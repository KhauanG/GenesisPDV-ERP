#!/usr/bin/env bash
# Publica o GitHub Release pdv-vX.Y.Z com o instalador gerado e conferido no Linux (OP-B3, D70-Q2: o dono autorizou a
# sessão a fazer o release; README do PDV › decisão 93), no lugar do job "GitHub Release" do pdv-release.yml:
#
#   apps/pdv/instalador/linux-wine/publicar-release.sh X.Y.Z [--simular] [--commit <sha>] [--instalador <exe>]
#       [--aceitar-referencia X.Y.Z] [--aceitar-disparo]
#
# Antes de qualquer escrita no GitHub, recusa (saída 1) se:
# - o instalador (GenesisPDV-Setup-X.Y.Z.exe) não tem o .sha256 no formato do sha256sum e conferido, o .conferido do
#   testar-instalador.sh deste mesmo arquivo, ou o .origem.json do gerar-instalador.sh com árvore limpa;
# - a URL padrão da API embutida (a da origem e a conferida) não é a de produção, https://api.grupoicebeer.com.br
#   (GENESIS_URL_API_RELEASE troca, como o vars.PDV_URL_API_PADRAO do workflow), ou o .conferido não diz assinatura
#   "nenhuma" (este caminho nunca assina; um release de referência assinado também para aqui);
# - a conferência não foi feita contra o último release pdv-v* publicado (sem rascunho nem pre-release, como a
#   implantação escolhe; o sha256 da referência tem de ser o do .sha256 do release) ou o .NET embutido é mais velho
#   que o dele; --aceitar-referencia aceita outro release publicado. Sem release publicado, só sem referência;
# - o commit da origem (ou o --commit, que tem de ser o mesmo) não é ancestral da origin/main (o release oficial sai só
#   de commit da main, como o workflow), ou o apps/pdv/Directory.Build.props desse commit não diz <Version>X.Y.Z;
# - a tag pdv-vX.Y.Z já existe em outro commit (nunca troca os binários de uma tag: suba a versão), ou o release
#   publicado já tem arquivos (o workflow só os trocava com "substituir" marcado; aqui, nunca);
# - a tag falta e o workflow "PDV release" (pdv-release.yml) está ligado: a tag criada pela API com o token de uma
#   pessoa é um push de tag, e o push da tag pdv-v* dispara o workflow (on: push: tags). Sem cota do Actions, fica uma
#   execução falhada no log público; com cota, o runner monta outro instalador, e o job do release dele falha ("já tem
#   arquivos") ou sobe os binários dele num rascunho que sobrou. Padrão até a confirmação do dono (D71): o workflow
#   fica desligado enquanto durar a D70 (README do PDV › decisão 93, o comando); --aceitar-disparo cria a tag assim
#   mesmo, com o aviso.
# Depois, pela API REST (`gh api`; a GraphQL é bloqueada nas sessões): cria a tag (se falta) no commit, o release como
# rascunho (ninguém o vê nem o baixa ainda), envia o .exe e o .exe.sha256 (uploads.github.com), confere os dois
# arquivos no release (nome e tamanho), publica o rascunho e baixa de volta o .exe público para conferir o sha256. Um
# rascunho deste mesmo release que sobrou de uma execução interrompida é reaproveitado (os arquivos dele saem antes do
# envio); um release publicado sem arquivos volta para rascunho antes dos envios. Falha no meio: o release fica em
# rascunho, invisível; rodar de novo continua dali.
#
# --simular faz só as conferências e as leituras (GET) e diz o que faria. A página de download só passa a oferecer a
# versão depois de uma implantação com --publicar-pdv (infra/producao/README.md › Implantar sem o GitHub Actions).
# Precisa de: gh autenticado com permissão de escrita no repositório (contents: write), git, jq, curl e sha256sum.
# GENESIS_REPO troca o repositório (padrão KhauanG/GenesisPDV-ERP).
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
raiz=$(cd "$aqui/../../../.." && pwd)
REPO=${GENESIS_REPO:-KhauanG/GenesisPDV-ERP}
URL_API_RELEASE=${GENESIS_URL_API_RELEASE:-https://api.grupoicebeer.com.br}
WORKFLOW_RELEASE=pdv-release.yml

versao=''
commit=''
instalador=''
aceitar_referencia=''
simular=false
aceitar_disparo=false

erro() {
  echo "publicar-release: $*" >&2
  exit 1
}
uso() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --simular)
      simular=true
      shift
      ;;
    --aceitar-disparo)
      aceitar_disparo=true
      shift
      ;;
    --commit | --instalador | --aceitar-referencia)
      (($# >= 2)) || erro "$1 precisa de um valor"
      case "$1" in
        --commit) commit=$2 ;;
        --instalador) instalador=$2 ;;
        --aceitar-referencia) aceitar_referencia=$2 ;;
      esac
      shift 2
      ;;
    -h | --ajuda)
      uso
      exit 0
      ;;
    -*) erro "opção desconhecida: $1 (ajuda: $0 --ajuda)" ;;
    *)
      [ -z "$versao" ] || erro "versão informada duas vezes: $versao e $1"
      versao=$1
      shift
      ;;
  esac
