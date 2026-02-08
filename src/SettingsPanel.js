/**
 * SettingsPanel - Webview for Rapid EA Configuration
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class SettingsPanel {
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

        // Set the HTML content
        this._panel.webview.html = this._getWebviewContent(this._panel.webview);

        // Set message listener
        this._setWebviewMessageListener(this._panel.webview);

        // Cleanup on dispose
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * @param {vscode.Uri} extensionUri
     * @param {vscode.ExtensionContext} context
     */
    static render(extensionUri, context) {
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'rapid-ea-settings',
                'Rapid EA Settings',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
                    retainContextWhenHidden: true
                }
            );

            SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context);
        }
    }

    dispose() {
        if (this._isDisposed) return;
        this._isDisposed = true;
        SettingsPanel.currentPanel = undefined;
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
     */
    _getWebviewContent(webview) {
        const nonce = this._getNonce();

        // Get current settings
        const currentInstructions = this._context.workspaceState.get('rapidEA.instructions', '');
        const currentFile = this._context.workspaceState.get('rapidEA.instructionFile', '');

        return /*html*/ `
          <!DOCTYPE html>
          <html lang="en">
          <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
              <title>Rapid EA Settings</title>
              <style>
                  body { background-color: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
                  h2 { color: #fff; border-bottom: 1px solid #444; padding-bottom: 10px; }
                  .section { margin-bottom: 25px; background: #252526; padding: 15px; border-radius: 6px; border: 1px solid #333; }
                  label { display: block; margin-bottom: 8px; font-weight: bold; color: #4CAF50; }
                  .description { font-size: 0.85em; color: #888; margin-bottom: 10px; }
                  
                  /* Search Box */
                  .search-container { position: relative; margin-bottom: 15px; }
                  input[type="text"] { 
                      width: 100%; padding: 10px; background: #3c3c3c; border: 1px solid #555; 
                      color: #fff; border-radius: 4px; box-sizing: border-box;
                  }
                  input[type="text"]:focus { outline: none; border-color: #0E639C; }

                  /* Results List */
                  #file-list { 
                      max-height: 200px; overflow-y: auto; background: #1e1e1e; border: 1px solid #444; 
                      border-radius: 4px; display: none; margin-top: 5px;
                  }
                  .file-item { 
                      padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #2b2b2b; color: #bbb;
                  }
                  .file-item:hover { background-color: #2a2d2e; color: #fff; }
                  .file-item.selected { background-color: #094771; color: #fff; }

                  /* Preview Area */
                  .selected-file-link {
                      color: #3794ff;
                      text-decoration: none;
                      cursor: pointer;
                      font-weight: bold;
                  }
                  .selected-file-link:hover {
                      text-decoration: underline;
                  }
                  
                  button {
                      padding: 8px 16px; background: #0E639C; color: white; border: none; 
                      cursor: pointer; border-radius: 4px; font-weight: 600;
                  }
                  button:hover { background: #1177BB; }
                  
                  .status-bar { margin-top: 15px; font-size: 0.9em; color: #FFD700; height: 1.2em; }
              </style>
          </head>
          <body>
              <h2>Rapid EA Configuration</h2>

              <div class="section">
                  <label>EA Instructions Context</label>
                  <div class="description">Search and select a documentation file (.md, .txt) to guide the strategy generation.</div>
                  
                  <div class="search-container">
                      <input type="text" id="file-search" placeholder="Search filenames (e.g., 'strategy', 'rules')..." autocomplete="off">
                      <div id="file-list"></div>
                  </div>

                  <div style="margin-bottom: 5px; font-size: 0.9em;">
                      Selected File: <span id="selected-file-link" class="selected-file-link" title="Click to open file">${currentFile || 'None'}</span>
                  </div>
                  
                  <div class="status-bar" id="status-msg"></div>
              </div>

              <script nonce="${nonce}">
                  const vscode = acquireVsCodeApi();
                  const searchInput = document.getElementById('file-search');
                  const fileList = document.getElementById('file-list');
                  const selectedFileLink = document.getElementById('selected-file-link');
                  const statusMsg = document.getElementById('status-msg');

                  let debounceTimer;

                  // Open File Handler
                  selectedFileLink.addEventListener('click', () => {
                      if (selectedFileLink.textContent !== 'None') {
                          vscode.postMessage({ command: 'openFile' });
                      }
                  });

                  // Search Handler
                  searchInput.addEventListener('input', (e) => {
                      const query = e.target.value;
                      if (!query) {
                          fileList.style.display = 'none';
                          return;
                      }

                      clearTimeout(debounceTimer);
                      debounceTimer = setTimeout(() => {
                          statusMsg.textContent = 'Searching...';
                          vscode.postMessage({ command: 'searchFiles', query: query });
                      }, 300);
                  });

                  // Handle Messages from Extension
                  window.addEventListener('message', event => {
                      const message = event.data;
                      
                      switch (message.command) {
                          case 'searchResults':
                              renderResults(message.files);
                              statusMsg.textContent = '';
                              break;
                          
                          case 'fileSelected':
                              selectedFileLink.textContent = message.fileName;
                              statusMsg.textContent = 'Instructions updated.';
                              break;

                          case 'error':
                              statusMsg.textContent = 'Error: ' + message.text;
                              statusMsg.style.color = '#ef5350';
                              break;
                      }
                  });

                  function renderResults(files) {
                      fileList.innerHTML = '';
                      if (files.length === 0) {
                          fileList.style.display = 'none';
                          statusMsg.textContent = 'No matching files found.';
                          return;
                      }

                      files.forEach(file => {
                          const div = document.createElement('div');
                          div.className = 'file-item';
                          div.textContent = file.label; // Display basename
                          div.title = file.path;        // Tooltip full path
                          
                          div.addEventListener('click', () => {
                              fileList.style.display = 'none';
                              searchInput.value = ''; // Clear search
                              statusMsg.textContent = 'Updating...';
                              vscode.postMessage({ command: 'selectFile', path: file.path });
                          });
                          
                          fileList.appendChild(div);
                      });
                      
                      fileList.style.display = 'block';
                  }
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

    _setWebviewMessageListener(webview) {
        webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'searchFiles':
                        try {
                            // Find .md and .txt files matching the query
                            const pattern = `**/*${message.query}*.{md,txt}`;
                            const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);

                            const results = files.map(f => ({
                                label: path.basename(f.fsPath),
                                path: f.fsPath
                            }));

                            webview.postMessage({ command: 'searchResults', files: results });
                        } catch (err) {
                            webview.postMessage({ command: 'error', text: err.message });
                        }
                        return;

                    case 'selectFile':
                        try {
                            const content = await fs.promises.readFile(message.path, 'utf-8');
                            const fileName = path.basename(message.path);

                            // Persist to workspace state
                            await this._context.workspaceState.update('rapidEA.instructions', content);
                            await this._context.workspaceState.update('rapidEA.instructionFile', fileName);
                            await this._context.workspaceState.update('rapidEA.instructionFilePath', message.path);

                            webview.postMessage({
                                command: 'fileSelected',
                                fileName: fileName
                            });
                        } catch (err) {
                            webview.postMessage({ command: 'error', text: 'Failed to read file: ' + err.message });
                        }
                        return;

                    case 'openFile':
                        try {
                            let filePath = this._context.workspaceState.get('rapidEA.instructionFilePath');

                            // Fallback: if full path is missing or stale, search workspace by basename
                            if (!filePath || !fs.existsSync(filePath)) {
                                const fileName = this._context.workspaceState.get('rapidEA.instructionFile');
                                if (fileName) {
                                    const matches = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 1);
                                    if (matches.length > 0) {
                                        filePath = matches[0].fsPath;
                                        await this._context.workspaceState.update('rapidEA.instructionFilePath', filePath);
                                    }
                                }
                            }

                            if (filePath && fs.existsSync(filePath)) {
                                const doc = await vscode.workspace.openTextDocument(filePath);
                                await vscode.window.showTextDocument(doc);
                            } else {
                                webview.postMessage({ command: 'error', text: 'File not found in workspace' });
                            }
                        } catch (err) {
                            webview.postMessage({ command: 'error', text: 'Failed to open file: ' + err.message });
                        }
                        return;
                }
            },
            undefined,
            this._disposables
        );
    }
}

module.exports = { SettingsPanel };
