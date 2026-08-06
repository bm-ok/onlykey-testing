/*
 * What a dead device host means, against every way it can die.
 *
 * EXPLAINER calls this "the part that has to be exact", and it is the one piece
 * of the kit whose important cases a normal run almost never produces. An
 * expected restart happens hundreds of times; an OOM kill, a mapping collision
 * and a firmware segfault happen rarely and matter enormously - and they are
 * not distinguishable by luck: an expected restart and an OOM kill are
 * byte-identical as signals (code:null, SIGKILL), separated only by the marker
 * file the child wrote before killing itself.
 *
 * So the decision is a pure function and this checks it directly, rather than
 * waiting for a real crash to exercise a branch. That is the same argument the
 * rest of this section makes for CBOR and the framing: check the oracle against
 * known answers before trusting what it says about a device.
 *
 * `device: false`.
 */
'use strict';

const { describe, it } = require('../../lib/harness');
const { classifyExit, FATAL, MAX_MAP_RETRIES } = require('../../lib/device/emulated');
const { watchdogVerdict, EXIT } = require('../../lib/runner');

const EXIT_MAPFAIL = 7;

describe('classifying a dead device host', { device: false }, () => {
  it('calls a marked exit a restart, whatever the signal says', async ({ assert }) => {
    /*
     * The marker wins over everything, and it has to: the child writes it
     * synchronously before killing itself, and without it a reboot is
     * indistinguishable from being killed from outside.
     */
    for (const exit of [
      { signal: 'SIGKILL', code: null },
      { signal: 'SIGSEGV', code: null },
      { signal: null, code: 0 },
    ]) {
      const verdict = classifyExit({ ...exit, expected: true, ready: true });
      assert.equal(verdict.kind, 'restart',
        `a marked exit with ${JSON.stringify(exit)} was not read as a restart`);
    }
  });

  it('calls an unmarked SIGKILL an external kill, not a reboot', async ({ assert }) => {
    /* The other side of the same coin, and the reason the marker exists. */
    const verdict = classifyExit({
      signal: 'SIGKILL', code: null, expected: false, ready: true,
    });

    assert.equal(verdict.kind, 'fatal');
    assert.equal(verdict.fatal, FATAL.HOST_KILLED);
    assert.includes(verdict.reason, 'OOM');
  });

  it('calls a segfault after boot a firmware crash', async ({ assert }) => {
    /* `ready` true means this generation printed its banner and then died -
     * which is a real crash, in code that had already started running. */
    const verdict = classifyExit({
      signal: 'SIGSEGV', expected: false, ready: true, mapRetries: 0, generation: 4,
    });

    assert.equal(verdict.kind, 'fatal');
    assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH);
    assert.includes(verdict.reason, 'generation 4');
  });

  it('retries a segfault during boot', async ({ assert }) => {
    /*
     * The case that cost whole runs. The boot-time mapping collision does not
     * always report itself as a clean exit code - it can arrive as a SIGSEGV,
     * and that took the fatal path. A crash before the banner cannot have
     * corrupted anything a later test depends on, which is exactly what makes
     * retrying it safe and retrying the case above unsafe.
     */
    const verdict = classifyExit({
      signal: 'SIGSEGV', expected: false, ready: false, mapRetries: 0,
    });

    assert.equal(verdict.kind, 'retry', 'a boot-time segfault should be retried');
    assert.includes(verdict.reason, 'boot');
  });

  it('gives up on a boot that keeps segfaulting', async ({ assert }) => {
    /*
     * A retry is for a flaky start, not a broken build. Once the budget is
     * spent the answer has to become fatal, and say which of the two it was -
     * "no longer a flaky start" is the sentence somebody reads at three in the
     * morning.
     */
    const verdict = classifyExit({
      signal: 'SIGSEGV', expected: false, ready: false, mapRetries: MAX_MAP_RETRIES,
    });

    assert.equal(verdict.kind, 'fatal');
    assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH);
    assert.includes(verdict.reason, 'no longer a flaky start');
  });

  it('reads the addon\'s own segfault line, not only the signal', async ({ assert }) => {
    /*
     * The addon writes "[okemu] FATAL: segfault at" plus a backtrace before the
     * process dies, so the evidence survives even when the exit arrives without
     * SIGSEGV attached.
     */
    const verdict = classifyExit({
      signal: null,
      code: 1,
      stderr: 'some noise\n[okemu] FATAL: segfault at 0x0\n  #0 ...',
      expected: false,
      ready: true,
    });

    assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH,
      'the backtrace was ignored because the signal was missing');
  });

  it('calls a SIGABRT a firmware crash, because _FORTIFY_SOURCE is why it aborted',
    async ({ assert }) => {
      /*
       * The case this file existed without, and the one the kit got backwards.
       * SIGABRT used to fall through to HOST_DIED - exit 5, "no verdict about
       * the device" - when it is the clearest verdict there is: the emulator
       * builds with _FORTIFY_SOURCE so an overflow aborts at the write, which
       * is how the RSA-4096 defect was found in the first place.
       */
      const verdict = classifyExit({
        code: null, signal: 'SIGABRT', stderr: '', ready: true, generation: 2,
      });
      assert.equal(verdict.kind, 'fatal');
      assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH,
        'a fortify abort is the firmware crashing, not the host dying');
      assert.match(verdict.reason, /aborted/);
    });

  it('reads glibc\'s own overflow line, not only the signal', async ({ assert }) => {
      /*
       * The parallel of the segfault test below it, and it needs its own case
       * because the two are reported by DIFFERENT writers. The addon prints
       * "[okemu] FATAL: segfault at" from its own handler; nothing prints
       * anything for an abort, because okemu_restart.cpp only handles SIGSEGV -
       * glibc writes the diagnosis and dies. So a run that captured the text
       * but lost the signal still has to reach the right verdict.
       */
      const verdict = classifyExit({
        code: 134, signal: null, ready: true, generation: 1,
        stderr: 'Slot =  2\nType =  68\n*** buffer overflow detected ***: terminated\n',
      });
      assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH,
        'the fortify diagnosis alone should be enough to call it a firmware crash');
    });

  it('does NOT retry an abort during boot, unlike a segfault', async ({ assert }) => {
      /*
       * The deliberate asymmetry, asserted so it does not get "fixed" into
       * symmetry later. A segfault before the banner is retried because it is
       * usually the flash mapping losing a race. A fortify abort is a
       * deterministic memory error - the same input aborts again next boot - so
       * retrying turns one clear failure into three slow ones.
       */
      const verdict = classifyExit({
        code: null, signal: 'SIGABRT', stderr: '', ready: false, mapRetries: 0,
        generation: 0,
      });
      assert.equal(verdict.kind, 'fatal',
        'an abort during boot is still a firmware crash, not a flaky start');
      assert.equal(verdict.fatal, FATAL.FIRMWARE_CRASH);
    });

  it('retries a mapping failure, then gives up naming it', async ({ assert }) => {
    const retry = classifyExit({
      code: EXIT_MAPFAIL, expected: false, ready: false, mapRetries: 0,
    });
    assert.equal(retry.kind, 'retry');

    const spent = classifyExit({
      code: EXIT_MAPFAIL, expected: false, ready: false, mapRetries: MAX_MAP_RETRIES,
    });
    assert.equal(spent.kind, 'fatal');
    assert.equal(spent.fatal, FATAL.MAP_FAILED,
      'a spent mapping retry must not be reported as a firmware crash');
  });

  it('reports a fired watchdog as EXIT.WATCHDOG, wherever it fired', async ({ assert }) => {
    /*
     * THE CASE THAT COST A 900-SECOND RUN ITS VERDICT. A run-max that fired
     * while a device host was booting was reported as exit 5 - "the device host
     * died for a reason that is not the firmware's fault" - because the boot
     * path fell through its `|| { code: EXIT.HOST_DIED }` fallback instead of
     * asking whether a watchdog had already spoken. The sentinel's own reason
     * string named the watchdog, so the sentence was right and the code
     * contradicted it, which is worse than both being wrong: README's whole
     * claim is that the code says what kind of problem it is WITHOUT reading
     * anything else, and every consumer of this kit rests on that.
     *
     * All three watchdogs, because the boot path is reachable from any of them
     * and only one of them was ever observed doing it.
     */
    for (const kind of ['run-max', 'inactivity', 'per-test']) {
      const verdict = watchdogVerdict({ fired: { kind, reason: 'because', pending: [] } });
      assert.equal(verdict.code, EXIT.WATCHDOG,
        `a ${kind} watchdog reported ${verdict.code}, not ${EXIT.WATCHDOG} - a watchdog ` +
        'hidden behind another code is a run whose verdict cannot be read off the exit');
      assert.includes(verdict.reason, `${kind} watchdog`);
    }
  });

  it('says what a watchdog was WAITING FOR, not only that it fired', async ({ assert }) => {
    /*
     * EXPLAINER: "a watchdog must report where it was blocked ... because
     * otherwise a stalled transport and a genuinely slow device look the same,
     * which is the failure mode this whole kit is designed to eliminate." The
     * pending list is that report, and it is easy to drop while refactoring the
     * message, since nothing else reads it.
     */
    const verdict = watchdogVerdict({
      fired: { kind: 'inactivity', reason: 'no progress for 31s', pending: ['waitHid(vendor)', 'log /UNLOCKED/'] },
    });

    assert.includes(verdict.reason, 'pending: waitHid(vendor); log /UNLOCKED/');
  });

  it('has no verdict when no watchdog fired, so the device gets to speak',
    async ({ assert }) => {
      /*
       * The other direction, and the reason this is a function rather than a
       * flag: a null here is what lets a firmware crash report as exit 2. If it
       * returned a watchdog verdict unconditionally, every crash would be
       * relabelled as a timeout.
       */
      assert.equal(watchdogVerdict({ fired: null }), null);
      assert.equal(watchdogVerdict({}), null);
      assert.equal(watchdogVerdict(null), null);
    });

  it('has a verdict for an exit nobody anticipated', async ({ assert }) => {
    /*
     * Anything that reaches the end is the host exiting for its own reasons,
     * and it must still be classified rather than falling through as a silent
     * undefined - the run needs a verdict, and "died for a reason not on this
     * list" is one.
     */
    const verdict = classifyExit({
      code: 42, signal: null, expected: false, ready: true,
    });

    assert.equal(verdict.kind, 'fatal');
    assert.equal(verdict.fatal, FATAL.HOST_DIED);
    assert.includes(verdict.reason, '42');
  });
});
