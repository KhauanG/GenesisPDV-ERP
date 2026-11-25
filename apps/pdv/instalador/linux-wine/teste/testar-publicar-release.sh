#!/usr/bin/env bash
# Testes de unidade do publicar-release.sh (OP-B3; README do PDV › decisão 93), sem tocar no GitHub: o script roda numa
# raiz falsa (um clone git de um "origin" local, com a main e um branch), com um instalador inventado e dublês do `gh`
# (que guarda num diretório o estado da tag e do release) e do `curl` no PATH. Cobre: a ordem das chamadas (lê a tag e
# os releases, cria a tag, o release em rascunho, envia o .exe e o .sha256 em uploads.github.com, confere os arquivos,
# publica o rascunho e baixa de volta o .exe público), o --simular só com leituras, as recusas antes de qualquer
# escrita (commit fora da main, versão diferente da do Directory.Build.props do commit, tag em outro commit — leve ou
# anotada —, release publicado com arquivos, sem o .conferido ou a origem, árvore suja, .sha256 fora do formato ou
# errado, --commit diferente do da origem, erro da API que não é 404, URL da API que não é a de produção na origem ou
# na conferência, assinatura, .NET ausente ou mais velho que o da referência, conferência sem referência ou contra
# outra que não o último release publicado, sha256 da referência diferente do publicado, workflow "PDV release"
# ligado sem --aceitar-disparo), o --aceitar-referencia, o --aceitar-disparo, o GENESIS_URL_API_RELEASE, o primeiro
# release (sem release anterior), a tag anotada no mesmo commit e o release publicado sem arquivos (volta para
# rascunho antes dos envios; com falha no envio, fica em rascunho e a segunda execução completa), o rascunho de uma
# execução interrompida (tira os arquivos parciais), a falha no envio (o release fica em rascunho) e o download
# público que não confere; a escrita recusada com HTTP 403 (a rede da sessão, D120) com o aviso do caminho manual. E
# o preparo do release pelo site (OP-B8, preparar-release-manual.sh): a pasta com os dois arquivos, as notas e o passo
# a passo (o link do formulário, o estado do workflow, a tag e o rascunho que já existam), as recusas do preparo (fora
# da main, versão, sem conferência, árvore suja, release publicado com arquivos, pasta com outros arquivos, opções da
# publicação), e a conferência do que o dono publicou (a tag, o rascunho, o pre-release, os arquivos, o download
# público e a página de download), tudo sem escrita.
#
#   bash apps/pdv/instalador/linux-wine/teste/testar-publicar-release.sh
# Precisa de bash, git, jq e coreutils.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-publicar-release.XXXXXX")
trap 'rm -rf "$T"' EXIT
export REGISTRO=$T/registro DUBLE=$T/duble GENESIS_REPO=dono-teste/repo-teste GENESIS_URL_DOWNLOAD=https://download.exemplo.invalid
BIN=$T/bin
mkdir -p "$BIN" "$DUBLE"
unset GH_TOKEN GITHUB_TOKEN

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  [[ -f $T/saida ]] && sed 's/^/    | /' "$T/saida" >&2
  [[ -f $REGISTRO ]] && sed 's/^/    registro| /' "$REGISTRO" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
git_t() { git -c user.name=teste -c user.email=teste@exemplo.invalid -c init.defaultBranch=main -c push.negotiate=false "$@"; }

# --- Raiz falsa: origin com a main (0.13.0 e depois 0.14.0) e um branch fora dela ------------------------------------
git_t init -q --bare "$T/origem.git"
git_t clone -q "$T/origem.git" "$T/raiz" 2>/dev/null
RAIZ=$T/raiz
mkdir -p "$RAIZ/apps/pdv/instalador/linux-wine"
cp "$AQUI/../publicar-release.sh" "$AQUI/../preparar-release-manual.sh" "$RAIZ/apps/pdv/instalador/linux-wine/"
printf 'apps/pdv/publish/\n' >"$RAIZ/.gitignore"
props() { printf '<Project>\n  <PropertyGroup>\n    <Version>%s</Version>\n  </PropertyGroup>\n</Project>\n' "$1" >"$RAIZ/apps/pdv/Directory.Build.props"; }
props 0.13.0
git_t -C "$RAIZ" add -A
git_t -C "$RAIZ" commit -qm 'versão 0.13.0'
C_013=$(git -C "$RAIZ" rev-parse HEAD)
props 0.14.0
git_t -C "$RAIZ" commit -qam 'versão 0.14.0'
C_014=$(git -C "$RAIZ" rev-parse HEAD)
git_t -C "$RAIZ" push -q origin main
git_t -C "$RAIZ" checkout -qb outro
echo x >"$RAIZ/x.txt"
git_t -C "$RAIZ" add x.txt
git_t -C "$RAIZ" commit -qm 'fora da main'
C_FORA=$(git -C "$RAIZ" rev-parse HEAD)
git_t -C "$RAIZ" checkout -q main
# Commit só no origin (outra pessoa juntou): o script tem de buscar a origin/main antes de conferir.
git_t clone -q "$T/origem.git" "$T/outro-clone" 2>/dev/null
echo y >"$T/outro-clone/y.txt"
git_t -C "$T/outro-clone" add y.txt
git_t -C "$T/outro-clone" commit -qm 'juntado por outra pessoa'
git_t -C "$T/outro-clone" push -q origin main
C_REMOTO=$(git -C "$T/outro-clone" rev-parse HEAD)
[[ $(git -C "$RAIZ" rev-parse origin/main) == "$C_014" ]] # a origin/main deste clone ainda não tem o C_REMOTO

