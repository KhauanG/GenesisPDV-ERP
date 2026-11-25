#!/usr/bin/env bash
# Genesis: vigia da implantação na VPS (OP-B4 e OP-B7; D70 e D119; README desta pasta › Vigia da implantação). Uma
# rodada: lê a main e as tags do repositório público (só leitura, sem token) e, havendo o que fazer, chama o
# implantar-sem-actions.sh. O genesis-vigia.timer (systemd) roda uma rodada a cada 2 minutos; o instalar-vigia.sh
# instala, atualiza, desliga e mostra o estado.
#
#   bash /opt/genesis/vigia/vigia-implantacao.sh      # uma rodada (o que o genesis-vigia.service roda)
#
# O sentido é o contrário do SSH: a VPS busca no repositório público, ninguém de fora fala com ela. Só vai para a
# produção o que entrou na main, e escrever nela (o merge, a tag) exige permissão no repositório.
#
# O que a rodada faz, uma coisa por rodada, nesta ordem de prioridade:
#   1. pedido manual do dono (forçar ou voltar uma versão): uma tag do repositório público num commit da main,
#        implantar/<AAAAMMDD-HHMMSS>       implantar o commit (implantar-sem-actions.sh <commit>)
#        implantar-pdv/<AAAAMMDD-HHMMSS>   o mesmo, publicando o PDV do último release (--publicar-pdv)
#      Outro nome de tag não é pedido. A data e hora do nome (UTC) ordena: roda só o mais novo ainda não visto, e os
#      anteriores ficam como pulados. Na instalação, as tags que já existem ficam como vistas. Commit fora da main:
#      recusado, sem chamar nada; mais velho que o atual: permitido (é a volta). Roda na hora, fora da janela também.
#   2. a main (D119): a ponta da main que o vigia ainda não tratou é implantada (implantar-sem-actions.sh <ponta>),
#      uma vez por commit: implantada, falhou ou recusada, não roda de novo sozinha (o próximo merge, sim). Por isso o
#      vigia não desfaz uma volta do dono (implantar.sh voltar): a ponta já foi tratada. A ponta que já é a versão no
#      ar (versoes/atual) fica tratada sem implantar. Só fora da janela (abaixo); o commit de um pedido manual também
#      fica tratado.
#   3. o PDV (D119): quando a tag pdv-vX.Y.Z de versão mais alta (com o commit dela) muda, o
#      implantar-sem-actions.sh --so-pdv --tag=<tag> publica na página de download o release publicado mais novo, se o
#      sha256 for diferente do que a página serve, sem montar nem trocar a versão. Uma vez por tag: o release com
#      arquivo inválido (código 65) não é tentado de novo (o log e o estado.json dizem); o release da tag ainda não
#      publicado (a tag nasce antes dele) ou o GitHub sem responder (69) e as outras falhas (o Docker, o espaço, a URL
#      que não respondeu: 1) tentam de novo depois de PDV_ESPERA_SEGUNDOS, sem mexer no estado.json. Só fora da
#      janela.
#
# Janela: nada automático (2 e 3) começa entre as 17:00 e a meia-noite no horário de Brasília (D119). O arquivo
# $PASTA/vigia/janela (root 600; o instalar-vigia.sh o cria com o padrão) tem "<hora de início>-<hora do fim>", horas
# cheias de 0 a 24 (padrão 17-24; o fim antes do início passa pela meia-noite, ex.: 22-6) ou "nenhuma"; fora do
# formato vale o padrão, com uma linha no log. Uma implantação que já começou não é interrompida.
#
# Uma rodada, na ordem:
#   a. trava do vigia (uma rodada por vez; ocupada = sai sem fazer nada) e a retomada de uma implantação interrompida
#      (a VPS reiniciou no meio: fica como falhou; ainda rodando, espera);
#   b. `git ls-remote --heads --tags` do repositório público; sem resposta = tenta na próxima rodada;
#   c. o que fazer (1, 2 ou 3): estado "recebido" (o PDV não escreve "recebido": abaixo); com outra implantação em
#      andamento (a trava do implantar-sem-actions.sh ou a do implantar.sh) ou dentro da janela, fica para depois;
#   d. a main do repositório num clone parcial próprio ($PASTA/vigia/repo.git): commit fora dela = "recusado";
#   e. o implantar-sem-actions.sh da main de agora (a mesma regra do README: o script vem da main, não do commit) e a
#      chamada, fora do terminal como sempre; estado "em_andamento" e depois "ok" ou "falhou" (o código 75 do
#      implantar-sem-actions.sh, a trava pega no mesmo instante, volta a "recebido");
#   f. depois de um "ok" de uma implantação, o vigia se atualiza com o vigia-implantacao.sh do commit implantado, só
#      se mudou (sha256), por rename (a rodada em andamento continua lendo o arquivo antigo); falhar aqui não desfaz a
#      implantação.
#
# Estado: $PASTA/vigia (root 700): vistos (os pedidos manuais: o nome, o resultado e quando), main-tratados (os
# commits da main: o commit, o resultado e quando), pdv-tratados (a tag, o commit dela, o resultado e quando), janela,
# vigia.log (o que cada rodada fez; 1 MB no máximo), ultima-implantacao.log (a saída da última chamada do
# implantar-sem-actions.sh), a cópia do implantar-sem-actions.sh e o repo.git. A única saída pública é
# $PASTA/download/implantacao/estado.json (servido em https://<DOWNLOAD_DOMINIO>/implantacao/estado.json, por decisão
# do dono, D70) com só {pedido, commit (12), resultado, inicio, fim}: pedido é o nome da tag, "main" (o automático)
# ou "pdv" (a publicação só do PDV, com o commit da versão no ar; escrita só quando a página mudou ou o release tem
# arquivo inválido: um "nada a publicar" ou uma espera não apagam o resultado da última implantação); o nome da tag e
# o commit já são públicos no repositório; resultado é recebido, em_andamento, ok, falhou ou recusado; inicio é
# quando o vigia recebeu o pedido (no PDV, a primeira tentativa desta tag) e fim, quando terminou (null até lá). Nada de log, versão, estado da VPS ou mensagem de erro (isso
# fica no vigia.log).
#
# Variáveis: GENESIS_PASTA (padrão /opt/genesis). Só para os testes: GENESIS_REPOSITORIO (um repositório local no
# lugar do público, passado também ao implantar-sem-actions.sh) e GENESIS_GID_NGINX (padrão 101, o nginx do
# genesis-web).
set -euo pipefail
umask 077

