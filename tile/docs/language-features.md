# Language Features

MQL Clangd provides rich language support for `.mq4`, `.mq5`, and `.mqh` files through VS Code language providers. All features are active automatically without configuration.

---

## Code Completion { .api }

Provided by `ItemProvider` for `**/*.{mq4,mq5,mqh}`.

Completion sources:
1. **MQL Built-in Functions** — all MQL4/MQL5 standard library functions with parameter info
2. **MQL Constants** — `PERIOD_M1`, `MODE_SMA`, `ORDER_TYPE_BUY`, `clrRed`, etc.
3. **MQL Keywords** — `input`, `sinput`, `extern`, `#property`, `#include`, `#define`, etc.
4. **Document Symbols** — functions, variables, `input` parameters, `#define` macros, classes from the current file

Example completions triggered for MQL:
```mql5
// Typing "Order" → shows OrderSend, OrderModify, OrderClose, etc.
// Typing "PERIOD_" → shows all timeframe constants
// Typing "clr" → shows all color constants with color preview
// Typing custom function name → shows it from document symbols
```

Completion items include:
- Documentation preview on hover in completion list
- Correct `CompletionItemKind` (Function, Constant, Keyword, Variable, etc.)
- MQL-specific grouping (`input` params listed first for EA context)

---

## Signature Help { .api }

Provided by `HelpProvider` for `**/*.{mq4,mq5,mqh}`.
Triggered on `(` (opening paren) and `,` (comma).

Shows parameter signatures for MQL built-in functions:
```mql5
OrderSend(|)   // → shows: OrderSend(symbol, cmd, volume, price, slippage, ...)
iMA(symbol, period, |)  // → shows 3rd parameter: ma_period highlighted
```

---

## Hover Documentation { .api }

Provided by `Hover_MQL()` for `**/*.{mq4,mq5,mqh}`.

Hovering over MQL identifiers shows:
- **Functions**: Full signature, description, parameter descriptions, return type
- **Constants**: Numeric value, description, enum group
- **Error codes**: Description of the error
- **Color constants**: Color name, hex value, and color preview
- **Types**: Type description

```mql5
// Hover over OrderSend → shows full function documentation
// Hover over PERIOD_H1 → shows "Hourly chart, value: 60"
// Hover over ERR_TRADE_DISABLED → shows error description
```

---

## Document Symbols & Outline { .api }

Provided by `MQLDocumentSymbolProvider` for `**/*.{mq4,mq5,mqh}`.

Shows the document structure in:
- **Outline view** (Explorer sidebar)
- **Breadcrumbs** (top of editor)
- Go to Symbol in File (`Ctrl+Shift+O`)

Symbol types extracted:
- **Functions** — `int OnInit()`, `void MyFunction(...)`, etc. (excludes standard event handlers)
- **Input parameters** — `input double Lots = 0.1`
- **Variables** — `int g_magic = 12345`
- **Classes** — class/struct declarations
- **Defines** — `#define MAX_ORDERS 10`

```javascript
// Symbol extraction API (internal)
extractDocumentSymbols(document)
// Returns:
{
    variables: [{name, type, line}],
    functions: [{name, line}],
    defines:   [{name, line}],
    classes:   [{name, line}],
    inputs:    [{name, type, line}]
}
```

---

## Color Provider { .api }

Provided by `ColorProvider` for `**/*.{mq4,mq5,mqh}`.

Shows color swatches inline for MQL color literals:

| Literal Format | Example |
|---------------|---------|
| RGB decimal | `C'255,0,0'` → red swatch |
| RGB hex | `C'0xFF,0x00,0x00'` → red swatch |
| Named constant | `clrRed`, `clrBlue`, `clrForestGreen`, etc. |

Clicking the swatch opens the VS Code color picker for interactive editing.

---

## Lightweight Diagnostics { .api }

Provided without MetaEditor by `registerLightweightDiagnostics()`. Active when `mql_tools.Diagnostics.Lightweight` is `true` (default).

