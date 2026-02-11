'use strict';

const vscode = require('vscode');
const obj_items = require('../data/items.json');
const colorW = require('../data/color.json');
const { getLanguage, getMiniIconPath, extractDocumentSymbols, getIncludeDir, getIncludeEntries, rgbaToHex } = require('./providerUtils');

function ItemProvider() {
    return {
        provideCompletionItems(document, position, _token, _context) {
            const loclang = getLanguage() === 'zh-tw' ? 'zh-cn' : getLanguage();
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
                    contents.appendMarkdown(`![](${getMiniIconPath()})`);
                    item.documentation = contents;
                    return item;
                });

            completionItems.push(...mqlItems);

            return completionItems;
        }
    };
}

function HelpProvider() {
    return {
        provideSignatureHelp(document, position, _token, context) {
            const loclang = getLanguage() === 'zh-tw' ? 'zh-cn' : getLanguage(),
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
                    return (new vscode.ParameterInformation(item, md));
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
    };
}

module.exports = { ItemProvider, HelpProvider };
