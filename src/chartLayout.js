'use strict';

// MQL: Arrange MT5 Charts
//
// Tiles MetaTrader 5 chart windows according to user-defined named presets.
// Each preset has two independent groups:
//
//   docked   - charts docked inside the MT5 main window. Tiled into a grid
//              there; the main window is first moved to `docked.monitor`.
//   floating - charts that have been undocked (right-click chart > uncheck
//              "Docked"). They become free top-level windows, so they can be
//              tiled onto ANY other monitor via `floating.{monitor,rows,cols}`.
//
// Detection is automatic (see scripts/mt5-arrange-charts.ps1). Omit `floating`
// to leave undocked charts untouched.
//
// Windows-only: it manipulates native MT5 windows via user32.dll. Under Wine the
// host has no such windows to arrange, so the command is a no-op there.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const STATUS_SETTING = 'mql_tools.ChartLayout.ShowStatusBarButton';
let statusItem = null;

// Fallbacks used when the user has not configured any presets.
const DEFAULT_PRESETS = [
    { name: 'wall', docked: { monitor: 1, rows: 2, cols: 3 }, gap: 0 },
    { name: 'quad', docked: { monitor: 1, rows: 2, cols: 2 }, gap: 0 },
    { name: 'focus', docked: { monitor: 1, rows: 1, cols: 1 }, gap: 0 },
];

function getPresets() {
    const raw = vscode.workspace.getConfiguration('mql_tools').get('ChartLayout.Presets');
    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PRESETS;
    return raw;
}

// A grid-template-areas value is an array of non-empty row strings; null if not.
function normalizeAreas(a) {
    if (!Array.isArray(a)) return null;
    const rows = a.map(r => String(r).trim()).filter(r => r !== '');
    return rows.length ? rows : null;
}

// Coerce a grid block into {monitor, areas} or {monitor, rows, cols}; null if unusable.
// `areas` (CSS grid-template-areas) wins over rows/cols when present.
function normalizeGrid(g) {
    if (!g) return null;
    const monitor = Math.trunc(Number(g.monitor)) || 0;
    if (monitor < 1) return null;
    const areas = normalizeAreas(g.areas);
    if (areas) return { monitor, areas };
    const rows = Math.trunc(Number(g.rows)) || 0;
    const cols = Math.trunc(Number(g.cols)) || 0;
    if (rows < 1 || cols < 1) return null;
    return { monitor, rows, cols };
}

// Coerce a configured preset; returns null if the (required) docked grid is bad.
function normalizePreset(p) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return null;
    const docked = normalizeGrid(p.docked);
    if (!docked) return null;
    const floating = normalizeGrid(p.floating); // optional
    const gap = Math.max(0, Math.trunc(Number(p.gap)) || 0);
    return { name: p.name.trim(), docked, floating, gap };
}

// CLI args for one grid group. `grid` is null when a floating group is absent
// (monitor 0 tells the worker to skip it). Areas are passed only when present;
// the worker prefers areas over rows/cols.
function gridArgs(prefix, grid) {
    const monitor = grid ? grid.monitor : 0;
    const rows = grid && grid.rows ? grid.rows : 1;
    const cols = grid && grid.cols ? grid.cols : 1;
    const a = [`-${prefix}Monitor`, String(monitor), `-${prefix}Rows`, String(rows), `-${prefix}Cols`, String(cols)];
    if (grid && grid.areas) a.push(`-${prefix}Areas`, grid.areas.join('|'));
    return a;
}

function buildArgs(scriptPath, preset) {
    return [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        ...gridArgs('Dock', preset.docked),
        ...gridArgs('Float', preset.floating),
        '-Gap', String(preset.gap),
    ];
}

// Resolve the system PowerShell by absolute path so we don't rely on PATH /
// current-directory search order (which could run a hijacked powershell.exe in
// an untrusted workspace). Fall back to the bare name only if it's missing.
function resolvePowershell() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(abs) ? abs : 'powershell.exe';
}

function runArrangeScript(scriptPath, preset) {
    return new Promise((resolve, reject) => {
        execFile(resolvePowershell(), buildArgs(scriptPath, preset), { windowsHide: true }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (out.startsWith('OK')) return resolve(out);
            const detail = out || String(stderr || '').trim() || (err && err.message) || 'unknown error';
            reject(new Error(detail.replace(/^ERROR\s*/, '')));
        });
    });
}

function gridLabel(g) {
    return g.areas ? `areas (${g.areas.length} rows)` : `${g.rows}×${g.cols}`;
}

function describe(preset) {
    let s = `docked ${gridLabel(preset.docked)} on mon ${preset.docked.monitor}`;
    if (preset.floating) s += `  •  floating ${gridLabel(preset.floating)} on mon ${preset.floating.monitor}`;
    return s;
}

async function ArrangeCharts(context) {
    if (process.platform !== 'win32') {
        vscode.window.showWarningMessage('Arrange MT5 Charts is Windows-only (it positions native MT5 windows).');
        return;
    }

    const presets = getPresets().map(normalizePreset).filter(Boolean);
    if (presets.length === 0) {
        vscode.window.showErrorMessage('No valid chart-layout presets. Each needs a name and a docked grid: monitor ≥ 1 plus either rows ≥ 1 and cols ≥ 1, or an areas template. Check mql_tools.ChartLayout.Presets.');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        presets.map(p => ({ label: p.name, detail: describe(p), preset: p })),
        { placeHolder: 'Select a chart layout preset' }
    );
    if (!pick) return;

    const scriptPath = path.join(context.extensionPath, 'scripts', 'mt5-arrange-charts.ps1');
    try {
        const result = await runArrangeScript(scriptPath, pick.preset);
        updateStatusLabel(pick.preset.name);
        // Transient success notification: shows in the status bar and auto-
        // dismisses after 4s instead of lingering as a dismissable toast.
        vscode.window.setStatusBarMessage(result.replace(/^OK\s*/, 'Charts arranged — '), 4000);
    } catch (e) {
        vscode.window.showErrorMessage(`Arrange MT5 Charts failed: ${e.message}`);
    }
}

// --- status bar quick-switch ---

function updateStatusLabel(name) {
    if (statusItem) statusItem.text = `$(multiple-windows) ${name}`;
}

function applyStatusVisibility() {
    if (!statusItem) return;
    const show = vscode.workspace.getConfiguration('mql_tools').get('ChartLayout.ShowStatusBarButton', true);
    if (show) statusItem.show(); else statusItem.hide();
}

// Create the "Charts" status-bar button (Windows only). Clicking it opens the
// preset picker; the label shows the last preset applied this session.
function createStatusBar(context) {
    if (process.platform !== 'win32') return;
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    statusItem.command = 'mql_tools.arrangeCharts';
    statusItem.text = '$(multiple-windows) Charts';
    statusItem.tooltip = 'Arrange MT5 Charts — pick a layout preset';
    context.subscriptions.push(statusItem);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(STATUS_SETTING)) applyStatusVisibility();
        })
    );
    applyStatusVisibility();
}

module.exports = { ArrangeCharts, createStatusBar, DEFAULT_PRESETS };
