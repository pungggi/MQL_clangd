'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const vscode = require('vscode');
const {
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
    shouldTriggerWatchdog,
    resolveStartupGraceMs,
    promptForSymbol,
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

suite('backtestRunner — promptForSymbol', function () {
    let originalQuickPick;
    let originalInputBox;

    setup(function () {
        originalQuickPick = vscode.window.showQuickPick;
        originalInputBox = vscode.window.showInputBox;
    });

    teardown(function () {
        vscode.window.showQuickPick = originalQuickPick;
        vscode.window.showInputBox = originalInputBox;
    });

    test('returns the picked symbol from the Quick Pick without opening the input box', async function () {
        let inputBoxCalls = 0;
        vscode.window.showQuickPick = async items => items.find(i => i.label === 'EURUSD');
        vscode.window.showInputBox = async () => { inputBoxCalls += 1; return undefined; };

        const result = await promptForSymbol('EURUSD', ['EURUSD', 'GBPUSD']);

        assert.strictEqual(result, 'EURUSD');
        assert.strictEqual(inputBoxCalls, 0);
    });

    test('Quick Pick includes a manual-entry sentinel that opens the input box', async function () {
        let quickPickItems;
        vscode.window.showQuickPick = async items => {
            quickPickItems = items;
            return items.find(i => i._manual);
        };
        vscode.window.showInputBox = async () => 'USDJPY.pro';

        const result = await promptForSymbol('EURUSD', ['EURUSD', 'GBPUSD']);

        assert.strictEqual(result, 'USDJPY.pro');
        const manualItem = quickPickItems.find(i => i._manual);
        assert.ok(manualItem, 'manual-entry sentinel item should be present in the Quick Pick');
        assert.ok(manualItem.label.toLowerCase().includes('manually'), 'sentinel label should mention manual entry');
    });

    test('falls back to the input box when no symbols are discovered', async function () {
        let quickPickCalls = 0;
        vscode.window.showQuickPick = async () => { quickPickCalls += 1; return undefined; };
        vscode.window.showInputBox = async () => 'EURUSDm';

        const result = await promptForSymbol('', []);

        assert.strictEqual(result, 'EURUSDm');
        assert.strictEqual(quickPickCalls, 0, 'Quick Pick should be skipped when the symbol list is empty');
    });

    test('returns null when the user cancels the Quick Pick', async function () {
        vscode.window.showQuickPick = async () => undefined;
        vscode.window.showInputBox = async () => 'should-not-be-used';

        const result = await promptForSymbol('EURUSD', ['EURUSD']);

        assert.strictEqual(result, null);
    });

    test('returns null when the user cancels the manual-entry input box', async function () {
        vscode.window.showQuickPick = async items => items.find(i => i._manual);
        vscode.window.showInputBox = async () => undefined;

        const result = await promptForSymbol('EURUSD', ['EURUSD']);

        assert.strictEqual(result, null);
    });
});
