'use strict';

/**
 * Client for the Ambientika cloud, the same one the Ambientika app uses.
 *
 *   POST /users/authenticate          { username, password } -> { id, jwtToken }
 *   GET  /house/houses-info           -> [{ houseId }]
 *   GET  /house/house-complete-info   ?houseId=  -> house with rooms and units
 *   GET  /device/device-status        ?deviceSerialNumber=  -> status packet
 *   POST /device/change-mode          { deviceSerialNumber, operatingMode, fanSpeed, humidityLevel, lightSensorLevel }
 *   GET  /device/reset-filter         ?deviceSerialNumber=
 *
 * Every request has a time limit: a request the cloud accepts and never answers
 * must not hold up the reading of the other units.
 */

const DEFAULT_HOST = 'https://app.ambientika.eu:4521';
/** Seconds the adapter waits for one answer of the cloud. */
const REQUEST_TIMEOUT_S = 20;
/** Longest answer that is still read (a status packet has a few hundred bytes). */
const MAX_BODY = 512 * 1024;

const OPERATING_MODES = [
    'Smart',
    'Auto',
    'ManualHeatRecovery',
    'Night',
    'AwayHome',
    'Surveillance',
    'TimedExpulsion',
    'Expulsion',
    'Intake',
    'MasterSlaveFlow',
    'SlaveMasterFlow',
    'Off',
];
/** Fan steps the cloud accepts in a command, in the order of their numbers. */
const FAN_SPEEDS = ['Low', 'Medium', 'High'];
/** Night and Turbo are steps a unit chooses itself; the cloud reports them and does not accept them. */
const FAN_SPEEDS_SHOWN = ['Low', 'Medium', 'High', 'Night', 'Turbo'];
const HUMIDITY_LEVELS = ['Dry', 'Normal', 'Moist'];
const LIGHT_SENSOR_LEVELS = ['NotAvailable', 'Off', 'Low', 'Medium'];
/** Best to worst. */
const AIR_QUALITIES = ['VeryGood', 'Good', 'Medium', 'Poor', 'Bad'];
/** Best to worst. */
const FILTER_STATUSES = ['Good', 'Medium', 'Bad'];

class CloudError extends Error {
    /**
     * @param {string} message what happened, for the log
     * @param {object} [info] details of the failure
     * @param {number|null} [info.status] HTTP status, null without an answer
     * @param {'auth'|'http'|'network'|'timeout'|'format'} [info.kind] kind of failure
     */
    constructor(message, info = {}) {
        super(message);
        this.name = 'CloudError';
        this.status = info.status === undefined ? null : info.status;
        this.kind = info.kind || 'http';
    }
}

/** A few words of an error answer of the cloud, never a whole HTML page. */
function shortText(data) {
    let text = data;
    if (data && typeof data === 'object') {
        text = data.message;
    }
    if (typeof text !== 'string') {
        return '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (/^</.test(text)) {
        return '';
    }
    return text.slice(0, 120);
}

/** The host as typed: spaces and slashes at the end do not count, https:// is assumed. */
function cleanHost(value) {
    let host = String(value === undefined || value === null ? '' : value)
        .trim()
        .replace(/\/+$/, '');
    if (!host) {
        return DEFAULT_HOST;
    }
    if (!/^https?:\/\//i.test(host)) {
        host = `https://${host}`;
    }
    return host;
}

class AmbientikaCloud {
    /**
     * @param {object} options sign-in data and limits
     * @param {string} options.username e-mail address of the Ambientika app
     * @param {string} options.password password of the Ambientika app
     * @param {string} [options.host] address of the cloud
     * @param {number} [options.timeoutS] seconds to wait for one answer
     * @param {typeof fetch} [options.fetch] for tests
     */
    constructor(options) {
        this.username = String(options.username || '');
        this.password = String(options.password === undefined || options.password === null ? '' : options.password);
        this.host = cleanHost(options.host);
        this.timeoutMs = (Number(options.timeoutS) > 0 ? Number(options.timeoutS) : REQUEST_TIMEOUT_S) * 1000;
        this.fetch = options.fetch || globalThis.fetch;
        this.token = null;
        this.signingIn = null;
        this.controllers = new Set();
        this.closed = false;
    }

    /** Ends every request under way; nothing is sent afterwards. */
    close() {
        this.closed = true;
        for (const c of this.controllers) {
            c.abort();
        }
        this.controllers.clear();
    }

