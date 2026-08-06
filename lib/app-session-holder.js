/*
 * app-session-holder.js - the one AppSession section 4's files share.
 *
 * Same argument as lib/gui-session-holder.js, and deliberately a separate
 * holder rather than a second slot in that one: section 3 and section 4 are
 * different codebases in different nw.js processes on different debugging
 * ports, and a shared holder would make it possible to stop one with the
 * other's stop file.
 *
 * The runner loads one file at a time and clears the harness registry between
 * them, so a module-level variable in a test file does not survive to the next.
 * The module cache does, which is what lets 19-stop take down what 10-session
 * started.
 *
 * Nothing here starts or stops anything - both remain visible steps in visible
 * files, which is the whole reason the sections are arranged this way.
 */
'use strict';

const path = require('path');

const { AppSession } = require('./app');
const { RUNS_ROOT } = require('./paths');

let session = null;

function create(opts = {}) {
  session = new AppSession({
    logDir: opts.logDir || RUNS_ROOT,
    userDataDir: opts.userDataDir || path.join(RUNS_ROOT, 'nw-app-udata'),
    ...opts,
  });
  return session;
}

/** The session, or a failure that says which file should have started it. */
function get() {
  if (!session) {
    throw new Error(
      'no OnlyKey App session is running - 04-app/10-session.test.js starts it, ' +
      'and this file was reached without it (run the section, not the file alone)'
    );
  }
  return session;
}

/** @returns {AppSession|null} - for a stop that must not throw if nothing ran. */
function peek() {
  return session;
}

function clear() {
  session = null;
}

module.exports = { create, get, peek, clear };
