# TODO

The work list. [PLAN.md](PLAN.md) is the source of truth for *why* and carries
the reasoning behind every row here; [README.md](README.md) is how to use what
exists. This file is the order to do things in, and what each one needs.

Ordered by what is unblocked and what unblocks the most, not by section number.
The two rules that shaped it:

- **The remaining pages go last.** `13-pgp-pqc` in particular - everything under
  it is proven now, so it is a page-debugging job rather than a coverage gap,
  and it is the one item here that cannot be finished without a browser in front
  of a human.
- **The large-response path goes early** even though it is unglamorous.
  Everything returning more than 64 bytes is testing it accidentally and would
  blame its own feature. This used to say "`OKGETRESPONSE` goes early"; there is
  no such mechanism - see the row below and PLAN's plane 1.

Trap that does NOT apply here, worth knowing because the old kit's notes are
full of it: slot collisions between files. `onlykey-alpha-testing` lost whole
runs to one file overwriting another's key material (its report records two in a
single day, RSA1 and RSA4), and its answer was to hand out slots. This kit boots
every file from a fresh fixture image, so files may reuse slots freely. Do not
inherit the workaround.

---

## 1. Section 2 - the `onlykey-cli` endpoint sweep

**The carried-over rows are done.** Every row of PLAN's table that belongs to
this section now has a replacement, and per the maintainer there are no further
tests to PORT here. What section 2 is for from now on is the thing it is named
after: **the Python CLI, endpoint by endpoint**. `onlykey-cli` exposes 36
subcommands and that list is the checklist - the sweep below is the section's
body, not a leftover.

The four ticked rows are kept because each one carries what it cost to
establish, and that is the part a future reader needs.

- [x] **`11-derived-xwing-cli`** (TC-16/17) → `02-cli/07-derived-xwing`, 7 tests
      in 9s. No button press and no `derivedkeymode` setup: the raw-HID branch
      has no `CRYPTO_AUTH` gate and bit 3 is checked only on the tunnelled path
      in `fido2/ok_extension.cpp`. Both facts are asserted rather than assumed -
      the tests count the device's own priming marker and require it not to
      move, so a firmware change that started demanding a confirmation reads as
      a sentence instead of a timeout.
- [x] **`06-lib-agent-ssh`** (TC-13) → `02-cli/08-lib-agent-ssh`, 7 tests in 7s.
      Three oracles on one key - lib-agent over hidapi, the kit over the
      in-process vendor interface, and node:crypto deriving the public half from
      the seed the firmware prints. "No device state changed" is asserted, not
      described: zero button challenges and zero flash sector erases across the
      file. Note the number - the row is named for the OLD kit's file; this
      kit's next free number was 08.
- [x] **`07-lib-agent-gpg`** (TC-13) → `02-cli/09-lib-agent-gpg`, 9 tests in 6s.
      The first lib-agent test that SIGNS - twice, each behind its own button
      challenge - so the first that needs `lib/pqc.js`. Both derived keys
      (ed25519 to sign, curve25519 to decrypt) checked against the kit's own,
      and the digits lib-agent prints checked against the packet the device says
      it received, which is what proves the multi-report send arrived intact.
      Three traps it turned up are in PLAN: `init` needs the venv on **PATH**,
      it leaves a **daemon running**, and **`gpgconf --kill all` hangs** on it.
