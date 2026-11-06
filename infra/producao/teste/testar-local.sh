#!/usr/bin/env bash
# Teste local da stack de produção (Implantação do piloto, I1 e I1b; README de infra/producao › Teste local).
# Sobe o docker-compose.yml de produção SEM mudança, mais o override docker-compose.teste.yml (PostgreSQL 18 no lugar
# do proxy do Cloud SQL, com o usuário `genesis` só com CREATEDB/CREATEROLE como no Cloud SQL, e um Traefik v3
# local), e passa pelos mesmos scripts da VPS: instalar.sh (gera os segredos da aplicação) e implantar.sh (migrações
# no container de tarefa, `up --wait`, registro de versão, volta atrás). Depois cria um admin da plataforma e uma
# empresa de teste com os CLIs e confere pelo Traefik: /saude da API nos dois domínios, o ERP (SPA), o download (a
# página e a publicação do instalador do PDV com `implantar.sh pdv publicar`), o
# /sync roteado, o login no ERP com o cookie Secure e os limites de memória (a soma do compose de produção, com o
# backup e o container de tarefa, dentro dos 2,5 GB, e o pico de uma tarefa, do backup e do Cloud SQL Auth Proxy).
# I1b: backup lógico (genesis-backup) para um S3 local, o token de monitoramento e o /api/saude/detalhada, e o
# ensaio de desastre: o PostgreSQL é trocado por um vazio, tudo é restaurado do bucket, as contagens de linhas e a
# colação conferem com as de antes, e o ERP volta a entrar.
#
# Como root (sudo), como o instalar.sh na VPS: ele exige root e põe a chave da conta de serviço no grupo 65532.
#
#   sudo infra/producao/teste/testar-local.sh [--sem-build] [--manter]
#     --sem-build  usa as imagens genesis-api, genesis-web e genesis-backup :teste-local já existentes
#     --manter     não derruba a stack no fim (para olhar; derrube depois com o comando que o script imprime)
# Variáveis: TESTE_IMAGEM_NODE e TESTE_IMAGEM_ALPINE (imagens base do build, ex.: com a CA de um proxy
#            corporativo), TESTE_BUILD_OPCOES (opções extras do `docker build`, ex.:
#            "--network host --build-arg https_proxy=http://127.0.0.1:3128" para o `apk add` do backup atrás de um
#            proxy), TESTE_PORTA_HTTPS (padrão 18443).
# Tudo é criado numa pasta temporária, com senhas geradas na hora e nunca impressas; no fim, containers, rede,
# volumes, imagens de teste e a pasta são removidos.
set -euo pipefail

RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
PRODUCAO=$RAIZ/infra/producao
TESTE=$PRODUCAO/teste
VERSAO_A=teste-local
VERSAO_B=teste-local-b
REDE=genesis-teste-proxy
PROJETO=genesis-teste
export TESTE_PORTA_HTTPS=${TESTE_PORTA_HTTPS:-18443}
BUILD=1
MANTER=0
for arg in "$@"; do
  case "$arg" in
    --sem-build) BUILD=0 ;;
    --manter) MANTER=1 ;;
    *)
      echo "uso: $0 [--sem-build] [--manter]" >&2
      exit 2
      ;;
  esac
done

passo() { printf '\n\033[1;35m### %s\033[0m\n' "$*"; }
falha() {
  printf '\033[1;31mFALHOU: %s\033[0m\n' "$*" >&2
  exit 1
}
confere() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || falha "rode como root (sudo $0): o instalar.sh exige root e põe a chave da conta de serviço no grupo 65532 (chown)."

T=$(mktemp -d "${TMPDIR:-/tmp}/genesis-teste-stack.XXXXXX")
chmod 755 "$T"
export GENESIS_PASTA=$T
export GENESIS_COMPOSE_EXTRA=$TESTE/docker-compose.teste.yml
export COMPOSE_PROJECT_NAME=$PROJETO
export TESTE_INITDB=$TESTE/initdb
TESTE_SENHA_POSTGRES=$(openssl rand -hex 16)
# A senha do `genesis` tem `+`, `+` codificado (%2B) e `\` no DATABASE_URL, como uma senha em base64: a API (o
# pg-connection-string, só decodeURIComponent) e o backup (decodificar_url) têm de chegar à mesma senha, senão um dos
# dois não autentica. No banco ela é <hex>+x+y\z; no DATABASE_URL, <hex>+x%2By\z.
SENHA_GENESIS_HEX=$(openssl rand -hex 12)
TESTE_SENHA_GENESIS="$SENHA_GENESIS_HEX+x+y\z"
SENHA_GENESIS_URL="$SENHA_GENESIS_HEX+x%2By\z"
TESTE_SENHA_ARMAZENAMENTO=$(openssl rand -hex 16)
export TESTE_SENHA_POSTGRES TESTE_SENHA_GENESIS TESTE_SENHA_ARMAZENAMENTO

compose_teste() {
  GENESIS_VERSAO=${VERSAO_ATUAL:-$VERSAO_A} docker compose --project-directory "$T" \
    -f "$T/releases/${VERSAO_ATUAL:-$VERSAO_A}/docker-compose.yml" -f "$GENESIS_COMPOSE_EXTRA" "$@"
}

limpar() {
  local codigo=$?
  if [ "$MANTER" = 1 ]; then
    echo
    echo "Stack mantida em $T. Para derrubar:"
    echo "  COMPOSE_PROJECT_NAME=$PROJETO GENESIS_VERSAO=$VERSAO_A TESTE_SENHA_POSTGRES=x TESTE_SENHA_GENESIS=x TESTE_SENHA_ARMAZENAMENTO=x TESTE_INITDB=$TESTE_INITDB \\"
    echo "    docker compose --project-directory $T -f $T/releases/$VERSAO_A/docker-compose.yml -f $GENESIS_COMPOSE_EXTRA --profile tarefa down -v --remove-orphans"
    echo "  docker network rm $REDE; rm -rf $T"
    exit $codigo
  fi
  passo "Limpeza"
  compose_teste --profile tarefa down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f genesis-teste-proxy-real >/dev/null 2>&1 || true
  docker network rm genesis-teste-proxy-real >/dev/null 2>&1 || true
  docker network rm "$REDE" >/dev/null 2>&1 || true
  if [ "$BUILD" = 1 ]; then
    docker image rm "genesis-api:$VERSAO_A" "genesis-web:$VERSAO_A" "genesis-backup:$VERSAO_A" >/dev/null 2>&1 || true
  fi
  docker image rm "genesis-api:$VERSAO_B" "genesis-web:$VERSAO_B" "genesis-backup:$VERSAO_B" >/dev/null 2>&1 || true
  rm -rf "$T"
  echo "containers, rede, volumes, imagens de teste e $T removidos"
  exit $codigo
}
trap limpar EXIT

