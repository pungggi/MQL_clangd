//+------------------------------------------------------------------+
//|                                                      MqlDebug.mqh |
//|                          MQL Tools Extension - Debug Bridge       |
//+------------------------------------------------------------------+
#ifndef MQLDEBUG_MQH
#define MQLDEBUG_MQH

#ifndef __clang__
#property copyright "MQL Tools Extension"
#property version "1.00"
#property strict
#else
#include "mql_clangd_compat.h"
#endif

//+------------------------------------------------------------------+
//| MqlDebug - Instrumentation library for VS Code Debugger Bridge   |
//|                                                                  |
//| This library is AUTO-INJECTED by the MQL Tools VS Code           |
//| extension when you start a debug session. Do not manually edit   |
//| files that include this library during a debug session.          |
//|                                                                  |
//| Structured output format (parsed by VS Code):                    |
//|   DBG|{ts}|{file}|{func}|{line}|WATCH|{name}|{type}|{value}      |
//|   DBG|{ts}|{file}|{func}|{line}|BREAK|{label}                    |
//|   DBG|{ts}|{file}|{func}|{line}|ENTER                            |
//|   DBG|{ts}|{file}|{func}|{line}|EXIT                             |
//|   DBG|{ts}|{file}|{func}|{line}|LOG|{message}                    |
//+------------------------------------------------------------------+

// Configuration
#define MQLDEBUG_MAX_SIZE  5242880  // 5 MB - auto-rotate when exceeded

// Global state encapsulated to prevent cross-instance races
class CMqlDebugState {
private:
  int __dbgHandle;
  bool __dbgInit;
#ifdef __MQL5__
  datetime __baselineTime;
  ulong    __baselineMicro;
#endif

public:
  CMqlDebugState() : __dbgHandle(INVALID_HANDLE), __dbgInit(false)
#ifdef __MQL5__
    , __baselineTime(0), __baselineMicro(0)
#endif
  {}

  int GetDebugHandle() { return __dbgHandle; }
  void SetDebugHandle(int handle) { __dbgHandle = handle; }
  bool IsDebugInitialized() { return __dbgInit; }
  void SetDebugInitialized(bool init) { __dbgInit = init; }
#ifdef __MQL5__
  datetime GetBaselineTime()  { return __baselineTime; }
  ulong    GetBaselineMicro() { return __baselineMicro; }
  void     SetBaseline(datetime t, ulong micro) { __baselineTime = t; __baselineMicro = micro; }
#endif
};

CMqlDebugState __dbgState;

#define MQLDEBUG_FILENAME "MqlDebug.txt"

//+------------------------------------------------------------------+
//| Initialize the debug log file                                    |
//+------------------------------------------------------------------+
bool MqlDebugInit() {
  if (__dbgState.IsDebugInitialized() && __dbgState.GetDebugHandle() != INVALID_HANDLE)
    return true;

  __dbgState.SetDebugHandle(FileOpen(
      MQLDEBUG_FILENAME, FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI |
                                   FILE_SHARE_READ | FILE_SHARE_WRITE));

  if (__dbgState.GetDebugHandle() == INVALID_HANDLE) {
    PrintFormat("MqlDebug: Failed to open log file. Error: %d", GetLastError());
    return false;
  }

  FileSeek(__dbgState.GetDebugHandle(), 0, SEEK_END);

  string header = "\n=== MqlDebug Session Started: " +
                  TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) +
                  " ===\n";

  if (FileWriteString(__dbgState.GetDebugHandle(), header) > 0) {
    FileFlush(__dbgState.GetDebugHandle());
#ifdef __MQL5__
    // Capture a baseline pairing of wall-clock second and monotonic counter
    // so MqlDebugTime() can derive an aligned millisecond offset.
    datetime bTime;
    do { bTime = TimeLocal(); } while (bTime != TimeLocal());
    ulong bMicro = GetMicrosecondCount();
    __dbgState.SetBaseline(bTime, bMicro);
#endif
    __dbgState.SetDebugInitialized(true);
  } else {
    PrintFormat("MqlDebug: Failed to write or flush header. Error: %d",
                GetLastError());
    FileClose(__dbgState.GetDebugHandle());
    __dbgState.SetDebugHandle(INVALID_HANDLE);
    return false;
  }
  return true;
}

