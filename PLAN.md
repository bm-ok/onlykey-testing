# Plan

Stages, in the order they are worth doing. [EXPLAINER.md](EXPLAINER.md) is the
design and its reasoning; [README.md](README.md) is how to use what exists.
This file is what is left.

Counts are as of 2026-08-04, both adapters green:

| | emulated | hardware |
|---|---|---|
| sanity | 37 passed, 0 failed | same - it needs no device |
| section 1 | 68 passed, 0 failed | 59 passed, 0 failed |
| section 2 | 23 passed, 0 failed (gadget) | skipped - `client-access`, the kit's adapter holds the nodes the CLI needs |
| section 3 | 12 passed, 0 failed (headless tier) | untried |
| **whole tree** | **140 passed** | **94 passed, 23 skipped-with-reason** |

Hardware counts are from before the PQC work; section 2 cannot run there at all,
so the only thing waiting on a key is a re-run of sections 0 and 1 against
`libraries@83353cf`, which needs a Teensy rebuild and a reflash.

## Three kits, not two

`onlykey-alpha-testing` is not the first ancestor. `onlykey-fido2` is - and it
is a **standalone library** that merely lives inside `onlykey.github.io/src/`
(also published as `github.com/bmatusiak/node-onlykey-fido2`). It is what the
web app talks to the device with, and its `test-api/` directory was the original
protocol test kit: an architect-plugin runner (`config.js`, `test_list`,
`test_onlykey`, `test_pgp`) with a `window_replacements` shim that supplies the
browser surface so the library can run under Node. Most of its cases are
commented out now and `pgp.js` is what still runs, but the shape of the idea
survived into everything after it.

| | kit | drives | transport |
|---|---|---|---|
| 1 | `onlykey-fido2/test-api` | the real library, through its own API | node-hid |
| 2 | `onlykey-alpha-testing` | the real library **and** ported copies | node-hid |
| 3 | this kit | ported copies | in-process, or node-hid |

### The library is a client to test, not a kit to adopt

**`test-api` is old and deprecated. Do not use it, do not update it** - said
plainly because a directory called `test-api` sitting next to the library will
otherwise look like something to build on. What it is good for is clues about
what was being tested, and that is worked through at the end of this section.

The library itself is a different matter. **`onlykey-fido2` is a client this kit
should TEST**, and the third one: the kit's own JS is one, python-onlykey is the
second, and this is what `onlykey.github.io` ships and therefore what every
browser user actually runs. Section 2 exists on exactly this argument - "the
point of having both is that they can disagree" - and nothing about that
argument is special to python. A firmware change that breaks the web app's
client is currently invisible to every test that exists.

It is testable from here without a browser, and both ancestors show how: supply
the small browser surface the library touches - `crypto.subtle`, `atob`/`btoa`,
`location.hostname`, `navigator.credentials.get` - and then call it the way the
app does. `test-api`'s `window_replacements` is the deprecated version of that
shim and the old kit's `lib/fido2/browser_env.js` is the maintained one; either
is worth reading, neither is worth depending on.

The one design decision worth getting right is what `navigator.credentials.get`
is pointed at. The old kit pointed it at `@vincss-public-projects/fido2-client`
over hidapi, which is why everything built on it needed a kernel device node.
Pointing it at **this kit's own `lib/device/ctap2.js`** instead needs no kernel
node and no USB at all.

**Where it goes: the front of section 3**, as its headless tier. Section 3 is
now split at the file number, and the two halves have genuinely different
requirements:

| | files | needs | runs in CI |
|---|---|---|---|
| the library, headless | `03-gui/00-09` | nothing a browser has - shim + `lib/device/ctap2.js` | yes |
| the page, in nw.js | `03-gui/10+` | `display`, and a device the page can reach | no |

Putting the library at the front rather than in section 1 is the point of it: if
the client cannot talk to the device headlessly, launching a browser to watch it
fail again explains nothing. It is the GUI section's own pre-flight. `display`
is a capability as of this change, so on a machine or runner without one the
browser files skip with a stated reason while the library files still run.

