'use strict';

// MQL: Edit Chart Layout Presets (Visual)
//
// Webview panel that lets users paint chart-layout grids with timeframe tokens
// instead of hand-writing "areas" JSON. The panel itself owns no layout logic:
// normalization, saving and running the arrangement all reuse chartLayout.js,
// so the editor can never drift from the ArrangeCharts command's behavior.
//
// Protocol (webview -> host):
//   { type: 'save',  presets: [...] }        write the full presets array
//   { type: 'apply', presets: [...], index } save, then arrange that preset
// Protocol (host -> webview):
//   { type: 'saveResult'|'applyResult', ok, message }
//
// Editor state lives in the webview only (per session, never persisted until
// Save writes the whole array to user settings).

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const {
    getPresets,
    normalizeGrid,
    normalizePreset,
    runArrangeScript,
    updateStatusLabel,
} = require('./chartLayout');

const CONFIG_KEY = 'ChartLayout.Presets';

// Human explanation for why normalizePreset() rejected an entry, using the
// same normalizeGrid() the command itself uses (no duplicated rules).
function describeInvalid(p) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) {
        return 'every preset needs a non-empty name.';
    }
    const name = `"${p.name.trim()}" `;
    if (!normalizeGrid(p.docked)) {
        return `preset ${name}needs a docked group: monitor 1+ plus a painted grid (or rows × cols).`;
    }
    if (p.floating && !normalizeGrid(p.floating)) {
        return `preset ${name}has a floating group with monitor < 1 or an empty grid.`;
    }
    return `preset ${name}is not a valid layout.`;
}

class ChartLayoutEditorPanel {
    static currentPanel = null;
    static viewType = 'mqlChartLayoutEditor';

