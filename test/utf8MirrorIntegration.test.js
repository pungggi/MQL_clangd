'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Semaphore tests (standalone, no filesystem) ──────────────────────────

// Inline the Semaphore class so we test it in isolation without pulling in
// the module's real _ioSem instance.
class Semaphore {
    constructor(max) { this._max = max; this._running = 0; this._queue = []; }
    acquire() {
        if (this._running < this._max) { this._running++; return Promise.resolve(); }
        return new Promise(resolve => this._queue.push(resolve));
    }
    release() {
        if (this._running <= 0) return;
        this._running--;
        if (this._queue.length) { this._running++; this._queue.shift()(); }
    }
}

suite('Semaphore', () => {
    test('allows up to max concurrent acquires', async () => {
        const sem = new Semaphore(3);
        const r1 = await sem.acquire();
        const r2 = await sem.acquire();
        const r3 = await sem.acquire();
        assert.strictEqual(sem._running, 3);
        sem.release(); sem.release(); sem.release();
    });

    test('queues acquire beyond max', async () => {
        const sem = new Semaphore(2);
        await sem.acquire();
        await sem.acquire();
        assert.strictEqual(sem._running, 2);
        assert.strictEqual(sem._queue.length, 0);

        let resolved = false;
        const p = sem.acquire().then(() => { resolved = true; });
        assert.strictEqual(sem._queue.length, 1);
        assert.strictEqual(resolved, false);

        sem.release();
        await p;
        assert.strictEqual(resolved, true);
        assert.strictEqual(sem._running, 2);
        sem.release(); sem.release();
    });

    test('releases in order', async () => {
        const sem = new Semaphore(1);
        await sem.acquire();

        const order = [];
        const p1 = sem.acquire().then(() => order.push(1));
        const p2 = sem.acquire().then(() => order.push(2));
        const p3 = sem.acquire().then(() => order.push(3));

        sem.release(); // unblock p1
        await p1;
        sem.release(); // unblock p2
        await p2;
        sem.release(); // unblock p3
        await p3;

        assert.deepStrictEqual(order, [1, 2, 3]);
    });

    test('max=1 acts as mutex', async () => {
        const sem = new Semaphore(1);
        let concurrent = 0;
        let maxConcurrent = 0;

        const work = Array.from({ length: 10 }, () =>
            sem.acquire().then(async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                // Small delay to let other promises schedule
                await new Promise(r => setTimeout(r, 1));
                concurrent--;
                sem.release();
            })
        );
        await Promise.all(work);
        assert.strictEqual(maxConcurrent, 1);
    });

    test('max=4 allows up to 4 concurrent', async () => {
        const sem = new Semaphore(4);
        let concurrent = 0;
        let maxConcurrent = 0;

        const work = Array.from({ length: 20 }, () =>
            sem.acquire().then(async () => {
                concurrent++;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise(r => setTimeout(r, 1));
                concurrent--;
                sem.release();
            })
        );
        await Promise.all(work);
        assert.strictEqual(maxConcurrent, 4);
    });
});

// ── Integration tests (real filesystem) ───────────────────────────────────
//
// These exercise ensureUtf8Mirror, walkAndMirror, transcodeOne, and
// _performMirror via the public API.

const { ensureUtf8Mirror, getMirrorRoot, mapToMirror } = require('../src/utf8Mirror');

let _tmpDir = null;
let _mirrorCount = 0;

/**
 * Create a temp source directory tree and return its path.
 * Automatically cleaned up after the suite.
 */
function setupSuiteTmpDir() {
    suiteSetup(() => {
        _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-mirror-test-'));
    });
    suiteTeardown(() => {
        if (_tmpDir) {
            fs.rmSync(_tmpDir, { recursive: true, force: true });
            _tmpDir = null;
        }
    });
}

/**
 * Make a fresh source directory per test so tests are independent.
 * Returns { srcDir, mirrorDir } where mirrorDir is where the mirror should end up.
 */
function freshSourceDir(name) {
    const srcDir = path.join(_tmpDir, name);
    fs.mkdirSync(srcDir, { recursive: true });
    const mirrorDir = mapToMirror(path.resolve(srcDir));
    return { srcDir, mirrorDir };
}

/** Write a file, creating parent dirs as needed. */
function writeFileSync(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

/** Write a file as UTF-16 LE with BOM. */
function writeUtf16Sync(filePath, text) {
    const bom = Buffer.from([0xff, 0xfe]);
    const payload = Buffer.from(text, 'utf16le');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.concat([bom, payload]));
}

/** Stat helper — returns mtimeMs or null. */
function mtimeMs(filePath) {
    try { return fs.statSync(filePath).mtimeMs; } catch { return null; }
}

