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
#   1. Remembers the current foreground window and which MetaEditor of the
#      configured installation is already running.
#   2. Starts MetaEditor with the source file as a bare argument (GUI mode, no
#      /compile), detached from this console.
#   3. MetaEditor is single-instance: when an instance was already running, the
#      new process only hands the file over and exits. The worker waits for that
#      exit (bounded) plus a short grace period, so the F7 in step 5 always
#      reaches the instance after it switched to the requested file. Without
#      that wait the key could hit a tab that merely carries the same file name
#      (other folder), compiling the wrong file.
#   4. Waits (bounded) for a MetaEditor window of the configured installation
#      whose title shows the file ("MetaEditor - [Name.mq5]"). The target is
#      found by title, never by the PID started here, because that process has
#      exited after the hand-over. A window of another MetaEditor installation
#      showing a file with the same name is ignored.
#   5. Delays the key (bounded) while a Shift/Ctrl/Alt/Win key is held, so it is
#      not read as a different shortcut, then posts F7 (Compile) to that window
#      with PostMessage. If a modifier is still held after the bound, the key
#      goes out anyway and the result says so: a misread chord at worst ends as
#      "triggered", a withheld key would fail the command for somebody who
#      simply keeps typing. No activation is needed, so this also works while
#      MetaEditor sits behind other windows.
#   6. Focus: for a short moment after the key, if MetaEditor's launch made it
#      the foreground window and the user has not meanwhile moved to another
#      window, the window from step 1 is activated again so the user keeps
#      working where they were (VS Code).
#   7. Waits (bounded) for the compiled .ex4/.ex5 next to the source to be
#      rewritten, as confirmation that the GUI compile really ran.
#   8. MetaEditor stays open: the final compile log is in its Toolbox window.
#
# Output protocol: the last stdout line is the result, exit code 0 only for OK.
#   OK compiled   pid=<n> window-ms=<n> bin-ms=<n> focus=<none|restored|kept> handoff=<none|exited|timeout> mods-ms=<n> mods=<clear|held> already-open=<0|1>
#   OK triggered  pid=<n> window-ms=<n> bin-ms=-1 focus=<...> handoff=<...> mods-ms=<n> mods=<clear|held> already-open=<0|1>
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
    [int]$ResultTimeoutMs = 20000,                      # max wait for the .ex4/.ex5 to be rewritten (0 = skip)
    [int]$HandOffTimeoutMs = 5000,                      # max wait for the started process to hand the file to a running instance and exit
    [int]$HandOffGraceMs = 250,                         # extra time for that instance to switch to the file's tab
    [int]$ModifierTimeoutMs = 3000                      # how long F7 is delayed while Shift/Ctrl/Alt/Win is held (0 = no wait; sent anyway afterwards)
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
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint buffer);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    // Canonical form for comparing a configured path with a process image path:
    // long names, backslashes, no trailing separator, lower-case.
    public static string NormalizePath(string p) {
        if (string.IsNullOrEmpty(p)) return string.Empty;
        string full;
        try { full = System.IO.Path.GetFullPath(p); } catch { full = p; }
        StringBuilder sb = new StringBuilder(1024);
        if (GetLongPathName(full, sb, (uint)sb.Capacity) > 0) full = sb.ToString();
        return full.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();
    }

    // Image path of a process, or null when it cannot be opened (elevated, other
    // session, already exited). Used instead of System.Diagnostics.Process.Path,
    // which is empty for a 64-bit process seen from a 32-bit PowerShell host.
    public static string ImagePath(uint pid) {
        IntPtr h = OpenProcess(0x1000, false, pid);  // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return null;
        try {
            StringBuilder sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            if (!QueryFullProcessImageName(h, 0, sb, ref size)) return null;
            return sb.ToString();
        } finally { CloseHandle(h); }
    }

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

    // True while a modifier key is physically held (Shift, Ctrl, Alt, Win).
    public static bool AnyModifierDown() {
        int[] keys = new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C };
        foreach (int k in keys) {
            if ((GetAsyncKeyState(k) & 0x8000) != 0) return true;
        }
        return false;
    }

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
$whatWeLookFor = 'window of "' + $MetaEditor + '" titled "*' + $titlePart + '*"'
$ext = [System.IO.Path]::GetExtension($SourceFile).ToLowerInvariant()
$outExt = if ($ext -eq '.mq4') { '.ex4' } else { '.ex5' }
$outFile = [System.IO.Path]::ChangeExtension($SourceFile, $outExt)

