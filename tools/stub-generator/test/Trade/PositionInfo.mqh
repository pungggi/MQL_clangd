//+------------------------------------------------------------------+
//|                                                 PositionInfo.mqh |
//|                             Copyright 2000-2024, MetaQuotes Ltd. |
//+------------------------------------------------------------------+
#include <Object.mqh>

//+------------------------------------------------------------------+
//| Class CPositionInfo                                              |
//| Purpose: Class for accessing position properties                 |
//+------------------------------------------------------------------+
class CPositionInfo : public CObject
  {
protected:
   string            m_symbol;

public:
                     CPositionInfo(void);
                    ~CPositionInfo(void);
   //--- fast access to position info by symbol
   ulong             Ticket(void) const;
   datetime          Time(void) const;
   ulong             TimeMsc(void) const;
   datetime          TimeUpdate(void) const;
   ulong             TimeUpdateMsc(void) const;
   ENUM_POSITION_TYPE PositionType(void) const;
   string            TypeDescription(void) const;
   long              Magic(void) const;
   long              Identifier(void) const;
   double            Volume(void) const;
   double            PriceOpen(void) const;
   double            StopLoss(void) const;
   double            TakeProfit(void) const;
   double            PriceCurrent(void) const;
   double            Commission(void) const;
   double            Swap(void) const;
   double            Profit(void) const;
   string            Symbol(void) const;
   string            Comment(void) const;
   //--- state
   bool              InfoInteger(const ENUM_POSITION_PROPERTY_INTEGER prop_id,long &var) const;
   bool              InfoDouble(const ENUM_POSITION_PROPERTY_DOUBLE prop_id,double &var) const;
   bool              InfoString(const ENUM_POSITION_PROPERTY_STRING prop_id,string &var) const;
   //--- selection
   bool              Select(const string symbol);
   bool              SelectByIndex(const int index);
   bool              SelectByMagic(const string symbol,const ulong magic);
   bool              SelectByTicket(const ulong ticket);
   //--- stored info
   void              StoreState(void);
   bool              CheckState(void);
  };

//+------------------------------------------------------------------+
//| Class COrderInfo                                                 |
//| Purpose: Class for accessing order properties                    |
//+------------------------------------------------------------------+
class COrderInfo : public CObject
  {
protected:
   ulong             m_ticket;

public:
                     COrderInfo(void);
                    ~COrderInfo(void);
   //--- fast access to order info
   ulong             Ticket(void) const;
   datetime          TimeSetup(void) const;
   ulong             TimeSetupMsc(void) const;
   datetime          TimeDone(void) const;
   ulong             TimeDoneMsc(void) const;
   ENUM_ORDER_TYPE   OrderType(void) const;
   string            TypeDescription(void) const;
   ENUM_ORDER_STATE  State(void) const;
   string            StateDescription(void) const;
   datetime          TimeExpiration(void) const;
   ENUM_ORDER_TYPE_FILLING TypeFilling(void) const;
   string            TypeFillingDescription(void) const;
   ENUM_ORDER_TYPE_TIME TypeTime(void) const;
   string            TypeTimeDescription(void) const;
   long              Magic(void) const;
   long              PositionId(void) const;
   long              PositionById(void) const;
   double            VolumeInitial(void) const;
   double            VolumeCurrent(void) const;
   double            PriceOpen(void) const;
   double            StopLoss(void) const;
   double            TakeProfit(void) const;
   double            PriceCurrent(void) const;
   double            PriceStopLimit(void) const;
   string            Symbol(void) const;
   string            Comment(void) const;
   //--- state
   bool              InfoInteger(const ENUM_ORDER_PROPERTY_INTEGER prop_id,long &var) const;
   bool              InfoDouble(const ENUM_ORDER_PROPERTY_DOUBLE prop_id,double &var) const;
   bool              InfoString(const ENUM_ORDER_PROPERTY_STRING prop_id,string &var) const;
   //--- selection
   bool              Select(const ulong ticket);
   bool              SelectByIndex(const int index);
   //--- stored info
   void              StoreState(void);
   bool              CheckState(void);
  };

