'use strict';

const mqlLogger = require('./logger');
const url = require('url');
const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const pathModule = require('path');

const sleep = require('util').promisify(setTimeout);
const fsPromises = fs.promises;
const { bumpVersionsInFile } = require('./versionBumper');

const REG_COMPILING = /: information: (?:compiling|checking)/;
const REG_INCLUDE = /: information: including/;
const REG_INFO = /: information: info/;
const REG_RESULT = /(?:Result:|: information: result)/;
const REG_ERR_WAR = /(?!0)\d+.(?:error|warning)/;
const REG_RESULT_SHORT = /\d+.error.+/;
const REG_LINE_PATH = /([a-zA-Z]:\\.+(?= :)|^\(\d+,\d+\))(?:.: )(.+)/;
const REG_ERROR_CODE = /(?<=error |warning )\d+/;
const REG_FULL_PATH = /[a-z]:\\.+/gi;
const REG_LINE_POS = /\((?:\d+,\d+)\)$/gm;
const REG_LINE_FRAGMENT = /\((?=(\d+,\d+).$)/gm;
const REG_PROPERTY_VERSION = /^\s*#property\s+version\s+["']([^\r\n"']+)["']/im;

// NOTE: diagnosticCollection and outputChannel are initialized in activate()
let diagnosticCollection = null;
let outputChannel = null;
let autoCheckTimer = null;
let isAutoCheckRunning = false;
let autoCheckDocVersions = new Map(); // Track document versions to ignore our own edits
// Guard to prevent CheckOnSave from re-triggering itself when Compile() saves files.
let internalSaveDepth = 0;
const lg = require('./language');
const { tf } = require('./timeUtils');
const { Help, OfflineHelp } = require('./help');
const { ShowFiles, InsertNameFileMQH, InsertMQH, InsertNameFileMQL, InsertMQL, InsertResource, InsertImport, InsertTime, InsertIcon, OpenFileInMetaEditor, OpenTradingTerminal, CreateComment } = require('./contextMenu');
const { IconsInstallation } = require('./addIcon');
const { ArrangeCharts, createStatusBar } = require('./chartLayout');
const { Hover_log, DefinitionProvider, Hover_MQL, ItemProvider, HelpProvider, ColorProvider, MQLDocumentSymbolProvider, getObjItems, clearSymbolCache, getIncludeDir } = require('./provider');
const { registerLightweightDiagnostics } = require('./lightweightDiagnostics');
const { sweepDbgBuildArtifacts } = require('./tempSweep');
const unresolvedSymbolWatcher = require('./unresolvedSymbolWatcher');
const { CreateProperties, generatePortableSwitch, resolvePathRelativeToWorkspace, haveIncludesChanged } = require('./createProperties');
const { decodeTextBuffer } = require('./textDecoding');
const { resolveCompileTargets, setCompileTargets, resetCompileTargets, markIndexDirty, getCompileTargets } = require('./compileTargetResolver');
const {
    toWineWindowsPath,
    fromWineWindowsPath,
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineTimeout,
    getWineEnv,
    validateWinePath,
    isWineInstalled,
    setOutputChannel: setWineOutputChannel,
    buildWineCmd,
    buildSpawnOptions,
    buildBatchContent,
    createWineBatchFile,
    cleanupBatchFile
} = require('./wineHelper');
const logTailer = require('./logTailer');
const { TradeReportDashboard } = require('./tradeReportDashboard');
const { runBacktest, cancelBacktests } = require('./backtestRunner');
const {
    bridge: debugBridge,
    COMPILE_MODE_CHECK,
    COMPILE_MODE_COMPILE,
    COMPILE_MODE_SCRIPT
} = require('./debugBridge');
const { MqlDebugAdapter } = require('./debugAdapter');
const { store: debugStore } = require('./debugStateStore');
const { registerDebugCodeLens } = require('./debugCodeLens');
const { reportNoisyDiagnostic } = require('./noisyDiagnostic');
const { showStartupPage } = require('./startupPage');


// =============================================================================
// SPELLCHECK INDEX - Lazy-loaded dictionary for typo detection
// =============================================================================

let spellcheckIndex = null;

/**
 * Build and cache the spellcheck index from items.json
 * Filters to group=2 (functions) and indexes by first character for fast lookup
 * @returns {{ byFirstChar: Object<string, string[]>, all: Set<string> }}
 */
function getSpellcheckIndex() {
    if (spellcheckIndex) return spellcheckIndex;

    const byFirstChar = {};
    const all = new Set();
    const items = getObjItems();

    for (const name in items) {
        // Only include functions (group 2) with reasonable length
        if (items[name].group === 2 && name.length >= 3) {
            all.add(name);
            const firstChar = name[0].toUpperCase();
            if (!byFirstChar[firstChar]) byFirstChar[firstChar] = [];
            byFirstChar[firstChar].push(name);
        }
    }

    spellcheckIndex = { byFirstChar, all };
    return spellcheckIndex;
}

/**
 * Bounded Levenshtein distance with early termination
 * @param {string} a - First string
 * @param {string} b - Second string
 * @param {number} maxDist - Maximum distance threshold
 * @returns {number} Distance if <= maxDist, otherwise Infinity
 */
function levenshteinBounded(a, b, maxDist) {
    const lenA = a.length, lenB = b.length;

    // Quick length check - if lengths differ by more than threshold, skip
    if (Math.abs(lenA - lenB) > maxDist) return Infinity;

    // Handle edge cases
    if (lenA === 0) return lenB <= maxDist ? lenB : Infinity;
    if (lenB === 0) return lenA <= maxDist ? lenA : Infinity;

    // Single row DP (space optimized O(min(m,n)))
    // Ensure we iterate over the shorter string for the inner loop
    const [shorter, longer] = lenA < lenB ? [a, b] : [b, a];
    const shortLen = shorter.length, longLen = longer.length;

    let row = Array.from({ length: shortLen + 1 }, (_, i) => i);

    for (let i = 1; i <= longLen; i++) {
        let prev = i;
        let minInRow = prev;

        for (let j = 1; j <= shortLen; j++) {
            const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
            const curr = Math.min(
                row[j] + 1,       // deletion
                prev + 1,         // insertion
                row[j - 1] + cost // substitution
            );
            row[j - 1] = prev;
            prev = curr;
            minInRow = Math.min(minInRow, curr);
        }
        row[shortLen] = prev;

        // Early exit: if minimum in this row > maxDist, we can't reach target
        if (minInRow > maxDist) return Infinity;
    }

    return row[shortLen] <= maxDist ? row[shortLen] : Infinity;
}

/**
 * Find closest matches for a misspelled word
 * @param {string} word - The misspelled word
 * @param {number} maxDist - Maximum edit distance (default: 2)
 * @param {number} maxResults - Maximum number of results (default: 3)
 * @returns {Array<{name: string, distance: number}>} Sorted by distance
 */
function findClosestMatches(word, maxDist = 2, maxResults = 3) {
    if (word.length < 3) return []; // Too short to reliably match

    const index = getSpellcheckIndex();
    const candidates = [];

    // First, check if it's already a valid function name
    if (index.all.has(word)) return [];

    // Strategy 1: Check words starting with same letter (most common typo pattern)
    const firstChar = word[0].toUpperCase();
    const primaryCandidates = index.byFirstChar[firstChar] || [];

    for (const name of primaryCandidates) {
        // Pre-filter by length difference
        if (Math.abs(name.length - word.length) > maxDist) continue;

        const dist = levenshteinBounded(word.toLowerCase(), name.toLowerCase(), maxDist);
        if (dist !== Infinity) {
            candidates.push({ name, distance: dist });
        }
    }

    // Strategy 2: If no matches found, check adjacent letters (handles first-char typos)
    if (candidates.length === 0 && word.length >= 4) {
        const firstCharCode = firstChar.charCodeAt(0);
        const adjacentChars = [
            String.fromCharCode(firstCharCode - 1),
            String.fromCharCode(firstCharCode + 1)
        ].filter(c => c >= 'A' && c <= 'Z');

        for (const altChar of adjacentChars) {
            const altCandidates = index.byFirstChar[altChar] || [];
            for (const name of altCandidates) {
                if (Math.abs(name.length - word.length) > maxDist) continue;
                const dist = levenshteinBounded(word.toLowerCase(), name.toLowerCase(), maxDist);
                if (dist !== Infinity) {
                    candidates.push({ name, distance: dist });
                }
            }
        }
    }

    // Sort by distance (prefer closer matches), then alphabetically
    candidates.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

    return candidates.slice(0, maxResults);
}


// =============================================================================
// CLANGD DIAGNOSTICS REFRESH
// =============================================================================

// Set when CreateProperties rewrote compile_commands.json or .clangd. The next
// finished compile then restarts clangd once (see refreshClangdDiagnostics) and
// clears the flag. A plain compile changes none of clangd's inputs.
let clangdNeedsRestart = false;

/**
 * Run CreateProperties and track whether clangd inputs changed.
 * All CreateProperties call sites go through this wrapper so the flag is
 * reliable no matter which path regenerated the database.
 */
async function regenerateProperties(force = false) {
    const status = await CreateProperties(force);
    if (status && status.changed) {
        clangdNeedsRestart = true;
    }
    return status;
}

/**
 * Refresh clangd diagnostics after compilation.
 *
 * This function restarts the clangd language server so it re-reads the
 * updated compile_commands.json. Then it "touches" open MQL documents to
 * trigger clangd to re-analyze them. After that, it restores the MQL
 * diagnostics that were set by the MetaEditor compiler.
 *
 * Only called when clangd's inputs actually changed (clangdNeedsRestart):
 * restarting clangd and synthesizing space insert/delete edits in every
 * visible editor after each compile disturbed typing for no benefit.
 */
async function refreshClangdDiagnostics() {
    try {
        // Step 1: Save all current MQL diagnostics before touching documents
        const savedDiagnostics = new Map();
        diagnosticCollection.forEach((uri, diagnostics) => {
            if (diagnostics.length > 0) {
                savedDiagnostics.set(uri.toString(), [...diagnostics]);
            }
        });

        // Step 2: Restart clangd language server
        await vscode.commands.executeCommand('clangd.restart');
        // Step 3: Wait for clangd to initialize
        await sleep(1000);

        // Step 4: Touch all open MQL documents to trigger clangd re-analysis
        const mqlExtensions = ['.mq4', '.mq5', '.mqh'];
        const openMqlDocuments = vscode.workspace.textDocuments.filter(doc => {
            const ext = pathModule.extname(doc.fileName).toLowerCase();
            return mqlExtensions.includes(ext) && !doc.isClosed;
        });

        const editedDocs = [];
        for (const doc of openMqlDocuments) {
            const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
            if (editor) {
                // Prevent our own synthetic edits from triggering AutoCheck.
                // We do exactly two edits (insert + delete), so pre-mark the next 2 versions.
                autoCheckDocVersions.set(doc.uri.toString(), doc.version + 2);

                const lastLine = doc.lineCount - 1;
                const lastChar = doc.lineAt(lastLine).text.length;
                const endPosition = new vscode.Position(lastLine, lastChar);

                // Insert and remove a space to trigger didChange
                await editor.edit(editBuilder => {
                    editBuilder.insert(endPosition, ' ');
                }, { undoStopBefore: false, undoStopAfter: false });

                await editor.edit(editBuilder => {
                    editBuilder.delete(new vscode.Range(endPosition, new vscode.Position(lastLine, lastChar + 1)));
                }, { undoStopBefore: false, undoStopAfter: false });

                editedDocs.push(doc);
            }
        }

        // Step 5: Save edited documents to clear dirty state caused by synthetic edits
        if (editedDocs.length > 0) {
            internalSaveDepth++;
            try {
                for (const doc of editedDocs) {
                    await doc.save();
                }
            } finally {
                internalSaveDepth = Math.max(0, internalSaveDepth - 1);
            }
        }

        // Step 6: Restore MQL diagnostics
        await sleep(100); // Small delay to let the edit complete
        savedDiagnostics.forEach((diagnostics, uriString) => {
            const uri = vscode.Uri.parse(uriString);
            diagnosticCollection.set(uri, diagnostics);
        });

    } catch (error) {
        // clangd extension may not be installed - silently ignore
    }
}


/**
 * Build command arguments for MetaEditor on Windows.
 * Returns an object with executable and args array for use with child_process.spawn.
 * MetaEditor requires: /compile:"path" (quotes are part of the argument value)
 *
 * Only processes known MetaEditor flags (/compile:, /log:, /inc:) to avoid corrupting
 * Windows paths like C:\foo. Skips values already wrapped in quotes to avoid double-quoting.
 */
function buildMetaEditorCmd(executable, args) {
    const metaEditorFlags = ['/compile:', '/log:', '/inc:'];
    const processedArgs = args.map(arg => {
        const matchingFlag = metaEditorFlags.find(flag => arg.toLowerCase().startsWith(flag));
        if (!matchingFlag) {
            return arg;
        }
        const value = arg.substring(matchingFlag.length);
        if (value.startsWith('"') && value.endsWith('"')) {
            return arg;
        }
        // Strip trailing backslashes to prevent \" ambiguity when the closing quote
        // immediately follows a backslash (e.g., /inc:"C:\dir\"). Windows APIs handle
        // directory paths identically with or without trailing separators.
        const safeValue = value.replace(/\\+$/, '');
        return `${matchingFlag}"${safeValue}"`;
    });
    return { executable, args: processedArgs };
}

/**
 * Infers the MQL data folder (the one containing Include/, Experts/, Logs/, …)
 * by walking up the directory tree from the given source file path.
 *
 * This mirrors the heuristic used by LogTailer.inferDataFolder() but works
 * directly on a file path rather than reading from the active editor, so it
 * can be called during headless compilation (e.g. from compilePath).
 *
 * @param {string} filePath - Absolute path to the MQL source file being compiled
 * @param {boolean} isMql5  - true for MQL5, false for MQL4
 * @returns {string|null}   - Inferred data-folder path, or null if not found
 */
function inferMqlDataDirFromPath(filePath, isMql5) {
    const targetDirName = isMql5 ? 'MQL5' : 'MQL4';
    let current = pathModule.dirname(filePath);
    const root = pathModule.parse(current).root;
    while (current && current !== root) {
        if (pathModule.basename(current).toUpperCase() === targetDirName) {
            if (fs.existsSync(pathModule.join(current, 'Include')) ||
                fs.existsSync(pathModule.join(current, 'Logs'))) {
                return current;
            }
        }
        const parent = pathModule.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

// ---------------------------------------------------------------------------
// CPU Architecture setting for MetaEditor compilation
// ---------------------------------------------------------------------------

/** Mapping of user-facing enum values to the numeric values used in .mqproj files.
 *  0 = X64 Regular, 1 = AVX, 2 = AVX2 + FMA3, 3 = AVX512 + FMA3
 */
const CPU_ARCH_MAP = {
    'x64': 0,
    'avx': 1,
    'avx2': 2,
    'avx512': 3,
};

/**
 * Create a temporary .mqproj file that wraps the source file with a cpu_architecture setting.
 * The project is placed in the same directory as the source file so relative paths work.
 *
 * @param {string} sourcePath - Absolute path to the .mq4/.mq5 source file
 * @param {number} archValue  - Numeric architecture value (0–3)
 * @returns {string} Absolute path to the created temporary .mqproj file
 */
function createTempMqproj(sourcePath, archValue) {
    const sourceDir = pathModule.dirname(sourcePath);
    const sourceBasename = pathModule.basename(sourcePath);
    const ext = pathModule.extname(sourcePath).toLowerCase();
    const isMql4 = ext === '.mq4';

    // Determine program_type from path heuristics
    let programType = 'expert';
    const lower = sourcePath.toLowerCase();
    if (lower.includes('indicator')) programType = 'indicator';
    else if (lower.includes('script')) programType = 'script';
    else if (lower.includes('service')) programType = 'service';
    else if (lower.includes('library')) programType = 'library';

    const project = {
        'platform': isMql4 ? 'mt4' : 'mt5',
        'program_type': programType,
        'optimize': '1',
        'fpzerocheck': '1',
        'cpu_architecture': String(archValue),
        'files': [
            {
                'path': `.\\${sourceBasename}`,
                'compile': 'true',
                'relative_to_project': 'true'
            }
        ]
    };

    const projName = `._mql_clangd_cpu_arch_${Date.now()}.mqproj`;
    const projPath = pathModule.join(sourceDir, projName);

    // MetaEditor expects UTF-16 LE with BOM
    const json = JSON.stringify(project, null, 2);
    const bom = Buffer.from([0xFF, 0xFE]);
    const encoded = Buffer.from(json, 'utf16le');
    fs.writeFileSync(projPath, Buffer.concat([bom, encoded]));

    return projPath;
}

/**
 * Clean up the temporary .mqproj file created by createTempMqproj.
 *
 * @param {string} projPath - Path to the temp .mqproj file
 */
function cleanupTempMqproj(projPath) {
    try {
        if (projPath && fs.existsSync(projPath)) {
            fs.unlinkSync(projPath);
        }
    } catch { /* best effort */ }
}

/**
 * Compile a single file path.
 *
 * @param {number} rt           - Compile mode (COMPILE_MODE_CHECK, COMPILE_MODE_COMPILE, COMPILE_MODE_SCRIPT)
 * @param {string} pathToCompile - Absolute path to the MQL source file
 * @param {object} _context      - VS Code extension context
 * @returns {Promise<boolean|string>} - Returns false/null on success, true for generic compilation
 *                                      errors (logged to output/problems), or a string for specific
 *                                      setup/environment errors.
 */
async function compilePath(rt, pathToCompile, _context) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const fileName = pathModule.basename(pathToCompile);
    const extension = pathModule.extname(pathToCompile).toLowerCase();
    const startT = new Date();
    const time = `${tf(startT, 'h')}:${tf(startT, 'm')}:${tf(startT, 's')}`;
    const propertyVersion = await getPropertyVersionFromFile(pathToCompile);

    let logFile, command, MetaDir, incDir, CommM, CommI, teq, includefile, log, portableMode;

    // Allow ${workspaceFolder} and relative paths in settings.
    const fileUri = vscode.Uri.file(pathToCompile);
    const wsFolder = vscode.workspace.getWorkspaceFolder(fileUri) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const workspaceFolderPath = wsFolder && wsFolder.uri ? wsFolder.uri.fsPath : '';

    let isMql5 = false;

    if (extension === '.mq4') {
        // isMql4
    } else if (extension === '.mq5') {
        isMql5 = true;
    } else if (extension === '.mqh') {
        // Try to determine flavor from resolved targets, falling back to substring check
        const savedTargets = getCompileTargets(fileUri, wsFolder, _context);
        let resolvedFlavor = null;

        if (savedTargets && savedTargets.length > 0) {
            // Check extension of the first target
            const firstTarget = savedTargets[0];
            if (firstTarget.toLowerCase().endsWith('.mq4')) resolvedFlavor = 'mql4';
            else if (firstTarget.toLowerCase().endsWith('.mq5')) resolvedFlavor = 'mql5';
        }

        if (resolvedFlavor === 'mql4') {
            // isMql4
        } else if (resolvedFlavor === 'mql5') {
            isMql5 = true;
        } else {
            // Last-resort fallback
            if (pathToCompile.toLowerCase().includes('mql4')) {
                // isMql4
            } else {
                isMql5 = true; // Default to MQL5
            }
        }
    } else {
        return `Unsupported file extension: ${extension}`;
    }

    if (isMql5) {
        MetaDir = config.Metaeditor.Metaeditor5Dir;
        incDir = config.Metaeditor.Include5Dir;
        portableMode = config.Metaeditor.Portable5;
        CommM = lg['path_editor5'];
        CommI = lg['path_include_5'];
    } else {
        MetaDir = config.Metaeditor.Metaeditor4Dir;
        incDir = config.Metaeditor.Include4Dir;
        portableMode = config.Metaeditor.Portable4;
        CommM = lg['path_editor4'];
        CommI = lg['path_include_4'];
    }

    MetaDir = resolvePathRelativeToWorkspace(MetaDir, workspaceFolderPath);
    incDir = resolvePathRelativeToWorkspace(incDir, workspaceFolderPath);

    // Set teq label based on operation type
    switch (rt) {
        case COMPILE_MODE_CHECK: teq = lg['checking'];
            break;
        case COMPILE_MODE_COMPILE: teq = lg['compiling'];
            break;
        case COMPILE_MODE_SCRIPT: teq = lg['comp_usi_script'];
            break;
    }

    // Early validation - before Promise
    if (!fs.existsSync(MetaDir)) {
        vscode.window.showErrorMessage(CommM);
        return CommM;
    }

    if (incDir && !fs.existsSync(incDir)) {
        vscode.window.showErrorMessage(CommI);
        return CommI;
    }

    const portableSwitch = generatePortableSwitch(portableMode);

    // CPU architecture is resolved here, but the metaeditor.ini mutation is deferred to
    // immediately before spawn (and wrapped in a try/finally + mutex) so that any early
    // return between here and the spawn cannot leak a mutated INI.
    const cpuArchSetting = isMql5 ? config.Compile?.CpuArchitecture : 'default';
    const cpuArchActive = cpuArchSetting && cpuArchSetting !== 'default' && CPU_ARCH_MAP[cpuArchSetting] !== undefined;

    // Strategy: Place the log file directly next to the source file.
    // MetaEditor creates log files without the source extension (e.g., SMC.log, not SMC.mq5.log)
    const baseName = pathModule.basename(pathToCompile, extension);
    logFile = pathModule.join(pathModule.dirname(pathToCompile), `${baseName}.log`);


    // Check if Wine is enabled (macOS/Linux with Wine wrapper)
    const useWine = isWineEnabled(config);
    const wineBinary = getWineBinary(config);
    const winePrefix = getWinePrefix(config);

    // Wine-specific validation
    if (useWine) {
        // Validate MetaEditor path format (must be Unix path, not Windows path)
        const pathValidation = validateWinePath(MetaDir);
        if (!pathValidation.valid) {
            const wineErr = `Wine Configuration Error: ${pathValidation.error}`;
            vscode.window.showErrorMessage(wineErr);
            return wineErr;
        }

        // When no Include dir is configured, try to infer the MQL data folder
        // by walking up from the source file (looks for MQL5/MQL4 dir with Include/ or Logs/).
        // MetaEditor CLI needs an explicit /inc: flag to locate user headers on Wine/Linux;
        // without it, it only searches its own installation Include directory.
        if (!incDir) {
            const inferred = inferMqlDataDirFromPath(pathToCompile, isMql5);
            if (inferred) {
                outputChannel.appendLine(`[Wine] Include${isMql5 ? '5' : '4'}Dir not configured; auto-inferred data folder: ${inferred}`);
                incDir = inferred;
            }
        }
    }

    // Build command arguments - convert paths if using Wine (async, done before Promise)
    let compileArg, logArg, incArg;
    if (useWine) {
        // Convert Unix paths to Windows paths via winepath
        const compileResult = await toWineWindowsPath(pathToCompile, wineBinary, winePrefix);
        const logResult = await toWineWindowsPath(logFile, wineBinary, winePrefix);

        if (!compileResult.success) {
            outputChannel.appendLine(`[Wine] Path conversion failed for compile path '${pathToCompile}'; using original path as fallback`);
            compileArg = pathToCompile;
        } else {
            compileArg = compileResult.path;
        }

        if (!logResult.success) {
            outputChannel.appendLine(`[Wine] Path conversion failed for log path '${logFile}'; using original path as fallback`);
            logArg = logFile;
        } else {
            logArg = logResult.path;
        }

        if (incDir) {
            const incResult = await toWineWindowsPath(incDir, wineBinary, winePrefix);
            if (!incResult.success) {
                outputChannel.appendLine(`[Wine] Path conversion failed for include path '${incDir}'; using original path as fallback`);
                incArg = incDir;
            } else {
                incArg = incResult.path;
            }
        } else {
            incArg = '';
        }
    } else {
        compileArg = pathToCompile;
        logArg = logFile;
        incArg = incDir || '';
    }

    includefile = incArg ? `/inc:"${incArg}"` : '';

    // Build command based on Wine mode
    let execArgs;
    let metaEditorWinPath;
    let batFile = null;

    if (useWine) {
        // Convert MetaEditor path to Windows path for cmd /c
        // We do this here (after other conversions) to ensure we have it for buildWineCmd
        const metaResult = await toWineWindowsPath(MetaDir, wineBinary, winePrefix);
        if (!metaResult.success) {
            const wineMetaErr = `[Wine] MetaEditor path conversion failed: ${metaResult.error}`;
            outputChannel.appendLine(wineMetaErr);
            return wineMetaErr;
        }
        metaEditorWinPath = metaResult.path;

        // Wine mode: routes through cmd /c handles path quoting
        const metaArgs = [`/compile:"${compileArg}"`, `/log:"${logArg}"`];
        if (includefile) metaArgs.push(includefile);
        if (portableSwitch) metaArgs.push(portableSwitch);

        try {
            const batContent = buildBatchContent(metaEditorWinPath, metaArgs);
            batFile = await createWineBatchFile(batContent, wineBinary, winePrefix);
        } catch (batchErr) {
            outputChannel.appendLine(`[Error] Failed to create Wine batch file: ${batchErr.message}`);
            vscode.window.showErrorMessage(`Wine compilation setup failed: ${batchErr.message}`);
            return batchErr.message || String(batchErr);
        }
        const wineCmd = buildWineCmd(wineBinary, batFile.winPath);
        command = wineCmd.executable;
        execArgs = wineCmd.args;
    } else {
        // Direct execution (Windows)
        // Paths are quoted by buildMetaEditorCmd() before spawn; windowsVerbatimArguments
        // ensures Node.js passes them through without re-escaping (fixes #6).
        execArgs = [`/compile:${pathToCompile}`, `/log:${logFile}`];
        if (incDir) execArgs.push(`/inc:${incDir}`);
        if (portableSwitch) execArgs.push(portableSwitch);
        command = MetaDir;
    }

    const runCompile = () => new Promise((resolve) => {

        // Common handler for processing compilation results
        const handleCompilationResult = async (launchError, stderror) => {
            if (stderror) {
                outputChannel.appendLine(`[Warning] Stderr: ${stderror}`);
            }

            // Clean up temporary batch file (Wine mode only)
            if (useWine && batFile) {
                cleanupBatchFile(batFile.unixPath);
            }
            // CPU architecture restoration is handled in the spawn try/finally, not here.

            let data;
            try {
                // Retry loop: Log file creation might be delayed.
                // MetaEditor sometimes takes a moment to flush the file.
                let attempts = 0;
                while (attempts < 30) { // Wait up to 3 seconds
                    if (fs.existsSync(logFile)) {
                        // Small grace period to ensure write completion
                        if (attempts > 0) await sleep(50);
                        break;
                    }
                    await sleep(100);
                    attempts++;
                }

                if (!fs.existsSync(logFile)) {
                    if (launchError) {
                        outputChannel.appendLine(`[Error] Launch error: ${launchError.message || launchError}`);
                    }
                    throw new Error(`Log file not found at: ${logFile}`);
                }

                data = await fsPromises.readFile(logFile, 'ucs-2');
            } catch (err) {
                const readErr = `${lg['err_read_log']} ${err.message}`;
                outputChannel.appendLine(`[Error] Failed to read log file: ${err.message}`);
                vscode.window.showErrorMessage(readErr);
                return resolve(readErr);
            }

            config.LogFile.DeleteLog && fs.unlink(logFile, (err) => {
                err && vscode.window.showErrorMessage(lg['err_remove_log']);
            });

            // Pass the Wine prefix so replaceLog can convert Windows paths from
            // MetaEditor output to valid Linux paths when running under Wine.
            log = replaceLog(data, rt === COMPILE_MODE_CHECK, useWine ? winePrefix : '');

            // Publish MetaEditor diagnostics to the Problems panel
            if (log.diagnostics.length > 0) {
                const diagnosticsMap = new Map();
                for (const diag of log.diagnostics) {
                    const uri = vscode.Uri.file(diag.file);
                    if (!diagnosticsMap.has(uri.toString())) {
                        diagnosticsMap.set(uri.toString(), []);
                    }
                    const diagnostic = new vscode.Diagnostic(diag.range, diag.message, diag.severity);
                    if (diag.errorCode) {
                        diagnostic.code = {
                            value: `MQL${diag.errorCode}`,
                            target: vscode.Uri.parse('https://www.mql5.com/en/docs/runtime/errors')
                        };
                    }
                    diagnosticsMap.get(uri.toString()).push(diagnostic);
                }
                for (const [uriString, diags] of diagnosticsMap) {
                    diagnosticCollection.set(vscode.Uri.parse(uriString), diags);
                }
            }

            const endT = new Date();
            const timeCompile = (endT - startT) / 1000;
            const targetLabel = formatCompileTargetLabel(fileName, propertyVersion);

            const cpuArchTag = cpuArchActive ? ` [${cpuArchSetting.toUpperCase()}]` : '';
            outputChannel.appendLine(`[${time}] ${teq} ${targetLabel}${cpuArchTag} [${timeCompile}s]`);

            if (rt === COMPILE_MODE_SCRIPT && !log.error) {
                if (useWine) {
                    try {
                        const wineEnv = getWineEnv(config);
                        // Use the already converted metaEditorWinPath
                        const rt2Args = [`/compile:"${compileArg}"`];
                        const rt2BatContent = buildBatchContent(metaEditorWinPath, rt2Args);
                        const rt2BatFile = await createWineBatchFile(rt2BatContent, wineBinary, winePrefix);
                        const wineCmd = buildWineCmd(wineBinary, rt2BatFile.winPath);

                        childProcess.spawn(wineCmd.executable, wineCmd.args, buildSpawnOptions({ env: wineEnv }))
                            .on('error', (error) => {
                                const startErr = `${lg['err_start_script']}: ${error.message}`;
                                outputChannel.appendLine(`[Error]  ${startErr}`);
                                cleanupBatchFile(rt2BatFile.unixPath);
                                resolve(startErr);
                            })
                            .on('close', () => {
                                outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                                cleanupBatchFile(rt2BatFile.unixPath);
                                resolve(false);
                            });
                    } catch (batchErr) {
                        const batchFailErr = `Failed to create Wine batch file for script execution: ${batchErr.message}`;
                        outputChannel.appendLine(`[Error] ${batchFailErr}`);
                        resolve(batchFailErr);
                    }
                } else {
                    // Direct execution on Windows – windowsVerbatimArguments keeps quotes intact (fixes #6)
                    const { executable, args } = buildMetaEditorCmd(MetaDir, [`/compile:${compileArg}`]);
                    childProcess.spawn(executable, args, { shell: false, windowsVerbatimArguments: true })
                        .on('error', (error) => {
                            const startErr = `${lg['err_start_script']}: ${error.message}`;
                            outputChannel.appendLine(`[Error]  ${startErr}`);
                            resolve(startErr);
                        })
                        .on('close', () => {
                            outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                            resolve(false);
                        });
                }
            } else {
                outputChannel.appendLine(String(log.text));
                resolve(log.error);
            }
        };

        // Execute compilation command
        let proc;
        if (useWine) {
            proc = childProcess.spawn(command, execArgs, buildSpawnOptions({ env: getWineEnv(config) }));
        } else {
            // Windows: windowsVerbatimArguments prevents Node.js from re-escaping the
            // quotes that buildMetaEditorCmd() adds around path values (fixes #6).
            const { executable, args } = buildMetaEditorCmd(command, execArgs);
            proc = childProcess.spawn(executable, args, buildSpawnOptions());
        }
        let stderrData = '';
        let timeoutId = null;

        // Set up timeout for Wine processes
        if (useWine) {
            const wineTimeout = getWineTimeout(config);
            timeoutId = setTimeout(() => {
                outputChannel.appendLine(`[Wine] Compilation timed out after ${wineTimeout / 1000} seconds. Killing process...`);
                proc.kill('SIGTERM');
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill('SIGKILL');
                    }
                }, 2000);
            }, wineTimeout);
        }

        const clearWineTimeout = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        proc.stderr.on('data', (data) => { stderrData += data.toString(); });
        proc.on('error', (err) => {
            clearWineTimeout();
            handleCompilationResult(err, stderrData);
        });
        proc.on('close', (code) => {
            clearWineTimeout();
            handleCompilationResult(code !== 0 ? `Process exited with code ${code}` : null, stderrData);
        });
    });

    if (!cpuArchActive) {
        return runCompile();
    }

    // CPU architecture override: create a temporary .mqproj with cpu_architecture set,
    // compile via /compile:<project.mqproj>, then clean up.
    const archValue = CPU_ARCH_MAP[cpuArchSetting];
    let tempProjPath = null;
    try {
        tempProjPath = createTempMqproj(pathToCompile, archValue);
        outputChannel.appendLine(`[CPU] Created temp project with cpu_architecture=${archValue} (${cpuArchSetting}): ${tempProjPath}`);

        // Override compileArg to point at the temp project instead of the source file.
        // We must rebuild the command arguments with the project path.
        if (useWine) {
            const projResult = await toWineWindowsPath(tempProjPath, wineBinary, winePrefix);
            const projWinPath = projResult.success ? projResult.path : tempProjPath;
            const metaArgs = [`/compile:"${projWinPath}"`, `/log:"${logArg}"`];
            if (includefile) metaArgs.push(includefile);
            if (portableSwitch) metaArgs.push(portableSwitch);
            const batContent = buildBatchContent(metaEditorWinPath, metaArgs);
            batFile = await createWineBatchFile(batContent, wineBinary, winePrefix);
            const wineCmd = buildWineCmd(wineBinary, batFile.winPath);
            command = wineCmd.executable;
            execArgs = wineCmd.args;
        } else {
            execArgs = [`/compile:${tempProjPath}`, `/log:${logFile}`];
            if (incDir) execArgs.push(`/inc:${incDir}`);
            if (portableSwitch) execArgs.push(portableSwitch);
            command = MetaDir;
        }

        return await runCompile();
    } finally {
        cleanupTempMqproj(tempProjPath);
        if (tempProjPath) {
            outputChannel.appendLine('[CPU] Cleaned up temp project');
        }
    }
}


