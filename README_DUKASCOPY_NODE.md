# dukascopy-cli (Node.js)

Arquivo único: `dukascopy-cli.js` (sem dependências npm).

Requisitos:
- Node 18+
- Java (apenas se você usar `server up/run`)

Uso (WSL/Linux):
  chmod +x dukascopy-cli.js
  ./dukascopy-cli.js help

Uso (Windows):
  node dukascopy-cli.js help

Config:
  node dukascopy-cli.js config init
  node dukascopy-cli.js config set host http://localhost:8080
  node dukascopy-cli.js config set ws ws://localhost:8080/ws/market

REST:
  node dukascopy-cli.js instruments list
  node dukascopy-cli.js orderbook top --instrument EURUSD
  node dukascopy-cli.js history bars --instrument EUR/USD --period M1 --minutes 60

WebSocket:
  node dukascopy-cli.js ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  node dukascopy-cli.js ws stats --duration 30

Servidor:
  node dukascopy-cli.js server env          (gera .env.example na pasta atual)
  node dukascopy-cli.js server up --port 8080
  node dukascopy-cli.js server logs --n 200 --follow
  node dukascopy-cli.js server down

MT5 (exporta EA+Indicador WS->GV):
  node dukascopy-cli.js mt5 export --out ./mt5

Observação:
- O WebSocket do seu servidor (pelos seus fontes) é `/ws/market`.
