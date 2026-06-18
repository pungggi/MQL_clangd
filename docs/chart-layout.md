# Arrange MT5 Charts

Tile your MetaTrader 5 chart windows into a saved layout with one command. Snap docked charts into a grid inside the terminal, and spread undocked charts across other monitors.

> ⚠️ **Windows only (for now).** This feature moves native MT5 windows through the Win32 API. On macOS / Linux (including Wine) the command does nothing.

## Quick start

1. Open MT5 with the charts you want.
2. In VS Code: **Ctrl+Shift+P** → **MQL: Arrange MT5 Charts**.
3. Pick a preset. Charts snap into place.

**Faster:** click the **Charts** button in the status bar (bottom-right) to open the same picker — its label shows the last layout you applied. Hide it with `mql_tools.ChartLayout.ShowStatusBarButton`.

A notification reports what moved, e.g. `Charts arranged — docked 6/6 on mon 2 (2×3); floating 2/2 on mon 1 (1×2)`.

## Two groups: docked vs floating

The command handles two kinds of chart window, detected automatically:

| Group        | What it is                                            | Where it goes                                                                   |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Docked**   | Charts living inside the MT5 window (the default).    | Tiled into a grid inside MT5. The MT5 window moves to the docked monitor first. |
| **Floating** | Charts you **undocked** — now free top-level windows. | Tiled onto any other monitor you choose.                                        |

A docked chart cannot leave the MT5 window. To place a chart on a different monitor, **undock it first**.

### Undock a chart

Right-click the register of the chart → uncheck **Docked** (Alt+R menu also lists it). The chart pops out as its own window. Drag it to any monitor. Re-running the command then tiles it via the preset's `floating` grid.

Undock state is not saved by this command. To keep it across restarts, arrange once then save an MT5 **profile** (_File → Profiles → Save As_). Loading that profile restores the undocked windows; run this command to re-tile them.

## Monitor numbers

Monitors are numbered 1-based in Windows enumeration order — the same order the command uses. The number is shown in each preset's description in the picker. If a layout lands on the wrong screen, swap the `monitor` value.

## Configure presets

Presets live in `settings.json` under `mql_tools.ChartLayout.Presets` — one list used by **both** the command and the status-bar button (which shows every preset in its picker). Each has a required `docked` grid and an optional `floating` grid.

Edit them via **Settings UI** (`Ctrl+,` → search `ChartLayout` → *Edit in settings.json*) or directly in `settings.json`. Changes apply on the next click — no reload needed.

```jsonc
"mql_tools.ChartLayout.Presets": [
  // All charts docked, tiled 2×4 inside MT5 on the ultrawide.
  { "name": "wall", "docked": { "monitor": 2, "rows": 2, "cols": 4 }, "gap": 0 },

  // Docked charts 2×3 on the ultrawide; undocked charts side-by-side on the primary.
  {
    "name": "split",
    "docked":   { "monitor": 2, "rows": 2, "cols": 3 },
    "floating": { "monitor": 1, "rows": 1, "cols": 2 },
    "gap": 4
  },

  // One big chart, primary monitor.
  { "name": "focus", "docked": { "monitor": 1, "rows": 1, "cols": 1 } }
]
```

| Field                         | Meaning                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `name`                        | Label in the picker.                                                          |
| `docked.monitor`              | Monitor the MT5 window moves to (1-based).                                    |
| `docked.rows` / `docked.cols` | Grid for docked charts.                                                       |
| `floating`                    | Same shape, for undocked charts on another monitor. Omit to leave them alone. |
| `gap`                         | Pixels between and around cells. Default `0`.                                 |

Match `rows × cols` to your chart count. Any **extra charts beyond the grid's cells are minimized** (tucked to the bottom) so they never overlap the grid — the notification reports how many, e.g. `docked 6/7 (1 minimized)`. Restore them from MT5's window list, or pick a preset with more cells.

## Spanning layouts (`areas`)

For non-uniform layouts — one chart wider or taller than the rest — use `areas` instead of `rows`/`cols`. It's CSS `grid-template-areas`: one string per row, cell names separated by spaces. Repeat a name so that chart **spans** those cells (any direction); `.` is an empty cell.

```jsonc
{
  "name": "tall-right",
  "docked": {
    "monitor": 2,
    "areas": [
      "A A B",
      "C C B"
    ]
  }
}
```

- `A` → top, spans 2 columns
- `B` → right column, **spans both rows** (tall)
- `C` → bottom, spans 2 columns

Rules:

- Every row must have the same number of cells.
- Each name must form a **filled rectangle** (no L-shapes or gaps), else the run errors with `area 'X' is not rectangular`.
- Charts fill regions in reading order (top-left → right → down), sorted by title.
- `areas` overrides `rows`/`cols`, and works for both `docked` and `floating`.

### Match charts by timeframe + symbol

If **every area name is a timeframe** (`M5`, `H1`, `M15`, …), the layout stops filling by order and instead places charts by meaning, bound to one symbol:

```jsonc
"docked": {
  "monitor": 2,
  "areas": [
    "M5  M5  H1",
    "M15 M15 H1"
  ]
}
```

- **Primary symbol** = the **active chart's symbol** (the one in MT5's title bar). Each region gets that symbol's chart for its timeframe.
- Charts of **other symbols**, and any timeframe not in the layout, are **minimized** — leaving a consistent single-symbol wall.
- A region whose timeframe has no open chart stays empty.
- Want a different symbol? Activate one of its charts, re-run → same shape, new symbol.

Standard timeframe tokens: `M1 M2 M3 M4 M5 M6 M10 M12 M15 M20 M30 H1 H2 H3 H4 H6 H8 H12 D1 W1 MN1`.

## Tips

- **All on one screen:** size the docked grid to your chart count (8 charts → `2×4`). No `floating` block needed.
- **Spread across screens:** undock the charts you want elsewhere, add a `floating` block on that monitor.
- **Charts are matched by title** (`SYMBOL,TIMEFRAME`), so order is stable across runs. Panels (Market Watch, Navigator, Toolbox) are never touched.

## Limits

- **Windows only.** It moves native MT5 windows via the Win32 API. Under Wine it does nothing.
- **First MT5 instance.** If several `terminal64` processes run, it targets the first one.
- **Uniform display scaling.** Positioning assumes the same DPI/scaling across monitors. On a mixed-scaling setup (e.g. 100% + 150%) charts may land slightly off; set the target monitors to the same scale.
- **No auto-undock.** MT5 exposes no reliable way to toggle a chart's dock state from outside, so you undock manually (or via a saved profile). This command only _positions_ windows.

## Troubleshooting

| Message                        | Cause / fix                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `MT5 (terminal64) not running` | Start MetaTrader 5 first.                                                                                    |
| `monitor N out of range`       | Fewer monitors than the preset expects. Lower the `monitor` number.                                          |
| `grid RxC too dense`           | Too many cells for the screen area. Use fewer rows/cols or a bigger monitor.                                 |
| `area 'X' is not rectangular`  | An `areas` cell name doesn't form a filled rectangle. Make each region a solid block.                        |
| Floating charts not moving     | They must be undocked (top-level) and titled `SYMBOL,TF`. Confirm the chart is popped out, not just resized. |
