# Compile a MQL4/MQL5 file through the MetaEditor GUI ("Compile MQL file using script").
#
# Why this worker exists
#   MetaTrader reloads a running EA/indicator only after a compile that went
#   through the MetaEditor UI (the program is re-initialised with
#   REASON_RECOMPILE). A command-line compile (metaeditor64.exe /compile:...)
#   rewrites the .ex4/.ex5, but the programs on the charts keep running the
#   previous build. This worker restores the original MQL Tools behaviour of the
#   command (MQL_clangd#77): open the file in MetaEditor and press Compile there.
#
# How it works
#   1. Remembers the current foreground window.
#   2. Starts MetaEditor with the source file as a bare argument (GUI mode, no
#      /compile), detached from this console.
#   3. Waits (bounded) for a MetaEditor window whose title shows the file
#      ("MetaEditor - [Name.mq5]"). MetaEditor is single-instance: when it is
#      already running, the new process hands the file to the running instance
#      and exits without a window, so the target is found by title, never by the
#      PID started here.
#   4. Posts F7 (Compile) straight to that window with PostMessage. No
#      activation is needed, so this also works while MetaEditor sits behind
#      other windows.
#   5. Focus: if MetaEditor's launch made it the foreground window, the window
#      from step 1 is activated again so the user keeps working where they were
#      (VS Code). If the user already moved to another window, nothing is touched.
#   6. Waits (bounded) for the compiled .ex4/.ex5 next to the source to be
#      rewritten, as confirmation that the GUI compile really ran.
#   7. MetaEditor stays open: the final compile log is in its Toolbox window.
#
# Output protocol: the last stdout line is the result, exit code 0 only for OK.
#   OK compiled   pid=<n> window-ms=<n> bin-ms=<n> focus=<none|restored|kept>
#   OK triggered  pid=<n> window-ms=<n> bin-ms=-1 focus=<...>
#   ERROR <reason>
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File metaeditor-gui-compile.ps1 `
#       -MetaEditor "C:\Program Files\MetaTrader 5\metaeditor64.exe" `
#       -SourceFile "C:\Users\me\AppData\Roaming\MetaQuotes\Terminal\<id>\MQL5\Experts\MyEA.mq5"
param(
    [Parameter(Mandatory = $true)][string]$MetaEditor,  # full path to metaeditor.exe / metaeditor64.exe
    [Parameter(Mandatory = $true)][string]$SourceFile,  # the .mq4/.mq5 file to open and compile
    [switch]$Portable,                                  # append /portable (mql_tools.Metaeditor.Portable4/5)
    [int]$WindowTimeoutMs = 20000,                      # max wait for the MetaEditor window showing the file
    [int]$ResultTimeoutMs = 15000                       # max wait for the .ex4/.ex5 to be rewritten (0 = skip)
)

$ErrorActionPreference = 'Stop'
function Fail($msg) { "ERROR $msg"; exit 1 }

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path -LiteralPath $MetaEditor)) { Fail "metaeditor-not-found: $MetaEditor" }
if (-not (Test-Path -LiteralPath $SourceFile)) { Fail "source-not-found: $SourceFile" }

Add-Type @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;

public class MeGui {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint uintType);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    // Visible top-level windows owned by one of `pids` whose title contains `part`
    // (ordinal, case-insensitive). MetaEditor's main window is titled
    // "MetaEditor - [<file>]" and its only other top-level windows (tooltips, IME,
    // GDI+) are hidden, so visibility plus the title is a reliable match.
    public static IntPtr[] FindWindows(uint[] pids, string part) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) < 0) return true;
            found.Add(h);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    public static uint WindowPid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

    // WM_KEYDOWN + WM_KEYUP for `vk` with a proper lParam (repeat count 1, scan
    // code, transition/release bits). Built here so the value is correct in a
    // 32-bit as well as a 64-bit PowerShell host.
    public static bool PostKey(IntPtr h, uint vk) {
        uint sc = MapVirtualKey(vk, 0);
        int down = 1 | (int)(sc << 16);
        int up = unchecked(down | (1 << 30) | (int)(1u << 31));
        bool a = PostMessage(h, 0x0100, (IntPtr)vk, (IntPtr)down);
        bool b = PostMessage(h, 0x0101, (IntPtr)vk, (IntPtr)up);
        return a && b;
    }
}
"@

$VK_F7 = 0x76
$baseName = [System.IO.Path]::GetFileName($SourceFile)
$titlePart = '[' + $baseName + ']'
$ext = [System.IO.Path]::GetExtension($SourceFile).ToLowerInvariant()
$outExt = if ($ext -eq '.mq4') { '.ex4' } else { '.ex5' }
$outFile = [System.IO.Path]::ChangeExtension($SourceFile, $outExt)

# Every MetaEditor build counts as a candidate: metaeditor.exe (MT4),
# metaeditor64.exe (MT5) and whatever the configured executable is called.
$exeNames = @('metaeditor', 'metaeditor64', [System.IO.Path]::GetFileNameWithoutExtension($MetaEditor)) |
    ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique
$launchPid = 0

function Get-MetaEditorPids {
    # [uint32[]] of the running MetaEditor processes (empty when none). The
    # leading comma keeps PowerShell from unrolling a one-element array.
    return ,([uint32[]]@(Get-Process -Name $exeNames -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }))
}

