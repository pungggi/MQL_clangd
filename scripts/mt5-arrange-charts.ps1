# Arrange MetaTrader 5 chart windows.
#
# Two independent groups, detected automatically:
#
#   DOCKED charts   = immediate children of MDIClient. Confined inside the MT5
#                     main window, so they are tiled into a grid there (and the
#                     main window is moved to the docked monitor first).
#
#   FLOATING charts = top-level windows owned by the main window whose title
#                     looks like "SYMBOL,TIMEFRAME" (e.g. MESU26,M5). When a
#                     chart is undocked it leaves MDIClient and becomes such a
#                     window, free to sit on ANY monitor. These are tiled onto
#                     the floating monitor in absolute screen coordinates.
#
# Charts are never matched by window class: the class embeds the process
# HINSTANCE (ASLR-randomised per launch). Docked = MDIClient child; floating =
# title pattern. Panels (Market Watch / Navigator / Toolbox) have non-chart
# titles and are skipped.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File mt5-arrange-charts.ps1 `
#       -DockMonitor 2 -DockRows 2 -DockCols 4 `
#       -FloatMonitor 1 -FloatRows 2 -FloatCols 2 -Gap 0
#
# Set -FloatMonitor 0 (default) to leave floating charts untouched.
param(
    [int]$DockMonitor  = 1,    # 1-based, System.Windows.Forms.Screen.AllScreens order
    [int]$DockRows     = 2,
    [int]$DockCols     = 2,
    [string]$DockAreas = "",   # grid-template-areas, rows joined by '|' (overrides rows/cols)
    [int]$FloatMonitor = 0,    # 0 = skip floating charts entirely
    [int]$FloatRows    = 1,
    [int]$FloatCols    = 1,
    [string]$FloatAreas = "",
    [int]$Gap          = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$GW_HWNDNEXT = 2
$GW_OWNER    = 4
$GW_CHILD    = 5
$SW_MINIMIZE = 6
$SW_RESTORE  = 9
$SWP_NOZ     = 0x0004 -bor 0x0010   # NOZORDER | NOACTIVATE
# MT5 standard timeframe suffixes -> identifies a chart title "SYMBOL,TF".
$TF_RE   = ',(M1|M2|M3|M4|M5|M6|M10|M12|M15|M20|M30|H1|H2|H3|H4|H6|H8|H12|D1|W1|MN1)$'
# Same set, as a whole token -> used to detect timeframe-named area cells.
$TF_BARE = '^(M1|M2|M3|M4|M5|M6|M10|M12|M15|M20|M30|H1|H2|H3|H4|H6|H8|H12|D1|W1|MN1)$'

function Fail($msg) { "ERROR $msg"; exit 1 }
function TitleOf([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][Win]::GetWindowText($h,$sb,256); $sb.ToString() }
# A chart title is "SYMBOL,TF"; split on the last comma.
function SymbolOf($title) { $i = $title.LastIndexOf(','); if ($i -ge 0) { $title.Substring(0, $i) } else { $title } }
function TfOf($title)     { $i = $title.LastIndexOf(','); if ($i -ge 0) { $title.Substring($i + 1) } else { "" } }

# Tile $hwnds into a rows x cols grid inside the box (x0,y0,W,H). Coordinates are
# whatever MoveWindow expects for those windows: client-relative for MDI children,
# screen for top-level. Charts beyond rows*cols are minimized so they never
# overlap the grid. Returns the number placed into cells.
function Tile($hwnds, $x0, $y0, $W, $H, $rows, $cols, $gap) {
    $cellW = [int][Math]::Floor(($W - $gap * ($cols + 1)) / $cols)
    $cellH = [int][Math]::Floor(($H - $gap * ($rows + 1)) / $rows)
    if ($cellW -le 0 -or $cellH -le 0) { Fail "grid ${rows}x${cols} too dense for ${W}x${H}" }
    $cells = $rows * $cols
    $n = 0
    for ($i = 0; $i -lt $hwnds.Count; $i++) {
        if ($i -ge $cells) {
            [void][Win]::ShowWindow($hwnds[$i], $SW_MINIMIZE)   # extra chart: tuck away
            continue
        }
        $r = [int][Math]::Floor($i / $cols)
        $c = $i % $cols
        $x = $x0 + $gap + $c * ($cellW + $gap)
        $y = $y0 + $gap + $r * ($cellH + $gap)
        [void][Win]::ShowWindow($hwnds[$i], $SW_RESTORE)
        [void][Win]::MoveWindow($hwnds[$i], $x, $y, $cellW, $cellH, $true)
        $n++
    }
    return $n
}

# Move one chart into region $e = @(minR,maxR,minC,maxC) of the unit grid.
function PlaceRegion($h, $e, $x0, $y0, $colX, $rowY, $gap) {
    $x = $x0 + $colX[$e[2]] + $gap
    $y = $y0 + $rowY[$e[0]] + $gap
    $w = ($colX[$e[3] + 1] - $colX[$e[2]]) - 2 * $gap
    $hgt = ($rowY[$e[1] + 1] - $rowY[$e[0]]) - 2 * $gap
    if ($w -le 0 -or $hgt -le 0) { Fail "areas grid too dense at gap $gap" }
    [void][Win]::ShowWindow($h, $SW_RESTORE)
    [void][Win]::MoveWindow($h, $x, $y, $w, $hgt, $true)
}

# Place $charts (objects with H/Symbol/Tf, pre-sorted by Title) using a CSS
# grid-template-areas template: $areasStr is rows joined by '|', cells within a
# row separated by whitespace. A repeated cell name forms a rectangular region
# spanning those cells (any direction); '.' is an empty cell.
#
# If every region name is a timeframe (M5, H1, ...), TIMEFRAME-MATCH mode binds
# the layout to one symbol ($activeSymbol, fallback first symbol): each region
# gets that symbol's chart for its timeframe; all other charts are minimized.
# Otherwise ORDER-FILL: charts fill regions in reading order; extras minimized.
# Returns the number placed.
function TileAreas($charts, $activeSymbol, $x0, $y0, $W, $H, $areasStr, $gap) {
    $grid = @()
    foreach ($row in ($areasStr -split '\|')) {
        $cells = @($row.Trim() -split '\s+' | Where-Object { $_ -ne '' })
        if ($cells.Count -gt 0) { $grid += ,$cells }
    }
    $nRows = $grid.Count
    if ($nRows -eq 0) { Fail "empty areas template" }
    $nCols = $grid[0].Count
    foreach ($g in $grid) { if ($g.Count -ne $nCols) { Fail "areas rows must all have $nCols columns" } }

    # Pixel boundaries per column/row edge (rounding-safe; no cumulative drift).
    $colX = 0..$nCols | ForEach-Object { [int][Math]::Round($_ * $W / $nCols) }
    $rowY = 0..$nRows | ForEach-Object { [int][Math]::Round($_ * $H / $nRows) }

    # Discover regions in reading order; track each one's bounding box.
    $order = New-Object System.Collections.Generic.List[string]
    $ext = @{}   # name -> @(minR, maxR, minC, maxC)
    for ($r = 0; $r -lt $nRows; $r++) {
        for ($c = 0; $c -lt $nCols; $c++) {
            $t = $grid[$r][$c]
            if ($t -eq '.') { continue }
            if (-not $ext.ContainsKey($t)) { $order.Add($t); $ext[$t] = @($r, $r, $c, $c) }
            else {
                $e = $ext[$t]
                if ($r -lt $e[0]) { $e[0] = $r }; if ($r -gt $e[1]) { $e[1] = $r }
                if ($c -lt $e[2]) { $e[2] = $c }; if ($c -gt $e[3]) { $e[3] = $c }
                $ext[$t] = $e
            }
        }
    }
    # Each region must be a filled rectangle (no gaps / L-shapes).
    foreach ($t in $order) {
        $e = $ext[$t]
        for ($r = $e[0]; $r -le $e[1]; $r++) {
            for ($c = $e[2]; $c -le $e[3]; $c++) {
                if ($grid[$r][$c] -ne $t) { Fail "area '$t' is not rectangular" }
            }
        }
    }

    # Timeframe-match mode when every region name is a bare timeframe.
    $tfMode = $order.Count -gt 0
    foreach ($name in $order) { if ($name -notmatch $TF_BARE) { $tfMode = $false; break } }

    $n = 0
    if ($tfMode) {
        # Bind to the active chart's symbol; if it isn't present in this group
        # (e.g. the active chart lives in the other group, or was closed), fall
        # back to the first symbol here so we don't minimize the whole group.
        $sym = $activeSymbol
        if (-not $sym -or -not ($charts | Where-Object { $_.Symbol -eq $sym })) {
            $sym = ($charts | Sort-Object Symbol | Select-Object -First 1).Symbol
        }
        $placed = New-Object System.Collections.Generic.List[IntPtr]
        foreach ($name in $order) {
            $match = $charts | Where-Object { $_.Symbol -eq $sym -and $_.Tf -eq $name } | Select-Object -First 1
            if ($match) {
                PlaceRegion $match.H $ext[$name] $x0 $y0 $colX $rowY $gap
                [void]$placed.Add($match.H); $n++
            }
        }
        foreach ($ch in $charts) { if (-not $placed.Contains($ch.H)) { [void][Win]::ShowWindow($ch.H, $SW_MINIMIZE) } }
    }
    else {
        for ($i = 0; $i -lt $charts.Count; $i++) {
            if ($i -ge $order.Count) { [void][Win]::ShowWindow($charts[$i].H, $SW_MINIMIZE); continue }
            PlaceRegion $charts[$i].H $ext[$order[$i]] $x0 $y0 $colX $rowY $gap
            $n++
        }
    }
    return $n
}

# --- monitors ---
$screens = [System.Windows.Forms.Screen]::AllScreens
function WorkArea($n) {
    if ($n -lt 1 -or $n -gt $screens.Count) { Fail "monitor $n out of range (1..$($screens.Count))" }
    return $screens[$n - 1].WorkingArea
}
$dockWa = WorkArea $DockMonitor

# --- MT5 main window ---
$proc = Get-Process -Name terminal64 -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Fail "MT5 (terminal64) not running" }
$main = $proc.MainWindowHandle
$mainPid = [uint32]$proc.Id
# MT5's title ends with the active chart's "SYMBOL,TF" -> use that symbol as the
# primary for timeframe-match layouts. (Empty -> TileAreas falls back to first.)
$activeChart = (@(((TitleOf $main) -split ' - ')))[-1]
$activeSymbol = (@($activeChart -split ','))[0].Trim()

