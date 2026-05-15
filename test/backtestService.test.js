'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    discoverBacktestEAs,
    invalidateBacktestEAsCache,
    parseTesterIni,
    updateTesterIniContent,
    readTesterConfig,
    findTesterLogDir,
    isTesterLogComplete,
    startBacktest,
    testerConfigFromIni,
} = require('../src/backtestService');

// Note: tests in this suite mutate process.env.APPDATA. Mocha runs files
// serially by default; do not enable parallel mode without isolating env state.

suite('backtestService', function () {
    let tempDir;

    setup(function () {
        invalidateBacktestEAsCache();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-backtest-service-'));
    });

    teardown(function () {
        invalidateBacktestEAsCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('discovers EAs with tester.ini even before any run logs exist', function () {
        const eaDir = createEa('Experts/MyEA', '[Tester]\nSymbol=EURUSD\n');

        const eas = discoverBacktestEAs(path.join(tempDir, 'MQL5'));

        assert.strictEqual(eas.length, 1);
        assert.strictEqual(eas[0].name, 'MyEA');
        assert.strictEqual(eas[0].dir, eaDir);
    });

    test('parses tester.ini tester and input defaults', function () {
        const iniPath = path.join(createEa('Experts/MyEA', testerIni()), 'tester.ini');

        const parsed = parseTesterIni(iniPath);
        const config = readTesterConfig({ testerIniPath: iniPath });

        assert.strictEqual(parsed.tester.Symbol, 'EURUSD');
        assert.strictEqual(parsed.inputs.RiskPercentage, '3.5');
        assert.deepStrictEqual(config, {
            symbol: 'EURUSD',
            fromDate: '2025.01.01',
            toDate: '2025.01.31',
            period: 'M5',
            riskPercentage: 3.5,
        });
    });

    test('updates tester.ini content while preserving optimization input format', function () {
        const updated = updateTesterIniContent(testerIni(), {
            symbol: 'GBPUSD',
            fromDate: '2025.02.01',
            toDate: '2025.02.28',
            riskPercentage: 1.25,
        });

        assert.ok(updated.includes('Symbol=GBPUSD'));
        assert.ok(updated.includes('FromDate=2025.02.01'));
        assert.ok(updated.includes('ToDate=2025.02.28'));
        assert.ok(updated.includes('RiskPercentage=1.25||1||0.5||10||Y'));
    });

    test('finds tester agent log directory from MQL5 root terminal id', function () {
        const mql5Root = path.join(tempDir, 'MetaQuotes', 'Terminal', 'ABCDEF', 'MQL5');
        const logDir = path.join(tempDir, 'MetaQuotes', 'Tester', 'ABCDEF', 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(mql5Root, { recursive: true });
        fs.mkdirSync(logDir, { recursive: true });

        const oldAppData = process.env.APPDATA;
        process.env.APPDATA = tempDir;
        try {
            assert.strictEqual(findTesterLogDir(mql5Root), logDir);
        } finally {
            if (oldAppData === undefined) delete process.env.APPDATA;
            else process.env.APPDATA = oldAppData;
        }
    });

    test('detects tester log completion without deleting prior logs', function () {
        const logPath = path.join(tempDir, 'tester.log');
        const content = 'MyEA deinitialized\nSIMULATED TRADING SUMMARY\nMetaTester 5 stopped\n';
        fs.writeFileSync(logPath, Buffer.from(content, 'utf16le'));

        assert.strictEqual(isTesterLogComplete(logPath, 'MyEA', 1), true);
        assert.strictEqual(isTesterLogComplete(logPath, 'MyEA', 2), false);
        assert.strictEqual(isTesterLogComplete(logPath, 'OtherEA', 1), false);
    });

    test('also handles UTF-8 tester-like logs in tests and fixtures', function () {
        const logPath = path.join(tempDir, 'tester-utf8.log');
        fs.writeFileSync(logPath, 'MyEA deinitialized\nfinal balance\nMetaTester 5 stopped\n', 'utf8');

        assert.strictEqual(isTesterLogComplete(logPath, 'MyEA', 1), true);
    });

    test('preserves a zero RiskPercentage instead of defaulting to 5.0', function () {
        const parsed = testerConfigFromIni({
            tester: { Symbol: 'EURUSD' },
            inputs: { RiskPercentage: '0' },
        });
        assert.strictEqual(parsed.riskPercentage, 0);

        const updated = updateTesterIniContent(testerIni(), { riskPercentage: 0 });
        assert.ok(updated.includes('RiskPercentage=0||1||0.5||10||Y'));
    });

    test('falls back to 5.0 when RiskPercentage is missing or non-numeric', function () {
        assert.strictEqual(testerConfigFromIni({ tester: {}, inputs: {} }).riskPercentage, 5.0);
        assert.strictEqual(testerConfigFromIni({ tester: {}, inputs: { RiskPercentage: 'abc' } }).riskPercentage, 5.0);
    });

    test('reuses cached discovery results until invalidated', function () {
        createEa('Experts/CachedEA', '[Tester]\nSymbol=EURUSD\n');
        const mql5Root = path.join(tempDir, 'MQL5');

        const first = discoverBacktestEAs(mql5Root);
        assert.strictEqual(first.length, 1);

        createEa('Experts/SecondEA', '[Tester]\nSymbol=GBPUSD\n');
        assert.strictEqual(discoverBacktestEAs(mql5Root).length, 1, 'cache should still hold one EA');

        invalidateBacktestEAsCache();
        assert.strictEqual(discoverBacktestEAs(mql5Root).length, 2, 'invalidation should pick up new EA');
    });

    test('startBacktest reports EA_NOT_FOUND when name does not match', async function () {
        createEa('Experts/RealEA', testerIni());
        const mql5Root = path.join(tempDir, 'MQL5');

        const result = await startBacktest({
            mql5Root,
            eaName: 'GhostEA',
            params: {},
            terminalPath: path.join(tempDir, 'fake-terminal'),
        });
        assert.strictEqual(result.started, false);
        assert.strictEqual(result.code, 'EA_NOT_FOUND');
    });

    test('startBacktest reports NO_TESTER_INI when EA has only runs/ folder', async function () {
        const eaDir = path.join(tempDir, 'MQL5', 'Experts', 'NoIniEA');
        fs.mkdirSync(path.join(eaDir, 'runs'), { recursive: true });
        const mql5Root = path.join(tempDir, 'MQL5');

        const result = await startBacktest({
            mql5Root,
            eaName: 'NoIniEA',
            params: {},
            terminalPath: path.join(tempDir, 'fake-terminal'),
        });
        assert.strictEqual(result.started, false);
        assert.strictEqual(result.code, 'NO_TESTER_INI');
    });

    test('startBacktest reports NO_TERMINAL when no terminal path provided', async function () {
        createEa('Experts/MyEA', testerIni());
        const mql5Root = path.join(tempDir, 'MQL5');

        const result = await startBacktest({
            mql5Root,
            eaName: 'MyEA',
            params: {},
            terminalPath: null,
        });
        assert.strictEqual(result.started, false);
        assert.strictEqual(result.code, 'NO_TERMINAL');
    });

    test('startBacktest reports NO_TESTER_LOG_DIR when no agent log dir exists', async function () {
        const mql5Root = path.join(tempDir, 'MetaQuotes', 'Terminal', 'NOLOGS', 'MQL5');
        const eaDir = path.join(mql5Root, 'Experts', 'MyEA');
        fs.mkdirSync(eaDir, { recursive: true });
        fs.writeFileSync(path.join(eaDir, 'tester.ini'), testerIni());

        const oldAppData = process.env.APPDATA;
        process.env.APPDATA = tempDir;
        try {
            const result = await startBacktest({
                mql5Root,
                eaName: 'MyEA',
                params: {},
                terminalPath: path.join(tempDir, 'fake-terminal'),
            });
            assert.strictEqual(result.started, false);
            assert.strictEqual(result.code, 'NO_TESTER_LOG_DIR');
        } finally {
            if (oldAppData === undefined) delete process.env.APPDATA;
            else process.env.APPDATA = oldAppData;
        }
    });

    function createEa(relativeDir, iniContent) {
        const eaDir = path.join(tempDir, 'MQL5', relativeDir);
        fs.mkdirSync(eaDir, { recursive: true });
        fs.writeFileSync(path.join(eaDir, 'tester.ini'), iniContent);
        return eaDir;
    }
});

suite('backtestService — Wine tester log discovery', function () {
    let tempDir;

    setup(function () {
        invalidateBacktestEAsCache();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-backtest-wine-'));
    });

    teardown(function () {
        invalidateBacktestEAsCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('finds tester log dir under Wine prefix using terminal ID', function () {
        const terminalId = 'ABC123';
        const mql5Root = path.join(tempDir, 'prefix', 'drive_c', 'MetaQuotes', 'Terminal', terminalId, 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        const logDir = path.join(tempDir, 'prefix', 'drive_c', 'users', 'wineuser',
            'AppData', 'Roaming', 'MetaQuotes', 'Tester', terminalId, 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const winePrefix = path.join(tempDir, 'prefix');
        const result = findTesterLogDir(mql5Root, '', { winePrefix });
        assert.strictEqual(result, logDir);
    });

    test('finds tester log dir via bounded fallback when terminal ID differs', function () {
        const mql5Root = path.join(tempDir, 'prefix', 'drive_c', 'Programs', 'MT5', 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        const logDir = path.join(tempDir, 'prefix', 'drive_c', 'users', 'crossover',
            'AppData', 'Roaming', 'MetaQuotes', 'Tester', 'DEADBEEF', 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const winePrefix = path.join(tempDir, 'prefix');
        const result = findTesterLogDir(mql5Root, '', { winePrefix });
        assert.strictEqual(result, logDir);
    });

    test('prefers configured dir over Wine prefix scan', function () {
        const mql5Root = path.join(tempDir, 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        const configuredDir = path.join(tempDir, 'custom-logs');
        fs.mkdirSync(configuredDir, { recursive: true });

        const result = findTesterLogDir(mql5Root, configuredDir, { winePrefix: path.join(tempDir, 'prefix') });
        assert.strictEqual(result, configuredDir);
    });

    test('returns null when no agent dirs exist under Wine prefix', function () {
        const mql5Root = path.join(tempDir, 'prefix', 'drive_c', 'MT5', 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        // Create the users dir but no MetaQuotes subdirectories
        fs.mkdirSync(path.join(tempDir, 'prefix', 'drive_c', 'users', 'user1'), { recursive: true });

        const result = findTesterLogDir(mql5Root, '', { winePrefix: path.join(tempDir, 'prefix') });
        assert.strictEqual(result, null);
    });

    test('returns null when Wine prefix does not exist', function () {
        const mql5Root = path.join(tempDir, 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        const result = findTesterLogDir(mql5Root, '', { winePrefix: path.join(tempDir, 'nonexistent') });
        assert.strictEqual(result, null);
    });

    test('scans multiple Wine users and picks freshest log dir', function () {
        const terminalId = 'TERM1';
        const mql5Root = path.join(tempDir, 'prefix', 'drive_c', 'MetaQuotes', 'Terminal', terminalId, 'MQL5');
        fs.mkdirSync(mql5Root, { recursive: true });

        // Create two users with agent log dirs
        const logDir1 = path.join(tempDir, 'prefix', 'drive_c', 'users', 'user1',
            'AppData', 'Roaming', 'MetaQuotes', 'Tester', terminalId, 'Agent-127.0.0.1-3000', 'logs');
        const logDir2 = path.join(tempDir, 'prefix', 'drive_c', 'users', 'user2',
            'AppData', 'Roaming', 'MetaQuotes', 'Tester', terminalId, 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(logDir1, { recursive: true });
        fs.mkdirSync(logDir2, { recursive: true });

        // Touch logDir2 to make it the freshest
        fs.writeFileSync(path.join(logDir2, 'dummy.log'), 'test');

        const winePrefix = path.join(tempDir, 'prefix');
        const result = findTesterLogDir(mql5Root, '', { winePrefix });
        assert.strictEqual(result, logDir2);
    });

    test('without wineOptions falls back to native APPDATA resolution', function () {
        const mql5Root = path.join(tempDir, 'MetaQuotes', 'Terminal', 'NATIVE', 'MQL5');
        const logDir = path.join(tempDir, 'MetaQuotes', 'Tester', 'NATIVE', 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(mql5Root, { recursive: true });
        fs.mkdirSync(logDir, { recursive: true });

        const oldAppData = process.env.APPDATA;
        process.env.APPDATA = tempDir;
        try {
            const result = findTesterLogDir(mql5Root);
            assert.strictEqual(result, logDir);
        } finally {
            if (oldAppData === undefined) delete process.env.APPDATA;
            else process.env.APPDATA = oldAppData;
        }
    });
});

suite('backtestService — Wine launch validation', function () {
    let tempDir;

    setup(function () {
        invalidateBacktestEAsCache();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-backtest-wine-launch-'));
    });

    teardown(function () {
        invalidateBacktestEAsCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('startBacktest rejects Windows-style terminal path in Wine mode', async function () {
        const eaDir = path.join(tempDir, 'MQL5', 'Experts', 'MyEA');
        fs.mkdirSync(eaDir, { recursive: true });
        fs.writeFileSync(path.join(eaDir, 'tester.ini'), testerIni());

        // Create fake log dir so we don't fail on NO_TESTER_LOG_DIR
        const logDir = path.join(tempDir, 'prefix', 'drive_c', 'users', 'u',
            'AppData', 'Roaming', 'MetaQuotes', 'Tester', 'MQL5', 'Agent-127.0.0.1-3000', 'logs');
        fs.mkdirSync(logDir, { recursive: true });

        const result = await startBacktest({
            mql5Root: path.join(tempDir, 'MQL5'),
            eaName: 'MyEA',
            params: { symbol: 'EURUSD', fromDate: '2025.01.01', toDate: '2025.01.31' },
            terminalPath: 'C:\\Program Files\\MT5\\terminal64.exe',
            useWine: true,
            wineBinary: 'wine64',
            winePrefix: path.join(tempDir, 'prefix'),
            wineEnv: {},
        });

        assert.strictEqual(result.started, false);
        assert.strictEqual(result.code, 'INVALID_TERMINAL_PATH');
    });
});

function testerIni() {
    return [
        '[Tester]',
        'Symbol=EURUSD',
        'Period=M5',
        'FromDate=2025.01.01',
        'ToDate=2025.01.31',
        '[Inputs]',
        'RiskPercentage=3.5||1||0.5||10||Y',
        '',
    ].join('\n');
}