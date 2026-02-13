'use strict';
const url = require('url');
const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const pathModule = require('path');

const sleep = require('util').promisify(setTimeout);
const fsPromises = fs.promises;

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

// NOTE: diagnosticCollection and outputChannel are initialized in activate()
let diagnosticCollection = null;
let outputChannel = null;
let autoCheckTimer = null;
let isAutoCheckRunning = false;
let autoCheckDocVersions = new Map(); // Track document versions to ignore our own edits
// Guard to prevent CheckOnSave from re-triggering itself when Compile() saves files.
let internalSaveDepth = 0;
const lg = require('./language');
const { Help, OfflineHelp } = require('./help');
const { ShowFiles, InsertNameFileMQH, InsertMQH, InsertNameFileMQL, InsertMQL, InsertResource, InsertImport, InsertTime, InsertIcon, OpenFileInMetaEditor, OpenTradingTerminal, CreateComment } = require('./contextMenu');
const { IconsInstallation } = require('./addIcon');
const { Hover_log, DefinitionProvider, Hover_MQL, ItemProvider, HelpProvider, ColorProvider, MQLDocumentSymbolProvider } = require('./provider');
const { obj_items } = require('./provider');
const { registerLightweightDiagnostics } = require('./lightweightDiagnostics');
const { CreateProperties, generatePortableSwitch, resolvePathRelativeToWorkspace } = require('./createProperties');
const { resolveCompileTargets, setCompileTargets, resetCompileTargets, markIndexDirty, getCompileTargets } = require('./compileTargetResolver');
const {
    toWineWindowsPath,
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


// =============================================================================
// SPELLCHECK INDEX - Lazy-loaded dictionary for typo detection
// =============================================================================

let spellcheckIndex = null;

/**
 * Build and cache the spellcheck index from obj_items
 * Filters to group=2 (functions) and indexes by first character for fast lookup
 * @returns {{ byFirstChar: Object<string, string[]>, all: Set<string> }}
 */
function getSpellcheckIndex() {
    if (spellcheckIndex) return spellcheckIndex;

    const byFirstChar = {};
    const all = new Set();

    for (const name in obj_items) {
        // Only include functions (group 2) with reasonable length
        if (obj_items[name].group === 2 && name.length >= 3) {
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

/**
 * Refresh clangd diagnostics after compilation.
 *
 * This function restarts the clangd language server so it re-reads the
 * updated compile_commands.json. Then it "touches" open MQL documents to
 * trigger clangd to re-analyze them. After that, it restores the MQL
 * diagnostics that were set by the MetaEditor compiler.
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
 * Compile a single file path
 * Extracted from Compile() to support compiling multiple targets
 */
async function compilePath(rt, pathToCompile, _context) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const fileName = pathModule.basename(pathToCompile);
    const extension = pathModule.extname(pathToCompile).toLowerCase();
    const startT = new Date();
    const time = `${tf(startT, 'h')}:${tf(startT, 'm')}:${tf(startT, 's')}`;

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
        return undefined;
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
        case 0: teq = lg['checking'];
            break;
        case 1: teq = lg['compiling'];
            break;
        case 2: teq = lg['comp_usi_script'];
            break;
    }

    // Early validation - before Promise
    if (!fs.existsSync(MetaDir)) {
        vscode.window.showErrorMessage(CommM);
        return undefined;
    }

    if (incDir && !fs.existsSync(incDir)) {
        vscode.window.showErrorMessage(CommI);
        return undefined;
    }

    const portableSwitch = generatePortableSwitch(portableMode);

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
            vscode.window.showErrorMessage(`Wine Configuration Error: ${pathValidation.error}`);
            return undefined;
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
            outputChannel.appendLine(`[Wine] MetaEditor path conversion failed: ${metaResult.error}`);
            return undefined;
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
            return undefined;
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

    return new Promise((resolve) => {

        // Common handler for processing compilation results
        const handleCompilationResult = async (launchError, stderror) => {
            if (stderror) {
                outputChannel.appendLine(`[Warning] Stderr: ${stderror}`);
            }

            // Clean up temporary batch file (Wine mode only)
            if (useWine && batFile) {
                cleanupBatchFile(batFile.unixPath);
            }

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
                outputChannel.appendLine(`[Error] Failed to read log file: ${err.message}`);
                return vscode.window.showErrorMessage(`${lg['err_read_log']} ${err.message}`), resolve();
            }

            config.LogFile.DeleteLog && fs.unlink(logFile, (err) => {
                err && vscode.window.showErrorMessage(lg['err_remove_log']);
            });

            log = replaceLog(data, rt === 0);

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

            outputChannel.appendLine(`[${time}] ${teq} '${fileName}' [${timeCompile}s]`);

            if (rt === 2 && !log.error) {
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
                                outputChannel.appendLine(`[Error]  ${lg['err_start_script']}: ${error.message}`);
                                cleanupBatchFile(rt2BatFile.unixPath);
                                resolve();
                            })
                            .on('close', () => {
                                outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                                cleanupBatchFile(rt2BatFile.unixPath);
                                resolve();
                            });
                    } catch (batchErr) {
                        outputChannel.appendLine(`[Error] Failed to create Wine batch file for script execution: ${batchErr.message}`);
                        resolve();
                    }
                } else {
                    // Direct execution on Windows – windowsVerbatimArguments keeps quotes intact (fixes #6)
                    const { executable, args } = buildMetaEditorCmd(MetaDir, [`/compile:${compileArg}`]);
                    childProcess.spawn(executable, args, { shell: false, windowsVerbatimArguments: true })
                        .on('error', (error) => {
                            outputChannel.appendLine(`[Error]  ${lg['err_start_script']}: ${error.message}`);
                            resolve();
                        })
                        .on('close', () => {
                            outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                            resolve();
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
}

async function Compile(rt, context) {
    await FixFormatting();
    // Save after formatting. Guard against re-entrant CheckOnSave triggers.
    internalSaveDepth++;
    try {
        await vscode.commands.executeCommand('workbench.action.files.saveAll');
    } finally {
        internalSaveDepth = Math.max(0, internalSaveDepth - 1);
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

        if (targets.length === 0) {
            // No targets resolved by mapping/inference (or user cancelled)
            // Fall back to magic comment for backward compatibility
            const magicPath = FindParentFile();
            if (magicPath && fs.existsSync(magicPath)) {
                pathsToCompile = [magicPath];
            } else {
                // If rt === 0 (checking), we can't fall back to current file for headers effectively
                // but we should check if we should allow checking the header itself or just warn.
                // Existing behavior for rt !== 0 was to warn.
                if (rt !== 0) {
                    return vscode.window.showWarningMessage(lg['mqh']);
                } else {
                    // For rt === 0, if no target found, just check the header itself as a fallback
                    pathsToCompile = [document.fileName];
                }
            }
        } else {
            pathsToCompile = targets;
        }
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

    // const startT = new Date();
    // const time = `${tf(startT, 'h')}:${tf(startT, 'm')}:${tf(startT, 's')}`;
    const teq = rt === 0 ? lg['checking'] : (rt === 1 ? lg['compiling'] : lg['comp_usi_script']);


    let hasErrors = false;
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: `MQL Tools: ${teq}`,
        },
        async () => {
            for (const pathToCompile of pathsToCompile) {
                const error = await compilePath(rt, pathToCompile, context);
                if (error) hasErrors = true;
            }
        }
    );

    // Refresh clangd diagnostics after compilation
    // This ensures the Problems panel reflects the actual compilation result
    await refreshClangdDiagnostics();

    // Focus Problems panel if there were errors, otherwise Output panel stays focused
    if (hasErrors) {
        await vscode.commands.executeCommand('workbench.panel.markers.view.focus');
    }
}

function replaceLog(str, f) {
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
                const link = url.pathToFileURL(mPath[0]).href;
                obj_hover[name] = { link };
                text += name + '\n';
            }
        }
        else if (REG_INCLUDE.test(item)) {
            const mName = item.match(/(?<=information: including ).+'/gi);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);
            if (mName && mPath) {
                const name = mName[0];
                const link = url.pathToFileURL(mPath[0]).href;
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
                const link = url.pathToFileURL(mPath[0]).href;
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
                        const fullPath = mFullPath[0].replace(/\($/, '').trim();
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

                        const linePos = link_res.match(REG_LINE_POS);
                        const hoverKey = (name_res + ' ' + (linePos ? linePos[0] : '')).trim();
                        obj_hover[hoverKey] = {
                            link: url.pathToFileURL(link_res).href.replace(REG_LINE_FRAGMENT, '#').replace(/\)$/gm, ''),
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

function tf(date, t, d) {

    switch (t) {
        case 'Y': d = date.getFullYear(); break;
        case 'M': d = date.getMonth() + 1; break;
        case 'D': d = date.getDate(); break;
        case 'h': d = date.getHours(); break;
        case 'm': d = date.getMinutes(); break;
        case 's': d = date.getSeconds(); break;
    }

    return d < 10 ? '0' + d.toString() : d.toString();
}

async function FixFormatting() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;
    const document = editor.document;
    const array = [];
    const data = {
        reg: [
            "\\bC '\\d{1,3},\\d{1,3},\\d{1,3}'",
            "\\bC '0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}'",
            "\\bD '(?:(?:\\d{2}|\\d{4})\\.\\d{2}\\.(?:\\d{2}|\\d{4})|(?:\\d{2}|\\d{4})\\.\\d{2}\\.(?:\\d{2}|\\d{4})\\s{1,}[\\d:]+)'"
        ],
        searchValue: [
            'C ',
            'C ',
            'D '
        ],
        replaceValue: [
            'C',
            'C',
            'D'
        ]
    };

    Array.from(document.getText().matchAll(new RegExp(CollectRegEx(data.reg), 'g'))).forEach(match => {
        for (const i in data.reg) {
            if (match[0].match(new RegExp(data.reg[i], 'g'))) {
                let range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
                array.push({ range, to: document.getText(range).replace(data.searchValue[i], data.replaceValue[i]) });
            }
        }
    });

    if (!array.length) return false;

    return await editor.edit(editBuilder => {
        for (const { range, to } of array) {
            editBuilder.replace(range, to);
        }
    });
}

function CollectRegEx(dt, string = '') {
    for (const i in dt) {
        string += dt[i] + '|';
    }
    return string.slice(0, -1);
}

/**
 * Code Action provider for MQL errors - offers quick fixes
 */
class MqlCodeActionProvider {
    provideCodeActions(document, _range, context) {
        const actions = [];

        for (const diagnostic of context.diagnostics) {
            const errorCode = diagnostic.code?.value; // e.g., "MQL199"
            const msg = diagnostic.message || '';



            // Handle clangd's "unknown type name 'XXX'" error
            const typeMatch = msg.match(/unknown type name '(\w+)'/i);
            if (typeMatch) {
                const typeName = typeMatch[1];
                const insertIncludeAction = new vscode.CodeAction(
                    `Add #ifdef __clang__ include for '${typeName}'`,
                    vscode.CodeActionKind.QuickFix
                );
                insertIncludeAction.edit = new vscode.WorkspaceEdit();
                const includeText = `#ifdef __clang__\n#include <${typeName}.mqh>  // TODO: Adjust path if needed\n#endif\n\n`;
                insertIncludeAction.edit.insert(document.uri, new vscode.Position(0, 0), includeText);
                insertIncludeAction.diagnostics = [diagnostic];
                actions.push(insertIncludeAction);
                continue;
            }

            // Phase 1A: Handle "wrong parameters count" error (MQL199)
            if (errorCode === 'MQL199' || diagnostic.message.includes('wrong parameters count')) {
                const funcMatch = diagnostic.message.match(/'(\w+)'/);
                if (funcMatch) {
                    const funcName = funcMatch[1];
                    const docsAction = this._createOpenDocsAction(funcName, diagnostic);
                    if (docsAction) actions.push(docsAction);
                }
            }

            // Phase 1B: Handle MQL "undeclared identifier" error (MQL256)
            if (errorCode === 'MQL256' || diagnostic.message.toLowerCase().includes('undeclared identifier')) {
                const identifierActions = this._createDeclareVariableActions(document, diagnostic);
                actions.push(...identifierActions);
            }

            // Spelling fix: Handle clangd's "use of undeclared identifier" for misspelled functions
            // clangd formats: "use of undeclared identifier 'X'" or "unknown identifier 'X'"
            // Also catches: "call to undeclared function", "undeclared identifier"
            const msgLower = msg.toLowerCase();
            if (msgLower.includes('undeclared') ||
                msgLower.includes('unknown') && msgLower.includes('identifier') ||
                msgLower.includes('not declared') ||
                msgLower.includes('was not declared')) {
                const spellingActions = this._createSpellingFixActions(document, diagnostic);
                // Add spelling fixes at the beginning for visibility
                actions.unshift(...spellingActions);
            }

            // Phase 1C: Handle "missing return" errors (MQL117, MQL121)
            if (errorCode === 'MQL117' || errorCode === 'MQL121' ||
                diagnostic.message.toLowerCase().includes('return')) {
                const returnAction = this._createAddReturnAction(document, diagnostic);
                if (returnAction) actions.push(returnAction);
            }

            // Phase 2: Handle "missing entry point" errors (MQL209, MQL356)
            if (errorCode === 'MQL209' || errorCode === 'MQL356') {
                const entryPointActions = this._createEntryPointActions(document, diagnostic, errorCode);
                actions.push(...entryPointActions);
            }

            // Phase 3: Handle "cannot convert to enum" error (MQL262)
            if (errorCode === 'MQL262' || diagnostic.message.toLowerCase().includes('cannot convert')) {
                const enumActions = this._createEnumSuggestionActions(document, diagnostic);
                actions.push(...enumActions);
            }

            // Phase 4: Handle "implicit conversion from 'number' to 'string'" warning (MQL181)
            if (errorCode === 'MQL181' && diagnostic.message.includes("implicit conversion from 'number' to 'string'")) {
                const conversionActions = this._createStringConversionActions(document, diagnostic);
                actions.push(...conversionActions);
            }

        }

        return actions;
    }

    /**
     * Phase 1A: Create action to open documentation for a function
     *
     * QuickFix Title Pattern: "MQL: Open documentation for '<function>'"
     * - Machine-recognizable prefix: "MQL: Open documentation for"
     * - Action: Opens MQL5 documentation for the specified function
     * - Safe: Yes (read-only, opens browser)
     */
    _createOpenDocsAction(funcName, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Open documentation for '${funcName}'`,
            vscode.CodeActionKind.QuickFix
        );

        // Use command to trigger Help system with the function name
        action.command = {
            command: 'mql_tools.help',
            title: 'Open documentation',
            arguments: [funcName, 5]  // Pass function name and default to MQL5
        };

        action.diagnostics = [diagnostic];
        action.isPreferred = true; // Show first in quickfix list

        return action;
    }

    /**
     * Phase 1B: Create quick fix actions to declare an undeclared variable
     */
    _createDeclareVariableActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const col = diagnostic.range.start.character;

        // Extract the identifier name from the document at the error position
        const lineText = document.lineAt(line).text;
        const identifierMatch = lineText.substring(col).match(/^(\w+)/);
        if (!identifierMatch) return actions;

        const identifier = identifierMatch[1];

        // Add input parameter option first (most common for EAs/indicators)
        const inputAction = this._createInputDeclarationAction(document, identifier, diagnostic);
        if (inputAction) {
            actions.push(inputAction);
        }

        // Then add local variable options
        // QuickFix Title Pattern: "MQL: Declare '<identifier>' as local <type>"
        // - Machine-recognizable prefix: "MQL: Declare"
        // - Action: Inserts local variable declaration
        // - Safe: Yes (adds code, does not modify existing)
        const commonTypes = ['int', 'double', 'string', 'bool', 'color', 'datetime', 'long'];

        // Find the start of the current function/block to insert declaration
        const funcStart = this._findFunctionStart(document, line);

        for (const type of commonTypes) {
            const action = new vscode.CodeAction(
                `MQL: Declare '${identifier}' as local ${type}`,
                vscode.CodeActionKind.QuickFix
            );
            action.edit = new vscode.WorkspaceEdit();

            if (funcStart !== null) {
                // Insert at start of function body
                const insertLine = funcStart.line + 1;
                const indent = this._getIndent(document, insertLine);
                action.edit.insert(
                    document.uri,
                    new vscode.Position(insertLine, 0),
                    `${indent}${type} ${identifier};\n`
                );
            } else {
                // Insert on the line before the error
                const indent = this._getIndent(document, line);
                action.edit.insert(
                    document.uri,
                    new vscode.Position(line, 0),
                    `${indent}${type} ${identifier};\n`
                );
            }

            action.diagnostics = [diagnostic];
            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 1B: Create action to declare as input parameter
     *
     * QuickFix Title Pattern: "MQL: Declare '<identifier>' as input parameter"
     * - Machine-recognizable prefix: "MQL: Declare"
     * - Action: Inserts input parameter declaration at file header
     * - Safe: Yes (adds code, does not modify existing)
     */
    _createInputDeclarationAction(document, identifier, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Declare '${identifier}' as input parameter`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Find position to insert (after existing inputs or at top)
        const insertPos = this._findInputInsertPosition(document);

        // Guess type based on identifier name
        const type = this._guessInputType(identifier);
        const defaultValue = this._getDefaultValue(type);

        const inputLine = `input ${type} ${identifier} = ${defaultValue};  // TODO: Adjust type and default\n`;

        action.edit.insert(document.uri, insertPos, inputLine);
        action.diagnostics = [diagnostic];
        action.isPreferred = true; // Prefer input declaration for EAs

        return action;
    }

    /**
     * Find the opening brace of the containing function
     */
    _findFunctionStart(document, fromLine) {
        let braceCount = 0;
        for (let i = fromLine; i >= 0; i--) {
            const text = document.lineAt(i).text;
            for (let j = text.length - 1; j >= 0; j--) {
                if (text[j] === '}') braceCount++;
                if (text[j] === '{') {
                    if (braceCount === 0) {
                        return { line: i, character: j };
                    }
                    braceCount--;
                }
            }
        }
        return null;
    }

    /**
     * Get the indentation of a line
     */
    _getIndent(document, lineNum) {
        if (lineNum >= document.lineCount) return '    ';
        const lineText = document.lineAt(lineNum).text;
        const match = lineText.match(/^(\s*)/);
        return match ? match[1] : '    ';
    }

    /**
     * Phase 1B: Find best position to insert input declaration
     */
    _findInputInsertPosition(document) {
        // Look for existing input declarations
        for (let i = 0; i < Math.min(50, document.lineCount); i++) {
            const line = document.lineAt(i).text;
            if (line.match(/^\s*input\s+/)) {
                // Found existing input, insert after last one
                let lastInputLine = i;
                for (let j = i + 1; j < Math.min(100, document.lineCount); j++) {
                    if (document.lineAt(j).text.match(/^\s*input\s+/)) {
                        lastInputLine = j;
                    } else if (document.lineAt(j).text.trim() &&
                        !document.lineAt(j).text.trim().startsWith('//')) {
                        break;
                    }
                }
                return new vscode.Position(lastInputLine + 1, 0);
            }
        }

        // No existing inputs, insert after #property lines or at top
        for (let i = 0; i < Math.min(20, document.lineCount); i++) {
            const line = document.lineAt(i).text;
            if (!line.trim().startsWith('#') && !line.trim().startsWith('//') && line.trim()) {
                return new vscode.Position(i, 0);
            }
        }

        return new vscode.Position(0, 0);
    }

    /**
     * Phase 1B: Guess input type from identifier name
     */
    _guessInputType(identifier) {
        const lower = identifier.toLowerCase();
        if (lower.includes('lot') || lower.includes('volume')) return 'double';
        if (lower.includes('magic') || lower.includes('period') || lower.includes('shift')) return 'int';
        if (lower.includes('enable') || lower.includes('use') || lower.includes('show')) return 'bool';
        if (lower.includes('comment') || lower.includes('symbol')) return 'string';
        if (lower.includes('color') || lower.includes('clr')) return 'color';
        return 'double'; // Default
    }

    /**
     * Phase 1B: Get default value for type
     */
    _getDefaultValue(type) {
        const defaults = {
            'int': '0',
            'double': '0.1',
            'bool': 'true',
            'string': '""',
            'color': 'clrRed',
            'datetime': '0',
            'long': '0'
        };
        return defaults[type] || '0';
    }

    /**
     * Phase 1C: Create action to add default return statement
     *
     * QuickFix Title Pattern: "MQL: Add return statement '<value>'"
     * - Machine-recognizable prefix: "MQL: Add return statement"
     * - Action: Inserts return statement at end of function
     * - Safe: Yes (adds code at function end)
     */
    _createAddReturnAction(document, diagnostic) {
        const line = diagnostic.range.start.line;

        // Find function signature to determine return type
        const returnType = this._findFunctionReturnType(document, line);
        if (!returnType || returnType === 'void') return null;

        const defaultValue = this._getReturnDefaultValue(returnType);

        const action = new vscode.CodeAction(
            `MQL: Add return statement '${defaultValue}'`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Find closing brace of function
        const closingBrace = this._findFunctionClosingBrace(document, line);
        if (closingBrace) {
            const indent = this._getIndent(document, closingBrace.line);
            action.edit.insert(
                document.uri,
                new vscode.Position(closingBrace.line, 0),
                `${indent}return ${defaultValue};\n`
            );
        }

        action.diagnostics = [diagnostic];
        return action;
    }

    /**
     * Phase 1C: Find function return type
     */
    _findFunctionReturnType(document, fromLine) {
        // Search backwards for function signature
        for (let i = fromLine; i >= Math.max(0, fromLine - 50); i--) {
            const line = document.lineAt(i).text;
            // Match function signature: returnType functionName(...)
            const match = line.match(/^\s*(int|double|bool|string|long|ulong|datetime|color|void)\s+\w+\s*\(/);
            if (match) {
                return match[1];
            }
        }
        return null;
    }

    /**
     * Phase 1C: Get default return value for type
     */
    _getReturnDefaultValue(type) {
        const defaults = {
            'int': '0',
            'double': '0.0',
            'bool': 'false',
            'string': '""',
            'long': '0',
            'ulong': '0',
            'datetime': '0',
            'color': 'clrNONE'
        };
        return defaults[type] || '0';
    }

    /**
     * Phase 1C: Find closing brace of function
     */
    _findFunctionClosingBrace(document, fromLine) {
        let braceCount = 0;
        let foundStart = false;

        for (let i = fromLine; i < document.lineCount; i++) {
            const text = document.lineAt(i).text;
            for (let j = 0; j < text.length; j++) {
                if (text[j] === '{') {
                    braceCount++;
                    foundStart = true;
                }
                if (text[j] === '}') {
                    braceCount--;
                    if (foundStart && braceCount === 0) {
                        return { line: i, character: j };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Phase 2: Create entry point skeleton actions
     */
    _createEntryPointActions(document, diagnostic, errorCode) {
        const actions = [];

        // Determine file type and appropriate entry points
        if (errorCode === 'MQL209') {
            // Indicator missing OnCalculate
            const action = this._createInsertEntryPointAction(
                document,
                'OnCalculate',
                this._getOnCalculateTemplate(),
                diagnostic
            );
            if (action) actions.push(action);
        } else if (errorCode === 'MQL356') {
            // EA or Script missing entry point
            // Offer both OnTick (EA) and OnStart (Script)
            const onTickAction = this._createInsertEntryPointAction(
                document,
                'OnTick',
                this._getOnTickTemplate(),
                diagnostic
            );
            if (onTickAction) actions.push(onTickAction);

            const onStartAction = this._createInsertEntryPointAction(
                document,
                'OnStart',
                this._getOnStartTemplate(),
                diagnostic
            );
            if (onStartAction) actions.push(onStartAction);
        }

        return actions;
    }

    /**
     * Phase 2: Create action to insert entry point template
     *
     * QuickFix Title Pattern: "MQL: Insert entry point '<function>'"
     * - Machine-recognizable prefix: "MQL: Insert entry point"
     * - Action: Inserts complete function skeleton (OnCalculate/OnTick/OnStart)
     * - Safe: Yes (adds code at file end)
     */
    _createInsertEntryPointAction(document, entryPointName, template, diagnostic) {
        const action = new vscode.CodeAction(
            `MQL: Insert entry point '${entryPointName}()'`,
            vscode.CodeActionKind.QuickFix
        );

        action.edit = new vscode.WorkspaceEdit();

        // Insert at end of file
        const lastLine = document.lineCount;
        action.edit.insert(
            document.uri,
            new vscode.Position(lastLine, 0),
            `\n${template}\n`
        );

        action.diagnostics = [diagnostic];
        action.isPreferred = true;

        return action;
    }

    /**
     * Phase 2: Get OnCalculate template for indicators
     */
    _getOnCalculateTemplate() {
        return `int OnCalculate(const int rates_total,
                const int prev_calculated,
                const int begin,
                const double &price[])
{
    // TODO: Implement indicator calculation

    return rates_total;
}`;
    }

    /**
     * Phase 2: Get OnTick template for EAs
     */
    _getOnTickTemplate() {
        return `void OnTick()
{
    // TODO: Implement trading logic

}`;
    }

    /**
     * Phase 2: Get OnStart template for scripts
     */
    _getOnStartTemplate() {
        return `void OnStart()
{
    // TODO: Implement script logic

}`;
    }

    /**
     * Phase 3: Create enum suggestion actions
     *
     * QuickFix Title Pattern: "MQL: Use enum '<ENUM_VALUE>' (<description>)"
     * - Machine-recognizable prefix: "MQL: Use enum"
     * - Action: Replaces numeric literal with proper MQL enum constant
     * - Safe: Yes (replaces value with equivalent enum)
     */
    _createEnumSuggestionActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const lineText = document.lineAt(line).text;

        // Try to find function call context
        const funcMatch = lineText.match(/(\w+)\s*\(/);
        if (!funcMatch) return actions;

        const funcName = funcMatch[1];

        // Get enum suggestions for this function
        const enumSuggestions = this._getEnumSuggestionsForFunction(funcName, lineText);

        for (const suggestion of enumSuggestions) {
            const action = new vscode.CodeAction(
                `MQL: Use enum '${suggestion.value}' (${suggestion.description})`,
                vscode.CodeActionKind.QuickFix
            );

            action.edit = new vscode.WorkspaceEdit();

            // Find the problematic parameter (usually a number like 0)
            const paramMatch = lineText.match(/,\s*(\d+)\s*[,)]/);
            if (paramMatch) {
                const startPos = lineText.indexOf(paramMatch[1], paramMatch.index);
                action.edit.replace(
                    document.uri,
                    new vscode.Range(
                        new vscode.Position(line, startPos),
                        new vscode.Position(line, startPos + paramMatch[1].length)
                    ),
                    suggestion.value
                );
            }

            action.diagnostics = [diagnostic];
            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 3: Get enum suggestions for specific functions
     *
     * ENUM_SUGGESTIONS Structure:
     * - Organized by function name for fast lookup
     * - Each function maps to array of { value, description, enumType, paramIndex }
     * - enumType: The MQL5 enum type (for documentation)
     * - paramIndex: 1-based parameter position in function signature
     * - Derived from files/mql_clangd_compat.h function signatures
     *
     * Machine-readable format for LLM agents:
     * - Consistent structure enables programmatic selection
     * - Description aids understanding without docs lookup
     * - enumType enables type-aware filtering
     */
    _getEnumSuggestionsForFunction(funcName) {
        // =================================================================
        // COMPREHENSIVE ENUM SUGGESTIONS MAPPING
        // Based on MQL5 function signatures from mql_clangd_compat.h
        // =================================================================

        /**
         * Shared enum value sets (reused across multiple functions)
         */
        const ENUM_TIMEFRAMES = [
            { value: 'PERIOD_CURRENT', description: 'Current chart timeframe', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M1', description: '1 minute', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M5', description: '5 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M15', description: '15 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_M30', description: '30 minutes', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_H1', description: '1 hour', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_H4', description: '4 hours', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_D1', description: 'Daily', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_W1', description: 'Weekly', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 },
            { value: 'PERIOD_MN1', description: 'Monthly', enumType: 'ENUM_TIMEFRAMES', paramIndex: 2 }
        ];

        const ENUM_MA_METHOD = [
            { value: 'MODE_SMA', description: 'Simple Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_EMA', description: 'Exponential Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_SMMA', description: 'Smoothed Moving Average', enumType: 'ENUM_MA_METHOD' },
            { value: 'MODE_LWMA', description: 'Linear Weighted Moving Average', enumType: 'ENUM_MA_METHOD' }
        ];

        const ENUM_APPLIED_PRICE = [
            { value: 'PRICE_CLOSE', description: 'Close price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_OPEN', description: 'Open price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_HIGH', description: 'High price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_LOW', description: 'Low price', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_MEDIAN', description: 'Median price (HL/2)', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_TYPICAL', description: 'Typical price (HLC/3)', enumType: 'ENUM_APPLIED_PRICE' },
            { value: 'PRICE_WEIGHTED', description: 'Weighted price (HLCC/4)', enumType: 'ENUM_APPLIED_PRICE' }
        ];

        const ENUM_APPLIED_VOLUME = [
            { value: 'VOLUME_TICK', description: 'Tick volume', enumType: 'ENUM_APPLIED_VOLUME' },
            { value: 'VOLUME_REAL', description: 'Real volume', enumType: 'ENUM_APPLIED_VOLUME' }
        ];

        const ENUM_STO_PRICE = [
            { value: 'STO_LOWHIGH', description: 'Low/High prices', enumType: 'ENUM_STO_PRICE' },
            { value: 'STO_CLOSECLOSE', description: 'Close/Close prices', enumType: 'ENUM_STO_PRICE' }
        ];

        const ENUM_ORDER_TYPE = [
            { value: 'ORDER_TYPE_BUY', description: 'Market buy order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL', description: 'Market sell order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_BUY_LIMIT', description: 'Buy limit pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL_LIMIT', description: 'Sell limit pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_BUY_STOP', description: 'Buy stop pending order', enumType: 'ENUM_ORDER_TYPE' },
            { value: 'ORDER_TYPE_SELL_STOP', description: 'Sell stop pending order', enumType: 'ENUM_ORDER_TYPE' }
        ];

        const ENUM_ORDER_FILLING = [
            { value: 'ORDER_FILLING_FOK', description: 'Fill or Kill - complete fill only', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_IOC', description: 'Immediate or Cancel - partial allowed', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_RETURN', description: 'Return - partial fills returned', enumType: 'ENUM_ORDER_TYPE_FILLING' },
            { value: 'ORDER_FILLING_BOC', description: 'Book or Cancel', enumType: 'ENUM_ORDER_TYPE_FILLING' }
        ];

        const ENUM_TRADE_REQUEST_ACTIONS = [
            { value: 'TRADE_ACTION_DEAL', description: 'Place market order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_PENDING', description: 'Place pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_SLTP', description: 'Modify SL/TP of position', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_MODIFY', description: 'Modify pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_REMOVE', description: 'Delete pending order', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' },
            { value: 'TRADE_ACTION_CLOSE_BY', description: 'Close position by opposite', enumType: 'ENUM_TRADE_REQUEST_ACTIONS' }
        ];

        // =================================================================
        // FUNCTION-SPECIFIC ENUM MAPPINGS
        // Signature: functionName(param1, param2, ...) - paramIndex is 1-based
        // =================================================================

        const ENUM_SUGGESTIONS = {
            // ---------------------------------------------------------------
            // INDICATOR FUNCTIONS (Technical Analysis)
            // ---------------------------------------------------------------

            // iMA(symbol, period, ma_period, ma_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iRSI(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iRSI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iMACD(symbol, period, fast_ema_period, slow_ema_period, signal_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iMACD': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iStochastic(symbol, period, Kperiod, Dperiod, slowing, ma_method, price_field)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_MA_METHOD, Param 7: ENUM_STO_PRICE
            'iStochastic': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 6 })),
                ...ENUM_STO_PRICE.map(e => ({ ...e, paramIndex: 7 }))
            ],

            // iBands(symbol, period, bands_period, bands_shift, deviation, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iBands': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iCCI(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iCCI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iMomentum(symbol, period, mom_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iMomentum': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iATR(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iATR': [...ENUM_TIMEFRAMES],

            // iADX(symbol, period, adx_period)
            // Param 2: ENUM_TIMEFRAMES
            'iADX': [...ENUM_TIMEFRAMES],

            // iMFI(symbol, period, ma_period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_VOLUME
            'iMFI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iOBV(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iOBV': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iVolumes(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iVolumes': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iAD(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iAD': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iForce(symbol, period, ma_period, ma_method, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_MA_METHOD, Param 5: ENUM_APPLIED_VOLUME
            'iForce': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 4 })),
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iChaikin(symbol, period, fast_ma_period, slow_ma_period, ma_method, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_VOLUME
            'iChaikin': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iEnvelopes(symbol, period, ma_period, ma_shift, ma_method, applied_price, deviation)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iEnvelopes': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iStdDev(symbol, period, ma_period, ma_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_MA_METHOD, Param 6: ENUM_APPLIED_PRICE
            'iStdDev': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 5 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iDEMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iDEMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iTEMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iTEMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iFrAMA(symbol, period, ma_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 5: ENUM_APPLIED_PRICE
            'iFrAMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 5 }))
            ],

            // iAMA(symbol, period, ama_period, fast_ma_period, slow_ma_period, ama_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 7: ENUM_APPLIED_PRICE
            'iAMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 7 }))
            ],

            // iVIDyA(symbol, period, cmo_period, ema_period, ma_shift, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iVIDyA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iTriX(symbol, period, ma_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 4: ENUM_APPLIED_PRICE
            'iTriX': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 4 }))
            ],

            // iOsMA(symbol, period, fast_ema_period, slow_ema_period, signal_period, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 6: ENUM_APPLIED_PRICE
            'iOsMA': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 6 }))
            ],

            // iWPR(symbol, period, calc_period)
            // Param 2: ENUM_TIMEFRAMES
            'iWPR': [...ENUM_TIMEFRAMES],

            // iSAR(symbol, period, step, maximum)
            // Param 2: ENUM_TIMEFRAMES
            'iSAR': [...ENUM_TIMEFRAMES],

            // iRVI(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iRVI': [...ENUM_TIMEFRAMES],

            // iDeMarker(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iDeMarker': [...ENUM_TIMEFRAMES],

            // iFractals(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iFractals': [...ENUM_TIMEFRAMES],

            // iAC(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iAC': [...ENUM_TIMEFRAMES],

            // iAO(symbol, period)
            // Param 2: ENUM_TIMEFRAMES
            'iAO': [...ENUM_TIMEFRAMES],

            // iBWMFI(symbol, period, applied_volume)
            // Param 2: ENUM_TIMEFRAMES, Param 3: ENUM_APPLIED_VOLUME
            'iBWMFI': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_APPLIED_VOLUME.map(e => ({ ...e, paramIndex: 3 }))
            ],

            // iBearsPower(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iBearsPower': [...ENUM_TIMEFRAMES],

            // iBullsPower(symbol, period, ma_period)
            // Param 2: ENUM_TIMEFRAMES
            'iBullsPower': [...ENUM_TIMEFRAMES],

            // iAlligator(symbol, period, jaw_period, jaw_shift, teeth_period, teeth_shift, lips_period, lips_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 9: ENUM_MA_METHOD, Param 10: ENUM_APPLIED_PRICE
            'iAlligator': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 9 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 10 }))
            ],

            // iGator(symbol, period, jaw_period, jaw_shift, teeth_period, teeth_shift, lips_period, lips_shift, ma_method, applied_price)
            // Param 2: ENUM_TIMEFRAMES, Param 9: ENUM_MA_METHOD, Param 10: ENUM_APPLIED_PRICE
            'iGator': [
                ...ENUM_TIMEFRAMES,
                ...ENUM_MA_METHOD.map(e => ({ ...e, paramIndex: 9 })),
                ...ENUM_APPLIED_PRICE.map(e => ({ ...e, paramIndex: 10 }))
            ],

            // iIchimoku(symbol, period, tenkan_sen, kijun_sen, senkou_span_b)
            // Param 2: ENUM_TIMEFRAMES
            'iIchimoku': [...ENUM_TIMEFRAMES],

            // ---------------------------------------------------------------
            // TIMESERIES / DATA COPY FUNCTIONS
            // ---------------------------------------------------------------

            // CopyRates(symbol, timeframe, start_pos, count, rates_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyRates': [...ENUM_TIMEFRAMES],

            // CopyTime(symbol, timeframe, start_pos, count, time_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyTime': [...ENUM_TIMEFRAMES],

            // CopyOpen(symbol, timeframe, start_pos, count, open_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyOpen': [...ENUM_TIMEFRAMES],

            // CopyHigh(symbol, timeframe, start_pos, count, high_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyHigh': [...ENUM_TIMEFRAMES],

            // CopyLow(symbol, timeframe, start_pos, count, low_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyLow': [...ENUM_TIMEFRAMES],

            // CopyClose(symbol, timeframe, start_pos, count, close_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyClose': [...ENUM_TIMEFRAMES],

            // CopyTickVolume(symbol, timeframe, start_pos, count, volume_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyTickVolume': [...ENUM_TIMEFRAMES],

            // CopyRealVolume(symbol, timeframe, start_pos, count, volume_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopyRealVolume': [...ENUM_TIMEFRAMES],

            // CopySpread(symbol, timeframe, start_pos, count, spread_array[])
            // Param 2: ENUM_TIMEFRAMES
            'CopySpread': [...ENUM_TIMEFRAMES],

            // iBars(symbol, timeframe)
            // Param 2: ENUM_TIMEFRAMES
            'iBars': [...ENUM_TIMEFRAMES],

            // iBarShift(symbol, timeframe, time, exact)
            // Param 2: ENUM_TIMEFRAMES
            'iBarShift': [...ENUM_TIMEFRAMES],

            // iOpen(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iOpen': [...ENUM_TIMEFRAMES],

            // iClose(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iClose': [...ENUM_TIMEFRAMES],

            // iHigh(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iHigh': [...ENUM_TIMEFRAMES],

            // iLow(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iLow': [...ENUM_TIMEFRAMES],

            // iTime(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iTime': [...ENUM_TIMEFRAMES],

            // iVolume(symbol, timeframe, shift)
            // Param 2: ENUM_TIMEFRAMES
            'iVolume': [...ENUM_TIMEFRAMES],

            // iHighest(symbol, timeframe, type, count, start)
            // Param 2: ENUM_TIMEFRAMES
            'iHighest': [...ENUM_TIMEFRAMES],

            // iLowest(symbol, timeframe, type, count, start)
            // Param 2: ENUM_TIMEFRAMES
            'iLowest': [...ENUM_TIMEFRAMES],

            // SeriesInfoInteger(symbol, timeframe, prop_id)
            // Param 2: ENUM_TIMEFRAMES
            'SeriesInfoInteger': [...ENUM_TIMEFRAMES],

            // IndicatorCreate(symbol, period, indicator_type, ...)
            // Param 2: ENUM_TIMEFRAMES
            'IndicatorCreate': [...ENUM_TIMEFRAMES],

            // ---------------------------------------------------------------
            // TRADING FUNCTIONS (MQL5)
            // ---------------------------------------------------------------

            // OrderSend - uses MqlTradeRequest struct, but often appears in context
            // Suggest common trade action and order types
            'OrderSend': [
                ...ENUM_TRADE_REQUEST_ACTIONS,
                ...ENUM_ORDER_TYPE,
                ...ENUM_ORDER_FILLING
            ],

            // OrderCheck - same as OrderSend
            'OrderCheck': [
                ...ENUM_TRADE_REQUEST_ACTIONS,
                ...ENUM_ORDER_TYPE,
                ...ENUM_ORDER_FILLING
            ]
        };

        return ENUM_SUGGESTIONS[funcName] || [];
    }

    /**
     * Create spelling fix actions for misspelled function names
     * Uses Levenshtein distance to find closest matches
     *
     * QuickFix Title Pattern: "MQL: Did you mean '<function>'?"
     * - Machine-recognizable prefix: "MQL: Did you mean"
     * - Action: Replaces misspelled identifier with correct function name
     * - Safe: Yes (replaces text at error location)
     *
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diagnostic
     * @returns {vscode.CodeAction[]}
     */
    _createSpellingFixActions(document, diagnostic) {
        const actions = [];
        const line = diagnostic.range.start.line;
        const col = diagnostic.range.start.character;

        // Try to extract identifier from error message first (clangd format: 'identifier')
        let misspelled = null;
        const msgMatch = diagnostic.message.match(/'(\w+)'/);
        if (msgMatch) {
            misspelled = msgMatch[1];
        }

        // Fallback: Extract from document at diagnostic position
        if (!misspelled) {
            const lineText = document.lineAt(line).text;
            const wordMatch = lineText.substring(col).match(/^(\w+)/);
            if (wordMatch) {
                misspelled = wordMatch[1];
            }
        }

        if (!misspelled) return actions;

        // Skip if too short (likely not a function name typo)
        if (misspelled.length < 4) return actions;

        // Find closest matches using Levenshtein distance
        const matches = findClosestMatches(misspelled, 2, 3);

        for (const match of matches) {
            const action = new vscode.CodeAction(
                `MQL: Did you mean '${match.name}'?`,
                vscode.CodeActionKind.QuickFix
            );

            action.edit = new vscode.WorkspaceEdit();

            // Calculate the exact range of the misspelled word
            const startPos = new vscode.Position(line, col);
            const endPos = new vscode.Position(line, col + misspelled.length);

            action.edit.replace(document.uri, new vscode.Range(startPos, endPos), match.name);
            action.diagnostics = [diagnostic];

            // Mark distance-1 matches as preferred (high confidence)
            if (match.distance === 1) {
                action.isPreferred = true;
            }

            actions.push(action);
        }

        return actions;
    }

    /**
     * Phase 4: Create actions to fix implicit number to string conversion
     *
     * QuickFix Title Pattern: "MQL: Wrap with IntegerToString()" or "MQL: Wrap with DoubleToString()"
     * - Machine-recognizable prefix: "MQL: Wrap with"
     * - Action: Wraps the numeric value at the diagnostic location with a conversion function
     * - Safe: Yes (wraps existing code)
     *
     * @param {vscode.TextDocument} document
     * @param {vscode.Diagnostic} diagnostic
     * @returns {vscode.CodeAction[]}
     */
    _createStringConversionActions(document, diagnostic) {
        const actions = [];
        const range = diagnostic.range;

        // Get the text at the diagnostic range
        const problematicText = document.getText(range);

        // Skip if already wrapped in a conversion function
        if (problematicText.includes('ToString(')) {
            return actions;
        }

        // Expand range to capture the full expression if it's short (single character like a number)
        let expandedRange = range;

        // If range is very small, try to find the full identifier/number
        if (range.end.character - range.start.character <= 1) {
            // Find word boundaries around the position
            const wordRange = document.getWordRangeAtPosition(range.start, /[\w.]+/);
            if (wordRange) {
                expandedRange = wordRange;
            }
        }

        const valueToWrap = document.getText(expandedRange);

        // Skip empty or already wrapped values
        if (!valueToWrap || valueToWrap.includes('ToString(')) {
            return actions;
        }

        // Create IntegerToString action
        const intAction = new vscode.CodeAction(
            'MQL: Wrap with IntegerToString()',
            vscode.CodeActionKind.QuickFix
        );
        intAction.edit = new vscode.WorkspaceEdit();
        intAction.edit.replace(
            document.uri,
            expandedRange,
            `IntegerToString(${valueToWrap})`
        );
        intAction.diagnostics = [diagnostic];
        actions.push(intAction);

        // Create DoubleToString action
        const doubleAction = new vscode.CodeAction(
            'MQL: Wrap with DoubleToString()',
            vscode.CodeActionKind.QuickFix
        );
        doubleAction.edit = new vscode.WorkspaceEdit();
        doubleAction.edit.replace(
            document.uri,
            expandedRange,
            `DoubleToString(${valueToWrap}, 8)`
        );
        doubleAction.diagnostics = [diagnostic];
        actions.push(doubleAction);

        // If it looks like an integer (no decimal point), prefer IntegerToString
        if (/^\d+$/.test(valueToWrap) || /^[A-Z_][A-Z0-9_]*$/.test(valueToWrap)) {
            intAction.isPreferred = true;
        } else if (valueToWrap.includes('.')) {
            doubleAction.isPreferred = true;
        }

        return actions;
    }
}

