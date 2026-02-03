//+------------------------------------------------------------------+
//|                                                   ExportData.mq5 |
//|                                  Copyright 2026, ngSoftware |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, ngSoftware"
#property link "https://www.mql5.com"
#property version "1.00"
#property script_show_inputs

input int InpBars = 1000; // Number of bars to export

//+------------------------------------------------------------------+
//| Script program start function                                    |
//+------------------------------------------------------------------+
void OnStart() {
  MqlRates rates[];
  ArraySetAsSeries(rates, true);

  int copied = CopyRates(_Symbol, _Period, 0, InpBars, rates);

  if (copied <= 0) {
    Print("Failed to copy rates. Error: ", GetLastError());
    return;
  }

  string fileName = "market_data.json";
  int fileHandle = FileOpen(fileName, FILE_WRITE | FILE_TXT | FILE_COMMON);

  if (fileHandle == INVALID_HANDLE) {
    Print("Failed to open file: ", fileName, " Error: ", GetLastError());
    // Try local folder if common fails (depends on permissions/sandbox)
    fileHandle = FileOpen(fileName, FILE_WRITE | FILE_TXT);
    if (fileHandle == INVALID_HANDLE) {
      Print("Failed to open file in local folder either.");
      return;
    }
  }

  // Manual JSON construction for simplicity in PoC
  FileWrite(fileHandle, "[");

  for (int i = copied - 1; i >= 0; i--) {
    string jsonObject =
        StringFormat("{\"time\": %I64d, \"open\": %.5f, \"high\": %.5f, "
                     "\"low\": %.5f, \"close\": %.5f, \"volume\": %I64d}",
                     rates[i].time, rates[i].open, rates[i].high, rates[i].low,
                     rates[i].close, rates[i].tick_volume);

    if (i > 0)
      jsonObject += ",";
    FileWrite(fileHandle, jsonObject);
  }

  FileWrite(fileHandle, "]");
  FileClose(fileHandle);

  Print("Data exported to ", fileName, ". Total bars: ", copied);
}
//+------------------------------------------------------------------+
