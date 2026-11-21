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
// Kept as the module object (not destructured) so tests can stub execFile.
const childProcess = require('child_process');

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
// An optional mt5Path (full path to a terminal64.exe) pins the preset to one
// MT5 instance and is carried through verbatim when non-empty.
function normalizePreset(p) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return null;
    const docked = normalizeGrid(p.docked);
    if (!docked) return null;
    const floating = normalizeGrid(p.floating); // optional
    const gap = Math.max(0, Math.trunc(Number(p.gap)) || 0);
    const out = { name: p.name.trim(), docked, floating, gap };
    const mt5Path = typeof p.mt5Path === 'string' ? p.mt5Path.trim() : '';
    if (mt5Path) out.mt5Path = mt5Path;
    return out;
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

// Full worker command line. `pid` (from the instance picker) and
// preset.mt5Path (pinned instance) are appended only when present; the worker
// resolves the target as: -Mt5Pid > -Mt5Path > first instance found.
function buildArgs(scriptPath, preset, pid) {
    const a = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        ...gridArgs('Dock', preset.docked),
        ...gridArgs('Float', preset.floating),
        '-Gap', String(preset.gap),
    ];
    if (preset.mt5Path) a.push('-Mt5Path', preset.mt5Path);
    if (pid > 0) a.push('-Mt5Pid', String(Math.trunc(pid)));
    return a;
}

// Resolve the system PowerShell by absolute path so we don't rely on PATH /
// current-directory search order (which could run a hijacked powershell.exe in
// an untrusted workspace). Fall back to the bare name only if it's missing.
function resolvePowershell() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(abs) ? abs : 'powershell.exe';
}

function runArrangeScript(scriptPath, preset, pid) {
    return new Promise((resolve, reject) => {
        childProcess.execFile(resolvePowershell(), buildArgs(scriptPath, preset, pid), { windowsHide: true }, (err, stdout, stderr) => {
            const out = String(stdout || '').trim();
            if (out.startsWith('OK')) return resolve(out);
            const detail = out || String(stderr || '').trim() || (err && err.message) || 'unknown error';
            reject(new Error(detail.replace(/^ERROR\s*/, '')));
        });
    });
}

// Probe the running MT5 instances via the worker's -ListInstances mode.
// Resolves to [{pid, title, path}] (path '' when the process is elevated or
// in another session); rejects when the probe itself fails.
function listMt5Instances(scriptPath) {
    return new Promise((resolve, reject) => {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ListInstances'];
        childProcess.execFile(resolvePowershell(), args, { windowsHide: true }, (err, stdout, stderr) => {
            if (err && !stdout) {
                return reject(new Error(String(stderr || '').trim() || err.message || 'instance probe failed'));
            }
            try {
                const list = JSON.parse(String(stdout || '').trim());
                if (!Array.isArray(list)) throw new Error('unexpected probe output');
                resolve(list.map(i => ({
                    pid: Number(i.pid) || 0,
                    title: String(i.title || ''),
                    path: String(i.path || ''),
                })));
            } catch (e) {
                reject(new Error(`cannot parse MT5 instance list: ${e.message}`));
            }
        });
    });
}

// Decide which running MT5 instance to arrange.
// - Preset pinned via mt5Path: the worker matches the process by exe path; no
//   probe needed (returns {pid: 0, path: <pinned path>}).
// - Single instance running: auto-selected, no prompt.
// - Several instances: QuickPick (window title / exe path / pid).
// Returns {pid, path} (pid 0 = let the worker match by path), or null when the
// user dismissed the picker. Throws when no instance is running.
async function resolveInstance(preset, scriptPath) {
    if (preset && preset.mt5Path) return { pid: 0, path: preset.mt5Path };
    const instances = await listMt5Instances(scriptPath);
    if (instances.length === 0) throw new Error('MT5 (terminal64) not running');
    if (instances.length === 1) return { pid: instances[0].pid, path: instances[0].path };
    const choice = await vscode.window.showQuickPick(
        instances.map(i => ({
            label: i.title || `MetaTrader 5 — pid ${i.pid}`,
            description: `pid ${i.pid}`,
            detail: i.path || '(exe path unavailable — elevated or other user session)',
            pid: i.pid,
            path: i.path,
        })),
        { placeHolder: 'Several MT5 instances are running — which terminal should be arranged?', matchOnDetail: true }
    );
    return choice ? { pid: choice.pid, path: choice.path } : null;
}

