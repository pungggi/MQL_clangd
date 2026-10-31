'use strict';
const fs = require('fs');
const path = require('path');

// Matches the artifacts written by debugInstrumentation.js during a debug run:
//   <base>.mql_dbg_build.<mq4|mq5|mqh>  instrumented source copies
//   <base>.mql_dbg_build.<ex4|ex5>      instrumented compiled binaries
// Aborted debug sessions (crash, closed window, killed terminal) leave these
// behind. They pollute search results, symbol scans and git status, so the
// extension sweeps them once at activation.
const DBG_BUILD_ARTIFACT = /\.mql_dbg_build\.(mq[45]|mqh|ex[45])$/i;

/** Pure helper: does this file name look like a debug-build artifact? */
function isDbgBuildArtifact(fileName) {
    return DBG_BUILD_ARTIFACT.test(fileName);
}

// Directory names never worth walking during the sweep. Keeps activation
// cheap in workspaces with large vendored trees.
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', '.vscode-test', '.vs', 'dist'];

/**
 * Recursively collect debug-build artifact paths below rootDir.
 * Unreadable directories are skipped silently: the sweep is best-effort and
 * must never turn a permission problem into an activation error.
 */
async function collectDbgBuildArtifacts(rootDir, { skipDirs = DEFAULT_SKIP_DIRS } = {}) {
    const skip = new Set(skipDirs);
    const found = [];

    async function walk(dir) {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skip.has(entry.name)) {
                    await walk(fullPath);
                }
            } else if (entry.isFile() && isDbgBuildArtifact(entry.name)) {
                found.push(fullPath);
            }
        }
    }

    await walk(rootDir);
    return found;
}

/**
 * Delete files one by one. Files that cannot be removed (locked by a still
 * running MetaEditor, permission error) are reported, not thrown.
 */
async function removeFiles(files, { unlink } = {}) {
    const doUnlink = unlink || ((p) => fs.promises.unlink(p));
    const removed = [];
    const failed = [];
    for (const file of files) {
        try {
            await doUnlink(file);
            removed.push(file);
        } catch (err) {
            failed.push({ file, code: err && err.code });
        }
    }
    return { removed, failed };
}

/**
 * Sweep leftover debug-build artifacts in every given root directory.
 * Returns per-root results so the caller can log a short summary.
 */
async function sweepDbgBuildArtifacts(rootDirs, deps = {}) {
    const results = [];
    for (const rootDir of rootDirs) {
        const files = await collectDbgBuildArtifacts(rootDir, deps);
        const outcome = await removeFiles(files, deps);
        results.push({ rootDir, removed: outcome.removed, failed: outcome.failed });
    }
    return results;
}

module.exports = {
    isDbgBuildArtifact,
    collectDbgBuildArtifacts,
    removeFiles,
    sweepDbgBuildArtifacts,
};
