'use strict';

const vscode = require('vscode');

/**
 * Provides document symbols for MQL files (Outline view, Breadcrumbs, Go to Symbol)
 * Shows: #property, #include, #define, input/sinput, functions, classes/structs
 */
function MQLDocumentSymbolProvider() {
    return {
        provideDocumentSymbols(document, _token) {
            const symbols = [];
            const text = document.getText();
            const lines = text.split('\n');

            // MQL types for matching
            const mqlTypes = 'int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color|void';

            // Track class/struct ranges for nesting functions
            const classRanges = [];

            // =========================================================
            // PREPROCESSOR SECTION - Group #property, #include, #define
            // =========================================================
            const preprocessorSymbols = [];

            // #property directives
            const propertyRegex = /^#property\s+(\w+)\s*(.*)/gm;
            let match;
            while ((match = propertyRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const line = document.lineAt(pos.line);
                const propName = match[1];
                const propValue = match[2].trim().replace(/^"(.+)"$/, '$1');

                const symbol = new vscode.DocumentSymbol(
                    `#property ${propName}`,
                    propValue,
                    vscode.SymbolKind.Property,
                    line.range,
                    line.range
                );
                preprocessorSymbols.push(symbol);
            }

            // #include directives
            const includeRegex = /^#include\s*[<"]([^>"]+)[>"]/gm;
            while ((match = includeRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const line = document.lineAt(pos.line);
                const includePath = match[1];

                const symbol = new vscode.DocumentSymbol(
                    `#include <${includePath}>`,
                    '',
                    vscode.SymbolKind.Module,
                    line.range,
                    line.range
                );
                preprocessorSymbols.push(symbol);
            }

            // #define macros
            const defineRegex = /^#define\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(.*))?/gm;
            while ((match = defineRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const line = document.lineAt(pos.line);
                const defineName = match[1];
                const defineValue = match[2] ? match[2].trim() : '';

                const symbol = new vscode.DocumentSymbol(
                    defineName,
                    defineValue,
                    vscode.SymbolKind.Constant,
                    line.range,
                    line.range
                );
                preprocessorSymbols.push(symbol);
            }

            // #import directives
            const importRegex = /^#import\s*"([^"]+)"/gm;
            while ((match = importRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const line = document.lineAt(pos.line);
                const importPath = match[1];

                const symbol = new vscode.DocumentSymbol(
                    `#import "${importPath}"`,
                    '',
                    vscode.SymbolKind.Module,
                    line.range,
                    line.range
                );
                preprocessorSymbols.push(symbol);
            }

            // Group preprocessor symbols if there are any
            if (preprocessorSymbols.length > 0) {
                // Sort by line number
                preprocessorSymbols.sort((a, b) => a.range.start.line - b.range.start.line);
                symbols.push(...preprocessorSymbols);
            }

            // =========================================================
            // INPUT PARAMETERS - Critical for EA/Indicator configuration
            // =========================================================
            const inputRegex = new RegExp(`^\\s*(input|sinput)\\s+(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\\s*=\\s*([^;]+))?`, 'gm');
            while ((match = inputRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const line = document.lineAt(pos.line);
                const inputType = match[1]; // input or sinput
                const varType = match[2];
                const varName = match[3];
                const defaultValue = match[4] ? match[4].trim() : '';

                const symbol = new vscode.DocumentSymbol(
                    varName,
                    `${inputType} ${varType}${defaultValue ? ' = ' + defaultValue : ''}`,
                    vscode.SymbolKind.Field,
                    line.range,
                    line.range
                );
                symbols.push(symbol);
            }

            // =========================================================
            // ENUMS
            // =========================================================
            const enumRegex = /^\s*enum\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/gm;
            while ((match = enumRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const startLine = pos.line;

                // Find closing brace
                let braceCount = 1;
                let endLine = startLine;
                for (let i = startLine; i < lines.length && braceCount > 0; i++) {
                    const lineText = lines[i];
                    for (const char of lineText) {
                        if (char === '{') braceCount++;
                        else if (char === '}') braceCount--;
                    }
                    if (braceCount === 0) endLine = i;
                }

                const range = new vscode.Range(startLine, 0, endLine, lines[endLine]?.length || 0);
                const symbol = new vscode.DocumentSymbol(
                    match[1],
                    'enum',
                    vscode.SymbolKind.Enum,
                    range,
                    document.lineAt(startLine).range
                );
                symbols.push(symbol);
            }

            // =========================================================
            // CLASSES AND STRUCTS
            // =========================================================
            const classRegex = /^\s*(class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*(?:public|protected|private)?\s*([a-zA-Z_][a-zA-Z0-9_]*))?\s*\{?/gm;
            while ((match = classRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const startLine = pos.line;
                const kind = match[1]; // class or struct
                const name = match[2];
                const baseClass = match[3] || '';

                // Find closing brace for class
                let braceCount = 0;
                let foundOpen = false;
                let endLine = startLine;
                for (let i = startLine; i < lines.length; i++) {
                    const lineText = lines[i];
                    for (const char of lineText) {
                        if (char === '{') {
                            braceCount++;
                            foundOpen = true;
                        } else if (char === '}') {
                            braceCount--;
                        }
                    }
                    if (foundOpen && braceCount === 0) {
                        endLine = i;
                        break;
                    }
                }

                const range = new vscode.Range(startLine, 0, endLine, lines[endLine]?.length || 0);
                const symbol = new vscode.DocumentSymbol(
                    name,
                    baseClass ? `extends ${baseClass}` : kind,
                    kind === 'class' ? vscode.SymbolKind.Class : vscode.SymbolKind.Struct,
                    range,
                    document.lineAt(startLine).range
                );

                classRanges.push({ symbol, startLine, endLine });
                symbols.push(symbol);
            }

            // =========================================================
            // FUNCTIONS - Including methods inside classes
            // =========================================================
            const funcRegex = new RegExp(`^\\s*(?:static\\s+)?(?:virtual\\s+)?(?:export\\s+)?(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(([^)]*)\\)`, 'gm');
            while ((match = funcRegex.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                const startLine = pos.line;
                const returnType = match[1];
                const funcName = match[2];
                const params = match[3].trim();

                // Find function body end
                let braceCount = 0;
                let foundOpen = false;
                let endLine = startLine;
                for (let i = startLine; i < lines.length; i++) {
                    const lineText = lines[i];
                    for (const char of lineText) {
                        if (char === '{') {
                            braceCount++;
                            foundOpen = true;
                        } else if (char === '}') {
                            braceCount--;
                        }
                    }
                    if (foundOpen && braceCount === 0) {
                        endLine = i;
                        break;
                    }
                    // Forward declaration (no body)
                    if (!foundOpen && lineText.includes(';')) {
                        endLine = i;
                        break;
                    }
                }

                const range = new vscode.Range(startLine, 0, endLine, lines[endLine]?.length || 0);
                const funcSymbol = new vscode.DocumentSymbol(
                    funcName,
                    `${returnType}(${params})`,
                    vscode.SymbolKind.Function,
                    range,
                    document.lineAt(startLine).range
                );

                // Check if function is inside a class
                const parentClass = classRanges.find(c =>
                    startLine > c.startLine && startLine < c.endLine
                );

                if (parentClass) {
                    // Add as child of class
                    funcSymbol.kind = vscode.SymbolKind.Method;
                    parentClass.symbol.children.push(funcSymbol);
                } else {
                    symbols.push(funcSymbol);
                }
            }

            return symbols;
        }
    };
}

module.exports = { MQLDocumentSymbolProvider };
