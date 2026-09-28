/*
 * Section 3, headless: derived X-Wing, end to end, with a device - the
 * DEVICE-CUSTODY model of firmware 3.0.5 / 3.1.0 and web app 4.0.0.
 *
 * The derived path: nothing stored, the key reproduced on demand from the
 * web-and-agent derivation key and a label - what the web app's age-derive page
 * uses. Firmware 8868553 ("spec keygen from HKDF seed; no private material")
 * moved the WHOLE X-Wing key into the device: a public-key request returns the
 * 1216-byte recipient [pk_M | pk_X], and decapsulation is a chunked OKDECRYPT
 * of the full 1120-byte ciphertext that returns the finished 32-byte secret.
 *
 * This file used to test the SPLIT-custody model that came before - the device
 * returned pk_X and an ML-KEM seed, the host rebuilt the recipient and finished
 * decapsulation from ss_X - and web app 4.0.0 changed its API to match the
 * firmware: derive_xwing_recipient(label, cb) and
 * derive_xwing_decap(label, ciphertext, cb), no press flag. Called the old way,
 * the press flag landed in the callback's place and the test hung (audit #7,
 * 2026-09-28).
 *
 * The round trip is still the point, and every step is a different party:
 *
 *   1. the DEVICE derives the recipient for a label
 *   2. a SENDER encapsulates to it - no device involved at all
 *   3. the DEVICE decapsulates the ciphertext and must land on the sender's secret
 *
 * If 3 agrees, the firmware, the web app and the sender's X-Wing are
 * consistent - the one thing that otherwise only surfaces as "no identity
 * matched any of the recipients". No private material leaves the device, so
 * the last test checks the secret is bound to the label.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { IFACE, okmsg } = require('../../lib/device');
const ours = require('../../lib/age-pqc');
const webenv = require('../../lib/webenv');

/* See 02-derive: the device refuses a touch-free derivation without this, and
 * says so as CTAP2_ERR_EXTENSION_NOT_SUPPORTED. */
/*
 * Field 30: the WEB AND AGENT derivation mode (okcore.cpp case 30) - the one
 * that governs a derive arriving over the FIDO2 tunnel. It was 21 here - the
 * STORED-derived challenge mode - while the comment below already said 30.
 * Field 21 refuses 2 (no press) unless the build defines OK_ALLOW_NO_PRESS, so
 * every run read "unsupported user input mode" as "this build cannot derive
 * without a touch" and skipped - leaving the key in CONFIG MODE, where
 * OKCONNECT is not on the allow-list, so every derive after it got no data
 * (audit #7, 2026-09-28). Field 30 has no such guard: 2 is always settable.
 */
const FIELD_DERIVED_KEY_MODE = 30;
/*
 * USER_INPUT_NONE, not a bit.
 *
 * This was 8 - "bit 3" - which is the LEGACY field-21 bitfield encoding. Field
 * 30 is an enum: 0 = challenge code, 1 = button press (the default), 2 = no
 * press. set_slot() refuses anything above USER_INPUT_NONE, so 8 came back as
 * "Error invalid user input mode" and read as a firmware fault. Splitting the
 * enum out of the bitfield is exactly what field 30 exists for (okcore.h), and
 * four files in this section still spoke the old encoding.
 */
const DERIVE_WITHOUT_TOUCH = 2;   // USER_INPUT_NONE

const LABEL = 'age:personal';

