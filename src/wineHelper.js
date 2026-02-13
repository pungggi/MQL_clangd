'use strict';
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');

const execFileAsync = promisify(execFile);

/** @type {import('vscode').OutputChannel|null} */
let outputChannel = null;

/**
 * Sets the output channel for Wine diagnostics logging.
 * Should be called during extension activation.
 * @param {import('vscode').OutputChannel} channel 
 */
function setOutputChannel(channel) {
    outputChannel = channel;
}

/**
 * Logs a message to the output channel (if available) and console.
 * @param {string} message 
 */
function log(message) {
    console.log(message);
    if (outputChannel) {
        outputChannel.appendLine(message);
    }
}

/**
 * Logs a warning message to the output channel (if available) and console.
 * @param {string} message 
 */
function logWarning(message) {
    console.warn(message);
    if (outputChannel) {
        outputChannel.appendLine(`[Warning] ${message}`);
    }
}

/**
 * Logs an error message to the output channel (if available) and console.
 * @param {string} message 
 */
function logError(message) {
    console.error(message);
    if (outputChannel) {
        outputChannel.appendLine(`[Error] ${message}`);
    }
}

/**
 * Checks if Wine is installed and accessible.
 * 
 * @param {string} wineBinary - Path to wine executable (e.g., 'wine64', '/usr/bin/wine')
 * @param {string} [winePrefix] - Optional WINEPREFIX path
 * @returns {Promise<{installed: boolean, version?: string, error?: string}>}
 */
async function isWineInstalled(wineBinary = 'wine64', winePrefix = '') {
    try {
        const env = { ...process.env };
        if (winePrefix) {
            env.WINEPREFIX = winePrefix;
        }

        const { stdout } = await execFileAsync(
            wineBinary,
            ['--version'],
            { timeout: 10000, env }
        );
        return { installed: true, version: stdout.trim() };
    } catch (error) {
        return {
            installed: false,
            error: error.code === 'ENOENT'
                ? `Wine binary not found at "${wineBinary}". Please install Wine or update the Wine.Binary setting.`
                : `Wine check failed: ${error.message}`
        };
    }
}

/**
 * Validates that a path is in Unix format (for Wine on macOS/Linux).
 * Wine expects Unix paths for executables, not Windows-style paths.
 * 
 * @param {string} pathToCheck - The path to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateWinePath(pathToCheck) {
    if (!pathToCheck || typeof pathToCheck !== 'string') {
        return { valid: false, error: 'Path is empty or invalid' };
    }

    // Check for Windows-style path (e.g., C:\, D:\, etc.)
    if (/^[A-Za-z]:[/\\]/.test(pathToCheck)) {
        return {
            valid: false,
            error: `Wine mode requires Unix-style paths. Got "${pathToCheck}". ` +
                'Use something like "/Users/you/.wine/drive_c/..." instead of "C:\\..."'
        };
    }

    return { valid: true };
}

/**
 * Converts a Unix/macOS path to a Windows-style path using Wine's winepath tool.
 * 
 * @param {string} localPath - The Unix/macOS path (e.g., /Users/name/...)
 * @param {string} wineBinary - Path to wine executable (e.g., 'wine64', '/usr/bin/wine')
 * @param {string} [winePrefix] - Optional WINEPREFIX path
 * @returns {Promise<{path: string, success: boolean, error?: string}>}
 */
async function toWineWindowsPath(localPath, wineBinary = 'wine64', winePrefix = '') {
    try {
        const env = { ...process.env };
        if (winePrefix) {
            env.WINEPREFIX = winePrefix;
        }

        // Wine's winepath is invoked as: wine winepath -w <path>
        // -w flag converts TO Windows format
        const { stdout } = await execFileAsync(
            wineBinary,
            ['winepath', '-w', localPath],
            { timeout: 10000, env }
        );
        return { path: stdout.trim(), success: true };
    } catch (error) {
        const errorMsg = `[Wine] Failed to convert path "${localPath}" with winepath: ${error.message}`;
        logError(errorMsg);
        // Return original path as fallback but indicate failure
        return {
            path: localPath,
            success: false,
            error: errorMsg
        };
    }
}

