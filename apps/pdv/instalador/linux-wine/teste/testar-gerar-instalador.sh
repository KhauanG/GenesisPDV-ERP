#!/usr/bin/env bash
# Testes de unidade do gerar-instalador.sh (OP-B3; README do PDV › decisão 93), sem .NET, Wine nem rede: o script roda
# numa raiz falsa (um repositório git com o apps/pdv mínimo) com dublês do dotnet, wine, wineboot, wineserver,
# winepath e curl no PATH. A cópia do script na raiz falsa troca só o sha256 fixado do Inno Setup pelo do conteúdo que
# o curl falso entrega (o de verdade não se forja) e o mínimo de espaço livre. Cobre: as opções do dotnet publish (as
# do gerar-instalador.ps1 e o .NET da última correção do nuget.org), os packages.lock.json devolvidos como estavam
# (também pelo trap, quando o dotnet publish falha depois de editá-los), a conferência do --info-build no Wine, o
# sha256 do Inno Setup conferido ANTES de rodá-lo (o errado não executa e não fica no cache), os /D do ISCC, o .sha256
# no formato do sha256sum e o .origem.json (commit, árvore limpa ou não: alteração versionada, arquivo ignorado que o
# build lê, como o .csproj.user, e Directory.Build.* fora do git acima do apps/pdv; bin/ e obj/ não contam), as
# recusas (publicação com arquivo a mais, executável que não confere, PDV_CERT_PFX_BASE64, versão inválida) e o
# prefixo do Wine apagado no fim, mesmo com falha.
#
#   bash apps/pdv/instalador/linux-wine/teste/testar-gerar-instalador.sh
# Precisa de bash, git, jq e coreutils.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-gerar-instalador.XXXXXX")
trap 'rm -rf "$T"' EXIT
export REGISTRO=$T/registro DUBLE=$T/duble
BIN=$T/bin
mkdir -p "$BIN" "$DUBLE" "$T/tmp"
unset PDV_CERT_PFX_BASE64 PDV_CERT_SENHA

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  [[ -f $T/saida ]] && sed 's/^/    | /' "$T/saida" >&2
  [[ -f $REGISTRO ]] && sed 's/^/    registro| /' "$REGISTRO" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Raiz falsa -------------------------------------------------------------------------------------------------------
RAIZ=$T/raiz
PDV=$RAIZ/apps/pdv
mkdir -p "$PDV/instalador/linux-wine" "$PDV/instalador/windows" "$PDV/src/GenesisPDV.App" "$PDV/src/GenesisPDV.Core"
printf '<Project><PropertyGroup><Version>0.14.0</Version></PropertyGroup></Project>\n' >"$PDV/Directory.Build.props"
echo '<Project />' >"$PDV/src/GenesisPDV.App/GenesisPDV.App.csproj"
echo '; iss' >"$PDV/instalador/windows/GenesisPDV.iss"
echo '{"version": 2}' >"$PDV/src/GenesisPDV.App/packages.lock.json"
echo '{"version": 2, "core": true}' >"$PDV/src/GenesisPDV.Core/packages.lock.json"
printf 'apps/pdv/publish/\nbin/\nobj/\n*.user\n' >"$RAIZ/.gitignore"
# O "instalador do Inno Setup" que o curl falso entrega; a cópia do script passa a fixar o sha256 dele.
echo 'instalador do inno de teste' >"$DUBLE/inno-bom"
SHA_BOM=$(sha256sum "$DUBLE/inno-bom" | cut -d' ' -f1)
sed -e "s/^SHA256_INNO=.*/SHA256_INNO=$SHA_BOM/" -e 's/-ge 2000000 \]/-ge 0 ]/' \
  "$AQUI/../gerar-instalador.sh" >"$PDV/instalador/linux-wine/gerar-instalador.sh"
