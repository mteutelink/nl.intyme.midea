import Homey from 'homey';
import { Driver as MDriver, Device as MDevice, DeviceContext as MDeviceContext, SecurityContext as MSecurityContext } from 'midea-msmarthome-ac-euosk105';

class MideaDriver extends Homey.Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MideaDriver has been initialized');
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
}

module.exports = MideaDriver;
