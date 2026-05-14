'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseLogSummary } = require('./logParser');

const TESTER_AGENT_LOG_DIR = path.join('Agent-127.0.0.1-3000', 'logs');
const DEFAULT_MAX_SCAN_DEPTH = 5;
const COMPLETION_TIME_SKEW_MS = 2000;
const RUN_LOG_TIMESTAMP_PARTS = ['year', 'month', 'day', 'hours', 'minutes', 'seconds'];
const MAX_TESTER_LOG_BYTES = 50 * 1024 * 1024;

const runningTests = new Map();
let discoveryCache = null;

class BacktestEAInfo {
    constructor(name, dir) {
        this.name = name;
        this.dir = dir;
        this.runsDir = path.join(dir, 'runs');
        this.testerIniPath = path.join(dir, 'tester.ini');
    }

    hasTesterConfig() {
        return fs.existsSync(this.testerIniPath);
    }

    getAllLogs() {
        if (!fs.existsSync(this.runsDir)) return [];
        try {
            return fs.readdirSync(this.runsDir)
                .filter(fileName => fileName.toLowerCase().endsWith('.log'))
                .map(fileName => {
                    const filePath = path.join(this.runsDir, fileName);
                    return { name: fileName, fileName, path: filePath, mtime: fs.statSync(filePath).mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
        } catch {
            return [];
        }
    }

    getLatestLog() {
        return this.getAllLogs()[0] || null;
    }

    getVersion() {
        const sourcePath = path.join(this.dir, `${this.name}.mq5`);
        if (!fs.existsSync(sourcePath)) return null;
        try {
            const match = fs.readFileSync(sourcePath, 'utf8').match(/#property\s+version\s+"([^"]+)"/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }
}

function isDirectory(dir) {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function isBacktestEaDirectory(dir) {
    return fs.existsSync(path.join(dir, 'tester.ini')) || isDirectory(path.join(dir, 'runs'));
}

function discoverBacktestEAs(mql5Root, maxDepth = DEFAULT_MAX_SCAN_DEPTH) {
    if (discoveryCache
        && discoveryCache.mql5Root === mql5Root
        && discoveryCache.maxDepth === maxDepth) {
        return discoveryCache.eas;
    }

    const expertsDir = path.join(mql5Root || '', 'Experts');
    if (!isDirectory(expertsDir)) return [];

    const results = [];
    const seen = new Set();

    function walk(dir, depth) {
        if (depth > maxDepth) return;

        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

        if (isBacktestEaDirectory(dir) && !seen.has(dir)) {
            seen.add(dir);
            results.push(new BacktestEAInfo(path.basename(dir), dir));
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (['runs', 'baselines', 'docs', 'snapshot'].includes(entry.name)) continue;
            walk(path.join(dir, entry.name), depth + 1);
        }
    }

    walk(expertsDir, 0);
    const eas = results.sort((a, b) => a.name.localeCompare(b.name));
    discoveryCache = { mql5Root, maxDepth, eas };
    return eas;
}

function invalidateBacktestEAsCache() {
    discoveryCache = null;
}

function findBacktestEA(mql5Root, eaName) {
    return discoverBacktestEAs(mql5Root).find(ea => ea.name.toLowerCase() === eaName.toLowerCase()) || null;
}

function parseTesterIni(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = { tester: {}, inputs: {} };
    let currentSection = 'tester';

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            currentSection = trimmed.slice(1, -1).toLowerCase();
            if (!result[currentSection]) result[currentSection] = {};
            continue;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex <= 0) continue;

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (currentSection === 'inputs' && value.includes('||')) value = value.split('||')[0];
        result[currentSection][key] = value;
    }

    return result;
}

function testerConfigFromIni(ini) {
    const rawRisk = ini.inputs?.RiskPercentage;
    const parsedRisk = rawRisk === undefined ? NaN : parseFloat(rawRisk);
    return {
        symbol: ini.tester?.Symbol || '',
        fromDate: ini.tester?.FromDate || '',
        toDate: ini.tester?.ToDate || '',
        period: ini.tester?.Period || 'M1',
        riskPercentage: Number.isFinite(parsedRisk) ? parsedRisk : 5.0,
    };
}

function readTesterConfig(ea) {
    if (!ea || !fs.existsSync(ea.testerIniPath)) return null;
    return testerConfigFromIni(parseTesterIni(ea.testerIniPath));
}

function updateTesterIniContent(content, params) {
    const lines = content.split(/\r?\n/);
    const result = [];
    let currentSection = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            currentSection = trimmed.slice(1, -1).toLowerCase();
            result.push(line);
            continue;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const replacement = getTesterIniReplacement(currentSection, key, trimmed.slice(eqIndex + 1), params);
            if (replacement) {
                result.push(replacement);
                continue;
            }
        }

        result.push(line);
    }

    return result.join(os.EOL);
}

function getTesterIniReplacement(section, key, oldValue, params) {
    if (section === 'tester') {
        if (key === 'Symbol' && params.symbol) return `Symbol=${params.symbol}`;
        if (key === 'FromDate' && params.fromDate) return `FromDate=${params.fromDate}`;
        if (key === 'ToDate' && params.toDate) return `ToDate=${params.toDate}`;
    }

    if (section === 'inputs' && key === 'RiskPercentage' && params.riskPercentage !== undefined) {
        const parts = oldValue.split('||');
        parts[0] = String(params.riskPercentage);
        return `RiskPercentage=${parts.join('||')}`;
    }

    return null;
}

function writeTesterIni(sourcePath, targetPath, params) {
    const content = fs.readFileSync(sourcePath, 'utf8');
    const updated = updateTesterIniContent(content, params);
    fs.writeFileSync(targetPath, updated, 'utf8');
    return updated;
}

function listSymbols(mql5Root) {
    const symbols = new Set();

    for (const ea of discoverBacktestEAs(mql5Root)) {
        const config = readTesterConfig(ea);
        if (config?.symbol) symbols.add(config.symbol);

        for (const log of ea.getAllLogs().slice(0, 10)) {
            try {
                const summary = parseLogSummary(log.path);
                if (summary.symbol && summary.symbol !== '?') symbols.add(summary.symbol);
            } catch { /* ignore unreadable logs */ }
        }
    }

    return Array.from(symbols).sort((a, b) => a.localeCompare(b));
}

function findTesterLogDir(mql5Root, configuredDir = '') {
    if (configuredDir && isDirectory(configuredDir)) return configuredDir;
    if (!mql5Root) return null;

    const terminalDataDir = path.dirname(mql5Root);
    const terminalId = path.basename(terminalDataDir);
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const testerTerminalDir = path.join(appData, 'MetaQuotes', 'Tester', terminalId);

    const candidates = [
        path.join(testerTerminalDir, TESTER_AGENT_LOG_DIR),
        ...findAgentLogDirs(testerTerminalDir),
    ].filter((dir, index, dirs) => dir && dirs.indexOf(dir) === index && isDirectory(dir));

    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => getDirMtimeMs(b) - getDirMtimeMs(a))[0];
}

function findAgentLogDirs(testerTerminalDir) {
    if (!isDirectory(testerTerminalDir)) return [];
    try {
        return fs.readdirSync(testerTerminalDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith('Agent-'))
            .map(entry => path.join(testerTerminalDir, entry.name, 'logs'));
    } catch {
        return [];
    }
}

function getDirMtimeMs(dir) {
    try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

function findLatestTesterLog(testerLogDir) {
    if (!isDirectory(testerLogDir)) return null;
    try {
        return fs.readdirSync(testerLogDir)
            .filter(fileName => fileName.toLowerCase().endsWith('.log'))
            .map(fileName => {
                const filePath = path.join(testerLogDir, fileName);
                return { name: fileName, path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
    } catch {
        return null;
    }
}

function readTesterLog(logPath) {
    try {
        const size = fs.statSync(logPath).size;
        if (size > MAX_TESTER_LOG_BYTES) return '';
        const buffer = fs.readFileSync(logPath);
        return looksLikeUtf16Le(buffer) ? buffer.toString('utf16le') : buffer.toString('utf8');
    } catch {
        return '';
    }
}

function looksLikeUtf16Le(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true;
    if (buffer.length < 4) return false;

    let zeroOddBytes = 0;
    let sampledOddBytes = 0;
    const sampleLength = Math.min(buffer.length, 512);
    for (let i = 1; i < sampleLength; i += 2) {
        sampledOddBytes++;
        if (buffer[i] === 0) zeroOddBytes++;
    }
    return sampledOddBytes > 0 && zeroOddBytes / sampledOddBytes > 0.3;
}

function countTesterStops(logPath) {
    if (!logPath || !fs.existsSync(logPath)) return 0;
    const matches = readTesterLog(logPath).match(/MetaTester 5 stopped/g);
    return matches ? matches.length : 0;
}

function isTesterLogComplete(logPath, eaName, expectedStopCount = 1) {
    const content = readTesterLog(logPath);
    if (!content) return false;

    const stopCount = (content.match(/MetaTester 5 stopped/g) || []).length;
    if (stopCount < expectedStopCount) return false;

    return content.includes(eaName)
        && (content.includes('SIMULATED TRADING SUMMARY')
            || content.includes(`${eaName} deinitialized`)
            || content.includes('final balance'));
}

function resolveTerminalPath(rawTerminalPath, fallbackPaths = []) {
    const candidates = [rawTerminalPath, ...fallbackPaths].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function startBacktest(options) {
    const { mql5Root, eaName, params, terminalPath, testerLogDir } = options;
    const ea = findBacktestEA(mql5Root, eaName);
    if (!ea) return { started: false, code: 'EA_NOT_FOUND', message: 'EA not found' };
    if (runningTests.has(ea.dir)) return { started: false, code: 'ALREADY_RUNNING', message: 'Test already running for this EA' };
    if (!ea.hasTesterConfig()) return { started: false, code: 'NO_TESTER_INI', message: 'No tester.ini found in EA folder' };
    if (!terminalPath) return { started: false, code: 'NO_TERMINAL', message: 'MT5 terminal not found' };

    const logDir = findTesterLogDir(mql5Root, testerLogDir);
    if (!logDir) {
        return { started: false, code: 'NO_TESTER_LOG_DIR', message: 'Strategy Tester agent log directory not found. Configure mql_tools.Backtest.TesterLogDir.' };
    }

    const mql5TesterIni = path.join(mql5Root, 'tester.ini');
    try {
        writeTesterIni(ea.testerIniPath, mql5TesterIni, params);
    } catch (error) {
        return { started: false, code: 'WRITE_FAILED', message: `Failed to write tester.ini: ${error.message}` };
    }

    const latestAtStart = findLatestTesterLog(logDir);
    const startTime = Date.now();

    let child;
    try {
        child = spawn(terminalPath, [`/config:${mql5TesterIni}`], { detached: true, stdio: 'ignore' });
    } catch (error) {
        return { started: false, code: 'LAUNCH_FAILED', message: `Failed to launch MT5 terminal: ${error.message}` };
    }

    const effectiveConfig = { ...readTesterConfig(ea), ...params, eaVersion: ea.getVersion() || 'Unknown' };
    runningTests.set(ea.dir, {
        pid: child.pid,
        process: child,
        startTime,
        ea,
        logDir,
        latestLogPathAtStart: latestAtStart?.path || null,
        initialStopCount: latestAtStart ? countTesterStops(latestAtStart.path) : 0,
        config: effectiveConfig,
    });

    child.unref();
    return { started: true, pid: child.pid, config: effectiveConfig };
}

function getBacktestStatus(mql5Root, eaName) {
    const ea = findBacktestEA(mql5Root, eaName);
    if (!ea) return { running: false };
    const running = runningTests.get(ea.dir);
    if (!running) return { running: false };

    const latestLog = findLatestTesterLog(running.logDir);
    if (latestLog && latestLog.mtimeMs >= running.startTime - COMPLETION_TIME_SKEW_MS) {
        const expectedStops = latestLog.path === running.latestLogPathAtStart ? running.initialStopCount + 1 : 1;
        if (isTesterLogComplete(latestLog.path, eaName, expectedStops)) {
            const logName = copyTesterLogToRuns(running.ea, latestLog.path);
            runningTests.delete(ea.dir);
            return { running: false, status: 'completed', logName: logName || latestLog.name };
        }
    }

    return { running: true, startTime: running.startTime, elapsed: Date.now() - running.startTime, pid: running.pid };
}

function cancelBacktest(mql5Root, eaName) {
    const ea = findBacktestEA(mql5Root, eaName);
    if (!ea) return false;
    return cancelByDir(ea.dir);
}

function cancelByDir(dir) {
    const running = runningTests.get(dir);
    if (!running) return false;

    if (process.platform === 'win32' && running.pid) {
        try { spawnSync('taskkill', ['/PID', String(running.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    } else if (running.pid) {
        let killed = false;
        try { process.kill(-running.pid, 'SIGTERM'); killed = true; } catch { /* fall through */ }
        if (!killed && running.process) {
            try { running.process.kill(); } catch { /* ignore */ }
        }
    }

    runningTests.delete(dir);
    return true;
}

function cancelAllBacktests() {
    for (const dir of Array.from(runningTests.keys())) cancelByDir(dir);
}

function copyTesterLogToRuns(ea, testerLogPath) {
    if (!ea || !testerLogPath || !fs.existsSync(testerLogPath)) return null;
    fs.mkdirSync(ea.runsDir, { recursive: true });

    const logFileName = `${formatRunTimestamp(new Date())}.log`;
    const destPath = path.join(ea.runsDir, logFileName);
    fs.copyFileSync(testerLogPath, destPath);
    return logFileName;
}

function formatRunTimestamp(date) {
    const values = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hours: date.getHours(),
        minutes: date.getMinutes(),
        seconds: date.getSeconds(),
    };
    const parts = RUN_LOG_TIMESTAMP_PARTS.map(part => String(values[part]).padStart(part === 'year' ? 4 : 2, '0'));
    return `${parts[0]}${parts[1]}${parts[2]}_${parts[3]}${parts[4]}${parts[5]}`;
}

module.exports = {
    BacktestEAInfo,
    discoverBacktestEAs,
    invalidateBacktestEAsCache,
    findBacktestEA,
    parseTesterIni,
    testerConfigFromIni,
    readTesterConfig,
    updateTesterIniContent,
    writeTesterIni,
    listSymbols,
    findTesterLogDir,
    findLatestTesterLog,
    countTesterStops,
    isTesterLogComplete,
    resolveTerminalPath,
    startBacktest,
    getBacktestStatus,
    cancelBacktest,
    cancelAllBacktests,
};