# Commands Reference

All commands are contributed under the `mql_tools` namespace and appear in the VS Code Command Palette. Commands can also be invoked programmatically:

```javascript
await vscode.commands.executeCommand('mql_tools.<commandId>');
```

---

## Compilation Commands

### `mql_tools.checkFile` — Syntax Check { .api }

**Keyboard shortcut**: `Ctrl+Shift+Z`

Runs MetaEditor with the check flag (`/check`) on the active MQL file. Parses the output log and displays errors/warnings in the Problems panel and output channel. Does not produce compiled output. Applies auto-formatting before checking.

- For `.mq4`/`.mq5`: checks the current file directly
- For `.mqh`: resolves the compile target (see [Compile Targets](./compile-targets.md))

```javascript
// Triggered automatically on save when CheckOnSave is true
// Triggered on typing with debounce when AutoCheck.Enabled is true
vscode.commands.executeCommand('mql_tools.checkFile');
```

---

### `mql_tools.compileFile` — Compile File { .api }

**Keyboard shortcut**: `Ctrl+Shift+X`

Compiles the active MQL file via MetaEditor (`/compile` flag). Produces `.ex4` or `.ex5` output. Shows progress in status bar. Displays errors in Problems panel and compilation output in the output channel. Focuses Problems panel if errors are found.

```javascript
vscode.commands.executeCommand('mql_tools.compileFile');
```

---

### `mql_tools.compileScript` — Compile and Run Script { .api }

**Keyboard shortcut**: `Ctrl+Shift+C`

Compiles the active file and then runs it as a MetaTrader script (`/compile` + script execution). Requires the MetaTrader terminal to be open and the script to be a valid script file.

```javascript
vscode.commands.executeCommand('mql_tools.compileScript');
```

---

## Configuration Commands

### `mql_tools.configurations` — Create Configuration { .api }

**Keyboard shortcut**: `Ctrl+Alt+M`

Generates or updates the workspace clangd configuration for MQL development. Creates/updates:
- `compile_commands.json` — per-file compile commands
- `.clangd` — diagnostic suppressions and clangd configuration
- `.clang-format` — MQL-compatible formatter settings
- `.vscode/settings.json` — updates `clangd.fallbackFlags` and disables the MS C++ engine

After updating config, automatically restarts clangd to apply changes.

```javascript
vscode.commands.executeCommand('mql_tools.configurations');
```

When the `Include4Dir`/`Include5Dir` setting is configured, the command includes those paths in the clangd flags. Re-running this command is safe — it preserves custom `.clangd` suppressions based on the `mql_tools.Clangd.PreserveSuppressions` setting.

---

## Help Commands

### `mql_tools.help` — Open Online Help { .api }

**Keyboard shortcut**: `Shift+F1`

Opens online MQL documentation for the keyword at the cursor position in the active editor. Auto-detects MQL version (4 or 5) from file extension and workspace name.

- Looks up `mql5-docs.json` for direct doc URL lookup
- Falls back to mql5.com search if no direct URL available
- For MQL4: opens `docs.mql4.com` with search
- Respects VS Code language setting (en/ru/de/es/zh/ja)

Can also be called from Quick Fix actions with explicit keyword and version:

```javascript
// From code (e.g., quick fix)
vscode.commands.executeCommand('mql_tools.help', 'OrderSend', 5);
vscode.commands.executeCommand('mql_tools.help', 'MarketInfo', 4);
```

---

### `mql_tools.offlineHelp` — Open Offline CHM Help { .api }

Opens the locally installed MetaTrader help file (`mql4.chm` or `mql5.chm`). Searches standard locations:

- **Windows**: `%APPDATA%\MetaQuotes\Terminal\Help\mql5.chm`
- **macOS**: `~/Library/Application Support/net.metaquotes.wine.metatrader5/...`
- **Linux**: `~/.mt5/drive_c/Program Files/MetaTrader 5/Help/mql5.chm`

Falls back to online help if CHM not found.

```javascript
vscode.commands.executeCommand('mql_tools.offlineHelp');
```

---

## MetaEditor / Terminal Commands

### `mql_tools.openInME` — Open in MetaEditor { .api }

**Keyboard shortcut**: `Ctrl+Alt+O`
**Context menu**: Right-click on `.mq4`, `.mq5`, `.mqh` files in Explorer or Editor Title

Opens the active (or right-clicked) file in MetaEditor.

```javascript
// With file URI argument (from context menu)
vscode.commands.executeCommand('mql_tools.openInME', uri);
// Without argument (uses active editor)
vscode.commands.executeCommand('mql_tools.openInME');
```

