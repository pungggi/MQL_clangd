'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');

// logTailer is a singleton; import once and reset state per test.
const logTailer = require('../src/logTailer');

function makeChannel() {
    return {
        chunks: [],
        clear() { this.cleared = true; this.chunks = []; },
        append(t) { this.chunks.push(t); },
        appendLine(t) { this.chunks.push(t + '\n'); }
    };
}

suite('logTailer — level parsing & filtering', () => {
    let out;
    setup(() => {
        out = makeChannel();
        logTailer.outputChannel = out;
        logTailer.lineBuffer = [];
        logTailer.pendingPartial = '';
        logTailer.levelFilter = null;
    });

    test('_lineLevel detects [LEVEL] prefix (LiveLog format)', () => {
        assert.strictEqual(logTailer._lineLevel('[INFO] {a:b:1}: hi'), 'INFO');
        assert.strictEqual(logTailer._lineLevel('12:00 | [DEBUG] {a:b:2}: x'), 'DEBUG');
        assert.strictEqual(logTailer._lineLevel('[ERROR] boom'), 'ERROR');
    });

    test('_lineLevel detects MT5 Tester "[EA] LEVEL" format', () => {
        assert.strictEqual(logTailer._lineLevel('2024.01.01 00:00 [MyEA] WARN {a:b:1}: w'), 'WARN');
        assert.strictEqual(logTailer._lineLevel('[EA] TRADE {a:b:2}: buy'), 'TRADE');
    });

    test('_lineLevel returns null for plain lines', () => {
        assert.strictEqual(logTailer._lineLevel('non-log informational line'), null);
        assert.strictEqual(logTailer._lineLevel(''), null);
    });

    test('no filter: all lines appended', () => {
        logTailer._ingestLines('[INFO] a\n[DEBUG] b\nplain c\n');
        assert.strictEqual(out.chunks.length, 1);
        assert.ok(out.chunks[0].includes('[INFO] a'));
        assert.ok(out.chunks[0].includes('plain c'));
    });

    test('filter hides non-selected levels, keeps plain lines', () => {
        logTailer._ingestLines('[INFO] a\n[DEBUG] b\n[ERROR] c\nplain d\n');
        out.chunks = [];
        logTailer.setLevelFilter(['ERROR']);
        const rendered = out.chunks.join('');
        assert.ok(rendered.includes('[ERROR] c'));
        assert.ok(rendered.includes('plain d'), 'non-log lines always pass');
        assert.ok(!rendered.includes('[INFO] a'));
        assert.ok(!rendered.includes('[DEBUG] b'));
    });

    test('multiple selected levels', () => {
        logTailer._ingestLines('[INFO] a\n[WARN] b\n[ERROR] c\n');
        out.chunks = [];
        logTailer.setLevelFilter(['INFO', 'WARN']);
        const rendered = out.chunks.join('');
        assert.ok(rendered.includes('[INFO] a') && rendered.includes('[WARN] b'));
        assert.ok(!rendered.includes('[ERROR] c'));
    });

    test('clearing filter re-renders full buffered history', () => {
        logTailer._ingestLines('[INFO] a\n[DEBUG] b\n[ERROR] c\n');
        logTailer.setLevelFilter(['ERROR']);     // narrow
        out.chunks = [];
        logTailer.setLevelFilter([]);            // clear
        const rendered = out.chunks.join('');
        assert.ok(rendered.includes('[INFO] a'));
        assert.ok(rendered.includes('[DEBUG] b'));
        assert.ok(rendered.includes('[ERROR] c'));
    });

    test('getLevelFilter reflects current state', () => {
        assert.deepStrictEqual(logTailer.getLevelFilter(), []);
        logTailer.setLevelFilter(['INFO', 'DEBUG']);
        assert.deepStrictEqual(logTailer.getLevelFilter().sort(), ['DEBUG', 'INFO']);
        logTailer.setLevelFilter([]);
        assert.deepStrictEqual(logTailer.getLevelFilter(), []);
    });

    test('partial trailing line is held until the next read', () => {
        logTailer._ingestLines('[INFO] star');      // no newline -> partial
        assert.strictEqual(out.chunks.length, 0);
        logTailer._ingestLines('ted\n');            // completion
        assert.ok(out.chunks.join('').includes('[INFO] started'));
    });
});

suite('liveLogLinks — {File:Func:Line} source resolution', () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const { LiveLogLinkProvider, resolveLiveLogSource } = require('../src/liveLogLinks');

    let tmp;
    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-log-'));
        fs.writeFileSync(path.join(tmp, 'MyEA.mq5'), '// x');
        // point the tailer singleton's base path at the temp folder
        logTailer.basePath = tmp;
    });
    teardown(() => {
        logTailer.basePath = null;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('resolves bare basename via tailer base path', () => {
        const resolved = resolveLiveLogSource('MyEA.mq5', tmp);
        assert.ok(resolved);
        assert.strictEqual(path.basename(resolved), 'MyEA.mq5');
    });

    test('returns null for a missing file', () => {
        assert.strictEqual(resolveLiveLogSource('Nope.mq5', tmp), null);
    });

    test('provideDocumentLinks creates a link per resolvable tag', () => {
        const docText = [
            '12:00 | [INFO] {MyEA.mq5:OnInit:42}: started',
            '12:01 | [WARN] {Nope.mq5:OnTick:9}: unresolved',
            '12:02 | plain line'
        ].join('\n');
        const links = new LiveLogLinkProvider().provideDocumentLinks({ getText: () => docText });
        // only the MyEA.mqh tag resolves; Nope.mqh is dropped; plain line has none
        assert.strictEqual(links.length, 1);
        const link = links[0];
        assert.ok(link.target.fragment.startsWith('41'), 'line is 1-based → 0-based fragment');
        assert.ok(link.tooltip.includes('OnInit'));
    });

    test('returns [] when no tags present', () => {
        const links = new LiveLogLinkProvider().provideDocumentLinks({ getText: () => 'no tags here\n' });
        assert.deepStrictEqual(links, []);
    });
});
