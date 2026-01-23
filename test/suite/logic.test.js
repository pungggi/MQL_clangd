const assert = require('assert');
const path = require('path');

// Import functions from createProperties
const { normalizePath, expandWorkspaceVariables, resolvePathRelativeToWorkspace, isSourceExtension, detectMqlVersion, generateIncludeFlag, generateBaseFlags, generateProjectFlags, generatePortableSwitch } = require('../../src/createProperties');

// Import Wine helper functions
const { isWineEnabled, getWineBinary } = require('../../src/wineHelper');

function withPlatform(value, fn) {
    const original = process.platform;
    try {
        Object.defineProperty(process, 'platform', { value });
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', { value: original });
    }
}

suite('Pure Logic Unit Tests', () => {
    suite('Path Normalization', () => {
        test('should convert backslashes to forward slashes', () => {
            assert.strictEqual(normalizePath('C:\\Users\\Test'), 'C:/Users/Test');
            assert.strictEqual(normalizePath('folder\\subfolder'), 'folder/subfolder');
        });

        test('should handle empty strings', () => {
            assert.strictEqual(normalizePath(''), '');
        });

        test('should handle paths with mixed slashes', () => {
            assert.strictEqual(normalizePath('C:\\Users/Test\\file'), 'C:/Users/Test/file');
        });

        test('should handle already normalized paths', () => {
            assert.strictEqual(normalizePath('C:/Users/Test'), 'C:/Users/Test');
        });

        test('should handle UNC paths', () => {
            assert.strictEqual(normalizePath('\\\\server\\share'), '//server/share');
        });
    });

    suite('Workspace-relative Path Resolution', () => {
        test('should expand ${workspaceFolder} in paths', () => {
            const ws = path.resolve('test-workspace');
            const expanded = expandWorkspaceVariables('${workspaceFolder}/../MetaEditor64.exe', ws);
            assert.strictEqual(expanded, ws + '/../MetaEditor64.exe');
        });

        test('should resolve relative paths against workspace folder', () => {
            const ws = path.resolve('test-workspace');
            const resolved = resolvePathRelativeToWorkspace('../MetaEditor64.exe', ws);
            assert.strictEqual(resolved, path.resolve(ws, '../MetaEditor64.exe'));
        });

        test('should resolve ${workspaceFolder} paths to absolute paths', () => {
            const ws = path.resolve('test-workspace');
            const resolved = resolvePathRelativeToWorkspace('${workspaceFolder}/../MetaEditor64.exe', ws);
            assert.strictEqual(resolved, path.resolve(ws, '../MetaEditor64.exe'));
        });

        test('should preserve absolute paths (normalize with resolve)', () => {
            const ws = path.resolve('test-workspace');
            const abs = path.resolve(ws, 'bin', 'metaeditor64.exe');
            const resolved = resolvePathRelativeToWorkspace(abs, ws);
            assert.strictEqual(resolved, abs);
        });
    });

    suite('MQL Version Detection', () => {
        test('should detect MQL5 from folder path', () => {
            const mql5Path = 'C:/Users/Test/MQL5/Experts';
            assert.strictEqual(detectMqlVersion(mql5Path, null), 'mql5');
        });

        test('should detect MQL4 from folder path', () => {
            const mql4Path = 'C:/Users/Test/MQL4/Experts';
            assert.strictEqual(detectMqlVersion(mql4Path, null), 'mql4');
        });

        test('should detect MQL5 from .mq5 file extension', () => {
            assert.strictEqual(detectMqlVersion(null, 'test.mq5'), 'mql5');
            assert.strictEqual(detectMqlVersion('C:/Some/Path', 'expert.mq5'), 'mql5');
        });

        test('should detect MQL4 from .mq4 file extension', () => {
            assert.strictEqual(detectMqlVersion(null, 'test.mq4'), 'mql4');
            assert.strictEqual(detectMqlVersion('C:/Some/Path', 'expert.mq4'), 'mql4');
        });

        test('should prioritize file extension over folder path', () => {
            // File extension should take priority over folder path
            assert.strictEqual(detectMqlVersion('C:/Users/Test/MQL4/Experts', 'test.mq5'), 'mql5');
            assert.strictEqual(detectMqlVersion('C:/Users/Test/MQL5/Experts', 'test.mq4'), 'mql4');
        });

        test('should be case-insensitive for folder path detection', () => {
            assert.strictEqual(detectMqlVersion('C:/Users/Test/mql5/Experts', null), 'mql5');
            assert.strictEqual(detectMqlVersion('C:/Users/Test/mql4/Experts', null), 'mql4');
            assert.strictEqual(detectMqlVersion('C:/Users/Test/Mql5/Experts', null), 'mql5');
        });

        test('should return null when no path or filename provided', () => {
            assert.strictEqual(detectMqlVersion(null, null), null);
            assert.strictEqual(detectMqlVersion('', ''), null);
        });

        test('should default to mql5 when version cannot be determined from path', () => {
            assert.strictEqual(detectMqlVersion('C:/Users/Test/MyProject', 'test.mqh'), 'mql5');
        });
    });

    suite('Include Path Generation', () => {
        test('should generate correct include flag format', () => {
            const includePath = 'C:/Users/Test/MQL5/Include';
            const flag = generateIncludeFlag(includePath);
            assert.strictEqual(flag, '-IC:/Users/Test/MQL5/Include');
        });

        test('should handle paths with spaces', () => {
            const includePath = 'C:/Users/Test User/MQL5/Include';
            const flag = generateIncludeFlag(includePath);
            assert.strictEqual(flag, '-IC:/Users/Test User/MQL5/Include');
        });

        test('should normalize backslashes to forward slashes', () => {
            const includePath = 'C:\\Users\\Test\\MQL5\\Include';
            const flag = generateIncludeFlag(includePath);
            assert.strictEqual(flag, '-IC:/Users/Test/MQL5/Include');
        });
    });

    suite('Compiler Flags', () => {
        test('should include required base flags', () => {
            const baseFlags = generateBaseFlags();
            assert.ok(baseFlags.includes('-xc++'), 'Base flags should include -xc++');
            assert.ok(baseFlags.includes('-std=c++17'), 'Base flags should include -std=c++17');
            assert.ok(baseFlags.includes('-ferror-limit=0'), 'Base flags should include -ferror-limit=0');
        });

        test('should include MQL5 define for MQL5 projects', () => {
            const baseFlags = generateBaseFlags();
            const mql5Flags = generateProjectFlags('mql5', baseFlags);
            assert.ok(mql5Flags.includes('-D__MQL5__'), 'MQL5 project flags should include -D__MQL5__');
            assert.ok(mql5Flags.includes('-D__MQL5_BUILD__'), 'MQL5 project flags should include -D__MQL5_BUILD__');
        });

        test('should include MQL4 define for MQL4 projects', () => {
            const baseFlags = generateBaseFlags();
            const mql4Flags = generateProjectFlags('mql4', baseFlags);
            assert.ok(mql4Flags.includes('-D__MQL4__'), 'MQL4 project flags should include -D__MQL4__');
            assert.ok(!mql4Flags.includes('-D__MQL5__'), 'MQL4 project flags should not include -D__MQL5__');
            assert.ok(mql4Flags.includes('-D__MQL4_BUILD__'), 'MQL4 project flags should include -D__MQL4_BUILD__');
        });
    });

    suite('File Extension Handling', () => {
        test('should recognize .mq4 files as source', () => {
            assert.ok(isSourceExtension('.mq4'));
        });

        test('should recognize .mq5 files as source', () => {
            assert.ok(isSourceExtension('.mq5'));
        });

        test('should recognize .mqh header files as source', () => {
            assert.ok(isSourceExtension('.mqh'));
        });

        test('should not recognize .ex4 compiled files as source', () => {
            assert.ok(!isSourceExtension('.ex4'));
        });

        test('should not recognize .ex5 compiled files as source', () => {
            assert.ok(!isSourceExtension('.ex5'));
        });

        test('should handle case-insensitive extensions', () => {
            assert.ok(isSourceExtension('.MQ4'));
            assert.ok(isSourceExtension('.MQ5'));
            assert.ok(isSourceExtension('.MQH'));
        });

        test('should return false for null/undefined/empty extensions', () => {
            assert.ok(!isSourceExtension(null));
            assert.ok(!isSourceExtension(undefined));
            assert.ok(!isSourceExtension(''));
        });
    });

    suite('Portable Switch Generation', () => {
        test('should return empty string when portable mode is disabled', () => {
            assert.strictEqual(generatePortableSwitch(false), '');
        });

        test('should return " /portable" when portable mode is enabled', () => {
            assert.strictEqual(generatePortableSwitch(true), ' /portable');
        });
    });

    suite('Wine Helper Functions', () => {
        suite('isWineEnabled', () => {
            test('should return false on Windows platform', () => {
                withPlatform('win32', () => {
                    const config = { Wine: { Enabled: true } };
                    assert.strictEqual(isWineEnabled(config), false);
                });
            });

            test('should return false when Wine.Enabled is false', () => {
                withPlatform('darwin', () => {
                    const config = { Wine: { Enabled: false } };
                    assert.strictEqual(isWineEnabled(config), false);
                });
            });

            test('should return true on macOS when Wine.Enabled is true', () => {
                withPlatform('darwin', () => {
                    const config = { Wine: { Enabled: true } };
                    assert.strictEqual(isWineEnabled(config), true);
                });
            });

            test('should return true on Linux when Wine.Enabled is true', () => {
                withPlatform('linux', () => {
                    const config = { Wine: { Enabled: true } };
                    assert.strictEqual(isWineEnabled(config), true);
                });
            });

            test('should return false when Wine config is missing', () => {
                withPlatform('darwin', () => {
                    const config = {};
                    assert.strictEqual(isWineEnabled(config), false);
                });
            });

            test('should return false when Wine.Enabled is undefined', () => {
                withPlatform('darwin', () => {
                    const config = { Wine: {} };
                    assert.strictEqual(isWineEnabled(config), false);
                });
            });
        });

        suite('getWineBinary', () => {
            test('should return configured Wine.Binary value', () => {
                const config = { Wine: { Binary: '/usr/local/bin/wine64' } };
                assert.strictEqual(getWineBinary(config), '/usr/local/bin/wine64');
            });

            test('should return default "wine64" when Wine.Binary is not set', () => {
                const config = { Wine: {} };
                assert.strictEqual(getWineBinary(config), 'wine64');
            });

            test('should return default "wine64" when Wine config is missing', () => {
                const config = {};
                assert.strictEqual(getWineBinary(config), 'wine64');
            });

            test('should handle custom wine binary name', () => {
                const config = { Wine: { Binary: 'wine' } };
                assert.strictEqual(getWineBinary(config), 'wine');
            });

            test('should handle full path to wine binary', () => {
                const config = { Wine: { Binary: '/opt/wine-staging/bin/wine64' } };
                assert.strictEqual(getWineBinary(config), '/opt/wine-staging/bin/wine64');
            });
        });

        // Note: toWineWindowsPath is not tested here because it requires actual Wine installation
        // and executes external processes. It should be tested in integration tests or manually.
    });
});
