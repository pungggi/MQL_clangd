/**
 * Timeframe utilities for multi-timeframe analysis
 */

// Timeframe hierarchy: minutes per bar
export const TIMEFRAMES = {
    M1: 1,
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
    H4: 240,
    D1: 1440,
    W1: 10080
};

// Timeframe display names
export const TIMEFRAME_NAMES = {
    1: 'M1',
    5: 'M5',
    15: 'M15',
    30: 'M30',
    60: 'H1',
    240: 'H4',
    1440: 'D1',
    10080: 'W1'
};

/**
 * Get higher timeframes relative to current
 * @param {number} currentTF - Current timeframe in minutes
 * @returns {number[]} Array of higher timeframes in minutes
 */
export function getHigherTimeframes(currentTF) {
    const tfValues = Object.values(TIMEFRAMES);
    return tfValues.filter(tf => tf > currentTF);
}

/**
 * Calculate which parent candle on HTF contains the given LTF candle
 * @param {number} timestamp - Unix timestamp of LTF candle
 * @param {number} ltfMinutes - Lower timeframe in minutes
 * @param {number} htfMinutes - Higher timeframe in minutes
 * @returns {object} Parent candle info
 */
export function getParentCandle(timestamp, ltfMinutes, htfMinutes) {
    const htfMs = htfMinutes * 60 * 1000;
    const parentStart = Math.floor(timestamp / htfMs) * htfMs;
    const parentEnd = parentStart + htfMs;

    // Calculate which candle of the HTF this is (1-indexed)
    const candlePosition = Math.floor((timestamp - parentStart) / (ltfMinutes * 60 * 1000)) + 1;
    const totalCandles = htfMinutes / ltfMinutes;

    return {
        startTime: parentStart,
        endTime: parentEnd,
        position: candlePosition,
        totalCandles: totalCandles,
        isComplete: candlePosition >= totalCandles
    };
}

/**
 * Aggregate LTF candles into a single HTF candle
 * @param {object[]} candles - Array of LTF candles with { time, open, high, low, close, volume }
 * @returns {object} Aggregated HTF candle
 */
export function aggregateCandles(candles) {
    if (!candles || candles.length === 0) return null;

    return {
        time: candles[0].time,
        open: candles[0].open,
        high: Math.max(...candles.map(c => c.high)),
        low: Math.min(...candles.map(c => c.low)),
        close: candles[candles.length - 1].close,
        volume: candles.reduce((sum, c) => sum + (c.volume || 0), 0)
    };
}

/**
 * Get candles belonging to the same HTF parent
 * @param {object[]} allCandles - All LTF candles
 * @param {number} targetTimestamp - Timestamp of selected candle
 * @param {number} ltfMinutes - Lower timeframe in minutes
 * @param {number} htfMinutes - Higher timeframe in minutes
 * @returns {object[]} Candles in the same HTF period
 */
export function getCandlesInSameHTF(allCandles, targetTimestamp, ltfMinutes, htfMinutes) {
    const parent = getParentCandle(targetTimestamp, ltfMinutes, htfMinutes);

    return allCandles.filter(c => {
        const t = c.time * 1000; // Convert to ms if needed
        return t >= parent.startTime && t < parent.endTime;
    });
}

/**
 * Format timestamp for display
 * @param {number} timestamp - Unix timestamp (seconds or milliseconds)
 * @returns {string} Formatted date string
 */
export function formatTime(timestamp) {
    // Handle both seconds and milliseconds
    const ms = timestamp > 10000000000 ? timestamp : timestamp * 1000;
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/**
 * Get timeframe name from minutes
 * @param {number} minutes - Timeframe in minutes
 * @returns {string} Timeframe name
 */
export function getTimeframeName(minutes) {
    return TIMEFRAME_NAMES[minutes] || `M${minutes}`;
}
