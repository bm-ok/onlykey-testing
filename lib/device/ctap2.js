/*
 * ctap2.js - the FIDO2 client protocol, over whichever bus the device is on.
 *
 * The protocol layer is ported from @vincss-public-projects/fido2-client
 * (VinCSS R&D, MIT) - specifically src/Transports/HIDPacket.js's framing and
 * src/CTAP2/CTAP2.js's sendCBOR loop, which is the shape the old kit already
 * proved against real hardware. What is NOT ported is src/Transports/USB.js,
 * its node-hid transport, and that omission is the entire point: that transport
 * needs a kernel device node, and needing one would push every FIDO2 test out
 * of section 1 and into a section that cannot run in CI. Here the transport is
 * whatever the device handle is - the emulator's in-process bus, or hidraw on a
 * physical key - so the same ceremony runs in both places.
 *
 * Three things about the wire are worth knowing before reading the code:
 *
 *   Fragmentation. A CTAPHID message is an init packet (channel, command,
 *   16-bit total length, then 57 bytes) followed by continuation packets
 *   (channel, sequence 0..127, then 59 bytes). Anything past a GetInfo needs
 *   it, so it is here rather than deferred.
 *
 *   KEEPALIVE is not noise, it is the user-presence prompt. While the
 *   authenticator waits for a button press it sends KEEPALIVE(0x02) roughly
 *   ten times a second. A client that treats those as errors cannot complete a
 *   ceremony; a TEST that watches for them knows exactly when to press.
 *
 *   The first byte of a CBOR response is the CTAP status, not CBOR. Zero is
 *   success and everything else is an error code, so the payload has to be
 *   split before it is decoded.
 */
'use strict';

const cbor = require('./cbor');
const { tracked } = require('./waits');

const IFACE_FIDO = 1;

/*
 * THE PROTOCOL NOW COMES FROM node-onlykey-lib (protocol.ctaphid - one lib, any
 * GUI; the test CLI is a GUI): the CTAPHID and authenticator command codes,
 * the CTAP2 status table, Ctap2Error and the packet framing. Checked before
 * the switch: frame() identical at 0, 1, 57, 58, 116, 200 and 1024 bytes (and
 * pinned by the library's frozen vectors from this file); CTAPHID, KEEPALIVE,
 * TYPE_INIT and the broadcast CID identical; CTAP2_CMD a superset.
 *
 * The status NAMES are the library's full spellings now - 'CTAP2_ERR_PIN_
 * INVALID' where this file said 'PIN_INVALID' - so an error reads "CTAP2 error
 * CTAP2_ERR_NO_CREDENTIALS". The tests match the distinctive part
 * (/NO_CREDENTIALS/, /PIN_NOT_SET/, /PIN_AUTH_INVALID/), which both carry.
 * The table is the firmware's own ctap_errors.h; this file also named 0x3E
 * UP_REQUIRED, a CTAP 2.1 code this firmware neither defines nor sends.
 *
 * What stays here is the Ctap2 class below: it is built on the kit's Device -
 * its HID history cursors, abort signals and keepalive record - which the
 * library's CtapHid does not have yet.
 */
const lib = require('node-onlykey-lib/protocol').ctaphid;

const toBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

const {
  CTAPHID, TYPE_INIT, CTAP2_CMD, CTAP2_ERROR, KEEPALIVE, Ctap2Error,
  INIT_PAYLOAD, CONT_PAYLOAD,
} = lib;

/* A Buffer, because the kit compares CIDs with .equals(). */
const BROADCAST_CID = toBuffer(lib.BROADCAST_CID);

/* ---- framing ------------------------------------------------------------- */

/** Split a message into 64-byte CTAPHID packets (Buffer views). */
function frame(cid, cmd, payload) {
  return lib.frame(cid, cmd, payload).map(toBuffer);
}

/**
 * The client protocol, bound to a device handle.
 *
 * Takes the kit's Device rather than a transport of its own, so every wait it
 * does is already cancellable by the test's deadline and by the device dying.
 */
class Ctap2 {
  /**
   * @param {object} device the kit's Device
   * @param {object} [opts] {signal}
   */
  constructor(device, opts = {}) {
    this.device = device;
    this.signal = opts.signal;
    this.cid = null;
    this.keepAlives = [];         // every status byte seen, for tests to assert on
  }

  _opts(extra = {}) {
    return { signal: this.signal, ...extra };
  }

  /** Allocate a channel. Must happen before anything else. */
  async init(opts = {}) {
    const nonce = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    const since = this.device.mark(IFACE_FIDO);

    for (const packet of frame(BROADCAST_CID, CTAPHID.INIT, nonce)) {
      this.device.send(IFACE_FIDO, packet);
    }

    const reply = await this.device.waitHid(IFACE_FIDO, this._opts({
      since,
      match: (buf) => buf[4] === (CTAPHID.INIT | TYPE_INIT) &&
        buf.subarray(7, 15).equals(nonce),
      timeoutMs: 5000,
      ...opts,
    }));

    this.cid = Buffer.from(reply.subarray(15, 19));
    return this.cid;
  }

