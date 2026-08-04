/*
 * keyboard.js - HID keyboard reports back into the text the device typed.
 *
 * The emulator surfaces the keyboard interface as an EVENT rather than as a
 * device node to be read with elevated privileges, and that is what makes a
 * whole class of tests possible at all: everything OnlyKey does by typing -
 * passwords, backups, TOTP - is observable here with no root and no /dev/hidraw.
 *
 * The report is the stock 8-byte boot-protocol layout that
 * core-override/okemu_usb.cpp fills:
 *
 *   [0] modifier bitmap   [1] reserved(0)   [2..7] up to six keycodes
 *
 * A key is "pressed" in one report and released by the next report that omits
 * it, so a naive decoder that reads every report emits every character twice.
 * Decoding is therefore edge-triggered: only keycodes not present in the
 * previous report count.
 */
'use strict';

const MOD = {
  LEFT_CTRL: 0x01, LEFT_SHIFT: 0x02, LEFT_ALT: 0x04, LEFT_GUI: 0x08,
  RIGHT_CTRL: 0x10, RIGHT_SHIFT: 0x20, RIGHT_ALT: 0x40, RIGHT_GUI: 0x80,
};

const SHIFT = MOD.LEFT_SHIFT | MOD.RIGHT_SHIFT;

/* US layout, HID usage codes 0x04..0x38 plus the keys OnlyKey actually uses. */
const UNSHIFTED = {
  0x28: '\n', 0x29: '\x1b', 0x2A: '\b', 0x2B: '\t', 0x2C: ' ',
  0x2D: '-', 0x2E: '=', 0x2F: '[', 0x30: ']', 0x31: '\\', 0x32: '#',
  0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/',
};
const SHIFTED = {
  0x2D: '_', 0x2E: '+', 0x2F: '{', 0x30: '}', 0x31: '|', 0x32: '~',
  0x33: ':', 0x34: '"', 0x35: '~', 0x36: '<', 0x37: '>', 0x38: '?',
};
const DIGITS = ')!@#$%^&*(';

/** One keycode + modifier byte to the character it produces, or ''. */
function charFor(code, modifiers) {
  const shifted = (modifiers & SHIFT) !== 0;

  if (code >= 0x04 && code <= 0x1D) {              // a-z
    const letter = String.fromCharCode(0x61 + (code - 0x04));
    return shifted ? letter.toUpperCase() : letter;
  }
  if (code >= 0x1E && code <= 0x27) {              // 1-9, 0
    const index = code === 0x27 ? 0 : code - 0x1D;
    return shifted ? DIGITS[index] : String(index);
  }
  if (shifted && SHIFTED[code] !== undefined) return SHIFTED[code];
  if (UNSHIFTED[code] !== undefined) return UNSHIFTED[code];
  return '';                                        // F-keys, arrows, media
}

/**
 * Stateful decoder: feed it every keyboard report in order, read `.text`.
 *
 * Kept stateful rather than exposed as a pure function over an array, because
 * the edge-triggering needs the previous report and a test that clears mid-way
 * (before pressing the button that types the next thing) must not lose it.
 */
class KeystrokeDecoder {
  constructor() {
    this.text = '';
    this.reports = 0;
    this._down = new Set();
  }

  /** @param {Buffer} report 8 bytes */
  feed(report) {
    if (!report || report.length < 3) return '';
    this.reports++;
    const modifiers = report[0];
    const now = new Set();
    let produced = '';

    for (let i = 2; i < Math.min(report.length, 8); i++) {
      const code = report[i];
      if (!code) continue;
      now.add(code);
      if (!this._down.has(code)) produced += charFor(code, modifiers);
    }

    this._down = now;
    this.text += produced;
    return produced;
  }

  clear() {
    this.text = '';
    /* Not _down: a key held across the clear has not been re-pressed, and
     * forgetting that would duplicate it into the fresh text. */
  }
}

module.exports = { KeystrokeDecoder, charFor, MOD };
