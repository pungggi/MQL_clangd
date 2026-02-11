'use strict';

const vscode = require('vscode');
const pathModule = require('path');
const sleep = require('util').promisify(setTimeout);

// Internal modules
const lg = require('./language');
const { Help, OfflineHelp } = require('./help');
const { ShowFiles, InsertNameFileMQH, InsertMQH, InsertNameFileMQL, InsertMQL, InsertResource, InsertImport, InsertTime, InsertIcon, OpenFileInMetaEditor, OpenTradingTerminal, CreateComment } = require('./contextMenu');
const { IconsInstallation } = require('./addIcon');
const { RapidPanel } = require('./RapidPanel');
const { SettingsPanel } = require('./SettingsPanel');
const { Hover_log, DefinitionProvider, Hover_MQL, ItemProvider, HelpProvider, ColorProvider, MQLDocumentSymbolProvider } = require('./provider');
const { registerLightweightDiagnostics } = require('./lightweightDiagnostics');
const { CreateProperties } = require('./createProperties');
const { setCompileTargets, resetCompileTargets, markIndexDirty } = require('./compileTargetResolver');
const {
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    isWineInstalled,
    setOutputChannel: setWineOutputChannel
} = require('./wineHelper');
const logTailer = require('./logTailer');

// Refactored modules
const compiler = require('./compiler');
const { MqlCodeActionProvider } = require('./codeActions');
const { tf } = require('./formatting');

// =============================================================================
// ACTIVATE
// =============================================================================

function activate(context) {
    // Initialize VS Code API-dependent variables (must be inside activate, not at module level)
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('mql');
    const outputChannel = vscode.window.createOutputChannel('MQL', 'mql-output');

    // Initialize compiler module with shared state
    compiler.init({ diagnosticCollection, outputChannel });

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

    // -------------------------------------------------------------------------
    // COMMAND REGISTRATIONS
    // -------------------------------------------------------------------------

    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.checkFile', () => compiler.Compile(0, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileFile', () => compiler.Compile(1, context)));
    context.subscriptions.push(vscode.commands.registerCommand('mql_tools.compileScript', () => compiler.Compile(2, context)));
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
    }));

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

    // -------------------------------------------------------------------------
    // LANGUAGE PROVIDERS
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // AUTO-CHECK & FILE WATCHING
    // -------------------------------------------------------------------------

    // Register auto-check, check-on-save, and startup check
    compiler.registerAutoCheck(context);

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
                indexInvalidationTimer = null;
                return;
            }

            // Process all pending folders
            for (const folderUriStr of pendingDirtyFolders) {
                const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.toString() === folderUriStr);
                if (folder) {
                    markIndexDirty(folder);
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

// =============================================================================
// DEACTIVATE
// =============================================================================

function deactivate() {
    logTailer.stop();
}

module.exports = {
    activate,
    deactivate,
    // Re-export for backward compatibility with tests
    replaceLog: compiler.replaceLog,
    tf,
};
