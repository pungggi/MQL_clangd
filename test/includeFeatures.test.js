'use strict';
const assert = require('assert');
const vscode = require('./mocks/vscode.js');
const { MQLDocumentSymbolProvider, IncludeDefinitionProvider } = require('../src/provider');

function makeDocument(text) {
    const lines = text.split('\n');
    return {
        getText: () => text,
        positionAt(offset) {
            let remaining = offset;
            for (let line = 0; line < lines.length; line++) {
                const lineLen = lines[line].length + 1;
                if (remaining < lineLen) return new vscode.Position(line, remaining);
                remaining -= lineLen;
            }
            return new vscode.Position(0, 0);
        },
        lineAt(l) {
            return {
                range: new vscode.Range(l, 0, l, (lines[l] || '').length),
                text: lines[l] || ''
            };
        },
        fileName: 'test.mq5',
        uri: { toString: () => 'test://test.mq5' },
        version: 1
    };
}

suite('Include basename labels (Outline)', () => {
    const provider = MQLDocumentSymbolProvider();

    function includes(symbols) {
        const node = symbols.find(s => s.name === 'Includes');
        return node ? node.children : [];
    }

    test('simple angle-bracket include shows basename, full path in detail', () => {
        const doc = makeDocument('#include <LiveLog.mqh>');
        const inc = includes(provider.provideDocumentSymbols(doc));
        assert.strictEqual(inc.length, 1);
        assert.strictEqual(inc[0].name, 'LiveLog.mqh');
        assert.strictEqual(inc[0].detail, '');
    });

    test('nested include path: basename label, relative path in detail', () => {
        const doc = makeDocument('#include <Helpers/Utils.mqh>');
        const inc = includes(provider.provideDocumentSymbols(doc));
        assert.strictEqual(inc[0].name, 'Utils.mqh');
        assert.strictEqual(inc[0].detail, 'Helpers/Utils.mqh');
    });

    test('quoted include also uses basename label', () => {
        const doc = makeDocument('#include "../Helpers/Utils.mqh"');
        const inc = includes(provider.provideDocumentSymbols(doc));
        assert.strictEqual(inc[0].name, 'Utils.mqh');
        assert.strictEqual(inc[0].detail, '../Helpers/Utils.mqh');
    });
});

suite('IncludeDefinitionProvider (#include go-to-definition)', () => {
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    let tmp, incDir;
    setup(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mql-inc-'));
        incDir = path.join(tmp, 'Include');
        fs.mkdirSync(incDir);
        fs.writeFileSync(path.join(incDir, 'Foo.mqh'), '// hi');
        fs.mkdirSync(path.join(incDir, 'Sub'));
        fs.writeFileSync(path.join(incDir, 'Sub', 'Bar.mqh'), '// bar');
    });
    teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

    function provider() {
        return IncludeDefinitionProvider(() => incDir);
    }

    test('angle-bracket include resolves against include dir', () => {
        const doc = makeDocument('#include <Foo.mqh>');
        // cursor over the path
        const loc = provider().provideDefinition(doc, new vscode.Position(0, 14));
        assert.ok(loc, 'expected a location');
        assert.strictEqual(path.basename(loc.uri.fsPath), 'Foo.mqh');
    });

    test('nested angle-bracket include resolves', () => {
        const doc = makeDocument('#include <Sub/Bar.mqh>');
        const loc = provider().provideDefinition(doc, new vscode.Position(0, 14));
        assert.ok(loc);
        assert.strictEqual(path.basename(loc.uri.fsPath), 'Bar.mqh');
    });

    test('unresolvable include returns undefined (falls through to clangd)', () => {
        const doc = makeDocument('#include <Nope.mqh>');
        const loc = provider().provideDefinition(doc, new vscode.Position(0, 14));
        assert.strictEqual(loc, undefined);
    });

    test('cursor not over the path returns undefined', () => {
        const doc = makeDocument('#include <Foo.mqh>');
        const loc = provider().provideDefinition(doc, new vscode.Position(0, 1));
        assert.strictEqual(loc, undefined);
    });

    test('non-include line returns undefined', () => {
        const doc = makeDocument('void OnTick() {}');
        const loc = provider().provideDefinition(doc, new vscode.Position(0, 5));
        assert.strictEqual(loc, undefined);
    });
});
