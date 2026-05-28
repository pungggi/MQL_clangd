'use strict';

const fs = require('fs');
const pathModule = require('path');
const { decodeTextBuffer } = require('./textDecoding');

// Regex for #property version "X.YZ"
const REG_PROPERTY_VERSION = /^(\s*#property\s+version\s+["'])([^\r\n"']+)(["']\s*)/im;

/**
 * Build a regex to match a const string declaration like:
 *   const string EA_VERSION = "6.01";
 *   const string EA_VERSION = "6.01"  ;
 *   string const EA_VERSION = "6.01";
 *
 * @param {string} name - The constant name to match
 * @returns {RegExp}
 */
function buildConstStringRegex(name) {
    // Anchored to line start (^ with m flag) to avoid matching commented-out declarations.
    return new RegExp(
        '^\\s*(const\\s+string|string\\s+const)\\s+' +
        escapeRegex(name) +
        '\\s*=\\s*["\']([^\\r\\n"\']+)["\']',
        'im'
    );
}

/**
 * Escape special regex characters in a string.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bump a version string by incrementing its last numeric segment.
 * Preserves leading zeros on the last segment.
 *
 * Examples:
 *   "1.00" → "1.01"
 *   "6.01" → "6.02"
 *   "4.57" → "4.58"
 *   "1.2.3" → "1.2.4"
 *   "1.09" → "1.10"
 *   "2.99" → "2.100"
 *
 * @param {string} version - The version string to bump
 * @returns {string|null} - The bumped version, or null if parsing fails
 */
function bumpVersion(version) {
    if (typeof version !== 'string' || !version.trim()) return null;

    const trimmed = version.trim();

    // Split by dot to find segments
    const segments = trimmed.split('.');
    if (segments.length === 0) return null;

    const lastIdx = segments.length - 1;
    const lastSegment = segments[lastIdx];

    // Reject non-fully-numeric segments (e.g. "1abc" would pass parseInt but is invalid)
    if (!/^\d+$/.test(lastSegment)) return null;
    const lastNum = parseInt(lastSegment, 10);

    // Bump the last segment, preserving zero-padding width
    const bumped = lastNum + 1;
    const paddedLast = lastSegment.length > 0 && lastSegment[0] === '0'
        ? bumped.toString().padStart(lastSegment.length, '0')
        : bumped.toString();

    segments[lastIdx] = paddedLast;
    return segments.join('.');
}

/**
 * Bump the #property version in source text.
 *
 * @param {string} text - MQL source code
 * @returns {{ text: string, oldVersion: string|null, newVersion: string|null }}
 */
function bumpPropertyVersion(text) {
    if (typeof text !== 'string') return { text: text || '', oldVersion: null, newVersion: null };

    const match = text.match(REG_PROPERTY_VERSION);
    if (!match) return { text, oldVersion: null, newVersion: null };

    const oldVersion = match[2];
    const newVersion = bumpVersion(oldVersion);
    if (!newVersion) return { text, oldVersion, newVersion: null };

    const newText = text.replace(REG_PROPERTY_VERSION, `$1${newVersion}$3`);
    return { text: newText, oldVersion, newVersion };
}

/**
 * Bump version constants in source text for the given constant names.
 *
 * @param {string} text - MQL source code
 * @param {string[]} constantNames - Array of constant names to look for (e.g., ["EA_VERSION"])
 * @returns {{ text: string, bumps: Array<{name: string, oldVersion: string|null, newVersion: string|null}> }}
 */
function bumpVersionConstants(text, constantNames) {
    if (typeof text !== 'string') return { text: text || '', bumps: [] };
    if (!Array.isArray(constantNames) || constantNames.length === 0) return { text, bumps: [] };

    let currentText = text;
    const bumps = [];

    for (const name of constantNames) {
        if (typeof name !== 'string' || !name.trim()) continue;

        const regex = buildConstStringRegex(name);
        const match = currentText.match(regex);
        if (!match) {
            bumps.push({ name, oldVersion: null, newVersion: null });
            continue;
        }

        // match[2] is the captured version value
        const oldVersion = match[2];
        const newVersion = bumpVersion(oldVersion);
        if (!newVersion) {
            bumps.push({ name, oldVersion, newVersion: null });
            continue;
        }

        // Replace only the version value inside the quotes
        // The regex captures: group1 = "const string" or "string const", group2 = version value
        // We need to replace just group2
        const fullMatch = match[0];
        const replacement = fullMatch.replace(oldVersion, newVersion);
        // Replace first occurrence only
        const idx = currentText.indexOf(fullMatch);
        if (idx !== -1) {
            currentText = currentText.substring(0, idx) + replacement + currentText.substring(idx + fullMatch.length);
        }

        bumps.push({ name, oldVersion, newVersion });
    }

    return { text: currentText, bumps };
}

/**
 * Detect the encoding of a buffer (mirrors decodeTextBuffer logic).
 * @param {Buffer} buffer
 * @returns {{ encoding: string, bom: boolean }}
 */
function detectEncoding(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { encoding: 'utf8', bom: false };
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { encoding: 'utf16le', bom: true };
    }
    const sampleLength = Math.min(buffer.length, 256);
    let nullByteCount = 0;
    for (let i = 0; i < sampleLength; i++) {
        if (buffer[i] === 0x00) nullByteCount++;
    }
    if (nullByteCount > sampleLength / 4) {
        return { encoding: 'utf16le', bom: false };
    }
    const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    return { encoding: 'utf8', bom: hasBom };
}

