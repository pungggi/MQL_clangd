'use strict';

const fs = require('fs');
const pathModule = require('path');
const os = require('os');

const { decodeTextBuffer } = require('./textDecoding');

const MIRRORABLE_EXTS = new Set(['.mqh', '.mq5', '.mq4']);
const STAMP_FILE = '.mirror-stamp';

// ── Bounded mirroring constants ─────────────────────────────────────────
const MAX_DEPTH = 20;
const MAX_FILES = 10000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const CONCURRENCY_LIMIT = 16;

/** Simple counting semaphore to cap concurrent async operations. */
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
const _ioSem = new Semaphore(CONCURRENCY_LIMIT);

/** Per-mirror-root mutex: deduplicates concurrent ensureUtf8Mirror calls. */
const _mirrorPromises = new Map();

/**
 * Compute the root directory for UTF-8 mirror copies.
 *
 *   Windows: %LOCALAPPDATA%/mql-clangd/mirror
 *   other  : $HOME/.cache/mql-clangd/mirror
 *
 * Uses process.platform so the path follows platform semantics regardless
 * of environment variable overrides.
 */
function getMirrorRoot() {
    const base = process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || pathModule.join(os.homedir(), 'AppData', 'Local'))
        : (process.env.XDG_CACHE_HOME || pathModule.join(os.homedir(), '.cache'));
    return pathModule.join(base, 'mql-clangd', 'mirror');
}

/**
 * Map a source path onto its mirror path.  The Windows drive letter becomes
 * a regular path segment (e.g. `C:\Users\...` → `<root>/C/Users/...`) so the
 * mirror is collision-free across drives and still greppable.
 *
 * UNC paths are normalised into an 'unc' subdirectory to prevent escaping
 * the mirror root.
 *
 * Callers must pass a fully resolved absolute path (e.g. from
 * `pathModule.resolve`).  Relative or bare-drive forms are rejected to avoid
 * bogus mirror names.
 */
function mapToMirror(sourceAbsPath) {
    if (typeof sourceAbsPath !== 'string') {
        throw new Error('mapToMirror: sourceAbsPath must be a string, got ' + typeof sourceAbsPath);
    }
    // Reject non-absolute paths (including bare-drive forms like "C:" or "C:foo").
    if (!pathModule.isAbsolute(sourceAbsPath) || /^[A-Za-z]:$/.test(sourceAbsPath) || /^[A-Za-z]:[^\\/]/.test(sourceAbsPath)) {
        throw new Error('mapToMirror: expected a resolved absolute path (pass pathModule.resolve first); got: ' + sourceAbsPath);
    }
    const root = getMirrorRoot();
    const normalised = pathModule.normalize(sourceAbsPath);
    const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(normalised);
    if (driveMatch) {
        return pathModule.join(root, driveMatch[1].toUpperCase(), driveMatch[2]);
    }
    // UNC paths (\\server\share\... or //server/share/...) — normalise into 'unc' subdirectory.
    const uncMatch = /^[\\/]{2}([^\\/]+)[\\/](.*)$/.exec(normalised);
    if (uncMatch) {
        return pathModule.join(root, 'unc', uncMatch[1], uncMatch[2]);
    }
    // POSIX-style absolute — strip ALL leading slashes so path.join stays under root.
    if (normalised.startsWith('/')) {
        return pathModule.join(root, normalised.replace(/^\/+/, ''));
    }
    // Should not reach here due to isAbsolute check above, but kept as safety fallback.
    return pathModule.join(root, normalised);
}

async function fileMtimeMs(filePath) {
    try {
        const st = await fs.promises.stat(filePath);
        return st.mtimeMs;
    } catch {
        return null;
    }
}