That also means the workflow's target should become `00-sanity 01-protocol
03-gui` rather than section 1 alone - the browser half will skip itself, and
saying so in the job summary is more honest than not running the section.

And it settles what `lib/device/tunnel.js` is for. It is a port of
`onlykey-api.js`'s `encode_ctaphid_request_as_keyhandle()`, and a second copy of
a client is a liability only if nothing ever compares them. Compared, it is the
independent oracle: the kit's reading of the tunnel format on one side, the
shipped library on the other, one firmware underneath. Same shape as
`00-venv.test.js` asserting that the CLI and the kit agree about what the device
just said.

Two things to get right when that happens:

- `location.hostname` **must** be `onlyagent.app`. It is folded into the
  derivation - `okcrypto_hkdf()` reads the RPID staged at `ctap_buffer+4` - and
  the CLI pins the same value; the wrong one derives a different key with no
  error at all, surfacing much later as "no identity matched any of the
  recipients". `tunnel.js` already pins the right one. `test-api` says
  `apps.crp.to` because it stopped being maintained while that was still the
  domain - which is the general rule for reading it, below.
- Resolve `node-hid` from this kit, not from `onlykey.github.io`, which pulls
  2.2.0 and a bundled hidapi with a use-after-free that segfaults on teardown.

### What `test-api` is good for: the inventory, not the values

Read for **what it covered**, never for what it says is true. It froze where it
froze, so its constants are history rather than fact - the RPID above is the
example, and there will be others.

What it was exercising, which is the closest thing to a coverage list for the
web app's client that exists:

| | through | covered here? |
|---|---|---|
| `onlykeyApi.api.connect()` / `.check()` | the library | equivalent covered by `12-webauthn-tunnel` |
| `onlykeyApi.pgp().api()` — `startEncryption` / `startDecryption` | `onlykey-pgp.js` | **no** |
| its `_$mode()` matrix — Encrypt Only, Sign Only, Encrypt and Sign, Decrypt Only, Decrypt and Verify | `onlykey-pgp.js` | **no** |
| ECDH (`ecdh.js`, referenced from `index.js`, file no longer present) | the library | **no** |
| kbpgp's own API, with no OnlyKey involvement | `test_pgp/` | the same idea as this kit's sanity section |

Two details worth keeping from it. Its `test_pgp` control - prove the PGP library
works on its own before blaming the device - is exactly the sanity section's
argument, arrived at independently. And `particle_send.sh` pressed the device's
button with an **IoT relay**, driven off a `"You have 8 seconds to enter
challenge code"` status event: the same 3-button confirmation `lib/pqc.js` now
answers in software, once solved with hardware.

`onlykey-3rd-party.js` and `onlykey-api.js` are also where `OKGETPUBKEY`'s
option bytes are written down - the thing `10-fido2-xwing-derive` is blocked on.
So that row is a reading job either way, not a reverse-engineering one.

### Section 3's build sheet: every feature, twice

`onlykey-3rd-party.js` exposes nine calls, and each one is behind a page in
`onlykey.github.io/src/plugins/`. The old kit tested several of these **twice** -
once from Node against the library, once through the GUI - and TC-11 is the
clearest case, with `17-nodejs-composite-pgp` and `17-nwjs-composite-pgp` being
the same feature from both ends. That is the shape to keep: the headless test
says the library works, the GUI test says the page wires it up, and when only
the second fails the page is at fault rather than the device.

| feature | page | old kit, Node | old kit, nw.js | `00-09` headless | `10+` GUI |
|---|---|---|---|---|---|
| `connect` | all of them | - | - | ✅ `00-fido2-lib` | - |
| X-Wing maths (`age_pqc.js`) | age-derive | - | `15` | ✅ `01-age-pqc-parity` | ☐ |
| `derive_public_key` / `derive_shared_secret` | password-generator, vault | - | `14` | ☐ | ☐ |
| `derive_xwing_recipient` / `derive_xwing_decap` | age-derive | - | `15` | ☐ | ☐ |
| `composite_sign` / `composite_decrypt` | pgp-pqc | `17-nodejs` | `17-nwjs` | ☐ | ☐ |
| `startEncryption` / `startDecryption` (`onlykey-pgp.js`) | encrypt, decrypt | `18`'s `pgp_env` half | `18` | ☐ | ☐ |
| age file format (`age_file.js`) | age-derive | - | - | ☐ | - |
| vendored openpgp fork (`openpgp_loader.js`) | pgp-pqc | `17-nodejs`'s `openpgp_node` | - | ☐ | - |
| composite blobs (`composite_pgp.js`) | pgp-pqc | `17-nodejs` | - | ☐ | - |
| vault | vault | - | - | ☐ | ☐ |
| chat | chat | - | - | - | ☐ |

