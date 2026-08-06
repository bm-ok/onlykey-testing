/*
 * PARKED IN wip/, WHICH THE RUNNER DOES NOT GLOB - NOT FINISHED, 2026-08-06.
 *
 * WHAT WORKS, verified: the two IPC verbs, the 10-frame SET_REPORT write, the
 * CRC, the 16+4 key split, and the write completing on the device - the console
 * shows slot 130 and the key bytes 30 31 ... 69 6A arriving intact.
 *
 * WHERE IT STOPS: the CHALLENGE frame is sent and accepted, but
 * okcrypto_hmacsha1()'s "GENERATE HMACSHA1 MESSAGE RECEIVED" never appears, so
 * either the challenge branch is not being entered or it is being entered and
 * refusing before that print. The next thing to do is wait on process_setreport's
 * OWN earlier print, "Received HMACSHA1 Message" (okcore.cpp:7843), which fires
 * before okcrypto_hmacsha1() is called - if THAT appears the branch is entered
 * and the problem is inside the handler; if it does not, the buffer is not
 * routing to the challenge branch at all and keyboard_buffer[64] is the thing
 * to dump.
 *
 * Everything below the header is measured rather than assumed, and the four
 * traps recorded in it each cost a run. Parked rather than deleted for exactly
 * that reason.
 *
 * Section 1: Yubikey-style HMAC-SHA1 challenge-response over HID CONTROL
 * TRANSFERS on the keyboard interface.
 *
 * NOT `15-hmac-secret`. That file is FIDO2's `hmac-secret` extension - CTAP2,
 * on the FIDO interface, salts wrapped for a password manager. This is the
 * Yubikey challenge-response protocol reached through SET_REPORT (0x0921) and
 * GET_REPORT (0x01a1), which is a different mechanism on a different interface
 * with different guards. They share three letters and nothing else, and they
 * sit in the same directory, so the distinction is stated here rather than left
 * to whoever greps for "hmac" next.
 *
 * GATED `emulated`, OUT LOUD. The hardware adapter THROWS for kbdSetReport and
 * kbdGetReport by design - hidraw would need HIDIOCSFEATURE/HIDIOCGFEATURE and
 * the udev access to read a workstation's keyboard interface, which is a
 * separate piece of work. Without this gate the file fails on a key for a
 * reason that looks like a device fault rather than an unbuilt seam.
 *
 * THIS IS A THIRD COMMAND CHANNEL. `process_setreport()` (okcore.cpp:7657)
 * sits beside the vendor interface and the WebAuthn tunnel, and it is the least
 * examined of the three - not by judgement but because the harness could not
 * reach it until the IPC verbs landed. It also outlives the debug console: a
 * production key ships without SEREMU, and the keyboard interface ships on
 * every build because it is the device's primary function.
 *
 * SURFACE: the keyboard interface's control transfers, for everything. The
 * debug console is not read anywhere in this file, so it survives into a
 * production walk.
 *
 * THE WIRE PROTOCOL, since none of it is guessable and all of it cost a read:
 *
 *   - A 70-byte `keyboard_buffer` is filled SEVEN BYTES AT A TIME. Each
 *     SET_REPORT carries 8 bytes: 7 of payload plus a sequence marker
 *     0x80..0x89 in byte 7, and the firmware copies to
 *     `keyboard_buffer[i + (marker - 0x80) * 7]`.
 *   - **The copy happens inside GET_REPORT, not SET_REPORT.** So every frame
 *     must be followed by a GET_REPORT or nothing lands. That is the Yubikey
 *     personalization protocol's write-then-poll shape, and a sender that only
 *     writes gets a device that never received anything.
 *   - `check_crc()` is CRC-16/MCRF4XX over bytes 0..63 only, little-endian at
 *     [65..66]. **The slot selector at [64] is NOT covered by it**, which is
 *     worth knowing before trusting the checksum to protect the routing.
 *   - The answer comes back as FOUR GET_REPORTs of 8 bytes, walking
 *     `getBuffer[8]` 0x40 -> 0x43, each ending in its own marker: 0xC0 at
 *     kb[7], 0xC1 at [15], 0xC2 at [23], 0xC3 at [31].
 *   - The 20-byte HMAC is SPLIT across those reports - kb[0..6], kb[8..14],
 *     kb[16..21] - with the CRC-16/X-25 of the HMAC at kb[22] (low) and kb[24]
 *     (high), and a constant 0x4B at kb[28] the source calls a "mystery byte".
 *
 * TWO SLOT-SELECTOR VOCABULARIES, WHICH IS THE TRAP THIS FILE WAS NEARLY BUILT
 * WRONG ON. `keyboard_buffer[64]` means different things in different branches:
 * 1 and 3 WRITE a key (to slots 130 and 129), while 0x30 and 0x38 CHALLENGE
 * those same two slots. TODO carried 0x30/0x38, was "corrected" to 1/3, and
 * that correction was wrong - both are real, for different operations.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');

/* okcore.h: the two reserved ECC slots the HMAC keys live in. */
const HMACSHA1_1 = 130;
const HMACSHA1_2 = 129;

