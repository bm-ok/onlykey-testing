/*
 * TC-13, the SSH half: `onlykey-agent <identity>` and nothing else.
 *
 * With no command, no `--daemonize`, no `--foreground`, no `--connect`, no
 * `--mosh` and no `--shell`, lib-agent's ssh/main() takes its last branch -
 * print every public key and return 0. No agent socket, no ssh-agent protocol,
 * no subprocess, and nothing written to the device. That is the whole surface
 * this file drives, and it is deliberately the smallest one that reaches the
 * firmware's agent derivation at all.
 *
 * lib-agent is the FOURTH client in this tree - after this kit's own JS,
 * python-onlykey and the web app's library - and the only one nothing has ever
 * run. It is also the one with the least in common with the others: it does not
 * speak the vendor protocol so much as ask one question, and the answer is a
 * key somebody's SSH server will be trusting.
 *
 * WHAT THE DEVICE IS ACTUALLY DOING, because the assertions below only make
 * sense against it. okcrypto_getpubkey() dispatches slot 132
 * (RESERVED_KEY_DERIVATION) to okcrypto_derive_key(), which is the "SSH/GPG
 * Derive Key" path:
 *
 *     sha256( <the device's slot-132 derivation key> || <32 bytes from the host> )
 *
 * and that hash IS the ed25519 seed. The host's 32 bytes are
 * sha256("user@host") - the identity, transliterated to ASCII by unidecode and
 * hashed by lib-agent before it ever reaches the device. Nothing is stored:
 * the key exists for the length of one request.
 *
 * THREE ORACLES, in increasing order of what they would catch:
 *
 *   - lib-agent against itself. Same identity twice must give the same key, a
 *     different identity a different one. Necessary and nowhere near
 *     sufficient: a firmware that ignored the host's bytes entirely passes the
 *     first, and one that hashed the wrong thing passes both.
 *   - lib-agent against THIS KIT, over the other transport. The kit asks the
 *     same question over the in-process vendor interface while lib-agent asks
 *     over USB, and the two must get the same key. That is what pins down the
 *     request format - the '01' keytype byte, the sha256, what exactly goes
 *     into it - rather than leaving it as whatever python happens to send.
 *   - the key against ITSELF, in pure JS. Both of the above are satisfied by a
 *     device that returns 32 bytes of anything, as long as it returns them
 *     consistently, and both clients would relay that happily into
 *     ~/.ssh/authorized_keys. The firmware prints the derived private key on
 *     its debug console, so node:crypto can derive the public half and check it
 *     really is the one that came back. That is the only assertion here that
 *     tests the firmware's arithmetic rather than its consistency.
 *
 * NO BUTTON AND NO WRITE, both asserted rather than left implied. The derive
 * path has no CRYPTO_AUTH gate and stores nothing, so the device should neither
 * prime a challenge nor erase a flash sector - and a firmware change that
 * started doing either would otherwise surface as this file timing out, or not
 * surface at all.
 *
 * This is section 2 rather than section 1 for the usual reason: lib-agent finds
 * the device through hidapi, so it needs a kernel device node. `client-access`
 * is what gates that - see 00-venv.test.js.
 */
'use strict';

const crypto = require('crypto');

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { byteprintAfter } = require('../../lib/device/logbuf');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');

/* The device's announcement that it has primed a button challenge, and its
 * announcement that it is writing flash. Neither may happen in this file. */
const PRIMED = /Encrypted Buffer/g;
const ERASED = /Erase Sector/g;

/* okcore.h: slot 132, the one okcrypto_derive_key() hashes against. */
const RESERVED_KEY_DERIVATION = 132;
const KEYTYPE_ED25519 = 1;

/*
 * `proto://user@host`. lib-agent parses this with one regex and hashes only
 * `user@host` - the proto is carried in the printed comment but never reaches
 * the device, which is the last test below.
 */
const IDENTITY = 'ssh://okt@example.com';
const OTHER = 'ssh://someone-else@example.com';
const HOST_ONLY = 'example.com';

/** Everything the derived key is a function of, exactly as lib-agent builds it. */
const identityHash = (userAtHost) => crypto.createHash('sha256').update(userAtHost, 'ascii').digest();

