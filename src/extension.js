'use strict';

const vscode = require('vscode');
const sleep = require('util').promisify(setTimeout);

// Internal modules
const { Hover_log, DefinitionProvider, Hover_MQL, ItemProvider, HelpProvider, ColorProvider, MQLDocumentSymbolProvider } = require('./provider');
const { registerLightweightDiagnostics } = require('./lightweightDiagnostics');
const { createProperties } = require('./createProperties');
const { markIndexDirty } = require('./compileTargetResolver');
const {
    resolveWineConfig,
    isWineInstalled,
    setOutputChannel: setWineOutputChannel
} = require('./wineHelper');
const logTailer = require('./logTailer');

// Refactored modules
const compiler = require('./compiler');
const { MqlCodeActionProvider } = require('./codeActions');
const { tf } = require('./formatting');
const { registerCommands } = require('./commands');

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
    const wine = resolveWineConfig(config);
    if (wine.enabled) {
        isWineInstalled(wine.binary, wine.prefix).then(result => {
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
                if (wine.prefix) {
                    outputChannel.appendLine(`[Wine] Using prefix: ${wine.prefix}`);
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
                createProperties().then(() => {
                    // Update successful info message
                    // console.log(`MQL Tools: Migrated to v${currentVersion}`);
                });
            }
            context.globalState.update('mql-tools.version', currentVersion);
        }
    });

    // -------------------------------------------------------------------------
    // COMMANDS, PROVIDERS & AUTO-CHECK
    // -------------------------------------------------------------------------

    registerCommands(context);

    // Language providers
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
