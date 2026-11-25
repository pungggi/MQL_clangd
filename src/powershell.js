'use strict';

const fs = require('fs');
const path = require('path');

// Resolve the system PowerShell by absolute path so we don't rely on PATH /
// current-directory search order (which could run a hijacked powershell.exe in
// an untrusted workspace). Fall back to the bare name only if it's missing.
// Shared by the workers that need a PowerShell host (chart layout, MetaEditor
// GUI compile).
function resolvePowershell() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fs.existsSync(abs) ? abs : 'powershell.exe';
}

module.exports = { resolvePowershell };
