/*
 * hardware.js - the declared seam. Designed for, not yet written.
 *
 * This exists now, empty, because the shape of the emulated path was decided
 * with it in mind and that decision is only enforceable if the seam is visible.
 * What it will have to do, in the order it will matter:
 *
 *   Report ID. node-hid's write() takes a report ID as its first byte and the
 *   proven client always prepends a zero. Payloads from lib/device/okmsg.js
 *   carry no report ID, so this adapter adds it - see the note at the top of
 *   lib/device/index.js for why that asymmetry lives in the adapters.
 *
 *   Padding. A hidraw reader must read the descriptor's declared count, so
 *   every inbound report arrives as a full 64 bytes with the tail zeroed. The
 *   emulated path replicates none of that, so this adapter strips the padding
 *   on the way in and both normalise to the same line stream.
 *
 *   NUL filtering on the debug channel, which the old kit did unconditionally
 *   (onlykey-alpha-testing/lib/hid.js). It belongs HERE and nowhere else: on
 *   the emulated path it would destroy legitimate NUL bytes.
 *
 *   Restart as disappearance. device.restart() resolves when the device comes
 *   back; here that means the SEREMU interface leaving the USB bus and
 *   re-enumerating, polled through hid.devices(), rather than a child process
 *   exiting. The old kit's config_mode.js already fails with "device never left
 *   the USB bus after 3 restart presses" when it does not, which is the check
 *   to carry over.
 *
 *   State fixtures by check-and-apply, never by image push. A physical key
 *   cannot have flash.bin written into it, so lib/fixtures/states/*.js run
 *   their real setup flow when check() fails. That is why those modules export
 *   two functions instead of one.
 *
 * None of this can run in a GitHub workflow: there is no /dev/hidraw on a
 * hosted runner, so node-hid has nothing to open. This adapter belongs to a
 * self-hosted runner or a developer's workstation.
 */
'use strict';

class HardwareTransport {
  constructor() {
    throw new Error(
      'the hardware adapter is not implemented yet - this is a declared seam ' +
      '(see lib/device/hardware.js). Run against the emulator, or write it.'
    );
  }
}

module.exports = { HardwareTransport };
