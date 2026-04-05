'use strict';
const assert = require('assert');
const path = require('path');

// ---------------------------------------------------------------------------
// debugLogReader — LOG event parsing
// ---------------------------------------------------------------------------
const { MqlDebugLogReader } = require('../src/debugLogReader');

suite('debugLogReader — LOG events', function () {
    test('parses LOG event line', function () {
        const reader = new MqlDebugLogReader('/fake/mql5');
        const result = reader._parseLine(
            'DBG|2024.01.01 12:00:00.000|test.mq5|OnTick|42|LOG|Trade opened: 0.1 lots'
        );
        assert.deepStrictEqual(result, {
            type: 'log',
            timestamp: '2024.01.01 12:00:00.000',
            file: 'test.mq5',
            func: 'OnTick',
            line: 42,
            message: 'Trade opened: 0.1 lots',
        });
    });

    test('LOG message with pipe characters is preserved', function () {
        const reader = new MqlDebugLogReader('/fake/mql5');
        const result = reader._parseLine(
            'DBG|2024.01.01 12:00:00.000|test.mq5|OnTick|42|LOG|a|b|c'
        );
        assert.strictEqual(result.type, 'log');
        assert.strictEqual(result.message, 'a|b|c');
    });

    test('LOG with empty message', function () {
        const reader = new MqlDebugLogReader('/fake/mql5');
        const result = reader._parseLine(
            'DBG|2024.01.01 12:00:00.000|test.mq5|OnTick|42|LOG|'
        );
        assert.strictEqual(result.type, 'log');
        assert.strictEqual(result.message, '');
    });

    test('existing event types still parse correctly', function () {
        const reader = new MqlDebugLogReader('/fake/mql5');
        const brk = reader._parseLine(
            'DBG|2024.01.01 12:00:00.000|test.mq5|OnTick|42|BREAK|bp_test_42'
        );
        assert.strictEqual(brk.type, 'break');
        assert.strictEqual(brk.label, 'bp_test_42');

        const watch = reader._parseLine(
            'DBG|2024.01.01 12:00:00.000|test.mq5|OnTick|42|WATCH|price|double|1.23456'
        );
        assert.strictEqual(watch.type, 'watch');
        assert.strictEqual(watch.varName, 'price');
    });
});

// ---------------------------------------------------------------------------
// debugStateStore — log event handling
// ---------------------------------------------------------------------------
const { store, DebugStateStore, MAX_HITS } = require('../src/debugStateStore');

suite('DebugStateStore — log events', function () {
    let s;
    setup(function () { s = new DebugStateStore(); });

    test('applyEvent with log type stores message', function () {
        s.startSession();
        s.applyEvent({
            type: 'log',
            message: 'hello world',
            file: 'test.mq5',
            func: 'OnTick',
            line: 42,
            timestamp: '2024.01.01 12:00:00.000',
        });
        assert.strictEqual(s.logMessages.length, 1);
        assert.strictEqual(s.logMessages[0].message, 'hello world');
        assert.strictEqual(s.logMessages[0].file, 'test.mq5');
        assert.strictEqual(s.logMessages[0].line, 42);
    });

    test('applyBatch with multiple log events', function () {
        s.startSession();
        s.applyBatch([
            { type: 'log', message: 'msg1', file: 'a.mq5', func: 'F', line: 1, timestamp: 't1' },
            { type: 'log', message: 'msg2', file: 'b.mq5', func: 'G', line: 2, timestamp: 't2' },
        ]);
        assert.strictEqual(s.logMessages.length, 2);
        assert.strictEqual(s.logMessages[0].message, 'msg1');
        assert.strictEqual(s.logMessages[1].message, 'msg2');
    });

    test('logMessages is cleared on session reset', function () {
        s.startSession();
        s.applyEvent({
            type: 'log', message: 'old', file: '', func: '', line: 0, timestamp: '',
        });
        assert.strictEqual(s.logMessages.length, 1);
        s.startSession(); // reset
        assert.strictEqual(s.logMessages.length, 0);
    });

    test('logMessages respects MAX_HITS cap', function () {
        const overflow = 10;
        const totalMessages = MAX_HITS + overflow;
        s.startSession();
        for (let i = 0; i < totalMessages; i++) {
            s._applyOne({
                type: 'log', message: `msg${i}`, file: '', func: '', line: i, timestamp: '',
            });
        }
        assert.ok(s.logMessages.length <= MAX_HITS, `Expected <= ${MAX_HITS}, got ${s.logMessages.length}`);
        // First message should have been shifted out
        assert.strictEqual(s.logMessages[0].message, `msg${totalMessages - MAX_HITS}`);
    });

    test('break events still work alongside log events', function () {
        s.startSession();
        s.applyBatch([
            { type: 'break', label: 'bp1', file: 'a.mq5', func: 'F', line: 10, timestamp: 't1' },
            { type: 'log', message: 'logged', file: 'a.mq5', func: 'F', line: 11, timestamp: 't2' },
        ]);
        assert.strictEqual(s.hits.length, 1);
        assert.strictEqual(s.logMessages.length, 1);
    });
});

