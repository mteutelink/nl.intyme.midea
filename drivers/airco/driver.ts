import { supportedHomeyCapabilities, capabilityOptions } from './capabilities';
import Homey from 'homey';
import type { MideaDevice } from './device';
import { _LOGGER, Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, GetCapabilitiesCommand, CloudSecurityContext, CONNECTION_TYPE, LANSecurityContext, DeviceState, GetStateCommand } from 'midea-msmarthome-ac-euosk105';
import { FAN_SPEED, SWING_MODE, OPERATIONAL_MODE } from 'midea-msmarthome-ac-euosk105/dist/DeviceState';

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
        case FAN_SPEED.AUTO: return args.fan_speed === "auto";
        case FAN_SPEED.FIXED: return args.fan_speed === "auto";
        case FAN_SPEED.SILENT: return args.fan_speed === "silent";
        case FAN_SPEED.LOW: return args.fan_speed === "low";
        case FAN_SPEED.MEDIUM: return args.fan_speed === "medium";
        case FAN_SPEED.HIGH: return args.fan_speed === "high";
        case FAN_SPEED.FULL: return args.fan_speed === "full";
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
        case SWING_MODE.OFF: return args.swing_mode === "off";
        case SWING_MODE.BOTH: return args.swing_mode === "both";
        case SWING_MODE.VERTICAL: return args.swing_mode === "vertical";
        case SWING_MODE.HORIZONTAL: return args.swing_mode === "horizontal";
      }
      return false;
    });

    this.homey.flow.getActionCard('thermostat_swing_mode_set').registerRunListener(async (args, state) => {
      await args.device.onCapability("thermostat_swing_mode", args.swing_mode, null);
    });

    // THERMOSTAT MODE
    this.homey.flow.getTriggerCard('thermostat_mode_changed').registerRunListener(async (args, state) => {
      return args.thermostat_mode === state.value;
    });

    this.homey.flow.getConditionCard('thermostat_mode_is').registerRunListener(async (args, state) => {
      let deviceState: DeviceState = await new GetStateCommand(args.device._device).execute();
      switch (deviceState.operationalMode) {
        case OPERATIONAL_MODE.AUTO: return args.thermostat_mode === "auto";
        case OPERATIONAL_MODE.COOL: return args.thermostat_mode === "cool";
        case OPERATIONAL_MODE.HEAT: return args.thermostat_mode === "heat";
        case OPERATIONAL_MODE.DRY: return args.thermostat_mode === "dry";
        case OPERATIONAL_MODE.FAN: return args.thermostat_mode === "fan";
      }
      return false;
    });

    this.homey.flow.getActionCard('thermostat_mode_set').registerRunListener(async (args, state) => {
      await args.device.onCapability("thermostat_mode", args.thermostat_mode, null);
    });
  }

  private cloudContext(data: any): CloudSecurityContext | null {
    const provider = data.provider ?? "nethomeplus";
    if (provider !== "nethomeplus" && provider !== "msmarthome") {
      throw new Error(this.homey.__("pair.login_credentials.invalidProvider"));
    }
    const username = String(data.username ?? "").trim();
    const password = String(data.password ?? "");
    if (provider === "nethomeplus" && !username && !password) return null;
    if (!username || !password) {
      throw new Error(this.homey.__("pair.login_credentials.credentialsRequired"));
    }
    return new CloudSecurityContext(
      username,
      password,
      provider === "msmarthome"
        ? CONNECTION_TYPE.MSMARTHOME
        : CONNECTION_TYPE.NETHOMEPLUS
    );
  }

  private async prepareCapabilities(device: any, mdevice: MDevice): Promise<void> {
    device.store.mideaCapabilitiesPolicy = 'reported';
    try {
      const caps = await new GetCapabilitiesCommand(mdevice).execute();
      device.capabilities = supportedHomeyCapabilities(caps);
      const options = capabilityOptions(caps);
      device.capabilitiesOptions = Object.fromEntries(
        Object.entries(options).filter(([id]) => device.capabilities.includes(id))
      );
      device.store.mideaCapabilities = caps.toSnapshot();
    } catch (error) {
      // A discovery failure must not prevent pairing; initialize with basic controls.
      device.capabilities = ['onoff', 'thermostat_mode', 'target_temperature', 'measure_temperature', 'measure_temperature.outside'];
      device.capabilitiesOptions = {
        thermostat_mode: { values: [
          { id: 'off', title: { en: 'Off', nl: 'Uit' } },
          { id: 'fan', title: { en: 'Fan', nl: 'Ventileren' } },
        ] },
      };
      this.log('Capabilities unavailable; optional controls can be added after a successful query');
    }
  }

  async onPair(session: any) {
    session.setHandler("list_devices", async () => {
      try {
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
      } catch (err) {
        this.error(err);
        return null;
      }
    });

    session.setHandler("enterTokenAndKey", async (data: any) => {
      try {
        const device = data.devices[0]; 

        let deviceContext: MDeviceContext = new MDeviceContext();
        deviceContext.id = device.data.id;
        deviceContext.macAddress = device.data.macAddress;
        deviceContext.udpId = device.data.udpId;
        deviceContext.host = device.store.host;
        deviceContext.port = device.store.port;

        let mdevice: MDevice = new MDevice(deviceContext)

        await mdevice.authenticate(new LANSecurityContext(data.token, data.key));
        device.store.token = data.token;
        device.store.key = data.key;

        await this.prepareCapabilities(device, mdevice);
        mdevice.close();
        return device;
      } catch (err) {
        this.error(err);
        return null;
      }
    });

    session.setHandler("login", async (data: any) => {
      try {
        const device = data.devices[0];

        let deviceContext: MDeviceContext = new MDeviceContext();
        deviceContext.id = device.data.id;
        deviceContext.macAddress = device.data.macAddress;
        deviceContext.udpId = device.data.udpId;
        deviceContext.host = device.store.host;
        deviceContext.port = device.store.port;

        let mdevice: MDevice = new MDevice(deviceContext)

        const cloudSecurityContext = this.cloudContext(data);
        const lanSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(mdevice, cloudSecurityContext);
        await mdevice.authenticate(lanSecurityContext);
        device.store.token = lanSecurityContext.token;
        device.store.key = lanSecurityContext.key;
        device.store.cloudProvider = data.provider ?? "nethomeplus";

        await this.prepareCapabilities(device, mdevice);
        mdevice.close();
        return device;
      } catch (err) {
        this.error(err instanceof Error ? err.message : "Cloud login failed");
        throw new Error(err instanceof Error ? err.message : "Cloud login failed");
      }
    });
  }

  async onRepair(session: any, device: MideaDevice) {
    let discovered: MDevice | undefined;
    session.setHandler("reinitializeDevice", async () => {
      discovered = (await MDriver.listDevices()).find(candidate => candidate.deviceContext.id === device.getData().id);
      if (!discovered) return null;
      const { token, key } = device.getStore();
      if (token && key) {
        try {
          if (await device.recoverAddress(discovered)) {
            await device.onInit(device._device);
            await session.done();
            return { repaired: true };
          }
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Authentication failed') throw error;
          return { host: discovered.deviceContext.host, credentialsRejected: true };
        }
      }
      return { host: discovered.deviceContext.host, token, key };
    });

    const completeRepair = async (security: LANSecurityContext, provider?: string) => {
      if (!discovered) throw new Error("Air conditioner not found on the local network");
      const candidate = new MDevice(discovered.deviceContext);
      try {
        await candidate.authenticate(security);
        await device.setStoreValue("host", candidate.deviceContext.host);
        await device.setStoreValue("port", candidate.deviceContext.port);
        await device.setStoreValue("token", security.token);
        await device.setStoreValue("key", security.key);
        if (provider) await device.setStoreValue("cloudProvider", provider);
        device._device?.close();
        await device.onInit(candidate);
      } catch (error) {
        candidate.close();
        throw error;
      }
      await session.done();
      return true;
    };

    session.setHandler("enterTokenAndKey", async (data: any) => {
      return completeRepair(new LANSecurityContext(data.token, data.key));
    });

    session.setHandler("login", async (data: any) => {
      if (!discovered) throw new Error("Air conditioner not found on the local network");
      const connection = new MDevice(discovered.deviceContext);
      const security = await MDriver.retrieveTokenAndKeyFromCloud(connection, this.cloudContext(data));
      return completeRepair(security, data.provider ?? "nethomeplus");
    });
  }
}

module.exports = MideaDriver;