Updates 300ms after document changes. Checks shown in the Problems panel under collection `mql-lightweight`:

### Unnecessary Semicolon (Hint)

```mql5
// Warning: Semicolon after closing brace (not after struct/class/enum)
void OnTick()
{

};  // ← "unnecessary-semicolon" hint
```

### Assignment in Condition (Warning)

```mql5
// Warning: Assignment where comparison was likely intended
if (x = 5)  // ← "assignment-in-condition" warning
    DoSomething();

// Not warned (intentional assignment pattern):
while ((x = GetNext()) != NULL) {}  // ← not warned
```

### Unclosed String (Warning)

```mql5
string msg = "Hello World;  // ← "unclosed-string" warning (odd quote count)
```

Lines with `#property`, `#import`, `#resource` directives are excluded from this check.

### Function Typo Detection

```mql5
Ordersend(...)    // → suggests "OrderSend"
printformat(...)  // → suggests "PrintFormat"
```

Typos found via Levenshtein distance ≤ 2 against the MQL built-in function list.

---

## Quick Fixes (Code Actions) { .api }

`MqlCodeActionProvider` provides VS Code QuickFix actions for MQL diagnostics. All fix titles follow the pattern `"MQL: <description>"` for machine recognition.

### Spelling Fix: "MQL: Did you mean '<function>'?" { .api }

Triggered for: clangd "undeclared identifier", "unknown identifier", "was not declared"

Finds closest MQL built-in function names using Levenshtein distance ≤ 2. Up to 3 suggestions.

```mql5
Ordersend(symbol, cmd, vol, price, slip, sl, tp, comment, magic, exp, arrow);
// Quick fix: "MQL: Did you mean 'OrderSend'?" → replaces Ordersend with OrderSend
```

### Open Documentation: "MQL: Open documentation for '<function>'" { .api }

Triggered for: `MQL199` (wrong parameters count)

```mql5
iMA(Symbol(), PERIOD_H1);   // wrong param count → MQL199
// Quick fix: "MQL: Open documentation for 'iMA'" → opens docs.mql5.com for iMA
```

### Declare Variable: "MQL: Declare '<name>' as local <type>" { .api }

Triggered for: `MQL256` (undeclared identifier)

Inserts variable declaration at the start of the containing function. Available for types: `int`, `double`, `string`, `bool`, `color`, `datetime`, `long`.

```mql5
void OnTick()
{
    totalPips += 10;   // MQL256: totalPips undeclared
// Quick fix options:
//   "MQL: Declare 'totalPips' as local double"
//   "MQL: Declare 'totalPips' as local int"
//   ...
}
```

### Declare Input: "MQL: Declare '<name>' as input parameter" { .api }

Triggered for: `MQL256` (undeclared identifier)

Inserts `input <type> <name> = <default>;` at the appropriate position (after existing `input` declarations). Type is inferred from the identifier name:

| Name contains | Inferred type |
|---------------|--------------|
| `lot`, `volume` | `double` |
| `magic`, `period`, `shift` | `int` |
| `enable`, `use`, `show` | `bool` |
| `comment`, `symbol` | `string` |
| `color`, `clr` | `color` |
| (default) | `double` |

### Add Return: "MQL: Add return statement '<value>'" { .api }

Triggered for: `MQL117`, `MQL121` (missing return)

Inserts `return <defaultValue>;` before the closing brace of the containing function. Default values by type: `int` → `0`, `double` → `0.0`, `bool` → `false`, `string` → `""`, `color` → `clrNONE`.

### Insert Entry Point: "MQL: Insert entry point '<function>()'" { .api }

Triggered for: `MQL209` (missing OnCalculate), `MQL356` (missing OnTick/OnStart)

Appends a function skeleton at the end of the file:

```mql5
// MQL209 → inserts:
int OnCalculate(const int rates_total,
        const int prev_calculated,
        const int begin,
        const double &price[])
{
    // TODO: Implement indicator calculation
    return rates_total;
}

// MQL356 → offers:
// "MQL: Insert entry point 'OnTick()'"
void OnTick()
{
    // TODO: Implement trading logic
}

// Or:
// "MQL: Insert entry point 'OnStart()'"
void OnStart()
{
    // TODO: Implement script logic
}
```

### Use Enum Constant: "MQL: Use enum '<ENUM_VALUE>' (<description>)" { .api }

Triggered for: `MQL262` (cannot convert to enum)

Suggests correct MQL enum constants for specific functions based on parameter context. Covers:
- `ENUM_TIMEFRAMES`: `PERIOD_M1`, `PERIOD_H1`, `PERIOD_D1`, etc.
- `ENUM_MA_METHOD`: `MODE_SMA`, `MODE_EMA`, `MODE_SMMA`, `MODE_LWMA`
- `ENUM_APPLIED_PRICE`: `PRICE_CLOSE`, `PRICE_OPEN`, `PRICE_HIGH`, `PRICE_LOW`, `PRICE_MEDIAN`, `PRICE_TYPICAL`, `PRICE_WEIGHTED`
- `ENUM_APPLIED_VOLUME`: `VOLUME_TICK`, `VOLUME_REAL`
- `ENUM_ORDER_TYPE`: `ORDER_TYPE_BUY`, `ORDER_TYPE_SELL`, etc.
- `ENUM_TRADE_REQUEST_ACTIONS`: `TRADE_ACTION_DEAL`, `TRADE_ACTION_PENDING`, etc.

Mapped to functions: `iMA`, `iRSI`, `iMACD`, `iStochastic`, `iBands`, `iCCI`, `iMomentum`, `iATR`, `iADX`, `iMFI`, `iOBV`, `iVolumes`, `iAD`, `iForce`, `iChaikin`, `iEnvelopes`, `iStdDev`, `iDEMA`, `iTEMA`, `iFrAMA`, `iAMA`, `iVIDyA`, `iTriX`, `iOsMA`, `iWPR`, `iSAR`, `iRVI`, `iDeMarker`, `iFractals`, `iAC`, `iAO`, `iBWMFI`, `iBearsPower`, `iBullsPower`, `iAlligator`, `iGator`, `iIchimoku`, `CopyRates`, `CopyTime`, `CopyOpen`, `CopyHigh`, `CopyLow`, `CopyClose`, `iHighest`, `iLowest`, `SeriesInfoInteger`, `IndicatorCreate`, `OrderSend`, `OrderCheck`.

### Wrap with Conversion: "MQL: Wrap with IntegerToString()" { .api }

Triggered for: `MQL181` (implicit conversion from number to string)

```mql5
string msg = "Error: " + GetLastError();   // MQL181
// Quick fix: "MQL: Wrap with IntegerToString()" → "Error: " + IntegerToString(GetLastError())
// Quick fix: "MQL: Wrap with DoubleToString()" → wraps with DoubleToString(x, 8)
```

`IntegerToString()` is `isPreferred` when the value looks like an integer (no decimal point).

### Add clangd Include: "Add #ifdef __clang__ include for '<type>'" { .api }

Triggered for: clangd "unknown type name '<type>'"

Inserts a conditional include at the top of file:

```mql5
#ifdef __clang__
#include <TypeName.mqh>  // TODO: Adjust path if needed
#endif
```

This prevents clangd errors while keeping the file valid for MetaEditor compilation.

---

## Output Channel Features { .api }

The `mql-output` language provides navigation in the compilation output panel:

### Hover in Output Channel

Hovering over a filename in the compilation output shows a link preview.

### Ctrl+Click Navigation

Clicking on file references in the output navigates to the source location:

```text
// Compilation output format:
Checking 'C:\MT5\MQL5\Experts\MyEA.mq5' :
C:\MT5\MQL5\Experts\MyEA.mq5(45,12) : error 195: unknown identifier 'xyz'
// Ctrl+click on the file reference → opens file at line 45, column 12
```
