const fs = require('fs');
const path = require('path');

const COUNT = 5000;
const OUTPUT_FILE = path.join(__dirname, '..', 'market_data.json');

function generateData(count) {
    const data = [];
    let time = Math.floor(Date.now() / 1000) - count * 3600;
    let price = 1000;

    for (let i = 0; i < count; i++) {
        const volatility = price * 0.005; // 0.5% volatility
        const change = (Math.random() - 0.5) * volatility;

        const close = price + change;
        const open = price;
        const high = Math.max(open, close) + Math.random() * volatility * 0.5;
        const low = Math.min(open, close) - Math.random() * volatility * 0.5;
        const volume = Math.floor(Math.random() * 1000) + 100;

        data.push({
            time: time,
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            close: parseFloat(close.toFixed(5)),
            volume: volume
        });

        price = close;
        time += 3600; // 1 hour steps
    }
    return data;
}

const data = generateData(COUNT);
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
console.log(`Generated ${COUNT} bars of market data to ${OUTPUT_FILE}`);
