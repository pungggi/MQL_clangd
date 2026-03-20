'use strict';
const vscode = require('vscode');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const THREAD_ID = 1;

/**
 * MqlDebugAdapter — inline DAP adapter shim for the MQL debug bridge.
 *
 * Does NOT control MetaTrader execution. Instead it:
 *   - Starts the debug bridge on DAP launch request
 *   - Emits DAP `stopped` events when DebugStateStore receives new breakpoint hits
 *   - Serves VS Code's native Variables and Call Stack panels from store data
 *   - Outputs breakpoint hit history to the Debug Console
 *
 * Implements the vscode.DebugAdapter interface (handleMessage + onDidSendMessage).
 */
class MqlDebugAdapter extends EventEmitter {
    /**
     * @param {import('./debugStateStore').DebugStateStore} store
     * @param {import('./debugBridge').MqlDebugBridge} bridge
     * @param {string} sourcePath
     * @param {string} mql5Root
     * @param {Function} compilePath
     * @param {object} context  VS Code extension context
     * @param {string} originalPath
     */
    constructor(store, bridge, sourcePath, mql5Root, compilePath, context, originalPath) {
        super();
        this._store        = store;
        this._bridge       = bridge;
        this._sourcePath   = sourcePath;
        this._mql5Root     = mql5Root;
        this._compilePath  = compilePath;
        this._context      = context;
        this._originalPath = originalPath;

        this._lastHitCount    = 0;
        this._wasActive       = false;
        this._seq             = 1;
        this._disposed        = false;

        // onDidSendMessage is required by VS Code's DebugAdapter interface.
        // We expose it as an EventEmitter event named 'message'.
        this._sendMessageEmitter = new vscode.EventEmitter();
        this.onDidSendMessage = this._sendMessageEmitter.event;

        this._storeListener = () => this._onStoreChange();
        this._store.onChange(this._storeListener);
    }

    // -------------------------------------------------------------------------
    // vscode.DebugAdapter interface
    // -------------------------------------------------------------------------

