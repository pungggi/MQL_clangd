//+------------------------------------------------------------------+
//|                                                      LiveLog.mqh |
//|                             MQL Tools Extension - Real-Time Log  |
//+------------------------------------------------------------------+
#property copyright "MQL Tools Extension"
#property version "1.20"
#property strict

//+------------------------------------------------------------------+
//| LiveLog - Real-time logging library for MQL4/MQL5                |
//|                                                                  |
//| This library provides logging functions that flush to disk       |
//| immediately, allowing VS Code to display logs in real-time.      |
//|                                                                  |
//| Usage:                                                           |
//|   #include <LiveLog.mqh>                                         |
//|                                                                  |
//|   // Use these functions for real-time output:                   |
//|   LL("Simple message");                                          |
//|   LL("Value: " + IntegerToString(myInt));                        |
//|   LLF("Price: %.5f Volume: %d", price, (int)volume);             |
//|                                                                  |
//| Shorthand:                                                       |
//|   LL(msg)           - Log message (converts any type)            |
//|   LLF(fmt, ...)     - Log with format string (up to 8 args)      |
//+------------------------------------------------------------------+

// Configuration
#define LIVELOG_FILENAME "LiveLog.txt"
#define LIVELOG_MAX_SIZE 10485760 // 10 MB - auto-rotate when exceeded

// Global state
int __llHandle = INVALID_HANDLE;
bool __llInit = false;

//+------------------------------------------------------------------+
//| Initialize the live log file                                     |
//+------------------------------------------------------------------+
bool LiveLogInit() {
  if (__llInit && __llHandle != INVALID_HANDLE)
    return true;

  __llHandle =
      FileOpen(LIVELOG_FILENAME, FILE_WRITE | FILE_READ | FILE_TXT | FILE_ANSI |
                                     FILE_SHARE_READ | FILE_SHARE_WRITE);

  if (__llHandle == INVALID_HANDLE) {
    PrintFormat("LiveLog: Failed to open file. Error: %d", GetLastError());
    return false;
  }

  FileSeek(__llHandle, 0, SEEK_END);
  __llInit = true;

  string header =
      StringFormat("\n=== LiveLog Started: %s ===\n",
                   TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS));
  FileWriteString(__llHandle, header);
  FileFlush(__llHandle);

  return true;
}

//+------------------------------------------------------------------+
//| Close the live log file                                          |
//+------------------------------------------------------------------+
void LiveLogClose() {
  if (__llHandle != INVALID_HANDLE) {
    FileWriteString(__llHandle, "=== LiveLog Ended ===\n");
    FileFlush(__llHandle);
    FileClose(__llHandle);
    __llHandle = INVALID_HANDLE;
  }
  __llInit = false;
}

//+------------------------------------------------------------------+
//| Check file size and rotate if needed                             |
//+------------------------------------------------------------------+
void LiveLogRotate() {
  if (__llHandle == INVALID_HANDLE)
    return;

  long size = (long)FileTell(__llHandle);
  if (size > LIVELOG_MAX_SIZE) {
    FileClose(__llHandle);

    string newName = "LiveLog_" + TimeToString(TimeLocal(), TIME_DATE) + ".txt";
    StringReplace(newName, ".", "_");
    StringReplace(newName, ":", "_");

    FileMove(LIVELOG_FILENAME, 0, newName, FILE_REWRITE);

    __llHandle =
        FileOpen(LIVELOG_FILENAME, FILE_WRITE | FILE_TXT | FILE_ANSI |
                                       FILE_SHARE_READ | FILE_SHARE_WRITE);

    if (__llHandle != INVALID_HANDLE) {
      FileWriteString(__llHandle, "=== LiveLog Rotated ===\n");
      FileFlush(__llHandle);
    }
  }
}

//+------------------------------------------------------------------+
//| Get timestamp with milliseconds                                  |
//+------------------------------------------------------------------+
string LiveLogTime() {
  MqlDateTime dt;
  TimeToStruct(TimeLocal(), dt);
  return StringFormat("%04d.%02d.%02d %02d:%02d:%02d.%03d", dt.year, dt.mon,
                      dt.day, dt.hour, dt.min, dt.sec, GetTickCount() % 1000);
}

//+------------------------------------------------------------------+
//| Core write function                                              |
//+------------------------------------------------------------------+
void LiveLogWrite(string msg) {
  if (!__llInit)
    LiveLogInit();
  if (__llHandle == INVALID_HANDLE)
    return;

  LiveLogRotate();

  string line = LiveLogTime() + " | " + msg + "\n";
  FileWriteString(__llHandle, line);
  FileFlush(__llHandle);
}

//+------------------------------------------------------------------+
//| LL - Main logging function (string)                              |
//+------------------------------------------------------------------+
void LL(string msg) {
  LiveLogWrite(msg);
  Print(msg);
}

//+------------------------------------------------------------------+
//| LLF - Formatted logging (like PrintFormat)                       |
//| Use StringFormat patterns: %d, %f, %.5f, %s, etc.                |
//+------------------------------------------------------------------+
void LLF(string fmt, string a1 = "", string a2 = "", string a3 = "",
         string a4 = "", string a5 = "", string a6 = "", string a7 = "",
         string a8 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4, a5, a6, a7, a8);
  LiveLogWrite(msg);
  Print(msg);
}

