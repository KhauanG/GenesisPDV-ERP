#!/usr/bin/env bash
# Genesis: vigia da implantação na VPS (OP-B4; D70; README desta pasta › Vigia da implantação). Uma rodada: lê as
# tags do repositório público (só leitura, sem token), escolhe o pedido de implantação mais novo ainda não visto e
# chama o implantar-sem-actions.sh com ele. O genesis-vigia.timer (systemd) roda uma rodada a cada 2 minutos; o
# instalar-vigia.sh instala, atualiza, desliga e mostra o estado.
#
#   bash /opt/genesis/vigia/vigia-implantacao.sh      # uma rodada (o que o genesis-vigia.service roda)
#
# O sentido é o contrário do SSH: a sessão do Claude Code (ou quem tem escrita no repositório) cria a tag, e a VPS a
# busca. Ninguém de fora pede: criar tag exige permissão de escrita no repositório, a mesma de juntar na main.
#
# Pedido = tag do repositório público, apontando para um commit da main (ancestral da origin/main):
#   implantar/<AAAAMMDD-HHMMSS>       implantar o commit (implantar-sem-actions.sh <commit>)
#   implantar-pdv/<AAAAMMDD-HHMMSS>   o mesmo, publicando o PDV do último release (--publicar-pdv)
# Outro nome de tag não é pedido. A data e hora do nome (UTC) ordena os pedidos: roda só o mais novo ainda não visto,
# e os anteriores ficam como pulados. Na instalação, as tags que já existem ficam como vistas (pedido antigo não
# roda). Commit fora da main: recusado, sem chamar nada. Commit mais velho que o atual: permitido (é a volta).
#
# Uma rodada, na ordem:
#   1. trava do vigia (uma rodada por vez; ocupada = sai sem fazer nada) e a retomada de uma implantação interrompida
#      (a VPS reiniciou no meio: o pedido fica como falhou; ainda rodando, espera);
#   2. `git ls-remote --tags` do repositório público; sem resposta = tenta na próxima rodada;
#   3. o pedido mais novo não visto: estado "recebido"; com outra implantação em andamento (a trava do
#      implantar-sem-actions.sh ou a do implantar.sh), fica para a próxima rodada;
#   4. a main do repositório num clone parcial próprio ($PASTA/vigia/repo.git): commit fora dela = "recusado";
#   5. o implantar-sem-actions.sh da main de agora (a mesma regra do README: o script vem da main, não do commit) e a
#      chamada, fora do terminal como sempre, com --publicar-pdv no implantar-pdv/; estado "em_andamento" e depois
#      "ok" ou "falhou" (o código 75 do implantar-sem-actions.sh, a trava pega no mesmo instante, volta a "recebido");
#   6. depois de um "ok", o vigia se atualiza com o vigia-implantacao.sh do commit implantado, só se mudou (sha256),
#      por rename (a rodada em andamento continua lendo o arquivo antigo); falhar aqui não desfaz a implantação.
#
# Estado: $PASTA/vigia (root 700): vistos (um pedido por linha: o nome, o resultado e quando), vigia.log (o que cada
# rodada fez; 1 MB no máximo), ultima-implantacao.log (a saída da última chamada do implantar-sem-actions.sh), a
# cópia do implantar-sem-actions.sh e o repo.git. A única saída pública é $PASTA/download/implantacao/estado.json
# (servido em https://<DOWNLOAD_DOMINIO>/implantacao/estado.json, por decisão do dono, D70) com só
# {pedido, commit (12), resultado, inicio, fim}: o nome da tag e o commit já são públicos no repositório; resultado
# é recebido, em_andamento, ok, falhou ou recusado; inicio é quando o vigia recebeu o pedido e fim, quando terminou
# (null até lá). Nada de log, versão, estado da VPS ou mensagem de erro (isso fica no vigia.log).
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
LOG=$VIGIA/vigia.log
LOG_MAXIMO_BYTES=1048576
LOG_CHAMADA=$VIGIA/ultima-implantacao.log
EM_ANDAMENTO=$VIGIA/em-andamento
AGUARDANDO=$VIGIA/.aguardando
SEM_REDE=$VIGIA/.sem-rede
TRAVA=$VIGIA/.vigia.lock
# O vigia instalado (o que o genesis-vigia.service roda) e a cópia do implantar-sem-actions.sh que ele chama.
VIGIA_INSTALADO=$VIGIA/vigia-implantacao.sh
SEM_ACTIONS=$VIGIA/implantar-sem-actions.sh
PUBLICO=$PASTA/download/implantacao
ESTADO=$PUBLICO/estado.json
GID_NGINX=${GENESIS_GID_NGINX:-101}
EXPR_PEDIDO='^(implantar|implantar-pdv)/[0-9]{8}-[0-9]{6}$'

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