function shouldFocusProblemsPanel(hasErrors, options = {}) {
    return Boolean(hasErrors) && !options.background;
}

function shouldRunCompileSuccessAction(hasErrors, options = {}) {
    return !hasErrors && typeof options.onSuccess === 'function';
}

async function runCompileSuccessAction(options = {}, logger = console) {
    const { onSuccess } = options;
    if (typeof onSuccess !== 'function') return;

    try {
        await onSuccess();
    } catch (error) {
        logger.error('Compile succeeded, but the onSuccess handler failed:', error);
    }
}

function shouldRunConfiguredPostCompileTask(hasErrors, config) {
    if (hasErrors) return false;
    const cfg = config || vscode.workspace.getConfiguration('mql_tools');
    const taskLabel = cfg.get('Compile.RunTaskOnSuccess');
    return typeof taskLabel === 'string' && taskLabel.trim().length > 0;
}

async function runConfiguredPostCompileTask(logger = console) {
    const taskLabel = (vscode.workspace.getConfiguration('mql_tools').get('Compile.RunTaskOnSuccess') || '').trim();
    if (!taskLabel) return;
    try {
        await vscode.commands.executeCommand('workbench.action.tasks.runTask', taskLabel);
    } catch (error) {
        logger.error(`Compile succeeded, but the post-compile task "${taskLabel}" failed to start:`, error);
    }
}

