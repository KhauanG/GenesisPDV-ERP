#!/usr/bin/env bash
# Genesis: instala, atualiza, desliga e mostra o vigia da implantação na VPS (OP-B4, OP-B7 e OP-B9; D70, D119 e D121;
# README desta pasta › Vigia da implantação). Idempotente: rodar de novo atualiza para a versão da main e mantém o que
# já foi visto e tratado.
#
#   bash instalar-vigia.sh               # instala ou atualiza e liga o timer (o comando do README)
#   bash instalar-vigia.sh --estado      # timer, janela, última rodada, estado.json público e o fim do log do vigia
#   bash instalar-vigia.sh --desligar    # desliga o timer (a implantação em andamento termina; os arquivos ficam)
#   bash instalar-vigia.sh --autoatualizar <commit>   # só o vigia chama, depois de uma implantação ok (abaixo)
#
# A instalação e a autoatualização deixam uma cópia deste script em $PASTA/vigia/instalar-vigia.sh (700), sempre a da
# instalação aplicada: é ela que o dono usa no --estado e no --desligar (a que o comando de instalar baixou em ~ fica
# na versão daquele dia).
#
# Instalar, na ordem:
#   1. root, systemd, git e flock; a pasta $PASTA/vigia (root 700) e a trava do vigia (uma rodada no meio, talvez
#      implantando: recusa, rode de novo em alguns minutos);
#   2. o clone parcial da main do repositório público ($PASTA/vigia/repo.git, sem token, sem tags e sem os arquivos);
#   3. da main de agora: o vigia-implantacao.sh, a cópia do implantar-sem-actions.sh e a deste script em $PASTA/vigia
#      (700) e o genesis-vigia.service e o genesis-vigia.timer em /etc/systemd/system (644, conferidos antes), só o que
#      mudou, e o daemon-reload; o commit da main fica em $PASTA/vigia/instalacao (a instalação aplicada, OP-B9);
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
# Na etapa 3 e na autoatualização, a unidade e o timer só entram conferidos (conferir_unidades: o formato esperado e o
# systemd-analyze verify sem erro nem aviso sobre eles); fora disso, na instalação à mão, nada é trocado.
#
# Autoatualização (OP-B9; D121): depois de cada implantação "ok", o vigia roda o instalar-vigia.sh do commit implantado
# com --autoatualizar <commit>, fora do terminal e com a trava dele (herdada no descritor 9), para que nenhuma mudança
# do vigia volte a pedir comando na VPS. Ela faz só a etapa 3 (do commit: o vigia-implantacao.sh, a cópia deste
# script, o genesis-vigia.service e o genesis-vigia.timer; da main, a cópia do implantar-sem-actions.sh, a mesma regra
# do vigia) e
# o que as etapas 5 e 6 criam quando falta (a janela com o padrão, as listas dos tratados, a pasta pública), sem a
# etapa 4 (os pedidos antigos por vistos), sem mexer nos tratados nem na janela que existe e sem ligar o timer: o vigia
# desligado pelo dono continua desligado. Troca só o que mudou (sha256), por rename (a rodada em andamento termina com
# os arquivos antigos), com tudo preparado antes ao lado de cada destino (a cópia nova e uma ligação com o de antes:
# a troca e a volta são só renames, sem pedir espaço em disco): primeiro as unidades, com o daemon-reload, o
# try-restart do timer que mudou e estava ligado e a conferência de que ele continua ligado (o timer que o dono
# desligou no meio, com o --desligar, que não espera a trava, continua desligado: não é falha); depois os scripts.
# Falhou qualquer troca, das unidades ou dos scripts: os arquivos de antes voltam (daemon-reload e o timer religado se
# caiu e continua habilitado). Saída: uma linha por fato, sem cor (o vigia a põe no vigia.log; nada vai ao
# estado.json). Códigos: 0 trocou (ou nada mudou), 65 conferência recusada (nada trocado), 69 o arquivo não veio do
# repositório (rede; nada trocado: o vigia tenta de novo na rodada seguinte), 75 a trava do vigia ocupada, 1 a troca
# falhou e foi desfeita (ou nem começou), 70 a troca falhou e os arquivos de antes não voltaram por inteiro (o vigia
# tenta de novo na rodada seguinte). A linha abaixo diz ao vigia que este instalador aceita o --autoatualizar (um commit
# anterior ao OP-B9 não a tem: o vigia faz como antes, só o programa do vigia):
# genesis-vigia-autoatualizar: 1
#
# Variáveis: GENESIS_PASTA (padrão /opt/genesis). Só para os testes: GENESIS_REPOSITORIO (um repositório local no
# lugar do público), GENESIS_SYSTEMD (padrão /etc/systemd/system) e GENESIS_GID_NGINX (padrão 101). Só o vigia:
# GENESIS_VIGIA_TRAVA=herdada (a trava dele já está presa no descritor 9).
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
# O commit cuja instalação foi aplicada por último, o resultado, quando e o sha256 do vigia-implantacao.sh instalado
# depois (o vigia o compara com o dele para saber se outro vigia o trocou: vigia-implantacao.sh › conferir_instalacao).
INSTALACAO=$VIGIA/instalacao
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
uso() { sed -n '6,9p' "$0" | sed 's/^# \{0,1\}//'; }

