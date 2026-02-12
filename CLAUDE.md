# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

VS Code extension for MQL4/MQL5 development. CommonJS modules, no TypeScript. Integrates with clangd for IntelliSense and MetaEditor for compilation. Cross-platform via Wine (macOS/Linux).

## Commands

```bash
# Lint (preferred — avoids pre-existing rapid-ea/ errors from full npm run lint)
npx eslint src/changedFile.js

# Unit tests (standalone, uses VS Code mock — fast, no VS Code instance needed)
npm run test:unit

# Full tests (launches VS Code test electron — slower)
npm test

# Run unit tests directly with mocha (TDD interface required)
npx mocha --ui tdd test/suite/*.test.js --timeout 10000

# Build for publishing
npm run build

# Watch mode for development
npm run webpack:watch
```

**Note:** `npm run lint` / `npm test` (which runs lint first) will report thousands of pre-existing errors from `rapid-ea/dist/bundle.js`. Lint individual files with `npx eslint src/file.js` instead.

## Architecture

**Hub-and-spoke pattern:** `extension.js` is a thin orchestrator that wires modules in `activate()`. `provider.js` is a re-export hub for language providers.

### Module Responsibilities

| Module | Role |
|---|---|
| `extension.js` | Orchestration only — init, provider registration, file watchers. No business logic. |
| `commands.js` | All `registerCommand` calls. New commands go here. |
| `compiler.js` | Full compilation pipeline: MetaEditor spawning, log parsing (`replaceLog`), diagnostics, auto-check. |
| `wineHelper.js` | All Wine/cross-platform logic. Other modules use `resolveWineConfig()`, `convertPathForWine()`, `spawnDetached()`. |
| `provider.js` | Re-export hub + `ColorProvider`. Individual providers in dedicated files. |
| `hoverProvider.js` | `Hover_log`, `DefinitionProvider`, `Hover_MQL` |
| `completionProvider.js` | `ItemProvider`, `HelpProvider` (signature help) |
| `symbolProvider.js` | `MQLDocumentSymbolProvider` (Outline/Breadcrumbs) |
| `providerUtils.js` | Shared utilities: symbol extraction, include paths, color math |
| `codeActions.js` | `MqlCodeActionProvider` — quick fixes for undeclared identifiers, type errors |
| `compileTargetResolver.js` | Reverse include graph: infers which `.mq4/.mq5` to compile for a `.mqh` header |
| `contextMenu.js` | Context menu handlers (open in MetaEditor, insert include, etc.) |
| `createProperties.js` | Clangd `compile_flags.txt` generator, path utilities |

### Compilation Flow

1. `compile(mode, context)` — mode: 0=check, 1=compile, 2=compile+run script
2. Resolves MQL4/5 flavor from file extension or compile targets
3. Converts paths via `convertPathForWine()` if Wine enabled
4. Spawns MetaEditor (Wine: `wine cmd /c metaeditor.exe /compile:"..." /log:"..."`; Windows: direct spawn with `windowsVerbatimArguments`)
5. Reads log file (UCS-2 encoded), parses with `replaceLog()` using regex constants
6. Publishes diagnostics to VS Code Problems panel, triggers clangd refresh

### Wine Support

Centralized in `wineHelper.js`. Other modules never import `child_process` for Wine.
- `resolveWineConfig(config)` → frozen `{ enabled, binary, prefix, timeout, env }`
- `convertPathForWine()` → `winepath -w` conversion with fallback
- Wine compilation routes through `cmd /c` so Windows' cmd.exe handles path quoting natively
- Only active on non-Windows when `mql_tools.Wine.Enabled = true`

### Compile Target Resolution

For `.mqh` headers, builds a reverse include graph to find which `.mq4/.mq5` files to compile. Cached per workspace folder with dirty-flag invalidation via file watcher.

## Testing

- **Framework:** Mocha with TDD interface (`suite`/`test`, not `describe`/`it`)
- **Mock:** `test/mocks/vscode.js` — comprehensive VS Code API mock with `_tracking` object for assertion on registrations
- **Files:** `logic.test.js` (pure unit tests), `extension.test.js` (activation), `integration.test.js` (providers, commands)
- **Backward compat:** `replaceLog` and `tf` are re-exported from `extension.js` for tests — don't remove

## Key Rules

- **No logic in `extension.js`** — find or create the right module
- **No `child_process` imports** outside `compiler.js` and `wineHelper.js`
- **`provider.js` is a re-export hub** — new providers get their own file and are re-exported
- **New commands** go in `commands.js` via `registerCommands()`, not inline in `activate()`
- **All files start with `'use strict';`**
- **`const` for requires**, grouped: Node built-ins first, then internal modules
- **Regex constants** at module top level with `REG_` prefix
- **Use `fsPromises`** (not callback `fs`) for new file I/O
- **Wrap `spawn()` in try/catch** — it throws synchronously on invalid commands
- **Guard duplicate `error`+`close` events** from child processes with an `errorEmitted` flag
- **Promises wrapping processes must always `resolve()`** — signal failure via `resolve(true)`, never leave hanging
- **Detect `ENOENT`/`EACCES`** on spawn errors for user-friendly messages

## Style

- ESLint: 4-space indent, single quotes (avoidEscape), semicolons required, `no-unused-vars` warn with `_` prefix ignore
- Section headers use `// ===...===` banner comments
