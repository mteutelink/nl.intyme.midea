import Homey, { Device } from 'homey';
import { Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, SecurityContext as MSecurityContext, DeviceState, GetStateCommand } from 'midea-msmarthome-ac-euosk105';
import { FAN_SPEED, SWING_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';
import { MideaDevice } from './device'

class MideaDriver extends Homey.Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MideaDriver has been initialized');

        // THERMOSTAT BOOST
        this.homey.flow.getConditionCard('thermostat_boost_is_true').registerRunListener(async (args, state) => {
          let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
          return (deviceState.turboMode);
        });

        this.homey.flow.getActionCard('thermostat_boost_set_true').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_boost", true, null);
        });
    
        this.homey.flow.getActionCard('thermostat_boost_set_false').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_boost", false, null);
        });
    
        // THERMOSTAT ECO MODE
        this.homey.flow.getConditionCard('thermostat_eco_is_true').registerRunListener(async (args, state) => {
          let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
          return (deviceState.ecoMode);
        });

        this.homey.flow.getActionCard('thermostat_eco_set_true').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_eco", true, null);
        });
    
        this.homey.flow.getActionCard('thermostat_eco_set_false').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_eco", false, null);
        });
    
        // THERMOSTAT FREEZE PROTECTION MODE
        this.homey.flow.getConditionCard('thermostat_freeze_protection_is_true').registerRunListener(async (args, state) => {
          let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
          return (deviceState.freezeProtectionMode);
        });

        this.homey.flow.getActionCard('thermostat_freeze_protection_set_true').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_freeze_protection", true, null);
        });
    
        this.homey.flow.getActionCard('thermostat_freeze_protection_set_false').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_freeze_protection", false, null);
        });
    
        // THERMOSTAT FAN SPEED
        this.homey.flow.getTriggerCard('thermostat_fan_speed_changed').registerRunListener(async (args, state) => {
          return args.fan_speed === state.value;
        });

        this.homey.flow.getConditionCard('thermostat_fan_speed_is').registerRunListener(async (args, state) => {
          let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
          switch (deviceState.fanSpeed) {
            case FAN_SPEED.AUTO: return args.fan_speed === "auto"; break;
            case FAN_SPEED.FIXED: return args.fan_speed === "auto"; break;
            case FAN_SPEED.SILENT: return args.fan_speed === "silent"; break;
            case FAN_SPEED.LOW: return args.fan_speed === "low"; break;
            case FAN_SPEED.MEDIUM: return args.fan_speed === "medium"; break;
            case FAN_SPEED.HIGH: return args.fan_speed === "high"; break;
            case FAN_SPEED.FULL: return args.fan_speed === "full"; break;
          }
          return false;
        });

        this.homey.flow.getActionCard('thermostat_fan_speed_set').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_fan_speed", args.fan_speed, null);
        });

        // THERMOSTAT SWING MODE
        this.homey.flow.getTriggerCard('thermostat_swing_mode_changed').registerRunListener(async (args, state) => {
          return args.swing_mode === state.value;
        });

        this.homey.flow.getConditionCard('thermostat_swing_mode_is').registerRunListener(async (args, state) => {
          let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
          switch (deviceState.swingMode) {
            case SWING_MODE.OFF: return args.swing_mode === "off"; break;
            case SWING_MODE.BOTH: return args.swing_mode === "both"; break;
            case SWING_MODE.VERTICAL: return args.swing_mode === "vertical"; break;
            case SWING_MODE.HORIZONTAL: return args.swing_mode === "horizontal"; break;
          }
          return false;
        });

        this.homey.flow.getActionCard('thermostat_swing_mode_set').registerRunListener(async (args, state) => {
          await args.device.onCapability("thermostat_swing_mode", args.swing_mode, null);
        });
  }

  async onPair(session: any) {
    session.setHandler("list_devices", async () => {
      let devices: any[] = [];

      let mdevices: MDevice[] = await MDriver.listDevices();
      mdevices.forEach(mdevice => {

        const device = {
          name: mdevice.deviceContext.ssid,
          data: {
            id: mdevice.deviceContext.id,
            macAddress: mdevice.deviceContext.macAddress,
            udpId: mdevice.deviceContext.udpId
          },
          store: {
            host: mdevice.deviceContext.host,
            port: mdevice.deviceContext.port,
          }
        };
        devices.push(device);
      });
      return devices;
    });

    session.setHandler("login", async (data: any) => {
      try {
        const device = data.devices[0];

        let deviceContext: MDeviceContext = new MDeviceContext();
        deviceContext.id = device.data.id;
        deviceContext.udpId = device.data.udpId;
        deviceContext.host = device.store.host;
        deviceContext.port = device.store.port;

        let mdevice: MDevice = new MDevice(deviceContext)

        let securityContext: MSecurityContext = await mdevice.authenticate(new MSecurityContext(data.username, data.password));
        device.store.username = securityContext.account;
        device.store.password = securityContext.password;
        return device;
      } catch (err) {
        return null;
      }
    });
  }

  async onRepair(session: any, device: Device) {
    session.setHandler("relogin", async (data: any) => {
      try {
        let securityContext: MSecurityContext = await (<MideaDevice>device)._device.authenticate(new MSecurityContext(data.username, data.password));
        device.setStoreValue("username", securityContext.account);
        device.setStoreValue("password", securityContext.password);
        return device;
      } catch (err) {
        return null;
      }    
    });
  }
}

module.exports = MideaDriver;
