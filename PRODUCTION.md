# The production walk

A fifth mode, and not a fifth section. Sections 1-4 all ask "does the device do
what it should". This asks the opposite question - "does the device NOT do what
it must not" - against a key built the way customers get it, with a human or a
robot pressing the buttons.

[PLAN.md](PLAN.md) is the source of truth for the four sections. This file is
separate because the production walk breaks an assumption every one of those
sections rests on, and that break is the whole design.

---

## The instrument is the thing being removed

Nearly every assertion in this kit reads the debug console. `device.log`,
`waitFor`, `waitForCount`, `waitForAny` - all of it is SEREMU output. On a
production key SEREMU is gone, deliberately: it is a debugging and development
interface, and on a security key it is a key-extraction path.

So the production walk is not "the same test files against a third adapter".
Emulated -> hardware is an adapter swap behind one device API. Hardware ->
production is a different *observability budget*, and most existing tests have
nothing left to read. What remains is what a real client can see:

    keyboard        what the device types
    vendor  0xFFAB  the raw HID request/response surface
    FIDO    0xF1D0  CTAPHID

That set is small, and that is the point - it is also exactly what an attacker
gets.

## The four interfaces, and which one goes

Counting from zero, as the code does. Spoken as HID1-HID4, SEREMU is HID4.

| iface | name | usage page | gadget node | on production |
|---|---|---|---|---|
| 0 | keyboard | - | `/dev/hidg0` | present |
| 1 | FIDO | `0xF1D0` | `/dev/hidg1` | present |
| 2 | vendor | `0xFFAB` | `/dev/hidg2` | present |
| 3 | SEREMU | - | `/dev/hidg3` | **absent** |

Defined in [`emulator/lib/hid-descriptors.js`](../../emulator/lib/hid-descriptors.js)
(`INTERFACES`), mirrored by `IFACE` in [`lib/device/index.js`](lib/device/index.js),
and originating in the firmware's own `usb_desc.h`.

SEREMU is last in both layouts, which is why removing it is clean: keyboard,
FIDO and vendor keep interface numbers 0, 1 and 2 either way. Real clients are
unaffected - `python-onlykey`'s `client.py` selects on
`usage_page == 0xffab or interface_number == 2` for vendor and
`0xf1d0 or interface_number == 1` for FIDO, and both hold on a three-interface
key.

The only consumer anywhere that wants interface 3 is
`OnlyKey-App/test/serial.js`, which opens SEREMU on purpose to read the debug
console. It is a development tool, and on a production key it correctly finds
nothing.

## DEBUG is not the switch

This is the trap, and it is worth stating before anyone tries to build a
production image by turning off a flag.

**`-DDEBUG` and the SEREMU interface are independent.** `DEBUG` - set in
`emulator/binding.gyp` alongside `USB_RAWHID` - controls whether
`Serial.println` emits anything. Turning it off gives a *silent* device that
still enumerates four interfaces. It does not produce a production descriptor
set.

The interface set comes from the firmware's `usb_desc.h`, under
`#elif defined(USB_RAWHID)`. There are two complete configuration blocks there:
the active one with `NUM_INTERFACE 4` and `SEREMU_INTERFACE 3`, and a second
one with `NUM_INTERFACE 3` and no SEREMU - **commented out**. Switching between
them is a manual edit of a comment block. No build flag selects it, and nothing
in the build complains either way.

The two blocks also differ by more than one interface. Endpoints are renumbered
wholesale:

| | debug (4 iface) | production (3 iface) |
|---|---|---|
| `NUM_ENDPOINTS` | 7 | 5 |
| `RAWHID_TX` / `RX` | 3 / 4 | 1 / 2 |
| `RAWHID2_TX` / `RX` | 5 / 6 | 3 / 4 |
| `KEYBOARD_ENDPOINT` | 7 | 5 |
| intervals | 5 | 1 |

So production is not "the same device minus a channel". It is a different
endpoint layout at different polling intervals, and anything keyed to endpoint
numbers - the gadget bridge's `/dev/hidgN` mapping in particular - does not
carry over untouched.

**A security-critical property enforced by a comment block is one careless
commit from shipping wrong.** That is the strongest argument for asserting it
mechanically, and it argues for asserting it at *release* time and not only
during a walk.

