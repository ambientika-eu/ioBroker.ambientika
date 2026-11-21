'use strict';

/**
 * Connection type "mqtt": reads the topics of the Ambientika MQTT Bridge from
 * an MQTT broker and shows every unit as an ioBroker device.
 *
 *   <prefix>/<serial>/state         JSON status of the unit (retained)
 *   <prefix>/<serial>/availability  online / offline (retained)
 *   <prefix>/<serial>/diagnostics   JSON poll diagnostics (retained)
 *   <prefix>/<serial>/reset_state   status of the last filter reset (retained)
 *   <prefix>/<serial>/reset_info    JSON, what the filter reset does on this unit
 *   <prefix>/bridge/availability    online / offline of the bridge itself
 *   <prefix>/neuracell/state        NeuraCell-X radon and dew-point status
 *   <discovery>/+/+/config          Home Assistant discovery, used for the unit names
 *
 * Commands are sent back as <prefix>/<serial>/set/<attribute> with a plain value.
 *
 * NeuraCell-X(R) and PhaseCell-X(R) are registered trademarks. Patent pending.
 * https://github.com/ambientika-eu/ambientika-mqtt-bridge
 */

const { DEVICE_STATES, DIAGNOSTIC_STATES, RESET_INFO_STATES, NEURACELL_STATES, TOP_STATES, CHANNEL_STATES } = require('./states');

/** Longest payload that is still looked at; the bridge stays far below this. */
const MAX_PAYLOAD = 64 * 1024;
/** Upper bound for units created from MQTT messages. */
const MAX_DEVICES = 250;

/**
 * A prefix as typed: spaces and slashes around it do not count.
 *
 * @param {any} value the prefix as typed
 * @param {string} fallback used when nothing was typed
 * @returns {string} the prefix
 */
function cleanPrefix(value, fallback) {
    return String(value === undefined || value === null ? fallback : value)
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .trim();
}

class MqttSource {
    /**
     * @param {any} adapter the adapter instance
     */
    constructor(adapter) {
        this.adapter = adapter;
        this.log = adapter.log;
        this.client = null;
        this.names = new Map(); // serial -> name from discovery
        this.unitOnline = new Map(); // object id -> availability the bridge reported
        this.bridgeOnline = null; // null = not reported
        this.connected = false;
        this.limitLogged = false;
        this.prefix = cleanPrefix(adapter.config.mqttPrefix, 'ambientika') || 'ambientika';
        this.discoveryPrefix = cleanPrefix(adapter.config.discoveryPrefix, 'homeassistant');
    }

