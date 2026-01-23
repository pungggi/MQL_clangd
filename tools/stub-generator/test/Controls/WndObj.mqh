//+------------------------------------------------------------------+
//|                                                       WndObj.mqh |
//|                             Copyright 2000-2024, MetaQuotes Ltd. |
//+------------------------------------------------------------------+
#include <Object.mqh>
#include <Arrays/ArrayObj.mqh>

//+------------------------------------------------------------------+
//| Class CWndObj                                                    |
//| Purpose: Base class for chart controls that use chart objects    |
//+------------------------------------------------------------------+
class CWndObj : public CObject
  {
protected:
   long              m_chart_id;        // chart ID
   int               m_subwin;          // chart subwindow
   string            m_name;            // object name
   int               m_x;               // X coordinate
   int               m_y;               // Y coordinate
   int               m_w;               // width
   int               m_h;               // height
   bool              m_visible;         // visibility flag
   bool              m_enabled;         // enabled flag

public:
                     CWndObj(void);
   virtual          ~CWndObj(void);
   //--- create/destroy
   virtual bool      Create(const long chart,const string name,
                            const int subwin,const int x1,const int y1,
                            const int x2,const int y2);
   virtual bool      Destroy(void);
   //--- geometry
   virtual bool      Move(const int x,const int y);
   virtual bool      Size(const int w,const int h);
   virtual bool      Shift(const int dx,const int dy);
   //--- properties
   long              ChartId(void) const;
   int               SubWindow(void) const;
   string            Name(void) const;
   int               Left(void) const;
   int               Top(void) const;
   int               Right(void) const;
   int               Bottom(void) const;
   int               Width(void) const;
   int               Height(void) const;
   //--- state
   virtual bool      Show(void);
   virtual bool      Hide(void);
   bool              IsVisible(void) const;
   virtual bool      Enable(void);
   virtual bool      Disable(void);
   bool              IsEnabled(void) const;
   //--- z-order
   long              Z_Order(void) const;
   bool              Z_Order(const long value);

protected:
   virtual bool      OnCreate(void);
   virtual bool      OnDestroy(void);
   virtual bool      OnMove(void);
   virtual bool      OnResize(void);
   virtual bool      OnShow(void);
   virtual bool      OnHide(void);
   virtual bool      OnEnable(void);
   virtual bool      OnDisable(void);
  };

//+------------------------------------------------------------------+
//| Class CWndContainer                                              |
//| Purpose: Base class for container controls                       |
//+------------------------------------------------------------------+
class CWndContainer : public CWndObj
  {
protected:
   CArrayObj         m_controls;        // array of child controls

public:
                     CWndContainer(void);
   virtual          ~CWndContainer(void);
   //--- container operations
   virtual bool      Add(CWndObj *control);
   virtual bool      Add(CWndObj &control);
   int               ControlsTotal(void) const;
   CWndObj*          Control(const int index) const;
   CWndObj*          ControlFind(const string name);
   virtual bool      Delete(CWndObj *control);
   virtual bool      Delete(const int index);
   //--- event handling
   virtual bool      OnEvent(const int id,const long &lparam,
                             const double &dparam,const string &sparam);
   //--- iteration
   virtual void      Redraw(void);
   virtual bool      Save(const int handle);
   virtual bool      Load(const int handle);

protected:
   virtual bool      OnCreate(void);
   virtual bool      OnDestroy(void);
   virtual bool      OnMove(void);
   virtual bool      OnResize(void);
   virtual bool      OnShow(void);
   virtual bool      OnHide(void);
   virtual bool      OnEnable(void);
   virtual bool      OnDisable(void);
  };

