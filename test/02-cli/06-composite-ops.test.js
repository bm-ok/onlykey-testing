/*
 * TC-11, phase two: the WEB APP's composite calls, against a key the CLI put on
 * the device.
 *
 * 05-composite-load proved the key arrives intact, using python to sign. This
 * asks the same device the same question through `onlykey-3rd-party.js` -
 * `composite_sign` and `composite_decrypt`, the two calls the pgp-pqc page is
 * built on - so the browser's client is checked against the same key the
 * command line loaded.
 *
 * It sits in section 2 rather than section 3's headless tier for one reason:
 * loading the key needs `onlykey-cli setpqc`, and therefore a kernel device
 * node. That is section 2's admission test, and it does not stop being true
 * because the client under test happens to be the browser's. The headless tier
 * stays CI-able precisely by keeping files like this out of it.
 *
 * Both operations raise the three-button challenge - okpqc_sign() and
 * okpqc_decrypt() each prime and then do nothing until CRYPTO_AUTH reaches 4 -
 * and the library primes and polls from inside a promise rather than from a
 * child process, which is what lib/pqc.js's confirmWhilst() is for.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');
const webenv = require('../../lib/webenv');

const SLOT_NAME = 'RSA1';
const SLOT_ID = 1;
const HALF_ECC = 0;

describe('composite operations, through the web app\'s library', {
  state: 'initialized',
  requires: ['crypto', 'client-access', 'webapp-lib', 'xwing-math'],
  timeoutMs: 240000,
}, () => {
  let blob = null;
  let ed25519Pub = null;
  let x25519Sk = null;
  let third = null;

  it('loads a composite key with the CLI', async ({ device, assert, signal, log }) => {
    const composite = webenv.loadPlain('composite_pgp.js');
    const generated = await composite.generateCompositeKey(webenv.openpgp(), {
      userId: { name: 'Kit', email: 'kit@example.com' },
    });
    blob = Buffer.from(generated.blob);

    const { ed25519 } = require('@noble/curves/ed25519.js');
    const { x25519 } = require('@noble/curves/ed25519.js');
    ed25519Pub = Buffer.from(ed25519.getPublicKey(blob.subarray(0, 32)));
    x25519Sk = Buffer.from(blob.subarray(64, 96));
    log(`x25519 public ${Buffer.from(x25519.getPublicKey(x25519Sk)).toString('hex').slice(0, 16)}…`);

    await device.unlock(PINS.primary, { signal });
    await device.enterConfigMode(PINS.primary, { signal });

    const result = await cli.run('onlykey-cli',
      ['setpqc', SLOT_NAME, blob.toString('hex')], { timeoutMs: 60000, signal });
    assert.equal(result.code, 0, `setpqc failed: ${result.stderr || result.stdout}`);

    /* Out of config mode: OKSIGN and OKDECRYPT are not on its allow-list. */
    await device.restart({ signal });
    await device.unlock(PINS.primary, { signal });

    const imports = webenv.create(device, { signal });
    const api = webenv.load(imports, 'onlykey-api.js');
    third = webenv.load(imports, 'onlykey-3rd-party.js', api)();

    assert.ok(typeof third.composite_sign === 'function', 'no composite_sign');
    assert.ok(typeof third.composite_decrypt === 'function', 'no composite_decrypt');

    /*
     * The handshake first, and it is not optional here even though it was for
     * the derive calls.
     *
     * derive_public_key builds its own OKCONNECT inline and needs nothing
     * beforehand. The composite operations do not: prime_composite() encrypts
     * every chunk with `onlykeyApi.sharedsec`, which only exists once connect()
     * has done the NaCl exchange. Without it the very first call dies inside
     * aesgcm_encrypt with "undefined is not iterable" - a message that names
     * neither the handshake nor the key.
     */
    await new Promise((resolve, reject) => {
      api.connect((err) => (err ? reject(new Error(String(err))) : resolve()));
    });
    assert.ok(api.sharedsec, 'the library has no transit key after connect()');
  });

  it('signs with the Ed25519 half, and the signature verifies',
    async ({ device, assert, signal, log }) => {
      /*
       * The web app's own call this time, not python's. Same device, same key,
       * same digest - so a disagreement between this and 05-composite-load
       * would say the two clients frame OKSIGN differently, which nothing else
       * would catch.
       */
      const digest = crypto.createHash('sha256').update('signed for the web app').digest();
      const primed = Buffer.concat([Buffer.from([HALF_ECC]), digest]);

      const sig = await pqc.confirmWhilst(device, pqc.challengeDigitsFor(primed),
        () => third.composite_sign(SLOT_ID, HALF_ECC, digest), { signal });

      const bytes = Buffer.from(sig);
      log(`library got ${bytes.length} bytes`);
      assert.equal(bytes.length, 64, 'an Ed25519 signature is 64 bytes');

      const { ed25519 } = require('@noble/curves/ed25519.js');
      assert.ok(ed25519.verify(bytes, digest, ed25519Pub),
        'the signature does not verify against the loaded key');
    });

  it('decrypts with the X25519 half', async ({ device, assert, signal, log }) => {
    /*
     * okpqc_decrypt() picks the half by SIZE - 32 bytes is an X25519 ephemeral
     * point, 1088 an ML-KEM ciphertext - so there is no selector byte and the
     * length is the whole instruction. The ECC half is used here for the same
     * reason as the signature: its answer can be checked in one line, since
     * X25519(sk_device, ephemeral_pub) must equal X25519(sk_ephemeral, pub_device).
     */
    const { x25519 } = require('@noble/curves/ed25519.js');

    const ephemeralSk = x25519.utils.randomSecretKey();
    const ephemeralPub = x25519.getPublicKey(ephemeralSk);
    const devicePub = x25519.getPublicKey(x25519Sk);
    const expected = Buffer.from(x25519.getSharedSecret(ephemeralSk, devicePub));

    /*
     * Answered by READING the challenge off the device's console rather than
     * predicting it, unlike the signature above. Both mechanisms are live on
     * purpose: predicting checks that this kit derives the same digits the
     * firmware does, and reading is what the browser pages need, since a page
     * assembles payloads nobody outside it can reconstruct. Keeping one of each
     * means neither goes stale.
     */
    const shared = await pqc.confirmFromConsole(device,
      () => third.composite_decrypt(SLOT_ID, ephemeralPub), { signal });

    const bytes = Buffer.from(shared);
    log(`shared secret ${bytes.toString('hex').slice(0, 16)}…`);

    assert.equal(bytes.length, 32, 'an X25519 shared secret is 32 bytes');
    assert.bytes(bytes, expected,
      'the device computed a different shared secret from the same two keys');
  });

  it('will not sign the same digest twice without a new confirmation',
    async ({ device, assert, signal }) => {
      /*
       * The confirmation is per-operation, not per-session. If CRYPTO_AUTH
       * stayed set, anything that reached the device afterwards could sign
       * silently - which is the whole property the three buttons exist to
       * provide, and it is invisible from a single successful signature.
       *
       * No presses are answered here: the call must NOT complete - which is
       * also why this test runs LAST. An unanswered challenge leaves the device
       * primed, and the next operation to arrive inherits it: okpqc_sign() and
       * okpqc_decrypt() both bail on `if (CRYPTO_AUTH != 4) return;` without
       * priming anything of their own, so the following test's presses would
       * answer THIS challenge and its own would never be raised. Measured -
       * that is exactly how the decrypt below failed when this test came first.
       */
      const digest = crypto.createHash('sha256').update('a second, unconfirmed signature').digest();

      const settled = await Promise.race([
        third.composite_sign(SLOT_ID, HALF_ECC, digest).then(() => 'signed', () => 'refused'),
        device.sleep(12000, { signal }).then(() => 'waiting'),
      ]);

      assert.notEqual(settled, 'signed',
        'the device signed a second digest with no confirmation - CRYPTO_AUTH is sticky');
    });
});
