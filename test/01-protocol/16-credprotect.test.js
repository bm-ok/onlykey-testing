/*
 * The `credProtect` extension: how hard a credential is to use.
 *
 * The second of the two extensions this firmware advertises in GET_INFO and
 * nothing exercised. Same argument as hmac-secret: clients feature-detect off
 * that list, so a broken implementation behind the flag surfaces as a client
 * failing with a healthy-looking device.
 *
 * WHAT IT IS. credProtect sets a policy on a credential at registration time,
 * and the level is stored WITH the credential rather than on the device:
 *
 *   1  userVerificationOptional             the default; usable as normal
 *   2  userVerificationOptionalWithCredentialIDList
 *                                           usable only when the client already
 *                                           knows the credential id - i.e. not
 *                                           discoverable to a bare GetAssertion
 *   3  userVerificationRequired             usable only with user verification
 *
 * The point of 2 and 3 is privacy and misuse resistance: a level-2 credential
 * does not answer a relying party that is fishing with an empty allowList, and
 * a level-3 one does not answer at all without UV.
 *
 * NO PIN IS NEEDED TO SET ANY OF THE THREE, which is worth stating because the
 * neighbouring rows are not like that. Registration takes the level, stores it,
 * and echoes it - so this whole file is ungated section 1 and runs against a
 * physical key with nothing to opt into. `credMgmt` and `CLIENT_PIN` are the
 * ones that need a client PIN, and they carry `fido-reset` for it.
 *
 * WHAT IS ASSERTED AND WHAT IS NOT. The device has to record the level and say
 * so; that is checkable here and is checked. Whether it ENFORCES level 3 is a
 * question about user verification, and this fixture has no way to verify a
 * user - `clientPin` is false and there is no biometric - so the enforcement
 * path is reached only in the negative: a level-3 credential should be
 * unusable, and that is asserted. Its positive half belongs with the PIN work.
 *
 * SURFACES - see PRODUCTION.md. FIDO (0xF1D0) throughout; user presence arrives
 * as KEEPALIVE(UP_NEEDED), which is client-visible, so the console is not read
 * at all and the file survives into a production walk.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { Ctap2, CTAP2_ERROR } = require('../../lib/device/ctap2');
const cbor = require('../../lib/device/cbor');

const RP_ID = 'okt.credprotect';
const FLAG_AT = 0x40;
const UP_NEEDED = 2;

const LEVEL = {
  OPTIONAL: 1,
  OPTIONAL_WITH_LIST: 2,
  REQUIRED: 3,
};

/** rpIdHash(32) | flags(1) | signCount(4) | [attested] | [extensions] */
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
    /* Two CBOR items back to back; decodeFirst reports where the key ended. */
    const key = cbor.decodeFirst(authData, at);
    out.coseKey = key.value;
    at = key.next;
  }

  const tail = authData.subarray(at);
  if (tail.length) out.extensions = cbor.decode(tail);
  return out;
}

