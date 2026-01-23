//+------------------------------------------------------------------+
//|                                      quickfix_test_error262.mq5  |
//|                        Test file for Error 262 - Cannot convert to enum |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    // ERROR 262: Cannot convert to enumeration
    // Should offer: "Replace with PERIOD_CURRENT", "Replace with PERIOD_H1", etc.
    int ma_handle = iMA(Symbol(), 0, 14, 0, MODE_SMA, PRICE_CLOSE);
    
    // ERROR 262: Cannot convert to enumeration
    // Should offer: "Replace with PERIOD_CURRENT", "Replace with PERIOD_H1", etc.
    int rsi_handle = iRSI(Symbol(), 0, 14, PRICE_CLOSE);
    
    // ERROR 262: Cannot convert to enumeration
    // Should offer enum suggestions for CopyRates
    MqlRates rates[];
    CopyRates(Symbol(), 0, 0, 100, rates);
    
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    // Test code
}