## What would make this cheap: one `#ifdef`

Turning that commented block into a real conditional - say `OK_PRODUCTION_USB`,
defaulting to the current four-interface build when undefined - would let the
emulator build **both** descriptor sets from one tree. Behaviour on ARM is
bit-identical when the flag is not set, so it fits the existing gate convention:
gate only what changes ARM behaviour, and this changes nothing by default.

With that in place the entire production walk - descriptor assertion, capture,
canary scan - becomes developable and CI-able on the emulator, with no physical
key in the loop until one is actually wanted. Without it, every iteration needs
a hand-edited firmware build.

This is a change in the firmware sources rather than in this kit, so it is a
decision to be taken deliberately, not folded into a test commit.

## The descriptor assertion

The first thing the walk does, and it refuses to continue if it fails: if
SEREMU is present on a key claiming to be production, nothing else the walk
finds matters.

Three rules make it trustworthy.

**Assert set equality, not absence.** "SEREMU is not in the list" fails open - a
key that did not enumerate, a permissions error, and a wrong device path all
produce an empty list, and an empty list contains no SEREMU. Assert instead that
the interface set *equals* keyboard + `0xF1D0` + `0xFFAB` and nothing else. Now
every failure that produces "we saw nothing" reads as a failure, and any
unexpected *extra* interface a bad build adds is caught too.

**Match on usage page, not on index or order.** `/dev/hidrawN` numbering and
interface ordering are not guaranteed stable across enumerations or kernels. A
check keyed on position passes silently when the ordering shifts. Reading sysfs
also keeps this off `node-hid`, which is an optional dependency - and this check
must never skip.

**Ambiguity fails.** The kit already draws this line with exit codes 4 and 5,
which mean *no verdict was produced* rather than a verdict of pass. A debug
interface that could not be opened is not a debug interface that is off.

The same read doubles as the build discriminator. The gadget presents
`1d50:60fc` / CRYPTOTRUST / ONLYKEY byte for byte, and the hardware adapter
already separates emulator from key via dummy_hcd in sysfs - but nothing today
separates *dev firmware on a real key* from *production firmware*. The interface
set does. So one descriptor read both identifies the build and asserts the
security property, and the walk can hard-refuse a dev build instead of quietly
testing the wrong thing.

## The leak check, and why canaries

"Does any IO leak anything sensitive" is unfalsifiable as written. "Does the
byte sequence of this PIN, this seed, this private key ever appear on any
interface during a full walk" is a scan over a capture, and it either fires or
it does not.

With SEREMU gone the remaining channels are exactly the three client-facing
ones, so "we captured everything" is a true statement rather than an
aspiration. That is what turns the scan into a proof instead of a sample.

It forks the walk into two tiers, and conflating them is how someone eventually
wipes their own key:

- **Non-destructive tier** - descriptors, no unsolicited output, no response to
  debug commands, correct interface set. Safe against any key, including one
  holding real secrets.
- **Canary tier** - requires provisioning known values, therefore requires a key
  that may be wiped. Never run against a key holding anything real.

**Develop the scanner on the emulator**, where DEBUG is on: there you can see
what the device thinks it is doing while capturing what it actually emits, and
confirm the scanner catches a leak introduced deliberately. A leak detector that
has never caught anything is not known to work. Then the same scanner runs
against production as pure passive observation.

## Presses: human, then robot

`device.press(n, {hold})` already abstracts this, with `tap | hold | long |
longest`. Human and robot are two backends behind one call, which is the good
outcome - no test needs to know which.

Two things to get right. The hold durations are load-bearing (config mode is a
long-press of 6), so a robot needs them calibrated rather than assumed. And the
human backend must *confirm* a press landed rather than assume it after
printing a prompt - the firmware discards a press that arrives mid-LED-fade,
which a robot will hit far more often than a person, because it presses the
instant it is told to.

## Sequencing

After the hardware adapter is proven, not before. The production walk shares
that unproven seam and is strictly harder, so proving the seam first is what
keeps a failure here attributable to the walk rather than to the adapter.

But one constraint applies today: **a test that can assert on the vendor,
keyboard or FIDO surface instead of on debug output survives into production
mode for free.** That is a cheap habit to adopt now and an expensive retrofit
later.