ACAO=instalar
COMMIT_AUTO=''
case "${1:-}" in
  '') ;;
  --estado) ACAO=estado ;;
  --desligar) ACAO=desligar ;;
  --autoatualizar)
    ACAO=autoatualizar
    COMMIT_AUTO=${2:-}
    [[ $COMMIT_AUTO =~ ^[0-9a-f]{40}$ ]] || {
      echo "--autoatualizar pede o commit implantado (40 hexadecimais): nada foi trocado" >&2
      exit 65
    }
    shift
    ;;
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

# conferir_unidades <pasta> [aviso]: o genesis-vigia.service e o genesis-vigia.timer da pasta têm o formato esperado
# (o serviço oneshot que roda o vigia instalado, com o KillMode=process; o timer dele, com o OnUnitInactiveSec e o
# WantedBy=timers.target, os mesmos nomes: nunca um segundo timer) e o systemd-analyze verify sai com 0 e sem aviso
# sobre eles (um aviso sobre outra unidade do sistema não conta). Volta 1 com o motivo na saída. Com "aviso" (a
# instalação à mão), a falta do systemd-analyze só avisa; na autoatualização, recusa.
conferir_unidades() {
  local d=$1 modo=${2:-} saida
  grep -qx '\[Service\]' "$d/$SERVICO" && grep -qx 'Type=oneshot' "$d/$SERVICO" &&
    grep -qxF 'ExecStart=/bin/bash /opt/genesis/vigia/vigia-implantacao.sh' "$d/$SERVICO" &&
    grep -qx 'KillMode=process' "$d/$SERVICO" || {
    echo "$SERVICO fora do formato esperado (o [Service] oneshot com ExecStart=/bin/bash /opt/genesis/vigia/vigia-implantacao.sh e KillMode=process)"
    return 1
  }
  grep -qx '\[Timer\]' "$d/$TIMER" && grep -qxF "Unit=$SERVICO" "$d/$TIMER" && grep -q '^OnUnitInactiveSec=' "$d/$TIMER" &&
    grep -qx '\[Install\]' "$d/$TIMER" && grep -qx 'WantedBy=timers.target' "$d/$TIMER" || {
    echo "$TIMER fora do formato esperado (o [Timer] com Unit=$SERVICO e OnUnitInactiveSec=, e o [Install] com WantedBy=timers.target)"
    return 1
  }
  if ! command -v systemd-analyze >/dev/null; then
    [ "$modo" = aviso ] || {
      echo "falta o systemd-analyze para conferir as unidades"
      return 1
    }
    aviso "falta o systemd-analyze: as unidades foram conferidas só pelo formato."
    return 0
  fi
  if ! saida=$(systemd-analyze verify "$d/$SERVICO" "$d/$TIMER" 2>&1) || grep -q 'genesis-vigia' <<<"$saida"; then
    # As linhas sobre as unidades do vigia primeiro: o systemd mais novo (Ubuntu 26.04) avisa antes sobre outras.
    echo "o systemd-analyze verify recusou as unidades: $({ grep -m 3 'genesis-vigia' <<<"$saida" || grep -m 3 . <<<"$saida"; } | tr '\n' ' ')"
    return 1
  fi
}

