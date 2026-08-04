/*
 * blank - a device that has never been set up.
 *
 * One definition, two consumers. On the emulator this is what an empty storage
 * directory boots into, so building the fixture is mostly a matter of checking
 * that assumption held. On hardware there is no such thing as an empty storage
 * directory, so the same module has to run the firmware's real wipe path - and
 * that is destructive enough to require saying so out loud.
 */
'use strict';

module.exports = {
  name: 'blank',
  description: 'never provisioned: no PINs, unlocked, nothing stored',

  /** @returns {Promise<boolean>} */
  async check(device) {
    const { state } = await device.status();
    return state === 'uninitialized';
  },

  async apply(device, { log, signal } = {}) {
    if (await module.exports.check(device)) {
      log && log('already blank');
      return;
    }

    /*
     * '0C', the USERSPACE wipe, never '9C'.
     *
     * Both return the device to uninitialized - measured on the emulator: a
     * provisioned device answers 'locked' before a '0C' and 'uninitialized'
     * after it - so the full wipe buys nothing here. What it costs is
     * everything: '9C' also erases the firmware hash, which on a physical key
     * forces the bootloader and needs a reflash to recover from. A fixture
     * that runs on every file is the last place that should be reachable.
     */
    log && log('wiping userspace (0C) and waiting for the reboot');
    await device.wipe({ full: false, signal });

    if (!(await module.exports.check(device))) {
      const { state, raw } = await device.status();
      throw new Error(`wipe finished but the device reports ${state} (${raw})`);
    }
  },
};
