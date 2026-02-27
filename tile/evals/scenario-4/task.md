# MQL Clangd Compiler Flags Generator

A utility module that generates and merges the set of clangd compiler flags needed for MQL4/MQL5 IntelliSense in VS Code.

## Capabilities

### Generates base compiler flags for MQL

Returns an array of base compiler flags enabling clangd to process MQL code. Includes C++ version flag (`-xc++`, `-std=c++17`), preprocessor defines (`-D__MQL__`, `-D__MQL5__`), Microsoft extension flags (`-fms-extensions`, `-fms-compatibility`), and warning suppressions appropriate for MQL syntax. Optionally includes `-include` for a compatibility header, and `-I` flags for workspace and include paths.

- Base flags always include `-xc++`, `-std=c++17`, `-D__MQL__`, and `-D__MQL5__` [@test](./tests/base_flags.test.js)
- When a `compatHeaderPath` is provided, a `-include<path>` flag is inserted at position 4 in the flags array [@test](./tests/compat_header.test.js)

### Transforms flags for MQL4 vs MQL5 projects

For MQL4 projects, replaces the `-D__MQL5__` flag with `-D__MQL4__` and appends `-D__MQL4_BUILD__`. For MQL5, appends `-D__MQL5_BUILD__`. The original base flags array is not mutated.

- Generating MQL4 project flags from a base array containing `-D__MQL5__` replaces it with `-D__MQL4__` and appends `-D__MQL4_BUILD__` [@test](./tests/mql4_flags.test.js)
- Generating MQL5 project flags only appends `-D__MQL5_BUILD__` without replacing any existing flags [@test](./tests/mql5_flags.test.js)

### Merges flags without duplicates

Merges a new set of flags into an existing array, skipping duplicates and empty/non-string entries. The original array order is preserved with new unique flags appended.

- Merging `['-xc++']` into `['-xc++', '-std=c++17']` returns `['-xc++', '-std=c++17']` (no duplicate) [@test](./tests/merge_no_dup.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Generates base compiler flags for clangd MQL support.
 * @param {{ compatHeaderPath?: string, workspacePath?: string, includePath?: string }} [options]
 * @returns {string[]}
 */
function generateBaseFlags(options) {}

/**
 * Transforms base flags for a specific MQL project type.
 * @param {'mql4' | 'mql5'} projectType
 * @param {string[]} baseFlags
 * @returns {string[]}
 */
function generateProjectFlags(projectType, baseFlags) {}

/**
 * Merges newFlags into currentFlags, avoiding duplicates and empty strings.
 * @param {string[]} currentFlags
 * @param {string[]} newFlags
 * @returns {string[]}
 */
function mergeFlags(currentFlags, newFlags) {}

module.exports = { generateBaseFlags, generateProjectFlags, mergeFlags };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides compiler flag generation used to configure the clangd language server for correct MQL4/5 IntelliSense.

[@satisfied-by](mql-clangd)