//+------------------------------------------------------------------+
//| Close the debug log file                                         |
//+------------------------------------------------------------------+
void MqlDebugClose() {
  if (__dbgState.GetDebugHandle() != INVALID_HANDLE) {
    FileWriteString(__dbgState.GetDebugHandle(), "=== MqlDebug Session Ended ===\n");
    FileFlush(__dbgState.GetDebugHandle());
    FileClose(__dbgState.GetDebugHandle());
    __dbgState.SetDebugHandle(INVALID_HANDLE);
  }
  __dbgState.SetDebugInitialized(false);
}

//+------------------------------------------------------------------+
//| Rotate log if over size limit                                    |
//+------------------------------------------------------------------+
void MqlDebugRotate() {
  if (__dbgState.GetDebugHandle() == INVALID_HANDLE)
    return;
  long size = (long)FileTell(__dbgState.GetDebugHandle());
  if (size > MQLDEBUG_MAX_SIZE) {
    FileClose(__dbgState.GetDebugHandle());
    __dbgState.SetDebugHandle(INVALID_HANDLE);
    string timestamp = TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS);
    StringReplace(timestamp, ".", "_");
    StringReplace(timestamp, ":", "_");
    string newName = "MqlDebug_" + timestamp + "_" +
                     IntegerToString(GetTickCount()) + ".txt";

    if (FileMove(MQLDEBUG_FILENAME, 0, newName, FILE_REWRITE)) {
      __dbgState.SetDebugHandle(FileOpen(MQLDEBUG_FILENAME,
                                        FILE_WRITE | FILE_TXT | FILE_ANSI |
                                            FILE_SHARE_READ | FILE_SHARE_WRITE));
      if (__dbgState.GetDebugHandle() != INVALID_HANDLE) {
#ifdef __MQL5__
        datetime bTime;
        do { bTime = TimeLocal(); } while (bTime != TimeLocal());
        __dbgState.SetBaseline(bTime, GetMicrosecondCount());
#endif
        FileWriteString(__dbgState.GetDebugHandle(),
                        "=== MqlDebug Log Rotated ===\n");
        FileFlush(__dbgState.GetDebugHandle());
        __dbgState.SetDebugInitialized(true);
      } else {
        __dbgState.SetDebugInitialized(false);
      }
    } else {
      __dbgState.SetDebugInitialized(false);
    }
  }
}

//+------------------------------------------------------------------+
//| Get timestamp with sub-second ordering                           |
//+------------------------------------------------------------------+
string MqlDebugTime() {
  MqlDateTime dt;
#ifdef __MQL5__
  datetime t = TimeLocal();
  TimeToStruct(t, dt);
  int ms = 0;
  if (__dbgState.GetBaselineMicro() != 0) {
    ulong nowMicro = GetMicrosecondCount();
    ulong elapsedMicro = nowMicro - __dbgState.GetBaselineMicro();
    // ms = sub-second part of the elapsed offset, anchored to the baseline second
    ms = (int)((elapsedMicro / 1000) % 1000);
  }
  return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.%03d", dt.year, dt.mon,
                      dt.day, dt.hour, dt.min, dt.sec, ms);
#else
  TimeToStruct(TimeLocal(), dt);
  return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.000", dt.year, dt.mon,
                      dt.day, dt.hour, dt.min, dt.sec);
#endif
}

//+------------------------------------------------------------------+
//| Core structured write                                            |
//+------------------------------------------------------------------+
void MqlDebugWrite(string structured) {
  if (!__dbgState.IsDebugInitialized())
    MqlDebugInit();
  if (__dbgState.GetDebugHandle() == INVALID_HANDLE)
    return;
  MqlDebugRotate();
  if (__dbgState.GetDebugHandle() == INVALID_HANDLE)
    return;
  FileWriteString(__dbgState.GetDebugHandle(), structured + "\n");
  FileFlush(__dbgState.GetDebugHandle());
}

//+------------------------------------------------------------------+
//| Escape strings for DBG logging                                   |
//+------------------------------------------------------------------+
string MqlDebugEscape(string val) {
  string res = val;
  StringReplace(res, "\\", "\\\\");
  StringReplace(res, "|", "\\|");
  StringReplace(res, "\n", "\\n");
  StringReplace(res, "\r", "\\r");
  return res;
}

//+------------------------------------------------------------------+
#define MQL_DBG_BREAK(label)                                                   \
  MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" +               \
                __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|BREAK|" +   \
                MqlDebugEscape(label))

