'use strict';
const vscode = require('vscode');

/**
 * Manages the Trade Report WebviewPanel.
 * Receives trade/equity/metric data from ideBridge and renders an interactive dashboard.
 */
class TradeReportPanel {
    static currentPanel = null;
    static viewType = 'mqlTradeReport';

    /**
     * Show or create the trade report panel.
     * @param {vscode.ExtensionContext} context
     * @param {import('./ideBridge')} bridge
     */
    static createOrShow(context, bridge) {
        const column = vscode.ViewColumn.Beside;

        if (TradeReportPanel.currentPanel) {
            TradeReportPanel.currentPanel._panel.reveal(column);
            TradeReportPanel.currentPanel._update(bridge);
            return TradeReportPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            TradeReportPanel.viewType,
            'MQL Trade Report',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        TradeReportPanel.currentPanel = new TradeReportPanel(panel, context, bridge);
        return TradeReportPanel.currentPanel;
    }

    constructor(panel, context, bridge) {
        this._panel = panel;
        this._context = context;
        this._bridge = bridge;
        this._disposables = [];

        this._panel.webview.html = this._getHtml(bridge);

        // Listen for bridge events and push updates to webview
        this._tradeListener = (trade) => {
            this._panel.webview.postMessage({ type: 'trade', data: trade, summary: bridge.getSummary() });
        };
        this._equityListener = (eq) => {
            this._panel.webview.postMessage({ type: 'equity', data: eq });
        };
        this._metricListener = (m) => {
            this._panel.webview.postMessage({ type: 'metric', data: m });
        };

        bridge.on('trades', this._tradeListener);
        bridge.on('equity', this._equityListener);
        bridge.on('metrics', this._metricListener);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'refresh') {
                this._update(bridge);
            }
        }, null, this._disposables);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    _update(bridge) {
        this._panel.webview.postMessage({
            type: 'fullUpdate',
            trades: bridge.trades,
            equity: bridge.equity,
            metrics: Object.fromEntries(bridge.metrics),
            summary: bridge.getSummary()
        });
    }

    dispose() {
        TradeReportPanel.currentPanel = null;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    _getHtml(bridge) {
        const summary = bridge.getSummary();
        const tradesJson = JSON.stringify(bridge.trades);
        const equityJson = JSON.stringify(bridge.equity);

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
.cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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
tr:hover td {
    background: var(--surface);
}
.type-buy  { color: var(--blue); }
.type-sell { color: var(--red); }

.equity-chart {
    width: 100%;
    height: 120px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    position: relative;
    overflow: hidden;
}
.equity-chart canvas {
    width: 100%;
    height: 100%;
}

.metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
    margin-bottom: 16px;
}
.metric-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.metric-item .key { color: var(--text-dim); font-size: 11px; }
.metric-item .val { font-weight: 600; font-variant-numeric: tabular-nums; }

.empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-dim);
}
.empty-state h3 { font-size: 16px; margin-bottom: 8px; color: var(--text); }
.empty-state p { font-size: 13px; line-height: 1.6; }
.empty-state code {
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
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
.toolbar button:hover {
    background: var(--border);
}
</style>
</head>
<body>

<div class="toolbar">
    <div style="font-size:16px; font-weight:600;">Trade Report</div>
    <button onclick="refresh()">Refresh</button>
</div>

<div class="cards" id="summaryCards">
    ${this._renderCards(summary)}
</div>

<div id="metricsSection"></div>

<div id="equitySection">
    <h2>Equity Curve</h2>
    <div class="equity-chart"><canvas id="equityCanvas"></canvas></div>
</div>

<h2>Trades</h2>
<div id="tradesSection">
    ${bridge.trades.length === 0 ? this._renderEmptyState() : this._renderTable(bridge.trades)}
</div>

<script>
    const vscode = acquireVsCodeApi();

    let trades = ${tradesJson};
    let equity = ${equityJson};
    let metrics = {};

    function refresh() {
        vscode.postMessage({ type: 'refresh' });
    }

    function pnlClass(v) { return v >= 0 ? 'positive' : 'negative'; }
    function fmt(v, d) { return (d === undefined ? 2 : d, Number(v).toFixed(d === undefined ? 2 : d)); }

    function renderCards(s) {
        return '<div class="card"><div class="label">Trades</div><div class="value neutral">' + s.tradeCount + '</div></div>'
             + '<div class="card"><div class="label">Net P&L</div><div class="value ' + pnlClass(s.netPnl) + '">' + fmt(s.netPnl) + '</div></div>'
             + '<div class="card"><div class="label">Win Rate</div><div class="value neutral">' + fmt(s.winRate, 1) + '%</div></div>'
             + '<div class="card"><div class="label">Gross Profit</div><div class="value positive">' + fmt(s.grossProfit) + '</div></div>'
             + '<div class="card"><div class="label">Gross Loss</div><div class="value negative">' + fmt(s.grossLoss) + '</div></div>'
             + '<div class="card"><div class="label">Commission</div><div class="value neutral">' + fmt(s.commission) + '</div></div>';
    }

    function renderTable(trades) {
        if (!trades.length) return renderEmpty();
        let h = '<table><thead><tr><th>#</th><th>Ticket</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Close</th><th>SL</th><th>TP</th><th>P&L</th><th>Time</th></tr></thead><tbody>';
        trades.forEach(function(t, i) {
            var cls = t.type === 'buy' ? 'type-buy' : 'type-sell';
            var pCls = t.profit >= 0 ? 'positive' : 'negative';
            h += '<tr>'
               + '<td>' + (i+1) + '</td>'
               + '<td>' + (t.ticket || '') + '</td>'
               + '<td>' + (t.symbol || '') + '</td>'
               + '<td class="' + cls + '">' + (t.type || '').toUpperCase() + '</td>'
               + '<td>' + fmt(t.lots) + '</td>'
               + '<td>' + (t.open_price ? fmt(t.open_price, 5) : '-') + '</td>'
               + '<td>' + (t.close_price ? fmt(t.close_price, 5) : '-') + '</td>'
               + '<td>' + (t.sl ? fmt(t.sl, 5) : '-') + '</td>'
               + '<td>' + (t.tp ? fmt(t.tp, 5) : '-') + '</td>'
               + '<td class="' + pCls + '">' + fmt(t.profit) + '</td>'
               + '<td style="color:var(--text-dim);font-size:11px">' + (t.close_time || '') + '</td>'
               + '</tr>';
        });
        h += '</tbody></table>';
        return h;
    }

    function renderEmpty() {
        return '<div class="empty-state">'
             + '<h3>Waiting for trade data...</h3>'
             + '<p>Add <code>#include &lt;IDEBridge.mqh&gt;</code> to your EA<br>'
             + 'Call <code>IDEBridgeInit()</code> in OnInit()<br>'
             + 'Call <code>IDEBridgeReportTrade(...)</code> or <code>IDEBridgeReportHistory()</code></p>'
             + '</div>';
    }

    function renderMetrics(m) {
        var keys = Object.keys(m);
        if (!keys.length) return '';
        var h = '<h2>Metrics</h2><div class="metrics-grid">';
        keys.forEach(function(k) {
            var val = m[k].value !== undefined ? m[k].value : m[k].value_str;
            h += '<div class="metric-item"><span class="key">' + k + '</span><span class="val">' + val + '</span></div>';
        });
        h += '</div>';
        return h;
    }

    function drawEquity(equityData) {
        var canvas = document.getElementById('equityCanvas');
        if (!canvas || !equityData.length) return;
        var ctx = canvas.getContext('2d');
        var w = canvas.width = canvas.parentElement.clientWidth;
        var h = canvas.height = canvas.parentElement.clientHeight;

        var values = equityData.map(function(e) { return e.equity; });
        var mn = Math.min.apply(null, values);
        var mx = Math.max.apply(null, values);
        var range = mx - mn || 1;
        var pad = 8;

        ctx.clearRect(0, 0, w, h);

        // Fill
        ctx.beginPath();
        ctx.moveTo(pad, h - pad);
        for (var i = 0; i < values.length; i++) {
            var x = pad + (i / (values.length - 1 || 1)) * (w - 2*pad);
            var y = h - pad - ((values[i] - mn) / range) * (h - 2*pad);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(w - pad, h - pad);
        ctx.closePath();
        ctx.fillStyle = 'rgba(137, 180, 250, 0.1)';
        ctx.fill();

        // Line
        ctx.beginPath();
        for (var i = 0; i < values.length; i++) {
            var x = pad + (i / (values.length - 1 || 1)) * (w - 2*pad);
            var y = h - pad - ((values[i] - mn) / range) * (h - 2*pad);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#89b4fa';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Message handler
    window.addEventListener('message', function(event) {
        var msg = event.data;
        switch (msg.type) {
            case 'trade':
                trades.push(msg.data);
                document.getElementById('summaryCards').innerHTML = renderCards(msg.summary);
                document.getElementById('tradesSection').innerHTML = renderTable(trades);
                break;
            case 'equity':
                equity.push(msg.data);
                drawEquity(equity);
                break;
            case 'metric':
                if (msg.data.key) {
                    metrics[msg.data.key] = msg.data;
                    document.getElementById('metricsSection').innerHTML = renderMetrics(metrics);
                }
                break;
            case 'fullUpdate':
                trades = msg.trades || [];
                equity = msg.equity || [];
                metrics = msg.metrics || {};
                document.getElementById('summaryCards').innerHTML = renderCards(msg.summary);
                document.getElementById('tradesSection').innerHTML = renderTable(trades);
                document.getElementById('metricsSection').innerHTML = renderMetrics(metrics);
                drawEquity(equity);
                break;
        }
    });

    // Initial draw
    drawEquity(equity);
</script>
</body>
</html>`;
    }

    _renderCards(summary) {
        const pnlCls = summary.netPnl >= 0 ? 'positive' : 'negative';
        return `
            <div class="card"><div class="label">Trades</div><div class="value neutral">${summary.tradeCount}</div></div>
            <div class="card"><div class="label">Net P&L</div><div class="value ${pnlCls}">${summary.netPnl.toFixed(2)}</div></div>
            <div class="card"><div class="label">Win Rate</div><div class="value neutral">${summary.winRate.toFixed(1)}%</div></div>
            <div class="card"><div class="label">Gross Profit</div><div class="value positive">${summary.grossProfit.toFixed(2)}</div></div>
            <div class="card"><div class="label">Gross Loss</div><div class="value negative">${summary.grossLoss.toFixed(2)}</div></div>
            <div class="card"><div class="label">Commission</div><div class="value neutral">${summary.commission.toFixed(2)}</div></div>`;
    }

    _renderEmptyState() {
        return `<div class="empty-state">
            <h3>Waiting for trade data...</h3>
            <p>Add <code>#include &lt;IDEBridge.mqh&gt;</code> to your EA<br>
            Call <code>IDEBridgeInit()</code> in OnInit()<br>
            Call <code>IDEBridgeReportTrade(...)</code> or <code>IDEBridgeReportHistory()</code></p>
        </div>`;
    }

    _renderTable(trades) {
        let html = `<table><thead><tr>
            <th>#</th><th>Ticket</th><th>Symbol</th><th>Type</th><th>Lots</th>
            <th>Open</th><th>Close</th><th>SL</th><th>TP</th><th>P&L</th><th>Time</th>
        </tr></thead><tbody>`;

        trades.forEach((t, i) => {
            const typeCls = t.type === 'buy' ? 'type-buy' : 'type-sell';
            const pnlCls = t.profit >= 0 ? 'positive' : 'negative';
            html += `<tr>
                <td>${i + 1}</td>
                <td>${t.ticket || ''}</td>
                <td>${t.symbol || ''}</td>
                <td class="${typeCls}">${(t.type || '').toUpperCase()}</td>
                <td>${(t.lots || 0).toFixed(2)}</td>
                <td>${t.open_price ? t.open_price.toFixed(5) : '-'}</td>
                <td>${t.close_price ? t.close_price.toFixed(5) : '-'}</td>
                <td>${t.sl ? t.sl.toFixed(5) : '-'}</td>
                <td>${t.tp ? t.tp.toFixed(5) : '-'}</td>
                <td class="${pnlCls}">${(t.profit || 0).toFixed(2)}</td>
                <td style="color:var(--text-dim);font-size:11px">${t.close_time || ''}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        return html;
    }
}

module.exports = { TradeReportPanel };
