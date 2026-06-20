// Mock for vscode API
const path = require('path');

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

const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
};

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
    }
}

const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
};

const CodeActionKind = {
    Empty: { value: '' },
    QuickFix: { value: 'quickfix' },
    Refactor: { value: 'refactor' },
    RefactorExtract: { value: 'refactor.extract' },
    RefactorInline: { value: 'refactor.inline' },
    RefactorRewrite: { value: 'refactor.rewrite' },
    Source: { value: 'source' },
    SourceOrganizeImports: { value: 'source.organizeImports' }
};

class CodeAction {
    constructor(title, kind) {
        this.title = title;
        this.kind = kind;
        this.diagnostics = [];
        this.command = undefined;
        this.isPreferred = false;
    }
}

class CodeLens {
    constructor(range, command) {
        this.range = range;
        this.command = command;
    }
}

class EventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (listener) => {
            this._listeners.push(listener);
            return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
        };
    }
    fire(value) {
        for (const l of this._listeners.slice()) l(value);
    }
    dispose() { this._listeners = []; }
}

const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
    Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
    Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
    Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20,
    EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25
};

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

module.exports = {
    Range,
    Position,
    RelativePattern,
    DiagnosticSeverity,
    Diagnostic,
    ConfigurationTarget,
    CodeActionKind,
    CodeAction,
    CodeLens,
    EventEmitter,
    SymbolKind,
    DocumentSymbol,
    env: {
        language: 'en'
    },
    window: {
        showInformationMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
        showQuickPick: () => Promise.resolve(undefined),
        showInputBox: () => Promise.resolve(undefined),
        createOutputChannel: () => ({
            appendLine: () => { },
            show: () => { },
            clear: () => { }
        }),
        withProgress: (options, task) => task({ report: () => { } })
    },
    workspace: {
        // Allow tests to override getConfiguration behavior
        _configMock: null,
        getConfiguration: function () {
            if (this._configMock) {
                return this._configMock;
            }
            return {
                get: (key, defaultValue) => defaultValue,
                update: () => Promise.resolve(),
                inspect: () => ({ workspaceValue: undefined })
            };
        },
        workspaceFolders: [],
        findFiles: () => Promise.resolve([]),
        fs: {
            stat: () => Promise.resolve({ type: 1 }),
            readFile: () => Promise.resolve(Buffer.from(''))
        }
    },
    Uri: {
        file: (path) => ({ fsPath: path, path: path }),
        parse: (path) => ({ fsPath: path, path: path }),
        joinPath: (base, ...segments) => {
            const joined = path.join(base.fsPath, ...segments);
            return { fsPath: joined, path: joined };
        }
    },
    languages: {
        createDiagnosticCollection: () => ({
            clear: () => { },
            set: () => { },
            delete: () => { }
        })
    },
    commands: {
        executeCommand: () => Promise.resolve(),
        registerCommand: () => ({ dispose: () => { } })
    },
    extensions: {
        getExtension: () => null
    }
};
