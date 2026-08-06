/*
 * Section 5's first file, and it tests the SECTION rather than the device.
 *
 * It exists so that `okt run 05-security` is meaningful on an otherwise empty
 * section, and so that the gate every later file depends on is itself proven
 * rather than assumed. Read test/05-security/README.md before adding anything
 * here - it carries the admission test and the two non-negotiable rules.
 *
 * `device: false`, because the subject is the harness's control mechanism.
 * Nothing here touches a device, which is also why this file may run anywhere.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

describe('section 5 controls', {
  device: false,
  /*
   * DECLARED NEGATIVE, and this file is the reason the flag is worth having:
   * `okt run 05-security --controls` must find something to check even before
   * any real security test exists, or the gate's own wiring goes unexercised
   * until the first file that needs it.
   */
  negative: true,
}, () => {
  it('lets an absence pass once a positive control has fired', async ({ assert }) => {
    /*
     * The shape every file in this section copies. The control proves the
     * instrument can see the thing at all; only then does the absence mean
     * anything.
     */
    const haystack = Buffer.from('okt-marker-0001 and then nothing of interest');

    assert.control('the search finds a marker written through the same path',
      haystack.includes('okt-marker-0001'));

    assert.absent(!haystack.includes('SECRET'),
      'the buffer does not contain the secret');
  });

  it('refuses an absence when no control has fired', async ({ assert }) => {
    /*
     * The gate proving itself. Without this, `assert.absent()` could silently
     * stop enforcing and every later file would keep passing - which is exactly
     * the failure mode the whole section is built against.
     */
    let refused = null;
    try {
      assert.absent(true, 'nothing proved this instrument works');
    } catch (err) {
      refused = err;
    }

    assert.ok(refused, 'assert.absent() passed with no control, so the gate is off');
    assert.match(refused.message, /REFUSED/,
      'the refusal should say why, not just fail');
    assert.equal(refused.constructor.name, 'MissingControlError');

    /* And this test's own control, since it is in a declared-negative file. */
    assert.control('assert.absent() refuses without a control', !!refused);
  });

  it('fails a control that did not fire, rather than recording it', async ({ assert }) => {
    /*
     * A control is a claim that something WORKED. Recording one that did not
     * fire would be worse than having none, because the ledger would then say
     * the instrument was proven when it was not.
     */
    let threw = null;
    try {
      assert.control('an instrument that does not work', false);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'a false control was accepted');
    assert.match(threw.message, /did not fire/);

    assert.control('a false control throws rather than being recorded', !!threw);
  });
});
