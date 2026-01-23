'use strict';
const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');

/**
 * Compile Target Resolver
 * Manages the mapping between .mqh header files and their compile targets (.mq4/.mq5 files)
 * Provides inference capabilities by building a reverse include graph
 */

// In-memory cache for reverse include index per workspace
const reverseIndexCache = new Map(); // workspaceUri -> { index: Map, dirty: boolean }

/**
 * Parse #include statements from MQL source code
 */
function parseIncludes(text) {
    const includes = [];
    // Strip block comments
    const strippedText = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = strippedText.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) continue;

        const match = trimmed.match(/^\s*#include\s+["<]([^">]+)[">]/);
        if (match) {
            includes.push(match[1]);
        }
    }

    return includes;
}

/**
 * Resolve an include path to absolute file path(s)
 */
function resolveIncludePath(includePath, currentFileDir, workspaceRoot, includeDir) {
    const candidates = [];

    const relPath = pathModule.join(currentFileDir, includePath);
    if (fs.existsSync(relPath)) {
        candidates.push(relPath);
    }

    const wsIncludePath = pathModule.join(workspaceRoot, 'Include', includePath);
    if (fs.existsSync(wsIncludePath)) {
        candidates.push(wsIncludePath);
    }

    if (includeDir && fs.existsSync(includeDir)) {
        const extIncludePath = pathModule.join(includeDir, includePath);
        if (fs.existsSync(extIncludePath)) {
            candidates.push(extIncludePath);
        }
    }

    return candidates;
}

/**
 * Build reverse include index: includedFile -> Set<includingFiles>
 */
async function buildReverseIndex(workspaceFolder, include4Dir, include5Dir, maxFiles = 5000) {
    const reverseIndex = new Map();
    const workspaceRoot = workspaceFolder.uri.fsPath;

    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5,mqh}'),
        '**/node_modules/**',
        maxFiles
    );

    for (const fileUri of files) {
        const filePath = fileUri.fsPath;
        const fileDir = pathModule.dirname(filePath);

        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const includes = parseIncludes(content);

            const ext = pathModule.extname(filePath).toLowerCase();
            const includeDir = (ext === '.mq4' || filePath.toLowerCase().includes('mql4')) ? include4Dir : include5Dir;

            for (const includePath of includes) {
                const resolvedPaths = resolveIncludePath(includePath, fileDir, workspaceRoot, includeDir);

                for (const resolvedPath of resolvedPaths) {
                    const normalizedResolved = pathModule.normalize(resolvedPath).toLowerCase();
                    // Store normalized key, but the value is a Set of original filePath strings
                    if (!reverseIndex.has(normalizedResolved)) {
                        reverseIndex.set(normalizedResolved, new Set());
                    }
                    reverseIndex.get(normalizedResolved).add(filePath);
                }
            }
        } catch (err) {
            console.error(`Error reading ${filePath}:`, err);
        }
    }

    return reverseIndex;
}

/**
 * Find candidate main files (.mq4/.mq5) that include a given header
 */
function findCandidateMains(reverseIndex, headerPath) {
    const normalizedHeader = pathModule.normalize(headerPath).toLowerCase();
    const visited = new Set();
    const queue = [normalizedHeader];
    const mainsSet = new Set();

    while (queue.length > 0) {
        const current = queue.shift();

        if (visited.has(current)) continue;
        visited.add(current);

        const includingFiles = reverseIndex.get(current);
        if (!includingFiles) continue;

        for (const includingFile of includingFiles) {
            const ext = pathModule.extname(includingFile).toLowerCase();

            if (ext === '.mq4' || ext === '.mq5') {
                mainsSet.add(includingFile);
            } else if (ext === '.mqh') {
                const normalizedIncluding = pathModule.normalize(includingFile).toLowerCase();
                queue.push(normalizedIncluding);
            }
        }
    }

    return Array.from(mainsSet);
}

/**
 * Get or build reverse include index for a workspace
 */
async function getOrBuildReverseIndex(workspaceFolder, _context) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const maxFiles = config.get('CompileTarget.InferMaxFiles', 5000);
    const include4Dir = config.get('Metaeditor.Include4Dir', '');
    const include5Dir = config.get('Metaeditor.Include5Dir', '');

    const wsUri = workspaceFolder.uri.toString();
    let cacheEntry = reverseIndexCache.get(wsUri);

    if (!cacheEntry || cacheEntry.dirty) {
        const index = await buildReverseIndex(workspaceFolder, include4Dir, include5Dir, maxFiles);
        cacheEntry = { index, dirty: false };
        reverseIndexCache.set(wsUri, cacheEntry);
    }

    return cacheEntry.index;
}

/**
 * Mark reverse index as dirty (needs rebuild)
 */
function markIndexDirty(workspaceFolder) {
    const wsUri = workspaceFolder.uri.toString();
    const cacheEntry = reverseIndexCache.get(wsUri);
    if (cacheEntry) {
        cacheEntry.dirty = true;
    }
}

/**
 * Get storage location for compile target mappings
 */
function getStorage(context, workspaceFolder) {
    const scope = workspaceFolder ? workspaceFolder.uri : null;
    const config = vscode.workspace.getConfiguration('mql_tools', scope);
    const storageType = config.get('CompileTarget.Storage', 'workspaceState');

    if (storageType === 'globalState') {
        return {
            get: (key, defaultValue) => context.globalState.get(key, defaultValue),
            set: (key, value) => context.globalState.update(key, value),
            storageType: 'globalState'
        };
    } else if (storageType === 'workspaceSettings') {
        return {
            get: (key, defaultValue) => config.get(key, defaultValue),
            set: (key, value) => config.update(key, value, workspaceFolder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace),
            storageType: 'workspaceSettings'
        };
    } else {
        return {
            get: (key, defaultValue) => context.workspaceState.get(key, defaultValue),
            set: (key, value) => context.workspaceState.update(key, value),
            storageType: 'workspaceState'
        };
    }
}

