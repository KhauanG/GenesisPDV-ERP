#!/usr/bin/env bash
# Spike do Velopack (F3-B8; README do PDV › decisão 100): o ROTEIRO-WINDOWS.txt rodado sozinho no Wine da sessão, com o
# resultado de cada passo conferido. Não substitui o roteiro no Windows de verdade (o critério do plano): o Wine não
# tem SmartScreen, Smart App Control, ACL de pasta nem o Windows 10/11 reais. Serve para achar defeito antes de mandar
# o pacote ao dono. Diferença de propósito no passo 4: a primeira tentativa da volta é forçada a falhar (a variável
# GENESIS_SPIKE_FALHAR_VOLTA, que só o pacote 1.0.2 lê), e a abertura seguinte da 1.0.2 tem de restaurar o banco outra
# vez e repetir a volta; no Windows do dono a volta sai na primeira tentativa.
#
#   apps/pdv/instalador/velopack-spike/ensaiar-no-wine.sh [--roteiro <pasta>] [--com-inno <GenesisPDV-Setup-X.Y.Z.exe>]
#
# --roteiro: a pasta roteiro/ do gerar-pacotes-teste.sh (padrão: apps/pdv/publish/velopack-spike/roteiro).
# --com-inno: instala antes o GenesisPDV pelo instalador atual (Inno) e confere, no fim, que a instalação, a
#   atualização e a volta do Velopack não mexeram em nada dele (Program Files, ProgramData\GenesisPDV, atalho, registro
#   de desinstalação) e que o mutex Global\GenesisPDV.Instancia do PDV aberto é visto pelo app do Velopack.
# Prefixo do Wine próprio e descartável (apagado no fim). Precisa de: wine (64 e 32 bits, como o linux-wine/), timeout.
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pasta_pdv=$(cd "$aqui/../.." && pwd)
roteiro="$pasta_pdv/publish/velopack-spike/roteiro"
inno=''

