/*
 * logbuf.js - the device's debug console as one accumulator string.
 *
 * This copies the old kit's idiom (onlykey-alpha-testing/lib/hid.js) rather
 * than improving on it, because the idiom is load-bearing:
 *
 *   - Everything is appended to ONE string and matched against the whole,
 *     unsplit. The firmware's output is not line-oriented in any reliable way -
 *     a report can carry half a line - and the readiness probe depends on
 *     matching across whatever arrived.
 *   - Matches are counted, not just found. The firmware emits one
 *     acknowledgement per byte sent, so a first-match wait is simply the wrong
 *     instrument for a burst of six button presses.
 *   - A wait matches RETROACTIVELY against everything already accumulated, not
 *     only against what arrives after it. Half the waits in this kit are armed
 *     after the thing they are waiting for has already been printed.
 *   - Clearing is the CALLER's job. A test that wants a clean slate asks for
 *     one; nothing clears behind a test's back.
 *
 * Two behaviours deliberately do not transfer. Filtering out NUL bytes destroys
 * legitimate ones and belongs only on the hardware path, where hidraw pads the
 * report. And the accumulator was unbounded, which is fine for a five-minute
 * mocha run and not fine for a run that reboots the device a hundred times - so
 * it has a cap and keeps the tail.
 */
'use strict';

const { tracked } = require('./waits');

const DEFAULT_CAP = 1 << 20;       // 1 MiB of debug text
const TRIM_TO = 0.75;              // drop a quarter at a time, not a byte at a time

class LogBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBytes] cap; the oldest text is dropped past it
   * @param {PendingSet} [opts.pending]
   */
  constructor(opts = {}) {
    this.maxBytes = opts.maxBytes || DEFAULT_CAP;
    this.pending = opts.pending || null;
    this.text = '';
    this.droppedChars = 0;         // trimmed off the front, cumulatively
    this.lastAppendAt = 0;         // the inactivity watchdog's clock
    this.totalChars = 0;
    this._subscribers = new Set();
  }

  /** Feed device output in. Any shape of chunk; no line assumptions. */
  append(chunk) {
    if (!chunk) return;
    this.text += chunk;
    this.totalChars += chunk.length;
    this.lastAppendAt = Date.now();

    if (this.text.length > this.maxBytes) {
      const keep = Math.floor(this.maxBytes * TRIM_TO);
      this.droppedChars += this.text.length - keep;
      this.text = this.text.slice(-keep);
    }

    for (const fn of [...this._subscribers]) {
      try { fn(); } catch { /* a waiter must not break the feed */ }
    }
  }

  clear() {
    this.text = '';
  }

  /** The last n characters, for a failure block. */
  tail(n = 2000) {
    return this.text.length <= n ? this.text : `…${this.text.slice(-n)}`;
  }

  /** How many times `matcher` occurs in everything accumulated. */
  count(matcher) {
    const re = globalRe(matcher);
    return (this.text.match(re) || []).length;
  }

  /**
   * Resolve once the accumulated output matches. Checks retroactively first.
   * @returns {Promise<RegExpMatchArray>}
   */
  waitFor(matcher, opts = {}) {
    const re = toRe(matcher);
    const existing = this.text.match(re);
    if (existing) return Promise.resolve(existing);

    return tracked(
      `debug output matching /${re.source}/`,
      { timeoutMs: 5000, pending: this.pending, ...opts },
      (resolve) => this._subscribe(() => {
        const m = this.text.match(re);
        if (m) resolve(m);
      })
    );
  }

  /**
   * Resolve once `matcher` has occurred at least `count` times.
   *
   * waitFor() only models a first match, which is not enough when the device
   * emits one acknowledgement per byte and the caller needs to know the whole
   * burst was consumed.
   * @returns {Promise<number>} the count actually seen
   */
  waitForCount(matcher, count, opts = {}) {
    const re = globalRe(matcher);
    const seen = () => (this.text.match(re) || []).length;
    if (seen() >= count) return Promise.resolve(seen());

    return tracked(
      `${count}x /${re.source}/ in debug output`,
      { timeoutMs: 8000, pending: this.pending, ...opts },
      (resolve) => this._subscribe(() => {
        const n = seen();
        if (n >= count) resolve(n);
      })
    );
  }

  /**
   * Resolve on the first of several patterns to match, telling the caller which
   * one it was. This is how a step waits on its success print AND its failure
   * print at once, so a device that reports "Error PINs Don't Match" fails at
   * the step that failed, in the device's own wording, instead of surfacing
   * eight seconds later as an unexplained timeout.
   * @param {Record<string, RegExp|string>} patterns
   * @returns {Promise<{key:string, match:RegExpMatchArray}>}
   */
  waitForAny(patterns, opts = {}) {
    const entries = Object.entries(patterns).map(([k, p]) => [k, toRe(p)]);
    const check = () => {
      for (const [key, re] of entries) {
        const m = this.text.match(re);
        if (m) return { key, match: m };
      }
      return null;
    };

    const now = check();
    if (now) return Promise.resolve(now);

    const desc = entries.map(([k, re]) => `${k} /${re.source}/`).join(' or ');
    return tracked(
      `debug output matching ${desc}`,
      { timeoutMs: 8000, pending: this.pending, ...opts },
      (resolve) => this._subscribe(() => {
        const hit = check();
        if (hit) resolve(hit);
      })
    );
  }

  _subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }
}

function toRe(matcher) {
  return matcher instanceof RegExp ? matcher : new RegExp(escapeRe(String(matcher)));
}

function globalRe(matcher) {
  if (matcher instanceof RegExp) {
    return matcher.flags.includes('g')
      ? new RegExp(matcher.source, matcher.flags)
      : new RegExp(matcher.source, `${matcher.flags}g`);
  }
  return new RegExp(escapeRe(String(matcher)), 'g');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { LogBuffer };
