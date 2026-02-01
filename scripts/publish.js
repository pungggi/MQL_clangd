#!/usr/bin/env node
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const target = args.find(arg => ['vsce', 'ovsx'].includes(arg));
const isPreRelease = args.includes('--pre-release');

if (!target) {
    console.error('Usage: node scripts/publish.js <vsce|ovsx> [--pre-release]');
    process.exit(1);
}

let env;
try {
    env = require('../.vscode/.env.json');
} catch (e) {
    console.error('Error: .vscode/.env.json not found. Create it with VSCE_PAT and OVSX_PAT keys.');
    process.exit(1);
}

const pat = target === 'vsce' ? env.VSCE_PAT : env.OVSX_PAT;

if (!pat) {
    console.error(`Error: ${target.toUpperCase()}_PAT not found in .vscode/.env.json`);
    process.exit(1);
}

const cmd = `npx ${target === 'vsce' ? 'vsce' : 'ovsx'} publish --pat ${pat}${isPreRelease ? ' --pre-release' : ''}`;
console.log(`Publishing to ${target.toUpperCase()}${isPreRelease ? ' (Pre-Release)' : ''}...`);

try {
    execSync(cmd, { stdio: 'inherit' });
} catch (e) {
    // Run afterpublish even on failure to revert main
    try {
        execSync('node scripts/afterpublish.js', { stdio: 'inherit' });
    } catch (afterErr) {
        console.error('Failed to run afterpublish:', afterErr.message);
    }
    process.exit(1);
}

// Run afterpublish to revert main back to src/extension.js
try {
    execSync('node scripts/afterpublish.js', { stdio: 'inherit' });
} catch (e) {
    console.error('Failed to run afterpublish:', e.message);
    process.exit(1);
}