function Find-TargetWindow {
    # Preferred order: the process started here, then the configured MetaEditor
    # installation, then any other MetaEditor showing the file.
    $handles = [MeGui]::FindWindows((Get-MetaEditorPids), $titlePart)
    if ($handles.Length -eq 0) { return [IntPtr]::Zero }
    $best = [IntPtr]::Zero
    $bestRank = 9
    foreach ($h in $handles) {
        $ownerPid = [MeGui]::WindowPid($h)
        $rank = 2
        if ($ownerPid -eq $launchPid) { $rank = 0 }
        else {
            # Path is empty/inaccessible for elevated processes; that is fine.
            $ownerPath = $null
            try { $ownerPath = (Get-Process -Id $ownerPid -ErrorAction Stop).Path } catch { }
            if ($ownerPath -and ($ownerPath -ieq $MetaEditor)) { $rank = 1 }
        }
        if ($rank -lt $bestRank) { $bestRank = $rank; $best = $h }
    }
    return $best
}

# --- 1. foreground window before the launch ---
$fgBefore = [MeGui]::GetForegroundWindow()
$fgBeforePid = 0
if ($fgBefore -ne [IntPtr]::Zero) { $fgBeforePid = [MeGui]::WindowPid($fgBefore) }

# --- 2. launch MetaEditor with the file (GUI mode) ---
$argList = @('"' + $SourceFile + '"')
if ($Portable) { $argList += '/portable' }
try {
    $proc = Start-Process -FilePath $MetaEditor -ArgumentList $argList -PassThru
    if ($proc) { $launchPid = [uint32]$proc.Id }
} catch {
    Fail ("launch-failed: " + $_.Exception.Message)
}

# --- 3. wait for the MetaEditor window showing the file ---
$hwnd = [IntPtr]::Zero
while ($sw.ElapsedMilliseconds -lt $WindowTimeoutMs) {
    $hwnd = Find-TargetWindow
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 50
}
if ($hwnd -eq [IntPtr]::Zero) {
    Fail ("window-timeout: no MetaEditor window titled '*" + $titlePart + "*' within ${WindowTimeoutMs} ms" +
        " (MetaEditor may still be starting, or it is showing a dialog)")
}
$tWindow = $sw.ElapsedMilliseconds

# --- 4. post F7 (Compile) to that window ---
$before = if (Test-Path -LiteralPath $outFile) { (Get-Item -LiteralPath $outFile).LastWriteTimeUtc } else { [datetime]::MinValue }
if (-not [MeGui]::PostKey($hwnd, $VK_F7)) {
    Fail ("post-failed: could not post F7 to the MetaEditor window 0x" + $hwnd.ToInt64().ToString('X'))
}
$tKey = $sw.ElapsedMilliseconds

# --- 5. + 6. watch the foreground for a moment, wait for the rewritten binary ---
# The binary check is informational only: the command-line compile that ran
# before this worker already produced it, so a timeout here means "not
# confirmed", never a failure.
$focus = 'none'
$focusWatchUntil = $tKey + 1500
$binMs = -1
while ($true) {
    $now = $sw.ElapsedMilliseconds
    $mePids = Get-MetaEditorPids
    $fg = [MeGui]::GetForegroundWindow()
    $fgIsMetaEditor = ($fg -ne [IntPtr]::Zero -and $mePids -contains [MeGui]::WindowPid($fg))

    if ($binMs -lt 0 -and $ResultTimeoutMs -gt 0 -and $now -lt $tKey + $ResultTimeoutMs -and
        (Test-Path -LiteralPath $outFile) -and (Get-Item -LiteralPath $outFile).LastWriteTimeUtc -gt $before) {
        $binMs = $now - $tKey
    }

    if ($focus -eq 'none' -and $fgIsMetaEditor) {
        # MetaEditor took the foreground with its launch. Hand it back to the
        # window the user was in. Without a remembered window (e.g. a locked
        # session) there is nothing to restore.
        $focus = 'kept'
        if ($fgBefore -ne [IntPtr]::Zero -and $fgBefore -ne $fg) {
            [void][MeGui]::SetForegroundWindow($fgBefore)
            Start-Sleep -Milliseconds 80
            if ($mePids -contains [MeGui]::WindowPid([MeGui]::GetForegroundWindow())) {
                # SetForegroundWindow is refused for non-foreground processes on
                # some systems; AppActivate works from a background process.
                try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$fgBeforePid) } catch { }
            }
            if ($mePids -notcontains [MeGui]::WindowPid([MeGui]::GetForegroundWindow())) { $focus = 'restored' }
        }
    }

    $waitBin = ($binMs -lt 0 -and $ResultTimeoutMs -gt 0 -and $now -lt $tKey + $ResultTimeoutMs)
    $waitFocus = ($focus -eq 'none' -and $now -le $focusWatchUntil)
    if (-not $waitBin -and -not $waitFocus) { break }
    Start-Sleep -Milliseconds 40
}

# --- 7. report ---
if ($binMs -ge 0) {
    "OK compiled pid=$launchPid window-ms=$tWindow bin-ms=$binMs focus=$focus"
} else {
    "OK triggered pid=$launchPid window-ms=$tWindow bin-ms=-1 focus=$focus"
}
exit 0
