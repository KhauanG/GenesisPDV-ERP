#!/usr/bin/env bash
# Genesis: implantação, volta atrás, tarefas, backup, token de monitoramento e página de download do PDV na VPS
# (Implantação do piloto, I1 e I1b; README desta pasta).
#
#   implantar.sh implantar <versao>   # migra e sobe a versão (imagens genesis-api, genesis-web e genesis-backup
#                                     # :<versao> já carregadas; arquivos em /opt/genesis/releases/<versao>)
#   implantar.sh voltar               # volta para a versão anterior (sem desfazer migrações)
#   implantar.sh estado               # versões, containers e saúde
#   implantar.sh tarefa <comando> [argumentos...]
#                                     # comando da API na imagem atual: admin-criar, empresa-criar, migrar-controle,
#                                     # migrar-empresas, empresa-provisionamento, particoes, referencias
#   implantar.sh backup <agora|estado|listar|restaurar|psql> [argumentos...]
#                                     # o genesis-backup do container em execução (README › Backup)
#   implantar.sh token-monitor [--arquivo <caminho>]
#                                     # gera (ou troca) o token do /api/saude/detalhada (README › Monitoramento)
#   implantar.sh pdv <atual|publicar <versao> <publicado_em>|retirar>
#                                     # instalador do PDV da página de download: o sha256 do publicado, publica o
#                                     # que chega em tar na entrada, ou tira todos (a página volta a dizer "ainda não
#                                     # foi publicado") (README › Página de download do PDV)
#   implantar.sh logs [guardar]       # logs da API guardados antes de cada troca do container (e os reinícios do
#                                     # atual); `guardar` guarda agora (README › A API reiniciou sozinha)
#
# Ordem do `implantar`: proxy do banco no ar → migração do controle → migração das empresas (canário, depois lotes)
# → nova API, novo ERP e novo backup (`up --wait`, healthchecks). As migrações seguem o padrão expandir/contrair: a
# API anterior continua funcionando com o schema novo, então uma falha antes da troca deixa a versão anterior no ar,
# e uma falha depois da troca volta sozinha para ela.
# Antes de recriar o genesis-api (implantar, voltar, volta automática, token-monitor), o log dele vai para $PASTA/logs
# (as últimas linhas e, se o Docker o reiniciou, o trecho em volta do último reinício): o `docker logs` some com o
# container (a causa do reinício de 04/11/2026 se perdeu assim).
# Variáveis (teste local da stack): GENESIS_PASTA (padrão /opt/genesis), GENESIS_COMPOSE_EXTRA (override do Compose),
# GENESIS_ESPERA_SEGUNDOS (padrão 240).
set -euo pipefail

