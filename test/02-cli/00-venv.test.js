/*
 * Section 2: onlykey-cli, against a device the kit itself is holding up.
 *
 * This is the first test in the kit that does NOT speak the protocol. Section 1
 * reimplements the client protocol in JS and checks the firmware against it;
 * this runs the actual client and checks that IT works. The point of having
 * both is that they can disagree - a section-1 pass with a section-2 failure
 * means the firmware is right and python-onlykey is not, which is a sentence
 * neither section can say alone.
 *
 * Why the two can share one device: with the USB gadget up, the kit's device
 * host holds /dev/hidg* (the device end of the link) and python-onlykey opens
 * /dev/hidraw* (the host end). Opposite ends, no contention - so section 2
 * keeps the fixture isolation section 1 has, instead of being pointed at
 * whatever long-running daemon happens to be about.
 *
 * `requires: kernel-hid` is what gates all of it. On a hosted runner there is
 * no /dev/hidraw at all and this can never run; on a workstation it runs only
 * when the gadget is free and unambiguous - see lib/gadget.js, which refuses
 * when a physical key is attached alongside, because python-onlykey takes the
 * first match and cannot tell them apart.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');

describe('onlykey-cli',
  { state: 'initialized', requires: ['crypto', 'kernel-hid'], timeoutMs: 120000 }, () => {
    it('has the venv it needs', async ({ assert, skip }) => {
      if (!cli.venvPresent()) skip(`no venv at ${cli.VENV_BIN}`);
      assert.ok(cli.binary('onlykey-cli'), 'onlykey-cli is missing from the venv');
      assert.ok(cli.binary('python3'), 'the venv has no python3');
    });

    it('sees exactly one OnlyKey on the bus', async ({ assert, signal }) => {
      /*
       * The precondition every later test rests on. python-onlykey enumerates
       * and takes the first match, so if it can see two devices, nothing below
       * says anything about WHICH one answered.
       */
      const result = await cli.run('python3', ['-c', [
        'import hid, json',
        'ds = [d for d in hid.enumerate(0, 0)',
        '      if d["vendor_id"] == 0x1d50 and d["product_id"] == 0x60fc]',
        'print(json.dumps(sorted({d["path"].decode().split(":")[0] for d in ds})))',
      ].join('\n')], { timeoutMs: 20000, signal });

      assert.equal(result.code, 0, `enumeration failed: ${result.stderr}`);
      const buses = JSON.parse(result.stdout.trim() || '[]');
      assert.equal(buses.length, 1,
        `expected one OnlyKey, hidapi sees ${buses.length}: ${JSON.stringify(buses)}`);
    });

    it('reports a locked device as locked, the same way the kit does',
      async ({ device, assert, signal }) => {
        /*
         * python-onlykey RAISES on a locked device rather than returning a
         * status string - read_bytes() turns the empty read into
         * "OnlyKey is locked, enter PIN to unlock". Worth asserting rather than
         * working around: it is the client's contract, and the kit reached the
         * same conclusion by a completely different route (the once-a-second
         * INITIALIZED broadcast on the vendor interface).
         *
         * Constructed directly rather than through the onlykey-cli executable,
         * whose module-import-time OnlyKey() has a known enumeration race - the
         * old kit lost real time treating it as a device fault.
         */
        const state = await device.status({ signal });
        assert.equal(state.state, 'locked', 'the fixture should boot locked');

        const result = await cli.run('python3', ['-c', [
          'import time',
          'from onlykey.client import OnlyKey',
          'ok = OnlyKey()',
          'ok.set_time(time.time())',
          'try:',
          '    print("READ:" + ok.read_string(timeout_ms=2500))',
          'except RuntimeError as e:',
          '    print("RAISED:" + str(e))',
          'ok.close()',
        ].join('\n')], { timeoutMs: 30000, signal });

        assert.equal(result.code, 0, `python-onlykey crashed outright: ${result.stderr}`);
        assert.match(result.stdout, /RAISED:.*locked/i,
          `expected python-onlykey to report a locked device, got ${JSON.stringify(result.stdout)}`);
      });

    it('agrees with section 1 once the device is unlocked',
      async ({ device, assert, signal }) => {
        /*
         * The cross-check that justifies running a second client at all. The
         * kit unlocks over its own in-process bus; python-onlykey asks the same
         * device over USB and has to get the same answer. Two clients, two
         * transports, one firmware - and a disagreement here would mean the
         * firmware is right and the client is not, which is a sentence neither
         * section can say alone.
         */
        const model = await device.unlock(PINS.primary, { signal });

        const result = await cli.run('python3', ['-c', [
          'import time',
          'from onlykey.client import OnlyKey',
          'ok = OnlyKey()',
          'ok.set_time(time.time())',
          'print(ok.read_string(timeout_ms=2500))',
          'ok.close()',
        ].join('\n')], { timeoutMs: 30000, signal });

        assert.equal(result.code, 0, `python-onlykey failed: ${result.stderr}`);
        assert.match(result.stdout, /UNLOCKED/,
          `expected an unlocked device, got ${JSON.stringify(result.stdout)}`);
        assert.includes(result.stdout.replace(/\s/g, ''), model.replace(/\0/g, '').trim(),
          'the CLI and the kit disagree about what the device just said');
      });
  });
