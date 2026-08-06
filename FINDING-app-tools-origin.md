# The OnlyKey App links to an origin the firmware does not stage

**Component:** `OnlyKey-App` (the packaged nw.js configuration app), `app/app.html`, Tools tab
**Severity:** depends on one hosting fact this write-up deliberately does not
establish - see "What decides the severity". Either an untidy link, or silent
key divergence.
**Found by:** reading the Tools tab while writing section 4 of `onlykey-testing`,
2026-08-06. Not by driving anything - see "Why there is no test for this".
**Status:** measured from source in this workspace. No HTTP request was made.

## What

The App's Tools tab holds eight external links. Four of them point at
`apps.crp.to`:

| link | href |
|---|---|
| Encrypt Messages | `https://apps.crp.to/app/encrypt` |
| Decrypt Messages | `https://apps.crp.to/app/decrypt` |
| Encrypt Files | `https://apps.crp.to/app/encrypt-file` |
| Decrypt Files | `https://apps.crp.to/app/decrypt-file` |

The other four go to `docs.crp.to` and are documentation, which nothing here is
about.

The device, meanwhile, has a different origin compiled into it.

## The firmware pins `onlyagent.app`

This is the part that matters, and it is why the finding does not rest on any
client's convention:

```
libraries/onlykey/okcrypto.cpp:245   const char rpid[] = "onlyagent.app";
libraries/fido2/device.cpp:89        SHA256("onlyagent.app") - OnlyAgent origin
libraries/fido2/device.cpp:112       compared against the incoming appid
```

`okcrypto_hkdf()` folds the RPID into the derivation. So the origin a page is
served from is an *input to the key*, not a detail of where it is hosted: the
same OnlyKey at a different origin derives different keys, with no error at any
layer. README records how that presents - much later, as "no identity matched
any of the recipients".

And the web app is deployed at that origin:

```
onlykey.github.io/BUILD.sh:67        echo onlyagent.app > ./docs/CNAME
onlykey.github.io/docs/CNAME         onlyagent.app
```

## What this is NOT

Two tempting phrasings are both wrong, and the first was in this repo's history
until it was checked:

**"Every maintained client moved to `onlyagent.app` and the App did not."**
False. `onlykey.github.io`'s own source still carries `apps.crp.to`, including a
LIVE occurrence: `src/onlykey-fido2/index.js:106` passes `"https://apps.crp.to"`
as `getAssertion`'s origin argument. The App's links are consistent with strings
still present in the shipped web client. python-onlykey does pin
`onlyagent.app` (`onlykey/age_plugin/derived_xwing.py:30`), and so does this
test kit (`lib/device/tunnel.js:42`) - but a test kit and a plugin agreeing is
not the same as the web client having moved.

**"`index.js`'s `apps.crp.to` sets the rpId."** Also false, and this is what
settles the derivation question. Both `rpId: domain` (`index.js:100`) and
`appid:` (`:103`) are **commented out**, so no rpId is passed and WebAuthn falls
back to the runtime origin. The live string is an origin/postMessage argument.
The effective RPID is therefore whatever domain served the page - which the
CNAME makes `onlyagent.app`.

## What decides the severity

**What does `apps.crp.to` serve today?**

- If it **redirects** to `onlyagent.app`, the browser's origin after the
  redirect is the final one, the derivation is unaffected, and this is an untidy
  link and nothing more.
- If it **serves the app directly**, a user who reaches the encrypt page through
  the App's Tools tab derives different keys from one who reaches it at
  `onlyagent.app`, silently.
- If it is **dead**, the links are broken.

That is one HTTP request, and it is a hosting question rather than a firmware or
client one, so this kit does not answer it. Note that the pages themselves are
in this workspace - `onlykey.github.io/docs/app/{encrypt,decrypt,encrypt-file,decrypt-file}.html`
- and section 3 drives them locally, so nothing about *the pages* is unknown.
Only the DNS is.

(If checking those pages by hand: serve them at `localhost`, never `127.0.0.1`.
WebAuthn refuses an IP as an rpId, the pages swallow the error, and the only
symptom is an output box that never fills. `lib/gui.js` probes readiness at
`127.0.0.1` but the browser is always pointed at `http://localhost:3000`.)

## Why there is no test for this

There was one, briefly, and it was removed on 2026-08-06 by decision.

The Tools tab is a launcher: eight anchors, six buttons wrapping four of them,
and zero inputs, selects or forms. Nothing on it reaches the device -
`external-links.js` hands each URL to `nw.Shell.openExternal`, which opens the
user's real browser. A link that opens an external page has no behaviour to
assert, so a test there could only pin href strings, which is maintenance
without a subject.

The finding does not depend on the tab either. It rests on a firmware constant
and a CNAME, both of which are checkable by reading, and neither of which a test
that drove the App would establish any better.

## Suggested fix

Point the four `/app/*` links at `onlyagent.app`, matching `okcrypto.cpp:245`
and `docs/CNAME`. If `apps.crp.to` is meant to remain live, make it a redirect
rather than a second origin serving the same app, so that the RPID a user's
browser ends up with is the one the device stages.
