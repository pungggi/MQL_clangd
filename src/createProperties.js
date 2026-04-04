'use strict';
const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');
const { parseIncludes, resolveIncludePath } = require('./compileTargetResolver');

/**
 * Normalizes paths for clangd (forward slashes).
 * @param {string} p
 */
function normalizePath(p) {
    if (!p) return '';
    return p.replace(/\\/g, '/');
}

/**
 * Expand a minimal, supported subset of VS Code variables in user-provided paths.
 * We intentionally keep this small and predictable.
 *
 * Supported:
 * - ${workspaceFolder}
 * - ${workspaceFolderBasename}
 *
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function expandWorkspaceVariables(inputPath, workspaceFolderPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const trimmed = inputPath.trim();

    if (!workspaceFolderPath) return trimmed;

    return trimmed
        .replace(/\$\{workspaceFolder\}/gi, workspaceFolderPath)
        .replace(/\$\{workspaceFolderBasename\}/gi, pathModule.basename(workspaceFolderPath));
}

/**
 * Resolve a configured path value against the current workspace folder.
 * - Expands ${workspaceFolder} variables.
 * - If the result is relative, resolves it against workspaceFolderPath.
 * - If the result is absolute, normalizes/removes '..' segments.
 *
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function resolvePathRelativeToWorkspace(inputPath, workspaceFolderPath) {
    if (typeof inputPath !== 'string') return inputPath;
    const expanded = expandWorkspaceVariables(inputPath, workspaceFolderPath);
    if (!expanded) return expanded;

    if (pathModule.isAbsolute(expanded)) {
        return pathModule.resolve(expanded);
    }

    if (!workspaceFolderPath) return expanded;
    return pathModule.resolve(workspaceFolderPath, expanded);
}

/**
 * Checks if a file extension is a valid MQL source extension.
 * Source extensions are .mq4, .mq5, and .mqh.
 * Compiled extensions (.ex4, .ex5) are NOT source extensions.
 * @param {string} ext - The file extension to check (e.g., '.mq4')
 * @returns {boolean} - True if it's a source extension, false otherwise
 */
function isSourceExtension(ext) {
    if (!ext) return false;
    const normalized = ext.toLowerCase();
    return ['.mq4', '.mq5', '.mqh'].includes(normalized);
}

/**
 * Checks if a file extension should have a direct compile_commands.json entry.
 * Headers rely on clangd fallback or inferred commands and must not be treated
 * as standalone translation units.
 * @param {string} ext - The file extension to check (e.g., '.mq5')
 * @returns {boolean} - True for .mq4/.mq5, false otherwise
 */
function isTranslationUnitExtension(ext) {
    if (!ext) return false;
    const normalized = ext.toLowerCase();
    return normalized === '.mq4' || normalized === '.mq5';
}

/**
 * Recursively walk the #include tree of an entry-point file in DFS post-order
 * (matching MQL's inline concatenation: a header's own includes appear before
 * it) and return, for each header, the list of headers that precede it.
 *
 * @param {string} entryPointPath  Absolute path to the .mq4/.mq5 file
 * @param {string} workspaceRoot   Workspace root directory
 * @param {string} [includeDir]    External MetaEditor Include directory
 * @returns {Promise<Map<string, string[]>>} normalizedHeaderPath → preceding header abs paths
 */
async function buildIncludeChain(entryPointPath, workspaceRoot, includeDir) {
    const flatOrder = [];
    const visited = new Set();
    const entryNorm = pathModule.normalize(entryPointPath).toLowerCase();
    visited.add(entryNorm);

    async function walk(filePath) {
        let content;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            return; // file unreadable — skip
        }
        const includes = parseIncludes(content);
        const fileDir = pathModule.dirname(filePath);

        for (const inc of includes) {
            const candidates = resolveIncludePath(inc, fileDir, workspaceRoot, includeDir);
            if (candidates.length === 0) continue;
            const resolved = candidates[0];
            const norm = pathModule.normalize(resolved).toLowerCase();
            if (visited.has(norm)) continue;
            visited.add(norm);
            // Recurse into the header first (post-order — a header's own
            // includes appear before it, matching MQL's inline concatenation)
            await walk(resolved);
            flatOrder.push(resolved);
        }
    }

    await walk(entryPointPath);

    // Build the result: for each header, preceding = everything before it in flatOrder
    const result = new Map();
    const precedingSoFar = [];
    for (let i = 0; i < flatOrder.length; i++) {
        const norm = normalizePath(flatOrder[i]);
        result.set(norm, [...precedingSoFar]);
        precedingSoFar.push(norm);
    }
    return result;
}

/**
 * Build a compile_commands.json entry for a .mqh header file with
 * -include flags for all preceding sibling headers from its parent TU.
 *
 * @param {string} headerPath         Absolute path to the .mqh file
 * @param {string[]} sharedFlags      Base compiler flags (same as TU entries)
 * @param {string[]} precedingHeaders Abs paths of headers preceding this one
 * @param {string} workspacePath      Workspace root path
 * @param {'mql4'|'mql5'} [mqlVersion='mql5']  MQL version of the parent entry point
 * @returns {{directory: string, arguments: string[], file: string}}
 */
