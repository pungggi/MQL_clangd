'use strict';

const url = require('url');
const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const pathModule = require('path');
const sleep = require('util').promisify(setTimeout);
const fsPromises = fs.promises;

const lg = require('./language');
const { generatePortableSwitch, resolvePathRelativeToWorkspace } = require('./createProperties');
const { resolvecompileTargets, getcompileTargets } = require('./compileTargetResolver');
const {
    resolveWineConfig,
    convertPathForWine,
    validateWinePath,
} = require('./wineHelper');
const { tf, fixFormatting, findParentFile } = require('./formatting');

// =============================================================================
// REGEX CONSTANTS - compiler output parsing
// =============================================================================
// --- Line-level classification (used with .test(), no /g flag) ---
const REG_COMPILING = /: information: (?:compiling|checking)/;
const REG_INCLUDE = /: information: including/;
const REG_INFO = /: information: info/;
const REG_RESULT = /(?:Result:|: information: result)/;

// --- Result-line sub-patterns ---
const REG_ERR_WAR = /(?!0)\d+.(?:error|warning)/;
const REG_RESULT_SHORT = /\d+.error.+/;

// --- Diagnostic path/position extraction ---
const REG_LINE_PATH = /([a-zA-Z]:\\.+(?= :)|^\(\d+,\d+\))(?:.: )(.+)/;
const REG_ERROR_CODE = /(?<=error |warning )\d+/;
const REG_FULL_PATH = /[a-z]:\\.+/gi;
const REG_LINE_POS = /\((?:\d+,\d+)\)$/gm;
const REG_LINE_FRAGMENT = /\((?=(\d+,\d+).$)/gm;

// --- Shared path pattern: Windows drive path before " :" separator ---
const REG_PATH_BEFORE_SEP = /[a-zA-Z]:\\.+(?= :)/gi;

// --- Name extraction from log categories ---
const REG_COMPILING_NAME = /(?<=compiling ).+'/gi;
const REG_CHECKING_NAME = /(?<=checking ).+'/gi;
const REG_INCLUDE_NAME = /(?<=information: including ).+'/gi;
const REG_INFO_NAME = /(?<=information: ).+/gi;

// --- Diagnostic detail extraction ---
const REG_DIAGNOSTIC_FULL_PATH = /[a-zA-Z]:\\[^(\r\n]+/g;
const REG_DIAGNOSTIC_POS = /\((\d+),(\d+)\)$/;
const REG_LINE_SUFFIX = /(.)(?:\d+,\d+).$/gm;

// --- Cleanup patterns ---
const REG_NEWLINES = /[\r\n]+/g;
const REG_ERR_WAR_PREFIX = /^(error|warning)\s*:\s*/i;

// --- Suppressed diagnostics ---
/** MQL error code for implicit number→string conversion (noise from Print/PrintLive) */
const MQL181_ERROR_CODE = '181';

// =============================================================================
// MODULE STATE - Initialized via init()
// =============================================================================
let diagnosticCollection = null;
let outputChannel = null;
let autoCheckTimer = null;
let isAutoCheckRunning = false;
let autoCheckDocVersions = new Map();
let internalSaveDepth = 0;

// Hover data from the last compilation, consumed by provider.js
let obj_hover = {};

/**
 * Initialize the compiler module with VS Code API objects created in activate().
 * Must be called once before any compilation functions are used.
 * @param {{ diagnosticCollection: vscode.DiagnosticCollection, outputChannel: vscode.OutputChannel }} deps
 */
function init(deps) {
    diagnosticCollection = deps.diagnosticCollection;
    outputChannel = deps.outputChannel;
}

/**
 * Get mutable state accessors for event handlers in extension.js
 */
function getState() {
    return {
        get internalSaveDepth() { return internalSaveDepth; },
        get isAutoCheckRunning() { return isAutoCheckRunning; },
        get autoCheckTimer() { return autoCheckTimer; },
    };
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

// =============================================================================
// METAEDITOR COMMAND BUILDER
// =============================================================================

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
        return `${matchingFlag}"${value}"`;
    });
    return { executable, args: processedArgs };
}

// =============================================================================
// COMPILE PATH - Single file compilation
// =============================================================================

/**
 * compile a single file path
 * Extracted from compile() to support compiling multiple targets
 */
