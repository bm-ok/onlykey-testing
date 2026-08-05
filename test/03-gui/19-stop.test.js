/*
 * Section 3, browser tier: stop the services, and prove they stopped.
 *
 * The other half of 10-session, and a visible step for the same reason: a stop
 * has to be something that can be seen to have run or not run. A hook that
 * silently did not fire leaves a browser and a web server alive on a developer's
 * machine, and the next run then fails on a port conflict a long way from the
 * cause.
 *
 * Killed by PROCESS GROUP rather than by pid. Chromium is a tree - a browser
 * process, a zygote, renderers - and killing its leader leaves the rest behind
 * holding the port. That is the same orphan problem EXPLAINER describes for
 * nw.js and the web app server, and process groups are the answer to both.
 *
 * The last test asserts the ports actually came free, because "sent SIGTERM"
 * and "stopped" are not the same claim.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const gui = require('../../lib/gui');
const session = require('../../lib/gui-session-holder');

describe('section 3 services, stopped', {
  device: false,
  requires: ['display', 'nwjs', 'webapp-lib'],
  timeoutMs: 60000,
}, () => {
  it('stops the browser and the web app', async ({ assert, log, skip }) => {
    const s = session.peek();
    if (!s) skip('no session was started - 10-session did not run');

    const stopped = s.stop();
    log(`stopped: ${stopped.join(', ') || '(nothing was running)'}`);
    assert.ok(true, 'stop() did not throw');
  });

  it('leaves both ports free', async ({ assert, skip }) => {
    /*
     * The assertion that makes the file worth having. A process group that
     * ignored SIGTERM, or a renderer that outlived its parent, still answers -
     * and the next run's startServer() refuses rather than reusing it, so this
     * failing here is much cheaper than it failing there.
     */
    if (!session.peek()) skip('no session was started - 10-session did not run');

    await session.peek().settled();

    const cdp = await gui.get(gui.CDP_PORT, '/json/version', 1000);
    const app = await gui.get(gui.APP_PORT, '/', 1000);

    assert.ok(cdp.err, `something is still answering CDP on ${gui.CDP_PORT}`);
    assert.ok(app.err, `something is still serving on ${gui.APP_PORT}`);

    session.clear();
  });
});
