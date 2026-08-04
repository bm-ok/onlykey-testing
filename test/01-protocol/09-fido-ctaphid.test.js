/*
 * CTAPHID on the FIDO interface (RawHID, usage page 0xF1D0).
 *
 * The transport layer only: INIT allocates a channel, PING echoes a payload,
 * and a locked device answers neither. That is the part reachable without a
 * kernel device node - a real WebAuthn ceremony goes through the browser's own
 * HID and WebAuthn stacks, which is section four's problem, not this one's.
 *
 * Frame layout (CTAPHID): channel id (4), command | 0x80, payload length
 * big-endian (2), then payload, padded to the 64-byte report.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { IFACE } = require('../../lib/device');

const BROADCAST_CID = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]);
const CMD_PING = 0x81;
const CMD_INIT = 0x86;

function frame(cid, cmd, payload = Buffer.alloc(0)) {
  const report = Buffer.alloc(64);
  cid.copy(report, 0);
  report[4] = cmd;
  report.writeUInt16BE(payload.length, 5);
  payload.copy(report, 7);
  return report;
}

describe('CTAPHID transport', { state: 'initialized', requires: ['crypto'] }, () => {
  it('ignores INIT while locked', async ({ device, assert, signal }) => {
    const nonce = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const since = device.mark(IFACE.FIDO);
    device.send(IFACE.FIDO, frame(BROADCAST_CID, CMD_INIT, nonce));

    /* A locked OnlyKey is not a FIDO authenticator yet. The absence of a reply
     * is the behaviour; asserting it needs a wait that is allowed to time out. */
    await assert.rejects(
      () => device.waitHid(IFACE.FIDO, { since, timeoutMs: 3000, signal }),
      /timed out/,
      'a locked device answered CTAPHID INIT'
    );
  });

  it('allocates a channel once unlocked', async ({ device, assert, signal }) => {
    await device.unlock(PINS.primary, { signal });

    const nonce = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    const since = device.mark(IFACE.FIDO);
    device.send(IFACE.FIDO, frame(BROADCAST_CID, CMD_INIT, nonce));

    const reply = await device.waitHid(IFACE.FIDO, { since, timeoutMs: 5000, signal });

    assert.equal(reply.subarray(0, 4).toString('hex'), BROADCAST_CID.toString('hex'),
      'INIT is answered on the broadcast channel');
    assert.equal(reply[4], CMD_INIT, 'wrong command in the reply');

    /* The nonce comes back so a host can tell ITS init from somebody else's on
     * the shared broadcast channel - the whole point of the exchange. */
    assert.equal(reply.subarray(7, 15).toString('hex'), nonce.toString('hex'),
      'the nonce did not come back');

    const cid = reply.subarray(15, 19);
    assert.notEqual(cid.toString('hex'), '00000000', 'no channel was allocated');
    assert.notEqual(cid.toString('hex'), 'ffffffff', 'the broadcast channel is not a channel');

    /* Hand it to the next test rather than re-running INIT - a second INIT
     * allocates a second channel and proves nothing new. */
    device._ctapCid = cid;
  });

  it('echoes a PING on the allocated channel', async ({ device, assert, signal }) => {
    const cid = device._ctapCid;
    assert.ok(cid, 'no channel from the INIT test');

    const payload = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const since = device.mark(IFACE.FIDO);
    device.send(IFACE.FIDO, frame(cid, CMD_PING, payload));

    const reply = await device.waitHid(IFACE.FIDO, { since, timeoutMs: 5000, signal });
    assert.equal(reply.subarray(0, 4).toString('hex'), cid.toString('hex'),
      'the reply came back on a different channel');
    assert.equal(reply[4], CMD_PING, 'wrong command in the reply');
    assert.equal(reply.readUInt16BE(5), payload.length, 'wrong payload length');
    assert.equal(reply.subarray(7, 7 + payload.length).toString('hex'), payload.toString('hex'),
      'PING did not echo its payload');
  });

  it('answers a PING on any channel id, allocated or not',
    async ({ device, assert, signal }) => {
      /*
       * Documenting a deviation, not asserting a virtue.
       *
       * CTAPHID allocates channel ids through INIT precisely so that concurrent
       * clients cannot answer each other's traffic, and a strict implementation
       * replies to an unknown cid with CTAPHID_ERROR / INVALID_CHANNEL. This
       * firmware echoes the PING instead - measured, on a cid that was never
       * allocated. Harmless for PING, which carries no state, and worth having
       * written down: anything built on top of this that assumes an unknown cid
       * will be rejected is building on something that is not there.
       */
      const bogus = Buffer.from([0x7F, 0x7F, 0x7F, 0x7F]);
      const payload = Buffer.from([1, 2, 3, 4]);
      const since = device.mark(IFACE.FIDO);
      device.send(IFACE.FIDO, frame(bogus, CMD_PING, payload));

      const reply = await device.waitHid(IFACE.FIDO, { since, timeoutMs: 5000, signal });
      assert.equal(reply.subarray(0, 4).toString('hex'), bogus.toString('hex'),
        'the reply came back on a different channel than it was sent on');
      assert.equal(reply[4], CMD_PING, 'expected the echo this firmware sends');
    });
});
