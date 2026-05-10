'use strict';

import { DeviceCapabilities, DeviceState } from 'midea-msmarthome-ac-euosk105';

const OPERATIONAL_MODE_AUTO = 1;
const OPERATIONAL_MODE_COOL = 2;
const OPERATIONAL_MODE_DRY = 3;
const OPERATIONAL_MODE_HEAT = 4;
const OPERATIONAL_MODE_FAN = 5;
const FAN_SPEED_SILENT = 20;
const FAN_SPEED_LOW = 40;
const FAN_SPEED_MEDIUM = 60;
const FAN_SPEED_HIGH = 80;
const FAN_SPEED_FULL = 100;
const FAN_SPEED_AUTO = 102;
const FAN_SPEED_FIXED = 101;
const SWING_MODE_OFF = 0;
const SWING_MODE_VERTICAL = 12;
const SWING_MODE_HORIZONTAL = 3;
const SWING_MODE_BOTH = 15;
const DEFAULT_MIN_TARGET_TEMPERATURE = 16;
const DEFAULT_MAX_TARGET_TEMPERATURE = 30;
const FAHRENHEIT_TARGET_THRESHOLD = 45;
const MIN_VALID_OUTDOOR_TEMPERATURE = -50;
const MAX_VALID_OUTDOOR_TEMPERATURE = 60;

export const SETTABLE_CAPABILITY_IDS = [
  'onoff',
  'target_temperature',
  'thermostat_mode',
  'thermostat_boost',
  'thermostat_fan_speed',
  'thermostat_swing_mode',
  'thermostat_eco',
  'thermostat_freeze_protection',
];

type CapabilityValue = {
  id: string;
  title: {
    en: string;
    nl: string;
  };
};

type HomeyCapabilityValue = boolean | number | string | null;

export type TargetTemperatureOptions = {
  min: number;
  max: number;
  step: number;
};

export function getSupportedCapabilityIds(capabilities: DeviceCapabilities): string[] {
  return [
    'onoff',
    'thermostat_mode',
    'target_temperature',
    'measure_temperature',
    'measure_temperature.inside',
    'measure_temperature.outside',
    ...(capabilities.turboCool || capabilities.turboHeat ? ['thermostat_boost'] : []),
    ...(capabilities.fanSpeedControl ? ['thermostat_fan_speed'] : []),
    ...(capabilities.updownFan || capabilities.leftrightFan ? ['thermostat_swing_mode'] : []),
    ...(capabilities.ecoMode || capabilities.specialEco ? ['thermostat_eco'] : []),
    ...(capabilities.frostProtectionMode ? ['thermostat_freeze_protection'] : []),
  ];
}

export function getTargetTemperatureOptions(capabilities: DeviceCapabilities): TargetTemperatureOptions {
  const mins = [capabilities.minTempAuto, capabilities.minTempCool, capabilities.minTempHeat]
    .filter((value) => Number.isFinite(value) && value > 0);
  const maxes = [capabilities.maxTempAuto, capabilities.maxTempCool, capabilities.maxTempHeat]
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    min: mins.length ? Math.min(...mins) : DEFAULT_MIN_TARGET_TEMPERATURE,
    max: maxes.length ? Math.max(...maxes) : DEFAULT_MAX_TARGET_TEMPERATURE,
    step: capabilities.decimals ? 0.5 : 1,
  };
}

function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(step < 1 ? 1 : 0));
}

function isTargetTemperatureOptions(value: DeviceCapabilities | TargetTemperatureOptions): value is TargetTemperatureOptions {
  return typeof (value as TargetTemperatureOptions).step === 'number';
}

