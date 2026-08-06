/*
 * Section 4: stop the App, and prove it went.
 *
 * The visible counterpart to 10-session. A stop is a step that can be seen to
 * have run or not run, which a hook could never be - and a stop that did not
 * stop is worth failing on, because the next run's start would then fail with
 * "something is already answering CDP" a long way from the cause.
 *
 * Killed by PROCESS GROUP. nw.js is a tree and killing its leader leaves
 * renderers behind; section 3 learned that when one aborted run left seven
 * Chromium processes alive.
 *
 * SURFACE: process state. Nothing here talks to a device.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { CDP_PORT } = require('../../lib/app');
const { get, waitFor } = require('../../lib/gui');

const session = require('../../lib/app-session-holder');

/*
 * No `client-access` here, though 10-session needs it. Stopping a process
 * requires no bus, and asking for one would make the runner raise a gadget for
 * a file that never touches it. If 10-session skipped for want of the bus, this
 * file still runs and finds nothing to stop, which is the correct outcome.
 */
describe('section 4 stop', {
  device: false,
  requires: ['display', 'nwjs'],
  timeoutMs: 60000,
}, () => {
  it('stops the App', async ({ assert, log }) => {
    /*
     * peek(), not get(): if 10-session skipped - no display, no nw, no App
     * checkout - this file must not fail for a session that was never meant to
     * exist. Nothing to stop is a pass, and says so.
     */
    const s = session.peek();
    if (!s) {
      log('no session was started, so there is nothing to stop');
      assert.ok(true, 'nothing to stop');
      return;
    }

    const stopped = s.stop();
    log(`stopped: ${stopped.join(', ') || 'nothing was running'}`);
    session.clear();
    assert.ok(true, 'stop ran');
  });

  it('released the debugging port, so the next run can start', async ({ assert }) => {
    /*
     * The assertion that makes the file worth having. A stopped process that
     * still holds 9223 is indistinguishable from a running one to the next
     * session's start check, and that failure arrives in a different file.
     *
     * WAITED FOR, NOT SAMPLED ONCE. The first version read the port a single
     * time immediately after the kill and failed - a SIGTERM to a process group
     * is a request, and Chromium takes a moment to unwind and let go of the
     * socket. Sampling something still in progress reads as a failure for the
     * same reason sampling something still arriving reads as an absence, which
     * this section has now hit three times in two files.
     */
    await waitFor(`CDP on ${CDP_PORT} to be released`, async () => {
      const res = await get(CDP_PORT, '/json/version', 1000);
      return !!res.err;
    }, { timeoutMs: 20000 });

    const res = await get(CDP_PORT, '/json/version', 1000);
    assert.ok(res.err,
      `something is still answering CDP on ${CDP_PORT} after the stop`);
  });
});
