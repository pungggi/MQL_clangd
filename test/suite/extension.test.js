const assert = require('assert');
const Module = require('module');

// 1. Hook the Node.js module loader to intercept 'vscode'
const vscodeMock = require('../mocks/vscode');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.apply(this, arguments);
};

// 2. Load the modules under test (they will now get the mock)
const extension = require('../../src/extension');
const {
    replaceLog,
    extractPropertyVersion,
    formatCompileTargetLabel,
    buildCompileProgressTitle,
    buildMetaEditorCmd,
    normalizeSpecialLiteralSpacing,
    shouldFocusProblemsPanel,
    shouldRunCompileSuccessAction,
    runCompileSuccessAction,
    resolveHeaderCompilePlan
} = extension;
const { normalizePath, generatePortableSwitch, safeConfigUpdate } = require('../../src/createProperties');

suite('Core Logic Unit Tests (Independent)', () => {

    test('Path Normalization', () => {
        assert.strictEqual(normalizePath('C:\\Users\\Test'), 'C:/Users/Test');
        assert.strictEqual(normalizePath('folder\\subfolder'), 'folder/subfolder');
        assert.strictEqual(normalizePath(''), '');
    });

    test('Log Parsing - Compilation Start', () => {
        const logStr = 'C:\\Project : information: compiling \'Main.mq5\'';
        const result = replaceLog(logStr, true);
        assert.strictEqual(result.text.includes('Main.mq5'), true);
    });

    test('Log Parsing - Error Detection', () => {
        const logStr = 'C:\\Project\\Main.mq5(10,5) : error 123: unexpected token';
        const result = replaceLog(logStr, true);

        assert.strictEqual(result.error, true);
        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(result.diagnostics[0].message, 'unexpected token');
        assert.strictEqual(result.diagnostics[0].file, 'C:\\Project\\Main.mq5');
        assert.strictEqual(result.diagnostics[0].range.start.line, 9); // 10-1
        assert.strictEqual(result.diagnostics[0].range.start.character, 4); // 5-1
        assert.strictEqual(result.diagnostics[0].severity, 0); // Error
    });

    test('Log Parsing - Error Detection without winePrefix leaves path unchanged (Windows compat)', () => {
        const logStr = 'C:\\Project\\Main.mq5(10,5) : error 123: unexpected token';
        // No winePrefix → backward-compatible: Windows path is kept as-is
        const result = replaceLog(logStr, true, '');
        assert.strictEqual(result.diagnostics[0].file, 'C:\\Project\\Main.mq5');
    });

    test('Log Parsing - Diagnostics also parsed when f=false (compile mode)', () => {
        const logStr = 'C:\\Project\\Main.mq5(10,5) : error 123: unexpected token';
        const result = replaceLog(logStr, false);

        assert.strictEqual(result.error, true);
        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(result.diagnostics[0].message, 'unexpected token');
    });

    test('Log Parsing - Warning Detection', () => {
        const logStr = 'C:\\Project\\Main.mq5(20,1) : warning 456: obsolete function';
        const result = replaceLog(logStr, true);

        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(result.diagnostics[0].severity, 1); // Warning
    });

    test('Log Parsing - Result Line', () => {
        const logStr = '0 error(s), 0 warning(s), compile time: 100 msec';
        const result = replaceLog(logStr, true);
        assert.strictEqual(result.error, false);
    });
});

