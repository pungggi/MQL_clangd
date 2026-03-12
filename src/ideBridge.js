'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const IDEBRIDGE_DIR = 'IDEBridge';
const IDEBRIDGE_MQH = 'IDEBridge.mqh';

// Channel file names matching IDEBridge.mqh definitions
const CHANNELS = {
    trades:  'trades.jsonl',
    equity:  'equity.jsonl',
    metrics: 'metrics.jsonl',
    log:     'log.jsonl'
};

class IDEBridge {
    constructor() {
        this.basePath = null;       // MQL data folder (parent of Files/)
        this.bridgeDir = null;      // Full path to Files/IDEBridge/
        this.watchers = new Map();  // channel name → fs.FSWatcher
        this.offsets = new Map();   // channel name → last read position
        this.isRunning = false;
        this.pollTimer = null;
        this.mqlVersion = null;

        // VS Code surfaces
        this.outputChannel = null;  // For log channel
        this.statusBarItem = null;

        // Listeners: channel → callback[]
        this._listeners = new Map();

        // Trade data accumulator (for webview)
        this.trades = [];
        this.equity = [];
        this.metrics = new Map();   // key → { value, ts }
    }

    // ---- Event system -------------------------------------------------------

    /**
     * Register a listener for a channel.
     * @param {'trades'|'equity'|'metrics'|'log'} channel
     * @param {function(object):void} callback
     */
    on(channel, callback) {
        if (!this._listeners.has(channel)) {
            this._listeners.set(channel, []);
        }
        this._listeners.get(channel).push(callback);
    }

    _emit(channel, data) {
        const listeners = this._listeners.get(channel);
        if (listeners) {
            for (const cb of listeners) {
                try { cb(data); } catch (e) { console.error('IDEBridge listener error:', e); }
            }
        }
    }

    // ---- Lifecycle ----------------------------------------------------------

    initStatusBar() {
        if (!this.statusBarItem) {
            this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
            this.statusBarItem.command = 'mql_tools.toggleIDEBridge';
            this.updateStatusBar();
        }
    }

    updateStatusBar() {
        if (!this.statusBarItem) return;
        if (this.isRunning) {
            const tradeCount = this.trades.length;
            this.statusBarItem.text = `$(graph) IDE Bridge: ${tradeCount} trades`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            this.statusBarItem.tooltip = 'IDE Bridge active \u2014 click to stop';
        } else {
            this.statusBarItem.text = '$(graph) IDE Bridge: Off';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = 'Click to start IDE Bridge (trade report watcher)';
        }
        this.statusBarItem.show();
    }

    async toggle() {
        if (this.isRunning) {
            this.stop();
        } else {
            await this.start();
        }
        this.updateStatusBar();
    }

    /**
     * Resolve the base MQL data path using the same logic as logTailer.
     */
    resolveBasePath() {
        const config = vscode.workspace.getConfiguration('mql_tools');
        let version = this.detectMqlVersion();
        if (!version) version = 'mql5';
        this.mqlVersion = version;

        const settingKey = version === 'mql4' ? 'Include4Dir' : 'Include5Dir';
        let rawIncDir = config.get(`Metaeditor.${settingKey}`);

        if (!rawIncDir) {
            rawIncDir = this.inferDataFolder(version);
        }

        if (!rawIncDir) return null;

        // Resolve workspace variables
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (rawIncDir.includes('${workspaceFolder}')) {
            rawIncDir = rawIncDir.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
        }

        let basePath = rawIncDir;
        if (path.basename(basePath).toLowerCase() === 'include') {
            basePath = path.dirname(basePath);
        }
        return basePath;
    }

