'use strict';
const vscode = require('vscode');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { instrumentedToOriginal } = require('./debugInstrumentation');

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
        this._store = store;
        this._bridge = bridge;
        this._sourcePath = sourcePath;
        this._mql5Root = mql5Root;
        this._compilePath = compilePath;
        this._context = context;
        this._originalPath = originalPath;

        this._lastHitCount = 0;
        this._wasActive = false;
        this._seq = 1;
        this._disposed = false;
        /** @type {Map<string, Set<number>>} active breakpoints per source path (lowercase) */
        this._activeBreakpoints = new Map();
        /** True once VS Code has sent at least one setBreakpoints request */
        this._breakpointsConfigured = false;
        /** @type {ReturnType<typeof setTimeout>|null} debounce timer for BP config writes */
        this._reinstrumentTimer = null;

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
            case 'initialize': this._onInitialize(message); break;
            case 'launch': this._onLaunch(message); break;
            case 'configurationDone': this._onConfigurationDone(message); break;
            case 'threads': this._onThreads(message); break;
            case 'stackTrace': this._onStackTrace(message); break;
            case 'scopes': this._onScopes(message); break;
            case 'variables': this._onVariables(message); break;
            case 'continue': this._onContinue(message); break;
            case 'pause': this._onPause(message); break;
            case 'next': this._onContinue(message); break;  // step-over → continue
            case 'stepIn': this._onContinue(message); break;
            case 'stepOut': this._onContinue(message); break;
            case 'terminate': this._onTerminate(message); break;
            case 'disconnect': this._onDisconnect(message); break;
            case 'setBreakpoints': this._onSetBreakpoints(message); break;
            case 'setExceptionBreakpoints': this._sendResponse(message, {}); break;
            case 'setFunctionBreakpoints': this._sendResponse(message, { breakpoints: [] }); break;
            case 'source': this._onSource(message); break;
            default:
                // Acknowledge unknown requests gracefully so VS Code doesn't show errors
                this._sendResponse(message, {});
                break;
        }
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (this._reinstrumentTimer) {
            clearTimeout(this._reinstrumentTimer);
            this._reinstrumentTimer = null;
        }
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
                (eaPath) => {
                    vscode.commands.executeCommand('mql_tools.openTradingTerminal', eaPath, this._mql5Root).then(undefined, () => { });
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
        const hit = this._store.latestHit;
        let frames;
        if (stack.length > 0) {
            // callStack is LIFO: last element is the innermost frame. Reverse for DAP (top = index 0).
            frames = stack.slice().reverse().map((f, i) => ({
                id: i,
                name: f.func,
                source: f.file ? { path: this._mapToOriginalPath(f.file) } : undefined,
                line: this._translateLine(f.file, parseInt(f.line, 10) || 0),
                column: 0,
            }));
            // Override top frame line with the original breakpoint line when available
            // (label-based parsing is more precise than the offset table for the hit frame)
            if (frames.length > 0 && hit) {
                const origLine = this._parseOriginalLine(hit.label);
                if (origLine > 0) frames[0].line = origLine;
            }
        } else {
            // No enter/exit events — synthesize a frame from the latest hit
            frames = hit ? [{
                id: 0,
                name: hit.func || '(unknown)',
                source: hit.file ? { path: this._mapToOriginalPath(hit.file) } : undefined,
                line: this._parseOriginalLine(hit.label) || this._translateLine(hit.file, parseInt(hit.line, 10) || 0),
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
        const src = req.arguments && req.arguments.source;
        const key = src && src.path ? src.path.toLowerCase().replace(/\\/g, '/') : null;

        // Resolve each requested line to its nearest probe, returning the
        // verified actual line (so VS Code moves the gutter indicator).
        const bps = (req.arguments.breakpoints || []).map(b => {
            let actualLine = b.line;
            let verified = true;
            if (key && this._bridge.probeMap) {
                const fileProbes = this._bridge.probeMap.get(key);
                if (fileProbes) {
                    let found = false;
                    // First check forward (downward)
                    for (let offset = 0; offset <= 10; offset++) {
                        if (fileProbes.has(b.line + offset)) {
                            actualLine = b.line + offset;
                            found = true;
                            break;
                        }
                    }
                    // Then check backward (upward)
                    if (!found) {
                        for (let offset = -1; offset >= -10; offset--) {
                            if (fileProbes.has(b.line + offset)) {
                                actualLine = b.line + offset;
                                found = true;
                                break;
                            }
                        }
                    }
                    if (!found) verified = false;
                }
            }
            return { id: this._seq++, verified, line: actualLine };
        });

        // Track active breakpoint lines (verified lines) for auto-continue fallback
        if (key) {
            const lines = new Set(bps.filter(b => b.verified).map(b => b.line));
            if (lines.size > 0) {
                this._activeBreakpoints.set(key, lines);
            } else {
                this._activeBreakpoints.delete(key);
            }
            this._breakpointsConfigured = true;

            // Write updated probe config — the EA picks it up within ~200 ms.
            // Debounce so rapid multi-file changes batch into one write.
            if (this._bridge.isActive) {
                this._scheduleConfigWrite();
            }
        }

        this._sendResponse(req, { breakpoints: bps });
    }

    /**
     * Debounced write of the breakpoint config file.
     * Collects all active probe IDs from _activeBreakpoints and writes them.
     */
    _scheduleConfigWrite() {
        if (this._reinstrumentTimer) clearTimeout(this._reinstrumentTimer);
        this._reinstrumentTimer = setTimeout(() => {
            this._reinstrumentTimer = null;
            this._writeBreakpointConfig();
        }, 100);
    }

    /** Resolve all active breakpoint lines to probe IDs and write the config file. */
    _writeBreakpointConfig() {
        if (!this._bridge.isActive) return;
        try {
            const activeIds = [];
            for (const [filePath, lines] of this._activeBreakpoints) {
                for (const line of lines) {
                    let id;
                    try {
                        id = this._bridge.resolveProbeId(filePath, line);
                    } catch (err) {
                        console.error(`[MqlDebugAdapter] Bridge error resolving probe id for ${filePath}:${line}`, err);
                        continue;
                    }
                    if (id !== undefined) activeIds.push(id);
                }
            }
            this._bridge.writeBreakpointConfig(activeIds);
        } catch (err) {
            console.error(`[MqlDebugAdapter] Fatal bridge error in _writeBreakpointConfig:`, err);
        }
    }

    _onScopes(req) {
        this._sendResponse(req, {
            scopes: [
                {
                    name: 'Watches',
                    variablesReference: 1,
                    expensive: false,
                },
                {
                    name: 'Breakpoint Info',
                    variablesReference: 2,
                    expensive: false,
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
                    name: w.varName,
                    value: String(w.value),
                    type: w.varType,
                    variablesReference: 0,
                }));
            } else {
                variables = this._store.latestWatchList.map(w => ({
                    name: w.varName,
                    value: String(w.value),
                    type: w.varType,
                    variablesReference: 0,
                }));
            }
        } else if (ref === 2) {
            // Breakpoint Info scope — metadata about the current hit
            const hit = this._store.latestHit;
            if (hit) {
                variables = [
                    { name: 'Label', value: hit.label || '(none)', variablesReference: 0 },
                    { name: 'Function', value: hit.func || '(unknown)', variablesReference: 0 },
                    { name: 'File', value: hit.file || '(unknown)', variablesReference: 0 },
                    { name: 'Line', value: String(this._parseOriginalLine(hit.label) || this._translateLine(hit.file, parseInt(hit.line, 10) || 0)), type: 'int', variablesReference: 0 },
                    { name: 'Timestamp', value: hit.timestamp || '', variablesReference: 0 },
                    { name: 'BP Hit Count', value: String(hit.hitCount || 0), type: 'int', variablesReference: 0 },
                    { name: 'Total Hits', value: String(this._store.hits.length), type: 'int', variablesReference: 0 },
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
        this._sendResponse(req, {});
        this._bridge.stop();  // sends STOP command — EA will self-unload
    }

    _onDisconnect(req) {
        this._sendResponse(req, {});
        this._bridge.stop();  // sends STOP command — EA will self-unload
    }

    // -------------------------------------------------------------------------
    // Store change handler
    // -------------------------------------------------------------------------

    _onStoreChange() {
        if (this._disposed) return;

        const hits = this._store.hits;

        // Reset hit counter if the store was cleared (new session)
        if (hits.length < this._lastHitCount) {
            this._lastHitCount = 0;
        }

        // Emit stopped + console output for each new hit
        if (hits.length > this._lastHitCount) {
            let shouldStop = false;
            for (let i = this._lastHitCount; i < hits.length; i++) {
                const h = hits[i];
                // Output to Debug Console so user sees hit history
                const displayLine = this._parseOriginalLine(h.label) || this._translateLine(h.file, parseInt(h.line, 10) || 0);
                this._sendEvent('output', {
                    category: 'console',
                    output: `[MQL Break] ${h.label}  ${h.func}:${displayLine}  (${h.file})  ${h.timestamp}\n`,
                });
                // Output watch values for this hit
                if (h.watches && h.watches.length) {
                    for (const w of h.watches) {
                        this._sendEvent('output', {
                            category: 'console',
                            output: `  ${w.varName} (${w.varType}) = ${w.value}\n`,
                        });
                    }
                }
                // Check if this breakpoint is still active in VS Code
                if (this._isBreakpointActive(h.label)) {
                    shouldStop = true;
                }
            }
            this._lastHitCount = hits.length;

            if (shouldStop) {
                // Fire stopped event — VS Code will pause the UI and request
                // stackTrace/scopes/variables, populating the native panels.
                this._sendEvent('stopped', {
                    reason: 'breakpoint',
                    description: `Hit: ${hits[hits.length - 1].label}`,
                    threadId: THREAD_ID,
                    allThreadsStopped: true,
                });
            } else {
                // Breakpoint was removed during session — auto-continue
                this._sendContinueCommand();
            }
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
    // Breakpoint tracking
    // -------------------------------------------------------------------------

    /**
     * Check if a breakpoint label (e.g. "bp_SMC_mq5_310") corresponds to
     * a line that still has an active breakpoint in VS Code.
     * If we have no tracking data yet (session started before any setBreakpoints),
     * assume active so we don't silently skip hits.
     */
    /**
     * Extract the original source line number from a breakpoint label.
     * Label format: bp_{sanitized_file}_{line}  (e.g. "bp_SMC_mq5_310")
     * @returns {number} original line, or 0 if unparseable
     */
    _parseOriginalLine(label) {
        const m = label && label.match(/_(\d+)$/);
        return m ? parseInt(m[1], 10) : 0;
    }

    _isBreakpointActive(label) {
        // Before any setBreakpoints call we have no tracking data — assume active.
        // An empty map after configuration means all BPs were removed → auto-continue.
        if (!this._breakpointsConfigured) return true;

        const originalLine = this._parseOriginalLine(label);
        if (!originalLine) return true; // can't parse — assume active

        // Check all tracked files for this line
        for (const lines of this._activeBreakpoints.values()) {
            if (lines.has(originalLine)) return true;
        }
        return false;
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
        // Strip .mql_dbg_build from the filename
        const mapped = filePath.replace(/\.mql_dbg_build\.(mq[45])/i, '.$1');

        // __FILE__ in MQL5 returns just the filename (no directory path).
        // Resolve back to a full path by matching the basename.
        const mappedBase = path.basename(mapped).toLowerCase();
        if (this._originalPath && path.basename(this._originalPath).toLowerCase() === mappedBase) {
            return this._originalPath;
        }
        if (this._sourcePath && path.basename(this._sourcePath).toLowerCase() === mappedBase) {
            return this._sourcePath;
        }

        // For included files: try resolving relative to the source directory
        if (this._sourcePath) {
            const resolved = path.join(path.dirname(this._sourcePath), mapped);
            try {
                if (fs.existsSync(resolved)) return resolved;
            } catch (err) {
                console.debug(`[MqlDebugAdapter] Source resolution failed for "${resolved}": ${err.message}`);
            }
        }

        return mapped;
    }

    // -------------------------------------------------------------------------
    // Line mapping
    // -------------------------------------------------------------------------

    /**
     * Translate an instrumented line number back to the original source line.
     * Falls back to the raw line if no line map is available.
     *
     * @param {string} file  File name as reported by MQL5 (__FILE__)
     * @param {number} instrumentedLine  1-based line in the instrumented file
     * @returns {number}
     */
    _translateLine(file, instrumentedLine) {
        if (!instrumentedLine || !this._bridge.lineMap) return instrumentedLine;
        const mapped = file ? file.replace(/\.mql_dbg_build\.(mq[45])/i, '.$1') : '';
        const normFile = mapped.toLowerCase().replace(/\\/g, '/');
        const normBase = normFile.substring(normFile.lastIndexOf('/') + 1);
        // lineMap is keyed by normalized full path; prefer full-path match, fall back to basename
        let baseMatch = null;
        let baseMatchCount = 0;
        for (const [key, offsets] of this._bridge.lineMap) {
            if (key === normFile || key.endsWith('/' + normFile)) {
                return instrumentedToOriginal(instrumentedLine, offsets);
            }
            const keyBase = key.substring(key.lastIndexOf('/') + 1);
            if (keyBase === normBase) {
                if (!baseMatch) baseMatch = offsets;
                baseMatchCount++;
            }
        }
        if (baseMatch) {
            if (baseMatchCount > 1) {
                console.warn(`[MqlDebugAdapter] Ambiguous line map: ${baseMatchCount} files match basename "${normBase}". Using first match.`);
            }
            return instrumentedToOriginal(instrumentedLine, baseMatch);
        }
        return instrumentedLine;
    }

    // -------------------------------------------------------------------------
    // DAP message helpers
    // -------------------------------------------------------------------------

    _sendResponse(req, body) {
        const msg = {
            type: 'response',
            seq: this._seq++,
            request_seq: req.seq,
            success: true,
            command: req.command,
            body: body || {},
        };
        this._sendMessageEmitter.fire(msg);
    }

    _sendErrorResponse(req, message) {
        const msg = {
            type: 'response',
            seq: this._seq++,
            request_seq: req.seq,
            success: false,
            command: req.command,
            message,
            body: {},
        };
        this._sendMessageEmitter.fire(msg);
    }

    _sendEvent(event, body) {
        const msg = {
            type: 'event',
            seq: this._seq++,
            event,
            body: body || {},
        };
        this._sendMessageEmitter.fire(msg);
    }
}

module.exports = { MqlDebugAdapter };
