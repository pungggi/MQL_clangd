'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    resolveBacktestPathSetting,
    resolveBacktestServerDir,
    isTradeReportServerDir,
    getTradeReportServerNotFoundMessage,
} = require('../src/backtestRunner');

suite('backtestRunner — TradeReportServer paths', function () {
    test('uses the default TradeReportServer folder under the MQL5 data folder', function () {
        const mql5Root = path.join('home', 'user', '.wine', 'drive_c', 'Terminal', 'MQL5');
        const expected = path.join(mql5Root, 'Tools', 'TradeReportServer');

        assert.strictEqual(resolveBacktestServerDir(mql5Root, '', ''), expected);
    });

    test('configured ServerDir overrides the default folder', function () {
        const workspace = path.resolve('workspace');
        const configured = '${workspaceFolder}/tools/server';
        const expected = path.join(workspace, 'tools', 'server');

        assert.strictEqual(resolveBacktestServerDir('/ignored/MQL5', configured, workspace), expected);
    });

    test('resolves relative ServerDir values against the workspace folder', function () {
        const workspace = path.resolve('workspace');
        const expected = path.join(workspace, 'tools', 'TradeReportServer');

        assert.strictEqual(resolveBacktestPathSetting('tools/TradeReportServer', workspace), expected);
    });

    test('detects a valid TradeReportServer package folder', function () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-backtest-server-'));
        try {
            const srcDir = path.join(tempDir, 'src');
            fs.mkdirSync(srcDir);
            fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(srcDir, 'index.js'), '');

            assert.strictEqual(isTradeReportServerDir(tempDir), true);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('missing-server message points users to ServerDir and Include5Dir', function () {
        const message = getTradeReportServerNotFoundMessage('/missing/TradeReportServer');

        assert.ok(message.includes('mql_tools.Backtest.ServerDir'));
        assert.ok(message.includes('Metaeditor.Include5Dir'));
        assert.ok(message.includes('package.json'));
    });
});
