# Finding: loading a 4096-bit RSA key writes one byte past `rsa_private_key`

**Status:** measured on the emulator, deterministic, `libraries@83353cf`.
**Severity:** out-of-bounds WRITE, reachable from a normal client
(`onlykey-cli loadkey` with any 4096-bit RSA key). Higher than the slot-tail
finding, which is read-only exposure at rest.
**Found by:** driving the RSA-4096 response boundary in `onlykey-testing`. The
emulator did the work here: `_FORTIFY_SOURCE` turns a silent one-byte corruption
into a loud abort, so this is a defect a physical key would not have surfaced.

## Summary

`rsa_priv_flash()` accumulates a key in fixed 57-byte `memcpy`s whose length is a
literal, never clamped to what remains in the destination. The guard threshold
varies per key type but the copy length does not, so the largest type runs one
byte off the end:

| type | key size | last offset passing the guard | ends at | |
|---|---|---|---|---|
| 1 | 1024 | 114 | 171 | safe |
| 2 | 2048 | 228 | 285 | safe |
| 3 | 3072 | 342 | 399 | safe |
| **4** | **4096** | **456** | **513** | **1 byte past a 512-byte array** |

Observed on the ninth chunk:

```
Slot =  2
Type =  68                              (4 | FEATURE_SIGN)
*** buffer overflow detected ***: terminated
```

## The buffer and the expression

`libraries/onlykey/okcore.cpp`, `rsa_priv_flash()`, the type-4 branch:

```c
else if ((buffer[6] & 0x0F) == 4)
{ //Expect 512 Bytes
    keysize = 512;
    if (buffer[0] != 0xBA && packet_buffer_offset <= 456)
    {
        memcpy(rsa_private_key + packet_buffer_offset, buffer + 7, 57);
        packet_buffer_offset = packet_buffer_offset + 57;
    }
}
```

The destination is `uint8_t rsa_private_key[MAX_RSA_KEY_SIZE]` -
`MAX_RSA_KEY_SIZE` is 512 (`okcore.h:210`), defined at `okcrypto.cpp:149`. The
offsets that satisfy `<= 456` are 0, 57, 114, 171, 228, 285, 342, 399, 456 - nine
of them - and the ninth copies 57 bytes to `rsa_private_key + 456`, touching
indices 456 through 512 inclusive. Index 512 is out of bounds.

## What triggers it - measured, both directions

- **Nine chunks at type 4: aborts.** Every time.
- **Eight chunks at type 4: device alive, no abort.** So the trigger is precisely
  the ninth copy, not the type byte alone.
- **The bytes do not have to be a key.** The eight-chunk probe sent
  `crypto.randomBytes(512)`, and the abort case is equally indifferent:
  `rsa_priv_flash()` never inspects the material. Nothing is validated until
  `okcore_flashget_RSA()` + `rsa_getpub()` at USE time, long after the write.
- **Only type 4.** Types 1-3 end at 171/285/399, all inside the array. A nibble
  above 4 that is not `KEYTYPE_PQC_PGP` is rejected with "Error invalid RSA type"
  before any copy. `KEYTYPE_PQC_PGP` (5) has its own branch bounded by
  `PQC_PGP_BLOB_LEN`; it writes past the 160-byte blob but stays well inside the
  512-byte array, so no fortify trip and no out-of-bounds write.

## Reachable from a normal client - yes

This is not a hand-built-client-only defect. python-onlykey's `setkey()`
(`client.py`) sends exactly nine chunks when `key_type & 0xf == 4`:

```python
elif key_type & 0xf == 4: # RSA 4096
    self.send_message(msg=Message.OKSETPRIV, slot_id=slot_number, payload=format(key_type, 'x')+value[:114])
    ... nine sends ...
    self.send_message(msg=Message.OKSETPRIV, slot_id=slot_number, payload=format(key_type, 'x')+value[912:1024])
```

and `_load_single_key()` picks the type from the key itself -
`rsa_type = key_size // 128`, which is 4 for any 4096-bit key. So
`onlykey-cli loadkey <4096-bit PGP key>` reaches it, as does any client following
the same framing (the OnlyKey App's RSA path is the other one to check).
Preconditions are only what `OKSETPRIV` always needs: unlocked and in config
mode.

**The value written differs by caller, and that is the part worth noting.** A
normal client's ninth chunk carries key bytes 456..511 - 56 bytes - so the 57th
byte copied is the report's own zero padding and the out-of-bounds byte is
`0x00`. A client that fills all 57 bytes of that final report controls the value
written past the array.

## What it lands on

Linker-dependent, so this is not asserted. The neighbours declared around it in
`okcrypto.cpp` are `rsa_publicN[512]` (line 148, immediately before) and
`ecc_public_key[(MAX_ECC_KEY_SIZE*2)+1]` / `ecc_private_key[MAX_ECC_KEY_SIZE]`
(153-154). On the emulator glibc aborts before anything is corrupted; on hardware
the write lands wherever the linker put the next object.

## Suggested fix

Clamp the copy to what remains, in all five branches rather than only type 4 -
the other four are safe by arithmetic that a future key size would break again:

```c
int n = keysize - packet_buffer_offset;
if (n > 57) n = 57;
if (n > 0) memcpy(rsa_private_key + packet_buffer_offset, buffer + 7, n);
```

The guard `packet_buffer_offset <= 456` can then be `< keysize`, which says what
it means: keep going while there is room.

## Reproducing

```sh
sudo sysctl -w vm.mmap_min_addr=4096
node bin/okt.js run test/01-protocol/23-rsa-tunnel.test.js --test 4096
```

The run aborts with exit code 5 and `*** buffer overflow detected ***` in the
device host's stderr, attached to the failing test. Note the exit code: SIGABRT
is currently classified as "the device host died for a reason that is not the
firmware's fault", which is wrong for a fortify trip - tracked separately in the
kit's TODO.
