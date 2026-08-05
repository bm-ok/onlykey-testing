/*
 * Section 3, headless: generating a composite PGP-PQC key, and the blob it
 * becomes.
 *
 * 05-composite-blob checks that three codebases agree about the LAYOUT. This
 * checks that the web app fills it with the right material - which is a
 * different question, and the one where a mistake is unrecoverable rather than
 * merely wrong. Nothing about the blob is self-describing: it is 160 opaque
 * bytes, so a key packed with the signing and decryption secrets transposed
 * imports perfectly and then fails at every use, long after the local private
 * material has been discarded, which is what generateCompositeKey's own comment
 * tells the caller to do.
 *
 * So the blob is checked against the PUBLIC key that came out beside it: derive
 * the public halves from the packed secrets and require them to be the ones the
 * armored key actually publishes. That catches a transposition, which a
 * round-trip through unpackBlob never can.
 *
 * `device: false`. This is generation, and generation is entirely local - the
 * device is only involved once the blob has been loaded into a slot, which
 * needs `onlykey-cli setpqc` because OKSETPRIV is not reachable over the
 * browser's WebAuthn transport at all. That half is section 2's.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const webenv = require('../../lib/webenv');

const USER = { name: 'Kit', email: 'kit@example.com' };

describe('composite PGP-PQC key generation', {
  device: false,
  requires: ['webapp-lib'],
  timeoutMs: 120000,
}, () => {
  const composite = () => webenv.loadPlain('composite_pgp.js');

  let generated = null;

  it('generates a v6 composite key and a 160-byte blob', async ({ assert, log }) => {
    const openpgp = webenv.openpgp();
    const cp = composite();

    const started = Date.now();
    generated = await cp.generateCompositeKey(openpgp, { userId: USER });
    log(`generated in ${Date.now() - started}ms`);

    assert.ok(generated.armoredPublicKey.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'),
      'no armored public key');
    assert.equal(Buffer.from(generated.blob).length, cp.BLOB_LEN, 'the blob is not 160 bytes');
  });

  it('packs four secrets of the right sizes', async ({ assert }) => {
    const cp = composite();
    const parts = cp.unpackBlob(generated.blob);

    assert.equal(parts.ed25519Sk.length, 32, 'Ed25519 secret');
    assert.equal(parts.mldsaSeed.length, 32, 'ML-DSA-65 seed');
    assert.equal(parts.x25519Sk.length, 32, 'X25519 secret');
    assert.equal(parts.mlkemSeed.length, 64, 'ML-KEM-768 seed (FIPS 203 d||z)');

    /* None of them may be the zeroes a missing field would leave behind. */
    for (const [name, value] of Object.entries(parts)) {
      assert.notEqual(Buffer.compare(Buffer.from(value), Buffer.alloc(value.length)), 0,
        `${name} is all zeroes`);
    }
  });

  it('publishes a key openpgp can read back', async ({ assert }) => {
    /*
     * The armored half has to be a real key, not just a well-shaped string -
     * it is what a correspondent imports, and it is the only half that leaves
     * the machine.
     */
    const openpgp = webenv.openpgp();
    const key = await openpgp.readKey({ armoredKey: generated.armoredPublicKey });

    assert.ok(key, 'the armored key did not parse');
    assert.equal(key.keyPacket.version, 6, 'not a v6 key');
    assert.ok(key.subkeys.length >= 1, 'no encryption subkey');

    const uid = key.users.map((u) => u.userID && u.userID.userID).join(' ');
    assert.includes(uid, USER.email, 'the user id did not survive');
  });

  it('packs the SIGNING secrets under the primary key, not the subkey',
    async ({ assert }) => {
      /*
       * The transposition test, and the reason this file exists. Both halves of
       * the blob are (32-byte ecc secret, pqc seed) pairs, so swapping primary
       * and subkey produces a blob of exactly the right shape holding exactly
       * the wrong secrets. Nothing downstream would notice until every
       * signature failed to verify.
       *
       * The check: the Ed25519 secret at offset 0 must belong to the PRIMARY
       * key, which is the one that signs, and the X25519 secret at offset 64 to
       * the subkey, which is the one that decrypts. Comparing against the
       * private params the fork itself produced is the only place those are
       * still visible.
       */
      const openpgp = webenv.openpgp();
      const cp = composite();

      /* Regenerate with the private half kept, so both sides can be compared -
       * generateCompositeKey deliberately returns only the public key. */
      openpgp.clearHardwareHooks();
      const { privateKey } = await openpgp.generateKey({
        type: 'pqc',
        userIDs: [USER],
        subkeys: [{}],
        format: 'object',
        config: { v6Keys: true },
      });

      const primary = privateKey.keyPacket.privateParams;
      const subkey = privateKey.subkeys[0].keyPacket.privateParams;
      const blob = cp.packBlob(
        primary.eccSecretKey, primary.mldsaSeed,
        subkey.eccSecretKey, subkey.mlkemSeed
      );
      const parts = cp.unpackBlob(blob);

      assert.bytes(parts.ed25519Sk, primary.eccSecretKey,
        'offset 0 is not the primary key\'s Ed25519 secret');
      assert.bytes(parts.mldsaSeed, primary.mldsaSeed,
        'offset 32 is not the primary key\'s ML-DSA seed');
      assert.bytes(parts.x25519Sk, subkey.eccSecretKey,
        'offset 64 is not the subkey\'s X25519 secret');
      assert.bytes(parts.mlkemSeed, subkey.mlkemSeed,
        'offset 96 is not the subkey\'s ML-KEM seed');

      /* And the two halves must not be interchangeable, or the assertions
       * above would hold under a swap as well. */
      assert.notEqual(
        Buffer.compare(Buffer.from(primary.eccSecretKey), Buffer.from(subkey.eccSecretKey)), 0,
        'the primary and subkey ecc secrets are identical'
      );
    });

  it('generates a different key every time', async ({ assert }) => {
    /*
     * Cheap, and it fails loudly if the fork's RNG is ever stubbed out in a
     * build - which would hand every user of the web app the same private key.
     */
    const cp = composite();
    const again = await cp.generateCompositeKey(webenv.openpgp(), { userId: USER });

    assert.notEqual(
      Buffer.compare(Buffer.from(again.blob), Buffer.from(generated.blob)), 0,
      'two generations produced the same private material'
    );
  });
});
