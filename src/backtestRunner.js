'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { COMPILE_MODE_CHECK } = require('./debugBridge');
const {
    discoverBacktestEAs,
    invalidateBacktestEAsCache,
    findBacktestEA,
    readTesterConfig,
    listSymbols,
    resolveTerminalPath,
    startBacktest,
    getBacktestStatus,
    cancelBacktest,
    cancelAllBacktests,
} = require('./backtestService');

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 10 * 60 * 1000;
const TERMINAL_SETTING_ID = 'mql_tools.Terminal.Terminal5Dir';
const TESTER_LOG_DIR_SETTING = 'Backtest.TesterLogDir';
const TESTER_LOG_DIR_SETTING_ID = `mql_tools.${TESTER_LOG_DIR_SETTING}`;
const DEFAULT_TERMINAL_PATHS = [
    'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
    'C:\\Program Files (x86)\\MetaTrader 5\\terminal64.exe',
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseMqlDate(v) {
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(v)) return null;
    const [year, month, day] = v.split('.').map(Number);
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
}

function isValidDate(v) {
    return parseMqlDate(v) !== null;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getWorkspaceFolderPath() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

function resolveBacktestPathSetting(rawPath, workspaceFolderPath = getWorkspaceFolderPath()) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return null;

    let expanded = rawPath.trim();
    if (workspaceFolderPath) expanded = expanded.replace(/\$\{workspaceFolder\}/g, workspaceFolderPath);
    if (expanded === '~' || expanded.startsWith(`~${path.sep}`) || expanded.startsWith('~/')) {
        expanded = path.join(os.homedir(), expanded.slice(1));
    }

    if (path.isAbsolute(expanded)) return path.normalize(expanded);
    return path.resolve(workspaceFolderPath || process.cwd(), expanded);
}

function resolveConfiguredTerminalPath(config) {
    const rawTerminalPath = config.get('Terminal.Terminal5Dir', '');
    const configuredPath = resolveBacktestPathSetting(rawTerminalPath);
    return resolveTerminalPath(configuredPath, DEFAULT_TERMINAL_PATHS);
}

function resolveConfiguredTesterLogDir(config) {
    return resolveBacktestPathSetting(config.get(TESTER_LOG_DIR_SETTING, ''));
}

function assertUsableMql5Root(mql5Root) {
    return mql5Root && fs.existsSync(path.join(mql5Root, 'Experts'));
}

// ---------------------------------------------------------------------------
// EA resolution
// ---------------------------------------------------------------------------

async function resolveEAName(context, mql5Root, resolveCompileTargets) {
    const eaList = discoverBacktestEAs(mql5Root);
    if (eaList.length === 0) {
        vscode.window.showErrorMessage('No EAs with tester.ini or runs/ folders were found under MQL5/Experts.');
        return null;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const candidateName = await resolveCandidateEAName(context, editor, resolveCompileTargets);
        if (candidateName) {
            const match = eaList.find(ea => ea.name.toLowerCase() === candidateName.toLowerCase());
            if (match) return match.name;
        }
    }

    const items = eaList.map(ea => {
        const latestLog = ea.getLatestLog();
        const runCount = ea.getAllLogs().length;
        return {
            label: ea.name,
            description: `${runCount} run${runCount !== 1 ? 's' : ''}`,
            detail: latestLog ? `Latest: ${latestLog.name}` : ea.hasTesterConfig() ? 'tester.ini available' : undefined,
        };
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select EA to backtest',
        title: 'MQL Backtest: Select Expert Advisor',
    });
    return pick ? pick.label : null;
}

