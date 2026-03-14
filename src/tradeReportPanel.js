'use strict';
const vscode = require('vscode');
const path = require('path');
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
    static createOrShow(context, parsedData, logFilePath) {
        const column = vscode.ViewColumn.Beside;

        if (TradeReportPanel.currentPanel) {
            TradeReportPanel.currentPanel._panel.reveal(column);
            TradeReportPanel.currentPanel._setData(parsedData, logFilePath);
            return TradeReportPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            TradeReportPanel.viewType,
            'MQL Trade Report',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        TradeReportPanel.currentPanel = new TradeReportPanel(panel, context, parsedData, logFilePath);
        return TradeReportPanel.currentPanel;
    }

    constructor(panel, context, parsedData, logFilePath) {
        this._panel = panel;
        this._context = context;
        this._logFilePath = logFilePath;
        this._disposables = [];
        this._fileCache = new Map();

        this._buildSourceMap();

        this._panel.webview.html = this._getHtml(parsedData);

        this._panel.webview.onDidReceiveMessage(msg => {
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
                    });
                    break;
                }
                case 'refresh': {
                    try {
                        const fresh = parseLogFile(this._logFilePath);
                        this._panel.webview.postMessage({
                            type: 'fullUpdate',
                            trades: fresh.trades,
                            allEntries: fresh.allEntries,
                            summary: fresh.summary,
                            testConfig: fresh.testConfig,
                            eaName: fresh.eaName
                        });
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to re-parse log: ${e.message}`);
                    }
                    break;
                }
                case 'openSource': {
                    this._openSource(msg.file, msg.line);
                    break;
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    _setData(parsedData, logFilePath) {
        this._logFilePath = logFilePath;
        this._panel.webview.postMessage({
            type: 'fullUpdate',
            trades: parsedData.trades,
            allEntries: parsedData.allEntries,
            summary: parsedData.summary,
            testConfig: parsedData.testConfig,
            eaName: parsedData.eaName
        });
    }

    async _buildSourceMap() {
        try {
            const uris = await vscode.workspace.findFiles('**/*.{mq4,mq5,mqh}', '**/node_modules/**');
            for (const uri of uris) {
                const basename = path.basename(uri.fsPath);
                if (!this._fileCache.has(basename)) {
                    this._fileCache.set(basename, uri);
                }
            }
        } catch (e) {
            console.error('Failed to build MQL source map', e);
        }
    }

    async _openSource(filename, lineNumber) {
        const line = Math.max(0, lineNumber - 1);
        let uri = this._fileCache.get(filename);
        
        if (!uri) {
            const uris = await vscode.workspace.findFiles(`**/${filename}`, null, 1);
            if (uris && uris.length > 0) {
                uri = uris[0];
                this._fileCache.set(filename, uri);
            }
        }

        if (uri) {
            vscode.workspace.openTextDocument(uri).then(doc => {
                vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One,
                    selection: new vscode.Range(line, 0, line, 0),
                    preserveFocus: false
                });
            });
        } else {
            vscode.window.showWarningMessage(`Could not find source file: ${filename}`);
        }
    }

    dispose() {
        TradeReportPanel.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    _getHtml(data) {
        const safeJson = (obj) => JSON.stringify(obj).replace(/<\//g, '<\\/');
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MQL Trade Report</title>
<style>
:root {
    --bg: #1e1e2e;
    --surface: #282840;
    --surface2: #313150;
    --text: #cdd6f4;
    --text-dim: #6c7086;
    --green: #a6e3a1;
    --red: #f38ba8;
    --blue: #89b4fa;
    --yellow: #f9e2af;
    --border: #45475a;
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
    color: #fff;
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
</style>
</head>
<body>

<div class="toolbar">
    <div style="font-size:16px; font-weight:600;">Trade Report</div>
    <button onclick="refresh()">Reload</button>
</div>

<div class="meta-bar" id="metaBar"></div>
<div class="cards" id="summaryCards"></div>

<h2>Trades</h2>
<div id="tradesSection"></div>

<h2>Log <span id="logCount" style="font-size:11px;font-weight:400;color:var(--text-dim)"></span></h2>
<div class="filter-bar" id="filterBar"></div>
<div class="log-section" id="logSection"></div>

<script>
    const vscode = acquireVsCodeApi();

    let trades = ${safeJson(data.trades)};
    let allEntries = ${safeJson(data.allEntries)};
    let summary = ${safeJson(data.summary)};
    let testConfig = ${safeJson(data.testConfig)};
    let eaName = ${safeJson(data.eaName)};
    let currentFilter = 'ALL';

    function refresh() { vscode.postMessage({ type: 'refresh' }); }

    // Event delegation for all clickable elements — avoids inline onclick with string escaping
    document.addEventListener('click', function(e) {
        var srcEl = e.target.closest('[data-src-file]');
        if (srcEl) {
            e.stopPropagation();
            vscode.postMessage({ type: 'openSource', file: srcEl.dataset.srcFile, line: parseInt(srcEl.dataset.srcLine, 10) });
            return;
        }
        var logLink = e.target.closest('[data-log-line]');
        if (logLink) {
            e.stopPropagation();
            vscode.postMessage({ type: 'openLine', lineNumber: parseInt(logLink.dataset.logLine, 10) });
            return;
        }
        var logEntry = e.target.closest('.log-entry');
        if (logEntry && logEntry.dataset.line) {
            vscode.postMessage({ type: 'openLine', lineNumber: parseInt(logEntry.dataset.line, 10) });
            return;
        }
        var filterBtn = e.target.closest('[data-filter]');
        if (filterBtn) {
            setFilter(filterBtn.dataset.filter);
            return;
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
            '<div class="card"><div class="label">Net P&L</div><div class="value ' + pc + '">' + fmt(s.netPnl) + '</div></div>' +
            '<div class="card"><div class="label">Win Rate</div><div class="value neutral">' + fmt(s.winRate, 1) + '%</div></div>' +
            '<div class="card"><div class="label">Gross Profit</div><div class="value positive">' + fmt(s.grossProfit) + '</div></div>' +
            '<div class="card"><div class="label">Gross Loss</div><div class="value negative">' + fmt(s.grossLoss) + '</div></div>' +
            '<div class="card"><div class="label">Commission</div><div class="value neutral">' + fmt(s.commission) + '</div></div>';
    }

    function renderTable() {
        if (!trades.length) {
            document.getElementById('tradesSection').innerHTML =
                '<div class="empty-state"><h3>No trades found</h3><p>This log file does not contain any parsed trades.</p></div>';
            return;
        }
        var h = '<table><thead><tr>' +
            '<th>#</th><th>Type</th><th>Entry</th><th>SL</th><th>TP</th><th>Lots</th>' +
            '<th>Close</th><th>Exit</th><th>P&L</th><th>Net</th><th>Source</th><th>Log</th>' +
            '</tr></thead><tbody>';
        trades.forEach(function(t, i) {
            var cls = t.type === 'buy' ? 'type-buy' : 'type-sell';
            var pc = (t.netPnl || 0) >= 0 ? 'positive' : 'negative';

            // Source column — prominent clickable links to MQL code
            var srcHtml = '<div class="src-cell">';
            if (t.orderSourceFile && t.orderSourceLine) {
                var entryLabel = t.orderSourceFunc ? t.orderSourceFunc + ':' + t.orderSourceLine : t.orderSourceFile + ':' + t.orderSourceLine;
                srcHtml += '<div><span class="src-label">entry</span></div>' +
                    '<span class="src-link" data-src-file="' + esc(t.orderSourceFile) + '" data-src-line="' + t.orderSourceLine + '" title="Open ' + esc(t.orderSourceFile) + ' line ' + t.orderSourceLine + '">' + esc(entryLabel) + '</span>';
            }
            if (t.exitSourceFile && t.exitSourceLine) {
                var exitLabel = t.exitSourceFunc ? t.exitSourceFunc + ':' + t.exitSourceLine : t.exitSourceFile + ':' + t.exitSourceLine;
                srcHtml += '<div style="margin-top:4px"><span class="src-label">exit</span></div>' +
                    '<span class="src-link" data-src-file="' + esc(t.exitSourceFile) + '" data-src-line="' + t.exitSourceLine + '" title="Open ' + esc(t.exitSourceFile) + ' line ' + t.exitSourceLine + '">' + esc(exitLabel) + '</span>';
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
                '<td class="' + pc + '">' + fmt(t.grossPnl) + '</td>' +
                '<td class="' + pc + '">' + fmt(t.netPnl) + '</td>' +
                '<td>' + srcHtml + '</td>' +
                '<td>' +
                    '<span class="log-link" data-log-line="' + t.orderLine + '" title="Go to order line in log">L' + t.orderLine + '</span>' +
                    (t.exitLine ? ' <span class="log-link" data-log-line="' + t.exitLine + '" title="Go to exit line in log">L' + t.exitLine + '</span>' : '') +
                '</td>' +
                '</tr>';
        });
        h += '</tbody></table>';
        document.getElementById('tradesSection').innerHTML = h;
    }

    function renderFilters() {
        var levels = ['ALL', 'TRADE', 'INFO', 'DEBUG', 'ERROR'];
        var h = '';
        levels.forEach(function(lv) {
            var active = currentFilter === lv ? ' active' : '';
            h += '<button class="filter-btn' + active + '" data-filter="' + lv + '">' + lv + '</button>';
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
                srcSpan = '<span class="src-link" data-src-file="' + esc(e.sourceFile) + '" data-src-line="' + e.sourceLine + '" title="Open ' + esc(e.sourceFile) + ' line ' + e.sourceLine + '">' + esc(srcLabel) + '</span>';
            }
            h += '<div class="log-entry" data-line="' + e.lineNumber + '">' +
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
            renderAll();
        }
    });

    renderAll();
</script>
</body>
</html>`;
    }
}

module.exports = { TradeReportPanel };
