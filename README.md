> **Note**: This project was originally based on [MQL Tools](https://github.com/L-I-V/MQL-Tools) by **L-I-V**, but has since evolved into an independent project with significant architectural changes including **clangd** support and major performance optimizations.
>
> **[View Changelog](CHANGELOG.md)** for the latest updates and improvements.

---

### Differences from MQL Tools

| Feature | MQL Tools | MQL Clangd |
|---------|-----------|------------|
| IntelliSense Engine | Microsoft C++ | **clangd** |
| Performance | Synchronous I/O | **Async I/O** |
| Diagnostics in Problems tab | ❌ | ✅ |
| Multi-root workspace support | ❌ | ✅ |
| Direct MQL5 doc links | ❌ | ✅ |
| Compilation - not necessary to open MetaEditor | ❌ | ✅ |
| Smart Compile Target for Headers | ❌ | ✅ |
| Document Symbols (Outline, Breadcrumbs) | ❌ | ✅ |
| Run Backtest from VS Code | ❌ | ✅ |
| Debugging | ❌ | **Coming next** |

---

### Smart Compile Targets for Header Files

When editing `.mqh` header files, the extension now intelligently determines which main `.mq4/.mq5` file to compile—without hardcoding filenames in the header itself.

*   **Automatic Inference**: The extension builds a reverse include graph to find which main files include your header.
*   **Smart Selection**:
  - If exactly 1 main file includes the header → **auto-compiles and remembers** the choice
  - If multiple main files include it → shows a picker to select which one(s) to compile
  - If no main files include it → shows all available main files to pick from
*   **Persistent Mappings**: Your choices are remembered across sessions (configurable storage: workspace-local, global, or shared via `.vscode/settings.json`).
*   **Multi-Target Support**: Compile multiple main files from a single header in one go.
*   **Backward Compatible**: The old magic comment syntax (`//###<path/to/file.mq5>`) still works as a fallback.

**Commands**:
- `MQL: Select Compile Target(s) for Header` — Manually choose compile targets
- `MQL: Reset Compile Target for Current Header` — Clear the mapping
- `MQL: Reset All Compile Target Mappings` — Clear all stored mappings

---

### IntelliSense & Semantic Support
This extension now uses **clangd** to provide state-of-the-art IntelliSense, code completion, and navigation for MQL4/5.

*   **Why clangd?** It provides faster, more accurate semantic analysis and better support for complex MQL projects compared to the default Microsoft C++ engine.
*   **Automatic Configuration**: When you run the `"MQL: Create configuration"` command, the extension automatically configures `clangd` with the correct include paths and compiler flags for your MQL version (MQL4 or MQL5). **clangd is automatically restarted** after configuration to immediately apply the new settings.
*   **Conflict Prevention**: To ensure the best experience, this extension automatically disables the Microsoft C++ "IntelliSense Engine" (while keeping the extension installed for other features) to prevent duplicate errors and completion items.

---

### Quick Setup Guide: 

1.  **Installation**:
    *   Install this **MQL Clangd** extension from the VS Code Marketplace.
    *   *Note: The **clangd** extension will be automatically installed as a required dependency.*

2.  **Open your project**:
    *   Open your MQL project folder (e.g., your `MQL5` or `MQL4` folder).
    *   **Pro Tip**: Ensure your folder name contains "MQL4" or "MQL5" for automatic version detection.

3.  **Basic Configuration**:
    *   Open Settings (`Ctrl+,`) and search for `MQL Clangd`.
    *   Provide the path to your **MetaEditor** executable (essential for compilation).

4.  **Initialize IntelliSense**:
    *   Press `Ctrl+Shift+P` and run the command: `"MQL: Create configuration"`.
    *   This one-time setup configures `clangd` to recognize your MQL code and libraries.

5.  **Bonus: Icons**:
    *   If you wish, set custom icons for MQL files. Press `Ctrl+Shift+P`, select `"MQL: Add icons to the theme"`, and choose your preferred MQL-supported theme.

---

### 💡Important Notes:
*   **Multi-root workspaces**: The configuration tool supports multi-root workspaces and will prioritize settings for the currently active file's folder.
*   **Settings Merge**: The extension is built to be "clean" - it merges MQL flags with your existing `clangd.fallbackFlags` rather than overwriting them.
*   **Compiler Flags**: We automatically inject `-xc++` and `-std=c++17` along with version-specific defines (`__MQL4__`/`__MQL5__`) to help clangd understand MQL syntax.
*   **Relative Paths & Portable Mode**: Settings like `mql_tools.Metaeditor.Metaeditor5Dir` and `mql_tools.Metaeditor.Include5Dir` now support `${workspaceFolder}` variable substitution and relative paths. This is perfect for portable MetaTrader installations:
    ```json
    {
        "mql_tools.Metaeditor.Metaeditor5Dir": "${workspaceFolder}/../MetaEditor64.exe",
        "mql_tools.Metaeditor.Include5Dir": "${workspaceFolder}"
    }
    ```
*   **Third-party Libraries**: If you use libraries like `JAson.mqh` and clangd reports "Unknown type" errors, you have two options:

    **Option A** - Add to settings (global, affects all files):
    ```json
    {
        "mql_tools.Clangd.ForcedIncludes": [
            "Include/JAson.mqh"
        ]
    }
    ```

    **Option B** - Add conditional include in your code (per-file):
	```mql5
	#ifdef __clang__
	#include <JAson.mqh>
	#endif
	```
This include is only seen by clangd and ignored by MetaEditor.

### MetaEditor on macOS / Linux (Wine)

On non-Windows platforms you can run MetaEditor through Wine while keeping the same workflow.

1. Install Wine (`wine64` or `wine`) and MetaTrader/MetaEditor inside a Wine prefix.
2. Point the extension to your MetaEditor executable (host path inside the Wine prefix), for example:

   ```json
   {
       "mql_tools.Metaeditor.Metaeditor5Dir": "${workspaceFolder}/../drive_c/Program Files/MetaTrader 5/MetaEditor64.exe"
   }
   ```

3. Enable the Wine wrapper and (optionally) configure the Wine binary:

   ```json
   {
       "mql_tools.Wine.Enabled": true,
       "mql_tools.Wine.Binary": "wine64" // or "wine", or full path like "/usr/local/bin/wine64"
   }
   ```

When `mql_tools.Wine.Enabled` is `true` on macOS/Linux:

- Compile / Check commands run MetaEditor via Wine instead of executing the `.exe` directly.
- Paths for source files, include directories and logs are automatically converted with `winepath -w`, so MetaEditor sees them as `Z:\\...` paths.
- Behaviour on Windows is unchanged (the wrapper is ignored on Windows, or when `Wine.Enabled` is `false`).

---

### Live Runtime Log

Monitor your MQL4/MQL5 terminal logs in real-time directly within VS Code—no need to switch to MetaTrader or open external log files.

**Features:**
- **Real-time log tailing**: See log messages as they happen
- **Status bar integration**: Click the status bar item to toggle log monitoring on/off
- **Two tailing modes**: Choose between standard journal logs or real-time LiveLog output

#### Log Modes

| Mode | Description | Latency |
|------|-------------|---------|
| **LiveLog (Real-time)** | Tails `MQL5/Files/LiveLog.txt` (auto-rotate at 10MB → `LiveLog_YYYY_MM_DD.txt`) - uses `PrintLive()` with immediate disk flush | **Instant** ⚡ |
| **Standard Journal** | Tails `MQL5/Logs/YYYYMMDD.log` - uses standard `Print()` output | Delayed (MetaTrader buffering) |

**Why two modes?**
MetaTrader's standard `Print()` function buffers output and doesn't flush to disk immediately, which causes delays in the VS Code log viewer. The **LiveLog** mode solves this by using a custom logging library (`LiveLog.mqh`) that writes directly to a file with immediate flush.

#### Setting up LiveLog (Real-time) Mode

1. **Install the library**:
   Run `MQL: Install LiveLog Library` from the Command Palette, or start tailing and accept the prompt to install.

2. **Include in your EA**:
   ```mql5
   #include <LiveLog.mqh>
   ```

3. **Use `PrintLive()` or the level-prefixed log functions**:
   ```mql5
   PrintLive("Hello, World!");
   PrintFormatLive("Value: %d, Price: %.5f", 42, 1.23456);

   // Level-prefixed logging (automatically includes source location for Trade Report):
   LogDebug("Debug message");
   LogInfo("Info message");
   LogWarn("Warning message");
   LogError("Error message");
   LogTrade("SIMULATED BUY MARKET");
   ```

   The `Log*()` functions automatically embed `{File:Function:Line}` tags, enabling **click-to-source** navigation in the Trade Report (see below).

4. **Optional - Redirect all Print() calls automatically**:
   Add `#define LIVELOG_REDIRECT` **before** the include to automatically redirect all `Print()` and `PrintFormat()` calls:
   ```mql5
   #define LIVELOG_REDIRECT
   #include <LiveLog.mqh>
   
   // Now all Print() calls automatically go to LiveLog.txt!
   Print("This will appear in LiveLog.txt");
   PrintFormat("Value: %d", 42);
   ```

5. **Optional - Clean session end marker**:
   Call `LiveLogClose()` from your `OnDeinit` to write a "Session Ended" marker:
   ```mql5
   void OnDeinit(const int reason)
   {
      LiveLogClose();  // Optional - writes "Session Ended" marker
      // ... your other cleanup code ...
   }
   ```


**Commands:**
- `MQL: Toggle Live Runtime Log` — Start/stop log tailing
- `MQL: Install LiveLog Library` — Deploy `LiveLog.mqh` to your Include folder
- `MQL: Switch Log Tail Mode (Live/Standard)` — Switch between real-time and standard modes

**Notes:**
- The extension automatically detects MQL version from your active file, workspace folder name, or configured settings
- If the data folder path is not configured, the extension will attempt to infer it from your workspace structure
- Only new log entries are shown (historical logs are not dumped on start)
- `LiveLog.txt` auto-rotates at 10MB (renamed to `LiveLog_YYYY_MM_DD.txt`) to prevent disk space issues

---

### Trade Report Dashboard

Analyze your Strategy Tester results directly in VS Code. The Trade Report parses MT5 tester log files and displays trades, P&L, and log entries in an interactive dashboard.

**Command:** `MQL: Open Trade Report Dashboard`

**Features:**
- Auto-discovers EAs with test runs under `MQL5/Experts/`
- Shows trade summary: count, net P&L, win rate, gross profit/loss, commissions
- Individual trade table with entry/exit prices, SL, TP, lots, and exit reason
- Filterable log viewer (ALL, TRADE, INFO, WARN, DEBUG, ERROR)
- Click any log line number to jump to that line in the `.log` file

#### Source Code Navigation (Click-to-Source)

When using **LiveLog** `Log*()` functions, each log entry and trade automatically includes a source location tag. In the Trade Report, these appear as clickable yellow badges that jump straight to the corresponding line in your MQL source code.

**Setup:** Just use LiveLog's level-prefixed functions — source tags are embedded automatically:

```mql5
#include <LiveLog.mqh>

void OnTick()
{
    LogInfo("Checking for entry signal");

    if (buySignal)
    {
        LogTrade("SIMULATED BUY MARKET");
        LogInfo("Entry: " + DoubleToString(price, 5) + " | SL: " + DoubleToString(sl, 5) + " | TP: " + DoubleToString(tp, 5) + " | Lots: 0.10");
    }
}
```

The Trade Report will show:
- **Source column** in the trades table with clickable entry/exit source links
- **Yellow source badges** on each log entry (e.g. `OnTick:12`) that open the file at that line

> **Note:** Source navigation requires LiveLog. Without it, trades and log entries still appear but without clickable source links.

#### Source Snapshots

Because `{File:Function:Line}` tags reference specific line numbers, modifying your EA source code after a test run can make those links point to the wrong lines. **Source Snapshots** solve this by copying all referenced MQL source files into a `snapshot/` folder next to the log file the first time you open a report.

**Enable it:**

```jsonc
// settings.json
"mql_tools.TradeReport.SnapshotSources": true
```

When a snapshot exists the Trade Report shows **two clickable badges** per source location:
- **Green badge** — opens the **snapshot** (frozen copy from test time, line numbers always match)
- **Yellow badge** — opens the **current** (live) file in your workspace

The dashboard also marks runs that have a snapshot with a small **snapshot** label.

> **Warning:** Enabling this setting increases disk usage because a full copy of every referenced source file is stored per run. If you run many tests the extra space can add up — disable the setting or delete `snapshot/` folders you no longer need.

---

### Run Backtest

Launch an MT5 Strategy Tester run for your EA directly from VS Code — without touching the MetaTrader UI.

**Requires:** TradeReportServer running (or auto-started) and a `tester.ini` file in the EA's folder.

**How to use:**

1. Open any `.mq5`, `.mq4`, or `.mqh` file belonging to your EA.
2. Press `Ctrl+Alt+T`, click the **⚗ Run Backtest** button in the editor title bar, or run `MQL: Run Backtest` from the Command Palette.
3. Select the EA (auto-detected from your current file, or pick from a list).
4. Choose the symbol and date range (pre-filled from `tester.ini`).
5. MT5 launches the Strategy Tester in the background. A progress notification tracks elapsed time.
6. When the test finishes, the **Trade Report Dashboard** opens automatically with the new results.

**Settings:**

| Setting | Default | Description |
|---------|---------|-------------|
| `mql_tools.Backtest.PromptForParameters` | `true` | Show symbol/date prompts before running. Set `false` to use `tester.ini` defaults silently. |
| `mql_tools.Backtest.AutoOpenReport` | `true` | Open the Trade Report Dashboard when the test completes. |
| `mql_tools.Backtest.AutoStartServer` | `true` | Auto-start TradeReportServer if it isn't already running. |
| `mql_tools.Backtest.ServerPort` | `3002` | Port used by TradeReportServer. |
| `mql_tools.ShowButton.RunBacktest` | `true` | Show/hide the toolbar button on MQL files. |

**Notes:**
- The test runs fully inside MT5 — cancelling the VS Code progress notification only stops monitoring, not the MT5 test itself.
- A `tester.ini` file must exist in the EA's folder (e.g. `Experts/Trading/MyEA/tester.ini`) for the server to know the default test configuration.

---

### MQL Debugger (Real-Time Variable Inspection)

Debug your MetaTrader Expert Advisors and Scripts directly from VS Code. The extension automatically injects telemetry code at your VS Code breakpoints, compiles a temporary instrumented build, and streams variable states back to a live debug dashboard — no MetaEditor debugger required.

**How to use:**

1. Open the `.mq5`, `.mq4`, or `.mqh` file you want to debug.
2. Place breakpoints in the editor margin (click to the left of the line numbers) where you want to inspect variables.
3. Click the **Start Debugging** (bug icon) button in the editor title bar, or press `Ctrl+Alt+D`, or run `MQL: Start Debugging` from the Command Palette.
   - *Starting from an `.mqh` file automatically resolves dependencies and asks which main EA to instrument.*
4. The extension will automatically:
   - Deploy `MqlDebug.mqh` to your MetaTrader `Include/` folder (always up to date).
   - Instrument all relevant source files (main EA + included headers with breakpoints).
   - Compile a temporary `*.mql_dbg_build.ex5` file without touching your original `.ex5`.
   - Start watching the debug log file.
   - Open the **MQL Debug panel** in VS Code.
5. In MetaTrader, attach the newly compiled EA/Script to a chart.
6. As the EA executes and hits breakpoints, variables populate and update in real-time in the debug dashboard.
7. When finished, click **Stop Session** in the notification or run `MQL: Stop Debugging`.

#### What variables are automatically watched

At each breakpoint the extension automatically collects variables into two tiers depending on the `mql_tools.Debug.DetailLevel` setting:

**Default mode** (always active):

| Source | Example |
|--------|---------|
| Function parameters | `double price`, `int magic` |
| Local variables declared before the breakpoint | `int bar = 0;` |
| Member access expressions used in the function | `g_timers.lastTime`, `this.m_count`, `a.b.c` |
| Implicit class members referenced near the breakpoint | `m_lotSize` used inside a class method |

**Deep Analysis mode** (`mql_tools.Debug.DetailLevel: deepAnalysis`) — additionally:

| Source | Example |
|--------|---------|
| Global primitive variables referenced within ±15 lines | `g_spread`, `g_signal` |
| `input` / `sinput` parameter variables (always, no proximity filter) | `InpLotSize`, `InpMaxOrders` |
| Primitive fields of local class-typed variables | `order.lots`, `order.openPrice` |

**Supported types:** `int`, `uint`, `short`, `ushort`, `char`, `uchar`, `long`, `ulong`, `double`, `float`, `string`, `bool`, `datetime`, `color`, common `ENUM_*` types, and arrays of numeric types.

#### Manual watch annotations

Add a `// @watch` comment near any breakpoint to explicitly name variables that should be watched, even if the auto-detector would miss them:

```mql5
// @watch myVar otherVar
SomeFunction();  // ← breakpoint here
```

Multiple variables can be listed on one line. Annotated variables are always watched first.

#### Breakpoint conditions

VS Code conditional breakpoints are fully supported. Set a condition in the breakpoint editor and the injected code wraps the telemetry in an `if` block — the EA only pauses when the condition is true.

#### Pause / Continue (blocking breakpoints)

Each breakpoint also injects a `MQL_DBG_PAUSE` call, which spin-waits until VS Code sends a **Continue** command (by stopping the debug session or using the Stop button). This lets you inspect a frozen state before the EA resumes.

> **Warning:** The EA thread is fully blocked while paused. No `OnTick`/`OnTimer` events fire. Use only on demo accounts or in the Strategy Tester.
> Auto-resumes after 120 seconds as a safety failsafe.

#### Call stack tracking

Functions containing breakpoints automatically get `ENTER`/`EXIT` instrumentation injected, so the debug dashboard shows a live call stack as functions are entered and returned.

#### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mql_tools.Debug.DetailLevel` | `default` | `default`: locals + member access. `deepAnalysis`: also global primitives, `input` vars, and class field expansion. |
| `mql_tools.ShowButton.StartDebugging` | `true` | Show/hide the toolbar bug button on MQL files. |

**Notes:**
- Class-typed variables are not serialized directly (would cause compile errors). Only their primitive/enum fields are watched.
- If an injection point is unsafe (e.g. inside a braceless single-line block), the debugger warns and skips that line. Use `// @watch` or add a statement to create a safe injection point.
- The instrumented build uses `.mql_dbg_build` in the filename — never commit or deploy these files.

---

### Troubleshooting clangd diagnostics (MQL-specific)

If you open built-in examples like `MQL5/Experts/Examples/MACD/MACD Sample.mq5` and see a large number of clangd errors, work through the steps below.

1. **Make sure the workspace is configured**
   - Run `MQL: Create configuration` (from the Command Palette) once per workspace root.
   - This command:
     - Updates `.vscode/settings.json` with the required `clangd.fallbackFlags`.
     - Generates a `.clangd` file in the workspace to suppress many MQL-specific false positives.

2. **Verify include paths**
   - The extension adds `-I` flags for your MQL4/MQL5 root and its `Include` directory based on your MetaEditor path.
   - If your MetaTrader installation lives in a non-standard location, set the appropriate `mql_tools.Metaeditor.*` settings (for example `Metaeditor5Dir` and `Include5Dir`), then run `MQL: Create configuration` again.
   - Advanced: you can manually extend `clangd.fallbackFlags` in `.vscode/settings.json` with extra `-I...` or `-include...` flags; MQL Clangd merges its own flags with your existing ones instead of overwriting them.

3. **Add forced includes for framework / library headers**
   - For additional frameworks or helper headers that define lots of types or functions used by your project, prefer:
     - `mql_tools.Clangd.ForcedIncludes` (global, for all MQL projects), or
     - `#ifdef __clang__` includes inside specific `.mq4/.mq5` files (per-file).
   - This is often enough to fix "unknown type/function" diagnostics without changing how MetaEditor compiles your code.

4. **Tuning diagnostics via the generated `.clangd` file**
   - The `.clangd` file generated by the extension already suppresses many diagnostics that are known to be noisy for MQL (preprocessor directives, array peculiarities, overload resolution differences, and so on).
   - If you still hit a clangd-only warning that is harmless in MQL, you can:
     - Open the `.clangd` file at the workspace root.
     - Add the diagnostic ID to the `Diagnostics: Suppress:` list.
   - This gives you fine-grained control over which clangd checks remain active.

   **Tip: Intentional assignment in conditions**

   If you see "Possible assignment in condition" for intentional code like `if(ticket = OrderSend(...))`, you can silence it by adding extra parentheses:
   ```mql5
   // Warning: assignment in condition
   if (ticket = OrderSend(...)) { }

   // No warning: extra parentheses signal intent
   if ((ticket = OrderSend(...))) { }
   ```

5. **Cleaning up old configuration**
   - If you previously used other extensions (for example the original "MQL Tools" based on the Microsoft C++ engine), you may have leftover `clangd.fallbackFlags` pointing to old compatibility headers or invalid include paths.
   - Open your workspace `.vscode/settings.json`, search for `clangd.fallbackFlags`, and remove or adjust any flags that reference non-existent paths or other extensions.
   - Then re-run `MQL: Create configuration` so MQL Clangd can regenerate a clean configuration.

---

### FAQ: Common Questions

#### How can I make clang-format more relaxed for MQL code?

If clang-format is reformatting your MQL code in ways you don't like, you have several options:

1. **Disable formatting entirely for MQL files** (recommended for MQL):
   Add this to your `.clangd` file:
   ```yaml
   ---
   If:
     PathMatch: .*\.(mq4|mq5|mqh)
   Diagnostics:
     # ... your existing suppressions
   Style:
     # Disable clang-format for MQL files
     DisableFormat: true
   ```

2. **Customize clang-format style**:
   Create a `.clang-format` file in your workspace root with relaxed settings:
   ```yaml
   BasedOnStyle: LLVM
   IndentWidth: 3
   ColumnLimit: 0
   AllowShortFunctionsOnASingleLine: All
   AllowShortIfStatementsOnASingleLine: true
   AllowShortLoopsOnASingleLine: true
   BreakBeforeBraces: Attach
   SpaceAfterCStyleCast: false
   ```

3. **Use MetaEditor's formatting instead**:
   Since MetaEditor has its own formatting rules, you might prefer to format MQL code in MetaEditor and disable clang-format in VS Code entirely.

#### Is it risky to suppress so many diagnostics?

**Short answer:** For MQL code, it's necessary and safe.

**Why we suppress diagnostics:**
- MQL is **not standard C++**. It has different syntax, keywords, and semantics.
- clangd is a C++ language server that doesn't natively understand MQL-specific features like:
  - `#property` and `#import` directives
  - `input` and `sinput` keywords
  - `export` modifier
  - Flexible arrays in classes
  - Different type conversion rules
  - Different overload resolution
  - MQL's custom string type

**What we suppress:**
- **False positives**: Errors that clangd reports but are valid MQL code
- **MQL-specific syntax**: Features that don't exist in standard C++
- **Type system differences**: MQL is more permissive with conversions

**What we DON'T suppress:**
- Logic errors in your code
- Undefined variables (that aren't MQL built-ins)
- Type mismatches that would also fail in MQL
- Most code completion and IntelliSense features

**The trade-off:**
- ✅ You get excellent IntelliSense, code completion, and navigation
- ✅ You avoid hundreds of false-positive errors
- ⚠️ You might miss some edge-case C++ errors (but MetaEditor will catch them during compilation)

**Best practice:** Use both tools together:
- Use VS Code + clangd for editing, navigation, and IntelliSense
- Use MetaEditor for final compilation and testing
- If you see a real error, add it to your `.clangd` suppressions only if it's a false positive and report an issue to this repository.

#### Can I add more diagnostic suppressions?

Yes! If you encounter additional false positives:

1. **Identify the diagnostic code**:
   - Hover over the error in VS Code
   - Look for the diagnostic code in brackets, e.g., `[unknown_typename]` or `[-Wunused-variable]`

2. **Add it to `.clangd`**:
   Open the `.clangd` file in your workspace root and add the code to the `Suppress` list:
   ```yaml
   Diagnostics:
     Suppress:
       # ... existing suppressions
       - your_diagnostic_code_here
   ```

3. **Save and reload**:
   The changes should take effect immediately. If not, reload the VS Code window.

## Preserving Custom Diagnostic Suppressions

The `.clangd` file is generated by the "MQL: Create configuration" command. If you have added custom diagnostic suppressions, you can preserve them when re-running the command.

Configuration option: `mql_tools.Clangd.PreserveSuppressions`
- **prompt** (default): Ask whether to merge suppressions each time
- **always**: Automatically merge existing suppressions
- **never**: Always overwrite the `.clangd` file

When merging, your custom suppressions are combined with the default MQL suppressions without duplicates. Set this in your VS Code settings (`.vscode/settings.json` or global settings):

```json
{
    "mql_tools.Clangd.PreserveSuppressions": "always"
}
```

If set to "prompt", you'll see a choice dialog when an existing `.clangd` is found.