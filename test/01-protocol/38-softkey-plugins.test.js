'use strict';
/*
 * SOFT-KEY FIRMWARE PLUGINS on the emulator - their own tests, SIDE-LOADED.
 *
 * Owner, 2026-10-01: experimental firmware features are plugins, each in its
 * own folder WITH ITS TESTS; the emulator builds them without depending on
 * ok-rn, and neither does this kit. node-onlykey-emulator, built with
 *   OKEMU_PLUGINS=<names> [OKEMU_PLUGINS_DIR=<a plugins folder>]
 * (its own emulator/plugins/ holds the hello demo)
 * records in emulator/.stage/build.json which plugins it staged and the folder
 * they came from. This file reads that and registers each plugin's
 * <pluginsDir>/<name>/tests/kit.test.js - so a plugin's tests run only against
 * an emulator that has the plugin, and leave with the plugin's folder. Against
 * a base emulator the one test here skips and says why.
 *
 * A plugin test gets the kit through `ctx` (IFACE, okmsg, PINS, requireLib), never by a
 * relative path into this repo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const { emulatorRoot } = require('../../lib/paths');

function staged() {
  try {
    const built = JSON.parse(fs.readFileSync(path.join(emulatorRoot().dir, '.stage', 'build.json'), 'utf8'));
    return {
      plugins: Array.isArray(built.plugins) ? built.plugins : [],
      dir: typeof built.pluginsDir === 'string' ? built.pluginsDir : null,
    };
  } catch (_) {
    return { plugins: [], dir: null };
  }
}

/*
 * requireLib: the kit's OWN pinned node-onlykey-lib, by public subpath - a plugin's
 * test checks the firmware against the library the kit runs, never a copy of its own.
 */
const ctx = { IFACE, okmsg, PINS, requireLib: (id) => require(id) };
const { plugins, dir } = staged();
const sideLoaded = plugins
  .map((name) => ({ name, file: dir ? path.join(dir, name, 'tests', 'kit.test.js') : null }))
  .filter((p) => p.file && fs.existsSync(p.file));

describe('soft-key firmware plugins on the emulator (side-loaded tests)', { state: 'initialized' }, () => {
  for (const p of sideLoaded) require(p.file)({ it }, ctx);
  if (!sideLoaded.length) {
    it('side-loaded plugin tests', async ({ skip }) => {
      skip(plugins.length
        ? `the emulator stages ${plugins.join(', ')}, but no tests/kit.test.js was found under ${dir || '(no pluginsDir recorded)'}`
        : 'this emulator was built without plugins (e.g. OKEMU_PLUGINS=hello npm run rebuild in the emulator)');
    });
  }
});
