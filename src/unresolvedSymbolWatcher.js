'use strict';

/**
 * On-save scan that surfaces call-sites the clangd index cannot resolve.
 * Emits a visible wavy underline (TextEditorDecoration) plus a Hint-severity
 * Diagnostic so Quick Fix can offer one-click recovery actions without
 * cluttering the Problems panel.
 */

const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');

const { extractTopLevelFunctionDefs, maskCommentsAndStrings } = require('./createProperties');

const DIAG_SOURCE = 'mql-clangd-unresolved';
const ALLOWLIST_TTL_MS = 10_000;
const PROBE_CONCURRENCY = 8;

const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'goto', 'sizeof', 'typeof',
    'new', 'delete', 'true', 'false', 'NULL',
    'class', 'struct', 'enum', 'union', 'typedef', 'template',
    'public', 'private', 'protected', 'virtual', 'static', 'const',
    'extern', 'inline', 'friend', 'operator',
    'this', 'super', 'void', 'int', 'uint', 'long', 'ulong', 'short',
    'ushort', 'char', 'uchar', 'double', 'float', 'string', 'bool',
    'datetime', 'color', 'input', 'sinput', 'group', 'try', 'catch', 'throw'
]);

// =============================================================================
// MQL stdlib builtins — loaded once from items.json, cached at module scope.
// =============================================================================

let _builtinsCache = null;

function getBuiltins() {
    if (_builtinsCache) return _builtinsCache;
    try {
        const items = require('../data/items.json');
        _builtinsCache = new Set(Object.keys(items));
    } catch {
        _builtinsCache = new Set();
    }
    return _builtinsCache;
}

// =============================================================================
// Include allowlist — names declared in workspace Include/ tree.
// Cached with TTL to avoid re-stat-ing hundreds of headers on every save.
// =============================================================================

let _includeCache = null;

function listMqhFiles(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = pathModule.join(dir, e.name);
        if (e.isDirectory()) {
            listMqhFiles(full, out);
        } else if (e.isFile() && /\.mqh$/i.test(e.name)) {
            out.push(full);
        }
    }
}

function buildIncludeAllowlist(includeDir) {
    if (!includeDir || !fs.existsSync(includeDir)) {
        return { names: new Set(), signature: '' };
    }
    const files = [];
    listMqhFiles(includeDir, files);
    let signature = '';
    const names = new Set();
    for (const f of files) {
        let st;
        try { st = fs.statSync(f); } catch { continue; }
        signature += `${f}:${st.mtimeMs};`;
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        try {
            const defs = extractTopLevelFunctionDefs(text);
            for (const d of defs) names.add(d.name);
        } catch { /* parser error — skip file */ }
        const masked = maskCommentsAndStrings(text);
        const declRegex = /\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g;
        let m;
        while ((m = declRegex.exec(masked)) !== null) {
            const nm = m[1];
            if (!KEYWORDS.has(nm)) names.add(nm);
        }
        const classRegex = /\b(?:class|struct|enum)\s+([A-Za-z_]\w*)/g;
        while ((m = classRegex.exec(masked)) !== null) {
            names.add(m[1]);
        }
        const defineRegex = /^\s*#define\s+([A-Za-z_]\w*)/gm;
        while ((m = defineRegex.exec(masked)) !== null) {
            names.add(m[1]);
        }
    }
    return { names, signature };
}

function getIncludeAllowlist(includeDir) {
    if (!includeDir) return new Set();
    const now = Date.now();
    if (_includeCache && _includeCache.dir === includeDir) {
        // Within TTL: trust cache without re-stat.
        if (now - _includeCache.builtAt < ALLOWLIST_TTL_MS) {
            return _includeCache.names;
        }
        // Past TTL: cheap signature compare before rebuild.
        const files = [];
        listMqhFiles(includeDir, files);
        let dirty = false;
        let sig = '';
        for (const f of files) {
            let st;
            try { st = fs.statSync(f); } catch { dirty = true; break; }
            sig += `${f}:${st.mtimeMs};`;
        }
        if (!dirty && sig === _includeCache.signature) {
            _includeCache.builtAt = now;
            return _includeCache.names;
        }
    }
    const { names, signature } = buildIncludeAllowlist(includeDir);
    _includeCache = { dir: includeDir, names, signature, builtAt: now };
    return names;
}

