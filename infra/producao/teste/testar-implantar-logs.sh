#!/usr/bin/env bash
# Testes de unidade dos logs guardados do implantar.sh (`guardar_logs_api`, `limpar_logs`, `implantar.sh logs`;
# README de infra/producao › A API reiniciou sozinha), sem Docker: um `docker` dublê no PATH responde ao `inspect`, ao
# `logs` (com --since, --until e --tail sobre um log simulado) e ao `compose` do genesis-api. Cobre o que o teste
# local (testar-local.sh, com a stack de verdade) não alcança: a queda horas antes da troca (mais de 5.000 linhas
# depois dela: o trecho em volta do último reinício guarda a linha fatal), o stderr do container no arquivo (é onde
# sai o "JavaScript heap out of memory"), a retenção (20 arquivos, nada com mais de 30 dias), a falha do `docker logs`
# só avisando, a versão fora do padrão, o `logs` sem a trava e as quatro chamadas (implantar, voltar, a volta
# automática da implantação que não ficou saudável e o token-monitor), cada uma com o motivo no cabeçalho. E a saída
# do `implantar`, que vai para o log público do Actions (D60): sem log da API, lista de containers nem memória, com as
# instruções apontando o script da release nova (o link $PASTA/implantar.sh ainda é o da anterior, ou nem existe).
#
#   bash infra/producao/teste/testar-implantar-logs.sh
# Precisa de bash, coreutils e findutils (o CI roda no ubuntu-latest).
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
IMPLANTAR=$AQUI/../implantar.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-implantar-logs.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/pasta" "$T/docker"
export GENESIS_PASTA=$T/pasta
export DUBLE=$T/docker
LOGS=$T/pasta/logs

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublê do docker ----------------------------------------------------------------------------------------------
# $DUBLE/existe: o container genesis-api existe; $DUBLE/imagem, $DUBLE/iniciado e $DUBLE/reinicios: o .Config.Image,
# o .State.StartedAt e o .RestartCount dele; $DUBLE/log: o log, uma linha por linha do container ("<1|2> <data>
# <texto>", 1 = stdout, 2 = stderr); $DUBLE/logs-falha: o `logs` sai com erro; $DUBLE/up-falha-<versão>: o
# `compose up` da versão não fica saudável; $DUBLE/proxy-falha: o `compose up` do proxy do Cloud SQL não fica
# saudável; $DUBLE/chamadas: os argumentos de cada chamada. O `compose up` com o genesis-api recria o container na
# versão dele (log novo, sem reinícios), como o de verdade. O `compose logs`, o `compose ps` e o `stats` imprimem como
# os de verdade, para a conferência da saída do `implantar` pegar quem volte a chamá-los.
cat >"$T/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DUBLE/chamadas"
case "$1" in
  inspect)
    [ -e "$DUBLE/existe" ] || exit 1
    [ "${2:-}" = -f ] || { echo '[{}]'; exit 0; }
    s=$3
    s=${s//'{{.Config.Image}}'/"$(cat "$DUBLE/imagem")"}
    s=${s//'{{.State.StartedAt}}'/"$(cat "$DUBLE/iniciado")"}
    s=${s//'{{.RestartCount}}'/"$(cat "$DUBLE/reinicios")"}
    echo "$s"
    ;;
  logs)
    [ -e "$DUBLE/logs-falha" ] && { echo 'Error response from daemon: dead or marked for removal' >&2; exit 1; }
    shift
    desde='' ate='' cauda=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --since) desde=$2; shift 2 ;;
        --until) ate=$2; shift 2 ;;
        --tail) cauda=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    # --since/--until pela data até o segundo (AAAA-MM-DDTHH:MM:SS); --tail: as últimas do que sobrou.
    awk -v desde="${desde:0:19}" -v ate="${ate:0:19}" -v cauda="$cauda" '
      { t = substr($2, 1, 19) }
      (desde == "" || t >= desde) && (ate == "" || t <= ate) { n++; fd[n] = $1; l[n] = substr($0, 3) }
      END {
        i = (cauda == "" || n <= cauda + 0) ? 1 : n - cauda + 1
        for (; i <= n; i++) {
          if (fd[i] == 2) { print l[i] > "/dev/stderr"; fflush("/dev/stderr") } else { print l[i]; fflush() }
        }
      }' "$DUBLE/log"
    ;;
  stats) echo 'genesis-api  412MiB / 1GiB  3.10%' ;;
  image | exec) exit 0 ;;
  compose)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --project-directory | -f) shift 2 ;;
        *) break ;;
      esac
    done
    case "$1" in
      logs) cut -c3- "$DUBLE/log"; exit 0 ;;
      ps) echo "genesis-api  $(cat "$DUBLE/imagem" 2>/dev/null)  Up 2 hours (healthy)"; exit 0 ;;
      up) ;;
      *) exit 0 ;;
    esac
    # O passo 1/4 sobe só o proxy; o `subir` sobe tudo (o proxy junto).
    case " $* " in *' genesis-api '*) ;; *' genesis-cloudsql-proxy '*) [ ! -e "$DUBLE/proxy-falha" ]; exit ;; *) exit 0 ;; esac
    touch "$DUBLE/existe"
    echo "genesis-api:$GENESIS_VERSAO" >"$DUBLE/imagem"
    date -u +%Y-%m-%dT%H:%M:%S.000000000Z >"$DUBLE/iniciado"
    echo 0 >"$DUBLE/reinicios"
    echo "1 $(cat "$DUBLE/iniciado") {\"level\":30,\"context\":\"Processo\",\"msg\":\"API no ar\",\"versao\":\"$GENESIS_VERSAO\"}" >"$DUBLE/log"
    [ ! -e "$DUBLE/up-falha-$GENESIS_VERSAO" ]
    ;;
  *) exit 1 ;;
