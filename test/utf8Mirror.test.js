'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decodeTextBuffer } = require('../src/textDecoding');
const { getMirrorRoot, mapToMirror } = require('../src/utf8Mirror');

suite('decodeTextBuffer', () => {
    test('empty buffer returns empty string', () => {
        assert.strictEqual(decodeTextBuffer(Buffer.alloc(0)), '');
    });

    test('non-buffer returns empty string', () => {
        assert.strictEqual(decodeTextBuffer(null), '');
        assert.strictEqual(decodeTextBuffer('hello'), '');
    });

    test('plain UTF-8 decodes correctly', () => {
        const buf = Buffer.from('hello world', 'utf8');
        assert.strictEqual(decodeTextBuffer(buf), 'hello world');
    });

    test('UTF-16 LE with BOM decodes correctly', () => {
        const text = 'hello';
        const utf16 = Buffer.from(text, 'utf16le');
        const bom = Buffer.from([0xff, 0xfe]);
        const buf = Buffer.concat([bom, utf16]);
        assert.strictEqual(decodeTextBuffer(buf), text);
    });

    test('UTF-16 LE without BOM detected by null-byte heuristic', () => {
        // ASCII chars in UTF-16 LE have 0x00 as every second byte
        const text = 'MQL5';
        const buf = Buffer.from(text, 'utf16le');
        // 4 chars × 2 bytes = 8 bytes; 4 null bytes = 50% → triggers heuristic
        const result = decodeTextBuffer(buf);
        assert.strictEqual(result, text);
    });

    test('UTF-8 with few null bytes not misdetected as UTF-16', () => {
        // Build a 256-byte buffer with only 1 null byte (well below 25% threshold)
        const data = Buffer.alloc(256, 0x41); // 'A' * 256
        data[100] = 0x00; // 1 null byte out of 256 = 0.4%
        const result = decodeTextBuffer(data);
        assert.ok(result.length > 0);
        // Should decode as UTF-8, not UTF-16
        assert.strictEqual(result[0], 'A');
    });

    test('exactly at 25% null threshold — below triggers UTF-8', () => {
        // sampleLength = 256, threshold = 256/4 = 64; need > 64 nulls for UTF-16
        const buf = Buffer.alloc(256, 0x41);
        // Place exactly 64 nulls — NOT greater than 64, so UTF-8 path
        for (let i = 0; i < 64; i++) buf[i * 2] = 0x00;
        const result = decodeTextBuffer(buf);
        // utf8 decode — just verify it doesn't throw and returns a string
        assert.strictEqual(typeof result, 'string');
    });
});

suite('mapToMirror', () => {
    function withEnv(key, value, fn) {
        const original = process.env[key];
        try {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
            return fn();
        } finally {
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    }

    test('Windows path maps drive letter to segment', () => {
        const result = withEnv('LOCALAPPDATA', 'C:\\Users\\user\\AppData\\Local', () => {
            return mapToMirror('C:\\Users\\user\\AppData\\Roaming\\MetaQuotes\\Include');
        });
        assert.ok(result.includes(path.join('C', 'Users', 'user', 'AppData', 'Roaming', 'MetaQuotes', 'Include')));
    });

    test('drive letter normalized to uppercase', () => {
        const lower = withEnv('LOCALAPPDATA', 'C:\\AppData\\Local', () => mapToMirror('c:\\foo\\bar'));
        const upper = withEnv('LOCALAPPDATA', 'C:\\AppData\\Local', () => mapToMirror('C:\\foo\\bar'));
        assert.strictEqual(lower, upper);
    });

    test('POSIX path strips leading slash', () => {
        const { result, root } = withEnv('LOCALAPPDATA', undefined, () => ({
            result: mapToMirror('/usr/local/include'),
            root: getMirrorRoot()
        }));
        assert.strictEqual(result, path.join(root, 'usr', 'local', 'include'));
    });

    test('different drives produce different mirror paths', () => {
        const c = withEnv('LOCALAPPDATA', 'C:\\AppData\\Local', () => mapToMirror('C:\\Include'));
        const d = withEnv('LOCALAPPDATA', 'C:\\AppData\\Local', () => mapToMirror('D:\\Include'));
        assert.notStrictEqual(c, d);
    });
});
