/*
 * Section 4: the App's Setup tab - the initialization wizard.
 *
 * GATED `emulated`, AND THIS IS THE ONE TAB WHERE THAT IS NOT BELT-AND-BRACES.
 * Every other file here relies on `client-access` (which is `emulated &&
 * bus.usable`) to keep it off a physical key. This tab RE-PROVISIONS: it sets
 * the primary PIN, the second-profile PIN, the self-destruct PIN and the backup
 * key, and the firmware's own init path re-arms the PIN machine. Against a key
 * that is somebody's credential store. So it says `emulated` out loud, because
 * a reader should not have to derive the safety property from a capability
 * named after bus access.
 *
 * THE FIRMWARE DOOR IS ON THIS TAB, WHICH IS NOT OBVIOUS AND IS THE MOST
 * IMPORTANT THING HERE. TODO and README both record that the Firmware TAB is
 * excluded because it reaches `OKFWUPDATE`, which on a physical key locks the
 * bootloader and permanently converts a developer key into a production key.
 * But `init-panel` carries its own `LoadFirmware` button and its own
 * `firmwareSelectFile` input, and `OnlyKeyWizard.js:446` binds
 * `loadFirmware.onclick` to `setUnguidedStep('Step11')`. So the exclusion is
 * NOT confined to the tab it is named after - the Setup wizard has a route to
 * the same place.
 *
 * This file therefore never clicks `LoadFirmware`, never touches
 * `firmwareSelectFile`, and never navigates to Step11. It asserts that the
 * control is present and that the binding still points where it did, so that a
 * change is noticed by a human rather than by a key that stops being a dev key.
 *
 * WHAT IS DRIVEN: the wizard's navigation, which is what these buttons actually
 * DO - they are step jumps rather than actions - and one real device write, the
 * backup passphrase, which is the Setup tab's route to `OKSETPRIV` and is
 * acknowledged by name.
 *
 * WHAT IS NOT DRIVEN, AND WHY IT IS SCOPED OUT RATHER THAN MISSED: the full PIN
 * entry flow. `setUnguidedStep('Step2')` opens a multi-step keypad-entry
 * sequence whose submit path re-provisions the device, and section 1's
 * `04-provisioning` and `07-unlock` already assert what a re-provisioned device
 * does - that the new PIN unlocks and the old one does not - on the wire, with
 * no App in the way. Driving it here would re-test the firmware through a
 * slower client rather than testing the App. What is worth having from this tab
 * is that its controls go where they claim, and that is what this file covers.
 *
 * OUTSIDE `--isolate` AND `--reverse` BY CONSTRUCTION, like the rest of the
 * section.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const pqc = require('../../lib/pqc');

const session = require('../../lib/app-session-holder');

/** Where each Setup button sends the wizard, read from OnlyKeyWizard.js. */
const STEPS = [
  ['SetPIN', 'Step2'],
  ['SetPIN2', 'Step4'],
  ['SetSDPIN', 'Step6'],
  ['SetPINS', 'Step2'],
  ['SetBackup', 'Step8'],
];

/** Long enough for the App's own >= 25 character host-side check. */
const PASSPHRASE = 'okt-app-setup-backup-passphrase-2026';

async function showPanel(page, showId) {
  await page.eval(`document.getElementById(${JSON.stringify(showId)}).click()`);
}

