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
