import { createChart, CandlestickSeries, LineSeries } from 'lightweight-charts';
// Mock Data for Initial Test if market_data.json is missing
const mockData = Array.from({ length: 100 }, (_, i) => ({
    time: 1600000000 + i * 3600,
    open: 100 + Math.random() * 10,
    high: 110 + Math.random() * 10,
    low: 90 + Math.random() * 10,
    close: 105 + Math.random() * 10,
    volume: Math.floor(Math.random() * 1000)
}));

let currentChart = null;
let candlestickSeries = null;

// DOM Elements
const inputEl = document.getElementById('strategy-input');
const btnVisualize = document.getElementById('btn-visualize');
const btnCode = document.getElementById('btn-code');
const statusEl = document.getElementById('status-msg');
const chartContainer = document.getElementById('chart-container');
const mqlOutput = document.getElementById('mql-output');

// Event Listeners
btnVisualize.addEventListener('click', handleVisualize);
btnCode.addEventListener('click', handleGenerateCode);
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleVisualize();
    }
});

async function loadData() {
    try {
        // Fetch from root as configured in Webpack
        const response = await fetch('/market_data.json');
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        return data;
    } catch (e) {
        console.warn('Could not load market_data.json, using mock data.', e);
        return mockData;
    }
}

async function handleVisualize() {
    const strategy = inputEl.value;
    if (!strategy) {
        statusEl.textContent = "Please enter a strategy description.";
        return;
    }

    statusEl.textContent = "Loading data...";
    const data = await loadData();

    statusEl.textContent = "Generating visualization...";

    // -------------------------------------------------------------------------
    // RENDER WITH LIGHTWEIGHT CHARTS
    // -------------------------------------------------------------------------

    // Clear previous chart
    chartContainer.innerHTML = '';

    const chartOptions = {
        layout: {
            textColor: '#d4d4d4',
            background: { type: 'solid', color: '#1e1e1e' }
        },
        grid: {
            vertLines: { color: '#333' },
            horzLines: { color: '#333' }
        },
        timeScale: {
            timeVisible: true,
            borderColor: '#333'
        }
    };

    currentChart = createChart(chartContainer, chartOptions);

    candlestickSeries = currentChart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
    });

    // Map data to Lightweight Charts format
    // expects { time, open, high, low, close }
    // time should be unix timestamp (seconds). Our data is seconds.
    const candleData = data.map(d => ({
        time: d.time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close
    }));

    // Sort just in case
    candleData.sort((a, b) => a.time - b.time);

    candlestickSeries.setData(candleData);

    // Indicators logic
    if (strategy.toLowerCase().includes('sma')) {
        console.log("Adding SMA");
        const smaSeries = currentChart.addSeries(LineSeries, {
            color: '#2962FF',
            lineWidth: 2,
            title: 'SMA 20'
        });

        const smaData = data.map((d, i, arr) => {
            const period = 20;
            if (i < period) return null;
            const slice = arr.slice(i - period, i);
            const avg = slice.reduce((sum, curr) => sum + curr.close, 0) / period;
            return { time: d.time, value: avg };
        }).filter(d => d !== null);

        smaData.sort((a, b) => a.time - b.time);
        smaSeries.setData(smaData);
    }

    currentChart.timeScale().fitContent();
    statusEl.textContent = "Visualization updated (Provider: Lightweight Charts).";
    mqlOutput.style.display = 'none';
}

// remove renderChart function as it is replaced by inline logic above or keep empty
function renderChart(options) {
    // Deprecated
}


async function handleGenerateCode() {
    const strategy = inputEl.value;
    statusEl.textContent = "Generating MQL code...";

    // -------------------------------------------------------------------------
    // MOCK AI AGENT LOGIC: Strategy Description -> MQL Code
    // -------------------------------------------------------------------------

    let mqlCode = `// Expert Advisor for: ${strategy}\n\n`;
    mqlCode += `#include <Trade/Trade.mqh>\nCTrade trade;\n\n`;
    mqlCode += `void OnTick() {\n`;

    if (strategy.toLowerCase().includes('sma')) {
        mqlCode += `   // SMA Strategy Logic\n`;
        mqlCode += `   double maFast = iMA(_Symbol, _Period, 20, 0, MODE_SMA, PRICE_CLOSE, 0);\n`;
        mqlCode += `   double maSlow = iMA(_Symbol, _Period, 50, 0, MODE_SMA, PRICE_CLOSE, 0);\n`;
        mqlCode += `   \n   if(maFast > maSlow) trade.Buy(0.1);\n`;
    } else {
        mqlCode += `   // Placeholder logic\n   Print("Running strategy: ${strategy}");\n`;
    }

    mqlCode += `}\n`;

    // -------------------------------------------------------------------------

    mqlOutput.style.display = 'block';
    mqlOutput.textContent = mqlCode;
    statusEl.textContent = "Code generated.";
}

// Global scope for HTML access
window.toggleSpeech = function () {
    alert("Speech-to-Text would activate here (using Web Speech API).");
}
