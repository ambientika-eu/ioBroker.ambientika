'use strict';

const assert = require('assert');
const { startFakeCloud } = require('../sim/fake-cloud');
const { createAdapter, wait, waitFor } = require('./mock-adapter');
const { TIMING } = require('../../lib/source-cloud');
const { AmbientikaCloud, CloudError, cleanHost } = require('../../lib/cloud');
const { fromCloudStatus } = require('../../lib/states');

// Short times, so that outages and retries can be watched in seconds.
Object.assign(TIMING, { pollMinS: 0.15, unitsIntervalS: 0.6, retryFirstS: 0.3, retryMaxS: 0.6, retryRejectedS: 0.8, afterCommandS: 0.3, confirmS: 1.5, confirmEveryS: 0.3, requestS: 0.5 });

const FLUR = 'A0B1C2D3E402'; // Master zone 0
const WOHN = 'A0B1C2D3E401'; // Slave zone 0
const ELTERN = 'A0B1C2D3E404'; // Master zone 1

describe('connection type cloud', () => {
    let cloud;
    let a;
    const unhandled = [];
    const onUnhandled = e => unhandled.push(e);

    before(async () => {
        cloud = await startFakeCloud();
        process.on('unhandledRejection', onUnhandled);
    });
    after(async () => {
        process.off('unhandledRejection', onUnhandled);
        await cloud.stop();
        assert.deepStrictEqual(unhandled, [], 'no unhandled rejections');
    });

    async function start(config, existing) {
        a = createAdapter(Object.assign({ connection: 'cloud', username: cloud.USER, password: cloud.PASSWORD, pollInterval: 0.15, cloudHost: cloud.url }, config), existing);
        await a.onReady();
        return a;
    }
    const changes = () => cloud.log.filter(l => l.kind === 'change-mode');
    const allOnline = () => cloud.serials.every(s => a.val(`${s}.online`) === true);

    beforeEach(() => cloud.reset());
    afterEach(async () => {
        if (a) await a.end();
        const errors = a ? a.logged('warn', /Unexpected error/) : [];
        a = null;
        assert.deepStrictEqual(errors, []);
    });

    it('signs in, creates all units with their names and fills the states', async () => {
        await start();
        await waitFor(allOnline, 'all online');
        assert.strictEqual(a.val('info.connection'), true);
        assert.strictEqual(a.objects.get(FLUR).common.name, 'Flur');
        assert.strictEqual(a.objects.get(FLUR).type, 'device');
        assert.strictEqual(a.objects.get(FLUR).native.serial, FLUR);
        assert.strictEqual(a.objects.get(FLUR).native.room, 'Haus');
        assert.strictEqual(a.objects.get('A0B1C2D3E405').common.name, 'Gäste-Bad');
        assert.strictEqual(a.val(`${FLUR}.operating_mode`), 'Smart');
        assert.strictEqual(a.val(`${FLUR}.fan_speed`), 'Medium');
        assert.strictEqual(a.val(`${FLUR}.fan_speed_num`), 2);
        assert.strictEqual(a.val(`${FLUR}.humidity_level`), 'Normal');
        assert.strictEqual(a.val(`${FLUR}.light_sensor_level`), 'Low');
        assert.strictEqual(a.val(`${FLUR}.temperature`), 21);
        assert.strictEqual(a.val(`${FLUR}.humidity`), 55);
        assert.strictEqual(a.val(`${FLUR}.air_quality`), 'Good');
        assert.strictEqual(a.val(`${FLUR}.air_quality_num`), 3);
        assert.strictEqual(a.val(`${FLUR}.filters_status`), 'Good');
        assert.strictEqual(a.val(`${FLUR}.filter_status_num`), 0);
        assert.strictEqual(a.val(`${FLUR}.humidity_alarm`), false);
        assert.strictEqual(a.val(`${FLUR}.night_alarm`), false);
        assert.strictEqual(a.val(`${FLUR}.device_role`), 'Master');
        assert.strictEqual(a.val(`${WOHN}.device_role`), 'SlaveEqualMaster');
        assert.strictEqual(a.val(`${ELTERN}.zone_index`), 1);
        // only the states the cloud fills, no states of the MQTT Bridge
        assert.ok(a.objects.has(`${FLUR}.reset_filter`));
        assert.ok(!a.objects.has(`${FLUR}.humidity_avg`));
        assert.ok(!a.objects.has(`${FLUR}.diagnostics`));
        assert.ok(!a.objects.has('info.bridge'));
        assert.strictEqual(a.objects.get(`${FLUR}.fan_speed`).common.write, true);
        assert.strictEqual(a.objects.get(`${FLUR}.temperature`).common.write, false);
        assert.strictEqual(a.objects.get(`${FLUR}.temperature`).common.unit, '°C');
        assert.strictEqual(cloud.counts.auth, 1);
        assert.deepStrictEqual(cloud.log.filter(l => l.kind === 'UNEXPECTED' || l.kind === 'unauthorized'), []);
        assert.strictEqual(a.logged('warn', /./).length + a.logged('error', /./).length, 0);
        assert.strictEqual(a.logged('info', /were removed/).length, 0);
    });

    it('follows the values of the units, also steps the unit chooses itself and unknown values', async () => {
        await start();
        await waitFor(allOnline);
        cloud.set(FLUR, { temperature: 19, humidity: 71, humidityAlarm: true, fanSpeed: 'Night', nightAlarm: true, airQuality: 'VeryGood', filtersStatus: 'Bad' });
        await waitFor(() => a.val(`${FLUR}.temperature`) === 19);
        assert.strictEqual(a.val(`${FLUR}.humidity`), 71);
        assert.strictEqual(a.val(`${FLUR}.humidity_alarm`), true);
        assert.strictEqual(a.val(`${FLUR}.fan_speed`), 'Night');
        assert.strictEqual(a.val(`${FLUR}.fan_speed_num`), 4);
        assert.strictEqual(a.val(`${FLUR}.night_alarm`), true);
        assert.strictEqual(a.val(`${FLUR}.air_quality_num`), 4);
        assert.strictEqual(a.val(`${FLUR}.filter_status_num`), 2);
        cloud.set(FLUR, { fanSpeed: 'Turbo', operatingMode: 'SomethingNew', airQuality: 'Purple' });
        await waitFor(() => a.val(`${FLUR}.fan_speed`) === 'Turbo');
        assert.strictEqual(a.val(`${FLUR}.fan_speed_num`), 5);
        assert.strictEqual(a.val(`${FLUR}.operating_mode`), 'SomethingNew');
        assert.strictEqual(a.val(`${FLUR}.operating_mode_num`), null);
        assert.strictEqual(a.val(`${FLUR}.air_quality_num`), null);
        assert.strictEqual(a.val(`${FLUR}.online`), true);
    });

    it('sends a command with all settings of the unit and acknowledges the state', async () => {
        await start();
        await waitFor(allOnline);
        cloud.set(FLUR, { humidityLevel: 'Moist', fanSpeed: 'High' });
        await waitFor(() => a.val(`${FLUR}.fan_speed`) === 'High');
        cloud.clear();
        await a.userWrite(`${FLUR}.operating_mode`, 'Night');
        assert.strictEqual(changes().length, 1);
        assert.deepStrictEqual(changes()[0].body, { deviceSerialNumber: FLUR, operatingMode: '3', fanSpeed: 2, humidityLevel: 2, lightSensorLevel: 2 });
        assert.strictEqual(changes()[0].ok, true);
        assert.deepStrictEqual(a.states.get(`${FLUR}.operating_mode`), { val: 'Night', ack: true });
        assert.strictEqual(a.val(`${FLUR}.last_operating_mode`), 'Smart');
        await wait(600); // read again after the command: the cloud agrees
        assert.deepStrictEqual(a.states.get(`${FLUR}.operating_mode`), { val: 'Night', ack: true });
        assert.strictEqual(a.val(`${FLUR}.operating_mode_num`), 3);
        // the other units were not touched
        assert.strictEqual(cloud.unit(ELTERN).status.operatingMode, 'Smart');
    });

    it('builds the second of two quick commands on the first', async () => {
        await start();
        await waitFor(allOnline);
        cloud.clear();
        await Promise.all([
            a.userWrite(`${FLUR}.operating_mode`, 'ManualHeatRecovery'),
            a.userWrite(`${FLUR}.fan_speed`, 'Low'),
            a.userWrite(`${FLUR}.humidity_level`, 'Dry'),
        ]);
        assert.strictEqual(changes().length, 3);
        assert.deepStrictEqual(changes()[2].body, { deviceSerialNumber: FLUR, operatingMode: '2', fanSpeed: 0, humidityLevel: 0, lightSensorLevel: 2 });
        await wait(600);
        assert.strictEqual(a.val(`${FLUR}.operating_mode`), 'ManualHeatRecovery');
        assert.strictEqual(a.val(`${FLUR}.fan_speed`), 'Low');
        assert.strictEqual(a.val(`${FLUR}.humidity_level`), 'Dry');
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'Low', ack: true });
    });

    it('never sends Night or Turbo: the nearest step when asked for, the last own step otherwise', async () => {
        cloud.set(FLUR, { operatingMode: 'ManualHeatRecovery' });
        cloud.set(ELTERN, { operatingMode: 'ManualHeatRecovery' });
        await start();
        await waitFor(allOnline);
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'Turbo');
        assert.strictEqual(changes()[0].body.fanSpeed, 2);
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'High', ack: true });
        await a.userWrite(`${FLUR}.fan_speed`, 'Night');
        assert.strictEqual(changes()[1].body.fanSpeed, 0);
        assert.strictEqual(a.logged('info', /chosen by the unit itself/).length, 2);

        // the unit runs its night step on its own; another setting is changed
        await a.userWrite(`${ELTERN}.fan_speed`, 'High');
        await wait(500);
        cloud.set(ELTERN, { fanSpeed: 'Night' });
        await waitFor(() => a.val(`${ELTERN}.fan_speed`) === 'Night');
        cloud.clear();
        await a.userWrite(`${ELTERN}.humidity_level`, 'Moist');
        assert.deepStrictEqual(changes()[0].body, { deviceSerialNumber: ELTERN, operatingMode: '2', fanSpeed: 2, humidityLevel: 2, lightSensorLevel: 2 });
        assert.ok(changes().every(c => c.ok));
    });

    it('shows what was sent until the unit reports it, and keeps the readings coming meanwhile', async () => {
        cloud.set(FLUR, { operatingMode: 'ManualHeatRecovery' });
        await start({ pollInterval: 30 }); // the readings after the command come without the regular ones
        await waitFor(allOnline);
        cloud.lag(FLUR, 1000);
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'High', ack: true });
        cloud.set(FLUR, { temperature: 23.5 });
        const seen = new Set();
        const end = Date.now() + 1400;
        while (Date.now() < end) {
            seen.add(a.val(`${FLUR}.fan_speed`));
            await wait(20);
        }
        assert.deepStrictEqual([...seen], ['High'], 'the old step is never shown again');
        assert.strictEqual(a.val(`${FLUR}.fan_speed_num`), 3);
        assert.strictEqual(a.val(`${FLUR}.temperature`), 23.5);
        assert.ok(cloud.counts[`status:${FLUR}`] >= 2, 'read again while waiting');
        assert.strictEqual(cloud.unit(FLUR).status.fanSpeed, 'High');
        await waitFor(() => !a.source.expected.has(FLUR), 'the unit reported it');
        const reads = cloud.counts[`status:${FLUR}`];
        await wait(800);
        assert.strictEqual(cloud.counts[`status:${FLUR}`], reads, 'no extra readings once the unit reported it');
        assert.strictEqual(a.logged('warn', /has not taken it over/).length, 0);
        assert.strictEqual(a.logged('debug', /reports what was sent/).length, 1);
    });

    it('says so when the unit does not take a command over, and shows its own values again', async () => {
        await start();
        await waitFor(allOnline);
        cloud.ignore(FLUR);
        await a.userWrite(`${FLUR}.operating_mode`, 'ManualHeatRecovery');
        await a.userWrite(`${FLUR}.fan_speed`, 'Low');
        await wait(600);
        assert.strictEqual(a.val(`${FLUR}.operating_mode`), 'ManualHeatRecovery');
        assert.strictEqual(a.val(`${FLUR}.last_operating_mode`), 'Smart');
        assert.strictEqual(a.val(`${FLUR}.fan_speed`), 'Low');
        await waitFor(() => a.val(`${FLUR}.operating_mode`) === 'Smart', 'own mode again', 3000);
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'Medium', ack: true });
        const warned = a.logged('warn', /has not taken it over/);
        assert.strictEqual(warned.length, 1);
        assert.match(warned[0].msg, /Flur \(A0B1C2D3E402\): 1.5 seconds after the command the unit still reports operating mode Smart instead of ManualHeatRecovery, fan speed Medium instead of Low\./);
        assert.doesNotMatch(warned[0].msg, /Slave/);
        // a Slave: the log says where to set it
        cloud.ignore(WOHN);
        await a.userWrite(`${WOHN}.humidity_level`, 'Dry');
        await waitFor(() => a.logged('warn', /has not taken it over/).length === 2, 'second warning', 3000);
        assert.match(a.logged('warn', /has not taken it over/)[1].msg, /humidity level Normal instead of Dry\. .*This unit is a Slave/);
        assert.strictEqual(a.val(`${WOHN}.humidity_level`), 'Normal');
    });

    it('says that the unit chooses the fan speed itself in Smart and Auto, and shows its own step', async () => {
        cloud.set(FLUR, { operatingMode: 'Auto' });
        await start();
        await waitFor(allOnline);
        cloud.ignore(FLUR); // in Auto the unit keeps its step
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.strictEqual(changes().length, 1);
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'Medium', ack: true });
        assert.strictEqual(a.logged('info', /Flur \(A0B1C2D3E402\): in the operating mode Auto the unit chooses the fan speed itself/).length, 1);
        assert.ok(!a.source.expected.has(FLUR));
        // a step that was waiting for the unit does not count once the mode is one where the unit chooses
        cloud.ignore(FLUR, false);
        cloud.set(FLUR, { operatingMode: 'ManualHeatRecovery' });
        await waitFor(() => a.val(`${FLUR}.operating_mode`) === 'ManualHeatRecovery');
        cloud.ignore(FLUR);
        await a.userWrite(`${FLUR}.fan_speed`, 'Low');
        await a.userWrite(`${FLUR}.operating_mode`, 'Smart');
        assert.deepStrictEqual(a.source.expected.get(FLUR).settings, { operatingMode: 'Smart' });
        await wait(2200);
        assert.strictEqual(a.logged('warn', /fan speed/).length, 0);
    });

    it('shows the value of the unit again when a read-only state is written by hand, and says which one sets it', async () => {
        await start();
        await waitFor(allOnline);
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed_num`, 4);
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed_num`), { val: 2, ack: true });
        await a.userWrite(`${FLUR}.fan_speed_num`, 3);
        await a.userWrite(`${WOHN}.fan_speed_num`, 1);
        assert.deepStrictEqual(a.states.get(`${WOHN}.fan_speed_num`), { val: 2, ack: true });
        await a.userWrite(`${FLUR}.operating_mode_num`, 2);
        assert.deepStrictEqual(a.states.get(`${FLUR}.operating_mode_num`), { val: 0, ack: true });
        assert.strictEqual(changes().length, 0);
        const said = a.logged('info', /only shows a value of the unit/);
        assert.strictEqual(said.length, 2, 'once per state');
        assert.strictEqual(said[0].msg, 'fan_speed_num only shows a value of the unit and cannot be set; to change it, write fan_speed (Low, Medium, High)');
        assert.match(said[1].msg, /^operating_mode_num .* write operating_mode \(Smart, Auto, /);
    });

    it('keeps the light sensor level of a unit that is switched off and on again', async () => {
        await start();
        await waitFor(allOnline);
        await a.userWrite(`${FLUR}.light_sensor_level`, 'Medium');
        assert.strictEqual(cloud.unit(FLUR).status.lightSensorLevel, 'Medium');
        await a.userWrite(`${FLUR}.operating_mode`, 'Off');
        await wait(500);
        cloud.set(FLUR, { lightSensorLevel: 'Off' }); // what a unit that is off reports
        await waitFor(() => a.val(`${FLUR}.light_sensor_level`) === 'Off');
        cloud.clear();
        await a.userWrite(`${FLUR}.operating_mode`, 'Smart');
        assert.deepStrictEqual(changes()[0].body, { deviceSerialNumber: FLUR, operatingMode: '0', fanSpeed: 1, humidityLevel: 1, lightSensorLevel: 3 });
        // a level set while the unit is off counts as well
        await a.userWrite(`${ELTERN}.operating_mode`, 'Off');
        await a.userWrite(`${ELTERN}.light_sensor_level`, 'NotAvailable');
        await a.userWrite(`${ELTERN}.operating_mode`, 'Auto');
        assert.strictEqual(changes()[changes().length - 1].body.lightSensorLevel, 0);
    });

    it('leaves the light sensor level out when the unit reports none', async () => {
        await start();
        await waitFor(allOnline);
        await a.end();
        cloud.reset();
        delete cloud.unit(FLUR).status.lightSensorLevel;
        await start();
        await waitFor(allOnline);
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.deepStrictEqual(changes()[0].body, { deviceSerialNumber: FLUR, operatingMode: '0', fanSpeed: 2, humidityLevel: 1 });
        assert.strictEqual(changes()[0].ok, true);
    });

    it('turns down values that cannot be set and writes to read-only states', async () => {
        await start();
        await waitFor(allOnline);
        cloud.clear();
        await a.userWrite(`${FLUR}.operating_mode`, 'Party');
        await a.userWrite(`${FLUR}.fan_speed`, 2);
        await a.userWrite(`${FLUR}.humidity_level`, null);
        await a.userWrite(`${FLUR}.temperature`, 30);
        await a.userWrite(`${FLUR}.online`, false);
        await a.userWrite('info.connection', false);
        await a.userWrite('nothere.operating_mode', 'Smart');
        await a.userWrite(`${FLUR}.reset_filter`, false);
        assert.strictEqual(changes().length, 0);
        assert.strictEqual(cloud.counts['reset-filter'] || 0, 0);
        assert.strictEqual(a.logged('warn', /cannot be set \(allowed: /).length, 3);
    });

    it('does not send a mode the cloud would not accept back', async () => {
        await start();
        await waitFor(allOnline);
        cloud.set(FLUR, { operatingMode: 'SomethingNew' });
        await waitFor(() => a.val(`${FLUR}.operating_mode`) === 'SomethingNew');
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.strictEqual(changes().length, 0);
        assert.strictEqual(a.logged('warn', /set the operating mode first/).length, 1);
        await a.userWrite(`${FLUR}.operating_mode`, 'Auto');
        assert.strictEqual(changes()[0].body.operatingMode, '1');
    });

    it('resets the filter of a Master and says what happens with a Slave', async () => {
        await start();
        await waitFor(allOnline);
        cloud.set(FLUR, { filtersStatus: 'Bad' });
        cloud.set(WOHN, { filtersStatus: 'Bad' });
        await waitFor(() => a.val(`${FLUR}.filters_status`) === 'Bad' && a.val(`${WOHN}.filters_status`) === 'Bad');
        await a.userWrite(`${FLUR}.reset_filter`, true);
        assert.deepStrictEqual(a.states.get(`${FLUR}.reset_filter`), { val: false, ack: true });
        await waitFor(() => a.val(`${FLUR}.filters_status`) === 'Good');
        await a.userWrite(`${WOHN}.reset_filter`, true);
        assert.strictEqual(cloud.log.filter(l => l.kind === 'reset-filter').length, 2);
        assert.strictEqual(a.logged('info', /is a Slave: the cloud clears the filter counter of a Master only/).length, 1);
        await wait(500);
        assert.strictEqual(a.val(`${WOHN}.filters_status`), 'Bad');
    });

    it('says once that a Slave does not follow a mode of its own', async () => {
        await start();
        await waitFor(allOnline);
        await a.userWrite(`${WOHN}.operating_mode`, 'Night');
        await a.userWrite(`${WOHN}.operating_mode`, 'Auto');
        await a.userWrite(`${WOHN}.fan_speed`, 'Low');
        assert.strictEqual(a.logged('info', /is a Slave and runs with the Master/).length, 1);
    });

    it('signs in again when the sign-in has expired, without showing anything offline', async () => {
        await start();
        await waitFor(allOnline);
        a.writes.length = 0;
        cloud.expire();
        await waitFor(() => cloud.counts.auth === 2);
        cloud.set(FLUR, { temperature: 25 });
        await waitFor(() => a.val(`${FLUR}.temperature`) === 25);
        assert.strictEqual(cloud.counts.auth, 2);
        assert.deepStrictEqual(a.writes.filter(w => /online$|connection$/.test(w.id)), []);
        // a command right after the sign-in expired
        cloud.expire();
        cloud.clear();
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.strictEqual(changes().filter(c => c.ok).length, 1);
        assert.strictEqual(a.logged('warn', /./).length, 0);
    });

    it('shows a unit offline after three readings without a status, and online again', async () => {
        await start();
        await waitFor(allOnline);
        cloud.clear();
        cloud.fault(WOHN, '404');
        await waitFor(() => a.val(`${WOHN}.online`) === false);
        assert.ok(cloud.counts[`status:${WOHN}`] >= 3);
        assert.strictEqual(a.val(`${FLUR}.online`), true);
        assert.strictEqual(a.val('info.connection'), true);
        assert.strictEqual(a.val(`${WOHN}.temperature`), 21); // the last values stay
        await wait(600);
        assert.strictEqual(a.logged('warn', /No status from the unit Wohnzimmer \(A0B1C2D3E401\): HTTP status 404: Status packet not found/).length, 1);
        cloud.fault(WOHN, null);
        await waitFor(() => a.val(`${WOHN}.online`) === true);
        assert.strictEqual(a.logged('info', /The unit Wohnzimmer \(A0B1C2D3E401\) answers again/).length, 1);
        // one failed reading in between is not shown
        a.writes.length = 0;
        cloud.fault(WOHN, '500');
        await waitFor(() => cloud.counts[`status:${WOHN}`] >= 1 && (cloud.fault(WOHN, null), true));
        await wait(500);
        assert.deepStrictEqual(a.writes.filter(w => w.id === `${WOHN}.online`), []);
    });

    for (const fault of ['hang', 'garbage', 'html', '500']) {
        it(`keeps reading the other units while one answers with "${fault}"`, async () => {
            await start();
            await waitFor(allOnline);
            cloud.fault(WOHN, fault);
            cloud.set(FLUR, { temperature: 17 });
            await waitFor(() => a.val(`${FLUR}.temperature`) === 17);
            await waitFor(() => a.val(`${WOHN}.online`) === false, 'offline', 15000);
            cloud.set(FLUR, { temperature: 18 });
            await waitFor(() => a.val(`${FLUR}.temperature`) === 18);
            assert.strictEqual(a.val(`${FLUR}.online`), true);
            const warned = a.logged('warn', /No status from the unit Wohnzimmer/);
            assert.strictEqual(warned.length, 1);
            assert.ok(!/<html|fanSp/.test(warned[0].msg), warned[0].msg);
            cloud.fault(WOHN, null);
            await waitFor(() => a.val(`${WOHN}.online`) === true);
        });
    }

    it('reports an outage of the cloud in one line and comes back on its own', async () => {
        await start();
        await waitFor(allOnline);
        cloud.outage('500');
        await waitFor(() => cloud.serials.every(s => a.val(`${s}.online`) === false));
        await waitFor(() => a.val('info.connection') === false);
        await wait(700);
        assert.strictEqual(a.logged('warn', /No status from any of the 5 units \(HTTP status 500: Internal Server Error\)/).length, 1);
        assert.strictEqual(a.logged('warn', /No status from the unit/).length, 0);
        cloud.outage('ok');
        await waitFor(allOnline);
        assert.strictEqual(a.val('info.connection'), true);
        assert.strictEqual(a.logged('info', /All 5 units answer again/).length, 1);
        assert.strictEqual(a.logged('info', /The unit .* answers again/).length, 0);
    });

    it('survives a cloud that accepts requests and never answers', async () => {
        await start();
        await waitFor(allOnline);
        cloud.outage('hang');
        await waitFor(() => a.val('info.connection') === false, 'connection false', 15000);
        await waitFor(() => a.logged('warn', /No status from any of the 5 units \(no answer from the Ambientika cloud within/).length === 1, 'warning', 15000);
        cloud.outage('ok');
        await waitFor(allOnline, 'online again', 15000);
    });

    it('waits and tries again when the cloud is not reachable at the start', async () => {
        cloud.outage('500');
        await start();
        assert.strictEqual(a.val('info.connection'), false);
        await waitFor(() => cloud.counts.auth >= 3);
        assert.strictEqual(a.logged('warn', /Ambientika cloud: HTTP status 500/).length, 1); // said once
        cloud.outage('ok');
        await waitFor(allOnline);
        assert.strictEqual(a.val('info.connection'), true);
    });

    it('waits and tries again when the address of the cloud does not answer at all', async () => {
        await start({ cloudHost: 'http://127.0.0.1:9' });
        assert.strictEqual(a.val('info.connection'), false);
        assert.strictEqual(a.logged('warn', /no connection to the Ambientika cloud \(/).length, 1);
        assert.strictEqual(a.objects.has(FLUR), false);
    });

    it('says so when e-mail address or password are not accepted, and tries again much later', async () => {
        await start({ password: 'wrong' });
        assert.strictEqual(a.val('info.connection'), false);
        assert.strictEqual(a.logged('error', /did not accept e-mail address and password\. Please check them in the adapter settings/).length, 1);
        assert.strictEqual(cloud.counts.auth, 1);
        await wait(400);
        assert.strictEqual(cloud.counts.auth, 1, 'no hammering with a wrong password');
        assert.ok(!JSON.stringify(a.logs).includes('wrong'), 'the password is not in the log');
        assert.strictEqual(a.objects.has(FLUR), false);
    });

    it('handles a password that stops being accepted while running', async () => {
        await start();
        await waitFor(allOnline);
        cloud.outage('refuse-auth');
        cloud.expire();
        await waitFor(() => a.val('info.connection') === false);
        assert.ok(cloud.serials.every(s => a.val(`${s}.online`) === false));
        assert.strictEqual(a.logged('error', /did not accept e-mail address and password/).length, 1);
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.strictEqual(a.logged('warn', /not signed in to the Ambientika cloud, nothing sent/).length, 1);
        cloud.outage('ok');
        await waitFor(allOnline);
        assert.strictEqual(a.val('info.connection'), true);
    });

    it('asks for the sign-in data when none are entered and sends nothing', async () => {
        await start({ username: '', password: '' });
        assert.strictEqual(a.logged('warn', /Please enter the e-mail address and the password of the Ambientika app/).length, 1);
        await wait(300);
        assert.deepStrictEqual(cloud.counts, {});
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        assert.strictEqual(a.val('info.connection'), false);
    });

    it('takes over new names, new units and units that were removed', async () => {
        await start();
        await waitFor(allOnline);
        cloud.rename(FLUR, 'Diele');
        cloud.addUnit('A0B1C2D3E499', 'Büro', 'Master', 2);
        cloud.removeUnit(WOHN);
        await waitFor(() => a.objects.get(FLUR).common.name === 'Diele');
        await waitFor(() => a.val('A0B1C2D3E499.online') === true);
        assert.strictEqual(a.objects.get('A0B1C2D3E499').common.name, 'Büro');
        assert.strictEqual(a.val('A0B1C2D3E499.zone_index'), 2);
        await waitFor(() => a.val(`${WOHN}.online`) === false);
        assert.ok(a.objects.has(`${WOHN}.temperature`), 'objects of a removed unit stay');
        assert.strictEqual(a.logged('info', /Unit A0B1C2D3E401 is no longer in the Ambientika account/).length, 1);
        assert.strictEqual(a.logged('info', /Unit A0B1C2D3E402 is now called "Diele"/).length, 1);
        cloud.clear();
        await a.userWrite(`${WOHN}.fan_speed`, 'High');
        assert.strictEqual(changes().length, 0);
        assert.strictEqual(a.logged('warn', /this unit is not in the Ambientika account/).length, 1);
        await wait(400);
        assert.strictEqual(cloud.counts[`status:${WOHN}`] || 0, 0, 'a removed unit is not asked any more');
    });

    it('shows what the unit has when a command is not accepted', async () => {
        await start();
        await waitFor(allOnline);
        cloud.outage('500');
        await a.userWrite(`${FLUR}.fan_speed`, 'High');
        cloud.outage('ok');
        assert.strictEqual(a.logged('warn', /fan_speed: command not accepted \(HTTP status 500/).length, 1);
        assert.deepStrictEqual(a.states.get(`${FLUR}.fan_speed`), { val: 'Medium', ack: true });
        await waitFor(allOnline);
    });

    it('keeps units of an earlier run: commands work at once, nothing is online before it is read', async () => {
        await start();
        await waitFor(allOnline);
        const objects = Object.fromEntries(a.objects);
        await a.end();
        cloud.outage('500');
        await start({}, objects);
        assert.strictEqual(a.val(`${FLUR}.online`), false);
        assert.strictEqual(a.devices.get(FLUR), FLUR);
        cloud.outage('ok');
        await waitFor(allOnline);
        assert.strictEqual(a.logged('info', /Unit .* added/).length, 0);
    });

    it('removes the states only the MQTT Bridge fills when an instance changes to the cloud', async () => {
        const st = (name, type) => ({ type: 'state', common: { name, type }, native: {} });
        const existing = {
            'info.bridge': st('bridge', 'boolean'),
            neuracell: { type: 'device', common: { name: 'NeuraCell-X' }, native: {} },
            'neuracell.radon': st('Radon', 'number'),
            [FLUR]: { type: 'device', common: { name: 'Flur' }, native: { serial: FLUR } },
            [`${FLUR}.temperature`]: st('Temperature', 'number'),
            [`${FLUR}.humidity_avg`]: st('Humidity (averaged)', 'number'),
            [`${FLUR}.operating_mode_raw`]: st('Mode raw', 'string'),
            [`${FLUR}.reset_state`]: st('Filter reset status', 'string'),
            [`${FLUR}.diagnostics`]: { type: 'channel', common: { name: 'Diagnostics' }, native: {} },
            [`${FLUR}.diagnostics.last_status`]: st('Last status packet', 'string'),
            [`${FLUR}.my_own_state`]: st('added by the user', 'string'),
        };
        await start({}, existing);
        await waitFor(allOnline);
        for (const id of ['info.bridge', 'neuracell', 'neuracell.radon', `${FLUR}.humidity_avg`, `${FLUR}.operating_mode_raw`, `${FLUR}.reset_state`, `${FLUR}.diagnostics`, `${FLUR}.diagnostics.last_status`]) {
            assert.ok(!a.objects.has(id), `${id} is still there`);
        }
        assert.ok(a.objects.has(`${FLUR}.temperature`));
        assert.ok(a.objects.has(`${FLUR}.my_own_state`), 'a state of the user stays');
        assert.strictEqual(a.objects.get(FLUR).native.serial, FLUR);
        assert.strictEqual(a.val(`${FLUR}.temperature`), 21);
        assert.strictEqual(a.logged('info', /states only the bridge fills .* were removed/).length, 1);
        assert.strictEqual(a.logged('info', /Unit A0B1C2D3E402 .*added/).length, 0);
    });

    it('stops at once, also while a request is under way, and writes nothing afterwards', async () => {
        await start();
        await waitFor(allOnline);
        cloud.outage('hang');
        await wait(250);
        const t0 = Date.now();
        await a.end();
        assert.ok(Date.now() - t0 < 100);
        assert.strictEqual(a.timers.size, 0, 'no timer left');
        const n = a.writes.length;
        const calls = JSON.stringify(cloud.counts);
        cloud.outage('ok');
        await wait(700);
        assert.strictEqual(a.writes.length, n);
        assert.strictEqual(JSON.stringify(cloud.counts), calls);
    });

    it('reads at the interval that is set, one request per unit', async () => {
        await start({ pollInterval: 0.4 });
        await waitFor(allOnline);
        cloud.clear();
        await wait(2000);
        const per = cloud.counts[`status:${FLUR}`];
        assert.ok(per >= 4 && per <= 6, `status requests in 2 s: ${per}`);
        assert.strictEqual(cloud.counts.auth || 0, 0);
    });

    it('uses 30 seconds when the interval is missing or nonsense, and stays within 10 to 3600', async () => {
        const saved = TIMING.pollMinS;
        TIMING.pollMinS = 10;
        try {
            for (const [typed, used] of [[undefined, 30], ['', 30], ['abc', 30], [0, 30], [-5, 30], [3, 10], [45.4, 45], ['60', 60], [99999, 3600]]) {
                const { CloudSource } = require('../../lib/source-cloud');
                const src = new CloudSource(createAdapter({ pollInterval: typed }));
                assert.strictEqual(src.intervalS, used, `typed ${JSON.stringify(typed)}`);
            }
        } finally {
            TIMING.pollMinS = saved;
        }
    });
});

describe('connection type', () => {
    const device = { type: 'device', common: { name: 'Flur' }, native: { serial: 'A0B1C2D3E402' } };
    const type = (config, existing) => {
        const a = createAdapter(config, existing);
        for (const [id, o] of a.objects) if (o.type === 'device') a.devices.set(id, o.native.serial);
        return a.connectionType();
    };
    it('is the cloud for a new instance', () => {
        assert.strictEqual(type({ connection: 'cloud', username: '', mqttHost: 'localhost' }), 'cloud');
        assert.strictEqual(type({}), 'cloud');
    });
    it('stays the MQTT Bridge for an instance of version 1.x that has units and no sign-in', () => {
        assert.strictEqual(type({ mqttHost: '192.168.1.5' }, { A0B1C2D3E402: device }), 'mqtt');
        assert.strictEqual(type({ connection: 'cloud', username: '', mqttHost: 'localhost' }, { A0B1C2D3E402: device }), 'mqtt');
    });
    it('is what the settings say otherwise', () => {
        assert.strictEqual(type({ connection: 'mqtt', username: 'a@b.c' }), 'mqtt');
        assert.strictEqual(type({ connection: 'cloud', username: 'a@b.c' }, { A0B1C2D3E402: device }), 'cloud');
        assert.strictEqual(type({ connection: ' MQTT ' }), 'mqtt');
    });
});

describe('cloud client', () => {
    it('reads the address as typed', () => {
        assert.strictEqual(cleanHost(''), 'https://app.ambientika.eu:4521');
        assert.strictEqual(cleanHost(undefined), 'https://app.ambientika.eu:4521');
        assert.strictEqual(cleanHost(' app.example.com:4521/ '), 'https://app.example.com:4521');
        assert.strictEqual(cleanHost('http://127.0.0.1:8080//'), 'http://127.0.0.1:8080');
    });
    it('shares one sign-in between requests that start together', async () => {
        const cloud = await startFakeCloud();
        try {
            const c = new AmbientikaCloud({ username: cloud.USER, password: cloud.PASSWORD, host: cloud.url });
            const all = await Promise.all(cloud.serials.map(s => c.status(s)));
            assert.strictEqual(all.length, 5);
            assert.strictEqual(cloud.counts.auth, 1);
            cloud.expire();
            await Promise.all(cloud.serials.map(s => c.status(s)));
            assert.strictEqual(cloud.counts.auth, 2);
            await assert.rejects(c.status('NOPE'), e => e instanceof CloudError && e.status === 404);
            await assert.rejects(c.changeMode(cloud.serials[0], { operatingMode: 'Smart', fanSpeed: 'Night', humidityLevel: 'Normal' }), /cannot be sent/);
            c.close();
            await assert.rejects(c.status(cloud.serials[0]), /stopping/);
        } finally {
            await cloud.stop();
        }
    });
    it('turns a status packet into the values of the states', () => {
        const v = fromCloudStatus({ operatingMode: 'Off', fanSpeed: 'Low', humidityLevel: 'Dry', lightSensorLevel: 'NotAvailable', airQuality: 'Bad', filtersStatus: 'Medium', lastOperatingMode: 'Smart' }, null);
        assert.strictEqual(v.operating_mode_num, 11);
        assert.strictEqual(v.fan_speed_num, 1);
        assert.strictEqual(v.humidity_level_num, 0);
        assert.strictEqual(v.light_sensor_level_num, 0);
        assert.strictEqual(v.air_quality_num, 0);
        assert.strictEqual(v.filter_status_num, 1);
        assert.strictEqual(v.last_operating_mode_num, 0);
        assert.strictEqual(v.zone_index, null);
    });
});
