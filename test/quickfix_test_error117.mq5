//+------------------------------------------------------------------+
//|                                      quickfix_test_error117.mq5  |
//|                        Test file for Error 117/121 - Missing return |
//+------------------------------------------------------------------+
#property copyright "Test"
#property version   "1.00"

//+------------------------------------------------------------------+
//| Calculate something                                              |
//+------------------------------------------------------------------+
int CalculateValue()
{
    int result = 42;
    
    // ERROR 117/121: Function must return a value
    // Should offer: "Add 'return 0;' at end of function"
    // (Missing return statement)
}

//+------------------------------------------------------------------+
//| Get price                                                        |
//+------------------------------------------------------------------+
double GetPrice()
{
    double price = 1.2345;
    
    // ERROR 117/121: Function must return a value
    // Should offer: "Add 'return 0.0;' at end of function"
    // (Missing return statement)
}

//+------------------------------------------------------------------+
//| Check condition                                                  |
//+------------------------------------------------------------------+
bool IsValid()
{
    bool valid = true;
    
    // ERROR 117/121: Function must return a value
    // Should offer: "Add 'return false;' at end of function"
    // (Missing return statement)
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
    int val = CalculateValue();
    double price = GetPrice();
    bool valid = IsValid();
}

