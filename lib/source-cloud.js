'use strict';

/**
 * Connection type "cloud": the adapter signs in to the Ambientika cloud with
 * the e-mail address and password of the Ambientika app, reads the status of
 * every unit at a fixed interval and sends commands the same way the app does.
 */

const { AmbientikaCloud, CloudError, DEFAULT_HOST, OPERATING_MODES, FAN_SPEEDS, HUMIDITY_LEVELS, LIGHT_SENSOR_LEVELS } = require('./cloud');
const { CLOUD_STATES, fromCloudStatus } = require('./states');

/** Seconds between two readings of all units, when the settings say nothing else. */
const POLL_INTERVAL_S = 30;
const POLL_INTERVAL_MAX_S = 3600;
/** How many units are asked for their status at the same time. */
const REQUESTS_AT_ONCE = 10;
/** Readings without a status in a row after which a unit is shown offline. */
const OFFLINE_AFTER = 3;
/** Times in seconds. An object, so that the tests can shorten them. */
const TIMING = {
    /** shortest interval between two readings of all units */
    pollMinS: 10,
    /** between two readings of the list of units (new units, new names) */
    unitsIntervalS: 600,
    /** until the next try after the cloud could not be reached: first, and longest */
    retryFirstS: 15,
    retryMaxS: 300,
    /** until the next sign-in after the cloud did not accept e-mail address and password */
    retryRejectedS: 1800,
    /** after a command until the unit is read again; the unit needs that long to report */
    afterCommandS: 4,
    /** the adapter waits that long for one answer of the cloud */
    requestS: 20,
};
/** Upper bound for the number of units of one account. */
const MAX_UNITS = 250;

const SLAVE_ROLES = new Set(['SlaveEqualMaster', 'SlaveOppositeMaster']);

class CloudSource {
    /**
     * @param {any} adapter the adapter instance
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.log = adapter.log;
        this.cloud = null;
        this.units = new Map(); // serial -> unit as the cloud lists it
        this.status = new Map(); // serial -> last status packet
        this.failures = new Map(); // serial -> readings without a status in a row
        this.online = new Map(); // serial -> shown online
        this.lastFan = new Map(); // serial -> last fan step a command may carry
        this.lastLight = new Map(); // serial -> light sensor level seen while the unit was running
        this.hold = new Map(); // serial -> time until which readings are skipped after a command
        this.queues = new Map(); // serial -> the command under way
        this.slaveNoted = new Set();
        this.timer = null;
        this.unitsReadAt = 0;
        this.retryS = TIMING.retryFirstS;
        this.connected = false;
        this.allSilentLogged = false;
        this.stopped = false;
        const typed = Number(adapter.config.pollInterval);
        this.intervalS =
            Number.isFinite(typed) && typed > 0
                ? Math.min(POLL_INTERVAL_MAX_S, Math.max(TIMING.pollMinS, typed < 1 ? typed : Math.round(typed)))
                : POLL_INTERVAL_S;
    }

    async start() {
        const c = this.adapter.config;
        const username = String(c.username || '').trim();
        const password = c.password === undefined || c.password === null ? '' : String(c.password);
        if (!username || !password) {
            this.log.warn('Please enter the e-mail address and the password of the Ambientika app in the adapter settings. Nothing is read until then.');
            return;
        }
        this.cloud = new AmbientikaCloud({ username, password, host: c.cloudHost, timeoutS: TIMING.requestS });
        if (this.cloud.host !== DEFAULT_HOST) {
            this.log.info(`Using the cloud address ${this.cloud.host}`);
        }
        this.log.info(`Signing in to the Ambientika cloud as ${username}, reading the units every ${this.intervalS} seconds`);
        await this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            this.adapter.clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.cloud) {
            this.cloud.close();
        }
    }

    schedule(fn, seconds) {
        if (this.stopped) {
            return;
        }
        if (this.timer) {
            this.adapter.clearTimeout(this.timer);
        }
        this.timer = this.adapter.setTimeout(() => {
            this.timer = null;
            fn.call(this).catch(e => {
                if (this.stopped) {
                    return;
                }
                this.log.warn(`Unexpected error, trying again in a minute: ${e && e.stack ? e.stack : e}`);
                this.schedule(fn, 60);
            });
        }, seconds * 1000);
    }

    async setConnected(connected) {
        if (this.stopped) {
            return;
        }
        this.connected = connected;
        await this.adapter.setStateChangedAsync('info.connection', { val: connected, ack: true });
    }

    /** Signs in and reads the list of units; tries again later when that fails. */
    async connect() {
        try {
            await this.cloud.signIn();
            await this.readUnits();
        } catch (e) {
            if (this.stopped) {
                return;
            }
            await this.lost(e);
            return;
        }
        this.retryS = TIMING.retryFirstS;
        this.log.info(`Signed in to the Ambientika cloud, ${this.units.size} unit${this.units.size === 1 ? '' : 's'}`);
        await this.setConnected(true);
        await this.poll();
    }

