/**
 * Bump version script for MQL Clangd extension
 * Increments the patch version of the extension
 */
const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    // Increment patch version
    const versionParts = pkg.version.split('.');
    const patchVersion = parseInt(versionParts[versionParts.length - 1], 10);
    if (!Number.isFinite(patchVersion) || !Number.isInteger(patchVersion)) {
        throw new Error(`Invalid patch version: "${versionParts[versionParts.length - 1]}" is not a valid integer`);
    }
    versionParts[versionParts.length - 1] = patchVersion + 1;
    pkg.version = versionParts.join('.');

    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4) + '\n');

    console.log(`Bumped version to ${pkg.version}`);
} catch (error) {
    console.error('Error bumping version:', error);
    process.exit(1);
}