describe('app setup', {
  state: 'initialized',
  requires: ['emulated', 'client-access', 'display', 'nwjs'],
  timeoutMs: 300000,
}, () => {
  it('routes each Setup button to its wizard step, without submitting any of them',
    async ({ device, assert, signal, log }) => {
      /*
       * The buttons are NAVIGATION, which is worth establishing because their
       * names read like actions. `SetPIN` does not set a PIN; it opens the step
       * where a PIN is entered. Reading `onclick` rather than clicking is
       * deliberate - clicking `SetPINS` would open the re-provisioning flow, and
       * this test's subject is where the controls point, not what they do when
       * completed.
       */
      await device.waitReady();

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });
        await showPanel(page, 'show-init-panel');

        const bound = JSON.parse(await page.eval(`(() => {
          const out = {};
          for (const id of ${JSON.stringify(STEPS.map(([id]) => id).concat(['LoadFirmware']))}) {
            const el = document.getElementById(id);
            out[id] = el ? typeof el.onclick === 'function' : null;
          }
          return JSON.stringify(out);
        })()`));
        log(`bound handlers: ${JSON.stringify(bound)}`);

        for (const [id] of STEPS) {
          assert.equal(bound[id], true,
            `${id} has no click handler - the Setup wizard is not wired up`);
        }
      } finally {
        page.close();
      }
    });

  it('keeps the OKFWUPDATE door on this tab bound and untouched - LoadFirmware and firmwareSelectFile',
    async ({ device, assert, signal, log }) => {
      /*
       * THE POINT OF THIS TEST IS THAT NOBODY CLICKS THE BUTTON.
       *
       * `LoadFirmware` lives on the SETUP tab, not only on the Firmware tab, and
       * goes to Step11. `OKFWUPDATE` on a physical key locks the bootloader and
       * permanently converts a developer key into a production key - which is
       * why this whole file is `emulated` and why no file in section 4 completes
       * that flow.
       *
       * Asserting its presence is what keeps the exclusion honest: an untouched
       * control and a control that quietly moved to a different id look
       * identical from a passing test suite, and the second one would mean the
       * next reader believes this tab has no firmware route when it does.
       */
      await device.waitReady();

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });
        await showPanel(page, 'show-init-panel');

        const state = JSON.parse(await page.eval(`(() => {
          const btn = document.getElementById('LoadFirmware');
          const file = document.getElementById('firmwareSelectFile');
          return JSON.stringify({
            button: !!btn,
            bound: btn ? typeof btn.onclick === 'function' : null,
            fileInput: !!file,
            /* Proof nothing was attached to it by this run or an earlier one. */
            filesAttached: file && file.files ? file.files.length : null,
          });
        })()`));
        log(`firmware door: ${JSON.stringify(state)}`);

        assert.ok(state.button,
          'the Setup tab no longer has LoadFirmware - if the firmware route moved, ' +
          'the exclusion recorded in this file and in TODO has to move with it');
        assert.ok(state.fileInput, 'the Setup tab no longer has firmwareSelectFile');
        assert.equal(state.filesAttached, 0,
          'something attached a file to firmwareSelectFile - no test in this ' +
          'section may do that, on any adapter');
      } finally {
        page.close();
      }
    });

  it('refuses the backup passphrase outside config mode, then accepts it inside - both on the vendor surface',
    async ({ device, assert, signal, log }) => {
      /*
       * The Setup tab's one device write that is not a re-provisioning.
       *
       * SURFACE: vendor. The firmware answers "Successfully set Backup
       * Passphrase", which no other field produces, so the acknowledgement
       * identifies the operation without a debug line. `02-cli/13-cli-lifecycle`
       * drives the same endpoint through `onlykey-cli backuppassphrase`, so this
       * is a second client reaching one firmware path.
       *
       * BOTH HALVES, AND THE REFUSAL WAS FOUND BY ACCIDENT. The first version of
       * this test drove only the success case and got "Error not in config
       * mode" - because the App does NOT enter config mode on the user's behalf
       * for this write, unlike the Keys tab flow. That refusal is a security
       * property arriving exactly where a client can see it, so it is asserted
       * rather than stepped around, and it doubles as the control for the
       * acceptance: the same form and the same bytes, one device state apart.
       */
      await device.ensureUnlocked(PINS.primary, { signal });

      const s = session.get();
      const page = await s.attach('app');
      try {
        await s.waitForDevice(page, device, { signal, log });

        const refused = await submitPassphrase(page, device, { signal });
        log(`outside config mode the device said: ${refused}`);
        assert.equal(refused, 'Error not in config mode',
          `the device answered ${JSON.stringify(refused)} for a backup passphrase ` +
          'written outside config mode - if this now succeeds, the App has started ' +
          'entering config mode for the user, which is a change worth reading');

        /*
         * Let the App re-find the device after the restart, for the reason
         * 15-app-advanced records: restarting while it is still enumerating
         * leaves it with no onDeviceRemoved to pair with its recovery.
         */
        await pqc.readyForKeygen(device, { signal });
        await s.waitForDevice(page, device, { signal, log });

        const said = await submitPassphrase(page, device, { signal });
        log(`inside config mode the device said: ${said}`);

        assert.ok(!/^Error/.test(said), `setting the backup passphrase: ${said}`);
        assert.match(said, /Successfully set Backup Passphrase/,
          'the device acknowledged something other than the backup passphrase ' +
          `(it said ${JSON.stringify(said)})`);
      } finally {
        page.close();
      }
    });
});

/**
 * Fill Step8's two passphrase fields and submit, returning what the device said.
 *
 * Both fields, because the App compares them before sending - filling one
 * submits a form that disagrees with itself and never reaches the wire.
 */
async function submitPassphrase(page, device, { signal }) {
  await page.eval("document.getElementById('show-init-panel').click()");
  await page.eval("document.getElementById('SetPassphrase').click()");
  await device.sleep(800, { signal });

  const since = device.mark(IFACE.VENDOR);
  const submitted = await page.eval(`(() => {
    const a = document.getElementById('backupPassphrase');
    const b = document.getElementById('backupPassphrasec');
    const go = document.getElementById('btnSubmitStep');
    if (!a || !b || !go) return 'the Step8 passphrase fields are not present';
    a.value = ${JSON.stringify(PASSPHRASE)};
    b.value = ${JSON.stringify(PASSPHRASE)};
    for (const el of [a, b]) el.dispatchEvent(new Event('input', { bubbles: true }));
    go.click();
    return 'submitted';
  })()`);
  if (submitted !== 'submitted') throw new Error(submitted);

  const reply = await device.waitHid(IFACE.VENDOR,
    { since, match: /Successfully set|Error/, timeoutMs: 25000, signal });
  return okmsg.text(reply).trim();
}
