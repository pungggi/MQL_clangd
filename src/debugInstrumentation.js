'use strict';
const fs = require('fs');
const path = require('path');

let vscode;
try {
    vscode = require('vscode');
} catch (e) {
    vscode = null;
}

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
 * Parse `// @watch varName [varName2 ...]` annotations from lines around the breakpoint.
 * Searches up to 5 lines before and 2 lines after the breakpoint line.
 * Supports multiple variable names on a single annotation line.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based breakpoint line
 * @returns {string[]}  Variable names to watch
 */
function parseWatchAnnotations(lines, bpLine) {
    const RE_WATCH = /\/\/\s*@watch\s+([\w\s]+)/;
    const vars = [];
    const from = Math.max(0, bpLine - 6);
    const to = Math.min(lines.length - 1, bpLine + 1);

    for (let i = from; i <= to; i++) {
        const m = lines[i].match(RE_WATCH);
        if (m) {
            const names = m[1].trim().split(/\s+/);
            for (const n of names) {
                if (n && !vars.includes(n)) vars.push(n);
            }
        }
    }
    return vars;
}

// -------------------------------------------------------------------------
// MQL5 type → watch macro mapping
// -------------------------------------------------------------------------

const MQL_TYPE_MACROS = {
    'int':      'MQL_DBG_WATCH_INT',
    'uint':     'MQL_DBG_WATCH_INT',
    'short':    'MQL_DBG_WATCH_INT',
    'ushort':   'MQL_DBG_WATCH_INT',
    'char':     'MQL_DBG_WATCH_INT',
    'uchar':    'MQL_DBG_WATCH_INT',
    'long':     'MQL_DBG_WATCH_LONG',
    'ulong':    'MQL_DBG_WATCH_LONG',
    'double':   'MQL_DBG_WATCH_DBL',
    'float':    'MQL_DBG_WATCH_DBL',
    'string':   'MQL_DBG_WATCH_STR',
    'bool':     'MQL_DBG_WATCH_BOOL',
    'datetime': 'MQL_DBG_WATCH_DATETIME',
    'color':    'MQL_DBG_WATCH_INT',
    'ENUM_TIMEFRAMES':       'MQL_DBG_WATCH_INT',
    'ENUM_ORDER_TYPE':       'MQL_DBG_WATCH_INT',
    'ENUM_POSITION_TYPE':    'MQL_DBG_WATCH_INT',
    'ENUM_DEAL_TYPE':        'MQL_DBG_WATCH_INT',
    'ENUM_TRADE_REQUEST_ACTIONS': 'MQL_DBG_WATCH_INT',
};

const MQL_ARRAY_MACROS = {
    'int':      'MQL_DBG_WATCH_ARRAY_INT',
    'uint':     'MQL_DBG_WATCH_ARRAY_INT',
    'short':    'MQL_DBG_WATCH_ARRAY_INT',
    'ushort':   'MQL_DBG_WATCH_ARRAY_INT',
    'char':     'MQL_DBG_WATCH_ARRAY_INT',
    'uchar':    'MQL_DBG_WATCH_ARRAY_INT',
    'long':     'MQL_DBG_WATCH_ARRAY_LONG',
    'ulong':    'MQL_DBG_WATCH_ARRAY_LONG',
    'double':   'MQL_DBG_WATCH_ARRAY_DBL',
    'float':    'MQL_DBG_WATCH_ARRAY_DBL',
    'string':   'MQL_DBG_WATCH_ARRAY_STR',
};

/**
 * Pick the typed macro for a given MQL5 type string.
 * Falls back to MQL_DBG_WATCH (double) for unknown types.
 * @param {string} mqlType
 * @param {boolean} [isArray=false]
 */
