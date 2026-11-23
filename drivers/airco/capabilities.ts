import { DeviceCapabilities, BooleanCapability } from 'midea-msmarthome-ac-euosk105';

export const BASE_CAPABILITIES = [
  'onoff', 'thermostat_mode', 'target_temperature',
  'measure_temperature', 'measure_temperature.outside',
];

const OPTIONAL: Record<string, BooleanCapability[]> = {
  thermostat_boost: ['turboCool', 'turboHeat'],
  thermostat_fan_speed: ['fanSpeedControl'],
  thermostat_swing_mode: ['updownFan', 'leftrightFan'],
  thermostat_eco: ['ecoMode'],
  thermostat_freeze_protection: ['frostProtectionMode'],
};

export function supportedHomeyCapabilities(caps: DeviceCapabilities): string[] {
  return BASE_CAPABILITIES.concat(Object.keys(OPTIONAL).filter(
    id => OPTIONAL[id].some(name => caps.getSupport(name) === 'supported')
  ));
}

const MODE_FEATURES: Record<string, BooleanCapability> = {
  auto: 'autoMode', cool: 'coolMode', dry: 'dryMode', heat: 'heatMode',
};
const MODE_NAMES: Record<number, 'Auto' | 'Cool' | 'Heat'> = {
  1: 'Auto', 2: 'Cool', 4: 'Heat',
};
const TITLES: Record<string, { en: string; nl: string }> = {
  off: { en: 'Off', nl: 'Uit' }, fan: { en: 'Fan', nl: 'Ventileren' },
  auto: { en: 'Auto', nl: 'Automatisch' }, cool: { en: 'Cool', nl: 'Koelen' },
  dry: { en: 'Dry', nl: 'Ontvochtigen' }, heat: { en: 'Heat', nl: 'Verwarmen' },
  vertical: { en: 'Vertical', nl: 'Verticaal' },
  horizontal: { en: 'Horizontal', nl: 'Horizontaal' },
  both: { en: 'Both', nl: 'Beide' },
};

/** Unknown features are hidden on new devices; existing devices retain them. */
export function capabilityOptions(caps: DeviceCapabilities, existing = false): Record<string, object> {
  const modes = ['off', 'fan', ...Object.keys(MODE_FEATURES).filter(
    mode => caps.getSupport(MODE_FEATURES[mode]) === 'supported'
      || (existing && caps.getSupport(MODE_FEATURES[mode]) === 'unknown')
  )];
  const vertical = caps.getSupport('updownFan');
  const horizontal = caps.getSupport('leftrightFan');
  const swing = ['off'];
  if (vertical === 'supported' || (existing && vertical === 'unknown')) swing.push('vertical');
  if (horizontal === 'supported' || (existing && horizontal === 'unknown')) swing.push('horizontal');
  if (swing.includes('vertical') && swing.includes('horizontal')) swing.push('both');
  return {
    thermostat_mode: { values: modes.map(id => ({ id, title: TITLES[id] })) },
    thermostat_swing_mode: { values: swing.map(id => ({ id, title: TITLES[id] })) },
    target_temperature: temperatureOptions(caps),
  };
}

export function temperatureOptions(caps: DeviceCapabilities, mode?: number): { min?: number; max?: number; step?: number } {
  const modes = mode !== undefined
    ? (MODE_NAMES[mode] ? [MODE_NAMES[mode]] : [])
    : (['auto', 'cool', 'heat'] as const)
      .filter(name => caps.getSupport(MODE_FEATURES[name]) === 'supported')
      .map(name => ({ auto: 'Auto', cool: 'Cool', heat: 'Heat' } as const)[name]);
  const pairs = modes.map(name => [
    caps.getReportedValue(`minTemp${name}`),
    caps.getReportedValue(`maxTemp${name}`),
  ]).filter((pair): pair is [number, number] =>
    typeof pair[0] === 'number' && typeof pair[1] === 'number'
      && Number.isFinite(pair[0]) && Number.isFinite(pair[1])
      && pair[0] > 0 && pair[1] >= pair[0]);
  const options: { min?: number; max?: number; step?: number } = {};
  if (pairs.length) {
    options.min = Math.min(...pairs.map(pair => pair[0]));
    options.max = Math.max(...pairs.map(pair => pair[1]));
  }
  const decimals = caps.getSupport('decimals');
  if (decimals !== 'unknown') options.step = decimals === 'supported' ? 0.5 : 1;
  return options;
}

/** Explicitly unsupported operations are rejected before writing to the AC. */
export function assertSupported(caps: DeviceCapabilities, id: string, value: unknown, mode?: number): void {
  const features = OPTIONAL[id];
  if (features && features.every(name => caps.getSupport(name) === 'unsupported')) {
    throw new Error(`This air conditioner does not support ${id}`);
  }
  if (id === 'thermostat_mode') {
    const name = MODE_FEATURES[String(value)];
    if (name && caps.getSupport(name) === 'unsupported') throw new Error(`Unsupported mode: ${value}`);
  }
  if (id === 'thermostat_boost' && value === true) {
    const name = mode === 2 ? 'turboCool' : mode === 4 ? 'turboHeat' : undefined;
    if (name && caps.getSupport(name) === 'unsupported') throw new Error('Turbo is unsupported in this mode');
  }
  if (id === 'thermostat_swing_mode') {
    if ((value === 'vertical' || value === 'both') && caps.getSupport('updownFan') === 'unsupported') {
      throw new Error('Vertical swing is unsupported');
    }
    if ((value === 'horizontal' || value === 'both') && caps.getSupport('leftrightFan') === 'unsupported') {
      throw new Error('Horizontal swing is unsupported');
    }
  }
  if (id === 'target_temperature') {
    const t = Number(value);
    const options = temperatureOptions(caps, mode);
    if (!Number.isFinite(t) || (options.min !== undefined && t < options.min)
      || (options.max !== undefined && t > options.max)
      || (options.step !== undefined && Math.abs(t / options.step - Math.round(t / options.step)) > 1e-6)) {
      throw new Error('Temperature is outside the supported range or step');
    }
  }
}