PASTA=${GENESIS_PASTA:-/opt/genesis}
VERSOES=$PASTA/versoes
ESPERA=${GENESIS_ESPERA_SEGUNDOS:-240}
MANTER_RELEASES=5
# Página de download do PDV: download/pdv é montada só leitura no genesis-web (docker-compose.yml); os temporários
# ficam em download/.recebendo.* (fora da montagem, no mesmo disco: a troca é um rename).
DOWNLOAD=$PASTA/download
DOWNLOAD_PDV=$DOWNLOAD/pdv
GID_NGINX=101
# Logs da API guardados (guardar_logs_api): as últimas LOGS_LINHAS linhas por arquivo e, se o Docker reiniciou o
# container (RestartCount > 0), também o trecho de LOGS_QUEDA_ANTES_MIN minutos antes a LOGS_QUEDA_DEPOIS_MIN minutos
# depois do último reinício (até LOGS_LINHAS linhas); no máximo LOGS_MANTER arquivos e nenhum com mais de LOGS_DIAS dias.
LOGS=$PASTA/logs
LOGS_LINHAS=5000
LOGS_QUEDA_ANTES_MIN=30
LOGS_QUEDA_DEPOIS_MIN=2
LOGS_MANTER=20
LOGS_DIAS=30

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32mOK:\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33mATENÇÃO: %s\033[0m\n' "$*" >&2; }
erro() {
  printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2
  exit 1
}

ler_versao() { [ -s "$VERSOES/$1" ] && cat "$VERSOES/$1" || true; }

# docker compose da versão $1 (o docker-compose.yml da própria release; projeto e .env em $PASTA).
compose() {
  local versao=$1
  shift
  local arquivos=(-f "$PASTA/releases/$versao/docker-compose.yml")
  [ -n "${GENESIS_COMPOSE_EXTRA:-}" ] && arquivos+=(-f "$GENESIS_COMPOSE_EXTRA")
  GENESIS_VERSAO=$versao docker compose --project-directory "$PASTA" "${arquivos[@]}" "$@"
}

# Imagens de uma versão: as releases anteriores ao I1b não têm o genesis-backup (voltar para uma delas tira o backup
# do ar até a próxima implantação; README › Backup).
imagens_da_versao() {
  echo genesis-api genesis-web
  grep -q 'image: genesis-backup:' "$PASTA/releases/$1/docker-compose.yml" && echo genesis-backup || true
}

servicos_da_versao() {
  echo genesis-cloudsql-proxy genesis-api genesis-web
  grep -q 'image: genesis-backup:' "$PASTA/releases/$1/docker-compose.yml" && echo genesis-backup || true
}

conferir_versao() {
  local versao=$1
  [[ $versao =~ ^[A-Za-z0-9._-]{1,64}$ ]] || erro "versão inválida: '$versao'."
  [ -f "$PASTA/releases/$versao/docker-compose.yml" ] ||
    erro "faltam os arquivos da versão $versao em $PASTA/releases/$versao (o workflow envia; à mão: README › Implantar sem o GitHub)."
  local img
  for img in $(imagens_da_versao "$versao"); do
    docker image inspect "$img:$versao" >/dev/null 2>&1 || erro "imagem $img:$versao não carregada (docker load)."
  done
}

# Grava a versão em produção: versoes/atual, versoes/anterior, o GENESIS_VERSAO do .env (para o `docker compose`
# manual em /opt/genesis) e os links docker-compose.yml e implantar.sh → release atual.
registrar() {
  local nova=$1 anterior=$2
  mkdir -p "$VERSOES"
  [ -n "$anterior" ] && [ "$anterior" != "$nova" ] && echo "$anterior" >"$VERSOES/anterior"
  echo "$nova" >"$VERSOES/atual"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $nova" >>"$VERSOES/historico"
  if grep -q '^GENESIS_VERSAO=' "$PASTA/.env"; then
    sed -i "s|^GENESIS_VERSAO=.*|GENESIS_VERSAO=$nova|" "$PASTA/.env"
  else
    echo "GENESIS_VERSAO=$nova" >>"$PASTA/.env"
  fi
  ln -sfn "releases/$nova/docker-compose.yml" "$PASTA/docker-compose.yml"
  ln -sfn "releases/$nova/implantar.sh" "$PASTA/implantar.sh"
}

# Sobe proxy, API, ERP e backup da versão e espera os healthchecks.
subir() {
  local versao=$1
  # shellcheck disable=SC2046 # lista de serviços de uma palavra cada
  compose "$versao" up -d --wait --wait-timeout "$ESPERA" --remove-orphans $(servicos_da_versao "$versao")
}

# Guarda o log do genesis-api em execução, com data e hora de cada linha (stdout e stderr: o "JavaScript heap out of
# memory" do V8 sai no stderr), em logs/api-<AAAAMMDDTHHMMSSZ>-<versão do container>.log, antes de o container ser
# recriado ($1: o motivo, na primeira linha do arquivo). As últimas LOGS_LINHAS linhas são só as horas antes da troca
# (o pino-http escreve uma linha por requisição, e o healthcheck sozinho dá ~5.760 por dia): quando o Docker já
# reiniciou o container (RestartCount > 0), vai antes delas o trecho em volta do último reinício (o StartedAt é a
# subida do processo novo, logo depois da queda), que guarda a queda mesmo com a troca horas ou dias depois. Sem o
# container, não faz nada; uma falha só avisa (não impede a troca de versão).
guardar_logs_api() {
  local motivo=$1 versao arquivo estado reinicios iniciado inicio desde='' ate=''
  docker inspect genesis-api >/dev/null 2>&1 || return 0
  versao=$(docker inspect -f '{{.Config.Image}}' genesis-api 2>/dev/null || true)
  versao=${versao#genesis-api:}
  [[ $versao =~ ^[A-Za-z0-9._-]{1,64}$ ]] || versao=desconhecida
  estado=$(docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' genesis-api 2>/dev/null || true)
  reinicios=${estado%% *}
  iniciado=${estado#* }
  [[ $reinicios =~ ^[0-9]+$ ]] || reinicios='?'
  [[ $iniciado =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || iniciado='?'
  if [[ $reinicios =~ ^[1-9][0-9]*$ ]] && [ "$iniciado" != '?' ] && inicio=$(date -u -d "$iniciado" +%s 2>/dev/null); then
    desde=$(date -u -d "@$((inicio - LOGS_QUEDA_ANTES_MIN * 60))" +%Y-%m-%dT%H:%M:%SZ)
    ate=$(date -u -d "@$((inicio + LOGS_QUEDA_DEPOIS_MIN * 60))" +%Y-%m-%dT%H:%M:%SZ)
  fi
  arquivo=$LOGS/api-$(date -u +%Y%m%dT%H%M%SZ)-$versao.log
  # Os logs trazem ids e IPs das requisições: pasta 700 e arquivos 600, como os segredos.
  if (
    umask 077
    mkdir -p "$LOGS"
    chmod 700 "$LOGS"
    {
      echo "# genesis-api $versao (no ar desde $iniciado, reinícios=$reinicios); guardado em $(date -u +%Y-%m-%dT%H:%M:%SZ) antes de: $motivo"
      # Só o último reinício (o Docker não guarda o StartedAt dos anteriores); o json-file (10 MB × 5) tem de ainda
      # ter as linhas. Num pico de log, as LOGS_LINHAS do fim do trecho (a queda e a volta).
      if [ -n "$desde" ]; then
        echo "# --- em volta do último reinício pelo Docker: de $desde a $ate (até $LOGS_LINHAS linhas) ---"
        docker logs --timestamps --since "$desde" --until "$ate" genesis-api 2>&1 | tail -n "$LOGS_LINHAS"
        echo "# --- as últimas $LOGS_LINHAS linhas ---"
      fi
      docker logs --timestamps --tail "$LOGS_LINHAS" genesis-api 2>&1
    } >"$arquivo"
  ); then
    ok "log da API ($versao) guardado em $arquivo"
  else
    aviso "não foi possível guardar o log da API em $arquivo; seguindo sem ele."
  fi
  limpar_logs
}

# Retenção dos logs guardados: apaga os com mais de LOGS_DIAS dias e, dos que sobram, os mais antigos além de
# LOGS_MANTER (o nome começa pela data UTC: a ordem do glob é a cronológica).
limpar_logs() {
  [ -d "$LOGS" ] || return 0
  find "$LOGS" -maxdepth 1 -type f -name 'api-*.log' -mtime +"$LOGS_DIAS" -delete 2>/dev/null || true
  local arquivos=("$LOGS"/api-*.log) excesso
  [ -e "${arquivos[0]}" ] || return 0
  excesso=$((${#arquivos[@]} - LOGS_MANTER))
  if [ "$excesso" -gt 0 ]; then
    rm -f -- "${arquivos[@]:0:excesso}"
  fi
}

# `implantar.sh logs`: o container atual (desde quando está no ar e quantas vezes o Docker o reiniciou) e os logs
# guardados; `logs guardar` guarda agora (ex.: antes de um `docker compose up -d` à mão, que também recria a API).
logs() {
  case "${1:-}" in
    '') ;;
    guardar)
      guardar_logs_api "implantar.sh logs guardar"
      return 0
      ;;
    *) erro "uso: implantar.sh logs [guardar]" ;;
  esac
  local estado f n=0
  estado=$(docker inspect -f '{{.Config.Image}}, no ar desde {{.State.StartedAt}}, reinícios={{.RestartCount}}' genesis-api 2>/dev/null || true)
  echo "Container genesis-api: ${estado:-não existe}"
  echo "  (reinícios > 0 = o processo caiu e o Docker subiu de novo; o log do container atual: docker logs genesis-api --since 1h)"
  echo
  echo "Logs guardados em $LOGS (antes de cada troca do container; os $LOGS_MANTER últimos, até $LOGS_DIAS dias), do mais antigo ao mais recente:"
  for f in "$LOGS"/api-*.log; do
    [ -e "$f" ] || continue
    printf '  %6s  %s\n' "$(du -h "$f" | cut -f1)" "${f##*/}"
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || echo "  (nenhum ainda)"
  echo
  echo "Ler: less $LOGS/<arquivo>"
  echo "A queda: grep -n -E '\"level\":(50|60)|heap out of memory|FATAL ERROR|sinal SIG' $LOGS/<arquivo> | tail -n 40"
}

# Apaga imagens e releases que não são a atual nem a anterior (as releases guardam as últimas $MANTER_RELEASES).
limpar() {
  local atual anterior
  atual=$(ler_versao atual)
  anterior=$(ler_versao anterior)
  for img in genesis-api genesis-web genesis-backup; do
    docker image ls "$img" --format '{{.Tag}}' | while read -r tag; do
      [ "$tag" = "$atual" ] || [ "$tag" = "$anterior" ] || [ "$tag" = '<none>' ] || docker image rm "$img:$tag" >/dev/null || true
    done
  done
  # Nomes de versão são gerados pelo workflow (sem espaço nem quebra de linha): `ls -t` basta para ordenar.
  # shellcheck disable=SC2012
  ls -1t "$PASTA/releases" 2>/dev/null | tail -n +$((MANTER_RELEASES + 1)) | while read -r rel; do
    [ "$rel" = "$atual" ] || [ "$rel" = "$anterior" ] || rm -rf "${PASTA:?}/releases/$rel"
  done
  docker image prune -f >/dev/null || true
}

implantar() {
  local nova=${1:-}
  [ -n "$nova" ] || erro "uso: implantar.sh implantar <versao>"
  conferir_versao "$nova"
  local atual
  atual=$(ler_versao atual)
  # As instruções das mensagens apontam o script da release nova: o link $PASTA/implantar.sh só muda no `registrar`
  # (até lá é o da versão anterior, que pode não ter o `logs`, e na primeira instalação nem existe).
  local script=$PASTA/releases/$nova/implantar.sh
  passo "Implantando $nova (em produção: ${atual:-nenhuma})"

  passo "1/4 Proxy do Cloud SQL"
  compose "$nova" up -d --wait --wait-timeout "$ESPERA" genesis-cloudsql-proxy ||
    erro "o proxy do Cloud SQL não ficou saudável em ${ESPERA}s (nada foi migrado nem trocado). Confira na VPS com bash $script estado."
  ok "proxy no ar"

  passo "2/4 Migração do banco de controle"
  compose "$nova" run --rm -T genesis-tarefa node dist/cli/migrar-controle.js ||
    erro "migração do controle falhou; a versão ${atual:-anterior} continua no ar."

  passo "3/4 Migração dos bancos das empresas (canário, depois lotes)"
  compose "$nova" run --rm -T genesis-tarefa node dist/cli/migrar-empresas.js ||
    erro "migração de empresa falhou (as com falha ficam em manutenção 503 até a próxima execução); a versão ${atual:-anterior} continua no ar. Veja: implantar.sh tarefa migrar-empresas"

  passo "4/4 API, ERP e backup"
  guardar_logs_api "implantar $nova"
  # Quem chama é o GitHub Actions, cujo log é público (repositório público, D60): nada de log da API, lista de
  # containers ou uso de memória na saída. O log da API que não subiu fica guardado na VPS (logs/, 700/600) e o
  # estado se vê lá (o `logs` e o `estado` do $script).
  if ! subir "$nova"; then
    if [ -n "$atual" ] && [ "$atual" != "$nova" ]; then
      aviso "a versão $nova não ficou saudável em ${ESPERA}s; voltando para $atual."
      guardar_logs_api "volta automática de $nova para $atual (a $nova não ficou saudável)"
      subir "$atual" || aviso "a versão $atual também não subiu: confira na VPS com bash $script estado."
    else
      guardar_logs_api "implantação de $nova que não ficou saudável em ${ESPERA}s"
    fi
    erro "implantação de $nova falhou (não ficou saudável em ${ESPERA}s). O log da API ficou guardado na VPS, em $LOGS: no terminal dela, bash $script logs (lista os arquivos e como ler) e bash $script estado."
  fi
  registrar "$nova" "$atual"
  limpar
  ok "versão $nova no ar (anterior: ${atual:-nenhuma}). Containers, memória e backup: $PASTA/implantar.sh estado, na VPS."
}

voltar() {
  local atual anterior
  atual=$(ler_versao atual)
  anterior=$(ler_versao anterior)
  [ -n "$anterior" ] || erro "não há versão anterior registrada em $VERSOES/anterior."
  conferir_versao "$anterior"
  passo "Voltando de ${atual:-?} para $anterior (as migrações não são desfeitas: expandir/contrair)"
  guardar_logs_api "voltar de ${atual:-?} para $anterior"
  subir "$anterior" || erro "a versão $anterior não ficou saudável; confira com implantar.sh estado."
  registrar "$anterior" "$atual"
  ok "versão $anterior no ar (a $atual fica como anterior: implantar.sh voltar troca de novo)"
  estado_curto
}

estado_curto() {
  local atual
  atual=$(ler_versao atual)
  [ -n "$atual" ] || return 0
  compose "$atual" ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \
    genesis-api genesis-web genesis-cloudsql-proxy genesis-backup 2>/dev/null || true
}

estado() {
  echo "Em produção: $(ler_versao atual)"
  echo "Anterior:    $(ler_versao anterior)"
  local atual chave=$PASTA/segredos/gcp-conta-servico.json
  atual=$(ler_versao atual)
  # Colar de novo o bloco do Cloud Shell recria a chave como root:root 600: o proxy (65532) segue com a cópia que
  # já abriu e só falha na próxima reinicialização (README › Passo 1).
  if [ -f "$chave" ] && [ "$(stat -c %a:%g "$chave")" != 640:65532 ]; then
    aviso "$chave está $(stat -c '%U:%G %a' "$chave"): o proxy do banco (uid 65532) não consegue ler e não sobe na próxima reinicialização. Corrija: bash $PASTA/releases/${atual:-<versão>}/instalar.sh && docker restart genesis-cloudsql-proxy"
  fi
  estado_curto
  [ -n "$atual" ] || return 0
  echo
  echo "Backup (genesis-backup):"
  if docker inspect genesis-backup >/dev/null 2>&1; then
    docker exec genesis-backup genesis-backup estado 2>&1 | sed 's/^/  /' || true
  else
    aviso "o container genesis-backup não existe: sem backup diário (README › Backup)."
  fi
  local instalador
  instalador=$(campo_pdv arquivo)
  echo "Página de download: ${instalador:-sem instalador do PDV publicado} (README › Página de download do PDV)"
  grep -q '^MONITOR_TOKEN_SHA256=.' "$PASTA/segredos/genesis-app.env" 2>/dev/null ||
    echo "Monitoramento: sem token (o /api/saude/detalhada responde 401); gere com: $PASTA/implantar.sh token-monitor"
  echo
  echo "Saúde da API (de dentro do container):"
  docker exec genesis-api node -e \
    "fetch('http://127.0.0.1:3000/saude').then(async r=>{console.log(r.status, await r.text());process.exit(r.ok?0:1)},e=>{console.log(String(e));process.exit(1)})"
}

tarefa() {
  local comando=${1:-}
  [ -n "$comando" ] || erro "uso: implantar.sh tarefa <comando> [argumentos...]"
  shift
  [[ $comando =~ ^[a-z-]+$ ]] || erro "comando inválido: '$comando'."
  local atual
  atual=$(ler_versao atual)
  [ -n "$atual" ] || erro "nenhuma versão implantada ainda."
  # Sem -T quando há terminal (o admin-criar pode ler a senha da entrada padrão com --senha-stdin).
  local tty=-T
  [ -t 0 ] && [ -t 1 ] && tty=
  compose "$atual" run --rm $tty genesis-tarefa node "dist/cli/$comando.js" "$@"
}

# Backup no container em execução (docker exec: o mesmo limite de 64 MB e a mesma trava do agendado).
backup() {
  local sub=${1:-}
  case "$sub" in
    agora | estado | listar | restaurar | psql) ;;
    *) erro "uso: implantar.sh backup <agora|estado|listar|restaurar|psql> [argumentos...] (README › Backup)" ;;
  esac
  docker inspect genesis-backup >/dev/null 2>&1 || erro "o container genesis-backup não está no ar (implantar.sh estado)."
  local tty=()
  [ -t 0 ] && [ -t 1 ] && tty=(-it)
  docker exec "${tty[@]}" genesis-backup genesis-backup "$@"
}

# Token de monitoramento do /api/saude/detalhada (I1b): 32 bytes aleatórios; só o SHA-256 vai para
# segredos/genesis-app.env (MONITOR_TOKEN_SHA256). O token aparece UMA vez, no terminal (ou num arquivo NOVO, criado
# com 600, com --arquivo); rodar de novo troca o token (o anterior para de valer quando a API é recriada, logo em
# seguida).
token_monitor() {
  local destino=''
  if [ "${1:-}" = --arquivo ]; then
    destino=${2:-}
    [ -n "$destino" ] || erro "uso: implantar.sh token-monitor [--arquivo <caminho>]"
  elif [ -n "${1:-}" ]; then
    erro "uso: implantar.sh token-monitor [--arquivo <caminho>]"
  fi
  [ -n "$destino" ] || [ -t 1 ] ||
    erro "rode num terminal (o token aparece uma vez na tela) ou use --arquivo <caminho>: nunca pelo workflow, que guarda o log."
  # O arquivo tem de ser novo: num arquivo que já existe o umask não muda a permissão (um 644 continuaria legível por
  # todos) e o `>` seguiria um link simbólico. Conferido antes de trocar o token (uma recusa não invalida o atual).
  if [ -n "$destino" ]; then
    if [ -e "$destino" ] || [ -L "$destino" ]; then
      erro "$destino já existe: o token só vai para um arquivo novo (apague o antigo ou escolha outro caminho; o token atual continua valendo)."
    fi
    [ -d "$(dirname "$destino")" ] || erro "a pasta de $destino não existe."
  fi
  local app=$PASTA/segredos/genesis-app.env atual token hash
  [ -s "$app" ] || erro "$app não existe (rode o instalar.sh antes)."
  atual=$(ler_versao atual)
  [ -n "$atual" ] || erro "nenhuma versão implantada ainda."
  token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
  # O arquivo antes do hash: se ele não puder ser criado, nada muda.
  if [ -n "$destino" ]; then
    (
      umask 077
      set -o noclobber
      printf '%s\n' "$token" >"$destino"
    ) || erro "não foi possível criar $destino (o token atual continua valendo)."
    [ "$(stat -c %a "$destino")" = 600 ] || {
      rm -f "$destino"
      erro "$destino não ficou com 600; apagado (o token atual continua valendo)."
    }
  fi
  (
    umask 077
    grep -v -e '^MONITOR_TOKEN_SHA256=' -e '^# Token de monitoramento do /api/saude/detalhada' "$app" >"$app.novo" || true
    {
      echo "# Token de monitoramento do /api/saude/detalhada (só o hash; implantar.sh token-monitor, $(date -u +%Y-%m-%dT%H:%M:%SZ))."
      echo "MONITOR_TOKEN_SHA256=$hash"
    } >>"$app.novo"
    mv "$app.novo" "$app"
    chmod 600 "$app"
  )
  passo "Recriando a API com o token novo"
  guardar_logs_api "token-monitor"
  compose "$atual" up -d --wait --wait-timeout "$ESPERA" genesis-api
  if [ -n "$destino" ]; then
    ok "token gravado em $destino (arquivo novo, 600). Passe ao monitor e apague o arquivo."
  else
    echo
    echo "Token de monitoramento (aparece só agora; guarde no monitor, nunca no repositório):"
    echo
    echo "  $token"
    echo
    echo "Uso: curl -H 'Authorization: Bearer <token>' https://<api>/api/saude/detalhada"
  fi
}

# Campo do download/pdv/atual.json (gravado por pdv_publicar, um campo por linha; sem depender de jq na VPS).
campo_pdv() {
  [ -f "$DOWNLOAD_PDV/atual.json" ] || return 0
  sed -n "s/^ *\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$DOWNLOAD_PDV/atual.json" | head -n 1
}

# sha256 do instalador publicado, só se o atual.json e o arquivo conferem (o workflow compara com o do último GitHub
# Release para não enviar de novo o mesmo instalador). Nada publicado, ou algo fora do lugar: não imprime nada.
pdv_atual() {
  local arquivo sha
  arquivo=$(campo_pdv arquivo)
  sha=$(campo_pdv sha256)
  [[ $arquivo =~ ^GenesisPDV-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe$ ]] && [[ $sha =~ ^[0-9a-f]{64}$ ]] || return 0
  [ -f "$DOWNLOAD_PDV/$arquivo" ] && [ -f "$DOWNLOAD_PDV/$arquivo.sha256" ] || return 0
  [ "$(sha256sum "$DOWNLOAD_PDV/$arquivo" | cut -d' ' -f1)" = "$sha" ] || return 0
  echo "$sha"
}

# Publica o instalador do PDV que chega em tar na entrada padrão (GenesisPDV-Setup-<versao>.exe e o .sha256 dele,
# do GitHub Release, já conferidos pelo workflow): extrai numa pasta temporária, confere de novo o sha256 (o envio
# pode ter cortado o arquivo), acerta as permissões e só então troca, por rename, o instalador, o .sha256 e, por
# último, o atual.json que a página lê. Guarda o instalador publicado antes deste, se for de versão menor (quem abriu a
# página antes da troca ainda baixa), e apaga os outros: voltar para uma versão menor (release com defeito tirado do
# GitHub) apaga o instalador retirado.
# X.Y.Z do nome GenesisPDV-Setup-X.Y.Z.exe (vazio se o nome não segue o padrão).
versao_do_instalador() {
  local nome=${1##*/}
  [[ $nome =~ ^GenesisPDV-Setup-([0-9]+\.[0-9]+\.[0-9]+)\.exe$ ]] && echo "${BASH_REMATCH[1]}" || true
}

# $1 é uma versão X.Y.Z menor que $2.
versao_menor() {
  [ -n "$1" ] && [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

PDV_TEMP=
pdv_publicar() {
  local versao=${1:-} publicado=${2:-}
  [[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "uso: implantar.sh pdv publicar <X.Y.Z> <AAAA-MM-DDTHH:MM:SSZ> < arquivos.tar"
  [[ $publicado =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    erro "data de publicação inválida: '$publicado' (AAAA-MM-DDTHH:MM:SSZ, a do GitHub Release)."
  [ -d "$DOWNLOAD_PDV" ] || erro "$DOWNLOAD_PDV não existe: rode o instalar.sh desta versão antes."
  local exe="GenesisPDV-Setup-$versao.exe" esperado nome calculado tamanho anterior f
  # Sobras de um envio interrompido (o trap não roda num kill -9).
  find "$DOWNLOAD" -maxdepth 1 -name '.recebendo.*' -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  PDV_TEMP=$(mktemp -d "$DOWNLOAD/.recebendo.XXXXXX")
  trap 'rm -rf "$PDV_TEMP"' EXIT
  # Só os dois nomes esperados saem do tar (nada de caminho com / ou ..).
  tar -xf - -C "$PDV_TEMP" --no-same-owner --no-same-permissions -- "$exe" "$exe.sha256" ||
    erro "envio incompleto: o tar não trouxe $exe e $exe.sha256 inteiros; nada mudou na página."
  esperado=$(awk 'NR == 1 { print tolower($1) }' "$PDV_TEMP/$exe.sha256")
  nome=$(awk 'NR == 1 { sub(/^\*/, "", $2); print $2 }' "$PDV_TEMP/$exe.sha256")
  [[ $esperado =~ ^[0-9a-f]{64}$ ]] && [ "$nome" = "$exe" ] &&
    [ "$(awk 'END { print NR }' "$PDV_TEMP/$exe.sha256")" = 1 ] ||
    erro "$exe.sha256 fora do formato do sha256sum (uma linha, '<hash>  $exe'); nada mudou na página."
  calculado=$(sha256sum "$PDV_TEMP/$exe" | cut -d' ' -f1)
  [ "$calculado" = "$esperado" ] ||
    erro "o sha256 de $exe recebido ($calculado) não confere com o do .sha256 ($esperado); nada mudou na página."
  tamanho=$(stat -c %s "$PDV_TEMP/$exe")
  [ "$tamanho" -gt 0 ] || erro "$exe recebido está vazio; nada mudou na página."
  # Um campo por linha (campo_pdv lê assim); os valores já passaram pelas expressões acima, sem nada a escapar.
  printf '{\n  "versao": "%s",\n  "arquivo": "%s",\n  "tamanho_bytes": %s,\n  "sha256": "%s",\n  "publicado_em": "%s"\n}\n' \
    "$versao" "$exe" "$tamanho" "$esperado" "$publicado" >"$PDV_TEMP/atual.json"
  chown root:"$GID_NGINX" "$PDV_TEMP/$exe" "$PDV_TEMP/$exe.sha256" "$PDV_TEMP/atual.json"
  chmod 640 "$PDV_TEMP/$exe" "$PDV_TEMP/$exe.sha256" "$PDV_TEMP/atual.json"
  # Data de modificação = a da publicação (o tar traz a do download no runner): a retenção abaixo ordena por ela.
  touch "$PDV_TEMP/$exe"
  mv -f "$PDV_TEMP/$exe" "$DOWNLOAD_PDV/$exe"
  mv -f "$PDV_TEMP/$exe.sha256" "$DOWNLOAD_PDV/$exe.sha256"
  mv -f "$PDV_TEMP/atual.json" "$DOWNLOAD_PDV/atual.json"
  # O publicado antes deste é o mais recente dos outros de versão menor (republicar a mesma versão não apaga o
  # anterior; um de versão maior foi retirado do GitHub e sai da pasta).
  anterior=
  for f in "$DOWNLOAD_PDV"/GenesisPDV-Setup-*.exe; do
    [ -e "$f" ] && [ "${f##*/}" != "$exe" ] || continue
    versao_menor "$(versao_do_instalador "$f")" "$versao" || continue
    if [ -z "$anterior" ] || [ "$f" -nt "$DOWNLOAD_PDV/$anterior" ]; then
      anterior=${f##*/}
    fi
  done
  for f in "$DOWNLOAD_PDV"/GenesisPDV-Setup-*.exe; do
    [ -e "$f" ] || continue
    [ "${f##*/}" = "$exe" ] || [ "${f##*/}" = "$anterior" ] || rm -f "$f" "$f.sha256"
  done
  ok "página de download com o PDV $versao ($exe, $tamanho bytes, sha256 $esperado)${anterior:+; anterior guardado: $anterior}"
}

# Tira o instalador da página (nenhum GitHub Release do PDV publicado sobrou: o workflow chama quando a lista vem
# vazia, sem erro). Primeiro o atual.json (um rm: a página passa direto a dizer "ainda não foi publicado"), depois os
# instaladores e os .sha256. Sem nada publicado, não faz nada.
pdv_retirar() {
  local f retirados=0
  [ -d "$DOWNLOAD_PDV" ] || { ok "página de download sem instalador do PDV (nada a retirar)"; return 0; }
  rm -f "$DOWNLOAD_PDV/atual.json"
  for f in "$DOWNLOAD_PDV"/GenesisPDV-Setup-*.exe "$DOWNLOAD_PDV"/GenesisPDV-Setup-*.exe.sha256; do
    [ -e "$f" ] || continue
    rm -f "$f"
    retirados=$((retirados + 1))
  done
  if [ "$retirados" -gt 0 ]; then
    ok "página de download sem instalador do PDV ($retirados arquivo(s) retirado(s)): ela diz que ainda não foi publicado"
  else
    ok "página de download sem instalador do PDV (nada a retirar)"
  fi
}

pdv() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    atual) pdv_atual ;;
    publicar) pdv_publicar "$@" ;;
    retirar) pdv_retirar ;;
    *) erro "uso: implantar.sh pdv <atual|publicar <versao> <publicado_em>|retirar> (README › Página de download do PDV)" ;;
  esac
}

# `logs` só lê (ou guarda um arquivo novo): não espera a trava, para dar para olhar durante uma implantação.
if [ "${1:-}" = logs ]; then
  shift
  logs "$@"
  exit 0
fi

# Uma implantação por vez.
mkdir -p "$PASTA"
exec 9>"$PASTA/.implantacao.lock"
flock -n 9 || erro "outra implantação está em andamento ($PASTA/.implantacao.lock)."

acao=${1:-}
shift || true
case "$acao" in
  implantar) implantar "$@" ;;
  voltar) voltar ;;
  estado) estado ;;
  tarefa) tarefa "$@" ;;
  backup) backup "$@" ;;
  token-monitor) token_monitor "$@" ;;
  pdv) pdv "$@" ;;
  *)
    sed -n '5,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
