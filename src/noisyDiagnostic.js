'use strict';

/**
 * "MQL: Report Noisy Diagnostic"
 *
 * Takes the diagnostic under the cursor and either
 *  - suppresses its clangd flag in the workspace `.clangd` file
 *    (`Diagnostics.Suppress`), or
 *  - copies a ready-to-paste report block for a GitHub issue.
 *
 * The pure helpers (`extractDiagnosticCode`, `pickDiagnosticAt`,
 * `buildReportText`, `insertSuppression`) are exported so they can be unit
 * tested without a VS Code host.
 */

const vscode = require('vscode');
const fs = require('fs');
const pathModule = require('path');

const MQL_EXTENSIONS = ['.mq4', '.mq5', '.mqh'];

// vscode-clangd publishes its diagnostics with source "clang". "clangd" and
// "clang-tidy" are accepted as well so the command keeps working if the
// language client changes the label.
const CLANGD_SOURCES = new Set(['clang', 'clangd', 'clang-tidy', 'clangtidy']);

const SEVERITY_NAMES = ['error', 'warning', 'information', 'hint'];

const SUPPRESS_ITEM_RE = /^([ \t]*)-[ \t]+(\S.*)$/;

/**
 * Returns the clangd diagnostic code (the value clangd's `Diagnostics.Suppress`
 * accepts, e.g. `unknown_type` or `-Wunused-result`), or an empty string.
 * @param {object} diagnostic
 * @returns {string}
 */
function extractDiagnosticCode(diagnostic) {
    if (!diagnostic || diagnostic.code === undefined || diagnostic.code === null) return '';
    const raw = diagnostic.code;
    const code = typeof raw === 'string' ? raw : (raw && typeof raw.value === 'string' ? raw.value : '');
    return String(code || '').trim();
}

/**
 * True when the diagnostic looks like it came from clangd. Only those can be
 * suppressed through `.clangd`; MetaEditor diagnostics have no clangd flag.
 * @param {object} diagnostic
 * @returns {boolean}
 */
function isClangdDiagnostic(diagnostic) {
    if (!diagnostic) return false;
    const source = String(diagnostic.source || '').toLowerCase().trim();
    return CLANGD_SOURCES.has(source);
}

/**
 * Picks the diagnostic that covers `position`, preferring clangd-sourced ones.
 * @param {Array<object>} diagnostics
 * @param {{line: number, character: number}} position
 * @returns {object|undefined}
 */
function pickDiagnosticAt(diagnostics, position) {
    if (!Array.isArray(diagnostics) || !position) return undefined;
    const covering = diagnostics.filter((diagnostic) => {
        if (!diagnostic || !diagnostic.range) return false;
        try {
            return diagnostic.range.contains(position);
        } catch {
            return false;
        }
    });
    if (covering.length === 0) return undefined;
    return covering.find(isClangdDiagnostic) || covering[0];
}

/**
 * @param {number} severity - vscode.DiagnosticSeverity value
 * @returns {string}
 */
function severityName(severity) {
    return SEVERITY_NAMES[severity] || 'unknown';
}

/**
 * Basename that also works for Windows paths on non-Windows hosts.
 * @param {string} fileName
 * @returns {string}
 */
function baseName(fileName) {
    const parts = String(fileName || '').split(/[\\/]/);
    return parts[parts.length - 1] || 'unknown';
}

/**
 * Reads (and trims) one source line, tolerating a minimal document stub.
 * @param {object} document
 * @param {number} line
 * @returns {string}
 */
function readSourceLine(document, line) {
    try {
        if (document && typeof document.lineAt === 'function') {
            return String(document.lineAt(line).text || '').trim();
        }
    } catch {
        /* line out of range — no snippet in the report */
    }
    return '';
}

/**
 * Builds a copy-pasteable report block for a GitHub issue.
 * @param {object} diagnostic
 * @param {object} document
 * @param {{extensionVersion?: string, vscodeVersion?: string}} [meta]
 * @returns {string}
 */
