/*
 * capabilities.js - what this host can actually reach.
 *
 * One host setting decides how much of the device is reachable, and it has to
 * be stated up front because it silently changes what a run even means. The
 * firmware reads its own storage through raw pointers, so the emulator maps
 * flash.bin at its real MK20DX256 addresses, and vm.mmap_min_addr decides how
 * low that mapping can start. Three rungs:
 *
 *   0x0000  everything, including fw_hash()'s walk from fwstartadr. Needs
 *           vm.mmap_min_addr=0 or CAP_SYS_RAWIO - nobody should run this.
 *   0x1000  the setting to use. certified_hw (enckeysectoradr+432 = 0x5BB0) is
 *           mapped, so crypto works, and page zero stays unmapped so a genuine
 *           NULL dereference still faults exactly as it should.
 *   0x10000 the unprivileged default. Storage at 0x3A800 is reachable and the
 *           device boots and enumerates - but okcrypto_split_sundae()
 *           dereferences certified_hw on every AES-GCM operation, so the device
 *           segfaults the moment it encrypts anything, storing a PIN included.
 *
 * That last rung is the dangerous one, because it looks like it is working
 * right up until the first test that stores a PIN. A run that lands there must
 * SAY so rather than reporting a pile of crashes, so the rung is read back and
 * treated as a capability, the same way as everything else the run cannot do.
 */
'use strict';

const fs = require('fs');

const gadget = require('./gadget');

const MMAP_MIN_ADDR = '/proc/sys/vm/mmap_min_addr';

/* The address okcrypto_split_sundae() dereferences on every AES-GCM op. */
const CERTIFIED_HW = 0x5BB0;

function readMmapMinAddr() {
  try {
    return parseInt(fs.readFileSync(MMAP_MIN_ADDR, 'utf8').trim(), 10);
  } catch {
    return null;   // not Linux, or /proc not mounted
  }
}

function rungOf(minAddr) {
  if (minAddr === null) return { name: 'unknown', minAddr };
  if (minAddr === 0) return { name: 'full', minAddr };
  if (minAddr <= CERTIFIED_HW) return { name: 'crypto', minAddr };
  return { name: 'hid-only', minAddr };
}

/*
 * A capability is a name, whether it is available, and - when it is not - one
 * sentence saying why, in terms of the thing that would have to change. That
 * sentence is what a skipped file reports, so it has to stand on its own in a
 * log read hours later by somebody who did not configure this machine.
 */
