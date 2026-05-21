//==============================================================================
// MT5 Service that looks for the existence of a file with the same
// name as the EA. If the post-compile VS Code task is configured and
// the file is created, the service will detect it and reapply a
// chart template with the same name as the EA.
//
// Usage: Compile, then start the Service from the Navigator (Services).
// Enable debug logging initially to verify that it works.
//==============================================================================

#property service
#property version   "1.00"


//==============================================================================
// SETTINGS
//==============================================================================
input string expertNames      = "EA_Name_1,EA_Name_2";   // Comma-separated EA names, without ".tpl"
input bool   showDebugOutput  = true;                    // Show debug output in the Experts log


//==============================================================================
// VARIABLES
//==============================================================================
string expertNamesArray[];


//==============================================================================
// FIND AN EA AMONGST CURRENTLY OPEN CHARTS FROM EA NAME
//==============================================================================
long IsExpertAdvisorOnChart(string expertNameWanted) {

   long chartId = ChartFirst();

   while(chartId >= 0) {

      string expertNameFound = ChartGetString(chartId, CHART_EXPERT_NAME);

      if (showDebugOutput) { Print("CHART INFORMATION:  ChartId=", chartId, " Symbol=", ChartSymbol(chartId), " Expert=", expertNameFound); }

      if (expertNameFound == expertNameWanted) { return chartId; }
      else { chartId = ChartNext(chartId); }
   }

   return -1;
}


//==============================================================================
// COMPILE WATCHER TICK
//==============================================================================
void CheckCompileFlags() {

   for (int i = 0; i < ArraySize(expertNamesArray); i++) {

      string name = expertNamesArray[i];
      if (name == "") { continue; }

      string filePath = "COMPILEFLAGS\\" + name + ".flag";
      int handle = FileOpen(filePath, FILE_READ|FILE_TXT);

      if (handle == INVALID_HANDLE) { continue; }

      FileClose(handle);

      if (!FileDelete(filePath)) {
         Print("Failed to delete flag ", filePath, " error=", GetLastError());
         continue;
      }

      long chartId = IsExpertAdvisorOnChart(name);
      if (chartId == -1) {
         if (showDebugOutput) { Print("EA ", name, " not found on any chart, skipping template apply."); }
         continue;
      }

      if (showDebugOutput) { Print("FOUND EA ", name, " on chart ", chartId, ", applying template ", name, ".tpl"); }
      if (!ChartApplyTemplate(chartId, name + ".tpl")) {
         Print("ChartApplyTemplate failed for ", name, " on chart ", chartId, " error=", GetLastError());
      }
   }
}


//==============================================================================
// SERVICE ENTRY POINT
//==============================================================================
void OnStart() {

   if (expertNames == "") {
      Print("Expert name(s) configuration missing.");
      return;
   }

   StringSplit(expertNames, ',', expertNamesArray);

   for (int i = 0; i < ArraySize(expertNamesArray); i++) {
      expertNamesArray[i] = StringTrimLeft(StringTrimRight(expertNamesArray[i]));
   }

   while (!IsStopped()) {
      CheckCompileFlags();
      Sleep(1000);
   }
}
