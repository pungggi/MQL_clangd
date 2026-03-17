const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseLine, RE_EA_LINE, RE_LIVELOG_LINE, RE_DETECT_EA, parseLogFile } = require('../src/logParser');

suite('Log Parser Reproduction Tests', () => {
    test('Comment 9: parseLine should handle 4-column lines correctly', () => {
        // HASH\t0\tTIMESTAMP\tMESSAGE
        const line = 'KI\t0\t22:57:25.438\tTesting started';
        const result = parseLine(line);
        
        assert.strictEqual(result.wallclock, '22:57:25.438');
        // Now source should be empty for 4-col lines
        assert.strictEqual(result.source, '');
        assert.strictEqual(result.payload, 'Testing started');
    });

    test('Comment 3: EA/LiveLog lines with milliseconds', () => {
        const payloadWithMs = '2026.02.13 00:00:00.123   [MyEA] INFO {File:Func:123}: msg';
        const match = payloadWithMs.match(RE_EA_LINE);
        assert.ok(match, 'Should match payload with milliseconds');
        assert.strictEqual(match[1], 'MyEA');
        assert.strictEqual(match[2], 'INFO');
        assert.strictEqual(match[3], 'File');
        assert.strictEqual(match[4], 'Func');
        assert.strictEqual(match[5], '123');
        assert.strictEqual(match[6], 'msg');

        const liveLogWithMs = '2026.02.13 00:00:00.123   [INFO] {File:Func:123}: msg';
        const matchLive = liveLogWithMs.match(RE_LIVELOG_LINE);
        assert.ok(matchLive, 'Should match LiveLog payload with milliseconds');
        assert.strictEqual(matchLive[1], 'INFO');
        assert.strictEqual(matchLive[2], 'File');
        assert.strictEqual(matchLive[3], 'Func');
        assert.strictEqual(matchLive[4], '123');
        assert.strictEqual(matchLive[5], 'msg');
    });

    test('Comment 7: EA detection with tabs (via parseLine and RE_DETECT_EA)', () => {
        const rawLine = 'CS\t0\t22:57:25.438\tMyEA (EURUSD,M1)\t2026.02.13 00:00:00   [MyEA] INFO {File:Func:123}: msg';
        const { payload } = parseLine(rawLine);
        assert.ok(payload.includes('[MyEA] INFO'), 'Payload should contain EA info');
        
        const m = payload.match(RE_DETECT_EA);
        assert.ok(m, 'Should detect EA from payload');
        assert.strictEqual(m[1], 'MyEA');
    });

    test('Incomplete trade detection in parseLogFile', () => {
        const logPath = path.join(os.tmpdir(), `incomplete_trade_${crypto.randomUUID()}.log`);
        
        // Log with two consecutive orders without fill/exit/pnl for the first one
        const content = 
            'HASH\t0\t2026.03.15 10:00:00\tTester\tEURUSD,M1: testing of MyEA from 2026.01.01 to 2026.02.01 started\n' +
            'HASH\t0\t2026.03.15 10:00:01\tMyEA (EURUSD,M1)\t2026.03.15 10:00:01   [MyEA] INFO {File:Func:1}: SIMULATED BUY MARKET\n' +
            'HASH\t0\t2026.03.15 10:00:02\tMyEA (EURUSD,M1)\t2026.03.15 10:00:02   [MyEA] INFO {File:Func:2}: SIMULATED SELL MARKET\n';
            
        fs.writeFileSync(logPath, content, 'utf8');
        
        try {
            const warnings = [];
            const logger = {
                warn: (msg) => warnings.push(msg)
            };
            
            const result = parseLogFile(logPath, { logger });
            
            assert.strictEqual(result.incompleteTrades.length, 1, 'Should have one incomplete trade');
            assert.strictEqual(result.incompleteTrades[0].type, 'buy', 'The incomplete trade should be the first one (buy)');
            assert.strictEqual(warnings.length, 1, 'Should have emitted one warning');
            assert.ok(warnings[0].includes('Incomplete trade detected at line 2'), 'Warning message should mention line 2');
        } finally {
            if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
        }
    });
});
