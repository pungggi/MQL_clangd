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
 * Count net brace depth change for a line, skipping braces inside
 * string literals (single- and double-quoted) and comments.
 *
 * @param {string} line
 * @param {boolean} inBlockComment  Whether we start inside a block comment
 * @returns {{ delta: number, inBlockComment: boolean }}
 */
function braceDepthDelta(line, inBlockComment = false) {
    let delta = 0;
    let inStr = false;
    let strCh = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inBlockComment) {
            if (ch === '*' && line[i + 1] === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === strCh) inStr = false;
            continue;
        }
        if (ch === '/' && line[i + 1] === '/') break; // line comment — rest is ignored
        if (ch === '/' && line[i + 1] === '*') { inBlockComment = true; i++; continue; }
        if (ch === '"' || ch === '\'') { inStr = true; strCh = ch; continue; }
        if (ch === '{') delta++;
        else if (ch === '}') delta--;
    }
    return { delta, inBlockComment };
}

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
 * Check if a file is a "user file" (not a system include from MQL5/Include/).
 * User files get full probe instrumentation at every executable line.
 * System includes are only instrumented if they have explicit breakpoints.
 *
 * @param {string} filePath
 * @param {string} mql5Root
 * @returns {boolean}
 */
function isUserFile(filePath, mql5Root) {
    if (!mql5Root) return true;
    const includeDir = path.resolve(mql5Root, 'Include');
    const rel = path.relative(includeDir, filePath);
    return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * Find ALL executable lines inside function bodies that can serve as
 * probe injection points.  Returns 0-based line indices.
 *
 * @param {string[]} lines
 * @returns {number[]}
 */
function findAllExecutableLines(lines) {
    const classifier = new MqlLineClassifier();
    const functions = findFunctionBoundaries(lines);

    const inFunction = new Set();
    for (const fn of functions) {
        for (let i = fn.bodyStart + 1; i < fn.bodyEnd; i++) {
            inFunction.add(i);
        }
    }

    const points = [];
    for (let i = 0; i < lines.length; i++) {
        const kind = classifier.classify(lines[i]);
        if (!inFunction.has(i)) continue;
        if (kind !== 'code') continue;
        const trimmed = lines[i].trimEnd();
        if (trimmed.endsWith(';') || trimmed.endsWith('}')) {
            points.push(i);
        }
    }
    return points;
}

/**
 * Detect whether `lines[idx]` is the sole body of a braceless control structure
 * (if / else if / for / while / else).  When true the probe injection must wrap
 * both the probe and the original line in { } to preserve control flow.
 *
 * @param {string[]} lines  Source lines (0-based)
 * @param {number}   idx    0-based index of the candidate line
 * @returns {boolean}
 */
function isBracelessBody(lines, idx) {
    // Walk backward to the first non-blank, non-comment line.
    // We must skip block-comment lines (/* ... */) in addition to // comments.
    let prev = -1;
    let inBlock = false;
    for (let i = idx - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t === '') continue;
        // Scanning backward: if a line ends a block comment, we are entering one
        if (!inBlock && t.endsWith('*/')) {
            inBlock = true;
        }
        if (inBlock) {
            // If this line starts the block comment, we're leaving it
            if (t.includes('/*')) inBlock = false;
            continue;
        }
        if (t.startsWith('//')) continue;
        // Skip block-comment continuation lines (e.g. " * text")
        if (t.startsWith('*') && !t.startsWith('*/')) continue;
        prev = i;
        break;
    }
    if (prev < 0) return false;

    const prevTrimmed = lines[prev].trim();

    // `else` or `} else` without opening brace
    if (/^(\}\s*)?else\s*$/.test(prevTrimmed)) return true;

    // Line ends with `)` — trace back to the matching `(` and check for control keyword
    if (prevTrimmed.endsWith(')')) {
        let depth = 0;
        for (let i = prev; i >= 0; i--) {
            const line = lines[i];
            for (let c = line.length - 1; c >= 0; c--) {
                if (line[c] === ')') depth++;
                else if (line[c] === '(') {
                    depth--;
                    if (depth === 0) {
                        const before = line.substring(0, c).trim();
                        return /\b(if|else\s+if|for|while)\s*$/.test(before);
                    }
                }
            }
        }
    }

    return false;
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
    if (targetLine < 1) return null;

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
// Well-known MQL built-in globals and struct definitions
// -------------------------------------------------------------------------

/** MQL4 built-in price/market globals + MQL5 predefined variables. */
const MQL_BUILTIN_GLOBALS = new Map([
    ['Bid',        { type: 'double', isArray: false, isInput: false }],
    ['Ask',        { type: 'double', isArray: false, isInput: false }],
    ['Point',      { type: 'double', isArray: false, isInput: false }],
    ['Digits',     { type: 'int',    isArray: false, isInput: false }],
    ['Spread',     { type: 'int',    isArray: false, isInput: false }],
    ['Bars',       { type: 'int',    isArray: false, isInput: false }],
    ['_Point',     { type: 'double', isArray: false, isInput: false }],
    ['_Digits',    { type: 'int',    isArray: false, isInput: false }],
    ['_Period',    { type: 'int',    isArray: false, isInput: false }],
    ['_LastError', { type: 'int',    isArray: false, isInput: false }],
    ['_StopFlag',  { type: 'bool',   isArray: false, isInput: false }],
]);

