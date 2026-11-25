#!/usr/bin/env bash
# Testes de unidade do vigia da implantação (OP-B4; D70; README de infra/producao › Vigia da implantação): o
# vigia-implantacao.sh e o instalar-vigia.sh, sem rede, sem systemd e sem root. Dublês de `id` e `systemctl` no PATH,
# o `git` de verdade (com um dublê que só registra a chamada) sobre um repositório local no lugar do público, com as
# tags de pedido criadas nele, e o implantar-sem-actions.sh falso dentro desse repositório (o vigia copia o da main,
# como na VPS). Cobre: a instalação (arquivos da main, unidades, tags antigas vistas, timer ligado, pasta pública),
# a escolha do pedido (o mais novo, os anteriores pulados, nomes fora do padrão ignorados, tag anotada), pedido já
# visto não roda de novo, a trava ocupada (a do implantar.sh, a do implantar-sem-actions.sh e o código 75) = tenta na
# próxima rodada, a recusa de commit fora da main, o implantar-pdv/ com --publicar-pdv, a falha, o estado.json só
# com os campos permitidos (e as permissões), a autoatualização (só depois de um ok, só se mudou, commit sem o
# vigia), a implantação interrompida, sem rede, sem root, sem a lista de vistos, a reinstalação com o timer ligado e
# desligado, o --desligar e o --estado; e o `systemd-analyze verify` das unidades (pulado sem o systemd-analyze).
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
export GIT_REAL
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
# `systemctl is-active`), sem-actions-codigo (o código do implantar-sem-actions.sh falso) e sem-actions-espera (ele
# espera o arquivo sumir, com sem-actions-esperando criado).
cat >"$T/bin/id" <<'DUBLE'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then cat "$DUBLE/uid" 2>/dev/null || echo 0; else exec /usr/bin/id "$@"; fi
DUBLE
cat >"$T/bin/systemctl" <<'DUBLE'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$DUBLE/ordem"
case "$1" in
  is-active) [ -e "$DUBLE/timer-ativo" ] ;;
  enable) touch "$DUBLE/timer-ativo" ;;
  disable) rm -f "$DUBLE/timer-ativo" ;;
  *) ;;
esac
DUBLE
cat >"$T/bin/git" <<'DUBLE'
#!/usr/bin/env bash
printf 'git %s [prompt=%s]\n' "$*" "${GIT_TERMINAL_PROMPT:-}" >>"$DUBLE/ordem"
exec "$GIT_REAL" "$@"
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
# implantar-sem-actions.sh falso (o vigia o copia da main).
printf 'implantar-sem-actions.sh %s [pasta=%s] [entrada=%s]\n' "$*" "$GENESIS_PASTA" "$(readlink /proc/$$/fd/0)" >>"$DUBLE/ordem"
echo "saída do implantar-sem-actions.sh de teste: $*"
if [ -e "$DUBLE/sem-actions-espera" ]; then
  touch "$DUBLE/sem-actions-esperando"
  while [ -e "$DUBLE/sem-actions-espera" ]; do sleep 0.1; done
fi
exit "$(cat "$DUBLE/sem-actions-codigo" 2>/dev/null || echo 0)"
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
if command -v systemd-analyze >/dev/null; then
  systemd-analyze verify "$VIGIA_DIR/genesis-vigia.service" "$VIGIA_DIR/genesis-vigia.timer" >"$T/verify" 2>&1 ||
    falha "systemd-analyze verify: $(cat "$T/verify")"
  [ ! -s "$T/verify" ] || falha "systemd-analyze verify com avisos: $(cat "$T/verify")"
  confere "unidades do systemd: systemd-analyze verify sem erros nem avisos"
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

rodar "$INSTALAR"
sucesso "instalação"
for f in vigia-implantacao.sh implantar-sem-actions.sh; do
  [ "$(stat -c %a "$VIGIA/$f")" = 700 ] || falha "$f instalado sem 700"
done
cmp -s "$VIGIA/vigia-implantacao.sh" <(g show "$C4:infra/producao/vigia/vigia-implantacao.sh") ||
  falha "o vigia instalado não é o da main"
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
[ "$(grep -c '(já estava na versão da main)' <<<"$SAIDA")" = 4 ] && ! grep -q '(atualizado)' <<<"$SAIDA" ||
  falha "reinstalação deveria manter os quatro arquivos (o vigia, o implantar-sem-actions.sh e as duas unidades): $SAIDA"
confere "reinstalação idempotente (nenhum dos quatro arquivos muda)"

# --- Pedido normal ------------------------------------------------------------------------------------------------
g tag implantar/20261124-100000 "$C2"
rodada
sucesso "pedido normal"
implantou "$C2" "pedido normal"
git_sem_credencial "rodada que implanta"
chamou '^git -c credential\.helper= ls-remote --tags ' && chamou '^git -c credential\.helper= --git-dir=.* fetch --quiet --prune --no-tags ' ||
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

printf '\n\033[1;32mVigia da implantação: todos os testes passaram.\033[0m\n'
