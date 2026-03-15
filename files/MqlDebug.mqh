//+------------------------------------------------------------------+
//|                                                      MqlDebug.mqh |
//|                          MQL Tools Extension - Debug Bridge       |
//+------------------------------------------------------------------+
#property copyright "MQL Tools Extension"
#property version "1.00"
#property strict

//+------------------------------------------------------------------+
//| MqlDebug - Instrumentation library for VS Code Debugger Bridge   |
//|                                                                  |
//| This library is AUTO-INJECTED by the MQL Tools VS Code           |
//| extension when you start a debug session. Do not manually edit   |
//| files that include this library during a debug session.          |
//|                                                                  |
//| Structured output format (parsed by VS Code):                    |
//|   DBG|{ts}|{file}|{func}|{line}|WATCH|{name}|{type}|{value}     |
//|   DBG|{ts}|{file}|{func}|{line}|BREAK|{label}                   |
//|   DBG|{ts}|{file}|{func}|{line}|ENTER                           |
//|   DBG|{ts}|{file}|{func}|{line}|EXIT                            |
//+------------------------------------------------------------------+

// Configuration
#define MQLDEBUG_FILENAME  "MqlDebug.txt"
#define MQLDEBUG_MAX_SIZE  5242880  // 5 MB - auto-rotate when exceeded

// Global state
int    __dbgHandle = INVALID_HANDLE;
bool   __dbgInit   = false;

//+------------------------------------------------------------------+
//| Initialize the debug log file                                    |
//+------------------------------------------------------------------+
bool MqlDebugInit() {
    if (__dbgInit && __dbgHandle != INVALID_HANDLE)
        return true;

    __dbgHandle = FileOpen(MQLDEBUG_FILENAME,
                           FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI |
                           FILE_SHARE_READ | FILE_SHARE_WRITE);

    if (__dbgHandle == INVALID_HANDLE) {
        PrintFormat("MqlDebug: Failed to open log file. Error: %d", GetLastError());
        return false;
    }

    FileSeek(__dbgHandle, 0, SEEK_END);
    __dbgInit = true;

    string header = StringFormat("\n=== MqlDebug Session Started: %s ===\n",
                                 TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS));
    FileWriteString(__dbgHandle, header);
    FileFlush(__dbgHandle);
    return true;
}

//+------------------------------------------------------------------+
//| Close the debug log file                                         |
//+------------------------------------------------------------------+
void MqlDebugClose() {
    if (__dbgHandle != INVALID_HANDLE) {
        FileWriteString(__dbgHandle, "=== MqlDebug Session Ended ===\n");
        FileFlush(__dbgHandle);
        FileClose(__dbgHandle);
        __dbgHandle = INVALID_HANDLE;
    }
    __dbgInit = false;
}

//+------------------------------------------------------------------+
//| Rotate log if over size limit                                    |
//+------------------------------------------------------------------+
void MqlDebugRotate() {
    if (__dbgHandle == INVALID_HANDLE) return;
    long size = (long)FileTell(__dbgHandle);
    if (size > MQLDEBUG_MAX_SIZE) {
        FileClose(__dbgHandle);
        __dbgHandle = INVALID_HANDLE;
        string newName = "MqlDebug_" + TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + ".txt";
        StringReplace(newName, ".", "_");
        StringReplace(newName, ":", "_");
        if (FileMove(MQLDEBUG_FILENAME, 0, newName, FILE_REWRITE)) {
            __dbgHandle = FileOpen(MQLDEBUG_FILENAME,
                                   FILE_WRITE | FILE_TXT | FILE_ANSI |
                                   FILE_SHARE_READ | FILE_SHARE_WRITE);
            if (__dbgHandle != INVALID_HANDLE) {
                FileWriteString(__dbgHandle, "=== MqlDebug Log Rotated ===\n");
                FileFlush(__dbgHandle);
                __dbgInit = true;
            } else {
                __dbgInit = false;
            }
        } else {
            __dbgInit = false;
        }
    }
}

//+------------------------------------------------------------------+
//| Get timestamp with sub-second ordering                           |
//+------------------------------------------------------------------+
string MqlDebugTime() {
    MqlDateTime dt;
    TimeToStruct(TimeLocal(), dt);
    #ifdef __MQL5__
        return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.%03d",
                            dt.year, dt.mon, dt.day,
                            dt.hour, dt.min, dt.sec,
                            (int)((GetMicrosecondCount() / 1000) % 1000));
    #else
        return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.000",
                            dt.year, dt.mon, dt.day,
                            dt.hour, dt.min, dt.sec);
    #endif
}

//+------------------------------------------------------------------+
//| Core structured write                                            |
//+------------------------------------------------------------------+
void MqlDebugWrite(string structured) {
    if (!__dbgInit) MqlDebugInit();
    if (__dbgHandle == INVALID_HANDLE) return;
    MqlDebugRotate();
    FileWriteString(__dbgHandle, structured + "\n");
    FileFlush(__dbgHandle);
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

#define MQL_DBG_WATCH_STR(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|string|" + (val))

#define MQL_DBG_WATCH_BOOL(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|bool|" + ((val) ? "true" : "false"))

#define MQL_DBG_WATCH_DATETIME(varName, val) \
    MqlDebugWrite("DBG|" + MqlDebugTime() + "|" + __FILE__ + "|" + __FUNCTION__ + "|" + IntegerToString(__LINE__) + "|WATCH|" + (varName) + "|datetime|" + TimeToString((datetime)(val), TIME_DATE | TIME_SECONDS))

//+------------------------------------------------------------------+
//| Convenience: auto-detect common numeric types via overloading.   |
//| For MQL4 or ambiguous cases, prefer the typed macros above.      |
//+------------------------------------------------------------------+
#define MQL_DBG_WATCH(varName, val) MQL_DBG_WATCH_DBL(varName, val)