describe('the credProtect extension', {
  state: 'initialized',
  requires: ['crypto'],
  timeoutMs: 300000,
}, () => {
  async function channel(device, signal) {
    await device.ensureUnlocked(PINS.primary, { signal });
    const ctap = new Ctap2(device, { signal });
    await ctap.init({ signal });
    return ctap;
  }

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

  /** Register, optionally asking for a credProtect level and/or rk. */
  async function register(ctap, device, log, signal, { level, rk = false } = {}) {
    const params = new Map([
      [1, crypto.randomBytes(32)],
      [2, new Map([['id', RP_ID], ['name', RP_ID]])],
      [3, new Map([['id', crypto.randomBytes(16)], ['name', 'okt'], ['displayName', 'okt']])],
      [4, [new Map([['alg', -7], ['type', 'public-key']])]],
    ]);
    if (level !== undefined) params.set(6, new Map([['credProtect', level]]));
    if (rk) params.set(7, new Map([['rk', true]]));

    const press = presser(device, log);
    const made = await ctap.makeCredential(params, { timeoutMs: 60000, signal, ...press });
    return { authData: parseAuthData(made.get(2)), pressed: press.count };
  }

  it('records and echoes every level the spec defines',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * All three in one test because they are one endpoint's parameter space,
       * and because the interesting failure is not "level 2 broke" but "the
       * device echoes a constant". Asserting each level comes back AS ITSELF is
       * what rules that out - a device that always answered 1 would satisfy any
       * single-level test.
       */
      const ctap = await channel(device, signal);

      for (const level of [LEVEL.OPTIONAL, LEVEL.OPTIONAL_WITH_LIST, LEVEL.REQUIRED]) {
        const { authData, pressed } = await register(ctap, device, log, signal, { level });
        assert.ok(pressed, `no user presence was asked for at level ${level}`);
        assert.ok(authData.extensions, `level ${level} came back with no extension map`);

        const echoed = authData.extensions.get('credProtect');
        log(`credProtect ${level} -> echoed ${echoed}`);
        assert.equal(echoed, level,
          `asked for credProtect ${level}, the device recorded ${echoed}`);
      }
    });

  it('does not invent the extension for a credential that never asked',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The negative that makes the positives mean something. A device that
       * stamped every credential with a level would pass the test above and
       * would be telling every client that credentials are protected when they
       * are not - which is the direction that matters, since a client reads this
       * to decide whether it may use a credential without verifying the user.
       */
      const ctap = await channel(device, signal);
      const { authData } = await register(ctap, device, log, signal);

      const echoed = authData.extensions && authData.extensions.get('credProtect');
      log(`no credProtect requested -> ${echoed === undefined ? 'absent' : echoed}`);
      assert.ok(echoed === undefined,
        `a credential that asked for nothing came back at credProtect ${echoed}`);
    });

  it('rejects a level that is not one of the three', async ({ device, assert, signal, log }) => {
    /*
     * SURFACE: FIDO - survives into a production walk.
     *
     * Worth having because the failure mode is silent acceptance. A device that
     * stored 4 would leave a credential in a state no client has a rule for,
     * and nothing downstream would notice until something tried to use it.
     * Either a refusal or a documented clamp is fine; storing it verbatim is
     * not, and that is what this distinguishes.
     */
    const ctap = await channel(device, signal);

    let outcome;
    try {
      const { authData } = await register(ctap, device, log, signal, { level: 4 });
      const echoed = authData.extensions && authData.extensions.get('credProtect');
      outcome = `accepted, echoed ${echoed === undefined ? 'nothing' : echoed}`;
      assert.notEqual(echoed, 4,
        'the device stored credProtect 4, which is not a level any client understands');
    } catch (err) {
      outcome = `refused: ${err.message}`;
    }
    log(`credProtect 4 -> ${outcome}`);
  });

  it('will not use a level-3 credential on a device that cannot verify a user',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * Level 3 is userVerificationRequired, and this fixture has no way to
       * verify a user at all - clientPin is false and there is no biometric. So
       * the only half of the enforcement reachable here is the refusal, and a
       * refusal is exactly what a client depends on: level 3 is chosen when the
       * credential must not be usable by presence alone.
       *
       * Asserted as "does not produce a usable assertion" rather than as a
       * specific error, because the spec permits more than one way to say no -
       * NO_CREDENTIALS from filtering the credential out of the allowList is as
       * correct as an explicit refusal, and pinning one would be pinning an
       * implementation choice. Succeeding is the failure.
       */
      const ctap = await channel(device, signal);
      const { authData } = await register(ctap, device, log, signal, { level: LEVEL.REQUIRED });

      const press = presser(device, log);
      let refusal = null;
      let assertion = null;
      try {
        assertion = await ctap.getAssertion(new Map([
          [1, RP_ID],
          [2, crypto.randomBytes(32)],
          [3, [new Map([['id', authData.credentialId], ['type', 'public-key']])]],
        ]), { timeoutMs: 60000, signal, ...press });
      } catch (err) {
        refusal = err;
      }

      if (refusal) {
        log(`level 3 without UV refused: ${refusal.message}`);
      } else {
        log(`level 3 without UV produced an assertion: ${assertion && [...assertion.keys()]}`);
      }

      assert.ok(refusal,
        'a credProtect level 3 credential produced an assertion on a device with no ' +
        'user verification available - that is the one thing level 3 is for');
    });
});
