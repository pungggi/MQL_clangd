import * as echarts from 'echarts';

console.log('[Rapid-EA] Bundle loaded');

// Generate realistic mock OHLC data using random walk with trend and volatility clustering
function generateRealisticMockData(length = 1000) {
    const data = [];

    // Starting price (forex-like, e.g., EURUSD around 1.08)
    let price = 1.08500;

    // Volatility and trend state
    let volatility = 0.0003; // Base volatility (30 pips)
    let trend = 0; // Current trend bias (-1 to 1)
    let trendDuration = 0;

    // Volume state
    let baseVolume = 5000;

    for (let i = 0; i < length; i++) {
        // Update trend occasionally (persistence)
        if (trendDuration <= 0 || Math.random() < 0.02) {
            trend = (Math.random() - 0.5) * 0.6; // Slight trend bias
            trendDuration = Math.floor(20 + Math.random() * 80); // 20-100 bars
        }
        trendDuration--;

        // Volatility clustering (GARCH-like behavior)
        const volShock = Math.random();
        if (volShock > 0.95) {
            volatility = Math.min(0.001, volatility * 1.5); // Volatility spike
        } else if (volShock < 0.3) {
            volatility = Math.max(0.00015, volatility * 0.95); // Mean reversion
        }

        // Price movement with trend component
        const drift = trend * volatility * 2;
        const randomWalk = (Math.random() - 0.5) * volatility * 2;
        const priceChange = drift + randomWalk;

        // Generate OHLC with realistic wicks
        const open = price;
        const bodySize = Math.abs(priceChange);
        const wickMultiplier = 0.3 + Math.random() * 0.7; // Wicks 30-100% of body

        let close, high, low;

        if (priceChange >= 0) {
            // Bullish candle
            close = open + bodySize;
            high = close + bodySize * wickMultiplier * Math.random();
            low = open - bodySize * wickMultiplier * Math.random();
        } else {
            // Bearish candle
            close = open - bodySize;
            high = open + bodySize * wickMultiplier * Math.random();
            low = close - bodySize * wickMultiplier * Math.random();
        }

        // Ensure high >= max(open, close) and low <= min(open, close)
        high = Math.max(high, open, close);
        low = Math.min(low, open, close);

        // Volume with patterns (higher on volatile moves)
        const volFactor = 1 + (Math.abs(priceChange) / volatility) * 0.5;
        const volume = Math.floor(baseVolume * volFactor * (0.5 + Math.random()));

        data.push({
            time: 1700000000 + i * 3600, // Start from late 2023
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            close: parseFloat(close.toFixed(5)),
            volume: volume
        });

        // Update price for next candle
        price = close;
    }

    return data;
}

// Mock Data for Initial Test if market_data.json is missing
const mockData = generateRealisticMockData(1000);

let currentChart = null;

// Initialization check
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Rapid-EA] DOM ready');
    const status = document.getElementById('status-msg');
    if (status) status.textContent = 'App initialized';
});



// DOM Elements - 4 input sections for price action trading
const inputFramework = document.getElementById('input-framework');
const inputTriggers = document.getElementById('input-triggers');
const inputTargets = document.getElementById('input-targets');
const inputStrategy = document.getElementById('input-strategy');
const btnVisualize = document.getElementById('btn-visualize');
const btnCode = document.getElementById('btn-code');
const statusEl = document.getElementById('status-msg');
const chartContainer = document.getElementById('chart-container');

const btnScan = document.getElementById('btn-scan');
const codebaseList = document.getElementById('codebase-list');

// Helper to get all strategy inputs combined
function getStrategyInputs() {
    return {
        framework: inputFramework?.value || '',
        triggers: inputTriggers?.value || '',
        targets: inputTargets?.value || '',
        strategy: inputStrategy?.value || ''
    };
}

// Event Listeners
if (btnVisualize) {
    btnVisualize.addEventListener('click', handleVisualize);
}
if (btnCode) {
    btnCode.addEventListener('click', handleGenerateCode);
}

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

// Generated files section elements
const generatedFilesSection = document.getElementById('generated-files-section');
const generatedFileLink = document.getElementById('generated-file-link');

// Store the current generated file path
let currentGeneratedFilePath = null;

