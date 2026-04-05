'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { parseLogFile } = require('./logParser');

/**
 * Manages the Trade Report WebviewPanel.
 * Displays parsed MT5 tester log data with clickable log-line navigation.
 */
class TradeReportPanel {
    static currentPanel = null;
    static viewType = 'mqlTradeReport';

    /**
     * Show or create the trade report panel.
     * @param {vscode.ExtensionContext} context
     * @param {object} parsedData - Output of logParser.parseLogFile()
     * @param {string} logFilePath - Absolute path to the source .log file
     */
    static async createOrShow(context, parsedData, logFilePath) {
        const column = vscode.ViewColumn.Beside;

        if (TradeReportPanel.currentPanel) {
            TradeReportPanel.currentPanel._panel.reveal(column);
            await TradeReportPanel.currentPanel._setData(parsedData, logFilePath);
            return TradeReportPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            TradeReportPanel.viewType,
            'MQL Trade Report',
            column,
            { enableScripts: true }
        );

        TradeReportPanel.currentPanel = new TradeReportPanel(panel, context, parsedData, logFilePath);
        return TradeReportPanel.currentPanel;
    }

    constructor(panel, context, parsedData, logFilePath) {
        this._panel = panel;
        this._context = context;
        this._isDisposing = false;
        this._logFilePath = logFilePath;
        this._eaName = parsedData.eaName;
        this._eaFile = parsedData.testConfig ? parsedData.testConfig.eaFile : null;
        this._disposables = [];
        this._fileCache = new Map();
        this._snapshotDir = null;

        this._buildSourceMapPromise = this._buildSourceMap();
        this._buildSourceMapPromise
            .then(() => this._ensureSnapshot(parsedData))
            .catch(err => { console.error('Failed to initialize source map or snapshot', err); });
        this._panel.webview.html = this._getHtml(parsedData);

        this._panel.webview.onDidReceiveMessage(async msg => {
            switch (msg.type) {
                case 'openLine': {
                    const uri = vscode.Uri.file(this._logFilePath);
                    const line = Math.max(0, msg.lineNumber - 1);
                    vscode.workspace.openTextDocument(uri).then(doc => {
                        vscode.window.showTextDocument(doc, {
                            viewColumn: vscode.ViewColumn.One,
                            selection: new vscode.Range(line, 0, line, 0),
                            preserveFocus: false
                        });
                    }).catch(err => {
                        vscode.window.showErrorMessage(`Failed to open log file: ${err.message}`);
                    }); break;
                }
                case 'refresh': {
                    await this._buildSourceMapPromise;
                    try {
                        const fresh = parseLogFile(this._logFilePath);
                        this._ensureSnapshot(fresh).catch(err => {
                            console.error('Failed to create source snapshot', err);
                        });
                        this._panel.webview.postMessage({
                            type: 'fullUpdate',
                            trades: fresh.trades,
                            allEntries: fresh.allEntries,
                            summary: fresh.summary,
                            testConfig: fresh.testConfig,
                            eaName: fresh.eaName,
                            hasSnapshot: !!this._snapshotDir
                        });
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to re-parse log: ${e.message}`);
                    }
                    break;
                }
                case 'openSource': {
                    this._openSource(msg.file, msg.line, msg.target || 'live');
                    break;
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    async _setData(parsedData, logFilePath) {
        this._logFilePath = logFilePath;
        const eaChanged = parsedData.eaName !== this._eaName;
        this._eaName = parsedData.eaName;
        this._eaFile = parsedData.testConfig ? parsedData.testConfig.eaFile : null;
        this._snapshotDir = null;
        // Only rebuild the source map when the EA changes or the cache is empty.
        // Re-using the existing cache on plain Refresh avoids a full workspace scan.
        if (eaChanged || this._fileCache.size === 0) {
            this._buildSourceMapPromise = this._buildSourceMap();
        }
        await this._buildSourceMapPromise;
        this._ensureSnapshot(parsedData).catch(err => {
            console.error('Failed to create source snapshot', err);
        });
        this._panel.webview.postMessage({
            type: 'fullUpdate',
            trades: parsedData.trades,
            allEntries: parsedData.allEntries,
            summary: parsedData.summary,
            testConfig: parsedData.testConfig,
            eaName: parsedData.eaName,
            hasSnapshot: !!this._snapshotDir
        });
    }

    async _buildSourceMap() {
        this._fileCache.clear();
        try {
            const uris = await vscode.workspace.findFiles('**/*.{mq4,mq5,mqh}', '**/node_modules/**');
            for (const uri of uris) {
                const basename = path.basename(uri.fsPath);
                if (!this._fileCache.has(basename)) {
                    this._fileCache.set(basename, []);
                }
                const cache = this._fileCache.get(basename);
                if (!cache.some(u => u.fsPath === uri.fsPath)) {
                    cache.push(uri);
                }
            }
        } catch (e) {
            console.error('Failed to build MQL source map', e);
        }
    }

    /**
     * Resolve a filename (possibly including directory parts) to a workspace URI.
     * Uses the file cache and additional context to disambiguate.
     */
    _resolveUri(filename) {
        if (!filename) return null;
        const basename = path.basename(filename);
        const candidates = this._fileCache.get(basename);
        if (!candidates || candidates.length === 0) return null;

        if (candidates.length === 1) return candidates[0];

        // Multiple candidates, try to match by path suffix (e.g. "Include/File.mqh")
        const normalizedFilename = filename.replace(/\\/g, '/');
        for (const uri of candidates) {
            if (uri.fsPath.replace(/\\/g, '/').endsWith(normalizedFilename)) {
                return uri;
            }
        }

        // Try to match using EA name or EA file path as a hint
        if (this._eaName) {
            const eaNameLower = this._eaName.toLowerCase();
            const match = candidates.find(u => {
                const name = path.parse(u.fsPath).name.toLowerCase();
                return name === eaNameLower || (name.startsWith(eaNameLower) && !/[a-z0-9]/.test(name[eaNameLower.length]));
            });
            if (match) return match;
        }
        if (this._eaFile) {
            const eaBasenameLower = path.basename(this._eaFile, path.extname(this._eaFile)).toLowerCase();
            const match = candidates.find(u => {
                const name = path.parse(u.fsPath).name.toLowerCase();
                return name === eaBasenameLower;
            });
            if (match) return match;
        }

        return candidates[0];
    }

    /**
     * Compute the snapshot directory for the current log file.
     * Layout: <logDir>/snapshot/<logBaseName>/
     */
    _snapshotDirForLog(logFilePath) {
        const logDir = path.dirname(logFilePath);
        const logBase = path.basename(logFilePath, path.extname(logFilePath));
        return path.join(logDir, 'snapshot', logBase);
    }

    /**
     * If SnapshotSources is enabled and no snapshot exists yet, copy all
     * referenced source files into the snapshot directory.
     * If a snapshot already exists (from a previous open), just record its path.
     */
    async _ensureSnapshot(parsedData) {
        const snapDir = this._snapshotDirForLog(this._logFilePath);

        // If snapshot already exists, just record it
        try {
            await fs.promises.access(snapDir);
            this._snapshotDir = snapDir;
            this._panel.webview.postMessage({ type: 'snapshotStatus', hasSnapshot: true });
            return;
        } catch { /* doesn't exist yet */ }

        // Check setting
        const config = vscode.workspace.getConfiguration('mql_tools');
        if (!config.get('TradeReport.SnapshotSources')) return;

        // Collect unique source filenames referenced in trades + log entries
        const sourceFiles = new Set();
        for (const t of parsedData.trades) {
            if (t.orderSourceFile) sourceFiles.add(t.orderSourceFile);
            if (t.exitSourceFile) sourceFiles.add(t.exitSourceFile);
        }
        for (const e of parsedData.allEntries) {
            if (e.sourceFile) sourceFiles.add(e.sourceFile);
        }
        if (sourceFiles.size === 0) return;

        // Resolve each filename to its workspace path and copy
        const MAX_SNAPSHOT_FILES = 500;
        const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024; // 50 MB total
        try {
            await fs.promises.mkdir(snapDir, { recursive: true });
            let copied = 0;
            let totalBytes = 0;
            for (const filename of sourceFiles) {
                if (copied >= MAX_SNAPSHOT_FILES) break;
                const uri = this._resolveUri(filename);
                if (!uri) continue;
                let stat;
                try { stat = await fs.promises.stat(uri.fsPath); } catch { continue; }
                if (totalBytes + stat.size > MAX_SNAPSHOT_BYTES) continue;

                // Sanitize to retain folder structure without path traversal
                const sanitized = this._sanitizeRelativePath(filename);
                const destPath = path.join(snapDir, sanitized);

                // Final validation: ensure the path did not escape snapDir
                const relative = path.relative(snapDir, destPath);
                if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

                await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
                await fs.promises.copyFile(uri.fsPath, destPath);
                copied++;
                totalBytes += stat.size;
            }
            if (copied > 0) {
                this._snapshotDir = snapDir;
                this._panel.webview.postMessage({ type: 'snapshotStatus', hasSnapshot: true });
            } else {
                // Clean up empty dir
                try { await fs.promises.rmdir(snapDir); } catch { /* ignore */ }
            }
        } catch (e) {
            console.error('Failed to create source snapshot', e);
        }
    }

    /**
     * Open a source file at the given line.
     * @param {'live'|'snapshot'} target - Whether to open the live workspace file or the snapshot copy
     */
    async _openSource(filename, lineNumber, target) {
        const line = Math.max(0, lineNumber - 1);

        // Snapshot target
        if (target === 'snapshot' && this._snapshotDir) {
            const sanitized = this._sanitizeRelativePath(filename);
            const snapFile = path.join(this._snapshotDir, sanitized);

            // Final validation: ensure the path did not escape snapshotDir
            const relative = path.relative(this._snapshotDir, snapFile);
            if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(snapFile)) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(snapFile));
                await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One,
                    selection: new vscode.Range(line, 0, line, 0),
                    preserveFocus: false
                });
                return;
            }
            // Fallback to live if snapshot file missing
        }

        // Live target (original behavior)
        let uri = this._resolveUri(filename);
        if (!uri) {
            const escapedFilename = this._escapeGlob(filename);
            const uris = await vscode.workspace.findFiles(`**/${escapedFilename}`, null, 1);
            if (uris && uris.length > 0) {
                uri = uris[0];
                const b = path.basename(uri.fsPath);
                if (!this._fileCache.has(b)) this._fileCache.set(b, []);
                const cache = this._fileCache.get(b);
                if (!cache.some(u => u.fsPath === uri.fsPath)) {
                    cache.push(uri);
                }
            }
        }

        if (uri) {
            vscode.workspace.openTextDocument(uri).then(doc => {
                vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One,
                    selection: new vscode.Range(line, 0, line, 0),
                    preserveFocus: false
                });
            }).catch(err => {
                vscode.window.showWarningMessage(`Could not open source file: ${err.message}`);
            });
        } else {
            vscode.window.showWarningMessage(`Could not find source file: ${filename}`);
        }
    }

    /**
     * Sanitize a filename to be used as a relative path within a snapshot.
     * Resolves internal dot segments and strips leading traversal/roots.
     */
    _sanitizeRelativePath(filename) {
        if (!filename) return '';
        // 1. Normalize early to let the OS resolver handle dot segments (e.g., "foo/../bar" -> "bar")
        let sanitized = path.normalize(filename);

        // 2. Repeatedly strip leading traversal or absolute roots
        let previous;
        do {
            previous = sanitized;
            // Remove leading slashes/backslashes and Windows drive letters
            sanitized = sanitized.replace(/^[\\\/]+/, '').replace(/^[a-zA-Z]:/, '');
            // Remove leading ".." path segments only
            sanitized = sanitized.replace(/^\.\.(?:[\\\/]|$)/, '');
        } while (sanitized !== previous && sanitized !== '');

        return sanitized;
    }

    _escapeGlob(pattern) {
        return pattern.replace(/[*?[\]{}]/g, '[$&]');
    }

    dispose() {
        if (this._isDisposing) return;
        this._isDisposing = true;
        TradeReportPanel.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    _getHtml(data) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const safeJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MQL Trade Report</title>
<style>
:root {
    --bg: var(--vscode-editor-background, #1e1e2e);
    --surface: var(--vscode-sideBar-background, #282840);
    --surface2: var(--vscode-input-background, #313150);
    --text: var(--vscode-editor-foreground, #cdd6f4);
    --text-dim: var(--vscode-descriptionForeground, #6c7086);
    --green: var(--vscode-charts-green, #a6e3a1);
    --red: var(--vscode-charts-red, #f38ba8);
    --blue: var(--vscode-charts-blue, #89b4fa);
    --yellow: var(--vscode-charts-yellow, #f9e2af);
    --border: var(--vscode-panel-border, #45475a);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    background: var(--bg);
    color: var(--text);
    padding: 16px;
    font-size: 13px;
}
.toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
}
.toolbar button {
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}
.toolbar button:hover { background: var(--border); }

.meta-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 16px;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
}
.meta-bar span { white-space: nowrap; }
.meta-bar .val { color: var(--text); font-weight: 600; }

.cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
}
.card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    text-align: center;
}
.card .label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
}
.card .value {
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
.positive { color: var(--green); }
.negative { color: var(--red); }
.neutral  { color: var(--blue); }

h2 {
    font-size: 14px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin: 20px 0 10px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 6px;
}

table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}
th {
    background: var(--surface2);
    color: var(--text-dim);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
    padding: 8px 10px;
    text-align: left;
    position: sticky;
    top: 0;
}
td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
}
tr:hover td { background: var(--surface); }
.type-buy  { color: var(--blue); }
.type-sell { color: var(--red); }

.log-link {
    display: inline-block;
    background: var(--surface2);
    color: var(--blue);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    cursor: pointer;
    text-decoration: none;
    font-family: monospace;
}
.log-link:hover {
    background: var(--border);
    color: var(--text);
}

.src-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(249, 226, 175, 0.12);
    color: var(--yellow);
    border: 1px solid rgba(249, 226, 175, 0.35);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    text-decoration: none;
    font-family: monospace;
    flex-shrink: 0;
    transition: background 0.15s, border-color 0.15s;
}
.src-link::before {
    content: '\u{1F4C4}';
    font-size: 10px;
}
.src-link:hover {
    background: rgba(249, 226, 175, 0.25);
    border-color: var(--yellow);
    color: var(--vscode-editor-foreground, #fff);
}
.src-link.src-snapshot {
    background: rgba(166, 227, 161, 0.12);
    color: var(--green);
    border-color: rgba(166, 227, 161, 0.35);
}
.src-link.src-snapshot::before {
    content: '\u{1F4CB}';
}
.src-link.src-snapshot:hover {
    background: rgba(166, 227, 161, 0.25);
    border-color: var(--green);
    color: var(--vscode-editor-foreground, #fff);
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.src-pair {
    display: inline-flex;
    gap: 4px;
    align-items: center;
}

/* Prominent source column in trades table */
.src-cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.src-cell .src-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--text-dim);
    margin-bottom: -2px;
}
.src-cell .src-link {
    margin-left: 0;
}

.empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-dim);
}
.empty-state h3 { font-size: 16px; margin-bottom: 8px; color: var(--text); }
.empty-state p { font-size: 13px; line-height: 1.6; }

/* Log entries section */
.log-section {
    max-height: 400px;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    font-family: monospace;
    font-size: 11px;
    margin-bottom: 16px;
}
.log-entry {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 2px 4px;
    border-radius: 3px;
    cursor: pointer;
}
.log-entry:hover { background: var(--surface2); }
.log-entry .ln {
    color: var(--text-dim);
    min-width: 40px;
    text-align: right;
    flex-shrink: 0;
    user-select: none;
}
.log-entry .lvl {
    min-width: 42px;
    font-weight: 600;
    flex-shrink: 0;
}
.log-entry .msg { word-break: break-all; }
.lvl-INFO  { color: var(--blue); }
.lvl-TRADE { color: var(--green); }
.lvl-DEBUG { color: var(--text-dim); }
.lvl-ERROR { color: var(--red); }
.lvl-WARN  { color: var(--yellow); }

.filter-bar {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
}
.filter-btn {
    background: var(--surface2);
    color: var(--text-dim);
    border: 1px solid var(--border);
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
}
.filter-btn.active {
    background: var(--border);
    color: var(--text);
}
.filter-btn:hover { background: var(--border); }

.toolbar button:focus-visible, .filter-btn:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
}
.src-link:focus-visible {
    outline: 2px solid var(--yellow);
    outline-offset: 2px;
}
.src-link.src-snapshot:focus-visible {
    outline-color: var(--green);
}
.log-entry:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: -1px;
    background: var(--surface2);
}
.log-link:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
}
</style>
</head>
<body>

<div class="toolbar">
    <div style="font-size:16px; font-weight:600;">Trade Report</div>
    <button type="button" data-action="refresh">Reload</button>
</div>

<div class="meta-bar" id="metaBar"></div>
<div class="cards" id="summaryCards"></div>

<h2>Trades</h2>
<div id="tradesSection"></div>

<h2>Log <span id="logCount" style="font-size:11px;font-weight:400;color:var(--text-dim)"></span></h2>
<div class="filter-bar" id="filterBar"></div>
<div class="log-section" id="logSection"></div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let trades = ${safeJson(data.trades)};
    let allEntries = ${safeJson(data.allEntries)};
    let summary = ${safeJson(data.summary)};
    let testConfig = ${safeJson(data.testConfig)};
    let eaName = ${safeJson(data.eaName)};
    let hasSnapshot = ${safeJson(!!this._snapshotDir)};
    let currentFilter = 'ALL';

    function refresh() { vscode.postMessage({ type: 'refresh' }); }

    function handleNavigation(target) {
        var srcEl = target.closest('[data-src-file]');
        if (srcEl) {
            var srcTarget = srcEl.dataset.srcTarget || 'live';
            vscode.postMessage({ type: 'openSource', file: srcEl.dataset.srcFile, line: parseInt(srcEl.dataset.srcLine, 10), target: srcTarget });
            return true;
        }
        var logLink = target.closest('[data-log-line]');
        if (logLink) {
            vscode.postMessage({ type: 'openLine', lineNumber: parseInt(logLink.dataset.logLine, 10) });
            return true;
        }
        var logEntry = target.closest('.log-entry');
        if (logEntry && logEntry.dataset.line) {
            vscode.postMessage({ type: 'openLine', lineNumber: parseInt(logEntry.dataset.line, 10) });
            return true;
        }
        return false;
    }

    // Event delegation for all clickable elements
    document.addEventListener('click', function(e) {
        var actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
            if (actionBtn.dataset.action === 'refresh') refresh();
            return;
        }
        if (handleNavigation(e.target)) {
            e.stopPropagation();
            return;
        }
        var filterBtn = e.target.closest('[data-filter]');
        if (filterBtn) {
            setFilter(filterBtn.dataset.filter);
            return;
        }
    });

    document.addEventListener('keydown', function(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (handleNavigation(e.target)) {
            e.preventDefault();
        }
    });

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function pnlClass(v) { return v >= 0 ? 'positive' : 'negative'; }
    function fmt(v, d) { d = d === undefined ? 2 : d; return Number(v || 0).toFixed(d); }

    function srcLinkHtml(file, line, label, showSnapshot) {
        var liveLink = '<span class="src-link" tabindex="0" role="button" data-src-file="' + esc(file) + '" data-src-line="' + line + '" data-src-target="live" title="Open current source: ' + esc(file) + ' line ' + line + '">' + esc(label) + '</span>';
        if (!showSnapshot) return liveLink;
        var snapLink = '<span class="src-link src-snapshot" tabindex="0" role="button" data-src-file="' + esc(file) + '" data-src-line="' + line + '" data-src-target="snapshot" title="Open snapshot (frozen at test time): ' + esc(file) + ' line ' + line + '">' + esc(label) + '</span>';
        return '<span class="src-pair">' + snapLink + liveLink + '</span>';
    }

    function renderMeta() {
        document.getElementById('metaBar').innerHTML =
            '<span>EA: <span class="val">' + esc(eaName) + '</span></span>' +
            '<span>Symbol: <span class="val">' + esc(testConfig.symbol) + '</span></span>' +
            '<span>TF: <span class="val">' + esc(testConfig.timeframe) + '</span></span>' +
            '<span>Period: <span class="val">' + esc(testConfig.from) + ' &mdash; ' + esc(testConfig.to) + '</span></span>' +
            '<span>Deposit: <span class="val">' + esc(testConfig.initialDeposit) + '</span></span>' +
            '<span>Leverage: <span class="val">' + esc(testConfig.leverage) + '</span></span>' +
            '<span>Model: <span class="val">' + esc(testConfig.testModel) + '</span></span>';
    }

    function renderCards() {
        var s = summary;
        var pc = s.netPnl >= 0 ? 'positive' : 'negative';
        document.getElementById('summaryCards').innerHTML =
            '<div class="card"><div class="label">Trades</div><div class="value neutral">' + s.tradeCount + '</div></div>' +
            '<div class="card"><div class="label">Net P&L</div><div class="value ' + pc + '">' + (s.netPnl >= 0 ? '+' : '') + fmt(s.netPnl) + '</div></div>' +
            '<div class="card"><div class="label">Win Rate</div><div class="value neutral">' + fmt(s.winRate, 1) + '%</div></div>' +
            '<div class="card"><div class="label">Gross Profit</div><div class="value positive">+' + fmt(s.grossProfit) + '</div></div>' +
            '<div class="card"><div class="label">Gross Loss</div><div class="value negative">' + fmt(s.grossLoss) + '</div></div>' +
            '<div class="card"><div class="label">Commission</div><div class="value neutral">' + fmt(s.commission) + '</div></div>';
    }

    function renderTable() {
        if (!trades.length) {
            document.getElementById('tradesSection').innerHTML =
                '<div class="empty-state"><h3>No trades found</h3><p>This log file does not contain any parsed trades.</p></div>';
            return;
        }
        var h = '<table><caption class="sr-only">Trade details</caption><thead><tr>' +
            '<th scope="col">#</th><th scope="col">Type</th><th scope="col">Entry</th><th scope="col">SL</th><th scope="col">TP</th><th scope="col">Lots</th>' +
            '<th scope="col">Close</th><th scope="col">Exit</th><th scope="col">P&amp;L</th><th scope="col">Net</th><th scope="col">Source</th><th scope="col">Log</th>' +
            '</tr></thead><tbody>';
        trades.forEach(function(t, i) {
            var cls = t.type === 'buy' ? 'type-buy' : 'type-sell';
            var pc = (t.netPnl || 0) >= 0 ? 'positive' : 'negative';

            // Source column — prominent clickable links to MQL code
            var srcHtml = '<div class="src-cell">';
            if (t.orderSourceFile && t.orderSourceLine) {
                var entryLabel = t.orderSourceFunc ? t.orderSourceFunc + ':' + t.orderSourceLine : t.orderSourceFile + ':' + t.orderSourceLine;
                srcHtml += '<div><span class="src-label">entry</span></div>' +
                    srcLinkHtml(t.orderSourceFile, t.orderSourceLine, entryLabel, hasSnapshot);
            }
            if (t.exitSourceFile && t.exitSourceLine) {
                var exitLabel = t.exitSourceFunc ? t.exitSourceFunc + ':' + t.exitSourceLine : t.exitSourceFile + ':' + t.exitSourceLine;
                srcHtml += '<div style="margin-top:4px"><span class="src-label">exit</span></div>' +
                    srcLinkHtml(t.exitSourceFile, t.exitSourceLine, exitLabel, hasSnapshot);
            }
            if (!t.orderSourceFile && !t.exitSourceFile) {
                srcHtml += '<span style="color:var(--text-dim);font-size:10px">no source info</span>';
            }
            srcHtml += '</div>';

            h += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td class="' + cls + '">' + esc((t.type || '').toUpperCase()) + '</td>' +
                '<td>' + fmt(t.entryPrice, 5) + '</td>' +
                '<td>' + fmt(t.sl, 5) + '</td>' +
                '<td>' + fmt(t.tp, 5) + '</td>' +
                '<td>' + fmt(t.lots) + '</td>' +
                '<td>' + fmt(t.closePrice, 5) + '</td>' +
                '<td>' + esc(t.exitReason || '') + '</td>' +
                '<td class="' + pc + '">' + ((t.grossPnl || 0) >= 0 ? '+' : '') + fmt(t.grossPnl) + '</td>' +
                '<td class="' + pc + '">' + ((t.netPnl || 0) >= 0 ? '+' : '') + fmt(t.netPnl) + '</td>' +
                '<td>' + srcHtml + '</td>' +
                '<td>' +
                    '<span class="log-link" tabindex="0" role="button" data-log-line="' + t.orderLine + '" title="Go to order line in log">L' + t.orderLine + '</span>' +
                    (t.exitLine ? ' <span class="log-link" tabindex="0" role="button" data-log-line="' + t.exitLine + '" title="Go to exit line in log">L' + t.exitLine + '</span>' : '') +
                '</td>' +
                '</tr>';
        });
        h += '</tbody></table>';
        document.getElementById('tradesSection').innerHTML = h;
    }

    function renderFilters() {
        var levels = ['ALL', 'TRADE', 'INFO', 'WARN', 'DEBUG', 'ERROR'];
        var h = '';
        levels.forEach(function(lv) {
            var active = currentFilter === lv ? ' active' : '';
            var pressed = currentFilter === lv ? 'true' : 'false';
            h += '<button class="filter-btn' + active + '" data-filter="' + lv + '" aria-pressed="' + pressed + '">' + lv + '</button>';
        });
        document.getElementById('filterBar').innerHTML = h;
    }

    function setFilter(lv) {
        currentFilter = lv;
        renderFilters();
        renderLog();
    }

    function renderLog() {
        var filtered = currentFilter === 'ALL'
            ? allEntries
            : allEntries.filter(function(e) { return e.level === currentFilter; });

        document.getElementById('logCount').textContent = '(' + filtered.length + ' of ' + allEntries.length + ')';

        // Limit rendered entries for performance
        var max = 2000;
        var entries = filtered.length > max ? filtered.slice(0, max) : filtered;
        var h = '';
        entries.forEach(function(e) {
            var srcSpan = '';
            if (e.sourceFile && e.sourceLine) {
                var srcLabel = e.sourceFunc ? e.sourceFunc + ':' + e.sourceLine : e.sourceFile + ':' + e.sourceLine;
                srcSpan = srcLinkHtml(e.sourceFile, e.sourceLine, srcLabel, hasSnapshot);
            }
            h += '<div class="log-entry" tabindex="0" role="button" data-line="' + e.lineNumber + '">' +
                '<span class="ln">' + e.lineNumber + '</span>' +
                '<span class="lvl lvl-' + e.level + '">' + e.level + '</span>' +
                srcSpan +
                '<span class="msg">' + esc(e.message) + '</span>' +
                '</div>';
        });
        if (filtered.length > max) {
            h += '<div style="text-align:center;padding:8px;color:var(--text-dim)">Showing first ' + max + ' of ' + filtered.length + ' entries</div>';
        }
        document.getElementById('logSection').innerHTML = h;
    }

    function renderAll() {
        renderMeta();
        renderCards();
        renderTable();
        renderFilters();
        renderLog();
    }

    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'fullUpdate') {
            trades = msg.trades || [];
            allEntries = msg.allEntries || [];
            summary = msg.summary || {};
            testConfig = msg.testConfig || {};
            eaName = msg.eaName || '';
            if (msg.hasSnapshot !== undefined) hasSnapshot = msg.hasSnapshot;
            renderAll();
        }
        if (msg.type === 'snapshotStatus') {
            hasSnapshot = msg.hasSnapshot;
            // Only re-render the sections that contain source links
            renderTable();
            renderLog();
        }
    });

    renderAll();
</script>
</body>
</html>`;
    }
}

module.exports = { TradeReportPanel };
