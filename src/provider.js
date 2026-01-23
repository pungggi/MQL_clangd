'use strict';
const vscode = require('vscode');
const pathModule = require('path');
const fs = require('fs');
const lg = require('./language');
const { resolvePathRelativeToWorkspace } = require('./createProperties');
const err_codes = require('../data/error-codes.json');
const obj_items = require('../data/items.json');
const colorW = require('../data/color.json')
const language = vscode.env.language;
const miniIconPath = vscode.Uri.file(pathModule.join(__dirname, '../', 'images', 'mql_icon_mini.png'));

// =============================================================================
// DOCUMENT SYMBOL EXTRACTION - For document-aware completion
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
 * Recursively get .mqh files from a directory
 * @param {string} dir - Directory path
 * @param {string} baseDir - Base directory for relative path calculation
 * @param {number} depth - Current recursion depth
 * @param {number} maxDepth - Maximum recursion depth
 * @returns {Array<{name: string, relativePath: string}>}
 */
// eslint-disable-next-line no-unused-vars
function getMqhFiles(dir, baseDir, depth = 0, maxDepth = 3) {
    const files = [];
    if (depth > maxDepth) return files;

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = pathModule.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...getMqhFiles(fullPath, baseDir, depth + 1, maxDepth));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mqh')) {
                const relativePath = pathModule.relative(baseDir, fullPath).replace(/\\/g, '/');
                files.push({
                    name: entry.name,
                    relativePath: relativePath
                });
            }
        }
    } catch (e) {
        // Directory not accessible, ignore
    }

    return files;
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


function Hover_log() {
    return {
        provideHover(document, position) {
            const word = document.lineAt(position.line).text;
            // Access obj_hover dynamically from extension module
            const ext = require('./extension');
            const obj_hover = ext.obj_hover || {};

            if (!(word in obj_hover)) return undefined;

            const link = (typeof obj_hover[word].link == 'undefined') ? '' : obj_hover[word].link,
                loclang = language === 'zh-tw' ? 'zh-cn' : language;

            if (loclang in err_codes)
                var local = err_codes[loclang][obj_hover[word].number];

            if (!local && !link)
                return undefined;

            const contents = new vscode.MarkdownString(`${local ? local : `[${lg['hover_log']}](${link})`}`);

            if (local) {
                if (link) {
                    contents.supportHtml = true;
                    contents.appendMarkdown(`<hr>\n\n[${lg['hover_log']}](${link})`);
                }
            }
            return new vscode.Hover(contents);
        }
    }
}

