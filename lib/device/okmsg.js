/*
 * okmsg.js - the OnlyKey client protocol, in JS.
 *
 * This is the vendor RawHID2 interface (usage page 0xFFAB, emulator iface 2) -
 * the one the app, the CLI and lib-agent all speak. Reimplemented here rather
 * than shelled out to python-onlykey for one reason: section 1's admission test
 * is "does this reach the device without a kernel device node", and every real
 * client finds the device through hidapi. python-onlykey stays untouched.
 *
 * Frame layout, from the firmware's own dispatch (okcore.cpp: recv_buffer[4] is
 * the message type) and confirmed against python-onlykey's send_message():
 *
 *   0..3  FF FF FF FF     header
 *   4     message type
 *   5     slot id         (only for messages that take one)
 *   6     field id        (only for OKSETSLOT-style messages)
 *   7..   payload
 *   pad to 64 with 0x00
 *
 * There is deliberately NO report ID here. The proven hardware client always
 * prepends a zero byte, but the emulator's delivery path pads to 64 and does
 * not strip a leading report ID - so identical test code would put different
 * bytes on the wire in each mode. Payloads carry no report ID; the hardware
 * adapter adds it.
 */
'use strict';

const REPORT_SIZE = 64;
const HEADER = [0xFF, 0xFF, 0xFF, 0xFF];

/* okcore.h: #define OKxxx (TYPE_INIT | 0xNN), TYPE_INIT = 0x80. */
const MSG = {
  OKPIN: 0xE1,          // set/advance primary PIN state machine
  OKPINSD: 0xE2,        // ... self-destruct PIN
  OKPINSEC: 0xE3,       // ... second (plausible deniability) profile PIN
  OKCONNECT: 0xE4,      // also known as OKSETTIME in python-onlykey
  OKGETLABELS: 0xE5,
  OKSETSLOT: 0xE6,
  OKWIPESLOT: 0xE7,
  OKGETPUBKEY: 0xEC,
  OKSIGN: 0xED,
  OKWIPEPRIV: 0xEE,
  OKSETPRIV: 0xEF,
  OKDECRYPT: 0xF0,
  OKRESTORE: 0xF1,
  OKGETRESPONSE: 0xF2,
  OKPING: 0xF3,
  OKFWUPDATE: 0xF4,
  OKHMAC: 0xF5,
  OKWEBAUTHN: 0xF6,
};

/* The three PIN state machines, by the name a test would use. */
const PIN_KIND = {
  primary: MSG.OKPIN,
  secondary: MSG.OKPINSEC,
  selfDestruct: MSG.OKPINSD,
};

/**
 * Build one 64-byte report.
 * @param {object} spec
 * @param {number} spec.msg      MSG.*
 * @param {number} [spec.slot]
 * @param {number} [spec.field]
 * @param {Buffer|number[]|string} [spec.payload]  string is taken as latin1
 */
function build({ msg, slot, field, payload }) {
  const parts = [...HEADER];
  if (msg === undefined) throw new Error('okmsg.build needs a msg');
  parts.push(msg & 0xFF);
  if (slot !== undefined) parts.push(slot & 0xFF);
  if (field !== undefined) parts.push(field & 0xFF);

  let body = Buffer.alloc(0);
  if (payload !== undefined && payload !== null) {
    body = typeof payload === 'string'
      ? Buffer.from(payload, 'latin1')
      : Buffer.from(payload);
  }

  /* Checked before the copy: Buffer.copy() truncates silently, which would put
   * a half-message on the wire and blame the firmware for ignoring it. */
  if (parts.length + body.length > REPORT_SIZE) {
    throw new RangeError(
      `message is ${parts.length + body.length} bytes, one report holds ${REPORT_SIZE}`
    );
  }

  const frame = Buffer.alloc(REPORT_SIZE);
  Buffer.concat([Buffer.from(parts), body]).copy(frame);
  return frame;
}

/**
 * OKCONNECT's payload: the epoch seconds as hex digit PAIRS, one byte each -
 * python-onlykey's set_time() encoding, which the firmware parses as such.
 * @param {Date|number} [when]
 */
function setTimePayload(when = Date.now()) {
  const secs = Math.floor((when instanceof Date ? when.getTime() : when) / 1000);
  let hex = secs.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * A device response as text.
 *
 * hidprint() memsets its buffer and writes only the string, so everything after
 * it is NUL padding - which is not part of the message and must not end up in
 * an assertion. Trailing NULs only: an interior one is the device's own byte.
 */
function text(buffer) {
  const buf = Buffer.from(buffer);
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0x00) end--;
  return buf.subarray(0, end).toString('latin1');
}

module.exports = { MSG, PIN_KIND, HEADER, REPORT_SIZE, build, setTimePayload, text };