if [ "$BUILD" = 1 ]; then
  passo "Build das imagens"
  args=()
  # Opções extras em palavras separadas por espaço (sem aspas dentro).
  # shellcheck disable=SC2206
  [ -n "${TESTE_BUILD_OPCOES:-}" ] && args+=($TESTE_BUILD_OPCOES)
  args_node=("${args[@]}")
  [ -n "${TESTE_IMAGEM_NODE:-}" ] && args_node+=(--build-arg "IMAGEM_NODE=$TESTE_IMAGEM_NODE")
  args_alpine=("${args[@]}")
  [ -n "${TESTE_IMAGEM_ALPINE:-}" ] && args_alpine+=(--build-arg "IMAGEM_ALPINE=$TESTE_IMAGEM_ALPINE")
  docker build -q -f "$RAIZ/apps/api/Dockerfile" --build-arg VERSAO=$VERSAO_A "${args_node[@]}" -t "genesis-api:$VERSAO_A" "$RAIZ"
  docker build -q -f "$RAIZ/apps/erp-web/Dockerfile" --build-arg VERSAO=$VERSAO_A "${args_node[@]}" -t "genesis-web:$VERSAO_A" "$RAIZ"
  docker build -q -f "$PRODUCAO/backup/Dockerfile" --build-arg VERSAO=$VERSAO_A "${args_alpine[@]}" -t "genesis-backup:$VERSAO_A" "$PRODUCAO/backup"
fi

passo "VPS simulada em $T"
docker network inspect "$REDE" >/dev/null 2>&1 || docker network create "$REDE" >/dev/null
mkdir -p "$T/segredos"
# Os segredos do Google (gerados pelo Cloud Shell na VPS real) com valores de teste; o bucket é o S3 local do override.
cat >"$T/segredos/genesis-google.env" <<EOF
CLOUDSQL_INSTANCIA=projeto-teste:southamerica-east1:genesis-teste
DATABASE_URL=postgres://genesis:$SENHA_GENESIS_URL@genesis-cloudsql-proxy:5432/genesis_control
ARMAZENAMENTO_ENDPOINT=http://genesis-armazenamento-teste:9000
ARMAZENAMENTO_REGIAO=us-east-1
ARMAZENAMENTO_BUCKET=genesis-teste
ARMAZENAMENTO_CHAVE_ACESSO=teste
ARMAZENAMENTO_CHAVE_SECRETA=$TESTE_SENHA_ARMAZENAMENTO
ARMAZENAMENTO_CAMINHO=true
EOF
echo '{"type": "service_account", "observacao": "arquivo de teste, sem chave"}' >"$T/segredos/gcp-conta-servico.json"
# O que o workflow envia para releases/<versao>.
for v in $VERSAO_A $VERSAO_B; do
  mkdir -p "$T/releases/$v"
  cp "$PRODUCAO"/{docker-compose.yml,implantar.sh,instalar.sh,compose.env.exemplo,genesis.env.exemplo} "$T/releases/$v/"
done

passo "instalar.sh (duas vezes: a segunda não pode trocar nenhum segredo)"
REDE_PROXY=$REDE bash "$T/releases/$VERSAO_A/instalar.sh"
hash_antes=$(sha256sum "$T/segredos/genesis-app.env")
REDE_PROXY=$REDE bash "$T/releases/$VERSAO_A/instalar.sh" >/dev/null
[ "$(sha256sum "$T/segredos/genesis-app.env")" = "$hash_antes" ] || falha "o instalar.sh trocou o genesis-app.env"
[ "$(stat -c %a "$T/segredos")" = 700 ] || falha "pasta de segredos sem 700"
[ "$(stat -c %a "$T/segredos/genesis-app.env")" = 600 ] || falha "genesis-app.env sem 600"
[ "$(stat -c %a:%g "$T/segredos/gcp-conta-servico.json")" = 640:65532 ] || falha "chave da conta de serviço sem 640 e grupo 65532"
[ "$(stat -c %a:%U:%g "$T/download/pdv")" = 750:root:101 ] || falha "pasta download/pdv sem root:101 750 (o nginx, uid 101, só lê)"
grep -q '^CLOUDSQL_INSTANCIA=projeto-teste:southamerica-east1:genesis-teste$' "$T/.env" || falha ".env sem a instância"
confere "segredos gerados uma vez, permissões e .env"

passo "docker compose config (produção sem override)"
GENESIS_VERSAO=$VERSAO_A docker compose --project-directory "$T" -f "$T/releases/$VERSAO_A/docker-compose.yml" config -q
confere "compose de produção válido"

passo "S3 local (no lugar do bucket do GCS)"
compose_teste up -d genesis-armazenamento-teste >/dev/null 2>&1 || falha "S3 local não subiu"
# O bucket já existe no GCS; aqui é criado com a mesma assinatura que o backup usa (curl --aws-sigv4).
docker run --rm --network genesis-interna --env-file "$T/segredos/genesis-google.env" --entrypoint bash \
  "genesis-backup:$VERSAO_A" -c '
    printf "user = \"%s:%s\"\n" "$ARMAZENAMENTO_CHAVE_ACESSO" "$ARMAZENAMENTO_CHAVE_SECRETA" >/tmp/c
    for _ in $(seq 1 30); do
      curl -sf -o /dev/null -K /tmp/c --aws-sigv4 "aws:amz:$ARMAZENAMENTO_REGIAO:s3" -X PUT \
        "$ARMAZENAMENTO_ENDPOINT/$ARMAZENAMENTO_BUCKET" && exit 0
      sleep 1
    done
    exit 1' || falha "bucket de teste não foi criado no S3 local"
