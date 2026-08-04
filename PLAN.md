# Plan

Stages, in the order they are worth doing. [EXPLAINER.md](EXPLAINER.md) is the
design and its reasoning; [README.md](README.md) is how to use what exists.
This file is what is left.

Counts are as of 2026-08-04, both adapters green:

| | emulated | hardware |
|---|---|---|
| section 1 | 62 passed, 0 failed, 3 skipped | 53 passed, 0 failed, 12 skipped-with-reason |

---

## Stage 0 — the kit itself ✅

- [x] Harness: real cancellation, `skip(reason)`, suite metadata, per-file
      registry clearing, fail-fast, per-test timing, a result shape that can
      represent a skip
- [x] Two-process device host, with every way it can die classified —
      expected restart, firmware crash, external/OOM kill, mapping failure
- [x] One device API, two adapters; report ID, padding and reboot-as-
      re-enumeration hidden inside the adapters
- [x] Fixtures: `blank` and `initialized`, fingerprinted image cache,
      copy-assert-rename restore
- [x] Runner and reporting: three watchdogs, six exit codes, live
      `status.json`, one sentinel line, self-contained failure blocks
- [x] Exit codes verified deliberately (0, 1, 3 both flavours, 4, 5).
      **2 is implemented but never forced** — it fired once naturally, on a
      post-provisioning boot, and classified correctly
- [x] Hardware adapter, selecting by sysfs so the emulator's gadget cannot be
      mistaken for a key
- [x] `okt flash`, paced, because HalfKay NAKs a direct-attached burst

## Stage 1 — section 1, protocol ✅

- [x] boot, debug console, restart, wipe, provisioning, snapshot, vendor
      status, unlock, slots + keyboard capture, CTAPHID transport
- [x] Backup and restore: created by the device, captured off the keyboard
      interface, verified against its own chained SHA256, restored, read back
- [x] Regression test for the `wipe_slot()` null dereference
      (`libraries@cb1197e`)
- [x] A real FIDO2 ceremony — register, authenticate, verify the signature in
      pure JS — with the CTAP2 client protocol ported off
      `@vincss-public-projects/fido2-client` and pointed at the kit's device
      handle instead of its node-hid transport

---

## The protocol surface

Determined by reading the three clients that already exist: python-onlykey's
`client.py`/`cli.py`, OnlyKey-App's `OnlyKeyComm.js`, and
`onlykey.github.io/src/onlykey-fido2`. The firmware's `okcore.h` is the
authority where they disagree, and they do: the app calls 227 `OKSETPIN2` where
the firmware calls it `OKPINSEC` and python calls it `OKSETPDPIN`.

There are **three planes**, not one, and only the first is well covered.

### Plane 1 — the vendor interface (RawHID2, usage `0xFFAB`)

Eighteen live message types. `0xE8`-`0xEB` were the U2F cert/key messages and
are removed in this firmware. This is what the CLI and the desktop app speak.

| | messages |
|---|---|
| **covered (9)** | `OKPIN` `OKPINSD` `OKPINSEC` `OKCONNECT` `OKGETLABELS` `OKSETSLOT` `OKWIPESLOT` `OKSETPRIV` `OKRESTORE` |
| **not covered (9)** | `OKGETPUBKEY` `OKSIGN` `OKWIPEPRIV` `OKDECRYPT` `OKGETRESPONSE` `OKPING` `OKFWUPDATE` `OKHMAC` `OKWEBAUTHN` |

Underneath `OKSETSLOT` sit **28 slot fields** and **6 key types** (ed25519,
P256, secp256k1, curve25519, ML-KEM-768, X-Wing). The kit writes exactly two
fields: `LABEL` and `PASSWORD`. Everything else - TOTP keys, the delay and
next-key chaining, wipe mode, key layout, type speed, the challenge modes - is
untouched.

`OKGETRESPONSE` is worth calling out on its own: it is how anything larger than
one 64-byte report comes back, so every large-payload path depends on it and
nothing tests it.

### Plane 2 — CTAP2 proper (RawHID, usage `0xF1D0`)

The firmware implements `MAKE_CREDENTIAL`, `GET_ASSERTION`, `GET_INFO`,
`CLIENT_PIN`, `RESET`, `NEXT_ASSERTION`, `CANCEL` and `CBOR_CRED_MGMT`, plus
the `hmac-secret` and `credProtect` extensions.

The kit covers `INIT` and `PING` - the transport, not the protocol. Nothing
CBOR is encoded or decoded anywhere in this repo yet.

### Plane 3 — vendor commands tunnelled through WebAuthn

The one that is easy to miss, and the one the web app actually uses.

An ordinary CTAP2 `authenticatorGetAssertion` carries a fabricated credential ID
in its `allowList`, and that credential ID *is* a vendor request:
`(cmd, opt1, opt2, opt3, data)` behind the magic bytes `0x8C 0x27`. The device
answers in the assertion's **signature** field. That is how a browser reaches
OnlyKey's vendor commands with no WebHID permission prompt.

Firmware side: `is_extension_request()`, called from three places in
`ctap.cpp` (896, 1174, 1949). Reference client:
`onlykey.github.io/src/onlykey-fido2/onlykey/onlykey-api.js`'s
`encode_ctaphid_request_as_keyhandle()` /
`decode_ctaphid_response_from_signature()`. The old kit ported both into
`onlykey-alpha-testing/lib/fido2/ctaphid.js`, driving them with
`@vincss-public-projects/fido2-client` over hidapi.

The kit covers none of it - **and it is section-1 work**, because a fabricated
GetAssertion can be written straight onto the in-process FIDO interface. It
needs no kernel device node, no browser and no fido2-client. That distinction
decides which stage it lands in.

---

