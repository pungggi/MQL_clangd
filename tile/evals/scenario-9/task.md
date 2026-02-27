# Wine Batch File Command Builder

A utility module for safely building Windows `.bat` file content that executes programs via Wine's `cmd.exe`, working around Wine's argument re-escaping behavior.

## Capabilities

### Escapes an argument for safe use as a quoted batch file value

Wraps a value in double-quotes and escapes all batch metacharacters: `%` becomes `%%`, embedded `"` becomes `""`, `^` becomes `^^`, and the characters `&`, `|`, `<`, `>`, `(`, `)`, `@`, `!` are each prefixed with `^`. Throws an error if the value contains control characters (`\r`, `\n`, or null bytes).

- `escapeBatchArg("C:\\Program Files")` returns `"\"C:\\Program Files\""` (wrapped in quotes) [@test](./tests/escape_simple.test.js)
- `escapeBatchArg("path%with%percent")` returns `"\"path%%with%%percent\""` [@test](./tests/escape_percent.test.js)
- Calling `escapeBatchArg` with a value containing `\n` throws an Error [@test](./tests/escape_control_char.test.js)

### Escapes only batch metacharacters without adding quotes

For arguments that already contain their own quoting structure (e.g. `/compile:"Z:\\path\\file.mq5"`), escapes only `%` as `%%`. Other metacharacters are protected by the surrounding quotes within the argument. Also throws on control characters.

- `escapeBatchMeta('/compile:"Z:\\my%%dir\\file.mq5"')` returns `'/compile:"Z:\\my%%%%dir\\file.mq5"'` [@test](./tests/escape_meta_percent.test.js)

### Builds batch file content from executable path and arguments

Produces a Windows batch file string (with CRLF line endings) containing `@echo off` followed by the escaped executable command line. The executable is escaped with full quoting; arguments use only metacharacter escaping (they already contain their own quoting).

- `buildBatchContent("C:\\MetaEditor\\metaeditor.exe", ['/compile:"Z:\\file.mq5"'])` produces a string starting with `@echo off\r\n` [@test](./tests/build_content.test.js)
- The resulting batch content executes the correct command when arguments contain spaces in paths [@test](./tests/build_with_spaces.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
/**
 * Escape a string for safe use as a quoted batch file argument.
 * Wraps in double quotes and escapes %, ", ^, &, |, <, >, (, ), @, !
 * @param {string} value
 * @returns {string} Quoted and escaped string
 * @throws {Error} If value contains \r, \n, or null bytes
 */
function escapeBatchArg(value) {}

/**
 * Escape only batch metacharacters (% -> %%) without adding outer quotes.
 * Use for arguments that already have internal quoting structure.
 * @param {string} value
 * @returns {string}
 * @throws {Error} If value contains \r, \n, or null bytes
 */
function escapeBatchMeta(value) {}

/**
 * Build the content for a temporary .bat file.
 * @param {string} exeWinPath - Windows-style path to the executable
 * @param {string[]} args - Pre-formatted arguments with their own quoting
 * @returns {string} .bat file content with CRLF line endings
 * @throws {Error} If exeWinPath or any arg contains control characters
 */
function buildBatchContent(exeWinPath, args) {}

module.exports = { escapeBatchArg, escapeBatchMeta, buildBatchContent };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides Wine integration that enables MQL compilation on macOS and Linux by routing MetaEditor commands through Wine's cmd.exe via temporary batch files.

[@satisfied-by](mql-clangd)
