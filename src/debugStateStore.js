'use strict';

const MAX_HITS        = 200;
const MAX_CALL_FRAMES = 50;

/**
 * In-memory store for the current MQL debug session state.
 *
 * Consumers (MqlDebugAdapter DAP shim) read from this store;
 * debugBridge writes to it by forwarding events from MqlDebugLogReader.
 *
 * @typedef {Object} WatchEntry
 * @property {string} varName
 * @property {string} varType
 * @property {string} value
 * @property {string} file
 * @property {string} func
 * @property {number} line
 * @property {string} timestamp
 *
 * @typedef {Object} BreakpointHit
 * @property {string} label
 * @property {string} file
 * @property {string} func
 * @property {number} line
 * @property {string} timestamp
 * @property {WatchEntry[]} watches   Variables captured at this hit
 * @property {number} hitCount
 *
 * @typedef {Object} CallFrame
 * @property {string} func
 * @property {string} file
 * @property {number} line
 * @property {'entered'|'exited'} state
 */
class DebugStateStore {
    constructor() {
        this._reset();
        /** @type {((store: DebugStateStore) => void)[]} */
        this._listeners = [];
    }

    _reset() {
        /** @type {BreakpointHit[]} */
        this.hits = [];
        /** @type {CallFrame[]} */
        this.callStack = [];
        /** Most recent watch values, keyed by varName */
        this.latestWatches = new Map(); // varName -> WatchEntry
        /** Per-breakpoint hit counts, keyed by label */
        this.hitCounts = new Map(); // label -> number
        /** @type {{ message: string, file: string, func: string, line: number, timestamp: string }[]} */
        this.logMessages = [];
        /** Monotonic counters — survive shift() so consumers detect new entries */
        this.totalHitCount = 0;
        this.totalLogCount = 0;
        this.sessionActive = false;
    }

    // -------------------------------------------------------------------------
    // Mutation (called by debugBridge from log reader events)
    // -------------------------------------------------------------------------

    startSession() {
        this._reset();
        this.sessionActive = true;
        this._notify();
    }

    endSession() {
        this.sessionActive = false;
        this._notify();
    }

    /**
     * Apply multiple events and notify listeners only once at the end.
     * Avoids triggering N panel re-renders for a batch of watch events
     * that all arrive together in a single log-file chunk.
     * @param {import('./debugLogReader').DebugEvent[]} events
     */
    applyBatch(events) {
        if (Array.isArray(events)) {
            for (const evt of events) {
                this._applyOne(evt);
            }
        }
        this._notify();
    }

    /** @param {import('./debugLogReader').DebugEvent} event */
    applyEvent(event) {
        this._applyOne(event);
        this._notify();
    }

    /** Internal: mutate state without notifying. */
    _applyOne(event) {
        switch (event.type) {
            case 'break': {
                const count = (this.hitCounts.get(event.label) || 0) + 1;
                this.hitCounts.set(event.label, count);
                const hit = {
                    label:     event.label,
                    file:      event.file,
                    func:      event.func,
                    line:      event.line,
                    timestamp: event.timestamp,
                    watches:   [],
                    hitCount:  count,
                };
                this.hits.push(hit);
                this.totalHitCount++;
                if (this.hits.length > MAX_HITS) this.hits.shift();
                break;
            }
            case 'watch': {
                const entry = {
                    varName:   event.varName,
                    varType:   event.varType,
                    value:     event.value,
                    file:      event.file,
                    func:      event.func,
                    line:      event.line,
                    timestamp: event.timestamp,
                };
                if (this.hits.length > 0) {
                    this.hits[this.hits.length - 1].watches.push(entry);
                }
                this.latestWatches.set(event.varName, entry);
                break;
            }
            case 'enter': {
                this.callStack.push({ func: event.func, file: event.file, line: event.line, state: 'entered' });
                if (this.callStack.length > MAX_CALL_FRAMES) this.callStack.shift();
                break;
            }
            case 'exit': {
                const top = this.callStack[this.callStack.length - 1];
                if (top && top.func === event.func) {
                    this.callStack.pop();
                } else {
                    this.callStack.push({ func: event.func, file: event.file, line: event.line, state: 'exited' });
                    if (this.callStack.length > MAX_CALL_FRAMES) this.callStack.shift();
                }
                break;
            }
            case 'log': {
                this.logMessages.push({
                    message:   event.message,
                    file:      event.file,
                    func:      event.func,
                    line:      event.line,
                    timestamp: event.timestamp,
                });
                this.totalLogCount++;
                if (this.logMessages.length > MAX_HITS) this.logMessages.shift();
                break;
            }
            case 'session_end': {
                this.sessionActive = false;
                break;
            }
            default:
                console.warn(`[DebugStateStore] Unrecognized event type: ${event.type}`, event);
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    /** @returns {BreakpointHit|null} The most recent breakpoint hit */
    get latestHit() {
        return this.hits.length > 0 ? this.hits[this.hits.length - 1] : null;
    }

    /** @returns {WatchEntry[]} All latest watch values as an array */
    get latestWatchList() {
        return Array.from(this.latestWatches.values());
    }

    // -------------------------------------------------------------------------
    // Observers
    // -------------------------------------------------------------------------

    /** @param {(store: DebugStateStore) => void} listener */
    onChange(listener) {
        this._listeners.push(listener);
    }

    removeListener(listener) {
        const idx = this._listeners.indexOf(listener);
        if (idx !== -1) this._listeners.splice(idx, 1);
    }

    _notify() {
        const listeners = this._listeners.slice();
        for (const l of listeners) {
            try {
                l(this);
            } catch (err) {
                console.warn('MqlDebugStore listener error:', err);
            }
        }
    }
}

// Singleton — one store per extension activation
const store = new DebugStateStore();
module.exports = { store, DebugStateStore, MAX_HITS };