//+------------------------------------------------------------------+
//| ENTER / EXIT - call stack tracking                               |
//+------------------------------------------------------------------+
#define MQL_DBG_ENTER \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|ENTER")

#define MQL_DBG_EXIT \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|EXIT")

//+------------------------------------------------------------------+
//| WATCH macros - one per type                                      |
//+------------------------------------------------------------------+
#define MQL_DBG_WATCH_INT(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + MqlDebugEscape(varName) + "|int|" + IntegerToString((long)(val)))

#define MQL_DBG_WATCH_LONG(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + MqlDebugEscape(varName) + "|long|" + IntegerToString((long)(val)))

#define MQL_DBG_WATCH_DBL(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + MqlDebugEscape(varName) + "|double|" + DoubleToString((double)(val), 8))

#define MQL_DBG_WATCH_STR(varName, val)                                        \
  MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" +               \
                __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" +   \
                MqlDebugEscape(varName) + "|string|" + MqlDebugEscape(val))

#define MQL_DBG_WATCH_BOOL(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + MqlDebugEscape(varName) + "|bool|" + ((val) ? "true" : "false"))

#define MQL_DBG_WATCH_DATETIME(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + MqlDebugEscape(varName) + "|datetime|" + TimeToString((datetime)(val), TIME_DATE | TIME_SECONDS))

//+------------------------------------------------------------------+
//| Convenience: auto-detect common numeric types via overloading.   |
//| For MQL4 or ambiguous cases, prefer the typed macros above.      |
//+------------------------------------------------------------------+
#define MQL_DBG_WATCH(varName, val) MQL_DBG_WATCH_DBL(varName, val)

//+------------------------------------------------------------------+
//| ARRAY watch macros — emit each element as a separate WATCH line  |
//| with varName[index] naming.  Capped at MQLDEBUG_MAX_ARRAY_ELEMS |
//| to prevent flooding the log file on large arrays.                |
//+------------------------------------------------------------------+
#define MQLDEBUG_MAX_ARRAY_ELEMS 50

#define MQL_DBG_WATCH_ARRAY_INT(varName, arr) \
  { int __n = MathMin(ArraySize(arr), MQLDEBUG_MAX_ARRAY_ELEMS); \
    MQL_DBG_WATCH_INT(varName + ".size", ArraySize(arr)); \
    for (int __i = 0; __i < __n; __i++) \
      MQL_DBG_WATCH_INT(varName + "[" + IntegerToString(__i) + "]", arr[__i]); }

#define MQL_DBG_WATCH_ARRAY_DBL(varName, arr) \
  { int __n = MathMin(ArraySize(arr), MQLDEBUG_MAX_ARRAY_ELEMS); \
    MQL_DBG_WATCH_INT(varName + ".size", ArraySize(arr)); \
    for (int __i = 0; __i < __n; __i++) \
      MQL_DBG_WATCH_DBL(varName + "[" + IntegerToString(__i) + "]", arr[__i]); }

#define MQL_DBG_WATCH_ARRAY_LONG(varName, arr) \
  { int __n = MathMin(ArraySize(arr), MQLDEBUG_MAX_ARRAY_ELEMS); \
    MQL_DBG_WATCH_INT(varName + ".size", ArraySize(arr)); \
    for (int __i = 0; __i < __n; __i++) \
      MQL_DBG_WATCH_LONG(varName + "[" + IntegerToString(__i) + "]", arr[__i]); }

#define MQL_DBG_WATCH_ARRAY_STR(varName, arr) \
  { int __n = MathMin(ArraySize(arr), MQLDEBUG_MAX_ARRAY_ELEMS); \
    MQL_DBG_WATCH_INT(varName + ".size", ArraySize(arr)); \
    for (int __i = 0; __i < __n; __i++) \
      MQL_DBG_WATCH_STR(varName + "[" + IntegerToString(__i) + "]", arr[__i]); }

