#!/usr/bin/env bash
# Testes de unidade do scripts/acompanhar-implantacao.sh (OP-B7; D119) e do aviso do scripts/pedir-implantacao.sh,
# sem rede e sem escrever no GitHub: o script é copiado para uma raiz falsa (um clone de um repositório local, com a
# main e um branch "outra"), com dublês do `curl` (o estado.json e o /saude de mentira, uma resposta por consulta), do
# `date` (a hora de Brasília controlada) e do `gh` (só registra: o acompanhamento nunca o chama). Cobre: argumentos, o
# commit fora da main e inexistente (recusados), o fetch antes da conferência (um commit que entrou na main depois do
# clone), o acompanhamento até ok (o estado de um commit anterior ignorado, a API reiniciada), a ponta da main depois
# do commit (o vigia implanta a ponta, que o inclui), o "pdv" de um commit que inclui o nosso, falhou, recusado da main
# (e o recusado de um pedido manual, que não é o nosso), a janela (a hora prevista e quanto falta: 18:30, 23:59:30,
# 05:00 na janela 22-6; 16:59 e "nenhuma" fora dela), o tempo limite e o pedir-implantacao.sh que avisa e acompanha.
#
#   bash scripts/testar-acompanhar-implantacao.sh
# Precisa de bash, git, jq e coreutils.
set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-acompanhar-teste.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/duble"
DATE_REAL=$(command -v date)
export DUBLE=$T/duble DATE_REAL
export ACOMPANHAR_INTERVALO=0 ACOMPANHAR_TEMPO_LIMITE=30
unset ACOMPANHAR_REMOTO ACOMPANHAR_API_URL ACOMPANHAR_DOWNLOAD_URL ACOMPANHAR_JANELA
printf '[user]\n\tname = Teste\n\temail = teste@genesis.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n' >"$T/gitconfig"
export GIT_CONFIG_GLOBAL=$T/gitconfig GIT_CONFIG_NOSYSTEM=1

falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# --- Dublês -------------------------------------------------------------------------------------------------------
# gh: só registra em $DUBLE/gh (o acompanhamento nunca cria tag).
cat >"$T/bin/gh" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DUBLE/gh"
exit 1
DUBLE
# curl: o estado.json e o /saude vêm de $DUBLE/estados e $DUBLE/saudes, uma linha por consulta (a última se repete;
# "404" = não servido). Cada URL vai para $DUBLE/curl.
cat >"$T/bin/curl" <<'DUBLE'
#!/usr/bin/env bash
url=''
for a in "$@"; do case "$a" in https://*) url=$a ;; esac; done
printf '%s\n' "$url" >>"$DUBLE/curl"
case "$url" in
  https://download.grupoicebeer.com.br/implantacao/estado.json) f=$DUBLE/estados ;;
  https://api.grupoicebeer.com.br/saude) f=$DUBLE/saudes ;;
  *) exit 22 ;;
esac
[ -s "$f" ] || exit 22
linha=$(head -n 1 "$f")
[ "$(wc -l <"$f")" -le 1 ] || sed -i 1d "$f"
[ "$linha" != 404 ] || exit 22
printf '%s\n' "$linha"
DUBLE
# date: a hora de Brasília (o `+%H:%M:%S` e o `+%H:%M` sem -u) vem de $DUBLE/horas (uma por consulta, a última se
# repete) ou de $DUBLE/hora (padrão 10:00:00, fora da janela), com o fuso pedido em $DUBLE/fuso; o resto, o date de
# verdade.
cat >"$T/bin/date" <<'DUBLE'
#!/usr/bin/env bash
if [ "$#" = 1 ] && { [ "$1" = +%H:%M:%S ] || [ "$1" = +%H:%M ]; }; then
  printf '%s\n' "${TZ:-}" >"$DUBLE/fuso"
  if [ -s "$DUBLE/horas" ]; then
    h=$(head -n 1 "$DUBLE/horas")
    [ "$(wc -l <"$DUBLE/horas")" -le 1 ] || sed -i 1d "$DUBLE/horas"
  else
    h=$(cat "$DUBLE/hora" 2>/dev/null || echo 10:00:00)
  fi
  if [ "$1" = +%H:%M ]; then echo "${h%:*}"; else echo "$h"; fi
  exit 0
