/*
 * age-pqc.js - the derived (label-based) X-Wing split-custody maths, in JS.
 *
 * A port of python-onlykey's onlykey/age_plugin/derived_xwing.py, which is what
 * age-plugin-onlykey actually computes, and the twin of what the web app
 * computes in a browser. Three implementations have to agree byte for byte -
 * this one, the CLI's (kyber_py), and the firmware's
 * (okcrypto_xwing_web_derive(), okcrypto.cpp) - and a disagreement shows up as
 * "decryption failed" with no indication of which of the three is wrong.
 *
 * Split custody is the whole point: the device holds sk_X and never emits it.
 * What it emits is one X25519 shared secret and a one-way
 * SHA256(sk_X || tag)-derived ML-KEM seed the host expands locally, so neither
 * half can decrypt alone.
 *
 *   DERIVE_PUBLIC_KEY -> [ pk_X(32) | mlkem_seed(32) ]
 *   DERIVE_SHAREDSEC  -> [ ss_X(32) | mlkem_seed(32) ]
 *
 * This module reaches no device. It is the host half on its own, which is what
 * lets it be checked against a fixed vector in the sanity section, with no
 * device host, no gadget and no key - and, one day, what a real derive over the
 * WebAuthn tunnel will be checked AGAINST. Getting the maths pinned first is
 * what will make that debuggable: when the tunnelled derive command starts
 * answering, a mismatch is then the device's option bytes and not this file.
 *
 * The three @noble packages are optional dependencies and are loaded on first
 * use, not at require() time, so that a kit without them can still LOAD this
 * file and report a skip with a reason - the same arrangement as node-hid in
 * lib/device/hardware.js. See the 'xwing-math' capability.
 */
'use strict';

const MLKEM_PK = 1184;
const MLKEM_CT = 1088;
const XWING_PK = 1216;
const XWING_CT = 1120;
const SEED = 32;

/* draft-connolly-cfrg-xwing-kem-09's combiner label, the ASCII of  \.//^\  */
const XWING_LABEL = Uint8Array.from([0x5c, 0x2e, 0x2f, 0x2f, 0x5e, 0x5c]);

const PACKAGES = ['@noble/post-quantum', '@noble/hashes', '@noble/curves'];

let loaded = null;

/**
 * The three packages, loaded once. ML-KEM-768 has no node:crypto equivalent, so
 * unlike every other piece of maths in this kit it cannot be done from the
 * standard library.
 */
function deps() {
  if (loaded) return loaded;
  try {
    loaded = {
      ml_kem768: require('@noble/post-quantum/ml-kem.js').ml_kem768,
      shake256: require('@noble/hashes/sha3.js').shake256,
      sha3_256: require('@noble/hashes/sha3.js').sha3_256,
      x25519: require('@noble/curves/ed25519.js').x25519,
    };
  } catch (err) {
    /* First line only: node appends a whole require stack, and this string is
     * a skip REASON that has to read as one sentence in a log. */
    const [first] = String(err.message).split('\n');
    throw new Error(
      `the X-Wing maths need ${PACKAGES.join(', ')}, which are optional ` +
      `dependencies: npm install  (${first})`
    );
  }
  return loaded;
}

/**
 * Whether the packages are here, and one sentence saying what to do if not.
 * Read by lib/capabilities.js, which is why it must not throw.
 *
 * @returns {{ok: boolean, why: string|null}}
 */
