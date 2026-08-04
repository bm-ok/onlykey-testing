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

/**
 * Load one of the library's modules against these imports.
 *
 * Extra arguments are passed through, because not every module takes only
 * imports: onlykey-3rd-party.js is `function (imports, onlykeyApi)` and returns
 * a factory of its own, and onlykey-pgp.js takes the same api object.
 */
function load(imports, moduleName, ...rest) {
  return require(path.join(LIB_ROOT, 'onlykey', moduleName))(imports, ...rest);
}

/*
 * The web app's own resolver, as far as these modules need it.
 *
 * age_pqc.js requires @noble/* by bare specifier, and onlykey-fido2's
 * package.json declares none of them - not an oversight. They are VENDORED, at
 * onlykey/vendor/@noble, and webpack.config.js aliases the bare specifiers onto
 * that directory ("this alias is the only thing that lets those resolve without
 * modifying the vendored files themselves"). Node knows nothing about that
 * alias, so the file cannot be require()d where it lives without help.
 *
 * The alias is tried first, and usually does not survive: the vendored packages
 * are ESM, and @noble/post-quantum imports @noble/hashes by bare specifier
 * INTERNALLY - which is the case webpack's alias exists for and which Node's
 * ESM resolver has no equivalent of short of a custom loader. So this falls
 * back to the copies installed here.
 *
 * That fallback is only safe because the two are the same build, and "only
 * safe because" is not something to leave implied - vendoredVersions() below
 * reports what the app ships so a test can require them to match. If the web
 * app ever vendors a different @noble, a parity test quietly running this kit's
 * copy would keep passing while proving nothing.
 */
const VENDOR = path.join(LIB_ROOT, 'onlykey', 'vendor');
const ALIASES = ['@noble/hashes', '@noble/post-quantum', '@noble/ciphers', '@noble/curves'];

/** The vendored file a bare specifier maps to, or null. */
function vendored(id) {
  const alias = ALIASES.find((a) => id === a || id.startsWith(`${a}/`));
  if (!alias) return null;
  return path.join(VENDOR, id);
}

/**
 * What the web app actually vendors, and what is installed here.
 *
 * A test asserts these agree. They are the same packages by name and the same
 * maths by intent, but the fallback above means the parity tests run the
 * installed copy - so equality here is what makes those tests mean anything.
 *
 * @returns {Array<{name:string, vendored:string|null, ours:string|null}>}
 */
function vendoredVersions() {
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).version || null; } catch { return null; }
  };
  return ALIASES.map((name) => ({
    name,
    vendored: read(path.join(VENDOR, name, 'package.json')),
    /* Resolved the way lib/age-pqc.js would resolve it, not by guessing a path. */
    ours: read(path.join(
      path.dirname(require.resolve('./paths')), '..', 'node_modules', name, 'package.json'
    )),
  }));
}

/**
 * Load a PLAIN CommonJS module from the library - one that takes no imports -
 * resolving its dependencies the way the app's build does.
 *
 * Order: the webpack alias first (so the vendored copies win, as they do in a
 * real build), then the module's own directory, then this kit as a last resort
 * for anything neither ships.
 */
function loadPlain(moduleName) {
  const file = path.join(LIB_ROOT, 'onlykey', moduleName);
  const dir = path.dirname(file);
  const source = fs.readFileSync(file, 'utf8');

  const mod = new Module(file, null);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(dir);

  /*
   * Two different "not found" codes, and both have to be caught. A CommonJS
   * miss is MODULE_NOT_FOUND; the vendored packages are ESM, so a bare
   * specifier they import internally fails as ERR_MODULE_NOT_FOUND from a
   * completely different resolver. Catching only the first turns the intended
   * fallback into a hard failure.
   */
  const missing = (err) => err
    && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND');

  const localRequire = (id) => {
    const alias = vendored(id);
    if (alias) {
      try { return mod.require(alias); } catch (err) {
        if (!missing(err)) throw err;
      }
    }
    try {
      return mod.require(id);
    } catch (err) {
      if (!missing(err)) throw err;
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

module.exports = {
  create, load, loadPlain, probe, vendoredVersions,
  LIB_ROOT, VENDOR, quietConsole,
};