// Global message listener for extension messages
window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.command === 'fileCreated') {
        // Show the generated file link
        if (generatedFilesSection && generatedFileLink) {
            generatedFilesSection.style.display = 'block';
            generatedFileLink.textContent = message.fileName;
            generatedFileLink.title = message.filePath;
            currentGeneratedFilePath = message.filePath;

            // Make it clickable to open the file
            generatedFileLink.onclick = () => {
                if (vscode) {
                    vscode.postMessage({ command: 'openFile', filePath: message.filePath });
                }
            };
        }
    } else if (message.command === 'fileDeleted') {
        // Hide the generated file link if the file was deleted
        if (generatedFilesSection && message.filePath === currentGeneratedFilePath) {
            generatedFilesSection.style.display = 'none';
            currentGeneratedFilePath = null;
        }
    }
});

async function loadData() {
    if (vscode) {
        // Request data from Extension
        if (statusEl) statusEl.textContent = "Requesting data from VS Code Extension...";
        vscode.postMessage({ command: 'requestData' });

        // Wait for response with timeout
        return new Promise((resolve, reject) => {
            let resolved = false;

            // Timeout after 3 seconds - use mock data
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    window.removeEventListener('message', listen);
                    console.warn('Timeout waiting for data, using mock data');
                    resolve(mockData);
                }
            }, 3000);

            const listen = (event) => {
                const message = event.data;
                if (message.command === 'receiveData') {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        window.removeEventListener('message', listen);
                        if (message.error) {
                            // On error, resolve with mock data instead of rejecting
                            console.warn('Data load error, using mock data:', message.error);
                            resolve(mockData);
                        } else {
                            resolve(message.data);
                        }
                    }
                } else if (message.command === 'codebaseScanned') {
                    // Update the UI with found files
                    if (codebaseList) {
                        codebaseList.innerHTML = '';
                        if (message.files.length > 0) {
                            message.files.forEach(f => {
                                const li = document.createElement('li');
                                li.textContent = f;
                                codebaseList.appendChild(li);
                            });
                        } else {
                            const li = document.createElement('li');
                            li.textContent = 'No .mqh files found';
                            codebaseList.appendChild(li);
                        }
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
    const inputs = getStrategyInputs();
    const strategy = [inputs.framework, inputs.triggers, inputs.targets, inputs.strategy].filter(Boolean).join(' ');

    if (statusEl) statusEl.textContent = "Loading data...";

    let data;
    try {
        data = await loadData();
    } catch (e) {
        console.error("Error loading data", e);
        // Fall back to mock data on error
        data = mockData;
        if (statusEl) statusEl.textContent = "Using demo data (load error: " + (e.message || e) + ")";
    }

    if (statusEl) statusEl.textContent = "Generating visualization...";

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
    const strategyLower = strategy.toLowerCase();
    if (strategyLower.includes('sma') || strategyLower.includes('crossover')) {
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

}

async function handleGenerateCode() {
    const inputs = getStrategyInputs();

    // Check if at least one input is provided
    const hasInput = inputs.framework || inputs.triggers || inputs.targets || inputs.strategy;
    if (!hasInput) {
        statusEl.textContent = "Please fill in at least one strategy section.";
        return;
    }
    statusEl.textContent = "Generating MQL code...";

    // Sanitize strategy string for MQL comments
    function sanitizeForMql(str) {
        return str
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, ' ')
            .replace(/\r/g, '')
            .replace(/\t/g, ' ');
    }

    const safeFramework = sanitizeForMql(inputs.framework);
    const safeTriggers = sanitizeForMql(inputs.triggers);
    const safeTargets = sanitizeForMql(inputs.targets);
    const safeStrategy = sanitizeForMql(inputs.strategy);

    // Build MQL5 Expert Advisor with structured sections
    let mqlCode = '';

    // --- Header ---
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//|                                        Rapid-EA Generated        |\n`;
    mqlCode += `//|                        Price Action Strategy                     |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `#property strict\n`;
    mqlCode += `#include <Trade/Trade.mqh>\n\n`;

    // --- Strategy Documentation ---
    mqlCode += `/*\n`;
    mqlCode += `================================================================================\n`;
    mqlCode += `STRATEGY SPECIFICATION\n`;
    mqlCode += `================================================================================\n`;
    if (safeFramework) {
        mqlCode += `\nFRAMEWORK (Patterns & Structures):\n`;
        mqlCode += `   ${safeFramework}\n`;
    }
    if (safeTriggers) {
        mqlCode += `\nTRIGGERS (Entry Conditions):\n`;
        mqlCode += `   ${safeTriggers}\n`;
    }
    if (safeTargets) {
        mqlCode += `\nTARGETS (TP/SL/Trailing):\n`;
        mqlCode += `   ${safeTargets}\n`;
    }
    if (safeStrategy) {
        mqlCode += `\nSTRATEGY (Session/Filters/Exceptions):\n`;
        mqlCode += `   ${safeStrategy}\n`;
    }
    mqlCode += `\n================================================================================\n`;
    mqlCode += `*/\n\n`;

    // --- Input Parameters ---
    mqlCode += `// ===== Input Parameters =====\n`;
    mqlCode += `input double LotSize = 0.1;           // Trade Lot Size\n`;
    mqlCode += `input int    MagicNumber = 123456;    // EA Magic Number\n`;
    mqlCode += `input double RiskPercent = 1.0;       // Risk per trade (%)\n`;
    mqlCode += `input int    MaxSpread = 30;          // Maximum spread (points)\n\n`;

    // --- Session Filters (if strategy mentions sessions) ---
    mqlCode += `// ===== Session Filters =====\n`;
    mqlCode += `input bool   TradeLondon = true;      // Trade London Session\n`;
    mqlCode += `input bool   TradeNewYork = true;     // Trade New York Session\n`;
    mqlCode += `input bool   TradeAsia = false;       // Trade Asian Session\n\n`;

    // --- Global Objects ---
    mqlCode += `// ===== Global Objects =====\n`;
    mqlCode += `CTrade trade;\n\n`;

    // --- Enums for state machine ---
    mqlCode += `// ===== Trade State Machine =====\n`;
    mqlCode += `enum TRADE_STATE {\n`;
    mqlCode += `   STATE_IDLE,           // Waiting for setup\n`;
    mqlCode += `   STATE_SETUP,          // Framework conditions met\n`;
    mqlCode += `   STATE_TRIGGER,        // Trigger confirmed, ready to enter\n`;
    mqlCode += `   STATE_IN_TRADE        // Position open\n`;
    mqlCode += `};\n`;
    mqlCode += `TRADE_STATE CurrentState = STATE_IDLE;\n\n`;

    // --- OnInit ---
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Expert initialization function                                   |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `int OnInit() {\n`;
    mqlCode += `   trade.SetExpertMagicNumber(MagicNumber);\n`;
    mqlCode += `   \n`;
    mqlCode += `   // TODO: Initialize price action detection\n`;
    mqlCode += `   \n`;
    mqlCode += `   return INIT_SUCCEEDED;\n`;
    mqlCode += `}\n\n`;

    // --- OnDeinit ---
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Expert deinitialization function                                 |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `void OnDeinit(const int reason) {\n`;
    mqlCode += `   // Clean up\n`;
    mqlCode += `}\n\n`;

    // --- Helper Functions ---
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Check if current time is in valid session                       |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `bool IsValidSession() {\n`;
    mqlCode += `   MqlDateTime dt;\n`;
    mqlCode += `   TimeToStruct(TimeCurrent(), dt);\n`;
    mqlCode += `   int hour = dt.hour;\n`;
    mqlCode += `   \n`;
    mqlCode += `   // London: 08:00-17:00 GMT\n`;
    mqlCode += `   if(TradeLondon && hour >= 8 && hour < 17) return true;\n`;
    mqlCode += `   // New York: 13:00-22:00 GMT\n`;
    mqlCode += `   if(TradeNewYork && hour >= 13 && hour < 22) return true;\n`;
    mqlCode += `   // Asia: 00:00-08:00 GMT\n`;
    mqlCode += `   if(TradeAsia && (hour >= 0 && hour < 8)) return true;\n`;
    mqlCode += `   \n`;
    mqlCode += `   return false;\n`;
    mqlCode += `}\n\n`;

    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Check Framework conditions (patterns/structures)                |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `bool CheckFramework() {\n`;
    mqlCode += `   // TODO: Implement pattern detection\n`;
    mqlCode += `   // Framework: ${safeFramework || 'Not specified'}\n`;
    mqlCode += `   \n`;
    mqlCode += `   return false; // Placeholder\n`;
    mqlCode += `}\n\n`;

    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Check Trigger conditions                                        |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `int CheckTrigger() {\n`;
    mqlCode += `   // TODO: Implement trigger detection\n`;
    mqlCode += `   // Triggers: ${safeTriggers || 'Not specified'}\n`;
    mqlCode += `   // Return: 1 = Buy, -1 = Sell, 0 = No trigger\n`;
    mqlCode += `   \n`;
    mqlCode += `   return 0; // Placeholder\n`;
    mqlCode += `}\n\n`;

    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Calculate Stop Loss based on price action                       |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `double CalculateSL(int direction) {\n`;
    mqlCode += `   // TODO: Implement SL calculation\n`;
    mqlCode += `   // Targets: ${safeTargets || 'Not specified'}\n`;
    mqlCode += `   \n`;
    mqlCode += `   double atr = 0; // Use ATR or swing points\n`;
    mqlCode += `   return direction > 0 ? SymbolInfoDouble(_Symbol, SYMBOL_BID) - atr \n`;
    mqlCode += `                        : SymbolInfoDouble(_Symbol, SYMBOL_ASK) + atr;\n`;
    mqlCode += `}\n\n`;

    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Calculate Take Profit                                           |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `double CalculateTP(int direction, double sl) {\n`;
    mqlCode += `   // TODO: Implement TP calculation\n`;
    mqlCode += `   double entry = direction > 0 ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)\n`;
    mqlCode += `                                : SymbolInfoDouble(_Symbol, SYMBOL_BID);\n`;
    mqlCode += `   double risk = MathAbs(entry - sl);\n`;
    mqlCode += `   \n`;
    mqlCode += `   // Default 2:1 R:R\n`;
    mqlCode += `   return direction > 0 ? entry + (risk * 2) : entry - (risk * 2);\n`;
    mqlCode += `}\n\n`;

    // --- OnTick ---
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `//| Expert tick function                                            |\n`;
    mqlCode += `//+------------------------------------------------------------------+\n`;
    mqlCode += `void OnTick() {\n`;
    mqlCode += `   // New bar check\n`;
    mqlCode += `   static datetime lastBarTime = 0;\n`;
    mqlCode += `   datetime currentBarTime = iTime(_Symbol, _Period, 0);\n`;
    mqlCode += `   if(lastBarTime == currentBarTime) return;\n`;
    mqlCode += `   lastBarTime = currentBarTime;\n\n`;
    mqlCode += `   // Spread filter\n`;
    mqlCode += `   if(SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) > MaxSpread) return;\n\n`;
    mqlCode += `   // Session filter\n`;
    mqlCode += `   if(!IsValidSession()) return;\n\n`;
    mqlCode += `   // State machine\n`;
    mqlCode += `   switch(CurrentState) {\n`;
    mqlCode += `      case STATE_IDLE:\n`;
    mqlCode += `         if(CheckFramework()) {\n`;
    mqlCode += `            CurrentState = STATE_SETUP;\n`;
    mqlCode += `         }\n`;
    mqlCode += `         break;\n\n`;
    mqlCode += `      case STATE_SETUP:\n`;
    mqlCode += `         {\n`;
    mqlCode += `            int trigger = CheckTrigger();\n`;
    mqlCode += `            if(trigger != 0) {\n`;
    mqlCode += `               double sl = CalculateSL(trigger);\n`;
    mqlCode += `               double tp = CalculateTP(trigger, sl);\n`;
    mqlCode += `               \n`;
    mqlCode += `               if(trigger > 0) {\n`;
    mqlCode += `                  if(trade.Buy(LotSize, _Symbol, 0, sl, tp)) {\n`;
    mqlCode += `                     CurrentState = STATE_IN_TRADE;\n`;
    mqlCode += `                  }\n`;
    mqlCode += `               } else {\n`;
    mqlCode += `                  if(trade.Sell(LotSize, _Symbol, 0, sl, tp)) {\n`;
    mqlCode += `                     CurrentState = STATE_IN_TRADE;\n`;
    mqlCode += `                  }\n`;
    mqlCode += `               }\n`;
    mqlCode += `            }\n`;
    mqlCode += `         }\n`;
    mqlCode += `         break;\n\n`;
    mqlCode += `      case STATE_IN_TRADE:\n`;
    mqlCode += `         if(!PositionSelect(_Symbol)) {\n`;
    mqlCode += `            CurrentState = STATE_IDLE;\n`;
    mqlCode += `         }\n`;
    mqlCode += `         // TODO: Trailing stop logic\n`;
    mqlCode += `         break;\n`;
    mqlCode += `   }\n`;
    mqlCode += `}\n`;

    statusEl.textContent = "Code generated successfully!";

    // If in VS Code, save the file
    if (vscode) {
        vscode.postMessage({ command: 'saveCode', text: mqlCode });
    }
}

// Global scope for HTML access
window.toggleSpeech = function () {
    alert("Speech-to-Text would activate here (using Web Speech API).");
}
