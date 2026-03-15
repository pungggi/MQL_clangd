'use strict';
const fs = require('fs');
const path = require('path');

// Injected at the top of every instrumented file (after #property directives)
const INCLUDE_LINE = '#include <MqlDebug.mqh>';

/**
 * A simple line-classification state machine for MQL5 source.
 * Determines whether a given line is safe to inject a macro after.
 */
class MqlLineClassifier {
    constructor() {
        this._inBlockComment = false;
    }

    /**
     * Classify a source line.
     * @param {string} line
     * @returns {'preprocessor'|'comment'|'blank'|'open_brace'|'code'}
     */
    classify(line) {
        const trimmed = line.trimStart();

        // Update block-comment state first
        if (this._inBlockComment) {
            if (trimmed.includes('*/')) {
                this._inBlockComment = false;
            }
            return 'comment';
        }

        if (trimmed === '') return 'blank';
        if (trimmed.startsWith('//')) return 'comment';
        if (trimmed.startsWith('/*')) {
            if (!trimmed.includes('*/')) this._inBlockComment = true;
            return 'comment';
        }
        if (trimmed.startsWith('#')) return 'preprocessor';
        if (trimmed.endsWith('\\')) return 'preprocessor'; // multi-line macro continuation

        // Line that opens a block without closing it — injecting after this is risky
        const openBraces = (trimmed.match(/\{/g) || []).length;
        const closeBraces = (trimmed.match(/\}/g) || []).length;
        if (openBraces > closeBraces) return 'open_brace';

        return 'code';
    }

    reset() { this._inBlockComment = false; }
}

/**
 * Find the first line at or after `targetLine` (1-based) that ends a complete
 * statement (ends with `;` or `}`) and is not a comment/preprocessor.
 *
 * @param {string[]} lines  Array of source lines (0-based index)
 * @param {number}   targetLine  1-based line number from VS Code breakpoint
 * @returns {number|null}  0-based index of the injection point (line AFTER which to insert),
 *                         or null if no safe point found within the search window.
 */
function findInjectionPoint(lines, targetLine) {
    const classifier = new MqlLineClassifier();

    // Pre-scan to build correct block-comment state up to the target line
    for (let i = 0; i < Math.min(targetLine - 1, lines.length); i++) {
        classifier.classify(lines[i]);
    }

    // Search forward from the target line (up to 10 lines) for a safe injection point
    const searchLimit = Math.min(targetLine - 1 + 10, lines.length);
    for (let i = targetLine - 1; i < searchLimit; i++) {
        const line = lines[i];
        const kind = classifier.classify(line);
        if (kind === 'comment' || kind === 'blank' || kind === 'preprocessor') continue;

        const trimmed = line.trimEnd();
        if (trimmed.endsWith(';') || trimmed.endsWith('{') || trimmed.endsWith('}')) {
            return i; // Inject AFTER this line (i is 0-based)
        }
    }

    return null;
}

/**
 * Parse `// @watch varName` annotations from lines around the breakpoint.
 * Searches up to 5 lines before and 2 lines after the breakpoint line.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based breakpoint line
 * @returns {string[]}  Variable names to watch
 */
function parseWatchAnnotations(lines, bpLine) {
    const RE_WATCH = /\/\/\s*@watch\s+(\w+)/;
    const vars = [];
    const from = Math.max(0, bpLine - 6);
    const to   = Math.min(lines.length - 1, bpLine + 1);

    for (let i = from; i <= to; i++) {
        const m = lines[i].match(RE_WATCH);
        if (m) vars.push(m[1]);
    }
    return vars;
}

/**
 * Generate the macro injection lines for one breakpoint.
 *
 * @param {string}   label     Breakpoint label (e.g. "bp_42")
 * @param {string[]} watchVars Variable names from @watch annotations
 * @param {string}   condition Optional condition string (may be empty)
 * @returns {string[]}  Lines to insert
 */
function buildInjectionLines(label, watchVars, condition) {
    const breakLine = `MQL_DBG_BREAK("${label}");`;
    const watchLines = watchVars.map(v =>
        `MQL_DBG_WATCH("${v}", ${v});`
    );

    const body = [breakLine, ...watchLines].join('\n  ');

    if (condition && condition.trim()) {
        return [`if (${condition}) { ${body} }`];
    }
    return [breakLine, ...watchLines];
}

/**
 * Insert the MqlDebug.mqh include into the source lines (after the last
 * #property directive block, or at the very top if none found).
 *
 * @param {string[]} lines  Source lines (mutated in place)
 */
function ensureInclude(lines) {
    // Already included?
    if (lines.some(l => l.includes('MqlDebug.mqh'))) return;

    // Find insertion point: after last consecutive #property or // comment at top
    let insertAt = 0;
    for (let i = 0; i < Math.min(30, lines.length); i++) {
        const t = lines[i].trimStart();
        if (t.startsWith('#property') || t.startsWith('//') || t === '') {
            insertAt = i + 1;
        } else if (t.startsWith('#include') || t.startsWith('#define')) {
            // Insert before other includes/defines if no properties found
            break;
        } else {
            break;
        }
    }

    lines.splice(insertAt, 0, INCLUDE_LINE);
}

/**
 * Instrument a source file for debugging.
 *
 * @param {string}   sourcePath   Absolute path to the original .mq5/.mq4 file
 * @param {Array<{line: number, condition?: string}>} breakpoints
 *   Array of VS Code breakpoints with 1-based line numbers
 * @returns {{ tempPath: string, restore: () => void, skipped: number[] }}
 *   tempPath  - path to the instrumented copy to compile
 *   restore() - deletes the temp file
 *   skipped   - 1-based line numbers for which no injection point was found
 */
function instrumentSource(sourcePath, breakpoints) {
    const ext  = path.extname(sourcePath);         // .mq5 or .mq4
    const base = path.basename(sourcePath, ext);
    const dir  = path.dirname(sourcePath);
    const tempPath = path.join(dir, `${base}.mql_dbg_build${ext}`);

    const raw   = fs.readFileSync(sourcePath);
    // Detect BOM (UTF-16LE) and decode accordingly — same logic as logTailer
    let content;
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
        content = raw.toString('utf16le');
    } else {
        content = raw.toString('utf8').replace(/^\uFEFF/, '');
    }

    const lines  = content.split(/\r?\n/);
    const skipped = [];

    // Collect all injection points: { afterLine0Based, injectionLines[] }
    // Process in reverse order so insertions don't shift earlier line numbers.
    const injections = [];

    for (const bp of breakpoints) {
        const injPoint = findInjectionPoint(lines, bp.line);
        if (injPoint === null) {
            skipped.push(bp.line);
            continue;
        }
        const watchVars = parseWatchAnnotations(lines, bp.line);
        const label = `bp_${bp.line}`;
        const macroLines = buildInjectionLines(label, watchVars, bp.condition || '');
        injections.push({ afterLine: injPoint, macroLines });
    }

    // Sort descending so we inject from bottom to top (preserves line numbers)
    injections.sort((a, b) => b.afterLine - a.afterLine);

    for (const { afterLine, macroLines } of injections) {
        lines.splice(afterLine + 1, 0, ...macroLines);
    }

    // Ensure MqlDebug.mqh is included
    ensureInclude(lines);

    // Write temp file as UTF-8 (MetaEditor accepts UTF-8 for .mq5)
    fs.writeFileSync(tempPath, lines.join('\n'), 'utf8');

    const restore = () => {
        try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
    };

    return { tempPath, restore, skipped };
}

module.exports = { instrumentSource };