export function normalizeTargetTemperatureWithOptions(value: number, options: TargetTemperatureOptions): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid target temperature: ${value}`);
  }

  const convertedValue = value >= FAHRENHEIT_TARGET_THRESHOLD
    ? (value - 32) * (5 / 9)
    : value;
  const normalizedValue = roundToStep(convertedValue, options.step);

  if (normalizedValue < options.min || normalizedValue > options.max) {
    throw new Error(`Target temperature ${value} is outside supported range ${options.min}-${options.max}`);
  }

  return normalizedValue;
}

export function normalizeTargetTemperature(
  value: number,
  capabilities: DeviceCapabilities | TargetTemperatureOptions | null,
): number {
  let options: TargetTemperatureOptions;

  if (!capabilities) {
    options = {
      min: DEFAULT_MIN_TARGET_TEMPERATURE,
      max: DEFAULT_MAX_TARGET_TEMPERATURE,
      step: 1,
    };
  } else if (isTargetTemperatureOptions(capabilities)) {
    options = capabilities;
  } else {
    options = getTargetTemperatureOptions(capabilities);
  }

  return normalizeTargetTemperatureWithOptions(value, options);
}

export function normalizeOutdoorTemperature(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const temperature = Number(value);
  if (temperature < MIN_VALID_OUTDOOR_TEMPERATURE || temperature > MAX_VALID_OUTDOOR_TEMPERATURE) {
    return null;
  }

  return temperature;
}

function capabilityValue(id: string, en: string, nl: string): CapabilityValue {
  return {
    id,
    title: { en, nl },
  };
}

function getThermostatModeValues(capabilities: DeviceCapabilities): CapabilityValue[] {
  const values = [
    capabilityValue('off', 'Off', 'Uit'),
  ];

  if (capabilities.heatMode) {
    values.push(capabilityValue('heat', 'Heat', 'Verwarmen'));
  }
  if (capabilities.coolMode) {
    values.push(capabilityValue('cool', 'Cool', 'Koelen'));
  }
  if (capabilities.dryMode) {
    values.push(capabilityValue('dry', 'Dry', 'Drogen'));
  }
  values.push(capabilityValue('fan', 'Fan', 'Ventilator'));
  if (capabilities.autoMode) {
    values.push(capabilityValue('auto', 'Automatic', 'Automatisch'));
  }

  return values;
}

function getSwingModeValues(capabilities: DeviceCapabilities): CapabilityValue[] {
  const values = [
    capabilityValue('off', 'Off', 'Uit'),
  ];

  if (capabilities.updownFan) {
    values.push(capabilityValue('vertical', 'Vertical', 'Verticaal'));
  }
  if (capabilities.leftrightFan) {
    values.push(capabilityValue('horizontal', 'Horizontal', 'Horizontaal'));
  }
  if (capabilities.updownFan && capabilities.leftrightFan) {
    values.push(capabilityValue('both', 'Both', 'Beide'));
  }

  return values;
}

export function getCapabilityOptions(
  capabilities: DeviceCapabilities,
  _state?: DeviceState,
): { [capabilityId: string]: object } {
  return {
    target_temperature: getTargetTemperatureOptions(capabilities),
    measure_temperature: {
      title: { en: 'Current temperature', nl: 'Huidige temperatuur' },
    },
    'measure_temperature.inside': {
      title: { en: 'Inside temperature', nl: 'Binnentemperatuur' },
    },
    'measure_temperature.outside': {
      title: { en: 'Outside temperature', nl: 'Buitentemperatuur' },
    },
    thermostat_mode: { values: getThermostatModeValues(capabilities) },
    thermostat_swing_mode: { values: getSwingModeValues(capabilities) },
  };
}

function setIfDefined(
  values: { [capabilityId: string]: HomeyCapabilityValue },
  capabilityId: string,
  value: HomeyCapabilityValue | undefined,
) {
  if (value !== undefined) {
    values[capabilityId] = value;
  }
}

function getThermostatModeValue(state: DeviceState): string {
  if (!state.powerOn) {
    return 'off';
  }

  switch (state.operationalMode) {
    case OPERATIONAL_MODE_AUTO: return 'auto';
    case OPERATIONAL_MODE_COOL: return 'cool';
    case OPERATIONAL_MODE_HEAT: return 'heat';
    case OPERATIONAL_MODE_DRY: return 'dry';
    case OPERATIONAL_MODE_FAN: return 'fan';
    default: return 'off';
  }
}

function getFanSpeedValue(state: DeviceState): string | undefined {
  switch (Number(state.fanSpeed)) {
    case FAN_SPEED_AUTO:
    case FAN_SPEED_FIXED: return 'auto';
    case FAN_SPEED_SILENT: return 'silent';
    case FAN_SPEED_LOW: return 'low';
    case FAN_SPEED_MEDIUM: return 'medium';
    case FAN_SPEED_HIGH: return 'high';
    case FAN_SPEED_FULL: return 'full';
    default: return undefined;
  }
}

function getSwingModeValue(state: DeviceState): string | undefined {
  switch (Number(state.swingMode)) {
    case SWING_MODE_OFF: return 'off';
    case SWING_MODE_BOTH: return 'both';
    case SWING_MODE_VERTICAL: return 'vertical';
    case SWING_MODE_HORIZONTAL: return 'horizontal';
    default: return undefined;
  }
}

export function getCapabilityValues(state: DeviceState): { [capabilityId: string]: HomeyCapabilityValue } {
  const values: { [capabilityId: string]: HomeyCapabilityValue } = {};
  setIfDefined(values, 'onoff', typeof state.powerOn === 'boolean' ? state.powerOn : undefined);
  setIfDefined(values, 'thermostat_mode', getThermostatModeValue(state));
  setIfDefined(values, 'target_temperature', Number.isFinite(state.targetTemperature) ? state.targetTemperature : undefined);
  if (state.operationalMode === OPERATIONAL_MODE_FAN && Number.isFinite(state.indoorTemperature)) {
    values.target_temperature = state.indoorTemperature;
  }
  setIfDefined(values, 'measure_temperature', Number.isFinite(state.indoorTemperature) ? state.indoorTemperature : undefined);
  setIfDefined(values, 'measure_temperature.inside', Number.isFinite(state.indoorTemperature) ? state.indoorTemperature : undefined);
  setIfDefined(values, 'measure_temperature.outside', normalizeOutdoorTemperature(state.outdoorTemperature));
  setIfDefined(values, 'thermostat_boost', typeof state.turboMode === 'boolean' ? state.turboMode : undefined);
  setIfDefined(values, 'thermostat_fan_speed', getFanSpeedValue(state));
  setIfDefined(values, 'thermostat_swing_mode', getSwingModeValue(state));
  setIfDefined(values, 'thermostat_eco', typeof state.ecoMode === 'boolean' ? state.ecoMode : undefined);
  setIfDefined(
    values,
    'thermostat_freeze_protection',
    typeof state.freezeProtectionMode === 'boolean' ? state.freezeProtectionMode : undefined,
  );

  return values;
}

export function getInitialCapabilityValues(
  state: DeviceState,
  capabilityIds: string[],
): { [capabilityId: string]: HomeyCapabilityValue } {
  const supportedCapabilityIds = new Set(capabilityIds);

  return Object.entries(getCapabilityValues(state))
    .reduce<{ [capabilityId: string]: HomeyCapabilityValue }>((values, [capabilityId, value]) => {
      if (supportedCapabilityIds.has(capabilityId)) {
        values[capabilityId] = value;
      }

      return values;
    }, {});
}