esac
DUBLE
chmod +x "$T/bin/docker"
export PATH=$T/bin:$PATH

implantar() { bash "$IMPLANTAR" "$@"; }
# A saída de uma implantação ($1: a descrição; $2: a saída) e as chamadas ao docker desde o último `: >chamadas` não
# podem levar ao log público do Actions o log da API, a lista de containers ou o uso de memória.
saida_sem_vazamento() {
  ! grep -q -e '"versao":' -e 'API no ar' -e 'heap out of memory' -e 'Up 2 hours' -e 'MiB' <<<"$2" ||
    falha "$1 pôs log da API, containers ou memória na saída: $2"
  ! grep -qE '^compose( .*)? (logs|ps)( |$)|^stats( |$)' "$DUBLE/chamadas" ||
    falha "$1 chamou compose logs/ps ou stats: $(grep -E '^compose( .*)? (logs|ps)( |$)|^stats( |$)' "$DUBLE/chamadas")"
}
guardados() { { find "$LOGS" -maxdepth 1 -name 'api-*.log' 2>/dev/null || true; } | sort; }
# Container no ar desde a volta da queda de 04/11 (18:05:43Z, um reinício pelo Docker), com o log curto de antes.
container_padrao() {
  touch "$DUBLE/existe"
  echo "genesis-api:$1" >"$DUBLE/imagem"
  echo 2026-11-04T18:05:43Z >"$DUBLE/iniciado"
  echo 1 >"$DUBLE/reinicios"
  cat >"$DUBLE/log" <<'LOG'
1 2026-11-04T18:05:40.000000000Z {"level":30,"msg":"Linha 900 de 1590"}
2 2026-11-04T18:05:42.000000000Z FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
1 2026-11-04T18:05:44.000000000Z {"level":30,"context":"Processo","msg":"API no ar"}
LOG
}
# O único arquivo guardado de uma versão ($1), e o motivo do cabeçalho ($2).
guardado_de() {
  local f
  f=$(find "$LOGS" -maxdepth 1 -name "api-*-$1.log" 2>/dev/null || true)
  [ -n "$f" ] && [ "$(wc -l <<<"$f")" = 1 ] || falha "esperava um arquivo guardado de $1: $(guardados)"
  head -n 1 "$f" | grep -qF "antes de: $2" || falha "cabeçalho do log de $1 sem 'antes de: $2': $(head -n 1 "$f")"
}