- [x] **`age_file.js` against the real `age` binary** → `02-cli/15-age-file-interop`,
      4 tests in 8s, `--isolate` 4/4 and `--reverse` green. BOTH directions, not
      just the one this row asked for: real `age` writes and `age_file.js` reads
      it, and `age_file.js` writes and real `age` reads it. A reader and a writer
      can be wrong in opposite ways and still pass one direction each.

      Cheap because the device half goes over RAW HID rather than the tunnel -
      the derived X-Wing branch has no `CRYPTO_AUTH` gate and does not check
      `derivedkeymode`, so no button, no config mode, no setup. It is also the
      first time the KIT sends the derived pair itself: `OKGETPUBKEY` slot 128
      with `KEYTYPE_XWING`, and `OKDECRYPT` slot 128 as TWO reports with the
      continuation marker in `buffer[6]` - the framing that used to be broken.

      The kit's recipient is asserted equal to the plugin's for the same label,
      so a later failure cannot be a silent key mismatch wearing a format
      failure's clothes.

      Failure KINDS separated on a real container, which `04-age-file` could not
      do: a corrupted sealed file key fails as an AEAD tag inside `openFileKey`
      and never reaches the MAC check, because the MAC cannot be computed until
      the file key is recovered. Only editing the MAC line itself reaches it.
      The first version of this test had that backwards.

**The sweep, which is now the section's main work.**

`onlykey-cli` exposes **37** subcommands. Before this, section 2 had run exactly
ONE of them - `setpqc`, and only as a way of loading a key for something else to
test. Everything else in the section drives `age-plugin-onlykey`, `onlykey-agent`,
`onlykey-gpg` or python-onlykey's library directly, so the CLI itself - the thing
a person actually types - was almost entirely untested.

Five files, split by what an endpoint COSTS rather than by help-text order.
**An endpoint is not covered by exiting 0**: several of these print a help line
and exit 0 when they dislike their arguments, so what the command did has to be
visible from a second place - the kit's own vendor interface reading back what
the CLI wrote, or the device's console saying what it received.

**`--isolate` AND `--reverse` ARE BOTH GATES FOR EVERY NEW FILE.** A file does
not land until `okt run <file> --isolate` and `okt run <file> --reverse` are
both green. They catch opposite faults and neither substitutes for the other:

| fault | fails when | caught by |
|---|---|---|
| the test DEPENDS on an earlier one | run alone | `--isolate` |
| the test is BROKEN BY an earlier one | something runs before it | `--reverse` |

Four times in this sweep a test was made wrong by what ran before it, and
`--isolate` caught none of them - three were caught by the natural order and one
by `--reverse` on its first use (`13-cli-lifecycle`'s `password`, which cannot
type while a predecessor has left config mode on). `--reverse` costs one
ordinary run, not a boot per test. A single endpoint has to be
debuggable on its own with `okt run <file> --test <name>`, which only works if
no test depends on what an earlier one did - so each test brings the device to
the state it needs itself, through `device.ensureUnlocked()`, the idempotent
form of `unlock()` (which cannot be called twice: it PRESSES the PIN digits, and
on an unlocked device those are slot presses).

**Every `it()` name must contain the literal endpoint it covers**, so that
`--test getlabels` selects exactly one test. That is what makes the gate worth
having rather than merely true.

**Every test says which surface it asserts on.** A production key ships without
SEREMU, so any assertion that reads the debug console cannot run in a future
production walk, while the keyboard, vendor and FIDO surfaces can - see
[PRODUCTION.md](PRODUCTION.md). Where an assertion can be made on a
client-visible surface without weakening it, make it there. Where the console is
genuinely the only oracle - counting button challenges, flash erase counts,
which SLOT a write went to - use it and say so. The words, so the split is
greppable rather than discovered later:

```
/* SURFACE: vendor - survives into a production walk. */
/* SURFACE: console - does NOT survive a production walk, and is used here
 * because <the reason nothing client-visible can answer this>. */
```

Existing files that fail the gate are **debt, tracked below, retrofitted
opportunistically** - the sweep is worth more than a clean isolation record. See
"Isolation debt" under Not tests.

- [x] **`10-cli-reads`** - `version` `fwversion` `getlabels` `getkeylabels`
      `ping` `rng`. 7 tests in 10s, first run green. The version is checked
      against what section 1's own unlock reported, the labels against a slot
      this kit wrote over the vendor interface, the RNG against a second call.
      Two findings worth carrying forward: **the CLI is not one program** -
      `ping` and `rng` hand off to `solo.cli.key()` and reach the device over
      FIDO, so they fail in a different language than the rest - and
      `getlabels` picks its slot layout with `okversion[19] == 'c'`, a fixed
      INDEX into the model string, which lands on the hardware-variant
      character only for a version string of exactly this length.
