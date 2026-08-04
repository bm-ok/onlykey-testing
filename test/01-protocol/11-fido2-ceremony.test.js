/*
 * A real FIDO2 ceremony: register a credential, then authenticate with it.
 *
 * The old kit could do this only through
 * @vincss-public-projects/fido2-client over hidapi, which means a kernel device
 * node, which means it could never run in CI. The protocol layer is ported into
 * lib/device/ctap2.js and pointed at the kit's device handle instead, so the
 * same ceremony runs on the emulator's in-process bus and on a physical key -
 * no browser, no hidapi, no node-hid.
 *
 * The interesting part is user presence. While the authenticator waits for a
 * finger it sends KEEPALIVE(UP_NEEDED) about ten times a second; a client that
 * treats those as errors cannot finish a ceremony. Here they are the cue to
 * press the button, which makes this the one test that drives both halves of
 * the device at once - the CTAP2 protocol on one interface and the touch
 * handler on another.
 *
 * Everything cryptographic is checked in pure JS against node:crypto: the
 * rpIdHash the device computed, and the assertion signature it produced with a
 * key we only ever see the public half of.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { Ctap2 } = require('../../lib/device/ctap2');
const cbor = require('../../lib/device/cbor');

const RP_ID = 'okt.test';
const USER_ID = Buffer.from('okt-user-0001');

/* authData flags, from the WebAuthn spec. */
const FLAG_UP = 0x01;          // user present
const FLAG_AT = 0x40;          // attested credential data included

/** rpIdHash(32) | flags(1) | signCount(4) | [aaguid(16) | idLen(2) | id | COSE] */
function parseAuthData(authData) {
  const out = {
    rpIdHash: authData.subarray(0, 32),
    flags: authData[32],
    signCount: authData.readUInt32BE(33),
  };
  if ((out.flags & FLAG_AT) === 0) return out;

  out.aaguid = authData.subarray(37, 53);
  const idLen = authData.readUInt16BE(53);
  out.credentialId = authData.subarray(55, 55 + idLen);
  out.coseKey = cbor.decode(authData.subarray(55 + idLen));
  return out;
}

/** A COSE_Key for ES256 into something node:crypto will verify with. */
function coseToPublicKey(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty !== 2 || alg !== -7) {
    throw new Error(`expected an ES256 EC2 key, got kty=${kty} alg=${alg}`);
  }
  return crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: cose.get(-2).toString('base64url'),
      y: cose.get(-3).toString('base64url'),
    },
    format: 'jwk',
  });
}