// Integer overloads for common cases
void LLF(string fmt, int a1, string a2 = "", string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, double a1, string a2 = "", string a3 = "",
         string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, int a1, int a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, double a1, double a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, string a1, double a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, string a1, int a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, int a1, double a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

void LLF(string fmt, double a1, int a2, string a3 = "", string a4 = "") {
  string msg = StringFormat(fmt, a1, a2, a3, a4);
  LiveLogWrite(msg);
  Print(msg);
}

//+------------------------------------------------------------------+
//| Level-prefixed logging                                           |
//+------------------------------------------------------------------+
void LogDebug(string msg) { LL("[DEBUG] " + msg); }
void LogInfo(string msg) { LL("[INFO] " + msg); }
void LogWarn(string msg) { LL("[WARN] " + msg); }
void LogError(string msg) { LL("[ERROR] " + msg); }

//+------------------------------------------------------------------+
//| PrintLive - Similar to Print() but with immediate file flush     |
//| Accepts up to 12 string arguments (will be concatenated)         |
//| NOTE: MQL will auto-convert numbers to strings (may show warning)|
//| For cleaner code, use explicit conversion: IntegerToString(x)    |
//+------------------------------------------------------------------+
void PrintLive(string a1, string a2 = "", string a3 = "", string a4 = "",
               string a5 = "", string a6 = "", string a7 = "", string a8 = "",
               string a9 = "", string a10 = "", string a11 = "",
               string a12 = "") {
  string msg = a1;
  if (a2 != "")
    msg += a2;
  if (a3 != "")
    msg += a3;
  if (a4 != "")
    msg += a4;
  if (a5 != "")
    msg += a5;
  if (a6 != "")
    msg += a6;
  if (a7 != "")
    msg += a7;
  if (a8 != "")
    msg += a8;
  if (a9 != "")
    msg += a9;
  if (a10 != "")
    msg += a10;
  if (a11 != "")
    msg += a11;
  if (a12 != "")
    msg += a12;
  LL(msg);
}

//+------------------------------------------------------------------+
//| PrintFormatLive - Alias for LLF (formatted log + print)          |
//+------------------------------------------------------------------+
void PrintFormatLive(string fmt, string a1 = "", string a2 = "", string a3 = "",
                     string a4 = "", string a5 = "", string a6 = "",
                     string a7 = "", string a8 = "") {
  LLF(fmt, a1, a2, a3, a4, a5, a6, a7, a8);
}

void PrintFormatLive(string fmt, int a1, string a2 = "", string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, double a1, string a2 = "", string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, int a1, int a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, double a1, double a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, string a1, double a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, string a1, int a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, int a1, double a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

void PrintFormatLive(string fmt, double a1, int a2, string a3 = "",
                     string a4 = "") {
  LLF(fmt, a1, a2, a3, a4);
}

//+------------------------------------------------------------------+
//| Level-prefixed Live versions                                     |
//+------------------------------------------------------------------+
void LogDebugLive(string msg) { LogDebug(msg); }
void LogInfoLive(string msg) { LogInfo(msg); }
void LogWarnLive(string msg) { LogWarn(msg); }
void LogErrorLive(string msg) { LogError(msg); }

//+------------------------------------------------------------------+
//| AUTOMATIC REDIRECTION (opt-in)                                    |
//| Define LIVELOG_REDIRECT before including this file to             |
//| automatically redirect Print() to PrintLive()                     |
//|                                                                  |
//| Usage in your EA:                                                 |
//|   #define LIVELOG_REDIRECT                                        |
//|   #include <LiveLog.mqh>                                          |
//|                                                                  |
//| Now all Print() calls will write to LiveLog.txt                   |
//+------------------------------------------------------------------+
#ifdef LIVELOG_REDIRECT
#define Print PrintLive
#define PrintFormat PrintFormatLive
#endif

//+------------------------------------------------------------------+
//| USAGE:                                                           |
//|                                                                  |
//| Option 1: Use "Live" functions directly:                          |
//|   PrintLive("Message");                                          |
//|   PrintFormatLive("Value: %d", 42);                              |
//|                                                                  |
//| Option 2: Redirect all Print() calls (add before include):        |
//|   #define LIVELOG_REDIRECT                                        |
//|   #include <LiveLog.mqh>                                          |
//|                                                                  |
//| To DISABLE live logging (use standard Print instead):            |
//| Replace the #include with these macros:                          |
//|                                                                  |
//|   #define PrintLive Print                                        |
//|   #define PrintFormatLive printf                                 |
//|   #define LogDebugLive LogDebug                                  |
//|   #define LogInfoLive LogInfo                                    |
//|   #define LogWarnLive LogWarn                                    |
//|   #define LogErrorLive LogError                                  |
//|                                                                  |
//| TIP: Call LiveLogClose() in OnDeinit() for clean session end.    |
//+------------------------------------------------------------------+
