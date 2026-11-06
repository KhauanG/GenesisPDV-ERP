#!/usr/bin/env bash
# genesis-backup: backup lógico diário dos bancos do Genesis para o bucket (Implantação do piloto, I1b; README de
# infra/producao › Backup). Roda no container `genesis-backup`, pelo Cloud SQL Auth Proxy (genesis-cloudsql-proxy).
#
#   genesis-backup agendar                       # padrão do container: todo dia às BACKUP_HORARIO (Brasília)
#   genesis-backup agora                         # um backup já (o mesmo do agendado)
#   genesis-backup estado                        # resumo do backups/estado.json (último backup e último sucesso)
#   genesis-backup listar [AAAA-MM-DD]           # dias guardados no bucket, ou os arquivos de um dia
#   genesis-backup restaurar AAAA-MM-DD <banco|todos> [--como <nome_novo>]
#                                                # baixa, confere o sha256 e restaura no servidor do DATABASE_URL
#   genesis-backup psql <banco> [argumentos do psql...]
#                                                # psql no servidor do DATABASE_URL (conferir uma restauração)
#   genesis-backup saude                         # healthcheck do container
#
# Cada backup: pg_dump (formato custom, cliente do PostgreSQL 18) do genesis_control e de cada genesis_emp_*, um por
# vez, em /trabalho (volume, não tmpfs: o tmpfs contaria no limite de memória); envia para
# <bucket>/backups/AAAA-MM-DD/<banco>.dump (S3 do GCS com a chave HMAC de genesis-google.env), grava o
# manifesto.json do dia (tamanho e sha256 de cada arquivo) e o backups/estado.json (lido pelo /api/saude/detalhada).
# Retenção: depois de um backup sem falha, apaga (todas as versões) os dias que estão ao mesmo tempo fora dos
# BACKUP_RETENCAO_DIAS mais recentes guardados e fora dos últimos BACKUP_RETENCAO_DIAS dias do calendário (uma
# sequência de falhas nunca apaga o que sobrou de bom), e as versões não atuais de backups/ (o bucket do GCS tem
# versionamento: um DELETE ou uma sobrescrita sem a versão só deixa o objeto como versão antiga).
#
# Variáveis: DATABASE_URL, ARMAZENAMENTO_ENDPOINT, ARMAZENAMENTO_REGIAO, ARMAZENAMENTO_BUCKET,
# ARMAZENAMENTO_CHAVE_ACESSO, ARMAZENAMENTO_CHAVE_SECRETA, ARMAZENAMENTO_CAMINHO (as de genesis-google.env);
# BACKUP_HORARIO (padrão 04:30), BACKUP_RETENCAO_DIAS (14), BACKUP_PREFIXO (backups), TZ (America/Sao_Paulo);
# BACKUP_TMP (/tmp) e BACKUP_TRABALHO (/trabalho) só mudam nos testes (testar-genesis-backup.sh).
# Nada aqui imprime segredo: a senha do banco vai para um PGPASSFILE e a chave HMAC para um arquivo de configuração do
# curl, os dois em /tmp (tmpfs) com permissão 600.
set -euo pipefail
umask 077

HORARIO=${BACKUP_HORARIO:-04:30}
RETENCAO=${BACKUP_RETENCAO_DIAS:-14}
PREFIXO=${BACKUP_PREFIXO:-backups}
TRABALHO=${BACKUP_TRABALHO:-/trabalho}
TMP_BACKUP=${BACKUP_TMP:-/tmp}
export TZ=${TZ:-America/Sao_Paulo}
BATIMENTO=$TMP_BACKUP/genesis-backup.batimento
TRAVA=$TMP_BACKUP/genesis-backup.trava
CURL_CFG=$TMP_BACKUP/genesis-backup.curl
export PGPASSFILE=$TMP_BACKUP/genesis-backup.pgpass
export PGCONNECT_TIMEOUT=15
FORMATO_MANIFESTO=1

agora_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s genesis-backup: %s\n' "$(agora_utc)" "$*"; }
erro() {
  printf '%s genesis-backup: ERRO: %s\n' "$(agora_utc)" "$*" >&2
  exit 1
}
batimento() { : >"$BATIMENTO"; }

