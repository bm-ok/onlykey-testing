/*
 * Section 4: the App's Advanced tab, against a device instead of a mock.
 *
 * THIS TAB REACHES SOMETHING NOTHING ELSE IN THE KIT CAN. `set_slot()` has 29
 * dispatched cases and TODO records exactly two with no coverage anywhere: case
 * 10 (`YUBIAUTH`, whose EEPROM accessor is named `public_DEPRICATED`) and case
 * 29. `onlykey-cli` exposes no route to case 10 - the section-2 sweep drove 13
 * of the CLI's 17 `setslot` field types and this is not among them - so the
 * Advanced tab is the only client in this tree that writes it. That is the
 * strongest reason to drive this tab and it was not visible until somebody read
 * the panel.
 *
 * SURFACE: vendor for both tests. The ECC key is proven by asking the DEVICE to
 * publish the public half and checking it against node:crypto, which is a
 * different implementation that has never spoken to the device. The Yubico
 * write is proven by the firmware's own named acknowledgement.
 *
 * TWO TRAPS, BOTH DOCUMENTED ELSEWHERE AND BOTH LOAD-BEARING HERE:
 *
 *   - `OKGETPUBKEY` is REFUSED IN CONFIG MODE, with no vendor reply at all -
 *     `02-cli/12-cli-slots` pinned that. Loading a key needs config mode and
 *     reading it back cannot happen inside it, so the readback crosses a
 *     reboot. A test that wrote and read in one session would see the read time
 *     out with nothing to explain it.
 *   - The App sends `setSlot("XX", "YUBIAUTH", ...)`, and `getSlotNum()` maps
 *     `'XX'` to slot **0** - a device-wide write rather than a per-slot one. So
 *     no slot has to be selected first, which is not obvious from a form that
 *     lives beside twelve slot buttons.
 *
 * NOT DRIVEN: `eccWipe` and `yubiWipe`. Wiping is a different assertion from
 * writing and belongs with the wipe semantics `01-protocol/19-rsa-keys` pins
 * (an ECC wipe really does empty the slot; an RSA wipe does not). Their
 * presence is asserted so a rename is noticed.
 *
 * OUTSIDE `--isolate` AND `--reverse` BY CONSTRUCTION, like the rest of the
 * section. Each test establishes its own device state and attaches its own page.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const pqc = require('../../lib/pqc');

const session = require('../../lib/app-session-holder');

/** The Advanced form's ECC type for Curve25519/Ed25519, and its slot. */
const ECC_TYPE_ED25519 = 1;
const ECC_SLOT = 101;

/** PKCS#8 prefix for a raw Ed25519 seed, so node:crypto can derive the public
 *  half from the same 32 bytes the device was given. */
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

async function showPanel(page, showId) {
  await page.eval(`(() => {
    const el = document.getElementById(${JSON.stringify(showId)});
    if (!el) throw new Error('no such panel control: ' + ${JSON.stringify(showId)});
    el.click();
  })()`);
}

/** Collect one vendor answer of `want` bytes. */
async function readBack(device, since, want, { signal }) {
  const out = [];
  let got = 0;
  while (got < want) {
    const rep = await device.waitHid(IFACE.VENDOR, { since: since + out.length, timeoutMs: 15000, signal });
    out.push(rep);
    got += rep.length;
  }
  return Buffer.concat(out).subarray(0, want);
}