REPOSITORIO_PUBLICO=KhauanG/GenesisPDV-ERP
REPOSITORIO=${GENESIS_REPOSITORIO:-https://github.com/$REPOSITORIO_PUBLICO}
PASTA=${GENESIS_PASTA:-/opt/genesis}
VIGIA=$PASTA/vigia
REPO=$VIGIA/repo.git
VISTOS=$VIGIA/vistos
MAIN_TRATADOS=$VIGIA/main-tratados
PDV_TRATADOS=$VIGIA/pdv-tratados
JANELA=$VIGIA/janela
LOG=$VIGIA/vigia.log
LOG_MAXIMO_BYTES=1048576
LOG_CHAMADA=$VIGIA/ultima-implantacao.log
EM_ANDAMENTO=$VIGIA/em-andamento
AGUARDANDO=$VIGIA/.aguardando
SEM_REDE=$VIGIA/.sem-rede
AVISO_JANELA=$VIGIA/.janela
AVISO_FORMATO_JANELA=$VIGIA/.janela-formato
# O PDV que vai tentar de novo (o 69 e as falhas passageiras): a hora (epoch) a partir da qual tenta, a tag, o sha256
# que a página servia na primeira tentativa (ou "-") e o inicio dela (o do estado.json, quando a página mudar).
PDV_ESPERA=$VIGIA/.pdv-espera
PDV_ESPERA_SEGUNDOS=900
PDV_AVISO=$VIGIA/.pdv-aviso
TRAVA=$VIGIA/.vigia.lock
# O vigia instalado (o que o genesis-vigia.service roda) e a cópia do implantar-sem-actions.sh que ele chama.
VIGIA_INSTALADO=$VIGIA/vigia-implantacao.sh
SEM_ACTIONS=$VIGIA/implantar-sem-actions.sh
PUBLICO=$PASTA/download/implantacao
ESTADO=$PUBLICO/estado.json
PAGINA_PDV=$PASTA/download/pdv/atual.json
GID_NGINX=${GENESIS_GID_NGINX:-101}
EXPR_PEDIDO='^(implantar|implantar-pdv)/[0-9]{8}-[0-9]{6}$'
EXPR_PDV='^pdv-v[0-9]+\.[0-9]+\.[0-9]+$'
JANELA_PADRAO=17-24
# Horário de Brasília. Sem o tzdata (o fuso não instalado), o mesmo deslocamento fixo: o Brasil não tem horário de
# verão desde 2019.
if [ -f /usr/share/zoneinfo/America/Sao_Paulo ]; then FUSO=America/Sao_Paulo; else FUSO='<-03>3'; fi

erro() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}
agora() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Uma linha no vigia.log (e no journal, pela saída padrão do serviço).
registrar() {
  printf '%s %s\n' "$(agora)" "$*" | tee -a "$LOG"
}
# Registra só se a mensagem mudou desde a última vez (a mesma espera a cada 2 minutos não enche o log).
registrar_uma_vez() {
  local marca=$1
  shift
  [ "$(cat "$marca" 2>/dev/null || true)" != "$*" ] || return 0
  printf '%s\n' "$*" >"$marca"
  registrar "$*"
}