`age_file.js` is worth calling out: the web app implements the **age file format
itself** - HPKE seal/open, stanza parsing, the header MAC, chunked STREAM - so
it can be checked against the real `age` binary in both directions with no
device at all. Nothing has ever tested it. Same for `vault`, which no kit has
ever driven.

Two things found while surveying, both already acted on:

- **This kit's identity encoding was stale.** `lib/age-pqc.js` carried
  `AGE-PLUGIN-ONLYKEY-DERIVED-` plus base32, inherited from the old kit;
  python-onlykey and the web app both use bech32 over `[0xFF | label]` under the
  hrp `age-plugin-onlykey-` - the SAME hrp a slot identity uses, because `age`
  picks the plugin binary from that literal prefix and a tidier one would break
  dispatch. A round-trip test could never have caught it, since a wrong encoder
  and its matching decoder agree perfectly. Fixed, and now checked against
  python's own output rather than against itself.
- **`age_pqc.js` needs the web app's resolver, not just its files.** It requires
  `@noble/*` by bare specifier and `onlykey-fido2/package.json` declares none of
  them - because they are **vendored**, at `onlykey/vendor/@noble`, with
  `webpack.config.js` aliasing the bare specifiers onto that directory ("the
  only thing that lets those resolve without modifying the vendored files").
  `openpgp` is vendored beside it and loaded by path through `raw-loader`.
  `webenv.loadPlain()` replicates the alias, and it only partly survives: the
  vendored packages are ESM, and `@noble/post-quantum` imports `@noble/hashes`
  by bare specifier *internally*, which Node's ESM resolver has no alias for. So
  `hashes` and `curves` load from the app's own vendor tree and `post-quantum`
  falls back to the copy installed here - harmless only while the two are the
  same build, which `01-age-pqc-parity` now asserts rather than assumes
  (`post-quantum 0.6.1`, the rest `2.2.0`, on both sides today). Without that
  assertion a future divergence would leave the parity tests passing while
  checking this kit against itself.

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
| ✅ | `01-pqc-keygen` — X-Wing keygen (TC-04) | cli | `01-pqc-keygen` | plus the readback the old kit never did, which is what found **two firmware bugs** (`libraries@83353cf`) that made every generated PQC key unusable |
| ✅ | `02-pqc-slot` — PQC slot selection (TC-06) | cli | `02-pqc-slot` | and the reserved-slot case now proves the plugin refused on the ARGUMENT, by asserting the device primed no challenge |
| ✅ | `03-pqc-decrypt` — X-Wing encrypt/decrypt (TC-05) | cli | `03-pqc-decrypt` | real `age`, encrypted on the host, decrypted on the device, byte for byte — and the end-to-end proof that `libraries@83353cf` fixed something real, since both bugs surfaced here as "no identity matched any of the recipients" |
| ✅ | `04-pqc-no-device` — decrypt with no device (TC-07) | cli | `04-pqc-no-device` | **unattended, in 27 seconds.** The old kit printed "please UNPLUG the OnlyKey now", waited two minutes for a human, and was skipped by default. The gadget unbinds its own UDC, and the firmware keeps running with its RAM intact — which a hand on the cable could not arrange either, an OnlyKey being bus-powered |
| ✅ | `05-age-pqc-derived` — split custody, JS math | sanity | `04-age-pqc-derived` | **no binaries, no device, no node-hid.** Six tests in 80ms, including the fixed vector from python-onlykey's own `derived_xwing.py`, so this is cross-language agreement and not self-consistency. The three `@noble` packages are optional dependencies behind the `xwing-math` capability |
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

**8 of 19 carried over, 2 of those partially.**

The sections were checked against what each file actually EXECUTES, not what its
name suggests, and that moved five rows. The whole PQC cluster - `01`, `02`,
`03`, `04` - drives `age-plugin-onlykey` and `age` as external binaries rather
than speaking the vendor protocol, so it is **cli** work and blocked on a kernel
device node. `17-nodejs-composite-pgp` shells to `onlykey-cli` as well as using
FIDO2, so it lands there too.

What that leaves is lopsided, and worth knowing before picking anything up:

| section | open | blocked on |
|---|---|---|
| sanity | 0 | done |
| protocol | 1 (partial) | nothing - `10`'s transport is done; the derive command is not |
| cli | 4 | nothing - the section runs; these are now just tests to write |
| gui | 4 | stage 6, and a display |

So "get all the tests over" is mostly a CLI problem, not a protocol one. Stage 3
is done and the section runs; the four rows left there are tests to write rather
than anything to unblock.

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
- `01-pqc-keygen`'s readback and its `wrote === 1` flash-write count, for the
  two PQC keygen bugs (`libraries@83353cf`). Neither needed the emulator to
  REPRODUCE - they were in every build - but both needed a test willing to ask
  the device a second question and to count what the device did, and the old
  kit could do neither

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
      and CTAPHID framing, the backup format, the X-Wing maths - against known
      answers. 35 tests in under a second. `device: false` in a file's metadata
      skips the device host entirely
- [x] Port `05-age-pqc-derived`'s split-custody maths into it
      (`lib/age-pqc.js`, `04-age-pqc-derived.test.js`). The fixed vector is
      regenerable - `tools/gen-derived-xwing-vector.py` runs python-onlykey's
      own reference on fixed inputs - so a future disagreement is three
      implementations diverging, not a stale fixture

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

The workflow now also installs the kit's own optional dependencies
(`--ignore-scripts`, so node-hid does not spend minutes building a binding for a
bus that is not there), runs the sanity section unconditionally, and asserts
`xwing-math` alongside the rung. That assertion is the point: a missing package
would not fail anything, it would skip the file with a reason and go green,
which is exactly how a test stops existing without anyone noticing. Still
untested, still `workflow_dispatch` only.

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
- [x] **Verified live.** With the key unplugged and the daemon stopped, the kit
      raised its own gadget, python-onlykey saw exactly one device, and all four
      tests passed. Full run: sanity + protocol + cli = **101 passed, 0 failed**
- [x] The PQC keygen rows, `01-pqc-keygen` and `02-pqc-slot`, on `lib/pqc.js`:
      config-mode entry, the three-button challenge computed rather than read
      off the LEDs, and the press timed on the device's own "Encrypted Buffer"
      rather than a blind margin. **Both found firmware bugs** - see the
      `wrote === 1` assertion, which is a regression test for one of them
- [x] `03-pqc-decrypt`, on `lib/pqc.js`'s decapsulation half: no config mode,
      digits hashed from the CIPHERTEXT rather than a fixed trigger, and the
      device's own print as the press signal - which here is the ONLY signal,
      because `age` runs the plugin as its own child and does not relay its
      stderr
- [x] `04-pqc-no-device`, on a new `device.unplug()`/`device.plug()`: a real
      bus-level detach, waiting for the hidraw nodes to actually go rather than
      for the write that causes it, since a client enumerating in that window
      still finds a device
- [ ] The rest of the CLI rows: lib-agent SSH and GPG, `11-derived-xwing-cli`,
      `17-nodejs-composite-pgp`
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

- [x] Section 3's headless tier is started (`03-gui/00-fido2-lib`, 6 tests):
      `lib/webenv.js` supplies the browser surface and points
      `navigator.credentials.get()` at `lib/device/ctap2.js`, and the real
      library completes an OKCONNECT handshake over the in-process bus. Its
      tunnel encoder is checked byte for byte against `lib/device/tunnel.js`,
      and both are checked against the device
- [x] `01-age-pqc-parity`: the web app's X-Wing maths against the same fixed
      vector, which found this kit's stale identity encoding
- [ ] The rest of the build sheet above. `derive_public_key` /
      `derive_shared_secret` is the next one worth doing - two pages depend on
      it and it needs the device, so it exercises the shim properly
- [ ] Section 3's browser tier (`03-gui/10+`), the web app in nw.js
- [ ] Section 4, the OnlyKey app — never driven from a harness at all
- [ ] Services started and stopped by *visible* test files at the section
      boundaries, never hooks; cleanup tracks process groups, because nw.js can
      crash and orphan the server it spawned holding a port

---

## Loose ends

- [ ] Crypto vectors against derived and stored keys — dropped from the first
      cut because those paths need challenge-mode configuration that has not
      been worked out
- [ ] `package-lock.json` is gitignored, but there are now four declared
      optional dependencies - `node-hid` and the three `@noble` packages, and
      the last of those is cryptographic maths the suite checks itself against.
      Decide whether the lockfile should be tracked
- [ ] Backup typing takes ~46s at the default TYPESPEED. Setting a faster type
      speed before the backup would cut the longest test roughly in half
- [ ] Fold the flasher's pacing back into
      `onlykey-usb-hid-passthrough/tools/halfkay_flash.py` if direct-attached
      flashing becomes routine there too — the kit has its own copy, but the
      original still dies at block 4 without a proxy
