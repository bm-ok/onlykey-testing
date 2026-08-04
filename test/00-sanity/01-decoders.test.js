/*
 * The keystroke decoder and the backup format, against known answers.
 *
 * Both are oracles that device tests lean on hard. 08-slot-keyboard decides
 * whether the firmware typed the right password by asking the decoder; and
 * 10-backup-restore decides whether 609 keystrokes survived by recomputing a
 * chained hash. If either were wrong, the device tests would be confidently
 * wrong in the same direction, which is worse than failing.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { KeystrokeDecoder, charFor } = require('../../lib/device/keyboard');
const backup = require('../../lib/device/backup');

/** An 8-byte boot-protocol keyboard report. */
function report(modifiers, ...keys) {
  const buf = Buffer.alloc(8);
  buf[0] = modifiers;
  keys.slice(0, 6).forEach((k, i) => { buf[2 + i] = k; });
  return buf;
}

const RELEASE = report(0);
const KEY_A = 0x04;
const KEY_1 = 0x1E;
const KEY_0 = 0x27;
const KEY_ENTER = 0x28;
const LEFT_SHIFT = 0x02;

describe('decoders', { device: false }, () => {
  it('maps the HID usage codes it is given', async ({ assert }) => {
    assert.equal(charFor(KEY_A, 0), 'a');
    assert.equal(charFor(KEY_A, LEFT_SHIFT), 'A');
    assert.equal(charFor(KEY_1, 0), '1');
    assert.equal(charFor(KEY_1, LEFT_SHIFT), '!');
    assert.equal(charFor(KEY_0, 0), '0');
    assert.equal(charFor(KEY_0, LEFT_SHIFT), ')');
    assert.equal(charFor(KEY_ENTER, 0), '\n');
    assert.equal(charFor(0x3A, 0), '', 'F1 produces no character');
  });

  it('counts a key once, not once per report', async ({ assert }) => {
    /*
     * THE bug this decoder exists to avoid. A key is pressed in one report and
     * released by the next report that omits it, so a decoder that reads every
     * report emits everything twice - and "hello123" silently becomes
     * "hheelllloo112233", which still contains the password and would pass a
     * sloppy assertion.
     */
    const dec = new KeystrokeDecoder();
    dec.feed(report(0, KEY_A));
    dec.feed(RELEASE);
    dec.feed(report(0, KEY_A));
    dec.feed(RELEASE);
    assert.equal(dec.text, 'aa', 'two presses, two characters');

    const held = new KeystrokeDecoder();
    held.feed(report(0, KEY_A));
    held.feed(report(0, KEY_A));      // still down, not a new press
    held.feed(report(0, KEY_A));
    assert.equal(held.text, 'a', 'a held key is one character');
  });

  it('decodes a whole word the way the device sends one', async ({ assert }) => {
    const dec = new KeystrokeDecoder();
    for (const code of [0x0B, 0x08, 0x0F, 0x0F, 0x12]) {   // h e l l o
      dec.feed(report(0, code));
      dec.feed(RELEASE);
    }
    assert.equal(dec.text, 'hello');
    assert.equal(dec.reports, 10, 'ten reports for five characters');
  });

  it('clears the text without forgetting what is held down', async ({ assert }) => {
    const dec = new KeystrokeDecoder();
    dec.feed(report(0, KEY_A));
    dec.clear();
    dec.feed(report(0, KEY_A));       // the same press, still held
    assert.equal(dec.text, '', 'a held key must not re-emit after a clear');
  });

  it('verifies a backup whose chained hash is right', async ({ assert }) => {
    /*
     * The hash is a FOLD, not a digest of the whole file: starting from 32 zero
     * bytes, each line becomes sha256(previous || line). Build one the way the
     * device would and check the parser agrees.
     */
    const lines = [crypto.randomBytes(48), crypto.randomBytes(48), crypto.randomBytes(12)];
    let chain = Buffer.alloc(32);
    for (const line of lines) {
      chain = crypto.createHash('sha256').update(chain).update(line).digest();
    }

    const text = [
      backup.BEGIN,
      ...lines.map((l) => l.toString('base64')),
      `--${chain.toString('base64')}`,
      backup.END,
    ].join('\n');

    const parsed = backup.parse(text);
    assert.ok(parsed.complete, 'both markers should be seen');
    assert.equal(parsed.lines, 3);
    assert.equal(parsed.data.length, 108);
    assert.ok(backup.verify(parsed), 'a correct chain should verify');
  });

  it('rejects a backup that lost a character', async ({ assert }) => {
    /* The point of the hash: a dropped keystroke has to be caught. */
    const lines = [crypto.randomBytes(48)];
    let chain = Buffer.alloc(32);
    for (const line of lines) {
      chain = crypto.createHash('sha256').update(chain).update(line).digest();
    }
    const good = [
      backup.BEGIN, ...lines.map((l) => l.toString('base64')),
      `--${chain.toString('base64')}`, backup.END,
    ].join('\n');

    assert.ok(backup.verify(backup.parse(good)), 'the control case should verify');

    /*
     * Corrupt a DATA line specifically. Dropping a character anywhere else -
     * from the BEGIN marker, say - proves nothing, because parse() skips
     * marker lines by design and the data it hashes is unchanged. (That is
     * exactly what a first attempt at this test did, and it passed for the
     * wrong reason.)
     */
    const lines2 = good.split('\n');
    const dataLine = lines2.findIndex((l) => l && !l.startsWith('-'));
    assert.ok(dataLine > 0, 'expected a base64 data line to damage');
    lines2[dataLine] = lines2[dataLine].slice(0, -2) + lines2[dataLine].slice(-1);

    const damaged = backup.parse(lines2.join('\n'));
    assert.notEqual(damaged.data.length, 48, 'the damage should change the decoded bytes');
    assert.ok(!backup.verify(damaged),
      'a backup missing a character must not verify');
  });

  it('splits restore packets the way the device expects', async ({ assert }) => {
    /*
     * 57 data bytes per packet, with a length byte in front: 0xFF means "more
     * follows" and the real count marks the last one, so the device learns the
     * end from the packet itself rather than from a terminator.
     */
    const exact = backup.toRestorePackets(Buffer.alloc(114, 1));
    assert.equal(exact.length, 2);
    assert.equal(exact[0][0], 0xFF, 'a full non-final packet is 0xFF');
    assert.equal(exact[1][0], 57, 'the final packet carries its own length');

    const ragged = backup.toRestorePackets(Buffer.alloc(60, 1));
    assert.equal(ragged.length, 2);
    assert.equal(ragged[0][0], 0xFF);
    assert.equal(ragged[1][0], 3, '60 = 57 + 3');

    const tiny = backup.toRestorePackets(Buffer.alloc(10, 1));
    assert.equal(tiny.length, 1);
    assert.equal(tiny[0][0], 10, 'a single packet is also the final one');
  });
});
