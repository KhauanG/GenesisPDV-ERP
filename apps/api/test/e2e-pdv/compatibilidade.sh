#!/usr/bin/env bash
# Matriz de compatibilidade do PDV instalado com a API desta árvore (Fase 3, F3-B7; padrões da Fase 3 › "Os blocos do PDV
# que mudam a sincronização rodam a matriz de compatibilidade com o PDV mais antigo em uso"; README da API › decisão
# 226): para cada tag `pdv-vX.Y.Z`, extrai o PDV daquela versão (git archive, sem checkout nem worktree), sobe a API do
# e2e DESTA árvore (servidor.ts, que semeia também as linhas da Fase 3), roda o GenesisPDV.E2E.Tests DA TAG contra ela
# (ativação, carga inicial, venda, caixa, revogação, recuperação do backup) e, com a API ainda no ar, confere que algum
# terminal daquela versão informou os cursores do catalogo, do pessoas e do operacao além das linhas novas
# (conferir-compatibilidade.ts). No fim de cada tag derruba a API, que apaga os bancos que criou. Uso, da raiz:
#   apps/api/test/e2e-pdv/compatibilidade.sh [pdv-v0.10.0 pdv-v0.13.0 ...] [-- <opções do dotnet test>]
# Sem tags: pdv-v0.10.0 (o mais antigo em uso, até a lista do dono no ERP › Terminais) e pdv-v0.13.0 (o publicado).
# Precisa do PostgreSQL de DATABASE_URL, do pnpm, do dotnet do global.json e das tags no clone local. Local, fora do CI.
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
porta="${E2E_PORTA_API:-3397}"
tags=()
while [[ $# -gt 0 && "$1" != "--" ]]; do tags+=("$1"); shift; done
[[ "${1:-}" == "--" ]] && shift
((${#tags[@]})) || tags=(pdv-v0.10.0 pdv-v0.13.0)

pid=""
temporario=""
encerrar_api() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    # A API apaga os bancos ao receber o SIGTERM: espera ela sair (até 30 s).
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  pid=""
}
limpar() {
  encerrar_api
  # `if` e não `&&`: o status da última instrução do trap de EXIT vira o status do script.
  if [[ -n "$temporario" ]]; then rm -rf "$temporario"; fi
}
trap limpar EXIT

resumo=()
falhou=0
for tag in "${tags[@]}"; do
  if [[ ! "$tag" =~ ^pdv-v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    echo "compatibilidade: tag inválida: $tag (esperado pdv-vX.Y.Z)" >&2
    exit 2
  fi
  versao="${BASH_REMATCH[1]}"
  git -C "$raiz" rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null \
    || { echo "compatibilidade: a tag $tag não existe neste clone" >&2; exit 2; }

  temporario="$(mktemp -d)"
  estado="$temporario/estado.json"
  log="$temporario/api.log"
  # O PDV da tag e o exemplo do estado que o projeto E2E dela copia para a saída (o mesmo arquivo desde o 0.10.0).
  git -C "$raiz" archive "$tag" apps/pdv apps/api/test/e2e-pdv/estado.exemplo.json .editorconfig | tar -x -C "$temporario"

  echo "compatibilidade: $tag — subindo a API desta árvore na porta $porta (log em $log)"
  E2E_ESTADO="$estado" E2E_PORTA_API="$porta" pnpm --dir "$raiz/apps/api" exec tsx test/e2e-pdv/servidor.ts >"$log" 2>&1 &
  pid=$!
  limite=$((SECONDS + 180))
  until [[ -f "$estado" ]]; do
    if ! kill -0 "$pid" 2>/dev/null || ((SECONDS > limite)); then
      echo "compatibilidade: a API do e2e não ficou pronta" >&2
      tail -n 50 "$log" >&2 || true
      exit 1
    fi
    sleep 0.5
  done

  status=0
  (
    cd "$temporario/apps/pdv"
    GENESIS_E2E_API="http://127.0.0.1:$porta/" GENESIS_E2E_ESTADO="$estado" GENESIS_E2E_EXIGIR=1 \
      dotnet test --project tests/GenesisPDV.E2E.Tests -c Release --fail-skips on --minimum-expected-tests 5 "$@"
  ) || status=$?
  if [[ $status -eq 0 ]]; then
    pnpm --dir "$raiz/apps/api" exec tsx test/e2e-pdv/conferir-compatibilidade.ts "$estado" "$versao" || status=$?
  fi
  if [[ $status -ne 0 ]]; then
    echo "Últimas linhas do log da API:"
    tail -n 80 "$log" || true
    falhou=1
    resumo+=("$tag: FALHOU")
  else
    resumo+=("$tag: ok")
  fi
  encerrar_api
  rm -rf "$temporario"
  temporario=""
done

printf 'compatibilidade: %s\n' "${resumo[@]}"
exit $falhou
