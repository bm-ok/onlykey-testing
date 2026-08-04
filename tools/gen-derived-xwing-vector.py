"""Regenerates test/00-sanity/fixtures/derived-xwing-vector.json.

The vector is the only thing standing between "our X-Wing maths is
self-consistent" and "our X-Wing maths is the same maths the CLI does". It is
produced by python-onlykey's OWN derived_xwing.py and xwing.py - the reference
implementation, not a second reading of the spec - on fixed inputs, so the JS
port in lib/age-pqc.js can be checked against it byte for byte.

The inputs are fixed, not random, and that is deliberate: a vector regenerated
with fresh randomness would pass against a JS port that had drifted, because
both sides would have moved together. These bytes are also emphatically not a
real device's - sk_x is 0..31.

Run it with the venv python that has python-onlykey installed:

    ../python-onlykey/.venv/bin/python tools/gen-derived-xwing-vector.py \\
        > test/00-sanity/fixtures/derived-xwing-vector.json

Only rerun this if the reference implementation changes. If it does and the
vector moves, that is not a fixture to be refreshed - it is three
implementations that no longer agree, and the firmware is one of them.
"""
import base64
import json

from onlykey.age_plugin import derived_xwing as dx
from onlykey.age_plugin import xwing

sk_x = bytes(range(32))            # a fixed X25519 "device" scalar
mlkem_seed = bytes([0xAA] * 32)    # a fixed ML-KEM seed
pk_x = xwing.x25519_scalarmult_base(sk_x)

recipient = dx.build_recipient(pk_x, mlkem_seed)
ss_enc, ct = xwing.xwing_encaps_host(recipient)

ct_x = dx.ct_x_of(ct)
ss_x = xwing.x25519_scalarmult(sk_x, ct_x)     # what a real device would return
ss_dec = dx.split_decapsulate(ss_x, ct, pk_x, mlkem_seed)

assert ss_dec == ss_enc, "python self-check failed - do not publish this vector"

pk_m, sk_m = dx.mlkem_keypair_from_seed(mlkem_seed)

b64 = lambda b: base64.b64encode(bytes(b)).decode()

print(json.dumps({
    "sk_x": b64(sk_x),
    "pk_x": b64(pk_x),
    "mlkem_seed": b64(mlkem_seed),
    "pk_m": b64(pk_m),
    "recipient": b64(recipient),
    "ciphertext": b64(ct),
    "ct_x": b64(ct_x),
    "ss_x": b64(ss_x),
    "shared_secret": b64(ss_enc),
}, indent=2))