chmod +x "$PDV/instalador/linux-wine/gerar-instalador.sh"
grep -q "^SHA256_INNO=$SHA_BOM$" "$PDV/instalador/linux-wine/gerar-instalador.sh" || falha 'a cópia não trocou o sha256 fixado'
git -C "$RAIZ" init -q -b main
git -C "$RAIZ" add -A
git -C "$RAIZ" -c user.name=teste -c user.email=teste@exemplo.invalid commit -qm inicio
COMMIT=$(git -C "$RAIZ" rev-parse HEAD)
LOCKS_ANTES=$(cd "$PDV" && sha256sum src/*/packages.lock.json)

# --- Dublês -----------------------------------------------------------------------------------------------------------
# dotnet publish: grava o GenesisPDV.exe na pasta do -o e edita um lock file (como o `publish -r` de verdade);
# $DUBLE/publicacao-extra: deixa também um .pdb; $DUBLE/publish-falha: edita o lock file e sai com 1 (o restore ou a
# compilação que quebra no meio).
cat >"$BIN/dotnet" <<'EOF'
#!/usr/bin/env bash
echo "dotnet $*" >>"$REGISTRO"
saida=''
while (($#)); do [[ $1 == -o ]] && { saida=$2; shift; }; shift; done
mkdir -p "$saida"
echo 'exe de teste' >"$saida/GenesisPDV.exe"
[[ -e $DUBLE/publicacao-extra ]] && echo pdb >"$saida/GenesisPDV.pdb"
echo '{"version": 2, "editado pelo publish": true}' >"$(dirname "$(dirname "$saida")")/src/GenesisPDV.App/packages.lock.json"
[[ -e $DUBLE/publish-falha ]] && { echo 'error NU1301: dublê' >&2; exit 1; }
exit 0
EOF
# winepath -w: /a/b → Z:\a\b. wine: converte Z:\ de volta; o GenesisPDV.exe --info-build grava o JSON
# ($DUBLE/info-demonstracao: com a demonstração ligada); o Setup do Inno cria o ISCC.exe no prefixo; o ISCC grava o
# instalador na PastaSaida.
cat >"$BIN/winepath" <<'EOF'
#!/usr/bin/env bash
[[ $1 == -w ]] && shift
printf 'Z:%s\n' "${1//\//\\}"
EOF
cat >"$BIN/wine" <<'EOF'
#!/usr/bin/env bash
echo "wine $* | prefixo=$WINEPREFIX" >>"$REGISTRO"
unix() { local c=${1#Z:}; printf '%s' "${c//\\//}"; }
case "$1" in
  reg) exit 0 ;;
  *GenesisPDV.exe)
    if [[ -e $DUBLE/info-demonstracao ]]; then demo=true; else demo=false; fi
    printf '{"versao":"0.14.0","url_api_padrao":"https://api.grupoicebeer.com.br","modo_demonstracao":%s}\n' "$demo" >"$(unix "$3")"
    ;;
  *innosetup-*.exe) mkdir -p "$WINEPREFIX/drive_c/inno" && echo iscc >"$WINEPREFIX/drive_c/inno/ISCC.exe" ;;
  'C:\inno\ISCC.exe')
    for a in "$@"; do
      case "$a" in /DVersaoApp=*) v=${a#*=} ;; /DPastaSaida=*) s=$(unix "${a#*=}") ;; esac
    done
    printf 'MZ ... Inno Setup Setup Data (6.4.3) ...\n' >"$s/GenesisPDV-Setup-$v.exe"
    ;;
esac
EOF
cat >"$BIN/wineboot" <<'EOF'
#!/usr/bin/env bash
echo "wineboot $* | prefixo=$WINEPREFIX" >>"$REGISTRO"
mkdir -p "$WINEPREFIX/drive_c"
EOF
cat >"$BIN/wineserver" <<'EOF'
#!/usr/bin/env bash
echo "wineserver $*" >>"$REGISTRO"
EOF
# curl: o índice do nuget.org com as versões do runtime; o Inno Setup bom ou, com $DUBLE/inno-errado, outro conteúdo.
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$REGISTRO"
saida='' url=''
while (($#)); do case $1 in -o) saida=$2; shift ;; https://*) url=$1 ;; esac; shift; done
case "$url" in
  *api.nuget.org*) echo '{"versions":["9.0.5","10.0.0","10.0.9","10.0.15","10.0.16-preview.1","11.0.0"]}' ;;
  *innosetup-6.4.3.exe)
    if [[ -e $DUBLE/inno-errado ]]; then echo 'outro conteúdo' >"$saida"; else cp "$DUBLE/inno-bom" "$saida"; fi ;;
  *) exit 22 ;;
esac
EOF
chmod +x "$BIN"/*

GI="$PDV/instalador/linux-wine/gerar-instalador.sh"
SAIDA=$PDV/publish/instalador
NOME=GenesisPDV-Setup-0.14.0.exe
rodar() {
  : >"$REGISTRO"
  STATUS=0
  env TMPDIR="$T/tmp" PATH="$BIN:$PATH" "$@" >"$T/saida" 2>&1 || STATUS=$?
}
sem_sobras() {
  [[ -z $(ls -A "$T/tmp") ]] || falha "$1: sobrou no TMPDIR: $(ls -A "$T/tmp")"
  [[ $(cd "$PDV" && sha256sum src/*/packages.lock.json) == "$LOCKS_ANTES" ]] || falha "$1: os packages.lock.json mudaram"
}

