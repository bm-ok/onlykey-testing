/*
 * config.js - the handful of constants the whole kit agrees on.
 */
'use strict';

const path = require('path');
const os = require('os');

/*
 * Test PINs. Buttons are 1-6, so digits are restricted to 1-6, and all three
 * must be distinct - the firmware chains primary -> secondary -> self-destruct
 * PIN entry as one continuous setup flow, and a repeat would commit the wrong
 * one somewhere in the middle without saying so.
 *
 * These are for the emulator and for disposable hardware. Nothing here should
 * ever be pointed at a key somebody uses.
 */
const PINS = {
  primary: '1111111',
  secondary: '2222222',
  selfDestruct: '6666666',
};

/*
 * The wait budgets.
 *
 * PER_TEST is a deadline, and it is deliberately not generous: everything in
 * section 1 is either an in-process round trip or a reboot, and a reboot
 * measures at ~2.2s including the firmware's own provisioning work.
 *
 * INACTIVITY is the interesting one - it is a no-progress budget, not a total
 * one. An operation that keeps making observable progress may take as long as
 * it needs; silence is what fails. That distinction is what lets it be short:
 * a total cap has to be sized for the slowest legitimate operation, whereas an
 * inactivity cap only has to be sized for the longest legitimate GAP, which
 * does not grow with payload size.
 */
const TIMEOUTS = {
  PER_TEST: 60_000,
  INACTIVITY: 30_000,
  RUN_MAX: 15 * 60_000,
  BOOT: 20_000,
};

/* Built fixtures are cached OUTSIDE the test tree, keyed by fingerprint. */
const CACHE_ROOT = process.env.OKT_CACHE_DIR ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'onlykey-testing');

/* The emulated device's storage files, and the only two sizes that are valid. */
const IMAGE_SIZES = {
  'flash.bin': 262144,
  'eeprom.bin': 2048,
};

module.exports = { PINS, TIMEOUTS, CACHE_ROOT, IMAGE_SIZES };
