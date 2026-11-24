#!/usr/bin/env bash
# Gera, no Linux, o mesmo instalador do GenesisPDV para Windows que o gerar-instalador.ps1 gera no runner Windows
# (OP-B3, D70-Q2: sem cota do GitHub Actions; README do PDV › decisão 93 e "Instalar na loja"):
#
#   apps/pdv/instalador/linux-wine/gerar-instalador.sh [--versao X.Y.Z] [--url-api https://...] [--runtime 10.0.N]
#
# 1. publica o executável único self-contained win-x64 com as mesmas opções do gerar-instalador.ps1 (a versão e a URL
#    padrão da API; o dotnet publish nunca leva a demonstração) e devolve os packages.lock.json como estavam (o
#    `dotnet publish -r` os edita, e essa mudança não se versiona: README do PDV › Restore travado). O .NET embutido é
#    a última correção do .NET 10 publicada no nuget.org (o pacote Microsoft.NETCore.App.Runtime.win-x64), como sai do
#    runner Windows, que monta com o SDK mais novo da faixa do global.json: o SDK 10.0.100 da sessão sozinho embutiria
#    o 10.0.0, sem as correções de segurança (--runtime fixa outra);
# 2. confere o executável pelo --info-build rodando no Wine (versão, URL e sem demonstração), como o script do Windows;
# 3. baixa o instalador do Inno Setup da versão fixa abaixo (a mesma do gerar-instalador.ps1), confere o sha256 fixo
#    ANTES de rodá-lo e o instala num prefixo do Wine próprio e descartável (apagado no fim, mesmo com falha);
# 4. compila o GenesisPDV.iss com o ISCC desse Inno Setup e grava o .sha256 no formato do sha256sum (o mesmo do
#    release e o que o `implantar.sh pdv publicar` confere) e o .origem.json (URL da API, commit, árvore limpa ou não,
#    versões), que o publicar-release.sh confere antes de publicar. Árvore limpa: nada no `git status` do apps/pdv,
#    nenhum arquivo ignorado nele fora de bin/, obj/ e publish/ (o .csproj.user que o MSBuild importa, por exemplo) e
#    nenhum Directory.Build.* ou nuget.config fora do git acima dele.
#
# Saída (pasta ignorada pelo git, a mesma do script do Windows): apps/pdv/publish/instalador/GenesisPDV-Setup-<versão>.exe,
# .exe.sha256 e .exe.origem.json. Sem assinatura: o certificado de código só existe no caminho do Windows (decisão 62);
# com PDV_CERT_PFX_BASE64 no ambiente o script recusa, em vez de gerar sem assinar em silêncio. Sem --versao vale a
# <Version> do apps/pdv/Directory.Build.props (a fonte única). Depois: testar-instalador.sh (a conferência) e, para o
# release oficial, publicar-release.sh.
#
# Precisa de: dotnet (o SDK do apps/pdv/global.json), wine com suporte a 32 bits (o Setup e o ISCC do Inno Setup 6 são
# de 32 bits: no Ubuntu, `dpkg --add-architecture i386 && apt-get install wine64 wine32:i386`), curl, jq, sha256sum e
# ~2 GB livres (o prefixo do Wine ocupa ~1,3 GB enquanto existe). Nada disso vai para o repositório.
set -euo pipefail

# Inno Setup fixo (o $VersaoInnoSetup do gerar-instalador.ps1): atualizar é trocar os três juntos, revisado como
# qualquer mudança. Desde março de 2026 o files.jrsoftware.org manda para os releases imutáveis do GitHub do projeto
# (o readme.txt de lá); o sha256 abaixo é o mesmo "file-hash" do innosetup-6.4.3.exe.issig publicado no
# files.jrsoftware.org (conferido em 24/11/2026).
VERSAO_INNO=6.4.3
URL_INNO=https://github.com/jrsoftware/issrc/releases/download/is-6_4_3/innosetup-6.4.3.exe
SHA256_INNO=f3c42116542c4cc57263c5ba6c4feabfc49fe771f2f98a79d2f7628b8762723b

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pasta_pdv=$(cd "$aqui/../.." && pwd)
projeto="$pasta_pdv/src/GenesisPDV.App/GenesisPDV.App.csproj"
iss="$pasta_pdv/instalador/windows/GenesisPDV.iss"
publicacao="$pasta_pdv/publish/win-x64"
saida="$pasta_pdv/publish/instalador"
cache="$pasta_pdv/publish/linux-wine"
versao=''
url_api=https://api.grupoicebeer.com.br
runtime=''

