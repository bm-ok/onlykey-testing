# TODO

The work list. [PLAN.md](PLAN.md) is the source of truth for *why* and carries
the reasoning behind every row here; [README.md](README.md) is how to use what
exists. This file is the order to do things in, and what each one needs.

Ordered by what is unblocked and what unblocks the most, not by section number.
Two rules shaped that order:

- **The remaining pages go last.** `13-pgp-pqc` in particular - everything under
  it is proven now, so it is a page-debugging job rather than a coverage gap,
  and it is the one item here that cannot be finished without a browser in front
  of a human.
- **The large-response path went early** even though it was unglamorous, and it
  is done. Everything returning more than 64 bytes had been testing it
  accidentally and would have blamed its own feature. This used to say
  "`OKGETRESPONSE` goes early"; there is no such mechanism - see PLAN's plane 1.

**WHERE THE WORK ACTUALLY IS NOW.** Sections 1 and 2 are close to done and the
headings below still read as if they are not, because each was written when its
section was empty. What is genuinely open, in the order this file's own rule
implies:

| | what | why it is next |
|---|---|---|
| 1 | the two never-tested PINs (§3) | provisioned on every single run and exercised once, negatively |
| 2 | `loadpqc` / `loadkey` accepting paths (§1) | the last section-2 row; a wiring job, the pieces exist |
| 3 | the remaining pages (§4) | needs a browser and a human for `13-pgp-pqc` |
| 4 | section 4, the app (§5) | no ancestor anywhere; genuinely last |

**RSA key handling came off the top of this table** on 2026-08-05 →
`01-protocol/19-rsa-keys`, 7 tests in 104s, `--isolate` 7/7 and `--reverse`
green. Every key kind the firmware stores now has coverage - the six ECC
`KEYTYPE_*` values by `14-stored-keys` and RSA, which is not one of them, by this
file. And `18-gui-encrypt-decrypt`'s prerequisite is met: the pair of slots
`onlykey-pgp.js` hardcodes is loaded, used and asserted about. See §2.

**When a file lands, update its section's `last run` in [PLAN.md](PLAN.md)'s
counts table.** The emulated and hardware columns carry separate dates because
they drift apart, and a count with no date reads as current when it is not. Both
were single sweeps as of 2026-08-05; section 3 is the one most exposed to drift,
since its browser tier depends on nw.js and the onlykey.github.io checkout rather
than on anything this repo pins.

Trap that does NOT apply here, worth knowing because the old kit's notes are
full of it: slot collisions between files. `onlykey-alpha-testing` lost whole
runs to one file overwriting another's key material (its report records two in a
single day, RSA1 and RSA4), and its answer was to hand out slots. This kit boots
every file from a fresh fixture image, so files may reuse slots freely. Do not
inherit the workaround.

---

## 1. Section 2 - the `onlykey-cli` endpoint sweep (DONE bar one row)

**The carried-over rows are done.** Every row of PLAN's table that belongs to
this section now has a replacement, and per the maintainer there are no further
tests to PORT here. What section 2 is for from now on is the thing it is named
after: **the Python CLI, endpoint by endpoint**. `onlykey-cli` exposes 37
subcommands, and **all 37 are now driven** - the sweep is finished. One row is
left in this section and it is at the bottom.

The ticked rows are kept because each carries what it cost to establish, which
is the part a future reader needs.

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

**A COMMAND THAT BLOCKS ON STDIN TRIPS THE WATCHDOG, NOT ITS OWN TIMEOUT.** The
run's inactivity budget is 30s and a blocked CLI produces no device output, so a
per-command `timeoutMs` above that aborts the whole run with a watchdog message
instead of failing the test that caused it. Section 2's commands are capped at
12s and fed stdin, so an unanticipated prompt surfaces as a wrong answer rather
than a hang. Found by a 45s timeout on `credential` killing a run at 31s.

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
| 28 slot fields under `OKSETSLOT` | **WRONG twice** - `set_slot()` dispatches **29** cases, and only **16** are per-slot; the other 13 are device-wide settings. 28 is the size of python's `MessageField` enum, which is where the number came from |
| `OKFWUPDATE` can leave a key needing `okt flash` | **WRONG, and worse than stated** - it locks the bootloader and permanently converts a developer key into a production key. Maintainer's understanding, deliberately NOT verified experimentally |

