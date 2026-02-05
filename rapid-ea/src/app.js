import * as echarts from 'echarts';
// Mock Data for Initial Test if market_data.json is missing
const mockData = Array.from({ length: 1000 }, (_, i) => ({
    time: 1600000000 + i * 3600,
    open: 100 + Math.random() * 10,
    high: 110 + Math.random() * 10,
    low: 90 + Math.random() * 10,
    close: 105 + Math.random() * 10,
    volume: Math.floor(Math.random() * 1000)
}));

let currentChart = null;

// DOM Elements
const inputEl = document.getElementById('strategy-input');
const btnVisualize = document.getElementById('btn-visualize');
const btnCode = document.getElementById('btn-code');
const statusEl = document.getElementById('status-msg');
const chartContainer = document.getElementById('chart-container');
const mqlOutput = document.getElementById('mql-output');
const btnScan = document.getElementById('btn-scan');
const codebaseList = document.getElementById('codebase-list');

// Event Listeners
btnVisualize.addEventListener('click', handleVisualize);
btnCode.addEventListener('click', handleGenerateCode);
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleVisualize();
    }
});

if (btnScan) {
    btnScan.addEventListener('click', () => {
        if (vscode) {
            btnScan.textContent = "Scanning...";
            vscode.postMessage({ command: 'scanCodebase' });
        } else {
            alert("This feature requires the VS Code Extension.");
        }
    });
}

// Handle window resize
window.addEventListener('resize', () => {
    if (currentChart) {
        currentChart.resize();
    }
});

// VS Code API Access
let vscode = null;
try {
    vscode = acquireVsCodeApi();
} catch (e) {
    console.log("Not running in VS Code Webview");
}

async function loadData() {
    if (vscode) {
        // Request data from Extension
        statusEl.textContent = "Requesting data from VS Code Extension...";
        vscode.postMessage({ command: 'requestData' });

        // Wait for response
        return new Promise((resolve, reject) => {
            const listen = (event) => {
                const message = event.data;
                if (message.command === 'receiveData') {
                    window.removeEventListener('message', listen);
                    if (message.error) {
                        reject(message.error);
                    } else {
                        resolve(message.data);
                    }
                } else if (message.command === 'codebaseScanned') {
                    // Update the UI with found files
                    if (codebaseList) {
                        codebaseList.innerHTML = message.files.length > 0
                            ? message.files.map(f => `<li>${f}</li>`).join('')
                            : "<li>No .mqh files found</li>";
                    }
                    if (btnScan) btnScan.textContent = "Scan";
                }
            };
            window.addEventListener('message', listen);
        });
    } else {
        // Fallback: Fetch from root (Standalone/Dev Server)
        try {
            const response = await fetch('/market_data.json');
            if (!response.ok) throw new Error('Network response was not ok');
            return await response.json();
        } catch (e) {
            console.warn('Could not load market_data.json, using mock data.', e);
            return mockData;
        }
    }
}

