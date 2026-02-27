# Wine Support (macOS / Linux)

MetaEditor is a Windows application. On macOS and Linux, the extension can run MetaEditor via [Wine](https://www.winehq.org/).

## Requirements

- Wine installed (`wine64` or `wine`)
- MetaTrader and MetaEditor installed inside Wine prefix
- `mql_tools.Wine.Enabled` set to `true`

---

## Configuration { .api }

```jsonc
{
    // Required: enable Wine
    "mql_tools.Wine.Enabled": true,

    // Optional: Wine executable (default: "wine64")
    "mql_tools.Wine.Binary": "wine64",

    // Optional: WINEPREFIX path (default: uses Wine default ~/.wine)
    "mql_tools.Wine.Prefix": "/home/user/.mt5",

    // Optional: compilation timeout in ms (default: 60000)
    "mql_tools.Wine.Timeout": 60000,

    // MetaEditor path as UNIX path (NOT Windows path)
    "mql_tools.Metaeditor.Metaeditor5Dir": "/home/user/.mt5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe",

    // Include dir as UNIX path
    "mql_tools.Metaeditor.Include5Dir": "/home/user/.mt5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal/<id>/MQL5"
}
```

**Important**: `Metaeditor5Dir` and `Include5Dir` must be Unix paths (not `C:\...`). The extension automatically converts them to Windows format using `wine winepath -w` when invoking Wine.

---

## Platform-Specific Examples

### Linux

```jsonc { .api }
{
    "mql_tools.Wine.Enabled": true,
    "mql_tools.Wine.Binary": "wine64",
    "mql_tools.Wine.Prefix": "/home/user/.mt5",
    "mql_tools.Metaeditor.Metaeditor5Dir": "/home/user/.mt5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe",
    "mql_tools.Metaeditor.Include5Dir": "/home/user/.mt5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal/XXXXXXXXXXXXXXXX/MQL5"
}
```

Install Wine on Ubuntu/Debian: `sudo apt install wine64`

Common log file path: `~/.mt5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal/<id>/MQL5/Logs/`

### macOS (Intel)

```jsonc { .api }
{
    "mql_tools.Wine.Enabled": true,
    "mql_tools.Wine.Binary": "wine64",
    "mql_tools.Wine.Prefix": "/Users/user/Library/Application Support/net.metaquotes.wine.metatrader5",
    "mql_tools.Metaeditor.Metaeditor5Dir": "/Users/user/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe",
    "mql_tools.Metaeditor.Include5Dir": "/Users/user/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal/<id>/MQL5"
}
```

### macOS (Apple Silicon / CrossOver)

```jsonc { .api }
{
    "mql_tools.Wine.Enabled": true,
    "mql_tools.Wine.Binary": "wine",
    "mql_tools.Wine.Prefix": "/Users/user/Library/Application Support/CrossOver/Bottles/MetaTrader5",
    "mql_tools.Metaeditor.Metaeditor5Dir": "/Users/user/Library/Application Support/CrossOver/Bottles/MetaTrader5/drive_c/Program Files/MetaTrader 5/metaeditor64.exe"
}
```

---

## How It Works

When Wine is enabled, the extension:

1. **Validates** the Wine setup at startup (calls `wine --version`)
2. **Converts paths** from Unix to Windows format via `wine winepath -w`
3. **Creates a temporary `.bat` file** with the MetaEditor command and arguments (handles quoting/escaping)
4. **Runs**: `wine cmd /c <batch_file.bat>`
5. **Cleans up** the batch file 5 seconds after invocation

Path conversion details:
- Reads `wine winepath -w <unixPath>` to get Windows-style path
- Used for both the MetaEditor executable and the file being compiled

---

## Wine Helper API

The Wine helper functions are used internally but document the logic:

### Path Validation { .api }

```javascript
validateWinePath(pathToCheck)
// Returns: {valid: boolean, error?: string}
// Validates path is Unix format (not C:\ style)
// Call before passing paths to Wine functions

const result = validateWinePath('/home/user/.wine/drive_c/...');
// {valid: true}

const bad = validateWinePath('C:\\Program Files\\...');
// {valid: false, error: "Path appears to be a Windows path..."}
```

### Path Conversion { .api }

```javascript
toWineWindowsPath(localPath, wineBinary, winePrefix)
// Returns: Promise<{path: string, success: boolean, error?: string}>
// Converts Unix path to Windows format

const result = await toWineWindowsPath('/home/user/.wine/drive_c/Windows', 'wine64', '');
// {path: 'Z:\\home\\user\\.wine\\drive_c\\Windows', success: true}
```

### Wine Status Check { .api }

```javascript
isWineInstalled(wineBinary, winePrefix)
// Returns: Promise<{installed: boolean, version?: string, error?: string}>
// Checks if Wine is reachable and returns version string

const status = await isWineInstalled('wine64', '');
// {installed: true, version: 'wine-8.0 (Ubuntu 8.0)'}
```

---

## Wine Environment

The `WINEPREFIX` environment variable is set for all Wine invocations when `Wine.Prefix` is non-empty:

```javascript { .api }
getWineEnv(config)
// Returns env object with WINEPREFIX if configured
// Example: { ...process.env, WINEPREFIX: '/home/user/.mt5' }
```

---

## Timeout Behavior

Wine processes can be slow to start. If a compilation exceeds `Wine.Timeout` ms:
- The process receives `SIGTERM`
- After 2 seconds, if still alive, receives `SIGKILL`
- An error is logged to the MQL output channel
- Increase timeout: `"mql_tools.Wine.Timeout": 120000`

---

## Startup Validation

When the extension activates with Wine enabled:
1. Checks Wine is installed by running `wine --version`
2. Logs the Wine version to the MQL output channel
3. Shows an error notification if Wine is not found, with "Open Settings" button

Wine validation result is shown at startup:
```
[Wine] Detected: wine-8.0 (Ubuntu 8.0)
[Wine] Using prefix: /home/user/.mt5
```

---

## Troubleshooting

**"Wine not found"**: Ensure Wine is installed and on PATH, or set full path in `Wine.Binary`.

**"Path appears to be a Windows path"**: Change `Metaeditor5Dir` to use Unix path format (starting with `/`), not `C:\...`.

**Compilation times out**: Increase `Wine.Timeout`. First compilation is slower due to Wine initialization.

**Path conversion fails**: Verify `Wine.Prefix` points to the correct Wine prefix that contains the MetaTrader installation.
