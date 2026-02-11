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
        // Escape HTML to prevent XSS
        const escapedInstructionFile = instructionFile
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

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
                        <div style="width: 340px; padding: 15px; background-color: #252526; border-right: 1px solid #333; display: flex; flex-direction: column; gap: 10px; overflow-y: auto;">
                            
                            <!-- Framework Section -->
                            <div class="input-section" style="background: rgba(255, 152, 0, 0.05); border: 1px solid rgba(255, 152, 0, 0.2); border-radius: 6px; padding: 10px;">
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                    <span style="color: #FF9800; font-size: 12px;">◆</span>
                                    <label style="color: #FF9800; font-weight: bold; font-size: 12px;">FRAMEWORK</label>
                                </div>
                                <div style="font-size: 10px; color: #888; margin-bottom: 6px;">Candlestick patterns, price structures, time situations</div>
                                <textarea id="input-framework" rows="2" style="width: 100%; background: #1e1e1e; color: #fff; border: 1px solid #444; padding: 6px; border-radius: 4px; resize: vertical; font-size: 11px;" placeholder="e.g., Engulfing, Pin Bar, Inside Bar, Break of Structure..."></textarea>
                            </div>

                            <!-- Triggers Section -->
                            <div class="input-section" style="background: rgba(33, 150, 243, 0.05); border: 1px solid rgba(33, 150, 243, 0.2); border-radius: 6px; padding: 10px;">
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                    <span style="color: #2196F3; font-size: 12px;">⚡</span>
                                    <label style="color: #2196F3; font-weight: bold; font-size: 12px;">TRIGGERS</label>
                                </div>
                                <div style="font-size: 10px; color: #888; margin-bottom: 6px;">What triggers entry, state transitions, confirmations</div>
                                <textarea id="input-triggers" rows="2" style="width: 100%; background: #1e1e1e; color: #fff; border: 1px solid #444; padding: 6px; border-radius: 4px; resize: vertical; font-size: 11px;" placeholder="e.g., Liquidity sweep + rejection, FVG fill, Order block touch..."></textarea>
                            </div>

                            <!-- Targets Section -->
                            <div class="input-section" style="background: rgba(76, 175, 80, 0.05); border: 1px solid rgba(76, 175, 80, 0.2); border-radius: 6px; padding: 10px;">
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                    <span style="color: #4CAF50; font-size: 12px;">🎯</span>
                                    <label style="color: #4CAF50; font-weight: bold; font-size: 12px;">TARGETS</label>
                                </div>
                                <div style="font-size: 10px; color: #888; margin-bottom: 6px;">TP, SL, trailing, partial exits, R:R logic</div>
                                <textarea id="input-targets" rows="2" style="width: 100%; background: #1e1e1e; color: #fff; border: 1px solid #444; padding: 6px; border-radius: 4px; resize: vertical; font-size: 11px;" placeholder="e.g., SL below swing low, TP at next liquidity pool, trail after 1:1..."></textarea>
                            </div>

                            <!-- Strategy Overview Section -->
                            <div class="input-section" style="background: rgba(156, 39, 176, 0.05); border: 1px solid rgba(156, 39, 176, 0.2); border-radius: 6px; padding: 10px;">
                                <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                                    <span style="color: #9C27B0; font-size: 12px;">📋</span>
                                    <label style="color: #9C27B0; font-weight: bold; font-size: 12px;">STRATEGY</label>
                                </div>
                                <div style="font-size: 10px; color: #888; margin-bottom: 6px;">Session filters, exceptions, correlations, overview</div>
                                <textarea id="input-strategy" rows="2" style="width: 100%; background: #1e1e1e; color: #fff; border: 1px solid #444; padding: 6px; border-radius: 4px; resize: vertical; font-size: 11px;" placeholder="e.g., London/NY sessions only, avoid news, check DXY correlation..."></textarea>
                            </div>

                            <div style="display: flex; gap: 10px;">
                                <button id="btn-visualize" style="flex: 1; padding: 10px; background: #0E639C; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">Visualize</button>
                                <button id="btn-code" style="flex: 1; padding: 10px; background: #388E3C; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">Generate Code</button>
                            </div>
                            
                            <div id="codebase-visibility" style="margin-top: 10px; border-top: 1px solid #444; padding-top: 10px;">
                                <!-- Ask Pattern Button - Point & Ask Feature -->
                                <button id="btn-ask-pattern" onclick="handleAskPattern()" style="display: none; width: 100%; margin-bottom: 10px; padding: 12px; background: linear-gradient(135deg, #9C27B0, #673AB7); color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; font-size: 12px;">
                                    🔍 Ask Pattern (MTF Analysis)
                                </button>
                                <div style="font-size: 0.9em; color: #888; margin-bottom: 5px; display: flex; justify-content: space-between;">
                                    <span>MQL Codebase</span>
                                    <span id="btn-scan" style="color: #0E639C; cursor: pointer; text-decoration: underline;">Scan</span>
                                </div>
                                <ul id="codebase-list" style="font-size: 0.8em; color: #666; padding-left: 15px; margin: 0; max-height: 100px; overflow-y: auto; list-style: none;">
                                    <li>Click Scan to detect .mqh files</li>
                                </ul>
                            </div>

                            <div style="margin-top: auto; padding-top: 10px; border-top: 1px solid #444;">
                                <div id="generated-files-section" style="display: none; background: rgba(14, 99, 156, 0.1); border: 1px solid rgba(14, 99, 156, 0.3); padding: 8px; border-radius: 4px; font-size: 0.8em; margin-bottom: 8px;">
                                    <div style="color: #888; margin-bottom: 4px; font-size: 0.85em;">Generated File:</div>
                                    <div id="generated-file-link" style="color: #0E639C; cursor: pointer; text-decoration: underline; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></div>
                                </div>
                                <div id="active-instructions-bar" style="background: rgba(76, 175, 80, 0.1); border: 1px solid rgba(76, 175, 80, 0.3); padding: 8px; border-radius: 4px; font-size: 0.8em; margin-bottom: 8px;">
                                    <div style="color: #888; margin-bottom: 2px; font-size: 0.85em;">Context Instructions:</div>
                                    <div id="instruction-filename" style="color: #4CAF50; font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapedInstructionFile}">${escapedInstructionFile}</div>
                                </div>
                                <div style="font-size: 0.8em; color: #666;">
                                    <span style="color: #4CAF50;">●</span> MQL-Clangd Integrated
                                </div>
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
              <script nonce="${nonce}">
                  // Fallback: if bundle failed to initialize, show diagnostic info
                  setTimeout(function() {
                      var s = document.getElementById('status-msg');
                      if (s && s.textContent === 'Ready') {
                          s.textContent = 'Warning: bundle may not have loaded';
                          s.style.color = '#FF5252';
                          console.error('[Rapid-EA] Bundle did not initialize within timeout');
                      }
                  }, 2000);
              </script>
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

                    case 'askPattern':
                        // Point & Ask feature - save context and invoke OpenCode
                        if (message.context) {
                            try {
                                // Save context to a temp file for reference
                                const workspaceFolders = vscode.workspace.workspaceFolders;
                                if (workspaceFolders && workspaceFolders.length > 0) {
                                    const contextPath = path.join(workspaceFolders[0].uri.fsPath, '.rapid-ea-context.md');
                                    await vscode.workspace.fs.writeFile(
                                        vscode.Uri.file(contextPath),
                                        Buffer.from(message.context, 'utf8')
                                    );
                                }

                                // Copy context to clipboard for easy paste into OpenCode
                                await vscode.env.clipboard.writeText(message.context);

                                // Show notification
                                vscode.window.showInformationMessage(
                                    'Pattern context copied to clipboard! Paste into OpenCode to analyze.',
                                    'Open Context File'
                                ).then(selection => {
                                    if (selection === 'Open Context File') {
                                        const workspaceFolders = vscode.workspace.workspaceFolders;
                                        if (workspaceFolders && workspaceFolders.length > 0) {
                                            const contextPath = path.join(workspaceFolders[0].uri.fsPath, '.rapid-ea-context.md');
                                            vscode.workspace.openTextDocument(vscode.Uri.file(contextPath))
                                                .then(doc => vscode.window.showTextDocument(doc));
                                        }
                                    }
                                });
                            } catch (err) {
                                vscode.window.showErrorMessage('Failed to process pattern context: ' + err.message);
                            }
                        }
                        return;

                    case 'openFile':
                        // Open a file in the editor when clicking the generated file link
                        if (message.filePath) {
                            // Validate path is within workspace to prevent path traversal
                            const workspaceFolders = vscode.workspace.workspaceFolders;
                            if (!workspaceFolders || workspaceFolders.length === 0) {
                                webview.postMessage({ command: 'invalidPath', text: 'No workspace open' });
                                return;
                            }

                            // Resolve to absolute path and normalize
                            const resolvedPath = path.resolve(message.filePath);
                            const isWithinWorkspace = workspaceFolders.some(folder => {
                                const folderPath = folder.uri.fsPath;
                                return resolvedPath.startsWith(folderPath);
                            });

                            if (!isWithinWorkspace) {
                                webview.postMessage({ command: 'invalidPath', text: 'File outside workspace' });
                                return;
                            }

                            const fileUri = vscode.Uri.file(resolvedPath);
                            try {
                                // Check if file exists
                                await vscode.workspace.fs.stat(fileUri);

                                // Try to find if file is already open
                                const existingDoc = vscode.workspace.textDocuments.find(
                                    doc => doc.uri.fsPath === fileUri.fsPath
                                );

                                if (existingDoc) {
                                    // Reuse existing tab
                                    await vscode.window.showTextDocument(existingDoc, {
                                        preserveFocus: false,
                                        preview: false
                                    });
                                } else {
                                    // Open new tab
                                    const doc = await vscode.workspace.openTextDocument(fileUri);
                                    await vscode.window.showTextDocument(doc, {
                                        viewColumn: vscode.ViewColumn.Beside,
                                        preview: false
                                    });
                                }
                            } catch {
                                // File was deleted - notify webview to remove the link
                                webview.postMessage({ command: 'fileDeleted', filePath: message.filePath });
                            }
                        }
                        return;

                    case 'saveCode':
                        // Save generated MQL code directly to the workspace
                        const code = message.text;
                        if (!code) return;

                        try {
                            const wsFolders = vscode.workspace.workspaceFolders;
                            if (!wsFolders || wsFolders.length === 0) {
                                vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
                                return;
                            }

                            const rootUri = wsFolders[0].uri;

                            // Create Experts folder if it doesn't exist
                            const expertsUri = vscode.Uri.joinPath(rootUri, 'Experts');
                            try {
                                await vscode.workspace.fs.stat(expertsUri);
                            } catch {
                                await vscode.workspace.fs.createDirectory(expertsUri);
                            }

                            // Generate unique filename with timestamp
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                            const fileName = `GeneratedEA_${timestamp}.mq5`;
                            const fileUri = vscode.Uri.joinPath(expertsUri, fileName);

                            // Create and write the file using WorkspaceEdit
                            const edit = new vscode.WorkspaceEdit();
                            edit.createFile(fileUri, { ignoreIfExists: false, overwrite: false });
                            await vscode.workspace.applyEdit(edit);

                            // Write content to the file
                            const encoder = new TextEncoder();
                            await vscode.workspace.fs.writeFile(fileUri, encoder.encode(code));

                            // Open the file in an editor tab
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            await vscode.window.showTextDocument(document, {
                                viewColumn: vscode.ViewColumn.Beside,
                                preview: false
                            });

                            vscode.window.showInformationMessage(`Created: ${fileName}`);

                            // Notify webview about the created file
                            webview.postMessage({
                                command: 'fileCreated',
                                fileName: fileName,
                                filePath: fileUri.fsPath
                            });
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to create file: ${error.message || error}`);
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
