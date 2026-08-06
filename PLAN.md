# Plan

Stages, in the order they are worth doing. [EXPLAINER.md](EXPLAINER.md) is the
design and its reasoning; [README.md](README.md) is how to use what exists.
This file is what is left, and why.

**[TODO.md](TODO.md) is the work list** - the same open items in the order to do
them, with what each one needs. Read that to pick something up; read this to
understand what you picked up. When an item is finished, both files change: the
box in TODO.md and the reasoning here.

Both adapters green as of 2026-08-06, hardware on `libraries@83353cf`. **Each row
carries when it was last measured**, because a count without a date is a claim
about the past wearing the present tense - and the two adapters drift apart at
different rates. This sentence read "Both adapters green" with no date at all
until 2026-08-06, by which point the hardware column was a day stale and had seen
nine fewer files than the tree contained - a header that had quietly stopped
being a measurement, which is the exact failure the dates exist to prevent.

| | emulated | last run | hardware | last run |
|---|---|---|---|---|
| sanity | 53 passed, 0 failed | 2026-08-06 02:16Z | 53 passed, 0 failed | 2026-08-06 13:28Z |
| section 1 | 115 passed, 0 failed, 1 skipped | 2026-08-06 15:33Z | 94 passed, 0 failed, 19 skipped | 2026-08-06 13:28Z |
| section 2 | 104 passed, 0 failed (gadget) | 2026-08-06 02:16Z | skipped - `client-access` | n/a |
| section 3 | 84 passed, 0 failed (headless 56 + browser 28) | 2026-08-06 02:16Z | n/a - both tiers drive the emulator by design | n/a |
| section 4 | 28 passed, 0 failed | 2026-08-06 14:44Z | n/a - needs `client-access`, the gadget | n/a |
| **whole tree** | **353 passed, 0 failed, 2 skipped** in 1489s | 2026-08-06 02:16Z | **147 passed, 0 failed, 19 skipped-with-reason** in 837s (sections 0+1; 2-4 cannot run there) | 2026-08-06 13:28Z |

**THE WHOLE-TREE ROW PREDATES SECTION 4 AND NO LONGER SUMS**, said here rather
than silently corrected by arithmetic, which is the mistake this table has
already made once. That run was 353 with section 4 as a single skipped stub; the
section is now 11 passing tests measured on its own at 03:34Z, so the tree is
**~364 and one skip lighter** - and unmeasured as a whole. Re-run it rather than
adding the numbers up.

**And note what it does to the budget.** 1489s was already 83% of the 30-minute
`RUN_MAX`; section 4 adds ~25s of tests plus a `gulp build` and an nw.js launch
per run. That is not what will break the cap, but it is the third section to
grow since the cap was last set, and a per-file cost stays invisible against a
per-run one - see TODO's row on making the budget per-SECTION.

**THE WHOLE TREE STOPPED FITTING IN `RUN_MAX`, AND THAT IS WHY THIS ROW IS A
REAL RUN AGAIN.** The 17:35Z sweep took 879s against a 900s cap - twenty-one
seconds of headroom nobody knew was the margin - and the five files that landed
at 21:02Z took section 1 from 367s to 707s, putting the tree five minutes over
the cap **hours before anybody noticed**. The 22:25Z attempt was cut off at 903s
with 225 passed and 0 failed; nothing had failed, the run had run out of budget.
`RUN_MAX` is now 30 minutes, with the per-section measurements beside it in
`lib/config.js` so it reads as a ceiling rather than a guess, and the row above
is the whole tree end to end in **1489s**. 1489 of 1800 is **83% of the ceiling**,
which is the number to watch: the next few files put it back where the last one
was.

**EVERY ROW IN THE TABLE ABOVE COMES FROM THAT ONE RUN**, 2026-08-06 02:16Z, which
is why they all carry the same date and why they sum exactly: 53 + 112 + 104 + 84
= 353. The previous version of this table did not sum - the whole-tree figure was
measured at 01:22Z and `02-cli/16-cli-key-files` landed at 01:25Z - and a reader
doing the arithmetic would have found three tests missing and gone looking for a
bug. Re-measured rather than annotated, because the annotation would have had to
be removed later anyway.

The lesson is in TODO: **a per-file cost is invisible against a per-run cap.**
Every one of those six files was measured, green and cheap on its own.

**Section 1's 112 was the 17:35Z sweep's 96 plus five new files measured on
their own** - `19-rsa-keys` 7, `20-second-profile` 3, `21-self-destruct` 2,
`22-rsa-slot-tail` 2, `23-rsa-tunnel` 2 (+1 gated off). It is confirmed by the
00:39Z whole-tree run rather than only by that arithmetic. All sixteen are green three ways
each: natural order, `--isolate` and `--reverse`.

**THE HARDWARE COLUMN HAS NOW SEEN THEM, AND THE COUNT HERE WAS WRONG - IT IS
NINE FILES, NOT FIVE.** This paragraph said "none of the five" and named
`19`-`23`, which undercounted by four: the 2026-08-05 hardware sweep ended at
16:24Z, and `15-hmac-secret` (16:54Z), `16-credprotect`, `17-resident-keys` and
`18-clientpin-credmgmt` (17:20Z) all landed after it. Measured from git rather
than recalled, which is how the four were found. All nine ran against the key on
2026-08-06; `15`, `16` and `17` are green on hardware for the first time.

Behaviour of the gates on a key, now MEASURED rather than predicted:

| file | gate | on a key |
|---|---|---|
| `18-clientpin-credmgmt` | `fido-reset` | skipped, 5 tests, unless `OKT_ALLOW_FIDO_RESET=1` |
| `21-self-destruct` | `full-wipe` | skipped, 2 tests, unless `OKT_ALLOW_FULL_WIPE=yes` |
| `22-rsa-slot-tail` | `storage-files` | skipped, 2 tests - no physical key has a `flash.bin` |
| `23-rsa-tunnel` | its 4096 test only | skipped; **now `emulated` AND the env var**, see below |

All are the gates working rather than gaps. `23-rsa-tunnel`'s other two tests
RAN and passed on the key - classic RSA over the WebAuthn transport against
physical hardware for the first time - so the file is hardware-capable and
gating it wholesale would have thrown that away.

**The 4096 test gained a capability gate on 2026-08-06, and the reason is
asymmetric.** It was held only by `OKT_EXPECT_RSA4096_FIX=yes`, an environment
variable with no hardware guard, so setting it on a hardware run would have
aimed a known out-of-bounds WRITE at a physical key. What makes that case safe
to drive is `_FORTIFY_SOURCE`, which is the emulator's: it aborts at the point
of the overflow, which is how the defect was found. On a key the same write
lands silently. The capability is now checked first, so the variable can only
arm it where the abort exists.

**`--reverse` has now been measured across the tree** the way `--isolate` was -
55 files in scope, 30 pass, 25 fail, all recorded as debt in TODO rather than
fixed. The useful part is the correlation: every file written since `--reverse`
became a gate passes it, and every failure predates the rule.

**Both columns were single sweeps as of 17:35Z**, and the emulated one is again
as of 2026-08-06 00:39Z - 344 passed, 0 failed, 2 skipped, 1356s:

