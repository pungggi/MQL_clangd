'use strict';

// MetaEditor GUI compile: the second half of "Compile MQL file using script".
//
// MetaTrader reloads an EA/indicator that runs on a chart only after a compile
// that went through the MetaEditor UI (the program is re-initialised with
// REASON_RECOMPILE). The command-line compile that feeds the Problems panel
// rewrites the .ex4/.ex5 but leaves the charts on the old build, which is what
// issue #77 reports. So after a clean command-line compile the file is opened
// in MetaEditor and Compile (F7) is pressed there, the way the original MQL
// Tools extension did it.
//
// The window handling lives in scripts/metaeditor-gui-compile.ps1 (it needs
// user32.dll). This module starts that worker and turns its one-line report
// into a result object.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolvePowershell } = require('./powershell');

const WORKER_SCRIPT = 'metaeditor-gui-compile.ps1';

// Bounds handed to the worker. MetaEditor shows the file within a couple of
// seconds of the launch (also on a cold start) and the GUI compile of a file
// that just compiled on the command line takes well under that. Both waits run
// asynchronously in the worker, they never block VS Code.
const DEFAULT_WINDOW_TIMEOUT_MS = 20000;
const DEFAULT_RESULT_TIMEOUT_MS = 20000;
// PowerShell start-up and the worker's Add-Type compile happen before the
// worker's own clock starts; this margin keeps the execFile timeout from firing
// first.
const WORKER_OVERHEAD_MS = 30000;

/** Absolute path of the bundled worker script. */
function workerPath(context) {
    return path.join(context.extensionPath, 'scripts', WORKER_SCRIPT);
}

/**
 * Command line for the worker. `portable` adds the switch as its own flag so
 * the worker passes `/portable` on to MetaEditor, like OpenFileInMetaEditor.
 */
function buildWorkerArgs(scriptPath, { metaEditor, sourceFile, portable = false,
    windowTimeoutMs = DEFAULT_WINDOW_TIMEOUT_MS, resultTimeoutMs = DEFAULT_RESULT_TIMEOUT_MS }) {
    const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        '-MetaEditor', metaEditor, '-SourceFile', sourceFile];
    if (portable) a.push('-Portable');
    a.push('-WindowTimeoutMs', String(windowTimeoutMs), '-ResultTimeoutMs', String(resultTimeoutMs));
    return a;
}

/**
 * Parse the worker's last stdout line:
 *   OK compiled   pid=<n> window-ms=<n> bin-ms=<n> focus=<none|restored|kept> handoff=<none|exited|timeout> mods-ms=<n> already-open=<0|1>
 *   OK triggered  pid=<n> window-ms=<n> bin-ms=-1 ...
 *   ERROR <reason>
 *
 * @returns {{ok: boolean, status: string, detail: string, pid?: number,
 *            windowMs?: number, binaryMs?: number, focus?: string,
 *            handoff?: string, modsMs?: number, alreadyOpen?: boolean}}
 */
function parseWorkerResult(stdout) {
    const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    if (last.startsWith('ERROR')) {
        return { ok: false, status: 'error', detail: last.replace(/^ERROR\s*/, '') };
    }
    if (!last.startsWith('OK')) {
        return { ok: false, status: 'error', detail: '' };
    }
    const fields = {};
    for (const m of last.matchAll(/(\S+)=([^\s]+)/g)) fields[m[1]] = m[2];
    return {
        ok: true,
        status: last.split(/\s+/)[1] === 'compiled' ? 'compiled' : 'triggered',
        pid: Number(fields.pid) || 0,
        windowMs: Number(fields['window-ms']) || 0,
        binaryMs: fields['bin-ms'] === undefined ? -1 : (Number(fields['bin-ms']) || -1),
        focus: fields.focus || 'none',
        handoff: fields.handoff || 'none',
        modsMs: fields['mods-ms'] === undefined ? 0 : (Number(fields['mods-ms']) || 0),
        alreadyOpen: fields['already-open'] === '1',
    };
}

