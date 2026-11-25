#!/usr/bin/env bash
# Acompanha pelas URLs públicas a implantação de um commit da main pelo vigia da VPS (OP-B7; D119). Desde a D119 o
# vigia (infra/producao/vigia) implanta sozinho cada commit novo da main, uma vez por commit, fora das 17h à
# meia-noite (horário de Brasília): o merge que o dono libera vale também como "pode implantar". A sessão nunca fala
# com a VPS nem cria tag; só lê o https://<download>/implantacao/estado.json e o /saude da API (README de
# infra/producao › Vigia da implantação).
#
#   scripts/acompanhar-implantacao.sh <commit da main>
#     <commit>   hash da main, curto (7 a 40 hexadecimais) ou completo (o merge que o dono liberou)
#
# Na ordem: confere que o commit está na origin/main (git fetch antes); diz se agora está dentro da janela sem
# implantação automática (a hora prevista do começo e quanto falta) e acompanha o estado.json e o /saude da API (o
# no_ar_desde muda quando a API nova sobe) até o vigia mostrar, para o commit ou um commit da main que o inclui (um
# merge depois dele; o vigia implanta só a ponta), "ok", "falhou" ou "recusado". O estado de um commit anterior ao
# nosso não conta. Um "pdv" (a publicação só do PDV, gravada com a versão no ar) de um commit que inclui o nosso diz
# que ele está no ar. Sai com 0 no ok, 1 no falhou/recusado (ou erro antes de acompanhar) e 3 no tempo limite (sem
# resultado: a implantação ainda roda, a VPS está fora, o vigia está desligado ou o commit já tinha sido tratado, ex.:
# uma volta do dono; o dono confere na VPS com `bash ~/instalar-vigia.sh --estado`). O tempo limite conta a partir do
# fim da janela, quando o commit chega dentro dela: começando dentro dela, ou vendo o "recebido" do vigia já dentro
# dela (o acompanhamento começou fora, e o vigia só viu o commit depois das 17:00). Dá para rodar em segundo plano: a implantação leva de 5 a 15
# minutos, mais até 2 minutos para o vigia ver o commit.
#
# Variáveis: ACOMPANHAR_REMOTO (padrão origin), ACOMPANHAR_API_URL (padrão https://api.grupoicebeer.com.br),
# ACOMPANHAR_DOWNLOAD_URL (padrão https://download.grupoicebeer.com.br), ACOMPANHAR_JANELA (padrão 17-24, o padrão
# do vigia; a da VPS fica no arquivo janela dela), ACOMPANHAR_TEMPO_LIMITE (segundos, padrão 3600) e
# ACOMPANHAR_INTERVALO (segundos entre as consultas, padrão 20).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTO=${ACOMPANHAR_REMOTO:-origin}
API_URL=${ACOMPANHAR_API_URL:-https://api.grupoicebeer.com.br}
DOWNLOAD_URL=${ACOMPANHAR_DOWNLOAD_URL:-https://download.grupoicebeer.com.br}
JANELA=${ACOMPANHAR_JANELA:-17-24}
TEMPO_LIMITE=${ACOMPANHAR_TEMPO_LIMITE:-3600}
INTERVALO=${ACOMPANHAR_INTERVALO:-20}
FUSO=America/Sao_Paulo

erro() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}
dizer() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
uso() { sed -n '8,9p' "$0" | sed 's/^# \{0,1\}//'; }

COMMIT=''
for arg in "$@"; do
  case "$arg" in
    -h | --ajuda)
      uso
      exit 0
      ;;
    -*)
      uso >&2
      erro "opção desconhecida: '$arg'."
      ;;
    *)
      [ -z "$COMMIT" ] || erro "informe um commit só (veio '$COMMIT' e '$arg')."
      COMMIT=$arg
      ;;
  esac
done
[ -n "$COMMIT" ] || {
  uso >&2
  erro "informe o commit da main a acompanhar."
}
[[ $COMMIT =~ ^[0-9a-f]{7,40}$ ]] || erro "commit inválido: '$COMMIT' (o hash da main, 7 a 40 hexadecimais minúsculos)."
for n in "$TEMPO_LIMITE" "$INTERVALO"; do
  [[ $n =~ ^[0-9]+$ ]] || erro "valor numérico inválido em ACOMPANHAR_TEMPO_LIMITE/ACOMPANHAR_INTERVALO: '$n'."