- **Emulated**: `okt run` with no target, one process, all four sections in
  order. 319 passed, 0 failed, 1 skipped, 879s, run `20260805-172107-935299`.
  The one skip is section 4's stub, which has never been written. Nothing was
  left behind - port 3000 free, no nw.js and no express server, which is
  `19-stop` doing its job inside a full-tree run rather than a section one.
- **Hardware**: sections 0 and 1 end to end against the key, finishing 16:24Z.
  Sections 2 and 3 cannot run there by construction - `client-access` needs the
  gadget, and section 3's headless tier drives the emulator on purpose.

Until this run the emulated column was per-file arithmetic, summed as each file
landed rather than produced by any single run. It agreed exactly, which is
reassuring rather than redundant: a per-file total can hide a file that only
passes when it runs alone, and this one does not. It has now agreed twice, the
second time across a `RUN_MAX` change and a section that had grown by six files -
which is the property worth having, since it is the only measurement that catches
a file passing solely because its neighbours did not run.

Section 3 remains the most drift-exposed section - its browser tier depends on
nw.js and the onlykey.github.io checkout rather than on anything this repo pins -
so it is still the one to re-measure when either of those moves. Note it must run
as a SECTION, never file by file: `10-session` starts nw.js and the express
server, `19-stop` stops them, and the session is held across files by the module
cache. Its 84 IS a section sweep, run 00:57Z after both PGP-page files landed,
rather than a total plus arithmetic.

Run directories under `runs/` carry the authoritative record - each has a
`status.json` with `startedAt`, `finishedAt` and the counts, and `run.log`'s
second line names the adapter.

The key is flashed with `libraries@83353cf` and sections 0 and 1 pass on it -
re-run 2026-08-06, 147 passed in 837s, run `20260806-131421`. The **19** skips
reconcile exactly and are worth reading as four groups rather than one number:
`00-boot` x2 and `02-restart` x2 (`device-host` - the emulator's two-process
lifecycle), `05-snapshot` x5 (`image-snapshots`), `18-clientpin-credmgmt` x5
(`fido-reset`), `21-self-destruct` x2 (`full-wipe`), `22-rsa-slot-tail` x2
(`storage-files`), and `23-rsa-tunnel`'s 4096 case. The count grew from 9 to 19
because nine files landed after the last hardware sweep, not because anything
stopped running.

**THAT RUN IS ALSO THE FIRST HARDWARE NUMBER WORTH TRUSTING, AND THE EARLIER ONES
WERE MEASURING A LEAKY ADAPTER.** `_open()` in `lib/device/hardware.js` was not
idempotent: a re-enumerating key races udev, so a reopen a few milliseconds early
failed with EACCES *part way through the loop*, leaving already-opened handles
live while the caller retried and opened a second set over the top. The orphan
kept its `data` listener, so SEREMU was delivered twice and the console
accumulator - which several section-1 tests use as their only oracle - filled
with interleaved duplicates. Two runs failed on it and each passed on a rerun,
looking exactly like flaky firmware. See the adapter's own comment for the
evidence and the fix; the short version is that the open order decided whether a
denial could do damage, and only denials on an interface *after* the first could.

**`13-large-response` means something on hardware that it cannot mean on the
emulator.** `core-override/okemu_usb.cpp`'s `usb_rawhid_send2()` is a one-line
call straight to `okemu_hid_emit` - no TX queue, no `TX_PACKET_LIMIT`, no path
that returns 0 - so the five-retry loop in `send_transport_response()` never
retries there and the truncation the file guards is unreachable. On a real key
the queue exists, and 3309 bytes over 52 reports arrived whole.
Section 2 cannot run against a physical key at all (`client-access`), and
section 3's headless tier drives the emulator on purpose - so those two stay
emulator-only by construction rather than by omission.

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
| the page, in nw.js | `03-gui/10+` | `display`, `nwjs`, and a device the page can reach | no |

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
option bytes are written down - which is what `10-fido2-xwing-derive` was
blocked on. It turned out to need no reading either: `03-gui/03-xwing-derive`
runs the library, and the library already sends them.

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
| the `_$mode()` matrix - Encrypt Only, Sign Only, Encrypt and Sign, Decrypt Only, Decrypt and Verify | encrypt, decrypt | - | `18` | ✅ `08-pgp-encrypt-decrypt` - all five driven | ✅ `14-gui-encrypt-decrypt` - all five again, in nw.js |
| X-Wing maths (`age_pqc.js`) | age-derive | - | `15` | ✅ `01-age-pqc-parity` | ☐ |
| `derive_public_key` / `derive_shared_secret` | password-generator, vault | - | `14` | ✅ `02-derive` | ✅ `11-password-generator` |
| `derive_xwing_recipient` / `derive_xwing_decap` | age-derive | - | `15` | ✅ `03-xwing-derive` | ✅ `12-age-derive` |
| composite key generation | pgp-pqc | `17-nodejs` | - | ✅ `06-composite-key` | - |
| loading a composite key | pgp-pqc | `17-nodejs` | - | ✅ `02-cli/05-composite-load` | - |
| `composite_sign` / `composite_decrypt` | pgp-pqc | `17-nodejs` | `17-nwjs` | ✅ `02-cli/06-composite-ops` - both halves of both operations, and TC-11's whole round trip | ☐ |
| key selection (`onlykey-pgp.js`) | encrypt, decrypt | - | - | ✅ `07-pgp-keys` | - |
| `startEncryption` / `startDecryption` | encrypt, decrypt | `18`'s `pgp_env` half | `18` | ✅ `08-pgp-encrypt-decrypt` - **section 3, not section 2**, and measured rather than argued | ✅ `14-gui-encrypt-decrypt` |
| age file format (`age_file.js`) | age-derive | - | - | ✅ `04-age-file` | ✅ via `12-age-derive` |
| vendored openpgp fork (`openpgp_loader.js`) | pgp-pqc | `17-nodejs`'s `openpgp_node` | - | ✅ used by `06` | - |
| composite blobs (`composite_pgp.js`) | pgp-pqc | `17-nodejs` | - | ✅ `05-composite-blob` | - |
| vault | vault | - | - | **placeholder** | **placeholder** |
| chat | chat | - | - | **placeholder** | **placeholder** |

**The `startEncryption`/`startDecryption` row said "section 2" and that was
wrong.** The reasoning was `07-pgp-keys`': the device-backed half needs a key the
device holds, and loading a COMPOSITE one needs `onlykey-cli setpqc` because
`OKSETPRIV` is not reachable over the browser transport. True for a composite key.
**Not true for a classic RSA key** - that goes into an RSA slot with `OKSETPRIV`
over the VENDOR interface, which `01-protocol/19-rsa-keys` does from the kit with
no CLI at all, and `01-protocol/23-rsa-tunnel` then drives sign and decrypt
against it through the tunnel. So the classic pages carry no section-2
prerequisite and their headless tier belongs in section 3 with the rest of the
library work. The PQC page keeps its section-2 prerequisite, because a composite
key genuinely does need `setpqc`.

