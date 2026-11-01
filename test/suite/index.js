const path = require('path');
const Mocha = require('mocha');
const Module = require('module');

async function run() {
    const { glob } = await import('glob');

    // ---------------------------------------------------------------------------
    // Bind every module to the same vscode mock the unit runner uses.
    //
    // This MUST happen here, before mocha loads a single test file. Test files
    // resolve `require('vscode')` at module scope, so whoever is loaded first
    // decides which vscode instance the module under test is bound to for the
    // whole run. Installing the hook inside a test file was too late:
    // documentSymbol.test.js pulled in src/provider (and, with it,
    // src/createProperties) before suite/extension.test.js installed its hook,
    // leaving those two bound to the real API and failing 9 tests.
    // ---------------------------------------------------------------------------
    const vscodeMock = require('../mocks/vscode');
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.apply(this, [request, ...rest]);
    };

    // Drop any src module that already loaded before this hook (the extension
    // host can pull it in during activation), so the tests re-require it under
    // the mock instead of ending up with a mixed real/mock environment.
    const srcRoot = path.join(__dirname, '..', '..', 'src') + path.sep;
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(srcRoot)) {
            delete require.cache[key];
        }
    }

    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    const files = await glob('**/*.test.js', { cwd: testsRoot });
    files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));

    return new Promise((c, e) => {
        try {
            mocha.run(failures => {
                if (failures > 0) {
                    e(new Error(`${failures} tests failed.`));
                } else {
                    c();
                }
            });
        } catch (err) {
            console.error(err);
            e(err);
        }
    });
}

module.exports = {
    run
};
