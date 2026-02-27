# MQL Include Path Extractor

A utility module that extracts `#include` directive paths from MQL4/MQL5 source code text.

## Capabilities

### Extracts include paths from MQL source text

Given a string of MQL source code, returns an array of file paths found in `#include` directives. Both `#include <file.mqh>` (angle-bracket) and `#include "file.mqh"` (double-quote) styles are supported.

- Given source code containing `#include <Trade/Trade.mqh>` returns `["Trade/Trade.mqh"]` [@test](./tests/basic_include.test.js)
- Given source code with both `#include <A.mqh>` and `#include "B.mqh"`, returns `["A.mqh", "B.mqh"]` [@test](./tests/mixed_includes.test.js)
- Lines inside a block comment (`/* ... */`) are ignored and their `#include` directives are not extracted [@test](./tests/block_comment.test.js)
- Lines beginning with `//` are skipped and their `#include` directives are not extracted [@test](./tests/line_comment.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Parses #include statements from MQL source code.
 * Strips block comments before scanning. Skips single-line comment lines.
 * Handles both <angle-bracket> and "double-quote" include styles.
 *
 * @param {string} text - Raw MQL source code as a string
 * @returns {string[]} Array of included file paths (without quotes or angle brackets)
 */
function parseIncludes(text) {}

module.exports = { parseIncludes };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides the include-parsing logic used internally for building compile target dependency graphs.

[@satisfied-by](mql-clangd)