    async start() {
        const a = this.adapter;
        await a.setObjectNotExistsAsync('info.bridge', {
            type: 'state',
            common: { name: 'Ambientika MQTT Bridge online', type: 'boolean', role: 'indicator.reachable', read: true, write: false, def: false },
            native: {},
        });
        await a.setStateAsync('info.bridge', { val: false, ack: true });

        const c = a.config;
        if (/[+#]/.test(this.prefix) || /[+#]/.test(this.discoveryPrefix)) {
            this.log.error(
                'The topic prefix and the discovery prefix must not contain + or # - please correct them in the adapter settings. Nothing is read until then.',
            );
            return;
        }
        // Host as typed: a pasted "mqtt://" in front, a slash behind or brackets around an IPv6 address do not count.
        let host = String(c.mqttHost || '')
            .trim()
            .replace(/^[a-z]+:\/\//i, '')
            .replace(/\/+$/, '');
        if (host.startsWith('[') && host.endsWith(']')) {
            host = host.slice(1, -1);
        }
        host = host || 'localhost';
        const typedPort = Number(c.mqttPort);
        const port = Number.isInteger(typedPort) && typedPort > 0 && typedPort < 65536 ? typedPort : 1883;
        const protocol = c.mqttTls ? 'mqtts' : 'mqtt';
        const url = `${protocol}://${host.includes(':') ? `[${host}]` : host}:${port}`;
        const opts = {
            protocol,
            host,
            port,
            clientId: `iobroker-ambientika-${a.instance}-${Math.random().toString(16).slice(2, 8)}`,
            clean: true,
            reconnectPeriod: 5000,
            connectTimeout: 15000,
        };
        if (c.mqttUser) {
            opts.username = String(c.mqttUser);
            opts.password = c.mqttPassword === undefined || c.mqttPassword === null ? '' : String(c.mqttPassword);
        }
        if (c.mqttTls && c.mqttTlsInsecure) {
            opts.rejectUnauthorized = false;
        }

        this.log.info(`Connecting to MQTT broker ${url}, topic prefix "${this.prefix}"`);
        let lastError = '';
        // Loaded here: an instance that reads the cloud itself does not need the MQTT client.
        const mqtt = require('mqtt');
        this.client = mqtt.connect(opts);
        this.client.on('connect', () => {
            lastError = '';
            this.connected = true;
            this.log.info('Connected to MQTT broker');
            a.setStateSafe('info.connection', true);
            const topics = [
                `${this.prefix}/+/state`,
                `${this.prefix}/+/availability`,
                `${this.prefix}/+/diagnostics`,
                `${this.prefix}/+/reset_state`,
                `${this.prefix}/+/reset_info`,
            ];
            if (this.discoveryPrefix) {
                topics.push(`${this.discoveryPrefix}/+/+/config`);
            }
            this.client.subscribe(topics, err => {
                if (err) {
                    this.log.error(`Subscribe failed: ${err.message}`);
                } else {
                    this.log.debug(`Subscribed to ${topics.join(', ')}`);
                }
            });
        });
        this.client.on('close', () => {
            if (!this.connected) {
                return;
            }
            this.connected = false;
            this.log.info('Connection to the MQTT broker lost - trying again every 5 seconds');
            this.onDisconnected().catch(() => {});
        });
        this.client.on('error', err => {
            // The client retries on its own; the same error is reported once.
            const text = String((err && err.message) || err);
            if (text !== lastError) {
                this.log.warn(`MQTT broker ${url}: ${text}`);
            }
            lastError = text;
        });
        this.client.on('message', (topic, msg) => {
            this.onMessage(topic, msg).catch(e => this.log.warn(`Message on ${topic} not processed: ${e.message}`));
        });
    }

    stop() {
        if (this.client) {
            this.client.removeAllListeners('message');
            this.client.end(true);
        }
    }

    ensure(serial) {
        const a = this.adapter;
        const id = a.idOf(serial);
        if (!a.created.has(id) && !a.pending.has(id) && !a.devices.has(id) && a.devices.size >= MAX_DEVICES) {
            if (!this.limitLogged) {
                this.log.warn(`More than ${MAX_DEVICES} units on the MQTT broker - further units are ignored`);
            }
            this.limitLogged = true;
        }
        return a.ensureDevice(serial, {
            states: TOP_STATES,
            channels: { diagnostics: CHANNEL_STATES },
            name: this.names.get(String(serial)),
            max: MAX_DEVICES,
        });
    }

    /** Without the broker nothing is known about bridge and units. */
    async onDisconnected() {
        const a = this.adapter;
        if (a.stopping) {
            return;
        }
        this.bridgeOnline = null;
        this.unitOnline.clear();
        await a.setStateChangedAsync('info.connection', { val: false, ack: true });
        await a.setStateChangedAsync('info.bridge', { val: false, ack: true });
        for (const id of a.created) {
            if (a.devices.has(id)) {
                await a.setStateChangedAsync(`${id}.online`, { val: false, ack: true });
            }
        }
    }

    async onMessage(topic, msg) {
        const a = this.adapter;
        if (a.stopping || !msg || msg.length > MAX_PAYLOAD) {
            return;
        }
        const text = msg.toString();
        const disc = this.discoveryPrefix;
        if (disc && topic.startsWith(`${disc}/`) && topic.endsWith('/config')) {
            return this.onDiscovery(text);
        }
        if (!topic.startsWith(`${this.prefix}/`)) {
            return;
        }
        const parts = topic.slice(this.prefix.length + 1).split('/');
        if (parts.length !== 2) {
            return;
        }
        const [serial, kind] = parts;
        if (!serial) {
            return;
        }

        if (serial === 'neuracell') {
            return kind === 'state' ? this.onNeuraCell(text) : undefined;
        }
        if (serial === 'bridge') {
            return kind === 'availability' ? this.onBridgeAvailability(text) : undefined;
        }

        if (kind === 'availability') {
            const word = text.trim().toLowerCase();
            if (word !== 'online' && word !== 'offline') {
                return;
            }
            if (!(await this.ensure(serial))) {
                return;
            }
            const id = a.idOf(serial);
            this.unitOnline.set(id, word === 'online');
            await this.publishOnline(id);
            return;
        }
        if (kind === 'reset_state') {
            const word = text.trim();
            if (!word || word.length > 40) {
                return;
            }
            if (!(await this.ensure(serial))) {
                return;
            }
            await a.setStateChangedAsync(`${a.idOf(serial)}.reset_state`, { val: word, ack: true });
            return;
        }
        if (kind !== 'state' && kind !== 'diagnostics' && kind !== 'reset_info') {
            return;
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            this.log.debug(`${topic} is not JSON`);
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return;
        }
        if (!(await this.ensure(serial))) {
            return;
        }
        const id = a.idOf(serial);
        if (kind === 'state') {
            await a.writeStates(id, DEVICE_STATES, payload);
        } else if (kind === 'diagnostics') {
            await a.writeStates(`${id}.diagnostics`, DIAGNOSTIC_STATES, payload);
        } else {
            await a.writeStates(`${id}.diagnostics`, RESET_INFO_STATES, payload);
        }
    }

    async onBridgeAvailability(text) {
        const word = text.trim().toLowerCase();
        if (word !== 'online' && word !== 'offline') {
            return;
        }
        const online = word === 'online';
        if (this.bridgeOnline === online) {
            return;
        }
        const first = this.bridgeOnline === null;
        this.bridgeOnline = online;
        if (!online) {
            this.log.warn('The Ambientika MQTT Bridge reports offline - the values of the units are not updated until it is back');
        } else if (!first) {
            this.log.info('The Ambientika MQTT Bridge is online again');
        }
        await this.adapter.setStateChangedAsync('info.bridge', { val: online, ack: true });
        for (const id of this.unitOnline.keys()) {
            await this.publishOnline(id);
        }
    }

    /**
     * A unit is online when the bridge says so and the bridge itself is running.
     *
     * @param {string} id id of the unit below the instance
     */
    async publishOnline(id) {
        const a = this.adapter;
        if (!this.unitOnline.has(id) || !a.created.has(id)) {
            return;
        }
        const online = this.connected && this.unitOnline.get(id) === true && this.bridgeOnline !== false;
        await a.setStateChangedAsync(`${id}.online`, { val: online, ack: true });
    }

    async onDiscovery(text) {
        const a = this.adapter;
        let cfg;
        try {
            cfg = JSON.parse(text);
        } catch {
            return;
        }
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
            return;
        }
        const dev = cfg.device || cfg.dev;
        if (!dev || typeof dev !== 'object') {
            return;
        }
        const ids = dev.identifiers || dev.ids;
        const name = typeof dev.name === 'string' ? dev.name.trim().slice(0, 120) : '';
        if (!Array.isArray(ids) || typeof ids[0] !== 'string' || !ids[0] || !name) {
            return;
        }
        // Only entities of this bridge: their topics start with its prefix.
        const refs = [cfg.state_topic, cfg.stat_t, cfg.command_topic, cfg.cmd_t, cfg.availability_topic, cfg.avty_t];
        if (!refs.some(t => typeof t === 'string' && t.startsWith(`${this.prefix}/`))) {
            return;
        }
        const serial = ids[0];
        if (this.names.get(serial) === name) {
            return;
        }
        if (!this.names.has(serial) && this.names.size >= 4 * MAX_DEVICES) {
            return;
        }
        this.names.set(serial, name);
        const id = a.idOf(serial);
        if (a.pending.has(id)) {
            await a.pending.get(id).catch(() => {});
        }
        if (a.created.has(id) && a.devices.get(id) === serial) {
            await a.extendObjectAsync(id, { common: { name } });
        }
    }

    async onNeuraCell(text) {
        const a = this.adapter;
        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return;
        }
        if (!a.created.has('neuracell')) {
            if (!a.pending.has('neuracell')) {
                a.pending.set(
                    'neuracell',
                    (async () => {
                        await a.setObjectNotExistsAsync('neuracell', {
                            type: 'device',
                            common: { name: 'NeuraCell-X® radon and dew-point protection' },
                            native: {},
                        });
                        for (const [key, def] of Object.entries(NEURACELL_STATES)) {
                            await a.createState(`neuracell.${key}`, def);
                        }
                        a.created.add('neuracell');
                    })().finally(() => a.pending.delete('neuracell')),
                );
            }
            await a.pending.get('neuracell');
        }
        await a.writeStates('neuracell', NEURACELL_STATES, payload);
    }

    /**
     * Sends a command to the bridge.
     *
     * @param {string} id id of the unit below the instance
     * @param {string} serial serial number of the unit
     * @param {string} key state key
     * @param {string|boolean} value value to set
     */
    async command(id, serial, key, value) {
        const def = TOP_STATES[key];
        if (!this.client || !this.connected) {
            throw new Error('not connected to the MQTT broker, nothing sent');
        }
        const topic = `${this.prefix}/${serial}/set/${def.cmd}`;
        const payload = value === true ? 'true' : String(value);
        this.client.publish(topic, payload, { qos: 1 }, err => {
            if (err && !this.adapter.stopping) {
                this.log.warn(`${topic} not sent: ${err.message}`);
            }
        });
        this.log.debug(`Sent ${topic} = ${payload}`);
    }
}

module.exports = { MqttSource, cleanPrefix };
