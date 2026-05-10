'use strict';

/* eslint-disable import/extensions, import/no-unresolved, node/no-missing-import */
import Homey from 'homey';
import {
  Driver as MDriver,
  Device as MDevice,
  DeviceContext as MDeviceContext,
  DeviceState,
  GetStateCommand,
  LANSecurityContext,
  SetStateCommand,
  _LOGGER,
} from 'midea-msmarthome-ac-euosk105';
import { FAN_SPEED, OPERATIONAL_MODE, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';
import {
  normalizeOutdoorTemperature,
  normalizeTargetTemperature,
  SETTABLE_CAPABILITY_IDS,
  type TargetTemperatureOptions,
} from './capabilities';

const LAN_OPERATION_TIMEOUT_MS = 15000;
const LAN_OPERATION_ATTEMPTS = 2;

type CapabilityValue = boolean | number | string | null;
type RediscoveryResult = {
  host: string;
  port: number;
};

type RediscoveryDriver = {
  rediscoverMideaDevice?: (device: { id: number; host?: string }) => Promise<RediscoveryResult | null>;
};

class MideaDevice extends Homey.Device {

  public _device: MDevice;
  private _pollTimerId: NodeJS.Timeout | null = null;
  private _pollGeneration: number = 0;
  private _maximumFailureCount:number = 5;
  private _failureCount: number = 0;
  private _commandQueue: Promise<void> = Promise.resolve();
  private _lastState: DeviceState | null = null;
  private _registeredCapabilityListeners = new Set<string>();

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log(`Midea AC [${this.getName()}] initializing ...`);
    this._failureCount = 0;
    this._commandQueue = Promise.resolve();
    this._stopPolling();
    if (this._device) {
      this._device.close();
    }
    const settings = this.getSettings();
    this._maximumFailureCount = +settings.max_number_of_errors_before_device_unavailable;

    try {
      const store = this.getStore();
      const deviceContext = this._createDeviceContext();
      this._device = new MDevice(deviceContext);

      let { token } = store;
      let { key } = store;
      if (!token || !key) {
        const lanSecurityContext: LANSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(this._device, null);
        token = lanSecurityContext.token;
        key = lanSecurityContext.key;
      }

      await this.setStoreValue('host', deviceContext.host);
      await this.setStoreValue('port', deviceContext.port);
      await this.setStoreValue('token', token);
      await this.setStoreValue('key', key);

      this._registerCapabilityListeners();

      // INITIALLY UPDATE STATE AND SET DEVICE TO AVAILABLE
      await this._refreshState();
      await this.setAvailable();

      // INITIALIZE POLLING
      this._initializePolling(settings.polling_interval);

      this.log(`Midea AC [${this.getName()}] initialized successfully`);
    } catch (err) {
      this.error(`Cannot initialize device[${this.getName()}]: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
      await this.setUnavailable(`Cannot initialize device[${this.getName()}]: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
      if (this._getStoredLanSecurityContext()) {
        this._initializePolling(settings.polling_interval);
      }
    }
  }

  private _initializePolling(pollingInterval: number) {
    this._stopPolling();
    const generation = this._pollGeneration;
    const pollingIntervalMs = pollingInterval * 1000;

    const poll = async () => {
      this._pollTimerId = null;
      try {
        await this._refreshState();
      } catch (err) {
        this.error(`Error during polling: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
        if (this.getAvailable()) {
          await this.setUnavailable(`Device [${this.getName()}] is unavailable; failure count: ${this._failureCount}`);
        }
      }

      if (generation === this._pollGeneration) {
        this._pollTimerId = this.homey.setTimeout(poll, pollingIntervalMs);
      }
    };

    this._pollTimerId = this.homey.setTimeout(poll, pollingIntervalMs);
  }

  private _stopPolling() {
    this._pollGeneration++;
    if (this._pollTimerId) {
      this.homey.clearTimeout(this._pollTimerId);
      this._pollTimerId = null;
    }
  }

  /**
   * _refreshState is called when the device state has to be updated.
   */
  private async _refreshState() {
    return this._runExclusive(() => this._refreshStateUnsafe());
  }

  private async _refreshStateUnsafe() {
    try {
      await this._fetchAndApplyDeviceStateUnsafe('get state');
    } catch (err) {
      // AN ERROR HAS OCCURED; INCREASE FAILURE COUNT AND CHECK IF THE MAXIMUM NUMBER OF ERRORS HAS BEEN REACHED
      // IF SO, MARK DEVICE UNAVAILABLE WHILE THE POLLER KEEPS TRYING TO RECOVER
      this._failureCount++;
      this.error(`Error during polling of device [${this.getName()}]; failure count = ${this._failureCount} : ${err instanceof Error ? err.message : JSON.stringify(err)}`);
      if (this._failureCount < this._maximumFailureCount) {
        this.log('Retrying');
      } else {
        throw new Error(`Device [${this.getName()}] is failing multiple times; failure count: ${this._failureCount}`);
      }
    }
  }

  public async getCurrentDeviceState(): Promise<DeviceState> {
    return this._runExclusive(() => this._fetchAndApplyDeviceStateUnsafe('get current device state'));
  }

  public async isBoostEnabled(): Promise<boolean> {
    const state = await this.getCurrentDeviceState();
    return state.turboMode;
  }

  public async isEcoEnabled(): Promise<boolean> {
    const state = await this.getCurrentDeviceState();
    return state.ecoMode;
  }

  public async isFreezeProtectionEnabled(): Promise<boolean> {
    const state = await this.getCurrentDeviceState();
    return state.freezeProtectionMode;
  }

  public async getFanSpeedValue(): Promise<string | null> {
    const state = await this.getCurrentDeviceState();
    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO: return 'auto';
      case FAN_SPEED.FIXED: return 'auto';
      case FAN_SPEED.SILENT: return 'silent';
      case FAN_SPEED.LOW: return 'low';
      case FAN_SPEED.MEDIUM: return 'medium';
      case FAN_SPEED.HIGH: return 'high';
      case FAN_SPEED.FULL: return 'full';
      default: return null;
    }
  }

  public async getSwingModeValue(): Promise<string | null> {
    const state = await this.getCurrentDeviceState();
    switch (state.swingMode) {
      case SWING_MODE.OFF: return 'off';
      case SWING_MODE.BOTH: return 'both';
      case SWING_MODE.VERTICAL: return 'vertical';
      case SWING_MODE.HORIZONTAL: return 'horizontal';
      default: return null;
    }
  }

  public async getThermostatModeValue(): Promise<string | null> {
    const state = await this.getCurrentDeviceState();
    if (!state.powerOn) {
      return 'off';
    }

    switch (state.operationalMode) {
      case OPERATIONAL_MODE.AUTO: return 'auto';
      case OPERATIONAL_MODE.COOL: return 'cool';
      case OPERATIONAL_MODE.HEAT: return 'heat';
      case OPERATIONAL_MODE.DRY: return 'dry';
      case OPERATIONAL_MODE.FAN: return 'fan';
      default: return null;
    }
  }

  private async _fetchAndApplyDeviceStateUnsafe(label: string): Promise<DeviceState> {
    const state = await this._getFreshDeviceStateUnsafe(label);
    await this._updateState(state);
    await this._setLastSeenAtIfAvailable();

    this._failureCount = 0;
    if (!this.getAvailable()) {
      await this.setAvailable();
    }

    return this._cloneDeviceState(state);
  }

  /**
   * _updateState is called when the device state has been retreived ia the local API and the Homey's device state needs to be updated.
   * @param {DeviceState} state The new state
   */
  private async _updateState(state: DeviceState) {
    this._lastState = this._cloneDeviceState(state);
    this.log(`state = ${JSON.stringify(state)})`);
    await this._setCapabilityValueIfAvailable('onoff', state.powerOn);
    if (state.powerOn) {
      switch (state.operationalMode) {
        case OPERATIONAL_MODE.AUTO: await this._setCapabilityValueIfAvailable('thermostat_mode', 'auto'); break;
        case OPERATIONAL_MODE.COOL: await this._setCapabilityValueIfAvailable('thermostat_mode', 'cool'); break;
        case OPERATIONAL_MODE.HEAT: await this._setCapabilityValueIfAvailable('thermostat_mode', 'heat'); break;
        case OPERATIONAL_MODE.DRY: await this._setCapabilityValueIfAvailable('thermostat_mode', 'dry'); break;
        case OPERATIONAL_MODE.FAN: await this._setCapabilityValueIfAvailable('thermostat_mode', 'fan'); break;
        default: break;
      }
    } else {
      await this._setCapabilityValueIfAvailable('thermostat_mode', 'off');
    }
    await this._setCapabilityValueIfAvailable('thermostat_boost', state.turboMode);

    await this._setCapabilityValueIfAvailable('target_temperature', state.targetTemperature);
    if (state.operationalMode === OPERATIONAL_MODE.FAN) {
      await this._setCapabilityValueIfAvailable('target_temperature', state.indoorTemperature);
    }
    await this._setCapabilityValueIfAvailable('measure_temperature', state.indoorTemperature);
    await this._setCapabilityValueIfAvailable('measure_temperature.inside', state.indoorTemperature);

    const outdoorTemperature = normalizeOutdoorTemperature(state.outdoorTemperature);
    await this._setCapabilityValueIfAvailable('measure_temperature.outside', outdoorTemperature);
    if (outdoorTemperature == null) {
      this.log('Ignoring invalid outdoor temperature:', state.outdoorTemperature);
    }

    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'auto'); break;
      case FAN_SPEED.FIXED: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'auto'); break;
      case FAN_SPEED.SILENT: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'silent'); break;
      case FAN_SPEED.LOW: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'low'); break;
      case FAN_SPEED.MEDIUM: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'medium'); break;
      case FAN_SPEED.HIGH: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'high'); break;
      case FAN_SPEED.FULL: await this._setCapabilityValueIfAvailable('thermostat_fan_speed', 'full'); break;
      default: break;
    }
    switch (state.swingMode) {
      case SWING_MODE.OFF: await this._setCapabilityValueIfAvailable('thermostat_swing_mode', 'off'); break;
      case SWING_MODE.BOTH: await this._setCapabilityValueIfAvailable('thermostat_swing_mode', 'both'); break;
      case SWING_MODE.VERTICAL: await this._setCapabilityValueIfAvailable('thermostat_swing_mode', 'vertical'); break;
      case SWING_MODE.HORIZONTAL: await this._setCapabilityValueIfAvailable('thermostat_swing_mode', 'horizontal'); break;
      default: break;
    }
    await this._setCapabilityValueIfAvailable('thermostat_eco', state.ecoMode);
    await this._setCapabilityValueIfAvailable('thermostat_freeze_protection', state.freezeProtectionMode);
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log(`Midea AC [${this.getName()}] has been added`);
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.includes('polling_interval')) {
      this._initializePolling(+newSettings.polling_interval);
    }
    if (changedKeys.includes('debug_level')) {
      _LOGGER.level = newSettings.debug_level.toString();
    }
    if (changedKeys.includes('max_number_of_errors_before_device_unavailable')) {
      this._maximumFailureCount = +newSettings.max_number_of_errors_before_device_unavailable;
      await this.onInit();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log(`Midea AC [${this.getName()}] was renamed to "${name}"`);
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this._stopPolling();
    if (this._device) {
      this._device.close();
    }
    this.log(`Midea AC [${this.getName()}] has been deleted`);
  }

  async onCapability(capability: string, value: unknown, opts: unknown) {
    return this._runExclusive(async () => {
      this.log(`Device::onCapability(capability='${capability}', value='`, value, '\')');
      if (!this.hasCapability(capability)) {
        throw new Error(`Capability '${capability}' is not supported by device [${this.getName()}]`);
      }

      try {
        let state = await this._getStateForCapabilityUpdate();

        switch (capability) {
          case 'onoff': state.powerOn = Boolean(value); break;
          case 'target_temperature': state.targetTemperature = normalizeTargetTemperature(Number(value), this._getTargetTemperatureOptions()); break;
          case 'thermostat_mode': {
            switch (value) {
              case 'auto': state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.AUTO; break;
              case 'cool': state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.COOL; break;
              case 'heat': state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.HEAT; break;
              case 'dry': state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.DRY; break;
              case 'fan': state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.FAN; break;
              case 'off': state.powerOn = false; break; /* this behaves exactly the same as the onoff button */
              default:
                this.log(`Value '${value}' for capability 'thermostat_mode' does not exist`);
                break;
            }
            break;
          }
          case 'thermostat_boost': {
            if (value) {
              state.ecoMode = false;
              state.freezeProtectionMode = false;
            }
            state.turboMode = Boolean(value); break; /* only available in thermostat_mode 'heat' or 'cool' */
          }
          case 'thermostat_eco': {
            /* only available in thermostat_mode 'cool' */
            if (value) {
              state.operationalMode = OPERATIONAL_MODE.COOL;
              state.turboMode = false;
              state.freezeProtectionMode = false;
            }
            state.ecoMode = Boolean(value);
            break;
          }
          case 'thermostat_freeze_protection': {
            /* only available in thermostat_mode 'heat' */
            if (value) {
              state.operationalMode = OPERATIONAL_MODE.HEAT;
              state.ecoMode = false;
              state.turboMode = false;
            }
            state.freezeProtectionMode = Boolean(value);
            break;
          }
          case 'thermostat_fan_speed': {
            switch (value) {
              case 'auto': {
                if (state.operationalMode === OPERATIONAL_MODE.AUTO) {
                  state.fanSpeed = FAN_SPEED.FIXED; /* this is the default setting when thermostat_mode in 'auto' */
                } else {
                  state.fanSpeed = FAN_SPEED.AUTO; /* only available in thermostat_mode 'heat' or 'cool' */
                }
                break;
              }
              case 'silent': state.fanSpeed = FAN_SPEED.SILENT; break;
              case 'low': state.fanSpeed = FAN_SPEED.LOW; break;
              case 'medium': state.fanSpeed = FAN_SPEED.MEDIUM; break;
              case 'high': state.fanSpeed = FAN_SPEED.HIGH; break;
              case 'full': state.fanSpeed = FAN_SPEED.FULL; break;
              default:
                this.log(`Value '${value}' for capability 'thermostat_fan_speed' does not exist`);
                break;
            }
            break;
          }
          case 'thermostat_swing_mode': {
            switch (value) {
              case 'off': state.swingMode = SWING_MODE.OFF; break;
              case 'both': state.swingMode = SWING_MODE.BOTH; break;
              case 'vertical': state.swingMode = SWING_MODE.VERTICAL; break;
              case 'horizontal': state.swingMode = SWING_MODE.HORIZONTAL; break;
              default:
                this.log(`Value '${value}' for capability 'thermostat_swing_mode' does not exist`);
                break;
            }
            break;
          }
          default:
            this.log(`Capability '${capability}' does not exist`);
            break;
        }

        state = await this._withLanTimeout('set state', (device) => new SetStateCommand(device, state).execute());
        await this._updateState(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error(`Error applying capability '${capability}' for device [${this.getName()}]: ${message}`);
        try {
          await this._refreshStateUnsafe(); // Revert UI to correct state
        } catch (refreshError) {
          this.error(`Failed to refresh device [${this.getName()}] after capability error: ${
            refreshError instanceof Error ? refreshError.message : String(refreshError)
          }`);
        }
        throw new Error(`Error applying capability '${capability}' for device [${this.getName()}]: ${message}`);
      }
    });
  }

  private _createDeviceContext(): MDeviceContext {
    const data = this.getData();
    const store = this.getStore();
    const deviceContext: MDeviceContext = new MDeviceContext();
    deviceContext.id = data.id;
    deviceContext.macAddress = data.macAddress;
    deviceContext.udpId = data.udpId;
    deviceContext.host = store.host || data.host;
    deviceContext.port = store.port || data.port;

    if (!deviceContext.host || !deviceContext.port) {
      throw new Error('Missing LAN host or port; repair or re-add the device');
    }

    return deviceContext;
  }

  private _resetLanDevice() {
    this._closeLanConnection();
    this._lastState = null;

    this._device = new MDevice(this._createDeviceContext());
    const lanSecurityContext = this._getStoredLanSecurityContext();
    if (lanSecurityContext) {
      this._device.lanSecurityContext = lanSecurityContext;
    }
  }

  private _closeLanConnection(device = this._device) {
    if (device) {
      const socket = (device as unknown as {
        lanConnection?: { _socket?: { destroy?: () => void } };
      }).lanConnection?._socket;
      socket?.destroy?.();
      device.close();
    }
  }

  private _getStoredLanSecurityContext(): LANSecurityContext | null {
    const store = this.getStore();
    const token = typeof store.token === 'string' ? store.token : null;
    const key = typeof store.key === 'string' ? store.key : null;

    if (!token || !key) {
      return null;
    }

    return new LANSecurityContext(token, key);
  }

  private async _getStateForCapabilityUpdate(): Promise<DeviceState> {
    const state = await this._getFreshDeviceStateUnsafe('get state before capability update');
    this._lastState = this._cloneDeviceState(state);
    return this._cloneDeviceState(state);
  }

  private async _getFreshDeviceStateUnsafe(label: string): Promise<DeviceState> {
    return this._withLanTimeout(label, (device) => new GetStateCommand(device).execute());
  }

  private _getTargetTemperatureOptions(): TargetTemperatureOptions | null {
    const options = this.getCapabilityOptions('target_temperature') as Partial<TargetTemperatureOptions> | null;
    if (
      options
      && typeof options.min === 'number'
      && typeof options.max === 'number'
      && typeof options.step === 'number'
    ) {
      return {
        min: options.min,
        max: options.max,
        step: options.step,
      };
    }

    return null;
  }

  private _cloneDeviceState(state: DeviceState): DeviceState {
    const clone = new DeviceState();
    clone.powerOn = state.powerOn;
    clone.operationalMode = state.operationalMode;
    clone.fanSpeed = state.fanSpeed;
    clone.swingMode = state.swingMode;
    clone.horizontalSwingAngle = state.horizontalSwingAngle;
    clone.verticalSwingAngle = state.verticalSwingAngle;
    clone.turboMode = state.turboMode;
    clone.ecoMode = state.ecoMode;
    clone.sleepMode = state.sleepMode;
    clone.freezeProtectionMode = state.freezeProtectionMode;
    clone.fahrenheit = state.fahrenheit;
    clone.targetTemperature = state.targetTemperature;
    clone.indoorTemperature = state.indoorTemperature;
    clone.outdoorTemperature = state.outdoorTemperature;
    clone.statusCode = state.statusCode;
    return clone;
  }

  private _registerCapabilityListeners() {
    SETTABLE_CAPABILITY_IDS.forEach((capability) => {
      if (!this.hasCapability(capability) || this._registeredCapabilityListeners.has(capability)) {
        return;
      }

      this.registerCapabilityListener(capability, async (value, opts) => this.onCapability(capability, value, opts));
      this._registeredCapabilityListeners.add(capability);
    });
  }

  private async _setCapabilityValueIfAvailable(capabilityId: string, value: CapabilityValue) {
    if (this.hasCapability(capabilityId)) {
      try {
        await this.setCapabilityValue(capabilityId, value);
      } catch (error) {
        this.error(`Failed to update capability '${capabilityId}' for device [${this.getName()}] with value ${JSON.stringify(value)}: ${
          error instanceof Error ? error.message : String(error)
        }`);
        throw error;
      }
    }
  }

  private async _runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this._commandQueue.catch((): undefined => undefined).then(operation);
    this._commandQueue = run.then((): undefined => undefined, (): undefined => undefined);
    return run;
  }

  private async _withLanTimeout<T>(label: string, operation: (device: MDevice) => Promise<T>): Promise<T> {
    return this._withLanTimeoutAndOptionalRediscovery(label, operation, true);
  }

  private async _withLanTimeoutAndOptionalRediscovery<T>(
    label: string,
    operation: (device: MDevice) => Promise<T>,
    allowRediscovery: boolean,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= LAN_OPERATION_ATTEMPTS; attempt++) {
      try {
        const result = await this._runLanOperationAttempt(label, operation);
        if (label !== 'authenticate') {
          this._resetLanDevice();
        }
        return result;
      } catch (error) {
        lastError = error;
        this._resetLanDevice();
        const deviceContext = this._createDeviceContext();
        this.error(`LAN ${label} failed for device [${this.getName()}] at ${deviceContext.host}:${deviceContext.port} on attempt ${attempt}/${LAN_OPERATION_ATTEMPTS}: ${
          error instanceof Error ? error.message : String(error)
        }`);
        if (attempt < LAN_OPERATION_ATTEMPTS) {
          this.log(`${label} failed on attempt ${attempt}; retrying: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }
    }

    if (allowRediscovery && await this._rediscoverLanAddress(label)) {
      return this._withLanTimeoutAndOptionalRediscovery(label, operation, false);
    }

    throw lastError;
  }

  private async _runLanOperationAttempt<T>(label: string, operation: (device: MDevice) => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const attemptDevice = this._device;

    try {
      return await Promise.race([
        (async () => {
          if (label !== 'authenticate') {
            const lanSecurityContext = this._getStoredLanSecurityContext();
            if (lanSecurityContext) {
              await attemptDevice.authenticate(lanSecurityContext);
            }
          }

          return operation(attemptDevice);
        })(),
        new Promise<T>((_resolve, reject) => {
          timer = this.homey.setTimeout(
            () => {
              this._lastState = null;
              this._closeLanConnection(attemptDevice);
              reject(new Error(`${label} timed out after ${LAN_OPERATION_TIMEOUT_MS}ms`));
            },
            LAN_OPERATION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        this.homey.clearTimeout(timer);
      }
    }
  }

  private async _rediscoverLanAddress(label: string): Promise<boolean> {
    const { rediscoverMideaDevice } = this.driver as unknown as RediscoveryDriver;
    if (!rediscoverMideaDevice) {
      return false;
    }

    const deviceContext = this._createDeviceContext();
    try {
      const result = await rediscoverMideaDevice.call(this.driver, {
        id: deviceContext.id,
        host: deviceContext.host,
      });

      if (!result || (result.host === deviceContext.host && result.port === deviceContext.port)) {
        return false;
      }

      this.log(`Rediscovered Midea AC [${this.getName()}] during ${label}: ${deviceContext.host}:${deviceContext.port} -> ${result.host}:${result.port}`);
      await this.setStoreValue('host', result.host);
      await this.setStoreValue('port', result.port);
      this._resetLanDevice();
      return true;
    } catch (error) {
      this.error(`Rediscovery failed for Midea AC [${this.getName()}] during ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return false;
    }
  }

  private async _setLastSeenAtIfAvailable() {
    const { setLastSeenAt } = this as unknown as { setLastSeenAt?: () => Promise<void> };
    if (setLastSeenAt) {
      await setLastSeenAt.call(this);
    }
  }

}

module.exports = MideaDevice;
