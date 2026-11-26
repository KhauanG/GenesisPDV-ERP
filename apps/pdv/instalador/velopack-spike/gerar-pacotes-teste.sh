#!/usr/bin/env bash
# Spike do Velopack (F3-B8; README do PDV › decisão 100; docs/planos/operacao-sem-actions-plano.md › OP-B3, Velopack).
# Protótipo DESCARTÁVEL: gera, no Linux da sessão, os pacotes de teste do roteiro do Windows. Nada daqui é o PDV.
#
#   apps/pdv/instalador/velopack-spike/gerar-pacotes-teste.sh [--saida <pasta>]
#
# 1. instala o vpk na versão fixa abaixo numa pasta própria (nunca global) e confere o contentHash do pacote no nuget.org;
# 2. gera uma chave Ed25519 DE TESTE (ssh-keygen, sem senha, apagável; nunca a do dono, que só existe no PC dele) e uma
#    segunda chave, "do invasor", para o caso da assinatura errada;
# 3. publica o protótipo win-x64 (autocontido, arquivo único, como o PDV) nas versões 1.0.0, 1.0.1 e 1.0.2 (esta com a
#    falha de migração simulada), com a chave pública de teste embutida, e empacota cada uma com `vpk [win] pack`
#    (critério (a): pacote do Windows montado no Linux), com o delta contra a anterior;
# 4. monta as pastas de feed do roteiro, cada uma com o releases.win.json do Velopack, os pacotes e o manifesto assinado
#    (manifesto.win.json + .sig, `ssh-keygen -Y sign -n genesispdv-atualizacao`): as boas (1.0.1 e 1.0.2) e as
#    adulteradas (assinatura de outra chave, pacote trocado, feed trocado com o sha256 refeito, canal trocado, versão
#    velha assinada);
# 5. confere o conteúdo (a lista de arquivos de cada nupkg, a versão, o sha256 do manifesto = o do arquivo = o do feed)
#    e junta tudo em velopack-spike-roteiro.zip + .sha256, com o ROTEIRO.txt (o roteiro do Windows do README).
#
# Saída: apps/pdv/publish/velopack-spike/ (ignorada pelo git). Precisa de: dotnet (SDK do apps/pdv/global.json),
# ssh-keygen (openssh-client), zstd (o vpk monta os deltas com ele no Linux), jq, python3, unzip, zip e sha256sum.
set -euo pipefail

# vpk e a biblioteca Velopack andam juntos (Directory.Packages.props desta pasta). O contentHash é o sha512 do .nupkg
# que o NuGet grava no .nupkg.metadata; conferido em 26/11/2026 no nuget.org (1.2.161, publicado em 29/09/2026).
VERSAO_VPK=1.2.161
HASH_VPK='UKmsuWXbh8fJYrer5Td615x4AviJP138EcUKc+uqMbE6YjwbGYrdQT+vt2qXp/bHH5Uwi+JG91F2HSX85NKGNA=='
APP=GenesisPDV.Spike
CANAL=win
CONTEXTO=genesispdv-atualizacao

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pasta_pdv=$(cd "$aqui/../.." && pwd)
projeto="$aqui/ProtoAtualizacao/ProtoAtualizacao.csproj"
saida="$pasta_pdv/publish/velopack-spike"

