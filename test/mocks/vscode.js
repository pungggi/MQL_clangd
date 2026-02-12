// Mock for vscode API — enhanced for integration testing
const path = require('path');

// =========================================================================
// Tracking arrays — collect registration calls for test assertions
// =========================================================================
const _tracking = {
    registeredCommands: [],         // { id, handler }
    registeredProviders: [],        // { type, selector, provider, ...options }
    createdDiagnosticCollections: [],
    createdOutputChannels: [],      // { name, languageId }
    createdFileSystemWatchers: [],  // { pattern }
    shownErrors: [],
    shownWarnings: [],
    shownInfos: [],
    createdStatusBarItems: [],
};

/** Reset all tracking arrays between test runs */
function _resetTracking() {
    for (const key of Object.keys(_tracking)) {
        _tracking[key].length = 0;
    }
}

// =========================================================================
// Core value types
// =========================================================================

class Range {
    constructor(startLine, startChar, endLine, endChar) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class RelativePattern {
    constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
    }
}

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
        this.source = '';
        this.code = undefined;
    }
}

class CodeAction {
    constructor(title, kind) {
        this.title = title;
        this.kind = kind;
    }
}

class SnippetString {
    constructor(value) {
        this.value = value;
    }
}

class CompletionItem {
    constructor(label, kind) {
        this.label = label;
        this.kind = kind;
    }
}

class CompletionList {
    constructor(items, isIncomplete) {
        this.items = items || [];
        this.isIncomplete = isIncomplete || false;
    }
}

class Hover {
    constructor(contents, range) {
        this.contents = contents;
        this.range = range;
    }
}

class MarkdownString {
    constructor(value) {
        this.value = value || '';
        this.isTrusted = false;
        this.supportHtml = false;
    }
    appendMarkdown(str) { this.value += str; return this; }
    appendCodeblock(code, lang) { this.value += `\`\`\`${lang || ''}\n${code}\n\`\`\``; return this; }
    appendText(str) { this.value += str; return this; }
}

class SignatureHelp {
    constructor() {
        this.signatures = [];
        this.activeSignature = 0;
        this.activeParameter = 0;
    }
}

class SignatureInformation {
    constructor(label, documentation) {
        this.label = label;
        this.documentation = documentation;
        this.parameters = [];
    }
}

class ParameterInformation {
    constructor(labelOrRange, documentation) {
        this.label = labelOrRange;
        this.documentation = documentation;
    }
}

class DocumentSymbol {
    constructor(name, detail, kind, range, selectionRange) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
        this.children = [];
    }
}

class ColorInformation {
    constructor(range, color) {
        this.range = range;
        this.color = color;
    }
}

class Color {
    constructor(red, green, blue, alpha) {
        this.red = red;
        this.green = green;
        this.blue = blue;
        this.alpha = alpha;
    }
}

class ColorPresentation {
    constructor(label) {
        this.label = label;
    }
}

class TextEdit {
    constructor(range, newText) {
        this.range = range;
        this.newText = newText;
    }
    static replace(range, newText) { return new TextEdit(range, newText); }
    static insert(position, newText) { return new TextEdit(new Range(position.line, position.character, position.line, position.character), newText); }
    static delete(range) { return new TextEdit(range, ''); }
}

class WorkspaceEdit {
    constructor() {
        this._edits = [];
    }
    replace(uri, range, newText) { this._edits.push({ uri, range, newText }); }
    insert(uri, position, newText) { this._edits.push({ uri, position, newText }); }
    delete(uri, range) { this._edits.push({ uri, range, newText: '' }); }
}

// =========================================================================
// Enums
// =========================================================================

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const CompletionItemKind = { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 };
const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

const CodeActionKind = {
    QuickFix: 'quickfix',
    Refactor: 'refactor',
    Source: 'source',
};

// =========================================================================
// Disposable helper
// =========================================================================
const disposable = () => ({ dispose: () => { } });

// =========================================================================
// File system watcher mock
// =========================================================================
function createFileSystemWatcher(pattern) {
    const watcher = {
        pattern,
        onDidChange: () => disposable(),
        onDidCreate: () => disposable(),
        onDidDelete: () => disposable(),
        dispose: () => { },
    };
    _tracking.createdFileSystemWatchers.push({ pattern });
    return watcher;
}

// =========================================================================
// Status bar item mock
// =========================================================================
function createStatusBarItem(alignment, priority) {
    const item = {
        alignment,
        priority,
        text: '',
        tooltip: '',
        command: undefined,
        show: () => { },
        hide: () => { },
        dispose: () => { },
    };
    _tracking.createdStatusBarItems.push(item);
    return item;
}

