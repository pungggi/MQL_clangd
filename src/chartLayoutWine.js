'use strict';
/**
 * Arrange MT5 Charts — Wine / Linux / macOS backend.
 *
 * The PowerShell worker cannot run outside Windows (it P/Invokes user32), and
 * X11 tools cannot see MT5's docked MDI charts at all (Wine renders child
 * windows inside its own surface). Instead, a tiny MT5 service
 * (files/ArrangeLayoutService.mq5) runs INSIDE the terminal — under Wine it
 * goes through Wine's own user32 — and acts as a dumb executor:
 *
 *   state.txt  service -> extension : chart hwnds, symbols, timeframes,
 *                                dock state, monitor geometry, main window
 *   req.txt    extension -> service : concrete window moves ("move=h,x,y,w,h")
 *   res.txt    service -> extension : "ok moved=N min=M" or "err <why>"
 *
 * All layout math (grids, areas, timeframe matching, minimizing extras) lives
 * HERE in JS — one implementation, unit-tested, shared by the command and the
 * visual editor. The service never needs to change when the layout logic
 * evolves. The Windows/PowerShell path in chartLayout.js is untouched; this
 * backend is selected only when process.platform !== 'win32'.
 *
 * This module must stay vscode-free (pure fs) so it is trivially testable.
 */

const fs = require('fs');
const path = require('path');

const DIR_NAME = 'mql_clangd_arrange';
const STATE_FILE = 'state.txt';
const REQ_FILE = 'req.txt';
const RES_FILE = 'res.txt';
/** state older than this (ms) means the service is not running. */
const STATE_MAX_AGE_MS = 15000;
/** how long to wait for the service to answer a request. */
const RES_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Timeframe plumbing (ports of NormalizeTf / TF_BARE from the PS worker).
// The service reports ChartPeriod() in minutes; region names in areas
// templates use MT5's TF codes or the three long display names.
// ---------------------------------------------------------------------------

const TF_BARE = new Set([
    'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30',
    'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1', 'MN1',
    'Daily', 'Weekly', 'Monthly',
]);

const PERIOD_TO_TF = new Map([
    [1, 'M1'], [2, 'M2'], [3, 'M3'], [4, 'M4'], [5, 'M5'], [6, 'M6'],
    [10, 'M10'], [12, 'M12'], [15, 'M15'], [20, 'M20'], [30, 'M30'],
    [60, 'H1'], [120, 'H2'], [180, 'H3'], [240, 'H4'], [360, 'H6'],
    [480, 'H8'], [720, 'H12'], [1440, 'D1'], [10080, 'W1'], [43200, 'MN1'],
]);

function normalizeTf(tf) {
    if (tf === 'Daily') return 'D1';
    if (tf === 'Weekly') return 'W1';
    if (tf === 'Monthly') return 'MN1';
    return tf;
}

function tfOfPeriod(periodMinutes) {
    return PERIOD_TO_TF.get(Math.trunc(Number(periodMinutes) || 0)) || '';
}

// ---------------------------------------------------------------------------
// state.txt parsing
// ---------------------------------------------------------------------------

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

/**
 * Parse the service's state.txt into a plain object:
 *   { mainHwnd, mdi:{w,h}, chrome:{l,t,r,b}, active,
 *     monitors:[{index,x,y,w,h,work:{x,y,w,h}}],
 *     charts:[{hwnd,symbol,tf,docked}] }
 */
function parseState(text) {
    const state = {
        mainHwnd: 0, mdi: { w: 0, h: 0 }, chrome: { l: 0, t: 0, r: 0, b: 0 },
        active: '', monitors: [], charts: [],
    };
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key === 'main') state.mainHwnd = toInt(val);
        else if (key === 'active') state.active = val.trim();
        else if (key === 'mdi') {
            const p = val.split(',');
            if (p.length >= 2) state.mdi = { w: toInt(p[0]), h: toInt(p[1]) };
        } else if (key === 'chrome') {
            const p = val.split(',');
            if (p.length >= 4) state.chrome = { l: toInt(p[0]), t: toInt(p[1]), r: toInt(p[2]), b: toInt(p[3]) };
        } else if (key === 'mon') {
            const p = val.split(';');
            if (p.length >= 9) {
                state.monitors.push({
                    index: toInt(p[0]),
                    x: toInt(p[1]), y: toInt(p[2]), w: toInt(p[3]), h: toInt(p[4]),
                    work: { x: toInt(p[5]), y: toInt(p[6]), w: toInt(p[7]), h: toInt(p[8]) },
                });
            }
        } else if (key === 'chart') {
            const p = val.split(';');
            if (p.length >= 4) {
                state.charts.push({
                    hwnd: toInt(p[0]),
                    symbol: p[1],
                    tf: tfOfPeriod(p[2]),
                    docked: p[3].trim() === '1',
                });
            }
        }
    }
    // Window title sort order, like the PS worker's Sort-Object Title:
    // charts order as "SYMBOL,TF" strings (case-insensitive).
    const key = (c) => `${c.symbol},${c.tf}`.toLowerCase();
    state.charts.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    state.monitors.sort((a, b) => a.index - b.index);
    return state;
}

