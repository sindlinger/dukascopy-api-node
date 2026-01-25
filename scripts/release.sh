#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/dist/release"

rm -rf "${OUT}"
mkdir -p "${OUT}"

cp -a \
  "${ROOT}/bin" \
  "${ROOT}/docs" \
  "${ROOT}/mt5" \
  "${ROOT}/dukascopy-api.js" \
  "${ROOT}/package.json" \
  "${ROOT}/README.md" \
  "${ROOT}/.env.example" \
  "${ROOT}/jforex-websocket-api-1.0.0.jar" \
  "${OUT}/"

echo "Release gerado em: ${OUT}"
