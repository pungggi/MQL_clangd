'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const {
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
    shouldTriggerWatchdog,
    resolveStartupGraceMs,
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

    test('accepts the compact YYYYMMDD form from tester INI filenames', function () {
        assert.ok(isValidDate('20260201'));
        assert.ok(isValidDate('20240229'));

        const parsed = parseMqlDate('20260201');
        assert.strictEqual(parsed.getFullYear(), 2026);
        assert.strictEqual(parsed.getMonth(), 1);
        assert.strictEqual(parsed.getDate(), 1);
    });

    test('rejects calendrically invalid compact dates', function () {
        assert.strictEqual(isValidDate('20250229'), false);
        assert.strictEqual(isValidDate('20251301'), false);
        assert.strictEqual(isValidDate('2026020'), false);
        assert.strictEqual(isValidDate('202602011'), false);
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

suite('backtestRunner — startup grace resolution', function () {
    const DEFAULT_MS = 45 * 1000;
    const MIN_MS = 5 * 1000;

    test('uses the default when the setting is missing', function () {
        assert.strictEqual(resolveStartupGraceMs(undefined), DEFAULT_MS);
        assert.strictEqual(resolveStartupGraceMs(null), DEFAULT_MS);
    });

    test('converts a valid numeric setting to milliseconds', function () {
        assert.strictEqual(resolveStartupGraceMs(90), 90 * 1000);
    });

    test('falls back to the default for non-finite values', function () {
        assert.strictEqual(resolveStartupGraceMs(NaN), DEFAULT_MS);
        assert.strictEqual(resolveStartupGraceMs('not-a-number'), DEFAULT_MS);
        assert.strictEqual(resolveStartupGraceMs(Infinity), DEFAULT_MS);
    });

    test('clamps tiny or negative values to the minimum floor', function () {
        assert.strictEqual(resolveStartupGraceMs(-10), MIN_MS);
        assert.strictEqual(resolveStartupGraceMs(0), MIN_MS);
        assert.strictEqual(resolveStartupGraceMs(1), MIN_MS);
    });

    test('accepts numeric strings from settings', function () {
        assert.strictEqual(resolveStartupGraceMs('60'), 60 * 1000);
    });
});