/**
 * Read file content, handling both open VS Code documents and disk files.
 * Returns the text with proper encoding detection.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {object} [vscode] - The vscode module (optional, for open document lookup)
 * @returns {Promise<{text: string, encoding: string, bom: boolean}|null>}
 */
async function readFileContent(filePath, vscode) {
    // Try open document first
    if (vscode) {
        const documents = vscode.workspace.textDocuments;
        const openDoc = documents && documents.find(doc => doc && doc.fileName === filePath);
        if (openDoc) {
            return { text: openDoc.getText(), encoding: 'document', bom: false };
        }
    }

    // Read from disk
    try {
        const buffer = await fs.promises.readFile(filePath);
        const { encoding, bom } = detectEncoding(buffer);
        return { text: decodeTextBuffer(buffer), encoding, bom };
    } catch {
        return null;
    }
}

/**
 * Write bumped content back to the file. If the document is open in VS Code,
 * apply an edit to the document instead of writing to disk, so VS Code's
 * dirty-state tracking and undo history work correctly.
 *
 * @param {string} filePath - Absolute file path
 * @param {string} originalText - The original text before bumping
 * @param {string} newText - The bumped text
 * @param {object} [vscode] - The vscode module (optional)
 * @param {string} [fileEncoding] - Encoding detected from the original file ('utf8' or 'utf16le')
 * @param {boolean} [fileBom] - Whether the original file had a BOM
 * @returns {Promise<boolean>} - true if write succeeded
 */
async function writeBumpedContent(filePath, originalText, newText, vscode, fileEncoding = 'utf8', fileBom = false) {
    if (originalText === newText) return false;

    if (vscode) {
        // Try to apply via VS Code workspace edit for open documents
        const documents = vscode.workspace.textDocuments;
        const openDoc = documents && documents.find(doc => doc && doc.fileName === filePath);

        if (openDoc) {
            const fullRange = new vscode.Range(
                openDoc.positionAt(0),
                openDoc.positionAt(openDoc.getText().length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(openDoc.uri, fullRange, newText);

            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                // Save the document so the file on disk has the bumped version
                const saved = await openDoc.save();
                return saved !== false;
            }
            // If applyEdit fails, fall through to disk write
        }
    }

    // Write directly to disk, preserving original encoding
    try {
        let data;
        if (fileEncoding === 'utf16le') {
            const encoded = Buffer.from(newText, 'utf16le');
            data = fileBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), encoded]) : encoded;
        } else {
            const encoded = Buffer.from(newText, 'utf8');
            data = fileBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
        }
        await fs.promises.writeFile(filePath, data);
        return true;
    } catch {
        return false;
    }
}

/**
 * Main entry point: bump version(s) in a file before compilation.
 *
 * Reads the file, bumps `#property version` and any configured version constants,
 * writes the changes back, and returns a summary.
 *
 * @param {object} options
 * @param {string} options.filePath - Absolute path to the MQL source file
 * @param {boolean} [options.bumpPropertyVersion=false] - Whether to bump #property version
 * @param {string[]} [options.versionConstantNames=[]] - Constant names to bump
 * @param {object} [options.vscode] - The vscode module
 * @param {object} [options.outputChannel] - VS Code output channel for logging
 * @returns {Promise<{bumped: boolean, propertyVersion: {old: string|null, new: string|null}, constants: Array}>}
 */
async function bumpVersionsInFile({ filePath, bumpPropertyVersion: doBumpProp = false, versionConstantNames = [], vscode: vscodeRef, outputChannel }) {
    const result = {
        bumped: false,
        propertyVersion: { old: null, new: null },
        constants: []
    };

    if (!doBumpProp && (!Array.isArray(versionConstantNames) || versionConstantNames.length === 0)) {
        return result;
    }

    const content = await readFileContent(filePath, vscodeRef);
    if (!content) return result;

    let currentText = content.text;
    const originalText = currentText;
    let anyChange = false;

    // 1. Bump #property version
    if (doBumpProp) {
        const propResult = bumpPropertyVersion(currentText);
        result.propertyVersion.old = propResult.oldVersion;
        result.propertyVersion.new = propResult.newVersion;
        if (propResult.newVersion && propResult.text !== currentText) {
            currentText = propResult.text;
            anyChange = true;
            if (outputChannel) {
                outputChannel.appendLine(`[Version] #property version: ${propResult.oldVersion} → ${propResult.newVersion}`);
            }
        }
    }

    // 2. Bump version constants
    if (Array.isArray(versionConstantNames) && versionConstantNames.length > 0) {
        const constResult = bumpVersionConstants(currentText, versionConstantNames);
        result.constants = constResult.bumps;
        if (constResult.text !== currentText) {
            currentText = constResult.text;
            anyChange = true;
            for (const b of constResult.bumps) {
                if (b.newVersion && outputChannel) {
                    outputChannel.appendLine(`[Version] ${b.name}: ${b.oldVersion} → ${b.newVersion}`);
                }
            }
        }
    }

    // 3. Write back if changed
    if (anyChange && currentText !== originalText) {
        const written = await writeBumpedContent(
            filePath, originalText, currentText, vscodeRef,
            content.encoding === 'document' ? 'utf8' : (content.encoding || 'utf8'),
            content.bom || false
        );
        result.bumped = written;
        if (!written && outputChannel) {
            outputChannel.appendLine(`[Version] Warning: failed to write bumped version to ${pathModule.basename(filePath)}`);
        }
    }

    return result;
}

module.exports = {
    bumpVersion,
    bumpPropertyVersion,
    bumpVersionConstants,
    bumpVersionsInFile,
    buildConstStringRegex
};
