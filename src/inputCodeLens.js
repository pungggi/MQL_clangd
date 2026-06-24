'use strict';

const vscode = require('vscode');

// MQL built-in value-type keywords, reused to detect the end of an input type.
const MQL_VALUE_TYPES = 'int|uint|long|ulong|short|ushort|char|uchar|double|float|string|bool|datetime|color';

// `input group "..."` section directive.
const INPUT_GROUP_RE = /^[ \t]*input[ \t]+group[ \t]+"([^"]*)"/gm;

// `input|sinput <type> <name> [= value]`  (optional enum/struct types supported via the catch-all `[\w<>:, \[\]]+`).
const INPUT_RE = new RegExp(
    `^[ \\t]*(input|sinput)[ \\t]+([A-Za-z_]\\w*(?:<[^>]*>)?|${MQL_VALUE_TYPES})[ \\t]+([A-Za-z_]\\w*)(?:[ \\t]*=[ \\t]*([^;\\n]+))?`,
    'gm'
);

// Optional trailing comment used as the input description/label:
//   `input int Lots = 0.1; // Lot size`
const TRAILING_COMMENT_RE = /[ \t]*;[ \t]*\/\/[ \t]*(.*)$/;

/**
 * Parse all `input`/`sinput` declarations and `input group` sections from a
 * source string. Returns inputs in file order, each annotated with the
 * `input group` section it falls under (or null when declared before the first
 * section). Comments are stripped defensively; offsets are not needed here
 * because we only need line numbers and field metadata.
 *
 * @param {string} text Full source text.
 * @returns {{sections: Array, inputs: Array}}
 */
function parseInputs(text) {
    const sections = [];
    let m;
    INPUT_GROUP_RE.lastIndex = 0;
    while ((m = INPUT_GROUP_RE.exec(text)) !== null) {
        const idx = m.index;
        const line = text.slice(0, idx).split('\n').length - 1;
        sections.push({ name: m[1] || '(unnamed)', line });
    }

    const inputs = [];
    INPUT_RE.lastIndex = 0;
    while ((m = INPUT_RE.exec(text)) !== null) {
        const idx = m.index;
        const line = text.slice(0, idx).split('\n').length - 1;
        const rawLine = text.split('\n')[line] || '';
        const cm = rawLine.match(TRAILING_COMMENT_RE);
        inputs.push({
            qualifier: m[1],          // input | sinput
            type: m[2],
            name: m[3],
            value: m[4] ? m[4].trim() : '',
            description: cm ? cm[1].trim() : '',
            line
        });
    }
    return { sections, inputs };
}

/** Resolve which section an input (by line) belongs to. */
function sectionForLine(sections, line) {
    let current = null;
    for (const s of sections) {
        if (s.line < line) current = s.name;
        else break;
    }
    return current;
}

/**
 * CodeLens provider that surfaces input configuration inline.
 *
 * - One lens above the *first* input of each section (and above any inputs
 *   before the first section) shows the group name + input count.
 * - Every input line carries a lightweight lens linking to a "Copy as .set"
 *   command that writes a Strategy Tester `.set` file for the whole document
 *   to the clipboard.
 */
class InputCodeLensProvider {
    constructor(onDidChange) {
        this.onDidChangeCodeLenses = onDidChange;
    }

    provideCodeLenses(document) {
        const text = document.getText();
        const { sections, inputs } = parseInputs(text);
        if (inputs.length === 0) return [];

        const lenses = [];

        // Group-header lenses: one per section boundary + one for pre-section
        // inputs (the "Inputs" pseudo-group). Each sits on the first input line
        // of the group.
        const groups = [];
        let preSectionCount = 0;
        let firstPreSectionLine = null;
        const sectionFirst = new Map(); // section name -> { line, count }

        for (const inp of inputs) {
            const sec = sectionForLine(sections, inp.line);
            if (sec === null) {
                if (firstPreSectionLine === null) firstPreSectionLine = inp.line;
                preSectionCount++;
            } else {
                if (!sectionFirst.has(sec)) {
                    sectionFirst.set(sec, { line: inp.line, count: 0 });
                }
                sectionFirst.get(sec).count++;
            }
        }

        if (firstPreSectionLine !== null) {
            groups.push({ line: firstPreSectionLine, label: 'Inputs', count: preSectionCount });
        }
        for (const [name, info] of sectionFirst) {
            groups.push({ line: info.line, label: name, count: info.count });
        }

        for (const g of groups) {
            const range = new vscode.Range(g.line, 0, g.line, 0);
            lenses.push(new vscode.CodeLens(range, {
                title: `$(settings-group) ${g.label} — ${g.count} input${g.count === 1 ? '' : 's'}  ·  Copy as .set`,
                command: 'mql_tools.copyInputsAsSet',
                tooltip: `"${g.label}" input group — click to copy all inputs as a Strategy Tester .set file`
            }));
        }

        return lenses;
    }
}

/**
 * Build MT5 Strategy Tester `.set` content for the inputs in the active
 * document. Format (one line per input):
 *
 *   Name=Value||InitialValue||Type||RangeStart||RangeStep||RangeStop||Label
 *
 * For inputs without an explicit default, the declared initializer is used as
 * both `Value` and `InitialValue`; otherwise empty.
 *
 * @param {vscode.TextDocument} document
 * @returns {string} `.set` content (UTF-8, `\n` line endings).
 */
function buildSetContent(document) {
    const text = document.getText();
    const { inputs } = parseInputs(text);
    if (inputs.length === 0) return '';

    const typeMap = (t) => {
        const low = String(t).toLowerCase();
        if (low === 'int' || low === 'uint' || low === 'long' || low === 'ulong' ||
            low === 'short' || low === 'ushort' || low === 'char' || low === 'uchar' ||
            low === 'color' || low === 'datetime') return 'int';
        if (low === 'double' || low === 'float') return 'double';
        if (low === 'string') return 'string';
        if (low === 'bool') return 'boolean';
        return 'int'; // enum types behave as ints in .set files
    };

    const lines = inputs.map(inp => {
        const value = inp.value;
        const type = typeMap(inp.type);
        // MT5 .set: Name=Value||Start||Step||Stop||InitialValue||Type
        // The widely compatible subset is: Name=Value||InitialValue||Type
        const parts = [
            inp.name,
            '=',
            value,
            '||', value,
            '||', type
        ];
        let line = parts.join('');
        if (inp.description) line += ` ;${inp.description}`;
        return line;
    });

    return lines.join('\n') + '\n';
}

module.exports = {
    InputCodeLensProvider,
    buildSetContent,
    parseInputs,
    // exported for testing
    _sectionForLine: sectionForLine
};
