/*
 * Section 4: the OnlyKey app, in its own nw.js.
 *
 * Declared, not written, and never approached before. It reaches the device
 * through the browser's own HID and WebAuthn stacks, so it needs a display, a
 * kernel HID device and a working WebAuthn implementation - none of which exist
 * on a hosted runner.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('OnlyKey app (section 4)', { requires: ['kernel-hid'] }, () => {
  it('drives the OnlyKey app', async ({ skip }) => {
    skip('not written yet - the app has never been driven from a test harness');
  });
});
