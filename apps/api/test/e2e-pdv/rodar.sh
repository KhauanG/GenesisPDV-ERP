#!/usr/bin/env bash
# E2E PDV ↔ API da Fase 1B (bloco B5) e da Fase 1C (C13: o caixa de ponta a ponta e o PDV 30.7): sobe a API do e2e
# (servidor.ts) em segundo plano, espera o estado ficar pronto por polling com tempo limite e roda o
# GenesisPDV.E2E.Tests (Avalonia headless) contra ela. No fim (sucesso, falha ou Ctrl+C) derruba a API, que apaga os
# bancos que criou. Uso, da raiz do repositório:
#   apps/api/test/e2e-pdv/rodar.sh [-c Release] [--no-build]
# GENESIS_E2E_RELATORIOS (pasta) recebe o pdv-30-7.json; GENESIS_E2E_30_7_MINUTOS espalha as 200 vendas do 30.7.
# Precisa do PostgreSQL de DATABASE_URL (padrão: o local do infra/docker-compose.yml), do pnpm e do dotnet do global.json.
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
porta="${E2E_PORTA_API:-3399}"
temporario="$(mktemp -d)"
estado="$temporario/estado.json"
log="${E2E_LOG_API:-$temporario/api.log}"

pid=""
encerrar() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    # A API apaga os bancos ao receber o SIGTERM: espera ela sair (até 30 s).
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -rf "$temporario"
}
trap encerrar EXIT

echo "e2e PDV: subindo a API na porta $porta (log em $log)"
E2E_ESTADO="$estado" E2E_PORTA_API="$porta" pnpm --dir "$raiz/apps/api" exec tsx test/e2e-pdv/servidor.ts >"$log" 2>&1 &
pid=$!

limite=$((SECONDS + 180))
until [[ -f "$estado" ]]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "::error::A API do e2e parou antes de ficar pronta"
    tail -n 50 "$log" || true
    exit 1
  fi
  if ((SECONDS > limite)); then
    echo "::error::A API do e2e não ficou pronta em 180 s"
    tail -n 50 "$log" || true
    exit 1
  fi
  sleep 0.5
done

cd "$raiz/apps/pdv"
status=0
# GENESIS_E2E_EXIGIR, --fail-skips e --minimum-expected-tests: o roteiro nunca é pulado em silêncio (variável renomeada,
# --filter passado em "$@"); sem eles, o EstadoE2ETests sozinho deixaria o job verde sem ativar nem revogar nada.
GENESIS_E2E_API="http://127.0.0.1:$porta/" GENESIS_E2E_ESTADO="$estado" GENESIS_E2E_EXIGIR=1 \
  dotnet test --project tests/GenesisPDV.E2E.Tests --fail-skips on --minimum-expected-tests 5 "$@" || status=$?
if [[ $status -ne 0 ]]; then
  echo "Últimas linhas do log da API:"
  tail -n 80 "$log" || true
fi
exit $status