//+------------------------------------------------------------------+
//| PAUSE — spin-wait at breakpoint until VS Code sends CONTINUE     |
//|                                                                  |
//| WARNING: The EA thread is fully blocked while paused.            |
//|          No OnTick / OnTimer / OnChartEvent will fire.           |
//|          Use ONLY on demo accounts or in the Strategy Tester.    |
//|                                                                  |
//| Safety:                                                          |
//|   - Auto-resumes after MQLDEBUG_PAUSE_TIMEOUT_SEC (default 120s)|
//|   - Auto-resumes if EA is removed from chart (IsStopped())       |
//|   - Stale command file is cleared before each pause              |
//+------------------------------------------------------------------+
#define MQLDEBUG_CMD_FILENAME    "MqlDebugCmd.txt"
#define MQLDEBUG_PAUSE_TIMEOUT_SEC 120

//+------------------------------------------------------------------+
//| Handle STOP / STOP_AND_CLOSE command logic                       |
//+------------------------------------------------------------------+
void MqlDebugHandleStopCmd(string trimmedCmd) {
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|||0|SESSION_END");
    MqlDebugClose();
    ExpertRemove();
    if (trimmedCmd == "STOP_AND_CLOSE") {
        TerminalClose(0);
    }
}

//+------------------------------------------------------------------+
//| Read the command file content (single I/O roundtrip)             |
//+------------------------------------------------------------------+
string MqlDebugReadCmd() {
    int handle = FileOpen(MQLDEBUG_CMD_FILENAME,
                          FILE_READ | FILE_TXT | FILE_ANSI |
                          FILE_SHARE_READ | FILE_SHARE_WRITE);
    if (handle == INVALID_HANDLE)
        return "";
    string line = FileReadString(handle);
    FileClose(handle);
    return line;
}

//+------------------------------------------------------------------+
//| Process any active commands (like STOP / STOP_AND_CLOSE)         |
//+------------------------------------------------------------------+
bool MqlDebugProcessCmd() {
    if (!__dbgState.IsDebugInitialized())
        return false;
    string cmd = MqlDebugReadCmd();
    if (cmd == "") return false;
    
    FileDelete(MQLDEBUG_CMD_FILENAME);
    
    string trimmedCmd = cmd;
    StringTrimLeft(trimmedCmd);
    StringTrimRight(trimmedCmd);
    if (trimmedCmd == "STOP" || trimmedCmd == "STOP_AND_CLOSE") {
        MqlDebugHandleStopCmd(trimmedCmd);
        return true;
    }
    return false;
}

//+------------------------------------------------------------------+
//| Check if a command is present in the command file                |
//+------------------------------------------------------------------+
bool MqlDebugCheckCmd(string cmd) {
    string read = MqlDebugReadCmd();
    StringTrimLeft(read);
    StringTrimRight(read);
    return (read == cmd);
}

//+------------------------------------------------------------------+
//| Pause execution until CONTINUE command or timeout                |
//+------------------------------------------------------------------+
void MqlDebugPause() {
    if (!__dbgState.IsDebugInitialized())
        return;

    // Clear any stale command left over from a previous breakpoint
    FileDelete(MQLDEBUG_CMD_FILENAME);

    uint startTick = GetTickCount();
    uint timeoutMs = MQLDEBUG_PAUSE_TIMEOUT_SEC * 1000;

    while (!IsStopped()) {
        // Timeout failsafe — resume so the EA isn't stuck forever
        if ((GetTickCount() - startTick) > timeoutMs) {
            MqlDebugWrite("DBG|" + MqlDebugTime() + "|||0|PAUSE_TIMEOUT");
            break;
        }

        // Read the command file to check if the "STOP", "STOP_AND_CLOSE", or "CONTINUE" strings are written
        string cmd = MqlDebugReadCmd();

        string trimmedCmd = cmd;
        StringTrimLeft(trimmedCmd);
        StringTrimRight(trimmedCmd);
        if (trimmedCmd == "STOP" || trimmedCmd == "STOP_AND_CLOSE") {
            MqlDebugHandleStopCmd(trimmedCmd);
            return;
        }

        // VS Code wrote CONTINUE → resume
        if (trimmedCmd == "CONTINUE") {
            break;
        }

        Sleep(100);
    }
}

#define MQL_DBG_PAUSE MqlDebugPause()

//+------------------------------------------------------------------+
//| Dynamic Breakpoint Probes                                        |
//|                                                                  |
//| Probes are injected at every executable line. Only those listed  |
//| in MqlDebugBPConfig.txt actually fire (BREAK + PAUSE).          |
//| VS Code rewrites the config file on every breakpoint change;     |
//| the EA reloads it every ~200 ms, so new/removed breakpoints     |
//| take effect without recompilation or EA restart.                 |
//+------------------------------------------------------------------+
#define MQLDEBUG_BP_CONFIG   "MqlDebugBPConfig.txt"
#define MQLDEBUG_RELOAD_MS   200

