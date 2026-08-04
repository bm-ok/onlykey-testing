/*
 * The firmware's own wipe paths.
 *
 * '0C' erases userspace and '9C' erases everything including the firmware hash,
 * which on real hardware forces the bootloader. Only '0C' is exercised here, so
 * this file runs unchanged against a physical key; '9C' is what the blank
 * fixture uses on hardware, behind an explicit confirmation.
 *
 * Neither is the addon's factoryReset(). That erases the backing store behind
 * the firmware's back, so none of the firmware's own bookkeeping happens and
 * nothing is printed; it sets an internal restart flag that no code anywhere
 * reads, so it never reboots; and it erases only from the first MAPPED byte
 * upward, which means on any host with a non-zero vm.mmap_min_addr the low
 * region of flash.bin survives the "factory reset" entirely.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('wipe', { state: 'initialized', requires: ['crypto'] }, () => {
  it('starts from a provisioned device', async ({ device, assert, signal }) => {
    const { state, raw } = await device.status({ signal });
    assert.equal(state, 'locked', `the fixture should restore a locked device, got ${raw}`);
  });

  it('takes a whole confirmed path in one line', async ({ device, assert, signal }) => {
    /*
     * The trailing 'C' is the confirmation, and the firmware only acts on a
     * complete path within one line - so no single stray byte can erase the
     * device and there is no arm/confirm handshake to sequence. A bare '0' is
     * therefore inert, which is what makes the wipe safe to have on this
     * channel at all.
     */
    device.log.clear();
    device.sendDebugLine('0');
    await device.log.waitFor(/I received from DEBUG: 48(?!\d)/, { signal });

    await device.sleep(500, { signal });
    const { state } = await device.status({ signal });
    assert.equal(state, 'locked', 'a bare 0 must not wipe anything');
  });

  it('erases userspace and reboots itself', async ({ device, assert, signal }) => {
    const before = device.generation;

    /* The wipe ends in CPU_RESTART(), so the acknowledgement is the next
     * generation booting - there is no completion print to wait for. */
    await device.wipe({ signal });
    assert.equal(device.generation, before + 1, 'the wipe should have rebooted the device');
  });

  it('comes back uninitialized', async ({ device, assert, signal }) => {
    const { state, raw } = await device.status({ signal });
    assert.equal(state, 'uninitialized', `after a userspace wipe, got ${raw}`);
  });

  it('no longer accepts the old PIN', async ({ device, assert, signal }) => {
    const { PINS } = require('../../lib/config');
    /*
     * A wiped device is unlocked-with-no-PIN-set, so there is nothing to unlock
     * INTO: the vendor interface never sends the model string. Waiting for one
     * and timing out is the assertion.
     */
    await assert.rejects(
      () => device.unlock(PINS.primary, { timeoutMs: 5000, signal }),
      /timed out/,
      'a wiped device answered a PIN entry as if it were still provisioned'
    );
  });
});
