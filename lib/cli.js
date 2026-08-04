/*
 * cli.js - running the Python venv's binaries, for section 2.
 *
 * Section 2 tests what a REAL client does, which means running the real client:
 * onlykey-cli, onlykey-agent, age-plugin-onlykey, all out of the okpqc venv
 * beside this checkout. Nothing here reimplements the protocol - that is
 * section 1's job, and the point of having both is that they can disagree.
 *
 * Why this can share a device with the kit at all: with the USB gadget up, the
 * kit's device host holds /dev/hidg* (the device side of the link) and these
 * binaries open /dev/hidraw* (the host side). Opposite ends, different file
 * descriptors, no contention - which is what lets section 2 keep the fixture
 * isolation section 1 has. Against a PHYSICAL key that is not true: there the
 * kit's own adapter holds the same hidraw nodes the CLI wants, and they would
 * steal each other's reports.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { CHECKOUTS_ROOT } = require('./paths');
const { tracked } = require('./device/waits');

const VENV_BIN = path.join(CHECKOUTS_ROOT, 'okpqc-venv', 'bin');

/** Absolute path to a venv binary, or an error naming where it looked. */
function binary(name) {
  const file = path.join(VENV_BIN, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `${name} is not in the venv (looked in ${VENV_BIN}). ` +
      'Run the workspace setup, or point CHECKOUTS_ROOT somewhere that has it.'
    );
  }
  return file;
}

/** Is the venv there at all? Cheap enough to ask before skipping a whole file. */
function venvPresent() {
  return fs.existsSync(VENV_BIN);
}

/**
 * Run a venv binary to completion.
 *
 * Never rejects on a non-zero exit: an exit code is a result, and several of
 * these tests are about the CLI failing correctly. It rejects only when the
 * process could not be run, or outlived its budget.
 *
 * @param {string} name  e.g. 'onlykey-cli'
 * @param {string[]} argv
 * @param {object} [opts] {timeoutMs, signal, pending, input, env}
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean}>}
 */
function run(name, argv = [], opts = {}) {
  const { timeoutMs = 30000 } = opts;
  const file = binary(name);

  return tracked(
    `${name} ${argv.join(' ')}`,
    { timeoutMs: 0, signal: opts.signal, pending: opts.pending },
    (resolve, reject) => {
      const child = execFile(file, argv, {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        env: { ...process.env, ...(opts.env || {}) },
      }, (err, stdout, stderr) => {
        /*
         * execFile's `err` conflates three things: the binary would not run,
         * it exited non-zero, and it was killed for taking too long. Only the
         * first is this function's problem.
         */
        if (err && err.code === 'ENOENT') {
          return reject(new Error(`${name} could not be executed: ${err.message}`));
        }
        const timedOut = !!(err && err.killed);
        return resolve({
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut,
        });
      });

      if (opts.input !== undefined && child.stdin) {
        child.stdin.end(opts.input);
      }

      /* Cancellation has to reach the child, or a timed-out test leaves a
       * python process holding the device open for the next one. */
      return () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    }
  );
}

module.exports = { run, binary, venvPresent, VENV_BIN };
