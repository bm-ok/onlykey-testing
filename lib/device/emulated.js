/*
 * emulated.js - the parent half of the two-process arrangement.
 *
 * Owns the device host child, the IPC socket it dials into, and - the part that
 * has to be exact - the classification of every way that child can die.
 *
 * Topology is inherited from the emulator rather than invented: the long-lived
 * process LISTENS and the restarting process dials in (lib/ipc-host.js), for
 * exactly the reason this design needs, which is that a reboot then becomes an
 * ordinary client disconnect. Reusing it also avoids a stdio pipe, which would
 * deadlock - see the note in the device host about what happens when a chatty
 * DEBUG build writes into a pipe nobody is draining.
 *
 * Four rough edges come with that reuse, and they are cheap to absorb here and
 * expensive to discover at three in the morning:
 *
 *   1. IpcHost.writeHid(iface, data) takes its arguments in the opposite order
 *      from emu.writeHid(buffer, iface). Wrapped once, here.
 *   2. IpcHost has no setPlugged sender even though the peer handles the
 *      command, so a bus-only detach has to be sent raw.
 *   3. The 'error' event carries two unrelated things - a transport Error and a
 *      device-sent {t:'error', message} frame - because _onFrame re-emits every
 *      frame under its own type name. Frames are therefore read from 'message'
 *      only, and 'error' is demuxed by shape.
 *   4. listen() probes an existing socket file by spawning a whole Node process
 *      (up to two seconds) and then throws if anything answers - a running GUI,
 *      most likely. So each run gets its own socket path inside its own run
 *      directory: no collision, no probe, and two runs can coexist.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { emulatorRoot, DEVICE_HOST } = require('../paths');
const { tracked } = require('./waits');

const EXIT_MAPFAIL = 7;
const MAX_MAP_RETRIES = 3;
const STDERR_KEEP = 8192;

/*
 * The firmware prints one of these at the end of setup(), and nothing else
 * does: "INITIALIZED" when it has PINs (OnlyKey.ino:398) and "UNLOCKED, NO PIN
 * SET" when it does not (OnlyKey.ino:370). Either one means the device is up
 * and listening, which is the only readiness signal that does not depend on
 * guessing how long a boot takes.
 */
const BOOT_BANNER = /INITIALIZED|UNLOCKED, NO PIN SET/;

/*
 * sockaddr_un.sun_path is 108 bytes on Linux, NUL included, and bind() answers
 * a longer path with EINVAL - which surfaces as a listen error and then, far
 * more confusingly, as a boot timeout, because the device host is running
 * perfectly well and simply has nobody to talk to.
 *
 * The socket belongs in the run directory, where it sits beside the log and the
 * markers and gets cleaned up with them. But this kit is explicitly not allowed
 * to assume where it was cloned, and a checkout two directories deep already
 * eats most of that budget - so when the run directory would push it over, the
 * socket goes to XDG_RUNTIME_DIR instead under a name unique to this run. What
 * actually matters is that no two runs share a path: that is what removes the
 * collision, removes ipc-host's two-second liveness probe, and lets two runs
 * coexist. Where the file lives is secondary, and the run log says which it got.
 */
const SUN_PATH_MAX = 100;   // 108 minus NUL, minus a little headroom

let socketSerial = 0;

function chooseSocketPath(runDir) {
  const inRun = path.join(runDir, 'ipc.sock');
  if (Buffer.byteLength(inRun) <= SUN_PATH_MAX) return { path: inRun, elsewhere: false };

  /* pid plus a per-process counter: unique against every other run on the
   * machine, and unique against the other files in this one. */
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const name = `okt-${process.pid}-${socketSerial++}.sock`;
  return { path: path.join(base, name), elsewhere: true };
}

/** How the device host stopped, and what that means for the run. */
const FATAL = {
  FIRMWARE_CRASH: 'firmware-crash',   // exit 2
  HOST_KILLED: 'host-killed',         // exit 5 - external or OOM kill
  HOST_DIED: 'host-died',             // exit 5 - exited for its own reasons
  MAP_FAILED: 'map-failed',           // exit 5 - retries exhausted
};

