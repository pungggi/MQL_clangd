'use strict';

const vscode = require('vscode');
const pathModule = require('path');

/**
 * Format a date component with zero-padding.
 * @param {Date} date
 * @param {'Y'|'M'|'D'|'h'|'m'|'s'} t - Component type
 * @param {number} [d] - Optional default value
 * @returns {string} Zero-padded string
 */
function tf(date, t, d) {
    switch (t) {
        case 'Y': d = date.getFullYear(); break;
        case 'M': d = date.getMonth() + 1; break;
        case 'D': d = date.getDate(); break;
        case 'h': d = date.getHours(); break;
        case 'm': d = date.getMinutes(); break;
        case 's': d = date.getSeconds(); break;
    }
    return d < 10 ? '0' + d.toString() : d.toString();
}

/**
 * Collect regex alternatives into a single pattern string.
 * @param {string[]} dt - Array of regex patterns
 * @param {string} [string=''] - Accumulator
 * @returns {string} Combined alternation pattern
 */
function collectRegEx(dt, string = '') {
    for (const i in dt) {
        string += dt[i] + '|';
    }
    return string.slice(0, -1);
}

/**
 * Fix MQL-specific formatting (color/date literals) before compilation.
 * Removes erroneous spaces after C/D literal prefixes.
 * @returns {Promise<boolean>} Whether any formatting changes were made
 */
async function fixFormatting() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return false;
    const document = editor.document;
    const array = [];
    const data = {
        reg: [
            "\\bC '\\d{1,3},\\d{1,3},\\d{1,3}'",
            "\\bC '0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}'",
            "\\bD '(?:(?:\\d{2}|\\d{4})\\.\\d{2}\\.(?:\\d{2}|\\d{4})|(?:\\d{2}|\\d{4})\\.\\d{2}\\.(?:\\d{2}|\\d{4})\\s{1,}[\\d:]+)'"
        ],
        searchValue: [
            'C ',
            'C ',
            'D '
        ],
        replaceValue: [
            'C',
            'C',
            'D'
        ]
    };

    Array.from(document.getText().matchAll(new RegExp(collectRegEx(data.reg), 'g'))).forEach(match => {
        for (const i in data.reg) {
            if (match[0].match(new RegExp(data.reg[i], 'g'))) {
                let range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
                array.push({ range, to: document.getText(range).replace(data.searchValue[i], data.replaceValue[i]) });
            }
        }
    });

    if (!array.length) return false;

    return await editor.edit(editBuilder => {
        for (const { range, to } of array) {
            editBuilder.replace(range, to);
        }
    });
}

/**
 * Find the parent MQL file from a magic comment on the first line of an .mqh file.
 * Magic comment format: //###<relative/path/to/file.mq5>
 * @returns {string|undefined} Absolute path to the parent file, or undefined
 */
function findParentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const { document } = editor;
    const extension = pathModule.extname(document.fileName).toLowerCase();
    if (extension === '.mqh') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return undefined;
        const workspacepath = workspaceFolders[0].uri.fsPath;

        let NameFileMQL, match, regEx = new RegExp('(\\/\\/###<).+(mq[4|5]>)', 'ig');

        match = regEx.exec(document.lineAt(0).text);
        while (match) {
            NameFileMQL = match[0];
            match = regEx.exec(document.lineAt(0).text);
        }

        if (NameFileMQL != undefined)
            NameFileMQL = pathModule.join(workspacepath, String(NameFileMQL.match(/(?<=<).+(?=>)/)));

        return NameFileMQL;
    } else {
        return undefined;
    }
}

module.exports = { tf, fixFormatting, collectRegEx, findParentFile };
