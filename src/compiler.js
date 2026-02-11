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
const { resolveCompileTargets, getCompileTargets } = require('./compileTargetResolver');
const {
    toWineWindowsPath,
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineTimeout,
    getWineEnv,
    validateWinePath,
} = require('./wineHelper');
const { tf, FixFormatting, FindParentFile } = require('./formatting');

// =============================================================================
// REGEX CONSTANTS - Compiler output parsing
// =============================================================================
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
    if (useWine) {
        // Wine mode: wine64 metaeditor64.exe /compile:"Z:\..." /log:"Z:\..." ...
        // Note: MetaDir (path to metaeditor.exe) is passed as Unix path - Wine accepts this for executables in its prefix
        execArgs = [MetaDir, `/compile:"${compileArg}"`, `/log:"${logArg}"`];
        if (includefile) execArgs.push(includefile);
        if (portableSwitch) execArgs.push(portableSwitch);
        command = wineBinary;
    } else {
        // Direct execution (Windows)
        // Note: With spawn shell:false, don't quote argument values - spawn handles escaping
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
                    const args = [MetaDir, `/compile:${compileArg}`];
                    const wineEnv = getWineEnv(config);
                    childProcess.spawn(wineBinary, args, { shell: false, env: wineEnv })
                        .on('error', (error) => {
                            outputChannel.appendLine(`[Error]  ${lg['err_start_script']}: ${error.message}`);
                            resolve();
                        })
                        .on('close', () => {
                            outputChannel.appendLine(String(log.text + lg['info_log_compile']));
                            resolve();
                        });
                } else {
                    // Direct execution on Windows - use spawn with shell: false to safely handle paths with spaces
                    const { executable, args } = buildMetaEditorCmd(MetaDir, [`/compile:${compileArg}`]);
                    childProcess.spawn(executable, args, { shell: false })
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
            proc = childProcess.spawn(command, execArgs, { shell: false, env: getWineEnv(config) });
        } else {
            // Windows: use spawn with shell: false to safely handle paths with spaces
            const { executable, args } = buildMetaEditorCmd(command, execArgs);
            proc = childProcess.spawn(executable, args, { shell: false });
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

// =============================================================================
// COMPILE - Main entry point for compilation
// =============================================================================

/**
 * Orchestrate MQL file compilation or syntax check.
 * @param {number} rt - 0=check, 1=compile, 2=compile+run script
 * @param {vscode.ExtensionContext} context
 */
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
            const regEx = new RegExp(`(?<=${isCompiling ? 'compiling' : 'checking'}.).+'`, 'gi');
            const mName = item.match(regEx);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);

            if (mName && mPath) {
                const name = mName[0];
                const link = url.pathToFileURL(mPath[0]).href;
                obj_hover_local[name] = { link };
                text += name + '\n';
            }
        }
        else if (REG_INCLUDE.test(item)) {
            const mName = item.match(/(?<=information: including ).+'/gi);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);
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
            const mName = item.match(/(?<=information: ).+/gi);
            const mPath = item.match(/[a-zA-Z]:\\.+(?= :)/gi);
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
                        obj_hover_local[hoverKey] = {
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
}

module.exports = {
    init,
    getState,
    Compile,
    replaceLog,
    registerAutoCheck,
};
