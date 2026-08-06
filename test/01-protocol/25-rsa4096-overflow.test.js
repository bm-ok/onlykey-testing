/*
 * Section 1: the RSA-4096 one-byte overflow, pinned as it ships.
 *
 * THE DEFECT IS THE SUBJECT. `rsa_priv_flash()` accumulates a key in fixed
 * 57-byte memcpys whose length is a literal, never clamped to what remains in
 * the destination. For type 4 the offsets satisfying `<= 456` are 0, 57, ...,
 * 456 - nine of them - and the ninth copies 57 bytes to `rsa_private_key + 456`,
 * touching index 512 of a 512-byte array. See FINDING-rsa4096-overflow.md.
 *
 * THIS FILE EXISTS BECAUSE THE FINDING SHOULD NOT REST ON A ONE-OFF
 * OBSERVATION. Until 2026-08-06 the kit could not test its own most serious
 * finding: the overflow kills the device host, the runner classified that as a
 * run-level abort, and no assertion ran. `23-rsa-tunnel`'s 4096 case had to be
 * gated off behind OKT_EXPECT_RSA4096_FIX just to let its file land. What
 * changed is `device.expectFatal()`, which captures a crash as evidence and
 * continues against a fresh host.
 *
 * IT WILL FAIL WHEN THE DEFECT IS FIXED, deliberately - expectFatal() rejects
 * if the device SURVIVES. That is the right direction for a regression test on
 * a live defect: the day `rsa_priv_flash()` clamps its copy, this goes red and
 * whoever sees it should retire the file and ungate `23-rsa-tunnel`'s boundary
 * case, which is still blocked because it needs the key to LOAD.
 *
 * SURFACE: the device host's exit status, which is emulated-only by nature - a
 * physical key is not a child process. Gated `emulated` out loud, and doubly
 * so: driving a known out-of-bounds WRITE at real hardware, where
 * _FORTIFY_SOURCE is not there to stop it, is the one thing this defect makes
 * unsafe. The same reasoning gates `23-rsa-tunnel`'s 4096 test.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const pqc = require('../../lib/pqc');

/* rsa_priv_flash() copies a fixed 57 bytes per report - the literal that is
 * never clamped, and the whole mechanism. */
const CHUNK = 57;

/* Type 4 (4096-bit) with the SIGN feature bit, the shape the finding used. */
const TYPE_4096 = 4;
const FEATURE_SIGN = 0x40;

describe('the RSA-4096 key load overflows and aborts the firmware', {
  state: 'initialized',
  requires: ['emulated', 'crypto'],
  timeoutMs: 300000,
}, () => {
  it('aborts on the ninth chunk, and the abort is classified as a firmware crash',
    async ({ device, assert, signal, log }) => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
      const jwk = privateKey.export({ format: 'jwk' });
      const pq = Buffer.concat([
        Buffer.from(jwk.p, 'base64url'), Buffer.from(jwk.q, 'base64url'),
      ]);
      assert.equal(pq.length, 512, 'a 4096-bit key is 512 bytes of P||Q');

      await pqc.readyForKeygen(device, { signal });
      const before = device.generation;

      const ev = await device.expectFatal(async () => {
        for (let i = 0; i < pq.length; i += CHUNK) {
          device.sendVendor({
            msg: okmsg.MSG.OKSETPRIV, slot: 2,
            field: TYPE_4096 | FEATURE_SIGN,
            payload: pq.subarray(i, i + CHUNK),
          });
          await device.sleep(120, { signal });
        }
      }, { signal, timeoutMs: 40000 });

      log(`kind=${ev.kind} signal=${ev.signal} generation=${ev.generation}`);

      /*
       * A FORTIFY TRIP, NOT A SEGFAULT, and the distinction is the finding's
       * whole value. The emulator builds with _FORTIFY_SOURCE so the overflow
       * aborts AT the write; on a physical key the same write lands silently
       * and surfaces later somewhere unrelated, if at all.
       *
       * This also depends on classifyExit() calling SIGABRT a firmware crash,
       * which it did not until 2026-08-06 - it reported exit 5, "the run
       * produced no verdict". So this assertion is what keeps the kit's verdict
       * and its own finding from drifting apart again.
       */
      assert.equal(ev.kind, 'firmware-crash',
        `the abort was classified ${ev.kind} rather than a firmware crash`);
      assert.match(ev.stderr, /\*\*\* (buffer overflow|stack smashing) detected \*\*\*/,
        'the captured stderr does not carry glibc\'s own diagnosis, so this ' +
        'crash may not be the overflow at all');

      /*
       * THE CONTROL, and without it this test proves much less than it looks.
       * "The device died" is equally what a broken send, a wedged host or an
       * unrelated bug produces. Requiring the run to CONTINUE - a fresh host,
       * an advanced generation, a device that answers again - is what says the
       * crash was the contained, expected one rather than the end of anything.
       */
      await device.waitReady({ signal });
      assert.ok(device.generation > before,
        'no fresh device host came up, so the crash was not contained');
      const status = await device.status({ signal });
      assert.notEqual(status.state, 'unknown',
        `the replacement host is not answering: ${status.raw}`);
      log(`recovered: ${status.state} at generation ${device.generation}`);
    });

  it('loads a 2048-bit key through the same path without aborting, which is the control',
    async ({ device, assert, signal, log }) => {
      /*
       * THE POSITIVE CONTROL FOR THE TEST ABOVE, in its own right rather than
       * as a comment: the same code path, the same framing, one size smaller.
       * Type 2's offsets stop at 228 and the last copy ends at 285, inside the
       * 512-byte array - so it must NOT abort.
       *
       * Without this, "sending chunks kills the device" would be consistent
       * with the kit framing OKSETPRIV wrongly. With it, the difference is the
       * key size and nothing else.
       */
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = privateKey.export({ format: 'jwk' });
      const pq = Buffer.concat([
        Buffer.from(jwk.p, 'base64url'), Buffer.from(jwk.q, 'base64url'),
      ]);

      await pqc.readyForKeygen(device, { signal });
      const since = device.mark(IFACE.VENDOR);
      for (let i = 0; i < pq.length; i += CHUNK) {
        device.sendVendor({
          msg: okmsg.MSG.OKSETPRIV, slot: 2, field: 2 | FEATURE_SIGN,
          payload: pq.subarray(i, i + CHUNK),
        });
        await device.sleep(120, { signal });
      }

      const ack = await device.waitHid(IFACE.VENDOR,
        { since, match: /Successfully|Error/, timeoutMs: 25000, signal });
      const said = okmsg.text(ack).trim();
      log(`device said: ${said}`);
      assert.match(said, /Successfully set RSA Key/,
        `the 2048-bit control did not load: ${said}`);
      assert.ok(!device.fatal, 'the 2048-bit load killed the device, which it must not');
    });
});