# 1. Caminho feliz.
rodar "$GI"
[[ $STATUS == 0 ]] || falha "caminho feliz saiu com $STATUS"
grep -qF -- "dotnet publish $PDV/src/GenesisPDV.App/GenesisPDV.App.csproj -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -p:Version=0.14.0 -p:GenesisUrlApiPadrao=https://api.grupoicebeer.com.br -p:RuntimeFrameworkVersion=10.0.15 -o $PDV/publish/win-x64" "$REGISTRO" ||
  falha 'o dotnet publish não tem as opções do gerar-instalador.ps1 e o .NET 10.0.15'
grep -q 'wine Z:.*innosetup-6.4.3.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /NOICONS /DIR=C:\\inno' "$REGISTRO" ||
  falha 'não instalou o Inno Setup em silêncio no prefixo'
grep -qF "wine C:\\inno\\ISCC.exe /Q /DVersaoApp=0.14.0 /DPastaPublicacao=Z:${PDV//\//\\}\\publish\\win-x64 /DPastaSaida=Z:${SAIDA//\//\\} Z:${PDV//\//\\}\\instalador\\windows\\GenesisPDV.iss" "$REGISTRO" ||
  falha 'o ISCC não recebeu os /D do gerar-instalador.ps1'
grep -q '/DAssinar' "$REGISTRO" && falha 'pediu assinatura'
prefixos=$(grep -o 'prefixo=[^ ]*' "$REGISTRO" | sort -u)
[[ $(wc -l <<<"$prefixos") == 1 && $prefixos == "prefixo=$T/tmp/"* ]] || falha "prefixo do Wine fora do temporário: $prefixos"
(cd "$SAIDA" && sha256sum -c --quiet "$NOME.sha256") || falha 'o .sha256 não confere'
grep -qxE "[0-9a-f]{64}  $NOME" "$SAIDA/$NOME.sha256" || falha '.sha256 fora do formato do sha256sum'
# shellcheck disable=SC2016 # $c é variável do jq.
jq -e --arg c "$COMMIT" --arg h "$(cut -d' ' -f1 "$SAIDA/$NOME.sha256")" '.versao == "0.14.0" and .commit == $c and
  .arvore_limpa == true and .inno_setup == "6.4.3" and .dotnet == "10.0.15" and .sha256 == $h' "$SAIDA/$NOME.origem.json" >/dev/null ||
  falha "origem: $(cat "$SAIDA/$NOME.origem.json")"
[[ $(sha256sum "$PDV/publish/linux-wine/innosetup-6.4.3.exe" | cut -d' ' -f1) == "$SHA_BOM" ]] || falha 'o Inno Setup não ficou no cache'
sem_sobras 'caminho feliz'
confere 'caminho feliz: publish do ps1 com o .NET mais novo, Inno no prefixo descartável, ISCC com os /D, .sha256 e origem'

# 2. Cache do Inno Setup conferido de novo: com o arquivo bom no cache, não baixa; trocado no cache, baixa outra vez.
rodar "$GI"
[[ $STATUS == 0 ]] || falha "segunda rodada saiu com $STATUS"
grep -q 'curl.*innosetup' "$REGISTRO" && falha 'baixou de novo o Inno Setup que já estava no cache'
echo adulterado >"$PDV/publish/linux-wine/innosetup-6.4.3.exe"
rodar "$GI"
[[ $STATUS == 0 ]] || falha "cache adulterado saiu com $STATUS"
grep -q 'curl.*innosetup' "$REGISTRO" || falha 'usou o Inno Setup adulterado do cache sem baixar de novo'
confere 'cache do Inno Setup: conferido pelo sha256 a cada uso (o adulterado é baixado de novo)'

# 3. Inno Setup baixado com outro sha256: recusa antes de rodá-lo e não guarda no cache.
rm -f "$PDV/publish/linux-wine/innosetup-6.4.3.exe"
touch "$DUBLE/inno-errado"
rodar "$GI"
rm -f "$DUBLE/inno-errado"
[[ $STATUS == 1 ]] || falha "Inno errado saiu com $STATUS"
grep -q 'não é o fixado' "$T/saida" || falha 'sem a mensagem do sha256 do Inno Setup'
grep -q 'wine .*innosetup' "$REGISTRO" && falha 'rodou o Inno Setup com o sha256 errado'
[[ -z $(ls "$PDV/publish/linux-wine/" 2>/dev/null) ]] || falha "sobrou o download errado: $(ls "$PDV/publish/linux-wine/")"
sem_sobras 'Inno errado'
confere 'Inno Setup com outro sha256: recusado antes de rodar, nada fica no cache, prefixo apagado'

