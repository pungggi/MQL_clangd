# Compile Targets for Header Files

When compiling or checking a `.mqh` header file, MetaEditor requires a "root" `.mq4`/`.mq5` file as the compilation entry point. This is because header files cannot be compiled standalone. The extension resolves the correct target automatically.

## Resolution Priority

The extension resolves compile targets in this order:

1. **Saved mapping** — Previously selected target stored per `CompileTarget.Storage` setting
2. **Automatic inference** — Reverse include graph scan to find which `.mq5`/`.mq4` files include this header
3. **Magic comment** (legacy fallback) — `//###<path/to/file.mq5>` on line 0 of the `.mqh` file
4. **Direct check** — For `rt=0` (check only), falls back to checking the header itself

---

## Using the Commands

### Manually Selecting a Target { .api }

```javascript
// Trigger the target selector UI
vscode.commands.executeCommand('mql_tools.selectCompileTarget');
// Shows QuickPick of all .mq4/.mq5 files in workspace
// For .mqh files only; shows error for other file types
```

### Resetting Targets { .api }

```javascript
// Reset for active .mqh only
vscode.commands.executeCommand('mql_tools.resetCompileTarget');

// Reset all stored mappings (prompts for confirmation)
vscode.commands.executeCommand('mql_tools.resetAllCompileTargets');
```

---

## Storage Modes

Configure `mql_tools.CompileTarget.Storage` to choose where mappings are saved:

### `workspaceState` (default) { .api }

Stored in VS Code's workspace state (per-user, per-workspace). Not visible in `.vscode/settings.json`. Does not affect other users.

```jsonc
{
    "mql_tools.CompileTarget.Storage": "workspaceState"
}
```

### `globalState` { .api }

Stored in VS Code's global state. Available across all workspaces on the same machine for the same user.

```jsonc
{
    "mql_tools.CompileTarget.Storage": "globalState"
}
```

### `workspaceSettings` { .api }

Stored in `.vscode/settings.json` under `mql_tools.CompileTarget.Map`. Shared with team via version control.

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

## Multi-Target Compilation { .api }

When `mql_tools.CompileTarget.AllowMultiSelect` is `true` (default), multiple targets can be selected for a single header file. Compiling the header will compile all mapped targets sequentially.

```jsonc
{
    "mql_tools.CompileTarget.AllowMultiSelect": true,
    "mql_tools.CompileTarget.Map": {
        "Include/SharedLib.mqh": [
            "Experts/EA_v1.mq5",
            "Experts/EA_v2.mq5",
            "Indicators/MyIndicator.mq5"
        ]
    }
}
```

---

## Automatic Inference

When no saved mapping exists, the extension scans the workspace to find files that include the header. It builds a "reverse include graph" by searching all `.mq4`/`.mq5`/`.mqh` files for `#include` statements.

```jsonc
{
    // Maximum files to scan (reduce for large workspaces)
    "mql_tools.CompileTarget.InferMaxFiles": 5000
}
```

If multiple `.mq5` files include the header, the extension shows a QuickPick to select which ones to use for compilation.

If `rt=0` (check-only) and inference finds no targets and no user selection was made, the header is checked directly.

---

## Legacy Magic Comment { .api }

For backward compatibility, a magic comment on the first line of a `.mqh` file specifies the compile target:

```mql5
//###<Experts/MyEA.mq5>

// Rest of the header...
#property strict
```

Insert via `mql_tools.InsNameMQL` command (`mql_tools.InsMQL` to browse for the file).

This legacy mechanism is only used when no saved mapping and no inferred targets are found.

---

## Configuration Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mql_tools.CompileTarget.Storage` | enum | `"workspaceState"` | Storage location for mappings |
| `mql_tools.CompileTarget.AllowMultiSelect` | boolean | `true` | Allow multiple targets per header |
| `mql_tools.CompileTarget.InferMaxFiles` | number | `5000` | Max files for inference scan |
| `mql_tools.CompileTarget.Map` | object | `{}` | Manual mapping (workspaceSettings mode) |
