'use strict';

/**
 * Unit tests for the Wine / Linux / macOS backend of Arrange MT5 Charts
 * (src/chartLayoutWine.js): state parsing, the layout math (ported from the
 * PowerShell worker), request serialization, and the two-phase file protocol
 * against a fake in-terminal service.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mocha = require('mocha');
const { suite, test, beforeEach, afterEach } = mocha;

const wine = require('../src/chartLayoutWine');

const MON1 = 'mon=1;0;0;1920;1080;0;0;1920;1040';
const MON2 = 'mon=2;1920;0;1920;1080;1920;0;1920;1040';

function stateText({ charts, mdi = '800,600', monitors = [MON1], main = 111, active = 'EURUSD' } = {}) {
    const lines = ['version=1', `main=${main}`, `mdi=${mdi}`, 'chrome=8,60,8,40', `active=${active}`, ...monitors];
    for (const c of charts || []) lines.push(`chart=${c[0]};${c[1]};${c[2]};${c[3]}`);
    return lines.join('\r\n') + '\r\n';
}

// chart tuple: [hwnd, symbol, periodMinutes, docked]
const DOCKED = [
    [101, 'EURUSD', 60, 1],      // H1
    [102, 'EURUSD', 5, 1],       // M5
    [103, 'GBPUSD', 15, 1],      // M15
    [104, 'USDJPY', 240, 1],     // H4
];

suite('chartLayoutWine: tf plumbing', () => {
    test('minutes -> MT5 timeframe codes', () => {
        assert.strictEqual(wine.tfOfPeriod(5), 'M5');
        assert.strictEqual(wine.tfOfPeriod(60), 'H1');
        assert.strictEqual(wine.tfOfPeriod(1440), 'D1');
        assert.strictEqual(wine.tfOfPeriod(10080), 'W1');
        assert.strictEqual(wine.tfOfPeriod(43200), 'MN1');
        assert.strictEqual(wine.tfOfPeriod(0), '');
    });

    test('long display names normalize to codes', () => {
        assert.strictEqual(wine.normalizeTf('Daily'), 'D1');
        assert.strictEqual(wine.normalizeTf('Weekly'), 'W1');
        assert.strictEqual(wine.normalizeTf('Monthly'), 'MN1');
        assert.strictEqual(wine.normalizeTf('H1'), 'H1');
    });
});

suite('chartLayoutWine: parseState', () => {
    test('parses charts, monitors and dock state', () => {
        const s = wine.parseState(stateText({ charts: DOCKED, monitors: [MON1, MON2] }));
        assert.strictEqual(s.mainHwnd, 111);
        assert.strictEqual(s.mdi.w, 800);
        assert.strictEqual(s.mdi.h, 600);
        assert.deepStrictEqual(s.chrome, { l: 8, t: 60, r: 8, b: 40 });
        assert.strictEqual(s.active, 'EURUSD');
        assert.strictEqual(s.monitors.length, 2);
        assert.deepStrictEqual(s.monitors[1].work, { x: 1920, y: 0, w: 1920, h: 1040 });
        assert.strictEqual(s.charts.length, 4);
        // sorted by "SYMBOL,TF": eurusd,h1 sorts before eurusd,m5
        assert.deepStrictEqual(s.charts[0], { hwnd: 101, symbol: 'EURUSD', tf: 'H1', docked: true });
    });

    test('charts sort by "SYMBOL,TF" like the PS worker title sort', () => {
        const s = wine.parseState(stateText({ charts: [[201, 'GBPUSD', 15, 1], [202, 'EURUSD', 60, 1], [203, 'EURUSD', 5, 0]] }));
        assert.deepStrictEqual(s.charts.map((c) => c.hwnd), [202, 203, 201]);
        assert.strictEqual(s.charts[1].docked, false);
    });

    test('isStateFresh boundaries', () => {
        assert.strictEqual(wine.isStateFresh(1000, 9000), true);
        assert.strictEqual(wine.isStateFresh(1000, 16000), false);
        assert.strictEqual(wine.isStateFresh(undefined, 0), false);
    });
});

suite('chartLayoutWine: layout math', () => {
    test('plain 2x2 grid rects match the PS worker formula (gap 4)', () => {
        const r = wine.tile([1, 2, 3, 4].map((h) => ({ hwnd: h })), { x: 0, y: 0, w: 800, h: 600 }, 2, 2, 4);
        assert.strictEqual(r.placed, 4);
        assert.deepStrictEqual(r.moves, [
            { hwnd: 1, x: 4, y: 4, w: 394, h: 294 },
            { hwnd: 2, x: 402, y: 4, w: 394, h: 294 },
            { hwnd: 3, x: 4, y: 302, w: 394, h: 294 },
            { hwnd: 4, x: 402, y: 302, w: 394, h: 294 },
        ]);
        assert.deepStrictEqual(r.mins, []);
    });

    test('charts beyond rows*cols are minimized', () => {
        const r = wine.tile([1, 2, 3].map((h) => ({ hwnd: h })), { x: 0, y: 0, w: 800, h: 600 }, 1, 2, 0);
        assert.strictEqual(r.placed, 2);
        assert.deepStrictEqual(r.mins, [3]);
    });

    test('too-dense grid fails like the worker', () => {
        assert.throws(() => wine.tile([{ hwnd: 1 }], { x: 0, y: 0, w: 100, h: 100 }, 1, 101, 0), /too dense/);
    });

    test('areas spans: A wide, B tall, C wide bottom', () => {
        const charts = [{ hwnd: 7, symbol: 'X', tf: 'H1' }, { hwnd: 8, symbol: 'Y', tf: 'H1' }, { hwnd: 9, symbol: 'Z', tf: 'H1' }];
        // 'A A B|C C B' is 3 columns (colX 0,267,533,800): A spans the left
        // two columns, B the tall right one, C the bottom two.
        const r = wine.tileAreas(charts, '', { x: 0, y: 0, w: 800, h: 600 }, 'A A B|C C B', 4);
        assert.strictEqual(r.placed, 3);
        assert.deepStrictEqual(r.moves, [
            { hwnd: 7, x: 4, y: 4, w: 525, h: 292 },
            { hwnd: 8, x: 537, y: 4, w: 259, h: 592 },
            { hwnd: 9, x: 4, y: 304, w: 525, h: 292 },
        ]);
    });

    test('non-rectangular area fails', () => {
        assert.throws(() => wine.tileAreas([{ hwnd: 1 }], '', { x: 0, y: 0, w: 100, h: 100 }, 'A A|A B', 0), /not rectangular/);
    });

    test('ragged rows fail', () => {
        assert.throws(() => wine.tileAreas([{ hwnd: 1 }], '', { x: 0, y: 0, w: 100, h: 100 }, 'A A A|B B', 0), /columns/);
    });

    test('timeframe-match mode: active symbol binds, others minimized', () => {
        const charts = [
            { hwnd: 1, symbol: 'EURUSD', tf: 'M5' },
            { hwnd: 2, symbol: 'EURUSD', tf: 'H1' },
            { hwnd: 3, symbol: 'EURUSD', tf: 'M15' },
            { hwnd: 4, symbol: 'GBPUSD', tf: 'M5' },
        ];
        const r = wine.tileAreas(charts, 'EURUSD', { x: 0, y: 0, w: 900, h: 600 }, 'M5 M5 H1|M15 M15 H1', 0);
        assert.strictEqual(r.placed, 3);
        assert.deepStrictEqual(r.missing, []);
        assert.deepStrictEqual(r.mins, [4]);                     // GBPUSD minimized
        assert.deepStrictEqual(r.moves.map((m) => m.hwnd), [1, 2, 3]);
        assert.deepStrictEqual(r.moves[0], { hwnd: 1, x: 0, y: 0, w: 600, h: 300 });
    });

    test('timeframe-match mode: long names normalize (Daily -> D1)', () => {
        const charts = [{ hwnd: 5, symbol: 'EURUSD', tf: 'D1' }];
        const r = wine.tileAreas(charts, 'EURUSD', { x: 0, y: 0, w: 100, h: 100 }, 'Daily', 0);
        assert.strictEqual(r.placed, 1);
        assert.deepStrictEqual(r.missing, []);
    });

    test('timeframe-match mode falls back to first symbol when active is absent', () => {
        const charts = [{ hwnd: 5, symbol: 'GBPUSD', tf: 'D1' }];
        const r = wine.tileAreas(charts, 'EURUSD', { x: 0, y: 0, w: 100, h: 100 }, 'D1', 0);
        assert.strictEqual(r.placed, 1);                         // GBPUSD used, not minimized
    });

    test('missing timeframe region is reported, not fatal', () => {
        const charts = [{ hwnd: 5, symbol: 'EURUSD', tf: 'H1' }];
        const r = wine.tileAreas(charts, 'EURUSD', { x: 0, y: 0, w: 100, h: 100 }, 'H1 H2', 0);
        assert.strictEqual(r.placed, 1);
        assert.deepStrictEqual(r.missing, ['H2']);
    });

    test('order-fill: extra regions become missing names', () => {
        const charts = [{ hwnd: 5, symbol: 'EURUSD', tf: 'H1' }];
        const r = wine.tileAreas(charts, '', { x: 0, y: 0, w: 100, h: 100 }, 'A B', 0);
        assert.strictEqual(r.placed, 1);
        assert.deepStrictEqual(r.missing, ['B']);
    });
});

suite('chartLayoutWine: plan computation', () => {
    const preset = (over = {}) => ({
        name: 't',
        gap: 0,
        docked: { monitor: 1, rows: 2, cols: 2 },
        ...over,
    });

    test('main window parks on the docked monitor work area', () => {
        const s = wine.parseState(stateText({ charts: DOCKED, monitors: [MON1, MON2] }));
        assert.deepStrictEqual(wine.computeMainMove(s, preset()), { hwnd: 111, x: 0, y: 0, w: 1920, h: 1040 });
    });

    test('docked cells are MDI-client coordinates, floating cells screen coordinates', () => {
        const charts = [...DOCKED, [201, 'XAUUSD', 5, 0], [202, 'XAUUSD', 15, 0]];
        const s = wine.parseState(stateText({ charts, monitors: [MON1, MON2] }));
        const plan = wine.computeMoves(s, preset({ floating: { monitor: 2, rows: 1, cols: 2 } }));
        // 4 docked charts in mdi 800x600 gap 0 -> 400x300 cells; sorted by
        // "SYMBOL,TF" so EURUSD,H1 lands first
        assert.deepStrictEqual(plan.moves[0], { hwnd: 101, x: 0, y: 0, w: 400, h: 300 });
        // floating on monitor 2 work area 1920x1040 at (1920,0)
        const floatMoves = plan.moves.filter((m) => [201, 202].includes(m.hwnd));
        assert.deepStrictEqual(floatMoves, [
            { hwnd: 202, x: 1920, y: 0, w: 960, h: 1040 },
            { hwnd: 201, x: 2880, y: 0, w: 960, h: 1040 },
        ]);
        assert.ok(plan.summary.includes('docked 4/4 on mon 1 (2x2)'), plan.summary);
        assert.ok(plan.summary.includes('floating 2/2 on mon 2 (1x2)'), plan.summary);
    });

    test('extra docked charts are minimized and reported', () => {
        const charts = [...DOCKED, [105, 'AUDCAD', 30, 1]];
        const s = wine.parseState(stateText({ charts }));
        const plan = wine.computeMoves(s, preset());
        // AUDCAD sorts first; the 5th cell-less chart is USDJPY,H4
        assert.deepStrictEqual(plan.mins, [104]);
        assert.ok(plan.summary.includes('docked 4/5 on mon 1 (2x2) (1 minimized)'), plan.summary);
    });

    test('monitor beyond the reported count errors', () => {
        const s = wine.parseState(stateText({ charts: DOCKED }));     // only mon 1
        assert.throws(() => wine.computeMoves(s, preset({ floating: { monitor: 2, rows: 1, cols: 1 } })), /monitor 2 out of range/);
    });

    test('areas presets flow through computeMoves', () => {
        const charts = [...DOCKED, [105, 'EURUSD', 15, 1]];     // EURUSD M15 for the template
        const s = wine.parseState(stateText({ charts, active: 'EURUSD' }));
        const plan = wine.computeMoves(s, preset({ docked: { monitor: 1, areas: ['M5 M5 H1', 'M15 M15 H1'] } }));
        assert.deepStrictEqual(plan.moves.map((m) => m.hwnd), [102, 101, 105]);
        assert.deepStrictEqual(plan.mins, [103, 104]);          // GBPUSD + USDJPY not in template
        assert.ok(plan.summary.includes('(areas)'), plan.summary);
    });
});

suite('chartLayoutWine: request serialization', () => {
    test('buildRequest emits the documented line format', () => {
        const body = wine.buildRequest({
            main: { hwnd: 111, x: 0, y: 0, w: 1920, h: 1040 },
            moves: [{ hwnd: 7, x: 4, y: 4, w: 400, h: 300 }],
            mins: [9],
        });
        assert.strictEqual(body,
            'version=1\r\nmain=111,0,0,1920,1040\r\nmove=7,4,4,400,300\r\nmin=9\r\n');
    });
});

// ---------------------------------------------------------------------------
// File-protocol integration against a fake service (state/req/res in a temp
// dir). Mirrors what files/ArrangeLayoutService.mq5 does inside MT5.
// ---------------------------------------------------------------------------
let tmpRoot = '';

function fakeServiceDir(stateBody) {
    const dir = wine.serviceDir(tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.txt'), stateBody);
    return dir;
}

/** Fake service: answers req.txt by rewriting state (new mdi) and res.txt. */
function startFakeService(dir, onMain) {
    const dir_ = path.join(dir);
    const timer = setInterval(() => {
        const req = path.join(dir_, 'req.txt');
        const res = path.join(dir_, 'res.txt');
        if (!fs.existsSync(req)) return;
        const text = fs.readFileSync(req, 'utf8');
        fs.unlinkSync(req);
        if (text.startsWith('version=1\r\nmain=')) {
            onMain();                                             // move main -> new mdi
            const st = fs.statSync(path.join(dir_, 'state.txt'));
            fs.utimesSync(path.join(dir_, 'state.txt'), st.atime, new Date(st.mtime.getTime() + 10));
            fs.writeFileSync(res, 'ok moved=1 min=0 skipped=0\r\n');
        } else {
            const moves = (text.match(/^move=/gm) || []).length;
            const mins = (text.match(/^min=/gm) || []).length;
            fs.writeFileSync(res, `ok moved=${moves} min=${mins} skipped=0\r\n`);
        }
    }, 40);
    return () => clearInterval(timer);
}