/* keyboard_buffer[64] values - see the header. */
const WRITE_SLOT_1 = 1;          // writes RESERVED_KEY_HMACSHA1_1 (130)
const CHALLENGE_SLOT_1 = 0x30;   // challenges that slot
const CHALLENGE_SLOT_2 = 0x38;   // challenges HMACSHA1_2 (129)

const KBD_BUFFER_SIZE = 70;

/*
 * THE WRITE'S COMPLETION MARKER, AND WHY IT IS NOT THE OBVIOUS STRING.
 *
 * The acknowledgement "Successfully set ECC Key" never appears on the console
 * as TEXT - `byteprint()` renders it as hex, so what arrives is
 * "53 75 63 63 65 73 73 66 75 6C 6C 79 ...". A regex for the readable string
 * matches nothing and times out looking exactly like a device that did not
 * answer. Cost a run to find. "Sending transport response data" is printed with
 * Serial.println and is plain text, so it is the marker that works.
 */
const WRITE_DONE = /Sending transport response data/;

/** CRC-16/MCRF4XX, which is what libyubikey's yubikey_crc16 computes. */
function crc16(buf, len = buf.length) {
  let crc = 0xffff;
  for (let n = 0; n < len; n++) {
    crc ^= buf[n] & 0xff;
    for (let i = 0; i < 8; i++) {
      const j = crc & 1;
      crc >>= 1;
      if (j) crc ^= 0x8408;
    }
  }
  return crc & 0xffff;
}

/** A 70-byte keyboard_buffer with its input CRC in place. */
function kbdBuffer(fill) {
  const buf = Buffer.alloc(KBD_BUFFER_SIZE, 0);
  fill(buf);
  const crc = crc16(buf, 64);      // bytes 0..63 ONLY; [64] is not covered
  buf[65] = crc & 0xff;
  buf[66] = crc >> 8;
  return buf;
}

/**
 * Push a keyboard_buffer to the device, seven bytes per control transfer.
 *
 * The GET_REPORT after each frame is not a poll for politeness - it is what
 * performs the copy. `okemu_kbd_get_report()` (and usb_dev.c before it) does
 * the `keyboard_buffer[i + (marker - 0x80) * 7] = setBuffer[i]` there.
 */
async function sendKbdBuffer(device, buf, { signal }) {
  const frames = Math.ceil(KBD_BUFFER_SIZE / 7);   // 10, markers 0x80..0x89
  const status = [];
  for (let f = 0; f < frames; f++) {
    const frame = Buffer.alloc(8, 0);
    buf.copy(frame, 0, f * 7, Math.min(f * 7 + 7, KBD_BUFFER_SIZE));
    frame[7] = 0x80 + f;
    device.kbdSetReport(frame);
    status.push(await device.kbdGetReport({ signal, timeoutMs: 8000 }));
  }
  return status;
}

/**
 * Read the four response reports, or report that nothing was staged.
 *
 * Before an HMAC completes, kb[31] is not 0xC3 and GET_REPORT answers with the
 * STATUS block instead - which is how "the device is waiting for a press" is
 * told apart from "the device answered". The marker check is what distinguishes
 * them, so it is the first thing asserted rather than an afterthought.
 */
