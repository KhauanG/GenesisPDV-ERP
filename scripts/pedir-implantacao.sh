#!/usr/bin/env bash
# Pede a implantação de um commit da main ao vigia da VPS (OP-B4; D70, com a autonomia que o dono deu à sessão em
# 24/11/2026) e acompanha o resultado pelas URLs públicas. A sessão nunca fala com a VPS: cria uma tag no repositório
# público, o vigia da VPS (infra/producao/vigia) a busca, implanta e publica o resultado em
# https://<download>/implantacao/estado.json (README de infra/producao › Vigia da implantação).
#
#   scripts/pedir-implantacao.sh <commit da main> [--publicar-pdv] [--sem-estado] [--sem-acompanhar]
#     <commit>          hash da main, curto (7 a 40 hexadecimais) ou completo
#     --publicar-pdv    também publica na página de download o instalador do último GitHub Release do PDV
#     --sem-estado      aceita um commit anterior ao OP-B4 (uma volta): o genesis-web dele não serve o estado.json
#     --sem-acompanhar  cria o pedido e sai, sem esperar o resultado
#
# Na ordem: confere que o commit está na origin/main (git fetch antes) e que o genesis-web dele serve o estado.json
# (a rota no nginx e a pasta montada no docker-compose.yml, desde o OP-B4; senão recusa sem o --sem-estado), cria a
# tag implantar/<AAAAMMDD-HHMMSS> (UTC; implantar-pdv/ com --publicar-pdv) pela API REST (`gh api
# repos/<repo>/git/refs`) e acompanha o estado.json e o /saude da API (o no_ar_desde muda quando a API nova sobe) até
# ok, falhou, recusado, um pedido mais novo passar na frente (o nosso fica como pulado) ou o tempo limite. Sai com 0
# no ok, 1 no falhou/recusado/pulado (ou erro antes do pedido), 2 com o --sem-estado quando a API reinicia (a troca
# de versão aconteceu; o resultado final não aparece no estado.json, o dono o vê na VPS) e 3 no tempo limite (sem
# resultado: a implantação ainda roda, a VPS está fora ou o vigia está desligado; o dono confere na VPS com
# `bash ~/instalar-vigia.sh --estado`). Dá para rodar em segundo plano: a implantação leva de 5 a 15 minutos, mais até
# 2 minutos para o vigia ver o pedido.
#
# Variáveis: PEDIR_REPO (padrão KhauanG/GenesisPDV-ERP), PEDIR_REMOTO (padrão origin), PEDIR_API_URL (padrão
# https://api.grupoicebeer.com.br), PEDIR_DOWNLOAD_URL (padrão https://download.grupoicebeer.com.br),
# PEDIR_TEMPO_LIMITE (segundos, padrão 3600) e PEDIR_INTERVALO (segundos entre as consultas, padrão 20).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=${PEDIR_REPO:-KhauanG/GenesisPDV-ERP}
REMOTO=${PEDIR_REMOTO:-origin}
API_URL=${PEDIR_API_URL:-https://api.grupoicebeer.com.br}
DOWNLOAD_URL=${PEDIR_DOWNLOAD_URL:-https://download.grupoicebeer.com.br}
TEMPO_LIMITE=${PEDIR_TEMPO_LIMITE:-3600}
INTERVALO=${PEDIR_INTERVALO:-20}

erro() {
  printf 'ERRO: %s\n' "$*" >&2
  exit 1
}
dizer() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
uso() { sed -n '7,11p' "$0" | sed 's/^# \{0,1\}//'; }

COMMIT=''
PREFIXO=implantar
ACOMPANHAR=1
SEM_ESTADO=0
for arg in "$@"; do
  case "$arg" in
    --publicar-pdv) PREFIXO=implantar-pdv ;;
    --sem-estado) SEM_ESTADO=1 ;;
    --sem-acompanhar) ACOMPANHAR=0 ;;
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
  erro "informe o commit da main a implantar."
}
[[ $COMMIT =~ ^[0-9a-f]{7,40}$ ]] || erro "commit inválido: '$COMMIT' (o hash da main, 7 a 40 hexadecimais minúsculos)."
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || erro "PEDIR_REPO inválido: '$REPO' (dono/repositório)."
for n in "$TEMPO_LIMITE" "$INTERVALO"; do
  [[ $n =~ ^[0-9]+$ ]] || erro "valor numérico inválido em PEDIR_TEMPO_LIMITE/PEDIR_INTERVALO: '$n'."
done
for c in git gh curl jq; do
  command -v "$c" >/dev/null || erro "falta o comando $c."
done

# --- O commit está na main -----------------------------------------------------------------------------------------
git -C "$RAIZ" fetch --quiet "$REMOTO" "+refs/heads/main:refs/remotes/$REMOTO/main" ||
  erro "não foi possível buscar a main de $REMOTO."
SHA=$(git -C "$RAIZ" rev-parse --verify --quiet "$COMMIT^{commit}") ||
  erro "commit '$COMMIT' não encontrado (ou o hash curto é ambíguo: informe o completo)."
git -C "$RAIZ" merge-base --is-ancestor "$SHA" "refs/remotes/$REMOTO/main" ||
  erro "o commit $SHA não está na main de $REMOTO: só vai para produção o que entrou na main (merge com a liberação do dono)."
dizer "commit $SHA está na main"

