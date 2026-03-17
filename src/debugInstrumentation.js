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
        let trimmed = line.trimStart();

        // Update block-comment state first
        if (this._inBlockComment) {
            const endIdx = trimmed.indexOf('*/');
            if (endIdx !== -1) {
                this._inBlockComment = false;
                const remaining = trimmed.substring(endIdx + 2).trimStart();
                if (remaining === '') return 'comment';
                return this.classify(remaining);
            }
            return 'comment';
        }

        if (trimmed === '') return 'blank';
        if (trimmed.startsWith('//')) return 'comment';
        if (trimmed.startsWith('/*')) {
            const endIdx = trimmed.indexOf('*/', 2);
            if (endIdx !== -1) {
                const remaining = trimmed.substring(endIdx + 2).trimStart();
                if (remaining === '') return 'comment';
                return this.classify(remaining);
            }
            this._inBlockComment = true;
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
 * Validate that a condition string has balanced delimiters and quotes.
 * @param {string} condition
 * @returns {boolean}
 */
function isConditionSafe(condition) {
    if (!condition || !condition.trim()) return false;
    const stack = [];
    const pairs = { '(': ')', '[': ']', '{': '}' };
    let inQuote = null;

    for (let i = 0; i < condition.length; i++) {
        const char = condition[i];
        if (inQuote) {
            if (char === inQuote) {
                let backslashCount = 0;
                for (let j = i - 1; j >= 0 && condition[j] === '\\'; j--) {
                    backslashCount++;
                }
                if (backslashCount % 2 === 0) {
                    inQuote = null;
                }
            }
            continue;
        }
        if (char === '"' || char === "'") {
            inQuote = char;
            continue;
        }
        if (pairs[char]) {
            stack.push(pairs[char]);
        } else if (char === ')' || char === ']' || char === '}') {
            if (stack.pop() !== char) return false;
        }
    }
    return stack.length === 0 && !inQuote;
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
        if (trimmed.endsWith(';') || trimmed.endsWith('}')) {
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
    const to = Math.min(lines.length - 1, bpLine + 1);

    for (let i = from; i <= to; i++) {
        const m = lines[i].match(RE_WATCH);
        if (m) vars.push(m[1]);
    }
    return vars;
}

/**
 * Sanitize a condition string for safe embedding into a single-line comment.
 * @param {string} condition
 * @returns {string}
 */
function sanitizeCondition(condition) {
    if (!condition) return "";
    // If it contains newlines or comment delimiters, use JSON encoding as a safe fallback
    const isUnsafe = /[\r\n]|\/\/|\/\*|\*\//.test(condition);
    if (!isUnsafe) return condition;

    return JSON.stringify(condition).slice(1, -1)
        .replace(/\/\//g, '/\\/')
        .replace(/\/\*/g, '/\\*')
        .replace(/\*\//g, '*\\/');
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

    if (condition && condition.trim()) {
        if (isConditionSafe(condition)) {
            const bodyLines = [breakLine, ...watchLines];
            return [`if (${condition}) {`, ...bodyLines.map(l => `  ${l}`), `}`];
        } else {
            // Fallback for malformed conditions: inject unconditional break plus a comment
            return [
                `// Invalid breakpoint condition: ${sanitizeCondition(condition)}`,
                breakLine,
                ...watchLines
            ];
        }
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
 * Resolves an include path to its absolute filesystem path.
 *
 * @param {string} incPath      Path as written in the #include directive
 * @param {string} includeBase  Absolute path to the directory doing the include
 * @param {string} mql5Root     MQL5 root directory
 * @returns {string|null}       Absolute path, or null if not found
 */
function resolveIncludePath(incPath, includeBase, mql5Root) {
    const relPath = path.join(includeBase, ...incPath.split(/[\\/]/));
    if (fs.existsSync(relPath)) return relPath;

    // Additionally check the user's custom /inc: VS Code settings
    const vscode = require('vscode');
    const config = vscode.workspace.getConfiguration('mql_tools');
    const isMql5 = (mql5Root && mql5Root.toLowerCase().includes('mql5')) || relPath.toLowerCase().includes('mql5');
    const customIncDir = isMql5 ? config.get('Metaeditor.Include5Dir') : config.get('Metaeditor.Include4Dir');
    
    if (customIncDir && fs.existsSync(customIncDir)) {
        const customPath = path.join(customIncDir, ...incPath.split(/[\\/]/));
        if (fs.existsSync(customPath)) return customPath;
    }

    if (mql5Root) {
        const extPath = path.join(mql5Root, 'Include', ...incPath.split(/[\\/]/));
        if (fs.existsSync(extPath)) return extPath;
    }
    return null;
}

/**
 * Instrument a source file and its included dependencies for debugging.
 *
 * @param {string}   entryPointPath Absolute path to the main .mq5/.mq4 file
 * @param {Map<string, Array<{line: number, condition?: string}>>} breakpointMap
 *   Map of normalized path -> array of VS Code breakpoints
 * @param {string}   mql5Root       MQL5 root directory (for resolving includes)
 * @returns {{ tempPath: string, restore: () => void, skipped: string[] }}
 */
function instrumentWorkspace(entryPointPath, breakpointMap, mql5Root) {
    const graph = new Map();

    function buildNode(filePath) {
        const normPath = filePath.toLowerCase().replace(/\\/g, '/');
        if (graph.has(normPath)) return graph.get(normPath);

        const node = {
            normPath,
            filePath,
            lines: null,
            eol: '\n',
            bps: breakpointMap.get(normPath) || [],
            includes: [], // { lineIdx, incPath, prefix, suffix, absPath }
            needsCopy: false
        };
        graph.set(normPath, node);

        if (node.bps.length > 0) {
            node.needsCopy = true;
        }

        let raw;
        try {
            raw = fs.readFileSync(filePath);
        } catch {
            return node;
        }

        let content;
        if (raw[0] === 0xFF && raw[1] === 0xFE) {
            content = raw.toString('utf16le');
        } else {
            content = raw.toString('utf8').replace(/^\uFEFF/, '');
        }

        node.eol = content.includes('\r\n') ? '\r\n' : '\n';
        node.lines = content.split(/\r?\n/);

        // Find includes
        for (let i = 0; i < node.lines.length; i++) {
            const m = node.lines[i].match(/^(\s*#include\s+["<])([^">]+)([">])/);
            if (m) {
                const incPath = m[2];
                const absPath = resolveIncludePath(incPath, path.dirname(filePath), mql5Root);
                if (absPath) {
                    node.includes.push({
                        lineIdx: i,
                        incPath,
                        prefix: m[1],
                        suffix: m[3],
                        absPath
                    });
                    buildNode(absPath);
                }
            }
        }
        return node;
    }

    // 1. Build DAG of includes
    buildNode(entryPointPath);

    // 2. Propagate needsCopy = true upstream
    let changed;
    do {
        changed = false;
        for (const node of graph.values()) {
            if (!node.needsCopy) {
                for (const inc of node.includes) {
                    const childNode = graph.get(inc.absPath.toLowerCase().replace(/\\/g, '/'));
                    if (childNode && childNode.needsCopy) {
                        node.needsCopy = true;
                        changed = true;
                        break;
                    }
                }
            }
        }
    } while (changed);

    // Entry point MUST always be copied (so we can compile it without destroying the user's .ex5)
    const entryNode = graph.get(entryPointPath.toLowerCase().replace(/\\/g, '/'));
    if (entryNode) entryNode.needsCopy = true;

    // 3. Perform copies and rewrites
    const tempFiles = [];
    const skippedArr = [];
    let entryTempPath = '';

    for (const node of graph.values()) {
        if (!node.needsCopy) continue;

        // Clean stale files in this directory before we write a new one
        const dir = path.dirname(node.filePath);
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.includes('.mql_dbg_build.')) {
                    try { fs.unlinkSync(path.join(dir, f)); } catch {}
                }
            }
        } catch {}

        // Rewrite includes that point to copied children
        for (const inc of node.includes) {
            const childNode = graph.get(inc.absPath.toLowerCase().replace(/\\/g, '/'));
            if (childNode && childNode.needsCopy) {
                const childExt = path.extname(inc.incPath);
                const childBase = inc.incPath.slice(0, -childExt.length);
                const newIncPath = `${childBase}.mql_dbg_build${childExt}`;
                node.lines[inc.lineIdx] = `#include "${newIncPath}"`;
            }
        }

        // Inject macros
        if (node.bps.length > 0) {
            const injections = [];
            for (const bp of node.bps) {
                const injPoint = findInjectionPoint(node.lines, bp.line);
                if (injPoint === null) {
                    const base = path.basename(node.filePath);
                    skippedArr.push(`${base}:${bp.line}`);
                    continue;
                }
                const watchVars = parseWatchAnnotations(node.lines, bp.line);
                const label = `bp_${path.basename(node.filePath)}_${bp.line}`;
                const macroLines = buildInjectionLines(label, watchVars, bp.condition || '');
                injections.push({ afterLine: injPoint, macroLines });
            }
            injections.sort((a, b) => b.afterLine - a.afterLine);
            for (const { afterLine, macroLines } of injections) {
                node.lines.splice(afterLine + 1, 0, ...macroLines);
            }
            ensureInclude(node.lines);
        }

        // Save
        const ext = path.extname(node.filePath);
        const base = path.basename(node.filePath, ext);
        const tempPath = path.join(dir, `${base}.mql_dbg_build${ext}`);

        if (node.filePath === entryPointPath) {
            entryTempPath = tempPath;
        }

        try {
            fs.writeFileSync(tempPath, node.lines.join(node.eol), 'utf8');
            tempFiles.push(tempPath);
        } catch (err) {
            skippedArr.push(`[Write Error: ${base}${ext}] ${err.message}`);
        }
    }

    const restore = () => {
        for (const tf of tempFiles) {
            try { fs.unlinkSync(tf); } catch {}
        }
        if (entryTempPath) {
            const ext = path.extname(entryPointPath);
            const binaryPath = entryTempPath.replace(/\.mq[45]$/i, ext.toLowerCase() === '.mq5' ? '.ex5' : '.ex4');
            try { fs.unlinkSync(binaryPath); } catch {}
        }
    };

    return { tempPath: entryTempPath, restore, skipped: skippedArr };
}

module.exports = { instrumentWorkspace };
