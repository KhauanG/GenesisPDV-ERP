#!/usr/bin/env bash
# Genesis: instala, atualiza, desliga e mostra o vigia da implantação na VPS (OP-B4 e OP-B7; D70 e D119; README desta
# pasta › Vigia da implantação). Idempotente: rodar de novo atualiza para a versão da main e mantém o que já foi visto
# e tratado.
#
#   bash instalar-vigia.sh               # instala ou atualiza e liga o timer (o comando do README)
#   bash instalar-vigia.sh --estado      # timer, janela, última rodada, estado.json público e o fim do log do vigia
#   bash instalar-vigia.sh --desligar    # desliga o timer (a implantação em andamento termina; os arquivos ficam)
#
# Instalar, na ordem:
#   1. root, systemd, git e flock; a pasta $PASTA/vigia (root 700) e a trava do vigia (uma rodada no meio, talvez
#      implantando: recusa, rode de novo em alguns minutos);
#   2. o clone parcial da main do repositório público ($PASTA/vigia/repo.git, sem token, sem tags e sem os arquivos);
#   3. da main de agora: o vigia-implantacao.sh e a cópia do implantar-sem-actions.sh em $PASTA/vigia (700) e o
#      genesis-vigia.service e o genesis-vigia.timer em /etc/systemd/system (644), só o que mudou, e o daemon-reload;
#   4. com o timer desligado (a primeira instalação ou depois do --desligar) ou sem a lista dos vistos (mesmo com o
#      timer ligado), as tags de pedido que já existem ficam como vistas: pedido antigo, ou feito enquanto o vigia
#      estava desligado, não roda, e o estado.json de um pedido que esperava fica "recusado" (com o fim); com o timer
#      ligado e a lista no lugar (uma atualização), os pedidos que ainda não rodaram continuam valendo;
#   5. a implantação automática da main (D119): a janela ($PASTA/vigia/janela, root 600, criada com o padrão 17-24 se
#      não existe; a que existe fica, com o formato conferido) e a ponta da main: se ela já é a versão no ar
#      (versoes/atual), fica tratada; senão, fica pendente, e o vigia a implanta na primeira rodada fora da janela;
#   6. a pasta pública do estado ($PASTA/download/implantacao, root:101 750: o nginx do genesis-web só lê);
#   7. liga o timer (enable --now) e mostra o estado.
#
# Variáveis: GENESIS_PASTA (padrão /opt/genesis). Só para os testes: GENESIS_REPOSITORIO (um repositório local no
# lugar do público), GENESIS_SYSTEMD (padrão /etc/systemd/system) e GENESIS_GID_NGINX (padrão 101).
set -euo pipefail
umask 077

REPOSITORIO_PUBLICO=KhauanG/GenesisPDV-ERP
REPOSITORIO=${GENESIS_REPOSITORIO:-https://github.com/$REPOSITORIO_PUBLICO}
PASTA=${GENESIS_PASTA:-/opt/genesis}
VIGIA=$PASTA/vigia
REPO=$VIGIA/repo.git
VISTOS=$VIGIA/vistos
MAIN_TRATADOS=$VIGIA/main-tratados
JANELA=$VIGIA/janela
JANELA_PADRAO=17-24
LOG=$VIGIA/vigia.log
TRAVA=$VIGIA/.vigia.lock
SYSTEMD=${GENESIS_SYSTEMD:-/etc/systemd/system}
PUBLICO=$PASTA/download/implantacao
GID_NGINX=${GENESIS_GID_NGINX:-101}
TIMER=genesis-vigia.timer
SERVICO=genesis-vigia.service
EXPR_PEDIDO='^(implantar|implantar-pdv)/[0-9]{8}-[0-9]{6}$'

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32mOK:\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33mATENÇÃO: %s\033[0m\n' "$*" >&2; }
erro() {
  printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2
  exit 1
}
uso() { sed -n '6,8p' "$0" | sed 's/^# \{0,1\}//'; }

ACAO=instalar
case "${1:-}" in
  '') ;;
  --estado) ACAO=estado ;;
  --desligar) ACAO=desligar ;;
  -h | --ajuda)
    uso
    exit 0
    ;;
  *)
    uso >&2
    erro "opção desconhecida: '$1'."
    ;;
