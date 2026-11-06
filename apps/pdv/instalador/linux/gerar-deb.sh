#!/usr/bin/env bash
# Gera o pacote .deb do GenesisPDV (implantação I3; PDV 5.1; README do PDV › "Instalar na loja" e decisão 62) a partir
# do executável único publicado para linux-x64:
#
#   apps/pdv/instalador/linux/gerar-deb.sh <versão X.Y.Z> <pasta da publicação linux-x64> <pasta de saída>
#
# Conteúdo: /opt/genesispdv/GenesisPDV, /usr/bin/genesispdv, o atalho .desktop e o ícone; o postinst cria o grupo
# genesispdv e /var/lib/genesispdv e /var/log/genesispdv (root:genesispdv, 2770); remover ou expurgar o pacote não
# apaga os dados. Saída: genesispdv_<versão>_amd64.deb e o .sha256 (formato do sha256sum). O AppImage fica para depois
# (as lojas do piloto são Windows, D21).
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "uso: $0 <versão X.Y.Z> <pasta da publicação linux-x64> <pasta de saída>" >&2
  exit 2
fi

versao=$1
publicacao=$2
saida=$3
aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
icone="$aqui/../../src/GenesisPDV.App/Assets/genesispdv.png"

if ! [[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "versão inválida '$versao' (use X.Y.Z)" >&2
  exit 2
fi
if [ ! -x "$publicacao/GenesisPDV" ]; then
  echo "executável não encontrado em $publicacao/GenesisPDV (dotnet publish -r linux-x64 -p:PublishSingleFile=true)" >&2
  exit 2
fi

raiz=$(mktemp -d)
trap 'rm -rf "$raiz"' EXIT
chmod 0755 "$raiz"

install -d "$raiz/DEBIAN" "$raiz/opt/genesispdv" "$raiz/usr/bin" "$raiz/usr/share/applications" \
  "$raiz/usr/share/icons/hicolor/256x256/apps"
install -m 0755 "$publicacao/GenesisPDV" "$raiz/opt/genesispdv/GenesisPDV"
ln -s /opt/genesispdv/GenesisPDV "$raiz/usr/bin/genesispdv"
install -m 0644 "$aqui/genesispdv.desktop" "$raiz/usr/share/applications/genesispdv.desktop"
install -m 0644 "$icone" "$raiz/usr/share/icons/hicolor/256x256/apps/genesispdv.png"
install -m 0755 "$aqui/debian/postinst" "$aqui/debian/postrm" "$raiz/DEBIAN/"

tamanho=$(du -sk --exclude=DEBIAN "$raiz" | cut -f1)
# O contato do pacote (campo obrigatório do Debian); padrão até a confirmação do dono (README do PDV › decisão 62).
mantenedor=${GENESISPDV_DEB_MANTENEDOR:-Genesis <suporte@genesispdv.com.br>}
# Dependências do runtime self-contained do .NET (ICU para a cultura pt-BR, OpenSSL para o HTTPS) e do Avalonia (X11,
# fontconfig). As alternativas cobrem Debian 12 e Ubuntu 22.04/24.04 (README do PDV › Pré-requisitos).
cat >"$raiz/DEBIAN/control" <<EOF
Package: genesispdv
Version: $versao
Architecture: amd64
Maintainer: $mantenedor
Installed-Size: $tamanho
Section: misc
Priority: optional
Depends: libc6, libgcc-s1, libstdc++6, zlib1g, libssl3 | libssl3t64, libicu78 | libicu77 | libicu76 | libicu74 | libicu72 | libicu70, libfontconfig1, libx11-6, libice6, libsm6
Description: GenesisPDV - frente de caixa do Genesis
 PDV desktop (Avalonia) que funciona offline e sincroniza com a nuvem do Genesis.
 Dados em /var/lib/genesispdv e logs em /var/log/genesispdv (grupo genesispdv).
EOF

mkdir -p "$saida"
pacote="$saida/genesispdv_${versao}_amd64.deb"
dpkg-deb --root-owner-group --build "$raiz" "$pacote" >/dev/null
(cd "$saida" && sha256sum "$(basename "$pacote")" >"$(basename "$pacote").sha256")
echo "$pacote"
