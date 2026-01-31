'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const language = vscode.env.language;
const platform = process.platform; // 'win32', 'darwin', 'linux'

// Map VS Code language codes to MQL5 web URL language codes
// MQL5 documentation supports: en, ru, zh, ja, es, de (and partial support for others)
const webLangMap = {
    'en': 'en',
    'ru': 'ru',
    'de': 'de',
    'es': 'es',
    'zh-cn': 'zh',
    'zh-tw': 'zh',
    'ja': 'ja'
};

/**
 * Get the MQL5 documentation language code for the current VS Code language
 * @returns {string} MQL5 documentation language code (defaults to 'en')
 */
function getMql5DocLang() {
    return webLangMap[language] || 'en';
}

// Load MQL5 docs mapping
let mql5DocsMap = null;
function loadMql5DocsMap() {
    if (mql5DocsMap !== null) return mql5DocsMap;
    try {
        const docsPath = path.join(__dirname, '..', 'data', 'mql5-docs.json');
        if (fs.existsSync(docsPath)) {
            mql5DocsMap = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
        } else {
            mql5DocsMap = {};
        }
    } catch (err) {
        console.error('Failed to load MQL5 docs map:', err);
        mql5DocsMap = {};
    }
    return mql5DocsMap;
}

/**
 * Opens web-based MQL documentation
 * @param {number} version - MQL version (4 or 5)
 * @param {string} keyword - Keyword to search for
 */
function openWebHelp(version, keyword) {
    const webLang = getMql5DocLang();
    let helpUrl;

    if (version === 4) {
        // MQL4 docs - direct search in documentation
        // MQL4 supports only 'cn', 'ru', 'en' language paths
        const mql4Lang = webLang === 'zh' ? 'cn' : (webLang === 'ru' ? 'ru' : 'en');
        helpUrl = `https://docs.mql4.com/${mql4Lang}/search?keyword=${encodeURIComponent(keyword)}`;
    } else {
        // MQL5 docs - try direct link first, fallback to search
        const docsMap = loadMql5DocsMap();
        const keyLower = keyword.toLowerCase();

        const docPath = docsMap[keyLower];
        if (docPath) {
            // Check if it's a full path (contains /) or just a category
            if (docPath.includes('/')) {
                // Full path: standardlibrary/tradeclasses/ctrade/ctradepositionmodify
                helpUrl = `https://www.mql5.com/${webLang}/docs/${docPath}`;
            } else {
                // Old format: category only, append keyword
                helpUrl = `https://www.mql5.com/${webLang}/docs/${docPath}/${keyLower}`;
            }
        } else {
            // Fallback to search
            helpUrl = `https://www.mql5.com/${webLang}/search#!keyword=${encodeURIComponent(keyword)}&module=docs`;
        }
    }

    vscode.env.openExternal(vscode.Uri.parse(helpUrl));
}

/**
 * Main help function - opens web-based MQL documentation
 * @param {string} [keyword] - Optional keyword to search for (used by quickfixes)
 * @param {number} [version] - Optional MQL version (4 or 5, defaults to auto-detect)
 */
