#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_ENV="$ROOT/.env"
GLOBAL_DIR="$HOME/.config/dukascopy-api"
GLOBAL_ENV="$GLOBAL_DIR/.env"

if [ ! -f "$LOCAL_ENV" ]; then
  echo "Erro: .env local não encontrado em $LOCAL_ENV"
  exit 1
fi

mkdir -p "$GLOBAL_DIR"

if [ -f "$GLOBAL_ENV" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  cp -f "$GLOBAL_ENV" "$GLOBAL_ENV.bak.$TS"
  rm -f "$GLOBAL_ENV"
  echo "Global removido: $GLOBAL_ENV (backup em $GLOBAL_ENV.bak.$TS)"
fi

echo "OK. Usando apenas o .env local: $LOCAL_ENV"
echo "Dica: evite DUKASCOPY_ENV_PATH/DUKASCOPY_ENV_FILE no ambiente."
