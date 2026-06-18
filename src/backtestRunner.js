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
    findLatestTesterLog,
} = require('./backtestService');
const {
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineEnv,
    validateWinePath,
    validateWineSetup,
    showOutputChannel,
} = require('./wineHelper');

const POLL_INTERVAL_MS = 2000;
const DEFAULT_STARTUP_GRACE_SECONDS = 45;
const STARTUP_GRACE_SETTING = 'Backtest.StartupGraceSeconds';
const MIN_STARTUP_GRACE_SECONDS = 5;
const DEFAULT_MONITOR_TIMEOUT_MINUTES = 10;
const MONITOR_TIMEOUT_SETTING = 'Backtest.MonitorTimeoutMinutes';
const MIN_MONITOR_TIMEOUT_MINUTES = 1;
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

/**
 * Parse an MQL date string into a local `Date`, validating it calendrically.
 *
 * Accepts the canonical dotted form `YYYY.MM.DD` and the compact `YYYYMMDD`
 * form used in MT5 tester INI filenames (users often copy-paste from there).
 *
 * @param {*} v - The raw date string.
 * @returns {Date|null} The parsed Date, or null if the input is malformed or not a real calendar date.
 */
function parseMqlDate(v) {
    if (typeof v !== 'string') return null;

    let year, month, day;
    if (/^\d{4}\.\d{2}\.\d{2}$/.test(v)) {
        [year, month, day] = v.split('.').map(Number);
    } else if (/^\d{8}$/.test(v)) {
        [year, month, day] = [v.slice(0, 4), v.slice(4, 6), v.slice(6, 8)].map(Number);
    } else {
        return null;
    }

    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
}

/**
 * Report whether a string is a valid MQL date in either accepted format.
 *
 * @param {*} v - The raw date string.
 * @returns {boolean} True if `v` parses to a real calendar date.
 */
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

function isUsableMql5Root(mql5Root) {
    return mql5Root && fs.existsSync(path.join(mql5Root, 'Experts'));
}

// ---------------------------------------------------------------------------
// EA resolution
// ---------------------------------------------------------------------------

