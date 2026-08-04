/*
 * hardware.js - the same test files, against a physical key.
 *
 * This is the other side of the seam described in lib/device/index.js. Three
 * differences are hidden here so that no test has to know which device it is
 * driving:
 *
 *   Report ID. hidraw takes the report ID as the first byte of every write and
 *   the proven client always prepends a zero. Payloads carry no report ID, so
 *   this adapter adds it. The emulator's delivery path pads to 64 and does not
 *   strip a leading report ID, so sending one there would put a different first
 *   byte on the wire from identical test code.
 *
 *   Padding. A hidraw reader must read the descriptor's declared count, so
 *   every SEREMU report arrives as a full 64 bytes with the tail zeroed. The
 *   emulated path emits exactly what the firmware wrote. So the NULs are
 *   stripped HERE and nowhere else - doing it on the emulated path would
 *   destroy legitimate NUL bytes in a binary report.
 *
 *   Restart as disappearance. A reboot on hardware is the device leaving the
 *   USB bus and coming back, not a child process exiting. Both present to a
 *   test as "the generation advanced".
 *
 * Selecting the right device is not a formality here. The emulator's USB
 * gadget presents 1d50:60fc, manufacturer CRYPTOTRUST, product ONLYKEY, serial
 * 1000000000 - byte for byte what a physical key presents, because that is the
 * entire point of the gadget. Nothing in the HID descriptors can tell them
 * apart. So selection is by sysfs: the gadget hangs off dummy_hcd and a real
 * key does not. Without that check a "hardware" run can quietly drive the
 * emulator and report a pass for a device that was never tested.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const { tracked } = require('./waits');

const VENDOR_IDS = [0x1d50, 0x16c0];
const IFACE = { KEYBOARD: 0, FIDO: 1, VENDOR: 2, SEREMU: 3 };

/* How often to notice that the device left the bus or came back. */
const ENUMERATION_POLL_MS = 250;

/*
 * How many consecutive misses count as "gone".
 *
 * One does not. Enumeration is read from sysfs, and a single sample can miss a
 * device that is perfectly present - udev re-probing a freshly plugged key,
 * rules being applied, a node being recreated. Measured: a key plugged in
 * seconds before a run produced one missed poll, which was read as a reboot,
 * and 00-boot failed on `generation === 0` for a device that had never
 * restarted. A genuine re-enumeration keeps the device away for a second or
 * more, so three quarters of a second of absence is still prompt and no longer
 * jumps at a glitch.
 */
const MISSES_BEFORE_GONE = 3;

function loadHid() {
  try {
    return require('node-hid');
  } catch (err) {
    throw new Error(
      'the hardware adapter needs node-hid, which is an optional dependency: ' +
      `npm install node-hid  (${err.message})`
    );
  }
}

/**
 * Every OnlyKey interface currently enumerated, grouped by physical device.
 *
 * @returns {Array<{usbPath:string, gadget:boolean, interfaces:Object}>}
 */
function discover(hid) {
  const groups = new Map();

  for (const dev of hid.devices()) {
    if (!VENDOR_IDS.includes(dev.vendorId)) continue;
    if (!dev.path) continue;

    /*
     * /dev/hidrawN -> the USB interface it belongs to -> the USB device above
     * it. The resolved path is also what says whether this is the gadget: a
     * gadget interface resolves under /sys/devices/platform/dummy_hcd.N.
     */
    let sysfs;
    try {
      sysfs = fs.realpathSync(`/sys/class/hidraw/${path.basename(dev.path)}/device`);
    } catch {
      continue;                        // vanished between enumerating and now
    }

    /* .../usbX/X-Y/X-Y:1.Z/0003:VVVV:PPPP.NNNN -> .../usbX/X-Y */
    const usbPath = path.dirname(path.dirname(sysfs));
    const gadget = /dummy_hcd/.test(sysfs);

    if (!groups.has(usbPath)) groups.set(usbPath, { usbPath, gadget, interfaces: {} });
    groups.get(usbPath).interfaces[dev.interface] = dev.path;
  }

  return [...groups.values()];
}

/**
 * Pick the device to drive, or explain why it cannot.
 * @param {object} opts {allowGadget, usbPath}
 */
