'use strict';

/**
 * ioBroker adapter for Ambientika ventilation units with heat recovery.
 *
 * Two connection types:
 *
 *   cloud  (default) The adapter signs in with the e-mail address and password
 *          of the Ambientika app and reads the units itself. Nothing else has
 *          to be installed.
 *   mqtt   The adapter reads the topics of the Ambientika MQTT Bridge from an
 *          MQTT broker (as adapter versions 1.x did). For installations that
 *          run the bridge anyway, e.g. for NeuraCell-X radon and dew-point
 *          protection.
 *
 * The object ids are the same for both: ambientika.<instance>.<serial>.<state>
 *
 * Maintained by Südwind GmbH, the manufacturer of Ambientika.
 * https://github.com/ambientika-eu/ioBroker.ambientika
 */

const utils = require('@iobroker/adapter-core');
const { methods } = require('./lib/base');

class AmbientikaAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'ambientika' });
        this.devices = new Map(); // object id -> serial
        this.created = new Set(); // object ids whose states exist
        this.pending = new Map(); // object id -> creation in progress
        this.source = null;
        this.stopping = false;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
}
Object.assign(AmbientikaAdapter.prototype, methods);

if (require.main !== module) {
    module.exports = options => new AmbientikaAdapter(options);
} else {
    new AmbientikaAdapter();
}