**That correction is now a file rather than an argument.**
`03-gui/08-pgp-encrypt-decrypt` loads both hardcoded RSA slots itself over the
vendor interface and drives all five modes, with no CLI involved anywhere. The
shape worth keeping is that **one PGP key fills both slots**: `slotid()` sends
OKSIGN to slot 2 and everything else to slot 1, and a PGP key is a primary that
signs plus a subkey that encrypts, so the primary's P‖Q goes to 2 and the
subkey's to 1. Generating that key with openpgp.js is also what makes the oracle
independent - the device is given only the factors, so the library's output is
checked by a library that has never spoken to it. Two client-side findings came
out of it and are in TODO's premises table; the shortest is that
`startEncryption`'s two argument guards test `.value` on strings the pages have
already dereferenced, so **neither guard can fire and an empty input hangs the
call** instead of reporting itself.

**`vault` and `chat` are placeholders**, per the maintainer - future features,
not shipped ones, so their absence from the sheet above is deliberate rather
than a gap. Worth saying plainly because it is not visible from the source:
`vault.js` is 513 lines with a complete-looking UI (add, list, export, import,
lock-all, a policy field) and calls the same derive pair the password-generator
does, so a reader would reasonably take it for a finished feature and write
tests against it. `chat.js` is 50 lines and obviously a stub. Neither is worth
testing until somebody says it is.

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
| ✅ | `12-non-pqc-regression` — slot labels, classic ECC + RSA (TC-15) | protocol | `08-slot-keyboard`, `14-stored-keys`, `19-rsa-keys` | **now whole.** Labels and slot storage by the first, the classic ECC curves by the second, and RSA-2048 by the third - store, publish, sign, decrypt, both feature-bit refusals, and the wipe pinned as it ships |
| ✅ | `01-pqc-keygen` — X-Wing keygen (TC-04) | cli | `01-pqc-keygen` | plus the readback the old kit never did, which is what found **two firmware bugs** (`libraries@83353cf`) that made every generated PQC key unusable |
| ✅ | `02-pqc-slot` — PQC slot selection (TC-06) | cli | `02-pqc-slot` | and the reserved-slot case now proves the plugin refused on the ARGUMENT, by asserting the device primed no challenge |
| ✅ | `03-pqc-decrypt` — X-Wing encrypt/decrypt (TC-05) | cli | `03-pqc-decrypt` | real `age`, encrypted on the host, decrypted on the device, byte for byte — and the end-to-end proof that `libraries@83353cf` fixed something real, since both bugs surfaced here as "no identity matched any of the recipients" |
| ✅ | `04-pqc-no-device` — decrypt with no device (TC-07) | cli | `04-pqc-no-device` | **unattended, in 27 seconds.** The old kit printed "please UNPLUG the OnlyKey now", waited two minutes for a human, and was skipped by default. The gadget unbinds its own UDC, and the firmware keeps running with its RAM intact — which a hand on the cable could not arrange either, an OnlyKey being bus-powered |
| ✅ | `05-age-pqc-derived` — split custody, JS math | sanity | `04-age-pqc-derived` | **no binaries, no device, no node-hid.** Six tests in 80ms, including the fixed vector from python-onlykey's own `derived_xwing.py`, so this is cross-language agreement and not self-consistency. The three `@noble` packages are optional dependencies behind the `xwing-math` capability |
| ✅ | `10-fido2-xwing-derive` — X-Wing derive over FIDO2 (TC-09/10) | protocol, gui | `12-webauthn-tunnel`, `03-gui/03-xwing-derive` | the tunnel is proven on both adapters, and the derive itself now runs — not by working the option bytes out, but by letting the shipped library send them, exactly as this file predicted. Full split-custody round trip: the device derives, a sender encapsulates with no device present, the device contributes only ss_X, and the host finishes |
| ✅ | `17-nodejs-composite-pgp` — composite PGP-PQC over Node FIDO2 (TC-11) | cli | `05-composite-load`, `06-composite-ops` | generated by the web app, loaded by the CLI, signed and decrypted by the device through the web app's own library — the "mixed" nature turned out to be the point rather than a problem |
| ✅ | `06-lib-agent-ssh` — SSH derived-key export (TC-13) | cli | `08-lib-agent-ssh` | **three oracles, 7s.** lib-agent over hidapi, this kit over the in-process vendor interface, and node:crypto deriving the public half from the seed the device printed — all on one key. The old kit could only check that a key came back |
| ✅ | `07-lib-agent-gpg` — GPG derived identity (TC-13) | cli | `09-lib-agent-gpg` | the first lib-agent test that SIGNS — twice, each behind its own button challenge. Both derived keys checked against this kit's own, and the OpenPGP packets parsed here rather than read back through gpg |
| ✅ | `11-derived-xwing-cli` — CLI derived X-Wing (TC-16/17) | cli | `07-derived-xwing` | **9 seconds, unattended.** The old one needed a key and a human; this asserts what it could only assume — the device primes no challenge on this branch, and the identity is encoded with the device saying nothing at all |
| ✅ | `14-gui-password-generator` | gui | `03-gui/11-password-generator` | the page's secret cross-checked against the kit's own derivation - two clients, two transports, one device |
| ✅ | `15-gui-age-derive` (TC-18/19) | gui | `03-gui/12-age-derive` | encrypt and decrypt in the browser, and the file it sealed opened by the kit |
| ☐ | `17-nwjs-composite-pgp` (TC-11) | gui | — | **stage 6** |
| ✅ | `18-gui-encrypt-decrypt` | gui | `03-gui/08-pgp-encrypt-decrypt`, `03-gui/14-gui-encrypt-decrypt` | **carried over in both tiers, and then some** - all five `_$mode()` modes headless and again in nw.js, each checked against openpgp.js rather than against the page's own output |

Sections are the kit's own: **sanity** (`test/00-sanity`, no device at all -
the kit's own oracles against known answers), **protocol** (`test/01-protocol`,
no kernel device node, the only device section CI can run), **cli**
(`test/02-cli`, onlykey-cli through the venv), **gui** (`test/03-gui`, the
onlykey.github.io web app in nw.js) and **app** (`test/04-app`, the OnlyKey
desktop app).

**Nothing maps to `app`.** The old kit never drove the desktop app either, so
section 4 is the one part of this kit with no ancestor at all — which is also
why it is last.

**13 of 19 carried over, 1 of those partially** - `08-backup-hmac`, whose backup
half is more than carried over and whose HMAC settings half is not covered at
all. `12-non-pqc-regression` and `18-gui-encrypt-decrypt` were the other two
partials and both are now whole, the second in both tiers.

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
| protocol | 1 (partial) | **NOT a test to write, and this row said it was until 2026-08-06.** `08-backup-hmac`'s **settings** half is DONE - `hmackeymode` is one of the 13 device settings `02-cli/11-cli-settings` drives, so it landed without anybody noticing. What is left is the **HMAC-SHA1 challenge-response feature itself**, and it is blocked on **two IPC verbs** (`kbdSetReport`/`kbdGetReport`) that do not exist in the emulator's protocol. See TODO's §2, which is the correct version of this row |
| cli | 0 | done - every carried-over row has a replacement |
| gui | 1 | `17-nwjs-composite-pgp`, which is the pgp-pqc page - `vault`/`chat` are placeholders, not gaps, and `18-gui-encrypt-decrypt` is done in both tiers |

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

