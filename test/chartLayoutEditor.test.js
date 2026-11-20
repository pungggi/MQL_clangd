'use strict';

// Unit tests for the visual Chart Layout preset editor.
//
// Two layers are covered:
//   1. Host side: panel creation, save normalization round-trip, apply guard
//      (uses the shared test/mocks/vscode.js, extended with a webview stub).
//   2. Webview side: the REAL inline script from _getHtml() runs against a
//      compact fake DOM (no jsdom dependency) — loading legacy/areas presets,
//      drag-painting, region validation, floating toggle, and the save
//      postMessage payload.

const assert = require('assert');
const vscodeMock = require('./mocks/vscode.js');

// ---------------------------------------------------------------- fake DOM --

class FakeClassList {
    constructor() { this._set = new Set(); }
    add(c) { this._set.add(c); }
    contains(c) { return this._set.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
    }
}

class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.parentNode = null;
        this._attrs = {};
        this._listeners = {};
        this._text = '';
        this.style = {};
        this.classList = new FakeClassList();
        this.value = '';
        this.disabled = false;
        this.checked = false;
    }
    get id() { return this._attrs.id || ''; }
    get className() { return this._attrs.class || ''; }
    set className(v) {
        this._attrs.class = v;
        this.classList = new FakeClassList();
        for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c);
    }
    get textContent() {
        let t = this._text;
        for (const c of this.children) t += c.textContent;
        return t;
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    set innerHTML(html) { this.children = []; this._text = ''; parseHtml(String(html), this); }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    matches(sel) {
        if (sel[0] === '.') return this.classList.contains(sel.slice(1));
        if (sel[0] === '#') return this.id === sel.slice(1);
        return this.tagName === sel;
    }
    closest(sel) {
        let n = this;
        while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; }
        return null;
    }
    _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }
    querySelector(sel) {
        let found = null;
        this._walk((c) => { if (!found && c.matches(sel)) found = c; });
        return found;
    }
    querySelectorAll(sel) {
        const found = [];
        this._walk((c) => { if (c.matches(sel)) found.push(c); });
        return found;
    }
}

function parseHtml(html, root) {
    const stack = [root];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w-]+(?:="[^"]*"|='[^']*'|\b))*)\s*(\/?)>/g;
    let m;
    let last = 0;
    while ((m = tagRe.exec(html))) {
        const text = html.substring(last, m.index);
        if (text.trim()) stack[stack.length - 1]._text += text;
        last = tagRe.lastIndex;
        const closing = m[1], tag = m[2].toLowerCase(), attrStr = m[3] || '', selfClose = m[4];
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const el = new FakeElement(tag);
        const attrRe = /([\w-]+)(?:="([^"]*)"|='([^']*)')/g;
        let a;
        while ((a = attrRe.exec(attrStr))) {
            el._attrs[a[1]] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : '');
        }
        for (const c of String(el._attrs.class || '').split(/\s+/).filter(Boolean)) el.classList.add(c);
        el.parentNode = stack[stack.length - 1];
        stack[stack.length - 1].children.push(el);
        if (!selfClose) stack.push(el);
    }
    const tail = html.substring(last);
    if (tail.trim()) stack[stack.length - 1]._text += tail;
}

function makeDocument(bodyHtml) {
    const doc = { body: new FakeElement('body') };
    doc.body.innerHTML = bodyHtml;
    doc.getElementById = (id) => {
        let found = null;
        if (doc.body.id === id) return doc.body;
        doc.body._walk((c) => { if (!found && c.id === id) found = c; });
        return found;
    };
    return doc;
}

function fire(el, type, event) {
    event = event || {};
    event.target = event.target || el;
    event.preventDefault = event.preventDefault || (() => { });
    for (const fn of (el._listeners[type] || []).slice()) fn(event);
}

// ------------------------------------------------------------ webview rig --

const TEST_PRESETS = [
    { name: 'legacy', docked: { monitor: 2, rows: 2, cols: 2 }, gap: 4 },
    { name: 'tfwall', docked: { monitor: 1, areas: ['H4 H4 H1', 'H4 H4 M15'] }, floating: { monitor: 2, areas: ['D1 W1'] }, gap: 0 },
    { name: 'broken-no-docked', gap: 0 },
    { name: 'aliases', docked: { monitor: 1, areas: ['Daily Daily H1', 'Weekly Monthly H1'] }, gap: 0 },
];

let panel = null;
let configWrites = [];

