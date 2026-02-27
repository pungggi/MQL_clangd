# MQL Version Detector

A utility function that determines whether a given file or folder path belongs to the MQL4 or MQL5 ecosystem.

## Capabilities

### Detects MQL version from file extension and path

Returns `'mql4'`, `'mql5'`, or `null` based on examining file extension (higher priority) and folder path components. Defaults to `'mql5'` when a path or filename is provided but the version cannot be determined.

- A file named `MyExpert.mq4` returns `'mql4'` [@test](./tests/mq4_extension.test.js)
- A file named `Strategy.mq5` returns `'mql5'` [@test](./tests/mq5_extension.test.js)
- A folder path `/Users/trader/MQL4/Experts` with no filename returns `'mql4'` [@test](./tests/folder_path_mql4.test.js)
- A folder path `/Users/trader/Projects` with no filename returns `'mql5'` (default when path present but version unknown) [@test](./tests/folder_path_default.test.js)
- Both `folderPath` and `fileName` are `null`/`undefined` returns `null` [@test](./tests/no_info.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Detects the MQL version from a folder path and/or filename.
 * File extension takes priority over folder path.
 * Defaults to 'mql5' when path info is available but version cannot be determined.
 *
 * @param {string|null} folderPath - Optional folder path to check for MQL4/MQL5 markers
 * @param {string|null} fileName - Optional filename to check extension (.mq4 or .mq5)
 * @returns {'mql4' | 'mql5' | null}
 */
function detectMqlVersion(folderPath, fileName) {}

module.exports = { detectMqlVersion };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides MQL version detection used to select the correct MetaEditor and include paths during compilation.

[@satisfied-by](mql-clangd)
