const assert = require('assert');

const { analyzeDocument } = require('../src/lightweightDiagnostics');

function makeDoc(source, fileName = 'test.mq5') {
    return {
        getText: () => source,
        fileName,
        uri: `file:///${fileName}`,
        positionAt: (offset) => {
            const before = source.slice(0, offset);
            const lines = before.split('\n');
            return { line: lines.length - 1, character: lines[lines.length - 1].length };
        }
    };
}

function codes(diagnostics) {
    return diagnostics.map(d => d.code).filter(Boolean);
}

suite('lightweightDiagnostics — comment stripping (issue #39)', () => {
    test('does not flag = inside a line comment after if condition', () => {
        const doc = makeDoc('if (TotalRecovery) // This is an = example (comment)\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('still flags real assignment in condition', () => {
        const doc = makeDoc('if (x = 5)\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), ['assignment-in-condition']);
    });

    test('does not flag intentional assignment paired with comparison', () => {
        const doc = makeDoc('if ((x = func()) != 0)\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('flags real assignment even when a == appears later in a comment', () => {
        const doc = makeDoc('if (x = 5) // is == intended?\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), ['assignment-in-condition']);
    });

    test('does not flag = inside an inline block comment in condition', () => {
        const doc = makeDoc('if (TotalRecovery /* x = 1 */)\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('does not flag }; that appears inside a block comment', () => {
        const doc = makeDoc('void f() { /* }; */ }');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('still flags real }; at code level', () => {
        const doc = makeDoc('int x = 5;\n};');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), ['unnecessary-semicolon']);
    });

    test('diagnostic range columns line up with the original line', () => {
        const doc = makeDoc('if (x = 5) // = comment\n{\n}');
        const diags = analyzeDocument(doc);
        assert.strictEqual(diags.length, 1);
        const r = diags[0].range;
        assert.strictEqual(r.start.line, 0);
        assert.strictEqual(r.start.character, 0);
        assert.ok(r.end.character > r.start.character);
    });

    test('does not flag = inside a string literal in condition', () => {
        const doc = makeDoc('if (s == "a = b")\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('multi-line block comment spanning lines is fully ignored', () => {
        const doc = makeDoc('/* this is\n  if (x = 5)\n  end */\nint y = 1;');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });
});
