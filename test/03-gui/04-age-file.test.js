/*
 * Section 3, headless: the age file format, as the web app writes it.
 *
 * `age_file.js` is not a wrapper around anything - the web app implements the
 * age v1 container itself: the HPKE seal of the file key, the header MAC, and
 * the STREAM body with its 64KiB chunks. It is the only part of the browser's
 * age support that never touches the device, and nothing has ever tested it.
 *
 * `device: false`, so this runs anywhere. The device's contribution is a
 * callback (`deriveSharedSecret`), which is exactly how the real page supplies
 * it - so standing in for it locally is not a shortcut, it is the interface.
 *
 * What gets checked here is the part a round trip cannot see. A format
 * implementation that is wrong in the same way twice will encrypt and decrypt
 * its own files perfectly forever; what breaks is interoperability, and the
 * places it breaks are always the same few - the chunk boundary, the last-chunk
 * flag, and what the header MAC covers. So those are tested directly, and
 * failures are separated by KIND: a corrupt header must fail as a MAC, not as
 * an AEAD tag, because the two mean different things about a file.
 *
 * Not here, and worth saying: reading a file written by the real `age` binary.
 * That needs the plugin, and decrypting one needs a device - so it belongs in
 * section 2 beside 03-pqc-decrypt rather than in the headless tier.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const ours = require('../../lib/age-pqc');
const webenv = require('../../lib/webenv');

const MAGIC = 'age-encryption.org/v1';
const STANZA = 'mlkem768x25519';
const CHUNK = 64 * 1024;

describe('the age file format, as the web app writes it', {
  device: false,
  requires: ['xwing-math', 'webapp-lib'],
  timeoutMs: 60000,
}, () => {
  const ageFile = () => webenv.loadPlain('age_file.js');

  /**
   * A recipient nobody had to plug in, plus the two halves of decapsulation.
   *
   * skX stays here and stands in for the device: the page's callback gets ss_X
   * from a real one, and everything after that is host-side either way.
   */
  function recipient() {
    const skX = ours.x25519Secret();
    const pkX = ours.x25519Base(skX);
    const seed = require('crypto').randomBytes(32);
    return { skX, pkX, seed, bytes: ours.buildRecipient(pkX, seed) };
  }

  /** The callback age_file.js asks for: the full 32-byte X-Wing secret. */
  const deriveWith = (r) => async (ciphertext) => ours.splitDecapsulate(
    ours.x25519Shared(r.skX, ours.ctXOf(ciphertext)), ciphertext, r.pkX, r.seed
  );

  function sealed(plaintext) {
    const r = recipient();
    const { sharedSecret, ciphertext } = ours.xwingEncapsHost(r.bytes);
    const file = ageFile().encryptAgeFile(Buffer.from(plaintext), { ciphertext, sharedSecret });
    return { r, file: Buffer.from(file) };
  }

  it('writes a header the age spec would recognise', async ({ assert }) => {
    const { file } = sealed('hello');
    const text = file.toString('latin1');

    assert.ok(text.startsWith(`${MAGIC}\n`), `the file does not begin with ${MAGIC}`);
    assert.match(text, new RegExp(`^-> ${STANZA} [A-Za-z0-9+/]+$`, 'm'),
      'no mlkem768x25519 recipient stanza');
    assert.match(text, /^--- [A-Za-z0-9+/]+$/m, 'no header MAC line');

    /* Unpadded base64 throughout, which the spec requires and which a
     * Buffer.toString('base64') would get wrong by default. */
    assert.ok(!/=\n/.test(text) && !/=$/.test(text.split('\n')[1] || ''),
      'the stanza carries padded base64');
  });

  it('carries the exact ciphertext it was given', async ({ assert }) => {
    /* The stanza argument is the 1120-byte X-Wing ciphertext, and the reader
     * on the other side has nothing else to decapsulate from. */
    const r = recipient();
    const { sharedSecret, ciphertext } = ours.xwingEncapsHost(r.bytes);
    const file = Buffer.from(
      ageFile().encryptAgeFile(Buffer.from('x'), { ciphertext, sharedSecret })
    );

    const m = file.toString('latin1').match(new RegExp(`^-> ${STANZA} (\\S+)$`, 'm'));
    assert.ok(m, 'no stanza to read');
    assert.bytes(Buffer.from(m[1], 'base64'), ciphertext, 'the stanza ciphertext');
  });

  it('reads back what it wrote', async ({ assert }) => {
    const plaintext = 'the quick brown fox jumps over the lazy dog';
    const { r, file } = sealed(plaintext);

    const out = await ageFile().decryptAgeFile(file, deriveWith(r));
    assert.equal(Buffer.from(out).toString('utf8'), plaintext);
  });

  it('handles the chunk boundaries', async ({ assert }) => {
    /*
     * Where STREAM implementations actually break. The last chunk is flagged in
     * the nonce's final byte, so a file that is exactly one chunk long, or one
     * byte over, is where an off-by-one turns into "decrypts everywhere except
     * against the other implementation".
     */
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1]) {
      const plaintext = Buffer.alloc(size, 0x41);
      const r = recipient();
      const { sharedSecret, ciphertext } = ours.xwingEncapsHost(r.bytes);
      const file = ageFile().encryptAgeFile(plaintext, { ciphertext, sharedSecret });

      const out = await ageFile().decryptAgeFile(Buffer.from(file), deriveWith(r));
      assert.bytes(out, plaintext, `${size} bytes`);
    }
  });

  it('refuses a file sealed to somebody else', async ({ assert }) => {
    /* The wrong shared secret has to fail on the AEAD tag over the file key -
     * not produce a plausible-looking wrong plaintext. */
    const { file } = sealed('secret');
    const stranger = recipient();

    await assert.rejects(
      async () => ageFile().decryptAgeFile(file, deriveWith(stranger)),
      /./
    );
  });

  it('refuses a tampered stanza, at the seal', async ({ assert }) => {
    /*
     * Editing the recipient stanza fails on the AEAD tag, NOT on the header
     * MAC, and that ordering is the age format rather than a weakness: the MAC
     * is keyed by the file key, so the file key has to be recovered before the
     * MAC can be checked at all. A changed ciphertext decapsulates to a
     * different secret, and the sealed file key stops opening.
     */
    const { r, file } = sealed('secret');
    const text = file.toString('latin1');

    const at = text.indexOf(`-> ${STANZA} `) + `-> ${STANZA} `.length + 4;
    const tampered = Buffer.from(file);
    tampered[at] ^= 0x01;

    await assert.rejects(async () => ageFile().decryptAgeFile(tampered, deriveWith(r)), /./);
  });

  it('refuses an injected stanza, as a MAC failure', async ({ assert }) => {
    /*
     * What the header MAC is actually for, and the only tampering that reaches
     * it: a change that leaves the real stanza intact, so the file key still
     * opens and the MAC is the one thing left to notice. Adding a recipient is
     * the threat - it is how you would try to make somebody else's file
     * readable by you - and it must be caught even though nothing about the
     * decryption path has been disturbed.
     */
    const { r, file } = sealed('secret');
    const text = file.toString('latin1');

    const injected = text.replace(
      `${MAGIC}\n`,
      `${MAGIC}\n-> X25519 ${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}\n` +
      `${Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')}\n`
    );

    const err = await assert.rejects(
      async () => ageFile().decryptAgeFile(Buffer.from(injected, 'latin1'), deriveWith(r)),
      /./
    );
    assert.match(err.message, /MAC|header/i,
      `expected a header MAC failure, got: ${err.message}`);
  });

  it('refuses a tampered body, after the header verified', async ({ assert }) => {
    const { r, file } = sealed('a message long enough to have a body worth editing');

    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;

    await assert.rejects(async () => ageFile().decryptAgeFile(tampered, deriveWith(r)), /./);
  });

  it('seals a file key to 32 bytes, and only opens it with the right secret',
    async ({ assert }) => {
      /*
       * The HPKE layer on its own, under the file format. 16 bytes of file key
       * plus a 16-byte Poly1305 tag, and the shared secret is bound in - so the
       * same file key sealed under two secrets must not collide.
       */
      const lib = ageFile();
      const r = recipient();
      const { sharedSecret, ciphertext } = ours.xwingEncapsHost(r.bytes);
      const fileKey = Buffer.alloc(16, 0x2A);

      const sealedKey = lib.sealFileKey(sharedSecret, ciphertext, fileKey);
      assert.equal(Buffer.from(sealedKey).length, 32, '16-byte key plus a 16-byte tag');

      assert.bytes(lib.openFileKey(sharedSecret, ciphertext, sealedKey), fileKey,
        'the file key did not survive a seal/open');

      const wrong = Buffer.from(sharedSecret);
      wrong[0] ^= 0x01;
      await assert.rejects(async () => lib.openFileKey(wrong, ciphertext, sealedKey), /./);
    });
});
