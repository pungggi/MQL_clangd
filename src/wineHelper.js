'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Converts a Unix/macOS path to a Windows-style path using Wine's winepath tool.
 * 
 * @param {string} localPath - The Unix/macOS path (e.g., /Users/name/...)
 * @param {string} wineBinary - Path to wine executable (e.g., 'wine64', '/usr/bin/wine')
 * @returns {Promise<string>} The Windows path (e.g., Z:\Users\name\...)
 */
async function toWineWindowsPath(localPath, wineBinary = 'wine64') {
    try {
        // Wine's winepath is invoked as: wine winepath -w <path>
        // -w flag converts TO Windows format
        const { stdout } = await execFileAsync(
            wineBinary,
            ['winepath', '-w', localPath],
            { timeout: 10000 }
        );
        return stdout.trim();
    } catch (error) {
        // Log warning but return original path as fallback
        // (compilation will likely fail, but at least we don't crash)
        console.error(`[Wine] Failed to convert path with winepath: ${error.message}`);
        return localPath;
    }
}

/**
 * Checks if Wine support should be used based on platform and configuration.
 *
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {boolean} True if Wine should be used
 */
function isWineEnabled(config) {
    // Only use Wine on non-Windows platforms when explicitly enabled
    return !!(process.platform !== 'win32' && config.Wine && config.Wine.Enabled === true);
}

/**
 * Gets the configured Wine binary path.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {string} The Wine binary path
 */
function getWineBinary(config) {
    return (config.Wine && config.Wine.Binary) || 'wine64';
}

module.exports = {
    toWineWindowsPath,
    isWineEnabled,
    getWineBinary
};

