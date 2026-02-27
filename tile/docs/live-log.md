# Live Runtime Log

The Live Log feature streams MetaTrader terminal log output directly into VS Code. Two modes are supported:

| Mode | Log File | Requirement | Latency |
|------|----------|-------------|---------|
| **LiveLog** | `MQL5/Files/LiveLog.txt` | `PrintLive()` in EA | Instant (real-time) |
| **Standard Journal** | `MQL5/Logs/YYYYMMDD.log` | Standard `Print()` | Delayed (buffered) |

---

## LiveLog Mode (Recommended)

### Installation { .api }

Run `MQL: Install LiveLog Library` from the Command Palette:

```javascript
vscode.commands.executeCommand('mql_tools.installLiveLog');
```

This copies `LiveLog.mqh` from the extension bundle to your `Include` folder. The `Include5Dir`/`Include4Dir` setting is used to locate the target folder; if not set, the extension auto-detects the path.

---

### MQL5 API { .api }

```mql5
#include <LiveLog.mqh>
```

#### Shorthand Functions (Recommended) { .api }

The library header recommends these shorthands for concise logging:

```mql5
void LL(string msg)
// Shorthand for PrintLive — writes msg to LiveLog.txt immediately
// Also calls Print(msg) unless LIVELOG_REDIRECT is defined

LL("OnTick called");
LL("Bid: " + DoubleToString(Bid, 5));

void LLF(string fmt, ...)
// Shorthand for PrintFormatLive — formatted log with StringFormat patterns
// Supports up to 8 arguments; overloads for string, int, double combinations
// Also calls Print(msg) unless LIVELOG_REDIRECT is defined

LLF("Price: %.5f Volume: %d", price, (int)volume);
LLF("Error %d: %s", code, description);
```

#### Basic Logging { .api }

```mql5
void PrintLive(string message)
// Writes message immediately to LiveLog.txt with instant flush
// Accepts up to 12 string arguments (concatenated)
// No buffering — appears in VS Code immediately

PrintLive("OnTick called");
PrintLive("Bid: " + DoubleToString(Bid, 5));
```

#### Formatted Logging { .api }

```mql5
void PrintFormatLive(string format, ...)
// Formatted output (same format codes as PrintFormat/StringFormat)
// Supports: %s, %d, %f, %g, %e, %i, %u, %x, %o, %c

PrintFormatLive("Tick: %s Bid=%.5f Ask=%.5f", Symbol(), Bid, Ask);
PrintFormatLive("Order %d placed, volume=%.2f", ticket, lots);
```

#### Log Level Functions { .api }

```mql5
void LogDebugLive(string message)   // [DEBUG] prefix
void LogInfoLive(string message)    // [INFO] prefix
void LogWarnLive(string message)    // [WARN] prefix
void LogErrorLive(string message)   // [ERROR] prefix

// Non-prefixed variants (identical behavior — all write to LiveLog immediately):
void LogDebug(string message)       // same as LogDebugLive
void LogInfo(string message)        // same as LogInfoLive
void LogWarn(string message)        // same as LogWarnLive
void LogError(string message)       // same as LogErrorLive
```

Example:
```mql5
LogInfoLive("EA initialized, symbol=" + Symbol());
LogWarnLive("Spread too high: " + IntegerToString(spread));
LogErrorLive("Order failed: " + IntegerToString(GetLastError()));
```

#### Redirect Print() { .api }

Optional: redirect all standard `Print()` and `PrintFormat()` calls to LiveLog:

```mql5
#define LIVELOG_REDIRECT   // Must be BEFORE the include
#include <LiveLog.mqh>

// Now all Print() calls go to LiveLog.txt (real-time)
Print("This is real-time now");
```

#### Disabling LiveLog (Removing Dependency) { .api }

To remove the LiveLog library dependency without changing your logging calls, replace the `#include` with these substitute macros:

```mql5
// Replace: #include <LiveLog.mqh>
// With these macros to fall back to standard Print():
#define PrintLive Print
#define PrintFormatLive PrintFormat
#define LL Print
#define LLF PrintFormat
#define LogDebugLive LogDebug
#define LogInfoLive  LogInfo
#define LogWarnLive  LogWarn
#define LogErrorLive LogError
```

#### Session End Marker { .api }

```mql5
void LiveLogClose()
// Writes a "=== Session Ended ===" marker to the log file
// Call in OnDeinit for clean session boundaries

void OnDeinit(const int reason)
{
    LogInfoLive("EA deinitializing, reason=" + IntegerToString(reason));
    LiveLogClose();
}
```

---

### Log File Behavior

- **Location**: `<MQL5DataFolder>/Files/LiveLog.txt`
- **Auto-rotation**: File rotates to `LiveLog_YYYY_MM_DD.txt` when it exceeds 10MB
- **Flush**: Each write is flushed immediately (`FileFlush()`)
- **Session markers**: Timestamps and session start/end markers included automatically

---

## Standard Journal Mode

Uses MetaTrader's built-in log file. Requires no additional MQL library.

```mql5
// MQL5 - use standard Print()
Print("Message appears in journal");
PrintFormat("Tick: Bid=%.5f Ask=%.5f", Bid, Ask);
```

**Limitation**: The standard journal is buffered by MetaTrader and typically shows output with a 1-3 second delay or longer. The log file is stored at `<MQL5DataFolder>/Logs/YYYYMMDD.log`.

---

## VS Code Controls

### Starting/Stopping { .api }

```javascript
// Toggle log tailing on/off
vscode.commands.executeCommand('mql_tools.toggleTerminalLog');
```

Or click the status bar item (shows `$(record)` when active, `$(circle-outline)` when inactive).

### Switching Modes { .api }

```javascript
// Shows QuickPick to switch between LiveLog and Standard Journal
vscode.commands.executeCommand('mql_tools.switchLogMode');
```

Mode can be switched while tailing is active — the session automatically restarts.

---

## Path Detection

The extension auto-detects the MQL data folder for log tailing:

1. Checks `mql_tools.Metaeditor.Include5Dir` (or `Include4Dir`) setting
2. Traces upward from the active file to find a folder with the MQL structure
3. Checks common platform-specific paths

For manual path configuration, set `mql_tools.Metaeditor.Include5Dir`:

```jsonc
{
    "mql_tools.Metaeditor.Include5Dir": "C:\\Users\\You\\AppData\\Roaming\\MetaQuotes\\Terminal\\<id>\\MQL5"
}
```

The tailer uses the `basePath` property (one level above `Include`) to find `Files/` and `Logs/` directories.

---

## Complete EA Example

```mql5
#define LIVELOG_REDIRECT
#include <LiveLog.mqh>

input double Lots = 0.01;
input int    MagicNumber = 12345;

int OnInit()
{
    LogInfoLive(StringFormat("EA starting: %s, Lots=%.2f", Symbol(), Lots));
    return INIT_SUCCEEDED;
}

void OnTick()
{
    double bid = SymbolInfoDouble(Symbol(), SYMBOL_BID);
    double ask = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
    PrintFormatLive("Tick: Bid=%.5f Ask=%.5f", bid, ask);
}

void OnDeinit(const int reason)
{
    LogInfoLive("OnDeinit, reason=" + IntegerToString(reason));
    LiveLogClose();
}
```