/** Well-known MQL struct/built-in type definitions. */
const MQL_BUILTIN_STRUCTS = new Map([
    ['MqlTick', { parent: null, members: new Map([
        ['time',         { type: 'datetime', isArray: false }],
        ['bid',          { type: 'double',   isArray: false }],
        ['ask',          { type: 'double',   isArray: false }],
        ['last',         { type: 'double',   isArray: false }],
        ['volume',       { type: 'ulong',    isArray: false }],
        ['time_msc',     { type: 'long',     isArray: false }],
        ['flags',        { type: 'uint',     isArray: false }],
        ['volume_real',  { type: 'double',   isArray: false }],
    ])}],
    ['MqlRates', { parent: null, members: new Map([
        ['time',         { type: 'datetime', isArray: false }],
        ['open',         { type: 'double',   isArray: false }],
        ['high',         { type: 'double',   isArray: false }],
        ['low',          { type: 'double',   isArray: false }],
        ['close',        { type: 'double',   isArray: false }],
        ['tick_volume',  { type: 'long',     isArray: false }],
        ['spread',       { type: 'int',      isArray: false }],
        ['real_volume',  { type: 'long',     isArray: false }],
    ])}],
    ['MqlDateTime', { parent: null, members: new Map([
        ['year',         { type: 'int', isArray: false }],
        ['mon',          { type: 'int', isArray: false }],
        ['day',          { type: 'int', isArray: false }],
        ['hour',         { type: 'int', isArray: false }],
        ['min',          { type: 'int', isArray: false }],
        ['sec',          { type: 'int', isArray: false }],
        ['day_of_week',  { type: 'int', isArray: false }],
        ['day_of_year',  { type: 'int', isArray: false }],
    ])}],
    ['MqlTradeRequest', { parent: null, members: new Map([
        ['action',       { type: 'int',      isArray: false }],
        ['magic',        { type: 'ulong',    isArray: false }],
        ['order',        { type: 'ulong',    isArray: false }],
        ['symbol',       { type: 'string',   isArray: false }],
        ['volume',       { type: 'double',   isArray: false }],
        ['price',        { type: 'double',   isArray: false }],
        ['stoplimit',    { type: 'double',   isArray: false }],
        ['sl',           { type: 'double',   isArray: false }],
        ['tp',           { type: 'double',   isArray: false }],
        ['deviation',    { type: 'ulong',    isArray: false }],
        ['type',         { type: 'int',      isArray: false }],
        ['type_filling', { type: 'int',      isArray: false }],
        ['type_time',    { type: 'int',      isArray: false }],
        ['expiration',   { type: 'datetime', isArray: false }],
        ['comment',      { type: 'string',   isArray: false }],
        ['position',     { type: 'ulong',    isArray: false }],
        ['position_by',  { type: 'ulong',    isArray: false }],
    ])}],
    ['MqlTradeResult', { parent: null, members: new Map([
        ['retcode',          { type: 'uint',   isArray: false }],
        ['deal',             { type: 'ulong',  isArray: false }],
        ['order',            { type: 'ulong',  isArray: false }],
        ['volume',           { type: 'double', isArray: false }],
        ['price',            { type: 'double', isArray: false }],
        ['bid',              { type: 'double', isArray: false }],
        ['ask',              { type: 'double', isArray: false }],
        ['comment',          { type: 'string', isArray: false }],
        ['request_id',       { type: 'uint',   isArray: false }],
        ['retcode_external', { type: 'int',    isArray: false }],
    ])}],
]);

// -------------------------------------------------------------------------
// Keyword sets for declaration parsing
// -------------------------------------------------------------------------

/** Identifiers that are clearly not type names on the left side of a declaration. */
const NON_TYPE_KEYWORDS = new Set([
    'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'break', 'continue', 'class', 'struct', 'enum', 'void', 'delete',
    'new', 'virtual', 'override', 'public', 'private', 'protected',
    'template', 'typedef', 'namespace', 'Print', 'Comment', 'Alert',
]);

/** MQL primitive type keywords — valid as type names but must never be extracted as variable names. */
const MQL_PRIMITIVE_TYPES = new Set([
    'int', 'uint', 'short', 'ushort', 'char', 'uchar',
    'long', 'ulong', 'double', 'float', 'string', 'bool',
    'datetime', 'color',
]);

/** Union of NON_TYPE_KEYWORDS + MQL_PRIMITIVE_TYPES — used to filter extracted variable names. */
const NON_VARNAME_KEYWORDS = new Set([...NON_TYPE_KEYWORDS, ...MQL_PRIMITIVE_TYPES]);

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
    // We accumulate brace deltas forward then scan backward using them.
    let braceDepth = 0;
    let funcBodyStart = -1;
    for (let i = idx; i >= 0; i--) {
        const r = braceDepthDelta(lines[i]);
        // Walking backward: subtract delta (opening braces push depth negative)
        braceDepth -= r.delta;
        if (braceDepth < 0) {
            // We've passed more opening braces than closing — found the function start
            funcBodyStart = i;
            break;
        }
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
    const RE_DECL = /^\s*(?:(?:static|const|input)\s+)*([A-Za-z_]\w*)\s+\*?\s*((?:[A-Za-z_]\w*(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?(?:\s*,\s*)?)+)\s*;/;
    const RE_VARNAME = /([A-Za-z_]\w*)(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?/g;

    // NON_TYPE_KEYWORDS / NON_VARNAME_KEYWORDS are module-level constants

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
            if (!seen.has(vName) && !NON_VARNAME_KEYWORDS.has(vName)) {
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
            params.push({ name: pm[2], type: pm[1], isArray: trimmed.includes('[') });
        }
    }
    return params;
}

// -------------------------------------------------------------------------
// Class and global type resolution for member access debugging
// -------------------------------------------------------------------------

/**
 * Parse class/struct definitions from source lines.
 * Extracts class name, parent class, and member declarations.
 *
 * @param {string[]} lines
 * @returns {{ name: string, parent: string|null, members: { name: string, type: string, isArray: boolean }[] }[]}
 */
function parseClassDefinitions(lines) {
    const classes = [];
    const RE_CLASS = /^\s*(?:class|struct)\s+([A-Za-z_]\w*)(?:\s*:\s*(?:(?:public|private|protected)\s+)?([A-Za-z_]\w*))?/;
    const RE_DECL = /^\s*(?:(?:static|const)\s+)*([A-Za-z_]\w*)\s+\*?\s*((?:[A-Za-z_]\w*(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?(?:\s*,\s*)?)+)\s*;/;
    const RE_VNAME = /([A-Za-z_]\w*)(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?/g;
    // Uses module-level NON_TYPE_KEYWORDS / NON_VARNAME_KEYWORDS

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(RE_CLASS);
        if (!m) continue;
        if (lines[i].trimEnd().endsWith(';')) continue; // forward declaration

        const className = m[1];
        const parent = m[2] || null;

        // Find opening brace
        let braceIdx = -1;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j].includes('{')) { braceIdx = j; break; }
        }
        if (braceIdx < 0) continue;

        // Find matching closing brace
        let depth = 0, endIdx = -1, inBC = false;
        for (let j = braceIdx; j < lines.length; j++) {
            const r = braceDepthDelta(lines[j], inBC);
            inBC = r.inBlockComment;
            depth += r.delta;
            if (depth === 0 && r.delta !== 0) { endIdx = j; break; }
        }
        if (endIdx < 0) continue;

        // Scan member declarations at class body depth (depth 1)
        const members = [];
        let bodyDepth = 0;
        let inBC2 = false;
        for (let j = braceIdx; j <= endIdx; j++) {
            const prevDepth = bodyDepth;
            const r = braceDepthDelta(lines[j], inBC2);
            inBC2 = r.inBlockComment;
            bodyDepth += r.delta;
            if (prevDepth !== 1) continue;

            const trimmed = lines[j].trimStart();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') ||
                trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

            const dm = trimmed.match(RE_DECL);
            if (!dm) continue;
            if (NON_TYPE_KEYWORDS.has(dm[1])) continue;

            RE_VNAME.lastIndex = 0;
            let vm;
            while ((vm = RE_VNAME.exec(dm[2])) !== null) {
                if (!NON_VARNAME_KEYWORDS.has(vm[1])) {
                    members.push({ name: vm[1], type: dm[1], isArray: vm[0].includes('[') });
                }
            }
        }

        classes.push({ name: className, parent, members });
        i = endIdx;
    }
    return classes;
}