/**
 * What a dead device host means. A pure function, so it can be checked against
 * every case in the sanity section instead of only against the ones a run
 * happens to produce - and the rare ones are exactly the ones that matter.
 *
 * EXPLAINER is blunt about why this has to be exact: an expected restart and an
 * OOM kill are byte-identical as signals (code:null, SIGKILL), and only the
 * marker file the child wrote before killing itself tells them apart.
 *
 * @param {object} exit
 *   code        exit code, or null when signalled
 *   signal      'SIGSEGV' | 'SIGKILL' | null
 *   stderr      everything the child said
 *   expected    a restart marker for this generation exists
 *   ready       this generation printed its boot banner before dying
 *   mapRetries  how many retries have already been spent
 *   generation
 * @returns {{kind:'restart'|'retry'|'fatal', fatal?:string, reason?:string}}
 */
function classifyExit({
  code, signal, stderr = '', expected, ready, mapRetries = 0, generation = 0,
}) {
  /* The marker first: it is the only thing that separates a reboot from a kill. */
  if (expected) return { kind: 'restart' };

  /*
   * The addon installs a segfault handler that writes "[okemu] FATAL: segfault
   * at" plus a backtrace before the process dies, so either the signal or that
   * line is enough to call it.
   */
  if (signal === 'SIGSEGV' || /\[okemu\] FATAL: segfault at/.test(stderr)) {
    /*
     * A segfault BEFORE the boot banner is a failed START, not a firmware bug,
     * and it is retried like the mapping failure it almost certainly is.
     *
     * The clean mapping failure below already gets that treatment, on
     * EXPLAINER's argument that a run legitimately produces hundreds of
     * restarts so even a small per-boot failure rate becomes a run-killer. The
     * collision does not always report itself cleanly: it can arrive as a
     * SIGSEGV instead, which took the fatal path and aborted whole runs -
     * measured twice in about eight full runs on 2026-08-05, once at generation
     * 0 with no device output at all and once at generation 1 on an ordinary
     * restart, both files passing immediately afterwards.
     *
     * `ready` is the honest boundary. It is false until this generation printed
     * its boot banner, so a crash while it is false happened during startup and
     * cannot have corrupted anything a later test depends on. After the banner,
     * a segfault is exactly what it looks like and stays fatal - and that
     * distinction is what makes retrying safe here and unsafe there.
     */
    if (!ready && mapRetries < MAX_MAP_RETRIES) {
      return { kind: 'retry', reason: 'segfault during boot' };
    }
    return {
      kind: 'fatal',
      fatal: FATAL.FIRMWARE_CRASH,
      reason: ready
        ? `the firmware segfaulted (generation ${generation})`
        : `the firmware segfaulted during boot ${MAX_MAP_RETRIES} times ` +
          `(generation ${generation}) - no longer a flaky start`,
    };
  }

  if (code === EXIT_MAPFAIL) {
    /*
     * Not a device crash - the emulated flash could not be mapped, usually
     * because something else took the address first. Retried, and counted so it
     * stops being invisible if the rate ever changes. In practice this should
     * be rare: the collision that used to crash-loop the daemon was the 32 MiB
     * bit-band alias fighting V8's ASLR'd heap, and that region is already
     * optional and skipped when its address is taken.
     */
    if (mapRetries < MAX_MAP_RETRIES) {
      return { kind: 'retry', reason: 'the emulated flash could not be mapped' };
    }
    return {
      kind: 'fatal',
      fatal: FATAL.MAP_FAILED,
      reason: `the emulated flash could not be mapped after ${MAX_MAP_RETRIES} retries`,
    };
  }

  if (signal === 'SIGKILL') {
    return {
      kind: 'fatal',
      fatal: FATAL.HOST_KILLED,
      reason: 'the device host was SIGKILLed with no restart marker - an external ' +
        'or OOM kill, not a reboot',
    };
  }

  return {
    kind: 'fatal',
    fatal: FATAL.HOST_DIED,
    reason: `the device host exited (code ${code}, signal ${signal}) without a restart marker`,
  };
}

