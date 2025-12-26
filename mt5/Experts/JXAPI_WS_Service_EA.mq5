//+------------------------------------------------------------------+
//| JXAPI_WS_Service_EA.mq5                                           |
//| EA servico: conecta no WebSocket do servidor e publica L2 em      |
//| Global Variables do Terminal.                                     |
//|                                                                  |
//| Suporta ws:// (sem TLS).                                          |
//+------------------------------------------------------------------+
#property strict
#property copyright "Eduardo Candeia Goncalves"
#property version   "1.0.0"

input string WsUrl            = "ws://127.0.0.1:8080/ws/market";
input string InstrumentFilter = "";            // vazio => usa Symbol()
input string TypeFilter       = "orderbook";   // "orderbook" recomendado
input int    Depth            = 10;            // niveis por lado
input int    TimerMs          = 20;            // loop
input bool   VerboseLog       = false;

string GVPrefix(const string inst) { return "JXAPI."+inst+"."; }

int    g_sock=-1;
string g_host="";
int    g_port=0;
string g_path="/";
bool   g_connected=false;
uchar  g_rx[];
double g_seq=0;

void V(string s){ if(VerboseLog) Print(s); }
void E(string s){ Print(s); }

bool ParseWsUrl(const string url, string &host, int &port, string &path)
{
   host=""; port=0; path="/";
   string u=url;
   if(StringFind(u,"ws://")!=0){ E("WsUrl deve comecar com ws://"); return false; }
   u=StringSubstr(u,5);
   int slash=StringFind(u,"/");
   string hostport=(slash>=0)?StringSubstr(u,0,slash):u;
   path=(slash>=0)?StringSubstr(u,slash):"/";
   int colon=StringFind(hostport,":");
   if(colon>=0){ host=StringSubstr(hostport,0,colon); port=(int)StringToInteger(StringSubstr(hostport,colon+1)); }
   else { host=hostport; port=80; }
   if(StringLen(host)==0) return false;
   if(port<=0) port=80;
   if(StringLen(path)==0) path="/";
   return true;
}

string Base64Encode(const uchar &src[], int len)
{
   string table="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
   string out="";
   int i=0;
   while(i<len)
   {
      int b0=src[i++];
      int b1=(i<len)?src[i++]:-1;
      int b2=(i<len)?src[i++]:-1;
      int trip=(b0<<16)|((b1<0?0:b1)<<8)|(b2<0?0:b2);
      int c0=(trip>>18)&63, c1=(trip>>12)&63, c2=(trip>>6)&63, c3=trip&63;
      out+=StringSubstr(table,c0,1);
      out+=StringSubstr(table,c1,1);
      if(b1<0) out+="="; else out+=StringSubstr(table,c2,1);
      if(b2<0) out+="="; else out+=StringSubstr(table,c3,1);
   }
   return out;
}

bool SendAll(const uchar &buf[], uint n){ return (SocketSend(g_sock,buf,n)==(int)n); }

bool ReadAvailable()
{
   if(g_sock<0) return false;
   if(!SocketIsConnected(g_sock)) return false;
   uint can=(uint)SocketIsReadable(g_sock);
   if(can==0) return true;
   uchar tmp[];
   int r=SocketRead(g_sock,tmp,can,1);
   if(r<=0) return true;
   int old=ArraySize(g_rx);
   ArrayResize(g_rx,old+r);
   for(int i=0;i<r;i++) g_rx[old+i]=tmp[i];
   return true;
}

bool TryPopWsText(string &msg)
{
   msg="";
   int n=ArraySize(g_rx);
   if(n<2) return false;
   int p=0;
   uchar b0=g_rx[p], b1=g_rx[p+1];
   bool fin=((b0&0x80)!=0);
   int opcode=(int)(b0&0x0F);
   bool masked=((b1&0x80)!=0);
   int plen7=(int)(b1&0x7F);
   p+=2;

   long payload_len=0;
   if(plen7<=125) payload_len=plen7;
   else if(plen7==126)
   {
      if(n<p+2) return false;
      payload_len=((long)g_rx[p]<<8)|(long)g_rx[p+1];
      p+=2;
   }
   else
   {
      if(n<p+8) return false;
      payload_len=0;
      for(int i=0;i<8;i++) payload_len=(payload_len<<8)|(long)g_rx[p+i];
      p+=8;
   }

   uchar maskkey[4];
   if(masked)
   {
      if(n<p+4) return false;
      for(int i=0;i<4;i++) maskkey[i]=g_rx[p+i];
      p+=4;
   }

   if(n<p+(int)payload_len) return false;

   if(opcode==1 && fin)
   {
      uchar payload[];
      ArrayResize(payload,(int)payload_len);
      for(int i=0;i<(int)payload_len;i++)
      {
         uchar c=g_rx[p+i];
         if(masked) c=(uchar)(c^maskkey[i%4]);
         payload[i]=c;
      }
      msg=CharArrayToString(payload,0,(int)payload_len,CP_UTF8);
   }

   int consumed=p+(int)payload_len;
   int remain=n-consumed;
   if(remain>0)
   {
      uchar nb[];
      ArrayResize(nb,remain);
      for(int i=0;i<remain;i++) nb[i]=g_rx[consumed+i];
      ArrayResize(g_rx,remain);
      for(int i=0;i<remain;i++) g_rx[i]=nb[i];
   }
   else ArrayResize(g_rx,0);

   return (StringLen(msg)>0);
}

