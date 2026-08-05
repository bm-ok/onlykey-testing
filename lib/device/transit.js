/*
 * transit.js - the WebAuthn tunnel's data-in-transit encryption.
 *
 * `lib/device/tunnel.js` frames a vendor command as a fabricated credential ID
 * and reads the answer out of an assertion's signature. That is enough for
 * OKCONNECT, which is how `12-webauthn-tunnel` gets by without this file. It is
 * NOT enough for any other tunnelled command: `bridge_to_onlykey()` runs
 * `okcrypto_aes_crypto_box(client_handle, handle_len, true)` over the whole
 * payload before it looks at the command, so an unencrypted request is
 * decrypted into noise and dispatched as noise.
 *
 * So this is the second half of the client, and it is written here rather than
 * borrowed from the shipped library for the reason section 1 exists: a test that
 * needs `onlykey-fido2` needs `webapp-lib` and stops being hardware-capable.
 * `03-xwing-derive` takes the other route deliberately - it lets the library
 * send the option bytes - and that is the right call there because the SUBJECT
 * is the library. Here the subject is the firmware's chunking, so the client has
 * to be ours.
 *
 * THE HANDSHAKE, from `ok_extension.cpp`'s OKCONNECT branch:
 *
 *   1. The client sends its own X25519 public key inside a 43-byte prefix -
 *      `set_time()` reads a big-endian epoch at payload[5..8], the public key is
 *      at payload[9..40], then a browser byte and an OS byte. The 43 is
 *      confirmed by the derive path, which reads its own argument at
 *      `client_handle + 43`.
 *   2. The device generates a keypair with `crypto_box_keypair()` and answers
 *      with its 32-byte public key followed by its model string.
 *   3. Both sides compute `crypto_box_beforenm()` and SHA256 it:
 *
 *          transit_key = SHA256( HSalsa20( X25519(sk, pk), 16 zero bytes ) )
 *
 *      That is NaCl's beforenm, NOT the raw X25519 output - which is the one
 *      thing here that node:crypto cannot do on its own, and the reason this
 *      file needs `@noble/ciphers`' `hsalsa`.
 *
 * THE BOX ITSELF IS PLAIN AES-256-GCM KEYSTREAM. `okcrypto_aes_crypto_box()`
 * uses a TWELVE-BYTE ZERO IV, every message, and discards the tag - the
 * `gcm.encrypt(state, state, len)` call is in place and
 * `large_resp_buffer_offset = len` shows no room for one. Two consequences worth
 * stating because both look like bugs from outside:
 *
 *   - Every message reuses one keystream. Two payloads of the same length XOR to
 *     the XOR of their plaintexts. That is the firmware's design, not this
 *     file's choice, and mirroring it is the only way to talk to it.
 *   - It is length-preserving, so a sealed chunk is exactly as long as its
 *     plaintext and the 228-byte request chunking is unaffected.
 *
 * AND THE SUNDAE LAYER DOES NOT APPLY, which is worth writing down because
 * `okcrypto_aes_gcm_encrypt2()` looks like it does. Its first statement is
 * `okcrypto_split_sundae(state, iv1, len, function1, s)` under `#ifdef
 * FACTORYKEYS`, which IS defined - but `split_sundae()` opens with
 * `if ((*certified_hw != 1 && *certified_hw != 3) || s == false) return;` and the
 * box passes `s = false` both ways. So the extra ChaCha/Salsa layers are skipped
 * for transit and only the AES-GCM keystream remains.
 */
'use strict';

const crypto = require('crypto');

const SIGMA = 'expand 32-byte k';
const PREFIX = 43;              // the OKCONNECT payload prefix, before any data
const IV = Buffer.alloc(12);    // the box's IV, zero every time - see above

/* Probe rather than require at load: @noble/ciphers is optional here, the same
 * way lib/age-pqc.js treats its own dependencies, so a file that needs this
 * skips with a reason instead of failing to load. */
function probe() {
  try {
    require('@noble/ciphers/salsa.js');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      why: '@noble/ciphers is not installed - the tunnel transit box needs hsalsa ' +
        `for NaCl's crypto_box_beforenm (${err.code || err.message})`,
    };
  }
}

const le = (buf) => new Uint32Array(
  Uint8Array.from(buf).buffer, 0, buf.length / 4,
);

/**
 * NaCl's `crypto_box_beforenm`: HSalsa20 over the X25519 shared point.
 * @param {Buffer} theirPublic 32 raw bytes
 * @param {crypto.KeyObject} ourPrivate an x25519 private key
 * @returns {Buffer} 32 bytes
 */
function beforenm(theirPublic, ourPrivate) {
  const { hsalsa } = require('@noble/ciphers/salsa.js');

  const shared = crypto.diffieHellman({
    privateKey: ourPrivate,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), theirPublic]),
      format: 'der',
      type: 'spki',
    }),
  });

  const out = new Uint32Array(8);
  hsalsa(
    le(Buffer.from(SIGMA, 'latin1')),
    le(shared),
    le(Buffer.alloc(16)),
    out,
  );
  return Buffer.from(out.buffer, out.byteOffset, 32);
}

/**
 * The AES key both sides use, from the device's public half and our private one.
 */
function transitKey(devicePublic, ourPrivate) {
  return crypto.createHash('sha256').update(beforenm(devicePublic, ourPrivate)).digest();
}

/** An X25519 pair, with the public half as the 32 raw bytes the wire wants. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
}

/**
 * The 43-byte OKCONNECT payload.
 * @param {Buffer} publicKey our 32 raw bytes
 */
function connectPayload(publicKey, { when = Date.now(), browser = 0x63, os = 0x6C } = {}) {
  const out = Buffer.alloc(PREFIX);
  out.writeUInt32BE(Math.floor(when / 1000), 5);
  publicKey.copy(out, 9);
  out[41] = browser;
  out[42] = os;
  return out;
}

/**
 * Seal or open a transit payload. The operation is its own inverse - one
 * keystream, XORed - so both directions are the same call.
 */
function box(key, data) {
  const c = crypto.createCipheriv('aes-256-gcm', key, IV);
  return Buffer.concat([c.update(Buffer.from(data)), c.final()]);
}

/**
 * Check the beforenm implementation against NaCl's own published vector before
 * trusting it against a device.
 *
 * These are the alice/bob keys from the NaCl documentation, whose beforenm value
 * is the `k` every NaCl box test uses. Getting this wrong would produce a
 * plausible-looking 32 bytes and a device that answers noise, which is a much
 * worse failure to debug than an assertion here.
 *
 * @returns {{ok: boolean, got: string, want: string}}
 */
function selfTest() {
  const aliceSk = Buffer.from(
    '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex');
  const bobPk = Buffer.from(
    'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', 'hex');
  const want = '1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389';

  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), aliceSk]),
    format: 'der',
    type: 'pkcs8',
  });
  const got = beforenm(bobPk, privateKey).toString('hex');
  return { ok: got === want, got, want };
}

module.exports = { probe, keypair, beforenm, transitKey, connectPayload, box, selfTest, PREFIX };
