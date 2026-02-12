const assert = require('assert');
const Module = require('module');

// 1. Hook the Node.js module loader to intercept 'vscode'
const vscodeMock = require('../mocks/vscode');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.apply(this, arguments);
};

// 2. Load modules under test (they will get the mock)
const extension = require('../../src/extension');
const logTailer = require('../../src/logTailer');

// =========================================================================
// Helpers
// =========================================================================

/** Build a minimal ExtensionContext stub */
function createMockContext() {
    const stateStore = () => ({
        _store: {},
        get(key, defaultValue) { return key in this._store ? this._store[key] : defaultValue; },
        update(key, value) { this._store[key] = value; return Promise.resolve(); },
    });
    return {
        subscriptions: [],
        extensionUri: { fsPath: '/mock/extension', path: '/mock/extension', toString: () => 'file:///mock/extension' },
        globalState: stateStore(),
        workspaceState: stateStore(),
    };
}

/** Wait for a condition to become true (used for delayed registrations) */
function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            if (predicate()) return resolve();
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
            }
            setTimeout(check, intervalMs);
        };
        check();
    });
}

// =========================================================================
// Tests
// =========================================================================

suite('Integration Tests — activate() / deactivate()', () => {
    let ctx;

    setup(() => {
        vscodeMock._resetTracking();
        vscodeMock.workspace._configMock = null;
        ctx = createMockContext();
    });

    teardown(() => {
        extension.deactivate();
    });

    // -----------------------------------------------------------------
    // Basic lifecycle
    // -----------------------------------------------------------------

    test('activate() completes without throwing', () => {
        assert.doesNotThrow(() => extension.activate(ctx));
    });

    test('deactivate() completes without throwing', () => {
        assert.doesNotThrow(() => extension.deactivate());
    });

    // -----------------------------------------------------------------
    // VS Code API object creation
    // -----------------------------------------------------------------

    test('activate() creates a diagnostic collection', () => {
        extension.activate(ctx);
        const collections = vscodeMock._tracking.createdDiagnosticCollections;
        assert.ok(collections.length >= 1, `Expected at least 1 diagnostic collection, got ${collections.length}`);
        assert.ok(
            collections.some(c => c.name === 'mql'),
            'Expected a diagnostic collection named "mql"'
        );
    });

    test('activate() creates an output channel', () => {
        extension.activate(ctx);
        const channels = vscodeMock._tracking.createdOutputChannels;
        assert.ok(channels.length >= 1, `Expected at least 1 output channel, got ${channels.length}`);
        assert.ok(
            channels.some(c => c.name === 'MQL'),
            'Expected an output channel named "MQL"'
        );
    });

    // -----------------------------------------------------------------
    // Command registration
    // -----------------------------------------------------------------

    test('activate() registers all expected commands', () => {
        extension.activate(ctx);
        const cmds = vscodeMock._tracking.registeredCommands;
        const ids = cmds.map(c => c.id);

        const expectedIds = [
            // Compilation
            'mql_tools.checkFile',
            'mql_tools.compileFile',
            'mql_tools.compileScript',
            // Help
            'mql_tools.help',
            'mql_tools.offlineHelp',
            // Compile target management
            'mql_tools.selectCompileTarget',
            'mql_tools.resetCompileTarget',
            'mql_tools.resetAllCompileTargets',
            // Configuration & tools
            'mql_tools.configurations',
            'mql_tools.Addicon',
            // Context menu
            'mql_tools.Showfiles',
            'mql_tools.InsMQL',
            'mql_tools.InsMQH',
            'mql_tools.InsNameMQL',
            'mql_tools.InsNameMQH',
            'mql_tools.InsResource',
            'mql_tools.InsImport',
            'mql_tools.InsTime',
            'mql_tools.InsIcon',
            'mql_tools.openInME',
            'mql_tools.openTradingTerminal',
            'mql_tools.commentary',
            // Log tailing
            'mql_tools.toggleTerminalLog',
            'mql_tools.installLiveLog',
            'mql_tools.switchLogMode',
            // Rapid EA
            'mql_tools.openRapidEA',
            'mql_tools.openSettings',
        ];

        for (const id of expectedIds) {
            assert.ok(ids.includes(id), `Missing command registration: "${id}"`);
        }
    });

    test('every registered command has a handler function', () => {
        extension.activate(ctx);
        const cmds = vscodeMock._tracking.registeredCommands;
        for (const cmd of cmds) {
            assert.strictEqual(typeof cmd.handler, 'function', `Command "${cmd.id}" handler is not a function`);
        }
    });

    // -----------------------------------------------------------------
    // Language provider registration
    // -----------------------------------------------------------------

    test('activate() registers HoverProvider for mql-output', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'HoverProvider' && p.selector === 'mql-output'),
            'Expected HoverProvider for "mql-output"'
        );
    });

    test('activate() registers DefinitionProvider for mql-output', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'DefinitionProvider' && p.selector === 'mql-output'),
            'Expected DefinitionProvider for "mql-output"'
        );
    });

    test('activate() registers HoverProvider for MQL source files', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'HoverProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected HoverProvider for MQL source files'
        );
    });

    test('activate() registers ColorProvider for MQL source files', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'ColorProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected ColorProvider for MQL source files'
        );
    });

    test('activate() registers CompletionItemProvider for MQL source files', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'CompletionItemProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected CompletionItemProvider for MQL source files'
        );
    });

    test('activate() registers DocumentSymbolProvider for MQL source files', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'DocumentSymbolProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected DocumentSymbolProvider for MQL source files'
        );
    });

    test('activate() registers CodeActionsProvider for MQL source files', () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;
        assert.ok(
            providers.some(p => p.type === 'CodeActionsProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected CodeActionsProvider for MQL source files'
        );
    });

    test('activate() registers SignatureHelpProvider after delay', async () => {
        extension.activate(ctx);
        const providers = vscodeMock._tracking.registeredProviders;

        // SignatureHelpProvider is registered after a 1-second delay
        await waitFor(
            () => providers.some(p => p.type === 'SignatureHelpProvider'),
            3000
        );

        assert.ok(
            providers.some(p => p.type === 'SignatureHelpProvider' && p.selector?.pattern?.includes('mqh')),
            'Expected SignatureHelpProvider for MQL source files'
        );
    });

    // -----------------------------------------------------------------
    // File watcher
    // -----------------------------------------------------------------

    test('activate() creates a file system watcher for MQL files', () => {
        extension.activate(ctx);
        const watchers = vscodeMock._tracking.createdFileSystemWatchers;
        assert.ok(watchers.length >= 1, 'Expected at least 1 file system watcher');
        assert.ok(
            watchers.some(w => typeof w.pattern === 'string' && w.pattern.includes('mq')),
            'Expected watcher pattern to include MQL extensions'
        );
    });

    // -----------------------------------------------------------------
    // Context subscriptions
    // -----------------------------------------------------------------

    test('activate() populates context.subscriptions', () => {
        extension.activate(ctx);
        const commandCount = vscodeMock._tracking.registeredCommands.length;
        // Subscriptions must exceed commands since providers, listeners, and
        // watchers are also pushed into context.subscriptions.
        assert.ok(
            ctx.subscriptions.length > commandCount,
            `Expected subscriptions (${ctx.subscriptions.length}) to exceed command count (${commandCount})`
        );
        assert.ok(
            ctx.subscriptions.length > 0,
            'Expected non-empty subscriptions'
        );
    });

    test('all subscriptions have a dispose method', () => {
        extension.activate(ctx);
        for (let i = 0; i < ctx.subscriptions.length; i++) {
            const sub = ctx.subscriptions[i];
            assert.ok(
                typeof sub.dispose === 'function',
                `Subscription at index ${i} lacks a dispose() method`
            );
        }
    });

    // -----------------------------------------------------------------
    // Status bar
    // -----------------------------------------------------------------

    test('activate() creates status bar items', () => {
        extension.activate(ctx);
        const items = vscodeMock._tracking.createdStatusBarItems;
        assert.ok(items.length >= 1, 'Expected at least 1 status bar item');
    });

    // -----------------------------------------------------------------
    // Wine disabled by default
    // -----------------------------------------------------------------

    test('no Wine error shown when Wine is disabled (default)', () => {
        extension.activate(ctx);
        const errors = vscodeMock._tracking.shownErrors;
        const wineErrors = errors.filter(e => String(e[0]).toLowerCase().includes('wine'));
        assert.strictEqual(wineErrors.length, 0, 'Expected no Wine-related errors when Wine is disabled');
    });

    // -----------------------------------------------------------------
    // Re-exports for backward compatibility
    // -----------------------------------------------------------------

    test('module re-exports replaceLog for backward compatibility', () => {
        assert.strictEqual(typeof extension.replaceLog, 'function');
    });

    test('module re-exports tf for backward compatibility', () => {
        assert.strictEqual(typeof extension.tf, 'function');
    });

    // -----------------------------------------------------------------
    // deactivate() behavior
    // -----------------------------------------------------------------

    test('deactivate() stops logTailer', () => {
        // Ensure logTailer is in a known state
        let stopCalled = false;
        const originalStop = logTailer.stop.bind(logTailer);
        logTailer.stop = function () {
            stopCalled = true;
            return originalStop();
        };

        try {
            extension.deactivate();
            assert.strictEqual(stopCalled, true, 'deactivate() should call logTailer.stop()');
        } finally {
            logTailer.stop = originalStop;
        }
    });

    // -----------------------------------------------------------------
    // Event listener registration
    // -----------------------------------------------------------------

    test('activate() registers onDidChangeTextDocument listeners', () => {
        extension.activate(ctx);
        // registerLightweightDiagnostics + registerAutoCheck each register one
        assert.ok(
            vscodeMock._tracking.onDidChangeTextDocumentListeners.length >= 2,
            `Expected >= 2 onDidChangeTextDocument listeners, got ${vscodeMock._tracking.onDidChangeTextDocumentListeners.length}`
        );
    });

    test('activate() registers onDidOpenTextDocument listener', () => {
        extension.activate(ctx);
        assert.ok(
            vscodeMock._tracking.onDidOpenTextDocumentListeners.length >= 1,
            `Expected >= 1 onDidOpenTextDocument listener, got ${vscodeMock._tracking.onDidOpenTextDocumentListeners.length}`
        );
    });

    test('activate() registers onDidCloseTextDocument listener', () => {
        extension.activate(ctx);
        assert.ok(
            vscodeMock._tracking.onDidCloseTextDocumentListeners.length >= 1,
            `Expected >= 1 onDidCloseTextDocument listener, got ${vscodeMock._tracking.onDidCloseTextDocumentListeners.length}`
        );
    });

    test('activate() registers onDidSaveTextDocument listener', () => {
        extension.activate(ctx);
        assert.ok(
            vscodeMock._tracking.onDidSaveTextDocumentListeners.length >= 1,
            `Expected >= 1 onDidSaveTextDocument listener, got ${vscodeMock._tracking.onDidSaveTextDocumentListeners.length}`
        );
    });

    // -----------------------------------------------------------------
    // File watcher event handlers
    // -----------------------------------------------------------------

    test('file watcher registers onDidChange, onDidCreate, and onDidDelete handlers', () => {
        extension.activate(ctx);
        const watchers = vscodeMock._tracking.createdFileSystemWatchers;
        const mqlWatcher = watchers.find(w => typeof w.pattern === 'string' && w.pattern.includes('mq'));
        assert.ok(mqlWatcher, 'Expected an MQL file watcher');
        assert.ok(
            mqlWatcher.watcher._onDidChangeHandlers.length >= 1,
            'Expected at least 1 onDidChange handler on file watcher'
        );
        assert.ok(
            mqlWatcher.watcher._onDidCreateHandlers.length >= 1,
            'Expected at least 1 onDidCreate handler on file watcher'
        );
        assert.ok(
            mqlWatcher.watcher._onDidDeleteHandlers.length >= 1,
            'Expected at least 1 onDidDelete handler on file watcher'
        );
    });

    // -----------------------------------------------------------------
    // Wine-enabled scenario
    // -----------------------------------------------------------------

    // Wine is only enabled on non-Windows platforms (isWineEnabled checks process.platform)
    if (process.platform !== 'win32') {
        test('Wine error shown when Wine is enabled but not installed', async () => {
            vscodeMock.workspace._configMock = {
                get: (key, defaultValue) => defaultValue,
                update: () => Promise.resolve(),
                inspect: () => ({ workspaceValue: undefined }),
                Metaeditor: { Metaeditor5Dir: '', Include5Dir: '', Metaeditor4Dir: '', Include4Dir: '', Portable5: false, Portable4: false },
                Wine: { Enabled: true, Binary: 'wine64', Prefix: '', Timeout: 60000 },
                AutoCheck: { Enabled: false },
                LogFile: { DeleteLog: false },
                Diagnostics: { Lightweight: false },
            };

            extension.activate(ctx);

            // Wine check is async — wait for an error message about Wine
            await waitFor(
                () => vscodeMock._tracking.shownErrors.some(
                    e => String(e[0]).toLowerCase().includes('wine')
                ),
                5000
            );

            const wineErrors = vscodeMock._tracking.shownErrors.filter(
                e => String(e[0]).toLowerCase().includes('wine')
            );
            assert.ok(wineErrors.length >= 1, 'Expected at least 1 Wine-related error');
        });
    }

    // -----------------------------------------------------------------
    // Command handler smoke tests
    // -----------------------------------------------------------------

    test('mql_tools.help handler does not throw', () => {
        extension.activate(ctx);
        const cmd = vscodeMock._tracking.registeredCommands.find(c => c.id === 'mql_tools.help');
        assert.ok(cmd, 'Expected mql_tools.help command to be registered');
        assert.doesNotThrow(() => cmd.handler());
    });

    test('mql_tools.openSettings handler does not throw', () => {
        extension.activate(ctx);
        const cmd = vscodeMock._tracking.registeredCommands.find(c => c.id === 'mql_tools.openSettings');
        assert.ok(cmd, 'Expected mql_tools.openSettings command to be registered');
        assert.doesNotThrow(() => cmd.handler());
    });

    // -----------------------------------------------------------------
    // Graceful degradation: missing extension
    // -----------------------------------------------------------------

    test('activate() does not throw when extensions.getExtension returns undefined', () => {
        const original = vscodeMock.extensions.getExtension;
        vscodeMock.extensions.getExtension = () => undefined;
        try {
            assert.doesNotThrow(() => extension.activate(ctx));
        } finally {
            vscodeMock.extensions.getExtension = original;
        }
    });

    // -----------------------------------------------------------------
    // Version tracking
    // -----------------------------------------------------------------

    test('activate() stores version in globalState', async () => {
        extension.activate(ctx);
        // Version update happens after a 2-second sleep.
        // We wait for the globalState to be updated.
        await waitFor(
            () => ctx.globalState._store['mql-tools.version'] !== undefined,
            5000
        );
        assert.ok(ctx.globalState._store['mql-tools.version'], 'Expected version to be stored in globalState');
    });
});