erro() {
  echo "gerar-instalador: $*" >&2
  exit 1
}
uso() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --versao)
      (($# >= 2)) || erro '--versao precisa de X.Y.Z'
      versao=$2
      shift 2
      ;;
    --url-api)
      (($# >= 2)) || erro '--url-api precisa da URL'
      url_api=$2
      shift 2
      ;;
    --runtime)
      (($# >= 2)) || erro '--runtime precisa da versão 10.0.N'
      runtime=$2
      shift 2
      ;;
    -h | --ajuda)
      uso
      exit 0
      ;;
    *) erro "opção desconhecida: $1 (ajuda: $0 --ajuda)" ;;
  esac
done

if [ -z "$versao" ]; then
  versao=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$pasta_pdv/Directory.Build.props" | head -n 1)
fi
# Só X.Y.Z: é o que vai no VersionInfo do Windows, no nome do arquivo e no versao_app comparado pela nuvem.
[[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "versão inválida '$versao' (use X.Y.Z)"
[[ $url_api =~ ^https://[^[:space:]]+$ ]] || erro "URL da API inválida '$url_api' (https://, sem espaços)"
[ -z "${PDV_CERT_PFX_BASE64:-}" ] ||
  erro 'PDV_CERT_PFX_BASE64 no ambiente: a assinatura só existe no gerar-instalador.ps1 (Windows); este caminho gera sem assinatura'

for comando in dotnet wine wineboot wineserver winepath curl jq sha256sum git tar timeout; do
  command -v "$comando" >/dev/null 2>&1 || erro "falta o comando '$comando' (veja o começo deste script)"
done
# O Wine 9 do Ubuntu, sem /run/user/<uid>, cai num diretório de servidor em /tmp e aborta ("free(): invalid pointer");
# como root, a pasta é criada aqui (é o que o systemd-logind faria numa sessão normal).
pasta_execucao="/run/user/$(id -u)"
if [ ! -d "$pasta_execucao" ]; then
  [ "$(id -u)" = 0 ] || erro "falta $pasta_execucao (o Wine 9 precisa dele): peça para criá-lo (dono você, permissão 700)"
  mkdir -p /run/user && mkdir -m 700 "$pasta_execucao"
fi
# .NET embutido: o do --runtime ou a correção mais nova do .NET 10 no nuget.org (o mesmo pacote que o publish baixa).
if [ -z "$runtime" ]; then
  runtime=$(curl -fsSL --proto '=https' --retry 3 \
    https://api.nuget.org/v3-flatcontainer/microsoft.netcore.app.runtime.win-x64/index.json |
    jq -r '.versions[]' | grep -E '^10\.0\.[0-9]+$' | sort -V | tail -n 1) ||
    erro 'não foi possível consultar no nuget.org a última correção do .NET 10 (use --runtime 10.0.N)'
fi
[[ $runtime =~ ^10\.0\.[0-9]+$ ]] || erro "versão do .NET inválida '$runtime' (use 10.0.N)"
livre_kb=$(df -Pk "${TMPDIR:-/tmp}" | awk 'NR == 2 { print $4 }')
[ "${livre_kb:-0}" -ge 2000000 ] ||
  erro "pouco espaço livre em ${TMPDIR:-/tmp} ($((${livre_kb:-0} / 1024)) MB; o prefixo do Wine e a publicação pedem ~2 GB)"

# Origem do instalador (o publicar-release.sh confere): o commit e se a árvore do PDV estava igual a ele. Contam como
# alteração, além do que o `git status` mostra, o arquivo ignorado pelo git no apps/pdv fora de bin/, obj/ e publish/
# (o build lê sozinho alguns deles: o <projeto>.csproj.user que o MSBuild importa, um .props, .targets ou .rsp local) e,
# acima do apps/pdv, um Directory.Build.* ou nuget.config fora do git (o MSBuild e o NuGet os procuram para cima).
alteracoes() {
  local d arquivo
  git -C "$pasta_pdv" status --porcelain -- . || echo '?? (git status falhou)'
  git -C "$pasta_pdv" ls-files --others --ignored --exclude-standard -- . | grep -Ev '(^|/)(bin|obj)/|^publish/' |
    sed 's/^/!! /' || true
  d=$(dirname "$pasta_pdv")
  while :; do
    for arquivo in Directory.Build.props Directory.Build.targets Directory.Build.rsp Directory.Packages.props \
      nuget.config NuGet.config NuGet.Config; do
      [ -e "$d/$arquivo" ] || continue
      if git -C "$pasta_pdv" ls-files --error-unmatch -- "$d/$arquivo" >/dev/null 2>&1; then
        git -C "$pasta_pdv" status --porcelain -- "$d/$arquivo"
      else
        echo "!! $d/$arquivo (fora do git, acima do apps/pdv)"
      fi
    done
    [ "$d" != / ] || break
    d=$(dirname "$d")
  done
}
commit=$(git -C "$pasta_pdv" rev-parse HEAD 2>/dev/null || echo '')
arvore_limpa=false
if [ -n "$commit" ]; then
  sujeira=$(alteracoes 2>/dev/null)
  if [ -z "$sujeira" ]; then
    arvore_limpa=true
  else
    echo "Alterações em relação ao commit (o release recusa este instalador):" >&2
    head -n 20 <<<"$sujeira" | sed 's/^/  /' >&2
  fi
fi
echo "GenesisPDV $versao, API padrão $url_api, .NET $runtime (commit ${commit:-?}, árvore do PDV $([ "$arvore_limpa" = true ] && echo limpa || echo 'com alterações'))"

temporario=$(mktemp -d "${TMPDIR:-/tmp}/genesispdv-instalador.XXXXXX")
export WINEPREFIX="$temporario/prefixo" WINEARCH=win64 WINEDEBUG=-all
# Sem Mono e Gecko (o Wine perguntaria numa janela) e sem tela: o driver gráfico "null" fica no registro do prefixo.
export WINEDLLOVERRIDES='mscoree,mshtml='
unset DISPLAY WAYLAND_DISPLAY
limpar() {
  local status=$?
  if [ -f "$temporario/locks.tar" ]; then
    tar -xf "$temporario/locks.tar" -C "$pasta_pdv" || echo 'gerar-instalador: não devolvi os packages.lock.json; confira com git status' >&2
  fi
  if [ -d "$WINEPREFIX" ]; then
    timeout 60 wineserver -k >/dev/null 2>&1 || true
  fi
  rm -rf "$temporario"
  exit "$status"
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 1. Publicação win-x64 (as mesmas opções do gerar-instalador.ps1), com os lock files guardados antes e devolvidos
# logo depois (e pelo trap, se o publish falhar).
(cd "$pasta_pdv" && find . -name packages.lock.json -not -path '*/bin/*' -not -path '*/obj/*' -not -path './publish/*' -print0 |
  tar --null -cf "$temporario/locks.tar" -T -)
rm -rf "$publicacao"
dotnet publish "$projeto" -c Release -r win-x64 --self-contained -p:PublishSingleFile=true \
  "-p:Version=$versao" "-p:GenesisUrlApiPadrao=$url_api" "-p:RuntimeFrameworkVersion=$runtime" -o "$publicacao"
tar -xf "$temporario/locks.tar" -C "$pasta_pdv"
rm -f "$temporario/locks.tar"
exe="$publicacao/GenesisPDV.exe"
[ -f "$exe" ] || erro "a publicação não gerou $exe"
extras=$(find "$publicacao" -mindepth 1 -maxdepth 1 ! -name GenesisPDV.exe -printf '%f ')
[ -z "$extras" ] || erro "a publicação deveria ter só o GenesisPDV.exe; veio também: $extras"

# 2. Prefixo do Wine descartável e a conferência do executável publicado (o mesmo que vai para o instalador).
timeout 300 wineboot -i >"$temporario/wineboot.log" 2>&1 || {
  cat "$temporario/wineboot.log" >&2
  erro 'o wineboot não preparou o prefixo do Wine'
}
timeout 120 wine reg add 'HKCU\Software\Wine\Drivers' /v Graphics /d null /f >/dev/null 2>&1 ||
  erro 'não foi possível desligar a tela no prefixo do Wine (driver null)'
# O wineboot termina de preparar o prefixo em segundo plano; sem esperar, o Setup do Inno falha ao criar as janelas
# ("Error reading FPreparingMemo.Lines.Strings").
timeout 120 wineserver -w || true
info_win=$(winepath -w "$temporario/info-build.json")
timeout 300 wine "$(winepath -w "$exe")" --info-build "$info_win" >"$temporario/info-build.log" 2>&1 || true
[ -s "$temporario/info-build.json" ] || {
  cat "$temporario/info-build.log" >&2
  erro 'GenesisPDV.exe --info-build não gravou o arquivo no Wine'
}
# shellcheck disable=SC2016 # $v e $u são variáveis do jq, não do shell.
jq -e --arg v "$versao" --arg u "$url_api" '.versao == $v and .url_api_padrao == $u and .modo_demonstracao == false' \
  "$temporario/info-build.json" >/dev/null || erro "o executável publicado não confere: $(jq -c . "$temporario/info-build.json")"
echo "Executável conferido: $(jq -c . "$temporario/info-build.json")"

# 3. Inno Setup: o download fica guardado em publish/linux-wine e o sha256 é conferido a cada uso, antes de rodar.
mkdir -p "$cache"
setup_inno="$cache/innosetup-$VERSAO_INNO.exe"
if [ ! -f "$setup_inno" ] || [ "$(sha256sum "$setup_inno" | cut -d' ' -f1)" != "$SHA256_INNO" ]; then
  rm -f "$setup_inno"
  echo "Baixando o Inno Setup $VERSAO_INNO ($URL_INNO)"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$setup_inno.parcial" "$URL_INNO" ||
    erro "não foi possível baixar o Inno Setup $VERSAO_INNO"
  baixado=$(sha256sum "$setup_inno.parcial" | cut -d' ' -f1)
  if [ "$baixado" != "$SHA256_INNO" ]; then
    rm -f "$setup_inno.parcial"
    erro "o sha256 do Inno Setup baixado ($baixado) não é o fixado ($SHA256_INNO); nada foi executado"
  fi
  mv -f "$setup_inno.parcial" "$setup_inno"
fi
# /ALLUSERS: no modo "só para mim" o Setup não acha a pasta {autopf} no Wine.
timeout 300 wine "$(winepath -w "$setup_inno")" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /NOICONS \
  '/DIR=C:\inno' '/LOG=C:\inno-instalacao.log' >"$temporario/inno.log" 2>&1 || true
iscc="$WINEPREFIX/drive_c/inno/ISCC.exe"
[ -f "$iscc" ] || {
  cat "$WINEPREFIX/drive_c/inno-instalacao.log" "$temporario/inno.log" >&2 2>/dev/null || true
  erro "o Inno Setup $VERSAO_INNO não se instalou no prefixo do Wine (32 bits? veja o começo deste script)"
}
echo "Inno Setup $VERSAO_INNO (sha256 $SHA256_INNO) no prefixo descartável"

# 4. Compilação do .iss, com os mesmos /D do gerar-instalador.ps1 (sem /DAssinar).
nome="GenesisPDV-Setup-$versao.exe"
mkdir -p "$saida"
rm -f "$saida/$nome" "$saida/$nome.sha256" "$saida/$nome.origem.json" "$saida/$nome.conferido"
if ! timeout 900 wine 'C:\inno\ISCC.exe' /Q "/DVersaoApp=$versao" "/DPastaPublicacao=$(winepath -w "$publicacao")" \
  "/DPastaSaida=$(winepath -w "$saida")" "$(winepath -w "$iss")" >"$temporario/iscc.log" 2>&1; then
  cat "$temporario/iscc.log" >&2
  erro 'ISCC (Inno Setup) falhou'
fi
timeout 120 wineserver -w || true
instalador="$saida/$nome"
[ -f "$instalador" ] || erro "instalador não gerado: $instalador"
# O cabeçalho do instalador diz com que Inno Setup ele foi compilado.
grep -aqF "Inno Setup Setup Data ($VERSAO_INNO)" "$instalador" ||
  erro "o instalador gerado não é do Inno Setup $VERSAO_INNO"

# 5. sha256 no formato do sha256sum (confere com "sha256sum -c" ou Get-FileHash) e a origem.
(cd "$saida" && sha256sum "$nome" >"$nome.sha256")
hash=$(cut -d' ' -f1 "$saida/$nome.sha256")
jq -n --arg versao "$versao" --arg url "$url_api" --arg commit "$commit" --argjson limpa "$arvore_limpa" \
  --arg inno "$VERSAO_INNO" --arg runtime "$runtime" --arg sha "$hash" --arg em "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{versao: $versao, url_api_padrao: $url, commit: $commit, arvore_limpa: $limpa, inno_setup: $inno,
    dotnet: $runtime, sha256: $sha, gerado_em: $em, gerador: "linux-wine"}' >"$saida/$nome.origem.json"
echo "Instalador: $instalador ($(du -h "$instalador" | cut -f1), sha256 $hash)"