function buildReportText(diagnostic, document, meta = {}) {
    const range = (diagnostic && diagnostic.range) || { start: { line: 0, character: 0 } };
    const line = range.start.line || 0;
    const column = (range.start.character || 0) + 1;

    const lines = [
        '### Noisy MQL diagnostic report',
        '',
        `- File: \`${baseName(document && document.fileName)}\` line ${line + 1}, column ${column}`,
        `- Source: ${(diagnostic && diagnostic.source) || '(unknown)'}`,
        `- Code: ${extractDiagnosticCode(diagnostic) || '(none)'}`,
        `- Severity: ${severityName(diagnostic && diagnostic.severity)}`,
        `- Message: ${(diagnostic && diagnostic.message) || '(none)'}`,
    ];
    if (meta.extensionVersion) lines.push(`- MQL Clangd: ${meta.extensionVersion}`);
    if (meta.vscodeVersion) lines.push(`- VS Code: ${meta.vscodeVersion}`);

    const sourceLine = readSourceLine(document, line);
    if (sourceLine) lines.push('', '```mql', sourceLine, '```');

    return lines.join('\n');
}

/**
 * Normalises a suppression entry for comparison (drops quotes and comments).
 * @param {string} value
 * @returns {string}
 */
function normalizeSuppression(value) {
    return String(value || '')
        .split('#')[0]
        .trim()
        .replace(/^["']/, '')
        .replace(/["']$/, '')
        .trim();
}

/**
 * Inserts one flag into the `Diagnostics.Suppress` list of a `.clangd` file
 * without touching anything else in the document.
 *
 * Handles: existing block list, flow list (`Suppress: [a, b]`), a `Diagnostics:`
 * block without `Suppress:`, a file without `Diagnostics:`, and an empty/new
 * file. Existing indentation and line endings are preserved.
 *
 * @param {string} clangdText - current `.clangd` content ('' when missing)
 * @param {string} flag - diagnostic code to suppress
 * @returns {{text: string, added: boolean, alreadyPresent: boolean}}
 */
function insertSuppression(clangdText, flag) {
    const original = typeof clangdText === 'string' ? clangdText : '';
    const wanted = normalizeSuppression(flag);
    if (!wanted) return { text: original, added: false, alreadyPresent: false };

    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);
    const isIndented = (line) => /^[ \t]/.test(line);

    // 1. Locate the top-level `Diagnostics:` block.
    const diagnosticsIdx = lines.findIndex((line) => /^Diagnostics:[ \t]*(?:#.*)?$/.test(line));
    if (diagnosticsIdx === -1) {
        const block = ['Diagnostics:', '  Suppress:', `    - ${wanted}`];
        const prefix = original.trim() === '' ? '' : original.replace(/\s*$/, eol);
        return { text: prefix + block.join(eol) + eol, added: true, alreadyPresent: false };
    }

    // The block ends at the next top-level key (or end of file).
    let blockEnd = lines.length;
    for (let i = diagnosticsIdx + 1; i < lines.length; i++) {
        if (lines[i].trim() !== '' && !isIndented(lines[i])) {
            blockEnd = i;
            break;
        }
    }

    // 2. Find `Suppress:` inside that block.
    for (let i = diagnosticsIdx + 1; i < blockEnd; i++) {
        const suppressMatch = /^([ \t]*)Suppress:[ \t]*(.*)$/.exec(lines[i]);
        if (!suppressMatch) continue;

        const keyIndent = suppressMatch[1];
        const inlineValue = suppressMatch[2].trim();

        // 2a. Flow style list: `Suppress: [a, b]` → rewrite as a block list.
        if (inlineValue.startsWith('[')) {
            const existing = inlineValue
                .replace(/^\[/, '')
                .replace(/\]\s*(?:#.*)?$/, '')
                .split(',')
                .map((value) => normalizeSuppression(value))
                .filter(Boolean);
            if (existing.includes(wanted)) {
                return { text: original, added: false, alreadyPresent: true };
            }
            const itemIndent = keyIndent + '  ';
            const rewritten = [
                `${keyIndent}Suppress:`,
                ...[...existing, wanted].map((value) => `${itemIndent}- ${value}`),
            ];
            lines.splice(i, 1, ...rewritten);
            return { text: lines.join(eol), added: true, alreadyPresent: false };
        }

        // 2b. Block style list: collect the items that follow.
        let lastItemIdx = -1;
        let itemIndent = keyIndent + '  ';
        const existing = [];
        for (let j = i + 1; j < blockEnd; j++) {
            if (lines[j].trim() === '') continue; // blank line inside the list
            const itemMatch = SUPPRESS_ITEM_RE.exec(lines[j]);
            if (!itemMatch) break;
            lastItemIdx = j;
            itemIndent = itemMatch[1];
            existing.push(normalizeSuppression(itemMatch[2]));
        }
        if (existing.includes(wanted)) {
            return { text: original, added: false, alreadyPresent: true };
        }
        lines.splice(lastItemIdx === -1 ? i + 1 : lastItemIdx + 1, 0, `${itemIndent}- ${wanted}`);
        return { text: lines.join(eol), added: true, alreadyPresent: false };
    }

    // 3. `Diagnostics:` without `Suppress:` — add the list right after it.
    lines.splice(diagnosticsIdx + 1, 0, '  Suppress:', `    - ${wanted}`);
    return { text: lines.join(eol), added: true, alreadyPresent: false };
}

/**
 * Command handler for `mql_tools.reportNoisyDiagnostic`.
 * @param {import('vscode').ExtensionContext} context
 * @param {import('vscode').OutputChannel} [outputChannel]
 */
async function reportNoisyDiagnostic(context, outputChannel) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('MQL: Open an MQL file and put the cursor on the diagnostic first.');
        return;
    }

    const document = editor.document;
    const extension = pathModule.extname(document.fileName).toLowerCase();
    if (!MQL_EXTENSIONS.includes(extension)) {
        vscode.window.showWarningMessage('MQL: This command only works in .mq4, .mq5 and .mqh files.');
        return;
    }

    const position = editor.selection.active;
    const diagnostic = pickDiagnosticAt(vscode.languages.getDiagnostics(document.uri), position);
    if (!diagnostic) {
        vscode.window.showInformationMessage(
            'MQL: No diagnostic under the cursor. Place the cursor on a problem squiggle and run the command again.'
        );
        return;
    }

    const flag = extractDiagnosticCode(diagnostic);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const canSuppress = Boolean(flag) && isClangdDiagnostic(diagnostic) && Boolean(workspaceFolder);

    const items = [];
    if (canSuppress) {
        items.push({
            label: `$(circle-slash) Suppress '${flag}' for this workspace`,
            description: 'Adds the flag to Diagnostics.Suppress in .clangd and restarts clangd',
            action: 'suppress',
        });
    }
    items.push({
        label: '$(clippy) Copy diagnostic report to the clipboard',
        description: 'Ready to paste into a GitHub issue',
        action: 'copy',
    });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'MQL: Report Noisy Diagnostic',
        placeHolder: `[${diagnostic.source || 'unknown'}] ${diagnostic.message || ''}`.slice(0, 120),
    });
    if (!picked) return;

    if (picked.action === 'copy') {
        const meta = {
            extensionVersion: context && context.extension && context.extension.packageJSON
                ? context.extension.packageJSON.version
                : undefined,
            vscodeVersion: vscode.version,
        };
        await vscode.env.clipboard.writeText(buildReportText(diagnostic, document, meta));
        vscode.window.showInformationMessage('MQL: Diagnostic report copied to the clipboard.');
        return;
    }

    // Suppress the flag in the workspace .clangd file.
    const clangdPath = pathModule.join(workspaceFolder.uri.fsPath, '.clangd');
    let existing = '';
    try {
        existing = await fs.promises.readFile(clangdPath, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            vscode.window.showErrorMessage(`MQL: Could not read ${clangdPath}: ${err.message}`);
            return;
        }
    }

    const result = insertSuppression(existing, flag);
    if (result.alreadyPresent) {
        vscode.window.showInformationMessage(`MQL: '${flag}' is already suppressed in .clangd.`);
        return;
    }

    try {
        await fs.promises.writeFile(clangdPath, result.text, 'utf8');
    } catch (err) {
        vscode.window.showErrorMessage(`MQL: Could not update .clangd: ${err.message}`);
        return;
    }

    if (outputChannel) {
        outputChannel.appendLine(`[Diagnostics] Suppressed '${flag}' in ${clangdPath}`);
    }

    try {
        await vscode.commands.executeCommand('clangd.restart');
    } catch {
        // clangd extension not installed: the suppression applies on the next start anyway.
    }

    vscode.window.showInformationMessage(`MQL: Suppressed '${flag}' in .clangd — clangd is restarting.`);
}

module.exports = {
    reportNoisyDiagnostic,
    // exported for unit tests
    _test: {
        extractDiagnosticCode,
        isClangdDiagnostic,
        pickDiagnosticAt,
        buildReportText,
        insertSuppression,
        severityName,
    },
};
