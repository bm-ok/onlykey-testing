/*
 * pqc.js - driving age-plugin-onlykey's on-device key operations.
 *
 * Every PQC operation the CLI asks for is gated behind a three-button challenge
 * the device makes up on the spot, and the device's only way of telling a human
 * which buttons to press is its own LEDs. A test has no eyes, so it computes the
 * digits instead - which it can, because the challenge is a pure function of a
 * packet whose contents are known before it is sent.
 *
 *   ecc_priv_flash() (okcore.cpp:5264) sees an all-0xFF key body, recognises it
 *   as "generate on device", and - for ML-KEM and X-Wing only - primes a
 *   challenge over a 9-byte packet: [keytype, 0xFF x 8]. done_process_packets()
 *   SHA256s that packet and takes bytes 0, 15 and 31 mod 6, plus one.
 *
 * So the digits are knowable, and this file knows them. What is NOT knowable
 * ahead of time is WHEN to press: priming runs synchronously inside the
 * firmware's HID report handler, blocking loop() for the best part of a second,
 * and a press that arrives during that window is not queued - it is dropped.
 *
 * The old kit solved that by watching the CLI's own "Press OnlyKey button"
 * line - which fires before the device has even been asked - and then waiting a
 * fixed margin comfortably past the longest priming it had measured. It did
 * that because the device's own "Encrypted Buffer" print, which is the exact
 * end of the blocking window, arrives over DEBUG-serial, and on a real key under
 * load that channel drops output.
 *
 * Here it does not. The debug console is an in-process event, not a USB
 * interface being polled, so this waits for the device to say it has finished
 * rather than guessing how long finishing takes. That is the whole reason to
 * have an emulator: the instrument the hardware kit wanted was there all along,
 * it just could not be trusted through a cable.
 */
'use strict';

const crypto = require('crypto');

const { PINS } = require('./config');
const cli = require('./cli');

/* okcore.h's KEYTYPE_*, mirrored in python-onlykey's age_plugin/__init__.py. */
const KEYTYPE = { MLKEM768: 5, XWING: 6 };

/* An all-0xFF key body is what tells the firmware to generate rather than
 * store - the `gen_key == 2040` trigger in ecc_priv_flash(). */
const GENERATE_TRIGGER = Buffer.alloc(8, 0xff);

/* The end of the blocking window, printed by done_process_packets()
 * (okcore.cpp:7560) once the challenge is primed and the response encrypted. */
const PRIMED = /Encrypted Buffer/g;

/**
 * The three buttons the device is about to ask for.
 *
 * done_process_packets(), okcore.cpp ~7533: SHA256 over the packet, then
 * temp[0], temp[15] and temp[31], each mod 6 plus 1. The DUO takes mod 3, and
 * this is not a DUO - if that ever changes, the digits go wrong in a way that
 * looks like the device ignoring presses.
 *
 * @param {number} keytype KEYTYPE.*
 * @returns {number[]} three buttons, 1..6
 */
function challengeDigits(keytype) {
  const packet = Buffer.concat([Buffer.from([keytype]), GENERATE_TRIGGER]);
  const hash = crypto.createHash('sha256').update(packet).digest();
  return [hash[0] % 6 + 1, hash[15] % 6 + 1, hash[31] % 6 + 1];
}

/**
 * Put the device where OKSETPRIV will be accepted, from wherever it is.
 *
 * Restart first, deliberately. Config-mode entry begins with a long press that
 * only means "config mode" on an unlocked device, and the unlock that precedes
 * it only means "unlock" on a locked one - so entering this sequence from an
 * unknown state feeds PIN digits to a device that reads them as slot presses.
 * A reboot is the cheapest way to know which state we are in, and it also
 * leaves config mode, which has no other exit.
 */
async function readyForKeygen(device, opts = {}) {
  const { pin = PINS.primary } = opts;
  await device.restart(opts);
  await device.unlock(pin, opts);
  await device.enterConfigMode(pin, opts);
}

/**
 * Run a venv binary that will trigger a keygen challenge, and answer it.
 *
 * The wait is armed BEFORE the process starts, because the device can prime the
 * challenge faster than a python interpreter takes to import its modules, and a
 * wait armed afterwards would sit through the whole thing having already missed
 * what it was waiting for.
 *
 * @param {object} device
 * @param {string} name  a venv binary, e.g. 'age-plugin-onlykey'
 * @param {string[]} argv
 * @param {object} [opts] {keytype, timeoutMs, signal, primeMs}
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
async function runWithConfirm(device, name, argv, opts = {}) {
  const {
    keytype = KEYTYPE.XWING,
    timeoutMs = 60000,
    primeMs = 30000,
    signal,
  } = opts;

  const digits = challengeDigits(keytype);
  const before = device.log.count(PRIMED);

  const primed = device.log.waitForCount(PRIMED, before + 1, {
    timeoutMs: primeMs,
    signal,
    pending: device.pending,
  });

  const running = cli.run(name, argv, { timeoutMs, signal });

  /*
   * If priming never happens the CLI is the one with the explanation - it will
   * have said what it could not do - so let it finish and report rather than
   * failing here on a timeout that only says "no press window".
   */
  try {
    await primed;
  } catch {
    return running;
  }

  /* One write, not three. The firmware paces the replay itself, which is what
   * makes this the reliable way to send a sequence - there is no host-side
   * delay between digits to get wrong. */
  device.pressLine(digits);

  return running;
}

/**
 * The whole thing: get into config mode, run the command, answer the challenge.
 *
 * Returns the CLI result. It never throws on a non-zero exit - several of these
 * tests are about the CLI failing correctly - so the caller asserts on `code`.
 */
async function generate(device, argv, opts = {}) {
  await readyForKeygen(device, opts);
  return runWithConfirm(device, 'age-plugin-onlykey', argv, opts);
}

/**
 * The identity and recipient a successful --generate prints.
 *
 * They come out on different streams, which is not an accident: the identity is
 * the only thing on stdout, so `age-plugin-onlykey --generate > identity.txt`
 * writes a usable identity file and everything else is commentary on stderr.
 *
 * @returns {{identity: string|null, recipient: string|null}}
 */
function parseGenerated({ stdout = '', stderr = '' } = {}) {
  const identity = stdout.match(/^AGE-PLUGIN-ONLYKEY-1[A-Z0-9]+$/m);
  const recipient = `${stdout}\n${stderr}`.match(/age1onlykey1[a-z0-9]+/);
  return {
    identity: identity ? identity[0] : null,
    recipient: recipient ? recipient[0] : null,
  };
}

module.exports = {
  KEYTYPE,
  GENERATE_TRIGGER,
  challengeDigits,
  readyForKeygen,
  runWithConfirm,
  generate,
  parseGenerated,
};
