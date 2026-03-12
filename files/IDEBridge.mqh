//+------------------------------------------------------------------+
//|                                                   IDEBridge.mqh  |
//|                        MQL Clangd Extension - IDE Bridge Library  |
//+------------------------------------------------------------------+
#property copyright "MQL Clangd Extension"
#property version "1.00"
#property strict

//+------------------------------------------------------------------+
//| IDEBridge - Structured data bridge from MQL to VS Code           |
//|                                                                  |
//| Writes JSONL (one JSON object per line) to Files/IDEBridge/      |
//| with immediate FileFlush(), allowing VS Code to display trade    |
//| reports, equity curves, and metrics in real-time.                |
//|                                                                  |
//| Usage:                                                           |
//|   #include <IDEBridge.mqh>                                       |
//|                                                                  |
//|   // In OnInit():                                                |
//|   IDEBridgeInit();                                               |
//|                                                                  |
//|   // Report trades:                                              |
//|   IDEBridgeReportTrade(ticket, symbol, type, lots,               |
//|       openPrice, closePrice, profit, openTime, closeTime);       |
//|                                                                  |
//|   // Report equity:                                              |
//|   IDEBridgeReportEquity(equity, balance);                        |
//|                                                                  |
//|   // Send metrics:                                               |
//|   IDEBridgeSendMetric("win_rate", 0.65);                         |
//|                                                                  |
//|   // Log messages:                                                |
//|   IDEBridgeLog(IDE_INFO, "Signal detected");                     |
//|                                                                  |
//|   // In OnDeinit():                                              |
//|   IDEBridgeClose();                                              |
//+------------------------------------------------------------------+

// --- Configuration -----------------------------------------------------------

#define IDEBRIDGE_DIR       "IDEBridge"
#define IDEBRIDGE_TRADES    "IDEBridge\\trades.jsonl"
#define IDEBRIDGE_EQUITY    "IDEBridge\\equity.jsonl"
#define IDEBRIDGE_METRICS   "IDEBridge\\metrics.jsonl"
#define IDEBRIDGE_LOG       "IDEBridge\\log.jsonl"
#define IDEBRIDGE_MAX_SIZE  10485760  // 10 MB per file before rotation

// --- Log levels --------------------------------------------------------------

#define IDE_DEBUG  0
#define IDE_INFO   1
#define IDE_WARN   2
#define IDE_ERROR  3

// --- Global state ------------------------------------------------------------

int __ideTrades  = INVALID_HANDLE;
int __ideEquity  = INVALID_HANDLE;
int __ideMetrics = INVALID_HANDLE;
int __ideLog     = INVALID_HANDLE;
bool __ideReady  = false;

//+------------------------------------------------------------------+
//| Ensure the IDEBridge directory exists and open all channels      |
//+------------------------------------------------------------------+
bool IDEBridgeInit() {
   if (__ideReady)
      return true;

   // Create directory (MQL creates inside Files/)
   if (!FolderCreate(IDEBRIDGE_DIR)) {
      int err = GetLastError();
      // Error 4313 = folder already exists, that's fine
      if (err != 0 && err != 4313) {
         PrintFormat("IDEBridge: Failed to create directory. Error: %d", err);
         return false;
      }
   }

   __ideTrades  = IDEBridgeOpenFile(IDEBRIDGE_TRADES);
   __ideEquity  = IDEBridgeOpenFile(IDEBRIDGE_EQUITY);
   __ideMetrics = IDEBridgeOpenFile(IDEBRIDGE_METRICS);
   __ideLog     = IDEBridgeOpenFile(IDEBRIDGE_LOG);

   __ideReady = (__ideTrades != INVALID_HANDLE &&
                 __ideEquity != INVALID_HANDLE &&
                 __ideMetrics != INVALID_HANDLE &&
                 __ideLog != INVALID_HANDLE);

   if (__ideReady) {
      IDEBridgeWriteLine(__ideLog, IDEBridgeLogJSON(IDE_INFO,
         "IDEBridge initialized: " + MQLInfoString(MQL_PROGRAM_NAME)));
   } else {
      Print("IDEBridge: Failed to open one or more channels");
   }

   return __ideReady;
}

//+------------------------------------------------------------------+
//| Open a single JSONL file for append                              |
//+------------------------------------------------------------------+
int IDEBridgeOpenFile(string filename) {
   int handle = FileOpen(filename,
      FILE_WRITE | FILE_READ | FILE_TXT | FILE_UNICODE |
      FILE_SHARE_READ | FILE_SHARE_WRITE);

   if (handle == INVALID_HANDLE) {
      PrintFormat("IDEBridge: Cannot open %s. Error: %d", filename, GetLastError());
      return INVALID_HANDLE;
   }

   FileSeek(handle, 0, SEEK_END);
   return handle;
}