async function handleVisualize() {
    const strategy = inputEl.value;
    if (!strategy) {
        statusEl.textContent = "Please enter a strategy description.";
        return;
    }

    statusEl.textContent = "Loading data...";

    let data;
    try {
        data = await loadData();
    } catch (e) {
        statusEl.textContent = "Error loading data: " + e;
        return;
    }

    statusEl.textContent = "Generating visualization...";

    // -------------------------------------------------------------------------
    // RENDER WITH APACHE ECHARTS (LWC Style)
    // -------------------------------------------------------------------------

    if (currentChart) {
        currentChart.dispose();
    }

    // Inject Legend Element if not exists
    let legendEl = document.getElementById('chart-legend');
    if (!legendEl) {
        legendEl = document.createElement('div');
        legendEl.id = 'chart-legend';
        legendEl.style.cssText = `
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 100;
            font-family: 'Roboto', sans-serif;
            font-size: 14px;
            color: #ccc;
            background: rgba(30, 30, 30, 0.5);
            padding: 8px;
            border-radius: 4px;
            pointer-events: none;
        `;
        chartContainer.style.position = 'relative'; // Ensure container is relative
        chartContainer.appendChild(legendEl);
    }

    currentChart = echarts.init(chartContainer);

    // Prepare Data
    data.sort((a, b) => a.time - b.time);

    const categoryData = data.map(d => new Date(d.time * 1000).toLocaleString());
    const ohlcData = data.map(d => [d.open, d.close, d.low, d.high]);

    const upColor = '#26a69a';
    const downColor = '#ef5350';

    const series = [
        {
            name: 'Price',
            type: 'candlestick',
            data: ohlcData,
            itemStyle: {
                color: upColor,
                color0: downColor,
                borderColor: upColor,
                borderColor0: downColor
            },
            z: 10
        }
    ];

    // Indicators
    if (strategy.toLowerCase().includes('sma')) {
        const period = 20;
        const smaData = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period) {
                smaData.push('-');
                continue;
            }
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += data[i - j].close;
            }
            smaData.push(sum / period);
        }

        series.push({
            name: 'SMA 20',
            type: 'line',
            data: smaData,
            smooth: true,
            lineStyle: { color: '#2962FF', width: 2 },
            symbol: 'none',
            z: 20
        });
    }

    const option = {
        backgroundColor: '#1e1e1e',
        animation: false, // LWC style is instant
        grid: {
            left: '5%',
            right: '5%',
            top: '5%',    // Maximize space
            bottom: '5%'  // Reclaimed space from slider
        },
        xAxis: {
            type: 'category',
            data: categoryData,
            scale: true,
            boundaryGap: false,
            axisLine: { lineStyle: { color: '#333' } },
            axisLabel: { color: '#888' },
            splitLine: { show: true, lineStyle: { color: '#2b2b2b' } },
            min: 'dataMin',
            max: 'dataMax'
        },
        yAxis: [
            // Right Price Axis
            {
                scale: true,
                position: 'right',
                axisLine: { show: true, lineStyle: { color: '#333' } },
                splitLine: { show: true, lineStyle: { color: '#2b2b2b' } },
                axisLabel: { color: '#888', formatter: (v) => v.toFixed(5) }
            },
            // Left Price Axis
            {
                scale: true,
                position: 'left',
                axisLine: { show: true, lineStyle: { color: '#333' } },
                splitLine: { show: false },
                axisLabel: { color: '#888', formatter: (v) => v.toFixed(5) },
                // Sync scaling
                min: 'dataMin',
                max: 'dataMax'
            }
        ],
        dataZoom: [
            {
                type: 'inside', // Mouse wheel zoom, Drag pan
                start: 50,
                end: 100
                // Removed restrictive flags to enable default drag-to-pan
            }
        ],
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross', label: { backgroundColor: '#333' } },
            show: false // We use custom legend
        },
        axisPointer: {
            link: { xAxisIndex: 'all' },
            label: { backgroundColor: '#333' }
        },
        series: [
            ...series,
            // Ghost series for left axis sync
            {
                name: 'Price (Left)',
                type: 'candlestick',
                data: ohlcData,
                yAxisIndex: 1,
                silent: true,
                itemStyle: { opacity: 0 }
            }
        ]
    };

    currentChart.setOption(option);

    // Custom Legend Update Logic
    const updateLegend = (index) => {
        if (index === undefined || index < 0 || index >= data.length) return;

        const d = data[index];
        const color = d.open > d.close ? '#ef5350' : '#26a69a';

        legendEl.innerHTML = `
            <span style="font-weight: bold; margin-right: 10px;">Rapid-EA Tech</span>
            Open: <span style="color: ${color}">${d.open.toFixed(5)}</span>
            High: <span style="color: ${color}">${d.high.toFixed(5)}</span>
            Low: <span style="color: ${color}">${d.low.toFixed(5)}</span>
            Close: <span style="color: ${color}">${d.close.toFixed(5)}</span>
        `;
    };

    // Initial Legend
    updateLegend(data.length - 1);

    // Event listener for crosshair move
    currentChart.getZr().on('mousemove', (params) => {
        const pointInPixel = [params.offsetX, params.offsetY];
        if (currentChart.containPixel('grid', pointInPixel)) {
            const pointInGrid = currentChart.convertFromPixel({ seriesIndex: 0 }, pointInPixel);
            const index = pointInGrid[0]; // X index
            updateLegend(Math.round(index));
        }
    });

    statusEl.textContent = "Visualization updated (LWC Style).";
    mqlOutput.style.display = 'none';

}

// Deprecated
async function renderChart(options) { }



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