# Com versionamento, como o bucket do GCS (o configurar-genesis.sh liga `--versioning`): a retenção tem de apagar as
# versões, não só deixá-las como versões antigas.
docker run --rm --network genesis-interna --env-file "$T/segredos/genesis-google.env" --entrypoint bash \
  "genesis-backup:$VERSAO_A" -c '
    source /usr/local/bin/genesis-backup && preparar_bucket
    printf "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Status>Enabled</Status></VersioningConfiguration>" >/tmp/v
    s3 PUT "" versioning= -T /tmp/v -o /dev/null && s3 GET "" versioning= | grep -q "<Status>Enabled</Status>"' ||
  falha "versionamento do bucket de teste"
confere "bucket genesis-teste no S3 local, com versionamento (como o do GCS)"

passo "implantar.sh implantar $VERSAO_A"
bash "$T/releases/$VERSAO_A/implantar.sh" implantar "$VERSAO_A"
VERSAO_ATUAL=$VERSAO_A
compose_teste up -d traefik-teste >/dev/null
[ "$(docker inspect -f '{{.State.Health.Status}}' genesis-backup)" = healthy ] || falha "genesis-backup sem healthy"
confere "genesis-backup no ar (healthy), agendado às 04:30 de Brasília"

passo "CLIs no container de tarefa"
SENHA_ADMIN=$(openssl rand -hex 12)
printf '%s\n' "$SENHA_ADMIN" | bash "$T/releases/$VERSAO_A/implantar.sh" tarefa admin-criar \
  --email admin.teste@genesis.invalid --nome 'Admin Teste' --senha-stdin | grep -v -i 'segredo\|otpauth'
SAIDA_EMPRESA=$(bash "$T/releases/$VERSAO_A/implantar.sh" tarefa empresa-criar \
  --razao-social 'Empresa Teste Implantacao Ltda' --cnpj 11222333000181)
echo "$SAIDA_EMPRESA" | grep -v -i senha
CODIGO=$(echo "$SAIDA_EMPRESA" | sed -n 's/^Empresa criada: código \([0-9]*\).*/\1/p')
SENHA_EMPRESA=$(echo "$SAIDA_EMPRESA" | sed -n 's/^Senha provisória.*: \(.*\)$/\1/p')
[ -n "$CODIGO" ] && [ -n "$SENHA_EMPRESA" ] || falha "empresa-criar não devolveu código e senha provisória"
bash "$T/releases/$VERSAO_A/implantar.sh" tarefa migrar-empresas || falha "migrar-empresas com a empresa criada"
confere "admin da plataforma e empresa $CODIGO criados; migrar-empresas de novo sem falha"

passo "Pelo Traefik (https://127.0.0.1:$TESTE_PORTA_HTTPS com os domínios de produção)"
dominio() { sed -n "s/^$1=//p" "$T/.env"; }
ERP=$(dominio ERP_DOMINIO)
API=$(dominio API_DOMINIO)
DOWNLOAD=$(dominio DOWNLOAD_DOMINIO)
req() {
  local host=$1
  shift
  curl -sS -k --noproxy '*' --max-time 10 --resolve "$host:$TESTE_PORTA_HTTPS:127.0.0.1" "$@"
}
url() { echo "https://$1:$TESTE_PORTA_HTTPS$2"; }
# O Traefik leva alguns segundos para ler os labels.
for _ in $(seq 1 30); do
  [ "$(req "$API" -o /dev/null -w '%{http_code}' "$(url "$API" /saude)" || true)" = 200 ] && break
  timeout 1 tail -f /dev/null || true
done
req "$API" "$(url "$API" /saude)" | grep -q '"status":"ok"' || falha "api: /saude"
req "$API" "$(url "$API" /saude)" | grep -q '"ambiente":"producao"' || falha "api: ambiente diferente de producao"
confere "$API/saude: ok, ambiente producao"
req "$ERP" "$(url "$ERP" /saude)" | grep -q '"banco_controle":"ok"' || falha "erp: /saude não foi para a API"
confere "$ERP/saude vai para a API"
req "$ERP" "$(url "$ERP" /)" | grep -q '<title>GenesisPDV · ERP</title>' || falha "erp: index"
req "$ERP" "$(url "$ERP" /vendas/consulta)" | grep -q '<div id="root">' || falha "erp: rota do SPA sem index.html"
req "$ERP" -D - -o /dev/null "$(url "$ERP" /)" | grep -qi '^strict-transport-security' || falha "erp: sem HSTS"
confere "$ERP: SPA servido (rotas caem no index.html), com HSTS"
req "$DOWNLOAD" "$(url "$DOWNLOAD" /)" | grep -q 'instalador do caixa ainda não foi publicado' || falha "download"
req "$DOWNLOAD" -D - -o /dev/null "$(url "$DOWNLOAD" /)" | grep -qi "^content-security-policy: default-src 'none'" ||
  falha "download: sem a CSP"
[ "$(req "$DOWNLOAD" -o /dev/null -w '%{http_code}' "$(url "$DOWNLOAD" /pdv/atual.json)")" = 404 ] ||
  falha "download: /pdv/atual.json deveria ser 404 sem instalador publicado"
confere "$DOWNLOAD: página com CSP; sem instalador publicado, /pdv/atual.json 404 (a página diz que não foi publicado)"

passo "Página de download do PDV (implantar.sh pdv publicar, com instaladores de mentira)"
mkdir -p "$T/pdv-teste"
# Publica a versão $1 com um "instalador" de 3 MiB aleatórios e o .sha256 no formato do gerar-instalador.ps1.
publicar_pdv() {
  local exe="GenesisPDV-Setup-$1.exe"
  head -c 3145728 /dev/urandom >"$T/pdv-teste/$exe"
  (cd "$T/pdv-teste" && sha256sum "$exe" >"$exe.sha256")
  tar -C "$T/pdv-teste" -cf - "$exe" "$exe.sha256" |
    bash "$T/releases/$VERSAO_A/implantar.sh" pdv publicar "$1" 2026-11-04T12:00:00Z
}
publicar_pdv 0.0.1 >/dev/null
sha1=$(cut -d' ' -f1 "$T/pdv-teste/GenesisPDV-Setup-0.0.1.exe.sha256")
atual=$(req "$DOWNLOAD" "$(url "$DOWNLOAD" /pdv/atual.json)")
grep -q '"versao": "0.0.1"' <<<"$atual" && grep -q "\"sha256\": \"$sha1\"" <<<"$atual" &&
  grep -q '"tamanho_bytes": 3145728' <<<"$atual" || falha "download: atual.json inesperado: $atual"
