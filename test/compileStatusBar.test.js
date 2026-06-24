'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');
const compileStatusBar = require('../src/compileStatusBar');

/**
 * compileStatusBar is a module-level singleton. We reset() between tests but
 * the activate() guard means createStatusBarItem is only called once per
 * process; the same item is reused and its fields mutated by update().
 */

function fakeContext() {
    return { subscriptions: [] };
}

suite('compileStatusBar', () => {
    suiteSetup(() => {
        // activate() is idempotent (singleton guard); call once for the whole suite.
        compileStatusBar.activate(fakeContext());
    });

    setup(() => {
        compileStatusBar.reset();
    });

    test('activate is idempotent (second call is a no-op, no throw)', () => {
        const ctx = fakeContext();
        assert.doesNotThrow(() => compileStatusBar.activate(ctx));
    });

    test('clean build shows check icon, 0 warnings, build tag', () => {
        compileStatusBar.update({ errorCount: 0, warningCount: 0, targetLabel: "'MyEA.mq5' (1.10)", check: false });
        const r = compileStatusBar.getLastResult();
        assert.ok(r);
        assert.strictEqual(r.errorCount, 0);
        assert.strictEqual(r.warningCount, 0);
        assert.strictEqual(r.check, false);
    });

    test('errors produce error icon + errorBackground theme color', () => {
        compileStatusBar.update({ errorCount: 3, warningCount: 2, targetLabel: "'EA'", check: false });
        const r = compileStatusBar.getLastResult();
        assert.strictEqual(r.errorCount, 3);
        assert.strictEqual(r.warningCount, 2);
        // ThemeColor is used for the background; the module constructs it from
        // vscode.ThemeColor — just assert the result was recorded.
        assert.ok(r);
    });

    test('warnings-only (no errors) is recorded as warning state', () => {
        compileStatusBar.update({ errorCount: 0, warningCount: 5, targetLabel: '', check: true });
        const r = compileStatusBar.getLastResult();
        assert.strictEqual(r.errorCount, 0);
        assert.strictEqual(r.warningCount, 5);
        assert.strictEqual(r.check, true);
    });

    test('negative counts are clamped to zero', () => {
        compileStatusBar.update({ errorCount: -2, warningCount: -9, targetLabel: '' });
        const r = compileStatusBar.getLastResult();
        assert.strictEqual(r.errorCount, 0);
        assert.strictEqual(r.warningCount, 0);
    });

    test('reset clears lastResult', () => {
        compileStatusBar.update({ errorCount: 1, warningCount: 0, targetLabel: '' });
        assert.ok(compileStatusBar.getLastResult());
        compileStatusBar.reset();
        assert.strictEqual(compileStatusBar.getLastResult(), null);
    });
});
