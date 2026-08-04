// Minimal mocha-like test harness for in-app tests.
// Usage:
// const h = require('./harness');
// h.describe('suite', () => { h.it('does something', async ({ExpoWorker, DeviceEventEmitter, log, assert}) => { ... }) });
// module.exports = { run: (ctx) => h.run(ctx) }

const suites = [];
let currentSuite = null;

function describe(name, fn) {
    const suite = { name, tests: [] };
    suites.push(suite);
    currentSuite = suite;
    try {
        fn();
    } finally {
        currentSuite = null;
    }
}

function it(name, fn) {
    if (!currentSuite) throw new Error('it() must be called inside describe()');
    currentSuite.tests.push({ name, fn });
}

function ok(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

function equal(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`);
}

function notEqual(a, b, msg) {
    if (a === b) throw new Error(msg || `Expected ${a} !== ${b}`);
}

async function run(context = {}) {
    const results = { suites: [], passed: 0, failed: 0 };
    const {
        timeoutMs = 0,
        testFilter,
        onTestStart,
        onTestEnd,
    } = context;

    const log = (context.log && typeof context.log === 'function')
        ? context.log
        : ((...args) => { try { console.log('[harness]', ...args); } catch (_) { } });

    for (const suite of suites) {
        const suiteRes = { name: suite.name, tests: [] };
        log(`suite: ${suite.name}`);
        for (const t of suite.tests) {
            if (typeof testFilter === 'function' && !testFilter(t.name, suite.name)) {
                continue;
            }

            const testRes = { name: t.name, ok: false, error: null };

            try { if (onTestStart) onTestStart({ suiteName: suite.name, testName: t.name }); } catch (_) { }
            try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'running' }); } catch (_e) { }

            try {
                const testPromise = (async () => {
                    await t.fn({ ...context, assert: { ok, equal, notEqual } });
                })();

                if (timeoutMs > 0) {
                    const timeoutPromise = new Promise((_, rej) => {
                        const id = setTimeout(() => {
                            rej(new Error(`Test timeout after ${timeoutMs}ms`));
                        }, timeoutMs);
                        testPromise.then(() => clearTimeout(id), () => clearTimeout(id));
                    });
                    await Promise.race([testPromise, timeoutPromise]);
                } else {
                    await testPromise;
                }

                try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'passed' }); } catch (_e) { }
                testRes.ok = true;
                results.passed++;
                log(`  ✓ ${t.name}`);
            } catch (e) {
                testRes.ok = false;
                testRes.error = e && (e.stack || e.message || String(e));
                try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'failed', error: testRes.error }); } catch (_e) { }
                results.failed++;
                log(`  ✗ ${t.name} -> ${testRes.error}`);
            }

            try { if (onTestEnd) onTestEnd({ suiteName: suite.name, testName: t.name, result: testRes }); } catch (_e) { }

            suiteRes.tests.push(testRes);
        }
        results.suites.push(suiteRes);
    }

    return results;
}

function getRegisteredSuites() {
    return suites.map(s => ({ name: s.name, tests: s.tests.map(t => ({ name: t.name })) }));
}

module.exports = { describe, it, run, assert: { ok, equal, notEqual }, getRegisteredSuites };