cabecalhos=$(req "$DOWNLOAD" -D - -o "$T/pdv-teste/baixado.exe" "$(url "$DOWNLOAD" /pdv/GenesisPDV-Setup-0.0.1.exe)")
[ "$(sha256sum "$T/pdv-teste/baixado.exe" | cut -d' ' -f1)" = "$sha1" ] || falha "download: instalador baixado diferente"
grep -qi '^content-disposition: attachment; filename="GenesisPDV-Setup-0.0.1.exe"' <<<"$cabecalhos" ||
  falha "download: instalador sem Content-Disposition attachment"
req "$DOWNLOAD" "$(url "$DOWNLOAD" /pdv/GenesisPDV-Setup-0.0.1.exe.sha256)" | grep -q "^$sha1  GenesisPDV-Setup-0.0.1.exe$" ||
  falha "download: .sha256 não servido"
[ "$(bash "$T/releases/$VERSAO_A/implantar.sh" pdv atual)" = "$sha1" ] || falha "implantar.sh pdv atual sem o sha256 publicado"
[ "$(stat -c %a:%g "$T/download/pdv/atual.json")" = 640:101 ] || falha "atual.json sem 640 e grupo 101"
confere "instalador 0.0.1 publicado: atual.json, download inteiro (attachment) e .sha256; pdv atual devolve o sha256"
# Um .sha256 que não confere é recusado e a página continua na versão publicada.
cp "$T/pdv-teste/GenesisPDV-Setup-0.0.1.exe" "$T/pdv-teste/GenesisPDV-Setup-0.0.9.exe"
echo "$(printf '0%.0s' $(seq 1 64))  GenesisPDV-Setup-0.0.9.exe" >"$T/pdv-teste/GenesisPDV-Setup-0.0.9.exe.sha256"
if tar -C "$T/pdv-teste" -cf - GenesisPDV-Setup-0.0.9.exe GenesisPDV-Setup-0.0.9.exe.sha256 |
  bash "$T/releases/$VERSAO_A/implantar.sh" pdv publicar 0.0.9 2026-11-04T12:00:00Z 2>/dev/null; then
  falha "pdv publicar aceitou um sha256 que não confere"
fi
req "$DOWNLOAD" "$(url "$DOWNLOAD" /pdv/atual.json)" | grep -q '"versao": "0.0.1"' || falha "download: a recusa mexeu no atual.json"
[ ! -e "$T/download/pdv/GenesisPDV-Setup-0.0.9.exe" ] || falha "pdv publicar deixou o instalador recusado na pasta"
[ -z "$(find "$T/download" -maxdepth 1 -name '.recebendo.*')" ] || falha "pdv publicar deixou temporários"
confere "sha256 que não confere: recusado, página intacta, sem temporários"
# Uma versão nova guarda a anterior; a seguinte apaga a mais velha.
publicar_pdv 0.0.2 >/dev/null
publicar_pdv 0.0.3 >/dev/null
req "$DOWNLOAD" "$(url "$DOWNLOAD" /pdv/atual.json)" | grep -q '"versao": "0.0.3"' || falha "download: atual.json sem a 0.0.3"
[ -f "$T/download/pdv/GenesisPDV-Setup-0.0.2.exe" ] && [ ! -e "$T/download/pdv/GenesisPDV-Setup-0.0.1.exe" ] &&
  [ ! -e "$T/download/pdv/GenesisPDV-Setup-0.0.1.exe.sha256" ] || falha "download: retenção (atual e anterior) errada"
[ "$(req "$DOWNLOAD" -o /dev/null -w '%{http_code}' "$(url "$DOWNLOAD" /pdv/outro.txt)")" = 404 ] ||
  falha "download: nome fora do padrão em /pdv/ deveria ser 404"
confere "versões novas: guarda a anterior, apaga as mais velhas; outros nomes em /pdv/ são 404"
# .sha256 com mais de uma linha é recusado (o formato do gerar-instalador.ps1 é uma linha só).
cp "$T/pdv-teste/GenesisPDV-Setup-0.0.3.exe" "$T/pdv-teste/GenesisPDV-Setup-0.0.8.exe"
(cd "$T/pdv-teste" && sha256sum GenesisPDV-Setup-0.0.8.exe GenesisPDV-Setup-0.0.3.exe >GenesisPDV-Setup-0.0.8.exe.sha256)
if tar -C "$T/pdv-teste" -cf - GenesisPDV-Setup-0.0.8.exe GenesisPDV-Setup-0.0.8.exe.sha256 |
  bash "$T/releases/$VERSAO_A/implantar.sh" pdv publicar 0.0.8 2026-11-04T12:00:00Z 2>/dev/null; then
  falha "pdv publicar aceitou um .sha256 com duas linhas"
fi
# Voltar para uma versão menor (a 0.0.3 tirada do GitHub): a 0.0.3 sai da pasta, não fica como anterior.
publicar_pdv 0.0.2 >/dev/null
req "$DOWNLOAD" "$(url "$DOWNLOAD" /pdv/atual.json)" | grep -q '"versao": "0.0.2"' || falha "download: atual.json sem a 0.0.2"
[ ! -e "$T/download/pdv/GenesisPDV-Setup-0.0.3.exe" ] || falha "download: o instalador retirado (0.0.3) ficou na pasta"
# Nenhum release publicado: pdv retirar esvazia a página (atual.json 404), e de novo não faz nada.
bash "$T/releases/$VERSAO_A/implantar.sh" pdv retirar >/dev/null
[ "$(req "$DOWNLOAD" -o /dev/null -w '%{http_code}' "$(url "$DOWNLOAD" /pdv/atual.json)")" = 404 ] ||
  falha "download: /pdv/atual.json deveria ser 404 depois do pdv retirar"