function probe() {
  try {
    deps();
    return { ok: true, why: null };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * Expands the device's 32-byte seed into an ML-KEM-768 keypair.
 *
 * SHAKE256 to 64 bytes, then d||z. That split has to match on all three sides:
 * the firmware's xwing_shake256()/keypair_derand(), python-onlykey's
 * mlkem_keypair_from_seed() by way of kyber_py's _keygen_internal(d, z), and
 * @noble's ml_kem768.keygen(seed64), which splits seed[:32]/seed[32:]
 * internally. They do, and the fixed vector is what proves it rather than this
 * comment.
 */
function mlkemKeypairFromSeed(mlkemSeed) {
  const { ml_kem768, shake256 } = deps();
  if (mlkemSeed.length !== SEED) {
    throw new Error(`mlkem_seed must be ${SEED} bytes, got ${mlkemSeed.length}`);
  }
  return ml_kem768.keygen(shake256(mlkemSeed, { dkLen: 64 }));
}

/** The 1216-byte X-Wing recipient public key, pk_M || pk_X. */
function buildRecipient(pkX, mlkemSeed) {
  if (pkX.length !== 32) throw new Error(`pk_X must be 32 bytes, got ${pkX.length}`);
  const { publicKey: pkM } = mlkemKeypairFromSeed(mlkemSeed);
  return concatBytes(pkM, pkX);
}

/*
 * The combiner, draft-connolly-cfrg-xwing-kem-09 section 5.3:
 * SHA3-256(ss_M || ss_X || ct_X || pk_X || XWingLabel). Every input is bound
 * in, which is why feeding it a wrong ss_X produces an unrelated secret rather
 * than a near miss.
 */
function xwingCombiner(ssM, ssX, ctX, pkX) {
  const { sha3_256 } = deps();
  return sha3_256(concatBytes(ssM, ssX, ctX, pkX, XWING_LABEL));
}

/**
 * Finishes decapsulation from the device's half.
 *
 * @param {Uint8Array} ssX        32 bytes: X25519(sk_X, ct_X), computed on the device
 * @param {Uint8Array} ciphertext 1120 bytes: ct_M || ct_X, out of the age stanza
 * @param {Uint8Array} pkX        the recipient's X25519 public key
 * @param {Uint8Array} mlkemSeed  32 bytes, from the device
 * @returns {Uint8Array} the 32-byte X-Wing shared secret. ct_M never leaves the host.
 */
function splitDecapsulate(ssX, ciphertext, pkX, mlkemSeed) {
  const { ml_kem768 } = deps();
  if (ssX.length !== 32) throw new Error('ss_X must be 32 bytes');
  if (ciphertext.length !== XWING_CT) {
    throw new Error(`X-Wing ct must be ${XWING_CT} bytes, got ${ciphertext.length}`);
  }
  const ctM = ciphertext.subarray(0, MLKEM_CT);
  const ctX = ciphertext.subarray(MLKEM_CT, XWING_CT);
  const { secretKey: skM } = mlkemKeypairFromSeed(mlkemSeed);
  return xwingCombiner(ml_kem768.decapsulate(ctM, skM), ssX, ctX, pkX);
}

/** ct_X - the only 32 bytes of a stanza ciphertext the device ever sees. */
function ctXOf(ciphertext) {
  return ciphertext.subarray(MLKEM_CT, XWING_CT);
}

/**
 * Standard X-Wing encapsulation, the sender's side. Mirrors xwing.py's
 * xwing_encaps_host(). Here it is the oracle: split decapsulation is checked
 * against what an ordinary encapsulation produced.
 */
function xwingEncapsHost(pk) {
  const { ml_kem768, x25519 } = deps();
  if (pk.length !== XWING_PK) {
    throw new Error(`X-Wing pk must be ${XWING_PK} bytes, got ${pk.length}`);
  }
  const pkM = pk.subarray(0, MLKEM_PK);
  const pkX = pk.subarray(MLKEM_PK, XWING_PK);

  const ekX = x25519.utils.randomSecretKey();
  const ctX = x25519.getPublicKey(ekX);
  const ssX = x25519.getSharedSecret(ekX, pkX);

  const { cipherText: ctM, sharedSecret: ssM } = ml_kem768.encapsulate(pkM);

  return {
    sharedSecret: xwingCombiner(ssM, ssX, ctX, pkX),
    ciphertext: concatBytes(ctM, ctX),
  };
}

/** X25519 on the device's behalf, for a test that has no device. */
function x25519Base(skX) {
  return deps().x25519.getPublicKey(skX);
}

/** ss_X, the one value a real device computes and returns. */
function x25519Shared(skX, ctX) {
  return deps().x25519.getSharedSecret(skX, ctX);
}

/** A random X25519 secret, for standing in for a device that is not here. */
function x25519Secret() {
  return deps().x25519.utils.randomSecretKey();
}

/* ---- the derived age identity -------------------------------------------
 * Mirrors derived_xwing.py's encode_identity/decode_identity: unpadded base32,
 * uppercase, behind a prefix that is deliberately NOT the slot identity's. A
 * derived identity carries a label and no slot number, which is the whole
 * difference between the two - so the encoding has to be distinguishable, not
 * merely different.
 */
const DERIVED_PREFIX = 'AGE-PLUGIN-ONLYKEY-DERIVED-';
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function encodeIdentity(label) {
  if (typeof label !== 'string' || !label) {
    throw new Error('derived identity needs a non-empty label');
  }
  return DERIVED_PREFIX + base32Encode(Buffer.from(label, 'utf8')).toUpperCase();
}

/** @returns {{derived: true, label: string}|null} - null for anything else. */
function decodeIdentity(s) {
  const upper = String(s).trim().toUpperCase();
  if (!upper.startsWith(DERIVED_PREFIX)) return null;
  const b32 = upper.slice(DERIVED_PREFIX.length);
  return { derived: true, label: Buffer.from(base32Decode(b32)).toString('utf8') };
}

module.exports = {
  probe,
  PACKAGES,
  mlkemKeypairFromSeed,
  buildRecipient,
  xwingCombiner,
  splitDecapsulate,
  ctXOf,
  xwingEncapsHost,
  x25519Base,
  x25519Shared,
  x25519Secret,
  encodeIdentity,
  decodeIdentity,
  DERIVED_PREFIX,
  XWING_LABEL,
  MLKEM_PK,
  MLKEM_CT,
  XWING_PK,
  XWING_CT,
  SEED,
};