    /**
     * One request with a time limit.
     *
     * @param {string} method GET or POST
     * @param {string} path path of the endpoint
     * @param {object} [options] what to send
     * @param {Record<string, string|number>} [options.query] query parameters
     * @param {any} [options.body] JSON body
     * @param {boolean} [options.auth] send the token (default true)
     * @returns {Promise<any>} parsed JSON, text, or null for an empty answer
     */
    async request(method, path, options = {}) {
        if (this.closed) {
            throw new CloudError('the adapter is stopping', { kind: 'network' });
        }
        const url = new URL(`${this.host}/${path}`);
        for (const [k, v] of Object.entries(options.query || {})) {
            url.searchParams.set(k, String(v));
        }
        const headers = { Accept: 'application/json' };
        if (options.auth !== false) {
            headers.Authorization = `Bearer ${this.token}`;
        }
        let body;
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.body);
        }
        const controller = new AbortController();
        this.controllers.add(controller);
        const limit = AbortSignal.timeout(this.timeoutMs);
        try {
            let res;
            let text;
            try {
                res = await this.fetch(url, { method, headers, body, signal: AbortSignal.any([controller.signal, limit]) });
                text = await res.text();
            } catch (e) {
                if (limit.aborted && !controller.signal.aborted) {
                    throw new CloudError(`no answer from the Ambientika cloud within ${Math.round(this.timeoutMs / 1000)} seconds`, {
                        kind: 'timeout',
                    });
                }
                const cause = e && e.cause && (e.cause.code || e.cause.message);
                throw new CloudError(`no connection to the Ambientika cloud (${cause || (e && e.message) || e})`, { kind: 'network' });
            }
            if (text.length > MAX_BODY) {
                text = text.slice(0, MAX_BODY);
            }
            const type = String(res.headers.get('content-type') || '').toLowerCase();
            let data = text === '' ? null : text;
            let parsed = false;
            if (text !== '' && type.includes('json')) {
                try {
                    data = JSON.parse(text);
                    parsed = true;
                } catch {
                    if (res.status === 200) {
                        throw new CloudError('the Ambientika cloud sent an answer that cannot be read', { status: 200, kind: 'format' });
                    }
                }
            }
            if (res.status !== 200) {
                const words = shortText(data);
                throw new CloudError(`HTTP status ${res.status}${words ? `: ${words}` : ''}`, { status: res.status, kind: 'http' });
            }
            return parsed || data === null ? data : { text: data };
        } finally {
            this.controllers.delete(controller);
        }
    }

    /**
     * Signs in. Several callers at the same time share one sign-in.
     *
     * @returns {Promise<void>}
     */
    signIn() {
        if (!this.signingIn) {
            this.signingIn = (async () => {
                let data;
                try {
                    data = await this.request('POST', 'users/authenticate', {
                        auth: false,
                        body: { username: this.username, password: this.password },
                    });
                } catch (e) {
                    if (e instanceof CloudError && [400, 401, 403].includes(e.status)) {
                        throw new CloudError('the Ambientika cloud did not accept e-mail address and password', { status: e.status, kind: 'auth' });
                    }
                    throw e;
                }
                if (!data || typeof data.jwtToken !== 'string' || !data.jwtToken) {
                    throw new CloudError('the Ambientika cloud answered the sign-in without a token', { status: 200, kind: 'format' });
                }
                this.token = data.jwtToken;
            })().finally(() => {
                this.signingIn = null;
            });
        }
        return this.signingIn;
    }

    /**
     * A request with the token. A sign-in that has expired is renewed once.
     *
     * @param {string} method GET or POST
     * @param {string} path path of the endpoint
     * @param {object} [options] see request()
     * @returns {Promise<any>} the answer
     */
    async authed(method, path, options = {}) {
        if (!this.token) {
            await this.signIn();
        }
        const used = this.token;
        try {
            return await this.request(method, path, options);
        } catch (e) {
            if (!(e instanceof CloudError) || ![401, 403].includes(e.status)) {
                throw e;
            }
            // Several requests may find out at the same time: one sign-in for all of them.
            if (this.token === used) {
                this.token = null;
            }
            if (!this.token) {
                await this.signIn();
            }
            return this.request(method, path, options);
        }
    }

    /**
     * All units of the account, over all houses and rooms.
     *
     * @returns {Promise<Array<{serial: string, name: string, role: string, zone: number|null, type: string, room: string, house: string}>>} the units
     */
    async units() {
        const houses = await this.authed('GET', 'house/houses-info');
        if (!Array.isArray(houses)) {
            throw new CloudError('the list of houses cannot be read', { status: 200, kind: 'format' });
        }
        const units = [];
        const seen = new Set();
        for (const entry of houses) {
            const houseId = entry && (entry.houseId !== undefined ? entry.houseId : entry.id);
            if (houseId === undefined || houseId === null) {
                continue;
            }
            const house = await this.authed('GET', 'house/house-complete-info', { query: { houseId } });
            if (!house || typeof house !== 'object' || !Array.isArray(house.rooms)) {
                continue;
            }
            for (const room of house.rooms) {
                if (!room || !Array.isArray(room.devices)) {
                    continue;
                }
                for (const d of room.devices) {
                    if (!d || typeof d.serialNumber !== 'string' || !d.serialNumber.trim()) {
                        continue;
                    }
                    const serial = d.serialNumber.trim();
                    if (seen.has(serial)) {
                        continue;
                    }
                    seen.add(serial);
                    units.push({
                        serial,
                        name: typeof d.name === 'string' ? d.name.trim().slice(0, 120) : '',
                        role: typeof d.role === 'string' ? d.role : '',
                        zone: Number.isInteger(d.zoneIndex) ? d.zoneIndex : null,
                        type: typeof d.deviceType === 'string' ? d.deviceType : '',
                        room: typeof room.name === 'string' ? room.name.trim().slice(0, 120) : '',
                        house: typeof house.name === 'string' ? house.name.trim().slice(0, 120) : '',
                    });
                }
            }
        }
        return units;
    }

    /**
     * The status packet of one unit as the cloud holds it.
     *
     * @param {string} serial serial number of the unit
     * @returns {Promise<Record<string, any>>} the status packet
     */
    async status(serial) {
        const data = await this.authed('GET', 'device/device-status', { query: { deviceSerialNumber: serial } });
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.operatingMode !== 'string') {
            throw new CloudError('the status packet cannot be read', { status: 200, kind: 'format' });
        }
        return data;
    }

    /**
     * Sets mode, fan step, humidity level and light sensor of a unit. The cloud
     * wants all of them in one command.
     *
     * @param {string} serial serial number of the unit
     * @param {object} mode the settings by name
     * @param {string} mode.operatingMode one of OPERATING_MODES
     * @param {string} mode.fanSpeed one of FAN_SPEEDS
     * @param {string} mode.humidityLevel one of HUMIDITY_LEVELS
     * @param {string} [mode.lightSensorLevel] one of LIGHT_SENSOR_LEVELS; left out, the unit keeps its own
     * @returns {Promise<void>}
     */
    async changeMode(serial, mode) {
        const op = OPERATING_MODES.indexOf(mode.operatingMode);
        const fan = FAN_SPEEDS.indexOf(mode.fanSpeed);
        const hum = HUMIDITY_LEVELS.indexOf(mode.humidityLevel);
        if (op < 0 || fan < 0 || hum < 0) {
            throw new CloudError('this combination cannot be sent', { kind: 'format' });
        }
        const body = { deviceSerialNumber: serial, operatingMode: String(op), fanSpeed: fan, humidityLevel: hum };
        const light = LIGHT_SENSOR_LEVELS.indexOf(mode.lightSensorLevel);
        if (light >= 0) {
            body.lightSensorLevel = light;
        }
        await this.authed('POST', 'device/change-mode', { body });
    }

    /**
     * Asks the cloud to clear the filter counter of a unit.
     *
     * @param {string} serial serial number of the unit
     * @returns {Promise<void>}
     */
    async resetFilter(serial) {
        await this.authed('GET', 'device/reset-filter', { query: { deviceSerialNumber: serial } });
    }
}

module.exports = {
    AmbientikaCloud,
    CloudError,
    cleanHost,
    DEFAULT_HOST,
    OPERATING_MODES,
    FAN_SPEEDS,
    FAN_SPEEDS_SHOWN,
    HUMIDITY_LEVELS,
    LIGHT_SENSOR_LEVELS,
    AIR_QUALITIES,
    FILTER_STATUSES,
};
