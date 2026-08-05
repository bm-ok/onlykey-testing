# onlykey-testing

A test kit for OnlyKey firmware that runs against the emulator first and
physical hardware second. The test files are written once; an adapter decides
which device they reach.

The design and its reasoning are in [EXPLAINER.md](EXPLAINER.md). This file is
how to use what was built. What is left to build is [TODO.md](TODO.md), in the
order to do it; [PLAN.md](PLAN.md) is why each of those items exists.

## Quick start

```sh
sudo sysctl -w vm.mmap_min_addr=4096     # once per boot, see "The rung" below
node bin/okt.js caps                     # what this host can reach, and why not
node bin/okt.js list                     # what would run
node bin/okt.js run 01-protocol          # run the protocol section
node bin/okt.js run 01-protocol/07-unlock.test.js   # or one file
echo $?                                  # the verdict
```

### Running one test

`--test` selects by substring against `"<suite name> <test name>"`, which is how
a single endpoint or a single behaviour gets debugged without its neighbours:

```sh
node bin/okt.js run test/02-cli/10-cli-reads.test.js --test rng
```

That only works if the test needs nothing an earlier test in its file did, and
that is a property of how the file was written rather than of the runner.
A test name should contain the literal thing it covers - the CLI sweep names
every `it()` after its endpoint - so `--test getlabels` selects exactly one.
Where one name contains another, `--test` also accepts `/regex/flags`:
`--test '/\bversion\b/'` selects `version` without also selecting `fwversion`.

`--isolate` checks it: each selected test runs in its own device session, and
anything that cannot stand alone is named.

```sh
node bin/okt.js run test/02-cli/10-cli-reads.test.js --isolate
```

It costs a fixture restore and a boot per test, so it is for after adding tests
rather than for ordinary runs. **Files in section 2's CLI sweep are expected to
pass it** - each brings the device to the state it needs itself, through
`device.ensureUnlocked()`, which is the idempotent form of `unlock()`. Files
built around one long operation with several assertions about it - the lib-agent
pair, the composite PGP files - deliberately are not, and `--isolate` reporting
them says exactly that rather than that something is broken.

`unlock()` cannot be called twice and the reason is worth knowing: it works by
PRESSING the PIN digits, so on an already-unlocked device those are slot
presses, the device types whatever the slots hold, and the call waits for an
`UNLOCKED` that will not come again. `ensureUnlocked()` reads the status first.

Standing alone is not the same as being unaffected by what ran before. A test
whose claim is "the device refuses this because config mode is off" passes in
isolation and inverts when a predecessor turns config mode on - and config mode
has no exit but a reboot. So there are two order faults, and they need different
instruments:

| fault | fails when | caught by |
|---|---|---|
| DEPENDS on an earlier test | run alone | `--isolate` |
| BROKEN BY an earlier test | something runs before it | `--reverse` |

`--reverse` runs a file's tests back to front in one ordinary session, so it
costs one run rather than a boot per test:

```sh
node bin/okt.js run test/02-cli/13-cli-lifecycle.test.js --reverse
```

The two orders are complementary rather than redundant. If A leaves state that
spoils B then the natural order already fails; if B leaves state that spoils A,
only the reverse does. Reverse rather than shuffle so that a failure reproduces
by rerunning the same command.

Neither is a substitute for the rule: **establish the state you are asserting
about**, rather than inheriting it. Both flags only tell you where that was not
done.

### Which surface a test reads

A production key ships without SEREMU - it is a debugging interface, and on a
security key it is a key-extraction path - so an assertion that reads the debug
console cannot run in a future production walk, while the keyboard, vendor
(`0xFFAB`) and FIDO (`0xF1D0`) surfaces can. [PRODUCTION.md](PRODUCTION.md) has
the argument.

Prefer a client-visible surface wherever it does not weaken the assertion, and
mark every test with the one it uses, in these words:

```js
/* SURFACE: vendor - survives into a production walk. */
/* SURFACE: console - does NOT survive a production walk, and is used here
 * because nothing a client can see reports which SLOT a write went to. */
```

More is reachable on the vendor surface than it first looks. The firmware
acknowledges each settings write by name, so `02-cli/11-cli-settings` asserts 13
endpoints with one console read between them. Genuinely console-only: counting
button challenges, counting flash sector erases, and reading back a derived
private key.

Nothing has to be installed to run the kit. Everything in `package.json` is an
**optional** dependency, and a file that needs one skips itself with a stated
reason rather than failing:

```sh
npm install                  # both groups
npm install --ignore-scripts # the pure-JS ones only, skipping node-hid's build
```