exigir_variaveis() {
  local v
  for v in DATABASE_URL ARMAZENAMENTO_ENDPOINT ARMAZENAMENTO_BUCKET ARMAZENAMENTO_CHAVE_ACESSO \
    ARMAZENAMENTO_CHAVE_SECRETA; do
    [ -n "${!v:-}" ] || erro "falta a variável $v (segredos/genesis-google.env)."
  done
  [[ $RETENCAO =~ ^[0-9]+$ ]] && [ "$RETENCAO" -ge 1 ] || erro "BACKUP_RETENCAO_DIAS inválido: '$RETENCAO'."
  [[ $HORARIO =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || erro "BACKUP_HORARIO inválido: '$HORARIO' (use HH:MM)."
}

# --- Banco --------------------------------------------------------------------------------------------------------

# Decodifica só as sequências %XX, como o pg-connection-string da API (decodeURIComponent da userinfo): `+` continua
# `+` (não é espaço fora de formulário) e a barra invertida é literal. Um `%` que não abre um %XX válido fica como está.
decodificar_url() {
  local resto=$1 saida='' byte
  while [[ $resto == *%* ]]; do
    saida+=${resto%%\%*}
    resto=${resto#*%}
    if [[ $resto =~ ^[0-9A-Fa-f]{2} ]]; then
      # shellcheck disable=SC2059 # o formato é só o escape \xHH (dois dígitos hexadecimais conferidos acima).
      printf -v byte "\\x${resto:0:2}"
      saida+=$byte
      resto=${resto:2}
    else
      saida+=%
    fi
  done
  printf '%s' "$saida$resto"
}

# Lê o DATABASE_URL (postgres://usuario:senha@host:porta/banco?sslmode=...) e grava a senha no PGPASSFILE; as
# conexões usam só host, porta e usuário (a senha nunca aparece na linha de comando).
preparar_banco() {
  local re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?(/[^?]*)?(\?(.*))?$'
  [[ $DATABASE_URL =~ $re ]] || erro "DATABASE_URL fora do formato postgres://usuario:senha@host:porta/banco."
  PG_USUARIO=$(decodificar_url "${BASH_REMATCH[2]}")
  local senha
  senha=$(decodificar_url "${BASH_REMATCH[4]}")
  PG_HOST=${BASH_REMATCH[5]}
  PG_PORTA=${BASH_REMATCH[7]:-5432}
  PG_SSLMODE=$(printf '%s' "${BASH_REMATCH[10]}" | tr '&' '\n' | sed -n 's/^sslmode=//p' | tail -n 1)
  local esc=${senha//\\/\\\\}
  esc=${esc//:/\\:}
  printf '%s:%s:*:%s:%s\n' "$PG_HOST" "$PG_PORTA" "${PG_USUARIO//:/\\:}" "$esc" >"$PGPASSFILE"
}

conexao() { # banco
  # shellcheck disable=SC2016 # o `'$PG_SSLMODE'` está dentro de "${...:+...}" entre aspas duplas: expande.
  printf "host='%s' port='%s' user='%s' dbname='%s' application_name='genesis_backup'%s" \
    "$PG_HOST" "$PG_PORTA" "$PG_USUARIO" "$1" "${PG_SSLMODE:+ sslmode='$PG_SSLMODE'}"
}

# sql BANCO CONSULTA [-v nome=valor...]: pela entrada padrão (o `-c` do psql não interpola as variáveis `:'nome'`).
sql() {
  local banco=$1 consulta=$2
  shift 2
  psql --no-psqlrc -X -v ON_ERROR_STOP=1 -Atq -d "$(conexao "$banco")" "$@" <<<"$consulta"
}

# Bancos do Genesis no servidor: o controle primeiro, depois as empresas.
listar_bancos() {
  echo genesis_control
  sql postgres "select datname from pg_database where datname ~ '^genesis_emp_[0-9]+$' and not datistemplate order by length(datname), datname"
}

# --- Bucket (S3 do GCS, assinatura SigV4 do curl) ------------------------------------------------------------------

preparar_bucket() {
  local u=${ARMAZENAMENTO_CHAVE_ACESSO}:${ARMAZENAMENTO_CHAVE_SECRETA}
  u=${u//\\/\\\\}
  printf 'user = "%s"\n' "${u//\"/\\\"}" >"$CURL_CFG"
  ENDPOINT=${ARMAZENAMENTO_ENDPOINT%/}
  REGIAO=${ARMAZENAMENTO_REGIAO:-auto}
  # O padrão da API (`ARMAZENAMENTO_CAMINHO`) é o estilo caminho (endpoint/bucket/chave).
  case "${ARMAZENAMENTO_CAMINHO:-true}" in
    1 | true | sim | yes) BASE="$ENDPOINT/$ARMAZENAMENTO_BUCKET" ;;
    *) BASE="${ENDPOINT%%://*}://$ARMAZENAMENTO_BUCKET.${ENDPOINT#*://}" ;;
  esac
  # Apagar UMA versão: o XML do GCS documenta `generation` (o número da versão, que é o `VersionId` da listagem);
  # o S3 (o teste local) usa `versionId`.
  case "$ENDPOINT" in
    *://storage.googleapis.com | *://*.storage.googleapis.com) PARAMETRO_VERSAO=generation ;;
    *) PARAMETRO_VERSAO=versionId ;;
  esac
}

uri() { jq -rn --arg v "$1" '$v|@uri'; }

# s3 MÉTODO CHAVE [CONSULTA] [argumentos do curl...]: corpo da resposta na saída; falha (código ≠ 0) em HTTP ≥ 400.
s3() {
  local metodo=$1 chave=$2 consulta=${3:-}
  shift 3 || shift $#
  local url=$BASE
  [ -n "$chave" ] && url="$url/$chave"
  [ -n "$consulta" ] && url="$url?$consulta"
  curl -sS --fail-with-body --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 3600 -K "$CURL_CFG" \
    --aws-sigv4 "aws:amz:$REGIAO:s3" -X "$metodo" "$@" "$url"
}

enviar() { # arquivo chave tipo [sha256]
  local cabecalhos=(-H "Content-Type: $3")
  [ -n "${4:-}" ] && cabecalhos+=(-H "x-amz-meta-sha256: $4")
  s3 PUT "$2" '' -T "$1" "${cabecalhos[@]}" -o /dev/null
}

baixar() { s3 GET "$1" '' -o "$2"; }

# baixar_objeto CHAVE ARQUIVO: 0 = baixou; 2 = o objeto não existe (NoSuchKey); 1 = bucket indisponível (chave HMAC
# sem permissão, rede, 5xx...), com o motivo curto em $MOTIVO_BUCKET. Nunca confunde "não existe" com "não consegui
# ler" (o `estado` e o último sucesso guardado dependem disso).
baixar_objeto() {
  local chave=$1 arquivo=$2 codigo erro=$TMP_BACKUP/genesis-backup.erro-curl
  MOTIVO_BUCKET=''
  if codigo=$(s3 GET "$chave" '' -o "$arquivo" -w '%{http_code}' 2>"$erro"); then
    rm -f "$erro"
    return 0
  fi
  if [ -f "$arquivo" ] && grep -q '<Code>NoSuchKey</Code>' "$arquivo"; then
    rm -f "$arquivo" "$erro"
    return 2
  fi
  local corpo=''
  [ -f "$arquivo" ] && corpo=$(tr '\n' ' ' <"$arquivo" | sed -n 's|.*<Code>\([^<]*\)</Code>.*<Message>\([^<]*\)</Message>.*|\1: \2|p')
  [ -n "$corpo" ] || [ ! -f "$arquivo" ] || corpo=$(tr '\n' ' ' <"$arquivo" | sed -n 's|.*<Code>\([^<]*\)</Code>.*|\1|p')
  case "$codigo" in
    '' | 000) MOTIVO_BUCKET="sem resposta de $ENDPOINT: $({ grep '^curl: (' "$erro" || true; } | tail -n 1 | sed 's/^curl: ([0-9]*) //' | cut -c1-200)" ;;
    *) MOTIVO_BUCKET="HTTP $codigo${corpo:+ $corpo}" ;;
  esac
  MOTIVO_BUCKET=$(printf '%s' "$MOTIVO_BUCKET" | cut -c1-300)
  rm -f "$arquivo" "$erro"
  return 1
}

# Chaves (ou prefixos comuns, com delimitador) sob um prefixo, com paginação (ListObjectsV2).
listar_chaves() { # prefixo [delimitador]
  local prefixo=$1 delimitador=${2:-} token='' resposta consulta
  while :; do
    consulta="list-type=2&prefix=$(uri "$prefixo")"
    [ -n "$delimitador" ] && consulta="delimiter=$(uri "$delimitador")&$consulta"
    [ -n "$token" ] && consulta="continuation-token=$(uri "$token")&$consulta"
    resposta=$(s3 GET '' "$consulta") || return 1
    if [ -n "$delimitador" ]; then
      grep -o '<CommonPrefixes><Prefix>[^<]*</Prefix>' <<<"$resposta" | sed 's/.*<Prefix>//; s/<\/Prefix>//' || true
    else
      grep -o '<Key>[^<]*</Key>' <<<"$resposta" | sed 's/<Key>//; s/<\/Key>//' || true
    fi
    grep -q '<IsTruncated>true</IsTruncated>' <<<"$resposta" || break
    token=$(grep -o '<NextContinuationToken>[^<]*</NextContinuationToken>' <<<"$resposta" | sed 's/<[^>]*>//g')
    [ -n "$token" ] || break
  done
}

# Dias guardados (AAAA-MM-DD), do mais recente para o mais antigo.
listar_dias() {
  listar_chaves "$PREFIXO/" / | sed -n "s|^$PREFIXO/\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)/$|\1|p" | sort -r
}

# Todas as versões sob um prefixo (com paginação), uma por linha:
# chave<TAB>versão<TAB>atual (true/false)<TAB>tipo (Version/DeleteMarker). Dois formatos:
# - GCS: o formato próprio do XML do GCS (`versions` sem valor; cada versão em <Version> com <Generation> e <IsLatest>;
#   página seguinte por marker + generation-marker a partir de NextMarker/NextGenerationMarker). O cabeçalho
#   x-goog-interop-list-objects-format (que pediria o formato do S3) NÃO pode ir: o GCS recusa x-goog junto da
#   assinatura x-amz do curl (400 ExcessHeaderValues, "Requests cannot specify both x-amz and x-goog headers"; achado
#   em produção em 04/11/2026). A <Generation> é o mesmo número que o DELETE recebe em `generation=`.
# - S3 (o teste local com MinIO): ListObjectVersions (`versions=`, <VersionId>, key-marker + version-id-marker).
# Num bucket sem versionamento, só as versões atuais (VersionId "null" no S3).
listar_versoes() { # prefixo
  local prefixo=$1 marcador_chave='' marcador_versao='' resposta consulta
  while :; do
    if [ "$PARAMETRO_VERSAO" = generation ]; then
      consulta="versions&prefix=$(uri "$prefixo")"
      [ -z "$marcador_chave" ] || consulta="$consulta&marker=$(uri "$marcador_chave")"
      [ -z "$marcador_versao" ] || consulta="$consulta&generation-marker=$(uri "$marcador_versao")"
    else
      consulta="versions=&prefix=$(uri "$prefixo")"
      [ -z "$marcador_chave" ] || consulta="$consulta&key-marker=$(uri "$marcador_chave")"
      [ -z "$marcador_versao" ] || consulta="$consulta&version-id-marker=$(uri "$marcador_versao")"
    fi
    resposta=$(s3 GET '' "$consulta") || return 1
    awk 'BEGIN { RS = "<" }
      function valor(n) { v = substr($0, n); sub(/[ \t\r\n]+$/, "", v); return v }
      /^(Version|DeleteMarker)>/ { tipo = substr($0, 1, index($0, ">") - 1); chave = ""; versao = ""; atual = ""; next }
      tipo != "" && /^Key>/ { chave = valor(5) }
      tipo != "" && /^VersionId>/ { versao = valor(11) }
      tipo != "" && /^Generation>/ { versao = valor(12) }
      tipo != "" && /^IsLatest>/ { atual = valor(10) }
      tipo != "" && /^\/(Version|DeleteMarker)>/ { printf "%s\t%s\t%s\t%s\n", chave, versao, atual, tipo; tipo = "" }' \
      <<<"$resposta"
    grep -q '<IsTruncated>true</IsTruncated>' <<<"$resposta" || break
    if [ "$PARAMETRO_VERSAO" = generation ]; then
      marcador_chave=$(grep -o '<NextMarker>[^<]*</NextMarker>' <<<"$resposta" | sed 's/<[^>]*>//g' || true)
      marcador_versao=$(grep -o '<NextGenerationMarker>[^<]*</NextGenerationMarker>' <<<"$resposta" | sed 's/<[^>]*>//g' || true)
    else
      marcador_chave=$(grep -o '<NextKeyMarker>[^<]*</NextKeyMarker>' <<<"$resposta" | sed 's/<[^>]*>//g' || true)
      marcador_versao=$(grep -o '<NextVersionIdMarker>[^<]*</NextVersionIdMarker>' <<<"$resposta" | sed 's/<[^>]*>//g' || true)
    fi
    [ -n "$marcador_chave" ] || return 1
  done
}

apagar_versao() { # chave versão
  if [ -z "$2" ] || [ "$2" = null ]; then
    s3 DELETE "$1" '' -o /dev/null
  else
    s3 DELETE "$1" "$PARAMETRO_VERSAO=$(uri "$2")" -o /dev/null
  fi
}

# apagar_versoes PREFIXO todas|antigas: `todas` apaga cada versão de cada objeto (o dia sai do bucket de verdade, não
# vira versão antiga) e confere que não sobrou objeto atual; `antigas` só as versões não atuais (sobrescritas de
# `backup agora` no mesmo dia e do estado.json). Devolve 1 se algo não foi apagado (sem depender do `set -e`, que não
# vale dentro de função chamada com `||`).
apagar_versoes() {
  local prefixo=$1 modo=$2 versoes chave versao atual tipo falhas=0 sobra
  versoes=$(listar_versoes "$prefixo") || {
    log "FALHOU a listagem das versões de $prefixo"
    return 1
  }
  while IFS=$'\t' read -r chave versao atual tipo; do
    [ -n "$chave" ] || continue
    # Uma marca de exclusão atual (S3) esconde as versões antigas: só sai junto com o dia (`todas`).
    [ "$modo" = todas ] || { [ "$atual" = false ] && [ "$tipo" = Version ]; } || continue
    if ! apagar_versao "$chave" "$versao" 2>/dev/null; then
      log "FALHOU apagar $chave (versão $versao)"
      falhas=$((falhas + 1))
    fi
  done <<<"$versoes"
  if [ "$modo" = todas ]; then
    if ! sobra=$(listar_chaves "$prefixo"); then
      log "FALHOU a conferência de $prefixo depois de apagar"
      return 1
    fi
    [ -z "$sobra" ] || {
      log "FALHOU: $prefixo ainda tem $(grep -c . <<<"$sobra") objeto(s) depois de apagar"
      return 1
    }
  fi
  [ "$falhas" -eq 0 ]
}

# --- Backup -------------------------------------------------------------------------------------------------------

# Retenção: só depois de um backup sem falha; apaga os dias além dos $RETENCAO mais recentes E fora dos últimos
# $RETENCAO dias do calendário (as duas condições: falhas seguidas nunca reduzem o que sobra), com todas as versões, e
# depois as versões não atuais do que fica. Devolve 1 se alguma parte falhou (o dia que sobrou entra de novo amanhã).
aplicar_retencao() {
  local limite dias dia n=0 apagados=0 falhou=0
  limite=$(date -d "@$(($(date +%s) - (RETENCAO - 1) * 86400))" +%F)
  dias=$(listar_dias) || {
    log "FALHOU a retenção: a lista de dias do bucket não veio"
    return 1
  }
  for dia in $dias; do
    n=$((n + 1))
    [ "$n" -gt "$RETENCAO" ] || continue
    [[ $dia < $limite ]] || continue
    if apagar_versoes "$PREFIXO/$dia/" todas; then
      apagados=$((apagados + 1))
      log "retenção: dia $dia apagado do bucket (todas as versões)"
    else
      falhou=1
      log "FALHOU a retenção do dia $dia (continua no bucket; a próxima retenção tenta de novo)"
    fi
  done
  if ! apagar_versoes "$PREFIXO/" antigas; then
    falhou=1
    log "FALHOU apagar as versões antigas de $PREFIXO/"
  fi
  log "retenção: $((n - apagados)) dia(s) guardado(s) (mantém $RETENCAO; apagados agora: $apagados)"
  return "$falhou"
}

# Último sucesso a guardar no estado.json quando este backup falhar: o do estado.json anterior; se o bucket não deixou
# ler o estado (e não por ele não existir), o do manifesto ok mais recente, para não gravar "nenhum" por um erro de
# leitura passageiro.
ultimo_sucesso_anterior() {
  local arquivo=$TRABALHO/estado-anterior.json r=0 d
  baixar_objeto "$PREFIXO/estado.json" "$arquivo" || r=$?
  if [ "$r" = 0 ]; then
    jq -c '.ultimo_sucesso // null' "$arquivo" 2>/dev/null || echo null
    rm -f "$arquivo"
    return 0
  fi
  if [ "$r" = 2 ]; then
    echo null
    return 0
  fi
  log "ATENÇÃO: o estado.json anterior não pôde ser lido ($MOTIVO_BUCKET); último sucesso pelos manifestos" >&2
  for d in $(listar_dias 2>/dev/null || true); do
    if baixar_objeto "$PREFIXO/$d/manifesto.json" "$arquivo" &&
      jq -e '.status == "ok"' "$arquivo" >/dev/null 2>&1; then
      jq -c '{dia, fim, tamanho_bytes}' "$arquivo"
      rm -f "$arquivo"
      return 0
    fi
    rm -f "$arquivo"
  done
  echo null
}

executar_backup() {
  exec 8>"$TRAVA"
  flock -n 8 || erro "outro backup (ou restauração) em andamento neste container."
  local inicio dia prefixo bancos banco arquivo tamanho sha total=0 itens='[]' falhas='[]' msg
  inicio=$(agora_utc)
  dia=$(date +%F)
  prefixo="$PREFIXO/$dia"
  batimento
  log "backup do dia $dia iniciado ($(pg_dump --version))"
  mkdir -p "$TRABALHO"
  rm -f "$TRABALHO"/*.dump "$TRABALHO"/*.erro
  if ! bancos=$(listar_bancos 2>"$TRABALHO/listar.erro"); then
    falhas=$(jq -c --arg e "$(tail -n 3 "$TRABALHO/listar.erro" | tr '\n' ' ' | cut -c1-300)" \
      '. + [{banco: "(lista de bancos)", erro: $e}]' <<<"$falhas")
    bancos=''
  fi
  rm -f "$TRABALHO/listar.erro"
  for banco in $bancos; do
    batimento
    arquivo=$TRABALHO/$banco.dump
    if ! pg_dump --format=custom --compress=6 --no-password -d "$(conexao "$banco")" -f "$arquivo" \
      2>"$TRABALHO/$banco.erro"; then
      msg=$(tail -n 3 "$TRABALHO/$banco.erro" | tr '\n' ' ' | cut -c1-300)
      log "FALHOU $banco: pg_dump: $msg"
      falhas=$(jq -c --arg b "$banco" --arg e "pg_dump: $msg" '. + [{banco: $b, erro: $e}]' <<<"$falhas")
      rm -f "$arquivo" "$TRABALHO/$banco.erro"
      continue
    fi
    rm -f "$TRABALHO/$banco.erro"
    tamanho=$(stat -c %s "$arquivo")
    sha=$(sha256sum "$arquivo" | cut -d' ' -f1)
    batimento
    if ! msg=$(enviar "$arquivo" "$prefixo/$banco.dump" application/octet-stream "$sha" 2>&1); then
      msg=$(printf '%s' "$msg" | tr '\n' ' ' | cut -c1-300)
      log "FALHOU $banco: envio ao bucket: $msg"
      falhas=$(jq -c --arg b "$banco" --arg e "envio: $msg" '. + [{banco: $b, erro: $e}]' <<<"$falhas")
      rm -f "$arquivo"
      continue
    fi
    rm -f "$arquivo"
    total=$((total + tamanho))
    itens=$(jq -c --arg b "$banco" --argjson t "$tamanho" --arg s "$sha" \
      '. + [{banco: $b, arquivo: ($b + ".dump"), tamanho_bytes: $t, sha256: $s}]' <<<"$itens")
    log "ok $banco: $tamanho bytes, sha256 $sha"
  done
  [ "$(jq length <<<"$itens")" -gt 0 ] || [ "$(jq length <<<"$falhas")" -gt 0 ] ||
    falhas='[{"banco":"(nenhum)","erro":"nenhum banco encontrado"}]'
  local fim manifesto=$TRABALHO/manifesto.json estado=$TRABALHO/estado.json status anterior=null
  fim=$(agora_utc)
  status=ok
  [ "$(jq length <<<"$falhas")" -eq 0 ] || status=falhou
  jq -n --argjson formato "$FORMATO_MANIFESTO" --arg dia "$dia" --arg inicio "$inicio" --arg fim "$fim" \
    --arg status "$status" --arg pg "$(pg_dump --version)" --arg versao "${GENESIS_VERSAO:-desconhecida}" \
    --argjson bancos "$itens" --argjson falhas "$falhas" --argjson total "$total" \
    '{formato: $formato, dia: $dia, inicio: $inicio, fim: $fim, status: $status, pg_dump: $pg,
      versao_genesis: $versao, tamanho_bytes: $total, bancos: $bancos, falhas: $falhas}' >"$manifesto"
  # O manifesto vai ANTES do estado.json (quando algum arquivo foi: sem ele, o dia não aparece como restaurável), e o
  # estado sai com o status final: um manifesto que não subiu é falha do dia, não "ok" no painel.
  if [ "$(jq length <<<"$itens")" -gt 0 ]; then
    if ! msg=$(enviar "$manifesto" "$prefixo/manifesto.json" application/json 2>&1); then
      msg=$(printf '%s' "$msg" | tr '\n' ' ' | cut -c1-300)
      log "FALHOU o envio do manifesto do dia $dia: $msg"
      falhas=$(jq -c --arg e "envio do manifesto: $msg" '. + [{banco: "(manifesto)", erro: $e}]' <<<"$falhas")
      status=falhou
    fi
  fi
  [ "$status" = ok ] || anterior=$(ultimo_sucesso_anterior)
  jq -n --argjson formato "$FORMATO_MANIFESTO" --arg dia "$dia" --arg inicio "$inicio" --arg fim "$fim" \
    --arg status "$status" --argjson total "$total" --argjson n "$(jq length <<<"$itens")" \
    --argjson falhas "$falhas" --argjson anterior "$anterior" \
    '{formato: $formato, status: $status, dia: $dia, inicio: $inicio, fim: $fim, tamanho_bytes: $total,
      bancos: $n, falhas: ($falhas | length),
      erro: (if ($falhas | length) > 0 then ($falhas | map(.banco + ": " + .erro) | join("; ") | .[0:500]) else null end),
      ultimo_sucesso: (if $status == "ok" then {dia: $dia, fim: $fim, tamanho_bytes: $total} else $anterior end)}' >"$estado"
  enviar "$estado" "$PREFIXO/estado.json" application/json || log "FALHOU o envio do estado.json"
  rm -f "$manifesto" "$estado"
  if [ "$status" = ok ]; then
    aplicar_retencao || log "ATENÇÃO: a retenção falhou (o backup do dia está completo)"
    log "backup do dia $dia concluído: $(jq length <<<"$itens") banco(s), $total bytes"
    return 0
  fi
  log "backup do dia $dia FALHOU: $(jq -r 'map(.banco + ": " + .erro) | join("; ")' <<<"$falhas")"
  return 1
}

agendar() {
  log "agendado todo dia às $HORARIO ($TZ); retenção de $RETENCAO dias; bucket $ARMAZENAMENTO_BUCKET/$PREFIXO/"
  trap 'log "encerrado"; exit 0' TERM INT
  batimento
  local alvo restante
  while :; do
    alvo=$(date -d "$(date +%F) $HORARIO" +%s)
    [ "$alvo" -gt "$(date +%s)" ] || alvo=$((alvo + 86400))
    log "próximo backup: $(date -d "@$alvo" '+%Y-%m-%d %H:%M %Z')"
    while restante=$((alvo - $(date +%s))) && [ "$restante" -gt 0 ]; do
      batimento
      sleep "$((restante < 60 ? restante : 60))" &
      wait $! || true
    done
    # Outro processo (o mesmo `genesis-backup agora` do manual): a trava (fd 8) é solta no fim, e o `set -e` vale
    # dentro do backup (numa função ou subshell chamada com `||` ou `if`, o bash desliga o `set -e` no corpo todo).
    "$0" agora || log "o backup das $HORARIO terminou com falha (código $?; detalhe nas linhas acima)"
  done
}

# --- Consulta e restauração ---------------------------------------------------------------------------------------

listar() {
  local dia=${1:-}
  if [ -z "$dia" ]; then
    local d dias r
    dias=$(listar_dias) || erro "bucket indisponível: a lista de dias de $PREFIXO/ não veio (detalhe acima)."
    for d in $dias; do
      r=0
      baixar_objeto "$PREFIXO/$d/manifesto.json" "$TRABALHO/m.json" || r=$?
      case "$r" in
        0) jq -r '"\(.dia)  \(.status)  \(.bancos | length) banco(s)  \(.tamanho_bytes) bytes  fim \(.fim)"' "$TRABALHO/m.json" ;;
        2) echo "$d  (sem manifesto: backup incompleto)" ;;
        *) echo "$d  (manifesto ilegível: $MOTIVO_BUCKET)" ;;
      esac
    done
    rm -f "$TRABALHO/m.json"
    return 0
  fi
  [[ $dia =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || erro "dia inválido: '$dia' (AAAA-MM-DD)."
  baixar "$PREFIXO/$dia/manifesto.json" "$TRABALHO/m.json" || erro "sem manifesto em $PREFIXO/$dia/."
  jq -r '.bancos[] | "\(.banco)  \(.tamanho_bytes) bytes  sha256 \(.sha256)"' "$TRABALHO/m.json"
  jq -r '.falhas[] | "FALHOU \(.banco): \(.erro)"' "$TRABALHO/m.json"
  rm -f "$TRABALHO/m.json"
}

existe_banco() { [ "$(sql postgres "select count(*) from pg_database where datname = :'nome'" -v "nome=$1")" = 1 ]; }

# filtrar_toc TOC DISPONIVEIS SAIDA PULADAS: copia a lista do `pg_restore -l` (TOC) sem as extensões que o servidor de
# destino não oferece (DISPONIVEIS: um nome de extensão por linha, do pg_available_extensions), sem o COMMENT delas e
# sem o SCHEMA de mesmo nome (o esquema que só existe para a extensão). Os nomes pulados vão para PULADAS. Caso real:
# o Cloud SQL cria a `google_vacuum_mgmt` (esquema e extensão de mesmo nome) em todo banco, o pg_dump a leva para o
# backup e o próprio Cloud SQL não deixa recriá-la ("Could not open extension control file"): sem o filtro, a
# restauração para no primeiro erro (--exit-on-error) e o backup não volta.
filtrar_toc() {
  : >"$4"
  awk -v puladas="$4" '
    FNR == NR { if ($0 != "") disponivel[$0] = 1; next }
    { linha[++n] = $0 }
    match($0, / EXTENSION - [^ ]+/) {
      nome = substr($0, RSTART + 13, RLENGTH - 13)
      if (!(nome in disponivel)) pular[nome] = 1
    }
    END {
      for (i = 1; i <= n; i++) {
        l = linha[i]; nome = ""
        if (l !~ /^[ \t]*;/) {
          if (match(l, / EXTENSION - [^ ]+/)) nome = substr(l, RSTART + 13, RLENGTH - 13)
          else if (match(l, / COMMENT - EXTENSION [^ ]+/)) nome = substr(l, RSTART + 21, RLENGTH - 21)
          else if (match(l, / SCHEMA - [^ ]+/)) nome = substr(l, RSTART + 10, RLENGTH - 10)
          else if (match(l, / COMMENT - SCHEMA [^ ]+/)) nome = substr(l, RSTART + 18, RLENGTH - 18)
        }
        if (nome != "" && (nome in pular)) continue
        print l
      }
      for (p in pular) print p > puladas
    }' "$2" "$1" >"$3"
}

# Restaura um arquivo do dia num banco NOVO (nunca por cima de um existente). O CREATE DATABASE sai do próprio dump
# (codificação, provedor e locale ICU do original); `--no-owner --no-acl`: o dono é o usuário do DATABASE_URL e os
# privilégios da role de runtime da empresa voltam com `implantar.sh tarefa migrar-empresas`.
restaurar_banco() { # arquivo banco_original banco_destino
  local arquivo=$1 original=$2 destino=$3 esquema=$TRABALHO/esquema.sql criar ajustes
  [[ $destino =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || erro "nome de banco inválido: '$destino'."
  if existe_banco "$destino"; then
    erro "o banco $destino já existe no servidor: a restauração nunca escreve por cima. Restaure com --como <outro_nome>, ou apague o banco antes (README › Backup › Restaurar)."
  fi
  # Cada passo com `|| return 1`: a função é chamada com `||` (o `set -e` não vale aqui dentro).
  pg_restore --create --schema-only -f "$esquema" "$arquivo" || return 1
  criar=$(grep -m 1 '^CREATE DATABASE ' "$esquema") || erro "o dump de $original não tem o CREATE DATABASE."
  ajustes=$(grep '^ALTER DATABASE .* SET ' "$esquema" || true)
  rm -f "$esquema"
  criar=${criar/#"CREATE DATABASE $original "/"CREATE DATABASE $destino "}
  ajustes=${ajustes//"ALTER DATABASE $original "/"ALTER DATABASE $destino "}
  sql postgres "$criar" || return 1
  [ -z "$ajustes" ] || sql "$destino" "$ajustes" || return 1
  # Só o que o servidor de destino consegue criar: as extensões do provedor que ele não oferece saem da lista
  # (filtrar_toc; ex.: google_vacuum_mgmt do Cloud SQL), com aviso. O resto restaura com --exit-on-error.
  local toc=$TRABALHO/restaurar.toc disponiveis=$TRABALHO/restaurar.extensoes lista=$TRABALHO/restaurar.lista
  local puladas=$TRABALHO/restaurar.puladas
  pg_restore -l "$arquivo" >"$toc" || return 1
  sql "$destino" "select name from pg_available_extensions order by 1" >"$disponiveis" || return 1
  filtrar_toc "$toc" "$disponiveis" "$lista" "$puladas" || return 1
  if [ -s "$puladas" ]; then
    log "ATENÇÃO: extensão(ões) do servidor de origem que o destino não oferece, fora da restauração: $(sort "$puladas" | tr '\n' ' ')"
  fi
  rm -f "$toc" "$disponiveis" "$puladas"
  pg_restore --no-owner --no-acl --exit-on-error --no-password -L "$lista" -d "$(conexao "$destino")" "$arquivo" || {
    rm -f "$lista"
    return 1
  }
  rm -f "$lista"
}

restaurar() {
  [ $# -ge 2 ] || erro "uso: genesis-backup restaurar AAAA-MM-DD <banco|todos> [--como <nome_novo>]"
  local dia=$1 alvo=$2 como=''
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --como)
        como=${2:-}
        shift 2 || erro "--como precisa de um nome."
        ;;
      *) erro "argumento desconhecido: $1" ;;
    esac
  done
  [[ $dia =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [ -n "$alvo" ] ||
    erro "uso: genesis-backup restaurar AAAA-MM-DD <banco|todos> [--como <nome_novo>]"
  [ "$alvo" != todos ] || [ -z "$como" ] || erro "--como só com um banco."
  exec 8>"$TRAVA"
  flock -n 8 || erro "outro backup (ou restauração) em andamento neste container."
  mkdir -p "$TRABALHO"
  local manifesto=$TRABALHO/manifesto-restaurar.json bancos banco arquivo sha esperado
  baixar "$PREFIXO/$dia/manifesto.json" "$manifesto" || erro "sem manifesto em $PREFIXO/$dia/ (genesis-backup listar)."
  if [ "$alvo" = todos ]; then
    bancos=$(jq -r '.bancos[].banco' "$manifesto")
  else
    jq -e --arg b "$alvo" '.bancos[] | select(.banco == $b)' "$manifesto" >/dev/null ||
      erro "o backup de $dia não tem o banco $alvo (genesis-backup listar $dia)."
    bancos=$alvo
  fi
  [ "$(jq length <<<"$(jq '.falhas' "$manifesto")")" -eq 0 ] ||
    log "ATENÇÃO: o backup de $dia teve falhas: $(jq -r '.falhas | map(.banco) | join(", ")' "$manifesto")"
  for banco in $bancos; do
    arquivo=$TRABALHO/restaurar-$banco.dump
    esperado=$(jq -r --arg b "$banco" '.bancos[] | select(.banco == $b) | .sha256' "$manifesto")
    log "baixando $PREFIXO/$dia/$banco.dump"
    baixar "$PREFIXO/$dia/$banco.dump" "$arquivo"
    sha=$(sha256sum "$arquivo" | cut -d' ' -f1)
    if [ "$sha" != "$esperado" ]; then
      rm -f "$arquivo"
      erro "sha256 de $banco não confere com o manifesto (arquivo corrompido?)."
    fi
    log "restaurando $banco em ${como:-$banco} (servidor $PG_HOST:$PG_PORTA)"
    restaurar_banco "$arquivo" "$banco" "${como:-$banco}" || {
      rm -f "$arquivo"
      erro "restauração de $banco falhou."
    }
    rm -f "$arquivo"
    log "ok ${como:-$banco}"
  done
  rm -f "$manifesto"
  log "restauração concluída. Próximo passo: implantar.sh tarefa migrar-empresas (recria a role de runtime de cada empresa e os privilégios; README › Backup › Restaurar)."
}

# Resumo do backups/estado.json. "Nenhum backup registrado" só quando o objeto não existe (NoSuchKey); bucket sem
# acesso (chave HMAC sem permissão, rede, 5xx) é erro, com o motivo, e sai com código 1.
estado() {
  local arquivo=$TRABALHO/estado-consulta.json r=0
  mkdir -p "$TRABALHO"
  baixar_objeto "$PREFIXO/estado.json" "$arquivo" || r=$?
  case "$r" in
    0) ;;
    2)
      echo "nenhum backup registrado ainda ($PREFIXO/estado.json não existe no bucket)"
      return 0
      ;;
    *)
      echo "bucket indisponível: $MOTIVO_BUCKET (não deu para ler $PREFIXO/estado.json; os backups guardados não foram tocados)" >&2
      return 1
      ;;
  esac
  jq -r '"último backup: \(.status) em \(.fim) (dia \(.dia)), \(.bancos) banco(s), \(.tamanho_bytes) bytes" +
    (if .erro then "\n  falhas: \(.erro)" else "" end) +
    "\núltimo sucesso: " + (if .ultimo_sucesso then "\(.ultimo_sucesso.fim) (\(.ultimo_sucesso.tamanho_bytes) bytes)" else "nenhum" end)' \
    "$arquivo"
  rm -f "$arquivo"
}

# Saudável = o agendador está vivo. Um backup que falhou NÃO deixa o container unhealthy: o `up --wait` da implantação
# e da restauração travaria por causa de um backup antigo; a falha aparece no `estado`, no log e no painel.
saude() {
  [ -f "$BATIMENTO" ] || exit 1
  local idade=$(($(date +%s) - $(stat -c %Y "$BATIMENTO")))
  # Durante um backup o batimento vem a cada banco; um único pg_dump pode levar alguns minutos.
  [ "$idade" -lt 1800 ] || exit 1
}

# Carregado com `source` (testes: backup/testar-genesis-backup.sh): só as funções.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

acao=${1:-agendar}
shift || true
case "$acao" in
  saude) saude ;;
  agendar | agora | estado | listar | restaurar | psql)
    exigir_variaveis
    preparar_banco
    preparar_bucket
    case "$acao" in
      agendar) agendar ;;
      agora) executar_backup ;;
      estado) estado ;;
      listar) listar "$@" ;;
      restaurar) restaurar "$@" ;;
      psql)
        [ $# -ge 1 ] || erro "uso: genesis-backup psql <banco> [argumentos do psql...]"
        banco=$1
        shift
        exec psql --no-psqlrc -X -d "$(conexao "$banco")" "$@"
        ;;
    esac
    ;;
  *)
    sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