suite('Formatting helper tests', () => {
    test('normalizeSpecialLiteralSpacing fixes spaced B/C/D prefixed literals', () => {
        const input = "int flags = B '111'; color shade = C '1,2,3'; datetime open = D '2024.01.02 03:04';";
        const result = normalizeSpecialLiteralSpacing(input);

        assert.ok(result.includes("B'111'"));
        assert.ok(result.includes("C'1,2,3'"));
        assert.ok(result.includes("D'2024.01.02 03:04'"));
    });

    test('normalizeSpecialLiteralSpacing fixes spaced D literals without a time suffix', () => {
        const input = "datetime open = D '2024.01.02';";
        assert.ok(normalizeSpecialLiteralSpacing(input).includes("D'2024.01.02'"));
    });

    test('normalizeSpecialLiteralSpacing leaves already-correct literals unchanged', () => {
        const input = "int flags = B'111'; color shade = C'1,2,3';";
        assert.strictEqual(normalizeSpecialLiteralSpacing(input), input);
    });

    test('formats compile target label with version', () => {
        assert.strictEqual(formatCompileTargetLabel('SMC.mq5', '4.57'), "'SMC.mq5' v4.57");
    });

    test('builds progress title with compile target label', () => {
        const targetLabel = formatCompileTargetLabel('SMC.mq5', '4.57');
        assert.strictEqual(buildCompileProgressTitle('Syntax checking', targetLabel), "MQL Tools: Syntax checking 'SMC.mq5' v4.57");
    });

    test('formatCompileTargetLabel omits version suffix when version is null', () => {
        assert.strictEqual(formatCompileTargetLabel('SMC.mq5', null), "'SMC.mq5'");
    });

    test('formatCompileTargetLabel omits version suffix when version is undefined', () => {
        assert.strictEqual(formatCompileTargetLabel('SMC.mq5', undefined), "'SMC.mq5'");
    });
});

suite('Property version extraction tests', () => {
    test('extracts version from #property directive', () => {
        const source = '#property version "4.57"\nvoid OnStart() {}';
        assert.strictEqual(extractPropertyVersion(source), '4.57');
    });

    test('ignores commented property version lines', () => {
        const source = '// #property version "4.57"\nvoid OnStart() {}';
        assert.strictEqual(extractPropertyVersion(source), null);
    });

    test('supports extra whitespace in property version directive', () => {
        const source = '   #property   version   "4.57"\nvoid OnStart() {}';
        assert.strictEqual(extractPropertyVersion(source), '4.57');
    });

});

suite('Problems panel focus helper tests', () => {
    test('returns false when there are no errors', () => {
        assert.strictEqual(shouldFocusProblemsPanel(false), false);
    });

    test('returns true for manual error runs', () => {
        assert.strictEqual(shouldFocusProblemsPanel(true), true);
    });

    test('returns false for background error runs', () => {
        assert.strictEqual(shouldFocusProblemsPanel(true, { background: true }), false);
    });
});

suite('Header compile target planning tests', () => {
    test('uses resolved .mq4/.mq5 targets for headers', () => {
        const targets = ['C:\\Project\\Experts\\Main.mq5'];
        const result = resolveHeaderCompilePlan({ targets });

        assert.deepStrictEqual(result, { pathsToCompile: targets, shouldWarn: false });
    });

    test('uses legacy magic-comment target when no target was resolved', () => {
        const magicPath = 'C:\\Project\\Experts\\Main.mq5';
        const result = resolveHeaderCompilePlan(
            { targets: [], magicPath },
            candidate => candidate === magicPath
        );

        assert.deepStrictEqual(result, { pathsToCompile: [magicPath], shouldWarn: false });
    });

    test('does not compile a header directly when no target exists', () => {
        const result = resolveHeaderCompilePlan({ targets: [], magicPath: null });

        assert.deepStrictEqual(result, { pathsToCompile: null, shouldWarn: true });
    });

    test('skips background header checks silently when no target exists', () => {
        const result = resolveHeaderCompilePlan({
            targets: [],
            magicPath: null,
            isBackground: true
        });

        assert.deepStrictEqual(result, { pathsToCompile: null, shouldWarn: false });
    });
});

suite('Compile success action helper tests', () => {
    test('returns true when compile succeeds and a success action exists', () => {
        assert.strictEqual(shouldRunCompileSuccessAction(false, { onSuccess: () => Promise.resolve() }), true);
    });

    test('returns false when compile has errors', () => {
        assert.strictEqual(shouldRunCompileSuccessAction(true, { onSuccess: () => Promise.resolve() }), false);
    });

    test('returns false when no success action is provided', () => {
        assert.strictEqual(shouldRunCompileSuccessAction(false, {}), false);
    });

    test('runs the success action when provided', async () => {
        let called = false;

        await runCompileSuccessAction({
            onSuccess: async () => {
                called = true;
            }
        }, {
            error: () => assert.fail('logger.error should not be called for successful callbacks')
        });

        assert.strictEqual(called, true);
    });

    test('logs and swallows errors thrown by the success action', async () => {
        const expectedError = new Error('boom');
        const logged = [];

        await assert.doesNotReject(async () => {
            await runCompileSuccessAction({
                onSuccess: async () => {
                    throw expectedError;
                }
            }, {
                error: (...args) => logged.push(args)
            });
        });

        assert.strictEqual(logged.length, 1);
        assert.match(logged[0][0], /Compile succeeded, but the onSuccess handler failed:/);
        assert.strictEqual(logged[0][1], expectedError);
    });
});