**FOURTEEN message types are actually dispatched**, not eighteen. `okcore.h`
defines eighteen; the switch in `okcore.cpp` has fourteen cases, and the other
four are not incoming messages at all. `0xE8`-`0xEB` were the U2F cert/key
messages and are removed in this firmware. This is what the CLI and the desktop
app speak.

| | messages |
|---|---|
| **covered (13)** | `OKPIN` `OKPINSD` `OKPINSEC` `OKCONNECT` `OKGETLABELS` `OKSETSLOT` `OKWIPESLOT` `OKSETPRIV` `OKWIPEPRIV` `OKRESTORE` `OKSIGN` `OKGETPUBKEY` `OKDECRYPT` |
| **not covered (1)** | `OKFWUPDATE` |
| **NOT A MESSAGE (4)** | `OKGETRESPONSE` `OKPING` `OKHMAC` `OKWEBAUTHN` |

That last row was four planned tests until somebody checked, and the check is
worth repeating rather than trusting this table:

```sh
grep -n "case OKGETRESPONSE:" onlykey/okcore.cpp     # nothing
```

`OKGETRESPONSE` (`0xF2`) and `OKPING` (`0xF3`) have **no handler and no
reference anywhere in the firmware** - zero hits across every `.cpp`. Every
client agrees: python-onlykey never sends them, and `onlykey-api.js` carries
`// const OKGETRESPONSE = 242;` commented out. `OKHMAC` (`0xF5`) and
`OKWEBAUTHN` (`0xF6`) do appear once each, but as INTERNAL TAGS -
`packet_buffer_details[0] = OKWEBAUTHN` - marking what a buffered packet is for.
Neither is ever received.

Sending any of the four is not a no-op, which is the one thing here worth
testing. The dispatcher's `default:` hands any unrecognised vendor message id to
`recv_fido_msg()`, so an unknown id on the vendor interface is interpreted as
CTAPHID data.

`OKGETPUBKEY`, `OKSIGN` and `OKDECRYPT` dispatch on the SLOT number, and there
are **three** stored-slot branches, not one - which is why two files rather than
one cover them:

| slots | branch | covered by |
|---|---|---|
| 101..116 | `okcore_flashget_ECC()`, `okcrypto_ecdsa_eddsa()` and the PQC pair | `14-stored-keys` - ed25519, nist256p1, secp256k1, curve25519, ML-KEM-768, X-Wing |
| 1..4 | `okcore_flashget_RSA()`, `okcrypto_rsasign()` / `okcrypto_rsadecrypt()` | `19-rsa-keys` - RSA-2048 |
| 1..4 with `KEYTYPE_PQC_PGP` | the same slots, routed to `okpqc_*` before the RSA branch | `13-large-response`, `02-cli/06-composite-ops` |

That third row is why `13-large-response` writing RSA slot 1 proved nothing about
RSA: `okcrypto_sign()` checks `(type & 0x0F) == KEYTYPE_PQC_PGP` and leaves for
`okpqc_sign()` before it ever reaches `is_bit_set(features, 6)`.

The derivation slots are covered separately: 132 by `08-lib-agent-ssh` and 128 by
`07-derived-xwing` and `15-age-file-interop`.

**Every message in plane 1 is now covered except `OKFWUPDATE`**, which is gated
`emulated` and driven only to its interlocks, deliberately - see TODO.

Underneath `OKSETSLOT` sit **29 dispatched cases** and **6 key types** (ed25519,
P256, secp256k1, curve25519, ML-KEM-768, X-Wing). Not 28 - that was the size of
python's `MessageField` enum, and the split matters more than the count: **16
are per-slot fields** and **13 are device-wide settings** that merely arrive
through the same message. All 13 settings are covered by `11-cli-settings`; 14
of the 16 slot fields by `12-cli-slots` and `13-cli-lifecycle`. What is left is
case 10 (`YUBIAUTH`, accessor named `public_DEPRICATED`) and case 29, which has
no name in any client's enum.

**How a large response actually comes back**, since this was written down wrong
here for several sessions and put a phantom row first in the work order.
Nothing requests chunks. `send_transport_response()` (okcore.cpp:2821) loops
`for (i = 0; i < len; i += 64)` and pushes consecutive 64-byte reports itself,
so a 1184-byte ML-KEM public key is 19 reports and a 3309-byte ML-DSA signature
is 52, all unsolicited.

That path is now tested directly by `01-protocol/13-large-response`, at both
1184 bytes (19 reports) and 3309 (52). It has a recorded failure mode: `RawHID.send2`
gives up instantly when the firmware's 4-packet TX queue is full and returned 0
without sending, and the return value was not checked, so a full queue **silently
dropped a chunk**. The comment at the fix site calls it the root cause of the
intermittent truncated multi-packet responses seen all session. A dropped chunk
is likelier at the extreme than in the middle, so the long response matters more
than the short one.

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
- [x] `08-lib-agent-ssh`, TC-13's SSH half - the fourth client in this tree and
      the last one nothing had ever run. The value is not that a key comes back,
      which is all the old kit could ask: it is that **three independent paths
      have to reach the same 32 bytes**. lib-agent asks over hidapi, the kit asks
      the same question over the in-process vendor interface, and node:crypto
      derives the public half from the seed the firmware prints - so the first
      two agreeing cannot be a shared misreading of the wire, and neither can be
      32 consistent bytes of nothing. The pure-JS half deliberately uses
      node:crypto's PKCS#8 wrapping rather than `@noble/curves`, which is an
      OPTIONAL dependency here: an oracle that can be absent is an oracle that
      silently stops running.

      Also asserted rather than implied, and both would be invisible otherwise:
      the derive path primes no button challenge, and the whole file erases zero
      flash sectors - a derived key is derived, never stored.

      Two facts about lib-agent found by asserting the opposite. `ssh/main()`
      overwrites `identity_dict['proto']` with `ssh` for every identity, so
      `git://okt@host` produces output byte-identical to `ssh://okt@host` - the
      first version of the test expected the comments to differ. And **only
      `user@host` is hashed**: the port and path appear in the published comment
      and never reach the device, so two authorized_keys entries can look as
      different as you like and be one key.
