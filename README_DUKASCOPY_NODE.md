# dukascopy (Node.js)

Arquivo único: `dukascopy.js` (sem dependências npm).

Requisitos:
- Node 18+
- Java (apenas se você usar `server up/run`)

Uso (WSL/Linux):
  chmod +x dukascopy.js
  ./dukascopy.js help

Uso (Windows):
  node dukascopy.js help

Config:
  node dukascopy.js config init
  node dukascopy.js config set host http://localhost:8080
  node dukascopy.js config set ws ws://localhost:8080/ws/market

REST:
  node dukascopy.js instruments list
  node dukascopy.js orderbook top --instrument EURUSD
  node dukascopy.js history bars --instrument EUR/USD --period M1 --minutes 60

WebSocket:
  node dukascopy.js ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  node dukascopy.js ws stats --duration 30

Servidor:
  node dukascopy.js server env          (gera .env.example na pasta atual)
  node dukascopy.js server up --port 8080
  node dukascopy.js server logs --n 200 --follow
  node dukascopy.js server down

MT5 (exporta EA+Indicador WS->GV):
  node dukascopy.js mt5 export --out ./mt5

Observação:
- O WebSocket do seu servidor (pelos seus fontes) é `/ws/market`.
