#!/usr/bin/env node
/*
 * okt - the command line for the OnlyKey test kit.
 *
 *   okt run [target...]     run a section, a directory or a single file
 *   okt list [target...]    enumerate what would run, without a device
 *   okt caps                what this host can reach, and why not
 *   okt fixture <state>
  okt flash [hexfile]  [--no-reboot] [--delay <ms>]     build (or rebuild) a cached device state
 *   okt flash [hex]         program a key sitting in its HalfKay bootloader
 *
 * With no target, every section runs in order. Sections are numbered so that
 * order is visible in the tree rather than encoded somewhere else.
 *
 * The exit code is the verdict and needs nothing else read to interpret:
 *
 *   0  finished, everything passed
 *   1  finished, at least one test failed - the only code that means the device
 *      behaved and the software did not
 *   2  the firmware crashed
 *   3  a watchdog fired (per-test deadline, inactivity, or run maximum)
 *   4  harness or runner error - the kit failed before it could judge anything
 *   5  the device host died for a reason that is not the firmware's fault
 *
 * 0-3 are verdicts about the device. 4 and 5 say the run did not produce a
 * verdict at all, and that distinction is the whole point.
 */
'use strict';

const { EXIT } = require('../lib/report');

function usage() {
  console.log(`usage:
  okt run [target...]  [--hardware] [--test <substring>] [--isolate] [--timeout <ms>] [--quiet]
  okt list [target...]
  okt caps
  okt fixture <state>
  okt flash [hexfile]  [--no-reboot] [--delay <ms>]

targets are section names (01-protocol), directories, or single files.

--test runs the tests whose "<suite> <test>" contains the substring, which is
how a single endpoint is debugged on its own. --isolate runs each selected test
in ITS OWN device session and reports any that cannot stand alone; it is for
checking that --test still works after adding tests, not for ordinary runs.

--hardware drives a physical key over /dev/hidraw instead of the emulator. The
emulator's USB gadget is excluded by default because it is indistinguishable
from a key by VID/PID; OKT_ALLOW_GADGET=yes targets it deliberately, and
OKT_USB_PATH picks one when several are attached.

exit codes: 0 pass  1 test failure  2 firmware crash  3 watchdog
            4 runner error  5 device host died`);
}

function parse(argv) {
  const out = {
    command: argv[2] || 'help', targets: [], filter: null,
    timeoutMs: null, quiet: false, adapter: 'emulated',
    reboot: true, delayMs: null, isolate: false,
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test') out.filter = argv[++i];
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--isolate') out.isolate = true;
    else if (a === '--hardware') out.adapter = 'hardware';
    else if (a === '--no-reboot') out.reboot = false;
    else if (a === '--delay') out.delayMs = parseInt(argv[++i], 10);
    else if (a === '--emulated') out.adapter = 'emulated';
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); process.exit(EXIT.RUNNER_ERROR); }
    else out.targets.push(a);
  }
  return out;
}

/**
 * Run every selected test ALONE, in its own device session.
 *
 * `--test` already runs one test on its own, which is the debugging workflow
 * this exists to protect. What it cannot do is tell you whether that workflow
 * still WORKS: a test that quietly depends on an earlier one in its file passes
 * in a normal run and fails only when somebody isolates it, which is exactly
 * the moment they are already debugging something else. The dependency is
 * usually an unlock, and it surfaces as a timeout waiting for a device that was
 * never unlocked - a failure that names nothing.
 *
 * So this runs the file once per test, each with a fresh fixture and a fresh
 * boot, and reports which ones cannot stand alone. It is not for ordinary runs:
 * N boots costs roughly N x 2s and every test pays for its own setup. Use it
 * after adding tests, and when a file's isolation is in doubt.
 *
 * Each pass gets its own run directory, so the failing one's log is already on
 * disk under its own name rather than interleaved with the rest.
 */
async function runIsolated(args) {
  const { run, list } = require('../lib/runner');
  const { EXIT: CODES } = require('../lib/report');

  const wanted = [];
  for (const entry of list(args.targets)) {
    if (!entry.ok) {
      console.error(`${entry.file}  !! ${entry.error}`);
      return CODES.RUNNER_ERROR;
    }
    for (const suite of entry.suites) {
      for (const t of suite.tests) {
        if (args.filter && !`${suite.name} ${t.name}`.includes(args.filter)) continue;
        wanted.push({ file: entry.file, suite: suite.name, test: t.name });
      }
    }
  }

  if (!wanted.length) {
    console.error('--isolate matched no tests');
    return CODES.RUNNER_ERROR;
  }

  console.log(`--isolate: ${wanted.length} test(s), one device session each\n`);

  const failed = [];
  let worst = 0;
  for (const [i, w] of wanted.entries()) {
    process.stdout.write(`[${i + 1}/${wanted.length}] ${w.file}  ${w.test} ... `);

    const { code } = await run({
      targets: args.targets,
      adapter: args.adapter,
      quiet: true,                            // the per-run log file is the record
      timeoutMs: args.timeoutMs || undefined,
      testFilter: (testName, suiteName) => testName === w.test && suiteName === w.suite,
    });

    /*
     * A pass here means the test needed nothing that ran before it. Anything
     * else is reported with its own run directory, because that is where the
     * failure block and the device output already are.
     */
    console.log(code === 0 ? 'alone: ok' : `ALONE: FAILED (exit ${code})`);
    if (code !== 0) { failed.push(w); worst = Math.max(worst, code); }
  }

  console.log('');
  if (!failed.length) {
    console.log(`--isolate: all ${wanted.length} test(s) stand alone`);
    return 0;
  }

  console.log(`--isolate: ${failed.length} of ${wanted.length} cannot run alone:`);
  for (const w of failed) console.log(`  ${w.file}  ${w.test}`);
  console.log('\nEach of these depends on something an earlier test in its file did.');
  return worst;
}