function select(hid, opts = {}) {
  const all = discover(hid);
  const candidates = all.filter((d) => {
    if (opts.usbPath) return d.usbPath.endsWith(opts.usbPath);
    return opts.allowGadget ? true : !d.gadget;
  });

  if (!candidates.length) {
    const seen = all.length
      ? all.map((d) => `${d.usbPath}${d.gadget ? ' (emulator gadget)' : ''}`).join(', ')
      : 'nothing';
    throw new Error(
      `no OnlyKey found on the USB bus. Enumerated: ${seen}. ` +
      (all.some((d) => d.gadget)
        ? 'The emulator\'s gadget is present but is excluded - set ' +
          'OKT_ALLOW_GADGET=yes to target it deliberately, which is a useful ' +
          'way to exercise this adapter without a physical key.'
        : 'Is the key plugged in, and do the udev rules grant access?')
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `${candidates.length} OnlyKeys are attached (${candidates.map((d) => d.usbPath).join(', ')}). ` +
      'Set OKT_USB_PATH to the one to drive - guessing would be worse than stopping.'
    );
  }

  const chosen = candidates[0];
  for (const iface of [IFACE.VENDOR, IFACE.SEREMU]) {
    if (!chosen.interfaces[iface]) {
      throw new Error(
        `the device at ${chosen.usbPath} is missing interface ${iface}. ` +
        (iface === IFACE.SEREMU
          ? 'Interface 3 is the DEBUG console, and it only exists in DEBUG ' +
            'firmware builds - this kit drives buttons, PINs and reboots ' +
            'through it, so a production build cannot be tested unattended.'
          : 'Interface 2 is the client protocol interface.')
      );
    }
  }

  return chosen;
}

