'use strict';
const vscode = require('vscode');
const { EventEmitter } = require('events');

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
        this.onDidSendMessage = new vscode.EventEmitter();

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
            case 'setBreakpoints':      this._sendResponse(message, { breakpoints: [] }); break;
            case 'setExceptionBreakpoints': this._sendResponse(message, {}); break;
            case 'setFunctionBreakpoints':  this._sendResponse(message, { breakpoints: [] }); break;
            default:
                // Respond with a generic error for unknown requests
                this._sendErrorResponse(message, `Unsupported request: ${message.command}`);
                break;
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._store.removeListener(this._storeListener);
        this.onDidSendMessage.dispose();
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

    _onLaunch(req) {
        // Start the bridge asynchronously; respond immediately so VS Code
        // can send configurationDone while compilation is in progress.
        this._sendResponse(req, {});

        void this._bridge.start(
            this._sourcePath,
            this._mql5Root,
            this._compilePath,
            this._context,
            () => {
                // openPanel callback — open the trading terminal; no webview panel needed
                vscode.commands.executeCommand('mql_tools.openTradingTerminal').then(undefined, () => {});
            },
            this._originalPath
        );
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
        // callStack is LIFO: last element is the innermost frame. Reverse for DAP (top = index 0).
        const frames = stack.slice().reverse().map((f, i) => ({
            id:     i,
            name:   f.func,
            source: f.file ? { path: f.file } : undefined,
            line:   parseInt(f.line, 10) || 0,
            column: 0,
        }));
        this._sendResponse(req, {
            stackFrames: frames,
            totalFrames: frames.length,
        });
    }

    _onScopes(req) {
        this._sendResponse(req, {
            scopes: [
                {
                    name:               'Watches',
                    variablesReference: 1,
                    expensive:          false,
                },
            ]
        });
    }

    _onVariables(req) {
        const ref = req.arguments && req.arguments.variablesReference;
        let variables = [];
        if (ref === 1) {
            variables = this._store.latestWatchList.map(w => ({
                name:               w.varName,
                value:              String(w.value),
                type:               w.varType,
                variablesReference: 0,
            }));
        }
        this._sendResponse(req, { variables });
    }

    _onContinue(req) {
        this._sendResponse(req, { allThreadsContinued: true });
        this._sendEvent('continued', { threadId: THREAD_ID, allThreadsContinued: true });
    }

    _onPause(req) {
        // No-op — we cannot pause the MT5 EA
        this._sendResponse(req, {});
    }

    _onTerminate(req) {
        this._sendResponse(req, {});
        this._bridge.stop();
    }

    _onDisconnect(req) {
        this._sendResponse(req, {});
        this._bridge.stop();
        this._sendEvent('exited', { exitCode: 0 });
        this._sendEvent('terminated', {});
    }

    // -------------------------------------------------------------------------
    // Store change handler
    // -------------------------------------------------------------------------

    _onStoreChange() {
        const hits = this._store.hits;

        // Emit stopped + console output for each new hit
        if (hits.length > this._lastHitCount) {
            for (let i = this._lastHitCount; i < hits.length; i++) {
                const h = hits[i];
                this._sendEvent('output', {
                    category: 'console',
                    output:   `[MQL Break] ${h.label}  ${h.func}:${h.line}  (${h.file})  ${h.timestamp}\n`,
                });
            }
            this._lastHitCount = hits.length;
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
        this.onDidSendMessage.fire(msg);
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
        this.onDidSendMessage.fire(msg);
    }

    _sendEvent(event, body) {
        const msg = {
            type:  'event',
            seq:   this._seq++,
            event,
            body:  body || {},
        };
        this.onDidSendMessage.fire(msg);
    }
}

module.exports = { MqlDebugAdapter };
