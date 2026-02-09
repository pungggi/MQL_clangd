/**
 * Chart Context Builder - Creates LLM-ready context from chart selections
 */

import {
    getParentCandle,
    aggregateCandles,
    getCandlesInSameHTF,
    formatTime,
    getTimeframeName,
    TIMEFRAMES
} from './timeframeUtils.js';

/**
 * Analyze single candle characteristics
 * @param {object} candle - Candle with open, high, low, close
 * @returns {object} Candle analysis
 */
function analyzeCandleType(candle) {
    const { open, high, low, close } = candle;
    const body = Math.abs(close - open);
    const range = high - low;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const isBullish = close > open;

    // Calculate ratios
    const bodyRatio = range > 0 ? body / range : 0;
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;

    // Identify pattern type
    let pattern = 'Standard';

    if (bodyRatio < 0.1) {
        pattern = 'Doji';
    } else if (bodyRatio > 0.8) {
        pattern = 'Marubozu';
    } else if (lowerWickRatio > 0.6 && upperWickRatio < 0.1) {
        pattern = isBullish ? 'Hammer' : 'Hanging Man';
    } else if (upperWickRatio > 0.6 && lowerWickRatio < 0.1) {
        pattern = 'Shooting Star';
    } else if (bodyRatio < 0.3 && upperWickRatio > 0.3 && lowerWickRatio > 0.3) {
        pattern = 'Spinning Top';
    }

    return {
        isBullish,
        body: body,
        range: range,
        upperWick: upperWick,
        lowerWick: lowerWick,
        bodyRatio: (bodyRatio * 100).toFixed(1),
        pattern
    };
}

/**
 * Analyze relationship between two consecutive candles
 * @param {object} prev - Previous candle
 * @param {object} curr - Current candle
 * @returns {string} Relationship pattern
 */
function analyzeRelationship(prev, curr) {
    if (!prev) return 'First candle';

    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);
    const prevBullish = prev.close > prev.open;
    const currBullish = curr.close > curr.open;

    // Inside bar
    if (curr.high <= prev.high && curr.low >= prev.low) {
        return 'Inside Bar';
    }

    // Outside bar (Engulfing)
    if (curr.high > prev.high && curr.low < prev.low) {
        return currBullish ? 'Bullish Engulfing' : 'Bearish Engulfing';
    }

    // Harami
    if (currBody < prevBody * 0.5 &&
        curr.high < prev.high && curr.low > prev.low &&
        prevBullish !== currBullish) {
        return currBullish ? 'Bullish Harami' : 'Bearish Harami';
    }

    return 'Continuation';
}

/**
 * ChartContextBuilder - Main class for building LLM context
 */
export class ChartContextBuilder {
    constructor(data, timeframeMinutes = 60) {
        this.data = data; // Array of { time, open, high, low, close, volume }
        this.timeframe = timeframeMinutes;
        this.selectedIndex = null;
        this.selectedCandle = null;
    }

    /**
     * Select a candle by index
     * @param {number} index - Index in data array
     * @returns {this} For chaining
     */
    selectCandle(index) {
        if (index >= 0 && index < this.data.length) {
            this.selectedIndex = index;
            this.selectedCandle = this.data[index];
        }
        return this;
    }

    /**
     * Get surrounding candles
     * @param {number} before - Number of candles before
     * @param {number} after - Number of candles after
     * @returns {object[]} Surrounding candles with analysis
     */
    getSurroundingCandles(before = 5, after = 2) {
        if (this.selectedIndex === null) return [];

        const start = Math.max(0, this.selectedIndex - before);
        const end = Math.min(this.data.length, this.selectedIndex + after + 1);

        return this.data.slice(start, end).map((candle, i) => {
            const absoluteIndex = start + i;
            const prevCandle = absoluteIndex > 0 ? this.data[absoluteIndex - 1] : null;

            return {
                ...candle,
                isSelected: absoluteIndex === this.selectedIndex,
                analysis: analyzeCandleType(candle),
                relationship: analyzeRelationship(prevCandle, candle)
            };
        });
    }

