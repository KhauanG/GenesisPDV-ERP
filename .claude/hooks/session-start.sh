#!/bin/bash
# Prepara a sessão do Claude Code na nuvem para rodar os checks do CLAUDE.md: dependências do pnpm, o .NET SDK do
# apps/pdv/global.json (a mesma versão da CI, que também é a do `dotnet format`) e o PostgreSQL local dos testes de
# integração da API. Roda a cada início, retomada e compactação da sessão; o que já está pronto é pulado.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# 1. Dependências do monorepo (pnpm). Só reinstala se o lock, os package.json ou este script mudaram.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  pnpm install --frozen-lockfile
  sha256sum .claude/hooks/session-start.sh pnpm-lock.yaml pnpm-workspace.yaml package.json \
    apps/*/package.json packages/*/package.json 2>/dev/null > "$hashes" || rm -f "$hashes"
fi

# 2. .NET SDK do global.json do PDV, em ~/.dotnet (fora do repositório).
DOTNET_DIR="$HOME/.dotnet"
SDK_PDV=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' apps/pdv/global.json | head -n 1)
if ! "$DOTNET_DIR/dotnet" --list-sdks 2>/dev/null | grep -q "^$SDK_PDV "; then
  instalador=$(mktemp)
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$instalador"
  bash "$instalador" --jsonfile apps/pdv/global.json --install-dir "$DOTNET_DIR" --no-path
  rm -f "$instalador"
fi
export PATH="$DOTNET_DIR:$PATH" DOTNET_ROOT="$DOTNET_DIR" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
# Pacotes NuGet do PDV (rápido quando já estão no cache ~/.nuget/packages).
(cd apps/pdv && dotnet restore GenesisPDV.slnx --locked-mode --verbosity quiet)

# 3. PostgreSQL local dos testes de integração (padrão do apps/api/test/integracao/ambiente.ts:
#    postgres://genesis:genesis_dev@127.0.0.1:5432). Só se o servidor estiver instalado no ambiente.
if command -v pg_lsclusters >/dev/null 2>&1; then
  pg_lsclusters --no-header 2>/dev/null | while read -r versao cluster _ estado _; do
    if [ "$estado" != "online" ]; then pg_ctlcluster "$versao" "$cluster" start || true; fi
  done
  if command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
    existe=$(su postgres -c "psql -tAc \"select 1 from pg_roles where rolname = 'genesis'\"" 2>/dev/null || true)
    if [ "$existe" != "1" ]; then
      su postgres -c "psql -c \"create role genesis login superuser password 'genesis_dev'\"" >/dev/null
    fi
  fi
fi

# 4. Variáveis para o resto da sessão.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$DOTNET_DIR:\$PATH\""
    echo "export DOTNET_ROOT=\"$DOTNET_DIR\""
    echo 'export DOTNET_CLI_TELEMETRY_OPTOUT=1'
    echo 'export DOTNET_NOLOGO=1'
  } >> "$CLAUDE_ENV_FILE"
fi
