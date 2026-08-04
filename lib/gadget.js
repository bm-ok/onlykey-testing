/*
 * gadget.js - is there a kernel HID device, and whose is it?
 *
 * Section 1 needs no kernel device node; that is what lets it run in CI. Every
 * later section needs one, because python-onlykey, lib-agent and the browser
 * all find the key through hidapi. On a workstation that node can come from two
 * places - a physical key, or the emulator's USB gadget - and the difference
 * between them is invisible to any client, by design.
 *
 * The part that matters, and the reason this file is not a one-line existence
 * check: the gadget is a SINGLETON. Section 1 gives every test file its own
 * device host, its own storage and its own snapshot, because the in-process bus
 * is per-process. There is exactly one USB gadget on the machine, and whoever
 * holds /dev/hidg* open owns it - normally the developer's pm2-supervised
 * daemon, with their own device state in it.
 *
 * So a CLI run against a gadget somebody else owns is not an isolated test run.
 * It provisions PINs, writes slots and wipes things inside a device the
 * developer is using. This file exists so the kit can tell that situation apart
 * and refuse it, rather than discovering it by having trashed something.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIGFS = '/sys/kernel/config/usb_gadget';
const SYSFS_HIDRAW = '/sys/class/hidraw';
const ONLYKEY_VID = 0x1D50;
const ONLYKEY_PID = 0x60FC;

/** Every /dev/hidgN the gadget presents, device side. */
function hidgNodes() {
  try {
    return fs.readdirSync('/dev')
      .filter((n) => /^hidg\d+$/.test(n))
      .sort()
      .map((n) => `/dev/${n}`);
  } catch {
    return [];
  }
}

/**
 * Which process holds those nodes open.
 *
 * Read out of /proc rather than shelled out to fuser or lsof: no dependency, no
 * sudo, and it works for our own user's processes - which is the case that
 * matters, since the daemon this is looking for is the developer's own.
 * @returns {{pid:number, command:string, nodes:string[]}|null}
 */
function findOwner(nodes = hidgNodes()) {
  if (!nodes.length) return null;
  const wanted = new Set(nodes);

  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }

  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }

    const held = [];
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (wanted.has(target)) held.push(target);
      } catch { /* the fd closed under us */ }
    }

    if (held.length) {
      let command = '';
      try {
        command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch { /* gone already */ }
      return { pid: Number(pid), command, nodes: held };
    }
  }

  return null;
}

/** The OnlyKey hidraw nodes on the host side, split by what is behind them. */
function hidrawNodes() {
  const out = { gadget: [], physical: [] };
  let nodes;
  try { nodes = fs.readdirSync(SYSFS_HIDRAW); } catch { return out; }

  for (const node of nodes) {
    let sysfs;
    let uevent;
    try {
      sysfs = fs.realpathSync(path.join(SYSFS_HIDRAW, node, 'device'));
      uevent = fs.readFileSync(path.join(SYSFS_HIDRAW, node, 'device', 'uevent'), 'utf8');
    } catch { continue; }

    const want = `:${ONLYKEY_VID.toString(16).toUpperCase().padStart(8, '0')}:` +
      `${ONLYKEY_PID.toString(16).toUpperCase().padStart(8, '0')}`;
    if (!uevent.toUpperCase().includes(want)) continue;

    /* dummy_hcd is the emulator's virtual bus; anything else is real silicon. */
    (/dummy_hcd/.test(sysfs) ? out.gadget : out.physical).push(`/dev/${node}`);
  }
  return out;
}

/**
 * The whole picture, in one call.
 *
 * @returns {{configured:boolean, bound:boolean, udc:string|null,
 *            hidg:string[], hidraw:{gadget:string[],physical:string[]},
 *            owner:object|null, ownedByUs:boolean, usable:boolean, why:string}}
 */
function inspect() {
  let configured = false;
  let udc = null;
  try {
    const gadgets = fs.readdirSync(CONFIGFS);
    if (gadgets.length) {
      configured = true;
      udc = fs.readFileSync(path.join(CONFIGFS, gadgets[0], 'UDC'), 'utf8').trim() || null;
    }
  } catch { /* configfs absent, or no gadget set up */ }

  const hidg = hidgNodes();
  const hidraw = hidrawNodes();
  const owner = findOwner(hidg);
  const ownedByUs = !!(owner && owner.pid === process.pid);

  let usable = false;
  let why = '';

  if (!configured) {
    why = `no USB gadget configured (${CONFIGFS} is empty) - ` +
      'run  sudo ./scripts/gadget-setup.sh  once in the emulator checkout';
  } else if (!udc) {
    why = 'the gadget exists but is not bound to a UDC - it is unplugged';
  } else if (!hidg.length) {
    why = 'the gadget is bound but presents no /dev/hidg* endpoints';
  } else if (owner && !ownedByUs) {
    why = `the gadget is already owned by pid ${owner.pid} (${shortCommand(owner.command)}). ` +
      'That process has its own device state, and driving it would provision PINs and ' +
      'write slots inside somebody else\'s device. Stop it first, or set ' +
      'OKT_USE_RUNNING_GADGET=yes to use it deliberately.';
  } else {
    usable = true;
  }

  return { configured, bound: !!udc, udc, hidg, hidraw, owner, ownedByUs, usable, why };
}

function shortCommand(command) {
  if (!command) return 'unknown';
  const parts = command.split(/\s+/);
  return parts.map((p) => (p.startsWith('/') ? path.basename(p) : p)).join(' ').slice(0, 60);
}

module.exports = { inspect, findOwner, hidgNodes, hidrawNodes, CONFIGFS };