    /**
     * The cloud is not available: everything offline, next try later.
     *
     * @param {Error} error why
     */
    async lost(error) {
        const rejected = error instanceof CloudError && error.kind === 'auth';
        const wait = rejected ? TIMING.retryRejectedS : this.retryS;
        if (rejected) {
            this.log.error(
                `${error.message}. Please check them in the adapter settings (the same as in the Ambientika app). Next try in ${Math.max(1, Math.round(wait / 60))} minutes.`,
            );
        } else if (this.connected || this.retryS === TIMING.retryFirstS) {
            this.log.warn(`Ambientika cloud: ${error.message}. Trying again, first in ${wait} seconds.`);
        } else {
            this.log.debug(`Ambientika cloud: ${error.message}. Next try in ${wait} seconds.`);
        }
        if (!rejected) {
            this.retryS = Math.min(TIMING.retryMaxS, this.retryS * 2);
        }
        await this.setConnected(false);
        this.allSilentLogged = this.units.size > 1;
        for (const serial of this.units.keys()) {
            await this.setOnline(serial, false);
        }
        this.cloud.token = null;
        this.schedule(this.connect, wait);
    }

    async readUnits() {
        const a = this.adapter;
        const list = await this.cloud.units();
        this.unitsReadAt = Date.now();
        let ignored = 0;
        const seen = new Set();
        for (const unit of list) {
            const ok = await a.ensureDevice(unit.serial, { states: CLOUD_STATES, name: unit.name, max: MAX_UNITS });
            if (!ok) {
                ignored++;
                continue;
            }
            seen.add(unit.serial);
            const before = this.units.get(unit.serial);
            this.units.set(unit.serial, unit);
            if (!before || before.name !== unit.name || before.room !== unit.room || before.house !== unit.house || before.type !== unit.type) {
                const common = unit.name ? { name: unit.name } : {};
                await a.extendObjectAsync(a.idOf(unit.serial), {
                    common,
                    native: { serial: unit.serial, room: unit.room, house: unit.house, deviceType: unit.type },
                });
                if (before && before.name !== unit.name && unit.name) {
                    this.log.info(`Unit ${unit.serial} is now called "${unit.name}"`);
                }
            }
        }
        // A unit that was removed from the account keeps its objects and is shown offline.
        for (const serial of [...this.units.keys()]) {
            if (!seen.has(serial)) {
                this.log.info(`Unit ${serial} is no longer in the Ambientika account - it is shown offline`);
                this.units.delete(serial);
                this.status.delete(serial);
                await this.setOnline(serial, false, true);
            }
        }
        if (ignored) {
            this.log.warn(
                `${ignored} unit${ignored === 1 ? '' : 's'} of the account cannot be shown (more than ${MAX_UNITS} units, or a serial number that is not usable)`,
            );
        }
        if (!list.length) {
            this.log.warn('The Ambientika account has no units yet. Add them in the Ambientika app; the adapter finds them on its own.');
        }
    }

    async setOnline(serial, online, force) {
        if (this.stopped) {
            return;
        }
        if (!force && this.online.get(serial) === online) {
            return;
        }
        this.online.set(serial, online);
        const id = this.adapter.idOf(serial);
        if (this.adapter.created.has(id)) {
            await this.adapter.setStateChangedAsync(`${id}.online`, { val: online, ack: true });
        }
    }

    /**
     * Takes a status packet: remembers it and writes the states.
     *
     * @param {string} serial serial number of the unit
     * @param {Record<string, any>} packet status packet of the cloud
     */
    async take(serial, packet) {
        const unit = this.units.get(serial);
        if (!unit || this.stopped) {
            return;
        }
        this.status.set(serial, packet);
        if (FAN_SPEEDS.includes(packet.fanSpeed)) {
            this.lastFan.set(serial, packet.fanSpeed);
        }
        // A unit that is switched off reports a default light sensor level, not the one it was set to.
        if (packet.operatingMode !== 'Off' && LIGHT_SENSOR_LEVELS.includes(packet.lightSensorLevel)) {
            this.lastLight.set(serial, packet.lightSensorLevel);
        }
        await this.adapter.writeStates(this.adapter.idOf(serial), CLOUD_STATES, fromCloudStatus(packet, unit.zone));
    }

