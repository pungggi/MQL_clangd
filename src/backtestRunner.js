'use strict';
const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;

const DEFAULT_PORT = 3002;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// HTTP helper — lightweight, no dependencies
// ---------------------------------------------------------------------------

/**
 * @param {'GET'|'POST'} method
 * @param {string} urlPath
 * @param {object|null} body
 * @param {number} port
 * @returns {Promise<{statusCode: number, data: any}>}
 */
function httpRequest(method, urlPath, body = null, port = DEFAULT_PORT) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'localhost',
            port,
            path: urlPath,
            method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        };
        if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => raw += chunk);
            res.on('end', () => {
                let data;
                try { data = JSON.parse(raw); } catch { data = raw; }
                resolve({ statusCode: res.statusCode, data });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        if (payload) req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function pingServer(port = DEFAULT_PORT) {
    try {
        const { statusCode } = await httpRequest('GET', '/api/eas', null, port);
        return statusCode === 200;
    } catch {
        return false;
    }
}

/**
 * Auto-start the TradeReportServer if it isn't already running.
 * @param {string} serverDir  Absolute path to the TradeReportServer directory
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function startServer(serverDir, port = DEFAULT_PORT) {
    const pkgPath = path.join(serverDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        vscode.window.showErrorMessage(`TradeReportServer not found at ${serverDir}`);
        return false;
    }

    serverProcess = spawn(process.execPath, ['src/index.js', 'serve'], {
        cwd: serverDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PORT: String(port) },
    });
    serverProcess.unref();

    // Wait for the server to become responsive
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await pingServer(port)) return true;
    }
    return false;
}

function stopServer() {
    if (serverProcess) {
        try { serverProcess.kill(); } catch { /* already gone */ }
        serverProcess = null;
    }
}

// ---------------------------------------------------------------------------
// EA resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which EA to test from the current file + server EA list.
 * @param {vscode.ExtensionContext} context
 * @param {number} port
 * @param {Function} resolveCompileTargets
 * @returns {Promise<string|null>} EA name or null if cancelled
 */
async function resolveEAName(context, port, resolveCompileTargets) {
    // Fetch known EAs from the server
    let eaList;
    try {
        const { statusCode, data } = await httpRequest('GET', '/api/eas', null, port);
        if (statusCode !== 200) throw new Error('Unexpected status');
        eaList = data;
    } catch {
        vscode.window.showErrorMessage('Failed to fetch EA list from TradeReportServer.');
        return null;
    }

    if (!eaList || eaList.length === 0) {
        vscode.window.showErrorMessage('No EAs with runs/ folders found on TradeReportServer.');
        return null;
    }

    // Try to match from the active editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const filePath = editor.document.uri.fsPath;
        const ext = path.extname(filePath).toLowerCase();
        let candidateName = null;

        if (ext === '.mq5' || ext === '.mq4') {
            candidateName = path.basename(filePath, ext);
        } else if (ext === '.mqh' && resolveCompileTargets) {
            // Reuse compile-target resolution to find the parent EA file
            try {
                const targets = await resolveCompileTargets(filePath, context, { silent: true });
                if (targets && targets.length > 0) {
                    const t = targets[0];
                    candidateName = path.basename(t, path.extname(t));
                }
            } catch { /* ignore — fall through to picker */ }
        }

        if (candidateName) {
            const match = eaList.find(ea =>
                ea.name.toLowerCase() === candidateName.toLowerCase()
            );
            if (match) return match.name;
        }
    }

    // Fall back to a QuickPick
    const items = eaList.map(ea => ({
        label: ea.name,
        description: `${ea.runCount} run${ea.runCount !== 1 ? 's' : ''}`,
        detail: ea.latestLog ? `Latest: ${ea.latestLog.name}` : undefined,
    }));
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select EA to backtest',
    });
    return pick ? pick.label : null;
}

// ---------------------------------------------------------------------------
// Parameter collection
// ---------------------------------------------------------------------------

/**
 * @param {string} eaName
 * @param {number} port
 * @returns {Promise<{symbol:string, fromDate:string, toDate:string, riskPercentage:number}|null>}
 */
async function getTestParameters(eaName, port) {
    // Fetch defaults from tester.ini via the server
    let defaults = { symbol: '', fromDate: '', toDate: '', riskPercentage: 5.0 };
    try {
        const { statusCode, data } = await httpRequest('GET', `/api/${encodeURIComponent(eaName)}/tester-config`, null, port);
        if (statusCode === 200 && data) {
            defaults = { ...defaults, ...data };
        }
    } catch { /* use fallback defaults */ }

    // Fetch available symbols
    let symbols = [];
    try {
        const { statusCode, data } = await httpRequest('GET', '/api/symbols', null, port);
        if (statusCode === 200 && Array.isArray(data)) symbols = data;
    } catch { /* proceed without symbol list */ }

    // Symbol picker
    let symbolItems;
    if (symbols.length > 0) {
        symbolItems = symbols.map(s => ({
            label: s,
            picked: s === defaults.symbol,
        }));
    } else if (defaults.symbol) {
        symbolItems = [{ label: defaults.symbol, picked: true }];
    }

    let symbol = defaults.symbol;
    if (symbolItems && symbolItems.length > 0) {
        const symbolPick = await vscode.window.showQuickPick(symbolItems, {
            placeHolder: `Symbol (default: ${defaults.symbol || 'none'})`,
        });
        if (!symbolPick) return null; // cancelled
        symbol = symbolPick.label;
    } else {
        const input = await vscode.window.showInputBox({
            prompt: 'Symbol',
            value: defaults.symbol,
        });
        if (input === undefined) return null;
        symbol = input;
    }

    // Date range
    const fromDate = await vscode.window.showInputBox({
        prompt: 'From date (YYYY.MM.DD)',
        value: defaults.fromDate,
        validateInput: v => /^\d{4}\.\d{2}\.\d{2}$/.test(v) ? null : 'Format: YYYY.MM.DD',
    });
    if (fromDate === undefined) return null;

    const toDate = await vscode.window.showInputBox({
        prompt: 'To date (YYYY.MM.DD)',
        value: defaults.toDate,
        validateInput: v => /^\d{4}\.\d{2}\.\d{2}$/.test(v) ? null : 'Format: YYYY.MM.DD',
    });
    if (toDate === undefined) return null;

    return {
        symbol,
        fromDate,
        toDate,
        riskPercentage: defaults.riskPercentage,
    };
}