// Backend dispatcher: on Windows the PowerShell worker moves the windows; on
// Wine / Linux / macOS the in-terminal ArrangeLayoutService does it via flag
// files (see chartLayoutWine.js). Returns { result, pinOffer } — pinOffer is
// set only when the instance was chosen interactively and can be pinned via
// mt5Path. Returns null when the user dismissed the instance picker.
async function arrangeViaBackend(context, preset) {
    const scriptPath = path.join(context.extensionPath, 'scripts', 'mt5-arrange-charts.ps1');
    if (process.platform === 'win32') {
        const target = await resolveInstance(preset, scriptPath);
        if (!target) return null;                       // picker dismissed
        const result = await runArrangeScript(scriptPath, preset, target.pid);
        const pinOffer = (target.pid > 0 && target.path) ? { path: target.path } : null;
        return { result, pinOffer };
    }
    const wine = require('./chartLayoutWine');
    const include5 = vscode.workspace.getConfiguration('mql_tools').get('Metaeditor.Include5Dir', '');
    if (!include5) {
        throw new Error('mql_tools.Metaeditor.Include5Dir is not set — the Wine backend needs it to locate the terminal\'s MQL5/Files folder');
    }
    if (preset.mt5Path) {
        vscode.window.showInformationMessage('Preset "mt5Path" pinning applies to the Windows backend — under Wine the terminal configured via Include5Dir is targeted.');
    }
    const result = await wine.runArrangeViaService(path.join(include5, 'Files'), preset);
    return { result, pinOffer: null };
}

function gridLabel(g) {
    return g.areas ? `areas (${g.areas.length} rows)` : `${g.rows}×${g.cols}`;
}

function describe(preset) {
    let s = `docked ${gridLabel(preset.docked)} on mon ${preset.docked.monitor}`;
    if (preset.floating) s += `  •  floating ${gridLabel(preset.floating)} on mon ${preset.floating.monitor}`;
    if (preset.mt5Path) s += `  •  pinned to ${path.basename(path.dirname(preset.mt5Path)) || preset.mt5Path}`;
    return s;
}

async function ArrangeCharts(context) {
    const presets = getPresets().map(normalizePreset).filter(Boolean);
    if (presets.length === 0) {
        vscode.window.showErrorMessage('No valid chart-layout presets. Each needs a name and a docked grid: monitor ≥ 1 plus either rows ≥ 1 and cols ≥ 1, or an areas template. Check mql_tools.ChartLayout.Presets.');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        [
            ...presets.map(p => ({ label: p.name, detail: describe(p), preset: p })),
            { label: '$(gear) Configure presets visually…', detail: 'Open the visual chart-layout editor', edit: true },
        ],
        { placeHolder: 'Select a chart layout preset' }
    );
    if (!pick) return;
    // Lazy require: the editor needs this module's helpers, so pulling it in at
    // the top would create a require cycle at load time.
    if (pick.edit) {
        require('./chartLayoutEditor').createOrShow(context);
        return;
    }

    // Which MT5 instance / backend: pinned via the preset's mt5Path, the only
    // one running, or the user's picker choice (Windows); the Wine backend
    // targets the configured terminal instead (see arrangeViaBackend).
    let run;
    try {
        run = await arrangeViaBackend(context, pick.preset);
    } catch (e) {
        vscode.window.showErrorMessage(`Arrange MT5 Charts failed: ${e.message}`);
        return;
    }
    if (!run) return;

    try {
        const result = run.result;
        updateStatusLabel(pick.preset.name);
        vscode.window.showInformationMessage(result.replace(/^OK\s*/, 'Charts arranged — '));
        // Chosen interactively (several instances ran) and the exe path is
        // known: offer a ready-to-paste snippet that pins this preset to the
        // chosen terminal, so next time no picker is needed.
        if (run.pinOffer) {
            const pin = await vscode.window.showInformationMessage(
                `Pin preset "${pick.preset.name}" to this MT5 instance?`,
                'Copy "mt5Path" snippet'
            );
            if (pin) {
                await vscode.env.clipboard.writeText(`"mt5Path": ${JSON.stringify(run.pinOffer.path)}`);
                vscode.window.showInformationMessage('Snippet copied — paste it into this preset entry in settings.json to always target this terminal.');
            }
        }
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

module.exports = {
    ArrangeCharts,
    arrangeViaBackend,
    buildArgs,
    createStatusBar,
    DEFAULT_PRESETS,
    getPresets,
    listMt5Instances,
    normalizeGrid,
    normalizePreset,
    resolveInstance,
    runArrangeScript,
    updateStatusLabel,
};