# --- Sem container ------------------------------------------------------------------------------------------------
saida=$(implantar logs)
grep -q 'Container genesis-api: não existe' <<<"$saida" || falha "logs sem container: $saida"
grep -q '(nenhum ainda)' <<<"$saida" || falha "logs sem arquivos deveria dizer (nenhum ainda)"
[ ! -e "$T/pasta/.implantacao.lock" ] || falha "implantar.sh logs pegou a trava das implantações"
implantar logs guardar >/dev/null || falha "logs guardar sem container deveria passar"
[ -z "$(guardados)" ] || falha "logs guardar sem container gravou arquivo"
confere "sem o container: nada a guardar, e o logs não pega a trava"

# --- Guardar ------------------------------------------------------------------------------------------------------
container_padrao 3dc47b0d23bd
implantar logs guardar >/dev/null || falha "logs guardar"
f=$(guardados)
[ "$(wc -l <<<"$f")" = 1 ] || falha "esperava um arquivo guardado: $f"
[[ ${f##*/} =~ ^api-[0-9]{8}T[0-9]{6}Z-3dc47b0d23bd\.log$ ]] || falha "nome fora do padrão: ${f##*/}"
[ "$(stat -c %a "$f")" = 600 ] && [ "$(stat -c %a "$LOGS")" = 700 ] || falha "permissões: $(stat -c '%a %n' "$f" "$LOGS")"
head -n 1 "$f" | grep -q '^# genesis-api 3dc47b0d23bd (no ar desde 2026-11-04T18:05:43Z, reinícios=1); guardado em .* antes de: implantar.sh logs guardar$' ||
  falha "cabeçalho: $(head -n 1 "$f")"
grep -q 'JavaScript heap out of memory' "$f" || falha "o stderr do container não foi para o arquivo"
grep -q '"msg":"API no ar"' "$f" || falha "o stdout do container não foi para o arquivo"
grep -qx 'logs --timestamps --tail 5000 genesis-api' "$DUBLE/chamadas" || falha "docker logs sem --timestamps --tail 5000"
confere "logs guardar: stdout e stderr com data, cabeçalho com reinícios, 600 numa pasta 700"

saida=$(implantar logs)
grep -qxF "$(printf '  %6s  %s' "$(du -h "$f" | cut -f1)" "${f##*/}")" <<<"$saida" || falha "linha do arquivo fora do formato '  %6s  %s': $saida"
grep -q 'Container genesis-api: genesis-api:3dc47b0d23bd, no ar desde 2026-11-04T18:05:43Z, reinícios=1' <<<"$saida" ||
  falha "logs sem o estado do container: $saida"
grep -q "${f##*/}" <<<"$saida" || falha "logs não lista o arquivo guardado"
confere "implantar.sh logs: o container (reinícios) e os arquivos"

# --- A queda horas antes da troca (04/11: a queda às 18:05Z, a implantação no dia seguinte) -------------------------
rm -rf "$LOGS"
: >"$DUBLE/chamadas"
echo 2026-11-04T18:05:43.512345678Z >"$DUBLE/iniciado"
{
  echo '1 2026-11-04T17:20:00.000000000Z {"level":30,"msg":"fora do trecho"}'
  echo '1 2026-11-04T17:50:12.000000000Z {"level":40,"context":"Processo","msg":"heap do Node acima de 85 % do limite"}'
  echo '1 2026-11-04T18:05:40.000000000Z {"level":30,"msg":"Linha 900 de 1590"}'
  echo '2 2026-11-04T18:05:42.000000000Z FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'
  echo '1 2026-11-04T18:05:44.000000000Z {"level":30,"context":"Processo","msg":"API no ar"}'
  # 6.000 linhas do healthcheck depois da volta (a cada 15 s: 25 h), mais que as 5.000 do fim do log.
  awk 'BEGIN {
    for (i = 1; i <= 6000; i++) {
      s = 18 * 3600 + 6 * 60 + 15 * i
      printf "1 2026-11-%02dT%02d:%02d:%02d.000000000Z {\"level\":30,\"req\":{\"url\":\"/saude\"},\"msg\":\"request completed\",\"n\":%d}\n",
        4 + int(s / 86400), int(s % 86400 / 3600), int(s % 3600 / 60), s % 60, i
    }
  }'
} >"$DUBLE/log"
implantar logs guardar >/dev/null || falha "logs guardar depois da queda"
f=$(guardados)
grep -qx 'logs --timestamps --since 2026-11-04T17:35:43Z --until 2026-11-04T18:07:43Z genesis-api' "$DUBLE/chamadas" ||
  falha "o trecho em volta do reinício deveria ir de 30 min antes a 2 min depois do StartedAt: $(grep '^logs' "$DUBLE/chamadas")"
grep -q 'FATAL ERROR: .*JavaScript heap out of memory' "$f" || falha "a linha fatal da queda não chegou ao arquivo"
grep -q 'heap do Node acima de 85 %' "$f" || falha "o aviso do heap de antes da queda não chegou ao arquivo"
grep -q '"msg":"API no ar"' "$f" || falha "o 'API no ar' da volta não chegou ao arquivo"
! grep -q 'fora do trecho' "$f" || falha "linha de antes do trecho (17:20) no arquivo"
grep -q '^# --- em volta do último reinício pelo Docker: de 2026-11-04T17:35:43Z a 2026-11-04T18:07:43Z' "$f" ||
  falha "sem o título do trecho do reinício"
[ "$(sed '1,/^# --- as últimas 5000 linhas ---$/d' "$f" | wc -l)" = 5000 ] || falha "o fim do log deveria ter 5000 linhas"
tail -n 1 "$f" | grep -q '"n":6000}' || falha "a última linha do log não está no arquivo"
! grep -q '"n":1000}' "$f" && grep -q '"n":1001}' "$f" || falha "o fim do log deveria começar na linha 1001 do healthcheck"
grep -n -E '"level":(50|60)|heap out of memory|FATAL ERROR|sinal SIG' "$f" | grep -q 'FATAL ERROR' ||
  falha "o grep do roteiro (implantar.sh logs) não acha a queda"
# Sem reinício pelo Docker (ou com o StartedAt fora do formato): só o fim do log.
for estado in '0 2026-11-04T18:05:43Z' '2 lixo'; do
  rm -rf "$LOGS"
  : >"$DUBLE/chamadas"
  echo "${estado%% *}" >"$DUBLE/reinicios"
  echo "${estado#* }" >"$DUBLE/iniciado"
  implantar logs guardar >/dev/null
  ! grep -q -- '--since' "$DUBLE/chamadas" && ! grep -q '^# --- ' "$(guardados)" ||
    falha "com '$estado' (reinícios, StartedAt) não deveria guardar o trecho do reinício"
done
head -n 1 "$(guardados)" | grep -q '(no ar desde ?, reinícios=2)' || falha "StartedAt fora do formato: $(head -n 1 "$(guardados)")"
container_padrao 3dc47b0d23bd
confere "queda horas antes da troca (6.000 linhas depois): o trecho de 30 min antes a 2 min depois do reinício guarda o aviso do heap, a linha fatal e a volta; sem reinício, só o fim"

# --- Versão fora do padrão e falha do docker logs -------------------------------------------------------------------
rm -rf "$LOGS"
echo 'sha256:0123abc; rm -rf /' >"$DUBLE/imagem"
implantar logs guardar >/dev/null
[[ $(guardados) =~ -desconhecida\.log$ ]] || falha "imagem fora do padrão deveria virar 'desconhecida': $(guardados)"
rm -rf "$LOGS"
echo genesis-api:abc >"$DUBLE/imagem"
touch "$DUBLE/logs-falha"
saida=$(implantar logs guardar 2>&1) || falha "falha do docker logs deveria só avisar"
grep -q 'ATENÇÃO: não foi possível guardar o log da API' <<<"$saida" || falha "falha do docker logs sem o aviso: $saida"
rm -f "$DUBLE/logs-falha"
confere "versão fora do padrão vira 'desconhecida'; falha do docker logs só avisa"

# --- Retenção -----------------------------------------------------------------------------------------------------
rm -rf "$LOGS"
mkdir -p "$LOGS"
for i in $(seq -w 1 24); do touch "$LOGS/api-202610${i}T120000Z-v$i.log"; done
# Dois com mais de 30 dias (pela data do arquivo), um deles entre os de nome mais recente.
touch -d '40 days ago' "$LOGS/api-20261001T120000Z-v01.log" "$LOGS/api-20261024T120000Z-v24.log"
implantar logs guardar >/dev/null
lista=$(guardados)
[ "$(wc -l <<<"$lista")" = 20 ] || falha "retenção deveria deixar 20 arquivos: $(wc -l <<<"$lista")"
! grep -q -e 'v01\.log' -e 'v24\.log' <<<"$lista" || falha "os com mais de 30 dias ficaram"
grep -q 'abc\.log$' <<<"$lista" || falha "o recém-guardado foi apagado"
grep -q 'v04\.log' <<<"$lista" && falha "os mais antigos além dos 20 deveriam sair: $lista"
grep -q 'v05\.log' <<<"$lista" || falha "o 20º mais recente deveria ficar: $lista"
confere "retenção: nada com mais de 30 dias e só os 20 mais recentes"

# --- Quem guarda: implantar, voltar, volta automática e token-monitor ----------------------------------------------
# A implantação de verdade com o dublê (migrações e `up` respondem 0; o `up` recria o container na versão nova).
rm -rf "$LOGS"
mkdir -p "$T/pasta/versoes" "$T/pasta/segredos"
for v in v1 v2 v3; do
  mkdir -p "$T/pasta/releases/$v"
  echo 'services: {}' >"$T/pasta/releases/$v/docker-compose.yml"
done
echo v1 >"$T/pasta/versoes/atual"
: >"$T/pasta/.env"
echo 'JWT_SEGREDO=x' >"$T/pasta/segredos/genesis-app.env"
container_padrao v1
: >"$DUBLE/chamadas"
saida=$(implantar implantar v2 2>&1) || falha "implantar v2: $saida"
[ "$(cat "$T/pasta/versoes/atual")" = v2 ] || falha "implantar v2 não registrou a versão"
saida_sem_vazamento "implantar v2 (no ar)" "$saida"
guardado_de v1 'implantar v2'
[ "$(guardados | wc -l)" = 1 ] || falha "implantar v2 deveria guardar um arquivo: $(guardados)"
implantar voltar >/dev/null || falha "voltar"
guardado_de v2 'voltar de v2 para v1'
[ "$(guardados | wc -l)" = 2 ] || falha "voltar deveria guardar um arquivo: $(guardados)"
rm -rf "$LOGS"
touch "$DUBLE/up-falha-v3"
: >"$DUBLE/chamadas"
saida=$(implantar implantar v3 2>&1) && falha "implantar v3 (sem ficar saudável) deveria falhar"
[ "$(cat "$T/pasta/versoes/atual")" = v1 ] || falha "a volta automática deveria deixar a v1 registrada"
saida_sem_vazamento "implantar v3 (volta automática)" "$saida"
# O link $PASTA/implantar.sh é o da v1 (que pode não ter o `logs`): a instrução é o script da v3, que sempre existe.
grep -qF "bash $T/pasta/releases/v3/implantar.sh logs" <<<"$saida" || falha "o erro da v3 deveria apontar o script da release nova: $saida"
grep -qF "$T/pasta/implantar.sh" <<<"$saida" && falha "o erro da v3 aponta o link da versão anterior: $saida"
guardado_de v1 'implantar v3'
guardado_de v3 'volta automática de v3 para v1'
grep -q '"versao":"v3"' "$(find "$LOGS" -name 'api-*-v3.log')" || falha "o log da v3 que não ficou saudável não foi guardado"
rm -rf "$LOGS"
implantar token-monitor --arquivo "$T/token" >/dev/null || falha "token-monitor --arquivo"
guardado_de v1 'token-monitor'
confere "implantar, voltar, a volta automática (o container que não ficou saudável) e o token-monitor guardam o log, com o motivo no cabeçalho"
confere "a saída do implantar (no ar e com volta automática) sem log da API, containers nem memória, e o erro aponta o script da release nova"

# --- Primeira instalação que não fica saudável (sem versão anterior) e proxy que não sobe --------------------------
rm -rf "$LOGS" "$T/pasta/versoes"
mkdir -p "$T/pasta/versoes"
: >"$DUBLE/chamadas"
saida=$(implantar implantar v3 2>&1) && falha "a primeira implantação (v3, sem ficar saudável) deveria falhar"
[ ! -e "$T/pasta/versoes/atual" ] || falha "a primeira implantação que falhou registrou a versão: $(cat "$T/pasta/versoes/atual")"
saida_sem_vazamento "a primeira implantação (v3)" "$saida"
grep -qF "bash $T/pasta/releases/v3/implantar.sh logs" <<<"$saida" || falha "a primeira implantação deveria apontar o script da release nova: $saida"
grep -q 'voltando para' <<<"$saida" && falha "sem versão anterior não há volta: $saida"
# O container de antes (o da v1 do teste anterior) e o da v3 que não ficou saudável.
f=$(find "$LOGS" -maxdepth 1 -name 'api-*-v3.log')
[ -n "$f" ] && [ "$(wc -l <<<"$f")" = 1 ] || falha "esperava o log da v3 que não ficou saudável: $(guardados)"
head -n 1 "$f" | grep -qF 'antes de: implantação de v3 que não ficou saudável em ' || falha "cabeçalho da primeira implantação: $(head -n 1 "$f")"
grep -q '"versao":"v3"' "$f" || falha "o log da v3 da primeira implantação não foi guardado"
rm -f "$DUBLE/up-falha-v3"
touch "$DUBLE/proxy-falha"
: >"$DUBLE/chamadas"
saida=$(implantar implantar v2 2>&1) && falha "implantar com o proxy fora do ar deveria falhar"
grep -qF "ERRO: o proxy do Cloud SQL não ficou saudável" <<<"$saida" || falha "proxy fora do ar sem a mensagem ERRO: $saida"
grep -qF "bash $T/pasta/releases/v2/implantar.sh estado" <<<"$saida" || falha "o erro do proxy deveria apontar o script da release nova: $saida"
! grep -q 'migrar-' "$DUBLE/chamadas" || falha "com o proxy fora do ar não deveria migrar"
[ ! -e "$T/pasta/versoes/atual" ] || falha "o proxy fora do ar registrou a versão"
rm -f "$DUBLE/proxy-falha"
confere "primeira instalação que não fica saudável: guarda o log com o motivo, não registra versão nem volta; proxy fora do ar: ERRO sem migrar"

# --- Uso ------------------------------------------------------------------------------------------------------------
implantar logs outra >/dev/null 2>&1 && falha "logs com subcomando desconhecido deveria falhar"
ajuda=$(implantar 2>/dev/null || true)
grep -q 'implantar.sh logs \[guardar\]' <<<"$ajuda" || falha "a ajuda não mostra o logs"
confere "uso: subcomando desconhecido recusado; a ajuda mostra o logs"

printf '\n\033[1;32mLogs do implantar.sh OK.\033[0m\n'
