# PRD — Run Backtest via Wine

## Document status
- Status: Draft for next iteration
- Scope: `mql_tools.runBacktest` on macOS/Linux with Wine
- Related current modules: `src/backtestRunner.js`, `src/backtestService.js`, `src/wineHelper.js`, `src/contextMenu.js`

## Summary
The extension already supports Wine for compile and terminal-open flows, but `Run Backtest` still assumes a native Windows launch path. This iteration adds first-class Wine support so a user on macOS/Linux can launch MT5 Strategy Tester from VS Code using a host-side path to the terminal executable and a host-side MQL5 data folder.

The design should reuse the existing Wine helpers and terminal-launch pattern instead of inventing a second launcher.

## Decisions from feasibility review
- `execWineBatch()` should move into `src/wineHelper.js` for this iteration to keep the Wine surface centralized and avoid a premature extra module.
- `startBacktest()` must become `async` because Wine path conversion depends on async `winepath` calls.
- Backtest run tracking should store the Wine launcher PID only (`launcherPid` / `pid`), not claim ownership of the real MT5 PID.
- Wine tester-log discovery should prefer deterministic paths first, then use a bounded fallback scan under the Wine prefix.

## Background and current state
Current backtest behavior:
- discovers EAs from `MQL5/Experts`
- reads per-EA `tester.ini`
- writes effective config to `<MQL5 root>/tester.ini`
- launches MT5 with `/config:<path>`
- monitors Strategy Tester agent logs
- copies the finished log into the EA `runs/` folder

Current limitation:
- `startBacktest()` launches `terminal64.exe` directly with Node `spawn()`
- `findTesterLogDir()` assumes Windows-style tester log resolution via `APPDATA`
- path conversion for Wine is not applied to the terminal path or generated `tester.ini`
- backtest launch does not currently reuse the existing Wine-aware `execWineBatch()` terminal-launch pattern used elsewhere in the extension

## Problem statement
On macOS/Linux, a user can compile with Wine but cannot reliably run a backtest from VS Code. The feature is inconsistent across workflows and forces the user back to the MT5 UI.

## Goals
1. Support `MQL: Run Backtest` on non-Windows platforms when `mql_tools.Wine.Enabled` is `true`.
2. Reuse existing Wine path-conversion and batch-launch helpers.
3. Support both prompted and silent `tester.ini`-driven backtests.
4. Resolve tester logs under a Wine prefix without requiring manual copying.
5. Preserve existing Windows behavior unchanged.
6. Fail fast with actionable error messages when Wine, prefix, terminal path, or tester-log path is invalid.

## Non-goals
- Rewriting the trade report parser or dashboard
- Supporting native macOS terminal execution without Wine
- Guaranteeing hard process-tree termination of MT5 under every Wine variant
- Adding optimization-run orchestration or distributed agents
- Solving every possible portable-install edge case in the first Wine slice

## Primary users
- MQL5 developers on macOS/Linux using MT5 inside Wine
- Users already compiling successfully with Wine and expecting parity for backtests

## User stories
1. As a Wine user, I can run `MQL: Run Backtest` and have MT5 launch through Wine without leaving VS Code.
2. As a Wine user, I can keep my terminal path and include path as host filesystem paths inside the Wine prefix.
3. As a user, I get a clear error if Wine is not installed, the prefix is wrong, or the terminal path is a Windows-style string instead of a host path.
4. As a user, I can still override the tester log directory when auto-detection fails.
5. As a Windows user, nothing changes.

## UX requirements
### Configuration behavior
- On Windows: keep current behavior.
- On non-Windows with `mql_tools.Wine.Enabled=false`: show a clear error that backtest launch requires Wine support on this platform.
- On non-Windows with `mql_tools.Wine.Enabled=true`: use Wine launch mode automatically.

### Error messaging
User-facing errors must distinguish between:
- Wine binary missing
- Wine prefix missing or invalid
- terminal path missing
- terminal path format invalid for Wine
- generated `tester.ini` path conversion failure
- tester log directory not found
- launch failure

### Progress / cancellation
- Keep the same progress notification UX.
- Cancellation remains best-effort.
- If a full process-tree kill cannot be guaranteed under Wine, message this honestly: monitoring is cancelled and MT5 may still be running.

## Functional requirements
### FR1 — Wine-aware backtest launch
When Wine mode is active, the extension must:
1. validate the configured terminal path with `validateWinePath()`
2. derive `wineBinary`, `winePrefix`, and `wineEnv`
3. convert the terminal executable path from host path to Wine Windows path with `toWineWindowsPath()`
4. convert the generated `<MQL5 root>/tester.ini` host path to Wine Windows path
5. launch MT5 through Wine using the same batch-file strategy already used by compile/open-terminal flows

### FR2 — Reuse shared Wine launcher pattern
The implementation must not duplicate ad-hoc Wine command assembly in backtest code.

Chosen approach for this iteration:
- extract the shared batch-launch logic from `contextMenu.js` into `wineHelper.js`

Reasoning:
- keeps Wine-specific process construction in one place
- avoids a premature `wineLauncher.js` split while the helper surface is still small
- matches current project structure and keeps the change set easy to review

The new helper should accept:
- program host path or pre-converted Wine path
- argument list
- Wine binary
- Wine prefix
- environment
- detached/background launch mode
- cleanup delay for temporary batch files