// ---------------------------------------------------------------------------
// debugAdapter — _parseHitCondition
// ---------------------------------------------------------------------------

// We need to access the private method. Since MqlDebugAdapter requires vscode
// and a store/bridge, we'll test it by instantiating with minimal mocks.
const { EventEmitter } = require('events');

// Minimal mock bridge
function makeMockBridge() {
    return {
        isActive: false,
        probeMap: null,
        lineMap: null,
        resolveProbeId: () => undefined,
        writeBreakpointConfig: () => {},
    };
}

// Import MqlDebugAdapter — it requires vscode (which is mocked by the test runner)
const vscode = require('vscode');

// We need the EventEmitter from vscode mock for onDidSendMessage
// Patch the mock to include EventEmitter if not present
if (!vscode.EventEmitter) {
    vscode.EventEmitter = class {
        constructor() { this._listeners = []; }
        get event() { return (listener) => { this._listeners.push(listener); return { dispose: () => {} }; }; }
        fire(data) { for (const l of this._listeners) l(data); }
        dispose() { this._listeners = []; }
    };
}
if (!vscode.debug) {
    vscode.debug = { breakpoints: [] };
}
if (!vscode.SourceBreakpoint) {
    vscode.SourceBreakpoint = class {};
}
if (!vscode.ProgressLocation) {
    vscode.ProgressLocation = { Notification: 1 };
}

// Now we can require the adapter
const { MqlDebugAdapter } = require('../src/debugAdapter');

suite('MqlDebugAdapter — _parseHitCondition', function () {
    let adapter;

    setup(function () {
        const mockStore = new DebugStateStore();
        const mockBridge = makeMockBridge();
        adapter = new MqlDebugAdapter(
            mockStore, mockBridge,
            '/fake/source.mq5', '/fake/mql5',
            () => false, { extensionPath: '/fake' },
            '/fake/source.mq5'
        );
    });

    teardown(function () {
        adapter.dispose();
    });

    test('plain number means == N', function () {
        const result = adapter._parseHitCondition('5');
        assert.deepStrictEqual(result, { op: '=', val: 5 });
    });

    test('"= N" means == N', function () {
        const result = adapter._parseHitCondition('= 10');
        assert.deepStrictEqual(result, { op: '=', val: 10 });
    });

    test('"== N" means == N', function () {
        const result = adapter._parseHitCondition('== 3');
        assert.deepStrictEqual(result, { op: '=', val: 3 });
    });

    test('"> N" means > N', function () {
        const result = adapter._parseHitCondition('> 5');
        assert.deepStrictEqual(result, { op: '>', val: 5 });
    });

    test('">= N" means >= N (encoded as G)', function () {
        const result = adapter._parseHitCondition('>= 10');
        assert.deepStrictEqual(result, { op: 'G', val: 10 });
    });

    test('"< N" means < N', function () {
        const result = adapter._parseHitCondition('< 3');
        assert.deepStrictEqual(result, { op: '<', val: 3 });
    });

    test('"<= N" means <= N (encoded as S)', function () {
        const result = adapter._parseHitCondition('<= 7');
        assert.deepStrictEqual(result, { op: 'S', val: 7 });
    });

    test('"% N" means modulo N', function () {
        const result = adapter._parseHitCondition('% 3');
        assert.deepStrictEqual(result, { op: '%', val: 3 });
    });

    test('whitespace is trimmed', function () {
        assert.deepStrictEqual(adapter._parseHitCondition('  > 5  '), { op: '>', val: 5 });
        assert.deepStrictEqual(adapter._parseHitCondition('  42  '), { op: '=', val: 42 });
    });

    test('empty/null returns null', function () {
        assert.strictEqual(adapter._parseHitCondition(''), null);
        assert.strictEqual(adapter._parseHitCondition(null), null);
        assert.strictEqual(adapter._parseHitCondition(undefined), null);
        assert.strictEqual(adapter._parseHitCondition('   '), null);
    });

    test('invalid expression returns null', function () {
        assert.strictEqual(adapter._parseHitCondition('abc'), null);
        assert.strictEqual(adapter._parseHitCondition('> abc'), null);
        assert.strictEqual(adapter._parseHitCondition('>>5'), null);
    });
});

