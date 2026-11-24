#!/usr/bin/env bash
# Testes de unidade do scripts/verificar-local.sh (OP-B1; D70), sem rodar nada de verdade: o script é copiado para uma
# raiz falsa (um repositório git num diretório temporário, com os arquivos que ele lê e dublês dos scripts que ele
# chama) e roda com dublês do pnpm, dotnet, docker, shellcheck, pg_isready, psql e wine no PATH. Cobre: a ordem dos
# jobs e dos passos e os comandos da CI (variáveis da integração, PostgreSQL 16 × 18, cwd do dotnet), a tabela final e
# o resumo.md, a saída ≠ 0 com um job forçado a falhar (e os outros jobs seguindo), o container do PostgreSQL 18
# removido sempre (sucesso, falha e SIGTERM no meio dos testes, ao grupo ou só ao script), a sobra de verificação
# morta (e a de outro usuário, viva), o dockerd subido antes do PostgreSQL 18 quando o Docker está fora do ar, o
# install nas integrações, o passo do Drizzle que gera migração, o build atrás do proxy (rede do host, build-args e as
# bases com o certificado), --so, --pular, opção ou job desconhecido, o --mudancas com a árvore de trabalho
# (inclusive arquivo não commitado) e o job opcional pdv-instalador (pulado com o aviso quando falta o Wine). As
# variáveis de configuração do script vêm sujas do ambiente de propósito: o job `scripts` da verificação de verdade
# roda este teste com o ambiente dela, e a cópia na raiz falsa não pode usá-las (com VERIFICACAO_LOCAL_LOGS, apagaria
# e reescreveria os logs reais).
#
#   bash scripts/testar-verificar-local.sh
# Precisa de bash, git, jq e coreutils.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-verificar-local.XXXXXX")
trap 'rm -rf "$T"' EXIT
RAIZ=$T/raiz
BIN=$T/bin
export REGISTRO=$T/registro DUBLE=$T/duble
mkdir -p "$BIN" "$DUBLE" "$RAIZ/scripts"
# Ambiente de quem chamou (ex.: `VERIFICACAO_LOCAL_LOGS=/x scripts/verificar-local.sh`): nenhuma rodada daqui pode lê-lo.
export VERIFICACAO_LOCAL_LOGS=$T/logs-de-quem-chamou VERIFICAR_PG16_URL=postgres://outro:x@192.0.2.1:1/outro \
  VERIFICACAO_LOCAL_MUDANCAS_SH=$T/mudancas-de-quem-chamou.sh VERIFICAR_IMAGEM_PG18=imagem-de-quem-chamou:1 \
  NODE_EXTRA_CA_CERTS=$T/ca-de-quem-chamou.crt SSL_CERT_FILE=$T/ca-de-quem-chamou.crt
# As variáveis que o verificar-local.sh lê do ambiente (e o proxy da sessão): toda rodada as tira.
LIMPO=(-u HTTPS_PROXY -u https_proxy -u NO_PROXY -u no_proxy -u VERIFICAR_CA -u NODE_EXTRA_CA_CERTS -u SSL_CERT_FILE
  -u VERIFICACAO_LOCAL_LOGS -u VERIFICAR_PG16_URL -u VERIFICACAO_LOCAL_MUDANCAS_SH -u VERIFICAR_IMAGEM_PG18)

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  [[ -f $T/saida ]] && sed 's/^/    | /' "$T/saida" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Raiz falsa -------------------------------------------------------------------------------------------------------
cp "$AQUI/verificar-local.sh" "$RAIZ/scripts/"
mkdir -p "$RAIZ/apps/api/drizzle/empresa" "$RAIZ/apps/api/test/e2e-pdv" "$RAIZ/apps/pdv/instalador/linux-wine/teste" \
  "$RAIZ/apps/erp-web" "$RAIZ/infra/producao/backup" "$RAIZ/infra/producao/teste" "$RAIZ/.github/scripts"