int FindMatching(const string s,const int startPos,const ushort openCh,const ushort closeCh)
{
   int depth=0,len=StringLen(s);
   for(int i=startPos;i<len;i++)
   {
      ushort c=(ushort)StringGetCharacter(s,i);
      if(c==openCh) depth++;
      else if(c==closeCh){ depth--; if(depth==0) return i; }
   }
   return -1;
}

bool ExtractJsonArray(const string json,const string key,string &outArrayContent)
{
   outArrayContent="";
   string k="\""+key+"\"";
   int kp=StringFind(json,k);
   if(kp<0) return false;
   int lb=StringFind(json,"[",kp);
   if(lb<0) return false;
   int rb=FindMatching(json,lb,'[',']');
   if(rb<0) return false;
   outArrayContent=StringSubstr(json,lb+1,rb-lb-1);
   return true;
}

bool ExtractJsonString(const string json,const string key,string &val)
{
   val="";
   string k="\""+key+"\"";
   int kp=StringFind(json,k);
   if(kp<0) return false;
   int cp=StringFind(json,":",kp);
   if(cp<0) return false;
   int q1=StringFind(json,"\"",cp);
   if(q1<0) return false;
   int q2=StringFind(json,"\"",q1+1);
   if(q2<0) return false;
   val=StringSubstr(json,q1+1,q2-(q1+1));
   return true;
}

bool ExtractJsonNumber(const string obj,const string key,double &val)
{
   val=0.0;
   string k="\""+key+"\"";
   int kp=StringFind(obj,k);
   if(kp<0) return false;
   int cp=StringFind(obj,":",kp);
   if(cp<0) return false;
   int i=cp+1,n=StringLen(obj);
   while(i<n)
   {
      ushort c=(ushort)StringGetCharacter(obj,i);
      if(c!=' '&&c!='\t'&&c!='\r'&&c!='\n') break;
      i++;
   }
   if(i>=n) return false;
   int j=i;
   while(j<n)
   {
      ushort c=(ushort)StringGetCharacter(obj,j);
      bool ok=(c>='0'&&c<='9')||c=='.'||c=='-'||c=='+'||c=='e'||c=='E';
      if(!ok) break;
      j++;
   }
   if(j<=i) return false;
   string token=StringSubstr(obj,i,j-i);
   val=StringToDouble(token);
   return true;
}

int ParseLevels(const string arrayContent,const int maxLevels,double &prices[],double &vols[])
{
   ArrayResize(prices,0); ArrayResize(vols,0);
   int pos=0,count=0,len=StringLen(arrayContent);
   while(pos<len && count<maxLevels)
   {
      int lb=StringFind(arrayContent,"{",pos);
      if(lb<0) break;
      int rb=FindMatching(arrayContent,lb,'{','}');
      if(rb<0) break;
      string obj=StringSubstr(arrayContent,lb+1,rb-lb-1);
      double price=0.0, vol=0.0;
      bool okP=ExtractJsonNumber(obj,"price",price);
      bool okV=ExtractJsonNumber(obj,"volume",vol);
      if(!okV) okV=ExtractJsonNumber(obj,"quantity",vol);
      if(okP && okV)
      {
         int n0=ArraySize(prices);
         ArrayResize(prices,n0+1);
         ArrayResize(vols,n0+1);
         prices[n0]=price; vols[n0]=vol; count++;
      }
      pos=rb+1;
   }
   return count;
}

void GVSet(const string name,const double value){ GlobalVariableSet(name,value); }

