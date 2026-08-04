/*
 * Out-of-box setup: the three PIN state machines.
 *
 * This is the flow the 'initialized' fixture is built with, run here as a
 * visible test rather than only as invisible setup - which is the same
 * reasoning as starting services from visible test files. When the fixture
 * build breaks, this file is what says which step broke and what the device
 * said about it.
 *
 * It calls the state module rather than reimplementing the flow, so there is
 * exactly one definition of how an OnlyKey gets provisioned.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const initialized = require('../../lib/fixtures/states/initialized');
const { okmsg } = require('../../lib/device');

describe('provisioning', { state: 'blank', requires: ['crypto'], timeoutMs: 120000 }, () => {
  it('starts uninitialized', async ({ device, assert, signal }) => {
    const { state, raw } = await device.status({ signal });
    assert.equal(state, 'uninitialized', `expected a blank device, got ${raw}`);
  });

  it('rejects a PIN shorter than seven digits', async ({ device, assert, signal }) => {
    device.log.clear();
    device.sendVendor({ msg: okmsg.MSG.OKPIN });          // arm
    await device.log.waitFor(/Enter PIN/, { signal });

    device.log.clear();
    device.pressLine([1, 1, 1]);
    await device.log.waitForCount(/password appended with/gi, 3, { signal });

    device.log.clear();
    device.sendVendor({ msg: okmsg.MSG.OKPIN });          // store
    const hit = await device.log.waitForAny({
      stored: /Storing PIN/,
      short: /Error PIN is not between 7 - 10 digits/,
    }, { signal });

    assert.equal(hit.key, 'short', 'the firmware accepted a three-digit PIN');
  });

  it('walks primary, secondary and self-destruct through to committed',
    async ({ device, assert, log, signal }) => {
      /*
       * Every step waits on the firmware's own print rather than on a sleep.
       * That is what makes the flow correct, not merely faster: the device
       * consumes injected digits at roughly 100ms each, and a fixed sleep let
       * the "store" message land mid-burst, whereupon the firmware saw a
       * five-digit PIN and the whole sequence ran to completion having
       * committed nothing.
       *
       * The device is mid-flow here from the rejected PIN above, and the
       * firmware's arm step resets the buffer, so this picks up cleanly.
       */
      await initialized.apply(device, { adapter: 'emulated', log, signal });

      const { state, raw } = await device.status({ signal });
      assert.equal(state, 'locked', `after setup and reboot, got ${raw}`);
    });

  it('unlocks with the PIN it was just given', async ({ device, assert, signal }) => {
    const model = await device.unlock(PINS.primary, { signal });
    assert.match(model, /^UNLOCKED/, 'the device did not report itself unlocked');
  });
});