# --- DOCKED group: move main to its monitor, tile MDIClient children ---
[void][Win]::ShowWindow($main, $SW_RESTORE)
[void][Win]::SetWindowPos($main, [IntPtr]::Zero, $dockWa.X, $dockWa.Y, $dockWa.Width, $dockWa.Height, $SWP_NOZ)
Start-Sleep -Milliseconds 250   # let MT5 resize MDIClient

$mdi = [Win]::FindWindowEx($main, [IntPtr]::Zero, "MDIClient", $null)
if ($mdi -eq [IntPtr]::Zero) { Fail "MDIClient not found" }

$docked = @()
$child = [Win]::GetWindow($mdi, $GW_CHILD)
while ($child -ne [IntPtr]::Zero) {
    $t = TitleOf $child
    $docked += [pscustomobject]@{ H = $child; Title = $t; Symbol = (SymbolOf $t); Tf = (TfOf $t) }
    $child = [Win]::GetWindow($child, $GW_HWNDNEXT)
}
$dockedSorted = @($docked | Sort-Object Title)
$dockTotal = $dockedSorted.Count
$cr = New-Object Win+RECT
[void][Win]::GetClientRect($mdi, [ref]$cr)
$dockPlaced = 0
if ($dockTotal -gt 0) {
    if ($DockAreas) {
        $dockPlaced = TileAreas $dockedSorted $activeSymbol 0 0 ($cr.Right - $cr.Left) ($cr.Bottom - $cr.Top) $DockAreas $Gap
    } else {
        $dockedH = @($dockedSorted | ForEach-Object { $_.H })
        $dockPlaced = Tile $dockedH 0 0 ($cr.Right - $cr.Left) ($cr.Bottom - $cr.Top) $DockRows $DockCols $Gap
    }
}