erro() {
  echo "gerar-pacotes-teste: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --saida)
      [[ $# -ge 2 ]] || erro "--saida pede uma pasta"
      saida=$2
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *) erro "opção desconhecida: $1" ;;
  esac
done

for programa in dotnet ssh-keygen jq unzip zip sha256sum zstd python3; do
  command -v "$programa" >/dev/null || erro "falta o $programa"
done

# A pasta é apagada e refeita: só uma nova, vazia ou de uma rodada anterior deste script (a marca), nunca outra.
if [[ -e $saida ]]; then
  [[ -d $saida ]] || erro "--saida não é uma pasta: $saida"
  if [[ -n $(ls -A "$saida") && ! -f "$saida/.velopack-spike" ]]; then
    erro "a pasta $saida não está vazia nem é de uma rodada anterior deste script"
  fi
fi
rm -rf "$saida"
mkdir -p "$saida"/{ferramentas,chave-teste,publicacao,releases,roteiro}
touch "$saida/.velopack-spike"
ferramentas="$saida/ferramentas"

# 1) vpk fixo, numa pasta só dele, com o contentHash conferido.
echo "== vpk $VERSAO_VPK"
dotnet tool install vpk --version "$VERSAO_VPK" --tool-path "$ferramentas" >/dev/null
metadados="$ferramentas/.store/vpk/$VERSAO_VPK/vpk/$VERSAO_VPK/.nupkg.metadata"
[[ -f $metadados ]] || erro "não achei o $metadados do vpk instalado"
[[ $(jq -r .contentHash "$metadados") == "$HASH_VPK" ]] || erro "o contentHash do vpk $VERSAO_VPK não é o fixado no script"
vpk() { COLUMNS=200 TERM=xterm "$ferramentas/vpk" "[win]" pack -x --skip-updates "$@"; }

# 2) chaves de teste (descartáveis; a do dono nunca passa pela sessão).
ssh-keygen -q -t ed25519 -N '' -C 'spike-velopack-teste-descartavel' -f "$saida/chave-teste/teste"
ssh-keygen -q -t ed25519 -N '' -C 'spike-velopack-outra-chave' -f "$saida/chave-teste/outra"
chave_publica=$(cat "$saida/chave-teste/teste.pub")

# 3) as três versões do protótipo, publicadas e empacotadas na mesma pasta de releases (o vpk gera o delta contra a
#    versão anterior que achar lá).
dotnet restore "$projeto" --locked-mode >/dev/null
for versao in 1.0.0 1.0.1 1.0.2; do
  echo "== $APP $versao"
  falha=false
  [[ $versao == 1.0.2 ]] && falha=true
  dotnet publish "$projeto" -c Release --no-restore \
    -p:Version="$versao" -p:SpikeChavePublica="$chave_publica" \
    -p:SpikeFalharMigracao="$falha" -o "$saida/publicacao/$versao" >"$saida/publicacao/publish-$versao.log" 2>&1 ||
    {
      cat "$saida/publicacao/publish-$versao.log" >&2
      erro "dotnet publish $versao falhou"
    }
  vpk -u "$APP" -v "$versao" -r win-x64 -p "$saida/publicacao/$versao" -e "$APP.exe" -o "$saida/releases" \
    --channel "$CANAL" --packTitle 'GenesisPDV Spike' --packAuthors Genesis \
    --shortcuts Desktop,StartMenuRoot,Startup >"$saida/releases/vpk-$versao.log" 2>&1 ||
    {
      cat "$saida/releases/vpk-$versao.log" >&2
      erro "vpk pack $versao falhou"
    }
  # O Setup.exe da pasta de releases é sempre o da última versão empacotada: o do roteiro é o da 1.0.0.
  cp "$saida/releases/$APP-$CANAL-Setup.exe" "$saida/Setup-$versao.exe"
  # O feed como ficou logo depois desta versão, só com o completo dela e os deltas (o releases.win.json do vpk é
  # acumulado; o Velopack só precisa do completo mais novo e dos deltas até ele): o zip do roteiro fica menor.
  mkdir -p "$saida/feed-$versao"
  jq -c --arg v "$versao" '.Assets |= map(select(.Type == "Delta" or .Version == $v))' \
    "$saida/releases/releases.$CANAL.json" >"$saida/feed-$versao/releases.$CANAL.json"
  jq -r '.Assets[].FileName' "$saida/feed-$versao/releases.$CANAL.json" | while read -r arquivo; do
    cp "$saida/releases/$arquivo" "$saida/feed-$versao/"
  done
done

# O sha256 de cada arquivo de dentro de um .nupkg, em JSON [{arquivo, sha256}] (python3 -I: o nome com [ ] e espaço
# do pacote do Velopack não passa pelo unzip -p, que lê o nome como padrão).
conteudo_zip() {
  python3 -I -c 'import hashlib, json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps([{"arquivo": i.filename, "sha256": hashlib.sha256(z.read(i)).hexdigest()} for i in z.infolist()]))' "$1"
}

# 4) manifesto assinado de uma pasta de feed: o sha256 do feed e de cada pacote, conferidos contra o próprio feed.
#    manifesto <pasta> <versão> <mínima permitida> <chave> [canal escrito no manifesto]
manifesto() {
  local pasta=$1 versao=$2 minima=$3 chave=$4 canal=${5:-$CANAL}
  local feed="$pasta/releases.$CANAL.json"
  local pacotes='[]' arquivo tipo versao_pacote tamanho sha256 sha256_feed
  while IFS=$'\t' read -r arquivo tipo versao_pacote tamanho sha256_feed; do
    sha256=$(sha256sum "$pasta/$arquivo" | cut -d' ' -f1)
    [[ ${sha256,,} == "${sha256_feed,,}" ]] || erro "sha256 do $arquivo difere do feed em $pasta"
    [[ $(stat -c %s "$pasta/$arquivo") == "$tamanho" ]] || erro "tamanho do $arquivo difere do feed em $pasta"
    # O completo leva o sha256 de cada arquivo de dentro: o remontado pelos deltas tem os mesmos arquivos em outro zip.
    conteudo='null'
    [[ ${tipo,,} == full ]] && conteudo=$(conteudo_zip "$pasta/$arquivo")
    pacotes=$(jq -c --arg a "$arquivo" --arg t "${tipo,,}" --arg v "$versao_pacote" --argjson n "$tamanho" --arg s "$sha256" \
      --argjson c "$conteudo" '. + [{arquivo: $a, tipo: $t, versao: $v, tamanho: $n, sha256: $s} + (if $c then {conteudo: $c} else {} end)]' \
      <<<"$pacotes")
  done < <(jq -r '.Assets[] | [.FileName, .Type, .Version, (.Size | tostring), .SHA256] | @tsv' "$feed")
  jq -n --arg app "$APP" --arg canal "$canal" --arg v "$versao" --arg m "$minima" \
    --arg feed "releases.$CANAL.json" --arg sf "$(sha256sum "$feed" | cut -d' ' -f1)" --argjson p "$pacotes" \
    '{formato: 1, app: $app, canal: $canal, versao: $v, versao_minima_permitida: $m,
      feed: {arquivo: $feed, sha256: $sf}, pacotes: $p}' >"$pasta/manifesto.$CANAL.json"
  rm -f "$pasta/manifesto.$CANAL.json.sig"
  ssh-keygen -q -Y sign -f "$saida/chave-teste/$chave" -n "$CONTEXTO" "$pasta/manifesto.$CANAL.json" 2>/dev/null
}

# As recusas que acontecem antes de qualquer download (assinatura, canal, feed refeito, versão velha) não precisam dos
# pacotes na pasta: saem depois do manifesto, e o zip do roteiro fica menor.
sem_pacotes() { rm -f "$1"/*.nupkg; }

rot="$saida/roteiro"
cp "$saida/Setup-1.0.0.exe" "$rot/1-instalar-$APP-1.0.0-Setup.exe"

# Boas: a 1.0.1 (mínima 1.0.0) e a 1.0.2 (mínima 1.0.1, a da migração que falha).
cp -r "$saida/feed-1.0.1" "$rot/feed-1.0.1"
manifesto "$rot/feed-1.0.1" 1.0.1 1.0.0 teste
cp -r "$saida/feed-1.0.2" "$rot/feed-1.0.2"
manifesto "$rot/feed-1.0.2" 1.0.2 1.0.1 teste

# Adulteradas (todas a partir da 1.0.1; a 1.0.0 instalada precisa recusar cada uma ANTES de aplicar):
# - assinada por outra chave;
cp -r "$saida/feed-1.0.1" "$rot/ruim-assinatura-de-outra-chave"
manifesto "$rot/ruim-assinatura-de-outra-chave" 1.0.1 1.0.0 outra
sem_pacotes "$rot/ruim-assinatura-de-outra-chave"
# - o pacote completo e o delta trocados por outros, com o feed e o manifesto originais (o download não confere);
cp -r "$rot/feed-1.0.1" "$rot/ruim-pacote-trocado"
for arquivo in "$rot/ruim-pacote-trocado/$APP-1.0.1-"*.nupkg; do
  printf 'X' | dd of="$arquivo" bs=1 seek=$(($(stat -c %s "$arquivo") / 2)) conv=notrunc status=none
done
# - o invasor refaz o feed com o sha256 do pacote dele, mas o manifesto assinado é o original;
cp -r "$rot/ruim-pacote-trocado" "$rot/ruim-feed-refeito"
for arquivo in "$rot/ruim-feed-refeito/$APP-1.0.1-"*.nupkg; do
  nome=$(basename "$arquivo")
  novo=$(sha256sum "$arquivo" | cut -d' ' -f1 | tr '[:lower:]' '[:upper:]')
  jq --arg n "$nome" --arg s "$novo" '(.Assets[] | select(.FileName == $n) | .SHA256) = $s' \
    "$rot/ruim-feed-refeito/releases.$CANAL.json" >"$rot/ruim-feed-refeito/feed.tmp"
  mv "$rot/ruim-feed-refeito/feed.tmp" "$rot/ruim-feed-refeito/releases.$CANAL.json"
done
sem_pacotes "$rot/ruim-feed-refeito"
# - um manifesto bom do canal beta servido como o do canal win;
cp -r "$saida/feed-1.0.1" "$rot/ruim-canal-trocado"
manifesto "$rot/ruim-canal-trocado" 1.0.1 1.0.0 teste beta
sem_pacotes "$rot/ruim-canal-trocado"
# - a versão velha, assinada de verdade (o caixa não pode voltar a uma versão com defeito): depois da 1.0.2 aceita (mínima
#   1.0.1), o manifesto de mínima 1.0.0 é recusado como antigo.
cp -r "$saida/feed-1.0.0" "$rot/ruim-versao-velha-assinada"
manifesto "$rot/ruim-versao-velha-assinada" 1.0.0 1.0.0 teste
sem_pacotes "$rot/ruim-versao-velha-assinada"

# 5) conferência do conteúdo (critério (a)) e o pacote do roteiro.
echo "== conferência"
for versao in 1.0.0 1.0.1 1.0.2; do
  nupkg="$saida/releases/$APP-$versao-full.nupkg"
  lista=$(unzip -Z1 "$nupkg" | LC_ALL=C sort)
  esperado=$(printf '%s\n' "$APP.nuspec" '[Content_Types].xml' _rels/.rels 'lib/app/GenesisPDV Spike_ExecutionStub.exe' \
    "lib/app/$APP.exe" lib/app/Squirrel.exe lib/app/sq.version | LC_ALL=C sort)
  [[ $lista == "$esperado" ]] || erro "conteúdo inesperado no $nupkg: $lista"
  nuspec=$(unzip -p "$nupkg" "$APP.nuspec")
  [[ $nuspec == *"<version>$versao</version>"* ]] || erro "versão errada no nuspec do $versao"
  [[ $nuspec == *'<rid>win-x64</rid>'* && $nuspec == *"<channel>$CANAL</channel>"* ]] || erro "o $versao não é win-x64 do canal $CANAL"
done
# O Setup.exe do Velopack é o executável com o pacote completo anexado em zip (o unzip avisa dos bytes do exe e sai 1).
nuspec_setup=$(unzip -p "$rot/1-instalar-$APP-1.0.0-Setup.exe" "$APP.nuspec" 2>/dev/null || true)
[[ $nuspec_setup == *'<version>1.0.0</version>'* ]] || erro "o Setup do roteiro não é o da 1.0.0"
[[ -f "$saida/releases/$APP-1.0.1-delta.nupkg" && -f "$saida/releases/$APP-1.0.2-delta.nupkg" ]] || erro "faltam os deltas"
echo "teste $chave_publica" >"$saida/chave-teste/permitidas"
for pasta in feed-1.0.1 feed-1.0.2 ruim-pacote-trocado ruim-feed-refeito ruim-canal-trocado ruim-versao-velha-assinada; do
  ssh-keygen -Y verify -f "$saida/chave-teste/permitidas" -I teste -n "$CONTEXTO" -s "$rot/$pasta/manifesto.$CANAL.json.sig" \
    <"$rot/$pasta/manifesto.$CANAL.json" >/dev/null 2>&1 || erro "a assinatura do $pasta não confere com a chave de teste"
done
if ssh-keygen -Y verify -f "$saida/chave-teste/permitidas" -I teste -n "$CONTEXTO" \
  -s "$rot/ruim-assinatura-de-outra-chave/manifesto.$CANAL.json.sig" \
  <"$rot/ruim-assinatura-de-outra-chave/manifesto.$CANAL.json" >/dev/null 2>&1; then
  erro "a assinatura de outra chave passou na conferência com a chave de teste"
fi

cp "$aqui/ROTEIRO-WINDOWS.txt" "$rot/ROTEIRO.txt"
cp "$saida/chave-teste/teste.pub" "$rot/chave-publica-de-teste.pub"
(cd "$saida" && rm -f velopack-spike-roteiro.zip && zip -qr velopack-spike-roteiro.zip roteiro &&
  sha256sum velopack-spike-roteiro.zip >velopack-spike-roteiro.zip.sha256)
echo "Pronto: $saida/velopack-spike-roteiro.zip ($(du -h "$saida/velopack-spike-roteiro.zip" | cut -f1))"
cat "$saida/velopack-spike-roteiro.zip.sha256"
