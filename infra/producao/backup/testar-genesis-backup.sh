#!/usr/bin/env bash
# Testes de unidade do genesis-backup.sh (I1b; README de infra/producao › Backup), sem Docker, banco nem bucket: o
# script é carregado com `source` (só as funções) e o `s3`, o `pg_dump` e a lista de bancos viram dublês. O bucket
# dublê guarda versões como o GCS com versionamento (sobrescrita e DELETE sem versão viram versão antiga) e deixa
# injetar falhas por método e chave. Cobre o que o teste local (testar-local.sh, com um S3 de verdade) não alcança:
#   - a senha do DATABASE_URL decodificada como o pg-connection-string da API (`+` literal, só %XX, `\` literal);
#   - `estado` distinguindo "não existe" (NoSuchKey) de bucket indisponível (403, rede);
#   - manifesto que não sobe = dia com falha no estado.json (com o último sucesso anterior, também quando o estado
#     anterior não pôde ser lido);
#   - retenção apagando todas as versões dos dias vencidos e as versões antigas do resto, com paginação, e uma falha
#     de DELETE aparecendo como falha (não como "apagado").
#
#   bash infra/producao/backup/testar-genesis-backup.sh
# Precisa de bash, jq, awk, flock e coreutils (o CI roda no ubuntu-latest). Com o node e as dependências do
# repositório instaladas (pnpm install), confere também a senha contra o pg-connection-string de verdade.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RAIZ=$(cd "$AQUI/../../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-backup-unidade.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/tmp" "$T/trabalho" "$T/bucket" "$T/versoes"
export BACKUP_TMP=$T/tmp BACKUP_TRABALHO=$T/trabalho
export DATABASE_URL='postgres://genesis:x@genesis-cloudsql-proxy:5432/genesis_control'
export ARMAZENAMENTO_ENDPOINT=https://storage.googleapis.com ARMAZENAMENTO_REGIAO=auto ARMAZENAMENTO_BUCKET=teste
export ARMAZENAMENTO_CHAVE_ACESSO=GOOGteste ARMAZENAMENTO_CHAVE_SECRETA=segredo-de-teste ARMAZENAMENTO_CAMINHO=true
export BACKUP_RETENCAO_DIAS=14

# shellcheck source-path=SCRIPTDIR source=genesis-backup.sh
source "$AQUI/genesis-backup.sh"

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublês -------------------------------------------------------------------------------------------------------

