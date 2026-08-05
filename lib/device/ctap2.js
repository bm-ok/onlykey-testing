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

/* CTAPHID commands. The high bit marks an initialisation packet. */
const CTAPHID = {
  PING: 0x01,
  MSG: 0x03,
  LOCK: 0x04,
  INIT: 0x06,
  WINK: 0x08,
  CBOR: 0x10,
  CANCEL: 0x11,
  KEEPALIVE: 0x3B,
  ERROR: 0x3F,
};
const TYPE_INIT = 0x80;

const BROADCAST_CID = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]);
const PACKET_SIZE = 64;
const INIT_PAYLOAD = PACKET_SIZE - 7;      // cid(4) + cmd(1) + bcnt(2)
const CONT_PAYLOAD = PACKET_SIZE - 5;      // cid(4) + seq(1)

/* authenticatorX command codes. */
const CTAP2_CMD = {
  MAKE_CREDENTIAL: 0x01,
  GET_ASSERTION: 0x02,
  GET_INFO: 0x04,
  CLIENT_PIN: 0x06,
  RESET: 0x07,
  GET_NEXT_ASSERTION: 0x08,
  CREDENTIAL_MANAGEMENT: 0x0A,
};

/* Only the codes a test is likely to meet; the rest report as their number. */
/*
 * CTAP2 status codes, transcribed from the FIRMWARE'S OWN fido2/ctap_errors.h -
 * which agrees with the CTAP2 spec - rather than from memory.
 *
 * The previous table was wrong in seven places and had been since it was
 * written. Nothing ever failed because of it, which is exactly why it survived:
 * these names only ever appear in an error MESSAGE, so a mislabelled code sends
 * a reader to the wrong part of the spec and nothing else. The PIN range was the
 * worst of it - 0x33 was absent and everything from 0x34 up was shifted by one,
 * so `credMgmt` refusing with PIN_AUTH_INVALID (0x33) printed as a bare "0x33",
 * and MakeCredential refusing with PIN_REQUIRED (0x36) printed as
 * "PIN_POLICY_VIOLATION". Both were the device behaving correctly and being
 * described as doing something else.
 */
const CTAP2_ERROR = {
  0x00: 'SUCCESS',
  0x10: 'CBOR_PARSING',
  0x11: 'CBOR_UNEXPECTED_TYPE',
  0x12: 'INVALID_CBOR',
  0x13: 'INVALID_CBOR_TYPE',
  0x14: 'MISSING_PARAMETER',
  0x15: 'LIMIT_EXCEEDED',
  0x16: 'UNSUPPORTED_EXTENSION',
  0x17: 'TOO_MANY_ELEMENTS',
  0x18: 'EXTENSION_NOT_SUPPORTED',
  0x19: 'CREDENTIAL_EXCLUDED',
  0x20: 'CREDENTIAL_NOT_VALID',
  0x21: 'PROCESSING',
  0x22: 'INVALID_CREDENTIAL',
  0x23: 'USER_ACTION_PENDING',
  0x24: 'OPERATION_PENDING',
  0x25: 'NO_OPERATIONS',
  0x26: 'UNSUPPORTED_ALGORITHM',
  0x27: 'OPERATION_DENIED',
  0x28: 'KEY_STORE_FULL',
  0x29: 'NOT_BUSY',
  0x2A: 'NO_OPERATION_PENDING',
  0x2B: 'UNSUPPORTED_OPTION',
  0x2C: 'INVALID_OPTION',
  0x2D: 'KEEPALIVE_CANCEL',
  0x2E: 'NO_CREDENTIALS',
  0x2F: 'USER_ACTION_TIMEOUT',
  0x30: 'NOT_ALLOWED',
  0x31: 'PIN_INVALID',
  0x32: 'PIN_BLOCKED',
  0x33: 'PIN_AUTH_INVALID',
  0x34: 'PIN_AUTH_BLOCKED',
  0x35: 'PIN_NOT_SET',
  0x36: 'PIN_REQUIRED',
  0x37: 'PIN_POLICY_VIOLATION',
  0x38: 'PIN_TOKEN_EXPIRED',
  0x39: 'REQUEST_TOO_LARGE',
  0x3A: 'ACTION_TIMEOUT',
  0x3E: 'UP_REQUIRED',
};

/* KEEPALIVE status bytes. */
const KEEPALIVE = { PROCESSING: 0x01, UP_NEEDED: 0x02 };

class Ctap2Error extends Error {
  constructor(code) {
    const name = CTAP2_ERROR[code] || `0x${code.toString(16)}`;
    super(`CTAP2 error ${name}`);
    this.name = 'Ctap2Error';
    this.code = code;
    this.ctapName = name;
  }
}

/* ---- framing ------------------------------------------------------------- */

/** Split a message into 64-byte CTAPHID packets. */
function frame(cid, cmd, payload) {
  const packets = [];

  const init = Buffer.alloc(PACKET_SIZE);
  cid.copy(init, 0);
  init[4] = cmd | TYPE_INIT;
  init.writeUInt16BE(payload.length, 5);
  payload.copy(init, 7, 0, Math.min(payload.length, INIT_PAYLOAD));
  packets.push(init);

  let offset = INIT_PAYLOAD;
  let seq = 0;
  while (offset < payload.length) {
    const cont = Buffer.alloc(PACKET_SIZE);
    cid.copy(cont, 0);
    cont[4] = seq++;                        // sequence, high bit clear
    payload.copy(cont, 5, offset, offset + CONT_PAYLOAD);
    packets.push(cont);
    offset += CONT_PAYLOAD;
  }

  return packets;
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
