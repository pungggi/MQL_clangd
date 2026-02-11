'use strict';

const vscode = require('vscode');
const pathModule = require('path');
const fs = require('fs');
const { resolvePathRelativeToWorkspace } = require('./createProperties');

// Lazy-initialized VS Code-dependent values (must not access vscode at module load time)
let _language = null;
function getLanguage() {
    if (!_language) {
        _language = vscode.env.language;
    }
    return _language;
}

let _miniIconPath = null;
function getMiniIconPath() {
    if (!_miniIconPath) {
        _miniIconPath = vscode.Uri.file(pathModule.join(__dirname, '../', 'images', 'mql_icon_mini.png'));
    }
    return _miniIconPath;
}

// =============================================================================
// DOCUMENT SYMBOL EXTRACTION - For document-aware completion and hover
// =============================================================================

/**
 * Extract symbols (variables, functions, defines, classes, structs) from document
 * @param {vscode.TextDocument} document
 * @returns {{ variables: Array, functions: Array, defines: Array, classes: Array, inputs: Array }}
 */
function extractDocumentSymbols(document) {
    const text = document.getText();
    const symbols = {
        variables: [],
        functions: [],
        defines: [],
        classes: [],
        inputs: []
    };

    // MQL types for matching
    const mqlTypes = 'int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color|void';

    // Extract input/sinput parameters (highest priority for EA developers)
    const inputRegex = new RegExp(`^\\s*(input|sinput)\\s+(?:${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)`, 'gm');
    let match;
    while ((match = inputRegex.exec(text)) !== null) {
        symbols.inputs.push({
            name: match[2],
            type: match[1],
            line: document.positionAt(match.index).line
        });
    }

    // Extract global/local variables (exclude function parameters and inputs)
    const varRegex = new RegExp(`(?<!input\\s+)(?<!sinput\\s+)\\b(${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*(?:=|;|,|\\[)`, 'gm');
    while ((match = varRegex.exec(text)) !== null) {
        const varName = match[2];
        // Avoid duplicates and exclude common MQL keywords that look like variables
        if (!symbols.variables.find(v => v.name === varName) &&
            !symbols.inputs.find(i => i.name === varName) &&
            !['true', 'false', 'NULL', 'EMPTY', 'EMPTY_VALUE', 'CLR_NONE'].includes(varName)) {
            symbols.variables.push({
                name: varName,
                type: match[1],
                line: document.positionAt(match.index).line
            });
        }
    }

    // Extract function definitions
    const funcRegex = new RegExp(`^\\s*(?:static\\s+)?(?:virtual\\s+)?(?:${mqlTypes})\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\([^)]*\\)\\s*(?:\\{|$)`, 'gm');
    while ((match = funcRegex.exec(text)) !== null) {
        const funcName = match[1];
        // Exclude MQL standard event handlers from completion (they're already defined)
        if (!['OnInit', 'OnDeinit', 'OnTick', 'OnTimer', 'OnTrade', 'OnTradeTransaction',
            'OnBookEvent', 'OnChartEvent', 'OnCalculate', 'OnTester', 'OnTesterInit',
            'OnTesterDeinit', 'OnTesterPass', 'OnStart'].includes(funcName)) {
            symbols.functions.push({
                name: funcName,
                line: document.positionAt(match.index).line
            });
        }
    }

    // Extract #define macros
    const defineRegex = /^#define\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
    while ((match = defineRegex.exec(text)) !== null) {
        symbols.defines.push({
            name: match[1],
            line: document.positionAt(match.index).line
        });
    }

    // Extract class/struct names
    const classRegex = /^\s*(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
    while ((match = classRegex.exec(text)) !== null) {
        symbols.classes.push({
            name: match[1],
            line: document.positionAt(match.index).line
        });
    }

    return symbols;
}

// =============================================================================
// INCLUDE PATH UTILITIES
// =============================================================================

/**
 * Get include directory path based on file extension and workspace
 * @param {vscode.TextDocument} document
 * @returns {string|null}
 */
function getIncludeDir(document) {
    const config = vscode.workspace.getConfiguration('mql_tools');
    const workspaceName = vscode.workspace.name || '';
    const filePath = document.fileName.toUpperCase();

    // Determine if MQL4 or MQL5
    const isMQL4 = workspaceName.toUpperCase().includes('MQL4') ||
        filePath.includes('MQL4') ||
        document.fileName.endsWith('.mq4');

    const rawIncDir = isMQL4 ? config.Metaeditor.Include4Dir : config.Metaeditor.Include5Dir;
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]);
    const workspaceFolderPath = wsFolder && wsFolder.uri ? wsFolder.uri.fsPath : '';
    const incDir = resolvePathRelativeToWorkspace(rawIncDir, workspaceFolderPath);

    if (incDir && incDir.length > 0) {
        // Check if incDir already ends with Include or we need to append it
        const includeSubDir = pathModule.join(incDir, 'Include');
        if (fs.existsSync(includeSubDir)) {
            return includeSubDir;
        } else if (fs.existsSync(incDir)) {
            return incDir;
        }
    }

    return null;
}