# FALHAS: "MÉTODO|padrão-da-chave|código" separados por espaço (glob da chave, vazio = a listagem do bucket; código
# HTTP, ou `rede` para sem resposta).
FALHAS=''
PAGINA_VERSOES=3
falha_injetada() { # método chave → código na saída
  local f resto padrao
  for f in $FALHAS; do
    resto=${f#*|}
    padrao=${resto%|*}
    # shellcheck disable=SC2053 # o padrão da chave é um glob de propósito.
    if [ "${f%%|*}" = "$1" ] && { [ -z "$padrao" ] && [ -z "$2" ] || [ -n "$padrao" ] && [[ $2 == $padrao ]]; }; then
      echo "${f##*|}"
      return 0
    fi
  done
  return 1
}

# Contador em arquivo: o s3 roda também dentro de $(...).
nova_versao() {
  local n
  n=$(($(cat "$T/seq" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$T/seq"
  echo "$((1000000 + n))"
}

# Torna a versão atual de uma chave uma versão antiga (como o GCS faz na sobrescrita e no DELETE sem versão).
arquivar() {
  [ -f "$T/bucket/$1" ] || return 0
  mkdir -p "$T/versoes/$1"
  mv "$T/bucket/$1" "$T/versoes/$1/$(cat "$T/bucket/$1.id")"
  rm -f "$T/bucket/$1.id"
}

chaves_atuais() { (cd "$T/bucket" && find . -type f ! -name '*.id' | sed 's|^\./||' | LC_ALL=C sort); }

lista_versoes() { # prefixo → chave<TAB>id<TAB>atual, por chave e versão
  local k v
  {
    for k in $(chaves_atuais); do printf '%s\t%s\ttrue\n' "$k" "$(cat "$T/bucket/$k.id")"; done
    (cd "$T/versoes" && find . -type f | sed 's|^\./||') | while read -r v; do
      printf '%s\t%s\tfalse\n' "${v%/*}" "${v##*/}"
    done
  } | awk -F'\t' -v p="$1" 'index($1, p) == 1' | LC_ALL=C sort
}

s3() {
  local metodo=$1 chave=$2 consulta=${3:-} saida=- envio='' w='' codigo=200 corpo='' f
  shift 3 || shift $#
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) saida=$2 && shift 2 ;;
      -T) envio=$2 && shift 2 ;;
      -w) w=$2 && shift 2 ;;
      -H)
        # O GCS recusa um cabeçalho x-goog junto da assinatura x-amz do curl (400 ExcessHeaderValues).
        [[ $2 != [Xx]-[Gg][Oo][Oo][Gg]-* ]] || falha "cabeçalho $2 junto da assinatura x-amz: o GCS recusa (ExcessHeaderValues)"
        shift 2
        ;;
      *) shift ;;
    esac
  done
  echo "$metodo $chave${consulta:+?$consulta}" >>"$T/chamadas"
  if f=$(falha_injetada "$metodo" "$chave"); then
    if [ "$f" = rede ]; then
      [ -z "$w" ] || printf '000'
      echo 'curl: (6) Could not resolve host: storage.googleapis.com' >&2
      return 6
    fi
    codigo=$f
    corpo="<?xml version='1.0' encoding='UTF-8'?><Error><Code>AccessDenied</Code><Message>Access denied (dublê).</Message></Error>"
  else
    case "$metodo:$chave" in
      GET:)
        corpo=$(listagem "$consulta")
        ;;
      GET:*)
        if [ -f "$T/bucket/$chave" ]; then
          corpo=$(cat "$T/bucket/$chave")
        else
          codigo=404
          corpo='<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>'
        fi
        ;;
      PUT:*)
        arquivar "$chave"
        mkdir -p "$(dirname "$T/bucket/$chave")"
        cp "$envio" "$T/bucket/$chave"
        nova_versao >"$T/bucket/$chave.id"
        ;;
      DELETE:*)
        case "$consulta" in
          generation=*)
            if [ -f "$T/bucket/$chave.id" ] && [ "$(cat "$T/bucket/$chave.id")" = "${consulta#generation=}" ]; then
              rm -f "$T/bucket/$chave" "$T/bucket/$chave.id"
            else
              rm -f "$T/versoes/$chave/${consulta#generation=}"
            fi
            ;;
          '') arquivar "$chave" ;;
          *) falha "DELETE com consulta inesperada: $consulta" ;;
        esac
        codigo=204
        ;;
    esac
  fi
  if [ "$saida" = - ]; then printf '%s' "$corpo"; else printf '%s' "$corpo" >"$saida"; fi
  [ -z "$w" ] || printf '%s' "$codigo"
  [ "$codigo" -lt 400 ] || return 22
}

parametro() { # consulta nome → valor decodificado
  tr '&' '\n' <<<"$1" | sed -n "s/^$2=//p" | head -n 1 | {
    read -r v || true
    decodificar_url "${v:-}"
  }
}