erro() {
  echo "ensaiar-no-wine: $*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --roteiro)
      [[ $# -ge 2 ]] || erro "--roteiro pede uma pasta"
      roteiro=$2
      shift 2
      ;;
    --com-inno)
      [[ $# -ge 2 ]] || erro "--com-inno pede o instalador"
      inno=$2
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *) erro "opção desconhecida: $1" ;;
  esac
done
[[ -d $roteiro ]] || erro "não achei o roteiro em $roteiro (rode o gerar-pacotes-teste.sh)"
[[ -z $inno || -f $inno ]] || erro "não achei o instalador $inno"
for programa in wine wineboot wineserver winecfg timeout; do
  command -v "$programa" >/dev/null || erro "falta o $programa"
done

mkdir -p "$pasta_pdv/publish/velopack-spike"
temporario=$(mktemp -d "$pasta_pdv/publish/velopack-spike/wine-ensaio.XXXXXX")
limpar() {
  WINEPREFIX="$temporario/prefixo" wineserver -k 2>/dev/null || true
  rm -rf "$temporario"
}
trap limpar EXIT
export WINEPREFIX="$temporario/prefixo" WINEARCH=win64 WINEDEBUG=-all WINEDLLOVERRIDES='mscoree,mshtml=' DISPLAY=
# O app reaberto pelo Update.exe herda a variável e não espera o Enter.
export GENESIS_SPIKE_SEM_PAUSA=1
# O Wine 9 do Ubuntu sem o /run/user/<uid> aborta (README do PDV › decisão 93).
mkdir -p "/run/user/$(id -u)" 2>/dev/null || true

echo "== prefixo do Wine"
timeout 300 wineboot -i >"$temporario/wine.log" 2>&1 || erro "o wineboot não preparou o prefixo"
timeout 120 wineserver -w
# Sem tela: o driver gráfico "null", como no linux-wine/ (sem ele o instalador do Inno sai com erro).
timeout 60 wine reg add 'HKCU\Software\Wine\Drivers' /v Graphics /d null /f >>"$temporario/wine.log" 2>&1 ||
  erro "não foi possível ligar o driver gráfico null"
timeout 120 winecfg /v win11 >>"$temporario/wine.log" 2>&1 || erro "não foi possível pôr o prefixo no Windows 11"
timeout 60 wineserver -w
c="$WINEPREFIX/drive_c"
usuario=$(basename "$(find "$c/users" -mindepth 1 -maxdepth 1 -type d ! -name Public | head -1)")
local_app="$c/users/$usuario/AppData/Local"
log="$c/ProgramData/GenesisPDV.Spike/logs/spike.log"
exe="C:\\users\\$usuario\\AppData\\Local\\GenesisPDV.Spike\\current\\GenesisPDV.Spike.exe"
mkdir -p "$c/SpikeVelopack"
cp -r "$roteiro" "$c/SpikeVelopack/roteiro"

esperar() { timeout 240 wineserver -w || true; }
linhas_log() { if [[ -f $log ]]; then wc -l <"$log"; else echo 0; fi; }
ultimo=0
passo=''
# rodar <descrição> <texto esperado no log novo> [args do app…]: roda e confere o que entrou no log desde o passo anterior
# (guardado em $passo, para o tambem conferir outros textos do mesmo passo).
rodar() {
  local descricao=$1 esperado=$2
  shift 2
  timeout 240 wine "$exe" "$@" --sem-pausa >/dev/null 2>&1 || true
  esperar
  sleep 2 # o Update.exe reabre o app depois de aplicar (às vezes duas vezes, na volta)
  esperar
  passo=$(tail -n +"$((ultimo + 1))" "$log" 2>/dev/null || true)
  ultimo=$(linhas_log)
  if [[ $passo == *"$esperado"* ]]; then
    echo "ok    $descricao"
  else
    echo "FALHA $descricao: esperado '$esperado'; o log disse:" >&2
    echo "$passo" >&2
    exit 1
  fi
}

# tambem <texto>: confere mais um texto no log do último passo do rodar.
tambem() {
  [[ $passo == *"$1"* ]] && return
  echo "FALHA no mesmo passo: esperado também '$1'; o log disse:" >&2
  echo "$passo" >&2
  exit 1
}

# rodar_ate <segundos> <descrição> <texto esperado> [args do app…]: como o rodar, mas repete a cada 5 s até o texto
# aparecer no log ou o limite vencer. Sem esperar o wineserver: com o PDV do Inno aberto (passo 6), ele nunca fica livre.
rodar_ate() {
  local limite=$1 descricao=$2 esperado=$3 inicio=$SECONDS
  shift 3
  while :; do
    timeout 60 wine "$exe" "$@" --sem-pausa >/dev/null 2>&1 || true
    passo=$(tail -n +"$((ultimo + 1))" "$log" 2>/dev/null || true)
    if [[ $passo == *"$esperado"* ]]; then
      ultimo=$(linhas_log)
      echo "ok    $descricao (em $((SECONDS - inicio)) s)"
      return
    fi
    if ((SECONDS - inicio >= limite)); then
      echo "FALHA $descricao: esperado '$esperado' em até $limite s; o log disse:" >&2
      echo "$passo" >&2
      exit 1
    fi
    sleep 5
  done
}

retrato_inno() {
  (cd "$c" && find "Program Files/GenesisPDV" ProgramData/GenesisPDV -printf '%p %s\n' 2>/dev/null | sort
    ls users/Public/Desktop 2>/dev/null || true
    wine reg query 'HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\{7125763E-1F1B-4A8F-9DE6-A27FFBE93EBB}_is1' \
      2>/dev/null | tr -d '\r' | grep -E 'DisplayVersion|InstallLocation' || true)
}

if [[ -n $inno ]]; then
  echo "== GenesisPDV pelo instalador atual (Inno)"
  cp "$inno" "$c/inno-setup.exe"
  (cd "$c" && timeout 300 wine 'C:\inno-setup.exe' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=iniciarcomwindows,areadetrabalho \
    >>"$temporario/wine.log" 2>&1) || {
    tail -20 "$temporario/wine.log" >&2
    erro "o instalador do Inno falhou no Wine"
  }
  esperar
  [[ -f "$c/Program Files/GenesisPDV/GenesisPDV.exe" ]] || erro "o Inno não instalou o GenesisPDV.exe"
  retrato_inno >"$temporario/inno-antes.txt"
fi

echo "== 1. instalar a 1.0.0 (Setup do Velopack, por usuário)"
(cd "$c/SpikeVelopack/roteiro" && timeout 240 wine ./1-instalar-GenesisPDV.Spike-1.0.0-Setup.exe --silent >>"$temporario/wine.log" 2>&1) ||
  erro "o Setup do Velopack falhou"
esperar
[[ -f "$local_app/GenesisPDV.Spike/packages/GenesisPDV.Spike-1.0.0-full.nupkg" ]] || erro "o Setup não deixou o pacote da 1.0.0"
for atalho in "users/$usuario/Desktop/GenesisPDV Spike.lnk" \
  "users/$usuario/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/GenesisPDV Spike.lnk" \
  "users/$usuario/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/StartUp/GenesisPDV Spike.lnk"; do
  [[ -f "$c/$atalho" ]] || erro "faltou o atalho $atalho"
done
echo "ok    instalada, com os atalhos da área de trabalho, do menu Iniciar e da inicialização do usuário"
rodar "1.2 abre a 1.0.0" "Pronto para vender (banco no esquema 1)"

echo "== 2. adulteradas"
rodar "2.1 assinatura de outra chave" "Assinatura recusada: assinada por outra chave" procurar --fonte 'C:\SpikeVelopack\roteiro\ruim-assinatura-de-outra-chave'
rodar "2.2 feed refeito" "o feed não é o que o manifesto assinou" procurar --fonte 'C:\SpikeVelopack\roteiro\ruim-feed-refeito'
rodar "2.3 pacote trocado" "RECUSADO no download" procurar --fonte 'C:\SpikeVelopack\roteiro\ruim-pacote-trocado'
rodar "2.4 canal trocado" "o manifesto é do canal 'beta', não do 'win'" procurar --fonte 'C:\SpikeVelopack\roteiro\ruim-canal-trocado'
rodar "2.5 continua na 1.0.0" "Versão instalada: 1.0.0" estado

echo "== 3. 1.0.0 → 1.0.1"
rodar "3.1 atualiza e reabre na 1.0.1" "ATUALIZADO: 1.0.0 → 1.0.1" procurar --fonte 'C:\SpikeVelopack\roteiro\feed-1.0.1'
# O gancho da reabertura (o Update.exe reabre com VELOPACK_RESTART) entra no spike.log, não só na tela. O da primeira
# execução não se confere aqui: o passo 1.2 abre o app direto, sem o VELOPACK_FIRSTRUN que o Setup passaria.
tambem "Reaberto pelo Velopack na 1.0.1"
grep -q 'Pacote remontado pelos deltas conferido arquivo por arquivo' "$log" || erro "a 1.0.1 não veio pelo delta conferido"
echo "ok    3.1 pelo delta, com o remontado conferido arquivo por arquivo"

echo "== 4. 1.0.1 → 1.0.2 (migração falha) → volta"
# A volta que não chega a ser aplicada: a 1.0.2 tem de ficar com a volta em andamento, sem dizer que voltou.
GENESIS_SPIKE_FALHAR_VOLTA=1 rodar "4.1 a 1.0.2 falha e a primeira volta não é aplicada" "A volta para a 1.0.1 não foi aplicada" \
  procurar --fonte 'C:\SpikeVelopack\roteiro\feed-1.0.2'
tambem "A migração do banco falhou na 1.0.2"
tambem "Banco restaurado do backup"
[[ $passo != *"VOLTA FEITA"* ]] || erro "4.1: disse VOLTA FEITA sem a volta aplicada"
rodar "4.1 em andamento, ainda na 1.0.2" "volta em andamento: 1.0.2 → 1.0.1, 1 tentativa(s)" estado
tambem "Versão instalada: 1.0.2"
rodar "4.1 a 1.0.2 reabre, restaura e volta para a 1.0.1" "VOLTA FEITA: a 1.0.2 falhou"
tambem "A volta para a 1.0.1 ainda não foi aplicada"
tambem "Voltando para a 1.0.1 pelo pacote guardado (tentativa 2 de 3"
tambem "Reaberto pelo Velopack na 1.0.1"
[[ $passo != *"A migração do banco falhou"* ]] || erro "4.1: a 1.0.2 migrou o banco de novo com a volta em andamento"
rodar "4.2 na 1.0.1, recusada e banco no esquema 2" "Versão instalada: 1.0.1" estado
tambem "recusadas: 1.0.2"
tambem "volta em andamento: nenhuma"
grep -q '^esquema=2$' "$c/ProgramData/GenesisPDV.Spike/dados/banco.txt" || erro "o banco não voltou ao esquema 2"
rodar "4.3 não tenta a 1.0.2 de novo" "fica recusada até sair uma mais nova" procurar --fonte 'C:\SpikeVelopack\roteiro\feed-1.0.2'
rodar "4.4 abre a 1.0.1" "Pronto para vender (banco no esquema 2)"

echo "== 5. versão velha assinada"
rodar "5.1 recusada" "manifesto antigo" procurar --fonte 'C:\SpikeVelopack\roteiro\ruim-versao-velha-assinada'
rodar "5.2 o manifesto anterior também" "manifesto antigo" procurar --fonte 'C:\SpikeVelopack\roteiro\feed-1.0.1'

if [[ -n $inno ]]; then
  echo "== 6. convivência com o GenesisPDV do Inno"
  retrato_inno >"$temporario/inno-depois.txt"
  diff "$temporario/inno-antes.txt" "$temporario/inno-depois.txt" >&2 || erro "o Velopack mexeu na instalação do Inno"
  echo "ok    6.2 Program Files, ProgramData\\GenesisPDV, atalho e registro do Inno sem mudança"
  wine 'C:\Program Files\GenesisPDV\GenesisPDV.exe' >/dev/null 2>&1 &
  pid_pdv=$!
  # O PDV leva um tempo variável para criar o mutex no Wine (o arquivo único se descompacta na primeira abertura, e
  # mais devagar com a máquina carregada): confere a cada 5 s, por até 120 s.
  rodar_ate 120 "6.1 o mutex do PDV aberto é visto" "mutex Global\\GenesisPDV.Instancia existe" mutex
  wineserver -k 2>/dev/null || true
  wait "$pid_pdv" 2>/dev/null || true
  rodar "6.1 e some com o PDV fechado" "mutex Global\\GenesisPDV.Instancia não existe" mutex
fi
echo "Ensaio no Wine verde."
