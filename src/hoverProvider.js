'use strict';

const vscode = require('vscode');
const lg = require('./language');
const err_codes = require('../data/error-codes.json');
const obj_items = require('../data/items.json');
const colorW = require('../data/color.json');
const { getLanguage, extractDocumentSymbols, rgbaToHex } = require('./providerUtils');

function Hover_log() {
    return {
        provideHover(document, position) {
            const word = document.lineAt(position.line).text;
            // Access obj_hover dynamically from compiler module
            const compiler = require('./compiler');
            const obj_hover = compiler.obj_hover || {};

            if (!(word in obj_hover)) return undefined;

            const link = (typeof obj_hover[word].link == 'undefined') ? '' : obj_hover[word].link,
                loclang = getLanguage() === 'zh-tw' ? 'zh-cn' : getLanguage();

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
    };
}

function DefinitionProvider() {
    return {
        provideDefinition(document, position) {
            const word = document.lineAt(position.line).text;
            // Access obj_hover dynamically from compiler module
            const compiler = require('./compiler');
            const obj_hover = compiler.obj_hover || {};

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
    };
}

function Hover_MQL() {
    return {
        provideHover(document, position) {
            const loclang = getLanguage() === 'zh-tw' ? 'zh-cn' : getLanguage();
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
                contents.appendMarkdown('User-configurable parameter for this EA/Indicator.');
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
                const cleanDesc = dl.replace(/^\([^)]+\)\s*/, '').trim();

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

module.exports = { Hover_log, DefinitionProvider, Hover_MQL };