[ -z "$(find "$T/download/pdv" -name 'GenesisPDV-Setup-*')" ] || falha "pdv retirar deixou instaladores"
[ -z "$(bash "$T/releases/$VERSAO_A/implantar.sh" pdv atual)" ] || falha "pdv atual depois do retirar deveria vir vazio"
bash "$T/releases/$VERSAO_A/implantar.sh" pdv retirar >/dev/null || falha "pdv retirar sem nada publicado deveria passar"
req "$DOWNLOAD" "$(url "$DOWNLOAD" /)" | grep -q 'pagina.js' || falha "download: página fora do ar depois do retirar"
confere ".sha256 de duas linhas recusado; versão menor apaga a retirada; pdv retirar volta a página para \"não publicado\""
sync=$(req "$API" -o /dev/null -w '%{http_code} %{content_type}' "$(url "$API" /sync/estado)")
[[ $sync =~ ^4[0-9][0-9]\ application/json ]] || falha "api: /sync/estado sem credenciais deveria ser recusado pela API (veio: $sync)"
[ "$(req "$ERP" -o /dev/null -w '%{http_code}' "$(url "$ERP" /sync/estado)")" = 200 ] || falha "erp: /sync não deveria ir para a API"
confere "/sync/* só no domínio da API"
resposta=$(req "$ERP" -D "$T/cabecalhos" -H 'Content-Type: application/json' \
  -d "{\"codigoEmpresa\":$CODIGO,\"login\":\"admin\",\"senha\":\"$SENHA_EMPRESA\"}" "$(url "$ERP" /api/auth/login)")
echo "$resposta" | grep -q '"senhaProvisoria":true' || falha "login no ERP: $(echo "$resposta" | head -c 300)"
grep -i '^set-cookie:' "$T/cabecalhos" | grep -i 'secure' | grep -qi 'samesite=strict' || falha "cookie de refresh sem Secure/SameSite=Strict"
confere "login no ERP pela origem do ERP (senha provisória), cookie Secure + SameSite=Strict"

passo "Backup lógico (I1b): genesis-backup agora, listar e estado"
bkp() { bash "$T/releases/$VERSAO_A/implantar.sh" backup "$@"; }
bkp agora || falha "backup agora"
DIA=$(docker exec genesis-backup date +%F)
bkp listar | grep -q "^$DIA  ok  2 banco(s)" || falha "backup listar sem o dia $DIA com 2 bancos: $(bkp listar)"
bkp listar "$DIA" | grep -q "^genesis_emp_$CODIGO " || falha "o dia $DIA não tem o genesis_emp_$CODIGO"
bkp estado | grep -q '^último backup: ok' || falha "backup estado: $(bkp estado)"
pico_backup=$(docker exec genesis-backup sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes')
[ "$pico_backup" -lt $((64 * 1048576)) ] || falha "pico do backup $((pico_backup / 1048576)) MiB (limite 64 MiB)"
docker inspect -f '{{.Config.User}}' genesis-backup | grep -qx postgres || falha "backup não roda como postgres"
confere "backup do dia $DIA no bucket (genesis_control + genesis_emp_$CODIGO), pico $((pico_backup / 1048576)) MiB (limite 64 MiB), usuário postgres"
confere "senha do genesis com '+', %2B e '\\' no DATABASE_URL: a API (migrações, empresa-criar) e o pg_dump do backup autenticam com a mesma"
# As funções do script no próprio container (source = só as funções), para olhar e mexer no bucket.
bib() { docker exec -i genesis-backup bash -c "source /usr/local/bin/genesis-backup && preparar_bucket && $1"; }
antigas() { bib "listar_versoes ${1:-backups/}" | awk -F'\t' '$3 != "true"' | grep -c . || true; }
bkp agora >/dev/null || falha "segundo backup agora no mesmo dia"
[ "$(antigas)" = 0 ] || falha "o segundo backup do dia deixou versões antigas: $(bib 'listar_versoes backups/')"
confere "backup agora de novo no mesmo dia: nenhuma versão antiga fica no bucket versionado"
# Retenção: 15 dias antigos falsos (cada um com uma versão antiga) + hoje = 16; ficam os 14 mais recentes.
# shellcheck disable=SC2016 # expande dentro do container.
bib 'printf x >/tmp/x; for d in $(seq -w 1 15); do for _ in 1 2; do enviar /tmp/x backups/2020-01-$d/genesis_control.dump application/octet-stream; done; done'
[ "$(antigas backups/2020-01-01/)" = 1 ] || falha "preparo da retenção: sem versão antiga no dia falso"
bkp agora >"$T/retencao.log" || falha "backup com retenção: $(cat "$T/retencao.log")"
for d in 01 02; do
  [ -z "$(bib "listar_versoes backups/2020-01-$d/")" ] || falha "2020-01-$d ficou no bucket (alguma versão): $(bib "listar_versoes backups/2020-01-$d/")"
done
[ -n "$(bib 'listar_chaves backups/2020-01-03/')" ] || falha "2020-01-03 (o 14º mais recente) foi apagado"
[ "$(antigas)" = 0 ] || falha "versões antigas depois da retenção: $(bib 'listar_versoes backups/' | awk -F'\t' '$3 != "true"')"
grep -q 'apagados agora: 2' "$T/retencao.log" || falha "log da retenção: $(grep retenção "$T/retencao.log")"
# shellcheck disable=SC2016 # expande dentro do container.
bib 'for d in $(seq -w 3 15); do apagar_versoes backups/2020-01-$d/ todas; done'
[ "$(bkp listar | grep -c .)" = 1 ] || falha "dias falsos sobraram: $(bkp listar)"
confere "retenção no bucket versionado: os dias vencidos saem com todas as versões, o 14º mais recente fica, nenhuma versão antiga sobra"
r=0
saida=$(docker exec -e ARMAZENAMENTO_CHAVE_SECRETA=errada genesis-backup genesis-backup estado 2>&1) || r=$?
if [ "$r" = 0 ] || ! grep -q '^bucket indisponível: HTTP 403' <<<"$saida" || grep -q 'nenhum backup' <<<"$saida"; then
  falha "estado com a chave HMAC errada deveria dizer bucket indisponível (saiu $r): $saida"
fi
confere "backup estado com a chave HMAC errada: bucket indisponível (HTTP 403), não \"nenhum backup registrado\""

passo "Token de monitoramento e /api/saude/detalhada (I1b)"
[ "$(req "$API" -o /dev/null -w '%{http_code}' "$(url "$API" /api/saude/detalhada)")" = 401 ] || falha "detalhada sem token deveria ser 401"
bash "$T/releases/$VERSAO_A/implantar.sh" token-monitor >/dev/null 2>&1 && falha "token-monitor sem terminal e sem --arquivo deveria recusar"
# Destino que já existe (644) ou link simbólico: recusa antes de trocar o token.
: >"$T/token-existente"
chmod 644 "$T/token-existente"
ln -s "$T/token-alvo" "$T/token-link"
hash_antes=$(grep '^MONITOR_TOKEN_SHA256=' "$T/segredos/genesis-app.env" || true)
for destino in "$T/token-existente" "$T/token-link"; do
  bash "$T/releases/$VERSAO_A/implantar.sh" token-monitor --arquivo "$destino" >/dev/null 2>&1 &&
    falha "token-monitor --arquivo $destino (já existe) deveria recusar"
done
[ ! -s "$T/token-existente" ] && [ ! -e "$T/token-alvo" ] || falha "o token foi gravado num destino recusado"
[ "$(grep '^MONITOR_TOKEN_SHA256=' "$T/segredos/genesis-app.env" || true)" = "$hash_antes" ] || falha "uma recusa trocou o hash do token"
rm -f "$T/token-existente" "$T/token-link"
bash "$T/releases/$VERSAO_A/implantar.sh" token-monitor --arquivo "$T/token-monitor" >/dev/null || falha "token-monitor --arquivo"
[ "$(stat -c %a "$T/token-monitor")" = 600 ] || falha "arquivo do token sem 600"
grep -q '^MONITOR_TOKEN_SHA256=[0-9a-f]\{64\}$' "$T/segredos/genesis-app.env" || falha "genesis-app.env sem o hash do token"
! grep -qF "$(cat "$T/token-monitor")" "$T/segredos/genesis-app.env" || falha "o token (e não só o hash) foi para o genesis-app.env"
# Logs da API guardados de uma versão ($1) com o motivo ($2) na primeira linha (implantar.sh › guardar_logs_api).
logs_guardados() {
  local f
  for f in "$T/logs"/api-*-"$1".log; do
    [ -e "$f" ] || continue
    if head -n 1 "$f" | grep -qF "antes de: $2"; then echo "$f"; fi
  done
}
detalhada() { req "$1" -H "Authorization: Bearer $(cat "$T/token-monitor")" "$(url "$1" /api/saude/detalhada)"; }
for _ in $(seq 1 30); do
  [ "$(req "$API" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$T/token-monitor")" "$(url "$API" /api/saude/detalhada)" || true)" = 200 ] && break
  timeout 1 tail -f /dev/null || true
