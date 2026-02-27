# Configuration Reference

All settings are under the `mql_tools` namespace. Configure them in `.vscode/settings.json` (workspace) or user `settings.json`.

## Quick Start Configuration

### MQL5 Workspace (Windows)

```jsonc { .api }
{
    "mql_tools.Metaeditor.Metaeditor5Dir": "C:\\Program Files\\MetaTrader 5\\metaeditor64.exe",
    "mql_tools.Metaeditor.Include5Dir": "C:\\Users\\Username\\AppData\\Roaming\\MetaQuotes\\Terminal\\<terminal-id>\\MQL5"
}
```

### MQL4 Workspace (Windows)

```jsonc { .api }
{
    "mql_tools.Metaeditor.Metaeditor4Dir": "C:\\Program Files\\MetaTrader 4\\metaeditor.exe",
    "mql_tools.Metaeditor.Include4Dir": "C:\\Users\\Username\\AppData\\Roaming\\MetaQuotes\\Terminal\\<terminal-id>\\MQL4"
}
```

### macOS/Linux with Wine

```jsonc { .api }
{
    "mql_tools.Metaeditor.Metaeditor5Dir": "/home/user/.mt5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe",
    "mql_tools.Metaeditor.Include5Dir": "/home/user/.mt5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal/<id>/MQL5",
    "mql_tools.Wine.Enabled": true,
    "mql_tools.Wine.Binary": "wine64",
    "mql_tools.Wine.Prefix": "/home/user/.mt5"
}
```

---

## MetaEditor Settings

### `mql_tools.Metaeditor.Metaeditor4Dir` { .api }

- **Type**: `string`
- **Default**: `"C:\\MT4_Install\\MetaTrader\\metaeditor.exe"`
- **Description**: Full path to MetaEditor 4 executable (`metaeditor.exe`). Used for compiling `.mq4` files and `.mqh` files in MQL4 workspaces. Supports `${workspaceFolder}` variable.

---

### `mql_tools.Metaeditor.Metaeditor5Dir` { .api }

- **Type**: `string`
- **Default**: `"C:\\MT5_Install\\MetaTrader\\metaeditor.exe"`
- **Description**: Full path to MetaEditor 5 executable (`metaeditor64.exe` on 64-bit). Used for compiling `.mq5` files and `.mqh` files in MQL5 workspaces. Supports `${workspaceFolder}` variable.

The extension accepts both `metaeditor.exe` and `metaeditor64.exe` basenames.

---

### `mql_tools.Metaeditor.Include4Dir` { .api }

- **Type**: `string`
- **Default**: `""`
- **Description**: Path to the MQL4 data folder (the folder containing `Include/`, `Logs/`, `Files/`, etc.). Used to pass the correct include path to clangd and MetaEditor, and to locate log files for the log tailer. Supports `${workspaceFolder}` and `${workspaceFolderBasename}`.

Typically: `C:\Users\You\AppData\Roaming\MetaQuotes\Terminal\<ID>\MQL4`

---

### `mql_tools.Metaeditor.Include5Dir` { .api }

- **Type**: `string`
- **Default**: `""`
- **Description**: Path to the MQL5 data folder. Same usage as `Include4Dir` but for MQL5.

Typically: `C:\Users\You\AppData\Roaming\MetaQuotes\Terminal\<ID>\MQL5`

---

### `mql_tools.Metaeditor.Portable4` { .api }

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Launch MetaEditor 4 in portable mode. Appends `/portable` flag to MetaEditor invocations.

---

### `mql_tools.Metaeditor.Portable5` { .api }

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Launch MetaEditor 5 in portable mode. Appends `/portable` flag to MetaEditor invocations.

---

## Terminal Settings

### `mql_tools.Terminal.Terminal4Dir` { .api }

- **Type**: `string`
- **Default**: `"C:\\MT4_Install\\MetaTrader\\terminal.exe"`
- **Description**: Full path to the MetaTrader 4 terminal executable (`terminal.exe`). Used by the `mql_tools.openTradingTerminal` command.

---

### `mql_tools.Terminal.Terminal5Dir` { .api }

- **Type**: `string`
- **Default**: `"C:\\MT5_Install\\MetaTrader\\terminal64.exe"`
- **Description**: Full path to the MetaTrader 5 terminal executable (`terminal64.exe`). Used by the `mql_tools.openTradingTerminal` command.

---

## Status Bar Button Settings

### `mql_tools.ShowButton.Compile` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Show the "Compile" button in the editor title bar for MQL files.

---

### `mql_tools.ShowButton.Check` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Show the "Check" button in the editor title bar for MQL files.

---

### `mql_tools.ShowButton.Script` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Show the "Compile and Run Script" button in the editor title bar for MQL files.

---

## Log File Settings

### `mql_tools.LogFile.DeleteLog` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Whether to delete the MetaEditor compilation log file after reading it. Set to `false` to keep log files for debugging.

---

## Auto-Check Settings

### `mql_tools.AutoCheck.Enabled` { .api }

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable automatic syntax checking while typing. The check is debounced by `AutoCheck.Delay` milliseconds. Runs `mql_tools.checkFile` automatically.

**Note**: Requires MetaEditor to be installed and configured. Each auto-check launches MetaEditor which has startup overhead.

---

### `mql_tools.AutoCheck.Delay` { .api }

- **Type**: `number`
- **Default**: `3000`
- **Minimum**: `1000`, **Maximum**: `30000`
- **Description**: Debounce delay in milliseconds for auto-check. The check fires this many ms after the last keystroke.

---

