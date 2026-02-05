"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = require("vscode");
const RapidPanel_1 = require("./panels/RapidPanel");
function activate(context) {
    console.log('Rapid EA Extension is now active!');
    const startCommand = vscode.commands.registerCommand('rapid-ea.start', () => {
        RapidPanel_1.RapidPanel.render(context.extensionUri);
    });
    context.subscriptions.push(startCommand);
}
//# sourceMappingURL=extension.js.map