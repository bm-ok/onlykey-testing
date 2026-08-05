/*
 * Section 3, headless: the composite PGP-PQC blob, against the two other
 * implementations of its layout.
 *
 * A composite key is one imported blob holding four secrets - Ed25519 and
 * ML-DSA-65 for signing, X25519 and ML-KEM-768 for decryption - and three
 * separate codebases have to agree byte for byte about where each one sits:
 *
 *   okpqc.h                 what the FIRMWARE reads out of the slot
 *   python-onlykey/pqc.py   what `onlykey-cli setpqc` writes into it
 *   composite_pgp.js        what the WEB APP packs
 *
 * Nothing checks that they agree. A drift would not fail loudly either: the
 * blob is a fixed-size run of opaque bytes, so a wrong offset imports cleanly
 * and then produces signatures that do not verify and decryptions that return
 * noise, with the key material itself unrecoverable from any error message.
 *
 * So this reads the firmware header and python's constants as text and requires
 * the web app's numbers to equal them. `device: false` - the authorities are
 * source files, and the point is that they are three different files.
 *
 * The blob layout is all that is checked here. Generating a composite key needs
 * the vendored openpgp fork, and using one needs the device; both belong in
 * later files.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { describe, it } = require('../../lib/harness');
const { CHECKOUTS_ROOT } = require('../../lib/paths');
const webenv = require('../../lib/webenv');

const OKPQC_H = path.join(CHECKOUTS_ROOT, 'libraries', 'onlykey', 'okpqc.h');
const PQC_PY = path.join(CHECKOUTS_ROOT, 'python-onlykey', 'onlykey', 'pqc.py');

/** `#define NAME 123` out of a C header. */
function cDefine(text, name) {
  const m = text.match(new RegExp(`^#define\\s+${name}\\s+(0x[0-9a-fA-F]+|\\d+)`, 'm'));
  return m ? Number(m[1]) : null;
}

/** `NAME = 123` out of a python module. */
function pyConst(text, name) {
  const m = text.match(new RegExp(`^${name}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)`, 'm'));
  return m ? Number(m[1]) : null;
}