async function resolveEAName(context, mql5Root, resolveCompileTargets) {
    const eaList = discoverBacktestEAs(mql5Root);
    if (eaList.length === 0) {
        vscode.window.showErrorMessage('No EAs with tester configuration files (*.ini) or runs/ folders were found under MQL5/Experts.');
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
            detail: latestLog ? `Latest: ${latestLog.name}` : ea.hasTesterConfig() ? 'Configuration available' : undefined,
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
    } catch (err) {
        console.error(`resolveCompileTargets failed for ${filePath}:`, err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Tester INI selection
// ---------------------------------------------------------------------------

async function selectTesterIniFile(ea) {
    const candidates = ea.getTesterIniCandidates();
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return ea.testerIniPath;

    const defaultName = 'tester.ini';
    const items = candidates.map(p => {
        const name = path.basename(p);
        return {
            label: name,
            description: name.toLowerCase() === defaultName ? '(default)' : undefined,
            path: p,
        };
    });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Multiple tester INI files in ${ea.name} — choose one for this run`,
        title: `MQL Backtest: Select tester INI for ${ea.name}`,
    });
    if (!pick) return undefined;

    ea.testerIniPath = pick.path;
    return pick.path;
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
        prompt: 'From date (YYYY.MM.DD or YYYYMMDD)',
        value: defaults.fromDate,
        title: 'MQL Backtest: Start Date',
        validateInput: v => isValidDate(v) ? null : 'Invalid date (YYYY.MM.DD or YYYYMMDD)',
    });
    if (fromDate === undefined) return null;

    const toDate = await vscode.window.showInputBox({
        prompt: 'To date (YYYY.MM.DD or YYYYMMDD)',
        value: defaults.toDate,
        title: 'MQL Backtest: End Date',
        validateInput: v => isValidDate(v) ? null : 'Invalid date (YYYY.MM.DD or YYYYMMDD)',
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
    if (uniqueSymbols.length === 0) return promptForSymbolInput(defaultSymbol);

    const items = uniqueSymbols.map(symbol => ({ label: symbol, picked: symbol === defaultSymbol }));
    items.push({ label: '$(edit) Enter symbol manually…', alwaysShow: true, _manual: true });

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Symbol (default: ${defaultSymbol || 'none'})`,
        title: 'MQL Backtest: Select Symbol',
    });
    if (!pick) return null;
    if (pick._manual) return promptForSymbolInput(defaultSymbol);
    return pick.label;
}

async function promptForSymbolInput(defaultSymbol) {
    const input = await vscode.window.showInputBox({
        prompt: 'Symbol (e.g. EURUSD, USDJPY.pro, EURUSDm)',
        value: defaultSymbol,
        title: 'MQL Backtest: Enter Symbol',
    });
    return input === undefined ? null : input;
}

/**
 * Merge launch-behavior settings into the backtest params. Both settings are
 * tri-state: `true`/`false` overrides the EA's INI, anything else (the `null`
 * default) leaves the INI value untouched.
 *
 * @param {vscode.WorkspaceConfiguration} config - The `mql_tools` configuration.
 * @param {object} params - Backtest parameters to mutate.
 */
function applyLaunchBehaviorSettings(config, params) {
    const visualMode = config.get('Backtest.VisualMode', null);
    const keepTerminalOpen = config.get('Backtest.KeepTerminalOpen', null);
    if (typeof visualMode === 'boolean') params.visualMode = visualMode;
    if (typeof keepTerminalOpen === 'boolean') params.shutdownTerminal = !keepTerminalOpen;
}

function getSilentParameters(mql5Root, eaName) {
    const ea = findBacktestEA(mql5Root, eaName);
    const iniName = ea && ea.testerIniPath ? path.basename(ea.testerIniPath) : 'tester.ini';
    const defaults = getDefaults(mql5Root, eaName);
    const missing = ['symbol', 'fromDate', 'toDate'].filter(key => !defaults[key]);
    if (missing.length > 0) {
        vscode.window.showErrorMessage(`Tester configuration for ${eaName} is missing required fields: ${missing.join(', ')}. Enable parameter prompts.`);
        return null;
    }
    if (!isValidDate(defaults.fromDate) || !isValidDate(defaults.toDate)) {
        vscode.window.showErrorMessage(`${iniName} for ${eaName} contains invalid dates (expected YYYY.MM.DD or YYYYMMDD).`);
        return null;
    }
    return defaults;
}

// ---------------------------------------------------------------------------
// Execute & monitor
// ---------------------------------------------------------------------------

/**
 * Coerces the configured startup grace period into a sane millisecond value.
 * Falls back to the default when the setting is missing, non-numeric, or
 * non-finite (e.g. mistyped in settings) and clamps to a minimum floor so a
 * tiny or negative value can't make the watchdog fire immediately.
 */
function resolveStartupGraceMs(rawSeconds) {
    const seconds = rawSeconds === undefined || rawSeconds === null ? DEFAULT_STARTUP_GRACE_SECONDS : Number(rawSeconds);
    if (!Number.isFinite(seconds)) return DEFAULT_STARTUP_GRACE_SECONDS * 1000;
    return Math.max(MIN_STARTUP_GRACE_SECONDS, seconds) * 1000;
}

/**
 * Coerces the configured monitor timeout into a sane millisecond value.
 * Falls back to the default when the setting is missing, non-numeric, or
 * non-finite, and clamps to a minimum floor so the monitor can't give up
 * before the first poll. Long visual-mode runs may need a generous value.
 */
function resolveMonitorTimeoutMs(rawMinutes) {
    const minutes = rawMinutes === undefined || rawMinutes === null ? DEFAULT_MONITOR_TIMEOUT_MINUTES : Number(rawMinutes);
    if (!Number.isFinite(minutes)) return DEFAULT_MONITOR_TIMEOUT_MINUTES * 60 * 1000;
    return Math.max(MIN_MONITOR_TIMEOUT_MINUTES, minutes) * 60 * 1000;
}

async function executeBacktest(eaName, params, options) {
    const startResult = await startBacktest({ eaName, params, ...options });
    if (!startResult.started) {
        showStartFailure(eaName, startResult);
        return false;
    }

    const isWine = !!options.useWine;
    const diagnostics = startResult.diagnostics || null;
    const startupGraceMs = resolveStartupGraceMs(options.startupGraceSeconds);
    const monitorTimeoutMs = resolveMonitorTimeoutMs(options.monitorTimeoutMinutes);
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Backtest: ${eaName} on ${params.symbol}`,
            cancellable: true,
        },
        async (progress, token) => monitorBacktest(options.mql5Root, eaName, progress, token, {
            isWine,
            diagnostics,
            startupGraceMs,
            monitorTimeoutMs,
        }),
    );
}

/**
 * Decides whether the startup watchdog should fire. It triggers once, after the
 * grace period elapses, when the watched tester-log directory shows no new
 * activity since launch — the signature of a misconfigured run that would
 * otherwise spin silently until MAX_POLL_TIME_MS.
 */
function shouldTriggerWatchdog(elapsedMs, graceMs, baselineMtimeMs, currentMtimeMs, alreadyShown) {
    if (alreadyShown) return false;
    if (elapsedMs < graceMs) return false;
    return currentMtimeMs <= baselineMtimeMs;
}

function showWatchdogNotification(mql5Root, eaName, elapsedSecs, diagnostics) {
    const lines = [`Backtest "${eaName}": MT5 launched ${elapsedSecs}s ago but no Strategy Tester log activity was detected.`];
    if (diagnostics) {
        if (diagnostics.terminalPath) lines.push(`Terminal: ${diagnostics.terminalPath}`);
        if (diagnostics.launchArgs) lines.push(`Args: ${diagnostics.launchArgs.join(' ')}`);
        if (diagnostics.testerIniPath) lines.push(`tester.ini: ${diagnostics.testerIniPath}`);
        if (diagnostics.logDir) lines.push(`Watching: ${diagnostics.logDir}`);
    }
    lines.push('MT5 may be writing logs elsewhere (wrong terminal, portable mismatch, different terminal-id).');

    // Fire-and-forget so polling continues while the notification is shown.
    vscode.window.showWarningMessage(lines.join(' '), 'Show Output', 'Cancel Backtest').then(selection => {
        if (selection === 'Show Output') {
            showOutputChannel();
        } else if (selection === 'Cancel Backtest') {
            cancelBacktest(mql5Root, eaName);
        }
    });
}

function showStartFailure(eaName, result) {
    if (result.code === 'ALREADY_RUNNING') {
        vscode.window.showWarningMessage(`A test is already running for ${eaName}.`);
        return;
    }
    vscode.window.showErrorMessage(`Failed to start backtest: ${result.message}`);
}

async function monitorBacktest(mql5Root, eaName, progress, token, monitorOptions = {}) {
    const {
        isWine = false,
        diagnostics = null,
        startupGraceMs = DEFAULT_STARTUP_GRACE_SECONDS * 1000,
        monitorTimeoutMs = DEFAULT_MONITOR_TIMEOUT_MINUTES * 60 * 1000,
    } = monitorOptions;
    const startTime = Date.now();
    progress.report({ message: 'Starting...' });

    const logDir = diagnostics?.logDir || null;
    const baselineMtimeMs = logDir ? (findLatestTesterLog(logDir)?.mtimeMs ?? 0) : 0;
    let watchdogShown = false;

    while (!token.isCancellationRequested) {
        const elapsed = Date.now() - startTime;
        if (elapsed > monitorTimeoutMs) {
            const timeoutMin = Math.round(monitorTimeoutMs / 60000);
            vscode.window.showWarningMessage(
                `Backtest monitoring timed out (${timeoutMin} min). The test may still be running in MT5. `
                + `Increase mql_tools.${MONITOR_TIMEOUT_SETTING} for long runs.`,
            );
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

        const elapsedNow = Date.now() - startTime;
        const secs = Math.round(elapsedNow / 1000);

        if (logDir && !watchdogShown) {
            const currentMtimeMs = findLatestTesterLog(logDir)?.mtimeMs ?? 0;
            if (shouldTriggerWatchdog(elapsedNow, startupGraceMs, baselineMtimeMs, currentMtimeMs, watchdogShown)) {
                watchdogShown = true;
                showWatchdogNotification(mql5Root, eaName, secs, diagnostics);
            }
        }

        progress.report({ message: `Running... (${secs}s)` });
    }

    const cancelled = cancelBacktest(mql5Root, eaName);
    const cancelMsg = isWine
        ? 'Backtest monitor was cancelled. MT5 may still be running inside Wine (best-effort termination).'
        : `Backtest for ${eaName} was cancelled.`;
    vscode.window.showInformationMessage(
        cancelled ? cancelMsg : 'Backtest monitor was cancelled. The test may still be running in MT5.',
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

    if (!isUsableMql5Root(mql5Root)) {
        vscode.window.showErrorMessage('Cannot find MQL5 folder. Configure mql_tools.Metaeditor.Include5Dir to your MQL5 data folder.');
        return;
    }

    // --- Wine detection and validation ---
    const useWine = isWineEnabled(config);
    let wineBinary, winePrefix, wineEnv;

    if (process.platform !== 'win32' && !useWine) {
        vscode.window.showErrorMessage(
            'Backtest launch requires Wine on this platform. Enable mql_tools.Wine.Enabled and configure your Wine prefix.',
            'Open Settings',
        ).then(sel => {
            if (sel === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'mql_tools.Wine');
        });
        return;
    }

    if (useWine) {
        wineBinary = getWineBinary(config);
        winePrefix = getWinePrefix(config);
        wineEnv = getWineEnv(config);

        const validation = await validateWineSetup(config);
        if (!validation.valid) {
            vscode.window.showErrorMessage(`Wine setup invalid: ${validation.errors.join('; ')}`);
            return;
        }
    }

    const terminalPath = resolveConfiguredTerminalPath(config);
    if (!terminalPath) {
        vscode.window.showErrorMessage(`Cannot find MT5 terminal. Configure ${TERMINAL_SETTING_ID}.`);
        return;
    }

    // Validate terminal path format when Wine is active
    if (useWine) {
        const pathCheck = validateWinePath(terminalPath);
        if (!pathCheck.valid) {
            vscode.window.showErrorMessage(`Wine Configuration Error: ${pathCheck.error}`);
            return;
        }
    }

    const eaName = await resolveEAName(context, mql5Root, opts.resolveCompileTargets);
    if (!eaName) return;

    const ea = findBacktestEA(mql5Root, eaName);
    if (!ea) {
        vscode.window.showErrorMessage(`EA ${eaName} not found.`);
        return;
    }
    const iniSelected = await selectTesterIniFile(ea);
    if (iniSelected === undefined) return;

    const params = promptParams ? await getTestParameters(mql5Root, eaName) : getSilentParameters(mql5Root, eaName);
    if (!params) return;
    applyLaunchBehaviorSettings(config, params);

    const portableMode = config.get('Metaeditor.Portable5', false);
    const startupGraceSeconds = config.get(STARTUP_GRACE_SETTING, DEFAULT_STARTUP_GRACE_SECONDS);
    const monitorTimeoutMinutes = config.get(MONITOR_TIMEOUT_SETTING, DEFAULT_MONITOR_TIMEOUT_MINUTES);

    const completed = await executeBacktest(eaName, params, {
        mql5Root,
        terminalPath,
        testerLogDir: resolveConfiguredTesterLogDir(config),
        useWine,
        wineBinary,
        winePrefix,
        wineEnv,
        portableMode,
        startupGraceSeconds,
        monitorTimeoutMinutes,
    });

    if (completed && autoOpen) vscode.commands.executeCommand('mql_tools.openTradeReport');
}

function cancelBacktests() {
    cancelAllBacktests();
}

module.exports = {
    runBacktest,
    cancelBacktests,
    resolveBacktestPathSetting,
    parseMqlDate,
    isValidDate,
    shouldTriggerWatchdog,
    resolveStartupGraceMs,
    resolveMonitorTimeoutMs,
    promptForSymbol,
    applyLaunchBehaviorSettings,
    TESTER_LOG_DIR_SETTING_ID,
};