/**
 * Wait for process_setreport() to actually CONSUME the buffer just sent.
 *
 * THE FINAL FRAME ONLY QUEUES THE WORK. It sets `setBuffer[8] = 1`, and
 * OnlyKey.ino:477 runs process_setreport() on the next main-loop pass
 * satisfying `!isfade || configmode` - so while an LED fade is running, which
 * is what an unlock leaves behind, the request sits there. Measured on the
 * emulator: 2504ms between the last frame and the handler firing.
 *
 * Sending a second buffer before the first is consumed OVERWRITES
 * keyboard_buffer and the queued operation runs on the wrong bytes. The first
 * version of this file wrote then challenged back to back, and the symptom was
 * a challenge that answered nothing - indistinguishable from a refusal.
 *
 * WHY THIS WAITS ON THE CONSOLE RATHER THAN ON GET_REPORT, which is the more
 * obvious choice and is WRONG: after the last frame `setBuffer[7]` is still
 * 0x89, so every additional GET_REPORT re-enters the hand-off branch and
 * rewrites `getBuffer[7]`. Polling for the 0xaf that process_setreport() sets
 * on its way out therefore destroys the signal it is looking for - measured,
 * the poll returned 0x00 forever. An observer that perturbs what it observes is
 * worse than a slower one.
 */
async function waitConsumed(device, re, { signal, timeoutMs = 20000 }) {
  return device.log.waitFor(re, { timeoutMs, signal });
}

async function readResponse(device, { signal, waitMs = 6000 }) {
  /*
   * POLL FOR THE FIRST 0xC0 RATHER THAN ASSUMING THE ANSWER IS READY.
   *
   * The final frame only sets `setBuffer[8] = 1`, which HANDS OFF to
   * process_setreport() - it does not run it. That happens in the firmware's
   * main loop, so an immediate read returns the status block with
   * getBuffer[7] = 0x89 and nothing staged. Measured: the first version of this
   * file read four reports straight away and got markers [0x89 x4], which reads
   * exactly like a device that refused.
   *
   * Polling is safe here precisely because nothing is staged yet: the
   * multi-report branch needs getBuffer[7] >= 0xa1, which process_setreport()
   * sets only on its way out, so a poll before then cannot consume part of a
   * sequence. Once 0xC0 arrives the remaining three reports follow immediately.
   */
  const deadline = Date.now() + waitMs;
  let last = null;
  for (;;) {
    last = await device.kbdGetReport({ signal, timeoutMs: 8000 });
    if (last[7] === 0xC0) break;
    if (Date.now() > deadline) {
      return { staged: false, raw: last, markers: [last[7]], polled: true };
    }
    await device.sleep(250, { signal });
  }

  const parts = [last];
  for (let i = 0; i < 3; i++) {
    parts.push(await device.kbdGetReport({ signal, timeoutMs: 8000 }));
  }
  const raw = Buffer.concat(parts);
  const markers = [raw[7], raw[15], raw[23], raw[31]];
  const staged = markers[0] === 0xC0 && markers[1] === 0xC1
    && markers[2] === 0xC2 && markers[3] === 0xC3;
  if (!staged) return { staged: false, raw, markers };

  const hmac = Buffer.concat([
    raw.subarray(0, 7), raw.subarray(8, 15), raw.subarray(16, 22),
  ]);
  const crc = raw[22] | (raw[24] << 8);
  return { staged: true, raw, markers, hmac, crc, mystery: raw[28] };
}

/** The write frame: slot selector, write request, and the split key. */
function writeKeyBuffer(selector, key) {
  return kbdBuffer((buf) => {
    buf[64] = selector;
    buf[45] = 5;        // request to write
    buf[46] = 0x60;     // "Set HMAC Key using Yklib"
    /*
     * THE KEY IS SPLIT, and the firmware's own comment says "HMAC key split for
     * some reason". process_setreport() does
     *   recv_buffer+7  <- keyboard_buffer+22  (16 bytes)
     *   recv_buffer+23 <- keyboard_buffer+16  (4 bytes)
     * so the FIRST sixteen bytes of the key go at offset 22 and the LAST four
     * at offset 16 - out of order, and silently wrong if mirrored naively.
     */
    key.copy(buf, 22, 0, 16);
    key.copy(buf, 16, 16, 20);
  });
}

/** The challenge frame: selector plus the challenge at offset 0. */
function challengeBuffer(selector, challenge) {
  return kbdBuffer((buf) => {
    buf[64] = selector;
    challenge.copy(buf, 0);
  });
}

