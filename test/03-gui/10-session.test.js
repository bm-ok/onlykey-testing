/*
 * Section 3, browser tier: start the services, and prove the window works.
 *
 * This is the file that raises section 3's two long-lived processes - the web
 * app's express server, and nw.js - and it is a VISIBLE test rather than a hook
 * on purpose. A wedge has to stay attributable to a step somebody can point at,
 * and a start that did not happen has to be as legible as one that did.
 * 19-stop takes them down again.
 *
 * They are separate processes here, unlike the old kit where nw.js spawned the
 * server as its own child - which is how a crashed browser left an orphan still
 * holding port 3000, and why its harness needed an `ensure.js` to clean up
 * before every run. Started separately and killed by process group, that state
 * does not arise.
 *
 * Nothing here opens an APP page. The app's pages talk to the device as they
 * load, and one opened before the OnlyKey is unlocked has its startup OKCONNECT
 * time out - at which point Chromium raises a native WebAuthn dialog, a real OS
 * window that no CDP command can dismiss, and the session is wedged until it is
 * restarted. So this file proves the browser works using its own landing page,
 * which makes no device call, and leaves app pages to the files that bring a
 * device up first.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const gui = require('../../lib/gui');

/*
 * Held across the files in this section. The runner loads one file at a time
 * and clears the registry between them, but the module cache persists - which
 * is what lets 19-stop take down what this file started.
 */
const session = require('../../lib/gui-session-holder');

describe('section 3 services', {
  device: false,
  requires: ['display', 'nwjs', 'webapp-lib'],
  timeoutMs: 180000,
}, () => {
  it('has a browser and an app to serve', async ({ assert }) => {
    const found = gui.probe();
    assert.ok(found.ok, found.why || 'no browser');
    assert.ok(gui.findNw(), 'no nw.js binary resolved');
  });

  it('starts the web app server', async ({ assert, log }) => {
    const s = session.create();
    const proc = await s.startServer();
    log(`web app pid ${proc.pid}, log ${proc.logFile}`);

    const res = await gui.get(gui.APP_PORT, '/');
    assert.equal(res.code, 200, 'the web app did not answer on 3000');
    assert.includes(res.body, '<html', 'the web app served something that is not a page');
  });

  it('starts nw.js and answers CDP', async ({ assert, log }) => {
    const s = session.get();
    const proc = await s.startBrowser();
    log(`nw.js pid ${proc.pid}, log ${proc.logFile}`);

    const version = await s.version();
    assert.ok(version, 'nw.js did not answer /json/version');
    assert.ok(version.Browser, 'no browser version reported');
    log(`browser ${version.Browser}`);
  });

  it('opens a window and runs code in it', async ({ assert, log }) => {
    /*
     * The landing page, not an app page - see the note at the top. What is
     * being established here is only that the CDP path works end to end:
     * evaluate, get a value back, and see what the page logged.
     */
    const s = session.get();
    const page = await s.open('http://127.0.0.1:3000/', { timeoutMs: 60000 });

    const title = await page.eval('document.title');
    const href = await page.eval('location.href');
    log(`opened ${href}`);

    assert.ok(typeof href === 'string' && href.includes('3000'),
      `the window is not on the web app: ${href}`);
    assert.ok(typeof title === 'string', 'no document.title came back');

    /* A real round trip through the page's own JavaScript, not just a property
     * read - a page that can be inspected but not driven is no use here. */
    const sum = await page.eval('(() => 6 * 7)()');
    assert.equal(sum, 42, 'the page did not evaluate an expression');

    /* And an async one, since almost everything the app does is a promise. */
    const async = await page.eval('Promise.resolve("ready")');
    assert.equal(async, 'ready', 'awaitPromise did not resolve in the page');

    page.close();
  });

  it('reports what the page logged', async ({ assert }) => {
    /*
     * Console capture is not a nicety. When a page-driving test fails, what the
     * page said is usually the only account of why, and it is gone the moment
     * the window closes.
     */
    const s = session.get();
    const page = await s.open('http://127.0.0.1:3000/', { timeoutMs: 60000 });

    await page.eval('console.log("okt", "console", "capture")');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(page.console.some((line) => line.includes('okt console capture')),
      `the page's console was not captured: ${JSON.stringify(page.console.slice(-5))}`);

    page.close();
  });
});