Checked while writing `19-rsa-keys`, all in `libraries/onlykey`:

| claim | status |
|---|---|
| python-onlykey frames RSA-2048 as five `OKSETPRIV` chunks | verified, `client.py:563` - five slices of 114 hex characters, nine for RSA-4096 |
| `onlykey-pgp.js` needs RSA slot 1 to decrypt and slot 2 to sign | verified, `slotid()` returns `slot == OKSIGN ? 2 : 1` and adds 100 only when `is_ecc` |
| `okcrypto_rsasign()` / `okcrypto_rsadecrypt()` had never had a byte sent at them | verified - `13-large-response` writes RSA slot 1, but as `KEYTYPE_PQC_PGP`, which `okcrypto_sign()` routes to `okpqc_sign()` before the RSA branch |
| an RSA slot holds a private key | **NO** - it holds **P‖Q and nothing else**. `rsa_getpub()` multiplies the halves for N and `rsa_sign()`/`rsa_decrypt()` recompute D, DP, DQ and QP every time, **with E hardcoded to `0x10001`**. A key whose exponent is not 65537 stores fine and then signs with a D it does not have |
| RSA `type` is a key type like the ECC ones | **NO** - it is the modulus size in 128-byte units (1..4 for 1024..4096), sharing one byte with the feature flags: low nibble size, bit 5 decrypt, bit 6 sign |
| the single-press `stored_key_challenge_mode` covers only ECC slots | **NO, it covers RSA too** - `done_process_packets()` loads it when the slot is `< 5` OR 101..116, and `< 5` **is** the RSA slot range. 14-stored-keys' byte-1 trick works here unchanged |
| `OKGETPUBKEY` takes any field on an RSA slot | **NO** - `okcrypto_getpubkey()` takes the RSA branch on `buffer[5] < 5 && !buffer[6]`. Any other field falls through to the ECC branch and reads a slot that does not exist |
| the key-load and operation chunk framings are the same | **NO, and this is the trap.** The KEY going in carries the **type byte** in `buffer[6]` on all five reports and `rsa_priv_flash()` copies a fixed 57 bytes from each, counting its own way to 256 with a global offset. The OPERATION payload carries the **continuation marker** - `0xFF` while more follows, the final chunk's length on the last. Swapping them gives a 255-byte packet or "Error invalid RSA type" |
| `OKSIGN` takes any digest on an RSA slot | **NO** - exactly 28, 32, 48 or 64 bytes, and the length PICKS THE HASH: `rsa_sign()` maps them onto SHA-224/256/384/512. And it is refused AFTER the confirmation, so the press is spent on a request the device was always going to refuse |
| "RSA is the one key type of six with no coverage" | **LOOSE, and this file's own opening said it.** `okcore.h`'s `KEYTYPE_*` values are 1..6 and **all six are ECC** - ed25519, P256, secp256k1, curve25519, ML-KEM-768, X-Wing - and all six were already covered by `14-stored-keys`. RSA is a **seventh key kind outside that enum**, with its own EEPROM accessor (`okeeprom_eeget_rsakey` rather than `..._ecckey`), its own flash sector, and a "type" that means modulus size rather than algorithm. The gap was real; the arithmetic describing it was not |

`OKFWUPDATE` is the exception to "check it": it is not to be verified
experimentally, and the gate is mechanical instead - see its row below.

The slot-field count was checked and is corrected below.

## 2. Section 1 - the protocol surface, now mostly touched

Highest leverage in the kit, and not for the reason this heading used to give.
It said "the only device section CI can run, so every test that lands here runs
on every push once stage 2 is enabled" - hosted CI is parked (see Not tests), so
that is not true today. The reason that survives is better: **section 1 is the
only place a test is worth double.** Section 2 can never run against a physical
key (`client-access`) and section 3's headless tier drives the emulator by
design, so section 1 is the hardware-capable surface - everything here was run
against a real key on 2026-08-05.

Plane 1, the vendor interface - 9 of 18 messages covered, plus two with a single
branch each:

