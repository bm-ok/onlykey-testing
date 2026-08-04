/*
 * Section 3: the web app, through nw.js.
 *
 * Declared, not written - and permanently impossible on a hosted runner for two
 * independent reasons: there is no display, so nothing that needs a browser
 * runs, and there is no kernel HID device, so the page could not reach the key
 * even with one.
 *
 * When this section is written, its long-lived services get started and stopped
 * by explicit test files at the start and end of the section, never by hooks.
 * A wedge has to stay attributable to a visible step, and a stop has to be a
 * step that can be seen to have run or not run. Cleanup tracks process GROUPS
 * rather than bare PIDs, because nw.js can crash and leave the web app server
 * it spawned alive as an orphan holding a port.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('web app GUI (section 3)', { requires: ['kernel-hid'] }, () => {
  it('drives the web app in nw.js', async ({ skip }) => {
    skip('not written yet - needs a display and a kernel HID device');
  });
});
