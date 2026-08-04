/*
 * TC-04: generate an X-Wing keypair on the device, through the real plugin.
 *
 * The old kit's 01-pqc-keygen, and the first test in this kit that makes the
 * firmware do post-quantum cryptography. It runs the actual
 * age-plugin-onlykey - not a JS reimplementation of what it sends - so a pass
 * says the shipped plugin works against this firmware, which is a different
 * claim from section 1's and the reason both exist.
 *
 * The device demands a three-button confirmation before it will generate
 * anything, and its only way of naming the buttons is its LEDs. lib/pqc.js
 * computes them instead; the comment there explains why that is legitimate
 * rather than a shortcut, and why the emulator makes the timing honest.
 *
 * The tests below run in order and build on each other: the readback has
 * nothing to read until the generate has run. fail-fast is on, so a broken
 * generate stops the file rather than producing a second, confusing failure.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');

const DEFAULT_SLOT = 101;    // age_plugin's DEFAULT_XWING_SLOT

describe('age-plugin-onlykey X-Wing keygen',
  { state: 'initialized', requires: ['crypto', 'client-access'], timeoutMs: 240000 }, () => {
    let generated = null;

    it('has the plugin it needs', async ({ assert, skip }) => {
      if (!cli.venvPresent()) skip(`no venv at ${cli.VENV_BIN}`);
      assert.ok(cli.binary('age-plugin-onlykey'), 'age-plugin-onlykey is missing from the venv');
    });

    it('knows which buttons the device is about to ask for', async ({ assert }) => {
      /*
       * Cheap, and it fails FIRST if it is going to fail. Without it, a wrong
       * derivation shows up two minutes later as a device that ignored three
       * presses, which reads like a timing problem and is not one.
       */
      const digits = pqc.challengeDigits(pqc.KEYTYPE.XWING);
      assert.equal(digits.length, 3);
      for (const d of digits) {
        assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `button ${d} is not 1..6`);
      }
    });

    it('generates an X-Wing identity in the default slot',
      async ({ device, assert, signal, log }) => {
        const erases = device.log.count(/Erase Sector/g);
        const result = await pqc.generate(device, ['--generate'], { signal });
        const wrote = device.log.count(/Erase Sector/g) - erases;
        log(`flash sector erases during the keygen: ${wrote}`);

        assert.equal(result.code, 0,
          `age-plugin-onlykey exited ${result.code}\nstderr: ${result.stderr}`);

        generated = pqc.parseGenerated(result);
        log(`recipient ${generated.recipient}`);

        assert.ok(generated.identity,
          `no AGE-PLUGIN-ONLYKEY-1... identity on stdout, got: ${JSON.stringify(result.stdout)}`);
        assert.ok(generated.recipient,
          `no age1onlykey1... recipient printed, got: ${JSON.stringify(result.stderr)}`);

        /*
         * The regression, and the cheapest way to see the bug that was here:
         * one keygen writes the slot ONCE.
         *
         * ecc_priv_flash() used to fall through after okcrypto_generate_random_key(),
         * which for a PQC type has already called back into ecc_priv_flash() to
         * store the seed. The second pass encrypted the already-encrypted buffer
         * again and wrote E(E(seed)) over the slot, so the device kept a key
         * whose public half it had never reported. Two erases is the fingerprint
         * of that, and it is visible here well before the readback below fails.
         */
        assert.equal(wrote, 1,
          'one --generate wrote the ECC slot more than once - the seed is being ' +
          'encrypted and stored twice (okcore.cpp ecc_priv_flash)');
      });

    it('will not read the key back while still in config mode',
      async ({ device, assert, signal }) => {
        /*
         * Config mode is not a superset of normal operation - it is an
         * ALLOW-LIST, and a short one. okcore.cpp:346 accepts exactly eleven
         * messages while configmode is true (OKCONNECT, OKWIPESLOT, OKSETSLOT,
         * OKSETPRIV, OKRESTORE, OKFWUPDATE, OKWIPEPRIV, OKGETLABELS, OKPIN,
         * OKPINSEC, OKPINSD) and returns without answering anything else.
         *
         * OKGETPUBKEY is not on that list, so the request is dropped where it
         * arrives. There is no error on the wire: the "ERROR NOT SUPPORTED IN
         * CONFIG MODE" below the check is a DEBUG print, so on a release build
         * a client sees only silence - which is what python-onlykey reports as
         * "got 0 bytes, expected 1216". A test that skipped this would leave
         * the next person to hit it reading that message as a truncation or a
         * missing key, which is what it looks like.
         *
         * The device is still in config mode here because the generate above
         * put it there and config mode has no exit but a reboot.
         */
        const result = await cli.run('age-plugin-onlykey',
          ['--recipient', '--slot', String(DEFAULT_SLOT)], { timeoutMs: 30000, signal });

        assert.notEqual(result.code, 0, 'config mode should not answer OKGETPUBKEY');
        assert.includes(result.stderr, 'got 0 bytes',
          'expected silence from the device, not a short or wrong answer');
        assert.ok(/NOT SUPPORTED IN CONFIG MODE/.test(device.log.tail(4000)),
          'the device did not say it was refusing on config-mode grounds');
      });

    it('put the key where it said it did', async ({ device, assert, signal, log }) => {
      /*
       * The check the old kit could not make, because it had no way to ask the
       * device a second question cheaply.
       *
       * --generate prints a recipient derived from what the device returned in
       * that one response. --recipient goes back to the device and asks slot
       * 101 for its public key over OKGETPUBKEY - a different message, no
       * button press, no keygen. Identical recipients mean the key was
       * genuinely stored, that it survived a reboot, and that a re-read
       * produces the same key rather than a fresh one. Different ones would
       * mean --generate reported a keypair that is not the one the device kept.
       */
      if (!generated || !generated.recipient) {
        assert.ok(false, 'nothing was generated to read back');
      }

      /* The only way out of config mode. It also proves the key is in flash
       * rather than in RAM left over from the generate. */
      await device.restart({ signal });
      await device.unlock(PINS.primary, { signal });

      const result = await cli.run('age-plugin-onlykey',
        ['--recipient', '--slot', String(DEFAULT_SLOT)], { timeoutMs: 30000, signal });

      assert.equal(result.code, 0, `--recipient failed: ${result.stderr}`);

      const readBack = pqc.parseGenerated(result).recipient;
      log(`read back ${readBack}`);
      assert.ok(readBack,
        '--recipient exited 0 but printed no recipient. ' +
        `stdout: ${JSON.stringify(result.stdout)} stderr: ${JSON.stringify(result.stderr)}`);
      assert.equal(readBack, generated.recipient,
        'the slot holds a different key from the one --generate reported');
    });
  });
