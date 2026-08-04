/*
 * backup.js - the OnlyKey backup file, parsed and reassembled in JS.
 *
 * The device types its backup out over the keyboard interface, one character
 * at a time, wrapped in PEM-style markers:
 *
 *   -----BEGIN ONLYKEY BACKUP-----
 *   <base64 line>
 *   <base64 line>
 *   --<base64 SHA256>
 *   -----END ONLYKEY BACKUP-----
 *
 * Restoring sends the same bytes back as OKRESTORE packets. Both halves are
 * reimplemented here rather than shelled out to python-onlykey's
 * restore_from_backup(), for the same reason as the rest of the client
 * protocol: section 1 has to reach the device without a kernel device node,
 * and python-onlykey finds it through hidapi.
 *
 * The hash is the interesting part, and the reason this file is worth having
 * on its own. It is not a hash OF the backup - it is a CHAIN: starting from 32
 * zero bytes, each data line folds in as sha256(previous || line). Computing
 * that here and comparing it against the line the device typed is a real
 * pure-JS crypto check against the device's own arithmetic, and it is what
 * says the keystrokes were captured without a dropped character - which,
 * over 600 keystrokes of a paced HID stream, is not a given.
 */
'use strict';

const crypto = require('crypto');

const BEGIN = '-----BEGIN ONLYKEY BACKUP-----';
const END = '-----END ONLYKEY BACKUP-----';

/* python-onlykey sends 57 data bytes per packet: 64 - 4 header - 1 message
 * type - 1 length byte, rounded to what its own client uses. */
const RESTORE_CHUNK = 57;

/**
 * @param {string} text everything the device typed
 * @returns {{data:Buffer, computedHash:Buffer, storedHash:Buffer|null,
 *            lines:number, complete:boolean}}
 */
function parse(text) {
  const complete = text.includes(BEGIN) && text.includes(END);

  const parts = [];
  let chain = Buffer.alloc(32);
  let storedHash = null;
  let lines = 0;

  for (const raw of String(text).trim().split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('-----')) continue;          // BEGIN / END

    if (line.startsWith('--')) {                     // the hash line
      storedHash = Buffer.from(line.slice(2), 'base64');
      continue;
    }

    const decoded = Buffer.from(line, 'base64');
    parts.push(decoded);
    lines++;
    chain = crypto.createHash('sha256').update(chain).update(decoded).digest();
  }

  return { data: Buffer.concat(parts), computedHash: chain, storedHash, lines, complete };
}

/** Does the chained hash the device typed match the one we computed? */
function verify(parsed) {
  return !!(parsed.storedHash &&
    parsed.storedHash.length === 32 &&
    parsed.computedHash.equals(parsed.storedHash));
}

/**
 * Split backup bytes into OKRESTORE payloads.
 *
 * Each packet is one length byte then up to 57 data bytes. The length byte is
 * 0xFF for "more follows" and the actual byte count for the last one - so the
 * device learns the end from the packet itself and needs no separate terminator.
 * @returns {Buffer[]} payloads, ready for okmsg.build({msg: OKRESTORE, payload})
 */
function toRestorePackets(data) {
  const packets = [];
  for (let offset = 0; offset < data.length; offset += RESTORE_CHUNK) {
    const chunk = data.subarray(offset, offset + RESTORE_CHUNK);
    const final = offset + RESTORE_CHUNK >= data.length;
    packets.push(Buffer.concat([Buffer.from([final ? chunk.length : 0xFF]), chunk]));
  }
  return packets;
}

module.exports = { parse, verify, toRestorePackets, BEGIN, END, RESTORE_CHUNK };