// ---------------------------------------------------------------------------
// Execute & monitor
// ---------------------------------------------------------------------------

/**
 * @param {string} eaName
 * @param {{symbol:string, fromDate:string, toDate:string, riskPercentage:number}} params
 * @param {number} port
 * @returns {Promise<boolean>} true if completed successfully
 */
async function executeBacktest(eaName, params, port) {
    // Launch the test
    try {
        const { statusCode, data } = await httpRequest(
            'POST',
            `/api/${encodeURIComponent(eaName)}/run-test`,
            params,
            port,
        );
        if (statusCode === 409) {
            vscode.window.showWarningMessage(`A test is already running for ${eaName}.`);
            return false;
        }
        if (statusCode !== 200) {
            const msg = (data && data.error) || `Server returned ${statusCode}`;
            vscode.window.showErrorMessage(`Failed to start backtest: ${msg}`);
            return false;
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to start backtest: ${err.message}`);
        return false;
    }

    // Monitor with progress notification
    const completed = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Backtest: ${eaName} on ${params.symbol}`,
            cancellable: true,
        },
        async (progress, token) => {
            const startTime = Date.now();
            progress.report({ message: 'Starting...' });

            while (!token.isCancellationRequested) {
                const elapsed = Date.now() - startTime;
                if (elapsed > MAX_POLL_TIME_MS) {
                    vscode.window.showWarningMessage('Backtest monitoring timed out (10 min). The test may still be running in MT5.');
                    return false;
                }

                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

                try {
                    const { statusCode, data } = await httpRequest(
                        'GET',
                        `/api/${encodeURIComponent(eaName)}/test-status`,
                        null,
                        port,
                    );
                    if (statusCode === 200 && data && !data.running) {
                        return true; // done
                    }
                } catch { /* server hiccup — keep polling */ }

                const secs = Math.round((Date.now() - startTime) / 1000);
                progress.report({ message: `Running... (${secs}s)` });
            }
            return false; // cancelled
        },
    );

    return completed;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a backtest for the current EA.
 * @param {vscode.ExtensionContext} context
 * @param {object} opts
 * @param {Function} opts.findMql5Root  Returns the MQL5 root directory or null
 * @param {Function} opts.resolveCompileTargets  From compileTargetResolver
 */
async function runBacktest(context, opts) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const port = config.get('Backtest.ServerPort', DEFAULT_PORT);
    const autoStart = config.get('Backtest.AutoStartServer', true);
    const promptParams = config.get('Backtest.PromptForParameters', true);
    const autoOpen = config.get('Backtest.AutoOpenReport', true);

    // 1. Ensure server is alive
    let alive = await pingServer(port);
    if (!alive && autoStart) {
        const mql5Root = opts.findMql5Root();
        if (!mql5Root) {
            vscode.window.showErrorMessage(
                'Cannot find MQL5 folder. Please configure your MQL Include directory setting.',
            );
            return;
        }
        const serverDir = path.join(mql5Root, 'Tools', 'TradeReportServer');
        alive = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Starting TradeReportServer...' },
            () => startServer(serverDir, port),
        );
    }
    if (!alive) {
        vscode.window.showErrorMessage(
            'TradeReportServer is not running. Start it manually or check settings.',
        );
        return;
    }

    // 2. Resolve EA
    const eaName = await resolveEAName(context, port, opts.resolveCompileTargets);
    if (!eaName) return;

    // 3. Collect parameters
    let params;
    if (promptParams) {
        params = await getTestParameters(eaName, port);
        if (!params) return; // cancelled
    } else {
        // Use defaults from tester.ini silently
        try {
            const { statusCode, data } = await httpRequest(
                'GET',
                `/api/${encodeURIComponent(eaName)}/tester-config`,
                null,
                port,
            );
            if (statusCode === 200 && data) {
                params = {
                    symbol: data.symbol,
                    fromDate: data.fromDate,
                    toDate: data.toDate,
                    riskPercentage: data.riskPercentage || 5.0,
                };
            }
        } catch { /* fall through */ }
        if (!params) {
            vscode.window.showErrorMessage(`No tester.ini defaults found for ${eaName}. Enable parameter prompts.`);
            return;
        }
    }

    // 4. Execute
    const completed = await executeBacktest(eaName, params, port);

    // 5. Auto-open report
    if (completed && autoOpen) {
        vscode.commands.executeCommand('mql_tools.openTradeReport');
    }
}

module.exports = { runBacktest, stopServer };
