'use strict';

import Homey from 'homey';

class MideaApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('App has been initialized');
  }

}

module.exports = MideaApp;
