//==============================================================================
// MT5 Service that looks for the existence of a file with the same
// name as the EA. If the post-compile vscode task is configured and
// the file is created, the service will detect it and reapply a 
// chart template with the same name as the EA.
//
// Usage: Compile and drag the Service to a new chart.chartId
// Enable debug logging initially to verify that it works.
//==============================================================================


//==============================================================================
// SETTINGS
//==============================================================================
input string expertNames   = "EA_Name_1,EA_Name_2";    // Comma-separated EA names, without ".tpl"
input bool showDebugOuput  = true;                    // Show debut ouput in the Experts log


//==============================================================================
// VARIABLES
//==============================================================================
string expertNamesArray[];      


//==============================================================================
// INITIALISATION
//==============================================================================
int OnInit() {

   if (expertNames == "") { Print("Expert name(s) configuration missing."); }
   else {
   
      StringSplit(expertNames, ',', expertNamesArray); 
      EventSetTimer(1);
   }

   return INIT_SUCCEEDED;
}

//==============================================================================
// COMPILE WATCHER LOOP
//==============================================================================
void OnTimer() {

   for (uint i = 0; i < expertNamesArray.Size(); i++) {
            
      string filePath = "COMPILEFLAGS\\" + expertNamesArray[i] + ".flag";
      int handle = FileOpen(filePath, FILE_READ|FILE_TXT);

      if(handle == INVALID_HANDLE) { continue; }
      else {
         FileClose(handle);   
         FileDelete(filePath);
         
         long chartId = IsExpertAdvisorOnChart(expertNamesArray[i]);
         
         if (chartId != -1) {
            if (showDebugOuput) { Print("FOUND EA " + expertNamesArray[i] + " on chart " + (string)chartId + ", applying template " + expertNamesArray[i] + ".tpl"); }
            ChartApplyTemplate(chartId, expertNamesArray[i] + ".tpl"); 
         }
      }
   }
}


//==============================================================================
// FIND AN EA AMONGST CURRENTLY OPEN CHARTS FROM EA NAME
//==============================================================================
long IsExpertAdvisorOnChart(string expertNameWanted) {

   long chartId = ChartFirst();
   
   while(chartId >= 0) {
   
      string expertNameFound = ChartGetString(chartId, CHART_EXPERT_NAME);
            
      if (showDebugOuput) { Print("CHART INFORMATION:  ChartId=", chartId, " Symbol=", ChartSymbol(chartId), " Expert=", expertNameFound); }
      
      if (expertNameFound == expertNameWanted) { return chartId; }
      else { chartId = ChartNext(chartId); }
   }
   
   return -1;
}