# --- FLOATING group: top-level, owned by main, chart-titled ---
$floatPlaced = 0
$floatTotal = 0
if ($FloatMonitor -ge 1) {
    $fWa = WorkArea $FloatMonitor
    $script:floats = New-Object System.Collections.Generic.List[object]
    $cb = [Win+EnumProc]{
        param($h, $l)
        $wpid = [uint32]0
        [void][Win]::GetWindowThreadProcessId($h, [ref]$wpid)
        if ($wpid -eq $mainPid -and [Win]::IsWindowVisible($h) -and ([Win]::GetWindow($h, $GW_OWNER) -eq $main)) {
            $t = TitleOf $h
            if ($t -match $TF_RE) { $script:floats.Add([pscustomobject]@{ H = $h; Title = $t; Symbol = (SymbolOf $t); Tf = (TfOf $t) }) }
        }
        return $true
    }
    [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
    $floatSorted = @($script:floats | Sort-Object Title)
    $floatTotal = $floatSorted.Count
    if ($floatTotal -gt 0) {
        if ($FloatAreas) {
            $floatPlaced = TileAreas $floatSorted $activeSymbol $fWa.X $fWa.Y $fWa.Width $fWa.Height $FloatAreas $Gap
        } else {
            $floatHa = @($floatSorted | ForEach-Object { $_.H })
            $floatPlaced = Tile $floatHa $fWa.X $fWa.Y $fWa.Width $fWa.Height $FloatRows $FloatCols $Gap
        }
    }
}

$dockLabel = if ($DockAreas) { "areas" } else { "${DockRows}x${DockCols}" }
$msg = "OK docked $dockPlaced/$dockTotal on mon $DockMonitor ($dockLabel)"
if (($dockTotal - $dockPlaced) -gt 0) { $msg += " ($($dockTotal - $dockPlaced) minimized)" }
if ($FloatMonitor -ge 1) {
    $floatLabel = if ($FloatAreas) { "areas" } else { "${FloatRows}x${FloatCols}" }
    $msg += "; floating $floatPlaced/$floatTotal on mon $FloatMonitor ($floatLabel)"
    if (($floatTotal - $floatPlaced) -gt 0) { $msg += " ($($floatTotal - $floatPlaced) minimized)" }
}
$msg
