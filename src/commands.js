'use strict';

const vscode = require('vscode');
const pathModule = require('path');

const { Help, OfflineHelp } = require('./help');
const { ShowFiles, InsertNameFileMQH, InsertMQH, InsertNameFileMQL, InsertMQL, InsertResource, InsertImport, InsertTime, InsertIcon, OpenFileInMetaEditor, OpenTradingTerminal, CreateComment } = require('./contextMenu');
const { IconsInstallation } = require('./addIcon');
const { RapidPanel } = require('./RapidPanel');
const { SettingsPanel } = require('./SettingsPanel');
const { CreateProperties } = require('./createProperties');
const { setCompileTargets, resetCompileTargets } = require('./compileTargetResolver');
const logTailer = require('./logTailer');
const compiler = require('./compiler');

/**
 * Register all VS Code commands for the extension.
 * @param {vscode.ExtensionContext} context
 */
function registerCommands(context) {
    // Compilation commands
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.checkFile', () => compiler.Compile(0, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileFile', () => compiler.Compile(1, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileScript', () => compiler.Compile(2, context)));

    // Help
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.help', (keyword, version) => Help(keyword, version)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.offlineHelp', () => OfflineHelp()));

    // Compile target management
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.selectCompileTarget', () => selectCompileTarget(context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.resetCompileTarget', () => resetCompileTarget(context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.resetAllCompileTargets', () => resetAllCompileTargetsCmd(context)));

    // Configuration & tools
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.configurations', async () => {
        await CreateProperties();
        try {
            await vscode.commands.executeCommand('clangd.restart');
        } catch (error) {
            // clangd extension may not be installed - silently ignore
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.Addicon', () => IconsInstallation()));

    // Context menu / insertion commands
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

    // Log tailing
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.toggleTerminalLog', () => logTailer.toggle()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.installLiveLog', () => installLiveLog()));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.switchLogMode', () => switchLogMode()));

    // Rapid EA - Visual Strategy Builder
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openRapidEA', () => {
        RapidPanel.render(context.extensionUri, context);
    }));

    // Rapid EA Settings
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.openSettings', () => {
        SettingsPanel.render(context.extensionUri, context);
    }));

    // Status Bar Item for Settings
    const settingsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    settingsStatusBarItem.command = 'mql_tools.openSettings';
    settingsStatusBarItem.text = '$(gear) Rapid EA';
    settingsStatusBarItem.tooltip = 'Rapid EA Settings';
    settingsStatusBarItem.show();
    context.subscriptions.push(settingsStatusBarItem);

    logTailer.initStatusBar();
}

// =============================================================================
// COMMAND HANDLERS
// =============================================================================

async function selectCompileTarget(context) {
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

    const cfg = vscode.workspace.getConfiguration('mql_tools');
    const allowMultiSelect = cfg.get('CompileTarget.AllowMultiSelect', true);

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
}

async function resetCompileTarget(context) {
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
}

async function resetAllCompileTargetsCmd(context) {
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
}

async function installLiveLog() {
    const version = logTailer.detectMqlVersion() || 'mql5';
    const cfg = vscode.workspace.getConfiguration('mql_tools');
    const logFolderName = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
    let rawIncDir = cfg.get(`Metaeditor.${logFolderName}`);

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
}

async function switchLogMode() {
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
}

module.exports = { registerCommands };
