'use strict';
const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const pathModule = require('path');
const lg = require('./language');
const { tf } = require('./formatting');
const { generatePortableSwitch, resolvePathRelativeToWorkspace } = require('./createProperties');
const {
    toWineWindowsPath,
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineEnv,
    validateWinePath
} = require('./wineHelper');


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

            // Note: MetaDir (path to metaeditor.exe) is passed as Unix path - Wine accepts this for executables in its prefix
            const args = [MetaDir, pathResult.path];
            if (portableSwitch) args.push(portableSwitch);
            const proc = childProcess.spawn(wineBinary, args, { shell: false, detached: true, stdio: 'ignore', env: wineEnv });
            proc.on('error', (err) => {
                console.error('Wine process error:', err);
                vscode.window.showErrorMessage(`${lg['err_open_in_me']} - ${fileName}`);
            });
            proc.unref();
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

async function OpenTradingTerminal() {
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

    const portableSwitch = generatePortableSwitch(portableMode);
    const useWine = isWineEnabled(config);

    try {
        if (useWine) {
            // Validate Terminal path format (must be Unix path, not Windows path)
            const pathValidation = validateWinePath(TerminalDir);
            if (!pathValidation.valid) {
                return vscode.window.showErrorMessage(`Wine Configuration Error: ${pathValidation.error}`);
            }

            const wineBinary = getWineBinary(config);
            const wineEnv = getWineEnv(config);
            const args = [TerminalDir];
            if (portableSwitch) args.push(portableSwitch);
            const proc = childProcess.spawn(wineBinary, args, { shell: false, detached: true, stdio: 'ignore', env: wineEnv });
            proc.on('error', (err) => {
                console.error('Wine process error:', err);
                vscode.window.showErrorMessage(`${lg['err_open_terminal']}`);
            });
            proc.unref();
        } else {
            const args = [];
            if (portableSwitch) args.push(portableSwitch);
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