function macroForType(mqlType, isArray) {
    if (!mqlType) return 'MQL_DBG_WATCH';
    const key = mqlType.replace(/\b(const|static|input)\b/g, '').trim().toLowerCase();
    if (isArray) {
        return MQL_ARRAY_MACROS[key] || null; // null = skip unsupported array type
    }
    if (key.startsWith('enum_')) return 'MQL_DBG_WATCH_INT';
    return MQL_TYPE_MACROS[key] || 'MQL_DBG_WATCH';
}

// -------------------------------------------------------------------------
// Local variable discovery
// -------------------------------------------------------------------------

/**
 * Find the enclosing function body for a given line and extract local variable
 * declarations visible at that line.
 *
 * Strategy: walk backwards from bpLine to find the function opening brace,
 * then scan forward through the function body up to bpLine collecting
 * variable declarations.
 *
 * @param {string[]} lines   Source lines (0-based array)
 * @param {number}   bpLine  1-based breakpoint line
 * @returns {{ name: string, type: string }[]}
 */
function parseLocalsInScope(lines, bpLine) {
    const idx = bpLine - 1; // convert to 0-based
    if (idx < 0 || idx >= lines.length) return [];

    // Walk backwards to find the function start (opening brace at depth 0)
    let braceDepth = 0;
    let funcBodyStart = -1;
    for (let i = idx; i >= 0; i--) {
        const line = lines[i];
        // Count braces (simplified — ignores braces in strings/comments)
        for (let c = line.length - 1; c >= 0; c--) {
            if (line[c] === '}') braceDepth++;
            else if (line[c] === '{') {
                braceDepth--;
                if (braceDepth < 0) {
                    funcBodyStart = i;
                    break;
                }
            }
        }
        if (funcBodyStart >= 0) break;
    }

    if (funcBodyStart < 0) return [];

    // Also grab function parameters from the line(s) before the opening brace
    const params = parseFunctionParams(lines, funcBodyStart);

    // Scan from funcBodyStart+1 to bpLine collecting local declarations
    const locals = [];
    const seen = new Set();

    // Add params first
    for (const p of params) {
        if (!seen.has(p.name)) {
            seen.add(p.name);
            locals.push(p);
        }
    }

    // MQL5 declaration pattern: type [modifiers] name [= ...][, name2 [= ...]];
    // Matches: int x;  double y = 1.0;  string a, b;  const int z = 5;
    const RE_DECL = /^\s*(?:(?:static|const|input)\s+)*([A-Za-z_]\w*)\s+((?:[A-Za-z_]\w*(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?(?:\s*,\s*)?)+)\s*;/;
    const RE_VARNAME = /([A-Za-z_]\w*)(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?/g;

    // Skip types that are clearly not variable declarations
    const NON_TYPE_KEYWORDS = new Set([
        'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
        'break', 'continue', 'class', 'struct', 'enum', 'void', 'delete',
        'new', 'virtual', 'override', 'public', 'private', 'protected',
        'template', 'typedef', 'namespace', 'Print', 'Comment', 'Alert',
    ]);

    for (let i = funcBodyStart + 1; i <= idx && i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        // Skip comments, preprocessor, blank
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

        const m = trimmed.match(RE_DECL);
        if (!m) continue;

        const typeName = m[1];
        if (NON_TYPE_KEYWORDS.has(typeName)) continue;

        const varsPart = m[2];
        let vm;
        RE_VARNAME.lastIndex = 0;
        while ((vm = RE_VARNAME.exec(varsPart)) !== null) {
            const vName = vm[1];
            const isArray = vm[0].includes('[');
            if (!seen.has(vName) && !NON_TYPE_KEYWORDS.has(vName)) {
                seen.add(vName);
                locals.push({ name: vName, type: typeName, isArray });
            }
        }
    }

    return locals;
}

/**
 * Parse function parameters from the signature above the opening brace.
 * Looks at the lines leading up to funcBodyStart for a parenthesized param list.
 *
 * @param {string[]} lines
 * @param {number}   braceLineIdx  0-based index of the line with '{'
 * @returns {{ name: string, type: string }[]}
 */
function parseFunctionParams(lines, braceLineIdx) {
    // Collect up to 10 lines before the brace to handle multi-line signatures
    const from = Math.max(0, braceLineIdx - 10);
    let sigText = '';
    for (let i = from; i <= braceLineIdx; i++) {
        sigText += ' ' + lines[i];
    }

    // Find the last parenthesized group before '{'
    const bracePos = sigText.lastIndexOf('{');
    const parenClose = sigText.lastIndexOf(')', bracePos);
    if (parenClose < 0) return [];
    let depth = 1;
    let parenOpen = parenClose - 1;
    while (parenOpen >= 0 && depth > 0) {
        if (sigText[parenOpen] === ')') depth++;
        else if (sigText[parenOpen] === '(') depth--;
        if (depth === 0) break;
        parenOpen--;
    }
    if (depth !== 0) return [];

    const paramStr = sigText.substring(parenOpen + 1, parenClose);
    if (!paramStr.trim()) return [];

    const params = [];
    // Split by comma (simplified — doesn't handle template params with commas)
    for (const chunk of paramStr.split(',')) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        // Pattern: [const] [&] type [&] name [= default]
        const pm = trimmed.match(/(?:(?:const|static|input)\s+)*([A-Za-z_]\w*)(?:\s*&)?\s+(?:&\s*)?([A-Za-z_]\w*)/);
        if (pm) {
            params.push({ name: pm[2], type: pm[1] });
        }
    }
    return params;
}

/**
 * Sanitize a string for use as a label in MQL macros.
 * Strips or replaces anything except letters, numbers, underscore, and dash.
 * @param {string} label
 * @returns {string}
 */
function sanitizeLabel(label) {
    if (!label) return "";
    return label.replace(/[^a-zA-Z0-9_-]/g, '_');
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
 * @param {{ name: string, type?: string }[]} watchVars  Variables to watch with optional type info
 * @param {string}   condition Optional condition string (may be empty)
 * @returns {string[]}  Lines to insert
 */
function buildInjectionLines(label, watchVars, condition) {
    const breakLine = `MQL_DBG_BREAK("${label}");`;
    const watchLines = [];
    for (const v of watchVars) {
        if (v.isArray) {
            const arrMacro = macroForType(v.type, true);
            if (arrMacro) {
                watchLines.push(`${arrMacro}("${v.name}", ${v.name});`);
            }
            // Skip unsupported array types (bool[], datetime[], etc.)
        } else {
            const macro = macroForType(v.type);
            watchLines.push(`${macro}("${v.name}", ${v.name});`);
        }
    }
    const pauseLine = `MQL_DBG_PAUSE;`;

    if (condition && condition.trim()) {
        if (isConditionSafe(condition)) {
            const bodyLines = [breakLine, ...watchLines, pauseLine];
            return [`if (${condition}) {`, ...bodyLines.map(l => `  ${l}`), `}`];
        } else {
            return [
                `// Invalid breakpoint condition: ${sanitizeCondition(condition)}`,
                breakLine,
                ...watchLines,
                pauseLine
            ];
        }
    }
    return [breakLine, ...watchLines, pauseLine];
}

/**
 * Get the leading whitespace from a line.
 */
function getIndent(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1] : '';
}

/**
 * Find function boundaries in MQL5 source.
 * Returns array of { bodyStart, bodyEnd } (0-based line indices).
 *
 * Looks for patterns like:
 *   type FuncName(...) {       or
 *   void OnTick() {
 *
 * @param {string[]} lines
 * @returns {{ bodyStart: number, bodyEnd: number }[]}
 */
function findFunctionBoundaries(lines) {
    const functions = [];
    // Regex to detect a function signature line (type + name + parens)
    // Handles: void OnTick(), int Calculate(int x, double y), etc.
    const RE_FUNC_SIG = /^\s*(?:(?:static|virtual|override|const|inline)\s+)*[A-Za-z_]\w*(?:\s*[*&])?\s+[A-Za-z_]\w*\s*\(/;

    // Also match class method definitions: void CMyClass::Method(...)
    const RE_METHOD_SIG = /^\s*(?:(?:static|virtual|override|const|inline)\s+)*[A-Za-z_]\w*(?:\s*[*&])?\s+[A-Za-z_]\w*\s*::\s*[A-Za-z_~]\w*\s*\(/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!RE_FUNC_SIG.test(line) && !RE_METHOD_SIG.test(line)) continue;

        // Skip if it looks like a forward declaration (ends with ;)
        // Scan forward to find '{' (might be on next line)
        let braceIdx = -1;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
            const trimmed = lines[j].trimEnd();
            if (trimmed.endsWith(';')) break; // forward declaration or prototype
            const bracePos = lines[j].indexOf('{');
            if (bracePos >= 0) {
                braceIdx = j;
                break;
            }
        }

        if (braceIdx < 0) continue;

        // Find the matching closing brace
        let depth = 0;
        let endIdx = -1;
        for (let j = braceIdx; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        endIdx = j;
                        break;
                    }
                }
            }
            if (endIdx >= 0) break;
        }

        if (endIdx > braceIdx) {
            functions.push({ bodyStart: braceIdx, bodyEnd: endIdx });
            i = endIdx; // skip past this function
        }
    }

    return functions;
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
    if (vscode) {
        const config = vscode.workspace.getConfiguration('mql_tools');
        const isMql5 = (mql5Root && mql5Root.toLowerCase().includes('mql5')) || relPath.toLowerCase().includes('mql5');
        const customIncDir = isMql5 ? config.get('Metaeditor.Include5Dir') : config.get('Metaeditor.Include4Dir');
        
        if (customIncDir && fs.existsSync(customIncDir)) {
            const customPath = path.join(customIncDir, ...incPath.split(/[\\/]/));
            if (fs.existsSync(customPath)) return customPath;
        }
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
 * @returns {{ tempPath: string, restore: () => void, skipped: string[] }|null}
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
        } catch (err) {
            console.warn(`[debugInstrumentation] Failed to read file: ${filePath}`, err);
            node.lines = []; // Ensure node.lines is an array to prevent downstream crashes
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
    const cleanedDirs = new Set();

    for (const node of graph.values()) {
        if (!node.needsCopy) continue;

        const dir = path.dirname(node.filePath);

        // Clean stale files in this directory before we write new ones,
        // but only do it once per directory per debug session!
        if (!cleanedDirs.has(dir)) {
            cleanedDirs.add(dir);
            try {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    if (f.includes('.mql_dbg_build.')) {
                        try { fs.unlinkSync(path.join(dir, f)); } catch {}
                    }
                }
            } catch {}
        }

        // Rewrite includes that point to copied children
        for (const inc of node.includes) {
            const childNode = graph.get(inc.absPath.toLowerCase().replace(/\\/g, '/'));
            if (childNode && childNode.needsCopy) {
                const childExt = path.extname(inc.incPath);
                const childBase = inc.incPath.slice(0, -childExt.length);
                const newIncPath = `${childBase}.mql_dbg_build${childExt}`;
                
                // Preserve original delimiter style (quotes vs angle brackets)
                if (inc.prefix && inc.suffix) {
                    node.lines[inc.lineIdx] = `${inc.prefix}${newIncPath}${inc.suffix}`;
                } else {
                    // Fallback to quotes if delimiter style cannot be determined
                    node.lines[inc.lineIdx] = `#include "${newIncPath}" /* fallback */`;
                }
            }
        }

        // Inject debug instrumentation
        if (node.bps.length > 0) {
            // 1. Identify which function names need ENTER/EXIT from ORIGINAL lines
            const bpLineSet = new Set(node.bps.map(b => b.line));
            const origFuncs = findFunctionBoundaries(node.lines);
            const funcNamesToInstrument = new Set();
            for (const fn of origFuncs) {
                for (let i = fn.bodyStart; i <= fn.bodyEnd; i++) {
                    if (bpLineSet.has(i + 1)) {
                        // Tag this function by its bodyStart line content for re-identification
                        funcNamesToInstrument.add(fn.bodyStart);
                        break;
                    }
                }
            }
            // Store the function signature lines so we can re-find them after injection
            const funcSigLines = new Set();
            for (const fn of origFuncs) {
                if (funcNamesToInstrument.has(fn.bodyStart)) {
                    // Record the text of the line containing the opening brace
                    funcSigLines.add(node.lines[fn.bodyStart]);
                }
            }

            // 2. Inject breakpoint macros (on original line numbers)
            const injections = [];
            for (const bp of node.bps) {
                const injPoint = findInjectionPoint(node.lines, bp.line);
                if (injPoint === null) {
                    const base = path.basename(node.filePath);
                    skippedArr.push(`${base}:${bp.line}`);
                    continue;
                }
                const annotatedVars = parseWatchAnnotations(node.lines, bp.line);
                const localVars = parseLocalsInScope(node.lines, bp.line);

                const seen = new Set();
                const watchVars = [];
                for (const name of annotatedVars) {
                    seen.add(name);
                    const local = localVars.find(l => l.name === name);
                    watchVars.push({ name, type: local ? local.type : '' });
                }
                for (const local of localVars) {
                    if (!seen.has(local.name)) {
                        seen.add(local.name);
                        watchVars.push(local);
                    }
                }

                const sanitizedBase = sanitizeLabel(path.basename(node.filePath));
                const label = `bp_${sanitizedBase}_${bp.line}`;
                const macroLines = buildInjectionLines(label, watchVars, bp.condition || '');
                injections.push({ afterLine: injPoint, macroLines });
            }
            injections.sort((a, b) => b.afterLine - a.afterLine);
            for (const { afterLine, macroLines } of injections) {
                node.lines.splice(afterLine + 1, 0, ...macroLines);
            }

            ensureInclude(node.lines);

            // 3. Inject ENTER/EXIT on the modified source
            //    Re-find function boundaries, then filter to only the functions
            //    we identified in step 1 (matched by signature line text)
            if (funcSigLines.size > 0) {
                const modifiedFuncs = findFunctionBoundaries(node.lines);
                const relevantFuncs = modifiedFuncs.filter(fn =>
                    funcSigLines.has(node.lines[fn.bodyStart])
                );
                // Process in reverse to preserve indices
                relevantFuncs.sort((a, b) => b.bodyStart - a.bodyStart);
                for (const fn of relevantFuncs) {
                    const indent = getIndent(node.lines[fn.bodyStart]) + '    ';

                    // EXIT before closing brace
                    node.lines.splice(fn.bodyEnd, 0, `${indent}MQL_DBG_EXIT;`);

                    // EXIT before each return (backwards)
                    // Wrap in braces to avoid breaking braceless if/for/while blocks.
                    // e.g. `if (x) return;` → `if (x) { MQL_DBG_EXIT; return; }`
                    for (let i = fn.bodyEnd - 1; i > fn.bodyStart; i--) {
                        if (/^return\b/.test(node.lines[i].trimStart())) {
                            const retIndent = getIndent(node.lines[i]);
                            node.lines[i] = `${retIndent}{ MQL_DBG_EXIT; ${node.lines[i].trim()} }`;
                        }
                    }

                    // ENTER after opening brace
                    node.lines.splice(fn.bodyStart + 1, 0, `${indent}MQL_DBG_ENTER;`);
                }
            }
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
            const binaryPath = entryTempPath.replace(/\.mql_dbg_build\.mq[45]$/i, '.mql_dbg_build' + (ext.toLowerCase() === '.mq5' ? '.ex5' : '.ex4'));
            try { fs.unlinkSync(binaryPath); } catch {}
        }
    };

    if (!entryTempPath) return null;

    return { tempPath: entryTempPath, restore, skipped: skippedArr };
}

module.exports = { instrumentWorkspace };