done
saude=$(detalhada "$API")
jq -e '.status == "ok" and .banco.status == "ok" and .api.ambiente == "producao" and .api.versao == "teste-local"' <<<"$saude" >/dev/null ||
  falha "detalhada: $(head -c 400 <<<"$saude")"
jq -e --arg dia "$DIA" '.ultimo_backup.status == "ok" and (.ultimo_backup.tamanho_bytes > 0) and .ultimo_backup.ultimo_sucesso_em != null' <<<"$saude" >/dev/null ||
  falha "detalhada sem o último backup: $(jq -c .ultimo_backup <<<"$saude")"
jq -e '.memoria.limite_bytes == 2147483648 and .memoria.usada_bytes > 0 and .terminais == [] and .eventos_fila_decisao == 0' <<<"$saude" >/dev/null ||
  falha "detalhada: memória/terminais: $(jq -c '{memoria, terminais, eventos_fila_decisao}' <<<"$saude")"
# Memória do processo (apps/api/README.md, decisão 166): o teto do heap do V8 vem do --max-old-space-size=1536.
jq -e '.processo.heap_limite_mb >= 1536 and .processo.heap_usado_mb > 0 and .processo.rss_mb > 0 and .processo.no_ar_segundos >= 0' <<<"$saude" >/dev/null ||
  falha "detalhada: processo: $(jq -c .processo <<<"$saude")"
detalhada "$ERP" | jq -e '.status == "ok"' >/dev/null || falha "detalhada pelo domínio do ERP"
token_antigo=$(cat "$T/token-monitor")
rm -f "$T/token-monitor"
bash "$T/releases/$VERSAO_A/implantar.sh" token-monitor --arquivo "$T/token-monitor" >/dev/null || falha "troca do token"
[ "$(req "$API" -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token_antigo" "$(url "$API" /api/saude/detalhada)")" = 401 ] ||
  falha "o token antigo continua valendo depois da troca"
detalhada "$API" | jq -e '.status == "ok"' >/dev/null || falha "o token novo não vale"
[ "$(grep -c '^MONITOR_TOKEN_SHA256=' "$T/segredos/genesis-app.env")" = 1 ] || falha "mais de um MONITOR_TOKEN_SHA256 no genesis-app.env"
# Cada token-monitor recria a API e guarda antes o log dela (decisão 166): dois arquivos de A com o motivo no cabeçalho.
[ "$(logs_guardados "$VERSAO_A" token-monitor | wc -l)" = 2 ] ||
  falha "o token-monitor deveria guardar o log da API antes de recriá-la (um por troca): $(ls -l "$T/logs" 2>&1)"
confere "401 sem token; --arquivo só num arquivo novo (já existente ou link: recusa sem trocar o token); token só como hash no genesis-app.env; 200 nos dois domínios com o último backup, a memória do container (2 GiB) e a troca do token"

