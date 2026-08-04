/*
 * PIN entry.
 *
 * The one operation every other unlocked-device test depends on, and the one
 * with the most host-side ways to get it wrong. The digits go out as a single
 * line because the firmware paces the replay itself; the answer comes back on
 * the vendor interface rather than the debug console because "UNLOCKED, NO PIN
 * SET" - what an UNPROVISIONED device prints at boot - also matches /UNLOCKED/,
 * and a status check that cannot tell those apart reports a blank device as an
 * unlocked one.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { IFACE } = require('../../lib/device');

describe('unlock', { state: 'initialized', requires: ['crypto'] }, () => {
  it('acknowledges every digit up to the one that completes the PIN',
    async ({ device, assert, signal }) => {
      device.log.clear();
      device.pressLine(PINS.primary.split(''));

      /*
       * Six acknowledgements for a seven-digit PIN, and that is correct.
       *
       * The firmware prints "password appended with <n>" from the branch it
       * takes when the guess does NOT yet match a stored hash. The seventh
       * digit completes the PIN, profile1hashevaluate() succeeds, and that
       * branch is never reached - the device prints "GUESSED PROFILE 1 PIN"
       * instead. Expecting one ack per digit times out on a PIN entry that
       * worked perfectly, which is a fine way to spend fifteen seconds proving
       * nothing.
       *
       * Counted rather than first-matched: the acks come one per BYTE, so a
       * first-match wait returns while six digits are still in flight.
       */
      const expected = PINS.primary.length - 1;
      const seen = await device.log.waitForCount(/password appended with/gi, expected,
        { timeoutMs: 15000, signal });
      assert.ok(seen >= expected, `saw ${seen} digit acknowledgements, wanted ${expected}`);

      await device.log.waitFor(/GUESSED PROFILE 1 PIN/, { timeoutMs: 15000, signal });
    });

  it('unlocks once the whole PIN has landed', async ({ device, assert, signal }) => {
    /*
     * profile1hashevaluate() runs a Curve25519 + SHA256 computation on every
     * digit once the guess reaches seven, and the digits arrive in one burst -
     * so the gap between the last digit and the device saying "unlocked" is
     * real work, not latency.
     */
    const model = await device.waitHid(IFACE.VENDOR, { match: /^UNLOCKED/, timeoutMs: 30000, signal });
    assert.ok(model, 'the device never reported itself unlocked');

    const { state } = await device.status({ signal });
    assert.equal(state, 'unlocked');
  });

  it('relocks on reboot and refuses a wrong PIN', async ({ device, assert, signal }) => {
    await device.restart({ signal });
    assert.equal((await device.status({ signal })).state, 'locked');

    /*
     * One wrong attempt only. Failed logins accumulate on the device and enough
     * of them wipe it - this is a test of the refusal, not of the lockout, and
     * the two need very different care.
     */
    const wrong = '1111112';
    assert.notEqual(wrong, PINS.primary, 'the wrong PIN must actually be wrong');
    assert.notEqual(wrong, PINS.secondary, 'must not be the second profile PIN');
    assert.notEqual(wrong, PINS.selfDestruct, 'must never be the self-destruct PIN');

    await assert.rejects(
      () => device.unlock(wrong, { timeoutMs: 8000, signal }),
      /timed out/,
      'the device unlocked with the wrong PIN'
    );

    assert.equal((await device.status({ signal })).state, 'locked',
      'still locked after a rejected PIN');
  });

  it('needs a reset before the right PIN works again', async ({ device, assert, signal }) => {
    /*
     * A rejected attempt does not clear the guess.
     *
     * The firmware appends every press to one buffer and only resets it once
     * ten keys have been entered (payload()'s `pass_keypress < 10` branch). So
     * after seven wrong digits the buffer still holds seven, and entering the
     * correct seven simply makes it fourteen - which matches nothing, forever.
     * Measured as a thirty-second timeout on a PIN that was perfectly correct.
     *
     * A reboot is the clean reset, and it is what a person does. Anything that
     * retries a PIN without one is testing a state it did not mean to be in.
     */
    await device.restart({ signal });
    assert.equal((await device.status({ signal })).state, 'locked');

    const model = await device.unlock(PINS.primary, { signal });
    assert.match(model, /^UNLOCKED/);
  });
});