/**
 * Legacy wrapper for toWineWindowsPath that returns just the path string.
 * Use toWineWindowsPath directly for better error handling.
 * 
 * @param {string} localPath - The Unix/macOS path
 * @param {string} wineBinary - Path to wine executable
 * @param {string} [winePrefix] - Optional WINEPREFIX path
 * @returns {Promise<string>} The Windows path (or original path on failure)
 * @deprecated Use toWineWindowsPath for proper error handling
 */
async function toWineWindowsPathLegacy(localPath, wineBinary = 'wine64', winePrefix = '') {
    const result = await toWineWindowsPath(localPath, wineBinary, winePrefix);
    return result.path;
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
 * On Apple Silicon Macs, users typically use 'wine' (not 'wine64') via CrossOver
 * or Game Porting Toolkit. The default 'wine64' may not exist in all configurations.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {string} The Wine binary path
 */
function getWineBinary(config) {
    return (config.Wine && config.Wine.Binary) || 'wine64';
}

/**
 * Gets the configured Wine prefix path.
 * 
 * The WINEPREFIX environment variable tells Wine which prefix to use.
 * Users with multiple Wine prefixes (CrossOver, PlayOnMac, custom setups)
 * need to specify this to use the correct prefix.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {string} The Wine prefix path (empty string if not configured)
 */
function getWinePrefix(config) {
    return (config.Wine && config.Wine.Prefix) || '';
}

/**
 * Gets the configured Wine process timeout in milliseconds.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {number} Timeout in milliseconds (default: 60000 = 60 seconds)
 */
function getWineTimeout(config) {
    const timeout = config.Wine && config.Wine.Timeout;
    if (typeof timeout === 'number' && timeout > 0) {
        return timeout;
    }
    return 60000; // 60 seconds default
}

/**
 * Creates environment object for Wine process execution.
 * Includes WINEPREFIX if configured.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @returns {object} Environment variables object
 */
function getWineEnv(config) {
    const env = { ...process.env };
    const winePrefix = getWinePrefix(config);
    if (winePrefix) {
        env.WINEPREFIX = winePrefix;
    }
    return env;
}

/**
 * Spawns a Wine process with proper timeout handling.
 * 
 * @param {string} wineBinary - Path to wine executable
 * @param {string[]} args - Arguments to pass to Wine
 * @param {object} options - Spawn options (env, cwd, etc.)
 * @param {number} timeoutMs - Timeout in milliseconds (0 = no timeout)
 * @returns {{proc: import('child_process').ChildProcess, cleanup: () => void}}
 */
function spawnWineProcess(wineBinary, args, options = {}, timeoutMs = 0) {
    const proc = spawn(wineBinary, args, { shell: false, ...options });

    let timeoutId = null;
    let killed = false;

    const cleanup = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };

    if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
            if (!killed) {
                killed = true;
                logWarning(`[Wine] Process timed out after ${timeoutMs}ms, killing...`);
                proc.kill('SIGTERM');
                // Give it a moment, then force kill
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill('SIGKILL');
                    }
                }, 2000);
            }
        }, timeoutMs);

        proc.on('exit', cleanup);
        proc.on('error', cleanup);
    }

    return { proc, cleanup };
}

/**
 * Performs a comprehensive Wine setup validation.
 * Checks if Wine is installed, prefix exists, and MetaEditor is accessible.
 * 
 * @param {object} config - VS Code configuration object for mql_tools
 * @param {string} metaEditorPath - Path to MetaEditor executable
 * @returns {Promise<{valid: boolean, errors: string[], warnings: string[]}>}
 */
