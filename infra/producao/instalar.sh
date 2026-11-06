#!/usr/bin/env bash
# Genesis: preparação da VPS (Implantação do piloto, I1). Idempotente: pode rodar quantas vezes quiser — o workflow
# de implantação roda antes de cada deploy. Nunca imprime segredos e nunca troca um segredo que já existe (trocar a
# CHAVE_MESTRA tornaria ilegível o que já foi cifrado com ela).
#
#   sudo bash instalar.sh            # na VPS, a partir da pasta com os arquivos de infra/producao
#
# O que faz:
#   1. Confere os pré-requisitos: root, Docker com Compose v2, rede externa do Traefik, segredos do Google em
#      /opt/genesis/segredos (gerados no Cloud Shell) com as chaves esperadas.
#   2. Gera /opt/genesis/segredos/genesis-app.env (JWT_SEGREDO, JWT_SEGREDO_PLATAFORMA, CHAVE_MESTRA) com openssl,
#      se ainda não existir.
#   3. Ajusta permissões: pasta de segredos 700; arquivos 600; a chave da conta de serviço root:65532 640 (o usuário
#      do Cloud SQL Auth Proxy, uid/gid 65532, precisa ler).
#   4. Cria /opt/genesis/.env (interpolação do Compose) e /opt/genesis/genesis.env (configuração não secreta) a partir
#      dos modelos, se ainda não existirem.
#   5. Cria a pasta do instalador do PDV da página de download (/opt/genesis/download/pdv, root:101 750, arquivos 640:
#      o nginx do genesis-web, uid/gid 101, só lê; README › Página de download do PDV).
# Variáveis (só para o teste local da stack, que também roda como root): GENESIS_PASTA (padrão /opt/genesis),
# REDE_PROXY (padrão: a do .env ou `proxy`).
# Rodar de novo depois de colar outra vez o bloco do Cloud Shell (README › Passo 1): o bloco recria a chave da conta
# de serviço como root:root 600, que o proxy (65532) não lê; este script devolve root:65532 640.
set -euo pipefail
umask 077

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PASTA=${GENESIS_PASTA:-/opt/genesis}
SEGREDOS=$PASTA/segredos
GOOGLE_ENV=$SEGREDOS/genesis-google.env
CONTA_SERVICO=$SEGREDOS/gcp-conta-servico.json
APP_ENV=$SEGREDOS/genesis-app.env
UID_PROXY=65532
GID_NGINX=101

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32mOK:\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33mATENÇÃO: %s\033[0m\n' "$*"; }
erro() {
  printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2
  exit 1
}

# Valor de uma chave num arquivo KEY=valor, sem imprimir.
valor() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

passo "1/5 Pré-requisitos"
if [ "$(id -u)" -ne 0 ]; then
  erro "rode como root (sudo bash $0): os segredos ficam em $SEGREDOS com dono root."
fi
command -v docker >/dev/null || erro "Docker não encontrado."
docker info >/dev/null 2>&1 || erro "o Docker não respondeu (o serviço está rodando?)."
docker compose version >/dev/null 2>&1 || erro "Docker Compose v2 (docker compose) não encontrado."
command -v openssl >/dev/null || erro "openssl não encontrado (apt-get install -y openssl)."
# Sem versões nem nomes de container na saída: no GitHub Actions ela vai para um log público (D60).
ok "Docker e Docker Compose v2 respondendo"

REDE=${REDE_PROXY:-}
[ -z "$REDE" ] && [ -f "$PASTA/.env" ] && REDE=$(valor "$PASTA/.env" REDE_PROXY)
REDE=${REDE:-proxy}
docker network inspect "$REDE" >/dev/null 2>&1 ||
  erro "a rede Docker '$REDE' do Traefik não existe. Na VPS ela é criada pelo projeto icebeer; confira com: docker network ls"
ok "rede externa '$REDE' do Traefik"
if docker ps --format '{{.Image}}' | grep -q '^traefik'; then
  ok "Traefik rodando"
else
  aviso "nenhum container do Traefik rodando: a API e o ERP sobem, mas não ficam acessíveis pelos domínios."
fi

[ -d "$SEGREDOS" ] || erro "$SEGREDOS não existe. Cole na VPS o bloco gerado pelo configurar-genesis.sh no Cloud Shell (README › Passo 1)."
[ -s "$GOOGLE_ENV" ] || erro "$GOOGLE_ENV não existe ou está vazio (bloco do Cloud Shell, README › Passo 1)."
[ -s "$CONTA_SERVICO" ] || erro "$CONTA_SERVICO não existe ou está vazio (bloco do Cloud Shell, README › Passo 1)."
for chave in CLOUDSQL_INSTANCIA DATABASE_URL ARMAZENAMENTO_ENDPOINT ARMAZENAMENTO_BUCKET ARMAZENAMENTO_CHAVE_ACESSO \
  ARMAZENAMENTO_CHAVE_SECRETA; do
  [ -n "$(valor "$GOOGLE_ENV" "$chave")" ] || erro "falta $chave em $GOOGLE_ENV."
done
case "$(valor "$GOOGLE_ENV" DATABASE_URL)" in
  postgres://*@genesis-cloudsql-proxy:5432/genesis_control) ;;
  *) aviso "DATABASE_URL de $GOOGLE_ENV não aponta para genesis-cloudsql-proxy:5432/genesis_control." ;;
esac
grep -q '"type": *"service_account"' "$CONTA_SERVICO" ||
  erro "$CONTA_SERVICO não parece uma chave de conta de serviço do Google."
