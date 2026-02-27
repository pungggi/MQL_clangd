# MQL Function Name Spellchecker

A module that detects likely misspelled MQL API function names by finding close matches in a known-correct dictionary using bounded edit distance.

## Capabilities

### Computes bounded Levenshtein distance with early termination

Computes the edit distance between two strings but returns `Infinity` if the distance would exceed a given threshold `maxDist`. Uses a space-efficient single-row dynamic programming approach. Performs a quick length difference check first: if the lengths differ by more than `maxDist`, returns `Infinity` immediately without any DP computation.

- `levenshteinBounded("OrderSend", "OrderSend", 2)` returns `0` [@test](./tests/identical.test.js)
- `levenshteinBounded("ordersend", "OrderSend", 2)` returns `Infinity` (all 9 chars differ in case; exact edit distance is 9 which exceeds maxDist=2) [@test](./tests/case_sensitive.test.js)
- `levenshteinBounded("Ordersend", "OrderSend", 2)` returns `1` (one substitution) [@test](./tests/one_substitution.test.js)
- Strings whose lengths differ by more than `maxDist` return `Infinity` without full DP [@test](./tests/length_early_exit.test.js)

### Finds closest dictionary matches for a misspelled word

Given a misspelled word and a dictionary (array of correct names), returns up to `maxResults` matches within `maxDist` edit distance, sorted by ascending distance then alphabetically. Returns an empty array if the word is already in the dictionary or is shorter than 3 characters. Uses a two-strategy lookup: first checks words sharing the same first character, then falls back to adjacent-alphabet characters if no matches are found.

- `findClosestMatches("Ordersend", ["OrderSend", "OrderClose"], 2, 3)` returns `[{name: "OrderSend", distance: 1}]` [@test](./tests/find_matches.test.js)
- An exact-match word returns an empty array [@test](./tests/exact_match.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Bounded Levenshtein distance with early termination.
 * @param {string} a
 * @param {string} b
 * @param {number} maxDist - Return Infinity if actual distance exceeds this
 * @returns {number} Distance if <= maxDist, otherwise Infinity
 */
function levenshteinBounded(a, b, maxDist) {}

/**
 * Find closest matches in dictionary for a misspelled word.
 * @param {string} word - The potentially misspelled word
 * @param {string[]} dictionary - Array of correct function names
 * @param {number} [maxDist=2]
 * @param {number} [maxResults=3]
 * @returns {Array<{name: string, distance: number}>} Sorted by distance asc, then alphabetically
 */
function findClosestMatches(word, dictionary, maxDist, maxResults) {}

module.exports = { levenshteinBounded, findClosestMatches };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides MQL function name spellchecking that suggests correct function names when typos are detected in the editor.

[@satisfied-by](mql-clangd)
