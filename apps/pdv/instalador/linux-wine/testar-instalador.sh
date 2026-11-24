#!/usr/bin/env bash
# Confere, no Linux, o instalador do GenesisPDV gerado pelo gerar-instalador.sh (OP-B3, D70-Q2; README do PDV ›
# decisão 93), no lugar do que o testar-instalador.ps1 confere no runner Windows até onde o Wine alcança:
#
#   apps/pdv/instalador/linux-wine/testar-instalador.sh [--versao X.Y.Z] [--instalador <exe>] [--publicacao <pasta>]
#       [--url-api https://...] [--referencia <exe> | --referencia-release <pdv-vX.Y.Z|ultima> | --sem-referencia]
#
# 1. sem executar: o .exe.sha256 no formato do sha256sum e conferido; é um PE do Windows com a versão pedida no
#    VERSIONINFO (FileVersion X.Y.Z.0, ProductVersion X.Y.Z, ProductName GenesisPDV); foi compilado pelo Inno Setup
#    fixado no gerar-instalador.sh; a assinatura (osslsigncode verify, obrigatório) é a mesma do publicado (hoje
#    nenhuma: com o publicado assinado, para); o .origem.json, se houver, é deste arquivo e desta versão, com a mesma
#    URL padrão da API do --url-api;
# 2. num prefixo do Wine próprio e descartável (o innoextract do Ubuntu só lê até o Inno Setup 6.0.5, e o master dele
#    até o 6.4.0: nem o 6.4.3 fixado nem o 6.7.0 do runner, que montou o pdv-v0.13.0): instala o instalador de
#    referência (o release publicado mais novo, sem rascunho nem pre-release, como a implantação escolhe; ou o
#    --referencia-release, ou --referencia) em silêncio e anota o que ficou (arquivos do programa,
#    pastas de dados, atalhos, "Iniciar com o Windows" e o registro de desinstalação); instala este por cima (o
#    caminho de atualização das lojas; se a referência for mais nova, confere que este desiste), desinstala;
# 3. instala este do zero e confere: a mesma lista da referência (só a versão muda); o GenesisPDV.exe instalado é,
#    byte a byte, o da publicação win-x64 (que tem só ele), com o .NET embutido igual ou mais novo que o da referência
#    e a ProductVersion X.Y.Z+<commit> da origem; o --info-build do instalado (versão, URL, sem demonstração);
#    reinstala por cima sem perder os dados; um instalador "mais antigo" que o instalado (DisplayVersion 99.0.0)
#    desiste sem mexer; desinstala e os dados de %ProgramData%\GenesisPDV ficam;
# 4. grava <exe>.conferido (o sha256 conferido, a URL da API, a referência e o sha256 dela, o .NET embutido deste e o
#    da referência, as duas assinaturas), que o publicar-release.sh exige e confere com o último release publicado.
#
# Não coberto (só o Windows de verdade, testar-instalador.ps1, ou o primeiro caixa: README do PDV › Instalar na loja):
# a permissão MODIFICAR do grupo Usuários nas pastas de dados, o PDV aberto até "Banco local pronto", o AppMutex com o
# PDV aberto, a DPAPI e o SmartScreen. Precisa de wine com 32 bits, osslsigncode, python3, jq, curl e ~1,5 GB livres
# (no Ubuntu, `apt-get install osslsigncode`).
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pasta_pdv=$(cd "$aqui/../.." && pwd)
REPO=${GENESIS_REPO:-KhauanG/GenesisPDV-ERP}
APP_ID='{7125763E-1F1B-4A8F-9DE6-A27FFBE93EBB}_is1'
CHAVE_RUN='Software\Microsoft\Windows\CurrentVersion\Run'
CHAVE_DESINSTALAR="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$APP_ID"
VERSAO_INNO=$(sed -n 's/^VERSAO_INNO=//p' "$aqui/gerar-instalador.sh")

versao=''
instalador=''
publicacao="$pasta_pdv/publish/win-x64"
url_api=https://api.grupoicebeer.com.br
referencia=''
referencia_release=ultima