suite('Portable Mode Tests', () => {
    suite('generatePortableSwitch function', () => {
        test('should return empty string when portable mode is disabled', () => {
            const result = generatePortableSwitch(false);
            assert.strictEqual(result, '');
        });

        test('should return "/portable" when portable mode is enabled', () => {
            const result = generatePortableSwitch(true);
            assert.strictEqual(result, '/portable');
        });

        test('should handle undefined as falsy (disabled)', () => {
            const result = generatePortableSwitch(undefined);
            assert.strictEqual(result, '');
        });

        test('should handle null as falsy (disabled)', () => {
            const result = generatePortableSwitch(null);
            assert.strictEqual(result, '');
        });
    });

    suite('Compile command integration', () => {
        test('compile command without portable mode uses production function', () => {
            const MetaDir = 'C:\\Program Files\\MetaTrader 5\\metaeditor64.exe';
            const filePath = 'C:\\Users\\Test\\MQL5\\Experts\\test.mq5';
            const includefile = ' /include:"C:\\Users\\Test\\MQL5\\Include"';
            const logFile = 'C:\\Users\\Test\\MQL5\\Experts\\test.log';
            const portableSwitch = generatePortableSwitch(false);

            const command = `"${MetaDir}" /compile:"${filePath}"${includefile} /s /log:"${logFile}"${portableSwitch ? ' ' + portableSwitch : ''}`;

            assert.ok(!command.includes('/portable'), 'Command should not include /portable when disabled');
            assert.ok(command.includes('/compile:'), 'Command should include /compile');
            assert.ok(command.includes('/log:'), 'Command should include /log');
        });

        test('compile command with portable mode uses production function', () => {
            const MetaDir = 'C:\\Program Files\\MetaTrader 5\\metaeditor64.exe';
            const filePath = 'C:\\Users\\Test\\MQL5\\Experts\\test.mq5';
            const includefile = ' /include:"C:\\Users\\Test\\MQL5\\Include"';
            const logFile = 'C:\\Users\\Test\\MQL5\\Experts\\test.log';
            const portableSwitch = generatePortableSwitch(true);

            const command = `"${MetaDir}" /compile:"${filePath}"${includefile} /s /log:"${logFile}"${portableSwitch ? ' ' + portableSwitch : ''}`;

            assert.ok(command.includes('/portable'), 'Command should include /portable when enabled');
            assert.ok(command.endsWith('/portable'), 'Command should end with /portable');
        });
    });

    suite('Open in MetaEditor command integration', () => {
        test('open command without portable mode uses production function', () => {
            const MetaDir = 'C:\\Program Files\\MetaTrader 5\\metaeditor64.exe';
            const filePath = 'C:\\Users\\Test\\MQL5\\Experts\\test.mq5';
            const portableSwitch = generatePortableSwitch(false);

            const command = `"${MetaDir}" "${filePath}"${portableSwitch ? ' ' + portableSwitch : ''}`;

            assert.ok(!command.includes('/portable'), 'Command should not include /portable when disabled');
        });

        test('open command with portable mode uses production function', () => {
            const MetaDir = 'C:\\Program Files\\MetaTrader 5\\metaeditor64.exe';
            const filePath = 'C:\\Users\\Test\\MQL5\\Experts\\test.mq5';
            const portableSwitch = generatePortableSwitch(true);

            const command = `"${MetaDir}" "${filePath}"${portableSwitch ? ' ' + portableSwitch : ''}`;

            assert.ok(command.includes('/portable'), 'Command should include /portable when enabled');
            assert.ok(command.endsWith('/portable'), 'Command should end with /portable');
        });
    });
});