function buildHeaderCompileEntry(headerPath, sharedFlags, precedingHeaders, workspacePath, mqlVersion) {
    const normalizedPath = normalizePath(headerPath);
    const isMql4 = mqlVersion === 'mql4';
    const args = ['clang++'];
    const flags = Array.isArray(sharedFlags) ? sharedFlags : [];

    // Find where the compat header -include flag ends up so we insert
    // sibling -include flags after it
    let compatInserted = false;
    for (const flag of flags) {
        if (!flag) continue;

        // Replace -xc++ with -xc++-header for header files
        if (flag === '-xc++') {
            args.push('-xc++-header');
            continue;
        }

        // Swap MQL version defines to match the parent entry point
        if (isMql4 && flag === '-D__MQL5__') {
            args.push('-D__MQL4__');
            continue;
        }
        if (!isMql4 && flag === '-D__MQL4__') {
            args.push('-D__MQL5__');
            continue;
        }

        args.push(flag);

        // After the compat header -include, insert sibling -include flags
        if (!compatInserted && flag.startsWith('-include')) {
            compatInserted = true;
            for (const h of precedingHeaders) {
                args.push(`-include${normalizePath(h)}`);
            }
        }
    }

    // If no compat header was found (unlikely), append sibling includes at end
    if (!compatInserted) {
        for (const h of precedingHeaders) {
            args.push(`-include${normalizePath(h)}`);
        }
    }

    args.push(isMql4 ? '-D__MQL4_BUILD__' : '-D__MQL5_BUILD__');
    args.push('-c');
    args.push(normalizedPath);

    return {
        directory: normalizePath(workspacePath),
        arguments: args,
        file: normalizedPath
    };
}

/**
 * For all entry-point files, build include chains and emit compile entries
 * for every .mqh file encountered.  When multiple entry points include the
 * same header, the entry providing the most preceding context wins.
 *
 * @param {string[]} entryPointPaths  Absolute paths of .mq4/.mq5 files
 * @param {string[]} sharedFlags      Base compiler flags
 * @param {string} workspacePath      Workspace root
 * @param {string} [includeDir]       External include directory
 * @returns {Promise<Array<{directory: string, arguments: string[], file: string}>>}
 */
async function buildAllHeaderEntries(entryPointPaths, sharedFlags, workspacePath, includeDir) {
    // Map<normalizedHeaderPath, { precedingHeaders: string[], mqlVersion: string }>
    const bestContext = new Map();

    for (const ep of entryPointPaths) {
        const epVersion = pathModule.extname(ep).toLowerCase() === '.mq4' ? 'mql4' : 'mql5';
        const chain = await buildIncludeChain(ep, workspacePath, includeDir);
        for (const [headerNorm, preceding] of chain) {
            const existing = bestContext.get(headerNorm);
            if (!existing || preceding.length > existing.precedingHeaders.length) {
                bestContext.set(headerNorm, { precedingHeaders: preceding, mqlVersion: epVersion });
            }
        }
    }

    const entries = [];
    for (const [headerNorm, ctx] of bestContext) {
        entries.push(buildHeaderCompileEntry(headerNorm, sharedFlags, ctx.precedingHeaders, workspacePath, ctx.mqlVersion));
    }
    return entries;
}

// --- Include-change detection for auto-regeneration ---

/** @type {Map<string, string>} normalizedPath → JSON fingerprint of #include list */
const includeSnapshotCache = new Map();

/**
 * Quick-scan a file for #include directives and return a fingerprint string.
 * @param {string} filePath  Absolute path
 * @returns {Promise<string>} JSON array of include paths (order-preserved), or '' on error
 */
async function snapshotIncludes(filePath) {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return JSON.stringify(parseIncludes(content));
    } catch {
        return '';
    }
}

/**
 * Check whether the #include directives in a file have changed since the
 * last snapshot.  Updates the cache as a side effect.
 * First call for a given file returns false (establishes baseline).
 *
 * @param {string} filePath  Absolute path to the entry-point file
 * @returns {Promise<boolean>} true if includes changed
 */
async function haveIncludesChanged(filePath) {
    const norm = pathModule.normalize(filePath).toLowerCase();
    const current = await snapshotIncludes(filePath);
    const previous = includeSnapshotCache.get(norm);
    includeSnapshotCache.set(norm, current);
    if (previous === undefined) return false; // first check — baseline
    return current !== previous;
}

/**
 * Builds one compile_commands.json entry for a translation unit.
 * Returns null for headers so clangd can fall back to inferred commands.
 * @param {string} filePath
 * @param {string[]} sharedFlags
 * @param {string} workspacePath
 * @returns {{directory: string, arguments: string[], file: string} | null}
 */