// ---------------------------------------------------------------------------
// debugBridge — writeBreakpointConfig extended format
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');

suite('MqlDebugBridge — writeBreakpointConfig extended format', function () {
    const { MqlDebugBridge } = require('../src/debugBridge');
    let tmpDir;
    let testBridge;

    setup(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqldbg-test-'));
        fs.mkdirSync(path.join(tmpDir, 'Files'), { recursive: true });
        testBridge = new MqlDebugBridge();
        testBridge._mql5Root = tmpDir;
    });

    teardown(function () {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    function readConfig() {
        return fs.readFileSync(path.join(tmpDir, 'Files', 'MqlDebugBPConfig.txt'), 'utf-8');
    }

    test('plain number array (backward compatible)', function () {
        testBridge.writeBreakpointConfig([3, 17, 42]);
        assert.strictEqual(readConfig(), '3,17,42');
    });

    test('entry with hit condition', function () {
        testBridge.writeBreakpointConfig([
            { id: 17, hitOp: '>', hitVal: 5 },
        ]);
        assert.strictEqual(readConfig(), '17h>5');
    });

    test('entry with logpoint flag', function () {
        testBridge.writeBreakpointConfig([
            { id: 42, isLogpoint: true },
        ]);
        assert.strictEqual(readConfig(), '42L');
    });

    test('entry with both hit condition and logpoint', function () {
        testBridge.writeBreakpointConfig([
            { id: 9, hitOp: '%', hitVal: 3, isLogpoint: true },
        ]);
        assert.strictEqual(readConfig(), '9h%3L');
    });

    test('mixed entries', function () {
        testBridge.writeBreakpointConfig([
            3,
            { id: 17, hitOp: '>', hitVal: 5 },
            { id: 42, isLogpoint: true },
            { id: 9, hitOp: '%', hitVal: 3, isLogpoint: true },
        ]);
        assert.strictEqual(readConfig(), '3,17h>5,42L,9h%3L');
    });

    test('entry with id only (no modifiers)', function () {
        testBridge.writeBreakpointConfig([
            { id: 10 },
        ]);
        assert.strictEqual(readConfig(), '10');
    });

    test('entry with >= encoded as G', function () {
        testBridge.writeBreakpointConfig([
            { id: 5, hitOp: 'G', hitVal: 10 },
        ]);
        assert.strictEqual(readConfig(), '5hG10');
    });

    test('entry with <= encoded as S', function () {
        testBridge.writeBreakpointConfig([
            { id: 5, hitOp: 'S', hitVal: 7 },
        ]);
        assert.strictEqual(readConfig(), '5hS7');
    });
});
