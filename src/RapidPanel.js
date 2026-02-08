/**
 * Rapid-EA Panel - Webview for visual strategy building and MQL code generation
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class RapidPanel {
    static currentPanel = undefined;

    /**
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    constructor(panel, extensionUri, context) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;
        this._disposables = [];
        this._isDisposed = false;

        // Set the HTML content for the webview panel
        this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);

        // Set an event listener to listen for messages passed from the webview context
        this._setWebviewMessageListener(this._panel.webview);

        // Check for disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    static render(extensionUri, context) {
        if (RapidPanel.currentPanel) {
            RapidPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'rapid-ea-panel',
                'Rapid EA',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [
                        vscode.Uri.joinPath(extensionUri, 'rapid-ea', 'dist')
                    ],
                    retainContextWhenHidden: true
                }
            );

            RapidPanel.currentPanel = new RapidPanel(panel, extensionUri, context);
        }
    }

    dispose() {
        if (this._isDisposed) return;
        this._isDisposed = true;
        RapidPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    /**
     * @param {vscode.Webview} webview
     * @param {vscode.Uri} extensionUri
     */
    _getWebviewContent(webview, extensionUri) {
        // Use rapid-ea/dist as the build output source
        const buildPath = vscode.Uri.joinPath(extensionUri, 'rapid-ea', 'dist');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(buildPath, 'bundle.js'));
        const nonce = this._getNonce();

        // Get stored instructions
        const instructions = this._context.workspaceState.get('rapidEA.instructions', '')
            .replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        const instructionFile = this._context.workspaceState.get('rapidEA.instructionFile', 'None');

        return /*html*/ `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';">
              <title>Rapid EA</title>
              <style>
                  body { margin: 0; padding: 0; background-color: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
              </style>
          </head>
          <body>
              <div id="root">
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
                            
                            <div id="active-instructions-bar" style="background: rgba(76, 175, 80, 0.1); border: 1px solid rgba(76, 175, 80, 0.3); padding: 8px; border-radius: 4px; font-size: 0.85em;">
                                <div style="color: #888; margin-bottom: 2px;">Context Instructions:</div>
                                <div id="instruction-filename" style="color: #4CAF50; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${instructionFile}">${instructionFile}</div>
                            </div>

                            <div>
                                <label style="display: block; margin-bottom: 5px; color: #ccc;">Strategy Description</label>
                                <textarea id="strategy-input" rows="6" style="width: 100%; background: #3c3c3c; color: #fff; border: 1px solid #555; padding: 8px; border-radius: 4px; resize: vertical;" placeholder="Describe your trading strategy..."></textarea>
                            </div>

                            <div style="display: flex; gap: 10px;">
                                <button id="btn-visualize" style="flex: 1; padding: 10px; background: #0E639C; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">Visualize</button>
                                <button id="btn-code" style="flex: 1; padding: 10px; background: #388E3C; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">Generate Code</button>
                            </div>

                            <div id="mql-output" style="display: none; background: #1e1e1e; padding: 10px; border: 1px solid #444; color: #9cdcfe; font-family: 'Consolas', 'Courier New', monospace; font-size: 12px; height: 200px; overflow: auto; white-space: pre-wrap; border-radius: 4px;"></div>
                            
                            <div id="codebase-visibility" style="margin-top: 10px; border-top: 1px solid #444; padding-top: 10px;">
                                <div style="font-size: 0.9em; color: #888; margin-bottom: 5px; display: flex; justify-content: space-between;">
                                    <span>MQL Codebase</span>
                                    <span id="btn-scan" style="color: #0E639C; cursor: pointer; text-decoration: underline;">Scan</span>
                                </div>
                                <ul id="codebase-list" style="font-size: 0.8em; color: #666; padding-left: 15px; margin: 0; max-height: 100px; overflow-y: auto; list-style: none;">
                                    <li>Click Scan to detect .mqh files</li>
                                </ul>
                            </div>

                            <div style="margin-top: auto; padding-top: 10px; border-top: 1px solid #444; font-size: 0.8em; color: #666;">
                                <span style="color: #4CAF50;">●</span> MQL-Clangd Integrated
                            </div>
                        </div>

                        <!-- Right Panel: Visualization -->
                        <div id="chart-container" style="flex: 1; position: relative;">
                            <!-- Chart render area -->
                        </div>
                    </div>
              </div>
              <script nonce="${nonce}">
                  // Inject instructions from settings
                  window.initialInstructions = "${instructions}";
              </script>
              <script nonce="${nonce}" src="${scriptUri}"></script>
          </body>
          </html>
        `;
    }

    _getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * @param {vscode.Webview} webview
     */
    _setWebviewMessageListener(webview) {
        webview.onDidReceiveMessage(
            async (message) => {
                const command = message.command;

                switch (command) {
                    case 'requestData':
                        // DATA ACCESS: Read market_data.json from workspace
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders && workspaceFolders.length > 0) {
                            const rootPath = workspaceFolders[0].uri.fsPath;
                            let dataPath = path.join(rootPath, 'rapid-ea', 'market_data.json');

                            try {
                                if (!fs.existsSync(dataPath)) {
                                    dataPath = path.join(rootPath, 'market_data.json');
                                }

                                if (fs.existsSync(dataPath)) {
                                    const fileContent = await fs.promises.readFile(dataPath, 'utf-8');
                                    webview.postMessage({
                                        command: 'receiveData',
                                        data: JSON.parse(fileContent)
                                    });
                                } else {
                                    // No file found, webview will use mock data
                                    webview.postMessage({ command: 'receiveData', error: 'File not found' });
                                }
                            } catch (error) {
                                webview.postMessage({
                                    command: 'receiveData',
                                    error: String(error.message || error)
                                });
                            }
                        } else {
                            webview.postMessage({ command: 'receiveData', error: 'No workspace open' });
                        }
                        return;

                    case 'scanCodebase':
                        // CODEBASE ACCESS: Find MQL headers
                        const mqlFiles = await vscode.workspace.findFiles('**/*.mqh', '**/node_modules/**', 50);
                        const fileNames = mqlFiles.map(f => path.basename(f.fsPath));
                        webview.postMessage({
                            command: 'codebaseScanned',
                            files: fileNames
                        });
                        return;

                    case 'getInstructions':
                        const instructions = this._context.workspaceState.get('rapidEA.instructions', '');
                        webview.postMessage({
                            command: 'instructionsData',
                            content: instructions
                        });
                        return;

                    case 'saveCode':
                        // Save generated MQL code to a file
                        const code = message.text;
                        if (!code) return;

                        const saveUri = await vscode.window.showSaveDialog({
                            defaultUri: vscode.Uri.file('GeneratedEA.mq5'),
                            filters: { 'MQL5 Files': ['mq5'], 'MQL4 Files': ['mq4'] }
                        });

                        if (saveUri) {
                            await fs.promises.writeFile(saveUri.fsPath, code, 'utf-8');
                            vscode.window.showInformationMessage(`Saved to ${path.basename(saveUri.fsPath)}`);

                            // Open the file in editor
                            const doc = await vscode.workspace.openTextDocument(saveUri);
                            await vscode.window.showTextDocument(doc);
                        }
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }
}

module.exports = { RapidPanel };
