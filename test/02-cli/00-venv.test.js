/*
 * Section 2: the CLI, through the Python venv.
 *
 * Declared, not written. The structure is fixed now so that later work has
 * somewhere to go and so that a run says what it is NOT covering, but the
 * emulator comes first and this section follows once the runner has proven
 * itself.
 *
 * This section is not merely deferred on a hosted runner - it is permanently
 * impossible there. python-onlykey finds the device through hidapi, like every
 * other real client, and a GitHub runner has no /dev/hidraw for hidapi to open.
 * The `kernel-hid` capability is how that gets said out loud, once, with a
 * reason, instead of the section quietly appearing to pass.
 *
 * Everything here belongs to a self-hosted runner or a workstation with the
 * gadget bridge up (see the emulator's scripts/gadget-setup.sh).
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('CLI (section 2)', { requires: ['kernel-hid'] }, () => {
  it('runs onlykey-cli against the device', async ({ skip }) => {
    skip('not written yet - section 2 follows once the runner has proven itself');
  });
});
