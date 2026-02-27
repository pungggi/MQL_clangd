# Clangd Suppression Configuration Parser

A utility module that reads an existing `.clangd` YAML configuration file and extracts diagnostic suppression entries, enabling them to be preserved when the file is regenerated.

## Capabilities

### Parses suppression entries from a .clangd file

Reads a `.clangd` YAML file and extracts all items listed under `Diagnostics: > Suppress:`. Entries are returned as an array of strings. If the file does not exist, returns an empty array. Parsing stops when encountering the `ClangTidy:` key after `Suppress:`.

- A `.clangd` file with `Diagnostics:\n  Suppress:\n    - foo\n    - bar` returns `["foo", "bar"]` [@test](./tests/parse_suppressions.test.js)
- A `.clangd` file that does not exist returns an empty array without throwing [@test](./tests/file_not_found.test.js)
- Lines starting with `#` inside the Suppress block are treated as comments and excluded from results [@test](./tests/comment_lines.test.js)

### Merges suppressions without duplicates

Given a base list of extension-provided suppressions and an existing list of user-defined suppressions from a `.clangd` file, produces a merged list. Extension-provided suppressions come first, followed by user-defined suppressions not already present in the base list.

- `mergeSuppressions(["a", "b"], ["b", "c"])` returns `["a", "b", "c"]` (no duplicate "b") [@test](./tests/merge_no_dup.test.js)
- `mergeSuppressions(["a"], [])` returns `["a"]` [@test](./tests/merge_empty.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
const fs = require('fs');

/**
 * Parses an existing .clangd file and extracts diagnostic suppressions.
 * @param {string} clangdFilePath - Absolute path to the .clangd file
 * @returns {Promise<string[]>}
 */
async function parseClangdSuppressions(clangdFilePath) {}

/**
 * Merges extension-provided suppressions with user-defined ones, no duplicates.
 * @param {string[]} newSuppressions
 * @param {string[]} existingSuppressions
 * @returns {string[]}
 */
function mergeClangdSuppressions(newSuppressions, existingSuppressions) {}

module.exports = { parseClangdSuppressions, mergeClangdSuppressions };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides .clangd configuration management including the ability to preserve user-defined diagnostic suppressions when regenerating workspace configuration.

[@satisfied-by](mql-clangd)