function isStateFresh(mtimeMs, nowMs, maxAgeMs = STATE_MAX_AGE_MS) {
    return typeof mtimeMs === 'number' && (nowMs - mtimeMs) < maxAgeMs;
}

// ---------------------------------------------------------------------------
// Layout math — direct port of Tile / TileAreas / PlaceRegion from
// scripts/mt5-arrange-charts.ps1, operating on chart objects instead of
// hwnds. All rects are the VISIBLE cell rects; the service expands
// top-level windows by their invisible resize frame when applying.
// ---------------------------------------------------------------------------

function workArea(state, monitorNo) {
    const m = state.monitors[monitorNo - 1];
    if (!m) throw new Error(`monitor ${monitorNo} out of range (1..${state.monitors.length || 0})`);
    return m.work;
}

// Plain rows x cols tiling. Returns { placed, moves, mins }.
function tile(charts, box, rows, cols, gap) {
    const moves = [], mins = [];
    const cellW = Math.floor((box.w - gap * (cols + 1)) / cols);
    const cellH = Math.floor((box.h - gap * (rows + 1)) / rows);
    if (cellW <= 0 || cellH <= 0) throw new Error(`grid ${rows}x${cols} too dense for ${box.w}x${box.h}`);
    const cells = rows * cols;
    charts.forEach((ch, i) => {
        if (i >= cells) { mins.push(ch.hwnd); return; }
        const r = Math.floor(i / cols);
        const c = i % cols;
        moves.push({
            hwnd: ch.hwnd,
            x: box.x + gap + c * (cellW + gap),
            y: box.y + gap + r * (cellH + gap),
            w: cellW, h: cellH,
        });
    });
    return { placed: Math.min(charts.length, cells), moves, mins };
}

// One chart into region e = {minR,maxR,minC,maxC} of the unit grid.
function placeRegion(out, hwnd, e, box, colX, rowY, gap) {
    const x = box.x + colX[e.minC] + gap;
    const y = box.y + rowY[e.minR] + gap;
    const w = (colX[e.maxC + 1] - colX[e.minC]) - 2 * gap;
    const h = (rowY[e.maxR + 1] - rowY[e.minR]) - 2 * gap;
    if (w <= 0 || h <= 0) throw new Error(`areas grid too dense at gap ${gap}`);
    out.push({ hwnd, x, y, w, h });
}

/**
 * grid-template-areas tiling. `areasStr` is rows joined by '|'. Port of the
 * PS TileAreas: rectangular-region validation, timeframe-match mode when every
 * region name is a timeframe (bound to activeSymbol, others minimized),
 * order-fill otherwise. Returns { placed, missing, moves, mins }.
 */
function tileAreas(charts, activeSymbol, box, areasStr, gap) {
    const grid = String(areasStr || '').split('|').map((row) => row.trim().split(/\s+/).filter((c) => c !== ''))
        .filter((cells) => cells.length > 0);
    const nRows = grid.length;
    if (nRows === 0) throw new Error('empty areas template');
    const nCols = grid[0].length;
    for (const g of grid) {
        if (g.length !== nCols) throw new Error(`areas rows must all have ${nCols} columns`);
    }

    // Pixel boundaries per column/row edge (rounding-safe; no cumulative drift).
    const colX = [], rowY = [];
    for (let i = 0; i <= nCols; i++) colX.push(Math.round((i * box.w) / nCols));
    for (let i = 0; i <= nRows; i++) rowY.push(Math.round((i * box.h) / nRows));

    // Regions in reading order with bounding boxes; each must be a rectangle.
    const order = [];
    const ext = new Map();
    for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < nCols; c++) {
            const t = grid[r][c];
            if (t === '.') continue;
            if (!ext.has(t)) { order.push(t); ext.set(t, { minR: r, maxR: r, minC: c, maxC: c }); }
            else {
                const e = ext.get(t);
                e.minR = Math.min(e.minR, r); e.maxR = Math.max(e.maxR, r);
                e.minC = Math.min(e.minC, c); e.maxC = Math.max(e.maxC, c);
            }
        }
    }
    for (const t of order) {
        const e = ext.get(t);
        for (let r = e.minR; r <= e.maxR; r++) {
            for (let c = e.minC; c <= e.maxC; c++) {
                if (grid[r][c] !== t) throw new Error(`area '${t}' is not rectangular`);
            }
        }
    }

    const moves = [], mins = [];
    let placed = 0;
    const missing = [];

    const tfMode = order.length > 0 && order.every((name) => TF_BARE.has(name));
    if (tfMode) {
        // Bind to the active chart's symbol; fall back to the first symbol
        // present so we never minimize the whole group.
        let sym = activeSymbol;
        if (!sym || !charts.some((c) => c.symbol === sym)) {
            sym = charts.length ? charts.slice().sort((a, b) => (a.symbol < b.symbol ? -1 : 1))[0].symbol : '';
        }
        const done = new Set();
        for (const name of order) {
            const match = charts.find((c) => !done.has(c.hwnd) && c.symbol === sym && c.tf === normalizeTf(name));
            if (match) {
                placeRegion(moves, match.hwnd, ext.get(name), box, colX, rowY, gap);
                done.add(match.hwnd); placed++;
            } else missing.push(name);
        }
        for (const c of charts) if (!done.has(c.hwnd)) mins.push(c.hwnd);
    } else {
        charts.forEach((c, i) => {
            if (i >= order.length) { mins.push(c.hwnd); return; }
            placeRegion(moves, c.hwnd, ext.get(order[i]), box, colX, rowY, gap);
            placed++;
        });
        for (let i = charts.length; i < order.length; i++) missing.push(order[i]);
    }
    return { placed, missing, moves, mins };
}

