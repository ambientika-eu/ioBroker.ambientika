'use strict';

const { methods } = require('../../lib/base');

/**
 * A stand-in for the adapter base class: objects and states in memory, the
 * methods of the real adapter class on top. Enough to run the connection types
 * without a js-controller; the integration tests use a real one.
 */
function createAdapter(config, existing) {
    const a = Object.create(methods);
    a.namespace = 'ambientika.0';
    a.instance = 0;
    a.FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
    a.config = config;
    a.objects = new Map(Object.entries(existing || {}));
    a.states = new Map();
    a.writes = []; // every state write, in order
    a.logs = [];
    a.timers = new Set();
    a.devices = new Map();
    a.created = new Set();
    a.pending = new Map();
    a.source = null;
    a.stopping = false;
    const logger = level => msg => a.logs.push({ level, msg: String(msg) });
    a.log = { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error'), silly: logger('silly') };
    a.setTimeout = (fn, ms) => {
        const t = setTimeout(() => {
            a.timers.delete(t);
            fn();
        }, ms);
        a.timers.add(t);
        return t;
    };
    a.clearTimeout = t => {
        clearTimeout(t);
        a.timers.delete(t);
    };
    a.subscribeStates = () => {};
    a.setStateAsync = async (id, state) => {
        if (a.stopping) throw new Error('write after stop');
        const s = typeof state === 'object' && state !== null ? state : { val: state, ack: false };
        a.states.set(id, { val: s.val, ack: !!s.ack });
        a.writes.push({ id, val: s.val, ack: !!s.ack });
    };
    a.setStateChangedAsync = async (id, state) => {
        const old = a.states.get(id);
        if (old && old.val === state.val && old.ack === !!state.ack) return;
        await a.setStateAsync(id, state);
    };
    a.setObjectNotExistsAsync = async (id, obj) => {
        if (!a.objects.has(id)) a.objects.set(id, JSON.parse(JSON.stringify(obj)));
    };
    a.extendObjectAsync = async (id, part) => {
        const obj = a.objects.get(id) || { common: {}, native: {} };
        obj.common = Object.assign({}, obj.common, part.common || {});
        obj.native = Object.assign({}, obj.native, part.native || {});
        a.objects.set(id, obj);
    };
    a.getDevicesAsync = async () => [...a.objects.entries()].filter(([, o]) => o.type === 'device').map(([id, o]) => Object.assign({ _id: `${a.namespace}.${id}` }, o));
    // what a user or a script does: write a state without ack
    a.userWrite = async (id, val) => {
        a.states.set(id, { val, ack: false });
        await a.onStateChange(`${a.namespace}.${id}`, { val, ack: false });
    };
    a.val = id => (a.states.has(id) ? a.states.get(id).val : undefined);
    a.logged = (level, re) => a.logs.filter(l => l.level === level && re.test(l.msg));
    a.end = () => new Promise(resolve => a.onUnload(resolve));
    return a;
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitFor(fn, what, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout waiting for ${what || fn}`);
        await wait(20);
    }
}

module.exports = { createAdapter, wait, waitFor };
