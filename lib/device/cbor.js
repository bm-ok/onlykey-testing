/*
 * cbor.js - just enough CBOR for CTAP2.
 *
 * CTAP2 does not use CBOR, it uses a strict subset of it (the "CTAP2 canonical
 * CBOR encoding form"): definite lengths only, no tags, no indefinite streams,
 * and map keys sorted canonically. That subset is small enough to write and
 * read in one sitting, which is the whole argument for having it here rather
 * than taking a dependency: this file is a test oracle, and an oracle you
 * cannot read is not much of one.
 *
 * Canonical ordering matters and is not cosmetic. The authenticator hashes
 * some of what it receives, so two encodings of the same map are not
 * interchangeable - a signature verifies against the bytes, not the meaning.
 * Keys sort by encoded length first, then bytewise.
 */
'use strict';

/* Major types, in the high three bits of the initial byte. */
const UINT = 0;
const NEGINT = 1;
const BYTES = 2;
const TEXT = 3;
const ARRAY = 4;
const MAP = 5;
const SIMPLE = 7;

/* ---- encoding ------------------------------------------------------------ */

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  if (value < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(BigInt(value), 1);
  return b;
}

/**
 * @param {*} value  number | string | Buffer | Array | Map | object | boolean | null
 * @returns {Buffer}
 */
function encode(value) {
  if (value === null) return Buffer.from([(SIMPLE << 5) | 22]);
  if (value === true) return Buffer.from([(SIMPLE << 5) | 21]);
  if (value === false) return Buffer.from([(SIMPLE << 5) | 20]);

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('CTAP2 CBOR: no floats here');
    return value >= 0 ? head(UINT, value) : head(NEGINT, -value - 1);
  }

  if (typeof value === 'string') {
    const body = Buffer.from(value, 'utf8');
    return Buffer.concat([head(TEXT, body.length), body]);
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const body = Buffer.from(value);
    return Buffer.concat([head(BYTES, body.length), body]);
  }

  if (Array.isArray(value)) {
    return Buffer.concat([head(ARRAY, value.length), ...value.map(encode)]);
  }

  /* A Map preserves the caller's key types; a plain object cannot hold the
   * integer keys CTAP2 requests are built from, so both are accepted. */
  const entries = value instanceof Map
    ? [...value.entries()]
    : Object.entries(value);

  const encoded = entries.map(([k, v]) => [encode(k), encode(v)]);
  encoded.sort((a, b) => (a[0].length - b[0].length) || Buffer.compare(a[0], b[0]));

  return Buffer.concat([head(MAP, encoded.length), ...encoded.flat()]);
}

/* ---- decoding ------------------------------------------------------------ */

function readHead(buf, pos) {
  const initial = buf[pos];
  const major = initial >> 5;
  const minor = initial & 0x1F;

  if (minor < 24) return { major, value: minor, next: pos + 1 };
  if (minor === 24) return { major, value: buf[pos + 1], next: pos + 2 };
  if (minor === 25) return { major, value: buf.readUInt16BE(pos + 1), next: pos + 3 };
  if (minor === 26) return { major, value: buf.readUInt32BE(pos + 1), next: pos + 5 };
  if (minor === 27) return { major, value: Number(buf.readBigUInt64BE(pos + 1)), next: pos + 9 };
  throw new Error(`CBOR: unsupported length encoding ${minor} at ${pos}`);
}

function decodeAt(buf, pos) {
  const { major, value, next } = readHead(buf, pos);

  switch (major) {
    case UINT: return { value, next };
    case NEGINT: return { value: -value - 1, next };

    case BYTES: return { value: buf.subarray(next, next + value), next: next + value };
    case TEXT: return {
      value: buf.subarray(next, next + value).toString('utf8'),
      next: next + value,
    };

    case ARRAY: {
      const out = [];
      let at = next;
      for (let i = 0; i < value; i++) {
        const item = decodeAt(buf, at);
        out.push(item.value);
        at = item.next;
      }
      return { value: out, next: at };
    }

    case MAP: {
      /* A Map, not an object: CTAP2 responses are keyed by integer, and an
       * object would stringify those keys and quietly lose the distinction
       * between 1 and "1". */
      const out = new Map();
      let at = next;
      for (let i = 0; i < value; i++) {
        const k = decodeAt(buf, at);
        const v = decodeAt(buf, k.next);
        out.set(k.value, v.value);
        at = v.next;
      }
      return { value: out, next: at };
    }

    case SIMPLE: {
      const minor = buf[pos] & 0x1F;
      if (minor === 20) return { value: false, next };
      if (minor === 21) return { value: true, next };
      if (minor === 22) return { value: null, next };
      if (minor === 23) return { value: undefined, next };
      if (minor === 26) return { value: buf.readFloatBE(pos + 1), next: pos + 5 };
      if (minor === 27) return { value: buf.readDoubleBE(pos + 1), next: pos + 9 };
      throw new Error(`CBOR: unsupported simple value ${minor} at ${pos}`);
    }

    default:
      throw new Error(`CBOR: unsupported major type ${major} at ${pos}`);
  }
}

/**
 * @param {Buffer} buf
 * @returns {*} Maps stay Maps, byte strings stay Buffers
 */
function decode(buf) {
  if (!buf || !buf.length) return undefined;
  const { value, next } = decodeAt(Buffer.from(buf), 0);
  if (next !== buf.length) {
    throw new Error(`CBOR: ${buf.length - next} trailing bytes after the top-level item`);
  }
  return value;
}

/** Maps to plain objects, for readable assertion messages. Lossy on purpose. */
function plain(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = plain(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  return value;
}

module.exports = { encode, decode, plain };