- [x] `09-lib-agent-gpg`, TC-13's GPG half - and the carried-over rows are now
      all done. It is NOT the SSH file with a different binary: lib-agent's
      `pubkey()` branches on the identity's proto and GPG takes the other side
      of every branch. It hashes the WHOLE identity string rather than
      `user@host`, derives TWO keys (ed25519 to sign, curve25519 to decrypt),
      and - the real difference - **it signs**, so this is the first lib-agent
      test that needs `lib/pqc.js` at all. `init` builds an OpenPGP key by
      signing twice, a self-certification over the primary and a binding over
      the subkey, and each is behind its own three-button challenge. The count
      is the assertion: exactly two, so a key built without a signature it
      should carry, or something signing that nobody asked for, both read as a
      number.

      The signature also takes a different firmware path from the export.
      `okcrypto_sign()` dispatches slot **201**, not 132, into
      `okcrypto_ecdsa_eddsa()`, which maps 201/202/203 back onto
      `okcrypto_derive_key()` by curve. 132 is the old number and is still what
      the pubkey call sends, so the two appearing side by side is not a typo.

      Both derived keys are checked against this kit's own, so `init` succeeding
      cannot just mean lib-agent and gpg agreed with each other - and the
      OpenPGP packets are walked here rather than read back through gpg, since
      gpg wrote them. A second oracle falls out of it for free: the digits
      lib-agent PRINTS are compared with the ones derived from the packet the
      device says it received. Those are computed on opposite sides of a
      multi-report send, so agreeing means `send_large_message2()`'s framing
      arrived intact - and a dropped chunk becomes two different triples rather
      than a confirmation the device mysteriously refuses.

      Three things it cost, all findings:

      - `init` needs the venv on **PATH**, unlike every other section-2 call,
        which run by absolute path deliberately. `run_init()` does
        `util.which('onlykey-gpg-agent')` and bakes the result into
        `run-agent.sh`, so without it the command dies before touching the
        device. It also means the homedir is only as portable as the venv.
      - **`init` leaves a daemon running.** Its last step is
        `gpg --list-secret-keys`, which makes gpg launch the agent named in
        `gpg.conf` - so a successful `init` returns with a long-lived
        `onlykey-gpg-agent` holding the device's hidraw node. Four of these were
        found on this machine from an earlier attempt at this row, forty hours
        old, homedirs long deleted. A test that starts a daemon and does not
        stop it does not fail; it accumulates.
      - **`gpgconf --kill all` does not work here - it hangs.** It drives the
        agent over assuan and asks things the stock gpg-agent answers (the
        observed stall was `gpg-connect-agent ... GETINFO tpm2d_running`), and
        `onlykey-gpg-agent` is a different program that does not answer them. So
        the stop reads `/proc`, matches on this run's own mkdtemp homedir, and
        signals the pid - which on a machine with several workspaces on it is
        also the only version that is safe to run.

      `11-derived-xwing-cli` is done - `07-derived-xwing`, both transports into
      one derivation. `17-nodejs-composite-pgp` is done - `05-composite-load`
      and `06-composite-ops`, the latter now covering both halves of both
      operations and TC-11's own acceptance criterion
- [x] Then start section 2 against the emulator: `onlykey-cli` through the
      venv, driven by visible start/stop test files rather than hooks. The CLI
      exposes **37 subcommands** - that list was the section-2 checklist and it
      is finished, `16-cli-key-files` last. Both commands that take a FILE are
      driven on the path that does the work, not only on the one that rejects
- [ ] The old kit drove FIDO2 from Node with
      `@vincss-public-projects/fido2-client` (the `bmatusiak/FIDO2Client` fork)
      over hidapi. That route needs a kernel node, so it belongs here rather
      than in section 1 - and it is worth having *as well as* the hand-rolled
      section-1 path, because it tests what a real client does

## Stage 4 — the PINs we set every run and never test ✅

**Why:** `PINS.secondary` and `PINS.selfDestruct` appeared exactly once each in
the suite, both in `07-unlock` as *negative* assertions. Every run provisioned
all three and exercised one. Both are now entered.

- [x] Second profile → `01-protocol/20-second-profile`, 3 tests in 39s, both
      gates green. It IS a different profile with different slot data -
      `gen_press()` adds 12 and `gen_hold()` 12 + 6, so its buttons address
      13..24 and can never address 1..12 - and it DOES see profile 1's, which is
      the third thing this row asked to confirm and the opposite of what ships.
      Both profiles unwrap ONE stored master profile key, deliberately, so that a
      PIN change need not re-derive it. Not a failed boundary: plausible
      deniability is the travel BUILD's property (see below), so separation by
      slot numbering is what the second profile is documented to be. Pinned, and
      the test fails if that ever changes
- [x] Self-destruct → `01-protocol/21-self-destruct`, 2 tests in 63s, gated on
      `full-wipe` - the existing capability, reused because its reason string
      already names the cost: `factorydefault()` erases the firmware hash and
      forces the bootloader, so a physical key needs reflashing. The device
      answers `UNLOCKED, NO PIN SET` afterwards and the primary PIN unlocks
      nothing. The second test re-provisions with the same three PINs and shows
      the old secret still cannot come back, because re-provisioning generates a
      new random profile key - and it carries a control, because after a wipe the
      slot types NOTHING, which is equally what a discarded press produces
- [ ] **The International Travel Edition — deferred until the kit is complete**,
      by decision. `STD_VERSION` is a `#define` in the sources rather than a build
      flag, so the travel edition is a comment-out and a rebuild - **two lines**
      (`libraries/onlykey/onlykey.h:84` and `OnlyKey.ino:82`), and doing one gives
      a half-travel build. File it beside `usb_desc.h`'s commented-out production
      block: both are hand-edited source variants the build cannot distinguish.
      The approach is a DIFF of this suite across both builds rather than a second
      suite - 76 guard directives, and what matters is which behaviours change,
      which two separate suites would never compare. Everything here assumes
      `STD_VERSION`, so `profilemode == NONENCRYPTEDPROFILE` is untested by
      construction. See TODO and README

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
- [x] `hmac-secret` — `01-protocol/15-hmac-secret`, 6 tests. The extension the
      firmware advertises and nothing exercised, which is the worst combination:
      clients feature-detect off the GET_INFO list, so a break shows up as a
      client failing with nothing wrong on the device side.

      **The note about `okcore.cpp:7645` was wrong** — two unrelated features
      that share a word. FIDO2's `hmac-secret` is in `fido2/ctap_parse.cpp` and
      `fido2/ctap.cpp`; `okcore.cpp:7645` is inside `process_setreport()`, the
      Yubikey-style HMAC-SHA1 challenge-response that arrives over the KEYBOARD
      interface and is tagged `OKHMAC`. The null-pointer patch is elsewhere
      again — `set_built_in_pin()` near line 855 — and the dispatcher reaches it
      only on a DUO with an uninitialized device. Nothing here goes near any of
      the three.
- [x] `credProtect` — `01-protocol/16-credprotect`, 4 tests, ungated
- [x] Resident keys — `01-protocol/17-resident-keys`, 4 tests, ungated
- [x] `credMgmt`, `CLIENT_PIN`, `RESET` — `01-protocol/18-clientpin-credmgmt`,
      5 tests, gated on the new `fido-reset` capability
- [x] The plane-3 tunnel: `lib/device/tunnel.js` plus
      `12-webauthn-tunnel.test.js`, passing on both adapters. `OKCONNECT`
      through a fabricated `allowList` credential ID returns the device's
      X25519 handshake key and a status string that **matches what the vendor
      interface reports** - two transports, two firmware paths, one answer
- [x] The vendor commands that ride it. `OKGETPUBKEY` answered INVALID_COMMAND
      on a hand-rolled first attempt, and rather than working its option bytes
      out, `03-gui/03-xwing-derive` lets the shipped library send them. The
      derive path is covered; the other tunnelled commands are not

## Stage 5b — the rest of plane 1

