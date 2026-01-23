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
| Clean compilation not necessary to open MetaEditor | ❌ | ✅ |
| Smart Compile Target for Headers | ❌ | ✅ |
| Wine Support (macOS/Linux) | Limited | **Full** |
| Document Symbols (Outline, Breadcrumbs) | ❌ | ✅ |

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
*   **Automatic Configuration**: When you run the `"MQL: Create configuration"` command, the extension automatically configures `clangd` with the correct include paths and compiler flags for your MQL version (MQL4 or MQL5).
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
       "mql_tools.Metaeditor.Metaeditor5Dir": "${workspaceFolder}/../drive_c/Program Files/MetaTrader 5/MetaEditor64.exe"   }
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