## Stage 2 — continuous integration

**Why first:** EXPLAINER's opening claim is that CI *is* the reason for all of
this, and it is the last unbuilt piece of the original design. Everything it
needs is now proven on both adapters. Until it exists, the kit only runs when
somebody remembers to run it.

- [ ] `.github/workflows/` running section 1 on a stock hosted runner
- [ ] `sudo sysctl -w vm.mmap_min_addr=4096`, and **assert the rung before
      running anything** — at the unprivileged default the device boots and
      answers HID and only segfaults once something encrypts, so a run that
      lands there looks healthy right up until the first PIN
- [ ] Check out the three sources, build the addon, cache what is cacheable
- [ ] Publish the run directory as an artifact; fail the job on the exit code,
      not on log scraping
- [ ] State plainly in the workflow that sections 2-4 are *impossible* there,
      not skipped for convenience

## Stage 3 — capability detection, and section 2 for free

**Why:** `capabilities.js` hard-codes `kernel-hid: !emulated`. That is wrong
whenever the gadget bridge is up: `/dev/hidraw*` then IS the emulator, and
python-onlykey can open it. Section 2 does not need a physical key — it needs a
kernel device node, and the gadget is one. Small change, disproportionate
consequence.

- [ ] Detect the gadget (dummy_hcd + the OnlyKey descriptors) instead of
      assuming from the adapter name
- [ ] `kernel-hid` true when a node exists, whoever is behind it
- [ ] Then start section 2 against the emulator: `onlykey-cli` through the
      venv, driven by visible start/stop test files rather than hooks. The CLI
      exposes **36 subcommands** - that list is the section-2 checklist
- [ ] The old kit drove FIDO2 from Node with
      `@vincss-public-projects/fido2-client` (the `bmatusiak/FIDO2Client` fork)
      over hidapi. That route needs a kernel node, so it belongs here rather
      than in section 1 - and it is worth having *as well as* the hand-rolled
      section-1 path, because it tests what a real client does

## Stage 4 — the PINs we set every run and never test

**Why:** `PINS.secondary` and `PINS.selfDestruct` appear exactly once each in
the suite, both in `07-unlock` as *negative* assertions. Every run provisions
all three and exercises one.

- [ ] Second profile: unlock into it, confirm it is a different profile with
      different slot data, confirm it does not see profile 1's
- [ ] Self-destruct: emulated only — it factory-resets, which on a key means a
      reflash. Gate it on a capability that says exactly that

## Stage 5 — CTAP2, and the WebAuthn tunnel

**Done:** `lib/device/cbor.js` (the CTAP2 canonical subset), `lib/device/ctap2.js`
(framing, the KEEPALIVE loop, GET_INFO / MakeCredential / GetAssertion), and
`11-fido2-ceremony.test.js` — passing on **both** adapters in about five
seconds. The transport is the kit's device handle, so it needs no kernel node
and stays in section 1, which is what makes it CI-able.

- [x] A CBOR encoder/decoder small enough to read
- [x] `GET_INFO` — versions, extensions, options, AAGUID
- [x] MakeCredential with a real user-presence press, driven off the
      KEEPALIVE(UP_NEEDED) the device sends while it waits for a finger
- [x] GetAssertion against that credential, signature verified in pure JS
      against the COSE key from the registration; plus the negative, that it
      does *not* verify over a different challenge
- [x] An unknown credential id is refused
- [ ] `hmac-secret`, the extension this firmware advertises and nothing
      exercises — also the only thing that would reach the unproven
      null-dereference patch at `okcore.cpp:7645`
- [ ] `credProtect`, the other advertised extension
- [ ] Resident keys (`rk` is true), `credMgmt`, `CLIENT_PIN`, `RESET`
- [ ] The plane-3 tunnel: fabricate the `allowList` credential ID, read the
      response out of the signature field. `OKGETPUBKEY` first, whose shape the
      old kit's `lib/fido2/client.js` already proves

## Stage 5b — the rest of plane 1

**Why:** half the vendor interface has never had a byte sent at it, and the
slot fields are worse — two of twenty-eight.

- [ ] `OKGETRESPONSE` first: every large payload depends on it
- [ ] `OKGETPUBKEY` / `OKSIGN` / `OKDECRYPT` across the six key types
- [ ] `OKSETPRIV` / `OKWIPEPRIV` beyond the backup-passphrase slot
- [ ] `OKPING`, `OKHMAC`, `OKWEBAUTHN`
- [ ] Slot fields beyond label and password: TOTP, the delay and next-key
      chaining, wipe mode, key layout, type speed, the challenge modes
- [ ] `OKFWUPDATE` last, and probably emulated-only — it is the one message
      that can leave a key needing `okt flash`

## Stage 6 — the sections that need a display

- [ ] Section 3, the web app in nw.js
- [ ] Section 4, the OnlyKey app — never driven from a harness at all
- [ ] Services started and stopped by *visible* test files at the section
      boundaries, never hooks; cleanup tracks process groups, because nw.js can
      crash and orphan the server it spawned holding a port

---

## Loose ends

- [ ] Crypto vectors against derived and stored keys — dropped from the first
      cut because those paths need challenge-mode configuration that has not
      been worked out
- [ ] `package-lock.json` is gitignored, but `node-hid` is now a declared
      optional dependency; decide whether the lockfile should be tracked
- [ ] Backup typing takes ~46s at the default TYPESPEED. Setting a faster type
      speed before the backup would cut the longest test roughly in half
- [ ] Fold the flasher's pacing back into
      `onlykey-usb-hid-passthrough/tools/halfkay_flash.py` if direct-attached
      flashing becomes routine there too — the kit has its own copy, but the
      original still dies at block 4 without a proxy
