'use strict';

const vscode = require('vscode');

/**
 * Persistent status-bar item that reflects the outcome of the last compile /
 * syntax-check: error count, warning count, target label and MQL version.
 *
 * Clicking it focuses the Problems panel so errors are never more than one
 * click away. Designed as a singleton scoped to the extension activation.
 *
 * Priority 95 sits between the log tailer (100) and chart layout (90) so the
 * compile result reads left-most of the MQL cluster in the status bar.
 */
const PRIORITY = 95;
const COMMAND_ID = 'mql_tools.openCompileProblems';

let statusItem = null;
let lastResult = null;

/**
 * Create the status-bar item and register its click command. Call once during
 * `activate()`; the disposable is pushed onto the extension subscriptions.
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    if (statusItem) return;

    statusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        PRIORITY
    );
    statusItem.command = COMMAND_ID;
    statusItem.tooltip = 'MQL compile result — click to open Problems';
    statusItem.name = 'MQL Compile Result';

    context.subscriptions.push(statusItem);

    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_ID, () => {
            vscode.commands.executeCommand('workbench.panel.markers.view.focus');
        })
    );

    // Start hidden until the first compile actually runs.
    statusItem.hide();
}

/**
 * Update the status bar after a compile / syntax-check completes.
 *
 * @param {Object} result
 * @param {number} result.errorCount      Number of errors reported.
 * @param {number} result.warningCount    Number of warnings reported.
 * @param {string} [result.targetLabel]   e.g. `'MyEA.mq5' (1.10)`.
 * @param {boolean} [result.check]        True for a syntax-check, false for a real compile.
 */
function update(result) {
    if (!statusItem) return;

    const errorCount = Math.max(0, result.errorCount | 0);
    const warningCount = Math.max(0, result.warningCount | 0);
    const check = result.check === true;
    lastResult = { errorCount, warningCount, targetLabel: result.targetLabel || '', check };

    const modeTag = check ? 'check' : 'build';
    const target = lastResult.targetLabel ? ` ${lastResult.targetLabel}` : '';

    let icon;
    let bg;
    if (errorCount > 0) {
        icon = '$(error)';
        bg = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (warningCount > 0) {
        icon = '$(warning)';
        bg = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        icon = '$(check)';
        bg = undefined;
    }

    const warnPart = warningCount > 0 ? ` ⚠${warningCount}` : '';
    statusItem.text = `${icon} MQL ${modeTag}: ${errorCount}e${warnPart}${target}`;
    statusItem.backgroundColor = bg;
    statusItem.tooltip = `${errorCount} error(s), ${warningCount} warning(s) — click to open Problems`;

    statusItem.show();
}

/** Hide and reset the item (e.g. when the workspace closes). */
function reset() {
    lastResult = null;
    if (statusItem) statusItem.hide();
}

module.exports = {
    activate,
    update,
    reset,
    /** @returns {Object|null} The last reported compile result, if any. */
    getLastResult: () => lastResult
};
