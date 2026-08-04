/*
 * webenv.js - the browser, as far as onlykey.github.io's device library is
 * concerned, with this kit's device behind it instead of a USB stack.
 *
 * The library at onlykey.github.io/src/onlykey-fido2 is what the web app talks
 * to the device with, which makes it a third client alongside this kit's own JS
 * and python-onlykey - and the only one of the three that nothing currently
 * tests, since its own test-api was deprecated. A firmware change that breaks
 * every browser user is invisible to this tree without something like this file.
 *
 * Two things make it cheap to run outside a browser, and neither is a
 * coincidence - the library was written to be driven this way:
 *
 *   It takes its dependencies as an argument. Every module under onlykey/ is
 *   `module.exports = function (imports) {...}` reading `imports.window`,
 *   `imports.console`, `imports.nacl`, `imports.forge`. There are no globals to
 *   monkey-patch and nothing to load in a particular order.
 *
 *   It already has a Node mode. onlykey.extra.js's getOS() returns "Node" when
 *   navigator.userAgent is exactly "NODE", and onlykey-api.js branches on that
 *   to read Buffers where a browser would hand it ArrayBuffers.
 *
 * The whole device surface is ONE call: window.navigator.credentials.get(),
 * at onlykey-api.js:379. The tunnel, the PGP layer, the derivations - all of it
 * funnels through that. So this points that one function at lib/device/ctap2.js
 * rather than at hidapi, and the library reaches the emulated device over the
 * in-process bus. No USB, no kernel node, no display, no browser.
 *
 * That is the difference from both ancestors. test-api's window_replacements
 * and the old kit's browser_env.js both wired credentials.get to
 * @vincss-public-projects/fido2-client over node-hid, which is why everything
 * built on them needed a real device node. This does not, so the web app's
 * client can be tested in CI.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const { Ctap2 } = require('./device/ctap2');
const { RP_ID } = require('./device/tunnel');

/* The library lives beside this checkout; the kit must not assume where. */
const LIB_ROOT = path.join(
  require('./paths').CHECKOUTS_ROOT, 'onlykey.github.io', 'src', 'onlykey-fido2'
);

/**
 * Is the library actually there? A swap slot may not have it checked out.
 * @returns {{ok: boolean, why: string|null}}
 */
