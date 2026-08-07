/*
 * read_exact() against a device that does not behave.
 *
 * THE OUTCOME TO RULE OUT is a truncated signature accepted as a signature. The
 * function reassembles a multi-report binary response - up to 52 reports for an
 * ML-DSA-65 signature - and every other property matters less than this one: if
 * a short read can return, the caller gets a buffer it believes is 3309 bytes of
 * signature and is actually 3000 bytes of signature followed by nothing, and the
 * verify that should have failed loudly instead fails as "bad signature" or, on
 * the decrypt side, as a wrong shared secret with no error at all.
 *
 * THE DEVICE IS THE UNTRUSTED INPUT HERE, which is why this file is in section
 * 5 rather than section 2. A malicious or malfunctioning device on the USB bus
 * chooses how many reports to send, how big each one is, when to stop, and
 * whether to error part way. read_exact has to turn every one of those into a
 * clean exception or an exact-length buffer, and never into a hang, an
 * unbounded read, or a partial result presented as complete.
 *
 * WHY A STUB DEVICE AND NOT THE EMULATOR. The property under test belongs
 * entirely to the host: read_exact's whole world is what `ok.read_bytes()`
 * returns. A stub can produce short, over-long, mis-framed, silent and erroring
 * responses precisely and repeatably, which the emulator's firmware - being
 * correct - will not do. This measures the function's contract against inputs a
 * hostile device could actually produce.
 *
 * `device: false` - no OnlyKey is involved.
 */
'use strict';

const path = require('path');

const { describe, it } = require('../../lib/harness');
const cli = require('../../lib/cli');
const { CHECKOUTS_ROOT } = require('../../lib/paths');

const PQC_PY = path.join(CHECKOUTS_ROOT, 'python-onlykey');

/*
 * Drives pqc.read_exact() against a scripted fake device inside one python
 * process. `script` is a list of what successive read_bytes() calls return:
 * a list of ints is a report, None means "timed out, nothing", and the string
 * 'raise' makes the call throw the way a transport error does.
 */
