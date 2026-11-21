//==============================================================================
// ArrangeLayoutService — window-move executor for the VS Code "MQL Clangd"
// extension. Enables "MQL: Arrange MT5 Charts" on Wine / Linux / macOS,
// where the extension's PowerShell worker cannot run.
//
// HOW IT WORKS (all layout math lives in the extension, this service only
// executes window moves — see docs/chart-layout.md):
//   MQL5/Files/mql_clangd_arrange/
//     state.txt  written by this service ~every 3 s (and after each request):
//                charts (hwnd;SYMBOL;period;docked), the main window handle,
//                the MDI client size, and all monitors (rect + work area).
//     req.txt    written by the extension: main=h,x,y,w,h / move=h,x,y,w,h /
//                min=h lines. Rects are the VISIBLE target rects; top-level
//                windows are expanded by their invisible resize frame here.
//     res.txt    written by this service: "ok moved=N min=M skipped=K" or
//                "err <reason>". The extension waits for this line.
//
// SETUP (once):
//   1. Copy this file into <terminal data folder>/MQL5/Services/.
//   2. Compile it in MetaEditor (F7).
//   3. Navigator -> Services -> right-click ArrangeLayoutService -> Add Service.
//      In the dialog enable "Allow DLL imports" (or enable it globally under
//      Tools -> Options -> Expert Advisors). This service only calls user32
//      move/size APIs.
//   5. In VS Code, set mql_tools.Metaeditor.Include5Dir to that terminal's
//      MQL5 folder (Wine setups need it for the backtest feature anyway).
//
// The extension targets THE terminal this service runs in. Docked grid rects
// are MDI-client coordinates; floating charts and the main window use screen
// coordinates — identical to the Windows/PowerShell backend's math.
//==============================================================================

#property service
#property version   "1.00"
#property description "Executor for Arrange MT5 Charts (VS Code MQL Clangd). Watches mql_clangd_arrange/req.txt and applies window moves."

// Structs must be declared BEFORE the #import block that references them.
struct RECT { int left; int top; int right; int bottom; };
struct POINT { int x; int y; };
struct MONITORINFO { int cbSize; RECT rcMonitor; RECT rcWork; uint dwFlags; };