# A instalação aplicada (o commit, o resultado, quando e o sha256 do vigia-implantacao.sh instalado), por rename.
marcar_instalacao() {
  local temp
  temp=$(mktemp "$VIGIA/.instalacao.XXXXXX")
  printf '%s %s %s %s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(sha256sum "$VIGIA/vigia-implantacao.sh" 2>/dev/null | cut -d' ' -f1)" >"$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$INSTALACAO"
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
  echo "Instalação do vigia aplicada por último (commit, resultado, quando, sha256 do vigia; OP-B9):"
  cat "$INSTALACAO" 2>/dev/null || echo "(nenhuma registrada: a instalação é anterior ao OP-B9)"
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
  local item origem destino modo codigo mudou_unidade=0 conferir motivo
  conferir=$(mktemp -d "$VIGIA/.conferir.XXXXXX")
  for item in "$SERVICO" "$TIMER"; do
    git_repo show "refs/heads/main:infra/producao/vigia/$item" >"$conferir/$item" 2>/dev/null || {
      rm -rf "$conferir"
      erro "não foi possível ler infra/producao/vigia/$item da main de $REPOSITORIO; nada foi trocado. Tente de novo."
    }
  done
  motivo=$(conferir_unidades "$conferir" aviso) || {
    rm -rf "$conferir"
    erro "$motivo; nada foi trocado."
  }
  rm -rf "$conferir"
  for item in \
    "infra/producao/vigia/vigia-implantacao.sh|$VIGIA/vigia-implantacao.sh|700" \
    "infra/producao/implantar-sem-actions.sh|$VIGIA/implantar-sem-actions.sh|700" \
    "infra/producao/vigia/instalar-vigia.sh|$VIGIA/instalar-vigia.sh|700" \
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
  marcar_instalacao "$main" instalacao

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
  printf '\n\033[1;32mVigia da implantação instalado.\033[0m Estado: bash %s --estado. Desligar: bash %s --desligar.\n' \
    "$VIGIA/instalar-vigia.sh" "$VIGIA/instalar-vigia.sh"
}

# --- Autoatualização (OP-B9; D121; só o vigia chama) ---------------------------------------------------------------

# A pasta de trabalho da autoatualização (os arquivos novos lidos do clone) e os temporários ao lado dos destinos (as
# cópias novas e as ligações com os de antes); saem junto com o script. Um temporário que já foi renomeado para o
# destino não existe mais com esse nome: o rm não o alcança.
AUTO=''
declare -a TEMPS=()
declare -A NOVO=() ANTES=() DESTINO=()
limpar_auto() {
  [ -z "$AUTO" ] || rm -rf "$AUTO"
  [ "${#TEMPS[@]}" = 0 ] || rm -f "${TEMPS[@]}"
}

# ler_de <ref> <caminho no repositório> <destino>: o arquivo do clone do vigia. Volta 65 se ele não existe na ref ou
# (um .sh) não é um script bash válido, 69 se não veio (o clone é parcial: os arquivos vêm do repositório público).
ler_de() {
  local ref=$1 caminho=$2 destino=$3
  [ -n "$(git_repo ls-tree --name-only "$ref" -- "$caminho" 2>/dev/null)" ] || {
    echo "o commit ${ref:0:12} não tem $caminho"
    return 65
  }
  git_repo show "$ref:$caminho" >"$destino" 2>/dev/null || {
    echo "não foi possível ler $caminho de ${ref:0:12} do repositório público (rede da VPS ou o GitHub fora do ar?)"
    return 69
  }
  if [[ $caminho == *.sh ]]; then
    [ "$(head -c 19 "$destino")" = '#!/usr/bin/env bash' ] && bash -n "$destino" 2>/dev/null || {
      echo "$caminho de ${ref:0:12} não é um script bash válido"
      return 65
    }
  fi
}

# preparar <nome> <modo>: ao lado do destino (o mesmo sistema de arquivos), a cópia nova pronta para o rename e uma
# ligação (hard link) com o arquivo de agora, a de antes. Assim a troca e a volta são só renames, que não pedem espaço
# em disco: o disco que enche no meio não deixa a instalação pela metade. Volta 1 se não conseguiu (nada trocado).
preparar() {
  local nome=$1 modo=$2 destino=${DESTINO[$1]} temp
  temp=$(mktemp "$(dirname "$destino")/.genesis-vigia.XXXXXX") || return 1
  TEMPS+=("$temp")
  cp "$AUTO/novo/$nome" "$temp" && chmod "$modo" "$temp" || return 1
  NOVO[$nome]=$temp
  ANTES[$nome]=''
  [ -e "$destino" ] || return 0
  temp=$(mktemp "$(dirname "$destino")/.genesis-vigia.antes.XXXXXX") || return 1
  TEMPS+=("$temp")
  ln -f "$destino" "$temp" || return 1
  ANTES[$nome]=$temp
}
trocar() { mv -f "${NOVO[$1]}" "${DESTINO[$1]}"; }
# voltar <nome>: o de antes no lugar (o rename da ligação) ou, se não existia, o novo removido.
voltar() {
  if [ -n "${ANTES[$1]}" ]; then mv -f "${ANTES[$1]}" "${DESTINO[$1]}"; else rm -f "${DESTINO[$1]}"; fi
}

