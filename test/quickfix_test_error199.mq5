//+------------------------------------------------------------------+
//|                                      quickfix_test_error199.mq5  |
//|                        Test file for Error 199 - Wrong params    |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    // ERROR 199: Wrong parameters count
    // Should offer: "📖 Show documentation for 'OrderSend'"
    OrderSend(Symbol(), OP_BUY);  // Missing many required parameters
    
    // ERROR 199: Wrong parameters count  
    // Should offer: "📖 Show documentation for 'iMA'"
    iMA(Symbol());  // Missing required parameters
    
    // ERROR 199: Wrong parameters count
    // Should offer: "📖 Show documentation for 'iRSI'"
    iRSI(Symbol(), 14);  // Missing required parameters
    
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    // Test code
}

