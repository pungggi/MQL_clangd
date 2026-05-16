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

    test('flags assignment-in-condition when a block comment closes earlier on the same line', () => {
        // Regression: previously this whole line was skipped because the line
        // began inside a block comment, so the trailing `if (x = 5)` slipped
        // past the analyzer.
        const doc = makeDoc('/* hdr */ if (x = 5)\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), ['assignment-in-condition']);
    });

    test('does not flag }; in struct preceded by a block comment', () => {
        // Regression: the struct/class/enum guard now runs on the
        // comment-stripped line so leading comments do not defeat it.
        const doc = makeDoc('/* hdr */ struct Foo { int x; };');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('does not flag escaped quotes inside a string in condition', () => {
        const doc = makeDoc('if (s == "a \\"=\\" b")\n{\n}');
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });

    test('does not crash on an unterminated block comment at EOF', () => {
        const doc = makeDoc('/* unterminated\n   if (x = 5)\n   no closer here');
        // The scanner must not throw, and content inside the unterminated
        // comment must not produce diagnostics.
        const diags = analyzeDocument(doc);
        assert.deepStrictEqual(codes(diags), []);
    });

    test('does not flag = inside an MQL char literal', () => {
        const doc = makeDoc("if (delim == '=')\n{\n}");
        assert.deepStrictEqual(codes(analyzeDocument(doc)), []);
    });
});
