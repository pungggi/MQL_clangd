const assert = require('assert');
const { findTimeframeTypos, TIMEFRAMES } = require('../src/chartLayout');

// Timeframe-shaped typo detection for ChartLayout.Presets "areas" cells.
// A cell is a "suspect" when it looks like a timeframe (optional letters + digits)
// but is not in the MT5 vocabulary — these silently disable timeframe-match mode.

suite('chartLayout: findTimeframeTypos', function () {
    test('returns nothing when every cell is a known timeframe', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['H1 M30 M15 M1 M1', 'H1 M30 M15 M5 M5']),
            []
        );
    });

    test('flags a one-letter typo (N1 instead of M1)', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['H1 M30 M15 N1 M1', 'H1 M30 M15 M5 M5']),
            ['N1']
        );
    });

    test('flags a bare number missing its prefix (30 instead of M30)', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['H1 30 M15 M5 M5']),
            ['30']
        );
    });

    test('flags wrong-digit timeframes (M7, H5, D2, W2, MN2)', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['M7 H5 D2 W2 MN2']),
            ['M7', 'H5', 'D2', 'W2', 'MN2']
        );
    });

    test('leaves free-form span names (A/B/C) alone', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['A A B', 'C C B']),
            []
        );
    });

    test('ignores the "." empty-cell marker', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['. M5 .', 'M15 M15 .']),
            []
        );
    });

    test('deduplicates repeated suspects within and across rows', function () {
        assert.deepStrictEqual(
            findTimeframeTypos(['N1 N1 M5', 'N1 H5 H5']),
            ['N1', 'H5']
        );
    });

    test('returns [] for null / empty input', function () {
        assert.deepStrictEqual(findTimeframeTypos(null), []);
        assert.deepStrictEqual(findTimeframeTypos([]), []);
    });

    test('does not mutate the input rows', function () {
        const input = ['H1 N1 M1'];
        const snapshot = input[0];
        findTimeframeTypos(input);
        assert.strictEqual(input[0], snapshot);
    });
});

suite('chartLayout: TIMEFRAMES vocabulary', function () {
    test('covers the documented MT5 set', function () {
        for (const tf of ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1']) {
            assert.ok(TIMEFRAMES.has(tf), `expected ${tf} in vocabulary`);
        }
    });
});
