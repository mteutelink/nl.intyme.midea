import Homey from 'homey';

/**
 * Driver for Midea-protocol air conditioners that are only reachable via
 * infrared (no WiFi module / MSmartHome account), such as units that ship
 * with a Midea OEM remote control (RG51/RG52/RG56/RG57 series, used by
 * Midea itself and by rebrands such as Mundoclima, Pioneer, Comfee and
 * Maxicool).
 *
 * Unlike the WiFi-based `airco` driver in this app, there is no way to
 * read the unit's actual state back over infrared, so this driver treats
 * Homey's stored capability values as the source of truth and always
 * sends a complete, freshly built command for the combined power / mode /
 * temperature / fan speed state.
 */
class MideaInfraredDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MideaInfraredDriver has been initialized');
  }

  async onPairListDevices() {
    return [
      {
        name: 'Midea Airco (Infrared)',
        data: {
          id: `midea-ir-${Date.now()}`,
        },
      },
    ];
  }

}

module.exports = MideaInfraredDriver;
