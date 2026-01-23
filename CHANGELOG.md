# Changelog

## 1.0.18 (Unpublished)

### Improvements
- **Reduced hover verbosity**:
  - Documentation tooltips now strip redundant return type prefixes (e.g., `(int)`) when providing descriptions for standard MQL functions.
  - Added `Hover: ShowAKA: No` to the generated `.clangd` configuration to suppress verbose type alias information in tooltips.
  - Improved regex for return type stripping to be more robust across different MQL data types.

## 1.0.17 (2026-01-23)

### Bug Fixes
- **Fixed compilation not working on Windows**: MetaEditor was not executing due to incorrect argument quoting
  - Removed quotes from spawn arguments when using `shell: false` - Node.js handles escaping automatically
  - Fixed log file name mismatch: extension now looks for `SMC.log` instead of `SMC.mq5.log` (MetaEditor creates logs without source extension)
- **Fixed "File must be in a workspace folder" error**: `.mq4/.mq5` files can now be compiled even when not in a workspace folder (`.mqh` files still require workspace for compile target resolution)

### Improvements
- **Focus Problems panel on errors**: After compilation, the Problems panel is automatically focused if there are errors; otherwise the Output panel stays focused

## 1.0.16 (2026-01-23)

### Bug Fixes
- **Fixed file staying dirty after CheckOnSave**: Files no longer remain in a dirty (unsaved) state after the CheckOnSave feature runs
  - The `refreshClangdDiagnostics()` function was doing synthetic edits to trigger clangd re-analysis, which left documents marked as modified
  - Now saves documents after the synthetic edit cycle to clear the dirty state
  - Uses `internalSaveDepth` guard to prevent re-triggering CheckOnSave during the cleanup save

## 1.0.15 (2026-01-22)

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