The helper should return process metadata so backtest tracking can keep the launcher PID:
- `proc`
- `pid`
- `batUnixPath` or equivalent cleanup handle

### FR3 — Async launch boundary
Because Wine path conversion is async, backtest launch must support async execution.

Required code change:
- make `startBacktest()` async

Acceptance requirement:
- `runBacktest()` must `await` the launch result before progress monitoring begins.
- `executeBacktest()` must `await startBacktest(...)` before entering the progress loop.
- No fake synchronous wrapper should be introduced around async Wine path conversion.

Implementation note:
- this is the main structural change in the iteration, but it is low-risk because `executeBacktest()` is already async.

### FR4 — Preserve portable mode compatibility
Backtest launch must honor the same MT5 portable-mode switch used by other terminal-launch flows when applicable.

At minimum:
- read the same portable-mode setting used by terminal launch
- pass the portable switch during backtest launch when enabled

### FR5 — Tester log discovery under Wine
`findTesterLogDir()` must support Wine-host paths.

Required resolution strategy:
1. If `mql_tools.Backtest.TesterLogDir` is configured and exists, use it.
2. Otherwise derive candidate tester-log directories from the Wine prefix plus the terminal identity.
3. Prefer deterministic candidates under the Wine prefix using the terminal id, e.g. `drive_c/users/*/AppData/Roaming/MetaQuotes/Tester/<terminalId>/Agent-*/logs`.
4. Do not assume the Wine username matches the host username; support bounded `users/*` scanning.
5. If portable mode is enabled or terminal ID cannot be derived, fall back to a bounded search for `MetaQuotes/Tester/*/Agent-*/logs` candidates and choose the freshest valid directory.

The implementation must avoid a destructive cleanup strategy.

### FR6 — Validation and setup diagnostics
Before launch, Wine mode must validate:
- Wine is installed
- Wine prefix exists
- terminal host path exists
- terminal host path is Unix-style
- MQL5 root exists
- tester log directory is resolved or an actionable override message is shown

### FR7 — Status monitoring remains unchanged
Once MT5 is launched, status monitoring should continue to use the existing log-based completion logic:
- latest tester log discovery
- completion markers (`MetaTester 5 stopped`, deinit/final balance/summary)
- log copy into `runs/`

### FR8 — Backwards compatibility
- Windows behavior must stay identical.
- Existing backtest settings remain valid.
- Deprecated TradeReportServer settings stay deprecated; do not revive them.

## Technical design notes
### Recommended refactor
1. Move or extract `execWineBatch()` from `contextMenu.js` into shared code.
2. Add a Wine-aware launch helper for detached terminal execution.
3. Update `backtestRunner.js` to pass Wine-related launch context.
4. Update `backtestService.js` so launch is async and platform-aware.
5. Extend tester-log resolution to support Wine prefix and portable mode.

### Suggested option shape
Backtest launch options should include:
- `mql5Root`
- `eaName`
- `params`
- `terminalPath`
- `testerLogDir`
- `useWine`
- `wineBinary`
- `winePrefix`
- `wineEnv`
- `portableMode`

### PID semantics
Wine-mode backtests should track the launcher process only.

Required behavior:
- store the spawned Wine-side launcher PID as `launcherPid` (or reuse `pid` with docs/comments that it is the launcher PID)
- do not label it as the MT5 PID
- cancellation and status messaging must describe termination as best-effort under Wine

### Logging
Add structured output-channel lines for:
- launch mode (`windows` vs `wine`)
- resolved tester log directory
- converted terminal/config paths when Wine is active
- launcher PID when available
- completion/cancel outcome

## Risks
1. Wine process cancellation may not terminate the actual MT5 process tree.
2. Portable-mode tester-log placement may differ across Wine installs.
3. Some Wine setups use `wine` instead of `wine64`.
4. Path conversion can fail for unusual prefixes or permissions.

## Mitigations
- treat cancellation as best-effort and message clearly
- support explicit `TesterLogDir` override
- reuse existing Wine binary/prefix config behavior
- keep bounded fallback scans for agent log directories

## Acceptance criteria
1. On macOS/Linux with valid Wine config, `MQL: Run Backtest` launches MT5 and monitors the run to completion.
2. The finished tester log is copied into the EA `runs/` folder.
3. `AutoOpenReport=true` opens the Trade Report after completion.
4. `PromptForParameters=false` still works using `tester.ini` defaults.
5. Invalid Wine config produces actionable errors without hanging.
6. Windows smoke tests continue to pass unchanged.
7. Wine-mode tracking documents and exposes launcher PID semantics clearly; it does not claim a real MT5 PID.

## Test plan
### Automated
- unit tests for Wine-specific tester-log directory resolution
- unit tests for path-validation failures
- unit tests for launch argument construction in Wine mode
- unit tests for portable-mode switch propagation
- regression tests for existing Windows helper behavior

### Manual
- Linux/macOS happy path with valid Wine prefix
- invalid Wine binary
- invalid terminal path format (`C:\...` on host)
- explicit `TesterLogDir` override
- prompted and silent backtest runs
- cancel monitoring during a running test

## Rollout plan
1. Implement shared Wine terminal-launch helper.
2. Make backtest launch async and integrate Wine mode.
3. Add tests.
4. Update README backtest section to remove old TradeReportServer guidance and document Wine backtests.
5. Run focused manual tests on Windows and one Wine environment before release.