- `node-hid` - the hardware adapter. Nothing emulated needs it.
- `@noble/post-quantum`, `@noble/hashes`, `@noble/curves` - the X-Wing maths in
  `lib/age-pqc.js`. ML-KEM-768 has no `node:crypto` equivalent, so this is the
  one piece of arithmetic in the kit that cannot come from the standard library.
  Reported as the `xwing-math` capability.

The kit is CommonJS on the same Node that built the emulator addon - the device
host loads that addon directly, and a mismatched ABI is not a failure worth
debugging twice.

It finds the emulator at `../../emulator` relative to its own root, with
`OKEMU_ROOT` overriding. If neither resolves it says which paths it tried.

### The firmware sources, and which copy compiles

Three source areas compose in a fixed order, and a file present in more than one
is taken from the LAST:

| | staged | holds |
|---|---|---|
| 1 | `arduino-1.6.5-r5-teensy_127/arduino-1.6.5-r5/…/cores/teensy3` | the stock Teensy 3 core |
| 2 | `OnlyKey-Firmware/*.c *.h` copied **over** it | OnlyKey's USB stack, shadowing core files |
| 3 | `libraries/` | the vendored Arduino libraries |

`emulator/scripts/stage.js` mirrors `in-docker-build.sh`, so this precedence is
the shipped build's too - it is not an emulator quirk. Nothing under `onlykey/`
is ever written to; the tree is assembled into `emulator/.stage`.

**The trap: `usb_desc.h` exists in BOTH area 1 and area 2, and only OnlyKey's
compiles.** The core copy is 356 lines, OnlyKey's is 469 and is the one carrying
the `NUM_INTERFACE` / `SEREMU_INTERFACE` blocks. Editing the core copy looks
applied - the file changes, the build succeeds - and does nothing at all. That
matters directly for the production descriptor work in
[PRODUCTION.md](PRODUCTION.md), whose whole subject is a commented-out block in
`OnlyKey-Firmware/usb_desc.h`.

The same shadowing applies to every `.c`/`.h` OnlyKey ships. Before editing a
firmware source, check whether area 2 has its own copy.

## The verdict

The exit code says what kind of problem it is without reading anything else:

| code | meaning |
|---|---|
| 0 | finished, everything passed |
| 1 | finished, at least one test failed - the only code that means the device behaved and the software did not |
| 2 | the firmware crashed |
| 3 | a watchdog fired: per-test deadline, no-progress inactivity, or run maximum |
| 4 | harness or runner error - the kit failed before it could judge anything |
| 5 | the device host died for a reason that is not the firmware's fault |

0-3 are verdicts about the device. **4 and 5 say the run did not produce a
verdict at all**, and that distinction is the whole point.

## What a run leaves behind

Every run gets its own directory under `runs/`, so nothing has to be piped or
tailed and two runs can coexist:

```
runs/<stamp>-<pid>/
  run.log             everything, timestamped
  status.json         rewritten live: section, file, test, elapsed, failures
  markers/            restart markers, one per generation
  files/<file>/       per-file device host: its storage, its markers
```

Poll `status.json` for progress. Read `run.log` afterwards. And every run ends
with exactly one sentinel line, emitted from the exit handler, the uncaught
exception handler and the unhandled rejection handler alike:

```
--- OKT-END status=finished code=0 tests=46p/0f/3s elapsed=99s reason="all tests passed" ---
```

**The absence of a sentinel means a hard crash.** That single fact, answerable
by one `grep OKT-END`, is what the old kit could never provide.

A failure block is self-contained - the pending wait, the recent device output,
the boot generation, and the device host's stderr if it died - so there is
nothing to go hunting for.

## The rung

One host setting decides how much of the device is reachable, and a run says
which one it got before it runs anything.

| `vm.mmap_min_addr` | what works |
|---|---|
| `0x0000` | everything, including `fw_hash()`. Needs `CAP_SYS_RAWIO`. Nobody should run this. |
| `0x1000` | **use this.** `certified_hw` (`0x5BB0`) is mapped so crypto works, and page zero stays unmapped so a genuine NULL dereference still faults. |
| `0x10000` | the unprivileged default. The device boots and answers HID, then segfaults the moment it encrypts anything - storing a PIN included. |

That last rung is the dangerous one: it looks like it is working right up until
the first test that stores a PIN. The runner reads the rung back and treats it
as a capability, so a run that lands there **skips the crypto files with a
stated reason** instead of reporting a pile of crashes.

## Writing a test file

