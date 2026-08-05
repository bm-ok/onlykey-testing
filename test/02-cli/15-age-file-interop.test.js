/*
 * The web app's age container, against the real `age` binary - both directions.
 *
 * `03-gui/04-age-file` proves the web app WRITES a correct age v1 container: it
 * checks the chunk boundary, the last-chunk flag and what the header MAC
 * covers, against its own reading. That is the part a round trip cannot see,
 * and it is worth having - but it is still one implementation agreeing with
 * itself. An implementation that is wrong in the same way twice encrypts and
 * decrypts its own files perfectly forever; what breaks is interoperability.
 *
 * So this is the other side, and it is deliberately BOTH directions, because
 * only one of them is the row TODO asked for and the pair is worth more than
 * either:
 *
 *   real age writes  ->  age_file.js reads     the row
 *   age_file.js writes  ->  real age reads     the complement
 *
 * A reader and a writer can be wrong in opposite ways and still pass one
 * direction each; passing both against a third party is what says the format is
 * right rather than merely self-consistent.
 *
 * WHY SECTION 2. The real `age` binary reaches an OnlyKey recipient through
 * `age-plugin-onlykey`, which finds the device through hidapi - so this needs a
 * kernel device node and can never run on a hosted runner. That is
 * `client-access`, exactly as for the rest of section 2.
 *
 * THE DEVICE HALF IS DONE OVER RAW HID, not through the tunnel, and that is
 * what keeps this file cheap. The derived X-Wing branch in okcrypto.cpp has no
 * CRYPTO_AUTH gate and does not check `derivedkeymode` - bit 3 is read only on
 * the tunnelled path in fido2/ok_extension.cpp - so no button press, no config
 * mode and no `derivedkeymode` setup is needed. 02-cli/07-derived-xwing
 * established that; this file relies on it and re-asserts it, by counting the
 * device's own priming marker across every step.
 *
 * It is also the first time the KIT sends the derived pair itself rather than
 * letting the plugin do it. Both are worth reading as claims about the wire:
 *
 *   OKGETPUBKEY slot 128, buffer[6] = KEYTYPE_XWING, tag(32)
 *                 -> [ pk_X(32) | mlkem_seed(32) ]
 *   OKDECRYPT   slot 128, tag(32) || ct_X(32) = 64 bytes, which does NOT fit
 *                 one 57-byte report, so it goes as two with the continuation
 *                 marker in buffer[6]: 0xFF then the remaining count
 *                 -> [ ss_X(32) | mlkem_seed(32) ]
 *
 * That second one is the framing that used to be broken - okcrypto_decrypt()
 * required (buffer[6] & 0x0F) == KEYTYPE_XWING and buffer[6] carries a
 * continuation marker here, so neither chunk matched and both fell through to
 * slot dispatch, returning a shared secret that never matched with no error
 * anywhere. Sending it by hand is what makes this file stand guard over that.
 *
 * SURFACES, per test - see PRODUCTION.md. Everything here is the vendor
 * interface plus host-side arithmetic; the console is read for nothing.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');
const ours = require('../../lib/age-pqc');
const webenv = require('../../lib/webenv');

/* okcore.h. 128 is RESERVED_KEY_WEB_DERIVATION; 6 is KEYTYPE_XWING. */
const WEB_DERIVATION = 128;
const KEYTYPE_XWING = 6;

/* The device's announcement that it primed a button challenge. Nothing in this
 * file may cause one - see the header. */
const PRIMED = /Encrypted Buffer/g;

const LABEL = 'age:interop';
const PLAINTEXT = 'The real age binary and the web app must agree, byte for byte.\n';

const ANSWER = (buf) => {
  const text = okmsg.text(buf);
  return !!text && text !== 'INITIALIZED';
};

/** SHA256(utf8(label)) - the convention onlykey_hid.py and the firmware share. */
const labelTag = (label) => crypto.createHash('sha256').update(label, 'utf8').digest();