listagem() {
  local consulta=$1 prefixo delimitador k resto
  prefixo=$(parametro "$consulta" prefix)
  # Formato do S3 (versions=, VersionId): o GCS não o devolve sem o cabeçalho x-goog, que ele recusa com a assinatura.
  [[ $consulta != versions=* && $consulta != *'&versions='* ]] || falha "listagem de versões no formato do S3 num endpoint do GCS: $consulta"
  if [[ $consulta == versions || $consulta == versions\&* || $consulta == *'&versions' || $consulta == *'&versions&'* ]]; then
    # Formato próprio do GCS, como devolvido em produção (04/11/2026): <Version> com <Generation> e <IsLatest>,
    # NextMarker/NextGenerationMarker e a página seguinte por marker + generation-marker.
    local km gm linhas pagina ultima
    km=$(parametro "$consulta" marker)
    gm=$(parametro "$consulta" generation-marker)
    ! tr '&' '\n' <<<"$consulta" | grep -q -e '^key-marker=' -e '^version-id-marker=' || falha "paginação do S3 no GCS: $consulta"
    linhas=$(lista_versoes "$prefixo")
    if [ -n "$km" ]; then
      linhas=$(awk -F'\t' -v k="$km" -v v="$gm" 'achou { print } $1 == k && $2 == v { achou = 1 }' <<<"$linhas")
    fi
    pagina=$(head -n "$PAGINA_VERSOES" <<<"$linhas")
    printf "<?xml version='1.0' encoding='UTF-8'?><ListBucketResult xmlns='http://doc.s3.amazonaws.com/2006-03-01'>"
    printf '<Name>teste</Name><Prefix>%s</Prefix><Marker></Marker><GenerationMarker></GenerationMarker>' "$prefixo"
    if [ "$(grep -c . <<<"$linhas" || true)" -gt "$PAGINA_VERSOES" ]; then
      ultima=$(tail -n 1 <<<"$pagina")
      printf '<NextMarker>%s</NextMarker><NextGenerationMarker>%s</NextGenerationMarker><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>' \
        "$(cut -f1 <<<"$ultima")" "$(cut -f2 <<<"$ultima")"
    else
      printf '<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>'
    fi
    [ -z "$pagina" ] || awk -F'\t' '{ printf "<Version><Key>%s</Key><Generation>%s</Generation><MetaGeneration>1</MetaGeneration><IsLatest>%s</IsLatest><LastModified>2026-11-04T16:13:49.429Z</LastModified><DeletedTime></DeletedTime><ETag>\"x\"</ETag><Size>1</Size></Version>", $1, $2, $3 }' <<<"$pagina"
    printf '</ListBucketResult>'
    return 0
  fi
  delimitador=$(parametro "$consulta" delimiter)
  printf '<ListBucketResult><IsTruncated>false</IsTruncated>'
  for k in $(chaves_atuais | awk -v p="$prefixo" 'index($0, p) == 1'); do
    resto=${k#"$prefixo"}
    if [ -n "$delimitador" ] && [[ $resto == *"$delimitador"* ]]; then
      echo "$prefixo${resto%%"$delimitador"*}$delimitador"
    else
      echo "K:$k"
    fi
  done | LC_ALL=C sort -u | while read -r k; do
    case "$k" in
      K:*) printf '<Contents><Key>%s</Key></Contents>' "${k#K:}" ;;
      *) printf '<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>' "$k" ;;
    esac
  done
  printf '</ListBucketResult>'
}