One suite per file, flat, with metadata:

```js
const { describe, it } = require('../../lib/harness');

describe('unlock', { state: 'initialized', requires: ['crypto'] }, () => {
  it('unlocks with the primary PIN', async ({ device, assert, signal, skip, log }) => {
    const model = await device.unlock('1111111', { signal });
    assert.match(model, /^UNLOCKED/);
  });
});
```

Metadata:

- `state` - the device state this file needs (`blank`, `initialized`). The
  runner restores it before the file runs.
- `requires` - capability names. An unmet one skips the file **with the reason**
  rather than failing it.
- `timeoutMs` - per-test deadline for this file.

Every test receives one argument: `device`, `assert`, a `signal` that every wait
honours, `skip(reason)`, and `log`. There are no `before`/`after` hooks and there
will not be - a hook is an invisible step, and an invisible step is what makes a
wedge unattributable.

Pass `signal` to every device call. That is what makes a timeout actually cancel
the test instead of leaving it running while the runner moves on.

## The device API

```js
device.log                        the debug console as one accumulator
  .waitFor(re, {timeoutMs, signal})      matches retroactively
  .waitForCount(re, n, opts)             the firmware acks per BYTE
  .waitForAny({ok: re, err: re}, opts)   first to match, and which
  .count(re) / .clear() / .tail(n)       clearing is the CALLER's job

device.press(n, {hold})           hold: tap | hold | long | longest
device.pressLine([1,2,3])         one write - the firmware paces the replay
device.sendDebugLine('8')

device.send(iface, buf)           no report ID, no padding - adapters normalise
device.sendVendor({msg, slot, field, payload})
device.mark(iface) / device.waitHid(iface, {match, since, timeoutMs, signal})
device.keystrokes / device.waitKeystrokes(text, opts)

device.waitReady()                booted AND reading its input
device.waitResponsive()           just the second half
device.restart() / device.wipe({full})
device.waitForReboot({from})      for commands that reboot as their completion
device.status()                   {state: uninitialized|locked|unlocked, raw}
device.unlock(pin)
device.enterConfigMode(pin)       long-press 6, relock, unlock again
device.setTime()                  RAM-only, rebased every boot
device.generation / device.restarts / device.storageDir
```

## Things the firmware does that will surprise you

All measured, all load-bearing, all commented at the point that depends on them:

- **A booted device is not a listening device.** The firmware drops debug-console
  input while it is busy - it has no queue for it - and it is busy for a while
  after boot and after unlock, both of which run LED fades. `waitReady()` and
  `unlock()` probe for responsiveness; `restart()` and `wipe()` resend up to
  three times, the same number the old kit used.
- **A press that lands mid-fade is discarded.** `payload()` reads the slot, prints
  "Additional Character", then `if (isfade) return;`.
- **A locked device does not read the vendor interface at all.** `recvmsg()` is
  only reached from `if (unlocked)`. The "Error device locked" branch in the
  source is unreachable on Classic/Color hardware - it is the DUO's. Status while
  locked comes from the once-a-second `INITIALIZED` broadcast.
- **A seven-digit PIN produces six digit acknowledgements.** The seventh digit
  completes the guess and takes the branch that evaluates it instead.
- **A rejected PIN does not clear the guess buffer** until ten keys have been
  entered, so the next attempt continues the old one. Reboot between attempts.
- **CTAPHID PING is answered on any channel id**, allocated or not.
- **A backup cannot be taken in config mode.** The backup branch requires
  `!isfade`, and config mode holds the LED animation forever. Configure the
  backup key in config mode, leave it, *then* hold button 1.
- **A restore reboots as its completion**, and probing across that reboot reads
  a stale ready flag - `locked` on the emulator where it is instant,
  `unreachable` on a key where re-enumeration takes real time. Same race, two
  faces. Use `waitForReboot()`.
- **The LOCK keypress types Super+L at the host** before rebooting
  (`lock_ok_and_screen`), so on a workstation it locks your screen. It is not a
  cheaper relock than a reboot - it *ends* in `CPU_RESTART()`.

## Device state

States are defined once in `lib/fixtures/states/` with a `check()` and an
`apply()`. On the emulator, `apply()` runs once in a builder and the resulting
`flash.bin`/`eeprom.bin` are cached under `~/.cache/onlykey-testing/fixtures/`,
keyed by a fingerprint over the built firmware and the state module. Each file
then boots from a fresh copy - which is what removes the cross-contamination
that forced the old kit to be run one file at a time by hand. On hardware the
same module checks the device and runs the real setup flow, because a physical
key cannot have an image pushed into it.

