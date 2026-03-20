'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { instrumentWorkspace } = require('./debugInstrumentation');
const { MqlDebugLogReader } = require('./debugLogReader');
const { store } = require('./debugStateStore');

const MQLDEBUG_MQH = 'MqlDebug.mqh';

/**
 * Compile modes for compilePath()
 */
const COMPILE_MODE_CHECK = 0;
const COMPILE_MODE_COMPILE = 1;
const COMPILE_MODE_SCRIPT = 2;

/**
 * MqlDebugBridge — Phase 1 orchestrator.
 *
 * Responsibilities:
 *   1. Deploy MqlDebug.mqh to the Include/ folder (if absent).
 *   2. Collect VS Code breakpoints for the active source file.
 *   3. Call instrumentSource() to produce a temp .mql_dbg_build file.
 *   4. Invoke compilePath() via the provided compile function.
 *   5. Start MqlDebugLogReader and forward events to DebugStateStore.
 *   6. Invoke optional onStarted callback (e.g. open trading terminal).
 *   7. Clean up temp files and stop the reader on session end.
 */
class MqlDebugBridge {
    constructor() {
        /** @type {MqlDebugLogReader|null} */
        this._reader = null;
        /** @type {(() => void)|null} */
        this._restore = null;
        this._active = false;
        /** @type {string|null} */
        this._mql5Root = null;
    }

