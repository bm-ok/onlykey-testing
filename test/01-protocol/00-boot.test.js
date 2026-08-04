/*
 * Does the device come up at all, and does it say so?
 *
 * Everything else in this section assumes a booted device that answers. This
 * file is what makes that assumption falsifiable, and it is the first file for
 * that reason: if it fails, nothing after it means anything.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { describe, it } = require('../../lib/harness');
const { IMAGE_SIZES } = require('../../lib/config');

describe('boot', { state: 'blank' }, () => {
  it('reaches its boot banner', async ({ device, assert }) => {
    await device.waitReady();
    assert.equal(device.generation, 0, 'a fresh run starts at generation 0');
    assert.ok(device.log.text.length > 0, 'the device produced no debug output at all');
  });

  it('backs its storage with two files of exactly the right size',
    async ({ device, assert, skip }) => {
      if (!device.capabilities.has('storage-files')) {
        skip(device.capabilities.why('storage-files'));
      }
    /*
     * Size is not a detail here. The firmware's loader validates size and
     * NOTHING else, and on any mismatch it truncates the file to zero and
     * rewrites the whole thing with 0xFF - so a wrong-sized image does not fail
     * loudly, it silently becomes a factory-blank device.
     */
      for (const [name, expected] of Object.entries(IMAGE_SIZES)) {
        const file = path.join(device.storageDir, name);
        assert.ok(fs.existsSync(file), `${name} was never created`);
        assert.equal(fs.statSync(file).size, expected, `${name} is the wrong size`);
      }
    });

  it('reports a state over the wire', async ({ device, assert }) => {
    const { state, raw } = await device.status();
    assert.equal(state, 'uninitialized', `a blank device should be uninitialized, got ${raw}`);
  });

  it('runs at a mmap rung that matches the capabilities it was given',
    async ({ device, assert, skip }) => {
      const caps = device.capabilities;
      assert.ok(caps, 'the runner injected no capability set');
      /* The rung is a property of the emulator's flash MAPPING. A physical key
       * has no mapping to constrain - its flash is on the key. */
      if (caps.adapter !== 'emulated') skip('the mmap rung only constrains the emulator');

      /*
       * The rung is read back and treated as a capability rather than assumed,
       * because at the unprivileged default (0x10000) the device still boots
       * and still answers HID - it only segfaults once something encrypts. A
       * run that lands there has to say so rather than reporting a pile of
       * crashes.
       */
      if (caps.rung.name === 'hid-only') {
        assert.ok(!caps.has('crypto'),
          'the rung says crypto is unreachable but the capability set says otherwise');
      } else {
        assert.ok(caps.has('crypto'), `rung ${caps.rung.name} should have crypto`);
      }
    });
});