  /**
   * Read one whole CTAPHID message, reassembling continuation packets.
   * @returns {Promise<{cmd:number, payload:Buffer}>}
   */
  async _receive(opts = {}) {
    const since = opts.since !== undefined ? opts.since : this.device.mark(IFACE_FIDO);

    /*
     * ONE cursor for the whole message, not a fresh one per packet.
     *
     * Taking mark() again after the init packet arrives looks harmless and is
     * not: on an in-process bus every continuation packet has ALREADY arrived
     * by then, so a cursor taken "now" excludes exactly the packets being
     * waited for, and the read hangs on data sitting in the buffer. Measured
     * as a 10s timeout on a GET_INFO the firmware had already answered in
     * three blocks. All packets of one message live after `since`; sequence
     * numbers tell them apart.
     */
    const initPacket = await this.device.waitHid(IFACE_FIDO, this._opts({
      timeoutMs: 10000,
      ...opts,
      since,
      match: (buf) => buf.subarray(0, 4).equals(this.cid) && (buf[4] & TYPE_INIT) !== 0,
    }));

    const cmd = initPacket[4] & 0x7F;
    const total = initPacket.readUInt16BE(5);
    const chunks = [initPacket.subarray(7, 7 + Math.min(total, INIT_PAYLOAD))];
    let have = chunks[0].length;

    /* Buffers are handed out by reference, so the report's own position is
     * findable by identity - which is how the cursor advances exactly past
     * what was consumed, rather than past whatever happened to arrive. */
    const offset = this.device.reportsSince(IFACE_FIDO, since).indexOf(initPacket);
    let last = since + (offset < 0 ? 0 : offset);

    let seq = 0;
    while (have < total) {
      const wanted = seq;
      const cont = await this.device.waitHid(IFACE_FIDO, this._opts({
        timeoutMs: 10000,
        ...opts,
        since,
        match: (buf) => buf.subarray(0, 4).equals(this.cid) && buf[4] === wanted,
      }));
      const slice = cont.subarray(5, 5 + Math.min(total - have, CONT_PAYLOAD));
      chunks.push(slice);
      have += slice.length;
      seq++;

      const at = this.device.reportsSince(IFACE_FIDO, since).indexOf(cont);
      if (at >= 0) last = Math.max(last, since + at);
    }

    return { cmd, payload: Buffer.concat(chunks), next: last + 1 };
  }

  /**
   * One CBOR command, with the KEEPALIVE loop.
   *
   * @param {number} cmd CTAP2_CMD.*
   * @param {Buffer} [data] already-encoded CBOR parameters
   * @param {object} [opts] {timeoutMs, onKeepAlive}
   * @returns {Promise<*>} the decoded response, or undefined for an empty one
   */
  async send(cmd, data = Buffer.alloc(0), opts = {}) {
    if (!this.cid) throw new Error('no CTAPHID channel - call init() first');

    const request = Buffer.concat([Buffer.from([cmd]), data]);
    const since = this.device.mark(IFACE_FIDO);
    for (const packet of frame(this.cid, CTAPHID.CBOR, request)) {
      this.device.send(IFACE_FIDO, packet);
    }

    let cursor = since;
    for (;;) {
      const { cmd: replyCmd, payload, next } = await this._receive({ ...opts, since: cursor });
      /* Advance past exactly what was consumed. A KEEPALIVE burst can put
       * several messages in the buffer at once, and mark() here would skip the
       * response sitting behind them. */
      cursor = next;

      if (replyCmd === CTAPHID.KEEPALIVE) {
        /*
         * The device is telling us it is alive and, when the status is
         * UP_NEEDED, that it is waiting for a finger. Recorded so a test can
         * assert user presence was actually demanded, and handed to the
         * caller so it can press the button.
         */
        const status = payload[0];
        this.keepAlives.push(status);
        if (opts.onKeepAlive) await opts.onKeepAlive(status);
        continue;
      }

      if (replyCmd === CTAPHID.ERROR) {
        throw new Error(`CTAPHID error 0x${(payload[0] || 0).toString(16)}`);
      }

      if (replyCmd !== CTAPHID.CBOR) {
        throw new Error(`unexpected CTAPHID command 0x${replyCmd.toString(16)} in a CBOR exchange`);
      }

      /* First byte is the status, the rest is CBOR - or nothing. */
      const status = payload[0];
      if (status !== 0x00) throw new Ctap2Error(status);
      return payload.length > 1 ? cbor.decode(payload.subarray(1)) : undefined;
    }
  }

  getInfo(opts = {}) {
    return this.send(CTAP2_CMD.GET_INFO, Buffer.alloc(0), opts);
  }

  makeCredential(params, opts = {}) {
    return this.send(CTAP2_CMD.MAKE_CREDENTIAL, cbor.encode(params), opts);
  }

  getAssertion(params, opts = {}) {
    return this.send(CTAP2_CMD.GET_ASSERTION, cbor.encode(params), opts);
  }

  /** Did the device ask for a finger during the last exchange? */
  get askedForUserPresence() {
    return this.keepAlives.includes(KEEPALIVE.UP_NEEDED);
  }
}

module.exports = {
  Ctap2, Ctap2Error, frame,
  CTAPHID, CTAP2_CMD, CTAP2_ERROR, KEEPALIVE, BROADCAST_CID, TYPE_INIT,
};