/**
 * Pull the key out of an `ssh-ed25519 <base64> <comment>` line.
 *
 * The base64 is an SSH wire-format blob - a length-prefixed type string
 * followed by a length-prefixed key - and unpacking it rather than comparing
 * the base64 text is what lets the device's own 32 bytes be compared against
 * it. It also checks the type twice, once in the line and once inside the blob,
 * because those are separately produced and a mismatch would mean lib-agent
 * built the blob for a different curve than it labelled it with.
 */
function parseSshPublicKey(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`not an SSH public key line: ${JSON.stringify(line)}`);
  const [type, b64, ...rest] = parts;

  const blob = Buffer.from(b64, 'base64');
  const typeLen = blob.readUInt32BE(0);
  const innerType = blob.subarray(4, 4 + typeLen).toString('ascii');
  const keyLen = blob.readUInt32BE(4 + typeLen);
  const key = blob.subarray(8 + typeLen, 8 + typeLen + keyLen);

  return { type, innerType, key, comment: rest.join(' '), blob, line: line.trim() };
}

/**
 * The ed25519 public key for a seed, with no dependency at all.
 *
 * node:crypto has ed25519 but will not take a bare 32-byte seed, so the seed is
 * wrapped in the fixed PKCS#8 preamble for the curve - the only variable part
 * of that DER is the seed itself. @noble/curves would also do this, but it is
 * an OPTIONAL dependency here, and an oracle that can be absent is an oracle
 * that silently stops running.
 *
 * The firmware computes this with Crypto/Ed25519.cpp's derivePublicKey(), which
 * is RFC 8032 to the letter - SHA-512 over the seed, clamp, scalar-multiply the
 * base point - so the two agree or the firmware is wrong.
 */
function ed25519PublicKey(seed) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
}

