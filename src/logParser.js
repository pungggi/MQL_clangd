'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Generalized MT5 tester log parser.
 * Reads a tester log file (UTF-16LE or UTF-8), auto-detects the EA name,
 * extracts trades, log entries, test config, and summary statistics.
 */

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function readFileWithEncoding(filePath) {
    const buffer = fs.readFileSync(filePath);
    // UTF-16 LE BOM
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        // strip BOM char
        return buffer.toString('utf16le').replace(/^\uFEFF/, '');
    }
    // UTF-8 BOM
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return buffer.toString('utf8').slice(1);
    }
    return buffer.toString('utf8');
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/**
 * MT5 tester log line format (tab-separated columns):
 *   HASH\t0\tTIMESTAMP\tSOURCE\tMESSAGE
 *
 * EA output lines look like:
 *   CS\t0\t22:57:25.438\tFVG_SupportsFVGMacro (EPH26,M1)\t2026.02.13 00:00:00   [FVG_SupportsFVGMacro] INFO {File:Func:Line}: msg
 *
 * We care about the message part after the EA column.
 */

const RE_TIMESTAMP_PATTERN = /\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?/.source;
const RE_TIMESTAMP_PREFIX = `(?:${RE_TIMESTAMP_PATTERN}\\s*)?`;

// Format A (MT5 Tester): [EAName] LEVEL {File:Func:Line}: message
const RE_EA_LINE = new RegExp(`^\\s*${RE_TIMESTAMP_PREFIX}\\[([^\\]]+)\\]\\s+(INFO|DEBUG|TRADE|ERROR|WARN)\\s+(?:\\{([^:}]+):([^:}]+):(\\d+)\\}:\\s*)?(.+)$`);

// Format B (LiveLog):    [LEVEL] {File:Func:Line}: message
const RE_LIVELOG_LINE = new RegExp(`^\\s*${RE_TIMESTAMP_PREFIX}\\[(INFO|DEBUG|TRADE|ERROR|WARN)\\]\\s+(?:\\{([^:}]+):([^:}]+):(\\d+)\\}:\\s*)?(.+)$`);

const RE_EXTRACT_TIMESTAMP = new RegExp(`(${RE_TIMESTAMP_PATTERN})`);
const RE_DETECT_EA = new RegExp('(?:\\[([^\\]]+)\\]\\s+(?:INFO|DEBUG|TRADE|ERROR|WARN)\\s)');

