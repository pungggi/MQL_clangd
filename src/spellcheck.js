'use strict';

const { obj_items } = require('./provider');

// =============================================================================
// SPELLCHECK INDEX - Lazy-loaded dictionary for typo detection
// =============================================================================

let spellcheckIndex = null;

/**
 * Build and cache the spellcheck index from obj_items
 * Filters to group=2 (functions) and indexes by first character for fast lookup
 * @returns {{ byFirstChar: Object<string, string[]>, all: Set<string> }}
 */
function getSpellcheckIndex() {
    if (spellcheckIndex) return spellcheckIndex;

    const byFirstChar = {};
    const all = new Set();

    for (const name in obj_items) {
        // Only include functions (group 2) with reasonable length
        if (obj_items[name].group === 2 && name.length >= 3) {
            all.add(name);
            const firstChar = name[0].toUpperCase();
            if (!byFirstChar[firstChar]) byFirstChar[firstChar] = [];
            byFirstChar[firstChar].push(name);
        }
    }

    spellcheckIndex = { byFirstChar, all };
    return spellcheckIndex;
}

/**
 * Bounded Levenshtein distance with early termination
 * @param {string} a - First string
 * @param {string} b - Second string
 * @param {number} maxDist - Maximum distance threshold
 * @returns {number} Distance if <= maxDist, otherwise Infinity
 */
function levenshteinBounded(a, b, maxDist) {
    const lenA = a.length, lenB = b.length;

    // Quick length check - if lengths differ by more than threshold, skip
    if (Math.abs(lenA - lenB) > maxDist) return Infinity;

    // Handle edge cases
    if (lenA === 0) return lenB <= maxDist ? lenB : Infinity;
    if (lenB === 0) return lenA <= maxDist ? lenA : Infinity;

    // Single row DP (space optimized O(min(m,n)))
    // Ensure we iterate over the shorter string for the inner loop
    const [shorter, longer] = lenA < lenB ? [a, b] : [b, a];
    const shortLen = shorter.length, longLen = longer.length;

    let row = Array.from({ length: shortLen + 1 }, (_, i) => i);

    for (let i = 1; i <= longLen; i++) {
        let prev = i;
        let minInRow = prev;

        for (let j = 1; j <= shortLen; j++) {
            const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
            const curr = Math.min(
                row[j] + 1,       // deletion
                prev + 1,         // insertion
                row[j - 1] + cost // substitution
            );
            row[j - 1] = prev;
            prev = curr;
            minInRow = Math.min(minInRow, curr);
        }
        row[shortLen] = prev;

        // Early exit: if minimum in this row > maxDist, we can't reach target
        if (minInRow > maxDist) return Infinity;
    }

    return row[shortLen] <= maxDist ? row[shortLen] : Infinity;
}

/**
 * Find closest matches for a misspelled word
 * @param {string} word - The misspelled word
 * @param {number} maxDist - Maximum edit distance (default: 2)
 * @param {number} maxResults - Maximum number of results (default: 3)
 * @returns {Array<{name: string, distance: number}>} Sorted by distance
 */
function findClosestMatches(word, maxDist = 2, maxResults = 3) {
    if (word.length < 3) return []; // Too short to reliably match

    const index = getSpellcheckIndex();
    const candidates = [];

    // First, check if it's already a valid function name
    if (index.all.has(word)) return [];

    // Strategy 1: Check words starting with same letter (most common typo pattern)
    const firstChar = word[0].toUpperCase();
    const primaryCandidates = index.byFirstChar[firstChar] || [];

    for (const name of primaryCandidates) {
        // Pre-filter by length difference
        if (Math.abs(name.length - word.length) > maxDist) continue;

        const dist = levenshteinBounded(word.toLowerCase(), name.toLowerCase(), maxDist);
        if (dist !== Infinity) {
            candidates.push({ name, distance: dist });
        }
    }

    // Strategy 2: If no matches found, check adjacent letters (handles first-char typos)
    if (candidates.length === 0 && word.length >= 4) {
        const firstCharCode = firstChar.charCodeAt(0);
        const adjacentChars = [
            String.fromCharCode(firstCharCode - 1),
            String.fromCharCode(firstCharCode + 1)
        ].filter(c => c >= 'A' && c <= 'Z');

        for (const altChar of adjacentChars) {
            const altCandidates = index.byFirstChar[altChar] || [];
            for (const name of altCandidates) {
                if (Math.abs(name.length - word.length) > maxDist) continue;
                const dist = levenshteinBounded(word.toLowerCase(), name.toLowerCase(), maxDist);
                if (dist !== Infinity) {
                    candidates.push({ name, distance: dist });
                }
            }
        }
    }

    // Sort by distance (prefer closer matches), then alphabetically
    candidates.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

    return candidates.slice(0, maxResults);
}

module.exports = { findClosestMatches };
