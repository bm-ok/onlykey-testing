/*
 * CBOR, against known answers.
 *
 * lib/device/cbor.js is an ORACLE: 11-fido2-ceremony decides whether the
 * firmware is right by comparing against what this file's code says the bytes
 * mean. An oracle nobody checks is just a second implementation with the same
 * standing as the thing it is judging - if the decoder were subtly wrong, the
 * ceremony would fail looking exactly like a firmware bug, and that is a bad
 * afternoon.
 *
 * So: RFC 8949's own appendix-A vectors, and the CTAP2 canonical ordering rule
 * that the encoder has to get right or signatures verify against the wrong
 * bytes.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const cbor = require('../../lib/device/cbor');

/* RFC 8949 appendix A, the subset CTAP2 can actually contain. */
const VECTORS = [
  ['00', 0],
  ['01', 1],
  ['0a', 10],
  ['17', 23],
  ['1818', 24],
  ['1819', 25],
  ['1864', 100],
  ['1903e8', 1000],
  ['1a000f4240', 1000000],
  ['20', -1],
  ['29', -10],
  ['3863', -100],
  ['3903e7', -1000],
  ['f4', false],
  ['f5', true],
  ['f6', null],
  ['60', ''],
  ['6161', 'a'],
  ['6449455446', 'IETF'],
  ['80', []],
  ['83010203', [1, 2, 3]],
  ['a0', {}],
];

describe('CBOR', { device: false }, () => {
  it('decodes the RFC 8949 vectors', async ({ assert }) => {
    for (const [hex, expected] of VECTORS) {
      const got = cbor.decode(Buffer.from(hex, 'hex'));

      if (Array.isArray(expected)) {
        assert.equal(JSON.stringify(got), JSON.stringify(expected), `0x${hex}`);
      } else if (expected && typeof expected === 'object') {
        assert.equal(got.size, 0, `0x${hex} should decode to an empty map`);
      } else {
        assert.equal(got, expected, `0x${hex}`);
      }
    }
  });

  it('encodes them back to the same bytes', async ({ assert }) => {
    for (const [hex, value] of VECTORS) {
      if (value && typeof value === 'object' && !Array.isArray(value)) continue;  // {} is a Map here
      assert.equal(cbor.encode(value).toString('hex'), hex, `re-encoding ${JSON.stringify(value)}`);
    }
  });

  it('round-trips byte strings, which JSON could not', async ({ assert }) => {
    for (const len of [0, 1, 23, 24, 255, 256, 1024]) {
      const original = Buffer.alloc(len, 0xAB);
      const back = cbor.decode(cbor.encode(original));
      assert.ok(Buffer.isBuffer(back), `${len} bytes should decode to a Buffer`);
      assert.equal(back.length, len);
      assert.equal(Buffer.compare(back, original), 0, `${len}-byte round trip`);
    }
  });

  it('sorts map keys canonically, shorter encodings first', async ({ assert }) => {
    /*
     * Not cosmetic. The authenticator hashes some of what it receives, so two
     * encodings of the same map are NOT interchangeable - a signature verifies
     * against bytes, not meaning. CTAP2's rule is: sort by encoded key length,
     * then bytewise.
     */
    /*
     * Single-byte values on purpose, so the expected bytes can be written out
     * by hand from the spec rather than derived from the encoder being tested.
     *
     *   a4          4-entry map
     *   01 01       key 1   -> 1
     *   02 03       key 2   -> 3
     *   0a 00       key 10  -> 0
     *   1864 02     key 100 -> 2      (two-byte key, so it sorts last)
     */
    const out = cbor.encode(new Map([[10, 0], [1, 1], [100, 2], [2, 3]]));
    assert.equal(out.toString('hex'), 'a4' + '0101' + '0203' + '0a00' + '186402',
      'keys must sort by encoded length, then bytewise');
  });

  it('keeps integer and string keys apart', async ({ assert }) => {
    /*
     * A plain object would stringify 1 into "1" and silently merge them. That
     * is why decode() returns Maps: CTAP2 responses are keyed by integer and
     * the WebAuthn structures inside them are keyed by string.
     */
    const decoded = cbor.decode(cbor.encode(new Map([[1, 'int'], ['1', 'str']])));
    assert.equal(decoded.get(1), 'int');
    assert.equal(decoded.get('1'), 'str');
    assert.equal(decoded.size, 2, 'the two keys must not collapse');
  });

  it('refuses what CTAP2 cannot contain', async ({ assert }) => {
    await assert.rejects(async () => cbor.encode(1.5), /no floats/);
    /* Indefinite-length (0x5F) is legal CBOR and illegal in CTAP2. */
    await assert.rejects(async () => cbor.decode(Buffer.from('5f', 'hex')),
      /unsupported length encoding/);
  });

  it('notices trailing bytes rather than ignoring them', async ({ assert }) => {
    /* A short read that silently succeeds is how a truncated response gets
     * mistaken for a valid one. */
    await assert.rejects(async () => cbor.decode(Buffer.from('0101', 'hex')),
      /trailing bytes/);
  });
});
