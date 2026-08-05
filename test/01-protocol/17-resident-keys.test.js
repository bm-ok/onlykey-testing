/*
 * Resident keys: credentials the device stores, and can find without being told
 * which one to look for.
 *
 * GET_INFO says `rk: true`. An ordinary FIDO2 credential is stateless - the
 * credential id handed to the relying party IS the key, wrapped, and the device
 * keeps nothing. A RESIDENT (discoverable) credential is the opposite: the
 * device stores it, and a client can ask "what do you have for this relying
 * party" with an empty allowList and get an answer. That is what usernameless
 * sign-in is built on, and it is the only part of FIDO2 that consumes storage
 * on the key - twelve slots on this firmware, which credMgmt reports.
 *
 * NO PIN NEEDED, so this is ungated section 1 and runs against a physical key
 * with nothing to opt into. That is worth stating because the neighbouring row
 * is not like that: ENUMERATING resident keys is credMgmt, which needs a client
 * PIN and therefore carries `fido-reset`. Creating and using them does not.
 *
 * EVERY TEST USES ITS OWN RELYING PARTY, which is not tidiness. Resident
 * credentials persist in the device for the whole file - there is no reboot
 * between tests and no fixture restore - so a test that made an rk for
 * `okt.rk` would be found by any later test asking about `okt.rk`, and the
 * negative test below would silently pass for the wrong reason. A unique rpId
 * per test is what makes each one mean what it says under `--isolate`,
 * `--reverse` and in file order alike.
 *
 * SURFACES - see PRODUCTION.md. FIDO (0xF1D0) throughout; user presence is
 * KEEPALIVE(UP_NEEDED), so nothing here reads the console and the file survives
 * into a production walk.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { Ctap2 } = require('../../lib/device/ctap2');
const cbor = require('../../lib/device/cbor');

const FLAG_AT = 0x40;
const UP_NEEDED = 2;
const GET_NEXT_ASSERTION = 0x08;

/* GetAssertion response keys, from the spec. */
const RESP_CREDENTIAL = 1;
const RESP_AUTH_DATA = 2;
const RESP_USER = 4;
const RESP_COUNT = 5;

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
    const key = cbor.decodeFirst(authData, at);
    out.coseKey = key.value;
    at = key.next;
  }
  const tail = authData.subarray(at);
  if (tail.length) out.extensions = cbor.decode(tail);
  return out;
}

