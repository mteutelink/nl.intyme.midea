const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceCapabilities } = require(process.env.MIDEA_CAPABILITIES_LIBRARY || 'midea-msmarthome-ac-euosk105');
const {
  supportedHomeyCapabilities, capabilityOptions, assertSupported, temperatureOptions,
} = require('../.homeybuild/drivers/airco/capabilities');

function caps(values) {
  return DeviceCapabilities.fromSnapshot({ version: 1, reported: values, raw: [] });
}

test('unknown optional functions remain hidden on new devices', () => {
  const unknown = new DeviceCapabilities();
  assert.equal(supportedHomeyCapabilities(unknown).includes('thermostat_boost'), false);
  assert.equal(supportedHomeyCapabilities(unknown).includes('thermostat_fan_speed'), false);
  assert.deepEqual(capabilityOptions(unknown).thermostat_mode.values.map(x => x.id), ['off', 'fan']);
  assert(capabilityOptions(unknown, true).thermostat_mode.values.some(x => x.id === 'heat'));
});

test('cool-only and vertical-only capabilities produce matching controls', () => {
  const c = caps({ coolMode: true, heatMode: false, autoMode: false, dryMode: true,
    updownFan: true, leftrightFan: false, turboCool: true, turboHeat: false });
  const ids = supportedHomeyCapabilities(c);
  assert(ids.includes('thermostat_boost'));
  assert(ids.includes('thermostat_swing_mode'));
  assert(!ids.includes('thermostat_eco'));
  assert.deepEqual(capabilityOptions(c).thermostat_swing_mode.values.map(x => x.id), ['off', 'vertical']);
  assert(!capabilityOptions(c).thermostat_mode.values.some(x => x.id === 'heat'));
  assert.throws(() => assertSupported(c, 'thermostat_mode', 'heat'), /Unsupported/);
  assert.throws(() => assertSupported(c, 'thermostat_swing_mode', 'both'), /unsupported/);
});

test('temperature limits use reported mode-specific bounds and resolution', () => {
  const c = caps({ coolMode: true, heatMode: true, minTempCool: 16, maxTempCool: 30,
    minTempHeat: 18, maxTempHeat: 28, decimals: true });
  assert.deepEqual(temperatureOptions(c, 4), { min: 18, max: 28, step: 0.5 });
  assert.doesNotThrow(() => assertSupported(c, 'target_temperature', 18.5, 4));
  assert.throws(() => assertSupported(c, 'target_temperature', 17, 4), /range/);
  assert.throws(() => assertSupported(c, 'target_temperature', 18.25, 4), /range/);
  assert.throws(() => assertSupported(c, 'target_temperature', NaN, 4), /range/);
});

test('unknown existing functions remain usable; explicitly unsupported ones are rejected', () => {
  assert.doesNotThrow(() => assertSupported(new DeviceCapabilities(), 'thermostat_eco', true));
  assert.throws(() => assertSupported(caps({ ecoMode: false, specialEco: false }), 'thermostat_eco', true), /support/);
});

test('failed capability refresh keeps cached support and does not remove controls', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const lib = require(process.env.MIDEA_CAPABILITIES_LIBRARY || 'midea-msmarthome-ac-euosk105');
  let response = null;
  const stored = { mideaCapabilities: caps({ heatMode: true, turboHeat: true }).toSnapshot() };
  const ids = new Set(['onoff', 'thermostat_mode', 'target_temperature', 'thermostat_eco']);
  const options = {};
  class HomeyDevice {
    getStoreValue(key) { return stored[key]; }
    async setStoreValue(key, value) { stored[key] = value; }
    hasCapability(id) { return ids.has(id); }
    async addCapability(id) { ids.add(id); }
    async removeCapability() { throw new Error('must not remove existing capabilities'); }
    getCapabilityOptions(id) { return options[id] || {}; }
    async setCapabilityOptions(id, value) { options[id] = value; }
    log() {}
  }
  const mockedLib = { ...lib, GetCapabilitiesCommand: class {
    async execute() { if (!response) throw new Error('temporary network failure'); return response; }
  }};
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../.homeybuild/drivers/airco/device'), 'utf8'), {
    Error, module: mod, exports: mod.exports,
    require: name => name === 'homey' ? { Device: HomeyDevice }
      : name === './capabilities' ? require('../.homeybuild/drivers/airco/capabilities')
        : mockedLib,
  });
  const device = new mod.exports();
  await device._loadCapabilities();
  assert(ids.has('thermostat_boost'));
  assert(ids.has('thermostat_eco'));
  assert(options.thermostat_mode.values.some(value => value.id === 'heat'));
  response = caps({ updownFan: true, leftrightFan: false });
  await device._loadCapabilities();
  assert(ids.has('thermostat_swing_mode'));
  assert.equal(stored.mideaCapabilities.reported.heatMode, true);
  assert.equal(stored.mideaCapabilities.reported.updownFan, true);
});

test('unreported temperature and frost fields never reset Homey readings to zero/false', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const lib = require(process.env.MIDEA_CAPABILITIES_LIBRARY || 'midea-msmarthome-ac-euosk105');
  const updated = {};
  class HomeyDevice {
    log() {} error() {}
    hasCapability() { return true; }
    getCapabilityOptions() { return {}; }
    async setCapabilityValue(id, value) { updated[id] = value; }
  }
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../.homeybuild/drivers/airco/device'), 'utf8'), {
    Error, module: mod, exports: mod.exports,
    require: name => name === 'homey' ? { Device: HomeyDevice }
      : name === './capabilities' ? require('../.homeybuild/drivers/airco/capabilities') : lib,
  });
  const data = Buffer.alloc(17);
  data[0] = 0xC0; data[2] = (2 << 5) | 7;
  data[11] = data[12] = 0xFF;
  const state = new lib.GetStateResponse(Buffer.concat([Buffer.alloc(10),data,Buffer.alloc(2)]));
  const device = new mod.exports();
  device._updateState(state);
  assert.equal(updated['measure_temperature'], undefined);
  assert.equal(updated['measure_temperature.outside'], undefined);
  assert.equal(updated['thermostat_freeze_protection'], undefined);
  assert.equal(updated['target_temperature'], 23);
});
