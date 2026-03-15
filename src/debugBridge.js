'use strict';
const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

const { instrumentSource }   = require('./debugInstrumentation');
const { MqlDebugLogReader }  = require('./debugLogReader');
const { store }              = require('./debugStateStore');

const MQLDEBUG_MQH = 'MqlDebug.mqh';

/**
 * Compile modes for compilePath()
 */
const COMPILE_MODE_CHECK   = 0;
const COMPILE_MODE_COMPILE = 1;
const COMPILE_MODE_SCRIPT  = 2;

/**
 * MqlDebugBridge — Phase 1 orchestrator.
 *
 * Responsibilities:
 *   1. Deploy MqlDebug.mqh to the Include/ folder (if absent).
 *   2. Collect VS Code breakpoints for the active source file.
 *   3. Call instrumentSource() to produce a temp .mql_dbg_build file.
 *   4. Invoke compilePath() via the provided compile function.
 *   5. Start MqlDebugLogReader and forward events to DebugStateStore.
 *   6. Open the DebugPanel webview.
 *   7. Clean up temp files and stop the reader on session end.
 */
class MqlDebugBridge {
    constructor() {
        /** @type {MqlDebugLogReader|null} */
        this._reader    = null;
        /** @type {(() => void)|null} */
        this._restore   = null;
        this._active    = false;
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
     * @param {Function} openPanel     Callback: openPanel(store) — opens/updates the debug panel
     */
    async start(sourcePath, mql5Root, compilePath, context, openPanel) {
        if (this._active) {
            vscode.window.showWarningMessage('MQL Debug session already running. Stop it first.');
            return;
        }

        // 1. Deploy MqlDebug.mqh
        const deployed = await this._deployLibrary(mql5Root, context);
        if (!deployed) return;

        // 2. Collect breakpoints for this file
        const breakpoints = this._collectBreakpoints(sourcePath);
        if (breakpoints.length === 0) {
            const answer = await vscode.window.showInformationMessage(
                'No breakpoints found in this file. Run anyway with only session-start logging?',
                'Yes', 'Cancel'
            );
            if (answer !== 'Yes') return;
        }

        // 3. Instrument source → temp file
        let tempPath, restore, skipped;
        try {
            ({ tempPath, restore, skipped } = instrumentSource(sourcePath, breakpoints));
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
                    compileError = await compilePath(COMPILE_MODE_COMPILE, tempPath, context);
                } catch (err) {
                    compileError = err.message || String(err);
                }

                if (compileError) {
                    restore();
                    vscode.window.showErrorMessage(`MQL Debug: Compilation failed — ${compileError}`);
                    return false;
                }
                return true;
            }
        );

        if (!success) return;

        // Compilation succeeded — keep the temp file alive until session ends
        // (MetaTrader needs the .ex5 which is next to the temp file)

        // 5. Start debug session
        this._active  = true;
        this._restore = restore;
        store.startSession();

        this._reader = new MqlDebugLogReader(mql5Root);
        this._reader.onBatch  = (evts) => store.applyBatch(evts);
        this._reader.onError  = (err) => {
            vscode.window.showErrorMessage(`MQL Debug: Log reader error — ${err.message || String(err)}`);
            this.stop();
        };
        this._reader.start();

        // 6. Open the panel
        openPanel(store);

        vscode.window.showInformationMessage(
            'MQL Debug session started. Attach the compiled EA in MetaTrader to begin.',
            'Stop Session'
        ).then(selection => {
            if (selection === 'Stop Session') this.stop();
        });
    }

    /** Stop the current debug session and clean up. */
    stop() {
        if (!this._active) return;
        this._active = false;

        if (this._reader) {
            this._reader.stop();
            this._reader = null;
        }
        if (this._restore) {
            this._restore();
            this._restore = null;
        }

        store.endSession();
        vscode.window.showInformationMessage('MQL Debug session stopped.');
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Deploy MqlDebug.mqh from extension bundle to MQL Include folder.
     * @param {string} mql5Root
     * @param {object} context  VS Code extension context
     * @returns {Promise<boolean>}
     */
    async _deployLibrary(mql5Root, context) {
        const includeDir = path.join(mql5Root, 'Include');
        const targetPath = path.join(includeDir, MQLDEBUG_MQH);

        try {
            await fs.promises.access(targetPath);
            return true; // Already deployed
        } catch (e) {
            if (e.code !== 'ENOENT') {
                throw e; // Rethrow permission errors or other FS issues
            }
            // If ENOENT, proceed to deploy
        }

        const extensionPath = context.extensionPath;
        const sourcePath    = path.join(extensionPath, 'files', MQLDEBUG_MQH);

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
     * Collect VS Code breakpoints for the given source file.
     * @param {string} sourcePath
     * @returns {Array<{line: number, condition?: string}>}
     */
    _collectBreakpoints(sourcePath) {
        const normalised = sourcePath.toLowerCase().replace(/\\/g, '/');
        return vscode.debug.breakpoints
            .filter(bp => {
                if (!(bp instanceof vscode.SourceBreakpoint)) return false;
                const bpPath = bp.location.uri.fsPath.toLowerCase().replace(/\\/g, '/');
                return bpPath === normalised;
            })
            .map(bp => ({
                line:      bp.location.range.start.line + 1, // VS Code is 0-based, MQL is 1-based
                condition: bp.condition || '',
            }));
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
