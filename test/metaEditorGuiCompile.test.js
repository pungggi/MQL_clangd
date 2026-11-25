'use strict';

// Unit tests for the MetaEditor GUI compile behind "Compile MQL file using
// script" (MQL_clangd#77): worker command line, result parsing, the execFile
// call, the output line, and the branch decision in compilePath().

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CONTEXT = { extensionPath: path.resolve(__dirname, '..') };
const INPUTS = { context: CONTEXT, metaEditor: 'C:\\MT5\\metaeditor64.exe', sourceFile: 'C:\\MQL5\\Experts\\My EA.mq5' };

function freshModule() {
    delete require.cache[require.resolve('../src/metaEditorGuiCompile.js')];
    return require('../src/metaEditorGuiCompile.js');
}

function stubExecFile(fn) {
    const orig = childProcess.execFile;
    childProcess.execFile = fn;
    return () => { childProcess.execFile = orig; };
}

// The unit tests also run on the ubuntu CI runner, where the module reports
// 'unsupported' and resolvePowershell() falls back to the bare name. Tests that
// exercise the Windows path stub the platform (and the SystemRoot lookup).
async function withPlatform(value, fn) {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
        return await fn();
    } finally {
        Object.defineProperty(process, 'platform', desc);
    }
}

// Make resolvePowershell() find C:\Windows\System32\...\powershell.exe on any host.
function stubSystemPowershell() {
    const hadRoot = Object.prototype.hasOwnProperty.call(process.env, 'SystemRoot');
    const root = process.env.SystemRoot;
    if (!hadRoot) process.env.SystemRoot = 'C:\\Windows';
    const origExists = fs.existsSync;
    fs.existsSync = (p) => (typeof p === 'string' && p.toLowerCase() === POWERSHELL.toLowerCase()) || origExists(p);
    return () => {
        if (!hadRoot) delete process.env.SystemRoot; else process.env.SystemRoot = root;
        fs.existsSync = origExists;
    };
}

