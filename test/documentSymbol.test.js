'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');
const { MQLDocumentSymbolProvider } = require('../src/provider');

// ---------------------------------------------------------------------------
// Helper: build a minimal TextDocument from a plain string
// ---------------------------------------------------------------------------
function makeDocument(text) {
    const lines = text.split('\n');

    function positionAt(offset) {
        let remaining = offset;
        for (let line = 0; line < lines.length; line++) {
            const lineLen = lines[line].length + 1; // +1 for the \n
            if (remaining < lineLen) {
                return { line, character: remaining };
            }
            remaining -= lineLen;
        }
        return { line: lines.length - 1, character: lines[lines.length - 1].length };
    }

    return {
        getText: () => text,
        positionAt,
        lineAt: (line) => ({
            range: new vscode.Range(line, 0, line, lines[line]?.length || 0),
            text: lines[line] || ''
        }),
        uri: { toString: () => 'test://test.mq5' },
        version: 1
    };
}

const provider = MQLDocumentSymbolProvider();

suite('MQLDocumentSymbolProvider', () => {

    // -----------------------------------------------------------------------
    // Core regression: functions must appear exactly once
    // -----------------------------------------------------------------------

    test('each function appears exactly once', () => {
        const doc = makeDocument([
            'void FuncA() {',
            '   int x = 0;',
            '}',
            '',
            'void FuncB() {',
            '   int y = 0;',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 2);
        assert.strictEqual(funcs[0].name, 'FuncA');
        assert.strictEqual(funcs[1].name, 'FuncB');
    });

    // -----------------------------------------------------------------------
    // Variant B: block-comment with function signature on its own line
    // -----------------------------------------------------------------------

    test('function signature inside block comment does not create duplicate', () => {
        const doc = makeDocument([
            '/*',
            'void FuncB()',
            '   Description: does something',
            '*/',
            'void FuncB() {',
            '   int x = 0;',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1, 'Expected exactly 1 function symbol');
        assert.strictEqual(funcs[0].name, 'FuncB');
        assert.strictEqual(funcs[0].range.start.line, 4, 'Symbol must start at the actual function definition');
    });

    // -----------------------------------------------------------------------
    // Variant A: block-comment referencing next function from inside prev body
    // -----------------------------------------------------------------------

    test('block comment inside function body does not create phantom symbol for next function', () => {
        const doc = makeDocument([
            'void FuncA() {',
            '   /*',
            '   void FuncB() is called next',
            '   */',
            '   FuncB();',
            '}',
            '',
            'void FuncB() {',
            '   int y = 0;',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 2, 'Expected exactly 2 function symbols');
        const funcB = funcs.find(s => s.name === 'FuncB');
        assert.ok(funcB, 'FuncB must exist');
        assert.strictEqual(funcB.range.start.line, 7, 'FuncB must start at line 7, not inside FuncA');
    });

    // -----------------------------------------------------------------------
    // Line comments: // lines must not produce phantom entries
    // -----------------------------------------------------------------------

    test('line-comment with function-like content does not create extra symbols', () => {
        const doc = makeDocument([
            '// void FuncA() - helper function',
            'void FuncA() {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1);
        assert.strictEqual(funcs[0].range.start.line, 1);
    });

    // -----------------------------------------------------------------------
    // Enum braceCount fix: enum range must end at its own closing brace
    // -----------------------------------------------------------------------

    test('enum range ends at its closing brace, not beyond', () => {
        const doc = makeDocument([
            'enum MyEnum {',
            '   VALUE_A,',
            '   VALUE_B',
            '};',
            '',
            'void FuncA() {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const enums = symbols.filter(s => s.kind === vscode.SymbolKind.Enum);
        assert.strictEqual(enums.length, 1, 'Expected 1 enum');
        assert.strictEqual(enums[0].name, 'MyEnum');
        assert.strictEqual(enums[0].range.end.line, 3, 'Enum must end at line 3 (the }; line)');

        // FuncA must still be a separate symbol
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1);
        assert.strictEqual(funcs[0].name, 'FuncA');
    });

    // -----------------------------------------------------------------------
    // Enum with opening brace on the NEXT line (common MQL style, e.g.
    // tools/stub-generator/test/Trade/Trade.mqh) — PR #66 review
    // -----------------------------------------------------------------------

    test('enum with opening brace on the next line is detected with correct range', () => {
        const doc = makeDocument([
            'enum ENUM_TRADE_REQUEST_ACTIONS',
            '  {',
            '   TRADE_ACTION_DEAL    = 0,',
            '   TRADE_ACTION_PENDING = 1',
            '  };',
            '',
            'void FuncA() {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const enums = symbols.filter(s => s.kind === vscode.SymbolKind.Enum);
        assert.strictEqual(enums.length, 1, 'Expected 1 enum');
        assert.strictEqual(enums[0].name, 'ENUM_TRADE_REQUEST_ACTIONS');
        assert.strictEqual(enums[0].range.start.line, 0, 'Enum must start at the enum line');
        assert.strictEqual(enums[0].range.end.line, 4, 'Enum must end at the }; line');

        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1);
        assert.strictEqual(funcs[0].name, 'FuncA');
    });

    // -----------------------------------------------------------------------
    // Multi-line function signature (params span several lines, e.g.
    // files/LiveLog.mqh's LLF overloads) — PR #66 review
    // -----------------------------------------------------------------------

    test('function with a multi-line parameter list is detected once with correct range', () => {
        const doc = makeDocument([
            'void LLF(string fmt, string a1 = "", string a2 = "",',
            '         string a3 = "", string a4 = "",',
            '         string a5 = "") {',
            '   int x = 0;',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1, 'Expected exactly 1 function symbol');
        assert.strictEqual(funcs[0].name, 'LLF');
        assert.strictEqual(funcs[0].range.start.line, 0, 'Must start at the signature line');
        assert.strictEqual(funcs[0].range.end.line, 4, 'Must end at the closing brace');
        // Detail label collapses the multi-line params onto one line
        assert.ok(!funcs[0].detail.includes('\n'), 'Detail must not contain newlines');
    });

    // -----------------------------------------------------------------------
    // Correct range for function following another
    // -----------------------------------------------------------------------

    test('second function range starts at its own signature line', () => {
        const doc = makeDocument([
            'int OnInit() {',
            '   return 0;',
            '}',
            '',
            'void OnDeinit(const int reason) {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 2);
        assert.strictEqual(funcs[0].name, 'OnInit');
        assert.strictEqual(funcs[0].range.start.line, 0);
        assert.strictEqual(funcs[0].range.end.line, 2);
        assert.strictEqual(funcs[1].name, 'OnDeinit');
        assert.strictEqual(funcs[1].range.start.line, 4);
        assert.strictEqual(funcs[1].range.end.line, 5);
    });

    // -----------------------------------------------------------------------
    // Functions inside classes are nested as methods, not duplicated
    // -----------------------------------------------------------------------

    test('class methods appear as children of the class, not at top level', () => {
        const doc = makeDocument([
            'class MyClass {',
            '   void MyMethod() {',
            '      int x = 0;',
            '   }',
            '};',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const classes = symbols.filter(s => s.kind === vscode.SymbolKind.Class);
        assert.strictEqual(classes.length, 1);
        assert.strictEqual(classes[0].name, 'MyClass');

        const methods = classes[0].children.filter(s => s.kind === vscode.SymbolKind.Method);
        assert.strictEqual(methods.length, 1);
        assert.strictEqual(methods[0].name, 'MyMethod');

        // MyMethod must NOT appear at top level
        const topLevelFuncs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(topLevelFuncs.length, 0);
    });

    // -----------------------------------------------------------------------
    // Grouping: preprocessor/input categories collapse into group nodes
    // -----------------------------------------------------------------------

    test('properties, includes, macros and inputs are wrapped in group nodes', () => {
        const doc = makeDocument([
            '#property copyright "A. Pungitore"',
            '#property version   "1.30"',
            '#include <LiveLog.mqh>',
            '#include <Trade/Trade.mqh>',
            '#define LOG_INFO 1',
            'input int InpLookback = 288;',
            'input double InpGap = 0.0;',
            '',
            'void OnInit() {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);

        const groups = symbols.filter(s => s.kind === vscode.SymbolKind.Namespace);
        const byName = Object.fromEntries(groups.map(g => [g.name, g]));

        assert.ok(byName.Properties, 'Properties group must exist');
        assert.strictEqual(byName.Properties.children.length, 2);

        assert.ok(byName.Includes, 'Includes group must exist');
        assert.strictEqual(byName.Includes.children.length, 2);

        assert.ok(byName.Macros, 'Macros group must exist');
        assert.strictEqual(byName.Macros.children.length, 1);

        assert.ok(byName.Inputs, 'Inputs group must exist');
        assert.strictEqual(byName.Inputs.children.length, 2);

        // No #import here → no Imports group
        assert.ok(!byName.Imports, 'Imports group must be omitted when empty');

        // Group range must span its children (breadcrumbs / reveal-in-outline).
        // End must reach the last child's actual end column, not column 0 —
        // VS Code ranges are end-exclusive, so column 0 would drop the line.
        assert.strictEqual(byName.Includes.range.start.line, 2);
        assert.strictEqual(byName.Includes.range.end.line, 3);
        const lastInclude = byName.Includes.children[byName.Includes.children.length - 1];
        assert.strictEqual(byName.Includes.range.end.character, lastInclude.range.end.character);
        assert.ok(byName.Includes.range.end.character > 0, 'Group end must span into the last line');

        // Functions stay top-level (one expand to reach them)
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1);
        assert.strictEqual(funcs[0].name, 'OnInit');
    });

    test('empty categories produce no group nodes', () => {
        const doc = makeDocument([
            'void OnInit() {',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const groups = symbols.filter(s => s.kind === vscode.SymbolKind.Namespace);
        assert.strictEqual(groups.length, 0, 'No preprocessor/inputs → no group nodes');
    });
});
