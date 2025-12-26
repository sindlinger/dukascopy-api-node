Como usar (Java 11+)

Ajuda:
java -jar jforexctl.jar help

WebSocket (ticks/top-of-book ou book; imprime JSON):

Exemplo (10 mensagens e sai):
java -jar jforexctl.jar ws --ws ws://localhost:7081/ticker --topOfBook true --instIDs EURUSD,USDJPY --pretty --count 10

Rodar por X segundos:
java -jar jforexctl.jar ws --ws ws://localhost:7081/ticker --topOfBook false --instIDs EURUSD,USDJPY --pretty --duration 30

Último order book via REST:
java -jar jforexctl.jar orderbook --rest http://localhost:7080 --instrument EUR/USD --pretty

Histórico via REST:

Últimos 60 minutos:
java -jar jforexctl.jar history --rest http://localhost:7080 --instrument EUR/USD --period M1 --minutes 60 --side BID --pretty

Com janela explícita (epoch ms):
java -jar jforexctl.jar history --rest http://localhost:7080 --instrument EUR/USD --period M5 --from 1700000000000 --to 1700003600000 --pretty

Instruments (lista e update):

Listar:
java -jar jforexctl.jar instruments list --rest http://localhost:7080 --pretty

Atualizar inscritos:
java -jar jforexctl.jar instruments set --rest http://localhost:7080 --list EUR/USD,USD/JPY,BTC/USD --pretty

Position (opcional, baseado no payload.md)
Se sua API realmente expõe esses endpoints, você pode usar:

get:
java -jar jforexctl.jar position get --rest http://localhost:7080 --clientOrderID ORD_1004 --pretty

open:
java -jar jforexctl.jar position open --rest http://localhost:7080 --instID AUDJPY --clientOrderID ORD_1004 --orderSide Buy --orderType Market --quantity 10000 --pretty

Se o path for diferente no seu servidor, ajuste com:
--path /api/v1/position (default já é esse)

Config por variável de ambiente (para não repetir)
Você pode setar:

JFOREX_REST (ex.: http://localhost:7080)

JFOREX_WS (ex.: ws://localhost:7081/ticker)



Exemplo:


export JFOREX_REST=http://localhost:7080
export JFOREX_WS=ws://localhost:7081/ticker
java -jar jforexctl.jar ws --topOfBook true --instIDs EURUSD,USDJPY --count 5 --pretty



Observação sobre portas (7080/7081 vs 8080)
O payload.md usa 7080/7081. Já o código Spring Boot que você enviou pode estar usando a porta padrão (8080), a menos que você tenha configurado server.port. Se estiver em 8080, use:

--rest http://localhost:8080

--ws ws://localhost:8080/ticker

Sobre “chamar as classes diretamente”
Esse CLI é um “cliente” (ele não depende das classes do JAR do servidor; só fala HTTP/WS). Se você quiser um CLI “embutido” que instancia Spring e chama JForexRunnerService/JForexL2RunnerApplication no mesmo processo, dá para fazer também — mas aí eu preciso que você envie o README completo e qualquer config de endpoints (principalmente o WebSocketConfig e o que estiver faltando para position, se existir), porque nem tudo veio nesses fontes.