#ifndef __clang__
bool   __mqldbg_active[];
int    __mqldbg_hitcount[];
int    __mqldbg_hitcond_op[];   // 0=none, 1==, 2=>, 3=>=, 4=<, 5=<=, 6=%
int    __mqldbg_hitcond_val[];
bool   __mqldbg_logpoint[];
#else
bool   *__mqldbg_active = nullptr;
int    *__mqldbg_hitcount = nullptr;
int    *__mqldbg_hitcond_op = nullptr;
int    *__mqldbg_hitcond_val = nullptr;
bool   *__mqldbg_logpoint = nullptr;
#endif
int    __mqldbg_maxProbe = 0;
uint   __mqldbg_lastReload = 0;

//+------------------------------------------------------------------+
//| Allocate the probe array. Called once via global initializer.     |
//+------------------------------------------------------------------+
int MqlDebugInitProbes(int count) {
    if (count < 0) {
        __mqldbg_maxProbe = 0;
        return -1;
    }
    if (count == 0) {
        __mqldbg_maxProbe = 0;
        return 0;
    }
    if (ArrayResize(__mqldbg_active, count) < count ||
        ArrayResize(__mqldbg_hitcount, count) < count ||
        ArrayResize(__mqldbg_hitcond_op, count) < count ||
        ArrayResize(__mqldbg_hitcond_val, count) < count ||
        ArrayResize(__mqldbg_logpoint, count) < count) {
        __mqldbg_maxProbe = 0;
        return -1;
    }
    ArrayFill(__mqldbg_active, 0, count, false);
    ArrayFill(__mqldbg_hitcount, 0, count, 0);
    ArrayFill(__mqldbg_hitcond_op, 0, count, 0);
    ArrayFill(__mqldbg_hitcond_val, 0, count, 0);
    ArrayFill(__mqldbg_logpoint, 0, count, false);
    __mqldbg_maxProbe = count;
    return 0;
}