- [x] **The multi-report response path** → `01-protocol/13-large-response`,
      3 tests in 45s, `--isolate` 3/3 and `--reverse` green. NOT
      `OKGETRESPONSE`, which does not exist - see the premises table above.

      Both sizes driven and both whole: **1184 bytes / 19 reports** (ML-KEM-768
      public key, generated on the device so it is the only source of the
      answer) and **3309 / 52** (ML-DSA-65 signature, the longest response the
      device produces). Report COUNT is asserted as well as byte count - they
      say different things, and a device answering the same payload in a
      different number of reports is a change worth knowing about.

      Also the answer to "what does an unhandled vendor message id do": it is
      handed to `recv_fido_msg()` and comes back as a **CTAPHID error frame**
      `FF FF FF FF BF 00 01 0B` on the vendor interface. Not silence - the test
      expected silence and was wrong, which is the better outcome, since silence
      would have been consistent with the report being dropped.

      First file to send `OKSETPRIV` and `OKSIGN` by hand rather than through
      onlykey-cli or the web app's library.
- [x] **`OKGETPUBKEY` / `OKSIGN` / `OKDECRYPT`** across the six key types →
      `01-protocol/14-stored-keys`, 6 tests in 90s, `--isolate` 6/6 and
      `--reverse` green. Section 1, so the whole file is hardware-capable.

      Every type checked against something that is not the device: ed25519,
      nist256p1 and secp256k1 pubkeys and signatures against node:crypto,
      curve25519 against node:crypto's X25519, and the two PQC types against
      @noble's encapsulation. Signatures are also checked NOT to verify over a
      different message.

      **This clears the challenge-mode blocker** - see the row below.

      Two findings. A PQC keygen has a different completion signal from a stored
      key: handing one over answers "Successfully set ECC Key", GENERATING one
      answers with the PUBLIC KEY itself (1184 / 1216 bytes) and no text at all.
      And the key the keygen returns is asserted equal to the key read back out
      of flash after a reboot, so generation, storage and retrieval agree.
- [x] ~~**`OKPING`, `OKHMAC`, `OKWEBAUTHN`**~~ - **not testable, not defects.**
      `OKPING` has no handler and no reference anywhere. `OKHMAC` and
      `OKWEBAUTHN` are internal tags (`packet_buffer_details[0] = OKWEBAUTHN`),
      never received. Three planned tests that dissolve on inspection; see
      PLAN's plane 1 for the check.
- [x] **`OKSETPRIV` / `OKWIPEPRIV`** beyond the backup-passphrase slot - done
      without ever being a row of its own. `14-stored-keys` sends OKSETPRIV into
      an ECC slot for all six key types, `13-large-response` sends it into an RSA
      slot as a 160-byte composite blob over three chunks, and `12-cli-slots`
      drives both through `setkey`/`wipekey`. What is NOT covered is an actual
      RSA key, which is the row below.
- [x] **Slot fields** - counted properly, and mostly done. `set_slot()` has **29**
      cases: **16 per-slot** fields and **13 device-wide settings** that merely
      arrive through the same message. "28" was python's `MessageField` enum
      size, not a firmware fact.

      All 13 device settings are covered by `02-cli/11-cli-settings`. Of the 16
      per-slot fields, `02-cli/12-cli-slots` and `13-cli-lifecycle` write 14 -
      label, username, url, the three delays, the five next-key characters, the
      2FA type, the TOTP key and the password. Two are left: **case 10**
      (`YUBIAUTH`, whose EEPROM accessor is named `public_DEPRICATED`) and
      **case 29**, which has no name in any client's enum.

      Also found: cases 5, 8, 9, 10 and 29 carry cross-guards - "Error MFA
      already enabled on this slot" and its mirror - but only when
      `Duo_config[0]==1`, meaning no device PIN is set. On a provisioned key they
      never fire, which is why a slot can hold both a password and a TOTP key in
      `13-cli-lifecycle`.
- [ ] **`OKFWUPDATE` - EMULATED-ONLY, MECHANICALLY GATED, AND NOT DRIVEN PAST
      ITS INTERLOCKS.** On a physical key this needs the special bootloader, and
      running it **locks the bootloader and permanently converts a developer key
      into a production key**. That is not "needs a reflash" - the key is gone as
      a dev key. Anything that sends this message, or drives a client that could,
      carries `requires: ['emulated']` so the hardware adapter cannot reach it
      and says why it skipped. `02-cli/14-cli-fido` already does.

      **What emulation cannot cover, by design rather than by omission:** FSEC
      lives in an anonymous mapping rebuilt on every boot, so there are no lock
      bits and the bootloader-lock path is not reachable on the emulator at all.
      What is testable is the framing, the interlocks and the refusals. Test
      those. The destructive behaviour stays untested.