done
[ "$JANELA" = nenhuma ] || [[ $JANELA =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]] ||
  erro "ACOMPANHAR_JANELA inválida: '$JANELA' (<início>-<fim> em horas cheias, ex.: 17-24, ou nenhuma)."
for c in git curl jq; do
  command -v "$c" >/dev/null || erro "falta o comando $c."
done

# --- O commit está na main -----------------------------------------------------------------------------------------
buscar_main() { git -C "$RAIZ" fetch --quiet "$REMOTO" "+refs/heads/main:refs/remotes/$REMOTO/main"; }
buscar_main || erro "não foi possível buscar a main de $REMOTO."
SHA=$(git -C "$RAIZ" rev-parse --verify --quiet "$COMMIT^{commit}") ||
  erro "commit '$COMMIT' não encontrado (ou o hash curto é ambíguo: informe o completo)."
git -C "$RAIZ" merge-base --is-ancestor "$SHA" "refs/remotes/$REMOTO/main" ||
  erro "o commit $SHA não está na main de $REMOTO: só vai para produção o que entrou na main (merge com a liberação do dono)."
PONTA=$(git -C "$RAIZ" rev-parse "refs/remotes/$REMOTO/main")
dizer "commit $SHA está na main"
[ "$PONTA" = "$SHA" ] ||
  dizer "a ponta da main já é ${PONTA:0:12} (um merge depois deste commit): o vigia implanta a ponta, que o inclui"

# O commit de 12 caracteres do estado.json inclui o nosso (é ele ou um commit da main depois dele). Um commit que a
# raiz ainda não conhece (um merge depois do fetch) faz buscar a main de novo, uma vez por commit.
declare -A INCLUI=()
inclui_o_nosso() {
  local curto=$1 completo
  [[ $curto =~ ^[0-9a-f]{12}$ ]] || return 1
  if [ -z "${INCLUI[$curto]:-}" ]; then
    completo=$(git -C "$RAIZ" rev-parse --verify --quiet "$curto^{commit}" 2>/dev/null) ||
      { buscar_main 2>/dev/null || true; completo=$(git -C "$RAIZ" rev-parse --verify --quiet "$curto^{commit}" 2>/dev/null) || true; }
    if [ -n "$completo" ] && git -C "$RAIZ" merge-base --is-ancestor "$SHA" "$completo" 2>/dev/null; then
      INCLUI[$curto]=sim
    else
      INCLUI[$curto]=nao
    fi
  fi
  [ "${INCLUI[$curto]}" = sim ]
}