suite('metaEditorGuiCompile', () => {
    suite('buildWorkerArgs', () => {
        test('passes the worker script, MetaEditor and source file as named parameters', () => {
            const m = freshModule();
            const argv = m.buildWorkerArgs('C:\\ext\\scripts\\metaeditor-gui-compile.ps1', INPUTS);
            assert.deepStrictEqual(argv.slice(0, 9), [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\ext\\scripts\\metaeditor-gui-compile.ps1',
                '-MetaEditor', 'C:\\MT5\\metaeditor64.exe', '-SourceFile', 'C:\\MQL5\\Experts\\My EA.mq5',
            ]);
            assert.strictEqual(argv[argv.indexOf('-WindowTimeoutMs') + 1], String(m.DEFAULT_WINDOW_TIMEOUT_MS));
            assert.strictEqual(argv[argv.indexOf('-ResultTimeoutMs') + 1], String(m.DEFAULT_RESULT_TIMEOUT_MS));
        });

        test('adds -Portable only when requested and keeps the timeouts in order', () => {
            const m = freshModule();
            assert.ok(!m.buildWorkerArgs('s.ps1', INPUTS).includes('-Portable'));
            const argv = m.buildWorkerArgs('s.ps1', { ...INPUTS, portable: true, windowTimeoutMs: 5000, resultTimeoutMs: 0 });
            assert.deepStrictEqual(argv.slice(-5), ['-Portable', '-WindowTimeoutMs', '5000', '-ResultTimeoutMs', '0']);
            assert.strictEqual(argv.filter((a) => a === '-Portable').length, 1);
        });
    });

    suite('parseWorkerResult', () => {
        test('OK compiled line becomes a successful result with timings', () => {
            const m = freshModule();
            const r = m.parseWorkerResult('noise\r\nOK compiled  pid=29932 window-ms=1496 bin-ms=439 focus=restored handoff=exited mods-ms=40 already-open=1\r\n');
            assert.deepStrictEqual(r, { ok: true, status: 'compiled', pid: 29932, windowMs: 1496, binaryMs: 439, focus: 'restored', handoff: 'exited', modsMs: 40, alreadyOpen: true });
        });

        test('OK triggered line (binary not seen rewritten) is still a success', () => {
            const m = freshModule();
            const r = m.parseWorkerResult('OK triggered pid=0 window-ms=1355 bin-ms=-1 focus=none');
            assert.strictEqual(r.ok, true);
            assert.strictEqual(r.status, 'triggered');
            assert.strictEqual(r.binaryMs, -1);
            assert.strictEqual(r.pid, 0);
            // Fields the older worker lines did not carry get neutral defaults.
            assert.strictEqual(r.handoff, 'none');
            assert.strictEqual(r.modsMs, 0);
            assert.strictEqual(r.alreadyOpen, false);
        });

        test('ERROR line keeps the reason as detail', () => {
            const m = freshModule();
            const r = m.parseWorkerResult('ERROR window-timeout: no MetaEditor window within 20000 ms');
            assert.deepStrictEqual(r, { ok: false, status: 'error', detail: 'window-timeout: no MetaEditor window within 20000 ms' });
        });

        test('empty or unexpected output is an error without detail (caller adds stderr)', () => {
            const m = freshModule();
            for (const out of ['', '\r\n', 'something else']) {
                const r = m.parseWorkerResult(out);
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.status, 'error');
                assert.strictEqual(r.detail, '');
            }
        });
    });

    suite('runMetaEditorGuiCompile', () => {
        test('runs the bundled worker through the absolute system PowerShell with a hidden console', async () => {
            const m = freshModule();
            let call = null;
            const restore = stubExecFile((cmd, args, opts, cb) => {
                call = { cmd, args, opts };
                cb(null, 'OK compiled pid=7 window-ms=1200 bin-ms=400 focus=none\n', '');
            });
            const restorePs = stubSystemPowershell();
            let r;
            try {
                r = await withPlatform('win32', () => m.runMetaEditorGuiCompile(INPUTS));
            } finally { restore(); restorePs(); }
            assert.strictEqual(call.cmd, POWERSHELL);
            assert.strictEqual(call.opts.windowsHide, true);
            assert.strictEqual(call.opts.timeout, m.DEFAULT_WINDOW_TIMEOUT_MS + m.DEFAULT_RESULT_TIMEOUT_MS + 30000);
            assert.deepStrictEqual(call.args, m.buildWorkerArgs(m.workerPath(CONTEXT), INPUTS));
            assert.ok(call.args[4].endsWith(path.join('scripts', 'metaeditor-gui-compile.ps1')));
            assert.deepStrictEqual(r, { ok: true, status: 'compiled', pid: 7, windowMs: 1200, binaryMs: 400, focus: 'none', handoff: 'none', modsMs: 0, alreadyOpen: false });
        });

        test('a failed worker resolves to ok=false with the worker reason', async () => {
            const m = freshModule();
            const restore = stubExecFile((cmd, args, opts, cb) => cb(new Error('exit 1'), 'ERROR post-failed: nope', ''));
            try {
                const r = await withPlatform('win32', () => m.runMetaEditorGuiCompile(INPUTS));
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.detail, 'post-failed: nope');
            } finally { restore(); }
        });

        test('falls back to stderr, then to the exec error, when the worker prints nothing', async () => {
            const m = freshModule();
            let r;
            let restore = stubExecFile((cmd, args, opts, cb) => cb(new Error('killed'), '', 'Add-Type : compile error'));
            try {
                r = await withPlatform('win32', () => m.runMetaEditorGuiCompile(INPUTS));
            } finally { restore(); }
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.detail, 'Add-Type : compile error');

            restore = stubExecFile((cmd, args, opts, cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', ''));
            try {
                r = await withPlatform('win32', () => m.runMetaEditorGuiCompile(INPUTS));
            } finally { restore(); }
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.detail, 'timeout');
        });

        test('passes the portable switch and an explicit result timeout through', async () => {
            const m = freshModule();
            let args = null;
            const restore = stubExecFile((cmd, a, opts, cb) => { args = a; cb(null, 'OK triggered pid=1 window-ms=10 bin-ms=-1 focus=none', ''); });
            try {
                await withPlatform('win32', () => m.runMetaEditorGuiCompile({ ...INPUTS, portable: true, resultTimeoutMs: 0, windowTimeoutMs: 1000 }));
            } finally { restore(); }
            assert.ok(args.includes('-Portable'));
            assert.strictEqual(args[args.indexOf('-ResultTimeoutMs') + 1], '0');
            assert.strictEqual(args[args.indexOf('-WindowTimeoutMs') + 1], '1000');
        });

        test('a missing worker script is reported without starting PowerShell', async () => {
            const m = freshModule();
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-gui-compile-'));
            const restore = stubExecFile(() => { throw new Error('execFile must not run'); });
            try {
                const r = await withPlatform('win32', () => m.runMetaEditorGuiCompile({ ...INPUTS, context: { extensionPath: tmp } }));
                assert.strictEqual(r.ok, false);
                assert.match(r.detail, /worker script not found/);
            } finally { restore(); fs.rmSync(tmp, { recursive: true, force: true }); }
        });

        test('a missing extension context is reported without starting PowerShell', async () => {
            const m = freshModule();
            const restore = stubExecFile(() => { throw new Error('execFile must not run'); });
            try {
                const r = await withPlatform('win32', () => m.runMetaEditorGuiCompile({ ...INPUTS, context: undefined }));
                assert.deepStrictEqual(r, { ok: false, status: 'error', detail: 'extension context unavailable' });
            } finally { restore(); }
        });

        test('does nothing outside Windows', async () => {
            const m = freshModule();
            const restore = stubExecFile(() => { throw new Error('execFile must not run'); });
            try {
                const r = await withPlatform('linux', () => m.runMetaEditorGuiCompile(INPUTS));
                assert.strictEqual(r.ok, false);
                assert.strictEqual(r.status, 'unsupported');
            } finally { restore(); }
        });

        test('the worker script ships next to the chart-layout worker', () => {
            assert.ok(fs.existsSync(path.join(CONTEXT.extensionPath, 'scripts', 'metaeditor-gui-compile.ps1')));
            const ignore = fs.readFileSync(path.join(CONTEXT.extensionPath, '.vscodeignore'), 'utf8');
            assert.ok(ignore.includes('!scripts/metaeditor-gui-compile.ps1'), '.vscodeignore must re-include the worker');
        });
    });

    suite('describeGuiCompileResult', () => {
        const names = { fileName: 'My EA.mq5', binaryName: 'My EA.ex5' };

        test('compiled: mentions F7, both timings and the terminal reload', () => {
            const m = freshModule();
            const line = m.describeGuiCompileResult(
                { ok: true, status: 'compiled', windowMs: 1496, binaryMs: 439, focus: 'none' }, names);
            assert.match(line, /^\[Info\] MetaEditor GUI compile: Compile \(F7\) sent to "My EA\.mq5" after 1\.5 s, My EA\.ex5 rewritten 0\.4 s later\. MetaTrader reloads/);
            assert.doesNotMatch(line, /already open/);
        });

        test('compiled with a same-named tab already open: says the hand-over was awaited', () => {
            const m = freshModule();
            const line = m.describeGuiCompileResult(
                { ok: true, status: 'compiled', windowMs: 1844, binaryMs: 389, focus: 'none', handoff: 'exited', modsMs: 0, alreadyOpen: true }, names);
            assert.match(line, /after 1\.8 s, My EA\.ex5 rewritten 0\.4 s later\. MetaTrader reloads the programs running on its charts after a MetaEditor compile\. The file name was already open in MetaEditor, the hand-over to the running instance was awaited first\.$/);
        });

        test('triggered with a binary wait: a warning naming the binary that did not change', () => {
            const m = freshModule();
            const line = m.describeGuiCompileResult({ ok: true, status: 'triggered', windowMs: 1355, binaryMs: -1 }, names);
            assert.match(line, /^\[Warning\] MetaEditor GUI compile: Compile \(F7\) sent to "My EA\.mq5" after 1\.4 s, but My EA\.ex5 was not rewritten within the wait time\. Check which tab MetaEditor compiled/);
        });

        test('triggered without a binary wait (headers): no mention of a binary', () => {
            const m = freshModule();
            const line = m.describeGuiCompileResult({ ok: true, status: 'triggered', windowMs: 1355, binaryMs: -1 },
                { ...names, binaryName: 'Common.ex5', waitedForBinary: false });
            assert.doesNotMatch(line, /Common\.ex5/);
            assert.match(line, /MetaTrader reloads/);
        });

        test('error: names the file and the reason', () => {
            const m = freshModule();
            const line = m.describeGuiCompileResult({ ok: false, status: 'error', detail: 'window-timeout: none' }, names);
            assert.strictEqual(line, '[Error] MetaEditor GUI compile failed for "My EA.mq5": window-timeout: none');
        });
    });

    suite('resolveScriptCompileFollowUp (compilePath branch decision)', () => {
        const extension = require('../src/extension');
        const { COMPILE_MODE_CHECK, COMPILE_MODE_COMPILE, COMPILE_MODE_SCRIPT } = require('../src/debugBridge');

        test('only a successful script-mode compile has a follow-up', () => {
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_CHECK, false, { useWine: false, platform: 'win32' }), 'none');
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_COMPILE, false, { useWine: false, platform: 'win32' }), 'none');
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_SCRIPT, true, { useWine: false, platform: 'win32' }), 'none');
        });

        test('Windows: MetaEditor GUI compile; Wine keeps its batch compile; other hosts the bare CLI compile', () => {
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_SCRIPT, false, { useWine: false, platform: 'win32' }), 'gui');
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_SCRIPT, false, { useWine: true, platform: 'win32' }), 'wine');
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_SCRIPT, false, { useWine: true, platform: 'linux' }), 'wine');
            assert.strictEqual(extension.resolveScriptCompileFollowUp(COMPILE_MODE_SCRIPT, false, { useWine: false, platform: 'darwin' }), 'cli');
        });
    });
});
