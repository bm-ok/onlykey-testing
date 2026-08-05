/*
 * The `hmac-secret` extension: a symmetric secret the device derives per
 * credential, per salt, and never stores.
 *
 * The firmware ADVERTISES it in GET_INFO and nothing has ever exercised it,
 * which is the worst combination there is. Clients feature-detect off that
 * list: a browser or a password manager reads `extensions: ["credProtect",
 * "hmac-secret"]`, believes it, and builds on it. If the implementation behind
 * the flag is broken the device still looks healthy - the break shows up as a
 * client failing, with nothing wrong on the device side to point at.
 *
 * WHAT IT IS FOR, since the assertions only make sense against it: hmac-secret
 * turns a FIDO2 credential into a source of symmetric key material. Give it a
 * salt, get 32 bytes back, deterministically, forever - and the bytes exist
 * nowhere but in that device. Password managers use it to wrap a vault key.
 * That is why the properties below are the ones tested: same salt must give the
 * same secret or the vault never opens again, and a different credential must
 * give a different secret or one key unlocks another's data.
 *
 * THE PROTOCOL, which is more than "set a flag". Getting a secret out needs a
 * key exchange with the authenticator first:
 *
 *   1. authenticatorClientPIN(getKeyAgreement) -> the device's P-256 COSE key.
 *      This works with NO PIN SET - clientPin is false in GET_INFO and it still
 *      answers, because the exchange is about confidentiality of the salt
 *      rather than about authentication.
 *   2. sharedSecret = SHA-256(ECDH(platform private, device public).x), which
 *      is pinUvAuthProtocol 1. The device advertises [1] and answers 0x7f to
 *      protocol 2, so there is exactly one thing to implement.
 *   3. saltEnc  = AES-256-CBC(sharedSecret, IV=0) over the salt, no padding
 *      saltAuth = HMAC-SHA256(sharedSecret, saltEnc), first 16 bytes
 *   4. The device answers with its output encrypted the same way.
 *
 * All of that is node:crypto - P-256 ECDH, AES-CBC, HMAC, SHA-256 - so there is
 * no optional dependency and nothing here trusts the device to check itself.
 *
 * NOT WHAT PLAN SAID IT WAS. PLAN recorded hmac-secret as "the only thing that
 * would reach the unproven null-dereference patch at okcore.cpp:7645". Those
 * are two unrelated features that share a word. FIDO2's hmac-secret lives in
 * fido2/ctap_parse.cpp and fido2/ctap.cpp; okcore.cpp:7645 is inside
 * process_setreport(), the Yubikey-style HMAC-SHA1 challenge-response that
 * arrives over the KEYBOARD interface as a SET_REPORT and is tagged OKHMAC. The
 * null-pointer patch is elsewhere again, in set_built_in_pin() near line 855,
 * which the vendor dispatcher reaches only on a DUO with an UNINITIALIZED
 * device. None of the three is reachable from here.
 *
 * SURFACES - see PRODUCTION.md. FIDO (0xF1D0) throughout, plus button presses.
 * The console is not read at all: user presence arrives as KEEPALIVE(UP_NEEDED)
 * on the FIDO interface, which is a client-visible signal, so this whole file
 * survives into a production walk.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { Ctap2, CTAP2_CMD } = require('../../lib/device/ctap2');
const cbor = require('../../lib/device/cbor');

const RP_ID = 'okt.hmac.test';
const USER_ID = Buffer.from('okt-hmac-user');

const FLAG_AT = 0x40;
const UP_NEEDED = 2;

/* CTAP2 hmac-secret extension keys, from the spec. */
const EXT_KEY_AGREEMENT = 1;
const EXT_SALT_ENC = 2;
const EXT_SALT_AUTH = 3;

/** rpIdHash(32) | flags(1) | signCount(4) | [attested data] | [extensions CBOR] */
function parseAuthData(authData) {
  const out = {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };

  let at = 37;
  if (out.flags & FLAG_AT) {
    out.aaguid = authData.subarray(at, at + 16);
    const idLen = authData.readUInt16BE(at + 16);
    out.credentialId = authData.subarray(at + 18, at + 18 + idLen);
    at += 18 + idLen;
    /*
     * The COSE key and any extension map are two CBOR items back to back with
     * no length between them, so the only way past the key is to decode it and
     * be told where it ended. cbor.decode() refuses a buffer with anything after
     * the item - the right default, and wrong here - so this uses decodeFirst(),
     * which exists for exactly this shape.
     */
    const key = cbor.decodeFirst(authData, at);
    out.coseKey = key.value;
    at = key.next;
  }

  const tail = authData.subarray(at);
  if (tail.length) out.extensions = cbor.decode(tail);
  return out;
}

