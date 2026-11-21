'use strict';

// Unit tests for chartLayout.js MT5-instance targeting: the per-preset
// mt5Path pin, the worker CLI args, and the instance probe/picker resolution.

const assert = require('assert');
const childProcess = require('child_process');
const vscodeMock = require('./mocks/vscode.js');

function freshModule() {
    delete require.cache[require.resolve('../src/chartLayout.js')];
    return require('../src/chartLayout.js');
}

function stubExecFile(fn) {
    const orig = childProcess.execFile;
    childProcess.execFile = fn;
    return () => { childProcess.execFile = orig; };
}

const PRESET = {
    name: 'p',
    docked: { monitor: 1, rows: 2, cols: 2 },
    floating: null,
    gap: 0,
};

suite('chartLayout targeting', () => {
    suiteTeardown(() => {
        vscodeMock.window.showQuickPick = () => Promise.resolve(undefined);
    });

    test('normalizePreset carries a trimmed mt5Path through', () => {
        const m = freshModule();
        const n = m.normalizePreset({ ...PRESET, mt5Path: '  C:\\MT5\\terminal64.exe ' });
        assert.strictEqual(n.mt5Path, 'C:\\MT5\\terminal64.exe');
    });

    test('normalizePreset omits mt5Path when empty or not a string', () => {
        const m = freshModule();
        for (const bad of ['', '   ', 42, null, undefined]) {
            const n = m.normalizePreset({ ...PRESET, mt5Path: bad });
            assert.ok(!('mt5Path' in n), `mt5Path must be absent for ${JSON.stringify(bad)}`);
        }
    });

    test('buildArgs stays legacy-shaped without targeting', () => {
        const m = freshModule();
        const a = m.normalizePreset(PRESET);
        const argv = m.buildArgs('s.ps1', a);
        assert.ok(!argv.includes('-Mt5Path'));
        assert.ok(!argv.includes('-Mt5Pid'));
    });

    test('buildArgs appends -Mt5Path / -Mt5Pid only when present', () => {
        const m = freshModule();
        const pinned = m.normalizePreset({ ...PRESET, mt5Path: 'C:\\MT5\\terminal64.exe' });
        let argv = m.buildArgs('s.ps1', pinned);
        assert.deepStrictEqual(argv.slice(-2), ['-Mt5Path', 'C:\\MT5\\terminal64.exe']);
        assert.ok(!argv.includes('-Mt5Pid'));

        argv = m.buildArgs('s.ps1', m.normalizePreset(PRESET), 4242);
        assert.deepStrictEqual(argv.slice(-2), ['-Mt5Pid', '4242']);
        assert.ok(!argv.includes('-Mt5Path'));

        argv = m.buildArgs('s.ps1', pinned, 7);
        assert.ok(argv.includes('-Mt5Path') && argv.includes('4242') === false && argv.includes('-Mt5Pid') && argv.indexOf('-Mt5Path') < argv.indexOf('-Mt5Pid'));
    });

    test('listMt5Instances parses the worker JSON', async () => {
        const m = freshModule();
        const json = JSON.stringify([
            { pid: 101, title: 'EURUSD,H1 - MetaTrader 5 - Broker A', path: 'C:\\A\\terminal64.exe' },
            { pid: 202, title: '', path: '' },
        ]);
        const restore = stubExecFile((cmd, args, opts, cb) => cb(null, json + '\r\n', ''));
        try {
            const list = await m.listMt5Instances('s.ps1');
            assert.strictEqual(list.length, 2);
            assert.deepStrictEqual(list[0], { pid: 101, title: 'EURUSD,H1 - MetaTrader 5 - Broker A', path: 'C:\\A\\terminal64.exe' });
            assert.deepStrictEqual(list[1], { pid: 202, title: '', path: '' });
        } finally { restore(); }
    });

    test('listMt5Instances rejects on non-JSON worker output', async () => {
        const m = freshModule();
        const restore = stubExecFile((cmd, args, opts, cb) => cb(null, 'garbage', ''));
        try {
            await assert.rejects(() => m.listMt5Instances('s.ps1'), /parse/);
        } finally { restore(); }
    });

    test('listMt5Instances rejects when the probe fails hard', async () => {
        const m = freshModule();
        const restore = stubExecFile((cmd, args, opts, cb) => cb(new Error('spawn failed'), '', 'boom'));
        try {
            await assert.rejects(() => m.listMt5Instances('s.ps1'), /boom/);
        } finally { restore(); }
    });

    test('resolveInstance: pinned preset skips the probe entirely', async () => {
        const m = freshModule();
        const restore = stubExecFile(() => { throw new Error('probe must not run'); });
        try {
            const t = await m.resolveInstance(m.normalizePreset({ ...PRESET, mt5Path: 'C:\\A\\terminal64.exe' }), 's.ps1');
            assert.deepStrictEqual(t, { pid: 0, path: 'C:\\A\\terminal64.exe' });
        } finally { restore(); }
    });

    test('resolveInstance: single running instance is auto-selected', async () => {
        const m = freshModule();
        const restore = stubExecFile((cmd, args, opts, cb) =>
            cb(null, JSON.stringify([{ pid: 55, title: 'T', path: 'C:\\A\\terminal64.exe' }]), ''));
        try {
            const t = await m.resolveInstance(m.normalizePreset(PRESET), 's.ps1');
            assert.deepStrictEqual(t, { pid: 55, path: 'C:\\A\\terminal64.exe' });
        } finally { restore(); }
    });

    test('resolveInstance: no instance running throws the legacy message', async () => {
        const m = freshModule();
        const restore = stubExecFile((cmd, args, opts, cb) => cb(null, '[]', ''));
        try {
            await assert.rejects(() => m.resolveInstance(m.normalizePreset(PRESET), 's.ps1'), /not running/);
        } finally { restore(); }
    });

    test('resolveInstance: several instances prompt; choice and dismissal both work', async () => {
        const m = freshModule();
        const two = JSON.stringify([
            { pid: 1, title: 'A', path: 'C:\\A\\terminal64.exe' },
            { pid: 2, title: 'B', path: 'C:\\B\\terminal64.exe' },
        ]);
        const restore = stubExecFile((cmd, args, opts, cb) => cb(null, two, ''));
        const origPick = vscodeMock.window.showQuickPick;
        try {
            const offered = [];
            vscodeMock.window.showQuickPick = async (items, opts2) => { offered.push({ items, opts2 }); return items[1]; };
            let t = await m.resolveInstance(m.normalizePreset(PRESET), 's.ps1');
            assert.deepStrictEqual(t, { pid: 2, path: 'C:\\B\\terminal64.exe' });
            assert.strictEqual(offered[0].items.length, 2);
            assert.strictEqual(offered[0].items[0].label, 'A');
            assert.strictEqual(offered[0].items[0].description, 'pid 1');
            assert.strictEqual(offered[0].items[0].detail, 'C:\\A\\terminal64.exe');

            vscodeMock.window.showQuickPick = async () => undefined;   // dismissed
            t = await m.resolveInstance(m.normalizePreset(PRESET), 's.ps1');
            assert.strictEqual(t, null);
        } finally {
            vscodeMock.window.showQuickPick = origPick;
            restore();
        }
    });
});
