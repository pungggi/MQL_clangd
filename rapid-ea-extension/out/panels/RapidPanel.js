"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RapidPanel = void 0;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
class RapidPanel {
    constructor(panel, extensionUri) {
        this._disposables = [];
        this._panel = panel;
        this._extensionUri = extensionUri;
        // Set the HTML content for the webview panel
        this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
        // Set an event listener to listen for messages passed from the webview context
        this._setWebviewMessageListener(this._panel.webview);
        // Check for disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }
    static render(extensionUri) {
        if (RapidPanel.currentPanel) {
            RapidPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
        }
        else {
            const panel = vscode.window.createWebviewPanel('rapid-ea-panel', 'Rapid EA', vscode.ViewColumn.One, {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, '../rapid-ea/dist')
                ]
            });
            RapidPanel.currentPanel = new RapidPanel(panel, extensionUri);
        }
    }
    dispose() {
        RapidPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
    _getWebviewContent(webview, extensionUri) {
        // Tip: Install the "es6-string-html" VS Code extension to enable code highlighting below
        // Use ../rapid-ea/dist as the build output source
        const buildPath = vscode.Uri.joinPath(extensionUri, '../rapid-ea/dist');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(buildPath, 'bundle.js'));
        // Note: In a real extension, we might copy the dist folder into the extension folder during build.
        // For this PoC, we point directly to the sibling folder.
        return /*html*/ `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Rapid EA</title>
              <style>
                  body { margin: 0; padding: 0; background-color: #1e1e1e; color: #ccc; }
              </style>
          </head>
          <body>
              <div id="root">
                  <!-- The App content will be injected here by bundle.js (it expects index.html structure, we might need to mimic it) -->
                   <div style="padding: 10px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <span style="font-weight: bold; color: #4CAF50;">Rapid-EA</span>
                            <span style="font-size: 0.8em; color: #888; margin-left: 10px;">Visual Strategy Builder</span>
                        </div>
                        <div id="status-msg" style="font-size: 0.9em; color: #FFD700;">Ready</div>
                    </div>

                    <div style="display: flex; height: calc(100vh - 50px);">
                        <!-- Left Panel: Controls -->
                        <div style="width: 300px; padding: 20px; background-color: #252526; border-right: 1px solid #333; display: flex; flex-direction: column; gap: 15px;">
                            
                            <div>
                                <label style="display: block; margin-bottom: 5px; color: #ccc;">Strategy Description</label>
                                <textarea id="strategy-input" rows="6" style="width: 100%; background: #3c3c3c; color: #fff; border: 1px solid #555; padding: 8px; border-radius: 4px;" placeholder="e.g. Simple Moving Average Crossover..."></textarea>
                            </div>

                            <div style="display: flex; gap: 10px;">
                                <button id="btn-visualize" style="flex: 1; padding: 8px; background: #0E639C; color: white; border: none; cursor: pointer; border-radius: 4px;">Visualize</button>
                                <button id="btn-code" style="flex: 1; padding: 8px; background: #388E3C; color: white; border: none; cursor: pointer; border-radius: 4px;">Generate Code</button>
                            </div>

                            <div id="mql-output" style="display: none; background: #1e1e1e; padding: 10px; border: 1px solid #444; color: #9cdcfe; font-family: monospace; height: 200px; overflow: auto; white-space: pre-wrap;"></div>
                            
                            <div id="codebase-visibility" style="margin-top: 10px; border-top: 1px solid #444; padding-top: 10px;">
                                <div style="font-size: 0.9em; color: #888; margin-bottom: 5px; display: flex; justify-content: space-between;">
                                    <span>Codebase Visibility</span>
                                    <span id="btn-scan" style="color: #0E639C; cursor: pointer; text-decoration: underline;">Scan</span>
                                </div>
                                <ul id="codebase-list" style="font-size: 0.8em; color: #666; padding-left: 15px; margin: 0; max-height: 100px; overflow-y: auto;">
                                    <li>No files scanned</li>
                                </ul>
                            </div>

                            <div style="margin-top: auto; padding-top: 10px; border-top: 1px solid #444; font-size: 0.8em; color: #666;">
                                Mock AI Agent Active
                            </div>
                        </div>

                        <!-- Right Panel: Visualization -->
                        <div id="chart-container" style="flex: 1; position: relative;">
                            <!-- Chart render area -->
                        </div>
                    </div>
              </div>
              <script src="${scriptUri}"></script>
          </body>
          </html>
        `;
    }
    _setWebviewMessageListener(webview) {
        webview.onDidReceiveMessage(async (message) => {
            const command = message.command;
            const text = message.text;
            switch (command) {
                case 'requestData':
                    // DATA ACCESS: Read market_data.json from workspace
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders && workspaceFolders.length > 0) {
                        const rootPath = workspaceFolders[0].uri.fsPath;
                        // Assume market_data.json is in rapid-ea folder for now, or root
                        // Let's check root first, then rapid-ea
                        let dataPath = path.join(rootPath, 'rapid-ea', 'market_data.json');
                        try {
                            if (!fs.existsSync(dataPath)) {
                                // Try alternate location
                                dataPath = path.join(rootPath, 'market_data.json');
                            }
                            if (fs.existsSync(dataPath)) {
                                const fileContent = await fs.promises.readFile(dataPath, 'utf-8');
                                webview.postMessage({
                                    command: 'receiveData',
                                    data: JSON.parse(fileContent)
                                });
                                vscode.window.showInformationMessage(`Loaded data from ${dataPath}`);
                            }
                            else {
                                vscode.window.showErrorMessage(`Could not find market_data.json in ${rootPath}`);
                                webview.postMessage({ command: 'receiveData', error: 'File not found' });
                            }
                        }
                        catch (error) {
                            vscode.window.showErrorMessage(`Error reading file: ${error.message}`);
                        }
                    }
                    else {
                        vscode.window.showErrorMessage("No workspace open.");
                    }
                    return;
                case 'scanCodebase':
                    // CODEBASE ACCESS: Prove we can see MQL headers
                    const mqlFiles = await vscode.workspace.findFiles('**/*.mqh', '**/node_modules/**', 20);
                    const fileNames = mqlFiles.map(f => path.basename(f.fsPath));
                    webview.postMessage({
                        command: 'codebaseScanned',
                        files: fileNames
                    });
                    return;
                case 'saveCode':
                    // IMPLEMENTATION for saving MQL code
                    vscode.window.showInformationMessage(`Generate Code request received: ${text.substring(0, 20)}...`);
                    return;
            }
        }, undefined, this._disposables);
    }
}
exports.RapidPanel = RapidPanel;
//# sourceMappingURL=RapidPanel.js.map