- [x] **`11-cli-settings`** - 13 endpoints, 13 tests in 53s, `--isolate` 13/13.
      `2ndprofilemode` `backupkeymode` `derivedkeymode` `hmackeymode`
      `storedkeymode` `idletimeout` `keylayout` `keytypespeed` `ledbrightness`
      `lockbutton` `sysadminmode` `touchsense` `wipemode`.

      **Entirely on the vendor surface bar one assertion**, because the firmware
      acknowledges every one of these BY NAME - "Successfully set keyboard
      layout" is a different string from "Successfully set typespeed" - so the
      acknowledgement identifies the field without a debug line. The refusals
      are equally specific, and "Error not in config mode" IS the security
      property arriving where an attacker would see it.

      `backuppassphrase` moved to `13-cli-lifecycle`: it reads stdin with
      prompt_toolkit and goes out as OKSETPRIV, so it is neither argv-driven nor
      a setslot.

      Three findings. **`onlykey-cli` exits 0 when the device refuses** - all
      seven refusals here return 0 with an error on stdout, which is this
      section's "exit code is not coverage" rule demonstrated rather than
      asserted. **Config mode is sticky and has no exit but a reboot**, and
      `wipemode`/`backupkeymode` do not merely need it, they SUCCEED inside it -
      so a predecessor entering config mode inverts their assertion rather than
      erroring. **--isolate does not catch that class**: those tests pass alone,
      they are broken by a predecessor rather than dependent on one. Establishing
      the state you assert about is the rule that covers both directions.
- [x] **`12-cli-slots`** - 8 endpoints, 8 tests in 89s, `--isolate` 8/8. Also
      closes most of section 1's "slot fields beyond LABEL and PASSWORD" row
      below: 13 of the CLI's 17 `setslot` field types are now written and each
      acknowledged in its own words. The remaining four - `password`, `gkey`,
      `totpkey` - read stdin with prompt_toolkit and moved to `13-cli-lifecycle`.

      Entirely on the vendor surface, console needed for nothing. The strongest
      assertion stores RFC 8032's published seed with `setkey` and reads the
      PUBLIC key back with OKGETPUBKEY, checking it against node:crypto - an
      acknowledgement says a write was accepted, this says the right bytes
      arrived.

      **`setpqc` reports success for a load the device refused** - three
      "Error not in config mode" replies, and the CLI prints "Loaded composite
      PQC PGP key (160 bytes) into RSA1" and exits 0 without reading them. A
      client fault, not a firmware one; the load path itself is fine, as
      05-composite-load shows from inside config mode.

      Two more surprises, both pinned as they ship: **OKWIPEPRIV says "Error
      device locked" on an unlocked device** that is merely not in config mode,
      where its neighbour OKSETPRIV says "Error not in config mode"; and
      **OKGETPUBKEY is REFUSED in config mode**, printing to the console with no
      vendor reply at all, so a client that writes a key and reads it back in one
      session sees the read time out with nothing to explain it.
- [ ] **`loadpqc` / `loadkey` accepting paths.** `12-cli-slots` drives only
      their rejecting path - the file-parse half needs a composite PGP key file
      and an OpenPGP private key respectively, which that file would have to
      generate. `03-gui/06-composite-key` already generates the first through the
      web app's own library, so the pieces exist; it is a wiring job.
