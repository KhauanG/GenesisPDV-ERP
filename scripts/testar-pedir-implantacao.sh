#!/usr/bin/env bash
# Testes de unidade do scripts/pedir-implantacao.sh (OP-B4; D70), sem rede e sem criar nada no GitHub: o script é
# copiado para uma raiz falsa (um clone de um repositório local, com a main e um branch "outra"), com dublês do `gh`
# (registra o pedido, nunca cria tag de verdade) e do `curl` (o estado.json e o /saude de mentira, uma resposta por
# consulta). Cobre: argumentos, o commit fora da main e inexistente (recusados antes do gh), o fetch antes da
# conferência (um commit que entrou na main depois do clone), a tag implantar/<AAAAMMDD-HHMMSS> e implantar-pdv/ pela
# API REST, o acompanhamento até ok (com o no_ar_desde que muda), falhou, recusado, um pedido mais novo na frente,
# o estado de um pedido anterior ignorado, a volta para um commit anterior ao OP-B4 (recusada sem o --sem-estado;
# com ele, até a API reiniciar), o tempo limite (sem afirmar que o pedido continua valendo), a falha do gh e o
# --sem-acompanhar.
#
#   bash scripts/testar-pedir-implantacao.sh
# Precisa de bash, git, jq e coreutils.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-pedir-teste.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/duble"
export DUBLE=$T/duble
export PEDIR_INTERVALO=0 PEDIR_TEMPO_LIMITE=30
unset PEDIR_REPO PEDIR_REMOTO PEDIR_API_URL PEDIR_DOWNLOAD_URL
printf '[user]\n\tname = Teste\n\temail = teste@genesis.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n' >"$T/gitconfig"
export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublês -------------------------------------------------------------------------------------------------------
# gh: registra a chamada em $DUBLE/gh e o nome da tag em $DUBLE/tag; $DUBLE/gh-falha faz falhar.
cat >"$T/bin/gh" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DUBLE/gh"
[ ! -e "$DUBLE/gh-falha" ] || exit 1
for a in "$@"; do
  case "$a" in ref=refs/tags/*) printf '%s\n' "${a#ref=refs/tags/}" >"$DUBLE/tag" ;; esac
done
echo '{}'
DUBLE
# curl: o estado.json e o /saude vêm de $DUBLE/estados e $DUBLE/saudes, uma linha por consulta (a última se repete;
# "404" = não servido); PEDIDO na linha vira o nome da tag criada. Cada URL vai para $DUBLE/curl.
cat >"$T/bin/curl" <<'DUBLE'
#!/usr/bin/env bash
url=''
for a in "$@"; do case "$a" in https://*) url=$a ;; esac; done
printf '%s\n' "$url" >>"$DUBLE/curl"
case "$url" in
  https://download.grupoicebeer.com.br/implantacao/estado.json) f=$DUBLE/estados ;;
  https://api.grupoicebeer.com.br/saude) f=$DUBLE/saudes ;;
  *) exit 22 ;;
esac
[ -s "$f" ] || exit 22
linha=$(head -n 1 "$f")
[ "$(wc -l <"$f")" -le 1 ] || sed -i 1d "$f"
[ "$linha" != 404 ] || exit 22
printf '%s\n' "${linha//PEDIDO/$(cat "$DUBLE/tag" 2>/dev/null)}"
DUBLE
chmod +x "$T/bin"/*

# --- Repositório: o remoto (a main e o branch "outra") e a raiz falsa, um clone dele -------------------------------
B=$T/remoto.git
git init -q --bare "$B"
git clone -q "$B" "$T/trabalho" 2>/dev/null
w() { git -C "$T/trabalho" "$@"; }
echo um >"$T/trabalho/LEIAME"
w add -A
w commit -q -m um
w push -q origin main
M1=$(w rev-parse HEAD)
w checkout -q -b outra
echo fora >"$T/trabalho/FORA"
w add -A
w commit -q -m fora
w push -q origin outra
X=$(w rev-parse HEAD)
w checkout -q main
RAIZ=$T/raiz
git clone -q "$B" "$RAIZ"
mkdir -p "$RAIZ/scripts"
cp "$AQUI/pedir-implantacao.sh" "$RAIZ/scripts/"
# Um commit que entra na main depois do clone da raiz: o script tem de buscar a main antes de conferir. É o primeiro
# com o OP-B4 (a rota do estado.json no nginx e a pasta montada no docker-compose.yml); o M1 é anterior.
echo dois >"$T/trabalho/LEIAME"
mkdir -p "$T/trabalho/apps/erp-web/nginx" "$T/trabalho/infra/producao"
printf 'server {\n    location = /implantacao/estado.json {\n        try_files $uri =404;\n    }\n}\n' \
  >"$T/trabalho/apps/erp-web/nginx/genesis.conf"
printf 'services:\n  web:\n    volumes:\n      - ./download/pdv:/srv/download/pdv:ro\n      - ./download/implantacao:/srv/download/implantacao:ro\n' \
  >"$T/trabalho/infra/producao/docker-compose.yml"
w add -A
w commit -q -m dois
w push -q origin main
M2=$(w rev-parse HEAD)
SCRIPT=$RAIZ/scripts/pedir-implantacao.sh
export PATH=$T/bin:$PATH

novo() {
  rm -f "$DUBLE"/*
  printf '%s\n' "${ESTADOS[@]}" >"$DUBLE/estados"
  printf '%s\n' "${SAUDES[@]}" >"$DUBLE/saudes"
}
rodar() {
  novo
  CODIGO=0
  SAIDA=$(bash "$SCRIPT" "$@" 2>&1) || CODIGO=$?
}
sem_gh() { [ ! -e "$DUBLE/gh" ] || falha "$1: não deveria chamar o gh: $(cat "$DUBLE/gh")"; }
tem() { grep -qF -- "$1" <<<"$SAIDA" || falha "$2: sem '$1' na saída: $SAIDA"; }
estado() { printf '{"pedido":"%s","commit":"%s","resultado":"%s","inicio":"2026-11-24T10:00:00Z","fim":%s}' "$1" "${2:0:12}" "$3" "${4:-null}"; }
saude() { printf '{"status":"ok","no_ar_desde":"%s"}' "$1"; }
ESTADOS=(404)
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)")

# --- Argumentos ---------------------------------------------------------------------------------------------------
rodar --ajuda
[ "$CODIGO" = 0 ] && grep -q -- '--publicar-pdv' <<<"$SAIDA" || falha "--ajuda: $SAIDA"
for args in "" "--opcao" "xyz" "${M1:0:6}" "${M1^^}" "$M1 $M2"; do
  # shellcheck disable=SC2086 # os argumentos de cada caso, por palavra
  rodar $args
  [ "$CODIGO" = 1 ] || falha "argumentos '$args' deveriam ser recusados (saiu $CODIGO): $SAIDA"
  sem_gh "argumentos '$args'"
done
confere "argumentos: sem commit, opção desconhecida, commit fora do formato e dois commits são recusados, sem o gh"

rodar "$X"
[ "$CODIGO" = 1 ] || falha "commit fora da main deveria ser recusado: $SAIDA"
tem "não está na main" "commit fora da main"
sem_gh "commit fora da main"
rodar 0123456789abcdef0123456789abcdef01234567
[ "$CODIGO" = 1 ] || falha "commit inexistente deveria ser recusado: $SAIDA"
sem_gh "commit inexistente"
confere "commit de outro branch e commit inexistente: recusados antes de criar o pedido"

# --- Pedido acompanhado até ok ------------------------------------------------------------------------------------
ESTADOS=(404 "$(estado implantar/20261101-000000 "$M1" ok '"2026-11-01T00:10:00Z"')" "$(estado PEDIDO "$M2" recebido)"
  "$(estado PEDIDO "$M2" em_andamento)" "$(estado PEDIDO "$M2" em_andamento)" "$(estado PEDIDO "$M2" ok '"2026-11-24T10:09:00Z"')")
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)"
  "$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-24T10:08:00.000Z)")
rodar "${M2:0:7}"
[ "$CODIGO" = 0 ] || falha "pedido ok deveria sair com 0 (saiu $CODIGO): $SAIDA"
tag=$(cat "$DUBLE/tag")
[[ $tag =~ ^implantar/[0-9]{8}-[0-9]{6}$ ]] || falha "tag fora do formato: $tag"
grep -qxF "api -X POST repos/KhauanG/GenesisPDV-ERP/git/refs -f ref=refs/tags/$tag -f sha=$M2" "$DUBLE/gh" ||
  falha "gh sem a criação da tag pela API REST: $(cat "$DUBLE/gh")"
tem "commit $M2 está na main" "pedido ok"
tem "estado do pedido: recebido" "pedido ok"
tem "estado do pedido: em_andamento" "pedido ok"
tem "a API reiniciou (no_ar_desde: 2026-11-20T00:00:00.000Z → 2026-11-24T10:08:00.000Z)" "pedido ok"
tem "implantação ok: commit ${M2:0:12} no ar (fim: 2026-11-24T10:09:00Z)" "pedido ok"
[ "$(grep -c 'estado do pedido: em_andamento' <<<"$SAIDA")" = 1 ] || falha "o mesmo estado deveria aparecer uma vez: $SAIDA"
grep -q 'implantar/20261101-000000' <<<"$SAIDA" && falha "o estado de um pedido anterior não é o nosso: $SAIDA"
confere "pedido: busca a main (o commit que entrou depois do clone), cria a tag implantar/<data> pela API REST e acompanha até ok (o estado de um pedido anterior ignorado, a API reiniciada)"

ESTADOS=("$(estado PEDIDO "$M2" ok '"2026-11-24T10:09:00Z"')")
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)")
rodar "$M2" --publicar-pdv
[ "$CODIGO" = 0 ] || falha "--publicar-pdv: $SAIDA"
[[ $(cat "$DUBLE/tag") =~ ^implantar-pdv/[0-9]{8}-[0-9]{6}$ ]] || falha "--publicar-pdv sem a tag implantar-pdv/: $(cat "$DUBLE/tag")"
tem "o no_ar_desde da API não mudou" "--publicar-pdv"
confere "--publicar-pdv: tag implantar-pdv/; ok sem a API reiniciar avisa"

# --- Volta para um commit anterior ao OP-B4 (sem o estado.json depois da troca) ----------------------------------
# O que o script procura está nos arquivos de verdade (renomear a rota ou a montagem faria ele recusar todo pedido).
grep -qF 'location = /implantacao/estado.json' "$AQUI/../apps/erp-web/nginx/genesis.conf" &&
  grep -qF './download/implantacao:/srv/download/implantacao' "$AQUI/../infra/producao/docker-compose.yml" ||
  falha "o genesis.conf ou o docker-compose.yml de produção sem a rota ou a montagem que o pedir-implantacao.sh confere"
ESTADOS=(404)
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)")
rodar "$M1"
[ "$CODIGO" = 1 ] || falha "commit anterior ao OP-B4 sem --sem-estado deveria ser recusado (saiu $CODIGO): $SAIDA"
tem "anterior ao OP-B4" "commit anterior ao OP-B4"
tem "--sem-estado" "commit anterior ao OP-B4"
sem_gh "commit anterior ao OP-B4"
# Com --sem-estado: o estado.json responde até a troca (o genesis-web novo ainda no ar) e depois dá 404; o fim é o
# reinício da API.
ESTADOS=("$(estado PEDIDO "$M1" recebido)" "$(estado PEDIDO "$M1" em_andamento)" 404)
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)"
  "$(saude 2026-11-24T10:08:00.000Z)")
rodar "$M1" --sem-estado
[ "$CODIGO" = 2 ] || falha "--sem-estado deveria sair com 2 quando a API reinicia (saiu $CODIGO): $SAIDA"
[ -s "$DUBLE/tag" ] || falha "--sem-estado sem o pedido"
tem "anterior ao OP-B4 (--sem-estado)" "--sem-estado"
tem "estado do pedido: em_andamento" "--sem-estado"
tem "a API reiniciou" "--sem-estado"
tem "a troca de versão aconteceu" "--sem-estado"
tem "instalar-vigia.sh --estado" "--sem-estado"
# Um commit com o OP-B4 ignora o --sem-estado: espera o ok do estado.json, como sempre.
ESTADOS=("$(estado PEDIDO "$M2" em_andamento)" "$(estado PEDIDO "$M2" ok '"2026-11-24T10:09:00Z"')")
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-24T10:08:00.000Z)")
rodar "$M2" --sem-estado
[ "$CODIGO" = 0 ] || falha "--sem-estado num commit com o OP-B4 deveria esperar o ok (saiu $CODIGO): $SAIDA"
tem "implantação ok" "--sem-estado num commit com o OP-B4"
confere "volta para um commit anterior ao OP-B4: recusada sem --sem-estado (sem o gh); com ele, acompanha até a API reiniciar e sai com 2"

# --- Falhou, recusado, pulado, tempo limite, gh fora, --sem-acompanhar ---------------------------------------------
for r in falhou recusado; do
  ESTADOS=("$(estado PEDIDO "$M2" em_andamento)" "$(estado PEDIDO "$M2" "$r" '"2026-11-24T10:09:00Z"')")
  rodar "$M2"
  [ "$CODIGO" = 1 ] || falha "$r deveria sair com 1 (saiu $CODIGO): $SAIDA"
  tem "implantação $r" "$r"
done
ESTADOS=("$(estado implantar/29991231-235959 "$M1" em_andamento)")
rodar "$M2"
[ "$CODIGO" = 1 ] || falha "pedido mais novo na frente deveria sair com 1: $SAIDA"
tem "passou na frente" "pulado"
ESTADOS=(404)
PEDIR_TEMPO_LIMITE=0 rodar "$M2"
[ "$CODIGO" = 3 ] || falha "tempo limite deveria sair com 3 (saiu $CODIGO): $SAIDA"
tem "tempo limite" "tempo limite"
tem "o vigia desligado" "tempo limite"
tem "instalar-vigia.sh --estado" "tempo limite"
grep -q 'continua valendo' <<<"$SAIDA" && falha "tempo limite não pode afirmar que o pedido continua valendo: $SAIDA"
novo
touch "$DUBLE/gh-falha"
CODIGO=0
SAIDA=$(bash "$SCRIPT" "$M2" 2>&1) || CODIGO=$?
[ "$CODIGO" = 1 ] || falha "falha do gh deveria sair com 1: $SAIDA"
tem "não foi possível criar a tag" "falha do gh"
grep -q 'implantacao/estado.json' "$DUBLE/curl" && falha "falha do gh não deveria acompanhar"
rodar "$M2" --sem-acompanhar
[ "$CODIGO" = 0 ] || falha "--sem-acompanhar: $SAIDA"
[ -s "$DUBLE/tag" ] || falha "--sem-acompanhar sem o pedido"
grep -q 'implantacao/estado.json' "$DUBLE/curl" && falha "--sem-acompanhar não deveria ler o estado.json"
confere "falhou e recusado saem com 1; pedido mais novo na frente (o nosso pulado) sai com 1; tempo limite com 3; gh fora do ar sem acompanhar; --sem-acompanhar só cria o pedido"

printf '\n\033[1;32mpedir-implantacao.sh: todos os testes passaram.\033[0m\n'
