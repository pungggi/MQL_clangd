const assert = require('assert');
const Module = require('module');

// Hook the Node.js module loader to intercept 'vscode'
const vscodeMock = require('../mocks/vscode');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.apply(this, arguments);
};

// Load the module under test
const {
    bumpVersion,
    bumpPropertyVersion,
    bumpVersionConstants,
    bumpVersionsInFile,
    buildConstStringRegex
} = require('../../src/versionBumper');

suite('Version Bumper Unit Tests', () => {

    // ── bumpVersion ──────────────────────────────────────────────────────────

    suite('bumpVersion', () => {
        test('bumps last segment of two-part version', () => {
            assert.strictEqual(bumpVersion('1.00'), '1.01');
            assert.strictEqual(bumpVersion('6.01'), '6.02');
            assert.strictEqual(bumpVersion('4.57'), '4.58');
        });

        test('preserves zero-padding on last segment', () => {
            assert.strictEqual(bumpVersion('1.09'), '1.10');
            assert.strictEqual(bumpVersion('2.99'), '2.100');
            assert.strictEqual(bumpVersion('1.001'), '1.002');
        });

        test('handles three-part versions', () => {
            assert.strictEqual(bumpVersion('1.2.3'), '1.2.4');
            assert.strictEqual(bumpVersion('10.0.99'), '10.0.100');
        });

        test('handles single number', () => {
            assert.strictEqual(bumpVersion('5'), '6');
        });

        test('returns null for non-numeric input', () => {
            assert.strictEqual(bumpVersion('abc'), null);
            assert.strictEqual(bumpVersion(''), null);
        });

        test('returns null for null/undefined', () => {
            assert.strictEqual(bumpVersion(null), null);
            assert.strictEqual(bumpVersion(undefined), null);
        });

        test('trims whitespace before parsing', () => {
            assert.strictEqual(bumpVersion('  1.00  '), '1.01');
        });
    });

    // ── bumpPropertyVersion ──────────────────────────────────────────────────

    suite('bumpPropertyVersion', () => {
        test('bumps #property version with double quotes', () => {
            const src = '#property version "1.00"\n#property strict';
            const result = bumpPropertyVersion(src);
            assert.strictEqual(result.newVersion, '1.01');
            assert.strictEqual(result.oldVersion, '1.00');
            assert.ok(result.text.includes('#property version "1.01"'));
            assert.ok(!result.text.includes('1.00'));
        });

        test('bumps #property version with single quotes', () => {
            const src = "#property version '6.01'";
            const result = bumpPropertyVersion(src);
            assert.strictEqual(result.newVersion, '6.02');
            assert.ok(result.text.includes("#property version '6.02'"));
        });

        test('handles #property version with extra whitespace', () => {
            const src = '  #property   version   "4.57"';
            const result = bumpPropertyVersion(src);
            assert.strictEqual(result.newVersion, '4.58');
            assert.ok(result.text.includes('"4.58"'));
        });

        test('returns null versions when no #property version found', () => {
            const src = '#property strict\nint OnInit() { return 0; }';
            const result = bumpPropertyVersion(src);
            assert.strictEqual(result.oldVersion, null);
            assert.strictEqual(result.newVersion, null);
            assert.strictEqual(result.text, src);
        });

        test('returns unchanged text for non-string input', () => {
            const result = bumpPropertyVersion(42);
            assert.strictEqual(result.text, 42);
            assert.strictEqual(result.oldVersion, null);
        });
    });

    // ── bumpVersionConstants ─────────────────────────────────────────────────

    suite('bumpVersionConstants', () => {
        test('bumps const string with known name', () => {
            const src = 'const string EA_VERSION = "6.01";';
            const result = bumpVersionConstants(src, ['EA_VERSION']);
            assert.strictEqual(result.bumps.length, 1);
            assert.strictEqual(result.bumps[0].oldVersion, '6.01');
            assert.strictEqual(result.bumps[0].newVersion, '6.02');
            assert.ok(result.text.includes('"6.02"'));
        });

        test('bumps string const (reversed order)', () => {
            const src = 'string const MY_VER = "1.00";';
            const result = bumpVersionConstants(src, ['MY_VER']);
            assert.strictEqual(result.bumps[0].newVersion, '1.01');
            assert.ok(result.text.includes('"1.01"'));
        });

        test('handles single-quoted values', () => {
            const src = "const string VER = '2.50';";
            const result = bumpVersionConstants(src, ['VER']);
            assert.strictEqual(result.bumps[0].newVersion, '2.51');
        });

        test('handles multiple constant names', () => {
            const src = 'const string EA_VERSION = "1.00";\nconst string LIB_VER = "3.14";';
            const result = bumpVersionConstants(src, ['EA_VERSION', 'LIB_VER']);
            assert.strictEqual(result.bumps.length, 2);
            assert.strictEqual(result.bumps[0].newVersion, '1.01');
            assert.strictEqual(result.bumps[1].newVersion, '3.15');
        });

        test('returns null for constant not found in source', () => {
            const src = 'const string OTHER = "1.00";';
            const result = bumpVersionConstants(src, ['EA_VERSION']);
            assert.strictEqual(result.bumps.length, 1);
            assert.strictEqual(result.bumps[0].oldVersion, null);
            assert.strictEqual(result.bumps[0].newVersion, null);
        });

        test('returns empty bumps for empty constant names array', () => {
            const src = 'const string EA_VERSION = "1.00";';
            const result = bumpVersionConstants(src, []);
            assert.strictEqual(result.bumps.length, 0);
            assert.strictEqual(result.text, src);
        });

        test('skips empty/invalid constant names', () => {
            const src = 'const string EA_VERSION = "1.00";';
            const result = bumpVersionConstants(src, ['', '  ', 'EA_VERSION']);
            assert.strictEqual(result.bumps.length, 1);
            assert.strictEqual(result.bumps[0].name, 'EA_VERSION');
            assert.strictEqual(result.bumps[0].newVersion, '1.01');
        });
    });

    // ── buildConstStringRegex ────────────────────────────────────────────────

    suite('buildConstStringRegex', () => {
        test('matches const string declaration', () => {
            const regex = buildConstStringRegex('EA_VERSION');
            const match = 'const string EA_VERSION = "1.00";'.match(regex);
            assert.ok(match);
            assert.strictEqual(match[2], '1.00');
        });

        test('matches string const declaration', () => {
            const regex = buildConstStringRegex('VER');
            const match = 'string const VER = "2.5";'.match(regex);
            assert.ok(match);
        });

        test('does not match wrong name', () => {
            const regex = buildConstStringRegex('EA_VERSION');
            const match = 'const string OTHER = "1.00";'.match(regex);
            assert.ok(!match);
        });

        test('escapes special regex chars in name', () => {
            const regex = buildConstStringRegex('VER$1');
            // Should not throw and should not match a plain VER
            const match = 'const string VER = "1.00";'.match(regex);
            assert.ok(!match);
        });
    });

    // ── bumpVersionsInFile (integration) ─────────────────────────────────────

    suite('bumpVersionsInFile', () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        test('returns bumped=false when no bump options are set', async () => {
            const tmpFile = path.join(os.tmpdir(), `mql-test-nobump-${Date.now()}.mq5`);
            fs.writeFileSync(tmpFile, '#property version "1.00"');
            try {
                const result = await bumpVersionsInFile({
                    filePath: tmpFile,
                    bumpPropertyVersion: false,
                    versionConstantNames: []
                });
                assert.strictEqual(result.bumped, false);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('bumps #property version on disk', async () => {
            const tmpFile = path.join(os.tmpdir(), `mql-test-propbump-${Date.now()}.mq5`);
            fs.writeFileSync(tmpFile, '#property version "1.00"\n#property strict\n');
            try {
                const result = await bumpVersionsInFile({
                    filePath: tmpFile,
                    bumpPropertyVersion: true,
                    versionConstantNames: []
                });
                assert.strictEqual(result.bumped, true);
                assert.strictEqual(result.propertyVersion.old, '1.00');
                assert.strictEqual(result.propertyVersion.new, '1.01');

                // Verify file on disk was updated
                const content = fs.readFileSync(tmpFile, 'utf8');
                assert.ok(content.includes('#property version "1.01"'));
                assert.ok(!content.includes('1.00'));
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('bumps version constant on disk', async () => {
            const tmpFile = path.join(os.tmpdir(), `mql-test-constbump-${Date.now()}.mq5`);
            fs.writeFileSync(tmpFile, '#property version "1.00"\nconst string EA_VERSION = "6.01";\n');
            try {
                const result = await bumpVersionsInFile({
                    filePath: tmpFile,
                    bumpPropertyVersion: false,
                    versionConstantNames: ['EA_VERSION']
                });
                assert.strictEqual(result.bumped, true);
                assert.strictEqual(result.constants[0].oldVersion, '6.01');
                assert.strictEqual(result.constants[0].newVersion, '6.02');

                const content = fs.readFileSync(tmpFile, 'utf8');
                assert.ok(content.includes('"6.02"'));
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('bumps both #property version and constant together', async () => {
            const tmpFile = path.join(os.tmpdir(), `mql-test-both-${Date.now()}.mq5`);
            fs.writeFileSync(tmpFile, '#property version "1.00"\nconst string EA_VERSION = "6.01";\n');
            try {
                const result = await bumpVersionsInFile({
                    filePath: tmpFile,
                    bumpPropertyVersion: true,
                    versionConstantNames: ['EA_VERSION']
                });
                assert.strictEqual(result.bumped, true);
                assert.strictEqual(result.propertyVersion.new, '1.01');
                assert.strictEqual(result.constants[0].newVersion, '6.02');

                const content = fs.readFileSync(tmpFile, 'utf8');
                assert.ok(content.includes('#property version "1.01"'));
                assert.ok(content.includes('"6.02"'));
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('returns bumped=false when file has no version patterns', async () => {
            const tmpFile = path.join(os.tmpdir(), `mql-test-nopattern-${Date.now()}.mq5`);
            fs.writeFileSync(tmpFile, 'int OnInit() { return 0; }\n');
            try {
                const result = await bumpVersionsInFile({
                    filePath: tmpFile,
                    bumpPropertyVersion: true,
                    versionConstantNames: ['EA_VERSION']
                });
                assert.strictEqual(result.bumped, false);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('handles non-existent file gracefully', async () => {
            const result = await bumpVersionsInFile({
                filePath: '/nonexistent/path/file.mq5',
                bumpPropertyVersion: true,
                versionConstantNames: []
            });
            assert.strictEqual(result.bumped, false);
        });
    });
});
