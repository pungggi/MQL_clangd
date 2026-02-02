const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    // Increment patch version
    const versionParts = pkg.version.split('.');
    const patchVersion = parseInt(versionParts[versionParts.length - 1]) + 1;
    versionParts[versionParts.length - 1] = patchVersion;
    pkg.version = versionParts.join('.');

    fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 4) + '\n');

    console.log(`Bumped version to ${pkg.version}`);
} catch (error) {
    console.error('Error bumping version:', error);
    process.exit(1);
}
