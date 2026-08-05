/*
 * The `onlykey-cli` endpoint sweep, part four: the commands that read stdin or
 * change what the device IS.
 *
 * REGROUPED FROM THE ORIGINAL PLAN, and the reason is a finding from the sweep
 * itself. TODO put `set-pin`, `change-pin`, `reset` and `wink` here as
 * "lifecycle". They are none of them OnlyKey commands: cli.py hands all four
 * straight to `solo.cli.key()`, so they reach the device over FIDO and speak
 * CTAP, and `set-pin` sets the FIDO2 CLIENT PIN rather than the device PIN
 * anybody would assume from the name. They belong with `credential` in
 * 14-cli-fido, and the five-file split is unchanged - only which file two of
 * them live in.
 *
 * What is left here is the commands that need a terminal, plus the two that
 * change the device's own life story:
 *
 *   settime            the device clock, which is RAM-only and rebased on boot
 *   password           setslot's stdin half
 *   totpkey / gkey     the same, for 2FA secrets
 *   backuppassphrase   OKSETPRIV, gated on config mode
 *   restore            OKRESTORE, from a backup file
 *   init               the first-use PIN walk
 *
 * prompt_toolkit DOES drive from a pipe. It warns ("Input is not a terminal")
 * and redraws its prompt oddly in captured output, but the value arrives
 * intact - so `input:` on cli.run() is enough and no pty is needed.
 *
 * SURFACES, marked per test as everywhere in this sweep - see PRODUCTION.md.
 * The best assertion in this file is on the KEYBOARD interface, which survives
 * into a production walk: a password written by the command line is read back
 * by pressing the button and decoding what the device types. That is the only
 * end-to-end check in the sweep that a written secret is the one that comes out.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { IFACE, okmsg } = require('../../lib/device');
const { PINS } = require('../../lib/config');
const cli = require('../../lib/cli');
const pqc = require('../../lib/pqc');

const ANSWER = (buf) => {
  const text = okmsg.text(buf);
  return !!text && text !== 'INITIALIZED';
};

const SLOT = 3;                              // slot 3a, this file's scratch slot
const SECRET = 'oktpw2026';

/* At least 25 characters, which the CLI enforces host-side. */
const PASSPHRASE = 'okt-test-backup-passphrase-2026';