describe('app advanced', {
  state: 'initialized',
  requires: ['client-access', 'display', 'nwjs'],
  timeoutMs: 300000,
}, () => {
  it('loads an ed25519 key through the Advanced ECC form, and the device publishes the matching public key',
    async ({ device, assert, signal, log }) => {
      /*
       * The oracle is node:crypto from the other side of the same seed. The App
       * is handed 32 bytes of hex and the device is asked what public key it
       * holds; an App that mangled a byte, or wrote to a different slot,
       * produces a public key that does not match. Self-consistency would prove
       * nothing - the App would happily read back its own mistake.
       */
      const seed = crypto.randomBytes(32);
      const want = crypto.createPublicKey(
        crypto.createPrivateKey({
          key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8',
        }),
      ).export({ format: 'der', type: 'spki' }).subarray(-32);

      const s = session.get();
      const page = await s.attach('app');
      try {
        /*
         * LET THE APP FIND THE DEVICE BEFORE TAKING IT AWAY, and this ordering
         * is load-bearing rather than tidy.
         *
         * OKSETPRIV is refused outside config mode and `readyForKeygen()`
         * restarts to get there. Doing that FIRST - which this test did until
         * 2026-08-06 - restarts the device while the App may still be running
         * its initial enumeration, so it misses both the removal and the
         * addition and settles with `{conn: null, init: false}` forever.
         * Measured: 2 failures in 4 runs, always this test, always as the first
         * device-driving test after the App launches.
         *
         * Waiting for the App to hold a connection before restarting means
         * there is always an `onDeviceRemoved` for it to pair with the
         * `onDeviceAdded`, which is what its recovery is built on.
         */
        await s.waitForDevice(page, device, { signal, log });

        await pqc.readyForKeygen(device, { signal });
        await s.waitForDevice(page, device, { signal, log });

        await showPanel(page, 'show-advanced-panel');

        const since = device.mark(IFACE.VENDOR);
        const submitted = await page.eval(`(() => {
          const type = document.getElementById('eccType');
          const slot = document.getElementById('eccSlot');
          const key = document.getElementById('eccKey');
          const btn = document.getElementById('eccSubmit');
          if (!type || !slot || !key || !btn) return 'the Advanced ECC form is not present';
          type.value = '${ECC_TYPE_ED25519}';
          type.dispatchEvent(new Event('change', { bubbles: true }));
          slot.value = '${ECC_SLOT}';
          slot.dispatchEvent(new Event('change', { bubbles: true }));
          /* The App slices to 64 characters and REJECTS anything shorter, so the
           * hex has to be exactly 32 bytes' worth. */
          key.value = ${JSON.stringify(seed.toString('hex'))};
          key.dispatchEvent(new Event('input', { bubbles: true }));
          btn.click();
          return 'submitted';
        })()`);
        assert.equal(submitted, 'submitted', submitted);

        const ack = await device.waitHid(IFACE.VENDOR,
          { since, match: /Successfully set|Error/, timeoutMs: 25000, signal })
          .catch(async () => {
            const err = await page.eval(
              "document.getElementById('eccFormError').innerText || ''");
            throw new Error('the device never acknowledged the ECC key' +
              (err ? ` - the App reported: ${err}` : ' - and the App reported no error'));
          });
        const said = okmsg.text(ack).trim();
        log(`device said: ${said}`);
        assert.match(said, /Successfully set ECC Key/,
          `loading an ECC key through the App: ${said}`);
      } finally {
        page.close();
      }

      /*
       * LEAVE CONFIG MODE BEFORE READING. OKGETPUBKEY answers nothing at all
       * inside it - not an error, silence - so this reboot is what makes the
       * readback possible rather than a durability precaution.
       */
      await device.restart({ signal });
      await device.ensureUnlocked(PINS.primary, { signal });

      const since = device.mark(IFACE.VENDOR);
      device.sendVendor({ msg: okmsg.MSG.OKGETPUBKEY, slot: ECC_SLOT });
      const published = (await readBack(device, since, 64, { signal })).subarray(0, 32);

      /* An error string is ASCII and a public key is not, so name that case
       * rather than reporting a mismatch at byte 0. */
      const asText = published.subarray(0, 16).toString('latin1');
      assert.ok(!/^Error/.test(asText),
        `ECC slot ${ECC_SLOT} did not answer with a key at all - it said ` +
        `${JSON.stringify(asText.split(' ')[0])}`);

      log(`device published ${published.toString('hex').slice(0, 32)}...`);
      assert.bytes(published, want,
        'the device published a different public key than the seed the App was ' +
        'given - so the App either mangled the hex or wrote a different slot');
    });

  it('writes YUBIAUTH through the Advanced Yubico form, which is set_slot case 10 and is covered nowhere else',
    async ({ device, assert, signal, log }) => {
      /*
       * WHAT THIS DOES AND DOES NOT PROVE, said plainly because the difference
       * matters here more than usual.
       *
       * It proves the App reaches case 10 and the firmware accepts it, by the
       * acknowledgement's own name: "Successfully set AES Key, Private ID, and
       * Public ID" is a string no other field produces.
       *
       * It does NOT prove the bytes. There is no readback - the EEPROM accessor
       * is `public_DEPRICATED` and no client message publishes it - and the App
       * rewrites the public id through `hexToModhex()` on the way, so what
       * arrives is deliberately not what was typed. Asserting the ack is
       * therefore the strongest available claim rather than a weak choice, and
       * saying so is the point: a future reader should not mistake this for the
       * byte-level agreement `12-app-keys` gets from a modulus.
       */
      await device.ensureUnlocked(PINS.primary, { signal });

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });
        await showPanel(page, 'show-advanced-panel');

        /*
         * THE PUBLIC ID FIELD TAKES MODHEX, NOT HEX, AND GETTING THAT WRONG IS
         * SILENT. `submitYubiAuthForm()` runs the value through
         * `hexToModhex(publicId, true)`, and `reverse = true` means the INPUT
         * alphabet is modhex - "cbdefghijklnrtuv" - which it converts to hex.
         * A hex digit is not in that alphabet, so the function throws, the throw
         * escapes the click handler into event dispatch, and nothing catches it:
         * no message reaches the device, `yubiError` stays empty and the form
         * does not reset. The next test pins that; this one establishes that the
         * path works at all, which is what makes the next one's silence mean
         * something.
         *
         * "cbcdcecfcgch" is modhex for the hex bytes 01 02 03 04 05 06.
         */
        const since = device.mark(IFACE.VENDOR);
        const submitted = await page.eval(`(() => {
          const pub = document.getElementById('yubiPublicId');
          const priv = document.getElementById('yubiPrivateId');
          const secret = document.getElementById('yubiSecretKey');
          const btn = document.getElementById('yubiSubmit');
          if (!pub || !priv || !secret || !btn) return 'the Advanced Yubico form is not present';
          /* 12 modhex chars of public id, 12 hex of private id, 32 hex of secret
           * key - the maxima the App slices to, so nothing is truncated. */
          pub.value = 'cbcdcecfcgch';
          priv.value = '0a0b0c0d0e0f';
          secret.value = '00112233445566778899aabbccddeeff';
          for (const el of [pub, priv, secret]) el.dispatchEvent(new Event('input', { bubbles: true }));
          btn.click();
          return 'submitted';
        })()`);
        assert.equal(submitted, 'submitted', submitted);

        const ack = await device.waitHid(IFACE.VENDOR,
          { since, match: /Successfully set|Error/, timeoutMs: 25000, signal })
          .catch(async () => {
            const err = await page.eval(
              "document.getElementById('yubiError').innerText || ''");
            throw new Error('the device never acknowledged the Yubico credential' +
              (err ? ` - the App reported: ${err}` : ' - and the App reported no error'));
          });
        const said = okmsg.text(ack).trim();
        log(`device said: ${said}`);

        assert.ok(!/^Error/.test(said), `writing YUBIAUTH through the App: ${said}`);
        assert.match(said, /Successfully set AES Key, Private ID, and Public ID/,
          `the device acknowledged something other than the Yubico credential ` +
          `(it said ${JSON.stringify(said)})`);
      } finally {
        page.close();
      }
    });

  it('discards a hex Public ID silently: YUBIAUTH sends nothing and the App reports nothing',
    async ({ device, assert, signal, log }) => {
      /*
       * A DEFECT, PINNED AS IT SHIPS, WITH ITS POSITIVE CONTROL IN THE SAME TEST.
       *
       * `submitYubiAuthForm()` converts the Public ID with `hexToModhex(v, true)`,
       * whose input alphabet is MODHEX. Hand it hex - which is what the adjacent
       * Private ID and Secret Key fields take, and what most tooling prints -
       * and it throws "Invalid character sent for hexToModhex conversion" from
       * inside the click handler. Nothing catches it. The App has `// TODO:
       * validation` at that spot and `// TODO: check for success` at the
       * callback, so the user gets no error, no acknowledgement and no clue: the
       * button simply does nothing, exactly like the slot-button dead window in
       * FINDING-app-slot-button-dead-window.md.
       *
       * THE CONTROL IS WHY THIS IS A FINDING RATHER THAN A TIMEOUT. The test
       * above submits a VALID modhex id and requires the device to acknowledge
       * it; only then does this one submit hex and require silence. Without that
       * pairing, "no vendor traffic" is equally what a broken form, a detached
       * page or a wedged device produces - which is the mistake this kit has
       * made three times and now gates against.
       *
       * It will fail the day the App validates the field or catches the throw,
       * which is the convention working rather than a regression.
       */
      await device.ensureUnlocked(PINS.primary, { signal });

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });
        await showPanel(page, 'show-advanced-panel');

        const since = device.mark(IFACE.VENDOR);
        await page.eval(`(() => {
          const pub = document.getElementById('yubiPublicId');
          const priv = document.getElementById('yubiPrivateId');
          const secret = document.getElementById('yubiSecretKey');
          document.getElementById('yubiError').innerText = '';
          pub.value = '010203040506';          /* HEX, which this field refuses */
          priv.value = '0a0b0c0d0e0f';
          secret.value = '00112233445566778899aabbccddeeff';
          for (const el of [pub, priv, secret]) el.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('yubiSubmit').click();
        })()`);

        /* Give it as long as a successful write took above, so this is silence
         * rather than impatience. */
        await device.sleep(4000, { signal });

        const traffic = device.reportsSince(IFACE.VENDOR, since)
          .map((r) => okmsg.text(r).trim())
          .filter((t) => /Successfully set|Error/.test(t));
        log(`vendor traffic after a hex Public ID: ${JSON.stringify(traffic)}`);

        assert.equal(traffic.length, 0,
          'the device answered something for a Public ID the App cannot convert - ' +
          `which would mean the throw no longer happens (it said ${JSON.stringify(traffic)})`);

        const shown = (await page.eval(
          "document.getElementById('yubiError').innerText || ''")).trim();
        log(`the App told the user: ${JSON.stringify(shown)}`);
        assert.equal(shown, '',
          'the App now reports the bad Public ID to the user - the defect this ' +
          'test pins is fixed, and the test should be inverted rather than repaired');
      } finally {
        page.close();
      }
    });

  it('exposes the ECC and Yubico wipe controls, which this file does not drive',
    async ({ device, assert, signal, log }) => {
      /*
       * Same argument as the Preferences tab's full-wipe row: an untouched
       * control is indistinguishable from one that vanished, so its presence is
       * asserted while its handler is left alone. Wipe SEMANTICS are pinned in
       * section 1, where the interesting asymmetry lives - an ECC wipe empties
       * the slot and an RSA wipe leaves the type byte behind.
       */
      await device.waitReady();

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });
        await showPanel(page, 'show-advanced-panel');

        const present = JSON.parse(await page.eval(`(() => {
          const out = {};
          for (const id of ['eccWipe', 'yubiWipe']) out[id] = !!document.getElementById(id);
          return JSON.stringify(out);
        })()`));
        log(`untouched controls: ${JSON.stringify(present)}`);

        for (const [id, found] of Object.entries(present)) {
          assert.ok(found, `the Advanced tab no longer has ${id}`);
        }
      } finally {
        page.close();
      }
    });
});