function setupHost(overrides) {
    configWrites = [];
    vscodeMock.workspace._configMock = {
        get: (key) => (key === 'ChartLayout.Presets' ? TEST_PRESETS : undefined),
        update: async (key, value, target) => { configWrites.push({ key, value, target }); },
        inspect: () => ({ workspaceValue: undefined }),
    };
    vscodeMock.window.createWebviewPanel = (viewType, title, column, options) => {
        const sent = [];
        panel = {
            viewType, title, options, sent,
            webview: {
                html: '',
                onDidReceiveMessage(cb) { this._cb = cb; },
                postMessage(m) { sent.push(m); },
            },
            onDidDispose() { },
            reveal() { },
            dispose() { },
        };
        return panel;
    };
    if (overrides) overrides();
    delete require.cache[require.resolve('../src/chartLayoutEditor.js')];
    delete require.cache[require.resolve('../src/chartLayout.js')];
    const editor = require('../src/chartLayoutEditor.js');
    editor.createOrShow({ extensionPath: 'C:\\fake' });
    return panel;
}

// Runs the inline script from the generated HTML against a fresh fake DOM.
function bootWebview(html) {
    const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(scriptMatch, 'inline script found');
    const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
    const bodyHtml = bodyMatch[1].replace(scriptMatch[0], '');
    const doc = makeDocument(bodyHtml);
    const win = {
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    };
    const api = { posted: [], postMessage(m) { this.posted.push(m); } };
    new Function('acquireVsCodeApi', 'document', 'window', scriptMatch[1])(() => api, doc, win);
    return { doc, win, api };
}

function cellAt(doc, gi, r, c) {
    const card = doc.getElementById('card-' + gi);
    return card.querySelector('.grid').children.find(
        (el) => el.getAttribute('data-r') === String(r) && el.getAttribute('data-c') === String(c));
}

function paint(doc, win, gi, r0, c0, r1, c1, token) {
    const chips = doc.getElementById('palChips');
    if (token) {
        const chip = chips.children.find((el) => el.getAttribute('data-tok') === token);
        fire(chips, 'click', { target: chip });
    }
    const editor = doc.getElementById('editor');
    fire(editor, 'mousedown', { target: cellAt(doc, gi, r0, c0), button: 0 });
    if (r1 !== r0 || c1 !== c0) fire(editor, 'mouseover', { target: cellAt(doc, gi, r1, c1) });
    for (const fn of (win._listeners.mouseup || []).slice()) fn({});
}

function previewJson(doc) { return JSON.parse(doc.getElementById('jsonPreview').textContent); }

// ------------------------------------------------------------------ suites --