# Every MetaEditor build counts as a candidate: metaeditor.exe (MT4),
# metaeditor64.exe (MT5) and whatever the configured executable is called.
$exeNames = @('metaeditor', 'metaeditor64', [System.IO.Path]::GetFileNameWithoutExtension($MetaEditor)) |
    ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique
$metaEditorKey = [MeGui]::NormalizePath($MetaEditor)
$launchPid = 0

function Get-MetaEditorPids {
    # [uint32[]] of the running MetaEditor processes (empty when none). The
    # leading comma keeps PowerShell from unrolling a one-element array.
    return ,([uint32[]]@(Get-Process -Name $exeNames -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }))
}

function Get-InstallationPids {
    # [uint32[]] of the running MetaEditor processes whose readable image path
    # is the configured installation.
    $all = Get-MetaEditorPids
    $found = @($all | Where-Object {
        $p = [MeGui]::ImagePath($_)
        $p -and ([MeGui]::NormalizePath($p) -eq $metaEditorKey)
    })
    return ,([uint32[]]$found)
}

function Find-TargetWindow {
    # The process started here always wins. Otherwise only a MetaEditor of the
    # configured installation qualifies: another installation may already show a
    # file with the same name, and F7 there would compile the wrong file. Only a
    # process whose image path cannot be read (elevated, other session) is
    # accepted without that check, as a last resort.
    $handles = [MeGui]::FindWindows((Get-MetaEditorPids), $titlePart)
    if ($null -eq $handles -or @($handles).Count -eq 0) { return [IntPtr]::Zero }
    $best = [IntPtr]::Zero
    $bestRank = 9
    foreach ($h in @($handles)) {
        $ownerPid = [MeGui]::WindowPid($h)
        if ($ownerPid -eq $launchPid) { return $h }
        $ownerPath = [MeGui]::ImagePath($ownerPid)
        if ($ownerPath) {
            if ([MeGui]::NormalizePath($ownerPath) -ne $metaEditorKey) { continue }
            if ($bestRank -gt 1) { $bestRank = 1; $best = $h }
        } elseif ($bestRank -gt 2) { $bestRank = 2; $best = $h }
    }
    return $best
}

# --- 1. state before the launch: foreground window, running instances ---
$fgBefore = [MeGui]::GetForegroundWindow()
$fgBeforePid = 0
if ($fgBefore -ne [IntPtr]::Zero) { $fgBeforePid = [MeGui]::WindowPid($fgBefore) }

$existingPids = Get-InstallationPids
$alreadyOpen = 0
if ($existingPids.Count -gt 0 -and @([MeGui]::FindWindows($existingPids, $titlePart)).Count -gt 0) {
    # A tab with this file name is already open (possibly another folder's file
    # with the same name): only reported, the hand-over wait below orders it.
    $alreadyOpen = 1
}

# --- 2. launch MetaEditor with the file (GUI mode) ---
$argList = @('"' + $SourceFile + '"')
if ($Portable) { $argList += '/portable' }
$proc = $null
try {
    $proc = Start-Process -FilePath $MetaEditor -ArgumentList $argList -PassThru
    if ($proc) { $launchPid = [uint32]$proc.Id }
} catch {
    Fail ("launch-failed: " + $_.Exception.Message)
}

# --- 3. hand-over: a running instance receives the file, the new process exits ---
$handOff = 'none'
if ($existingPids.Count -gt 0 -and $proc) {
    $exited = $false
    try { $exited = $proc.WaitForExit($HandOffTimeoutMs) } catch { $exited = $true }
    if ($exited) {
        $handOff = 'exited'
        Start-Sleep -Milliseconds $HandOffGraceMs
    } else {
        # Not single-instance after all, or the process hangs: its own window is
        # preferred below, so only the wait is reported.
        $handOff = 'timeout'
    }
}

# --- 4. wait for the MetaEditor window showing the file ---
$hwnd = [IntPtr]::Zero
while ($sw.ElapsedMilliseconds -lt $WindowTimeoutMs) {
    $hwnd = Find-TargetWindow
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 50
}
if ($hwnd -eq [IntPtr]::Zero) {
    Fail ("window-timeout: no " + $whatWeLookFor + " within ${WindowTimeoutMs} ms" +
        " (MetaEditor may still be starting, or it is showing a dialog)")
}
$tWindow = $sw.ElapsedMilliseconds