    static createOrShow(context) {
        if (ChartLayoutEditorPanel.currentPanel) {
            ChartLayoutEditorPanel.currentPanel._panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ChartLayoutEditorPanel.viewType,
            'Chart Layout Editor',
            vscode.ViewColumn.Active,
            // retainContextWhenHidden: grid edits must survive tab switches.
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ChartLayoutEditorPanel.currentPanel = new ChartLayoutEditorPanel(panel, context);
    }

    constructor(panel, context) {
        this._panel = panel;
        this._context = context;
        this._disposables = [];
        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(msg => this._onMessage(msg), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    dispose() {
        ChartLayoutEditorPanel.currentPanel = null;
        this._panel.dispose();
        for (const d of this._disposables) d.dispose();
        this._disposables = [];
    }

    _post(msg) {
        this._panel.webview.postMessage(msg);
    }

    async _onMessage(msg) {
        switch (msg.type) {
            case 'save':
                try {
                    this._post(await this._save(msg.presets, 'saveResult'));
                } catch (e) {
                    this._post({ type: 'saveResult', ok: false, message: e.message });
                }
                break;
            case 'apply':
                try {
                    await this._apply(msg.presets, msg.index);
                } catch (e) {
                    this._post({ type: 'applyResult', ok: false, message: e.message });
                }
                break;
            default:
                break;
        }
    }

    // Normalize + write the full presets array to settings. Returns a
    // result envelope; rejects are caught by the caller.
    async _save(presets, resultType) {
        if (!Array.isArray(presets) || presets.length === 0) {
            return { type: resultType, ok: false, message: 'Keep at least one preset, or delete leftovers you no longer need.' };
        }
        const norm = [];
        for (const p of presets) {
            const n = normalizePreset(p);
            if (!n) return { type: resultType, ok: false, message: `Not saved: ${describeInvalid(p)}` };
            norm.push(n);
        }
        const clean = norm.map(p => {
            const o = { name: p.name, docked: p.docked };
            if (p.floating) o.floating = p.floating;
            o.gap = p.gap;
            return o;
        });
        const target = await this._saveTarget();
        if (!target) return { type: resultType, ok: false, message: 'Save cancelled.' };
        await vscode.workspace.getConfiguration('mql_tools').update(CONFIG_KEY, clean, target);
        const scopeName = target === vscode.ConfigurationTarget.Workspace ? 'workspace settings' : 'user settings';
        return { type: resultType, ok: true, message: `Saved ${clean.length} preset${clean.length === 1 ? '' : 's'} to ${scopeName}.`, presets: clean };
    }

    // Where to write presets: user settings by default. A workspace-level
    // override keeps winning over any user-scope write (VS Code precedence:
    // workspace > user), so a Global-only save would be silently ignored by
    // the editor on reopen and by Arrange MT5 Charts. When an override is
    // active, ask once per session where to save.
    async _saveTarget() {
        if (this._saveScopeChoice) return this._saveScopeChoice;
        const insp = vscode.workspace.getConfiguration('mql_tools').inspect(CONFIG_KEY);
        const overridden = !!(insp && (insp.workspaceValue !== undefined || insp.workspaceFolderValue !== undefined));
        if (!overridden) return vscode.ConfigurationTarget.Global;
        const pick = await vscode.window.showQuickPick([
            {
                label: '$(workspace) Workspace settings',
                detail: 'The workspace override stays in effect — save there so the editor and Arrange MT5 Charts see the change.',
                target: vscode.ConfigurationTarget.Workspace,
            },
            {
                label: '$(home) User settings',
                detail: 'Keep the workspace override; the saved list will NOT be used in this workspace.',
                target: vscode.ConfigurationTarget.Global,
            },
        ], { placeHolder: 'This workspace overrides mql_tools.ChartLayout.Presets. Where should the presets be saved?' });
        if (!pick) return null;   // cancelled
        this._saveScopeChoice = pick.target;
        return pick.target;
    }

    async _apply(presets, index) {
        if (process.platform !== 'win32') {
            this._post({ type: 'applyResult', ok: false, message: 'Arrange MT5 Charts is Windows-only (it positions native MT5 windows).' });
            return;
        }
        const saved = await this._save(presets, 'applyResult');
        if (!saved.ok) {
            this._post({ type: 'applyResult', ok: false, message: `Not applied — ${saved.message}` });
            return;
        }
        const i = Math.max(0, Math.min(Math.trunc(Number(index)) || 0, saved.presets.length - 1));
        const preset = saved.presets[i];
        const scriptPath = path.join(this._context.extensionPath, 'scripts', 'mt5-arrange-charts.ps1');
        try {
            const result = await runArrangeScript(scriptPath, preset);
            updateStatusLabel(preset.name);
            this._post({ type: 'applyResult', ok: true, message: result.replace(/^OK\s*/, 'Charts arranged — ') });
        } catch (e) {
            this._post({ type: 'applyResult', ok: false, message: `Arrange failed: ${e.message}` });
        }
    }

    _getHtml() {
        const initial = getPresets().map(p => ({ raw: p, invalid: !normalizePreset(p) }));
        const nonce = crypto.randomBytes(16).toString('base64');
        const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Chart Layout Editor</title>
<style>
:root {
    --bg: var(--vscode-editor-background, #1e1e2e);
    --surface: var(--vscode-sideBar-background, #282840);
    --surface2: var(--vscode-input-background, #313150);
    --text: var(--vscode-editor-foreground, #cdd6f4);
    --dim: var(--vscode-descriptionForeground, #6c7086);
    --border: var(--vscode-panel-border, #45475a);
    --accent: var(--vscode-focusBorder, #89b4fa);
    --btn: var(--vscode-button-background, #316bcd);
    --btnfg: var(--vscode-button-foreground, #ffffff);
    --btn2: var(--vscode-button-secondaryBackground, #3a3a5c);
    --btn2fg: var(--vscode-button-secondaryForeground, #ffffff);
    --ok: var(--vscode-charts-green, #a6e3a1);
    --err: var(--vscode-errorForeground, #f38ba8);
    --warn: var(--vscode-charts-yellow, #f9e2af);
    --blue: var(--vscode-charts-blue, #89b4fa);
    --green: var(--vscode-charts-green, #a6e3a1);
    --purple: var(--vscode-charts-purple, #cba6f7);
    --selbg: var(--vscode-list-activeSelectionBackground, #04395e);
    --selfg: var(--vscode-list-activeSelectionForeground, #ffffff);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    background: var(--bg); color: var(--text);
    font-size: 13px; height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
button { font-family: inherit; font-size: 12px; cursor: pointer; }
input { font-family: inherit; font-size: 12px; }

/* toolbar */
#toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
#toolbar .grp { display: flex; gap: 6px; align-items: center; }
#toolbar button {
    background: var(--btn2); color: var(--btn2fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 5px 12px;
}
#toolbar button:hover:not(:disabled) { filter: brightness(1.2); }
#toolbar button:disabled { opacity: 0.45; cursor: default; }
#toolbar button.primary { background: var(--btn); color: var(--btnfg); border-color: transparent; }
#status { font-size: 12px; color: var(--dim); flex: 1; text-align: right; padding: 0 8px; overflow: hidden; max-height: 5em; overflow-wrap: anywhere; }
#status.ok { color: var(--ok); }
#status.err { color: var(--err); }

/* palette */
#palette {
    display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
    padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface);
}
#palette .lab { color: var(--dim); margin-right: 2px; }
.chip {
    background: var(--surface2); color: var(--text);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 2px 7px; font-size: 11px; font-weight: 600; min-width: 30px;
}
.chip:hover { border-color: var(--accent); }
.chip.sel { background: var(--btn); color: var(--btnfg); border-color: var(--btn); }
#customTok {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border);
    border-radius: 3px; padding: 3px 7px; width: 110px;
}
#customTok.sel { border-color: var(--btn); outline: 1px solid var(--btn); }
#customTok::placeholder { color: var(--dim); }

/* main layout */
#main { display: flex; flex: 1; min-height: 0; }
#sidebar {
    width: 250px; min-width: 200px; border-right: 1px solid var(--border);
    overflow-y: auto; background: var(--surface);
}
.side-head {
    padding: 8px 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--border);
}
#presetList { list-style: none; }
#presetList .item { padding: 7px 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
#presetList .item:hover { background: var(--surface2); }
#presetList .item.sel { background: var(--selbg); }
#presetList .item.sel .pname { color: var(--selfg); }
#presetList .pname { font-weight: 600; display: block; }
#presetList .psum { font-size: 11px; color: var(--dim); display: block; margin-top: 2px; }
#presetList .empty { padding: 14px 12px; color: var(--dim); font-style: italic; }

#editor { flex: 1; overflow-y: auto; padding: 14px 16px; min-width: 0; }
.noPreset { color: var(--dim); padding: 24px; text-align: center; }
.row { display: flex; gap: 14px; align-items: center; }
.name-row { margin-bottom: 12px; }
.name-row label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.name-row .grow { flex: 1; }
.name-row input {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 5px 8px; font-size: 13px;
}
#presetName { width: 100%; }
#presetGap { width: 80px; }

/* group cards */
.card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 14px;
}
.card.off { opacity: 0.75; }
.card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.card h3 { font-size: 13px; }
.card .crow { display: flex; align-items: center; gap: 10px; }
.card .cs { font-size: 11px; color: var(--dim); display: block; margin-top: 2px; }
.card .tog { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--dim); cursor: pointer; }
.card .mon { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.card .mon input {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 6px; width: 64px;
}
.off-note { font-size: 12px; color: var(--dim); font-style: italic; padding: 6px 0; }

.grid { display: grid; gap: 4px; user-select: none; overflow-x: auto; }
.cell {
    min-height: 42px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); border-radius: 5px;
    font-size: 12px; font-weight: 700; cursor: crosshair; background: var(--surface2);
}
.cell.empty { color: var(--dim); font-weight: 400; }
.cell.custom { color: var(--purple); }
.cell.tf-m { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 45%, var(--border)); }
.cell.tf-h { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--border)); }
.cell.tf-d { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 45%, var(--border)); }
.cell.red { background: color-mix(in srgb, var(--err) 22%, var(--surface2)); border-color: var(--err); }
.cell.drag { outline: 2px solid var(--accent); outline-offset: -1px; }

.tools { display: flex; gap: 6px; align-items: center; margin-top: 10px; }
.tbtn {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 3px 10px; font-size: 11px;
}
.tbtn:hover:not(:disabled) { border-color: var(--accent); }
.tbtn:disabled { opacity: 0.4; cursor: default; }
.dims { font-size: 11px; color: var(--dim); margin-left: auto; }

.hint { margin-top: 8px; font-size: 12px; line-height: 1.45; }
.hint.ok { color: var(--ok); }
.hint.warn { color: var(--warn); }
.hint.err { color: var(--err); }

/* json preview */
.json { margin-top: 4px; }
.json summary { cursor: pointer; color: var(--dim); font-size: 12px; margin-bottom: 6px; }
.json pre {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px; font-family: var(--vscode-editor-font-family, Consolas, monospace);
    font-size: 12px; line-height: 1.5; overflow: auto; max-height: 300px; user-select: text;
    white-space: pre;
}
</style>
</head>
<body>
<div id="toolbar">
    <div class="grp">
        <button id="btnNew" title="Add a new blank preset">+ New</button>
        <button id="btnDup" title="Duplicate the selected preset">Duplicate</button>
        <button id="btnDelete" title="Delete the selected preset">Delete</button>
    </div>
    <span id="status"></span>
    <div class="grp">
        <button id="btnApply" class="primary" title="Save all presets, then arrange MT5 charts with this one">▷ Apply Now</button>
        <button id="btnSave" title="Write all presets to user settings (mql_tools.ChartLayout.Presets)">Save to Settings</button>
    </div>
</div>
<div id="palette">
    <span class="lab">Paint:</span>
    <span id="palChips" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center"></span>
    <input id="customTok" type="text" placeholder="custom name…" title="Type a custom region name, then paint with it (Enter to confirm). Daily/Weekly/Monthly are accepted and saved as D1/W1/MN1.">
</div>
<div id="main">
    <div id="sidebar">
        <div class="side-head">Presets</div>
        <ul id="presetList"></ul>
    </div>
    <div id="editor"></div>
</div>
<script nonce="${nonce}">
(function () {
    'use strict';
    var vscode = acquireVsCodeApi();
    var INITIAL = ${safeJson(initial)};

    var TF_TOKENS = ['M1','M2','M3','M4','M5','M6','M10','M12','M15','M20','M30','H1','H2','H3','H4','H6','H8','H12','D1','W1','MN1'];
    var TF_SET = {};
    for (var t0 = 0; t0 < TF_TOKENS.length; t0++) TF_SET[TF_TOKENS[t0]] = true;
    // Long display names MT5 puts in D1/W1/MN1 window titles. The worker
    // accepts both spellings; the editor canonicalizes to the short codes so
    // the grid model (and everything saved from it) always uses one token.
    var TF_ALIAS = { 'Daily': 'D1', 'Weekly': 'W1', 'Monthly': 'MN1' };
    function canonTok(t) { return TF_ALIAS[t] || t; }
    var MAX_ROWS = 12, MAX_COLS = 16;

    var presets = [];
    for (var i0 = 0; i0 < INITIAL.length; i0++) {
        presets.push(loadPreset(INITIAL[i0].raw, INITIAL[i0].invalid));
    }
    var sel = 0;
    var token = 'H1';
    var custom = '';
    var drag = null;

    // ---------- helpers ----------

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function cur() { return presets[sel]; }
    function groupOf(p, gi) { return gi === 0 ? p.docked : p.floating; }
    function markTouched() { var p = cur(); if (p) p.touched = true; }
    function clampInt(v, min, max, dflt) {
        var n = Math.trunc(Number(v)) || dflt;
        if (n < min) n = min;
        if (n > max) n = max;
        return n;
    }
    function blankGrid(rows, cols) {
        var g = [];
        for (var r = 0; r < rows; r++) {
            var row = [];
            for (var c = 0; c < cols; c++) row.push('.');
            g.push(row);
        }
        return g;
    }
    // 0->A, 1->B, ... 25->Z, 26->AA ... (region names for order-fill grids)
    function seqName(i) {
        var s = '';
        var n = i + 1;
        while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
        return s;
    }

    // ---------- load (raw settings entry -> editable model) ----------

    function loadGroup(g) {
        var mon = clampInt(g && g.monitor, 1, 16, 1);
        var grid = null;
        if (g && Array.isArray(g.areas)) {
            var rows = [];
            for (var i = 0; i < g.areas.length; i++) {
                // A token containing '|' would split into rows when the worker
                // joins/splits on it; drop it to an empty cell instead.
                var cells = String(g.areas[i]).trim().split(/\\s+/).filter(function (t) { return t !== ''; })
                    .map(function (t) { return t.indexOf('|') >= 0 ? '.' : canonTok(t); });
                if (cells.length) rows.push(cells);
            }
            if (rows.length) {
                var cols = 0;
                for (var r = 0; r < rows.length; r++) cols = Math.max(cols, rows[r].length);
                grid = [];
                for (var r2 = 0; r2 < rows.length; r2++) {
                    var row = rows[r2].slice();
                    while (row.length < cols) row.push('.');   // pad ragged rows
                    grid.push(row);
                }
            }
            if (grid) return { monitor: mon, grid: grid, on: true, legacy: false, dirty: false };
        }
        // Legacy rows/cols (or nothing usable): uniform grid with sequential
        // region names = the same order-fill behavior rows/cols gives. No size
        // clamp here — oversized legacy grids load verbatim so a Save never
        // silently truncates a preset the user did not touch. The 'legacy'
        // flag keeps the exact rows/cols shape for saving until the user edits this grid:
        // the uniform worker geometry differs slightly from areas at gap > 0.
        var nr = Math.max(1, Math.trunc(Number(g && g.rows)) || 2);
        var nc = Math.max(1, Math.trunc(Number(g && g.cols)) || 3);
        var isLegacy = !!(g && Math.trunc(Number(g.rows)) >= 1 && Math.trunc(Number(g.cols)) >= 1);
        grid = [];
        var n = 0;
        for (var rr = 0; rr < nr; rr++) {
            var line = [];
            for (var cc = 0; cc < nc; cc++) line.push(seqName(n++));
            grid.push(line);
        }
        return { monitor: mon, grid: grid, on: true, legacy: isLegacy, dirty: false };
    }

    function loadPreset(raw, origInvalid) {
        raw = raw || {};
        return {
            name: typeof raw.name === 'string' ? raw.name : '',
            gap: clampInt(raw.gap, 0, 999, 0),
            docked: loadGroup(raw.docked),
            floating: raw.floating ? loadGroup(raw.floating) : null,
            origInvalid: !!origInvalid,
            touched: false
        };
    }

    // ---------- model -> settings shape ----------

    function groupJson(g) {
        // Untouched legacy grids save back as rows/cols so the arrangement
        // (uniform worker geometry) is bit-for-bit what it was before.
        if (g.legacy && !g.dirty) {
            return { monitor: g.monitor, rows: g.grid.length, cols: g.grid[0].length };
        }
        return { monitor: g.monitor, areas: g.grid.map(function (row) { return row.map(canonTok).join(' '); }) };
    }
    function presetToJson(p) {
        var o = { name: p.name.trim(), docked: groupJson(p.docked) };
        if (p.floating && p.floating.on) o.floating = groupJson(p.floating);
        o.gap = p.gap;
        return o;
    }
    function allJson() { return presets.map(presetToJson); }
    function liveValid(p) { return !!p && p.name.trim() !== '' && p.docked.monitor >= 1; }

    // ---------- region analysis (validation + mode hint) ----------

    function analyze(grid) {
        var map = {}, order = [];
        for (var r = 0; r < grid.length; r++) {
            for (var c = 0; c < grid[r].length; c++) {
                var t = grid[r][c];
                if (t === '.') continue;
                if (!map[t]) { map[t] = { minR: r, maxR: r, minC: c, maxC: c, n: 0 }; order.push(t); }
                var e = map[t];
                if (r < e.minR) e.minR = r;
                if (r > e.maxR) e.maxR = r;
                if (c < e.minC) e.minC = c;
                if (c > e.maxC) e.maxC = c;
                e.n++;
            }
        }
        var nonRect = [];
        for (var i = 0; i < order.length; i++) {
            var t2 = order[i], e2 = map[t2];
            var ok = e2.n === (e2.maxR - e2.minR + 1) * (e2.maxC - e2.minC + 1);
            for (var rr = e2.minR; rr <= e2.maxR && ok; rr++) {
                for (var cc = e2.minC; cc <= e2.maxC && ok; cc++) {
                    if (grid[rr][cc] !== t2) ok = false;
                }
            }
            if (!ok) nonRect.push(t2);
        }
        var nonTf = [], tfAll = order.length > 0;
        for (var j = 0; j < order.length; j++) {
            if (!TF_SET[canonTok(order[j])]) { tfAll = false; nonTf.push(order[j]); }
        }
        return { map: map, order: order, nonRect: nonRect, nonTf: nonTf, tfAll: tfAll, empty: order.length === 0 };
    }

    function hintText(an) {
        if (an.nonRect.length) {
            return { cls: 'err', text: 'Not rectangular: ' + an.nonRect.join(', ') + ' — every region must be a filled rectangle (the run errors with "area is not rectangular").' };
        }
        if (an.empty) {
            return { cls: 'warn', text: 'Empty grid — every chart in this group would be minimized.' };
        }
        if (an.tfAll) {
            return { cls: 'ok', text: 'Timeframe-match: every region gets the active symbol\\u2019s chart for that timeframe; charts of other symbols are minimized.' };
        }
        return { cls: 'warn', text: 'Order-fill: charts (sorted by title) fill the regions in reading order; extras are minimized. ' + (an.nonTf.length ? '\\u201C' + an.nonTf[0] + '\\u201D is not a timeframe.' : '') };
    }

    function summary(p) {
        function gs(g) { return g.grid.length + '\\u00d7' + g.grid[0].length + ' mon ' + g.monitor; }
        function mode(an, suffix) { return an.empty ? ' empty' : (an.tfAll ? ' ' + suffix + 'TF' : ' ' + suffix + 'fill'); }
        var s = gs(p.docked) + ' \\u00b7' + mode(analyze(p.docked.grid), '');
        if (p.floating && p.floating.on) s += ' \\u00b7 float ' + gs(p.floating) + mode(analyze(p.floating.grid), '');
        return s;
    }

    // ---------- rendering ----------

    function renderAll() {
        renderSidebar();
        renderEditor();
        updateButtons();
    }
    function afterChange() {
        renderSidebar();
        updatePreview();
        updateButtons();
    }

    function renderSidebar() {
        var ul = document.getElementById('presetList');
        var html = '';
        for (var i = 0; i < presets.length; i++) {
            var p = presets[i];
            var flag = '';
            if (p.origInvalid && !p.touched) flag = ' \\u26a0 invalid in settings';
            else if (!liveValid(p)) flag = ' \\u26a0 needs a name';
            html += '<li class="item' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
                '<span class="pname">' + esc(p.name.trim() || '(unnamed)') + '</span>' +
                '<span class="psum">' + esc(summary(p)) + flag + '</span></li>';
        }
        ul.innerHTML = html || '<li class="empty">No presets — click + New.</li>';
    }

    function cardHtml(gi, title, sub) {
        var p = cur();
        var isFloat = gi === 1;
        var on = !isFloat || !!(p.floating && p.floating.on);
        var g = groupOf(p, gi);
        var h = '<section class="card' + (isFloat && !on ? ' off' : '') + '" id="card-' + gi + '" data-gi="' + gi + '">';
        h += '<header><div class="ct"><div class="crow">';
        if (isFloat) h += '<label class="tog"><input type="checkbox" id="floatToggle"' + (on ? ' checked' : '') + '> enable</label>';
        h += '<h3>' + title + '</h3></div><span class="cs">' + sub + '</span></div>';
        h += '<label class="mon">Monitor <input type="number" min="1" max="16" step="1" class="monitor" value="' + (g ? g.monitor : 1) + '"' + (isFloat && !on ? ' disabled' : '') + '></label></header>';
        if (isFloat) h += '<div class="off-note"' + (on ? ' style="display:none"' : '') + '>Off — undocked charts are left untouched.</div>';
        h += '<div class="card-body"' + (isFloat && !on ? ' style="display:none"' : '') + '>';
        h += '<div class="grid"></div>';
        h += '<div class="tools"><button class="tbtn addRow">+ row</button><button class="tbtn delRow">\\u2212 row</button><button class="tbtn addCol">+ col</button><button class="tbtn delCol">\\u2212 col</button><span class="dims"></span></div>';
        h += '<div class="hint"></div></div></section>';
        return h;
    }

    function renderEditor() {
        var p = cur();
        var ed = document.getElementById('editor');
        if (!p) {
            ed.innerHTML = '<div class="noPreset">No presets. Click <b>+ New</b> to paint one.</div>';
            updatePreview();
            return;
        }
        ed.innerHTML =
            '<div class="row name-row">' +
            '<label class="grow">Preset name <input id="presetName" type="text" value="' + esc(p.name) + '" placeholder="e.g. wall"></label>' +
            '<label>Gap (px) <input id="presetGap" type="number" min="0" max="999" step="1" value="' + p.gap + '"></label>' +
            '</div>' +
            cardHtml(0, 'Docked grid', 'charts inside the MT5 window — MT5 moves to this monitor first') +
            cardHtml(1, 'Floating grid', 'charts you undocked in MT5 (their own top-level windows)') +
            '<details class="json" open><summary>settings.json preview (read-only, updates live)</summary><pre id="jsonPreview"></pre></details>';
        renderGroup(0);
        if (p.floating && p.floating.on) renderGroup(1);
        updatePreview();
    }

    function cellClass(t, nonRectSet) {
        var cls = 'cell';
        var ct = canonTok(t);
        if (t === '.') cls += ' empty';
        else if (TF_SET[ct]) cls += (ct.charAt(0) === 'M' && ct !== 'MN1') ? ' tf tf-m' : (ct.charAt(0) === 'H' ? ' tf tf-h' : ' tf tf-d');
        else cls += ' custom';
        if (nonRectSet[t]) cls += ' red';
        return cls;
    }

    function renderGroup(gi) {
        var p = cur();
        if (!p) return;
        var g = groupOf(p, gi);
        var card = document.getElementById('card-' + gi);
        if (!g || !card) return;
        var gridEl = card.querySelector('.grid');
        var an = analyze(g.grid);
        var nonRectSet = {};
        for (var i = 0; i < an.nonRect.length; i++) nonRectSet[an.nonRect[i]] = true;
        var cols = g.grid[0].length;
        var dr0 = -1, dr1 = -1, dc0 = -1, dc1 = -1;
        if (drag && drag.gi === gi) {
            dr0 = Math.min(drag.r0, drag.r1); dr1 = Math.max(drag.r0, drag.r1);
            dc0 = Math.min(drag.c0, drag.c1); dc1 = Math.max(drag.c0, drag.c1);
        }
        var html = '';
        for (var r = 0; r < g.grid.length; r++) {
            for (var c = 0; c < cols; c++) {
                var t = g.grid[r][c];
                var cls = cellClass(t, nonRectSet);
                if (r >= dr0 && r <= dr1 && c >= dc0 && c <= dc1) cls += ' drag';
                html += '<div class="' + cls + '" data-r="' + r + '" data-c="' + c + '" title="' + esc(t === '.' ? 'empty cell — right-click any cell to reset it' : t) + '">' + esc(t === '.' ? '\\u00b7' : t) + '</div>';
            }
        }
        gridEl.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(64px, 1fr))';
        gridEl.innerHTML = html;
        card.querySelector('.dims').textContent = g.grid.length + ' rows \\u00d7 ' + cols + ' cols';
        card.querySelector('.addRow').disabled = g.grid.length >= MAX_ROWS;
        card.querySelector('.delRow').disabled = g.grid.length <= 1;
        card.querySelector('.addCol').disabled = cols >= MAX_COLS;
        card.querySelector('.delCol').disabled = cols <= 1;
        var h = hintText(an);
        var hintEl = card.querySelector('.hint');
        hintEl.className = 'hint ' + h.cls;
        hintEl.textContent = h.text;
    }

    function updatePreview() {
        var pre = document.getElementById('jsonPreview');
        if (!pre) return;
        var p = cur();
        pre.textContent = p ? JSON.stringify(presetToJson(p), null, 4) : '';
    }

    function updateButtons() {
        var has = presets.length > 0;
        document.getElementById('btnDup').disabled = !has;
        document.getElementById('btnDelete').disabled = !has;
        document.getElementById('btnSave').disabled = !has;
        document.getElementById('btnApply').disabled = !has || !liveValid(cur());
    }

    // ---------- palette ----------

    function buildPalette() {
        var html = '<button class="chip" data-tok="." title="empty cell (no chart)">\\u00b7</button>';
        for (var i = 0; i < TF_TOKENS.length; i++) {
            html += '<button class="chip" data-tok="' + TF_TOKENS[i] + '">' + TF_TOKENS[i] + '</button>';
        }
        document.getElementById('palChips').innerHTML = html;
    }
    function updatePaletteSel() {
        var chips = document.getElementById('palChips').children;
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.toggle('sel', chips[i].getAttribute('data-tok') === token);
        }
        var ct = document.getElementById('customTok');
        var t = custom.trim();
        ct.classList.toggle('sel', t !== '' && token === t && !TF_SET[token] && token !== '.');
    }

    // ---------- status ----------

    function status(ok, text) {
        var el = document.getElementById('status');
        el.className = 'status ' + (ok ? 'ok' : 'err');
        el.textContent = (ok ? '\\u2713 ' : '\\u2717 ') + text;
    }

    // ---------- events ----------

    function giOf(el) {
        var card = el.closest('.card');
        return card ? (card.getAttribute('data-gi') === '0' ? 0 : 1) : -1;
    }

    function onEditorInput(e) {
        var p = cur();
        if (!p) return;
        if (e.target.id === 'presetName') {
            p.name = e.target.value;
            markTouched();
            renderSidebar();
            updatePreview();
            updateButtons();
        } else if (e.target.id === 'presetGap') {
            p.gap = clampInt(e.target.value, 0, 999, 0);
            updatePreview();
        } else if (e.target.classList.contains('monitor')) {
            var gi = giOf(e.target);
            var g = groupOf(p, gi);
            if (g) {
                g.monitor = clampInt(e.target.value, 1, 16, 1);
                renderSidebar();
                updatePreview();
            }
        }
    }

    function onEditorChange(e) {
        var p = cur();
        if (!p) return;
        if (e.target.id === 'floatToggle') {
            if (e.target.checked && !p.floating) {
                p.floating = { monitor: 1, grid: blankGrid(2, 2), on: true, legacy: false, dirty: false };
            } else if (p.floating) {
                p.floating.on = e.target.checked;
            }
            markTouched();
            renderEditor();
            afterChange();
        } else if (e.target.id === 'presetGap') {
            p.gap = clampInt(p.gap, 0, 999, 0);
            e.target.value = String(p.gap);
            updatePreview();
        } else if (e.target.classList.contains('monitor')) {
            var gi = giOf(e.target);
            var g = groupOf(p, gi);
            if (g) {
                g.monitor = clampInt(g.monitor, 1, 16, 1);
                e.target.value = String(g.monitor);
            }
        }
    }

    function onEditorClick(e) {
        var b = e.target.closest('.tbtn');
        if (!b) return;
        var p = cur();
        if (!p) return;
        var gi = giOf(b);
        var g = groupOf(p, gi);
        if (!g) return;
        var cls = b.className;
        if (cls.indexOf('addRow') >= 0) {
            var row = [];
            for (var i = 0; i < g.grid[0].length; i++) row.push('.');
            g.grid.push(row);
        } else if (cls.indexOf('delRow') >= 0) {
            if (g.grid.length > 1) g.grid.pop(); else return;
        } else if (cls.indexOf('addCol') >= 0) {
            for (var r = 0; r < g.grid.length; r++) g.grid[r].push('.');
        } else if (cls.indexOf('delCol') >= 0) {
            if (g.grid[0].length > 1) { for (var r2 = 0; r2 < g.grid.length; r2++) g.grid[r2].pop(); } else return;
        } else {
            return;
        }
        g.dirty = true;
        markTouched();
        renderGroup(gi);
        afterChange();
    }

    function onCellMouseDown(e) {
        if (e.button !== 0) return;
        var cell = e.target.closest('.cell');
        if (!cell) return;
        var gi = giOf(cell);
        if (gi < 0) return;
        drag = {
            gi: gi,
            r0: parseInt(cell.getAttribute('data-r'), 10),
            c0: parseInt(cell.getAttribute('data-c'), 10),
            r1: parseInt(cell.getAttribute('data-r'), 10),
            c1: parseInt(cell.getAttribute('data-c'), 10)
        };
        e.preventDefault();   // no text selection while painting
        renderGroup(gi);
    }

    function onCellMouseOver(e) {
        if (!drag) return;
        var cell = e.target.closest('.cell');
        if (!cell) return;
        var gi = giOf(cell);
        if (gi !== drag.gi) return;
        var r = parseInt(cell.getAttribute('data-r'), 10);
        var c = parseInt(cell.getAttribute('data-c'), 10);
        if (r !== drag.r1 || c !== drag.c1) {
            drag.r1 = r;
            drag.c1 = c;
            renderGroup(gi);
        }
    }

    function onWindowMouseUp() {
        if (!drag) return;
        var d = drag;
        drag = null;
        var p = cur();
        var g = groupOf(p, d.gi);
        if (!g) return;
        var r0 = Math.min(d.r0, d.r1), r1 = Math.max(d.r0, d.r1);
        var c0 = Math.min(d.c0, d.c1), c1 = Math.max(d.c0, d.c1);
        for (var r = r0; r <= r1; r++) {
            for (var c = c0; c <= c1; c++) g.grid[r][c] = token;
        }
        g.dirty = true;
        markTouched();
        renderGroup(d.gi);
        afterChange();
    }

    function onCellContext(e) {
        var cell = e.target.closest('.cell');
        if (!cell) return;
        e.preventDefault();
        var gi = giOf(cell);
        var p = cur();
        var g = groupOf(p, gi);
        if (!g) return;
        g.grid[parseInt(cell.getAttribute('data-r'), 10)][parseInt(cell.getAttribute('data-c'), 10)] = '.';
        g.dirty = true;
        markTouched();
        renderGroup(gi);
        afterChange();
    }

    function init() {
        buildPalette();
        renderAll();
        updatePaletteSel();
        status(true, 'Edits stay in this panel until you press Save.');

        document.getElementById('palChips').addEventListener('click', function (e) {
            var b = e.target.closest('.chip');
            if (!b) return;
            token = b.getAttribute('data-tok');
            updatePaletteSel();
        });
        var ct = document.getElementById('customTok');
        ct.addEventListener('input', function () {
            custom = ct.value;
            var t = custom.trim();
            if (t !== '') {
                // Tokens are separated by spaces and rows by '|': a name with
                // either would silently split into multiple cells/rows.
                if (/[\\s|]/.test(t)) {
                    status(false, 'Region names cannot contain spaces or "|" — keeping the previous token.');
                    return;
                }
                var c = canonTok(t);
                if (c !== t) status(true, t + ' \\u2192 painted as ' + c + ' (both spellings work)');
                token = c;
            }
            updatePaletteSel();
        });
        ct.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); ct.blur(); }
        });

        document.getElementById('btnNew').addEventListener('click', function () {
            presets.push({
                name: 'layout ' + (presets.length + 1),
                gap: 0,
                docked: { monitor: 1, grid: blankGrid(2, 3), on: true, legacy: false, dirty: false },
                floating: null,
                origInvalid: false,
                touched: true
            });
            sel = presets.length - 1;
            renderAll();
            status(true, 'Preset added — paint the grid, then Save.');
        });
        document.getElementById('btnDup').addEventListener('click', function () {
            var p = cur();
            if (!p) return;
            var copy = JSON.parse(JSON.stringify(p));
            copy.name = (p.name.trim() || 'layout') + ' copy';
            copy.origInvalid = false;
            copy.touched = true;
            presets.push(copy);
            sel = presets.length - 1;
            renderAll();
        });
        document.getElementById('btnDelete').addEventListener('click', function () {
            if (!presets.length) return;
            presets.splice(sel, 1);
            if (sel >= presets.length) sel = presets.length - 1;
            renderAll();
            status(true, 'Preset deleted (nothing written until Save).');
        });
        document.getElementById('btnSave').addEventListener('click', function () {
            vscode.postMessage({ type: 'save', presets: allJson() });
        });
        document.getElementById('btnApply').addEventListener('click', function () {
            if (!liveValid(cur())) return;
            vscode.postMessage({ type: 'apply', presets: allJson(), index: sel });
        });

        document.getElementById('presetList').addEventListener('click', function (e) {
            var li = e.target.closest('.item');
            if (!li) return;
            sel = parseInt(li.getAttribute('data-i'), 10);
            renderAll();
        });

        var ed = document.getElementById('editor');
        ed.addEventListener('input', onEditorInput);
        ed.addEventListener('change', onEditorChange);
        ed.addEventListener('click', onEditorClick);
        ed.addEventListener('mousedown', onCellMouseDown);
        ed.addEventListener('mouseover', onCellMouseOver);
        ed.addEventListener('contextmenu', onCellContext);
        window.addEventListener('mouseup', onWindowMouseUp);
        window.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && drag) {
                var gi = drag.gi;
                drag = null;
                renderGroup(gi);
            }
        });

        window.addEventListener('message', function (e) {
            var m = e.data;
            if (!m) return;
            if (m.type === 'saveResult' || m.type === 'applyResult') status(m.ok, m.message);
        });
    }

    init();
})();
</script>
</body>
</html>`;
    }
}

function createOrShow(context) {
    ChartLayoutEditorPanel.createOrShow(context);
}

module.exports = { createOrShow };
