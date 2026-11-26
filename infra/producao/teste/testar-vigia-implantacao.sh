#!/usr/bin/env bash
# Testes de unidade do vigia da implantação (OP-B4, OP-B7 e OP-B9; D70, D119 e D121; README de infra/producao › Vigia da
# implantação): o vigia-implantacao.sh e o instalar-vigia.sh, sem rede, sem systemd e sem root. Dublês de `id`,
# `systemctl` e `date` (a hora de Brasília controlada) no PATH,
# o `git` de verdade (com um dublê que só registra a chamada) sobre um repositório local no lugar do público, com as
# tags de pedido criadas nele, e o implantar-sem-actions.sh falso dentro desse repositório (o vigia copia o da main,
# como na VPS). Cobre: a instalação (arquivos da main, unidades, tags antigas vistas, timer ligado, pasta pública),
# a escolha do pedido (o mais novo, os anteriores pulados, nomes fora do padrão ignorados, tag anotada), pedido já
# visto não roda de novo, a trava ocupada (a do implantar.sh, a do implantar-sem-actions.sh e o código 75) = tenta na
# próxima rodada, a recusa de commit fora da main, o implantar-pdv/ com --publicar-pdv, a falha, o estado.json só
# com os campos permitidos (e as permissões), a autoatualização (só depois de um ok, só se mudou, commit sem o
# vigia), a implantação interrompida, sem rede, sem root, sem a lista de vistos, a reinstalação com o timer ligado e
# desligado, o --desligar e o --estado; e o `systemd-analyze verify` das unidades (pulado sem o systemd-analyze).
# A implantação automática da main (OP-B7): a ponta nova implantada uma vez só, a falha que não repete, a volta do dono
# que não é desfeita, a janela (16:59 roda, 17:00 e 23:59 esperam, 00:00 roda; configurável, com o formato
# conferido), a instalação com a versão no ar igual ou diferente da ponta, o PDV novo publicado sozinho (--so-pdv
# --tag=<tag>, sem commit: sem montar nem trocar a versão), o "nada a publicar" que não mexe no estado.json, a tag
# antes do release publicado (69) que espera sem mexer no estado.json e depois publica com o inicio da primeira
# tentativa, a falha passageira (1) que tenta de novo, o release inválido (65) que não repete, a tag manual com
# prioridade e fora da janela, a main antes do PDV, a implantação automática interrompida e a ponta que esperava como
# recebido e foi implantada pelo terminal (o estado.json termina como ok). A autoatualização completa (OP-B9; D121):
# a unidade e o timer que mudam no commit implantado, trocados por rename e recarregados (o timer ligado continua
# ligado); só o service mudado (o daemon-reload, sem o try-restart do timer); os iguais, sem nada regravado; o timer
# fora do formato e a unidade com aviso do systemd-analyze, recusados (também na instalação à mão), ficando as antigas
# e o vigia de antes; a troca que falha (o daemon-reload, o try-restart, o timer que cai, o rename de um script depois
# das unidades: o disco cheio), desfeita por inteiro, e a volta que também falha (pendente, refeita na rodada
# seguinte); o vigia desligado pelo dono, que continua desligado, também com o --desligar no meio da troca; a volta a
# um commit sem o --autoatualizar (só o programa, como antes), o merge seguinte pelo vigia antigo e a rodada que
# compara o sha256 do registro; o arquivo que não veio (pendente, tenta na rodada seguinte), também numa volta (refeita
# como depois do ok); a conferência com o commit no ar anterior ao OP-B9 (sem-autoatualizar, o vigia novo fica) e com a
# versão no ar fora da main (sem-commit); a cópia do instalar-vigia.sh em vigia/; a transição com o vigia do OP-B7 de
# verdade (o do e539ed0, quando o histórico o tem); nada no estado.json.
#
#   bash infra/producao/teste/testar-vigia-implantacao.sh
# Precisa de bash, git, jq, coreutils e util-linux (flock); roda sem root.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VIGIA_DIR=$AQUI/../vigia
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-vigia-teste.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/duble" "$T/systemd"
GIT_REAL=$(command -v git)
DATE_REAL=$(command -v date)
MV_REAL=$(command -v mv)
export GIT_REAL DATE_REAL MV_REAL
export DUBLE=$T/duble
export GENESIS_PASTA=$T/pasta
# file://, não o caminho: num clone local o git ignora o --filter=blob:none e copia todos os objetos; assim o clone é
# parcial como na VPS, e os arquivos (o implantar-sem-actions.sh, o vigia do commit) vêm sob demanda.
export GENESIS_REPOSITORIO=file://$T/remoto
export GENESIS_SYSTEMD=$T/systemd
GENESIS_GID_NGINX=$(id -g)
export GENESIS_GID_NGINX
# Git sem a configuração de quem roda (assinatura de commit e de tag, branch padrão...).
printf '[user]\n\tname = Teste\n\temail = teste@genesis.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n' >"$T/gitconfig"
export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublês -------------------------------------------------------------------------------------------------------
# Cada chamada vai para $DUBLE/ordem. Arquivos de controle em $DUBLE: uid (o `id -u`), timer-ativo (o
# `systemctl is-active`), hora (a hora "HH:MM" do `date +%H` do vigia, o horário de Brasília; o fuso pedido vai para
# $DUBLE/fuso), sem-actions-codigo (o código do implantar-sem-actions.sh falso), sem-actions-espera (ele espera o
# arquivo sumir, com sem-actions-esperando criado), so-pdv-codigo e so-pdv-sha (o --so-pdv falso: o código e o sha256
# que ele "publica" no atual.json da página, com qualquer código).
cat >"$T/bin/id" <<'DUBLE'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then cat "$DUBLE/uid" 2>/dev/null || echo 0; else exec /usr/bin/id "$@"; fi
DUBLE
# O systemctl falso da autoatualização (OP-B9): falha-daemon-reload e falha-try-restart (uma vez: o arquivo some) fazem
# o daemon-reload ou o try-restart falhar (o try-restart que falha deixa o timer desligado); timer-cai-no-try-restart
# deixa o timer desligado num try-restart que sai com 0; desligar-no-daemon-reload (uma vez) faz o que o --desligar do
# dono faz no mesmo instante do daemon-reload (o disable --now: o timer parado e desabilitado). try-restart, restart e
# start só ligam como o systemd: o try-restart só mexe no timer ligado. O is-enabled: habilitado sem
# timer-desabilitado (o disable o cria, o enable o apaga).
cat >"$T/bin/systemctl" <<'DUBLE'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$DUBLE/ordem"
case "$1" in
  is-active) [ -e "$DUBLE/timer-ativo" ] ;;
  is-enabled) [ ! -e "$DUBLE/timer-desabilitado" ] ;;
  enable)
    touch "$DUBLE/timer-ativo"
    rm -f "$DUBLE/timer-desabilitado"
    ;;
  disable)
    rm -f "$DUBLE/timer-ativo"
    touch "$DUBLE/timer-desabilitado"
    ;;
  daemon-reload)
    if [ -e "$DUBLE/desligar-no-daemon-reload" ]; then
      rm -f "$DUBLE/desligar-no-daemon-reload" "$DUBLE/timer-ativo"
      touch "$DUBLE/timer-desabilitado"
    fi
    if [ -e "$DUBLE/falha-daemon-reload" ]; then
      rm -f "$DUBLE/falha-daemon-reload"
      exit 1
    fi
    ;;
  try-restart)
    if [ -e "$DUBLE/falha-try-restart" ]; then
      rm -f "$DUBLE/falha-try-restart" "$DUBLE/timer-ativo"
      exit 1
    fi
    if [ -e "$DUBLE/timer-cai-no-try-restart" ]; then
      rm -f "$DUBLE/timer-cai-no-try-restart" "$DUBLE/timer-ativo"
    fi
    ;;
  restart | start) touch "$DUBLE/timer-ativo" ;;
  *) ;;
esac
DUBLE
# git: com $DUBLE/git-show-falha, o `git show` de um caminho que contém o texto dele falha (o arquivo que não veio
# do repositório público: a rede).
cat >"$T/bin/git" <<'DUBLE'
#!/usr/bin/env bash
printf 'git %s [prompt=%s]\n' "$*" "${GIT_TERMINAL_PROMPT:-}" >>"$DUBLE/ordem"
if [ -s "$DUBLE/git-show-falha" ] && [[ " $* " == *" show "* ]] && [[ $* == *"$(cat "$DUBLE/git-show-falha")"* ]]; then
  echo "fatal: dublê: sem rede" >&2
  exit 128
fi
exec "$GIT_REAL" "$@"
DUBLE
# mv: com $DUBLE/mv-falha, o rename de uma cópia nova da autoatualização (.genesis-vigia.*, não a de antes) para um
# destino que termina com o texto dele falha (o disco cheio, o sistema de arquivos com erro); com
# $DUBLE/mv-falha-desfazer, o da cópia de antes (.genesis-vigia.antes.*), a volta.
cat >"$T/bin/mv" <<'DUBLE'
#!/usr/bin/env bash
destino=${*: -1}
origem=${*: -2:1}
if [ -s "$DUBLE/mv-falha" ] && [[ $origem == */.genesis-vigia.* && $origem != */.genesis-vigia.antes.* ]] &&
  [[ $destino == *"$(cat "$DUBLE/mv-falha")" ]]; then
  echo "mv: dublê: sem espaço no disco" >&2
  exit 1
fi
if [ -s "$DUBLE/mv-falha-desfazer" ] && [[ $origem == */.genesis-vigia.antes.* ]] &&
  [[ $destino == *"$(cat "$DUBLE/mv-falha-desfazer")" ]]; then
  echo "mv: dublê: sem espaço no disco" >&2
  exit 1
fi
exec "$MV_REAL" "$@"
DUBLE
# Sem o systemd-analyze (fora do Ubuntu), um falso que aceita tudo: a autoatualização o exige; a conferência das
# unidades pelo systemd-analyze de verdade fica pulada (abaixo e no OP-B9).
if ! command -v systemd-analyze >/dev/null; then
  printf '#!/usr/bin/env bash\nexit 0\n' >"$T/bin/systemd-analyze"
  SEM_ANALYZE=1
else
  SEM_ANALYZE=0
  # O systemd do Ubuntu 26.04 avisa, no verify, sobre unidades do sistema que não são do vigia (o CPUAccounting=
  # removido, em xfs_scrub_all.service e walinuxagent.service no runner do GitHub). O dublê põe esses avisos antes da
  # saída do systemd-analyze de verdade, em qualquer Ubuntu: só o aviso sobre as unidades do vigia conta, e o motivo
  # da recusa tem de mostrá-lo mesmo depois deles.
  ANALYZE_REAL=$(command -v systemd-analyze)
  cat >"$T/bin/systemd-analyze" <<DUBLE
#!/usr/bin/env bash
if [ "\${1:-}" = verify ]; then
  for u in xfs_scrub_all.service system-xfs_scrub.slice walinuxagent.service; do
    echo "/usr/lib/systemd/system/\$u:26: Support for option CPUAccounting= has been removed and it is ignored" >&2
  done
fi
exec "$ANALYZE_REAL" "\$@"
DUBLE
fi
# date: o `+%H` (a hora da janela) vem de $DUBLE/hora (padrão 10:00, fora da janela); o resto, o date de verdade.
cat >"$T/bin/date" <<'DUBLE'
#!/usr/bin/env bash
if [ "$#" = 1 ] && [ "$1" = +%H ]; then
  printf '%s\n' "${TZ:-}" >"$DUBLE/fuso"
  h=$(cat "$DUBLE/hora" 2>/dev/null || echo 10:00)
  echo "${h%%:*}"
  exit 0
