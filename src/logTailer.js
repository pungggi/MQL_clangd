'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// LiveLog configuration
const LIVELOG_FILENAME = 'LiveLog.txt';
const LIVELOG_MQH_FILENAME = 'LiveLog.mqh';

class MqlLogTailer {
    constructor() {
        this.outputChannel = null;
        this.currentFilePath = null;
        this.lastSize = 0;
        this.timer = null;
        this.watcher = null; // Native file watcher for instant updates
        this.isTailing = false;
        this.mqlVersion = null; // 'mql4' or 'mql5'
        this.statusBarItem = null;
        this.mode = 'livelog'; // 'standard' or 'livelog' - default to livelog for real-time updates
        this.basePath = null; // Base MQL folder path
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
     * @param {string} [mode] - 'livelog' or 'standard'. Defaults to this.mode
     */
    async start(mode = null) {
        if (mode) {
            this.mode = mode;
        }

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

        // Find the base MQL folder
        let basePath = rawIncDir;
        if (path.basename(basePath).toLowerCase() === 'include') {
            basePath = path.dirname(basePath);
        }
        this.basePath = basePath;

        // Determine log file path based on mode
        let logFilePath;
        let logDescription;

        if (this.mode === 'livelog') {
            // LiveLog mode: tail Files/LiveLog.txt (written by LiveLog.mqh with FileFlush)
            const filesDir = path.join(basePath, 'Files');
            logFilePath = path.join(filesDir, LIVELOG_FILENAME);
            logDescription = 'LiveLog (real-time)';

            // Check if LiveLog.mqh is installed, offer to install if not
            const includeDir = path.join(basePath, 'Include');
            const liveLogMqhPath = path.join(includeDir, LIVELOG_MQH_FILENAME);

            if (!fs.existsSync(liveLogMqhPath)) {
                const answer = await vscode.window.showInformationMessage(
                    'LiveLog library not found. Install it to enable real-time logging?',
                    'Install LiveLog.mqh',
                    'Use Standard Logs'
                );

                if (answer === 'Install LiveLog.mqh') {
                    const installed = await this.deployLiveLogLibrary();
                    if (!installed) {
                        return; // Deployment failed, error already shown
                    }
                    vscode.window.showInformationMessage(
                        'LiveLog.mqh installed! Add `#include <LiveLog.mqh>` to your EA and use PrintLive() for real-time output.',
                        'OK'
                    );
                } else if (answer === 'Use Standard Logs') {
                    // Fall back to standard mode
                    this.mode = 'standard';
                } else {
                    return; // User cancelled
                }
            }

            // If still in livelog mode after potential fallback
            if (this.mode === 'livelog') {
                // Ensure Files directory exists
                if (!fs.existsSync(filesDir)) {
                    try {
                        fs.mkdirSync(filesDir, { recursive: true });
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to create Files folder: ${err.message}`);
                        return;
                    }
                }
            }
        }

        if (this.mode === 'standard') {
            // Standard mode: tail Logs/YYYYMMDD.log
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
            const fileName = this.getLogFileName();
            logFilePath = path.join(logsDir, fileName);
            logDescription = 'Standard Journal';
        }

        this.currentFilePath = logFilePath;

        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(`MQL ${version.toUpperCase()} Runtime Log`, 'mql-output');
        }

        this.outputChannel.show(true);
        this.outputChannel.appendLine(`--- Starting ${logDescription} Tail ---`);
        this.outputChannel.appendLine(`[Info] Mode: ${this.mode.toUpperCase()}`);
        this.outputChannel.appendLine(`[Info] Tailing: ${this.currentFilePath}`);

        if (this.mode === 'livelog') {
            this.outputChannel.appendLine('[Info] For real-time logs, use PrintLive() instead of Print() in your EA');
            this.outputChannel.appendLine('[Info] Add: #include <LiveLog.mqh>');
        }

        // Set initial size and start tailing before any file operations
        this.lastSize = 0;
        this.isTailing = true;

        // In livelog mode, set up watcher first, then clear the file
        // This prevents missing writes that occur between clear and watcher setup
        if (this.mode === 'livelog' && fs.existsSync(this.currentFilePath)) {
            this.setupWatcher(); // Set up watcher BEFORE truncating
            try {
                fs.writeFileSync(this.currentFilePath, '');
                this.lastSize = 0; // Reset after truncation so watcher treats it as cleared
                this.outputChannel.appendLine('[Info] Cleared previous log content');
            } catch (err) {
                this.outputChannel.appendLine(`[Warning] Could not clear log file: ${err.message}`);
            }
        }

        if (!fs.existsSync(this.currentFilePath)) {
            const fileName = path.basename(this.currentFilePath);
            this.outputChannel.appendLine(`[Warning] Log file ${fileName} does not exist yet. Waiting for activity...`);
        }

        this.setupWatcher(); // Set up native file watcher for instant updates
        this.poll(); // Start backup polling for edge cases
    }

    /**
     * Deploys the LiveLog.mqh library to the user's Include folder.
     * @returns {Promise<boolean>} True if deployment succeeded
     */
    async deployLiveLogLibrary() {
        if (!this.basePath) {
            vscode.window.showErrorMessage('Cannot deploy LiveLog: MQL folder path not determined');
            return false;
        }

        const includeDir = path.join(this.basePath, 'Include');
        const targetPath = path.join(includeDir, LIVELOG_MQH_FILENAME);

        // Find source file in extension resources
        const extensionPath = vscode.extensions.getExtension('ngsoftware.mql-clangd')?.extensionPath;
        if (!extensionPath) {
            vscode.window.showErrorMessage('Cannot find MQL Tools extension path');
            return false;
        }

        const sourcePath = path.join(extensionPath, 'files', LIVELOG_MQH_FILENAME);
        if (!fs.existsSync(sourcePath)) {
            vscode.window.showErrorMessage(`LiveLog.mqh template not found at: ${sourcePath}`);
            return false;
        }

        try {
            // Ensure Include directory exists
            if (!fs.existsSync(includeDir)) {
                fs.mkdirSync(includeDir, { recursive: true });
            }

            // Copy file
            fs.copyFileSync(sourcePath, targetPath);
            this.outputChannel?.appendLine(`[Info] Installed LiveLog.mqh to: ${targetPath}`);
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to install LiveLog.mqh: ${err.message}`);
            return false;
        }
    }

    /**
     * Stops tailing.
     */
    stop() {
        this.isTailing = false;
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.outputChannel) {
            this.outputChannel.appendLine('--- Tail Stopped ---');
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
            const modeLabel = this.mode === 'livelog' ? 'LIVE' : 'STD';
            this.statusBarItem.text = `$(sync~spin) MQL Log: ${this.mqlVersion?.toUpperCase() || 'MQL'} (${modeLabel})`;
            this.statusBarItem.backgroundColor = this.mode === 'livelog'
                ? new vscode.ThemeColor('statusBarItem.prominentBackground')
                : new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.tooltip = `Click to stop log tailing (${this.mode === 'livelog' ? 'Real-time mode' : 'Standard journal'})`;
        } else {
            this.statusBarItem.text = '$(primitive-square) MQL Log: Off';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to start live MQL log tailing';
        }
        this.statusBarItem.show();
    }

    /**
     * Sets up a native file watcher for instant change detection.
     */
    setupWatcher() {
        // Close existing watcher if any
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        if (!fs.existsSync(this.currentFilePath)) {
            return; // File doesn't exist yet, poll will handle it
        }

        try {
            this.watcher = fs.watch(this.currentFilePath, (eventType) => {
                if (!this.isTailing) return;
                if (eventType === 'change') {
                    this.checkForNewContent();
                }
            });

            this.watcher.on('error', (err) => {
                console.error('MQL Tailer watcher error:', err);
                // Watcher died, poll will recreate it
                this.watcher = null;
            });
        } catch (err) {
            console.error('Failed to create file watcher:', err);
        }
    }

    /**
     * Checks for new content in the log file.
     */
    checkForNewContent() {
        if (!this.isTailing) return;

        try {
            if (fs.existsSync(this.currentFilePath)) {
                const stats = fs.statSync(this.currentFilePath);

                if (stats.size > this.lastSize) {
                    this.readNewLines(stats.size);
                } else if (stats.size < this.lastSize) {
                    // File was truncated or cleared
                    this.lastSize = 0;
                    this.outputChannel.appendLine('[Info] Log file truncated. Refreshing...');
                }
            }
        } catch (err) {
            console.error('MQL Tailer content check error:', err);
        }
    }

    /**
     * Backup polling loop for edge cases (file rotation, watcher not set up).
     * Runs less frequently since watcher handles most updates.
     */
    poll() {
        if (!this.isTailing) return;

        try {
            // Check for file rotation at midnight (only for standard mode with date-based logs)
            if (this.mode === 'standard') {
                const expectedFile = this.getLogFileName();
                if (path.basename(this.currentFilePath) !== expectedFile) {
                    const newPath = path.join(path.dirname(this.currentFilePath), expectedFile);
                    this.outputChannel.appendLine(`[Info] Day changed. Switching to ${expectedFile}`);
                    this.currentFilePath = newPath;
                    this.lastSize = 0;
                    this.setupWatcher(); // Set up watcher for new file
                }
            }

            // Ensure watcher is running (recreate if file now exists or watcher died)
            if (!this.watcher && fs.existsSync(this.currentFilePath)) {
                this.setupWatcher();
            }

            // Also check for content in case watcher missed something
            this.checkForNewContent();
        } catch (err) {
            console.error('MQL Tailer poll error:', err);
        }

        // Slower poll interval since watcher handles real-time updates
        this.timer = setTimeout(() => this.poll(), 5000);
    }

    /**
     * Reads new content from the log file.
     * LiveLog files are ANSI (utf8), standard MQL logs are UTF-16LE.
     */
    readNewLines(newSize) {
        const fd = fs.openSync(this.currentFilePath, 'r');
        const length = newSize - this.lastSize;
        const buffer = Buffer.alloc(length);

        fs.readSync(fd, buffer, 0, length, this.lastSize);
        fs.closeSync(fd);

        // LiveLog uses ANSI/UTF-8, standard MetaTrader logs use UTF-16LE
        let content;
        if (this.mode === 'livelog') {
            content = buffer.toString('utf8');
        } else {
            content = buffer.toString('utf16le');
        }

        // Trim BOM if present in the middle of a stream (unlikely but safe)
        const cleanContent = content.replace(/\uFEFF/g, '');

        if (cleanContent) {
            this.outputChannel.append(cleanContent);
        }

        this.lastSize = newSize;
    }
}

module.exports = new MqlLogTailer();