function detect({ adapter = 'emulated' } = {}) {
  const minAddr = readMmapMinAddr();
  const rung = rungOf(minAddr);
  const bus = gadget.inspect();
  const caps = new Map();

  const add = (name, ok, why) => caps.set(name, { name, ok, why: ok ? null : why });

  const emulated = adapter === 'emulated';

  add('device', true, null);

  /*
   * The emulated device's flash and EEPROM are ordinary files, which is what
   * makes state snapshottable at all. A physical key's are inside the key, so
   * anything that inspects or pushes an image belongs to the emulator.
   */
  add('storage-files', emulated,
    'a physical key keeps its flash inside the key - there is no file to read');

  add('image-snapshots', emulated,
    'device state cannot be pushed into a physical key as an image; hardware ' +
    'fixtures run their real setup flow instead');

  /*
   * The two-process arrangement and its restart markers are how the emulated
   * device reboots. A key reboots by leaving the USB bus.
   */
  add('device-host', emulated,
    'a physical key is not a child process, so there is no exit status or ' +
    'restart marker to classify - a reboot is a re-enumeration');

  add('crypto', rung.name === 'crypto' || rung.name === 'full' || !emulated,
    rung.name === 'unknown'
      ? `could not read ${MMAP_MIN_ADDR}, so the flash mapping's low bound is unknown`
      : `vm.mmap_min_addr is ${minAddr} (0x${(minAddr || 0).toString(16)}), so ` +
        `certified_hw at 0x${CERTIFIED_HW.toString(16)} is not mapped and any AES-GCM ` +
        `operation segfaults - run  sudo sysctl -w vm.mmap_min_addr=4096`);

  add('fw-hash', rung.name === 'full' || !emulated,
    `fw_hash() walks from fwstartadr, which needs the flash mapped at 0x0 ` +
    `(vm.mmap_min_addr=0 or CAP_SYS_RAWIO); this host is at ${minAddr}`);

  /*
   * Not a bug list entry. FSEC is not in flash.bin - it lives in an anonymous
   * peripheral mapping written fresh every boot, and what gets written depends
   * on whether the flash mapping landed at address zero. It does not, on any
   * host configured the way this project recommends, so FSEC latches to the
   * already-provisioned value, the one-time provisioning branch never runs, and
   * there is no factory key derivation, no firmware hash in EEPROM and no
   * security lock bits.
   */
  add('attestation', !emulated,
    'emulated mode never runs the firmware\'s one-time provisioning branch: FSEC ' +
    'latches to already-provisioned unless the flash maps at 0x0, and that ' +
    'configuration (vm.mmap_min_addr=0) is one nobody should run');

  /*
   * The emulator exposes the keyboard as an event rather than a device node to
   * be read with elevated privileges - which is what finally makes backup and
   * restore testable at all.
   */
  add('keyboard-capture', true, null);

  /*
   * usb-bus is about the ADAPTER: the in-process bus is not enumerable, full
   * stop. A gadget in front of the emulator does not change that - it is a
   * second, separate path to the same firmware.
   */
  add('usb-bus', !emulated,
    'emulated mode has no USB bus - the in-process HID bus is not enumerable');

  /*
   * kernel-hid is DETECTED, not assumed from the adapter name.
   *
   * The old rule was `!emulated`, which is wrong the moment the USB gadget is
   * up: /dev/hidraw is then the emulator, and python-onlykey can open it like
   * any other client. That assumption is what kept the CLI section looking
   * like it needed a physical key when it only ever needed a kernel node.
   *
   * The gadget is a singleton, though, so existing is not the same as being
   * ours - see lib/gadget.js. A run that provisions PINs inside the
   * developer's own daemon is not an isolated test run, it is vandalism with
   * a progress bar.
   */
  if (emulated) {
    const opted = process.env.OKT_USE_RUNNING_GADGET === 'yes';
    add('kernel-hid', bus.usable || (opted && bus.bound && bus.hidg.length > 0),
      bus.why || 'no kernel HID device is reachable from emulated mode');
  } else {
    add('kernel-hid', bus.hidraw.physical.length > 0,
      'no physical OnlyKey is enumerated - anything reaching the device through ' +
      'hidapi (python-onlykey, lib-agent, node-hid) needs one');
  }

  /*
   * The full wipe erases the firmware hash and drops a physical key into the
   * bootloader, which needs a reflash to recover from. On the emulator it is a
   * file being erased. The kit's own fixtures never need it - the userspace
   * wipe ('0C') returns a device to uninitialized, which is what 'blank' means
   * - so this stays off unless somebody asks for it out loud.
   */
  add('full-wipe', emulated || process.env.OKT_ALLOW_FULL_WIPE === 'yes',
    "'9C' erases the firmware hash and forces the bootloader on real " +
    'hardware; set OKT_ALLOW_FULL_WIPE=yes if you can reflash the key');

  return {
    adapter,
    rung,
    /* The bus picture, for a runner that wants to say WHY rather than just
     * that a section was skipped. */
    gadget: bus,
    /** @returns {boolean} */
    has: (name) => !!(caps.get(name) && caps.get(name).ok),
    /** @returns {string|null} why `name` is unavailable, or null if it is */
    why: (name) => {
      const c = caps.get(name);
      if (!c) return `unknown capability '${name}'`;
      return c.ok ? null : c.why;
    },
    /**
     * First unmet requirement, as a sentence, or null if all are met.
     * @param {string[]} required
     */
    missing: (required = []) => {
      for (const name of required) {
        const c = caps.get(name);
        if (!c) return `requires unknown capability '${name}'`;
        if (!c.ok) return `requires ${name}: ${c.why}`;
      }
      return null;
    },
    list: () => [...caps.values()],
  };
}

module.exports = { detect, rungOf, readMmapMinAddr, CERTIFIED_HW, MMAP_MIN_ADDR };
