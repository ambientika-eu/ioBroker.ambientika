'use strict';

/**
 * What the adapter does, apart from being an ioBroker adapter: the methods here
 * are put on the adapter class in main.js. Kept apart from the ioBroker base
 * class, so that the tests can run them without a js-controller.
 */

const { TOP_STATES, RESERVED } = require('./states');
const { CloudSource } = require('./source-cloud');
const { MqttSource } = require('./source-mqtt');

/** Longest text written into a state. */
const MAX_TEXT = 200;

function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

const methods = {
    /**
     * Object id for a serial: no dots, no spaces, no characters ioBroker forbids.
     *
     * @param {string} serial serial number of the unit
     * @returns {string} id below the instance
     */
    idOf(serial) {
        return String(serial).replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_');
    },

    /**
     * Which connection type this instance uses. An instance that was set up with
     * version 1.x has units from the MQTT Bridge and no cloud sign-in: it keeps
     * reading the bridge.
     *
     * @returns {'cloud'|'mqtt'} the connection type
     */
    connectionType() {
        const typed = String(this.config.connection || '')
            .trim()
            .toLowerCase();
        if (typed === 'mqtt') {
            return 'mqtt';
        }
        const signIn = String(this.config.username || '').trim();
        if (!signIn && this.devices.size > 0) {
            return 'mqtt';
        }
        return 'cloud';
    },

    async onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });

        // Units of an earlier run: commands work before their first values, and
        // nothing is shown online before it is known.
        try {
            for (const obj of await this.getDevicesAsync()) {
                const serial = obj && obj.native && obj.native.serial;
                if (!serial) {
                    continue;
                }
                const id = obj._id.slice(this.namespace.length + 1);
                if (RESERVED.has(id)) {
                    continue;
                }
                this.devices.set(id, String(serial));
                await this.setStateChangedAsync(`${id}.online`, { val: false, ack: true });
            }
        } catch (e) {
            this.log.debug(`Units of the earlier run not read: ${e.message}`);
        }
        this.subscribeStates('*');

        const type = this.connectionType();
        if (
            type === 'mqtt' &&
            String(this.config.connection || '')
                .trim()
                .toLowerCase() !== 'mqtt'
        ) {
            this.log.info(
                'This instance was set up for the Ambientika MQTT Bridge and keeps reading it. To read the units directly from the Ambientika cloud, choose the connection type in the adapter settings.',
            );
        }
        this.source = type === 'mqtt' ? new MqttSource(this) : new CloudSource(this);
        await this.source.start();
    },

    /**
     * setState that never throws after the adapter was stopped.
     *
     * @param {string} id state id below the instance
     * @param {any} val value
     */
    setStateSafe(id, val) {
        if (this.stopping) {
            return;
        }
        try {
            const p = this.setStateChangedAsync(id, { val, ack: true });
            if (p && p.catch) {
                p.catch(() => {});
            }
        } catch {
            // the database is gone during shutdown
        }
    },

    /**
     * Value in the type of the state; undefined = leave the state as it is.
     *
     * @param {any} v value as received
     * @param {string} type type of the state
     * @param {number} [max] longest text
     * @returns {any} the value to write
     */
    convert(v, type, max) {
        if (v === null) {
            return null;
        }
        if (type === 'number') {
            if (typeof v === 'number') {
                return Number.isFinite(v) ? v : undefined;
            }
            if (typeof v !== 'string' || !v.trim()) {
                return undefined;
            }
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        }
        if (type === 'boolean') {
            if (typeof v === 'boolean') {
                return v;
            }
            if (typeof v === 'number') {
                return v !== 0;
            }
            if (typeof v !== 'string') {
                return undefined;
            }
            const s = v.trim().toLowerCase();
            if (s === 'true' || s === 'on' || s === '1') {
                return true;
            }
            if (s === 'false' || s === 'off' || s === '0') {
                return false;
            }
            return undefined;
        }
        if (typeof v === 'object') {
            return undefined;
        }
        return String(v).slice(0, max || MAX_TEXT);
    },

    /**
     * Writes every field of the payload that has a state; the others are left alone.
     *
     * @param {string} base id of the device or channel
     * @param {Record<string, any>} defs state definitions by key
     * @param {Record<string, any>} payload values by key
     */
    async writeStates(base, defs, payload) {
        for (const [key, def] of Object.entries(defs)) {
            const from = def.from || key;
            if (!has(payload, from)) {
                continue;
            }
            const val = this.convert(payload[from], def.type, def.max);
            if (val === undefined) {
                continue;
            }
            await this.setStateChangedAsync(`${base}.${key}`, { val, ack: true });
        }
    },

    async createState(id, def) {
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: def.name,
                type: def.type,
                role: def.role,
                unit: def.unit,
                read: def.read !== false,
                write: !!def.write,
                states: def.states,
            },
            native: def.cmd ? { command: def.cmd } : {},
        });
    },

    /**
     * Creates the unit and its states once.
     *
     * @param {string} serial serial number of the unit
     * @param {object} spec what to create
     * @param {Record<string, any>} spec.states states directly below the unit
     * @param {Record<string, Record<string, any>>} [spec.channels] channel id -> its states
     * @param {string} [spec.name] name of the unit
     * @param {number} [spec.max] upper bound for the number of units
     * @returns {Promise<boolean>} false when the unit is not accepted
     */
    ensureDevice(serial, spec) {
        const id = this.idOf(serial);
        if (this.created.has(id)) {
            return Promise.resolve(this.devices.get(id) === String(serial));
        }
        if (!String(serial).trim() || String(serial).length > 64 || RESERVED.has(id)) {
            return Promise.resolve(false);
        }
        if (!this.pending.has(id)) {
            if (this.devices.has(id) && this.devices.get(id) !== String(serial)) {
                return Promise.resolve(false);
            }
            if (!this.devices.has(id) && spec.max && this.devices.size >= spec.max) {
                return Promise.resolve(false);
            }
            this.pending.set(
                id,
                this.createDevice(id, String(serial), spec)
                    .then(() => true)
                    .finally(() => this.pending.delete(id)),
            );
        }
        return this.pending.get(id).then(() => this.devices.get(id) === String(serial));
    },

    async createDevice(id, serial, spec) {
        const known = this.devices.has(id);
        this.devices.set(id, serial);
        const name = spec.name;
        await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: { name: name || `Ambientika ${serial}`, statusStates: { onlineId: `${this.namespace}.${id}.online` } },
            native: { serial },
        });
        for (const [key, def] of Object.entries(spec.states)) {
            await this.createState(`${id}.${key}`, def);
        }
        for (const [channel, defs] of Object.entries(spec.channels || {})) {
            await this.setObjectNotExistsAsync(`${id}.${channel}`, {
                type: 'channel',
                common: { name: channel.charAt(0).toUpperCase() + channel.slice(1) },
                native: {},
            });
            for (const [key, def] of Object.entries(defs)) {
                await this.createState(`${id}.${channel}.${key}`, def);
            }
        }
        if (known) {
            // Unit of an earlier version: bring the selectable values up to date.
            for (const [key, def] of Object.entries(spec.states)) {
                if (def.states) {
                    await this.extendObjectAsync(`${id}.${key}`, { common: { states: def.states } });
                }
            }
            await this.extendObjectAsync(id, { common: { statusStates: { onlineId: `${this.namespace}.${id}.online` } } });
        }
        if (name) {
            await this.extendObjectAsync(id, { common: { name } });
        }
        this.created.add(id);
        if (!known) {
            this.log.info(`Unit ${serial}${name ? ` (${name})` : ''} added`);
        }
    },

    async onStateChange(fullId, state) {
        if (!state || state.ack || this.stopping || !this.source) {
            return;
        }
        const local = fullId.slice(this.namespace.length + 1);
        const dot = local.indexOf('.');
        if (dot < 0) {
            return;
        }
        const id = local.slice(0, dot);
        const key = local.slice(dot + 1);
        const def = has(TOP_STATES, key) ? TOP_STATES[key] : null;
        if (!def || !def.cmd || RESERVED.has(id) || !this.devices.has(id)) {
            return;
        }
        const serial = this.devices.get(id);
        let value = state.val;
        if (key === 'reset_filter') {
            if (value !== true && value !== 1 && value !== 'true') {
                return;
            }
            value = true;
        } else if (typeof value !== 'string' || !def.values.includes(value)) {
            this.log.warn(`${local}: ${JSON.stringify(value)} cannot be set (allowed: ${def.values.join(', ')})`);
            return;
        }
        try {
            await this.source.command(id, serial, key, value);
        } catch (e) {
            if (!this.stopping) {
                this.log.warn(`${local}: ${e.message}`);
            }
        }
        if (key === 'reset_filter' && !this.stopping) {
            await this.setStateAsync(local, { val: false, ack: true });
        }
    },

    onUnload(callback) {
        this.stopping = true;
        try {
            if (this.source) {
                this.source.stop();
            }
        } catch {
            // nothing to do
        }
        callback();
    },
};

module.exports = { methods };
