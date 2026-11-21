const path = require('path');
const { tests } = require('@iobroker/testing');
const { startFakeCloud } = require('./sim/fake-cloud');

// Starts a real js-controller with this adapter and a local stand-in for the
// Ambientika cloud (test/sim/fake-cloud.js): sign-in, units, values, commands,
// outage. The many single cases run faster in test/unit/cloud.test.js.
const FLUR = 'A0B1C2D3E402';
const WOHN = 'A0B1C2D3E401';

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitFor(fn, what, timeoutMs = 40000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
        await wait(250);
    }
}

tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    // JS_CONTROLLER=7.2.5 tests against that version; without it the harness takes the current development version.
    controllerVersion: process.env.JS_CONTROLLER || undefined,
    defineAdditionalTests({ suite }) {
        suite('Ambientika cloud', getHarness => {
            let cloud;

            before(async () => {
                cloud = await startFakeCloud();
            });
            after(async () => {
                await cloud.stop();
            });

            it('signs in with the data of the app, shows the units, sends commands and survives an outage', async function () {
                this.timeout(180000);
                const harness = getHarness();
                const ns = 'ambientika.0';
                const val = async id => {
                    const s = await harness.states.getStateAsync(`${ns}.${id}`);
                    return s ? s.val : undefined;
                };
                const set = (id, v) => harness.states.setStateAsync(`${ns}.${id}`, { val: v, ack: false });

                // the password is encrypted by the harness as Admin does it
                await harness.changeAdapterConfig('ambientika', {
                    native: { connection: 'cloud', username: cloud.USER, password: cloud.PASSWORD, pollInterval: 10, cloudHost: cloud.url },
                });
                await harness.startAdapterAndWait();

                await waitFor(async () => (await val('info.connection')) === true, 'info.connection');
                for (const serial of cloud.serials) {
                    await waitFor(async () => (await val(`${serial}.online`)) === true, `${serial} online`);
                }
                if (cloud.log.find(l => l.kind === 'auth' && !l.ok)) throw new Error('the password did not arrive as typed');

                const dev = await harness.objects.getObjectAsync(`${ns}.${FLUR}`);
                if (dev.type !== 'device' || dev.common.name !== 'Flur' || dev.native.serial !== FLUR) throw new Error(`device ${JSON.stringify(dev)}`);
                if (dev.common.statusStates.onlineId !== `${ns}.${FLUR}.online`) throw new Error('statusStates');
                const expected = {
                    operating_mode: 'Smart', fan_speed: 'Medium', humidity_level: 'Normal', light_sensor_level: 'Low', temperature: 21,
                    humidity: 55, air_quality: 'Good', humidity_alarm: false, night_alarm: false, filters_status: 'Good',
                    last_operating_mode: 'Smart', device_role: 'Master', zone_index: 0, operating_mode_num: 0, fan_speed_num: 2,
                    humidity_level_num: 1, light_sensor_level_num: 2, air_quality_num: 3, filter_status_num: 0,
                };
                for (const [key, value] of Object.entries(expected)) {
                    const s = await harness.states.getStateAsync(`${ns}.${FLUR}.${key}`);
                    if (!s || s.val !== value || s.ack !== true) throw new Error(`${key}: ${JSON.stringify(s)} instead of ${JSON.stringify(value)}`);
                }
                const fan = await harness.objects.getObjectAsync(`${ns}.${FLUR}.fan_speed`);
                if (fan.common.write !== true || fan.common.states.Turbo !== 'Turbo' || fan.common.role !== 'level.mode.fan') throw new Error('fan_speed object');
                if (await harness.objects.getObjectAsync(`${ns}.${FLUR}.humidity_avg`)) throw new Error('a state of the MQTT Bridge exists');
                if (await harness.objects.getObjectAsync(`${ns}.info.bridge`)) throw new Error('info.bridge exists');

                // values follow
                cloud.set(WOHN, { temperature: 18, humidity: 72, humidityAlarm: true, fanSpeed: 'Night' });
                await waitFor(async () => (await val(`${WOHN}.temperature`)) === 18, 'temperature 18');
                if ((await val(`${WOHN}.fan_speed`)) !== 'Night' || (await val(`${WOHN}.humidity_alarm`)) !== true) throw new Error('values of Wohnzimmer');

                // commands: a mode, something that does not exist, fan steps, a read-only state, the filter reset
                cloud.clear();
                cloud.set(FLUR, { filtersStatus: 'Bad' });
                await set(`${FLUR}.operating_mode`, 'Night');
                await waitFor(() => cloud.log.filter(l => l.kind === 'change-mode').length === 1, 'first command');
                await set(`${FLUR}.operating_mode`, 'Hyperdrive');
                await set(`${FLUR}.fan_speed`, 2);
                await set(`${FLUR}.temperature`, 30);
                await set(`${FLUR}.fan_speed`, 'Turbo');
                await waitFor(() => cloud.log.filter(l => l.kind === 'change-mode').length === 2, 'second command');
                await set(`${FLUR}.reset_filter`, true);
                await waitFor(() => cloud.log.find(l => l.kind === 'reset-filter'), 'filter reset');
                const sent = cloud.log.filter(l => l.kind === 'change-mode').map(l => JSON.stringify(l.body));
                const want = [
                    JSON.stringify({ deviceSerialNumber: FLUR, operatingMode: '3', fanSpeed: 1, humidityLevel: 1, lightSensorLevel: 2 }),
                    JSON.stringify({ deviceSerialNumber: FLUR, operatingMode: '3', fanSpeed: 2, humidityLevel: 1, lightSensorLevel: 2 }),
                ];
                if (JSON.stringify(sent) !== JSON.stringify(want)) throw new Error(`sent ${sent.join(' | ')}`);
                await waitFor(async () => {
                    const s = await harness.states.getStateAsync(`${ns}.${FLUR}.operating_mode`);
                    return s && s.val === 'Night' && s.ack === true;
                }, 'mode acknowledged');
                await waitFor(async () => {
                    const s = await harness.states.getStateAsync(`${ns}.${FLUR}.fan_speed`);
                    return s && s.val === 'High' && s.ack === true;
                }, 'fan acknowledged');
                await waitFor(async () => {
                    const s = await harness.states.getStateAsync(`${ns}.${FLUR}.reset_filter`);
                    return s && s.ack === true && s.val === false;
                }, 'button back');
                await waitFor(async () => (await val(`${FLUR}.filters_status`)) === 'Good', 'filter good');

                // the sign-in expires: nothing is shown offline
                cloud.expire();
                cloud.set(FLUR, { temperature: 23 });
                await waitFor(async () => (await val(`${FLUR}.temperature`)) === 23, 'value after new sign-in');
                if ((await val(`${FLUR}.online`)) !== true) throw new Error('offline after the sign-in expired');

                // the cloud is away, and back
                cloud.outage('500');
                await waitFor(async () => (await val('info.connection')) === false, 'connection false', 90000);
                await waitFor(async () => (await val(`${FLUR}.online`)) === false, 'unit offline', 90000);
                cloud.outage('ok');
                await waitFor(async () => (await val('info.connection')) === true && (await val(`${FLUR}.online`)) === true, 'back', 90000);
                if (cloud.log.find(l => l.kind === 'UNEXPECTED')) throw new Error('a request that is not part of the API');
            });
        });
    },
});
