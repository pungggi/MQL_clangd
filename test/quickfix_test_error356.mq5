//+------------------------------------------------------------------+
//|                                      quickfix_test_error356.mq5  |
//|                        Test file for Error 356 - Missing entry point |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    return(INIT_SUCCEEDED);
}

// ERROR 356: OnTick or OnStart function not found
// Should offer: "Insert OnTick() skeleton" (for EA)
// Should offer: "Insert OnStart() skeleton" (for Script)
// This will insert the proper entry point template