describe('onlykey-agent, the SSH half', {
  state: 'initialized',
  requires: ['crypto', 'client-access'],
  timeoutMs: 180000,
}, () => {
  let published = null;      // what lib-agent printed for IDENTITY
  let erasedAtStart = 0;

  /** The whole command under test: an identity, and not one other argument. */
  const agent = (identity, opts) =>
    cli.run('onlykey-agent', [identity], { timeoutMs: 45000, ...opts });

  it('prints one SSH public key and exits 0', async ({ device, assert, signal, log, skip }) => {
    if (!cli.venvPresent()) skip(`no venv at ${cli.VENV_BIN}`);
    assert.ok(cli.binary('onlykey-agent'), 'onlykey-agent is missing from the venv');

    /*
     * lib-agent's connect() calls set_time() and then insists on reading a
     * version string back, so it needs an unlocked device before it will do
     * anything at all. The kit unlocks over its own bus, as everywhere else.
     */
    await device.unlock(PINS.primary, { signal });
    const primed = device.log.count(PRIMED);
    erasedAtStart = device.log.count(ERASED);

    const result = await agent(IDENTITY, { signal });
    assert.equal(result.code, 0, `onlykey-agent exited ${result.code}: ${result.stderr}`);

    const lines = result.stdout.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1,
      `expected exactly one public key, got ${JSON.stringify(lines)}`);

    published = parseSshPublicKey(lines[0]);
    log(`published ${published.type} ${published.key.toString('hex')}`);

    assert.equal(published.type, 'ssh-ed25519',
      `onlykey-agent defaults to ed25519; it printed ${published.type}`);
    assert.equal(published.innerType, 'ssh-ed25519',
      'the blob is labelled one curve on the outside and another on the inside');
    assert.equal(published.key.length, 32, `an ed25519 key is 32 bytes, this is ${published.key.length}`);

    /*
     * The comment is lib-agent's Identity.to_string(), and it is the only place
     * the curve choice is recorded - an authorized_keys entry with the wrong one
     * is how somebody later derives a different key and cannot say why.
     */
    assert.equal(published.comment, `<${IDENTITY}|ed25519>`,
      'the key was published under the wrong identity');

    /*
     * And it really did take the print-and-exit branch. --daemonize is the one
     * that writes an SSH_AUTH_SOCK assignment to stdout, so its absence is what
     * says no agent was left running behind this test.
     */
    assert.ok(!/SSH_AUTH_SOCK/.test(result.stdout + result.stderr),
      'onlykey-agent started an agent instead of printing a key');

    assert.equal(device.log.count(PRIMED), primed,
      'exporting an SSH public key primed a button challenge - this path has no CRYPTO_AUTH gate');
  });

  it('derives the same key twice', async ({ device, assert, signal }) => {
    /*
     * The whole premise of a derived key: nothing is stored, so the answer has
     * to be reproducible or the key handed to a server yesterday is not the one
     * the device offers today. That failure arrives much later, as a login that
     * is refused with "Permission denied (publickey)" and no other account.
     */
    const primed = device.log.count(PRIMED);

    const again = await agent(IDENTITY, { signal });
    assert.equal(again.code, 0, `the second run failed: ${again.stderr}`);

    const key = parseSshPublicKey(again.stdout.trim());
    assert.bytes(key.key, published.key, 'the same identity derived two different keys');
    assert.equal(device.log.count(PRIMED), primed, 'a challenge was primed');
  });

  it('derives a different key for a different identity', async ({ assert, signal }) => {
    /*
     * The other half, and not a formality. The identity is hashed to 32 bytes
     * before it reaches the device, so a firmware that ignored those bytes and
     * returned its slot-132 key directly would pass the test above perfectly
     * and fail this one - and every user of that firmware would share one SSH
     * key across every host they ever connected to.
     */
    const other = await agent(OTHER, { signal });
    assert.equal(other.code, 0, `${OTHER} failed: ${other.stderr}`);

    const key = parseSshPublicKey(other.stdout.trim());
    assert.notEqual(key.key.toString('hex'), published.key.toString('hex'),
      `${OTHER} and ${IDENTITY} derived the same key`);
  });

  it('derives the key this kit derives, over the other transport',
    async ({ device, assert, signal, log }) => {
      /*
       * Two clients, two transports, one key. lib-agent asked over USB through
       * hidapi; this asks over the in-process vendor interface, and both have
       * to reach the same 32 bytes.
       *
       * It is also the first OKGETPUBKEY this kit has ever sent, and the
       * request is worth reading as an assertion in itself, because every part
       * of it is a claim about the firmware's dispatch:
       *
       *   slot     132   RESERVED_KEY_DERIVATION, the SSH/GPG derive branch
       *   [6]      0x01  KEYTYPE_ED25519, checked as `buffer[6] <= KEYTYPE_CURVE25519`
       *   [7..38]        sha256("user@host"), which okcrypto_derive_key() hashes
       *                  against the device's own key to make the ed25519 seed
       *
       * python-onlykey builds the same bytes from the hex STRING lib-agent hands
       * it - send_message() does bytearray.fromhex() unless from_ascii is set -
       * which is why '01' + hexdigest arrives as 33 raw bytes and not 66 ASCII
       * ones. Getting that wrong puts 0x30 in buffer[6] and the request matches
       * no branch at all, silently.
       */
      const primed = device.log.count(PRIMED);
      const since = device.mark(IFACE.VENDOR);

      device.sendVendor({
        msg: okmsg.MSG.OKGETPUBKEY,
        slot: RESERVED_KEY_DERIVATION,
        payload: Buffer.concat([
          Buffer.from([KEYTYPE_ED25519]),
          identityHash('okt@example.com'),
        ]),
      });

      const reply = await device.waitHid(IFACE.VENDOR, { since, timeoutMs: 10000, signal });
      assert.ok(!/^Error/.test(okmsg.text(reply)),
        `the device refused OKGETPUBKEY: ${okmsg.text(reply)}`);
      assert.equal(reply.length, 64, `expected one 64-byte report, got ${reply.length}`);

      /*
       * ed25519 fills the first 32 and leaves the rest zero, which is exactly
       * how python-onlykey tells an ed25519 answer from a 64-byte P-256 one -
       * so asserting the tail is empty is asserting the device answered with
       * the curve that was asked for.
       */
      const key = reply.subarray(0, 32);
      log(`the kit's own OKGETPUBKEY: ${key.toString('hex')}`);
      assert.bytes(reply.subarray(32), Buffer.alloc(32),
        'the device answered with a 64-byte key, not an ed25519 one');

      assert.bytes(key, published.key,
        'lib-agent and this kit got different keys for the same identity');
      assert.equal(device.log.count(PRIMED), primed, 'a challenge was primed');
    });

  it('published the public half of the key the device actually derived',
    async ({ device, assert, log }) => {
      /*
       * The assertion that needs no trust in either client. Everything above is
       * satisfied by a device that returns 32 consistent bytes of anything, and
       * both clients would relay that into an authorized_keys file without
       * complaint - the failure would land on whoever tried to log in.
       *
       * okcrypto_derive_key() dumps the seed it just built (`Agent derivation
       * private key`) immediately before okcrypto_compute_pubkey() turns it
       * into the answer, so the pair can be checked from outside. The last dump
       * on the console is the one the previous test caused.
       *
       * Console-only, so this is emulated-in-practice - which costs nothing,
       * since `client-access` already means the gadget rather than a key.
       */
      const seed = byteprintAfter(device.log.text, 'Agent derivation private key');
      assert.ok(seed, 'the device never printed a derived key - is this a DEBUG build?');
      assert.equal(seed.length, 32, `an ed25519 seed is 32 bytes, the device printed ${seed.length}`);

      const derived = ed25519PublicKey(seed);
      log(`node:crypto derives ${derived.toString('hex')}`);

      assert.bytes(derived, published.key,
        'the published key is not the ed25519 public key for the seed the device derived');
    });

  it('hashes the user and the host, and nothing else', async ({ assert, signal, log }) => {
    /*
     * Exactly `user@host` reaches the device. Not the proto, not the port, not
     * the path - pubkey() builds `id_parts` from those two fields alone when
     * the proto is ssh, and hashes that. Everything else in the identity is
     * carried in the printed comment and nowhere near the derivation.
     *
     * That asymmetry is worth pinning precisely because it is invisible: the
     * comment shows the whole identity, so two authorized_keys entries can look
     * as different as you like and be the same key. Somebody who writes
     * `ssh://okt@example.com:22` for one host and `:2222` for another gets ONE
     * key, and nothing in either the CLI's output or the device's says so.
     */
    const dropped = await agent(`${IDENTITY}:2222/some/path`, { signal });
    assert.equal(dropped.code, 0, `an identity with a port and path failed: ${dropped.stderr}`);
    const droppedKey = parseSshPublicKey(dropped.stdout.trim());

    assert.bytes(droppedKey.key, published.key,
      'the port or the path reached the derivation - only user@host is hashed');
    assert.equal(droppedKey.comment, `<${IDENTITY}:2222/some/path|ed25519>`,
      'the port and path are meant to survive into the comment even though they are not hashed');

    /*
     * And the proto is not merely unhashed, it is REWRITTEN. ssh/main() does
     * `identity.identity_dict['proto'] = 'ssh'` over whatever was parsed, so a
     * different scheme does not produce a different key OR a different comment -
     * it produces byte-identical output. Found by asserting the opposite: the
     * first version of this test compared `example.com` against
     * `ssh://example.com` believing the comments would differ, and they do not,
     * because by then both are `ssh://`.
     */
    const other = await agent('git://okt@example.com', { signal });
    assert.equal(other.code, 0, `a git:// identity failed: ${other.stderr}`);
    log(`git:// published as ${parseSshPublicKey(other.stdout.trim()).comment}`);
    assert.equal(other.stdout.trim(), published.line,
      'a different proto produced different output - it is supposed to be normalised to ssh://');

    /*
     * The other direction, and what makes the rest mean anything: something
     * that IS hashed has to change the key. Without this, everything above
     * holds equally for a firmware that ignored the host's 32 bytes entirely
     * and handed out one key for every identity ever asked for.
     */
    const bare = await agent(HOST_ONLY, { signal });
    assert.equal(bare.code, 0, `${HOST_ONLY} failed: ${bare.stderr}`);
    const bareKey = parseSshPublicKey(bare.stdout.trim());

    assert.equal(bareKey.comment, `<ssh://${HOST_ONLY}|ed25519>`,
      'an identity typed with no proto is still published with one');
    assert.notEqual(bareKey.key.toString('hex'), published.key.toString('hex'),
      'dropping the user changed nothing - the user is not being hashed');
  });

  it('wrote nothing to the device, across everything above', async ({ device, assert, log }) => {
    /*
     * The claim in TC-13's row - "no device state changed" - stated as a fact
     * about the run rather than a description of the design. A derived key is
     * derived on demand and never stored, so no flash sector should have been
     * erased by any of the six exports above; okcrypto_derive_key() only READS
     * slot 132.
     *
     * `Erase Sector` is the same marker 01-pqc-keygen counts to prove a keygen
     * wrote its slot exactly once. Here the honest number is zero, and it is
     * checked last so it covers every test in the file.
     */
    const erased = device.log.count(ERASED) - erasedAtStart;
    log(`flash sector erases during this file: ${erased}`);
    assert.equal(erased, 0,
      'exporting a derived SSH key wrote flash - it is supposed to store nothing');
  });
});
