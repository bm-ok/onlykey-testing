'use strict';
/*
 * SOFT-KEY FIRMWARE PLUGINS on the emulator (owner, 2026-10-01: "a way for
 * these plugins to be tested with the node-onlykey-emulator, where
 * node-onlykey-emulator is not forced to use ok-rn").
 *
 * The emulator stages plugins only when built with
 *   OKEMU_PLUGINS=hello OKEMU_PLUGINS_DIR=<a plugins folder> npm run rebuild
 * and records them in emulator/.stage/build.json. This file ARMS ITSELF on
 * that record: against a base emulator every test skips and says why, so the
 * base run keeps measuring the firmware everyone has.
 *
 * hello is the smallest plugin (ok-rn/android/okemu/plugins/hello): one vendor
 * message, OKHELLO (0x7E, 0xFE on the wire), answered with a fixed sentence
 * while the key is unlocked. Raw frames, so the device's own words are the
 * evidence.
 */
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const { emulatorRoot } = require('../../lib/paths');

const OKHELLO = 0x80 | 0x7e;

function stagedPlugins() {
  try {
    const built = JSON.parse(fs.readFileSync(path.join(emulatorRoot().dir, '.stage', 'build.json'), 'utf8'));
    return Array.isArray(built.plugins) ? built.plugins : [];
  } catch (_) {
    return [];
  }
}

describe('soft-key firmware plugins on the emulator', { state: 'initialized' }, () => {
  it('hello: OKHELLO is answered by the plugin while unlocked, and not while locked',
    async ({ device, assert, signal, log, skip }) => {
      const plugins = stagedPlugins();
      log(`emulator build plugins: ${JSON.stringify(plugins)}`);
      if (!plugins.includes('hello')) {
        skip('this emulator was not built with the hello plugin (OKEMU_PLUGINS=hello OKEMU_PLUGINS_DIR=... npm run rebuild)');
      }
      await device.restart({ signal });

      /* locked: like every vendor message, nothing comes back */
      const lockedSince = device.mark(IFACE.VENDOR);
      device.sendVendor({ msg: OKHELLO, slot: 0 });
      await device.sleep(1500, { signal });
      const lockedSaid = device.reportsSince(IFACE.VENDOR, lockedSince)
        .map((r) => okmsg.text(r).trim()).filter((t) => /HELLO/.test(t));
      assert.equal(lockedSaid.length, 0, `a locked key answered OKHELLO: ${lockedSaid[0]}`);

      await device.unlock(PINS.primary, { signal });
      const since = device.mark(IFACE.VENDOR);
      device.sendVendor({ msg: OKHELLO, slot: 0 });
      const reply = await device.waitHid(IFACE.VENDOR, { since, match: /HELLO/, timeoutMs: 6000, signal });
      const said = okmsg.text(reply).trim();
      log(`the emulator said: ${JSON.stringify(said)}`);
      assert.equal(said, 'HELLO from plugin hello');
    });
});
