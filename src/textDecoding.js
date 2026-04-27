'use strict';

// Decode buffer as UTF-16 LE (BOM or >25% null bytes in first 256) or UTF-8.
function decodeTextBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';

    const hasUtf16LeBom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
    if (hasUtf16LeBom) {
        return buffer.toString('utf16le', 2);
    }

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

    const utf8Text = buffer.toString('utf8');
    return utf8Text.charCodeAt(0) === 0xFEFF ? utf8Text.slice(1) : utf8Text;
}

module.exports = { decodeTextBuffer };
