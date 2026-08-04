# Plan

Stages, in the order they are worth doing. [EXPLAINER.md](EXPLAINER.md) is the
design and its reasoning; [README.md](README.md) is how to use what exists.
This file is what is left.

Counts are as of 2026-08-04, both adapters green:

| | emulated | hardware |
|---|---|---|
| section 1 | 56 passed, 0 failed, 3 skipped | 47 passed, 0 failed, 12 skipped-with-reason |

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
      venv, driven by visible start/stop test files rather than hooks

## Stage 4 — the PINs we set every run and never test

**Why:** `PINS.secondary` and `PINS.selfDestruct` appear exactly once each in
the suite, both in `07-unlock` as *negative* assertions. Every run provisions
all three and exercises one.

- [ ] Second profile: unlock into it, confirm it is a different profile with
      different slot data, confirm it does not see profile 1's
- [ ] Self-destruct: emulated only — it factory-resets, which on a key means a
      reflash. Gate it on a capability that says exactly that

## Stage 5 — CTAP2, not just CTAPHID

**Why:** `09-fido-ctaphid` covers `INIT` and `PING` — the transport. A real
ceremony needs a button press for user presence, which this kit can now do; the
old kit needed a browser for it.

- [ ] MakeCredential with a real user-presence press
- [ ] GetAssertion against that credential; verify the signature in pure JS
- [ ] The `okcore.cpp:7645` null-dereference patch is **still unproven** —
      nothing reaches the HMAC challenge-response wipe path. An HMAC test would
      close it

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