ok "segredos do Google em $SEGREDOS (valores não exibidos)"

passo "2/5 Segredos da aplicação ($APP_ENV)"
if [ -s "$APP_ENV" ]; then
  for chave in JWT_SEGREDO JWT_SEGREDO_PLATAFORMA CHAVE_MESTRA; do
    [ -n "$(valor "$APP_ENV" "$chave")" ] || erro "falta $chave em $APP_ENV (o arquivo existe; corrija à mão, sem apagar a CHAVE_MESTRA)."
  done
  ok "já existia; mantido como está"
else
  {
    echo "# Gerado pelo instalar.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ). Segredo: não copie para chat, e-mail ou repositório."
    echo "# NUNCA troque a CHAVE_MESTRA sem a rotação (CHAVES_MESTRAS_ANTERIORES, apps/api/README.md): o que já foi"
    echo "# cifrado com ela fica ilegível. Guarde uma cópia deste arquivo fora da VPS (cofre de senhas)."
    echo "JWT_SEGREDO=$(openssl rand -base64 48 | tr -d '\n')"
    echo "JWT_SEGREDO_PLATAFORMA=$(openssl rand -base64 48 | tr -d '\n')"
    echo "CHAVE_MESTRA=$(openssl rand -base64 32 | tr -d '\n')"
    echo "CHAVE_MESTRA_VERSAO=1"
    echo "# SMTP real (opcional por enquanto), quando existir:"
    echo "# SMTP_URL=smtps://usuario:senha@smtp.hostinger.com:465"
    echo "# MONITOR_TOKEN_SHA256 (hash do token do /api/saude/detalhada): gerado por implantar.sh token-monitor."
  } >"$APP_ENV.novo"
  mv "$APP_ENV.novo" "$APP_ENV"
  ok "gerado (JWT_SEGREDO, JWT_SEGREDO_PLATAFORMA, CHAVE_MESTRA; valores não exibidos)"
fi

passo "3/5 Permissões"
chmod 700 "$SEGREDOS"
chmod 600 "$GOOGLE_ENV" "$APP_ENV"
chown root:root "$SEGREDOS" "$GOOGLE_ENV" "$APP_ENV"
chown root:"$UID_PROXY" "$CONTA_SERVICO"
chmod 640 "$CONTA_SERVICO"
ok "$SEGREDOS 700; *.env 600; gcp-conta-servico.json 640 (grupo $UID_PROXY, o usuário do Cloud SQL Auth Proxy)"

passo "4/5 Arquivos de configuração em $PASTA"
umask 022
mkdir -p "$PASTA/releases"
if [ -f "$PASTA/.env" ]; then
  ok ".env já existia; mantido"
else
  [ -f "$AQUI/compose.env.exemplo" ] || erro "modelo compose.env.exemplo não encontrado ao lado do instalar.sh."
  INSTANCIA=$(valor "$GOOGLE_ENV" CLOUDSQL_INSTANCIA)
  sed -e "s|^CLOUDSQL_INSTANCIA=.*|CLOUDSQL_INSTANCIA=$INSTANCIA|" \
    -e "s|^REDE_PROXY=.*|REDE_PROXY=$REDE|" \
    -e "s|^GENESIS_SEGREDOS=.*|GENESIS_SEGREDOS=$SEGREDOS|" \
    "$AQUI/compose.env.exemplo" >"$PASTA/.env"
  ok ".env criado (instância do Cloud SQL do bloco do Cloud Shell e a rede do Traefik; confira em $PASTA/.env)"
fi
if [ -f "$PASTA/genesis.env" ]; then
  ok "genesis.env já existia; mantido"
else
  [ -f "$AQUI/genesis.env.exemplo" ] || erro "modelo genesis.env.exemplo não encontrado ao lado do instalar.sh."
  cp "$AQUI/genesis.env.exemplo" "$PASTA/genesis.env"
  ok "genesis.env criado a partir do modelo (confira os domínios em CORS_ORIGENS e ERP_URL)"
fi

passo "5/5 Pasta da página de download ($PASTA/download/pdv)"
# download/ (root 755) guarda o pdv/, montado só leitura no genesis-web, e os temporários do `implantar.sh pdv
# publicar` (.recebendo.*, root 700, fora da montagem e no mesmo disco: a troca é um `mv`, nunca um arquivo pela
# metade). Rodar de novo devolve as permissões, sem apagar nada.
mkdir -p "$PASTA/download/pdv"
chown root:root "$PASTA/download"
chmod 755 "$PASTA/download"
chown -R root:"$GID_NGINX" "$PASTA/download/pdv"
chmod 750 "$PASTA/download/pdv"
find "$PASTA/download/pdv" -mindepth 1 -type f -exec chmod 640 {} +
if [ -s "$PASTA/download/pdv/atual.json" ]; then
  ok "instalador publicado: $(sed -n 's/^ *"arquivo": *"\([^"]*\)".*/\1/p' "$PASTA/download/pdv/atual.json")"
else
  ok "pasta pronta (ainda sem instalador: a Implantação publica o último GitHub Release do PDV)"
fi

if ! grep -q '^MONITOR_TOKEN_SHA256=.' "$APP_ENV"; then
  aviso "sem token de monitoramento: o /api/saude/detalhada responde 401. Depois da implantação, no terminal da VPS: $PASTA/implantar.sh token-monitor (README › Monitoramento)."
fi

printf '\n\033[1;32mVPS pronta para o Genesis.\033[0m Próximo passo: implantar (README › Passo 5).\n'