# O timer que estava ligado e parou no meio da troca: se continua habilitado, caiu (é falha); se não, o dono o
# desligou (--desligar, que não espera a trava): continua desligado.
timer_habilitado() { systemctl is-enabled --quiet "$TIMER" 2>/dev/null; }

# desfazer <ativo>: os arquivos de antes de volta (a troca falhou): os scripts e as unidades já trocados, o
# daemon-reload se uma unidade voltou e o timer religado se estava ligado, caiu e continua habilitado. Volta 1 se algo
# não voltou.
desfazer() {
  local nome ativo=$1 tudo=0
  for nome in "${TROCADOS[@]}"; do voltar "$nome" || tudo=1; done
  if [ "${#TROCADOS_UNIDADES[@]}" -gt 0 ]; then systemctl daemon-reload || tudo=1; fi
  if [ "$ativo" = 1 ] && ! systemctl is-active --quiet "$TIMER"; then
    if timer_habilitado; then
      systemctl restart "$TIMER" || tudo=1
    else
      echo "o $TIMER foi desligado durante a troca; continua desligado"
    fi
  fi
  if [ "$tudo" = 0 ]; then
    echo "os arquivos de antes voltaram (o vigia, a unidade e o timer como estavam)"
  else
    echo "ATENÇÃO: os arquivos de antes não voltaram por inteiro (o vigia tenta a instalação de novo na próxima rodada; o dono confere com bash $VIGIA/instalar-vigia.sh --estado)"
  fi
  return "$tudo"
}

# falhar <motivo> <ativo>: desfaz e sai com 1 (desfeita) ou 70 (não voltou por inteiro).
falhar() {
  echo "$1: nada fica trocado"
  desfazer "$2" || exit 70
  exit 1
}