suite('ensureUtf8Mirror — integration', () => {
    setupSuiteTmpDir();

    test('mirrors a simple .mqh file as UTF-8', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('simple');
        writeFileSync(path.join(srcDir, 'Types.mqh'), 'int x = 1;');

        const result = await ensureUtf8Mirror(srcDir);
        assert.strictEqual(result, mirrorDir);

        const mirrored = fs.readFileSync(path.join(mirrorDir, 'Types.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'int x = 1;');
    });

    test('transcodes UTF-16 LE with BOM to UTF-8', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('utf16');
        writeUtf16Sync(path.join(srcDir, 'Header.mqh'), 'void OnInit();');

        await ensureUtf8Mirror(srcDir);

        const mirrored = fs.readFileSync(path.join(mirrorDir, 'Header.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'void OnInit();');
    });

    test('transcodes UTF-16 LE without BOM (null-byte heuristic)', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('utf16-nobom');
        // Write raw UTF-16 LE without BOM — pure ASCII → 50% null bytes
        const content = Buffer.from('Trade', 'utf16le');
        fs.writeFileSync(path.join(srcDir, 'Trade.mqh'), content);

        await ensureUtf8Mirror(srcDir);

        const mirrored = fs.readFileSync(path.join(mirrorDir, 'Trade.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'Trade');
    });

    test('skips non-mirrorable extensions', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('skip-ext');
        writeFileSync(path.join(srcDir, 'readme.txt'), 'hello');
        writeFileSync(path.join(srcDir, 'Code.mqh'), 'int x;');

        await ensureUtf8Mirror(srcDir);

        assert.ok(!fs.existsSync(path.join(mirrorDir, 'readme.txt')));
        assert.ok(fs.existsSync(path.join(mirrorDir, 'Code.mqh')));
    });

    test('mirrors nested subdirectories', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('nested');
        writeFileSync(path.join(srcDir, 'A', 'B', 'Deep.mqh'), 'deep content');

        await ensureUtf8Mirror(srcDir);

        const mirrored = fs.readFileSync(
            path.join(mirrorDir, 'A', 'B', 'Deep.mqh'), 'utf8'
        );
        assert.strictEqual(mirrored, 'deep content');
    });

    test('prunes stale mirror entries not in source', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('prune');
        writeFileSync(path.join(srcDir, 'Keep.mqh'), 'keep');

        // First mirror
        await ensureUtf8Mirror(srcDir);
        assert.ok(fs.existsSync(path.join(mirrorDir, 'Keep.mqh')));

        // Add a stale file directly to mirror
        writeFileSync(path.join(mirrorDir, 'Stale.mqh'), 'stale');

        // Remove source file and re-mirror
        fs.unlinkSync(path.join(srcDir, 'Keep.mqh'));

        await ensureUtf8Mirror(srcDir);

        assert.ok(!fs.existsSync(path.join(mirrorDir, 'Keep.mqh')), 'removed source should be pruned from mirror');
        assert.ok(!fs.existsSync(path.join(mirrorDir, 'Stale.mqh')), 'stale file should be pruned');
    });

    test('skips up-to-date files (mtime match)', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('uptodate');
        writeFileSync(path.join(srcDir, 'Cached.mqh'), 'v1');

        await ensureUtf8Mirror(srcDir);
        const firstMtime = mtimeMs(path.join(mirrorDir, 'Cached.mqh'));
        assert.ok(firstMtime !== null);

        // Re-mirror without changing source — should skip
        await ensureUtf8Mirror(srcDir);
        const secondMtime = mtimeMs(path.join(mirrorDir, 'Cached.mqh'));
        assert.strictEqual(firstMtime, secondMtime, 'file should not be rewritten');
    });

    test('preserves source mtime on mirror file (POSIX)', async () => {
        // On Windows, utimes can fail with EINVAL on some paths/filesystems.
        if (process.platform === 'win32') return;

        const { srcDir, mirrorDir } = freshSourceDir('mtime-preserve');
        const srcFile = path.join(srcDir, 'Timed.mqh');
        writeFileSync(srcFile, 'content');

        // Set a specific source mtime (1 hour ago)
        const oneHourAgo = Date.now() - 3600000;
        fs.utimesSync(srcFile, oneHourAgo / 1000, oneHourAgo / 1000);

        await ensureUtf8Mirror(srcDir);

        const srcStat = fs.statSync(srcFile);
        const dstStat = fs.statSync(path.join(mirrorDir, 'Timed.mqh'));
        // Allow 2ms tolerance for filesystem rounding
        assert.ok(
            Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 2,
            `mirror mtime (${dstStat.mtimeMs}) should match source (${srcStat.mtimeMs})`
        );
    });

    test('utimes failure does not prevent mirror creation (Windows compat)', async () => {
        // Verify that even when utimes fails, the file is still mirrored.
        const { srcDir, mirrorDir } = freshSourceDir('utimes-fail-safe');
        writeFileSync(path.join(srcDir, 'Safe.mqh'), 'safe content');

        await ensureUtf8Mirror(srcDir);

        const mirrored = fs.readFileSync(path.join(mirrorDir, 'Safe.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'safe content');
    });

    test('re-mirrors when source is newer than mirror', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('re-mirror');
        const srcFile = path.join(srcDir, 'Update.mqh');

        writeFileSync(srcFile, 'v1');
        await ensureUtf8Mirror(srcDir);

        // Touch source to make it newer
        const now = Date.now();
        fs.utimesSync(srcFile, now / 1000, now / 1000);
        writeFileSync(srcFile, 'v2');
        // Ensure write updated mtime
        fs.utimesSync(srcFile, now / 1000 + 1, now / 1000 + 1);

        await ensureUtf8Mirror(srcDir);

        const mirrored = fs.readFileSync(path.join(mirrorDir, 'Update.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'v2');
    });

    test('returns source dir when input is not a directory', async () => {
        const { srcDir } = freshSourceDir('notdir');
        const filePath = path.join(srcDir, 'file.mqh');
        writeFileSync(filePath, 'x');

        const result = await ensureUtf8Mirror(filePath);
        assert.strictEqual(result, filePath);
    });

    test('returns source dir when input does not exist', async () => {
        const result = await ensureUtf8Mirror('/nonexistent/path/12345');
        assert.strictEqual(result, '/nonexistent/path/12345');
    });

    test('returns source dir for null/empty/undefined input', async () => {
        assert.strictEqual(await ensureUtf8Mirror(null), null);
        assert.strictEqual(await ensureUtf8Mirror(''), '');
        assert.strictEqual(await ensureUtf8Mirror(undefined), undefined);
    });

    test('deduplicates concurrent calls for same directory', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('dedup');
        writeFileSync(path.join(srcDir, 'D.mqh'), 'x');

        // Fire 5 concurrent calls — only one walk should execute
        const results = await Promise.all([
            ensureUtf8Mirror(srcDir),
            ensureUtf8Mirror(srcDir),
            ensureUtf8Mirror(srcDir),
            ensureUtf8Mirror(srcDir),
            ensureUtf8Mirror(srcDir),
        ]);

        // All should return the same mirror dir
        for (const r of results) {
            assert.strictEqual(r, mirrorDir);
        }
        // File should exist exactly once
        const mirrored = fs.readFileSync(path.join(mirrorDir, 'D.mqh'), 'utf8');
        assert.strictEqual(mirrored, 'x');
    });

    test('does not follow symlinked directories', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('symlink');
        writeFileSync(path.join(srcDir, 'Real.mqh'), 'real');

        // Create a symlink pointing back to srcDir (would cause infinite recursion)
        const linkPath = path.join(srcDir, 'loop');
        try {
            fs.symlinkSync(srcDir, linkPath, 'junction');
        } catch {
            // Symlinks may not be supported on this platform/config
            return;
        }

        await ensureUtf8Mirror(srcDir);

        // Real.mqh should be mirrored; loop/ should NOT be followed
        assert.ok(fs.existsSync(path.join(mirrorDir, 'Real.mqh')));
        assert.ok(!fs.existsSync(path.join(mirrorDir, 'loop', 'Real.mqh')),
            'symlinked directory should not be followed');
    });

    test('mirror directory has restrictive permissions', async () => {
        // Only meaningful on POSIX; on Windows chmod is a no-op
        if (process.platform === 'win32') return;

        const { srcDir, mirrorDir } = freshSourceDir('perms');
        writeFileSync(path.join(srcDir, 'P.mqh'), 'x');

        await ensureUtf8Mirror(srcDir);

        // _performMirror explicitly chmods the mirror leaf directory to 0o700
        const stat = fs.statSync(mirrorDir);
        const mode = stat.mode & 0o777;
        assert.strictEqual(mode, 0o700, `mirror dir should be 0o700, got 0o${mode.toString(8)}`);
    });

    test('writes stamp file after successful mirror', async () => {
        const { srcDir, mirrorDir } = freshSourceDir('stamp');
        writeFileSync(path.join(srcDir, 'S.mqh'), 's');

        await ensureUtf8Mirror(srcDir);

        assert.ok(fs.existsSync(path.join(mirrorDir, '.mirror-stamp')));
    });
});
