# Changelog

## 1.1.41

### Improvements
- **Better IntelliSense for MetaTrader standard libraries (#34)**: Code completion, Go to Definition, and error checking now work more reliably when your project uses MetaTrader's built-in include libraries such as `Generic/`, `Expert/`, and other Standard Library headers.
- **Fewer missing-symbol and false-error problems**: The extension now handles MetaTrader library files saved in different text encodings, so clangd can understand more of your project instead of silently skipping important headers.
- **Automatic setup, with an opt-out**: The improved library support is enabled automatically when you run `MQL: Create Configuration`. If it causes issues in a special setup, you can turn it off with `mql_tools.Clangd.UseUtf8Mirror`.

## 1.1.40

### Features
- **Quick Fix for Known Clangd False Positives**: When a clang diagnostic matches a known MQL false-positive suppression (e.g. `typecheck_decl_incomplete_type`), the **Quick Fix** menu now offers a one-click action to run **"MQL: Create Configuration"** — regenerating `.clangd` with all suppressions.

## 1.1.39

### Features
- **Hit Conditional Breakpoints**: Breakpoints can now specify a hit count condition (e.g. `> 5`, `% 3`, `== 10`) so they only fire after the Nth hit. Supports `=`, `>`, `>=`, `<`, `<=`, and `%` (modulo) operators.
- **Logpoints**: Breakpoints with a log message emit to the Debug Console without pausing the EA. Supports `{expression}` interpolation with type-aware formatting for `int`, `double`, `string`, `bool`, `datetime`, and `enum` types.
- **Clickable MQL Online Docs**: Hover tooltips now include a direct link to the MQL5 online documentation for built-in functions.
- **Descriptive Breakpoint Messages**: Adjusted and unverified breakpoints now show descriptive status messages in the VS Code UI.
- **Smarter Variable Detection**: The debugger now uses heuristics to prioritize which variables to watch at each breakpoint:
  - **Assignment-proximity scoring**: Variables assigned on or near the breakpoint line are ranked higher than distant declarations.
  - **Control-flow awareness**: Variables from enclosing `if`/`for`/`while`/`switch` conditions are automatically included.
  - **Function call arguments**: Variables passed as arguments to function calls near the breakpoint are detected.
  - **Auto-expand small structs**: Struct/class members (<=8 primitive fields) are expanded at default detail level without needing Deep Analysis.
- **Expression Watches** (`// @watch:type expr`): Watch arbitrary MQL expressions, not just variables. The expression is evaluated at the breakpoint and its value shown in the Variables panel. Function calls are validated against a built-in allowlist of read-only MQL functions. Use `// @watch!:type expr` to bypass safety checks for advanced use cases.
- **Variable Timeline**: Expand any variable in the Variables panel to see its value history across multiple hits of the same breakpoint.
- **Batch I/O**: Debug probes now batch all writes into a single `FileWriteString+FileFlush` per breakpoint hit, reducing file I/O by up to 10x for breakpoints with many watches.
- **CodeLens Watch Suggestions**: Breakpoint lines without a `@watch` annotation show a clickable "Add @watch" CodeLens for quick annotation insertion.

### Bug Fixes
- **Mid-session logpoints**: Logpoints added after compilation now work without recompiling — every probe checks the logpoint flag at runtime.
- **Operator precedence in breakpoint metadata**: Fixed fragile `&&`/`||` precedence when extracting `hitCondition` and `logMessage` from DAP requests.

## 1.1.38

### Features (GA)
The following features, introduced as pre-release in 1.1.32, are now generally available:

- **MQL Debugger** (`Ctrl+Alt+D`): Set breakpoints in VS Code, then debug live MQL EAs/Scripts without leaving the editor. Auto-instruments source files, compiles a debug build, and streams variable state to a live dashboard.
  - Auto-watches locals, parameters, and class members; `// @watch` annotations for manual additions; conditional breakpoints; call stack tracking; 120 s auto-resume safety.
  - Breakpoint probes reload from config every ~200 ms — no recompile needed when breakpoints change.
  - EA auto-attaches to the first chart when the source is inside `MQL5\Experts\`.
  - Settings: `mql_tools.Debug.DetailLevel` (`default` | `deepAnalysis`), `mql_tools.Debug.CloseTerminalOnExit`.
- **Trade Report Dashboard**: Interactive webview for MT5 Strategy Tester results — trade summary, P&L, trade table, and filterable log viewer. Click-to-source navigation via LiveLog tags.
- **Run Backtest** (`Ctrl+Alt+T`): Trigger MT5 Strategy Tester from VS Code, monitor progress, and auto-open the Trade Report on completion.
  - Settings: `mql_tools.Backtest.ServerPort`, `AutoStartServer`, `PromptForParameters`, `AutoOpenReport`, `mql_tools.ShowButton.RunBacktest`.
- **LiveLog — Source Location Tags**: `LogDebug/Info/Warn/Error/Trade` macros embed `{File:Function:Line}` tags for click-to-source in the Trade Report.
- **Welcome Page**: Opens on first launch of each version with feature guides. Re-open via `MQL: Open Welcome Page`.

### Bug Fixes
- **Log parser**: Fixed missing `wallclock` field in parsed log lines.
- **Debug instrumentation**: Fixed inverted brace-depth condition in backward scope scan for local variable detection.


## 1.1.37

### Features
- **Per-header `-include` injection for Go to Definition in `.mqh` files (#28)**: Emit `compile_commands.json` entries for `.mqh` header files with `-include` flags for preceding sibling headers, preserving MQL's concatenation order. This gives clangd the same symbol visibility as the MQL compiler, fixing Go to Definition and autocomplete across headers that depend on symbols from earlier includes.
- **Auto-regenerate `compile_commands.json`**: Automatically regenerates the compilation database when `#include` directives change in `.mq4`, `.mq5`, or `.mqh` files on save, or when `.mqh` files are created/deleted.

## 1.1.36

### Bug Fixes
- **Fix 393 compilation errors in MQL5 stdlib stubs header**: Added Win32 type preamble (PVOID, HANDLE, FILETIME, etc.), converted base class forward declarations to minimal class definitions, and removed duplicate struct definitions that caused redefinition errors under clang. Both MQL4 and MQL5 modes now compile with zero errors.

## 1.1.35

### Bug Fixes
- **Go to Definition for MQL4 indicators and Expert Advisors (#28)**: Added ~80 MQL4-specific function stubs to the compatibility header, guarded by `#ifdef __MQL4__`. This resolves clangd failing to compile every `.mq4` file due to missing declarations for MQL4 built-in functions. Includes:
  - **Indicator setup**: `SetIndexStyle`, `SetIndexLabel`, `SetIndexDrawBegin`, `SetIndexShift`, `SetIndexEmptyValue`, `IndicatorBuffers`, `IndicatorCounted`, `IndicatorShortName`, `IndicatorDigits`, `SetLevelValue`, `SetLevelStyle`
  - **Technical indicators**: All MQL4 indicator functions returning `double` with `shift` parameter (`iMA`, `iRSI`, `iMACD`, `iStochastic`, `iBands`, `iATR`, `iCCI`, `iADX`, and 20 more), plus 7 `OnArray` variants
  - **Predefined variables**: `Ask`, `Bid`, `Open[]`, `Close[]`, `High[]`, `Low[]`, `Volume[]`, `Time[]`
  - **State-checking**: `IsTradeAllowed`, `IsTesting`, `IsOptimization`, `IsVisualMode`, `IsConnected`, `IsDemo`, and more
  - **Conversion aliases**: `TimeToStr`, `StrToTime`, `DoubleToStr`, `StringGetChar`, `StringSetChar`
  - **Utilities**: `PlaySound`, `MessageBox`, `HideTestIndicators`
- **`.clangd` migration**: Existing workspaces automatically have the duplicate `-c` flag removed from `.clangd` CompileFlags on extension update.

## 1.1.33

### Bug Fixes
- **Go to Definition for MQL4 in generic workspaces**: Fixed "Go to Definition" (F12) and include resolution failing for MQL4 projects opened from generically-named workspace folders. The extension now detects the workspace's dominant MQL version by counting actual `.mq4` vs `.mq5` files instead of relying on the folder name. This ensures correct `-D__MQL4__`/`-D__MQL5__` defines, proper include paths, and working symbol navigation regardless of workspace naming (fixes #28).
- **Mixed-workspace include paths**: Files whose extension mismatches the workspace's dominant version (e.g. a `.mq5` file in an MQL4-dominant workspace) now get the correct external include directory and defines in `compile_commands.json`.
- **Stale fallback flags**: Changing `Metaeditor.Include4Dir`/`Include5Dir` settings or the workspace's MQL version no longer leaves stale defines and include paths in `clangd.fallbackFlags`.

## 1.1.32 (pre-release)

### Features
- **MQL Debugger** (`Ctrl+Alt+D`): Set breakpoints in VS Code, then debug live MQL EAs/Scripts without leaving the editor. Auto-instruments source files, compiles a debug build, and streams variable state to a live dashboard. → [Full guide](media/tabs/tab-debugger.html)
  - Auto-watches locals, parameters, and class members; `// @watch` annotations for manual additions; conditional breakpoints; call stack tracking; 120 s auto-resume safety.
  - Breakpoint probes reload from config every ~200 ms — no recompile needed when breakpoints change.
  - EA auto-attaches to the first chart when the source is inside `MQL5\Experts\`.
  - New settings: `mql_tools.Debug.DetailLevel` (`default` | `deepAnalysis`), `mql_tools.Debug.CloseTerminalOnExit` (default: `true`).
- **Trade Report Dashboard**: Interactive webview for MT5 Strategy Tester results — trade summary, P&L, trade table, and filterable log viewer. Click-to-source navigation via LiveLog tags; source snapshots keep links accurate after edits. → [Full guide](media/tabs/tab-tradereport.html)
- **Run Backtest** (`Ctrl+Alt+T`): Trigger MT5 Strategy Tester from VS Code, monitor progress, and auto-open the Trade Report on completion. → [Full guide](media/tabs/tab-backtest.html)
  - New settings: `mql_tools.Backtest.ServerPort`, `AutoStartServer`, `PromptForParameters`, `AutoOpenReport`, `mql_tools.ShowButton.RunBacktest`.
- **LiveLog — Source Location Tags**: `LogDebug/Info/Warn/Error/Trade` macros now embed `{File:Function:Line}` tags for click-to-source in the Trade Report. → [Full guide](media/tabs/tab-livelog.html)
- **Welcome Page**: Opens on first launch of each version with feature guides. Re-open via `MQL: Open Welcome Page`.

### Snippets
- Added `LogInfo`, `LogDebug`, `LogWarn`, `LogError`, `LogTrade` snippets.

### Improvements
- **Standard Library Stubs**: Regenerated with improved stub generator (better template handling, forward-declaration skipping, manual extras block).
- **Compatibility Header**: Extended `mql_clangd_compat.h` with additional MQL built-in types and macros.

## 1.1.31

### Features
- **Compile & Open Terminal**: New command `MQL: Compile and Open Terminal` compiles the current MQL file and automatically launches the MetaTrader terminal on successful compilation. A dedicated toolbar button (configurable via `mql_tools.ShowButtonCompileAndOpenTerminal`) appears alongside the existing compile button.
- **Version Label in Compilation Output**: The `#property version` value is now extracted from the compiled file and displayed in compilation success messages and the progress notification title. Supports both UTF-8 and UTF-16 LE encoded files.

## 1.1.27

### Bug Fixes
- **Wine: MQL5 include files not found on Linux**: Fixed two issues that prevented `#include` headers from being located when compiling MQL5 files via MetaEditor under Wine on Arch Linux (and other Linux setups):
  - `fromWineWindowsPath` now resolves the `dosdevices/z:` symlink to its canonical Linux target (typically `/`) so diagnostics reference real file paths instead of the `~/.wine/dosdevices/z:/…` symlink path. Results are cached per drive letter to avoid repeated `realpathSync` calls during log parsing.
  - When `mql_tools.Metaeditor.Include5Dir` (or `Include4Dir`) is not configured and Wine is enabled, the extension now automatically infers the MQL data folder by walking up the directory tree from the compiled file, looking for an `MQL5`/`MQL4` directory that contains an `Include/` or `Logs/` subdirectory. The inferred path is passed to MetaEditor as `/inc:`, allowing it to locate user-defined headers without requiring manual configuration.

## 1.1.26

### Bug Fixes
- **Background checks and special literal formatting**: Fixed automatic syntax checks stealing editor focus while typing by avoiding Problems-panel focus during background runs, preserved `B'...'` binary literals during formatting normalization, and made `D'...'` literal spacing normalization consistent for both date-only and date-time forms.

## 1.1.25

### Bug Fixes
- **Wine compiler output paths on Linux**: Fixed compiler diagnostics and output links under Wine by converting Windows-style paths (`C:\...`) from MetaEditor output into host Linux paths using the configured Wine prefix. VS Code file links now open the correct source files again (fixes #17).
- **`.mqh` headers in `compile_commands.json`**: Fixed clangd errors for header files by generating direct compile commands only for real translation units (`.mq4`/`.mq5`), avoiding the "expected exactly one compiler job" error when opening `.mqh` files (fixes #18).


## 1.1.24

### Features
- **Clangd Properties Generator**: New module for generating `.clangd` configuration properties and compiler flags for MQL projects, improving clangd setup automation.

### Improvements
- **Lightweight Diagnostics**: Major rewrite of the lightweight diagnostics engine with better detection of unnecessary semicolons, assignments in conditions, and unclosed strings.

## 1.1.23

### Bug Fixes
- **Wine Compilation**: Fixed a critical bug where arguments with spaces (like `/compile:"Path with spaces"`) were being double-quoted in the generated batch file, causing `cmd.exe` to fail parsing.
  - Implemented smarter argument escaping that preserves existing quotes while securing batch metacharacters.
  - Added safeguards around batch file creation to prevent UI hangs if the filesystem operation fails.
  
## 1.1.21/22

### Bug Fixes
- **Windows Compilation with Spaces in Paths**: Fixed compilation failure when file or folder paths contain spaces (e.g., `RB v20.mq5`). `spawn()` with `shell: false` was re-escaping the quotes added by `buildMetaEditorCmd()`, causing MetaEditor to receive malformed `/compile:\"...\"` arguments. Now uses `windowsVerbatimArguments: true` to pass arguments verbatim without Node.js re-escaping (fixes #6).

## 1.1.20 (pre-release)

### Removals
- **Project Context**: Removed the "Project Context" feature and its associated commands/settings to streamline the extension.

## 1.1.18

### Features
- **LiveLog Enhancements**:
  - `PrintLive()` now accepts up to 12 string arguments (was 8)
  - New `LIVELOG_REDIRECT` macro: Add `#define LIVELOG_REDIRECT` before `#include <LiveLog.mqh>` to automatically redirect all `Print()` and `PrintFormat()` calls to `PrintLive()` and `PrintFormatLive()`
  - LiveLog.txt is cleared when starting a new tail session for a fresh start
- **Standard Library Stubs**: Added MQL5 Standard Library stubs and a generator tool for improved clangd support.


## 1.1.14

### Improvements
- **clangd Auto-Restart**: The `MQL: Create configuration` command now automatically restarts clangd after generating configuration files, so the new settings take effect immediately.
- **Stubs Quality**: Removed enum generation from stdlib stubs to avoid conflicts with real MQL5 headers. Enums are now provided by `mql_clangd_compat.h` (built-in enums) and real MQL5 headers (stdlib enums). This eliminates false positive "redefinition of enumerator" and "scoped mismatch" errors.
- **Stub Generator**: Added `--skip-enums` flag to skip enum generation entirely
- **Alglib False Positives**: Added default suppressions for `member_def_does_not_match_ret_type`, `member_decl_does_not_match`, `ovl_no_oper`, and `typecheck_assign_const` diagnostics. These are false positives from stub mismatches and MQL's const semantics differing from C++.

### Bug Fixes
- **Project Context**: Fixed race condition in parallel processing that caused incomplete symbol extraction (missing defines/enums/classes)

## 1.1.0 (pre-release)
### Features
- **MQL Project Context & AI Bridge**: New command `MQL: Activate Project Context` generates an AI-friendly context file at project root
  - **TOML format** (default): Optimized for AI context engines (uses `smol-toml`)
  - **Markdown format**: Human-readable with Mermaid dependency diagrams
  - Extracts symbol tables: `#define`, `enum`, `class/struct`, function signatures, and `#include` dependencies
  - Includes curated summary of high-frequency MQL standard library functions
  - Auto-updates on file changes with debounced file watcher (default 12s delay, configurable)
  - Token counting with `js-tiktoken` (configurable warning threshold)
  - Concurrency-limited parallel file I/O for reduced system load
  - Persists activation state across VS Code sessions
  - New configuration settings: `ProjectContext.FileName`, `ProjectContext.Format`, `ProjectContext.EnableAutoUpdate`, `ProjectContext.AutoUpdateDelay`, `ProjectContext.ScanMode`, `ProjectContext.IncludeStdLib`, `ProjectContext.ExcludePatterns`, `ProjectContext.MaxTokens`

## 1.0.18

### Features
- **Live Runtime Log**:
  - New command `MQL: Toggle Live Runtime Log` to start/stop log monitoring
  - Status bar indicator showing tailing state with toggle functionality
  - Displays logs in dedicated output channel with real-time updates
  - Configuration via `mql_tools.Metaeditor.Include4Dir` and `mql_tools.Metaeditor.Include5Dir` settings

### Improvements
- **Reduced hover verbosity**:
  - Documentation tooltips now strip redundant return type prefixes (e.g., `(int)`) when providing descriptions for standard MQL functions.
  - Added `Hover: ShowAKA: No` to the generated `.clangd` configuration to suppress verbose type alias information in tooltips.
  - Improved regex for return type stripping to be more robust across different MQL data types.
- **Enhanced configuration descriptions**: Updated `Include4Dir` and `Include5Dir` settings to use markdown descriptions highlighting their importance for the Live Runtime Log feature

## 1.0.17

### Bug Fixes
- **Fixed compilation not working on Windows**: MetaEditor was not executing due to incorrect argument quoting
  - Removed quotes from spawn arguments when using `shell: false` - Node.js handles escaping automatically
  - Fixed log file name mismatch: extension now looks for `SMC.log` instead of `SMC.mq5.log` (MetaEditor creates logs without source extension)
- **Fixed "File must be in a workspace folder" error**: `.mq4/.mq5` files can now be compiled even when not in a workspace folder (`.mqh` files still require workspace for compile target resolution)

### Improvements
- **Focus Problems panel on errors**: After compilation, the Problems panel is automatically focused if there are errors; otherwise the Output panel stays focused

## 1.0.16

### Bug Fixes
- **Fixed file staying dirty after CheckOnSave**: Files no longer remain in a dirty (unsaved) state after the CheckOnSave feature runs
  - The `refreshClangdDiagnostics()` function was doing synthetic edits to trigger clangd re-analysis, which left documents marked as modified
  - Now saves documents after the synthetic edit cycle to clear the dirty state
  - Uses `internalSaveDepth` guard to prevent re-triggering CheckOnSave during the cleanup save

## 1.0.15

### Features
- **Wine support for macOS/Linux**: Run MetaEditor on macOS and Linux through Wine compatibility layer
  - New `mql_tools.Wine.Enabled` setting to enable Wine wrapper (default: `false`)
  - New `mql_tools.Wine.Binary` setting to configure Wine binary path (default: `wine64`)
  - Automatic path conversion using `winepath` for compilation and file opening
  - Works seamlessly with existing MetaEditor configuration
  - Localized configuration descriptions in 14 languages

### Bug Fixes
- **Fixed "Create configuration" command error (Issue #21)**: The `MQL: Create configuration` command no longer fails when optional extensions (like Microsoft C/C++) are not installed
  - Fixed logic error in `safeConfigUpdate` that caused it to call `config.update()` for unregistered settings when `silent=true`
  - The function now correctly returns early for unregistered settings regardless of silent mode

## 1.0.14

### Diagnostics
- **Fixed diagnostics regression from PR #19**: Problems panel now correctly displays MetaEditor diagnostics for all compilation modes (Check, Compile, Script), not just Check mode
  - `diagnosticCollection.clear()` now runs for every compilation mode to ensure Problems reflects the latest run
  - `diagnosticCollection.set()` now publishes diagnostics for all `rt` values (0, 1, 2)
  - Prevents stale or missing problems after compilation

### Features
- **Check on Save**: New `mql_tools.CheckOnSave` setting (default: `true`) automatically runs syntax check when MQL files are saved
  - Provides instant feedback without manual compilation
  - Respects AutoCheck settings to avoid conflicts
  - Works for `.mq4`, `.mq5`, and `.mqh` files

### Bug Fixes
- **AutoCheck trigger prevention**: Synthetic edits from `refreshClangdDiagnostics()` no longer trigger AutoCheck by pre-marking document versions

## 1.0.13 (pre-release)

### Diagnostics
- **Enhanced clangd false-positive suppression**: Added 25 new diagnostic suppressions for complex MQL5 code:
  - `unsupported_bom` - UTF-16 LE encoded files
  - `character_too_large` - Unicode character literals in macros
  - `ovl_deleted_special_init` - Hidden constructors in subclasses
  - `error_subscript_overload` - Default values in subscript operators
  - `expected_fn_body` - Export modifier before function bodies
  - `function_marked_override_not_overriding` - MQL override keyword semantics
  - `mem_init_not_member_or_class` - Constructor initialization list differences
  - `typename_nested_not_found` - Nested typename resolution differences
  - `typecheck_invalid_lvalue_addrof` - Taking address of rvalues (MQL allows this in certain contexts)
  - `bad_parameter_name_template_id` - Parameter names with template-like syntax
  - `new_incomplete_or_sizeless_type` - Allocation of incomplete/forward-declared types
  - `ref_non_value` - Template parameters used as values (MQL template semantics differ)
  - `no_template_suggest` - Template name suggestions (MQL has different template rules)
  - `unexpected_typedef` - Type names in expression contexts (MQL syntax differences)
  - `invalid_non_static_member_use` - Non-static member usage (MQL member access rules differ)
  - `uninitialized_member_in_ctor` - Const member initialization in constructors (MQL initialization rules differ)
  - `unknown_type_or_class_name_suggest` - Unknown class name suggestions (MQL forward declarations)
  - `access_dtor` - Protected destructor access (MQL allows this in certain contexts)
  - `allocation_of_abstract_type` - Abstract class instantiation (MQL allows this in certain contexts)
  - `incomplete_base_class` - Incomplete base class types (MQL inheritance patterns)
  - `sizeof_alignof_incomplete_or_sizeless_type` - sizeof/alignof on incomplete types (MQL array handling)
  - `increment_decrement_enum` - Increment/decrement operations on enums (MQL allows this)
  - `unexpected_unqualified_id` - Type-id naming (MQL syntax differences)
  - `typename_requires_specqual` - Type specifier requirements (MQL type system differences)
  - `ovl_no_viable_subscript` - Subscript operator overload resolution (MQL overload rules differ)
- **Added `export` keyword macro**: MQL's `export` modifier is now properly handled in the compatibility header
- **Improved documentation**: Added comprehensive FAQ section in README covering:
  - How to customize clang-format for MQL code
  - Explanation of diagnostic suppression risks and benefits
  - Step-by-step guide for adding custom suppressions

### Configuration
- **Relative Paths & Variable Substitution**: Settings like `MetaEditor*Dir` and `Include*Dir` now support `${workspaceFolder}` variable substitution and relative paths (e.g., `${workspaceFolder}/../MetaEditor64.exe`). This is especially useful for portable MetaTrader installations.

### Compilation
- **Compile Target Resolver**: New feature for `.mqh` header files - automatically infers which `.mq4/.mq5` main files to compile without hardcoding filenames in headers
  - **Auto-inference**: Builds reverse include graph to find candidate main files
  - **Smart selection**: Auto-compiles when exactly 1 main includes the header; shows picker for multiple targets
  - **Persistent mappings**: Remembers user's compile target choices across sessions
  - **Multi-target support**: Compile multiple main files from a single header
  - **Configurable storage**: Choose between workspace-local, global, or shared settings
  - **Backward compatible**: Existing magic comment syntax (`//###<path>`) still works
- **New Commands**:
  - `MQL: Select Compile Target(s) for Header` - Manually choose compile targets for `.mqh` files
  - `MQL: Reset Compile Target for Current Header` - Clear mapping for current header
  - `MQL: Reset All Compile Target Mappings` - Clear all stored mappings
- **Configuration**:
  - `mql_tools.CompileTarget.Storage` - Where to store mappings (workspaceState/globalState/workspaceSettings)
  - `mql_tools.CompileTarget.AllowMultiSelect` - Enable selecting multiple compile targets
  - `mql_tools.CompileTarget.InferMaxFiles` - Safety limit for file scanning during inference
  - `mql_tools.CompileTarget.Map` - Manual mapping object (for workspaceSettings mode)


## 1.0.12

### Compatibility Header
- **Expanded Standard Library stubs**: Added comprehensive stub declarations for Trade, Controls, and Arrays libraries (54 classes, 1100+ methods)
- **Stub Generator Tool**: New `tools/stub-generator` Node.js tool to auto-generate stubs from MQL5 Standard Library headers
- Added `ENUM_FILE_POSITION` enum and fixed `FileSeek` signature

### Diagnostics
- **Extended clangd suppressions**: Added 20+ suppressions for MQL5 Math/Alglib/Fuzzy/Stat libraries (complex types, overloads, incomplete types, constructors)
- **Fixed false positive**: `assignment-in-condition` warning no longer triggers for `=` inside string literals (e.g., `"X=NaN"`)

## 1.0.11

### IntelliSense
- **Document Symbol Provider**: Outline view, breadcrumbs, and Go to Symbol (`Ctrl+Shift+O`) for MQL files. Shows `#property`, `#include`, `#define`, `input/sinput`, enums, classes, structs, and functions.
- **Enhanced Completion**: Include path completion (`#include <...>`), document-aware completion for local symbols (inputs, variables, functions, defines, classes).
- **Improved Hover**: Shows documentation for local symbols (inputs, defines, functions). Compact parameter display. Color preview for color constants.

### Diagnostics
- **Lightweight Diagnostics**: Instant syntax feedback without MetaEditor. Detects assignment in condition (`=` vs `==`), unclosed strings, common MQL typos (`Ordersend` → `OrderSend`). Setting: `mql_tools.Diagnostics.Lightweight` (default: enabled).

## 1.0.10

### Configuration
- **Portable Mode Support**: Added `Portable4` and `Portable5` settings to enable MetaTrader's `/portable` switch for compilation and opening files in MetaEditor. This is useful for portable MetaTrader installations that store data in the terminal folder instead of AppData.

## 1.0.9

### QuickFixes
- **Spelling Suggestions**: Detects misspelled MQL function names and offers "Did you mean 'X'?" fixes.
- **Open Documentation**: Error 199 (wrong parameters count) - opens MQL5 docs for the function.
- **Declare Variable**: Error 256 (undeclared identifier) - offers to declare as input parameter or local variable.
- **Add Return Statement**: Errors 117/121 (missing return) - inserts appropriate return statement.
- **Entry Point Skeletons**: Errors 209/356 (missing entry point) - inserts OnCalculate/OnTick/OnStart templates.
- **Enum Suggestions**: Error 262 (cannot convert to enum) - suggests common enum values for indicator/trading functions.
- **Include Fix**: clangd "unknown type name" - adds `#ifdef __clang__` include directive.

### IntelliSense
- Suppress `this.` member access diagnostics - MQL allows `this.member` syntax without pointer semantics.
- Added function overloads for MQL4 legacy trading functions, series Copy functions, and Object/Chart getter functions.
- Added missing MQL5 constants and functions - extended `ENUM_DEAL_REASON` values, Database/SQLite API, and Economic Calendar API.

### Snippets
- Added 20+ MQL5 code snippets for common patterns:
  - Event handlers: `OnInit`, `OnDeinit`, `OnTick`, `OnStart`, `OnCalculate`, `OnTimer`, `OnChartEvent`, `OnTrade`, `OnTradeTransaction`
  - Trading: `OrderSend` with `MqlTradeRequest`, indicator handle creation
  - Data: `CopyRates`/`CopyBuffer` with error handling
  - Declarations: input parameters, properties, classes, enums, comments

### Configuration
- **Improved clangd config**: Better organized suppressions by category with explanatory comments.
- **Diagnostics**: Clickable error codes in Problems panel now link to MQL5 documentation.
- **Localization**: Added translations for all VS Code supported languages (zh-cn, zh-tw, fr, de, it, es, ja, ko, pt-br, tr, pl, cs, hu).

### Bugfixes
- Removed duplicate `-ferror-limit=0` flag from generated `.clangd` config.
- Fixed MQL4/MQL5 version define handling in mixed workspaces - version defines are now set per-file based on extension.

## 1.0.8
- **Keyboard Shortcuts**: Added keyboard shortcuts for common commands:
  - `Ctrl+Alt+M`: Create MQL configuration
  - `Ctrl+Alt+O`: Open in MetaEditor
  - `Ctrl+Alt+C`: Create function comment
  - `Ctrl+Alt+I`: Insert MQH include

## 1.0.7
- **MQL5 Help**: Direct links to online documentation pages in the language of the user's VS Code.
- **Offline Help**: New command `MQL: Get the MQL4/MQL5 offline help` opens local CHM files from MetaTrader Terminal with keyword anchor (Windows/macOS/Linux). No help files are shipped with the extension.

## 1.0.0
- **Major Architecture Shift**: Migrated from Microsoft C/C++ to **clangd** for superior MQL intellisense and performance.
- **Performance Overhaul**: Converted blocking synchronous I/O to asynchronous operations across the extension.
- **Centralized Diagnostics**: Compiler errors and warnings now appear directly in the VS Code **Problems** tab.
- **Improved UI Responsiveness**: Optimized color providers and completion items to prevent high CPU load on large documents.
- **Reliability**: Added a Mocha unit testing suite for core logic.