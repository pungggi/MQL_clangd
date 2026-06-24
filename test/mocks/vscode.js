// Mock for vscode API
const path = require('path');

class Range {
    constructor(a, b, c, d) {
        // Accept both Range(line, char, line, char) and Range(Position, Position)
        if (a && typeof a === 'object' && 'line' in a) {
            this.start = { line: a.line, character: a.character };
            this.end = { line: b.line, character: b.character };
        } else {
            this.start = { line: a, character: b };
            this.end = { line: c, character: d };
        }
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
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

/**
 * Records WorkspaceEdit operations so tests can assert what would be applied.
 * Each entry: { op: 'insert'|'replace'|'delete', uri, range?, newText? }
 */
class WorkspaceEdit {
    constructor() {
        this._ops = [];
    }
    insert(uri, pos, newText) { this._ops.push({ op: 'insert', uri, range: pos, newText }); }
    replace(uri, range, newText) { this._ops.push({ op: 'replace', uri, range, newText }); }
    delete(uri, range) { this._ops.push({ op: 'delete', uri, range }); }
    get size() { return this._ops.length; }
    entries() {
        const map = new Map();
        for (const o of this._ops) {
            if (!map.has(o.uri)) map.set(o.uri, []);
            map.get(o.uri).push([o.range, o.newText === undefined ? null : o.newText]);
        }
        return [...map];
    }
}

class ThemeColor {
    constructor(id) { this.id = id; }
}

const StatusBarAlignment = { Left: 1, Right: 2 };

module.exports = {
    Range,
    Position,
    Location,
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
    WorkspaceEdit,
    ThemeColor,
    StatusBarAlignment,
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
        withProgress: (options, task) => task({ report: () => { } }),
        // Minimal status-bar item mock capturing the last text/state.
        createStatusBarItem: (alignment, priority) => ({
            alignment, priority,
            text: '', tooltip: '', name: '', command: '',
            backgroundColor: undefined,
            _shown: false,
            show() { this._shown = true; },
            hide() { this._shown = false; },
            dispose() { this._shown = false; }
        }),
        activeTextEditor: null
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
        file: (p) => ({ fsPath: p, path: p, fragment: '', with(o) { return { fsPath: p, path: p, fragment: o.fragment || '' }; } }),
        parse: (p) => ({ fsPath: p, path: p, fragment: '' }),
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
    },
    DocumentLink: class {
        constructor(range) { this.range = range; }
    }
};
