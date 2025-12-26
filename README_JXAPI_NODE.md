# jxapi (Node.js)

Arquivo único: `jxapi.js` (sem dependências npm).

Requisitos:
- Node 18+
- Java (apenas se você usar `server up/run`)

Uso (WSL/Linux):
  chmod +x jxapi.js
  ./jxapi.js help

Uso (Windows):
  node jxapi.js help

Config:
  node jxapi.js config init
  node jxapi.js config set host http://localhost:8080
  node jxapi.js config set ws ws://localhost:8080/ws/market

REST:
  node jxapi.js instruments list
  node jxapi.js orderbook top --instrument EURUSD
  node jxapi.js history bars --instrument EUR/USD --period M1 --minutes 60

WebSocket:
  node jxapi.js ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  node jxapi.js ws stats --duration 30

Servidor:
  node jxapi.js server env          (gera .env.example na pasta atual)
  node jxapi.js server up --port 8080
  node jxapi.js server logs --n 200 --follow
  node jxapi.js server down

MT5 (exporta EA+Indicador WS->GV):
  node jxapi.js mt5 export --out ./mt5

Observação:
- O WebSocket do seu servidor (pelos seus fontes) é `/ws/market`.