    detectMqlVersion() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const fn = editor.document.fileName.toLowerCase();
            if (fn.endsWith('.mq4')) return 'mql4';
            if (fn.endsWith('.mq5')) return 'mql5';
            if (fn.includes('mql4')) return 'mql4';
            if (fn.includes('mql5')) return 'mql5';
        }
        const folders = vscode.workspace.workspaceFolders;
        if (folders) {
            for (const f of folders) {
                const fp = f.uri.fsPath.toLowerCase();
                if (fp.includes('mql4')) return 'mql4';
                if (fp.includes('mql5')) return 'mql5';
            }
        }
        const config = vscode.workspace.getConfiguration('mql_tools');
        if (config.get('Metaeditor.Include5Dir') && !config.get('Metaeditor.Include4Dir')) return 'mql5';
        if (config.get('Metaeditor.Include4Dir') && !config.get('Metaeditor.Include5Dir')) return 'mql4';
        return null;
    }

    inferDataFolder(version) {
        const editor = vscode.window.activeTextEditor;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const targetDirName = version.toUpperCase();

        if (editor) {
            let current = path.dirname(editor.document.fileName);
            const root = path.parse(current).root;
            while (current !== root) {
                if (path.basename(current).toUpperCase() === targetDirName) {
                    if (fs.existsSync(path.join(current, 'Include')) || fs.existsSync(path.join(current, 'Logs'))) {
                        return current;
                    }
                }
                current = path.dirname(current);
            }
        }
        if (workspaceFolder) {
            if (path.basename(workspaceFolder).toUpperCase() === targetDirName) return workspaceFolder;
            const sub = path.join(workspaceFolder, targetDirName);
            if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) return sub;
            if (fs.existsSync(path.join(workspaceFolder, 'Include'))) return workspaceFolder;
        }
        return null;
    }

    // ---- Start / Stop -------------------------------------------------------

    async start() {
        this.basePath = this.resolveBasePath();
        if (!this.basePath) {
            vscode.window.showErrorMessage(
                'IDEBridge: Cannot determine MQL folder. Configure your Include directory setting.',
                'Configure'
            ).then(sel => {
                if (sel === 'Configure') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'mql_tools.Metaeditor');
                }
            });
            return;
        }

        this.bridgeDir = path.join(this.basePath, 'Files', IDEBRIDGE_DIR);

        // Ensure directory exists
        if (!fs.existsSync(this.bridgeDir)) {
            try {
                fs.mkdirSync(this.bridgeDir, { recursive: true });
            } catch (err) {
                vscode.window.showErrorMessage(`IDEBridge: Cannot create directory: ${err.message}`);
                return;
            }
        }

        // Check if IDEBridge.mqh is deployed
        const mqhTarget = path.join(this.basePath, 'Include', IDEBRIDGE_MQH);
        if (!fs.existsSync(mqhTarget)) {
            const answer = await vscode.window.showInformationMessage(
                'IDEBridge.mqh not found in Include folder. Install it?',
                'Install IDEBridge.mqh',
                'Cancel'
            );
            if (answer === 'Install IDEBridge.mqh') {
                if (!this.deployLibrary()) return;
                vscode.window.showInformationMessage(
                    'IDEBridge.mqh installed! Add `#include <IDEBridge.mqh>` to your EA.'
                );
            } else {
                return;
            }
        }

        // Clear accumulated data
        this.trades = [];
        this.equity = [];
        this.metrics = new Map();

        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel(
                `MQL ${(this.mqlVersion || 'MQL5').toUpperCase()} IDE Bridge`, 'mql-output'
            );
        }
        this.outputChannel.show(true);
        this.outputChannel.appendLine('--- IDE Bridge Started ---');
        this.outputChannel.appendLine(`[Info] Watching: ${this.bridgeDir}`);
        this.outputChannel.appendLine('[Info] Add #include <IDEBridge.mqh> to your EA');

        this.isRunning = true;

        // Initialize offsets and set up watchers for each channel
        for (const [channel, filename] of Object.entries(CHANNELS)) {
            const filePath = path.join(this.bridgeDir, filename);
            this.offsets.set(channel, 0);

            // Optionally clear previous data
            if (fs.existsSync(filePath)) {
                try {
                    fs.writeFileSync(filePath, '');
                } catch (e) {
                    // non-critical
                }
            }

            this.setupWatcher(channel, filePath);
        }

        // Backup poll
        this.poll();
    }

    stop() {
        this.isRunning = false;

        for (const [channel, watcher] of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.outputChannel) {
            this.outputChannel.appendLine('--- IDE Bridge Stopped ---');
        }
    }

    // ---- File watching ------------------------------------------------------

    setupWatcher(channel, filePath) {
        // Close existing watcher for this channel
        if (this.watchers.has(channel)) {
            this.watchers.get(channel).close();
            this.watchers.delete(channel);
        }

        if (!fs.existsSync(filePath)) return;

        try {
            const watcher = fs.watch(filePath, (eventType) => {
                if (!this.isRunning) return;
                if (eventType === 'change') {
                    this.readNewLines(channel, filePath);
                }
            });

            watcher.on('error', (err) => {
                console.error(`IDEBridge watcher error (${channel}):`, err);
                this.watchers.delete(channel);
            });

            this.watchers.set(channel, watcher);
        } catch (err) {
            console.error(`IDEBridge: Failed to watch ${channel}:`, err);
        }
    }

    poll() {
        if (!this.isRunning) return;

        for (const [channel, filename] of Object.entries(CHANNELS)) {
            const filePath = path.join(this.bridgeDir, filename);

            // Recreate watcher if needed
            if (!this.watchers.has(channel) && fs.existsSync(filePath)) {
                this.setupWatcher(channel, filePath);
            }

            this.readNewLines(channel, filePath);
        }

        this.pollTimer = setTimeout(() => this.poll(), 5000);
    }

    readNewLines(channel, filePath) {
        if (!this.isRunning) return;

        try {
            if (!fs.existsSync(filePath)) return;

            const stats = fs.statSync(filePath);
            const lastOffset = this.offsets.get(channel) || 0;

            if (stats.size <= lastOffset) {
                if (stats.size < lastOffset) {
                    // File was truncated
                    this.offsets.set(channel, 0);
                }
                return;
            }

            const length = stats.size - lastOffset;
            const buffer = Buffer.alloc(length);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, length, lastOffset);
            fs.closeSync(fd);

            this.offsets.set(channel, stats.size);

            const content = buffer.toString('utf8');
            const lines = content.split('\n').filter(l => l.trim());

            for (const line of lines) {
                this.processLine(channel, line);
            }
        } catch (err) {
            console.error(`IDEBridge read error (${channel}):`, err);
        }
    }

    // ---- Message processing -------------------------------------------------

    processLine(channel, line) {
        let data;
        try {
            data = JSON.parse(line);
        } catch (e) {
            // Not valid JSON, skip
            return;
        }

        switch (channel) {
            case 'trades':
                this.trades.push(data);
                this._emit('trades', data);
                this.updateStatusBar();
                if (this.outputChannel) {
                    const dir = data.type === 'buy' ? '\u25B2' : '\u25BC';
                    const pnl = data.profit >= 0 ? `+${data.profit.toFixed(2)}` : data.profit.toFixed(2);
                    this.outputChannel.appendLine(
                        `[Trade] #${data.ticket} ${dir} ${data.symbol} ${data.lots} lots | P&L: ${pnl}`
                    );
                }
                break;

            case 'equity':
                this.equity.push(data);
                this._emit('equity', data);
                break;

            case 'metrics':
                if (data.key) {
                    this.metrics.set(data.key, {
                        value: data.value ?? data.value_str,
                        ts: data.ts
                    });
                }
                this._emit('metrics', data);
                break;

            case 'log':
                this._emit('log', data);
                if (this.outputChannel) {
                    const level = data.level || 'INFO';
                    const prefix = level === 'ERROR' ? '\u274C' :
                                   level === 'WARN'  ? '\u26A0' :
                                   level === 'DEBUG' ? '\u25CB' : '\u25CF';
                    this.outputChannel.appendLine(`[${level}] ${prefix} ${data.msg || ''}`);
                }
                break;
        }
    }

    // ---- Library deployment -------------------------------------------------

    deployLibrary() {
        if (!this.basePath) {
            vscode.window.showErrorMessage('IDEBridge: MQL folder path not determined');
            return false;
        }

        const includeDir = path.join(this.basePath, 'Include');
        const targetPath = path.join(includeDir, IDEBRIDGE_MQH);

        const extensionPath = vscode.extensions.getExtension('ngsoftware.mql-clangd')?.extensionPath;
        if (!extensionPath) {
            vscode.window.showErrorMessage('IDEBridge: Cannot find extension path');
            return false;
        }

        const sourcePath = path.join(extensionPath, 'files', IDEBRIDGE_MQH);
        if (!fs.existsSync(sourcePath)) {
            vscode.window.showErrorMessage(`IDEBridge: Template not found at ${sourcePath}`);
            return false;
        }

        try {
            if (!fs.existsSync(includeDir)) {
                fs.mkdirSync(includeDir, { recursive: true });
            }
            fs.copyFileSync(sourcePath, targetPath);
            this.outputChannel?.appendLine(`[Info] Installed IDEBridge.mqh to: ${targetPath}`);
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`IDEBridge: Failed to install library: ${err.message}`);
            return false;
        }
    }

    // ---- Data access (for webview) ------------------------------------------

    getSummary() {
        if (this.trades.length === 0) {
            return { tradeCount: 0, netPnl: 0, winRate: 0, grossProfit: 0, grossLoss: 0, commission: 0 };
        }

        let grossProfit = 0, grossLoss = 0, wins = 0, totalCommission = 0;
        for (const t of this.trades) {
            if (t.profit >= 0) { grossProfit += t.profit; wins++; }
            else { grossLoss += t.profit; }
            totalCommission += (t.commission || 0) + (t.swap || 0);
        }

        return {
            tradeCount: this.trades.length,
            netPnl: grossProfit + grossLoss + totalCommission,
            winRate: (wins / this.trades.length) * 100,
            grossProfit,
            grossLoss,
            commission: totalCommission
        };
    }
}

module.exports = new IDEBridge();
