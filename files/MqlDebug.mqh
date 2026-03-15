//+------------------------------------------------------------------+
//|                                                      MqlDebug.mqh |
//|                          MQL Tools Extension - Debug Bridge       |
//+------------------------------------------------------------------+
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
//+------------------------------------------------------------------+

// Configuration
#define MQLDEBUG_MAX_SIZE  5242880  // 5 MB - auto-rotate when exceeded

// Global state encapsulated to prevent cross-instance races
class CMqlDebugState {
public:
  int __dbgHandle;
  bool __dbgInit;
  string __dbgFilename;

  CMqlDebugState()
      : __dbgHandle(INVALID_HANDLE), __dbgInit(false), __dbgFilename("") {}
};

CMqlDebugState __dbgState;

string __MqlDebugGetFilename() {
  if (__dbgState.__dbgFilename == "") {
    __dbgState.__dbgFilename =
        "mql_debug_" + IntegerToString((long)ChartID()) + "_" +
        IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "_" +
        Symbol() + ".log";
  }
  return __dbgState.__dbgFilename;
}

//+------------------------------------------------------------------+
//| Initialize the debug log file                                    |
//+------------------------------------------------------------------+
bool MqlDebugInit() {
  if (__dbgState.__dbgInit && __dbgState.__dbgHandle != INVALID_HANDLE)
    return true;

  __dbgState.__dbgHandle = FileOpen(
      __MqlDebugGetFilename(), FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI |
                                   FILE_SHARE_READ | FILE_SHARE_WRITE);

  if (__dbgState.__dbgHandle == INVALID_HANDLE) {
    PrintFormat("MqlDebug: Failed to open log file. Error: %d", GetLastError());
    return false;
  }

  FileSeek(__dbgState.__dbgHandle, 0, SEEK_END);

  string header = "\n=== MqlDebug Session Started: " +
                  TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) +
                  " ===\n";

  if (FileWriteString(__dbgState.__dbgHandle, header) > 0) {
    FileFlush(__dbgState.__dbgHandle);
    __dbgState.__dbgInit = true;
  } else {
    PrintFormat("MqlDebug: Failed to write or flush header. Error: %d",
                GetLastError());
    return false;
  }
    return true;
}

//+------------------------------------------------------------------+
//| Close the debug log file                                         |
//+------------------------------------------------------------------+
void MqlDebugClose() {
  if (__dbgState.__dbgHandle != INVALID_HANDLE) {
    FileWriteString(__dbgState.__dbgHandle, "=== MqlDebug Session Ended ===\n");
    FileFlush(__dbgState.__dbgHandle);
    FileClose(__dbgState.__dbgHandle);
    __dbgState.__dbgHandle = INVALID_HANDLE;
  }
  __dbgState.__dbgInit = false;
}

//+------------------------------------------------------------------+
//| Rotate log if over size limit                                    |
//+------------------------------------------------------------------+
void MqlDebugRotate() {
  if (__dbgState.__dbgHandle == INVALID_HANDLE)
    return;
  long size = (long)FileTell(__dbgState.__dbgHandle);
  if (size > MQLDEBUG_MAX_SIZE) {
    FileClose(__dbgState.__dbgHandle);
    __dbgState.__dbgHandle = INVALID_HANDLE;
    string timestamp = TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS);
    StringReplace(timestamp, ".", "_");
    StringReplace(timestamp, ":", "_");
    string newName = "MqlDebug_" + timestamp + ".txt";

    if (FileMove(__MqlDebugGetFilename(), 0, newName, FILE_REWRITE)) {
      __dbgState.__dbgHandle = FileOpen(__MqlDebugGetFilename(),
                                        FILE_WRITE | FILE_TXT | FILE_ANSI |
                                            FILE_SHARE_READ | FILE_SHARE_WRITE);
      if (__dbgState.__dbgHandle != INVALID_HANDLE) {
        FileWriteString(__dbgState.__dbgHandle,
                        "=== MqlDebug Log Rotated ===\n");
        FileFlush(__dbgState.__dbgHandle);
        __dbgState.__dbgInit = true;
      } else {
        __dbgState.__dbgInit = false;
      }
    } else {
      __dbgState.__dbgInit = false;
    }
  }
}

//+------------------------------------------------------------------+
//| Get timestamp with sub-second ordering                           |
//+------------------------------------------------------------------+
string MqlDebugTime() {
  MqlDateTime dt;
#ifdef __MQL5__
  ulong micro;
  datetime t;
  do {
    micro = GetMicrosecondCount();
    t = TimeLocal();
  } while (t != TimeLocal());
  TimeToStruct(t, dt);
  return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.%03d", dt.year, dt.mon,
                      dt.day, dt.hour, dt.min, dt.sec,
                      (int)((micro / 1000) % 1000));
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
  if (!__dbgState.__dbgInit)
    MqlDebugInit();
  if (__dbgState.__dbgHandle == INVALID_HANDLE)
    return;
  MqlDebugRotate();
  if (__dbgState.__dbgHandle == INVALID_HANDLE)
    return;
  FileWriteString(__dbgState.__dbgHandle, structured + "\n");
  FileFlush(__dbgState.__dbgHandle);
}

//+------------------------------------------------------------------+
//| Escape strings for DBG logging                                   |
//+------------------------------------------------------------------+
string MqlDebugEscape(string val) {
  string res = val;
  StringReplace(res, "\\", "\\\\");
  StringReplace(res, "|", "\\|");
  StringReplace(res, "\n", "\\n");
  return res;
}

//+------------------------------------------------------------------+
//| BREAK - checkpoint hit (maps to a VS Code breakpoint)            |
//+------------------------------------------------------------------+
#define MQL_DBG_BREAK(label) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|BREAK|" + (label))

//+------------------------------------------------------------------+
//| ENTER / EXIT - call stack tracking                               |
//+------------------------------------------------------------------+
#define MQL_DBG_ENTER() \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|ENTER")

#define MQL_DBG_EXIT() \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|EXIT")

//+------------------------------------------------------------------+
//| WATCH macros - one per type                                      |
//+------------------------------------------------------------------+
#define MQL_DBG_WATCH_INT(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|int|" + IntegerToString((long)(val)))

#define MQL_DBG_WATCH_LONG(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|long|" + IntegerToString((long)(val)))

#define MQL_DBG_WATCH_DBL(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|double|" + DoubleToString((double)(val), 8))

#define MQL_DBG_WATCH_STR(varName, val)                                        \
  MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" +               \
                __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" +   \
                (varName) + "|string|" + MqlDebugEscape(val))

#define MQL_DBG_WATCH_BOOL(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|bool|" + ((val) ? "true" : "false"))

#define MQL_DBG_WATCH_DATETIME(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|datetime|" + TimeToString((datetime)(val), TIME_DATE | TIME_SECONDS))

//+------------------------------------------------------------------+
//| Convenience: auto-detect common numeric types via overloading.   |
//| For MQL4 or ambiguous cases, prefer the typed macros above.      |
//+------------------------------------------------------------------+
#define MQL_DBG_WATCH(varName, val) MQL_DBG_WATCH_DBL(varName, val)
