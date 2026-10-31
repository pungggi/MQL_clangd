'use strict';

// Central logger for the extension. All src modules log through this module
// instead of console.* so that messages land in the visible "MQL" output
// channel (what users can actually find) instead of the hidden devtools
// console. Warnings and errors are still mirrored to the devtools console,
// where extension authors look when debugging.
//
// Until initLogger() is called with the extension's output channel, messages
// fall back to plain console output. That keeps unit tests and the earliest
// activation phase working without a channel.

let outputChannel = null;

const PREFIX = {
    error: '[Error]',
    warn: '[Warn]',
    info: '[Info]',
    debug: '[Debug]',
};

/**
 * Bind the logger to the extension's output channel. Safe to call once during
 * activation; passing undefined/null resets the fallback behaviour (used by
 * tests).
 */
function initLogger(channel) {
    outputChannel = channel || null;
}

/** Format one argument the way console would (Errors with stack, objects as JSON). */
function formatArg(arg) {
    if (arg instanceof Error) {
        return arg.stack || arg.message;
    }
    if (typeof arg === 'string') {
        return arg;
    }
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

function write(level, args) {
    const message = `${PREFIX[level] || ''} ${args.map(formatArg).join(' ')}`.trim();
    if (outputChannel) {
        outputChannel.appendLine(message);
        if (level === 'error') {
            console.error(message);
        } else if (level === 'warn') {
            console.warn(message);
        }
    } else if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }
}

module.exports = {
    initLogger,
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    log: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
};
