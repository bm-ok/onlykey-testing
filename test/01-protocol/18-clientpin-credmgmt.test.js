/*
 * CLIENT_PIN and credential management - the half of CTAP2 that needs a PIN.
 *
 * ============================ WHAT THIS COSTS ============================
 * This file SETS A CTAP2 CLIENT PIN on the device, and the only way to clear
 * one is a FIDO2 reset. Against a physical key that means:
 *
 *     EVERY RESIDENT CREDENTIAL ON THE KEY IS WIPED, and the key is left
 *     with a PIN set.
 *
 * Every site the key is enrolled at as a discoverable credential stops working.
 * On the emulator none of that matters - the fixture is a copy and the next
 * file gets a fresh one - so the capability `fido-reset` is automatically true
 * there and false on hardware unless somebody opts in with
 *
 *     OKT_ALLOW_FIDO_RESET=1
 *
 * A default `--hardware` run therefore SKIPS this file and says why. That is
 * deliberately not the blunt `emulated` gate OKFWUPDATE carries: that one is
 * irreversible and there is nothing to opt into, whereas this is destructive
 * but recoverable, and CTAP2 PIN handling should be testable on real silicon
 * eventually rather than never.
 * ========================================================================
 *
 * WHY IT IS ONE FILE. credMgmt and CLIENT_PIN read like two rows and are one
 * dependency chain, which is worth knowing before planning around them:
 *
 *   credMgmt needs a pinUvAuthParam
 *     -> which is HMAC(pinToken, ...)
 *        -> pinToken comes from CLIENT_PIN getPinToken
 *           -> which refuses with PIN_NOT_SET unless a PIN exists
 *              -> which is CLIENT_PIN setPin
 *
 * GET_INFO reports `clientPin: false`, and that means SUPPORTED BUT NOT SET
 * rather than unsupported - the option would be absent if the firmware had no
 * PIN support. So the chain is open, and credMgmt is reachable; it just has a
 * door in front of it. Verified before this file was written, because three
 * other rows in this work list turned out to rest on premises nobody had
 * checked.
 *
 * ONE-WAY WITHIN A RUN, WHICH IS WHY EVERY TEST RESETS FIRST. A client PIN
 * cannot be unset, only reset away, and after setPin a MakeCredential with no
 * pinAuth is refused with PIN_REQUIRED. So any test asserting something about a
 * device WITHOUT a PIN is at the mercy of whatever ran before it. `--reverse`
 * proved exactly that: back to front, the PIN-change test ran first and
 * "reports no PIN set" failed, correctly. Each test now starts from
 * freshAuthenticator(), which is a CTAP_RESET - the operation this file is
 * gated on in the first place.
 *
 * SURFACES - see PRODUCTION.md. FIDO (0xF1D0) throughout, plus button presses
 * that arrive as KEEPALIVE(UP_NEEDED). The console is not read.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { Ctap2, CTAP2_CMD } = require('../../lib/device/ctap2');
const cbor = require('../../lib/device/cbor');

const RP_ID = 'okt.pin';
const UP_NEEDED = 2;
const FLAG_AT = 0x40;

/* CTAP2 command bytes not in the kit's enum. 0x41 is the FIDO_2_1_PRE alias
 * this firmware also answers - GET_INFO lists FIDO_2_1_PRE, and both dispatch
 * to the same handler. */
const CRED_MGMT = 0x0A;
const CRED_MGMT_PRE = 0x41;

/* CLIENT_PIN subcommands. */
const CP = { GET_RETRIES: 1, GET_KEY_AGREEMENT: 2, SET_PIN: 3, CHANGE_PIN: 4, GET_PIN_TOKEN: 5 };

/* credMgmt subcommands. */
const CM = { METADATA: 1, RP_BEGIN: 2, RK_BEGIN: 4 };

const PIN = '9137';
const NEW_PIN = '2468';

function parseAuthData(authData) {
  const out = { flags: authData[32] };
  let at = 37;
  if (out.flags & FLAG_AT) {
    const idLen = authData.readUInt16BE(at + 16);
    out.credentialId = authData.subarray(at + 18, at + 18 + idLen);
  }
  return out;
}