# escrever_estado <pedido> <commit> <resultado> [fim]: os valores já passaram pelas expressões do pedido, do commit e
# da data (nada a escapar). O inicio é o da primeira vez que este pedido apareceu no estado.json (o "recebido").
# Arquivo novo e rename no mesmo diretório: o nginx nunca lê um estado pela metade.
escrever_estado() {
  local pedido=$1 commit=${2:0:12} resultado=$3 fim=null inicio temp
  [ -z "${4:-}" ] || fim="\"$4\""
  inicio=$(agora)
  if [ "$(campo_estado pedido)" = "$pedido" ] && [ -n "$(campo_estado inicio)" ]; then inicio=$(campo_estado inicio); fi
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

# --- Pedidos ------------------------------------------------------------------------------------------------------

visto() { [ -f "$VISTOS" ] && grep -q "^$1 " "$VISTOS"; }
marcar() { printf '%s %s %s\n' "$1" "$2" "$(agora)" >>"$VISTOS"; }

# As travas do implantar-sem-actions.sh e do implantar.sh livres agora (abre, tenta e solta; o subshell fecha o
# descritor): com uma delas presa, há implantação em andamento (a do dono pelo terminal, ou outra).
travas_livres() {
  (exec 7>"$PASTA/.implantar-sem-actions.lock" && flock -n 7) &&
    (exec 7>"$PASTA/.implantacao.lock" && flock -n 7)
}

# Implantação que ficou em andamento numa rodada anterior: a VPS reiniciou ou o vigia parou no meio. Com a trava do
# implantar-sem-actions.sh presa, ela ainda roda (fora do vigia, que morreu): espera. Livre: o pedido fica como
# falhou (não se sabe até onde foi; o implantar.sh estado e o log dizem), e a rodada segue.
retomar_interrompida() {
  [ -f "$EM_ANDAMENTO" ] || return 0
  local pedido commit
  read -r pedido commit _ <"$EM_ANDAMENTO" || true
  if ! [[ $pedido =~ $EXPR_PEDIDO ]] || ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
    rm -f "$EM_ANDAMENTO"
    return 0
  fi
  if ! travas_livres; then
    registrar_uma_vez "$AGUARDANDO" "$pedido: a implantação que ficou em andamento ainda roda; espera ela terminar"
    return 1
  fi
  local no_ar
  no_ar=$(cat "$PASTA/versoes/atual" 2>/dev/null || true)
  marcar "$pedido" falhou
  rm -f "$EM_ANDAMENTO" "$AGUARDANDO"
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
  if ! lista=$(git_publico ls-remote --tags "$REPOSITORIO" 2>&1); then
    registrar_uma_vez "$SEM_REDE" "sem resposta do repositório público (rede da VPS ou o GitHub fora do ar?); tenta de novo na próxima rodada"
    return 0
  fi
  [ ! -f "$SEM_REDE" ] || {
    rm -f "$SEM_REDE"
    registrar "o repositório público voltou a responder"
  }

  # nome → commit; o "^{}" (a tag anotada descascada até o commit) vale sobre o objeto da tag.
  local -A commit_de=()
  local sha ref nome
  while IFS=$'\t' read -r sha ref; do
    nome=${ref#refs/tags/}
    if [[ $nome == *'^{}' ]]; then
      nome=${nome%'^{}'}
      [[ $nome =~ $EXPR_PEDIDO ]] && [[ $sha =~ ^[0-9a-f]{40}$ ]] && commit_de[$nome]=$sha
    elif [[ $nome =~ $EXPR_PEDIDO ]] && [[ $sha =~ ^[0-9a-f]{40}$ ]] && [ -z "${commit_de[$nome]:-}" ]; then
      commit_de[$nome]=$sha
    fi
  done <<<"$lista"

  # Os não vistos, do mais velho para o mais novo pela data e hora do nome (o prefixo só desempata).
  local pendentes=()
  for nome in "${!commit_de[@]}"; do
    visto "$nome" || pendentes+=("${nome#*/} $nome")
  done
  [ "${#pendentes[@]}" -gt 0 ] || return 0
  mapfile -t pendentes < <(printf '%s\n' "${pendentes[@]}" | sort | cut -d' ' -f2)
  local pedido=${pendentes[-1]}
  local commit=${commit_de[$pedido]}
  [ "$(campo_estado pedido)" = "$pedido" ] || {
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

  if ! atualizar_repo >/dev/null 2>&1; then
    registrar_uma_vez "$SEM_REDE" "não foi possível buscar a main do repositório público; tenta de novo na próxima rodada"
    return 0
  fi
  if ! na_main "$commit"; then
    marcar "$pedido" recusado
    escrever_estado "$pedido" "$commit" recusado "$(agora)"
    registrar "$pedido: recusado (o commit $commit não está na main: só vai para produção o que entrou na main)"
    return 0
  fi
  local codigo=0
  instalar_de "refs/heads/main:infra/producao/implantar-sem-actions.sh" "$SEM_ACTIONS" || codigo=$?
  if [ "$codigo" = 1 ]; then
    marcar "$pedido" falhou
    escrever_estado "$pedido" "$commit" falhou "$(agora)"
    registrar "$pedido: falhou (a main não tem um implantar-sem-actions.sh válido)"
    return 0
  fi

  local opcoes=()
  [[ $pedido != implantar-pdv/* ]] || opcoes+=(--publicar-pdv)
  printf '%s %s %s\n' "$pedido" "$commit" "$(agora)" >"$EM_ANDAMENTO"
  escrever_estado "$pedido" "$commit" em_andamento
  registrar "$pedido: em andamento (bash $SEM_ACTIONS ${opcoes[*]} $commit; saída em $LOG_CHAMADA)"
  codigo=0
  GENESIS_PASTA=$PASTA bash "$SEM_ACTIONS" "${opcoes[@]}" "$commit" </dev/null >"$LOG_CHAMADA" 2>&1 9>&- || codigo=$?
  rm -f "$EM_ANDAMENTO"
  case "$codigo" in
    0)
      marcar "$pedido" ok
      escrever_estado "$pedido" "$commit" ok "$(agora)"
      registrar "$pedido: ok (commit ${commit:0:12} no ar)"
      autoatualizar "$commit" || registrar "a autoatualização do vigia falhou; fica o vigia atual (a implantação continua ok)"
      ;;
    75)
      escrever_estado "$pedido" "$commit" recebido
      registrar "$pedido: outra implantação começou no mesmo instante; tenta de novo na próxima rodada"
      ;;
    *)
      marcar "$pedido" falhou
      escrever_estado "$pedido" "$commit" falhou "$(agora)"
      registrar "$pedido: falhou (código $codigo; a mensagem ERRO e o resumo estão em $LOG_CHAMADA)"
      ;;
  esac
}

rodada
