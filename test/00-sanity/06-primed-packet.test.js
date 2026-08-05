/*
 * Reading the challenge packet back out of the device's console.
 *
 * The three-button confirmation is derived from a packet the firmware hashes,
 * and there are two ways to know that packet: predict it, or read it. Predicting
 * works when the caller chose the payload and is the stronger check, because it
 * proves this kit derives what the firmware derives. Reading is what a browser
 * page needs, since a page assembles payloads nobody outside it can reconstruct.
 *
 * The reading half has one genuinely dangerous detail, and it is worth pinning
 * away from a device: `byteprint()` prints with `Serial.print(b, HEX)`, which
 * does NOT zero-pad. 0x05 prints as "5" and 0x0A as "A", so the dump is a
 * ragged mix of one- and two-character tokens - and anything that treats it as
 * fixed-width hex shifts every byte after the first small one, producing a
 * plausible-looking packet and therefore three plausible-looking wrong digits.
 *
 * `device: false`; the parser takes an object with a log, and a log is a string.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const pqc = require('../../lib/pqc');

/** Just enough of a device: the parser reads `device.log.text`. */
const fakeDevice = (text) => ({ log: { text } });

describe('the primed packet, read off the console', { device: false }, () => {
  it('reads a dump of unpadded hex', async ({ assert }) => {
    /*
     * The exact shape byteprint produces: a newline, then each byte followed by
     * a space, then a newline. The small bytes here are the point.
     */
    const device = fakeDevice([
      'done_process_packets',
      'Received Message',
      '',
      '6 FF FF FF FF FF FF FF FF ',
      '',
      'Encrypted Buffer',
    ].join('\n'));

    const packet = pqc.packetFromConsole(device);

    assert.ok(packet, 'nothing was read');
    assert.bytes(packet, Buffer.from([0x06, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
      'the keygen trigger packet');
  });

  it('does not run past the end of the dump', async ({ assert }) => {
    /*
     * Whatever the firmware prints next must not be swallowed. "512" and "16"
     * are real lines from this device's console and are perfectly good hex -
     * which is why the parser stops at the first token that is not one or two
     * hex characters rather than at the first non-hex line.
     */
    const device = fakeDevice([
      'Received Message',
      '1 2 3 ',
      'Reading nonce',
      '2954',
    ].join('\n'));

    assert.bytes(pqc.packetFromConsole(device), Buffer.from([1, 2, 3]),
      'the parser ran past the dump');
  });

  it('takes the LAST dump, not the first', async ({ assert }) => {
    /*
     * The console is an accumulator that tests deliberately do not clear, so a
     * run has many of these by the time anything reads one. The interesting
     * packet is always the most recent.
     */
    const device = fakeDevice([
      'Received Message',
      'AA BB ',
      'Encrypted Buffer',
      'Received Message',
      'C D E ',
    ].join('\n'));

    assert.bytes(pqc.packetFromConsole(device), Buffer.from([0x0C, 0x0D, 0x0E]),
      'an older packet was read');
  });

  it('has nothing to say when nothing was primed', async ({ assert }) => {
    assert.equal(pqc.packetFromConsole(fakeDevice('boot\nINITIALIZED\n')), null);
  });

  it('derives the same digits from a read packet as from a known one',
    async ({ assert }) => {
      /*
       * The two halves joined up: a packet read off the console has to produce
       * the digits the predicting path would have produced for the same bytes.
       * If these ever disagree, one of the two mechanisms is lying and the
       * device would refuse a confirmation that looked correct from here.
       */
      const packet = Buffer.concat([Buffer.from([6]), Buffer.alloc(8, 0xFF)]);
      const dumped = `Received Message\n${
        [...packet].map((b) => b.toString(16).toUpperCase()).join(' ')} \nEncrypted Buffer`;

      const read = pqc.packetFromConsole(fakeDevice(dumped));
      assert.bytes(read, packet, 'the round trip through the console format');

      assert.equal(
        JSON.stringify(pqc.challengeDigitsFor(read)),
        JSON.stringify(pqc.challengeDigits(pqc.KEYTYPE.XWING)),
        'read and predicted digits disagree for the same packet'
      );
    });
});