async function compilePath(rt, pathTocompile, _context) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const fileName = pathModule.basename(pathTocompile);
    const extension = pathModule.extname(pathTocompile).toLowerCase();
    const startT = new Date();
    const time = `${tf(startT, 'h')}:${tf(startT, 'm')}:${tf(startT, 's')}`;

    let logFile, command, MetaDir, incDir, CommM, CommI, teq, includefile, log, portableMode;

    // Allow ${workspaceFolder} and relative paths in settings.
    const fileUri = vscode.Uri.file(pathTocompile);
    const wsFolder = vscode.workspace.getWorkspaceFolder(fileUri) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const workspaceFolderPath = wsFolder && wsFolder.uri ? wsFolder.uri.fsPath : '';

    let isMql5 = false;

    if (extension === '.mq4') {
        // isMql4
    } else if (extension === '.mq5') {
        isMql5 = true;
    } else if (extension === '.mqh') {
        // Try to determine flavor from resolved targets, falling back to substring check
        const savedTargets = getcompileTargets(fileUri, wsFolder, _context);
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
            if (pathTocompile.toLowerCase().includes('mql4')) {
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
    const baseName = pathModule.basename(pathTocompile, extension);
    logFile = pathModule.join(pathModule.dirname(pathTocompile), `${baseName}.log`);


    // Resolve Wine configuration (no-op on Windows / when disabled)
    const wine = resolveWineConfig(config);

    // Wine-specific validation
    if (wine.enabled) {
        const pathValidation = validateWinePath(MetaDir);
        if (!pathValidation.valid) {
            vscode.window.showErrorMessage(`Wine Configuration Error: ${pathValidation.error}`);
            return undefined;
        }
    }

    // Build command arguments - convert paths if using Wine (async, done before Promise)
    const wineLogger = (msg) => outputChannel.appendLine(msg);
    let compileArg, logArg, incArg;
    if (wine.enabled) {
        compileArg = await convertPathForWine(pathTocompile, wine.binary, wine.prefix, wineLogger);
        logArg = await convertPathForWine(logFile, wine.binary, wine.prefix, wineLogger);
        incArg = incDir ? await convertPathForWine(incDir, wine.binary, wine.prefix, wineLogger) : '';
    } else {
        compileArg = pathTocompile;
        logArg = logFile;
        incArg = incDir || '';
    }

    includefile = incArg ? `/inc:"${incArg}"` : '';

    // Build command based on Wine mode
    let execArgs;
    if (wine.enabled) {
        // Wine mode: wine64 metaeditor64.exe /compile:"Z:\..." /log:"Z:\..." ...
        // Note: MetaDir (path to metaeditor.exe) is passed as Unix path - Wine accepts this for executables in its prefix
        execArgs = [MetaDir, `/compile:"${compileArg}"`, `/log:"${logArg}"`];
        if (includefile) execArgs.push(includefile);
        if (portableSwitch) execArgs.push(portableSwitch);
        command = wine.binary;
    } else {
        // Direct execution (Windows)
        // Note: With spawn shell:false, don't quote argument values - spawn handles escaping
        execArgs = [`/compile:${pathTocompile}`, `/log:${logFile}`];
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

            // Surface spawn/launch errors clearly
            if (launchError) {
                const errMsg = launchError.message || String(launchError);
                const isNotFound = launchError.code === 'ENOENT';
                const isPermission = launchError.code === 'EACCES' || launchError.code === 'EPERM';

                if (isNotFound) {
                    outputChannel.appendLine(`[Error] compiler not found: ${command}`);
                    vscode.window.showErrorMessage(`compiler executable not found: ${command}`);
                } else if (isPermission) {
                    outputChannel.appendLine(`[Error] Permission denied launching compiler: ${command}`);
                    vscode.window.showErrorMessage(`Permission denied: ${command}`);
                } else {
                    outputChannel.appendLine(`[Error] Launch error: ${errMsg}`);
                }
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
                    const detail = launchError
                        ? ` (compiler ${launchError.code === 'ENOENT' ? 'not found' : 'failed to start'})`
                        : '';
                    throw new Error(`Log file not found at: ${logFile}${detail}`);
                }

                data = await fsPromises.readFile(logFile, 'ucs-2');
            } catch (err) {
                outputChannel.appendLine(`[Error] Failed to read log file: ${err.message}`);
                vscode.window.showErrorMessage(`${lg['err_read_log']} ${err.message}`);
                return resolve(true); // Signal error to caller
            }

            if (config.LogFile.DeleteLog) {
                fsPromises.unlink(logFile).catch(err => {
                    outputChannel.appendLine(`[Warning] Failed to delete log file: ${err.message}`);
                });
            }

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
            const timecompile = (endT - startT) / 1000;

            outputChannel.appendLine(`[${time}] ${teq} '${fileName}' [${timecompile}s]`);

            if (rt === 2 && !log.error) {
                let scriptProc;
                try {
                    if (wine.enabled) {
                        const args = [MetaDir, `/compile:${compileArg}`];
                        scriptProc = childProcess.spawn(wine.binary, args, { shell: false, env: wine.env });
                    } else {
                        const { executable, args } = buildMetaEditorCmd(MetaDir, [`/compile:${compileArg}`]);
                        scriptProc = childProcess.spawn(executable, args, { shell: false });
                    }
                } catch (spawnErr) {
                    outputChannel.appendLine(`[Error] ${lg['err_start_script']}: ${spawnErr.message}`);
                    return resolve(true);
                }
                scriptProc.on('error', (error) => {
                    outputChannel.appendLine(`[Error] ${lg['err_start_script']}: ${error.message}`);
                    resolve(true);
                });
                scriptProc.on('close', () => {
                    outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                    resolve();
                });
            } else {
                outputChannel.appendLine(String(log.text));
                resolve(log.error);
            }
        };

        // Execute compilation command
        let proc;
        try {
            if (wine.enabled) {
                proc = childProcess.spawn(command, execArgs, { shell: false, env: wine.env });
            } else {
                // Windows: use spawn with shell: false to safely handle paths with spaces
                const { executable, args } = buildMetaEditorCmd(command, execArgs);
                proc = childProcess.spawn(executable, args, { shell: false });
            }
        } catch (spawnErr) {
            outputChannel.appendLine(`[Error] Failed to spawn compiler process: ${spawnErr.message}`);
            vscode.window.showErrorMessage(`Failed to start compiler: ${spawnErr.message}`);
            return resolve(true); // Signal error to caller
        }
        let stderrData = '';
        let timeoutId = null;

        // Set up timeout for Wine processes
        if (wine.enabled) {
            timeoutId = setTimeout(() => {
                outputChannel.appendLine(`[Wine] Compilation timed out after ${wine.timeout / 1000} seconds. Killing process...`);
                proc.kill('SIGTERM');
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill('SIGKILL');
                    }
                }, 2000);
            }, wine.timeout);
        }

        const clearWineTimeout = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };

        let errorEmitted = false;
        proc.stderr.on('data', (data) => { stderrData += data.toString(); });
        proc.on('error', (err) => {
            errorEmitted = true;
            clearWineTimeout();
            handleCompilationResult(err, stderrData);
        });
        proc.on('close', (code) => {
            if (errorEmitted) return; // Already handled by 'error' event
            clearWineTimeout();
            if (code !== 0) {
                const exitErr = new Error(`Process exited with code ${code}`);
                exitErr.code = 'EXIT_' + code;
                exitErr.exitCode = code;
                handleCompilationResult(exitErr, stderrData);
            } else {
                handleCompilationResult(null, stderrData);
            }
        });
    });
}

