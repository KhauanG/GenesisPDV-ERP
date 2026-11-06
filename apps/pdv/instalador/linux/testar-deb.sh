#!/usr/bin/env bash
# Teste de fumaça do pacote .deb do GenesisPDV (implantação I3; README do PDV › decisão 62). Sem uso na CI e no release
# desde a decisão 80 do README do PDV (só Windows), sem garantia de que continue funcionando; fica como referência
# para conferir à mão, numa máquina sem o pacote, com sudo e o xvfb instalado:
#
#   apps/pdv/instalador/linux/testar-deb.sh <genesispdv_X.Y.Z_amd64.deb> <versão X.Y.Z> <URL padrão da API>
#
# Confere o conteúdo e o sha256, instala pelo apt (as dependências resolvem), as pastas root:genesispdv 2770, o
# --info-build do executável instalado, abre o PDV com um usuário do grupo genesispdv até "Banco local pronto" em
# /var/log/genesispdv (o banco nas pastas do sistema), confere que o banco e o log saem com escrita do grupo (umask 007 e
# g+rw do PermissoesGrupo) e abre de novo com uma segunda conta do grupo, que escreve no mesmo log e abre o mesmo banco,
# e remove e expurga o pacote conferindo que os dados ficam.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "uso: $0 <pacote.deb> <versão> <URL padrão da API>" >&2
  exit 2
fi

pacote=$(realpath "$1")
versao=$2
url=$3
temp=$(mktemp -d)
pdv=
segunda_conta=genesispdv-ci2
criou_segunda=

falhar() {
  echo "::error::$1"
  sudo sh -c 'tail -n 60 /var/log/genesispdv/*.log' 2>/dev/null || true
  exit 1
}

conferir() {
  local descricao=$1
  shift
  if "$@"; then
    echo "ok: $descricao"
  else
    falhar "$descricao"
  fi
}

# O PDV roda numa sessão própria (setsid): o kill do grupo leva junto o xvfb-run, o Xvfb e o app (com sudo: o da segunda
# conta é de outro usuário).
fechar_pdv() {
  if [ -n "$pdv" ]; then
    sudo kill -- "-$pdv" 2>/dev/null || true
    wait "$pdv" 2>/dev/null || true
    pdv=
  fi
}

encerrar() {
  fechar_pdv
  if [ -n "$criou_segunda" ]; then
    sudo userdel -r "$segunda_conta" 2>/dev/null || true
  fi
  rm -rf "$temp"
}
trap encerrar EXIT

tem_banco_pronto() {
  sudo sh -c 'grep -qs "Banco local pronto" /var/log/genesispdv/*.log'
}

# Quantas aberturas chegaram a "Banco local pronto" (todas as contas escrevem no mesmo log do dia).
aberturas() {
  sudo sh -c 'cat /var/log/genesispdv/*.log 2>/dev/null' | grep -c "Banco local pronto" || true
}

# Espera com prazo (60 s) pela abertura número $1, nunca um tempo fixo.
esperar_abertura() {
  for _ in $(seq 1 120); do
    [ "$(aberturas)" -ge "$1" ] && return 0
    kill -0 "$pdv" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}

# Modo octal do arquivo (sudo: a pasta é 2770 e o runner pode ainda não estar no grupo nesta sessão).
modo() {
  sudo stat -c '%a' "$1"
}

conferir "sha256 do pacote" sh -c "cd '$(dirname "$pacote")' && sha256sum -c '$(basename "$pacote").sha256'"
conferir "versão $versao no control" sh -c "dpkg-deb --field '$pacote' Version | grep -qx '$versao'"
dpkg-deb --contents "$pacote" >"$temp/conteudo"
for item in ./opt/genesispdv/GenesisPDV ./usr/bin/genesispdv ./usr/share/applications/genesispdv.desktop \
  ./usr/share/icons/hicolor/256x256/apps/genesispdv.png; do
  conferir "pacote contém $item" grep -q " $item" "$temp/conteudo"
