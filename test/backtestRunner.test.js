'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const {
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
    shouldTriggerWatchdog,
} = require('../src/backtestRunner');

suite('backtestRunner — internal runner helpers', function () {
    test('resolves relative path settings against the workspace folder', function () {
        const workspace = path.resolve('workspace');
        const expected = path.join(workspace, 'logs', 'tester');

        assert.strictEqual(resolveBacktestPathSetting('logs/tester', workspace), expected);
    });

    test('expands home-directory path settings', function () {
        const resolved = resolveBacktestPathSetting('~/tester-logs', '');

        assert.strictEqual(resolved, path.join(os.homedir(), 'tester-logs'));
    });

    test('validates MQL date strings calendrically', function () {
        assert.ok(isValidDate('2025.02.28'));
        assert.ok(isValidDate('2024.02.29'));
        assert.strictEqual(isValidDate('2025.02.29'), false);
        assert.strictEqual(isValidDate('2025-02-28'), false);
    });

    test('parses valid MQL dates as local Date objects', function () {
        const parsed = parseMqlDate('2025.12.31');

        assert.strictEqual(parsed.getFullYear(), 2025);
        assert.strictEqual(parsed.getMonth(), 11);
        assert.strictEqual(parsed.getDate(), 31);
    });

    test('parseMqlDate handles invalid dates appropriately', function () {
        assert.strictEqual(parseMqlDate('invalid-date'), null);
        assert.strictEqual(parseMqlDate('2025.13.01'), null);
        assert.strictEqual(parseMqlDate('2025.02.30'), null);
    });
});

suite('backtestRunner — startup watchdog', function () {
    const GRACE_MS = 45 * 1000;

    test('does not trigger before the grace period elapses', function () {
        assert.strictEqual(shouldTriggerWatchdog(10000, GRACE_MS, 0, 0, false), false);
    });

    test('triggers after the grace period when no log activity is seen', function () {
        // currentMtime unchanged from the baseline -> MT5 never wrote.
        assert.strictEqual(shouldTriggerWatchdog(GRACE_MS, GRACE_MS, 1000, 1000, false), true);
        assert.strictEqual(shouldTriggerWatchdog(GRACE_MS + 5000, GRACE_MS, 0, 0, false), true);
    });

    test('does not trigger when the tester log shows fresh activity', function () {
        // currentMtime advanced past the baseline -> MT5 is writing logs.
        assert.strictEqual(shouldTriggerWatchdog(GRACE_MS + 5000, GRACE_MS, 1000, 2000, false), false);
    });

    test('only fires once (suppressed after it has been shown)', function () {
        assert.strictEqual(shouldTriggerWatchdog(GRACE_MS + 10000, GRACE_MS, 1000, 1000, true), false);
    });
});