function buildCompileCommandEntry(filePath, sharedFlags, workspacePath) {
    const normalizedFilePath = normalizePath(filePath);
    const ext = pathModule.extname(normalizedFilePath).toLowerCase();

    if (!isTranslationUnitExtension(ext)) {
        return null;
    }

    const args = ['clang++'];
    const flags = Array.isArray(sharedFlags) ? sharedFlags : [];

    flags.forEach(flag => {
        if (!flag) {
            return;
        }

        if (ext === '.mq4' && flag === '-D__MQL5__') {
            args.push('-D__MQL4__');
            return;
        }

        if (ext === '.mq5' && flag === '-D__MQL4__') {
            args.push('-D__MQL5__');
            return;
        }

        args.push(flag);
    });

    args.push(ext === '.mq4' ? '-D__MQL4_BUILD__' : '-D__MQL5_BUILD__');

    // -c tells the driver to compile only (no linking), producing
    // exactly one compiler job. Some clangd versions fail when this is missing.
    args.push('-c');
    args.push(normalizedFilePath);

    return {
        directory: normalizePath(workspacePath),
        arguments: args,
        file: normalizedFilePath
    };
}

/**
 * Generates the portable switch string for MetaEditor commands.
 * Note: Returns the switch without leading space - callers should handle spacing.
 * @param {boolean} portableMode - Whether portable mode is enabled
 * @returns {string} - Empty string or '/portable'
 */
function generatePortableSwitch(portableMode) {
    return portableMode ? '/portable' : '';
}

/**
 * Generates an include flag for the compiler.
 * Uses normalized forward-slash paths for clangd compatibility.
 * @param {string} includePath - The include path
 * @returns {string} - The include flag (e.g., '-I/path/to/include')
 */
function generateIncludeFlag(includePath) {
    const normalized = normalizePath(includePath);
    return `-I${normalized}`;
}

/**
 * Generates the base compiler flags for clangd.
 * These are pure flags without path-dependent includes.
 * @param {Object} options - Optional configuration
 * @param {string} [options.compatHeaderPath] - Path to compatibility header
 * @param {string} [options.workspacePath] - Workspace path for include
 * @param {string} [options.includePath] - Include directory path
 * @returns {string[]} - Array of base compiler flags
 */
function generateBaseFlags(options = {}) {
    const flags = [
        '-xc++',
        '-std=c++17',
        '-D__MQL__',
        '-D__MQL5__',
        '-fms-extensions',
        '-fms-compatibility',
        '-ferror-limit=0',
        '-Wno-invalid-token-paste',
        '-Wno-unused-value',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',
        '-Xclang', '-Wno-invalid-pp-directive',
        '-Wno-unknown-directives',
        '-Wno-language-extension-token'
    ];

    // Add optional path-dependent flags
    if (options.compatHeaderPath) {
        flags.splice(4, 0, `-include${options.compatHeaderPath}`);
    }
    if (options.workspacePath) {
        flags.push(`-I${normalizePath(options.workspacePath)}`);
    }
    if (options.includePath) {
        flags.push(`-I${normalizePath(options.includePath)}`);
    }

    return flags;
}

/**
 * Generates project-specific flags based on MQL version.
 * Transforms base flags for MQL4 projects (replaces __MQL5__ with __MQL4__).
 * @param {'mql4' | 'mql5'} projectType - The project type
 * @param {string[]} baseFlags - The base flags to transform
 * @returns {string[]} - Array of project-specific flags
 */
function generateProjectFlags(projectType, baseFlags) {
    const flags = [...baseFlags];

    if (projectType === 'mql4') {
        // Replace -D__MQL5__ with -D__MQL4__
        const mql5Index = flags.indexOf('-D__MQL5__');
        if (mql5Index !== -1) {
            flags[mql5Index] = '-D__MQL4__';
        }
        // Add MQL4-specific build flag
        flags.push('-D__MQL4_BUILD__');
    } else if (projectType === 'mql5') {
        // Add MQL5-specific build flag
        flags.push('-D__MQL5_BUILD__');
    }

    return flags;
}

/**
 * Detects the MQL version based on folder path and/or file extension.
 * Priority: file extension > folder path.
 * @param {string} folderPath - The folder path to check (optional)
 * @param {string} fileName - The file name to check (optional)
 * @returns {'mql4' | 'mql5' | null} - The detected MQL version or null if not determinable
 */
function detectMqlVersion(folderPath, fileName) {
    // Check file extension first (higher priority)
    if (fileName) {
        const ext = fileName.toLowerCase();
        if (ext.endsWith('.mq4')) {
            return 'mql4';
        }
        if (ext.endsWith('.mq5')) {
            return 'mql5';
        }
    }

    // Check folder path
    if (folderPath) {
        const upperPath = folderPath.toUpperCase();
        if (upperPath.includes('MQL4')) {
            return 'mql4';
        }
        if (upperPath.includes('MQL5')) {
            return 'mql5';
        }
    }

    // Default to mql5 if we have a path but can't determine version
    if (folderPath || fileName) {
        return 'mql5';
    }

    return null;
}

/**
 * Determines the dominant MQL version for a workspace by examining actual file extensions.
 * Counts .mq4 vs .mq5 files and returns the majority version.
 * Ties (equal counts) default to 'mql5'.
 * Falls back to folder-path heuristic if no translation units exist.
 * @param {Array<{fsPath: string}>} fileUris - Array of objects with fsPath property
 * @param {string} workspacePath - The workspace folder path (used as fallback)
 * @param {string} workspaceName - The workspace folder name (used as fallback)
 * @returns {'mql4' | 'mql5'}
 */
