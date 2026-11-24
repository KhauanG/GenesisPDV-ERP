#!/usr/bin/env bash
# Testes de unidade do implantar-sem-actions.sh (D70-Q1, OP-B2; README de infra/producao › Implantar sem o GitHub
# Actions), sem Docker nem rede: dublês de `docker`, `curl`, `df`, `id`, `nice` e `ionice` no PATH, o `git` de verdade
# (com um dublê que só registra a chamada) sobre um repositório local no lugar do público, e o instalar.sh e o
# implantar.sh falsos dentro desse repositório (o script copia os do commit, como o workflow). Cobre: o formato do
# commit, a ancestralidade (outro branch, commit inexistente, a main reescrita), root, espaço em disco, as duas
# travas, a ordem das etapas (build com nice/ionice e as tags/Dockerfiles do workflow, os arquivos da versão,
# instalar.sh, implantar.sh, URLs públicas, limpeza), `--simular` (nada montado nem trocado), `--sem-conferir-url`, o
# `--publicar-pdv` (versão mais alta publicada, sha256 certo, errado e fora do formato, já publicado, sem release →
# retirar e o 404 conferido, GitHub fora do ar → só aviso), a falha da implantação e das URLs com o resumo, a limpeza
# das imagens (também a atual depois de implantações que falharam) e a execução fora do terminal (o terminal morto
# por SIGHUP/SIGKILL no meio do implantar.sh não interrompe a implantação; o log e o --acompanhar).
# O ensaio de ponta a ponta, com o Docker e a stack de verdade, é o `testar-local.sh --sem-actions`.
#
#   bash infra/producao/teste/testar-implantar-sem-actions.sh
# Precisa de bash, git, jq, tar, coreutils e util-linux (flock); roda sem root.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=$AQUI/../implantar-sem-actions.sh
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-sem-actions-teste.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/duble"
GIT_REAL=$(command -v git)
JQ_REAL=$(command -v jq)
export GIT_REAL JQ_REAL
export DUBLE=$T/duble
export GENESIS_PASTA=$T/pasta
export GENESIS_REPOSITORIO=$T/remoto
export GENESIS_CONFERIR_TENTATIVAS=2 GENESIS_CONFERIR_INTERVALO=0
# Variáveis que o script lê e que o ambiente de quem roda o teste pode ter.
unset GENESIS_API_URL GENESIS_ERP_URL GENESIS_DOWNLOAD_URL GENESIS_BUILD_OPCOES GENESIS_ESPACO_MINIMO_GB \
  GENESIS_MANTER_IMAGENS GENESIS_COMPOSE_EXTRA
# Git sem a configuração de quem roda (assinatura de commit, branch padrão...).
printf '[user]\n\tname = Teste\n\temail = teste@genesis.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n' >"$T/gitconfig"
export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublês -------------------------------------------------------------------------------------------------------
# Cada chamada vai para $DUBLE/ordem (a ordem das etapas). Arquivos de controle em $DUBLE: uid (o `id -u`), df-livre-kb
# (o espaço livre do `df`), build-falha, imagens-<nome> (o `docker image ls`: "<data>\t<tag>" por linha), gh-lista e
# gh-release (as respostas da API do GitHub), gh-falha (a lista falha), assets/<arquivo> (os downloads do release),
# pagina-versao (o atual.json servido), url-falha (o /saude público não responde), implantar-espera (o implantar.sh
# implantar espera o arquivo sumir, com implantar-esperando criado) e retirar-sem-efeito (o pdv retirar não tira).
cat >"$T/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$DUBLE/ordem"
case "$1" in
  info) [ "${2:-}" != -f ] || echo "$DUBLE/raiz-docker" ;;
  buildx | builder) ;;
  build) [ ! -e "$DUBLE/build-falha" ] ;;
  run)
    # docker run ... --entrypoint jq <imagem> <argumentos do jq>
    while [ "$1" != --entrypoint ]; do shift; done
    shift 3
    exec "$JQ_REAL" "$@"
    ;;
  image)
    case "$2" in
      ls) cat "$DUBLE/imagens-$3" 2>/dev/null || true ;;
      rm) ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
DUBLE
cat >"$T/bin/curl" <<'DUBLE'
#!/usr/bin/env bash
saida='' formato='' url=''
while [ $# -gt 0 ]; do
  case "$1" in
    -o) saida=$2; shift 2 ;;
    -w) formato=$2; shift 2 ;;
    -H | --max-time | --proto | -r) shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf 'curl %s\n' "$url" >>"$DUBLE/ordem"
escrever() { if [ -n "$saida" ]; then cat >"$saida"; else cat; fi; }
gh=https://api.github.com/repos/KhauanG/GenesisPDV-ERP
case "$url" in
  "$gh/releases?per_page=100&page=1") [ ! -e "$DUBLE/gh-falha" ] || exit 22; escrever <"$DUBLE/gh-lista" ;;
  "$gh/releases?"*) echo '[]' | escrever ;;
  "$gh/releases/tags/"*) escrever <"$DUBLE/gh-release" ;;
  https://github.com/KhauanG/GenesisPDV-ERP/releases/download/*)
    f=$DUBLE/assets/${url##*/}
    [ -f "$f" ] || exit 22
    escrever <"$f"
    ;;
  */api/saude/detalhada) printf 401 ;;
  */pdv/atual.json)
    if [ -s "$DUBLE/pagina-versao" ]; then
      [ -z "$formato" ] || printf 200
      printf '{\n  "versao": "%s"\n}\n' "$(cat "$DUBLE/pagina-versao")" | escrever
    else
      [ -n "$formato" ] || exit 22
      printf 404
    fi
    ;;
  */pdv/*.exe) [ -s "$DUBLE/pagina-versao" ] || exit 22 ;;
  */saude) [ ! -e "$DUBLE/url-falha" ] || exit 22; echo '{"status":"ok","banco_controle":"ok"}' | escrever ;;
  */) echo '<html><div id="root"></div><script src="/pagina.js"></script>' | escrever ;;
  *) exit 22 ;;
