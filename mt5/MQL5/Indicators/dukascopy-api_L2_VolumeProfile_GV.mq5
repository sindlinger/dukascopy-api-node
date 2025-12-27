//+------------------------------------------------------------------+
//| dukascopy-api_L2_VolumeProfile_GV.mq5                                     |
//| Indicador: apenas plota. Lê L2 via Global Variables do Terminal.  |
//+------------------------------------------------------------------+
#property indicator_chart_window
#property indicator_plots 0
#property strict
#property copyright "Eduardo Candeia Goncalves"
#property version   "1.0.0"

input string Instrument        = "";   // vazio => usa Symbol()
input int    Depth             = 10;
input int    ProfileRows       = 60;
input int    BinPoints         = 10;
input int    MaxBarPixels      = 240;
input int    BarHeightPixels   = 8;
input int    WallMarginPixels  = 12;
input bool   ShowText          = true;
input int    FontSize          = 8;
input string FontName          = "Consolas";
input double VolumeDivisor     = 1.0;
input int    SegmentOrder      = 0;    // 0 Bid->Ask, 1 Ask->Bid
input color  BidColor          = clrLime;
input color  AskColor          = clrRed;

string g_prefix;
double g_binSize=0.0;

long   g_keys[];
double g_bidAgg[];
double g_askAgg[];

double g_lastBid=0.0;
double g_lastAsk=0.0;
double g_lastSeq=-1.0;

string NormalizeInst(string s){ StringReplace(s,"/",""); return s; }
string GVPrefix(const string inst){ return "dukascopy-api."+inst+"."; }

int FindKeyIndex(const long key)
{
   int n=ArraySize(g_keys);
   for(int i=0;i<n;i++) if(g_keys[i]==key) return i;
   return -1;
}

long PriceToKey(const double price){ return (g_binSize<=0.0)?0:(long)MathRound(price/g_binSize); }
double KeyToPrice(const long key){ return (double)key*g_binSize; }

void AddToBin(const long key,const double bidAdd,const double askAdd)
{
   int idx=FindKeyIndex(key);
   if(idx<0)
   {
      int n=ArraySize(g_keys);
      ArrayResize(g_keys,n+1);
      ArrayResize(g_bidAgg,n+1);
      ArrayResize(g_askAgg,n+1);
      g_keys[n]=key; g_bidAgg[n]=0.0; g_askAgg[n]=0.0;
      idx=n;
   }
   g_bidAgg[idx]+=bidAdd;
   g_askAgg[idx]+=askAdd;
}

void ObjRectLabelUpsert(const string name,const int x,const int y,const int w,const int h,const color col)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_RECTANGLE_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_BACK,true);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetInteger(0,name,OBJPROP_XSIZE,MathMax(0,w));
   ObjectSetInteger(0,name,OBJPROP_YSIZE,MathMax(0,h));
   ObjectSetInteger(0,name,OBJPROP_COLOR,col);
}

void ObjTextUpsert(const string name,const int x,const int y,const string text)
{
   if(ObjectFind(0,name)<0)
   {
      ObjectCreate(0,name,OBJ_LABEL,0,0,0);
      ObjectSetInteger(0,name,OBJPROP_CORNER,CORNER_LEFT_UPPER);
      ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,name,OBJPROP_BACK,true);
      ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
      ObjectSetInteger(0,name,OBJPROP_FONTSIZE,FontSize);
      ObjectSetString(0,name,OBJPROP_FONT,FontName);
      ObjectSetInteger(0,name,OBJPROP_COLOR,clrSilver);
   }
   ObjectSetInteger(0,name,OBJPROP_XDISTANCE,x);
   ObjectSetInteger(0,name,OBJPROP_YDISTANCE,y);
   ObjectSetString(0,name,OBJPROP_TEXT,text);
}

void DeleteAllObjects()
{
   int total=ObjectsTotal(0,0,-1);
   for(int i=total-1;i>=0;i--)
   {
      string name=ObjectName(0,i,0,-1);
      if(StringFind(name,g_prefix)==0) ObjectDelete(0,name);
   }
}

bool GVGetSafe(const string name,double &val){ return GlobalVariableGet(name,val); }