function detectWorkspaceMqlVersion(fileUris, workspacePath, workspaceName) {
    let mq4Count = 0;
    let mq5Count = 0;

    for (const uri of fileUris) {
        const ext = pathModule.extname(uri.fsPath).toLowerCase();
        if (ext === '.mq4') mq4Count++;
        else if (ext === '.mq5') mq5Count++;
    }

    if (mq4Count > mq5Count) return 'mql4';
    if (mq5Count > 0) return 'mql5';           // includes tie — mql5 wins
    // mq4Count === 0 && mq5Count === 0 → fall through to path heuristic

    // Fallback to path-based detection when no .mq4/.mq5 files exist
    if (workspaceName && workspaceName.toUpperCase().includes('MQL4')) return 'mql4';
    if (workspacePath && workspacePath.toUpperCase().includes('MQL4')) return 'mql4';
    return 'mql5';
}

/**
 * Merges new flags into existing ones, avoiding duplicates and empty strings.
 * @param {string[]} currentFlags 
 * @param {string[]} newFlags 
 */
function mergeFlags(currentFlags, newFlags) {
    const combined = Array.isArray(currentFlags) ? [...currentFlags] : [];
    const sanitizedNew = newFlags.filter(f => f && typeof f === 'string' && f.trim().length > 0);
    for (const flag of sanitizedNew) {
        if (!combined.includes(flag)) {
            combined.push(flag);
        }
    }
    return combined;
}

/**
 * Safely updates VS Code configuration to avoid errors if settings are not registered.
 * @param {string} section - The configuration section to update
 * @param {any} value - The value to set
 * @param {vscode.ConfigurationTarget} target - The configuration target
 * @param {boolean} [silent=false] - If true, don't log anything on failure
 */
async function safeConfigUpdate(section, value, target, silent = false) {
    const config = vscode.workspace.getConfiguration();
    const info = config.inspect(section);

    // Check if the setting is actually registered by verifying at least one value exists
    // config.inspect() returns an object even for unknown settings, but all values will be undefined
    const isRegistered = info && (
        info.defaultValue !== undefined ||
        info.globalValue !== undefined ||
        info.workspaceValue !== undefined ||
        info.workspaceFolderValue !== undefined ||
        info.defaultLanguageValue !== undefined ||
        info.globalLanguageValue !== undefined ||
        info.workspaceLanguageValue !== undefined ||
        info.workspaceFolderLanguageValue !== undefined
    );

    if (!isRegistered) {
        if (!silent) {
            console.info(`MQL Tools: Optional setting "${section}" not available (extension may not be installed)`);
        }
        return;
    }

    try {
        await config.update(section, value, target);
    } catch (e) {
        if (!silent) {
            console.error(`MQL Tools: Failed to update "${section}": ${e.message}`);
        }
    }
}

/**
 * Parses an existing .clangd file and extracts diagnostic suppressions.
 * @param {string} clangdFilePath - Path to the .clangd file
 * @returns {Promise<string[]>} - Array of existing suppressions (empty if file doesn't exist or has no suppressions)
 */
async function parseClangdSuppressions(clangdFilePath) {
    try {
        const content = await fs.promises.readFile(clangdFilePath, 'utf8');
        const suppressions = [];
        let inDiagnostics = false;
        let inSuppress = false;

        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('Diagnostics:')) {
                inDiagnostics = true;
                continue;
            }
            if (inDiagnostics && trimmed.startsWith('Suppress:')) {
                inSuppress = true;
                continue;
            }
            if (inDiagnostics && trimmed.startsWith('ClangTidy:')) {
                inSuppress = false;
                break;
            }
            if (inSuppress && trimmed.startsWith('- ')) {
                const suppression = trimmed.substring(2).trim();
                if (suppression && !suppression.startsWith('#')) {
                    suppressions.push(suppression);
                }
            }
        }

        return suppressions;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        console.error('MQL Tools: Failed to parse .clangd suppressions', err);
        return [];
    }
}

/**
 * Merges extension-provided suppressions with custom suppressions from file.
 * @param {string[]} newSuppressions - Suppressions provided by the extension
 * @param {string[]} existingSuppressions - Suppressions found in the existing .clangd file
 * @returns {string[]} - Merged suppressions without duplicates
 */
function mergeClangdSuppressions(newSuppressions, existingSuppressions) {
    const newSet = new Set(newSuppressions);
    const merged = [...newSuppressions];

    for (const suppression of existingSuppressions) {
        if (suppression && !newSet.has(suppression)) {
            merged.push(suppression);
            newSet.add(suppression);
        }
    }

    return merged;
}

/**
 * Main function to generate/update workspace properties for clangd.
 * @param {boolean} [force=false] - If true, force overwrite of existing config files
 */
