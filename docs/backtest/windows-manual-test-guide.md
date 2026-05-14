# Windows manual test guide — Run Backtest

## Purpose
This guide validates the current built-in backtest flow on Windows after the TradeReportServer removal.

## Scope
Validates:
- EA discovery
- parameter prompting
- silent run from `tester.ini`
- MT5 launch
- tester log detection
- run log copy into `runs/`
- Trade Report auto-open behavior

## Prerequisites
### Required software
- Windows machine
- VS Code
- this extension loaded from the workspace or packaged VSIX
- MetaTrader 5 installed

### Required extension settings
Set these in workspace or user settings:

```json
{
  "mql_tools.Metaeditor.Include5Dir": "C:/.../MQL5",
  "mql_tools.Terminal.Terminal5Dir": "C:/.../terminal64.exe",
  "mql_tools.Backtest.PromptForParameters": true,
  "mql_tools.Backtest.AutoOpenReport": true
}
```

Notes:
- `Include5Dir` must point to the MQL5 data folder containing `Experts`.
- `Terminal5Dir` must point to `terminal64.exe`.
- Only set `mql_tools.Backtest.TesterLogDir` if auto-detection fails.

### Required EA fixture
Pick or create one EA folder under `MQL5/Experts/<YourEA>/` with:
- `<YourEA>.mq5`
- `tester.ini`
- optional existing `runs/`

You can copy the template from `docs/backtest/artifacts/tester.ini.example` and adjust symbol/date values.

## Recommended pre-test setup
1. Close running MT5 terminals if possible.
2. Ensure the target EA compiles and appears under `MQL5/Experts`.
3. Delete only disposable old logs from that EA's `runs/` folder if you want a cleaner assertion.
4. Keep VS Code Output and Notifications visible.

## Test case 1 — Happy path with parameter prompts
1. Open a file belonging to the target EA:
   - `.mq5`, or
   - `.mqh` that resolves to the EA via compile-target logic.
2. Run `MQL: Run Backtest`.
3. If the EA is not auto-resolved, choose it from the Quick Pick.
4. Select a symbol.
5. Enter a valid `From date` in `YYYY.MM.DD` format.
6. Enter a valid `To date` in `YYYY.MM.DD` format.
7. Wait for the progress notification.
8. Wait for MT5 Strategy Tester to finish.

Expected results:
- no TradeReportServer error appears
- MT5 launches automatically
- progress notification shows elapsed seconds
- after completion, a new `.log` file is copied into `MQL5/Experts/<YourEA>/runs/`
- if `AutoOpenReport=true`, the Trade Report opens automatically

## Test case 2 — Silent mode from `tester.ini`
1. Set `"mql_tools.Backtest.PromptForParameters": false`.
2. Ensure the EA `tester.ini` contains `Symbol`, `FromDate`, and `ToDate`.
3. Run `MQL: Run Backtest` again.

Expected results:
- no prompt for symbol/date appears
- MT5 launches directly
- run completes and creates a fresh log in `runs/`

## Test case 3 — EA discovery without prior runs
1. Use an EA folder that has `tester.ini` but no `runs/` folder yet.
2. Run `MQL: Run Backtest`.

Expected results:
- the EA appears in the selection list
- the run still starts successfully
- the `runs/` folder is created automatically when the log is copied

## Test case 4 — Auto-open report disabled
1. Set `"mql_tools.Backtest.AutoOpenReport": false`.
2. Run a backtest to completion.

Expected results:
- run finishes normally
- a log is copied into `runs/`
- Trade Report does not auto-open
- you can still open it manually with `MQL: Open Trade Report Dashboard`

## Test case 5 — Manual tester-log override
Run this only if auto-detection fails.

1. Find the Strategy Tester agent log folder used by your MT5 terminal.
2. Set `"mql_tools.Backtest.TesterLogDir"` to that folder.
3. Run `MQL: Run Backtest` again.

Expected results:
- the backtest starts without the "Strategy Tester agent log directory not found" error
- completion is detected and the log is copied into `runs/`

## Test case 6 — Cancel from the progress UI
1. Start a backtest.
2. Cancel it from the VS Code progress notification before it finishes.

Expected results:
- VS Code shows either:
  - `Backtest for <EA> was cancelled.`, or
  - `Backtest monitor was cancelled. The test may still be running in MT5.`
- the extension should not crash
- behavior is best-effort; MT5 may still be running depending on timing

## Negative checks
### Missing `tester.ini`
Expected:
- `Failed to start backtest: No tester.ini found in EA folder`

### Invalid silent defaults
With `PromptForParameters=false` and missing/invalid dates in `tester.ini`:
- expected clear validation error
- backtest should not launch

### Missing terminal path
With bad `Terminal5Dir`:
- expected error telling you to configure `mql_tools.Terminal.Terminal5Dir`

### Missing MQL5 root
With bad `Include5Dir`:
- expected error telling you to configure `mql_tools.Metaeditor.Include5Dir`

## What to capture during testing
Record these for each run:
- active EA name
- symbol and date range
- whether prompts were enabled
- whether MT5 launched
- whether a new log appeared in `runs/`
- whether Trade Report auto-opened
- any notification/error text

## Pass criteria
The Windows smoke test passes if:
1. a backtest can be launched from VS Code without TradeReportServer
2. completion is detected from tester logs
3. the finished log is copied into the EA `runs/` folder
4. auto-open behavior matches the setting
5. failure cases show actionable messages