fi
exec "$DATE_REAL" "$@"
DUBLE
chmod +x "$T/bin"/*

# --- Repositório local no lugar do público ------------------------------------------------------------------------
# C1 sem o vigia (anterior ao OP-B4); C2 com o vigia, as unidades e o implantar-sem-actions.sh falso; C3 só no
# branch "outra"; C4 (o último da main) com o vigia mudado (uma linha de comentário a mais).
R=$T/remoto
g() { "$GIT_REAL" -C "$R" "$@"; }
"$GIT_REAL" init -q "$R"
g config uploadpack.allowFilter true
mkdir -p "$R/infra/producao/vigia"
echo 'primeiro' >"$R/LEIAME"
g add -A
g commit -q -m primeiro
C1=$(g rev-parse HEAD)
cp "$VIGIA_DIR/vigia-implantacao.sh" "$VIGIA_DIR/instalar-vigia.sh" "$VIGIA_DIR/genesis-vigia.service" \
  "$VIGIA_DIR/genesis-vigia.timer" "$R/infra/producao/vigia/"
cat >"$R/infra/producao/implantar-sem-actions.sh" <<'DUBLE'
#!/usr/bin/env bash
# implantar-sem-actions.sh falso (o vigia o copia da main). Implantado com sucesso, grava o versoes/atual como o
# implantar.sh; o --so-pdv "publica" o sha256 de $DUBLE/so-pdv-sha no atual.json da página (também quando sai com
# outro código: a página trocada e a URL que não respondeu depois) e sai com o código de $DUBLE/so-pdv-codigo.
printf 'implantar-sem-actions.sh %s [pasta=%s] [entrada=%s]\n' "$*" "$GENESIS_PASTA" "$(readlink /proc/$$/fd/0)" >>"$DUBLE/ordem"
echo "saída do implantar-sem-actions.sh de teste: $*"
if [ "${1:-}" = --so-pdv ]; then
  codigo=$(cat "$DUBLE/so-pdv-codigo" 2>/dev/null || echo 0)
  if [ -s "$DUBLE/so-pdv-sha" ]; then
    mkdir -p "$GENESIS_PASTA/download/pdv"
    printf '{\n  "versao": "0.0.0",\n  "sha256": "%s",\n  "publicado_em": "2026-11-25T00:00:00Z"\n}\n' "$(cat "$DUBLE/so-pdv-sha")" >"$GENESIS_PASTA/download/pdv/atual.json"
    rm -f "$DUBLE/so-pdv-sha"
  fi
  exit "$codigo"
fi
if [ -e "$DUBLE/sem-actions-espera" ]; then
  touch "$DUBLE/sem-actions-esperando"
  while [ -e "$DUBLE/sem-actions-espera" ]; do sleep 0.1; done
fi
codigo=$(cat "$DUBLE/sem-actions-codigo" 2>/dev/null || echo 0)
if [ "$codigo" = 0 ]; then
  mkdir -p "$GENESIS_PASTA/versoes"
  echo "${*: -1}" | cut -c1-12 >"$GENESIS_PASTA/versoes/atual"
fi
exit "$codigo"
DUBLE
g add -A
g commit -q -m 'segundo, com o vigia'
C2=$(g rev-parse HEAD)
g checkout -q -b outra
echo fora >"$R/FORA"
g add -A
g commit -q -m 'fora da main'
C3=$(g rev-parse HEAD)
g checkout -q main
echo '# linha nova do vigia (C4)' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
g add -A
g commit -q -m 'quarto, vigia mudado'
C4=$(g rev-parse HEAD)
# Pedido antigo, de antes da instalação.
g tag implantar/20261101-000000 "$C1"

export PATH=$T/bin:$PATH
INSTALAR=$VIGIA_DIR/instalar-vigia.sh
VIGIA=$GENESIS_PASTA/vigia
ESTADO=$GENESIS_PASTA/download/implantacao/estado.json

rodar() {
  : >"$DUBLE/ordem"
  CODIGO=0
  SAIDA=$(bash "$@" 2>&1) || CODIGO=$?
}
# Uma rodada do vigia instalado (o que o genesis-vigia.service roda).
rodada() { rodar "$VIGIA/vigia-implantacao.sh"; }
sucesso() { [ "$CODIGO" = 0 ] || falha "$1: saiu $CODIGO: $SAIDA"; }
recusa() {
  [ "$CODIGO" != 0 ] || falha "$1: deveria recusar (saiu 0): $SAIDA"
  grep -qF -- "$2" <<<"$SAIDA" || falha "$1: sem a mensagem '$2': $SAIDA"
}
chamou() { grep -qE -- "$1" "$DUBLE/ordem"; }
nao_implantou() { ! chamou '^implantar-sem-actions\.sh ' || falha "$1: não deveria implantar: $(grep '^implantar-sem-actions' "$DUBLE/ordem")"; }
implantou() {
  [ "$(grep -c '^implantar-sem-actions\.sh ' "$DUBLE/ordem")" = 1 ] || falha "$2: deveria implantar uma vez: $(cat "$DUBLE/ordem")"
  grep -qxF "implantar-sem-actions.sh $1 [pasta=$GENESIS_PASTA] [entrada=/dev/null]" "$DUBLE/ordem" ||
    falha "$2: chamada esperada 'implantar-sem-actions.sh $1': $(grep '^implantar-sem-actions' "$DUBLE/ordem")"
}
campo() { jq -r ".$1" "$ESTADO"; }
estado_e() {
  [ "$(campo pedido)" = "$1" ] && [ "$(campo commit)" = "${2:0:12}" ] && [ "$(campo resultado)" = "$3" ] ||
    falha "$4: estado.json esperado ($1, ${2:0:12}, $3): $(cat "$ESTADO" 2>/dev/null)"
}
resultado_visto() { awk -v p="$1" '$1 == p { r = $2 } END { print r }' "$VIGIA/vistos"; }

# --- Unidades do systemd ------------------------------------------------------------------------------------------
if [ "$SEM_ANALYZE" = 0 ]; then
  systemd-analyze verify "$VIGIA_DIR/genesis-vigia.service" "$VIGIA_DIR/genesis-vigia.timer" >"$T/verify" 2>&1 ||
    falha "systemd-analyze verify: $(cat "$T/verify")"
  # Como no instalar-vigia.sh: só conta o aviso sobre as unidades do vigia (os das outras unidades do sistema, não).
  grep -q 'CPUAccounting' "$T/verify" || falha "o dublê do systemd-analyze não pôs os avisos de outras unidades"
  ! grep -q 'genesis-vigia' "$T/verify" || falha "systemd-analyze verify com avisos: $(grep 'genesis-vigia' "$T/verify")"
  confere "unidades do systemd: systemd-analyze verify sem erros nem avisos sobre elas (com avisos de outras unidades)"
else
  printf '\033[1;33m-\033[0m systemd-analyze não instalado: verificação das unidades pulada\n'
fi
grep -qx 'ExecStart=/bin/bash /opt/genesis/vigia/vigia-implantacao.sh' "$VIGIA_DIR/genesis-vigia.service" &&
  grep -qx 'Type=oneshot' "$VIGIA_DIR/genesis-vigia.service" && grep -qx 'KillMode=process' "$VIGIA_DIR/genesis-vigia.service" &&
  grep -qx 'IOSchedulingClass=idle' "$VIGIA_DIR/genesis-vigia.service" && grep -qx 'OnUnitInactiveSec=2min' "$VIGIA_DIR/genesis-vigia.timer" ||
  falha "unidades sem o ExecStart, o oneshot, o KillMode=process, o idle ou os 2 minutos"
confere "serviço oneshot com prioridade baixa e KillMode=process (parar o vigia não para a implantação); timer de 2 minutos"

# --- Instalação ---------------------------------------------------------------------------------------------------
echo 1000 >"$DUBLE/uid"
rodar "$INSTALAR"
recusa "instalar sem root" "rode como root"
rodar "$INSTALAR" --opcao-errada
recusa "opção desconhecida" "opção desconhecida"
rm -f "$DUBLE/uid"

# A versão no ar é a ponta da main (C4): a instalação a dá como tratada (a implantação automática, mais abaixo).
mkdir -p "$GENESIS_PASTA/versoes"
echo "${C4:0:12}" >"$GENESIS_PASTA/versoes/atual"
rodar "$INSTALAR"
sucesso "instalação"
for f in vigia-implantacao.sh implantar-sem-actions.sh instalar-vigia.sh; do
  [ "$(stat -c %a "$VIGIA/$f")" = 700 ] || falha "$f instalado sem 700"
done
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C4:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "o vigia instalado não é o da main"
# A cópia do instalar-vigia.sh em vigia/ (a que o dono usa no --estado e no --desligar; a de ~ fica parada).
cmp -s "$VIGIA/instalar-vigia.sh" <(g show "$C4:infra/producao/vigia/instalar-vigia.sh") ||
  falha "a cópia do instalar-vigia.sh não é a da main"
grep -qF "Estado: bash $VIGIA/instalar-vigia.sh --estado. Desligar: bash $VIGIA/instalar-vigia.sh --desligar." <<<"$SAIDA" ||
  falha "o fim da instalação deveria apontar a cópia em vigia/: $(tail -n 1 <<<"$SAIDA")"
cmp -s "$VIGIA/implantar-sem-actions.sh" <(g show "$C4:infra/producao/implantar-sem-actions.sh") ||
  falha "o implantar-sem-actions.sh instalado não é o da main"
for f in genesis-vigia.service genesis-vigia.timer; do
  cmp -s "$GENESIS_SYSTEMD/$f" "$VIGIA_DIR/$f" || falha "$f não instalado"
  [ "$(stat -c %a "$GENESIS_SYSTEMD/$f")" = 644 ] || falha "$f sem 644"
done
[ "$(stat -c %a "$VIGIA")" = 700 ] || falha "pasta do vigia sem 700"
[ "$(stat -c %a:%g "$GENESIS_PASTA/download/implantacao")" = "750:$GENESIS_GID_NGINX" ] || falha "pasta pública sem 750 e o grupo do nginx"
[ "$(resultado_visto implantar/20261101-000000)" = visto-na-instalacao ] || falha "o pedido antigo não ficou como visto: $(cat "$VIGIA/vistos")"
grep -qx 'systemctl daemon-reload' "$DUBLE/ordem" && grep -qx "systemctl enable --now genesis-vigia.timer" "$DUBLE/ordem" ||
  falha "instalação sem o daemon-reload e o enable --now: $(grep systemctl "$DUBLE/ordem")"
# Todo git sem credencial nem pergunta (o repositório é público): -c credential.helper= e GIT_TERMINAL_PROMPT=0.
git_sem_credencial() {
  ! grep '^git ' "$DUBLE/ordem" | grep -qv '^git -c credential\.helper= .* \[prompt=0\]$' ||
    falha "$1: git com credencial ou pergunta: $(grep '^git ' "$DUBLE/ordem" | grep -v '^git -c credential\.helper= .* \[prompt=0\]$')"
}
git_sem_credencial "instalação"
grep -q "^git -c credential.helper= .*clone --quiet --bare --filter=blob:none --single-branch --branch main --no-tags" "$DUBLE/ordem" ||
  falha "clone sem as opções (bare, parcial, só a main, sem tags, sem credencial): $(grep '^git ' "$DUBLE/ordem")"
# O clone ficou parcial de verdade: promisor e arquivos que faltam (os que nenhum git show pediu).
[ "$("$GIT_REAL" --git-dir="$VIGIA/repo.git" config remote.origin.promisor)" = true ] || falha "repo.git sem o promisor"
GIT_NO_LAZY_FETCH=1 "$GIT_REAL" --git-dir="$VIGIA/repo.git" rev-list --objects --missing=print refs/heads/main | grep -q '^?' ||
  falha "repo.git com todos os arquivos: o clone deveria ser parcial (blob:none)"
rodada
sucesso "rodada depois da instalação"
nao_implantou "pedido antigo"
[ ! -e "$ESTADO" ] || falha "estado.json sem nenhum pedido atendido"
confere "instalação: arquivos da main (700/644), daemon-reload e timer ligado, pasta pública 750, git sem credencial, clone parcial; o pedido de antes da instalação não roda"

rodar "$INSTALAR"
sucesso "reinstalação"
[ "$(grep -c '(já estava na versão da main)' <<<"$SAIDA")" = 5 ] && ! grep -q '(atualizado)' <<<"$SAIDA" ||
  falha "reinstalação deveria manter os cinco arquivos (o vigia, o implantar-sem-actions.sh, o instalar-vigia.sh e as duas unidades): $SAIDA"
confere "reinstalação idempotente (nenhum dos cinco arquivos muda)"

# --- Pedido normal ------------------------------------------------------------------------------------------------
g tag implantar/20261124-100000 "$C2"
rodada
sucesso "pedido normal"
implantou "$C2" "pedido normal"
git_sem_credencial "rodada que implanta"
chamou '^git -c credential\.helper= ls-remote --heads --tags ' && chamou '^git -c credential\.helper= --git-dir=.* fetch --quiet --prune --no-tags ' ||
  falha "rodada sem o ls-remote --tags e o fetch --no-tags: $(grep '^git ' "$DUBLE/ordem")"
estado_e implantar/20261124-100000 "$C2" ok "pedido normal"
[ "$(jq -c 'keys' "$ESTADO")" = '["commit","fim","inicio","pedido","resultado"]' ] || falha "estado.json com outros campos: $(cat "$ESTADO")"
[[ $(campo inicio) =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] &&
  [[ $(campo fim) =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || falha "inicio/fim fora do formato: $(cat "$ESTADO")"
[ "$(stat -c %a:%g "$ESTADO")" = "640:$GENESIS_GID_NGINX" ] || falha "estado.json sem 640 e o grupo do nginx"
[ -z "$(find "$GENESIS_PASTA/download/implantacao" -name '.estado.*')" ] || falha "temporário do estado ficou na pasta pública"
grep -q 'saída do implantar-sem-actions.sh de teste' "$VIGIA/ultima-implantacao.log" || falha "sem a saída da chamada no log"
grep -q 'implantar/20261124-100000: ok' "$VIGIA/vigia.log" || falha "vigia.log sem o ok"
rodada
nao_implantou "o mesmo pedido de novo"
confere "pedido implantar/: chama o implantar-sem-actions.sh da main com o commit completo, sem terminal, e o git da rodada sem credencial (os arquivos sob demanda do clone parcial); estado.json só {pedido, commit (12), resultado, inicio, fim}, 640; não roda duas vezes"

# Autoatualização: o C2 tem o vigia sem a linha do C4 (o instalado é o do C4): depois do ok, o do C2.
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C2:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "depois do ok, o vigia deveria ser o do commit implantado (C2)"
grep -q "vigia atualizado com o do commit ${C2:0:12}" "$VIGIA/vigia.log" || falha "sem o registro da autoatualização"
confere "autoatualização: depois do ok, o vigia do commit implantado (por rename, com o registro)"

# --- Vários pedidos: o mais novo, com --publicar-pdv; os outros pulados; nomes fora do padrão ignorados ----------
g tag implantar/20261124-110000 "$C2"
g tag -a -m 'pedido anotado' implantar-pdv/20261124-120000 "$C4"
g tag implantar/2026112-1200 "$C4"
g tag implantar/20261124-130000-x "$C4"
g tag implantar-outro/20261124-140000 "$C4"
rodada
sucesso "vários pedidos"
implantou "--publicar-pdv $C4" "implantar-pdv/ anotado"
estado_e implantar-pdv/20261124-120000 "$C4" ok "vários pedidos"
[ "$(resultado_visto implantar/20261124-110000)" = pulado ] || falha "o pedido anterior deveria ficar como pulado"
grep -q '^implantar/2026112-1200 \|^implantar/20261124-130000-x \|^implantar-outro/' "$VIGIA/vistos" && falha "nomes fora do padrão não são pedidos"
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C4:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "depois do ok do C4, o vigia do C4"
confere "vários pedidos: só o mais novo (implantar-pdv/ → --publicar-pdv; tag anotada descascada até o commit), os anteriores pulados, nomes fora do padrão ignorados"

# Volta: um commit mais velho que o atual é permitido; sem o vigia no commit (C1), fica o atual.
g tag implantar/20261124-150000 "$C1"
cp "$VIGIA/vigia-implantacao.sh" "$T/vigia-antes"
rodada
implantou "$C1" "volta para o C1"
cmp -s "$VIGIA/vigia-implantacao.sh" "$T/vigia-antes" || falha "commit sem o vigia não deveria mexer no vigia instalado"
grep -q "o commit ${C1:0:12} não tem um vigia-implantacao.sh válido" "$VIGIA/vigia.log" || falha "sem o registro do commit sem vigia"
confere "volta para um commit mais velho: implanta; commit sem o vigia mantém o atual"

# --- Recusa: commit fora da main ----------------------------------------------------------------------------------
g tag implantar/20261124-160000 "$C3"
rodada
nao_implantou "commit fora da main"
estado_e implantar/20261124-160000 "$C3" recusado "commit fora da main"
[ "$(campo fim)" != null ] || falha "recusado sem o fim"
[ "$(resultado_visto implantar/20261124-160000)" = recusado ] || falha "recusado não ficou nos vistos"
grep -q "o commit $C3 não está na main" "$VIGIA/vigia.log" || falha "sem o motivo da recusa no log"
rodada
nao_implantou "recusado de novo"
confere "commit fora da main: recusado, sem chamar o implantar-sem-actions.sh, e não tenta de novo"

# --- Trava ocupada: tenta na próxima rodada -----------------------------------------------------------------------
g tag implantar/20261124-170000 "$C4"
for trava in .implantacao.lock .implantar-sem-actions.lock; do
  exec 8>"$GENESIS_PASTA/$trava"
  flock -n 8
  rodada
  sucesso "trava $trava ocupada"
  nao_implantou "trava $trava ocupada"
  estado_e implantar/20261124-170000 "$C4" recebido "trava $trava ocupada"
  [ "$(campo fim)" = null ] || falha "recebido com fim"
  exec 8>&-
done
# Um inicio fixo do passado (o "recebido"): com a resolução de segundo do agora(), sem isto o teste quase nunca
# falharia se a regra de manter o inicio quebrasse.
inicio=2026-01-01T00:00:00Z
sed -i "s/^  \"inicio\": \"[^\"]*\",\$/  \"inicio\": \"$inicio\",/" "$ESTADO"
[ "$(campo inicio)" = "$inicio" ] || falha "não foi possível fixar o inicio: $(cat "$ESTADO")"
[ "$(grep -c 'outra implantação em andamento' "$VIGIA/vigia.log")" = 1 ] || falha "a espera deveria ir ao log uma vez só"
echo 75 >"$DUBLE/sem-actions-codigo"
rodada
implantou "$C4" "código 75"
estado_e implantar/20261124-170000 "$C4" recebido "código 75 (a trava pega no mesmo instante)"
[ "$(campo inicio)" = "$inicio" ] || falha "código 75: o inicio deveria ser o do recebido ($inicio), não $(campo inicio)"
[ -z "$(resultado_visto implantar/20261124-170000)" ] || falha "código 75 não deveria marcar o pedido como visto"
rm -f "$DUBLE/sem-actions-codigo"
rodada
implantou "$C4" "depois da trava"
estado_e implantar/20261124-170000 "$C4" ok "depois da trava"
[ "$(campo inicio)" = "$inicio" ] || falha "o inicio deveria ser o do recebido ($inicio), não $(campo inicio)"
confere "trava ocupada (a do implantar.sh, a do implantar-sem-actions.sh e o código 75): fica recebido e roda na próxima rodada, com o mesmo inicio"

# --- Falha --------------------------------------------------------------------------------------------------------
echo 1 >"$DUBLE/sem-actions-codigo"
cp "$VIGIA/vigia-implantacao.sh" "$T/vigia-antes"
echo '# outra linha (C5)' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
g add -A
g commit -q -m 'quinto'
C5=$(g rev-parse HEAD)
g tag implantar/20261124-180000 "$C5"
rodada
implantou "$C5" "falha"
estado_e implantar/20261124-180000 "$C5" falhou "falha"
cmp -s "$VIGIA/vigia-implantacao.sh" "$T/vigia-antes" || falha "falha não deveria autoatualizar o vigia"
grep -q 'implantar/20261124-180000: falhou (código 1' "$VIGIA/vigia.log" || falha "sem a falha no log"
rm -f "$DUBLE/sem-actions-codigo"
rodada
nao_implantou "falhou não tenta de novo"
confere "falha: estado falhou, sem autoatualizar e sem tentar de novo (um pedido novo tenta)"

# --- Interrompida -------------------------------------------------------------------------------------------------
printf 'implantar/20261124-190000 %s 2026-11-24T19:00:00Z\n' "$C5" >"$VIGIA/em-andamento"
g tag implantar/20261124-190000 "$C5"
exec 8>"$GENESIS_PASTA/.implantar-sem-actions.lock"
flock -n 8
rodada
nao_implantou "interrompida ainda rodando"
[ -e "$VIGIA/em-andamento" ] || falha "com a implantação ainda rodando, o em-andamento fica"
exec 8>&-
rodada
nao_implantou "interrompida"
[ ! -e "$VIGIA/em-andamento" ] || falha "em-andamento ficou"
estado_e implantar/20261124-190000 "$C5" falhou "interrompida"
grep -q 'implantar/20261124-190000: falhou (interrompida' "$VIGIA/vigia.log" || falha "sem a interrompida no log"
confere "implantação interrompida (a VPS reiniciou): espera a que ainda roda; depois, falhou, sem rodar de novo"

# --- A rodada em andamento: outra rodada sai sem fazer nada; o vigia não se reescreve no lugar --------------------
g tag implantar/20261124-200000 "$C5"
touch "$DUBLE/sem-actions-espera"
bash "$VIGIA/vigia-implantacao.sh" >"$T/rodada1" 2>&1 &
pid=$!
for _ in $(seq 1 100); do [ -e "$DUBLE/sem-actions-esperando" ] && break; sleep 0.1; done
[ -e "$DUBLE/sem-actions-esperando" ] || falha "a rodada não chegou na implantação: $(cat "$T/rodada1")"
estado_e implantar/20261124-200000 "$C5" em_andamento "durante a implantação"
[ "$(campo fim)" = null ] || falha "em_andamento com fim"
inode=$(stat -c %i "$VIGIA/vigia-implantacao.sh")
SAIDA=$(bash "$VIGIA/vigia-implantacao.sh" 2>&1) || falha "a segunda rodada deveria sair com 0: $SAIDA"
[ -z "$SAIDA" ] || falha "a segunda rodada não deveria fazer nada: $SAIDA"
rm -f "$DUBLE/sem-actions-espera"
wait "$pid" || falha "a rodada da implantação falhou: $(cat "$T/rodada1")"
estado_e implantar/20261124-200000 "$C5" ok "depois da espera"
[ "$(stat -c %i "$VIGIA/vigia-implantacao.sh")" != "$inode" ] || falha "a autoatualização deveria trocar o arquivo por rename"
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C5:infra/producao/vigia/vigia-implantacao.sh") || falha "o vigia do C5"
rm -f "$DUBLE/sem-actions-esperando"
confere "rodada em andamento: a outra sai sem fazer nada; estado em_andamento (fim null) durante; autoatualização por rename"

# --- Sem rede, sem root, sem a lista dos vistos -------------------------------------------------------------------
g tag implantar/20261124-210000 "$C5"
GENESIS_REPOSITORIO=file://$T/nao-existe rodada
sucesso "sem rede (a rodada não falha: tenta na próxima)"
nao_implantou "sem rede"
GENESIS_REPOSITORIO=file://$T/nao-existe rodada
[ "$(grep -c 'sem resposta do repositório público' "$VIGIA/vigia.log")" = 1 ] || falha "sem rede deveria ir ao log uma vez só"
echo 1000 >"$DUBLE/uid"
rodada
recusa "rodada sem root" "rode como root"
rm -f "$DUBLE/uid"
mv "$VIGIA/vistos" "$T/vistos"
rodada
sucesso "sem a lista dos vistos"
nao_implantou "sem a lista dos vistos"
grep -q 'sem a lista dos pedidos vistos' "$VIGIA/vigia.log" || falha "sem o aviso da lista dos vistos"
mv "$T/vistos" "$VIGIA/vistos"
rodada
implantou "$C5" "rede de volta"
grep -q 'o repositório público voltou a responder' "$VIGIA/vigia.log" || falha "sem o registro da volta da rede"
confere "sem rede: tenta na próxima rodada (uma linha no log); sem root: recusa; sem a lista dos vistos: não implanta nada"

# --- Reinstalação com o timer ligado e desligado; --desligar e --estado -------------------------------------------
g tag implantar/20261124-220000 "$C5"
rodar "$INSTALAR"
sucesso "reinstalação com o timer ligado"
[ -z "$(resultado_visto implantar/20261124-220000)" ] || falha "com o timer ligado, o pedido pendente continua valendo"
# O pedido fica esperando a trava (o dono implanta pelo terminal) quando o vigia é desligado.
exec 8>"$GENESIS_PASTA/.implantacao.lock"
flock -n 8
rodada
estado_e implantar/20261124-220000 "$C5" recebido "pedido esperando a trava"
inicio=$(campo inicio)
exec 8>&-
rodar "$INSTALAR" --desligar
sucesso "--desligar"
grep -qx 'systemctl disable --now genesis-vigia.timer' "$DUBLE/ordem" || falha "--desligar sem o disable --now do timer"
grep -q 'stop genesis-vigia.service' "$DUBLE/ordem" && falha "--desligar não pode parar o serviço (a implantação em andamento)"
rodar "$INSTALAR" --estado
sucesso "--estado"
grep -q 'desligado' <<<"$SAIDA" && grep -q '"pedido": "implantar/20261124-220000"' <<<"$SAIDA" &&
  grep -q 'implantar/20261124-210000: ok' <<<"$SAIDA" || falha "--estado sem o timer, o estado.json e o log: $SAIDA"
rodar "$INSTALAR"
sucesso "reinstalação depois do --desligar"
[ "$(resultado_visto implantar/20261124-220000)" = visto-na-instalacao ] ||
  falha "o pedido pendente com o vigia desligado deveria ficar como visto na reinstalação"
# O estado público dele não fica "recebido" para sempre: recusado, com o fim e o mesmo inicio.
estado_e implantar/20261124-220000 "$C5" recusado "pedido que esperava, visto na reinstalação"
[[ $(campo fim) =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && [ "$(campo inicio)" = "$inicio" ] ||
  falha "recusado na reinstalação sem o fim ou com outro inicio: $(cat "$ESTADO")"
[ "$(jq -c 'keys' "$ESTADO")" = '["commit","fim","inicio","pedido","resultado"]' ] &&
  [ "$(stat -c %a:%g "$ESTADO")" = "640:$GENESIS_GID_NGINX" ] || falha "estado.json da reinstalação fora do formato: $(cat "$ESTADO")"
grep -q 'implantar/20261124-220000: recusado (estava como recebido' "$VIGIA/vigia.log" || falha "sem o motivo do recusado no log"
rodada
nao_implantou "pedido feito com o vigia desligado"
estado_e implantar/20261124-220000 "$C5" recusado "a rodada seguinte não mexe no recusado"
confere "reinstalação: com o timer ligado, o pendente vale; depois do --desligar (só o timer), os pedidos feitos no meio não rodam e o que esperava fica recusado no estado.json; --estado mostra"

# --- Lista dos vistos perdida com o timer ligado: a reinstalação não reimplanta o histórico --------------------------
[ -e "$DUBLE/timer-ativo" ] || falha "o timer deveria estar ligado depois da reinstalação"
cp "$ESTADO" "$T/estado-antes"
rm -f "$VIGIA/vistos"
rodada
nao_implantou "sem a lista, timer ligado"
rodar "$INSTALAR"
sucesso "reinstalação sem a lista dos vistos, timer ligado"
grep -q 'a lista dos pedidos vistos .* não existia' <<<"$SAIDA" || falha "sem o aviso da lista recriada: $SAIDA"
while IFS=$'\t' read -r _ ref; do
  nome=${ref#refs/tags/}
  [[ $nome =~ ^(implantar|implantar-pdv)/[0-9]{8}-[0-9]{6}$ ]] || continue
  [ "$(resultado_visto "$nome")" = visto-na-instalacao ] || falha "$nome deveria ficar como visto na reinstalação sem a lista"
done < <(g ls-remote --tags . | grep -v '\^{}$')
rodada
nao_implantou "tags antigas depois da lista recriada, timer ligado"
cmp -s "$ESTADO" "$T/estado-antes" || falha "o estado.json de um pedido já terminado não muda: $(cat "$ESTADO")"
confere "lista dos vistos perdida com o timer ligado: a reinstalação marca todas as tags como vistas; nenhum pedido antigo roda"

# --- Log aparado --------------------------------------------------------------------------------------------------
head -c 1100000 /dev/zero | tr '\0' 'x' | fold -w 100 >>"$VIGIA/vigia.log"
rodada
[ "$(stat -c %s "$VIGIA/vigia.log")" -le 1048576 ] || falha "o vigia.log deveria ser aparado"
confere "vigia.log aparado acima de 1 MB"

# --- Implantação automática da main (OP-B7; D119) ------------------------------------------------------------------
# A VPS do zero (o vigia reinstalado com o timer desligado: as tags que existem ficam como vistas), sobre o mesmo
# repositório. novo_commit = um merge na main (o vigia e o implantar-sem-actions.sh falso continuam nele).
novo_commit() {
  echo "$1" >>"$R/LEIAME"
  g add -A
  g commit -q -m "$1"
  g rev-parse HEAD
}
main_resultado() { awk -v c="$1" '$1 == c { print $2; exit }' "$VIGIA/main-tratados"; }
pdv_resultado() { awk -v t="$1" '$1 == t { r = $3 } END { print r }' "$VIGIA/pdv-tratados"; }
so_campos() {
  [ "$(jq -c 'keys' "$ESTADO")" = '["commit","fim","inicio","pedido","resultado"]' ] &&
    [ "$(stat -c %a:%g "$ESTADO")" = "640:$GENESIS_GID_NGINX" ] || falha "$1: estado.json fora do formato: $(cat "$ESTADO")"
}
reinstalar_do_zero() {
  rm -rf "$GENESIS_PASTA" "$DUBLE/timer-ativo"
  mkdir -p "$GENESIS_PASTA/versoes"
  echo "$1" >"$GENESIS_PASTA/versoes/atual"
  rodar "$INSTALAR"
  sucesso "instalação do zero (no ar: $1)"
}
rm -f "$DUBLE/hora" "$DUBLE/sem-actions-codigo"

# Instalação com a versão no ar igual à ponta (C5): tratada, nada a implantar.
reinstalar_do_zero "${C5:0:12}"
grep -q "a ponta da main ${C5:0:12} já é a versão no ar" <<<"$SAIDA" || falha "instalação sem o aviso da ponta no ar: $SAIDA"
[ "$(cat "$VIGIA/janela")" = 17-24 ] && [ "$(stat -c %a "$VIGIA/janela")" = 600 ] || falha "janela sem o padrão 17-24 ou sem 600"
[ "$(stat -c %a "$VIGIA/main-tratados")" = 600 ] || falha "main-tratados sem 600"
[ "$(main_resultado "$C5")" = no-ar-na-instalacao ] || falha "a ponta no ar deveria ficar tratada: $(cat "$VIGIA/main-tratados")"
rodada
sucesso "rodada com a ponta no ar"
nao_implantou "ponta já no ar"
confere "instalação com a versão no ar igual à ponta da main: tratada, nada implantado; janela padrão 17-24 (600)"

# Instalação com a versão no ar diferente (um merge depois dela): pendente, implantada fora da janela.
C6=$(novo_commit sexto)
reinstalar_do_zero "${C5:0:12}"
grep -q "a ponta da main ${C6:0:12} ainda não está no ar" <<<"$SAIDA" || falha "instalação sem o aviso da ponta pendente: $SAIDA"
[ -z "$(main_resultado "$C6")" ] || falha "a ponta fora do ar não deveria ficar tratada"
for hora in 17:00 23:59; do
  echo "$hora" >"$DUBLE/hora"
  rodada
  sucesso "janela às $hora"
  nao_implantou "dentro da janela ($hora)"
  estado_e main "$C6" recebido "dentro da janela ($hora)"
  [ "$(cat "$DUBLE/fuso")" = America/Sao_Paulo ] || falha "a janela deveria usar o horário de Brasília: TZ=$(cat "$DUBLE/fuso")"
done
[ "$(grep -c "main ${C6:0:12}: dentro da janela .*implanta a partir das 00:00" "$VIGIA/vigia.log")" = 1 ] ||
  falha "a espera da janela deveria ir ao log uma vez, com a hora prevista: $(cat "$VIGIA/vigia.log")"
so_campos "recebido na janela"
inicio=2026-01-01T00:00:00Z
sed -i "s/^  \"inicio\": \"[^\"]*\",\$/  \"inicio\": \"$inicio\",/" "$ESTADO"
echo 00:00 >"$DUBLE/hora"
rodada
implantou "$C6" "meia-noite"
estado_e main "$C6" ok "meia-noite"
[ "$(campo inicio)" = "$inicio" ] || falha "o inicio da main deveria ser o do recebido ($inicio), não $(campo inicio)"
so_campos "main ok"
[ "$(main_resultado "$C6")" = ok ] || falha "C6 deveria ficar ok nos tratados"
rodada
nao_implantou "a mesma ponta de novo"
confere "instalação com a versão no ar diferente da ponta: pendente; 17:00 e 23:59 esperam (recebido; a hora prevista no log, uma vez), 00:00 implanta a ponta (pedido main, o inicio do recebido); uma vez só"

C7=$(novo_commit setimo)
echo 16:59 >"$DUBLE/hora"
rodada
implantou "$C7" "16:59"
estado_e main "$C7" ok "16:59"
confere "16:59: fora da janela, implanta o merge novo"

# Falha não repete; o merge seguinte, sim.
C8=$(novo_commit oitavo)
echo 1 >"$DUBLE/sem-actions-codigo"
cp "$VIGIA/vigia-implantacao.sh" "$T/vigia-antes"
rodada
implantou "$C8" "main que falha"
estado_e main "$C8" falhou "main que falha"
[ "$(main_resultado "$C8")" = falhou ] || falha "C8 deveria ficar falhou nos tratados"
rm -f "$DUBLE/sem-actions-codigo"
rodada
nao_implantou "main que falhou não repete"
C9=$(novo_commit nono)
rodada
implantou "$C9" "merge depois da falha"
estado_e main "$C9" ok "merge depois da falha"
confere "a ponta que falhou não roda de novo sozinha; o merge seguinte, sim"

# A volta do dono (implantar.sh voltar: o versoes/atual muda para a anterior) não é desfeita.
echo "${C7:0:12}" >"$GENESIS_PASTA/versoes/atual"
rodada
nao_implantou "volta do dono"
confere "a volta do dono (implantar.sh voltar) não é desfeita: a ponta já foi tratada"

# Tag manual: na hora, fora da janela também, e o commit dela fica tratado na main.
C10=$(novo_commit decimo)
echo 18:00 >"$DUBLE/hora"
g tag implantar/20261125-010000 "$C10"
rodada
implantou "$C10" "tag manual dentro da janela"
estado_e implantar/20261125-010000 "$C10" ok "tag manual dentro da janela"
[ "$(main_resultado "$C10")" = ok ] || falha "o commit da tag manual deveria ficar tratado na main"
echo 00:00 >"$DUBLE/hora"
rodada
nao_implantou "a ponta que a tag manual implantou"
# A tag manual tem prioridade sobre a ponta nova na mesma rodada; a ponta vem na rodada seguinte.
C11=$(novo_commit decimo-primeiro)
g tag implantar/20261125-020000 "$C9"
rodada
implantou "$C9" "tag manual com a ponta nova pendente"
estado_e implantar/20261125-020000 "$C9" ok "tag manual primeiro"
rodada
implantou "$C11" "a ponta depois da tag manual"
estado_e main "$C11" ok "a ponta depois da tag manual"
confere "tag manual: roda na hora, dentro da janela também, tem prioridade sobre a ponta nova e deixa o commit dela tratado"

# Janela configurável (passando pela meia-noite) e fora do formato.
C12=$(novo_commit decimo-segundo)
echo 22-6 >"$VIGIA/janela"
echo 05:00 >"$DUBLE/hora"
rodada
nao_implantou "janela 22-6 às 05:00"
grep -q "main ${C12:0:12}: dentro da janela .*implanta a partir das 06:00" "$VIGIA/vigia.log" || falha "sem a hora prevista da janela 22-6"
echo 25-3 >"$VIGIA/janela"
echo 18:00 >"$DUBLE/hora"
rodada
nao_implantou "janela fora do formato às 18:00 (vale o padrão)"
grep -q "janela fora do formato em .* ('25-3'.*vale o padrão 17-24" "$VIGIA/vigia.log" || falha "sem o aviso da janela fora do formato"
echo 22-6 >"$VIGIA/janela"
echo 06:00 >"$DUBLE/hora"
rodada
implantou "$C12" "janela 22-6 às 06:00"
rodar "$INSTALAR" --estado
grep -q 'janela: das 22:00 às 06:00' <<<"$SAIDA" && grep -q "^$C12 ok " <<<"$SAIDA" || falha "--estado sem a janela e os commits tratados: $SAIDA"
echo 17-24 >"$VIGIA/janela"
echo 10:00 >"$DUBLE/hora"
confere "janela configurável (22-6 passa pela meia-noite: 05:00 espera, 06:00 implanta); fora do formato vale o padrão, com o aviso no log; --estado mostra"

# PDV: a tag pdv-vX.Y.Z de versão mais alta muda → --so-pdv --tag=<tag> (sem commit: nem montar nem trocar a versão).
g tag pdv-v0.13.0 "$C12"
cp "$ESTADO" "$T/estado-antes"
rodada
implantou "--so-pdv --tag=pdv-v0.13.0" "PDV: release já publicado"
cmp -s "$ESTADO" "$T/estado-antes" || falha "nada a publicar não deveria mexer no estado.json: $(cat "$ESTADO")"
[ "$(pdv_resultado pdv-v0.13.0)" = ok ] || falha "pdv-v0.13.0 deveria ficar tratado: $(cat "$VIGIA/pdv-tratados")"
grep -q 'pdv pdv-v0.13.0: nada a publicar' "$VIGIA/vigia.log" || falha "sem o nada a publicar no log"
rodada
nao_implantou "PDV já tratado"
g tag pdv-v0.9.9 "$C12"
rodada
nao_implantou "tag de versão menor (0.9.9 < 0.13.0)"
g tag -a -m 'release' pdv-v0.14.0 "$C12"
printf 'a%.0s' $(seq 1 64) >"$DUBLE/so-pdv-sha"
rodada
implantou "--so-pdv --tag=pdv-v0.14.0" "PDV novo"
estado_e pdv "$C12" ok "PDV novo (o commit da versão no ar)"
so_campos "pdv ok"
[ "$(campo fim)" != null ] || falha "pdv ok sem o fim"
[ "$(main_resultado "$C12")" = ok ] || falha "o PDV não muda os tratados da main"
[ "$(cat "$GENESIS_PASTA/versoes/atual")" = "${C12:0:12}" ] || falha "o --so-pdv não troca a versão"
confere "PDV novo (tag anotada) publicado sozinho com --so-pdv --tag=<tag>, sem commit; estado.json {pdv, versão no ar, ok}; o já publicado não mexe no estado.json; tag de versão menor não conta"

# A tag antes do release publicado (o publicar-release.sh e o workflow criam a tag, depois o rascunho, e só publicam
# depois de enviar o instalador): o --so-pdv --tag sai com 69. A tag não fica tratada e o estado.json não muda (o
# inicio e o fim fixos do passado: com a resolução de segundo do agora(), só o resultado não pegaria uma escrita).
# Publicado o release, a página muda e o estado.json fica ok com o inicio da primeira tentativa, não o da publicação
# do 0.14.0 (outro dia, a mesma versão no ar: o mesmo pedido e o mesmo commit).
sed -i -e 's/^  "inicio": "[^"]*",$/  "inicio": "2026-01-01T00:00:00Z",/' -e 's/^  "fim": "[^"]*"$/  "fim": "2026-01-01T00:05:00Z"/' "$ESTADO"
[ "$(campo inicio) $(campo fim)" = "2026-01-01T00:00:00Z 2026-01-01T00:05:00Z" ] || falha "não foi possível fixar o inicio e o fim: $(cat "$ESTADO")"
cp "$ESTADO" "$T/estado-antes"
g tag pdv-v0.15.0 "$C12"
echo 69 >"$DUBLE/so-pdv-codigo"
rodada
implantou "--so-pdv --tag=pdv-v0.15.0" "tag sem o release publicado"
[ -z "$(pdv_resultado pdv-v0.15.0)" ] || falha "o 69 não deveria marcar a tag"
cmp -s "$ESTADO" "$T/estado-antes" || falha "o 69 não escreve no estado.json: $(cat "$ESTADO")"
grep -q 'pdv pdv-v0.15.0: o GitHub não respondeu, o release está incompleto ou ainda não foi publicado; tenta de novo em 15 minutos' "$VIGIA/vigia.log" ||
  falha "sem a espera do 69 no log"
read -r _ tag_espera antes_espera _ <"$VIGIA/.pdv-espera"
[ "$tag_espera" = pdv-v0.15.0 ] && [ "$antes_espera" = "$(printf 'a%.0s' $(seq 1 64))" ] ||
  falha "a espera sem a tag ou o sha256 que a página servia: $(cat "$VIGIA/.pdv-espera")"
rm -f "$DUBLE/so-pdv-codigo"
rodada
nao_implantou "o 69: espera"
# O release publicado; a espera vencida, com o inicio da primeira tentativa fixo (o que tem de ir ao estado.json).
sed -i 's/^[0-9]* \(pdv-v0\.15\.0 [0-9a-f-]*\) .*$/0 \1 2026-02-02T00:00:00Z/' "$VIGIA/.pdv-espera"
printf 'b%.0s' $(seq 1 64) >"$DUBLE/so-pdv-sha"
rodada
implantou "--so-pdv --tag=pdv-v0.15.0" "o release da tag publicado"
estado_e pdv "$C12" ok "o release da tag publicado"
[ "$(campo inicio)" = 2026-02-02T00:00:00Z ] ||
  falha "o inicio do pdv deveria ser o da primeira tentativa desta tag (2026-02-02T00:00:00Z), não $(campo inicio)"
[ "$(pdv_resultado pdv-v0.15.0)" = ok ] && [ ! -e "$VIGIA/.pdv-espera" ] || falha "depois de publicado, pdv-v0.15.0 ok e sem a espera"
confere "tag antes do release publicado (69): não fica tratada, o estado.json não muda (nem o fim), espera $((900 / 60)) minutos; publicado, ok com o inicio da primeira tentativa (não o da publicação de outro dia na mesma versão no ar)"

# Falha passageira (código 1: o Docker, o espaço, a URL que não respondeu): tenta de novo, sem marcar a tag nem
# mexer no estado.json. Aqui a página já trocou (a URL falhou depois): a tentativa seguinte acha a página com o
# release ("nada a publicar" pelo sha256 de agora), mas o de antes da primeira tentativa diz que ela mudou: ok.
cp "$ESTADO" "$T/estado-antes"
g tag pdv-v0.16.0 "$C12"
echo 1 >"$DUBLE/so-pdv-codigo"
printf 'c%.0s' $(seq 1 64) >"$DUBLE/so-pdv-sha"
rodada
implantou "--so-pdv --tag=pdv-v0.16.0" "falha passageira"
[ -z "$(pdv_resultado pdv-v0.16.0)" ] || falha "a falha passageira (1) não deveria marcar a tag: $(cat "$VIGIA/pdv-tratados")"
cmp -s "$ESTADO" "$T/estado-antes" || falha "a falha passageira não escreve no estado.json: $(cat "$ESTADO")"
grep -q 'pdv pdv-v0.16.0: não publicou (código 1: .*tenta de novo em 15 minutos' "$VIGIA/vigia.log" || falha "sem a falha passageira no log"
rm -f "$DUBLE/so-pdv-codigo"
rodada
nao_implantou "falha passageira: espera"
sed -i 's/^[0-9]* /0 /' "$VIGIA/.pdv-espera"
rodada
implantou "--so-pdv --tag=pdv-v0.16.0" "falha passageira: de novo"
estado_e pdv "$C12" ok "falha passageira: a página trocou na primeira tentativa"
[ "$(pdv_resultado pdv-v0.16.0)" = ok ] || falha "depois da falha passageira, pdv-v0.16.0 ok"
confere "falha passageira do --so-pdv (1): não fica tratada nem mexe no estado.json; tenta de novo depois da espera, e a página trocada na primeira tentativa conta como ok"

# Release com arquivo inválido (65): falhou, não tenta de novo esta tag.
g tag pdv-v0.17.0 "$C12"
echo 65 >"$DUBLE/so-pdv-codigo"
rodada
implantou "--so-pdv --tag=pdv-v0.17.0" "release inválido"
estado_e pdv "$C12" falhou "release inválido"
[ "$(pdv_resultado pdv-v0.17.0)" = falhou ] || falha "release inválido deveria ficar tratado como falhou"
grep -q 'pdv pdv-v0.17.0: falhou (o release tem arquivo inválido' "$VIGIA/vigia.log" || falha "sem o arquivo inválido no log"
rm -f "$DUBLE/so-pdv-codigo"
rodada
nao_implantou "release inválido não repete"
confere "release com arquivo inválido (65): falhou, não tenta de novo"

g tag pdv-v0.18.0 "$C12"
echo 18:00 >"$DUBLE/hora"
rodada
nao_implantou "PDV dentro da janela"
echo 10:00 >"$DUBLE/hora"
rodada
implantou "--so-pdv --tag=pdv-v0.18.0" "PDV fora da janela"
# A main antes do PDV: o merge e o release novos na mesma rodada.
C13=$(novo_commit decimo-terceiro)
g tag pdv-v0.19.0 "$C13"
rodada
implantou "$C13" "main antes do PDV"
rodada
implantou "--so-pdv --tag=pdv-v0.19.0" "o PDV na rodada seguinte"
confere "PDV dentro da janela espera; a ponta nova da main vem antes do PDV, que roda na rodada seguinte"

# Implantação automática interrompida (a VPS reiniciou): espera a que ainda roda; depois, falhou, tratada.
C14=$(novo_commit decimo-quarto)
printf 'main %s 2026-11-25T03:00:00Z\n' "$C14" >"$VIGIA/em-andamento"
exec 8>"$GENESIS_PASTA/.implantar-sem-actions.lock"
flock -n 8
rodada
nao_implantou "main interrompida ainda rodando"
exec 8>&-
rodada
nao_implantou "main interrompida"
estado_e main "$C14" falhou "main interrompida"
[ "$(main_resultado "$C14")" = falhou ] || falha "a main interrompida deveria ficar tratada como falhou"
rodada
nao_implantou "main interrompida não repete"
confere "implantação automática interrompida: espera a que ainda roda; depois, falhou e tratada (não repete)"

# A ponta que ficou "recebido" (a trava presa: o dono implanta pelo terminal) e virou a versão no ar por fora do vigia:
# tratada sem implantar, e o estado.json termina (ok, com o fim e o mesmo inicio), em vez de ficar "recebido".
C15=$(novo_commit decimo-quinto)
exec 8>"$GENESIS_PASTA/.implantar-sem-actions.lock"
flock -n 8
rodada
nao_implantou "ponta com a trava presa"
estado_e main "$C15" recebido "ponta com a trava presa"
inicio=2026-01-01T00:00:00Z
sed -i "s/^  \"inicio\": \"[^\"]*\",\$/  \"inicio\": \"$inicio\",/" "$ESTADO"
echo "${C15:0:12}" >"$GENESIS_PASTA/versoes/atual"
exec 8>&-
rodada
nao_implantou "ponta implantada pelo terminal"
estado_e main "$C15" ok "ponta implantada pelo terminal"
[ "$(campo fim)" != null ] && [ "$(campo inicio)" = "$inicio" ] || falha "o ok da ponta já no ar sem o fim ou com outro inicio: $(cat "$ESTADO")"
so_campos "ponta já no ar"
[ "$(main_resultado "$C15")" = ja-no-ar ] || falha "a ponta já no ar deveria ficar ja-no-ar nos tratados"
grep -q "main: a ponta ${C15:0:12} já é a versão no ar (implantada fora do vigia)" "$VIGIA/vigia.log" || falha "sem o registro da ponta já no ar"
# Já no ar sem um "recebido" dela (a volta do dono, o merge seguinte ao do terminal): o estado.json não muda.
cp "$ESTADO" "$T/estado-antes"
C16=$(novo_commit decimo-sexto)
echo "${C16:0:12}" >"$GENESIS_PASTA/versoes/atual"
rodada
nao_implantou "ponta no ar sem recebido"
cmp -s "$ESTADO" "$T/estado-antes" || falha "a ponta já no ar sem recebido dela não mexe no estado.json: $(cat "$ESTADO")"
confere "a ponta que esperava como recebido e foi implantada pelo terminal: ja-no-ar, e o estado.json termina como ok (o mesmo inicio); sem o recebido dela, nada muda"

# --- O vigia se atualiza por inteiro (OP-B9; D121) ----------------------------------------------------------------
# O repositório "público" volta a ter os arquivos do vigia deste checkout (os scripts e as duas unidades); cada cenário
# muda o que precisa e faz um merge na main (novo_commit).
SYS=$GENESIS_SYSTEMD
SERVICO=genesis-vigia.service
TIMER=genesis-vigia.timer
arquivos_do_checkout() {
  cp "$VIGIA_DIR/vigia-implantacao.sh" "$VIGIA_DIR/instalar-vigia.sh" "$VIGIA_DIR/$SERVICO" "$VIGIA_DIR/$TIMER" \
    "$R/infra/producao/vigia/"
}
instalacao_e() {
  local c r
  read -r c r _ <"$VIGIA/instalacao"
  [ "$c" = "$1" ] && [ "$r" = "$2" ] || falha "$3: instalação esperada ($1 $2): $(cat "$VIGIA/instalacao")"
  [ "$(stat -c %a "$VIGIA/instalacao")" = 600 ] || falha "$3: o registro da instalação sem 600"
}
iguais_ao_commit() {
  local f
  cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$1:infra/producao/vigia/vigia-implantacao.sh") || falha "$2: o vigia não é o do commit ${1:0:12}"
  cmp -s "$VIGIA/instalar-vigia.sh" <(g show "$1:infra/producao/vigia/instalar-vigia.sh") || falha "$2: a cópia do instalar-vigia.sh não é a do commit ${1:0:12}"
  [ "$(stat -c %a "$VIGIA/instalar-vigia.sh")" = 700 ] || falha "$2: a cópia do instalar-vigia.sh sem 700"
  for f in $SERVICO $TIMER; do
    cmp -s "$SYS/$f" <(g show "$1:infra/producao/vigia/$f") || falha "$2: $f não é o do commit ${1:0:12}"
    [ "$(stat -c %a "$SYS/$f")" = 644 ] || falha "$2: $f sem 644"
  done
}
guardar_instalados() {
  rm -rf "${T:?}/antes"
  mkdir -p "$T/antes"
  cp -p "$VIGIA/vigia-implantacao.sh" "$VIGIA/instalar-vigia.sh" "$SYS/$SERVICO" "$SYS/$TIMER" "$T/antes/"
  stat -c %i "$SYS/$SERVICO" "$SYS/$TIMER" >"$T/antes/inodes"
}
nada_trocado() {
  local f
  for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "$1: $f não deveria mudar"; done
  cmp -s "$VIGIA/vigia-implantacao.sh" "$T/antes/vigia-implantacao.sh" || falha "$1: o vigia não deveria mudar"
  cmp -s "$VIGIA/instalar-vigia.sh" "$T/antes/instalar-vigia.sh" || falha "$1: a cópia do instalar-vigia.sh não deveria mudar"
  [ "$(stat -c %i "$SYS/$SERVICO" "$SYS/$TIMER")" = "$(cat "$T/antes/inodes")" ] || falha "$1: as unidades não deveriam ser regravadas"
}
sem_systemctl_de_troca() {
  ! grep -qE '^systemctl (daemon-reload|try-restart|restart|start|enable)' "$DUBLE/ordem" ||
    falha "$1: não deveria recarregar nem ligar nada: $(grep '^systemctl' "$DUBLE/ordem")"
}
sem_temporarios() {
  [ -z "$(find "$VIGIA" "$SYS" -name '.autoatualizar.*' -o -name '.genesis-vigia.*' -o -name '.instalar.*')" ] ||
    falha "$1: temporários da autoatualização ficaram: $(find "$VIGIA" "$SYS" -name '.autoatualizar.*' -o -name '.genesis-vigia.*' -o -name '.instalar.*')"
}
# O vigia de um commit anterior ao OP-B9 (o do OP-B7: troca só o programa depois de um ok e não conhece o
# vigia/instalacao): o do commit e539ed0 deste repositório quando o histórico o tem; senão, o deste checkout com a
# conferência da instalação, o --autoatualizar e o registro desligados.
RAIZ=$(cd "$AQUI/../../.." && pwd)
vigia_antigo() {
  if "$GIT_REAL" -C "$RAIZ" cat-file -e e539ed0:infra/producao/vigia/vigia-implantacao.sh 2>/dev/null; then
    "$GIT_REAL" -C "$RAIZ" show e539ed0:infra/producao/vigia/vigia-implantacao.sh >"$1"
  else
    sed -e 's/^conferir_instalacao() {$/conferir_instalacao() {\n  return 0/' \
      -e 's/^marcar_instalacao() {$/marcar_instalacao() {\n  return 0/' \
      -e 's/^  if \[ -n "$(git_repo ls-tree --name-only "$commit" -- infra\/producao\/vigia\/instalar-vigia.sh 2>\/dev\/null)" \]; then$/  if false; then/' \
      "$VIGIA_DIR/vigia-implantacao.sh" >"$1"
    [ "$(grep -c '^  return 0$\|^  if false; then$' "$1")" -ge 3 ] || falha "o vigia antigo simulado não desligou o OP-B9"
  fi
  bash -n "$1" || falha "o vigia antigo não é um script bash válido"
}
rm -f "$DUBLE/hora" "$DUBLE/sem-actions-codigo" "$DUBLE/timer-desabilitado"
touch "$DUBLE/timer-ativo"

# A instalação à mão (a reinstalação, com o timer ligado) registra o commit da main e o sha256 do vigia instalado.
rodar "$INSTALAR"
sucesso "reinstalação antes do OP-B9"
read -r c r _ sha <"$VIGIA/instalacao"
[ "$c $r" = "$C16 instalacao" ] && [ "$sha" = "$(sha256sum "$VIGIA/vigia-implantacao.sh" | cut -d' ' -f1)" ] ||
  falha "o registro da instalação à mão sem o commit da main, o resultado ou o sha256 do vigia: $(cat "$VIGIA/instalacao")"
grep -q 'Instalação do vigia aplicada por último' <(bash "$INSTALAR" --estado 2>&1) || falha "--estado sem a instalação aplicada"

# 1. A unidade e o timer que mudam no commit implantado: trocados (por rename) e recarregados; o timer, ligado.
arquivos_do_checkout
echo '# mudança de teste da unidade (OP-B9)' >>"$R/infra/producao/vigia/$SERVICO"
echo '# mudança de teste do timer (OP-B9)' >>"$R/infra/producao/vigia/$TIMER"
guardar_instalados
C17=$(novo_commit 'unidades mudadas')
rodada
implantou "$C17" "unidades mudadas"
estado_e main "$C17" ok "unidades mudadas"
so_campos "unidades mudadas"
iguais_ao_commit "$C17" "unidades mudadas"
[ "$(stat -c %i "$SYS/$SERVICO" "$SYS/$TIMER")" != "$(cat "$T/antes/inodes")" ] || falha "as unidades deveriam ser trocadas por rename"
grep -qx 'systemctl daemon-reload' "$DUBLE/ordem" && grep -qx "systemctl try-restart $TIMER" "$DUBLE/ordem" ||
  falha "unidades mudadas sem o daemon-reload e o try-restart do timer: $(grep '^systemctl' "$DUBLE/ordem")"
[ "$(grep -c "^systemctl try-restart $TIMER" "$DUBLE/ordem")" = 1 ] && ! grep -qE '^systemctl (enable|start|restart) ' "$DUBLE/ordem" ||
  falha "um try-restart só, sem ligar outro timer: $(grep '^systemctl' "$DUBLE/ordem")"
[ -e "$DUBLE/timer-ativo" ] || falha "o timer deveria continuar ligado"
instalacao_e "$C17" ok "unidades mudadas"
grep -qF "vigia atualizado com o do commit ${C17:0:12} (instalação completa, OP-B9): trocados com os do commit ${C17:0:12}: $SERVICO $TIMER vigia-implantacao.sh; daemon-reload; o timer reiniciado e ligado" "$VIGIA/vigia.log" ||
  falha "sem o registro da instalação completa: $(tail -n 3 "$VIGIA/vigia.log")"
sem_temporarios "unidades mudadas"
cp "$ESTADO" "$T/estado-antes"
rodada
nao_implantou "depois da instalação completa"
sem_systemctl_de_troca "a rodada seguinte"
cmp -s "$ESTADO" "$T/estado-antes" || falha "a autoatualização não escreve no estado.json"
confere "OP-B9: a unidade e o timer que mudam no commit implantado são trocados por rename, com o daemon-reload e um try-restart do timer ligado (que continua ligado); o registro em vigia/instalacao (600); nada no estado.json"

# 2. Os iguais não mexem em nada.
guardar_instalados
C18=$(novo_commit 'nada do vigia mudou')
rodada
implantou "$C18" "nada do vigia mudou"
nada_trocado "nada do vigia mudou"
sem_systemctl_de_troca "nada do vigia mudou"
instalacao_e "$C18" ok "nada do vigia mudou"
! grep -q "vigia atualizado com o do commit ${C18:0:12}" "$VIGIA/vigia.log" || falha "nada mudou não vai ao log"
confere "OP-B9: com o vigia, a unidade e o timer iguais aos do commit, nada é regravado nem recarregado"

# 2b. Só o genesis-vigia.service muda (o timer igual): o daemon-reload, sem o try-restart do timer, que continua ligado.
echo '# mudança de teste só da unidade (OP-B9)' >>"$R/infra/producao/vigia/$SERVICO"
C=$(novo_commit 'só a unidade mudada')
rodada
implantou "$C" "só a unidade mudada"
iguais_ao_commit "$C" "só a unidade mudada"
grep -qx 'systemctl daemon-reload' "$DUBLE/ordem" || falha "só a unidade mudada: sem o daemon-reload"
! grep -qE '^systemctl (try-restart|restart|start|enable)' "$DUBLE/ordem" ||
  falha "só a unidade mudada: o timer, que não mudou, não leva try-restart: $(grep '^systemctl' "$DUBLE/ordem")"
[ -e "$DUBLE/timer-ativo" ] || falha "só a unidade mudada: o timer deveria continuar ligado"
instalacao_e "$C" ok "só a unidade mudada"
grep -qxF "$(tail -n 1 "$VIGIA/vigia.log" | cut -d' ' -f1) vigia atualizado com o do commit ${C:0:12} (instalação completa, OP-B9): trocados com os do commit ${C:0:12}: $SERVICO; daemon-reload" "$VIGIA/vigia.log" ||
  falha "só a unidade mudada: a linha do log sem o timer reiniciado: $(tail -n 1 "$VIGIA/vigia.log")"
confere "OP-B9: só o genesis-vigia.service mudado: o daemon-reload, sem o try-restart do timer (que continua ligado), e a linha do log sem o timer reiniciado"

# 3. A unidade inválida é recusada e a antiga fica (o vigia novo do mesmo commit também não entra: tudo ou nada).
arquivos_do_checkout
echo '# mudança de teste da unidade (OP-B9)' >>"$R/infra/producao/vigia/$SERVICO"
echo '# mudança de teste do timer (OP-B9)' >>"$R/infra/producao/vigia/$TIMER"
sed -i 's/^OnUnitInactiveSec=.*$/OnBootSec=5min/' "$R/infra/producao/vigia/$TIMER"
echo '# vigia do commit com o timer fora do formato' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
guardar_instalados
C19=$(novo_commit 'timer fora do formato')
rodada
implantou "$C19" "timer fora do formato"
estado_e main "$C19" ok "timer fora do formato (a implantação continua ok)"
so_campos "timer fora do formato"
nada_trocado "timer fora do formato"
sem_systemctl_de_troca "timer fora do formato"
instalacao_e "$C19" recusado "timer fora do formato"
grep -qF "instalação do vigia do commit ${C19:0:12} recusada: $TIMER fora do formato esperado" "$VIGIA/vigia.log" ||
  falha "sem o motivo da recusa no vigia.log: $(tail -n 3 "$VIGIA/vigia.log")"
! grep -q 'formato' "$ESTADO" || falha "o motivo não vai ao estado.json"
cp "$ESTADO" "$T/estado-antes"
rodada
nao_implantou "depois da recusa"
sem_systemctl_de_troca "a recusa não repete a cada rodada"
cmp -s "$ESTADO" "$T/estado-antes" || falha "a recusa não escreve no estado.json"
instalacao_e "$C19" recusado "a recusa não repete"
# A instalação à mão também confere: com o timer fora do formato na main, recusa sem trocar nada.
rodar "$INSTALAR"
recusa "instalação à mão com o timer fora do formato" "fora do formato esperado"
nada_trocado "instalação à mão com o timer fora do formato"
if [ "$SEM_ANALYZE" = 0 ]; then
  # O formato certo e um aviso do systemd-analyze verify (a chave desconhecida, com saída 0): recusada também.
  arquivos_do_checkout
  sed -i 's/^Type=oneshot$/Type=oneshot\nChaveInventada=sim/' "$R/infra/producao/vigia/$SERVICO"
  C20=$(novo_commit 'unidade com aviso do systemd-analyze')
  rodada
  implantou "$C20" "unidade com aviso"
  estado_e main "$C20" ok "unidade com aviso"
  nada_trocado "unidade com aviso"
  instalacao_e "$C20" recusado "unidade com aviso"
  grep -q "instalação do vigia do commit ${C20:0:12} recusada: o systemd-analyze verify recusou as unidades: .*ChaveInventada" "$VIGIA/vigia.log" ||
    falha "sem o aviso do systemd-analyze no vigia.log: $(tail -n 3 "$VIGIA/vigia.log")"
  confere "OP-B9: unidade com aviso do systemd-analyze verify (saída 0) recusada; ficam as antigas"
fi
confere "OP-B9: o timer fora do formato é recusado (também na instalação à mão): ficam a unidade, o timer e o vigia antigos, a implantação continua ok, o motivo só no vigia.log, e não repete a cada rodada"

# 4. A troca que falha é desfeita: o daemon-reload que falha, o try-restart que falha (o timer cai) e o timer que não
# fica ligado.
for caso in falha-daemon-reload falha-try-restart timer-cai-no-try-restart; do
  arquivos_do_checkout
  echo "# mudança de teste do timer ($caso)" >>"$R/infra/producao/vigia/$TIMER"
  echo "# vigia do commit ($caso)" >>"$R/infra/producao/vigia/vigia-implantacao.sh"
  guardar_instalados
  C=$(novo_commit "troca que falha: $caso")
  touch "$DUBLE/$caso"
  rodada
  implantou "$C" "troca que falha ($caso)"
  estado_e main "$C" ok "troca que falha ($caso)"
  for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "$caso: $f deveria voltar ao de antes"; done
  cmp -s "$VIGIA/vigia-implantacao.sh" "$T/antes/vigia-implantacao.sh" || falha "$caso: o vigia não deveria mudar"
  [ -e "$DUBLE/timer-ativo" ] || falha "$caso: o timer deveria ficar ligado depois de desfeito"
  instalacao_e "$C" falhou "troca que falha ($caso)"
  grep -q "instalação do vigia do commit ${C:0:12} falhou (código 1): .*os arquivos de antes voltaram" "$VIGIA/vigia.log" ||
    falha "$caso: sem a troca desfeita no vigia.log: $(tail -n 3 "$VIGIA/vigia.log")"
  [ "$(grep -c '^systemctl daemon-reload' "$DUBLE/ordem")" = 2 ] || falha "$caso: um daemon-reload na troca e outro ao desfazer: $(grep '^systemctl' "$DUBLE/ordem")"
  if [ "$caso" = falha-daemon-reload ]; then
    ! grep -qE '^systemctl (try-restart|restart)' "$DUBLE/ordem" || falha "$caso: o timer ligado não precisa de restart"
  else
    [ "$(grep -c "^systemctl restart $TIMER" "$DUBLE/ordem")" = 1 ] || falha "$caso: o timer que caiu é religado uma vez: $(grep '^systemctl' "$DUBLE/ordem")"
  fi
  rm -f "${DUBLE:?}/${caso:?}"
done
confere "OP-B9: a troca que falha (o daemon-reload, o try-restart, o timer que não fica ligado) é desfeita: as unidades de antes voltam, o timer fica ligado (religado uma vez se caiu), o vigia não muda, a implantação continua ok"

# 4b. O rename de um script que falha depois das unidades trocadas (o disco cheio): tudo volta, as unidades também
# (as cópias e as ligações com os de antes preparadas antes da troca: a volta é só rename); e a volta que também falha
# (70): "pendente", e a rodada seguinte refaz a instalação inteira.
arquivos_do_checkout
echo '# mudança de teste do timer (o script que falha)' >>"$R/infra/producao/vigia/$TIMER"
echo '# vigia do commit (o script que falha)' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
echo '# instalador do commit (o script que falha)' >>"$R/infra/producao/vigia/instalar-vigia.sh"
guardar_instalados
C=$(novo_commit 'o rename do script que falha')
echo /instalar-vigia.sh >"$DUBLE/mv-falha"
rodada
rm -f "$DUBLE/mv-falha"
implantou "$C" "o rename do script que falha"
estado_e main "$C" ok "o rename do script que falha"
nada_trocado "o rename do script que falha"
[ -e "$DUBLE/timer-ativo" ] || falha "o rename do script que falha: o timer deveria continuar ligado"
[ "$(grep -c '^systemctl daemon-reload' "$DUBLE/ordem")" = 2 ] && ! grep -qE '^systemctl (restart|start|enable)' "$DUBLE/ordem" ||
  falha "o rename do script que falha: um daemon-reload na troca e outro ao desfazer, sem religar: $(grep '^systemctl' "$DUBLE/ordem")"
instalacao_e "$C" falhou "o rename do script que falha"
grep -q "instalação do vigia do commit ${C:0:12} falhou (código 1): .*não foi possível gravar $VIGIA/instalar-vigia.sh: nada fica trocado os arquivos de antes voltaram" "$VIGIA/vigia.log" ||
  falha "o rename do script que falha: sem a troca desfeita no vigia.log: $(tail -n 2 "$VIGIA/vigia.log")"
sem_temporarios "o rename do script que falha"
rodada
nao_implantou "depois do rename que falha"
sem_systemctl_de_troca "o falhou com tudo de volta não repete a cada rodada"
arquivos_do_checkout
echo '# mudança de teste do timer (a volta que falha)' >>"$R/infra/producao/vigia/$TIMER"
echo '# vigia do commit (a volta que falha)' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
echo '# instalador do commit (a volta que falha)' >>"$R/infra/producao/vigia/instalar-vigia.sh"
guardar_instalados
C=$(novo_commit 'a volta que falha')
echo /instalar-vigia.sh >"$DUBLE/mv-falha"
echo /vigia-implantacao.sh >"$DUBLE/mv-falha-desfazer"
rodada
rm -f "$DUBLE/mv-falha" "$DUBLE/mv-falha-desfazer"
implantou "$C" "a volta que falha"
estado_e main "$C" ok "a volta que falha"
for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "a volta que falha: $f deveria voltar ao de antes"; done
instalacao_e "$C" pendente "a volta que falha"
grep -q "instalação do vigia do commit ${C:0:12}: .*não foi possível gravar $VIGIA/instalar-vigia.sh: nada fica trocado .*ATENÇÃO: os arquivos de antes não voltaram por inteiro" "$VIGIA/vigia.log" ||
  falha "a volta que falha: sem o registro no vigia.log: $(tail -n 2 "$VIGIA/vigia.log")"
sem_temporarios "a volta que falha"
rodada
nao_implantou "a volta que falha, a rodada seguinte"
iguais_ao_commit "$C" "a volta que falha, a rodada seguinte"
instalacao_e "$C" ok "a volta que falha, a rodada seguinte"
[ -e "$DUBLE/timer-ativo" ] || falha "a volta que falha: o timer deveria continuar ligado"
confere "OP-B9: o rename de um script que falha depois das unidades trocadas desfaz tudo (as unidades também; só renames, sem pedir espaço) e não repete; a volta que também falha fica pendente (70), e a rodada seguinte aplica a instalação inteira"

# 5. O --desligar do dono é respeitado: com o timer desligado (no meio da rodada), a troca não o liga.
arquivos_do_checkout
echo '# mudança de teste do timer (desligado)' >>"$R/infra/producao/vigia/$TIMER"
C21=$(novo_commit 'timer mudado com o vigia desligado')
rm -f "$DUBLE/timer-ativo"
rodada
implantou "$C21" "vigia desligado"
iguais_ao_commit "$C21" "vigia desligado"
grep -qx 'systemctl daemon-reload' "$DUBLE/ordem" || falha "vigia desligado: as unidades novas com o daemon-reload"
! grep -qE '^systemctl (try-restart|restart|start|enable)' "$DUBLE/ordem" && [ ! -e "$DUBLE/timer-ativo" ] ||
  falha "o vigia desligado pelo dono deveria continuar desligado: $(grep '^systemctl' "$DUBLE/ordem")"
instalacao_e "$C21" ok "vigia desligado"
grep -q "vigia atualizado com o do commit ${C21:0:12} .*o timer continua desligado" "$VIGIA/vigia.log" || falha "sem o timer desligado no log"
touch "$DUBLE/timer-ativo"
confere "OP-B9: o vigia desligado pelo dono (--desligar) continua desligado depois da troca (daemon-reload, sem try-restart, enable nem start)"

# 5b. O dono desliga (--desligar, que não espera a trava) no meio da troca, com o timer ligado no começo: a troca vale e
# o timer continua desligado, sem restart; com a troca que falha no mesmo instante, as de antes voltam, também sem
# religar.
for caso in sem-falha falha-daemon-reload; do
  arquivos_do_checkout
  echo "# mudança de teste do timer (desligado no meio, $caso)" >>"$R/infra/producao/vigia/$TIMER"
  guardar_instalados
  C=$(novo_commit "desligado no meio da troca: $caso")
  touch "$DUBLE/timer-ativo" "$DUBLE/desligar-no-daemon-reload"
  [ "$caso" = sem-falha ] || touch "$DUBLE/$caso"
  rodada
  rm -f "$DUBLE/desligar-no-daemon-reload" "$DUBLE/falha-daemon-reload"
  implantou "$C" "desligado no meio ($caso)"
  [ ! -e "$DUBLE/timer-ativo" ] && ! grep -qE '^systemctl (restart|start|enable)' "$DUBLE/ordem" ||
    falha "desligado no meio ($caso): o timer desligado pelo dono deveria continuar desligado: $(grep '^systemctl' "$DUBLE/ordem")"
  if [ "$caso" = sem-falha ]; then
    iguais_ao_commit "$C" "desligado no meio"
    instalacao_e "$C" ok "desligado no meio"
    grep -q "vigia atualizado com o do commit ${C:0:12} .*o timer foi desligado durante a troca e continua desligado" "$VIGIA/vigia.log" ||
      falha "desligado no meio: sem o registro no log: $(tail -n 1 "$VIGIA/vigia.log")"
  else
    for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "desligado no meio ($caso): $f deveria voltar ao de antes"; done
    instalacao_e "$C" falhou "desligado no meio ($caso)"
    grep -q "instalação do vigia do commit ${C:0:12} falhou (código 1): .*o $TIMER foi desligado durante a troca; continua desligado" "$VIGIA/vigia.log" ||
      falha "desligado no meio ($caso): sem o registro no log: $(tail -n 1 "$VIGIA/vigia.log")"
  fi
done
rm -f "$DUBLE/timer-desabilitado"
touch "$DUBLE/timer-ativo"
confere "OP-B9: o --desligar do dono no meio da troca é respeitado: o timer continua desligado (sem restart), com a troca feita ou, se ela falhou no mesmo instante, desfeita"

# 6. A volta a um commit cujo instalar-vigia.sh não tem o --autoatualizar (anterior ao OP-B9, com o vigia do OP-B7):
# como antes, só o programa do vigia; a unidade e o timer instalados ficam.
arquivos_do_checkout
sed -i '/^# genesis-vigia-autoatualizar: 1$/d' "$R/infra/producao/vigia/instalar-vigia.sh"
echo '# mudança de teste do timer (sem o --autoatualizar)' >>"$R/infra/producao/vigia/$TIMER"
vigia_antigo "$R/infra/producao/vigia/vigia-implantacao.sh"
echo '# vigia de um commit anterior ao OP-B9' >>"$R/infra/producao/vigia/vigia-implantacao.sh"
C22=$(novo_commit 'commit sem o --autoatualizar')
arquivos_do_checkout
C23=$(novo_commit 'a main de volta com o OP-B9')
echo "${C23:0:12}" >"$GENESIS_PASTA/versoes/atual"
rodada
nao_implantou "a ponta já no ar"
guardar_instalados
g tag implantar/20261125-030000 "$C22"
rodada
implantou "$C22" "volta a um commit sem o --autoatualizar"
estado_e implantar/20261125-030000 "$C22" ok "volta a um commit sem o --autoatualizar"
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C22:infra/producao/vigia/vigia-implantacao.sh") || falha "volta: o vigia do commit, como antes"
for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "volta: $f não deveria mudar"; done
sem_systemctl_de_troca "volta a um commit sem o --autoatualizar"
instalacao_e "$C22" sem-autoatualizar "volta a um commit sem o --autoatualizar"
grep -q "só o programa do vigia: o commit é anterior ao OP-B9" "$VIGIA/vigia.log" || falha "volta: sem o registro no log"
rodada
nao_implantou "depois da volta"
sem_systemctl_de_troca "depois da volta (a instalação não é desfeita nem refeita)"
instalacao_e "$C22" sem-autoatualizar "depois da volta"
# O merge seguinte, com o OP-B9 de novo e a unidade e o timer mudados: o vigia antigo instalado pela volta o implanta e
# troca só o programa, sem tocar no registro da volta (o sha256 dele é o do vigia antigo); a rodada seguinte, já com o
# vigia novo, vê o sha256 do registro diferente do dele e aplica a instalação completa.
cp "$VIGIA/instalacao" "$T/instalacao-da-volta"
arquivos_do_checkout
echo '# mudança de teste do timer (depois da volta)' >>"$R/infra/producao/vigia/$TIMER"
echo '# mudança de teste da unidade (depois da volta)' >>"$R/infra/producao/vigia/$SERVICO"
C24=$(novo_commit 'merge depois da volta')
rodada
implantou "$C24" "merge depois da volta (o vigia antigo)"
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C24:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "merge depois da volta: o vigia antigo troca o programa pelo do commit"
for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "merge depois da volta: o vigia antigo não mexe em $f"; done
cmp -s "$VIGIA/instalacao" "$T/instalacao-da-volta" || falha "merge depois da volta: o vigia antigo não mexe no registro: $(cat "$VIGIA/instalacao")"
read -r _ _ _ sha <"$VIGIA/instalacao"
[ "$sha" != "$(sha256sum "$VIGIA/vigia-implantacao.sh" | cut -d' ' -f1)" ] || falha "merge depois da volta: o sha256 do registro deveria ser o do vigia antigo"
rodada
nao_implantou "merge depois da volta (o vigia novo)"
iguais_ao_commit "$C24" "merge depois da volta"
grep -qx "systemctl try-restart $TIMER" "$DUBLE/ordem" || falha "merge depois da volta: sem o try-restart do timer mudado"
instalacao_e "$C24" ok "merge depois da volta"
grep -q "instalação do vigia: o vigia instalado não é o da última instalação completa .*aplica a do commit no ar ${C24:0:12}" "$VIGIA/vigia.log" ||
  falha "merge depois da volta: sem o registro no log: $(tail -n 3 "$VIGIA/vigia.log")"
rodada
sem_systemctl_de_troca "merge depois da volta: a rodada seguinte"
confere "OP-B9: a volta a um commit sem o --autoatualizar só troca o programa do vigia (como antes), não mexe na unidade nem no timer e não é refeita a cada rodada; no merge seguinte, o vigia antigo troca só o programa e a rodada seguinte (o sha256 do registro não é o do vigia instalado) aplica a instalação completa"

# 7. O arquivo que não veio (a rede): pendente, uma linha no log, e a rodada seguinte tenta de novo.
arquivos_do_checkout
echo '# mudança de teste do timer (pendente)' >>"$R/infra/producao/vigia/$TIMER"
guardar_instalados
C25=$(novo_commit 'instalação pendente')
echo 'instalar-vigia.sh' >"$DUBLE/git-show-falha"
rodada
implantou "$C25" "instalação pendente"
estado_e main "$C25" ok "instalação pendente"
nada_trocado "instalação pendente"
instalacao_e "$C25" pendente "instalação pendente"
rodada
nada_trocado "pendente, ainda sem rede"
[ "$(grep -c "instalação do vigia do commit ${C25:0:12}: o instalar-vigia.sh não veio" "$VIGIA/vigia.log")" = 1 ] ||
  falha "a espera da rede deveria ir ao log uma vez só"
echo "$TIMER" >"$DUBLE/git-show-falha"
rodada
nada_trocado "pendente, a unidade sem rede"
instalacao_e "$C25" pendente "pendente, a unidade sem rede"
rm -f "$DUBLE/git-show-falha"
cp "$ESTADO" "$T/estado-antes"
rodada
nao_implantou "pendente com a rede de volta"
iguais_ao_commit "$C25" "pendente com a rede de volta"
instalacao_e "$C25" ok "pendente com a rede de volta"
cmp -s "$ESTADO" "$T/estado-antes" || falha "a instalação pendente não escreve no estado.json"
confere "OP-B9: o arquivo que não vem do repositório (a rede) deixa a instalação pendente, nada trocado, uma linha no log; com a rede de volta, a rodada seguinte a aplica"

# 8. A transição: o vigia do OP-B7 instalado (o que o dono reinstala depois do PR-16b) implanta o primeiro commit com
# o OP-B9 e troca só o programa; a rodada seguinte, já com o vigia novo, aplica a instalação completa do commit no ar,
# sem comando do dono. Com o vigia do OP-B7 de verdade (o do commit e539ed0 deste repositório) quando o histórico o
# tem; senão, o mesmo estado que ele deixa (o vigia novo sem o registro da instalação).
arquivos_do_checkout
echo '# mudança de teste do timer (transição)' >>"$R/infra/producao/vigia/$TIMER"
echo '# mudança de teste da unidade (transição)' >>"$R/infra/producao/vigia/$SERVICO"
C26=$(novo_commit 'primeiro commit com o OP-B9')
if "$GIT_REAL" -C "$RAIZ" cat-file -e e539ed0:infra/producao/vigia/vigia-implantacao.sh 2>/dev/null; then
  "$GIT_REAL" -C "$RAIZ" show e539ed0:infra/producao/vigia/vigia-implantacao.sh >"$VIGIA/vigia-implantacao.sh"
  ! grep -q conferir_instalacao "$VIGIA/vigia-implantacao.sh" || falha "o vigia do e539ed0 não deveria ter o OP-B9"
  rm -f "$VIGIA/instalacao"
  guardar_instalados
  rodada
  implantou "$C26" "transição: o vigia do OP-B7 implanta"
  estado_e main "$C26" ok "transição: o vigia do OP-B7 implanta"
  cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C26:infra/producao/vigia/vigia-implantacao.sh") ||
    falha "transição: o vigia do OP-B7 troca o programa pelo do commit"
  for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "transição: o vigia do OP-B7 não mexe em $f"; done
  [ ! -e "$VIGIA/instalacao" ] || falha "transição: o vigia do OP-B7 não registra a instalação"
  transicao="o vigia do OP-B7 (e539ed0) implanta e troca só o programa"
else
  printf '\033[1;33m-\033[0m o histórico não tem o e539ed0: a transição começa do estado que o vigia do OP-B7 deixa\n'
  guardar_instalados
  rodada
  implantou "$C26" "transição (simulada)"
  for f in $SERVICO $TIMER; do cp -p "$T/antes/$f" "$SYS/$f"; done
  rm -f "$VIGIA/instalacao"
  transicao="o estado que o vigia do OP-B7 deixa (simulado)"
fi
cp "$ESTADO" "$T/estado-antes"
rodada
nao_implantou "transição: a rodada do vigia novo"
iguais_ao_commit "$C26" "transição: a rodada do vigia novo"
grep -qx 'systemctl daemon-reload' "$DUBLE/ordem" && grep -qx "systemctl try-restart $TIMER" "$DUBLE/ordem" ||
  falha "transição: sem o daemon-reload e o try-restart: $(grep '^systemctl' "$DUBLE/ordem")"
[ -e "$DUBLE/timer-ativo" ] || falha "transição: o timer deveria continuar ligado"
instalacao_e "$C26" ok "transição"
grep -q "instalação do vigia: o vigia instalado não é o da última instalação completa .*aplica a do commit no ar ${C26:0:12}" "$VIGIA/vigia.log" ||
  falha "transição: sem o registro no log: $(tail -n 3 "$VIGIA/vigia.log")"
cmp -s "$ESTADO" "$T/estado-antes" || falha "transição: nada no estado.json"
rodada
sem_systemctl_de_troca "transição: a rodada seguinte"
confere "OP-B9: transição: $transicao; a rodada seguinte (o vigia novo, sem o registro da instalação) aplica a instalação completa do commit no ar, sem comando do dono, e não repete"

# 9. A versão no ar fora da main do clone (o C3, do branch "outra": implantado pelo dono no terminal) e o registro
# ausente: "sem-commit" (fica a instalação atual), nada trocado, uma linha no log, e não repete.
echo "${C3:0:12}" >"$GENESIS_PASTA/versoes/atual"
rm -f "$VIGIA/instalacao"
guardar_instalados
rodada
nao_implantou "versão no ar fora da main"
nada_trocado "versão no ar fora da main"
sem_systemctl_de_troca "versão no ar fora da main"
instalacao_e "${C3:0:12}" sem-commit "versão no ar fora da main"
rodada
sem_systemctl_de_troca "versão no ar fora da main, a rodada seguinte"
[ "$(grep -c "instalação do vigia: a versão no ar ${C3:0:12} não está na main do clone do vigia; fica a instalação atual" "$VIGIA/vigia.log")" = 1 ] ||
  falha "versão no ar fora da main: uma linha no log, uma vez só"
confere "OP-B9: a versão no ar fora da main do clone fica sem-commit (a instalação atual, nada trocado), uma linha no log, sem repetir"

# 10. A conferência do começo da rodada com o commit no ar anterior ao OP-B9 (o C22) e o registro ausente ou de outro
# vigia: o vigia novo não se troca sozinho pelo antigo ("sem-autoatualizar", nada trocado). Sem o instalar-vigia.sh
# (a rede), o registro fica como está (não "pendente": sem o instalador não se sabe se o commit tem o
# --autoatualizar), uma linha no log, e a rodada seguinte decide de novo.
echo "${C22:0:12}" >"$GENESIS_PASTA/versoes/atual"
for registro in ausente outro-vigia; do
  if [ "$registro" = ausente ]; then
    rm -f "$VIGIA/instalacao"
  else
    printf '%s ok 2026-11-25T00:00:00Z %064d\n' "$C26" 0 >"$VIGIA/instalacao"
  fi
  guardar_instalados
  rodada
  nao_implantou "commit no ar sem o --autoatualizar ($registro)"
  nada_trocado "commit no ar sem o --autoatualizar ($registro)"
  sem_systemctl_de_troca "commit no ar sem o --autoatualizar ($registro)"
  instalacao_e "$C22" sem-autoatualizar "commit no ar sem o --autoatualizar ($registro)"
  rodada
  nada_trocado "commit no ar sem o --autoatualizar ($registro), a rodada seguinte"
done
[ "$(grep -c "o commit no ar ${C22:0:12} é anterior ao OP-B9 (sem o --autoatualizar); fica a instalação atual" "$VIGIA/vigia.log")" = 2 ] ||
  falha "commit no ar sem o --autoatualizar: uma linha no log por registro, sem repetir a cada rodada"
rm -f "$VIGIA/instalacao"
linhas_antes=$(grep -c "o vigia instalado não é o da última instalação completa .*aplica a do commit no ar ${C22:0:12}" "$VIGIA/vigia.log")
echo 'instalar-vigia.sh' >"$DUBLE/git-show-falha"
rodada
rodada
nada_trocado "commit no ar sem o instalador (a rede)"
[ ! -e "$VIGIA/instalacao" ] || falha "a conferência sem o instalador não grava o registro (nem pendente): $(cat "$VIGIA/instalacao")"
[ "$(grep -c "instalação do vigia do commit ${C22:0:12}: o instalar-vigia.sh não veio" "$VIGIA/vigia.log")" = 1 ] &&
  [ "$(grep -c "o vigia instalado não é o da última instalação completa .*aplica a do commit no ar ${C22:0:12}" "$VIGIA/vigia.log")" = $((linhas_antes + 1)) ] ||
  falha "a conferência sem o instalador: uma linha de cada no log, sem repetir a cada rodada: $(tail -n 4 "$VIGIA/vigia.log")"
rm -f "$DUBLE/git-show-falha"
rodada
nada_trocado "commit no ar sem o instalador, com a rede de volta"
instalacao_e "$C22" sem-autoatualizar "commit no ar sem o instalador, com a rede de volta"
confere "OP-B9: na conferência do começo da rodada, o commit no ar anterior ao OP-B9 (registro ausente ou de outro vigia) não troca o vigia novo pelo antigo (sem-autoatualizar); sem o instalador, o registro fica como está e a rodada seguinte decide de novo"

# 11. A volta pelo GitHub a esse commit com o instalar-vigia.sh sem vir (a rede): "pendente"; com a rede de volta, a
# rodada seguinte a refaz como depois do ok da volta: o programa do vigia do commit, como a volta teria feito.
guardar_instalados
echo 'instalar-vigia.sh' >"$DUBLE/git-show-falha"
g tag implantar/20261125-040000 "$C22"
rodada
rm -f "$DUBLE/git-show-falha"
implantou "$C22" "volta com o instalador sem vir"
estado_e implantar/20261125-040000 "$C22" ok "volta com o instalador sem vir"
nada_trocado "volta com o instalador sem vir"
instalacao_e "$C22" pendente "volta com o instalador sem vir"
rodada
nao_implantou "volta pendente com a rede de volta"
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C22:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "volta pendente com a rede de volta: o programa do vigia do commit, como a volta teria feito"
for f in $SERVICO $TIMER; do cmp -s "$SYS/$f" "$T/antes/$f" || falha "volta pendente com a rede de volta: $f não deveria mudar"; done
instalacao_e "$C22" sem-autoatualizar "volta pendente com a rede de volta"
confere "OP-B9: a volta a um commit anterior ao OP-B9 que ficou pendente (a rede) é refeita como depois do ok: o programa do vigia do commit, sem mexer na unidade nem no timer"

printf '\n\033[1;32mVigia da implantação: todos os testes passaram.\033[0m\n'
