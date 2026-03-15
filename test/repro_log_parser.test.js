const assert = require('assert');
const { parseLine, RE_EA_LINE, RE_LIVELOG_LINE, RE_TIMESTAMP_PREFIX } = require('../src/logParser');

const RE_DETECT_EA = new RegExp(`(?:\\[([^\\]]+)\\]\\s+(?:INFO|DEBUG|TRADE|ERROR|WARN)\\s)`);

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
    });

    test('Comment 7: EA detection with tabs (via parseLine and RE_DETECT_EA)', () => {
        const rawLine = 'CS\t0\t22:57:25.438\tMyEA (EURUSD,M1)\t2026.02.13 00:00:00   [MyEA] INFO {File:Func:123}: msg';
        const { payload } = parseLine(rawLine);
        assert.ok(payload.includes('[MyEA] INFO'), 'Payload should contain EA info');
        
        const m = payload.match(RE_DETECT_EA);
        assert.ok(m, 'Should detect EA from payload');
        assert.strictEqual(m[1], 'MyEA');
    });
});
