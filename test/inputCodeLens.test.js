'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');
const { InputCodeLensProvider, buildSetContent, parseInputs, _sectionForLine } = require('../src/inputCodeLens');

function makeDocument(text) {
    const lines = text.split('\n');
    return {
        getText: () => text,
        lineAt: (l) => ({ text: lines[l] || '' }),
        fileName: 'MyEA.mq5'
    };
}

suite('inputCodeLens — parseInputs', () => {
    test('parses input/sinput with type, name, value', () => {
        const { inputs } = parseInputs('input int Magic = 12345;\nsinput string Secret = "x";');
        assert.strictEqual(inputs.length, 2);
        assert.strictEqual(inputs[0].qualifier, 'input');
        assert.strictEqual(inputs[0].type, 'int');
        assert.strictEqual(inputs[0].name, 'Magic');
        assert.strictEqual(inputs[0].value, '12345');
        assert.strictEqual(inputs[1].qualifier, 'sinput');
        assert.strictEqual(inputs[1].name, 'Secret');
    });

    test('captures trailing comment as description', () => {
        const { inputs } = parseInputs('input double Lots = 0.1; // Lot size');
        assert.strictEqual(inputs[0].description, 'Lot size');
    });

    test('parses input group sections', () => {
        const { sections, inputs } = parseInputs([
            'input int Magic = 1;',
            'input group "Risk"',
            'input double Lots = 0.1;',
            'input group "Trade"',
            'input bool Trail = true;'
        ].join('\n'));
        assert.strictEqual(sections.length, 2);
        assert.strictEqual(sections[0].name, 'Risk');
        assert.strictEqual(sections[1].name, 'Trade');
        assert.strictEqual(inputs.length, 3);
    });

    test('sectionForLine assigns inputs to the right group', () => {
        const src = [
            'input int Magic = 1;',          // line 0 -> pre-section
            'input group "Risk"',            // line 1
            'input double Lots = 0.1;',      // line 2 -> Risk
            'input group "Trade"',           // line 3
            'input bool Trail = true;'       // line 4 -> Trade
        ].join('\n');
        const { sections, inputs } = parseInputs(src);
        assert.strictEqual(_sectionForLine(sections, inputs[0].line), null);
        assert.strictEqual(_sectionForLine(sections, inputs[1].line), 'Risk');
        assert.strictEqual(_sectionForLine(sections, inputs[2].line), 'Trade');
    });
});

suite('inputCodeLens — CodeLens grouping', () => {
    const provider = new InputCodeLensProvider();

    test('one lens per section + one for pre-section inputs', () => {
        const doc = makeDocument([
            'input int Magic = 1;',
            'input group "Risk"',
            'input double Lots = 0.1;',
            'input int SL = 50;',
            'input group "Trade"',
            'input bool Trail = true;'
        ].join('\n'));
        const lenses = provider.provideCodeLenses(doc);
        // pre-section, Risk, Trade
        assert.strictEqual(lenses.length, 3);
        assert.ok(lenses[0].command.title.includes('Inputs') && lenses[0].command.title.includes('1 input'));
        assert.ok(lenses[1].command.title.includes('Risk') && lenses[1].command.title.includes('2 inputs'));
        assert.ok(lenses[2].command.title.includes('Trade'));
    });

    test('no inputs returns empty array', () => {
        const doc = makeDocument('void OnTick() {}\nint x = 5;');
        assert.deepStrictEqual(provider.provideCodeLenses(doc), []);
    });

    test('every lens wires the copy-as-set command', () => {
        const doc = makeDocument('input int Magic = 1;\ninput group "G"\ninput int X = 2;');
        for (const lens of provider.provideCodeLenses(doc)) {
            assert.strictEqual(lens.command.command, 'mql_tools.copyInputsAsSet');
        }
    });
});

suite('inputCodeLens — buildSetContent (.set export)', () => {
    test('serializes each input to Name=Value||InitialValue||Type', () => {
        const doc = makeDocument([
            'input int Magic = 12345;',
            'input double Lots = 0.1; // Lot size',
            'input bool UseTrailing = true;'
        ].join('\n'));
        const out = buildSetContent(doc).trim().split('\n');
        assert.strictEqual(out[0], 'Magic=12345||12345||int');
        assert.ok(out[1].startsWith('Lots=0.1||0.1||double'));
        assert.ok(out[1].includes(';Lot size'));
        assert.strictEqual(out[2], 'UseTrailing=true||true||boolean');
    });

    test('returns empty string when no inputs', () => {
        const doc = makeDocument('void OnTick() {}');
        assert.strictEqual(buildSetContent(doc), '');
    });
});
