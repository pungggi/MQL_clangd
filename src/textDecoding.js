'use strict';

/**
 * Decode a Buffer to a string, auto-detecting UTF-16 LE (with or without BOM)
 * vs UTF-8.  MetaQuotes ships many MQL5 library headers as UTF-16 LE with BOM;
 * Node's default `readFile(path, 'utf8')` would return mojibake for those.
 *
 * Detection:
 *   - UTF-16 LE BOM (FF FE) → decode as utf16le, strip the BOM.
 *   - Otherwise, sample the first 256 bytes; if > 25% are 0x00, treat as
 *     UTF-16 LE without BOM.
 *   - Else, utf8.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';

    const hasUtf16LeBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
    if (hasUtf16LeBom) {
        return buffer.toString('utf16le', 2);
    }

    const utf8Text = buffer.toString('utf8');
    const sampleLength = Math.min(buffer.length, 256);
    let nullByteCount = 0;

    for (let i = 0; i < sampleLength; i++) {
        if (buffer[i] === 0x00) {
            nullByteCount++;
        }
    }

    if (nullByteCount > sampleLength / 4) {
        return buffer.toString('utf16le');
    }

    return utf8Text;
}

module.exports = { decodeTextBuffer };