/**
 * Resolve which paths to compile for a .mqh header file.
 *
 * Decision order:
 * 1. `targets` not an array → `{ pathsToCompile: null, shouldWarn: false }` (caller already warned/aborted)
 * 2. `targets` is a non-empty array → `{ pathsToCompile: targets, shouldWarn: false }`
 * 3. `targets` is empty AND `magicPath` exists on disk → `{ pathsToCompile: [magicPath], shouldWarn: false }`
 * 4. Otherwise → `{ pathsToCompile: null, shouldWarn: !isBackground }`
 *    (`isBackground` suppresses the warning for silent auto-check runs)
 *
 * @param {object}   opts
 * @param {string[]|null} opts.targets      Resolved compile targets (from resolveCompileTargets).
 *                                          Pass `null` to signal abort; pass `[]` to trigger fallback.
 * @param {string}  [opts.magicPath]        Magic-comment parent path (from FindParentFile()).
 *                                          Used only when `targets` is empty.
 * @param {boolean} [opts.isBackground=false] True for silent background checks (CheckOnSave).
 *                                          Suppresses the "no target" warning when true.
 * @param {function(string):boolean} [pathExists=fs.existsSync] Injected for unit-testing.
 *
 * @returns {{ pathsToCompile: string[]|null, shouldWarn: boolean }}
 *   `pathsToCompile` — paths to hand to compilePath(), or null to skip compilation.
 *   `shouldWarn`     — true when the caller should show a "no compile target" warning.
 *
 * @example
 * // User-triggered compile, one mapped target
 * resolveHeaderCompilePlan({ targets: ['C:\\EA\\MyEA.mq5'] })
 * // → { pathsToCompile: ['C:\\EA\\MyEA.mq5'], shouldWarn: false }
 *
 * @example
 * // Background check, no targets found — suppress warning
 * resolveHeaderCompilePlan({ targets: [], isBackground: true })
 * // → { pathsToCompile: null, shouldWarn: false }
 */
