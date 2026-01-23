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

const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
};

module.exports = {
    Range,
    Position,
    RelativePattern,
    DiagnosticSeverity,
    ConfigurationTarget,
    env: {
        language: 'en'
    },
    window: {
        showInformationMessage: () => Promise.resolve(),
        showErrorMessage: () => Promise.resolve(),
        showWarningMessage: () => Promise.resolve(),
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
