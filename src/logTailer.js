'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class MqlLogTailer {
    constructor() {
        this.outputChannel = null;
        this.currentFilePath = null;
        this.lastSize = 0;
        this.timer = null;
        this.isTailing = false;
        this.mqlVersion = null; // 'mql4' or 'mql5'
        this.statusBarItem = null;
    }

    /**
     * Initializes the status bar item.
     */
    initStatusBar() {
        if (!this.statusBarItem) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            this.statusBarItem.command = 'mql_tools.toggleTerminalLog';
            this.updateStatusBar();
        }
    }

    /**
     * Toggles the log tailing state.
     */
    async toggle() {
        if (this.isTailing) {
            this.stop();
        } else {
            await this.start();
        }
        this.updateStatusBar();
    }

    /**
     * Starts tailing the log file.
     */
    async start() {
        const config = vscode.workspace.getConfiguration('mql_tools');

        // Fully automated version and path inference
        let version = this.detectMqlVersion();

        if (!version) {
            // Default to mql5 if we really can't tell, the subsequent 
            // folder check will handle the "not set" case anyway.
            version = 'mql5';
        }

        this.mqlVersion = version;
        const logFolderName = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
        let rawIncDir = config.get(`Metaeditor.${logFolderName}`);

        if (!rawIncDir) {
            // Attempt to infer path from active file or workspace
            rawIncDir = this.inferDataFolder(version);
        }

        if (!rawIncDir) {
            vscode.window.showErrorMessage(`Include path for ${version.toUpperCase()} is not set and could not be inferred. Please configure MQL Tools settings.`, 'Configure')
                .then(selection => {
                    if (selection === 'Configure') {
                        vscode.commands.executeCommand('workbench.action.openSettings', `mql_tools.Metaeditor.Include${version === 'mql4' ? '4' : '5'}Dir`);
                    }
                });
            return;
        }

        // Resolve workspace variables
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (rawIncDir.includes('${workspaceFolder}')) {
            rawIncDir = rawIncDir.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
        }

        // Find the Logs folder
        let basePath = rawIncDir;
        if (path.basename(basePath).toLowerCase() === 'include') {
            basePath = path.dirname(basePath);
        }

        const logsDir = path.join(basePath, 'Logs');
        if (!fs.existsSync(logsDir)) {
            vscode.window.showErrorMessage(`Logs folder not found at: ${logsDir}. Make sure your Include path points into the MQL4/MQL5 data folder.`, 'Configure')
                .then(selection => {
                    if (selection === 'Configure') {
                        vscode.commands.executeCommand('workbench.action.openSettings', `mql_tools.Metaeditor.Include${version === 'mql4' ? '4' : '5'}Dir`);
                    }
                });
            return;
        }

        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(`MQL ${version.toUpperCase()} Runtime Log`);
        }

        const fileName = this.getLogFileName();
        this.currentFilePath = path.join(logsDir, fileName);

        this.outputChannel.show(true);
        this.outputChannel.appendLine(`--- Starting Live Tail: ${this.currentFilePath} ---`);
        this.outputChannel.appendLine(`[Info] Tailing MQL logs from ${logsDir}`);

        // Set initial size to end of file to prevent dump of historical logs
        if (fs.existsSync(this.currentFilePath)) {
            this.lastSize = fs.statSync(this.currentFilePath).size;
        } else {
            this.lastSize = 0;
            this.outputChannel.appendLine(`[Warning] Log file ${fileName} does not exist yet. Waiting for terminal activity...`);
        }

        this.isTailing = true;
        this.poll();
    }

    /**
     * Stops tailing.
     */
    stop() {
        this.isTailing = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.outputChannel) {
            this.outputChannel.appendLine(`--- Tail Stopped ---`);
        }
    }

    /**
     * Logic to detect MQL version from active state.
     */
    detectMqlVersion() {
        const editor = vscode.window.activeTextEditor;

        // 1. Check active editor first
        if (editor) {
            const fileName = editor.document.fileName.toLowerCase();
            if (fileName.endsWith('.mq4')) return 'mql4';
            if (fileName.endsWith('.mq5')) return 'mql5';
            if (fileName.includes('mql4')) return 'mql4';
            if (fileName.includes('mql5')) return 'mql5';
        }

        // 2. Check workspace folders
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const folderName = folder.name.toLowerCase();
                const folderPath = folder.uri.fsPath.toLowerCase();
                if (folderName.includes('mql4') || folderPath.includes('mql4')) return 'mql4';
                if (folderName.includes('mql5') || folderPath.includes('mql5')) return 'mql5';
            }
        }

        // 3. Check if settings imply one version
        const config = vscode.workspace.getConfiguration('mql_tools');
        const inc4 = config.get('Metaeditor.Include4Dir');
        const inc5 = config.get('Metaeditor.Include5Dir');

        if (inc5 && !inc4) return 'mql5';
        if (inc4 && !inc5) return 'mql4';

        return null;
    }

    /**
     * Tries to infer the MQL data folder based on the current file path
     * or workspace structure.
     */
    inferDataFolder(version) {
        const editor = vscode.window.activeTextEditor;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const targetDirName = version.toUpperCase(); // "MQL4" or "MQL5"

        // Strategy 1: Trace up from active file
        if (editor) {
            let current = path.dirname(editor.document.fileName);
            const root = path.parse(current).root;

            while (current !== root) {
                const baseName = path.basename(current).toUpperCase();
                if (baseName === targetDirName) {
                    // Check if it has the standard subfolders
                    if (fs.existsSync(path.join(current, 'Logs')) || fs.existsSync(path.join(current, 'Include'))) {
                        return current;
                    }
                }
                current = path.dirname(current);
            }
        }

        // Strategy 2: Check workspace root
        if (workspaceFolder) {
            // Check if workspace is the MQLX folder itself
            if (path.basename(workspaceFolder).toUpperCase() === targetDirName) {
                return workspaceFolder;
            }
            // Check if workspace contains MQLX folder
            const subDir = path.join(workspaceFolder, targetDirName);
            if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
                return subDir;
            }
            // Check if workspace *looks like* an MQL folder (has Include/Logs)
            if (fs.existsSync(path.join(workspaceFolder, 'Logs')) && fs.existsSync(path.join(workspaceFolder, 'Include'))) {
                return workspaceFolder;
            }
        }

        return null;
    }

    /**
     * Formats current date as YYYYMMDD.log
     */
    getLogFileName() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}${m}${day}.log`;
    }

    /**
     * Update the status bar UI.
     */
    updateStatusBar() {
        if (!this.statusBarItem) return;
        if (this.isTailing) {
            this.statusBarItem.text = `$(sync~spin) MQL Log: ${this.mqlVersion.toUpperCase()}`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.tooltip = 'Click to stop live log tailing';
        } else {
            this.statusBarItem.text = `$(primitive-square) MQL Log: Off`;
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to start live MQL log tailing';
        }
        this.statusBarItem.show();
    }

    /**
     * Polling loop for file changes.
     */
    poll() {
        if (!this.isTailing) return;

        try {
            // Check for file rotation at midnight
            const expectedFile = this.getLogFileName();
            if (path.basename(this.currentFilePath) !== expectedFile) {
                const newPath = path.join(path.dirname(this.currentFilePath), expectedFile);
                this.outputChannel.appendLine(`[Info] Day changed. Switching to ${expectedFile}`);
                this.currentFilePath = newPath;
                this.lastSize = 0;
            }

            if (fs.existsSync(this.currentFilePath)) {
                const stats = fs.statSync(this.currentFilePath);

                if (stats.size > this.lastSize) {
                    this.readNewLines(stats.size);
                } else if (stats.size < this.lastSize) {
                    // File was truncated or cleared
                    this.lastSize = 0;
                    this.outputChannel.appendLine(`[Info] Log file truncated. Refreshing...`);
                }
            }
        } catch (err) {
            console.error('MQL Tailer error:', err);
        }

        this.timer = setTimeout(() => this.poll(), 1000);
    }

    /**
     * Reads new content from the log file.
     * MQL logs are encoded in UTF-16LE.
     */
    readNewLines(newSize) {
        const fd = fs.openSync(this.currentFilePath, 'r');
        const length = newSize - this.lastSize;
        const buffer = Buffer.alloc(length);

        fs.readSync(fd, buffer, 0, length, this.lastSize);
        fs.closeSync(fd);

        // MetaTrader logs are UTF-16LE (UCS2)
        const content = buffer.toString('utf16le');

        // Trim BOM if present in the middle of a stream (unlikely but safe)
        const cleanContent = content.replace(/\uFEFF/g, '');

        if (cleanContent) {
            this.outputChannel.append(cleanContent);
        }

        this.lastSize = newSize;
    }
}

module.exports = new MqlLogTailer();
