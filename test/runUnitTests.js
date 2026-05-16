/**
 * Unit test runner that doesn't require VS Code
 * Run with: node test/runUnitTests.js
 */

const Mocha = require('mocha');
const path = require('path');
const Module = require('module');

// Mock the vscode module before any other requires
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'vscode') {
        return require('./mocks/vscode.js');
    }
    return originalRequire.apply(this, arguments);
};

const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 10000
});

// Add the test files
mocha.addFile(path.resolve(__dirname, 'repro_log_parser.test.js'));
mocha.addFile(path.resolve(__dirname, 'debugInstrumentation.test.js'));
mocha.addFile(path.resolve(__dirname, 'debugFeatures.test.js'));
mocha.addFile(path.resolve(__dirname, 'backtestRunner.test.js'));
mocha.addFile(path.resolve(__dirname, 'suite/logic.test.js'));
mocha.addFile(path.resolve(__dirname, 'suite/extension.test.js'));
mocha.addFile(path.resolve(__dirname, 'utf8Mirror.test.js'));
mocha.addFile(path.resolve(__dirname, 'utf8MirrorIntegration.test.js'));
mocha.addFile(path.resolve(__dirname, 'lightweightDiagnostics.test.js'));

// Run the tests
mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
});

