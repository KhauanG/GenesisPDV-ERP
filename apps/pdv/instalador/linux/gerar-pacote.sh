#!/usr/bin/env bash
# Publica o GenesisPDV para linux-x64 e gera o .deb (implantação I3; README do PDV › "Instalar na loja" e decisão 62),
# o par do gerar-instalador.ps1 do Windows: executável único self-contained com a versão e a URL padrão da API,
# conferido pelo --info-build (versão, URL e sem demonstração) e empacotado pelo gerar-deb.sh. Sem uso na CI e no
# release desde a decisão 80 do README do PDV (só Windows), sem garantia de que continue funcionando; fica como
# referência para gerar à mão:
#
#   apps/pdv/instalador/linux/gerar-pacote.sh [versão X.Y.Z] [URL padrão da API]
#
# Sem versão vale a <Version> do apps/pdv/Directory.Build.props (a fonte única); sem URL, a do piloto. Saída:
# apps/pdv/publish/deb/genesispdv_<versão>_amd64.deb (+ .sha256).
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pasta_pdv=$(cd "$aqui/../.." && pwd)
projeto="$pasta_pdv/src/GenesisPDV.App/GenesisPDV.App.csproj"
publicacao="$pasta_pdv/publish/linux-x64"
saida="$pasta_pdv/publish/deb"
versao=${1:-}
url=${2:-https://api.grupoicebeer.com.br}

if [ -z "$versao" ]; then
  versao=$(dotnet msbuild "$projeto" -getProperty:Version | tr -d '[:space:]')
fi
if ! [[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::versão inválida '$versao' (use X.Y.Z)" >&2
  exit 1
fi
echo "GenesisPDV $versao, API padrão $url"

# dotnet publish nunca leva a demonstração (ModoDemonstracao=false ao publicar).
rm -rf "$publicacao"
dotnet publish "$projeto" -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true \
  "-p:Version=$versao" "-p:GenesisUrlApiPadrao=$url" -o "$publicacao"

info=$(mktemp)
trap 'rm -f "$info"' EXIT
"$publicacao/GenesisPDV" --info-build "$info"
# shellcheck disable=SC2016 # $v e $u são variáveis do jq, não do shell.
if ! jq -e --arg v "$versao" --arg u "$url" '.versao == $v and .url_api_padrao == $u and .modo_demonstracao == false' "$info" >/dev/null; then
  echo "::error::o executável publicado não confere: $(cat "$info")" >&2
  exit 1
fi
echo "Executável conferido: $(jq -c . "$info")"

rm -rf "$saida"
pacote=$("$aqui/gerar-deb.sh" "$versao" "$publicacao" "$saida")
echo "Pacote: $pacote ($(du -h "$pacote" | cut -f1), sha256 $(cut -d' ' -f1 "$pacote.sha256"))"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "pacote=$pacote"
    echo "versao=$versao"
  } >>"$GITHUB_OUTPUT"
fi