# --- 5. briefly delay the key while a modifier is held ---
# A held Shift/Ctrl/Alt/Win could turn the posted F7 into another shortcut, so
# the key waits (bounded) until they are released. After the bound it is sent
# anyway and reported: a misread chord at worst ends as "triggered" (binary not
# rewritten, warning), a key that is never sent would fail the command although
# the command-line compile was clean.
$tMods = $sw.ElapsedMilliseconds
$mods = 'clear'
if ($ModifierTimeoutMs -gt 0) {
    while ([MeGui]::AnyModifierDown()) {
        if ($sw.ElapsedMilliseconds -ge $tMods + $ModifierTimeoutMs) { $mods = 'held'; break }
        Start-Sleep -Milliseconds 50
    }
}
$modsMs = $sw.ElapsedMilliseconds - $tMods

$before = [datetime]::MinValue
$beforeItem = Get-Item -LiteralPath $outFile -ErrorAction SilentlyContinue
if ($beforeItem) { $before = $beforeItem.LastWriteTimeUtc }
if (-not [MeGui]::PostKey($hwnd, $VK_F7)) {
    Fail ("post-failed: could not post F7 to the MetaEditor window 0x" + $hwnd.ToInt64().ToString('X'))
}
$tKey = $sw.ElapsedMilliseconds

# --- 6. + 7. watch the foreground for a moment, wait for the rewritten binary ---
# The binary check is informational only: the command-line compile that ran
# before this worker already produced it, so a timeout here means "not
# confirmed", never a failure.
$focus = 'none'
$focusWatchUntil = $tKey + 1500
$userSwitched = $false
$binMs = -1
while ($true) {
    $now = $sw.ElapsedMilliseconds
    $mePids = Get-MetaEditorPids
    $fg = [MeGui]::GetForegroundWindow()
    $fgIsMetaEditor = ($fg -ne [IntPtr]::Zero -and $mePids -contains [MeGui]::WindowPid($fg))

    # -ErrorAction SilentlyContinue: MetaEditor deletes the old binary while a
    # failed compile runs, so existence and read must not be two steps.
    if ($binMs -lt 0 -and $ResultTimeoutMs -gt 0 -and $now -lt $tKey + $ResultTimeoutMs) {
        $item = Get-Item -LiteralPath $outFile -ErrorAction SilentlyContinue
        if ($item -and $item.LastWriteTimeUtc -gt $before) { $binMs = $now - $tKey }
    }

    if ($focus -eq 'none' -and $now -le $focusWatchUntil) {
        if ($fgIsMetaEditor) {
            # MetaEditor took the foreground with its launch. Hand it back to the
            # window the user was in, unless there was none (locked session) or the
            # user already chose another window in the meantime.
            $focus = 'kept'
            if ($fgBefore -ne [IntPtr]::Zero -and $fgBefore -ne $fg -and -not $userSwitched) {
                [void][MeGui]::SetForegroundWindow($fgBefore)
                Start-Sleep -Milliseconds 80
                if ((Get-MetaEditorPids) -contains [MeGui]::WindowPid([MeGui]::GetForegroundWindow())) {
                    # SetForegroundWindow is refused for non-foreground processes on
                    # some systems; AppActivate works from a background process.
                    try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$fgBeforePid) } catch { }
                }
                if ((Get-MetaEditorPids) -notcontains [MeGui]::WindowPid([MeGui]::GetForegroundWindow())) { $focus = 'restored' }
            }
        } elseif ($fg -ne [IntPtr]::Zero -and $fg -ne $fgBefore) {
            # A third window is in front: the user moved on, leave the focus alone.
            $userSwitched = $true
        }
    }

    $waitBin = ($binMs -lt 0 -and $ResultTimeoutMs -gt 0 -and $now -lt $tKey + $ResultTimeoutMs)
    $waitFocus = ($focus -eq 'none' -and $now -le $focusWatchUntil)
    if (-not $waitBin -and -not $waitFocus) { break }
    Start-Sleep -Milliseconds 40
}

# --- 8. report ---
$common = "pid=$launchPid window-ms=$tWindow focus=$focus handoff=$handOff mods-ms=$modsMs mods=$mods already-open=$alreadyOpen"
if ($binMs -ge 0) {
    "OK compiled $common bin-ms=$binMs"
} else {
    "OK triggered $common bin-ms=-1"
}
exit 0
