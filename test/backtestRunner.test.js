'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const vscode = require('vscode');
const {
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
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
