# MQL Clangd

MQL Clangd is a Visual Studio Code extension that provides comprehensive MQL4/MQL5 development tooling for MetaTrader algorithmic trading. It powers IntelliSense, semantic analysis, and code completion via the clangd language server, compiles/checks MQL files through MetaEditor, provides lightweight live diagnostics without MetaEditor, and streams runtime logs directly into VS Code.

## Package Information

- **Package Name**: mql-clangd
- **Package Type**: npm (VS Code extension)
- **Publisher**: ngsoftware
- **Extension ID**: `ngsoftware.mql-tools`
- **Language**: JavaScript
- **Installation**: Install from VS Code Marketplace or `ext install ngsoftware.mql-clangd`
- **VS Code Requirement**: `^1.90.0`
- **Required Dependency**: `llvm-vs-code-extensions.vscode-clangd` (auto-installed)

## Core Imports

This is a VS Code extension — it is activated automatically when MQL files (`.mq4`, `.mq5`, `.mqh`) are opened. There is no programmatic import. All interaction occurs through VS Code commands, settings, and language features.

## Basic Setup

```jsonc
// .vscode/settings.json — minimum configuration
{
    "mql_tools.Metaeditor.Metaeditor5Dir": "C:\\MT5\\metaeditor64.exe",
    "mql_tools.Metaeditor.Include5Dir": "C:\\Users\\You\\AppData\\Roaming\\MetaQuotes\\Terminal\\<ID>\\MQL5"
}
```

Run `MQL: Create configuration` (`Ctrl+Alt+M`) once per workspace to initialize clangd with the correct include paths and generate `compile_commands.json`.

## Capabilities

### Commands

All user-facing actions exposed as VS Code commands in the Command Palette (`Ctrl+Shift+P`). Includes compile, check, configuration creation, help, icon installation, snippet insertion, and log management.

```text { .api }
Command IDs:
  mql_tools.checkFile           — Syntax check active file (Ctrl+Shift+Z)
  mql_tools.compileFile         — Compile active file (Ctrl+Shift+X)
  mql_tools.compileScript       — Compile and run as script (Ctrl+Shift+C)
  mql_tools.configurations      — Create/update clangd configuration (Ctrl+Alt+M)
  mql_tools.help                — Open online MQL documentation (Shift+F1)
  mql_tools.offlineHelp         — Open offline CHM documentation
  mql_tools.toggleTerminalLog   — Toggle live runtime log tailing
  mql_tools.installLiveLog      — Install LiveLog.mqh library
  mql_tools.switchLogMode       — Switch between LiveLog/Standard log mode
  mql_tools.selectCompileTarget — Select compile target(s) for active .mqh header
  mql_tools.resetCompileTarget  — Reset compile target for active .mqh header
  mql_tools.resetAllCompileTargets — Reset all compile target mappings
  mql_tools.Addicon             — Install MQL icons in icon theme
  mql_tools.openInME            — Open file in MetaEditor (Ctrl+Alt+O)
  mql_tools.openTradingTerminal — Open MetaTrader terminal (F4)
  mql_tools.commentary          — Generate function doc comment (Ctrl+Alt+C)
  mql_tools.InsMQH              — Insert #include for .mqh file (Ctrl+Alt+I)
  mql_tools.InsNameMQH          — Insert #include for .mqh (Explorer context menu, URI arg)
  mql_tools.InsResource         — Insert #resource directive
  mql_tools.InsImport           — Insert #import block for .dll/.ex5
  mql_tools.InsTime             — Insert current datetime literal
  mql_tools.InsIcon             — Insert #property icon directive
  mql_tools.InsMQL              — Insert compile target magic comment (editor picker)
  mql_tools.InsNameMQL          — Insert compile target magic comment (Explorer context menu)
  mql_tools.reportNoisyDiagnostic — Report noisy clangd diagnostic
  mql_tools.Showfiles           — Toggle show/hide .ex4/.ex5 compiled files
```

[Commands Reference](./commands.md)

### Configuration Settings

All settings are under the `mql_tools` namespace. Configure MetaEditor paths, terminal paths, Wine support (macOS/Linux), compile target storage, auto-check behavior, and lightweight diagnostics.

```jsonc { .api }
// Key settings
"mql_tools.Metaeditor.Metaeditor4Dir": string  // Path to metaeditor.exe (MQL4)
"mql_tools.Metaeditor.Metaeditor5Dir": string  // Path to metaeditor64.exe (MQL5)
"mql_tools.Metaeditor.Include4Dir": string     // MQL4 data folder path
"mql_tools.Metaeditor.Include5Dir": string     // MQL5 data folder path
"mql_tools.Wine.Enabled": boolean              // Enable Wine on macOS/Linux
"mql_tools.AutoCheck.Enabled": boolean         // Auto-check on typing
"mql_tools.CheckOnSave": boolean               // Check on save
"mql_tools.Diagnostics.Lightweight": boolean   // Live diagnostics without MetaEditor
```

