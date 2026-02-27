# MQL Reverse Include Graph

A utility module that builds a reverse dependency graph for MQL files and traverses it to find which main `.mq4`/`.mq5` files transitively depend on a given header file.

## Capabilities

### Builds a reverse include index

Given a list of `{ filePath, includes }` records (where `includes` is an array of resolved absolute paths that the file includes), builds a `Map<normalizedIncludedPath, Set<includingFilePath>>`. Keys are lowercase-normalized paths for case-insensitive matching.

- A file `A.mq5` that includes `B.mqh` produces an entry where the key is the normalized path of `B.mqh` and the value is a Set containing `A.mq5` [@test](./tests/build_index.test.js)
- Multiple files including the same header all appear in that header's Set [@test](./tests/multiple_includers.test.js)

### Finds candidate main files via graph traversal

Given the reverse index and the path of a header file, performs a BFS/DFS traversal to find all `.mq4`/`.mq5` files that transitively include the header (directly or through other `.mqh` intermediaries). Each node is visited at most once to handle cyclic includes.

- A chain `main.mq5 → middle.mqh → target.mqh` returns `["main.mq5"]` when querying for `target.mqh` [@test](./tests/transitive_dependency.test.js)
- A direct dependency `main.mq4 → target.mqh` returns `["main.mq4"]` [@test](./tests/direct_dependency.test.js)
- Cyclic includes (A.mqh includes B.mqh, B.mqh includes A.mqh) do not cause infinite loops [@test](./tests/cyclic_includes.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
const path = require('path');

/**
 * Builds a reverse include index from a list of file records.
 * @param {Array<{ filePath: string, includes: string[] }>} fileRecords
 * @returns {Map<string, Set<string>>} Map of normalized included path -> Set of including file paths
 */
function buildReverseIndex(fileRecords) {}

/**
 * Finds all .mq4/.mq5 main files that transitively include the given header.
 * @param {Map<string, Set<string>>} reverseIndex
 * @param {string} headerPath - Absolute path to the header file
 * @returns {string[]} Array of absolute paths to main files
 */
function findCandidateMains(reverseIndex, headerPath) {}

module.exports = { buildReverseIndex, findCandidateMains };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides the reverse include graph used to automatically determine which main MQL file to compile when editing a header file.

[@satisfied-by](mql-clangd)
