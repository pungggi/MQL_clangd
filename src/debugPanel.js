'use strict';
const vscode = require('vscode');

const VIEW_TYPE = 'mqlDebugPanel';

/**
 * MqlDebugPanel — Phase 1 debug variable viewer.
 *
 * Shows a live-updating table of:
 *  - Breakpoint hits (label, file, function, line, timestamp)
 *  - Watch variables captured at each hit (name, type, value)
 *  - Current call stack
 *
 * Receives state from DebugStateStore via the onChange listener.
 */
class MqlDebugPanel {
  static currentPanel = null;

  /**
   * @param {import('./debugStateStore').DebugStateStore} store
   * @param {vscode.ExtensionContext} context
   */
  static show(store, context) {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (MqlDebugPanel.currentPanel) {
      MqlDebugPanel.currentPanel._panel.reveal(column);
      MqlDebugPanel.currentPanel._sendState();
      return MqlDebugPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'MQL Debug',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    MqlDebugPanel.currentPanel = new MqlDebugPanel(panel, store, context);
    return MqlDebugPanel.currentPanel;
  }

  constructor(panel, store, context) {
    this._panel = panel;
    this._store = store;
    this._context = context;
    this._disposables = [];
    this._isDisposed = false;

    this._panel.webview.html = this._buildHtml();

    // Handle messages from webview (e.g. "Stop session" button)
    this._panel.webview.onDidReceiveMessage(
      msg => {
        if (msg.type === 'stopSession') {
          vscode.commands.executeCommand('mql_tools.stopDebugging');
        }
      },
      undefined,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Subscribe to state changes
    this._listener = () => this._sendState();
    this._store.onChange(this._listener);

    // Initial render
    this._sendState();
  }

  /** Push current store state to the webview. */
  _sendState() {
    if (this._isDisposed || !this._panel) return;
    this._panel.webview.postMessage({
      type: 'update',
      sessionActive: this._store.sessionActive,
      hits: this._store.hits.slice(-50),   // last 50 hits
      callStack: this._store.callStack,
      latestWatches: this._store.latestWatchList,
    });
  }

  dispose() {
    if (this._isDisposed) return;
    this._isDisposed = true;

    MqlDebugPanel.currentPanel = null;

    if (this._listener) {
      this._store.removeListener(this._listener);
      this._listener = null;
    }

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  _buildHtml() {
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${this._panel.webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MQL Debug</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
  }
  h2 { font-size: 1em; margin-bottom: 8px; color: var(--vscode-foreground); }
  h3 { font-size: 0.9em; margin: 12px 0 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.8em;
    font-weight: bold;
  }
  .badge-active { background: #1a8a2e; color: #fff; }
  .badge-stopped { background: #666; color: #fff; }
  button {
    margin-left: 8px;
    padding: 3px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th {
    text-align: left;
    padding: 4px 8px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    color: var(--vscode-foreground);
    font-size: 0.8em;
    font-weight: 600;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .hit-row { cursor: pointer; }
  .hit-row:hover td { background: var(--vscode-list-hoverBackground); }
  .hit-row.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .type-tag { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); font-size: 0.85em; }
  .val { font-family: monospace; }
  .func { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
  .file { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .ts { color: var(--vscode-descriptionForeground); font-size: 0.78em; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
  .section { margin-bottom: 16px; }
  #header { display: flex; align-items: center; margin-bottom: 14px; gap: 6px; }
</style>
</head>
<body>
<div id="header">
  <h2>MQL Debugger Bridge</h2>
  <span id="statusBadge" class="badge badge-stopped">STOPPED</span>
  <button id="stopSessionBtn">Stop Session</button>
</div>

<div class="section">
  <h3>Latest Watches</h3>
  <div id="latestWatches"><p class="empty">No watch data yet.</p></div>
</div>

<div class="section">
  <h3>Breakpoint Hits</h3>
  <div id="hits"><p class="empty">No breakpoints hit yet.</p></div>
</div>

<div class="section">
  <h3>Call Stack</h3>
  <div id="callStack"><p class="empty">No call stack data yet.</p></div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let _selectedHitIdx = -1;
let _hits = [];

function stopSession() { vscode.postMessage({ type: 'stopSession' }); }
document.getElementById('stopSessionBtn').addEventListener('click', stopSession);

document.getElementById('hits').addEventListener('click', (evt) => {
  const row = evt.target.closest('.hit-row');
  if (!row) return;

  document.querySelectorAll('.hit-row').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  _selectedHitIdx = parseInt(row.dataset.idx, 10);
});

window.addEventListener('message', evt => {
  const msg = evt.data;
  if (msg.type !== 'update') return;

  // Status badge
  const badge = document.getElementById('statusBadge');
  if (msg.sessionActive) {
    badge.textContent = 'ACTIVE';
    badge.className = 'badge badge-active';
  } else {
    badge.textContent = 'STOPPED';
    badge.className = 'badge badge-stopped';
  }

  _hits = msg.hits || [];

  renderLatestWatches(msg.latestWatches || []);
  renderHits(_hits);
  renderCallStack(msg.callStack || []);
});

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLatestWatches(watches) {
  const el = document.getElementById('latestWatches');
  if (!watches.length) { el.innerHTML = '<p class="empty">No watch data yet.</p>'; return; }
  let html = '<table><thead><tr><th>Variable</th><th>Type</th><th>Value</th><th>Function</th><th>Line</th></tr></thead><tbody>';
  for (const w of watches) {
    html += '<tr>'
      + '<td>' + esc(w.varName) + '</td>'
      + '<td class="type-tag">' + esc(w.varType) + '</td>'
      + '<td class="val">' + esc(w.value) + '</td>'
      + '<td class="func">' + esc(w.func) + '</td>'
      + '<td>' + esc(w.line) + '</td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderHits(hits) {
  const el = document.getElementById('hits');
  if (!hits.length) { el.innerHTML = '<p class="empty">No breakpoints hit yet.</p>'; return; }

  let html = '<table><thead><tr><th>Label</th><th>Function</th><th>Line</th><th>File</th><th>Time</th></tr></thead><tbody>';
  hits.forEach((h, i) => {
    const effectiveIdx = _selectedHitIdx >= 0 ? _selectedHitIdx : hits.length - 1;
    const selected = i === effectiveIdx ? ' selected' : '';
    html += '<tr class="hit-row' + selected + '" data-idx="' + i + '">'
      + '<td>' + esc(h.label) + '</td>'
      + '<td class="func">' + esc(h.func) + '</td>'
      + '<td>' + esc(h.line) + '</td>'
      + '<td class="file">' + esc(h.file) + '</td>'
      + '<td class="ts">' + esc(h.timestamp) + '</td>'
      + '</tr>';
    // Watches sub-rows
    if (h.watches && h.watches.length) {
      for (const w of h.watches) {
        html += '<tr><td style="padding-left:20px;color:var(--vscode-descriptionForeground)">'
          + esc(w.varName) + '</td>'
          + '<td class="type-tag">' + esc(w.varType) + '</td>'
          + '<td class="val" colspan="3">' + esc(w.value) + '</td></tr>';
      }
    }
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderCallStack(stack) {
  const el = document.getElementById('callStack');
  if (!stack.length) { el.innerHTML = '<p class="empty">No call stack data yet.</p>'; return; }
  let html = '<table><thead><tr><th>Function</th><th>File</th><th>Line</th><th>State</th></tr></thead><tbody>';
  for (let i = stack.length - 1; i >= 0; i--) {
    const f = stack[i];
    html += '<tr>'
      + '<td class="func">' + esc(f.func) + '</td>'
      + '<td class="file">' + esc(f.file) + '</td>'
      + '<td>' + esc(f.line) + '</td>'
      + '<td>' + esc(f.state) + '</td>'
      + '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}
</script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = { MqlDebugPanel };
