'use strict';

const { OPERATING_MODES, FAN_SPEEDS_SHOWN, HUMIDITY_LEVELS, LIGHT_SENSOR_LEVELS, AIR_QUALITIES, FILTER_STATUSES } = require('./cloud');

function statesOf(list) {
    const out = {};
    for (const v of list) {
        out[v] = v;
    }
    return out;
}

/**
 * States of one unit. The ids are the same for both connection types, so a
 * script or a visualisation keeps working when the connection type is changed.
 *
 * cloud  = filled when the adapter reads the Ambientika cloud itself
 * cmd    = writable; attribute name of the command
 * values = what may be written
 */
const DEVICE_STATES = {
    operating_mode: { name: 'Operating mode', type: 'string', role: 'level.mode', write: true, cmd: 'operating_mode', values: OPERATING_MODES, cloud: true },
    fan_speed: { name: 'Fan speed', type: 'string', role: 'level.mode.fan', write: true, cmd: 'fan_speed', values: FAN_SPEEDS_SHOWN, cloud: true },
    humidity_level: { name: 'Humidity level', type: 'string', role: 'level.mode', write: true, cmd: 'humidity_level', values: HUMIDITY_LEVELS, cloud: true },
    light_sensor_level: {
        name: 'Light sensor sensitivity',
        type: 'string',
        role: 'level.mode',
        write: true,
        cmd: 'light_sensor_level',
        values: LIGHT_SENSOR_LEVELS,
        cloud: true,
    },
    temperature: { name: 'Temperature', type: 'number', role: 'value.temperature', unit: '°C', cloud: true },
    humidity: { name: 'Humidity', type: 'number', role: 'value.humidity', unit: '%', cloud: true },
    temperature_avg: { name: 'Temperature (averaged)', type: 'number', role: 'value.temperature', unit: '°C' },
    humidity_avg: { name: 'Humidity (averaged)', type: 'number', role: 'value.humidity', unit: '%' },
    humidity_raw: { name: 'Humidity raw', type: 'number', role: 'value.humidity', unit: '%' },
    air_quality: { name: 'Air quality', type: 'string', role: 'text', cloud: true },
    humidity_alarm: { name: 'Humidity alarm', type: 'boolean', role: 'indicator.alarm', cloud: true },
    night_alarm: { name: 'Night mode', type: 'boolean', role: 'indicator', cloud: true },
    filters_status: { name: 'Filter status', type: 'string', role: 'text', cloud: true },
    filters_status_raw: { name: 'Filter status raw', type: 'string', role: 'text' },
    filter_ack_since: { name: 'Filter acknowledged since', type: 'string', role: 'date' },
    filter_ack_until: { name: 'Filter acknowledgement valid until', type: 'string', role: 'date' },
    operating_mode_raw: { name: 'Mode raw', type: 'string', role: 'text' },
    last_operating_mode: { name: 'Last mode', type: 'string', role: 'text', cloud: true },
    device_role: { name: 'Device role', type: 'string', role: 'text', cloud: true },
    zone_index: { name: 'Zone', type: 'number', role: 'value', cloud: true },
    operating_mode_num: { name: 'Mode (num)', type: 'number', role: 'value', cloud: true },
    operating_mode_raw_num: { name: 'Mode raw (num)', type: 'number', role: 'value' },
    last_operating_mode_num: { name: 'Last mode (num)', type: 'number', role: 'value', cloud: true },
    fan_speed_num: { name: 'Fan speed (num)', type: 'number', role: 'value', cloud: true },
    humidity_level_num: { name: 'Humidity level (num)', type: 'number', role: 'value', cloud: true },
    light_sensor_level_num: { name: 'Light sensor sensitivity (num)', type: 'number', role: 'value', cloud: true },
    air_quality_num: { name: 'Air quality (num)', type: 'number', role: 'value', cloud: true },
    filter_status_num: { name: 'Filter status (num)', type: 'number', role: 'value', cloud: true },
    filter_status_raw_num: { name: 'Filter status raw (num)', type: 'number', role: 'value' },
};
for (const def of Object.values(DEVICE_STATES)) {
    if (def.values) {
        def.states = statesOf(def.values);
    }
}

/** Filled from <prefix>/<serial>/diagnostics of the MQTT Bridge, kept in the channel "diagnostics". */
const DIAGNOSTIC_STATES = {
    last_status: { name: 'Last status packet', type: 'string', role: 'date' },
    poll_failures_total: { name: 'Failed polls since the bridge started', type: 'number', role: 'value' },
    poll_failures_consecutive: { name: 'Failed polls in a row', type: 'number', role: 'value' },
    last_failure: { name: 'Last failed poll', type: 'string', role: 'date' },
    last_failure_reason: { name: 'Reason of the last failed poll', type: 'string', role: 'text' },
    last_outage_start: { name: 'Last outage: first failed poll', type: 'string', role: 'date' },
    last_outage_end: { name: 'Last outage: last failed poll', type: 'string', role: 'date' },
    last_outage_polls: { name: 'Last outage: failed polls', type: 'number', role: 'value' },
    bridge_started: { name: 'Bridge started (failed polls are counted from here)', type: 'string', role: 'date' },
};
/** From <prefix>/<serial>/reset_info of the MQTT Bridge, also in the channel "diagnostics". */
const RESET_INFO_STATES = {
    reset_note: { from: 'note', name: 'What the filter reset does on this unit', type: 'string', role: 'text', max: 1200 },
};

