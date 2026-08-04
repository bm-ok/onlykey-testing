# Plan

Stages, in the order they are worth doing. [EXPLAINER.md](EXPLAINER.md) is the
design and its reasoning; [README.md](README.md) is how to use what exists.
This file is what is left.

Counts are as of 2026-08-04, both adapters green:

| | emulated | hardware |
|---|---|---|
| sanity | 29 passed, 0 failed | same - it needs no device |
| section 1 | 68 passed, 0 failed, 3 skipped | 59 passed, 0 failed, 12 skipped-with-reason |

## Tests carried over

The old kit is `onlykey/onlykey-alpha-testing`, nineteen files driving a
physical key over USB with a human watching. This is where each one went.

The kit is a redesign, not a port, so the mapping is not one-to-one: some old
files split across several new ones, several new ones replace nothing because
the emulator made them possible for the first time, and the rest are waiting on
a section that does not exist yet.

| | old test | section | replaced by | note |
|---|---|---|---|---|
| ✅ | `00-setup` — device initial setup (SETUP-02/03/04) | protocol | `04-provisioning`, `07-unlock` | the old one skipped itself unless `ONLYKEY_CONFIRM_SETUP=yes`; the emulated device has nothing to lose, so it runs every time |
| ✅ | `09-fido2-connect` — CTAP2 handshake | protocol | `09-fido-ctaphid` | plus the locked-device case, which the old kit did not check |
| ✅ | `13-fido2-standard-ceremony` — makeCredential/getAssertion | protocol | `11-fido2-ceremony` | now with no browser and no hidapi, and the signature verified in pure JS |
| ⚠️ | `08-backup-hmac` — backup and HMAC settings (TC-13) | protocol | `10-backup-restore` | the **backup half is more than carried over**: the old kit called a full round trip untestable, and this does it. The HMAC settings half is not covered |
| ⚠️ | `12-non-pqc-regression` — slot labels, classic ECC + RSA (TC-15) | protocol | `08-slot-keyboard` | labels and slot storage covered; classic ECC and RSA key handling is not |
| ☐ | `01-pqc-keygen` — X-Wing keygen (TC-04) | cli | — | drives `age-plugin-onlykey --generate`, not the vendor protocol → **stage 3** |
| ☐ | `02-pqc-slot` — PQC slot selection (TC-06) | cli | — | `age-plugin-onlykey --generate --slot N`; two of its three cases never touch the device |
| ☐ | `03-pqc-decrypt` — X-Wing encrypt/decrypt (TC-05) | cli | — | drives `age` and `age-plugin-onlykey` |
| ☐ | `04-pqc-no-device` — decrypt with no device (TC-07) | cli | — | the *absence* of a device is the test, but it still runs the plugin binary |
| ☐ | `05-age-pqc-derived` — split custody, JS math | sanity | — | **no binaries, no device, no node-hid** — belongs in the sanity section, which now exists for exactly this |
| ⚠️ | `10-fido2-xwing-derive` — X-Wing derive over FIDO2 (TC-09/10) | protocol | `12-webauthn-tunnel` | the tunnel it rides on is built and proven on both adapters; the X-Wing derive command itself still needs its option bytes worked out |
| ☐ | `17-nodejs-composite-pgp` — composite PGP-PQC over Node FIDO2 (TC-11) | cli | — | mixed: the FIDO2 half is plane 3 and reachable now, but it also shells to `onlykey-cli` |
| ☐ | `06-lib-agent-ssh` — SSH derived-key export (TC-13) | cli | — | lib-agent finds the device through hidapi → **stage 3** |
| ☐ | `07-lib-agent-gpg` — GPG derived identity (TC-13) | cli | — | **stage 3** |
| ☐ | `11-derived-xwing-cli` — CLI derived X-Wing (TC-16/17) | cli | — | **stage 3** |
| ☐ | `14-gui-password-generator` | gui | — | drives `localhost:3000/app/password-generator`; needs a display |
| ☐ | `15-gui-age-derive` (TC-18/19) | gui | — | **stage 6** |
| ☐ | `17-nwjs-composite-pgp` (TC-11) | gui | — | **stage 6** |
| ☐ | `18-gui-encrypt-decrypt` | gui | — | drives `localhost:3000/app/encrypt` |

Sections are the kit's own: **sanity** (`test/00-sanity`, no device at all -
the kit's own oracles against known answers), **protocol** (`test/01-protocol`,
no kernel device node, the only device section CI can run), **cli**
(`test/02-cli`, onlykey-cli through the venv), **gui** (`test/03-gui`, the
onlykey.github.io web app in nw.js) and **app** (`test/04-app`, the OnlyKey
desktop app).