async function CreateProperties(force = false) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return;
    }

    const config = vscode.workspace.getConfiguration();
    const configMql = vscode.workspace.getConfiguration('mql_tools');

    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
        ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
        : vscode.workspace.workspaceFolders[0];

    const workspacepath = workspaceFolder.uri.fsPath;
    const workspaceName = workspaceFolder.name;
    const incPath = pathModule.join(workspacepath, 'Include');

    // Path to MQL compatibility header for clangd
    const extensionPath = pathModule.join(__dirname, '..');
    const compatHeaderPath = normalizePath(pathModule.join(extensionPath, 'files', 'mql_clangd_compat.h'));

    // Scan for translation units FIRST to determine workspace MQL version
    let targetFiles = [];
    try {
        targetFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5}'));
    } catch (err) {
        console.error('MQL Tools: Failed to scan workspace files', err);
    }

    const workspaceVersion = detectWorkspaceMqlVersion(targetFiles, workspacepath, workspaceName);
    const mqlDefine = workspaceVersion === 'mql4' ? '-D__MQL4__' : '-D__MQL5__';

    // Base flags for clangd to improve MQL support.
    const baseFlags = [
        '-xc++',
        '-std=c++17',
        '-D__MQL__',
        mqlDefine,
        `-include${compatHeaderPath}`,
        '-fms-extensions',           // Allow some non-standard C++ (like incomplete arrays)
        '-fms-compatibility',
        '-ferror-limit=0',           // Don't stop at 20 errors
        '-Wno-invalid-token-paste',
        '-Wno-unused-value',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',     // Silences string literal to char* warnings
        '-Xclang', '-Wno-invalid-pp-directive', // Force silence #property errors
        '-Wno-unknown-directives',
        '-Wno-language-extension-token',
        `-I${normalizePath(workspacepath)}`,
        `-I${normalizePath(incPath)}`
    ];

    // Resolve both include dirs for per-file correctness in mixed workspaces
    const inc4Dir = resolvePathRelativeToWorkspace(configMql.Metaeditor.Include4Dir, workspacepath);
    const inc5Dir = resolvePathRelativeToWorkspace(configMql.Metaeditor.Include5Dir, workspacepath);

    function resolveExternalIncFlag(dir) {
        if (!dir || dir.length === 0) return null;
        const sub = pathModule.join(dir, 'Include');
        if (fs.existsSync(sub)) return `-I${normalizePath(sub)}`;
        if (fs.existsSync(dir)) return `-I${normalizePath(dir)}`;
        return null;
    }

    const inc4Flag = resolveExternalIncFlag(inc4Dir);
    const inc5Flag = resolveExternalIncFlag(inc5Dir);
    const primaryIncFlag = workspaceVersion === 'mql4' ? inc4Flag : inc5Flag;

    const arrPath = [...baseFlags];
    if (primaryIncFlag) {
        arrPath.push(primaryIncFlag);
    }

    // Filter stale extension-managed flags before merging.  Pattern-based
    // removal catches old values (e.g. previous Include4Dir paths, old compat
    // header locations) that exact-value checks would miss.
    const currentFlagSet = new Set(arrPath);
    const existingFlags = (config.get('clangd.fallbackFlags') || [])
        .filter(f => {
            if (currentFlagSet.has(f)) return false;          // will be re-added by merge
            if (f === '-D__MQL4__' || f === '-D__MQL5__') return false;
            if (f.startsWith('-include') && f.includes('mql_clangd_compat')) return false;
            return true;
        });
    const mergedFlags = mergeFlags(existingFlags, arrPath);
    await safeConfigUpdate('clangd.fallbackFlags', mergedFlags, vscode.ConfigurationTarget.Workspace);
    // C_Cpp.intelliSenseEngine is optional - silent mode since C++ extension may not be installed
    await safeConfigUpdate('C_Cpp.intelliSenseEngine', 'Disabled', vscode.ConfigurationTarget.Workspace, true);

    // Resolve external include directory for include-chain resolution
    function resolveExternalIncDir(dir) {
        if (!dir || dir.length === 0) return undefined;
        const sub = pathModule.join(dir, 'Include');
        return fs.existsSync(sub) ? sub : (fs.existsSync(dir) ? dir : undefined);
    }
    const resolvedExternalIncDir = resolveExternalIncDir(workspaceVersion === 'mql4' ? inc4Dir : inc5Dir);

    // --- Generate compile_commands.json (reuse targetFiles from version detection scan) ---
    try {
        // 1. Build TU entries (existing behavior)
        const tuEntries = targetFiles
            .map(fileUri => {
                const ext = pathModule.extname(fileUri.fsPath).toLowerCase();
                // Swap external include dir for files mismatching workspace version
                const neededIncFlag = ext === '.mq4' ? inc4Flag : inc5Flag;
                if (neededIncFlag !== primaryIncFlag) {
                    const fileFlags = arrPath.filter(f => f !== primaryIncFlag);
                    if (neededIncFlag) fileFlags.push(neededIncFlag);
                    return buildCompileCommandEntry(fileUri.fsPath, fileFlags, workspacepath);
                }
                return buildCompileCommandEntry(fileUri.fsPath, arrPath, workspacepath);
            })
            .filter(Boolean);

        // 2. Build header entries with -include injection for preceding siblings
        const headerEntries = await buildAllHeaderEntries(
            targetFiles.map(f => f.fsPath),
            arrPath,
            workspacepath,
            resolvedExternalIncDir
        );

        const compileCommands = [...tuEntries, ...headerEntries];

        if (compileCommands.length > 0) {
            const dbPath = pathModule.join(workspacepath, 'compile_commands.json');
            await fs.promises.writeFile(dbPath, JSON.stringify(compileCommands, null, 4), 'utf8');

            // Cleanup conflicting files
            const legacyFlags = pathModule.join(workspacepath, 'compile_flags.txt');
            if (fs.existsSync(legacyFlags)) {
                await fs.promises.unlink(legacyFlags).catch(() => { });
            }
        }

        // Populate include snapshot cache for change detection
        for (const fileUri of targetFiles) {
            const snapshot = await snapshotIncludes(fileUri.fsPath);
            const norm = pathModule.normalize(fileUri.fsPath).toLowerCase();
            includeSnapshotCache.set(norm, snapshot);
        }
    } catch (err) {
        console.error('MQL Tools: Failed to generate compile_commands.json', err);
    }

    const associations = { '*.mqh': 'cpp', '*.mq4': 'cpp', '*.mq5': 'cpp' };
    await safeConfigUpdate('mql_tools.context', true, vscode.ConfigurationTarget.Workspace);
    await safeConfigUpdate('files.associations', associations, vscode.ConfigurationTarget.Workspace);

    // --- Generate .clangd file for direct diagnostic suppression ---
    try {
        const clangdConfigPath = pathModule.join(workspacepath, '.clangd');
        const preserveSetting = configMql.Clangd?.PreserveSuppressions || 'prompt';
        let shouldPreserve = false;

        if (!force) {
            if (preserveSetting === 'always') {
                shouldPreserve = true;
            } else if (preserveSetting === 'never') {
                shouldPreserve = false;
            } else {
                const existingFile = fs.existsSync(clangdConfigPath);
                if (existingFile) {
                    const choice = await vscode.window.showWarningMessage(
                        'An existing .clangd file was found. Do you want to preserve your custom diagnostic suppressions?',
                        'Merge Suppressions',
                        'Overwrite',
                        'Configure...'
                    );
                    if (choice === 'Configure...') {
                        await vscode.commands.executeCommand(
                            'workbench.action.openSettings',
                            'mql_tools.Clangd.PreserveSuppressions'
                        );
                        // Don't modify the file when user chooses to configure
                        return;
                    }
                    shouldPreserve = choice === 'Merge Suppressions';
                }
            }
        }

        const baseSuppressions = [
            'pp_file_not_found',
            'err_pp_file_not_found',
            'err_cannot_open_file',
            'unsupported_encoding',
            'unsupported_bom',
            'bad_cxx_cast_generic',
            'lexing_error',
            'character_too_large',
            'pp_invalid_directive',
            'unknown_directive',
            'pp_import_directive_ms',
            'typecheck_incomplete_array_needs_initializer',
            'illegal_decl_array_of_references',
            'typecheck_subscript_not_integer',
            'flexible_array_not_at_end',
            'typecheck_invalid_operands',
            'typecheck_convert_incompatible_pointer',
            'typecheck_invalid_lvalue_addrof',
            'increment_decrement_enum',
            'init_conversion_failed',
            'reference_bind_drops_quals',
            'lvalue_reference_bind_to_temporary',
            'err_lvalue_reference_bind_to_unrelated',
            'ovl_no_conversion_in_cast',
            'ovl_no_viable_conversion_in_cast',
            'ovl_no_viable_function_in_call',
            'ovl_no_viable_function_in_init',
            'ovl_no_viable_member_function_in_call',
            'ovl_diff_return_type',
            'ovl_ambiguous_call',
            'ovl_ambiguous_conversion',
            'ovl_ambiguous_conversion_in_cast',
            'ovl_ambiguous_oper_binary',
            'ovl_ambiguous_oper_unary',
            'ambig_derived_to_base_conv',
            'ovl_deleted_special_init',
            'ovl_no_viable_subscript',
            'error_subscript_overload',
            'missing_default_ctor',
            'ctor_conv_to_void_ptr',
            'member_init_from_this',
            'mem_init_not_member_or_class',
            'uninitialized_member_in_ctor',
            'access_dtor',
            'allocation_of_abstract_type',
            'incomplete_base_class',
            'function_marked_override_not_overriding',
            'undeclared_var_use',
            'undeclared_var_use_suggest',
            'redefinition',
            'param_default_argument_redefinition',
            'bad_parameter_name_template_id',
            'non-pod-varargs',
            'duplicate_case',
            'writable-strings',
            'conditional_ambiguous',
            'err_typecheck_member_reference_suggestion',
            'invalid_non_static_member_use',
            'err_field_incomplete_or_sizeless',
            'new_incomplete_or_sizeless_type',
            'sizeof_alignof_incomplete_or_sizeless_type',
            'err_typecheck_bool_condition',
            'err_typecheck_ambiguous_condition',
            'tautological-constant-out-of-range-compare',
            'unknown_typename',
            'no_template',
            'no_template_suggest',
            'unknown_type_or_class_name_suggest',
            'ref_non_value',
            'expected_lparen_after_type',
            'invalid_token_after_toplevel_declarator',
            'expected_unqualified_id',
            'unexpected_unqualified_id',
            'expected_param_declarator',
            'missing_param',
            'expected_type',
            'typename_requires_specqual',
            'unexpected_typedef',
            'expected_class_name',
            'template_missing_args',
            'member_with_template_arguments',
            'missing_type_specifier',
            'expected_semi_decl_list',
            'member_redeclared',
            'expected_after',
            'extraneous_closing_brace',
            'expected_qualified_after_typename',
            'override_keyword_only_allowed_on_virtual_member_functions',
            'auto_not_allowed',
            'invalid_decl_spec_combination',
            'expected_fn_body',
            'typename_nested_not_found',
            'member_function_call_bad_type',
            'member_call_without_object',
            'typecheck_unary_expr',
            'typecheck_convert_incompatible',
            'typecheck_member_reference_struct_union',
            'typecheck_nonviable_condition',
            'typecheck_call_too_many_args_at_most',
            'typecheck_call_too_many_args_suggest',
            'typecheck_call_too_few_args_at_least',
            'typecheck_call_too_few_args_suggest',
            'base_class_has_flexible_array_member',
            'flexible_array_has_nontrivial_dtor',
            'unknown_typename_suggest',
            'impcast_complex_scalar',
            'ovl_no_viable_oper',
            'ovl_ambiguous_member_call',
            'typecheck_subscript_value',
            'ovl_ambiguous_init',
            'reference_bind_failed',
            'typecheck_call_too_many_args',
            'typecheck_call_too_few_args_at_least_one',
            'excess_initializers',
            'typecheck_expression_not_modifiable_lvalue',
            'incomplete_member_access',
            'incomplete_type',
            'typecheck_incomplete_tag',
            'constructor_return_type',
            'destructor_return_type',
            'pp_including_mainfile_in_preamble',
            'pp_include_too_deep',
            'expected_expression',
            'constructor_redeclared',
            'bound_member_function',
            'static_out_of_line',
            'no_member_suggest',
            'no_member',
            'expected',
            'err_member_reference_needs_call',
            'member_reference_needs_call',
            'expected_arrow_after_this',
            'err_expected_arrow_after_this',
            'extraneous_token_before_semi',
            'expected_semi_after_expr',
            // Alglib / Standard Library false positives (stub mismatches)
            'member_def_does_not_match_ret_type',
            'member_decl_does_not_match',
            'ovl_no_oper',
            // MQL const semantics differ from C++ - const params can be reassigned
            'typecheck_assign_const',
            // Clangd driver error when compile command produces multiple jobs
            'fe_expected_compiler_job'
        ];

        let finalSuppressions = baseSuppressions;
        if (shouldPreserve && fs.existsSync(clangdConfigPath)) {
            const existingSuppressions = await parseClangdSuppressions(clangdConfigPath);
            finalSuppressions = mergeClangdSuppressions(baseSuppressions, existingSuppressions);
        }

        const suppressionsYaml = finalSuppressions.map(s => `    - ${s}`).join('\n');

        const clangdConfig =
            `# MQL Clangd Configuration
# Auto-generated by MQL Clangd extension
# This file suppresses false-positive errors from clangd for MQL-specific syntax
#
# ============================================================================
# TO SUPPRESS ADDITIONAL WARNINGS:
# Add warning flags to the Suppress list below. Examples:
#   - -Wparentheses          # "Possible assignment in condition"
#   - -Wunused-variable      # Unused variable warnings
#   - -Wunused-parameter     # Unused parameter warnings
#
# Or use inline pragmas in your code:
#   #pragma clang diagnostic ignored "-Wparentheses"
# ============================================================================

Diagnostics:
  Suppress:
${suppressionsYaml}

  ClangTidy:
    Remove:
      - modernize-*
      - cppcoreguidelines-*
      - readability-identifier-naming
      - bugprone-narrowing-conversions
      - cert-*
      - hicpp-*
      - performance-*
      - google-*
    
Hover:
    ShowAKA: No

CompileFlags:
  Add:
    # Suppress all warnings in .clangd config; targeted -Wno-* flags are already set in baseFlags
    - -Wno-everything

InlayHints:
  Enabled: Yes
  ParameterNames: Yes
  DeducedTypes: Yes
`;
        await fs.promises.writeFile(clangdConfigPath, clangdConfig, 'utf8');
    } catch (err) {
        console.error('MQL Tools: Failed to generate .clangd', err);
    }

    // --- Generate .clang-format file for MQL-friendly formatting ---
    try {
        const clangFormatPath = pathModule.join(workspacepath, '.clang-format');
        const clangFormatMarker = '# MQL Clang-Format Configuration (generated)';
        const clangFormatConfig =
            `# MQL Clang-Format Configuration (generated)
# Auto-generated by MQL Clangd extension
# Prevents clang-format from breaking MQL-specific syntax like #property directives

BasedOnStyle: LLVM
Language: Cpp

# Indentation
IndentWidth: 4
TabWidth: 4
UseTab: Never

# Line length - reasonable for MQL code
ColumnLimit: 0

# Preprocessor formatting - CRITICAL for MQL #property directives
# Setting to None prevents clang-format from adding backslash line continuations
IndentPPDirectives: None

# Keep original line breaks where possible
BreakBeforeBraces: Attach
AllowShortFunctionsOnASingleLine: None
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false

# Pointer and reference alignment
PointerAlignment: Left
ReferenceAlignment: Left

# Spacing
SpaceAfterCStyleCast: false
SpaceBeforeParens: ControlStatements
SpacesInParentheses: false

# Include sorting - disabled to preserve MQL include order
SortIncludes: Never
`;

        // Check if file exists and preserve user config
        try {
            await fs.promises.access(clangFormatPath);
            // File exists, read it to check for MQL marker
            const existingConfig = await fs.promises.readFile(clangFormatPath, 'utf8');

            // Only overwrite if the file contains our marker or force flag is set
            if (existingConfig.includes(clangFormatMarker) || force) {
                await fs.promises.writeFile(clangFormatPath, clangFormatConfig, 'utf8');
                console.log('MQL Tools: .clang-format file updated');
            } else {
                console.log('MQL Tools: Preserving existing user .clang-format configuration');
            }
        } catch (accessErr) {
            // File doesn't exist, create it
            if (accessErr.code === 'ENOENT') {
                await fs.promises.writeFile(clangFormatPath, clangFormatConfig, 'utf8');
                console.log('MQL Tools: .clang-format file created');
            } else {
                throw accessErr;
            }
        }
    } catch (err) {
        console.error('MQL Tools: Failed to generate .clang-format', err);
    }
}