suite('safeConfigUpdate Tests (Issue #21)', () => {
    const ConfigurationTarget = vscodeMock.ConfigurationTarget;

    setup(() => {
        // Reset mock before each test
        vscodeMock.workspace._configMock = null;
    });

    test('should not throw when setting is not registered and silent=true', async () => {
        // Mock config where inspect returns null (setting not registered)
        vscodeMock.workspace._configMock = {
            get: () => undefined,
            update: () => { throw new Error('Should not be called'); },
            inspect: () => null  // Setting not registered
        };

        // This should NOT throw - it should return early
        await assert.doesNotReject(async () => {
            await safeConfigUpdate('nonexistent.setting', 'value', ConfigurationTarget.Workspace, true);
        });
    });

    test('should not throw when setting is not registered and silent=false', async () => {
        // Mock config where inspect returns null (setting not registered)
        vscodeMock.workspace._configMock = {
            get: () => undefined,
            update: () => { throw new Error('Should not be called'); },
            inspect: () => null  // Setting not registered
        };

        // This should NOT throw - it should return early (after logging)
        await assert.doesNotReject(async () => {
            await safeConfigUpdate('nonexistent.setting', 'value', ConfigurationTarget.Workspace, false);
        });
    });

    test('should call update when setting is registered', async () => {
        let updateCalled = false;
        vscodeMock.workspace._configMock = {
            get: () => undefined,
            update: () => { updateCalled = true; return Promise.resolve(); },
            inspect: () => ({ defaultValue: 'default', workspaceValue: undefined })  // Setting exists
        };

        await safeConfigUpdate('existing.setting', 'value', ConfigurationTarget.Workspace, false);
        assert.strictEqual(updateCalled, true, 'update() should be called when setting is registered');
    });
});

suite('replaceLog Wine Path Conversion Tests (Issue #17)', () => {
    const WINE_PREFIX = '/home/username/Bottles/Meta-Trader';

    test('error diagnostic file path is converted to Linux path when winePrefix is set', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5\\Scripts\\CloseAllWindows.mq5(10,5) : error 123: unexpected token';
        const result = replaceLog(logStr, true, WINE_PREFIX);

        assert.strictEqual(result.error, true);
        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(
            result.diagnostics[0].file,
            `${WINE_PREFIX}/drive_c/Programs/MetaTrader5/MQL5/Scripts/CloseAllWindows.mq5`
        );
    });

    test('warning diagnostic file path is converted to Linux path when winePrefix is set', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5\\Experts\\MyEA.mq5(20,1) : warning 456: obsolete function';
        const result = replaceLog(logStr, true, WINE_PREFIX);

        assert.strictEqual(result.diagnostics.length, 1);
        assert.strictEqual(result.diagnostics[0].severity, 1); // Warning
        assert.strictEqual(
            result.diagnostics[0].file,
            `${WINE_PREFIX}/drive_c/Programs/MetaTrader5/MQL5/Experts/MyEA.mq5`
        );
    });

    test('hover link href contains a valid file:// URL pointing to Linux path', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5\\Scripts\\CloseAllWindows.mq5(10,5) : error 123: unexpected token';
        const result = replaceLog(logStr, true, WINE_PREFIX);
        const hoverEntry = extension.obj_hover['unexpected token (10,5)'];

        assert.strictEqual(result.diagnostics.length, 1);
        assert.ok(hoverEntry, 'hover entry should be created for the diagnostic');
        assert.strictEqual(hoverEntry.number, '123');
        assert.ok(hoverEntry.link.startsWith('file://'), 'hover link should use file://');
        assert.ok(hoverEntry.link.endsWith('#10,5'), 'hover link should preserve line/column fragment');
        assert.ok(
            hoverEntry.link.includes('/home/username/Bottles/Meta-Trader/drive_c/Programs/MetaTrader5/MQL5/Scripts/CloseAllWindows.mq5'),
            'hover link should reference the converted Linux path'
        );
        assert.ok(!hoverEntry.link.includes('C:%5C'), 'hover link should not contain an encoded Windows path');
    });

    test('line/col positions are preserved after path conversion', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5\\Scripts\\foo.mq5(42,7) : error 100: some error';
        const result = replaceLog(logStr, true, WINE_PREFIX);

        assert.strictEqual(result.diagnostics[0].range.start.line, 41);     // 42-1
        assert.strictEqual(result.diagnostics[0].range.start.character, 6); // 7-1
    });

    test('compilation start line produces hover link with Linux path', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5 : information: compiling \'CloseAllWindows.mq5\'';
        const result = replaceLog(logStr, true, WINE_PREFIX);
        const hoverEntry = extension.obj_hover["'CloseAllWindows.mq5'"];

        assert.ok(result.text.includes('CloseAllWindows.mq5'));
        assert.ok(hoverEntry, 'hover entry should be created for the compilation line');
        assert.ok(hoverEntry.link.startsWith('file://'), 'hover link should use file://');
        assert.ok(
            hoverEntry.link.includes(`${WINE_PREFIX}/drive_c/Programs/MetaTrader5/MQL5`),
            'hover link should reference the converted Linux path'
        );
    });

    test('MQL181 implicit-conversion warning is still suppressed with winePrefix', () => {
        const logStr = 'C:\\Programs\\MetaTrader5\\MQL5\\Scripts\\foo.mq5(5,3) : warning 181: implicit conversion from \'number\' to \'string\'';
        const result = replaceLog(logStr, true, WINE_PREFIX);
        assert.strictEqual(result.diagnostics.length, 0, 'MQL181 should be filtered even with winePrefix');
    });
});