**Nothing maps to `app`.** The old kit never drove the desktop app either, so
section 4 is the one part of this kit with no ancestor at all — which is also
why it is last.

**5 of 19 carried over, 2 of those partially.**

The sections were checked against what each file actually EXECUTES, not what its
name suggests, and that moved five rows. The whole PQC cluster - `01`, `02`,
`03`, `04` - drives `age-plugin-onlykey` and `age` as external binaries rather
than speaking the vendor protocol, so it is **cli** work and blocked on a kernel
device node. `17-nodejs-composite-pgp` shells to `onlykey-cli` as well as using
FIDO2, so it lands there too.

What that leaves is lopsided, and worth knowing before picking anything up:

| section | open | blocked on |
|---|---|---|
| sanity | 1 | nothing - `05` is pure JS and the section is built |
| protocol | 1 (partial) | nothing - `10`'s transport is done; the derive command is not |
| cli | 8 | **stage 3** - the capability fix, then the section itself |
| gui | 4 | stage 6, and a display |

So "get all the tests over" is mostly a CLI problem, not a protocol one, and
stage 3 is the thing standing in front of eight of the fourteen.

### New tests that replaced nothing

These have no ancestor in the old kit, because a device on a real USB bus with a
human watching could not have run them:

- `00-boot`, `01-debug-console`, `02-restart`, `03-wipe` — the device lifecycle,
  and the machinery that tells an expected reboot from a crash
- `05-snapshot` — state restored from an image, which is what removed the
  cross-contamination that forced the old kit to be run one file at a time
- `06-vendor-status` — including the discovery that a locked device does not
  read the vendor interface at all
- `08-slot-keyboard` — reading back what the device TYPED, which on hardware
  needs privileged access to every keystroke on the machine
- the `wipe_slot()` null-dereference regression, for a bug the emulator found
  and hardware had hidden for years

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
- [x] A **sanity section** (`test/00-sanity`) that runs first and needs no
      device: the kit's own oracles - CBOR, the keystroke decoder, the vendor
      and CTAPHID framing, the backup format - against known answers. 21 tests
      in under a second. `device: false` in a file's metadata skips the device
      host entirely
- [ ] Port `05-age-pqc-derived`'s split-custody maths into it

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

- [x] Detect the gadget instead of assuming from the adapter name
      (`lib/gadget.js`): configfs, the UDC binding, the `/dev/hidg*` endpoints,
      and the host-side `/dev/hidraw*` split into gadget and physical
- [x] `kernel-hid` is now detected. On this machine it reports **false with the
      reason**: the gadget is bound but owned by the pm2 daemon's pid, and
      driving it would provision PINs inside the developer's own device.
      `OKT_USE_RUNNING_GADGET=yes` opts in deliberately
- [x] **The ownership decision, settled: the kit raises the gadget itself.**
      `device-host.js --gadget` starts the emulator's bridge, and a file whose
      metadata requires `kernel-hid` gets one. The isolation survives because
      the two ends are different nodes - the kit's host holds `/dev/hidg*`
      (device side) and the CLI opens `/dev/hidraw*` (host side), so they are
      not competing for the same descriptors
- [x] Refuse rather than race: the transport checks the bus is free **before**
      spawning anything, and names the owning pid
- [x] One device at a time, enforced. A gadget and a physical key on the same
      bus are indistinguishable to any client, and a WebAuthn ceremony would
      race both, so that combination is refused with that as the reason
- [x] `lib/cli.js` and a real `02-cli/00-venv.test.js`: enumeration is exactly
      one device, the state reads back through python-onlykey, and the CLI and
      section 1 must agree about the firmware version
- [ ] **Unverified live** - it has only ever been seen to skip, because this
      machine has both the daemon and a key attached. Needs one run with the
      key unplugged and the daemon stopped
- [ ] Then the rest of the CLI rows: the PQC cluster, lib-agent SSH and GPG
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
- [x] The plane-3 tunnel: `lib/device/tunnel.js` plus
      `12-webauthn-tunnel.test.js`, passing on both adapters. `OKCONNECT`
      through a fabricated `allowList` credential ID returns the device's
      X25519 handshake key and a status string that **matches what the vendor
      interface reports** - two transports, two firmware paths, one answer
- [ ] The vendor commands that ride it: `OKGETPUBKEY` answered
      INVALID_COMMAND on a first attempt, so its option bytes need working out
      from `lib/fido2/client.js`. That is what `10-fido2-xwing-derive` needs

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