done

sudo apt-get install -y -qq "$pacote" >/dev/null
conferir "pacote instalado" sh -c "dpkg-query -W -f='\${Status}' genesispdv | grep -q 'install ok installed'"
conferir "grupo genesispdv criado" sh -c 'getent group genesispdv >/dev/null'
for pasta in /var/lib/genesispdv /var/lib/genesispdv/backup /var/lib/genesispdv/impressao /var/log/genesispdv; do
  # sudo: a pasta-mãe é 2770 e o runner não está no grupo, então nem o stat das subpastas passaria sem ele.
  conferir "$pasta com root:genesispdv 2770" sh -c "[ \"\$(sudo stat -c '%U:%G %a' '$pasta')\" = 'root:genesispdv 2770' ]"
done

/opt/genesispdv/GenesisPDV --info-build "$temp/info.json"
# shellcheck disable=SC2016 # $v e $u são variáveis do jq, não do shell.
conferir "executável instalado com a versão, a URL e sem demonstração" \
  jq -e --arg v "$versao" --arg u "$url" '.versao == $v and .url_api_padrao == $u and .modo_demonstracao == false' "$temp/info.json"

# Quem roda o teste entra no grupo; o sg abre o PDV já com ele (sem sair da sessão), que então usa as pastas do sistema.
usuario=$(id -un)
sudo usermod -aG genesispdv "$usuario"
setsid sg genesispdv -c "exec xvfb-run -a /usr/bin/genesispdv" >"$temp/pdv.out" 2>&1 &
pdv=$!
esperar_abertura 1 || true
conferir "PDV instalado abriu com o banco em /var/lib/genesispdv" tem_banco_pronto
conferir "pdv.db em /var/lib/genesispdv" sudo test -f /var/lib/genesispdv/pdv.db
fechar_pdv
log_do_dia=$(sudo sh -c 'ls -1 /var/log/genesispdv/*.log' | head -n 1)
conferir "pdv.db com escrita do grupo e nada para os outros (660)" test "$(modo /var/lib/genesispdv/pdv.db)" = 660
conferir "log do dia com escrita do grupo e nada para os outros (660)" test "$(modo "$log_do_dia")" = 660

# Segunda conta do grupo no mesmo caixa: abre o banco da primeira e escreve no log do dia dela. A ativação continua por
# conta (a chave em ~/.config é de cada uma; o README manda usar sempre a mesma), mas nada fica somente leitura.
if ! id "$segunda_conta" >/dev/null 2>&1; then
  sudo useradd --create-home --groups genesispdv "$segunda_conta"
  criou_segunda=1
fi
setsid sudo -u "$segunda_conta" -H xvfb-run -a /usr/bin/genesispdv >"$temp/pdv2.out" 2>&1 &
pdv=$!
esperar_abertura 2 || true
conferir "segunda conta do grupo abriu o mesmo banco e escreveu no mesmo log" test "$(aberturas)" -ge 2
fechar_pdv
if sudo sh -c 'grep -qsi "readonly database" /var/log/genesispdv/*.log'; then
  falhar "o log tem erro de permissão depois da segunda conta"
fi
echo "ok: sem erro de permissão no log depois da segunda conta"

sudo dpkg --remove genesispdv >/dev/null
conferir "remove tirou o executável" test ! -e /opt/genesispdv/GenesisPDV
conferir "remove manteve o banco" sudo test -f /var/lib/genesispdv/pdv.db
sudo dpkg --purge genesispdv >/dev/null
conferir "purge manteve o banco e os logs" sh -c 'sudo test -f /var/lib/genesispdv/pdv.db && sudo sh -c "ls /var/log/genesispdv/*.log" >/dev/null'
echo "Pacote $pacote conferido: instala, abre com o banco do sistema, remove e expurga sem perder dados."
