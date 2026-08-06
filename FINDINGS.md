# Findings, and whether anybody has been told

Every defect this kit has found, with its reporting status. **The status column
is the reason this file exists**: the write-ups themselves say what was found and
how it was measured, and each is linked from the TODO row that produced it, but
until 2026-08-06 nothing anywhere recorded whether a finding had been SENT.
Every one of them was unreported and the repo could not say so - which reads, to
a cold reader, exactly like a repo whose findings had all been filed.

(Deliberately not written as a count. The first version of this paragraph said
"all six", which was true for about four hours - the seventh landed the same
day. A number here has to be maintained in step with the table below it, and
this file exists because unmaintained status claims are the problem.)

**Nothing here has been reported yet.** That is a fact about this repo, not a
judgement about the findings.

**#9 and #10 are FIXED but still unreported, and the two are different things.**
Both are python-onlykey defects fixed in the `bm-ok` fork and awaiting a PR, so
their `where` column says so rather than staying blank - a fix sitting in a
local fork has told the maintainer exactly as much as no fix at all. When the PR
goes up, put its number in `issue`.

**#8 is the one to read first if you only read one**, now that it is fixed as
much as for what it was. It was the only finding here that got harder to fix the
longer it waited — every part of it is bound into the composite key derivation,
so keys made before and after cannot read each other — and it is also the one
that grew under investigation: it began as "two constants are wrong" and ended as
three independent divergences from draft-ietf-openpgp-pqc-10, the second and
third only visible once the first was corrected. **One confirmed divergence is
not evidence that there is only one.**

**Severity is not a ranking of how alarming something sounds.** Two of these
(#2, #7) are bounded by REACHABILITY rather than by what they would do, and #7
is deliberate firmware behaviour whose defect is that it happens silently. Each
write-up says what it is NOT as carefully as what it is, and that section is the
one to read before deciding what to do about it.

| # | finding | component | severity | reported | where | issue |
|---|---|---|---|---|---|---|
| 1 | [RSA-4096 key load writes one byte past `rsa_private_key`](FINDING-rsa4096-overflow.md) | firmware (`libraries/onlykey`) | **out-of-bounds WRITE**, reachable from a normal client | **no** | — | — |
| 2 | [The RSA slot tail keeps 85 bytes of a previous key's plaintext](FINDING-rsa-slot-tail.md) | firmware (`libraries/onlykey`) | key material at rest; NOT reachable through a normal device operation | **no** | — | — |
| 3 | [`onlykey-cli` never maps failure onto its exit code](FINDING-cli-exit-codes.md) | python-onlykey | ~25 of 37 subcommands; a script cannot tell success from refusal | **no** | — | — |
| 4 | [Slot buttons are clickable ~1.2s before anything is bound](FINDING-app-slot-button-dead-window.md) | OnlyKey-App | low - usability | **no** | — | — |
| 5 | [The Yubico Public ID field discards a wrong-format value in silence](FINDING-app-yubico-silent-discard.md) | OnlyKey-App | low - usability | **no** | — | — |
| 6 | [The Tools tab links to an origin the firmware does not stage](FINDING-app-tools-origin.md) | OnlyKey-App | depends on one hosting fact - see the write-up | **no** | — | — |
| 7 | [Writing an HMAC key silently removes that slot's button-press requirement](FINDING-hmac-press-free-on-write.md) | firmware (`libraries/onlykey`) | low-moderate; DELIBERATE behaviour, silent side effect. Bounded by needing an unlocked device | **no** | — | — |
| 8 | [Composite PQC was three revisions behind the draft: private-range algorithm IDs, a hashed ECC key share, and a KMAC combiner](FINDING-pqc-private-algorithm-ids.md) | vendored openpgp.js fork (`onlykey.github.io` + `python-onlykey`) + `lib-agent` mirror | **interoperability, and was unfixable after release** - all three are bound into the derived KEK | **no** | **fixed** in the `bm-ok` forks (`onlykey.github.io@ef41bec`, `python-onlykey@4875e24`, `lib-agent@d3f894e`), PR pending. All four rpgp interop directions now pass | — |
| 9 | `pqc.sign()`/`pqc.decrypt()` could not return their own output | python-onlykey | binary output impossible: `read_string()` drops every zero byte, and `read_bytes()` underneath is ONE 64-byte report with no reassembly, so a 3309-byte ML-DSA signature could never be returned at all | **no** | fixed in `bm-ok` fork, PR pending | — |
| 10 | `setpqc` reported success for a load the device refused | python-onlykey | a client cannot detect it - there is no readback for a composite slot | **no** | fixed in `bm-ok` fork, PR pending; `02-cli/12-cli-slots` flipped from pinning the defect to asserting the refusal | — |
| 11 | `libagent/device/onlykey_pqc.py` is dead code - imported by nothing | lib-agent | the composite PQC path is unreachable from `onlykey-agent`/`onlykey-gpg`; 134 lines that look like a shipped feature | **no** | — | — |
| 12 | [The FIDO2 interface does not answer in config mode](FINDING-fido-silent-in-config-mode.md) | firmware | availability, SILENT - a user in config mode has no WebAuthn and no U2F, with no error from the device. Emulator-measured; wants one hardware confirmation before filing upstream | **no** | — | — |

## How to keep this honest

**When a finding is sent, fill in `reported`, `where` and `issue` in the same
change.** A row that says "no" when it has been filed is worse than no row: it
invites somebody to report it twice, which costs a maintainer's time rather than
this repo's.

**When a finding is FIXED upstream, do not delete its row.** Several of these are
pinned by tests written to fail the day the defect goes - `19-rsa-keys`' wipe
test, `15-app-advanced`'s silent-discard test, `03-gui/08`'s guard test. A fix
therefore turns a green test red on purpose, and the next person to see that red
needs this table to tell them it is the convention working rather than a
regression. Mark the row fixed and say which test will now fail.

**Severity here is the write-up's own claim**, not a scale applied afterwards.
Two of these deliberately do not carry a number: #2 because what bounds it is
reachability rather than impact, and #6 because it turns on a hosting fact this
kit will not establish.

## What is NOT in this table

Defects in this kit's own code, which are fixed here rather than reported. They
are in the git history and in the comments at the fix sites - the leaked HID
handle in `lib/device/hardware.js`, the ack loop in `04-app/12-app-keys`, the
`page.close()` that did not close. Those are worth reading for the same reason
the findings are, but nobody needs to be told about them.

Also not here: the two upstream repos this kit must not modify. `OnlyKey-App`,
python-onlykey and lib-agent are upstream checkouts, and section 4's whole value
is that it measures the App **as shipped** - patching one would make its tests
describe something nobody runs. Findings against them go in this table and
upstream, never into the checkout.