function parseLine(text) {
    // Split on tabs — MT5 tester logs are tab-delimited
    const parts = text.split('\t');
    // Typical: hash, 0, wallclock, source, payload
    // EA lines have 5+ parts; system lines have 4-5 parts with "Tester", "Network", etc.
    const source = parts.length >= 5 ? parts[3].trim() : '';
    const payload = parts.length >= 5 ? parts.slice(4).join('\t').trim() : (parts.length >= 4 ? parts[3].trim() : text);

    return { source, payload };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse an MT5 tester log file.
 * @param {string} logPath - Absolute path to the .log file
 * @param {object} options - Optional: { logger }
 * @returns {object} Parsed data
 */
function parseLogFile(logPath, options = {}) {
    const logger = options.logger || console;
    const content = readFileWithEncoding(logPath);
    const rawLines = content.split(/\r?\n/);

    // ---- Auto-detect EA name ------------------------------------------------
    // Format A: [EAName] LEVEL ... → EA name is in the first bracket
    // Format B: [LEVEL] {File:...} → no EA name in brackets, try Tester source col
    let eaName = null;
    for (let i = 0; i < Math.min(rawLines.length, 200); i++) {
        const { payload } = parseLine(rawLines[i]);
        if (!payload) continue;
        const m = payload.match(RE_DETECT_EA);
        if (m && !['INFO', 'DEBUG', 'TRADE', 'ERROR', 'WARN'].includes(m[1])) {
            eaName = m[1];
            break;
        }
    }
    // Fallback: extract EA name from Tester "testing of" line or log file name
    if (!eaName) {
        for (let i = 0; i < Math.min(rawLines.length, 50); i++) {
            const m = rawLines[i].match(/testing of\s+(.+?)\s+from/);
            if (m) { eaName = m[1].replace(/\.ex[45]$/i, ''); break; }
        }
    }

    // ---- Parse all lines into structured entries ----------------------------
    const allEntries = [];  // { lineNumber, timestamp, level, message, sourceFile, sourceFunc, sourceLine, raw }
    const trades = [];
    const incompleteTrades = [];
    let currentTrade = null;

    // Test config extraction
    let symbol = null;
    let testFrom = null;
    let testTo = null;
    let testTimeframe = null;
    let initialDeposit = null;
    let leverage = null;
    let testModel = null;
    let eaFile = null;
    let finalBalance = null;

    // Summary from the EA's own summary block (if present)
    let logSummary = null;

    for (let i = 0; i < rawLines.length; i++) {
        const lineNumber = i + 1;
        const raw = rawLines[i];
        if (!raw.trim()) continue;

        const { source, payload } = parseLine(raw);

        // ---- Extract test config from system (Tester) lines -----------------
        if (source === 'Tester' || source.startsWith('Tester')) {
            const testingMatch = payload.match(/(\S+),(M\d+):\s+testing of\s+(.+?)\s+from\s+(\S+\s+\S+)\s+to\s+(\S+\s+\S+)\s+started/);
            if (testingMatch) {
                symbol = testingMatch[1];
                testTimeframe = testingMatch[2];
                eaFile = testingMatch[3];
                testFrom = testingMatch[4];
                testTo = testingMatch[5];
            }
            if (!symbol) {
                const symMatch = payload.match(/^(\S+),(M\d+):\s+every tick/);
                if (symMatch) { symbol = symMatch[1]; testTimeframe = symMatch[2]; testModel = 'Every Tick'; }
                const symMatch2 = payload.match(/^(\S+),(M\d+):\s+real ticks/);
                if (symMatch2) { symbol = symMatch2[1]; testTimeframe = symMatch2[2]; testModel = 'Real Ticks'; }
            }
            const depMatch = payload.match(/initial deposit\s+([\d.]+)\s+(\w+),\s*leverage\s+(\S+)/);
            if (depMatch) { initialDeposit = depMatch[1]; leverage = depMatch[3]; }
            const balMatch = payload.match(/final balance\s+([\d.]+)/);
            if (balMatch) { finalBalance = balMatch[1]; }
            if (payload.includes('every tick')) testModel = testModel || 'Every Tick';
            if (payload.includes('real ticks')) testModel = testModel || 'Real Ticks';
        }

        // ---- Parse EA log entries -------------------------------------------
        // Try Format A first (MT5 Tester): [EAName] LEVEL {File:Func:Line}: msg
        // Then Format B (LiveLog):          [LEVEL] {File:Func:Line}: msg
        let level, srcFile, srcFunc, srcLine, message;
        const eaMatch = payload.match(RE_EA_LINE);
        if (eaMatch) {
            [, , level, srcFile, srcFunc, srcLine, message] = eaMatch;
        } else {
            const liveMatch = payload.match(RE_LIVELOG_LINE);
            if (!liveMatch) continue;
            [, level, srcFile, srcFunc, srcLine, message] = liveMatch;
        }

        // Extract the simulated timestamp from the payload (e.g. "2026.02.13 15:20:00")
        const tsMatch = payload.match(RE_EXTRACT_TIMESTAMP);
        const timestamp = tsMatch ? tsMatch[1] : '';

        const entry = {
            lineNumber,
            timestamp,
            level,
            message,
            sourceFile: srcFile || '',
            sourceFunc: srcFunc || '',
            sourceLine: srcLine || '',
            raw
        };
        allEntries.push(entry);

        // ---- Trade state machine --------------------------------------------
        // Order placement
        const orderMatch = message.match(/SIMULATED (SELL|BUY) (LIMIT ORDER|STOP ORDER|MARKET|LIMIT|STOP)/i);
        if (orderMatch) {
            // If we had an incomplete trade, save it to incompleteTrades
            if (currentTrade) {
                incompleteTrades.push(currentTrade);
                logger.warn(`[logParser] Incomplete trade detected at line ${currentTrade.orderLine}. Symbol: ${currentTrade.symbol}, TS: ${currentTrade.timestamp}`);
            }
            currentTrade = {
                type: orderMatch[1].toLowerCase(),
                orderLine: lineNumber,
                orderSourceFile: srcFile,
                orderSourceFunc: srcFunc,
                orderSourceLine: srcLine,
                timestamp,
                entryPrice: null,
                sl: null,
                tp: null,
                lots: null,
                fillLine: null,
                fillTime: null,
                exitReason: null,
                exitLine: null,
                closePrice: null,
                closeTime: null,
                grossPnl: null,
                commission: null,
                netPnl: null,
                symbol: symbol
            };
            continue;
        }

        if (currentTrade) {
            // Entry details line: Entry: 6848.25 | SL: 6854.50 | TP: 6830.00 (swing) | Lots: 1.00
            const detailMatch = message.match(/Entry:\s*([\d.]+)\s*\|\s*SL:\s*([\d.]+)\s*\|\s*TP:\s*([\d.]+)(?:\s*\([^)]*\))?\s*\|\s*Lots:\s*([\d.]+)/);
            if (detailMatch) {
                currentTrade.entryPrice = parseFloat(detailMatch[1]);
                currentTrade.sl = parseFloat(detailMatch[2]);
                currentTrade.tp = parseFloat(detailMatch[3]);
                currentTrade.lots = parseFloat(detailMatch[4]);
                continue;
            }

            // Alternate detail format: Entry: 1.08500  SL: 1.08400  TP: 1.08700  Lots: 0.10
            const detailMatch2 = message.match(/Entry:\s*([\d.]+)\s+SL:\s*([\d.]+)\s+TP:\s*([\d.]+)\s+Lots:\s*([\d.]+)/);
            if (detailMatch2) {
                currentTrade.entryPrice = parseFloat(detailMatch2[1]);
                currentTrade.sl = parseFloat(detailMatch2[2]);
                currentTrade.tp = parseFloat(detailMatch2[3]);
                currentTrade.lots = parseFloat(detailMatch2[4]);
                continue;
            }

            // Fill
            if (message.includes('SIMULATED FILL')) {
                currentTrade.fillLine = lineNumber;
                currentTrade.fillTime = timestamp;
                continue;
            }

            // Exit
            const exitMatch = message.match(/SIMULATED EXIT:\s*(.+?)\s*===/);
            if (exitMatch) {
                currentTrade.exitReason = exitMatch[1].trim();
                currentTrade.exitLine = lineNumber;
                currentTrade.exitSourceFile = srcFile;
                currentTrade.exitSourceFunc = srcFunc;
                currentTrade.exitSourceLine = srcLine;
                currentTrade.closeTime = timestamp;
                continue;
            }

            // Close price
            const closeMatch = message.match(/(LONG|SHORT) closed at ([\d.]+)\s*\(entry:\s*([\d.]+)\)/);
            if (closeMatch) {
                currentTrade.closePrice = parseFloat(closeMatch[2]);
                continue;
            }

            // P&L — this completes the trade
            const pnlMatch = message.match(/Gross P&L:\s*\$?([-\d.]+)\s*\|\s*Commission:\s*\$?([\d.]+)\s*\|\s*Net P&L:\s*\$?([-\d.]+)/);
            if (pnlMatch) {
                currentTrade.grossPnl = parseFloat(pnlMatch[1]);
                currentTrade.commission = parseFloat(pnlMatch[2]);
                currentTrade.netPnl = parseFloat(pnlMatch[3]);
                trades.push(currentTrade);
                currentTrade = null;
                continue;
            }
        }

        // ---- Log summary block from EA (optional) ---------------------------
        const totalMatch = message.match(/Total Trades:\s*(\d+)/);
        if (totalMatch && !logSummary) {
            logSummary = { totalTrades: parseInt(totalMatch[1]) };
        }
        if (logSummary) {
            const wrMatch = message.match(/Wins:\s*(\d+)\s*\|\s*Losses:\s*(\d+)\s*\|\s*Win Rate:\s*([\d.]+)%/);
            if (wrMatch) {
                logSummary.wins = parseInt(wrMatch[1]);
                logSummary.losses = parseInt(wrMatch[2]);
                logSummary.winRate = parseFloat(wrMatch[3]);
            }
            const gpMatch = message.match(/Gross Profit:\s*\$?([\d.]+)\s*\|\s*Gross Loss:\s*\$?([\d.]+)/);
            if (gpMatch) {
                logSummary.grossProfit = parseFloat(gpMatch[1]);
                logSummary.grossLoss = parseFloat(gpMatch[2]);
            }
            const commMatch = message.match(/Total Commissions:\s*\$?([\d.]+)/);
            if (commMatch) { logSummary.totalCommissions = parseFloat(commMatch[1]); }
            const netMatch = message.match(/NET P&L:\s*\$?([-\d.]+)/);
            if (netMatch) { logSummary.netPnl = parseFloat(netMatch[1]); }
        }
    }

    // Push any incomplete trade remaining after the loop
    if (currentTrade) {
        incompleteTrades.push(currentTrade);
        currentTrade = null;
    }

    // ---- Compute summary from parsed trades ---------------------------------
    const wins = trades.filter(t => t.netPnl > 0).length;
    const losses = trades.filter(t => t.netPnl < 0).length;
    const breakeven = trades.filter(t => t.netPnl === 0).length;
    const grossProfit = trades.reduce((s, t) => s + (t.grossPnl > 0 ? t.grossPnl : 0), 0);
    const grossLoss = trades.reduce((s, t) => s + (t.grossPnl < 0 ? t.grossPnl : 0), 0);
    const totalCommission = trades.reduce((s, t) => s + (t.commission || 0), 0);
    const netPnl = trades.reduce((s, t) => s + (t.netPnl || 0), 0);
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

    return {
        logPath,
        logFileName: path.basename(logPath),
        eaName: eaName || 'Unknown EA',
        testConfig: {
            symbol: symbol || '?',
            timeframe: testTimeframe || '?',
            from: testFrom || '?',
            to: testTo || '?',
            eaFile: eaFile || '?',
            initialDeposit: initialDeposit || '?',
            leverage: leverage || '?',
            testModel: testModel || '?',
            finalBalance: finalBalance || '?'
        },
        trades,
        incompleteTrades,
        allEntries,
        summary: {
            tradeCount: trades.length,
            wins,
            losses,
            breakeven,
            winRate,
            grossProfit,
            grossLoss,
            commission: totalCommission,
            netPnl
        },
        logSummary
    };
}

