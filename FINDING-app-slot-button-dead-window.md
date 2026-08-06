# The OnlyKey App shows clickable slot buttons ~1.2s before they do anything

**Component:** `OnlyKey-App` (the packaged nw.js configuration app), `app/scripts/onlyKey/OnlyKeyComm.js`
**Severity:** low - usability, not security. No data is at risk and nothing is
mis-written; a click is silently discarded.
**Measured:** 2026-08-06, against the OnlyKey emulator over its USB gadget,
firmware `v3.0.4-testc`, App 5.5.0, nw.js 0.114.0 / Chromium 151.
**Status:** reproduced with a positive control. Not previously reported, and
structurally invisible to the App's own test suite - see the last section.

## What happens

After the device is unlocked, the App reveals its **Slots** tab with twelve slot
buttons (`1a`..`6b`). They are laid out, styled and hit-testable. For about
**1.2 seconds** none of them is wired to anything: clicking one does nothing at
all - no dialog, no error, no console output.

A user who clicks a slot button in that window sees a button that ignored them.
Clicking again works.

## Why

The click handler is bound in `initSlotConfigForm()`:

```js
function initSlotConfigForm() {
  const deviceType = myOnlyKey.getDeviceType();
  const deviceBtns = ui.slotConfigBtns.getElementsByClassName(`ok-${deviceType}`)[0];
  const configBtns = Array.from(deviceBtns.getElementsByTagName('input'));
  configBtns.forEach((btn, i) => {
    ...
    btn.addEventListener('click', showSlotConfigForm);   // <- the binding
  });
  ...
}
```

and the only thing that calls it during startup is **`handleGetLabels()`**, on
receipt of a slot-label message from the device:

```js
} else {
  myOnlyKey.labels[slotNum - 1] = msgParts[1];
  initSlotConfigForm();          // OnlyKeyComm.js:504
  ...
}
```

**Revealing the panel and binding its buttons are driven by different events.**
The panel is shown from the unlocked/initialized state; the binding waits for
the first `OKGETLABELS` reply to come back over HID. The gap between those two
is the dead window.

The binding is also not a one-off - `initSlotConfigForm()` runs again for every
label message (12 of them here, one per slot), re-binding the same listener each
time. `addEventListener` de-duplicates an identical function reference, so this
is wasted work rather than twelve handlers, but it does mean the *first* label
is what ends the dead window.

## Measurement

Instrumented from inside the page, with the click issued in the same animation
frame that first observes the button as laid out - a click driven over CDP from
outside cannot test this, because the round trip is comparable to the window
being measured.

```
visibleAt            4993 ms   (slot button first has non-zero width)
boundAt              6156 ms   (initSlotConfigForm runs for the first time)
gapMs                1163 ms
clickedBeforeBind    true
dialogOpenAfterClick false     <- the click did nothing
dialogOpenNow        false     <- and nothing happened later either
```

**Positive control, in the same run:** clicking the same button after binding
opens the dialog (`open: true`). Without that, "the click did nothing" would be
indistinguishable from a broken click instrument.

## What makes it reachable

Nothing artificial. The sequence is the ordinary one:

1. Plug in an OnlyKey and open the App.
2. Enter the PIN on the device.
3. The App switches to the Slots tab as soon as it sees the device unlocked.
4. **Click a slot button as soon as it appears.**

The window opens exactly when the UI first invites the click, which is the worst
possible placement: the affordance appears at the start of the dead period, not
at the end of it. There is no spinner, no disabled state and no "loading" text
on the slot buttons during it - the App's `working-dialog` is closed by this
point.

**On real hardware the window is likely to be wider than measured here.** The
gap is bounded by the round trip of the first `OKGETLABELS` reply, and this
measurement is against an emulated device on an in-process HID bus. A physical
key over USB, and particularly one on a hub or a busy host, has further to go.

## Suggested fixes

Any one of these closes it; the first is the smallest.

1. **Bind the handlers when the panel is built rather than when labels arrive.**
   The buttons exist in the markup already; nothing about `addEventListener`
   needs a label. `initSlotConfigForm()` currently does two unrelated jobs -
   setting label text and binding handlers - and only the first needs the device.
2. **Disable the slot buttons until the first label arrives**, so the affordance
   matches the behaviour.
3. Failing either, **bind once** rather than on every label message, and do it
   at the earliest point `myOnlyKey.getDeviceType()` is known - the binding is
   already guarded by device type via the `ok-${deviceType}` container lookup.

## Why the App's own tests cannot see this

`OnlyKey-App/test/configure-slot-test.js` covers this exact flow and passes,
because it drives a **mocked** `chrome.hid`:

```js
['UNLOCKED', 'OK', 'UNLOCKEDv0.2-beta.3', '\0', '\x01|FooLabel', ...]
  .forEach(function (msgText) {
    driver.executeScript(function (msg) { chromeHid.mockResponse([null, msg]); },
      messageToBuffer(msgText));
  });
driver.findElement(By.id('slot1aConfig')).click();
```

The canned label messages are pushed synchronously, immediately before the
click, so the binding has always happened by the time the button is clicked.
**The dead window is a property of a device that answers over a wire, and the
mock does not have one.** That is the general shape worth noting: a mock that
answers instantly cannot exhibit a bug whose whole content is latency.

## A second, smaller finding from the same flow: the NEXTKEY3 FIXME does not reproduce

`configure-slot-test.js` ends with a test whose comment reads:

```js
// For some reason, it's also setting NEXTKEY3 to 2 (Return).
// FIXME is this a bug in the form? Should this be unchecked?
```

Measured against a device: **it does not happen.** Configuring a password
through the slot dialog and then pressing the button types the password and
**nothing after it**.

With a positive control in the same test, because otherwise this says nothing:
writing `NEXTKEY3` = `'2'` directly over the vendor interface - field 6, the same
message the App's test captured - and pressing again types the password followed
by `"\n"`. So the instrument can see a Return, and the App's not producing one
is a real absence rather than a decoder that drops it.

Two readings, and this does not distinguish them: either the behaviour was
fixed at some point after that test was written and its comment outlived it, or
it is reachable only through the exact click sequence that test performs (it
submits once with a deliberate confirmation mismatch, then submits again). Worth
one line either way, because a FIXME describing something that no longer happens
is a maintenance cost of its own.

## One thing that is not a defect, recorded because it looks like one

While chasing this, `getAttribute('open')` on the dialog reads as falsy even
when the dialog is fully open. That is correct DOM behaviour - `showModal()`
sets the attribute to the **empty string** - and the App's selenium test
comparing `getAttribute('open')` to `'true'` is right only because WebDriver
normalises boolean attributes to `"true"`. Anything reading the raw DOM must use
the `open` **property** (or `hasAttribute`). This cost three debugging
iterations here and is not a bug in the App.
