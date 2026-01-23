//+------------------------------------------------------------------+
//|                                      quickfix_test_error209.mq5  |
//|                        Test file for Error 209 - Missing OnCalculate |
//+------------------------------------------------------------------+
#property copyright "Test"
#property indicator_chart_window
#property indicator_buffers 1
#property indicator_plots   1

// Indicator buffer
double BufferMain[];

//+------------------------------------------------------------------+
//| Custom indicator initialization function                         |
//+------------------------------------------------------------------+
int OnInit()
{
    SetIndexBuffer(0, BufferMain, INDICATOR_DATA);
    return(INIT_SUCCEEDED);
}

// ERROR 209: OnCalculate function not found
// Should offer: "Insert OnCalculate() skeleton"
// This will insert the proper OnCalculate template for indicators