    /**
     * Reads one unit.
     *
     * @param {string} serial serial number of the unit
     * @returns {Promise<{serial: string, ok: boolean, reached: boolean, error?: Error}>} how it went
     */
    async readUnit(serial) {
        try {
            const packet = await this.cloud.status(serial);
            if ((this.hold.get(serial) || 0) > Date.now()) {
                // A command was sent while this reading was under way; it shows the state before.
                return { serial, ok: true, reached: true };
            }
            await this.take(serial, packet);
            return { serial, ok: true, reached: true };
        } catch (e) {
            const reached = e instanceof CloudError && e.status !== null && e.status < 500 && e.kind !== 'auth';
            return { serial, ok: false, reached, error: e };
        }
    }

    /** One reading of all units, then the next one is scheduled. */
    async poll() {
        if (this.stopped) {
            return;
        }
        const started = Date.now();
        if (started - this.unitsReadAt > TIMING.unitsIntervalS * 1000) {
            try {
                await this.readUnits();
            } catch (e) {
                if (e instanceof CloudError && e.kind === 'auth') {
                    await this.lost(e);
                    return;
                }
                this.unitsReadAt = Date.now() - (TIMING.unitsIntervalS - 60) * 1000; // again in a minute
                this.log.debug(`List of units not read: ${e.message}`);
            }
        }

        const serials = [...this.units.keys()].filter(s => (this.hold.get(s) || 0) <= Date.now());
        const results = [];
        let next = 0;
        const worker = async () => {
            while (next < serials.length && !this.stopped) {
                const serial = serials[next++];
                results.push(await this.readUnit(serial));
            }
        };
        await Promise.all(Array.from({ length: Math.min(REQUESTS_AT_ONCE, serials.length) }, worker));
        if (this.stopped) {
            return;
        }

        const rejected = results.find(r => r.error instanceof CloudError && r.error.kind === 'auth');
        if (rejected) {
            await this.lost(rejected.error);
            return;
        }
        await this.judge(results);

        const used = (Date.now() - started) / 1000;
        this.schedule(this.poll, Math.max(Math.min(1, this.intervalS), this.intervalS - used));
    }

    /**
     * Shows units online or offline after a reading and says so in the log - once per change.
     *
     * @param {Array<{serial: string, ok: boolean, reached: boolean, error?: Error}>} results one entry per unit read
     */
    async judge(results) {
        if (!results.length) {
            return;
        }
        const reached = results.some(r => r.reached);
        const stopped = [];
        const resumed = [];
        for (const r of results) {
            if (r.ok) {
                this.failures.set(r.serial, 0);
                if (this.online.get(r.serial) === false && this.status.has(r.serial)) {
                    resumed.push(r.serial);
                }
                if (this.status.has(r.serial)) {
                    await this.setOnline(r.serial, true);
                }
                continue;
            }
            const n = (this.failures.get(r.serial) || 0) + 1;
            this.failures.set(r.serial, n);
            // Offline after a few readings in a row; at once when nothing was ever read.
            if ((n >= OFFLINE_AFTER || !this.status.has(r.serial)) && this.online.get(r.serial) !== false) {
                stopped.push(r);
                await this.setOnline(r.serial, false);
            } else if (this.online.get(r.serial) === undefined) {
                await this.setOnline(r.serial, false);
            }
        }

        const label = s => {
            const u = this.units.get(s);
            return u && u.name ? `${u.name} (${s})` : s;
        };
        const total = this.units.size;
        if (total > 1 && stopped.length === total) {
            const reasons = [...new Set(stopped.map(r => r.error.message))].join('; ').slice(0, 300);
            this.log.warn(`No status from any of the ${total} units (${reasons}). They are shown offline until the Ambientika cloud answers again.`);
            this.allSilentLogged = true;
        } else {
            for (const r of stopped) {
                this.log.warn(`No status from the unit ${label(r.serial)}: ${r.error.message}. It is shown offline until it answers again.`);
            }
        }
        if (total > 1 && resumed.length === total && this.allSilentLogged) {
            this.log.info(`All ${total} units answer again`);
        } else {
            for (const s of resumed) {
                this.log.info(`The unit ${label(s)} answers again`);
            }
        }
        if (resumed.length) {
            this.allSilentLogged = false;
        }
        await this.setConnected(reached);
    }

    /**
     * Sends a command. Commands for the same unit run one after the other, so
     * that the second one builds on what the first one set.
     *
     * @param {string} id id of the unit below the instance
     * @param {string} serial serial number of the unit
     * @param {string} key state key
     * @param {string|boolean} value value to set
     * @returns {Promise<void>}
     */
    command(id, serial, key, value) {
        const before = this.queues.get(serial) || Promise.resolve();
        const run = before.catch(() => {}).then(() => this.runCommand(id, serial, key, value));
        const tail = run.catch(() => {});
        this.queues.set(serial, tail);
        tail.then(() => {
            if (this.queues.get(serial) === tail) {
                this.queues.delete(serial);
            }
        });
        return run;
    }