suite('buildMetaEditorCmd Tests (Issue #6)', () => {
    test('should add quotes to /compile: flag value', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/compile:C:\\Users\\Test\\file.mq5']);
        assert.strictEqual(result.executable, 'metaeditor64.exe');
        assert.strictEqual(result.args[0], '/compile:"C:\\Users\\Test\\file.mq5"');
    });

    test('should add quotes to /log: flag value', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/log:C:\\Users\\Test\\file.log']);
        assert.strictEqual(result.args[0], '/log:"C:\\Users\\Test\\file.log"');
    });

    test('should add quotes to /inc: flag value', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/inc:C:\\Users\\Test\\Include']);
        assert.strictEqual(result.args[0], '/inc:"C:\\Users\\Test\\Include"');
    });

    test('should strip trailing backslash from /inc: value before quoting', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/inc:C:\\Users\\Test\\Include\\']);
        assert.strictEqual(result.args[0], '/inc:"C:\\Users\\Test\\Include"');
    });

    test('should strip multiple trailing backslashes', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/inc:C:\\Users\\Test\\Include\\\\\\']);
        assert.strictEqual(result.args[0], '/inc:"C:\\Users\\Test\\Include"');
    });

    test('should not modify already-quoted values', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/compile:"C:\\Users\\Test\\file.mq5"']);
        assert.strictEqual(result.args[0], '/compile:"C:\\Users\\Test\\file.mq5"');
    });

    test('should not modify non-MetaEditor flags', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/portable', '/someotherflag']);
        assert.strictEqual(result.args[0], '/portable');
        assert.strictEqual(result.args[1], '/someotherflag');
    });

    test('should handle mixed flags correctly', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', [
            '/compile:C:\\path\\file.mq5',
            '/log:C:\\path\\file.log',
            '/inc:C:\\path\\Include\\',
            '/portable'
        ]);
        assert.strictEqual(result.args[0], '/compile:"C:\\path\\file.mq5"');
        assert.strictEqual(result.args[1], '/log:"C:\\path\\file.log"');
        assert.strictEqual(result.args[2], '/inc:"C:\\path\\Include"');
        assert.strictEqual(result.args[3], '/portable');
    });

    test('should be case-insensitive for flag matching', () => {
        const result = buildMetaEditorCmd('metaeditor64.exe', ['/COMPILE:C:\\file.mq5', '/Log:C:\\file.log']);
        // Note: The function normalizes flags to lowercase from the metaEditorFlags array
        assert.strictEqual(result.args[0], '/compile:"C:\\file.mq5"');
        assert.strictEqual(result.args[1], '/log:"C:\\file.log"');
    });
});