function activate(context) {
    // Initialize VS Code API-dependent variables (must be inside activate, not at module level)
    diagnosticCollection = vscode.languages.createDiagnosticCollection('mql');
    outputChannel = vscode.window.createOutputChannel('MQL', 'mql-output');

    const extensionId = 'ngsoftware.mql-tools';
    const currentVersion = vscode.extensions.getExtension(extensionId)?.packageJSON.version;
    const previousVersion = context.globalState.get('mql-tools.version');

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

    // Wait for environment to stabilize before migration check
    sleep(2000).then(() => {
        if (previousVersion !== currentVersion) {
            if (currentVersion === '1.0.0' || currentVersion === '1.0.1' || currentVersion === '1.0.2') {
                CreateProperties().then(() => {
                    // Update successful info message
                    // console.log(`MQL Tools: Migrated to v${currentVersion}`);
                });
            }
            context.globalState.update('mql-tools.version', currentVersion);
        }
    });

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.checkFile', () => Compile(0, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileFile', () => Compile(1, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileScript', () => Compile(2, context)));
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
                console.error('Failed to reset some compile targets:', failed);
                vscode.window.showWarningMessage(`Reset complete with ${failed.length} errors. Check console for details.`);
            } else {
                vscode.window.showInformationMessage('All compile target mappings reset');
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.configurations', async () => {
        await CreateProperties();
        try {
            await vscode.commands.executeCommand('clangd.restart');
        } catch (error) {
            // clangd extension may not be installed - silently ignore
        }
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
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openTradingTerminal', () => OpenTradingTerminal()));
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

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.switchLogMode', async () => {
        const current = logTailer.mode;
        const items = [
            { label: 'LiveLog (Real-time)', description: 'Tail MQL5/Files/LiveLog.txt - requires PrintLive() in EA', mode: 'livelog' },
            { label: 'Standard Journal', description: 'Tail MQL5/Logs/YYYYMMDD.log - uses Print() output (not real-time)', mode: 'standard' }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Current: ${current === 'livelog' ? 'LiveLog (Real-time)' : 'Standard Journal'}`
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

    context.subscriptions.push(vscode.languages.registerHoverProvider('mql-output', Hover_log()));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider('mql-output', DefinitionProvider()));
    context.subscriptions.push(vscode.languages.registerHoverProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, Hover_MQL()));
    context.subscriptions.push(vscode.languages.registerColorProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, ColorProvider()));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, ItemProvider()));
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, MQLDocumentSymbolProvider()));
    sleep(1000).then(() => { context.subscriptions.push(vscode.languages.registerSignatureHelpProvider({ pattern: '**/*.{mq4,mq5,mqh}' }, HelpProvider(), '(', ',')); });

    // Register lightweight diagnostics (instant feedback without MetaEditor)
    registerLightweightDiagnostics(context);

    // Register Code Action provider for MQL quick fixes
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*.{mq4,mq5,mqh}' },
        new MqlCodeActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
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
        autoCheckTimer = setTimeout(async () => {
            isAutoCheckRunning = true;
            const activeDoc = vscode.window.activeTextEditor?.document;
            const checkingUri = activeDoc?.uri.toString();

            try {
                await Compile(0, context); // Syntax check (no compilation)
            } finally {
                // Record the final document version after our edits complete
                // This prevents re-triggering from FixFormatting or save changes
                if (checkingUri && vscode.window.activeTextEditor?.document.uri.toString() === checkingUri) {
                    autoCheckDocVersions.set(checkingUri, vscode.window.activeTextEditor.document.version);
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
            await Compile(0, context); // Syntax check
        } finally {
            isAutoCheckRunning = false;
        }
    }));

    // Auto-compile once when workspace finishes loading (regardless of configuration)
    sleep(3000).then(async () => {
        if (isAutoCheckRunning) return;

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const ext = pathModule.extname(editor.document.fileName).toLowerCase();
            if (['.mq4', '.mq5', '.mqh'].includes(ext)) {
                isAutoCheckRunning = true;
                try {
                    await Compile(0, context); // Syntax check on startup
                } finally {
                    isAutoCheckRunning = false;
                }
            }
        }
    });

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
                    // console.log(`[MQL Index] Invalidated cache for ${folder.name} (debounced)`);
                }
            }
            pendingDirtyFolders.clear();
            indexInvalidationTimer = null;
        }, INDEX_DEBOUNCE_MS);
    };

    fileWatcher.onDidChange(debouncedMarkDirty);
    fileWatcher.onDidCreate(debouncedMarkDirty);
    fileWatcher.onDidDelete(debouncedMarkDirty);
    context.subscriptions.push(fileWatcher);


}

function deactivate() {
    logTailer.stop();
}


module.exports = {
    activate,
    deactivate,
    replaceLog,
    tf,
    buildMetaEditorCmd
};