    async runCommand(id, serial, key, value) {
        if (!this.cloud || !this.cloud.token) {
            throw new Error('not signed in to the Ambientika cloud, nothing sent');
        }
        const unit = this.units.get(serial);
        if (!unit) {
            throw new Error('this unit is not in the Ambientika account, nothing sent');
        }
        const name = unit.name ? `${unit.name} (${serial})` : serial;

        if (key === 'reset_filter') {
            await this.cloud.resetFilter(serial);
            const role = (this.status.get(serial) || {}).deviceRole || unit.role;
            if (SLAVE_ROLES.has(role)) {
                this.log.info(
                    `Filter reset sent for ${name}. This unit is a Slave: the cloud clears the filter counter of a Master only, a Slave keeps its own until it is reset at the unit.`,
                );
            } else {
                this.log.info(`Filter reset sent for ${name}`);
            }
            this.readSoon(serial);
            return;
        }

        let base = this.status.get(serial);
        if (!base) {
            base = await this.cloud.status(serial);
            await this.take(serial, base);
        }
        const mode = {
            operatingMode: base.operatingMode,
            fanSpeed: base.fanSpeed,
            humidityLevel: base.humidityLevel,
            lightSensorLevel: this.lastLight.get(serial) || base.lightSensorLevel,
        };
        if (key === 'operating_mode') {
            mode.operatingMode = value;
        } else if (key === 'fan_speed') {
            mode.fanSpeed = value;
        } else if (key === 'humidity_level') {
            mode.humidityLevel = value;
        } else if (key === 'light_sensor_level') {
            mode.lightSensorLevel = value;
        }

        if (!OPERATING_MODES.includes(mode.operatingMode)) {
            throw new Error(
                `the unit reports the operating mode ${JSON.stringify(mode.operatingMode)}, which cannot be sent back - please set the operating mode first`,
            );
        }
        // Night and Turbo are steps the unit chooses itself; the cloud does not take them in a command.
        if (!FAN_SPEEDS.includes(mode.fanSpeed)) {
            const asked = key === 'fan_speed';
            const nearest = mode.fanSpeed === 'Night' ? 'Low' : mode.fanSpeed === 'Turbo' ? 'High' : 'Medium';
            const instead = asked ? nearest : this.lastFan.get(serial) || nearest;
            if (asked) {
                this.log.info(`${name}: the fan speed ${mode.fanSpeed} is chosen by the unit itself and cannot be set - sending ${instead} instead`);
            }
            mode.fanSpeed = instead;
        }
        if (!HUMIDITY_LEVELS.includes(mode.humidityLevel)) {
            mode.humidityLevel = 'Normal';
        }
        if (!LIGHT_SENSOR_LEVELS.includes(mode.lightSensorLevel)) {
            delete mode.lightSensorLevel; // the unit keeps its own
        }

        this.hold.set(serial, Date.now() + TIMING.afterCommandS * 1000);
        try {
            await this.cloud.changeMode(serial, mode);
        } catch (e) {
            this.hold.delete(serial);
            // The state shows what the unit has, not what could not be set.
            await this.take(serial, base).catch(() => {});
            throw new Error(`command not accepted (${e.message})`);
        }
        this.log.debug(`Sent to ${serial}: ${JSON.stringify(mode)}`);

        const role = base.deviceRole || unit.role;
        if (key === 'operating_mode' && SLAVE_ROLES.has(role) && !this.slaveNoted.has(serial)) {
            this.slaveNoted.add(serial);
            this.log.info(
                `${name} is a Slave and runs with the Master of its zone. Set the operating mode at the Master; a Slave does not follow a command of its own.`,
            );
        }

        // The next command builds on these values, and the states show them until the unit reports.
        const assumed = Object.assign({}, base, mode);
        if (mode.operatingMode !== base.operatingMode) {
            assumed.lastOperatingMode = base.operatingMode;
        }
        if (this.stopped) {
            return;
        }
        this.hold.set(serial, Date.now() + TIMING.afterCommandS * 1000);
        await this.take(serial, assumed);
        // take() remembers the light level only while the unit runs; a level that was set counts always.
        if (key === 'light_sensor_level') {
            this.lastLight.set(serial, value);
        }
        this.readSoon(serial);
    }

    /**
     * Reads one unit a few seconds after a command, without waiting for the next reading of all units.
     *
     * @param {string} serial serial number of the unit
     */
    readSoon(serial) {
        if (this.stopped) {
            return;
        }
        this.adapter.setTimeout(
            () => {
                if (this.stopped || !this.units.has(serial) || (this.hold.get(serial) || 0) > Date.now()) {
                    return;
                }
                this.readUnit(serial)
                    .then(r => (r.ok ? this.judge([r]) : undefined))
                    .catch(() => {});
            },
            TIMING.afterCommandS * 1000 + 200,
        );
    }
}

module.exports = { CloudSource, POLL_INTERVAL_S, TIMING };
