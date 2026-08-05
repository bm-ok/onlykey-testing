/*
 * SECTION 3 - the web app, in two tiers, and the split is the useful part.
 *
 * The web app is two things stacked. Underneath is
 * onlykey.github.io/src/onlykey-fido2, a standalone device library (also
 * published as github.com/bmatusiak/node-onlykey-fido2) that speaks CTAP2 and
 * the vendor tunnel. On top is the page that calls it. Only the top half needs
 * a browser, so the file number is where the section splits:
 *
 *   00-09  the library, headless. No display, no USB, no kernel HID node -
 *          just the browser surface it touches, shimmed onto this kit's own
 *          CTAP2 layer. Runs anywhere section 1 runs, CI included.
 *   10+    the page itself, in nw.js. Needs `display`, and a device the page
 *          can actually reach. 10-session raises the two long-lived processes
 *          and 19-stop takes them down, as visible test files rather than
 *          hooks.
 *
 * The order is the point of the split. If the library cannot talk to the device
 * headlessly, launching a browser to watch it fail again explains nothing - so
 * these files are the browser tier's own pre-flight. `display` is a capability,
 * so on a machine or runner without one the browser half skips with a stated
 * reason while this half still runs.
 *
 * ---
 *
 * This file: the web app's OWN device library, against the emulated device.
 * No browser, no display, no USB, no kernel HID node.
 *
 * onlykey.github.io/src/onlykey-fido2 is what every browser user actually runs,
 * and it is the one client of the three that nothing tests - its own test-api
 * was deprecated and is not coming back. So a firmware change that breaks the
 * web app is invisible to this tree, and this file is the smallest thing that
 * fixes that.
 *
 * lib/webenv.js explains how it runs outside a browser. The short version: the
 * library takes its dependencies as an argument rather than reading globals, it
 * already has a Node mode, and its entire device surface is one call -
 * navigator.credentials.get() - pointed here at lib/device/ctap2.js instead of
 * at hidapi. That last substitution is what the ancestors could not do, and it
 * is why this runs in CI.
 *
 * Two of the tests below need no device at all. They compare the shipped
 * library's tunnel encoder against lib/device/tunnel.js, which is a port of it -
 * and a port is only a liability if nothing ever checks it against the
 * original. Checked, it is the independent oracle: two readings of one wire
 * format, and a disagreement says which side drifted.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const tunnel = require('../../lib/device/tunnel');
const { Ctap2 } = require('../../lib/device/ctap2');
const webenv = require('../../lib/webenv');

/*
 * The library narrates every step to console. Silent by default - one handshake
 * buries a run log - but it is the only account of what it thinks it is doing,
 * so OKT_WEBLIB_VERBOSE=yes turns it back on when something in there is wrong.
 */
const verbose = () => (process.env.OKT_WEBLIB_VERBOSE === 'yes' ? console : undefined);