passo "Ensaio de desastre: PostgreSQL vazio, restauração do bucket e o ERP de volta"
pg() { docker exec -i genesis-cloudsql-proxy psql -U postgres -v ON_ERROR_STOP=1 -Atq "$@"; }
GERADOR="select string_agg(format('select %L, count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' union all ' order by n.nspname, c.relname) || ';' from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'"
retrato() { # banco: contagem de linhas de todas as tabelas + codificação e locale do banco
  pg -d "$1" -c "$GERADOR" | pg -d "$1" | sort
  pg -d postgres -c "select datname, pg_encoding_to_char(encoding), datlocprovider, datlocale, datcollate from pg_database where datname = '$1'"
}
EMPRESA_BANCO=genesis_emp_$CODIGO
# API parada: nada muda entre o backup e o retrato.
docker stop genesis-api >/dev/null
bkp agora >/dev/null || falha "backup com a API parada"
retrato genesis_control >"$T/antes-controle"
retrato "$EMPRESA_BANCO" >"$T/antes-empresa"
[ "$(grep -c . "$T/antes-empresa")" -gt 50 ] || falha "retrato da empresa pequeno demais"
compose_teste rm -sf genesis-cloudsql-proxy >/dev/null 2>&1
compose_teste up -d --wait --wait-timeout 120 genesis-cloudsql-proxy >/dev/null
[ "$(pg -d postgres -c "select count(*) from pg_database where datname like 'genesis%'")" = 0 ] || falha "o PostgreSQL novo não está vazio"
bkp restaurar "$DIA" todos || falha "restaurar todos"
retrato genesis_control >"$T/depois-controle"
retrato "$EMPRESA_BANCO" >"$T/depois-empresa"
diff -u "$T/antes-controle" "$T/depois-controle" || falha "genesis_control restaurado difere do original"
diff -u "$T/antes-empresa" "$T/depois-empresa" || falha "$EMPRESA_BANCO restaurado difere do original"
bkp restaurar "$DIA" "$EMPRESA_BANCO" >/dev/null 2>&1 && falha "restaurar por cima de um banco existente deveria recusar"
bkp restaurar "$DIA" "$EMPRESA_BANCO" --como "${EMPRESA_BANCO}_copia" >/dev/null || falha "restaurar --como"
# Conferida pelo `backup psql` (o mesmo que o README manda usar no ensaio da VPS).
[ "$(bkp psql "${EMPRESA_BANCO}_copia" -Atc 'select count(*) from usuarios')" = "$(pg -d "$EMPRESA_BANCO" -c 'select count(*) from usuarios')" ] ||
  falha "cópia restaurada com --como difere"
bkp psql postgres -qc "drop database ${EMPRESA_BANCO}_copia" >/dev/null || falha "backup psql: drop database da cópia"
bash "$T/releases/$VERSAO_A/implantar.sh" tarefa migrar-empresas >/dev/null || falha "migrar-empresas depois da restauração"
compose_teste up -d --wait --wait-timeout 120 genesis-api >/dev/null || falha "API não voltou depois da restauração"
resposta=$(req "$ERP" -H 'Content-Type: application/json' \
  -d "{\"codigoEmpresa\":$CODIGO,\"login\":\"admin\",\"senha\":\"$SENHA_EMPRESA\"}" "$(url "$ERP" /api/auth/login)")
echo "$resposta" | grep -q '"senhaProvisoria":true' || falha "login no ERP depois da restauração: $(echo "$resposta" | head -c 300)"
confere "servidor vazio → restaurar todos: contagens de linhas e colação iguais às de antes; por cima recusa; --como restaura ao lado; migrar-empresas recria a role de runtime e o ERP entra"

passo "Pico do Cloud SQL Auth Proxy real (192 MiB no compose; sem o Google, só a subida e conexões recusadas)"
docker network create genesis-teste-proxy-real >/dev/null
openssl genrsa 2048 2>/dev/null | jq -Rs '{type: "service_account", project_id: "projeto-teste", private_key_id: "0", private_key: ., client_email: "teste@projeto-teste.iam.gserviceaccount.com", token_uri: "https://oauth2.invalid/token"}' >"$T/conta-servico-falsa.json"
chmod 644 "$T/conta-servico-falsa.json"
imagem_proxy=$(sed -n 's/^ *image: \(gcr.io\/cloud-sql-connectors\/cloud-sql-proxy:.*\)$/\1/p' "$PRODUCAO/docker-compose.yml")
docker run -d --name genesis-teste-proxy-real --network genesis-teste-proxy-real --memory 192m --memory-swap 192m \
  --read-only -v "$T/conta-servico-falsa.json:/segredos/k.json:ro" \
  -e CSQL_PROXY_INSTANCE_CONNECTION_NAME=projeto-teste:southamerica-east1:genesis-teste "$imagem_proxy" \
  --address=0.0.0.0 --port=5432 --credentials-file=/segredos/k.json --structured-logs >/dev/null
for _ in 1 2 3 4 5; do
  docker run --rm --network genesis-teste-proxy-real -e PGCONNECT_TIMEOUT=10 "genesis-backup:$VERSAO_A" \
    psql "host=genesis-teste-proxy-real user=x dbname=y sslmode=disable" -c 'select 1' >/dev/null 2>&1 &
