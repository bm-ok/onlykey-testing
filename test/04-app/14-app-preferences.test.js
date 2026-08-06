/*
 * Section 4: the App's Preferences tab, against a device instead of a mock.
 *
 * THE APP'S OWN SUITE DOES NOT TOUCH THIS TAB. `configure-slot-test.js` covers
 * slots and `startup-test.js` covers two dialogs; nothing exercises settings.
 * That matters here because these are DEVICE-WIDE settings rather than slot
 * data - one of them changes how fast the key types every password it holds,
 * another decides whether the lock button works - and a mocked `chrome.hid`
 * cannot tell you that the byte which arrived is the byte the form showed.
 *
 * SURFACE: vendor, entirely. The firmware acknowledges every one of these BY
 * NAME - "Successfully set typespeed" is a different string from "Successfully
 * set keyboard layout" - so the acknowledgement identifies the field with no
 * debug line anywhere in the file. That is the same property `02-cli/11-cli-settings`
 * rests on, and it means this whole file survives into a production walk.
 *
 * WHY THESE FIVE AND NOT THE WHOLE PANEL. The tab carries eight controls and
 * they fall into three groups that need different handling:
 *
 *   - FIVE FORMS, driven here: typespeed, keyboard layout, LED brightness,
 *     lockout (idle timeout) and lock button. All five are accepted OUTSIDE
 *     config mode, which `11-cli-settings` measured, so a test can establish
 *     its own state with nothing more than an unlock.
 *   - TWO BUTTON PAIRS, not driven: modkey mode and HMAC button press. Both are
 *     refused outside config mode, and config mode is sticky with no exit but a
 *     reboot - so driving them here would leave every later test in this
 *     section running against a device in a different mode than it thinks.
 *     `11-cli-settings` covers both refusals already.
 *   - ONE DESTRUCTIVE BUTTON, DELIBERATELY NEVER CLICKED: `fullWipeModeBtn`
 *     calls `submitWipeMode(e, 2)`, which is "Successfully set Wipe Mode to
 *     Full Wipe". On a physical key a full wipe erases the firmware hash and
 *     forces the bootloader - that is what the `full-wipe` capability exists to
 *     gate, and its reason string names the cost. No file in section 4 clicks
 *     it. The inventory test below asserts it is PRESENT and leaves it alone,
 *     so its absence would be noticed without it ever being armed.
 *
 * OUTSIDE `--isolate` AND `--reverse` BY CONSTRUCTION, like the rest of the
 * section - the session lives in 10-session. Every test here still establishes
 * its own device state and attaches its own page, so a failure names one test.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');

const session = require('../../lib/app-session-holder');

/** Switch to a tab by clicking the same control a user would. */
async function showPanel(page, showId) {
  await page.eval(`(() => {
    const el = document.getElementById(${JSON.stringify(showId)});
    if (!el) throw new Error('no such panel control: ' + ${JSON.stringify(showId)});
    el.click();
  })()`);
}

/**
 * Fill one Preferences field and press its submit button.
 *
 * The App reads these with `ui.<form>.<field>.value` and `parseInt`, so setting
 * `.value` is genuinely what the user's typing does - unlike the slot form,
 * which gates every field behind its own checkbox.
 */
async function setAndSubmit(page, { field, value, submit }) {
  const result = await page.eval(`(() => {
    const el = document.getElementById(${JSON.stringify(field)});
    const btn = document.getElementById(${JSON.stringify(submit)});
    if (!el) return 'no such field: ' + ${JSON.stringify(field)};
    if (!btn) return 'no such submit: ' + ${JSON.stringify(submit)};
    el.value = ${JSON.stringify(String(value))};
    /* A <select> reads its value on change; an <input> is read on submit. Fire
     * both so one helper covers the two shapes. */
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    btn.click();
    return 'submitted';
  })()`);
  if (result !== 'submitted') throw new Error(result);
}

/*
 * Drive one setting and require the device to acknowledge THAT setting.
 *
 * The assertion is deliberately stronger than "no error came back". Each of
 * these fields has its own acknowledgement string, so requiring the right one
 * proves the App sent the field it displayed - a form that wrote the typespeed
 * byte into the brightness slot would still answer "Successfully set ...", just
 * not with this name.
 */