async function main() {
  const args = parse(process.argv);

  switch (args.command) {
    case 'run': {
      const { run } = require('../lib/runner');
      if (args.isolate) { process.exit(await runIsolated(args)); }

      const { code } = await run({
        targets: args.targets,
        adapter: args.adapter,
        quiet: args.quiet,
        timeoutMs: args.timeoutMs || undefined,
        testFilter: args.filter
          ? (testName, suiteName) => `${suiteName} ${testName}`.includes(args.filter)
          : undefined,
      });
      process.exit(code);
      break;
    }

    case 'list': {
      const { list } = require('../lib/runner');
      const { detect } = require('../lib/capabilities');
      const caps = detect({ adapter: args.adapter });

      console.log(`mmap rung: ${caps.rung.name} (vm.mmap_min_addr=${caps.rung.minAddr})`);
      for (const cap of caps.list()) {
        console.log(`  ${cap.ok ? '[x]' : '[ ]'} ${cap.name}${cap.ok ? '' : ` - ${cap.why}`}`);
      }
      console.log('');

      let files = 0;
      let tests = 0;
      for (const entry of list(args.targets)) {
        if (!entry.ok) {
          console.log(`${entry.file}  !! ${entry.error}`);
          continue;
        }
        files++;
        for (const suite of entry.suites) {
          const meta = suite.meta || {};
          const bits = [];
          if (meta.state) bits.push(`state=${meta.state}`);
          if (meta.requires && meta.requires.length) bits.push(`requires=${meta.requires.join(',')}`);
          const missing = caps.missing(meta.requires || []);
          console.log(`${entry.file}  ${suite.name}${bits.length ? `  [${bits.join(' ')}]` : ''}` +
            `${missing ? `  -> SKIPPED: it ${missing}` : ''}`);
          for (const t of suite.tests) {
            tests++;
            console.log(`    - ${t.name}`);
          }
        }
      }
      console.log(`\n${files} file(s), ${tests} test(s)`);
      break;
    }

    case 'caps': {
      const { detect } = require('../lib/capabilities');
      const caps = detect({ adapter: args.adapter });
      console.log(`adapter: ${caps.adapter}`);
      console.log(`rung: ${caps.rung.name} (vm.mmap_min_addr=${caps.rung.minAddr})`);
      for (const cap of caps.list()) {
        console.log(`  ${cap.ok ? '[x]' : '[ ]'} ${cap.name}${cap.ok ? '' : `\n        ${cap.why}`}`);
      }
      break;
    }

    case 'fixture': {
      const state = args.targets[0];
      if (!state) { usage(); process.exit(EXIT.RUNNER_ERROR); }
      const fixtures = require('../lib/fixtures');
      const { detect } = require('../lib/capabilities');
      const result = await fixtures.ensure(state, {
        log: (m) => console.log(`  ${m}`),
        capabilities: detect({ adapter: 'emulated' }),
      });
      console.log(`${state}: ${result.built ? 'built' : 'cached'} at ${result.dir}`);
      break;
    }

    case 'flash': {
      const { flash, waitForKey } = require('../lib/flash');
      const { DEFAULT_HEX } = require('../lib/paths');
      const hex = args.targets[0] || DEFAULT_HEX;

      if (!args.targets[0]) console.log(`using the sibling builder's output: ${hex}`);
      const result = flash(hex, {
        reboot: args.reboot,
        delayMs: args.delayMs || undefined,
        log: (m) => console.log(`  ${m}`),
      });

      if (args.reboot) {
        console.log(waitForKey()
          ? '  key is back on the bus'
          : '  key did NOT come back on the bus - check it');
      }
      console.log(`flashed ${result.blocks} blocks via ${result.devPath}`);
      break;
    }

    case 'help':
    default:
      usage();
      process.exit(args.command === 'help' ? 0 : EXIT.RUNNER_ERROR);
  }
}

main().catch((err) => {
  /*
   * The message, not the stack. Most of what surfaces here is an instruction
   * to the operator - tap the bootloader button, plug the key in, point at a
   * hex that exists - and a ten-frame trace buries it. OKT_DEBUG=1 brings the
   * trace back for the times it is genuinely a bug in the kit.
   */
  console.error(`okt: ${err && err.message ? err.message : err}`);
  if (process.env.OKT_DEBUG && err && err.stack) console.error(err.stack);
  process.exit(EXIT.RUNNER_ERROR);
});