fi
exec "$DATE_REAL" "$@"
DUBLE
chmod +x "$T/bin"/*

# --- Repositório: o remoto (a main e o branch "outra") e a raiz falsa, um clone dele -------------------------------
B=$T/remoto.git
git init -q --bare "$B"
git clone -q "$B" "$T/trabalho" 2>/dev/null
w() { git -C "$T/trabalho" "$@"; }
commitar() {
  echo "$1" >>"$T/trabalho/LEIAME"
  w add -A
  w commit -q -m "$1"
  w push -q origin "${2:-main}"
  w rev-parse HEAD
}
M1=$(commitar um)
w checkout -q -b outra
X=$(commitar fora outra)
w checkout -q main
RAIZ=$T/raiz
git clone -q "$B" "$RAIZ"
mkdir -p "$RAIZ/scripts"
cp "$AQUI/acompanhar-implantacao.sh" "$AQUI/pedir-implantacao.sh" "$RAIZ/scripts/"
# Um commit que entra na main depois do clone da raiz: o script tem de buscar a main antes de conferir.
M2=$(commitar dois)
SCRIPT=$RAIZ/scripts/acompanhar-implantacao.sh
export PATH=$T/bin:$PATH

novo() {
  rm -f "${DUBLE:?}"/*
  printf '%s\n' "${ESTADOS[@]}" >"$DUBLE/estados"
  printf '%s\n' "${SAUDES[@]}" >"$DUBLE/saudes"
  [ -z "${HORA:-}" ] || echo "$HORA" >"$DUBLE/hora"
  # shellcheck disable=SC2086 # as horas, uma por palavra
  [ -z "${HORAS:-}" ] || printf '%s\n' $HORAS >"$DUBLE/horas"
}
rodar() {
  novo
  CODIGO=0
  SAIDA=$(bash "$SCRIPT" "$@" 2>&1) || CODIGO=$?
  [ ! -e "$DUBLE/gh" ] || falha "o acompanhamento nunca chama o gh: $(cat "$DUBLE/gh")"
}
tem() { grep -qF -- "$1" <<<"$SAIDA" || falha "$2: sem '$1' na saída: $SAIDA"; }
estado() { printf '{"pedido":"%s","commit":"%s","resultado":"%s","inicio":"2026-11-24T10:00:00Z","fim":%s}' "$1" "${2:0:12}" "$3" "${4:-null}"; }
saude() { printf '{"status":"ok","no_ar_desde":"%s"}' "$1"; }
ESTADOS=(404)
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)")

# --- Argumentos ---------------------------------------------------------------------------------------------------
rodar --ajuda
[ "$CODIGO" = 0 ] && grep -q 'acompanhar-implantacao.sh <commit da main>' <<<"$SAIDA" || falha "--ajuda: $SAIDA"
for args in "" "--opcao" "xyz" "${M1:0:6}" "${M1^^}" "$M1 $M2"; do
  # shellcheck disable=SC2086 # os argumentos de cada caso, por palavra
  rodar $args
  [ "$CODIGO" = 1 ] || falha "argumentos '$args' deveriam ser recusados (saiu $CODIGO): $SAIDA"
done
ACOMPANHAR_JANELA=17h rodar "$M2"
[ "$CODIGO" = 1 ] || falha "ACOMPANHAR_JANELA inválida deveria ser recusada: $SAIDA"
rodar "$X"
[ "$CODIGO" = 1 ] || falha "commit fora da main deveria ser recusado: $SAIDA"
tem "não está na main" "commit fora da main"
rodar 0123456789abcdef0123456789abcdef01234567
[ "$CODIGO" = 1 ] || falha "commit inexistente deveria ser recusado: $SAIDA"
[ ! -e "$DUBLE/curl" ] || falha "recusado antes de acompanhar não deveria ler as URLs: $(cat "$DUBLE/curl")"
confere "argumentos: sem commit, opção desconhecida, commit fora do formato, dois commits e a janela inválida são recusados; commit de outro branch e inexistente também, antes de ler as URLs"

# --- Até ok -------------------------------------------------------------------------------------------------------
ESTADOS=(404 "$(estado main "$M1" ok '"2026-11-01T00:10:00Z"')" "$(estado main "$M2" recebido)"
  "$(estado main "$M2" em_andamento)" "$(estado main "$M2" em_andamento)" "$(estado main "$M2" ok '"2026-11-24T10:09:00Z"')")
SAUDES=("$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-20T00:00:00.000Z)"
  "$(saude 2026-11-20T00:00:00.000Z)" "$(saude 2026-11-24T10:08:00.000Z)")
rodar "${M2:0:7}"
[ "$CODIGO" = 0 ] || falha "ok deveria sair com 0 (saiu $CODIGO): $SAIDA"
tem "commit $M2 está na main" "ok"
tem "fora da janela sem implantação automática (17-24" "ok"
tem "estado: recebido (pedido main, commit ${M2:0:12})" "ok"
tem "estado: em_andamento (pedido main" "ok"
tem "a API reiniciou (no_ar_desde: 2026-11-20T00:00:00.000Z → 2026-11-24T10:08:00.000Z)" "ok"
tem "implantação ok: commit ${M2:0:12} no ar (fim: 2026-11-24T10:09:00Z)" "ok"
[ "$(grep -c 'estado: em_andamento' <<<"$SAIDA")" = 1 ] || falha "o mesmo estado deveria aparecer uma vez: $SAIDA"
grep -q "${M1:0:12}" <<<"$SAIDA" && falha "o estado de um commit anterior não é o nosso: $SAIDA"
[ "$(cat "$DUBLE/fuso")" = America/Sao_Paulo ] || falha "a janela deveria usar o horário de Brasília: TZ=$(cat "$DUBLE/fuso")"
confere "busca a main (o commit que entrou depois do clone) e acompanha até ok (o estado de um commit anterior ignorado, a API reiniciada); nunca chama o gh"

# A ponta da main depois do nosso commit (outro merge): o vigia implanta a ponta, que o inclui; um pedido manual (tag)
# do nosso commit também conta; o "pdv" da versão no ar que o inclui diz que ele está no ar.
M3=$(commitar tres)
ESTADOS=("$(estado main "$M3" em_andamento)" "$(estado main "$M3" ok '"2026-11-24T10:09:00Z"')")
rodar "$M2"
[ "$CODIGO" = 0 ] || falha "a ponta que inclui o nosso deveria sair com 0: $SAIDA"
tem "a ponta da main já é ${M3:0:12}" "ponta depois"
tem "implantação ok: commit ${M3:0:12} no ar" "ponta depois"
ESTADOS=("$(estado implantar/20261125-010000 "$M2" ok '"2026-11-24T10:09:00Z"')")
rodar "$M2"
[ "$CODIGO" = 0 ] || falha "a tag manual do nosso commit deveria sair com 0: $SAIDA"
ESTADOS=("$(estado pdv "$M3" ok '"2026-11-24T10:09:00Z"')")
rodar "$M2"
[ "$CODIGO" = 0 ] || falha "o pdv de um commit que inclui o nosso deveria sair com 0: $SAIDA"
tem "o commit ${M2:0:12} está no ar (na versão ${M3:0:12}; depois, a publicação do PDV: ok)" "pdv"
ESTADOS=("$(estado pdv "$M1" ok '"2026-11-24T10:09:00Z"')")
ACOMPANHAR_TEMPO_LIMITE=0 rodar "$M2"
[ "$CODIGO" = 3 ] || falha "o pdv de um commit anterior não é o nosso (tempo limite, 3): saiu $CODIGO: $SAIDA"
confere "a ponta da main depois do commit (que o inclui), a tag manual dele e o pdv de uma versão que o inclui contam; o pdv de uma versão anterior, não"

# --- Falhou, recusado, tempo limite --------------------------------------------------------------------------------
for r in falhou recusado; do
  ESTADOS=("$(estado main "$M3" em_andamento)" "$(estado main "$M3" "$r" '"2026-11-24T10:09:00Z"')")
  rodar "$M3"
  [ "$CODIGO" = 1 ] || falha "$r deveria sair com 1 (saiu $CODIGO): $SAIDA"
  tem "implantação $r (pedido main" "$r"
  tem "instalar-vigia.sh --estado" "$r"
done
ESTADOS=("$(estado implantar/20261125-020000 "$M3" falhou '"2026-11-24T10:09:00Z"')")
rodar "$M3"
[ "$CODIGO" = 1 ] || falha "falhou de uma tag manual do nosso commit deveria sair com 1: $SAIDA"
ESTADOS=("$(estado implantar/20261125-030000 "$M3" recusado '"2026-11-24T10:09:00Z"')")
ACOMPANHAR_TEMPO_LIMITE=0 rodar "$M3"
[ "$CODIGO" = 3 ] || falha "recusado de um pedido manual não é o nosso resultado (tempo limite, 3): saiu $CODIGO: $SAIDA"
ESTADOS=(404)
ACOMPANHAR_TEMPO_LIMITE=0 rodar "$M3"
[ "$CODIGO" = 3 ] || falha "tempo limite deveria sair com 3 (saiu $CODIGO): $SAIDA"
tem "tempo limite" "tempo limite"
tem "o vigia desligado" "tempo limite"
tem "instalar-vigia.sh --estado" "tempo limite"
confere "falhou e recusado da main saem com 1 (o falhou de uma tag do commit também); o recusado de um pedido manual não é o nosso; tempo limite com 3"

# --- Janela -------------------------------------------------------------------------------------------------------
ESTADOS=("$(estado main "$M3" recebido)" "$(estado main "$M3" ok '"2026-11-25T03:09:00Z"')")
HORA=18:30:00 rodar "$M3"
[ "$CODIGO" = 0 ] || falha "janela 18:30: $SAIDA"
tem "agora é 18:30 em Brasília, dentro da janela sem implantação automática (17-24): o vigia começa a partir das 00:00 (daqui a 5 h 30 min)" "janela 18:30"
HORA=23:59:30 rodar "$M3"
tem "a partir das 00:00 (daqui a 0 h 0 min)" "janela 23:59:30"
HORA=16:59:59 rodar "$M3"
tem "fora da janela sem implantação automática" "16:59:59"
ACOMPANHAR_JANELA=22-6 HORA=05:00:00 rodar "$M3"
tem "dentro da janela sem implantação automática (22-6): o vigia começa a partir das 06:00 (daqui a 1 h 0 min)" "janela 22-6 às 05:00"
ACOMPANHAR_JANELA=nenhuma HORA=18:30:00 rodar "$M3"
tem "fora da janela sem implantação automática (nenhuma" "janela nenhuma"
# Dentro da janela, o tempo limite conta a partir do fim dela: com o limite 0 às 23:59:50, o ok que chega depois de
# três consultas sem estado ainda vale (sem a extensão, o tempo limite venceria na primeira); depois do fim, 3.
ESTADOS=(404 404 404 "$(estado main "$M3" ok '"2026-11-25T03:09:00Z"')")
ACOMPANHAR_TEMPO_LIMITE=0 HORA=23:59:50 rodar "$M3"
[ "$CODIGO" = 0 ] || falha "dentro da janela, o tempo limite conta do fim dela (saiu $CODIGO): $SAIDA"
ESTADOS=(404)
ACOMPANHAR_TEMPO_LIMITE=0 HORA=23:59:59 rodar "$M3"
[ "$CODIGO" = 3 ] || falha "tempo limite depois da janela: $SAIDA"
# Começa fora da janela (16:59:59) e o vigia só recebe o commit dentro dela (17:00:30): o tempo limite passa a contar
# do fim dela, com a hora prevista, uma vez só; sem isso, o limite 0 venceria no primeiro "recebido".
ESTADOS=("$(estado main "$M3" recebido)" "$(estado main "$M3" recebido)" "$(estado main "$M3" ok '"2026-11-25T03:09:00Z"')")
ACOMPANHAR_TEMPO_LIMITE=0 HORAS="16:59:59 17:00:30" rodar "$M3"
[ "$CODIGO" = 0 ] || falha "recebido dentro da janela depois de começar fora dela (saiu $CODIGO): $SAIDA"
tem "fora da janela sem implantação automática (17-24" "começa fora da janela"
tem "o vigia recebeu o commit dentro da janela sem implantação automática (17-24, horário de Brasília): implanta a partir das 00:00 (daqui a 6 h 59 min)" "recebido dentro da janela"
[ "$(grep -c 'o vigia recebeu o commit dentro da janela' <<<"$SAIDA")" = 1 ] || falha "a extensão deveria ser dita uma vez: $SAIDA"
ESTADOS=("$(estado main "$M3" recebido)")
ACOMPANHAR_TEMPO_LIMITE=0 HORAS="16:59:59 16:59:59" rodar "$M3"
[ "$CODIGO" = 3 ] || falha "recebido fora da janela não estende o tempo limite (saiu $CODIGO): $SAIDA"
confere "janela: dentro dela, a hora prevista e quanto falta (18:30, 23:59:30; 22-6 às 05:00), e o tempo limite conta do fim dela (também quando o vigia recebe o commit já dentro dela, começando fora); 16:59 e nenhuma, fora"

# --- O pedir-implantacao.sh antigo: avisa e acompanha -------------------------------------------------------------
ESTADOS=("$(estado main "$M3" ok '"2026-11-24T10:09:00Z"')")
novo
CODIGO=0
SAIDA=$(bash "$RAIZ/scripts/pedir-implantacao.sh" "$M3" --publicar-pdv 2>&1) || CODIGO=$?
[ "$CODIGO" = 0 ] || falha "pedir-implantacao.sh deveria acompanhar até o ok: $SAIDA"
tem "não cria mais a tag de pedido (D119)" "pedir-implantacao.sh"
tem "--publicar-pdv ignorado" "pedir-implantacao.sh"
tem "implantação ok: commit ${M3:0:12} no ar" "pedir-implantacao.sh"
[ ! -e "$DUBLE/gh" ] || falha "pedir-implantacao.sh não pode chamar o gh: $(cat "$DUBLE/gh")"
novo
CODIGO=0
SAIDA=$(bash "$RAIZ/scripts/pedir-implantacao.sh" "$M3" --sem-acompanhar 2>&1) || CODIGO=$?
[ "$CODIGO" = 0 ] && [ ! -e "$DUBLE/curl" ] && [ ! -e "$DUBLE/gh" ] || falha "--sem-acompanhar: só o aviso: $SAIDA"
confere "pedir-implantacao.sh: avisa que não cria mais a tag, ignora --publicar-pdv e passa o commit ao acompanhamento; --sem-acompanhar só avisa"

printf '\n\033[1;32macompanhar-implantacao.sh: todos os testes passaram.\033[0m\n'
