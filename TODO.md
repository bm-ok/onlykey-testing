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
- **`OKGETRESPONSE` goes early** even though it is unglamorous. Every large
  payload comes back through it, so anything else that returns more than 64
  bytes is testing it accidentally and would blame its own feature.

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
- [ ] **`age_file.js` against the real `age` binary** - PLAN puts this in
      section 2 rather than beside `03-gui/04-age-file`, because reading a file
      the real binary wrote needs the plugin, and the plugin needs a device.
      `04-age-file` already proves the web app writes a correct container; this
      is the other direction.

**The sweep, which is now the section's main work:**

- [ ] **Every `onlykey-cli` subcommand.** 36 of them, and that list is the
      checklist. Driven by visible start/stop test files at the section
      boundary, never by hooks - and, as everywhere else here, an endpoint is
      not covered by exiting 0. What it did has to be visible from a second
      place: the kit's own vendor interface reading back what the CLI wrote, or
      the device's own console saying what it received.

      Worth enumerating the subcommands and grouping them before writing
      anything, because they are not one kind of thing - some are pure reads,
      some write slot data, some need config mode, and at least one
      (self-destruct) is a capability question rather than a test.

## 2. Section 1 - the protocol surface nothing has ever touched

Highest leverage in the kit: section 1 is the only device section CI can run, so
every test that lands here runs on every push once stage 2 is enabled.

Plane 1, the vendor interface - 9 of 18 messages covered, plus two with a single
branch each:

- [ ] **`OKGETRESPONSE`** - first, for the reason at the top of this file.
- [ ] **`OKGETPUBKEY` / `OKSIGN` / `OKDECRYPT`** across the six key types
      (ed25519, P256, secp256k1, curve25519, ML-KEM-768, X-Wing). What exists
      now is the DERIVED branches only - `OKGETPUBKEY` at slot 132
      (`08-lib-agent-ssh`) and at slot 128 with `OKDECRYPT` (`07-derived-xwing`).
      Both dispatch on the slot number, so the stored-slot branches - the ones
      that read a key out of flash, where all six key types live - are still
      untouched by either message.
- [ ] **`OKPING`, `OKHMAC`, `OKWEBAUTHN`**.
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