echo 'select 1;' >"$RAIZ/apps/api/drizzle/empresa/0000_inicio.sql"
printf 'ARG IMAGEM_NODE=node:22-teste\nFROM ${IMAGEM_NODE}\n' >"$RAIZ/apps/api/Dockerfile"
printf 'ARG IMAGEM_NODE=node:22-teste\nFROM ${IMAGEM_NODE}\n' >"$RAIZ/apps/erp-web/Dockerfile"
printf 'ARG IMAGEM_ALPINE=alpine:teste\nFROM ${IMAGEM_ALPINE}\n' >"$RAIZ/infra/producao/backup/Dockerfile"
echo 'services: {}' >"$RAIZ/infra/producao/docker-compose.yml"
: >"$RAIZ/infra/producao/genesis.env.exemplo"
for s in infra/producao/backup/testar-genesis-backup.sh infra/producao/teste/testar-implantar-logs.sh \
  infra/producao/teste/testar-implantar-sem-actions.sh scripts/testar-verificar-local.sh \
  apps/pdv/instalador/linux-wine/gerar-instalador.sh apps/pdv/instalador/linux-wine/testar-instalador.sh \
  apps/pdv/instalador/linux-wine/teste/testar-gerar-instalador.sh \
  apps/pdv/instalador/linux-wine/teste/testar-publicar-release.sh; do
  printf '#!/usr/bin/env bash\necho "%s $(pwd)" >>"$REGISTRO"\n' "$s" >"$RAIZ/$s"