**Why:** half the vendor interface has never had a byte sent at it, and the
slot fields are worse — two of twenty-eight.

- [x] ~~`OKGETRESPONSE` first: every large payload depends on it~~ — no such
      mechanism; the path is `send_transport_response()` pushing unsolicited
      reports, tested by `13-large-response`
- [x] `OKGETPUBKEY` / `OKSIGN` / `OKDECRYPT` across the six key types — five in
      `14-stored-keys`, and RSA in `19-rsa-keys`. **All six are now covered.**
- [x] `OKSETPRIV` / `OKWIPEPRIV` beyond the backup-passphrase slot — and the RSA
      wipe is pinned as it ships: `rsa_priv_flash()` returns from its `wipe`
      branch before writing the key type, so the slot keeps reporting a key. See
      TODO
- [x] ~~`OKPING`, `OKHMAC`, `OKWEBAUTHN`~~ — not messages; internal tags and a
      dead id
- [x] Slot fields beyond label and password — 27 of 29 cases, by
      `11-cli-settings`, `12-cli-slots` and `13-cli-lifecycle`. Left: case 10
      (`YUBIAUTH`) and case 29
- [ ] `OKFWUPDATE` last, emulated-only and mechanically gated — it locks the
      bootloader and permanently converts a developer key into a production key,
      so it is driven only to its interlocks and never past them

## Stage 6 — the sections that need a display

- [x] Section 3's headless tier is started (`03-gui/00-fido2-lib`, 6 tests):
      `lib/webenv.js` supplies the browser surface and points
      `navigator.credentials.get()` at `lib/device/ctap2.js`, and the real
      library completes an OKCONNECT handshake over the in-process bus. Its
      tunnel encoder is checked byte for byte against `lib/device/tunnel.js`,
      and both are checked against the device
- [x] `01-age-pqc-parity`: the web app's X-Wing maths against the same fixed
      vector, which found this kit's stale identity encoding
- [x] `02-derive`: `derive_public_key` / `derive_shared_secret` through the
      library, which the old kit could only reach through a browser. Needs the
      device's `derivedkeymode` bit 3 set, which the kit does over its own
      vendor interface (`OKSETSLOT` slot 1 field 21) rather than shelling to
      onlykey-cli - reaching for the CLI would drag `client-access` in and take
      the file out of CI
- [x] `03-xwing-derive`: the derived X-Wing path end to end against the
      emulated device, finished with BOTH this kit's maths and the web app's.
      This is what `10-fido2-xwing-derive` was blocked on
- [x] `04-age-file`: the age v1 container the web app writes itself - header
      shape, the STREAM chunk boundaries, and failures separated by KIND
- [x] `05-composite-blob`: the 160-byte composite layout, checked against
      `okpqc.h` and `pqc.py` as source files rather than against itself
- [x] `06-composite-key`: generation through the vendored openpgp fork, and the
      blob checked against the PUBLIC key beside it rather than against itself
- [x] `07-pgp-keys`: the PGP layer's key selection - primary signs, subkey
      encrypts, and which key a message names
- [x] `08-pgp-encrypt-decrypt`: `startEncryption` / `startDecryption`, all five
      of `_$mode()`'s modes, against a classic RSA key the file loads into the two
      slots `slotid()` hardcodes. The key comes from openpgp.js and the device
      gets only its factors, so the library's output is judged by an
      implementation that has never spoken to the device - a signature it verifies
      is one a correspondent would verify. Two client findings, in TODO
- [x] ~~**The headless tier is complete.**~~ **It was not**, and this row said it
      was until 2026-08-05. The claim was that everything reachable without a HID
      node was covered and that what remained needed `onlykey-cli setpqc` - true
      of the PQC page and **false of the classic pages**, whose key goes in over
      the vendor interface. `08-pgp-encrypt-decrypt` is what was missing, and the
      way the gap hid is worth more than the gap: a row that names its blocker
      correctly for ONE case reads as covering every case beside it. The tier is
      complete now, with `startEncryption`/`startDecryption` the last thing in it
- [ ] **In section 2, not here:** read a file written by the real `age` binary
      with `age_file.js`. That needs the plugin, and decrypting one needs a
      device, so it belongs beside `03-pqc-decrypt`
- [x] Section 3's browser tier is standing up: `lib/gui.js` runs the web app's
      own express server and nw.js as TWO separate process groups, and drives
      the window over CDP with Node's built-in WebSocket - no dependency, and no
      `ensure.js`-style cleanup, because a crashed browser can no longer orphan
      the server it never owned. `10-session` starts them, `19-stop` stops them
      and asserts the ports came free
- [x] `11-password-generator`: the first test in the kit where the device call
      goes THROUGH THE BROWSER - Chromium's own WebAuthn over the USB gadget -
      and it cross-checks the page's answer against the same derivation done by
      this kit over the in-process bus. Two clients, two transports, one device,
      one secret
- [x] `12-age-derive`: the whole derived X-Wing feature in one page - label to
      identity, seal, and open again - plus the assertion that makes it worth
      having: **an age file sealed by the browser is opened by this kit**, with
      its own maths and its own transport. Self-consistency would have proved
      nothing; interoperability is the thing that breaks quietly
- [x] `14-gui-encrypt-decrypt`: the classic PGP pages in nw.js, all five modes,
      with the device reached by Chromium's own WebAuthn over the USB gadget. The
      pairing with `08` is what makes it worth having - the library was proven
      first, so a failure here is the page, and the two findings it produced are
      both about wiring rather than about crypto.

      **One of them is in THIS kit and had been claimed-but-false for weeks.**
      `Page.close()` closed the debugger socket and left the tab running;
      `11-password-generator`'s "closes its window" test asserts the opposite in
      its own comment. Nothing noticed because no file had ever opened a SECOND
      page in one session. It does not present as a leak either: Chromium allows
      one WebAuthn request at a time PER BROWSER, so an abandoned tab whose
      startup OKCONNECT is still outstanding kills the next page's handshake with
      `OperationError: A request is already pending`, the page swallows it, and
      the run dies on the inactivity watchdog pointing at the device. Fixed, and
      `14` now waits for each page's handshake to land before doing anything -
      which is also an assertion worth having on its own.

      The other is about the pages: **the recipients field is a tokenizer**, not
      the `<input>` it looks like, and it escape()s its value into a hidden
      element. That is what `startEncryption`'s `'-----BEGIN%'` branch is for, and
      it is the only way an armored key fits in a field that strips newlines. See
      TODO for the other two page mechanics.