function probe() {
  try {
    require.resolve(path.join(LIB_ROOT, 'onlykey', 'onlykey-api.js'));
    return { ok: true, why: null };
  } catch {
    return {
      ok: false,
      why: `the web app's device library is not checked out at ${LIB_ROOT}`,
    };
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A WebAuthn assertion, the way a browser hands one back.
 *
 * Buffers rather than ArrayBuffers on purpose: the library's Node branch
 * (onlykey-api.js:272) does Buffer.from(response.authenticatorData.slice(...)),
 * so this is the shape it expects when getOS() says "Node".
 */
function assertionResponse(assertion, credentialId, clientDataJSON) {
  return {
    id: base64url(credentialId),
    rawId: Buffer.from(credentialId),
    type: 'public-key',
    response: {
      authenticatorData: assertion.get(2),
      signature: assertion.get(3),
      clientDataJSON: Buffer.from(clientDataJSON, 'utf8'),
      userHandle: assertion.get(4) || null,
    },
  };
}

/**
 * A failure shaped like the browser's.
 *
 * The library reads error.name and nothing else - it checks for AbortError,
 * NS_ERROR_ABORT, InvalidStateError and NotAllowedError by name. A bare Error
 * would take a path meant for something quite different, so anything the
 * authenticator refuses is reported the way a browser reports it: NotAllowedError.
 */
function webAuthnError(err) {
  const out = new Error(err && err.message ? err.message : String(err));
  out.name = 'NotAllowedError';
  out.cause = err;
  return out;
}

/**
 * The browser surface, with `device` behind it.
 *
 * @param {object} device the kit's device handle
 * @param {object} [opts] {rpId, ctap, signal, onKeepAlive}
 * @returns {object} an `imports` object to hand the library's modules
 */
function create(device, opts = {}) {
  const rpId = opts.rpId || RP_ID;
  const ctap = opts.ctap || new Ctap2(device);
  let started = ctap.started === true;

  const nacl = require(path.join(LIB_ROOT, 'onlykey', 'nacl.min.js'));
  const forge = require(path.join(LIB_ROOT, 'onlykey', 'forge.min.js'));

  const window = {
    /*
     * node:crypto's webcrypto has the two things the library reaches for -
     * subtle.digest and getRandomValues - so there is nothing to shim here
     * beyond handing it over under the name a browser uses.
     */
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),

    /*
     * The RPID is folded into the derivation - okcrypto_hkdf() reads it where
     * okcrypto.cpp stages it - so anything derived through this path is bound
     * to this origin. It has to match what tunnel.js and the CLI use, or keys
     * come out different with no error anywhere.
     */
    location: { hostname: rpId, origin: `https://${rpId}`, href: `https://${rpId}/` },

    navigator: {
      /* Exactly "NODE": getOS() compares the whole string. */
      userAgent: 'NODE',
      vendor: 'node',
      platform: 'Linux',

      credentials: {
        /**
         * The one call the library makes at the device, translated into the
         * CTAP2 GetAssertion this kit already speaks.
         */
        async get({ publicKey } = {}) {
          if (!publicKey) throw webAuthnError(new Error('no publicKey options'));

          if (!started) {
            await ctap.init(opts);
            started = true;
          }

          /*
           * A real clientDataJSON, hashed properly. The device does not read
           * it on the tunnel path, but it is signed over on every other path,
           * so building it correctly here keeps this shim honest for the
           * ceremonies as well as the tunnel.
           */
          const clientDataJSON = JSON.stringify({
            type: 'webauthn.get',
            challenge: base64url(publicKey.challenge || crypto.randomBytes(32)),
            origin: `https://${publicKey.rpId || rpId}`,
            crossOrigin: false,
          });

          const allow = (publicKey.allowCredentials || []).map(
            (c) => new Map([['id', Buffer.from(c.id)], ['type', c.type || 'public-key']])
          );

          const params = new Map([
            [1, publicKey.rpId || rpId],
            [2, crypto.createHash('sha256').update(clientDataJSON).digest()],
          ]);
          if (allow.length) params.set(3, allow);

          try {
            const assertion = await ctap.getAssertion(params, {
              timeoutMs: publicKey.timeout || 30000,
              signal: opts.signal,
              onKeepAlive: opts.onKeepAlive,
            });
            const first = publicKey.allowCredentials && publicKey.allowCredentials[0];
            return assertionResponse(
              assertion,
              (first && first.id) || Buffer.alloc(0),
              clientDataJSON
            );
          } catch (err) {
            throw webAuthnError(err);
          }
        },
      },
    },
  };

  /* The library sets and polls this itself while it waits on the device. */
  window._status = null;

  /*
   * The app event bus. In the web app this is the architect plugin system's
   * shared emitter; the library announces its progress on it and never reads
   * anything back, so an ordinary EventEmitter is the whole contract.
   *
   * Not optional, and it fails loudly rather than subtly: OK_CONNECT() emits
   * "ok-connecting" before it does anything else, so without this the very
   * first call dies inside a Promise with "Cannot read properties of
   * undefined".
   *
   * Worth having rather than stubbing to a no-op, because these five events are
   * the library's own account of what it is doing - a test can assert that a
   * handshake actually reached "ok-connected" instead of inferring it.
   */
  const app = new EventEmitter();
  /* The library is chattier than any test needs, and an unhandled 'error'
   * event on an EventEmitter throws. */
  app.setMaxListeners(0);
  app.on('error', () => {});

  return {
    window,
    app,
    console: opts.console || quietConsole(),
    nacl,
    forge,
    ctap,
    LIB_ROOT,
  };
}

/**
 * The library narrates heavily to console.log. Left on, one OKCONNECT buries
 * the run log; the failure blocks are what a post-mortem reads, and they do not
 * come from here. Pass `console` in opts to watch it.
 */
function quietConsole() {
  const noop = () => {};
  return { log: noop, warn: noop, error: noop, info: noop, debug: noop };
}

/** Load one of the library's modules against these imports. */
function load(imports, moduleName) {
  return require(path.join(LIB_ROOT, 'onlykey', moduleName))(imports);
}

/**
 * Load a PLAIN CommonJS module from the library - one that takes no imports -
 * with this kit's node_modules standing in for anything its own checkout is
 * missing.
 *
 * Needed because age_pqc.js requires @noble/post-quantum, @noble/hashes and
 * @noble/curves, and onlykey-fido2's package.json declares none of them: in a
 * browser build a bundler supplies them, and in that checkout they are simply
 * absent, so the file cannot be require()d where it lives. Supplying them from
 * here is the same act as supplying the browser surface - and it is why this
 * kit's @noble versions matter, since a different ML-KEM would make a parity
 * test meaningless.
 *
 * Resolution is tried from the module's own directory FIRST, so anything the
 * library does ship still wins; only a genuine MODULE_NOT_FOUND falls back.
 */
function loadPlain(moduleName) {
  const file = path.join(LIB_ROOT, 'onlykey', moduleName);
  const dir = path.dirname(file);
  const source = fs.readFileSync(file, 'utf8');

  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(dir);

  const localRequire = (id) => {
    try {
      return mod.require(id);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
      return require(id);
    }
  };
  localRequire.resolve = (id) => {
    try { return Module._resolveFilename(id, mod); } catch { return require.resolve(id); }
  };
  localRequire.cache = require.cache;

  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', source);
  fn.call(mod.exports, mod.exports, localRequire, mod, file, dir);
  mod.loaded = true;
  return mod.exports;
}

module.exports = { create, load, loadPlain, probe, LIB_ROOT, quietConsole };