Requires `mql_tools.Metaeditor.Metaeditor4Dir` or `Metaeditor5Dir` to be configured. On macOS/Linux with Wine enabled, automatically converts paths using `wine winepath`.

---

### `mql_tools.openTradingTerminal` — Open Trading Terminal { .api }

**Keyboard shortcut**: `F4`

Launches MetaTrader 4 or 5 terminal. Detects MQL version from the active file name (contains `mql4`/`mql5`) or workspace name.

```javascript
vscode.commands.executeCommand('mql_tools.openTradingTerminal');
```

Requires `mql_tools.Terminal.Terminal4Dir` or `Terminal5Dir` to be configured.

---

## Snippet Insertion Commands

### `mql_tools.InsMQH` — Insert Include Statement { .api }

**Keyboard shortcut**: `Ctrl+Alt+I`
**Context menu**: "Insert MQH as #include" in MQL editor submenu

Opens a file picker filtered to `.mqh` files. Inserts an `#include` statement at the cursor:
- Relative path uses `<>` for files in the Include folder
- Path from same directory uses `""` notation

```javascript
vscode.commands.executeCommand('mql_tools.InsMQH');
```

Example output: `#include <MyLib.mqh>` or `#include "relative/MyLib.mqh"`

---

### `mql_tools.InsNameMQH` — Insert Include from Explorer { .api }

**Context menu**: Right-click on `.mqh` file in Explorer → "Insert MQH as #include"

Inserts an `#include` statement for the selected `.mqh` file at the cursor in the active editor. Called directly by the Explorer context menu with the selected file URI. Use `mql_tools.InsMQH` for the file-picker variant.

```javascript
// Called by Explorer context menu with URI argument
vscode.commands.executeCommand('mql_tools.InsNameMQH', uri);
```

Example output: `#include <Include/MyLib.mqh>` or `#include "MyLib.mqh"`

---

### `mql_tools.InsMQL` — Insert Compile Target Comment (Editor) { .api }

**Context menu**: "Insert the file name 'mq4/mq5' in mqh document" — MQL editor submenu (`.mqh` files only)

Opens a file picker filtered to `.mq4`/`.mq5` files. When a file is selected and the active editor is a `.mqh` file, inserts a legacy magic compile-target comment at the top of the file:

```mql5
//###<Experts/MyEA.mq5>
```

This comment tells the extension which `.mq5`/`.mq4` file to compile when the `.mqh` header is the active file. Superseded by the `mql_tools.selectCompileTarget` command for new projects.

```javascript
vscode.commands.executeCommand('mql_tools.InsMQL');
```

---

### `mql_tools.InsNameMQL` — Insert Compile Target Comment (Explorer) { .api }

**Context menu**: Right-click on `.mq4`/`.mq5` file in Explorer → "Insert the file name 'mq4/mq5' in mqh document"

Inserts a legacy magic compile-target comment at the top of the **active** `.mqh` editor for the right-clicked `.mq4`/`.mq5` file:

```mql5
//###<Experts/MyEA.mq5>
```

Only works when the active editor contains a `.mqh` file. Use `mql_tools.InsMQL` for the file-picker variant.

```javascript
// Called by Explorer context menu with URI argument
vscode.commands.executeCommand('mql_tools.InsNameMQL', uri);
```

---

### `mql_tools.InsResource` — Insert Resource Directive { .api }

**Context menu**: "Insert resource" in MQL editor

Opens file picker filtered to `.bmp` and `.wav` files. Inserts at cursor:

```mql5
#resource "\\Images\\myfile.bmp"
```

---

### `mql_tools.InsImport` — Insert Import Block { .api }

**Context menu**: "Insert import" in MQL editor

Opens file picker filtered to `.dll` and `.ex5` files. Inserts at cursor:

```mql5
// For .dll:
#import "mylib.dll"

#import

// For .ex5:
#import "Libraries\\mylib.ex5"

#import
```

---

### `mql_tools.InsTime` — Insert Datetime Literal { .api }

**Context menu**: "Insert datetime" in MQL editor

Inserts the current date/time as a MQL datetime literal at cursor position. If text is selected, replaces the selection.

```mql5
// Example output:
D'2026.02.27 14:30:45'
```

---

### `mql_tools.InsIcon` — Insert Icon Directive { .api }

**Context menu**: "Insert icon" in MQL editor

Opens file picker filtered to `.ico` files. Inserts at cursor:

```mql5
#property icon "\\Images\\myicon.ico"
```

---

### `mql_tools.commentary` — Create Function Comment { .api }

**Keyboard shortcut**: `Ctrl+Alt+C`
**Context menu**: "Create commentary" in MQL editor

