# syntax=docker/dockerfile:1
# Imagem de produção do ERP web (Implantação do piloto, I1). Contexto do build = raiz do monorepo:
#   docker build -f apps/erp-web/Dockerfile -t genesis-web:<versao> .
# Build estático do Vite servido por um nginx sem root (porta 8080). A API fica na MESMA origem: o Traefik manda
# `erp.<domínio>/api/*` e `/saude` para a API (cookie de refresh SameSite=Strict em /api/auth, sem CORS), e o resto
# para este container. O mesmo nginx atende `download.<domínio>` (a página em /srv/download; o instalador do PDV fica
# fora da imagem, numa pasta do host montada só leitura em /srv/download/pdv pelo docker-compose.yml de produção).
ARG IMAGEM_NODE=node:22.23.4-bookworm-slim
ARG IMAGEM_NGINX=nginxinc/nginx-unprivileged:1.29.8-alpine

FROM ${IMAGEM_NODE} AS build
ENV PNPM_HOME=/pnpm \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# --prefer-offline adiante: o store do cache mount pode vir vazio quando esta camada vem do cache de camadas (ver
# apps/api/Dockerfile).
RUN --mount=type=cache,id=genesis-pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=genesis-pnpm,target=/pnpm/store \
    pnpm install --prefer-offline --frozen-lockfile --filter erp-web...
# Faixa de ambiente no topo do ERP (vazio = produção, sem faixa).
ARG VITE_AMBIENTE=
ENV VITE_AMBIENTE=${VITE_AMBIENTE}
RUN pnpm --filter @genesis/shared run build && pnpm --filter erp-web run build

FROM ${IMAGEM_NGINX} AS final
ARG VERSAO=desconhecida
LABEL org.opencontainers.image.title="genesis-web" \
      org.opencontainers.image.description="ERP web do GenesisPDV (estático)" \
      org.opencontainers.image.version="${VERSAO}"
# Só a configuração do Genesis (sem o default.conf da imagem nem os scripts que o reescrevem na partida).
USER root
RUN rm -f /etc/nginx/conf.d/default.conf /docker-entrypoint.d/*.sh
COPY apps/erp-web/nginx/genesis.conf /etc/nginx/conf.d/genesis.conf
COPY apps/erp-web/nginx/cabecalhos.conf /etc/nginx/genesis-cabecalhos.conf
COPY apps/erp-web/nginx/cabecalhos-download.conf /etc/nginx/genesis-cabecalhos-download.conf
COPY apps/erp-web/nginx/download/ /srv/download/
COPY --from=build /repo/apps/erp-web/dist/ /usr/share/nginx/html/
RUN printf '%s\n' "${VERSAO}" > /usr/share/nginx/html/versao.txt
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/saude-web"]