describe('the hmac-secret extension', {
  state: 'initialized',
  requires: ['crypto'],
  timeoutMs: 300000,
}, () => {
  /** A CTAP2 channel on an unlocked device. Every test builds its own. */
  async function channel(device, signal) {
    await device.ensureUnlocked(PINS.primary, { signal });
    const ctap = new Ctap2(device, { signal });
    await ctap.init({ signal });
    return ctap;
  }

  /** Press once when the device asks, and only once. */
  const presser = (device, log) => {
    let pressed = 0;
    return {
      onKeepAlive: async (status) => {
        if (status === UP_NEEDED && !pressed) {
          pressed++;
          log('device asked for user presence - pressing button 1');
          device.press(1);
        }
      },
      get count() { return pressed; },
    };
  };

  /**
   * The key exchange, pinUvAuthProtocol 1.
   *
   * SHA-256 of the ECDH x-coordinate ONLY - not the full point, and not the
   * DER-wrapped secret. node:crypto's diffieHellman() on P-256 returns exactly
   * the 32-byte x, which is what the spec wants.
   */
  async function keyExchange(ctap, signal) {
    const reply = await ctap.send(CTAP2_CMD.CLIENT_PIN,
      cbor.encode(new Map([[1, 1], [2, 2]])), { signal });

    const cose = reply.get(1);
    const x = cose.get(-2);
    const y = cose.get(-3);

    const devicePub = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex'), x, y,
      ]),
      format: 'der',
      type: 'spki',
    });

    const platform = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const shared = crypto.createHash('sha256')
      .update(crypto.diffieHellman({ privateKey: platform.privateKey, publicKey: devicePub }))
      .digest();

    /* The platform's own public key, as the COSE map the device expects back. */
    const raw = platform.publicKey.export({ format: 'der', type: 'spki' }).subarray(-64);
    const platformCose = new Map([
      [1, 2], [3, -25], [-1, 1], [-2, raw.subarray(0, 32)], [-3, raw.subarray(32)],
    ]);

    return { shared, platformCose };
  }

  const aes = (shared, data, decrypt = false) => {
    const c = decrypt
      ? crypto.createDecipheriv('aes-256-cbc', shared, Buffer.alloc(16))
      : crypto.createCipheriv('aes-256-cbc', shared, Buffer.alloc(16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  };

  /** Register a credential, with or without asking for the extension. */
  async function register(ctap, device, log, signal, { hmacSecret = true } = {}) {
    const params = new Map([
      [1, crypto.randomBytes(32)],
      [2, new Map([['id', RP_ID], ['name', RP_ID]])],
      [3, new Map([['id', USER_ID], ['name', 'okt'], ['displayName', 'okt']])],
      [4, [new Map([['alg', -7], ['type', 'public-key']])]],
    ]);
    if (hmacSecret) params.set(6, new Map([['hmac-secret', true]]));

    const press = presser(device, log);
    const made = await ctap.makeCredential(params, { timeoutMs: 60000, signal, ...press });
    const authData = parseAuthData(made.get(2));
    return { authData, pressed: press.count };
  }

  /** Ask a credential for the secret behind a salt. */
  async function secretFor(ctap, device, log, signal, credentialId, salt) {
    const { shared, platformCose } = await keyExchange(ctap, signal);
    const saltEnc = aes(shared, salt);
    const saltAuth = crypto.createHmac('sha256', shared).update(saltEnc).digest().subarray(0, 16);

    const params = new Map([
      [1, RP_ID],
      [2, crypto.randomBytes(32)],
      [3, [new Map([['id', credentialId], ['type', 'public-key']])]],
      [4, new Map([['hmac-secret', new Map([
        [EXT_KEY_AGREEMENT, platformCose],
        [EXT_SALT_ENC, saltEnc],
        [EXT_SALT_AUTH, saltAuth],
      ])]])],
    ]);

    const press = presser(device, log);
    const assertion = await ctap.getAssertion(params, { timeoutMs: 60000, signal, ...press });
    const authData = parseAuthData(assertion.get(2));

    if (!authData.extensions) throw new Error('the assertion carried no extension output');
    const encrypted = authData.extensions.get('hmac-secret');
    if (!encrypted) throw new Error(`no hmac-secret in ${[...authData.extensions.keys()]}`);
    return aes(shared, encrypted, true);
  }

  it('is advertised in GET_INFO, which is what clients feature-detect on',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The cheapest test in the file and the one that justifies the rest. A
       * client reads this list and commits to a design; if the flag is present
       * the behaviour below has to be present too, and that pairing is what is
       * actually being asserted here.
       */
      const ctap = await channel(device, signal);
      const info = await ctap.getInfo({ signal });

      const extensions = info.get(2) || [];
      const options = info.get(4) || new Map();
      log(`extensions: ${JSON.stringify(extensions)}`);
      log(`pinUvAuthProtocols: ${JSON.stringify(info.get(6))}`);

      assert.ok(extensions.includes('hmac-secret'),
        `hmac-secret is not advertised: ${JSON.stringify(extensions)}`);

      /*
       * And the exchange it needs works WITHOUT a PIN, which is not obvious:
       * clientPin is false here. getKeyAgreement is about keeping the salt
       * confidential on the wire, not about authenticating anybody, so a device
       * with no PIN still has to answer it - and if it did not, hmac-secret
       * would be advertised and unusable.
       */
      assert.equal(options.get('clientPin'), false,
        'this fixture is meant to have no FIDO2 PIN set');

      const { shared } = await keyExchange(ctap, signal);
      assert.equal(shared.length, 32, 'the shared secret should be a SHA-256 digest');
    });

  it('is echoed back by MakeCredential when the credential asks for it',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The device has to record, at registration time, that this credential
       * carries the extension - and say so. A device that accepted the request
       * and silently made an ordinary credential would fail much later, at the
       * first GetAssertion, looking like a client bug.
       */
      const ctap = await channel(device, signal);
      const { authData, pressed } = await register(ctap, device, log, signal);

      assert.ok(pressed, 'the device never asked for user presence');
      assert.ok(authData.credentialId && authData.credentialId.length,
        'no credential id came back');
      assert.ok(authData.extensions, 'the attestation carried no extension map at all');

      log(`extensions echoed: ${JSON.stringify([...authData.extensions])}`);
      assert.equal(authData.extensions.get('hmac-secret'), true,
        'the credential was made without recording the hmac-secret extension');
    });

  it('is NOT echoed when the credential does not ask for it',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The negative half, and it is what makes the positive one mean something:
       * a device that echoed the extension unconditionally would pass the test
       * above while telling every client that every credential has a secret
       * behind it.
       */
      const ctap = await channel(device, signal);
      const { authData } = await register(ctap, device, log, signal, { hmacSecret: false });

      const echoed = authData.extensions && authData.extensions.get('hmac-secret');
      log(`extensions: ${authData.extensions ? JSON.stringify([...authData.extensions]) : 'none'}`);
      assert.ok(!echoed,
        'a credential that did not request hmac-secret came back carrying it');
    });

  it('returns 32 bytes for a salt, and the same 32 bytes every time',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * THE PROPERTY THE FEATURE EXISTS FOR. A password manager wraps its vault
       * key with these bytes; if they are not reproducible the vault is gone.
       * Two calls, separate key exchanges - so a fresh shared secret and a fresh
       * saltEnc each time - and the plaintext output has to be identical.
       *
       * That the two ciphertexts differ while the plaintexts match is itself
       * worth having: it says the output really is being encrypted to the
       * exchange rather than returned in the clear.
       */
      const ctap = await channel(device, signal);
      const { authData } = await register(ctap, device, log, signal);
      const salt = crypto.randomBytes(32);

      const first = await secretFor(ctap, device, log, signal, authData.credentialId, salt);
      log(`secret: ${first.toString('hex')}`);
      assert.equal(first.length, 32, `expected 32 bytes, got ${first.length}`);
      assert.notEqual(first.toString('hex'), '00'.repeat(32), 'the secret is all zeros');
      assert.notEqual(first.toString('hex'), salt.toString('hex'),
        'the device returned the salt back rather than a secret derived from it');

      const second = await secretFor(ctap, device, log, signal, authData.credentialId, salt);
      assert.bytes(second, first,
        'the same credential and salt produced two different secrets - nothing could be unwrapped twice');
    });

  it('gives a different secret for a different salt', async ({ device, assert, signal, log }) => {
    /*
     * SURFACE: FIDO - survives into a production walk.
     *
     * Without this, everything above holds for a device that ignores the salt
     * and returns one secret per credential. That would look identical to a
     * working implementation until somebody used two salts.
     */
    const ctap = await channel(device, signal);
    const { authData } = await register(ctap, device, log, signal);

    const a = await secretFor(ctap, device, log, signal, authData.credentialId, Buffer.alloc(32, 1));
    const b = await secretFor(ctap, device, log, signal, authData.credentialId, Buffer.alloc(32, 2));
    log(`salt 0x01 -> ${a.toString('hex').slice(0, 32)}...`);
    log(`salt 0x02 -> ${b.toString('hex').slice(0, 32)}...`);

    assert.notEqual(a.toString('hex'), b.toString('hex'),
      'two different salts produced the same secret - the salt is not reaching the derivation');
  });

  it('gives a different secret for a different credential', async ({ device, assert, signal, log }) => {
    /*
     * SURFACE: FIDO - survives into a production walk.
     *
     * The isolation property, and the one with security consequences rather
     * than usability ones: if two credentials derived the same secret from the
     * same salt, one site's credential would unwrap another site's vault.
     */
    const ctap = await channel(device, signal);
    const salt = Buffer.alloc(32, 7);

    const one = await register(ctap, device, log, signal);
    const two = await register(ctap, device, log, signal);
    assert.notEqual(one.authData.credentialId.toString('hex'),
      two.authData.credentialId.toString('hex'),
      'two registrations produced the same credential id');

    const a = await secretFor(ctap, device, log, signal, one.authData.credentialId, salt);
    const b = await secretFor(ctap, device, log, signal, two.authData.credentialId, salt);
    log(`credential 1 -> ${a.toString('hex').slice(0, 32)}...`);
    log(`credential 2 -> ${b.toString('hex').slice(0, 32)}...`);

    assert.notEqual(a.toString('hex'), b.toString('hex'),
      'two credentials derived the same secret from one salt - they are not isolated');
  });
});