async function resolveCandidateEAName(context, editor, resolveCompileTargets) {
    const filePath = editor.document.uri.fsPath;
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.mq5' || ext === '.mq4') return path.basename(filePath, ext);
    if (ext !== '.mqh' || !resolveCompileTargets) return null;

    try {
        const targets = await resolveCompileTargets({
            document: editor.document,
            workspaceFolder: vscode.workspace.getWorkspaceFolder(editor.document.uri),
            context,
            rt: COMPILE_MODE_CHECK,
        });
        const target = targets && targets[0];
        return target ? path.basename(target, path.extname(target)) : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Parameter collection
// ---------------------------------------------------------------------------

async function getTestParameters(mql5Root, eaName) {
    const defaults = getDefaults(mql5Root, eaName);
    const symbols = listSymbols(mql5Root);

    const symbol = await promptForSymbol(defaults.symbol, symbols);
    if (symbol === null) return null;

    const fromDate = await vscode.window.showInputBox({
        prompt: 'From date (YYYY.MM.DD)',
        value: defaults.fromDate,
        title: 'MQL Backtest: Start Date',
        validateInput: v => isValidDate(v) ? null : 'Invalid date (YYYY.MM.DD)',
    });
    if (fromDate === undefined) return null;

    const toDate = await vscode.window.showInputBox({
        prompt: 'To date (YYYY.MM.DD)',
        value: defaults.toDate,
        title: 'MQL Backtest: End Date',
        validateInput: v => isValidDate(v) ? null : 'Invalid date (YYYY.MM.DD)',
    });
    if (toDate === undefined) return null;

    if (parseMqlDate(fromDate) > parseMqlDate(toDate)) {
        vscode.window.showErrorMessage(`"From" date (${fromDate}) must not be after "To" date (${toDate}).`);
        return null;
    }

    return { symbol, fromDate, toDate, riskPercentage: defaults.riskPercentage };
}

function getDefaults(mql5Root, eaName) {
    const ea = findBacktestEA(mql5Root, eaName);
    return readTesterConfig(ea) || { symbol: '', fromDate: '', toDate: '', riskPercentage: 5.0 };
}

async function promptForSymbol(defaultSymbol, symbols) {
    const uniqueSymbols = symbols.includes(defaultSymbol) || !defaultSymbol ? symbols : [defaultSymbol, ...symbols];
    if (uniqueSymbols.length > 0) {
        const pick = await vscode.window.showQuickPick(
            uniqueSymbols.map(symbol => ({ label: symbol, picked: symbol === defaultSymbol })),
            { placeHolder: `Symbol (default: ${defaultSymbol || 'none'})`, title: 'MQL Backtest: Select Symbol' },
        );
        return pick ? pick.label : null;
    }

    const input = await vscode.window.showInputBox({
        prompt: 'Symbol',
        value: defaultSymbol,
        title: 'MQL Backtest: Enter Symbol',
    });
    return input === undefined ? null : input;
}

function getSilentParameters(mql5Root, eaName) {
    const defaults = getDefaults(mql5Root, eaName);
    const missing = ['symbol', 'fromDate', 'toDate'].filter(key => !defaults[key]);
    if (missing.length > 0) {
        vscode.window.showErrorMessage(`tester.ini for ${eaName} is missing required fields: ${missing.join(', ')}. Enable parameter prompts.`);
        return null;
    }
    if (!isValidDate(defaults.fromDate) || !isValidDate(defaults.toDate)) {
        vscode.window.showErrorMessage(`tester.ini for ${eaName} contains invalid dates (expected YYYY.MM.DD).`);
        return null;
    }
    return defaults;
}

// ---------------------------------------------------------------------------
// Execute & monitor
// ---------------------------------------------------------------------------

async function executeBacktest(eaName, params, options) {
    const startResult = startBacktest({ eaName, params, ...options });
    if (!startResult.started) {
        showStartFailure(eaName, startResult);
        return false;
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Backtest: ${eaName} on ${params.symbol}`,
            cancellable: true,
        },
        async (progress, token) => monitorBacktest(options.mql5Root, eaName, progress, token),
    );
}

function showStartFailure(eaName, result) {
    if (result.code === 'ALREADY_RUNNING') {
        vscode.window.showWarningMessage(`A test is already running for ${eaName}.`);
        return;
    }
    vscode.window.showErrorMessage(`Failed to start backtest: ${result.message}`);
}

async function monitorBacktest(mql5Root, eaName, progress, token) {
    const startTime = Date.now();
    progress.report({ message: 'Starting...' });

    while (!token.isCancellationRequested) {
        const elapsed = Date.now() - startTime;
        if (elapsed > MAX_POLL_TIME_MS) {
            vscode.window.showWarningMessage('Backtest monitoring timed out (10 min). The test may still be running in MT5.');
            return false;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        if (token.isCancellationRequested) break;

        const status = getBacktestStatus(mql5Root, eaName);
        if (!status.running) {
            if (status.status === 'completed') {
                vscode.window.showInformationMessage(`Backtest completed for ${eaName}.`);
                return true;
            }
            return false;
        }

        const secs = Math.round((Date.now() - startTime) / 1000);
        progress.report({ message: `Running... (${secs}s)` });
    }

    const cancelled = cancelBacktest(mql5Root, eaName);
    vscode.window.showInformationMessage(
        cancelled
            ? `Backtest for ${eaName} was cancelled.`
            : 'Backtest monitor was cancelled. The test may still be running in MT5.',
    );
    return false;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function runBacktest(context, opts) {
    invalidateBacktestEAsCache();
    const config = vscode.workspace.getConfiguration('mql_tools');
    const promptParams = config.get('Backtest.PromptForParameters', true);
    const autoOpen = config.get('Backtest.AutoOpenReport', true);
    const mql5Root = opts.findMql5Root();

    if (!assertUsableMql5Root(mql5Root)) {
        vscode.window.showErrorMessage('Cannot find MQL5 folder. Configure mql_tools.Metaeditor.Include5Dir to your MQL5 data folder.');
        return;
    }

    const terminalPath = resolveConfiguredTerminalPath(config);
    if (!terminalPath) {
        vscode.window.showErrorMessage(`Cannot find MT5 terminal. Configure ${TERMINAL_SETTING_ID}.`);
        return;
    }

    const eaName = await resolveEAName(context, mql5Root, opts.resolveCompileTargets);
    if (!eaName) return;

    const params = promptParams ? await getTestParameters(mql5Root, eaName) : getSilentParameters(mql5Root, eaName);
    if (!params) return;

    const completed = await executeBacktest(eaName, params, {
        mql5Root,
        terminalPath,
        testerLogDir: resolveConfiguredTesterLogDir(config),
    });

    if (completed && autoOpen) vscode.commands.executeCommand('mql_tools.openTradeReport');
}

function stopServer() {
    cancelAllBacktests();
}

module.exports = {
    runBacktest,
    stopServer,
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
    TESTER_LOG_DIR_SETTING_ID,
};
