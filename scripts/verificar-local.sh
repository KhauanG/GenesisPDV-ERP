#!/usr/bin/env bash
# Verificação local completa (OP-B1; D70): reproduz na sessão do Claude Code (ou numa máquina Linux de
# desenvolvimento) todos os jobs da CI (.github/workflows/ci.yml) que rodam em Linux, na ordem e com os mesmos
# comandos, e imprime no fim a tabela job × resultado × tempo (também em .verificacao-local/resumo.md, para colar no
# corpo do PR). Sai com ≠ 0 se algum job falhar. Enquanto não houver cota do GitHub Actions (D70), o script inteiro
# verde é o portão antes de cada PR e de cada merge na `main` (CONTRIBUTING.md › CI).
#
# Uso, de qualquer pasta do repositório (ou `pnpm verificar:local [opções]`):
#   scripts/verificar-local.sh                       # todos os jobs
#   scripts/verificar-local.sh --so ts,imagens       # só estes jobs
#   scripts/verificar-local.sh --pular e2e-sync      # todos menos estes
#   scripts/verificar-local.sh --mudancas origin/main  # só os jobs do que mudou desde a base (como a CI)
#
# Jobs (os nomes da CI; plano: docs/planos/operacao-sem-actions-plano.md › OP-B1):
#   ts               install congelado, formatação, lint, tipos, schemas Drizzle × migrações, Esquema.g.cs do PDV,
#                    testes unitários (shared, API e ERP) e build
#   integracao-pg16  integração da API no PostgreSQL 16 local (o do infra/docker-compose.yml; fora da CI desde a D59)
#   integracao-pg18  integração da API no PostgreSQL 18 (container postgres:18-alpine numa porta livre, removido no
#                    fim mesmo com falha ou Ctrl+C), com as variáveis do job integracao-pg18
#   imagens          build das 3 imagens Docker (sem push), shellcheck, testes do backup, dos logs do implantar.sh e
#                    do implantar-sem-actions.sh e o compose de produção (com o teto somado de 2,5 GB)
#   pdv              PDV no Linux: restore --locked-mode, build Release e testes (os que exigem Windows ficam pulados)
#   pdv-formatacao   dotnet format --verify-no-changes
#   e2e-sync         API local + PDV headless (apps/api/test/e2e-pdv/rodar.sh)
#   scripts          só local: shellcheck de scripts/ e .github/scripts/ e o teste deste script
#
# Não coberto aqui (só o runner Windows faz, até o OP-B3): a impressora de teste do spooler (SpoolerWindowsTests), o
# instalador do Windows e o teste dele (instala, abre, reinstala e desinstala).
#
# Sobe o dockerd (integracao-pg18 e imagens; numa sessão própria, que o Ctrl+C não derruba) e o PostgreSQL 16 local
# (integracao-pg16 e e2e-sync) se não estiverem no ar (como o .claude/hooks/session-start.sh), só para os jobs que
# precisam. Atrás do proxy da sessão (HTTPS_PROXY), as imagens montam com --network host, o proxy nos
# build-args e o certificado do proxy (VERIFICAR_CA, ou o NODE_EXTRA_CA_CERTS/SSL_CERT_FILE do ambiente) numa imagem
# base derivada, passada pelos ARG IMAGEM_NODE/IMAGEM_ALPINE dos Dockerfiles; sem proxy, o build é o mesmo da CI.
# Logs de cada job em .verificacao-local/<job>.log (VERIFICACAO_LOCAL_LOGS muda a pasta).
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ" || exit 2

JOBS=(ts integracao-pg16 integracao-pg18 imagens pdv pdv-formatacao e2e-sync scripts)
declare -A DESCRICAO=(
  [ts]='TypeScript (API, ERP web, shared)'
  [integracao-pg16]='Integração da API (PostgreSQL 16)'
  [integracao-pg18]='Integração da API (PostgreSQL 18)'
  [imagens]='Imagens Docker (API, ERP e backup)'
  [pdv]='PDV (.NET 10) – Linux'
  [pdv-formatacao]='PDV (.NET 10) – formatação'
  [e2e-sync]='E2E PDV ↔ API'
  [scripts]='Scripts da verificação local'
)
# Saída do .github/scripts/mudancas.sh → jobs daqui. O job "scripts" é de segundos e roda sempre.
declare -A SAIDA_MUDANCAS=(
  [ts]=ts [integracao-pg16]=ts [integracao-pg18]=ts [imagens]=imagens
  [pdv]=pdv [pdv-formatacao]=pdv [e2e-sync]=e2e
)

