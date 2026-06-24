'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');
const { MqlCodeActionProvider } = require('../src/extension');

/**
 * Build a minimal TextDocument the MqlCodeActionProvider can read.
 * Lines are 0-indexed. lineAt() returns {text, range}; getText(range) returns
 * the slice; getWordRangeAtPosition expands a position to the matching word.
 */
function makeDocument(lines) {
    const arr = Array.isArray(lines) ? lines : lines.split('\n');
    return {
        lineCount: arr.length,
        uri: { fsPath: '/t/EA.mq5', toString: () => 't' },
        lineAt(line) {
            const text = arr[line] || '';
            return { text, range: new vscode.Range(line, 0, line, text.length) };
        },
        getText(range) {
            if (!range) return arr.join('\n');
            // Support both Range and Position; for our tests a 1-char/word range
            // spanning one line is all we need.
            const startCol = range.start.character;
            const endCol = range.end.character;
            const ln = range.start.line;
            return (arr[ln] || '').slice(startCol, endCol);
        },
        getWordRangeAtPosition(pos, regex) {
            const text = arr[pos.line] || '';
            // Find a word boundary match around pos.character
            const left = text.slice(0, pos.character).search(/[A-Za-z0-9_.]+$/);
            if (left < 0) return undefined;
            const tail = text.slice(left).match(regex || /[A-Za-z0-9_.]+/);
            const len = tail ? tail[0].length : 0;
            return new vscode.Range(pos.line, left, pos.line, left + len);
        }
    };
}

/** Assert that a CodeAction's edit applies exactly one replacement == expected. */
function assertSingleReplacement(action, expected) {
    assert.ok(action.edit, 'action has a WorkspaceEdit');
    const ops = action.edit._ops || [];
    const replaces = ops.filter(o => o.op === 'replace');
    assert.strictEqual(replaces.length, 1, `expected one replace, got ${replaces.length}`);
    assert.strictEqual(replaces[0].newText, expected);
}

const provider = new MqlCodeActionProvider();

suite('MqlCodeActionProvider — Phase 5: explicit cast', () => {
    test('wraps operand in (double) for int->double conversion', () => {
        const src = '   double x = 5;';
        const doc = makeDocument([src]);
        const diag = new vscode.Diagnostic(
            new vscode.Range(0, 14, 0, 15),
            "implicit conversion from 'int' to 'double'",
            vscode.DiagnosticSeverity.Warning
        );
        diag.source = 'clang';
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        const cast = actions.find(a => /explicit \(double\) cast/.test(a.title));
        assert.ok(cast, 'expected an explicit-cast action');
        assertSingleReplacement(cast, '(double)5');
    });

    test('double->int conversion targets int', () => {
        const doc = makeDocument(['   int n = 1.5;']);
        const diag = new vscode.Diagnostic(
            new vscode.Range(0, 11, 0, 14),
            "implicit conversion from 'double' to 'int'",
            vscode.DiagnosticSeverity.Warning
        );
        diag.source = 'clang';
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        const cast = actions.find(a => /explicit \(int\) cast/.test(a.title));
        assert.ok(cast);
        assertSingleReplacement(cast, '(int)1.5');
    });

    test('number->string is NOT handled here (left to the ToString handler)', () => {
        const doc = makeDocument(['   string s = 5;']);
        const diag = new vscode.Diagnostic(
            new vscode.Range(0, 14, 0, 15),
            "implicit conversion from 'number' to 'string'",
            vscode.DiagnosticSeverity.Warning
        );
        // No MQL181 code set, so Phase 5 runs — but it should skip string target.
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        const cast = actions.find(a => /explicit \(\w+\) cast/.test(a.title));
        assert.ok(!cast, 'string-target conversions must not get an explicit-cast action');
    });

    test('non-conversion message yields no cast action', () => {
        const doc = makeDocument(['int x = 0;']);
        const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'something else', vscode.DiagnosticSeverity.Warning);
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        assert.ok(!actions.some(a => /explicit \(\w+\) cast/.test(a.title)));
    });
});

suite('MqlCodeActionProvider — Phase 6: unused variable', () => {
    test('offers comment-out and remove actions for "unused variable"', () => {
        const doc = makeDocument(['   int unused = 5;', 'void f() {}']);
        const diag = new vscode.Diagnostic(
            new vscode.Range(0, 6, 0, 12),
            "unused variable 'unused'",
            vscode.DiagnosticSeverity.Warning
        );
        diag.source = 'clang';
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        const titles = actions.map(a => a.title);

        const comment = actions.find(a => /Comment out/.test(a.title));
        assert.ok(comment, 'expected a comment-out action');
        // comment-out replaces the line with `   // int unused = 5;`
        const cReplace = comment.edit._ops.find(o => o.op === 'replace');
        assert.ok(cReplace);
        assert.strictEqual(cReplace.newText, '   // int unused = 5;');

        const remove = actions.find(a => /Remove unused/.test(a.title));
        assert.ok(remove, 'expected a remove action');
        // remove deletes the whole line (range from line 0 col 0 to line 1 col 0)
        const del = remove.edit._ops.find(o => o.op === 'delete');
        assert.ok(del);
        assert.strictEqual(del.range.start.line, 0);
        assert.strictEqual(del.range.end.line, 1);
    });

    test('"declared but not used" also triggers the fix', () => {
        const doc = makeDocument(['   int x = 1;']);
        const diag = new vscode.Diagnostic(new vscode.Range(0, 6, 0, 7), 'declared but not used', vscode.DiagnosticSeverity.Warning);
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        assert.ok(actions.some(a => /Comment out|Remove unused/.test(a.title)));
    });

    test('does not fire for unrelated warnings', () => {
        const doc = makeDocument(['   int x = 1;']);
        const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), 'type mismatch', vscode.DiagnosticSeverity.Warning);
        const actions = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] });
        assert.ok(!actions.some(a => /unused|Comment out|Remove unused/.test(a.title)));
    });
});
