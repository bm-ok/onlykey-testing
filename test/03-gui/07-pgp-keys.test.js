/*
 * Section 3, headless: the web app's PGP layer, as far as it goes without a
 * device.
 *
 * onlykey-pgp.js is the biggest module in the library and the one behind the
 * encrypt and decrypt pages. Most of it needs the device - the private half of
 * every operation lives there - but the part that decides WHICH KEY a given
 * message or public key refers to does not, and getting that wrong is how a
 * message ends up encrypted to the wrong subkey or verified against the wrong
 * one.
 *
 * That distinction is the thing worth pinning. A PGP key is a primary key that
 * signs plus a subkey that encrypts, and the two are interchangeable in every
 * respect except which operation they are valid for - the same shape of mistake
 * as the composite blob's transposed halves in 06, and just as quiet.
 *
 * Keys are generated here rather than taken from a fixture. The deprecated
 * test-api ships some, and using them would make this depend on a directory
 * PLAN says to depend on nothing in.
 *
 * `device: false`. The device-backed half - startEncryption/startDecryption
 * against a key the OnlyKey holds - needs a composite key loaded into a slot by
 * `onlykey-cli setpqc`, which is not reachable over the browser's WebAuthn
 * transport at all, so it belongs to section 2.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const webenv = require('../../lib/webenv');

const USER = { name: 'Kit', email: 'kit@example.com' };

/* onlykey-pgp.js's own strings - the page sets them by name. */
const MODES = [
  'Encrypt Only', 'Sign Only', 'Encrypt and Sign',
  'Decrypt Only', 'Decrypt and Verify',
];

describe('the web app\'s PGP layer', {
  device: false,
  requires: ['webapp-lib'],
  timeoutMs: 120000,
}, () => {
  let pgp = null;
  let armored = null;
  let openpgp = null;

  /* The library is callback-style throughout; every one of these settles. */
  const call = (fn, ...args) => new Promise((resolve, reject) => {
    fn(...args, (err, value) => (err ? reject(new Error(String(err))) : resolve(value)));
  });

  /*
   * A key id, as hex, from either shape this module hands back.
   *
   * They are not consistent: getPGPVerifyKeyID and getPGPCryptKeyID return
   * 8-byte Buffers, while getMessageKeyIds returns hex STRINGS. Comparing one
   * against the other without noticing produces the ASCII of a hex string
   * hexed again - a mismatch that looks like the wrong key rather than the
   * wrong type.
   */
  const hex = (id) => (typeof id === 'string'
    ? id.toLowerCase()
    : Buffer.from(id).toString('hex'));

  it('builds the PGP api and generates a key to read', async ({ assert }) => {
    openpgp = webenv.openpgp();

    /*
     * kbpgp reaches this module as a FACTORY rather than an instance -
     * onlykey-pgp.js calls imports.kbpgp() itself, twice, with different first
     * arguments. plugin.js registers the instance for the pages instead, which
     * is the sort of difference that only shows up when something is driven
     * from an unusual direction.
     */
    const imports = webenv.create(null, {});
    pgp = webenv.load(imports, 'onlykey-pgp.js')({}, false);

    assert.ok(typeof pgp.getPublicKeyInfo === 'function', 'no getPublicKeyInfo');
    assert.ok(typeof pgp.api === 'function', 'no api()');

    const key = await openpgp.generateKey({
      type: 'ecc', curve: 'curve25519', userIDs: [USER], format: 'armored',
    });
    armored = key.publicKey;
    assert.ok(armored.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), 'no armored key');
  });

  it('reads a public key it has never seen before', async ({ assert }) => {
    const info = await call(pgp.getPublicKeyInfo, armored);

    assert.ok(info, 'no key info came back');
    assert.ok(info.primary, 'the key info has no primary key');
    assert.ok(Array.isArray(info.subkeys) && info.subkeys.length >= 1,
      'the key info has no subkeys');
    assert.ok(Array.isArray(info.userids) && info.userids.length >= 1,
      'the key info has no user ids');
  });

  it('tells the signing key from the encryption key', async ({ assert, log }) => {
    /*
     * The assertion this file exists for. getPGPVerifyKeyID has to name the
     * PRIMARY key and getPGPCryptKeyID the SUBKEY; swap them and every
     * signature is verified against a key that never signs while every message
     * is encrypted to one that cannot decrypt - and both failures surface far
     * from here.
     */
    const verify = await call(pgp.getPGPVerifyKeyID, armored);
    const crypt = await call(pgp.getPGPCryptKeyID, armored);
    log(`verify ${hex(verify)}, crypt ${hex(crypt)}`);

    assert.equal(Buffer.from(verify).length, 8, 'a PGP key id is 8 bytes');
    assert.equal(Buffer.from(crypt).length, 8, 'a PGP key id is 8 bytes');
    assert.notEqual(hex(verify), hex(crypt),
      'the signing and encryption key ids are the same - primary and subkey confused');

    /* And which is which, against the key itself rather than against each
     * other: openpgp reports the primary and the encryption subkey separately. */
    const key = await openpgp.readKey({ armoredKey: armored });
    assert.equal(hex(verify), key.getKeyID().toHex(),
      'the verify key id is not the primary key');
    assert.equal(hex(crypt), key.subkeys[0].getKeyID().toHex(),
      'the crypt key id is not the encryption subkey');
  });

  it('lists both key ids, primary first', async ({ assert }) => {
    const ids = await call(pgp.getPublicKeyIds, armored);
    const verify = await call(pgp.getPGPVerifyKeyID, armored);
    const crypt = await call(pgp.getPGPCryptKeyID, armored);

    assert.equal(ids.length, 2, `expected two key ids, got ${ids.length}`);
    assert.equal(hex(ids[0]), hex(verify), 'the first id is not the primary key');
    assert.equal(hex(ids[1]), hex(crypt), 'the second id is not the encryption subkey');
  });

  it('identifies which key a message was encrypted to', async ({ assert }) => {
    /*
     * The decrypt page's first question, asked before any device is involved:
     * given an armored message, which of my keys does it need? Answering it
     * wrongly means asking the device for the wrong key, which fails as a
     * decryption error rather than as anything about key selection.
     */
    const message = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'for the subkey only' }),
      encryptionKeys: await openpgp.readKey({ armoredKey: armored }),
      format: 'armored',
    });

    const ids = await call(pgp.getMessageKeyIds, message);
    const crypt = await call(pgp.getPGPCryptKeyID, armored);

    assert.ok(ids.length >= 1, 'no key ids read out of the message');
    assert.equal(typeof ids[0], 'string',
      'getMessageKeyIds used to return hex strings - if that changed, so did every caller');
    assert.ok(ids.some((id) => hex(id) === hex(crypt)),
      `the message names ${ids.map(hex).join(', ')}, not the encryption subkey ${hex(crypt)}`);
  });

  it('carries the mode the page sets', async ({ assert }) => {
    /*
     * The five modes are the whole of the encrypt/decrypt pages' behaviour, and
     * they are set by NAME - a string typo picks a different branch silently
     * rather than failing, which is what makes reading them back worth doing.
     */
    const api = pgp.api();
    assert.ok(typeof api._$mode === 'function', 'no _$mode on the pgp api');

    for (const mode of MODES) {
      api._$mode(mode);
      assert.equal(api._$mode(), mode, `the api did not keep the mode ${mode}`);
    }
  });
});