describe('FIDO2 ceremony',
  { state: 'initialized', requires: ['crypto'], timeoutMs: 120000 }, () => {
    let ctap = null;
    let registered = null;
    const clientDataHash = crypto.randomBytes(32);

    it('unlocks and allocates a CTAPHID channel', async ({ device, assert, signal }) => {
      await device.unlock(PINS.primary, { signal });

      ctap = new Ctap2(device, { signal });
      const cid = await ctap.init();

      assert.equal(cid.length, 4);
      assert.notEqual(cid.toString('hex'), 'ffffffff', 'the broadcast channel is not a channel');
    });

    it('reports what it can do, in CBOR', async ({ device, assert }) => {
      const info = await ctap.getInfo();
      const versions = info.get(1);
      const extensions = info.get(2) || [];
      const options = info.get(4);

      assert.ok(versions.includes('FIDO_2_0'), `versions: ${JSON.stringify(versions)}`);
      assert.equal(info.get(3).length, 16, 'the AAGUID should be 16 bytes');

      /*
       * These are the two extensions this firmware advertises, and hmac-secret
       * is the one that reaches the challenge-response paths nothing else in
       * the kit touches.
       */
      assert.ok(extensions.includes('hmac-secret'), `extensions: ${JSON.stringify(extensions)}`);
      assert.equal(options.get('up'), true, 'user presence should be supported');
    });

    it('registers a credential, asking for a finger on the way',
      async ({ device, assert, log, signal }) => {
        const params = new Map([
          [1, clientDataHash],
          [2, new Map([['id', RP_ID], ['name', 'OnlyKey test kit']])],
          [3, new Map([
            ['id', USER_ID], ['name', 'okt'], ['displayName', 'OKT User'],
          ])],
          [4, [new Map([['alg', -7], ['type', 'public-key']])]],   // ES256
        ]);

        let pressed = 0;
        const response = await ctap.makeCredential(params, {
          timeoutMs: 60000,
          signal,
          /*
           * The device is telling us it is waiting for a touch. Pressing once
           * is enough - the rest of the KEEPALIVEs are it waiting for the
           * press to be noticed.
           */
          onKeepAlive: async (status) => {
            if (status === 2 && !pressed) {
              pressed++;
              log('device asked for user presence - pressing button 1');
              device.press(1);
            }
          },
        });

        assert.ok(pressed, 'the device never asked for user presence');
        assert.ok(ctap.askedForUserPresence, 'no UP_NEEDED keepalive was recorded');

        assert.equal(response.get(1), 'packed', 'unexpected attestation format');
        registered = parseAuthData(response.get(2));

        assert.ok((registered.flags & FLAG_UP) !== 0, 'the UP flag is not set');
        assert.ok((registered.flags & FLAG_AT) !== 0, 'no attested credential data');
        assert.ok(registered.credentialId.length > 0, 'no credential id');
      });

    it('computed the rpIdHash the way we would have', async ({ assert }) => {
      /*
       * The first pure-JS crypto check of the ceremony, and a cheap one: the
       * device hashed the RP id itself, and we can hash it too. A mismatch
       * means the device registered the credential against a different origin
       * from the one asked for.
       */
      const expected = crypto.createHash('sha256').update(RP_ID, 'utf8').digest();
      assert.equal(registered.rpIdHash.toString('hex'), expected.toString('hex'));
    });

    it('authenticates with that credential, and the signature verifies',
      async ({ device, assert, log, signal }) => {
        const challenge = crypto.randomBytes(32);
        const params = new Map([
          [1, RP_ID],
          [2, challenge],
          [3, [new Map([['id', registered.credentialId], ['type', 'public-key']])]],
        ]);

        let pressed = 0;
        const assertion = await ctap.getAssertion(params, {
          timeoutMs: 60000,
          signal,
          onKeepAlive: async (status) => {
            if (status === 2 && !pressed) {
              pressed++;
              log('device asked for user presence - pressing button 1');
              device.press(1);
            }
          },
        });

        const authData = assertion.get(2);
        const signature = assertion.get(3);
        assert.ok(authData && authData.length >= 37, 'no authData in the assertion');
        assert.ok(signature && signature.length > 0, 'no signature in the assertion');

        /*
         * The whole point. WebAuthn signs authenticatorData || clientDataHash
         * with the credential's private key - which never leaves the device -
         * and we verify it here with the public half the registration handed
         * back. If this passes, the device did real ECDSA over exactly the
         * bytes the protocol says it should have.
         */
        const publicKey = coseToPublicKey(registered.coseKey);
        const signedOver = Buffer.concat([authData, challenge]);
        const ok = crypto.verify('sha256', signedOver, publicKey, signature);

        assert.ok(ok, 'the assertion signature did not verify against the registered key');

        /* And it must not verify against something else, or the check above
         * would pass for any bytes at all. */
        const tampered = Buffer.concat([authData, crypto.randomBytes(32)]);
        assert.ok(!crypto.verify('sha256', tampered, publicKey, signature),
          'the signature verified over the wrong challenge');
      });

    it('refuses an assertion for a credential it does not know',
      async ({ assert, signal }) => {
        const params = new Map([
          [1, RP_ID],
          [2, crypto.randomBytes(32)],
          [3, [new Map([['id', crypto.randomBytes(32)], ['type', 'public-key']])]],
        ]);

        const err = await assert.rejects(
          () => ctap.getAssertion(params, { timeoutMs: 20000, signal }),
          /CTAP2 error/,
          'the device produced an assertion for a credential it never issued'
        );
        /* NO_CREDENTIALS is the spec answer; anything else is worth seeing. */
        assert.match(err.message, /NO_CREDENTIALS|NOT_ALLOWED|0x/);
      });
  });
