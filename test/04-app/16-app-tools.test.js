/*
 * Section 4: the App's Tools tab.
 *
 * THIS TAB REACHES NO DEVICE, AND THAT IS THE FINDING RATHER THAN A LIMITATION.
 * MEASURED FROM THE LIVE DOM, not from the markup: 8 anchors, 6 buttons, and
 * ZERO inputs, selects and forms. The first version of this file said "six
 * anchors and nothing else" because it was read out of app.html with a regex
 * that stopped at the first <dialog> - wrong on both counts, and caught by its
 * own assertion rather than by review. Read the panel, not the source.
 *
 * The device claim rests on the zeros, not on the buttons: the six buttons wrap
 * the six labelled links and open URLs, and with no input, select or form there
 * is nothing on the tab that can carry a value anywhere. It is a launcher for
 * the WEB app and
 * the agent documentation, so everything behind it is already covered: the
 * encrypt and decrypt pages by `03-gui/08` and `03-gui/14`, the GPG and SSH
 * agents by `02-cli/09` and `02-cli/08`. There is no device behaviour here to
 * test, and a file that pretended otherwise would be inventing work.
 *
 * SO WHAT IS WORTH ASSERTING IS THE DESTINATIONS, because a link is the one
 * thing here that can break silently and take a user somewhere wrong.
 *
 * NOTHING IS EVER CLICKED. `external-links.js` opens these with
 * `nw.Shell.openExternal`, which hands the URL to the user's REAL browser - so
 * a click would spawn a browser outside the kit's process groups and make a
 * network request to a third party. Neither belongs in a test run. The hrefs
 * are read from the DOM instead, which is what the assertion needs anyway.
 *
 * THE DESTINATIONS ARE PINNED AS THEY SHIP, AND FOUR OF THEM LOOK WRONG. Every
 * link points at `apps.crp.to`, while every maintained component in this tree
 * uses `onlyagent.app`: `lib/device/tunnel.js:42` pins it, python-onlykey names
 * it in five places as "the fixed derivation origin shared with the web app",
 * and the web app's own client carries `//rpId: 'apps.crp.to'` COMMENTED OUT.
 *
 * That matters more than a dead link would, because the four `/app/*` links go
 * to pages whose keys are rpId-derived: `okcrypto_hkdf()` folds the RPID into
 * the derivation, so the same OnlyKey on a different origin produces DIFFERENT
 * keys with no error at all - the failure README describes as surfacing much
 * later as "no identity matched any of the recipients". Whether that is live or
 * merely dead depends on what `apps.crp.to` serves today, which is one HTTP
 * request a maintainer can make and this kit deliberately does not.
 *
 * Pinned as it ships, per the kit's convention: these assertions FAIL the day
 * the links are corrected, and that is the convention working.
 *
 * `requires` does NOT include `client-access` - nothing here needs a device, and
 * asking for one would make the runner raise a gadget for a file that never
 * uses it. Same reasoning as `19-stop`.
 */
'use strict';

const { describe, it } = require('../../lib/harness');

const session = require('../../lib/app-session-holder');

/**
 * Every anchor, in document order, exactly as it ships. Two carry no text -
 * they are the panel's heading links - and are asserted as empty deliberately,
 * since a label appearing there is a change worth seeing.
 */
const LINKS = [
  ['', 'https://docs.crp.to/webcrypt.html'],
  ['Encrypt Messages', 'https://apps.crp.to/app/encrypt'],
  ['Decrypt Messages', 'https://apps.crp.to/app/decrypt'],
  ['Encrypt Files', 'https://apps.crp.to/app/encrypt-file'],
  ['Decrypt Files', 'https://apps.crp.to/app/decrypt-file'],
  ['', 'https://docs.crp.to/onlykey-agent.html'],
  ['OnlyKey GPG Agent', 'https://docs.crp.to/onlykey-agent.html#gpg-agent-quickstart-guide'],
  ['OnlyKey SSH Agent', 'https://docs.crp.to/onlykey-agent.html#ssh-agent-quickstart-guide'],
];