/**
 * Parse global (file-scope) variable declarations.
 * Skips class/struct/function bodies by tracking brace depth.
 *
 * @param {string[]} lines
 * @returns {{ name: string, type: string, isArray: boolean }[]}
 */
function parseGlobalDeclarations(lines) {
    const globals = [];
    // Exclude parens to avoid matching function prototypes like: int func(int, datetime);
    const RE_DECL = /^\s*(?:(?:static|const|input)\s+)*([A-Za-z_]\w*)\s+\*?\s*([A-Za-z_][^;{()]*)\s*;/;
    const RE_VNAME = /([A-Za-z_]\w*)(?:\s*(?:\[[^\]]*\]))*(?:\s*=[^,;]*)?/g;
    // Uses module-level NON_TYPE_KEYWORDS / NON_VARNAME_KEYWORDS

    let depth = 0;
    let inBC = false;
    for (let i = 0; i < lines.length; i++) {
        const prevDepth = depth;
        const r = braceDepthDelta(lines[i], inBC);
        inBC = r.inBlockComment;
        depth += r.delta;
        if (prevDepth !== 0) continue;

        const trimmed = lines[i].trimStart();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') ||
            trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

        const m = trimmed.match(RE_DECL);
        if (!m) continue;
        if (NON_TYPE_KEYWORDS.has(m[1])) continue;

        const isInput = /\bs?input\b/.test(lines[i]);
        RE_VNAME.lastIndex = 0;
        let vm;
        while ((vm = RE_VNAME.exec(m[2])) !== null) {
            if (!NON_VARNAME_KEYWORDS.has(vm[1])) {
                globals.push({ name: vm[1], type: m[1], isArray: vm[0].includes('['), isInput });
            }
        }
    }
    return globals;
}

/**
 * Build a type database from all files in the include graph.
 *
 * @param {Map} graph  The include graph built by instrumentWorkspace
 * @returns {{ classMap: Map<string, { parent: string|null, members: Map<string, { type: string, isArray: boolean }> }>, globalMap: Map<string, { type: string, isArray: boolean }> }}
 */
function buildTypeDatabase(graph) {
    const classMap = new Map();
    const globalMap = new Map();

    for (const node of graph.values()) {
        if (!node.lines) continue;

        for (const cls of parseClassDefinitions(node.lines)) {
            if (!classMap.has(cls.name)) {
                const memberMap = new Map();
                for (const m of cls.members) {
                    memberMap.set(m.name, { type: m.type, isArray: m.isArray });
                }
                classMap.set(cls.name, { parent: cls.parent, members: memberMap });
            }
        }

        for (const g of parseGlobalDeclarations(node.lines)) {
            if (!globalMap.has(g.name)) {
                globalMap.set(g.name, { type: g.type, isArray: g.isArray, isInput: g.isInput });
            }
        }
    }

    // Inject well-known MQL built-in globals (only if not already declared in user code)
    for (const [name, info] of MQL_BUILTIN_GLOBALS) {
        if (!globalMap.has(name)) globalMap.set(name, info);
    }
    // Inject well-known MQL struct definitions (only if not already parsed from user code)
    for (const [name, def] of MQL_BUILTIN_STRUCTS) {
        if (!classMap.has(name)) classMap.set(name, def);
    }

    return { classMap, globalMap };
}

/**
 * Find member access expressions (obj.member, this.field, a.b.c) used in the
 * function body up to the breakpoint line.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based breakpoint line
 * @returns {string[]}  Unique member access expressions
 */
function findMemberAccessExpressions(lines, bpLine) {
    const idx = bpLine - 1;
    if (idx < 0 || idx >= lines.length) return [];

    // Find function body start (walk backwards to opening brace)
    let braceDepth = 0, funcStart = -1;
    for (let i = idx; i >= 0; i--) {
        for (let c = lines[i].length - 1; c >= 0; c--) {
            if (lines[i][c] === '}') braceDepth++;
            else if (lines[i][c] === '{') {
                braceDepth--;
                if (braceDepth < 0) { funcStart = i; break; }
            }
        }
        if (funcStart >= 0) break;
    }
    if (funcStart < 0) return [];

    const RE = /\b((?:this|[a-zA-Z_]\w*)(?:\.[a-zA-Z_]\w*)+)/g;
    const exprs = new Set();

    for (let i = funcStart; i <= idx && i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('/*') ||
            trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

        RE.lastIndex = 0;
        let m;
        while ((m = RE.exec(lines[i])) !== null) {
            const expr = m[1];
            const afterIdx = m.index + m[0].length;
            const afterChar = afterIdx < lines[i].length ? lines[i][afterIdx] : '';

            if (afterChar === '(') {
                // Last segment is a method call — trim it and keep the object part
                const lastDot = expr.lastIndexOf('.');
                if (lastDot > 0) {
                    const objPart = expr.substring(0, lastDot);
                    if (objPart.includes('.')) exprs.add(objPart);
                }
            } else {
                exprs.add(expr);
            }
        }
    }

    return Array.from(exprs);
}

/**
 * Determine the enclosing class name for the function containing a breakpoint.
 * Checks for ClassName::MethodName in the signature, or whether the function
 * is lexically inside a class body (inline method).
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based
 * @returns {string|null}
 */
