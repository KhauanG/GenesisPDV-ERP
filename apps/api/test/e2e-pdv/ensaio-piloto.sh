#!/usr/bin/env bash
# Ensaio do piloto com a carga REAL (implantação I5), local e fora do CI: sobe a API do ensaio (ensaio-piloto.ts), que
# importa a planilha do Nuvem3 de GENESIS_PLANILHA_REAL pelo importador de verdade, e roda o EnsaioPilotoTests (o PDV de
# verdade, Avalonia headless): ativação e carga inicial, busca no catálogo real, vendas sorteadas em dinheiro, PIX e
# cartão, sangria, fechamento cego e a conferência no ERP e na Prontidão da loja. No fim (sucesso, falha ou Ctrl+C)
# derruba a API, que apaga os bancos que criou. Uso, da raiz do repositório:
#   GENESIS_PLANILHA_REAL=/caminho/Produtos.xlsx apps/api/test/e2e-pdv/ensaio-piloto.sh [-c Release] [--no-build]
# Sem GENESIS_PLANILHA_REAL o ensaio é pulado (sai com 0). GENESIS_ENSAIO_RELATORIO (arquivo, padrão
# ensaio-piloto.json na pasta temporária do sistema) recebe os tempos e as contagens, sem nome de produto nem código;
# GENESIS_ENSAIO_VENDAS muda o número de vendas (padrão 30). A planilha NUNCA vai para o repositório.
set -euo pipefail

if [[ -z "${GENESIS_PLANILHA_REAL:-}" ]]; then
  echo "ensaio do piloto: GENESIS_PLANILHA_REAL não definida; ensaio pulado."
  exit 0
fi
if [[ ! -f "$GENESIS_PLANILHA_REAL" ]]; then
  echo "ensaio do piloto: planilha não encontrada: $GENESIS_PLANILHA_REAL" >&2
  exit 2
fi

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
porta="${E2E_PORTA_API:-3398}"
temporario="$(mktemp -d)"
estado="$temporario/estado.json"
log="${E2E_LOG_API:-$temporario/api.log}"
relatorio="${GENESIS_ENSAIO_RELATORIO:-${TMPDIR:-/tmp}/ensaio-piloto.json}"

pid=""
encerrar() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    # A API apaga os bancos ao receber o SIGTERM: espera ela sair (até 30 s).
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  # O estado tem os ids e os códigos da amostra do catálogo real: some junto com a pasta temporária.
  rm -rf "$temporario"
}
trap encerrar EXIT

echo "ensaio do piloto: subindo a API na porta $porta e importando a planilha (log em $log)"
GENESIS_PLANILHA_REAL="$GENESIS_PLANILHA_REAL" E2E_ESTADO="$estado" E2E_PORTA_API="$porta" \
  pnpm --dir "$raiz/apps/api" exec tsx test/e2e-pdv/ensaio-piloto.ts >"$log" 2>&1 &
pid=$!

limite=$((SECONDS + 600))
until [[ -f "$estado" ]]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "A API do ensaio parou antes de ficar pronta:" >&2
    tail -n 50 "$log" >&2 || true
    exit 1
  fi
  if ((SECONDS > limite)); then
    echo "A API do ensaio não ficou pronta em 600 s:" >&2
    tail -n 50 "$log" >&2 || true
    exit 1
  fi
  sleep 1
done
grep '^ensaio:' "$log" || true

cd "$raiz/apps/pdv"
status=0
# --explicit only: o EnsaioPilotoTests é explícito (o rodar.sh do CI nunca o roda nem o conta como pulado).
GENESIS_ENSAIO_ESTADO="$estado" GENESIS_ENSAIO_RELATORIO="$relatorio" \
  dotnet test --project tests/GenesisPDV.E2E.Tests --explicit only \
  --filter-class GenesisPDV.E2E.Tests.EnsaioPilotoTests --minimum-expected-tests 1 "$@" || status=$?
if [[ $status -ne 0 ]]; then
  echo "Últimas linhas do log da API:"
  tail -n 80 "$log" || true
else
  echo "ensaio do piloto: relatório em $relatorio"
fi
exit $status
