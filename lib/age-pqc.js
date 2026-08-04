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

/* ---- bech32 --------------------------------------------------------------
 * BIP-173's algorithm, with no length cap: a derived recipient is 1216 bytes,
 * which encodes to 1964 characters, and bech32's usual 90-character limit is a
 * Bitcoin address rule that age does not apply.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Checksum(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i += 1) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

/** 8-bit bytes <-> 5-bit groups. */
function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('invalid value for convertBits');
    acc = ((acc << from) | value) & 0xFFFFFFFF;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('invalid padding in convertBits');
  }
  return out;
}

function bech32Encode(hrp, bytes) {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  const combined = [...data, ...bech32Checksum(hrp, data)];
  return hrp + '1' + combined.map((d) => CHARSET[d]).join('');
}

/** @returns {{hrp: string|null, data: Uint8Array|null}} */
function bech32Decode(str) {
  const s = String(str);
  const sep = s.lastIndexOf('1');
  if (sep < 1 || sep + 7 > s.length) return { hrp: null, data: null };

  const hrp = s.slice(0, sep);
  const chars = s.slice(sep + 1);
  const values = [];
  for (const c of chars) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) return { hrp: null, data: null };
    values.push(idx);
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...values]) !== 1) {
    return { hrp: null, data: null };
  }

  try {
    return { hrp, data: Uint8Array.from(convertBits(values.slice(0, -6), 5, 8, false)) };
  } catch {
    return { hrp: null, data: null };
  }
}

/* ---- recipients and identities ------------------------------------------
 * Both are bech32, and the identity's HRP is deliberately the SAME as a
 * slot identity's: `age` chooses which plugin binary to exec from that literal
 * prefix, so a distinct HRP would not be a tidier encoding, it would break
 * dispatch entirely. What separates a derived identity from a slot one is the
 * first payload byte, a 0xFF marker.
 *
 * This kit shipped the superseded scheme until the web app's own age_pqc.js
 * was put beside it - `AGE-PLUGIN-ONLYKEY-DERIVED-` plus unpadded base32, which
 * python-onlykey no longer emits and `age` rejects outright.
 */
const RECIPIENT_HRP = 'age1onlykey';
const IDENTITY_HRP = 'age-plugin-onlykey-';   // must match cli.py's IDENTITY_HRP
const DERIVED_MARKER = 0xFF;

function encodeRecipient(pubkey) {
  return bech32Encode(RECIPIENT_HRP, pubkey);
}

function decodeRecipient(recipient) {
  const { hrp, data } = bech32Decode(String(recipient).trim().toLowerCase());
  if (hrp !== RECIPIENT_HRP || data === null) {
    throw new Error(`not a valid ${RECIPIENT_HRP} recipient: ${recipient}`);
  }
  return data;
}

function encodeIdentity(label) {
  if (typeof label !== 'string' || !label) {
    throw new Error('derived identity needs a non-empty label');
  }
  const payload = concatBytes(Uint8Array.of(DERIVED_MARKER), Buffer.from(label, 'utf8'));
  return bech32Encode(IDENTITY_HRP, payload).toUpperCase();
}

/** @returns {{derived: true, label: string}|null} - null for a slot identity. */
function decodeIdentity(s) {
  const { hrp, data } = bech32Decode(String(s).trim().toLowerCase());
  if (hrp !== IDENTITY_HRP || !data || data.length < 1 || data[0] !== DERIVED_MARKER) {
    return null;
  }
  return { derived: true, label: Buffer.from(data.subarray(1)).toString('utf8') };
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
  encodeRecipient,
  decodeRecipient,
  bech32Encode,
  bech32Decode,
  RECIPIENT_HRP,
  IDENTITY_HRP,
  DERIVED_MARKER,
  XWING_LABEL,
  MLKEM_PK,
  MLKEM_CT,
  XWING_PK,
  XWING_CT,
  SEED,
};
