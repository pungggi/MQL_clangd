'use strict';
const assert = require('assert');
const { _test } = require('../src/debugInstrumentation');
const {
    MqlLineClassifier,
    isConditionSafe,
    findInjectionPoint,
    parseWatchAnnotations,
    macroForType,
    parseLocalsInScope,
    parseFunctionParams,
    sanitizeLabel,
    sanitizeCondition,
} = _test;

suite('debugInstrumentation', function () {

    // =========================================================================
    // MqlLineClassifier
    // =========================================================================

    suite('MqlLineClassifier', function () {
        let cls;
        setup(function () { cls = new MqlLineClassifier(); });

        test('blank line', function () {
            assert.strictEqual(cls.classify(''), 'blank');
            assert.strictEqual(cls.classify('   '), 'blank');
        });

        test('single-line comment', function () {
            assert.strictEqual(cls.classify('// hello'), 'comment');
            assert.strictEqual(cls.classify('  // hello'), 'comment');
        });

        test('preprocessor directive', function () {
            assert.strictEqual(cls.classify('#include <Foo.mqh>'), 'preprocessor');
            assert.strictEqual(cls.classify('#define FOO 1'), 'preprocessor');
        });

        test('multi-line macro continuation', function () {
            assert.strictEqual(cls.classify('  something \\'), 'preprocessor');
        });

        test('code line', function () {
            assert.strictEqual(cls.classify('int x = 5;'), 'code');
        });

        test('open brace line', function () {
            assert.strictEqual(cls.classify('if (x) {'), 'open_brace');
        });

        test('balanced braces on one line = code', function () {
            assert.strictEqual(cls.classify('if (x) { return; }'), 'code');
        });

        test('block comment tracking', function () {
            assert.strictEqual(cls.classify('/* start'), 'comment');
            assert.strictEqual(cls.classify('middle'), 'comment');
            assert.strictEqual(cls.classify('end */'), 'comment');
            assert.strictEqual(cls.classify('int y;'), 'code');
        });

        test('inline block comment', function () {
            assert.strictEqual(cls.classify('/* quick */ int z;'), 'code');
        });

        test('reset clears state', function () {
            cls.classify('/* open');
            cls.reset();
            assert.strictEqual(cls.classify('int a;'), 'code');
        });
    });

    // =========================================================================
    // isConditionSafe
    // =========================================================================

    suite('isConditionSafe', function () {
        test('balanced parentheses', function () {
            assert.strictEqual(isConditionSafe('(a > b) && (c < d)'), true);
        });

        test('unbalanced parentheses', function () {
            assert.strictEqual(isConditionSafe('(a > b'), false);
        });

        test('empty/null input', function () {
            assert.strictEqual(isConditionSafe(''), false);
            assert.strictEqual(isConditionSafe(null), false);
            assert.strictEqual(isConditionSafe(undefined), false);
        });

        test('string with escaped quote', function () {
            assert.strictEqual(isConditionSafe('"hello \\"world"'), true);
        });

        test('unmatched bracket types', function () {
            assert.strictEqual(isConditionSafe('(a]'), false);
        });

        test('unclosed string', function () {
            assert.strictEqual(isConditionSafe('"hello'), false);
        });
    });

    // =========================================================================
    // findInjectionPoint
    // =========================================================================

    suite('findInjectionPoint', function () {
        test('finds line ending with semicolon', function () {
            const lines = [
                'void OnTick() {',       // 1
                '  int x = 5;',          // 2  <- target
                '  double y = 1.0;',     // 3
                '}',                      // 4
            ];
            // targetLine=2 (1-based), should return index 1 (0-based) = line "int x = 5;"
            assert.strictEqual(findInjectionPoint(lines, 2), 1);
        });

        test('skips comments and blanks', function () {
            const lines = [
                'void OnTick() {',
                '  // comment',           // 2  <- target
                '',                        // 3
                '  int x = 5;',           // 4
                '}',
            ];
            assert.strictEqual(findInjectionPoint(lines, 2), 3);
        });

        test('finds line ending with closing brace', function () {
            const lines = [
                'void OnTick() {',
                '  if (true) { return; }', // 2 <- target
                '}',
            ];
            assert.strictEqual(findInjectionPoint(lines, 2), 1);
        });

        test('returns null when no safe point found', function () {
            const lines = [
                '// only comments',
                '// more comments',
                '// still comments',
            ];
            assert.strictEqual(findInjectionPoint(lines, 1), null);
        });

        test('returns null when targetLine is negative', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 5;',
                '}',
            ];
            assert.strictEqual(findInjectionPoint(lines, -1), null);
        });

        test('returns null when targetLine exceeds array length', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 5;',
                '}',
            ];
            assert.strictEqual(findInjectionPoint(lines, lines.length + 5), null);
        });

        test('skips preprocessor directives', function () {
            const lines = [
                'void Foo() {',
                '#ifdef __MQL5__',        // 2 <- target
                '  int x = 5;',           // 3
                '#endif',                  // 4
                '}',
            ];
            assert.strictEqual(findInjectionPoint(lines, 2), 2);
        });
    });

    // =========================================================================
    // parseWatchAnnotations
    // =========================================================================

    suite('parseWatchAnnotations', function () {
        test('finds @watch annotation before breakpoint', function () {
            const lines = [
                'void Foo() {',
                '  // @watch myVar otherVar',
                '  int x = 5;',         // bp on line 3
                '}',
            ];
            const vars = parseWatchAnnotations(lines, 3);
            assert.deepStrictEqual(vars, ['myVar', 'otherVar']);
        });

        test('returns empty when no annotation', function () {
            const lines = [
                'void Foo() {',
                '  int x = 5;',
                '}',
            ];
            assert.deepStrictEqual(parseWatchAnnotations(lines, 2), []);
        });

        test('deduplicates variable names', function () {
            const lines = [
                '// @watch a b',
                '// @watch b c',
                'int x;',
            ];
            const vars = parseWatchAnnotations(lines, 3);
            assert.deepStrictEqual(vars, ['a', 'b', 'c']);
        });
    });

    // =========================================================================
    // macroForType
    // =========================================================================

    suite('macroForType', function () {
        test('int types map to WATCH_INT', function () {
            assert.strictEqual(macroForType('int'), 'MQL_DBG_WATCH_INT');
            assert.strictEqual(macroForType('uint'), 'MQL_DBG_WATCH_INT');
            assert.strictEqual(macroForType('short'), 'MQL_DBG_WATCH_INT');
            assert.strictEqual(macroForType('color'), 'MQL_DBG_WATCH_INT');
        });

        test('long types map to WATCH_LONG', function () {
            assert.strictEqual(macroForType('long'), 'MQL_DBG_WATCH_LONG');
            assert.strictEqual(macroForType('ulong'), 'MQL_DBG_WATCH_LONG');
        });

        test('float types map to WATCH_DBL', function () {
            assert.strictEqual(macroForType('double'), 'MQL_DBG_WATCH_DBL');
            assert.strictEqual(macroForType('float'), 'MQL_DBG_WATCH_DBL');
        });

        test('string maps to WATCH_STR', function () {
            assert.strictEqual(macroForType('string'), 'MQL_DBG_WATCH_STR');
        });

        test('bool maps to WATCH_BOOL', function () {
            assert.strictEqual(macroForType('bool'), 'MQL_DBG_WATCH_BOOL');
        });

        test('datetime maps to WATCH_DATETIME', function () {
            assert.strictEqual(macroForType('datetime'), 'MQL_DBG_WATCH_DATETIME');
        });

        test('ENUM_ prefix maps to WATCH_INT', function () {
            assert.strictEqual(macroForType('ENUM_ORDER_TYPE'), 'MQL_DBG_WATCH_INT');
            assert.strictEqual(macroForType('ENUM_TIMEFRAMES'), 'MQL_DBG_WATCH_INT');
        });

        test('unknown type falls back to WATCH (double)', function () {
            assert.strictEqual(macroForType('SomeClass'), 'MQL_DBG_WATCH');
        });

        test('null/undefined falls back to WATCH', function () {
            assert.strictEqual(macroForType(null), 'MQL_DBG_WATCH');
            assert.strictEqual(macroForType(undefined), 'MQL_DBG_WATCH');
        });

        test('strips const/static modifiers', function () {
            assert.strictEqual(macroForType('const int'), 'MQL_DBG_WATCH_INT');
            assert.strictEqual(macroForType('static double'), 'MQL_DBG_WATCH_DBL');
        });

        test('array macros', function () {
            assert.strictEqual(macroForType('int', true), 'MQL_DBG_WATCH_ARRAY_INT');
            assert.strictEqual(macroForType('double', true), 'MQL_DBG_WATCH_ARRAY_DBL');
            assert.strictEqual(macroForType('string', true), 'MQL_DBG_WATCH_ARRAY_STR');
        });

        test('unsupported array type returns null', function () {
            assert.strictEqual(macroForType('SomeClass', true), null);
        });
    });

    // =========================================================================
    // parseLocalsInScope
    // =========================================================================

    suite('parseLocalsInScope', function () {
        test('finds locals before breakpoint', function () {
            const lines = [
                'void OnTick() {',        // 1
                '  int count = 0;',       // 2
                '  double price = 1.5;',  // 3
                '  // bp here',           // 4
                '}',                       // 5
            ];
            const locals = parseLocalsInScope(lines, 4);
            const names = locals.map(l => l.name);
            assert.ok(names.includes('count'), 'should find count');
            assert.ok(names.includes('price'), 'should find price');
        });

        test('includes function parameters', function () {
            const lines = [
                'void Foo(int bar, double baz) {',
                '  int x = 1;',           // 2 - bp
                '}',
            ];
            const locals = parseLocalsInScope(lines, 2);
            const names = locals.map(l => l.name);
            assert.deepStrictEqual(names.sort(), ['bar', 'baz', 'x']);
        });

        test('returns empty for out of range', function () {
            assert.deepStrictEqual(parseLocalsInScope([], 1), []);
            assert.deepStrictEqual(parseLocalsInScope(['int x;'], 0), []);
        });
    });

    // =========================================================================
    // parseFunctionParams
    // =========================================================================

    suite('parseFunctionParams', function () {
        test('parses simple parameters', function () {
            const lines = [
                'void Foo(int a, double b) {',   // 0 - braceLineIdx
                '  int x;',
                '}',
            ];
            const params = parseFunctionParams(lines, 0);
            assert.ok(params.some(p => p.name === 'a' && p.type === 'int'));
            assert.ok(params.some(p => p.name === 'b' && p.type === 'double'));
        });

        test('handles empty parameters', function () {
            const lines = [
                'void Bar() {',
                '}',
            ];
            const params = parseFunctionParams(lines, 0);
            assert.deepStrictEqual(params, []);
        });
    });

    // =========================================================================
    // sanitizeLabel / sanitizeCondition
    // =========================================================================

    suite('sanitizeLabel', function () {
        test('replaces non-alphanumeric characters with underscores', function () {
            assert.strictEqual(sanitizeLabel('test"label\\with|pipes'), 'test_label_with_pipes');
        });

        test('preserves alphanumeric, underscores and hyphens', function () {
            assert.strictEqual(sanitizeLabel('bp_42-line'), 'bp_42-line');
        });

        test('returns empty for null/undefined', function () {
            assert.strictEqual(sanitizeLabel(null), '');
            assert.strictEqual(sanitizeLabel(undefined), '');
        });
    });

    suite('sanitizeCondition', function () {
        test('passes through simple conditions unchanged', function () {
            const result = sanitizeCondition('x > 5 && y < 10');
            assert.strictEqual(result, 'x > 5 && y < 10');
        });

        test('escapes comment delimiters', function () {
            assert.strictEqual(sanitizeCondition('x /* comment */ y'), 'x /\\* comment *\\/ y');
        });

        test('escapes newlines', function () {
            assert.strictEqual(sanitizeCondition('x > 5\n&& y < 10'), 'x > 5\\n&& y < 10');
        });

        test('returns empty for null/undefined', function () {
            assert.strictEqual(sanitizeCondition(null), '');
            assert.strictEqual(sanitizeCondition(undefined), '');
        });
    });
});
