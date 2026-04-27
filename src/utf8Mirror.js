'use strict';

const fs = require('fs');
const pathModule = require('path');
const os = require('os');

const { decodeTextBuffer } = require('./textDecoding');

const MIRRORABLE_EXTS = new Set(['.mqh', '.mq5', '.mq4']);
const STAMP_FILE = '.mirror-stamp';

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
        : pathModule.join(os.homedir(), '.cache');
    return pathModule.join(base, 'mql-clangd', 'mirror');
}

/**
 * Map a source path onto its mirror path.  The Windows drive letter becomes
 * a regular path segment (e.g. `C:\Users\...` → `<root>/C/Users/...`) so the
 * mirror is collision-free across drives and still greppable.
 *
 * UNC paths are normalised into an 'unc' subdirectory to prevent escaping
 * the mirror root.
 */
function mapToMirror(sourceAbsPath) {
    const root = getMirrorRoot();
    const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(sourceAbsPath);
    if (driveMatch) {
        return pathModule.join(root, driveMatch[1].toUpperCase(), driveMatch[2]);
    }
    // UNC paths (\\server\share\... or //server/share/...) — normalise into 'unc' subdirectory.
    const uncMatch = /^[\\/]{2}([^\\/]+)[\\/](.*)$/.exec(sourceAbsPath);
    if (uncMatch) {
        return pathModule.join(root, 'unc', uncMatch[1], uncMatch[2]);
    }
    // POSIX-style absolute — strip the leading slash.
    if (sourceAbsPath.startsWith('/')) {
        return pathModule.join(root, sourceAbsPath.slice(1));
    }
    return pathModule.join(root, sourceAbsPath);
}

async function fileMtimeMs(filePath) {
    try {
        const st = await fs.promises.stat(filePath);
        return st.mtimeMs;
    } catch {
        return null;
    }
}

async function transcodeOne(srcPath, dstPath) {
    const buffer = await fs.promises.readFile(srcPath);
    const text = decodeTextBuffer(buffer);
    await fs.promises.mkdir(pathModule.dirname(dstPath), { recursive: true });
    await fs.promises.writeFile(dstPath, text, 'utf8');
}

async function walkAndMirror(srcDir, dstDir) {
    let entries;
    try {
        entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
    } catch (err) {
        // Propagate so ensureUtf8Mirror can fall back to the source directory.
        throw err;
    }

    // Prune stale mirror entries that no longer exist in the source.
    const srcNames = new Set(entries.map(e => e.name));
    let dstEntries;
    try {
        dstEntries = await fs.promises.readdir(dstDir, { withFileTypes: true });
    } catch {
        dstEntries = [];
    }

    await Promise.all(dstEntries
        .filter(d => d.name !== STAMP_FILE && !srcNames.has(d.name))
        .map(async dEntry => {
            const stalePath = pathModule.join(dstDir, dEntry.name);
            try {
                if (dEntry.isDirectory()) {
                    await fs.promises.rm(stalePath, { recursive: true });
                } else if (MIRRORABLE_EXTS.has(pathModule.extname(dEntry.name).toLowerCase())) {
                    await fs.promises.unlink(stalePath);
                }
            } catch (err) {
                console.warn(`MQL Tools: failed to prune stale mirror entry ${stalePath}: ${err && err.message}`);
            }
        }));

    await Promise.all(entries.map(async entry => {
        const srcPath = pathModule.join(srcDir, entry.name);
        const dstPath = pathModule.join(dstDir, entry.name);

        if (entry.isDirectory()) {
            await walkAndMirror(srcPath, dstPath);
            return;
        }
        if (!entry.isFile()) return;

        const ext = pathModule.extname(entry.name).toLowerCase();
        if (!MIRRORABLE_EXTS.has(ext)) return;

        const [srcMtime, dstMtime] = await Promise.all([
            fileMtimeMs(srcPath),
            fileMtimeMs(dstPath)
        ]);
        if (srcMtime === null) return;
        if (dstMtime !== null && dstMtime >= srcMtime) return;

        try {
            await transcodeOne(srcPath, dstPath);
        } catch (err) {
            console.warn(`MQL Tools: failed to mirror ${srcPath}: ${err && err.message}`);
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

    promise = _performMirror(sourceIncludeDir, mirrorDir, srcStat.mtimeMs);
    _mirrorPromises.set(mirrorDir, promise);
    try {
        return await promise;
    } finally {
        _mirrorPromises.delete(mirrorDir);
    }
}

async function _performMirror(sourceIncludeDir, mirrorDir, srcMtimeMs) {
    const stampPath = pathModule.join(mirrorDir, STAMP_FILE);
    try {
        await fs.promises.mkdir(mirrorDir, { recursive: true });

        // Skip full walk if mirror was built after the source dir was last modified.
        const stampMtime = await fileMtimeMs(stampPath);
        if (stampMtime !== null && stampMtime >= srcMtimeMs) {
            return mirrorDir;
        }

        await walkAndMirror(sourceIncludeDir, mirrorDir);
        await fs.promises.writeFile(stampPath, '', 'utf8');
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