// ---------------------------------------------------------------------------
// Plan computation from a state snapshot + preset
// ---------------------------------------------------------------------------

/**
 * Where the MT5 main window should go: the docked monitor's work area, like
 * the PS worker (always issued, even if the window is already there — the
 * subsequent MDIClient resize keeps docked math exact).
 */
function computeMainMove(state, preset) {
    const wa = workArea(state, preset.docked.monitor);
    return { hwnd: state.mainHwnd, x: wa.x, y: wa.y, w: wa.w, h: wa.h };
}

/**
 * Full move/minimize plan for both chart groups against a (post-main-move)
 * state snapshot. Returns { moves, mins, summary } — summary mirrors the PS
 * worker's "docked P/T on mon M (grid) ..." message.
 */
function computeMoves(state, preset) {
    const gap = preset.gap || 0;
    const moves = [], mins = [];
    const dockedCharts = state.charts.filter((c) => c.docked);
    const floatingCharts = state.charts.filter((c) => !c.docked);
    let summary = '';

    // --- docked group: cells are MDIClient-client coordinates ---
    {
        const box = { x: 0, y: 0, w: state.mdi.w, h: state.mdi.h };
        const g = preset.docked;
        let placed = 0;
        const missing = [];
        if (dockedCharts.length > 0) {
            if (g.areas) {
                const r = tileAreas(dockedCharts, state.active, box, g.areas.join('|'), gap);
                placed = r.placed; missing.push(...r.missing);
                moves.push(...r.moves); mins.push(...r.mins);
            } else {
                const r = tile(dockedCharts, box, g.rows, g.cols, gap);
                placed = r.placed;
                moves.push(...r.moves); mins.push(...r.mins);
            }
        }
        const label = g.areas ? 'areas' : `${g.rows}x${g.cols}`;
        const extra = dockedCharts.length - placed;
        summary += `docked ${placed}/${dockedCharts.length} on mon ${g.monitor} (${label})`;
        if (extra > 0) summary += ` (${extra} minimized)`;
        if (missing.length) summary += ` [missing: ${missing.join(', ')}]`;
    }

    // --- floating group (optional): screen coordinates on its monitor ---
    if (preset.floating) {
        const wa = workArea(state, preset.floating.monitor);
        const box = { x: wa.x, y: wa.y, w: wa.w, h: wa.h };
        const g = preset.floating;
        let placed = 0;
        const missing = [];
        if (floatingCharts.length > 0) {
            if (g.areas) {
                const r = tileAreas(floatingCharts, state.active, box, g.areas.join('|'), gap);
                placed = r.placed; missing.push(...r.missing);
                moves.push(...r.moves); mins.push(...r.mins);
            } else {
                const r = tile(floatingCharts, box, g.rows, g.cols, gap);
                placed = r.placed;
                moves.push(...r.moves); mins.push(...r.mins);
            }
        }
        const label = g.areas ? 'areas' : `${g.rows}x${g.cols}`;
        const extra = floatingCharts.length - placed;
        summary += `; floating ${placed}/${floatingCharts.length} on mon ${g.monitor} (${label})`;
        if (extra > 0) summary += ` (${extra} minimized)`;
        if (missing.length) summary += ` [missing: ${missing.join(', ')}]`;
    }

    return { moves, mins, summary };
}

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------

