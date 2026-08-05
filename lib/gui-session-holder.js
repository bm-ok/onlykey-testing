/*
 * gui-session-holder.js - the one GuiSession section 3's browser tier shares.
 *
 * The runner loads one test file at a time and clears the harness registry
 * between them, so a module-level variable in a test file does not survive to
 * the next one. The module cache does, which is what makes this the place to
 * keep a service that 10-session starts and 19-stop stops.
 *
 * Deliberately not a hook, and deliberately not hidden: this holds the handle,
 * but nothing here starts or stops anything. Both of those remain visible steps
 * in visible files, which is the whole reason section 3 is arranged this way.
 */
'use strict';

const path = require('path');

const { GuiSession } = require('./gui');
const { RUNS_ROOT } = require('./paths');

let session = null;

/** Replace whatever was held. Logs go under runs/, beside everything else. */
function create(opts = {}) {
  session = new GuiSession({
    logDir: opts.logDir || RUNS_ROOT,
    userDataDir: opts.userDataDir || path.join(RUNS_ROOT, 'nw-udata'),
    ...opts,
  });
  return session;
}

/** The session, or a failure that says which file should have started it. */
function get() {
  if (!session) {
    throw new Error(
      'no GUI session is running - 03-gui/10-session.test.js starts it, and ' +
      'this file was reached without it (run the section, not the file alone)'
    );
  }
  return session;
}

/** @returns {GuiSession|null} - for a stop that must not throw if nothing ran. */
function peek() {
  return session;
}

function clear() {
  session = null;
}

module.exports = { create, get, peek, clear };
