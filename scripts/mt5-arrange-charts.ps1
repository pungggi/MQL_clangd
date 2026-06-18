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
    [int]$FloatMonitor = 0,    # 0 = skip floating charts entirely
    [int]$FloatRows    = 1,
    [int]$FloatCols    = 1,
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
$SW_RESTORE  = 9
$SWP_NOZ     = 0x0004 -bor 0x0010   # NOZORDER | NOACTIVATE
# MT5 standard timeframe suffixes -> identifies a chart title "SYMBOL,TF".
$TF_RE = ',(M1|M2|M3|M4|M5|M6|M10|M12|M15|M20|M30|H1|H2|H3|H4|H6|H8|H12|D1|W1|MN1)$'

function Fail($msg) { "ERROR $msg"; exit 1 }
function TitleOf([IntPtr]$h) { $sb = New-Object System.Text.StringBuilder 256; [void][Win]::GetWindowText($h,$sb,256); $sb.ToString() }

# Tile $hwnds into a rows x cols grid inside the box (x0,y0,W,H). Coordinates are
# whatever MoveWindow expects for those windows: client-relative for MDI children,
# screen for top-level. Returns the number placed.
function Tile($hwnds, $x0, $y0, $W, $H, $rows, $cols, $gap) {
    $cellW = [int][Math]::Floor(($W - $gap * ($cols + 1)) / $cols)
    $cellH = [int][Math]::Floor(($H - $gap * ($rows + 1)) / $rows)
    if ($cellW -le 0 -or $cellH -le 0) { Fail "grid ${rows}x${cols} too dense for ${W}x${H}" }
    $cells = $rows * $cols
    $n = 0
    for ($i = 0; $i -lt $hwnds.Count -and $i -lt $cells; $i++) {
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

# --- DOCKED group: move main to its monitor, tile MDIClient children ---
[void][Win]::ShowWindow($main, $SW_RESTORE)
[void][Win]::SetWindowPos($main, [IntPtr]::Zero, $dockWa.X, $dockWa.Y, $dockWa.Width, $dockWa.Height, $SWP_NOZ)
Start-Sleep -Milliseconds 250   # let MT5 resize MDIClient

$mdi = [Win]::FindWindowEx($main, [IntPtr]::Zero, "MDIClient", $null)
if ($mdi -eq [IntPtr]::Zero) { Fail "MDIClient not found" }

$docked = @()
$child = [Win]::GetWindow($mdi, $GW_CHILD)
while ($child -ne [IntPtr]::Zero) {
    $docked += [pscustomobject]@{ H = $child; Title = (TitleOf $child) }
    $child = [Win]::GetWindow($child, $GW_HWNDNEXT)
}
$dockedH = @($docked | Sort-Object Title | ForEach-Object { $_.H })
$cr = New-Object Win+RECT
[void][Win]::GetClientRect($mdi, [ref]$cr)
$dockPlaced = 0
if ($dockedH.Count -gt 0) {
    $dockPlaced = Tile $dockedH 0 0 ($cr.Right - $cr.Left) ($cr.Bottom - $cr.Top) $DockRows $DockCols $Gap
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
            if ($t -match $TF_RE) { $script:floats.Add([pscustomobject]@{ H = $h; Title = $t }) }
        }
        return $true
    }
    [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
    $floatH = @($script:floats | Sort-Object Title | ForEach-Object { $_.H })
    $floatTotal = $floatH.Count
    if ($floatTotal -gt 0) {
        $floatPlaced = Tile $floatH $fWa.X $fWa.Y $fWa.Width $fWa.Height $FloatRows $FloatCols $Gap
    }
}

$msg = "OK docked $dockPlaced/$($dockedH.Count) on mon $DockMonitor (${DockRows}x${DockCols})"
if ($FloatMonitor -ge 1) { $msg += "; floating $floatPlaced/$floatTotal on mon $FloatMonitor (${FloatRows}x${FloatCols})" }
$msg