function resolveHeaderCompilePlan({ targets, magicPath, isBackground = false }, pathExists = fs.existsSync) {
    if (!Array.isArray(targets)) {
        return { pathsToCompile: null, shouldWarn: false };
    }

    if (targets.length > 0) {
        return { pathsToCompile: targets, shouldWarn: false };
    }

    if (magicPath && pathExists(magicPath)) {
        return { pathsToCompile: [magicPath], shouldWarn: false };
    }

    return { pathsToCompile: null, shouldWarn: !isBackground };
}

async function Compile(rt, context, options = {}) {
    // Background runs never format and never call saveAll. Auto-formatting and
    // saving every open dirty document from a background syntax check fired
    // unrelated formatters and save hooks on files the command never touched.
    // Check-on-save and the startup check read the file that is already on disk,
    // so their diagnostics stay accurate without any write; only auto-check after
    // typing has to save the document it is checking (see saveDocumentUri below).
    if (!options.background) {
        await FixFormatting();
        // Save after formatting. Guard against re-entrant CheckOnSave triggers.
        internalSaveDepth++;
        try {
            await vscode.commands.executeCommand('workbench.action.files.saveAll');
        } finally {
            internalSaveDepth = Math.max(0, internalSaveDepth - 1);
        }
    } else if (options.saveDocumentUri) {
        // Auto-check after typing: MetaEditor only reads files, so the edited
        // document has to be saved to be checked. Save exactly that document —
        // identified by URI at change time, not whatever is active when the
        // debounce fires (the user may have switched files meanwhile) — and
        // never reformat from a background run.
        const editedDocument = vscode.workspace.textDocuments
            .find((document) => document.uri.toString() === options.saveDocumentUri);
        if (editedDocument && editedDocument.isDirty) {
            internalSaveDepth++;
            try {
                await editedDocument.save();
            } finally {
                internalSaveDepth = Math.max(0, internalSaveDepth - 1);
            }
        }
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const extension = pathModule.extname(document.fileName).toLowerCase();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

    let pathsToCompile = [];

    // For .mqh files, resolve compile targets
    if (extension === '.mqh') {
        // Workspace folder is required for .mqh compile target resolution
        if (!workspaceFolder) {
            return vscode.window.showErrorMessage('File must be in a workspace folder');
        }

        const targets = await resolveCompileTargets({
            document,
            workspaceFolder,
            context,
            rt
        });

        if (targets === null) {
            return; // User cancelled or aborted
        }

        const headerPlan = resolveHeaderCompilePlan({
            targets,
            magicPath: targets.length === 0 ? FindParentFile() : undefined,
            isBackground: Boolean(options.background)
        });

        if (!headerPlan.pathsToCompile) {
            // Headers are not standalone translation units. MetaEditor can emit
            // misleading diagnostics such as "'<file>' - not a function" when
            // a .mqh is compiled directly, so require a real .mq4/.mq5 target.
            if (headerPlan.shouldWarn) {
                return vscode.window.showWarningMessage(lg['mqh']);
            }
            return;
        }

        pathsToCompile = headerPlan.pathsToCompile;
    } else {
        // For .mq4/.mq5, compile the current file
        pathsToCompile = [document.fileName];
    }

    // Compile all targets
    outputChannel.clear();
    outputChannel.show(true);

    // Always clear previous MetaEditor diagnostics so Problems reflects the last run.
    // (We keep lightweight diagnostics in a separate collection.)
    diagnosticCollection.clear();

    // Auto-version bump: bump #property version and/or const string version constants
    // before compilation, if configured.
    // Only runs for user-initiated compiles (not background checks/auto-checks).
    // Guarded by internalSaveDepth so the document save does not re-trigger CheckOnSave.
    // AutoCheck timer is cleared after bumping because WorkspaceEdit triggers
    // onDidChangeTextDocument which would otherwise queue a spurious second compile.
    const config = vscode.workspace.getConfiguration('mql_tools');
    const autoBump = config.get('Compile.AutoVersionBump');
    const versionConstantNames = config.get('Compile.VersionConstantNames');
    const shouldBump = !options.background && autoBump;
    if (shouldBump) {
        internalSaveDepth++;
        try {
            for (const p of pathsToCompile) {
                try {
                    await bumpVersionsInFile({
                        filePath: p,
                        bumpPropertyVersion: autoBump,
                        versionConstantNames: versionConstantNames || [],
                        vscode,
                        outputChannel
                    });
                } catch (bumpErr) {
                    outputChannel.appendLine(`[Version] Error bumping version in ${pathModule.basename(p)}: ${bumpErr.message}`);
                }
            }
        } finally {
            internalSaveDepth = Math.max(0, internalSaveDepth - 1);
        }
        // Clear any AutoCheck timer that the WorkspaceEdit may have armed.
        if (autoCheckTimer) {
            clearTimeout(autoCheckTimer);
            autoCheckTimer = null;
        }
    }

    // const startT = new Date();
    // const time = `${tf(startT, 'h')}:${tf(startT, 'm')}:${tf(startT, 's')}`;
    const teq = rt === COMPILE_MODE_CHECK ? lg['checking'] : (rt === COMPILE_MODE_COMPILE ? lg['compiling'] : lg['comp_usi_script']);


    let progressTitle = buildCompileProgressTitle(teq);
    if (pathsToCompile.length === 1) {
        const progressTargetPath = pathsToCompile[0];
        const progressTargetVersion = await getPropertyVersionFromFile(progressTargetPath);
        const progressTargetLabel = formatCompileTargetLabel(pathModule.basename(progressTargetPath), progressTargetVersion);
        progressTitle = buildCompileProgressTitle(teq, progressTargetLabel);
    }

    let hasErrors = false;
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: progressTitle,
        },
        async () => {
            for (const pathToCompile of pathsToCompile) {
                const error = await compilePath(rt, pathToCompile, context);
                if (error) hasErrors = true;
            }
        }
    );

    // Restart clangd only when compile_commands.json or .clangd changed during
    // this run. A plain compile does not touch clangd inputs; restarting the
    // server and touching every visible editor after each compile broke user
    // typing and undo state for no benefit.
    if (clangdNeedsRestart) {
        clangdNeedsRestart = false;
        await refreshClangdDiagnostics();
    }
    // Only steal focus for explicit user-invoked runs, not background checks.
    if (shouldFocusProblemsPanel(hasErrors, options)) {
        await vscode.commands.executeCommand('workbench.panel.markers.view.focus');
    }

    if (shouldRunCompileSuccessAction(hasErrors, options)) {
        await runCompileSuccessAction(options);
    }
    if (shouldRunConfiguredPostCompileTask(hasErrors)) {
        await runConfiguredPostCompileTask();
    }
}