esac
DUBLE
cat >"$T/bin/df" <<'DUBLE'
#!/usr/bin/env bash
printf 'df %s\n' "$*" >>"$DUBLE/ordem"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/teste 209715200 0 %s 1%% /\n' \
  "$(cat "$DUBLE/df-livre-kb" 2>/dev/null || echo 104857600)"
DUBLE
cat >"$T/bin/id" <<'DUBLE'
#!/usr/bin/env bash
[ "$1" = -u ] && { cat "$DUBLE/uid" 2>/dev/null || echo 0; }
DUBLE
for p in nice ionice; do
  cat >"$T/bin/$p" <<DUBLE
#!/usr/bin/env bash
printf '$p %s\n' "\$*" >>"\$DUBLE/ordem"
shift 2
exec "\$@"
DUBLE
done
cat >"$T/bin/git" <<'DUBLE'
#!/usr/bin/env bash
printf 'git %s [prompt=%s]\n' "$*" "${GIT_TERMINAL_PROMPT:-}" >>"$DUBLE/ordem"
exec "$GIT_REAL" "$@"
DUBLE
chmod +x "$T/bin"/*

# --- Repositório local no lugar do público ------------------------------------------------------------------------
# C1 e C2 na main (C2 é o último), C3 só no branch "outra". O instalar.sh e o implantar.sh são dublês: registram a
# chamada e imitam o que o script usa deles (versoes/atual e anterior, pdv atual/publicar/retirar).
R=$T/remoto
git() { "$GIT_REAL" "$@"; }
git init -q "$R"
mkdir -p "$R/apps/api" "$R/apps/erp-web" "$R/infra/producao/backup"
for f in apps/api/Dockerfile apps/erp-web/Dockerfile infra/producao/backup/Dockerfile; do echo 'FROM scratch' >"$R/$f"; done
for f in docker-compose.yml compose.env.exemplo genesis.env.exemplo; do echo "# $f de teste" >"$R/infra/producao/$f"; done
cat >"$R/infra/producao/instalar.sh" <<'DUBLE'
#!/usr/bin/env bash
printf 'instalar.sh %s\n' "$*" >>"$DUBLE/ordem"
[ ! -e "$DUBLE/instalar-falha" ]
DUBLE
cat >"$R/infra/producao/implantar.sh" <<'DUBLE'
#!/usr/bin/env bash
printf 'implantar.sh %s\n' "$*" >>"$DUBLE/ordem"
case "$1" in
  implantar)
    [ ! -e "$DUBLE/implantar-falha" ] || { echo 'ERRO: implantação de teste falhou' >&2; exit 1; }
    if [ -e "$DUBLE/implantar-espera" ]; then
      touch "$DUBLE/implantar-esperando"
      while [ -e "$DUBLE/implantar-espera" ]; do sleep 0.1; done
    fi
    mkdir -p "$GENESIS_PASTA/versoes"
    [ ! -s "$GENESIS_PASTA/versoes/atual" ] || cp "$GENESIS_PASTA/versoes/atual" "$GENESIS_PASTA/versoes/anterior"
    echo "$2" >"$GENESIS_PASTA/versoes/atual"
    ;;
  pdv)
    case "$2" in
      atual) cat "$DUBLE/pdv-atual" 2>/dev/null || true ;;
      publicar) mkdir -p "$DUBLE/pdv-recebido" && tar -xf - -C "$DUBLE/pdv-recebido" && echo "$3" >"$DUBLE/pagina-versao" ;;
      retirar) [ -e "$DUBLE/retirar-sem-efeito" ] || rm -f "$DUBLE/pagina-versao" ;;
    esac
    ;;
esac
DUBLE
chmod 644 "$R/infra/producao/instalar.sh" "$R/infra/producao/implantar.sh"
git -C "$R" add -A
git -C "$R" commit -q -m primeiro
C1=$(git -C "$R" rev-parse HEAD)
echo segundo >"$R/LEIAME"
git -C "$R" add -A
git -C "$R" commit -q -m segundo
C2=$(git -C "$R" rev-parse HEAD)
git -C "$R" checkout -q -b outra
echo fora >"$R/FORA"
git -C "$R" add -A
git -C "$R" commit -q -m 'fora da main'
C3=$(git -C "$R" rev-parse HEAD)
git -C "$R" checkout -q main
unset -f git
V1=${C1:0:12}
V2=${C2:0:12}

export PATH=$T/bin:$PATH

# Cenário limpo: VPS sem nada, dublês no padrão.
novo_cenario() {
  rm -rf "$GENESIS_PASTA" "$DUBLE"
  mkdir -p "$DUBLE/raiz-docker" "$DUBLE/assets"
  : >"$DUBLE/ordem"
}
# Roda o script; a saída (stdout e stderr) em $SAIDA e o código em $CODIGO.
rodar() {
  : >"$DUBLE/ordem"
  CODIGO=0
  SAIDA=$(bash "$SCRIPT" "$@" 2>&1) || CODIGO=$?
}
sucesso() { [ "$CODIGO" = 0 ] || falha "$1: saiu $CODIGO: $SAIDA"; }
recusa() {
  [ "$CODIGO" != 0 ] || falha "$1: deveria recusar (saiu 0): $SAIDA"
  grep -qF -- "$2" <<<"$SAIDA" || falha "$1: sem a mensagem '$2': $SAIDA"
}
chamou() { grep -qE -- "$1" "$DUBLE/ordem"; }
nao_chamou() { ! chamou "$1" || falha "$2: não deveria chamar '$1': $(grep -E -- "$1" "$DUBLE/ordem")"; }
# Linha da primeira chamada que casa com $1 (para conferir a ordem).
linha() { grep -nE -- "$1" "$DUBLE/ordem" | head -n 1 | cut -d: -f1; }
antes() {
  local a b
  a=$(linha "$1")
  b=$(linha "$2")
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] || falha "esperava '$1' antes de '$2': $(cat "$DUBLE/ordem")"
}

# --- Argumentos e conferências iniciais ---------------------------------------------------------------------------
novo_cenario
rodar --ajuda
sucesso "--ajuda"
grep -q -- '--publicar-pdv' <<<"$SAIDA" || falha "--ajuda sem as opções: $SAIDA"
rodar --opcao-que-nao-existe
recusa "opção desconhecida" "opção desconhecida"
rodar "$V1" "$V2"
recusa "dois commits" "um commit só"
for invalido in xyz 1a2b3c 1A2B3C4D5E6F "$C1"0 "$V1;id"; do
  rodar "$invalido"
  recusa "commit '$invalido'" "commit inválido"
  nao_chamou '^git ' "commit '$invalido'"
done
rodar --simular "${C1:0:7}"
sucesso "commit de 7 caracteres (o hash curto do GitHub)"
grep -q "commit $C1 está na main (informado: ${C1:0:7})" <<<"$SAIDA" && grep -q "Simulação de $V1:" <<<"$SAIDA" ||
  falha "commit de 7 caracteres: deveria achar o $C1 e usar a versão $V1: $SAIDA"
confere "formato do commit (7 a 40 hexadecimais minúsculos, como o workflow; os 7 do GitHub valem, com a versão em 12): os outros são recusados antes do git"

echo 1000 >"$DUBLE/uid"
rodar "$V1"
recusa "sem root" "rode como root"
nao_chamou '^git |^docker build ' "sem root"
rm -f "$DUBLE/uid"
echo $((4 * 1048576)) >"$DUBLE/df-livre-kb"
rodar "$V1"
recusa "pouco espaço" "só 4 GB livres"
nao_chamou '^git |^docker build ' "pouco espaço"
mkdir -p "$GENESIS_PASTA"
GENESIS_ESPACO_MINIMO_GB=4 rodar --simular "$V1"
sucesso "limiar configurável (GENESIS_ESPACO_MINIMO_GB=4)"
grep -q "^df -Pk -- $DUBLE/raiz-docker$" "$DUBLE/ordem" && grep -q "^df -Pk -- $GENESIS_PASTA$" "$DUBLE/ordem" ||
  falha "espaço medido sem o disco do Docker e o do $GENESIS_PASTA: $(grep '^df' "$DUBLE/ordem")"
rm -f "$DUBLE/df-livre-kb"
confere "recusa sem root e com menos de 5 GB livres (disco do Docker e do /opt/genesis), antes do git"

mkdir -p "$GENESIS_PASTA"
exec 9>"$GENESIS_PASTA/.implantacao.lock"
flock -n 9
rodar "$V1"
recusa "trava do implantar.sh" "outra implantação está em andamento"
[ "$CODIGO" = 75 ] || falha "trava do implantar.sh: deveria sair com 75 (tente de novo depois), saiu $CODIGO"
nao_chamou '^git |^docker build ' "trava do implantar.sh"
exec 9>&-
exec 9>"$GENESIS_PASTA/.implantar-sem-actions.lock"
flock -n 9
rodar "$V1"
recusa "outra execução" "outra implantação sem o Actions"
[ "$CODIGO" = 75 ] || falha "outra execução: deveria sair com 75 (tente de novo depois), saiu $CODIGO"
exec 9>&-
echo 1000 >"$DUBLE/uid"
rodar "$V1"
[ "$CODIGO" = 1 ] || falha "sem root: deveria sair com 1 (só a trava sai com 75), saiu $CODIGO"
rm -f "$DUBLE/uid"
confere "recusa com outra implantação em andamento (a trava do implantar.sh e a deste script), com o código 75; as outras recusas com 1"

# --- Commit da main -----------------------------------------------------------------------------------------------
novo_cenario
# O clone local (caminho, não URL) copia todos os objetos, inclusive o C3: a ancestralidade recusa.
rodar --simular "$C3"
recusa "commit de outro branch" "não está na main"
rodar --simular "${C3:0:12}"
recusa "commit curto de outro branch" "não está na main"
rodar --simular "$(printf 'd%.0s' $(seq 1 40))"
recusa "commit inexistente" "não encontrado na main"
# A main reescrita (força) para C1: o C2 continua na fonte (buscado antes), mas não é mais ancestral da main.
rodar --simular "$V2"
sucesso "--simular com C2"
"$GIT_REAL" -C "$R" reset -q --hard "$C1"
rodar --simular "$V2"
recusa "commit fora da main reescrita" "não está na main"
"$GIT_REAL" -C "$R" reset -q --hard "$C2"
confere "só commit da main: outro branch, inexistente e fora da main reescrita são recusados"

# Pela URL (file://, como o https do GitHub): clone parcial só da main, e o checkout busca os arquivos do commit. O
# commit de outro branch, pelo hash completo, o clone parcial busca sob demanda: a ancestralidade recusa.
"$GIT_REAL" -C "$R" config uploadpack.allowFilter true
novo_cenario
GENESIS_REPOSITORIO=file://$R rodar --simular "$C3"
recusa "commit de outro branch pela URL" "não está na main"
GENESIS_REPOSITORIO=file://$R rodar --sem-conferir-url "$V1"
sucesso "implantar pela URL"
[ "$("$GIT_REAL" -C "$GENESIS_PASTA/fonte" config remote.origin.promisor)" = true ] || falha "a fonte deveria ser um clone parcial"
[ "$("$GIT_REAL" -C "$GENESIS_PASTA/fonte" rev-parse HEAD)" = "$C1" ] && [ -f "$GENESIS_PASTA/releases/$V1/implantar.sh" ] ||
  falha "clone parcial: fonte fora do $C1 ou sem os arquivos da release"
[ -z "$("$GIT_REAL" -C "$GENESIS_PASTA/fonte" for-each-ref --format='%(refname)' | grep -E '^refs/tags/|outra')" ] ||
  falha "a fonte deveria ter só a main, sem tags: $("$GIT_REAL" -C "$GENESIS_PASTA/fonte" for-each-ref)"
confere "pela URL: clone parcial só da main e sem tags, commit de outro branch recusado, checkout com os arquivos do commit"

# --- --simular ----------------------------------------------------------------------------------------------------
novo_cenario
rodar --simular --publicar-pdv "$V1"
sucesso "--simular"
grep -q "Simulação de $V1: tudo conferido; nada foi montado nem trocado" <<<"$SAIDA" || falha "--simular sem o fim: $SAIDA"
grep -q "faria: nice -n 19 ionice -c 3 docker build --build-arg VERSAO=$V1 -f $GENESIS_PASTA/fonte/apps/api/Dockerfile -t genesis-api:$V1 $GENESIS_PASTA/fonte$" <<<"$SAIDA" ||
  falha "--simular sem o build da API: $SAIDA"
nao_chamou '^docker (build |run|image rm|builder)|^instalar\.sh|^implantar\.sh|^curl |checkout --quiet|^nice ' "--simular"
[ ! -e "$GENESIS_PASTA/releases" ] && [ ! -e "$GENESIS_PASTA/versoes" ] || falha "--simular criou releases ou versoes"
confere "--simular: confere tudo e mostra o build, sem montar, copiar, instalar, implantar, baixar nem limpar"

# --- Implantação de um commit (curto) -----------------------------------------------------------------------------
novo_cenario
mkdir -p "$GENESIS_PASTA/versoes"
echo antiga >"$GENESIS_PASTA/versoes/atual"
printf '%s\n' "API_DOMINIO=api.teste.invalid" "ERP_DOMINIO=erp.teste.invalid" "DOWNLOAD_DOMINIO=download.teste.invalid" >"$GENESIS_PASTA/.env"
rodar "$V1"
sucesso "implantar $V1"
for nome in api web backup; do
  case $nome in
    api) arq=apps/api/Dockerfile ctx='' ;;
    web) arq=apps/erp-web/Dockerfile ctx='' ;;
    backup) arq=infra/producao/backup/Dockerfile ctx=/infra/producao/backup ;;
  esac
  grep -qxF "nice -n 19 ionice -c 3 docker build --build-arg VERSAO=$V1 -f $GENESIS_PASTA/fonte/$arq -t genesis-$nome:$V1 $GENESIS_PASTA/fonte$ctx" "$DUBLE/ordem" ||
    falha "build da genesis-$nome sem nice/ionice, a versão, o Dockerfile ou o contexto do workflow: $(grep 'docker build' "$DUBLE/ordem")"
done
antes '^git .*clone .*--no-checkout' '^git .*fetch .*refs/heads/main:refs/remotes/origin/main'
antes 'fetch' 'merge-base --is-ancestor'
antes 'merge-base --is-ancestor' 'checkout --quiet --force --detach'
antes 'checkout --quiet --force --detach' 'docker build .* -t genesis-api:'
antes 'docker build .* -t genesis-api:' 'docker build .* -t genesis-web:'
antes 'docker build .* -t genesis-web:' 'docker build .* -t genesis-backup:'
antes 'docker build .* -t genesis-backup:' '^instalar\.sh'
antes '^instalar\.sh' "^implantar\.sh implantar $V1\$"
antes "^implantar\.sh implantar $V1\$" '^curl https://api\.teste\.invalid/saude$'
antes '^curl https://api\.teste\.invalid/saude$' '^curl https://erp\.teste\.invalid/saude$'
antes '^curl https://erp\.teste\.invalid/saude$' '^curl https://erp\.teste\.invalid/$'
antes '^curl https://erp\.teste\.invalid/$' '^curl https://api\.teste\.invalid/api/saude/detalhada$'
antes '^curl https://api\.teste\.invalid/api/saude/detalhada$' '^curl https://download\.teste\.invalid/$'
antes '^curl https://download\.teste\.invalid/$' '^docker builder prune -f --filter until=168h$'
nao_chamou 'api\.github\.com|pdv (atual|publicar|retirar)' "implantar sem --publicar-pdv"
! grep -E '^git ' "$DUBLE/ordem" | grep -qv '\[prompt=0\]$' || falha "git sem GIT_TERMINAL_PROMPT=0: $(grep '^git ' "$DUBLE/ordem")"
grep -q "^git -c credential.helper= clone --quiet --no-checkout --filter=blob:none --single-branch --branch main --no-tags $R $GENESIS_PASTA/fonte" "$DUBLE/ordem" ||
  falha "clone sem o repositório informado ou com credencial: $(grep clone "$DUBLE/ordem")"
[ "$(stat -c %a "$GENESIS_PASTA/fonte")" = 700 ] || falha "fonte sem 700"
[ "$("$GIT_REAL" -C "$GENESIS_PASTA/fonte" rev-parse HEAD)" = "$C1" ] || falha "fonte fora do commit $C1"
for f in docker-compose.yml implantar.sh instalar.sh compose.env.exemplo genesis.env.exemplo; do
  [ -f "$GENESIS_PASTA/releases/$V1/$f" ] || falha "releases/$V1 sem $f"
done
[ -x "$GENESIS_PASTA/releases/$V1/implantar.sh" ] && [ -x "$GENESIS_PASTA/releases/$V1/instalar.sh" ] &&
  [ ! -x "$GENESIS_PASTA/releases/$V1/docker-compose.yml" ] || falha "releases/$V1: só os .sh com +x"
[ "$(ls "$GENESIS_PASTA/releases/$V1" | wc -l)" = 5 ] || falha "releases/$V1 com arquivos a mais: $(ls "$GENESIS_PASTA/releases/$V1")"
[ "$(cat "$GENESIS_PASTA/versoes/atual")" = "$V1" ] || falha "versoes/atual sem $V1"
grep -q "Versão: $V1 no ar." <<<"$SAIDA" && grep -q 'Página de download: não mexida (sem --publicar-pdv).' <<<"$SAIDA" ||
  falha "resumo: $SAIDA"
# A saída das etapas vem do log da execução desacoplada (o terminal só a mostra), com o link para a última.
log=$(readlink -f "$GENESIS_PASTA/logs/implantar-sem-actions.log")
[[ $log == "$GENESIS_PASTA"/logs/implantar-sem-actions-*.log ]] && grep -q "Versão: $V1 no ar." "$log" &&
  grep -qF "Saída completa desta implantação: $log" <<<"$SAIDA" || falha "log da execução desacoplada: $log: $SAIDA"
[ "$(stat -c %a "$GENESIS_PASTA/logs")" = 700 ] && [ "$(stat -c %a "$log")" = 600 ] || falha "logs sem 700 ou o log sem 600"
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'genesis-sem-actions.*' -newer "$T/gitconfig" 2>/dev/null)" ] ||
  falha "temporário do script ficou para trás"
confere "commit curto da main: clone sem credencial, fonte 700 no commit, 3 builds com nice/ionice e as tags/Dockerfiles do workflow, 5 arquivos (só os .sh com +x), instalar.sh, implantar.sh implantar, URLs do .env, limpeza e o resumo, nesta ordem"

# Sem commit: o último da main; a fonte já existe (só fetch). As URLs com o padrão do workflow sem o .env.
rm -f "$GENESIS_PASTA/.env"
rodar --sem-conferir-url
sucesso "sem commit"
grep -q "commit $C2, o último da main" <<<"$SAIDA" || falha "sem commit deveria implantar o último da main ($C2): $SAIDA"
nao_chamou 'clone' "fonte existente"
nao_chamou '^curl ' "--sem-conferir-url"
grep -q "implantar.sh implantar $V2" "$DUBLE/ordem" || falha "sem commit: implantar $V2"
rodar "$V2"
sucesso "URLs padrão"
chamou '^curl https://api\.grupoicebeer\.com\.br/saude$' || falha "sem .env, a URL padrão do workflow: $(grep '^curl' "$DUBLE/ordem")"
GENESIS_API_URL=https://api.outra.invalid rodar "$V2"
chamou '^curl https://api\.outra\.invalid/saude$' || falha "GENESIS_API_URL não valeu"
confere "sem commit = o último da main; fonte reaproveitada (só fetch); --sem-conferir-url; URLs do .env, do padrão do workflow ou das variáveis"

# --- Falhas da implantação ----------------------------------------------------------------------------------------
novo_cenario
touch "$DUBLE/build-falha"
rodar "$V1"
recusa "build que falha" "não montou"
nao_chamou '^instalar\.sh|^implantar\.sh' "build que falha"
grep -q "Versão: $V1 não foi implantada" <<<"$SAIDA" || falha "resumo do build que falha: $SAIDA"
rm -f "$DUBLE/build-falha"
touch "$DUBLE/instalar-falha"
rodar "$V1"
recusa "instalar.sh que falha" "o instalar.sh falhou"
nao_chamou '^implantar\.sh' "instalar.sh que falha"
rm -f "$DUBLE/instalar-falha"
touch "$DUBLE/implantar-falha"
rodar "$V1"
recusa "implantar.sh que falha" "não ficou no ar"
grep -q "bash $GENESIS_PASTA/releases/$V1/implantar.sh estado" <<<"$SAIDA" || falha "resumo da falha sem o script da release nova: $SAIDA"
chamou '^docker image ls genesis-api' || falha "a falha da implantação deveria limpar as imagens antigas"
nao_chamou '^curl ' "implantar.sh que falha"
rm -f "$DUBLE/implantar-falha"
touch "$DUBLE/url-falha"
rodar "$V1"
recusa "URL pública que não responde" "$GENESIS_PASTA/implantar.sh voltar"
[ "$(grep -c '/saude$' "$DUBLE/ordem")" = 2 ] || falha "a conferência deveria tentar GENESIS_CONFERIR_TENTATIVAS vezes"
rm -f "$DUBLE/url-falha"
confere "build, instalar.sh, implantar.sh e URL pública que falham: saída ≠ 0, nada depois, e o resumo diz onde parou"

# --- Limpeza das imagens ------------------------------------------------------------------------------------------
novo_cenario
mkdir -p "$GENESIS_PASTA/versoes"
echo velha1 >"$GENESIS_PASTA/versoes/atual"
for nome in genesis-api genesis-web genesis-backup; do
  printf '%s\t%s\n' '2026-11-20 10:00:01 +0000 UTC' velha1 '2026-11-24 10:00:00 +0000 UTC' "$V1" \
    '2026-11-23 10:00:00 +0000 UTC' velha5 '2026-11-22 10:00:00 +0000 UTC' velha4 \
    '2026-11-21 10:00:00 +0000 UTC' velha3 '2026-11-20 10:00:00 +0000 UTC' '<none>' >"$DUBLE/imagens-$nome"
done
rodar --sem-conferir-url "$V1"
sucesso "limpeza"
removidas=$(grep '^docker image rm' "$DUBLE/ordem" | sort | tr '\n' ' ')
[ "$removidas" = "docker image rm genesis-api:velha3 docker image rm genesis-backup:velha3 docker image rm genesis-web:velha3 " ] ||
  falha "limpeza: esperava só a velha3 (ficam as 3 mais recentes, $V1, velha5 e velha4, e a anterior, velha1): $removidas"
# Depois de 3 implantações que falharam (a última, esta), a versão em produção é a 4ª mais recente e a anterior, a 5ª:
# a falha também limpa, e só a proteção da atual e da anterior as mantém; as novas que falharam ficam.
novo_cenario
mkdir -p "$GENESIS_PASTA/versoes"
echo producao >"$GENESIS_PASTA/versoes/atual"
echo anterior >"$GENESIS_PASTA/versoes/anterior"
for nome in genesis-api genesis-web genesis-backup; do
  printf '%s\t%s\n' '2026-11-24 10:00:00 +0000 UTC' "$V1" '2026-11-23 10:00:00 +0000 UTC' falhou2 \
    '2026-11-22 10:00:00 +0000 UTC' falhou1 '2026-11-21 10:00:00 +0000 UTC' producao \
    '2026-11-20 10:00:00 +0000 UTC' anterior '2026-11-19 10:00:00 +0000 UTC' velha >"$DUBLE/imagens-$nome"
done
touch "$DUBLE/implantar-falha"
rodar --sem-conferir-url "$V1"
recusa "limpeza depois da falha" "não ficou no ar"
removidas=$(grep '^docker image rm' "$DUBLE/ordem" | sort | tr '\n' ' ')
[ "$removidas" = "docker image rm genesis-api:velha docker image rm genesis-backup:velha docker image rm genesis-web:velha " ] ||
  falha "limpeza depois da falha: esperava só a velha (ficam $V1, falhou2 e falhou1, as 3 mais recentes, a atual, producao, e a anterior): $removidas"
[ "$(cat "$GENESIS_PASTA/versoes/atual")" = producao ] || falha "a falha não deveria mudar versoes/atual"
confere "limpeza: ficam as 3 imagens mais recentes de cada, a atual e a anterior (também a atual atrás de 3 implantações que falharam); cache do build com mais de uma semana"

# --- --publicar-pdv -----------------------------------------------------------------------------------------------
# Releases: a pdv-v0.13.0 é a de versão mais alta publicada (a 0.14.0 é pre-release, a 0.15.0 rascunho, a 0.9.0 e a
# 0.10.0 menores na ordem de versão, não na de texto).
pdv_cenario() {
  novo_cenario
  jq -n '[
    {tag_name: "pdv-v0.15.0", draft: true, prerelease: false},
    {tag_name: "pdv-v0.14.0", draft: false, prerelease: true},
    {tag_name: "pdv-v0.9.0", draft: false, prerelease: false},
    {tag_name: "pdv-v0.13.0", draft: false, prerelease: false},
    {tag_name: "pdv-v0.10.0", draft: false, prerelease: false},
    {tag_name: "outra-coisa", draft: false, prerelease: false}]' >"$DUBLE/gh-lista"
  jq -n '{tag_name: "pdv-v0.13.0", published_at: "2026-11-17T12:00:00Z",
    assets: [{name: "GenesisPDV-Setup-0.13.0.exe"}, {name: "GenesisPDV-Setup-0.13.0.exe.sha256"}]}' >"$DUBLE/gh-release"
  head -c 4096 /dev/urandom >"$DUBLE/assets/GenesisPDV-Setup-0.13.0.exe"
  (cd "$DUBLE/assets" && sha256sum GenesisPDV-Setup-0.13.0.exe >GenesisPDV-Setup-0.13.0.exe.sha256)
  SHA_PDV=$(cut -d' ' -f1 "$DUBLE/assets/GenesisPDV-Setup-0.13.0.exe.sha256")
}
exe=GenesisPDV-Setup-0.13.0.exe
baixa=https://github.com/KhauanG/GenesisPDV-ERP/releases/download/pdv-v0.13.0

pdv_cenario
rodar --publicar-pdv "$V1"
sucesso "publicar o PDV"
antes "^curl $baixa/$exe.sha256\$" '^implantar\.sh pdv atual$'
antes '^implantar\.sh pdv atual$' "^curl $baixa/$exe\$"
antes "^curl $baixa/$exe\$" '^instalar\.sh'
antes "^implantar\.sh implantar $V1\$" '^implantar\.sh pdv publicar 0\.13\.0 2026-11-17T12:00:00Z$'
antes '^implantar\.sh pdv publicar' '^curl https://download\.grupoicebeer\.com\.br/pdv/atual\.json$'
chamou "^curl https://download\.grupoicebeer\.com\.br/pdv/$exe\$" || falha "conferência sem o primeiro byte do instalador"
cmp -s "$DUBLE/pdv-recebido/$exe" "$DUBLE/assets/$exe" && cmp -s "$DUBLE/pdv-recebido/$exe.sha256" "$DUBLE/assets/$exe.sha256" ||
  falha "o implantar.sh pdv publicar não recebeu o instalador e o .sha256 do release"
grep -q 'Página de download: PDV 0.13.0 (publicado nesta implantação).' <<<"$SAIDA" || falha "resumo do PDV publicado: $SAIDA"
confere "--publicar-pdv: o pdv-v0.13.0 (versão mais alta publicada), baixado e conferido antes do instalar.sh, publicado depois da troca e conferido pela URL"

pdv_cenario
echo "$SHA_PDV" >"$DUBLE/pdv-atual"
echo 0.13.0 >"$DUBLE/pagina-versao"
rodar --publicar-pdv "$V1"
sucesso "PDV já publicado"
nao_chamou "^curl $baixa/$exe\$|pdv publicar" "PDV já publicado"
grep -q 'Página de download: PDV 0.13.0 (já publicado).' <<<"$SAIDA" || falha "resumo do PDV já publicado: $SAIDA"
chamou '/pdv/atual\.json$' || falha "PDV já publicado: a conferência do atual.json"
confere "--publicar-pdv com o mesmo sha256 já na página: nada baixado nem publicado"

pdv_cenario
head -c 4096 /dev/urandom >"$DUBLE/assets/$exe"
rodar --publicar-pdv "$V1"
recusa "sha256 que não confere" "não confere com o $exe.sha256"
nao_chamou '^instalar\.sh|^implantar\.sh (implantar|pdv publicar)' "sha256 que não confere"
grep -q "Versão: $V1 não foi implantada" <<<"$SAIDA" && grep -q 'não conferiu' <<<"$SAIDA" || falha "resumo do sha256 errado: $SAIDA"
pdv_cenario
(cd "$DUBLE/assets" && sha256sum "$exe" "$exe" >"$exe.sha256")
rodar --publicar-pdv "$V1"
recusa ".sha256 de duas linhas" "deveria ter uma linha só"
nao_chamou '^instalar\.sh' ".sha256 de duas linhas"
pdv_cenario
echo "$SHA_PDV  outro-nome.exe" >"$DUBLE/assets/$exe.sha256"
rodar --publicar-pdv "$V1"
recusa ".sha256 com outro nome" "fora do formato do sha256sum"
nao_chamou '^instalar\.sh' ".sha256 com outro nome"
confere "--publicar-pdv com sha256 errado ou .sha256 fora do formato: para antes do instalar.sh, com a produção intacta"

pdv_cenario
jq -n '[{tag_name: "pdv-v0.14.0", draft: false, prerelease: true}]' >"$DUBLE/gh-lista"
echo 0.12.0 >"$DUBLE/pagina-versao"
rodar --publicar-pdv "$V1"
sucesso "sem release publicado"
antes "^implantar\.sh implantar $V1\$" '^implantar\.sh pdv retirar$'
antes '^implantar\.sh pdv retirar$' '^curl https://download\.grupoicebeer\.com\.br/pdv/atual\.json$'
grep -q 'instalador retirado nesta implantação' <<<"$SAIDA" || falha "resumo do retirar: $SAIDA"
grep -q 'atual.json → 404' <<<"$SAIDA" || falha "retirar: a conferência do 404: $SAIDA"
# O retirar que não tirou (o atual.json ainda servido): a conferência pela URL pega.
pdv_cenario
jq -n '[{tag_name: "pdv-v0.14.0", draft: false, prerelease: true}]' >"$DUBLE/gh-lista"
echo 0.12.0 >"$DUBLE/pagina-versao"
touch "$DUBLE/retirar-sem-efeito"
rodar --publicar-pdv "$V1"
recusa "retirar sem efeito" "deveria responder 404 sem release publicado (veio 200)"
confere "--publicar-pdv sem release pdv-vX.Y.Z publicado: pdv retirar depois da troca e a conferência do 404"

for caso in lista release sha256 exe; do
  pdv_cenario
  case $caso in
    lista) touch "$DUBLE/gh-falha" ;;
    release) jq -n '{tag_name: "pdv-v0.13.0", published_at: "2026-11-17T12:00:00Z", assets: [{name: "GenesisPDV-Setup-0.13.0.exe"}]}' >"$DUBLE/gh-release" ;;
    sha256) rm -f "$DUBLE/assets/$exe.sha256" ;;
    exe) rm -f "$DUBLE/assets/$exe" ;;
  esac
  rodar --publicar-pdv "$V1"
  sucesso "GitHub sem o $caso"
  grep -q 'A página de download fica como está' <<<"$SAIDA" || falha "GitHub sem o $caso: sem o aviso: $SAIDA"
  nao_chamou 'pdv (publicar|retirar)' "GitHub sem o $caso"
  grep -q "Versão: $V1 no ar." <<<"$SAIDA" && grep -q 'Página de download: não mexida (o GitHub não respondeu' <<<"$SAIDA" ||
    falha "resumo do GitHub sem o $caso: $SAIDA"
done
confere "--publicar-pdv com o GitHub sem responder ou o release incompleto: só um aviso, a implantação segue e a página fica como está"

# --- Fora do terminal ---------------------------------------------------------------------------------------------
# O "terminal" (uma sessão própria, como a do terminal do navegador) morre por SIGHUP e SIGKILL com o implantar.sh no
# meio: a implantação, noutra sessão, termina sozinha; o --acompanhar a mostra até o fim e, depois, a saída da última.
novo_cenario
touch "$DUBLE/implantar-espera"
setsid bash "$SCRIPT" --sem-conferir-url "$V1" >"$T/terminal.log" 2>&1 &
terminal=$!
for _ in $(seq 1 600); do
  [ ! -e "$DUBLE/implantar-esperando" ] || break
  sleep 0.1
done
[ -e "$DUBLE/implantar-esperando" ] || falha "o implantar.sh não começou: $(cat "$T/terminal.log")"
grep -q 'a implantação roda fora deste terminal' "$T/terminal.log" || falha "o terminal sem o aviso: $(cat "$T/terminal.log")"
kill -HUP -- "-$terminal" 2>/dev/null || true
kill -KILL -- "-$terminal" 2>/dev/null || true
wait "$terminal" 2>/dev/null || true
CODIGO=0
SAIDA=$(bash "$SCRIPT" --acompanhar --sem-conferir-url 2>&1) || CODIGO=$?
recusa "--acompanhar com outra opção" "--acompanhar vai sozinho"
bash "$SCRIPT" --acompanhar >"$T/acompanhar.log" 2>&1 &
acompanhar=$!
for _ in $(seq 1 50); do
  ! grep -q 'implantação em andamento' "$T/acompanhar.log" || break
  sleep 0.1
done
rm -f "$DUBLE/implantar-espera"
wait "$acompanhar" || falha "--acompanhar saiu ≠ 0: $(cat "$T/acompanhar.log")"
grep -q 'implantação em andamento' "$T/acompanhar.log" && grep -q "Versão: $V1 no ar." "$T/acompanhar.log" ||
  falha "--acompanhar deveria seguir a implantação até o resumo: $(cat "$T/acompanhar.log")"
! grep -q "Versão: $V1 no ar." "$T/terminal.log" || falha "o terminal morto não deveria ter visto o fim"
[ "$(cat "$GENESIS_PASTA/versoes/atual")" = "$V1" ] || falha "a implantação não terminou depois do terminal morto"
(exec 7>"$GENESIS_PASTA/.implantar-sem-actions.lock" && flock -n 7) || falha "a trava ficou presa depois do fim"
rodar --acompanhar
sucesso "--acompanhar sem implantação em andamento"
grep -q 'nenhuma implantação sem o Actions em andamento' <<<"$SAIDA" && grep -q "Versão: $V1 no ar." <<<"$SAIDA" ||
  falha "--acompanhar depois do fim: a saída da última: $SAIDA"
# Mais de 10 execuções: ficam os 10 logs mais recentes.
for i in $(seq 1 12); do : >"$GENESIS_PASTA/logs/implantar-sem-actions-20260101T0000$(printf %02d "$i")Z-1.log"; done
rodar --sem-conferir-url "$V1"
sucesso "retenção dos logs"
[ "$(find "$GENESIS_PASTA/logs" -name 'implantar-sem-actions-*.log' | wc -l)" = 10 ] &&
  [ ! -e "$GENESIS_PASTA/logs/implantar-sem-actions-20260101T000003Z-1.log" ] ||
  falha "retenção: esperava os 10 logs mais recentes: $(ls "$GENESIS_PASTA/logs")"
GENESIS_SEM_ACTIONS_LOG=$T/forjado.log rodar --sem-conferir-url "$V1"
recusa "execução desacoplada sem a trava" "execução desacoplada sem a trava"
nao_chamou '^git |^docker build ' "execução desacoplada sem a trava"
confere "fora do terminal: o terminal morto (SIGHUP e SIGKILL) no meio do implantar.sh não para a implantação; --acompanhar até o fim e depois; log 600 com os 10 últimos; sem a trava herdada, recusa"

printf '\n\033[1;32mimplantar-sem-actions.sh OK.\033[0m\n'
