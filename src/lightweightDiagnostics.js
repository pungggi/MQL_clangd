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
const DEBOUNCE_DELAY = 600; // ms

/**
 * Analyze document and return lightweight diagnostics
 * @param {vscode.TextDocument} document
 * @returns {vscode.Diagnostic[]}
 */
function analyzeDocument(document) {
    const diagnostics = [];
    const text = document.getText();
    const lines = text.split('\n');

    // Track multi-line state across the entire document
    let inMultiLineString = false;
    let multiLineStringStartLine = -1;
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i++) {
        // Strip trailing \r to handle CRLF line endings
        const line = lines[i].replace(/\r$/, '');
        const trimmed = line.trim();

        // --- Character scanner: always runs to maintain state ---
        // Tracks block comments, strings, char literals, and escape sequences.
        // Also builds `codeLine`: a copy of `line` with comment characters
        // replaced by spaces, preserving column positions for diagnostic ranges.
        let inString = inMultiLineString;
        let escaped = false;
        let quoteCount = 0;
        const hasLineContinuation = line.endsWith('\\');
        let lineIsCode = !inBlockComment && !inMultiLineString;
        let codeLine = '';

        for (let j = 0; j < line.length; j++) {
            const char = line[j];

            // Handle block comment state
            if (inBlockComment) {
                codeLine += ' ';
                if (char === '*' && j < line.length - 1 && line[j + 1] === '/') {
                    codeLine += ' ';
                    inBlockComment = false;
                    j++; // skip the '/'
                }
                continue;
            }

            // Skip escaped characters inside strings
            if (escaped) {
                escaped = false;
                codeLine += char;
                continue;
            }

            if (inString && char === '\\') {
                escaped = true;
                codeLine += char;
                continue;
            }

            // Outside strings: detect comment starts
            if (!inString) {
                // Single-line comment: blank out the rest of the line
                if (char === '/' && j < line.length - 1 && line[j + 1] === '/') {
                    codeLine += ' '.repeat(line.length - j);
                    break;
                }
                // Block comment start
                if (char === '/' && j < line.length - 1 && line[j + 1] === '*') {
                    inBlockComment = true;
                    codeLine += '  ';
                    j++; // skip the '*'
                    continue;
                }
                // Character literal containing a double quote: skip '"'
                if (char === '\'' && j + 2 < line.length && line[j + 1] === '"' && line[j + 2] === '\'') {
                    codeLine += line.substr(j, 3);
                    j += 2; // skip the '"' and closing '
                    continue;
                }
            }

            // Track string boundaries
            if (char === '"') {
                quoteCount++;
                if (!inString) {
                    inString = true;
                    if (multiLineStringStartLine === -1) {
                        multiLineStringStartLine = i;
                    }
                } else {
                    inString = false;
                }
            }
            codeLine += char;
        }

        // Update multi-line string state for next iteration
        if (!inMultiLineString && inString) {
            inMultiLineString = true;
        } else if (inMultiLineString && !inString) {
            inMultiLineString = false;
            multiLineStringStartLine = -1;
        }

        // --- Skip diagnostics for non-code lines ---
        // If the entire line is inside a block comment or multi-line string
        // that started before this line, skip diagnostic checks
        if (!lineIsCode) continue;
        // Skip empty lines and pure single-line comment lines
        if (trimmed === '' || trimmed.startsWith('//')) continue;

        // CHECK 1: Semicolon after closing brace (common typo, not struct/class/enum)
        if (/\}\s*;/.test(codeLine) && !/^\s*(struct|class|enum)/.test(trimmed)) {
            const m = codeLine.match(/\}\s*;/);
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
        const conditionMatch = codeLine.match(/\b(if|while)\s*\(\s*(.+)\s*\)(?:\s*\{|\s*$)/);
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
                const condStart = codeLine.indexOf(conditionMatch[0]);
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

        // CHECK 3: Unclosed string literal check
        // Skip MQL directives that commonly have unbalanced quotes
        if (/^#(property|import|resource)\s/.test(trimmed)) continue;

        // Report suspicious patterns on this line
        // Only report if:
        // 1. We have odd quote count
        // 2. No line continuation
        // 3. Not inside a multi-line string that started earlier
        // 4. Not a #define macro (which often has odd quote patterns)
        if (!inMultiLineString && quoteCount % 2 !== 0 && !hasLineContinuation) {
            // Skip lines that look like macro definitions
            if (!/^\s*#\s*define\s/.test(line)) {
                const diag = new vscode.Diagnostic(
                    new vscode.Range(i, 0, i, line.length),
                    'Possible unclosed string literal',
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'mql-lightweight';
                diag.code = 'unclosed-string';
                diagnostics.push(diag);
            }
        }
    }
    
    // After processing all lines, check if there's an unclosed multi-line string
    if (inMultiLineString && multiLineStringStartLine >= 0) {
        const diag = new vscode.Diagnostic(
            new vscode.Range(multiLineStringStartLine, 0, multiLineStringStartLine, lines[multiLineStringStartLine].length),
            'Unclosed string literal (started here)',
            vscode.DiagnosticSeverity.Error
        );
        diag.source = 'mql-lightweight';
        diag.code = 'unclosed-string';
        diagnostics.push(diag);
    }

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
        while ((match = regex.exec(text)) !== null) {
            // Find line number for this match
            const pos = document.positionAt(match.index);
            const line = pos.line;
            const col = pos.character;
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(line, col, line, col + typo.length),
                `Typo: '${typo}' should be '${correct}'`,
                vscode.DiagnosticSeverity.Error
            ));
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
