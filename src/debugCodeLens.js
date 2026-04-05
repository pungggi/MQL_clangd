'use strict';
const vscode = require('vscode');

/**
 * CodeLens provider for MQL debug watch annotations.
 *
 * Shows an "Add @watch" lens on breakpoint lines that don't already have
 * a nearby `@watch` annotation. Clicking inserts a `// @watch ` comment
 * above the breakpoint line for the user to fill in.
 */
class DebugWatchCodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

        // Refresh when breakpoints change
        this._bpDisposable = vscode.debug.onDidChangeBreakpoints(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    dispose() {
        this._bpDisposable.dispose();
        this._onDidChangeCodeLenses.dispose();
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.CodeLens[]}
     */
    provideCodeLenses(document) {
        const lenses = [];
        const breakpoints = vscode.debug.breakpoints.filter(bp =>
            bp instanceof vscode.SourceBreakpoint &&
            bp.location.uri.fsPath === document.uri.fsPath &&
            bp.enabled
        );

        for (const bp of breakpoints) {
            const line = bp.location.range.start.line; // 0-based
            if (this._hasWatchAnnotation(document, line)) continue;

            const range = new vscode.Range(line, 0, line, 0);
            lenses.push(new vscode.CodeLens(range, {
                title: '$(eye) Add @watch annotation',
                command: 'mql_tools.insertWatchAnnotation',
                arguments: [document.uri, line],
            }));
        }
        return lenses;
    }

    /**
     * Check if there's already a @watch annotation within 5 lines above the breakpoint.
     * @param {vscode.TextDocument} document
     * @param {number} bpLine  0-based
     * @returns {boolean}
     */
    _hasWatchAnnotation(document, bpLine) {
        const from = Math.max(0, bpLine - 5);
        const to = Math.min(document.lineCount - 1, bpLine + 2);
        for (let i = from; i <= to; i++) {
            if (document.lineAt(i).text.includes('@watch')) return true;
        }
        return false;
    }
}

/**
 * Insert a `// @watch ` annotation above the given line.
 * @param {vscode.Uri} uri
 * @param {number} line  0-based
 */
async function insertWatchAnnotation(uri, line) {
    const editor = await vscode.window.showTextDocument(uri);
    const indent = editor.document.lineAt(line).text.match(/^(\s*)/)[1];
    const snippet = new vscode.SnippetString(`${indent}// @watch \${1:varName}\n`);
    const position = new vscode.Position(line, 0);
    await editor.insertSnippet(snippet, position);
}

/**
 * Register the CodeLens provider and the insert command.
 * @param {vscode.ExtensionContext} context
 */
function registerDebugCodeLens(context) {
    const provider = new DebugWatchCodeLensProvider();
    const selector = [
        { language: 'mql5', scheme: 'file' },
        { language: 'mql4', scheme: 'file' },
        { language: 'cpp', pattern: '**/*.mqh', scheme: 'file' },
    ];
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(selector, provider),
        vscode.commands.registerCommand('mql_tools.insertWatchAnnotation', insertWatchAnnotation),
        provider,
    );
}

module.exports = { registerDebugCodeLens, DebugWatchCodeLensProvider };