/**
 * Open `sourceFile` in the MetaEditor GUI and press Compile there.
 *
 * @param {object} options
 * @param {object} options.context          Extension context (locates the worker script)
 * @param {string} options.metaEditor       Full path to metaeditor.exe / metaeditor64.exe
 * @param {string} options.sourceFile       Absolute path of the .mq4/.mq5 file
 * @param {boolean} [options.portable]      Launch MetaEditor with /portable
 * @param {number} [options.windowTimeoutMs]
 * @param {number} [options.resultTimeoutMs] 0 skips the confirmation wait
 * @returns {Promise<object>} The parsed worker result; `ok` is false for
 *   'error' (worker failed) and 'unsupported' (not on Windows).
 */
function runMetaEditorGuiCompile({ context, metaEditor, sourceFile, portable = false, windowTimeoutMs,
    resultTimeoutMs, execFile = childProcess.execFile }) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve({ ok: false, status: 'unsupported', detail: 'MetaEditor GUI compile is only available on Windows' });
            return;
        }
        if (!context || !context.extensionPath) {
            resolve({ ok: false, status: 'error', detail: 'extension context unavailable' });
            return;
        }
        const scriptPath = workerPath(context);
        if (!fs.existsSync(scriptPath)) {
            resolve({ ok: false, status: 'error', detail: `worker script not found: ${scriptPath}` });
            return;
        }
        const winMs = Number(windowTimeoutMs) > 0 ? Number(windowTimeoutMs) : DEFAULT_WINDOW_TIMEOUT_MS;
        const resMs = resultTimeoutMs === undefined ? DEFAULT_RESULT_TIMEOUT_MS : Math.max(0, Number(resultTimeoutMs) || 0);
        const args = buildWorkerArgs(scriptPath, {
            metaEditor, sourceFile, portable, windowTimeoutMs: winMs, resultTimeoutMs: resMs,
        });
        const options = { windowsHide: true, timeout: winMs + resMs + WORKER_OVERHEAD_MS };
        execFile(resolvePowershell(), args, options, (err, stdout, stderr) => {
            const result = parseWorkerResult(stdout);
            if (!result.ok && !result.detail) {
                result.detail = String(stderr || '').trim() || (err && err.message) || 'worker produced no result';
            }
            resolve(result);
        });
    });
}

function seconds(ms) {
    return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * One output-channel line describing a worker result. A triggered compile whose
 * binary did not change is reported as a warning: MetaEditor usually compiled a
 * different tab or showed a dialog, and nothing was reloaded on the charts.
 */
function describeGuiCompileResult(result, { fileName, binaryName, waitedForBinary = true }) {
    if (result.status === 'compiled') {
        return `[Info] MetaEditor GUI compile: Compile (F7) sent to "${fileName}" after ${seconds(result.windowMs)}, ` +
            `${binaryName} rewritten ${seconds(result.binaryMs)} later. MetaTrader reloads the programs running on its ` +
            `charts after a MetaEditor compile.${result.alreadyOpen ? ' The file name was already open in MetaEditor, the hand-over to the running instance was awaited first.' : ''}`;
    }
    const sent = `[${waitedForBinary ? 'Warning' : 'Info'}] MetaEditor GUI compile: Compile (F7) sent to "${fileName}" after ${seconds(result.windowMs)}`;
    if (result.status === 'triggered') {
        return waitedForBinary
            ? `${sent}, but ${binaryName} was not rewritten within the wait time. Check which tab MetaEditor compiled and its Toolbox; nothing was reloaded on the charts.`
            : `${sent}. MetaTrader reloads the programs running on its charts after a MetaEditor compile.`;
    }
    return `[Error] MetaEditor GUI compile failed for "${fileName}": ${result.detail}`;
}

module.exports = {
    DEFAULT_RESULT_TIMEOUT_MS,
    DEFAULT_WINDOW_TIMEOUT_MS,
    WORKER_SCRIPT,
    buildWorkerArgs,
    describeGuiCompileResult,
    parseWorkerResult,
    runMetaEditorGuiCompile,
    workerPath,
};