autoatualizar() {
  local commit=$COMMIT_AUTO c nome item origem ref destino modo codigo ativo=0 desligado_no_meio=0
  [ "$(id -u)" = 0 ] || {
    echo "rode como root: nada foi trocado"
    exit 65
  }
  for c in git flock sha256sum systemctl; do
    command -v "$c" >/dev/null || {
      echo "falta o comando $c: nada foi trocado"
      exit 65
    }
  done
  [ -d "$REPO" ] && [ -d "$SYSTEMD" ] || {
    echo "o vigia não está instalado ($REPO, $SYSTEMD): nada foi trocado"
    exit 65
  }
  # A trava do vigia: herdada (o vigia já a segura no descritor 9) ou, à mão, a nossa.
  if [ "${GENESIS_VIGIA_TRAVA:-}" != herdada ]; then exec 9>"$TRAVA"; fi
  flock -n 9 2>/dev/null || {
    echo "a trava do vigia está ocupada (uma rodada no meio): nada foi trocado"
    exit 75
  }
  git_repo cat-file -e "$commit^{commit}" 2>/dev/null && git_repo merge-base --is-ancestor "$commit" refs/heads/main 2>/dev/null || {
    echo "o commit ${commit:0:12} não está na main do clone do vigia: nada foi trocado"
    exit 65
  }
  AUTO=$(mktemp -d "$VIGIA/.autoatualizar.XXXXXX")
  trap limpar_auto EXIT
  mkdir "$AUTO/novo"

  # Os cinco arquivos, todos lidos e conferidos antes de trocar qualquer um. A cópia do instalar-vigia.sh em
  # $VIGIA é a que o dono usa no --estado e no --desligar (a de ~ é a que o comando de instalar baixou e fica parada).
  local -a itens=(
    "$commit|infra/producao/vigia/$SERVICO|$SYSTEMD/$SERVICO|644"
    "$commit|infra/producao/vigia/$TIMER|$SYSTEMD/$TIMER|644"
    "$commit|infra/producao/vigia/vigia-implantacao.sh|$VIGIA/vigia-implantacao.sh|700"
    "refs/heads/main|infra/producao/implantar-sem-actions.sh|$VIGIA/implantar-sem-actions.sh|700"
    "$commit|infra/producao/vigia/instalar-vigia.sh|$VIGIA/instalar-vigia.sh|700"
  )
  for item in "${itens[@]}"; do
    IFS='|' read -r ref origem destino modo <<<"$item"
    codigo=0
    ler_de "$ref" "$origem" "$AUTO/novo/$(basename "$destino")" || codigo=$?
    [ "$codigo" = 0 ] || {
      echo "nada foi trocado"
      exit "$codigo"
    }
  done
  conferir_unidades "$AUTO/novo" || {
    echo "nada foi trocado: ficam o vigia, a unidade e o timer atuais"
    exit 65
  }

  # Só o que mudou (sha256), na ordem da lista: as unidades primeiro, depois os scripts. Tudo preparado ao lado do
  # destino antes de trocar o primeiro.
  local -a unidades=() scripts=()
  TROCADOS=()
  TROCADOS_UNIDADES=()
  for item in "${itens[@]}"; do
    IFS='|' read -r ref origem destino modo <<<"$item"
    nome=$(basename "$destino")
    [ -f "$destino" ] && [ "$(sha256sum <"$AUTO/novo/$nome")" = "$(sha256sum <"$destino")" ] && continue
    DESTINO[$nome]=$destino
    preparar "$nome" "$modo" || {
      echo "não foi possível preparar a cópia de $destino ao lado dele (o disco cheio?): nada foi trocado"
      exit 1
    }
    if [[ $destino == "$SYSTEMD"/* ]]; then unidades+=("$nome"); else scripts+=("$nome"); fi
  done

  # 1. As unidades: as novas por rename, o daemon-reload, o try-restart do timer que mudou (só se estava ligado: o
  # desligado pelo dono continua desligado) e a conferência de que o ligado continua ligado (ou foi desligado pelo
  # dono no meio: continua desligado).
  if [ "${#unidades[@]}" -gt 0 ]; then
    ! systemctl is-active --quiet "$TIMER" || ativo=1
    for nome in "${unidades[@]}"; do
      trocar "$nome" || falhar "não foi possível gravar ${DESTINO[$nome]}" "$ativo"
      TROCADOS+=("$nome")
      TROCADOS_UNIDADES+=("$nome")
    done
    systemctl daemon-reload || falhar "o systemctl daemon-reload falhou" "$ativo"
    if [ "$ativo" = 1 ] && [[ " ${unidades[*]} " == *" $TIMER "* ]] && ! systemctl try-restart "$TIMER"; then
      falhar "o systemctl try-restart $TIMER falhou" "$ativo"
    fi
    if [ "$ativo" = 1 ] && ! systemctl is-active --quiet "$TIMER"; then
      timer_habilitado && falhar "o $TIMER não ficou ligado depois da troca" "$ativo"
      desligado_no_meio=1
    fi
  fi

  # 2. Os scripts (o vigia em execução continua lendo o arquivo antigo). Um rename que falha desfaz tudo, as
  # unidades também.
  for nome in "${scripts[@]}"; do
    trocar "$nome" || falhar "não foi possível gravar ${DESTINO[$nome]}" "$ativo"
    TROCADOS+=("$nome")
  done

  # 3. O que as etapas 5 e 6 criam quando falta, sem mexer no que existe.
  [ -f "$JANELA" ] || (umask 077 && echo "$JANELA_PADRAO" >"$JANELA")
  for nome in "$JANELA" "$MAIN_TRATADOS" "$VIGIA/pdv-tratados"; do
    [ -f "$nome" ] || : >"$nome"
    chmod 600 "$nome"
  done
  mkdir -p "$PUBLICO"
  chgrp "$GID_NGINX" "$PUBLICO" 2>/dev/null || true
  chmod 750 "$PUBLICO"

  if [ "${#unidades[@]}" = 0 ] && [ "${#scripts[@]}" = 0 ]; then
    echo "nada mudou (o vigia, a cópia do implantar-sem-actions.sh, o instalar-vigia.sh, a unidade e o timer já eram os do commit ${commit:0:12})"
  else
    local recarga=''
    [ "${#unidades[@]}" = 0 ] || recarga="; daemon-reload"
    if [ "$desligado_no_meio" = 1 ]; then
      recarga="$recarga; o timer foi desligado durante a troca e continua desligado"
    elif [ "$ativo" = 1 ] && [[ " ${unidades[*]} " == *" $TIMER "* ]]; then
      recarga="$recarga; o timer reiniciado e ligado"
    fi
    [ "${#unidades[@]}" = 0 ] || [ "$ativo" = 1 ] || recarga="$recarga; o timer continua desligado"
    local -a trocados=("${unidades[@]}" "${scripts[@]}")
    echo "trocados com os do commit ${commit:0:12}: ${trocados[*]}$recarga"
  fi
}

case "$ACAO" in
  instalar) instalar ;;
  estado) estado ;;
  desligar) desligar ;;
  autoatualizar) autoatualizar ;;
esac