### `mql_tools.CheckOnSave` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Automatically run a syntax check when an MQL file is saved.

---

## Diagnostics Settings

### `mql_tools.Diagnostics.Lightweight` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Enable lightweight live diagnostics that run without MetaEditor. Provides instant feedback for:
  - Unnecessary semicolons after `}`
  - Assignment (`=`) in `if`/`while` conditions where `==` was likely intended
  - Unclosed string literals
  - Common MQL function name typos

---

## Wine Settings (macOS/Linux)

### `mql_tools.Wine.Enabled` { .api }

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable Wine for running MetaEditor on macOS or Linux. Ignored on Windows. When enabled, the extension converts file paths between Unix and Windows formats automatically using `wine winepath`.

---

### `mql_tools.Wine.Binary` { .api }

- **Type**: `string`
- **Default**: `"wine64"`
- **Description**: Path to the Wine executable. Use `wine` instead of `wine64` when running Apple Silicon (ARM) with CrossOver or similar. Can be an absolute path or a command name if Wine is on PATH.

---

### `mql_tools.Wine.Prefix` { .api }

- **Type**: `string`
- **Default**: `""`
- **Description**: Path to use as `WINEPREFIX`. When empty, Wine uses the default prefix (`~/.wine`). Set this to the Wine prefix that contains the MetaTrader installation.

Example: `/home/user/.mt5` or `/Users/user/Library/Application Support/net.metaquotes.wine.metatrader5`

---

### `mql_tools.Wine.Timeout` { .api }

- **Type**: `number`
- **Default**: `60000`
- **Minimum**: `10000`, **Maximum**: `300000`
- **Description**: Timeout in milliseconds for Wine-based MetaEditor compilation. Wine processes can be slow to start; increase this if compilations are timing out.

---

## Compile Target Settings

### `mql_tools.CompileTarget.Storage` { .api }

- **Type**: `string` (enum)
- **Default**: `"workspaceState"`
- **Options**:
  - `"workspaceState"` — Stored per-user, per-workspace in VS Code's workspace state. Not shared via version control.
  - `"globalState"` — Stored per-user across all workspaces in VS Code's global state.
  - `"workspaceSettings"` — Stored in `.vscode/settings.json` under `mql_tools.CompileTarget.Map`. Shared with team via version control.
- **Description**: Where compile target mappings (header → .mq4/.mq5 file) are persisted.

---

### `mql_tools.CompileTarget.AllowMultiSelect` { .api }

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Allow selecting multiple compile targets for a single `.mqh` header file. When enabled, compiling the header compiles all mapped targets.

---

### `mql_tools.CompileTarget.InferMaxFiles` { .api }

- **Type**: `number`
- **Default**: `5000`
- **Minimum**: `100`, **Maximum**: `50000`
- **Description**: Maximum number of files to scan when building the reverse include graph for automatic compile target inference. Reduce for large workspaces with performance issues.

---

### `mql_tools.CompileTarget.Map` { .api }

- **Type**: `object`
- **Default**: `{}`
- **Description**: Manual mapping of `.mqh` headers to their compile targets, used when `Storage` is `"workspaceSettings"`. Keys are header file paths (relative to workspace), values are arrays of compile target paths.

```jsonc
{
    "mql_tools.CompileTarget.Storage": "workspaceSettings",
    "mql_tools.CompileTarget.Map": {
        "Include/MyUtils.mqh": ["Experts/MyEA.mq5"],
        "Include/Indicators.mqh": ["Experts/EA1.mq5", "Experts/EA2.mq5"]
    }
}
```

---

## Clangd Settings

### `mql_tools.Clangd.PreserveSuppressions` { .api }

- **Type**: `string` (enum)
- **Default**: `"prompt"`
- **Options**:
  - `"prompt"` — Ask each time whether to preserve custom suppressions
  - `"always"` — Always merge custom suppressions with the new config
  - `"never"` — Always overwrite the `.clangd` file without merging
- **Description**: Controls whether custom diagnostic suppressions added to `.clangd` are preserved when running `MQL: Create configuration`.

---

## Path Variable Expansion

Settings that accept path values support the following variables:

| Variable | Description |
|----------|-------------|
| `${workspaceFolder}` | Absolute path of the first workspace folder |
| `${workspaceFolderBasename}` | Basename of the workspace folder |
| Relative paths | Resolved relative to the workspace folder |
| Absolute paths | Used as-is |

Example:
```jsonc
{
    "mql_tools.Metaeditor.Include5Dir": "${workspaceFolder}/../mt5_data/MQL5"
}
```

## Internal Settings

### `mql_tools.context` { .api }

- **Type**: `boolean`
- **Default**: `false`
- **Description**: Internal setting that controls whether certain context menu items are shown in the Explorer. When `true`, the "Show/hide .ex4/.ex5 files" menu item appears in the Explorer context menu.

---

## MQL Version Detection

The extension auto-detects whether a workspace is MQL4 or MQL5 using these rules (in priority order):

1. **File extension**: `.mq4` → MQL4, `.mq5` → MQL5
2. **Workspace name**: Contains `MQL4` → MQL4, otherwise MQL5
3. **Active file path**: Contains `MQL4` → MQL4, contains `MQL5` → MQL5

This determines which MetaEditor path, include dir, and terminal to use.

---

## Automatic Startup Check

When an MQL file is open in the active editor when VS Code starts (or when the extension activates), the extension automatically runs a syntax check (`mql_tools.checkFile`) after a 3-second delay. This behavior runs unconditionally at startup regardless of `AutoCheck.Enabled` or `CheckOnSave` settings.