function probe(name, script, want, timeoutMs = 3000) {
  const py = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(PQC_PY)})`,
    'from onlykey import pqc',
    '',
    /*
     * json.loads rather than inlining the literal: JSON's `null` is not Python
     * syntax, and a NameError here would surface as "no result" and read like a
     * failure of the code under test.
     */
    `SCRIPT = json.loads(${JSON.stringify(JSON.stringify(script))})`,
    'class Fake:',
    '    script = SCRIPT',
    '    def __init__(self): self.i = 0',
    '    def read_bytes(self, n=64, to_bytes=False, timeout_ms=100):',
    '        if self.i >= len(self.script): return b""',
    '        item = self.script[self.i]; self.i += 1',
    '        if item == "raise": raise RuntimeError("transport blew up")',
    '        if item is None: return b""',
    '        return bytes(item)',
    '',
    'out = {}',
    'try:',
    `    got = pqc.read_exact(Fake(), ${want}, timeout_ms=${timeoutMs})`,
    '    out["ok"] = True; out["len"] = len(got); out["hex"] = got.hex()',
    'except Exception as e:',
    '    out["ok"] = False; out["err"] = type(e).__name__ + ": " + str(e)[:120]',
    'print("RESULT " + json.dumps(out))',
  ].join('\n');

  return cli.run('python3', ['-c', py], { timeoutMs: 30000 })
    .then((r) => {
      const m = (r.stdout || '').match(/^RESULT (.*)$/m);
      if (!m) throw new Error(`${name}: no result. stdout=${r.stdout} stderr=${r.stderr}`);
      return JSON.parse(m[1]);
    });
}

const report = (byte, n = 64) => Array.from({ length: n }, () => byte);

describe('read_exact against a misbehaving device', {
  device: false,
  requires: ['client-access'],
  negative: true,
  timeoutMs: 180000,
}, () => {
  it('returns exactly the requested length when the device behaves',
    async ({ assert, log }) => {
      /*
       * The positive control for every absence in this file. If the happy path
       * did not work, "it refused the bad input" would be indistinguishable
       * from "it refuses everything".
       */
      const res = await probe('happy', [report(0xAA), report(0xBB)], 96);
      log(`happy path: ${JSON.stringify(res).slice(0, 90)}`);

      assert.control('read_exact returns a correct response when given one',
        res.ok === true && res.len === 96);
      assert.equal(res.len, 96, 'a well-behaved device did not yield the exact length');
    });

  it('refuses a truncated response instead of returning a short buffer',
    async ({ assert, log }) => {
      /* 3309 asked for, one 64-byte report delivered, then silence. */
      const res = await probe('truncated', [report(0x11), null, null], 3309, 1500);
      log(`truncated: ${JSON.stringify(res).slice(0, 120)}`);

      assert.control('the probe exercised the truncating device',
        typeof res.ok === 'boolean');
      assert.absent(res.ok !== true,
        'read_exact RETURNED on a truncated response - a caller would treat '
        + `${res.len} bytes as a complete ${3309}-byte signature`);
      assert.includes(String(res.err), 'got ',
        `expected a short-read error, got ${JSON.stringify(res.err)}`);
    });

  it('does not hang when the device says nothing at all',
    async ({ assert, log }) => {
      const started = Date.now();
      const res = await probe('silent', [null, null, null, null], 64, 1200);
      const took = Date.now() - started;
      log(`silent device: ${JSON.stringify(res).slice(0, 90)} in ${took}ms`);

      assert.control('the silent-device probe ran and returned a verdict',
        typeof res.ok === 'boolean');
      assert.absent(res.ok !== true, 'read_exact returned success for a silent device');
      assert.ok(took < 25000, `read_exact took ${took}ms - it should stop at its deadline`);
    });

  it('never returns more than asked for, however much the device sends',
    async ({ assert, log }) => {
      /* Four 64-byte reports for a 32-byte request. */
      const res = await probe('overlong',
        [report(0xC1), report(0xC2), report(0xC3), report(0xC4)], 32);
      log(`over-long: ok=${res.ok} len=${res.len}`);

      assert.control('the over-long probe produced a buffer', res.ok === true);
      assert.equal(res.len, 32,
        `read_exact returned ${res.len} bytes for a 32-byte request - an '
        + 'over-reading device could overflow a caller's expectations`);
      assert.absent(!/c2|c3|c4/.test(res.hex.slice(0, 8)),
        'the first bytes are not from the first report, so framing slipped');
    });

  it('does not treat a transport error as the end of a complete response',
    async ({ assert, log }) => {
      /* One good report, then the transport throws, then silence. */
      const res = await probe('erroring', [report(0x55), 'raise', null], 128, 1500);
      log(`erroring transport: ${JSON.stringify(res).slice(0, 120)}`);

      assert.control('the erroring probe ran and returned a verdict',
        typeof res.ok === 'boolean');
      assert.absent(res.ok !== true,
        'read_exact returned success after the transport errored mid-stream');
    });

  it('skips a leading status broadcast rather than reading it as payload',
    async ({ assert, log }) => {
      /*
       * The device announces "UNLOCKED" on its own schedule. Reading it as the
       * first 8 bytes of a signature is how the ASCII of a status message ends
       * up where key-derived bytes belong - and it must not be silently
       * incorporated, only skipped.
       */
      const unlocked = Array.from(Buffer.from('UNLOCKED'.padEnd(64, '\0'), 'latin1'));
      const res = await probe('status-first', [unlocked, report(0x77)], 64);
      log(`status then data: ok=${res.ok} first byte=${res.hex.slice(0, 2)}`);

      assert.control('the status-first probe produced a buffer', res.ok === true);
      assert.equal(res.hex.slice(0, 2), '77',
        'the status broadcast was returned as payload instead of being skipped');
      assert.absent(!res.hex.startsWith('554e4c4f'),
        'the response begins with the ASCII of "UNLOCKED"');
    });
});
