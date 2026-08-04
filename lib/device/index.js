/*
 * device/index.js - the one device API every test is written against.
 *
 * There is one API with two adapters behind it, and the differences between
 * them are hidden HERE rather than pushed onto test code:
 *
 *   Report ID. The proven hardware client always prepends a zero byte, but the
 *   emulator's delivery path pads to 64 and does not strip a leading report ID
 *   - so identical test code would put different bytes on the wire in each
 *   mode. Payloads carry no report ID and the hardware adapter adds it.
 *
 *   Chunking and zero-padding. The firmware already emits exactly 64 bytes for
 *   RawHID and already flushes SEREMU at 64 bytes or at a newline; the bridges
 *   re-chunk and pad only because a hidraw reader must read the descriptor's
 *   declared count. The emulated path replicates none of that, and the hardware
 *   adapter strips the padding on the way in, so both normalise to the same
 *   line stream.
 *
 * A test never constructs this. The runner builds it, prepares the device state
 * the file's metadata asks for, and injects it.
 */
'use strict';

const { LogBuffer } = require('./logbuf');
const { KeystrokeDecoder } = require('./keyboard');
const { PendingSet, tracked, sleep, anySignal, TimeoutError } = require('./waits');
const okmsg = require('./okmsg');

/* usb_desc.h's interface numbers, which the firmware and the descriptors use. */
const IFACE = { KEYBOARD: 0, FIDO: 1, VENDOR: 2, SEREMU: 3 };

/*
 * The firmware's own debug button harness (okcore.cpp, touch_sense_loop): a
 * line of ASCII digits selects the buttons, '!' per hold tier modifies the digit
 * before it, and newline commits the line. This - not the analog touch pads -
 * is the supported way to drive buttons, and it exists only in DEBUG builds.
 */
const HOLD_MODIFIER = { tap: '', hold: '!', long: '!!', longest: '!!!' };
const DBG_QUEUE_MAX = 16;   // firmware queue depth; past it the tail is dropped
const DBG_LINE_MAX = 32;    // firmware raw line buffer, one SEREMU OUT report

const HID_HISTORY = 64;     // reports kept per interface, for retroactive waits

class Device {
  /**
   * @param {object} transport an EmulatedTransport (or, later, a hardware one)
   * @param {object} [opts] {capabilities, signals}
   */
  constructor(transport, opts = {}) {
    this.transport = transport;
    this.capabilities = opts.capabilities || null;
    /* Extra cancellation sources the runner owns - the inactivity budget and
     * the run maximum. A watchdog that cannot cut a wait short is a watchdog
     * that reports a stall after the run has already stopped mattering. */
    this.externalSignals = opts.signals || [];

    this.pending = new PendingSet();
    this.log = new LogBuffer({ pending: this.pending });
    this.keys = new KeystrokeDecoder();
    this.led = [];

    this.hid = { [IFACE.FIDO]: [], [IFACE.VENDOR]: [], [IFACE.KEYBOARD]: [] };
    this._hidSubscribers = new Set();

    /*
     * A device that has died must not be waited on. Every wait below is
     * cancellable from two directions - the test's own deadline and the device
     * disappearing underneath it - because without the second one a firmware
     * crash mid-wait surfaces as an ordinary timeout seconds later, with the
     * crash nowhere near the failure it caused.
     */
    this._fatalController = new AbortController();

    transport.on('log', (text) => this.log.append(text));
    transport.on('led', (pixels) => { this.led = pixels; });
    transport.on('keyboard', (data) => {
      this._recordHid(IFACE.KEYBOARD, data);
      this.keys.feed(data);
    });
    transport.on('hid', (iface, data) => this._recordHid(iface, data));
    transport.on('fatal', (info) => {
      this._fatalController.abort(new Error(info.reason));
    });
  }

  get generation() { return this.transport.generation; }
  /** Where flash.bin and eeprom.bin live for this run - they are ordinary
   *  files, which is what makes device state snapshottable at all. */
  get storageDir() { return this.transport.storageDir; }
  get restarts() { return this.transport.restarts; }
  get fatal() { return this.transport.fatal; }
  get keystrokes() { return this.keys.text; }

  /** Options every wait shares: device-death cancellation folded in. */
  _opts(opts = {}) {
    return {
      ...opts,
      pending: this.pending,
      signal: anySignal([opts.signal, this._fatalController.signal, ...this.externalSignals]),
    };
  }