/**
 * Get entries (folders and .mqh files) for a specific directory level
 * Used for hierarchical include completion
 * @param {string} baseDir - Base include directory
 * @param {string} currentPath - Current path being typed (e.g., "Arrays/" or "")
 * @returns {Array<{name: string, isFolder: boolean, relativePath: string}>}
 */
function getIncludeEntries(baseDir, currentPath = '') {
    const entries = [];
    // Path traversal protection
    if (pathModule.isAbsolute(currentPath) || currentPath.includes('..') || (process.platform !== 'win32' && currentPath.includes('\\'))) {
        return [];
    }
    const resolvedBaseDir = fs.realpathSync(pathModule.resolve(baseDir));
    const targetDir = fs.realpathSync(pathModule.resolve(baseDir, currentPath));
    if (!(targetDir.startsWith(resolvedBaseDir + pathModule.sep) || targetDir === resolvedBaseDir)) {
        return [];
    }

    try {
        const dirEntries = fs.readdirSync(targetDir, { withFileTypes: true });
        for (const entry of dirEntries) {
            if (entry.isDirectory()) {
                // Add folder with trailing slash
                entries.push({
                    name: entry.name,
                    isFolder: true,
                    relativePath: currentPath + entry.name + '/'
                });
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mqh')) {
                // Add .mqh file
                entries.push({
                    name: entry.name,
                    isFolder: false,
                    relativePath: currentPath + entry.name
                });
            }
        }
    } catch (e) {
        // Directory not accessible, ignore
    }

    // Sort: folders first, then files
    entries.sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        return a.name.localeCompare(b.name);
    });

    return entries;
}

// =============================================================================
// COLOR UTILITIES
// =============================================================================

function hexToRgbA(hexColor) {
    return [
        hexColor & 0xFF, (hexColor >> 8) & 0xFF, (hexColor >> 16) & 0xFF, (hexColor >> 24) & 0xFF ? ((hexColor >> 24) & 0xFF) : 255
    ];
}

function rgbaToHex(red, green, blue, alpha = 255) {
    const rgb = (alpha << 24) | (red << 16) | (green << 8) | (blue << 0);
    return (0x100000000 + rgb).toString(16).slice(alpha == 255 ? 2 : alpha == 0 ? 3 : (alpha < 128 ? 1 : 0));
}

function dToHex(r, g, b) {
    return [r, g, b].map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0x0' + hex : '0x' + hex;
    }).join();
}

function round(num, precision = 2) {
    return +(Math.round(num + 'e' + precision) + 'e' + -precision);
}

module.exports = {
    getLanguage,
    getMiniIconPath,
    extractDocumentSymbols,
    getIncludeDir,
    getIncludeEntries,
    hexToRgbA,
    rgbaToHex,
    dToHex,
    round,
};
