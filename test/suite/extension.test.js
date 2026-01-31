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
const { replaceLog } = require('../../src/extension');
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
