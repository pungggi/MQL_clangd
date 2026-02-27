# MQL Lightweight Diagnostics Analyzer

A static analysis module that detects common MQL coding errors in source text without requiring an external compiler.

## Capabilities

### Detects unnecessary semicolons after closing braces

Reports a hint-level diagnostic when a `}` is followed immediately by `;` on a non-struct/non-class/non-enum line. Semicolons after `struct`, `class`, or `enum` declarations are valid and must not be flagged.

- Source `void foo() {};` reports one unnecessary-semicolon diagnostic on that line [@test](./tests/unnecessary_semicolon.test.js)
- Source `struct Foo {};` reports zero diagnostics (struct closing brace is valid) [@test](./tests/struct_no_flag.test.js)

### Detects assignment in condition

Reports a warning when a single `=` (not `==`, `!=`, `<=`, `>=`) appears inside an `if(...)` or `while(...)` condition without an adjacent comparison operator. Intentional patterns like `if((x=expr)!=0)` must not be flagged.

- Source `if(x=5)` reports one assignment-in-condition diagnostic [@test](./tests/assignment_in_condition.test.js)
- Source `if((x=func())!=NULL)` reports zero diagnostics (comparison operator present) [@test](./tests/assignment_with_comparison.test.js)

### Detects unclosed string literals

Reports a warning when a line has an odd number of `"` characters (after accounting for escape sequences and excluding lines inside block comments or multi-line strings). Lines ending with `\` (line continuation) are exempt.

- Source `string s = "hello;` reports one unclosed-string diagnostic [@test](./tests/unclosed_string.test.js)
- Source `string s = "hello" + "world";` reports zero diagnostics (even quote count) [@test](./tests/balanced_strings.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Analyzes MQL source code and returns lightweight diagnostics.
 * Each diagnostic has: { line, message, severity, code }
 * severity: 'hint' | 'warning' | 'error'
 * code: 'unnecessary-semicolon' | 'assignment-in-condition' | 'unclosed-string'
 *
 * @param {string} text - MQL source code as a string
 * @returns {Array<{line: number, message: string, severity: string, code: string}>}
 */
function analyzeDocument(text) {}

module.exports = { analyzeDocument };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides real-time lightweight diagnostics for MQL files displayed in the VS Code Problems panel without needing MetaEditor.

[@satisfied-by](mql-clangd)
