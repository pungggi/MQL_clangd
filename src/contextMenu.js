'use strict';
const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const pathModule = require('path');
const lg = require('./language');
const { tf } = require('./timeUtils');
const { generatePortableSwitch, resolvePathRelativeToWorkspace } = require('./createProperties');
const {
    toWineWindowsPath,
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineEnv,
    validateWinePath,
    execWineBatch
} = require('./wineHelper');

const TERMINAL_KILL_DELAY_MS = 1500;
const STARTUP_INI_CLEANUP_DELAY_MS = 60_000;

let _mqlDebugChannel = null;

function getMqlDebugChannel() {
    if (!_mqlDebugChannel) {
        _mqlDebugChannel = vscode.window.createOutputChannel('MQL Debug', { log: false });
    }
    return _mqlDebugChannel;
}

function ShowFiles(...args) {
    const conf = vscode.workspace.getConfiguration(),
        object = {}, obj = {};

    Object.assign(object, conf.files.exclude);
    args.forEach(arg => arg in object ? Object.assign(obj, object[arg] === false ? { [arg]: true } : { [arg]: false }) : Object.assign(obj, { [arg]: true }));

    conf.update('files.exclude', obj, false);
}

function InsertIcon() {

    const options = {
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(pathModule.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Images')),
        filters: {
            'Import Files': ['ico']
        }
    };

    vscode.window.showOpenDialog(options).then(fileUri => {
        if (fileUri && fileUri[0]) {
            const { document, selection, edit } = vscode.window.activeTextEditor, NName = fileUri[0].fsPath, RelativePath = vscode.workspace.asRelativePath(NName),
                d = selection.start.line, ns = document.lineAt(d).text.length, pos = new vscode.Position(d, ns),
                str = RelativePath.replace(/\//g, '\\\\');

            edit(edit => edit.insert(pos, (ns > 0 ? '\n' : '') + '#property icon ' + '"\\\\' + str + '"'));
        }
    });
}

function InsertMQL() {
    const options = {
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath),
        filters: {
            'MQL Files': ['mq4', 'mq5']
        }
    };

    vscode.window.showOpenDialog(options).then(fileUri => {
        if (fileUri && fileUri[0])
            InsertNameFileMQL(fileUri[0]);
    });
}

function InsertNameFileMQL(uri) {

    const activeEditor = vscode.window.activeTextEditor, RelativePath = vscode.workspace.asRelativePath(uri.fsPath), extension = pathModule.extname(activeEditor.document.fileName),
        pos = new vscode.Position(0, 0);

    if (extension === '.mqh') activeEditor.edit(edit => edit.insert(pos, `//###<${RelativePath}>\n`));

}

function InsertMQH() {
    const options = {
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(pathModule.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Include')),
        filters: {
            'MQH Include Files': ['mqh']
        }
    };

    vscode.window.showOpenDialog(options).then(fileUri => {
        if (fileUri && fileUri[0])
            InsertNameFileMQH(fileUri[0]);
    });

}

function InsertNameFileMQH(uri) {

    const { document, selection, edit } = vscode.window.activeTextEditor, NName = uri.fsPath, RelativePath = vscode.workspace.asRelativePath(NName),
        Path = document.fileName, extension = pathModule.extname(Path),
        d = selection.start.line, ns = document.lineAt(d).text.length, pos = new vscode.Position(d, ns);

    if (['.mq4', '.mq5', '.mqh'].includes(extension)) {
        const dirName = pathModule.dirname(Path), Ye = NName.includes(Path.match(/.*\\(?=(?:(?:(?:.+)\.(?:\w+))$))/m)[0]) ? 1 : 0,
            str = Ye ? NName.slice(dirName.length + 1) : RelativePath.replace(/(^include\/)(.+)/im, '$2');
        edit(edit => edit.insert(pos, (ns > 0 ? '\n' : '') + '#include ' + (Ye === 1 ? '"' : '<') + str + (Ye === 1 ? '"' : '>')));
    }
}

function InsertResource() {

    const options = {
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(pathModule.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Files')),
        filters: {
            'Import Files': ['bmp', 'wav']
        }
    };

    vscode.window.showOpenDialog(options).then(fileUri => {
        if (fileUri && fileUri[0]) {
            const { document, selection, edit } = vscode.window.activeTextEditor, NName = fileUri[0].fsPath, RelativePath = vscode.workspace.asRelativePath(NName),
                d = selection.start.line, ns = document.lineAt(d).text.length, pos = new vscode.Position(d, ns),
                str = RelativePath.replace(/\//g, '\\\\');

            edit(edit => edit.insert(pos, (ns > 0 ? '\n' : '') + '#resource ' + '"\\\\' + str + '"'));
        }
    });
}

function InsertImport() {

    const options = {
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(pathModule.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'Libraries')),
        filters: {
            'Library Files': ['dll', 'ex5']
        }
    };

    vscode.window.showOpenDialog(options).then(fileUri => {
        if (fileUri && fileUri[0]) {
            const { document, selection, edit } = vscode.window.activeTextEditor, NName = fileUri[0].fsPath, RelativePath = vscode.workspace.asRelativePath(NName),
                Path = document.fileName, extfile = pathModule.extname(NName), fileName = pathModule.basename(NName),
                d = selection.start.line, ns = document.lineAt(d).text.length, pos = new vscode.Position(d, ns);

            if (extfile === '.dll')
                edit(edit => edit.insert(pos, (ns > 0 ? '\n' : '') + '#import ' + '"' + fileName + '"' + '\n\n#import'));
            if (extfile === '.ex5') {
                const dirName = pathModule.dirname(Path), Ye = NName.includes(Path.match(/.*\\(?=(?:(?:(?:.+)\.(?:\w+))$))/m)[0]) ? 1 : 0,
                    str = Ye ? NName.slice(dirName.length + 1) : (RelativePath.search(/^Libraries/) != -1 ? RelativePath.match(/(?<=Libraries\/).+/gi) : '..\\..\\..\\' + RelativePath).replace(/\//g, '\\');
                edit(edit => edit.insert(pos, (ns > 0 ? '\n' : '') + '#import ' + '"' + str + '"' + '\n\n#import'));
            }
        }
    });
}

function InsertTime() {
    const { selection, edit } = vscode.window.activeTextEditor, { start, end } = selection, date = new Date(),
        time = `D'${tf(date, 'Y')}.${tf(date, 'M')}.${tf(date, 'D')} ${tf(date, 'h')}:${tf(date, 'm')}:${tf(date, 's')}'`,
        pos = new vscode.Position(start.line, start.character);

    (end.line !== start.line || end.character !== start.character) ? edit(edit => edit.replace(selection, time)) : edit(edit => edit.insert(pos, time));
}

function CreateComment() {
    const { document, selection, edit } = vscode.window.activeTextEditor, { end } = selection,
        reg = /(?:(\w+)\s+)(?:(?:\w+::|)\w+(?: +|)\()/,
        wordAtCursorRange = document.getWordRangeAtPosition(end, reg);

    if (wordAtCursorRange === undefined)
        return undefined;
    const snip = document.getText(wordAtCursorRange),
        regEx = new RegExp(`${snip.replace('(', '\\(')}([\\s+\\n+\\w+&\\[\\]\\,=]*)\\)(?:(?:(?:\\s+|\\n)|)\\/\\*(?:.|\\n)*\\*\\/|(?:\\s+|)\\/\\/.*|)(?:\\{|\\s+\\{)`);
    let a, args;

    args = document.getText().match(regEx);
    if (args) {
        const space = ''.padEnd(wordAtCursorRange.start.character, ' ');
        let comment = space + '/**\n', type;
        comment += space + ' * ' + lg['comm_func'] + '\n';
        args[1].replace(/\s+/g, ' ').trim().split(',').forEach((item, index) => {
            a = item.match(/(?<= )(?:[\w&[\]=]+)$/, 'g');
            if (a) comment += `${space} * @param  ${a[0]}: ${lg['comm_arg']} ${index + 1}\n`;
        });
        if ((type = snip.match(reg)[1]) != 'void') comment += `${space} * @return ( ${type} )\n`;
        comment += space + ' */\n';

        edit(edit => edit.insert(new vscode.Position(wordAtCursorRange.start.line, 0), comment));
    }
}

async function OpenFileInMetaEditor(uri) {
    const extension = pathModule.extname(uri.fsPath).toLowerCase(), config = vscode.workspace.getConfiguration('mql_tools'), wn = vscode.workspace.name.includes('MQL4'), fileName = pathModule.basename(uri.fsPath);
    let MetaDir, CommM, portableMode, settingName;

    if (['.mq4', '.mqh'].includes(extension) && wn) {
        MetaDir = config.Metaeditor.Metaeditor4Dir;
        portableMode = config.Metaeditor.Portable4;
        CommM = lg['path_editor4'];
        settingName = 'mql_tools.Metaeditor.Metaeditor4Dir';
    }
    else if (['.mq5', '.mqh'].includes(extension) && !wn) {
        MetaDir = config.Metaeditor.Metaeditor5Dir;
        portableMode = config.Metaeditor.Portable5;
        CommM = lg['path_editor5'];
        settingName = 'mql_tools.Metaeditor.Metaeditor5Dir';
    }
    else
        return undefined;

    // Allow ${workspaceFolder} and relative paths in settings.
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const workspaceFolderPath = wsFolder && wsFolder.uri ? wsFolder.uri.fsPath : '';
    MetaDir = resolvePathRelativeToWorkspace(MetaDir, workspaceFolderPath);

    if (typeof MetaDir !== 'string' || !MetaDir.length) {
        return vscode.window.showErrorMessage(`${CommM} [${MetaDir || ''}]`, 'Configure')
            .then(selection => {
                if (selection === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', settingName);
                }
            });
    }

    const Nm = pathModule.basename(MetaDir),
        lowNm = Nm.toLowerCase();

    if (!(fs.existsSync(MetaDir) && fs.statSync(MetaDir).isFile() && (lowNm === 'metaeditor.exe' || lowNm === 'metaeditor64.exe'))) {
        return vscode.window.showErrorMessage(`${CommM} [${MetaDir}]`, 'Configure')
            .then(selection => {
                if (selection === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', settingName);
                }
            });
    }

    const portableSwitch = generatePortableSwitch(portableMode);
    const useWine = isWineEnabled(config);

    try {
        if (useWine) {
            // Validate MetaEditor path format (must be Unix path, not Windows path)
            const pathValidation = validateWinePath(MetaDir);
            if (!pathValidation.valid) {
                return vscode.window.showErrorMessage(`Wine Configuration Error: ${pathValidation.error}`);
            }

            const wineBinary = getWineBinary(config);
            const winePrefix = getWinePrefix(config);
            const wineEnv = getWineEnv(config);

            const pathResult = await toWineWindowsPath(uri.fsPath, wineBinary, winePrefix);
            if (!pathResult.success) {
                console.error(`[Wine] Path conversion failed: ${pathResult.error}`);
                return vscode.window.showErrorMessage(`${lg['err_open_in_me']} - ${fileName} (Wine path conversion failed)`);
            }

            // Convert MetaEditor path to Windows format first
            const metaResult = await toWineWindowsPath(MetaDir, wineBinary, winePrefix);
            if (!metaResult.success) {
                console.error(`[Wine] MetaEditor path conversion failed: ${metaResult.error}`);
                return vscode.window.showErrorMessage(`${lg['err_open_in_me']} - ${fileName} (Wine path conversion failed for editor)`);
            }
            const metaEditorWinPath = metaResult.path;

            const args = [pathResult.path]; // File to open
            if (portableSwitch) args.push(portableSwitch);

            await execWineBatch(metaEditorWinPath, args, wineBinary, winePrefix, wineEnv, `${lg['err_open_in_me']} - ${fileName}`);
        } else {
            const args = [uri.fsPath];
            if (portableSwitch) args.push(portableSwitch);
            const proc = childProcess.spawn(MetaDir, args, { detached: true, stdio: 'ignore' });
            proc.on('error', (err) => {
                console.error('MetaEditor launch error:', err);
                vscode.window.showErrorMessage(`${lg['err_open_in_me']} - ${fileName}`);
            });
            proc.unref();
        }
    }
    catch (e) {
        return vscode.window.showErrorMessage(`${lg['err_open_in_me']} - ${fileName}`);
    }
}

/** Check if a terminal process is already running (Windows only). */
function _isTerminalRunning(exeName) {
    return new Promise(resolve => {
        if (!/^[A-Za-z0-9._-]+$/.test(exeName)) {
            resolve(false);
            return;
        }
        childProcess.execFile(
            'tasklist',
            ['/FI', `IMAGENAME eq ${exeName}`, '/NH'],
            { encoding: 'utf-8', timeout: 3000 },
            (err, stdout) => {
                if (err) { resolve(false); return; }
                resolve(stdout.toLowerCase().includes(exeName.toLowerCase()));
            }
        );
    });
}

/** Kill a running terminal process by image name (Windows only). */
function _killTerminal(exeName) {
    return new Promise(resolve => {
        if (!/^[A-Za-z0-9._-]+$/.test(exeName)) {
            resolve();
            return;
        }
        childProcess.execFile(
            'taskkill',
            ['/IM', exeName, '/F'],
            { encoding: 'utf-8', timeout: 5000 },
            () => resolve() // resolve regardless of success
        );
    });
}

/**
 * Build a startup INI file so MetaTrader auto-attaches an EA on launch.
 *
 * @param {string} eaPath   Absolute path to the compiled .ex5/.ex4 binary
 * @param {string} mql5Root MQL5 root directory (contains Experts/, Files/, …)
 * @returns {string|null}   Path to the generated INI file, or null if the EA
 *                          is not inside the Experts tree.
 */
function buildStartupIni(eaPath, mql5Root) {
    const expertsDir = pathModule.join(mql5Root, 'Experts');
    const relative = pathModule.relative(expertsDir, eaPath);

    // If the EA lives outside the Experts tree, relative will start with ".."
    if (relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;

    // Expert= expects a backslash-separated path without extension
    const expertValue = relative
        .replace(/\.[^.]+$/, '')       // strip .ex5 / .ex4
        .replace(/\//g, '\\');         // normalise to backslashes

    // [Startup] section must match MT5 docs casing.
    // Symbol/Period are omitted so MT5 uses whatever chart is already open.
    const iniContent = `[Startup]\r\nExpert=${expertValue}\r\n`;
    const iniPath = pathModule.join(os.tmpdir(), `mql_debug_startup_${Date.now()}.ini`);
    try {
        fs.writeFileSync(iniPath, iniContent, 'utf-8');
    } catch (err) {
        throw new Error(`Failed to create startup INI at ${iniPath}: ${err.message}`, { cause: err });
    }
    return iniPath;
}

/**
 * Open the MetaTrader trading terminal.
 *
 * @param {string} [eaPath]   Optional absolute path to a compiled EA (.ex5/.ex4).
 *                             When provided the terminal is launched with a startup
 *                             config that auto-attaches the EA to a chart.
 * @param {string} [mql5Root] MQL5 root directory — required when eaPath is given.
 */
async function OpenTradingTerminal(eaPath, mql5Root) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const editor = vscode.window.activeTextEditor;

    // Determine MQL version from active file or workspace name
    let isMql4 = false;
    if (editor) {
        const fileName = editor.document.fileName.toLowerCase();
        if (fileName.includes('mql4')) {
            isMql4 = true;
        } else if (fileName.includes('mql5')) {
            isMql4 = false;
        } else if (vscode.workspace.name && vscode.workspace.name.includes('MQL4')) {
            isMql4 = true;
        }
    } else if (vscode.workspace.name && vscode.workspace.name.includes('MQL4')) {
        isMql4 = true;
    }

    let TerminalDir, CommT, portableMode, settingName;

    if (isMql4) {
        TerminalDir = config.Terminal.Terminal4Dir;
        portableMode = config.Metaeditor.Portable4;
        CommT = lg['path_terminal4'];
        settingName = 'mql_tools.Terminal.Terminal4Dir';
    } else {
        TerminalDir = config.Terminal.Terminal5Dir;
        portableMode = config.Metaeditor.Portable5;
        CommT = lg['path_terminal5'];
        settingName = 'mql_tools.Terminal.Terminal5Dir';
    }

    // Allow ${workspaceFolder} and relative paths in settings.
    const wsFolder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ||
        (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const workspaceFolderPath = wsFolder && wsFolder.uri ? wsFolder.uri.fsPath : '';
    TerminalDir = resolvePathRelativeToWorkspace(TerminalDir, workspaceFolderPath);

    if (typeof TerminalDir !== 'string' || !TerminalDir.length) {
        return vscode.window.showErrorMessage(`${CommT} [${TerminalDir || ''}]`, 'Configure')
            .then(selection => {
                if (selection === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', settingName);
                }
            });
    }

    const Nm = pathModule.basename(TerminalDir),
        lowNm = Nm.toLowerCase();

    if (!(fs.existsSync(TerminalDir) && fs.statSync(TerminalDir).isFile() && (lowNm === 'terminal.exe' || lowNm === 'terminal64.exe'))) {
        return vscode.window.showErrorMessage(`${CommT} [${TerminalDir}]`, 'Configure')
            .then(selection => {
                if (selection === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', settingName);
                }
            });
    }

    // Build optional startup INI when an EA path is provided
    let iniPath = null;
    if (eaPath && mql5Root) {
        try {
            iniPath = buildStartupIni(eaPath, mql5Root);
            if (!iniPath) {
                console.warn('[OpenTradingTerminal] EA is not inside MQL5/Experts; skipping auto-attach.');
            }
        } catch (err) {
            // Log but don't abort — the terminal can still open without auto-attach
            console.error('[OpenTradingTerminal] Failed to build startup INI:', err.message);
        }
    }

    const portableSwitch = generatePortableSwitch(portableMode);
    const useWine = isWineEnabled(config);

    // Grab the MQL output channel for visible diagnostics
    const _oc = getMqlDebugChannel();

    if (iniPath) {
        let iniContent = '';
        try {
            iniContent = fs.readFileSync(iniPath, 'utf-8');
        } catch (err) {
            console.warn(`[Auto-attach] Failed to read INI file at ${iniPath}:`, err);
        }
        _oc.appendLine(`[Auto-attach] INI path: ${iniPath}`);
        _oc.appendLine(`[Auto-attach] INI content:\n${iniContent}`);
        _oc.show(true);

        // /config: is ignored when MT5 is already running — the second process
        // just focuses the existing window.  Detect this and let the user decide.
        if (!useWine) {
            const running = await _isTerminalRunning(lowNm);
            if (running) {
                const choice = await vscode.window.showWarningMessage(
                    'MetaTrader is already running. Auto-attach via /config: only works on a fresh launch.',
                    'Close & Relaunch', 'Attach Manually'
                );
                if (choice === 'Close & Relaunch') {
                    await _killTerminal(lowNm);
                    // Small delay so the OS releases the process handle
                    await new Promise(r => setTimeout(r, TERMINAL_KILL_DELAY_MS));
                } else {
                    // User chose manual attach or dismissed — skip INI
                    iniPath = null;
                }
            }
        }
    } else if (eaPath) {
        _oc.appendLine(`[Auto-attach] No INI created — eaPath=${eaPath}, mql5Root=${mql5Root}`);
        _oc.show(true);
    }

    try {
        if (useWine) {
            // Validate Terminal path format (must be Unix path, not Windows path)
            const pathValidation = validateWinePath(TerminalDir);
            if (!pathValidation.valid) {
                return vscode.window.showErrorMessage(`Wine Configuration Error: ${pathValidation.error}`);
            }

            const wineBinary = getWineBinary(config);
            const wineEnv = getWineEnv(config);
            const winePrefix = getWinePrefix(config);

            const termResult = await toWineWindowsPath(TerminalDir, wineBinary, winePrefix);
            if (!termResult.success) {
                return vscode.window.showErrorMessage(`${lg['err_open_terminal']} (Wine path conversion failed)`);
            }
            const terminalWinPath = termResult.path;

            const args = [];
            if (portableSwitch) args.push(portableSwitch);
            if (iniPath) {
                const iniResult = await toWineWindowsPath(iniPath, wineBinary, winePrefix);
                if (iniResult.success) {
                    args.push(`/config:${iniResult.path}`);
                } else {
                    console.warn(`[OpenTradingTerminal] Wine conversion of INI path failed; skipping auto-attach. iniPath=${iniPath}, error=${iniResult.error || 'unknown'}`);
                }
            }

            await execWineBatch(terminalWinPath, args, wineBinary, winePrefix, wineEnv, lg['err_open_terminal']);
        } else {
            const args = [];
            if (portableSwitch) args.push(portableSwitch);
            if (iniPath) args.push(`/config:${iniPath}`);
            _oc.appendLine(`[Auto-attach] Spawning: "${TerminalDir}" ${args.join(' ')}`);
            _oc.show(true);
            const proc = childProcess.spawn(TerminalDir, args, { detached: true, stdio: 'ignore' });
            proc.on('error', (err) => {
                console.error('Terminal launch error:', err);
                vscode.window.showErrorMessage(`${lg['err_open_terminal']}`);
            });
            proc.unref();
        }
    }
    catch (e) {
        return vscode.window.showErrorMessage(`${lg['err_open_terminal']}`);
    }
    finally {
        // Clean up the temporary INI after MT5 has had time to start and read it.
        // MT5 can take 10-30s to initialise; BATCH_FILE_CLEANUP_DELAY_MS (5s) is
        // too short, so use STARTUP_INI_CLEANUP_DELAY_MS for startup INIs.
        if (iniPath) {
            setTimeout(() => {
                try { fs.unlinkSync(iniPath); } catch (_) { /* best-effort */ }
            }, STARTUP_INI_CLEANUP_DELAY_MS);
        }
    }
}


module.exports = {
    ShowFiles,
    InsertNameFileMQH,
    InsertMQH,
    InsertNameFileMQL,
    InsertMQL,
    InsertResource,
    InsertImport,
    InsertTime,
    InsertIcon,
    CreateComment,
    OpenFileInMetaEditor,
    OpenTradingTerminal
};