describe('app tools', {
  requires: ['display', 'nwjs'],
  timeoutMs: 120000,
}, () => {
  it('shows the Tools tab as external links and nothing that reaches the device',
    async ({ assert, log }) => {
      const s = session.get();
      const page = await s.attach('app');
      try {
        await page.eval("document.getElementById('show-tools-panel').click()");

        const found = JSON.parse(await page.eval(`(() => {
          const panel = document.getElementById('tools-panel');
          if (!panel) return JSON.stringify({ missing: true });
          return JSON.stringify({
            links: Array.from(panel.getElementsByTagName('a'))
              .map((a) => [a.textContent.trim(), a.getAttribute('href')]),
            /* Anything that could carry a value to the device. */
            inputs: panel.getElementsByTagName('input').length,
            selects: panel.getElementsByTagName('select').length,
            buttons: panel.getElementsByTagName('button').length,
            forms: panel.getElementsByTagName('form').length,
          });
        })()`));

        assert.ok(!found.missing, 'the App has no tools-panel');
        log(`tools-panel: ${found.links.length} links, ${found.inputs} inputs, ` +
          `${found.selects} selects, ${found.buttons} buttons, ${found.forms} forms`);

        /*
         * The claim "this tab reaches no device" is made the strong way, by
         * requiring the absence of every control that could carry a value,
         * rather than by observing that no traffic happened to appear.
         */
        assert.equal(found.inputs, 0, 'the Tools tab grew an input - it may now reach the device');
        assert.equal(found.selects, 0, 'the Tools tab grew a select - it may now reach the device');
        assert.equal(found.forms, 0, 'the Tools tab grew a form - it may now reach the device');

        /*
         * Buttons are EXPECTED here - six of them, wrapping the labelled links -
         * so their count is pinned rather than required to be zero. A seventh is
         * worth a look; a button is the one control on this tab that could grow
         * a device call without also growing an input.
         */
        assert.equal(found.buttons, 6,
          `the Tools tab has ${found.buttons} buttons rather than 6 - check whether ` +
          'the new one opens a URL or does something to the device');

        assert.equal(found.links.length, LINKS.length,
          `the Tools tab has ${found.links.length} links rather than ${LINKS.length}`);
      } finally {
        page.close();
      }
    });

  it('links to apps.crp.to, which every maintained client in this tree replaced with onlyagent.app',
    async ({ assert, log }) => {
      const s = session.get();
      const page = await s.attach('app');
      try {
        await page.eval("document.getElementById('show-tools-panel').click()");

        const links = JSON.parse(await page.eval(`(() => {
          const panel = document.getElementById('tools-panel');
          return JSON.stringify(Array.from(panel.getElementsByTagName('a'))
            .map((a) => [a.textContent.trim(), a.getAttribute('href')]));
        })()`));

        for (const [i, [label, href]] of links.entries()) {
          const [wantLabel, wantHref] = LINKS[i];
          log(`${label} -> ${href}`);
          assert.equal(label, wantLabel, `link ${i} is labelled ${label}`);
          assert.equal(href, wantHref,
            `link ${i} (${label}) points at ${href} rather than ${wantHref} - if this ` +
            'is the apps.crp.to -> onlyagent.app correction, invert the expectation ' +
            'rather than repairing it, and see this file\'s header for why the four ' +
            '/app/* links matter more than the two documentation ones');
        }

        /*
         * State the consequence where it will be read, not only in the header:
         * the four /app/* destinations are rpId-derived, so a wrong origin is a
         * different key rather than a broken page.
         */
        const derived = links.filter(([, href]) => href.includes('/app/'));
        assert.equal(derived.length, 4,
          'the number of rpId-derived destinations changed, which changes how much ' +
          'the origin above matters');
      } finally {
        page.close();
      }
    });
});