describe('derived X-Wing, through the web app\'s library', {
  state: 'initialized',
  requires: ['crypto', 'xwing-math', 'webapp-lib'],
  timeoutMs: 90000,
}, () => {
  let third = null;

  const verbose = () => (process.env.OKT_WEBLIB_VERBOSE === 'yes' ? console : undefined);

  /* Web app 4.0.0's shape: no press flag, and each always calls back - both
   * wrap themselves in try/catch - so a plain promise is honest here. */
  const recipientFor = (label) => new Promise((resolve, reject) => {
    third.derive_xwing_recipient(label, (err, recipient) => (
      err ? reject(new Error(String(err))) : resolve(Buffer.from(recipient))
    ));
  });

  const decapFor = (label, ciphertext) => new Promise((resolve, reject) => {
    third.derive_xwing_decap(label, ciphertext, (err, ss) => (
      err ? reject(new Error(String(err))) : resolve(Buffer.from(ss))
    ));
  });

  it('allows derivation without a touch', async ({ device, assert, signal, skip }) => {
    await device.unlock(PINS.primary, { signal });
    await device.enterConfigMode(PINS.primary, { signal });

    const since = device.mark(IFACE.VENDOR);
    device.sendVendor({
      msg: okmsg.MSG.OKSETSLOT,
      slot: 1,
      field: FIELD_DERIVED_KEY_MODE,
      payload: Buffer.from([DERIVE_WITHOUT_TOUCH]),
    });

    const reply = await device.waitHid(IFACE.VENDOR,
      { since, match: /Successfully set|Error/, timeoutMs: 5000, signal });
    if (/unsupported user input mode/.test(okmsg.text(reply))) {
      /* Out of config mode FIRST, as in 02: skip() ends this test. */
      await device.restart({ signal });
      await device.unlock(PINS.primary, { signal });
      skip('this build has OK_ALLOW_NO_PRESS off, so user-input mode 2 (no press) ' +
        'is refused by design - onlykey.h ships it commented out and a stale 2 in ' +
        'EEPROM fails closed to challenge code');
    }
    assert.ok(!/Error/.test(okmsg.text(reply)),
      `setting the derived-key mode failed: ${okmsg.text(reply)}`);

    await device.restart({ signal });
    await device.unlock(PINS.primary, { signal });
  });

  it('builds the third-party api', async ({ device, assert, signal }) => {
    /* Its own step, after the reboot above: built inside the setting test, a
     * skip there left `third` null and every test below failed on it. */
    const imports = webenv.create(device, { signal, console: verbose() });
    const api = webenv.load(imports, 'onlykey-api.js');
    third = webenv.load(imports, 'onlykey-3rd-party.js', api)();
    assert.ok(typeof third.derive_xwing_recipient === 'function', 'no derive_xwing_recipient');
  });

  it('derives a recipient for a label', async ({ assert, log }) => {
    const recipient = await recipientFor(LABEL);
    log(`recipient ${recipient.toString('hex').slice(0, 24)}…`);
    assert.equal(recipient.length, ours.XWING_PK, 'an X-Wing recipient is 1216 bytes');
    assert.notEqual(Buffer.compare(recipient, Buffer.alloc(ours.XWING_PK)), 0,
      'the device returned an all-zero recipient');
  });

  it('derives the same recipient for the same label, and a different one for another',
    async ({ assert }) => {
      /*
       * The whole premise of the derived path: nothing is stored, so an
       * identity is only usable because the same label reproduces it. And two
       * labels must not collide, or every "separate" identity would be one.
       */
      const first = await recipientFor(LABEL);
      const again = await recipientFor(LABEL);
      assert.bytes(again, first, 'the recipient for the same label');
      const other = await recipientFor('work');
      assert.notEqual(Buffer.compare(other, first), 0, 'two labels derived the same recipient');
    });

  it('completes a device-custody round trip', async ({ assert, log }) => {
    /* The sender encapsulates with no device present; the device alone
     * decapsulates. The host never holds a secret key. */
    const recipient = await recipientFor(LABEL);
    const { sharedSecret, ciphertext } = ours.xwingEncapsHost(recipient);
    assert.equal(ciphertext.length, ours.XWING_CT, 'the ciphertext is 1120 bytes');

    const ss = await decapFor(LABEL, Buffer.from(ciphertext));
    log(`ss ${ss.toString('hex').slice(0, 24)}…`);
    assert.equal(ss.length, 32, 'an X-Wing shared secret is 32 bytes');
    assert.bytes(ss, Buffer.from(sharedSecret), "the device did not recover the sender's secret");
  });

  it("the web app's own X-Wing reaches the same secret", async ({ assert }) => {
    /* The sender is the library the browser actually runs this time - checked
     * against python's fixed vector in 01-age-pqc-parity, against the device here. */
    const lib = webenv.loadPlain('age_pqc.js');
    const recipient = await recipientFor(LABEL);
    const { sharedSecret, ciphertext } = lib.xwingEncapsHost(recipient);
    const ss = await decapFor(LABEL, Buffer.from(ciphertext));
    assert.bytes(ss, Buffer.from(sharedSecret), "the device could not open the web app's encapsulation");
  });

  it('binds the secret to the label', async ({ assert }) => {
    /*
     * The security claim, as a test: the key is the device's and the label's.
     * A ciphertext made for one label, opened under another, must not give the
     * sender's secret - otherwise one derived identity would open another's mail.
     */
    const recipient = await recipientFor(LABEL);
    const { sharedSecret, ciphertext } = ours.xwingEncapsHost(recipient);
    const wrong = await decapFor('work', Buffer.from(ciphertext));
    assert.notEqual(Buffer.compare(wrong, Buffer.from(sharedSecret)), 0,
      'a different label opened the ciphertext');
  });
});