- [x] **`13-cli-lifecycle`** - 7 endpoints, 7 tests in 67s, `--isolate` 7/7.
      `settime` `password` `totpkey` `gkey` `backuppassphrase` `restore` `init`.

      **Regrouped**: `set-pin` `change-pin` `reset` `wink` moved to
      `14-cli-fido`. None of them is an OnlyKey command - cli.py hands all four
      to `solo.cli.key()`, so they reach the device over FIDO, and `set-pin`
      sets the FIDO2 CLIENT PIN rather than the device PIN its name suggests.
      The five-file split is unchanged; only which file they live in.

      prompt_toolkit drives from a pipe - it warns and redraws oddly in captured
      output, but the value arrives intact, so `input:` on `cli.run()` is enough
      and no pty is needed.

      Best assertion in the sweep is here and is on the KEYBOARD surface: a
      password written by the command line is read back by pressing the button
      and decoding what the device types. Every other test in the sweep checks
      that a write was ACCEPTED; this checks the secret that comes out is the
      one that went in.

      **`init` is silent on a set-up device until config mode, then re-arms the
      PIN machine** - and prints exactly the same script either way, exiting 0.
      One of those two outcomes is a key an Enter-and-six-presses away from a
      replaced PIN, and nothing in the output says which just happened.

      `backuppassphrase` is length-checked host-side (>= 25 characters) before
      anything reaches the wire, which is the right shape - a weak backup
      passphrase is what would make an exported backup worth stealing.

      `gkey` and `totpkey` are indistinguishable on any client surface: one
      base32-decodes and the other does not, and the device acknowledges both
      with "Successfully set 2FA Key". Telling them apart needs a TOTP code
      checked against a host computation, which is the deferred challenge-mode
      work in PLAN's loose ends.
- [x] **`14-cli-fido`** - 6 endpoints, 6 tests in 22s, `--isolate` 6/6.
      `wink` `credential` `set-pin` `change-pin` `reset` `loadfirmware`.

      **The sweep is complete: 37 of 37 subcommands are now driven.**

      Nothing here flashes firmware and nothing resets the authenticator. Both
      are driven exactly as far as their confirmation prompts, which is the part
      worth testing: the assertion is that NEITHER interface carries anything
      while the guard holds.

      **`credential`, `set-pin` and `change-pin` are broken by a host dependency**
      - `AttributeError: 'Fido2Client' object has no attribute 'client_pin'`,
      solo calling an API the installed python-fido2 no longer exposes. The
      device answers; the client cannot use the answer. `set-pin` then EXITS 0
      while printing the error, so a script checking exit codes is told a PIN
      was set when none was. Worth deciding whether to pin the venv's `solo` and
      `fido2` back into step - see the row under Not tests.

## Premises worth checking before picking a row up

`OKGETRESPONSE` cost an hour whenever it came up because the row asserted a
firmware mechanism that does not exist, and nothing in the row said whether
anybody had looked. So: **rows that rest on a claim about the firmware say
whether the claim has been verified.**

Checked while correcting that one:

| claim | status |
|---|---|
| `OKGETRESPONSE` returns large payloads | **FALSE** - no handler, no references |
| `OKPING` is a live message | **FALSE** - no handler, no references |
| `OKHMAC` / `OKWEBAUTHN` are live messages | **FALSE** - internal tags only |
| "eighteen live message types" | **wrong** - fourteen are dispatched |
| CTAP2 implements MakeCredential, GetAssertion, GetInfo, ClientPIN, Reset, GetNextAssertion, Cancel, CredMgmt | verified, all in `fido2/ctap.cpp` |
| `hmac-secret` and `credProtect` are advertised | verified, in `ctap.cpp` / `ctap_parse.cpp` |
| the derived branches have no `CRYPTO_AUTH` gate | verified, and asserted by `07-derived-xwing` and `15-age-file-interop` |
| 28 slot fields under `OKSETSLOT` | **UNVERIFIED** - the CLI reaches 17 of them; where 28 came from is not recorded |
| `OKFWUPDATE` can leave a key needing `okt flash` | **UNVERIFIED** - never driven past its confirmation prompt, deliberately |

The two marked UNVERIFIED are left as they are rather than chased now. Neither
blocks anything; both should be checked before a row is written against them.

## 2. Section 1 - the protocol surface nothing has ever touched