async function validateWineSetup(config, metaEditorPath = '') {
    const errors = [];
    const warnings = [];

    const wineBinary = getWineBinary(config);
    const winePrefix = getWinePrefix(config);

    // Check Wine installation
    const wineCheck = await isWineInstalled(wineBinary, winePrefix);
    if (!wineCheck.installed) {
        errors.push(wineCheck.error || 'Wine is not installed or not accessible');
    } else {
        log(`[Wine] Found Wine: ${wineCheck.version}`);
    }

    // Check Wine prefix if specified
    if (winePrefix) {
        const fs = require('fs');
        if (!fs.existsSync(winePrefix)) {
            errors.push(`Wine prefix not found: "${winePrefix}"`);
        } else {
            const systemReg = require('path').join(winePrefix, 'system.reg');
            if (!fs.existsSync(systemReg)) {
                warnings.push(`Wine prefix may not be initialized: "${winePrefix}" (system.reg not found)`);
            }
        }
    }

    // Validate MetaEditor path format
    if (metaEditorPath) {
        const pathValidation = validateWinePath(metaEditorPath);
        if (!pathValidation.valid) {
            errors.push(pathValidation.error);
        }

        // Check if MetaEditor exists
        const fs = require('fs');
        if (!fs.existsSync(metaEditorPath)) {
            errors.push(`MetaEditor not found at: "${metaEditorPath}"`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

module.exports = {
    setOutputChannel,
    isWineInstalled,
    validateWinePath,
    toWineWindowsPath,
    toWineWindowsPathLegacy,
    isWineEnabled,
    getWineBinary,
    getWinePrefix,
    getWineTimeout,
    getWineEnv,
    spawnWineProcess,
    validateWineSetup,
    log,
    logWarning,
    logError,
    buildWineCmd,
    buildSpawnOptions,
    buildBatchContent,
    createWineBatchFile,
    cleanupBatchFile
};

/**
 * Build command to execute a .bat file via Wine's cmd.exe.
 *
 * Executes `wine cmd /c <bat_path>` to run a pre-written batch file.
 *
 * @param {string} wineBinary - Path to wine executable (e.g. 'wine64')
 * @param {string} batWinPath - Windows-style path to the .bat file to execute
 * @returns {{ executable: string, args: string[] }}
 */
function buildWineCmd(wineBinary, batWinPath) {
    return {
        executable: wineBinary,
        args: ['cmd', '/c', batWinPath],
    };
}

/**
 * Build spawn options for MetaEditor/Wine processes.
 *
 * On Windows, Node's spawn() will otherwise re-escape embedded quotes in arguments
 * (e.g. /compile:"C:\\Path With Spaces\\file.mq5"), which breaks MetaEditor.
 * This restores the behavior from PR #7 by enabling windowsVerbatimArguments.
 */
function buildSpawnOptions({ env } = {}) {
    const options = { shell: false };
    if (env) options.env = env;
    if (process.platform === 'win32') {
        options.windowsVerbatimArguments = true;
    }
    return options;
}


/**
 * Build the content for a temporary .bat file that executes a Wine command.
 *
 * This bypasses Wine's MSVC-style command line reconstruction which escapes
 * embedded quotes (" -> \") in a way that cmd.exe cannot parse. By writing
 * the exact command to a .bat file, cmd.exe reads and executes it directly.
 *
 * @param {string} exeWinPath - Windows-style path to the executable
 * @param {string[]} args - Arguments with correct quoting (e.g. '/compile:"Z:\\..."')
 * @returns {string} The .bat file content
 */
function buildBatchContent(exeWinPath, args) {
    const quotedExe = '"' + exeWinPath + '"';
    const cmdLine = [quotedExe, ...args].join(' ');
    return '@echo off\r\n' + cmdLine + '\r\n';
}

/**
 * Create a temporary .bat file for Wine command execution.
 *
 * Writes the command to a temp file and converts its path to Windows format
 * so it can be passed to `wine cmd /c <bat_path>`.
 *
 * @param {string} content - The .bat file content (from buildBatchContent)
 * @param {string} wineBinary - Path to wine executable
 * @param {string} [winePrefix] - Optional WINEPREFIX path
 * @returns {Promise<{unixPath: string, winPath: string}>}
 */
async function createWineBatchFile(content, wineBinary, winePrefix) {
    const tmpDir = os.tmpdir();
    const batName = 'mql_compile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.bat';
    const batUnixPath = nodePath.join(tmpDir, batName);

    fs.writeFileSync(batUnixPath, content, 'utf8');

    const result = await toWineWindowsPath(batUnixPath, wineBinary, winePrefix);
    if (!result.success) {
        try { fs.unlinkSync(batUnixPath); } catch (_) { /* ignore */ }
        throw new Error('Failed to convert batch file path: ' + result.error);
    }

    return { unixPath: batUnixPath, winPath: result.path };
}

/**
 * Clean up a temporary .bat file created by createWineBatchFile.
 *
 * @param {string} unixPath - The Unix path to the .bat file
 */
function cleanupBatchFile(unixPath) {
    try { fs.unlinkSync(unixPath); } catch (_) { /* ignore */ }
}
