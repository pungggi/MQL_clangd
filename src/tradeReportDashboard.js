'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { discoverEAs, parseLogSummary, parseLogFile } = require('./logParser');
const { TradeReportPanel } = require('./tradeReportPanel');

/**
 * Dashboard webview that discovers EAs and their test runs.
 * Clicking a run opens the full trade report panel.
 */
class TradeReportDashboard {
    static currentPanel = null;
    static viewType = 'mqlTradeReportDashboard';

    /**
     * @param {vscode.ExtensionContext} context
     * @param {string} expertsDir - Absolute path to MQL5/Experts
     */
    static createOrShow(context, expertsDir) {
        const column = vscode.ViewColumn.One;

        if (TradeReportDashboard.currentPanel) {
            TradeReportDashboard.currentPanel._panel.reveal(column);
            TradeReportDashboard.currentPanel._refresh(expertsDir);
            return TradeReportDashboard.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            TradeReportDashboard.viewType,
            'Trade Report Dashboard',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        TradeReportDashboard.currentPanel = new TradeReportDashboard(panel, context, expertsDir);
        return TradeReportDashboard.currentPanel;
    }

    constructor(panel, context, expertsDir) {
        this._panel = panel;
        this._context = context;
        this._expertsDir = expertsDir;
        this._disposables = [];

        const data = this._scan(expertsDir);
        this._panel.webview.html = this._getHtml(data);

        this._panel.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'openRun': {
                    this._openReport(msg.logPath);
                    break;
                }
                case 'openFile': {
                    this._openFilePicker();
                    break;
                }
                case 'refresh': {
                    this._refresh(this._expertsDir);
                    break;
                }
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    _scan(expertsDir) {
        let eas;
        try { eas = discoverEAs(expertsDir); } catch { eas = []; }
        // Quick-parse summary for each EA's runs (latest 10 per EA for speed)
        return eas.map(ea => {
            const runs = ea.runs.slice(0, 10).map(run => {
                let data;
                try {
                    const s = parseLogSummary(run.path);
                    data = { ...run, ...s };
                } catch {
                    data = { ...run, tradeCount: 0, netPnl: 0, winRate: 0, symbol: '?', from: '?', to: '?' };
                }
                // Check if a source snapshot exists for this run
                const logBase = path.basename(run.path, path.extname(run.path));
                const snapDir = path.join(path.dirname(run.path), 'snapshot', logBase);
                data.hasSnapshot = fs.existsSync(snapDir);
                return data;
            });
            return { name: ea.name, dir: ea.dir, runsDir: ea.runsDir, runs };
        });
    }

    _refresh(expertsDir) {
        this._expertsDir = expertsDir;
        const data = this._scan(expertsDir);
        this._panel.webview.postMessage({ type: 'fullUpdate', eas: data });
    }

    _openReport(logPath) {
        try {
            const parsed = parseLogFile(logPath);
            if (parsed.trades.length === 0) {
                vscode.window.showWarningMessage('No trades found in this log file.');
            }
            TradeReportPanel.createOrShow(this._context, parsed, logPath);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to parse log: ${e.message}`);
        }
    }

    async _openFilePicker() {
        const opts = {
            canSelectMany: false,
            filters: { 'MT5 Log Files': ['log'], 'All Files': ['*'] },
            openLabel: 'Open Log'
        };
        if (this._expertsDir) {
            opts.defaultUri = vscode.Uri.file(this._expertsDir);
        }
        const picks = await vscode.window.showOpenDialog(opts);
        if (!picks || picks.length === 0) return;
        this._openReport(picks[0].fsPath);
    }

    dispose() {
        TradeReportDashboard.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    _getHtml(eas) {
        const safeJson = (obj) => JSON.stringify(obj).replace(/<\//g, '<\\/');
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trade Report Dashboard</title>
<style>
:root {
    --bg: #1e1e2e;
    --surface: #282840;
    --surface2: #313150;
    --surface3: #3b3b5c;
    --text: #cdd6f4;
    --text-dim: #6c7086;
    --green: #a6e3a1;
    --red: #f38ba8;
    --blue: #89b4fa;
    --yellow: #f9e2af;
    --border: #45475a;
    --hover: #363658;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    background: var(--bg);
    color: var(--text);
    padding: 20px;
    font-size: 13px;
}

.toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
}
.toolbar h1 { font-size: 18px; font-weight: 600; }
.toolbar-actions { display: flex; gap: 8px; }
.btn {
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 7px 16px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
}
.btn:hover { background: var(--border); }
.btn-primary {
    background: #3b5998;
    border-color: #4a6baf;
}
.btn-primary:hover { background: #4a6baf; }

.empty-state {
    text-align: center;
    padding: 80px 20px;
    color: var(--text-dim);
}
.empty-state h3 { font-size: 16px; color: var(--text); margin-bottom: 12px; }
.empty-state p { margin-bottom: 20px; line-height: 1.6; }

/* EA Card */
.ea-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 20px;
    overflow: hidden;
}
.ea-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--surface2);
}
.ea-name { font-size: 15px; font-weight: 600; }
.ea-meta { font-size: 11px; color: var(--text-dim); }

/* Runs table */
.runs-table {
    width: 100%;
    border-collapse: collapse;
}
.runs-table th {
    text-align: left;
    padding: 8px 16px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
}
.runs-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
}
.runs-table tr.run-row {
    cursor: pointer;
    transition: background 0.1s;
}
.runs-table tr.run-row:hover { background: var(--hover); }
.runs-table tr.run-row:last-child td { border-bottom: none; }

.positive { color: var(--green); }
.negative { color: var(--red); }
.neutral  { color: var(--blue); }
.dim { color: var(--text-dim); }

.badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
}
.badge-trades { background: rgba(137,180,250,0.15); color: var(--blue); }
.badge-snapshot { background: rgba(166,227,161,0.15); color: var(--green); font-size: 9px; }
</style>
</head>
<body>

<div class="toolbar">
    <h1>Trade Report Dashboard</h1>
    <div class="toolbar-actions">
        <button class="btn" onclick="openFile()">Open Log File...</button>
        <button class="btn" onclick="refresh()">Refresh</button>
    </div>
</div>

<div id="content"></div>

<script>
    const vscode = acquireVsCodeApi();
    let eas = ${safeJson(eas)};

    function openFile() { vscode.postMessage({ type: 'openFile' }); }
    function refresh()  { vscode.postMessage({ type: 'refresh' }); }

    // Use event delegation for run rows — avoids path-escaping issues
    document.addEventListener('click', function(e) {
        var row = e.target.closest('.run-row');
        if (row && row.dataset.path) {
            vscode.postMessage({ type: 'openRun', logPath: row.dataset.path });
        }
    });

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function fmt(v, d) { d = d === undefined ? 2 : d; return Number(v || 0).toFixed(d); }
    function pnlClass(v) { return v >= 0 ? 'positive' : 'negative'; }

    function formatDate(mtime) {
        if (!mtime) return '?';
        var d = new Date(mtime);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    }

    function render() {
        var el = document.getElementById('content');
        if (!eas.length) {
            el.innerHTML = '<div class="empty-state">' +
                '<h3>No EAs with test runs found</h3>' +
                '<p>No <code>runs/</code> folders with <code>.log</code> files were found under Experts.<br>' +
                'You can still open a log file directly.</p>' +
                '<button class="btn btn-primary" onclick="openFile()">Open Log File...</button>' +
                '</div>';
            return;
        }

        var h = '';
        eas.forEach(function(ea) {
            h += '<div class="ea-card">';
            h += '<div class="ea-header">';
            h += '<div class="ea-name">' + esc(ea.name) + '</div>';
            h += '<div class="ea-meta">' + ea.runs.length + ' run' + (ea.runs.length !== 1 ? 's' : '') + '</div>';
            h += '</div>';

            h += '<table class="runs-table"><thead><tr>';
            h += '<th>Run</th><th>Symbol</th><th>Period</th><th>Trades</th><th>Net P&L</th><th>Win Rate</th><th>Date</th>';
            h += '</tr></thead><tbody>';

            ea.runs.forEach(function(run, i) {
                var pc = pnlClass(run.netPnl);
                h += '<tr class="run-row" data-path="' + esc(run.path) + '">';
                var snapBadge = run.hasSnapshot ? ' <span class="badge badge-snapshot" title="Source snapshot available">snapshot</span>' : '';
                h += '<td>' + esc(run.fileName) + snapBadge + '</td>';
                h += '<td>' + esc(run.symbol) + '</td>';
                h += '<td class="dim" style="font-size:11px">' + esc(run.from) + ' &mdash; ' + esc(run.to) + '</td>';
                h += '<td><span class="badge badge-trades">' + run.tradeCount + '</span></td>';
                h += '<td class="' + pc + '" style="font-weight:600">' + fmt(run.netPnl) + '</td>';
                h += '<td class="neutral">' + fmt(run.winRate, 1) + '%</td>';
                h += '<td class="dim" style="font-size:11px">' + formatDate(run.mtime) + '</td>';
                h += '</tr>';
            });

            h += '</tbody></table></div>';
        });

        el.innerHTML = h;
    }

    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'fullUpdate') {
            eas = msg.eas || [];
            render();
        }
    });

    render();
</script>
</body>
</html>`;
    }
}

module.exports = { TradeReportDashboard };