- [ ] **`pgp-pqc`, attempted and backed out** - the page's own workflow works and
      the last step does not. What was established, so the next attempt starts
      here rather than rediscovering it. The working copy is `wip/`, which the
      runner does not glob, so it is kept without being run - it was previously
      left in a session temp directory and came within a cleanup of being lost.
      The `lib/pqc.js` diff that sat beside it is deliberately NOT kept:
      `f2d78da` landed a better version of it, whose AbortController replaces a
      `done` flag that left waits outstanding in `device.pending`:

      - **Everything below the page is now proven, which is the whole change
        since the attempt.** `02-cli/06-composite-ops` runs TC-11 end to end
        with no browser: the 1088-byte ML-KEM half (five chunked sends), one
        `openpgp.decrypt()` driving BOTH hooks and both challenges, and one
        `openpgp.sign()` driving both signature halves with the result verified
        against the published public key. That last one is the maintainer's own
        acceptance criterion for TC-11, and it is the only assertion here that
        needs no trust in this kit's arithmetic - a shared secret is checked by
        recomputing it, a signature by the public key a correspondent would use.
      - It also covers the opposite firmware path from decryption. Decrypt is a
        large REQUEST (1088 in, 32 out); sign is a large RESPONSE (32-byte
        digest in, a 3309-byte ML-DSA-65 signature back), which is where the
        alpha kit's hardest bug lived: `store_FIDO_response()` dropped anything
        that did not fit and the device then blamed the challenge PIN. This
        firmware carries the fix (`LARGE_RESP_BUFFER_SIZE` 3328, and both
        `device.cpp` bugs commented at the fix site).
      - So the page is now the ONLY untested layer, which it was not before.
        When it was backed out, the two-challenge decrypt had never been run
        anywhere - not headless, not in section 2 - so the browser was never
        actually established as the variable. It is now.
      - The workflow itself is right and 10 of 12 tests passed: the PAGE
        generates a composite key, displays the blob and tells you to run
        `onlykey-cli setpqc <slot> <hex>`, the kit runs exactly that, and the
        page then encrypts host-side. That seam - a browser that cannot reach
        OKSETPRIV handing hex to a command line that can - is the feature's real
        shape and worth testing exactly that way.
      - **The challenge cannot be predicted here**, unlike everywhere else: an
        openpgp signature is over subpackets the page assembles. But it does not
        need to be. `done_process_packets()` prints `Received Message` followed
        by `byteprint(packet_buffer, packet_buffer_offset)` - the exact bytes it
        is about to hash - so the digits can be READ. Note `Serial.print(b, HEX)`
        does not pad, so `0x05` prints as `5` and naive joining shifts every
        byte after the first small one.
      - **A composite decryption raises TWO challenges, not one.**
        `registerCompositeHooks` wires both `hooks.ecdh` and `hooks.mlkemDecaps`,
        and openpgp needs both halves. Answering only the first leaves the second
        unanswered and the page reports "Composite operation abandoned by the
        device" for an operation that was half done - one `CTAP1_SUCCESS` in its
        console, then an abandonment.
      - Answering repeatedly IS the fix and `confirmFromConsole()` now does it
        correctly - proven against section 2's own composite sign and decrypt,
        which it drives end to end. `06-composite-ops` uses it for the decrypt
        and keeps predicted digits for the signature, so both mechanisms stay
        live: predicting proves this kit derives what the firmware derives,
        reading is what a page needs.
      - So the helper is no longer the suspect, and neither is anything under
        it. What remains unexplained is the PAGE: its console shows PENDING,
        PENDING, SUCCESS - one operation completing - and then nothing further,
        with `#pgp_plaintext_out` never filling. The next thing to find out is
        whether openpgp's second hook is ever invoked, which means instrumenting
        the page rather than the kit.
      - **The instrumentation seam already exists and needs no change to the web
        app.** `pgp-pqc.js` sets `window.__pgpPqcTestHooks` = `{ openpgp,
        compositePgp, hardwareKeyForCurrentSlot, ok }` - the LIVE transport
        included. Wrapping `ok.composite_decrypt` over CDP records every device
        call, and the two halves are distinguishable by argument size alone: 32
        bytes is `hooks.ecdh`, 1088 is `hooks.mlkemDecaps`. That answers the
        question above in one run. (Its comment still names
        `onlykey-testing/test/17-gui-composite-pgp.js`, a path in the ALPHA kit -
        the hooks were built for a test that was never finished.)
      - The page reports its errors in `#pgp_decrypt_status` etc., so a failure
        message should read those as well as the console.
      - Its decrypt handler's comment says the challenge is confirmed "once".
        `registerCompositeHooks` wires two hooks and the fork awaits both, so the
        comment is wrong - worth noting only because a stale comment there hints
        the two-challenge path was never run by hand either.

- [ ] The pages that are left: encrypt, decrypt, pgp-pqc. `vault` and `chat` are
      placeholders and are not on the list. Every feature these three call is
      already proven at the library level - encrypt and decrypt as of
      `08-pgp-encrypt-decrypt` - so a failure there means the PAGE, which is the
      whole reason the tiers are split. Unlike the two pages already done they are
      NOT self-contained: all three need a key the device actually holds. **Only
      pgp-pqc carries the section-2 prerequisite**, because loading a COMPOSITE
      key needs `onlykey-cli setpqc` and `OKSETPRIV` is not reachable over the
      browser transport. The classic pages' key goes in over the vendor
      interface, which the kit does itself
- [ ] **`localhost`, never `127.0.0.1`.** WebAuthn refuses an IP address as an
      rpId, so a page served from `127.0.0.1` dies with "SecurityError: This is
      an invalid domain" before the device is contacted - and the pages swallow
      their errors, so the only symptom is an output box that never fills. Worse,
      the RPID is folded into the derivation, so a page on `localhost` derives a
      DIFFERENT key from one on `onlyagent.app`: any cross-check has to ask the
      kit for the same rpId the browser will use
- [ ] **The ordering that is not optional:** the app's pages talk to the device
      as they load, and one opened before the OnlyKey is unlocked has its
      startup OKCONNECT time out - at which point Chromium raises a NATIVE
      WebAuthn dialog, an OS window no CDP command can dismiss, and the session
      is wedged until restarted. Device up and unlocked first, always. The
      landing page in `tools/nwjs` makes no device call, which is what makes it
      safe to start on
- [ ] **Section 4, the OnlyKey app.** This row said "never driven from a harness
      at all" until 2026-08-06, and that is **false**: the App ships its own
      selenium + mocha suite in `OnlyKey-App/test/`, driving nw.js's bundled
      chromedriver. What is true is that the suite proves the UI against a
      **mocked `chrome.hid`** and never against a device - the mirror image of
      every other section here. Two things measured while correcting this, both
      of which change what adopting it would cost: the suite **does not run as
      shipped** (`test/serial.js` requires `node-hid`, which is not a dependency
      of that repo), and `chromeHid._sent` **records only mock traffic**, so it is
      not the free instrumentation seam it looks like. TODO's §5 carries the
      detail and the three device-selection gates
- [ ] Services started and stopped by *visible* test files at the section
      boundaries, never hooks; cleanup tracks process groups, because nw.js can
      crash and orphan the server it spawned holding a port

---

## Stage 7 — section 5, security

**PLANNED, NOT BUILT, AND DELIBERATELY AFTER THE SWEEP.** Written down now
because the reasoning is fresh and because the two harness changes it needs are
easier to justify while the runs that motivated them are still in the log.
TODO carries the rows; this is why they exist.

### Why it is a section rather than tests scattered through the others

**Every section so far is organised by what a test NEEDS to run.** That is not a
filing convention, it is the whole design: section 1's admission test is "does
this reach the device without a kernel device node", which is exactly why it runs
on a hosted runner and against a physical key, and why section 2 can do neither.
The sections are a statement about transport and environment.