function replaceLog(str, f, winePrefix) {
    let text = f ? '' : '\n\n', obj_hover = {}, ye = false, diagnostics = [];
    if (!str) return { text, obj_hover, error: ye, diagnostics };

    const lines = str.replace(/\u{FEFF}/gu, '').split('\n');
    for (const item of lines) {
        const trimmed = item.trim();
        if (!trimmed) continue;

        if (REG_COMPILING.test(item)) {
            const isCompiling = item.includes('compiling');
            const regEx = new RegExp(`(?<=${isCompiling ? 'compiling' : 'checking'}.).+'`, 'gi');
            const mName = item.match(regEx);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);

            if (mName && mPath) {
                const name = mName[0];
                const resolvedPath = fromWineWindowsPath(mPath[0], winePrefix);
                const link = url.pathToFileURL(resolvedPath).href;
                obj_hover[name] = { link };
                text += name + '\n';
            }
        }
        else if (REG_INCLUDE.test(item)) {
            const mName = item.match(/(?<=information: including ).+'/gi);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);
            if (mName && mPath) {
                const name = mName[0];
                const resolvedPath = fromWineWindowsPath(mPath[0], winePrefix);
                const link = url.pathToFileURL(resolvedPath).href;
                obj_hover[name] = { link };
                text += name + '\n';
            }
        }
        else if (item.includes('information: generating code') || item.includes('information: code generated')) {
            continue;
        }
        else if (REG_INFO.test(item)) {
            const mName = item.match(/(?<=information: ).+/gi);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);
            if (mName && mPath) {
                const name = mName[0];
                const resolvedPath = fromWineWindowsPath(mPath[0], winePrefix);
                const link = url.pathToFileURL(resolvedPath).href;
                obj_hover[name] = { link };
                text += name + '\n';
            }
        }
        else if (REG_RESULT.test(item)) {
            const mErrWar = item.match(REG_ERR_WAR);
            const mSummary = item.match(REG_RESULT_SHORT);
            const summaryText = mSummary ? mSummary[0] : item;

            if (mErrWar) {
                const isErr = mErrWar[0].includes('error');
                if (isErr) ye = true;
                text += f ? `[${isErr ? 'Error' : 'Warning'}] ${item}` : `[${isErr ? 'Error' : 'Warning'}] Result: ${summaryText}`;
            } else {
                text += f ? `[Done] ${item}` : `[Done] Result: ${summaryText}`;
            }
            text += '\n';
        }
        else {
            const mLinePath = item.match(REG_LINE_PATH);
            if (mLinePath) {
                const link_res = (mLinePath[1] || '').replace(/[\r\n]+/g, '');
                let name_res = (mLinePath[2] || '').replace(/[\r\n]+/g, '');

                const gh_match = name_res.match(REG_ERROR_CODE);
                const gh = gh_match ? gh_match[0] : null;
                name_res = name_res.replace(gh || '', '').replace(/^(error|warning)\s*:\s*/i, '').trim();

                if (link_res.match(REG_FULL_PATH) && name_res) {
                    const mFullPath = link_res.match(/[a-zA-Z]:\\[^(\r\n]+/g);
                    const mPos = link_res.match(/\((\d+),(\d+)\)$/);

                    if (mFullPath && mPos) {
                        const rawPath = mFullPath[0].replace(/\($/, '').trim();
                        // On Linux/Wine, convert the Windows path emitted by MetaEditor to a
                        // proper Linux path using the Wine prefix (e.g. C:\... → {prefix}/drive_c/...)
                        const fullPath = fromWineWindowsPath(rawPath, winePrefix);
                        const line = parseInt(mPos[1]) - 1;
                        const col = parseInt(mPos[2]) - 1;
                        const severity = item.toLowerCase().includes('error') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;

                        // Filter out MQL181 (implicit conversion from number to string)
                        // These are noise since Print/PrintLive accept any type via implicit conversion
                        // Broadened check to catch various formats of this warning
                        const isMQL181 = gh === '181' ||
                            (name_res.toLowerCase().includes('implicit conversion') &&
                                ((name_res.includes("'number'") || name_res.includes('number')) &&
                                    (name_res.includes("'string'") || name_res.includes('string'))));
                        if (isMQL181) {
                            continue; // Skip this warning entirely
                        }

                        if (severity === vscode.DiagnosticSeverity.Error) ye = true;

                        diagnostics.push({
                            file: fullPath,
                            range: new vscode.Range(line, col, line, col + 1),
                            message: name_res,
                            severity: severity,
                            errorCode: gh  // Include error code for documentation link
                        });

                        // Build hover link: resolve the raw Windows path portion of link_res
                        // (which may include position suffix like "(10,5)") to a Linux path,
                        // then let pathToFileURL produce a valid file:// URL.
                        const resolvedLinkRes = fromWineWindowsPath(link_res, winePrefix);
                        const linePos = resolvedLinkRes.match(REG_LINE_POS);
                        const hoverKey = (name_res + ' ' + (linePos ? linePos[0] : '')).trim();
                        obj_hover[hoverKey] = {
                            link: url.pathToFileURL(resolvedLinkRes).href.replace(REG_LINE_FRAGMENT, '#').replace(/\)$/gm, ''),
                            number: gh ? String(gh) : null
                        };

                        const suffix = link_res.match(/(.)(?:\d+,\d+).$/gm);
                        text += name_res + (suffix ? ' ' + suffix[0] : '') + '\n';
                    } else {
                        text += name_res + '\n';
                    }

                }
                else {
                    text += name_res + (gh ? ` ${gh}` : '') + '\n';
                }
            } else {
                text += item + '\n';
            }
        }
    }

    // Store obj_hover in module-level variable for access by provider
    module.exports.obj_hover = obj_hover;
    return {
        text: text,
        error: ye,
        diagnostics: diagnostics
    };

}


function FindParentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const { document } = editor;
    const extension = pathModule.extname(document.fileName).toLowerCase();
    if (extension === '.mqh') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return undefined;
        const workspacepath = workspaceFolders[0].uri.fsPath;

        let NameFileMQL, match, regEx = new RegExp('(\\/\\/###<).+(mq[4|5]>)', 'ig');

        match = regEx.exec(document.lineAt(0).text);
        while (match) {
            NameFileMQL = match[0];
            match = regEx.exec(document.lineAt(0).text);
        }

        if (NameFileMQL != undefined)
            NameFileMQL = pathModule.join(workspacepath, String(NameFileMQL.match(/(?<=<).+(?=>)/)));

        return NameFileMQL;
    } else {
        return undefined;
    }
}

function extractPropertyVersion(text) {
    if (typeof text !== 'string' || !text) return null;

    const match = text.match(REG_PROPERTY_VERSION);
    const version = match && match[1] ? match[1].trim() : '';

    return version || null;
}

function getOpenDocumentText(filePath) {
    const documents = vscode.workspace.textDocuments;
    if (!Array.isArray(documents) || !filePath) return null;

    const openDocument = documents.find(doc => doc && doc.fileName === filePath);
    return openDocument ? openDocument.getText() : null;
}

async function getPropertyVersionFromFile(filePath) {
    if (!filePath) return null;

    const openDocumentText = getOpenDocumentText(filePath);
    if (openDocumentText) {
        return extractPropertyVersion(openDocumentText);
    }

    try {
        const buffer = await fsPromises.readFile(filePath);
        return extractPropertyVersion(decodeTextBuffer(buffer));
    } catch {
        return null;
    }
}

function formatPropertyVersionLabel(version) {
    if (!version) return '';

    const normalizedVersion = version.trim();
    if (!normalizedVersion) return '';

    const prefixedVersion = /^v/i.test(normalizedVersion)
        ? normalizedVersion
        : `v${normalizedVersion}`;

    return ` ${prefixedVersion}`;
}

function formatCompileTargetLabel(fileName, propertyVersion) {
    if (!fileName) return '';

    return `'${fileName}'${formatPropertyVersionLabel(propertyVersion)}`;
}

function buildCompileProgressTitle(teq, targetLabel = '') {
    return targetLabel ? `MQL Tools: ${teq} ${targetLabel}` : `MQL Tools: ${teq}`;
}

const SPECIAL_LITERAL_SPACING_RULES = [
    { pattern: '\\bB \'[01]+\'', searchValue: 'B ', replaceValue: 'B' },
    { pattern: '\\bC \'\\d{1,3},\\d{1,3},\\d{1,3}\'', searchValue: 'C ', replaceValue: 'C' },
    { pattern: '\\bC \'0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}\'', searchValue: 'C ', replaceValue: 'C' },
    { pattern: '\\bD \'(?:\\d{2}|\\d{4})\\.\\d{2}\\.(?:\\d{2}|\\d{4})(?:\\s{1,}[\\d:]+)?\'', searchValue: 'D ', replaceValue: 'D' }
];