function DefinitionProvider() {
    return {
        provideDefinition(document, position) {
            const word = document.lineAt(position.line).text;
            // Access obj_hover dynamically from extension module
            const ext = require('./extension');
            const obj_hover = ext.obj_hover || {};

            if (!(word in obj_hover)) return undefined;

            const link = (typeof obj_hover[word].link == 'undefined') ? '' : obj_hover[word].link;

            if (!link) return undefined;
            const fileLink = link.match(/.+(?=#)/g) !== null ? link.match(/.+(?=#)/g)[0] : link,
                fragment1 = link.match(/.+(?=#)/g) !== null ? link.match(/(?<=#)(?:\d+,\d+)$/gm)[0].match(/(?:\w+)/g)[0] : 0,
                fragment2 = link.match(/.+(?=#)/g) !== null ? link.match(/(?<=#)(?:\d+,\d+)$/gm)[0].match(/(?:\w+)/g)[1] : 0,
                uri = vscode.Uri.file(fileLink.match(/(?<=file:\/\/\/).+/g)[0].replace(/%20/g, ' ')),
                pos = new vscode.Position(+fragment1 <= 0 ? 0 : +fragment1 - 1, +fragment2 <= 0 ? 0 : +fragment2 - 1);

            return new vscode.Location(uri, pos);
        }
    }
}

function Hover_MQL() {
    return {
        provideHover(document, position) {
            const loclang = language === 'zh-tw' ? 'zh-cn' : language;
            const range = document.getWordRangeAtPosition(position);
            const word = document.getText(range);

            if (!word) return undefined;

            // =================================================================
            // PRIORITY 1: Check local document symbols first
            // =================================================================
            const docSymbols = extractDocumentSymbols(document);

            // Check if it's a local input parameter
            const inputMatch = docSymbols.inputs.find(i => i.name === word);
            if (inputMatch) {
                const contents = new vscode.MarkdownString();
                contents.appendCodeblock(`${inputMatch.type} ${inputMatch.name}`, 'cpp');
                contents.appendMarkdown(`**Input Parameter** (line ${inputMatch.line + 1})\n\n`);
                contents.appendMarkdown(`User-configurable parameter for this EA/Indicator.`);
                return new vscode.Hover(contents, range);
            }

            // Check if it's a local #define
            const defineMatch = docSymbols.defines.find(d => d.name === word);
            if (defineMatch) {
                const contents = new vscode.MarkdownString();
                contents.appendCodeblock(`#define ${defineMatch.name}`, 'cpp');
                contents.appendMarkdown(`**Macro** (line ${defineMatch.line + 1})`);
                return new vscode.Hover(contents, range);
            }

            // Check if it's a local function
            const funcMatch = docSymbols.functions.find(f => f.name === word);
            if (funcMatch) {
                const contents = new vscode.MarkdownString();
                contents.appendMarkdown(`**Local Function** (line ${funcMatch.line + 1})`);
                return new vscode.Hover(contents, range);
            }

            // Check if it's a local class/struct
            const classMatch = docSymbols.classes.find(c => c.name === word);
            if (classMatch) {
                const contents = new vscode.MarkdownString();
                contents.appendMarkdown(`**Class/Struct** (line ${classMatch.line + 1})`);
                return new vscode.Hover(contents, range);
            }

            // =================================================================
            // PRIORITY 2: Check MQL library items
            // =================================================================
            if (!(word in obj_items)) return undefined;

            const item = obj_items[word];
            const contents = new vscode.MarkdownString();
            contents.supportHtml = true;

            // Get localized description
            const dl = item.description[loclang] || item.description.en || '';

            // FUNCTIONS (group 2) - Compact documentation (no redundancy)
            if (item.group === 2) {
                // Extract just the description text (remove return type prefix like "(int)")
                // Regex now matches any content inside parentheses at start of string
                const cleanDesc = dl.replace(/^\([^\)]+\)\s*/, '').trim();

                if (cleanDesc) {
                    contents.appendMarkdown(`${cleanDesc}\n\n`);
                }

                // Parameters (compact)
                const params = item.parameters[loclang] || item.parameters.en || [];
                if (params.length > 0) {
                    params.forEach(param => {
                        const re = /(.+?(?= {2}))(.+)/;
                        const match = param.match(re);
                        if (match) {
                            const paramName = match[1].trim();
                            const paramDesc = match[2].trim();
                            contents.appendMarkdown(`- \`${paramName}\` ${paramDesc}\n`);
                        } else {
                            // Fallback if strict format not found
                            contents.appendMarkdown(`- ${param}\n`);
                        }
                    });
                }

                return new vscode.Hover(contents, range);
            }

            // CONSTANTS/ENUMS (group 15, 6, etc.) - Compact hover
            const example = item.code?.map(m => m.label)[0] || word;
            contents.appendCodeblock(example, 'cpp');

            if (dl) {
                contents.appendMarkdown(dl);
            }

            // Color preview for color constants
            if (item.group === 15 && word in colorW) {
                const clrRGB = colorW[word].split(',');
                const hexColor = rgbaToHex(+clrRGB[0], +clrRGB[1], +clrRGB[2]);
                contents.appendMarkdown(`\n\n<span style="background-color:#${hexColor};padding:2px 20px;">&nbsp;</span> \`#${hexColor}\``);
            }

            return new vscode.Hover(contents, range);
        }
    };
}

function ItemProvider() {
    return {
        provideCompletionItems(document, position, _token, _context) {
            const loclang = language === 'zh-tw' ? 'zh-cn' : language;
            const line = document.lineAt(position).text;
            const linePrefix = line.substring(0, position.character);
            const range = document.getWordRangeAtPosition(position);
            const prefix = document.getText(range)?.toLowerCase() || '';

            const completionItems = [];

            // =================================================================
            // INCLUDE COMPLETION - Hierarchical navigation (folders first)
            // =================================================================
            const includeMatch = linePrefix.match(/#include\s*[<"]([^>"]*)?$/);
            if (includeMatch) {
                const partialPath = includeMatch[1] || '';
                const incDir = getIncludeDir(document);

                if (incDir) {
                    // Get entries for current directory level
                    const entries = getIncludeEntries(incDir, partialPath);

                    for (const entry of entries) {
                        if (entry.isFolder) {
                            // Folder - show with folder icon, insert just the folder name
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Folder);
                            item.detail = 'Folder';
                            item.insertText = entry.name + '/';
                            item.sortText = '0' + entry.name; // Folders first
                            item.command = { command: 'editor.action.triggerSuggest', title: 'Re-trigger' };
                            completionItems.push(item);
                        } else {
                            // File - show with file icon
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.File);
                            item.detail = 'Include file';
                            item.insertText = entry.name;
                            item.sortText = '1' + entry.name; // Files after folders
                            completionItems.push(item);
                        }
                    }
                }

                // Also suggest local .mqh files from workspace root (flat, for quick access)
                if (!partialPath) {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const wsRoot = workspaceFolders[0].uri.fsPath;
                        const localEntries = getIncludeEntries(wsRoot, '');
                        for (const entry of localEntries.filter(e => !e.isFolder).slice(0, 10)) {
                            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.File);
                            item.detail = 'Local file';
                            item.insertText = entry.name;
                            item.sortText = '2' + entry.name;
                            if (!completionItems.find(i => i.label === entry.name)) {
                                completionItems.push(item);
                            }
                        }
                    }
                }

                return completionItems;
            }

            // Early return for empty prefix (except for include completion above)
            if (!prefix) return [];

            // =================================================================
            // DOCUMENT SYMBOLS COMPLETION - Variables, functions, defines from current file
            // =================================================================
            const docSymbols = extractDocumentSymbols(document);

            // Input parameters (highest priority for EA developers)
            for (const input of docSymbols.inputs) {
                if (input.name.toLowerCase().startsWith(prefix)) {
                    const item = new vscode.CompletionItem(input.name, vscode.CompletionItemKind.Field);
                    item.detail = `${input.type} (input parameter)`;
                    item.sortText = '00' + input.name; // Highest priority
                    item.documentation = new vscode.MarkdownString(`**Input Parameter**\n\nDeclared at line ${input.line + 1}`);
                    completionItems.push(item);
                }
            }

            // Variables from document
            for (const variable of docSymbols.variables) {
                if (variable.name.toLowerCase().startsWith(prefix)) {
                    const item = new vscode.CompletionItem(variable.name, vscode.CompletionItemKind.Variable);
                    item.detail = `${variable.type} (local)`;
                    item.sortText = '01' + variable.name;
                    item.documentation = new vscode.MarkdownString(`**Variable**\n\nType: \`${variable.type}\`\nLine: ${variable.line + 1}`);
                    completionItems.push(item);
                }
            }

            // Functions from document
            for (const func of docSymbols.functions) {
                if (func.name.toLowerCase().startsWith(prefix)) {
                    const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
                    item.detail = 'function (local)';
                    item.sortText = '02' + func.name;
                    item.insertText = new vscode.SnippetString(func.name + '($0)');
                    item.documentation = new vscode.MarkdownString(`**Local Function**\n\nDefined at line ${func.line + 1}`);
                    completionItems.push(item);
                }
            }

            // #define macros from document
            for (const define of docSymbols.defines) {
                if (define.name.toLowerCase().startsWith(prefix)) {
                    const item = new vscode.CompletionItem(define.name, vscode.CompletionItemKind.Constant);
                    item.detail = '#define (local)';
                    item.sortText = '03' + define.name;
                    item.documentation = new vscode.MarkdownString(`**Macro Definition**\n\nDefined at line ${define.line + 1}`);
                    completionItems.push(item);
                }
            }

            // Classes/Structs from document
            for (const cls of docSymbols.classes) {
                if (cls.name.toLowerCase().startsWith(prefix)) {
                    const item = new vscode.CompletionItem(cls.name, vscode.CompletionItemKind.Class);
                    item.detail = 'class/struct (local)';
                    item.sortText = '04' + cls.name;
                    item.documentation = new vscode.MarkdownString(`**Class/Struct**\n\nDefined at line ${cls.line + 1}`);
                    completionItems.push(item);
                }
            }

            // =================================================================
            // MQL LIBRARY COMPLETION - From obj_items (standard MQL functions, constants, etc.)
            // =================================================================
            const docSymbolNames = new Set([
                ...docSymbols.inputs.map(i => i.name),
                ...docSymbols.variables.map(v => v.name),
                ...docSymbols.functions.map(f => f.name),
                ...docSymbols.defines.map(d => d.name),
                ...docSymbols.classes.map(c => c.name)
            ]);

            const mqlItems = Object.values(obj_items)
                .filter(item => item.label.toLowerCase().startsWith(prefix))
                .filter(item => !docSymbolNames.has(item.label)) // Avoid duplicates with local symbols
                .map(match => {
                    const item = new vscode.CompletionItem(match.label, match.group);
                    item.insertText = new vscode.SnippetString(match.body);
                    item.detail = match.description[loclang] ? match.description[loclang] : match.description.en;
                    item.sortText = '10' + match.label; // Lower priority than local symbols
                    const contents = new vscode.MarkdownString();
                    contents.appendCodeblock(match.code.map(m => m.label)[0]);
                    if (match.group === 15) {
                        if (match.label in colorW) {
                            let clrRGB = colorW[match.label].split(',');
                            contents.appendMarkdown(
                                `<span style="background-color:#${rgbaToHex(+clrRGB[0], +clrRGB[1], +clrRGB[2])};">${Array.from({ length: 55 }, () => '&nbsp;').join('')}</span><br>\n`);
                            contents.supportHtml = true;
                        }
                    }
                    contents.appendMarkdown(`![](${miniIconPath})`);
                    item.documentation = contents;
                    return item;
                });

            completionItems.push(...mqlItems);

            return completionItems;
        }
    }
}

function HelpProvider() {
    return {
        provideSignatureHelp(document, position, _token, context) {
            const loclang = language === 'zh-tw' ? 'zh-cn' : language,
                line = document.lineAt(position).text.substring(0, position.character);

            if (line.lastIndexOf('//') >= 0)
                return undefined;

            let i = position.character - 1,
                bracketCount = 0;
            while (i >= 0) {
                const char = line.substring(i, i + 1);
                if (char == '(') {
                    if (bracketCount == 0)
                        break;
                }
                else if (char == ')') {
                    bracketCount++;
                }
                i--;
            }

            const nf = line.substring(0, i).match(/(?:\w+)(?=$)/gm);
            if (!nf)
                return undefined;
            const FunctionName = nf[0];

            if (!(FunctionName in obj_items))
                return undefined;
            if (obj_items[FunctionName].group !== 2)
                return undefined;

            const sig = new vscode.SignatureHelp();

            sig.signatures = obj_items[FunctionName].code.map((str) => {
                if (/(?<=\().+(?=\))/.exec(str.label))
                    var jh = /(?<=\().+(?=\))/.exec(str.label)[0].split(',');
                else jh = [str.label];
                const arrParam = jh,
                    paramDescription = obj_items[FunctionName].parameters[loclang] ? obj_items[FunctionName].parameters[loclang] : obj_items[FunctionName].parameters.en,
                    mdSig = new vscode.MarkdownString(`<span style="color:#d19a66;"><i> ${str.description[loclang] ? str.description[loclang] : str.description.en ? str.description.en : ''} </i></span>`);

                mdSig.supportHtml = true;

                const info = new vscode.SignatureInformation(str.label, mdSig);

                info.parameters = arrParam.map((item) => {
                    if (/(?:.*\s)(.+)/g.exec(item))
                        var xc = /(?:.*\s)(.+)/g.exec(item)[1];
                    else xc = item;
                    const npt = xc,
                        reg = /((?:^\w+|^\w+\[\])(?=\s))+(?= {2})(.+)/m,
                        prm = paramDescription.find(name =>
                            (reg.exec(name) !== null ? reg.exec(name)[1] : '') == npt
                        ),
                        des = reg.exec(prm) !== null ? reg.exec(prm)[2] : '',
                        r = /(\[)(.+?)(\])(.*)/,
                        md = new vscode.MarkdownString(
                            `<span style="color:#ffd700e6;">${des.replace(r, '$1')}</span><span style="color:#C678DD;">${des.replace(r, '$2')}</span>` +
                            `<span style="color:#ffd700e6;">${des.replace(r, '$3')}</span><span style="color:#05AD97;">${des.replace(r, '$4')}</span>`);
                    md.supportHtml = true;
                    return (new vscode.ParameterInformation(item, md))
                });
                return (info);
            });

            sig.activeSignature = context.triggerKind === 1 || (context.triggerKind === 2 && context.isRetrigger === false) ? 0 : context.activeSignatureHelp.activeSignature;
            let ui = (line.substring(i + 1).match(/(?:\w+|'\w+')(?:,|\s+,)/g) || []).length,
                pr = obj_items[FunctionName].pr;

            if (pr > 0)
                if (ui > pr - 1)
                    ui = pr - 1;

            sig.activeParameter = ui;

            return sig;
        }
    }
}

function ColorProvider() {
    return {
        provideDocumentColors(document) {
            // High CPU Protection: Skip color parsing for very large files
            if (document.lineCount > 10000) return [];

            const text = document.getText();
            const matches = text.matchAll(/\bC'\d{1,3},\d{1,3},\d{1,3}'|\bC'0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}'|\b0x(?:[A-Fa-f0-9]{2})?(?:[A-Fa-f0-9]{6})\b/g),
                ret = Array.from(matches).map(match => {
                    const colorName = match[0];
                    let clrRGB, hx, lr, lx;

                    hx = colorName.match(/\b0x(?:[A-Fa-f0-9]{2})?(?:[A-Fa-f0-9]{6})\b/);
                    if (hx) {
                        clrRGB = hexToRgbA(hx[0]);
                    }

                    else if (colorName.includes(`C'`)) {
                        lr = colorName.match(/(?<=C')\d{1,3},\d{1,3},\d{1,3}(?=')/);
                        if (lr) {
                            clrRGB = lr[0].split(',');
                            clrRGB.push(255);
                        }
                        else {
                            lx = colorName.match(/(?<=C')0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}(?=')/);
                            if (lx) {
                                clrRGB = lx[0].split(',').map(m => parseInt(m));
                                clrRGB.push(255);
                            }
                        }
                    }

                    if (clrRGB) {
                        return (new vscode.ColorInformation(new vscode.Range(
                            document.positionAt(match.index),
                            document.positionAt(match.index + match[0].length)
                        ),
                            new vscode.Color(clrRGB[0] / 255, clrRGB[1] / 255, clrRGB[2] / 255, round(clrRGB[3] / 255))));
                    }
                });

            // Optimized word filtering to avoid expensive re-scanning of the entire document
            const words = text.matchAll(/\w+/g);
            for (const item of words) {
                if (item[0] in colorW) {
                    const rgbCol = colorW[item[0]].split(',');
                    ret.push(new vscode.ColorInformation(new vscode.Range(
                        document.positionAt(item.index),
                        document.positionAt(item.index + item[0].length)
                    ),
                        new vscode.Color(rgbCol[0] / 255, rgbCol[1] / 255, rgbCol[2] / 255, 1)));
                }
            }

            return ret.filter(c => !!c);
        },

        provideColorPresentations(color, context) {
            const colorName = context.document.getText(context.range),
                red = color.red * 255,
                green = color.green * 255,
                blue = color.blue * 255,
                alpha = color.alpha * 255;

            if (colorName.match(/(?<=\b0x)(?:[A-Fa-f0-9]{2})?(?:[A-Fa-f0-9]{6})\b/)) {
                return [new vscode.ColorPresentation(`0x${rgbaToHex(blue, green, red, round(alpha, 0))}`)];
            }
            else if (colorName.includes(`C'`)) {
                if (colorName.match(/(?<=C')\d{1,3},\d{1,3},\d{1,3}(?=')/)) {
                    const clrRGB = `${red},${green},${blue}`;

                    for (let arg in colorW) {
                        if (colorW[arg] === clrRGB)
                            return [new vscode.ColorPresentation(arg)];

                    }
                    return [new vscode.ColorPresentation(`C'${clrRGB}'`)];
                }
                else if (colorName.match(/(?<=C')0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}(?=')/)) {
                    return [new vscode.ColorPresentation(`C'${dToHex(red, green, blue)}'`)]
                }
            }
            else if (colorName in colorW) {
                const clrRGB = `${red},${green},${blue}`;

                for (let arg in colorW) {
                    if (colorW[arg] === clrRGB)
                        return [new vscode.ColorPresentation(arg)];

                }
                return [new vscode.ColorPresentation(`C'${clrRGB}'`)];
            }
        }
    }
}

function hexToRgbA(hexColor) {
    return [
        hexColor & 0xFF, (hexColor >> 8) & 0xFF, (hexColor >> 16) & 0xFF, (hexColor >> 24) & 0xFF ? ((hexColor >> 24) & 0xFF) : 255
    ]
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
    return +(Math.round(num + "e" + precision) + "e" + -precision);
}


// =============================================================================
// DOCUMENT SYMBOL PROVIDER - Outline view, Breadcrumbs, Go to Symbol
// =============================================================================

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

module.exports = {
    Hover_log,
    DefinitionProvider,
    Hover_MQL,
    ItemProvider,
    HelpProvider,
    ColorProvider,
    MQLDocumentSymbolProvider,
    obj_items
}
