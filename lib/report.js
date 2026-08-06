/*
 * report.js - everything an automated agent needs to know, emitted
 * unambiguously.
 *
 * Three things, and each one answers a question the old kit could not:
 *
 *   The log file. Every run writes its own, so nothing has to be piped or
 *   tailed - and a background command whose output is piped through tail is
 *   exactly how a run's last words get lost.
 *
 *   The status file. Rewritten live with the current section, file, test,
 *   elapsed time and failures so far, so progress is readable by polling ONE
 *   file. Written to a temp name and renamed, because a poller must never read
 *   a half-written file and conclude the run has gone strange.
 *
 *   The sentinel. Exactly one line ends every run, emitted from the exit
 *   handler, the uncaught exception handler and the unhandled rejection handler
 *   alike, saying whether it finished or aborted, why, and with what code. The
 *   ABSENCE of a sentinel means a hard crash - and that single fact, answerable
 *   by one grep, is the thing the old kit could never provide.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/*
 * The exit code says what kind of problem it is without reading anything else.
 * 0-3 are verdicts about the device; 4 and 5 say the run did not produce a
 * verdict at all, and that distinction is the whole point.
 */
const EXIT = {
  PASS: 0,            // finished, everything passed
  TEST_FAILURE: 1,    // finished, something failed - the device behaved, the software did not
  FIRMWARE_CRASH: 2,  // the firmware segfaulted, or tripped _FORTIFY_SOURCE
  WATCHDOG: 3,        // per-test deadline, inactivity budget or run maximum
  RUNNER_ERROR: 4,    // a file that would not load, a fixture that would not build, bad config
  HOST_DIED: 5,       // the device host died for a reason that is not the firmware's fault
};

const SENTINEL_PREFIX = '--- OKT-END';

class Reporter {
  /**
   * @param {object} opts {runDir, runId, quiet}
   */
  constructor(opts) {
    this.runDir = opts.runDir;
    this.runId = opts.runId;
    this.quiet = !!opts.quiet;

    fs.mkdirSync(this.runDir, { recursive: true });
    this.logPath = path.join(this.runDir, 'run.log');
    this.statusPath = path.join(this.runDir, 'status.json');
    this._fd = fs.openSync(this.logPath, 'a');

    this.startedAt = Date.now();
    this.finished = false;

    this.state = {
      runId: this.runId,
      runDir: this.runDir,
      startedAt: new Date(this.startedAt).toISOString(),
      section: null,
      file: null,
      suite: null,
      test: null,
      status: 'starting',
      elapsedMs: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      generation: null,
      pending: [],
    };
    this.writeStatus();
    this._installExitHandlers();
  }

  /* ---- log -------------------------------------------------------------- */

  write(line) {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    try { fs.writeSync(this._fd, stamped); } catch { /* the run matters more */ }
    if (!this.quiet) process.stdout.write(stamped);
  }

  log(...parts) {
    this.write(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
  }

  /* ---- status ----------------------------------------------------------- */

  update(patch) {
    Object.assign(this.state, patch);
    this.state.elapsedMs = Date.now() - this.startedAt;
    this.writeStatus();
  }

  writeStatus() {
    const tmp = `${this.statusPath}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
      fs.renameSync(tmp, this.statusPath);
    } catch { /* never let reporting fail a run */ }
  }

  /* ---- failure blocks ---------------------------------------------------- */

  /**
   * A failure block is self-contained: it carries the wait that was pending,
   * the recent device output and the boot generation, so there is nothing to go
   * hunting for afterwards.
   */
  failure({ file, suite, test, error, reason, device }) {
    const lines = [
      '',
      '================ FAILURE ================',
      `file      : ${file}`,
      `suite     : ${suite}`,
      `test      : ${test}`,
    ];
    if (reason) lines.push(`reason    : ${reason}`);
    if (error) lines.push(`error     : ${indent(error)}`);

    if (device) {
      const snap = device.snapshot();
      lines.push(`generation: ${snap.generation} (${snap.restarts} restarts, ${snap.mapRetries} map retries)`);
      lines.push(`pending   : ${snap.pending.length ? snap.pending.join('; ') : 'nothing'}`);
      lines.push(`last out  : ${snap.lastOutputAt
        ? `${Date.now() - snap.lastOutputAt}ms ago`
        : 'no device output at all'}`);
      if (snap.keystrokes) lines.push(`keystrokes: ${JSON.stringify(snap.keystrokes)}`);
      if (snap.fatal) lines.push(`device    : ${snap.fatal.kind} - ${snap.fatal.reason}`);
      lines.push('--- recent device output ---');
      lines.push(snap.recentOutput || '(none)');
      if (snap.fatal && snap.fatal.detail) {
        lines.push('--- device host stderr ---');
        lines.push(snap.fatal.detail);
      }
    }
    lines.push('=========================================', '');

    for (const line of lines) this.write(line);
  }

  /* ---- the sentinel ------------------------------------------------------ */

  /**
   * @param {object} end {status:'finished'|'aborted', reason, code, counts}
   * @returns {number} the exit code, so callers can `process.exit(reporter.finish(...))`
   */
  finish({ status, reason, code, counts = {} }) {
    if (this.finished) return code;
    this.finished = true;

    const tally = `${counts.passed || 0}p/${counts.failed || 0}f/${counts.skipped || 0}s`;
    this.update({
      status,
      reason,
      code,
      finishedAt: new Date().toISOString(),
      passed: counts.passed || 0,
      failed: counts.failed || 0,
      skipped: counts.skipped || 0,
    });

    /* One line, always the same shape, always the last thing in the file. */
    this.write(
      `${SENTINEL_PREFIX} status=${status} code=${code} tests=${tally} ` +
      `elapsed=${Math.round((Date.now() - this.startedAt) / 1000)}s reason=${JSON.stringify(reason || '')} ---`
    );

    try { fs.closeSync(this._fd); } catch { /* ignore */ }
    return code;
  }

  /*
   * The sentinel has to survive the ways a run can end that nobody planned for.
   * An uncaught exception and an unhandled rejection are both "the runner
   * itself broke", which is exit 4 - the run did not produce a verdict.
   */
  _installExitHandlers() {
    const bail = (kind) => (err) => {
      if (this.finished) return;
      const text = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
      this.write(`${kind}: ${text}`);
      this.finish({
        status: 'aborted',
        reason: `${kind}: ${firstLine(text)}`,
        code: EXIT.RUNNER_ERROR,
        counts: this.state,
      });
      process.exit(EXIT.RUNNER_ERROR);
    };

    process.on('uncaughtException', bail('uncaught exception'));
    process.on('unhandledRejection', bail('unhandled rejection'));
    process.on('exit', () => {
      if (this.finished) return;
      /* Something called process.exit() past every other path. Say so rather
       * than leaving a log with no last line. */
      this.finish({
        status: 'aborted',
        reason: 'the runner exited without reporting a result',
        code: process.exitCode || EXIT.RUNNER_ERROR,
        counts: this.state,
      });
    });
  }
}

function indent(text) {
  return String(text).split('\n').join('\n            ');
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

module.exports = { Reporter, EXIT, SENTINEL_PREFIX };