const EXTRA_DEVICE_STATES = {
    online: { name: 'Online', type: 'boolean', role: 'indicator.reachable', cloud: true },
    reset_state: { name: 'Filter reset status', type: 'string', role: 'text' },
    reset_filter: { name: 'Reset filter', type: 'boolean', role: 'button', read: false, write: true, cmd: 'reset_filter', cloud: true },
};

const NEURACELL_STATES = {
    radon_protection: { name: 'Radon protection active', type: 'boolean', role: 'indicator.alarm' },
    radon: { name: 'Radon', type: 'number', role: 'value', unit: 'Bq/m³' },
    radon_threshold: { name: 'Radon threshold', type: 'number', role: 'value', unit: 'Bq/m³' },
    radon_meter_connected: { name: 'Radon meter connected', type: 'boolean', role: 'indicator.reachable' },
    dewpoint_block: { name: 'Dew-point ventilation block', type: 'boolean', role: 'indicator' },
    dewpoint_controller_connected: { name: 'Dew-point controller connected', type: 'boolean', role: 'indicator.reachable' },
    dewpoint_fallback: { name: 'Fallback ventilation active', type: 'boolean', role: 'indicator' },
    indoor_dew_point: { name: 'Dew point indoor', type: 'number', role: 'value.temperature', unit: '°C' },
    outdoor_dew_point: { name: 'Dew point outdoor', type: 'number', role: 'value.temperature', unit: '°C' },
    override_active: { name: 'NeuraCell-X override active', type: 'boolean', role: 'indicator' },
};

const TOP_STATES = Object.assign({}, DEVICE_STATES, EXTRA_DEVICE_STATES);
const CHANNEL_STATES = Object.assign({}, DIAGNOSTIC_STATES, RESET_INFO_STATES);

function onlyCloud(defs) {
    const out = {};
    for (const [key, def] of Object.entries(defs)) {
        if (def.cloud) {
            out[key] = def;
        }
    }
    return out;
}
const CLOUD_STATES = onlyCloud(TOP_STATES);

/** Ids below the instance that are never a unit. */
const RESERVED = new Set(['bridge', 'neuracell', 'info']);

/** Number of a text value: its place in the list, higher = more / worse. null for an unknown value. */
function numberOf(list, value) {
    const i = list.indexOf(value);
    return i < 0 ? null : i;
}

function plusOne(n) {
    return n === null ? null : n + 1;
}

function fromEnd(list, value) {
    const i = list.indexOf(value);
    return i < 0 ? null : list.length - 1 - i;
}

/**
 * The status packet of the cloud in the keys of the states.
 *
 * @param {Record<string, any>} s status packet as the cloud sends it
 * @param {number|null} zone zone of the unit from the list of units
 * @returns {Record<string, any>} values by state key
 */
function fromCloudStatus(s, zone) {
    const fan = s.fanSpeed;
    return {
        operating_mode: s.operatingMode,
        fan_speed: fan,
        humidity_level: s.humidityLevel,
        light_sensor_level: s.lightSensorLevel,
        temperature: s.temperature,
        humidity: s.humidity,
        air_quality: s.airQuality,
        humidity_alarm: s.humidityAlarm,
        night_alarm: s.nightAlarm,
        filters_status: s.filtersStatus,
        last_operating_mode: s.lastOperatingMode,
        device_role: s.deviceRole,
        zone_index: zone,
        operating_mode_num: numberOf(OPERATING_MODES, s.operatingMode),
        last_operating_mode_num: numberOf(OPERATING_MODES, s.lastOperatingMode),
        // 1 Low, 2 Medium, 3 High, 4 Night, 5 Turbo - as the Ambientika MQTT Bridge counts them
        fan_speed_num: plusOne(numberOf(FAN_SPEEDS_SHOWN, fan)),
        humidity_level_num: numberOf(HUMIDITY_LEVELS, s.humidityLevel),
        light_sensor_level_num: numberOf(LIGHT_SENSOR_LEVELS, s.lightSensorLevel),
        // 4 = very good ... 0 = bad
        air_quality_num: fromEnd(AIR_QUALITIES, s.airQuality),
        // 0 = good, 1 = medium, 2 = bad
        filter_status_num: numberOf(FILTER_STATUSES, s.filtersStatus),
    };
}

module.exports = {
    DEVICE_STATES,
    DIAGNOSTIC_STATES,
    RESET_INFO_STATES,
    EXTRA_DEVICE_STATES,
    NEURACELL_STATES,
    TOP_STATES,
    CHANNEL_STATES,
    CLOUD_STATES,
    RESERVED,
    fromCloudStatus,
};