suite('chartLayoutEditor (host)', () => {
    suiteTeardown(() => {
        vscodeMock.workspace._configMock = null;
        delete vscodeMock.window.createWebviewPanel;
    });

    test('panel html embeds presets and a nonce CSP', () => {
        const p = setupHost();
        assert.strictEqual(p.viewType, 'mqlChartLayoutEditor');
        assert.ok(p.options.enableScripts && p.options.retainContextWhenHidden);
        assert.ok(/script-src 'nonce-/.test(p.webview.html));
        assert.ok(p.webview.html.includes('var INITIAL = [{"raw"'));
        assert.ok(p.webview.html.includes('"invalid":true'));   // broken-no-docked flagged
        assert.ok(!p.webview.html.includes('http://') && !p.webview.html.includes('https://'));
    });

    test('save writes the full normalized array to user settings (global)', async () => {
        const p = setupHost();
        await p.webview._cb({
            type: 'save',
            presets: [
                { name: ' legacy ', docked: { monitor: 2, areas: ['H4 H4', 'H4 H4'] }, gap: 4 },
                { name: 'nofloat', docked: { monitor: 1, areas: ['A B'] }, floating: { monitor: 2, areas: ['. .'] }, gap: 0 },
            ],
        });
        assert.strictEqual(p.sent.length, 1);
        assert.strictEqual(p.sent[0].type, 'saveResult');
        assert.strictEqual(p.sent[0].ok, true, p.sent[0].message);
        assert.strictEqual(configWrites.length, 1);
        const w = configWrites[0];
        assert.strictEqual(w.key, 'ChartLayout.Presets');
        assert.strictEqual(w.target, vscodeMock.ConfigurationTarget.Global);
        assert.deepStrictEqual(w.value, [
            { name: 'legacy', docked: { monitor: 2, areas: ['H4 H4', 'H4 H4'] }, gap: 4 },
            // all-empty floating areas survive normalization and is written
            { name: 'nofloat', docked: { monitor: 1, areas: ['A B'] }, floating: { monitor: 2, areas: ['. .'] }, gap: 0 },
        ]);
    });

    test('preset without floating writes no floating key', async () => {
        const p = setupHost();
        await p.webview._cb({ type: 'save', presets: [{ name: 'x', docked: { monitor: 1, areas: ['H1'] }, gap: 0 }] });
        assert.strictEqual(p.sent[0].ok, true);
        assert.ok(!('floating' in configWrites[0].value[0]));
    });

    test('invalid preset blocks the save with a reason', async () => {
        const p = setupHost();
        await p.webview._cb({ type: 'save', presets: [{ name: '', docked: { monitor: 1, areas: ['H1'] }, gap: 0 }] });
        assert.strictEqual(p.sent[0].ok, false);
        assert.ok(p.sent[0].message.includes('name'));
        assert.strictEqual(configWrites.length, 0);
    });

    test('empty preset list is rejected', async () => {
        const p = setupHost();
        await p.webview._cb({ type: 'save', presets: [] });
        assert.strictEqual(p.sent[0].ok, false);
        assert.strictEqual(configWrites.length, 0);
    });

    test('workspace override: canceling the scope pick writes nothing', async () => {
        const p = setupHost(() => {
            vscodeMock.workspace._configMock.inspect = () => ({ workspaceValue: [{ name: 'ws' }] });
        });
        await p.webview._cb({ type: 'save', presets: [{ name: 'x', docked: { monitor: 1, areas: ['H1'] }, gap: 0 }] });
        assert.strictEqual(p.sent[0].ok, false);
        assert.ok(p.sent[0].message.includes('cancelled'));
        assert.strictEqual(configWrites.length, 0);
    });

    test('workspace override: picking workspace saves there', async () => {
        const orig = vscodeMock.window.showQuickPick;
        vscodeMock.window.showQuickPick = () => Promise.resolve({ target: vscodeMock.ConfigurationTarget.Workspace });
        try {
            const p = setupHost(() => {
                vscodeMock.workspace._configMock.inspect = () => ({ workspaceValue: [{ name: 'ws' }] });
            });
            await p.webview._cb({ type: 'save', presets: [{ name: 'x', docked: { monitor: 1, areas: ['H1'] }, gap: 0 }] });
            assert.strictEqual(p.sent[0].ok, true, p.sent[0].message);
            assert.ok(p.sent[0].message.includes('workspace settings'));
            assert.strictEqual(configWrites[0].target, vscodeMock.ConfigurationTarget.Workspace);
        } finally {
            vscodeMock.window.showQuickPick = orig;
        }
    });

    test('apply is Windows-only', async () => {
        const plat = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        try {
            const p = setupHost();
            await p.webview._cb({ type: 'apply', presets: TEST_PRESETS.slice(0, 1), index: 0 });
            Object.defineProperty(process, 'platform', plat);
            assert.strictEqual(p.sent.length, 1);
            assert.strictEqual(p.sent[0].type, 'applyResult');
            assert.strictEqual(p.sent[0].ok, false);
            assert.ok(p.sent[0].message.includes('Windows-only'));
            assert.strictEqual(configWrites.length, 0);
        } finally {
            Object.defineProperty(process, 'platform', plat);
        }
    });
});

suite('chartLayoutEditor (webview script)', () => {
    test('loads legacy rows/cols and saves them back unchanged until edited', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        // first preset selected by default; the untouched legacy grid keeps its
        // exact rows/cols shape (uniform worker geometry) in the saved JSON
        assert.deepStrictEqual(previewJson(doc), {
            name: 'legacy',
            docked: { monitor: 2, rows: 2, cols: 2 },
            gap: 4,
        });
        // order-fill hint (A is not a timeframe)
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('warn'));
        assert.ok(hint.textContent.includes('Order-fill'));
        // painting is a geometry edit: only then does this grid become areas
        paint(doc, win, 0, 0, 0, 0, 0, 'H4');
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['H4 B', 'C D']);
    });

    test('oversized legacy grid loads verbatim (no silent truncation)', () => {
        const p = setupHost(() => {
            vscodeMock.workspace._configMock.get = () => [
                { name: 'wide', docked: { monitor: 1, rows: 1, cols: 17 }, gap: 0 },
            ];
        });
        const { doc } = bootWebview(p.webview.html);
        assert.deepStrictEqual(previewJson(doc).docked, { monitor: 1, rows: 1, cols: 17 });
        assert.strictEqual(doc.getElementById('card-0').querySelectorAll('.cell').length, 17);
    });

    test('pipe token inside an areas row loads as an empty cell', () => {
        const p = setupHost(() => {
            vscodeMock.workspace._configMock.get = () => [
                { name: 'pipes', docked: { monitor: 1, areas: ['A|B C'] }, gap: 0 },
            ];
        });
        const { doc } = bootWebview(p.webview.html);
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['. C']);
    });

    test('loads areas preset with floating group', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        // click 2nd preset in sidebar
        const item = doc.getElementById('presetList').children[1];
        fire(doc.getElementById('presetList'), 'click', { target: item });
        assert.deepStrictEqual(previewJson(doc), {
            name: 'tfwall',
            docked: { monitor: 1, areas: ['H4 H4 H1', 'H4 H4 M15'] },
            floating: { monitor: 2, areas: ['D1 W1'] },
            gap: 0,
        });
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('ok'), hint.textContent);
        assert.ok(hint.textContent.includes('Timeframe-match'));
    });

    test('flags invalid raw entries without crashing', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        const item = doc.getElementById('presetList').children[2];
        fire(doc.getElementById('presetList'), 'click', { target: item });
        assert.ok(item.textContent.includes('invalid in settings'));
        // loads a blank editable 2×3 grid; name survives, so it stays applicable
        assert.strictEqual(previewJson(doc).name, 'broken-no-docked');
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['A B C', 'D E F']);
        assert.strictEqual(doc.getElementById('btnApply').disabled, false);
        // emptying the name invalidates it live
        const nameInput = doc.getElementById('presetName');
        nameInput.value = '';
        fire(doc.getElementById('editor'), 'input', { target: nameInput, value: '' });
        assert.strictEqual(doc.getElementById('btnApply').disabled, true);
        const fresh = doc.getElementById('presetList').children[2];
        assert.ok(fresh.textContent.includes('needs a name'));
    });

    test('drag-paints a rectangle with the selected token', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        paint(doc, win, 0, 0, 0, 0, 1, 'H4');   // top-left 2 cells of row 0
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['H4 H4', 'C D']);
        // mixed tokens -> still order-fill
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('warn'));
    });

    test('all-timeframe grid shows timeframe-match hint', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        paint(doc, win, 0, 0, 0, 0, 0, 'H4');
        paint(doc, win, 0, 0, 1, 0, 1, 'H4');
        paint(doc, win, 0, 1, 0, 1, 1, 'H1');
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('ok'), hint.textContent);
    });

    test('non-rectangular region turns cells red and errors the hint', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        paint(doc, win, 0, 0, 0, 0, 0, 'H4');   // (0,0) only
        paint(doc, win, 0, 1, 1, 1, 1, 'H4');   // (1,1) only -> diagonal, not rect
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('err'));
        assert.ok(hint.textContent.includes('Not rectangular'));
        assert.ok(cellAt(doc, 0, 0, 0).className.includes('red'));
        assert.ok(cellAt(doc, 0, 1, 1).className.includes('red'));
    });

    test('right-click resets a cell to empty', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        const editor = doc.getElementById('editor');
        fire(editor, 'contextmenu', { target: cellAt(doc, 0, 0, 0) });
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['. B', 'C D']);
    });

    test('custom token paints as order-fill name', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        const ct = doc.getElementById('customTok');
        ct.value = 'EURUSD';
        fire(ct, 'input', { target: ct });
        paint(doc, win, 0, 0, 0, 0, 1, null);   // use selected custom token
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['EURUSD EURUSD', 'C D']);
    });

    test('floating toggle adds and strips the floating group', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        const editor = doc.getElementById('editor');
        // legacy preset: no floating -> enable (real DOM keeps state on the element)
        const tog = doc.getElementById('floatToggle');
        tog.checked = true;
        fire(editor, 'change', { target: tog, checked: true });
        assert.deepStrictEqual(previewJson(doc).floating, { monitor: 1, areas: ['. .', '. .'] });
        // disable again -> omitted (renderEditor rebuilt the card, grab fresh toggle)
        const tog2 = doc.getElementById('floatToggle');
        tog2.checked = false;
        fire(editor, 'change', { target: tog2, checked: false });
        assert.ok(!('floating' in previewJson(doc)));
    });

    test('row/col buttons resize the grid', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        const editor = doc.getElementById('editor');
        const card = doc.getElementById('card-0');
        fire(editor, 'click', { target: card.querySelector('.addRow') });
        fire(editor, 'click', { target: card.querySelector('.addCol') });
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['A B .', 'C D .', '. . .']);
        fire(editor, 'click', { target: card.querySelector('.delRow') });
        fire(editor, 'click', { target: card.querySelector('.delCol') });
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['A B', 'C D']);
    });

    test('new / duplicate / delete manage the list', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        fire(doc.getElementById('btnNew'), 'click');
        assert.strictEqual(previewJson(doc).name, 'layout 5');
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['. . .', '. . .']);
        fire(doc.getElementById('btnDup'), 'click');
        assert.strictEqual(previewJson(doc).name, 'layout 5 copy');
        for (let i = 0; i < 6; i++) fire(doc.getElementById('btnDelete'), 'click');
        assert.ok(doc.getElementById('editor').textContent.includes('No presets'));
        assert.strictEqual(doc.getElementById('btnSave').disabled, true);
    });

    test('rename updates preview, validity and save payload', () => {
        const p = setupHost();
        const { doc, api } = bootWebview(p.webview.html);
        const editor = doc.getElementById('editor');
        const nameInput = doc.getElementById('presetName');
        nameInput.value = 'renamed';
        fire(editor, 'input', { target: nameInput, value: 'renamed' });
        assert.strictEqual(previewJson(doc).name, 'renamed');
        fire(doc.getElementById('btnSave'), 'click');
        assert.strictEqual(api.posted.length, 1);
        assert.strictEqual(api.posted[0].type, 'save');
        assert.deepStrictEqual(api.posted[0].presets[0], {
            name: 'renamed',
            docked: { monitor: 2, rows: 2, cols: 2 },
            gap: 4,
        });
    });

    test('apply button posts the selected index', () => {
        const p = setupHost();
        const { doc, api } = bootWebview(p.webview.html);
        fire(doc.getElementById('presetList'), 'click', { target: doc.getElementById('presetList').children[1] });
        fire(doc.getElementById('btnApply'), 'click');
        assert.strictEqual(api.posted.length, 1);
        assert.strictEqual(api.posted[0].type, 'apply');
        assert.strictEqual(api.posted[0].index, 1);
        assert.strictEqual(api.posted[0].presets[1].name, 'tfwall');
    });

    test('long timeframe aliases load canonical and keep tf mode', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        fire(doc.getElementById('presetList'), 'click', { target: doc.getElementById('presetList').children[3] });
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['D1 D1 H1', 'W1 MN1 H1']);
        const hint = doc.getElementById('card-0').querySelector('.hint');
        assert.ok(hint.className.includes('ok'), hint.textContent);
        assert.ok(hint.textContent.includes('Timeframe-match'));
    });

    test('custom tokens with separators are rejected', () => {
        const p = setupHost();
        const { doc } = bootWebview(p.webview.html);
        const ct = doc.getElementById('customTok');
        ct.value = 'A B';
        fire(ct, 'input', { target: ct });
        assert.ok(doc.getElementById('status').textContent.includes('cannot contain'));
        ct.value = 'A|B';
        fire(ct, 'input', { target: ct });
        assert.ok(doc.getElementById('status').textContent.includes('cannot contain'));
    });

    test('apply stays disabled until every region is rectangular', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        assert.strictEqual(doc.getElementById('btnApply').disabled, false);
        // two diagonal cells sharing one token = non-rectangular region
        paint(doc, win, 0, 0, 0, 0, 0, 'H4');
        paint(doc, win, 0, 1, 1, 1, 1, null);
        assert.strictEqual(doc.getElementById('btnApply').disabled, true);
        // resolving the region re-enables apply
        const editor = doc.getElementById('editor');
        fire(editor, 'contextmenu', { target: cellAt(doc, 0, 1, 1) });
        assert.strictEqual(doc.getElementById('btnApply').disabled, false);
    });

    test('preset names with markup are escaped in the sidebar', () => {
        const p = setupHost(() => {
            vscodeMock.workspace._configMock.get = () => [
                { name: '<img src=x onerror=alert(1)>', docked: { monitor: 1, areas: ['A B'] }, gap: 0 },
            ];
        });
        const { doc } = bootWebview(p.webview.html);
        const item = doc.getElementById('presetList').children[0];
        assert.strictEqual(item.querySelectorAll('img').length, 0);
        assert.ok(item.textContent.includes('&lt;img'), item.textContent);
    });

    test('typing Daily in the custom box paints canonical D1', () => {
        const p = setupHost();
        const { doc, win } = bootWebview(p.webview.html);
        const ct = doc.getElementById('customTok');
        ct.value = 'Daily';
        fire(ct, 'input', { target: ct });
        paint(doc, win, 0, 0, 0, 0, 0, null);   // single-cell paint with the selected token
        assert.deepStrictEqual(previewJson(doc).docked.areas, ['D1 B', 'C D']);
        // the suggestion surfaces in the status line and the canonical chip lights up
        assert.ok(doc.getElementById('status').textContent.includes('D1'));
        const d1 = Array.from(doc.getElementById('palChips').children).find((c) => c.getAttribute('data-tok') === 'D1');
        assert.ok(d1.classList.contains('sel'));
    });
});
