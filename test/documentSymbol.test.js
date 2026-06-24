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

// Predefined MQL5 event-handler names used to assert grouping behavior.
const MQL_HANDLER_NAMES = new Set([
    'OnStart', 'OnInit', 'OnDeinit', 'OnTick', 'OnCalculate', 'OnTimer',
    'OnTrade', 'OnTradeTransaction', 'OnBookEvent', 'OnChartEvent',
    'OnTester', 'OnTesterInit', 'OnTesterDeinit', 'OnTesterPass'
]);

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
        // OnInit/OnDeinit are predefined handlers → nested under the group.
        const group = symbols.find(s => s.name === 'Event Handlers');
        const funcs = group.children;
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
            'void Helper() {',
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

        // Ordinary (non-handler) functions stay top-level (one expand to reach them)
        const funcs = symbols.filter(s => s.kind === vscode.SymbolKind.Function);
        assert.strictEqual(funcs.length, 1);
        assert.strictEqual(funcs[0].name, 'Helper');
    });

    test('MQL5 event handlers group under "Event Handlers"; other On* helpers stay top-level', () => {
        const doc = makeDocument([
            'int OnInit() {',
            '   return 0;',
            '}',
            '',
            'void OnTick() {',
            '}',
            '',
            'void OnDeinit(const int reason) {',
            '}',
            '',
            'void OnboardUser() {',   // not a predefined handler
            '}',
            '',
            'double Helper() {',
            '   return 0.0;',
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);

        const group = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Event Handlers');
        assert.ok(group, 'Event Handlers group must exist');
        const handlerNames = group.children.map(c => c.name).sort();
        assert.deepStrictEqual(handlerNames, ['OnDeinit', 'OnInit', 'OnTick']);
        assert.strictEqual(group.detail, '3');

        // OnboardUser and Helper are NOT predefined handlers → top-level functions
        const topLevelFuncs = symbols.filter(s => s.kind === vscode.SymbolKind.Function).map(s => s.name).sort();
        assert.deepStrictEqual(topLevelFuncs, ['Helper', 'OnboardUser']);

        // Predefined handlers must NOT also appear at top level
        assert.ok(!symbols.some(s => s.kind === vscode.SymbolKind.Function && MQL_HANDLER_NAMES.has(s.name)));
    });

    test('empty categories produce no group nodes', () => {
        const doc = makeDocument([
            'void Helper() {',   // ordinary function, no preprocessor/inputs/handlers
            '}',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const groups = symbols.filter(s => s.kind === vscode.SymbolKind.Namespace);
        assert.strictEqual(groups.length, 0, 'No preprocessor/inputs/handlers → no group nodes');
    });

    // -----------------------------------------------------------------------
    // Inputs sub-grouped by `input group "..."` sections (mirrors MT5 dialog)
    // -----------------------------------------------------------------------

    test('inputs are nested under their `input group` sections', () => {
        const doc = makeDocument([
            'input int InpMagic = 12345;',          // before any section → ungrouped
            'input group "Trading"',
            'input double InpLots = 0.1;',
            'input int InpSL = 100;',
            'input group "Session"',
            'input int InpStartHour = 8;',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const inputs = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Inputs');
        assert.ok(inputs, 'Inputs group must exist');
        // Detail shows the TOTAL input count, not the number of direct children
        assert.strictEqual(inputs.detail, '4');

        // Direct children: ungrouped input, then the two section nodes (file order)
        assert.strictEqual(inputs.children[0].name, 'InpMagic');
        assert.strictEqual(inputs.children[0].kind, vscode.SymbolKind.Field);

        const sections = inputs.children.filter(c => c.kind === vscode.SymbolKind.Namespace);
        assert.deepStrictEqual(sections.map(s => s.name), ['Trading', 'Session']);
        assert.deepStrictEqual(sections[0].children.map(c => c.name), ['InpLots', 'InpSL']);
        assert.strictEqual(sections[0].detail, '2');
        assert.deepStrictEqual(sections[1].children.map(c => c.name), ['InpStartHour']);
    });

    test('inputs without any `input group` stay a flat list under Inputs', () => {
        const doc = makeDocument([
            'input int InpA = 1;',
            'input int InpB = 2;',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const inputs = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Inputs');
        assert.ok(inputs);
        assert.strictEqual(inputs.children.length, 2);
        assert.ok(inputs.children.every(c => c.kind === vscode.SymbolKind.Field));
    });

    // -----------------------------------------------------------------------
    // Macros: function-like #define split into a separate group
    // -----------------------------------------------------------------------

    test('function-like macros split into "Macro Functions"; constants stay in "Macros"', () => {
        const doc = makeDocument([
            '#define LOG_INFO 1',
            '#define PI 3.14159',
            '#define MAX(a,b) ((a)>(b)?(a):(b))',
            '#define SQUARE(x) ((x)*(x))',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const macros = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Macros');
        const macroFns = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Macro Functions');

        assert.ok(macros, 'Macros group must exist');
        assert.deepStrictEqual(macros.children.map(c => c.name), ['LOG_INFO', 'PI']);

        assert.ok(macroFns, 'Macro Functions group must exist');
        assert.deepStrictEqual(macroFns.children.map(c => c.name), ['MAX(a,b)', 'SQUARE(x)']);
        assert.ok(macroFns.children.every(c => c.kind === vscode.SymbolKind.Function));
    });

    test('object-like macro with a parenthesised value is NOT treated as function-like', () => {
        const doc = makeDocument([
            '#define WRAPPED (1 + 2)',   // space before ( → object-like constant
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const macros = symbols.find(s => s.kind === vscode.SymbolKind.Namespace && s.name === 'Macros');
        assert.ok(macros);
        assert.deepStrictEqual(macros.children.map(c => c.name), ['WRAPPED']);
        assert.ok(!symbols.some(s => s.name === 'Macro Functions'));
    });

    // -----------------------------------------------------------------------
    // Alphabetical sort toggle (mql_tools.Outline.SortGroupChildren)
    // -----------------------------------------------------------------------

    test('SortGroupChildren=true sorts group children by name', () => {
        const doc = makeDocument([
            '#include <Zebra.mqh>',
            '#include <Alpha.mqh>',
            '#include <Mango.mqh>',
        ].join('\n'));

        vscode.workspace._configMock = { get: (key) => key === 'Outline.SortGroupChildren' };
        try {
            const symbols = provider.provideDocumentSymbols(doc);
            const includes = symbols.find(s => s.name === 'Includes');
            assert.deepStrictEqual(
                includes.children.map(c => c.name),
                ['#include <Alpha.mqh>', '#include <Mango.mqh>', '#include <Zebra.mqh>']
            );
        } finally {
            vscode.workspace._configMock = null;
        }
    });

    test('SortGroupChildren default (off) keeps source order', () => {
        const doc = makeDocument([
            '#include <Zebra.mqh>',
            '#include <Alpha.mqh>',
        ].join('\n'));

        const symbols = provider.provideDocumentSymbols(doc);
        const includes = symbols.find(s => s.name === 'Includes');
        assert.deepStrictEqual(
            includes.children.map(c => c.name),
            ['#include <Zebra.mqh>', '#include <Alpha.mqh>']
        );
    });
});