```sh
node bin/okt.js fixture initialized     # build or rebuild, before a run
```

## Flashing a key

```sh
node bin/okt.js flash                   # the sibling builder's OnlyKey.cpp.hex
node bin/okt.js flash path/to.hex       # or an explicit image
```

Tap the button on the key first, so it enumerates as the HalfKay bootloader
(`16C0:0478`). The image goes out as 1089-byte reports written straight to
`/dev/hidrawN` - no node-hid, no python.

It **paces the writes**, which is the one thing it does differently from
`onlykey-usb-hid-passthrough/tools/halfkay_flash.py`, and the reason it is here
rather than borrowed. HalfKay programs a block after acknowledging the
transfer and NAKs anything arriving while it is busy; the kernel reports that
as `EPIPE`. Flashing *through* the Feather proxy never hits it, because the
proxy holds each report for up to `PROXY_OUT_BLOCK_MS` waiting for a slot - it
is the back-pressure. Attached directly there is none, and the original tool
dies a few blocks in:

```
FAILED writing block at 0x001000 (block 4): [Errno 32] Broken pipe
```

15ms between blocks fixes it and costs three seconds on a 210-block image.

Four limits of snapshot restore, none of them bugs:

- A snapshot **always boots locked**. The flags and PIN hashes are RAM, rebuilt
  in `setup()`; snapshots skip provisioning, not unlocking.
- **No attestation.** FSEC is written fresh every boot from an anonymous mapping,
  so it latches to already-provisioned and the one-time provisioning branch never
  runs: no factory key derivation, no firmware hash in EEPROM, no lock bits.
- **Time is RAM-only** and rebased every boot.
- A rebuild of the firmware invalidates the cache automatically.

## Sections

```
test/00-sanity/     built    no device at all - the kit's own oracles
test/01-protocol/   built    Node over the wire protocols
test/02-cli/        stub     the CLI through the Python venv
test/03-gui/        stub     the web app through nw.js
test/04-app/        stub     the OnlyKey app, in its own nw.js
```

The sanity section runs first and declares `device: false`, so the runner never
starts a device host for it: it checks the kit's own pure-JS oracles - CBOR, the
keystroke decoder, the vendor and CTAPHID framing, the backup format, the X-Wing
maths - against known answers, in under a second. If those disagree with their
answers, nothing the device sections go on to say can be trusted.

The admission test for section 1 is not "is this protocol-level" but **"does
this reach the device without a kernel device node"**. Sections 2-4 are not
merely deferred on a hosted runner - they are permanently impossible there.
There is no `/dev/hidraw`, so python-onlykey, lib-agent and node-hid have
nothing to open, and no display, so nothing that needs a browser runs. Their
stubs say so, with a reason, every run.

## Not built yet

- **The hardware adapter** is a declared seam with a stub behind it
  (`lib/device/hardware.js`), which documents what it has to do and why the
  emulated path is shaped the way it is.
- **The GitHub Actions workflow.** On a hosted runner it comes down to
  `sudo sysctl -w vm.mmap_min_addr=4096`, three source checkouts, building the
  addon, asserting the rung, and running section 1.
### Challenge modes, and how to use a stored key without three presses

A crypto operation on a stored or derived key normally demands a three-digit
challenge: `done_process_packets()` hashes the packet and picks
`Challenge_button1/2/3` from it, and the operation waits for all three.

Setting `stored_key_challenge_mode` (slot field 22) or
`derived_key_challenge_mode` (field 21) to **1** replaces that with a single
press of **any** button. `done_process_packets()` sets `CRYPTO_AUTH = 3` instead
of computing digits, and the press handler in `OnlyKey.ino` has a clause -
`(stored_key_challenge_mode==1 && isfade && packet_buffer_details[0])` - that
goes straight to `CRYPTO_AUTH = 4` without checking which button arrived.

**Send it as the byte `1`, not the character `'1'`.** That clause tests `== 1`
exactly. The string puts `0x31` in EEPROM, which is truthy enough for
`done_process_packets()` to take the no-digits branch - so the device primes and
appears to be waiting for one press - and then no press satisfies the clause and
the operation answers `Error incorrect challenge`.

`01-protocol/14-stored-keys.test.js` uses this to drive `OKGETPUBKEY`, `OKSIGN`
and `OKDECRYPT` against all six key types, so **crypto vectors against stored
keys are built**; the derived paths are covered by `02-cli/07-derived-xwing` and
`02-cli/15-age-file-interop`.
