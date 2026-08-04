/*
 * waits.js - one place where "waiting for the device" is defined.
 *
 * Every wait in this kit is bounded three ways and says what it was waiting
 * for: a timeout, the test's AbortSignal, and a description registered while it
 * is outstanding. The description is not decoration - a watchdog that cannot
 * name the pending request cannot tell a stalled transport from a genuinely
 * slow device, which is the exact failure mode this kit exists to eliminate.
 */
'use strict';

class TimeoutError extends Error {
  constructor(desc, ms) {
    super(`timed out after ${ms}ms waiting for ${desc}`);
    this.name = 'TimeoutError';
    this.desc = desc;
    this.timeoutMs = ms;
  }
}

class CancelledError extends Error {
  constructor(desc, cause) {
    super(`cancelled while waiting for ${desc}${cause ? `: ${cause}` : ''}`);
    this.name = 'CancelledError';
    this.desc = desc;
  }
}

/**
 * The set of waits currently outstanding, for the watchdogs and failure blocks
 * to read. Shared by the whole device handle, so "what was pending" is one
 * question with one answer.
 */
class PendingSet {
  constructor() { this.entries = new Set(); }

  add(desc) {
    const entry = { desc, since: Date.now() };
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }

  /** @returns {string[]} human-readable, newest last */
  list() {
    return [...this.entries]
      .sort((a, b) => a.since - b.since)
      .map((e) => `${e.desc} (pending ${Date.now() - e.since}ms)`);
  }

  get size() { return this.entries.size; }
}

/**
 * Build a promise that is cancellable for real.
 *
 * @param {string} desc          what is being waited for, in a reader's words
 * @param {object} opts          {timeoutMs, signal, pending}
 * @param {function} subscribe   (resolve, reject) => unsubscribe
 *
 * `subscribe` may resolve synchronously; the unsubscribe it returns is called
 * even in that case, so a subscriber list never keeps a settled waiter.
 */
function tracked(desc, opts, subscribe) {
  const { timeoutMs = 5000, signal, pending } = opts || {};

  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let untrack = null;
    let unsubscribe = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (untrack) untrack();
      if (unsubscribe) unsubscribe();
    };

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      cleanup();
      fn(value);
    };

    function onAbort() {
      const reason = signal.reason && signal.reason.message
        ? signal.reason.message
        : String(signal.reason || '');
      finish(reject, new CancelledError(desc, reason));
    }

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(reject, new TimeoutError(desc, timeoutMs)), timeoutMs);
    }

    if (pending) untrack = pending.add(desc);

    const un = subscribe(
      (v) => finish(resolve, v),
      (e) => finish(reject, e)
    );

    /* Resolved inside subscribe(): cleanup already ran, so unhook now. */
    if (done) { if (typeof un === 'function') un(); }
    else unsubscribe = typeof un === 'function' ? un : null;
  });
}

/** A sleep that a cancelled test does not have to sit through. */
function sleep(ms, { signal, pending } = {}) {
  return tracked(`sleep ${ms}ms`, { timeoutMs: 0, signal, pending }, (resolve) => {
    const t = setTimeout(resolve, ms);
    return () => clearTimeout(t);
  });
}

/**
 * One signal that fires when any of these do.
 *
 * Every device wait is cancellable from two directions: the test's own deadline
 * and the device dying underneath it. Without the second one, a firmware crash
 * mid-wait surfaces as an ordinary timeout seconds later, with the crash
 * nowhere near the failure it caused.
 */
function anySignal(signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(live);

  const controller = new AbortController();
  for (const s of live) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

module.exports = { tracked, sleep, anySignal, PendingSet, TimeoutError, CancelledError };
