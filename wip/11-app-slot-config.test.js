/*
 * Section 4: the App's slot configuration, against a device instead of a mock.
 *
 * THE INVENTORY IS THE APP'S OWN TEST, and it is read for what it COVERED, not
 * for what it claims is true - the same rule PLAN sets for `test-api`.
 * `OnlyKey-App/test/configure-slot-test.js` walks: disconnected, working,
 * device connected, locked, the slot dialog open, the label shown, the password
 * confirmation check, the OKSETSLOT bytes for a password, and a NEXTKEY3 write
 * nobody asked for. Every one of those assertions is made against
 * `chromeHid.mockResponse()` - canned bytes, including a firmware version
 * (`UNLOCKEDv0.2-beta.3`) that no device here runs.
 *
 * So the App's suite proves the WIRING and never the device, which is the exact
 * mirror of every other section in this kit, and closing that is the whole
 * reason section 4 exists.
 *
 * WHAT THIS FILE ASSERTS ON, AND WHY NOT `_sent`. The row that planned this
 * section believed `chromeHid._sent` recorded what the App put on the wire. It
 * does not - `send()` appends to it only when the connection is the mock's, so
 * against a real device it stays empty. The better oracle was available all
 * along: THE DEVICE END. What arrived is stronger evidence than what a client
 * believes it sent, and it needs no patching at all.
 *
 * SURFACE: keyboard and vendor, plus the App's own UI. The strongest assertion
 * here reads a secret back by PRESSING THE BUTTON and decoding what the device
 * types - the same instrument `02-cli/13-cli-lifecycle` uses, and one that
 * survives into a production walk. The debug console is not read anywhere here.
 *
 * OUTSIDE `--isolate` AND `--reverse` BY CONSTRUCTION, like `03-gui/14`: the
 * session lives in `10-session`. The discipline that replaces the gates is
 * minimum coupling - every test brings the device to the state it asserts about
 * and attaches its own page.
 */
'use strict';

const { describe, it } = require('../lib/harness');
const { IFACE, okmsg } = require('../lib/device');
const { PINS } = require('../lib/config');

const session = require('../lib/app-session-holder');

/* Named per file, the way section 1 does - there is no shared FIELD export. */
const FIELD = { LABEL: 1, PASSWORD: 5 };

/* The slot the App calls "1a" and the firmware calls 1. */
const SLOT = 1;
const LABEL = 'oktapp1';
const PASSWORD = 'oktAppPass1';

/**
 * Open the slot dialog for 1a and wait for it.
 *
 * `slot1aConfig` IS A DUPLICATE ID in app.html - line 381 and line 440 - and
 * only ONE of the two is ever rendered. Neither "the first" nor "the one with
 * data-slot-id" is a safe rule: preferring the data attribute picked the
 * element in the hidden panel and waited sixty seconds for a control that was
 * never going to be laid out, while `getElementById` happened to return the
 * live one. Both facts are accidents of document order.
 *
 * So the rule here is the only one that stays true if the markup moves: click
 * whichever candidate is actually VISIBLE. A zero-width control is not a
 * control a user could press, and that is the property being relied on.
 */
async function openSlotDialog(page) {
  /*
   * WAIT FOR THE APP TO HAVE NOTICED THE UNLOCK, not merely for the device to
   * be unlocked. These are different events with a gap between them: this kit
   * unlocks over its own in-process bus, and the App learns about it from its
   * own traffic some time later. Clicking in that gap finds the slot controls
   * present in the DOM and laid out at 0x0 - the panel is not shown yet - so
   * the click lands on nothing and the dialog never opens.
   *
   * Measured while writing this file: the first version failed exactly there,
   * and a screenshot of the window was what distinguished "the control is
   * missing" from "the control is not visible yet".
   */
  /*
   * EVERY WAIT HERE IS UNDER THE 30s INACTIVITY BUDGET, deliberately. A page
   * wait produces no device output, so a 60s one does not fail its own test -
   * it trips the run-level inactivity watchdog and aborts the WHOLE run with
   * exit 3, blaming a watchdog rather than the test that hung. Section 2 caps
   * its CLI commands at 12s for exactly this reason; the same arithmetic
   * applies to anything that waits on a browser.
   */
  await page.waitFor(
    "typeof myOnlyKey !== 'undefined' && myOnlyKey && myOnlyKey.isInitialized " +
    '&& myOnlyKey.isLocked === false',
    { timeoutMs: 20000 });

  const clicked = await page.eval(`(() => {
    const seen = (el) => el && el.getBoundingClientRect().width > 0;
    const candidates = [
      ...document.querySelectorAll('#slot1aConfig'),
      ...document.querySelectorAll('[data-slot-id="1a"]'),
    ];
    const target = candidates.find(seen);
    if (!target) {
      return 'FOUND ' + candidates.length + ' slot-1a candidates, none visible';
    }
    target.click();
    return 'clicked a visible slot 1a control of ' + candidates.length + ' candidates';
  })()`);

  if (clicked.startsWith('FOUND')) throw new Error(clicked);

  await page.waitFor(
    "!!document.getElementById('slot-config-dialog').getAttribute('open')",
    { timeoutMs: 20000 });
  return clicked;
}