describe('the composite PGP-PQC blob layout', {
  device: false,
  requires: ['webapp-lib'],
}, () => {
  const lib = () => webenv.loadPlain('composite_pgp.js');

  it('agrees with the firmware about every offset', async ({ assert, skip, log }) => {
    if (!fs.existsSync(OKPQC_H)) skip(`no firmware source at ${OKPQC_H}`);
    const h = fs.readFileSync(OKPQC_H, 'utf8');
    const web = lib();

    /* Left is the web app's name, right is the firmware's. */
    const pairs = [
      ['BLOB_LEN', 'PQC_PGP_BLOB_LEN'],
      ['OFF_ED25519', 'PQC_OFF_ED25519'],
      ['OFF_MLDSA_SEED', 'PQC_OFF_MLDSA_SEED'],
      ['OFF_X25519', 'PQC_OFF_X25519'],
      ['OFF_MLKEM_SEED', 'PQC_OFF_MLKEM_SEED'],
      ['MLDSA_SEED_LEN', 'MLDSA65_SEED_LEN'],
      ['MLKEM_SEED_LEN', 'MLKEM768_SEED_LEN'],
      ['HALF_ECC', 'PQC_HALF_ECC'],
      ['MLKEM_CT_LEN', 'MLKEM_CT_SIZE'],
      ['SS_LEN', 'MLKEM_SS_SIZE'],
      ['MLDSA_SIG_LEN', 'MLDSA_SIG_SIZE'],
      ['ED25519_SIG_LEN', 'ED25519_SIG_SIZE'],
      ['X25519_PT_LEN', 'X25519_SS_SIZE'],
    ];

    for (const [ours, theirs] of pairs) {
      const firmware = cDefine(h, theirs);
      assert.ok(firmware !== null, `okpqc.h no longer defines ${theirs}`);
      assert.equal(web[ours], firmware, `${ours} vs okpqc.h's ${theirs}`);
    }
    log(`checked ${pairs.length} constants against okpqc.h`);
  });

  it('agrees with python-onlykey about every offset', async ({ assert, skip }) => {
    if (!fs.existsSync(PQC_PY)) skip(`no python-onlykey source at ${PQC_PY}`);
    const py = fs.readFileSync(PQC_PY, 'utf8');
    const web = lib();

    const pairs = [
      ['BLOB_LEN', 'PQC_PGP_BLOB_LEN'],
      ['OFF_ED25519', 'OFF_ED25519'],
      ['OFF_MLDSA_SEED', 'OFF_MLDSA_SEED'],
      ['OFF_X25519', 'OFF_X25519'],
      ['OFF_MLKEM_SEED', 'OFF_MLKEM_SEED'],
      ['HALF_ECC', 'HALF_ECC'],
      ['HALF_PQC', 'HALF_PQC'],
      ['X25519_PT_LEN', 'X25519_PT_LEN'],
      ['ED25519_SIG_LEN', 'ED25519_SIG_LEN'],
    ];

    for (const [ours, theirs] of pairs) {
      const python = pyConst(py, theirs);
      assert.ok(python !== null, `pqc.py no longer defines ${theirs}`);
      assert.equal(web[ours], python, `${ours} vs pqc.py's ${theirs}`);
    }
  });

  it('is the key type the firmware expects for a loaded slot', async ({ assert, skip }) => {
    /*
     * 0x67 is not a number to take on trust - it is KEYTYPE_PQC_PGP with the
     * decrypt and sign feature bits, and if the firmware ever renumbers the key
     * type the web app would keep importing blobs the device files under
     * something else.
     */
    if (!fs.existsSync(OKPQC_H)) skip(`no firmware source at ${OKPQC_H}`);
    const keytype = cDefine(fs.readFileSync(OKPQC_H, 'utf8'), 'KEYTYPE_PQC_PGP');

    assert.ok(keytype !== null, 'okpqc.h no longer defines KEYTYPE_PQC_PGP');
    assert.equal(lib().PQC_KEY_TYPE_BYTE, keytype | 0x20 | 0x40,
      'the web app\'s key-type byte is not KEYTYPE_PQC_PGP with decrypt+sign');
  });

  it('packs each secret at its own offset', async ({ assert }) => {
    /*
     * Distinguishable fillers, so a transposition is visible. Two 32-byte
     * fields sitting next to each other would round-trip perfectly even if
     * they were swapped, which is exactly the mistake this layout invites.
     */
    const web = lib();
    const ed = Buffer.alloc(32, 0x11);
    const mldsa = Buffer.alloc(32, 0x22);
    const x = Buffer.alloc(32, 0x33);
    const mlkem = Buffer.alloc(64, 0x44);

    const blob = Buffer.from(web.packBlob(ed, mldsa, x, mlkem));
    assert.equal(blob.length, web.BLOB_LEN, 'the blob is not 160 bytes');

    assert.bytes(blob.subarray(0, 32), ed, 'Ed25519 at 0');
    assert.bytes(blob.subarray(32, 64), mldsa, 'the ML-DSA seed at 32');
    assert.bytes(blob.subarray(64, 96), x, 'X25519 at 64');
    assert.bytes(blob.subarray(96, 160), mlkem, 'the ML-KEM seed at 96');
  });

  it('unpacks what it packed', async ({ assert }) => {
    const web = lib();
    const parts = {
      ed25519Sk: Buffer.alloc(32, 0xA1),
      mldsaSeed: Buffer.alloc(32, 0xB2),
      x25519Sk: Buffer.alloc(32, 0xC3),
      mlkemSeed: Buffer.alloc(64, 0xD4),
    };

    const blob = web.packBlob(parts.ed25519Sk, parts.mldsaSeed, parts.x25519Sk, parts.mlkemSeed);
    const back = web.unpackBlob(blob);

    for (const [name, value] of Object.entries(parts)) {
      assert.bytes(back[name], value, name);
    }
  });

  it('refuses a secret of the wrong size, naming it', async ({ assert }) => {
    /*
     * The ML-KEM seed is 64 bytes and the other three are 32, which is the
     * error somebody will make. It has to be rejected at the pack rather than
     * silently truncated into the next field's space.
     */
    const web = lib();
    const ok32 = Buffer.alloc(32);
    const ok64 = Buffer.alloc(64);

    await assert.rejects(async () => web.packBlob(Buffer.alloc(31), ok32, ok32, ok64), /ed25519Sk/);
    await assert.rejects(async () => web.packBlob(ok32, Buffer.alloc(64), ok32, ok64), /mldsaSeed/);
    await assert.rejects(async () => web.packBlob(ok32, ok32, Buffer.alloc(33), ok64), /x25519Sk/);
    await assert.rejects(async () => web.packBlob(ok32, ok32, ok32, ok32), /mlkemSeed/);

    await assert.rejects(async () => web.unpackBlob(Buffer.alloc(159)), /160/);
  });
});
