#!/usr/bin/env node
/*
 * okt - the command line for the OnlyKey test kit.
 *
 *   okt run [target...]     run a section, a directory or a single file
 *   okt list [target...]    enumerate what would run, without a device
 *   okt caps                what this host can reach, and why not
 *   okt fixture <state>     build (or rebuild) a cached device state
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
  okt run [target...]  [--test <substring>] [--timeout <ms>] [--quiet]
  okt list [target...]
  okt caps
  okt fixture <state>

targets are section names (01-protocol), directories, or single files.

exit codes: 0 pass  1 test failure  2 firmware crash  3 watchdog
            4 runner error  5 device host died`);
}

function parse(argv) {
  const out = { command: argv[2] || 'help', targets: [], filter: null, timeoutMs: null, quiet: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test') out.filter = argv[++i];
    else if (a === '--timeout') out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); process.exit(EXIT.RUNNER_ERROR); }
    else out.targets.push(a);
  }
  return out;
}

async function main() {
  const args = parse(process.argv);

  switch (args.command) {
    case 'run': {
      const { run } = require('../lib/runner');
      const { code } = await run({
        targets: args.targets,
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
      const caps = detect({ adapter: 'emulated' });

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
      const caps = detect({ adapter: 'emulated' });
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

    case 'help':
    default:
      usage();
      process.exit(args.command === 'help' ? 0 : EXIT.RUNNER_ERROR);
  }
}

main().catch((err) => {
  console.error(`okt: ${err && (err.stack || err.message)}`);
  process.exit(EXIT.RUNNER_ERROR);
});
