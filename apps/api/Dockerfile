# syntax=docker/dockerfile:1
# Imagem de produção da API (Implantação do piloto, I1). Contexto do build = raiz do monorepo:
#   docker build -f apps/api/Dockerfile -t genesis-api:<versao> .
# Estágios: dependências (pnpm fetch, só o lockfile) → build (shared + API) → pnpm deploy --prod → imagem final
# enxuta, sem pnpm nem dependências de desenvolvimento, rodando como o usuário `node` (uid 1000).
# A mesma imagem roda a API (`node dist/main.js`) e as tarefas da implantação (`node dist/cli/<comando>.js`).
ARG IMAGEM_NODE=node:22.23.4-bookworm-slim

FROM ${IMAGEM_NODE} AS base
ENV PNPM_HOME=/pnpm \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
# A versão do pnpm vem do campo "packageManager" do package.json (corepack).
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS dependencias
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Baixa os pacotes do lockfile para o cache (camada reaproveitada enquanto o lockfile não muda). Atenção: o cache de
# CAMADAS (type=gha) volta em outra máquina, mas o cache mount do store não; com esta camada vinda do cache, o store
# pode estar vazio. Por isso os passos seguintes usam --prefer-offline (store quando tem, registro quando falta; o
# lockfile congelado garante as mesmas versões) em vez de só offline (falhava com ERR_PNPM_NO_OFFLINE_TARBALL).
RUN --mount=type=cache,id=genesis-pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM dependencias AS build
COPY . .
# Só a API e o que ela usa (@genesis/shared); o argon2 usa o binário pré-compilado (glibc).
RUN --mount=type=cache,id=genesis-pnpm,target=/pnpm/store \
    pnpm install --prefer-offline --frozen-lockfile --filter api...
RUN pnpm --filter @genesis/shared run build && pnpm --filter api run build
# node_modules só de produção, com o @genesis/shared copiado (não link) para dentro.
RUN --mount=type=cache,id=genesis-pnpm,target=/pnpm/store \
    pnpm --config.inject-workspace-packages=true --filter api deploy --prod --prefer-offline /saida
# Monta a pasta final só com o necessário (o deploy copia o pacote inteiro, com src/ e test/): node_modules e
# package.json do deploy, o JS compilado, o SQL das migrações e os dados das referências nacionais, que o
# carregar.ts lê de `src/database/referencias/` também a partir de `dist/`.
RUN mkdir -p /app/src/database \
 && cp -r /saida/node_modules /saida/package.json /app/ \
 && cp -r apps/api/dist apps/api/drizzle /app/ \
 && cp -r apps/api/src/database/referencias /app/src/database/ \
 && find /app/src /app/dist \( -name '*.ts' -o -name '*.map' \) -delete

FROM ${IMAGEM_NODE} AS final
ARG VERSAO=desconhecida
LABEL org.opencontainers.image.title="genesis-api" \
      org.opencontainers.image.description="API do GenesisPDV & ERP" \
      org.opencontainers.image.version="${VERSAO}"
ENV NODE_ENV=production \
    AMBIENTE=producao \
    PORTA=3000 \
    GENESIS_VERSAO=${VERSAO}
WORKDIR /app
# Arquivos do root e só leitura para o usuário da aplicação.
COPY --from=build /app ./
USER node
EXPOSE 3000
# /saude responde 503 sem o banco de controle: o container fica "unhealthy" e o Traefik deixa de mandar tráfego.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORTA||3000)+'/saude').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