async function drives(t, { field, value, submit, ack, what }) {
  const { device, assert, signal, log } = t;
  await device.ensureUnlocked(PINS.primary, { signal });

  const s = session.get();
  const page = await s.attach('app');
  try {
    await s.waitForDevice(page, device, { signal, log });
    await showPanel(page, 'show-pref-panel');

    const since = device.mark(IFACE.VENDOR);
    await setAndSubmit(page, { field, value, submit });

    const reply = await device.waitHid(IFACE.VENDOR,
      { since, match: /Successfully set|Error/, timeoutMs: 20000, signal });
    const said = okmsg.text(reply).trim();
    log(`device said: ${said}`);

    assert.ok(!/^Error/.test(said), `setting ${what} through the App: ${said}`);
    assert.match(said, ack,
      `the device acknowledged something other than ${what} - the App may have ` +
      `sent a different field than the form it was given (it said ${JSON.stringify(said)})`);
  } finally {
    page.close();
  }
}

describe('app preferences', {
  state: 'initialized',
  requires: ['client-access', 'display', 'nwjs'],
  timeoutMs: 240000,
}, () => {
  it('sets keytypespeed through the Preferences form, acknowledged by name', async (t) => {
    await drives(t, {
      field: 'okTypeSpeed', value: 7, submit: 'typeSpeedSubmit',
      ack: /Successfully set typespeed/i, what: 'the type speed',
    });
  });

  it('sets keylayout through the Preferences form, acknowledged by name', async (t) => {
    /*
     * The only <select> on the tab. Its value is a numeric layout index rather
     * than a name, and the App parseInts it, so 1 is "the second entry" rather
     * than anything meaningful - which is fine, because what is being tested is
     * that the App transmits the field it showed.
     */
    await drives(t, {
      field: 'okKeyboardLayout', value: 1, submit: 'kbdLayoutSubmit',
      ack: /Successfully set keyboard layout/i, what: 'the keyboard layout',
    });
  });

  it('sets ledbrightness through the Preferences form, acknowledged by name', async (t) => {
    await drives(t, {
      field: 'okLedBrightness', value: 3, submit: 'ledBrightnessSubmit',
      ack: /Successfully set LED brightness/i, what: 'the LED brightness',
    });
  });

  it('sets idletimeout through the Preferences lockout form, acknowledged by name', async (t) => {
    /*
     * Named `lockout` in the UI and `idletimeout` in every client and in the
     * firmware's own acknowledgement. The test name carries BOTH, because the
     * kit's convention is that `--test idletimeout` selects the endpoint and a
     * reader coming from the App needs the other word to find it.
     */
    await drives(t, {
      field: 'okLockout', value: 10, submit: 'lockoutSubmit',
      ack: /Successfully set idle timeout/i, what: 'the idle timeout',
    });
  });

  it('sets lockbutton through the Preferences form, acknowledged by name', async (t) => {
    await drives(t, {
      field: 'okLockButton', value: 1, submit: 'lockButtonSubmit',
      ack: /Successfully set lock button/i, what: 'the lock button',
    });
  });

  it('exposes the full-wipe control, which no test arms', async ({ device, assert, signal, log }) => {
    /*
     * AN INVENTORY ASSERTION, AND THE REASON IT IS WORTH ONE.
     *
     * `fullWipeModeBtn` is wired to `submitWipeMode(e, 2)` - Full Wipe. This
     * file will not click it, and neither will any other in section 4, for the
     * same reason the Firmware tab is off limits: on a physical key it erases
     * the firmware hash and forces the bootloader.
     *
     * But "we do not touch it" is invisible in a test suite, and an untouched
     * control is indistinguishable from a control that quietly disappeared. So
     * its presence is asserted and its handler is left alone. If the App ever
     * moves or renames it, this fails and somebody re-reads this comment rather
     * than discovering the gap later.
     *
     * The two config-mode button pairs are checked the same way and for a
     * milder version of the same reason - driving them would strand the section
     * in config mode, which has no exit but a reboot.
     */
    await device.waitReady();

    const s = session.get();
    const page = await s.attach('app');
    try {
      await s.waitForDevice(page, device, { signal, log });
      await showPanel(page, 'show-pref-panel');

      const present = JSON.parse(await page.eval(`(() => {
        const ids = ['fullWipeModeBtn', 'enableModkeyModeBtn', 'disableModkeyModeBtn',
                     'enableHmacBtnPressBtn', 'disableHmacBtnPressBtn'];
        const out = {};
        for (const id of ids) out[id] = !!document.getElementById(id);
        return JSON.stringify(out);
      })()`));
      log(`untouched controls: ${JSON.stringify(present)}`);

      for (const [id, found] of Object.entries(present)) {
        assert.ok(found,
          `the Preferences tab no longer has ${id} - this file asserts its ` +
          'presence precisely because it must never be driven, so a rename ' +
          'needs a human to look rather than a silent gap');
      }
    } finally {
      page.close();
    }
  });
});