PASTA=$RAIZ/apps/pdv/publish/instalador
NOME=GenesisPDV-Setup-0.14.0.exe
mkdir -p "$PASTA"
head -c 4096 /dev/urandom >"$PASTA/$NOME"
HASH=$(sha256sum "$PASTA/$NOME" | cut -d' ' -f1)
# sha256 do instalador do pdv-v0.13.0 e do pdv-v0.12.0 "publicados" (o .sha256 que o curl falso entrega).
export HASH_013=1313131313131313131313131313131313131313131313131313131313131313
export HASH_012=1212121212121212121212121212121212121212121212121212121212121212
URL_PROD=https://api.grupoicebeer.com.br
# Instalador "gerado e conferido" de um commit, com a árvore limpa ou não, conferido contra o 0.13.0 publicado.
preparar() {
  local commit=$1 limpa=${2:-true}
  (cd "$PASTA" && sha256sum "$NOME" >"$NOME.sha256")
  jq -n --arg c "$commit" --arg h "$HASH" --argjson l "$limpa" --arg u "$URL_PROD" \
    '{versao: "0.14.0", url_api_padrao: $u, commit: $c, arvore_limpa: $l, sha256: $h, inno_setup: "6.4.3",
      dotnet: "10.0.15"}' >"$PASTA/$NOME.origem.json"
  jq -n --arg h "$HASH" --arg u "$URL_PROD" --arg r "$HASH_013" \
    '{versao: "0.14.0", sha256: $h, url_api: $u, referencia: "0.13.0", referencia_sha256: $r,
      dotnet: "10.0.1526.53008", dotnet_referencia: "10.0.1526.53008", assinatura: "nenhuma",
      assinatura_referencia: "nenhuma"}' >"$PASTA/$NOME.conferido"
}
# Troca campos do .conferido ou da origem: conferido '.dotnet = "x"'.
conferido() { jq "$1" "$PASTA/$NOME.conferido" >"$T/c" && mv "$T/c" "$PASTA/$NOME.conferido"; }
origem() { jq "$1" "$PASTA/$NOME.origem.json" >"$T/c" && mv "$T/c" "$PASTA/$NOME.origem.json"; }

# --- Dublês -----------------------------------------------------------------------------------------------------------
# gh api: o estado fica em $DUBLE (ref.json = a tag; anotada.json = o objeto da tag anotada; release.json = o release
# com os arquivos). $DUBLE/erro-500: a leitura da tag falha com 500; $DUBLE/falhar-envio-<nome>: o envio desse falha.
# A lista de releases traz também o pdv-v0.13.0 e o pdv-v0.12.0 publicados e um pdv-v0.15.0 em rascunho (que não
# conta), a não ser com $DUBLE/sem-anteriores. O workflow pdv-release.yml está desligado ("disabled_manually"), a não
# ser com $DUBLE/workflow-ativo ou $DUBLE/workflow-404. $DUBLE/escrita-403: toda escrita é recusada com 403 (como a
# rede da sessão desde a D120).
cat >"$BIN/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >>"$REGISTRO"
[[ $1 == api ]] || { echo "dublê: só gh api" >&2; exit 2; }
shift
metodo=GET url='' entrada='' campos=()
while (($#)); do
  case "$1" in
    --method) metodo=$2; shift 2 ;;
    -H) shift 2 ;;
    --input) entrada=$2; shift 2 ;;
    --paginate) shift ;;
    -f | -F) campos+=("$2"); shift 2 ;;
    *) url=$1; shift ;;
  esac
done
R=repos/dono-teste/repo-teste
[[ $metodo != GET && -e $DUBLE/escrita-403 ]] && { echo 'gh: Forbidden (HTTP 403)' >&2; exit 1; }
nao_achou() { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
campo() { local c; for c in "${campos[@]}"; do [[ $c == "$1="* ]] && { echo "${c#*=}"; return; }; done; }
case "$metodo $url" in
  "GET $R/git/ref/tags/pdv-v0.14.0")
    [[ -e $DUBLE/erro-500 ]] && { echo 'gh: Server Error (HTTP 500)' >&2; exit 1; }
    [[ -f $DUBLE/ref.json ]] && cat "$DUBLE/ref.json" || nao_achou ;;
  "GET $R/git/tags/"*) cat "$DUBLE/anotada.json" ;;
  "GET $R/releases?per_page=100")
    if [[ -e $DUBLE/sem-anteriores ]]; then anteriores='[]'; else
      anteriores='[{"id": 13, "tag_name": "pdv-v0.13.0", "draft": false, "prerelease": false, "assets": []},
        {"id": 12, "tag_name": "pdv-v0.12.0", "draft": false, "prerelease": false, "assets": []},
        {"id": 15, "tag_name": "pdv-v0.15.0", "draft": true, "prerelease": false, "assets": []}]'
    fi
    if [[ -f $DUBLE/release.json ]]; then jq -c --argjson a "$anteriores" '[.] + $a' "$DUBLE/release.json"; else jq -c . <<<"$anteriores"; fi ;;
  "GET $R/actions/workflows/pdv-release.yml")
    [[ -e $DUBLE/workflow-404 ]] && nao_achou
    if [[ -e $DUBLE/workflow-ativo ]]; then echo '{"state": "active"}'; else echo '{"state": "disabled_manually"}'; fi ;;
  "GET $R/releases/77/assets?per_page=100") jq -c .assets "$DUBLE/release.json" ;;
  "POST $R/git/refs")
    jq -n --arg s "$(campo sha)" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
    cat "$DUBLE/ref.json" ;;
  "POST $R/releases")
    jq -n --arg t "$(campo tag_name)" '{id: 77, tag_name: $t, draft: true, assets: []}' >"$DUBLE/release.json"
    cat "$DUBLE/release.json" ;;
  "POST https://uploads.github.com/$R/releases/77/assets?name="*)
    nome=${url##*name=}
    [[ -e $DUBLE/falhar-envio-$nome ]] && { echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1; }
    jq --arg n "$nome" --argjson t "$(stat -c %s "$entrada")" \
      '.assets += [{id: (100 + (.assets | length)), name: $n, size: $t, state: "uploaded"}]' "$DUBLE/release.json" >"$DUBLE/r.tmp"
    mv "$DUBLE/r.tmp" "$DUBLE/release.json"
    echo '{}' ;;
  "DELETE $R/releases/assets/"*)
    jq --argjson i "${url##*/}" '.assets |= map(select(.id != $i))' "$DUBLE/release.json" >"$DUBLE/r.tmp"
    mv "$DUBLE/r.tmp" "$DUBLE/release.json" ;;
  "PATCH $R/releases/77")
    jq --argjson d "$(campo draft)" '.draft = $d' "$DUBLE/release.json" >"$DUBLE/r.tmp"
    mv "$DUBLE/r.tmp" "$DUBLE/release.json"
    echo '{}' ;;
  *) echo "dublê do gh: chamada inesperada: $metodo $url" >&2; exit 3 ;;