function normalizeSpecialLiteralSpacing(text) {
    return SPECIAL_LITERAL_SPACING_RULES.reduce((normalizedText, rule) => {
        return normalizedText.replace(new RegExp(rule.pattern, 'g'), match => match.replace(rule.searchValue, rule.replaceValue));
    }, text);
}

async function FixFormatting() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;
    const document = editor.document;
    const replacements = [];
    const combinedPattern = new RegExp(SPECIAL_LITERAL_SPACING_RULES.map(rule => rule.pattern).join('|'), 'g');

    Array.from(document.getText().matchAll(combinedPattern)).forEach(match => {
        const replacement = normalizeSpecialLiteralSpacing(match[0]);
        if (replacement === match[0]) {
            return;
        }

        const range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
        replacements.push({ range, to: replacement });
    });

    if (!replacements.length) return false;

    return await editor.edit(editBuilder => {
        for (const { range, to } of replacements) {
            editBuilder.replace(range, to);
        }
    });
}

// The Code Action provider lives in src/codeActionProvider.js (review item 11).
const { createCodeActionProvider } = require('./codeActionProvider');


// ---------------------------------------------------------------------------
// Shared MQL path helpers (used by openTradeReport and runBacktest)
// ---------------------------------------------------------------------------

/**
 * Resolve the MQL Experts/ folder via multiple strategies.
 * @returns {string|null}
 */
function findExpertsDir() {
    // Strategy 1: logTailer already resolved basePath (Live Log was used)
    if (logTailer.basePath) {
        const d = pathModule.join(logTailer.basePath, 'Experts');
        if (fs.existsSync(d)) return d;
    }

    // Strategy 2: User-configured Include dir setting
    const config = vscode.workspace.getConfiguration('mql_tools');
    const version = (logTailer.detectMqlVersion ? logTailer.detectMqlVersion() : null) || 'mql5';
    const settingKey = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
    const rawIncDir = config.get(`Metaeditor.${settingKey}`);
    if (rawIncDir) {
        const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const resolvedIncDir = resolvePathRelativeToWorkspace(rawIncDir, wsFolder);
        if (resolvedIncDir) {
            let base = resolvedIncDir;
            if (pathModule.basename(base).toLowerCase() === 'include') base = pathModule.dirname(base);
            const d = pathModule.join(base, 'Experts');
            if (fs.existsSync(d)) return d;
        }
    }

    // Strategy 3: Scan MetaQuotes AppData — find all terminal data folders
    const appData = process.env.APPDATA || pathModule.join(os.homedir(), 'AppData', 'Roaming');
    const mqRoot = pathModule.join(appData, 'MetaQuotes', 'Terminal');
    if (fs.existsSync(mqRoot)) {
        const mqlDir = version === 'mql4' ? 'MQL4' : 'MQL5';
        let candidates = [];
        try {
            for (const termId of fs.readdirSync(mqRoot)) {
                try {
                    const d = pathModule.join(mqRoot, termId, mqlDir, 'Experts');
                    if (fs.existsSync(d)) candidates.push(d);
                } catch (err) {
                    if (outputChannel) {
                        outputChannel.appendLine(`Error checking path for termId ${termId} in ${mqRoot} (${mqlDir}): ${err.message}`);
                    }
                }
            }
        } catch (err) {
            if (outputChannel) {
                outputChannel.appendLine(`Error reading MetaQuotes root directory ${mqRoot}: ${err.message}`);
            }
        }
        // Pick the one with the most recently modified Experts subfolder
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) {
            candidates.sort((a, b) => {
                try { return fs.statSync(b).mtime - fs.statSync(a).mtime; } catch (err) {
                    if (outputChannel) {
                        outputChannel.appendLine(`Error comparing modification times for candidates ${a} and ${b}: ${err.message}`);
                    }
                    return 0;
                }
            });
            return candidates[0];
        }
    }

    return null;
}

/**
 * Derive the MQL5 (or MQL4) root from the Experts dir.
 * 
 * ASSUMPTION: This assumes the 'Experts/' directory is a direct child of the 
 * MQL root (e.g., MQL5/Experts). Since findExpertsDir() only searches standard 
 * terminal/data paths, this function returns pathModule.dirname(expertsDir).
 * This may be inaccurate for non-standard or deeply nested layouts; callers 
 * should validate the returned path if strict accuracy is required.
 * 
 * @returns {string|null}
 */
function findMql5Root() {
    const expertsDir = findExpertsDir();
    if (!expertsDir) return null;
    return pathModule.dirname(expertsDir); // Experts -> MQL5
}