//+------------------------------------------------------------------+
//| Write a single line and flush immediately                        |
//+------------------------------------------------------------------+
void IDEBridgeWriteLine(int handle, string json) {
   if (handle == INVALID_HANDLE)
      return;
   FileWriteString(handle, json + "\n");
   FileFlush(handle);
}

//+------------------------------------------------------------------+
//| Rotate a file if it exceeds IDEBRIDGE_MAX_SIZE                   |
//+------------------------------------------------------------------+
void IDEBridgeRotate(int &handle, string filename) {
   if (handle == INVALID_HANDLE)
      return;

   long size = (long)FileTell(handle);
   if (size <= IDEBRIDGE_MAX_SIZE)
      return;

   FileClose(handle);
   handle = INVALID_HANDLE;

   string rotated = filename;
   StringReplace(rotated, ".jsonl", "");
   rotated += "_" + TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + ".jsonl";
   StringReplace(rotated, ".", "_");
   StringReplace(rotated, ":", "_");
   // Restore .jsonl extension
   int lastUnderscore = StringLen(rotated) - 5; // "_jsonl" length
   rotated = StringSubstr(rotated, 0, lastUnderscore) + ".jsonl";

   if (FileMove(filename, 0, rotated, FILE_REWRITE)) {
      handle = IDEBridgeOpenFile(filename);
   } else {
      PrintFormat("IDEBridge: Rotation failed for %s. Error: %d", filename, GetLastError());
   }
}

//+------------------------------------------------------------------+
//| Escape a string for JSON (minimal: quotes and backslashes)       |
//+------------------------------------------------------------------+
string IDEBridgeEscape(string s) {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\t", "\\t");
   return s;
}

//+------------------------------------------------------------------+
//| ISO-ish timestamp for JSON                                       |
//+------------------------------------------------------------------+
string IDEBridgeTimestamp() {
   MqlDateTime dt;
   TimeToStruct(TimeLocal(), dt);
#ifdef __MQL5__
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d.%03d",
      dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec,
      (GetMicrosecondCount() / 1000) % 1000);
#else
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d.000",
      dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
#endif
}

// ============================================================================
// PUBLIC API
// ============================================================================

//+------------------------------------------------------------------+
//| Report a completed trade                                         |
//+------------------------------------------------------------------+
void IDEBridgeReportTrade(long ticket, string symbol, int type,
                          double lots, double openPrice, double closePrice,
                          double profit, datetime openTime, datetime closeTime,
                          double sl = 0, double tp = 0, double commission = 0,
                          double swap = 0, string comment = "") {

   if (!__ideReady) IDEBridgeInit();
   IDEBridgeRotate(__ideTrades, IDEBRIDGE_TRADES);

   string typeStr = (type == 0) ? "buy" : (type == 1) ? "sell" : "other";

   string json = StringFormat(
      "{\"ts\":\"%s\",\"ticket\":%I64d,\"symbol\":\"%s\",\"type\":\"%s\","
      "\"lots\":%.2f,\"open_price\":%.5f,\"close_price\":%.5f,"
      "\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f,\"commission\":%.2f,"
      "\"swap\":%.2f,\"open_time\":\"%s\",\"close_time\":\"%s\","
      "\"comment\":\"%s\"}",
      IDEBridgeTimestamp(), ticket, IDEBridgeEscape(symbol), typeStr,
      lots, openPrice, closePrice, sl, tp, profit, commission, swap,
      TimeToString(openTime, TIME_DATE | TIME_SECONDS),
      TimeToString(closeTime, TIME_DATE | TIME_SECONDS),
      IDEBridgeEscape(comment));

   IDEBridgeWriteLine(__ideTrades, json);
}

//+------------------------------------------------------------------+
//| Report an equity/balance snapshot                                |
//+------------------------------------------------------------------+
void IDEBridgeReportEquity(double equity, double balance,
                           double margin = 0, double freeMargin = 0) {

   if (!__ideReady) IDEBridgeInit();
   IDEBridgeRotate(__ideEquity, IDEBRIDGE_EQUITY);

   string json = StringFormat(
      "{\"ts\":\"%s\",\"equity\":%.2f,\"balance\":%.2f,"
      "\"margin\":%.2f,\"free_margin\":%.2f}",
      IDEBridgeTimestamp(), equity, balance, margin, freeMargin);

   IDEBridgeWriteLine(__ideEquity, json);
}

//+------------------------------------------------------------------+
//| Send a named metric (key-value)                                  |
//+------------------------------------------------------------------+
void IDEBridgeSendMetric(string key, double value) {
   if (!__ideReady) IDEBridgeInit();
   IDEBridgeRotate(__ideMetrics, IDEBRIDGE_METRICS);

   string json = StringFormat(
      "{\"ts\":\"%s\",\"key\":\"%s\",\"value\":%.8f}",
      IDEBridgeTimestamp(), IDEBridgeEscape(key), value);

   IDEBridgeWriteLine(__ideMetrics, json);
}

