/*
 * The web app library must not print secret key material to the console.
 *
 * WHAT IS SECRET HERE. `onlykey_api.sharedsec` is the NaCl transit key: the
 * X25519 shared secret established by OKCONNECT between the page and the
 * device. Every composite operation encrypts its payload chunks under it
 * (`prime_composite` -> `aesgcm_encrypt(chunk, onlykeyApi.sharedsec)`), so
 * anyone holding it can read and forge the traffic of that session. Its
 * SHA-256 is the AES-256 key the same code derives for the same purpose.
 *
 * WHY THE CONSOLE MATTERS on a page that handles private keys. The browser
 * console is not a private channel: devtools history persists, extensions with
 * debugger access read it, screen shares and pasted bug reports carry it, and
 * the nw.js harness this kit runs captures every line. A key that reaches it
 * has left the boundary the device exists to enforce.
 *
 * HOW THIS TEST WORKS, and why it is not a grep. The library is loaded with a
 * CAPTURING console (webenv's `console` option), a real OKCONNECT is performed
 * against the device, and the transit key the handshake actually produced is
 * then searched for in everything the library printed - as decimal bytes, hex,
 * base64, and as the base64 of its SHA-256. Grepping the source for
 * `console.log` would prove a coding style; this proves the secret itself does
 * not escape, whatever route it takes to get there.
 *
 * `api.connect` is deliberately taken from onlykey-3rd-party.js, which
 * OVERRIDES onlykey-api.js's connect. That override is the one the pgp-pqc page
 * runs, so it is the one worth asserting about.
 *
 * SURFACE: FIDO (0xF1D0) - the handshake is a WebAuthn ceremony. Survives into
 * a production walk.
 */
'use strict';

const crypto = require('crypto');
const util = require('util');

const { describe, it } = require('../../lib/harness');
const { PINS } = require('../../lib/config');
const webenv = require('../../lib/webenv');

/** Every way a 32-byte secret could plausibly have been rendered into a log. */
function renderings(secret) {
  const buf = Buffer.from(secret);
  const sha = crypto.createHash('sha256').update(buf).digest();
  return [
    ['decimal bytes', Array.from(buf).join(', ')],
    ['hex', buf.toString('hex')],
    ['base64', buf.toString('base64')],
    ['sha256 base64 (the derived AES key)', sha.toString('base64')],
    ['sha256 hex', sha.toString('hex')],
    ['sha256 decimal bytes', Array.from(sha).join(', ')],
  ];
}

