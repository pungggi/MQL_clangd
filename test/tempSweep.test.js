const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isDbgBuildArtifact, collectDbgBuildArtifacts, removeFiles, sweepDbgBuildArtifacts } = require('../src/tempSweep');

suite('tempSweep', () => {
    suite('isDbgBuildArtifact', () => {
        test('matches instrumented sources and binaries', () => {
            assert.strictEqual(isDbgBuildArtifact('SMC.mql_dbg_build.mq5'), true);
            assert.strictEqual(isDbgBuildArtifact('SMC.mql_dbg_build.mq4'), true);
            assert.strictEqual(isDbgBuildArtifact('includes.mql_dbg_build.mqh'), true);
            assert.strictEqual(isDbgBuildArtifact('SMC.mql_dbg_build.ex5'), true);
            assert.strictEqual(isDbgBuildArtifact('SMC.mql_dbg_build.ex4'), true);
        });

        test('is case-insensitive', () => {
            assert.strictEqual(isDbgBuildArtifact('EA.MQL_DBG_BUILD.MQ5'), true);
        });

        test('rejects unrelated file names', () => {
            assert.strictEqual(isDbgBuildArtifact('SMC.mq5'), false);
            assert.strictEqual(isDbgBuildArtifact('mql_dbg_build_notes.txt'), false);
            assert.strictEqual(isDbgBuildArtifact('SMC.mql_dbg_build.mq5.bak'), false);
            assert.strictEqual(isDbgBuildArtifact('.mql_dbg_build'), false);
        });
    });

    suite('collectDbgBuildArtifacts', () => {
        let root;
        setup(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-tempsweep-'));
        });
        teardown(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        function touch(relative) {
            const full = path.join(root, relative);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, 'x');
        }

        test('finds artifacts in nested directories', async () => {
            touch('SMC.mql_dbg_build.mq5');
            touch('sub/EA.mql_dbg_build.ex5');
            touch('deep/nested/inc.mql_dbg_build.mqh');

            const found = await collectDbgBuildArtifacts(root);
            assert.strictEqual(found.length, 3);
        });

        test('ignores regular sources and skipped directories', async () => {
            touch('SMC.mq5');
            touch('SMC.ex5');
            touch('node_modules/pkg/EA.mql_dbg_build.mq5');
            touch('.git/objects/EA.mql_dbg_build.mq5');

            const found = await collectDbgBuildArtifacts(root);
            assert.deepStrictEqual(found, []);
        });

        test('does not throw on unreadable directories', async () => {
            touch('SMC.mql_dbg_build.mq5');
            const unreadable = path.join(root, 'locked');
            fs.mkdirSync(unreadable);
            const originalReaddir = fs.promises.readdir;
            fs.promises.readdir = async (dir, opts) => {
                if (String(dir).endsWith('locked')) {
                    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
                }
                return originalReaddir(dir, opts);
            };
            try {
                const found = await collectDbgBuildArtifacts(root);
                assert.strictEqual(found.length, 1);
            } finally {
                fs.promises.readdir = originalReaddir;
            }
        });
    });

    suite('removeFiles', () => {
        let root;
        setup(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-tempsweep-'));
        });
        teardown(() => {
            fs.rmSync(root, { recursive: true, force: true });
        });

        test('removes existing files and reports failures for missing ones', async () => {
            const keep = path.join(root, 'SMC.mql_dbg_build.mq5');
            fs.writeFileSync(keep, 'x');
            const missing = path.join(root, 'gone.mql_dbg_build.ex5');

            const { removed, failed } = await removeFiles([keep, missing]);
            assert.deepStrictEqual(removed, [keep]);
            assert.strictEqual(failed.length, 1);
            assert.strictEqual(failed[0].file, missing);
            assert.strictEqual(fs.existsSync(keep), false);
        });

        test('uses an injected unlink function', async () => {
            const calls = [];
            await removeFiles(['a', 'b'], { unlink: async (p) => { calls.push(p); } });
            assert.deepStrictEqual(calls, ['a', 'b']);
        });
    });

    suite('sweepDbgBuildArtifacts', () => {
        let rootA;
        let rootB;
        setup(() => {
            rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-tempsweep-a-'));
            rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-tempsweep-b-'));
        });
        teardown(() => {
            fs.rmSync(rootA, { recursive: true, force: true });
            fs.rmSync(rootB, { recursive: true, force: true });
        });

        test('sweeps every root and returns per-root results', async () => {
            fs.writeFileSync(path.join(rootA, 'A.mql_dbg_build.mq5'), 'x');
            fs.writeFileSync(path.join(rootB, 'B.mql_dbg_build.ex4'), 'x');
            fs.writeFileSync(path.join(rootB, 'Keep.mq5'), 'x');

            const results = await sweepDbgBuildArtifacts([rootA, rootB]);
            assert.strictEqual(results.length, 2);
            assert.strictEqual(results[0].removed.length, 1);
            assert.strictEqual(results[1].removed.length, 1);
            assert.strictEqual(fs.readdirSync(rootB).includes('Keep.mq5'), true);
            assert.strictEqual(fs.readdirSync(rootA).length, 0);
        });
    });
});