/**
 * Get compile target mapping for a header file
 */
function getCompileTargets(headerUri, workspaceFolder, context) {
    const storage = getStorage(context, workspaceFolder);
    const map = storage.get('CompileTarget.Map', {});

    const headerRelPath = pathModule.relative(workspaceFolder.uri.fsPath, headerUri.fsPath);
    const normalizedKey = pathModule.normalize(headerRelPath).toLowerCase();

    return map[normalizedKey] || null;
}

/**
 * Set compile target mapping for a header file
 */
async function setCompileTargets(headerUri, targetUris, workspaceFolder, context) {
    const storage = getStorage(context, workspaceFolder);
    const map = storage.get('CompileTarget.Map', {});

    const headerRelPath = pathModule.relative(workspaceFolder.uri.fsPath, headerUri.fsPath);
    const normalizedKey = pathModule.normalize(headerRelPath).toLowerCase();

    const targetRelPaths = targetUris.map(uri =>
        pathModule.relative(workspaceFolder.uri.fsPath, uri.fsPath)
    );

    map[normalizedKey] = targetRelPaths;
    await storage.set('CompileTarget.Map', map);
}

/**
 * Reset compile target mapping for a header file or all headers
 */
async function resetCompileTargets(headerUri, workspaceFolder, context) {
    const storage = getStorage(context, workspaceFolder);

    if (headerUri === null) {
        await storage.set('CompileTarget.Map', {});
    } else {
        const map = storage.get('CompileTarget.Map', {});
        const headerRelPath = pathModule.relative(workspaceFolder.uri.fsPath, headerUri.fsPath);
        const normalizedKey = pathModule.normalize(headerRelPath).toLowerCase();

        delete map[normalizedKey];
        await storage.set('CompileTarget.Map', map);
    }
}

/**
 * Prompt user to select compile targets
 */
async function promptForTargets(headerUri, workspaceFolder, context, candidates) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const allowMultiSelect = config.get('CompileTarget.AllowMultiSelect', true);

    let items;

    if (candidates && candidates.length > 0) {
        items = candidates.map(filePath => ({
            label: pathModule.basename(filePath),
            description: pathModule.relative(workspaceFolder.uri.fsPath, filePath),
            filePath: filePath
        }));
    } else {
        const MAX_RESULTS = 1000;
        const allMains = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5}'),
            '**/node_modules/**',
            MAX_RESULTS
        );

        if (allMains.length === MAX_RESULTS) {
            vscode.window.showWarningMessage(`Compile target list truncated at ${MAX_RESULTS} files. Some targets may be missing.`);
        }

        items = allMains.map(uri => ({
            label: pathModule.basename(uri.fsPath),
            description: pathModule.relative(workspaceFolder.uri.fsPath, uri.fsPath),
            filePath: uri.fsPath
        }));
    }

    if (items.length === 0) {
        vscode.window.showWarningMessage('No .mq4 or .mq5 files found in workspace');
        return null;
    }

    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: allowMultiSelect,
        placeHolder: `Select compile target(s) for ${pathModule.basename(headerUri.fsPath)}`,
        title: 'MQL Compile Target'
    });

    if (!selected) {
        return null;
    }

    const selectedItems = Array.isArray(selected) ? selected : [selected];
    const targetUris = selectedItems.map(item => vscode.Uri.file(item.filePath));

    await setCompileTargets(headerUri, targetUris, workspaceFolder, context);

    return selectedItems.map(item => item.filePath);
}

/**
 * Resolve compile targets for a document - Main entry point
 */
async function resolveCompileTargets({ document, workspaceFolder, context, rt }) {
    const ext = pathModule.extname(document.fileName).toLowerCase();

    if (ext !== '.mqh') {
        return null;
    }

    const skipInteraction = (rt === 0);
    const headerUri = document.uri;

    const existingTargets = getCompileTargets(headerUri, workspaceFolder, context);
    if (existingTargets && existingTargets.length > 0) {
        // Validate that targets still exist (fixes stale paths and multi-root collision issues)
        const validTargets = existingTargets
            .map(relPath => pathModule.join(workspaceFolder.uri.fsPath, relPath))
            .filter(absPath => fs.existsSync(absPath));

        if (validTargets.length > 0) {
            return validTargets;
        }
        // If no valid targets found (files deleted/moved), fall through to inference
    }

    const reverseIndex = await getOrBuildReverseIndex(workspaceFolder, context);
    const candidates = findCandidateMains(reverseIndex, headerUri.fsPath);

    if (candidates.length === 0) {
        if (skipInteraction) {
            return [];
        }
        return await promptForTargets(headerUri, workspaceFolder, context, null);
    } else if (candidates.length === 1) {
        if (!skipInteraction) {
            const targetUris = [vscode.Uri.file(candidates[0])];
            await setCompileTargets(headerUri, targetUris, workspaceFolder, context);
        }
        return candidates;
    } else {
        if (skipInteraction) {
            // Avoid auto-check running multiple compiles without an explicit mapping.
            return null;
        }
        return await promptForTargets(headerUri, workspaceFolder, context, candidates);
    }
}

module.exports = {
    resolveCompileTargets,
    setCompileTargets,
    resetCompileTargets,
    markIndexDirty,
    getCompileTargets
};