done
wait
pico_proxy=$(docker exec genesis-teste-proxy-real sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes')
docker rm -f genesis-teste-proxy-real >/dev/null
docker network rm genesis-teste-proxy-real >/dev/null
[ "$pico_proxy" -lt $((192 * 1048576)) ] || falha "pico do proxy $((pico_proxy / 1048576)) MiB"
confere "pico do proxy real: $((pico_proxy / 1048576)) MiB (limite 192 MiB; o pico em produção sai no implantar.sh estado)"

passo "Limites de memória (decisão do dono: 2,5 GB somados)"
total=0
for c in genesis-api genesis-web genesis-backup genesis-cloudsql-proxy; do
  m=$(docker inspect -f '{{.HostConfig.Memory}}' "$c")
  printf '  %-24s %5d MiB\n' "$c" $((m / 1048576))
  [ "$c" = genesis-cloudsql-proxy ] || total=$((total + m))
done
[ $((total / 1048576)) = 2240 ] || falha "API + ERP + backup deveriam somar 2240 MiB"
confere "API 2048 MiB + ERP 128 MiB + backup 64 MiB no ar (aqui o PostgreSQL de teste, no lugar do proxy de 192 MiB, usa 512 MiB)"
# O compose de produção sem override, com o perfil da tarefa: ela roda com a API no ar (migrações da implantação,
# implantar.sh tarefa), então a soma de todos os limites tem de caber nos 2,5 GB.
soma=$(GENESIS_VERSAO=$VERSAO_A docker compose --project-directory "$T" -f "$T/releases/$VERSAO_A/docker-compose.yml" \
  --profile tarefa config --format json | grep -o '"mem_limit": *"[0-9]*"' | grep -o '[0-9]*' | awk '{s += $1} END {print s / 1048576}')
[ "$soma" -le 2560 ] || falha "limites do compose de produção, com a tarefa, somam $soma MiB (teto: 2560)"
confere "compose de produção: API 2048 + ERP 128 + proxy 192 + backup 64 + tarefa 128 = $soma MiB (teto 2560 MiB)"
# Pico de memória de uma tarefa (referencias: todas as empresas, referências nacionais e seed) no limite de produção.
pico=$(compose_teste run --rm -T --entrypoint sh genesis-tarefa -c \
  'node dist/cli/referencias.js >/dev/null || exit 1; cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes') ||
  falha "referencias no container de tarefa (limite de 128 MiB)"
confere "pico da tarefa referencias: $((pico / 1048576)) MiB (limite 128 MiB)"
docker inspect -f '{{.Config.User}}' genesis-api | grep -qx node || falha "API não roda como node"
docker inspect -f '{{.Config.User}}' genesis-web | grep -qx 101 || falha "ERP não roda como 101"
confere "API e ERP sem root"

passo "Nova versão ($VERSAO_B) e volta atrás"
docker tag "genesis-api:$VERSAO_A" "genesis-api:$VERSAO_B"
docker tag "genesis-web:$VERSAO_A" "genesis-web:$VERSAO_B"
docker tag "genesis-backup:$VERSAO_A" "genesis-backup:$VERSAO_B"
bash "$T/releases/$VERSAO_B/implantar.sh" implantar "$VERSAO_B" >/dev/null
[ "$(cat "$T/versoes/atual")" = "$VERSAO_B" ] && [ "$(cat "$T/versoes/anterior")" = "$VERSAO_A" ] || falha "registro de versões"
bash "$T/releases/$VERSAO_B/implantar.sh" voltar >/dev/null
[ "$(cat "$T/versoes/atual")" = "$VERSAO_A" ] && [ "$(cat "$T/versoes/anterior")" = "$VERSAO_B" ] || falha "voltar"
grep -q "^GENESIS_VERSAO=$VERSAO_A$" "$T/.env" || falha ".env sem a versão atual"
[ "$(req "$API" -o /dev/null -w '%{http_code}' "$(url "$API" /saude)")" = 200 ] || falha "API fora do ar depois do voltar"
confere "implantar $VERSAO_B → voltar para $VERSAO_A, API respondendo"
# Logs guardados antes de recriar a API: o implantar de B guarda o do container de A, o voltar o de B (com a linha
# "API no ar" do main.ts), pasta 700 e arquivos 600; o `logs` lista sem a trava. Conferidos pelo motivo do cabeçalho:
# o token-monitor também guardou dois de A, e um deles passaria por este.
for par in "$VERSAO_A|implantar $VERSAO_B" "$VERSAO_B|voltar de $VERSAO_B para $VERSAO_A"; do
  v=${par%%|*}
  motivo=${par#*|}
  f=$(logs_guardados "$v" "$motivo")
  [ -n "$f" ] && [ "$(wc -l <<<"$f")" = 1 ] && [ "$(stat -c %a "$f")" = 600 ] ||
    falha "log da API $v antes de '$motivo' não guardado (ou mais de um, ou sem 600): $(ls -l "$T/logs" 2>&1)"
  grep -q '"msg":"API no ar"' "$f" || falha "log guardado de $v sem a linha 'API no ar'"
done
[ "$(find "$T/logs" -maxdepth 1 -name "api-*-$VERSAO_A.log" | wc -l)" = 3 ] ||
  falha "esperava 3 logs de $VERSAO_A (2 do token-monitor e 1 do implantar de $VERSAO_B): $(ls -l "$T/logs" 2>&1)"
[ "$(stat -c %a "$T/logs")" = 700 ] || falha "pasta dos logs sem 700"
# A saída guardada antes do grep: com o pipefail, o `grep -q` que sai na primeira linha mataria o implantar.sh com
# SIGPIPE nas linhas que ele ainda escreve depois.
saida=$(bash "$T/implantar.sh" logs)
grep -q "api-.*-$VERSAO_B.log" <<<"$saida" || falha "implantar.sh logs não lista o log de $VERSAO_B"
confere "logs da API guardados antes de cada troca (implantar.sh logs)"

passo "Bloco do Cloud Shell colado de novo (chave da conta de serviço volta a root:root 600)"
chown root:root "$T/segredos/gcp-conta-servico.json"
chmod 600 "$T/segredos/gcp-conta-servico.json"
saida=$(bash "$T/implantar.sh" estado 2>&1)
grep -q 'ATENÇÃO: .*gcp-conta-servico.json.*instalar.sh' <<<"$saida" || falha "estado não avisou da chave sem 640/65532"
REDE_PROXY=$REDE bash "$T/releases/$VERSAO_A/instalar.sh" >/dev/null
[ "$(stat -c %a:%g "$T/segredos/gcp-conta-servico.json")" = 640:65532 ] || falha "instalar.sh não devolveu 640 e grupo 65532"
saida=$(bash "$T/implantar.sh" estado 2>&1)
! grep -q 'ATENÇÃO' <<<"$saida" || falha "estado ainda avisa depois do instalar.sh"
confere "implantar.sh estado avisa; o instalar.sh devolve root:65532 640"

printf '\n\033[1;32mStack de produção OK localmente.\033[0m\n'
