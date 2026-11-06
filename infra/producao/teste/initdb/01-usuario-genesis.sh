#!/bin/sh
# Teste local da stack: cria o usuário `genesis` com os privilégios do Cloud SQL (cloudsqlsuperuser: CREATEDB e
# CREATEROLE, sem SUPERUSER). O genesis_control NÃO é criado aqui: a migração do controle cria, como em produção.
set -eu
psql -v ON_ERROR_STOP=1 -v senha="$GENESIS_SENHA_TESTE" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
create role genesis login createdb createrole password :'senha';
SQL
