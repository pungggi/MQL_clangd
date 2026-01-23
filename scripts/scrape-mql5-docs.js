/**
 * Scrapes MQL5 documentation recursively to build a function-to-URL mapping
 * Run with: node scripts/scrape-mql5-docs.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.mql5.com';
const DOCS_PATH = '/en/docs';
const MAX_DEPTH = 5; // Maximum recursion depth
const DELAY_MS = 300; // Delay between requests

// Result storage: keyword -> path (without /en/docs prefix)
const allDocs = {};
const visited = new Set();

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        };
        https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function extractLinks(html) {
    const links = [];
    // Match all documentation links: /en/docs/...
    const regex = /href="(\/en\/docs\/[a-z0-9_/]+)"/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const link = match[1].toLowerCase();
        if (!visited.has(link)) {
            links.push(link);
        }
    }
    return [...new Set(links)];
}

function extractKeyword(docPath) {
    // Extract the last segment as keyword
    // /en/docs/standardlibrary/tradeclasses/ctrade/ctradepositionmodify -> ctradepositionmodify
    const parts = docPath.split('/').filter(Boolean);
    return parts[parts.length - 1];
}

async function scrapePage(docPath, depth = 0) {
    if (depth > MAX_DEPTH || visited.has(docPath)) return;
    visited.add(docPath);

    const url = BASE_URL + docPath;
    try {
        const html = await fetchPage(url);

        // Store this page's keyword and path
        const keyword = extractKeyword(docPath);
        const pathWithoutLang = docPath.replace('/en/docs/', '');

        // Only store if it looks like a function/class page (not a category index)
        if (pathWithoutLang.includes('/')) {
            allDocs[keyword] = pathWithoutLang;
        }

        // Progress output
        process.stdout.write(`\r[${visited.size} pages, ${Object.keys(allDocs).length} entries] ${docPath.substring(0, 60).padEnd(60)}`);

        // Find and follow links
        const links = extractLinks(html);
        for (const link of links) {
            await new Promise(r => setTimeout(r, DELAY_MS));
            await scrapePage(link, depth + 1);
        }
    } catch (err) {
        process.stdout.write(`\n`);
        console.error(`Error scraping ${docPath}:`, err.message);
    }
}

async function main() {
    console.log('Starting recursive MQL5 documentation scrape...');
    console.log('This may take several minutes...\n');

    const startTime = Date.now();
    await scrapePage(DOCS_PATH, 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    process.stdout.write('\n\n');
    const outputPath = path.join(__dirname, '..', 'data', 'mql5-docs.json');
    const dataDir = path.dirname(outputPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, JSON.stringify(allDocs, null, 2));

    console.log(`Done! Found ${Object.keys(allDocs).length} entries in ${elapsed}s`);
    console.log(`Visited ${visited.size} pages.`);
    console.log(`Saved to: ${outputPath}`);
}

main().catch(console.error);

