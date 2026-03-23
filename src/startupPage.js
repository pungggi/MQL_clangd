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
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent(currentVersion, context.extensionPath);

    // Mark version as seen when the panel is closed (by any means)
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

function getWebviewContent(version, extensionPath) {
    const htmlPath = path.join(extensionPath, 'media', 'startupPage.html');
    return fs.readFileSync(htmlPath, 'utf8').replace(/\{\{version\}\}/g, version);
}

module.exports = {
    showStartupPage
};
