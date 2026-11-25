#!/usr/bin/env bash
# Testes de unidade do vigia da implantação (OP-B4 e OP-B7; D70 e D119; README de infra/producao › Vigia da
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
# recebido e foi implantada pelo terminal (o estado.json termina como ok).
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
export GIT_REAL DATE_REAL
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

# A versão no ar é a ponta da main (C4): a instalação a dá como tratada (a implantação automática, mais abaixo).
mkdir -p "$GENESIS_PASTA/versoes"
echo "${C4:0:12}" >"$GENESIS_PASTA/versoes/atual"
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

printf '\n\033[1;32mVigia da implantação: todos os testes passaram.\033[0m\n'