# git sem credencial nenhuma (nem a de um credential helper do root, nem pergunta): o repositório é público.
git_publico() { GIT_TERMINAL_PROMPT=0 timeout 300 git -c credential.helper= "$@"; }
git_repo() { git_publico --git-dir="$REPO" "$@"; }

aparar_log() {
  [ -f "$LOG" ] || return 0
  [ "$(stat -c %s "$LOG")" -gt "$LOG_MAXIMO_BYTES" ] || return 0
  local temp
  temp=$(mktemp "$VIGIA/.vigia.log.XXXXXX")
  tail -n 2000 "$LOG" >"$temp"
  mv -f "$temp" "$LOG"
}

# --- estado.json (a única saída pública) --------------------------------------------------------------------------

# Campo do estado.json gravado por escrever_estado (um campo por linha; sem jq na VPS).
campo_estado() {
  [ -f "$ESTADO" ] || return 0
  sed -n "s/^  \"$1\": \"\([^\"]*\)\",\{0,1\}\$/\1/p" "$ESTADO" | head -n 1
}

# O estado.json é deste pedido e deste commit (o "main" é o mesmo pedido para commits diferentes).
estado_de() { [ "$(campo_estado pedido)" = "$1" ] && [ "$(campo_estado commit)" = "${2:0:12}" ]; }

# escrever_estado <pedido> <commit> <resultado> [fim] [inicio]: os valores já passaram pelas expressões do pedido, do
# commit e da data (nada a escapar). O inicio é o dado ou, sem ele, o da primeira vez que este pedido, com este
# commit, apareceu no estado.json (o "recebido"). O PDV dá o dele: o pedido "pdv" com a mesma versão no ar casa com
# a publicação de outro dia. Arquivo novo e rename no mesmo diretório: o nginx nunca lê um estado pela metade.
escrever_estado() {
  local pedido=$1 commit=${2:0:12} resultado=$3 fim=null inicio=${5:-} temp
  [ -z "${4:-}" ] || fim="\"$4\""
  if [ -z "$inicio" ]; then
    inicio=$(agora)
    if estado_de "$pedido" "$commit" && [ -n "$(campo_estado inicio)" ]; then inicio=$(campo_estado inicio); fi
  fi
  mkdir -p "$PUBLICO"
  chgrp "$GID_NGINX" "$PUBLICO"
  chmod 750 "$PUBLICO"
  temp=$(mktemp "$PUBLICO/.estado.XXXXXX")
  printf '{\n  "pedido": "%s",\n  "commit": "%s",\n  "resultado": "%s",\n  "inicio": "%s",\n  "fim": %s\n}\n' \
    "$pedido" "$commit" "$resultado" "$inicio" "$fim" >"$temp"
  chgrp "$GID_NGINX" "$temp"
  chmod 640 "$temp"
  mv -f "$temp" "$ESTADO"
}

# --- Listas do que já foi tratado ---------------------------------------------------------------------------------

visto() { [ -f "$VISTOS" ] && grep -q "^$1 " "$VISTOS"; }
marcar() { printf '%s %s %s\n' "$1" "$2" "$(agora)" >>"$VISTOS"; }
main_tratado() { [ -f "$MAIN_TRATADOS" ] && grep -q "^$1 " "$MAIN_TRATADOS"; }
# Um commit da main tratado (implantado, falhou, recusado, já no ar ou de um pedido manual): não roda de novo sozinho.
marcar_main() { main_tratado "$1" || printf '%s %s %s\n' "$1" "$2" "$(agora)" >>"$MAIN_TRATADOS"; }
pdv_tratado() { [ -f "$PDV_TRATADOS" ] && grep -q "^$1 $2 " "$PDV_TRATADOS"; }
marcar_pdv() { printf '%s %s %s %s\n' "$1" "$2" "$3" "$(agora)" >>"$PDV_TRATADOS"; }

# A versão no ar (o versoes/atual do implantar.sh: o commit em 12 caracteres), ou nada.
versao_no_ar() {
  local v
  v=$(cat "$PASTA/versoes/atual" 2>/dev/null || true)
  [[ $v =~ ^[0-9a-f]{12}$ ]] && echo "$v" || true
}

# O sha256 do instalador que a página de download serve (o atual.json do implantar.sh pdv publicar), ou nada.
pdv_na_pagina() {
  [ -f "$PAGINA_PDV" ] || return 0
  sed -n 's/^  "sha256": "\([0-9a-f]\{64\}\)",\{0,1\}$/\1/p' "$PAGINA_PDV" | head -n 1
}

# --- Janela -------------------------------------------------------------------------------------------------------