class HardwareTransport extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.allowGadget] target the emulator's gadget on purpose
   * @param {string}  [opts.usbPath]     disambiguate when several are attached
   */
  constructor(opts = {}) {
    super();
    this.hid = loadHid();
    this.allowGadget = opts.allowGadget !== undefined
      ? opts.allowGadget
      : process.env.OKT_ALLOW_GADGET === 'yes';
    this.usbPath = opts.usbPath || process.env.OKT_USB_PATH || null;

    this.generation = 0;
    this.restarts = 0;
    this.mapRetries = 0;              // no mapping to fail; kept for one shape
    this.fatal = null;
    this.ready = false;
    this.stderr = '';                 // no child process; kept for one shape
    this.storageDir = null;           // flash lives on the key, not in a file

    this.device = null;               // the selected {usbPath, interfaces}
    this.handles = new Map();         // iface -> node-hid HID
    this._genLog = '';
    this._bootWaiters = new Set();
    this._poll = null;
    this._stopping = false;
    this._present = false;
    this._misses = 0;
  }

  get kind() { return 'hardware'; }
  get attached() { return this.handles.size > 0; }
  get genLog() { return this._genLog; }

  /* ---- lifecycle -------------------------------------------------------- */

  async start() {
    this.device = select(this.hid, { allowGadget: this.allowGadget, usbPath: this.usbPath });
    this.emit('selected', {
      usbPath: this.device.usbPath,
      gadget: this.device.gadget,
      interfaces: Object.keys(this.device.interfaces).map(Number).sort(),
    });

    this._open();
    this._present = true;
    this._startPolling();

    /*
     * There is no boot to wait for: the key has been running since it was
     * plugged in, and its banner was printed long before this process started.
     * Readiness on hardware means the interfaces are open - and the caller
     * then probes the debug console, which is the only thing that proves the
     * firmware is reading rather than merely enumerated.
     */
    this.ready = true;
    return this;
  }

  _open() {
    const { interfaces } = this.device;

    for (const iface of [IFACE.SEREMU, IFACE.VENDOR, IFACE.FIDO, IFACE.KEYBOARD]) {
      const devPath = interfaces[iface];
      if (!devPath) continue;

      let handle;
      try {
        handle = new this.hid.HID(devPath);
      } catch (err) {
        /*
         * The keyboard interface is the one most likely to be refused, since
         * reading it means reading every keystroke the device sends. Losing it
         * costs the keyboard-capture tests and nothing else, so it degrades
         * rather than aborting - but it says so.
         */
        if (iface === IFACE.KEYBOARD) {
          this.emit('interface-unavailable', { iface, path: devPath, reason: err.message });
          continue;
        }
        throw new Error(`could not open interface ${iface} at ${devPath}: ${err.message}`);
      }

      handle.on('data', (buf) => this._onReport(iface, buf));
      handle.on('error', (err) => this._onHandleError(iface, err));
      this.handles.set(iface, handle);
    }
  }

  _closeHandles() {
    for (const handle of this.handles.values()) {
      try { handle.close(); } catch { /* already gone */ }
    }
    this.handles.clear();
  }

  async stop() {
    this._stopping = true;
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._closeHandles();
  }

  /* ---- reports ---------------------------------------------------------- */

  _onReport(iface, buf) {
    if (iface === IFACE.SEREMU) {
      /*
       * Strip the NUL padding, and only here. hidraw hands back the
       * descriptor's full 64 bytes with the tail zeroed; the firmware wrote a
       * short line. Leaving them in puts NULs through every regex the test
       * suite matches against.
       */
      const text = buf.toString('latin1').replace(/\0+$/, '');
      if (!text) return;
      this._genLog = (this._genLog + text).slice(-65536);
      this.emit('log', text);
      return;
    }

    if (iface === IFACE.KEYBOARD) {
      this.emit('keyboard', Buffer.from(buf));
      return;
    }

    /* FIDO and vendor reports stay the descriptor's full 64 bytes: their
     * readers index by offset, and okmsg.text() trims the padding when a
     * report is being read as a string. */
    this.emit('hid', iface, Buffer.from(buf));
  }

  _onHandleError(iface, err) {
    if (this._stopping || this.fatal) return;
    /* A handle error is usually the device leaving the bus - which on hardware
     * is what a reboot looks like. The poll loop decides which it was. */
    this.emit('interface-error', { iface, reason: err && err.message });
    this._closeHandles();
  }

  /* ---- enumeration ------------------------------------------------------ */

  /*
   * A reboot is the device DISAPPEARING and coming back, so both edges have to
   * be seen. Polling rather than reacting to handle errors alone, because a
   * fast re-enumeration can complete before the read thread notices anything,
   * and because the old kit's failure - "device never left the USB bus after 3
   * restart presses" - is precisely the case where the disappearance never
   * happened and the run must not pretend otherwise.
   */
  _startPolling() {
    this._poll = setInterval(() => this._checkEnumeration(), ENUMERATION_POLL_MS);
    this._poll.unref();
  }

  _checkEnumeration() {
    if (this._stopping || this.fatal) return;

    let present = false;
    try {
      const found = discover(this.hid).find((d) => d.usbPath === this.device.usbPath);
      present = !!(found && found.interfaces[IFACE.SEREMU]);
      if (found) this.device.interfaces = found.interfaces;
    } catch {
      present = false;
    }

    /*
     * Handles dropped, but the device never left: reopen, and do NOT count it
     * as a reboot.
     *
     * A read error closes every handle, because a half-open device is worse
     * than a closed one. Nothing reopened them unless the device also vanished
     * from sysfs - and it does not have to. Measured: the firmware erasing a
     * flash sector during a PIN commit stalled USB long enough to error a read,
     * the handles closed, and the very next write failed with "interface 3 is
     * not open" against a device that was present the whole time.
     *
     * Distinguishing this from a reboot matters. Bumping the generation here
     * would invent a restart that never happened, and every test that counts
     * generations would quietly be measuring the wrong thing.
     */
    if (present && this._present && !this.handles.size) {
      try {
        this._open();
        this.ready = true;
        this.emit('interfaces-reopened', { generation: this.generation });
      } catch (err) {
        this.emit('interface-error', { iface: null, reason: err.message });
      }
      return;
    }

    if (this._present && !present) {
      /* Debounced: a miss is a suspicion, not a verdict. */
      this._misses++;
      if (this._misses < MISSES_BEFORE_GONE) return;

      this._present = false;
      this._misses = 0;
      this.ready = false;
      this._closeHandles();
      this.emit('bus-detach', { generation: this.generation });
      return;
    }

    if (present) this._misses = 0;

    if (!this._present && present) {
      this._present = true;
      this._genLog = '';
      try {
        this._open();
      } catch (err) {
        /* Enumerated but not openable yet - udev may not have applied its
         * rules to the new nodes. Try again on the next tick. */
        this._present = false;
        this.emit('interface-error', { iface: null, reason: err.message });
        return;
      }

      this.restarts++;
      this.generation++;
      this.ready = true;
      this.emit('restart', { generation: this.generation, restarts: this.restarts });
      this.emit('boot', { generation: this.generation });
      for (const waiter of [...this._bootWaiters]) waiter.resolve(this.generation);
      this._bootWaiters.clear();
    }
  }

  /* ---- commands --------------------------------------------------------- */

  /** Host -> device. The report ID goes on HERE; payloads never carry one. */
  writeHid(buffer, iface) {
    const handle = this.handles.get(iface);
    if (!handle) {
      throw new Error(`interface ${iface} is not open` +
        (this._present ? '' : ' - the device is off the bus'));
    }
    handle.write([0x00, ...Buffer.from(buffer)]);
  }

  /** No bus to detach from that this process controls. */
  setPlugged() {
    throw new Error(
      'a bus-only detach is not available on hardware - unplug it, or run the ' +
      'emulated adapter where the bus is software'
    );
  }

  waitForBoot(opts = {}) {
    if (this.fatal) return Promise.reject(new Error(this.fatal.reason));
    if (this.ready) return Promise.resolve(this.generation);

    return tracked(
      `the key to re-enumerate (generation ${this.generation + 1})`,
      { timeoutMs: 30000, ...opts },
      (resolve, reject) => {
        const waiter = { resolve, reject };
        this._bootWaiters.add(waiter);
        return () => this._bootWaiters.delete(waiter);
      }
    );
  }
}

module.exports = { HardwareTransport, discover, select, IFACE };
