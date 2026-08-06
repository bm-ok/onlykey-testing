/*
 * Section 3, browser tier: /app/encrypt and /app/decrypt, in a real Chromium,
 * against a real device over the USB gadget.
 *
 * The pages no kit has ever driven. `03-gui/08-pgp-encrypt-decrypt` proved the
 * library underneath them - all five of `_$mode()`'s modes, checked against
 * openpgp.js - so anything that fails HERE is the page: the ids, the mode
 * radio, the tokenizer, the click handler, the WebAuthn origin. That is the
 * whole argument for two tiers and it only pays off if both exist.
 *
 * Numbered 14 rather than 13 because 13 is reserved for `pgp-pqc`, which every
 * document already calls `13-pgp-pqc` and whose working copy is in `wip/`.
 *
 * WHAT THE PAGES DO WITH THEIR FIELDS, since none of it is guessable and two of
 * the four cost real time to work out:
 *
 *   encrypt  #pgpkeyurl   recipients. NOT a plain input - jquery.tokenizer.js
 *                         replaces it with a contenteditable span and hides the
 *                         real one, then writes `escape(value)` into it. That
 *                         is why startEncryption has a `slice(0,11) ==
 *                         '-----BEGIN%'` branch: an armored key arrives
 *                         URL-ESCAPED, which is also the only way one fits,
 *                         since an <input> strips newlines from .value.
 *            #pgpkeyurl2  the signer - your own public key. A textarea.
 *            #message     the message in, and the armored result back OUT.
 *   decrypt  #pgpkeyurl   the sender, for verification. A textarea here.
 *            #pgpkeyurl2  yours. #message again carries both directions.
 *
 * The mode is read off the `#action` radio during `page.setup()`, and each
 * radio has a `change` listener that re-runs setup - so setting `.checked` and
 * dispatching `change` is how a mode gets selected, and there is no other way
 * in from outside: `page.okpgp` lives in the plugin's closure and is not
 * published on `window` the way pgp-pqc's test hooks are.
 *
 * THE CHALLENGE IS ANSWERED BY THE KIT, not by the page. Every mode but Encrypt
 * Only raises a three-digit confirmation, and the page's only account of it is
 * the button text. `pqc.confirmFromConsole()` reads the packet the device says
 * it hashed and presses the digits, which works regardless of who is driving -
 * it watches the device, not the caller.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE, exactly as in 11-password-generator: the
 * device is unlocked and the keys are loaded BEFORE any page opens. A page
 * loaded against a locked device times out its startup OKCONNECT, and Chromium
 * then raises a native WebAuthn dialog that no CDP command can dismiss - which
 * wedges the session, not just this file.
 *
 * NOT `--isolate`-able, BY DESIGN and not as debt - the same class as
 * 10-session, 11 and 12. This file needs the browser and the web app that
 * `10-session` started and `19-stop` stops, so running it alone would orphan
 * both. The coupling is kept to the minimum the tier allows: one leading test
 * establishes the device, every later test opens and closes its OWN page, and
 * nothing is shared but the keys.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const webenv = require('../../lib/webenv');
const pqc = require('../../lib/pqc');
const session = require('../../lib/gui-session-holder');
const { pgpRsaKey, loadSlots } = require('../../lib/pgp-rsa');

/*
 * localhost, NOT 127.0.0.1 - see 11-password-generator for the full argument.
 * WebAuthn refuses an IP as a relying-party id, the page swallows the error,
 * and the only symptom is an output box that never fills.
 *
 * Unlike the derive pages, the RPID does not change the ANSWER here: these
 * operations use STORED keys in RSA slots 1 and 2, and okcrypto_hkdf()'s use of
 * the RPID only reaches the derived paths. So this has to be localhost for
 * WebAuthn to work at all, and no cross-check has to match it.
 */
const ORIGIN = 'http://localhost:3000';
const ENCRYPT = `${ORIGIN}/app/encrypt`;
const DECRYPT = `${ORIGIN}/app/decrypt`;

const USER = { name: 'Kit', email: 'kit@example.com' };
const SENDER = { name: 'Sender', email: 'sender@example.com' };

const PLAINTEXT = 'the pages that no kit has driven, in a browser this time';

/* done_process_packets()'s end-of-priming print. */
const PRIMED = /Encrypted Buffer/g;