// =============================================================================
// COMPILE - Main entry point for compilation
// =============================================================================

/**
 * Orchestrate MQL file compilation or syntax check.
 * @param {number} rt - 0=check, 1=compile, 2=compile+run script
 * @param {vscode.ExtensionContext} context
 */
async function compile(rt, context) {
    await fixFormatting();
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

    let pathsTocompile = [];

    // For .mqh files, resolve compile targets
    if (extension === '.mqh') {
        // Workspace folder is required for .mqh compile target resolution
        if (!workspaceFolder) {
            return vscode.window.showErrorMessage('File must be in a workspace folder');
        }

        const targets = await resolvecompileTargets({
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
            const magicPath = findParentFile();
            if (magicPath && fs.existsSync(magicPath)) {
                pathsTocompile = [magicPath];
            } else {
                // If rt === 0 (checking), we can't fall back to current file for headers effectively
                // but we should check if we should allow checking the header itself or just warn.
                // Existing behavior for rt !== 0 was to warn.
                if (rt !== 0) {
                    return vscode.window.showWarningMessage(lg['mqh']);
                } else {
                    // For rt === 0, if no target found, just check the header itself as a fallback
                    pathsTocompile = [document.fileName];
                }
            }
        } else {
            pathsTocompile = targets;
        }
    } else {
        // For .mq4/.mq5, compile the current file
        pathsTocompile = [document.fileName];
    }

    // compile all targets
    outputChannel.clear();
    outputChannel.show(true);

    // Always clear previous MetaEditor diagnostics so Problems reflects the last run.
    // (We keep lightweight diagnostics in a separate collection.)
    diagnosticCollection.clear();

    const teq = rt === 0 ? lg['checking'] : (rt === 1 ? lg['compiling'] : lg['comp_usi_script']);

    let hasErrors = false;
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: `MQL Tools: ${teq}`,
        },
        async () => {
            for (const pathTocompile of pathsTocompile) {
                const error = await compilePath(rt, pathTocompile, context);
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

// =============================================================================
// LOG PARSER
// =============================================================================

/**
 * Parse MetaEditor log output into structured data.
 * @param {string} str - Raw log content (UCS-2 decoded)
 * @param {boolean} f - True for check mode (prefix format), false for compile mode
 * @returns {{ text: string, error: boolean, diagnostics: Array, obj_hover: Object }}
 */
function replaceLog(str, f) {
    let text = f ? '' : '\n\n', obj_hover_local = {}, ye = false, diagnostics = [];
    if (!str) return { text, obj_hover: obj_hover_local, error: ye, diagnostics };

    const lines = str.replace(/\u{FEFF}/gu, '').split('\n');
    for (const item of lines) {
        const trimmed = item.trim();
        if (!trimmed) continue;

        if (REG_COMPILING.test(item)) {
            const isCompiling = item.includes('compiling');
            const mName = item.match(isCompiling ? REG_COMPILING_NAME : REG_CHECKING_NAME);
            const mPath = item.match(REG_PATH_BEFORE_SEP);

            if (mName && mPath) {
                const name = mName[0];
                const link = url.pathToFileURL(mPath[0]).href;
                obj_hover_local[name] = { link };
                text += name + '\n';
            }
        }
        else if (REG_INCLUDE.test(item)) {
            const mName = item.match(REG_INCLUDE_NAME);
            const mPath = item.match(REG_PATH_BEFORE_SEP);
            if (mName && mPath) {
                const name = mName[0];
                const link = url.pathToFileURL(mPath[0]).href;
                obj_hover_local[name] = { link };
                text += name + '\n';
            }
        }
        else if (item.includes('information: generating code') || item.includes('information: code generated')) {
            continue;
        }
        else if (REG_INFO.test(item)) {
            const mName = item.match(REG_INFO_NAME);
            const mPath = item.match(REG_PATH_BEFORE_SEP);
            if (mName && mPath) {
                const name = mName[0];
                const link = url.pathToFileURL(mPath[0]).href;
                obj_hover_local[name] = { link };
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
                const link_res = (mLinePath[1] || '').replace(REG_NEWLINES, '');
                let name_res = (mLinePath[2] || '').replace(REG_NEWLINES, '');

                const gh_match = name_res.match(REG_ERROR_CODE);
                const gh = gh_match ? gh_match[0] : null;
                name_res = name_res.replace(gh || '', '').replace(REG_ERR_WAR_PREFIX, '').trim();

                if (link_res.match(REG_FULL_PATH) && name_res) {
                    const mFullPath = link_res.match(REG_DIAGNOSTIC_FULL_PATH);
                    const mPos = link_res.match(REG_DIAGNOSTIC_POS);

                    if (mFullPath && mPos) {
                        const fullPath = mFullPath[0].replace(/\($/, '').trim();
                        const line = parseInt(mPos[1]) - 1;
                        const col = parseInt(mPos[2]) - 1;
                        const severity = item.toLowerCase().includes('error') ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;

                        // Filter out MQL181 (implicit conversion from number to string)
                        // These are noise since Print/PrintLive accept any type via implicit conversion
                        const isMQL181 = gh === MQL181_ERROR_CODE ||
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
                        obj_hover_local[hoverKey] = {
                            link: url.pathToFileURL(link_res).href.replace(REG_LINE_FRAGMENT, '#').replace(/\)$/gm, ''),
                            number: gh ? String(gh) : null
                        };

                        const suffix = link_res.match(REG_LINE_SUFFIX);
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

    // Store obj_hover at module level so provider.js can access it
    module.exports.obj_hover = obj_hover_local;

    return {
        text: text,
        obj_hover: obj_hover_local,
        error: ye,
        diagnostics: diagnostics
    };
}

// =============================================================================
// AUTO-CHECK REGISTRATION
// =============================================================================

/**
 * Register auto-check (debounced on text change), check-on-save, and startup check.
 * Called from activate() to encapsulate all auto-check state and event wiring.
 * @param {vscode.ExtensionContext} context
 */
function registerAutoCheck(context) {
    // Debounced auto-check on text change
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        const config = vscode.workspace.getConfiguration('mql_tools');
        if (!config.AutoCheck.Enabled) return;

        const ext = pathModule.extname(event.document.fileName).toLowerCase();
        if (!['.mq4', '.mq5', '.mqh'].includes(ext)) return;

        const docUri = event.document.uri.toString();
        const docVersion = event.document.version;

        // Ignore changes caused by our own auto-check edits (fixFormatting, save)
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
                await compile(0, context); // Syntax check (no compilation)
            } finally {
                // Record the final document version after our edits complete
                // This prevents re-triggering from fixFormatting or save changes
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
        // Ignore saves performed by compile() itself (prevents recursion / cascades)
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
            await compile(0, context); // Syntax check
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
                    await compile(0, context); // Syntax check on startup
                } finally {
                    isAutoCheckRunning = false;
                }
            }
        }
    });
}

module.exports = {
    init,
    getState,
    compile,
    replaceLog,
    registerAutoCheck,
};