**Security is organised by INTENT, and intent cuts across all of that.** A
malformed vendor write is section-1-shaped, a CLI that reports success for a
refused load is section-2-shaped, and an origin check is section-3-shaped;
grouping them by where they run scatters the one property they share. So it gets
a section, and a section needs an admission test as sharp as section 1's or it
becomes a junk drawer:

> **Does this send something the device should REFUSE, or look for something it
> should not REVEAL?**

Negative-space testing. Everything else in this kit asks whether a feature works;
this asks whether a non-feature is absent. A test that ends up here because it
"feels security-related" while actually asserting that something WORKS belongs in
its own section, and the rule is what makes that call without an argument.

**No deliberate security pass has ever been run against this firmware here.**
Every finding to date arrived sideways - the RSA slot tail was found by reading
code while writing a coverage test, the RSA-4096 overflow by loading a key a
feature needed, the `last_request_opt3` clobber by a scripted caller doing what
no human was fast enough to do. That is a strong prior that the surface repays
looking at on purpose, not a claim that it is unsound.

### Two harness prerequisites, before any test in it is written

Both are load-bearing enough that a security test written without them would
produce confident nonsense, so they land first.

**1. A dead device host must be a RECORDED RESULT, not the end of the run.**
Today a firmware crash aborts everything with exit 2 or 5, and for coverage that
is exactly right - a device that died mid-suite invalidates whatever came after
it. Here it is useless, because **"the device died" IS the finding**. The
RSA-4096 overflow demonstrates both halves: it aborts the device host, so
`23-rsa-tunnel` has to gate that case off behind `OKT_EXPECT_RSA4096_FIX=yes`
just to let the file land, and a test cannot observe the abort from the inside
because the runner classifies a dead host as a run-level abort before any
assertion executes. The section needs a runner mode where a crash is captured
with its evidence - the signal, the addon's `[okemu] FATAL:` line and backtrace,
the request that caused it - and the next case continues against a fresh host.

**2. No negative assertion counts unless a POSITIVE CONTROL in the same test
fires.** A gate, in the same class as `--isolate` and `--reverse`, because it
catches the same kind of silent wrongness. A section built on "the device did
not reveal X" is a section where a broken instrument reads as a pass, and this
kit has already produced three of those in a single day:

| what read as absence | what it actually was |
|---|---|
| no plaintext in the RSA slot tail | `pqc.readyForKeygen()` RESTARTS, and a reboot zeroes the global that held the residue |
| still no plaintext, second attempt | `flash.bin` is word-reversed, so the search was looking for the wrong byte order |
| silence from an unknown vendor message id | a CTAPHID error frame on the vendor interface - the test expected silence and was wrong |

The first two would have closed a real finding as "nothing there". The pattern to
generalise is `01-protocol/22-rsa-slot-tail`'s: it writes a known marker through
a path that is NOT encrypted, finds it, and only then believes an absence
elsewhere in the same dump. Stated as a rule - **prove the instrument in the same
test, or the absence means nothing.**

### Gating

**Emulated-only by default, hardware behind an explicit opt-in** - the shape
`fido-reset` and `full-wipe` already use, with the reason string naming the cost.
Provoking malformed writes, oversized lengths and deliberate crashes against a
physical key is a separate risk conversation, and the gate is where that
conversation gets recorded rather than assumed.

### The instruments already exist, which is what makes this cheap

Nothing here needs new transport work. The pieces were all built for coverage and
each happens to be a security instrument as well:

| instrument | what it gives a security test |
|---|---|
| `lib/device/transit.js` | seals ARBITRARY bytes to the device, so a request can be malformed after encryption rather than before |
| `lib/device/ctap2.js` | speaks CTAPHID directly - frames, channel ids, commands the firmware does not implement |
| `okmsg.build` | frames vendor messages by hand, so every field can be wrong on purpose |
| `flash.bin`, dumpable | reads the device's storage out of band, which is how "should not reveal" is checked at all |

**And `_FORTIFY_SOURCE` is the part a physical key cannot offer.** The emulator
builds the firmware with it, so a buffer overflow ABORTS at the point of the
overflow instead of corrupting whatever was next in memory. That is how the
RSA-4096 one-byte overflow was found and it is a capability, not an accident: on
real hardware the same write lands silently and surfaces - if it surfaces at all
- as something unrelated much later. It belongs in EXPLAINER's account of what
the emulator makes possible, and it is the single strongest argument for doing
this work here rather than against a key.

### Candidate rows, not exhaustive

- malformed and oversized length fields on every framed message
- out-of-order and forged continuation markers - `buffer[6]` means two different
  things in two chunked sends, which is a parser confusion waiting to be aimed
- `opt3` manipulation on the tunnel: the high-water mark is a *drop* rule, so it
  is also a replay and truncation surface
- **the zero-IV keystream reuse question on the transit box.** Every message in a
  session is AES-256-GCM with the SAME key and a TWELVE-BYTE ZERO IV, tag
  discarded - so it is one keystream XORed against every message both ways. That
  is the firmware's design and mirroring it is the only way to talk to it, but
  nobody has assessed whether it is exploitable in practice: what a passive
  observer of two messages recovers, and whether any message is attacker-chosen
- unknown vendor ids reaching the CTAPHID stack, which the dispatcher's
  `default:` hands to `recv_fido_msg()` - a parser reached by a path its callers
  did not intend is the classic shape
- **the KEYBOARD interface, which is the largest item in the section and the one
  with the clearest argument.** `process_setreport()` (okcore.cpp:7638) is a
  third command channel beside the vendor interface and the tunnel: slot
  selection, HMAC-SHA1 challenge-response, Yubico OTP keys, a device-wide
  TYPESPEED write. It is guarded by `unlocked`, `check_crc()` and a
  `CRYPTO_AUTH` interlock, and it is inert while locked - but it reaches
  `set_private()` and `recvmsg()` DIRECTLY, so it never passes the
  `case OKSETPRIV:` guard where config mode and the user-slot allow-list live.
  The firmware's own comment says as much. It survives on production keys where
  SEREMU does not, and it is untested because the harness cannot reach it -
  the IPC verbs the HMAC row needs are the same ones this needs. **Unexamined
  for a structural reason rather than a considered one**, which is the same
  shape as the OnlyKey App's tests running against a mocked `chrome.hid`, and
  the reason both belong on a list rather than in somebody's head. TODO carries
  the detail and the one open question, marked UNVERIFIED: whether a local
  unprivileged process reaches a keyboard interface more easily than `0xFFAB`,
  per OS. The web path is closed - browsers refuse keyboard-usage devices in
  WebHID - so the local one is the unknown
- refusal paths asserted WITH controls: every "Error not in config mode" and
  "Error device locked" is a security property arriving where a client sees it,
  and each is worth one test that proves the operation would otherwise have
  succeeded

---

## Loose ends

- [x] **A boot that segfaults is now retried**, and the whole exit
      classification is checked in the sanity section rather than only by
      whatever a run happens to produce. `classifyExit()` is a pure function;
      `00-sanity/05-exit-classification` covers all eight outcomes, including
      the two that used to need a rare real crash to reach.

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