void PublishOrderBook(const string json)
{
   string type=""; ExtractJsonString(json,"type",type);
   if(StringLen(TypeFilter)>0 && type!=TypeFilter) return;

   string instrument=""; ExtractJsonString(json,"instrument",instrument);
   if(StringLen(instrument)==0) return;

   string wantInst=InstrumentFilter;
   if(StringLen(wantInst)==0) wantInst=Symbol();
   StringReplace(wantInst,"/","");

   if(instrument!=wantInst) return;
   if(type!="orderbook") return;

   double bid=0,ask=0,ts=0;
   ExtractJsonNumber(json,"bid",bid);
   ExtractJsonNumber(json,"ask",ask);
   ExtractJsonNumber(json,"timestamp",ts);

   string bidsArr="",asksArr="";
   ExtractJsonArray(json,"bids",bidsArr);
   ExtractJsonArray(json,"asks",asksArr);

   double bp[],bv[],ap[],av[];
   int nb=ParseLevels(bidsArr,Depth,bp,bv);
   int na=ParseLevels(asksArr,Depth,ap,av);

   string pfx=GVPrefix(instrument);

   GVSet(pfx+"ts",ts);
   GVSet(pfx+"bid",bid);
   GVSet(pfx+"ask",ask);
   GVSet(pfx+"depth",(double)Depth);

   for(int i=1;i<=Depth;i++)
   {
      double p=0,v=0;
      if(i<=nb){ p=bp[i-1]; v=bv[i-1]; }
      GVSet(pfx+"B.P"+(string)i,p);
      GVSet(pfx+"B.V"+(string)i,v);

      p=0; v=0;
      if(i<=na){ p=ap[i-1]; v=av[i-1]; }
      GVSet(pfx+"A.P"+(string)i,p);
      GVSet(pfx+"A.V"+(string)i,v);
   }

   g_seq+=1.0;
   GVSet(pfx+"seq",g_seq);
   EventChartCustom(0,10001,(long)g_seq,0.0,instrument);
}

void Disconnect()
{
   if(g_sock>=0) SocketClose(g_sock);
   g_sock=-1; g_connected=false; ArrayResize(g_rx,0);
}

bool Connect()
{
   Disconnect();
   if(!ParseWsUrl(WsUrl,g_host,g_port,g_path)) return false;

   g_sock=SocketCreate();
   if(g_sock<0){ E("SocketCreate falhou err="+(string)GetLastError()); return false; }

   if(!SocketConnect(g_sock,g_host,g_port,3000))
   {
      E("SocketConnect falhou err="+(string)GetLastError());
      SocketClose(g_sock); g_sock=-1;
      return false;
   }

   uchar keybytes[16];
   for(int i=0;i<16;i++) keybytes[i]=(uchar)MathRand();
   string key=Base64Encode(keybytes,16);

   string req=
      "GET "+g_path+" HTTP/1.1\r\n"+
      "Host: "+g_host+":"+ (string)g_port +"\r\n"+
      "Upgrade: websocket\r\n"+
      "Connection: Upgrade\r\n"+
      "Sec-WebSocket-Key: "+key+"\r\n"+
      "Sec-WebSocket-Version: 13\r\n\r\n";

   uchar out[];
   StringToCharArray(req,out,0,WHOLE_ARRAY,CP_UTF8);
   if(!SendAll(out,(uint)(ArraySize(out)-1))){ E("Handshake send falhou"); Disconnect(); return false; }

   uchar respbuf[]; ArrayResize(respbuf,0);
   string resp="";
   for(int t=0;t<50;t++)
   {
      uint can=(uint)SocketIsReadable(g_sock);
      if(can>0)
      {
         uchar tmp[];
         int r=SocketRead(g_sock,tmp,can,200);
         if(r>0)
         {
            int old=ArraySize(respbuf);
            ArrayResize(respbuf,old+r);
            for(int i=0;i<r;i++) respbuf[old+i]=tmp[i];
            resp=CharArrayToString(respbuf,0,ArraySize(respbuf),CP_UTF8);
            if(StringFind(resp,"\r\n\r\n")>=0) break;
         }
      }
      Sleep(50);
   }

   if(StringFind(resp," 101 ")<0){ E("Handshake sem 101. Resp:\n"+resp); Disconnect(); return false; }

   g_connected=true;
   V("WS conectado.");
   return true;
}

int OnInit()
{
   MathSrand((uint)TimeLocal());
   ArrayResize(g_rx,0);
   g_seq=0;
   int ms=TimerMs; if(ms<10) ms=10;
   EventSetMillisecondTimer(ms);
   Connect();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Disconnect();
}

void OnTimer()
{
   if(g_sock<0 || !SocketIsConnected(g_sock) || !g_connected){ Connect(); return; }
   if(!ReadAvailable()){ Disconnect(); return; }

   for(int i=0;i<50;i++)
   {
      string msg;
      if(!TryPopWsText(msg)) break;
      PublishOrderBook(msg);
   }
}
//+------------------------------------------------------------------+
