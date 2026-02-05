import * as vscode from 'vscode';
import { RapidPanel } from './panels/RapidPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Rapid EA Extension is now active!');

    const startCommand = vscode.commands.registerCommand('rapid-ea.start', () => {
        RapidPanel.render(context.extensionUri);
    });

    context.subscriptions.push(startCommand);
}