    get isActive() { return this._active; }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Start a debug session for the given source file.
     *
     * @param {string}   sourcePath    Absolute path to the .mq5/.mq4 file
     * @param {string}   mql5Root      MQL5 root folder (has Include/, Files/, Experts/)
     * @param {Function} compilePath   The compilePath(rt, path, context) function from extension.js
     * @param {object}   context       VS Code extension context
     * @param {Function} [onStarted]   Optional callback invoked after session starts (e.g. open terminal)
     */
    async start(sourcePath, mql5Root, compilePath, context, onStarted) {
        if (this._active) {
            vscode.window.showWarningMessage('MQL Debug session already running. Stop it first.');
            return;
        }

        this._mql5Root = mql5Root;

        // 0. Clean up stale command file from a previous session
        this._cleanCmdFile();

        // 1. Deploy MqlDebug.mqh
        const deployed = await this._deployLibrary(mql5Root, context);
        if (!deployed) return;

        // 2. Collect breakpoints across the workspace
        const breakpointMap = this._collectAllBreakpoints();
        if (breakpointMap.size === 0) {
            const answer = await vscode.window.showInformationMessage(
                'No breakpoints found anywhere in the workspace. Run anyway with only session-start logging?',
                'Yes', 'Cancel'
            );
            if (answer !== 'Yes') return;
        }

        // 3. Instrument workspace and resolve includes
        let tempPath, restore, skipped;
        try {
            const result = instrumentWorkspace(sourcePath, breakpointMap, mql5Root);
            if (!result) {
                vscode.window.showErrorMessage(`MQL Debug: Failed to instrument workspace.`);
                return;
            }
            ({ tempPath, restore, skipped } = result);
        } catch (err) {
            vscode.window.showErrorMessage(`MQL Debug: Failed to instrument source: ${err.message}`);
            return;
        }

        if (skipped.length > 0) {
            vscode.window.showWarningMessage(
                `MQL Debug: Could not inject at lines: ${skipped.join(', ')} (unsafe injection points — add a statement there or use // @watch).`
            );
        }

        // 4. Compile the instrumented temp file
        const success = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'MQL Debug: Compiling instrumented source…', cancellable: false },
            async () => {
                let compileError;
                try {
                    // compilePath returns:
                    // - false/null: Success
                    // - true: Generic compilation error (details in Output/Problems view)
                    // - string: Specific setup/environment error
                    compileError = await compilePath(COMPILE_MODE_COMPILE, tempPath, context);
                } catch (err) {
                    compileError = err.message || String(err);
                }

                if (compileError) {
                    restore();
                    // If compileError is true, it's a generic compilation failure; otherwise use the error string.
                    const errMsg = (compileError === true) ? 'Check the Output panel or Problems view for details.' : compileError;
                    vscode.window.showErrorMessage(`MQL Debug: Compilation failed — ${errMsg}`);
                    return false;
                }
                return true;
            }
        );

        if (!success) return;

        // Compilation succeeded — keep the temp file alive until session ends
        // (MetaTrader needs the .ex5 which is next to the temp file)

        // 5. Start debug session
        this._active = true;
        this._restore = restore;
        store.startSession();

        this._reader = new MqlDebugLogReader(mql5Root);
        this._reader.onBatch = (evts) => {
            this._log(`Reader batch: ${evts.length} events`);
            store.applyBatch(evts);
        };
        this._reader.onError = (err) => {
            vscode.window.showErrorMessage(`MQL Debug: Log reader error — ${err.message || String(err)}`);
            this.stop();
        };
        this._reader.onLog = (msg) => this._log(msg);
        this._reader.start();

        // 6. Invoke optional post-start callback (e.g. open trading terminal)
        if (typeof onStarted === 'function') onStarted();

        const isMql5 = sourcePath.toLowerCase().endsWith('.mq5');
        const exName = path.basename(tempPath).replace(/\.mq[45]$/i, isMql5 ? '.ex5' : '.ex4');

        vscode.window.showInformationMessage(
            `MQL Debug session started. Attach the temporary "${exName}" in MetaTrader to begin.`,
            'Stop Session'
        ).then(selection => {
            if (selection === 'Stop Session') this.stop();
        });
    }

    /** Stop the current debug session and clean up. */
    stop() {
        if (!this._active) return;
        this._active = false;

        // Unblock the EA if it's paused at a breakpoint
        this._sendContinueCommand();

        if (this._reader) {
            this._reader.stop();
            this._reader = null;
        }
        if (this._restore) {
            this._restore();
            this._restore = null;
        }

        // Clean up command file
        this._cleanCmdFile();

        store.endSession();
        vscode.window.showInformationMessage('MQL Debug session stopped.');
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /** Log to the MQL output channel (visible in Output panel). */
    _log(msg) {
        const ch = this._getOutputChannel();
        if (ch) ch.appendLine(`[MQL Debug] ${msg}`);
        console.log(`[MqlDebugBridge] ${msg}`);
    }

    _getOutputChannel() {
        if (!this._outputChannel) {
            try {
                this._outputChannel = vscode.window.createOutputChannel('MQL Debug');
            } catch { /* ignore */ }
        }
        return this._outputChannel;
    }

    /** Write CONTINUE to the command file so a paused EA resumes. */
    _sendContinueCommand() {
        if (!this._mql5Root) return;
        const cmdPath = path.join(this._mql5Root, 'Files', 'MqlDebugCmd.txt');
        try {
            fs.writeFileSync(cmdPath, 'CONTINUE\n', 'utf-8');
        } catch (err) {
            console.warn('[MqlDebugBridge] Failed to write continue command:', err.message);
        }
    }

    /** Delete the command file (cleanup). */
    _cleanCmdFile() {
        if (!this._mql5Root) return;
        const cmdPath = path.join(this._mql5Root, 'Files', 'MqlDebugCmd.txt');
        try {
            fs.unlinkSync(cmdPath);
        } catch {
            // File may not exist — that's fine
        }
    }

    /**
     * Deploy MqlDebug.mqh from extension bundle to MQL Include folder.
     * Always overwrites to ensure the latest version (with pause support etc.).
     * @param {string} mql5Root
     * @param {object} context  VS Code extension context
     * @returns {Promise<boolean>}
     */
    async _deployLibrary(mql5Root, context) {
        const includeDir = path.join(mql5Root, 'Include');
        const targetPath = path.join(includeDir, MQLDEBUG_MQH);
        const sourcePath = path.join(context.extensionPath, 'files', MQLDEBUG_MQH);

        try {
            await fs.promises.access(sourcePath);
        } catch {
            vscode.window.showErrorMessage(`MQL Debug: Cannot find ${MQLDEBUG_MQH} in extension bundle at: ${sourcePath}`);
            return false;
        }

        try {
            await fs.promises.mkdir(includeDir, { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
            return true;
        } catch (err) {
            vscode.window.showErrorMessage(`MQL Debug: Failed to deploy ${MQLDEBUG_MQH}: ${err.message}`);
            return false;
        }
    }

    /**
     * Collect all VS Code breakpoints mapped by lowercase file path.
     * @returns {Map<string, Array<{line: number, condition?: string}>>}
     */
    _collectAllBreakpoints() {
        const bpMap = new Map();
        for (const bp of vscode.debug.breakpoints) {
            if (!(bp instanceof vscode.SourceBreakpoint)) continue;
            const bpPath = bp.location.uri.fsPath.toLowerCase().replace(/\\/g, '/');
            if (!bpMap.has(bpPath)) bpMap.set(bpPath, []);
            bpMap.get(bpPath).push({
                line: bp.location.range.start.line + 1, // VS Code is 0-based, MQL is 1-based
                condition: bp.condition || '',
            });
        }
        return bpMap;
    }
}

// Singleton
const bridge = new MqlDebugBridge();
module.exports = {
    bridge,
    COMPILE_MODE_CHECK,
    COMPILE_MODE_COMPILE,
    COMPILE_MODE_SCRIPT
};