esac
EOF
# curl: o download público devolve o .exe do release ($DUBLE/curl-corrompido: outro conteúdo), o .sha256 dele
# ($DUBLE/curl-sha256-outro: outra linha) e o dos releases 0.13.0 e 0.12.0; a página de download, o $DUBLE/atual.json
# (sem ele, 404).
cat >"$BIN/curl" <<EOF
#!/usr/bin/env bash
echo "curl \$*" >>"\$REGISTRO"
saida='' url=''
while ((\$#)); do case \$1 in -o) saida=\$2; shift ;; https://*) url=\$1 ;; esac; shift; done
case "\$url" in
  */pdv-v0.13.0/GenesisPDV-Setup-0.13.0.exe.sha256) echo "\$HASH_013  GenesisPDV-Setup-0.13.0.exe" >"\$saida" ;;
  */pdv-v0.12.0/GenesisPDV-Setup-0.12.0.exe.sha256) echo "\$HASH_012  GenesisPDV-Setup-0.12.0.exe" >"\$saida" ;;
  */pdv-v0.14.0/$NOME.sha256)
    if [[ -e \$DUBLE/curl-sha256-outro ]]; then echo "\$HASH_013  $NOME" >"\$saida"; else cp "$PASTA/$NOME.sha256" "\$saida"; fi ;;
  https://download.exemplo.invalid/pdv/atual.json) [[ -f \$DUBLE/atual.json ]] && cp "\$DUBLE/atual.json" "\$saida" || exit 22 ;;
  */pdv-v0.14.0/$NOME)
    if [[ -e \$DUBLE/curl-corrompido ]]; then echo outro >"\$saida"; else cp "$PASTA/$NOME" "\$saida"; fi ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$BIN"/*

