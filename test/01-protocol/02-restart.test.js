/*
 * Reboots.
 *
 * These tests reboot constantly - it is the single most exercised operation in
 * the kit - so the reboot machinery gets its own file. What is being checked is
 * not really the firmware: it is that the runner can tell an expected restart
 * from every other way the device host can stop, which is the distinction the
 * whole two-process design exists to make.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { describe, it } = require('../../lib/harness');

describe('restart', { state: 'blank' }, () => {
  it('comes back as a new generation', async ({ device, assert, signal }) => {
    const before = device.generation;
    await device.restart({ signal });
    assert.equal(device.generation, before + 1, 'the boot generation should advance');
    assert.equal(device.restarts, before + 1, 'the restart should have been counted');
  });

  it('is classified as expected, not as a kill', async ({ device, assert }) => {
    /*
     * The marker is what makes this answerable. An expected restart and an OOM
     * kill are byte-identical to the parent - both arrive as code:null,
     * signal:'SIGKILL' - so the child writes a generation-stamped marker
     * synchronously before killing itself, and the parent classifies on that.
     * Without it, the run would either abort on every reboot or respawn through
     * a machine that is out of memory.
     */
    const marker = path.join(device.transport.markerDir, `restart-${device.generation - 1}`);
    assert.ok(fs.existsSync(marker), 'the restarting generation wrote no marker');

    const written = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(written.generation, device.generation - 1, 'the marker names the wrong generation');
    assert.ok(!device.fatal, `the restart was misclassified: ${device.fatal && device.fatal.reason}`);
  });

  it('answers again afterwards', async ({ device, assert, signal }) => {
    device.log.clear();
    device.press(1);
    await device.log.waitFor(/I received from DEBUG: 49(?!\d)/, { signal });

    const { state } = await device.status({ signal });
    assert.equal(state, 'uninitialized', 'a reboot is not a wipe');
  });

  it('keeps its storage across the reboot', async ({ device, assert, signal }) => {
    /*
     * A reboot must not lose flash. The emulated flash is MAP_SHARED and
     * file-backed precisely so the kernel persists it however the process dies
     * - which is what makes the abrupt SIGKILL exit an honest model of a device
     * reset rather than a shortcut.
     */
    const flash = path.join(device.storageDir, 'flash.bin');
    const before = fs.statSync(flash).size;
    await device.restart({ signal });
    assert.equal(fs.statSync(flash).size, before, 'flash.bin changed size across a reboot');
    assert.equal(device.generation, 2, 'two restarts in this file, two generations');
  });
});