  _recordHid(iface, data) {
    const list = this.hid[iface] || (this.hid[iface] = []);
    list.push(Buffer.from(data));
    if (list.length > HID_HISTORY) list.shift();
    for (const fn of [...this._hidSubscribers]) {
      try { fn(iface); } catch { /* a waiter must not break the feed */ }
    }
  }

  /* ---- raw traffic ------------------------------------------------------ */

  /**
   * Host -> device. No report ID, no padding: see the note at the top.
   * @param {number} iface IFACE.*
   * @param {Buffer|number[]|string} data  string is taken as latin1
   */
  send(iface, data) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data);
    this.transport.writeHid(buf, iface);
    return buf;
  }

  /** Build and send one client-protocol message on the vendor interface. */
  sendVendor(spec) {
    return this.send(IFACE.VENDOR, okmsg.build(spec));
  }

  /**
   * How many reports this interface has already produced.
   *
   * Take a mark BEFORE sending a request, then wait with {since: mark}, so the
   * wait cannot be satisfied by a report that arrived before the request. Waits
   * are otherwise retroactive by design - the device broadcasts its status once
   * a second whether anyone asked or not, and a wait armed a millisecond late
   * would sit through a whole broadcast interval for no reason.
   */
  mark(iface) { return (this.hid[iface] || []).length; }

  /**
   * Wait for a report on `iface`.
   * @param {number} iface
   * @param {object} [opts] {match, since, timeoutMs, signal}
   *   match  RegExp tested against the report as text, or (buf) => boolean
   *   since  index from mark(); defaults to 0, i.e. retroactive
   * @returns {Promise<Buffer>}
   */
  waitHid(iface, opts = {}) {
    const { match, since = 0 } = opts;
    const test = matcherFor(match);
    const list = () => this.hid[iface] || [];

    const scan = () => {
      const reports = list();
      for (let i = since; i < reports.length; i++) {
        if (test(reports[i])) return reports[i];
      }
      return null;
    };

    const already = scan();
    if (already) return Promise.resolve(already);

    const what = match instanceof RegExp ? ` matching /${match.source}/` : '';
    return tracked(
      `a report on ${ifaceName(iface)}${what}`,
      this._opts({ timeoutMs: 5000, ...opts }),
      (resolve) => {
        const fn = () => { const hit = scan(); if (hit) resolve(hit); };
        this._hidSubscribers.add(fn);
        return () => this._hidSubscribers.delete(fn);
      }
    );
  }

  /** Wait for the next keyboard report, raw. */
  waitKeyboard(opts = {}) {
    return this.waitHid(IFACE.KEYBOARD, opts);
  }

  /**
   * Wait until the device has TYPED something matching.
   *
   * The debug console announces the keybuffer before the keystrokes go out -
   * the typing is paced by a separate task at TYPESPEED - so waiting on the log
   * and then reading the keystrokes reads them too early, measured as an empty
   * string a second before "hello123" showed up. This waits on the keystrokes
   * themselves, which is the thing under test anyway.
   */
  waitKeystrokes(matcher, opts = {}) {
    const re = matcher instanceof RegExp
      ? matcher
      : new RegExp(String(matcher).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    if (re.test(this.keystrokes)) return Promise.resolve(this.keystrokes);

    return tracked(
      `the device to type /${re.source}/`,
      this._opts({ timeoutMs: 15000, ...opts }),
      (resolve) => {
        const fn = () => { if (re.test(this.keystrokes)) resolve(this.keystrokes); };
        this._hidSubscribers.add(fn);
        return () => this._hidSubscribers.delete(fn);
      }
    );
  }

  /* ---- buttons ---------------------------------------------------------- */

  /**
   * One press. n is 1..6.
   * @param {number} n
   * @param {object} [opts] {hold: 'tap'|'hold'|'long'|'longest', ticks}
   */
  press(n, opts = {}) {
    return this.pressLine([{ button: n, ...opts }]);
  }

  /**
   * A sequence of presses in ONE write.
   *
   * The firmware paces the replay itself, so this is the reliable way to enter
   * a PIN: there is no host-side delay between digits to get wrong. A 7-digit
   * PIN sent as seven separate writes is how the old kit ended up with the
   * "store" message landing mid-burst and the firmware seeing a 5-digit PIN.
   *
   * @param {Array<number|string|object>} presses
   */
  pressLine(presses) {
    const items = normalisePresses(presses);
    if (items.length > DBG_QUEUE_MAX) {
      throw new RangeError(
        `at most ${DBG_QUEUE_MAX} presses per line (the firmware's queue depth), ` +
        `got ${items.length}`
      );
    }

    const line = items.map(({ button, hold, ticks }) => {
      if (!Number.isInteger(button) || button < 1 || button > 6) {
        throw new RangeError(`button must be 1..6, got ${button}`);
      }
      if (ticks !== undefined) {
        if (!Number.isInteger(ticks) || ticks < 1) {
          throw new RangeError(`ticks must be a positive integer, got ${ticks}`);
        }
        return `${button}#${ticks}`;
      }
      const tier = hold || 'tap';
      if (!(tier in HOLD_MODIFIER)) {
        throw new RangeError(
          `hold must be one of ${Object.keys(HOLD_MODIFIER).join(', ')}, got ${tier}`
        );
      }
      return `${button}${HOLD_MODIFIER[tier]}`;
    }).join('');

    /* The modifiers can exhaust the firmware's line buffer before the queue
     * does - sixteen 'longest' holds is 64 bytes. */
    if (line.length > DBG_LINE_MAX) {
      throw new RangeError(
        `press line is ${line.length} bytes, the firmware accepts ${DBG_LINE_MAX}: ${line}`
      );
    }

    this.sendDebugLine(line);
    return line;
  }

  /** One line of the firmware's DEBUG protocol. Return is the only terminator. */
  sendDebugLine(text) {
    return this.send(IFACE.SEREMU, `${text}\n`);
  }

  /* ---- lifecycle -------------------------------------------------------- */

  /** Resolve once the current generation has booted AND is listening. */
  async waitReady(opts = {}) {
    await this.transport.waitForBoot(this._opts({ timeoutMs: 20000, ...opts }));
    await this.waitResponsive(opts);
    return this.generation;
  }

  /**
   * Wait until the firmware is actually draining its debug input.
   *
   * The boot banner says setup() finished; it does not say loop() is reading.
   * The firmware drops debug-console input while it is busy - it has no queue
   * for it - and it is busy for a surprisingly long time in two places: right
   * after boot, and right after an unlock, both of which run LED fades.
   * Measured: a PIN entered immediately after boot produced not one
   * acknowledgement in fifteen seconds, and a restart requested immediately
   * after an unlock produced no output at all for twenty-four.
   *
   * So probe rather than assume. An unrecognised command path is deliberately
   * silent beyond the per-line echo every line gets, which makes it exactly the
   * readiness probe the firmware's own comment says it is. Counting echoes
   * rather than matching one keeps a stale echo from a previous probe - the
   * accumulator is never cleared behind a test's back - from answering for a
   * device that has since stopped listening.
   */
  async waitResponsive(opts = {}) {
    const { timeoutMs = 15000, probeEveryMs = 500 } = opts;
    const re = /I received from DEBUG: 112(?!\d)/g;      // 'p', not a command path
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const before = this.log.count(re);
      const echoed = this.log.waitForCount(re, before + 1, this._opts({
        ...opts,
        timeoutMs: Math.min(probeEveryMs, Math.max(50, deadline - Date.now())),
      }));
      this.sendDebugLine('p');

      try {
        return await echoed;
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        if (Date.now() >= deadline) {
          throw new TimeoutError(
            `the device to start reading its debug console (generation ${this.generation})`,
            timeoutMs
          );
        }
      }
    }
  }

  /**
   * Reboot, and come back.
   *
   * The restart itself has no observable acknowledgement: okcore.cpp prints
   * "'8' restart requested" and calls CPU_RESTART() on the next line, which does
   * not return - so the device resets before the SEREMU buffer is flushed and
   * neither that print nor the byte echo before it ever reaches the host. The
   * real acknowledgement is the next generation booting.
   *
   * From a test's point of view this is also exactly what USB re-enumeration
   * looks like, which is why the same call covers both transports.
   */
  restart(opts = {}) {
    return this._commandThatReboots('8', 'restart', opts);
  }

  /**
   * Wipe, using the firmware's own path.
   *
   * NOT the addon's factoryReset(): that erases the backing store behind the
   * firmware's back, so none of the firmware's bookkeeping happens and nothing
   * is printed; it sets an internal restart flag that no code anywhere reads,
   * so it never fires the restart sink and never reboots; and it erases only
   * from the first MAPPED byte upward, which means on any host with a non-zero
   * vm.mmap_min_addr the low region of flash.bin survives the "factory reset"
   * entirely. '0C' and '9C' do the real thing and end in CPU_RESTART().
   *
   * @param {object} [opts] {full} - full also erases the firmware hash
   */
  wipe(opts = {}) {
    /* The trailing 'C' is the confirmation, and the firmware only acts on a
     * complete path within one line - so no single stray byte can erase the
     * device, and there is no arm/confirm handshake to sequence. Which also
     * means a resent line is harmless: wiping an already-wiped device is the
     * same device. */
    if (opts.full && this.capabilities && !this.capabilities.has('full-wipe')) {
      throw new Error(`refusing a full wipe: ${this.capabilities.why('full-wipe')}`);
    }
    return this._commandThatReboots(opts.full ? '9C' : '0C', 'wipe', opts);
  }

  /**
   * Send a debug-console command whose only acknowledgement is the reboot it
   * causes, and keep sending it until the device actually reboots.
   *
   * The retry is not belt-and-braces. The debug console drops input while the
   * firmware is busy - measured: a restart requested within a second of an
   * unlock produced no echo, no reboot and no output of any kind for the next
   * 24 seconds, because the device was still running its unlock animations and
   * never drained the report. The old kit hit the same thing from the other
   * side and gave up with "device never left the USB bus after 3 restart
   * presses"; three attempts is that same number, and the wording below is
   * deliberately close so the two kits' failures read alike.
   */
  async _commandThatReboots(line, what, opts = {}) {
    const { attempts = 3, perAttemptMs = 10000 } = opts;
    const target = this.generation + 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      /* Armed BEFORE the send, so a fast reboot cannot land between the two. */
      const rebooted = this._waitForGeneration(target, {
        ...opts,
        timeoutMs: perAttemptMs,
      });
      this.sendDebugLine(line);

      try {
        await rebooted;
        /* Booted is not the same as listening - see waitResponsive(). Returning
         * on the banner alone hands the next test a device that will silently
         * drop its first few commands. */
        await this.waitResponsive(opts);
        return this.generation;
      } catch (err) {
        if (err instanceof TimeoutError && attempt < attempts) continue;
        if (err instanceof TimeoutError) {
          throw new TimeoutError(
            `the device to ${what} - it never rebooted after ${attempts} '${line}' requests ` +
            `(generation still ${this.generation})`,
            perAttemptMs * attempts
          );
        }
        throw err;
      }
    }
    return this.generation;
  }

  _waitForGeneration(target, opts = {}) {
    if (this.generation >= target && this.transport.ready) {
      return Promise.resolve(this.generation);
    }
    return tracked(
      `device generation ${target} to boot`,
      this._opts({ timeoutMs: 30000, ...opts }),
      (resolve) => {
        const onBoot = ({ generation }) => { if (generation >= target) resolve(generation); };
        this.transport.on('boot', onBoot);
        return () => this.transport.removeListener('boot', onBoot);
      }
    );
  }

  /* ---- protocol conveniences -------------------------------------------- */

  /** OKCONNECT with the host's clock. Time is RAM-only and rebased every boot,
   *  so anything counter or TOTP derived needs this again after every reboot. */
  setTime(when = Date.now()) {
    return this.sendVendor({ msg: okmsg.MSG.OKCONNECT, payload: okmsg.setTimePayload(when) });
  }

  /**
   * What state is the device in?
   *
   * Three sources, because the firmware has three behaviours:
   *   unlocked      answers OKCONNECT, and printed HW_MODEL(UNLOCKED) on unlock
   *   locked        answers nothing, but taskInitialized broadcasts
   *                 "INITIALIZED" over the vendor interface once a second
   *   uninitialized broadcasts nothing at all - there is no HID task for it -
   *                 so the debug console's "UNLOCKED, NO PIN SET" is the only
   *                 evidence, and it is printed once, at boot
   *
   * @returns {Promise<{state:string, raw:string|null}>}
   */
  async status(opts = {}) {
    const since = this.mark(IFACE.VENDOR);
    try { this.setTime(); } catch { /* fall through to the console evidence */ }

    let raw = null;
    try {
      /* Comfortably longer than the 1000ms broadcast interval, so one call
       * spans at least one full broadcast regardless of phase. */
      const report = await this.waitHid(IFACE.VENDOR, {
        since,
        match: /UNLOCKED|INITIALIZED/,
        timeoutMs: 2500,
        ...opts,
      });
      raw = okmsg.text(report);
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
    }

    if (raw && /^UNLOCKED/.test(raw)) return { state: 'unlocked', raw };
    if (raw && /^INITIALIZED/.test(raw)) return { state: 'locked', raw };

    /*
     * Silence on the vendor interface is not the same as a dead device, and
     * telling those apart cannot rely on having seen the boot.
     *
     * An uninitialized device broadcasts nothing at all - there is no HID task
     * for it - so the only positive evidence is the debug console answering.
     * On the emulator the boot banner is also there, because the runner has
     * been attached since generation zero; on hardware the key booted long
     * before this process started and that banner is gone forever. Probing is
     * the rule that works on both.
     */
    if (/UNLOCKED, NO PIN SET/.test(this.transport.genLog || '')) {
      return { state: 'uninitialized', raw: 'UNLOCKED, NO PIN SET' };
    }

    try {
      await this.waitResponsive({ timeoutMs: 5000, ...opts });
      return { state: 'uninitialized', raw: 'silent on the vendor interface, answering on the debug console' };
    } catch {
      return { state: 'unknown', raw };
    }
  }

  /**
   * Enter the primary PIN and wait for the device to say it is unlocked.
   *
   * The wait is on the vendor interface's HW_MODEL(UNLOCKED) print rather than
   * on the debug console, because "UNLOCKED, NO PIN SET" - what an
   * uninitialized device prints at boot - also matches /UNLOCKED/ and would
   * make an unprovisioned device look unlocked.
   *
   * It is deliberately generous: profile1hashevaluate() runs a Curve25519 +
   * SHA256 computation on every digit once the guess reaches 7, and the digits
   * arrive in one burst.
   */
  async unlock(pin, opts = {}) {
    const since = this.mark(IFACE.VENDOR);
    this.pressLine(String(pin).split(''));
    const report = await this.waitHid(IFACE.VENDOR, {
      since,
      match: /^UNLOCKED/,
      timeoutMs: 30000,
      ...opts,
    });

    /* The unlock announcement is sent BEFORE the firmware finishes unlocking -
     * fadeon(), fadeoff(85) and the profile setup all follow it - and during
     * that window the device drops everything sent to it. Callers that unlock
     * and immediately do something are the normal case, so pay the wait here
     * once rather than in every test that unlocks. */
    await this.waitResponsive(opts);
    return okmsg.text(report);
  }

  /** A sleep the test's deadline can cut short. Prefer waiting on the device. */
  sleep(ms, opts = {}) {
    return sleep(ms, this._opts(opts));
  }

  /* ---- for failure blocks ----------------------------------------------- */

  snapshot() {
    return {
      generation: this.generation,
      restarts: this.restarts,
      mapRetries: this.transport.mapRetries,
      pending: this.pending.list(),
      lastOutputAt: this.log.lastAppendAt || null,
      recentOutput: this.log.tail(1500),
      keystrokes: this.keys.text.slice(-200),
      fatal: this.fatal,
    };
  }
}

/* ---- helpers ------------------------------------------------------------ */

function normalisePresses(presses) {
  const list = Array.isArray(presses) ? presses : [presses];
  return list.map((p) => {
    if (typeof p === 'number') return { button: p };
    if (typeof p === 'string') return { button: parseInt(p, 10) };
    return p;
  });
}

function matcherFor(match) {
  if (!match) return () => true;
  if (typeof match === 'function') return match;
  if (match instanceof RegExp) return (buf) => match.test(okmsg.text(buf));
  throw new TypeError('match must be a RegExp or a function');
}

function ifaceName(iface) {
  return Object.keys(IFACE).find((k) => IFACE[k] === iface) || `iface ${iface}`;
}

module.exports = { Device, IFACE, okmsg };
