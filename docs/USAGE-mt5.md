Essa implementação é um “pipeline” inteiro dentro do próprio MT5, sem arquivo e sem WebRequest no indicador, usando:

um Expert Advisor (EA) como serviço de rede (WebSocket), e

um indicador que só plota lendo “Global Variables” do Terminal.

Fluxo geral (o que acontece em tempo real)

A) Servidor (fora do MT5)
Seu servidor Spring Boot envia mensagens JSON no WebSocket /ws/market (tick e orderbook), no estilo que você mostrou:

{"type":"orderbook","instrument":"EURUSD",...,"bids":[...],"asks":[...]}

Observação importante (JNLP JForex 3):
- DEMO: http://platform.dukascopy.com/demo_3/jforex_3.jnlp
- LIVE: http://platform.dukascopy.com/live_3/jforex_3.jnlp

B) EA “serviço” (dentro do MT5): JXAPI_WS_Service_EA.mq5
Esse EA é o componente que realmente “pega WebSocket”.

Conecta em TCP no host/porta do WebSocket
Ele pega WsUrl (ex.: ws://127.0.0.1:8080/ws/market) e separa:

host: 127.0.0.1

porta: 8080

path: /ws/market

Faz o handshake WebSocket (HTTP Upgrade)
Ele envia uma requisição HTTP como cliente WebSocket:

GET /ws/market HTTP/1.1

Upgrade: websocket

Connection: Upgrade

Sec-WebSocket-Key: <chave base64 aleatória>

Sec-WebSocket-Version: 13

E espera a resposta HTTP/1.1 101 Switching Protocols.
Se não vier 101, ele considera que não virou WebSocket e reconecta.

Loop principal de leitura (timer)
O EA usa EventSetMillisecondTimer(TimerMs) e a cada “tick” do timer:

lê bytes disponíveis do socket (não-bloqueante)

acumula esses bytes num buffer (g_rx)

tenta extrair frames WebSocket completos (texto)

Decodifica frames WebSocket e obtém JSON
Ele implementa o parsing básico do frame:

lê FIN/opcode

lê payload length (<=125, 126, 127)

assume que mensagens do servidor vêm como “text frame” (opcode 1) e normalmente sem máscara

Quando consegue um frame texto completo, converte para string UTF-8 e passa para a rotina de “publish”.

Filtra por type e instrument
Como seu servidor manda vários instrumentos, o EA filtra:

type == "orderbook" (por padrão)

instrument == <símbolo desejado> (por padrão Symbol() do gráfico, normalizado sem /)

Então você pode deixar o WS “floodando” e o EA só pega o que interessa.

Publica o snapshot do book em Global Variables
Aqui é o “canal” EA → indicador.

O EA grava em Global Variables (todas double) chaves como:

Para EURUSD:

JXAPI.EURUSD.bid

JXAPI.EURUSD.ask

JXAPI.EURUSD.ts

JXAPI.EURUSD.B.P1, JXAPI.EURUSD.B.V1 … até Depth

JXAPI.EURUSD.A.P1, JXAPI.EURUSD.A.V1 … até Depth

E por último ele incrementa:

JXAPI.EURUSD.seq

Esse seq é o “commit”: o indicador só considera que o snapshot mudou quando o seq muda (evita ler no meio de uma atualização).

Além disso, o EA dispara:

EventChartCustom(..., 10001, ...)
Isso pode ser usado para “notificar”, mas o indicador no pacote atual apenas faz polling do seq via OnCalculate (o que é ok, porque OnCalculate é acionado frequentemente).

C) Indicador (dentro do MT5): JXAPI_L2_VolumeProfile_GV.mq5
Esse indicador não faz rede. Ele só lê as Global Variables e desenha.

Em cada OnCalculate
Ele verifica JXAPI.<inst>.seq.

se não mudou, não faz nada

se mudou, ele lê todos os níveis B/A e monta um snapshot local

Converte níveis em “bins” e desenha o perfil
Ele pega os níveis e desenha, no lado direito do gráfico:

uma barra horizontal por nível de preço (bin)

a barra é dividida em dois segmentos: BID (verde) e ASK (vermelho)

o tamanho é proporcional ao total daquele nível, normalizado pelo maior nível visível (para manter proporção)

Não mexe em barras passadas
Ele usa time[0] como âncora para mapear preço→Y na tela. Ele não recalcula histórico.

Por que isso funciona e por que é dividido em EA + indicador

Indicadores no MT5 não são o lugar certo para rede/sockets.

EA é o “serviço” de rede e atualização.

Indicador é só “renderização”.

Isso também permite você trocar o indicador (outro desenho, outro estilo) sem mexer no canal de dados.

Limitações atuais (importantes)

Apenas ws:// (sem TLS)
Se você usar wss://, precisa implementar TLS (SocketTlsHandshake etc.). O pacote atual não faz isso.

WebSocket “mínimo”
Ele trata frames texto simples (FIN + opcode 1). Não trata:

fragmentação (mensagem quebrada em vários frames)

ping/pong (alguns servidores enviam ping)

close frame

Na prática, muitos servidores Spring enviam frames texto completos e funciona. Se o servidor mandar ping, pode precisar adicionar resposta pong.

Global Variables só armazenam números
Por isso a publicação é “nivel por nivel” (preço/volume), não JSON inteiro.

Como você valida que está funcionando

Com EA rodando, abra no MT5:
Tools → Global Variables (F3)
Procure chaves começando com JXAPI.EURUSD. e veja se seq está incrementando.

Aba Experts/Journal
Se o EA não conecta, ele vai logar erro de socket/handshake.

Teste simples
Anexe o EA e o indicador no mesmo gráfico EURUSD.
Se o WS estiver ativo e mandando orderbook EURUSD, o seq sobe e o indicador começa a desenhar.

Se você quiser, eu ajusto essa implementação para:

publicar também o “tick” (best bid/ask e qty) em GV

suportar wss:// (TLS)

responder ping/pong

reduzir custo de desenho (em vez de apagar tudo sempre, atualizar só objetos existentes)
