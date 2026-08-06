/*
 * pgp-rsa.js - one PGP key, split across the two RSA slots the web app hardcodes.
 *
 * `onlykey-pgp.js`'s `slotid()` is `slot == OKSIGN ? 2 : 1`, so the encrypt and
 * decrypt pages can only ever use RSA slot 2 to sign and RSA slot 1 to decrypt.
 * A PGP key is a primary that signs plus a subkey that encrypts, which is the
 * same shape from the other end - so one generated key supplies both slots, and
 * that pairing is the thing worth having in one place rather than in each file
 * that needs it.
 *
 * Here rather than in a test file because two files now need exactly this
 * (03-gui/08 headless and 03-gui/14 in the browser) and a third would be the
 * point at which the copies start to drift. 01-protocol/19-rsa-keys and
 * 23-rsa-tunnel keep their own loaders deliberately: theirs are about the
 * FRAMING and each drives a variation of it, which is their subject rather than
 * a means to something else.
 *
 * The key comes from openpgp.js, which is what makes an oracle possible at all:
 * the device is given only the factors, so anything the web app's library
 * produces can be judged by an implementation that has never spoken to the
 * device.
 */
'use strict';

const { PINS } = require('./config');
const { IFACE, okmsg } = require('./device');
const pqc = require('./pqc');

const CHUNK = 57;                     // vendor-interface payload per report
const TYPE_2048 = 2;                  // the low nibble is the modulus in 128-byte units
const RSA_2048_BYTES = 256;

/**
 * The two roles, and which slot and feature bit each one means.
 *
 * The feature bits share a byte with the size nibble - bit 5 decrypt, bit 6
 * sign - so a slot loaded for one role REFUSES the other by name, which
 * 19-rsa-keys pins.
 */
const ROLES = {
  sign: { slot: 2, feature: 64, half: 'primary', what: 'signing (primary)' },
  decrypt: { slot: 1, feature: 32, half: 'sub', what: 'encryption (subkey)' },
};

/**
 * Generate a PGP RSA key and hand back both halves in device terms.
 *
 * The ORDER of the factors does not matter and was measured rather than
 * assumed: openpgp.js emits p < q (RFC 4880's convention, `u = p⁻¹ mod q`) and
 * node:crypto's JWK export emits p > q (PKCS#1's), and the device signs and
 * decrypts correctly with either, because `rsa_sign()` recomputes D, DP, DQ and
 * QP from whatever it was handed. E is hardcoded to 65537 in the firmware,
 * which is also what openpgp.js chooses.
 *
 * @param {object} openpgp webenv.openpgp()
 * @param {Array} userIDs openpgp's userIDs
 */
async function pgpRsaKey(openpgp, userIDs) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa', rsaBits: 2048, userIDs, format: 'object',
  });
  const half = (packet) => ({
    pq: Buffer.concat([
      Buffer.from(packet.privateParams.p), Buffer.from(packet.privateParams.q),
    ]),
    n: Buffer.from(packet.publicParams.n),
    e: Buffer.from(packet.publicParams.e),
  });
  return {
    privateKey,
    publicKey,
    armored: publicKey.armor(),
    primary: half(privateKey.keyPacket),
    sub: half(privateKey.subkeys[0].keyPacket),
  };
}

/** An unsolicited multi-report answer, gathered off the vendor interface. */
async function collectVendor(device, since, want, { signal, timeoutMs = 30000 }) {
  const expected = Math.ceil(want / 64);
  const deadline = Date.now() + timeoutMs;
  let reports = device.reportsSince(IFACE.VENDOR, since);
  while (reports.length < expected && Date.now() < deadline) {
    await device.sleep(100, { signal });
    reports = device.reportsSince(IFACE.VENDOR, since);
  }
  return Buffer.concat(reports).subarray(0, want);
}

/**
 * Put the named roles of `key` into their slots, and prove they landed.
 *
 * One config-mode session covers both writes; the readback needs a different
 * state entirely, because OKGETPUBKEY is REFUSED in config mode - it prints to
 * the console and sends no vendor reply at all, so a client that writes a key
 * and reads it back without leaving first sees the read time out with nothing
 * to explain it (02-cli/12-cli-slots).
 *
 * Leaves the device unlocked and out of config mode, which is what every caller
 * wants next and what a page needs before it opens.
 *
 * @param {object} device
 * @param {object} key from pgpRsaKey()
 * @param {string[]} roles any of 'sign', 'decrypt'
 * @param {object} ctx {signal, assert, log}
 */
async function loadSlots(device, key, roles, { signal, assert, log = () => {} }) {
  const wanted = roles.map((name) => {
    const role = ROLES[name];
    if (!role) throw new Error(`no such RSA role: ${name}`);
    return role;
  });

  await pqc.readyForKeygen(device, { signal });

  for (const w of wanted) {
    const pq = key[w.half].pq;
    const since = device.mark(IFACE.VENDOR);
    for (let i = 0; i < pq.length; i += CHUNK) {
      device.sendVendor({
        msg: okmsg.MSG.OKSETPRIV,
        slot: w.slot,
        /* The KEY going in carries the TYPE BYTE in buffer[6] on every report -
         * not the continuation marker an operation PAYLOAD carries. See
         * 19-rsa-keys; swapping them gives "Error invalid RSA type". */
        field: TYPE_2048 | w.feature,
        payload: pq.subarray(i, i + CHUNK),
      });
      await device.sleep(150, { signal });
    }
    const ack = await device.waitHid(IFACE.VENDOR,
      { since, match: /Successfully|Error/, timeoutMs: 30000, signal });
    assert.match(okmsg.text(ack).trim(), /Successfully set RSA Key/,
      `storing the key in RSA slot ${w.slot}: ${okmsg.text(ack).trim()}`);
  }

  await device.restart({ signal });
  await device.ensureUnlocked(PINS.primary, { signal });

  for (const w of wanted) {
    const since = device.mark(IFACE.VENDOR);
    device.sendVendor({ msg: okmsg.MSG.OKGETPUBKEY, slot: w.slot, field: 0 });
    const published = await collectVendor(device, since, RSA_2048_BYTES, { signal });
    assert.bytes(published, key[w.half].n,
      `RSA slot ${w.slot} published a different modulus than the PGP key it was given`);
    log(`RSA slot ${w.slot} holds the ${w.what} half, modulus ${published.length} bytes`);
  }
}

module.exports = {
  pgpRsaKey, loadSlots, collectVendor, ROLES, RSA_2048_BYTES, TYPE_2048,
};