describe('the web app\'s age container against the real age binary', {
  state: 'initialized',
  requires: ['crypto', 'client-access', 'xwing-math', 'webapp-lib'],
  timeoutMs: 300000,
}, () => {
  const needCli = ({ skip }) => {
    if (!cli.venvPresent()) skip(`no venv at ${cli.VENV_BIN}`);
    cli.binary('age');
    cli.binary('age-plugin-onlykey');
  };

  const ageFile = () => webenv.loadPlain('age_file.js');

  /** [pk_X | mlkem_seed] for a label, straight over the vendor interface. */
  async function deriveRecipient(device, label, { signal }) {
    const since = device.mark(IFACE.VENDOR);
    device.sendVendor({
      msg: okmsg.MSG.OKGETPUBKEY,
      slot: WEB_DERIVATION,
      field: KEYTYPE_XWING,
      payload: labelTag(label),
    });
    const reply = await device.waitHid(IFACE.VENDOR, { since, match: ANSWER, timeoutMs: 10000, signal });
    if (reply.length < 64) throw new Error(`derived recipient came back ${reply.length} bytes`);
    return { pkX: reply.subarray(0, 32), seed: reply.subarray(32, 64) };
  }

  /**
   * ss_X for a label and a ct_X, over the multi-packet derived branch.
   *
   * 64 bytes over a 57-byte report, so two sends: the first carries 57 with
   * 0xFF in buffer[6] meaning "more coming", the second carries the remaining 7
   * with its own count there. The firmware reassembles into its own 64-byte
   * buffer and only then derives.
   */
  async function deriveDecap(device, label, ctX, { signal }) {
    const payload = Buffer.concat([labelTag(label), Buffer.from(ctX)]);
    if (payload.length !== 64) throw new Error(`derive decap payload must be 64 bytes`);

    const since = device.mark(IFACE.VENDOR);
    device.sendVendor({
      msg: okmsg.MSG.OKDECRYPT, slot: WEB_DERIVATION, field: 0xFF, payload: payload.subarray(0, 57),
    });
    device.sendVendor({
      msg: okmsg.MSG.OKDECRYPT, slot: WEB_DERIVATION, field: 7, payload: payload.subarray(57),
    });

    const reply = await device.waitHid(IFACE.VENDOR, { since, match: ANSWER, timeoutMs: 15000, signal });
    if (reply.length < 64) throw new Error(`derived decaps came back ${reply.length} bytes`);
    return { ssX: reply.subarray(0, 32), seed: reply.subarray(32, 64) };
  }

  /** A working directory that a failure leaves behind as evidence. */
  const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'okt-agefile-'));

  it('the real age binary encrypts to a recipient the device derived',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * The precondition for everything below, and an assertion in its own
       * right: the recipient this kit builds from the device's two halves has
       * to be the one the PLUGIN builds for the same label, or the two sides
       * are deriving different keys and every later failure would be blamed on
       * the container format instead.
       */
      const primed = device.log.count(PRIMED);

      const { pkX, seed } = await deriveRecipient(device, LABEL, { signal });
      const recipient = ours.encodeRecipient(ours.buildRecipient(pkX, seed));
      log(`kit derives    ${recipient.slice(0, 40)}...`);

      const viaPlugin = await cli.run('age-plugin-onlykey',
        ['--derived', '--label', LABEL, '--recipient'], { timeoutMs: 30000, signal });
      assert.equal(viaPlugin.code, 0, `the plugin failed: ${viaPlugin.stderr}`);
      log(`plugin derives ${viaPlugin.stdout.trim().slice(0, 40)}...`);

      assert.equal(recipient, viaPlugin.stdout.trim(),
        'the kit and the plugin built different recipients from the same label');

      const dir = workdir();
      fs.writeFileSync(path.join(dir, 'plain.txt'), PLAINTEXT);
      const sealed = path.join(dir, 'real.age');

      const enc = await pqc.encrypt(recipient, path.join(dir, 'plain.txt'), sealed, { signal });
      assert.equal(enc.code, 0, `age encrypt failed: ${enc.stderr}`);

      const bytes = fs.readFileSync(sealed);
      assert.includes(bytes.toString('latin1'), 'age-encryption.org/v1',
        'the real binary did not write an age v1 header');
      assert.includes(bytes.toString('latin1'), 'mlkem768x25519',
        'the real binary did not write an X-Wing stanza');

      assert.equal(device.log.count(PRIMED), primed,
        'the derived path primed a button challenge - it has no CRYPTO_AUTH gate');
      fs.rmSync(dir, { recursive: true, force: true });
    });

  it('the web app\'s parser opens a container the real age binary wrote',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * THE ROW. Every byte of this container was produced by the real `age`
       * binary - its header, its stanza wrapping, its 16-byte STREAM nonce and
       * its chunked body - and it is opened by age_file.js, which shares no code
       * with it. The device contributes exactly one value, ss_X, and the
       * ML-KEM half is finished on the host, which is the split-custody design.
       *
       * `decryptAgeFile` takes the shared secret through a callback, which is
       * how the real page supplies it too - so standing in for the page here is
       * the interface rather than a shortcut.
       */
      const primed = device.log.count(PRIMED);
      const dir = workdir();

      try {
        const { pkX, seed } = await deriveRecipient(device, LABEL, { signal });
        const recipient = ours.encodeRecipient(ours.buildRecipient(pkX, seed));

        fs.writeFileSync(path.join(dir, 'plain.txt'), PLAINTEXT);
        const sealed = path.join(dir, 'real.age');
        const enc = await pqc.encrypt(recipient, path.join(dir, 'plain.txt'), sealed, { signal });
        assert.equal(enc.code, 0, `age encrypt failed: ${enc.stderr}`);

        const fileBytes = fs.readFileSync(sealed);
        const ciphertext = pqc.xwingCiphertextOf(sealed);
        log(`stanza ciphertext ${ciphertext.length} bytes`);

        /* The one device call, and the only 32 bytes of the ciphertext it sees. */
        const { ssX } = await deriveDecap(device, LABEL, ours.ctXOf(ciphertext), { signal });
        const shared = ours.splitDecapsulate(ssX, ciphertext, pkX, seed);

        const opened = await ageFile().decryptAgeFile(new Uint8Array(fileBytes), async () => shared);
        assert.bytes(Buffer.from(opened), Buffer.from(PLAINTEXT),
          'the web app opened the real binary\'s file and got different bytes');

        assert.equal(device.log.count(PRIMED), primed,
          'the derived decapsulation primed a button challenge');
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log(`evidence left in ${dir}`);
        throw err;
      }
    });

  it('the real age binary opens a container the web app\'s code wrote',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * The complement, and the harder direction: a reader is forgiving in ways
       * a writer cannot be. Here age_file.js produces the whole container and
       * the real binary has to accept all of it - the armor, the stanza
       * wrapping, the header MAC and the STREAM framing - with the device doing
       * the decapsulation through the plugin, exactly as a user would.
       *
       * The encapsulation is done HOST-SIDE with no device at all, which is not
       * a shortcut but the shape of the thing: X-Wing encapsulation is entirely
       * public-key, so a sender never needs the recipient's device. That is
       * what makes an age recipient useful.
       */
      const primed = device.log.count(PRIMED);
      const dir = workdir();

      try {
        const { pkX, seed } = await deriveRecipient(device, LABEL, { signal });
        const pk = ours.buildRecipient(pkX, seed);

        /* The sender's side, with nothing plugged in. */
        const { ciphertext, sharedSecret } = ours.xwingEncapsHost(pk);
        const container = ageFile().encryptAgeFile(
          new TextEncoder().encode(PLAINTEXT), { ciphertext, sharedSecret });

        const sealed = path.join(dir, 'webapp.age');
        fs.writeFileSync(sealed, Buffer.from(container));
        log(`the web app wrote ${container.length} bytes`);

        /* The identity is the label in an envelope - no device involved in
         * making it, which 07-derived-xwing asserts separately. */
        const ident = await cli.run('age-plugin-onlykey',
          ['--derived', '--label', LABEL, '--identity'], { timeoutMs: 30000, signal });
        assert.equal(ident.code, 0, `--identity failed: ${ident.stderr}`);
        const identity = ident.stdout.split('\n').find((l) => l.startsWith('AGE-PLUGIN-ONLYKEY-1'));
        assert.ok(identity, 'no derived identity came back');
        fs.writeFileSync(path.join(dir, 'identity.txt'), `${identity.trim()}\n`);

        const out = path.join(dir, 'opened.txt');
        const dec = await cli.run('age',
          ['-d', '-i', path.join(dir, 'identity.txt'), '-o', out, sealed],
          { timeoutMs: 90000, signal, env: { PATH: `${cli.VENV_BIN}:${process.env.PATH}` } });

        assert.equal(dec.code, 0,
          `the real age binary refused the web app's container: ${dec.stderr.slice(-400)}`);
        assert.bytes(fs.readFileSync(out), Buffer.from(PLAINTEXT),
          'the real binary opened the web app\'s file and got different bytes');

        assert.equal(device.log.count(PRIMED), primed, 'a challenge was primed');
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log(`evidence left in ${dir}`);
        throw err;
      }
    });

  it('a real container fails by the right KIND for each thing tampered with',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * 04-age-file separates these failure KINDS on containers the web app wrote
       * itself. Doing it on a container the REAL binary wrote is the part that
       * could not be checked there, and the distinction matters: it tells
       * somebody which half of the file to go and look at.
       *
       * TWO TAMPERS, because the first version of this test used one and had the
       * wrong model of the format. Corrupting the stanza BODY does not reach the
       * MAC check at all - the body is the HPKE-sealed file key, so it fails
       * inside openFileKey() as an AEAD tag, and it fails there FIRST because
       * the MAC cannot even be computed until the file key has been recovered.
       * That ordering is correct and is now asserted rather than assumed.
       *
       * To reach the MAC check the file key has to survive, so the second tamper
       * edits the MAC line itself - the one part of the header that is not
       * covered by the value it carries.
       */
      const dir = workdir();

      try {
        const { pkX, seed } = await deriveRecipient(device, LABEL, { signal });
        const recipient = ours.encodeRecipient(ours.buildRecipient(pkX, seed));

        fs.writeFileSync(path.join(dir, 'plain.txt'), PLAINTEXT);
        const sealed = path.join(dir, 'real.age');
        const enc = await pqc.encrypt(recipient, path.join(dir, 'plain.txt'), sealed, { signal });
        assert.equal(enc.code, 0, `age encrypt failed: ${enc.stderr}`);

        const fileBytes = fs.readFileSync(sealed);
        const ciphertext = pqc.xwingCiphertextOf(sealed);
        const { ssX } = await deriveDecap(device, LABEL, ours.ctXOf(ciphertext), { signal });
        const shared = ours.splitDecapsulate(ssX, ciphertext, pkX, seed);

        /* Untouched, it opens - so the tamper below is the only variable. */
        const lib = ageFile();
        await lib.decryptAgeFile(new Uint8Array(fileBytes), async () => shared);

        const lines = fileBytes.toString('latin1').split('\n');
        const flip = (line) => (line[4] === 'A' ? 'B' : 'A') + line.slice(1).replace(/^(.{3})./, '$1x');

        const reject = async (bytes, what) => {
          let failure = null;
          try {
            await lib.decryptAgeFile(new Uint8Array(bytes), async () => shared);
          } catch (err) {
            failure = err;
          }
          assert.ok(failure, `${what} opened anyway`);
          log(`${what} reported: ${failure.message}`);
          return failure.message;
        };

        /*
         * The sealed file key, on the line after the stanza header. It never
         * reaches the MAC: HPKE fails to open it first.
         */
        const stanzaAt = lines.findIndex((l) => l.startsWith('-> mlkem768x25519'));
        assert.ok(stanzaAt >= 0, 'no X-Wing stanza line to tamper with');

        const bodyEdit = [...lines];
        const body = bodyEdit[stanzaAt + 1];
        bodyEdit[stanzaAt + 1] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);

        const bodyFailure = await reject(Buffer.from(bodyEdit.join('\n'), 'latin1'),
          'a corrupted sealed file key');
        assert.match(bodyFailure, /tag|decrypt|open/i,
          `expected an AEAD failure for a corrupted file key, got ${JSON.stringify(bodyFailure)}`);
        assert.ok(!/MAC/i.test(bodyFailure),
          'a corrupted file key was reported as a header MAC failure - it never gets that far');

        /*
         * The MAC line itself, which is the only edit that leaves the file key
         * recoverable and the header no longer vouched for.
         */
        const macAt = lines.findIndex((l) => l.startsWith('--- '));
        assert.ok(macAt >= 0, 'no MAC line in the header');

        const macEdit = [...lines];
        const mac = macEdit[macAt];
        macEdit[macAt] = `--- ${mac[4] === 'A' ? 'B' : 'A'}${mac.slice(5)}`;

        const macFailure = await reject(Buffer.from(macEdit.join('\n'), 'latin1'),
          'a tampered header MAC');
        assert.match(macFailure, /MAC/i,
          `expected a header MAC failure, got ${JSON.stringify(macFailure)}`);

        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        log(`evidence left in ${dir}`);
        throw err;
      }
    });
});