done
cat >"$RAIZ/apps/api/test/e2e-pdv/rodar.sh" <<'EOF'
#!/usr/bin/env bash
echo "rodar.sh $* DATABASE_URL=$DATABASE_URL E2E_LOG_API=$E2E_LOG_API RELATORIOS=$GENESIS_E2E_RELATORIOS" >>"$REGISTRO"
EOF
# mudancas.sh dublê: devolve o que está em $DUBLE/mudancas e registra a base e a ponta recebidas.
cat >"$RAIZ/.github/scripts/mudancas.sh" <<'EOF'
#!/usr/bin/env bash
echo "mudancas.sh $*" >>"$REGISTRO"
echo "Motivo: local"
cat "$DUBLE/mudancas"
EOF
chmod +x "$RAIZ"/scripts/*.sh "$RAIZ"/apps/api/test/e2e-pdv/rodar.sh "$RAIZ"/.github/scripts/*.sh \
  "$RAIZ"/apps/pdv/instalador/linux-wine/*.sh "$RAIZ"/apps/pdv/instalador/linux-wine/teste/*.sh
printf '.verificacao-local/\n' >"$RAIZ/.gitignore"
git -C "$RAIZ" init -q -b main
git -C "$RAIZ" add -A
git -C "$RAIZ" -c user.name=teste -c user.email=teste@exemplo.invalid commit -qm inicio

# --- Dublês -----------------------------------------------------------------------------------------------------------
# pnpm: registra os argumentos, o DATABASE_URL e os tetos da trava. $DUBLE/falhar-pg18: a integração no PostgreSQL 18
# (porta 55432) falha; $DUBLE/travar-pg18: ela fica parada até ser morta (o teste manda SIGTERM; o PID do sleep vai
# em $DUBLE/travado); $DUBLE/drizzle-novo: o db:gerar:empresa cria uma migração (schema alterado sem migração).
cat >"$BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "pnpm $* | DATABASE_URL=${DATABASE_URL:-} TETOS=${TETO_TRAVA_VERSAO_MS:-}/${TETO_TRAVA_CARGA_MS:-}" >>"$REGISTRO"
case "$*" in
  *test:integracao*)
    if [[ ${DATABASE_URL:-} == *:55432/* ]]; then
      [[ -e $DUBLE/falhar-pg18 ]] && { echo 'teste de integração falhou (dublê)'; exit 1; }
      if [[ -e $DUBLE/travar-pg18 ]]; then
        sleep 60 &
        echo $! >"$DUBLE/travado"
        wait $!
      fi
    fi
    ;;
  *db:gerar:empresa*) [[ -e $DUBLE/drizzle-novo ]] && echo 'create table x();' >apps/api/drizzle/empresa/0001_novo.sql ;;
esac
exit 0
EOF
cat >"$BIN/dotnet" <<'EOF'
#!/usr/bin/env bash
echo "dotnet $* | cwd=$(pwd) TETO=${GENESISPDV_TETO_CONSULTA_MS:-}" >>"$REGISTRO"
EOF
# docker: info ok (com $DUBLE/docker-parado, só depois que o dublê do dockerd subiu), o run do PostgreSQL 18 publica a
# porta 55432, o compose devolve 2 serviços somando 2.048 MiB.
cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$REGISTRO"
case "$1" in
  info) [[ ! -e $DUBLE/docker-parado || -e $DUBLE/dockerd-no-ar ]]; exit ;;
  exec | logs | rm) exit 0 ;;
  ps) [[ -e $DUBLE/sobra ]] && printf '%s\n' genesis-verificacao-pg18-999999999 \
    genesis-verificacao-pg18-999999998 genesis-verificacao-pg18-$PID_VIVO outro ;;
  run) echo 0123456789abcdef ;;
  port) echo '127.0.0.1:55432' ;;
  build) [[ " $* " == *' -q '* ]] && echo sha256:0000 ;;
  compose)
    [[ " $* " == *' --format json '* ]] &&
      echo '{"services":{"api":{"mem_limit":"1073741824"},"web":{"mem_limit":"1073741824"}}}'
    ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\necho "shellcheck $*" >>"$REGISTRO"\n' >"$BIN/shellcheck"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/pg_isready"
# dockerd: registra a sessão em que subiu (campo 6 do /proc/<pid>/stat) e "fica no ar"; id -u: root (o script só sobe o dockerd como root); ps -p: vivo só o PID listado em
# $DUBLE/ps-vivos (o processo de outro usuário, que o kill -0 não alcança).
cat >"$BIN/dockerd" <<'EOF'
#!/usr/bin/env bash
echo "dockerd $* | sessao=$(awk '{print $6}' /proc/$$/stat 2>/dev/null)" >>"$REGISTRO"
touch "$DUBLE/dockerd-no-ar"
EOF
printf '#!/usr/bin/env bash\n[[ $* == -u ]] && { echo 0; exit 0; }\nexec %q "$@"\n' "$(command -v id)" >"$BIN/id"
printf '#!/usr/bin/env bash\n[[ $1 == -p ]] && grep -qx -- "$2" "$DUBLE/ps-vivos" 2>/dev/null\n' >"$BIN/ps"
printf '#!/usr/bin/env bash\necho "psql $*" >>"$REGISTRO"\n' >"$BIN/psql"
# wine --version: instalado, a não ser com $DUBLE/sem-wine (a sessão pode ter o Wine de verdade no PATH).
printf '#!/usr/bin/env bash\n[[ -e $DUBLE/sem-wine ]] && exit 127\necho wine-teste\n' >"$BIN/wine"
chmod +x "$BIN"/*

# Roda o script na raiz falsa, sem o proxy da sessão; a saída fica em $T/saida e o status em $STATUS.
rodar() {
  : >"$REGISTRO"
  STATUS=0
  env "${LIMPO[@]}" PATH="$BIN:$PATH" "$@" >"$T/saida" 2>&1 || STATUS=$?
}
VL="$RAIZ/scripts/verificar-local.sh"
LOGS=$RAIZ/.verificacao-local

linha() { { grep -nF -- "$1" "$REGISTRO" || true; } | head -n 1 | cut -d: -f1; }
em_ordem() {
  local anterior=0 n m
  for m in "$@"; do
    n=$(linha "$m")
    [[ -n $n ]] || falha "não chamou: $m"
    ((n > anterior)) || falha "fora de ordem: $m (linha $n do registro, depois da $anterior)"
    anterior=$n
  done
}
resultado() { grep -F "| $1 — " "$LOGS/resumo.md" | cut -d'|' -f3 | sed 's/^ //; s/ $//'; }

# 1. Tudo verde: ordem da CI, comandos e variáveis, tabela, saída 0, PostgreSQL 18 removido.
rodar "$VL"
[[ $STATUS == 0 ]] || falha "tudo verde saiu com $STATUS"
# A conferência do PostgreSQL 16 entra no banco postgres (o genesis_control pode não existir no servidor local).
em_ordem 'pnpm build' "psql postgres://genesis:genesis_dev@127.0.0.1:5432/postgres -tAc select 1" \
  'pnpm --filter api test:integracao | DATABASE_URL=postgres://genesis:genesis_dev@127.0.0.1:5432/'
em_ordem 'pnpm install --frozen-lockfile' 'pnpm format:check' 'pnpm lint' 'pnpm typecheck' \
  'pnpm --filter api db:gerar:controle' 'pnpm --filter api db:gerar:empresa' 'pnpm --filter api verificar:esquema-pdv' \
  'pnpm --filter @genesis/shared test' 'pnpm --filter api test:unit' 'pnpm --filter erp-web test' 'pnpm build' \
  'pnpm --filter api test:integracao | DATABASE_URL=postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control TETOS=100/250' \
  'docker info' 'docker run -d --rm --name genesis-verificacao-pg18-' \
  'pnpm --filter api test:integracao | DATABASE_URL=postgres://genesis:genesis_dev@127.0.0.1:55432/genesis_control TETOS=100/250' \
  'docker rm -f genesis-verificacao-pg18-' \
  'docker build -f apps/api/Dockerfile -t genesis-api:verificacao-local .' \
  'docker build -f apps/erp-web/Dockerfile -t genesis-web:verificacao-local .' \
  'docker build -f infra/producao/backup/Dockerfile -t genesis-backup:verificacao-local infra/producao/backup' \
  'shellcheck -x -S warning infra/producao/' "infra/producao/backup/testar-genesis-backup.sh $RAIZ" \
  "infra/producao/teste/testar-implantar-logs.sh $RAIZ" "infra/producao/teste/testar-implantar-sem-actions.sh $RAIZ" \
  'docker compose --project-directory . -f docker-compose.yml config -q' \
  "dotnet restore GenesisPDV.slnx --locked-mode | cwd=$RAIZ/apps/pdv" \
  "dotnet build GenesisPDV.slnx --no-restore -c Release | cwd=$RAIZ/apps/pdv" \
  "dotnet test --solution GenesisPDV.slnx --no-build -c Release | cwd=$RAIZ/apps/pdv TETO=800" \
  "dotnet format GenesisPDV.slnx --verify-no-changes --no-restore | cwd=$RAIZ/apps/pdv" \
  "apps/pdv/instalador/linux-wine/gerar-instalador.sh $RAIZ" "apps/pdv/instalador/linux-wine/testar-instalador.sh $RAIZ" \
  'dotnet build tests/GenesisPDV.E2E.Tests --no-restore -c Release' \
  "rodar.sh -c Release --no-build DATABASE_URL=postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control E2E_LOG_API=$LOGS/e2e-sync/e2e-api.log" \
  'shellcheck -x -S warning scripts/' "scripts/testar-verificar-local.sh $RAIZ" \
  "apps/pdv/instalador/linux-wine/teste/testar-gerar-instalador.sh $RAIZ" \
  "apps/pdv/instalador/linux-wine/teste/testar-publicar-release.sh $RAIZ"
grep -q '^shellcheck .*scripts/.*apps/pdv/instalador/linux-wine/gerar-instalador\.sh.*linux-wine/teste/testar-publicar-release\.sh' "$REGISTRO" ||
  falha 'o shellcheck do job scripts não cobre os scripts do instalador pelo Wine'
grep -q -- '--network host' "$REGISTRO" && falha 'sem proxy, o build não deveria usar a rede do host'
for j in ts integracao-pg16 integracao-pg18 imagens pdv pdv-formatacao pdv-instalador e2e-sync scripts; do
  [[ $(resultado "$j") == ok ]] || falha "job $j: '$(resultado "$j")' em vez de ok"
  [[ -s $LOGS/$j.log ]] || falha "sem o log do job $j"
done
grep -q '| Job | Resultado | Tempo |' "$T/saida" || falha 'a tabela não saiu na tela'
grep -q 'tudo verde' "$T/saida" || falha 'sem a mensagem final de sucesso'
grep -q 'Não coberto aqui' "$LOGS/resumo.md" || falha 'o resumo não lista o que fica só no Windows'
grep -q 'sem o Wine' "$T/saida" "$LOGS/resumo.md" && falha 'com o Wine instalado, avisou que falta o Wine'
[[ -z $(git -C "$RAIZ" status --porcelain) ]] || falha 'a verificação deixou arquivos na árvore (compose, segredos?)'
grep -q 'dockerd' "$REGISTRO" && falha 'com o Docker no ar, subiu o dockerd'
grep -q 'de-quem-chamou\|192\.0\.2\.1' "$REGISTRO" "$T/saida" && falha 'usou a configuração do ambiente de quem chamou'
confere 'tudo verde: jobs e passos na ordem da CI, variáveis da integração, tabela, saída 0, árvore limpa'

# 1b. Cada integração sozinha (--so) roda o install da CI antes dos testes (recompila o dist do shared).
for j in integracao-pg16 integracao-pg18; do
  rodar "$VL" --so "$j"
  [[ $STATUS == 0 ]] || falha "--so $j saiu com $STATUS"
  em_ordem 'pnpm install --frozen-lockfile' 'pnpm --filter api test:integracao'
done
confere 'integrações sozinhas: pnpm install --frozen-lockfile antes dos testes, como no job da CI'

# 1c. Docker fora do ar: o integracao-pg18 sozinho sobe o dockerd antes do container (não depende do job imagens).
touch "$DUBLE/docker-parado"
rm -f "$DUBLE/dockerd-no-ar"
rodar "$VL" --so integracao-pg18
rm -f "$DUBLE/docker-parado" "$DUBLE/dockerd-no-ar"
[[ $STATUS == 0 && $(resultado integracao-pg18) == ok ]] || falha "Docker parado: saída $STATUS, '$(resultado integracao-pg18)'"
em_ordem 'docker info' 'dockerd' 'docker run -d --rm --name genesis-verificacao-pg18-'
# Numa sessão própria (setsid): o Ctrl+C ou o SIGTERM ao grupo da verificação não derrubam o daemon.
if [[ -r /proc/$$/stat ]]; then
  sessao_dockerd=$(sed -n 's/^dockerd .* | sessao=\([0-9]*\)$/\1/p' "$REGISTRO")
  [[ -n $sessao_dockerd && $sessao_dockerd != "$(awk '{print $6}' /proc/$$/stat)" ]] ||
    falha "o dockerd subiu na sessão da verificação ('$sessao_dockerd'), sem o setsid"
fi
confere 'Docker fora do ar: o integracao-pg18 sobe o dockerd (numa sessão própria) antes do PostgreSQL 18'

# 2. Um job forçado a falhar: tabela com FALHOU, os outros seguem, saída ≠ 0, PostgreSQL 18 removido.
touch "$DUBLE/falhar-pg18"
rodar "$VL"
rm -f "$DUBLE/falhar-pg18"
[[ $STATUS == 1 ]] || falha "com falha forçada saiu com $STATUS (esperado 1)"
[[ $(resultado integracao-pg18) == FALHOU ]] || falha "integracao-pg18: '$(resultado integracao-pg18)'"
for j in ts integracao-pg16 imagens pdv pdv-formatacao pdv-instalador e2e-sync scripts; do
  [[ $(resultado "$j") == ok ]] || falha "job $j depois da falha: '$(resultado "$j")'"
done
grep -q '| integracao-pg18 — .* | FALHOU |' "$T/saida" || falha 'a tabela da tela não mostra o FALHOU'
grep -q 'teste de integração falhou (dublê)' "$T/saida" || falha 'a tela não mostra o fim do log do job que falhou'
em_ordem 'docker run -d --rm --name genesis-verificacao-pg18-' 'docker rm -f genesis-verificacao-pg18-' \
  'docker build -f apps/api/Dockerfile'
confere 'falha forçada na integração do PostgreSQL 18: FALHOU na tabela, demais jobs ok, saída 1, container removido'

# 3. SIGTERM no meio da integração do PostgreSQL 18: o trap remove o container.
touch "$DUBLE/travar-pg18"
rm -f "$DUBLE/travado"
: >"$REGISTRO"
env "${LIMPO[@]}" PATH="$BIN:$PATH" setsid "$VL" --so integracao-pg18 >"$T/saida" 2>&1 &
pid=$!
for _ in $(seq 1 100); do [[ -e $DUBLE/travado ]] && break; sleep 0.1; done
[[ -e $DUBLE/travado ]] || falha 'a integração do PostgreSQL 18 não começou'
kill -TERM -- "-$pid"
STATUS=0
wait "$pid" || STATUS=$?
rm -f "$DUBLE/travar-pg18"
[[ $STATUS == 143 ]] || falha "SIGTERM saiu com $STATUS (esperado 143)"
grep -q '^docker rm -f genesis-verificacao-pg18-' "$REGISTRO" || falha 'o container do PostgreSQL 18 ficou para trás'
confere 'SIGTERM durante os testes: saída 143 e o container do PostgreSQL 18 removido pelo trap'

# 3b. SIGTERM só ao PID do script (`kill <pid>`, não ao grupo): o trap não espera o fim do passo; encerra a árvore
#     dele (o sleep do dublê) e remove o container na hora.
touch "$DUBLE/travar-pg18"
rm -f "$DUBLE/travado"
: >"$REGISTRO"
env "${LIMPO[@]}" PATH="$BIN:$PATH" "$VL" --so integracao-pg18 >"$T/saida" 2>&1 &
pid=$!
for _ in $(seq 1 100); do [[ -s $DUBLE/travado ]] && break; sleep 0.1; done
[[ -s $DUBLE/travado ]] || falha 'a integração do PostgreSQL 18 não começou'
neto=$(<"$DUBLE/travado")
kill -TERM "$pid"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill -0 "$pid" 2>/dev/null && falha 'com o SIGTERM só no script, ele esperou o fim do passo'
STATUS=0
wait "$pid" || STATUS=$?
rm -f "$DUBLE/travar-pg18"
[[ $STATUS == 143 ]] || falha "SIGTERM só no script saiu com $STATUS (esperado 143)"
grep -q '^docker rm -f genesis-verificacao-pg18-' "$REGISTRO" || falha 'o container do PostgreSQL 18 ficou para trás'
for _ in $(seq 1 50); do kill -0 "$neto" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$neto" 2>/dev/null; then
  kill "$neto" 2>/dev/null || true
  falha 'o processo do passo (sleep do dublê) sobreviveu ao trap'
fi
confere 'SIGTERM só no script: sai na hora com 143, encerra a árvore do passo e remove o container'

# 3c. Sobra de uma verificação morta (PID que não existe mais) sai antes do container novo; a de um PID vivo, não,
#     nem a de um PID que o kill -0 não alcança mas existe (verificação viva de outro usuário: o ps -p a acha).
touch "$DUBLE/sobra"
export PID_VIVO=$$ # o deste teste, vivo durante a verificação
echo 999999998 >"$DUBLE/ps-vivos"
rodar "$VL" --so integracao-pg18
rm -f "$DUBLE/sobra" "$DUBLE/ps-vivos"
[[ $STATUS == 0 ]] || falha "com sobra de container saiu com $STATUS"
em_ordem 'docker rm -f genesis-verificacao-pg18-999999999' 'docker run -d --rm --name genesis-verificacao-pg18-'
grep -q '^docker rm -f genesis-verificacao-pg18-999999998' "$REGISTRO" && falha 'removeu o container de outro usuário vivo'
[[ $(grep -c '^docker rm -f ' "$REGISTRO") == 2 ]] || falha 'removeu container de verificação viva (ou não removeu o novo)'
confere 'sobra de verificação morta removida antes do PostgreSQL 18 novo; a de um PID vivo (inclusive de outro usuário) fica'

# 4. Schema Drizzle alterado sem migração: o job ts falha no passo e para ali.
touch "$DUBLE/drizzle-novo"
rodar "$VL" --so ts
rm -f "$DUBLE/drizzle-novo" "$RAIZ/apps/api/drizzle/empresa/0001_novo.sql"
[[ $STATUS == 1 && $(resultado ts) == FALHOU ]] || falha "drizzle: saída $STATUS, ts '$(resultado ts)'"
grep -q 'Schema Drizzle alterado sem migração' "$LOGS/ts.log" || falha 'o log do ts não explica a falha do Drizzle'
grep -q 'verificar:esquema-pdv' "$REGISTRO" && falha 'o ts seguiu depois do passo que falhou'
confere 'Drizzle: migração gerada na verificação reprova o ts (e o job para no passo)'

# 5. Atrás do proxy: rede do host, proxy nos build-args e as bases derivadas com o certificado.
echo 'certificado' >"$T/ca.crt"
: >"$REGISTRO"
STATUS=0
env "${LIMPO[@]}" PATH="$BIN:$PATH" HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=registro.exemplo VERIFICAR_CA="$T/ca.crt" \
  "$VL" --so imagens >"$T/saida" 2>&1 || STATUS=$?
[[ $STATUS == 0 ]] || falha "imagens atrás do proxy saiu com $STATUS"
em_ordem 'docker build -q --build-arg BASE=node:22-teste -t genesis-verificacao-base-node:local' \
  'docker build -q --build-arg BASE=alpine:teste -t genesis-verificacao-base-alpine:local' \
  'docker build --network host --build-arg HTTPS_PROXY=http://127.0.0.1:9 --build-arg https_proxy=http://127.0.0.1:9 --build-arg NO_PROXY=registro.exemplo --build-arg no_proxy=registro.exemplo --build-arg IMAGEM_NODE=genesis-verificacao-base-node:local -f apps/api/Dockerfile' \
  'docker build --network host --build-arg HTTPS_PROXY=http://127.0.0.1:9 --build-arg https_proxy=http://127.0.0.1:9 --build-arg NO_PROXY=registro.exemplo --build-arg no_proxy=registro.exemplo --build-arg IMAGEM_ALPINE=genesis-verificacao-base-alpine:local -f infra/producao/backup/Dockerfile'
confere 'proxy da sessão: --network host, proxy nos build-args e IMAGEM_NODE/IMAGEM_ALPINE com o certificado'

# 6. --so e --pular; opção e job desconhecidos saem com 2 sem rodar nada.
rodar "$VL" --so pdv-formatacao,scripts
[[ $STATUS == 0 && $(resultado pdv-formatacao) == ok && $(resultado scripts) == ok ]] || falha '--so não rodou os pedidos'
[[ $(resultado ts) == 'pulado (fora do --so)' ]] || falha "--so: ts '$(resultado ts)'"
grep -q '^pnpm' "$REGISTRO" && falha '--so pdv-formatacao,scripts chamou o pnpm'
rodar "$VL" --pular ts,imagens,e2e-sync,integracao-pg16,integracao-pg18
[[ $STATUS == 0 && $(resultado imagens) == 'pulado (--pular)' && $(resultado pdv) == ok ]] || falha '--pular'
grep -q '^docker' "$REGISTRO" && falha '--pular imagens,integracao-pg18 chamou o docker'
for args in '--so ts,inexistente' '--pular nada' '--desconhecida' '--so' '--mudancas'; do
  # shellcheck disable=SC2086 # os argumentos de propósito separados
  rodar "$VL" $args
  [[ $STATUS == 2 ]] || falha "'$args' saiu com $STATUS (esperado 2)"
  [[ -s $REGISTRO ]] && falha "'$args' rodou algum comando"
done
confere '--so e --pular; opção ou job desconhecido sai com 2 sem rodar nada'

# 7. --mudancas: o mudancas.sh recebe a base e um commit com a árvore de trabalho (o arquivo não commitado está nele);
#    só os jobs das saídas "true" rodam, o "scripts" roda sempre.
echo novo >"$RAIZ/nao-commitado.txt"
printf 'ts=false\npdv=true\nimagens=false\ne2e=false\n' >"$DUBLE/mudancas"
rodar "$VL" --mudancas HEAD
[[ $STATUS == 0 ]] || falha "--mudancas saiu com $STATUS"
read -r _ base ponta < <(grep '^mudancas.sh ' "$REGISTRO")
[[ $base == HEAD ]] || falha "--mudancas passou a base '$base'"
[[ $(git -C "$RAIZ" cat-file -t "$ponta") == commit ]] || falha "a ponta '$ponta' não é um commit"
[[ $(git -C "$RAIZ" show "$ponta:nao-commitado.txt") == novo ]] || falha 'a ponta não tem o arquivo não commitado'
[[ $(git -C "$RAIZ" rev-parse HEAD) == $(git -C "$RAIZ" rev-parse main) ]] || falha 'o --mudancas mexeu no HEAD'
[[ $(git -C "$RAIZ" status --porcelain) == '?? nao-commitado.txt' ]] || falha 'o --mudancas mexeu no índice'
for j in pdv pdv-formatacao pdv-instalador scripts; do
  [[ $(resultado "$j") == ok ]] || falha "--mudancas: $j '$(resultado "$j")'"
done
for j in ts integracao-pg16 integracao-pg18 imagens e2e-sync; do
  [[ $(resultado "$j") == 'pulado (sem mudanças)' ]] || falha "--mudancas: $j '$(resultado "$j")'"
done
rm -f "$RAIZ/nao-commitado.txt"
rodar "$VL" --mudancas nao-existe
[[ $STATUS == 2 ]] || falha "--mudancas com base inexistente saiu com $STATUS"
confere '--mudancas: árvore de trabalho num commit solto (sem mexer no HEAD nem no índice), jobs pela saída do mudancas.sh'

# 8. Sem o Wine: o pdv-instalador sai da rodada como pulado, com o aviso na tela e no resumo, e a rodada fica verde.
touch "$DUBLE/sem-wine"
rodar "$VL" --so pdv-instalador,scripts
rm -f "$DUBLE/sem-wine"
[[ $STATUS == 0 ]] || falha "sem o Wine saiu com $STATUS"
[[ $(resultado pdv-instalador) == 'pulado (sem o Wine)' ]] || falha "sem o Wine: pdv-instalador '$(resultado pdv-instalador)'"
grep -q 'aviso: pdv-instalador pulado: o Wine não está instalado' "$T/saida" || falha 'sem o aviso do Wine na tela'
grep -q 'o Wine não está instalado' "$LOGS/resumo.md" || falha 'sem o aviso do Wine no resumo'
grep -q '^apps/pdv/instalador/linux-wine/\(gerar\|testar\)-instalador\.sh ' "$REGISTRO" && falha 'sem o Wine, rodou o instalador'
[[ $(resultado scripts) == ok ]] || falha 'sem o Wine, o job scripts não rodou'
confere 'sem o Wine: pdv-instalador pulado com o aviso (tela e resumo), rodada verde'

[[ ! -e $VERIFICACAO_LOCAL_LOGS ]] || falha 'uma rodada escreveu na pasta de logs de quem chamou (VERIFICACAO_LOCAL_LOGS)'
confere 'nenhuma rodada usou VERIFICACAO_LOCAL_LOGS, VERIFICAR_PG16_URL, o mudancas.sh nem a imagem de quem chamou'

echo 'verificar-local.sh: todos os testes passaram'
