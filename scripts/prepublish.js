/**
 * Prepublish script for MQL Clangd extension
 * Updates the main entry point to point to the distribution file
 */
const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));


    // Update main entry point
    pkg.main = './dist/extension.js';

    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4) + '\n');

    console.log(`Updated version to ${pkg.version} and main to ${pkg.main}`);
} catch (error) {
    console.error('Error updating package.json:', error);
    process.exit(1);
}

