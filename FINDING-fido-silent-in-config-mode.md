# The FIDO2 interface does not answer while the device is in config mode

**Component:** firmware (`libraries/fido2` + `libraries/onlykey`).

**Severity:** availability, silent. A user in config mode has **no WebAuthn and
no U2F** — every FIDO login on that device stops working until they reboot it.
Nothing is disclosed and nothing is corrupted; the endpoint simply does not
answer, so the browser reports a generic timeout and nothing anywhere says
"config mode".

**Measured by:** `01-protocol/26-fido-in-config-mode.test.js`, 4/4, **emulated**.
**Wants one hardware confirmation before it goes upstream as a firmware claim** —
see the caveat at the end.

## The measurement

The same CTAPHID INIT, on the same device, in one session, three times:

```
CTAPHID INIT before config mode: answered
CTAPHID INIT in config mode:     no reply
OKCONNECT over the bridge:       no reply
CTAPHID INIT after leaving:      answered

before=true  during=false  duringBridge=false  after=true
```

The before/after pair is the whole design of the test. A bare "it timed out in
config mode" has at least three other explanations — an unattached FIDO
interface, a device still busy from the five-second press, a harness fault — and
measuring the identical call immediately either side of the state change removes
all of them. It answers, stops answering, and answers again; the only variable
left is config mode.

Both layers are silent: raw CTAPHID (the FIDO transport itself) and the OnlyKey
WebAuthn bridge (`bridge_to_onlykey()`'s OKCONNECT handshake) on top of it.

## Why it is surprising

`configmode` appears **nowhere** in `libraries/fido2/`. okcore.cpp's
config-mode allow-list (line 347) filters `process_packets()` — the raw-HID
dispatch — which is a different entry point from `bridge_to_onlykey()`. So by
reading the sources, FIDO should be unaffected by config mode entirely.

It is not, and the mechanism has not been located. That is worth saying plainly:
this finding reports a **behaviour**, not a diagnosis. Whatever suppresses the
FIDO endpoint in config mode is not the obvious allow-list, and somebody who
wants to change it will have to find it first.

## Why it matters on its own

Config mode is not an exotic state. It is what a user enters to load a key,
change a slot, or set a backup passphrase — routine administration, done from
the OnlyKey app, and it persists until the device is rebooted. During that whole
window:

- WebAuthn logins fail on every site.
- U2F second factors fail.
- Nothing tells the user why. The device is plugged in, lit, and unlocked; the
  browser just times out.

A user who configures a slot and then tries to log in somewhere will conclude
their security key is broken. The fix, if it is one, may be as small as
documenting it — but at the moment it is neither documented nor discoverable.

## Is it deliberate?

Unknown, and the answer changes what should happen next. If suppressing FIDO
during configuration is intentional defence-in-depth, it should be **documented**
and should ideally fail loudly rather than silently. If it is incidental — a
side effect of how config mode parks the main loop — it is a bug.

Nothing in the sources or comments says either way, which is itself part of the
finding.

## Emulator caveat

This was measured on the emulator. The behaviour looks structural rather than
timing-dependent, so it should reproduce on a Teensy, but **it has not been
checked on one**, and "the FIDO endpoint goes quiet" is exactly the shape of
claim that a host-side or emulator-side artifact could counterfeit. One
confirmation on real hardware — enter config mode, attempt any WebAuthn
ceremony, reboot, attempt it again — is enough, and should happen before this is
filed upstream as a statement about the firmware.

---

## Appendix: the design thread this closed (parked)

Recorded here because it is where the question came from, and because the
conclusion is "do not build this", which is worth being able to find later.

**A browser cannot load a key onto the device.** Loading needs `OKSETPRIV` (or a
dedicated, narrower `OKSETPQC`), the firmware permits either only in config mode
or on first use, and a browser's only transport is WebAuthn — which the
measurement above shows is silent in exactly that state. A dedicated `OKSETPQC`
is genuinely the better-shaped command (a composite key is always type `0x67`
and always 160 bytes, so it needs no keytype byte and sidesteps the
`recv_buffer[6]` collision entirely, and it is far less to review than a general
private-key write from a web origin) — but none of that helps when the transport
is unavailable in the only state the write is permitted in.

**A RAM-only key does not rescue it either**, and the reason is stronger than
"another slot would clobber it". `rsa_private_key[]` is a single 512-byte global
(`okcrypto.cpp:149`); `okcore_flashget_RSA(slot)` overwrites it from flash; and
**both** `okcrypto_sign()` (`okcrypto.cpp:186`) and `okcrypto_decrypt()`
(`okcrypto.cpp:352`) call it unconditionally at the top of every RSA-slot
operation, *before* dispatching to `okpqc_sign()`/`okpqc_decrypt()`. The
dispatch path to the PQC code runs **through** the refill that would destroy the
key, so a RAM-resident key would not survive to its own next use, never mind
another slot's.

There is a second, independent blocker: `okcore_flashget_RSA()` reads the key
type from EEPROM and returns early when it is zero, and the dispatch to
`okpqc_sign()` is gated on that EEPROM byte being `KEYTYPE_PQC_PGP`. So a
RAM-only key would need an EEPROM type write anyway, plus its own buffer that
nothing refills — most of a flash write, with none of the persistence.
