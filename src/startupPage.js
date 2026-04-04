const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function showStartupPage(context, force = false) {
    const currentVersion = context.extension.packageJSON.version || '1.0.0';

    // Check if dismissed for current version
    if (!force) {
        const dismissedVersion = context.globalState.get('mql-tools.startupPageDismissedVersion');
        if (dismissedVersion === currentVersion) {
            return; // Already dismissed for this version, don't show
        }
    }

    const panel = vscode.window.createWebviewPanel(
        'mqlStartup',
        `MQL Extension Welcome (v${currentVersion})`,
        vscode.ViewColumn.One,
        {
            enableScripts: true
        }
    );

    panel.webview.html = getWebviewContent(currentVersion, context.extensionPath);

    // Mark version as seen when the panel is closed
    panel.onDidDispose(() => {
        context.globalState.update('mql-tools.startupPageDismissedVersion', currentVersion);
    });

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'dismiss':
                    panel.dispose();
                    return;
            }
        },
        undefined,
        context.subscriptions
    );
}

const TAB_NAMES = ['debugger', 'livelog', 'backtest', 'tradereport'];

function readTabPartial(extensionPath, tabName) {
    const tabPath = path.join(extensionPath, 'media', 'tabs', `tab-${tabName}.html`);
    try {
        return fs.readFileSync(tabPath, 'utf8');
    } catch (err) {
        console.error(`[MQL Tools] Failed to read tab partial "${tabPath}": ${err.message}`);
        return `<!-- tab-${tabName} unavailable -->`;
    }
}

function getWebviewContent(version, extensionPath) {
    const htmlPath = path.join(extensionPath, 'media', 'startupPage.html');
    try {
        const nonce = require('crypto').randomBytes(16).toString('base64');
        let html = fs.readFileSync(htmlPath, 'utf8');
        for (const tabName of TAB_NAMES) {
            html = html.replace(`{{tab-${tabName}}}`, readTabPartial(extensionPath, tabName));
        }
        return html
            .replace(/\{\{version\}\}/g, version)
            .replace(/\{\{nonce\}\}/g, nonce);
    } catch (err) {
        console.error(`[MQL Tools] Failed to read startup page from "${htmlPath}": ${err.message}`);
        return `<!DOCTYPE html><html><body><p>MQL Tools v${version} — startup page unavailable.</p></body></html>`;
    }
}

module.exports = {
    showStartupPage
};
