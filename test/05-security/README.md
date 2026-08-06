# Section 5 - security

**The admission test, and it has to be this sharp or the section becomes a junk
drawer:**

> **Does this send something the device should REFUSE, or look for something it
> should not REVEAL?**

Every other section is organised by what a test NEEDS to run - section 1's rule
is "does this reach the device without a kernel device node", which is exactly
why it runs on a hosted runner and against a physical key, and why section 2 can
do neither. Security is organised by INTENT, and intent cuts across all of that:
a malformed vendor write is section-1-shaped, a CLI that reports success for a
refused load is section-2-shaped, an origin check is section-3-shaped. Grouping
them by where they run scatters the one property they share.

A test that lands here while actually asserting that something WORKS belongs in
its own section. The rule above settles that without an argument.

## The two rules that are not negotiable

**1. Every file declares `negative: true` and proves its instrument in every
test.** Run `okt run 05-security --controls` before committing; it is a gate in
the same class as `--isolate` and `--reverse`. Use `assert.control()` for the
thing that proves the instrument works and `assert.absent()` for the claim about
absence - `absent()` refuses to pass unless a control has already fired.

This is not bureaucracy. The kit has produced six absences that were its own
instrument, five of them in a single day:

| what read as an absence | what it actually was |
|---|---|
| no plaintext in the RSA slot tail | `readyForKeygen()` RESTARTS, and a reboot zeroes the global holding the residue |
| still none, second attempt | `flash.bin` is word-reversed - the search had the wrong byte order |
| silence from an unknown vendor id | a CTAPHID error frame on the vendor interface |
| "the Tools tab has six anchors and nothing else" | a regex that stopped at the first `<dialog>` |
| a run with "zero interface errors" | the runner did not subscribe to that event until nine minutes later |
| "the device did not stage an HMAC response" | a `keyboard_buffer` wiped five seconds after it landed |

The first two would have closed a real finding as "nothing there".
`01-protocol/22-rsa-slot-tail` is the pattern to copy: write a known marker
through a path that is NOT encrypted, find it, and only then believe an absence
elsewhere in the same dump.

**2. Emulated by default; hardware behind an explicit opt-in.** Provoking
malformed writes, oversized lengths and deliberate crashes against a physical
key is a separate risk conversation, and the gate is where that gets recorded
rather than assumed. Use the shape `fido-reset` and `full-wipe` already use,
with the reason string naming the cost.

## What this section must never do

- **Never drive `OKFWUPDATE`.** On a physical key it locks the bootloader and
  permanently converts a developer key into a production key. Anything that
  could reach it carries `requires: ['emulated']`, and note the door is on the
  App's Setup tab as well as its Firmware tab - see `04-app/16-app-setup`.
- **Never send a 4096-bit RSA key at hardware.** It is a known out-of-bounds
  WRITE (`FINDING-rsa4096-overflow.md`) and `_FORTIFY_SOURCE` - the thing that
  makes it safe to study - is the emulator's. On a key the same write lands
  silently.
- **Never modify anything under `onlykey/`.** Those are upstream checkouts. A
  finding goes in `FINDINGS.md` and upstream, never into the checkout.

## What makes this cheap: the instruments already exist

Built for coverage, each also a security instrument. Nothing here needs new
transport work.

| instrument | what it gives |
|---|---|
| `lib/device/transit.js` | seals ARBITRARY bytes, so a request can be malformed AFTER encryption |
| `lib/device/ctap2.js` | CTAPHID directly - frames, channel ids, commands the firmware does not implement |
| `okmsg.build` | vendor messages framed by hand, so every field can be wrong on purpose |
| `device.kbdSetReport` / `kbdGetReport` | the keyboard interface's control transfers - a THIRD command channel that bypasses the vendor dispatcher's config-mode gate |
| `flash.bin`, dumpable | reads storage out of band, which is how "should not reveal" is checked at all |
| `device.expectFatal()` | a crash captured as EVIDENCE, with a fresh host after it - so "the device died" can be a result instead of the end of the run |

And `_FORTIFY_SOURCE` is the part a physical key cannot offer: the emulator
builds with it, so an overflow ABORTS where it happens instead of corrupting
whatever was next. That is how the RSA-4096 overflow was found, and it is the
strongest single argument for doing this work here rather than against a key.

## Candidate rows, not exhaustive

See TODO's §6 for the full list and the reasoning. The largest single item is
the **keyboard interface** (`process_setreport()`), which reaches `set_private()`
and `recvmsg()` DIRECTLY and so never passes the `case OKSETPRIV:` guard where
config mode and the user-slot allow-list live - the firmware's own comment says
so. It is now reachable: the IPC verbs landed on 2026-08-06 and
`01-protocol/24-hmac-sha1-challenge` drives that channel end to end.

One open question is marked UNVERIFIED and decides how much that row matters:
whether a local unprivileged process reaches a keyboard interface more easily
than it reaches `0xFFAB`, and whether that differs per OS. The web path is
closed - browsers refuse keyboard-usage devices in WebHID - so the local one is
the unknown. It wants measuring per platform rather than reasoning about.