BANCOS=$'genesis_control\ngenesis_emp_1001'
listar_bancos() { echo "$BANCOS"; }
pg_dump() {
  [ "$1" != --version ] || {
    echo 'pg_dump (PostgreSQL) 18.6'
    return 0
  }
  local destino=''
  while [ $# -gt 0 ]; do
    [ "$1" = -f ] && destino=$2
    shift
  done
  head -c 2048 /dev/urandom >"$destino"
}

rodar_backup() { # → código de saída; log em $T/log
  local r=0
  (executar_backup) >"$T/log" 2>&1 || r=$?
  return "$r"
}
estado_bucket() { jq -c "$1" "$T/bucket/backups/estado.json"; }
versoes_antigas() { lista_versoes "${1:-backups/}" | awk -F'\t' '$3 == "false"' | grep -c . || true; }

preparar_bucket

# --- DATABASE_URL --------------------------------------------------------------------------------------------------

# O esperado é o do pg-connection-string (decodeURIComponent da userinfo), conferido com o node abaixo.
casos=(
  'ab+c%2Bd' 'ab+c+d'
  'a\b+c%2B%25d%3Ae%40f' 'a\b+c+%d:e@f'
  '%C3%A9%41' 'éA'
  '50%zz' '50%zz'
  '%25%2525' '%%25'
  'hex0123456789abcdef' 'hex0123456789abcdef'
)
for ((i = 0; i < ${#casos[@]}; i += 2)); do
  obtido=$(decodificar_url "${casos[i]}")
  [ "$obtido" = "${casos[i + 1]}" ] || falha "decodificar_url '${casos[i]}': veio '$obtido', esperado '${casos[i + 1]}'"
done
pcs=$(find "$RAIZ/node_modules/.pnpm" -maxdepth 3 -type d -path '*pg-connection-string@2*/node_modules/pg-connection-string' 2>/dev/null | head -n 1 || true)
if command -v node >/dev/null && [ -n "$pcs" ]; then
  for ((i = 0; i < ${#casos[@]}; i += 2)); do
    obtido=$(node -e 'process.stdout.write(require(process.argv[1]).parse(process.argv[2]).password)' "$pcs" \
      "postgres://genesis:${casos[i]}@h:5432/x")
    [ "$obtido" = "${casos[i + 1]}" ] || falha "pg-connection-string '${casos[i]}': veio '$obtido', esperado '${casos[i + 1]}'"
  done
  confere "senha do DATABASE_URL: decodificar_url igual ao pg-connection-string da API (${pcs##*/node_modules/.pnpm/})"
else
  confere "senha do DATABASE_URL: decodificar_url igual ao esperado do pg-connection-string (sem node_modules: sem a conferência ao vivo)"
fi
DATABASE_URL='postgres://us%2Ber:ab+c%2Bd%5C%3Ae\f@genesis-cloudsql-proxy:5432/genesis_control?sslmode=disable' preparar_banco
[ "$PG_USUARIO" = us+er ] || falha "usuário: '$PG_USUARIO'"
[ "$(cat "$PGPASSFILE")" = 'genesis-cloudsql-proxy:5432:*:us+er:ab+c+d\\\:e\\f' ] || falha "PGPASSFILE: $(cat "$PGPASSFILE")"
[ "$PG_SSLMODE" = disable ] || falha "sslmode: '$PG_SSLMODE'"
[ "$(stat -c %a "$PGPASSFILE")" = 600 ] || falha "PGPASSFILE sem 600"
confere "PGPASSFILE com '+' literal, %2B, '\\' e ':' escapados (600)"

# --- estado ---------------------------------------------------------------------------------------------------------

saida=$(estado 2>&1) || falha "estado sem estado.json deveria sair 0: $saida"
[ "$saida" = 'nenhum backup registrado ainda (backups/estado.json não existe no bucket)' ] || falha "estado ausente: $saida"
for f in 'GET|backups/estado.json|403' 'GET|backups/estado.json|503' 'GET|backups/estado.json|rede'; do
  r=0
  saida=$(FALHAS=$f estado 2>&1) || r=$?
  [ "$r" = 1 ] || falha "estado com $f deveria sair 1 (saiu $r): $saida"
  grep -q '^bucket indisponível: ' <<<"$saida" || falha "estado com $f: $saida"
  ! grep -q 'nenhum backup' <<<"$saida" || falha "estado com $f disse que não há backup"
done
saida=$(FALHAS='GET|backups/estado.json|403' estado 2>&1) || true
grep -q 'HTTP 403 AccessDenied: Access denied' <<<"$saida" || falha "estado 403 sem o motivo: $saida"
saida=$(FALHAS='GET|backups/estado.json|rede' estado 2>&1) || true
grep -q 'sem resposta de https://storage.googleapis.com: Could not resolve host' <<<"$saida" || falha "estado sem rede sem o motivo: $saida"
confere "estado: NoSuchKey = nenhum backup (saída 0); 403, 503 e sem rede = bucket indisponível com o motivo (saída 1)"

# --- Backup, manifesto e estado.json --------------------------------------------------------------------------------

DIA=$(date +%F)
rodar_backup || falha "backup: $(cat "$T/log")"
[ "$(estado_bucket '[.status, .bancos, (.ultimo_sucesso.dia)]')" = "[\"ok\",2,\"$DIA\"]" ] || falha "estado.json: $(estado_bucket .)"
[ -f "$T/bucket/backups/$DIA/manifesto.json" ] || falha "sem manifesto"
estado | grep -q '^último backup: ok' || falha "estado depois do backup"
# Manifesto antes do estado.json.
grep -n '^PUT ' "$T/chamadas" | grep -E 'manifesto.json|estado.json' | tail -n 2 | grep -q 'manifesto.json' &&
  [ "$(grep '^PUT ' "$T/chamadas" | tail -n 1)" = 'PUT backups/estado.json' ] || falha "ordem dos envios: $(grep '^PUT ' "$T/chamadas")"
sucesso_fim=$(estado_bucket '.ultimo_sucesso.fim')
confere "backup ok: manifesto enviado antes do estado.json; estado ok com o último sucesso de hoje"

rodar_backup || falha "segundo backup do dia: $(cat "$T/log")"
[ "$(versoes_antigas)" = 0 ] || falha "o segundo backup do dia deixou versões antigas: $(lista_versoes backups/)"
grep -q "apagados agora: 0" "$T/log" || falha "log da retenção: $(cat "$T/log")"
confere "backup agora repetido no mesmo dia: a sobrescrita não deixa versão antiga (dumps, manifesto e estado.json)"

sucesso_fim=$(estado_bucket '.ultimo_sucesso.fim')
manifesto_antes=$(sha256sum "$T/bucket/backups/$DIA/manifesto.json")
r=0
FALHAS='PUT|backups/*/manifesto.json|503' rodar_backup || r=$?
[ "$r" = 1 ] || falha "manifesto que não subiu deveria dar falha (saiu $r): $(cat "$T/log")"
[ "$(estado_bucket '.status')" = '"falhou"' ] || falha "estado.json com o manifesto falho: $(estado_bucket .)"
estado_bucket '.erro' | grep -q 'manifesto' || falha "estado.json sem o erro do manifesto: $(estado_bucket .)"
[ "$(estado_bucket '.ultimo_sucesso.fim')" = "$sucesso_fim" ] || falha "último sucesso perdido: $(estado_bucket .)"
[ "$(sha256sum "$T/bucket/backups/$DIA/manifesto.json")" = "$manifesto_antes" ] || falha "o manifesto do dia mudou"
grep -q 'FALHOU o envio do manifesto' "$T/log" || falha "log sem a falha do manifesto"
! grep -q 'retenção' "$T/log" || falha "retenção rodou num backup com falha"
estado | grep -q '^último backup: falhou' || falha "estado não mostra a falha"
confere "manifesto que não sobe: estado.json falhou (com o erro e o último sucesso anterior), sem retenção, saída 1"

r=0
FALHAS='PUT|backups/*/manifesto.json|503 GET|backups/estado.json|403' rodar_backup || r=$?
[ "$r" = 1 ] || falha "saída $r"
[ "$(estado_bucket '.ultimo_sucesso.dia')" = "\"$DIA\"" ] || falha "último sucesso pelos manifestos: $(estado_bucket .)"
grep -q 'ATENÇÃO: o estado.json anterior não pôde ser lido (HTTP 403' "$T/log" || falha "log sem o aviso do estado anterior: $(cat "$T/log")"
confere "estado anterior ilegível (403): o último sucesso vem do manifesto ok mais recente, não vira nenhum"

# --- Retenção --------------------------------------------------------------------------------------------------------

rodar_backup || falha "backup: $(cat "$T/log")"
for d in $(seq -w 1 15); do
  echo "dump $d" >"$T/x"
  for n in 1 2; do enviar "$T/x" "backups/2020-01-$d/genesis_control.dump" application/octet-stream; done
  enviar "$T/x" "backups/2020-01-$d/manifesto.json" application/json
done
[ "$(versoes_antigas backups/2020-01-01/)" = 1 ] || falha "preparo: versão antiga do dia falso"
: >"$T/chamadas"
rodar_backup || falha "backup com retenção: $(cat "$T/log")"
for d in 01 02; do
  [ -z "$(lista_versoes "backups/2020-01-$d/")" ] || falha "2020-01-$d ainda tem versões: $(lista_versoes "backups/2020-01-$d/")"
  grep -q "retenção: dia 2020-01-$d apagado do bucket (todas as versões)" "$T/log" || falha "log sem 2020-01-$d"
done
[ -f "$T/bucket/backups/2020-01-03/genesis_control.dump" ] || falha "2020-01-03 (14º dia mais recente) foi apagado"
[ "$(versoes_antigas)" = 0 ] || falha "sobraram versões antigas: $(lista_versoes backups/ | awk -F'\t' '$3 == "false"')"
grep -q 'apagados agora: 2' "$T/log" || falha "log da retenção: $(cat "$T/log")"
grep -q '^DELETE backups/2020-01-01/genesis_control.dump?generation=' "$T/chamadas" || falha "DELETE sem a geração (GCS)"
! grep -q '^DELETE [^?]*$' "$T/chamadas" || falha "DELETE sem versão (no GCS versionado só vira versão antiga)"
[ "$(grep -c '?versions&' "$T/chamadas")" -gt 3 ] || falha "a listagem de versões não paginou"
grep -q '&generation-marker=' "$T/chamadas" || falha "a paginação do GCS não usou generation-marker"
confere "retenção: dias vencidos saem com todas as versões (generation=, com paginação), o 14º dia fica, nenhuma versão antiga sobra"

echo "dump" >"$T/x"
for n in 1 2; do enviar "$T/x" backups/2020-01-03/genesis_control.dump application/octet-stream; done
for d in 01 02; do enviar "$T/x" "backups/2019-12-$d/genesis_control.dump" application/octet-stream; done
r=0
FALHAS='DELETE|backups/2019-12-01/*|500' rodar_backup || r=$?
[ "$r" = 0 ] || falha "o backup em si deu certo: saída $r ($(cat "$T/log"))"
grep -q 'FALHOU apagar backups/2019-12-01/genesis_control.dump' "$T/log" || falha "log sem o DELETE falho: $(cat "$T/log")"
grep -q 'FALHOU a retenção do dia 2019-12-01' "$T/log" || falha "log sem a falha do dia"
! grep -q 'dia 2019-12-01 apagado' "$T/log" || falha "o dia que não saiu foi registrado como apagado"
grep -q 'ATENÇÃO: a retenção falhou' "$T/log" || falha "sem o aviso da retenção"
[ -f "$T/bucket/backups/2019-12-01/genesis_control.dump" ] || falha "o dump do DELETE falho sumiu"
[ ! -f "$T/bucket/backups/2019-12-02/genesis_control.dump" ] || falha "2019-12-02 não saiu"
grep -q 'apagados agora: 1' "$T/log" || falha "contagem: $(grep retenção "$T/log")"
[ "$(versoes_antigas backups/2020-01-03/)" = 0 ] || falha "versão antiga de 2020-01-03 ficou"
confere "DELETE que falha: o dia continua e sai como FALHOU (não como apagado), o aviso da retenção aparece e o backup segue ok"

rm -rf "${T:?}/bucket"/* "${T:?}/versoes"/*
r=0
FALHAS='GET||503' aplicar_retencao >"$T/log" 2>&1 || r=$?
[ "$r" = 1 ] || falha "retenção sem a lista de dias deveria falhar (saiu $r)"
grep -q 'FALHOU a retenção: a lista de dias do bucket não veio' "$T/log" || falha "log: $(cat "$T/log")"
confere "retenção sem a lista de dias: falha explícita"

# A resposta real do GCS (04/11/2026, `?versions&prefix=backups/&max-keys=3`, numa linha só, nome do bucket trocado):
# a primeira página truncada e a segunda com uma versão antiga do estado.json.
(
  s3() {
    case "$3" in
      *generation-marker=1793808832317601*)
        printf '%s' "<?xml version='1.0' encoding='UTF-8'?><ListBucketResult xmlns='http://doc.s3.amazonaws.com/2006-03-01'><Name>teste</Name><Prefix>backups/</Prefix><Marker>backups/2026-11-04/manifesto.json</Marker><GenerationMarker>1793808832317601</GenerationMarker><MaxKeys>3</MaxKeys><IsTruncated>false</IsTruncated><Version><Key>backups/estado.json</Key><Generation>1793808700000001</Generation><MetaGeneration>1</MetaGeneration><IsLatest>false</IsLatest><LastModified>2026-11-04T16:11:40.001Z</LastModified><DeletedTime>2026-11-04T16:13:53.000Z</DeletedTime><ETag>\"a\"</ETag><Size>300</Size></Version><Version><Key>backups/estado.json</Key><Generation>1793808833000001</Generation><MetaGeneration>1</MetaGeneration><IsLatest>true</IsLatest><LastModified>2026-11-04T16:13:53.000Z</LastModified><DeletedTime></DeletedTime><ETag>\"b\"</ETag><Size>310</Size></Version></ListBucketResult>"
        ;;
      *)
        printf '%s' "<?xml version='1.0' encoding='UTF-8'?><ListBucketResult xmlns='http://doc.s3.amazonaws.com/2006-03-01'><Name>teste</Name><Prefix>backups/</Prefix><Marker></Marker><GenerationMarker></GenerationMarker><NextMarker>backups/2026-11-04/manifesto.json</NextMarker><NextGenerationMarker>1793808832317601</NextGenerationMarker><MaxKeys>3</MaxKeys><IsTruncated>true</IsTruncated><Version><Key>backups/2026-11-04/genesis_control.dump</Key><Generation>1793808829420082</Generation><MetaGeneration>1</MetaGeneration><IsLatest>true</IsLatest><LastModified>2026-11-04T16:13:49.429Z</LastModified><DeletedTime></DeletedTime><ETag>\"f317d77cb9774d3ccea8240e9c8594e4\"</ETag><Size>105772</Size></Version><Version><Key>backups/2026-11-04/genesis_emp_199322.dump</Key><Generation>1793808831725237</Generation><MetaGeneration>1</MetaGeneration><IsLatest>true</IsLatest><LastModified>2026-11-04T16:13:51.730Z</LastModified><DeletedTime></DeletedTime><ETag>\"06a97cdb27382c50910a1423108eb670\"</ETag><Size>1438858</Size></Version><Version><Key>backups/2026-11-04/manifesto.json</Key><Generation>1793808832317601</Generation><MetaGeneration>1</MetaGeneration><IsLatest>true</IsLatest><LastModified>2026-11-04T16:13:52.321Z</LastModified><DeletedTime></DeletedTime><ETag>\"a1803fe7d94c406ced833117215831e6\"</ETag><Size>680</Size></Version></ListBucketResult>"
        ;;
    esac
  }
  listar_versoes backups/ >"$T/versoes-gcs"
)
printf '%s\n' \
  $'backups/2026-11-04/genesis_control.dump\t1793808829420082\ttrue\tVersion' \
  $'backups/2026-11-04/genesis_emp_199322.dump\t1793808831725237\ttrue\tVersion' \
  $'backups/2026-11-04/manifesto.json\t1793808832317601\ttrue\tVersion' \
  $'backups/estado.json\t1793808700000001\tfalse\tVersion' \
  $'backups/estado.json\t1793808833000001\ttrue\tVersion' >"$T/versoes-esperadas"
cmp -s "$T/versoes-gcs" "$T/versoes-esperadas" || falha "listagem do GCS real: $(cat "$T/versoes-gcs")"
confere "listagem de versões no formato real do GCS (Generation, IsLatest, NextMarker/NextGenerationMarker, numa linha só), sem cabeçalho x-goog"

# --- Restauração: extensões do provedor que o destino não oferece ---------------------------------------------------

# A lista de um `pg_restore -l` de um banco do Cloud SQL (PostgreSQL 18): o provedor cria a google_vacuum_mgmt (esquema
# e extensão de mesmo nome) em todo banco, e o próprio Cloud SQL não deixa recriá-la na restauração.
cat >"$T/toc" <<'FIM'
;
; Archive created at 2026-11-04 16:13:49 UTC
;     dbname: genesis_control
;
; Selected TOC Entries:
;
8; 2615 16390 SCHEMA - google_vacuum_mgmt cloudsqladmin
9; 3079 16391 EXTENSION - google_vacuum_mgmt
3501; 0 0 COMMENT - EXTENSION google_vacuum_mgmt
2; 3079 16400 EXTENSION - pgcrypto
3502; 0 0 COMMENT - EXTENSION pgcrypto
230; 1259 16410 TABLE public empresas genesis
3490; 0 16410 TABLE DATA public empresas genesis
3300; 2606 16420 CONSTRAINT public empresas empresas_pkey genesis
FIM
printf 'pgcrypto\nplpgsql\n' >"$T/disponiveis"
filtrar_toc "$T/toc" "$T/disponiveis" "$T/lista" "$T/puladas"
! grep -q 'google_vacuum_mgmt' "$T/lista" || falha "google_vacuum_mgmt ficou na lista: $(grep google "$T/lista")"
for esperado in 'EXTENSION - pgcrypto' 'COMMENT - EXTENSION pgcrypto' 'TABLE public empresas' 'TABLE DATA public empresas' \
  'CONSTRAINT public empresas' '; Selected TOC Entries:'; do
  grep -qF "$esperado" "$T/lista" || falha "sumiu da lista: $esperado"
done
[ "$(cat "$T/puladas")" = google_vacuum_mgmt ] || falha "puladas: $(cat "$T/puladas")"
printf 'google_vacuum_mgmt\npgcrypto\nplpgsql\n' >"$T/disponiveis"
filtrar_toc "$T/toc" "$T/disponiveis" "$T/lista" "$T/puladas"
cmp -s "$T/toc" "$T/lista" || falha "com tudo disponível a lista deveria sair igual"
[ ! -s "$T/puladas" ] || falha "nada a pular, mas puladas: $(cat "$T/puladas")"
confere "restauração: extensão do provedor que o destino não oferece (google_vacuum_mgmt do Cloud SQL) sai da lista com o esquema e o COMMENT; o resto fica igual"

printf '\n\033[1;32mgenesis-backup.sh: testes de unidade OK.\033[0m\n'
