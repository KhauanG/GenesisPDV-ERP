# syntax=docker/dockerfile:1
# Imagem do backup lógico diário (Implantação do piloto, I1b; README de infra/producao › Backup). Contexto do build =
# esta pasta:
#   docker build -f infra/producao/backup/Dockerfile -t genesis-backup:<versao> infra/producao/backup
# Base: Alpine com só o cliente do PostgreSQL 18 (pg_dump/pg_restore/psql da mesma versão do Cloud SQL), sem o
# servidor, o initdb, o JIT nem o `VOLUME` da imagem oficial `postgres` (dezenas de MB em vez de ~120 MB comprimidos
# a cada implantação, que envia a imagem inteira). bash (o script), curl (envio ao bucket com assinatura AWS SigV4,
# que o GCS aceita com a chave HMAC), jq (manifesto e estado em JSON) e tzdata (o horário de Brasília). O pacote do
# cliente cria o usuário `postgres` (uid 70), o mesmo da imagem oficial: roda sem root.
ARG IMAGEM_ALPINE=alpine:3.24

FROM ${IMAGEM_ALPINE}
RUN apk add --no-cache bash curl jq postgresql18-client tzdata \
 && id -u postgres | grep -qx 70 \
 && mkdir -p /trabalho \
 && chown postgres:postgres /trabalho \
 && chmod 700 /trabalho
COPY --chmod=755 genesis-backup.sh /usr/local/bin/genesis-backup
# A versão vem depois do RUN e do COPY: um ARG antes de um RUN entra no ambiente dele e um valor novo (o commit, a
# cada implantação) refaria o `apk add` sempre, sem usar o cache do CI.
ARG VERSAO=desconhecida
LABEL org.opencontainers.image.title="genesis-backup" \
      org.opencontainers.image.description="Backup lógico diário (pg_dump) dos bancos do GenesisPDV para o bucket" \
      org.opencontainers.image.version="${VERSAO}"
ENV GENESIS_VERSAO=${VERSAO} \
    TZ=America/Sao_Paulo \
    BACKUP_TRABALHO=/trabalho
USER postgres
WORKDIR /trabalho
# Saudável = o agendador está vivo (batimento a cada minuto, e a cada banco durante o backup). Um backup com falha não
# muda a saúde (README › Backup › O que olhar).
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --start-interval=2s --retries=2 CMD ["genesis-backup", "saude"]
ENTRYPOINT ["genesis-backup"]
CMD ["agendar"]
