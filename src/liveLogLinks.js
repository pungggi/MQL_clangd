'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { fromWineWindowsPath } = require('./wineHelper');

/**
 * Inline source-location tag embedded by LiveLog's Log*() macros:
 *   [LEVEL] {File:Function:Line}: message
 * `File` is the MQL `__FILE__` value (a Windows-style path on MetaEditor).
 * Captures the tag and its character span so a DocumentLink can cover it.
 */
const SRC_TAG_RE = /\{([^:}]+):([^:}]+):(\d+)\}/g;

/**
 * Resolve a `__FILE__` path emitted in a LiveLog line to a file on disk.
 *
 * Strategy (first hit wins):
 *   1. If it looks like a Windows drive path and Wine is active, convert it.
 *   2. Try the path verbatim (already a native absolute path).
 *   3. Try the basename under the tailer's resolved MQL `basePath`, searching
 *      the common EA/indicator/script subfolders.
 *   4. Try the basename under any workspace folder.
 *
 * @param {string} filePath  Raw `__FILE__` value.
 * @param {string} basePath  Tailer-resolved MQL data folder (may be '').
 * @returns {string|null} Absolute native path when found, else null.
 */
function resolveLiveLogSource(filePath, basePath) {
    if (!filePath) return null;
    const raw = String(filePath).trim();

    // 1. Wine conversion (no-op when not running under Wine / prefix empty).
    const winePath = fromWineWindowsPath(raw, getCurrentWinePrefix());
    const candidates = [winePath];
    if (winePath !== raw) candidates.push(raw);

    for (const c of candidates) {
        if (path.isAbsolute(c) && fs.existsSync(c) && fs.statSync(c).isFile()) {
            return c;
        }
    }

    // 3. Base-path relative lookup (MQL data folder + common subfolders).
    const base = String(basePath || '');
    const baseName = path.basename(raw.replace(/\\/g, '/'));
    if (baseName && base) {
        const subDirs = ['', 'Experts', 'Indicators', 'Scripts', 'Include', 'MQL5', 'MQL4',
            'MQL5/Experts', 'MQL5/Indicators', 'MQL5/Scripts', 'MQL5/Include',
            'MQL4/Experts', 'MQL4/Indicators', 'MQL4/Scripts', 'MQL4/Include'];
        for (const sub of subDirs) {
            const candidate = path.join(base, sub, baseName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
    }

    // 4. Workspace-relative basename search.
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
        const candidate = path.join(folder.uri.fsPath, baseName);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

// The Wine prefix is only known to the tailer/compile path at runtime; read it
// lazily so this module stays decoupled from extension.js. Defaults to '' (no
// conversion) when unavailable.
let _winePrefixOverride = '';
/** @param {string} prefix Override the Wine prefix used for path conversion. */
function setWinePrefix(prefix) { _winePrefixOverride = prefix || ''; }
function getCurrentWinePrefix() { return _winePrefixOverride; }

/**
 * DocumentLinkProvider for the `mql-output` language (the LiveLog tail view).
 * Turns every `{File:Function:Line}` tag into a clickable link that opens the
 * emitting source line — the call site of the Print/LogInfo/… macro.
 */
class LiveLogLinkProvider {
    /** @param {(file:string,line:number)=>{uri:vscode.Uri|null}} [resolver] for tests */
    constructor(resolver) {
        this._resolver = resolver || defaultResolve;
    }

    provideDocumentLinks(document) {
        const links = [];
        const text = document.getText();
        const lineEnds = computeLineEnds(text);
        const base = getTailerBasePath();

        SRC_TAG_RE.lastIndex = 0;
        let m;
        while ((m = SRC_TAG_RE.exec(text)) !== null) {
            const tagStart = m.index;
            const tagEnd = tagStart + m[0].length;
            const file = m[1];
            const line = parseInt(m[3], 10);

            const resolved = this._resolver(file, line, base);
            if (!resolved) continue;

            const start = offsetToPosition(tagStart, lineEnds);
            const end = offsetToPosition(tagEnd, lineEnds);
            const range = new vscode.Range(start, end);

            const link = new vscode.DocumentLink(range);
            link.target = resolved.uri;
            link.tooltip = `Open ${path.basename(file)}:${line} — ${m[2]}()`;
            links.push(link);
        }
        return links;
    }
}

/** Default resolver: returns a vscode.Uri with a #line fragment, or null. */
function defaultResolve(file, line, base) {
    const resolved = resolveLiveLogSource(file, base);
    if (!resolved) return null;
    const lineNo = Math.max(0, line - 1);
    const uri = vscode.Uri.file(resolved).with({ fragment: `${lineNo},0` });
    return { uri };
}

/** @returns {string} The tailer's resolved MQL base path, or ''. */
function getTailerBasePath() {
    try {
        const tailer = require('./logTailer');
        return (tailer && tailer.basePath) || '';
    } catch (_) {
        return '';
    }
}

function computeLineEnds(text) {
    const ends = [];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) ends.push(i);
    }
    return ends;
}

function offsetToPosition(offset, lineEnds) {
    let line = 0;
    for (let i = 0; i < lineEnds.length; i++) {
        if (offset > lineEnds[i]) line = i + 1;
        else break;
    }
    const lineStart = line === 0 ? 0 : lineEnds[line - 1] + 1;
    return new vscode.Position(line, offset - lineStart);
}

module.exports = {
    LiveLogLinkProvider,
    resolveLiveLogSource,
    SRC_TAG_RE,
    setWinePrefix
};
