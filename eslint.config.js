'use strict';

const commonGlobals = {
    Buffer: 'readonly',
    console: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    module: 'readonly',
    process: 'readonly',
    require: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    URL: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
};

const mochaGlobals = {
    after: 'readonly',
    afterEach: 'readonly',
    before: 'readonly',
    beforeEach: 'readonly',
    describe: 'readonly',
    it: 'readonly',
    setup: 'readonly',
    suite: 'readonly',
    suiteSetup: 'readonly',
    suiteTeardown: 'readonly',
    teardown: 'readonly',
    test: 'readonly',
};

module.exports = [
    {
        ignores: ['dist/**', 'node_modules/**', '.vscode-test/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...commonGlobals },
        },
        rules: {
            indent: ['error', 4, { SwitchCase: 1 }],
            'linebreak-style': 'off',
            quotes: ['error', 'single', { avoidEscape: true }],
            semi: ['error', 'always'],
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
            'no-constant-condition': ['error', { checkLoops: false }],
        },
    },
    {
        files: ['**/*.test.js', '**/*.spec.js', '**/test/**/*.js', '**/tests/**/*.js'],
        languageOptions: {
            globals: { ...mochaGlobals },
        },
    },
];