function findEnclosingClassName(lines, bpLine) {
    const idx = bpLine - 1;
    if (idx < 0 || idx >= lines.length) return null;

    // Find function body start
    let braceDepth = 0, funcStart = -1;
    for (let i = idx; i >= 0; i--) {
        for (let c = lines[i].length - 1; c >= 0; c--) {
            if (lines[i][c] === '}') braceDepth++;
            else if (lines[i][c] === '{') {
                braceDepth--;
                if (braceDepth < 0) { funcStart = i; break; }
            }
        }
        if (funcStart >= 0) break;
    }
    if (funcStart < 0) return null;

    // Check for ClassName::MethodName pattern in the signature
    let sigText = '';
    for (let i = Math.max(0, funcStart - 5); i <= funcStart; i++) {
        sigText += ' ' + lines[i];
    }
    const cm = sigText.match(/([A-Za-z_]\w*)\s*::\s*[A-Za-z_~]\w*\s*\(/);
    if (cm) return cm[1];

    // Check if the function is lexically inside a class body (inline method)
    braceDepth = 0;
    for (let i = funcStart - 1; i >= 0; i--) {
        for (let c = lines[i].length - 1; c >= 0; c--) {
            if (lines[i][c] === '}') braceDepth++;
            else if (lines[i][c] === '{') {
                braceDepth--;
                if (braceDepth < 0) {
                    // We exited a scope — check if it's a class/struct
                    for (let k = i; k >= Math.max(0, i - 5); k--) {
                        const km = lines[k].match(/(?:class|struct)\s+([A-Za-z_]\w*)/);
                        if (km) return km[1];
                    }
                    return null;
                }
            }
        }
    }

    return null;
}

/**
 * Look up a member in a class, following the inheritance chain.
 *
 * @param {Map} classMap
 * @param {string} className
 * @param {string} memberName
 * @returns {{ type: string, isArray: boolean }|null}
 */
function lookupClassMember(classMap, className, memberName) {
    const visited = new Set();
    let current = className;
    while (current && !visited.has(current)) {
        visited.add(current);
        const def = classMap.get(current);
        if (!def) return null;
        if (def.members.has(memberName)) return def.members.get(memberName);
        current = def.parent;
    }
    return null;
}

/**
 * Resolve the type of a member access expression by walking the class map.
 * Handles chains (a.b.c) and inheritance.
 *
 * @param {string} expr  e.g. 'g_timers.lastTime' or 'this.count'
 * @param {{ name: string, type: string }[]} locals
 * @param {Map} globalMap
 * @param {Map} classMap
 * @param {string|null} enclosingClass
 * @returns {{ type: string, isArray: boolean }|null}
 */
function resolveMemberType(expr, locals, globalMap, classMap, enclosingClass) {
    const parts = expr.split('.');
    if (parts.length < 2) return null;

    // Resolve the root object's type
    let currentType = null;
    const root = parts[0];

    if (root === 'this') {
        currentType = enclosingClass;
    } else {
        const local = locals.find(l => l.name === root);
        if (local) {
            currentType = local.type;
        } else if (globalMap.has(root)) {
            currentType = globalMap.get(root).type;
        }
    }

    if (!currentType) return null;

    // Walk the member chain
    for (let i = 1; i < parts.length; i++) {
        const member = lookupClassMember(classMap, currentType, parts[i]);
        if (!member) return null;
        if (i === parts.length - 1) return member;
        // Intermediate segment — its type should be another class
        currentType = member.type;
    }

    return null;
}

/**
 * Check if a type is watchable (primitive or enum) rather than a class/struct.
 *
 * @param {string} typeName
 * @param {Map} classMap
 * @returns {boolean}
 */
function isWatchableType(typeName, classMap) {
    const key = typeName.replace(/\b(const|static|input)\b/g, '').trim();
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MQL_TYPE_MACROS, lower)) return true;
    if (lower.startsWith('enum_')) return true;
    if (classMap.has(key)) return false;
    return false; // unknown type — skip to avoid compile errors
}

/**
 * Find implicit class members (accessed without this.) used near a breakpoint.
 * Only returns members with watchable (primitive/enum) types.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based
 * @param {{ name: string, type: string }[]} locals
 * @param {Map} classMap
 * @param {string|null} enclosingClass
 * @returns {{ name: string, type: string, isArray: boolean }[]}
 */