function clearIncludeCache() {
    _includeCache = null;
}

// =============================================================================
// Call-site scanning
// =============================================================================

function findCallSiteOffsets(text) {
    const masked = maskCommentsAndStrings(text);
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    const sites = [];
    let m;
    while ((m = re.exec(masked)) !== null) {
        const name = m[1];
        if (KEYWORDS.has(name)) continue;
        sites.push({ name, start: m.index, end: m.index + name.length });
    }
    return sites;
}

function scanCallSites(document) {
    const offsets = findCallSiteOffsets(document.getText());
    return offsets.map(s => ({
        name: s.name,
        range: new vscode.Range(document.positionAt(s.start), document.positionAt(s.end))
    }));
}

// =============================================================================
// Definition probe — query clangd LSP directly when its extension is loaded.
// Fall back to vscode.executeDefinitionProvider, but treat results that only
// land in the same document as a likely textual fallback (= miss).
// =============================================================================

let _clangdClient = null;
let _clangdResolved = false;

async function getClangdClient() {
    if (_clangdResolved) return _clangdClient;
    _clangdResolved = true;
    try {
        const ext = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
        if (!ext) return null;
        if (!ext.isActive) await ext.activate();
        const api = ext.exports;
        if (!api) return null;
        // clangd extension exposes either `languageClient` or `getApi(...)`.
        const client = api.languageClient || (typeof api.getApi === 'function' ? api.getApi(1).languageClient : null);
        _clangdClient = client || null;
    } catch {
        _clangdClient = null;
    }
    return _clangdClient;
}

function rangeContainsPosition(range, pos) {
    if (!range || !pos) return false;
    const startLine = range.start.line, endLine = range.end.line;
    if (pos.line < startLine || pos.line > endLine) return false;
    if (pos.line === startLine && pos.character < range.start.character) return false;
    if (pos.line === endLine && pos.character > range.end.character) return false;
    return true;
}

async function probeDefinition(document, position) {
    // Preferred path: ask clangd directly. Empty array = unresolved.
    const client = await getClangdClient();
    if (client && typeof client.sendRequest === 'function') {
        try {
            const params = {
                textDocument: { uri: document.uri.toString() },
                position: { line: position.line, character: position.character }
            };
            const res = await client.sendRequest('textDocument/definition', params);
            if (!res) return { resolved: false, reason: 'clangd-null' };
            const arr = Array.isArray(res) ? res : [res];
            if (arr.length === 0) return { resolved: false, reason: 'clangd-empty' };
            return { resolved: true };
        } catch {
            // Fall through to provider API on transport error.
        }
    }

    // Fallback: aggregated provider result. Treat "only result is current doc
    // AND the probe position sits inside that same range" as a textual fallback.
    let result;
    try {
        result = await vscode.commands.executeCommand(
            'vscode.executeDefinitionProvider',
            document.uri,
            position
        );
    } catch {
        return { resolved: false, reason: 'provider-error' };
    }
    if (!result || result.length === 0) {
        return { resolved: false, reason: 'empty' };
    }
    const docUri = document.uri.toString();
    const realHits = result.filter(loc => {
        const uri = (loc && loc.uri && loc.uri.toString()) || (loc && loc.targetUri && loc.targetUri.toString());
        if (!uri) return false;
        if (uri !== docUri) return true;
        const range = loc.range || loc.targetSelectionRange || loc.targetRange;
        // Same-doc hit that contains the probe position is the call-site itself
        // or a textual fallback to the very token we typed — not a real def.
        return !rangeContainsPosition(range, position);
    });
    if (realHits.length === 0) {
        return { resolved: false, reason: 'self-only' };
    }
    return { resolved: true };
}

// =============================================================================
// Watcher activation
// =============================================================================

let decorationType = null;
let diagnosticCollection = null;
const inFlight = new Map();

