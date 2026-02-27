# Clangd Setup & Integration

MQL Clangd integrates the [clangd](https://clangd.llvm.org/) C/C++ language server with MQL5 and MQL4 files. Because MQL is syntactically similar to C++, clangd provides powerful IntelliSense when given the right configuration.

## How It Works

1. MQL files (`.mq4`, `.mq5`, `.mqh`) are registered as `cpp` language in VS Code
2. The `mql_tools.configurations` command generates clangd configuration files
3. Clangd reads these files to understand the MQL "compiler" environment
4. The bundled `mql_clangd_compat.h` provides stubs for MQL-specific types and intrinsics

## Initial Setup

Run `MQL: Create configuration` (`Ctrl+Alt+M`) once per workspace:

```javascript { .api }
// This command creates/updates:
// ├── compile_commands.json      — Per-file compile commands
// ├── .clangd                    — Suppressions + clangd config
// ├── .clang-format              — MQL-compatible formatter
// └── .vscode/settings.json      — clangd.fallbackFlags + engine disable
```

The command auto-detects MQL version (4 or 5) from workspace name.

---

## Generated Files

### `compile_commands.json` { .api }

Contains per-file compilation commands that clangd uses to understand each MQL file. Generated with:

```jsonc
// Format
[
  {
    "directory": "<workspacePath>",
    "command": "clang++ -xc++ -std=c++17 -D__MQL__ -D__MQL5__ -include<compat.h> -fms-extensions -fms-compatibility -ferror-limit=0 -I<workspacePath> -I<workspacePath>/Include -I<includePath> -w <file.mq5>",
    "file": "<absolute/path/to/file.mq5>"
  }
]
```

All `.mq4`, `.mq5`, and `.mqh` files in the workspace are included (but not `.ex4`/`.ex5` compiled files).

---

### `.clangd` { .api }

Suppresses approximately 80 MQL-specific false-positive diagnostics. Key suppressions include:

```yaml
# Example suppressions in .clangd
Diagnostics:
  Suppress:
    - "equality comparison result unused"
    - "declaration shadows"
    - "unused-variable"
    - "readability-identifier-naming"
    - "not a member of"
    # ... ~80 total suppressions for MQL idioms
CompileFlags:
  Add: ["-xc++", "-std=c++17", "-D__MQL__", "-D__MQL5__", ...]
InlayHints:
  Enabled: true
  ParameterNames: true
  DeducedTypes: true
```

When re-running `mql_tools.configurations`, custom suppressions can be preserved based on `mql_tools.Clangd.PreserveSuppressions`.

---

### `.clang-format` { .api }

MQL-compatible formatter settings. The critical setting prevents clang-format from breaking `#property` and `#include` directives:

```yaml
SortIncludes: false
IncludeBlocks: Preserve
```

---

### `.vscode/settings.json` Updates { .api }

The command adds/updates:

```jsonc
{
    // Disable Microsoft C++ IntelliSense engine (prevents conflict with clangd)
    "C_Cpp.intelliSenseEngine": "disabled",

    // Clangd compiler flags for files not in compile_commands.json
    "clangd.fallbackFlags": [
        "-xc++",
        "-std=c++17",
        "-D__MQL__",
        "-D__MQL5__",          // or "-D__MQL4__" for MQL4 workspaces
        "-include<path/to/mql_clangd_compat.h>",
        "-fms-extensions",
        "-fms-compatibility",
        "-ferror-limit=0",
        "-I<workspacePath>",
        "-I<workspacePath>/Include",
        "-I<externalIncludePath>"  // from Include5Dir/Include4Dir setting
    ]
}
```

---

## MQL Compatibility Header

The extension bundles `files/mql_clangd_compat.h` which provides:

- Stub definitions for MQL-specific built-in types (`color`, `datetime`, `string`)
- Macro definitions for MQL intrinsics that would otherwise cause clangd errors
- Type aliases making clangd accept MQL syntax

This header is automatically included via the `-include` flag in clangd configuration.

---

## Clangd Version Requirements

The extension requires the `vscode-clangd` extension to be installed:
- Extension ID: `llvm-vs-code-extensions.vscode-clangd`
- The extension will prompt to install it if missing

Use clangd 12+ for best results with MQL files. Install via the VS Code clangd extension's "Install Language Server" command.

---

## Refreshing Clangd Diagnostics

After compilation, clangd diagnostics are automatically refreshed to reflect the latest MetaEditor output:

1. Clangd is restarted via `clangd.restart` command
2. All open MQL documents are "touched" (empty edit) to trigger re-analysis
3. MetaEditor diagnostics from the last compilation are re-applied

This ensures the Problems panel shows diagnostics from both clangd (live) and MetaEditor (last compile).

---

## Troubleshooting

**clangd shows too many errors**: Re-run `MQL: Create configuration` to update suppressions. Check that `Include5Dir`/`Include4Dir` is set correctly.

**"Unknown type name" errors**: The compat header may be missing an MQL type. Use the "Add #ifdef __clang__ include" quick fix to add conditional includes.

**Inlay hints showing wrong types**: Verify clangd is using the correct workspace configuration and that `.clangd` is in the workspace root.

**clangd not starting**: Ensure `vscode-clangd` extension is installed and configured. Run `clangd: Restart language server` from Command Palette.