// =========================================================================
// Module export
// =========================================================================
module.exports = {
    // Tracking interface for integration tests
    _tracking,
    _resetTracking,

    // Value types
    Range,
    Position,
    RelativePattern,
    Diagnostic,
    CodeAction,
    SnippetString,
    CompletionItem,
    CompletionList,
    Hover,
    MarkdownString,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    DocumentSymbol,
    ColorInformation,
    Color,
    ColorPresentation,
    TextEdit,
    WorkspaceEdit,

    // Enums
    DiagnosticSeverity,
    ConfigurationTarget,
    StatusBarAlignment,
    CompletionItemKind,
    SymbolKind,
    ViewColumn,
    ProgressLocation,
    CodeActionKind,

    // Namespaces
    env: {
        language: 'en'
    },

    window: {
        showInformationMessage: (...args) => {
            _tracking.shownInfos.push(args);
            return Promise.resolve();
        },
        showErrorMessage: (...args) => {
            _tracking.shownErrors.push(args);
            return Promise.resolve();
        },
        showWarningMessage: (...args) => {
            _tracking.shownWarnings.push(args);
            return Promise.resolve();
        },
        createOutputChannel: (name, languageId) => {
            const channel = {
                name,
                appendLine: () => { },
                append: () => { },
                show: () => { },
                clear: () => { },
                dispose: () => { },
            };
            _tracking.createdOutputChannels.push({ name, languageId });
            return channel;
        },
        withProgress: (options, task) => task({ report: () => { } }),
        createStatusBarItem,
        activeTextEditor: null,
        visibleTextEditors: [],
        showQuickPick: () => Promise.resolve(undefined),
        createWebviewPanel: () => ({
            webview: {
                html: '',
                onDidReceiveMessage: () => disposable(),
                postMessage: () => { },
                asWebviewUri: (uri) => uri,
                cspSource: '',
            },
            onDidDispose: () => disposable(),
            reveal: () => { },
            dispose: () => { },
        }),
    },

    workspace: {
        // Allow tests to override getConfiguration behavior
        _configMock: null,
        getConfiguration: function (section) {
            if (this._configMock) {
                return this._configMock;
            }
            // Return a deep-ish mock that supports dotted access used by the extension
            const defaults = {};
            return {
                get: (key, defaultValue) => defaultValue,
                update: () => Promise.resolve(),
                inspect: () => ({ workspaceValue: undefined }),
                // Support direct property access (e.g. config.Metaeditor.xxx)
                Metaeditor: { Metaeditor5Dir: '', Include5Dir: '', Metaeditor4Dir: '', Include4Dir: '', Portable5: false, Portable4: false },
                Wine: { Enabled: false, Binary: 'wine64', Prefix: '', Timeout: 60000 },
                AutoCheck: { Enabled: false },
                LogFile: { DeleteLog: false },
                Diagnostics: { Lightweight: false },
            };
        },
        workspaceFolders: [
            {
                uri: { fsPath: '/mock/workspace', toString: () => 'file:///mock/workspace' },
                name: 'mock-workspace',
                index: 0,
            }
        ],
        getWorkspaceFolder: () => ({
            uri: { fsPath: '/mock/workspace', toString: () => 'file:///mock/workspace' },
            name: 'mock-workspace',
            index: 0,
        }),
        findFiles: () => Promise.resolve([]),
        fs: {
            stat: () => Promise.resolve({ type: 1 }),
            readFile: () => Promise.resolve(Buffer.from(''))
        },
        createFileSystemWatcher,
        onDidChangeTextDocument: () => disposable(),
        onDidOpenTextDocument: () => disposable(),
        onDidCloseTextDocument: () => disposable(),
        onDidSaveTextDocument: () => disposable(),
        onDidChangeConfiguration: () => disposable(),
        textDocuments: [],
        applyEdit: () => Promise.resolve(true),
    },

    Uri: {
        file: (p) => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
        parse: (p) => ({ fsPath: p, path: p, toString: () => p }),
        joinPath: (base, ...segments) => {
            const joined = path.join(base.fsPath, ...segments);
            return { fsPath: joined, path: joined, toString: () => `file://${joined}` };
        }
    },

    languages: {
        createDiagnosticCollection: (name) => {
            const coll = {
                name,
                clear: () => { },
                set: () => { },
                delete: () => { },
                dispose: () => { },
                forEach: () => { },
            };
            _tracking.createdDiagnosticCollections.push({ name });
            return coll;
        },
        registerHoverProvider: (selector, provider) => {
            _tracking.registeredProviders.push({ type: 'HoverProvider', selector, provider });
            return disposable();
        },
        registerDefinitionProvider: (selector, provider) => {
            _tracking.registeredProviders.push({ type: 'DefinitionProvider', selector, provider });
            return disposable();
        },
        registerCompletionItemProvider: (selector, provider, ...triggers) => {
            _tracking.registeredProviders.push({ type: 'CompletionItemProvider', selector, provider, triggers });
            return disposable();
        },
        registerColorProvider: (selector, provider) => {
            _tracking.registeredProviders.push({ type: 'ColorProvider', selector, provider });
            return disposable();
        },
        registerDocumentSymbolProvider: (selector, provider) => {
            _tracking.registeredProviders.push({ type: 'DocumentSymbolProvider', selector, provider });
            return disposable();
        },
        registerSignatureHelpProvider: (selector, provider, ...triggers) => {
            _tracking.registeredProviders.push({ type: 'SignatureHelpProvider', selector, provider, triggers });
            return disposable();
        },
        registerCodeActionsProvider: (selector, provider, metadata) => {
            _tracking.registeredProviders.push({ type: 'CodeActionsProvider', selector, provider, metadata });
            return disposable();
        },
    },

    commands: {
        executeCommand: () => Promise.resolve(),
        registerCommand: (id, handler) => {
            _tracking.registeredCommands.push({ id, handler });
            return disposable();
        },
    },

    extensions: {
        getExtension: () => ({
            packageJSON: { version: '1.0.0' }
        }),
    },
};