describe('the web app library does not log secret key material', {
  state: 'initialized',
  requires: ['crypto', 'webapp-lib'],
  negative: true,
  timeoutMs: 180000,
}, () => {
  let captured = [];
  let sharedsec = null;

  it('performs a real OKCONNECT with the library\'s console captured',
    async ({ device, assert, signal, log }) => {
      await device.unlock(PINS.primary, { signal });

      /*
       * inspect() rather than String(): a Uint8Array stringifies to a bare
       * comma-joined list, but the library also passes objects and arrays, and
       * inspect renders those fully. maxArrayLength null matters - the default
       * truncates at 100 entries with "... more items", which would hide a
       * secret logged inside a longer buffer.
       */
      const record = (...args) => {
        captured.push(args.map((a) => (typeof a === 'string'
          ? a
          : util.inspect(a, { depth: null, maxArrayLength: null }))).join(' '));
      };
      const capturing = {
        log: record, info: record, warn: record, error: record, debug: record,
      };

      const imports = webenv.create(device, { signal, console: capturing });
      const api = webenv.load(imports, 'onlykey-api.js');
      /* Loading 3rd-party OVERRIDES api.connect - that override is under test. */
      webenv.load(imports, 'onlykey-3rd-party.js', api)();

      await new Promise((resolve, reject) => {
        api.connect((err) => (err ? reject(new Error(String(err))) : resolve()));
      });

      sharedsec = api.sharedsec;
      log(`captured ${captured.length} console lines during the handshake`);

      /*
       * This test IS the instrument for the next one, so its control is that
       * the instrument came up: a real handshake completed and produced a real
       * 32-byte secret to go looking for. An absence asserted without that is
       * an absence of nothing.
       */
      assert.control('a real handshake produced a 32-byte transit key to search for',
        Boolean(sharedsec) && sharedsec.length === 32);

      assert.ok(sharedsec && sharedsec.length === 32,
        `no 32-byte transit key after connect (got ${sharedsec && sharedsec.length})`);
    });

  it('does not print the transit key, or anything derived from it',
    async ({ assert, log }) => {
      const text = captured.join('\n');

      /*
       * CONTROL ONE: the capture is wired to THIS library's console. Without
       * it, an empty `captured` would make every absence below pass while
       * measuring nothing - which is the exact failure mode section 5 exists
       * to prevent.
       */
      assert.control('the capture received this library\'s own output',
        captured.length > 0 && /OnlyKey|OKCONNECT|ctaphid/i.test(text));

      /*
       * CONTROL TWO: the search itself works. A known-present, non-secret
       * string must be findable by the same substring test the absences use -
       * otherwise "not found" could just mean the matcher is broken.
       */
      const probe = 'OnlyKey';
      assert.control('the substring matcher finds a value that IS present',
        text.includes(probe));

      for (const [how, needle] of renderings(sharedsec)) {
        assert.absent(!text.includes(needle),
          `the transit key was printed to the console as ${how}. `
          + 'It is the session key for every composite operation; anything that '
          + 'can read the console can read and forge that session.');
      }

      log('no rendering of the transit key appears in the captured output');
    });

  /*
   * The OTHER handshake, and the one the pgp-pqc page runs.
   *
   * onlykey-3rd-party.js defines its own `connect` on the object its factory
   * returns - `var ok = onlykey3rd(1, 0)` in pgp-pqc.js - so the handshake
   * above is not the one that page performs. It derives a transit key of its
   * own, and it used to print it.
   *
   * WHY THIS ONE CANNOT SEARCH FOR THE SECRET, which is worth stating because
   * the weaker assertion below looks like laziness otherwise: that connect
   * keeps nothing. `transit_key` and `sharedsec` are local `var`s, used to
   * decrypt the reply and then dropped, and `async_sha256(sharedsec)`'s result
   * is discarded in the callback. Nothing is assigned to the returned object,
   * so a test has no handle on the value to go looking for. (The secret the
   * composite operations actually use is `onlykeyApi.sharedsec`, set by
   * onlykey-api.js's connect - the one the first two tests cover.)
   *
   * So this asserts the property that does not need the value: after this
   * handshake, the library printed NO byte buffer at all. Any rendering of a
   * key - decimal array, hex run, base64 run - trips it, and so would a future
   * line dumping a response or handle. Before the console strip this failed on
   * `Uint8Array(32) [ ... ]` from "Transit shared secret".
   */
  const BYTE_BUFFERISH = [
    ['a decimal byte array', /\d{1,3}(?:,\s*\d{1,3}){15,}/],
    ['a long hex run', /\b[0-9a-fA-F]{40,}\b/],
    ['a long base64 run', /\b[A-Za-z0-9+/]{40,}={0,2}\b/],
  ];

  it('prints no byte buffers at all from the third-party client\'s handshake',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.unlock(PINS.primary, { signal });

      const seen = [];
      const record = (...args) => {
        seen.push(args.map((a) => (typeof a === 'string'
          ? a
          : util.inspect(a, { depth: null, maxArrayLength: null }))).join(' '));
      };
      const capturing = {
        log: record, info: record, warn: record, error: record, debug: record,
      };

      const imports = webenv.create(device, { signal, console: capturing });
      const api = webenv.load(imports, 'onlykey-api.js');
      const third = webenv.load(imports, 'onlykey-3rd-party.js', api)();

      await new Promise((resolve, reject) => {
        third.connect((err) => (err ? reject(new Error(String(err))) : resolve()));
      });

      const text = seen.join('\n');
      log(`third.connect captured ${seen.length} lines`);

      /*
       * CONTROL: the capture is wired to this handshake. Its own output is the
       * separator line the connect prints, so seeing that proves the recorder
       * ran and that a silent result below means silence rather than a
       * disconnected console.
       */
      assert.control('the capture received the third-party handshake\'s output',
        seen.length > 0);

      /*
       * CONTROL: the matchers fire on something that IS buffer-shaped, so a
       * clean result cannot be a broken regex.
       */
      const probe = util.inspect(new Uint8Array(32).fill(7),
        { depth: null, maxArrayLength: null });
      assert.control('the byte-buffer matchers detect a real 32-byte buffer',
        BYTE_BUFFERISH.some(([, rx]) => rx.test(probe)));

      for (const [what, rx] of BYTE_BUFFERISH) {
        const hit = seen.find((line) => rx.test(line));
        assert.absent(!hit,
          `the third-party handshake printed ${what}: ${String(hit).slice(0, 120)}. `
          + 'This handshake derives a transit key; nothing buffer-shaped should '
          + 'reach the console from it.');
      }
    });
});
