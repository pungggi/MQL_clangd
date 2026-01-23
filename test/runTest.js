const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        // Explicitly request stable version
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            version: 'stable'
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();