/** req.txt body from { main?, moves:[], mins:[] }. Visible rects. */
function buildRequest(plan) {
    const lines = ['version=1'];
    if (plan.main) lines.push(`main=${plan.main.hwnd},${plan.main.x},${plan.main.y},${plan.main.w},${plan.main.h}`);
    for (const m of plan.moves || []) lines.push(`move=${m.hwnd},${m.x},${m.y},${m.w},${m.h}`);
    for (const h of plan.mins || []) lines.push(`min=${h}`);
    return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Orchestration: two phases (main window first — the MDIClient resizes, so
// docked cell rects are computed from a refreshed state snapshot).
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One arrange at a time per service directory: the req/res protocol has a
// single slot, so two overlapping runs (command + editor) would overwrite
// each other's request. Calls queue here and keep their own results.
const inflight = new Map();   // dir -> tail promise (never rejects)

function serviceDir(filesRoot) { return path.join(filesRoot, DIR_NAME); }

function readState(dir) {
    try {
        const p = path.join(dir, STATE_FILE);
        const text = fs.readFileSync(p, 'utf8');
        return { state: parseState(text), mtimeMs: fs.statSync(p).mtimeMs };
    } catch {
        return null;
    }
}

function writeReq(dir, body) {
    const p = path.join(dir, REQ_FILE);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);
}

/** Poll res.txt until its content changes to a fresh ok/err line. */
async function waitResult(dir, sentAtMs, timeoutMs = RES_TIMEOUT_MS) {
    const p = path.join(dir, RES_FILE);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const st = fs.statSync(p);
            if (st.mtimeMs >= sentAtMs) {
                const line = fs.readFileSync(p, 'utf8').trim();
                if (line.startsWith('ok')) return line;
                if (line.startsWith('err')) throw new Error(line.replace(/^err\s*/, '').trim() || 'service error');
            }
        } catch (e) {
            if (e.message && !/ENOENT/.test(e.message) && !e.message.startsWith('service') && e.message !== 'service error') throw e;
        }
        if (Date.now() > deadline) throw new Error('Arrange service did not answer — is it running? (see docs/chart-layout.md, Wine setup)');
        await sleep(150);
    }
}

/**
 * Arrange `preset` through the service living under `<filesRoot>` (= the
 * terminal's MQL5/Files folder). Resolves with an "OK ..." summary line
 * compatible with the PowerShell backend, rejects with a readable error.
 */
async function arrangeViaServiceInner(filesRoot, preset) {
    const dir = serviceDir(filesRoot);
    const probe = readState(dir);
    if (!probe || !isStateFresh(probe.mtimeMs, Date.now())) {
        throw new Error('Arrange service not running — start ArrangeLayoutService in MT5 (see docs/chart-layout.md, Wine setup)');
    }
    if (probe.state.charts.length === 0) throw new Error('no charts open in MT5');

    // Phase 1: park the main window on the docked monitor (always, like PS).
    const sent1 = Date.now() - 1;
    writeReq(dir, buildRequest({ main: computeMainMove(probe.state, preset) }));
    await waitResult(dir, sent1);

    // Phase 2: re-read state (the service refreshes it after moving main —
    // MDIClient has a new size), then send the concrete chart moves. If the
    // refresh never happens, abort instead of planning with the stale MDI
    // size: the cells would not match the moved window.
    let snap = null;
    let refreshed = false;
    for (let i = 0; i < 40; i++) {
        snap = readState(dir);
        if (snap && snap.mtimeMs > probe.mtimeMs) { refreshed = true; break; }
        await sleep(100);
    }
    if (!refreshed) {
        throw new Error('service did not refresh state.txt after moving the main window — docked cells would use the old MDI size');
    }
    if (!snap) throw new Error('lost state.txt while arranging');
    const plan = computeMoves(snap.state, preset);
    if (plan.moves.length || plan.mins.length) {
        const sent2 = Date.now() - 1;
        writeReq(dir, buildRequest(plan));
        await waitResult(dir, sent2);
    }
    return `OK ${plan.summary}`;
}

/** Queued entry point (see `inflight`). */
async function runArrangeViaService(filesRoot, preset) {
    const key = serviceDir(filesRoot);
    const prior = inflight.get(key) || Promise.resolve();
    const task = prior.catch(() => { }).then(() => arrangeViaServiceInner(filesRoot, preset));
    const tail = task.finally(() => { if (inflight.get(key) === tail) inflight.delete(key); });
    inflight.set(key, tail);
    return task;
}

module.exports = {
    buildRequest,
    computeMainMove,
    computeMoves,
    computePlan: computeMoves, // alias for early drafts/tests
    isStateFresh,
    parseState,
    runArrangeViaService,
    serviceDir,
    tile,
    tileAreas,
    tfOfPeriod,
    normalizeTf,
};