PR="$RAIZ/apps/pdv/instalador/linux-wine/publicar-release.sh"
rodar() {
  : >"$REGISTRO"
  STATUS=0
  env PATH="$BIN:$PATH" "$PR" "$@" >"$T/saida" 2>&1 || STATUS=$?
}
zerar() { rm -f "$DUBLE"/*; }
linha() { { grep -nF -- "$1" "$REGISTRO" || true; } | head -n 1 | cut -d: -f1; }
em_ordem() {
  local anterior=0 n m
  for m in "$@"; do
    n=$(linha "$m")
    [[ -n $n ]] || falha "não chamou: $m"
    ((n > anterior)) || falha "fora de ordem: $m (linha $n do registro, depois da $anterior)"
    anterior=$n
  done
}
sem_escrita() { ! grep -q -- '--method' "$REGISTRO" || falha "$1: escreveu no GitHub"; }
recusa() {
  local motivo=$1 texto=$2
  shift 2
  rodar "$@"
  [[ $STATUS == 1 ]] || falha "$motivo: saiu com $STATUS (esperado 1)"
  grep -qF -- "$texto" "$T/saida" || falha "$motivo: sem a mensagem '$texto'"
  sem_escrita "$motivo"
}

# 1. Nada no GitHub: tag, rascunho, os dois envios, conferência, publicação e o download público.
zerar
preparar "$C_014"
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "caminho feliz saiu com $STATUS"
em_ordem 'gh api repos/dono-teste/repo-teste/git/ref/tags/pdv-v0.14.0' \
  'gh api --paginate repos/dono-teste/repo-teste/releases?per_page=100' \
  'releases/download/pdv-v0.13.0/GenesisPDV-Setup-0.13.0.exe.sha256' \
  'gh api repos/dono-teste/repo-teste/actions/workflows/pdv-release.yml' \
  "gh api --method POST repos/dono-teste/repo-teste/git/refs -f ref=refs/tags/pdv-v0.14.0 -f sha=$C_014" \
  "gh api --method POST repos/dono-teste/repo-teste/releases -f tag_name=pdv-v0.14.0 -f target_commitish=$C_014 -f name=GenesisPDV 0.14.0 -f body=GenesisPDV 0.14.0 para Windows: $NOME (instale por cima da versão anterior: banco, backups e ativação ficam). Confira o .exe.sha256 antes de instalar (README do PDV › Instalar na loja). -F draft=true" \
  "gh api --method POST -H Content-Type: application/octet-stream --input $PASTA/$NOME https://uploads.github.com/repos/dono-teste/repo-teste/releases/77/assets?name=$NOME" \
  "gh api --method POST -H Content-Type: application/octet-stream --input $PASTA/$NOME.sha256 https://uploads.github.com/repos/dono-teste/repo-teste/releases/77/assets?name=$NOME.sha256" \
  'gh api repos/dono-teste/repo-teste/releases/77/assets?per_page=100' \
  'gh api --method PATCH repos/dono-teste/repo-teste/releases/77 -F draft=false' \
  "releases/download/pdv-v0.14.0/$NOME"
grep -qF "https://github.com/dono-teste/repo-teste/releases/download/pdv-v0.14.0/$NOME" "$REGISTRO" || falha 'baixou de outro endereço'
grep -qF 'https://github.com/dono-teste/repo-teste/releases/download/pdv-v0.13.0/GenesisPDV-Setup-0.13.0.exe.sha256' "$REGISTRO" ||
  falha 'não conferiu a referência com o .sha256 do pdv-v0.13.0 publicado'
grep -q 'conferido contra o release pdv-v0.13.0 publicado' "$T/saida" || falha 'sem dizer contra que release foi conferido'
[[ $(jq -r '.draft' "$DUBLE/release.json") == false ]] || falha 'o release ficou em rascunho'
[[ $(jq -c '[.assets[].name]' "$DUBLE/release.json") == "[\"$NOME\",\"$NOME.sha256\"]" ]] || falha 'os arquivos do release'
grep -q 'download público conferido' "$T/saida" || falha 'sem a conferência do download'
grep -q -- '--publicar-pdv' "$T/saida" || falha 'sem o próximo passo (implantação com --publicar-pdv)'
# O commit C_REMOTO (só no origin) prova que o script buscou a origin/main antes de conferir.
[[ $(git -C "$RAIZ" rev-parse origin/main) == "$C_REMOTO" ]] || falha 'não buscou a origin/main (git fetch origin main)'
confere 'nada no GitHub: busca a main, cria a tag, o rascunho, envia os dois, confere, publica e baixa de volta'

# 2. --simular: só leituras.
zerar
preparar "$C_014"
rodar 0.14.0 --simular
[[ $STATUS == 0 ]] || falha "--simular saiu com $STATUS"
sem_escrita '--simular'
if ! grep -q 'seria criada no commit' "$T/saida" || ! grep -q 'seria criado em rascunho' "$T/saida"; then
  falha '--simular não diz o que faria'
fi
grep -q "^curl .*$NOME\$" "$REGISTRO" && falha '--simular baixou o instalador'
grep -q 'workflow pdv-release.yml: disabled_manually' "$T/saida" || falha '--simular não diz o estado do workflow'
confere '--simular: só as leituras e o que faria'

# 3. Recusas antes de qualquer escrita.
zerar
preparar "$C_FORA"
recusa 'commit fora da main' 'não está na main' 0.14.0
preparar "$C_013"
recusa 'versão do Directory.Build.props' 'diz <Version>0.13.0</Version>, não 0.14.0' 0.14.0
preparar "$C_014"
recusa '--commit diferente' "o instalador é do commit $C_014, não do $C_013" 0.14.0 --commit "$C_013"
recusa 'versão inválida' 'informe a versão X.Y.Z' 0.14
recusa 'instalador de outra versão' 'GenesisPDV-Setup-0.15.0.exe' 0.15.0 --instalador "$PASTA/$NOME"
preparar "$C_014" false
recusa 'árvore suja' 'alterações não commitadas' 0.14.0
preparar "$C_014"
rm "$PASTA/$NOME.conferido"
recusa 'sem o .conferido' 'testar-instalador.sh' 0.14.0
preparar "$C_014"
jq '.sha256 = "0000"' "$PASTA/$NOME.conferido" >"$T/c" && mv "$T/c" "$PASTA/$NOME.conferido"
recusa '.conferido de outro arquivo' 'testar-instalador.sh' 0.14.0
preparar "$C_014"
rm "$PASTA/$NOME.origem.json"
recusa 'sem a origem' 'gerar-instalador.sh' 0.14.0
preparar "$C_014"
printf '%s *%s\n' "$HASH" "$NOME" >"$PASTA/$NOME.sha256"
recusa '.sha256 fora do formato' 'fora do formato do sha256sum' 0.14.0
preparar "$C_014"
printf '%064d  %s\n' 0 "$NOME" >"$PASTA/$NOME.sha256"
recusa '.sha256 errado' 'não confere' 0.14.0
preparar "$C_014"
jq -n --arg s "$C_013" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
recusa 'tag em outro commit' "já existe no commit $C_013" 0.14.0
jq -n '{object: {type: "tag", sha: "aaaa"}}' >"$DUBLE/ref.json"
jq -n --arg s "$C_013" '{object: {type: "commit", sha: $s}}' >"$DUBLE/anotada.json"
recusa 'tag anotada em outro commit' "já existe no commit $C_013" 0.14.0
zerar
jq -n '{id: 77, tag_name: "pdv-v0.14.0", draft: false, assets: [{id: 1, name: "x", size: 1, state: "uploaded"}]}' >"$DUBLE/release.json"
recusa 'release publicado com arquivos' 'já está publicado com 1 arquivo(s)' 0.14.0
zerar
touch "$DUBLE/erro-500"
recusa 'erro da API (500)' 'a API do GitHub recusou' 0.14.0
confere 'recusas sem escrever: fora da main, versão, --commit, origem, conferência, árvore suja, .sha256, tag, release, erro 500'

# 3b. Recusas do que a conferência garante: URL da API, assinatura, .NET, referência; e o workflow ligado.
zerar
preparar "$C_014"
origem '.url_api_padrao = "https://homologacao.exemplo.invalid"'
conferido '.url_api = "https://homologacao.exemplo.invalid"'
recusa 'instalador de homologação' "gerado com a API padrão 'https://homologacao.exemplo.invalid'" 0.14.0
preparar "$C_014"
conferido '.url_api = "https://homologacao.exemplo.invalid"'
recusa 'conferência com outra URL' "a conferência ($NOME.conferido) diz a API" 0.14.0
preparar "$C_014"
conferido 'del(.url_api)'
recusa 'conferência sem a URL (versão antiga do teste)' 'diz a API' 0.14.0
preparar "$C_014"
conferido '.assinatura = "?"'
recusa 'assinatura não conferida' 'não diz assinatura "nenhuma"' 0.14.0
preparar "$C_014"
conferido '.assinatura_referencia = "assinado"'
recusa 'referência assinada' 'é assinado' 0.14.0
preparar "$C_014"
conferido 'del(.dotnet)'
recusa 'sem o .NET conferido' 'não traz o .NET embutido' 0.14.0
preparar "$C_014"
conferido '.dotnet = "10.0.25.1"'
recusa '.NET mais velho que o da referência' 'mais velho que o do 0.13.0 publicado (10.0.1526.53008)' 0.14.0
preparar "$C_014"
conferido '.referencia = "" | .referencia_sha256 = "" | .dotnet_referencia = "" | .assinatura_referencia = ""'
recusa 'conferência sem referência (--sem-referencia)' 'sem o release de referência, e o último publicado é o pdv-v0.13.0' 0.14.0
preparar "$C_014"
conferido ".referencia = \"0.12.0\" | .referencia_sha256 = \"$HASH_012\""
recusa 'conferência contra um release antigo' 'contra o 0.12.0, e a referência esperada é 0.13.0' 0.14.0
recusa '--aceitar-referencia de um rascunho' 'não há release pdv-v0.15.0 publicado' 0.14.0 --aceitar-referencia 0.15.0
preparar "$C_014"
conferido ".referencia_sha256 = \"$HASH_012\""
recusa 'referência local que não é a publicada' 'não é o do release pdv-v0.13.0 publicado' 0.14.0
preparar "$C_014"
touch "$DUBLE/workflow-ativo"
recusa 'workflow PDV release ligado' 'está ligado, e criar a tag pdv-v0.14.0 o dispara' 0.14.0
recusa 'workflow ligado (--simular também)' 'rode com --aceitar-disparo' 0.14.0 --simular
zerar
preparar "$C_014"
GENESIS_URL_API_RELEASE=http://api.exemplo.invalid recusa 'GENESIS_URL_API_RELEASE sem https' 'GENESIS_URL_API_RELEASE inválida' 0.14.0
confere 'recusas sem escrever: URL de homologação, assinatura, .NET, referência ausente, antiga ou local, workflow ligado'

# 3c. O que se aceita com escolha explícita.
zerar
preparar "$C_014"
conferido ".referencia = \"0.12.0\" | .referencia_sha256 = \"$HASH_012\""
rodar 0.14.0 --aceitar-referencia 0.12.0 --simular
[[ $STATUS == 0 ]] || falha "--aceitar-referencia 0.12.0 saiu com $STATUS"
grep -q 'referência aceita: o 0.12.0 publicado, não o último (pdv-v0.13.0)' "$T/saida" || falha 'sem o aviso da referência aceita'
preparar "$C_014"
touch "$DUBLE/workflow-ativo"
rodar 0.14.0 --aceitar-disparo
[[ $STATUS == 0 ]] || falha "--aceitar-disparo saiu com $STATUS"
grep -q 'aviso: --aceitar-disparo: criar a tag pdv-v0.14.0 dispara o "PDV release"' "$T/saida" || falha 'sem o aviso do disparo'
em_ordem 'actions/workflows/pdv-release.yml' 'git/refs'
zerar
touch "$DUBLE/workflow-404"
preparar "$C_014"
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "sem o workflow no repositório saiu com $STATUS"
zerar
touch "$DUBLE/sem-anteriores"
preparar "$C_014"
conferido '.referencia = "" | .referencia_sha256 = "" | .dotnet_referencia = "" | .assinatura_referencia = ""'
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "primeiro release (sem anterior) saiu com $STATUS"
grep -q 'nenhum release pdv-v\* publicado' "$T/saida" || falha 'primeiro release: sem o aviso'
rm -f "$DUBLE/release.json" "$DUBLE/ref.json"
preparar "$C_014"
rodar 0.14.0 --simular
[[ $STATUS == 1 ]] && grep -q 'a referência esperada é nenhuma' "$T/saida" || falha 'sem release anterior, aceitou a referência 0.13.0'
zerar
preparar "$C_014"
origem '.url_api_padrao = "https://api.outra.exemplo.invalid"'
conferido '.url_api = "https://api.outra.exemplo.invalid"'
GENESIS_URL_API_RELEASE=https://api.outra.exemplo.invalid rodar 0.14.0 --simular
[[ $STATUS == 0 ]] || falha "GENESIS_URL_API_RELEASE saiu com $STATUS"
confere 'aceitos: --aceitar-referencia (outro publicado), --aceitar-disparo, sem o workflow, primeiro release, GENESIS_URL_API_RELEASE'

# 4. Tag anotada no mesmo commit e release publicado sem arquivos: volta para rascunho, envia os dois e publica, sem
# recriar a tag nem o release (e sem ler o estado do workflow: a tag já existe, nada é disparado).
zerar
preparar "$C_014"
touch "$DUBLE/workflow-ativo"
jq -n '{object: {type: "tag", sha: "bbbb"}}' >"$DUBLE/ref.json"
jq -n --arg s "$C_014" '{object: {type: "commit", sha: $s}}' >"$DUBLE/anotada.json"
jq -n '{id: 77, tag_name: "pdv-v0.14.0", draft: false, prerelease: false, assets: []}' >"$DUBLE/release.json"
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "release publicado sem arquivos saiu com $STATUS"
em_ordem 'gh api repos/dono-teste/repo-teste/git/tags/bbbb' 'gh api --method PATCH repos/dono-teste/repo-teste/releases/77 -F draft=true' \
  "assets?name=$NOME" "assets?name=$NOME.sha256" 'gh api --method PATCH repos/dono-teste/repo-teste/releases/77 -F draft=false'
grep -q 'git/refs\|POST repos/dono-teste/repo-teste/releases \|actions/workflows' "$REGISTRO" &&
  falha 'recriou a tag ou o release, ou leu o workflow com a tag já criada'
[[ $(jq -r .draft "$DUBLE/release.json") == false && $(jq '.assets | length' "$DUBLE/release.json") == 2 ]] || falha 'o release não ficou certo'
confere 'tag anotada no mesmo commit e release publicado sem arquivos: volta para rascunho, envia os dois e publica'

# 4b. Release publicado sem arquivos e o envio do .sha256 que falha: fica em rascunho (o .exe sozinho não fica à
# vista) e a mensagem diz isso; a segunda execução tira o .exe parcial e completa.
zerar
preparar "$C_014"
jq -n --arg s "$C_014" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
jq -n '{id: 77, tag_name: "pdv-v0.14.0", draft: false, prerelease: false, assets: []}' >"$DUBLE/release.json"
touch "$DUBLE/falhar-envio-$NOME.sha256"
rodar 0.14.0
[[ $STATUS == 1 ]] || falha "publicado sem arquivos + falha no envio saiu com $STATUS"
grep -q 'continua em rascunho' "$T/saida" || falha 'sem dizer que o release ficou em rascunho'
[[ $(jq -r .draft "$DUBLE/release.json") == true ]] || falha 'o release publicado ficou à vista com um arquivo só'
rm -f "$DUBLE/falhar-envio-$NOME.sha256"
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "segunda execução depois da falha saiu com $STATUS"
em_ordem 'gh api --method DELETE repos/dono-teste/repo-teste/releases/assets/100' "assets?name=$NOME.sha256" \
  'gh api --method PATCH repos/dono-teste/repo-teste/releases/77 -F draft=false'
[[ $(jq -r .draft "$DUBLE/release.json") == false && $(jq -c '[.assets[].name]' "$DUBLE/release.json") == "[\"$NOME\",\"$NOME.sha256\"]" ]] ||
  falha "o release não ficou certo: $(jq -c . "$DUBLE/release.json")"
confere 'publicado sem arquivos com falha no envio: fica em rascunho e a segunda execução completa'

# 5. Rascunho de uma execução interrompida (com um arquivo pela metade): tira o parcial, envia os dois e publica.
zerar
preparar "$C_014"
jq -n --arg s "$C_014" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
jq -n --arg n "$NOME" '{id: 77, tag_name: "pdv-v0.14.0", draft: true, assets: [{id: 9, name: $n, size: 10, state: "starter"}]}' >"$DUBLE/release.json"
rodar 0.14.0
[[ $STATUS == 0 ]] || falha "rascunho interrompido saiu com $STATUS"
em_ordem 'gh api --method DELETE repos/dono-teste/repo-teste/releases/assets/9' "assets?name=$NOME" \
  "assets?name=$NOME.sha256" 'gh api --method PATCH repos/dono-teste/repo-teste/releases/77 -F draft=false'
grep -q 'git/refs\|POST repos/dono-teste/repo-teste/releases ' "$REGISTRO" && falha 'recriou a tag ou o release'
[[ $(jq '.assets | length' "$DUBLE/release.json") == 2 && $(jq -r .draft "$DUBLE/release.json") == false ]] || falha 'o rascunho não ficou certo'
confere 'rascunho interrompido: tira o arquivo parcial, envia os dois e publica'

# 6. Falha no envio do .sha256: sai com erro e o release fica em rascunho (nunca publicado pela metade).
zerar
preparar "$C_014"
touch "$DUBLE/falhar-envio-$NOME.sha256"
rodar 0.14.0
[[ $STATUS == 1 ]] || falha "falha no envio saiu com $STATUS"
grep -q 'continua em rascunho' "$T/saida" || falha 'sem dizer que o release ficou em rascunho'
grep -q 'PATCH' "$REGISTRO" && falha 'publicou o rascunho depois da falha no envio'
[[ $(jq -r .draft "$DUBLE/release.json") == true ]] || falha 'o release não ficou em rascunho'
confere 'falha no envio: saída 1 e o release em rascunho'

# 7. O download público não confere: saída 1 com o aviso.
zerar
preparar "$C_014"
touch "$DUBLE/curl-corrompido"
rodar 0.14.0
[[ $STATUS == 1 ]] || falha "download corrompido saiu com $STATUS"
grep -q 'não tem o sha256' "$T/saida" || falha 'sem o aviso do download que não confere'
confere 'download público que não confere: saída 1 com o aviso'

# 8. A publicação pela sessão com a escrita recusada (HTTP 403, a rede da sessão; D120): saída 1 e o aviso do caminho
# manual, sem tentar outra coisa.
zerar
preparar "$C_014"
touch "$DUBLE/escrita-403"
rodar 0.14.0
[[ $STATUS == 1 ]] || falha "escrita recusada com 403 saiu com $STATUS"
grep -qF 'escrita recusada (HTTP 403)' "$T/saida" || falha 'sem o aviso da escrita recusada'
grep -qF 'preparar-release-manual.sh 0.14.0' "$T/saida" || falha 'o aviso não aponta o caminho manual'
[[ $(grep -c -- '--method' "$REGISTRO") == 1 ]] || falha 'tentou outra escrita depois da recusa'
confere 'escrita recusada com 403: saída 1 e o aviso do caminho manual (preparar-release-manual.sh)'

# 9. Preparo do release pelo site (OP-B8): a pasta com os dois arquivos, as notas e o passo a passo, sem escrita.
PM="$RAIZ/apps/pdv/instalador/linux-wine/preparar-release-manual.sh"
SAIDA_PADRAO=$RAIZ/apps/pdv/publish/release-manual/pdv-v0.14.0
NOTAS="GenesisPDV 0.14.0 para Windows: $NOME (instale por cima da versão anterior: banco, backups e ativação ficam). Confira o .exe.sha256 antes de instalar (README do PDV › Instalar na loja)."
manual() {
  : >"$REGISTRO"
  STATUS=0
  env PATH="$BIN:$PATH" "$PM" "$@" >"$T/saida" 2>&1 || STATUS=$?
}
recusa_manual() {
  local motivo=$1 texto=$2
  shift 2
  manual "$@"
  [[ $STATUS == 1 ]] || falha "$motivo: saiu com $STATUS (esperado 1)"
  grep -qF -- "$texto" "$T/saida" || falha "$motivo: sem a mensagem '$texto'"
  sem_escrita "$motivo"
}
limpar_saida() { find "$RAIZ/apps/pdv/publish/release-manual" -mindepth 1 -delete 2>/dev/null || true; }
zerar
limpar_saida
preparar "$C_014"
manual 0.14.0
[[ $STATUS == 0 ]] || falha "preparo saiu com $STATUS"
sem_escrita 'preparo'
grep -q "^curl .*pdv-v0.14.0/$NOME\$" "$REGISTRO" && falha 'o preparo baixou o instalador do release'
[[ $(find "$SAIDA_PADRAO" -mindepth 1 -printf '%f\n' | sort | tr '\n' ' ') == "$NOME $NOME.sha256 PASSO-A-PASSO.txt notas-do-release.md " ]] ||
  falha "a pasta do preparo: $(find "$SAIDA_PADRAO" -mindepth 1 -printf '%f ')"
cmp -s "$SAIDA_PADRAO/$NOME" "$PASTA/$NOME" && cmp -s "$SAIDA_PADRAO/$NOME.sha256" "$PASTA/$NOME.sha256" ||
  falha 'os dois arquivos da pasta não são os conferidos'
[[ $(cat "$SAIDA_PADRAO/notas-do-release.md") == "$NOTAS" ]] || falha 'as notas não são as do workflow'
ROTEIRO=$SAIDA_PADRAO/PASSO-A-PASSO.txt
grep -qF "https://github.com/dono-teste/repo-teste/releases/new?tag=pdv-v0.14.0&target=$C_014&title=GenesisPDV%200.14.0&body=GenesisPDV%200.14.0%20para%20Windows" "$ROTEIRO" ||
  falha 'sem o link do formulário com a tag, o commit, o título e as notas'
grep -qF 'já está desligado (disabled_manually): pule este passo' "$ROTEIRO" || falha 'sem o estado do workflow (desligado)'
grep -qF "a main já avançou até ${C_REMOTO:0:12}" "$ROTEIRO" || falha 'sem dizer que a main avançou depois do commit'
grep -qF "$NOME.sha256  (sha256 $HASH)" "$ROTEIRO" || falha 'sem o sha256 no roteiro'
grep -qF 'Set as a pre-release" DESMARCADO' "$ROTEIRO" || falha 'sem o aviso do pre-release'
grep -qF 'Publish release' "$ROTEIRO" || falha 'sem o Publish release'
grep -qF 'preparar-release-manual.sh 0.14.0 --conferir' "$T/saida" || falha 'sem o próximo passo (a conferência)'
confere 'preparo: a pasta com os dois arquivos conferidos, as notas e o passo a passo com o link, sem escrita'

# 9b. Workflow ligado: o preparo sai (o desligar é o passo 1 do dono), com o aviso; a mesma pasta é trocada inteira.
zerar
preparar "$C_014"
touch "$DUBLE/workflow-ativo"
manual 0.14.0
[[ $STATUS == 0 ]] || falha "preparo com o workflow ligado saiu com $STATUS"
grep -qF 'LIGADO: desligue-o antes de publicar' "$ROTEIRO" || falha 'o roteiro não pede para desligar o workflow'
grep -qF 'o passo 1 do roteiro (desligá-lo) vem antes de publicar' "$T/saida" || falha 'sem o aviso do workflow ligado'
sem_escrita 'preparo com o workflow ligado'
# Tag no mesmo commit e um rascunho: o roteiro manda editar o rascunho, e o workflow não importa (nada é disparado).
jq -n --arg s "$C_014" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
jq -n --arg n "$NOME" '{id: 77, tag_name: "pdv-v0.14.0", draft: true, prerelease: false, assets: [{id: 9, name: $n, size: 10, state: "starter"}]}' >"$DUBLE/release.json"
manual 0.14.0 --saida "$T/pasta-do-dono"
[[ $STATUS == 0 ]] || falha "preparo com a tag e o rascunho saiu com $STATUS"
grep -qF 'Já há um rascunho do pdv-v0.14.0' "$T/pasta-do-dono/PASSO-A-PASSO.txt" || falha 'o roteiro não manda editar o rascunho'
grep -qF 'a tag pdv-v0.14.0 já existe: publicar não dispara nada' "$T/pasta-do-dono/PASSO-A-PASSO.txt" || falha 'com a tag criada, o workflow ainda é passo'
grep -q 'actions/workflows' "$REGISTRO" && falha 'leu o workflow com a tag já criada'
sem_escrita 'preparo com a tag e o rascunho'
confere 'preparo: workflow ligado vira o passo 1; tag e rascunho existentes, editar o rascunho; --saida'

# 9c. Recusas do preparo, sem escrita.
zerar
limpar_saida
preparar "$C_FORA"
recusa_manual 'preparo fora da main' 'não está na main' 0.14.0
[[ -e $SAIDA_PADRAO ]] && falha 'a recusa deixou a pasta do preparo'
preparar "$C_013"
recusa_manual 'preparo com a versão errada' 'diz <Version>0.13.0</Version>, não 0.14.0' 0.14.0
preparar "$C_014" false
recusa_manual 'preparo com a árvore suja' 'alterações não commitadas' 0.14.0
preparar "$C_014"
rm "$PASTA/$NOME.conferido"
recusa_manual 'preparo sem a conferência' 'testar-instalador.sh' 0.14.0
preparar "$C_014"
printf '%064d  %s\n' 0 "$NOME" >"$PASTA/$NOME.sha256"
recusa_manual 'preparo com o .sha256 errado' 'não confere' 0.14.0
preparar "$C_014"
jq -n '{id: 77, tag_name: "pdv-v0.14.0", draft: false, assets: [{id: 1, name: "x", size: 1, state: "uploaded"}]}' >"$DUBLE/release.json"
recusa_manual 'preparo com o release já publicado com arquivos' 'já está publicado com 1 arquivo(s)' 0.14.0
zerar
mkdir -p "$T/pasta-ocupada"
echo x >"$T/pasta-ocupada/outro.txt"
recusa_manual 'pasta com outros arquivos' 'tem outros arquivos (outro.txt)' 0.14.0 --saida "$T/pasta-ocupada"
[[ $(ls "$T/pasta-ocupada") == outro.txt ]] || falha 'mexeu na pasta ocupada'
recusa_manual '--simular no preparo' 'que não vale aqui' 0.14.0 --simular
recusa_manual '--aceitar-disparo no preparo' 'que não vale aqui' 0.14.0 --aceitar-disparo
rodar 0.14.0 --preparar-manual --simular
[[ $STATUS == 1 ]] && grep -qF -- '--simular é da publicação pela sessão' "$T/saida" || falha 'publicar-release.sh --preparar-manual --simular'
rodar 0.14.0 --conferir-publicado --saida "$T/x"
[[ $STATUS == 1 ]] && grep -qF -- '--saida só vale com --preparar-manual' "$T/saida" || falha '--saida na conferência'
rodar 0.14.0 --preparar-manual --conferir-publicado
[[ $STATUS == 1 ]] && grep -qF 'não vão juntos' "$T/saida" || falha '--preparar-manual com --conferir-publicado'
confere 'recusas do preparo sem escrita: fora da main, versão, árvore suja, sem conferência, .sha256, release com arquivos, pasta ocupada, opções'

# 10. Conferência do que o dono publicou pelo site: só leituras.
publicado() {
  jq -n --arg s "$C_014" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
  jq -n --arg n "$NOME" --argjson t "$(stat -c %s "$PASTA/$NOME")" --argjson u "$(stat -c %s "$PASTA/$NOME.sha256")" \
    '{id: 77, tag_name: "pdv-v0.14.0", draft: false, prerelease: false,
      assets: [{id: 1, name: $n, size: $t, state: "uploaded"}, {id: 2, name: ($n + ".sha256"), size: $u, state: "uploaded"}]}' \
    >"$DUBLE/release.json"
}
rel() { jq "$1" "$DUBLE/release.json" >"$T/c" && mv "$T/c" "$DUBLE/release.json"; }
zerar
preparar "$C_014"
publicado
jq -n --arg h "$HASH_013" '{versao: "0.13.0", arquivo: "GenesisPDV-Setup-0.13.0.exe", sha256: $h}' >"$DUBLE/atual.json"
manual 0.14.0 --conferir
[[ $STATUS == 0 ]] || falha "conferência do publicado saiu com $STATUS"
sem_escrita 'conferência'
grep -qF "release pdv-v0.14.0 conferido: publicado no commit $C_014" "$T/saida" || falha 'sem o resultado da conferência'
grep -qF "releases/download/pdv-v0.14.0/$NOME.sha256" "$REGISTRO" || falha 'não baixou o .sha256 público'
grep -qF 'ainda oferece o 0.13.0: o vigia publica o 0.14.0' "$T/saida" || falha 'sem dizer que a página ainda não mudou'
grep -q 'continua ligado' "$T/saida" && falha 'avisou do workflow desligado'
jq -n --arg h "$HASH" '{versao: "0.14.0", sha256: $h}' >"$DUBLE/atual.json"
touch "$DUBLE/workflow-ativo"
manual 0.14.0 --conferir
[[ $STATUS == 0 ]] || falha "conferência com a página nova saiu com $STATUS"
grep -qF 'já oferece o 0.14.0' "$T/saida" || falha 'sem dizer que a página já oferece a versão'
grep -qF 'continua ligado' "$T/saida" || falha 'sem o aviso do workflow ainda ligado'
rm "$DUBLE/atual.json"
manual 0.14.0 --conferir
[[ $STATUS == 0 ]] && grep -qF 'não consegui ler https://download.exemplo.invalid/pdv/atual.json' "$T/saida" ||
  falha 'a página de download fora do ar derrubou a conferência do release'
confere 'conferência do publicado: a tag, os dois arquivos, o download público e a página (já, ainda não, fora), sem escrita'

# 10b. Recusas da conferência, sem escrita.
zerar
preparar "$C_014"
recusa_manual 'conferência sem a tag' 'a tag pdv-v0.14.0 não existe no GitHub' 0.14.0 --conferir
publicado
rel '.draft = true'
recusa_manual 'conferência do rascunho' 'ainda está em rascunho' 0.14.0 --conferir
publicado
rel '.prerelease = true'
recusa_manual 'conferência do pre-release' 'marcado como pre-release' 0.14.0 --conferir
publicado
jq -n --arg s "$C_013" '{object: {type: "commit", sha: $s}}' >"$DUBLE/ref.json"
recusa_manual 'conferência da tag em outro commit' "já existe no commit $C_013" 0.14.0 --conferir
publicado
rel '.assets[0].size = 10'
recusa_manual 'conferência de um arquivo pela metade' "não tem $NOME inteiro" 0.14.0 --conferir
publicado
rel '.assets += [{id: 3, name: "outro.zip", size: 1, state: "uploaded"}]'
recusa_manual 'conferência com outro arquivo' 'outros arquivos além dos dois' 0.14.0 --conferir
publicado
rm "$DUBLE/release.json"
recusa_manual 'conferência sem o release da tag' 'não há release dela' 0.14.0 --conferir
publicado
touch "$DUBLE/curl-corrompido"
recusa_manual 'conferência do .exe público trocado' 'o arquivo anexado é outro' 0.14.0 --conferir
rm "$DUBLE/curl-corrompido"
touch "$DUBLE/curl-sha256-outro"
recusa_manual 'conferência do .sha256 público trocado' "$NOME.sha256 público não é o daqui" 0.14.0 --conferir
confere 'recusas da conferência sem escrita: sem tag, rascunho, pre-release, outro commit, arquivo pela metade ou a mais, sem release, download trocado'

echo 'publicar-release.sh: todos os testes passaram'