describe('onlykey-cli, the stdin and life-cycle endpoints', {
  state: 'initialized',
  requires: ['crypto', 'client-access'],
  timeoutMs: 300000,
}, () => {
  const needCli = ({ skip }) => {
    if (!cli.venvPresent()) skip(`no venv at ${cli.VENV_BIN}`);
    cli.binary('onlykey-cli');
  };

  const okc = (argv, opts) => cli.run('onlykey-cli', argv, { timeoutMs: 40000, ...opts });

  async function sent(device, argv, { signal, input, replies = 1 }) {
    const since = device.mark(IFACE.VENDOR);
    const result = await okc(argv, { signal, input });
    await device.waitHid(IFACE.VENDOR, { since, match: ANSWER, timeoutMs: 12000, signal });
    if (replies > 1) await device.sleep(800, { signal });
    const said = device.reportsSince(IFACE.VENDOR, since)
      .map((r) => okmsg.text(r).trim()).filter((t) => t && t !== 'INITIALIZED');
    return { result, said };
  }

  const outOfConfigMode = async (device, signal) => {
    await device.restart({ signal });
    await device.ensureUnlocked(PINS.primary, { signal });
  };

  it('`settime` sets the clock and reports what the device answered',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * OKCONNECT under another name. The device answers with its model string,
       * and the CLI prints exactly that - so this is the same two-reader check
       * the rest of the sweep makes, on the one command every other client runs
       * first. It matters more than it looks: the clock is RAM-only and rebased
       * on every boot, so anything counter or TOTP derived is wrong until this
       * has run.
       */
      const { result, said } = await sent(device, ['settime'], { signal });
      log(`device answered ${JSON.stringify(said[0])}`);

      assert.match(said[0], /^UNLOCKED/, `expected a model string, got ${JSON.stringify(said)}`);
      assert.equal(result.stdout.trim(), said[0],
        'the CLI printed something other than what the device answered');
    });

  it('`password` is stored from stdin, and the device types it back',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });

      /*
       * Out of config mode, not merely unlocked, and this one was found by
       * `--reverse` rather than by reasoning. In config mode a button press is
       * config input rather than a slot press, so the device types NOTHING and
       * the failure reads "the device typed "" in three presses" - which names
       * the keyboard, not the mode.
       *
       * It passed alone and passed in file order, where this test runs second.
       * Only reversed - after `backuppassphrase`, which ends in config mode -
       * does it break. That is the whole reason --reverse exists.
       */
      await outOfConfigMode(device, signal);

      /* SURFACE: vendor - the write is acknowledged by name. */
      const { result, said } = await sent(device, ['setslot', '3a', 'password', 'x'],
        { signal, input: `${SECRET}\n` });
      assert.equal(said[0], 'Successfully set Password',
        `the device answered: ${JSON.stringify(said)}`);
      assert.includes(result.stdout, 'Successfully set Password',
        'the CLI did not relay the acknowledgement');

      /*
       * SURFACE: keyboard - survives into a production walk, and this is the
       * assertion the whole file exists for.
       *
       * Everything else in the sweep checks that a write was ACCEPTED. This
       * checks that the secret which came back out is the one that went in, by
       * the route a user actually uses: press the button, read what the device
       * typed. No console, no vendor readback - just the two ends of the
       * feature. On a physical key this same assertion needs privileged access
       * to every keystroke on the machine; here the keyboard interface is an
       * event.
       *
       * Pressed up to three times because a press that lands mid-LED-fade is
       * discarded silently - payload() returns early on `isfade` - and a slot
       * write starts a fade. That is what a person does when a key does not
       * respond, and it is the only honest option since the firmware prints
       * nothing when the fade ends. Measured in 08-slot-keyboard: the first
       * press after configuring a slot never types, the second one does.
       */
      device.keys.clear();

      let typed = null;
      for (let attempt = 1; attempt <= 3 && !typed; attempt++) {
        device.press(SLOT);
        typed = await device.waitKeystrokes(SECRET, { timeoutMs: 6000, signal }).catch(() => null);
        if (!typed) log(`press ${attempt} landed mid-fade and was discarded`);
      }

      assert.ok(typed, `the device typed ${JSON.stringify(device.keystrokes)} in three presses`);
      assert.includes(device.keystrokes, SECRET,
        'the device typed something other than the password the command line stored');
    });

  it('`totpkey` stores a 2FA secret from stdin',
    async ({ device, assert, signal, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /* SURFACE: vendor - survives into a production walk. */
      const { result, said } = await sent(device, ['setslot', '3a', 'totpkey', 'x'],
        { signal, input: 'ABCDEFGHIJKLMNOP\n' });
      assert.equal(said[0], 'Successfully set 2FA Key',
        `the device answered: ${JSON.stringify(said)}`);
      assert.includes(result.stdout, 'Successfully set 2FA Key',
        'the CLI did not relay the acknowledgement');
    });

  it('`gkey` stores a base32 secret, and cannot be told apart from its sibling on the wire',
    async ({ device, assert, signal, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk, but only so far, and
       * the limit is worth stating rather than papering over.
       *
       * `gkey` base32-DECODES what it is given and sends the bytes; its sibling
       * sends the text as typed. Two different payloads, and the device
       * acknowledges both with the identical "Successfully set 2FA Key" - so no
       * client-visible surface distinguishes them. Telling them apart would mean
       * generating a TOTP code and checking it against a host-side computation,
       * which is a real test and belongs with the challenge-mode work that is
       * already deferred in PLAN's loose ends.
       *
       * What IS asserted here: the command accepts a base32 secret and the
       * device stores something. That is the honest extent of it.
       */
      const { result, said } = await sent(device, ['setslot', '3a', 'gkey', 'x'],
        { signal, input: 'ABCDEFGHIJKLMNOP\n' });
      assert.equal(said[0], 'Successfully set 2FA Key',
        `the device answered: ${JSON.stringify(said)}`);
      assert.includes(result.stdout, 'Successfully set 2FA Key',
        'the CLI did not relay the acknowledgement');
    });

  it('`backuppassphrase` is length-checked on the host and gated on the device',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await outOfConfigMode(device, signal);

      /*
       * SURFACE: vendor - survives into a production walk; here the first
       * assertion is the SILENCE. A short passphrase is refused host-side -
       * "must be at least 25 characters" - so nothing is sent, which is the
       * right shape: a weak backup passphrase is the one thing that would make
       * an exported backup worth stealing, and the check happening before the
       * wire means it cannot be bypassed by a modified device.
       */
      const shortSince = device.mark(IFACE.VENDOR);
      const short = await okc(['backuppassphrase'], { signal, input: 'tooshort\ntooshort\n' });
      await device.sleep(700, { signal });

      assert.match(short.stdout, /at least 25 characters/i,
        `expected a length refusal, got ${JSON.stringify(short.stdout.slice(-200))}`);
      assert.equal(device.reportsSince(IFACE.VENDOR, shortSince).filter(ANSWER).length, 0,
        'a passphrase the CLI rejected still reached the device');

      /*
       * And a long enough one is refused by the DEVICE outside config mode,
       * because it goes out as OKSETPRIV - the same gate `setkey` sits behind.
       */
      const long = `${PASSPHRASE}\n${PASSPHRASE}\n`;
      const refused = await sent(device, ['backuppassphrase'], { signal, input: long });
      log(`outside config mode: ${JSON.stringify(refused.said)}`);
      assert.equal(refused.said[0], 'Error not in config mode',
        `outside config mode the device answered: ${JSON.stringify(refused.said)}`);

      /* Inside it, the device takes it. */
      await pqc.readyForKeygen(device, { signal });
      const accepted = await sent(device, ['backuppassphrase'], { signal, input: long });
      log(`in config mode: ${JSON.stringify(accepted.said)}`);
      assert.ok(!/^Error/.test(accepted.said[0]),
        `in config mode the device answered: ${JSON.stringify(accepted.said)}`);
    });

  it('`restore` asks for a file rather than guessing, and sends nothing without one',
    async ({ device, assert, signal, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk; the assertion is the
       * silence again.
       *
       * Only the rejecting path is driven here. A real restore needs a backup
       * file, and 01-protocol/10-backup-restore already does the whole round
       * trip - created by the device, captured off the keyboard interface,
       * verified against its own chained SHA256, restored, read back - over the
       * vendor interface rather than through this command. What is not covered
       * is this command carrying that file, and it is a TODO row rather than
       * something done badly here.
       */
      const since = device.mark(IFACE.VENDOR);
      const result = await okc(['restore'], { signal });
      await device.sleep(700, { signal });

      assert.includes(result.stdout, 'Usage: onlykey-cli restore',
        `expected a usage line, got ${JSON.stringify(result.stdout.slice(0, 200))}`);
      assert.equal(device.reportsSince(IFACE.VENDOR, since).filter(ANSWER).length, 0,
        'restore reached the device before deciding it had no file to restore');
    });

  it('`init` is silent on a set-up device until config mode, then re-arms its PIN machine',
    async ({ device, assert, signal, log, skip }) => {
      needCli({ skip });
      await device.ensureUnlocked(PINS.primary, { signal });

      /*
       * SURFACE: vendor - survives into a production walk.
       *
       * `init` is the first-use PIN walk: passes of OKPIN, OKPINSEC and OKPINSD
       * - the same state machines 01-protocol/04-provisioning drives on a blank
       * device - with a "Press the Enter key once you are done" between each.
       *
       * On a device that is already set up it does TWO different things
       * depending on a mode it never mentions, and prints exactly the same
       * script either way:
       *
       *   outside config mode   the device answers nothing at all
       *   inside config mode    the PIN machine re-arms, and says so
       *
       * Both are asserted here, because the pair is the finding. `init` exits 0
       * and walks its whole prompt sequence regardless, so its output tells you
       * nothing about which of the two just happened - and one of them is a key
       * that is one Enter-and-six-presses away from a replaced PIN.
       *
       * FOUND BY THE GATE, and worth recording as the second instance of a
       * hazard 11-cli-settings already documented: this test passed in sequence
       * and failed under --isolate, because the test before it left config mode
       * on and this one inherited it. The rule that catches it is the same -
       * establish the state you are asserting about - and it was not applied
       * here until --isolate said so.
       */
      await outOfConfigMode(device, signal);

      const quietSince = device.mark(IFACE.VENDOR);
      const quiet = await okc(['init'], { signal, input: '\n'.repeat(8) });
      await device.sleep(1500, { signal });

      assert.equal(quiet.code, 0, `init exited ${quiet.code}: ${quiet.stderr.slice(-300)}`);
      assert.includes(quiet.stdout, 'Press the Enter key once you are done',
        'init did not walk its prompt sequence');

      const quietSaid = device.reportsSince(IFACE.VENDOR, quietSince).filter(ANSWER)
        .map((r) => okmsg.text(r).trim());
      log(`outside config mode the device said: ${JSON.stringify(quietSaid)}`);
      assert.equal(quietSaid.length, 0,
        `outside config mode init should reach nothing, but the device answered: ${JSON.stringify(quietSaid)}`);

      /* And inside config mode it really does re-arm. */
      await pqc.readyForKeygen(device, { signal });

      const armedSince = device.mark(IFACE.VENDOR);
      await okc(['init'], { signal, input: '\n'.repeat(8) });
      await device.sleep(1500, { signal });

      const said = device.reportsSince(IFACE.VENDOR, armedSince).filter(ANSWER)
        .map((r) => okmsg.text(r).trim());
      log(`in config mode the device said: ${JSON.stringify(said)}`);

      const ready = said.filter((t) => /enter your (PIN|self-destruct PIN)/.test(t));
      const refused = said.filter((t) => /Error PIN is not between/.test(t));
      assert.ok(ready.length > 0,
        `in config mode init should arm the PIN machine: ${JSON.stringify(said)}`);
      assert.equal(refused.length, ready.length,
        `every armed pass should close out with a length error: ${JSON.stringify(said)}`);

      /*
       * And the PIN survives. This is the half that would catch a genuinely
       * destructive `init`: no buttons are pressed here, so every pass ends in
       * "Error PIN is not between 7 - 10 digits" and the fixture's own PIN must
       * still open the device. A pass that got far enough to store something
       * would leave a key that opens with nothing.
       */
      await device.restart({ signal });
      const model = await device.ensureUnlocked(PINS.primary, { signal });
      assert.match(model, /^UNLOCKED/, 'the device no longer opens with its own PIN');
    });
});
