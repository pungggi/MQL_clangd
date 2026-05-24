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
// APPLY TEMPLATE TO ALL CHARTS WITH THE MATCHING EA
//==============================================================================
void ApplyTemplateToChartsWithEA(string expertNameWanted) {

   long chartId = ChartFirst();
   bool foundAny = false;

   while(chartId >= 0) {

      string expertNameFound = ChartGetString(chartId, CHART_EXPERT_NAME);

      if (showDebugOutput) { Print("CHART INFORMATION:  ChartId=", chartId, " Symbol=", ChartSymbol(chartId), " Expert=", expertNameFound); }

      if (expertNameFound == expertNameWanted) {
         foundAny = true;
         if (showDebugOutput) { Print("FOUND EA ", expertNameWanted, " on chart ", chartId, ", applying template ", expertNameWanted, ".tpl"); }
         if (!ChartApplyTemplate(chartId, expertNameWanted + ".tpl")) {
            Print("ChartApplyTemplate failed for ", expertNameWanted, " on chart ", chartId, " error=", GetLastError());
         }
      }
      chartId = ChartNext(chartId);
   }

   if (!foundAny) {
      if (showDebugOutput) { Print("EA ", expertNameWanted, " not found on any chart, skipping template apply."); }
   }
}


//==============================================================================
// COMPILE WATCHER TICK
//==============================================================================
void CheckCompileFlags() {

   for (int i = 0; i < ArraySize(expertNamesArray); i++) {

      string name = expertNamesArray[i];
      if (name == "") { continue; }

      string filePath = "COMPILEFLAGS\\" + name + ".flag";
      if (!FileIsExist(filePath)) { continue; }

      if (!FileDelete(filePath)) {
         Print("Failed to delete flag ", filePath, " error=", GetLastError());
         continue;
      }

      ApplyTemplateToChartsWithEA(name);
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
      StringTrimLeft(expertNamesArray[i]);
      StringTrimRight(expertNamesArray[i]);
   }

   while (!IsStopped()) {
      CheckCompileFlags();
      Sleep(1000);
   }
}
