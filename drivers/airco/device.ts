import Homey from 'homey';
import { Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, GetStateCommand, DeviceState, LANSecurityContext, CloudSecurityContext,  SetStateCommand, _LOGGER } from 'midea-msmarthome-ac-euosk105';
import { FAN_SPEED, OPERATIONAL_MODE, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';

export class MideaDevice extends Homey.Device {
  public _device: MDevice;
  private _intervalId: any;
  private _updatingState: boolean = false;
  private _maximumFailureCount:number = 5;
  private _failureCount: number = 0;
  
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Midea AC [' + this.getName() + '] initializing ...');
    this._failureCount = 0;

    try {
      const deviceContext: MDeviceContext = new MDeviceContext();
      deviceContext.id = this.getData().id;
      deviceContext.macAddress = this.getData().macAddress;
      deviceContext.udpId = this.getData().udpId;
      deviceContext.host = this.getStore().host;
      deviceContext.port = this.getStore().port;
      this._device = new MDevice(deviceContext);

      // RETRIEVE TOKEN AND KEY FROM USERNAME PASSWORD IF NOT ADDED DURING PAIRING
      if (!this.getStore().token || !this.getStore().key) {
        let cloudSecurityContext: CloudSecurityContext =  new CloudSecurityContext(this.getStore().username, this.getStore().password);
        let lanSecurityContext: LANSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(this._device, cloudSecurityContext);
        this.setStoreValue("token",  lanSecurityContext.token);
        this.setStoreValue("key",  lanSecurityContext.key);
      }
      await this._device.authenticate(new LANSecurityContext(this.getStore().token, this.getStore().key));

      // REGISTER CAPABILITY LISTENERS
      this.registerCapabilityListener("onoff", async (value, opts) => { return this.onCapability("onoff", value, opts); });
      this.registerCapabilityListener("target_temperature", async (value, opts) => { return this.onCapability("target_temperature", value, opts); });
      this.registerCapabilityListener("thermostat_mode", async (value, opts) => { return this.onCapability("thermostat_mode", value, opts); });
      this.registerCapabilityListener("thermostat_boost", async (value, opts) => { return this.onCapability("thermostat_boost", value, opts); });
      this.registerCapabilityListener("thermostat_fan_speed", async (value, opts) => { return this.onCapability("thermostat_fan_speed", value, opts); });
      this.registerCapabilityListener("thermostat_swing_mode", async (value, opts) => { return this.onCapability("thermostat_swing_mode", value, opts); });
      this.registerCapabilityListener("thermostat_eco", async (value, opts) => { return this.onCapability("thermostat_eco", value, opts); });
      this.registerCapabilityListener("thermostat_freeze_protection", async (value, opts) => { return this.onCapability("thermostat_freeze_protection", value, opts); });

      // INITIALLY UPDATE STATE AND SET DEVICE TO AVAILABLE
      await this._refreshState();
      this.setAvailable();       

      // INITIALIZE POLLING
      const settings = this.getSettings();
      this._maximumFailureCount = +settings.max_number_of_errors_before_device_unavailable;
      this._initializePolling(settings.polling_interval);

      this.log('Midea AC [' + this.getName() + '] initialized successfully'); 
    } catch (err) {
      this.error("Cannot initialize device[" + this.getName() + "]: " + (err instanceof Error ? err.message : JSON.stringify(err)));
      this.setUnavailable("Cannot initialize device[" + this.getName() + "]: " + (err instanceof Error ? err.message : JSON.stringify(err)));
    }
  }

  private _initializePolling(pollingInterval: number) {
    // CLEAR POLLING
    if (this._intervalId) this.homey.clearInterval(this._intervalId);

    // SET POLLER
    this._intervalId = this.homey.setInterval(async () => {
      try {
        await this._refreshState();
      } catch (err) {
        this.homey.clearInterval(this._intervalId);
        this.error("Error during polling: " + (err instanceof Error ? err.message : JSON.stringify(err)));
        this.setUnavailable("Device [" + this.getName() + "] is unavailable; failure count: " + this._failureCount);
      }
    }, pollingInterval * 1000);
  }

  /**
   * _refreshState is called when the device state has to be updated.
   */
  private async _refreshState() {
    if (this._updatingState) {
      this.log("Skipping state refresh because another update is in progress");
      return;
    }

    try {
      // EXECUTE THE GETSTATECOMMAND TO RETREIVE THE STATE AND REFRESH HOMEY'S DEVICE STATE
      const state: DeviceState = await new GetStateCommand(this._device).execute();
      this._updateState(state);

      // AT THS STAGE REFRESHING HAS BEEN SUCCESFUL, WHICH RESETS THE FAILURE COUNT
      this._failureCount = 0;
    } catch (err) {
      // AN ERROR HAS OCCURED; INCREASE FAILURE COUNT AND CHECK IF THE MAXIMUM NUMBER OF ERRORS HAS BEEN REACHED
      // IF SO, STOP POLLING AND SET DEVICE UNAVAILABLE ELSE, LOG THE ERROR AND RETRY
      this._failureCount++;   
      this.error("Error during polling of device [" + this.getName() + "]; failure count = " + this._failureCount + " : " + (err instanceof Error ? err.message : JSON.stringify(err)));
      if (this._failureCount < this._maximumFailureCount) {
        this.log("Retrying");
      } else { 
        throw new Error("Device [" + this.getName() + "] is failing multiple times; failure count: " + this._failureCount);
      }
    }
  }

  /**
   * _updateState is called when the device state has been retreived ia the local API and the Homey's device state needs to be updated.
   * @param {DeviceState} state The new state
   */
  private _updateState(state: DeviceState) {
    this.log("state = " + JSON.stringify(state) + ")");
    this.setCapabilityValue("onoff", state.powerOn);
    if (state.powerOn) {
      switch (state.operationalMode) {
        case OPERATIONAL_MODE.AUTO: this.setCapabilityValue("thermostat_mode", "auto"); break;
        case OPERATIONAL_MODE.COOL: this.setCapabilityValue("thermostat_mode", "cool"); break;
        case OPERATIONAL_MODE.HEAT: this.setCapabilityValue("thermostat_mode", "heat"); break;
        case OPERATIONAL_MODE.DRY: this.setCapabilityValue("thermostat_mode", "dry"); break;
        case OPERATIONAL_MODE.FAN: this.setCapabilityValue("thermostat_mode", "fan"); break;
      }
    } else {
      this.setCapabilityValue("thermostat_mode", "off");
    }
    this.setCapabilityValue("thermostat_boost", state.turboMode);

    this.setCapabilityValue("target_temperature", state.targetTemperature);
    if (state.operationalMode == OPERATIONAL_MODE.FAN) {
      this.setCapabilityValue("target_temperature", state.indoorTemperature);
    }
    this.setCapabilityValue("measure_temperature", state.indoorTemperature);

    if (state.outdoorTemperature != null && state.outdoorTemperature < 60) {
      this.setCapabilityValue("measure_temperature.outside", state.outdoorTemperature);
    } else {
      this.log("Ignoring invalid outdoor temperature:", state.outdoorTemperature);
    }

    switch (state.fanSpeed) {
      case FAN_SPEED.AUTO: this.setCapabilityValue("thermostat_fan_speed", "auto"); break;
      case FAN_SPEED.FIXED: this.setCapabilityValue("thermostat_fan_speed", "auto"); break;
      case FAN_SPEED.SILENT: this.setCapabilityValue("thermostat_fan_speed", "silent"); break;
      case FAN_SPEED.LOW: this.setCapabilityValue("thermostat_fan_speed", "low"); break;
      case FAN_SPEED.MEDIUM: this.setCapabilityValue("thermostat_fan_speed", "medium"); break;
      case FAN_SPEED.HIGH: this.setCapabilityValue("thermostat_fan_speed", "high"); break;
      case FAN_SPEED.FULL: this.setCapabilityValue("thermostat_fan_speed", "full"); break;
    }
    switch (state.swingMode) {
      case SWING_MODE.OFF: this.setCapabilityValue("thermostat_swing_mode", "off"); break;
      case SWING_MODE.BOTH: this.setCapabilityValue("thermostat_swing_mode", "both"); break;
      case SWING_MODE.VERTICAL: this.setCapabilityValue("thermostat_swing_mode", "vertical"); break;
      case SWING_MODE.HORIZONTAL: this.setCapabilityValue("thermostat_swing_mode", "horizontal"); break;
    }
    this.setCapabilityValue("thermostat_eco", state.ecoMode);
    this.setCapabilityValue("thermostat_freeze_protection", state.freezeProtectionMode);
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
    if (changedKeys.includes("debug_level")) {
      _LOGGER.level = newSettings.debug_level.toString();
    }
    if (changedKeys.includes("max_number_of_errors_before_device_unavailable")) {
      this._maximumFailureCount = +newSettings.max_number_of_errors_before_device_unavailable;
      this.onInit();
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
    this.log("Device::onCapability(capability='" + capability + "', value='", value, "')");
    try {
      this._updatingState = true;
      let state: DeviceState = await new GetStateCommand(this._device).execute();

      switch (capability) {
        case "onoff": state.powerOn = value; break;
        case "target_temperature": state.targetTemperature = value; break;
        case "thermostat_mode": {
          switch (value) {
            case "auto": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.AUTO; break;
            case "cool": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.COOL; break;
            case "heat": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.HEAT; break;
            case "dry": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.DRY; break;
            case "fan": state.powerOn = true; state.operationalMode = OPERATIONAL_MODE.FAN; break;
            case "off": state.powerOn = false; break; /* this behaves exactly the same as the onoff button */
            default:
              this.log("Value '" + value + "' for capability 'thermostat_mode' does not exist");
              break;
          }
          break;
        }
        case "thermostat_boost":  {
          if (value) {
            /* boost mode disables ECO and freeze protection */
            this.setCapabilityValue("thermostat_eco", (state.ecoMode = false));
            this.setCapabilityValue("thermostat_freeze_protection", (state.freezeProtectionMode = false));
          }
          state.turboMode = value; break; /* only available in thermostat_mode 'heat' or 'cool' */
        }
        case "thermostat_eco": {
          /* only available in thermostat_mode 'cool' */
          if (value) {
            state.operationalMode = OPERATIONAL_MODE.COOL;

            /* ECO mode disables boost and freeze protection */
            this.setCapabilityValue("thermostat_boost", (state.turboMode = false));
            this.setCapabilityValue("thermostat_freeze_protection", (state.freezeProtectionMode = false));
          }
          state.ecoMode = value; 
          break; 
        }
        case "thermostat_freeze_protection": {
          /* only available in thermostat_mode 'heat' */
          if (value) {
            state.operationalMode = OPERATIONAL_MODE.HEAT;

            /* freeze protection mode disables boost and ECO */
            this.setCapabilityValue("thermostat_eco", (state.ecoMode = false));
            this.setCapabilityValue("thermostat_boost", (state.turboMode = false));
          }
          state.freezeProtectionMode = value; 
          break; 
        }
        case "thermostat_fan_speed": {
          switch (value) {
            case "auto": {
              if (state.operationalMode == OPERATIONAL_MODE.AUTO) {
                state.fanSpeed = FAN_SPEED.FIXED; /* this is the default setting when thermostat_mode in 'auto' */
              } else {
                state.fanSpeed = FAN_SPEED.AUTO; /* only available in thermostat_mode 'heat' or 'cool' */
              }
              break;
            }
            case "silent": state.fanSpeed = FAN_SPEED.SILENT; break;
            case "low": state.fanSpeed = FAN_SPEED.LOW; break;
            case "medium": state.fanSpeed = FAN_SPEED.MEDIUM; break;
            case "high": state.fanSpeed = FAN_SPEED.HIGH; break;
            case "full": state.fanSpeed = FAN_SPEED.FULL; break;
            default:
              this.log("Value '" + value + "' for capability 'thermostat_fan_speed' does not exist");
              break;
          }
          break;
        }
        case "thermostat_swing_mode": {
          switch (value) {
            case "off": state.swingMode = SWING_MODE.OFF; break;
            case "both": state.swingMode = SWING_MODE.BOTH; break;
            case "vertical": state.swingMode = SWING_MODE.VERTICAL; break;
            case "horizontal": state.swingMode = SWING_MODE.HORIZONTAL; break;
            default:
              this.log("Value '" + value + "' for capability 'thermostat_swing_mode' does not exist");
              break;
          }
          break;
        }
        default:
          this.log("Capability '" + capability + "' does not exist");
          break;
      }

      state = await new SetStateCommand(this._device, state).execute();
      this._updateState(state);
    } catch(err) {
      this.error(err);
      await this._refreshState(); // Revert UI to correct state
      throw new Error("Error during adjustment of settings from device [" + this.getName() + "]"); 
    } finally {
      this._updatingState = false;
    }
  }
}

module.exports = MideaDevice;