function activate(context, getIncludeDir) {
    // Defensive: reset module-scoped state on re-entry (Reload Window keeps the
    // module cache alive but creates a fresh ExtensionContext).
    if (decorationType) {
        try { decorationType.dispose(); } catch { /* ignore */ }
    }
    inFlight.clear();
    decorationType = vscode.window.createTextEditorDecorationType({
        textDecoration: 'underline wavy var(--vscode-editorWarning-foreground)'
    });
    diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(decorationType);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (!isMqlDoc(doc)) return;
            scheduleScan(doc, getIncludeDir);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            diagnosticCollection.delete(doc.uri);
            for (const ed of vscode.window.visibleTextEditors) {
                if (ed.document.uri.toString() === doc.uri.toString()) {
                    ed.setDecorations(decorationType, []);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            [{ language: 'mql5' }, { language: 'mql4' }, { pattern: '**/*.{mq4,mq5,mqh}' }],
            new UnresolvedCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );
}

function isMqlDoc(doc) {
    return /\.(mq4|mq5|mqh)$/i.test(doc.fileName);
}

function scheduleScan(doc, getIncludeDir) {
    const key = doc.uri.toString();
    const token = { canceled: false };
    const prev = inFlight.get(key);
    if (prev) prev.canceled = true;
    inFlight.set(key, token);

    runScan(doc, token, getIncludeDir).catch((err) => {
        console.error('MQL unresolved scan failed:', err);
    });
}

async function runScan(doc, token, getIncludeDir) {
    const sites = scanCallSites(doc);
    if (token.canceled) return;

    const localSymbols = collectLocalNames(doc);
    const includeDir = typeof getIncludeDir === 'function' ? getIncludeDir(doc) : null;
    const includeAllow = getIncludeAllowlist(includeDir);
    const mqlBuiltins = getBuiltins();

    // Canary probe: ask clangd to locate the *first defined local function*. If
    // clangd has no answer for a symbol that demonstrably exists in this file,
    // the whole TU is dark to clangd (missing compile_commands entry, parse
    // failure, etc.) — emit a file-level diagnostic so the user sees a
    // lightbulb anywhere in the file, not only at unresolved call sites.
    const canary = await probeCanary(doc, token);
    if (token.canceled) return;
    if (canary && canary.dark) {
        const range = new vscode.Range(0, 0, 0, 0);
        const diag = new vscode.Diagnostic(
            range,
            `clangd cannot resolve any symbol in this file. The file may be missing from compile_commands.json or clangd failed to parse it.`,
            vscode.DiagnosticSeverity.Hint
        );
        diag.source = DIAG_SOURCE;
        diag.code = 'file-clangd-dark';
        diagnosticCollection.set(doc.uri, [diag]);
        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document.uri.toString() === doc.uri.toString()) {
                ed.setDecorations(decorationType, [range]);
            }
        }
        return;
    }

    const candidates = sites.filter(s =>
        !localSymbols.has(s.name) &&
        !includeAllow.has(s.name) &&
        !mqlBuiltins.has(s.name)
    );

    // Dedup per-name to probe each symbol at most once per save.
    const byName = new Map();
    for (const s of candidates) {
        if (!byName.has(s.name)) byName.set(s.name, []);
        byName.get(s.name).push(s);
    }

    const probeResults = await mapWithConcurrency(
        Array.from(byName.entries()),
        PROBE_CONCURRENCY,
        async ([name, occurrences]) => {
            if (token.canceled) return null;
            const probe = await probeDefinition(doc, occurrences[0].range.start);
            return { name, occurrences, probe };
        }
    );
    if (token.canceled) return;

    const unresolvedRanges = [];
    const diagnostics = [];
    for (const r of probeResults) {
        if (!r || r.probe.resolved) continue;
        for (const occ of r.occurrences) {
            unresolvedRanges.push(occ.range);
            const diag = new vscode.Diagnostic(
                occ.range,
                `clangd has no definition for '${r.name}'. Header may be parsed outside its compile target.`,
                vscode.DiagnosticSeverity.Hint
            );
            diag.source = DIAG_SOURCE;
            diag.code = 'unresolved-symbol';
            diagnostics.push(diag);
        }
    }

    if (token.canceled) return;
    diagnosticCollection.set(doc.uri, diagnostics);
    for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === doc.uri.toString()) {
            ed.setDecorations(decorationType, unresolvedRanges);
        }
    }
}