describe('the web app\'s device library', {
  state: 'initialized',
  requires: ['crypto', 'webapp-lib'],
  timeoutMs: 45000,
}, () => {
  let api = null;

  it('loads outside a browser, and knows it', async ({ device, assert }) => {
    /*
     * getOS() returns "Node" only for navigator.userAgent === "NODE" exactly,
     * and the library branches on it to read Buffers where a browser hands it
     * ArrayBuffers. Getting this wrong does not fail here - it fails much later
     * with a DataView over the wrong kind of object.
     */
    const imports = webenv.create(device);
    api = webenv.load(imports, 'onlykey-api.js');

    assert.equal(api.os, 'Node', 'the library did not take its Node path');
    assert.ok(typeof api.connect === 'function', 'no connect() on the library');
    assert.ok(typeof api.encode_ctaphid_request_as_keyhandle === 'function',
      'no tunnel encoder on the library');
  });

  it('encodes a tunnel request byte for byte the way this kit does',
    async ({ assert }) => {
      /*
       * No device involved. The shipped encoder and lib/device/tunnel.js's port
       * of it must produce identical credential IDs, including the detail most
       * likely to drift: the length byte declares the REAL payload length while
       * the buffer is padded to sixteen.
       */
      const cases = [
        { cmd: 0xE4, opt1: 0, opt2: 0, opt3: 0, data: Buffer.alloc(0) },
        { cmd: 0xEC, opt1: 1, opt2: 2, opt3: 3, data: Buffer.from([1, 2, 3]) },
        { cmd: 0xED, opt1: 0, opt2: 0, opt3: 0, data: Buffer.alloc(32, 0xAA) },
        { cmd: 0xF3, opt1: 0xFF, opt2: 0xFF, opt3: 0xFF, data: Buffer.alloc(64, 0x5A) },
      ];

      for (const c of cases) {
        const theirs = Buffer.from(
          api.encode_ctaphid_request_as_keyhandle(c.cmd, c.opt1, c.opt2, c.opt3, c.data)
        );
        const ours = tunnel.encodeRequest(c);
        assert.bytes(ours, theirs, `cmd 0x${c.cmd.toString(16)} with ${c.data.length} bytes`);
      }
    });

  it('agrees about where the payload stops', async ({ assert }) => {
    /* The one case a length-vs-padding bug survives: three bytes of payload in
     * a sixteen-byte field. If either side read the padded size, the device
     * would be handed thirteen bytes of zeroes as though they were request. */
    const theirs = Buffer.from(
      api.encode_ctaphid_request_as_keyhandle(0xEC, 0, 0, 0, Buffer.from([1, 2, 3]))
    );
    assert.equal(theirs[9], 3, 'the shipped encoder declares a length of 3');
    assert.equal(theirs.length, 26, '10 header + 16 minimum data');
  });

  it('unlocks the device', async ({ device, assert, signal }) => {
    /*
     * A visible step, because everything below it depends on this and a
     * locked device does not answer the tunnel at all - it simply never
     * sends a report, which arrives as a CTAPHID timeout with no hint that
     * the PIN was the problem.
     */
    const model = await device.unlock(PINS.primary, { signal });
    assert.match(model, /^UNLOCKED/, 'the device did not unlock');
  });

  it('completes an OKCONNECT handshake against the device',
    async ({ device, assert, signal, log }) => {
      /*
       * The real thing: the library's own connect(), which builds the request,
       * fabricates the credential ID, calls navigator.credentials.get(), reads
       * the device's X25519 key out of the assertion signature and computes a
       * shared secret with it. Every layer of the shipped client, over the
       * emulator's in-process bus.
       */
      const imports = webenv.create(device, { signal, console: verbose() });
      const live = webenv.load(imports, 'onlykey-api.js');

      await new Promise((resolve, reject) => {
        live.connect((err) => (err ? reject(new Error(String(err))) : resolve()));
      });

      log(`library reports firmware ${live.FWversion}, ${live.OKversion}`);

      assert.ok(live.sharedsec, 'the library computed no shared secret');
      assert.equal(live.sharedsec.length, 32, 'a shared secret is 32 bytes');
      assert.ok(live.FWversion, 'the library read no firmware version');
    });

  it('reads the same firmware version the kit does', async ({ device, assert, signal }) => {
    /*
     * The cross-check that justifies running a third client at all, and the
     * same shape as 00-venv.test.js asserting the CLI and the kit agree. Two
     * completely different code paths - the shipped browser client through the
     * WebAuthn tunnel, and this kit's own tunnel.js - have to describe one
     * device the same way. A disagreement names which one is wrong, which
     * neither could do alone.
     */
    const ctap = new Ctap2(device);
    await ctap.init({ signal });
    const mine = await tunnel.send(ctap, { cmd: 0xE4 }, { signal });

    const imports = webenv.create(device, { signal });
    const live = webenv.load(imports, 'onlykey-api.js');
    await new Promise((resolve, reject) => {
      live.connect((err) => (err ? reject(new Error(String(err))) : resolve()));
    });

    assert.ok(mine.data, 'the kit got no OKCONNECT payload');
    assert.includes(mine.data.toString('latin1'), live.FWversion,
      'the library and the kit disagree about the firmware version');
  });
});