esac
[ "$#" -le 1 ] || erro "use uma opção só."

git_publico() { GIT_TERMINAL_PROMPT=0 timeout 300 git -c credential.helper= "$@"; }
git_repo() { git_publico --git-dir="$REPO" "$@"; }
timer_ligado() { systemctl is-active --quiet "$TIMER" 2>/dev/null; }

# A janela sem implantação automática no formato do vigia (vigia-implantacao.sh › ler_janela): "<início>-<fim>" em
# horas cheias (início de 0 a 23, fim de 1 a 24, diferentes) ou "nenhuma".
janela_valida() {
  [ "$1" = nenhuma ] && return 0
  [[ $1 =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]] || return 1
  local ini=$((10#${BASH_REMATCH[1]})) fim=$((10#${BASH_REMATCH[2]}))
  [ "$ini" -le 23 ] && [ "$fim" -le 24 ] && [ "$fim" -ge 1 ] && [ "$ini" != "$fim" ]
}
ler_janela() { head -c 64 "$JANELA" 2>/dev/null | head -n 1 | tr -d '[:space:]' || true; }
descrever_janela() {
  local j=$1
  if [ "$j" = nenhuma ]; then
    echo "nenhuma: a main é implantada a qualquer hora"
  else
    printf 'das %02d:00 às %02d:00 (horário de Brasília), sem implantação automática\n' "$((10#${j%-*}))" "$((10#${j#*-} % 24))"
  fi
}

conferir_root() {
  [ "$(id -u)" = 0 ] ||
    erro "rode como root (o terminal da VPS na Hostinger já entra como root; senão, sudo -i antes)."
}

# --- --estado e --desligar -----------------------------------------------------------------------------------------

estado() {
  conferir_root
  passo "Timer ($TIMER)"
  if timer_ligado; then
    ok "ligado: uma rodada a cada 2 minutos"
    systemctl list-timers "$TIMER" --no-pager 2>/dev/null || true
  else
    aviso "desligado: nenhum pedido é atendido e a main não é implantada (para ligar: bash $0)."
  fi
  passo "Implantação automática da main (D119)"
  local j
  j=$(ler_janela)
  if janela_valida "${j:-$JANELA_PADRAO}"; then
    ok "janela: $(descrever_janela "${j:-$JANELA_PADRAO}") ($JANELA)"
  else
    aviso "janela fora do formato em $JANELA ('$j'): vale o padrão, $(descrever_janela "$JANELA_PADRAO")."
  fi
  echo "Versão no ar: $(cat "$PASTA/versoes/atual" 2>/dev/null || echo 'nenhuma registrada')"
  echo "Últimos commits da main tratados (commit, resultado, quando):"
  tail -n 3 "$MAIN_TRATADOS" 2>/dev/null || echo "(nenhum)"
  echo "Últimas publicações do PDV (tag, commit, resultado, quando):"
  tail -n 3 "$VIGIA/pdv-tratados" 2>/dev/null || echo "(nenhuma)"
  passo "Última rodada ($SERVICO)"
  systemctl show "$SERVICO" -p ActiveState -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp \
    --no-pager 2>/dev/null || true
  [ ! -f "$VIGIA/em-andamento" ] || aviso "implantação em andamento: $(cut -d' ' -f1 "$VIGIA/em-andamento") (bash $VIGIA/implantar-sem-actions.sh --acompanhar mostra)."
  passo "Estado público ($PUBLICO/estado.json, o que a sessão lê)"
  cat "$PUBLICO/estado.json" 2>/dev/null || echo "(nenhum pedido atendido ainda)"
  passo "Log do vigia (as 20 últimas linhas de $LOG)"
  tail -n 20 "$LOG" 2>/dev/null || echo "(vazio)"
  echo
  echo "Saída completa da última implantação pedida: $VIGIA/ultima-implantacao.log"
  echo "Implantação em andamento ou a última, com o resumo: bash $VIGIA/implantar-sem-actions.sh --acompanhar"
}

desligar() {
  conferir_root
  command -v systemctl >/dev/null || erro "falta o systemctl."
  systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
  ok "vigia desligado: nenhum pedido novo é atendido e a main não é implantada. Uma implantação que já estava em andamento termina normalmente."
  echo "Os arquivos ficam em $VIGIA (o log, os pedidos vistos e os commits tratados). Para religar: o mesmo comando de instalar (os pedidos por tag feitos enquanto ele esteve desligado não rodam; a ponta da main ainda não tratada, sim, fora da janela)."
}

# --- Instalar ------------------------------------------------------------------------------------------------------

# instalar_arquivo <caminho no repositório> <destino> <modo>: grava o arquivo da main no destino só se mudou, por
# rename (o vigia em execução continua lendo o antigo). Volta 0 se gravou, 2 se já estava igual.
instalar_arquivo() {
  local origem=$1 destino=$2 modo=$3 temp
  temp=$(mktemp "$(dirname "$destino")/.genesis-vigia.XXXXXX")
  git_repo show "refs/heads/main:$origem" >"$temp" 2>/dev/null || {
    rm -f "$temp"
    erro "a main de $REPOSITORIO não tem $origem (o vigia chegou na main com o OP-B4)."
  }
  if [[ $origem == *.sh ]]; then
    [ "$(head -c 19 "$temp")" = '#!/usr/bin/env bash' ] && bash -n "$temp" 2>/dev/null || {
      rm -f "$temp"
      erro "$origem da main não é um script bash válido; nada foi trocado."
    }
  fi
  if [ -f "$destino" ] && [ "$(sha256sum <"$temp")" = "$(sha256sum <"$destino")" ]; then
    rm -f "$temp"
    return 2
  fi
  chmod "$modo" "$temp"
  mv -f "$temp" "$destino"
}

# O estado.json público de um pedido que ficou esperando ("recebido": a trava de outra implantação presa) e acabou de
# ser marcado como visto na instalação nunca terminaria: fica "recusado", com o fim (a sessão para de esperar; o
# motivo vai ao vigia.log). Uma implantação em andamento (o em-andamento existe) fica com o vigia, que a retoma.
encerrar_estado_pendente() {
  local estado=$PUBLICO/estado.json pedido resultado temp
  [ -f "$estado" ] && [ ! -f "$VIGIA/em-andamento" ] || return 0
  pedido=$(sed -n 's/^  "pedido": "\([^"]*\)",$/\1/p' "$estado" | head -n 1)
  resultado=$(sed -n 's/^  "resultado": "\([^"]*\)",$/\1/p' "$estado" | head -n 1)
  [[ $pedido =~ $EXPR_PEDIDO ]] && [[ $resultado =~ ^(recebido|em_andamento)$ ]] || return 0
  grep -q "^$pedido visto-na-instalacao " "$VISTOS" || return 0
  temp=$(mktemp "$PUBLICO/.estado.XXXXXX")
  sed -e "s/^  \"resultado\": \"$resultado\",\$/  \"resultado\": \"recusado\",/" \
    -e "s/^  \"fim\": null\$/  \"fim\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"/" "$estado" >"$temp"
  chgrp "$GID_NGINX" "$temp"
  chmod 640 "$temp"
  mv -f "$temp" "$estado"
  printf '%s %s: recusado (estava como %s e ficou como visto na instalação do vigia: não roda; a sessão pede de novo)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pedido" "$resultado" >>"$LOG"
  ok "o pedido $pedido, que esperava, ficou como recusado no estado público (não roda; a sessão pede de novo)"
}

instalar() {
  conferir_root
  passo "1/7 Pré-requisitos e a pasta do vigia ($VIGIA)"
  local c
  for c in git flock timeout sha256sum systemctl; do
    command -v "$c" >/dev/null || erro "falta o comando $c (no Ubuntu: apt-get install -y git util-linux)."
  done
  [ -d "$SYSTEMD" ] || erro "$SYSTEMD não existe: o vigia precisa do systemd."
  mkdir -p "$VIGIA"
  chown root:root "$VIGIA" 2>/dev/null || true
  chmod 700 "$VIGIA"
  exec 9>"$TRAVA"
  flock -n 9 || erro "o vigia está no meio de uma rodada (talvez implantando: bash $0 --estado mostra). Rode de novo em alguns minutos."
  ok "root, systemd, git e flock; $VIGIA (700)"

  passo "2/7 Main do repositório público ($REPO)"
  if [ ! -d "$REPO" ]; then
    git_publico clone --quiet --bare --filter=blob:none --single-branch --branch main --no-tags "$REPOSITORIO" "$REPO" ||
      erro "não foi possível clonar $REPOSITORIO (rede da VPS ou o GitHub fora do ar?); tente de novo."
  fi
  git_repo remote set-url origin "$REPOSITORIO"
  git_repo fetch --quiet --prune --no-tags origin '+refs/heads/main:refs/heads/main' ||
    erro "não foi possível buscar a main de $REPOSITORIO (rede da VPS ou o GitHub fora do ar?); tente de novo."
  local main
  main=$(git_repo rev-parse --verify --quiet refs/heads/main) || erro "branch main não encontrado em $REPOSITORIO."
  ok "main em ${main:0:12}"

  passo "3/7 Arquivos do vigia (da main ${main:0:12})"
  local item origem destino modo codigo mudou_unidade=0
  for item in \
    "infra/producao/vigia/vigia-implantacao.sh|$VIGIA/vigia-implantacao.sh|700" \
    "infra/producao/implantar-sem-actions.sh|$VIGIA/implantar-sem-actions.sh|700" \
    "infra/producao/vigia/$SERVICO|$SYSTEMD/$SERVICO|644" \
    "infra/producao/vigia/$TIMER|$SYSTEMD/$TIMER|644"; do
    IFS='|' read -r origem destino modo <<<"$item"
    codigo=0
    instalar_arquivo "$origem" "$destino" "$modo" || codigo=$?
    case "$codigo" in
      0)
        ok "$destino (atualizado)"
        [[ $destino != "$SYSTEMD"/* ]] || mudou_unidade=1
        ;;
      2) ok "$destino (já estava na versão da main)" ;;
      *) exit "$codigo" ;;
    esac
  done
  systemctl daemon-reload
  [ "$mudou_unidade" = 0 ] || ok "systemd recarregado (as unidades mudaram)"

  passo "4/7 Pedidos que já existem"
  local lista sha ref nome vistos=0 lista_nova=0
  lista=$(git_publico ls-remote --tags "$REPOSITORIO") ||
    erro "não foi possível ler as tags de $REPOSITORIO (rede da VPS ou o GitHub fora do ar?); tente de novo."
  # Sem a lista (a primeira instalação, ou a pasta do vigia apagada ou restaurada sem ela), as tags existentes ficam
  # como vistas mesmo com o timer ligado: as tags não somem depois de atendidas, e uma lista vazia faria o vigia
  # implantar de novo o pedido mais novo do histórico (uma volta sem ninguém pedir).
  [ -f "$VISTOS" ] || lista_nova=1
  touch "$VISTOS"
  chmod 600 "$VISTOS"
  if [ "$lista_nova" = 0 ] && timer_ligado; then
    ok "o vigia já estava ligado: os pedidos que ainda não rodaram continuam valendo"
  else
    while IFS=$'\t' read -r sha ref; do
      nome=${ref#refs/tags/}
      nome=${nome%'^{}'}
      [[ $nome =~ $EXPR_PEDIDO ]] && [[ $sha =~ ^[0-9a-f]{40}$ ]] || continue
      grep -q "^$nome " "$VISTOS" && continue
      printf '%s visto-na-instalacao %s\n' "$nome" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$VISTOS"
      vistos=$((vistos + 1))
    done <<<"$lista"
    [ "$lista_nova" = 0 ] || ! timer_ligado ||
      aviso "a lista dos pedidos vistos ($VISTOS) não existia: as tags que já existem ficam como vistas, mesmo com o vigia ligado."
    ok "$vistos pedido(s) antigo(s) marcado(s) como visto(s): não rodam (só os pedidos novos daqui em diante)"
    encerrar_estado_pendente
  fi

  passo "5/7 Implantação automática da main (D119)"
  local janela
  janela=$(ler_janela)
  if [ ! -f "$JANELA" ]; then
    (umask 077 && echo "$JANELA_PADRAO" >"$JANELA")
    janela=$JANELA_PADRAO
    ok "janela criada com o padrão: $(descrever_janela "$janela") ($JANELA)"
  elif janela_valida "$janela"; then
    ok "janela: $(descrever_janela "$janela") ($JANELA, mantida)"
  else
    aviso "janela fora do formato em $JANELA ('$janela'; o formato é <início>-<fim> em horas cheias, ex.: 17-24, ou nenhuma): o vigia usa o padrão, $(descrever_janela "$JANELA_PADRAO"). Corrija com: echo $JANELA_PADRAO > $JANELA"
  fi
  chmod 600 "$JANELA"
  touch "$MAIN_TRATADOS" "$VIGIA/pdv-tratados"
  chmod 600 "$MAIN_TRATADOS" "$VIGIA/pdv-tratados"
  local no_ar
  no_ar=$(cat "$PASTA/versoes/atual" 2>/dev/null || true)
  if grep -q "^$main " "$MAIN_TRATADOS"; then
    ok "a ponta da main ${main:0:12} já foi tratada ($(grep "^$main " "$MAIN_TRATADOS" | head -n 1 | cut -d' ' -f2)): não roda de novo sozinha"
  elif [ "$no_ar" = "${main:0:12}" ]; then
    printf '%s no-ar-na-instalacao %s\n' "$main" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$MAIN_TRATADOS"
    ok "a ponta da main ${main:0:12} já é a versão no ar: nada a implantar"
  else
    ok "a ponta da main ${main:0:12} ainda não está no ar (no ar: ${no_ar:-nenhuma versão registrada}): o vigia a implanta na primeira rodada fora da janela"
  fi

  passo "6/7 Pasta do estado público ($PUBLICO)"
  mkdir -p "$PUBLICO"
  chown root:"$GID_NGINX" "$PUBLICO" 2>/dev/null || chgrp "$GID_NGINX" "$PUBLICO"
  chmod 750 "$PUBLICO"
  [ ! -f "$PUBLICO/estado.json" ] || {
    chgrp "$GID_NGINX" "$PUBLICO/estado.json"
    chmod 640 "$PUBLICO/estado.json"
  }
  ok "root:$GID_NGINX 750 (servida em https://<DOWNLOAD_DOMINIO>/implantacao/estado.json depois de uma implantação com o OP-B4)"

  passo "7/7 Timer ($TIMER)"
  systemctl enable --now "$TIMER" >/dev/null
  ok "vigia ligado: uma rodada 1 minuto depois de agora e, depois, a cada 2 minutos"
  printf '\n\033[1;32mVigia da implantação instalado.\033[0m Estado: bash %s --estado. Desligar: bash %s --desligar.\n' "$0" "$0"
}

case "$ACAO" in
  instalar) instalar ;;
  estado) estado ;;
  desligar) desligar ;;
esac
