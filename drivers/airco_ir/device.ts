import Homey from 'homey';

// Must match the command matrix generated into
// .homeycompose/signals/ir/midea_ir.json
const MIN_TEMP = 17;
const MAX_TEMP = 30;

type ThermostatMode = 'off' | 'auto' | 'cool' | 'heat' | 'dry' | 'fan';
type FanSpeed = 'silent' | 'low' | 'medium' | 'high' | 'full' | 'auto';

// The IR protocol only distinguishes 4 fan speeds. The app-wide
// `thermostat_fan_speed` capability (shared with the WiFi `airco` driver)
// offers 6, so the extremes are folded into the nearest supported speed.
const FAN_SPEED_TO_IR: Record<FanSpeed, string> = {
  silent: 'LOW',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  full: 'HIGH',
  auto: 'AUTO',
};

const MODE_TO_IR: Record<Exclude<ThermostatMode, 'off'>, string> = {
  auto: 'AUTO',
  cool: 'COOL',
  heat: 'HEAT',
  dry: 'DRY',
  fan: 'FAN',
};

class MideaInfraredDevice extends Homey.Device {

  private signal: any;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MideaInfraredDevice [' + this.getName() + '] has been initialized');

    this.signal = this.homey.rf.getSignalInfrared('midea_ir');

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
    this.registerCapabilityListener('thermostat_mode', this.onCapabilityThermostatMode.bind(this));
    this.registerCapabilityListener('thermostat_fan_speed', this.onCapabilityFanSpeed.bind(this));
  }

  /** Builds the exact command name used as a key in signals/ir/midea_ir.json */
  private buildCommandName(power: boolean, mode: Exclude<ThermostatMode, 'off'>, temp: number, fanSpeed: FanSpeed): string {
    if (!power) return 'OFF';
    const clampedTemp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.round(temp)));
    return `M_${MODE_TO_IR[mode]}_T${clampedTemp}_F${FAN_SPEED_TO_IR[fanSpeed]}`;
  }

  /**
   * Re-reads the device's current (about-to-be or already) stored
   * capability values and sends the one IR command that represents that
   * full state. The Midea IR protocol encodes power + mode + temperature
   * + fan speed in a single signal, so every change needs a full,
   * freshly built command — there is no way to toggle just one field.
   */
  private async sendCurrentState(overrides: Partial<{
    onoff: boolean;
    thermostat_mode: ThermostatMode;
    target_temperature: number;
    thermostat_fan_speed: FanSpeed;
  }> = {}) {
    const power = overrides.onoff ?? this.getCapabilityValue('onoff') ?? false;
    const rawMode: ThermostatMode = overrides.thermostat_mode ?? this.getCapabilityValue('thermostat_mode') ?? 'auto';
    const temp = overrides.target_temperature ?? this.getCapabilityValue('target_temperature') ?? 22;
    const fanSpeed: FanSpeed = overrides.thermostat_fan_speed ?? this.getCapabilityValue('thermostat_fan_speed') ?? 'auto';

    const isOff = !power || rawMode === 'off';
    const mode: Exclude<ThermostatMode, 'off'> = rawMode === 'off' ? 'auto' : rawMode;

    const cmd = this.buildCommandName(!isOff, mode, temp, fanSpeed);
    this.log('Sending Midea IR command:', cmd);

    try {
      await this.signal.cmd(cmd);
    } catch (err) {
      this.error('Failed to send IR command', cmd, err);
      throw err;
    }
  }

  /** Keeps `onoff` and `thermostat_mode` in sync, since IR has no state readback. */
  private async syncPowerCapabilities(power: boolean) {
    if (this.getCapabilityValue('onoff') !== power) {
      await this.setCapabilityValue('onoff', power).catch(this.error);
    }
    const currentMode = this.getCapabilityValue('thermostat_mode');
    if (!power && currentMode !== 'off') {
      await this.setCapabilityValue('thermostat_mode', 'off').catch(this.error);
    } else if (power && currentMode === 'off') {
      await this.setCapabilityValue('thermostat_mode', 'auto').catch(this.error);
    }
  }

  async onCapabilityOnoff(value: boolean) {
    await this.syncPowerCapabilities(value);
    await this.sendCurrentState({ onoff: value });
  }

  async onCapabilityTargetTemperature(value: number) {
    await this.sendCurrentState({ target_temperature: value });
  }

  async onCapabilityThermostatMode(value: ThermostatMode) {
    await this.syncPowerCapabilities(value !== 'off');
    await this.sendCurrentState({ thermostat_mode: value });
  }

  async onCapabilityFanSpeed(value: FanSpeed) {
    await this.sendCurrentState({ thermostat_fan_speed: value });
  }

}

module.exports = MideaInfraredDevice;