done

[[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "informe a versão X.Y.Z (recebido: '${versao}')"
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || erro "repositório inválido: $REPO"
[[ $URL_API_RELEASE =~ ^https://[^[:space:]]+$ ]] || erro "GENESIS_URL_API_RELEASE inválida '$URL_API_RELEASE' (https://, sem espaços)"
[[ -z $aceitar_referencia || $aceitar_referencia =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  erro "--aceitar-referencia precisa da versão X.Y.Z de um release publicado (recebido: '$aceitar_referencia')"
for comando in gh git jq curl sha256sum; do
  command -v "$comando" >/dev/null 2>&1 || erro "falta o comando '$comando'"
done
tag="pdv-v$versao"
nome="GenesisPDV-Setup-$versao.exe"
[ -n "$instalador" ] || instalador="$raiz/apps/pdv/publish/instalador/$nome"
[ "$(basename "$instalador")" = "$nome" ] || erro "o instalador da versão $versao se chama $nome (recebido: $instalador)"
[ -f "$instalador" ] || erro "instalador não encontrado: $instalador (gere com gerar-instalador.sh e confira com testar-instalador.sh)"
pasta=$(cd "$(dirname "$instalador")" && pwd)
instalador="$pasta/$nome"

# --- Conferências locais ----------------------------------------------------------------------------------------------
[ -f "$instalador.sha256" ] || erro "falta $nome.sha256"
{ [ "$(awk 'END { print NR }' "$instalador.sha256")" = 1 ] &&
  grep -qxE "[0-9a-f]{64}  GenesisPDV-Setup-${versao//./\\.}\.exe" "$instalador.sha256"; } ||
  erro "$nome.sha256 fora do formato do sha256sum (uma linha, '<hash>  $nome')"
(cd "$pasta" && sha256sum -c --quiet "$nome.sha256") || erro "o sha256 de $nome não confere com o .sha256"
hash=$(cut -d' ' -f1 "$instalador.sha256")
# shellcheck disable=SC2016 # $v e $h são variáveis do jq.
jq -e --arg v "$versao" --arg h "$hash" '.versao == $v and .sha256 == $h' "$instalador.conferido" >/dev/null 2>&1 ||
  erro "falta a conferência deste arquivo ($nome.conferido do testar-instalador.sh, com o mesmo sha256)"
# shellcheck disable=SC2016 # $v e $h são variáveis do jq.
jq -e --arg v "$versao" --arg h "$hash" '.versao == $v and .sha256 == $h' "$instalador.origem.json" >/dev/null 2>&1 ||
  erro "falta a origem deste arquivo ($nome.origem.json do gerar-instalador.sh, com o mesmo sha256)"
[ "$(jq -r .arvore_limpa "$instalador.origem.json")" = true ] ||
  erro 'o instalador foi gerado com alterações não commitadas no apps/pdv: gere de novo com a árvore limpa'
# A URL padrão da API embutida no exe: a da produção (o caixa novo abre a ativação com ela preenchida). A do
# gerar-instalador.sh --url-api e a do testar-instalador.sh --url-api ficam gravadas na origem e na conferência.
url_origem=$(jq -r '.url_api_padrao // ""' "$instalador.origem.json")
[ "$url_origem" = "$URL_API_RELEASE" ] ||
  erro "o instalador foi gerado com a API padrão '$url_origem', não a do release oficial ($URL_API_RELEASE; GENESIS_URL_API_RELEASE troca): gere de novo sem --url-api"
url_conferida=$(jq -r '.url_api // ""' "$instalador.conferido")
[ "$url_conferida" = "$URL_API_RELEASE" ] ||
  erro "a conferência ($nome.conferido) diz a API '$url_conferida', não $URL_API_RELEASE: confira de novo com o testar-instalador.sh"
[ "$(jq -r '.assinatura // ""' "$instalador.conferido")" = nenhuma ] ||
  erro "a conferência não diz assinatura \"nenhuma\" ($nome.conferido): este caminho não assina; confira de novo com o testar-instalador.sh"
# O .NET embutido e a referência da conferência (comparada com o último release publicado mais abaixo, com o GitHub).
dotnet=$(jq -r '.dotnet // ""' "$instalador.conferido")
[[ $dotnet =~ ^10\.0\.[0-9]+\.[0-9]+$ ]] || erro "a conferência não traz o .NET embutido (dotnet: '$dotnet'): confira de novo com o testar-instalador.sh"
referencia=$(jq -r '.referencia // ""' "$instalador.conferido")
if [ -n "$referencia" ]; then
  [[ $referencia =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "referência inválida na conferência: '$referencia'"
  referencia_sha256=$(jq -r '.referencia_sha256 // ""' "$instalador.conferido")
  [[ $referencia_sha256 =~ ^[0-9a-f]{64}$ ]] || erro "a conferência não traz o sha256 da referência $referencia: confira de novo"
  dotnet_ref=$(jq -r '.dotnet_referencia // ""' "$instalador.conferido")
  [[ $dotnet_ref =~ ^10\.0\.[0-9]+\.[0-9]+$ ]] || erro "a conferência não traz o .NET da referência $referencia: confira de novo"
  [ "$(printf '%s\n%s\n' "$dotnet_ref" "$dotnet" | sort -V | tail -n 1)" = "$dotnet" ] ||
    erro "o .NET embutido ($dotnet) é mais velho que o do $referencia publicado ($dotnet_ref): falta correção de segurança"
  [ "$(jq -r '.assinatura_referencia // ""' "$instalador.conferido")" = nenhuma ] ||
    erro "o release de referência $referencia é assinado (ou a assinatura dele não foi conferida): este caminho não assina; use o Windows"
fi
commit_origem=$(jq -r '.commit // ""' "$instalador.origem.json")
[[ $commit_origem =~ ^[0-9a-f]{40}$ ]] || erro "commit da origem inválido: '$commit_origem'"
if [ -n "$commit" ]; then
  [[ $commit =~ ^[0-9a-f]{7,40}$ ]] || erro "commit inválido: $commit (7 a 40 hexadecimais)"
  [[ $commit_origem == "$commit"* ]] || erro "o instalador é do commit $commit_origem, não do $commit"
fi
commit=$commit_origem

git -C "$raiz" fetch -q origin main || erro 'não foi possível atualizar a origin/main (git fetch origin main)'
git -C "$raiz" cat-file -e "$commit^{commit}" 2>/dev/null || erro "o commit $commit não existe neste clone"
git -C "$raiz" merge-base --is-ancestor "$commit" origin/main ||
  erro "o commit $commit não está na main: o release oficial sai só de commit da main"
versao_props=$(git -C "$raiz" show "$commit:apps/pdv/Directory.Build.props" | sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' | head -n 1)
[ "$versao_props" = "$versao" ] ||
  erro "o apps/pdv/Directory.Build.props do commit $commit diz <Version>$versao_props</Version>, não $versao"
echo "GenesisPDV $versao: $nome (sha256 $hash), commit $commit da main, repositório $REPO"

# --- Estado no GitHub (só leituras) -----------------------------------------------------------------------------------
# gh api que devolve o corpo; um 404 vira saída 4 (o recurso não existe), qualquer outro erro, saída 1 com a mensagem.
ler() {
  local saida status=0
  saida=$(gh api "$@" 2>"$temporario/erro") || status=$?
  if ((status != 0)); then
    if grep -q 'HTTP 404' "$temporario/erro"; then return 4; fi
    cat "$temporario/erro" >&2
    echo "publicar-release: a API do GitHub recusou: gh api $*" >&2
    return 1
  fi
  printf '%s\n' "$saida"
}
temporario=$(mktemp -d "${TMPDIR:-/tmp}/genesispdv-release.XXXXXX")
trap 'rm -rf "$temporario"' EXIT

commit_tag=''
status=0
ref=$(ler "repos/$REPO/git/ref/tags/$tag") || status=$?
if ((status == 0)); then
  case "$(jq -r .object.type <<<"$ref")" in
    commit) commit_tag=$(jq -r .object.sha <<<"$ref") ;;
    # Tag anotada: aponta para um objeto tag, que aponta para o commit.
    tag)
      anotada=$(ler "repos/$REPO/git/tags/$(jq -r .object.sha <<<"$ref")") || exit 1
      commit_tag=$(jq -r .object.sha <<<"$anotada")
      ;;
    *) erro "a tag $tag aponta para um objeto inesperado: $(jq -c .object <<<"$ref")" ;;
  esac
elif ((status != 4)); then
  exit 1
fi
if [ -n "$commit_tag" ] && [ "$commit_tag" != "$commit" ]; then
  erro "a tag $tag já existe no commit $commit_tag, e o instalador é do $commit: suba a versão (nova tag), nunca troque os binários de uma tag"
fi

# Rascunhos não aparecem em releases/tags/<tag>: a lista traz os dois.
lista=$(ler --paginate "repos/$REPO/releases?per_page=100") || exit 1
release=$(jq -s --arg t "$tag" '[add // [] | .[] | select(.tag_name == $t)] | first // empty' <<<"$lista")
id=''
rascunho=false
if [ -n "$release" ]; then
  id=$(jq -r .id <<<"$release")
  rascunho=$(jq -r .draft <<<"$release")
  arquivos=$(jq '.assets | length' <<<"$release")
  if [ "$rascunho" != true ] && [ "$arquivos" -gt 0 ]; then
    erro "o release $tag já está publicado com $arquivos arquivo(s): nunca são trocados (suba a versão)"
  fi
fi

# A conferência tem de ter sido contra o último release publicado (sem rascunho nem pre-release, fora este mesmo: o
# mesmo critério da implantação), ou o --aceitar-referencia; e o instalador de referência, o do .sha256 desse release.
ultimo=$(jq -rs --arg t "$tag" '[add // [] | .[] | select(.draft == false and .prerelease == false and .tag_name != $t)
  | .tag_name] | .[]' <<<"$lista" | grep -E '^pdv-v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
esperada=${ultimo#pdv-v}
if [ -n "$aceitar_referencia" ]; then
  # shellcheck disable=SC2016 # $t é variável do jq.
  jq -se --arg t "pdv-v$aceitar_referencia" 'any(add // [] | .[]; .tag_name == $t and .draft == false and .prerelease == false)' \
    <<<"$lista" >/dev/null || erro "--aceitar-referencia $aceitar_referencia: não há release pdv-v$aceitar_referencia publicado"
  [ "$aceitar_referencia" = "$esperada" ] ||
    echo "aviso: referência aceita: o $aceitar_referencia publicado, não o último (${ultimo:-nenhum})" >&2
  esperada=$aceitar_referencia
fi
if [ "$referencia" != "$esperada" ]; then
  if [ -z "$referencia" ]; then
    erro "a conferência foi feita sem o release de referência, e o último publicado é o $ultimo: confira de novo contra ele (testar-instalador.sh sem --sem-referencia)"
  fi
  erro "a conferência foi feita contra o $referencia, e a referência esperada é ${esperada:-nenhuma (não há release publicado)}: confira de novo (testar-instalador.sh), ou aceite outro release publicado com --aceitar-referencia"
fi
if [ -n "$referencia" ]; then
  curl -fsSL --proto '=https' --retry 3 -o "$temporario/referencia.sha256" \
    "https://github.com/$REPO/releases/download/pdv-v$referencia/GenesisPDV-Setup-$referencia.exe.sha256" ||
    erro "não consegui baixar o .sha256 do release pdv-v$referencia (a referência da conferência)"
  [ "$(cut -d' ' -f1 "$temporario/referencia.sha256")" = "$referencia_sha256" ] ||
    erro "o instalador de referência da conferência (sha256 $referencia_sha256) não é o do release pdv-v$referencia publicado: confira de novo contra o release"
  echo "conferido contra o release pdv-v$referencia publicado (.NET $dotnet_ref; este: $dotnet)"
else
  echo 'aviso: nenhum release pdv-v* publicado: a conferência foi sem referência (o primeiro release)' >&2
fi

# O push da tag pdv-v* dispara o pdv-release.yml (a tag criada com o token de uma pessoa não é como a do GITHUB_TOKEN).
estado_workflow=''
if [ -z "$commit_tag" ]; then
  status=0
  workflow=$(ler "repos/$REPO/actions/workflows/$WORKFLOW_RELEASE") || status=$?
  if ((status == 0)); then
    estado_workflow=$(jq -r '.state // ""' <<<"$workflow")
  elif ((status == 4)); then
    estado_workflow=inexistente
  else
    exit 1
  fi
  if [ "$estado_workflow" = active ]; then
    if ! $aceitar_disparo; then
      erro "o workflow \"PDV release\" ($WORKFLOW_RELEASE) está ligado, e criar a tag $tag o dispara (on: push: tags). Desligue-o enquanto durar a D70 (README do PDV › decisão 93; padrão até a confirmação do dono, D71) ou rode com --aceitar-disparo"
    fi
    echo "aviso: --aceitar-disparo: criar a tag $tag dispara o \"PDV release\" ($WORKFLOW_RELEASE); sem cota do Actions, a execução falha no log público; com cota, o job do release dele falha com \"já tem arquivos\"" >&2
  fi
fi

if $simular; then
  echo "Simulação (nada foi escrito no GitHub):"
  if [ -n "$commit_tag" ]; then
    echo "  tag $tag: já existe no commit $commit"
  else
    echo "  tag $tag: seria criada no commit $commit (workflow $WORKFLOW_RELEASE: ${estado_workflow:-?})"
  fi
  if [ -z "$id" ]; then
    echo "  release $tag: seria criado em rascunho"
  elif [ "$rascunho" = true ]; then
    echo "  release $tag: já existe em rascunho; seria completado"
  else
    echo "  release $tag: já existe publicado, sem arquivos; voltaria para rascunho e seria completado"
  fi
  echo "  arquivos: $nome e $nome.sha256; depois o rascunho seria publicado e o .exe público conferido"
  exit 0
fi

# --- Escritas ----------------------------------------------------------------------------------------------------------
if [ -z "$commit_tag" ]; then
  ler --method POST "repos/$REPO/git/refs" -f "ref=refs/tags/$tag" -f "sha=$commit" >/dev/null ||
    erro "não foi possível criar a tag $tag"
  echo "tag $tag criada no commit $commit"
fi
notas="GenesisPDV $versao para Windows: $nome (instale por cima da versão anterior: banco, backups e ativação ficam). Confira o .exe.sha256 antes de instalar (README do PDV › Instalar na loja)."
if [ -z "$id" ]; then
  id=$(ler --method POST "repos/$REPO/releases" -f "tag_name=$tag" -f "target_commitish=$commit" \
    -f "name=GenesisPDV $versao" -f "body=$notas" -F draft=true | jq -r .id) || erro "não foi possível criar o release $tag"
  [[ $id =~ ^[0-9]+$ ]] || erro "o GitHub não devolveu o id do release criado"
  rascunho=true
  echo "release $tag criado em rascunho (id $id)"
elif [ "$rascunho" = true ]; then
  for antigo in $(jq -r '.assets[].id' <<<"$release"); do
    ler --method DELETE "repos/$REPO/releases/assets/$antigo" >/dev/null || erro "não foi possível tirar o arquivo $antigo do rascunho"
  done
  echo "rascunho $tag (id $id) de uma execução anterior: reaproveitado"
else
  # Publicado sem arquivos (criado à mão, ou um workflow que parou antes dos envios): volta para rascunho até os dois
  # arquivos subirem, para uma falha no meio não deixar à vista um release pela metade (e rodar de novo continuar).
  ler --method PATCH "repos/$REPO/releases/$id" -F draft=true >/dev/null ||
    erro "não foi possível voltar o release $tag (publicado sem arquivos) para rascunho"
  rascunho=true
  echo "release $tag (id $id) estava publicado sem arquivos: voltou para rascunho até os dois arquivos subirem"
fi

for arquivo in "$nome" "$nome.sha256"; do
  ler --method POST -H 'Content-Type: application/octet-stream' --input "$pasta/$arquivo" \
    "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$arquivo" >/dev/null ||
    erro "o envio de $arquivo falhou (o release continua em rascunho: rode de novo)"
  echo "enviado: $arquivo"
done
no_release=$(ler "repos/$REPO/releases/$id/assets?per_page=100") || erro 'não foi possível listar os arquivos do release (continua em rascunho)'
for arquivo in "$nome" "$nome.sha256"; do
  tamanho=$(stat -c %s "$pasta/$arquivo")
  # shellcheck disable=SC2016 # $n e $t são variáveis do jq.
  jq -e --arg n "$arquivo" --argjson t "$tamanho" 'any(.[]; .name == $n and .size == $t and .state == "uploaded")' \
    <<<"$no_release" >/dev/null || erro "o release não tem $arquivo inteiro ($tamanho bytes); continua em rascunho"
done
[ "$(jq length <<<"$no_release")" = 2 ] || erro "o release tem outros arquivos além dos dois: $(jq -c '[.[].name]' <<<"$no_release")"

ler --method PATCH "repos/$REPO/releases/$id" -F draft=false >/dev/null || erro "não foi possível publicar o rascunho $tag"
echo "release $tag publicado: https://github.com/$REPO/releases/tag/$tag"

# Conferência do que qualquer pessoa baixa (o mesmo caminho que a implantação usa).
curl -fsSL --proto '=https' --retry 3 -o "$temporario/$nome" "https://github.com/$REPO/releases/download/$tag/$nome" ||
  erro "o release foi publicado, mas o download público de $nome falhou: confira à mão"
[ "$(sha256sum "$temporario/$nome" | cut -d' ' -f1)" = "$hash" ] ||
  erro "o $nome público não tem o sha256 $hash: confira o release à mão"
echo "download público conferido (sha256 $hash)"
echo "Próximo passo: a página de download só oferece o $versao depois de uma implantação com --publicar-pdv"
echo "(infra/producao/README.md › Implantar sem o GitHub Actions); os caixas se atualizam um de cada vez, com o dono."
