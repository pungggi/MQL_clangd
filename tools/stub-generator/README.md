# MQL5 Stub Generator

Generates clangd-compatible C++ stub declarations from MQL5 Standard Library headers.

## Purpose

This tool parses MQL5 `.mqh` header files and extracts:
- Class declarations (with inheritance)
- Struct declarations
- Enum definitions
- Method signatures (including virtual, static, const)
- Member variables

It outputs minimal C++ stubs that allow clangd to provide accurate autocomplete and error checking for MQL5 code.

## Usage

```bash
# Basic usage - parse all headers in a directory
node index.js -i "C:/Program Files/MetaTrader 5/MQL5/Include" -o stubs.h

# Parse specific subdirectories
node index.js -i "./Include" -d "Trade,Controls,Arrays" -o stdlib_stubs.h

# Verbose output with dry run
node index.js -i "./Include" -d "Trade" -v --dry-run
```

## Options

| Option | Description |
|--------|-------------|
| `-i, --input` | Path to MQL5 Include directory (required) |
| `-o, --output` | Output file path (default: `generated_stubs.h`) |
| `-d, --dirs` | Specific subdirectories or patterns to parse (comma-separated, flexible matching) |
| `-f, --forward-only` | Generate forward declarations only (no class definitions) |
| `-m, --merge` | Merge with existing output file (add new, keep existing declarations) |
| `--force` | Overwrite existing file without prompting |
| `-v, --verbose` | Enable verbose output |
| `--dry-run` | Parse files but don't write output |
| `-h, --help` | Show help message |

## Examples

### Generate stubs for Trade library only

```bash
node index.js -i "C:/Users/You/AppData/Roaming/MetaQuotes/Terminal/XXX/MQL5/Include" \
              -d "Trade" \
              -o trade_stubs.h
```

### Generate comprehensive stubs

```bash
node index.js -i "/path/to/MQL5/Include" \
              -d "Trade,Controls,Arrays,Indicators,ChartObjects" \
              -o mql5_stdlib_stubs.h
```

### Preview what would be generated

```bash
node index.js -i "./Include" -d "Trade" -v --dry-run
```

## Output Format

The generated file includes:
- Header guard (`#pragma once`)
- `#ifdef __clang__` wrapper (only active for clangd)
- Forward declarations for all classes
- Enum definitions
- Class declarations with:
  - Public and protected members/methods
  - Proper inheritance hierarchy
  - Correct method signatures

## Integration

After generating stubs, you can:

1. **Include directly in your compatibility header:**
   ```cpp
   // In mql_clangd_compat.h
   #include "generated_stubs.h"
   ```

2. **Or copy relevant sections manually** into your existing compatibility header.

## Limitations

- Does not parse template classes (basic support only)
- Does not extract documentation comments
- May not handle all MQL5 syntax variations
- Private members are excluded by default

## Files

- `index.js` - CLI entry point
- `parser.js` - MQL5 source parser
- `generator.js` - C++ stub generator
- `test/` - Sample MQL5 headers for testing

