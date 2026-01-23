//+------------------------------------------------------------------+
//|                                                        Trade.mqh |
//|                             Copyright 2000-2024, MetaQuotes Ltd. |
//|                                             Sample for testing   |
//+------------------------------------------------------------------+
#include <Object.mqh>

//+------------------------------------------------------------------+
//| enums                                                            |
//+------------------------------------------------------------------+
enum ENUM_TRADE_REQUEST_ACTIONS
  {
   TRADE_ACTION_DEAL    = 0,  // Market order
   TRADE_ACTION_PENDING = 1,  // Pending order
   TRADE_ACTION_SLTP    = 2,  // Modify SL/TP
   TRADE_ACTION_MODIFY  = 3,  // Modify order
   TRADE_ACTION_REMOVE  = 4,  // Remove order
   TRADE_ACTION_CLOSE_BY = 5  // Close by opposite
  };

//+------------------------------------------------------------------+
//| Class CTrade                                                     |
//| Purpose: Class for trading operations                            |
//+------------------------------------------------------------------+
class CTrade : public CObject
  {
protected:
   MqlTradeRequest   m_request;         // request data
   MqlTradeResult    m_result;          // result data
   bool              m_async_mode;      // async mode flag
   ulong             m_magic;           // expert magic number
   ulong             m_deviation;       // deviation for market orders
   ENUM_ORDER_TYPE_FILLING m_type_filling; // order filling type
   ENUM_ORDER_TYPE_TIME m_type_time;    // order expiration type
   datetime          m_expiration;      // order expiration time
   string            m_comment;         // order comment
   int               m_log_level;       // logging level

public:
                     CTrade(void);
                    ~CTrade(void);
   //--- methods for setting parameters
   void              SetExpertMagicNumber(const ulong magic);
   void              SetDeviationInPoints(const ulong deviation);
   void              SetTypeFilling(const ENUM_ORDER_TYPE_FILLING filling);
   void              SetTypeFillingBySymbol(const string symbol);
   void              SetOrderExpiration(const datetime expiration);
   void              SetMarginMode(void);
   void              SetAsyncMode(const bool mode);
   void              SetLogLevel(const int log_level);
   //--- methods for getting parameters
   ulong             RequestMagic(void) const;
   ulong             RequestDeviation(void) const;
   ENUM_ORDER_TYPE_FILLING RequestTypeFilling(void) const;
   //--- position operations
   bool              PositionOpen(const string symbol,const ENUM_ORDER_TYPE order_type,
                                  const double volume,const double price,
                                  const double sl,const double tp,
                                  const string comment="");
   bool              PositionModify(const string symbol,const double sl,const double tp);
   bool              PositionModify(const ulong ticket,const double sl,const double tp);
   bool              PositionClose(const string symbol,const ulong deviation=ULONG_MAX);
   bool              PositionClose(const ulong ticket,const ulong deviation=ULONG_MAX);
   bool              PositionCloseBy(const ulong ticket,const ulong ticket_by);
   bool              PositionClosePartial(const string symbol,const double volume,
                                          const ulong deviation=ULONG_MAX);
   bool              PositionClosePartial(const ulong ticket,const double volume,
                                          const ulong deviation=ULONG_MAX);
   //--- order operations
   bool              OrderOpen(const string symbol,const ENUM_ORDER_TYPE order_type,
                               const double volume,const double limit_price,
                               const double price,const double sl,const double tp,
                               ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,
                               const datetime expiration=0,
                               const string comment="");
   bool              OrderModify(const ulong ticket,const double price,
                                 const double sl,const double tp,
                                 const ENUM_ORDER_TYPE_TIME type_time,
                                 const datetime expiration,
                                 const double stoplimit=0.0);
   bool              OrderDelete(const ulong ticket);
   //--- trade results
   uint              ResultRetcode(void) const;
   ulong             ResultDeal(void) const;
   ulong             ResultOrder(void) const;
   double            ResultVolume(void) const;
   double            ResultPrice(void) const;
   double            ResultBid(void) const;
   double            ResultAsk(void) const;
   string            ResultComment(void) const;
   uint              ResultRetcodeDescription(string &description) const;
   //--- request data
   ENUM_TRADE_REQUEST_ACTIONS RequestAction(void) const;
   string            RequestSymbol(void) const;
   double            RequestVolume(void) const;
   double            RequestPrice(void) const;
   double            RequestSL(void) const;
   double            RequestTP(void) const;
   string            RequestComment(void) const;
   //--- helper methods
   bool              Buy(const double volume,const string symbol=NULL,
                         double price=0.0,const double sl=0.0,
                         const double tp=0.0,const string comment="");
   bool              Sell(const double volume,const string symbol=NULL,
                          double price=0.0,const double sl=0.0,
                          const double tp=0.0,const string comment="");
   bool              BuyLimit(const double volume,const double price,
                              const string symbol=NULL,const double sl=0.0,
                              const double tp=0.0,
                              const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,
                              const datetime expiration=0,const string comment="");
   bool              SellLimit(const double volume,const double price,
                               const string symbol=NULL,const double sl=0.0,
                               const double tp=0.0,
                               const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,
                               const datetime expiration=0,const string comment="");
   bool              BuyStop(const double volume,const double price,
                             const string symbol=NULL,const double sl=0.0,
                             const double tp=0.0,
                             const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,
                             const datetime expiration=0,const string comment="");
   bool              SellStop(const double volume,const double price,
                              const string symbol=NULL,const double sl=0.0,
                              const double tp=0.0,
                              const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,
                              const datetime expiration=0,const string comment="");

protected:
   bool              PositionOpenCheck(const string symbol);
   bool              OrderTypeCheck(const string symbol);
   void              ClearStructures(void);
   bool              SelectPosition(const string symbol);
  };

