/*
 * TC-06: --slot picks which of the sixteen user ECC slots holds the key.
 *
 * 101-116 are the user slots; 117-132 are reserved by the firmware for the
 * things it needs keys for itself - web derivation, HMAC, backup, derivation
 * (okcore.h). Writing a PQC key into one of those would quietly break the
 * feature that owns it, so the plugin refuses before it opens the device at
 * all: validate_ecc_slot() runs on the argument, not on a device response.
 *
 * That distinction is why the two rejection cases below want no device and no
 * button presses, and it is worth preserving in the test rather than flattening
 * away. A reserved slot that failed by asking the device and being told no
 * would be a different, worse design - the CLI would have to be trusted to have
 * asked - and this test would still pass. So it checks that the device was
 * never involved: no challenge was primed while they ran.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');

const PRIMED = /Encrypted Buffer/g;

describe('age-plugin-onlykey slot selection',
  { state: 'initialized', requires: ['crypto', 'client-access'], timeoutMs: 240000 }, () => {
    it('refuses a reserved slot without touching the device',
      async ({ device, assert, signal }) => {
        const before = device.log.count(PRIMED);

        const result = await cli.run('age-plugin-onlykey',
          ['--generate', '--slot', '117'], { timeoutMs: 20000, signal });

        assert.notEqual(result.code, 0, 'a reserved slot must not exit 0');
        assert.match(result.stderr, /reserved|101-116/i,
          `expected a reserved-slot error, got: ${result.stderr}`);

        /* The point of the test: it failed on the argument, not on the wire. */
        assert.equal(device.log.count(PRIMED), before,
          'the device primed a challenge for a slot the plugin should have rejected outright');
      });

    it('refuses a slot that is not a slot at all', async ({ assert, signal }) => {
      const result = await cli.run('age-plugin-onlykey',
        ['--generate', '--slot', '200'], { timeoutMs: 20000, signal });

      assert.notEqual(result.code, 0, 'an out-of-range slot must not exit 0');
      assert.match(result.stderr, /101-116/i,
        `expected a slot-range error, got: ${result.stderr}`);
    });

    it('generates into a slot that is not the default', async ({ device, assert, signal, log }) => {
      /*
       * 103, so a pass means the --slot argument reached the firmware rather
       * than everything quietly landing in 101 and looking right.
       */
      const result = await pqc.generate(device, ['--generate', '--slot', '103'], { signal });

      assert.equal(result.code, 0,
        `age-plugin-onlykey exited ${result.code}\nstderr: ${result.stderr}`);

      const { identity, recipient } = pqc.parseGenerated(result);
      log(`slot 103 recipient ${recipient}`);
      assert.ok(identity, `no identity on stdout, got: ${JSON.stringify(result.stdout)}`);
      assert.ok(recipient, `no recipient printed, got: ${JSON.stringify(result.stderr)}`);

      /*
       * And it went into 103 specifically. Reading 104 back has to either fail
       * or return something else - if every slot answered with the key just
       * generated, --slot would be decoration and this file would still pass on
       * its other assertions.
       */
      const other = await cli.run('age-plugin-onlykey',
        ['--recipient', '--slot', '104'], { timeoutMs: 30000, signal });

      if (other.code === 0) {
        assert.notEqual(other.stdout.trim(), recipient,
          'slot 104 returned the key that was generated in slot 103');
      }
    });
  });
