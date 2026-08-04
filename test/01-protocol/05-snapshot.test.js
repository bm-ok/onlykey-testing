/*
 * What a restored snapshot is, and what it is not.
 *
 * Snapshots are what remove the cross-contamination that forced the old kit to
 * be run one file at a time by hand: apply() runs once in a builder and every
 * file after that boots from a fresh copy of the images. The limits are worth
 * asserting rather than remembering, because each one has a failure mode that
 * looks like a firmware bug from the outside.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { describe, it } = require('../../lib/harness');
const { PINS, IMAGE_SIZES } = require('../../lib/config');

describe('snapshot restore', { state: 'initialized', requires: ['crypto'] }, () => {
  it('restores images of exactly the right size', async ({ device, assert }) => {
    /*
     * The loader validates size and nothing else, and on any mismatch - too
     * short or too long - it truncates the file to zero and rewrites the whole
     * thing with 0xFF. A half-copied snapshot does not come back
     * half-restored; it comes back as a factory-blank device, and the test that
     * then fails gets blamed on the firmware. Hence copy-to-temp, assert,
     * rename in the fixture code, and this check that it held.
     */
    for (const [name, expected] of Object.entries(IMAGE_SIZES)) {
      const size = fs.statSync(path.join(device.storageDir, name)).size;
      assert.equal(size, expected, `restored ${name} is the wrong size`);
    }
  });

  it('boots LOCKED, always', async ({ device, assert, signal }) => {
    /*
     * A snapshot always boots locked, and no fixture can change that: the
     * unlocked/initialized/configmode flags and the PIN hashes are RAM, rebuilt
     * in setup(). Snapshots skip provisioning, not unlocking - so every file
     * that needs an unlocked device still pays one PIN entry.
     */
    const { state, raw } = await device.status({ signal });
    assert.equal(state, 'locked', `a restored snapshot should boot locked, got ${raw}`);
  });

  it('carries the PINs it was built with', async ({ device, assert, signal }) => {
    const model = await device.unlock(PINS.primary, { signal });
    assert.match(model, /^UNLOCKED/, 'the snapshot did not carry its primary PIN');
  });

  it('relocks on the next boot', async ({ device, assert, signal }) => {
    await device.restart({ signal });
    const { state } = await device.status({ signal });
    assert.equal(state, 'locked', 'unlocking is RAM state and must not survive a reboot');
  });

  it('does not pretend to provide attestation', async ({ device, assert }) => {
    /*
     * Not a bug list entry - a capability. FSEC is not in flash.bin; it lives
     * in an anonymous peripheral mapping written fresh every boot, and what
     * gets written depends on whether the flash mapping landed at address zero.
     * It does not, on any host configured the way this project recommends, so
     * FSEC latches to the already-provisioned value, the one-time provisioning
     * branch never runs, and there is no factory key derivation, no firmware
     * hash written to EEPROM and no security lock bits.
     */
    assert.ok(!device.capabilities.has('attestation'),
      'emulated mode must never claim attestation');
    assert.match(device.capabilities.why('attestation'), /provisioning branch/);
  });
});
