# The OnlyKey App discards a wrong-format Yubico Public ID in total silence

**Component:** `OnlyKey-App` (the packaged nw.js configuration app),
`app/scripts/onlyKey/OnlyKeyComm.js`, Advanced tab
**Severity:** low - usability, not security. Nothing is mis-written and no data
is at risk; the write simply does not happen and the user is not told.
**Measured:** 2026-08-06, against the OnlyKey emulator over its USB gadget,
firmware `v3.0.4-testc`, App 5.5.0, nw.js 0.114.0 / Chromium 151.
**Status:** reproduced with a positive control and a window capture. Not
previously reported.

## What happens

The Advanced tab's "Add Yubikey Security Info (Legacy)" form takes a Public
Identity, a Private Identity and a Secret Key, and writes them to the device.

Enter a Public Identity in **hex** rather than **modhex** and press *Save to
OnlyKey*:

- nothing is sent to the device - zero vendor traffic,
- `yubiError` stays empty,
- the form is **not reset**, so the fields keep the values that were rejected,
- and no message appears anywhere in the UI.

The button appears to do nothing at all. Clicking it again does nothing again.

## Why

`submitYubiAuthForm()` (`OnlyKeyComm.js:1687`) converts the Public ID before
sending it:

```js
publicId = hexToModhex(publicId.slice(0, maxPublicIdLength), true);
```

`hexToModhex(inputStr, reverse)` (`OnlyKeyComm.js:2569`) with `reverse = true`
takes **modhex** as its INPUT alphabet and converts to hex:

```js
var o = reverse ? modhex : hex;      // "cbdefghijklnrtuv"
inputStr.split("").forEach(function (c) {
  var i = o.indexOf(c);
  if (i < 0) {
    throw new Error("Invalid character sent for hexToModhex conversion");
  }
  ...
```

A hex digit is not in that alphabet, so the function **throws**. The throw
happens inside the button's click handler, escapes into event dispatch, and
nothing catches it - the App has `// TODO: validation` on the line directly
above the call, and `// TODO: check for success, then reset` at the callback.
`myOnlyKey.setYubiAuth()` is never reached, so no `OKSETSLOT` leaves the App.

## Why a user hits this

The field IS labelled - "Public Identity (6 bytes modhex)" - so the format is
stated rather than hidden, and this write-up does not claim otherwise. What
makes it easy to get wrong is the two fields immediately below it:

| field | label |
|---|---|
| Public Identity | **6 bytes modhex** |
| Private Identity | 6 bytes **hex** |
| Secret Key | 16 bytes **hex** |

Three adjacent fields, one of which takes a different alphabet from the other
two. A user who fills all three from the same hex dump gets silence.

## The visible tell, such as it is

The only signal is the form NOT resetting. A successful submit ends in
`ui.yubiAuthForm.reset()`, so a still-populated field means the write never
happened - but that is a difference a user has to know to look for, and it is
the same appearance as a form the App simply left alone.

## How it was measured, and the control

Driven through the App's own form against an emulated device, watching the
vendor interface from the other side:

1. **Positive control first.** Submit a VALID modhex Public ID
   (`cbcdcecfcgch`, which is hex `01 02 03 04 05 06`). The device answers
   `Successfully set AES Key, Private ID, and Public ID`. This proves the form,
   the transport and the device all work.
2. **Then the defect.** Submit the same values with the Public ID as hex
   (`010203040506`). Zero vendor reports match `Successfully set|Error` over
   four seconds, `yubiError` is empty, and `yubiPublicId` still holds
   `010203040506`.

Without step 1, "no vendor traffic" would be equally consistent with a broken
form, a detached page or a wedged device - which is a mistake this test kit has
made three times, so the control is mandatory rather than thorough.

Covered by `test/04-app/15-app-advanced.test.js`, which pins the current
behaviour and will fail when it is fixed - deliberately, since a test whose
subject is a known defect should fail when the defect goes.

## Related

Same class as
[FINDING-app-slot-button-dead-window.md](FINDING-app-slot-button-dead-window.md):
a control that a user can operate and that silently does nothing. Both are
usability defects rather than security ones, and both are invisible to the App's
own suite, which drives a mocked `chrome.hid` and never exercises this form.

Worth noting the section header reads "Add Yubikey Security Info **(Legacy)**",
which may bear on how much it is worth fixing.

## Suggested fix

Either validate the field against the modhex alphabet before converting and
report the failure in `yubiError`, or wrap the conversion in a `try/catch` that
does the same. The `// TODO: validation` comment is on the line.
