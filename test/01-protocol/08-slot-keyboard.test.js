/*
 * Store a password in a slot, press the button, read back what the device
 * typed.
 *
 * This is the test the emulator makes possible and a kernel device never could.
 * On real hardware the keyboard interface is a device node that has to be read
 * with elevated privileges, and reading it means reading every keystroke on the
 * machine; here it is an event on an in-process bus. That is what finally makes
 * anything the device TYPES - passwords, backups, TOTP codes - testable at all.
 *
 * It is also the widest end-to-end path in this section: the vendor protocol
 * writes the slot, the firmware encrypts it with AES-GCM into EEPROM, the
 * button press decrypts it again, and the keyboard interface types it out. A
 * pass here means the crypto rung is genuinely reachable, not just that the
 * device booted.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const { IFACE, okmsg } = require('../../lib/device');

/* okcore.cpp's set_slot() field ids, matching python-onlykey's MessageField. */
const FIELD = { LABEL: 1, USERNAME: 2, PASSWORD: 5 };

const SLOT = 1;                 // slot 1a - the first profile's first button
const LABEL = 'kittest';
const PASSWORD = 'hello123';

describe('slots and keyboard capture',
  { state: 'initialized', requires: ['crypto', 'keyboard-capture'] }, () => {
    it('unlocks first - slots are not writable while locked',
      async ({ device, assert, signal }) => {
        const model = await device.unlock(PINS.primary, { signal });
        assert.match(model, /^UNLOCKED/);
      });

    it('stores a label and a password in slot 1', async ({ device, assert, signal }) => {
      for (const [field, value] of [[FIELD.LABEL, LABEL], [FIELD.PASSWORD, PASSWORD]]) {
        const since = device.mark(IFACE.VENDOR);
        device.sendVendor({ msg: okmsg.MSG.OKSETSLOT, slot: SLOT, field, payload: value });

        const reply = await device.waitHid(IFACE.VENDOR,
          { since, match: /Successfully set|Error/, timeoutMs: 5000, signal });
        const text = okmsg.text(reply);
        assert.ok(!/Error/.test(text), `setting field ${field} failed: ${text}`);
      }
    });

    it('types the stored password when its button is pressed',
      async ({ device, assert, signal, log }) => {
        device.log.clear();
        device.keys.clear();

        /*
         * A press that lands mid-fade is discarded.
         *
         * payload() reads the slot's settings, prints "Additional Character",
         * and then does `if (isfade) return;` - so a press that arrives while
         * the LEDs are still animating (from the unlock, or from the blink that
         * acknowledges a slot write) is consumed and produces nothing at all.
         * Measured: the first press after configuring a slot never types; the
         * second one does.
         *
         * Pressing again is exactly what a person does when a key does not
         * respond, so it is what the test does too - and it is the only honest
         * option, since the firmware prints nothing when the fade ends.
         */
        let typed = null;
        for (let attempt = 1; attempt <= 3 && !typed; attempt++) {
          device.press(SLOT);
          typed = await device.waitKeystrokes(PASSWORD, { timeoutMs: 6000, signal })
            .catch(() => null);
          if (!typed) log(`press ${attempt} landed mid-fade and was discarded`);
        }

        assert.ok(typed, `the device typed ${JSON.stringify(device.keystrokes)} in three presses`);
        assert.ok(device.hid[IFACE.KEYBOARD].length > 0, 'no keyboard reports at all');
        assert.includes(device.keystrokes, PASSWORD);
      });

    it('decodes press and release as one character each',
      async ({ device, assert }) => {
        /*
         * A key is pressed in one report and released by the next report that
         * omits it, so a naive decoder emits everything twice. The report count
         * being about double the character count is the evidence that the
         * edge-triggering is doing its job.
         */
        const reports = device.hid[IFACE.KEYBOARD].length;
        assert.ok(reports >= PASSWORD.length,
          `${reports} reports for ${PASSWORD.length} characters`);
        assert.equal(device.keystrokes.replace(/[^\x20-\x7e]/g, ''), PASSWORD,
          'decoded text should be exactly what was stored');
      });

    it('reads the password back out of EEPROM, encrypted', async ({ device, assert }) => {
      /*
       * The debug console narrates the decryption, which is what makes this an
       * assertion about the crypto path rather than about the keyboard: the
       * firmware read ciphertext from EEPROM and produced the plaintext through
       * AES-GCM, dereferencing certified_hw on the way - the exact operation
       * that segfaults at the unprivileged mmap rung.
       */
      assert.match(device.log.text, /Reading Password from EEPROM/);
      assert.match(device.log.text, /DECRYPTED STATE/);
    });
  });