describe('the encrypt and decrypt pages', {
  state: 'initialized',
  requires: ['crypto', 'client-access', 'display', 'nwjs', 'webapp-lib'],
  timeoutMs: 300000,
}, () => {
  let mine = null;         // the key the device holds both halves of
  let correspondent = null; // a second key, entirely host-side
  let openpgp = null;

  /**
   * Open a page, and do not hand it back until it has finished talking to the
   * device.
   *
   * WAITING FOR THE HANDSHAKE IS NOT OPTIONAL AND COST A RUN. Every app page
   * starts an OKCONNECT as it loads. Chromium allows **one WebAuthn request at a
   * time per browser**, not per tab - so a page closed while its startup
   * handshake is still outstanding poisons the NEXT one, which dies inside
   * Chromium with `OperationError: A request is already pending.` The page
   * swallows that, its output box never fills, and what a test sees is a device
   * that was never contacted at all.
   *
   * `#header_messages` is the page's own report that the handshake landed -
   * onlykey-api.js writes "Secure Connection Established" into it with the
   * firmware version - so this is both the wait and an assertion that the page
   * reached the device before anything asked it to do work.
   */
  async function openPage(url, log) {
    const page = await session.get().open(url, { timeoutMs: 60000 });
    /* The app renders after its scripts run, so the fields are what to wait
     * for - the load event fires long before any of this exists. */
    await page.waitFor('!!document.querySelector("#onlykey_start")', { timeoutMs: 60000 });
    await page.waitFor('!!document.querySelector("#message")', { timeoutMs: 60000 });
    await page.waitFor(
      '/Secure Connection Established/.test(document.querySelector("#header_messages").textContent)',
      { timeoutMs: 60000 }
    ).catch(() => {
      throw new Error(`${url} never completed its startup OKCONNECT; its console: ` +
        `${JSON.stringify(page.console.slice(-8))}`);
    });
    log(`opened ${await page.eval('location.href')}, handshake complete`);
    return page;
  }

  /**
   * Pick a mode by its radio, the way a person does.
   *
   * Each radio has a `change` listener that re-runs `page.setup()`, which is
   * what re-reads `_$mode()` from `$("#action")[0].select_one.value`. Setting
   * `.checked` alone changes the dot and nothing else.
   */
  async function selectMode(page, radioId, expected) {
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(`#${radioId}`)});
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    /* The button's label is the page's own account of which mode it is in, and
     * it is set by setup() from the mode rather than from the radio - so this
     * checks the mode took rather than that the click landed. */
    await page.waitFor(
      `document.querySelector("#onlykey_start").textContent.trim() === ${JSON.stringify(expected)}`,
      { timeoutMs: 15000 }
    );
  }

  /** The recipients field, through the tokenizer that owns it. */
  async function setRecipients(page, armored) {
    /*
     * `.add()` on the tokenizer instance rather than typing into the
     * contenteditable, because it is the same call the widget makes on blur and
     * it ends in `updateFormInput()`, which is what escape()s the value into the
     * hidden #pgpkeyurl. Setting #pgpkeyurl.value directly would skip the
     * escaping and hand startEncryption a key it cannot parse - and setting the
     * contenteditable's text would need the newlines to survive as <div>s.
     */
    /* `window.jQuery`, NOT `window.$`: app.js assigns only the former
     * (`window.jQuery = $`), and the plugin system hands `$` around as a
     * dependency rather than a global. Reaching for `$` here is a TypeError
     * inside the page, which arrives as an unhelpful "page threw". */
    await page.eval(`(() => {
      const t = window.jQuery("#pgpkeyurl").data("tokenizer");
      if (!t) throw new Error("the recipients field has no tokenizer");
      t.add(${JSON.stringify(armored)});
      return document.querySelector("#pgpkeyurl").value.length;
    })()`);
  }

  const setField = (page, id, value) => page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(`#${id}`)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value.length;
  })()`);

  /**
   * Click the button and wait for #message to become something else.
   *
   * Both pages write their result back into the SAME textarea the input came
   * from, so "it worked" is "the box changed", not "the box is non-empty". The
   * page swallows its errors onto the button text, which is why the failure
   * path reads that and the console rather than saying "timed out".
   */
  async function runPage(page, { was, timeoutMs = 120000 }) {
    page.console.length = 0;
    await page.eval('document.querySelector("#onlykey_start").click(); true');

    await page.waitFor(
      `document.querySelector("#message").value !== ${JSON.stringify(was)}`,
      { timeoutMs }
    ).catch(async () => {
      const button = await page.eval('document.querySelector("#onlykey_start").textContent');
      throw new Error(
        `the page produced nothing. Its button says ${JSON.stringify(button)}; ` +
        `its console: ${JSON.stringify(page.console.slice(-8))}`
      );
    });

    return page.eval('document.querySelector("#message").value');
  }

  it('unlocks the device and loads the RSA slots before any page opens',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: vendor, for the key and both moduli. A visible step, and
       * deliberately the first: what it prevents is not a failed test but a
       * wedged session - see the header.
       *
       * BOTH halves in one load, unlike 08, which loads one per test. There is
       * no cheaper option here: each page test would otherwise pay a config-mode
       * round trip on top of a browser, and the tier is not isolatable anyway.
       */
      openpgp = webenv.openpgp();
      mine = await pgpRsaKey(openpgp, [USER]);
      correspondent = await pgpRsaKey(openpgp, [SENDER]);

      await loadSlots(device, mine, ['sign', 'decrypt'], { signal, assert, log });

      const status = await device.status({ signal });
      assert.equal(status.state, 'unlocked',
        `the device must be unlocked before a page opens, not ${status.state}`);
    });

  it('Encrypt Only encrypts in the browser without asking the device to do anything',
    async ({ device, assert, log }) => {
      /*
       * SURFACE: none for the OPERATION, and that distinction is sharper here
       * than it is headless. 08's version of this test genuinely reaches no
       * device; in a browser the PAGE always does, because every app page starts
       * an OKCONNECT as it loads. So the claim is not "nothing plugged in" - it
       * is that the encryption itself never asks the device for anything, which
       * is what makes Encrypt Only the cheapest "did we break encrypt" check.
       * The assertion is on confirmations primed, not on device silence, and it
       * says so rather than overclaiming.
       *
       * It is also the one that proves the tokenizer path, because the recipient
       * key has to survive being escape()d into a hidden input and unescape()d
       * back inside startEncryption. If that round trip were broken this would
       * fail as "no armored key", which no other mode would catch.
       */
      const primed = device.log.count(PRIMED);
      const page = await openPage(ENCRYPT, log);
      try {
        await selectMode(page, 'encrypt_only', 'Encrypt');
        await setRecipients(page, correspondent.armored);
        await setField(page, 'message', PLAINTEXT);

        const armored = await runPage(page, { was: PLAINTEXT });
        log(`${String(armored).length} characters back in the message box`);
        assert.match(String(armored), /^-----BEGIN PGP MESSAGE-----/,
          'the encrypt page did not put an armored message in the box');

        /* The oracle: the correspondent opens it with the private half, and
         * nothing in that path has ever seen this browser or this device. */
        const opened = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: String(armored) }),
          decryptionKeys: correspondent.privateKey,
        });
        assert.equal(opened.data, PLAINTEXT,
          'the recipient recovered something other than what was typed');

        assert.equal(device.log.count(PRIMED), primed,
          'Encrypt Only primed a confirmation on the device - the page startup may talk to ' +
          'it, but this MODE must never ask it to sign or decrypt anything');
      } finally {
        page.close();
      }
    });

  it('Sign Only signs through the browser, on the RSA key in slot 2',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO through Chromium's own WebAuthn stack over the USB gadget,
       * console for the press window. THE test this file exists for: every byte
       * of the operation goes the way it would for somebody at
       * onlykey.github.io, and the signature is verified by openpgp.js against
       * the public half of the key whose factors are in slot 2.
       */
      const page = await openPage(ENCRYPT, log);
      try {
        await selectMode(page, 'sign_only', 'Sign');
        await setField(page, 'pgpkeyurl2', mine.armored);
        await setField(page, 'message', PLAINTEXT);

        device.log.clear();
        const armored = await pqc.confirmFromConsole(device,
          () => runPage(page, { was: PLAINTEXT }), { signal });

        assert.match(String(armored), /^-----BEGIN PGP MESSAGE-----/,
          'Sign Only put no armored message in the box');

        const verified = await openpgp.verify({
          message: await openpgp.readMessage({ armoredMessage: String(armored) }),
          verificationKeys: mine.publicKey,
          expectSigned: true,
          format: 'utf8',
        });
        assert.equal(verified.data, PLAINTEXT, 'the signed message carries different text');
        assert.equal(await verified.signatures[0].verified, true,
          'openpgp.js could not verify a signature the browser drove the device to make');

        /* The device was genuinely asked, which a page that quietly signed
         * host-side with the placeholder key would not have done. */
        assert.ok(device.log.count(PRIMED) >= 1,
          'no confirmation was ever primed - the signature did not come from the device');
      } finally {
        page.close();
      }
    });

  it('Encrypt and Sign does both, through the browser',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: as above. The mode the page DEFAULTS to, and the quietest place
       * for a mistake: a message that is encrypted but unsigned still opens, so
       * only asking openpgp.js for both properties catches a signature that was
       * skipped rather than made.
       */
      const page = await openPage(ENCRYPT, log);
      try {
        await selectMode(page, 'encrypt_and_sign', 'Encrypt and Sign');
        await setRecipients(page, correspondent.armored);
        await setField(page, 'pgpkeyurl2', mine.armored);
        await setField(page, 'message', PLAINTEXT);

        device.log.clear();
        const armored = await pqc.confirmFromConsole(device,
          () => runPage(page, { was: PLAINTEXT }), { signal });

        assert.match(String(armored), /^-----BEGIN PGP MESSAGE-----/,
          'Encrypt and Sign put no armored message in the box');

        const opened = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: String(armored) }),
          decryptionKeys: correspondent.privateKey,
          verificationKeys: mine.publicKey,
          expectSigned: true,
        });
        assert.equal(opened.data, PLAINTEXT, 'the recipient recovered different text');
        assert.equal(await opened.signatures[0].verified, true,
          'the message decrypted but its signature does not verify');
      } finally {
        page.close();
      }
    });

  it('Decrypt Only recovers a message sealed to the RSA key in slot 1',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO through the browser, console for the press window. The
       * request crosses a keyhandle boundary here and nowhere else in this file:
       * a PKCS#1 v1.5 ciphertext for RSA-2048 is a whole modulus, so
       * u2fSignBuffer sends 228 + 28. 23-rsa-tunnel proved the firmware keeps
       * both chunks and 08 proved the library sends both; this proves it still
       * happens when Chromium is carrying them.
       */
      const sealed = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: PLAINTEXT }),
        encryptionKeys: mine.publicKey,
        format: 'armored',
      });

      const page = await openPage(DECRYPT, log);
      try {
        await selectMode(page, 'decrypt_only', 'Decrypt');
        await setField(page, 'pgpkeyurl2', mine.armored);
        await setField(page, 'message', String(sealed));

        device.log.clear();
        const out = await pqc.confirmFromConsole(device,
          () => runPage(page, { was: String(sealed) }), { signal });

        assert.includes(String(out), PLAINTEXT,
          `the page put ${JSON.stringify(String(out).slice(0, 120))} in the box`);

        const packet = pqc.packetFromConsole(device);
        log(`device accumulated ${packet && packet.length} bytes of ciphertext`);
        assert.equal(packet && packet.length, 256,
          `the device hashed ${packet && packet.length} bytes of a 256-byte ciphertext - ` +
          'a short count means an early keyhandle was dropped');
      } finally {
        page.close();
      }
    });

  it('Decrypt and Verify recovers it and names the sender',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: as above. The mode the decrypt page DEFAULTS to, and the only
       * one with a third key in play - the sender's, verified host-side by kbpgp
       * with no device involvement. It runs `unbox` in STRICT mode, so a
       * signature that does not check fails the whole call rather than arriving
       * unsigned.
       *
       * Who signed it reaches the page only as button text, which is exactly
       * what a person reads, so that is what this asserts on.
       */
      const sealed = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: PLAINTEXT }),
        encryptionKeys: mine.publicKey,
        signingKeys: correspondent.privateKey,
        format: 'armored',
      });

      const page = await openPage(DECRYPT, log);
      try {
        await selectMode(page, 'decrypt_and_verify', 'Decrypt and Verify');
        await setField(page, 'pgpkeyurl', correspondent.armored);
        await setField(page, 'pgpkeyurl2', mine.armored);
        await setField(page, 'message', String(sealed));

        device.log.clear();
        const out = await pqc.confirmFromConsole(device,
          () => runPage(page, { was: String(sealed) }), { signal });

        assert.includes(String(out), PLAINTEXT,
          `the page put ${JSON.stringify(String(out).slice(0, 120))} in the box`);

        const button = await page.eval('document.querySelector("#onlykey_start").textContent');
        log(`button says ${JSON.stringify(button)}`);
        assert.includes(String(button), 'Signed by',
          'the page never reported a signer, which is the whole difference from Decrypt Only');
        assert.includes(String(button), SENDER.email.split('@')[0],
          'the page named a different signer than the key that signed the message');
      } finally {
        page.close();
      }
    });
});