    /**
     * Get higher timeframe context
     * @returns {object[]} Array of HTF parent info
     */
    getHTFContext() {
        if (!this.selectedCandle) return [];

        const htfList = [
            { name: 'H4', minutes: 240 },
            { name: 'D1', minutes: 1440 }
        ];

        // Filter to only show HTFs higher than current
        const relevantHTFs = htfList.filter(htf => htf.minutes > this.timeframe);

        return relevantHTFs.map(htf => {
            const timestamp = this.selectedCandle.time * 1000; // Convert to ms
            const parent = getParentCandle(timestamp, this.timeframe, htf.minutes);

            // Get candles in this HTF period and aggregate them
            const candlesInHTF = getCandlesInSameHTF(
                this.data,
                timestamp,
                this.timeframe,
                htf.minutes
            );

            const aggregatedHTF = aggregateCandles(candlesInHTF);
            const htfAnalysis = aggregatedHTF ? analyzeCandleType(aggregatedHTF) : null;

            return {
                name: htf.name,
                startTime: formatTime(parent.startTime),
                endTime: formatTime(parent.endTime),
                position: parent.position,
                totalCandles: parent.totalCandles,
                isComplete: parent.isComplete,
                analysis: htfAnalysis
            };
        });
    }

    /**
     * Build markdown-formatted context for LLM
     * @param {string} userQuestion - Optional user question
     * @returns {string} Markdown context
     */
    toMarkdown(userQuestion = 'Identify this pattern and its significance') {
        if (!this.selectedCandle) {
            return '## No candle selected\nPlease click on a candle to analyze.';
        }

        const candle = this.selectedCandle;
        const analysis = analyzeCandleType(candle);
        const prevCandle = this.selectedIndex > 0 ? this.data[this.selectedIndex - 1] : null;
        const relationship = analyzeRelationship(prevCandle, candle);

        let md = '';

        // Selected Candle Section
        md += `## Selected Candle\n`;
        md += `- **Timeframe**: ${getTimeframeName(this.timeframe)} | **Time**: ${formatTime(candle.time)}\n`;
        md += `- **OHLC**: O:${candle.open.toFixed(5)} H:${candle.high.toFixed(5)} L:${candle.low.toFixed(5)} C:${candle.close.toFixed(5)}\n`;
        md += `- **Type**: ${analysis.isBullish ? 'Bullish' : 'Bearish'} | Body: ${analysis.bodyRatio}% of range\n`;
        md += `- **Pattern**: ${analysis.pattern}\n`;
        md += `- **Vs Previous**: ${relationship}\n\n`;

        // Higher Timeframe Context
        const htfContext = this.getHTFContext();
        if (htfContext.length > 0) {
            md += `## Higher Timeframe Context\n`;
            for (const htf of htfContext) {
                md += `### ${htf.name} Parent\n`;
                md += `- Range: ${htf.startTime} to ${htf.endTime}\n`;
                md += `- Position: Candle ${htf.position} of ${htf.totalCandles} (${htf.isComplete ? 'Complete' : 'Forming'})\n`;
                if (htf.analysis) {
                    md += `- ${htf.name} Type: ${htf.analysis.isBullish ? 'Bullish' : 'Bearish'} ${htf.analysis.pattern}\n`;
                }
                md += `\n`;
            }
        }

        // Surrounding Bars
        const surrounding = this.getSurroundingCandles(5, 2);
        if (surrounding.length > 0) {
            md += `## Surrounding Bars\n`;
            md += `| Time | O | H | L | C | Pattern | Rel |\n`;
            md += `|------|---|---|---|---|---------|-----|\n`;
            for (const bar of surrounding) {
                const marker = bar.isSelected ? '→' : '';
                md += `| ${marker}${formatTime(bar.time)} | ${bar.open.toFixed(5)} | ${bar.high.toFixed(5)} | ${bar.low.toFixed(5)} | ${bar.close.toFixed(5)} | ${bar.analysis.pattern} | ${bar.relationship} |\n`;
            }
            md += `\n`;
        }

        // User Question
        md += `## Question\n${userQuestion}\n`;

        return md;
    }

    /**
     * Build JSON context (for programmatic use)
     * @returns {object} JSON context
     */
    toJSON() {
        if (!this.selectedCandle) return null;

        const candle = this.selectedCandle;
        const analysis = analyzeCandleType(candle);
        const prevCandle = this.selectedIndex > 0 ? this.data[this.selectedIndex - 1] : null;

        return {
            selected: {
                time: formatTime(candle.time),
                ohlc: { o: candle.open, h: candle.high, l: candle.low, c: candle.close },
                analysis,
                relationship: analyzeRelationship(prevCandle, candle)
            },
            timeframe: getTimeframeName(this.timeframe),
            htfContext: this.getHTFContext(),
            surrounding: this.getSurroundingCandles(5, 2)
        };
    }
}

export default ChartContextBuilder;