bool LoadSnapshot(const string inst)
{
   string pfx=GVPrefix(inst);
   double seq;
   if(!GVGetSafe(pfx+"seq",seq)) return false;
   if(seq==g_lastSeq) return false;

   ArrayResize(g_keys,0);
   ArrayResize(g_bidAgg,0);
   ArrayResize(g_askAgg,0);

   double bid=0,ask=0;
   GVGetSafe(pfx+"bid",bid);
   GVGetSafe(pfx+"ask",ask);
   g_lastBid=bid; g_lastAsk=ask;

   for(int i=1;i<=Depth;i++)
   {
      double bp=0,bv=0,ap=0,av=0;
      GVGetSafe(pfx+"B.P"+(string)i,bp);
      GVGetSafe(pfx+"B.V"+(string)i,bv);
      GVGetSafe(pfx+"A.P"+(string)i,ap);
      GVGetSafe(pfx+"A.V"+(string)i,av);

      if(bp>0) AddToBin(PriceToKey(bp), bv/VolumeDivisor, 0.0);
      if(ap>0) AddToBin(PriceToKey(ap), 0.0, av/VolumeDivisor);
   }

   g_lastSeq=seq;
   return true;
}

void Render(const datetime anchorTime)
{
   if(g_binSize<=0.0) return;
   if(ArraySize(g_keys)==0) return;

   double mid=0.0;
   if(g_lastBid>0.0 && g_lastAsk>0.0) mid=(g_lastBid+g_lastAsk)/2.0;
   else if(g_lastBid>0.0) mid=g_lastBid;
   else if(g_lastAsk>0.0) mid=g_lastAsk;
   else return;

   int rows=MathMax(10,ProfileRows);
   int half=rows/2;
   long centerKey=PriceToKey(mid);
   long minKey=centerKey-half;
   long maxKey=centerKey+half;

   double maxTotal=0.0;
   for(long k=minKey;k<=maxKey;k++)
   {
      int idx=FindKeyIndex(k);
      if(idx<0) continue;
      double t=g_bidAgg[idx]+g_askAgg[idx];
      if(t>maxTotal) maxTotal=t;
   }
   if(maxTotal<=0.0) maxTotal=1.0;

   int chartW=(int)ChartGetInteger(0,CHART_WIDTH_IN_PIXELS,0);
   int wallX=chartW-WallMarginPixels;

   DeleteAllObjects();

   for(long k=minKey;k<=maxKey;k++)
   {
      int idx=FindKeyIndex(k);
      if(idx<0) continue;
      double bidV=g_bidAgg[idx];
      double askV=g_askAgg[idx];
      double total=bidV+askV;
      if(total<=0.0) continue;

      double price=KeyToPrice(k);

      int x=0,y=0;
      if(!ChartTimePriceToXY(0,0,anchorTime,price,x,y)) continue;

      int barLen=(int)MathRound((total/maxTotal)*MaxBarPixels);
      barLen=MathMax(1,MathMin(MaxBarPixels,barLen));

      int yTop=y-(BarHeightPixels/2);
      int startX=wallX-barLen; if(startX<0) startX=0;

      int bidLen=(int)MathRound(barLen*(bidV/total));
      bidLen=MathMax(0,MathMin(barLen,bidLen));
      int askLen=barLen-bidLen;

      int len1=(SegmentOrder==0)?bidLen:askLen;
      int len2=barLen-len1;

      color col1=(SegmentOrder==0)?BidColor:AskColor;
      color col2=(SegmentOrder==0)?AskColor:BidColor;

      string name1=g_prefix+"S1_"+(string)k;
      string name2=g_prefix+"S2_"+(string)k;

      ObjRectLabelUpsert(name1,startX,yTop,len1,BarHeightPixels,col1);
      ObjRectLabelUpsert(name2,startX+len1,yTop,len2,BarHeightPixels,col2);

      if(ShowText)
      {
         string txt=DoubleToString(price,_Digits)+"  B:"+DoubleToString(bidV,0)+" A:"+DoubleToString(askV,0);
         string nameT=g_prefix+"T_"+(string)k;
         int tx=startX-150; if(tx<0) tx=0;
         ObjTextUpsert(nameT,tx,yTop-1,txt);
      }
   }
}

int OnInit()
{
   g_prefix="JXVG_"+(string)ChartID()+"_";
   g_binSize=BinPoints*_Point;
   ArrayResize(g_keys,0);
   ArrayResize(g_bidAgg,0);
   ArrayResize(g_askAgg,0);
   g_lastSeq=-1.0;
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason){ DeleteAllObjects(); }

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total<=0) return 0;

   string inst=Instrument;
   if(StringLen(inst)==0) inst=Symbol();
   inst=NormalizeInst(inst);

   if(LoadSnapshot(inst)) Render(time[0]);
   return rates_total;
}
//+------------------------------------------------------------------+