/** Submit the slot form and wait for the App to close the dialog. */
async function submitSlot(page) {
  await page.eval("document.getElementById('slotSubmit').click()");
}

/*
 * `state: 'initialized'` because every assertion here is about a provisioned
 * device, and the runner restores that fixture before the file runs.
 *
 * Note what that means for the App, which outlives the file: each file gets its
 * OWN device host, so between 10-session and this file the device goes away and
 * a new one appears. The App survives it - `init()` registers
 * `onDeviceAdded`/`onDeviceRemoved`, and the connection id observed in the first
 * test is 2 rather than 1 for exactly that reason.
 */
describe('app slot config', {
  state: 'initialized',
  requires: ['client-access', 'display', 'nwjs'],
  timeoutMs: 240000,
}, () => {
  it('shows a connected device rather than its disconnected dialog', async ({ device, assert, log }) => {
    /*
     * ESTABLISH THE STATE THIS ASSERTS ABOUT. The App enumerates as it loads and
     * 10-session raised the gadget before it, so a connection should already
     * exist - but "should" is what this file exists to replace.
     */
    await device.waitReady();

    const s = session.get();
    const page = await s.attach('app');
    try {
      const state = JSON.parse(await page.eval(`(() => {
        const open = (id) => {
          const el = document.getElementById(id);
          return el ? !!el.getAttribute('open') : null;
        };
        return JSON.stringify({
          disconnected: open('disconnected-dialog'),
          working: open('working-dialog'),
          locked: open('locked-dialog'),
          connectionId: (typeof myOnlyKey !== 'undefined') ? myOnlyKey.connection : null,
        });
      })()`));
      log(`dialogs: ${JSON.stringify(state)}`);

      /* The App's own account of whether it got a device: setConnection(-1)
       * is its "none". */
      assert.ok(state.connectionId !== null && state.connectionId !== -1,
        `the App has no device connection (connectionId ${state.connectionId}) - ` +
        'it either enumerated before the gadget was up or took the wrong interface');
      assert.ok(!state.disconnected,
        'the App shows its disconnected dialog with a device on the bus');
    } finally {
      page.close();
    }
  });

  it('writes a slot LABEL through the UI that the device reports back', async ({ device, assert, signal, log }) => {
    await device.ensureUnlocked(PINS.primary, { signal });

    const s = session.get();
    const page = await s.attach('app');
    try {
      /*
       * Drive the App's own form rather than its internals. Calling
       * `myOnlyKey.setSlot()` directly would skip precisely the layer section 4
       * exists to test - the App's suite already proves that much against a mock.
       */
      log(await openSlotDialog(page));

      await page.eval(`(() => {
        const label = document.getElementById('txtSlotLabel');
        label.value = ${JSON.stringify(LABEL)};
        label.dispatchEvent(new Event('input', {bubbles: true}));
        label.dispatchEvent(new Event('change', {bubbles: true}));
      })()`);
      await submitSlot(page);

      /* The DEVICE's answer, over this kit's own transport - not the App's. */
      const since = device.mark(IFACE.VENDOR);
      device.sendVendor({ msg: okmsg.MSG.OKGETLABELS });
      const reply = await device.waitHid(IFACE.VENDOR,
        { since, match: new RegExp(LABEL), timeoutMs: 20000, signal });

      assert.includes(okmsg.text(reply), LABEL,
        'the label the App wrote never came back from the device');
    } finally {
      page.close();
    }
  });

  it('writes a PASSWORD through the UI that the device TYPES when pressed', async ({ device, assert, signal, log }) => {
    /*
     * The assertion worth having in this file, and the one the App's own suite
     * structurally cannot make: it checks the BYTES of an OKSETSLOT message it
     * captured from its own mock. This checks that the secret which comes out
     * of the device is the one the user typed into the App.
     */
    await device.ensureUnlocked(PINS.primary, { signal });

    const s = session.get();
    const page = await s.attach('app');
    try {
      log(await openSlotDialog(page));

      await page.eval(`(() => {
        const chk = document.getElementById('chkPassword');
        if (chk && !chk.checked) chk.click();
        for (const id of ['txtPassword', 'txtPasswordConfirm']) {
          const el = document.getElementById(id);
          el.value = ${JSON.stringify(PASSWORD)};
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
      })()`);
      await submitSlot(page);

      /* Let the App's writes land before asking the device to replay them. */
      await new Promise((r) => setTimeout(r, 2000));

      device.keys.clear();

      /*
       * A press that lands mid-fade is discarded - `payload()` returns early on
       * `isfade`, and a slot write blinks the LEDs. Pressing again is what a
       * person does when a key does not respond, and it is the only honest
       * option since the firmware prints nothing when the fade ends.
       */
      let typed = null;
      for (let attempt = 1; attempt <= 3 && !typed; attempt++) {
        device.press(SLOT);
        typed = await device.waitKeystrokes(PASSWORD, { timeoutMs: 8000, signal })
          .catch(() => null);
        if (!typed) log(`press ${attempt} landed mid-fade and was discarded`);
      }

      assert.ok(typed,
        `the device typed ${JSON.stringify(device.keystrokes)} in three presses, ` +
        `not the password the App was given`);
      assert.includes(device.keystrokes, PASSWORD);
    } finally {
      page.close();
    }
  });

  it('appends a RETURN after the password without being asked - NEXTKEY3, pinned as it ships', async ({ device, assert, signal, log }) => {
    /*
     * THE APP'S OWN TEST FLAGS THIS AND CANNOT SETTLE IT. Its comment reads:
     *
     *   // For some reason, it's also setting NEXTKEY3 to 2 (Return).
     *   // FIXME is this a bug in the form? Should this be unchecked?
     *
     * It could only see an OKSETSLOT message going to its mock. Whether the
     * device then TYPES a Return is a device question, and this is the first
     * place able to ask it: configure a password through the UI, press the
     * button, and look at what came off the keyboard interface after it.
     *
     * PINNED AS IT SHIPS, and written to FAIL when the form is fixed - the
     * convention this kit uses for behaviour it has decided to record rather
     * than to bless. If the App stops adding NEXTKEY3, this test is the thing
     * that says so.
     */
    await device.ensureUnlocked(PINS.primary, { signal });

    const s = session.get();
    const page = await s.attach('app');
    try {
      log(await openSlotDialog(page));
      await page.eval(`(() => {
        const chk = document.getElementById('chkPassword');
        if (chk && !chk.checked) chk.click();
        for (const id of ['txtPassword', 'txtPasswordConfirm']) {
          const el = document.getElementById(id);
          el.value = ${JSON.stringify(PASSWORD)};
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
      })()`);
      await submitSlot(page);
      await new Promise((r) => setTimeout(r, 2000));

      device.keys.clear();

      let typed = null;
      for (let attempt = 1; attempt <= 3 && !typed; attempt++) {
        device.press(SLOT);
        typed = await device.waitKeystrokes(PASSWORD, { timeoutMs: 8000, signal })
          .catch(() => null);
        if (!typed) log(`press ${attempt} landed mid-fade and was discarded`);
      }
      assert.ok(typed, 'the device did not type the password, so the tail cannot be read');

      /* Give the Return its own moment - it is one report after the last
       * character, and waitKeystrokes returned on the password alone. */
      await new Promise((r) => setTimeout(r, 1500));

      const tail = device.keystrokes.slice(device.keystrokes.indexOf(PASSWORD) + PASSWORD.length);
      log(`what followed the password: ${JSON.stringify(tail)}`);

      assert.match(tail, /[\r\n]/,
        'the App no longer appends a Return after a password - if that was ' +
        'deliberate, this test has done its job and should be updated to ' +
        'assert the new behaviour (see the FIXME in the App\'s own ' +
        'configure-slot-test.js)');
    } finally {
      page.close();
    }
  });
});