function Help(keyword, version) {
    // If keyword is provided (called from quickfix), use it directly
    if (keyword) {
        // Default to MQL5 if version not specified
        const mqlVersion = version || 5;
        openWebHelp(mqlVersion, keyword);
        return;
    }

    // Original cursor-based help logic
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('MQL Help: No active editor');
        return;
    }

    const { document, selection } = editor;
    const fileName = document.fileName.toLowerCase();

    // Check if it's an MQL file
    const isMQL = fileName.endsWith('.mq4') || fileName.endsWith('.mq5') || fileName.endsWith('.mqh');
    if (!isMQL) {
        vscode.window.showInformationMessage('MQL Help: Only available for .mq4, .mq5, .mqh files');
        return;
    }

    const { start, end } = selection;
    if (end.line !== start.line) {
        vscode.window.showInformationMessage('MQL Help: Multi-line selections not supported; place cursor on a single line or select a single word');
        return;
    }

    const isSelectionSearch = end.character !== start.character;
    const wordAtCursorRange = isSelectionSearch
        ? selection
        : document.getWordRangeAtPosition(end, /(#\w+|\w+)/);

    if (!wordAtCursorRange) {
        vscode.window.showInformationMessage('MQL Help: Place cursor on a keyword');
        return;
    }

    const cursorKeyword = document.getText(wordAtCursorRange);
    const wn = vscode.workspace.name ? vscode.workspace.name.includes('MQL4') : false;

    // Determine MQL version
    let detectedVersion;
    if (fileName.endsWith('.mq4') || (fileName.endsWith('.mqh') && wn)) {
        detectedVersion = 4;
    } else {
        detectedVersion = 5;
    }

    openWebHelp(detectedVersion, cursorKeyword);
}

/**
 * Get possible CHM file paths based on OS, MQL version, and Wine configuration
 * @param {number} version - MQL version (4 or 5)
 * @returns {string[]} - Array of possible CHM file paths
 */
function getChmPaths(version) {
    const chmFile = version === 4 ? 'mql4.chm' : 'mql5.chm';
    const paths = [];

    // Check for Wine.Prefix configuration
    const config = vscode.workspace.getConfiguration('mql_tools');
    const winePrefix = config.Wine?.Prefix || '';

    if (platform === 'win32') {
        // Windows: %APPDATA%\MetaQuotes\Terminal\Help\
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        paths.push(path.join(appData, 'MetaQuotes', 'Terminal', 'Help', chmFile));
    } else if (platform === 'darwin') {
        // macOS: Check Wine prefix first if configured
        const home = os.homedir();

        if (winePrefix) {
            // User-configured Wine prefix takes priority
            if (version === 5) {
                paths.push(path.join(winePrefix, 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
            } else {
                paths.push(path.join(winePrefix, 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
            }
        }

        // Fallback to common macOS Wine locations
        if (version === 5) {
            paths.push(path.join(home, 'Library', 'Application Support', 'net.metaquotes.wine.metatrader5', 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
            paths.push(path.join(home, 'Library', 'Application Support', 'MetaTrader 5', 'Bottles', 'metatrader5', 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
            // CrossOver support
            paths.push(path.join(home, 'Library', 'Application Support', 'CrossOver', 'Bottles', 'MetaTrader5', 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
        } else {
            paths.push(path.join(home, 'Library', 'Application Support', 'net.metaquotes.wine.metatrader4', 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
            // CrossOver support
            paths.push(path.join(home, 'Library', 'Application Support', 'CrossOver', 'Bottles', 'MetaTrader4', 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
        }
    } else if (platform === 'linux') {
        // Linux: Check Wine prefix first if configured
        const home = os.homedir();

        if (winePrefix) {
            // User-configured Wine prefix takes priority
            if (version === 5) {
                paths.push(path.join(winePrefix, 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
            } else {
                paths.push(path.join(winePrefix, 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
            }
        }

        // Fallback to common Linux Wine locations
        if (version === 5) {
            paths.push(path.join(home, '.mt5', 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
            paths.push(path.join(home, '.wine', 'drive_c', 'Program Files', 'MetaTrader 5', 'Help', chmFile));
        } else {
            paths.push(path.join(home, '.mt4', 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
            paths.push(path.join(home, '.wine', 'drive_c', 'Program Files', 'MetaTrader 4', 'Help', chmFile));
        }
    }

    return paths;
}

/**
 * Find the first existing CHM file from the list of paths
 * @param {string[]} paths - Array of possible CHM file paths
 * @returns {string|null} - Path to the CHM file or null if not found
 */
function findChmFile(paths) {
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Opens offline CHM help file with keyword anchor
 * @param {number} version - MQL version (4 or 5)
 * @param {string} keyword - Keyword to search for
 */
function openOfflineHelp(version, keyword) {
    const chmPaths = getChmPaths(version);
    const chmFile = findChmFile(chmPaths);

    if (!chmFile) {
        vscode.window.showWarningMessage(
            `MQL${version} offline help not found. Searched:\n${chmPaths.join('\n')}`,
            'Open Online Help'
        ).then(selection => {
            if (selection === 'Open Online Help') {
                openWebHelp(version, keyword);
            }
        });
        return;
    }

    const keyLower = keyword.toLowerCase();

    if (platform === 'win32') {
        // Windows: Use hh.exe with mk:@MSITStore protocol
        // Format: hh.exe mk:@MSITStore:path\to\file.chm::/<topic>.htm
        // Using spawn with args array to prevent command injection
        const topicUrl = `mk:@MSITStore:${chmFile}::/${keyLower}.htm`;
        const child = spawn('hh.exe', [topicUrl], { detached: true, stdio: 'ignore' });
        child.on('error', () => {
            // Fallback: just open the CHM file
            const fallbackChild = spawn('hh.exe', [chmFile], { detached: true, stdio: 'ignore' });
            fallbackChild.unref();
        });
        child.unref();
    } else {
        // macOS/Linux: Open with default viewer (xchm, kchmviewer, etc.)
        // CHM viewers don't typically support anchors, so just open the file
        // Using spawn with args array to prevent command injection
        const openCmd = platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(openCmd, [chmFile], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => {
            vscode.window.showErrorMessage(`Failed to open CHM file: ${err.message}`);
        });
        child.unref();
    }
}

/**
 * Main offline help function
 */
function OfflineHelp() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('MQL Help: No active editor');
        return;
    }

    const { document, selection } = editor;
    const fileName = document.fileName.toLowerCase();

    // Check if it's an MQL file
    const isMQL = fileName.endsWith('.mq4') || fileName.endsWith('.mq5') || fileName.endsWith('.mqh');
    if (!isMQL) {
        vscode.window.showInformationMessage('MQL Help: Only available for .mq4, .mq5, .mqh files');
        return;
    }

    const { start, end } = selection;
    if (end.line !== start.line) return;

    const isSelectionSearch = end.character !== start.character;
    const wordAtCursorRange = isSelectionSearch
        ? selection
        : document.getWordRangeAtPosition(end, /(#\w+|\w+)/);

    if (!wordAtCursorRange) {
        vscode.window.showInformationMessage('MQL Help: Place cursor on a keyword');
        return;
    }

    const keyword = document.getText(wordAtCursorRange);
    const wn = vscode.workspace.name ? vscode.workspace.name.includes('MQL4') : false;

    // Determine MQL version
    let version;
    if (fileName.endsWith('.mq4') || (fileName.endsWith('.mqh') && wn)) {
        version = 4;
    } else {
        version = 5;
    }

    openOfflineHelp(version, keyword);
}

module.exports = {
    Help,
    OfflineHelp,
    getMql5DocLang
};