describe('HMAC-SHA1 challenge-response over keyboard control transfers', {
  state: 'initialized',
  requires: ['emulated', 'crypto'],
  timeoutMs: 300000,
}, () => {
  /*
   * A 20-byte key, which is what Sha1.initHmac(ecc_private_key, 20) reads, and
   * a 32-byte challenge whose LAST BYTE IS NON-ZERO.
   *
   * That is load-bearing. okcrypto_hmacsha1() infers the challenge length by
   * scanning back from byte 63 for the last non-zero byte (never below 16), so
   * a challenge ending in 0x00 would be hashed SHORTER than it was sent and the
   * host's oracle would disagree for a reason that looks like a crypto fault.
   */
  const KEY = Buffer.from('303132333435363738396162636465666768696a', 'hex');
  const CHALLENGE = Buffer.concat([
    Buffer.from('okt hmac challenge, 32 bytes long', 'latin1').subarray(0, 31),
    Buffer.from([0xff]),
  ]);

  it('writes an HMAC key, then answers a challenge with the HMAC-SHA1 node:crypto computes',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(PINS.primary, { signal });

      /* ---- write the key to HMACSHA1_1 (slot selector 1) ---- */
      device.log.clear();
      await sendKbdBuffer(device, writeKeyBuffer(WRITE_SLOT_1, KEY), { signal });
      await waitConsumed(device, WRITE_DONE, { signal });
      log(`wrote a 20-byte HMAC key to slot ${HMACSHA1_1}`);

      /* ---- challenge that slot (selector 0x30) ---- */
      device.log.clear();
      await sendKbdBuffer(device, challengeBuffer(CHALLENGE_SLOT_1, CHALLENGE), { signal });
      await waitConsumed(device, /GENERATE HMACSHA1 MESSAGE RECEIVED/, { signal });
      const res = await readResponse(device, { signal });

      assert.ok(res.staged,
        'the device did not stage an HMAC response - the four reports came back ' +
        `with markers ${JSON.stringify(res.markers)} rather than C0/C1/C2/C3, ` +
        'which is the status block rather than an answer');

      /*
       * THE ORACLE IS node:crypto, which has never spoken to the device. The
       * message is the first `inputlen` bytes of keyboard_buffer, and inputlen
       * is inferred as 32 for this challenge - so the device and the host must
       * agree about the LENGTH as well as the bytes, and a length disagreement
       * shows up as a completely different digest rather than a near miss.
       */
      const want = crypto.createHmac('sha1', KEY).update(CHALLENGE).digest();
      log(`device ${res.hmac.toString('hex')}`);
      log(`node   ${want.toString('hex')}`);
      assert.bytes(res.hmac, want,
        'the device computed a different HMAC-SHA1 than node:crypto over the same ' +
        'key and challenge');

      /*
       * The CRC is the device's own checksum of its answer, converted from
       * MCRF4XX to X-25 by the firmware's `crc ^= 0xFFFF`. Checking it proves
       * the response was reassembled from the right four reports in the right
       * order - a transposition would still produce 20 plausible bytes.
       */
      assert.equal(res.crc, crc16(want, 20) ^ 0xffff,
        'the response CRC does not match the HMAC it accompanies, so the four ' +
        'reports were not reassembled correctly');
      assert.equal(res.mystery, 0x4B,
        'kb[28] is not the constant 0x4B the firmware writes there');
    });

  it('requires no button press on a slot whose key was just written - the flag that removes user presence',
    async ({ device, assert, signal, log }) => {
      /*
       * PINNED AS IT SHIPS, AND THIS IS THE SECURITY-RELEVANT HALF.
       *
       * Writing a key through this path ALWAYS ends in
       * `okeeprom_eeset_hmac_challengemode(&mode)` with `mode` set to the slot
       * just written (okcore.cpp:7703-7730, commented "Authlite requires no
       * press required"). The default is 0, meaning physical presence IS
       * required - so writing a key SILENTLY REMOVES the button press for that
       * slot, and nothing in the write acknowledges it.
       *
       * The challenge branch then reads
       * `if (hmac_challenge_disabled == 1 || hmac_challenge_disabled == crslot)`
       * and runs okcrypto_hmacsha1() inline.
       *
       * The test asserts the CONSEQUENCE rather than the flag: a challenge
       * answered with no press at all. It fails the day presence stops being
       * removed - which would be a behaviour change worth someone reading this
       * comment for.
       */
      await device.ensureUnlocked(PINS.primary, { signal });
      device.log.clear();
      await sendKbdBuffer(device, writeKeyBuffer(WRITE_SLOT_1, KEY), { signal });
      await waitConsumed(device, WRITE_DONE, { signal });

      device.log.clear();
      await sendKbdBuffer(device, challengeBuffer(CHALLENGE_SLOT_1, CHALLENGE), { signal });
      await waitConsumed(device, /GENERATE HMACSHA1 MESSAGE RECEIVED/, { signal });
      const before = device.log.count(/Waiting for challenge buttons/);
      const res = await readResponse(device, { signal });

      assert.ok(res.staged,
        'no answer came back without a press, so this slot still demands one - ' +
        'if that is deliberate now, the write path stopped setting challengemode');

      const want = crypto.createHmac('sha1', KEY).update(CHALLENGE).digest();
      assert.bytes(res.hmac, want, 'the press-free answer is not the right HMAC');

      /*
       * The control that makes "no press was needed" mean something: the device
       * must not have ASKED either. Counting its own waiting message is the
       * only way to tell "answered immediately" from "answered because
       * something else pressed a button".
       */
      assert.equal(device.log.count(/Waiting for challenge buttons/), before,
        'the device asked for a button press and something answered it - this ' +
        'test proves nothing unless no press was requested');
      log('answered with no press requested, and no press given');
    });

  it('demands a button press on a slot whose key was never written this way, and answers nothing until it arrives',
    async ({ device, assert, signal, log }) => {
      /*
       * THE OTHER PATH, and reaching it needs a detail the flag logic makes
       * awkward: any slot written through SET_REPORT has its press requirement
       * removed, so the press path is only reachable on a slot that has NOT
       * been written that way.
       *
       * Writing slot 1 sets challengemode to 130. Challenging slot 2 then finds
       * `hmac_challenge_disabled` (130) neither 1 nor its own crslot (129), so
       * it takes the else: CRYPTO_AUTH = 3, packet_buffer_details[0] = OKHMAC,
       * a yellow fade, and a twenty-second window.
       *
       * The key is the device's derived default (`type == 0` in
       * okcrypto_hmacsha1()), so the ANSWER cannot be predicted here - which is
       * why this test asserts the gate rather than the digest. The digest is
       * proven in the first test, on the slot where the key is known.
       */
      await device.ensureUnlocked(PINS.primary, { signal });
      device.log.clear();
      await sendKbdBuffer(device, writeKeyBuffer(WRITE_SLOT_1, KEY), { signal });
      await waitConsumed(device, WRITE_DONE, { signal });

      device.log.clear();
      await sendKbdBuffer(device, challengeBuffer(CHALLENGE_SLOT_2, CHALLENGE), { signal });
      await waitConsumed(device, /GENERATE HMACSHA1 MESSAGE RECEIVED|Waiting for challenge buttons/, { signal });

      /*
       * FIRST: nothing is staged. This is the assertion that matters - a device
       * that answered here would be one that skipped user presence.
       */
      const beforePress = await readResponse(device, { signal, waitMs: 2500 });
      assert.ok(!beforePress.staged,
        'the device staged an HMAC response for a slot that requires a button ' +
        `press, without one - markers ${JSON.stringify(beforePress.markers)}`);
      log('nothing staged before the press, which is the gate holding');

      /* The device says so itself, which is the positive control for the
       * absence above: silence from a wedged device would look identical. */
      await device.log.waitFor(/Waiting for challenge buttons/,
        { timeoutMs: 15000, signal });
      log('the device asked for a press');

      /*
       * THEN press. The handler clause is
       * `(CRYPTO_AUTH == 3 && packet_buffer_details[0] == OKHMAC && isfade)`,
       * so any button satisfies it - it is a presence check rather than a
       * challenge, unlike the three-digit crypto confirmation.
       */
      await device.press(1);
      await device.sleep(1500, { signal });

      const afterPress = await readResponse(device, { signal });
      assert.ok(afterPress.staged,
        'the press did not release the answer - markers ' +
        `${JSON.stringify(afterPress.markers)}`);
      assert.equal(afterPress.crc, crc16(afterPress.hmac, 20) ^ 0xffff,
        'the answer released by the press does not match its own CRC');
      log(`answered after one press: ${afterPress.hmac.toString('hex')}`);
    });
});