LOGS="${VERIFICACAO_LOCAL_LOGS:-$RAIZ/.verificacao-local}"
MUDANCAS_SH="${VERIFICACAO_LOCAL_MUDANCAS_SH:-$RAIZ/.github/scripts/mudancas.sh}"
URL_PG16="${VERIFICAR_PG16_URL:-postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control}"
IMAGEM_PG18="${VERIFICAR_IMAGEM_PG18:-postgres:18-alpine}"
# As mesmas do job integracao-pg18 (runner compartilhado; a sessão também é).
TETOS_TRAVA=(TETO_TRAVA_VERSAO_MS=100 TETO_TRAVA_CARGA_MS=250)

uso() {
  sed -n '2,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

erro_uso() {
  echo "verificar-local: $1" >&2
  echo "Jobs: ${JOBS[*]}. Ajuda: $0 --ajuda" >&2
  exit 2
}

lista_jobs() {
  local job conhecido
  local -a pedidos
  IFS=, read -ra pedidos <<<"$1"
  ((${#pedidos[@]})) || erro_uso "lista de jobs vazia"
  for job in "${pedidos[@]}"; do
    conhecido=false
    for j in "${JOBS[@]}"; do [[ $j == "$job" ]] && conhecido=true; done
    $conhecido || erro_uso "job desconhecido: $job"
    echo "$job"
  done
}

declare -A SO=() PULAR=()
BASE_MUDANCAS=''
while (($#)); do
  case "$1" in
    --so)
      (($# >= 2)) || erro_uso "--so precisa da lista de jobs"
      escolhidos=$(lista_jobs "$2") || exit 2
      for j in $escolhidos; do SO[$j]=1; done
      shift 2
      ;;
    --pular)
      (($# >= 2)) || erro_uso "--pular precisa da lista de jobs"
      escolhidos=$(lista_jobs "$2") || exit 2
      for j in $escolhidos; do PULAR[$j]=1; done
      shift 2
      ;;
    --mudancas)
      (($# >= 2)) || erro_uso "--mudancas precisa da base (ex.: origin/main)"
      BASE_MUDANCAS=$2
      shift 2
      ;;
    -h | --ajuda)
      uso
      exit 0
      ;;
    *) erro_uso "opção desconhecida: $1" ;;
  esac
done

mkdir -p "$LOGS" || exit 2
rm -f "$LOGS"/*.log "$LOGS/resumo.md"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
if ! command -v dotnet >/dev/null 2>&1 && [[ -x $HOME/.dotnet/dotnet ]]; then
  export PATH="$HOME/.dotnet:$PATH" DOTNET_ROOT="$HOME/.dotnet"
fi

# ---------------------------------------------------------------------------------------------------------------------
# O que roda

declare -A RESULTADO=() TEMPO=()

# --mudancas: o mudancas.sh compara commits; para valer também o que ainda não foi commitado, a árvore de trabalho vira
# um commit solto (índice temporário + commit-tree), sem mexer no índice, no HEAD nem em branch nenhum.
declare -A MUDOU=()
MOTIVO_MUDANCAS=''
if [[ -n $BASE_MUDANCAS ]]; then
  git rev-parse -q --verify "$BASE_MUDANCAS^{commit}" >/dev/null || erro_uso "base não encontrada no git: $BASE_MUDANCAS"
  indice=$(mktemp)
  cp "$(git rev-parse --git-path index)" "$indice" 2>/dev/null || rm -f "$indice" # sem índice: o git cria um
  arvore=$(GIT_INDEX_FILE=$indice git add -A && GIT_INDEX_FILE=$indice git write-tree)
  rm -f "$indice"
  [[ -n $arvore ]] || erro_uso "não foi possível registrar a árvore de trabalho para o --mudancas"
  ponta=$(GIT_AUTHOR_NAME=verificacao-local GIT_AUTHOR_EMAIL=verificacao@local.invalid \
    GIT_COMMITTER_NAME=verificacao-local GIT_COMMITTER_EMAIL=verificacao@local.invalid \
    git commit-tree "$arvore" -p HEAD -m 'verificação local (árvore de trabalho)') ||
    erro_uso "não foi possível registrar a árvore de trabalho para o --mudancas"
  saida=$(env -u GITHUB_ACTIONS -u GITHUB_OUTPUT -u GITHUB_STEP_SUMMARY bash "$MUDANCAS_SH" "$BASE_MUDANCAS" "$ponta") ||
    erro_uso "o mudancas.sh falhou"
  echo "$saida" >"$LOGS/mudancas.log"
  while IFS='=' read -r chave valor; do
    case "$chave" in ts | pdv | imagens | e2e) MUDOU[$chave]=$valor ;; esac
  done <<<"$saida"
  MOTIVO_MUDANCAS="mudanças desde $BASE_MUDANCAS (árvore de trabalho inteira, inclusive o que não foi commitado)"
fi

declare -A RODA=()
for job in "${JOBS[@]}"; do
  if ((${#SO[@]})) && [[ -z ${SO[$job]:-} ]]; then
    RESULTADO[$job]='pulado (fora do --so)'
  elif [[ -n ${PULAR[$job]:-} ]]; then
    RESULTADO[$job]='pulado (--pular)'
  elif [[ -n $BASE_MUDANCAS && -n ${SAIDA_MUDANCAS[$job]:-} && ${MUDOU[${SAIDA_MUDANCAS[$job]}]:-true} != true ]]; then
    RESULTADO[$job]='pulado (sem mudanças)'
  else
    RODA[$job]=1
  fi
done

# ---------------------------------------------------------------------------------------------------------------------
# Passos e jobs

LOG_JOB=/dev/null

# Funções de passo que rodam no próprio shell: mudam variáveis dele (o container e a porta do PostgreSQL 18, os
# argumentos do build) ou sobem um serviço que tem de sobreviver ao passo (dockerd, PostgreSQL 16). São curtas (cada
# comando delas leva segundos), então o sinal que chega no meio espera só o comando da vez.
declare -A NO_SHELL=([garantir_docker]=1 [garantir_pg16]=1 [iniciar_pg18]=1 [preparar_build]=1)
PASSO_PID=''

# passo "Nome" comando...: roda com a saída no log do job; na tela, só o nome e o resultado. O comando roda em segundo
# plano com `wait`: o bash adia o trap enquanto espera um filho em primeiro plano, e o `wait` o sinal interrompe na
# hora. Assim um SIGTERM (ou Ctrl+C) mandado só ao script, e não ao grupo de processos, não espera o fim de uma
# integração de ~13 min: o trap encerra a árvore do passo (PASSO_PID) e remove o container.
passo() {
  local nome=$1 inicio=$SECONDS status=0
  shift
  printf '  → %s ' "$nome"
  printf '\n===== %s =====\n$ %s\n' "$nome" "$*" >>"$LOG_JOB"
  if [[ -n ${NO_SHELL[$1]:-} ]]; then
    "$@" >>"$LOG_JOB" 2>&1 </dev/null || status=$?
  else
    "$@" >>"$LOG_JOB" 2>&1 </dev/null &
    PASSO_PID=$!
    wait "$PASSO_PID" || status=$?
    PASSO_PID=''
  fi
  if ((status == 0)); then
    printf '(ok, %ss)\n' "$((SECONDS - inicio))"
  else
    printf '(FALHOU, saída %s)\n' "$status"
    printf '===== falhou: %s (saída %s) =====\n' "$nome" "$status" >>"$LOG_JOB"
  fi
  return "$status"
}

no_pdv() { (cd "$RAIZ/apps/pdv" && "$@"); }

retrato_drizzle() {
  find apps/api/drizzle -type f -print0 | sort -z | xargs -0 sha256sum
}

# Na CI o checkout é limpo e o passo confere o `git status` de apps/api/drizzle. Aqui a árvore pode ter migração nova
# ainda sem commit (o bloco em andamento): falha só se gerar as migrações MUDAR algo nela.
conferir_drizzle() {
  local antes depois
  antes=$(retrato_drizzle) || return 1
  pnpm --filter api db:gerar:controle || return 1
  pnpm --filter api db:gerar:empresa || return 1
  depois=$(retrato_drizzle) || return 1
  if [[ $antes != "$depois" ]]; then
    diff <(echo "$antes") <(echo "$depois")
    echo "Schema Drizzle alterado sem migração: os arquivos acima foram gerados agora por db:gerar:controle/db:gerar:empresa; versione o SQL"
    return 1
  fi
}

job_ts() {
  passo 'Dependências' pnpm install --frozen-lockfile || return 1
  passo 'Formatação' pnpm format:check || return 1
  passo 'Lint' pnpm lint || return 1
  passo 'Tipos' pnpm typecheck || return 1
  passo 'Schemas Drizzle × migrações versionadas' conferir_drizzle || return 1
  passo 'Esquema do PDV (Esquema.g.cs) × schema Drizzle e registro de fluxos' pnpm --filter api verificar:esquema-pdv || return 1
  passo 'Testes unitários do shared' pnpm --filter @genesis/shared test || return 1
  passo 'Testes unitários da API' pnpm --filter api test:unit || return 1
  passo 'Testes unitários do ERP web' pnpm --filter erp-web test || return 1
  passo 'Build (API e ERP web)' pnpm build || return 1
}

# PostgreSQL 16 local (padrão do apps/api/test/integracao/ambiente.ts), como o hook da sessão: sobe os clusters fora do
# ar e cria o papel genesis se faltar. A conferência entra no banco `postgres` (o genesis_control é criado pelos próprios
# testes, com outro nome, e pode não existir).
garantir_pg16() {
  local conferencia="${URL_PG16%/*}/postgres"
  if pg_isready -q -h 127.0.0.1 -p 5432 2>/dev/null && psql "$conferencia" -tAc 'select 1' >/dev/null 2>&1; then
    return 0
  fi
  if command -v pg_lsclusters >/dev/null 2>&1; then
    pg_lsclusters --no-header 2>/dev/null | while read -r versao cluster _ estado _; do
      [[ $estado == online ]] || pg_ctlcluster "$versao" "$cluster" start || true
    done
    if id postgres >/dev/null 2>&1; then
      existe=$(su postgres -c "psql -tAc \"select 1 from pg_roles where rolname = 'genesis'\"" 2>/dev/null || true)
      if [[ $existe != 1 ]]; then
        su postgres -c "psql -c \"create role genesis login superuser password 'genesis_dev'\"" >/dev/null || true
      fi
    fi
  fi
  local limite=$((SECONDS + 60))
  until psql "$conferencia" -tAc 'select 1' >/dev/null 2>&1; do
    ((SECONDS < limite)) || {
      echo "PostgreSQL 16 local indisponível (papel genesis em $conferencia)"
      return 1
    }
    sleep 1
  done
}

# As duas integrações repetem o `pnpm install` do job da CI: é ele que, pelo postinstall da raiz, recompila o
# packages/shared/dist que a API importa. Rodadas com `--so integracao-*` depois de mexer no shared (ou no lockfile)
# testam o código atual, não o dist da rodada anterior; depois do job ts, o install leva segundos.
job_integracao_pg16() {
  passo 'Dependências' pnpm install --frozen-lockfile || return 1
  passo 'PostgreSQL 16 local no ar' garantir_pg16 || return 1
  passo 'Testes de integração da API (PostgreSQL 16)' \
    env DATABASE_URL="$URL_PG16" "${TETOS_TRAVA[@]}" pnpm --filter api test:integracao || return 1
}

# Container do PostgreSQL 18: nome com o PID (duas verificações em paralelo não se atrapalham), porta escolhida pelo
# Docker (127.0.0.1, porta livre), removido no fim do job e pelo trap (falha, Ctrl+C, SIGTERM).
# Uma verificação está viva enquanto o PID dela existe, de qualquer usuário: o `kill -0` falha também com EPERM (o
# processo existe, mas é de outro usuário do grupo docker), então o `ps -p` desempata antes de remover o container.
verificacao_viva() {
  kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}
PG18_CONTAINER=''
PG18_PORTA=''

parar_pg18() {
  if [[ -n $PG18_CONTAINER ]]; then
    docker rm -f "$PG18_CONTAINER" >/dev/null 2>&1 || true
    PG18_CONTAINER=''
  fi
}

iniciar_pg18() {
  local nome="genesis-verificacao-pg18-$$" limite antigo
  # Sobra de uma verificação morta sem trap (SIGKILL, sessão reiniciada): o container cujo PID não existe mais.
  for antigo in $(docker ps -a --filter label=genesis.verificacao-local=1 --format '{{.Names}}' 2>/dev/null); do
    [[ $antigo =~ ^genesis-verificacao-pg18-([0-9]+)$ ]] || continue
    verificacao_viva "${BASH_REMATCH[1]}" || docker rm -f "$antigo" >/dev/null 2>&1 || true
  done
  PG18_CONTAINER=$nome
  docker run -d --rm --name "$nome" --label genesis.verificacao-local=1 \
    -e POSTGRES_USER=genesis -e POSTGRES_PASSWORD=genesis_dev -e POSTGRES_DB=genesis_control \
    -p 127.0.0.1::5432 "$IMAGEM_PG18" || return 1
  PG18_PORTA=$(docker port "$nome" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p' | head -n 1)
  [[ -n $PG18_PORTA ]] || {
    echo "sem a porta publicada do container $nome"
    return 1
  }
  echo "PostgreSQL 18 ($IMAGEM_PG18) em 127.0.0.1:$PG18_PORTA (container $nome)"
  # Pronto = aceita conexão pela porta publicada (o pg_isready de dentro responde antes, no servidor temporário do
  # initdb, que ainda não escuta TCP).
  limite=$((SECONDS + 120))
  until docker exec "$nome" pg_isready -q -h 127.0.0.1 -U genesis -d genesis_control 2>/dev/null; do
    ((SECONDS < limite)) || {
      echo "o PostgreSQL 18 não ficou pronto em 120 s"
      docker logs --tail 50 "$nome" 2>&1 || true
      return 1
    }
    sleep 1
  done
}

job_integracao_pg18() {
  passo 'Dependências' pnpm install --frozen-lockfile || return 1
  passo 'Docker no ar' garantir_docker || return 1
  passo 'PostgreSQL 18 (container)' iniciar_pg18 || return 1
  passo 'Testes de integração da API (PostgreSQL 18)' \
    env DATABASE_URL="postgres://genesis:genesis_dev@127.0.0.1:$PG18_PORTA/genesis_control" "${TETOS_TRAVA[@]}" \
    pnpm --filter api test:integracao || return 1
}

# Usado pelos jobs integracao-pg18 e imagens. O dockerd sobe numa sessão e num grupo de processos próprios (setsid):
# o nohup só ignora o SIGHUP, e o Ctrl+C (SIGINT ao grupo em primeiro plano) ou um SIGTERM ao grupo do script
# derrubariam também o daemon, que reinstala o tratamento do SIGINT; o Docker ficaria fora do ar no resto da sessão.
garantir_docker() {
  docker info >/dev/null 2>&1 && return 0
  if [[ $(id -u) == 0 ]] && command -v dockerd >/dev/null 2>&1; then
    mkdir -p "$LOGS/servicos"
    echo "subindo o dockerd (log em $LOGS/servicos/dockerd.log)"
    if command -v setsid >/dev/null 2>&1; then
      setsid nohup dockerd >>"$LOGS/servicos/dockerd.log" 2>&1 </dev/null &
    else
      nohup dockerd >>"$LOGS/servicos/dockerd.log" 2>&1 </dev/null &
    fi
    disown || true
  fi
  local limite=$((SECONDS + 60))
  until docker info >/dev/null 2>&1; do
    ((SECONDS < limite)) || {
      echo "o Docker não está no ar (e não foi possível subir o dockerd)"
      return 1
    }
    sleep 1
  done
}

# Build atrás do proxy da sessão (README do .ccr: processos dentro do container não alcançam o proxy local nem confiam
# no certificado dele): rede do host, o proxy nos build-args e uma base derivada com o certificado.
ARGS_BUILD=()
ARGS_NODE=()
ARGS_ALPINE=()
preparar_build() {
  local proxy=${HTTPS_PROXY:-${https_proxy:-}} sem_proxy=${NO_PROXY:-${no_proxy:-}}
  local ca=${VERIFICAR_CA:-${NODE_EXTRA_CA_CERTS:-${SSL_CERT_FILE:-}}}
  ARGS_BUILD=()
  ARGS_NODE=()
  ARGS_ALPINE=()
  [[ -n $proxy ]] || return 0
  echo "proxy de saída detectado: build com --network host e o proxy nos build-args"
  ARGS_BUILD=(--network host --build-arg "HTTPS_PROXY=$proxy" --build-arg "https_proxy=$proxy"
    --build-arg "NO_PROXY=$sem_proxy" --build-arg "no_proxy=$sem_proxy")
  [[ -n $ca && -f $ca ]] || return 0
  echo "certificado do proxy ($ca) nas bases derivadas genesis-verificacao-base-*:local"
  local contexto
  contexto=$(mktemp -d)
  cp "$ca" "$contexto/ca-extra.crt"
  cat >"$contexto/Dockerfile" <<'EOF'
ARG BASE
FROM ${BASE}
USER root
COPY ca-extra.crt /usr/local/share/ca-extra.crt
RUN mkdir -p /etc/ssl/certs && cat /usr/local/share/ca-extra.crt >> /etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-extra.crt
EOF
  local node alpine status=0
  node=$(sed -n 's/^ARG IMAGEM_NODE=//p' apps/api/Dockerfile | head -n 1)
  alpine=$(sed -n 's/^ARG IMAGEM_ALPINE=//p' infra/producao/backup/Dockerfile | head -n 1)
  docker build -q --build-arg "BASE=$node" -t genesis-verificacao-base-node:local "$contexto" &&
    docker build -q --build-arg "BASE=$alpine" -t genesis-verificacao-base-alpine:local "$contexto" || status=$?
  rm -rf "$contexto"
  ((status == 0)) || return "$status"
  ARGS_NODE=(--build-arg IMAGEM_NODE=genesis-verificacao-base-node:local)
  ARGS_ALPINE=(--build-arg IMAGEM_ALPINE=genesis-verificacao-base-alpine:local)
}

compose_producao() {
  local temporario status=0
  temporario=$(mktemp -d)
  cp -r infra/producao/. "$temporario/"
  (
    cd "$temporario" || exit 1
    export GENESIS_VERSAO=ci CLOUDSQL_INSTANCIA=projeto:regiao:instancia ERP_DOMINIO=erp.exemplo.invalid \
      API_DOMINIO=api.exemplo.invalid DOWNLOAD_DOMINIO=download.exemplo.invalid GENESIS_SEGREDOS="$temporario/segredos"
    mkdir -p segredos
    touch segredos/genesis-google.env segredos/genesis-app.env segredos/gcp-conta-servico.json
    [ -e genesis.env ] || cp genesis.env.exemplo genesis.env
    docker compose --project-directory . -f docker-compose.yml config -q --no-env-resolution --no-path-resolution || exit 1
    soma=$(docker compose --project-directory . -f docker-compose.yml --profile tarefa config --format json \
      --no-env-resolution --no-path-resolution | jq '[.services[].mem_limit | tonumber] | add / 1048576') || exit 1
    echo "Soma dos limites de memória (API + ERP + proxy + backup + tarefa): $soma MiB"
    [[ $soma =~ ^[0-9]+$ ]] || {
      echo "soma dos limites ilegível: $soma"
      exit 1
    }
    [ "$soma" -le 2560 ] || {
      echo "limites de memória somam $soma MiB (teto: 2560)"
      exit 1
    }
  ) || status=$?
  rm -rf "$temporario"
  return "$status"
}

job_imagens() {
  passo 'Docker no ar' garantir_docker || return 1
  passo 'Preparo do build (proxy da sessão)' preparar_build || return 1
  passo 'Imagem da API' docker build "${ARGS_BUILD[@]}" "${ARGS_NODE[@]}" -f apps/api/Dockerfile \
    -t genesis-api:verificacao-local . || return 1
  passo 'Imagem do ERP' docker build "${ARGS_BUILD[@]}" "${ARGS_NODE[@]}" -f apps/erp-web/Dockerfile \
    -t genesis-web:verificacao-local . || return 1
  passo 'Imagem do backup' docker build "${ARGS_BUILD[@]}" "${ARGS_ALPINE[@]}" -f infra/producao/backup/Dockerfile \
    -t genesis-backup:verificacao-local infra/producao/backup || return 1
  passo 'Scripts de produção (shellcheck)' \
    bash -c 'shellcheck -x -S warning infra/producao/*.sh infra/producao/backup/*.sh infra/producao/teste/*.sh' || return 1
  passo 'Script do backup (testes de unidade)' bash infra/producao/backup/testar-genesis-backup.sh || return 1
  passo 'Logs do implantar.sh (testes de unidade)' bash infra/producao/teste/testar-implantar-logs.sh || return 1
  passo 'Implantação sem o Actions (testes de unidade)' bash infra/producao/teste/testar-implantar-sem-actions.sh ||
    return 1
  passo 'Compose de produção válido (e dentro dos 2,5 GB somados)' compose_producao || return 1
}

job_pdv() {
  passo 'Restore' no_pdv dotnet restore GenesisPDV.slnx --locked-mode || return 1
  passo 'Build' no_pdv dotnet build GenesisPDV.slnx --no-restore -c Release || return 1
  # O mesmo teto das consultas com volume sintético do job do Windows (a sessão também é compartilhada).
  passo 'Testes (os que exigem Windows ficam pulados)' \
    no_pdv env GENESISPDV_TETO_CONSULTA_MS=800 dotnet test --solution GenesisPDV.slnx --no-build -c Release || return 1
}

job_pdv_formatacao() {
  passo 'Restore' no_pdv dotnet restore GenesisPDV.slnx --locked-mode || return 1
  passo 'Formatação (dotnet format)' no_pdv dotnet format GenesisPDV.slnx --verify-no-changes --no-restore || return 1
}

job_e2e_sync() {
  local saidas="$LOGS/e2e-sync"
  rm -rf "$saidas"
  mkdir -p "$saidas"
  passo 'PostgreSQL 16 local no ar' garantir_pg16 || return 1
  passo 'Dependências' pnpm install --frozen-lockfile || return 1
  passo 'Restore e build do e2e do PDV' \
    no_pdv bash -c 'dotnet restore GenesisPDV.slnx --locked-mode && dotnet build tests/GenesisPDV.E2E.Tests --no-restore -c Release' ||
    return 1
  passo 'E2E (API local + PDV headless)' \
    env DATABASE_URL="$URL_PG16" E2E_LOG_API="$saidas/e2e-api.log" GENESISPDV_CAPTURAS="$saidas/capturas" \
    GENESIS_E2E_RELATORIOS="$saidas/relatorios" apps/api/test/e2e-pdv/rodar.sh -c Release --no-build || return 1
}

job_scripts() {
  passo 'shellcheck (scripts/ e .github/scripts/)' bash -c 'shellcheck -x -S warning scripts/*.sh .github/scripts/*.sh' ||
    return 1
  passo 'Teste do verificar-local.sh (comandos falsos)' bash scripts/testar-verificar-local.sh || return 1
}

# ---------------------------------------------------------------------------------------------------------------------
# Execução

encerrar() {
  parar_pg18
}

# A árvore do passo em andamento (o comando e os descendentes dele, pelo pgrep; sem ele, só o comando): os filhos do
# passo ficam no grupo do script e, em segundo plano, ignoram o SIGINT; o trap os encerra com SIGTERM. A lista é
# montada antes do primeiro kill (um filho órfão não teria mais o pai para achá-lo).
arvore() {
  local filho
  echo "$1"
  for filho in $(pgrep -P "$1" 2>/dev/null); do arvore "$filho"; done
}
interromper() {
  local status=$1 motivo=$2 pids
  trap '' INT TERM
  echo
  echo "verificar-local: $motivo"
  if [[ -n $PASSO_PID ]]; then
    pids=$(arvore "$PASSO_PID")
    # shellcheck disable=SC2086 # um PID por palavra
    kill -TERM $pids 2>/dev/null || true
  fi
  exit "$status"
}
trap encerrar EXIT
trap 'interromper 130 interrompido' INT
trap 'interromper 143 "encerrado (SIGTERM)"' TERM

formatar_tempo() { printf '%02d:%02d' "$(($1 / 60))" "$(($1 % 60))"; }

commit=$(git rev-parse --short=12 HEAD 2>/dev/null || echo '?')
ramo=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
if [[ -n $(git status --porcelain 2>/dev/null) ]]; then sujo=' + alterações não commitadas'; else sujo=''; fi
echo "Verificação local (D70): $ramo @ $commit$sujo"
[[ -n $MOTIVO_MUDANCAS ]] && echo "Escopo: $MOTIVO_MUDANCAS"
echo "Logs: $LOGS"

INICIO_TOTAL=$SECONDS
for job in "${JOBS[@]}"; do
  [[ -n ${RODA[$job]:-} ]] || continue
  LOG_JOB="$LOGS/$job.log"
  : >"$LOG_JOB"
  echo
  echo "▶ $job — ${DESCRICAO[$job]}"
  inicio=$SECONDS
  funcao="job_${job//-/_}"
  if "$funcao"; then
    RESULTADO[$job]='ok'
  else
    RESULTADO[$job]='FALHOU'
    echo "  últimas linhas de $LOG_JOB:"
    tail -n 40 "$LOG_JOB" | sed 's/^/    /'
  fi
  [[ $job == integracao-pg18 ]] && parar_pg18
  TEMPO[$job]=$((SECONDS - inicio))
done
LOG_JOB=/dev/null

falhas=0
{
  echo "### Verificação local (\`scripts/verificar-local.sh\`, D70)"
  echo
  echo "\`$ramo\` @ \`$commit\`$sujo, $(date '+%d/%m/%Y %H:%M') — total $(formatar_tempo $((SECONDS - INICIO_TOTAL)))"
  [[ -n $MOTIVO_MUDANCAS ]] && echo && echo "Escopo: $MOTIVO_MUDANCAS."
  echo
  echo '| Job | Resultado | Tempo |'
  echo '|---|---|---|'
  for job in "${JOBS[@]}"; do
    if [[ -n ${TEMPO[$job]:-} ]]; then t=$(formatar_tempo "${TEMPO[$job]}"); else t='—'; fi
    echo "| $job — ${DESCRICAO[$job]} | ${RESULTADO[$job]} | $t |"
    [[ ${RESULTADO[$job]} == FALHOU ]] && falhas=$((falhas + 1))
  done
  echo
  echo 'Não coberto aqui (só o runner Windows, até o OP-B3): impressora de teste do spooler (SpoolerWindowsTests),'
  echo 'instalador do Windows e o teste dele (instala, abre, reinstala e desinstala).'
} >"$LOGS/resumo.md"
echo
cat "$LOGS/resumo.md"
echo
if ((falhas > 0)); then
  echo "verificar-local: $falhas job(s) falharam (logs em $LOGS)"
  exit 1
fi
echo 'verificar-local: tudo verde'
exit 0