# A janela sem nada automático, "<início> <fim>" em horas cheias (ou "nenhuma"), do arquivo janela; fora do formato,
# o padrão, com uma linha no log (uma vez por conteúdo).
ler_janela() {
  local conteudo ini fim
  conteudo=$(head -c 64 "$JANELA" 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
  [ -n "$conteudo" ] || conteudo=$JANELA_PADRAO
  if [ "$conteudo" = nenhuma ]; then
    echo nenhuma
    return 0
  fi
  if [[ $conteudo =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]]; then
    ini=$((10#${BASH_REMATCH[1]}))
    fim=$((10#${BASH_REMATCH[2]}))
    if [ "$ini" -le 23 ] && [ "$fim" -le 24 ] && [ "$ini" != "$fim" ] && [ "$fim" -ge 1 ]; then
      echo "$ini $fim"
      return 0
    fi
  fi
  # Para o journal e o log, não para quem lê a janela (a saída padrão).
  registrar_uma_vez "$AVISO_FORMATO_JANELA" "janela fora do formato em $JANELA ('$conteudo'; o formato é <início>-<fim> em horas cheias de 0 a 24, ex.: 17-24, ou nenhuma): vale o padrão $JANELA_PADRAO" >&2
  echo "${JANELA_PADRAO%-*} ${JANELA_PADRAO#*-}"
}

# Volta 0 (e diz até quando, "HH:00") se agora, no horário de Brasília, está dentro da janela sem nada automático.
dentro_da_janela() {
  local janela ini fim hora
  janela=$(ler_janela)
  [ "$janela" != nenhuma ] || return 1
  read -r ini fim <<<"$janela"
  hora=$(TZ=$FUSO date +%H)
  [[ $hora =~ ^[0-9]{2}$ ]] || return 1
  hora=$((10#$hora))
  if [ "$ini" -lt "$fim" ]; then
    [ "$hora" -ge "$ini" ] && [ "$hora" -lt "$fim" ] || return 1
  else
    [ "$hora" -ge "$ini" ] || [ "$hora" -lt "$fim" ] || return 1
  fi
  printf '%02d:00\n' $((fim % 24))
}

# --- Rodada -------------------------------------------------------------------------------------------------------

# As travas do implantar-sem-actions.sh e do implantar.sh livres agora (abre, tenta e solta; o subshell fecha o
# descritor): com uma delas presa, há implantação em andamento (a do dono pelo terminal, ou outra).
travas_livres() {
  (exec 7>"$PASTA/.implantar-sem-actions.lock" && flock -n 7) &&
    (exec 7>"$PASTA/.implantacao.lock" && flock -n 7)
}

# Implantação que ficou em andamento numa rodada anterior: a VPS reiniciou ou o vigia parou no meio. Com a trava do
# implantar-sem-actions.sh presa, ela ainda roda (fora do vigia, que morreu): espera. Livre: o pedido (ou o commit da
# main) fica como falhou (não se sabe até onde foi; o implantar.sh estado e o log dizem), e a rodada segue. A
# publicação só do PDV interrompida tenta de novo (troca só arquivos da página, por rename, e não muda a versão).
retomar_interrompida() {
  [ -f "$EM_ANDAMENTO" ] || return 0
  local pedido commit
  read -r pedido commit _ <"$EM_ANDAMENTO" || true
  if ! { [[ $pedido =~ $EXPR_PEDIDO ]] || [[ $pedido =~ ^(main|pdv)$ ]]; } || ! [[ $commit =~ ^[0-9a-f]{12}([0-9a-f]{28})?$ ]]; then
    rm -f "$EM_ANDAMENTO"
    return 0
  fi
  if ! travas_livres; then
    registrar_uma_vez "$AGUARDANDO" "$pedido: a implantação que ficou em andamento ainda roda; espera ela terminar"
    return 1
  fi
  local no_ar
  no_ar=$(cat "$PASTA/versoes/atual" 2>/dev/null || true)
  rm -f "$EM_ANDAMENTO" "$AGUARDANDO"
  if [ "$pedido" = pdv ]; then
    registrar "pdv: a publicação do PDV foi interrompida (a VPS reiniciou ou o vigia parou no meio); tenta de novo"
    return 0
  fi
  [ "$pedido" = main ] || marcar "$pedido" falhou
  [ "${#commit}" != 40 ] || marcar_main "$commit" falhou
  escrever_estado "$pedido" "$commit" falhou "$(agora)"
  registrar "$pedido: falhou (interrompida: a VPS reiniciou ou o vigia parou no meio da implantação; no ar: ${no_ar:-nenhuma versão registrada}; confira com bash $PASTA/implantar.sh estado e a saída em $LOG_CHAMADA)"
}

# Clone parcial só da main, sem tags e sem os arquivos (blob:none): o histórico, para a ancestralidade; os arquivos
# (o implantar-sem-actions.sh, o vigia do commit) vêm sob demanda.
atualizar_repo() {
  if [ ! -d "$REPO" ]; then
    git_publico clone --quiet --bare --filter=blob:none --single-branch --branch main --no-tags "$REPOSITORIO" "$REPO" ||
      return 1
  fi
  git_repo remote set-url origin "$REPOSITORIO"
  git_repo fetch --quiet --prune --no-tags origin '+refs/heads/main:refs/heads/main'
}

# O commit está no histórico da main (um commit de outro branch, de PR ou que não existe: não).
na_main() {
  git_repo cat-file -e "$1^{commit}" 2>/dev/null && git_repo merge-base --is-ancestor "$1" refs/heads/main 2>/dev/null
}

# instalar_de <ref:caminho> <destino>: grava o arquivo do repositório no destino (700) só se mudou, por rename; volta
# 1 se o arquivo não existe na ref ou não é um script bash válido. Um script em execução não é reescrito no lugar (o
# bash o lê aos poucos): o rename troca o arquivo, e quem já o lia continua no antigo.
instalar_de() {
  local origem=$1 destino=$2 temp
  temp=$(mktemp "$VIGIA/.novo.XXXXXX")
  if ! git_repo show "$origem" >"$temp" 2>/dev/null || [ "$(head -c 19 "$temp")" != '#!/usr/bin/env bash' ] ||
    ! bash -n "$temp" 2>/dev/null; then
    rm -f "$temp"
    return 1
  fi
  if [ -f "$destino" ] && [ "$(sha256sum <"$temp")" = "$(sha256sum <"$destino")" ]; then
    rm -f "$temp"
    return 2
  fi
  chmod 700 "$temp"
  mv -f "$temp" "$destino"
}

# Depois de um "ok": o vigia do commit implantado (mesmo numa volta a um commit antigo: o que vale é o que está no
# ar; a próxima implantação da main traz o de hoje). Sem o arquivo no commit (anterior ao OP-B4), fica o atual.
autoatualizar() {
  local codigo=0
  instalar_de "$1:infra/producao/vigia/vigia-implantacao.sh" "$VIGIA_INSTALADO" || codigo=$?
  case "$codigo" in
    0) registrar "vigia atualizado com o do commit ${1:0:12} (sha256 $(sha256sum "$VIGIA_INSTALADO" | cut -d' ' -f1))" ;;
    2) ;;
    *) registrar "o commit ${1:0:12} não tem um vigia-implantacao.sh válido: fica o vigia atual" ;;
  esac
}

# buscar_main: a main do repositório público no clone do vigia; volta 1 (já registrado) se a rede falhou (tenta na
# próxima rodada).
buscar_main() {
  atualizar_repo >/dev/null 2>&1 && return 0
  registrar_uma_vez "$SEM_REDE" "não foi possível buscar a main do repositório público; tenta de novo na próxima rodada"
  return 1
}

# copiar_sem_actions <pedido> <commit>: a cópia do implantar-sem-actions.sh da main (já buscada). Sem um script
# válido na main, o pedido falhou: o estado e o log, e volta 1 (quem chama marca como tratado).
copiar_sem_actions() {
  local codigo=0
  instalar_de "refs/heads/main:infra/producao/implantar-sem-actions.sh" "$SEM_ACTIONS" || codigo=$?
  [ "$codigo" = 1 ] || return 0
  escrever_estado "$1" "$2" falhou "$(agora)"
  registrar "$1: falhou (a main não tem um implantar-sem-actions.sh válido)"
  return 1
}

# implantar <pedido> <commit> [opções]: a chamada do implantar-sem-actions.sh, com o estado e o log; o commit fica
# como tratado na main (o pedido manual também: o vigia não o implanta de novo sozinho). Código 75 (a trava pega no
# mesmo instante): volta a "recebido", sem marcar nada.
implantar() {
  local pedido=$1 commit=$2 codigo=0
  shift 2
  printf '%s %s %s\n' "$pedido" "$commit" "$(agora)" >"$EM_ANDAMENTO"
  escrever_estado "$pedido" "$commit" em_andamento
  registrar "$pedido: em andamento (bash $SEM_ACTIONS ${*:+$* }$commit; saída em $LOG_CHAMADA)"
  GENESIS_PASTA=$PASTA bash "$SEM_ACTIONS" "$@" "$commit" </dev/null >"$LOG_CHAMADA" 2>&1 9>&- || codigo=$?
  rm -f "$EM_ANDAMENTO"
  case "$codigo" in
    0)
      [ "$pedido" = main ] || marcar "$pedido" ok
      marcar_main "$commit" ok
      escrever_estado "$pedido" "$commit" ok "$(agora)"
      registrar "$pedido: ok (commit ${commit:0:12} no ar)"
      autoatualizar "$commit" || registrar "a autoatualização do vigia falhou; fica o vigia atual (a implantação continua ok)"
      ;;
    75)
      escrever_estado "$pedido" "$commit" recebido
      registrar "$pedido: outra implantação começou no mesmo instante; tenta de novo na próxima rodada"
      ;;
    *)
      [ "$pedido" = main ] || marcar "$pedido" falhou
      marcar_main "$commit" falhou
      escrever_estado "$pedido" "$commit" falhou "$(agora)"
      registrar "$pedido: falhou (código $codigo; a mensagem ERRO e o resumo estão em $LOG_CHAMADA)"
      ;;
  esac
}

# 1. O pedido manual mais novo não visto (pendentes: do mais velho para o mais novo).
atender_pedido() {
  local pendentes=("$@") nome
  local pedido=${pendentes[-1]}
  local commit=${COMMIT_DE[$pedido]}
  estado_de "$pedido" "$commit" || {
    escrever_estado "$pedido" "$commit" recebido
    registrar "$pedido: recebido (commit ${commit:0:12})"
  }
  if ! travas_livres; then
    registrar_uma_vez "$AGUARDANDO" "$pedido: outra implantação em andamento; tenta de novo na próxima rodada"
    return 0
  fi
  rm -f "$AGUARDANDO"
  for nome in "${pendentes[@]:0:${#pendentes[@]}-1}"; do
    marcar "$nome" pulado
    registrar "$nome: pulado (o pedido mais novo $pedido vale no lugar dele)"
  done
  buscar_main || return 0
  if ! na_main "$commit"; then
    marcar "$pedido" recusado
    escrever_estado "$pedido" "$commit" recusado "$(agora)"
    registrar "$pedido: recusado (o commit $commit não está na main: só vai para produção o que entrou na main)"
    return 0
  fi
  copiar_sem_actions "$pedido" "$commit" || {
    marcar "$pedido" falhou
    marcar_main "$commit" falhou
    return 0
  }
  local opcoes=()
  [[ $pedido != implantar-pdv/* ]] || opcoes+=(--publicar-pdv)
  implantar "$pedido" "$commit" "${opcoes[@]}"
}

# 2. A ponta da main ainda não tratada (D119). Sem nada a fazer com ela, MAIN_PENDENTE fica 0 (a rodada segue para
# o PDV); um flag, não o código de volta: uma função chamada numa condição roda sem o set -e.
atender_main() {
  local ponta=$1 no_ar ate
  MAIN_PENDENTE=0
  ! main_tratado "$ponta" || return 0
  no_ar=$(versao_no_ar)
  if [ "$no_ar" = "${ponta:0:12}" ]; then
    marcar_main "$ponta" ja-no-ar
    # O "recebido" de uma rodada anterior (a trava presa ou a janela) que o dono implantou pelo terminal: o estado
    # público termina (ok: a ponta está no ar), em vez de ficar "recebido" para sempre.
    if estado_de main "$ponta" && [[ $(campo_estado resultado) =~ ^(recebido|em_andamento)$ ]]; then
      escrever_estado main "$ponta" ok "$(agora)"
      registrar "main: a ponta ${ponta:0:12} já é a versão no ar (implantada fora do vigia); o estado.json, que estava como recebido, fica ok"
    else
      registrar "main: a ponta ${ponta:0:12} já é a versão no ar; não implanta de novo"
    fi
    return 0
  fi
  MAIN_PENDENTE=1
  estado_de main "$ponta" || {
    escrever_estado main "$ponta" recebido
    registrar "main: commit novo ${ponta:0:12} na ponta da main (recebido; no ar: ${no_ar:-nenhuma versão registrada})"
  }
  if ! travas_livres; then
    registrar_uma_vez "$AGUARDANDO" "main ${ponta:0:12}: outra implantação em andamento; tenta de novo na próxima rodada"
    return 0
  fi
  rm -f "$AGUARDANDO"
  if ate=$(dentro_da_janela); then
    registrar_uma_vez "$AVISO_JANELA" "main ${ponta:0:12}: dentro da janela sem implantação automática (horário de Brasília, $JANELA); implanta a partir das $ate"
    return 0
  fi
  rm -f "$AVISO_JANELA"
  buscar_main || return 0
  # A main reescrita entre o ls-remote e o fetch (um force push): a ponta lida não é mais dela.
  if ! na_main "$ponta"; then
    marcar_main "$ponta" recusado
    escrever_estado main "$ponta" recusado "$(agora)"
    registrar "main: recusado (o commit $ponta não está mais na main)"
    return 0
  fi
  copiar_sem_actions main "$ponta" || {
    marcar_main "$ponta" falhou
    return 0
  }
  implantar main "$ponta"
}

# 3. O PDV (D119): a tag pdv-vX.Y.Z de versão mais alta mudou. "nada a publicar" (a página já serve o mesmo sha256,
# ou nenhum release publicado) não escreve no estado.json: o resultado da última implantação continua lá. A tag vai
# ao --so-pdv (--tag): com o release dela ainda não publicado, ele sai com 69 em vez de achar o anterior, que a página
# já serve, e a tag não fica tratada antes da hora.
atender_pdv() {
  local tag=$1 commit=$2 no_ar espera tag_espera antes_espera inicio_espera ate antes depois inicio codigo=0
  [ -n "$tag" ] && ! pdv_tratado "$tag" "$commit" || return 0
  no_ar=$(versao_no_ar)
  if [ -z "$no_ar" ]; then
    registrar_uma_vez "$AGUARDANDO" "pdv $tag: sem versão no ar registrada ($PASTA/versoes/atual); a publicação do PDV espera a primeira implantação"
    return 0
  fi
  # A espera (o 69 e as falhas passageiras) vale só para a mesma tag (um release novo tenta na hora); dela vêm também
  # o sha256 que a página servia e o inicio da primeira tentativa.
  espera=0 tag_espera='' antes_espera='' inicio_espera=''
  [ ! -f "$PDV_ESPERA" ] || read -r espera tag_espera antes_espera inicio_espera 2>/dev/null <"$PDV_ESPERA" || true
  if ! [[ $espera =~ ^[0-9]+$ ]] || [ "$tag_espera" != "$tag" ]; then
    espera=0 antes_espera='' inicio_espera=''
  fi
  [ "$(date +%s)" -ge "$espera" ] || return 0
  if ! travas_livres; then
    registrar_uma_vez "$AGUARDANDO" "pdv $tag: outra implantação em andamento; tenta de novo na próxima rodada"
    return 0
  fi
  rm -f "$AGUARDANDO"
  if ate=$(dentro_da_janela); then
    registrar_uma_vez "$AVISO_JANELA" "pdv $tag: dentro da janela sem nada automático (horário de Brasília, $JANELA); publica a partir das $ate"
    return 0
  fi
  rm -f "$AVISO_JANELA"
  buscar_main || return 0
  copiar_sem_actions pdv "$no_ar" || {
    marcar_pdv "$tag" "$commit" falhou
    return 0
  }
  # O sha256 de antes e o inicio são os da primeira tentativa desta tag: a que publicou e falhou depois (a URL que
  # não respondeu) e a tentativa seguinte, que acha a página já trocada, contam como uma publicação só.
  antes=$(pdv_na_pagina)
  if [[ $antes_espera =~ ^([0-9a-f]{64}|-)$ ]]; then antes=${antes_espera#-}; fi
  inicio=$(agora)
  if [[ $inicio_espera =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then inicio=$inicio_espera; fi
  printf 'pdv %s %s\n' "$no_ar" "$(agora)" >"$EM_ANDAMENTO"
  registrar "pdv $tag: publicação do PDV na versão no ar $no_ar (bash $SEM_ACTIONS --so-pdv --tag=$tag; saída em $LOG_CHAMADA)"
  GENESIS_PASTA=$PASTA bash "$SEM_ACTIONS" --so-pdv "--tag=$tag" </dev/null >"$LOG_CHAMADA" 2>&1 9>&- || codigo=$?
  rm -f "$EM_ANDAMENTO"
  depois=$(pdv_na_pagina)
  case "$codigo" in
    0)
      rm -f "$PDV_ESPERA"
      marcar_pdv "$tag" "$commit" ok
      if [ "$depois" != "$antes" ]; then
        escrever_estado pdv "$no_ar" ok "$(agora)" "$inicio"
        registrar "pdv $tag: ok (a página de download serve agora o instalador de sha256 ${depois:-nenhum})"
      else
        registrar "pdv $tag: nada a publicar (a página já servia o release publicado mais novo, ou não há release publicado)"
      fi
      ;;
    75) registrar "pdv $tag: outra implantação começou no mesmo instante; tenta de novo na próxima rodada" ;;
    65)
      # O release com arquivo inválido: o único que não repete (refeito no mesmo release, o README diz como tentar).
      rm -f "$PDV_ESPERA"
      marcar_pdv "$tag" "$commit" falhou
      escrever_estado pdv "$no_ar" falhou "$(agora)" "$inicio"
      registrar "pdv $tag: falhou (o release tem arquivo inválido; não tenta de novo esta tag: a mensagem ERRO e o resumo estão em $LOG_CHAMADA)"
      ;;
    *)
      # O 69 (o GitHub sem responder, o release incompleto ou ainda não publicado) e as falhas passageiras (o 1: o
      # Docker, o espaço, a imagem, a URL que não respondeu): tenta de novo depois, sem marcar a tag nem mexer no
      # estado.json.
      printf '%s %s %s %s\n' $(($(date +%s) + PDV_ESPERA_SEGUNDOS)) "$tag" "${antes:--}" "$inicio" >"$PDV_ESPERA"
      # Uma linha por tag e motivo: um release que fica como pre-release com a tag mais alta tenta a cada 15 minutos.
      if [ "$codigo" = 69 ]; then
        registrar_uma_vez "$PDV_AVISO" "pdv $tag: o GitHub não respondeu, o release está incompleto ou ainda não foi publicado; tenta de novo em $((PDV_ESPERA_SEGUNDOS / 60)) minutos (saída em $LOG_CHAMADA)"
      else
        registrar_uma_vez "$PDV_AVISO" "pdv $tag: não publicou (código $codigo: a mensagem ERRO e o resumo estão em $LOG_CHAMADA); tenta de novo em $((PDV_ESPERA_SEGUNDOS / 60)) minutos"
      fi
      ;;
  esac
}

rodada() {
  [ "$(id -u)" = 0 ] || erro "rode como root (o genesis-vigia.service roda como root)."
  local c
  for c in git flock timeout sha256sum stat; do
    command -v "$c" >/dev/null || erro "falta o comando $c."
  done
  mkdir -p "$VIGIA"
  chmod 700 "$VIGIA"
  # Uma rodada por vez (a que implanta segura a trava por minutos; o timer não começa outra enquanto o serviço roda,
  # mas uma rodada à mão poderia).
  exec 9>"$TRAVA"
  flock -n 9 || exit 0
  aparar_log
  # Sem a lista dos vistos (o instalar-vigia.sh a cria), toda tag antiga pareceria pedido novo: não roda nada.
  if [ ! -f "$VISTOS" ]; then
    registrar_uma_vez "$AGUARDANDO" "sem a lista dos pedidos vistos ($VISTOS): rode o instalar-vigia.sh (README › Vigia da implantação); nada é implantado até lá"
    return 0
  fi
  retomar_interrompida || return 0

  local lista
  if ! lista=$(git_publico ls-remote --heads --tags "$REPOSITORIO" 2>&1); then
    registrar_uma_vez "$SEM_REDE" "sem resposta do repositório público (rede da VPS ou o GitHub fora do ar?); tenta de novo na próxima rodada"
    return 0
  fi
  [ ! -f "$SEM_REDE" ] || {
    rm -f "$SEM_REDE"
    registrar "o repositório público voltou a responder"
  }

  # Pedido → commit e tag do PDV → commit; o "^{}" (a tag anotada descascada até o commit) vale sobre o objeto da
  # tag. A ponta da main, do refs/heads/main.
  declare -gA COMMIT_DE=()
  local -A pdv_de=()
  local sha ref nome ponta=''
  while IFS=$'\t' read -r sha ref; do
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
    if [ "$ref" = refs/heads/main ]; then
      ponta=$sha
      continue
    fi
    [[ $ref == refs/tags/* ]] || continue
    nome=${ref#refs/tags/}
    if [[ $nome == *'^{}' ]]; then
      nome=${nome%'^{}'}
      if [[ $nome =~ $EXPR_PEDIDO ]]; then COMMIT_DE[$nome]=$sha; fi
      if [[ $nome =~ $EXPR_PDV ]]; then pdv_de[$nome]=$sha; fi
    elif [[ $nome =~ $EXPR_PEDIDO ]] && [ -z "${COMMIT_DE[$nome]:-}" ]; then
      COMMIT_DE[$nome]=$sha
    elif [[ $nome =~ $EXPR_PDV ]] && [ -z "${pdv_de[$nome]:-}" ]; then
      pdv_de[$nome]=$sha
    fi
  done <<<"$lista"

  # 1. Pedido manual: os não vistos, do mais velho para o mais novo pela data e hora do nome (o prefixo só desempata).
  local pendentes=()
  for nome in "${!COMMIT_DE[@]}"; do
    visto "$nome" || pendentes+=("${nome#*/} $nome")
  done
  if [ "${#pendentes[@]}" -gt 0 ]; then
    mapfile -t pendentes < <(printf '%s\n' "${pendentes[@]}" | sort | cut -d' ' -f2)
    atender_pedido "${pendentes[@]}"
    return 0
  fi

  # 2. A ponta da main.
  if [ -z "$ponta" ]; then
    registrar_uma_vez "$SEM_REDE" "o repositório público respondeu sem o branch main; tenta de novo na próxima rodada"
    return 0
  fi
  atender_main "$ponta"
  [ "$MAIN_PENDENTE" = 0 ] || return 0

  # 3. O PDV: a tag pdv-vX.Y.Z de versão mais alta.
  local tag_pdv=''
  if [ "${#pdv_de[@]}" -gt 0 ]; then
    tag_pdv=$(printf '%s\n' "${!pdv_de[@]}" | sort -V | tail -n 1)
  fi
  if [ -n "$tag_pdv" ]; then atender_pdv "$tag_pdv" "${pdv_de[$tag_pdv]}"; fi
}

rodada