function activate(context) {
    // Initialize VS Code API-dependent variables (must be inside activate, not at module level)
    diagnosticCollection = vscode.languages.createDiagnosticCollection('mql');
    outputChannel = vscode.window.createOutputChannel('MQL', 'mql-output');
    context.subscriptions.push(diagnosticCollection, outputChannel);
    // Route all module logging into the visible MQL output channel.
    mqlLogger.initLogger(outputChannel);

    // Sweep leftover *.mql_dbg_build.* artifacts from aborted debug sessions.
    // Fire-and-forget: the sweep is best-effort and must never block or fail
    // activation (see src/tempSweep.js).
    sweepDbgBuildArtifacts((vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath))
        .then(results => {
            const removed = results.reduce((sum, r) => sum + r.removed.length, 0);
            if (removed > 0) {
                outputChannel.appendLine(`[Info] Removed ${removed} leftover debug-build artifact(s) from aborted debug sessions`);
            }
        })
        .catch(() => { });

    // Show Startup Page PoC
    showStartupPage(context);


    // Debug watch annotation CodeLens
    registerDebugCodeLens(context);

    // Clear symbol cache when a document is closed
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
        clearSymbolCache(document.uri.toString());
        // Drop any pending auto-check version tracking for closed documents.
        // Without this the map grows for every checked-then-closed document.
        autoCheckDocVersions.delete(document.uri.toString());
    }));

    // Resolve the package manifest from the running extension instead of hardcoding
    // an id: the manifest id is `<publisher>.<name>` (ngsoftware.mql-clangd), and the
    // old hardcoded 'ngsoftware.mql-tools' made getExtension() return undefined,
    // which silently disabled the migration check and the CPU_ARCH_MAP guard below.
    const extPkg = context.extension?.packageJSON;
    const currentVersion = extPkg?.version;
    const previousVersion = context.globalState.get('mql-tools.version');

    // Guard: CPU_ARCH_MAP must cover every non-'default' enum value declared in package.json.
    const cpuArchEnum = extPkg?.contributes?.configuration?.properties?.['mql_tools.Compile.CpuArchitecture']?.enum || [];
    for (const v of cpuArchEnum) {
        if (v !== 'default' && CPU_ARCH_MAP[v] === undefined) {
            outputChannel.appendLine(`[Warning] CpuArchitecture enum value '${v}' has no CPU_ARCH_MAP entry; selecting it will be a no-op.`);
        }
    }

    // Initialize Wine helper with output channel for logging
    setWineOutputChannel(outputChannel);

    // Validate Wine configuration if enabled
    const config = vscode.workspace.getConfiguration('mql_tools');
    if (isWineEnabled(config)) {
        const wineBinary = getWineBinary(config);
        const winePrefix = getWinePrefix(config);

        isWineInstalled(wineBinary, winePrefix).then(result => {
            if (!result.installed) {
                vscode.window.showErrorMessage(
                    `Wine is enabled but not found: ${result.error || 'Unknown error'}`,
                    'Open Settings'
                ).then(selection => {
                    if (selection === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'mql_tools.Wine');
                    }
                });
            } else {
                outputChannel.appendLine(`[Wine] Detected: ${result.version}`);
                if (winePrefix) {
                    outputChannel.appendLine(`[Wine] Using prefix: ${winePrefix}`);
                }
            }
        }).catch(error => {
            const errorMessage = error?.message || String(error);
            outputChannel.appendLine(`[Wine] Error checking Wine installation: ${errorMessage}`);
            outputChannel.appendLine(error?.stack || '');
            vscode.window.showErrorMessage(
                `Failed to check Wine installation: ${errorMessage}`,
                'Open Settings'
            ).then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'mql_tools.Wine');
                }
            });
        });
    }

    // Migration check: run once the workspace has settled. Fires on the first
    // workspace-folder change or after a 2 s cap, whichever comes first, and
    // cleans up both triggers afterwards (the old fixed sleep(2000) always
    // blocked the full two seconds and left no dispose path).
    let migrationCheckDone = false;
    const runMigrationCheck = async () => {
        if (migrationCheckDone) return;
        migrationCheckDone = true;
        try {
            if (previousVersion !== currentVersion) {
                if (currentVersion === '1.0.0' || currentVersion === '1.0.1' || currentVersion === '1.0.2') {
                    regenerateProperties().catch((err) => {
                        outputChannel.appendLine(`[Error] Migration CreateProperties failed: ${err.message}`);
                    });
                }

                // v1.1.35+: Remove duplicate -c from .clangd CompileFlags.Add.
                // The flag is already in compile_commands.json entries and caused
                // double -c with -x c++-header for inferred header commands.
                try {
                    for (const wf of (vscode.workspace.workspaceFolders || [])) {
                        const clangdPath = pathModule.join(wf.uri.fsPath, '.clangd');
                        if (fs.existsSync(clangdPath)) {
                            const content = await fs.promises.readFile(clangdPath, 'utf8');
                            if (content.includes('    - -c\n')) {
                                let patched = content.replace(/^ {4}# Compile only[^\n]*\n {4}- -c\n/m, '');
                                if (patched === content) {
                                    // Comment was missing or edited — remove bare flag line
                                    patched = content.replace(/^ {4}- -c\n/m, '');
                                }
                                if (patched !== content) {
                                    await fs.promises.writeFile(clangdPath, patched, 'utf8');
                                    mqlLogger.info('MQL Tools: Migrated .clangd — removed duplicate -c flag');
                                }
                            }
                        }
                    }
                } catch (err) {
                    mqlLogger.error('MQL Tools: .clangd migration failed', err);
                }

                context.globalState.update('mql-tools.version', currentVersion);
            }
        } catch (err) {
            mqlLogger.error('MQL Tools: migration check failed', err);
        }
    };
    const migrationFolderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => runMigrationCheck());
    const migrationTimer = setTimeout(() => runMigrationCheck(), 2000);
    context.subscriptions.push(migrationFolderSub, { dispose: () => clearTimeout(migrationTimer) });

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.showStartupPage', () => showStartupPage(context, true)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.checkFile', () => Compile(COMPILE_MODE_CHECK, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileFile', () => Compile(COMPILE_MODE_COMPILE, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileFileAndOpenTerminal', () => Compile(COMPILE_MODE_COMPILE, context, { onSuccess: OpenTradingTerminal })));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileScript', () => Compile(COMPILE_MODE_SCRIPT, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.help', (keyword, version) => Help(keyword, version)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.offlineHelp', () => OfflineHelp()));

    // Compile target commands
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.selectCompileTarget', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const extension = pathModule.extname(document.fileName).toLowerCase();

        if (extension !== '.mqh') {
            return vscode.window.showWarningMessage('This command is only for .mqh header files');
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return vscode.window.showErrorMessage('File must be in a workspace folder');
        }

        // Force user to select targets (pass null for candidates to show all mains)
        const config = vscode.workspace.getConfiguration('mql_tools');
        const allowMultiSelect = config.get('CompileTarget.AllowMultiSelect', true);

        const allMains = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.{mq4,mq5}'),
            '**/node_modules/**',
            1000
        );

        const items = allMains.map(uri => ({
            label: pathModule.basename(uri.fsPath),
            description: pathModule.relative(workspaceFolder.uri.fsPath, uri.fsPath),
            filePath: uri.fsPath
        }));

        if (items.length === 0) {
            return vscode.window.showWarningMessage('No .mq4 or .mq5 files found in workspace');
        }

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: allowMultiSelect,
            placeHolder: `Select compile target(s) for ${pathModule.basename(document.fileName)}`,
            title: 'MQL Compile Target'
        });

        if (!selected) return;

        const selectedItems = Array.isArray(selected) ? selected : [selected];
        const targetUris = selectedItems.map(item => vscode.Uri.file(item.filePath));

        await setCompileTargets(document.uri, targetUris, workspaceFolder, context);

        vscode.window.showInformationMessage(
            `Compile target(s) set: ${selectedItems.map(i => i.label).join(', ')}`
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.resetCompileTarget', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const extension = pathModule.extname(document.fileName).toLowerCase();

        if (extension !== '.mqh') {
            return vscode.window.showWarningMessage('This command is only for .mqh header files');
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            return vscode.window.showErrorMessage('File must be in a workspace folder');
        }

        await resetCompileTargets(document.uri, workspaceFolder, context);
        vscode.window.showInformationMessage('Compile target mapping reset');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.resetAllCompileTargets', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return vscode.window.showErrorMessage('No workspace folder open');
        }

        const answer = await vscode.window.showWarningMessage(
            'Reset all compile target mappings?',
            { modal: true },
            'Yes', 'No'
        );

        if (answer === 'Yes') {
            const results = await Promise.allSettled(workspaceFolders.map(folder => resetCompileTargets(null, folder, context)));
            const failed = results.filter(r => r.status === 'rejected');

            if (failed.length > 0) {
                mqlLogger.error('Failed to reset some compile targets:', failed);
                vscode.window.showWarningMessage(`Reset complete with ${failed.length} errors. Check console for details.`);
            } else {
                vscode.window.showInformationMessage('All compile target mappings reset');
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.configurations', async () => {
        await regenerateProperties();
        try {
            await vscode.commands.executeCommand('clangd.restart');
        } catch (error) {
            // clangd extension may not be installed - silently ignore
        }
        // The command already restarted clangd: don't restart again on the
        // next finished compile.
        clangdNeedsRestart = false;
    }));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.Addicon', () => IconsInstallation()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.Showfiles', () => ShowFiles('**/*.ex4', '**/*.ex5')));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsMQL', () => InsertMQL()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsMQH', () => InsertMQH()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsNameMQL', (uri) => InsertNameFileMQL(uri)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsNameMQH', (uri) => InsertNameFileMQH(uri)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsResource', () => InsertResource()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsImport', () => InsertImport()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsTime', () => InsertTime()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.InsIcon', () => InsertIcon()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openInME', (uri) => OpenFileInMetaEditor(uri)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openTradingTerminal', (eaPath, mql5Root) => OpenTradingTerminal(eaPath, mql5Root)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.arrangeCharts', () => ArrangeCharts(context)));
    createStatusBar(context);
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.commentary', () => CreateComment()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.toggleTerminalLog', () => logTailer.toggle()));

    // LiveLog commands for real-time logging
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.installLiveLog', async () => {
        // Manually trigger LiveLog library deployment
        const version = logTailer.detectMqlVersion() || 'mql5';
        const config = vscode.workspace.getConfiguration('mql_tools');
        const logFolderName = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
        let rawIncDir = config.get(`Metaeditor.${logFolderName}`);

        if (!rawIncDir) {
            rawIncDir = logTailer.inferDataFolder(version);
        }

        if (!rawIncDir) {
            vscode.window.showErrorMessage('Cannot determine MQL folder path. Please configure Include directory settings.');
            return;
        }

        let basePath = rawIncDir;
        if (pathModule.basename(basePath).toLowerCase() === 'include') {
            basePath = pathModule.dirname(basePath);
        }
        logTailer.basePath = basePath;

        const success = await logTailer.deployLiveLogLibrary();
        if (success) {
            vscode.window.showInformationMessage(
                'LiveLog.mqh installed! Add `#include <LiveLog.mqh>` to your EA and use PrintLive() for real-time output.'
            );
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.installCompileListenerService', async () => {
        const config = vscode.workspace.getConfiguration('mql_tools');
        let rawIncDir = config.get('Metaeditor.Include5Dir');
        if (!rawIncDir) {
            rawIncDir = logTailer.inferDataFolder('mql5');
        }
        if (!rawIncDir) {
            vscode.window.showErrorMessage('Cannot determine MQL5 folder path. Please configure mql_tools.Metaeditor.Include5Dir.');
            return;
        }
        let basePath = rawIncDir;
        if (pathModule.basename(basePath).toLowerCase() === 'include') {
            basePath = pathModule.dirname(basePath);
        }
        const servicesDir = pathModule.join(basePath, 'Services');
        const extensionPath = context.extensionPath;
        const sourcePath = pathModule.join(extensionPath, 'files', 'CompileListenerService.mq5');
        const targetPath = pathModule.join(servicesDir, 'CompileListenerService.mq5');
        try {
            await fs.promises.mkdir(servicesDir, { recursive: true });
            try {
                await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
                vscode.window.showInformationMessage(`CompileListenerService.mq5 installed to: ${targetPath}. Open MetaEditor, compile it, then start it from Navigator → Services.`);
            } catch (copyErr) {
                if (copyErr.code === 'EEXIST') {
                    if (outputChannel) {
                        outputChannel.appendLine(`[CompileListenerService] Target file already exists: ${targetPath} (source: ${sourcePath})`);
                    }
                    const answer = await vscode.window.showWarningMessage(
                        'CompileListenerService.mq5 already exists at destination. Do you want to overwrite it?',
                        'Yes', 'No'
                    );
                    if (answer === 'Yes') {
                        await fs.promises.copyFile(sourcePath, targetPath);
                        vscode.window.showInformationMessage(`CompileListenerService.mq5 overwritten at: ${targetPath}. Open MetaEditor, compile it, then start it from Navigator → Services.`);
                    } else {
                        vscode.window.showInformationMessage('Installation skipped. Existing CompileListenerService.mq5 was not overwritten.');
                    }
                } else {
                    throw copyErr;
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to install CompileListenerService.mq5: ${err.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.switchLogMode', async () => {
        const current = logTailer.mode;
        const items = [
            { label: 'LiveLog (Real-time)', description: 'Tail MQL5/Files/LiveLog.txt - requires PrintLive() in EA', mode: 'livelog' },
            { label: 'LiveLog (Common/Tester)', description: 'Tail Common\\Files\\LiveLog.txt - shared with strategy-tester agents, requires #define LIVELOG_COMMON in EA', mode: 'common' },
            { label: 'Standard Journal', description: 'Tail MQL5/Logs/YYYYMMDD.log - uses Print() output (not real-time)', mode: 'standard' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Current: ${items.find(i => i.mode === current)?.label || current}`,
            title: 'MQL: Switch Log Tail Mode'
        });

        if (selected && selected.mode !== current) {
            logTailer.mode = selected.mode;
            if (logTailer.isTailing) {
                logTailer.stop();
                await logTailer.start();
            }
            logTailer.updateStatusBar();
            vscode.window.showInformationMessage(`Switched to ${selected.label} mode`);
        }
    }));

    logTailer.initStatusBar();

    // Trade Report Dashboard — discover EAs and their test runs
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openTradeReport', () => {
        const expertsDir = findExpertsDir();
        if (!expertsDir) {
            vscode.window.showErrorMessage(
                'Cannot find MQL Experts folder. Please configure your MQL Include directory setting.',
                'Configure'
            ).then(sel => {
                if (sel === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'mql_tools.Metaeditor');
                }
            });
            return;
        }

        try {
            TradeReportDashboard.createOrShow(context, expertsDir);
        } catch (error) {
            mqlLogger.error('Failed to create or show Trade Report Dashboard:', error);
            vscode.window.showErrorMessage(`Failed to open Trade Report Dashboard: ${error.message}`);
        }
    }));

    // Run Backtest — launch MT5 Strategy Tester via TradeReportServer
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.runBacktest', () => {
        return runBacktest(context, {
            findMql5Root,
            resolveCompileTargets,
        });
    }));

    // MQL Debugger Bridge — DAP adapter shim
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('mql5', {
            createDebugAdapterDescriptor(session) {
                const cfg = session.configuration;
                const adapter = new MqlDebugAdapter(
                    debugStore,
                    debugBridge,
                    cfg.program,
                    cfg._mql5Root,
                    compilePath,
                    context,
                    cfg._originalPath
                );
                return new vscode.DebugAdapterInlineImplementation(adapter);
            }
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.startDebugging', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('MQL Debug: Open an MQL source file first.');
            return;
        }
        let sourcePath = editor.document.uri.fsPath;
        const ext = pathModule.extname(sourcePath).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) {
            vscode.window.showErrorMessage('MQL Debug: The active file must be an .mq5, .mq4, or .mqh EA/script/header.');
            return;
        }

        if (ext === '.mqh') {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('MQL Debug: .mqh file must be inside a workspace folder to resolve its compile target.');
                return;
            }
            const targets = await resolveCompileTargets({
                document: editor.document,
                workspaceFolder,
                context,
                rt: COMPILE_MODE_COMPILE
            });
            if (!targets || targets.length === 0) {
                return; // User cancelled or no targets
            }
            if (targets.length > 1) {
                vscode.window.showInformationMessage(`MQL Debug: Multiple targets found. Debugging the first one: ${pathModule.basename(targets[0])}`);
            }
            sourcePath = targets[0];
        }

        const mql5Root = findMql5Root();
        if (!mql5Root) {
            vscode.window.showErrorMessage('MQL Debug: Cannot determine MQL5 root folder. Set Include5Dir in settings.');
            return;
        }

        const originalPath = editor.document.uri.fsPath;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
            || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);

        await vscode.debug.startDebugging(workspaceFolder, {
            type: 'mql5',
            request: 'launch',
            name: 'MQL Debug',
            program: sourcePath,
            _mql5Root: mql5Root,
            _originalPath: originalPath,
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.stopDebugging', () => {
        vscode.debug.stopDebugging();
    }));

    context.subscriptions.push(vscode.languages.registerHoverProvider('mql-output', Hover_log()));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider('mql-output', DefinitionProvider()));
    context.subscriptions.push(vscode.languages.registerHoverProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, Hover_MQL()));
    context.subscriptions.push(vscode.languages.registerColorProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, ColorProvider()));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, ItemProvider()));
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, MQLDocumentSymbolProvider()));
    // Signature help provider is registered immediately, but HelpProvider()
    // is constructed lazily on first use: building it scans the MQL standard
    // library docs, and the old sleep(1000)-deferred registration both delayed
    // activation and left signature help unavailable for the first second.
    let signatureHelpInstance = null;
    const lazySignatureHelpProvider = {
        provideSignatureHelp(document, position, token, contextArg) {
            if (!signatureHelpInstance) {
                signatureHelpInstance = HelpProvider();
            }
            return signatureHelpInstance.provideSignatureHelp(document, position, token, contextArg);
        }
    };
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, lazySignatureHelpProvider, '(', ','));

    // Register lightweight diagnostics (instant feedback without MetaEditor)
    registerLightweightDiagnostics(context);

    // Register on-save unresolved-symbol watcher (decoration + Hint diagnostics + quick fix)
    unresolvedSymbolWatcher.activate(context, getIncludeDir);

    // Register Code Action provider for MQL quick fixes
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*.{mq4,mq5,mqh}' },
        createCodeActionProvider({ findClosestMatches }),
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ));

    // Was contributed in package.json but never registered, so the palette entry
    // failed with "command not found".
    context.subscriptions.push(vscode.commands.registerCommand(
        'mql_tools.reportNoisyDiagnostic',
        () => reportNoisyDiagnostic(context, outputChannel)
    ));

    // Debounced auto-check on text change
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        const config = vscode.workspace.getConfiguration('mql_tools');
        if (!config.AutoCheck.Enabled) return;

        const ext = pathModule.extname(event.document.fileName).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) return;

        const docUri = event.document.uri.toString();
        const docVersion = event.document.version;

        // Ignore changes caused by our own auto-check edits (FixFormatting, save)
        const trackedVersion = autoCheckDocVersions.get(docUri);
        if (trackedVersion !== undefined && docVersion <= trackedVersion) {
            return; // This change is from our own edits, ignore it
        }
        // User made a new change, clear any tracked version for this doc
        autoCheckDocVersions.delete(docUri);

        // Clear previous timer
        if (autoCheckTimer) {
            clearTimeout(autoCheckTimer);
            autoCheckTimer = null;
        }

        // Don't start new check if one is already running
        if (isAutoCheckRunning) return;

        const delay = config.AutoCheck.Delay || 3000;
        const editedUri = docUri; // the document the user typed in
        autoCheckTimer = setTimeout(async () => {
            isAutoCheckRunning = true;

            try {
                await Compile(COMPILE_MODE_CHECK, context, { background: true, saveDocumentUri: editedUri }); // Syntax check (no compilation)
            } finally {
                // Record the final document version after our edits complete
                // This prevents re-triggering from FixFormatting or save changes
                const editedDoc = vscode.workspace.textDocuments
                    .find((document) => document.uri.toString() === editedUri);
                if (editedDoc) {
                    autoCheckDocVersions.set(editedUri, editedDoc.version);
                }
                isAutoCheckRunning = false;
            }
        }, delay);
    }));

    // Clean up timer on deactivate
    context.subscriptions.push({
        dispose: () => {
            if (autoCheckTimer) {
                clearTimeout(autoCheckTimer);
                autoCheckTimer = null;
            }
        }
    });

    // Check on save - run syntax check when MQL files are saved
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
        // Ignore saves performed by Compile() itself (prevents recursion / cascades)
        if (internalSaveDepth > 0) return;

        const config = vscode.workspace.getConfiguration('mql_tools');
        if (!config.CheckOnSave) return;

        const ext = pathModule.extname(document.fileName).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) return;

        // Don't start if auto-check is already running
        if (isAutoCheckRunning) return;

        // Clear any pending auto-check timer since we're checking now
        if (autoCheckTimer) {
            clearTimeout(autoCheckTimer);
            autoCheckTimer = null;
        }

        isAutoCheckRunning = true;
        try {
            await Compile(COMPILE_MODE_CHECK, context, { background: true }); // Syntax check
        } finally {
            isAutoCheckRunning = false;
        }
    }));

    // Auto-compile once when the workspace finishes loading. Fires when an MQL
    // document first becomes active (immediate) or at a 3 s cap for the case
    // where an MQL editor is already restored, whichever comes first. Both
    // triggers are disposed after the single run; the old fixed sleep(3000)
    // always waited three seconds and left its timer undisposed.
    let startupCheckDone = false;
    const attemptStartupCheck = async () => {
        if (isAutoCheckRunning) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const ext = pathModule.extname(editor.document.fileName).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) return;

        isAutoCheckRunning = true;
        try {
            await Compile(COMPILE_MODE_CHECK, context, { background: true }); // Syntax check on startup
        } finally {
            isAutoCheckRunning = false;
        }
    };
    const finishStartupCheck = () => {
        startupCheckDone = true;
        startupFolderSub.dispose();
        if (startupCheckTimer) clearTimeout(startupCheckTimer);
    };
    const startupFolderSub = vscode.window.onDidChangeActiveTextEditor(async () => {
        if (startupCheckDone) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const ext = pathModule.extname(editor.document.fileName).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) return;
        finishStartupCheck();
        await attemptStartupCheck();
    });
    const startupCheckTimer = setTimeout(async () => {
        if (startupCheckDone) return;
        finishStartupCheck();
        await attemptStartupCheck();
    }, 3000);
    context.subscriptions.push(startupFolderSub, { dispose: () => clearTimeout(startupCheckTimer) });

    // Watch for file changes to invalidate reverse index cache
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{mq4,mq5,mqh}');

    // Debounced invalidation to handle batch updates (e.g. git checkout)
    let indexInvalidationTimer = null;
    const INDEX_DEBOUNCE_MS = 1000;
    const pendingDirtyFolders = new Set();

    const debouncedMarkDirty = (uri) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            pendingDirtyFolders.add(folder.uri.toString());
        }

        if (indexInvalidationTimer) {
            clearTimeout(indexInvalidationTimer);
        }

        indexInvalidationTimer = setTimeout(() => {
            if (pendingDirtyFolders.size === 0) {
                indexInvalidationTimer = null; // Reset timer state (Comment 6)
                return;
            }

            // Process all pending folders
            for (const folderUriStr of pendingDirtyFolders) {
                const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === folderUriStr);
                if (folder) {
                    markIndexDirty(folder);
                    // mqlLogger.info(`[MQL Index] Invalidated cache for ${folder.name} (debounced)`);
                }
            }
            pendingDirtyFolders.clear();
            indexInvalidationTimer = null;
        }, INDEX_DEBOUNCE_MS);
    };

    fileWatcher.onDidChange(debouncedMarkDirty);
    context.subscriptions.push(fileWatcher);

    // --- Auto-regenerate compile_commands.json when include graph changes ---

    let mqhStructuralTimer = null;
    const MQH_STRUCTURAL_DEBOUNCE_MS = 2000;

    const debouncedStructuralChange = (uri) => {
        debouncedMarkDirty(uri); // still invalidate the reverse index
        const ext = pathModule.extname(uri.fsPath).toLowerCase();
        if (ext === '.mqh') {
            if (mqhStructuralTimer) clearTimeout(mqhStructuralTimer);
            mqhStructuralTimer = setTimeout(() => {
                mqhStructuralTimer = null;
                regenerateProperties().catch(err => {
                    mqlLogger.error('MQL Tools: Failed to auto-regenerate after .mqh change', err);
                });
            }, MQH_STRUCTURAL_DEBOUNCE_MS);
        }
    };

    fileWatcher.onDidCreate(debouncedStructuralChange);
    fileWatcher.onDidDelete(debouncedStructuralChange);
    context.subscriptions.push({ dispose: () => { if (mqhStructuralTimer) clearTimeout(mqhStructuralTimer); } });

    // Auto-regenerate when #include directives change in MQL source files
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (internalSaveDepth > 0) return;
        const ext = pathModule.extname(document.fileName).toLowerCase();
        if (ext !== '.mq4' && ext !== '.mq5' && ext !== '.mqh') return;

        try {
            const changed = await haveIncludesChanged(document.fileName);
            if (!changed) return;
            await regenerateProperties();
        } catch (err) {
            mqlLogger.error('MQL Tools: Failed to auto-regenerate compile_commands.json', err);
        }
    }));

}

function deactivate() {
    try {
        logTailer.dispose();
    } catch (error) {
        mqlLogger.error('Error during logTailer.dispose():', error);
    }

    try {
        cancelBacktests();
    } catch (error) {
        mqlLogger.error('Error during cancelBacktests():', error);
    }

    try {
        debugBridge.stop();
    } catch (error) {
        mqlLogger.error('Error during debugBridge.stop():', error);
    }

    try {
        debugBridge.dispose();
    } catch (error) {
        mqlLogger.error('Error during debugBridge.dispose():', error);
    }
}


module.exports = {
    activate,
    deactivate,
    replaceLog,
    tf,
    extractPropertyVersion,
    formatCompileTargetLabel,
    buildCompileProgressTitle,
    buildMetaEditorCmd,
    normalizeSpecialLiteralSpacing,
    shouldFocusProblemsPanel,
    shouldRunCompileSuccessAction,
    runCompileSuccessAction,
    shouldRunConfiguredPostCompileTask,
    runConfiguredPostCompileTask,
    resolveHeaderCompilePlan,
    inferMqlDataDirFromPath,
    bumpVersionsInFile: require('./versionBumper').bumpVersionsInFile
};