// ---------------------------------------------------------------------------
// Find latest tester log under a given EA runs directory
// ---------------------------------------------------------------------------

/**
 * Find the latest .log file in a directory (sorted by mtime descending).
 * @param {string} dir - Directory to scan
 * @returns {string|null} - Absolute path to latest log, or null
 */
function findLatestLog(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    try {
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.log'))
            .map(f => {
                const fp = path.join(dir, f);
                return { path: fp, mtime: fs.statSync(fp).mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
        return files.length > 0 ? files[0].path : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// EA discovery — scan Experts/ tree for directories containing runs/*.log
// ---------------------------------------------------------------------------

/**
 * Recursively find EA directories that contain a runs/ folder with .log files.
 * @param {string} expertsDir - Absolute path to MQL5/Experts (or MQL4/Experts)
 * @returns {object[]} Array of { name, dir, runsDir, runs[] } sorted by latest run
 */
function discoverEAs(expertsDir) {
    if (!expertsDir || !fs.existsSync(expertsDir)) return [];

    const results = [];

    function walk(dir, depth) {
        if (depth > 5) return; // safety limit
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        // Resolve where to look for .log files for this EA dir.
        // Priority: runs/ → runs/runs/ → EA dir itself (name-matched only).
        const runsDir = path.join(dir, 'runs');
        const nestedRunsDir = path.join(runsDir, 'runs');
        const dirName = path.basename(dir).toLowerCase();

        let logsSourceDir = null;
        const tryDirs = [
            { d: runsDir, nameMatch: false },
            { d: nestedRunsDir, nameMatch: false },
            { d: dir, nameMatch: true }
        ];
        for (const { d, nameMatch } of tryDirs) {
            if (!fs.existsSync(d)) continue;
            try {
                const hasLogs = fs.readdirSync(d).some(f => {
                    if (!f.endsWith('.log')) return false;
                    return nameMatch ? path.basename(f, '.log').toLowerCase() === dirName : true;
                });
                if (hasLogs) { logsSourceDir = { d, nameMatch }; break; }
            } catch { /* skip */ }
        }

        if (logsSourceDir) {
            try {
                const { d, nameMatch } = logsSourceDir;
                const logs = fs.readdirSync(d)
                    .filter(f => {
                        if (!f.endsWith('.log')) return false;
                        return nameMatch ? path.basename(f, '.log').toLowerCase() === dirName : true;
                    })
                    .map(f => {
                        const fp = path.join(d, f);
                        let mtime;
                        try { mtime = fs.statSync(fp).mtime; } catch { mtime = new Date(0); }
                        return { fileName: f, path: fp, mtime };
                    })
                    .sort((a, b) => b.mtime - a.mtime);

                if (logs.length > 0) {
                    results.push({ name: path.basename(dir), dir, runsDir: d, runs: logs });
                }
            } catch { /* skip unreadable */ }
        }

        // Recurse into subdirectories (but skip runs/ itself)
        for (const ent of entries) {
            if (ent.isDirectory() && ent.name !== 'runs' && ent.name !== 'baselines' && ent.name !== 'docs' && ent.name !== 'snapshot') {
                walk(path.join(dir, ent.name), depth + 1);
            }
        }
    }

    walk(expertsDir, 0);

    // Sort EAs by most recent run first
    results.sort((a, b) => b.runs[0].mtime - a.runs[0].mtime);
    return results;
}

/**
 * Quick-parse: extract only summary info from a log without full entry parsing.
 * Much faster than parseLogFile for dashboard overview.
 * @param {string} logPath
 * @returns {object} { eaName, symbol, timeframe, from, to, tradeCount, netPnl, winRate }
 */
function parseLogSummary(logPath) {
    const content = readFileWithEncoding(logPath);
    const lines = content.split(/\r?\n/);

    let eaName = null;
    let symbol = null;
    let timeframe = null;
    let testFrom = null;
    let testTo = null;
    let tradeCount = 0;
    let netPnl = 0;
    let wins = 0;
    let losses = 0;
    let breakeven = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim()) continue;
        const { source, payload } = parseLine(raw);

        // EA name (skip level-only brackets from LiveLog format)
        if (!eaName) {
            const m = payload.match(RE_DETECT_EA);
            if (m && !['INFO', 'DEBUG', 'TRADE', 'ERROR', 'WARN'].includes(m[1])) eaName = m[1];
        }
        if (!eaName && (source === 'Tester' || source.startsWith('Tester'))) {
            const tm = payload.match(/testing of\s+(.+?)\s+from/);
            if (tm) eaName = tm[1].replace(/\.ex[45]$/i, '');
        }

        // Test config from Tester lines
        if (source === 'Tester' || source.startsWith('Tester')) {
            const tm = payload.match(/(\S+),(M\d+):\s+testing of\s+.+?\s+from\s+(\S+\s+\S+)\s+to\s+(\S+\s+\S+)\s+started/);
            if (tm) { symbol = tm[1]; timeframe = tm[2]; testFrom = tm[3]; testTo = tm[4]; }
        }

        // Trade P&L lines — count trades and accumulate net P&L
        const pnlMatch = payload.match(/Net P&L:\s*\$?([-\d.]+)/);
        if (pnlMatch && payload.match(/Gross P&L:/)) {
            tradeCount++;
            const pnl = parseFloat(pnlMatch[1]);
            netPnl += pnl;
            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;
            else breakeven++;
        }
    }

    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

    return {
        eaName: eaName || path.basename(logPath, '.log'),
        symbol: symbol || '?',
        timeframe: timeframe || '?',
        from: testFrom || '?',
        to: testTo || '?',
        tradeCount,
        netPnl,
        wins,
        losses,
        breakeven,
        winRate
    };
}

module.exports = { parseLogFile, findLatestLog, discoverEAs, parseLogSummary, parseLine, RE_TIMESTAMP_PATTERN, RE_TIMESTAMP_PREFIX, RE_EA_LINE, RE_LIVELOG_LINE, RE_DETECT_EA };