describe('CLIENT_PIN and credential management', {
  state: 'initialized',
  /* `fido-reset` FIRST, so a skipped hardware run leads with what it costs. */
  requires: ['fido-reset', 'crypto'],
  timeoutMs: 300000,
}, () => {
  async function channel(device, signal) {
    await device.ensureUnlocked(PINS.primary, { signal });
    const ctap = new Ctap2(device, { signal });
    await ctap.init({ signal });
    return ctap;
  }

  const presser = (device, log) => ({
    onKeepAlive: async (status) => {
      if (status === UP_NEEDED) {
        log('device asked for user presence - pressing button 1');
        device.press(1);
      }
    },
  });

  const aes = (key, data, decrypt = false) => {
    const c = decrypt
      ? crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16))
      : crypto.createCipheriv('aes-256-cbc', key, Buffer.alloc(16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  };

  /** pinUvAuthProtocol 1: sharedSecret = SHA-256 of the ECDH x-coordinate. */
  async function exchange(ctap, signal) {
    const reply = await ctap.send(CTAP2_CMD.CLIENT_PIN,
      cbor.encode(new Map([[1, 1], [2, CP.GET_KEY_AGREEMENT]])), { signal });
    const cose = reply.get(1);

    const devicePub = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex'),
        cose.get(-2), cose.get(-3),
      ]),
      format: 'der',
      type: 'spki',
    });
    const platform = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const shared = crypto.createHash('sha256')
      .update(crypto.diffieHellman({ privateKey: platform.privateKey, publicKey: devicePub }))
      .digest();

    const raw = platform.publicKey.export({ format: 'der', type: 'spki' }).subarray(-64);
    return {
      shared,
      cose: new Map([[1, 2], [3, -25], [-1, 1], [-2, raw.subarray(0, 32)], [-3, raw.subarray(32)]]),
    };
  }

  const setPin = async (ctap, signal, pin) => {
    const { shared, cose } = await exchange(ctap, signal);
    const padded = Buffer.alloc(64);
    Buffer.from(pin, 'utf8').copy(padded);
    const newPinEnc = aes(shared, padded);
    const pinAuth = crypto.createHmac('sha256', shared).update(newPinEnc).digest().subarray(0, 16);
    return ctap.send(CTAP2_CMD.CLIENT_PIN, cbor.encode(new Map([
      [1, 1], [2, CP.SET_PIN], [3, cose], [4, pinAuth], [5, newPinEnc],
    ])), { signal });
  };

  const pinToken = async (ctap, signal, pin) => {
    const { shared, cose } = await exchange(ctap, signal);
    const pinHashEnc = aes(shared, crypto.createHash('sha256').update(pin).digest().subarray(0, 16));
    const reply = await ctap.send(CTAP2_CMD.CLIENT_PIN, cbor.encode(new Map([
      [1, 1], [2, CP.GET_PIN_TOKEN], [3, cose], [6, pinHashEnc],
    ])), { signal });
    return aes(shared, reply.get(2), true);
  };

  /** credMgmt with the pinUvAuthParam its gated subcommands need. */
  const credMgmt = (ctap, signal, token, sub, cmd = CRED_MGMT) => {
    const param = crypto.createHmac('sha256', token)
      .update(Buffer.from([sub])).digest().subarray(0, 16);
    return ctap.send(cmd, cbor.encode(new Map([[1, sub], [3, 1], [4, param]])), { signal });
  };

  /**
   * A channel onto an authenticator with NO PIN and NO resident credentials.
   *
   * Every test starts here, and that is the whole reason this file is gated on
   * `fido-reset`. A client PIN cannot be unset - only reset away - so any test
   * that asserts something about a device WITHOUT one is at the mercy of
   * whatever ran before it. `--reverse` proved that: with the tests back to
   * front, the PIN-change test ran first and "reports no PIN set" then failed,
   * correctly.
   *
   * Resetting per test rather than once for the file is deliberate. The
   * alternative - a flag remembering whether a PIN was set, and which one -
   * fails the moment changePIN runs before the test that set it, which is
   * exactly the case reverse order produces. Establishing the state is the only
   * thing that survives every order.
   *
   * IT REBOOTS AS WELL AS RESETTING, and that second part was found by
   * `--reverse` too. A CTAP_RESET clears the PIN and the resident credentials
   * and does NOT clear the bad-pinAuth counter: PIN_BOOT_ATTEMPTS is 3 PER
   * BOOT, ctap_reset_pin_attempts() is the only thing that restores it, and
   * ctap_reset() does not call it. So after a few tests that deliberately
   * present a wrong PIN, the next refusal escalates from PIN_AUTH_INVALID to
   * PIN_AUTH_BLOCKED - correct behaviour, and it made an assertion about the
   * error code depend on how many tests had run first.
   *
   * A reboot is the only thing that restores the budget, so the reboot is part
   * of what "fresh" has to mean here.
   *
   * CTAP_RESET needs a user-presence test, so the button is pressed for it like
   * anything else.
   */
  async function freshAuthenticator(device, signal, log) {
    await device.restart({ signal });
    const ctap = await channel(device, signal);
    await ctap.send(CTAP2_CMD.RESET, Buffer.alloc(0),
      { timeoutMs: 60000, signal, ...presser(device, log) });
    log('rebooted and reset: no PIN, no resident credentials, 3 pinAuth attempts');
    return ctap;
  }

  const ensurePin = async (ctap, signal, log, pin = PIN) => {
    await setPin(ctap, signal, pin);
    log(`client PIN set to ${pin}`);
  };

  it('reports no PIN set, and refuses a pinToken until there is one',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The head of the chain, asserted rather than assumed. `clientPin: false`
       * means SUPPORTED BUT NOT SET; if it meant unsupported the option would be
       * absent, and everything below would be unreachable rather than merely
       * gated.
       */
      const ctap = await freshAuthenticator(device, signal, log);
      const info = await ctap.getInfo({ signal });
      const options = info.get(4);

      assert.ok(options.has('clientPin'),
        'clientPin is absent from GET_INFO, which would mean PINs are unsupported');
      assert.equal(options.get('clientPin'), false,
        'this fixture is meant to start with no client PIN');

      const retries = await ctap.send(CTAP2_CMD.CLIENT_PIN,
        cbor.encode(new Map([[1, 1], [2, CP.GET_RETRIES]])), { signal });
      log(`retries left: ${retries.get(3)}`);
      assert.ok(retries.get(3) > 0, 'the device reports no PIN attempts remaining');

      let refusal = null;
      try {
        await pinToken(ctap, signal, PIN);
      } catch (err) {
        refusal = err;
      }
      log(`getPinToken with no PIN set -> ${refusal ? refusal.message : 'A TOKEN'}`);
      assert.ok(refusal, 'the device handed out a pinToken with no PIN set');
      assert.match(refusal.message, /PIN_NOT_SET/,
        `expected PIN_NOT_SET, got ${refusal.message}`);
    });

  it('refuses credMgmt without a pinUvAuthParam', async ({ device, assert, signal, log }) => {
    /*
     * SURFACE: FIDO - survives into a production walk.
     *
     * The gate itself, and the reason this file exists in the shape it does.
     * credMgmt enumerates and DELETES credentials, so an unauthenticated
     * credMgmt would let any process on the host wipe the key's registrations.
     *
     * Both command bytes are checked: this firmware answers 0x0A and the
     * FIDO_2_1_PRE alias 0x41 with the same handler, so a gate on only one of
     * them would be no gate at all.
     */
    const ctap = await freshAuthenticator(device, signal, log);

    for (const cmd of [CRED_MGMT, CRED_MGMT_PRE]) {
      let refusal = null;
      try {
        await ctap.send(cmd, cbor.encode(new Map([[1, CM.METADATA]])), { signal });
      } catch (err) {
        refusal = err;
      }
      log(`credMgmt 0x${cmd.toString(16)} unauthenticated -> ${refusal ? refusal.message : 'ANSWERED'}`);
      assert.ok(refusal, `credMgmt 0x${cmd.toString(16)} answered with no pinUvAuthParam`);

      /*
       * PIN_AUTH_INVALID on a device with its attempt budget intact - which the
       * reboot in freshAuthenticator() guarantees. Without it the second of
       * these two calls escalates to PIN_AUTH_BLOCKED, because the budget is 3
       * bad attempts PER BOOT and a CTAP_RESET does not restore it. Both are
       * refusals and both are correct; pinning the first is only possible
       * because the state is established rather than inherited.
       */
      assert.match(refusal.message, /PIN_AUTH_INVALID/,
        `expected PIN_AUTH_INVALID from 0x${cmd.toString(16)}, got ${refusal.message} - ` +
        'if this is PIN_AUTH_BLOCKED, the attempt budget was already spent');
    }
  });

  it('sets a PIN, hands out a token for it, and refuses the wrong one',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * setPin is only permitted while no PIN exists - ctap_client_pin refuses
       * with NOT_ALLOWED otherwise - so this is the one-way step, and the test
       * that opens the door for the rest.
       *
       * The wrong-PIN half matters more than the right one: a device that
       * handed out a token for any PIN would pass every other test in this file
       * while being unauthenticated in practice.
       */
      const ctap = await freshAuthenticator(device, signal, log);
      await ensurePin(ctap, signal, log);

      const token = await pinToken(ctap, signal, PIN);
      log(`pinToken ${token.length} bytes`);
      assert.equal(token.length, 16,
        `this firmware's PIN_TOKEN_SIZE is 16; got ${token.length}`);
      assert.notEqual(token.toString('hex'), '00'.repeat(token.length),
        'the token is all zeros');

      let refusal = null;
      try {
        await pinToken(ctap, signal, '0000');
      } catch (err) {
        refusal = err;
      }
      log(`wrong PIN -> ${refusal ? refusal.message : 'A TOKEN'}`);
      assert.ok(refusal, 'the device handed out a token for the wrong PIN');

      /* GET_INFO must now agree that a PIN exists - a client reads this to
       * decide whether to prompt. */
      const info = await ctap.getInfo({ signal });
      assert.equal(info.get(4).get('clientPin'), true,
        'a PIN was set and GET_INFO still reports clientPin false');
    });

  it('answers credMgmt getCredsMetadata once authenticated',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The far end of the chain. getCredsMetadata reports how many resident
       * credentials exist and how many more will fit, which is the only way a
       * client can tell the user the key is full before a registration fails.
       *
       * Both command bytes again, and they must agree: 0x0A and 0x41 are one
       * handler, so a difference between them would mean one of the two is
       * answering from somewhere else.
       */
      const ctap = await freshAuthenticator(device, signal, log);
      await ensurePin(ctap, signal, log);
      const token = await pinToken(ctap, signal, PIN);

      const answers = [];
      for (const cmd of [CRED_MGMT, CRED_MGMT_PRE]) {
        const reply = await credMgmt(ctap, signal, token, CM.METADATA, cmd);
        const existing = reply.get(1);
        const remaining = reply.get(2);
        log(`credMgmt 0x${cmd.toString(16)}: ${existing} stored, ${remaining} slots left`);
        answers.push(`${existing}/${remaining}`);

        assert.ok(Number.isInteger(existing) && existing >= 0,
          `existingResidentCredentialsCount is not a count: ${existing}`);
        assert.ok(Number.isInteger(remaining) && remaining >= 0,
          `maxPossibleRemainingResidentCredentialsCount is not a count: ${remaining}`);
      }

      assert.equal(answers[0], answers[1],
        `0x0A and its 0x41 alias disagree: ${answers.join(' vs ')}`);
    });

  it('changes the PIN, and the old one stops working',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * changePIN is the other half of CLIENT_PIN and needs the CURRENT PIN, so
       * it is the one command here that proves the device is actually checking
       * what it was given rather than accepting any well-formed request. The
       * assertion that matters is the old PIN failing afterwards - a change that
       * left both working would look identical to a successful one.
       */
      const ctap = await freshAuthenticator(device, signal, log);
      await ensurePin(ctap, signal, log);

      const { shared, cose } = await exchange(ctap, signal);
      const padded = Buffer.alloc(64);
      Buffer.from(NEW_PIN, 'utf8').copy(padded);
      const newPinEnc = aes(shared, padded);
      const pinHashEnc = aes(shared,
        crypto.createHash('sha256').update(PIN).digest().subarray(0, 16));
      const pinAuth = crypto.createHmac('sha256', shared)
        .update(Buffer.concat([newPinEnc, pinHashEnc])).digest().subarray(0, 16);

      await ctap.send(CTAP2_CMD.CLIENT_PIN, cbor.encode(new Map([
        [1, 1], [2, CP.CHANGE_PIN], [3, cose], [4, pinAuth], [5, newPinEnc], [6, pinHashEnc],
      ])), { signal });
      log(`PIN changed ${PIN} -> ${NEW_PIN}`);

      const token = await pinToken(ctap, signal, NEW_PIN);
      assert.equal(token.length, 16, 'the new PIN did not yield a usable token');

      let refusal = null;
      try {
        await pinToken(ctap, signal, PIN);
      } catch (err) {
        refusal = err;
      }
      log(`old PIN after change -> ${refusal ? refusal.message : 'A TOKEN'}`);
      assert.ok(refusal, 'the old PIN still works after changePIN');
    });
});
