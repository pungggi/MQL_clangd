'use strict';
const assert = require('assert');
const { _test } = require('../src/debugInstrumentation');
const {
    MqlLineClassifier,
    isConditionSafe,
    isExpressionSafe,
    SAFE_READONLY_FUNCTIONS,
    findInjectionPoint,
    parseWatchAnnotations,
    macroForType,
    parseLocalsInScope,
    parseFunctionParams,
    sanitizeLabel,
    sanitizeCondition,
    buildLogExpression,
    buildProbeInjection,
    scoreVariableRelevance,
    findEnclosingControlFlowVars,
    findFunctionCallArgs,
    collectWatchVars,
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
    // isExpressionSafe
    // =========================================================================

    suite('isExpressionSafe', function () {
        test('allows simple variable access', function () {
            const r = isExpressionSafe('myVar');
            assert.strictEqual(r.safe, true);
        });

        test('allows arithmetic expressions', function () {
            const r = isExpressionSafe('(a + b) * 2.0');
            assert.strictEqual(r.safe, true);
        });

        test('allows allowlisted function calls', function () {
            assert.strictEqual(isExpressionSafe('SymbolInfoDouble(_Symbol, SYMBOL_ASK)').safe, true);
            assert.strictEqual(isExpressionSafe('OrdersTotal()').safe, true);
            assert.strictEqual(isExpressionSafe('MathAbs(x - y)').safe, true);
            assert.strictEqual(isExpressionSafe('ArraySize(arr)').safe, true);
            assert.strictEqual(isExpressionSafe('StringLen(s)').safe, true);
        });

        test('allows nested allowlisted calls', function () {
            const r = isExpressionSafe('NormalizeDouble(SymbolInfoDouble(_Symbol, SYMBOL_ASK), 5)');
            assert.strictEqual(r.safe, true);
        });

        test('allows type casts that look like function calls', function () {
            assert.strictEqual(isExpressionSafe('int(myDouble)').safe, true);
            assert.strictEqual(isExpressionSafe('double(myInt) + 1.0').safe, true);
            assert.strictEqual(isExpressionSafe('string(value)').safe, true);
        });

        test('rejects dangerous function calls — OrderSend', function () {
            const r = isExpressionSafe('OrderSend(request, result)');
            assert.strictEqual(r.safe, false);
            assert.ok(r.reason.includes('OrderSend'));
        });

        test('rejects FileDelete', function () {
            const r = isExpressionSafe('FileDelete("data.csv")');
            assert.strictEqual(r.safe, false);
            assert.ok(r.reason.includes('FileDelete'));
        });

        test('rejects WebRequest', function () {
            const r = isExpressionSafe('WebRequest("POST", url, headers, timeout, data, res, resHeaders)');
            assert.strictEqual(r.safe, false);
            assert.ok(r.reason.includes('WebRequest'));
        });

        test('rejects unknown user functions', function () {
            const r = isExpressionSafe('MyCustomFunction(x)');
            assert.strictEqual(r.safe, false);
            assert.ok(r.reason.includes('MyCustomFunction'));
        });

        test('rejects semicolons (statement injection)', function () {
            const r = isExpressionSafe('x; OrderSend(req, res)');
            assert.strictEqual(r.safe, false);
            assert.strictEqual(r.reason, 'semicolons not allowed');
        });

        test('rejects preprocessor directives', function () {
            const r = isExpressionSafe('#include <evil.mqh>');
            assert.strictEqual(r.safe, false);
            assert.strictEqual(r.reason, 'preprocessor directives not allowed');
        });

        test('rejects unbalanced delimiters', function () {
            const r = isExpressionSafe('SymbolInfoDouble(_Symbol');
            assert.strictEqual(r.safe, false);
            assert.strictEqual(r.reason, 'unbalanced delimiters');
        });

        test('rejects empty/null', function () {
            assert.strictEqual(isExpressionSafe('').safe, false);
            assert.strictEqual(isExpressionSafe(null).safe, false);
            assert.strictEqual(isExpressionSafe(undefined).safe, false);
        });

        test('SAFE_READONLY_FUNCTIONS contains expected entries', function () {
            assert.ok(SAFE_READONLY_FUNCTIONS.has('SymbolInfoDouble'));
            assert.ok(SAFE_READONLY_FUNCTIONS.has('OrdersTotal'));
            assert.ok(SAFE_READONLY_FUNCTIONS.has('MathAbs'));
            assert.ok(SAFE_READONLY_FUNCTIONS.has('ArraySize'));
            assert.ok(SAFE_READONLY_FUNCTIONS.has('TimeCurrent'));
            // Should NOT contain side-effecting functions
            assert.ok(!SAFE_READONLY_FUNCTIONS.has('OrderSend'));
            assert.ok(!SAFE_READONLY_FUNCTIONS.has('FileDelete'));
            assert.ok(!SAFE_READONLY_FUNCTIONS.has('WebRequest'));
            assert.ok(!SAFE_READONLY_FUNCTIONS.has('Print'));
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
            const result = parseWatchAnnotations(lines, 3);
            assert.deepStrictEqual(result.names, ['myVar', 'otherVar']);
            assert.deepStrictEqual(result.expressions, []);
        });

        test('returns empty when no annotation', function () {
            const lines = [
                'void Foo() {',
                '  int x = 5;',
                '}',
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.deepStrictEqual(result.names, []);
            assert.deepStrictEqual(result.expressions, []);
        });

        test('deduplicates variable names', function () {
            const lines = [
                '// @watch a b',
                '// @watch b c',
                'int x;',
            ];
            const result = parseWatchAnnotations(lines, 3);
            assert.deepStrictEqual(result.names, ['a', 'b', 'c']);
        });

        test('parses typed expression watch', function () {
            const lines = [
                'void OnTick() {',
                '  // @watch:double SymbolInfoDouble(_Symbol, SYMBOL_ASK)',
                '  Print("test");',  // bp on line 3
                '}',
            ];
            const result = parseWatchAnnotations(lines, 3);
            assert.strictEqual(result.expressions.length, 1);
            assert.strictEqual(result.expressions[0].type, 'double');
            assert.strictEqual(result.expressions[0].expr, 'SymbolInfoDouble(_Symbol, SYMBOL_ASK)');
        });

        test('mixed simple and typed annotations', function () {
            const lines = [
                '// @watch x y',
                '// @watch:int OrdersTotal()',
                'int z;',  // bp on line 3
            ];
            const result = parseWatchAnnotations(lines, 3);
            assert.deepStrictEqual(result.names, ['x', 'y']);
            assert.strictEqual(result.expressions.length, 1);
            assert.strictEqual(result.expressions[0].type, 'int');
        });

        test('rejects unsafe expression watches and reports them', function () {
            const lines = [
                '// @watch:int OrderSend(request, result)',
                'int z;',  // bp on line 2
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.strictEqual(result.expressions.length, 0, 'should not include unsafe expression');
            assert.strictEqual(result.rejected.length, 1, 'should report rejection');
            assert.ok(result.rejected[0].reason.includes('OrderSend'));
            assert.strictEqual(result.rejected[0].line, 1);
        });

        test('accepts safe and rejects unsafe in same block', function () {
            const lines = [
                '// @watch:double SymbolInfoDouble(_Symbol, SYMBOL_ASK)',
                '// @watch:int FileDelete("bad.csv")',
                'Print("test");',  // bp on line 3
            ];
            const result = parseWatchAnnotations(lines, 3);
            assert.strictEqual(result.expressions.length, 1, 'safe expression accepted');
            assert.strictEqual(result.expressions[0].expr, 'SymbolInfoDouble(_Symbol, SYMBOL_ASK)');
            assert.strictEqual(result.rejected.length, 1, 'unsafe expression rejected');
            assert.ok(result.rejected[0].reason.includes('FileDelete'));
        });

        test('@watch!: bypasses safety checks for dangerous calls', function () {
            const lines = [
                '// @watch!:int OrderSend(request, result)',
                'int z;',  // bp on line 2
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.strictEqual(result.expressions.length, 1, 'unsafe expression allowed with !');
            assert.strictEqual(result.expressions[0].expr, 'OrderSend(request, result)');
            assert.strictEqual(result.expressions[0].type, 'int');
            assert.strictEqual(result.rejected.length, 0, 'no rejections');
        });

        test('@watch!: still rejects unbalanced delimiters', function () {
            const lines = [
                '// @watch!:int OrderSend(request',
                'int z;',  // bp on line 2
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.strictEqual(result.expressions.length, 0, 'unbalanced still rejected');
            assert.strictEqual(result.rejected.length, 1);
            assert.strictEqual(result.rejected[0].reason, 'unbalanced delimiters');
        });

        test('@watch!: allows user-defined functions', function () {
            const lines = [
                '// @watch!:double MyCustomCalculation(x, y, z)',
                'Print("test");',  // bp on line 2
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.strictEqual(result.expressions.length, 1);
            assert.strictEqual(result.expressions[0].expr, 'MyCustomCalculation(x, y, z)');
        });

        test('@watch: without ! rejects same user-defined function', function () {
            const lines = [
                '// @watch:double MyCustomCalculation(x, y, z)',
                'Print("test");',  // bp on line 2
            ];
            const result = parseWatchAnnotations(lines, 2);
            assert.strictEqual(result.expressions.length, 0, 'rejected without !');
            assert.strictEqual(result.rejected.length, 1);
            assert.ok(result.rejected[0].reason.includes('MyCustomCalculation'));
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

    // =========================================================================
    // buildLogExpression
    // =========================================================================

    suite('buildLogExpression', function () {
        test('plain text without interpolation', function () {
            const result = buildLogExpression('hello world', []);
            assert.strictEqual(result, '"hello world"');
        });

        test('empty/null template returns empty string literal', function () {
            assert.strictEqual(buildLogExpression('', []), '""');
            assert.strictEqual(buildLogExpression(null, []), '""');
            assert.strictEqual(buildLogExpression(undefined, []), '""');
        });

        test('single {expr} with int type', function () {
            const vars = [{ name: 'count', type: 'int' }];
            const result = buildLogExpression('count={count}', vars);
            assert.strictEqual(result, '"count=" + IntegerToString((long)(count))');
        });

        test('single {expr} with double type', function () {
            const vars = [{ name: 'price', type: 'double' }];
            const result = buildLogExpression('price={price}', vars);
            assert.strictEqual(result, '"price=" + DoubleToString((double)(price), 8)');
        });

        test('single {expr} with string type', function () {
            const vars = [{ name: 'name', type: 'string' }];
            const result = buildLogExpression('name={name}', vars);
            assert.strictEqual(result, '"name=" + (name)');
        });

        test('single {expr} with bool type', function () {
            const vars = [{ name: 'flag', type: 'bool' }];
            const result = buildLogExpression('flag={flag}', vars);
            assert.strictEqual(result, '"flag=" + ((flag) ? "true" : "false")');
        });

        test('single {expr} with datetime type', function () {
            const vars = [{ name: 'ts', type: 'datetime' }];
            const result = buildLogExpression('time={ts}', vars);
            assert.strictEqual(result, '"time=" + TimeToString((datetime)(ts), TIME_DATE | TIME_SECONDS)');
        });

        test('single {expr} with long type', function () {
            const vars = [{ name: 'ticket', type: 'ulong' }];
            const result = buildLogExpression('ticket={ticket}', vars);
            assert.strictEqual(result, '"ticket=" + IntegerToString((long)(ticket))');
        });

        test('single {expr} with enum type', function () {
            const vars = [{ name: 'ot', type: 'ENUM_ORDER_TYPE' }];
            const result = buildLogExpression('type={ot}', vars);
            assert.strictEqual(result, '"type=" + IntegerToString((long)(ot))');
        });

        test('multiple interpolations', function () {
            const vars = [
                { name: 'x', type: 'int' },
                { name: 'y', type: 'double' },
            ];
            const result = buildLogExpression('x={x}, y={y}', vars);
            assert.strictEqual(result, '"x=" + IntegerToString((long)(x)) + ", y=" + DoubleToString((double)(y), 8)');
        });

        test('unknown type falls back to (string) cast', function () {
            const vars = [{ name: 'obj', type: 'CMyClass' }];
            const result = buildLogExpression('obj={obj}', vars);
            assert.strictEqual(result, '"obj=" + (string)(obj)');
        });

        test('expression not in watchVars falls back to (string) cast', function () {
            const result = buildLogExpression('val={unknown}', []);
            assert.strictEqual(result, '"val=" + (string)(unknown)');
        });

        test('unclosed brace treated as literal', function () {
            const result = buildLogExpression('hello {world', []);
            // Implementation splits at '{', then finds no '}', treats rest as literal
            assert.strictEqual(result, '"hello " + "{world"');
        });

        test('empty braces produce literal {}', function () {
            const result = buildLogExpression('a {} b', []);
            assert.strictEqual(result, '"a " + "{}" + " b"');
        });

        test('strips const/static from type before matching', function () {
            const vars = [{ name: 'x', type: 'const int' }];
            const result = buildLogExpression('{x}', vars);
            assert.strictEqual(result, 'IntegerToString((long)(x))');
        });

        test('float type uses DoubleToString', function () {
            const vars = [{ name: 'f', type: 'float' }];
            const result = buildLogExpression('{f}', vars);
            assert.strictEqual(result, 'DoubleToString((double)(f), 8)');
        });

        test('{{ produces literal open brace', function () {
            const result = buildLogExpression('a {{ b', []);
            assert.strictEqual(result, '"a " + "{" + " b"');
        });

        test('}} produces literal close brace', function () {
            const result = buildLogExpression('a }} b', []);
            assert.strictEqual(result, '"a } b"');
        });

        test('{{expr}} produces literal braces around text', function () {
            const result = buildLogExpression('{{hello}}', []);
            assert.strictEqual(result, '"{" + "hello}"');
        });

        test('escaped braces mixed with interpolation', function () {
            const vars = [{ name: 'x', type: 'int' }];
            const result = buildLogExpression('val={{x}}', vars);
            // {{ → literal {, then {x} is expression, then }} would need
            // to appear but here after {x} there's only }
            // Actually: "val={{x}}" → v a l = { { x } }
            // First { at 4, template[5]='{' → literal {, pos=6
            // Next { at 6... wait: "val={{x}}" positions:
            //   v(0) a(1) l(2) =(3) {(4) {(5) x(6) }(7) }(8)
            // openIdx=4, template[5]='{' → push "val=", push "{", pos=6
            // openIdx=indexOf('{',6)=-1, rest is "x}}" → replace }} → "x}"
            // Result: "val=" + "{" + "x}"
            assert.strictEqual(result, '"val=" + "{" + "x}"');
        });

        test('}} at end of string after expression', function () {
            const vars = [{ name: 'x', type: 'int' }];
            const result = buildLogExpression('{x}}}', vars);
            // {x} is expression, then }} → literal }
            assert.strictEqual(result, 'IntegerToString((long)(x)) + "}"');
        });

        test('standalone }} with no expressions', function () {
            const result = buildLogExpression('}}', []);
            assert.strictEqual(result, '"}"');
        });

        test('standalone {{ with no expressions', function () {
            const result = buildLogExpression('{{', []);
            assert.strictEqual(result, '"{"');
        });
    });

    // =========================================================================
    // buildProbeInjection
    // =========================================================================

    suite('buildProbeInjection', function () {
        test('basic probe without logMessage contains PAUSE', function () {
            const lines = buildProbeInjection(0, 'bp_test_1', [], '');
            const joined = lines.join('\n');
            assert.ok(joined.includes('MqlDebugProbeCheck(0)'), 'should check probe');
            assert.ok(joined.includes('MQL_DBG_BBREAK("bp_test_1")'), 'should emit BREAK (batch)');
            assert.ok(joined.includes('MQL_DBG_PAUSE'), 'should contain PAUSE');
            assert.ok(joined.includes('MqlDebugBatchStart()'), 'should start batch');
            assert.ok(joined.includes('MqlDebugBatchFlush()'), 'should flush batch');
        });

        test('probe without logMessage has runtime logpoint check to skip PAUSE', function () {
            const lines = buildProbeInjection(5, 'bp_test_5', [], '');
            const joined = lines.join('\n');
            assert.ok(joined.includes('MqlDebugIsLogpoint(5)'), 'should check logpoint at runtime');
            assert.ok(joined.includes('MQL_DBG_PAUSE'), 'should still contain PAUSE for break mode');
        });

        test('probe with logMessage generates dual path with MQL_DBG_LOG', function () {
            const vars = [{ name: 'x', type: 'int' }];
            const lines = buildProbeInjection(3, 'bp_test_3', vars, '', 'x={x}');
            const joined = lines.join('\n');
            assert.ok(joined.includes('MqlDebugIsLogpoint(3)'), 'should check logpoint flag');
            assert.ok(joined.includes('MQL_DBG_LOG('), 'should contain LOG macro');
            assert.ok(joined.includes('IntegerToString'), 'should have interpolated expression');
            assert.ok(joined.includes('MQL_DBG_PAUSE'), 'should have PAUSE in break branch');
        });

        test('logpoint path does not include PAUSE', function () {
            const lines = buildProbeInjection(3, 'bp_test_3', [], '', 'hello');
            const joined = lines.join('\n');
            // Find the logpoint branch (between MqlDebugIsLogpoint and } else)
            const logpointStart = joined.indexOf('MqlDebugIsLogpoint');
            const elseIdx = joined.indexOf('} else {', logpointStart);
            const logpointBranch = joined.substring(logpointStart, elseIdx);
            assert.ok(!logpointBranch.includes('MQL_DBG_PAUSE'), 'logpoint branch should not PAUSE');
        });

        test('probe with condition includes condition in guard', function () {
            const lines = buildProbeInjection(0, 'bp_test_1', [], 'x > 5');
            const joined = lines.join('\n');
            assert.ok(joined.includes('&& (x > 5)'), 'should include condition expression');
        });

        test('probe with watch vars includes batch watch macros', function () {
            const vars = [
                { name: 'count', type: 'int' },
                { name: 'price', type: 'double' },
            ];
            const lines = buildProbeInjection(0, 'bp_test_1', vars, '');
            const joined = lines.join('\n');
            assert.ok(joined.includes('MQL_DBG_BWATCH_INT("count", count)'), 'should watch int (batch)');
            assert.ok(joined.includes('MQL_DBG_BWATCH_DBL("price", price)'), 'should watch double (batch)');
        });

        test('no-logMessage fallback: logpoint emits BREAK + watches without PAUSE', function () {
            const vars = [{ name: 'x', type: 'int' }];
            const lines = buildProbeInjection(7, 'bp_test_7', vars, '');
            const joined = lines.join('\n');
            // Should have batch BREAK and watch in the main body (before logpoint check)
            assert.ok(joined.includes('MQL_DBG_BBREAK("bp_test_7")'), 'should have BREAK (batch)');
            assert.ok(joined.includes('MQL_DBG_BWATCH_INT("x", x)'), 'should have watch (batch)');
            // PAUSE is conditional on NOT being a logpoint
            assert.ok(joined.includes('!MqlDebugIsLogpoint(7)'),
                'should guard PAUSE with logpoint check');
            assert.ok(joined.includes('MQL_DBG_PAUSE'),
                'should contain PAUSE in break branch');
        });
    });

    // =========================================================================
    // scoreVariableRelevance
    // =========================================================================

    suite('scoreVariableRelevance', function () {
        test('variable assigned on BP line gets highest score', function () {
            const lines = ['void OnTick() {', '  int x = 5;', '  x = 10;', '  Print(x);', '}'];
            const score = scoreVariableRelevance(lines, 3, 'x'); // line 3 is "x = 10;"
            assert.ok(score >= 10, `expected >= 10 for BP-line assignment, got ${score}`);
        });

        test('variable assigned 2 lines before BP scores high', function () {
            const lines = ['void OnTick() {', '  int x = 5;', '  double y = 1.0;', '  Print(x);', '}'];
            const score = scoreVariableRelevance(lines, 4, 'x'); // x assigned at line 2, BP at line 4
            assert.ok(score > 0, `expected > 0, got ${score}`);
        });

        test('unreferenced variable scores zero', function () {
            const lines = ['void OnTick() {', '  int x = 5;', '  Print(y);', '}'];
            const score = scoreVariableRelevance(lines, 3, 'z'); // z not in code at all
            assert.strictEqual(score, 0);
        });

        test('frequently used variable gets frequency bonus', function () {
            const lines = [
                'void OnTick() {',
                '  int x = arr[x] + x;',
                '  if (x > 0) x++;',
                '  Print(x);', // BP here (line 4)
                '}',
            ];
            const score = scoreVariableRelevance(lines, 4, 'x');
            // x appears on multiple lines near BP, should get frequency bonus
            assert.ok(score >= 3, `expected >= 3 for frequent var, got ${score}`);
        });
    });

    // =========================================================================
    // findEnclosingControlFlowVars
    // =========================================================================

    suite('findEnclosingControlFlowVars', function () {
        test('detects variables in if-condition', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 5;',
                '  if (x > threshold) {',
                '    Print(x);', // BP here (line 4)
                '  }',
                '}',
            ];
            const vars = findEnclosingControlFlowVars(lines, 4);
            assert.ok(vars.includes('x'), 'should find x');
            assert.ok(vars.includes('threshold'), 'should find threshold');
        });

        test('detects loop iterator in for-loop', function () {
            const lines = [
                'void OnTick() {',
                '  for (int i = 0; i < count; i++) {',
                '    arr[i] = 0;', // BP here (line 3)
                '  }',
                '}',
            ];
            const vars = findEnclosingControlFlowVars(lines, 3);
            assert.ok(vars.includes('i'), 'should find i');
            assert.ok(vars.includes('count'), 'should find count');
        });

        test('detects while-condition variables', function () {
            const lines = [
                'void OnTick() {',
                '  while (pos >= 0) {',
                '    Process(pos);', // BP here (line 3)
                '  }',
                '}',
            ];
            const vars = findEnclosingControlFlowVars(lines, 3);
            assert.ok(vars.includes('pos'), 'should find pos');
        });

        test('returns empty when not inside control flow', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 5;', // BP here (line 2)
                '}',
            ];
            const vars = findEnclosingControlFlowVars(lines, 2);
            assert.deepStrictEqual(vars, []);
        });
    });

    // =========================================================================
    // findFunctionCallArgs
    // =========================================================================

    suite('findFunctionCallArgs', function () {
        test('detects arguments on BP line', function () {
            const lines = [
                'void OnTick() {',
                '  OrderSend(request, result);', // BP here (line 2)
                '}',
            ];
            const vars = findFunctionCallArgs(lines, 2);
            assert.ok(vars.includes('request'), 'should find request');
            assert.ok(vars.includes('result'), 'should find result');
        });

        test('detects arguments on adjacent lines', function () {
            const lines = [
                'void OnTick() {',
                '  Print(msg);',
                '  int x = 0;', // BP here (line 3)
                '  Send(data);',
                '}',
            ];
            const vars = findFunctionCallArgs(lines, 3);
            assert.ok(vars.includes('msg'), 'should find msg from line before');
            assert.ok(vars.includes('data'), 'should find data from line after');
        });

        test('skips nested function calls as arguments', function () {
            const lines = [
                'void OnTick() {',
                '  Print(StringLen(text));', // BP here (line 2)
                '}',
            ];
            const vars = findFunctionCallArgs(lines, 2);
            // StringLen is a function call, should not appear as a variable
            assert.ok(!vars.includes('StringLen'), 'should not include function name');
            assert.ok(vars.includes('text'), 'should find text');
        });

        test('returns empty with no function calls', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 5;', // BP here (line 2)
                '}',
            ];
            const vars = findFunctionCallArgs(lines, 2);
            assert.deepStrictEqual(vars, []);
        });
    });

    // =========================================================================
    // macroForType batch mode
    // =========================================================================

    suite('macroForType batch mode', function () {
        test('returns batch macro for int', function () {
            assert.strictEqual(macroForType('int', false, true), 'MQL_DBG_BWATCH_INT');
        });

        test('returns batch macro for double', function () {
            assert.strictEqual(macroForType('double', false, true), 'MQL_DBG_BWATCH_DBL');
        });

        test('returns batch macro for string', function () {
            assert.strictEqual(macroForType('string', false, true), 'MQL_DBG_BWATCH_STR');
        });

        test('returns batch array macro for int[]', function () {
            assert.strictEqual(macroForType('int', true, true), 'MQL_DBG_BWATCH_ARRAY_INT');
        });

        test('returns batch fallback for unknown type', function () {
            assert.strictEqual(macroForType(null, false, true), 'MQL_DBG_BWATCH');
        });

        test('returns non-batch macro when batch=false', function () {
            assert.strictEqual(macroForType('int', false, false), 'MQL_DBG_WATCH_INT');
        });

        test('batch enum type returns BWATCH_INT', function () {
            assert.strictEqual(macroForType('ENUM_ORDER_TYPE', false, true), 'MQL_DBG_BWATCH_INT');
        });
    });

    // =========================================================================
    // buildProbeInjection — expression watches
    // =========================================================================

    suite('buildProbeInjection — expression watches', function () {
        test('expression watch injects expression verbatim as value', function () {
            const vars = [
                { name: 'SymbolInfoDouble(...)', type: 'double', isExpression: true, expr: 'SymbolInfoDouble(_Symbol, SYMBOL_ASK)' },
            ];
            const lines = buildProbeInjection(0, 'bp_test_1', vars, '');
            const joined = lines.join('\n');
            assert.ok(
                joined.includes('MQL_DBG_BWATCH_DBL("SymbolInfoDouble(...)", SymbolInfoDouble(_Symbol, SYMBOL_ASK))'),
                'should inject expression as value argument'
            );
        });

        test('expression watch with int type uses BWATCH_INT', function () {
            const vars = [
                { name: 'OrdersTotal()', type: 'int', isExpression: true, expr: 'OrdersTotal()' },
            ];
            const lines = buildProbeInjection(0, 'bp_test_1', vars, '');
            const joined = lines.join('\n');
            assert.ok(
                joined.includes('MQL_DBG_BWATCH_INT("OrdersTotal()", OrdersTotal())'),
                'should use int macro for int expression'
            );
        });

        test('mixed regular and expression watches', function () {
            const vars = [
                { name: 'x', type: 'int' },
                { name: 'Ask price', type: 'double', isExpression: true, expr: 'SymbolInfoDouble(_Symbol, SYMBOL_ASK)' },
            ];
            const lines = buildProbeInjection(0, 'bp_test_1', vars, '');
            const joined = lines.join('\n');
            assert.ok(joined.includes('MQL_DBG_BWATCH_INT("x", x)'), 'regular watch');
            assert.ok(joined.includes('SymbolInfoDouble(_Symbol, SYMBOL_ASK)'), 'expression watch');
        });
    });

    // =========================================================================
    // collectWatchVars — integration
    // =========================================================================

    suite('collectWatchVars — integration', function () {
        const emptyTypeDB = { classMap: new Map(), globalMap: new Map() };

        test('collects locals and sorts by relevance', function () {
            const lines = [
                'void OnTick() {',
                '  int x = 0;',
                '  int unused = 99;',
                '  double y = 1.0;',
                '  y = Ask;',         // y is assigned here (line 5), 1 line before BP
                '  Print(y);',        // BP on line 6 — y is referenced here
                '}',
            ];
            const vars = collectWatchVars(lines, 6, emptyTypeDB, false);
            const names = vars.map(v => v.name);
            assert.ok(names.includes('x'), 'should include x');
            assert.ok(names.includes('y'), 'should include y');
            assert.ok(names.includes('unused'), 'should include unused');
            // y (assigned 1 line before BP, referenced on BP line) should rank above unused (far away, no refs)
            assert.ok(names.indexOf('y') < names.indexOf('unused'), 'y should sort before unused');
        });

        test('includes expression watches from @watch:type annotations', function () {
            const lines = [
                'void OnTick() {',
                '  // @watch:double SymbolInfoDouble(_Symbol, SYMBOL_ASK)',
                '  int x = 5;',   // BP on line 3
                '}',
            ];
            const vars = collectWatchVars(lines, 3, emptyTypeDB, false);
            const exprWatch = vars.find(v => v.isExpression);
            assert.ok(exprWatch, 'should include expression watch');
            assert.strictEqual(exprWatch.type, 'double');
            assert.strictEqual(exprWatch.expr, 'SymbolInfoDouble(_Symbol, SYMBOL_ASK)');
        });
    });
});
