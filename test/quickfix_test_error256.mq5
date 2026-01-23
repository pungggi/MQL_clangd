//+------------------------------------------------------------------+
//|                                      quickfix_test_error256.mq5  |
//|                        Test file for Error 256 - Undeclared ID   |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    // ERROR 256: Undeclared identifier 'Lots'
    // Should offer: "Declare 'Lots' as input parameter" (preferred)
    // Should offer: "Declare 'Lots' as int/double/string/etc."
    double volume = Lots;
    
    // ERROR 256: Undeclared identifier 'MagicNumber'
    // Should offer: "Declare 'MagicNumber' as input parameter" (preferred)
    int magic = MagicNumber;
    
    // ERROR 256: Undeclared identifier 'EnableTrading'
    // Should offer: "Declare 'EnableTrading' as input parameter" (preferred)
    if (EnableTrading) {
        // Trade logic
    }
    
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    // Test code
}