    /** Called by VS Code with each incoming DAP request. */
    handleMessage(message) {
        if (this._disposed) return;
        switch (message.command) {
            case 'initialize':          this._onInitialize(message); break;
            case 'launch':              this._onLaunch(message); break;
            case 'configurationDone':   this._onConfigurationDone(message); break;
            case 'threads':             this._onThreads(message); break;
            case 'stackTrace':          this._onStackTrace(message); break;
            case 'scopes':              this._onScopes(message); break;
            case 'variables':           this._onVariables(message); break;
            case 'continue':            this._onContinue(message); break;
            case 'pause':               this._onPause(message); break;
            case 'next':                this._onContinue(message); break;  // step-over → continue
            case 'stepIn':              this._onContinue(message); break;
            case 'stepOut':             this._onContinue(message); break;
            case 'terminate':           this._onTerminate(message); break;
            case 'disconnect':          this._onDisconnect(message); break;
            case 'setBreakpoints':      this._onSetBreakpoints(message); break;
            case 'setExceptionBreakpoints': this._sendResponse(message, {}); break;
            case 'setFunctionBreakpoints':  this._sendResponse(message, { breakpoints: [] }); break;
            case 'source':              this._onSource(message); break;
            default:
                // Acknowledge unknown requests gracefully so VS Code doesn't show errors
                this._sendResponse(message, {});
                break;
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._store.removeListener(this._storeListener);
        this._sendMessageEmitter.dispose();
    }

    // -------------------------------------------------------------------------
    // DAP request handlers
    // -------------------------------------------------------------------------

    _onInitialize(req) {
        this._sendResponse(req, {
            supportsConfigurationDoneRequest: true,
            supportsTerminateRequest: true,
        });
        this._sendEvent('initialized', {});
    }

    async _onLaunch(req) {
        // Start the bridge — wait for instrumentation + compilation to finish.
        // If bridge.start() returns without activating (compilation failed, user cancelled, etc.)
        // we terminate the debug session so VS Code doesn't stay in a phantom "running" state.
        try {
            await this._bridge.start(
                this._sourcePath,
                this._mql5Root,
                this._compilePath,
                this._context,
                () => {
                    vscode.commands.executeCommand('mql_tools.openTradingTerminal').then(undefined, () => {});
                }
            );
        } catch (err) {
            this._sendErrorResponse(req, `MQL Debug launch failed: ${err.message || err}`);
            this._sendEvent('terminated', {});
            return;
        }

        if (!this._bridge.isActive) {
            // bridge.start() returned normally but didn't activate
            // (user cancelled, no breakpoints + cancelled, or compilation failed)
            this._sendResponse(req, {});
            this._sendEvent('terminated', {});
            return;
        }

        this._wasActive = true;
        this._sendResponse(req, {});
    }

    _onConfigurationDone(req) {
        this._sendResponse(req, {});
    }

    _onThreads(req) {
        this._sendResponse(req, {
            threads: [{ id: THREAD_ID, name: 'MQL5 EA' }]
        });
    }

    _onStackTrace(req) {
        const stack = this._store.callStack;
        let frames;
        if (stack.length > 0) {
            // callStack is LIFO: last element is the innermost frame. Reverse for DAP (top = index 0).
            frames = stack.slice().reverse().map((f, i) => ({
                id:     i,
                name:   f.func,
                source: f.file ? { path: this._mapToOriginalPath(f.file) } : undefined,
                line:   parseInt(f.line, 10) || 0,
                column: 0,
            }));
        } else {
            // No enter/exit events — synthesize a frame from the latest hit
            const hit = this._store.latestHit;
            frames = hit ? [{
                id:     0,
                name:   hit.func || '(unknown)',
                source: hit.file ? { path: this._mapToOriginalPath(hit.file) } : undefined,
                line:   parseInt(hit.line, 10) || 0,
                column: 0,
            }] : [];
        }
        this._sendResponse(req, {
            stackFrames: frames,
            totalFrames: frames.length,
        });
    }

    _onSource(req) {
        // VS Code asks for file content when it can't find the file on disk.
        // Read the original source file instead of the temp build file.
        const sourceRef = req.arguments && req.arguments.source;
        const filePath = sourceRef && (sourceRef.path || '');
        const mappedPath = this._mapToOriginalPath(filePath);
        try {
            const content = fs.readFileSync(mappedPath, 'utf-8');
            this._sendResponse(req, { content, mimeType: 'text/plain' });
        } catch {
            this._sendErrorResponse(req, `Cannot read source: ${mappedPath}`);
        }
    }

    _onSetBreakpoints(req) {
        const bps = (req.arguments.breakpoints || []).map(b => ({
            id:       this._seq++,
            verified: true,
            line:     b.line,
        }));
        this._sendResponse(req, { breakpoints: bps });
    }

    _onScopes(req) {
        this._sendResponse(req, {
            scopes: [
                {
                    name:               'Watches',
                    variablesReference: 1,
                    expensive:          false,
                },
                {
                    name:               'Breakpoint Info',
                    variablesReference: 2,
                    expensive:          false,
                },
            ]
        });
    }

    _onVariables(req) {
        const ref = req.arguments && req.arguments.variablesReference;
        let variables = [];
        if (ref === 1) {
            // Watches scope — latest watch values from the most recent hit
            const hit = this._store.latestHit;
            if (hit && hit.watches && hit.watches.length) {
                variables = hit.watches.map(w => ({
                    name:               w.varName,
                    value:              String(w.value),
                    type:               w.varType,
                    variablesReference: 0,
                }));
            } else {
                variables = this._store.latestWatchList.map(w => ({
                    name:               w.varName,
                    value:              String(w.value),
                    type:               w.varType,
                    variablesReference: 0,
                }));
            }
        } else if (ref === 2) {
            // Breakpoint Info scope — metadata about the current hit
            const hit = this._store.latestHit;
            if (hit) {
                variables = [
                    { name: 'Label',          value: hit.label || '(none)',                              variablesReference: 0 },
                    { name: 'Function',       value: hit.func || '(unknown)',                            variablesReference: 0 },
                    { name: 'File',           value: hit.file || '(unknown)',                            variablesReference: 0 },
                    { name: 'Line',           value: String(hit.line || 0),     type: 'int',            variablesReference: 0 },
                    { name: 'Timestamp',      value: hit.timestamp || '',                                variablesReference: 0 },
                    { name: 'BP Hit Count',   value: String(hit.hitCount || 0), type: 'int',            variablesReference: 0 },
                    { name: 'Total Hits',     value: String(this._store.hits.length), type: 'int',      variablesReference: 0 },
                ];
            }
        }
        this._sendResponse(req, { variables });
    }

    _onContinue(req) {
        this._sendContinueCommand();
        this._sendResponse(req, { allThreadsContinued: true });
        this._sendEvent('continued', { threadId: THREAD_ID, allThreadsContinued: true });
    }

    _onPause(req) {
        // Cannot pause at an arbitrary point — only breakpoints pause the EA
        this._sendResponse(req, {});
    }

    _onTerminate(req) {
        this._sendContinueCommand();  // unblock EA if paused
        this._sendResponse(req, {});
        this._bridge.stop();
    }

    _onDisconnect(req) {
        this._sendContinueCommand();  // unblock EA if paused
        this._sendResponse(req, {});
        this._bridge.stop();
        this._sendEvent('exited', { exitCode: 0 });
        this._sendEvent('terminated', {});
    }

    // -------------------------------------------------------------------------
    // Store change handler
    // -------------------------------------------------------------------------

    _onStoreChange() {
        if (this._disposed) return;

        const hits = this._store.hits;
        console.log(`[MqlDebugAdapter] _onStoreChange: hits=${hits.length}, lastHitCount=${this._lastHitCount}, sessionActive=${this._store.sessionActive}`);

        // Reset hit counter if the store was cleared (new session)
        if (hits.length < this._lastHitCount) {
            this._lastHitCount = 0;
        }

        // Emit stopped + console output for each new hit
        if (hits.length > this._lastHitCount) {
            for (let i = this._lastHitCount; i < hits.length; i++) {
                const h = hits[i];
                // Output to Debug Console so user sees hit history
                this._sendEvent('output', {
                    category: 'console',
                    output:   `[MQL Break] ${h.label}  ${h.func}:${h.line}  (${h.file})  ${h.timestamp}\n`,
                });
                // Output watch values for this hit
                if (h.watches && h.watches.length) {
                    for (const w of h.watches) {
                        this._sendEvent('output', {
                            category: 'console',
                            output:   `  ${w.varName} (${w.varType}) = ${w.value}\n`,
                        });
                    }
                }
            }
            this._lastHitCount = hits.length;

            // Fire stopped event — VS Code will pause the UI and request
            // stackTrace/scopes/variables, populating the native panels.
            // VS Code handles repeated stopped events while already paused
            // by simply refreshing the panels — no continued event needed.
            this._sendEvent('stopped', {
                reason:            'breakpoint',
                description:       `Hit: ${hits[hits.length - 1].label}`,
                threadId:          THREAD_ID,
                allThreadsStopped: true,
            });
        }

        // Session ended
        if (this._wasActive && !this._store.sessionActive) {
            this._sendEvent('exited', { exitCode: 0 });
            this._sendEvent('terminated', {});
        }
        this._wasActive = this._store.sessionActive;
    }

    // -------------------------------------------------------------------------
    // EA command channel
    // -------------------------------------------------------------------------

    /**
     * Write CONTINUE to the command file so the paused EA resumes.
     * Safe to call even if no EA is paused (the file is just ignored).
     */
    _sendContinueCommand() {
        if (!this._mql5Root) return;
        const cmdPath = path.join(this._mql5Root, 'Files', 'MqlDebugCmd.txt');
        try {
            fs.writeFileSync(cmdPath, 'CONTINUE\n', 'utf-8');
        } catch (err) {
            console.warn('[MqlDebugAdapter] Failed to write continue command:', err.message);
        }
    }

    // -------------------------------------------------------------------------
    // Path mapping
    // -------------------------------------------------------------------------

    /**
     * Map instrumented temp file names back to original source paths.
     * e.g. "SMC.mql_dbg_build.mq5" → original source path for "SMC.mq5"
     * The temp file name pattern is: <basename>.mql_dbg_build.<ext>
     */
    _mapToOriginalPath(filePath) {
        if (!filePath) return filePath;
        // Replace .mql_dbg_build.mq5 → .mq5 (and .mq4)
        const mapped = filePath.replace(/\.mql_dbg_build\.(mq[45])/i, '.$1');
        if (mapped !== filePath && this._originalPath) {
            // If we have the original path, use it directly (handles full path)
            return this._originalPath;
        }
        return mapped;
    }

    // -------------------------------------------------------------------------
    // DAP message helpers
    // -------------------------------------------------------------------------

    _sendResponse(req, body) {
        const msg = {
            type:        'response',
            seq:         this._seq++,
            request_seq: req.seq,
            success:     true,
            command:     req.command,
            body:        body || {},
        };
        this._sendMessageEmitter.fire(msg);
    }

    _sendErrorResponse(req, message) {
        const msg = {
            type:        'response',
            seq:         this._seq++,
            request_seq: req.seq,
            success:     false,
            command:     req.command,
            message,
            body:        {},
        };
        this._sendMessageEmitter.fire(msg);
    }

    _sendEvent(event, body) {
        const msg = {
            type:  'event',
            seq:   this._seq++,
            event,
            body:  body || {},
        };
        this._sendMessageEmitter.fire(msg);
    }
}

module.exports = { MqlDebugAdapter };
