'use strict';
const vscode = require('vscode');

// Lightweight diagnostics collection (separate from MetaEditor diagnostics)
// NOTE: This is lazy-initialized to avoid accessing vscode APIs at module load time
let _lightweightDiagnostics = null;
function getLightweightDiagnostics() {
    if (!_lightweightDiagnostics) {
        _lightweightDiagnostics = vscode.languages.createDiagnosticCollection('mql-lightweight');
    }
    return _lightweightDiagnostics;
}

// Debounce timers per document
const diagnosticTimers = new Map();
const DEBOUNCE_DELAY = 300; // ms

/**
 * Analyze document and return lightweight diagnostics
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function analyzeDocument(document) {
    const diagnostics = [];
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip comments and empty lines
        if (trimmed.startsWith('//') || trimmed === '') continue;

        // CHECK 1: Semicolon after closing brace (common typo, not struct/class/enum)
        if (/\}\s*;/.test(line) && !/^\s*(struct|class|enum)/.test(trimmed)) {
            const m = line.match(/\}\s*;/);
            const col = m.index + m[0].lastIndexOf(';');
            const diag = new vscode.Diagnostic(
                new vscode.Range(i, col, i, col + 1),
                'Possibly unnecessary semicolon after closing brace',
                vscode.DiagnosticSeverity.Hint
            );
            diag.source = 'mql-lightweight';
            diag.code = 'unnecessary-semicolon';
            diagnostics.push(diag);
        }

        // CHECK 2: Assignment in condition (= instead of ==)
        // Skip intentional patterns like: if((x=expr)!=0) or if((x=func())!=NULL)
        const conditionMatch = line.match(/\b(if|while)\s*\(\s*(.+)\s*\)(?:\s*\{|\s*$)/);
        if (conditionMatch) {
            const condition = conditionMatch[2];
            // Remove string literals before checking for assignment
            const conditionNoStrings = condition.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
            // Has a single = (not ==, !=, <=, >=)
            const hasAssignment = /[^=!<>]=[^=]/.test(conditionNoStrings);
            // Has a comparison operator (intentional assignment pattern)
            const hasComparison = /[=!<>]=|!=|==|<=|>=/.test(conditionNoStrings);
            // Simple assignment like if(x=5) but NOT if((x=5)!=0)
            if (hasAssignment && !hasComparison) {
                const condStart = line.indexOf(conditionMatch[0]);
                const diag = new vscode.Diagnostic(
                    new vscode.Range(i, condStart, i, condStart + conditionMatch[0].length),
                    'Possible assignment in condition (did you mean "==" instead of "="?)',
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'mql-lightweight';
                diag.code = 'assignment-in-condition';
                diagnostics.push(diag);
            }
        }

        // CHECK 3: Unclosed string literal on single line
        // DISABLED: This check causes too many false positives in complex MQL code
        // (multi-line strings, macros, special MQL syntax patterns)
        // TODO: Re-enable with better heuristics or make it configurable
        /*
        let quoteCount = 0;
        let inString = false;
        let escaped = false;
        let hasBackslashAtEnd = trimmed.endsWith('\\');

        for (let j = 0; j < line.length; j++) {
            const char = line[j];

            if (!inString && j < line.length - 1 && char === '/' && line[j + 1] === '/') {
                break;
            }

            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                quoteCount++;
                inString = !inString;
            }
        }

        if (quoteCount % 2 !== 0 && !hasBackslashAtEnd) {
            const diag = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.length),
                'Possible unclosed string literal (odd number of quotes)',
                vscode.DiagnosticSeverity.Warning
            );
            diag.source = 'mql-lightweight';
            diag.code = 'unclosed-string';
            diagnostics.push(diag);
        }
        */

        // CHECK 4: Common MQL function typos
        const commonTypos = {
            'Ordersend': 'OrderSend', 'ordersend': 'OrderSend',
            'Orderclose': 'OrderClose', 'Symbolinfo': 'SymbolInfo',
            'symbolinfo': 'SymbolInfo', 'Accountinfo': 'AccountInfo',
            'accountinfo': 'AccountInfo', 'Positionget': 'PositionGet',
            'Iclose': 'iClose', 'Iopen': 'iOpen', 'Ihigh': 'iHigh', 'Ilow': 'iLow'
        };

        for (const [typo, correct] of Object.entries(commonTypos)) {
            const regex = new RegExp(`\\b${typo}\\b`, 'g');
            let match;
            while ((match = regex.exec(line)) !== null) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(i, match.index, i, match.index + typo.length),
                    `Typo: '${typo}' should be '${correct}'`,
                    vscode.DiagnosticSeverity.Error
                ));
            }
        }
    }
    return diagnostics;
}

/**
 * Update diagnostics for a document (debounced)
 * @param {vscode.TextDocument} document
 */
function updateDiagnostics(document) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    if (!config.Diagnostics?.Lightweight) {
        const existingTimer = diagnosticTimers.get(document.uri);
        if (existingTimer) {
            clearTimeout(existingTimer);
            diagnosticTimers.delete(document.uri);
        }
        getLightweightDiagnostics().delete(document.uri);
        return;
    }
    const existingTimer = diagnosticTimers.get(document.uri);
    if (existingTimer) clearTimeout(existingTimer);
    const newTimer = setTimeout(() => {
        const diagnostics = analyzeDocument(document);
        getLightweightDiagnostics().set(document.uri, diagnostics);
        diagnosticTimers.delete(document.uri);
    }, DEBOUNCE_DELAY);
    diagnosticTimers.set(document.uri, newTimer);
}

function clearDiagnostics(document) {

    const existingTimer = diagnosticTimers.get(document.uri);

    if (existingTimer) {

        clearTimeout(existingTimer);

        diagnosticTimers.delete(document.uri);

    }

    getLightweightDiagnostics().delete(document.uri);

}

/**
 * Register lightweight diagnostics handlers
 * @param {vscode.ExtensionContext} context
 */
function registerLightweightDiagnostics(context) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const ext = event.document.fileName.toLowerCase();
            if (ext.endsWith('.mq4') || ext.endsWith('.mq5') || ext.endsWith('.mqh')) {
                updateDiagnostics(event.document);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            const ext = document.fileName.toLowerCase();
            if (ext.endsWith('.mq4') || ext.endsWith('.mq5') || ext.endsWith('.mqh')) {
                updateDiagnostics(document);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            clearDiagnostics(document);
        })
    );
    vscode.workspace.textDocuments.forEach((document) => {
        const ext = document.fileName.toLowerCase();
        if (ext.endsWith('.mq4') || ext.endsWith('.mq5') || ext.endsWith('.mqh')) {
            updateDiagnostics(document);
        }
    });
}

// Export getter function instead of the collection itself
module.exports = { registerLightweightDiagnostics, getLightweightDiagnostics };