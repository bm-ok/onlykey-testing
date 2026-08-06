# Writing an HMAC key silently removes that slot's button-press requirement

**Component:** firmware, `libraries/onlykey/okcore.cpp`, `process_setreport()`
**Severity:** low-to-moderate, and bounded by reachability rather than by
impact - it needs an already-unlocked device (see "What this is not").
**Measured:** 2026-08-06 against the OnlyKey emulator, firmware `v3.0.4-testc`,
by `onlykey-testing`'s `01-protocol/24-hmac-sha1-challenge`.
**Status:** measured, with a positive control. Not previously reported.

## What happens

Writing an HMAC-SHA1 key through the keyboard interface's control-transfer
channel also, and without saying so, sets that slot's challenge mode so the slot
no longer requires a button press. Afterwards, any host that can reach the
keyboard interface can obtain HMAC-SHA1 responses from that key with no physical
presence at all.

Nothing in the write acknowledges it. The device answers the write exactly as it
answers any key write, and the presence requirement is gone.

## Why

`process_setreport()` handles the key write. On the success path it computes a
new challenge mode from the current one (`okcore.cpp:7703-7715`):

```c
uint8_t mode = 0;
okeeprom_eeget_hmac_challengemode(&mode);
if (mode==1) {                      // both slots already press-free
} else if (mode==recv_buffer[5]) {  // this slot already press-free
} else if (mode) {                  // the OTHER slot is press-free
    mode = 1;                       // now BOTH are
} else {                            // neither was
    mode = recv_buffer[5];          // now THIS one is
}
```

and then stores it, gated only on the key having been written as an HMAC key
(`:7727`):

```c
if (KEYtype == 9) {
    okeeprom_eeset_hmac_challengemode(&mode);
}
```

**Every branch leaves the slot just written press-free.** From the default of 0
("physical presence required") a first write sets `mode` to that slot; a second
write to the other slot escalates to `1`, which is *both* slots. There is no
path through this block that writes a key and leaves presence required.

The challenge branch then honours it (`okcore.cpp:~7868`):

```c
if (hmac_challenge_disabled == 1 || hmac_challenge_disabled == crslot) {
    CRYPTO_AUTH = 4;
    okcrypto_hmacsha1();   // answered inline, no press
```

The default really is press-required, which the wipe path confirms by restoring
it (`:7691`):

```c
{ uint8_t zero = 0; okeeprom_eeset_hmac_challengemode(&zero); } // Reset to default both slots require button press
```

## This is DELIBERATE, and that is the point

The source says so, at `:7705`:

```c
// Authlite requires no press required
```

So the behaviour is intended: Authlite needs challenge-response without a
touch, and this is how the device provides it. **The finding is not that the
device can be press-free.** It is that a user-presence requirement is removed as
a *side effect* of writing a key, with:

- no separate opt-in - it is not a flag the caller sets, it is inferred,
- no acknowledgement - the write's reply is the ordinary key-write reply,
- no way to write a key and KEEP presence, short of wiping the slot afterwards
  (`:7691`), which also destroys the key,
- and escalation - writing the second slot moves the setting from "this slot"
  to `1`, meaning **both** slots, including one the caller did not touch.

A maintainer may well read all that and decide it is correct for Authlite. The
reason to report it is that nobody can make that call about behaviour that is
not written down anywhere, and a user who loads an HMAC key to use with, say,
KeePassXC has no way to learn that their key's touch requirement went away.

## What this is NOT

Stated as carefully as what it is, because the reachability is what bounds it.

**Not remotely reachable.** The whole branch is gated `initialized && unlocked`
(`okcore.cpp:7657`), so it needs a device that is already provisioned *and*
already unlocked - which means the PIN has already been entered on the device
itself. An attacker who has that has a great deal more than this.

**Not a way to extract the key.** The HMAC key never leaves the device. What is
removed is the presence check on *using* it.

**Not comparable to the RSA-4096 overflow**
([FINDING-rsa4096-overflow.md](FINDING-rsa4096-overflow.md)), which is an
out-of-bounds write reachable from a normal client. This is a policy bit changed
by a legitimate operation, and it sits well below that.

**Not a claim about local attack surface.** Whether an unprivileged local
process reaches a keyboard interface more easily than it reaches the vendor
interface `0xFFAB`, and whether that differs per OS, is UNVERIFIED here and is
an OS-permissions question rather than a firmware one. The web path is closed -
browsers refuse keyboard-usage devices in WebHID - so the local one is the
unknown. That question decides how much this matters and this write-up does not
answer it.

**Not observed on hardware.** Measured on the emulator only, because the kit's
hardware adapter does not implement the control transfers this channel needs.
The mechanism is firmware rather than emulation, so it should hold on a key, but
that is reasoning rather than measurement.

## How it was measured

`01-protocol/24-hmac-sha1-challenge` drives both paths against the emulated
device over the real control-transfer channel:

1. **The press-free path.** Write a 20-byte key to HMAC slot 1, then challenge
   that slot. The answer arrives with **no press given and none requested** -
   the device's own "Waiting for challenge buttons" count is asserted UNMOVED,
   so the answer cannot be explained by something else having pressed a button.
   The response is checked against `node:crypto`'s HMAC-SHA1 over the same key
   and challenge (`26243c20b3a667b208be4cdc899da46f849c3387` on both sides), and
   its CRC against the reassembled digest.
2. **The press-required path, as the control.** Writing slot 1 sets the flag to
   130, so slot 2 (129) still demands presence. A challenge to slot 2 stages
   nothing, and the same challenge answers once a button is pressed. Without
   this half, "no press was needed" would be consistent with a device that
   cannot ask for one.

Both tests pass `--isolate` and `--reverse`.

## Suggested fix

If the Authlite behaviour is to stay, make it explicit rather than inferred:
carry the desired challenge mode in the write itself so a caller has to ask for
press-free, and acknowledge the resulting mode in the reply so a client can see
what it has. Failing that, documenting it would close most of the gap - the
current behaviour is only a trap because it is unwritten.

The escalation to `1` on the second write is worth a second look on its own,
since it changes a slot the caller did not address.
