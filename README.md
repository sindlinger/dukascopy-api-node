# dukascopy-api (Node.js)

Arquivo único: `dukascopy-api.js` (sem dependências npm).

Requisitos:
- Node 18+
- Java (apenas se você usar `server up/run`)

Uso (WSL/Linux):
  chmod +x dukascopy-api.js
  ./dukascopy-api.js help



Uso (Windows):
  node dukascopy-api.js help

Carregando variáveis de ambiente:

set -a
source .env
set +a


Config:
  node dukascopy-api.js config init
  node dukascopy-api.js config set host http://localhost:8080
  node dukascopy-api.js config set ws ws://localhost:8080/ws/market

REST:
  node dukascopy-api.js instruments list
  node dukascopy-api.js orderbook top --instrument EURUSD
  node dukascopy-api.js history bars --instrument EUR/USD --period M1 --minutes 60

WebSocket:
  node dukascopy-api.js ws tail --type orderbook --instrument EURUSD --limit 20 --pretty
  node dukascopy-api.js ws stats --duration 30

Servidor:
  node dukascopy-api.js server env          (gera .env.example na pasta atual)
  node dukascopy-api.js server up --port 8080
  node dukascopy-api.js server logs --n 200 --follow
  node dukascopy-api.js server down

MT5 (exporta EA+Indicador WS->GV):
  node dukascopy-api.js mt5 export --out ./mt5

Observação:
- O WebSocket do seu servidor (pelos seus fontes) é `/ws/market`.