#import "user32.dll"
long GetParent(long hWnd);
long GetAncestor(long hWnd, uint gaFlags);          // GA_ROOT = 2
int  GetWindowLongW(long hWnd, int nIndex);         // GWL_STYLE = -16
bool MoveWindow(long hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
bool SetWindowPos(long hWnd, long hWndAfter, int X, int Y, int cx, int cy, uint uFlags);
bool ShowWindow(long hWnd, int nCmdShow);
bool GetClientRect(long hWnd, RECT &rect);
bool GetWindowRect(long hWnd, RECT &rect);
bool ClientToScreen(long hWnd, POINT &point);
int  GetSystemMetrics(int nIndex);
long MonitorFromRect(RECT &rect, uint dwFlags);   // MONITOR_DEFAULTTONEAREST = 2
bool GetMonitorInfoW(long hMonitor, MONITORINFO &info);
int  GetWindowTextW(long hWnd, ushort &buffer[], int nMaxCount);
int  GetClassNameW(long hWnd, ushort &buffer[], int nMaxCount);
#import

// --- constants (winuser.h) ---
#define GA_ROOT          2
#define GA_ROOTOWNER     3
#define GWL_STYLE      (-16)
#define WS_CHILD    0x40000000
#define SW_MINIMIZE      6
#define SW_RESTORE       9
#define SWP_NOZORDER  0x0004
#define SWP_NOACTIVATE 0x0010
#define SM_CXSIZEFRAME   32
#define SM_CYSIZEFRAME   33
#define SM_CXPADDEDBORDER 92
#define SM_XVIRTUALSCREEN   76
#define SM_YVIRTUALSCREEN   77
#define SM_CXVIRTUALSCREEN  78
#define SM_CYVIRTUALSCREEN  79
#define SM_CXSCREEN       0
#define SM_CYSCREEN       1
#define MONITOR_DEFAULTTONEAREST 2
#define MAX_MONITORS     16

#define STATE_FILE "mql_clangd_arrange\\state.txt"
#define STATE_TMP  "mql_clangd_arrange\\state.tmp"
#define REQ_FILE   "mql_clangd_arrange\\req.txt"
#define RES_FILE   "mql_clangd_arrange\\res.txt"
#define RES_TMP    "mql_clangd_arrange\\res.tmp"
#define POLL_MS    250
#define STATE_EVERY_MS 3000

struct ChartInfo {
   long   hwnd;
   string symbol;
   int    period;    // ChartPeriod() minutes
   bool   docked;
};
struct MoveReq {
   long hwnd;
   int  x, y, w, h;
};

//==============================================================================
// helpers
//==============================================================================
string TrimAll(string s)
{
   int a = 0, b = StringLen(s) - 1;
   while(a <= b) {
      ushort ch = StringGetCharacter(s, a);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') a++;
      else break;
   }
   while(b >= a) {
      ushort ch = StringGetCharacter(s, b);
      if(ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') b--;
      else break;
   }
   if(b < a) return "";
   return StringSubstr(s, a, b - a + 1);
}

int SplitString(const string s, const ushort sep, string &parts[])
{
   ArrayFree(parts);
   if(StringLen(s) == 0) return 0;
   int start = 0;
   for(int i = 0; i < StringLen(s); i++) {
      if(StringGetCharacter(s, i) == sep) {
         int n = ArraySize(parts);
         ArrayResize(parts, n + 1);
         parts[n] = StringSubstr(s, start, i - start);
         start = i + 1;
      }
   }
   int n = ArraySize(parts);
   ArrayResize(parts, n + 1);
   parts[n] = StringSubstr(s, start);
   return ArraySize(parts);
}

string MainWindowTitle(long hwnd)
{
   ushort buf[512];
   ArrayInitialize(buf, 0);
   int len = GetWindowTextW(hwnd, buf, 512);
   if(len <= 0) return "";
   return ShortArrayToString(buf);
}

// Port of the PowerShell backend's active-symbol heuristic: the main title
// ends with the ACTIVE chart's "SYMBOL,TF" after the last " - " segment.
string ActiveSymbolOf(long main)
{
   string title = MainWindowTitle(main);
   int last = -1;
   for(int i = 0; i + 2 < StringLen(title); i++)
      if(StringGetCharacter(title, i) == ' ' &&
         StringGetCharacter(title, i + 1) == '-' &&
         StringGetCharacter(title, i + 2) == ' ')
         last = i;
   string seg = (last >= 0) ? StringSubstr(title, last + 3) : title;
   int comma = StringFind(seg, ",");
   if(comma > 0) seg = StringSubstr(seg, 0, comma);
   return TrimAll(seg);
}

bool IsMdiClient(long hwnd)
{
   ushort buf[64];
   int n = GetClassNameW(hwnd, buf, 64);
   if(n <= 0) return false;
   string cls;
   for(int i = 0; i < n; i++) cls += ShortToString(buf[i]);
   return (cls == "MDIClient");
}

int EnumerateCharts(ChartInfo &charts[])
{
   ArrayFree(charts);
   long id = ChartFirst();
   while(id >= 0) {
      long hwnd = ChartGetInteger(id, CHART_WINDOW_HANDLE);
      if(hwnd != 0) {
         long p = GetParent(hwnd);
         if(p != 0 && !IsMdiClient(p)) {
            // Current MT5 builds wrap each docked chart in an MDI child
            // FRAME: CHART_WINDOW_HANDLE is the inner VIEW (view -> frame ->
            // MDIClient). Moving the view leaves the frame behind and MFC
            // re-tiles the frames. Operate on the frame instead: its parent
            // is the MDI client, so MoveWindow coordinates (and mdi= in
            // state.txt) line up exactly.
            hwnd = p;
            p = GetParent(hwnd);
         }
         int n = ArraySize(charts);
         ArrayResize(charts, n + 1);
         charts[n].hwnd   = hwnd;
         charts[n].symbol = ChartSymbol(id);
         // ChartPeriod() returns ENUM_TIMEFRAMES, where H1 is 16385 — NOT
         // minutes. Publish plain minutes (what state.txt / the extension
         // expect) via PeriodSeconds().
         charts[n].period = (int)(PeriodSeconds(ChartPeriod(id)) / 60);
         charts[n].docked = (p != 0);   // MDI child (frame) -> docked
      }
      id = ChartNext(id);
   }
   return ArraySize(charts);
}

long MainHwndOf(const ChartInfo &charts[])
{
   if(ArraySize(charts) == 0) return 0;
   // GA_ROOT of a FLOATING chart returns the chart window itself (it is
   // top-level). GA_ROOTOWNER walks parents AND owners, so it lands on the
   // terminal frame for both docked and floating charts.
   long root = GetAncestor(charts[0].hwnd, GA_ROOTOWNER);
   if(root != 0) return root;
   return GetAncestor(charts[0].hwnd, GA_ROOT);
}

bool ChartSetContains(const ChartInfo &charts[], long hwnd)
{
   for(int i = 0; i < ArraySize(charts); i++)
      if(charts[i].hwnd == hwnd) return true;
   return false;
}

string ChartSignature(const ChartInfo &charts[], long main)
{
   string s = "m" + (string)main;
   for(int i = 0; i < ArraySize(charts); i++)
      s += "|" + (string)charts[i].hwnd + "," + charts[i].symbol + "," +
           (string)charts[i].period + "," + (string)(charts[i].docked ? 1 : 0);
   return s;
}

// Write text via a temp file + FileMove so the extension never reads a
// half-written file (it does the same on its side).
bool WriteTextAtomic(const string finalPath, const string tmpPath, const string text)
{
   // Write as ANSI with explicit CRLF: split on \n and write \r\n lines.
   int h = FileOpen(tmpPath, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) { Print("cannot write ", tmpPath, " err=", GetLastError()); return false; }
   string lines[];
   int n = SplitString(text, '\n', lines);
   for(int i = 0; i < n; i++) {
      string line = lines[i];
      if(StringLen(line) > 0 && StringGetCharacter(line, StringLen(line) - 1) == '\r')
         line = StringSubstr(line, 0, StringLen(line) - 1);
      FileWriteString(h, line);
      if(i < n - 1) FileWriteString(h, "\r\n");
   }
   FileClose(h);
   if(!FileMove(tmpPath, 0, finalPath, FILE_REWRITE)) {
      Print("cannot move ", tmpPath, " -> ", finalPath, " err=", GetLastError());
      return false;
   }
   return true;
}

//==============================================================================
// state.txt — the extension's view into this terminal
//==============================================================================
struct MonInfo {
   long hmon;
   RECT mon;
   RECT work;
};

// Discover all monitors WITHOUT callbacks (MQL5 cannot pass function
// pointers) and WITHOUT struct-by-value calls (MonitorFromPoint is not
// importable): probe a grid of 1x1 rects across the virtual screen with
// MonitorFromRect — which takes the rect BY POINTER — and dedup the returned
// HMONITORs. GetMonitorInfoW then gives each monitor's rect and work area.
int EnumerateMonitors(MonInfo &out[])
{
   ArrayFree(out);
   long hmons[];
   int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
   int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
   int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
   int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
   if(vw > 0 && vh > 0) {
      RECT probe;
      for(int y = vy; y < vy + vh; y += 64) {
         for(int x = vx; x < vx + vw; x += 64) {
            probe.left = x; probe.top = y;
            probe.right = x + 1; probe.bottom = y + 1;
            long m = MonitorFromRect(probe, MONITOR_DEFAULTTONEAREST);
            if(m == 0) continue;
            bool known = false;
            for(int i = 0; i < ArraySize(hmons); i++) if(hmons[i] == m) { known = true; break; }
            if(!known) {
               int n = ArraySize(hmons);
               ArrayResize(hmons, n + 1);
               hmons[n] = m;
               if(n + 1 >= MAX_MONITORS) break;
            }
         }
         if(ArraySize(hmons) >= MAX_MONITORS) break;
      }
   }
   for(int i = 0; i < ArraySize(hmons); i++) {
      MONITORINFO mi;
      mi.cbSize = 40;   // int + RECT(16) + RECT(16) + uint
      if(!GetMonitorInfoW(hmons[i], mi)) continue;
      int n = ArraySize(out);
      ArrayResize(out, n + 1);
      out[n].hmon = hmons[i];
      out[n].mon = mi.rcMonitor;
      out[n].work = mi.rcWork;
   }
   // Degenerate fallback: no monitors resolved (should not happen) — report
   // the primary screen rect as a single full-size "monitor".
   if(ArraySize(out) == 0) {
      ArrayResize(out, 1);
      out[0].hmon = 0;
      int w = GetSystemMetrics(SM_CXSCREEN);
      int h = GetSystemMetrics(SM_CYSCREEN);
      out[0].mon.left = 0;  out[0].mon.top = 0;  out[0].mon.right = w;  out[0].mon.bottom = h;
      out[0].work = out[0].mon;
   }
   // Stable numbering for presets: left-to-right, then top-to-bottom.
   for(int i = 1; i < ArraySize(out); i++) {
      for(int j = 0; j < i; j++) {
         bool swap = false;
         if(out[i].mon.left < out[j].mon.left) swap = true;
         else if(out[i].mon.left == out[j].mon.left && out[i].mon.top < out[j].mon.top) swap = true;
         if(swap) {
            MonInfo t = out[i]; out[i] = out[j]; out[j] = t;
         }
      }
   }
   return ArraySize(out);
}

bool WriteState()
{
   ChartInfo charts[];
   EnumerateCharts(charts);
   long main = MainHwndOf(charts);

   // MDI client area (docked cell coordinates) + main-window chrome insets.
   int mdiW = 0, mdiH = 0;
   int chromeL = 0, chromeT = 0, chromeR = 0, chromeB = 0;
   long mdi = 0;
   for(int i = 0; i < ArraySize(charts); i++) {
      if(charts[i].docked) { mdi = GetParent(charts[i].hwnd); break; }
   }
   if(mdi != 0) {
      RECT cr;
      if(GetClientRect(mdi, cr)) { mdiW = cr.right - cr.left; mdiH = cr.bottom - cr.top; }
      if(main != 0) {
         RECT mr;
         POINT origin;
         origin.x = 0; origin.y = 0;
         if(GetWindowRect(main, mr) && ClientToScreen(mdi, origin)) {
            chromeL = origin.x - mr.left;
            chromeT = origin.y - mr.top;
            chromeR = mr.right - (origin.x + mdiW);
            chromeB = mr.bottom - (origin.y + mdiH);
         }
      }
   }

   // Monitors: probe order left-to-right / top-to-bottom (1-based numbering
   // for presets). rcWork accounts for host panels just like the Windows
   // backend's Screen.AllScreens.
   MonInfo mons[];
   EnumerateMonitors(mons);

   string text = "";
   text += "version=1\n";
   text += "main=" + (string)main + "\n";
   text += "mdi=" + (string)mdiW + "," + (string)mdiH + "\n";
   text += "chrome=" + (string)chromeL + "," + (string)chromeT + "," +
           (string)chromeR + "," + (string)chromeB + "\n";
   text += "active=" + ActiveSymbolOf(main) + "\n";
   for(int i = 0; i < ArraySize(mons); i++) {
      RECT mo = mons[i].mon, wk = mons[i].work;
      text += "mon=" + (string)(i + 1) + ";" +
              (string)mo.left + ";" + (string)mo.top + ";" + (string)(mo.right - mo.left) + ";" + (string)(mo.bottom - mo.top) + ";" +
              (string)wk.left + ";" + (string)wk.top + ";" + (string)(wk.right - wk.left) + ";" + (string)(wk.bottom - wk.top) + "\n";
   }
   for(int i = 0; i < ArraySize(charts); i++) {
      text += "chart=" + (string)charts[i].hwnd + ";" + charts[i].symbol + ";" +
              (string)charts[i].period + ";" + (string)(charts[i].docked ? "1" : "0") + "\n";
   }
   return WriteTextAtomic(STATE_FILE, STATE_TMP, text);
}

//==============================================================================
// request handling
//==============================================================================
void ProcessRequest()
{
   // Read the whole request first, then delete it (the extension writes it
   // atomically via rename, so we always see a complete file).
   int h = FileOpen(REQ_FILE, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;

   MoveReq moves[];
   long mins[];
   long mainMove = 0;
   bool hasMain = false;
   int moveCount = 0, minCount = 0;

   while(!FileIsEnding(h)) {
      string line = TrimAll(FileReadString(h));
      if(StringLen(line) == 0) continue;
      int eq = StringFind(line, "=");
      if(eq <= 0) continue;
      string key = StringSubstr(line, 0, eq);
      string val = StringSubstr(line, eq + 1);
      string parts[];
      if(key == "main" && SplitString(val, ',', parts) >= 5) {
         mainMove = (long)StringToInteger(parts[0]);
         // stored as a MoveReq so the apply loop is uniform
         int n = ArraySize(moves);
         ArrayResize(moves, n + 1);
         moves[n].hwnd = mainMove;
         moves[n].x = (int)StringToInteger(parts[1]);
         moves[n].y = (int)StringToInteger(parts[2]);
         moves[n].w = (int)StringToInteger(parts[3]);
         moves[n].h = (int)StringToInteger(parts[4]);
         hasMain = true;
      }
      else if(key == "move" && SplitString(val, ',', parts) >= 5) {
         int n = ArraySize(moves);
         ArrayResize(moves, n + 1);
         moves[n].hwnd = (long)StringToInteger(parts[0]);
         moves[n].x = (int)StringToInteger(parts[1]);
         moves[n].y = (int)StringToInteger(parts[2]);
         moves[n].w = (int)StringToInteger(parts[3]);
         moves[n].h = (int)StringToInteger(parts[4]);
         moveCount++;
      }
      else if(key == "min") {
         int n = ArraySize(mins);
         ArrayResize(mins, n + 1);
         mins[n] = (long)StringToInteger(val);
         minCount++;
      }
   }
   FileClose(h);
   FileDelete(REQ_FILE);
   if(!hasMain && moveCount == 0 && minCount == 0) return;

   // Current chart set — every requested handle must belong to it (or be
   // the main window); unknown/stale handles are skipped, not applied.
   ChartInfo charts[];
   EnumerateCharts(charts);
   long main = MainHwndOf(charts);

   int moved = 0, minimized = 0, skipped = 0;

   // Main window first: restore, park on the work area, let the MDI client
   // resize, then refresh state so the extension computes cells for the NEW
   // size (two-phase protocol).
   if(hasMain) {
      if(main == 0 || moves[0].hwnd != main) skipped++;
      else {
         ShowWindow(main, SW_RESTORE);
         SetWindowPos(main, 0, moves[0].x, moves[0].y, moves[0].w, moves[0].h,
                      SWP_NOZORDER | SWP_NOACTIVATE);
         moved++;
         Sleep(300);   // let MT5 resize its MDIClient (same wait as the PS worker)
         WriteState();
      }
   }

   // Chart moves. Docked charts are WS_CHILD: MoveWindow takes MDI-client
   // coordinates. On current builds the moved window is the MDI child FRAME
   // (parent = MDIClient), so cells map 1:1. Top-level charts (floating,
   // or the main window itself) get expanded by SM_C*SIZEFRAME +
   // SM_CXPADDEDBORDER so their VISIBLE edges land exactly on the cell rect —
   // same compensation as the PowerShell backend.
   int first = hasMain ? 1 : 0;
   for(int i = first; i < ArraySize(moves); i++) {
      long hwnd = moves[i].hwnd;
      bool isMain = (hwnd == main && main != 0);
      if(!isMain && !ChartSetContains(charts, hwnd)) { skipped++; continue; }
      ShowWindow(hwnd, SW_RESTORE);
      int bx = 0, by = 0;
      if((GetWindowLongW(hwnd, GWL_STYLE) & WS_CHILD) == 0) {
         bx = GetSystemMetrics(SM_CXSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
         by = GetSystemMetrics(SM_CYSIZEFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
         if(bx < 0) bx = 0;
         if(by < 0) by = 0;
      }
      MoveWindow(hwnd, moves[i].x - bx, moves[i].y - by,
                 moves[i].w + 2 * bx, moves[i].h + 2 * by, true);
      moved++;
   }

   // Minimize extras (tuck to the bottom of the MDI area / taskbar).
   for(int i = 0; i < ArraySize(mins); i++) {
      long hwnd = mins[i];
      bool isMain = (hwnd == main && main != 0);
      if(!isMain && !ChartSetContains(charts, hwnd)) { skipped++; continue; }
      ShowWindow(hwnd, SW_MINIMIZE);
      minimized++;
   }

   WriteTextAtomic(RES_FILE, RES_TMP,
                   "ok moved=" + (string)moved + " min=" + (string)minimized +
                   " skipped=" + (string)skipped);
}

//==============================================================================
// service loop
//==============================================================================
void OnStart()
{
   Print("ArrangeLayoutService v1.00 started — watching ", REQ_FILE);
   WriteState();
   string lastSig = "";
   ulong lastStateAt = 0;

   while(!IsStopped()) {
      if(FileIsExist(REQ_FILE)) {
         ProcessRequest();
         lastSig = "";        // force a state refresh next tick
      }

      ChartInfo charts[];
      EnumerateCharts(charts);
      long main = MainHwndOf(charts);
      string sig = ChartSignature(charts, main);
      ulong now = GetTickCount64();
      if(sig != lastSig || now - lastStateAt >= STATE_EVERY_MS) {
         WriteState();
         lastSig = sig;
         lastStateAt = GetTickCount64();
      }
      Sleep(POLL_MS);
   }

   Print("ArrangeLayoutService stopped");
}
