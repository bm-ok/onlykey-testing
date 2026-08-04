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

  async apply(device, { adapter, log } = {}) {
    if (await module.exports.check(device)) {
      log && log('already blank');
      return;
    }

    /*
     * '9C' is the full wipe - it also erases the firmware hash, which on real
     * hardware forces the bootloader and needs a reflash to recover from. On
     * the emulator that is a file being erased; on a physical key it is an
     * afternoon. So hardware has to opt in explicitly.
     */
    if (adapter !== 'emulated' && process.env.OKT_CONFIRM_DESTRUCTIVE !== 'yes') {
      throw new Error(
        'refusing to wipe physical hardware without OKT_CONFIRM_DESTRUCTIVE=yes: ' +
        'the full wipe erases the firmware hash and forces the bootloader'
      );
    }

    log && log('wiping (9C) and waiting for the reboot');
    await device.wipe({ full: true });

    if (!(await module.exports.check(device))) {
      const { state, raw } = await device.status();
      throw new Error(`wipe finished but the device reports ${state} (${raw})`);
    }
  },
};
