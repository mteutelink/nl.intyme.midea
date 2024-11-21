import Homey from 'homey';
import { Device as MDevice, DeviceContext as MDeviceContext, GetStateCommand, DeviceState, SecurityContext as MSecurityContext, SecurityContext, SetStateCommand } from 'midea-msmarthome-ac-euosk105';
import { FAN_SPEED, OPERATIONAL_MODE, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';

class MyDevice extends Homey.Device {
  private _device: MDevice;
  private _securityContext: MSecurityContext = null;
  private _intervalId: any;

  private _updatingState: boolean = false;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Midea AC [' + this.getName() + '] initialized');

    const deviceContext: MDeviceContext = new MDeviceContext();
    deviceContext.id = this.getData().id;
    deviceContext.macAddress = this.getData().macAddress;
    deviceContext.udpId = this.getData().udpId;
    deviceContext.host = this.getStore().host;
    deviceContext.port = this.getStore().port;
    this._device = new MDevice(deviceContext);

    this._securityContext = await this._device.authenticate(new MSecurityContext(this.getStore().username, this.getStore().password));

    this.registerCapabilityListener("onoff", async (value, opts) => { return this.onCapability("onoff", value, opts); });
    this.registerCapabilityListener("target_temperature", async (value, opts) => { return this.onCapability("target_temperature", value, opts); });
    this.registerCapabilityListener("airco_mode_capability", async (value, opts) => { return this.onCapability("airco_mode_capability", value, opts); });
    this.registerCapabilityListener("airco_boost_capability", async (value, opts) => { return this.onCapability("airco_boost_capability", value, opts); });
    this.registerCapabilityListener("airco_fan_mode_capability", async (value, opts) => { return this.onCapability("airco_fan_mode_capability", value, opts); });
    this.registerCapabilityListener("airco_swing_mode_capability", async (value, opts) => { return this.onCapability("airco_swing_mode_capability", value, opts); });
    
    const settings = this.getSettings();
    this._initializePolling(settings.polling_interval);
  }

  private _initializePolling(pollingInterval: number) {
    if (this._intervalId) this.homey.clearInterval(this._intervalId);
    this._intervalId = this.homey.setInterval(async () => {
      if (!this._updatingState) {
        try {
          const state: DeviceState = await new GetStateCommand(this._device).execute();
          this._updateState(state);
        } catch (err) {
          this.log("error = " + err);
        }
      }
    }, pollingInterval * 1000);
  }

  private _updateState(state: DeviceState) {
    this.log("state = " + JSON.stringify(state));
    this.setCapabilityValue("onoff", state.powerOn);
    this.setCapabilityValue("airco_boost_capability", state.turboMode);
    this.setCapabilityValue("target_temperature", state.targetTemperature);
    this.setCapabilityValue("measure_temperature", state.indoorTemperature);
    this.setCapabilityValue("measure_temperature.outside", state.outdoorTemperature);
    switch (state.operationalMode) {
      case OPERATIONAL_MODE.AUTO: this.setCapabilityValue("airco_mode_capability", "auto"); break;
      case OPERATIONAL_MODE.COOL: this.setCapabilityValue("airco_mode_capability", "cool"); break;
      case OPERATIONAL_MODE.DRY: this.setCapabilityValue("airco_mode_capability", "dry"); break;
      case OPERATIONAL_MODE.HEAT: this.setCapabilityValue("airco_mode_capability", "heat"); break;
      case OPERATIONAL_MODE.FAN: this.setCapabilityValue("airco_mode_capability", "fan"); break;
    }
    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO: this.setCapabilityValue("airco_fan_mode_capability", "auto"); break;
      case FAN_SPEED.FIXED: this.setCapabilityValue("airco_fan_mode_capability", "fixed"); break;
      case FAN_SPEED.SILENT: this.setCapabilityValue("airco_fan_mode_capability", "silent"); break;
      case FAN_SPEED.LOW: this.setCapabilityValue("airco_fan_mode_capability", "low"); break;
      case FAN_SPEED.MEDIUM: this.setCapabilityValue("airco_fan_mode_capability", "medium"); break;
      case FAN_SPEED.HIGH: this.setCapabilityValue("airco_fan_mode_capability", "high"); break;
    }
    switch (state.swingMode) {
      case SWING_MODE.OFF: this.setCapabilityValue("airco_swing_mode_capability", "off"); break;
      case SWING_MODE.BOTH: this.setCapabilityValue("airco_swing_mode_capability", "both"); break;
      case SWING_MODE.VERTICAL: this.setCapabilityValue("airco_swing_mode_capability", "vertical"); break;
      case SWING_MODE.HORIZONTAL: this.setCapabilityValue("airco_swing_mode_capability", "horizontal"); break;
    }
  } 

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('Midea AC [' + this.getName() + '] has been added');
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

    if (changedKeys.includes("polling_interval")) {
      this._initializePolling(+newSettings.polling_interval);
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('Midea AC [' + this.getName() + '] was renamed to "' + name + '"');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.homey.clearInterval(this._intervalId);
    this.log('Midea AC [' + this.getName() + '] has been deleted');
  }

  async onCapability(capability: string, value: any, opts: any) {
    try {
      this._updatingState = true; 
      let state: DeviceState = await new GetStateCommand(this._device).execute();

      switch (capability) {
        case "onoff": state.powerOn = value; break;
        case "target_temperature": state.targetTemperature = value; break;
        case "airco_mode_capability": {
          switch (value) {
            case "auto": state.operationalMode = OPERATIONAL_MODE.AUTO; break;
            case "cool": state.operationalMode = OPERATIONAL_MODE.COOL; break;
            case "dry": state.operationalMode = OPERATIONAL_MODE.DRY; break;
            case "heat": state.operationalMode = OPERATIONAL_MODE.HEAT; break;
            case "fan": state.operationalMode = OPERATIONAL_MODE.FAN; break;
          }
          break;
        }
        case "airco_boost_capability": state.turboMode = value; break;
        case "airco_fan_mode_capability": {
          switch (value) {
            case "auto": state.fanSpeed= FAN_SPEED.AUTO; break;
            case "fixed": state.fanSpeed = FAN_SPEED.FIXED; break;
            case "silent": state.fanSpeed = FAN_SPEED.SILENT; break;
            case "low": state.fanSpeed = FAN_SPEED.LOW; break;
            case "medium": state.fanSpeed = FAN_SPEED.MEDIUM; break;
            case "high": state.fanSpeed = FAN_SPEED.HIGH; break;
            //case "full": state.fanSpeed = FAN_SPEED.FULL; break;
          }
          break;
        }
        case "airco_swing_mode_capability": {
          switch (value) {
            case "off": state.swingMode = SWING_MODE.OFF; break;
            case "both": state.swingMode = SWING_MODE.BOTH; break;
            case "vertical": state.swingMode = SWING_MODE.VERTICAL; break;
            case "horizontal": state.swingMode = SWING_MODE.HORIZONTAL; break;
          }
        } 
      }

      state = await new SetStateCommand(this._device, state).execute();
      this._updateState(state);
    } finally {
      this._updatingState = false; 
    }
  }
}

module.exports = MyDevice;
