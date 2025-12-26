# JForex Bundle (Servidor + CLI)

Esta pasta foi pensada para ser "um diretório independente" contendo:
- Servidor (Spring Boot): `jforex-websocket-api-*.jar`
- CLI (cliente): `jforex.jar`
- Script único: `jforex` (start/stop + encaminha comandos do CLI)

## Estrutura esperada

```
./jforex
./jforex.jar
./jforex-websocket-api-1.0.0.jar
./.env
```

## Uso rápido

1) Inicialize (cria `.env` template e config local `jforex.properties`):

```bash
chmod +x ./jforex
./jforex init 8080
```

Edite `.env` e preencha `JFOREX_USER` e `JFOREX_PASS`.

2) Suba o servidor em background:

```bash
./jforex up --port 8080
```

3) Use o CLI:

```bash
./jforex instruments list
./jforex orderbook top --instrument EURUSD
./jforex ws tail --type tick --instrument EURUSD --limit 20 --pretty
```

4) Ver logs e parar:

```bash
./jforex logs
./jforex down
```

## Observação (WSL x Windows)

Se você iniciar o servidor com `./jforex up` no WSL, o host correto para o CLI é `localhost`.
Se você rodar o servidor separado no Windows, o `localhost` do WSL não aponta para o Windows; nesse caso configure o host para o IP do Windows.
