/*
 * PARKED - DO NOT ADD TO test/03-gui/ UNTIL THE DECRYPT STEP IS FIXED.
 *
 * Not because of where it lives: the require depth and the `13-` number are
 * already correct for test/03-gui/, and moving it there is all it takes to make
 * the runner load it. That was tried and it works. It is parked because of what
 * happens next.
 *
 * WHERE IT GETS TO, run as `03-gui/10-session 03-gui/13-pgp-pqc 03-gui/19-stop`
 * (it needs 10-session; alone it fails with "no GUI session is running"):
 *
 *   10 pass - unlock, open page, generate in the browser, load the displayed
 *             hex with `onlykey-cli setpqc`, encrypt host-side
 *    1 fail - "decrypts it through the device"
 *
 * THE FAILURE, and it is not yet diagnosed:
 *
 *   Page status: "ERROR: Error decrypting message: Key Data Integrity failed"
 *   Page console: USER_ACTION_PENDING, USER_ACTION_PENDING, CTAP1_SUCCESS
 *   Harness:      3x /Received Message/ still pending after 37s
 *
 * A composite decryption needs TWO device operations - X25519 then ML-KEM-768 -
 * each with its own three-button confirmation. Only one completed, and the
 * device then stopped announcing received packets, so the second half never
 * produced a key share and the AES key unwrap failed. Whether that is the test
 * failing to drive the second confirmation, or the page failing to raise it, is
 * exactly the open question.
 *
 * WHAT IT IS NOT: evidence that composite decryption is broken. The identical
 * operation - one openpgp.decrypt() driving both halves through the same
 * WebAuthn bridge and the same hardware hooks - passes at the library tier in
 * 02-cli/06-composite-ops ("decrypts a real PGP message, which asks the device
 * twice"). The page was served the current bundle, not a stale one: index.js
 * serves ./docs, and docs/ holds one bundle carrying the conformant codepoints.
 * So this is a PAGE-TIER question, and the page tier has never had coverage -
 * which is the whole reason this file exists.
 *
 * It hangs rather than fails fast (the run ends on the inactivity watchdog,
 * exit 3, ~146s), so dropping it into the section would cost every future run
 * that time and end it on a watchdog. Hence parked rather than merely red.
 *
 * NEXT STEP for whoever picks this up: instrument which of the two halves is
 * missing before touching anything. lib/pqc.js's confirmFromConsole() answers
 * every challenge it observes, so start by checking whether the second
 * challenge is ever raised on the console at all.
 *
 * ---------------------------------------------------------------------------
 *
 * Section 3, browser tier: the pgp-pqc page - TC-11 the way a person does it.
 *
 * This page is unusual among the app's screens in that it cannot finish its own
 * job. It generates a composite key and then tells you, in its own status text,
 * to run `onlykey-cli setpqc <slot> <blob hex>` - because OKSETPRIV is not
 * reachable over the browser's WebAuthn transport at all. So the workflow spans
 * two clients by design, and this test follows it exactly: the PAGE generates,
 * the CLI loads what the page displayed, and the PAGE then uses the key.
 *
 * Everything it does is already proven elsewhere - 06-composite-key for the
 * generation, 05-composite-load for the load, 06-composite-ops for the device
 * calls through the library - so what is left here, again, is whether the page
 * joins them up.
 *
 * THE CHALLENGE IS READ, NOT PREDICTED. Every other file computes the three
 * buttons from a payload it chose itself. It cannot here: an openpgp signature
 * is over subpackets the page assembles, so the digest is not knowable from
 * outside without reimplementing the thing under test. lib/pqc.js's
 * confirmFromConsole() reads the packet the device says it hashed and derives
 * the digits from that - simpler, and honest about which side is the authority.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');
const session = require('../../lib/gui-session-holder');

const RP_ID = 'localhost';
const PAGE = `http://${RP_ID}:3000/app/pgp-pqc`;

const SLOT_ID = 1;
const SLOT_NAME = 'RSA1';
const EMAIL = 'kit@example.com';
const MESSAGE = 'composite, through the page';

describe('the pgp-pqc page', {
  state: 'initialized',
  requires: ['crypto', 'client-access', 'display', 'nwjs', 'webapp-lib'],
  timeoutMs: 300000,
}, () => {
  let page = null;

  const val = (id) => page.eval(`document.querySelector(${JSON.stringify(`#${id}`)}).value`);
  const text = (id) => page.eval(`document.querySelector(${JSON.stringify(`#${id}`)}).textContent`);

  const setVal = (id, value) => page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(`#${id}`)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  const click = (id) => page.eval(`(document.querySelector(${JSON.stringify(`#${id}`)}).click(), true)`);

  it('unlocks the device before anything opens a page',
    async ({ device, assert, signal }) => {
      const model = await device.unlock(PINS.primary, { signal });
      assert.match(model, /^UNLOCKED/, 'the device is not unlocked');
    });

  it('opens the page', async ({ assert, log }) => {
    page = await session.get().open(PAGE, { timeoutMs: 60000 });
    await page.waitFor('!!document.querySelector("#pgp_generate")', { timeoutMs: 60000 });
    log(`opened ${await page.eval('location.href')}`);

    for (const id of ['pgp_slot', 'pgp_user_email', 'pgp_public_key', 'pgp_blob_hex',
      'pgp_plaintext', 'pgp_encrypt', 'pgp_ciphertext_out', 'pgp_decrypt',
      'pgp_plaintext_out', 'pgp_sign', 'pgp_signature_out']) {
      assert.ok(await page.eval(`!!document.querySelector("#${id}")`), `no #${id}`);
    }
  });

  it('generates a composite key in the browser', async ({ assert, log }) => {
    page.console.length = 0;

    await setVal('pgp_user_email', EMAIL);
    await setVal('pgp_slot', String(SLOT_ID));
    await click('pgp_generate');

    await page.waitFor('document.querySelector("#pgp_blob_hex").value.length > 0',
      { timeoutMs: 120000 }).catch(() => {
      throw new Error(`the page generated nothing. Its console: ${
        JSON.stringify(page.console.slice(-8))}`);
    });

    const armored = await val('pgp_public_key');
    const hex = await val('pgp_blob_hex');
    log(`page status: ${(await text('pgp_generate_status')).slice(0, 90)}`);

    assert.ok(armored.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), 'no armored key');
    assert.match(hex, /^[0-9a-f]{320}$/, `not a 160-byte blob: ${hex.slice(0, 40)}…`);
  });

  it('loads what the page displayed, with the CLI it told us to use',
    async ({ device, assert, signal }) => {
      /*
       * The page's own instruction, followed literally. This is the seam the
       * feature actually has - a browser that cannot reach OKSETPRIV handing a
       * hex string to a command line that can - and testing it any other way
       * would be testing a workflow nobody has.
       */
      const hex = await val('pgp_blob_hex');

      await device.enterConfigMode(PINS.primary, { signal });
      const result = await cli.run('onlykey-cli',
        ['setpqc', SLOT_NAME, hex], { timeoutMs: 60000, signal });

      assert.equal(result.code, 0, `setpqc failed: ${result.stderr || result.stdout}`);

      /* Out of config mode, which does not accept OKSIGN or OKDECRYPT. */
      await device.restart({ signal });
      await device.unlock(PINS.primary, { signal });
    });

  it('encrypts to its own public key, with no device involved',
    async ({ assert }) => {
      /* Host-only, like every PGP encryption - worth asserting rather than
       * assuming, since it is why this half never asks for a button. */
      page.console.length = 0;

      await setVal('pgp_plaintext', MESSAGE);
      await click('pgp_encrypt');

      await page.waitFor('document.querySelector("#pgp_ciphertext_out").value.length > 0',
        { timeoutMs: 60000 }).catch(() => {
        throw new Error(`the page encrypted nothing. Its console: ${
          JSON.stringify(page.console.slice(-8))}`);
      });

      const armored = await val('pgp_ciphertext_out');
      assert.ok(armored.startsWith('-----BEGIN PGP MESSAGE-----'),
        `not an armored PGP message: ${armored.slice(0, 80)}`);
    });

  it('decrypts it through the device', async ({ device, assert, signal, log }) => {
    /*
     * The device's half of a composite decryption, driven by the page and
     * confirmed by the kit reading the challenge off the console. The page has
     * to reload its hooks against the loaded slot first, which is what its own
     * decrypt handler does.
     */
    page.console.length = 0;

    const ciphertext = await val('pgp_ciphertext_out');
    await setVal('pgp_ciphertext_in', ciphertext);

    await pqc.confirmFromConsole(device, async () => {
      await click('pgp_decrypt');
      await page.waitFor('document.querySelector("#pgp_plaintext_out").value.length > 0',
        { timeoutMs: 120000 });
    }, { signal, primeMs: 90000 }).catch(async (err) => {
      throw new Error(`${err.message}. Page status: ${
        JSON.stringify(await text('pgp_decrypt_status'))}. Console: ${
        JSON.stringify(page.console.slice(-10))}`);
    });

    const out = await val('pgp_plaintext_out');
    log(`page recovered ${JSON.stringify(out.slice(0, 40))}`);
    assert.equal(out, MESSAGE, 'the page did not recover the plaintext');
  });

  it('signs through the device, and verifies its own signature',
    async ({ device, assert, signal }) => {
      /*
       * Signing routes through composite_sign, so it raises its own challenge.
       * Verification is the page's job too - it has the public key it made -
       * which makes this one assertion cover both directions of the hook.
       */
      page.console.length = 0;

      await setVal('pgp_sign_plaintext', MESSAGE);

      await pqc.confirmFromConsole(device, async () => {
        await click('pgp_sign');
        await page.waitFor('document.querySelector("#pgp_signature_out").value.length > 0',
          { timeoutMs: 120000 });
      }, { signal, primeMs: 90000 }).catch((err) => {
        throw new Error(`${err.message}. The page's console: ${
          JSON.stringify(page.console.slice(-10))}`);
      });

      const signature = await val('pgp_signature_out');
      assert.ok(signature.startsWith('-----BEGIN PGP'),
        `not an armored signature: ${signature.slice(0, 80)}`);

      await setVal('pgp_verify_in', signature);
      await click('pgp_verify');
      await page.waitFor('document.querySelector("#pgp_verify_status").textContent.length > 0',
        { timeoutMs: 60000 });

      const status = await text('pgp_verify_status');
      assert.ok(!/^ERROR/i.test(status), `the page could not verify: ${status.slice(0, 160)}`);
    });

  it('closes its window', async ({ assert }) => {
    page.close();
    page = null;
    assert.ok(true, 'window closed');
  });
});