class EmulatedTransport extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.runDir     this run's directory
   * @param {string} opts.storageDir where flash.bin / eeprom.bin live
   * @param {number} [opts.bootTimeoutMs]
   */
  constructor(opts) {
    super();
    this.runDir = opts.runDir;
    this.storageDir = opts.storageDir;
    /* Put the device on the USB bus as well as the in-process one. Only
     * sections that need a kernel device node ask for this - see lib/gadget.js
     * for why it cannot simply always be on. */
    this.gadget = !!opts.gadget;
    const socket = chooseSocketPath(this.runDir);
    this.socketPath = socket.path;
    this.socketElsewhere = socket.elsewhere;
    this.markerDir = path.join(this.runDir, 'markers');
    this.bootTimeoutMs = opts.bootTimeoutMs || 20000;

    this.generation = 0;
    this.mapRetries = 0;
    this.restarts = 0;
    this.fatal = null;          // {kind, reason, detail}

    this.child = null;
    this.host = null;
    this.ready = false;         // this generation has printed its boot banner
    this.stderr = '';           // last STDERR_KEEP bytes, for the failure block

    this._stopping = false;
    this._genLog = '';          // this generation's output, for the banner probe
    this._bootWaiters = new Set();
  }

  /* ---- lifecycle -------------------------------------------------------- */

  async start() {
    fs.mkdirSync(this.markerDir, { recursive: true });
    fs.mkdirSync(this.storageDir, { recursive: true });

    /*
     * Check the bus is free BEFORE spawning anything.
     *
     * There is one USB gadget on a machine and whoever holds /dev/hidg* open
     * owns it. Racing the developer's daemon for it would not fail cleanly -
     * both processes would half-work, and the tests would provision PINs inside
     * whichever device answered. Refusing here, by name, is the only honest
     * option.
     */
    if (this.gadget) {
      const bus = require('../gadget').inspect();
      if (!bus.usable && process.env.OKT_USE_RUNNING_GADGET !== 'yes') {
        throw new Error(`cannot raise the USB gadget: ${bus.why}`);
      }
    }

    const IpcHost = require(path.join(emulatorRoot().dir, 'lib', 'ipc-host'));
    this.host = new IpcHost({ socketPath: this.socketPath });

    /*
     * Must be attached before anything else: _onFrame re-emits a device-sent
     * {t:'error'} frame as an 'error' event, and an unhandled 'error' on an
     * EventEmitter is a thrown exception, not a log line.
     */
    this.host.on('error', (payload) => {
      if (payload instanceof Error) this.emit('transport-error', payload);
      else this.emit('device-error', String(payload && payload.message));
    });

    this.host.on('message', (msg) => this._onFrame(msg));
    this.host.listen();

    this._spawn();
    await this.waitForBoot();
    return this;
  }

  _spawn() {
    this.ready = false;
    this._genLog = '';

    const argv = [
      DEVICE_HOST,
      '--socket', this.socketPath,
      '--storage', this.storageDir,
      '--markers', this.markerDir,
      '--generation', String(this.generation),
    ];
    if (this.gadget) argv.push('--gadget');

    this.child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    const keep = (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP);
    };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);

    const child = this.child;
    /*
     * 'close', not 'exit'.
     *
     * 'exit' fires as soon as the process is gone, while its stdio pipes may
     * still have data in flight - and the one thing worth having at that
     * moment is precisely what was in flight: the addon's segfault handler
     * writes "[okemu] FATAL: segfault at" plus a backtrace to stderr as it
     * dies. Classifying on 'exit' reported the crash with an empty detail
     * block, measured, every time. 'close' carries the same code and signal
     * and waits for the pipes to end first.
     */
    child.on('close', (code, signal) => this._onChildExit(child, code, signal));
    child.on('error', (err) => this._declareFatal(FATAL.HOST_DIED,
      `could not spawn the device host: ${err.message}`));

    this.emit('spawn', { generation: this.generation, pid: child.pid });
  }

  /*
   * Classification happens HERE, on the exit event - never on the restart
   * message. Two reasons. An expected restart and an OOM kill are
   * byte-identical as signals (code:null, SIGKILL), so only the marker file the
   * child wrote before killing itself tells them apart. And respawning on the
   * message would race two children against the same eeprom.bin, since the old
   * child writes the whole EEPROM during shutdown.
   */
  _onChildExit(child, code, signal) {
    if (child !== this.child) return;      // a stale child we already replaced
    this.child = null;
    if (this._stopping || this.fatal) return;

    const marker = path.join(this.markerDir, `restart-${this.generation}`);

    const verdict = classifyExit({
      code,
      signal,
      stderr: this.stderr,
      expected: fs.existsSync(marker),
      ready: this.ready,
      mapRetries: this.mapRetries,
      generation: this.generation,
    });

    if (verdict.kind === 'restart') {
      this.restarts++;
      this.generation++;
      this.emit('restart', { generation: this.generation, restarts: this.restarts });
      this._spawn();
      return;
    }

    if (verdict.kind === 'retry') {
      this.mapRetries++;
      this.emit('map-retry', {
        attempt: this.mapRetries,
        generation: this.generation,
        reason: verdict.reason,
      });
      this._spawn();
      return;
    }

    this._declareFatal(verdict.fatal, verdict.reason);
  }

  _declareFatal(kind, reason) {
    if (this.fatal) return;
    this.fatal = { kind, reason, detail: this.stderr.slice(-2000), generation: this.generation };
    this.emit('fatal', this.fatal);
    for (const waiter of [...this._bootWaiters]) waiter.reject(new Error(reason));
    this._bootWaiters.clear();
  }

  async stop() {
    this._stopping = true;
    const child = this.child;
    this.child = null;

    if (child) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 3000);
        child.once('exit', done);
        try { child.kill('SIGTERM'); } catch { done(); }
      });
    }

    if (this.host) {
      try { this.host.close(); } catch { /* ignore */ }
      this.host = null;
    }
  }

  /* ---- frames ----------------------------------------------------------- */

  _onFrame(msg) {
    switch (msg.t) {
      case 'log': {
        this._genLog = (this._genLog + msg.text).slice(-65536);
        this.emit('log', msg.text);
        if (!this.ready && BOOT_BANNER.test(this._genLog)) {
          this.ready = true;
          for (const waiter of [...this._bootWaiters]) waiter.resolve(this.generation);
          this._bootWaiters.clear();
          this.emit('boot', { generation: this.generation });
        }
        break;
      }
      case 'hid':
        /*
         * Both directions arrive here, and outbound SEREMU and keyboard traffic
         * is deliberately absent - the peer suppresses it because it already
         * leaves as `log` and `keyboard` and would otherwise be doubled.
         * Reading `hid` alone therefore loses the entire debug console, which
         * is why the log has its own path above.
         */
        if (msg.dir === 'out') {
          this.emit('hid', msg.iface, Buffer.from(msg.data, 'base64'));
        }
        break;
      case 'keyboard':
        this.emit('keyboard', Buffer.from(msg.data, 'base64'));
        break;
      case 'led':
        this.emit('led', msg.pixels);
        break;
      case 'ready':
        this.emit('attached', msg);
        break;
      default:
        break;
    }
  }

  /* ---- commands --------------------------------------------------------- */

  /** Host -> device. Argument order is emu.writeHid's, not IpcHost's. */
  writeHid(buffer, iface) {
    if (!this.host || !this.host.connected) {
      throw new Error('device host is not attached');
    }
    this.host.writeHid(iface, Buffer.from(buffer));
  }

  /** Bus-only detach. IpcHost has no sender for this, so it goes out raw. */
  setPlugged(plugged) {
    if (!this.host) throw new Error('no IPC host');
    this.host._send({ t: 'setPlugged', plugged: !!plugged });
  }

  /**
   * Resolve when the current generation has printed its boot banner.
   * @param {object} [opts] {timeoutMs, signal, pending}
   */
  waitForBoot(opts = {}) {
    if (this.fatal) return Promise.reject(new Error(this.fatal.reason));
    if (this.ready) return Promise.resolve(this.generation);

    return tracked(
      `device generation ${this.generation} to finish booting`,
      { timeoutMs: this.bootTimeoutMs, ...opts },
      (resolve, reject) => {
        const waiter = { resolve, reject };
        this._bootWaiters.add(waiter);
        return () => this._bootWaiters.delete(waiter);
      }
    );
  }

  get kind() { return 'emulated'; }
  get attached() { return !!(this.host && this.host.connected); }

  /*
   * This generation's output only, bounded.
   *
   * Distinct from the test-visible accumulator, which spans reboots on purpose.
   * A boot banner is only evidence about the boot it came from, and an
   * uninitialized device's "UNLOCKED, NO PIN SET" is printed once, at boot -
   * so asking "did THIS generation print it" needs a buffer that resets.
   */
  get genLog() { return this._genLog; }
}

module.exports = { EmulatedTransport, FATAL, BOOT_BANNER, classifyExit, MAX_MAP_RETRIES };
