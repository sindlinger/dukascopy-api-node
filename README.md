# dukascopy-api (Node.js CLI)

Instalação via npm (Windows e WSL/Linux):
1) Entre na pasta
2) Rode:

    npm install -g .

Isso cria o comando `dukascopy-api` no PATH (no Windows o npm cria um `.cmd` automaticamente).

Uso local (sem instalar globalmente):
    node ./dukascopy-api.js <comando> ...

Distribuição (release):
    npm run release

Instalação a partir do release:
    npm install -g ./dist/release

Se preferir um arquivo instalável:
    (cd dist/release && npm pack)
    npm install -g ./dist/release/dukascopy-api-1.0.0.tgz

Docker (imagem para servidor):
1) Copie o arquivo de exemplo e edite credenciais (no host):
    cp .env.example .env
    dukascopy-api server set --user SEU_USER --pass SUA_SENHA --jnlp URL --instruments EUR/USD,USD/JPY

    # JNLP (JForex 3) — escolha DEMO ou LIVE:
    # DEMO: http://platform.dukascopy.com/demo_3/jforex_3.jnlp
    # LIVE: http://platform.dukascopy.com/live_3/jforex_3.jnlp

2) (Opcional) Centralize o .env fora do projeto:
    export DUKASCOPY_ENV_FILE=~/.config/dukascopy-api/.env
    # ou um caminho absoluto de sua preferência

3) Suba o container:
    docker compose up -d --build

3) Logs e status:
    docker compose logs -f
    docker compose down

CLI fora do container (recomendado):
    npm install -g .
    dukascopy-api config sync-env
    dukascopy-api config set host http://localhost:8080
    dukascopy-api config set ws ws://localhost:8080/ws/market

Uso local no WSL (servidor rodando no WSL):
1) Instale o CLI no WSL:
    npm install -g .
2) Configure host/ws para o serviço local:
    dukascopy-api config set host http://127.0.0.1:9999
    dukascopy-api config set ws ws://127.0.0.1:9999/ws/market
3) Teste via CLI:
    dukascopy-api instruments list
    dukascopy-api ws tail --type orderbook --instrument EURUSD --limit 20 --pretty

Uso no Windows (CLI fora do WSL, servidor no WSL):
1) Descubra o IP do WSL:
    wsl ip route get 1.1.1.1 | wsl awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
2) Configure host/ws no Windows:
    dukascopy-api config set host http://<IP_DO_WSL>:9999
    dukascopy-api config set ws ws://<IP_DO_WSL>:9999/ws/market
3) Teste via CLI:
    dukascopy-api instruments list
    dukascopy-api ws tail --type orderbook --instrument EURUSD --limit 20 --pretty

Alias opcional (CLI dentro do container):
    dukascopy-api-docker() { docker compose exec dukascopy-api-node dukascopy-api --host http://127.0.0.1:8080 --ws ws://127.0.0.1:8080/ws/market "$@"; }

Se o demo expirar, atualize credenciais e reinicie o container:
    dukascopy-api server set --user NOVO_USER --pass NOVA_SENHA
    docker compose up -d --force-recreate

Exemplos:
    dukascopy-api config init
    dukascopy-api config set host http://localhost:8080
    dukascopy-api config set ws ws://localhost:8080/ws/market

Nota:
- Ao definir `host`, o `ws` é atualizado automaticamente para manter consistência.

Servidor:
    dukascopy-api server env
    dukascopy-api server set --user SEU_USER --pass SUA_SENHA
    dukascopy-api server up --port 8080
    dukascopy-api server status
    dukascopy-api server logs --n 200 --follow
    dukascopy-api server down

Arquivo .env (centralizado):
- Linux/WSL: ~/.config/dukascopy-api/.env
- Windows: %APPDATA%\\dukascopy-api\\.env

Override de caminho:
- DUKASCOPY_ENV_PATH ou DUKASCOPY_ENV_FILE (caminho absoluto)

O comando `server set` sempre grava nesse .env global. Se existir um .env local no projeto,
ele também é atualizado para manter Docker/compose em sincronia.

Diferença importante:
- RUNNING (managed): servidor iniciado por `server up` (pidfile existe)
- RUNNING (unmanaged): porta responde, mas não há pidfile (iniciado fora do CLI)