# --- Janela (a do vigia: nada automático entre as 17:00 e a meia-noite, horário de Brasília) ----------------------
# "<segundos até o fim da janela> <hora do fim, HH:00>", se agora está dentro dela; senão, volta 1.
ate_o_fim_da_janela() {
  [ "$JANELA" != nenhuma ] || return 1
  local ini=$((10#${JANELA%-*})) fim=$((10#${JANELA#*-})) agora h m s
  agora=$(TZ=$FUSO date +%H:%M:%S)
  IFS=: read -r h m s <<<"$agora"
  h=$((10#$h))
  if [ "$ini" -lt "$fim" ]; then
    [ "$h" -ge "$ini" ] && [ "$h" -lt "$fim" ] || return 1
  else
    [ "$h" -ge "$ini" ] || [ "$h" -lt "$fim" ] || return 1
  fi
  printf '%d %02d:00\n' $((((fim * 3600) - (h * 3600 + 10#$m * 60 + 10#$s) + 86400) % 86400)) $((fim % 24))
}
fim=$((SECONDS + TEMPO_LIMITE))
# 1 = o tempo limite já conta do fim da janela (uma vez só).
estendido=0
if janela_agora=$(ate_o_fim_da_janela); then
  read -r falta FIM_JANELA <<<"$janela_agora"
  dizer "agora é $(TZ=$FUSO date +%H:%M) em Brasília, dentro da janela sem implantação automática ($JANELA): o vigia começa a partir das $FIM_JANELA (daqui a $((falta / 3600)) h $((falta % 3600 / 60)) min); o tempo limite conta a partir de lá"
  fim=$((fim + falta))
  estendido=1
else
  dizer "fora da janela sem implantação automática ($JANELA, horário de Brasília): o vigia vê o commit em até 2 minutos, e a implantação leva de 5 a 15 minutos"
fi

# --- Leituras públicas ---------------------------------------------------------------------------------------------
ler_estado() { curl -fsS --proto '=https' --max-time 15 "$DOWNLOAD_URL/implantacao/estado.json" 2>/dev/null || true; }
campo() { jq -r --arg c "$1" '.[$c] // empty | tostring' 2>/dev/null <<<"$2" || true; }
no_ar_desde() {
  curl -fsS --proto '=https' --max-time 15 "$API_URL/saude" 2>/dev/null | jq -r '.no_ar_desde // empty' 2>/dev/null || true
}
NO_AR_ANTES=$(no_ar_desde)

# --- Acompanhamento ------------------------------------------------------------------------------------------------
ultimo=''
api_reiniciou=0
while :; do
  estado=$(ler_estado)
  pedido=$(campo pedido "$estado")
  commit=$(campo commit "$estado")
  resultado=$(campo resultado "$estado")
  nosso=0
  if [ -n "$pedido" ] && inclui_o_nosso "$commit"; then nosso=1; fi
  if [ "$nosso" = 1 ] && [ "$pedido $commit $resultado" != "$ultimo" ]; then
    dizer "estado: $resultado (pedido $pedido, commit $commit)"
    ultimo="$pedido $commit $resultado"
  fi
  # O vigia recebeu o commit já dentro da janela (o acompanhamento começou fora dela, logo antes das 17:00): ele
  # espera o fim dela, e o tempo limite passa a contar de lá.
  if [ "$nosso" = 1 ] && [ "$resultado" = recebido ] && [ "$estendido" = 0 ] && janela_agora=$(ate_o_fim_da_janela); then
    read -r falta FIM_JANELA <<<"$janela_agora"
    estendido=1
    [ $((SECONDS + falta + TEMPO_LIMITE)) -le "$fim" ] || fim=$((SECONDS + falta + TEMPO_LIMITE))
    dizer "o vigia recebeu o commit dentro da janela sem implantação automática ($JANELA, horário de Brasília): implanta a partir das $FIM_JANELA (daqui a $((falta / 3600)) h $((falta % 3600 / 60)) min); o tempo limite conta a partir de lá"
  fi
  agora_no_ar=$(no_ar_desde)
  if [ "$api_reiniciou" = 0 ] && [ -n "$agora_no_ar" ] && [ -n "$NO_AR_ANTES" ] && [ "$agora_no_ar" != "$NO_AR_ANTES" ]; then
    dizer "a API reiniciou (no_ar_desde: $NO_AR_ANTES → $agora_no_ar)"
    api_reiniciou=1
  fi
  if [ "$nosso" = 1 ]; then
    case "$pedido:$resultado" in
      pdv:*)
        # A publicação só do PDV grava a versão no ar: o commit dela (que inclui o nosso) está no ar.
        dizer "implantação ok: o commit ${SHA:0:12} está no ar (na versão $commit; depois, a publicação do PDV: $resultado)"
        exit 0
        ;;
      *:ok)
        dizer "implantação ok: commit $commit no ar (fim: $(campo fim "$estado"))"
        [ "$api_reiniciou" = 1 ] || dizer "atenção: o no_ar_desde da API não mudou (a mesma versão já estava no ar?)"
        exit 0
        ;;
      *:falhou | main:recusado)
        dizer "implantação $resultado (pedido $pedido, commit $commit; o motivo fica no log do vigia na VPS: bash ~/instalar-vigia.sh --estado)"
        exit 1
        ;;
    esac
  fi
  if [ "$SECONDS" -ge "$fim" ]; then
    dizer "tempo limite sem o resultado; último estado: ${ultimo:-nenhum deste commit}. A implantação pode estar ainda rodando, a VPS fora do ar, o vigia desligado ou o commit já tratado antes (uma volta do dono não é desfeita). O dono confere na VPS: bash ~/instalar-vigia.sh --estado."
    exit 3
  fi
  sleep "$INTERVALO"
done
