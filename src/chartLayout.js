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

// Coerce a grid block {monitor,rows,cols} into safe integers; null if unusable.
function normalizeGrid(g) {
    if (!g) return null;
    const monitor = Math.trunc(Number(g.monitor)) || 0;
    const rows = Math.trunc(Number(g.rows)) || 0;
    const cols = Math.trunc(Number(g.cols)) || 0;
    if (monitor < 1 || rows < 1 || cols < 1) return null;
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

function buildArgs(scriptPath, preset) {
    const f = preset.floating;
    return [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-DockMonitor', String(preset.docked.monitor),
        '-DockRows', String(preset.docked.rows),
        '-DockCols', String(preset.docked.cols),
        '-FloatMonitor', String(f ? f.monitor : 0),
        '-FloatRows', String(f ? f.rows : 1),
        '-FloatCols', String(f ? f.cols : 1),
        '-Gap', String(preset.gap),
    ];
}

function runArrangeScript(scriptPath, preset) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', buildArgs(scriptPath, preset), { windowsHide: true }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (out.startsWith('OK')) return resolve(out);
            const detail = out || String(stderr || '').trim() || (err && err.message) || 'unknown error';
            reject(new Error(detail.replace(/^ERROR\s*/, '')));
        });
    });
}

function describe(preset) {
    const d = preset.docked;
    let s = `docked ${d.rows}×${d.cols} on mon ${d.monitor}`;
    if (preset.floating) {
        const f = preset.floating;
        s += `  •  floating ${f.rows}×${f.cols} on mon ${f.monitor}`;
    }
    return s;
}

async function ArrangeCharts(context) {
    if (process.platform !== 'win32') {
        vscode.window.showWarningMessage('Arrange MT5 Charts is Windows-only (it positions native MT5 windows).');
        return;
    }

    const presets = getPresets().map(normalizePreset).filter(Boolean);
    if (presets.length === 0) {
        vscode.window.showErrorMessage('No valid chart-layout presets. Each needs a name and a docked grid (monitor ≥ 1, rows ≥ 1, cols ≥ 1). Check mql_tools.ChartLayout.Presets.');
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
        vscode.window.showInformationMessage(result.replace(/^OK\s*/, 'Charts arranged — '));
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