function findImplicitClassMembers(lines, bpLine, locals, classMap, enclosingClass) {
    if (!enclosingClass) return [];

    // Collect all members from the class and its ancestors
    const allMembers = new Map();
    const visited = new Set();
    let current = enclosingClass;
    while (current && !visited.has(current) && classMap.has(current)) {
        visited.add(current);
        const cd = classMap.get(current);
        for (const [name, info] of cd.members) {
            if (!allMembers.has(name)) allMembers.set(name, info);
        }
        current = cd.parent;
    }
    if (allMembers.size === 0) return [];

    const localNames = new Set(locals.map(l => l.name));
    const idx = bpLine - 1;
    const from = Math.max(0, idx - 10);
    const results = [];

    for (const [memberName, memberInfo] of allMembers) {
        if (localNames.has(memberName)) continue; // shadowed by local
        if (!isWatchableType(memberInfo.type, classMap)) continue;

        const re = new RegExp('\\b' + memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        for (let i = from; i <= idx && i < lines.length; i++) {
            const trimmed = lines[i].trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') ||
                trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
            if (re.test(lines[i])) {
                results.push({ name: memberName, type: memberInfo.type, isArray: memberInfo.isArray });
                break;
            }
        }
    }

    return results;
}

/**
 * Find global primitive variables referenced near a breakpoint.
 * Scans ±15 lines around bpLine for identifiers matching globalMap entries.
 *
 * @param {string[]} lines
 * @param {number}   bpLine    1-based
 * @param {Map}      globalMap
 * @param {Map}      classMap
 * @param {Set}      seen      Already-seen variable names (locals, params, members)
 * @returns {{ name: string, type: string, isArray: boolean }[]}
 */
function findGlobalVarsNearBreakpoint(lines, bpLine, globalMap, classMap, seen) {
    const results = [];
    const idx = bpLine - 1;
    const from = Math.max(0, idx - 15);
    const to = Math.min(lines.length - 1, idx + 5);

    for (const [varName, info] of globalMap) {
        if (seen.has(varName)) continue;
        if (!isWatchableType(info.type, classMap)) continue;

        const re = new RegExp('\\b' + varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        for (let i = from; i <= to; i++) {
            const trimmed = lines[i].trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') ||
                trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
            if (re.test(lines[i])) {
                results.push({ name: varName, type: info.type, isArray: info.isArray });
                break;
            }
        }
    }
    return results;
}

/**
 * Expand local variables of class type into their watchable primitive fields.
 * Returns watch entries of the form { name: 'local.field', type, isArray }.
 *
 * @param {{ name: string, type: string }[]} locals
 * @param {Map} classMap
 * @returns {{ name: string, type: string, isArray: boolean }[]}
 */
function findClassFieldExpansions(locals, classMap) {
    const results = [];
    for (const local of locals) {
        if (!classMap.has(local.type)) continue;
        const visited = new Set();
        let current = local.type;
        while (current && !visited.has(current) && classMap.has(current)) {
            visited.add(current);
            const cd = classMap.get(current);
            for (const [memberName, memberInfo] of cd.members) {
                if (isWatchableType(memberInfo.type, classMap)) {
                    results.push({
                        name: `${local.name}.${memberName}`,
                        type: memberInfo.type,
                        isArray: memberInfo.isArray,
                    });
                }
            }
            current = cd.parent;
        }
    }
    return results;
}

/**
 * Find global variables of class/struct type referenced near a breakpoint.
 * Used in deep analysis to expand those instances into their primitive fields.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based
 * @param {Map}      globalMap
 * @param {Map}      classMap
 * @param {Set}      seen
 * @returns {{ name: string, type: string }[]}
 */
function findGlobalClassInstancesNearBreakpoint(lines, bpLine, globalMap, classMap, seen) {
    const results = [];
    const idx = bpLine - 1;
    const from = Math.max(0, idx - 15);
    const to = Math.min(lines.length - 1, idx + 5);

    for (const [varName, info] of globalMap) {
        if (seen.has(varName)) continue;
        if (!classMap.has(info.type)) continue;

        const re = new RegExp('\\b' + varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        for (let i = from; i <= to; i++) {
            const trimmed = lines[i].trimStart();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') ||
                trimmed.startsWith('*') || trimmed.startsWith('#')) continue;
            if (re.test(lines[i])) {
                results.push({ name: varName, type: info.type });
                break;
            }
        }
    }
    return results;
}

/**
 * Extract watchable expressions from a return statement near the breakpoint.
 * Handles: return ident; return obj.member; skips function calls.
 *
 * @param {string[]} lines
 * @param {number}   bpLine  1-based
 * @returns {string[]}
 */
function extractReturnExpressions(lines, bpLine) {
    const idx = bpLine - 1;
    const from = Math.max(0, idx - 1);
    const to = Math.min(lines.length - 1, idx + 2);

    for (let i = from; i <= to; i++) {
        const m = lines[i].match(/\breturn\s+(.+?)\s*;/);
        if (!m) continue;
        const expr = m[1].trim();
        const results = [];
        const RE = /\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\b/g;
        let rm;
        while ((rm = RE.exec(expr)) !== null) {
            const e = rm[1];
            const afterIdx = rm.index + e.length;
            if (afterIdx < expr.length && expr[afterIdx] === '(') continue; // skip function calls
            results.push(e);
        }
        return [...new Set(results)];
    }
    return [];
}

/**
 * Map an instrumented file line number back to the original source line.
 *
 * @param {number} instrumentedLine  1-based line in the instrumented file
 * @param {{ originalLine: number, linesInserted: number }[]} offsets
 *   Sorted by originalLine ascending
 * @returns {number} 1-based line in the original file
 */
function instrumentedToOriginal(instrumentedLine, offsets) {
    let totalOffset = 0;
    for (const { originalLine, linesInserted } of offsets) {
        const injectionPoint = originalLine + totalOffset + 1;
        if (instrumentedLine < injectionPoint) break;
        if (instrumentedLine < injectionPoint + linesInserted) {
            return originalLine;
        }
        totalOffset += linesInserted;
    }
    return instrumentedLine - totalOffset;
}

/**
 * Sanitize a string for use as a label in MQL macros.
 * Strips or replaces anything except letters, numbers, underscore, and dash.
 * @param {string} label
 * @returns {string}
 */
function sanitizeLabel(label) {
    if (!label) return '';
    return label.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Sanitize a condition string for safe embedding into a single-line comment.
 * @param {string} condition
 * @returns {string}
 */
function sanitizeCondition(condition) {
    if (!condition) return '';
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
    const pauseLine = 'MQL_DBG_PAUSE;';

    if (condition && condition.trim()) {
        if (isConditionSafe(condition)) {
            const bodyLines = [breakLine, ...watchLines, pauseLine];
            return [`if (${condition}) {`, ...bodyLines.map(l => `  ${l}`), '}'];
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
 * Convert a logpoint message template to an MQL string expression.
 * Handles `{expression}` interpolation by resolving types from watchVars.
 *
 * Example: "x = {x}, name = {name}" with watchVars containing x:int, name:string
 *   → `"x = " + IntegerToString((long)(x)) + ", name = " + (name)`
 *
 * @param {string} template  Logpoint message with {expr} placeholders
 * @param {{ name: string, type?: string }[]} watchVars  Available variables with type info
 * @returns {string}  MQL string expression
 */
function buildLogExpression(template, watchVars) {
    if (!template) return '""';

    const varMap = new Map();
    for (const v of watchVars) {
        varMap.set(v.name, v.type || '');
    }

    const parts = [];
    let pos = 0;
    while (pos < template.length) {
        const openIdx = template.indexOf('{', pos);
        if (openIdx < 0) {
            // Rest is literal text
            parts.push(JSON.stringify(template.substring(pos)));
            break;
        }
        // Literal text before {
        if (openIdx > pos) {
            parts.push(JSON.stringify(template.substring(pos, openIdx)));
        }
        const closeIdx = template.indexOf('}', openIdx + 1);
        if (closeIdx < 0) {
            // Unclosed { — treat rest as literal
            parts.push(JSON.stringify(template.substring(openIdx)));
            break;
        }
        const expr = template.substring(openIdx + 1, closeIdx).trim();
        if (!expr) {
            parts.push('"{}"');
        } else {
            // Look up the expression type from watch vars
            const type = varMap.get(expr) || '';
            const typeLower = type.replace(/\b(const|static|input)\b/g, '').trim().toLowerCase();
            if (['int', 'uint', 'short', 'ushort', 'char', 'uchar', 'long', 'ulong', 'color'].includes(typeLower) ||
                typeLower.startsWith('enum_')) {
                parts.push(`IntegerToString((long)(${expr}))`);
            } else if (['double', 'float'].includes(typeLower)) {
                parts.push(`DoubleToString((double)(${expr}), 8)`);
            } else if (typeLower === 'bool') {
                parts.push(`((${expr}) ? "true" : "false")`);
            } else if (typeLower === 'datetime') {
                parts.push(`TimeToString((datetime)(${expr}), TIME_DATE | TIME_SECONDS)`);
            } else if (typeLower === 'string') {
                parts.push(`(${expr})`);
            } else {
                // Unknown type — try generic string conversion
                parts.push(`(string)(${expr})`);
            }
        }
        pos = closeIdx + 1;
    }

    if (parts.length === 0) return '""';
    return parts.join(' + ');
}

/**
 * Generate the macro injection lines for one dynamic probe.
 * Wraps the BREAK + watches + PAUSE inside an `if (MqlDebugProbeCheck(id))` block
 * so the EA only fires the probe when VS Code has activated it via the config file.
 *
 * Every probe includes a runtime logpoint check (`MqlDebugIsLogpoint`) so that
 * logpoints added mid-session work even without recompilation:
 * - If a logMessage template was provided at compile time, the logpoint path
 *   emits a LOG event with the interpolated message.
 * - Otherwise, the logpoint fallback emits BREAK + watches (same as break mode)
 *   but skips PAUSE, so the EA continues without stopping.
 *
 * @param {number}   probeId      Sequential probe index
 * @param {string}   label        Breakpoint label (e.g. "bp_SMC_mq5_310")
 * @param {{ name: string, type?: string, isArray?: boolean }[]} watchVars
 * @param {string}   condition    Optional condition string (may be empty)
 * @param {string}   [logMessage] Optional logpoint message template with {expr} placeholders
 * @returns {string[]}  Lines to insert
 */
function buildProbeInjection(probeId, label, watchVars, condition, logMessage) {
    const watchLines = [];
    watchLines.push(`MQL_DBG_BREAK("${label}");`);
    for (const v of watchVars) {
        if (v.isArray) {
            const arrMacro = macroForType(v.type, true);
            if (arrMacro) watchLines.push(`${arrMacro}("${v.name}", ${v.name});`);
        } else {
            const macro = macroForType(v.type);
            watchLines.push(`${macro}("${v.name}", ${v.name});`);
        }
    }

    const condExpr = (condition && condition.trim() && isConditionSafe(condition))
        ? ` && (${condition})` : '';

    const result = [];
    if (condition && condition.trim() && !isConditionSafe(condition)) {
        result.push(`// Invalid breakpoint condition: ${sanitizeCondition(condition)}`);
    }

    const hasLogMessage = logMessage && logMessage.trim();
    if (hasLogMessage) {
        // Compile-time logpoint message available: use MQL_DBG_LOG in logpoint path
        const logExpr = buildLogExpression(logMessage, watchVars);
        result.push(
            `if (MqlDebugProbeCheck(${probeId})${condExpr}) {`,
            `  if (MqlDebugIsLogpoint(${probeId})) {`,
            `    MQL_DBG_LOG(${logExpr});`,
            '  } else {',
            ...watchLines.map(l => `    ${l}`),
            '    MQL_DBG_PAUSE;',
            '  }',
            '}'
        );
    } else {
        // No logpoint message: emit BREAK + watches always, only PAUSE when not a logpoint.
        // This allows logpoints added mid-session to work without recompilation.
        result.push(
            `if (MqlDebugProbeCheck(${probeId})${condExpr}) {`,
            ...watchLines.map(l => `  ${l}`),
            `  if (!MqlDebugIsLogpoint(${probeId})) MQL_DBG_PAUSE;`,
            '}'
        );
    }
    return result;
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
        let inBC = false;
        for (let j = braceIdx; j < lines.length; j++) {
            const r = braceDepthDelta(lines[j], inBC);
            inBC = r.inBlockComment;
            depth += r.delta;
            if (depth === 0 && r.delta !== 0) {
                endIdx = j;
                break;
            }
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
 * @returns {number} 0-based insertion index, or -1 if already present
 */
function findIncludeInsertAt(lines) {
    if (lines.some(l => l.includes('MqlDebug.mqh'))) return -1;
    let insertAt = 0;
    for (let i = 0; i < Math.min(30, lines.length); i++) {
        const t = lines[i].trimStart();
        if (t.startsWith('#property') || t.startsWith('//') || t === '') {
            insertAt = i + 1;
        } else if (t.startsWith('#include') || t.startsWith('#define')) {
            break;
        } else {
            break;
        }
    }
    return insertAt;
}

function ensureInclude(lines) {
    const insertAt = findIncludeInsertAt(lines);
    if (insertAt < 0) return -1;
    lines.splice(insertAt, 0, INCLUDE_LINE);
    return insertAt;
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
 * Collect all watch variables for a breakpoint at the given line.
 * Factored out so it can be called from the all-line probe loop.
 *
 * @param {string[]} lines        Source lines (0-based array)
 * @param {number}   bpLine       1-based breakpoint line
 * @param {{ classMap: Map, globalMap: Map }} typeDB
 * @param {boolean}  deepAnalysis
 * @returns {{ name: string, type: string, isArray?: boolean }[]}
 */
function collectWatchVars(lines, bpLine, typeDB, deepAnalysis) {
    const annotatedVars = parseWatchAnnotations(lines, bpLine);
    const localVars = parseLocalsInScope(lines, bpLine);

    const seen = new Set();
    const watchVars = [];
    for (const name of annotatedVars) {
        seen.add(name);
        const local = localVars.find(l => l.name === name);
        watchVars.push({ name, type: local ? local.type : '', isArray: local ? local.isArray : false });
    }
    for (const local of localVars) {
        if (!seen.has(local.name)) {
            seen.add(local.name);
            watchVars.push(local);
        }
    }

    const enclosingClass = findEnclosingClassName(lines, bpLine);
    for (const expr of findMemberAccessExpressions(lines, bpLine)) {
        if (seen.has(expr)) continue;
        const resolved = resolveMemberType(expr, localVars, typeDB.globalMap, typeDB.classMap, enclosingClass);
        if (resolved && isWatchableType(resolved.type, typeDB.classMap)) {
            seen.add(expr);
            watchVars.push({ name: expr, type: resolved.type, isArray: resolved.isArray });
        }
    }

    for (const member of findImplicitClassMembers(lines, bpLine, localVars, typeDB.classMap, enclosingClass)) {
        if (!seen.has(member.name)) {
            seen.add(member.name);
            watchVars.push(member);
        }
    }

    if (deepAnalysis) {
        for (const g of findGlobalVarsNearBreakpoint(lines, bpLine, typeDB.globalMap, typeDB.classMap, seen)) {
            seen.add(g.name);
            watchVars.push(g);
        }
        for (const field of findClassFieldExpansions(localVars, typeDB.classMap)) {
            if (!seen.has(field.name)) {
                seen.add(field.name);
                watchVars.push(field);
            }
        }
        for (const [varName, info] of typeDB.globalMap) {
            if (!info.isInput || seen.has(varName)) continue;
            if (!isWatchableType(info.type, typeDB.classMap)) continue;
            seen.add(varName);
            watchVars.push({ name: varName, type: info.type, isArray: info.isArray });
        }
        const globalClassInstances = findGlobalClassInstancesNearBreakpoint(
            lines, bpLine, typeDB.globalMap, typeDB.classMap, seen
        );
        for (const field of findClassFieldExpansions(globalClassInstances, typeDB.classMap)) {
            if (!seen.has(field.name)) {
                seen.add(field.name);
                watchVars.push(field);
            }
        }
    }

    for (const expr of extractReturnExpressions(lines, bpLine)) {
        if (seen.has(expr)) continue;
        let type = '', isArray = false;
        const local = localVars.find(l => l.name === expr);
        if (local) {
            type = local.type; isArray = local.isArray || false;
        } else if (typeDB.globalMap.has(expr)) {
            const g = typeDB.globalMap.get(expr);
            type = g.type; isArray = g.isArray;
        } else if (expr.includes('.')) {
            const resolved = resolveMemberType(expr, localVars, typeDB.globalMap, typeDB.classMap, enclosingClass);
            if (resolved) { type = resolved.type; isArray = resolved.isArray; }
        }
        if (!type || !isWatchableType(type, typeDB.classMap)) continue;
        seen.add(expr);
        watchVars.push({ name: expr, type, isArray });
    }

    return watchVars;
}

/**
 * Instrument a source file and its included dependencies for debugging.
 *
 * @param {string}   entryPointPath Absolute path to the main .mq5/.mq4 file
 * @param {Map<string, Array<{line: number, condition?: string}>>} breakpointMap
 *   Map of normalized path -> array of VS Code breakpoints
 * @param {string}   mql5Root       MQL5 root directory (for resolving includes)
 * @returns {{ tempPath: string, restore: () => void, skipped: string[], lineMap: Map, probeMap: Map }|null}
 */
function instrumentWorkspace(entryPointPath, breakpointMap, mql5Root) {
    const graph = new Map();

    // Read debug detail level from VS Code settings
    const _config = vscode ? vscode.workspace.getConfiguration('mql_tools') : null;
    const deepAnalysis = _config ? _config.get('Debug.DetailLevel') === 'deepAnalysis' : false;

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

    // 1b. Mark all user files for full probe instrumentation
    for (const node of graph.values()) {
        if (isUserFile(node.filePath, mql5Root)) {
            node.needsCopy = true;
        }
    }

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

    // 2b. Build type database from the include graph for member access resolution
    const typeDB = buildTypeDatabase(graph);

    // 3. Perform copies and rewrites
    const tempFiles = [];
    const skippedArr = [];
    let entryTempPath = '';
    const cleanedDirs = new Set();
    /** @type {Map<string, { originalLine: number, linesInserted: number }[]>} */
    const lineMap = new Map();
    /** @type {Map<string, Map<number, number>>}  normPath → Map<line1Based → probeId> */
    const probeMap = new Map();
    let nextProbeId = 0;

    // Pre-count total probes across all files so MqlDebugInitProbes() receives
    // the correct capacity before the entry point is written to disk.
    // (The entry point is processed first in the graph, so nextProbeId would
    //  only reflect its own probes at the time of insertion without this pass.)
    let totalProbeCount = 0;
    for (const node of graph.values()) {
        if (!node.needsCopy || !node.lines || node.lines.length === 0) continue;
        if (isUserFile(node.filePath, mql5Root)) {
            totalProbeCount += findAllExecutableLines(node.lines).length;
        } else if (node.bps.length > 0) {
            // Count unique injection points for system-include BPs
            const seen = new Set();
            for (const bp of node.bps) {
                const ip = findInjectionPoint(node.lines, bp.line);
                if (ip !== null) seen.add(ip);
            }
            totalProbeCount += seen.size;
        }
    }
    const probeCapacity = Math.max(totalProbeCount + 100, 1000);

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
                        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore cleanup errors */ }
                    }
                }
            } catch { /* ignore read errors */ }
        }

        // Rewrite includes that point to copied children
        for (const inc of node.includes) {
            const childNode = graph.get(inc.absPath.toLowerCase().replace(/\\/g, '/'));
            if (childNode && childNode.needsCopy) {
                const childExt = path.extname(inc.incPath);
                const childBase = inc.incPath.slice(0, -childExt.length);
                const newIncPath = `${childBase}.mql_dbg_build${childExt}`;

                if (inc.prefix && inc.suffix) {
                    node.lines[inc.lineIdx] = `${inc.prefix}${newIncPath}${inc.suffix}`;
                } else {
                    node.lines[inc.lineIdx] = `#include "${newIncPath}" /* fallback */`;
                }
            }
        }

        // ---------------------------------------------------------------
        // Inject probes — either all executable lines (user files) or
        // only lines with explicit BPs (system includes).
        // ---------------------------------------------------------------
        const fullInstrument = isUserFile(node.filePath, mql5Root) || node.bps.length > 0;
        if (fullInstrument && node.lines.length > 0) {
            // Build a set of BP injection points for this file
            const bpByInjLine = new Map(); // 0-based injection line → bp
            const bpLineSet = new Set();
            for (const bp of node.bps) {
                const injPoint = findInjectionPoint(node.lines, bp.line);
                if (injPoint === null) {
                    skippedArr.push(`${path.basename(node.filePath)}:${bp.line}`);
                } else {
                    if (bpByInjLine.has(injPoint)) {
                        // Merge conditions — two BPs at the same effective line
                        const existing = bpByInjLine.get(injPoint);
                        if (bp.condition && existing.condition) {
                            existing.condition = `(${existing.condition}) || (${bp.condition})`;
                        } else if (bp.condition) {
                            existing.condition = bp.condition;
                        }
                    } else {
                        bpByInjLine.set(injPoint, bp);
                    }
                    bpLineSet.add(bp.line);
                }
            }

            // 1. Identify functions needing ENTER/EXIT (only those with BPs)
            const origFuncs = findFunctionBoundaries(node.lines);
            const funcSigLines = new Set();
            const instrumentedFuncBounds = [];
            for (const fn of origFuncs) {
                let hasBp = false;
                for (let i = fn.bodyStart; i <= fn.bodyEnd; i++) {
                    if (bpLineSet.has(i + 1)) { hasBp = true; break; }
                }
                if (hasBp) {
                    funcSigLines.add(node.lines[fn.bodyStart]);
                    instrumentedFuncBounds.push({ bodyStart: fn.bodyStart, bodyEnd: fn.bodyEnd });
                }
            }

            // 2. Compute include insertion point on ORIGINAL lines
            const includeInsertAtOriginal = findIncludeInsertAt(node.lines);

            // 3. Determine which lines get probes
            const execLines = isUserFile(node.filePath, mql5Root)
                ? findAllExecutableLines(node.lines)    // ALL executable lines
                : [...bpByInjLine.keys()];              // only BP lines for system includes

            const sanitizedBase = sanitizeLabel(path.basename(node.filePath));
            const fileProbeMap = new Map();

            // 4. Build probe injections
            const injections = [];
            for (const execLine of execLines) {
                const bp = bpByInjLine.get(execLine);
                const originalLine = execLine + 1; // 1-based
                const probeId = nextProbeId++;

                let watchVars = [];
                let condition = '';
                let logMessage = '';
                if (bp) {
                    watchVars = collectWatchVars(node.lines, bp.line, typeDB, deepAnalysis);
                    condition = bp.condition || '';
                    logMessage = bp.logMessage || '';
                }

                const label = `bp_${sanitizedBase}_${originalLine}`;
                const macroLines = buildProbeInjection(probeId, label, watchVars, condition, logMessage);
                const braceless = isBracelessBody(node.lines, execLine);
                injections.push({ targetLine: execLine, macroLines, braceless });

                // Record probe mapping (actual line + BP line if different)
                fileProbeMap.set(originalLine, probeId);
                if (bp && bp.line !== originalLine) {
                    fileProbeMap.set(bp.line, probeId);
                }
            }

            // Splice injections (reverse order to preserve indices).
            // For braceless control bodies, wrap in { } and insert probe BEFORE
            // the target line to preserve control flow.
            // For normal lines, insert probe AFTER the target line — inserting
            // before would break multi-line statements whose final line ends
            // with ';' (the probe's `if` would land mid-expression).
            injections.sort((a, b) => b.targetLine - a.targetLine);
            for (const { targetLine, macroLines, braceless } of injections) {
                const indent = getIndent(node.lines[targetLine]);
                if (braceless) {
                    node.lines.splice(targetLine + 1, 0, `${indent}}`);
                    node.lines.splice(targetLine, 0, `${indent}{`, ...macroLines);
                } else {
                    node.lines.splice(targetLine + 1, 0, ...macroLines);
                }
            }

            // 5. Include + probe init
            const includeIdx = ensureInclude(node.lines);
            if (node.filePath === entryPointPath && includeIdx >= 0) {
                node.lines.splice(includeIdx + 1, 0,
                    `int __mqldbg_probes_init__ = MqlDebugInitProbes(${probeCapacity});`);
            }

            // 6. ENTER/EXIT (same as before — only for functions with BPs)
            if (funcSigLines.size > 0) {
                const modifiedFuncs = findFunctionBoundaries(node.lines);
                const relevantFuncs = modifiedFuncs.filter(fn =>
                    funcSigLines.has(node.lines[fn.bodyStart])
                );
                relevantFuncs.sort((a, b) => b.bodyStart - a.bodyStart);
                for (const fn of relevantFuncs) {
                    const indent = getIndent(node.lines[fn.bodyStart]) + '    ';
                    node.lines.splice(fn.bodyEnd, 0, `${indent}MQL_DBG_EXIT;`);
                    for (let i = fn.bodyEnd - 1; i > fn.bodyStart; i--) {
                        if (/^return\b[\s\S]*;\s*$/.test(node.lines[i].trim())) {
                            const retIndent = getIndent(node.lines[i]);
                            node.lines[i] = `${retIndent}{ MQL_DBG_EXIT; ${node.lines[i].trim()} }`;
                        }
                    }
                    node.lines.splice(fn.bodyStart + 1, 0, `${indent}MQL_DBG_ENTER;`);
                }
            }

            // 7. Build line offset table
            const fileOffsets = [];
            const includeLines = (node.filePath === entryPointPath && includeInsertAtOriginal >= 0) ? 2 : (includeInsertAtOriginal >= 0 ? 1 : 0);
            if (includeLines > 0) {
                fileOffsets.push({ originalLine: includeInsertAtOriginal, linesInserted: includeLines });
            }
            for (const { targetLine, macroLines, braceless } of injections) {
                const extra = braceless ? 2 : 0;  // { and }
                const insertAt = braceless ? targetLine : targetLine + 1;
                fileOffsets.push({ originalLine: insertAt, linesInserted: macroLines.length + extra });
            }
            for (const fn of instrumentedFuncBounds) {
                fileOffsets.push({ originalLine: fn.bodyStart + 1, linesInserted: 1 });
                fileOffsets.push({ originalLine: fn.bodyEnd, linesInserted: 1 });
            }
            fileOffsets.sort((a, b) => a.originalLine - b.originalLine);
            lineMap.set(node.normPath, fileOffsets);
            probeMap.set(node.normPath, fileProbeMap);
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

    /**
     * Attempt to delete all temp files (sources + binary).
     * Returns an array of file paths that could not be deleted (still locked
     * by MT5). The caller should retry these later.
     * @returns {string[]}  Paths that could not be deleted yet
     */
    const restore = () => {
        const locked = [];
        for (const tf of tempFiles) {
            try { fs.unlinkSync(tf); } catch (err) {
                if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
                    locked.push(tf);
                }
            }
        }
        if (entryTempPath) {
            const ext = path.extname(entryPointPath);
            const binaryPath = entryTempPath.replace(/\.mql_dbg_build\.mq[45]$/i, '.mql_dbg_build' + (ext.toLowerCase() === '.mq5' ? '.ex5' : '.ex4'));
            try { fs.unlinkSync(binaryPath); } catch (err) {
                if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
                    locked.push(binaryPath);
                }
            }
        }
        return locked;
    };

    if (!entryTempPath) return null;

    return { tempPath: entryTempPath, restore, skipped: skippedArr, lineMap, probeMap };
}

module.exports = {
    instrumentWorkspace,
    instrumentedToOriginal,
    // Exported for unit testing
    _test: {
        MqlLineClassifier,
        isConditionSafe,
        findInjectionPoint,
        parseWatchAnnotations,
        macroForType,
        parseLocalsInScope,
        parseFunctionParams,
        sanitizeLabel,
        sanitizeCondition,
        braceDepthDelta,
        buildLogExpression,
        buildProbeInjection,
    }
};
