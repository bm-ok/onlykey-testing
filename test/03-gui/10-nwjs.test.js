/*
 * Section 3: the web app - in two tiers, and the split is the useful part.
 *
 * The web app is two things stacked. Underneath is
 * onlykey.github.io/src/onlykey-fido2, a standalone device library (also
 * published as github.com/bmatusiak/node-onlykey-fido2) that speaks CTAP2 and
 * the vendor tunnel. On top is the page that calls it. Only the top half needs
 * a browser.
 *
 *   00-09  the library, headless. No display, no USB, no kernel HID device -
 *          just the browser surface it touches (crypto.subtle, atob/btoa,
 *          location.hostname, navigator.credentials.get) shimmed onto this
 *          kit's own CTAP2 layer. Runs anywhere section 1 runs, CI included.
 *   10+    the page itself, in nw.js. Needs `display`, and a device the page
 *          can actually reach.
 *
 * Why the library is worth testing rather than assumed correct: it is a THIRD
 * client, alongside this kit's own JS and python-onlykey, and it is the one
 * every browser user actually runs. Section 2 exists on the argument that two
 * implementations can disagree and that a disagreement names which one is
 * wrong - nothing about that was ever specific to python. As things stand, a
 * firmware change that breaks the web app's client is invisible to every test
 * in this tree.
 *
 * It also has no tests of its own any more: `onlykey-fido2/test-api` was the
 * original protocol kit and is deprecated. See PLAN.md, "Three kits, not two".
 *
 * Ordering is deliberate. If the library cannot talk to the device headlessly,
 * launching a browser to watch it fail again explains nothing.
 *
 * When the nw.js half is written, its long-lived services get started and
 * stopped by explicit test files at the section boundaries, never by hooks. A
 * wedge has to stay attributable to a visible step, and a stop has to be a step
 * that can be seen to have run or not run. Cleanup tracks process GROUPS rather
 * than bare PIDs, because nw.js can crash and leave the web app server it
 * spawned alive as an orphan holding a port.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('web app GUI (section 3)', { requires: ['display', 'kernel-hid'] }, () => {
  it('drives the web app in nw.js', async ({ skip }) => {
    skip('not written yet - needs a display and a device the page can reach');
  });
});