Generates a JSDoc-style doc comment for the function at the cursor. Detects the return type and parameter names from the function signature. Places the cursor after the comment.

```mql5
/**
 * Function description
 * @param  lot: Argument 1
 * @param  symbol: Argument 2
 * @return ( double )
 */
double CalculateLot(double lot, string symbol)
{
```

---

## Compile Target Commands

### `mql_tools.selectCompileTarget` — Select Compile Target { .api }

Only available for `.mqh` header files. Shows a QuickPick of all `.mq4`/`.mq5` files in the workspace. Selected file(s) are saved as the compile target for the active header.

```javascript
vscode.commands.executeCommand('mql_tools.selectCompileTarget');
```

---

### `mql_tools.resetCompileTarget` — Reset Compile Target { .api }

Clears the saved compile target mapping for the active `.mqh` header file.

```javascript
vscode.commands.executeCommand('mql_tools.resetCompileTarget');
```

---

### `mql_tools.resetAllCompileTargets` — Reset All Compile Targets { .api }

Prompts for confirmation then clears all saved compile target mappings for all workspace folders.

```javascript
vscode.commands.executeCommand('mql_tools.resetAllCompileTargets');
```

---

## Log Tailing Commands

### `mql_tools.toggleTerminalLog` — Toggle Live Runtime Log { .api }

**Status bar click**

Starts or stops the log tailing session. When started:
- Opens a dedicated output channel (`MQL Terminal`)
- Begins watching the log file with file system watching
- Shows the current mode (LiveLog or Standard) in the status bar

Status bar icon: `$(record)` when tailing, `$(circle-outline)` when stopped.

```javascript
vscode.commands.executeCommand('mql_tools.toggleTerminalLog');
```

---

### `mql_tools.installLiveLog` — Install LiveLog Library { .api }

Deploys the bundled `LiveLog.mqh` library from the extension to the user's MQL `Include` folder. Path is determined from `mql_tools.Metaeditor.Include5Dir` (or `Include4Dir`), or auto-detected from workspace.

```javascript
vscode.commands.executeCommand('mql_tools.installLiveLog');
```

After successful installation: "LiveLog.mqh installed! Add `#include <LiveLog.mqh>` to your EA and use PrintLive() for real-time output."

---

### `mql_tools.switchLogMode` — Switch Log Mode { .api }

Shows a QuickPick to switch between:
- **LiveLog (Real-time)**: Tails `MQL5/Files/LiveLog.txt` (requires `PrintLive()` in EA)
- **Standard Journal**: Tails `MQL5/Logs/YYYYMMDD.log` (uses standard `Print()` output)

If tailing is active when mode is changed, automatically restarts the tailing session.

---

## Icon Commands

### `mql_tools.Addicon` — Add Icons to Theme { .api }

**Context menu**: "Add icons to the theme"

Shows a QuickPick of supported icon themes. Installs MQL file type icons (`.mq4`, `.mq5`, `.mqh`, `.ex4`, `.ex5`) into the selected theme.

Supported themes:
- **Material Icon Theme** (`pkief.material-icon-theme`) — uses `material-icon-theme.files.associations` setting
- **vscode-icons** (`vscode-icons-team.vscode-icons`) — uses `vsicons.associations.files` setting
- **VSCode Great Icons** (`emmanuelbeziat.vscode-great-icons`) — directly patches icon JSON
- **Material Theme Icons** (`equinusocio.vsc-material-theme-icons`) — directly patches icon JSON

If the selected extension is not installed, offers to install it automatically.

---

## Diagnostics Commands

### `mql_tools.reportNoisyDiagnostic` — Report Noisy Diagnostic { .api }

Contributed command for reporting false-positive or noisy diagnostics from clangd or the lightweight diagnostics engine. Appears in the Command Palette as "MQL: Report noisy diagnostic".

```javascript
vscode.commands.executeCommand('mql_tools.reportNoisyDiagnostic');
```

**Note**: This command is contributed in `package.json` but may not have full implementation in all versions. Use it via the Command Palette when available.

---

## File Visibility Commands

### `mql_tools.Showfiles` — Show/Hide Compiled Files { .api }

**Context menu**: "Show/hide .ex4/.ex5 files" (only shown when `mql_tools.context == true`)

Toggles the `files.exclude` setting for `**/*.ex4` and `**/*.ex5` patterns, showing or hiding compiled MetaTrader files in the Explorer.

The Explorer context menu item for `mql_tools.Showfiles` only appears when `"mql_tools.context": true` is set in VS Code settings. The command can always be invoked programmatically:

```javascript
vscode.commands.executeCommand('mql_tools.Showfiles');
```