# 4. Executável que não confere (demonstração ligada): recusa antes do Inno Setup.
touch "$DUBLE/info-demonstracao"
rodar "$GI"
rm -f "$DUBLE/info-demonstracao"
[[ $STATUS == 1 ]] || falha "demonstração saiu com $STATUS"
grep -q 'o executável publicado não confere' "$T/saida" || falha 'sem a mensagem do --info-build'
grep -q 'ISCC\|innosetup' "$REGISTRO" && falha 'seguiu para o Inno Setup com o executável errado'
sem_sobras 'demonstração'
confere 'executável publicado com a demonstração: recusa antes do Inno Setup'

# 5. Publicação com arquivo a mais, PDV_CERT_PFX_BASE64, versão inválida.
touch "$DUBLE/publicacao-extra"
rodar "$GI"
rm -f "$DUBLE/publicacao-extra"
recusou() { [[ $STATUS == 1 ]] && grep -q -- "$1" "$T/saida"; }
recusou 'GenesisPDV.pdb' || falha "publicação com o .pdb: saída $STATUS"
sem_sobras 'publicação extra'
rodar env PDV_CERT_PFX_BASE64=x "$GI"
recusou 'assinatura só existe no gerar-instalador.ps1' || falha "certificado: saída $STATUS"
[[ -s $REGISTRO ]] && falha 'com o certificado no ambiente, rodou algum comando'
rodar "$GI" --versao 1.2
recusou 'versão inválida' || falha "versão inválida: saída $STATUS"
rodar "$GI" --runtime 9.0.1
recusou 'versão do .NET inválida' || falha "--runtime 9: saída $STATUS"
confere 'recusas: publicação com arquivo a mais, certificado no ambiente, versão e .NET inválidos'

# 5b. dotnet publish que falha depois de editar o lock file: o trap devolve os packages.lock.json e apaga o temporário.
touch "$DUBLE/publish-falha"
rodar "$GI"
rm -f "$DUBLE/publish-falha"
[[ $STATUS != 0 ]] || falha 'o publish que falha saiu com 0'
grep -q 'wine\|ISCC' "$REGISTRO" && falha 'seguiu depois do publish que falhou'
sem_sobras 'publish que falha'
confere 'dotnet publish que falha: o trap devolve os packages.lock.json editados e apaga o temporário'

# 6. Árvore do PDV com alteração não commitada: a origem diz arvore_limpa false (o publicar-release.sh recusa).
echo mudou >>"$PDV/Directory.Build.props"
rodar "$GI" --versao 0.14.0
git -C "$RAIZ" checkout -q -- apps/pdv/Directory.Build.props
[[ $STATUS == 0 ]] || falha "árvore suja saiu com $STATUS"
[[ $(jq -r .arvore_limpa "$SAIDA/$NOME.origem.json") == false ]] || falha 'a origem não registrou a árvore suja'
# bin/ e obj/ (ignorados) não contam: a árvore continua limpa.
mkdir -p "$PDV/src/GenesisPDV.App/bin/Release" "$PDV/src/GenesisPDV.App/obj"
touch "$PDV/src/GenesisPDV.App/bin/Release/x.dll" "$PDV/src/GenesisPDV.App/obj/project.assets.json"
rodar "$GI"
[[ $STATUS == 0 && $(jq -r .arvore_limpa "$SAIDA/$NOME.origem.json") == true ]] || falha 'bin/ e obj/ sujaram a árvore'
# Arquivo ignorado que o MSBuild importa sozinho (o .csproj.user) e Directory.Build.targets fora do git acima do PDV.
for sujo in "$PDV/src/GenesisPDV.App/GenesisPDV.App.csproj.user" "$RAIZ/apps/Directory.Build.targets"; do
  echo '<Project />' >"$sujo"
  rodar "$GI"
  rm -f "$sujo"
  [[ $STATUS == 0 ]] || falha "$(basename "$sujo"): saiu com $STATUS"
  [[ $(jq -r .arvore_limpa "$SAIDA/$NOME.origem.json") == false ]] || falha "$(basename "$sujo") não sujou a árvore"
  grep -qF "$(basename "$sujo")" "$T/saida" || falha "sem dizer qual arquivo sujou a árvore: $(basename "$sujo")"
done
confere 'árvore do PDV: alteração, .csproj.user ignorado e Directory.Build.targets acima sujam; bin/ e obj/ não'

echo 'gerar-instalador.sh: todos os testes passaram'