/**
 * Secondary helper to update properties during compilation.
 */
function Cpp_prop(incDir) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;

    const config = vscode.workspace.getConfiguration();
    const editor = vscode.window.activeTextEditor;
    const workspaceFolder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri))
        ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
        : vscode.workspace.workspaceFolders[0];

    const workspacepath = workspaceFolder.uri.fsPath;
    const incPath = pathModule.join(workspacepath, 'Include');

    // Allow ${workspaceFolder} and relative paths in settings.
    const resolvedIncDir = resolvePathRelativeToWorkspace(incDir, workspacepath);

    const extensionPath = pathModule.join(__dirname, '..');
    const compatHeaderPath = normalizePath(pathModule.join(extensionPath, 'files', 'mql_clangd_compat.h'));

    const baseFlags = [
        '-xc++',
        '-std=c++17',
        `-include${compatHeaderPath}`,
        '-fms-extensions',
        '-fms-compatibility',
        '-ferror-limit=0',
        '-Wno-unknown-pragmas',
        '-Wno-writable-strings',
        '-Xclang', '-Wno-invalid-pp-directive',
        '-Wno-unknown-directives',
        `-I${normalizePath(workspacepath)}`,
        `-I${normalizePath(incPath)}`
    ];

    // If user already points to an Include folder, don't append Include/Include.
    // Only add an -I flag if we have a non-empty, valid include directory.
    let arrPath = baseFlags;
    if (resolvedIncDir && typeof resolvedIncDir === 'string' && resolvedIncDir.length > 0) {
        const includeCandidate = pathModule.join(resolvedIncDir, 'Include');
        const includeDirForFlags = (fs.existsSync(includeCandidate)) ? includeCandidate : resolvedIncDir;
        const normalizedIncDir = normalizePath(includeDirForFlags);
        if (normalizedIncDir && normalizedIncDir.length > 0) {
            arrPath = [...baseFlags, `-I${normalizedIncDir}`];
        }
    }

    const existingFlags = config.get('clangd.fallbackFlags') || [];
    const mergedFlags = mergeFlags(existingFlags, arrPath);
    safeConfigUpdate('clangd.fallbackFlags', mergedFlags, vscode.ConfigurationTarget.Workspace);
    // C_Cpp.intelliSenseEngine is optional - silent mode since C++ extension may not be installed
    safeConfigUpdate('C_Cpp.intelliSenseEngine', 'Disabled', vscode.ConfigurationTarget.Workspace, true);
}

module.exports = {
    CreateProperties,
    Cpp_prop,
    normalizePath,
    expandWorkspaceVariables,
    resolvePathRelativeToWorkspace,
    isSourceExtension,
    isTranslationUnitExtension,
    detectMqlVersion,
    detectWorkspaceMqlVersion,
    generateIncludeFlag,
    generateBaseFlags,
    generateProjectFlags,
    generatePortableSwitch,
    buildCompileCommandEntry,
    buildIncludeChain,
    buildHeaderCompileEntry,
    buildAllHeaderEntries,
    haveIncludesChanged,
    includeSnapshotCache,
    parseClangdSuppressions,
    mergeClangdSuppressions,
    safeConfigUpdate
};