describe('resident keys', {
  state: 'initialized',
  requires: ['crypto'],
  timeoutMs: 300000,
}, () => {
  /* A relying party nobody else in this file will ask about. */
  const freshRp = () => `okt.rk.${crypto.randomBytes(4).toString('hex')}`;

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

  async function register(ctap, device, log, signal, rpId, { rk, userId, userName = 'okt' }) {
    const params = new Map([
      [1, crypto.randomBytes(32)],
      [2, new Map([['id', rpId], ['name', rpId]])],
      [3, new Map([
        ['id', userId || crypto.randomBytes(16)],
        ['name', userName], ['displayName', userName],
      ])],
      [4, [new Map([['alg', -7], ['type', 'public-key']])]],
    ]);
    if (rk) params.set(7, new Map([['rk', true]]));

    const press = presser(device, log);
    const made = await ctap.makeCredential(params, { timeoutMs: 60000, signal, ...press });
    return parseAuthData(made.get(2));
  }

  /** GetAssertion with an EMPTY allowList - the discoverable-credential ask. */
  function discover(ctap, device, log, signal, rpId) {
    const press = presser(device, log);
    return ctap.getAssertion(new Map([[1, rpId], [2, crypto.randomBytes(32)]]),
      { timeoutMs: 60000, signal, ...press });
  }

  it('stores a credential the device can find with an empty allowList',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The whole feature in one test: register with rk, then ask the device
       * what it has for that relying party WITHOUT naming a credential. A
       * stateless credential cannot answer that question, so an answer is proof
       * the device stored something.
       */
      const ctap = await channel(device, signal);
      const rpId = freshRp();
      const userId = Buffer.from('okt-rk-user-one');

      const made = await register(ctap, device, log, signal, rpId, { rk: true, userId });
      log(`registered ${made.credentialId.toString('hex').slice(0, 24)}... at ${rpId}`);

      const found = await discover(ctap, device, log, signal, rpId);
      const credential = found.get(RESP_CREDENTIAL);
      const authData = parseAuthData(found.get(RESP_AUTH_DATA));

      assert.ok(credential, 'the assertion named no credential');
      assert.bytes(credential.get('id'), made.credentialId,
        'the device found a different credential than the one registered');

      /*
       * And the rpIdHash it signed over is the right relying party - a device
       * that answered with SOME credential rather than one for this rpId would
       * satisfy everything above.
       */
      assert.bytes(authData.rpIdHash, crypto.createHash('sha256').update(rpId).digest(),
        'the assertion is over a different relying party');

      /*
       * The user handle comes back too, and that is what usernameless sign-in
       * actually consumes: the client has no idea who it is talking to until
       * the device says.
       */
      const user = found.get(RESP_USER);
      assert.ok(user, 'no user handle came back - usernameless sign-in needs it');
      assert.bytes(user.get('id'), userId, 'the device returned a different user handle');
    });

  it('does not find a credential that was registered without rk',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * The negative, and the one with a privacy consequence rather than a
       * usability one. A stateless credential must be invisible to a relying
       * party that did not already have its id: if every credential answered an
       * empty allowList, any site could enumerate what else the key is enrolled
       * at.
       *
       * Its own rpId, so a resident credential from another test cannot answer
       * this and make it pass for the wrong reason.
       */
      const ctap = await channel(device, signal);
      const rpId = freshRp();

      const made = await register(ctap, device, log, signal, rpId, { rk: false });
      log(`registered non-resident ${made.credentialId.toString('hex').slice(0, 24)}...`);

      let refusal = null;
      try {
        await discover(ctap, device, log, signal, rpId);
      } catch (err) {
        refusal = err;
      }

      log(`empty allowList -> ${refusal ? refusal.message : 'AN ASSERTION'}`);
      assert.ok(refusal,
        'a credential registered without rk answered an empty allowList - every ' +
        'relying party could enumerate the key');
      assert.match(refusal.message, /NO_CREDENTIALS/,
        `expected NO_CREDENTIALS, got ${refusal.message}`);
    });

  it('counts several credentials for one relying party, and walks them',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * Two users at one relying party is the case the protocol has a whole
       * second command for. The first GetAssertion reports how many there are
       * and returns one; GET_NEXT_ASSERTION returns the next, and the client
       * shows an account picker.
       *
       * numberOfCredentials is ABSENT when there is only one, which is spec
       * behaviour and easy to read as a bug - so it is asserted here where there
       * are two, and its absence is asserted in the single-credential test
       * above by not looking for it.
       */
      const ctap = await channel(device, signal);
      const rpId = freshRp();
      const alice = Buffer.from('okt-rk-alice');
      const bob = Buffer.from('okt-rk-bob');

      await register(ctap, device, log, signal, rpId, { rk: true, userId: alice, userName: 'alice' });
      await register(ctap, device, log, signal, rpId, { rk: true, userId: bob, userName: 'bob' });

      const first = await discover(ctap, device, log, signal, rpId);
      const count = first.get(RESP_COUNT);
      log(`numberOfCredentials: ${count}`);
      assert.equal(count, 2,
        `two resident credentials at one rpId should report 2, got ${count}`);

      const second = await ctap.send(GET_NEXT_ASSERTION, Buffer.alloc(0), { signal });
      assert.ok(second, 'GET_NEXT_ASSERTION returned nothing');

      const users = [first, second].map((r) => r.get(RESP_USER).get('id').toString());
      log(`walked: ${JSON.stringify(users)}`);

      /*
       * Both users, once each, in either order. Order is not specified and
       * pinning it would pin an implementation detail; that the SET is right is
       * the property - a device that returned the same credential twice would
       * leave one account permanently unreachable.
       */
      assert.equal(JSON.stringify([...users].sort()),
        JSON.stringify([alice.toString(), bob.toString()].sort()),
        'the two assertions did not cover both users exactly once');
    });

  it('refuses GET_NEXT_ASSERTION when nothing is being walked',
    async ({ device, assert, signal, log }) => {
      /*
       * SURFACE: FIDO - survives into a production walk.
       *
       * GET_NEXT_ASSERTION is only meaningful straight after a GetAssertion that
       * found more than one credential - the firmware keeps that state in
       * getAssertionState.lastcmd and checks it. Out of context it must refuse,
       * because the alternative is handing out a credential nobody asked about.
       *
       * A fresh channel is opened deliberately, so nothing this file did earlier
       * is mid-walk when the command arrives.
       */
      const ctap = await channel(device, signal);

      let refusal = null;
      try {
        await ctap.send(GET_NEXT_ASSERTION, Buffer.alloc(0), { signal });
      } catch (err) {
        refusal = err;
      }

      log(`bare GET_NEXT_ASSERTION -> ${refusal ? refusal.message : 'AN ASSERTION'}`);
      assert.ok(refusal, 'GET_NEXT_ASSERTION answered with no assertion in progress');
    });
});
