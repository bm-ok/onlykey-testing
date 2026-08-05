# Finding: `onlykey-cli` never maps failure onto its exit code

**Status:** measured across four test files in `onlykey-testing`, twelve
subcommands confirmed, `libraries@83353cf` / current venv.
**Severity:** not memory safety - correctness of the client contract. It matters
because it is what makes every other defect quiet: a script, a CI job or a
provisioning tool cannot tell a completed operation from a refused one.
**Shape:** this is **one class, not a pile of symptoms.** It has been reported
three times as three bugs (`setpqc` claiming success, `set-pin` claiming success,
`setkey` storing nothing on the 4096 path); those are three routes into the same
hole.

## The class

`onlykey-cli` exits 0 whether the operation succeeded or not. There are three
distinct routes, and they need different fixes, which is why they are separated
here rather than merged:

### (a) Prints its own success string without reading the reply at all

`setpqc` (cli.py):

```python
pqc.load_composite_key(only_key, slot_id, blob)
print('Loaded composite PQC PGP key (%d bytes) into %s' % (len(blob), sys.argv[2]))
```

No `read_string()` anywhere on the path. **Measured** (`02-cli/12-cli-slots`):
outside config mode the device sends three `Error not in config mode` replies and
the CLI prints "Loaded composite PQC PGP key (160 bytes) into RSA1" and exits 0.
The success message is a statement about what the CLI *sent*.

### (b) Reads the reply, prints it verbatim, never inspects it

`setslot` and `setkey` (client.py):

```python
self.send_message(msg=Message.OKSETSLOT, slot_id=slot_number, message_field=message_field, payload=value, from_ascii=True)
print(self.read_string())
```

The device's own words reach the user's terminal - and nothing tests whether they
begin with `Error`. **Measured** (`02-cli/11-cli-settings`): seven refusals across
the thirteen settings commands each printed `Error not in config mode` on stdout
and exited 0.

This route has a second failure mode that is worse, because there is no error
text to read either. **Measured today:** `onlykey-cli setkey RSA1 4 s <4096-bit
key>` exited 0 having printed a bare newline - `read_string()` returned empty, the
device stored nothing, and no error was reported anywhere. (That run is also one
outcome of the RSA-4096 overflow; the other outcome is the firmware aborting. See
[FINDING-rsa4096-overflow.md](FINDING-rsa4096-overflow.md).) So an empty reply is
treated as indistinguishable from a good one.

### (c) Catches a host-side exception, prints it, falls off the end

The `solo`-backed commands. **Measured** (`02-cli/14-cli-fido`): `credential`,
`set-pin` and `change-pin` all fail inside `solo` with
`AttributeError: 'Fido2Client' object has no attribute 'client_pin'` - solo calling
an API the installed python-fido2 has removed - and `set-pin` prints that
traceback text and exits 0. A script checking exit codes is told a PIN was set
when none was.

Note this route is a *different* bug from (a) and (b): the device answered
correctly and the client could not use the answer. It shares only the exit code.

## What is measured, and what is expected

**Measured - twelve subcommands:**

| route | commands | file |
|---|---|---|
| (b) | seven of the thirteen settings commands | `02-cli/11-cli-settings` |
| (a) | `setpqc` | `02-cli/12-cli-slots` |
| (b) | `setkey` (empty-reply variant, 4096 path) | measured 2026-08-05 |
| (b) | `init` - prints the same script whether it re-armed the PIN machine or did nothing | `02-cli/13-cli-lifecycle` |
| (c) | `credential`, `set-pin`, `change-pin` | `02-cli/14-cli-fido` |

**Expected to share it, not yet measured.** Every command that WRITES, because
they all bottom out in the same two client methods. By route:

- **(b), via `setslot`:** the remaining six settings commands, and the slot-field
  writers - `setslot`, `wipeslot`, `password`, `totpkey`, `gkey`.
- **(b), via `setkey`/`OKSETPRIV`:** `genkey`, `wipekey`, `backuppassphrase`,
  `restore`.
- **(a) or (b):** `loadpqc` and `loadkey` - they print an unconditional
  "Loading…"/"Loaded…" like `setpqc` but delegate to `setkey`, so they can fail at
  either layer. Their file-parse paths are the one section-2 row still open, so
  this is the natural thing to assert when that lands.
- **(c):** `wink`, `reset`, `loadfirmware` - the rest of the `solo` dispatch.

**Not expected to share it:** the six read commands - `version`, `fwversion`,
`getlabels`, `getkeylabels`, `ping`, `rng`. A failed read is visible as missing or
wrong output rather than as a false success. (`getlabels` has an unrelated defect:
it picks its slot layout with `okversion[19] == 'c'`, a fixed INDEX into the model
string, which lands on the hardware-variant character only for a version string of
exactly that length.)

That is **roughly 25 of the 37 subcommands** by inspection, of which 12 are
confirmed.

## Why it is worth fixing as a class

Every quiet defect found in this codebase so far was quiet *because of this*. The
RSA-4096 overflow presents as "exit 0, nothing stored". `setpqc` against a device
that refused presents as "Loaded". A `set-pin` that never ran presents as success.
A maintainer fixing three symptoms leaves the fourth and fifth in place; fixing
the contract retires the whole family.

## Suggested fix

Three small changes, one per route:

1. **A single reply check in `client.py`.** The device's failure vocabulary is
   already uniform - `hidprint()` sends `Error …` - so one helper does it:

   ```python
   def _expect_ok(self):
       reply = self.read_string()
       print(reply)
       if reply.strip().startswith('Error'):
           raise RuntimeError(reply.strip())
       if not reply.strip():
           raise RuntimeError('no reply from device')
       return reply
   ```

   Call it where `print(self.read_string())` appears today. The empty-reply case
   matters as much as the `Error` case - that is the 4096 path.

2. **`setpqc` (and `loadpqc`/`loadkey`) must read before they claim.** Move the
   "Loaded …" print after a successful `_expect_ok()`.

3. **`cli.py` must exit non-zero.** Its `except Exception:` blocks print and
   return; they should `sys.exit(1)`. That covers route (c) without touching
   `solo` - the underlying solo/python-fido2 version mismatch is a separate
   decision, tracked in the kit's TODO.

## A note for whoever tests this

`02-cli/14-cli-fido` asserts the CURRENT behaviour of `set-pin` and friends,
deliberately - a test whose subject is a known breakage should fail when the
breakage is fixed. So fixing this will fail that file, on purpose, and its
assertions need updating rather than reverting.
