# Workspace Path Resolver

A utility module for resolving user-configured paths that may contain VS Code variable references and relative path components.

## Capabilities

### Expands VS Code variables in path strings

Replaces `${workspaceFolder}` with the actual workspace folder path and `${workspaceFolderBasename}` with its base name. Replacement is case-insensitive.

- `${workspaceFolder}/src` with workspace `/home/user/project` becomes `/home/user/project/src` [@test](./tests/expand_workspace_folder.test.js)
- `${workspaceFolderBasename}` with workspace `/home/user/myproject` becomes `myproject` [@test](./tests/expand_basename.test.js)

### Resolves paths relative to workspace root

After variable expansion, resolves relative paths against the workspace folder. Absolute paths are normalized (resolving `..` segments). Returns the input unchanged if it is not a string.

- A relative path `../MetaEditor64.exe` with workspace `/home/user/MQL5` resolves to `/home/user/MetaEditor64.exe` [@test](./tests/relative_path.test.js)
- An absolute path `/opt/mt5/metaeditor.exe` with any workspace is returned as-is (normalized) [@test](./tests/absolute_path.test.js)

## Implementation

[@generates](./src/index.js)

## API

```javascript { #api }
const path = require('path');

/**
 * Expands ${workspaceFolder} and ${workspaceFolderBasename} in inputPath.
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function expandWorkspaceVariables(inputPath, workspaceFolderPath) {}

/**
 * Resolves a configured path value against the workspace folder.
 * Expands variables, resolves relative paths, normalizes absolute paths.
 * @param {string} inputPath
 * @param {string} workspaceFolderPath
 * @returns {string}
 */
function resolvePathRelativeToWorkspace(inputPath, workspaceFolderPath) {}

module.exports = { expandWorkspaceVariables, resolvePathRelativeToWorkspace };
```

## Dependencies { .dependencies }

### mql-clangd 1.1.24 { .dependency }

High-performance MQL4/MQL5 tools for Visual Studio Code. Provides path resolution utilities used when loading user-configured MetaEditor and include directory paths that may contain workspace variable references.

[@satisfied-by](mql-clangd)
