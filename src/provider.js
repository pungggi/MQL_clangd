'use strict';

const vscode = require('vscode');
const colorW = require('../data/color.json');
const obj_items = require('../data/items.json');
const { hexToRgbA, rgbaToHex, dToHex, round } = require('./providerUtils');

// Re-export split modules so existing consumers don't need to change imports
const { Hover_log, DefinitionProvider, Hover_MQL } = require('./hoverProvider');
const { ItemProvider, HelpProvider } = require('./completionProvider');
const { MQLDocumentSymbolProvider } = require('./symbolProvider');
const { extractDocumentSymbols } = require('./providerUtils');

// =============================================================================
// COLOR PROVIDER
// =============================================================================

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

                    else if (colorName.includes('C\'')) {
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
            else if (colorName.includes('C\'')) {
                if (colorName.match(/(?<=C')\d{1,3},\d{1,3},\d{1,3}(?=')/)) {
                    const clrRGB = `${red},${green},${blue}`;

                    for (let arg in colorW) {
                        if (colorW[arg] === clrRGB)
                            return [new vscode.ColorPresentation(arg)];

                    }
                    return [new vscode.ColorPresentation(`C'${clrRGB}'`)];
                }
                else if (colorName.match(/(?<=C')0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2},0x[A-Fa-f0-9]{2}(?=')/)) {
                    return [new vscode.ColorPresentation(`C'${dToHex(red, green, blue)}'`)];
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
    obj_items,
    extractDocumentSymbols
};