//+------------------------------------------------------------------+
//| Send a string metric                                             |
//+------------------------------------------------------------------+
void IDEBridgeSendMetricStr(string key, string value) {
   if (!__ideReady) IDEBridgeInit();
   IDEBridgeRotate(__ideMetrics, IDEBRIDGE_METRICS);

   string json = StringFormat(
      "{\"ts\":\"%s\",\"key\":\"%s\",\"value_str\":\"%s\"}",
      IDEBridgeTimestamp(), IDEBridgeEscape(key), IDEBridgeEscape(value));

   IDEBridgeWriteLine(__ideMetrics, json);
}

//+------------------------------------------------------------------+
//| Log a message with level                                         |
//+------------------------------------------------------------------+
void IDEBridgeLog(int level, string message) {
   if (!__ideReady) IDEBridgeInit();
   IDEBridgeRotate(__ideLog, IDEBRIDGE_LOG);

   IDEBridgeWriteLine(__ideLog, IDEBridgeLogJSON(level, message));

#ifndef IDEBRIDGE_SILENT
   Print(message);
#endif
}

//+------------------------------------------------------------------+
//| Build a log JSON line (internal helper)                          |
//+------------------------------------------------------------------+
string IDEBridgeLogJSON(int level, string message) {
   string lvl;
   switch (level) {
      case IDE_DEBUG: lvl = "DEBUG"; break;
      case IDE_INFO:  lvl = "INFO";  break;
      case IDE_WARN:  lvl = "WARN";  break;
      case IDE_ERROR: lvl = "ERROR"; break;
      default:        lvl = "INFO";  break;
   }

   return StringFormat(
      "{\"ts\":\"%s\",\"level\":\"%s\",\"msg\":\"%s\",\"ea\":\"%s\"}",
      IDEBridgeTimestamp(), lvl, IDEBridgeEscape(message),
      IDEBridgeEscape(MQLInfoString(MQL_PROGRAM_NAME)));
}

//+------------------------------------------------------------------+
//| Report all historical trades from account (convenience)          |
//| Call once after a backtest to dump the full deal history          |
//+------------------------------------------------------------------+
#ifdef __MQL5__
void IDEBridgeReportHistory() {
   if (!__ideReady) IDEBridgeInit();

   if (!HistorySelect(0, TimeCurrent())) {
      IDEBridgeLog(IDE_ERROR, "Failed to select deal history");
      return;
   }

   int total = HistoryDealsTotal();
   int reported = 0;

   for (int i = 0; i < total; i++) {
      ulong ticket = HistoryDealGetTicket(i);
      if (ticket == 0) continue;

      long dealType  = HistoryDealGetInteger(ticket, DEAL_TYPE);
      long dealEntry = HistoryDealGetInteger(ticket, DEAL_ENTRY);

      // Only report trade exits (DEAL_ENTRY_OUT / DEAL_ENTRY_INOUT)
      if (dealEntry != DEAL_ENTRY_OUT && dealEntry != DEAL_ENTRY_INOUT)
         continue;

      string symbol    = HistoryDealGetString(ticket, DEAL_SYMBOL);
      double lots      = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double price     = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double profit    = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double commission = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      double swap      = HistoryDealGetDouble(ticket, DEAL_SWAP);
      datetime time    = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      string comment   = HistoryDealGetString(ticket, DEAL_COMMENT);

      int type = (dealType == DEAL_TYPE_BUY) ? 0 : 1;

      // For exit deals, we report the exit info. Open price/time would
      // require matching the position, which we simplify here.
      IDEBridgeReportTrade((long)ticket, symbol, type, lots,
                           0, price, profit, 0, time,
                           0, 0, commission, swap, comment);
      reported++;
   }

   IDEBridgeLog(IDE_INFO, StringFormat("Reported %d deals from history", reported));
}
#endif

//+------------------------------------------------------------------+
//| Close all file handles cleanly                                   |
//+------------------------------------------------------------------+
void IDEBridgeClose() {
   if (__ideLog != INVALID_HANDLE) {
      IDEBridgeWriteLine(__ideLog, IDEBridgeLogJSON(IDE_INFO, "IDEBridge session ended"));
   }

   if (__ideTrades  != INVALID_HANDLE) { FileClose(__ideTrades);  __ideTrades  = INVALID_HANDLE; }
   if (__ideEquity  != INVALID_HANDLE) { FileClose(__ideEquity);  __ideEquity  = INVALID_HANDLE; }
   if (__ideMetrics != INVALID_HANDLE) { FileClose(__ideMetrics); __ideMetrics = INVALID_HANDLE; }
   if (__ideLog     != INVALID_HANDLE) { FileClose(__ideLog);     __ideLog     = INVALID_HANDLE; }

   __ideReady = false;
}
//+------------------------------------------------------------------+