//+------------------------------------------------------------------+
//| Reload active probe IDs from the config file.                    |
//| Extended format: comma-separated entries, each is                 |
//|   id[h<op><val>][L]                                              |
//| where:                                                           |
//|   id     = probe index (integer)                                 |
//|   h<op><val> = hit condition:  op is =, >, G(>=), <, S(<=), %   |
//|   L      = logpoint flag (log only, no pause)                    |
//| Examples: "3,17h>5,42L,9h%3L"                                    |
//|                                                                  |
//| Return Value:                                                    |
//|   Returns true ONLY when MqlDebugProcessCmd() indicates a        |
//|   "STOP" or "STOP_AND_CLOSE" shutdown sequence has occurred,     |
//|   instructing the caller to early-exit. Returns false for normal |
//|   operation (even if parsing MQLDEBUG_BP_CONFIG fails or the     |
//|   file is missing).                                              |
//+------------------------------------------------------------------+
bool MqlDebugLoadConfig() {
    // Check for STOP commands while not paused
    if (MqlDebugProcessCmd()) return true;

    ArrayFill(__mqldbg_active, 0, __mqldbg_maxProbe, false);
    ArrayFill(__mqldbg_hitcond_op, 0, __mqldbg_maxProbe, 0);
    ArrayFill(__mqldbg_hitcond_val, 0, __mqldbg_maxProbe, 0);
    ArrayFill(__mqldbg_logpoint, 0, __mqldbg_maxProbe, false);
    // NOTE: __mqldbg_hitcount is intentionally NOT reset here.
    // Hit counts persist across config reloads so that changing a
    // hit condition (e.g. "> 5" → "> 10") evaluates against the
    // running total, matching standard DAP adapter behavior.

    int handle = FileOpen(MQLDEBUG_BP_CONFIG,
                          FILE_READ | FILE_TXT | FILE_ANSI |
                          FILE_SHARE_READ | FILE_SHARE_WRITE);
    if (handle == INVALID_HANDLE) return false;

    string content = FileReadString(handle);
    FileClose(handle);

    if (content == "") return false;

#ifndef __clang__
    string parts[];
#else
    string *parts;
#endif
    int cnt = StringSplit(content, ',', parts);
    for (int i = 0; i < cnt; i++) {
        StringTrimLeft(parts[i]);
        StringTrimRight(parts[i]);
        string token = parts[i];
        int len = StringLen(token);
        if (len == 0 || StringGetCharacter(token, 0) < '0' ||
            StringGetCharacter(token, 0) > '9')
          continue;

        // Parse probe ID (leading digits)
        int pos = 0;
        while (pos < len && StringGetCharacter(token, pos) >= '0' &&
               StringGetCharacter(token, pos) <= '9')
            pos++;
        int id = (int)StringToInteger(StringSubstr(token, 0, pos));
        if (id < 0 || id >= __mqldbg_maxProbe)
            continue;
        __mqldbg_active[id] = true;

        // Parse optional modifiers
        while (pos < len) {
            ushort ch = StringGetCharacter(token, pos);
            if (ch == 'h' || ch == 'H') {
                // Hit condition: h<op><val>
                pos++;
                if (pos >= len) break;
                ushort opCh = StringGetCharacter(token, pos);
                int op = 0;
                pos++;
                if (opCh == '=')             op = 1; // ==
                else if (opCh == '>')        op = 2; // >
                else if (opCh == 'G' || opCh == 'g') op = 3; // >= (G for Greater-or-equal)
                else if (opCh == '<')        op = 4; // <
                else if (opCh == 'S' || opCh == 's') op = 5; // <= (S for Smaller-or-equal)
                else if (opCh == '%')        op = 6; // modulo
                // Read the value digits
                int valStart = pos;
                while (pos < len && StringGetCharacter(token, pos) >= '0' &&
                       StringGetCharacter(token, pos) <= '9')
                    pos++;
                int val = (pos > valStart)
                    ? (int)StringToInteger(StringSubstr(token, valStart, pos - valStart))
                    : 0;
                __mqldbg_hitcond_op[id] = op;
                __mqldbg_hitcond_val[id] = val;
            } else if (ch == 'L' || ch == 'l') {
                __mqldbg_logpoint[id] = true;
                pos++;
            } else {
                pos++; // skip unknown char
            }
        }
    }

    return false;
}

//+------------------------------------------------------------------+
//| Check whether a probe should fire. Reloads config every ~200 ms. |
//| Increments hit count and evaluates hit condition if present.     |
//+------------------------------------------------------------------+
bool MqlDebugProbeCheck(int id) {
    if (__mqldbg_maxProbe == 0 || id < 0 || id >= __mqldbg_maxProbe)
        return false;

    uint now = GetTickCount();
    if (now - __mqldbg_lastReload > MQLDEBUG_RELOAD_MS) {
        __mqldbg_lastReload = now;
        if (MqlDebugLoadConfig()) return false;
    }

    if (!__mqldbg_active[id])
        return false;

    // Increment hit counter (saturate to prevent signed overflow)
    if (__mqldbg_hitcount[id] < 2147483647)
        __mqldbg_hitcount[id]++;
    int count = __mqldbg_hitcount[id];

    // Evaluate hit condition (op 0 = no condition, always fire)
    int op  = __mqldbg_hitcond_op[id];
    int val = __mqldbg_hitcond_val[id];
    if (op != 0) {
        bool pass = false;
        switch (op) {
            case 1: pass = (count == val);            break; // =
            case 2: pass = (count >  val);            break; // >
            case 3: pass = (count >= val);            break; // >=
            case 4: pass = (count <  val);            break; // <
            case 5: pass = (count <= val);            break; // <=
            case 6: pass = (val > 0 && count % val == 0); break; // %
        }
        if (!pass) return false;
    }

    return true;
}

//+------------------------------------------------------------------+
//| Check whether a probe is in logpoint mode (log only, no pause).  |
//+------------------------------------------------------------------+
bool MqlDebugIsLogpoint(int id) {
    if (id < 0 || id >= __mqldbg_maxProbe) return false;
    return __mqldbg_logpoint[id];
}

//+------------------------------------------------------------------+
//| LOG macro — structured log output for logpoints                   |
//+------------------------------------------------------------------+
#define MQL_DBG_LOG(msg)                                                       \
  MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" +              \
                __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|LOG|" +    \
                MqlDebugEscape(msg))

#endif // MQLDEBUG_MQH
