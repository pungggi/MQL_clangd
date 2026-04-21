'use strict';

const fs = require('fs');
const pathModule = require('path');
const os = require('os');

const { decodeTextBuffer } = require('./textDecoding');

const MIRRORABLE_EXTS = new Set(['.mqh', '.mq5', '.mq4']);

/**
 * Compute the root directory for UTF-8 mirror copies.
 *
 *   Windows: %LOCALAPPDATA%/mql-clangd/mirror
 *   other  : $HOME/.cache/mql-clangd/mirror
 *
 * @returns {string}
 */
function getMirrorRoot() {
    const base = process.env.LOCALAPPDATA
        ? process.env.LOCALAPPDATA
        : pathModule.join(os.homedir(), '.cache');
    return pathModule.join(base, 'mql-clangd', 'mirror');
}

/**
 * Map a source path onto its mirror path.  The Windows drive letter becomes
 * a regular path segment (e.g. `C:\Users\...` → `<root>/C/Users/...`) so the
 * mirror is collision-free across drives and still greppable.
 *
 * @param {string} sourceAbsPath
 * @returns {string}
 */
function mapToMirror(sourceAbsPath) {
    const root = getMirrorRoot();
    const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(sourceAbsPath);
    if (driveMatch) {
        return pathModule.join(root, driveMatch[1].toUpperCase(), driveMatch[2]);
    }
    // POSIX-style absolute — strip the leading slash to keep path.join sane.
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
    } catch {
        return;
    }

    for (const entry of entries) {
        const srcPath = pathModule.join(srcDir, entry.name);
        const dstPath = pathModule.join(dstDir, entry.name);

        if (entry.isDirectory()) {
            await walkAndMirror(srcPath, dstPath);
            continue;
        }
        if (!entry.isFile()) continue;

        const ext = pathModule.extname(entry.name).toLowerCase();
        if (!MIRRORABLE_EXTS.has(ext)) continue;

        const [srcMtime, dstMtime] = await Promise.all([
            fileMtimeMs(srcPath),
            fileMtimeMs(dstPath)
        ]);
        if (srcMtime === null) continue;
        if (dstMtime !== null && dstMtime >= srcMtime) continue;

        try {
            await transcodeOne(srcPath, dstPath);
        } catch (err) {
            console.warn(`MQL Tools: failed to mirror ${srcPath}: ${err && err.message}`);
        }
    }
}

/**
 * Ensure a UTF-8 mirror of `sourceIncludeDir` exists and is up to date.
 * Returns the mirror directory path so callers can use it as the effective
 * include root.  On any top-level failure, returns `sourceIncludeDir` so
 * clangd falls back to the original tree (no worse than no-mirror).
 *
 * No-op (returns the input) when the source doesn't exist or isn't a dir.
 *
 * @param {string} sourceIncludeDir
 * @returns {Promise<string>}
 */
async function ensureUtf8Mirror(sourceIncludeDir) {
    if (!sourceIncludeDir || typeof sourceIncludeDir !== 'string') {
        return sourceIncludeDir;
    }

    try {
        const st = await fs.promises.stat(sourceIncludeDir);
        if (!st.isDirectory()) return sourceIncludeDir;
    } catch {
        return sourceIncludeDir;
    }

    const mirrorDir = mapToMirror(pathModule.resolve(sourceIncludeDir));

    try {
        await fs.promises.mkdir(mirrorDir, { recursive: true });
        await walkAndMirror(sourceIncludeDir, mirrorDir);
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
