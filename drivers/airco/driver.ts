'use strict';

/* eslint-disable import/extensions, import/no-unresolved, node/no-missing-import */
import Homey, { Device } from 'homey';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';
import {
  CloudSecurityContext,
  Device as MDevice,
  DeviceCapabilities,
  DeviceContext as MDeviceContext,
  DeviceState,
  Driver as MDriver,
  GetCapabilitiesCommand,
  GetStateCommand,
  LANSecurityContext,
  MIDEA_DISCOVER_BROADCAST_MSG,
  Security,
} from 'midea-msmarthome-ac-euosk105';
import { getCapabilityOptions, getInitialCapabilityValues, getSupportedCapabilityIds } from './capabilities';
import {
  getCidrHosts,
  getExplicitDiscoveryHosts,
  MAX_AUTO_DISCOVERY_HOSTS,
  MIN_AUTO_DISCOVERY_PREFIX,
  netmaskToPrefix,
} from './discovery-targets';

const MIDEA_AC_APPLIANCE_TYPE = 172;
const MIDEA_DISCOVERY_PORT = 6445;
const DISCOVERY_BATCH_SIZE = 128;
const DISCOVERY_BATCH_DELAY_MS = 10;
const DISCOVERY_SETTLE_MS = 1800;
const DEVICE_AUTH_TIMEOUT_MS = 15000;
const LAN_AUTH_RESPONSE_SAMPLE_BYTES = 16;
const MSMARTHOME_CONNECTION_TYPE = 0;
const MIDEA_HANDSHAKE_REQUEST_MESSAGE_TYPE = 0;

type PairDevice = {
  name: string;
  capabilities?: string[];
  capabilitiesOptions?: {
    [capabilityId: string]: object;
  };
  capabilitiesValues?: {
    [capabilityId: string]: boolean | number | string | null;
  };
  data: {
    id: number;
    macAddress: string;
    udpId: string;
  };
  store: {
    host: string;
    port: number;
    serial?: string;
    firmware?: string;
    cloudName?: string;
    cloudType?: string;
    modelNumber?: string;
    sn8?: string;
    online?: boolean;
    token?: string;
    key?: string;
    authError?: string;
  };
};

type PairSession = {
  setHandler: (name: string, handler: (data: unknown) => Promise<unknown>) => void;
  emit: (event: string, data?: unknown) => Promise<void>;
  done: () => Promise<void>;
};

type DiscoverySession = {
  session: PairSession;
  socket: dgram.Socket;
  timers: NodeJS.Timeout[];
  generation: number;
  seenCandidates: Set<string>;
  preparedIds: Set<string>;
  pending: number;
  ready: number;
  skipped: number;
  doneRequested: boolean;
  stopped: boolean;
};

type TokenAndKeyData = {
  devices: PairDevice[];
  token: string;
  key: string;
};

type LoginData = {
  devices: PairDevice[];
  username?: string;
  password?: string;
};

type StartDiscoveryData = {
  target?: string;
  generation?: number;
};

type RediscoveryDevice = {
  id: number;
  host?: string;
};

type RediscoveryResult = {
  host: string;
  port: number;
};

type LanAuthDiagnostics = {
  responseLength: number;
  tcpKeyLength: number;
  responsePrefix: string;
  tcpKeyPrefix: string;
  tcpKeyIsError: boolean;
};

type CloudApplianceMetadata = {
  id: number;
  name?: string;
  type?: string;
  modelNumber?: string;
  sn8?: string;
  online?: boolean;
};

type CloudApplianceResponse = {
  id: number | string;
  name?: string;
  type?: string;
  modelNumber?: string;
  sn8?: string;
  onlineStatus?: string;
};

type CloudApplianceListResponse = {
  data?: {
    list?: CloudApplianceResponse[];
  };
};

type CloudConnectionWithExecute = {
  executeCommand: (
    cloudSecurityContext: CloudSecurityContext,
    path: string,
    body: object,
  ) => Promise<CloudApplianceListResponse>;
};

class MideaDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MideaDriver has been initialized');

    // THERMOSTAT BOOST
    this.homey.flow.getConditionCard('thermostat_boost_is_true').registerRunListener(async (args, state) => {
      return args.device.isBoostEnabled();
    });

    this.homey.flow.getActionCard('thermostat_boost_set_true').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_boost', true, null);
    });

    this.homey.flow.getActionCard('thermostat_boost_set_false').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_boost', false, null);
    });

    // THERMOSTAT ECO MODE
    this.homey.flow.getConditionCard('thermostat_eco_is_true').registerRunListener(async (args, state) => {
      return args.device.isEcoEnabled();
    });

    this.homey.flow.getActionCard('thermostat_eco_set_true').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_eco', true, null);
    });

    this.homey.flow.getActionCard('thermostat_eco_set_false').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_eco', false, null);
    });

    // THERMOSTAT FREEZE PROTECTION MODE
    this.homey.flow.getConditionCard('thermostat_freeze_protection_is_true').registerRunListener(async (args, state) => {
      return args.device.isFreezeProtectionEnabled();
    });

    this.homey.flow.getActionCard('thermostat_freeze_protection_set_true').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_freeze_protection', true, null);
    });

    this.homey.flow.getActionCard('thermostat_freeze_protection_set_false').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_freeze_protection', false, null);
    });

    // THERMOSTAT FAN SPEED
    this.homey.flow.getTriggerCard('thermostat_fan_speed_changed').registerRunListener(async (args, state) => {
      return args.fan_speed === state.value;
    });

    this.homey.flow.getConditionCard('thermostat_fan_speed_is').registerRunListener(async (args, state) => {
      return args.fan_speed === await args.device.getFanSpeedValue();
    });

    this.homey.flow.getActionCard('thermostat_fan_speed_set').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_fan_speed', args.fan_speed, null);
    });

    // THERMOSTAT SWING MODE
    this.homey.flow.getTriggerCard('thermostat_swing_mode_changed').registerRunListener(async (args, state) => {
      return args.swing_mode === state.value;
    });

    this.homey.flow.getConditionCard('thermostat_swing_mode_is').registerRunListener(async (args, state) => {
      return args.swing_mode === await args.device.getSwingModeValue();
    });

    this.homey.flow.getActionCard('thermostat_swing_mode_set').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_swing_mode', args.swing_mode, null);
    });

    // THERMOSTAT MODE
    this.homey.flow.getTriggerCard('thermostat_mode_changed').registerRunListener(async (args, state) => {
      return args.thermostat_mode === state.value;
    });

    this.homey.flow.getConditionCard('thermostat_mode_is').registerRunListener(async (args, state) => {
      return args.thermostat_mode === await args.device.getThermostatModeValue();
    });

    this.homey.flow.getActionCard('thermostat_mode_set').registerRunListener(async (args, state) => {
      await args.device.onCapability('thermostat_mode', args.thermostat_mode, null);
    });
  }

  async onPair(session: PairSession) {
    let discoverySession: DiscoverySession | null = null;

    session.setHandler('enterTokenAndKey', async (payload: unknown) => {
      const data = payload as TokenAndKeyData;
      try {
        const device = data.devices[0];
        if (!device) {
          return null;
        }

        return this.preparePairDeviceWithTokenAndKey(device, data.token, data.key);
      } catch (err) {
        this.error(err);
        throw err;
      }
    });

    session.setHandler('login', async (payload: unknown) => {
      const data = payload as LoginData;
      try {
        this.log(`login handler called for ${data && data.devices ? data.devices.length : 0} device(s)`);
        return this.preparePairDevices(data.devices, data.username, data.password);
      } catch (err) {
        this.error(err);
        return {
          devices: [] as PairDevice[],
          failed: data && data.devices ? data.devices : [],
        };
      }
    });

    session.setHandler('startDiscovery', async (payload: unknown) => {
      const data = payload as StartDiscoveryData;
      try {
        this.stopDiscovery(discoverySession);
        discoverySession = this.createDiscoverySession(session, data && data.generation);
        this.startDiscovery(discoverySession, data && data.target);
        return { started: true };
      } catch (err) {
        this.error(err);
        return { started: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    session.setHandler('stopDiscovery', async () => {
      this.stopDiscovery(discoverySession);
      discoverySession = null;
      return { stopped: true };
    });

    session.setHandler('prepareDevices', async (payload: unknown) => {
      const data = payload as LoginData;
      this.log(`prepareDevices handler called for ${data && data.devices ? data.devices.length : 0} device(s), credentials=${data && (data.username || data.password) ? 'provided' : 'default'}`);
      return this.preparePairDevices(data.devices, data.username, data.password);
    });
  }

  async onRepair(session: PairSession, device: Device) {
    session.setHandler('reinitializeDevice', async () => {
      const mdevices = await MDriver.listDevices();
      const mdevice = mdevices.find((mdevice) => device.getData().id === mdevice.deviceContext.id);
      if (mdevice) {
        if (mdevice.deviceContext.host !== device.getStore().host) {
          // IP ADDRESS OF THE DEVICE HAS CHANGED ==> RESET HOST and CLEAR TOKEN AND KEY
          await device.setStoreValue('host', mdevice.deviceContext.host);
          await device.setStoreValue('port', mdevice.deviceContext.port);
          await device.setStoreValue('token', null);
          await device.setStoreValue('key', null);
        }
        return device.getStore();
      }
      return null;
    });

    session.setHandler('enterTokenAndKey', async (payload: unknown) => {
      const data = payload as TokenAndKeyData;
      let mdevice: MDevice | null = null;
      try {
        const deviceContext: MDeviceContext = new MDeviceContext();
        deviceContext.id = device.getData().id;
        deviceContext.macAddress = device.getData().macAddress;
        deviceContext.udpId = device.getData().udpId;
        deviceContext.host = device.getStore().host;
        deviceContext.port = device.getStore().port;

        mdevice = new MDevice(deviceContext);

        await mdevice.authenticate(new LANSecurityContext(data.token, data.key));
        await device.setStoreValue('token', data.token);
        await device.setStoreValue('key', data.key);

        mdevice.close();
        mdevice = null;

        await device.onInit();
        await session.done();
        return device;
      } catch (err) {
        this.error(err);
        return null;
      } finally {
        if (mdevice) {
          mdevice.close();
        }
      }
    });

    session.setHandler('login', async (payload: unknown) => {
      const data = payload as LoginData;
      let mdevice: MDevice | null = null;
      try {
        const deviceContext: MDeviceContext = new MDeviceContext();
        deviceContext.id = device.getData().id;
        deviceContext.macAddress = device.getData().macAddress;
        deviceContext.udpId = device.getData().udpId;
        deviceContext.host = device.getStore().host;
        deviceContext.port = device.getStore().port;

        mdevice = new MDevice(deviceContext);

        const cloudSecurityContext: CloudSecurityContext = new CloudSecurityContext(data.username, data.password);
        const lanSecurityContext: LANSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(mdevice, cloudSecurityContext);
        await device.setStoreValue('token', lanSecurityContext.token);
        await device.setStoreValue('key', lanSecurityContext.key);

        mdevice.close();
        mdevice = null;

        await device.onInit();
        await session.done();
        return device;
      } catch (err) {
        this.error(err);
        return null;
      } finally {
        if (mdevice) {
          mdevice.close();
        }
      }
    });
  }

  private createDiscoverySession(session: PairSession, generation?: number): DiscoverySession {
    const discoverySession: DiscoverySession = {
      session,
      socket: dgram.createSocket('udp4'),
      timers: [],
      generation: generation || 0,
      seenCandidates: new Set<string>(),
      preparedIds: new Set<string>(),
      pending: 0,
      ready: 0,
      skipped: 0,
      doneRequested: false,
      stopped: false,
    };

    discoverySession.socket.on('message', (message, info) => {
      this.handleDiscoveryMessage(discoverySession, message, info.address).catch((error) => this.error(error));
    });

    discoverySession.socket.on('error', (error) => {
      this.handleDiscoveryError(discoverySession, error).catch((emitError) => this.error(emitError));
    });

    return discoverySession;
  }

  private async handleDiscoveryMessage(discoverySession: DiscoverySession, message: Buffer, host: string) {
    if (discoverySession.stopped) {
      return;
    }

    const mdevice = this.parseDiscoveryResponse(message, host);
    if (!mdevice) {
      return;
    }

    const device = this.createPairDevice(mdevice);
    const candidateKey = this.getDiscoveryCandidateKey(device);
    const stableKey = this.getStableDeviceKey(device);
    if (
      discoverySession.seenCandidates.has(candidateKey)
      || discoverySession.preparedIds.has(stableKey)
    ) {
      return;
    }

    discoverySession.seenCandidates.add(candidateKey);
    if (this.isAlreadyPairedDevice(device)) {
      device.store.authError = 'Device is already paired';
      discoverySession.skipped++;
      if (!discoverySession.stopped) {
        await discoverySession.session.emit('deviceCandidateFailed', {
          generation: discoverySession.generation,
          device,
        });
      }
      await this.emitDiscoveryProgress(discoverySession);
      return;
    }

    discoverySession.pending++;
    try {
      const result = await this.preparePairDevices([device]);
      const preparedDevice = result.devices[0];
      const failedDevice = result.failed[0];

      if (
        preparedDevice
        && !discoverySession.stopped
        && !discoverySession.preparedIds.has(stableKey)
      ) {
        discoverySession.preparedIds.add(stableKey);
        discoverySession.ready++;
        await discoverySession.session.emit('deviceFound', {
          generation: discoverySession.generation,
          device: preparedDevice,
        });
      } else {
        discoverySession.skipped++;
        if (failedDevice && !discoverySession.stopped) {
          await discoverySession.session.emit('deviceCandidateFailed', {
            generation: discoverySession.generation,
            device: failedDevice,
          });
        }
        await this.emitDiscoveryProgress(discoverySession);
      }
    } catch (error) {
      discoverySession.skipped++;
      this.error(`Skipping discovered Midea device ${device.data.id} at ${device.store.host}: ${
        error instanceof Error ? error.message : String(error)
      }`);
      if (!discoverySession.stopped) {
        await discoverySession.session.emit('deviceCandidateFailed', {
          generation: discoverySession.generation,
          device,
        });
      }
      await this.emitDiscoveryProgress(discoverySession);
    } finally {
      discoverySession.pending--;
      await this.finishDiscoveryIfReady(discoverySession);
    }
  }

  private async handleDiscoveryError(discoverySession: DiscoverySession, error: Error) {
    if (!discoverySession.stopped) {
      this.error(error);
      await discoverySession.session.emit('discoveryError', {
        generation: discoverySession.generation,
        error: error.message,
      });
    }
    this.stopDiscovery(discoverySession);
  }

  private startDiscovery(discoverySession: DiscoverySession, target?: string) {
    const explicitTarget = Boolean(target && target.trim());
    const hosts = explicitTarget
      ? getExplicitDiscoveryHosts(target)
      : this.getLocalDiscoveryHosts();

    discoverySession.socket.bind({}, () => {
      discoverySession.socket.setBroadcast(true);
      if (!explicitTarget) {
        this.sendDiscoveryPacket(discoverySession, '255.255.255.255');
      }
      this.sendDiscoveryHosts(discoverySession, hosts);
    });
  }

  private sendDiscoveryHosts(discoverySession: DiscoverySession, hosts: string[]) {
    for (let offset = 0; offset < hosts.length; offset += DISCOVERY_BATCH_SIZE) {
      const batch = hosts.slice(offset, offset + DISCOVERY_BATCH_SIZE);
      const timer = this.homey.setTimeout(() => {
        batch.forEach((host) => this.sendDiscoveryPacket(discoverySession, host));
      }, (offset / DISCOVERY_BATCH_SIZE) * DISCOVERY_BATCH_DELAY_MS);
      discoverySession.timers.push(timer);
    }

    const doneDelay = Math.ceil(hosts.length / DISCOVERY_BATCH_SIZE) * DISCOVERY_BATCH_DELAY_MS + DISCOVERY_SETTLE_MS;
    const doneTimer = this.homey.setTimeout(() => {
      if (!discoverySession.stopped) {
        discoverySession.doneRequested = true;
        this.finishDiscoveryIfReady(discoverySession).catch((error) => this.error(error));
      }
    }, doneDelay);
    discoverySession.timers.push(doneTimer);
  }

  private async emitDiscoveryProgress(discoverySession: DiscoverySession) {
    if (!discoverySession.stopped) {
      await discoverySession.session.emit('discoveryProgress', {
        generation: discoverySession.generation,
        seen: discoverySession.seenCandidates.size,
        ready: discoverySession.ready,
        skipped: discoverySession.skipped,
        pending: discoverySession.pending,
      });
    }
  }

  private async finishDiscoveryIfReady(discoverySession: DiscoverySession) {
    if (
      discoverySession.stopped
      || !discoverySession.doneRequested
      || discoverySession.pending > 0
    ) {
      return;
    }

    await discoverySession.session.emit('discoveryDone', {
      generation: discoverySession.generation,
      count: discoverySession.ready,
      ready: discoverySession.ready,
      skipped: discoverySession.skipped,
      seen: discoverySession.seenCandidates.size,
    });
    this.stopDiscovery(discoverySession);
  }

  private sendDiscoveryPacket(discoverySession: DiscoverySession, host: string) {
    if (discoverySession.stopped) {
      return;
    }
    discoverySession.socket.send(
      MIDEA_DISCOVER_BROADCAST_MSG,
      0,
      MIDEA_DISCOVER_BROADCAST_MSG.length,
      MIDEA_DISCOVERY_PORT,
      host,
    );
  }

  private stopDiscovery(discoverySession: DiscoverySession | null) {
    if (!discoverySession || discoverySession.stopped) {
      return;
    }

    discoverySession.stopped = true;
    discoverySession.timers.forEach((timer) => this.homey.clearTimeout(timer));
    try {
      discoverySession.socket.close();
    } catch (error) {
      // The socket may already be closed by a previous cancellation path.
    }
  }

  private getLocalDiscoveryHosts(): string[] {
    const hosts = new Set<string>();
    const interfaces = os.networkInterfaces();

    Object.values(interfaces).forEach((items) => {
      (items || []).forEach((item) => {
        if (item.family !== 'IPv4' || item.internal) {
          return;
        }

        const prefix = Math.max(netmaskToPrefix(item.netmask), MIN_AUTO_DISCOVERY_PREFIX);
        getCidrHosts(item.address, prefix, MAX_AUTO_DISCOVERY_HOSTS)
          .forEach((host) => hosts.add(host));
      });
    });

    return Array.from(hosts);
  }

  private getDiscoveryCandidateKey(device: PairDevice): string {
    return `${this.getStableDeviceKey(device)}:${device.store.host}`;
  }

  private getStableDeviceKey(device: PairDevice): string {
    return device.data.id ? `id:${device.data.id}` : `mac:${device.data.macAddress || device.data.udpId}`;
  }

  private isAlreadyPairedDevice(device: PairDevice): boolean {
    return this.getDevices().some((homeyDevice) => {
      const data = homeyDevice.getData() as Partial<PairDevice['data']>;

      return (
        typeof data.id === 'number'
        && data.id === device.data.id
      ) || (
        Boolean(data.macAddress)
        && data.macAddress === device.data.macAddress
      ) || (
        Boolean(data.udpId)
        && data.udpId === device.data.udpId
      );
    });
  }

  async rediscoverMideaDevice(device: RediscoveryDevice): Promise<RediscoveryResult | null> {
    const hosts = this.getRediscoveryHosts(device.host);
    const devices = await this.discoverMideaPairDevices(hosts);
    const discoveredDevice = devices.find((candidate) => candidate.data.id === device.id);

    if (!discoveredDevice) {
      return null;
    }

    return {
      host: discoveredDevice.store.host,
      port: discoveredDevice.store.port,
    };
  }

  private getRediscoveryHosts(host?: string): string[] {
    const hosts = new Set<string>();

    if (host) {
      getCidrHosts(host, 24, MAX_AUTO_DISCOVERY_HOSTS)
        .forEach((candidate) => hosts.add(candidate));
    }

    this.getLocalDiscoveryHosts()
      .forEach((candidate) => hosts.add(candidate));

    return Array.from(hosts);
  }

  private async discoverMideaPairDevices(hosts: string[]): Promise<PairDevice[]> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const devices: PairDevice[] = [];
      const seen = new Set<string>();
      let closed = false;

      const close = () => {
        if (!closed) {
          closed = true;
          socket.close();
        }
      };

      socket.on('message', (message, info) => {
        const mdevice = this.parseDiscoveryResponse(message, info.address);
        if (!mdevice) {
          return;
        }

        const device = this.createPairDevice(mdevice);
        const key = this.getDiscoveryCandidateKey(device);
        if (seen.has(key)) {
          return;
        }

        seen.add(key);
        devices.push(device);
      });

      socket.on('error', (error) => {
        close();
        reject(error);
      });

      socket.bind({}, () => {
        socket.setBroadcast(true);
        hosts.forEach((host) => {
          socket.send(
            MIDEA_DISCOVER_BROADCAST_MSG,
            0,
            MIDEA_DISCOVER_BROADCAST_MSG.length,
            MIDEA_DISCOVERY_PORT,
            host,
          );
        });
      });

      this.homey.setTimeout(() => {
        close();
        resolve(devices);
      }, DISCOVERY_SETTLE_MS);
    });
  }

  private async preparePairDevices(devices: PairDevice[], username?: string, password?: string) {
    const preparedDevices: PairDevice[] = [];
    const failed: PairDevice[] = [];
    const cloudMetadata = await this.getCloudApplianceMetadata(devices || [], username, password);

    for (const device of devices || []) {
      try {
        if (this.isAlreadyPairedDevice(device)) {
          device.store.authError = 'Device is already paired';
          failed.push(device);
          continue;
        }

        this.applyCloudMetadata(device, cloudMetadata.get(device.data.id));
        this.log(`Preparing Midea device ${device.data.id} at ${device.store.host}`);
        const cloudSecurityContext = username || password
          ? new CloudSecurityContext(username, password)
          : null;
        const {
          udpId,
          lanSecurityContext,
          capabilities,
          state,
        } = await this.withTimeout(
          this.prepareDeviceWithUdpIdCandidates(device, cloudSecurityContext),
          DEVICE_AUTH_TIMEOUT_MS,
          'Timed out while authenticating the device',
        );
        this.applyPreparedDevice(device, udpId, lanSecurityContext, capabilities, state);
        preparedDevices.push(device);
        this.log(`Prepared Midea device ${device.data.id} at ${device.store.host}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        device.store.authError = message;
        this.error(`Failed to prepare Midea device ${device.data.id} at ${device.store.host}: ${message}`);
        failed.push(device);
      }
    }

    return {
      devices: preparedDevices,
      failed,
    };
  }

  private async preparePairDeviceWithTokenAndKey(device: PairDevice, token: string, key: string): Promise<PairDevice> {
    if (this.isAlreadyPairedDevice(device)) {
      throw new Error('Device is already paired');
    }

    const {
      udpId,
      lanSecurityContext,
      capabilities,
      state,
    } = await this.withTimeout(
      this.prepareDeviceWithTokenAndKeyCandidates(device, token, key),
      DEVICE_AUTH_TIMEOUT_MS,
      'Timed out while authenticating the device',
    );

    this.applyPreparedDevice(device, udpId, lanSecurityContext, capabilities, state);
    return device;
  }

  private applyPreparedDevice(
    device: PairDevice,
    udpId: string,
    lanSecurityContext: LANSecurityContext,
    capabilities: DeviceCapabilities,
    state: DeviceState,
  ) {
    device.data.udpId = udpId;
    device.capabilities = getSupportedCapabilityIds(capabilities);
    device.capabilitiesOptions = getCapabilityOptions(capabilities);
    device.capabilitiesValues = getInitialCapabilityValues(state, device.capabilities);
    device.store.token = lanSecurityContext.token;
    device.store.key = lanSecurityContext.key;
    delete device.store.authError;
  }

  private async getCloudApplianceMetadata(
    devices: PairDevice[],
    username?: string,
    password?: string,
  ): Promise<Map<number, CloudApplianceMetadata>> {
    const metadataById = new Map<number, CloudApplianceMetadata>();
    if (!devices.length || !username || !password) {
      return metadataById;
    }

    try {
      const cloudSecurityContext = new CloudSecurityContext(username, password, MSMARTHOME_CONNECTION_TYPE);
      const cloudConnection = cloudSecurityContext.getCloudConnection(this.createMideaDevice(devices[0])) as CloudConnectionWithExecute;
      const response = await this.withTimeout(
        cloudConnection.executeCommand(cloudSecurityContext, '/v1/appliance/user/list/get', {}),
        DEVICE_AUTH_TIMEOUT_MS,
        'Timed out while retrieving device names from the MSmartHome cloud',
      );
      const appliances = response && response.data && Array.isArray(response.data.list)
        ? response.data.list
        : [];

      appliances.forEach((appliance) => {
        const id = Number(appliance.id);
        if (!Number.isFinite(id)) {
          return;
        }

        metadataById.set(id, {
          id,
          name: appliance.name,
          type: appliance.type,
          modelNumber: appliance.modelNumber,
          sn8: appliance.sn8,
          online: appliance.onlineStatus === '1',
        });
      });

      this.log(`Retrieved MSmartHome metadata for ${metadataById.size} appliance(s)`);
    } catch (error) {
      this.error(`Failed to retrieve MSmartHome device metadata: ${error instanceof Error ? error.message : String(error)}`);
    }

    return metadataById;
  }

  private applyCloudMetadata(device: PairDevice, metadata?: CloudApplianceMetadata) {
    if (!metadata) {
      return;
    }

    if (metadata.name) {
      device.name = metadata.name;
      device.store.cloudName = metadata.name;
    }
    device.store.cloudType = metadata.type;
    device.store.modelNumber = metadata.modelNumber;
    device.store.sn8 = metadata.sn8;
    device.store.online = metadata.online;
  }

  private async prepareDeviceWithUdpIdCandidates(
    device: PairDevice,
    cloudSecurityContext: CloudSecurityContext | null,
  ): Promise<{ udpId: string; lanSecurityContext: LANSecurityContext; capabilities: DeviceCapabilities; state: DeviceState }> {
    let lastError: Error | null = null;

    for (const udpId of this.getUdpIdCandidates(device)) {
      let mdevice: MDevice | null = null;
      try {
        mdevice = this.createMideaDevice(device, udpId);
        const lanSecurityContext = await MDriver.retrieveTokenAndKeyFromCloud(mdevice, cloudSecurityContext);
        this.log(`Retrieved token and key for Midea device ${device.data.id} using udpId ${udpId}`);
        const { capabilities, state } = await this.prepareAuthenticatedMideaDevice(device, mdevice, lanSecurityContext);
        return {
          udpId,
          lanSecurityContext,
          capabilities,
          state,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.error(`Failed token/key and LAN auth flow for Midea device ${device.data.id} using udpId ${udpId}: ${lastError.message}`);
      } finally {
        if (mdevice) {
          mdevice.close();
        }
      }
    }

    throw lastError || new Error('Unable to retrieve token and key from the Midea cloud or authenticate locally');
  }

  private async prepareDeviceWithTokenAndKeyCandidates(
    device: PairDevice,
    token: string,
    key: string,
  ): Promise<{ udpId: string; lanSecurityContext: LANSecurityContext; capabilities: DeviceCapabilities; state: DeviceState }> {
    let lastError: Error | null = null;

    for (const udpId of this.getUdpIdCandidates(device)) {
      let mdevice: MDevice | null = null;
      try {
        mdevice = this.createMideaDevice(device, udpId);
        const lanSecurityContext = new LANSecurityContext(token, key);
        const { capabilities, state } = await this.prepareAuthenticatedMideaDevice(device, mdevice, lanSecurityContext);
        return {
          udpId,
          lanSecurityContext,
          capabilities,
          state,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.error(`Failed manual token/key LAN auth flow for Midea device ${device.data.id} using udpId ${udpId}: ${lastError.message}`);
      } finally {
        if (mdevice) {
          mdevice.close();
        }
      }
    }

    throw lastError || new Error('Unable to authenticate locally with the provided token and key');
  }

  private async prepareAuthenticatedMideaDevice(
    device: PairDevice,
    mdevice: MDevice,
    lanSecurityContext: LANSecurityContext,
  ): Promise<{ capabilities: DeviceCapabilities; state: DeviceState }> {
    await this.authenticateDeviceForPairing(device, mdevice, lanSecurityContext);
    const capabilities = await new GetCapabilitiesCommand(mdevice).execute();
    const state = await new GetStateCommand(mdevice).execute();
    return { capabilities, state };
  }

  private getUdpIdCandidates(device: PairDevice): string[] {
    return Array.from(new Set([
      device.data.udpId,
      this.createUdpId(device.data.id, 'little'),
      this.createUdpId(device.data.id, 'big'),
    ].filter(Boolean)));
  }

  private createUdpId(deviceId: number, endian: 'little' | 'big'): string {
    if (!Number.isSafeInteger(deviceId) || deviceId < 0) {
      throw new Error(`Invalid Midea device id: ${deviceId}`);
    }

    const bytes = Buffer.alloc(6);

    if (endian === 'little') {
      bytes.writeUIntLE(deviceId, 0, bytes.length);
    } else {
      bytes.writeUIntBE(deviceId, 0, bytes.length);
    }

    const hash = crypto.createHash('sha256').update(bytes).digest();
    const udpId = Buffer.alloc(16);
    for (let index = 0; index < udpId.length; index++) {
      udpId[index] = hash[index] ^ hash[index + 16];
    }

    return udpId.toString('hex');
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve, reject) => {
          timer = this.homey.setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        this.homey.clearTimeout(timer);
      }
    }
  }

  private async authenticateDeviceForPairing(
    device: PairDevice,
    mdevice: MDevice,
    lanSecurityContext: LANSecurityContext,
  ): Promise<void> {
    try {
      await mdevice.authenticate(lanSecurityContext);
    } catch (error) {
      const originalError = error instanceof Error ? error.message : String(error);
      this.error(`LAN authentication failed for Midea device ${device.data.id} at ${device.store.host}:${device.store.port}: ${originalError}`);

      const probe = await this.probeLanAuthentication(device, lanSecurityContext);
      mdevice.lanSecurityContext = probe;
      this.log(`LAN authentication recovered on retry for Midea device ${device.data.id} at ${device.store.host}:${device.store.port}`);
    }
  }

  private async probeLanAuthentication(device: PairDevice, lanSecurityContext: LANSecurityContext): Promise<LANSecurityContext> {
    let diagnostics: LanAuthDiagnostics | null = null;

    try {
      const encoded = Security.encode8370(
        lanSecurityContext,
        Buffer.from(lanSecurityContext.token, 'hex'),
        0,
        MIDEA_HANDSHAKE_REQUEST_MESSAGE_TYPE,
      );
      const response = await this.executeLanHandshake(device, encoded.data);
      const tcpKeyData = response.slice(8, 72);
      diagnostics = this.getLanAuthDiagnostics(response, tcpKeyData);
      const updatedSecurityContext = await Security.tcpKey(lanSecurityContext, tcpKeyData);
      this.log(`LAN authentication probe succeeded for Midea device ${device.data.id} at ${device.store.host}:${device.store.port}: ${this.formatLanAuthDiagnostics(diagnostics)}`);
      return updatedSecurityContext;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnosticMessage = diagnostics
        ? `${message}; ${this.formatLanAuthDiagnostics(diagnostics)}`
        : message;
      this.error(`LAN authentication probe failed for Midea device ${device.data.id} at ${device.store.host}:${device.store.port}: ${diagnosticMessage}`);
      throw new Error(diagnosticMessage);
    }
  }

  private async executeLanHandshake(device: PairDevice, message: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (error: Error | null, response?: Buffer) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();

        if (error) {
          reject(error);
          return;
        }

        resolve(response || Buffer.alloc(0));
      };

      socket.setTimeout(DEVICE_AUTH_TIMEOUT_MS);
      socket.once('error', (error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
      socket.once('timeout', () => {
        finish(new Error('LAN handshake timed out'));
      });
      socket.once('data', (response) => {
        finish(null, response);
      });

      socket.connect(device.store.port, device.store.host, () => {
        socket.write(message, (error) => {
          if (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    });
  }

  private getLanAuthDiagnostics(response: Buffer, tcpKeyData: Buffer): LanAuthDiagnostics {
    return {
      responseLength: response.length,
      tcpKeyLength: tcpKeyData.length,
      responsePrefix: response.subarray(0, LAN_AUTH_RESPONSE_SAMPLE_BYTES).toString('hex'),
      tcpKeyPrefix: tcpKeyData.subarray(0, LAN_AUTH_RESPONSE_SAMPLE_BYTES).toString('hex'),
      tcpKeyIsError: tcpKeyData.toString('utf8') === 'ERROR',
    };
  }

  private formatLanAuthDiagnostics(diagnostics: LanAuthDiagnostics): string {
    return [
      `responseLength=${diagnostics.responseLength}`,
      `tcpKeyLength=${diagnostics.tcpKeyLength}`,
      `responsePrefix=${diagnostics.responsePrefix || '<empty>'}`,
      `tcpKeyPrefix=${diagnostics.tcpKeyPrefix || '<empty>'}`,
      `tcpKeyIsError=${diagnostics.tcpKeyIsError}`,
    ].join(', ');
  }

  private createPairDevice(mdevice: MDevice): PairDevice {
    return {
      name: mdevice.deviceContext.ssid || 'Air conditioner',
      data: {
        id: mdevice.deviceContext.id,
        macAddress: mdevice.deviceContext.macAddress,
        udpId: mdevice.deviceContext.udpId,
      },
      store: {
        host: mdevice.deviceContext.host,
        port: mdevice.deviceContext.port,
        serial: mdevice.deviceContext.serial,
        firmware: mdevice.deviceContext.firmware,
      },
    };
  }

  private createMideaDevice(device: PairDevice, udpId = device.data.udpId): MDevice {
    const deviceContext: MDeviceContext = new MDeviceContext();
    deviceContext.id = device.data.id;
    deviceContext.macAddress = device.data.macAddress;
    deviceContext.udpId = udpId;
    deviceContext.host = device.store.host;
    deviceContext.port = device.store.port;

    return new MDevice(deviceContext);
  }

  private parseDiscoveryResponse(message: Buffer, host: string): MDevice | null {
    try {
      let msg = message;
      const context = new MDeviceContext();

      if (msg[0] === 0x83 || msg[1] === 0x70) {
        context.version = 3;
        msg = msg.subarray(8, msg.length - 16);
      } else if (msg[0] === 0x5A || msg[1] === 0x5A) {
        context.version = 2;
      }

      if (msg[0] !== 0x5A || msg.length < 104) {
        return null;
      }

      const data = Security.aesDecrypt(msg.subarray(40, msg.length - 16));
      context.applianceType = data[55 + data[40]];
      const idHex = msg.subarray(20, 26).toString('hex').match(/../g).reverse()
        .join('');
      context.id = parseInt(idHex, 16);
      context.ssid = data.subarray(41, 41 + data[40]).toString();
      context.macAddress = Array.from(data.subarray(63 + data[40], 69 + data[40]))
        .map((byte) => byte.toString(16))
        .join(':');
      context.host = host;
      context.port = parseInt(data.subarray(4, 8).toString('hex').match(/../g).reverse()
        .join(''), 16);
      context.serial = data.subarray(8, 40).toString();
      context.firmware = `${data[72 + data[40]]}.${data[73 + data[40]]}.${data[74 + data[40]]}`;

      if (context.version === 3) {
        const hash = crypto.createHash('sha256').update(Buffer.from(idHex, 'hex')).digest();
        const b1 = hash.subarray(0, 16);
        const b2 = hash.subarray(16);
        const b3 = Buffer.alloc(16);
        for (let i = 0; i < b1.length; i++) {
          b3[i] = b1[i] ^ b2[i];
        }
        context.udpId = b3.toString('hex');
      }

      if (context.version === 3 && context.applianceType === MIDEA_AC_APPLIANCE_TYPE) {
        return new MDevice(context);
      }
    } catch (error) {
      this.error(error);
    }
    return null;
  }

}

module.exports = MideaDriver;
