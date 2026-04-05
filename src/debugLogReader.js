'use strict';
const fs = require('fs');
const path = require('path');

const MQLDEBUG_FILENAME = 'MqlDebug.txt';
const POLL_INTERVAL_MS  = 500;

/**
 * Reads MqlDebug.txt written by MqlDebug.mqh and emits parsed debug events.
 *
 * Structured line format (written by MqlDebug.mqh):
 *   DBG|{timestamp}|{file}|{function}|{line}|WATCH|{name}|{type}|{value}
 *   DBG|{timestamp}|{file}|{function}|{line}|BREAK|{label}
 *   DBG|{timestamp}|{file}|{function}|{line}|ENTER
 *   DBG|{timestamp}|{file}|{function}|{line}|EXIT
 *   DBG|{timestamp}|{file}|{function}|{line}|SESSION_END
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
        this.watcher      = null;
        this.timer        = null;
        this.renameTimer  = null;
        this._buf         = Buffer.allocUnsafe(65536);
        this._partial     = '';  // buffered incomplete trailing line

        /** Preferred: called with all events in a file chunk at once. @type {((events: DebugEvent[]) => void) | null} */
        this.onBatch     = null;
        /** Fallback: called per-event if onBatch is not set. @type {((event: DebugEvent) => void) | null} */
        this.onEvent     = null;
        /** @type {((err: Error) => void) | null} */
        this.onError     = null;
        /** @type {((msg: string) => void) | null} */
        this.onLog       = null;
    }

    _log(msg) {
        if (this.onLog) this.onLog(msg);
        console.log(`[MqlDebugLogReader] ${msg}`);
    }

    /** Start watching the debug log file. Clears the file first for a clean session. */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastSize  = 0;
        this._partial  = '';

        this._log(`start() — watching: ${this.filePath}`);

        // Ensure directory and file exist so the fs.watch watcher can be set up
        // immediately (avoids relying on slow poll fallback).
        // If file already has content from a prior session, skip it rather than
        // truncating — truncating while MT5 may still hold the handle is unsafe.
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(this.filePath)) {
                const stats = fs.statSync(this.filePath);
                this.lastSize = stats.size; // skip existing content
                this._log(`File exists, skipping ${stats.size} bytes`);
            } else {
                fs.writeFileSync(this.filePath, ''); // touch so watcher can attach
                this._log('File created (touched)');
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
        if (this.renameTimer) {
            clearTimeout(this.renameTimer);
            this.renameTimer = null;
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
                if (eventType === 'change') {
                    this._checkForNewContent();
                } else if (eventType === 'rename') {
                    // File might have been rotated or re-created
                    this.renameTimer = setTimeout(() => {
                        this.renameTimer = null;
                        if (this.isRunning) {
                            this._setupWatcher();
                            this._checkForNewContent();
                        }
                    }, 500);
                }
            });
            this.watcher.on('error', (err) => {
                this._emitError(err);
                this.watcher = null;
            });
        } catch (err) {
            this._emitError(err);
        }
    }

    _poll() {
        if (!this.isRunning) return;
        // Recreate watcher if the file appeared or watcher died
        if (!this.watcher && fs.existsSync(this.filePath)) {
            this._setupWatcher();
        }
        // Always check for new content — fs.watch on Windows can silently miss
        // change events for files written by external processes (e.g. MetaTrader).
        // The watcher is the fast path; polling is the reliable fallback.
        this._checkForNewContent();
        this.timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
    }

    /**
     * Try to read new data from lastSize position.
     * Bypasses stat entirely — just attempts to read.  If there is data
     * past lastSize, we get it; if not, readSync returns 0.
     * This avoids Windows NTFS directory-entry cache staleness issues.
     */
    _checkForNewContent() {
        if (!this.isRunning) return;
        let fd = -1;
        try {
            if (!fs.existsSync(this.filePath)) return;
            fd = fs.openSync(this.filePath, 'r');

            const BUF_SIZE = 65536;
            const buf = this._buf;
            const chunks = [];
            let totalRead = 0;

            // Read all available new data from lastSize onward
            while (true) {
                const n = fs.readSync(fd, buf, 0, BUF_SIZE, this.lastSize + totalRead);
                if (n === 0) break;
                chunks.push(Buffer.from(buf.subarray(0, n)));
                totalRead += n;
            }

            // Detect log rotation (file truncated / smaller than expected)
            if (totalRead === 0) {
                const stats = fs.fstatSync(fd);
                if (stats.size < this.lastSize) {
                    this._log(`File truncated (${this.lastSize} → ${stats.size}), resetting`);
                    this.lastSize = 0;
                }
            }

            fs.closeSync(fd);
            fd = -1;

            if (totalRead > 0) {
                this.lastSize += totalRead;
                const text = this._partial + Buffer.concat(chunks).toString('utf8');
                const lines = text.split(/\r?\n/);
                // If the chunk doesn't end with a newline, the last element is
                // an incomplete line — buffer it for the next read.
                if (!text.endsWith('\n') && !text.endsWith('\r\n')) {
                    this._partial = lines.pop();
                } else {
                    this._partial = '';
                }
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
            }
        } catch (err) {
            if (fd >= 0) try { fs.closeSync(fd); } catch { /* ignore */ }
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
     * @property {'watch'|'break'|'enter'|'exit'|'session_end'} type
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
            case 'LOG': {
                // LOG message may contain '|' — rejoin remaining parts
                return { type: 'log', ...base, message: rest.join('|') };
            }
            case 'SESSION_END': {
                return { type: 'session_end', ...base };
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