Highest leverage in the kit: section 1 is the only device section CI can run, so
every test that lands here runs on every push once stage 2 is enabled.

Plane 1, the vendor interface - 9 of 18 messages covered, plus two with a single
branch each:

- [ ] **The multi-report response path**, first, for the reason at the top of
      this file - and NOT `OKGETRESPONSE`, which does not exist. That row sat
      here across several sessions on a premise nobody had checked: `okcore.h`
      defines the id, no dispatcher case handles it, no `.cpp` references it,
      and every client has it commented out or absent. Large responses come back
      as unsolicited consecutive 64-byte reports from `send_transport_response()`.

      What to test instead: drive a large VENDOR response directly and assert it
      arrives whole and in order. 1184 bytes (ML-KEM-768 public key, 19 reports)
      and 3309 (ML-DSA-65 signature, 52 reports). The long one matters more - the
      recorded failure was `RawHID.send2` returning 0 on a full TX queue with the
      result unchecked, silently dropping a chunk, which is likelier at the
      extreme than in the middle.

      Plus: an unrecognised vendor message id falls to the dispatcher's
      `default:` and is handed to `recv_fido_msg()`. Worth pinning; it is the
      kind of thing that changes silently.
- [ ] **`OKGETPUBKEY` / `OKSIGN` / `OKDECRYPT`** across the six key types
      (ed25519, P256, secp256k1, curve25519, ML-KEM-768, X-Wing). What exists
      now is the DERIVED branches only - `OKGETPUBKEY` at slot 132
      (`08-lib-agent-ssh`) and at slot 128 with `OKDECRYPT` (`07-derived-xwing`).
      Both dispatch on the slot number, so the stored-slot branches - the ones
      that read a key out of flash, where all six key types live - are still
      untouched by either message.
- [x] ~~**`OKPING`, `OKHMAC`, `OKWEBAUTHN`**~~ - **not testable, not defects.**
      `OKPING` has no handler and no reference anywhere. `OKHMAC` and
      `OKWEBAUTHN` are internal tags (`packet_buffer_details[0] = OKWEBAUTHN`),
      never received. Three planned tests that dissolve on inspection; see
      PLAN's plane 1 for the check.
- [ ] **`OKSETPRIV` / `OKWIPEPRIV`** beyond the backup-passphrase slot.
- [ ] **Slot fields beyond `LABEL` and `PASSWORD`** - 2 of 28 are written today.
      TOTP keys, the delay and next-key chaining, wipe mode, key layout, type
      speed, the challenge modes.
- [ ] **`OKFWUPDATE` last, and probably emulated-only** - it is the one message
      that can leave a physical key needing `okt flash`.

Plane 2, CTAP2 proper - the ceremony works; the extensions do not exist:

- [ ] **`hmac-secret`** - the extension this firmware advertises and nothing
      exercises. Also the only thing that would reach the unproven
      null-dereference patch at `okcore.cpp:7645`.
- [ ] **`credProtect`** - the other advertised extension.
- [ ] **Resident keys** (`rk` is true), **`credMgmt`**, **`CLIENT_PIN`**,
      **`RESET`**.

And the two carried-over rows that came over only partly:

- [ ] **HMAC settings** - the half of old `08-backup-hmac` that
      `01-protocol/10-backup-restore` did not take. The backup half is more than
      carried over; this half is not covered at all.
- [ ] **Classic ECC and RSA key handling** - the half of old
      `12-non-pqc-regression` that `08-slot-keyboard` did not take. Labels and
      slot storage are covered; the key handling is not. This is also the
      prerequisite for the encrypt/decrypt pages below, which need a classic RSA
      key in RSA slots 1 and 2.

## 3. The PINs provisioned every run and never tested

`PINS.secondary` and `PINS.selfDestruct` appear once each, both as *negative*
assertions in `07-unlock`.

- [ ] **Second profile** - unlock into it, confirm it is a different profile with
      different slot data, and confirm it cannot see profile 1's.