async function transcodeOne(srcPath, dstPath, srcStat) {
    const buffer = await fs.promises.readFile(srcPath);
    const text = decodeTextBuffer(buffer);
    const dir = pathModule.dirname(dstPath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(dstPath, text, { encoding: 'utf8', mode: 0o600 });
    // Preserve source mtime so future comparisons remain correct even when
    // installers / sync tools extract files with older timestamps.
    // Non-fatal: on some platforms/paths utimes may fail (e.g. NTFS EINVAL).
    if (srcStat) {
        try {
            await fs.promises.utimes(dstPath, srcStat.atimeMs, srcStat.mtimeMs);
        } catch { /* best-effort; mtime may drift by one mirror cycle */ }
    }
}

async function walkAndMirror(srcDir, dstDir, depth, ctx) {
    if (depth > MAX_DEPTH) {
        console.warn(`MQL Tools: mirror depth limit (${MAX_DEPTH}) exceeded at ${srcDir}`);
        return;
    }
    if (ctx.fileCount >= MAX_FILES) {
        console.warn(`MQL Tools: mirror file limit (${MAX_FILES}) reached`);
        return;
    }

    let entries;
    try {
        entries = await _ioSem.acquire().then(() =>
            fs.promises.readdir(srcDir, { withFileTypes: true }).finally(() => _ioSem.release())
        );
    } catch {
        return;
    }

    // Prune stale mirror entries that no longer exist in the source.
    const srcNames = new Set(entries.map(e => e.name));
    let dstEntries;
    try {
        dstEntries = await _ioSem.acquire().then(() =>
            fs.promises.readdir(dstDir, { withFileTypes: true }).finally(() => _ioSem.release())
        );
    } catch {
        dstEntries = [];
    }

    // Batch prune with concurrency limiter
    await Promise.all(dstEntries
        .filter(d => d.name !== STAMP_FILE && !srcNames.has(d.name))
        .map(async dEntry => {
            const stalePath = pathModule.join(dstDir, dEntry.name);
            try {
                await _ioSem.acquire();
                if (dEntry.isDirectory()) {
                    await fs.promises.rm(stalePath, { recursive: true });
                } else if (MIRRORABLE_EXTS.has(pathModule.extname(dEntry.name).toLowerCase())) {
                    await fs.promises.unlink(stalePath);
                }
            } catch (err) {
                console.warn(`MQL Tools: failed to prune stale mirror entry ${stalePath}: ${err && err.message}`);
            } finally {
                _ioSem.release();
            }
        }));

    // Process entries with concurrency limiter
    await Promise.all(entries.map(async entry => {
        const srcPath = pathModule.join(srcDir, entry.name);
        const dstPath = pathModule.join(dstDir, entry.name);

        // Skip all symlinks (to directories and files) to prevent infinite
        // recursion and avoid mirroring uncontrolled content.
        // On most POSIX systems, readdir Dirent reports symlink-to-dir as
        // isSymbolicLink()=true, isDirectory()=false, so the isDirectory()
        // branch below would never see them.  On platforms where Dirent
        // falls back to stat (d_type=DT_UNKNOWN), isDirectory() could be
        // true — checking isSymbolicLink() first ensures consistent behavior.
        if (entry.isSymbolicLink()) return;
        if (entry.isDirectory()) {
            await walkAndMirror(srcPath, dstPath, depth + 1, ctx);
            return;
        }
        // Non-regular files (sockets, FIFOs, etc.) are silently skipped.
        // Symlink-to-file entries are also skipped here since isFile()
        // returns false for symlinks on most platforms.  MetaQuotes
        // headers are never symlinks, so this has no practical impact.
        if (!entry.isFile()) return;

        const ext = pathModule.extname(entry.name).toLowerCase();
        if (!MIRRORABLE_EXTS.has(ext)) return;

        // Fast-path check — may overshoot by up to CONCURRENCY_LIMIT entries
        // due to concurrent Promise.all iterations.  Acceptable: the limits
        // are safety bounds, not exact quotas.
        if (ctx.fileCount >= MAX_FILES) return;

        try {
            await _ioSem.acquire();
            const [srcStat, dstMtime] = await Promise.all([
                fs.promises.stat(srcPath),
                fileMtimeMs(dstPath)
            ]);
            if (!srcStat || !srcStat.isFile()) return;
            if (srcStat.size > MAX_FILE_BYTES) return;
            if (ctx.totalBytes + srcStat.size > MAX_TOTAL_BYTES) return;
            if (dstMtime !== null && dstMtime >= srcStat.mtimeMs) return;

            // All checks passed — commit to mirroring this file.
            ctx.fileCount++;
            ctx.totalBytes += srcStat.size;
            await transcodeOne(srcPath, dstPath, srcStat);
        } catch (err) {
            console.warn(`MQL Tools: failed to mirror ${srcPath}: ${err && err.message}`);
        } finally {
            _ioSem.release();
        }
    }));
}

/**
 * Ensure a UTF-8 mirror of `sourceIncludeDir` exists and is up to date.
 * Returns the mirror directory path so callers can use it as the effective
 * include root.  On any failure, returns `sourceIncludeDir` so clangd falls
 * back to the original tree (no worse than no-mirror).
 *
 * Concurrent calls targeting the same mirror directory are deduplicated
 * via an in-process mutex so only one walk runs at a time per root.
 */
async function ensureUtf8Mirror(sourceIncludeDir) {
    if (!sourceIncludeDir || typeof sourceIncludeDir !== 'string') {
        return sourceIncludeDir;
    }

    let srcStat;
    try {
        srcStat = await fs.promises.stat(sourceIncludeDir);
        if (!srcStat.isDirectory()) return sourceIncludeDir;
    } catch {
        return sourceIncludeDir;
    }

    const mirrorDir = mapToMirror(pathModule.resolve(sourceIncludeDir));

    // Deduplicate concurrent mirror operations for the same directory.
    let promise = _mirrorPromises.get(mirrorDir);
    if (promise) return promise;

    promise = _performMirror(sourceIncludeDir, mirrorDir);
    _mirrorPromises.set(mirrorDir, promise);
    try {
        return await promise;
    } finally {
        _mirrorPromises.delete(mirrorDir);
    }
}

async function _performMirror(sourceIncludeDir, mirrorDir) {
    const stampPath = pathModule.join(mirrorDir, STAMP_FILE);
    try {
        await fs.promises.mkdir(mirrorDir, { recursive: true });
        // Explicitly chmod the mirror root: recursive mkdir's mode only applies
        // to the final directory component and is subject to umask.
        // On Windows this is a no-op (NTFS uses ACLs).
        await fs.promises.chmod(mirrorDir, 0o700).catch(() => {});

        // Always perform the full walk so nested-file changes are detected.
        // Per-file mtime checks inside walkAndMirror skip up-to-date files.
        const ctx = { fileCount: 0, totalBytes: 0 };
        await walkAndMirror(sourceIncludeDir, mirrorDir, 0, ctx);
        await fs.promises.writeFile(stampPath, '', { encoding: 'utf8', mode: 0o600 });
        return mirrorDir;
    } catch (err) {
        console.warn(`MQL Tools: UTF-8 mirror unavailable for ${sourceIncludeDir}: ${err && err.message}`);
        return sourceIncludeDir;
    }
}

module.exports = {
    ensureUtf8Mirror,
    getMirrorRoot,
    mapToMirror
};