Plane 2, CTAP2 proper - the ceremony works; the extensions do not exist:

- [x] **`hmac-secret`** → `01-protocol/15-hmac-secret`, 6 tests in 11s,
      `--isolate` 6/6 and `--reverse` green. Entirely on the FIDO surface -
      user presence arrives as KEEPALIVE(UP_NEEDED), which is client-visible -
      so the whole file survives into a production walk.

      The properties tested are the ones the feature exists for: 32 bytes back,
      the SAME 32 for the same salt (a password manager wraps a vault key with
      them, so unreproducible means the vault is gone), a DIFFERENT secret per
      salt, and a DIFFERENT secret per credential (or one site's credential
      unwraps another's vault). Plus the negative: a credential that did not ask
      for the extension must not come back carrying it.

      `getKeyAgreement` works with **no PIN set** - `clientPin` is false and it
      still answers, because the exchange is about keeping the salt confidential
      rather than authenticating anybody. If it did not, the extension would be
      advertised and unusable.

      **The `okcore.cpp:7645` note was wrong** - see PLAN. Two unrelated
      features that share the word HMAC.
- [x] **`credProtect`** → `01-protocol/16-credprotect`, 4 tests. Ungated - no PIN
      is needed to set any level, so it runs against a key with nothing to opt
      into. All three levels echoed as themselves; level 4 is accepted but
      echoed as NOTHING rather than stored; a credential that asked for nothing
      comes back with nothing; and a level-3 credential is refused with
      NO_CREDENTIALS on a device that cannot verify a user, which is the one
      thing level 3 is for.
- [x] **Resident keys** → `01-protocol/17-resident-keys`, 4 tests. Ungated.
      Discoverable with an empty allowList, the user handle comes back,
      non-resident credentials are correctly INVISIBLE to an empty allowList
      (or any site could enumerate the key), two users at one rpId report
      `numberOfCredentials: 2` and `GET_NEXT_ASSERTION` walks them, and a bare
      GET_NEXT_ASSERTION is refused. Every test uses its own rpId - resident
      credentials persist for the whole file, so a shared one would let an
      earlier test answer a later one's question.
- [x] **`credMgmt`, `CLIENT_PIN`, `RESET`** → `01-protocol/18-clientpin-credmgmt`,
      5 tests, gated on **`fido-reset`**.

      **The chain was verified before the file was written**, since three rows
      here have dissolved on inspection: `clientPin: false` means SUPPORTED BUT
      NOT SET - the option would be absent if PINs were unsupported - so
      credMgmt is reachable behind `setPin` -> `getPinToken` -> pinUvAuthParam,
      and both `0x0A` and the `0x41` FIDO_2_1_PRE alias answer.

      Two firmware behaviours worth knowing, both found by `--reverse`:
      a client PIN **cannot be unset**, only reset away; and the bad-pinAuth
      budget is **3 per BOOT**, which `ctap_reset()` does NOT restore - only a
      reboot or a successful auth does. So a second bad attempt escalates from
      PIN_AUTH_INVALID to PIN_AUTH_BLOCKED. Every test therefore reboots AND
      resets before it starts.

And the two carried-over rows that came over only partly:

- [ ] **HMAC settings** - the half of old `08-backup-hmac` that
      `01-protocol/10-backup-restore` did not take. The backup half is more than
      carried over; this half is not covered at all.
- [x] **RSA key handling** - the other half of old `12-non-pqc-regression` →
      `01-protocol/19-rsa-keys`, 7 tests in 104s, first run green, `--isolate`
      7/7 and `--reverse` green. **Every key kind the firmware stores now has
      coverage** - the six ECC `KEYTYPE_*` values by `14-stored-keys` and RSA,
      which is not one of them, by this file. `18-gui-encrypt-decrypt`'s
      prerequisite is met: RSA slot 1 holds a decrypt key and slot 2 a sign key,
      the pair `onlykey-pgp.js`'s `slotid()` hardcodes.

      Every answer checked against something that is not the device. The
      modulus against OpenSSL's own N for the same key AND against P * Q
      multiplied out in BigInt; the signature verified by node:crypto against a
      public key built from **the modulus the device published**, not from the
      host's key object; the plaintext sealed by node:crypto to that same
      published modulus, so a device decrypting with the wrong key returns noise.

      Almost entirely on the vendor surface - every answer and every refusal
      arrives where a client can see it. The console is read for "Encrypted
      Buffer" only, for press timing, plus two secondary "nothing was primed"
      counts.

      The premises it corrected are in the table above and are worth reading
      before touching RSA again: the slot holds **P‖Q with E hardcoded to
      65537**, `type` is the **modulus size in 128-byte units** sharing a byte
      with the feature flags, the two chunk framings mean **different things in
      `buffer[6]`**, and the single-press challenge mode **covers RSA slots**
      because `done_process_packets()` tests `slot < 5`.

      **Two findings, one pinned as a test.** `OKSIGN` on a decrypt-only slot
      and `OKDECRYPT` on a sign-only slot are refused BY NAME and **without
      priming a confirmation**, which is the security property arriving where a
      client sees it. And the pinned one: see the OKWIPEPRIV row below.
- [x] **`OKWIPEPRIV` on an RSA slot does not clear the slot's key type** -
      pinned as it ships by `19-rsa-keys`'s last test, which is written so that
      **it fails the day this is fixed**. `rsa_priv_flash()` handles `wipe` first
      and returns before it ever reaches `okeeprom_eeset_rsakey()`, so the flash
      region is zeroed and the type byte survives in EEPROM. The ECC path has the
      opposite shape - `ecc_priv_flash()` writes the type byte unconditionally on
      the way in, so an ECC wipe records type 0 and the slot really does read as
      empty afterwards.

      What a client sees: a wiped RSA slot does NOT answer "Error no RSA Private
      Key set in this slot" the way a never-written one does.
      `okcore_flashget_RSA()` believes the stale type, decrypts 256 zero bytes
      into P and Q, multiplies them and publishes the result - so the slot goes
      on reporting a 2048-bit key that is not a key. Measured: `6cd48841…`
      where the real modulus had been.
- [ ] **DECIDE: is the RSA slot tail worth a test?** Found by reading, **not
      verified experimentally**, and it is the one thing here that wants the
      maintainer's judgement. `rsa_priv_flash()` encrypts only `keysize` bytes
      but then copies all `MAX_RSA_KEY_SIZE` (512) bytes of the
      `rsa_private_key` global into the flash sector - and that global is where
      `okcore_flashget_RSA()` decrypts keys **in place**. So storing a smaller
      key (a 1024-bit one, 128 bytes) after any larger key has been READ writes
      the previous key's **plaintext** P‖Q into flash past the encrypted region.

      Same profile key either way, so it is not a cross-user leak - it is
      unencrypted private key material at rest. Demonstrating it needs a
      1024-bit key stored after a 2048-bit read, and the only oracle is
      `flash.bin` rather than any client surface, so it would be an
      emulated-only file gated on `storage-files`. Deliberately left out of
      `19-rsa-keys`: the subject is the storage layout, not RSA key handling.

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

## The state the physical key was left in

Recorded because it is nowhere else and the next hardware run inherits it. On
2026-08-05 sections 0 and 1 ran against the key (`libraries@83353cf`), and three
things persist - there is no fixture restore on hardware:

- **ECC1 (slot 101)** holds the X-Wing key `14-stored-keys` generated last.
- **RSA1** holds `13-large-response`'s random 160-byte composite PQC blob. It is
  not a real key; it is seeds, and it will sign and decrypt happily.
- **`stored_key_challenge_mode` = 1**, which is the one that changes the key's
  security posture: every stored-key crypto operation now takes ONE press of any
  button instead of a three-digit challenge. `14-stored-keys` sets it and does
  not restore it.

Undoing the last one means entering config mode and writing slot field 22 back
to `0` **as the byte, not the character** - see README, "Challenge modes". The
first two are overwritten by whatever runs next.

Not left behind: no FIDO2 client PIN. `18-clientpin-credmgmt` sets one, but it
requires `fido-reset`, which is false on hardware unless somebody opts in - so
that file skipped and never touched the key.

## Order debt, the other direction

- [ ] **Measure `--reverse` across the tree**, the way `--isolate` was measured
      below. It costs one ordinary run per file rather than a boot per test, so
      it is far cheaper than that pass was - but it competes with any other work
      for the device, so it wants a quiet moment. The five sweep files and
      `15-age-file-interop` are green reversed; nothing else has been checked.

## Isolation debt

Measured 2026-08-05 with `okt run <file> --isolate` across the tree:
**41 files, 239 tests - 18 files pass, 23 fail, 155/239 tests (65%) stand alone.**
(`19-rsa-keys` is the +1 file and +7 tests, passing its gate as a new file must.)

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
| `01-protocol` | 4/14 | 45/75 |
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

- [ ] **Stage 2, CI - PARKED DELIBERATELY, not abandoned.** The workflow exists,
      is `workflow_dispatch` only, and has still never run on GitHub. Do not
      dispatch it and do not add push/PR triggers for now.

      **Why it is parked:** hosted CI is being re-envisioned once the
      local/developer-station side settles. A Raspberry Pi bridge could let a
      SELF-HOSTED runner reach a real device node - which would put sections 2,
      3 and 4 in reach of automation, and those are permanently impossible on a
      hosted runner. That is a different workflow with a different shape, not
      this one plus triggers, so building this one out further would be work
      thrown away.

      **What is already done and stays done.** Four defects were found by
      simulating every step against a clean tree and are fixed in the file
      (`1349aca`): the emulator repo name was wrong; `npm install` cannot work
      in `emulator/` because `"gypfile": true` runs node-gyp before
      `scripts/stage.js` generates the `sources.gypi` that `binding.gyp`
      includes; `npm run build` has no configure step; and the Teensy core -
      one of the FOUR trees `stage.js` requires - was never checked out at all.
      With those fixed the addon builds from a clean tree locally.

      **What is still unverified** is everything GitHub-specific: the runner
      image, the sysctl, the sparse checkout resolving, the artifact upload.

      **And note it cannot be dispatched from this workstation**, which is a
      practical fact rather than part of the decision: there is no `gh` binary,
      no `GH_TOKEN`/`GITHUB_TOKEN`, and no git credential helper. Dispatching
      means the Actions tab, or installing `gh` first. That is why the four
      defects were found by simulating the steps locally against a clean tree
      rather than by watching a run fail.

      Whatever replaces this must keep the two assertions the file already
      makes, since both fail in ways that do not look like themselves: the mmap
      rung (`vm.mmap_min_addr=4096`) and the `xwing-math` capability, BEFORE
      running anything. At the unprivileged default the device boots and answers
      HID and only segfaults once something encrypts; and a missing optional
      package skips a file with a reason and goes green, which is exactly how a
      test stops existing without anyone noticing.
- [ ] **Track `package-lock.json`?** Currently gitignored, with four declared
      optional dependencies - `node-hid` and three `@noble` packages, the last of
      which is cryptographic maths the suite checks itself against.
- [x] **Crypto vectors against derived and stored keys** - the challenge-mode
      configuration is worked out, and it is two facts:

      1. **`stored_key_challenge_mode` = 1 turns the three-digit challenge into a
         single press of ANY button.** `done_process_packets()` sets
         `CRYPTO_AUTH = 3` instead of computing the digits, and the press handler
         in `OnlyKey.ino` has a clause - `(stored_key_challenge_mode==1 && isfade
         && packet_buffer_details[0])` - that goes straight to `CRYPTO_AUTH = 4`
         without checking which button was pressed. `derived_key_challenge_mode`
         has the identical clause.
      2. **It must be sent as the BYTE 1, not the character `'1'`.** The clause
         tests `== 1` exactly. The string puts 0x31 in EEPROM, which is truthy
         enough for `done_process_packets()` to set `CRYPTO_AUTH = 3` - so the
         device primes and looks like it is waiting for one press - and then no
         press satisfies the clause and the operation answers "Error incorrect
         challenge". That is almost certainly why the row read as unworkable.

      Worth knowing: `03-gui/02-derive` sets the DERIVED mode with `String(8)` =
      0x38, and it works only because the tunnelled path tests
      `is_bit_set(mode, 3)` and 0x38 happens to have bit 3 set. Right by
      accident, and it would not survive being changed to another value.
- [ ] **Backup typing takes ~46s** at the default TYPESPEED. Setting a faster
      type speed before the backup would roughly halve the longest test.
- [ ] **Fold the flasher's pacing back** into
      `onlykey-usb-hid-passthrough/tools/halfkay_flash.py` if direct-attached
      flashing becomes routine there too. The kit has its own copy; the original
      still dies at block 4 without a proxy.