# --- O genesis-web do commit serve o estado.json -------------------------------------------------------------------
# A rota (nginx) e a pasta montada (docker-compose.yml) chegaram com o OP-B4. Numa volta para um commit anterior, o
# genesis-web dele responde 404 no estado.json depois da troca de versão: o "ok" fica só no host, e a sessão não o vê
# (só o reinício da API no /saude). README de infra/producao › Vigia da implantação.
serve_estado() {
  local nginx compose
  nginx=$(git -C "$RAIZ" show "$1:apps/erp-web/nginx/genesis.conf" 2>/dev/null) || return 1
  compose=$(git -C "$RAIZ" show "$1:infra/producao/docker-compose.yml" 2>/dev/null) || return 1
  grep -qF 'location = /implantacao/estado.json' <<<"$nginx" &&
    grep -qF './download/implantacao:/srv/download/implantacao' <<<"$compose"
}
if serve_estado "$SHA"; then
  SEM_ESTADO=0
elif [ "$SEM_ESTADO" = 0 ]; then
  erro "o commit ${SHA:0:12} é anterior ao OP-B4: o genesis-web dele não serve o /implantacao/estado.json, e o resultado desta implantação não apareceria para a sessão depois da troca de versão. Para pedir assim mesmo (uma volta), repita com --sem-estado: o script acompanha só até a API reiniciar (o no_ar_desde do /saude), e o dono confere o resultado na VPS (bash ~/instalar-vigia.sh --estado)."
else
  dizer "atenção: o commit ${SHA:0:12} é anterior ao OP-B4 (--sem-estado): depois da troca de versão, o estado.json dá 404; acompanho só até a API reiniciar"
fi

# --- Leituras públicas ---------------------------------------------------------------------------------------------
ler_estado() { curl -fsS --proto '=https' --max-time 15 "$DOWNLOAD_URL/implantacao/estado.json" 2>/dev/null || true; }
campo() { jq -r --arg c "$1" '.[$c] // empty | tostring' 2>/dev/null <<<"$2" || true; }
no_ar_desde() {
  curl -fsS --proto '=https' --max-time 15 "$API_URL/saude" 2>/dev/null | jq -r '.no_ar_desde // empty' 2>/dev/null || true
}
NO_AR_ANTES=$(no_ar_desde)

# --- O pedido ------------------------------------------------------------------------------------------------------
TAG=$PREFIXO/$(date -u +%Y%m%d-%H%M%S)
gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/tags/$TAG" -f "sha=$SHA" >/dev/null ||
  erro "não foi possível criar a tag $TAG em $REPO (permissão de escrita no repositório?)."
dizer "pedido criado: tag $TAG → ${SHA:0:12} (o vigia da VPS o vê em até 2 minutos)"
if [ "$ACOMPANHAR" = 0 ]; then
  echo "Acompanhar: $DOWNLOAD_URL/implantacao/estado.json (pedido $TAG) e $API_URL/saude (no_ar_desde)."
  exit 0
fi

# --- Acompanhamento ------------------------------------------------------------------------------------------------
fim=$((SECONDS + TEMPO_LIMITE))
ultimo=''
api_reiniciou=0
while :; do
  estado=$(ler_estado)
  pedido=$(campo pedido "$estado")
  resultado=$(campo resultado "$estado")
  if [ "$pedido" = "$TAG" ] && [ "$resultado" != "$ultimo" ]; then
    dizer "estado do pedido: $resultado"
    ultimo=$resultado
  fi
  agora_no_ar=$(no_ar_desde)
  if [ "$api_reiniciou" = 0 ] && [ -n "$agora_no_ar" ] && [ -n "$NO_AR_ANTES" ] && [ "$agora_no_ar" != "$NO_AR_ANTES" ]; then
    dizer "a API reiniciou (no_ar_desde: $NO_AR_ANTES → $agora_no_ar)"
    api_reiniciou=1
  fi
  if [ "$pedido" = "$TAG" ]; then
    case "$resultado" in
      ok)
        dizer "implantação ok: commit ${SHA:0:12} no ar (fim: $(campo fim "$estado"))"
        [ "$api_reiniciou" = 1 ] || dizer "atenção: o no_ar_desde da API não mudou (a mesma versão já estava no ar?)"
        exit 0
        ;;
      falhou | recusado)
        dizer "implantação $resultado (o motivo fica no log do vigia na VPS: bash instalar-vigia.sh --estado)"
        exit 1
        ;;
    esac
  elif [[ $pedido =~ ^implantar(-pdv)?/[0-9]{8}-[0-9]{6}$ ]] && [[ ${pedido#*/} > ${TAG#*/} ]]; then
    dizer "um pedido mais novo ($pedido) passou na frente: o nosso ficou como pulado"
    exit 1
  fi
  # Commit sem o estado.json: a troca de versão (a API reiniciou) é o último sinal público. Depois dela vêm a
  # conferência da saúde e, se a nova não responder, a volta sozinha: o resultado final só o dono vê na VPS.
  if [ "$SEM_ESTADO" = 1 ] && [ "$api_reiniciou" = 1 ]; then
    dizer "a troca de versão aconteceu (--sem-estado): o resultado final não aparece no estado.json (o genesis-web do commit ${SHA:0:12} não o serve). Peça ao dono para conferir na VPS: bash ~/instalar-vigia.sh --estado"
    exit 2
  fi
  if [ "$SECONDS" -ge "$fim" ]; then
    dizer "tempo limite (${TEMPO_LIMITE} s) sem o resultado; último estado do pedido: ${ultimo:-não visto}. A implantação pode estar ainda rodando, a VPS fora do ar ou o vigia desligado (um pedido feito com ele desligado não roda quando ele é religado: peça de novo). O dono confere na VPS: bash ~/instalar-vigia.sh --estado."
    exit 3
  fi
  sleep "$INTERVALO"
done
