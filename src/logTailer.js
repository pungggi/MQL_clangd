'use strict';
const vscode = require('vscode');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { isWineEnabled, getWinePrefix } = require('./wineHelper');

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
        this.mode = 'livelog'; // 'standard', 'livelog' or 'common' - default to livelog for real-time updates
        this.basePath = null; // Base MQL folder path
        this.isChecking = false; // Guard against concurrent checkForNewContent() calls

        // --- Level filtering (by LOG_INFO / LOG_DEBUG / ...) ---
        // `levelFilter === null`  → all lines visible (default).
        // Otherwise a Set of uppercase level names (INFO/DEBUG/WARN/ERROR/TRADE)
        // that are shown; everything else is suppressed in the output channel.
        this.levelFilter = null;
        this.lineBuffer = [];          // every received line, in order (capped)
        this.pendingPartial = '';      // incomplete trailing chunk awaiting a '\n'
        this.MAX_BUFFER = 20000;
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
     * @param {string} [mode] - 'livelog', 'standard' or 'common'. Defaults to this.mode
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

        // Resolve the MQL data folder. Required for livelog/standard modes;
        // in common mode (which tails the data-folder-independent common
        // folder) it is optional and only used for the library install check.
        let basePath = null;
        const logFolderName = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
        let rawIncDir = config.get(`Metaeditor.${logFolderName}`);

        if (!rawIncDir) {
            // Attempt to infer path from active file or workspace
            rawIncDir = this.inferDataFolder(version);
        }

        if (rawIncDir) {
            // Resolve workspace variables
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (rawIncDir.includes('${workspaceFolder}')) {
                rawIncDir = rawIncDir.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
            }

            // Find the base MQL folder
            basePath = rawIncDir;
            if (path.basename(basePath).toLowerCase() === 'include') {
                basePath = path.dirname(basePath);
            }
        } else if (this.mode !== 'common') {
            vscode.window.showErrorMessage(`Include path for ${version.toUpperCase()} is not set and could not be inferred. Please configure MQL Tools settings.`, 'Configure')
                .then(selection => {
                    if (selection === 'Configure') {
                        vscode.commands.executeCommand('workbench.action.openSettings', `mql_tools.Metaeditor.Include${version === 'mql4' ? '4' : '5'}Dir`);
                    }
                });
            return;
        }

        // Keep the instance path in sync even when unresolved (common mode),
        // so deployLiveLogLibrary() never acts on a stale folder from a
        // previous run
        this.basePath = basePath;

        // Both LiveLog-based modes need LiveLog.mqh in the EA; offer to
        // install it if missing (skipped when the data folder is unknown)
        if ((this.mode === 'livelog' || this.mode === 'common') && basePath) {
            const liveLogMqhPath = path.join(basePath, 'Include', LIVELOG_MQH_FILENAME);

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
                    const defineHint = this.mode === 'common' ? '`#define LIVELOG_COMMON` and ' : '';
                    vscode.window.showInformationMessage(
                        `LiveLog.mqh installed! Add ${defineHint}\`#include <LiveLog.mqh>\` to your EA and use PrintLive() for real-time output.`,
                        'OK'
                    );
                } else if (answer === 'Use Standard Logs') {
                    // Fall back to standard mode
                    this.mode = 'standard';
                } else {
                    return; // User cancelled
                }
            } else {
                // Already installed: the EA compiles against this copy, not the
                // bundled source, so an extension update never refreshes it.
                // Offer a re-deploy when the bundle is newer. Non-fatal.
                await this.maybeOfferLiveLogUpdate(liveLogMqhPath);
            }
        }

        // Determine log file path based on mode
        let logFilePath;
        let logDescription;

        if (this.mode === 'common') {
            // Common mode: tail the shared common data folder, visible to the
            // terminal AND all strategy-tester agents (requires
            // #define LIVELOG_COMMON before #include <LiveLog.mqh> in the EA)
            const commonDir = this.getCommonFilesDir();
            if (!commonDir) {
                const hint = process.platform === 'win32'
                    ? '%APPDATA% is not set'
                    : 'enable mql_tools.Wine and run MetaTrader at least once in the Wine prefix';
                vscode.window.showErrorMessage(`Cannot resolve the MetaTrader common data folder (${hint}).`);
                return;
            }
            logFilePath = path.join(commonDir, LIVELOG_FILENAME);
            logDescription = 'LiveLog (Common/Tester)';

            if (!fs.existsSync(commonDir)) {
                try {
                    fs.mkdirSync(commonDir, { recursive: true });
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to create common Files folder: ${err.message}`);
                    return;
                }
            }
        }

        if (this.mode === 'livelog') {
            // LiveLog mode: tail Files/LiveLog.txt (written by LiveLog.mqh with FileFlush)
            const filesDir = path.join(basePath, 'Files');
            logFilePath = path.join(filesDir, LIVELOG_FILENAME);
            logDescription = 'LiveLog (real-time)';

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

        if (this.mode === 'common') {
            this.outputChannel.appendLine('[Info] Common mode: live charts AND strategy-tester runs share this file');
            this.outputChannel.appendLine('[Info] In your EA, add before the include: #define LIVELOG_COMMON');
            this.outputChannel.appendLine('[Info] Then: #include <LiveLog.mqh> and use PrintLive()');
        }

        // Set initial size and start tailing before any file operations
        this.lastSize = 0;
        this.lineBuffer = [];
        this.pendingPartial = '';
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

        // Common mode: never truncate - charts/tester agents may hold open
        // handles positioned at the old EOF, and truncating under them
        // corrupts subsequent writes. Tail from the current end instead.
        if (this.mode === 'common' && fs.existsSync(this.currentFilePath)) {
            try {
                this.lastSize = fs.statSync(this.currentFilePath).size;
                this.outputChannel.appendLine('[Info] Tailing from current end of file (common log is not truncated)');
            } catch (err) {
                this.outputChannel.appendLine(`[Warning] Could not stat log file: ${err.message}`);
            }
        }

        if (!fs.existsSync(this.currentFilePath)) {
            const fileName = path.basename(this.currentFilePath);
            this.outputChannel.appendLine(`[Warning] Log file ${fileName} does not exist yet. Waiting for activity...`);
        }

        // Only set up watcher if not already done (prevents race with livelog mode watcher)
        if (!this.watcher) {
            this.setupWatcher();
        }
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
        const sourcePath = this.getBundledLiveLogSource();
        if (!sourcePath) {
            vscode.window.showErrorMessage('Cannot find MQL Tools extension path');
            return false;
        }
        if (!fs.existsSync(sourcePath)) {
            vscode.window.showErrorMessage(`LiveLog.mqh template not found at: ${sourcePath}`);
            return false;
        }

        try {
            // Ensure Include directory exists
            await fsPromises.mkdir(includeDir, { recursive: true });

            // Copy file
            await fsPromises.copyFile(sourcePath, targetPath);
            this.outputChannel?.appendLine(`[Info] Installed LiveLog.mqh to: ${targetPath}`);
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to install LiveLog.mqh: ${err.message}`);
            return false;
        }
    }

    /**
     * Resolves the LiveLog.mqh bundled inside the extension (the update source).
     * @returns {string|null} absolute path, or null if the extension isn't found
     */
    getBundledLiveLogSource() {
        const extensionPath = vscode.extensions.getExtension('ngsoftware.mql-clangd')?.extensionPath;
        if (!extensionPath) {
            return null;
        }
        return path.join(extensionPath, 'files', LIVELOG_MQH_FILENAME);
    }

    /**
     * Reads the `#property version "X.YY"` string from an .mqh file.
     * @param {string} filePath
     * @returns {string|null} the version string, or null if unreadable/absent
     */
    readMqhVersion(filePath) {
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            const m = text.match(/#property\s+version\s+"([^"]+)"/i);
            return m ? m[1].trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Compares dotted version strings segment-by-segment ("1.30" vs "1.4").
     * @returns {number} >0 if a is newer than b, <0 if older, 0 if equal
     */
    compareVersions(a, b) {
        const pa = String(a).split('.');
        const pb = String(b).split('.');
        const len = Math.max(pa.length, pb.length);
        for (let i = 0; i < len; i++) {
            const diff = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    /**
     * When LiveLog.mqh already exists in the user's Include folder, compares it
     * against the version bundled with the extension and offers a re-deploy when
     * the bundle is newer. The installed copy is what the EA compiles against, so
     * updating the extension alone never refreshes it (see deployLiveLogLibrary).
     * Non-fatal: declining or unparseable versions leave the working copy in place.
     * @param {string} installedPath - path to the LiveLog.mqh in the Include folder
     */
    async maybeOfferLiveLogUpdate(installedPath) {
        const sourcePath = this.getBundledLiveLogSource();
        if (!sourcePath || !fs.existsSync(sourcePath)) return;

        const installedVer = this.readMqhVersion(installedPath);
        const bundledVer = this.readMqhVersion(sourcePath);
        // Can't read either side -> stay silent rather than nag on every start
        if (!installedVer || !bundledVer) return;
        if (this.compareVersions(bundledVer, installedVer) <= 0) return;

        const answer = await vscode.window.showInformationMessage(
            `A newer LiveLog.mqh is available (installed ${installedVer} → ${bundledVer}). Update it now?`,
            'Update LiveLog.mqh',
            'Keep Current'
        );

        if (answer === 'Update LiveLog.mqh') {
            const updated = await this.deployLiveLogLibrary();
            if (updated) {
                vscode.window.showInformationMessage(
                    `LiveLog.mqh updated to ${bundledVer}. Recompile your EA (F7) so the change takes effect.`,
                    'OK'
                );
            }
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

    /** Dispose all VS Code resources. Call from extension deactivate(). */
    dispose() {
        this.stop();
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
            this.statusBarItem = null;
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
     * Resolves the MetaTrader common data folder
     * (%APPDATA%\MetaQuotes\Terminal\Common\Files). Shared by the terminal
     * and all strategy-tester agents; not affected by /portable mode
     * (portable changes the data folder, not the common folder).
     * On non-Windows platforms with Wine mode enabled, resolves inside the
     * Wine prefix (drive_c/users/<user>/AppData/Roaming/...).
     * @returns {string|null} Path, or null if it cannot be resolved
     */
    getCommonFilesDir() {
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA;
            if (!appData) return null;
            return path.join(appData, 'MetaQuotes', 'Terminal', 'Common', 'Files');
        }

        const config = vscode.workspace.getConfiguration('mql_tools');
        if (!isWineEnabled(config)) return null;

        const usersDir = path.join(getWinePrefix(config), 'drive_c', 'users');

        // Wine names the Windows user after the Unix user; try that first,
        // then scan for any user dir where MetaTrader has run
        const userDirs = [];
        try { userDirs.push(os.userInfo().username); } catch { /* ignore */ }
        try {
            for (const u of fs.readdirSync(usersDir)) {
                if (!userDirs.includes(u)) userDirs.push(u);
            }
        } catch {
            return null;
        }

        for (const u of userDirs) {
            const terminalDir = path.join(usersDir, u, 'AppData', 'Roaming', 'MetaQuotes', 'Terminal');
            if (fs.existsSync(terminalDir)) {
                return path.join(terminalDir, 'Common', 'Files');
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
            const modeLabel = this.mode === 'livelog' ? 'LIVE' : this.mode === 'common' ? 'COMMON' : 'STD';
            const modeName = this.mode === 'livelog' ? 'Real-time mode'
                : this.mode === 'common' ? 'Common/Tester mode'
                    : 'Standard journal';
            this.statusBarItem.text = `$(sync~spin) MQL Log: ${this.mqlVersion?.toUpperCase() || 'MQL'} (${modeLabel})`;
            this.statusBarItem.backgroundColor = this.mode === 'standard'
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : new vscode.ThemeColor('statusBarItem.prominentBackground');
            this.statusBarItem.tooltip = `Click to stop log tailing (${modeName})`;
            this.statusBarItem.accessibilityInformation = {
                label: `MQL Log tailing active, ${modeName}, click to stop`,
                role: 'button'
            };
        } else {
            this.statusBarItem.text = '$(primitive-square) MQL Log: Off';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to start live MQL log tailing';
            this.statusBarItem.accessibilityInformation = {
                label: 'MQL Log tailing off, click to start',
                role: 'button'
            };
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
    async checkForNewContent() {
        if (!this.isTailing) return;
        if (this.isChecking) return;

        this.isChecking = true;
        try {
            const stats = await fsPromises.stat(this.currentFilePath);

            if (stats.size > this.lastSize) {
                this.readNewLines(stats.size);
            } else if (stats.size < this.lastSize) {
                // File was truncated or cleared
                this.lastSize = 0;
                this.outputChannel.appendLine('[Info] Log file truncated. Refreshing...');
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('MQL Tailer content check error:', err);
            }
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Backup polling loop for edge cases (file rotation, watcher not set up).
     * Runs less frequently since watcher handles most updates.
     */
    async poll() {
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
            if (!this.watcher) {
                try {
                    await fsPromises.access(this.currentFilePath);
                    this.setupWatcher();
                } catch {
                    // File doesn't exist yet, skip
                }
            }

            // Also check for content in case watcher missed something
            await this.checkForNewContent();
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
        let fd;
        try {
            fd = fs.openSync(this.currentFilePath, 'r');
            const length = newSize - this.lastSize;
            const buffer = Buffer.alloc(length);

            fs.readSync(fd, buffer, 0, length, this.lastSize);

            // LiveLog (data folder and common) uses ANSI/UTF-8,
            // standard MetaTrader logs use UTF-16LE
            let content;
            if (this.mode === 'standard') {
                content = buffer.toString('utf16le');
            } else {
                content = buffer.toString('utf8');
            }

            // Trim BOM if present in the middle of a stream (unlikely but safe)
            const cleanContent = content.replace(/\uFEFF/g, '');

            if (cleanContent) {
                this._ingestLines(cleanContent);
            }

            this.lastSize = newSize;
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('MQL Tailer read error:', err);
            }
        } finally {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch { /* ignore close errors */ }
            }
        }
    }

    /**
     * Buffer incoming raw text (handling partial trailing lines), keep a capped
     * history, and append only lines passing the active level filter to the
     * output channel. Lines without a recognizable level always pass.
     */
    _ingestLines(rawChunk) {
        if (!this.outputChannel) return;

        // Reassemble with any partial line carried over from the last read.
        const combined = this.pendingPartial + rawChunk;
        const parts = combined.split('\n');
        this.pendingPartial = parts.pop(); // last element is the partial tail (may be '')

        const visible = [];
        for (const line of parts) {
            this.lineBuffer.push(line);
            if (this._linePassesFilter(line)) visible.push(line);
        }
        // Cap the history so a long session cannot grow without bound.
        if (this.lineBuffer.length > this.MAX_BUFFER) {
            this.lineBuffer.splice(0, this.lineBuffer.length - this.MAX_BUFFER);
        }

        if (visible.length) {
            this.outputChannel.append(visible.join('\n') + '\n');
        }
    }

    /**
     * Extract the log level from a line and test it against the active filter.
     * Recognizes the LiveLog `[LEVEL]` prefix and the MT5 Tester
     * `LEVEL {…}` form. Lines with no level always pass.
     */
    _lineLevel(line) {
        // [LEVEL] {File:Func:Line}: ...   (LiveLog)
        let m = line.match(/\[(INFO|DEBUG|TRADE|ERROR|WARN)\]/i);
        if (m) return m[1].toUpperCase();
        // ... [EAName] LEVEL {...} ...    (MT5 Tester)
        m = line.match(/\]\s+(INFO|DEBUG|TRADE|ERROR|WARN)\b/i);
        if (m) return m[1].toUpperCase();
        return null;
    }

    _linePassesFilter(line) {
        if (!this.levelFilter || this.levelFilter.size === 0) return true;
        const lvl = this._lineLevel(line);
        if (!lvl) return true; // non-log informational lines always show
        return this.levelFilter.has(lvl);
    }

    /**
     * Set the visible level set and re-render the buffered history filtered.
     * Pass `null` (or an empty array) to clear the filter.
     * @param {string[]|null} levels
     */
    setLevelFilter(levels) {
        this.levelFilter = (!levels || levels.length === 0)
            ? null
            : new Set(levels.map(l => String(l).toUpperCase()));
        if (!this.outputChannel) return;
        this.outputChannel.clear();
        const visible = this.lineBuffer.filter(l => this._linePassesFilter(l));
        if (visible.length) this.outputChannel.append(visible.join('\n') + '\n');
    }

    /** @returns {string[]} The current filter levels, or [] when unfiltered. */
    getLevelFilter() {
        return this.levelFilter ? [...this.levelFilter] : [];
    }
}

module.exports = new MqlLogTailer();