[Configuration Reference](./configuration.md)

### Clangd Integration & Workspace Setup

The `MQL: Create configuration` command generates three workspace files:
- `compile_commands.json` — per-file compile commands with MQL include paths and defines
- `.clangd` — suppresses ~80 MQL-specific false-positive diagnostics; configures ClangTidy and InlayHints
- `.clang-format` — MQL-friendly formatting rules (prevents `#property` directive breakage)

Also updates `clangd.fallbackFlags` in `.vscode/settings.json` with MQL-specific compiler flags and disables the Microsoft C++ IntelliSense engine to prevent conflicts.

```javascript { .api }
// Flags injected into clangd.fallbackFlags
[
    "-xc++",
    "-std=c++17",
    "-D__MQL__",
    "-D__MQL5__",           // or -D__MQL4__ for MQL4 projects
    "-include<compat.h>",   // MQL compatibility header
    "-fms-extensions",
    "-fms-compatibility",
    "-ferror-limit=0",
    "-I<workspacePath>",
    "-I<workspacePath>/Include",
    "-I<externalIncludeDir>"  // from Include4Dir/Include5Dir setting
]
```

[Clangd Setup Guide](./clangd-setup.md)

### Smart Compile Targets for Header Files

When compiling `.mqh` header files, the extension automatically resolves which `.mq4`/`.mq5` file to compile by building a reverse include graph. Supports single/multiple target selection with persistent storage.

```javascript { .api }
// Storage options for compile target mappings
"mql_tools.CompileTarget.Storage": "workspaceState" | "globalState" | "workspaceSettings"
"mql_tools.CompileTarget.AllowMultiSelect": boolean  // Allow multiple targets
"mql_tools.CompileTarget.InferMaxFiles": number      // Max files to scan (default: 5000)
"mql_tools.CompileTarget.Map": object                // Manual mapping (workspaceSettings mode)

// Legacy fallback: magic comment in first line of .mqh file
//###<path/to/file.mq5>
```

[Compile Targets Reference](./compile-targets.md)

### Live Runtime Log

Streams MetaTrader terminal log output directly into VS Code with two modes:
- **LiveLog** (real-time): Tails `MQL5/Files/LiveLog.txt` written by the bundled `LiveLog.mqh` library
- **Standard Journal**: Tails `MQL5/Logs/YYYYMMDD.log` (MetaTrader buffered output)

```mql5 { .api }
// LiveLog.mqh — MQL5 logging API (after install via "MQL: Install LiveLog Library")
#include <LiveLog.mqh>

PrintLive(string message)                          // Real-time log output
PrintFormatLive(string format, ...)                // Formatted real-time log
LogDebugLive(string message)                       // Debug level
LogInfoLive(string message)                        // Info level
LogWarnLive(string message)                        // Warning level
LogErrorLive(string message)                       // Error level
LiveLogClose()                                     // Write "Session Ended" marker

// Optional: redirect all Print() calls automatically
#define LIVELOG_REDIRECT
#include <LiveLog.mqh>
```

[Live Log Reference](./live-log.md)

### Wine Support (macOS/Linux)

Run MetaEditor and MetaTrader on macOS/Linux via Wine. Paths are automatically converted between Unix and Windows formats.

```jsonc { .api }
"mql_tools.Wine.Enabled": true
"mql_tools.Wine.Binary": "wine64"           // or "wine" for Apple Silicon
"mql_tools.Wine.Prefix": ""                 // WINEPREFIX path (empty = ~/.wine)
"mql_tools.Wine.Timeout": 60000             // Compilation timeout in ms
```

[Wine Support Reference](./wine.md)

### Language Features

Automatically active for `.mq4`, `.mq5`, and `.mqh` files:
- **IntelliSense**: Code completion for all MQL built-in functions, constants, and document symbols
- **Hover documentation**: Full documentation for MQL functions, constants, error codes, and color swatches
- **Signature help**: Parameter hints on `(` and `,`
- **Document symbols**: Outline and Breadcrumbs navigation for functions, inputs, variables, classes
- **Color provider**: Visual color swatches for MQL color literals
- **Lightweight diagnostics**: Instant checks for semicolon errors, assignment-in-condition, unclosed strings, common typos — no MetaEditor required
- **Quick fixes**: MQL-aware code actions for undeclared variables, missing returns, wrong parameter counts, spelling corrections

[Language Features Reference](./language-features.md)
