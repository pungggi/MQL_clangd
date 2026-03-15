'use strict';
const fs = require('fs');
const path = require('path');

const MQLDEBUG_FILENAME = 'MqlDebug.txt';
const POLL_INTERVAL_MS  = 5000;

/**
 * Reads MqlDebug.txt written by MqlDebug.mqh and emits parsed debug events.
 *
 * Structured line format (written by MqlDebug.mqh):
 *   DBG|{timestamp}|{file}|{function}|{line}|WATCH|{name}|{type}|{value}
 *   DBG|{timestamp}|{file}|{function}|{line}|BREAK|{label}
 *   DBG|{timestamp}|{file}|{function}|{line}|ENTER
 *   DBG|{timestamp}|{file}|{function}|{line}|EXIT
 *
 * Usage:
 *   const reader = new MqlDebugLogReader(basePath);
 *   reader.onEvent = (event) => { ... };
 *   reader.start();
 *   // ...
 *   reader.stop();
 */
class MqlDebugLogReader {
    /**
     * @param {string} basePath  MQL5 root folder (contains Files/, Include/, etc.)
     */
    constructor(basePath) {
        this.basePath    = basePath;
        this.filePath    = path.join(basePath, 'Files', MQLDEBUG_FILENAME);
        this.lastSize    = 0;
        this.isRunning   = false;
        this.watcher     = null;
        this.timer       = null;

        /** Preferred: called with all events in a file chunk at once. @type {((events: DebugEvent[]) => void) | null} */
        this.onBatch     = null;
        /** Fallback: called per-event if onBatch is not set. @type {((event: DebugEvent) => void) | null} */
        this.onEvent     = null;
        /** @type {((err: Error) => void) | null} */
        this.onError     = null;
    }

    /** Start watching the debug log file. Clears the file first for a clean session. */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastSize  = 0;

        // Clear the log file for this session (same pattern as logTailer)
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(this.filePath)) {
                fs.writeFileSync(this.filePath, '');
            }
        } catch (err) {
            this._emitError(err);
        }

        this._setupWatcher();
        this._poll(); // Backup polling
    }

    /** Stop watching. */
    stop() {
        this.isRunning = false;
        if (this.watcher) {
            try { this.watcher.close(); } catch { /* ignore */ }
            this.watcher = null;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    _setupWatcher() {
        if (this.watcher) {
            try { this.watcher.close(); } catch { /* ignore */ }
            this.watcher = null;
        }
        if (!fs.existsSync(this.filePath)) return;

        try {
            this.watcher = fs.watch(this.filePath, (eventType) => {
                if (!this.isRunning) return;
                if (eventType === 'change') this._checkForNewContent();
            });
            this.watcher.on('error', (err) => {
                this._emitError(err);
                this.watcher = null;
            });
        } catch (err) {
            console.error('MqlDebugLogReader: failed to create watcher:', err);
        }
    }

    _poll() {
        if (!this.isRunning) return;
        // Recreate watcher if the file appeared or watcher died
        if (!this.watcher && fs.existsSync(this.filePath)) {
            this._setupWatcher();
        }
        this._checkForNewContent();
        this.timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
    }

    _checkForNewContent() {
        if (!this.isRunning) return;
        try {
            if (!fs.existsSync(this.filePath)) return;
            const stats = fs.statSync(this.filePath);
            if (stats.size > this.lastSize) {
                this._readNewLines(stats.size);
            } else if (stats.size < this.lastSize) {
                // File was cleared/rotated
                this.lastSize = 0;
            }
        } catch (err) {
            this._emitError(err);
        }
    }

    _readNewLines(newSize) {
        try {
            const fd     = fs.openSync(this.filePath, 'r');
            const length = newSize - this.lastSize;
            const buf    = Buffer.alloc(length);
            try {
                fs.readSync(fd, buf, 0, length, this.lastSize);
            } finally {
                fs.closeSync(fd);
            }
            this.lastSize = newSize;

            // MqlDebug.mqh writes UTF-8 bytes despite using the FILE_ANSI flag (which normally implies ANSI/CP1252).
            const text   = buf.toString('utf8');
            const lines  = text.split(/\r?\n/);
            const events = [];
            for (const line of lines) {
                if (line.startsWith('DBG|')) {
                    const evt = this._parseLine(line);
                    if (evt) events.push(evt);
                }
            }
            // Deliver all events in this chunk as one batch so the store
            // notifies listeners only once instead of once per line.
            if (events.length > 0 && this.onBatch) {
                this.onBatch(events);
            } else if (events.length > 0 && this.onEvent) {
                for (const evt of events) this.onEvent(evt);
            }
        } catch (err) {
            this._emitError(err);
        }
    }

    /**
     * Parse a structured DBG| line into a DebugEvent object.
     *
     * @param {string} line
     * @returns {DebugEvent|null}
     *
     * @typedef {Object} DebugEvent
     * @property {'watch'|'break'|'enter'|'exit'} type
     * @property {string} timestamp
     * @property {string} file        Source file (from __FILE__)
     * @property {string} func        Function name (from __FUNCTION__)
     * @property {number} line        Source line (from __LINE__)
     * @property {string} [varName]   Variable name (watch events)
     * @property {string} [varType]   Variable type (watch events)
     * @property {string} [value]     Variable value as string (watch events)
     * @property {string} [label]     Breakpoint label (break events)
     */
    _parseLine(line) {
        // DBG|ts|file|func|lineno|KIND[|...]
        const parts = line.split('|');
        if (parts.length < 6) return null;

        const [, ts, file, func, lineStr, kind, ...rest] = parts;
        const lineNo = parseInt(lineStr, 10);
        if (isNaN(lineNo)) return null;

        const base = { timestamp: ts, file, func, line: lineNo };

        switch (kind) {
            case 'WATCH': {
                if (rest.length < 3) return null;
                const [varName, varType, ...valueParts] = rest;
                // Value may contain '|' characters (e.g. strings with pipes)
                return { type: 'watch', ...base, varName, varType, value: valueParts.join('|') };
            }
            case 'BREAK': {
                return { type: 'break', ...base, label: rest[0] || '' };
            }
            case 'ENTER': {
                return { type: 'enter', ...base };
            }
            case 'EXIT': {
                return { type: 'exit', ...base };
            }
            default:
                return null;
        }
    }

    _emitError(err) {
        if (this.onError) this.onError(err);
        else console.error('MqlDebugLogReader error:', err);
    }
}

module.exports = { MqlDebugLogReader };