async function probeCanary(doc, token) {
    // Find a local function definition we can ask clangd about. If clangd
    // returns nothing for it, the whole file is dark to clangd.
    const text = doc.getText();
    let defs;
    try { defs = extractTopLevelFunctionDefs(text); } catch { defs = []; }
    if (!defs || defs.length === 0) return null;

    // Probe up to 3 distinct defs to avoid a false dark signal from a single
    // odd parse mismatch.
    const targets = defs.slice(0, 3);
    let anyResolved = false;
    for (const d of targets) {
        if (token.canceled) return null;
        // Find the symbol's identifier position in the source text.
        const masked = maskCommentsAndStrings(text);
        const re = new RegExp(`\\b${escapeRegExp(d.name)}\\s*\\(`, 'g');
        let m, pos = null;
        while ((m = re.exec(masked)) !== null) {
            // Skip call-sites — accept the first that looks like a definition
            // (preceded on the line by a type token, no `;` immediately after `)`).
            const before = masked.slice(Math.max(0, m.index - 60), m.index);
            if (/\b(void|int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color)\s+$/.test(before)) {
                pos = doc.positionAt(m.index);
                break;
            }
        }
        if (!pos) continue;
        const probe = await probeDefinition(doc, pos);
        if (token.canceled) return null;
        if (probe.resolved) {
            anyResolved = true;
            break;
        }
    }
    return { dark: !anyResolved };
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]);
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return out;
}

function collectLocalNamesFromText(rawText) {
    const text = maskCommentsAndStrings(rawText);
    const names = new Set();
    const defs = extractTopLevelFunctionDefs(text);
    for (const d of defs) names.add(d.name);
    const classRegex = /\b(?:class|struct|enum)\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = classRegex.exec(text)) !== null) names.add(m[1]);
    const defineRegex = /^\s*#define\s+([A-Za-z_]\w*)/gm;
    while ((m = defineRegex.exec(text)) !== null) names.add(m[1]);
    // Match typed variable decls: `int foo = ...`, `double bar;`, `string baz[10]`.
    // Deliberately omit a trailing `\(` to avoid lumping function decls in here —
    // those come from extractTopLevelFunctionDefs above.
    const varRegex = /\b(?:int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color|void)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\[)/g;
    while ((m = varRegex.exec(text)) !== null) names.add(m[1]);
    return names;
}

function collectLocalNames(doc) {
    return collectLocalNamesFromText(doc.getText());
}

// =============================================================================
// CodeActionProvider
// =============================================================================

class UnresolvedCodeActionProvider {
    provideCodeActions(document, range, context) {
        const ours = context.diagnostics.filter(d => d.source === DIAG_SOURCE);
        if (ours.length === 0) return [];
        const actions = [];

        const regen = new vscode.CodeAction(
            'Regenerate MQL configuration (refresh compile_commands.json)',
            vscode.CodeActionKind.QuickFix
        );
        regen.command = {
            command: 'mql_tools.configurations',
            title: 'Regenerate MQL configuration'
        };
        regen.diagnostics = ours;
        regen.isPreferred = true;
        actions.push(regen);

        const restart = new vscode.CodeAction(
            'Restart clangd language server',
            vscode.CodeActionKind.QuickFix
        );
        restart.command = {
            command: 'clangd.restart',
            title: 'Restart clangd'
        };
        restart.diagnostics = ours;
        actions.push(restart);

        return actions;
    }
}

module.exports = {
    activate,
    scanCallSites,
    findCallSiteOffsets,
    collectLocalNames,
    collectLocalNamesFromText,
    buildIncludeAllowlist,
    getIncludeAllowlist,
    clearIncludeCache,
    getBuiltins,
    mapWithConcurrency,
    rangeContainsPosition,
    escapeRegExp,
    UnresolvedCodeActionProvider,
    KEYWORDS,
    DIAG_SOURCE,
    ALLOWLIST_TTL_MS,
    PROBE_CONCURRENCY
};
