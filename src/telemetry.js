'use strict';

// =============================================================================
// TELEMETRY MODULE
// Anonymous usage analytics via PostHog.
//
// DEVELOPER SETUP:
//   Fill in POSTHOG_ENDPOINT and POSTHOG_API_KEY before publishing.
//   Users opt out via: Settings → mql_tools.telemetry.enabled = false
//   The global VS Code telemetry switch (telemetry.telemetryLevel) is also
//   respected automatically.
//
// DATA COLLECTED (anonymous, no PII):
//   - Extension version, VS Code version, OS platform
//   - Which commands are invoked
//   - Compile/check results: success/fail, file type (mq4/mq5/mqh), Wine mode
//   - Active feature flags at startup (Wine, lightweight diagnostics, etc.)
//
// NOT COLLECTED:
//   - File names, paths, workspace names, code content
// =============================================================================

const https = require('https');
const crypto = require('crypto');
const vscode = require('vscode');

// --- Developer constants (fill before publishing) ---
const POSTHOG_ENDPOINT = 'https://app.posthog.com/batch/'; // replace with your host
const POSTHOG_API_KEY  = 'phc_REPLACE_WITH_YOUR_KEY';

const FLUSH_INTERVAL_MS = 30_000; // send queued events every 30 s
const MAX_QUEUE_SIZE    = 50;     // send immediately when queue reaches this

let _sessionId   = null; // random UUID, generated per-session, never persisted
let _extVersion  = 'unknown';
let _queue       = [];
let _flushTimer  = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isEnabled() {
    // Respect VS Code's global telemetry level (off / error / crash / all)
    if (vscode.env.isTelemetryEnabled === false) return false;

    const cfg = vscode.workspace.getConfiguration('mql_tools');
    return cfg.get('telemetry.enabled', true);
}

function _send(batch) {
    if (!POSTHOG_API_KEY || POSTHOG_API_KEY.startsWith('phc_REPLACE')) return;

    const body = JSON.stringify({ api_key: POSTHOG_API_KEY, batch });
    let hostname, basePath;
    try {
        const u = new URL(POSTHOG_ENDPOINT);
        hostname = u.hostname;
        basePath = u.pathname;
    } catch (_) {
        return;
    }

    // Fire-and-forget: schedule after current JS turn so it never blocks
    setImmediate(() => {
        try {
            const req = https.request(
                {
                    hostname,
                    port: 443,
                    path: basePath,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body)
                    }
                },
                (res) => { res.resume(); } // drain response to free socket
            );
            req.on('error', () => {}); // silently swallow network errors
            req.write(body);
            req.end();
        } catch (_) {}
    });
}

function _flush() {
    if (_queue.length === 0) return;
    _send(_queue.splice(0)); // drain queue atomically
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise telemetry. Call once from activate().
 * @param {import('vscode').ExtensionContext} context
 */
function init(context) {
    _sessionId  = crypto.randomUUID();
    _extVersion = context.extension?.packageJSON?.version ?? 'unknown';

    // Flush on a timer; unref() so it won't keep the Node process alive
    _flushTimer = setInterval(_flush, FLUSH_INTERVAL_MS);
    if (_flushTimer.unref) _flushTimer.unref();

    // Flush remaining events when the extension deactivates
    context.subscriptions.push({ dispose: () => { clearInterval(_flushTimer); _flush(); } });
}

/**
 * Record an anonymous event. Fire-and-forget – never throws.
 * @param {string} event   PostHog event name
 * @param {Record<string,unknown>} [props]  Additional properties (no PII)
 */
function track(event, props = {}) {
    try {
        if (!_isEnabled()) return;

        _queue.push({
            event,
            distinct_id: _sessionId,
            properties: {
                ext_v:    _extVersion,
                vscode_v: vscode.version,
                platform: process.platform,
                ...props
            },
            timestamp: new Date().toISOString()
        });

        if (_queue.length >= MAX_QUEUE_SIZE) setImmediate(_flush);
    } catch (_) {}
}

module.exports = { init, track };