- [ ] **Self-destruct** - emulated only. It factory-resets, which on a physical
      key means a reflash, so gate it on a capability that says exactly that.

## 4. Section 3 - the pages that are left

Every feature these call is already proven at the library level, so a failure
here means the PAGE. That is the whole reason the tiers are split.

Two things that are not optional for any of them, both already measured:

- **Serve from `localhost`, never `127.0.0.1`.** WebAuthn refuses an IP as an
  rpId, the pages swallow the error, and the only symptom is an output box that
  never fills. The RPID is also folded into the derivation, so any cross-check
  must ask the kit for the same rpId the browser will use.
- **Device up and unlocked before any page opens.** A page whose startup
  `OKCONNECT` times out makes Chromium raise a NATIVE WebAuthn dialog that no
  CDP command can dismiss, and the session is wedged until restarted. The
  landing page in `tools/nwjs` makes no device call, which is what makes it safe
  to start on.

- [ ] **`18-gui-encrypt-decrypt`** - the classic (non-PQC) PGP pages,
      `/app/encrypt` and `/app/decrypt`, which no kit has driven. Split it the
      way the old one did: of the encrypt page's three modes only **Encrypt
      Only** avoids the device entirely, so that half runs with nothing plugged
      in and is the cheapest possible "did we break encrypt" check. Sign Only,
      Encrypt and Sign, and both decrypt modes call `OKSIGN`/`OKDECRYPT` against
      **RSA slot 1 (decrypt) and slot 2 (sign)**, hardcoded in
      `onlykey-pgp.js`'s `slotid()` - so that half needs the classic RSA key
      handling above.
- [ ] **`13-pgp-pqc`** - LAST, by decision. Working copy is
      [wip/13-pgp-pqc.test.js](wip/13-pgp-pqc.test.js), which the runner does
      not glob. Everything beneath it is now proven headless by
      `02-cli/06-composite-ops`, so this is page debugging, not coverage. Start
      by instrumenting the page: it already publishes
      `window.__pgpPqcTestHooks` with the live `ok` transport, so wrapping
      `ok.composite_decrypt` over CDP records every device call, and the two
      halves are told apart by argument size alone - 32 bytes is `hooks.ecdh`,
      1088 is `hooks.mlkemDecaps`. See PLAN.md's pgp-pqc block for the rest.

## 5. Section 4 - the OnlyKey app

- [ ] **Never driven from a harness at all**, by this kit or the old one. The
      one part with no ancestor, which is why it is last.

---

## Order debt, the other direction

- [ ] **Measure `--reverse` across the tree**, the way `--isolate` was measured
      below. It costs one ordinary run per file rather than a boot per test, so
      it is far cheaper than that pass was - but it competes with any other work
      for the device, so it wants a quiet moment. The five sweep files and
      `15-age-file-interop` are green reversed; nothing else has been checked.

## Isolation debt

Measured 2026-08-05 with `okt run <file> --isolate` across the tree:
**40 files, 232 tests - 17 files pass, 23 fail, 148/232 tests (64%) stand alone.**

Retrofitted **opportunistically**, when a file is being worked on for another
reason. Not a project of its own: the sweep is worth more than a clean
isolation record. `--isolate` is a gate for NEW files only.

The pattern is the same everywhere: test 1 establishes something - an unlock, a
registered credential, a generated key, a written slot - and tests 2..n assert
about it. `device.ensureUnlocked()` fixes the unlock half cheaply; the rest
means each test redoing the establishing step, which is sometimes right and
sometimes changes what the file is testing.

| section | files pass/total | tests alone |
|---|---|---|
| `00-sanity` | **7/7** | 50/50 |
| `01-protocol` | 3/13 | 38/68 |
| `02-cli` | 4/11 | 33/64 |
| `03-gui` headless | 3/8 | 26/49 |
| `04-app` | 1/1 | 1/1 |

Sanity is clean because those files are `device: false` - there is no device
state to inherit. Files that fail, worst first:

| file | alone |
|---|---|
| `01-protocol/08-slot-keyboard` | 1/6 |
| `01-protocol/11-fido2-ceremony` | 1/6 |
| `01-protocol/12-webauthn-tunnel` | 1/6 |
| `02-cli/03-pqc-decrypt` | 1/6 |
| `02-cli/06-composite-ops` | 1/7 |
| `02-cli/07-derived-xwing` | 1/7 |
| `03-gui/03-xwing-derive` | 1/6 |
| `03-gui/07-pgp-keys` | 1/6 |
| `01-protocol/09-fido-ctaphid` | 2/4 |
| `01-protocol/02-restart` | 2/4 |
| `02-cli/04-pqc-no-device` | 2/5 |
| `02-cli/05-composite-load` | 2/4 |
| `02-cli/08-lib-agent-ssh` | 2/7 |
| `03-gui/00-fido2-lib` | 2/6 |
| `03-gui/02-derive` | 2/6 |
| `03-gui/06-composite-key` | 2/5 |
| `01-protocol/10-backup-restore` | 3/9 |
| `01-protocol/03-wipe` | 3/5 |
| `01-protocol/04-provisioning` | 3/4 |
| `01-protocol/07-unlock` | 3/4 |
| `02-cli/01-pqc-keygen` | 3/5 |
| `02-cli/09-lib-agent-gpg` | 5/9 |
| `01-protocol/01-debug-console` | 5/6 |

**`03-gui/10-session`, `11`, `12`, `19-stop` (22 tests) are not in the tally and
are not debt.** They are structurally non-isolatable BY DESIGN: `10-session`
starts nw.js and the express server and `19-stop` stops them, which is the
kit's no-hooks rule working as intended. Running `--isolate` over them would
start a browser and a server with nothing to stop them and orphan both, so it
was not run rather than run and cleaned up after.

Two files are deliberate rather than lazy even within the tally: the lib-agent
pair and the composite PGP files are built around ONE long operation with
several assertions about it. Re-running `onlykey-gpg init` per assertion would
test something different from what the file is for.

## The venv's solo / python-fido2 mismatch

- [ ] **Decide whether to pin them back into step.** `credential`, `set-pin` and
      `change-pin` all fail inside `solo` with `'Fido2Client' object has no
      attribute 'client_pin'` - solo calls an API the installed python-fido2 has
      removed. `wink` works, so the transport and the device are fine; it is
      purely the PIN-token path. `02-cli/14-cli-fido` asserts the current
      behaviour, so whichever way this is resolved that file will need its
      assertions updated - deliberately, since a test whose subject is a known
      breakage should fail when the breakage is fixed.

## Not tests

Tracked here so they do not get lost, but they are not coverage.

- [ ] **Stage 2, CI.** The workflow exists, is `workflow_dispatch` only, and is
      **untested**. Do not enable it without a manual run first. It must assert
      the mmap rung (`vm.mmap_min_addr=4096`) and the `xwing-math` capability
      *before* running anything - at the unprivileged default the device boots
      and answers HID and only segfaults once something encrypts, and a missing
      optional package would skip a file with a reason and go green, which is
      exactly how a test stops existing without anyone noticing.
- [ ] **Track `package-lock.json`?** Currently gitignored, with four declared
      optional dependencies - `node-hid` and three `@noble` packages, the last of
      which is cryptographic maths the suite checks itself against.
- [ ] **Crypto vectors against derived and stored keys** - dropped from the first
      cut because those paths need challenge-mode configuration that has not been
      worked out.
- [ ] **Backup typing takes ~46s** at the default TYPESPEED. Setting a faster
      type speed before the backup would roughly halve the longest test.
- [ ] **Fold the flasher's pacing back** into
      `onlykey-usb-hid-passthrough/tools/halfkay_flash.py` if direct-attached
      flashing becomes routine there too. The kit has its own copy; the original
      still dies at block 4 without a proxy.