erro() {
  echo "testar-instalador: FALHOU: $*" >&2
  exit 1
}
ok() { echo "ok: $*"; }
aviso() { echo "aviso: $*"; }
uso() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --versao | --instalador | --publicacao | --url-api | --referencia | --referencia-release)
      (($# >= 2)) || erro "$1 precisa de um valor"
      case "$1" in
        --versao) versao=$2 ;;
        --instalador) instalador=$2 ;;
        --publicacao) publicacao=$2 ;;
        --url-api) url_api=$2 ;;
        --referencia)
          referencia=$2
          referencia_release=''
          ;;
        --referencia-release) referencia_release=$2 ;;
      esac
      shift 2
      ;;
    --sem-referencia)
      referencia=''
      referencia_release=''
      shift
      ;;
    -h | --ajuda)
      uso
      exit 0
      ;;
    *) erro "opção desconhecida: $1 (ajuda: $0 --ajuda)" ;;
  esac
done

[ -n "$versao" ] || versao=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$pasta_pdv/Directory.Build.props" | head -n 1)
[[ $versao =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || erro "versão inválida '$versao' (use X.Y.Z)"
[ -n "$instalador" ] || instalador="$pasta_pdv/publish/instalador/GenesisPDV-Setup-$versao.exe"
for comando in wine wineboot wineserver winepath winecfg osslsigncode python3 jq curl sha256sum timeout; do
  command -v "$comando" >/dev/null 2>&1 || erro "falta o comando '$comando'"
done
[ -f "$instalador" ] || erro "instalador não encontrado: $instalador (gere com gerar-instalador.sh)"
instalador=$(cd "$(dirname "$instalador")" && pwd)/$(basename "$instalador")
nome=$(basename "$instalador")
[ "$nome" = "GenesisPDV-Setup-$versao.exe" ] || erro "o arquivo se chama $nome; para a versão $versao seria GenesisPDV-Setup-$versao.exe"
[ -f "$publicacao/GenesisPDV.exe" ] || erro "publicação win-x64 não encontrada em $publicacao (a do mesmo gerar-instalador.sh)"
pasta_execucao="/run/user/$(id -u)"
if [ ! -d "$pasta_execucao" ]; then
  [ "$(id -u)" = 0 ] || erro "falta $pasta_execucao (o Wine 9 precisa dele)"
  mkdir -p /run/user && mkdir -m 700 "$pasta_execucao"
fi

rm -f "$instalador.conferido"
temporario=$(mktemp -d "${TMPDIR:-/tmp}/genesispdv-teste-instalador.XXXXXX")
export WINEPREFIX="$temporario/prefixo" WINEARCH=win64 WINEDEBUG=-all WINEDLLOVERRIDES='mscoree,mshtml='
unset DISPLAY WAYLAND_DISPLAY
limpar() {
  local status=$?
  if [ -d "$WINEPREFIX" ]; then timeout 60 wineserver -k >/dev/null 2>&1 || true; fi
  rm -rf "$temporario"
  exit "$status"
}
trap limpar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
C="$WINEPREFIX/drive_c"
PASTA_APP="$C/Program Files/GenesisPDV"
PASTA_DADOS="$C/ProgramData/GenesisPDV"

pe() { python3 -I "$aqui/ler-versao-pe.py" "$1"; }

# Arquivo + .sha256 (uma linha "<hash>  <nome>", o formato que o release e o implantar.sh pdv publicar usam).
conferir_sha256() {
  local exe=$1 linhas
  [ -f "$exe.sha256" ] || erro "falta $(basename "$exe").sha256"
  linhas=$(awk 'END { print NR }' "$exe.sha256")
  { [ "$linhas" = 1 ] && grep -qxE "[0-9a-f]{64}  $(basename "$exe" | sed 's/\./\\./g')" "$exe.sha256"; } ||
    erro "$(basename "$exe").sha256 fora do formato do sha256sum (uma linha, '<hash>  $(basename "$exe")')"
  (cd "$(dirname "$exe")" && sha256sum -c --quiet "$(basename "$exe").sha256") ||
    erro "o sha256 de $(basename "$exe") não confere com o .sha256"
}

# Assinatura Authenticode: "nenhuma" ou "assinado" (o osslsigncode é obrigatório: sem ele, a conferência da
# assinatura sumiria em silêncio).
assinatura() {
  local saida
  saida=$(osslsigncode verify -in "$1" 2>&1 || true)
  if grep -q 'No signature found' <<<"$saida"; then echo nenhuma; else echo assinado; fi
}

# Valor de uma chave do HKLM no registro do prefixo (system.reg, gravado pelo wineserver ao sair), sem aspas.
valor_registro() {
  timeout 120 wineserver -w || true
  SECAO="[${1//\\/\\\\}]" NOME="\"$2\"=" awk '
    /^\[/ { s = ENVIRON["SECAO"]; dentro = (index($0, s) == 1 && (length($0) == length(s) || substr($0, length(s) + 1, 1) == " ")); next }
    dentro && index($0, ENVIRON["NOME"]) == 1 {
      v = substr($0, length(ENVIRON["NOME"]) + 1)
      if (v !~ /^"/) { print v; exit }
      v = substr(v, 2, length(v) - 2)
      saida = ""
      for (i = 1; i <= length(v); i++) {
        c = substr(v, i, 1)
        if (c == "\\") { i++; c = substr(v, i, 1) }
        saida = saida c
      }
      print saida
      exit
    }
  ' "$WINEPREFIX/system.reg"
}

# Roda um instalador ou desinstalador do Windows em silêncio, com prazo, e espera o Wine terminar (o desinstalador
# do Inno se copia para a pasta temporária e continua de lá). Devolve o código de saída.
executar() {
  local exe=$1 log=$2 status=0
  timeout 300 wine "$(winepath -w "$exe")" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/LOG=C:\\$log" \
    >>"$temporario/wine.log" 2>&1 || status=$?
  timeout 300 wineserver -w || true
  return "$status"
}
mostrar_log() {
  if [ -f "$C/$1" ]; then tail -n 40 "$C/$1" >&2; fi
}
instalar() {
  executar "$1" "$2" || {
    mostrar_log "$2"
    erro "a instalação de $(basename "$1") saiu com erro"
  }
}
desinstalar() {
  [ -f "$PASTA_APP/unins000.exe" ] || erro "sem o desinstalador em Program Files\\GenesisPDV"
  executar "$PASTA_APP/unins000.exe" "$1" || {
    mostrar_log "$1"
    erro 'a desinstalação saiu com erro'
  }
  [ ! -e "$PASTA_APP" ] || erro "a desinstalação deixou Program Files\\GenesisPDV: $(ls "$PASTA_APP")"
  [ -z "$(valor_registro "$CHAVE_RUN" GenesisPDV)" ] || erro 'a desinstalação deixou o "Iniciar com o Windows"'
  [ -z "$(valor_registro "$CHAVE_DESINSTALAR" DisplayVersion)" ] || erro 'a desinstalação deixou o registro de desinstalação'
  [ ! -e "$C/ProgramData/Microsoft/Windows/Start Menu/Programs/GenesisPDV.lnk" ] || erro 'a desinstalação deixou o atalho do menu'
  for pasta in dados backup logs impressao; do
    [ -d "$PASTA_DADOS/$pasta" ] || erro "a desinstalação apagou %ProgramData%\\GenesisPDV\\$pasta (os dados ficam)"
  done
}

# O que a instalação deixou, com a versão trocada por <versão> (o que muda entre dois instaladores do mesmo .iss).
manifesto() {
  local v=$1 atalho chave
  (cd "$PASTA_APP" && find . -type f | LC_ALL=C sort | sed 's|^\./|programa: |')
  (cd "$PASTA_DADOS" && find . -mindepth 1 -type d | LC_ALL=C sort | sed 's|^\./|dados: |')
  for atalho in 'ProgramData/Microsoft/Windows/Start Menu/Programs/GenesisPDV.lnk' 'users/Public/Desktop/GenesisPDV.lnk'; do
    [ -f "$C/$atalho" ] && echo "atalho: $atalho"
  done
  echo "iniciar com o Windows: $(valor_registro "$CHAVE_RUN" GenesisPDV)"
  for chave in DisplayName DisplayVersion Publisher InstallLocation DisplayIcon UninstallString QuietUninstallString \
    NoModify NoRepair 'Inno Setup: App Path' 'Inno Setup: Language' 'Inno Setup: Deselected Tasks'; do
    echo "desinstalação $chave: $(valor_registro "$CHAVE_DESINSTALAR" "$chave")"
  done | awk -v v="$v" '{ while ((i = index($0, v)) > 0) $0 = substr($0, 1, i - 1) "<versão>" substr($0, i + length(v)); print }'
}

# Versão do .NET embutido num GenesisPDV.exe (o VERSIONINFO do mscordaccore: 10.0.<correção><ano>.<n>).
versao_dotnet() { pe "$1" | jq -r '[.versionamentos[] | select(.textos.InternalName == "mscordaccore.dll")][0].versao_arquivo // ""'; }

# --- 1. Sem executar ---------------------------------------------------------------------------------------------------
conferir_sha256 "$instalador"
hash=$(cut -d' ' -f1 "$instalador.sha256")
ok "$nome e o .sha256 no formato do sha256sum (sha256 $hash)"
info_pe=$(pe "$instalador") || erro "$nome não é um executável do Windows (PE) com VERSIONINFO"
# shellcheck disable=SC2016 # $v é variável do jq.
jq -e --arg v "$versao" '.pe and .versao_arquivo == ($v + ".0") and .textos.FileVersion == $v and
  .textos.ProductVersion == $v and .textos.ProductName == "GenesisPDV" and .textos.CompanyName == "Genesis"' \
  <<<"$info_pe" >/dev/null || erro "VERSIONINFO não é o da versão $versao: $(jq -c '{versao_arquivo, textos}' <<<"$info_pe")"
ok "PE do Windows ($(jq -r .maquina <<<"$info_pe")), VERSIONINFO $versao (ProductName GenesisPDV)"
grep -aqF "Inno Setup Setup Data ($VERSAO_INNO)" "$instalador" || erro "não foi compilado pelo Inno Setup $VERSAO_INNO"
ok "compilado pelo Inno Setup $VERSAO_INNO (o fixado no gerar-instalador.sh)"
assinatura_nova=$(assinatura "$instalador")
origem="$instalador.origem.json"
commit_origem=''
dotnet_origem=''
if [ -f "$origem" ]; then
  # shellcheck disable=SC2016 # $v e $h são variáveis do jq.
  jq -e --arg v "$versao" --arg h "$hash" '.versao == $v and .sha256 == $h' "$origem" >/dev/null ||
    erro "o $(basename "$origem") não é deste arquivo/versão: $(jq -c . "$origem")"
  commit_origem=$(jq -r '.commit // ""' "$origem")
  dotnet_origem=$(jq -r '.dotnet // ""' "$origem")
  url_origem=$(jq -r '.url_api_padrao // ""' "$origem")
  [ "$url_origem" = "$url_api" ] ||
    erro "o instalador foi gerado com a API padrão '$url_origem', e a conferência pede $url_api (--url-api)"
  ok "origem: commit ${commit_origem:-?}, árvore limpa $(jq -r .arvore_limpa "$origem"), .NET ${dotnet_origem:-?}"
else
  aviso "sem $(basename "$origem") (não veio do gerar-instalador.sh): sem conferir commit e .NET da origem"
fi
extras=$(find "$publicacao" -mindepth 1 -maxdepth 1 ! -name GenesisPDV.exe -printf '%f ')
[ -z "$extras" ] || erro "a publicação deveria ter só o GenesisPDV.exe; tem também: $extras"
hash_publicado=$(sha256sum "$publicacao/GenesisPDV.exe" | cut -d' ' -f1)

# --- Referência (o release publicado) ----------------------------------------------------------------------------------
versao_ref=''
dotnet_ref=''
assinatura_ref=''
if [ -z "$referencia" ] && [ -n "$referencia_release" ]; then
  tag=$referencia_release
  if [ "$tag" = ultima ]; then
    # O release publicado mais novo, como o implantar-sem-actions.sh escolhe (sem rascunho nem pre-release): uma tag
    # criada pelo publicar-release.sh que parou antes de publicar o release não conta.
    lista=$(curl -fsS --proto '=https' --retry 3 --max-time 60 -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' "https://api.github.com/repos/$REPO/releases?per_page=100") ||
      erro "não consegui listar os releases de $REPO (use --referencia-release pdv-vX.Y.Z)"
    tag=$(jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' <<<"$lista" |
      grep -E '^pdv-v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
    [ -n "$tag" ] || erro "nenhum release pdv-v* publicado em $REPO (use --sem-referencia)"
  fi
  [[ $tag =~ ^pdv-v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || erro "release de referência inválido '$tag' (pdv-vX.Y.Z)"
  versao_ref=${BASH_REMATCH[1]}
  pasta_ref="$pasta_pdv/publish/linux-wine/referencia/$tag"
  referencia="$pasta_ref/GenesisPDV-Setup-$versao_ref.exe"
  if [ ! -f "$referencia" ] || ! (cd "$pasta_ref" && sha256sum -c --quiet "GenesisPDV-Setup-$versao_ref.exe.sha256" 2>/dev/null); then
    mkdir -p "$pasta_ref"
    for arquivo in "GenesisPDV-Setup-$versao_ref.exe" "GenesisPDV-Setup-$versao_ref.exe.sha256"; do
      curl -fsSL --proto '=https' --retry 3 -o "$pasta_ref/$arquivo" \
        "https://github.com/$REPO/releases/download/$tag/$arquivo" ||
        erro "não consegui baixar $arquivo do release $tag (tag sem release publicado? use --referencia-release pdv-vX.Y.Z)"
    done
  fi
fi
if [ -n "$referencia" ]; then
  [ -f "$referencia" ] || erro "referência não encontrada: $referencia"
  if [ -z "$versao_ref" ]; then
    [[ $(basename "$referencia") =~ ^GenesisPDV-Setup-([0-9]+\.[0-9]+\.[0-9]+)\.exe$ ]] ||
      erro "a referência deveria se chamar GenesisPDV-Setup-X.Y.Z.exe"
    versao_ref=${BASH_REMATCH[1]}
  fi
  conferir_sha256 "$referencia"
  # shellcheck disable=SC2016 # $v é variável do jq.
  pe "$referencia" | jq -e --arg v "$versao_ref" '.textos.ProductVersion == $v' >/dev/null ||
    erro "a referência não é um instalador do GenesisPDV $versao_ref"
  inno_ref=$(grep -aoE 'Inno Setup Setup Data \([0-9.]+\)' "$referencia" | head -n 1 | grep -oE '[0-9.]+' || echo '?')
  assinatura_ref=$(assinatura "$referencia")
  ok "referência: GenesisPDV $versao_ref publicado ($(basename "$referencia"), sha256 conferido, Inno Setup $inno_ref, assinatura: $assinatura_ref)"
  if [ "$assinatura_ref" != nenhuma ] && [ "$assinatura_nova" != assinado ]; then
    erro "o instalador publicado é assinado e este não: este caminho não assina (não coberto; use o Windows)"
  fi
  referencia_sha256=$(cut -d' ' -f1 "$referencia.sha256")
else
  aviso 'sem instalador de referência: a lista do que a instalação deixa não é comparada com a de um publicado'
fi
ok "assinatura deste: $assinatura_nova$([ "$assinatura_nova" = nenhuma ] && echo ' (como o release atual: o Windows mostra o aviso do SmartScreen)')"

# --- 2. Prefixo do Wine descartável ------------------------------------------------------------------------------------
timeout 300 wineboot -i >>"$temporario/wine.log" 2>&1 || erro 'o wineboot não preparou o prefixo do Wine'
timeout 120 wine reg add 'HKCU\Software\Wine\Drivers' /v Graphics /d null /f >>"$temporario/wine.log" 2>&1 ||
  erro 'não foi possível desligar a tela no prefixo do Wine'
# O .iss pede o Windows 10 22H2 (10.0.19045) ou mais novo; o "win10" do Wine 9 diz 10.0.19043.
timeout 120 winecfg /v win11 >>"$temporario/wine.log" 2>&1 || erro 'não foi possível pôr o prefixo do Wine no Windows 11'
timeout 120 wineserver -w || true

if [ -n "$referencia" ]; then
  instalar "$referencia" referencia.log
  [ -f "$PASTA_APP/GenesisPDV.exe" ] || erro "a referência não instalou o GenesisPDV.exe"
  manifesto "$versao_ref" >"$temporario/manifesto-referencia.txt"
  dotnet_ref=$(versao_dotnet "$PASTA_APP/GenesisPDV.exe")
  ok "referência $versao_ref instalada (.NET embutido: arquivo ${dotnet_ref:-?})"
  if [ "$(printf '%s\n%s\n' "$versao_ref" "$versao" | sort -V | tail -n 1)" = "$versao" ]; then
    instalar "$instalador" atualizacao.log
    [ "$(sha256sum "$PASTA_APP/GenesisPDV.exe" | cut -d' ' -f1)" = "$hash_publicado" ] ||
      erro "a atualização por cima da $versao_ref não trocou o GenesisPDV.exe pelo da publicação"
    [ "$(valor_registro "$CHAVE_DESINSTALAR" DisplayVersion)" = "$versao" ] || erro 'a atualização não gravou a versão nova'
    ok "atualização por cima da $versao_ref publicada (o caminho das lojas): exe novo e versão $versao"
  else
    executar "$instalador" atualizacao.log && erro "o $versao por cima da $versao_ref, mais nova, deveria desistir"
    [ "$(valor_registro "$CHAVE_DESINSTALAR" DisplayVersion)" = "$versao_ref" ] || erro 'o instalador mais antigo mexeu na instalação'
    ok "o $versao por cima da $versao_ref (mais nova) desiste em silêncio, sem mexer"
  fi
  desinstalar desinstalacao-referencia.log
  ok 'desinstalada (o programa saiu; as pastas de dados ficaram)'
fi

# --- 3. Este instalador do zero ----------------------------------------------------------------------------------------
instalar "$instalador" instalacao.log
manifesto "$versao" >"$temporario/manifesto.txt"
if [ -n "$referencia" ]; then
  diff -u "$temporario/manifesto-referencia.txt" "$temporario/manifesto.txt" >&2 ||
    erro "a instalação não deixa o mesmo que a do $versao_ref publicado (diferenças acima; a versão já foi trocada por <versão>)"
  ok "a instalação deixa o mesmo que a do $versao_ref publicado ($(wc -l <"$temporario/manifesto.txt") itens: programa, dados, atalhos e registro)"
fi
sed 's/^/    /' "$temporario/manifesto.txt"
programa=$(cd "$PASTA_APP" && find . -type f ! -name 'unins000.*' -printf '%P\n' | LC_ALL=C sort | tr '\n' ' ')
[ "$programa" = 'GenesisPDV.exe ' ] || erro "o programa instalado deveria ser só o GenesisPDV.exe (e o desinstalador); veio: $programa"
[ "$(sha256sum "$PASTA_APP/GenesisPDV.exe" | cut -d' ' -f1)" = "$hash_publicado" ] ||
  erro 'o GenesisPDV.exe instalado não é o da publicação win-x64'
ok "a lista de arquivos bate com a da publicação win-x64: GenesisPDV.exe, byte a byte (sha256 $hash_publicado), mais o desinstalador"
[ "$(valor_registro "$CHAVE_DESINSTALAR" DisplayVersion)" = "$versao" ] || erro "o registro de desinstalação não diz $versao"
[ "$(valor_registro "$CHAVE_RUN" GenesisPDV)" = '"C:\Program Files\GenesisPDV\GenesisPDV.exe"' ] ||
  erro 'sem o "Iniciar com o Windows" apontando para o exe instalado'
for atalho in 'ProgramData/Microsoft/Windows/Start Menu/Programs/GenesisPDV.lnk' 'users/Public/Desktop/GenesisPDV.lnk'; do
  [ -f "$C/$atalho" ] || erro "sem o atalho $atalho"
done
ok 'registro de desinstalação com a versão, "Iniciar com o Windows" e os atalhos do menu e da área de trabalho'

info_app=$(pe "$PASTA_APP/GenesisPDV.exe")
# shellcheck disable=SC2016 # $v é variável do jq.
versao_produto=$(jq -r '[.versionamentos[] | select(.textos.InternalName == "GenesisPDV.dll")][0].textos.ProductVersion // ""' <<<"$info_app")
[[ $versao_produto == "$versao" || $versao_produto == "$versao+"* ]] || erro "o GenesisPDV.exe diz ProductVersion '$versao_produto'"
if [ -n "$commit_origem" ]; then
  [ "$versao_produto" = "$versao+$commit_origem" ] || erro "o GenesisPDV.exe é de '$versao_produto', e a origem diz o commit $commit_origem"
fi
dotnet_novo=$(versao_dotnet "$PASTA_APP/GenesisPDV.exe")
[[ $dotnet_novo =~ ^10\.0\.([0-9]+)\.[0-9]+$ ]] || erro "versão do .NET embutido ilegível: '$dotnet_novo'"
if [ -n "$dotnet_origem" ]; then
  [ "$((BASH_REMATCH[1] / 100))" = "${dotnet_origem##*.}" ] || erro "o .NET embutido ($dotnet_novo) não é o $dotnet_origem da origem"
fi
if [ -n "$dotnet_ref" ]; then
  [ "$(printf '%s\n%s\n' "$dotnet_ref" "$dotnet_novo" | sort -V | tail -n 1)" = "$dotnet_novo" ] ||
    erro "o .NET embutido ($dotnet_novo) é mais velho que o do $versao_ref publicado ($dotnet_ref): falta correção de segurança"
fi
ok "GenesisPDV.exe $versao_produto, .NET embutido $dotnet_novo${dotnet_ref:+ (o publicado: $dotnet_ref)}"

timeout 300 wine 'C:\Program Files\GenesisPDV\GenesisPDV.exe' --info-build 'C:\info-build.json' >>"$temporario/wine.log" 2>&1 || true
[ -s "$C/info-build.json" ] || erro 'o GenesisPDV.exe instalado não respondeu ao --info-build'
# shellcheck disable=SC2016 # $v e $u são variáveis do jq.
jq -e --arg v "$versao" --arg u "$url_api" '.versao == $v and .url_api_padrao == $u and .modo_demonstracao == false' \
  "$C/info-build.json" >/dev/null || erro "o exe instalado não confere: $(jq -c . "$C/info-build.json")"
ok "--info-build do instalado: $(jq -c . "$C/info-build.json")"

# Reinstalar por cima (atualizar = instalar por cima): o banco do caixa continua.
printf 'banco de teste\n' >"$PASTA_DADOS/dados/pdv.db"
hash_banco=$(sha256sum "$PASTA_DADOS/dados/pdv.db" | cut -d' ' -f1)
instalar "$instalador" reinstalacao.log
[ "$(sha256sum "$PASTA_DADOS/dados/pdv.db" | cut -d' ' -f1)" = "$hash_banco" ] || erro 'a reinstalação mexeu no pdv.db'
[ "$(sha256sum "$PASTA_APP/GenesisPDV.exe" | cut -d' ' -f1)" = "$hash_publicado" ] || erro 'a reinstalação trocou o exe'
ok 'reinstalação por cima: o pdv.db ficou como estava'

# Instalador "mais antigo" que o instalado (como o testar-instalador.ps1: DisplayVersion 99.0.0): desiste em silêncio.
timeout 120 wine reg add "HKLM\\$CHAVE_DESINSTALAR" /v DisplayVersion /d 99.0.0 /f /reg:64 >>"$temporario/wine.log" 2>&1 ||
  erro 'não foi possível simular uma versão instalada mais nova'
antes=$(stat -c '%Y %s' "$PASTA_APP/GenesisPDV.exe")
executar "$instalador" mais-antigo.log && erro 'o instalador por cima de uma versão "mais nova" (99.0.0) deveria desistir'
[ "$(stat -c '%Y %s' "$PASTA_APP/GenesisPDV.exe")" = "$antes" ] || erro 'o instalador "mais antigo" mexeu no exe'
[ "$(valor_registro "$CHAVE_DESINSTALAR" DisplayVersion)" = 99.0.0 ] || erro 'o instalador "mais antigo" mexeu no registro'
grep -q 'versão mais antiga por cima de uma mais nova' "$C/mais-antigo.log" || erro 'o log não registra a desistência'
timeout 120 wine reg add "HKLM\\$CHAVE_DESINSTALAR" /v DisplayVersion /d "$versao" /f /reg:64 >>"$temporario/wine.log" 2>&1 || true
ok 'um instalador "mais antigo" que o instalado (99.0.0) desiste em silêncio, sem mexer'

desinstalar desinstalacao.log
[ "$(sha256sum "$PASTA_DADOS/dados/pdv.db" | cut -d' ' -f1)" = "$hash_banco" ] || erro 'a desinstalação apagou o pdv.db'
ok 'desinstalação: o programa, os atalhos e o registro saíram; %ProgramData%\GenesisPDV e o pdv.db ficaram'

jq -n --arg versao "$versao" --arg sha "$hash" --arg url "$url_api" --arg ref "$versao_ref" \
  --arg ref_sha "${referencia_sha256:-}" --arg dotnet "$dotnet_novo" --arg dotnet_ref "$dotnet_ref" \
  --arg assinatura "$assinatura_nova" --arg assinatura_ref "$assinatura_ref" --arg em "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{versao: $versao, sha256: $sha, url_api: $url, referencia: $ref, referencia_sha256: $ref_sha, dotnet: $dotnet,
    dotnet_referencia: $dotnet_ref, assinatura: $assinatura, assinatura_referencia: $assinatura_ref,
    conferido_em: $em}' >"$instalador.conferido"
echo "testar-instalador: $nome conferido (não coberto: a permissão das pastas, o PDV aberto e o AppMutex, no Windows)"