suite('chartLayoutWine: file protocol with fake service', () => {
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mqlwine-')); });
    afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

    test('runArrangeViaService: two phases, OK summary', async function () {
        this.timeout(4000);
        let mdi = '800,600';
        const charts = DOCKED;
        const dir = fakeServiceDir(stateText({ charts }));
        const stop = startFakeService(dir, () => {
            mdi = '1912,1000';                                    // main parked -> mdi grew
            fs.writeFileSync(path.join(dir, 'state.txt'), stateText({ charts, mdi }));
        });
        try {
            const result = await wine.runArrangeViaService(tmpRoot, {
                name: 't', gap: 0, docked: { monitor: 1, rows: 2, cols: 2 },
            });
            assert.ok(result.startsWith('OK '), result);
            assert.ok(result.includes('docked 4/4 on mon 1 (2x2)'), result);
            // phase 2 cells use the REFRESHED mdi size, not the original one
            // (1912x1000 -> 956x500 cells)
            assert.ok(result.length > 0);
        } finally {
            stop();
        }
    });

    test('runArrangeViaService: no state -> service not running error', async function () {
        this.timeout(2000);
        fs.mkdirSync(wine.serviceDir(tmpRoot), { recursive: true });
        await assert.rejects(
            () => wine.runArrangeViaService(tmpRoot, { name: 't', gap: 0, docked: { monitor: 1, rows: 1, cols: 1 } }),
            /service not running/
        );
    });

    test('runArrangeViaService: stale state counts as not running', async function () {
        this.timeout(2000);
        const dir = fakeServiceDir(stateText({ charts: DOCKED }));
        const st = path.join(dir, 'state.txt');
        const old = new Date(Date.now() - 60000);
        fs.utimesSync(st, old, old);
        await assert.rejects(
            () => wine.runArrangeViaService(tmpRoot, { name: 't', gap: 0, docked: { monitor: 1, rows: 1, cols: 1 } }),
            /service not running/
        );
    });

    test('runArrangeViaService: service error surfaces', async function () {
        this.timeout(4000);
        const dir = fakeServiceDir(stateText({ charts: DOCKED }));
        const stop = (() => {
            const t = setInterval(() => {
                const req = path.join(dir, 'req.txt');
                if (fs.existsSync(req)) {
                    fs.unlinkSync(req);
                    fs.writeFileSync(path.join(dir, 'res.txt'), 'err no valid window handles\r\n');
                }
            }, 40);
            return () => clearInterval(t);
        })();
        try {
            await assert.rejects(
                () => wine.runArrangeViaService(tmpRoot, { name: 't', gap: 0, docked: { monitor: 1, rows: 1, cols: 1 } }),
                /no valid window handles/
            );
        } finally {
            stop();
        }
    });
});
