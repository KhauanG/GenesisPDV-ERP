# API – GenesisPDV & ERP

API na nuvem (NestJS + Drizzle + PostgreSQL) que atende o ERP web, o painel da plataforma e a sincronização dos
PDVs (`/sync/*`). Segue `docs/arquitetura/decisoes.md` (ADR-02, 08, 09), o modelo de dados
(`docs/arquitetura/modelo-de-dados.md`, "MD") e a especificação do ERP ("ERP"). Entrega da **Fase 0** do roadmap.

## O que tem aqui

| Área                                                                                                                                                                                                                                                     | Onde                                                                                         | Referência                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| Configuração por ambiente validada com `zod`                                                                                                                                                                                                             | `src/config/configuracao.ts`, `.env.example`                                                 | roadmap Fase 0                          |
| Logs JSON (pino) com `requisicao_id` (eco do `X-Requisicao-Id`), `GET /saude`, envelope de erro `{ codigo, mensagem, campos }`                                                                                                                           | `src/app.module.ts`, `src/comum/filtro-erros.ts`, `src/saude`                                | ERP 1.8, VG 13                          |
| Banco de controle completo (13 tabelas, inclui `backups_empresas`) e banco da empresa da Fase 0 (inclui MD 3.15) e dos cadastros base da Fase 1A (pessoas, produtos, combos, mix, estoque, NCM, parâmetros fiscais por UF)                               | `src/database/controle/schema.ts`, `src/database/empresa/schema/*`                           | MD 2, 2.14, 3.1–3.4, 3.15               |
| Migrações versionadas (drizzle-kit + SQL customizado)                                                                                                                                                                                                    | `drizzle/controle`, `drizzle/empresa`                                                        | MD 1.5–1.9                              |
| Executor de migrações "um schema, N bancos", canário, lotes, `migracoes_empresas`, manutenção 503 só para falha ou schema abaixo do mínimo                                                                                                               | `src/database/migracoes`, `src/plataforma/migrador-empresas.ts`, `src/tenancy/resolvedor.ts` | MD 2.12, ERP 19.7                       |
| Roles de banco separadas: dona (provisionamento/migrações) × runtime por empresa (sem `DELETE` nas C/D/P/R, auditoria append-only, único `CONNECT` no banco da empresa)                                                                                  | `src/database/roles-empresa.ts`, `src/database/servidores.ts`                                | MD 1.4                                  |
| Multiempresa: `ContextoEmpresa` imutável (AsyncLocalStorage), cache de pools com limite e fechamento de ociosos, conferência de `current_database()`                                                                                                     | `src/tenancy`                                                                                | ADR-02, VG 4.3.1                        |
| Provisionamento (CREATE DATABASE, migrações, referências, seed idempotente, admin com senha provisória), tentar novamente/descartar                                                                                                                      | `src/plataforma/provisionamento.ts`, `src/database/seed`, `src/database/referencias`         | MD 7, ERP 19.4                          |
| Login do ERP (argon2id, JWT 15 min, refresh rotativo em cookie `httpOnly` com detecção de reuso por família, inatividade pela última requisição, bloqueio atômico, limite por IP e por código+login, troca de senha, esqueci/redefinir senha por e-mail) | `src/auth`                                                                                   | ERP 4                                   |
| Autorização: `@Permissao`, guard, filtro por lojas permitidas                                                                                                                                                                                            | `src/autorizacao`                                                                            | ERP 2, 11.4                             |
| Usuários (listagem com filtros/ordenação, obter, criar com senha provisória, alterar com versão, excluir, desbloquear; escalada barrada) e perfis (consulta)                                                                                             | `src/usuarios`, `src/perfis`, `packages/shared/usuarios.ts`                                  | ERP 11.1–11.3                           |
| Auditoria na mesma transação (antes/depois, segredos mascarados), particionada, append-only, catálogo de ações em `@genesis/shared`; `GET /api/auditoria` com filtros do ERP 17.3 e lojas permitidas                                                     | `src/auditoria`                                                                              | ERP 17, MD 3.1.7                        |
| Painel da plataforma: login com TOTP (sem reuso do código), sessões com família e detecção de reuso, empresas (listar/criar/suspender/reativar), planos, migrações                                                                                       | `src/plataforma`                                                                             | ERP 19                                  |
| Cifra de segredos AES-256-GCM com chave mestra fora do banco; envelope ECIES para o terminal                                                                                                                                                             | `src/seguranca/cifra.ts`, `src/seguranca/ecies.ts`                                           | MD 1.10                                 |
| Sincronização: `POST /sync/ativar`, `GET /sync/estado`, `GET /sync/pull`, `POST /sync/push`, `POST /sync/heartbeat`, registro de fluxos, envelope de erro próprio                                                                                        | `src/sync` ([README](src/sync/README.md))                                                    | SYNC 2–8, 21.1; MD 3.15, 6              |
| Cadastros base da Fase 1: empresa, lojas (assistente de primeira configuração), caixas, locais de estoque, perfis, usuários (PIN, permissões individuais, redefinir senha), formas de pagamento, configurações e atalhos, pessoas, marcas e categorias | `src/empresa`, `src/lojas`, `src/estoques`, `src/perfis`, `src/usuarios`, `src/formas-pagamento`, `src/configuracoes`, `src/pessoas`, `src/catalogo`, `src/referencias`, `src/comum/cadastro.ts`, `packages/shared/{estrutura,pessoas,catalogo,formas-pagamento,campos}.ts` | ERP 7.1–7.2, 8.4, 8.7, 9.1, 9.3.1, 9.9, 10.1–10.3, 11.1–11.3, 13.2; MD 7.13 |
| Produtos (listagem com os filtros do Nuvem3, formulário com códigos de barras/embalagens, preços complementares, lojas, faixas, combo com posições e alternativas, ficha técnica, vasilhame, tributação e flags do PDV; saldos e combos montáveis), custo do combo automático (trigger + `CustoCombos`), grupos de preço por quantidade (mix), restrições de horário de venda, busca de NCM | `src/produtos`, `drizzle/empresa/0005_produtos_custo_combo.sql`, `packages/shared/{produtos,precos}.ts` | ERP 8.1, 8.2, 8.9, 8.10; MD 3.6.3–3.6.13 |
| Estoque: acerto Entrada/Saída/Definir (rascunho → efetivado → estornado) com movimentos e saldos na mesma transação, consulta de saldos por estoque; importação de produtos e clientes por planilha (xlsx/csv, colunas do Nuvem3) com prévia, tarefa em segundo plano e relatório de inconsistências; dashboard (casca) | `src/estoques`, `src/importacao`, `src/dashboard`, `packages/shared/{estoque,importacao,dashboard}.ts` | ERP 6, 8.2.11, 8.6, 13.5, 16.4; MD 3.7 |
| PDVs/Terminais no ERP: listagem e detalhe, códigos de ativação (gerar, cancelar, liberar), revogação em 3 modos, ressincronizar/mensagem, troca de hardware, eventos com erro (leitura) e manutenção periódica | `src/terminais`                                                                              | ERP 12; SYNC 3.1, 3.8 |
| Fila técnica (pg-boss, schema `pgboss` do controle), tarefas em segundo plano (`GET /api/tarefas`), e-mail transacional (SMTP) e armazenamento de objetos S3 com URL assinada                                                                            | `src/infra`, `src/tarefas`                                                                   | ERP 3.6, 18.14; MD 3.1.6, 3.1.8, 3.1.10 |

## Rodar localmente, passo a passo

Pré-requisitos: Node 22.13+, pnpm 10, PostgreSQL 16 (o `infra/docker-compose.yml` sobe um com `genesis`/`genesis_dev`
e o banco `genesis_control`, mais o Mailpit e o armazenamento S3; sem Docker, qualquer PostgreSQL 16 com uma role com
`CREATEDB` e `CREATEROLE` serve — ela cria um banco e uma role de runtime por empresa).

```bash
# 1. Dependências (na raiz do monorepo). O postinstall já compila o @genesis/shared; ao editar
#    packages/shared/src com a API no ar, deixe `pnpm dev:shared` rodando para recompilar.
pnpm install

# 2. Ambiente local: PostgreSQL, Mailpit (http://localhost:8025) e S3 (http://localhost:9001)
docker compose -f infra/docker-compose.yml up -d        # ou use um PostgreSQL já instalado

# 3. Variáveis (opcional em desenvolvimento: os padrões apontam para o ambiente local; linha "CHAVE=" vazia vale como
#    variável ausente)
cp apps/api/.env.example apps/api/.env

# 4. Banco de controle: migrações + plano "padrao" + servidor de banco padrão
pnpm --filter api db:migrate:controle

# 5. Primeiro administrador da plataforma (mostra a senha e o segredo TOTP uma única vez)
pnpm --filter api admin:criar --email voce@genesis.dev --nome "Seu Nome" --papel superadmin

# 6. Primeira empresa (código 100001 em diante; mostra a senha provisória do "admin" uma única vez)
pnpm --filter api empresa:criar --razao-social "Ice Beer Comércio de Bebidas Ltda" --cnpj 11222333000181

# 7. API em modo desenvolvimento (recarrega ao salvar) em http://localhost:3000
pnpm --filter api dev
```

Teste rápido:

```bash
curl localhost:3000/saude
curl -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"codigoEmpresa":"100001","login":"admin","senha":"<senha provisória>"}'
# → trocarSenha: true. Com o tokenAcesso: POST /api/auth/trocar-senha { senhaAtual, novaSenha }
```

## Comandos (`pnpm --filter api <comando>`)

| Comando                                                                                                                               | O que faz                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev` / `build` / `start`                                                                                                             | Desenvolvimento com `tsx watch`; compilação para `dist/`; execução de `dist/main.js`                                                                                                                |
| `typecheck`, `test`, `test:unit`, `test:integracao`                                                                                   | Verificação de tipos; todos os testes; só unitários (sem banco); só integração (PostgreSQL)                                                                                                         |
| `test:sync-triggers`                                                                                                                  | Toda tabela do registro de fluxos (`src/sync/fluxos.ts`) tem `tg_<tabela>_versao` com `fn_versao` e `ix_<tabela>_versao` (MD 1.5)                                                                   |
| `test:limpar`                                                                                                                         | Remove bancos e roles de teste (integração e e2e do PDV) deixados por execuções interrompidas (só os sem conexão ativa)                                                                             |
| `carga:razao [--movimentos=4000000] [--produtos=2000] [--manter] [--so-massa] [--saida=arq.json]`                                      | Fora do CI: massa de 1 ano do razão (3 lojas, CD, Treino) num banco descartável, roteiro de `EXPLAIN (ANALYZE, BUFFERS)` antes/depois dos índices da 0026 e o heap do replay; apaga os bancos no fim (decisão 176) |
| `carga:exportacao [--movimentos=1000000] [--produtos=2000] [--saida=arq.json]` | Fora do CI: a massa do `carga:razao` num banco descartável e a exportação do razão inteiro em tarefa (`.xlsx` e `.csv`), com o tempo, o pico de heap do processo e a conferência das linhas do arquivo; apaga os bancos no fim (decisão 177) |
| `carga:estoque-atual [--movimentos=4000000] [--produtos=2000] [--saida=arq.json]` | Fora do CI: a massa do `carga:razao` num banco descartável e o relatório Estoque Atual pela rota ("Todas" e uma loja, agora e na data-base pelos dois caminhos, a exportação na hora), o pior de 3 abaixo de 3 s; apaga os bancos no fim (decisão 178) |
| `db:migrate:controle`                                                                                                                 | Cria o `genesis_control` se não existir, aplica as migrações e o seed mínimo do controle                                                                                                            |
| `db:migrate:empresas [--empresas=100001,100002] [--lote=4] [--parar-no-primeiro-erro]`                                                | Migra todas as empresas `ativa`/`suspensa`: canário primeiro, depois as demais; reaplica referências, catálogo de permissões e seed idempotente; sai com código 1 se alguma falhar                  |
| `db:referencias [--empresas=…]`                                                                                                       | Recarrega referências nacionais, catálogo de permissões e seed em todas as empresas                                                                                                                 |
| `db:ncm:atualizar [--simular] [--empresas=…] [--arquivo=<caminho>\|-] [--url=…] [--permitir-encerramento-em-massa]` | Baixa a tabela NCM vigente do Siscomex (`SISCOMEX_NCM_URL`) ou lê o arquivo, confere o formato e aplica em cada empresa com o relatório (incluídos, encerrados, produtos com NCM inválido) e o `ressincronizar_fluxo referencia` (decisão 193) |
| `db:particoes`                                                                                                                        | Garante as partições mensais de `auditoria` (12 meses à frente) — agendar mensalmente                                                                                                               |
| `db:preencher-seq-lancamento [--empresas=…] [--saida=quebras.csv]` | Dá a ordem de lançamento (`seq_lancamento`) aos movimentos de estoque antigos, cria o índice da linha e relata as linhas do razão com a cadeia quebrada, também depois da migração, sem nada a preencher (decisão 146); o `db:migrate:empresas` já roda o preenchimento antes da `0017` |
| `db:recalcular-saldos (--empresa=100001[,…] \| --todas) [--estoque=<id>] [--produto=<id>] [--corrigir] [--saida=relatorio.csv]` | Refaz `saldos_estoque` pelo razão (replay por `seq_lancamento`) e confere `produtos.custo_medio`: diz "idêntico" ou lista cada linha divergente (gravado, recalculado, diferença, primeiro movimento divergente); `--corrigir` regrava só a projeção, sob a trava, e o saldo certo desce ao PDV. Sem filtro e idêntico, resolve o `RAZAO_SALDO_DIVERGENTE` aberto. Sai com 2 se diverge sem `--corrigir` (decisão 147) |
| `empresa:criar --razao-social … --cnpj … [--plano padrao] [--regime simples_nacional] [--codigo N] [--admin-login admin] [--canario]` | Provisiona uma empresa                                                                                                                                                                              |
| `empresa:provisionamento --codigo N (--tentar-novamente \| --descartar)`                                                              | Continua um provisionamento que falhou ou descarta (DROP DATABASE)                                                                                                                                  |
| `admin:criar --email … --nome … [--papel superadmin] [--senha-stdin]`                                                                 | Cria admin da plataforma com 2FA (TOTP). A senha é gerada e exibida uma vez, lida da entrada padrão (`--senha-stdin`) ou de `GENESIS_ADMIN_SENHA` — nunca como argumento (histórico do shell, `ps`) |
| `db:gerar:controle` / `db:gerar:empresa`                                                                                              | `drizzle-kit generate` depois de alterar os schemas (ver "Migrações")                                                                                                                               |

Na raiz: `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format`.

## Rotas

ERP (prefixo `/api`, token `Authorization: Bearer`): `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/trocar-senha`, `POST /auth/esqueci-senha`, `POST /auth/redefinir-senha`, `GET /auth/eu`,
`GET|PUT /empresa`, `GET|POST /lojas`, `GET|PUT|DELETE /lojas/:id`, `GET|POST /lojas/:id/caixas`,
`PUT|DELETE /lojas/:id/caixas/:caixaId`, `GET|POST /estoques`, `GET|PUT|DELETE /estoques/:id`, `GET|POST /usuarios`,
`GET /usuarios/exportar`, `GET|PUT|DELETE /usuarios/:id`, `POST /usuarios/:id/desbloquear`,
`POST /usuarios/:id/redefinir-senha`, `PUT /usuarios/:id/pin`, `GET|PUT /usuarios/:id/permissoes`,
`GET|POST /perfis`, `GET|PUT|DELETE /perfis/:id`, `POST /perfis/:id/duplicar`, `GET|POST /formas-pagamento`,
`GET /formas-pagamento/opcoes`, `GET|PUT|DELETE /formas-pagamento/:id`, `GET|PUT /configuracoes`, `GET|PUT /atalhos-pdv`,
`POST /atalhos-pdv/restaurar-padrao`, `GET|POST /pessoas`, `GET /pessoas/exportar`, `GET|PUT|DELETE /pessoas/:id`,
`GET|POST /marcas`, `GET|PUT|DELETE /marcas/:id`, `POST /marcas/mesclar`, `GET /categorias/arvore`, `POST /categorias`,
`PUT|DELETE /categorias/:id`, `POST /categorias/:id/mover`, `GET|POST /produtos`, `GET /produtos/exportar`,
`GET /produtos/busca`, `GET /produtos/verificar-ean`, `GET /produtos/codigo-interno-livre`,
`GET|PUT|DELETE /produtos/:id`, `GET /produtos/:id/saldos`, `GET|POST /grupos-preco-quantidade`,
`GET|PUT|DELETE /grupos-preco-quantidade/:id`, `GET|POST /restricoes-horario-venda`,
`GET|PUT|DELETE /restricoes-horario-venda/:id`, `GET|POST /acertos`, `GET|PUT|DELETE /acertos/:id`,
`POST /acertos/:id/efetivar`, `POST /acertos/:id/estornar`, `GET|POST /transferencias`,
`GET|PUT|DELETE /transferencias/:id`, `POST /transferencias/:id/enviar|receber|tratar-divergencia|cancelar`,
`PUT /transferencias/:id/nfe-externa`,
`GET /saldos-estoque`, `GET /saldos-estoque/itens`,
`GET /relatorios/estoque-atual`, `POST /relatorios/estoque-atual/ajustar`, `GET /relatorios/:relatorio/exportar`,
`GET|POST /tipos-estoque`, `GET|PUT|DELETE /tipos-estoque/:id`, `GET /importacoes/produtos|clientes/modelo`, `POST /importacoes/produtos|clientes/previa`
(multipart), `POST /importacoes/produtos|clientes/confirmar`, `GET /dashboard`, `GET /implantacao/prontidao`, `GET /ncms`, `GET /ncms/:codigo`,
`GET /referencias/unidades|cfops`, `GET /referencias/ufs|municipios|paises`,
`GET /utilitarios/cep/:cep`, `GET /auditoria`, `GET /terminais`, `GET /terminais/:id`, `PATCH /terminais/:id`,
`GET /terminais/:id/eventos-erro`, `POST /terminais/:id/revogar|ressincronizar|mensagem|hardware/confirmar`,
`POST /eventos-recebidos/:id/reprocessar|aplicar-novo-numero|descartar`, `POST /eventos-recebidos/reprocessar-lote`,
`GET|POST /terminais/ativacoes`, `DELETE /terminais/ativacoes/:id`, `POST /terminais/ativacoes/liberar`,
`GET /tarefas`, `GET /tarefas/:id`.
Painel (`/api/plataforma`, token de audiência `plataforma`): `POST /auth/login|refresh|logout`, `GET /auth/eu`,
`GET /empresas`, `GET /empresas/:codigo`, `POST /empresas`, `POST /empresas/:codigo/suspender`,
`POST /empresas/:codigo/reativar`, `POST /empresas/:codigo/provisionamento/tentar-novamente|descartar`, `GET /planos`,
`GET /migracoes` (situação), `GET /migracoes/simular`, `POST /migracoes/aplicar`. Monitoramento (I1b, token de
monitoramento `Authorization: Bearer`, nunca a sessão do ERP): `GET /api/saude/detalhada` (decisão 201). Fora do
prefixo: `GET /saude` e o protocolo do PDV (`POST /sync/ativar`,
`POST /sync/token/renovar`, `GET /sync/estado`, `GET /sync/pull`, `POST /sync/push`, `POST /sync/heartbeat`,
`GET /sync/eventos-status` (C14); token do
terminal, envelope
`{ erro: { codigo, mensagem, detalhes, requisicao_id } }`).

## Variáveis de ambiente

Todas estão em `.env.example` com comentário. As essenciais:

| Variável                                                                                          | Padrão                                                          | Observação                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AMBIENTE`                                                                                        | `desenvolvimento`                                               | `desenvolvimento`, `teste`, `homologacao`, `producao`. Lê `.env.<AMBIENTE>.local`, `.env.<AMBIENTE>`, `.env.local`, `.env`. Com `NODE_ENV=production` a API recusa `desenvolvimento`/`teste`; o ambiente ativo sai no log de partida |
| `DATABASE_URL`                                                                                    | `postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control` | Banco de controle; os testes de integração também o leem (do processo ou do `apps/api/.env`)                                                                                                                                         |
| `EMPRESAS_SERVIDOR_URL`                                                                           | = `DATABASE_URL`                                                | Servidor padrão dos bancos de empresa (registrado em `servidores_banco` com a senha cifrada). A role precisa de `CREATEDB` e `CREATEROLE`                                                                                            |
| `JWT_SEGREDO`, `JWT_SEGREDO_PLATAFORMA`, `CHAVE_MESTRA`                                           | só dev/teste têm padrão                                         | Obrigatórias em homologação/produção, diferentes dos valores de desenvolvimento e os dois segredos JWT diferentes entre si                                                                                                           |
| `TRUST_PROXY`                                                                                     | `false` (dev/teste)                                             | Proxies confiáveis à frente da API (número de saltos, `false` ou IPs/CIDRs). Obrigatória em homologação/produção: define o IP usado no limite de taxa e na auditoria                                                                 |
| `LOGIN_MAX_TENTATIVAS` / `LOGIN_BLOQUEIO_MINUTOS`                                                 | 5 / 15                                                          | ERP 4.1 (login, senha atual na troca e painel)                                                                                                                                                                                       |
| `LOGIN_LIMITE_POR_MINUTO` / `LOGIN_LIMITE_POR_CONTA_MINUTO`                                       | 20 / 10                                                         | Limites por IP e por conta (código+login; e-mail no painel; usuário na troca de senha)                                                                                                                                               |
| `SESSAO_INATIVIDADE_MINUTOS` / `SESSAO_ADMIN_INATIVIDADE_MINUTOS` / `REFRESH_TOLERANCIA_SEGUNDOS` | 60 / 30 / 20                                                    | Inatividade pela última requisição real; janela em que o mesmo refresh simultâneo responde 409 sem derrubar a sessão                                                                                                                 |
| `POOL_CACHE_MAXIMO` / `POOL_OCIOSO_MS`                                                            | 50 / 300000                                                     | Cache de pools por empresa (pool em uso nunca é fechado)                                                                                                                                                                             |
| `DASHBOARD_CACHE_MS` | 60000 | Cache do `GET /dashboard` por empresa × loja × mês × o que o usuário enxerga (ERP 6); 0 desliga (testes e e2e) |
| `CEP_CONSULTA_URL`                                                                                | ViaCEP (`https://viacep.com.br/ws/{cep}/json/`)                  | Consulta de CEP do ERP (opcional, 3 s de limite); `desligada` desativa — o endereço é digitado                                                                                                                                        |
| `SISCOMEX_NCM_URL` | `https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO` | Tabela NCM vigente que o `db:ncm:atualizar` baixa (decisão 193); só a tarefa usa |
| `ERP_URL`, `SMTP_URL`, `EMAIL_REMETENTE`                                                          | `http://localhost:5173`, `smtp://127.0.0.1:1025`                | Links e envio de e-mail (Mailpit em desenvolvimento)                                                                                                                                                                                 |
| `ARMAZENAMENTO_*`                                                                                 | MinIO/RustFS local em dev                                       | Endpoint, região, bucket, chaves e estilo de caminho do S3                                                                                                                                                                           |
| `FILA_TRABALHADOR`                                                                                | `true`                                                          | Esta instância executa a fila (tarefas e e-mails); `false` só enfileira                                                                                                                                                              |
| `VERIFICACAO_RAZAO_CRON` | vazia (desligada) | Cron (UTC, 5 campos) da verificação periódica do razão de estoque: só confere e abre o alerta `RAZAO_SALDO_DIVERGENTE`; corrigir é o `db:recalcular-saldos --corrigir`. Cron inválido recusa a subida; esvaziar desliga e remove o agendamento já gravado no pg-boss (decisão 147) |
| `ARGON2_CONCORRENCIA` / `PLANILHA_CONCORRENCIA` | 4 / 2 | Semáforos do processo: hashes argon2 e leituras de planilha simultâneos (decisão 93) |
| `EXPORTACAO_CONCORRENCIA` / `EXPORTACOES_PENDENTES_POR_USUARIO` | 2 / 2 | Gerações de arquivo de exportação simultâneas no processo (listagens, relatório da importação e a exportação de relatório em tarefa; mínimo 2, para sempre sobrar vaga a quem baixa na hora) e exportações em tarefa na fila ou executando por usuário, 422 acima (decisões 93 e 177) |
| `ARMAZENAMENTO_INATIVIDADE_MS` | 120000 | Inatividade máxima da conexão de um pedido ao armazenamento: sem nenhum byte indo ou vindo, o pedido falha e o SDK repete (3 tentativas); conexão: 10 s (decisão 177) |
| `IMAGENS_CONCORRENCIA` / `IMAGENS_LIMITE_PIXELS` | 1 / 36000000 | Imagens decodificadas ao mesmo tempo no processo (o sharp, uma thread do libvips cada) e o teto de pixels (largura × altura) aceito no envio, conferido pelo cabeçalho antes de decodificar (decisão 189) |
| `ARQUIVOS_ENVIOS_SIMULTANEOS` / `ARQUIVOS_ENVIOS_SIMULTANEOS_USUARIO` / `ARQUIVOS_ENVIOS_POR_MINUTO` | 4 / 2 / 30 | Envios de arquivo (`POST /api/arquivos`) sendo processados ao mesmo tempo no processo (a vaga é pega com o corpo já lido; o seguinte espera), ao mesmo tempo por usuário (contados desde antes da leitura, 429 acima) e por usuário por minuto, 429 acima (decisão 189) |
| `HASH_LIMITE_POR_MINUTO` / `IMPORTACAO_PREVIAS_POR_MINUTO` | 10 / 10 | Por usuário e por minuto (PIN, senha do cliente, senha de liberação; prévias de importação), 429 acima (decisão 93) |
| `MONITOR_TOKEN_SHA256` | vazio (rota fechada) | SHA-256 (hex) do token do `GET /api/saude/detalhada`; só o hash fica no ambiente (decisão 140) |
| `MONITOR_LIMITE_POR_MINUTO` | 30 | Consultas ao `/api/saude/detalhada` por IP por minuto, contando as recusadas; 429 acima |
| `GENESIS_VERSAO` / `BACKUP_ESTADO_CHAVE` | `desenvolvimento` / `backups/estado.json` | Versão no painel (a imagem define com o commit) e o estado do último backup no bucket (gravado pelo `genesis-backup`) |

### Em produção (VPS + Cloud SQL, Implantação do piloto I1)

A imagem `apps/api/Dockerfile` já traz `NODE_ENV=production` e `AMBIENTE=producao`; o resto vem de três arquivos na
VPS (passo a passo e modelos em `infra/producao/README.md`):

| Arquivo na VPS | Variáveis | Origem |
| --- | --- | --- |
| `segredos/genesis-google.env` (root, 600) | `DATABASE_URL` (usuário `genesis` em `genesis-cloudsql-proxy:5432/genesis_control`), `ARMAZENAMENTO_ENDPOINT=https://storage.googleapis.com`, `ARMAZENAMENTO_REGIAO=auto`, `ARMAZENAMENTO_BUCKET`, `ARMAZENAMENTO_CHAVE_ACESSO`/`_SECRETA` (HMAC do GCS), `ARMAZENAMENTO_CAMINHO=true` | `configurar-genesis.sh` no Cloud Shell |
| `segredos/genesis-app.env` (root, 600) | `JWT_SEGREDO`, `JWT_SEGREDO_PLATAFORMA`, `CHAVE_MESTRA`, `CHAVE_MESTRA_VERSAO=1`; `SMTP_URL` quando houver; `MONITOR_TOKEN_SHA256` (I1b) | `infra/producao/instalar.sh` (openssl, uma vez; nunca troca); o hash do token, `implantar.sh token-monitor` |
| `genesis.env` | `TRUST_PROXY=1` (o Traefik), `CORS_ORIGENS` e `ERP_URL` = `https://erp.grupoicebeer.com.br`, `COOKIE_SEGURO=true`, `EMPRESAS_ICU_LOCALE=pt-BR`, `FILA_TRABALHADOR=true`, `EMAIL_REMETENTE`, `LOG_NIVEL=info` | `infra/producao/genesis.env.exemplo` |

O compose ainda define `NODE_OPTIONS=--max-old-space-size=1536` (container de 2 GB) e `PORTA=3000`. Os CLIs rodam
compilados na mesma imagem (`node dist/cli/<comando>.js`, pelo `implantar.sh tarefa <comando>`), sem `tsx`.

## Migrações

- Os schemas Drizzle são a fonte das tabelas; `drizzle-kit generate` gera o SQL em `drizzle/<banco>/`.
- O que o drizzle-kit não gera fica em migrações SQL customizadas (`drizzle-kit generate --custom`): funções e
  sequências **antes** das tabelas (`0000_funcoes`), e depois triggers `tg_<tabela>_versao`, FKs de autoria,
  índices únicos com `NULLS NOT DISTINCT`, a tabela `auditoria` particionada por mês e a função de partições.
- Toda tabela nova com `versao` precisa do trigger numa migração customizada: `fn_versao` se algum fluxo do pull a
  lê — e então ela entra no registro de fluxos `src/sync/fluxos.ts`, de onde sai `TABELAS_FN_VERSAO` —, senão
  `fn_versao_local` (lista em `src/database/empresa/versionamento.ts`). Os testes `versionamento` e
  `test:sync-triggers` conferem listas × banco. O CI falha se o schema Drizzle mudar sem migração gerada.
- Coluna isenta de versão (argumento do `fn_versao`, migração 0011, decisão 128; do `fn_versao_local` desde a 0016,
  decisão 146) só para projeção mantida pelo banco, nunca editada no ERP e que não desce ao PDV; entra em
  `COLUNAS_ISENTAS_VERSAO` e no `omitir` do fluxo.
- Depois das migrações de cada empresa (e do pós-migração) o `MigradorEmpresas` reaplica os privilégios da role de
  runtime (tabelas novas entram; tabela sem `versao` = L e aceita `DELETE`). Sequências: `usage, select`; só
  `seq_codigo_produtos` tem também `update` (o `setval` de `proximoCodigoProduto`, decisão 102). Esse grant vem só no
  fim, e não vem se uma migração falha: a migração que põe uma **sequência nova no default de uma tabela que a API já
  grava** dá o `usage, select` à role `current_database() || '_app'` (se existir) na própria transação, como a 0016
  (decisão 146); senão os INSERTs da API, a do deploy anterior inclusive, falham com 42501 até o fim da migração.
- Migração aplicada **nunca** é editada: o hash (SHA-256 do arquivo) é conferido e a divergência põe a empresa em
  manutenção. Use o padrão expandir/contrair (a API continua atendendo durante a migração em massa).
- Passo de dados que não cabe na transação da migração sem travar o banco (preencher uma coluna nova em lotes,
  `create index concurrently`) vai em `PREPARACOES_MIGRACAO_EMPRESA` (`src/database/migracoes/preparacoes-empresa.ts`):
  o executor o roda fora de transação, na mesma conexão, logo antes da migração da tag, só se ela ainda vai ser
  aplicada. Tem de ser idempotente. Quem aplica o journal à mão num banco com dados passa as preparações (decisão 146).
  Hoje: o preenchimento da `seq_lancamento` antes da 0017 (decisão 146) e os índices do razão antes da 0026 (decisão 176).
  O que ela tem a contar volta como `RelatoPreparacao` (`avisos` e `dados`): o `MigradorEmpresas` põe os avisos no
  resultado da empresa (terminal do `db:migrate:empresas`, modal e log do "Aplicar") e o relato em
  `auditoria_plataforma` (`migracao_preparada`, com a empresa), porque a segunda passada já não acha o que relatar.

## Testes

`pnpm --filter api test` roda os unitários e os de integração. Os de integração usam o PostgreSQL de `DATABASE_URL`
(do processo ou, se ausente, do `apps/api/.env`; padrão: o local), criam um banco de controle
`genesis_t_<aleatório>_ctl` e reservam (trava consultiva) uma faixa de códigos de empresa livre (800000–990999) por
arquivo, e removem bancos e roles no fim. Execução interrompida deixa sobras: `pnpm --filter api test:limpar`.
O e-mail é capturado por um SMTP local do próprio teste e o S3 por um servidor em memória (com
`ARMAZENAMENTO_TESTE_URL` o teste usa um S3 de verdade, como o do docker-compose). Cobrem: provisionamento + seed idempotente + tentar
novamente/descartar; login, senha provisória, erro genérico, bloqueio, refresh rotativo com detecção de reuso,
logout e limite de taxa; permissões (403) e lojas permitidas; isolamento entre empresas (tokens trocados, pools,
banco errado); migração em massa em 3 empresas com falha forçada → só aquela em 503, canário que interrompe e hash
alterado, com a situação (atrasadas/com erro), a simulação (pendentes e SQL lidos do banco da empresa) e o log
das execuções; trigger de versão + trava de ordenação com transações concorrentes (inclui controle negativo sem a trava
e carga com 8 escritores); painel da plataforma com TOTP e papéis; cadastro de usuários (filtros, ordenação,
validação 422, duplicidade 409 por campo, conflito de versão 409, último Master, auto-edição, escalada de perfil e de
lojas, auditoria sem a senha, exportação CSV/xlsx com os filtros da listagem e permissão de exportar); roles (sem `DELETE`/`TRUNCATE`, auditoria append-only, sem `CONNECT` cruzado);
sincronização (ativação e repetição, estado, carga inicial com 2 lojas até o `cursor_teto`, PIN só da loja,
o mesmo evento duas vezes → `duplicado`, ordem estrita, hash divergente, retenção por dependência, regressão,
push concorrente, hardware alterado, empresa suspensa, terminal revogado, heartbeat com comandos, força bruta na
ativação); refresh concorrente (409 sem bifurcar), reuso fora da janela, tokens de antes da rotação após logout,
inatividade, bloqueio com tentativas paralelas (ERP e painel), TOTP repetido; auditoria filtrada por loja;
esqueci/redefinir senha e tarefa com arquivo no S3 pela fila pg-boss; a tarefa interrompida (`tarefas-interrompidas.test.ts`,
decisão 150). Cadastros da Fase 1 (um arquivo por grupo:
`estrutura`, `perfis-usuarios`, `formas-configuracoes`, `pessoas-catalogo`): assistente da loja (estoque homônimo,
caixa 0, conta "Caixa – loja", numerações), CD como loja depósito com estoque `deposito`, limite de lojas do plano,
caixas com série NFC-e única e nº inicial, filtro por lojas permitidas (403 e listagens filtradas), 403 sem a
permissão, 409 de versão em cada cadastro e 409 `CONFLITO` por campo, 422 por campo (zod e regras do MD), PIN do PDV
(argon2id m = 64 MiB, ordem PHC canônica, recusas da SYNC 4.3, PIN curto), permissões individuais e redefinir senha,
perfis (escalada, `permissoes_versao`, duplicar), formas de pagamento (CHECKs do MD 3.10.1, meio fiscal inativo,
senha de liberação), configurações (só o que difere do padrão, sobreposição por loja, `editar_fiscal`), atalhos
(troca de teclas numa gravação, teclas proibidas, restaurar padrão), pessoas (filhas, CPF repetido com o cadastro
existente, filtros, exportação, `editar_credito`), CEP com servidor falso (encontrado, inexistente, lento), marcas
(acento/caixa, SEM MARCA, mesclar) e categorias (caminho, 5 níveis, mover sem ciclo, renomear propaga).
Produtos (`produtos.test.ts`): cadastro com EAN + DUN-14 com fator/preço, atacado, promocional, parcelado, loja e
faixas, histórico de preços e `busca`; 422 (DV do EAN, NCM, unidade), código interno 409, versão 409; faixa
recriada/sobreposta e loja retirada; filtros (nome, código de barras do fardo, NCM por prefixo, tipo, situação),
custo escondido e ordenação por custo 403 sem `produtos.ver_custo`, exportação; "Altera Preço do Produto no ERP"
desligado; EAN duplicado `bloquear` × `avisar` (confirmação, filtro "EAN duplicado", edição de duplicado migrado);
combo com posições e alternativas (custo Σ custo × qtd, recalculado pela API e por `UPDATE` direto no banco, sem
mudar o preço; alternativa fora do custo; composição alterada), combo dentro de combo, matéria-prima e o próprio
produto recusados, ficha técnica com perda e ciclo recusado pelo banco, combos montáveis e saldos por estoque,
exclusão bloqueada (componente, saldo) e livre (combo, com as filhas); vasilhame; grupos de preço (faixas, membros,
resumo, nome único, fracionado, mover de outro grupo com confirmação, modo produto apaga as faixas, unidade
diferente pelo produto, excluir desvincula, permissões); restrições de horário (meia-noite, alvo, loja imutável,
permissão); NCM por código/descrição, CFOPs, busca de produto e código interno livre.
Estoque (`estoque.test.ts`): acerto Entrada/Saída/Definir com movimento e saldo na mesma transação, custo médio
ponderado, diferença do "Definir" que desconta os movimentos posteriores à contagem, saldo negativo (configuração e
Master), estorno, imutabilidade, versão, permissões, consulta de saldos e combos montáveis. "Definir" com o PDV
offline (`definir-offline.test.ts`, F2-B4, decisão 148): a Definição de pronto nas três ordens de chegada das vendas,
o estorno com as compensações, o "Definir" antigo anulado pelo mais novo e a Entrada lançada no momento da
efetivação, com o recálculo idêntico depois de cada caso. Importação e dashboard
(`importacao-dashboard.test.ts`, com a fila pg-boss e o S3 em memória): modelo xlsx; prévia de um CSV com o cabeçalho
do Nuvem3 (colunas reconhecidas/ignoradas, EAN duplicado e inválido, NCM inválido, sem preço, atualização pelo código
interno) sem gravar nada; confirmação em tarefa (marcas/categorias criadas, EAN duplicado gravado, acerto "Definir"
com `AJUSTE_IMPORTACAO`, estoque mínimo, auditoria com origem `importacao`, relatório no armazenamento); xlsx com
células numéricas e "Atualizar preços" desligado; erros de arquivo e 403; clientes (CPF, documento inválido, cidade
não encontrada, reimportação atualiza); dashboard (cards, vendas por loja zeradas, estoque abaixo do mínimo, mês,
financeiro só com permissão, loja fora das permitidas). Planilha de edição em massa do Nuvem3
(`importacao-nuvem3.test.ts`, fixture **sintética** com os 15 cabeçalhos do arquivo real): 1ª importação cria com o
IdProduto do Nuvem3 (unidade por extenso, categoria em lista com vírgula no nome e com duas categorias, NCM sem o zero,
estoque negativo, EAN curto, menu digital) e o produto seguinte do formulário continua na sequência; reimportação
idêntica = tudo `sem_alteracao` sem gravar nada (versões, auditoria e acerto iguais); 2 células alteradas = 2
`atualizar` com o diff certo e só esses produtos gravados; a nossa exportação reimporta igual; `Excluir` inativa,
código inválido/repetido e o aviso `codigo_conflito`. Unitários em `src/importacao/produtos.spec.ts` (análise e
comparação sem banco) e `packages/shared/src/importacao.spec.ts` (parsers).
Terminais no ERP (`terminais.test.ts`): listagem só das lojas permitidas com contadores e filtros de conexão/situação,
detalhe e ações 403 fora da loja ou sem a permissão; renomear nos dois bancos; código pendente mascarado, cancelado e
recusado na ativação; revogar imediato (nº do caixa conferido, 401 `TERMINAL_REVOGADO` no pull, caixa livre,
idempotente); aceitar pendências (heartbeat com `revogar`, pull só de `acesso`/`configuracao`) e carência vencida →
revogado pela manutenção, com salto no próximo terminal; perdido/roubado (PIN e senha de cliente descem nulos para
outro terminal da loja, auditoria por registro); manutenção (código vencido, `provisionando` esquecido, reconciliação
do banco da empresa); comandos ressincronizar/mensagem no heartbeat sem duplicar; confirmar troca de hardware; D20
(substituição com evento em erro → alerta, aba de eventos com e sem payload, alerta fechado quando o evento é
resolvido); 20 falhas → `ATIVACAO_BLOQUEADA` + alerta, "Liberar ativações" auditado e a ativação volta. O agendamento
da manutenção no `pgboss.schedule` fica em `servicos-fundo.test.ts`; `statusConexao` em
`packages/shared/src/terminais.spec.ts`.
Rotação do token (`token.test.ts`): troca do hash com o anterior por 7 dias, repetição pelo mesmo `requisicao_id`
(pelo anterior e pelo novo) sem efeito, outro hash com o mesmo id → 400, anterior com id novo → 401, hash conhecido ou
malformado → 400, hardware divergente → 409, anterior fora da janela → 401, `renovar_token` do heartbeat depois de 30
dias, e o alerta/auditoria `token_anterior_reutilizado` uma vez enquanto aberto (não dentro da margem de 30 s do
primeiro uso do novo; também quando o clone usa outra máquina e leva 409). Em `terminais.test.ts`, o mesmo alerta
na listagem e no detalhe, "Resolver" com quem e o quê, e os alertas que fecham sozinhos recusados. Os envelopes ECIES de
`packages/shared/testes/ecies/vetores.json` (que o PDV decifra) são conferidos em `src/seguranca/ecies.spec.ts`.
Prontidão da loja (`prontidao.test.ts`, implantação I5): cada regra de `falta` (ou `aviso`) para `ok` quando o que ela
aponta é resolvido — empresa em implantação, loja sem PDV, caixa só o 0, operador sem PIN, liberações pelas
permissões efetivas (totem fora, perfil, negação individual, liberador sem `pdv.acesso.entrar`, gerente de outra
loja não conta, demissão pelo dia da empresa), cada liberação vista sem ninguém (`falta` ou `aviso`) e depois `ok`
(inclusive limite de gaveta, forma "exige supervisor", desconto pelos cascos e configuração do terminal com a
permissão sem `pdv.supervisor`), o gerente como único com PIN (PIX manual e forma "exige supervisor" em `falta`), o PIX
manual com a chave desligada (fica enquanto houver operador sem a permissão), PIX com a chave da loja (422 da chave
inválida e da chave sem nome; a chave gravada inválida ou sem nome vista pela Prontidão; 403 do Gerente ao trocar o
recebedor e a auditoria `pix_recebedor_alterado`), cartão, catálogo (produto, preço, código, EAN com dígito errado,
EAN repetido, combo com componente inativo, desligado na loja ou sem componente, NCM, estoque negativo), terminal
(ativação, contato, versão mínima, relógio por `relogio_confiavel` e pelos alertas `RELOGIO_DESVIO`/`SUSPEITO`, fila de
decisão, lacuna; sem `terminais.ver`, um aviso só), a sessão de caixa esquecida, o backup no controle (recente, velho e
com falha), a tarefa atrasada e o pg-boss (só os trabalhos da empresa e os da plataforma); a loja fica `pronta`; 403
sem `configuracoes.ver` e fora das lojas permitidas, 422 sem a loja, 404 da loja inexistente e nenhum nome nem login
na resposta. **Ensaio do piloto com a carga real** (local, fora do CI): `GENESIS_PLANILHA_REAL=<planilha do Nuvem3>
apps/api/test/e2e-pdv/ensaio-piloto.sh` sobe `test/e2e-pdv/ensaio-piloto.ts` (importa a planilha pelo importador, cria
a loja de ensaio e o caixa pelas rotas do ERP, os usuários com PIN e a amostra vendável) e roda o `EnsaioPilotoTests`
do PDV (decisão 143); sem a variável, sai com 0 dizendo que pulou. O relatório (`GENESIS_ENSAIO_RELATORIO`) só tem
tempos e contagens; a planilha e o estado com os códigos nunca saem da pasta temporária.

## Versões escolhidas

| Pacote                                    | Versão                  | Observação                                                                                                                                                          |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                                   | 22 LTS (≥ 22.13)        | ADR-09. O ESLint 10.13 e o jsdom 29 exigem `^22.13`; `engine-strict=true` no `.npmrc`                                                                               |
| TypeScript                                | **6.0.3** (não a 7.0.2) | O typescript-eslint 8.72 (último) exige `typescript < 6.1`: o TS 7 é a reescrita nativa sem a API JS que o lint usa. Voltar à 7 quando o typescript-eslint suportar |
| NestJS                                    | 12.3.2                  | Só ESM → a API é ESM (`"type": "module"`, `NodeNext`, imports com `.js`)                                                                                            |
| Drizzle ORM / drizzle-kit                 | 0.45.4 / 0.31.11        | A 1.0 ainda é RC                                                                                                                                                    |
| pg                                        | 8.23.1                  |                                                                                                                                                                     |
| zod                                       | 4.6.7                   | schemas em `@genesis/shared`                                                                                                                                        |
| argon2                                    | 0.45.1                  | argon2id (m=19 MiB, t=3, p=1)                                                                                                                                       |
| jose                                      | 6.2.14                  | JWT HS256                                                                                                                                                           |
| otplib                                    | 13.5.0                  | TOTP (2FA)                                                                                                                                                          |
| @nestjs/throttler                         | 6.7.1                   | limite de taxa                                                                                                                                                      |
| nestjs-pino / pino / pino-http            | 5.3.1 / 10.4.0 / 11.0.0 | logs JSON                                                                                                                                                           |
| Vitest / Vite                             | 5.0.5 / 8.3.5           | sem necessidade de fixar major anterior                                                                                                                             |
| ESLint / Prettier                         | 10.13.0 / 3.9.10        | flat config na raiz                                                                                                                                                 |
| pg-boss                                   | 12.38.0                 | fila técnica (exige Node ≥ 22.12)                                                                                                                                   |
| @aws-sdk/client-s3 / s3-request-presigner | 3.1160.0                | S3 e URL assinada; checksums "flexíveis" só quando exigidos (compatível com MinIO/RustFS)                                                                           |
| nodemailer / smtp-server (testes)         | 10.3.1 / 3.21.3         | e-mail transacional                                                                                                                                                 |
| write-excel-file                          | 4.1.1                   | xlsx do "Exportar" das listagens (só depende do `fflate`); o `xlsx` (SheetJS) do npm está parado na 0.18 e o `exceljs` arrasta dependências antigas                 |
| exceljs | 4.4.0 (exata) | só o `WorkbookWriter` em streaming da exportação de relatório em tarefa (F2-B29, decisão 177); MIT, 23 MB e ~120 pacotes transitivos (archiver, unzipper, jszip, fast-csv…: a parte de leitura vem junto e fica sem uso; a transitiva mais nova é de 07/10/2026, mais de duas semanas); o alerta moderado do `uuid@8` (GHSA-w5hq-g745-h8pq, `v3`/`v5`/`v6` com `buf`) não se aplica: o exceljs só chama `v4`. O síncrono continua no `write-excel-file` |
| read-excel-file | 9.3.10 | leitura do xlsx da importação (mesmo autor do `write-excel-file`, só `fflate` + parser SAX); a 9.3.14 é de 29/10/2026 (menos de duas semanas) |
| fast-xml-parser | 5.11.2 | XML da NF-e de fornecedor (F2-B18, decisão 163), com `processEntities: false` e `maxNestedTags`; a 5.12.0 é de 03/11/2026 (menos de duas semanas) |
| sharp | 0.35.5 (exata) | conferência e variante `pdv_256` das imagens enviadas (F2-B43, decisão 189); libvips 8.18.7 **pré-compilado** nos pacotes opcionais `@img/sharp-<plataforma>` (no Linux da VPS e da imagem Docker, `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64`, glibc; o `node:22-bookworm-slim` é glibc), sem compilar nada na instalação (não precisa entrar em `onlyBuiltDependencies`); de 27/09/2026. O lockfile traz as variantes de todas as plataformas e o pnpm instala só a da máquina |
| xml-crypto / @xmldom/xmldom | 6.4.0 / 0.8.15 | conferência da assinatura XMLDSig da NF-e (decisão 163); o `@xmldom/xmldom` fixado na mesma versão que o `xml-crypto` usa, para o nó passado a `loadSignature` ser do mesmo DOM |

## Decisões de implementação

Divergências e lacunas encontradas nos documentos (precedência ADR > MD > SYNC > ERP/PDV) e escolhas técnicas:

1. **Sem metadados de decorators** (`emitDecoratorMetadata: false`): toda injeção do Nest é explícita com
   `@Inject(...)`. O `tsx` (dev/CLIs) e o Vitest transpilam sem emitir metadados; assim produção, dev e testes se
   comportam igual. Por isso o `ThrottlerGuard` é usado via subclasse (`LimiteTaxaGuard`) com injeção explícita.
2. **Grafo de serviços fora do container do Nest** (`src/servicos.ts`): o mesmo objeto atende controllers, CLIs e
   testes; o Nest só faz HTTP, guards e interceptors.
3. **Envelope de erro**: o do ERP 1.8 (`{ codigo, mensagem, campos }`) com `detalhes` e `requisicao_id` opcionais.
   Códigos acrescentados: `EMPRESA_CANCELADA` (MD 2.3), `TROCA_SENHA_OBRIGATORIA` (403, senha provisória),
   `CONFLITO` (409, violação de unicidade), `LIMITE_TAXA` (429), `MANUTENCAO` (503 + `Retry-After`),
   `REFRESH_CONCORRENTE` (409, decisão 12), `ARQUIVO_GRANDE` (413) e `TIPO_NAO_SUPORTADO` (415) do envio de arquivos
   (decisão 189). O `/sync` usa o envelope próprio da SYNC 2.4 (`src/sync/erros.ts`). A API do ERP usa JSON em `camelCase` (contrato pedido para o login); o sync segue
   `snake_case` (SYNC 2.3).
4. **`empresas.canario`**: o ERP 19.7 fala em "empresas marcadas como canário"; o MD 2.3 ainda não tem a coluna. Foi
   criada e precisa entrar no MD. Sem empresa marcada, a de menor código é o canário; falha no canário interrompe a
   execução. (`canal_pdv` já está no MD 2.3 e segue o tipo de lá, `varchar(7)`.)
5. **Paralelismo das migrações**: MD 2.12 ("uma empresa por vez por servidor") prevalece sobre ERP 19.7 ("lotes
   paralelos, padrão 4"): o lote é o número de **servidores** migrados em paralelo; dentro de um servidor é sequencial.
   Cada migração roda numa transação com `lock_timeout`, registrada em `migracoes_empresas` e na tabela interna do
   drizzle (`drizzle.__drizzle_migrations`, formato compatível com o migrador oficial).
6. **Modo manutenção** (MD 2.12, ERP 19.7) = status `migrando`, linha `falhou` em `migracoes_empresas` (inclusive hash
   divergente) ou `empresas.versao_schema` abaixo da última migração do journal com que o código foi publicado (tag
   desconhecida = migração mais nova, compatível por expandir/contrair) → 503 `MANUTENCAO` em login, refresh, toda
   rota da empresa e `/sync`. Migração `aplicando` **não** tira a empresa do ar. A execução seguinte bem-sucedida
   tira da manutenção.
7. **FKs adiadas**: `usuarios.pessoa_id` (→ `pessoas`, MD 3.5) existe como coluna; a FK entra com a tabela. As de
   `caixas.terminal_id`/`terminal_anterior_id` e `numeracoes.ultimo_atualizado_por_terminal_id` (→ `terminais`) foram
   criadas com o MD 3.15 (migração `0003_sincronizacao`). FKs circulares (lojas ↔ arquivos, ativacoes_pdv ↔ terminais_pdv) e as de
   autoria (`criado_por_id`/`atualizado_por_id` → `usuarios`) estão nas migrações customizadas.
8. **Tabelas do banco da empresa nesta fase**: MD 3.1 (`configuracoes`, `templates_documentos`, `numeracoes`,
   `arquivos`, `auditoria`, `tarefas`, `alertas`, `mensagens_enviadas`), 3.2 (`empresa`, `lojas`, `estoques`,
   `tipos_estoque`, `caixas`), 3.3 completo, e o necessário ao seed: `ufs`, `municipios`, `bancos`, `cfops`,
   `cfops_grupos`, `meios_pagamento_fiscais`, `unidades_medida`, `tipos_movimento_estoque`, `planos_contas`,
   `contas_correntes`, `formas_pagamento`, `atalhos_pdv`, e o MD 3.15 (`terminais`, `eventos_recebidos`,
   `comandos_terminal`, `entidades_evento`). A Fase 1A acrescentou as tabelas dos cadastros base (decisão 34);
   continuam para as fases seguintes `conversoes_cfop`, IBPT, as tabelas da Reforma Tributária e as fiscais de regra
   por UF (`regras_icms_uf`, `pautas_st_uf`, `beneficios_fiscais_uf`).
9. **Referências**: UFs e os 5.571 municípios do IBGE completos (`src/database/referencias/`, a partir do conjunto
   público kelvins/municipios-brasileiros); CFOPs só os 40 usados pelos grupos e conversões padrão (a tabela oficial
   completa entra com a fase fiscal); bancos só os 10 em destaque. A carga só grava linhas novas/alteradas (o trigger
   de versão roda até em INSERT que cai no `ON CONFLICT`).
10. **Seed idempotente**: insere só o que falta e nunca ressuscita o que a empresa excluiu/renomeou; permissão nova do
    catálogo entra nos perfis padrão (e incrementa `permissoes_versao`), permissão que a empresa tirou do perfil não
    volta. Perfil de sistema novo cujo nome a empresa já usa num perfil próprio entra como "Nome (padrão)" (depois
    "(padrão 2)"…, sem limite), sem tocar no dela (o "Encarregado" da Central do PDV, README do PDV › decisão 66). A
    descrição de um perfil de sistema que o seed mudou troca no pós-migração só se a empresa ainda tem a de antes
    (`descricoesAnteriores` em `PERFIS_PADRAO`; o Encarregado que passou a cancelar a venda paga, README do PDV ›
    decisão 78); a que ela reescreveu fica. Atalho padrão novo cuja tecla já
    está em uso entra desabilitado. `VASILHAME_DEVOLVIDO` tem
    `documento_tipo = 'venda'` (o MD lista "venda / vasilhame"; o documento real vem no movimento).
11. **Catálogo de permissões** (`packages/shared/permissoes.ts`): união do ERP 11.4 com a matriz do PDV 31.2 —
    `pdv.venda.horario_restrito`, `pdv.crediario.receber` e `pdv.crediario.desconto_juros` vêm do PDV;
    `pdv.supervisor`, `pdv.vale.emitir` e `pdv.pagamento.consumo_interno` vêm do ERP. `permite_liberacao = false` em
    `pdv.supervisor`, `pdv.caixa.ver_calculado_fechamento` e `pdv.config.fiscal`. Perfis padrão em
    `packages/shared/perfis-padrao.ts` (Administrador = tudo menos `pdv.config.fiscal`; `pdv.vale.emitir` para
    Supervisor e Gerente).
12. **Sessões do ERP e do painel**: rotação (numa transação com a linha travada) cria uma linha nova (mesma
    `familia_id`, mesma expiração absoluta de 7 dias, mesma última atividade) e encerra a anterior com
    `motivo_encerramento = 'rotacionada'` (valor **acrescentado** ao CHECK: é o que permite detectar o reuso).
    `sessoes_admin` ganhou `familia_id` e `motivo_encerramento` (fora do MD 2.9, mesmo desenho do MD 3.3.6). Refresh já
    rotacionado que reaparece em até `REFRESH_TOLERANCIA_SEGUNDOS` com a sucessora aberta (abas/requisições
    simultâneas) → 409 `REFRESH_CONCORRENTE` sem apagar o cookie nem derrubar nada; fora da janela é reuso: derruba
    todas as sessões do usuário/admin (`reuso_detectado`, com auditoria). Token de acesso de sessão rotacionada só vale
    enquanto a família tiver sessão aberta: logout, troca de senha, reuso, inatividade ou admin invalidam todos os tokens
    da família. **Inatividade** (60 min ERP, 30 min painel) é medida pela última requisição autenticada
    (`ultimo_uso_em`, gravado pelo guard no máximo 1×/min); o refresh agendado pelo navegador não conta como uso. A
    configuração por empresa `geral.sessao_inatividade_min` entra com as Configurações (Fase 1). O claim `pv` passou a
    `perm_versao` (ERP 2.1); é informativo: o guard relê `permissoes_versao` no banco a cada requisição.
13. **Login**: erro genérico para empresa/usuário/senha errados e para usuário inativo/demitido; "Usuário bloqueado
    temporariamente…" após o bloqueio (texto exigido pelo ERP 4.1); empresa suspensa só depois de credenciais
    válidas; empresa `provisionando` → `EMPRESA_SUSPENSA` sem consultar o banco. A verificação argon2 roda **fora** da
    transação; o bloqueio é conferido de novo na linha travada (`for update`) e o contador é incrementado
    atomicamente — tentativas em paralelo contam todas e as que chegam depois do bloqueio são recusadas mesmo com a
    senha certa. Só a transação que pode gravar `usuarios` (tabela sincronizável) começa com `select fn_trava_versao()`
    (MD 1.5); login de usuário inexistente ou já bloqueado grava só os logs, sem a trava da empresa. Senha atual errada
    na troca de senha conta como tentativa (e bloqueia). Um Master desbloqueia em `POST /usuarios/:id/desbloquear`.
    A regra "diferente das 3 últimas senhas" (ERP 4.2) não foi feita: o MD não tem
    histórico de senhas.
14. **Limite de taxa**: `@nestjs/throttler` em memória, dois limites: por IP (20/min) e por conta (código da empresa +
    login, e-mail do admin, ou o usuário na troca de senha; 10/min) em login, refresh, troca de senha, esqueci/redefinir
    senha e `/sync/ativar`. O IP vem do `TRUST_PROXY` declarado. Com várias instâncias da API será preciso um
    armazenamento compartilhado (Redis). Atrasos progressivos em vez do bloqueio duro ficam para depois (o bloqueio
    por conta continua permitindo que alguém que sabe código+login bloqueie o usuário; o Master desbloqueia).
15. **Auditoria**: sem `CHECK` de banco em `acao` (ERP 17.1: lista aberta; o `ck_auditoria_acao` da 0002 foi removido
    na 0003); o catálogo único é `ACOES_AUDITORIA` em `@genesis/shared` (MD 3.1.7 + ERP 17.1 + `segredo_entregue`,
    `token_anterior_reutilizado` do MD 1.10/2.4) e a API recusa ação fora dele — inclusive as que chegam do PDV em
    `auditoria.registros`. `GET /api/auditoria`: linhas com `loja_id` só das lojas permitidas (as sem loja, para todos
    com `auditoria.ver`); filtros de período (padrão: hoje, no fuso `America/Sao_Paulo`, para a consulta tocar só a
    partição do mês — o histórico de um registro, com `registro_id`, não tem período padrão), usuário, entidade, ação,
    origem, loja e texto. Partições de 3 meses atrás a 12 meses à frente na
    migração; `db:particoes`/pós-migração mantêm 12 à frente; não há partição "default" (linha fora da faixa falha
    alto em vez de travar a criação de partições futuras). Append-only por privilégio (a role de runtime só tem
    `select, insert`) e também por trigger (contra a role dona).
16. **Painel da plataforma**: login em um passo (`email`, `senha`, `codigoTotp`); o TOTP é criado já ativo pelo
    `admin:criar` (o convite por e-mail do ERP 19.11 vem depois). O mesmo código TOTP não serve duas vezes:
    `admins_plataforma.totp_ultimo_passo` (coluna fora do MD 2.8) guarda o último passo de 30 s aceito e o login só
    aceita passo maior, na mesma transação que zera o contador. Bloqueio do painel com a mesma regra atômica do ERP
    (decisão 13) e limite por e-mail. Papéis: criar empresa = `superadmin`,
    `financeiro`; suspender/reativar/tentar novamente = `superadmin`, `suporte`, `financeiro`; descartar =
    `superadmin`; migrações = `superadmin`, `suporte`; consultas = todos.
17. **Loja fora das permitidas** em `GET /lojas/:id` → 403 `SEM_PERMISSAO` (a listagem já vem filtrada).
18. Nomes das variáveis de ambiente em português (`AMBIENTE`, `PORTA`…), seguindo ADR-06.
19. **Usuários** (ERP 11.2): só Master marca/desmarca Master e só Master altera/exclui outro Master; o último Master
    ativo não pode ser desmarcado, desativado nem excluído (422 `REGRA_NEGOCIO`); ninguém altera o próprio perfil,
    lojas, limite de desconto ou flag Master, nem se exclui; quem não é Master só atribui perfil cujas permissões tem,
    só concede/retira lojas que enxerga e não concede limite de desconto maior que o próprio. **Escalada**: quem não é
    Master só altera, exclui ou mexe em login/e-mail de usuário cujo acesso efetivo (permissões e lojas) está contido
    no dele — trocar o e-mail de alguém mais poderoso e pedir "esqueci minha senha" tomaria a conta. Isso substitui a
    antiga preservação das lojas que o editor não enxerga: um usuário com loja fora do alcance do editor só é alterado
    por quem a enxerga (ou por um Master). "Ao menos uma loja" só é
    exigido quando a empresa já tem loja ativa (na Fase 0 a empresa nasce sem lojas). Toda senha definida na criação
    é provisória; sem senha informada, a API gera uma e a devolve uma única vez. Login/código/CPF repetidos → 409
    `CONFLITO` com `campos`. Mudança de perfil, Master ou lojas incrementa `permissoes_versao` e grava também
    `permissoes_alteradas`.

20. **Permissões efetivas em cache** (por instância): chave com `permissoes_versao`, Master, perfil e a "geração" da
    empresa (`max(versao)` de `perfis`, `perfis_permissoes`, `usuarios_permissoes`, `usuarios_lojas` e `lojas`, lida
    no mesmo SELECT do guard); validade de 60 s como rede de segurança. Mudança de perfil, de loja (inclusive exclusão
    lógica) ou do seed vale na próxima requisição em todas as instâncias.
21. **Roles de banco (MD 1.4)**: a role de `servidores_banco` (e de `DATABASE_URL`) é a **dona**: cria bancos e roles,
    migra e carrega referências/seed. Cada empresa ganha `genesis_emp_<codigo>_app` (NOSUPERUSER, sem CREATEDB/
    CREATEROLE/BYPASSRLS, dona de nada), com senha aleatória cifrada pela chave mestra em `empresas.usuario_banco` e
    `empresas.senha_banco_cifrada` (colunas fora do MD 2.3; o MD 2.2 diz que `servidores_banco.usuario` é "a role
    usada pela API", aqui ela é a de provisionamento). `REVOKE CONNECT ... FROM PUBLIC` no banco da empresa e
    `CONNECT` só para a role dela: um pool mal roteado nem abre o banco de outra empresa. Privilégios: `select,
insert, update` nas tabelas com `versao` (C/D/P/R), `+ delete` nas L, só `select, insert` na `auditoria`, nenhum
    nas partições (o acesso é pela tabela-mãe) e nenhum DDL (`db:particoes` usa a role dona). O banco de controle
    continua com uma role só (`DATABASE_URL`): separar a de runtime da de migração do controle fica para o deploy de
    homologação.
22. **Pools de empresa**: o descarte por tamanho só fecha pools ociosos (sem conexão emprestada nem requisição a
    caminho, contador por entrada); com todos em uso o cache passa do máximo temporariamente.
23. **Nomes de banco**: CREATE/DROP/migração só para `genesis_emp_<6 dígitos>` igual a `genesis_emp_${codigo}` da
    própria empresa; o banco de controle nunca pode ter nome de empresa nem `postgres`/`template*`
    (`src/database/nomes-bancos.ts`).
24. **`versoes_app_pdv`**: o MD 2.7 dá à versão do app o nome `versao`, que colide com a `versao` das CP (e o trigger
    `fn_versao_local` sobrescrevia o SemVer com um número). A coluna do app virou `versao_app` (como em
    `terminais_pdv.versao_app`) e a CP `versao bigint` voltou; o MD precisa do mesmo ajuste.
25. **Transações repetidas** (MD 1.5, "repete a transação até 3 vezes"): a tentativa original + 3 repetições em
    `40P01`/`40001`, com espera aleatória de 10–50 ms entre elas.
26. **Configuração**: `AMBIENTE` continua com padrão `desenvolvimento` (o passo a passo local não exige `.env`), mas
    `NODE_ENV=production` com `desenvolvimento`/`teste` não sobe; fora de dev/teste os valores de desenvolvimento
    (segredo JWT, chave mestra) são recusados e `TRUST_PROXY` é obrigatória. Variável vazia (`CHAVE=` no `.env`) vale
    como ausente.
27. **Sincronização (Fase 0)**: ver `src/sync/README.md` — fluxos só com as tabelas que já existem, handlers só de
    `auditoria.registros` e `terminal.configuracao_alterada`, demais tipos `SCHEMA_DESCONHECIDO` (transitório),
    regressão de sequência como HTTP 409 `REGRESSAO_DETECTADA` com os resultados já processados em `detalhes`,
    envelope ECIES próprio documentado em `src/seguranca/ecies.ts`.
28. **Esqueci minha senha** (ERP 4.3): a resposta é sempre a mesma, inclusive para usuário sem e-mail (o texto orienta
    a procurar um administrador) — o ERP 4.3 pede as duas coisas; vale a de não revelar usuários. A requisição só grava
    `mensagens_enviadas` (pendente) e enfileira; o trabalhador gera o token de uso único (1 h) — o segredo nunca fica
    em claro no banco nem na fila —, envia e marca `enviada`. Pedido repetido em menos de 2 min não gera outro e-mail.
    Redefinir encerra todas as sessões do usuário (`senha_alterada`) e zera o bloqueio. `mensagens_enviadas` não tem
    coluna de corpo: o conteúdo é montado pelo tipo (`template_tipo = 'redefinicao_senha'`).
29. **Fila e armazenamento**: pg-boss no banco de controle (schema `pgboss`), trabalhos só com ids; enviados depois do
    commit. Tarefas (ERP 3.6) por tipo registrado (`TarefasSegundoPlano.registrarTipo`); nenhuma tarefa de negócio na
    Fase 0. Armazenamento S3 com URL assinada (15 min; downloads de tarefa, 7 dias, o máximo da assinatura v4). A MinIO
    parou de publicar imagens da edição comunitária: o `docker-compose` usa o RustFS (API S3); o código só usa o SDK S3.
30. **Código de ativação do PDV** (ERP 12.3): `POST /api/terminais/ativacoes` (`terminais.ativar`) com loja, caixa,
    descrição e validade; a escolha "série atual/série nova" da NFC-e entra com a fase fiscal. A tela PDVs/Terminais
    chegou na 1B (decisões 110–117).

31. **Exportar listagem** (ERP 3.1, 1.8): `GET /api/<recurso>/exportar?formato=xlsx|csv&<filtros>&ordenar=` com os
    mesmos filtros e ordenação da listagem, sem paginação, auditado como `exportar` (formato, filtros e quantidade de
    linhas). CSV em UTF-8 com BOM, `;` e vírgula decimal (o Excel em pt-BR abre direto) e texto iniciado por
    `= + - @` prefixado com apóstrofo (evita fórmula no CSV). Datas no fuso `America/Sao_Paulo`. Permissão:
    `<recurso>.exportar` ou `relatorios.exportar`; recurso sem a chave própria no catálogo (usuários) depende de
    `relatorios.exportar`. A geração é síncrona até 50.000 linhas (`LIMITE_EXPORTACAO`): o caminho em segundo plano
    acima de 5.000 (ERP 3.6) entra com a central de tarefas no cabeçalho do ERP; nenhuma listagem da Fase 0 chega
    perto disso.
32. **Migrações › Situação** (ERP 19.7): `GET /api/plataforma/migracoes?filtro=todas|atrasadas|com_erro` compara a
    última migração do journal com `empresas.versao_schema` (pendentes = migrações posteriores) e usa
    `migracoes_empresas` para o erro e a execução mais recente; versão gravada que o código não conhece aparece como
    `desconhecida` (banco à frente da API). O log é o resumo que cada "Aplicar" já grava em `auditoria_plataforma`
    (`migracao_executada`), com os avisos das preparações de cada empresa (decisão 146). **Simular** (`GET /migracoes/simular`, superadmin/suporte): com `codigo`, lê
    `drizzle.__drizzle_migrations` do próprio banco (o mesmo registro do executor) e aponta migrações alteradas depois
    de aplicadas; sem `codigo`, estima pelo `versao_schema` sem abrir conexão com cada banco. "Aplicar em uma" é o
    `POST /migracoes/aplicar` com `codigos: [x]`. A execução é síncrona (sem progresso em tempo real ainda).
33. **`/auth/eu` devolve `ativa` em cada loja** para os seletores mostrarem só lojas ativas (ERP 3.4); a lista continua
    sendo a das lojas permitidas não excluídas.

### Fase 1A – banco dos cadastros base

34. **Tabelas novas** (migração `0004_cadastros_fase1`: o SQL gerado pelo drizzle-kit com as sequências de `codigo`
    antes e os objetos customizados depois, num arquivo só, para a migração ser atômica): MD 3.1.5
    (`numeracoes_faixas`), 3.2 completo (`lojas.nfce_qrcode_versao` + `lojas_banners`, `certificados_digitais`,
    `impressoras_destino`, `taxas_entrega`), 3.4 (`paises`, `ncms`, `cests`, `parametros_fiscais_uf`), 3.5 completo
    (`pessoas` e filhas, `pessoas_aliases`, `pessoas_relevancia_loja`, `saldos_credito_pessoas`,
    `parcelas_credito_pessoas`, `saldos_vasilhame_pessoas`), 3.6.1–3.6.7, 3.6.9, 3.6.10, 3.6.12, 3.6.13 (marcas,
    categorias, produtos com todas as colunas — tributação, vasilhame, kit/ficha técnica, mix —, códigos de barras com
    fator/preço de embalagem, variações, `produtos_componentes` com posições e `produtos_componentes_alternativas`,
    relacionados, preços por quantidade, dados por loja e por UF, lotes, fornecedores, imagens, histórico de preços,
    restrições de horário, grupos de preço por quantidade e faixas), 3.7.2–3.7.5 (`movimentos_estoque`,
    `saldos_estoque`, `saldos_lote`, `acertos_estoque`, `itens_acerto_estoque`) e 3.9.1 (`planos_contas_lojas`). As
    variações (3.6.6) entram agora, antes da fase delas, porque `variacao_id` aparece em códigos de barras, saldos,
    movimentos e componentes: assim as FKs nascem junto e o espelho do PDV não muda depois. Complementos (3.6.8) e
    promoções (3.6.11) ficam para a Fase 2/PDV-2.
35. **FKs adiadas**: `produtos_lojas.st_nota_entrada_id` (→ `notas_entrada`, compras),
    `parcelas_credito_pessoas.parcela_financeira_id` (→ `parcelas_financeiras`, Fase 4) e
    `produtos.ibs_cbs_cst`/`ibs_cbs_classificacao` (→ tabelas da Reforma, fase fiscal) existem como colunas; as FKs
    entram com as tabelas. `usuarios.pessoa_id → pessoas` (decisão 7) foi criada nesta migração. `lojas_banners` fica
    em `schema/sistema.ts` e `numeracoes_faixas` em `schema/sincronizacao.ts` só para não haver import circular entre
    os módulos do schema.
36. **Fluxos do pull** (`src/sync/fluxos.ts`): `catalogo`, `estoque` e `pessoas` ganharam as tabelas e os filtros do
    MD 6.2 (loja/estoque/UF do terminal, saldo só de tipo vendável sem custo, pessoas só com `pessoas_relevancia_loja`
    da loja ou de todas, `produtos` sem custo/markup/dimensões); `configuracao` ganhou banners, faixas de numeração,
    certificados (arquivo e senha descem nulos até a entrega cifrada), destinos de impressão e taxas de entrega;
    `referencia` ganhou `ncms`, `paises` e `parametros_fiscais_uf` (UF da loja, vigência atual e futuras, sem
    `fundamento`/`pendencias`). `operacao` continua vazio. Os campos calculados de imagem (`foto_url`,
    `imagem_url`/`*_sha256`) entram com `/sync/arquivos`; até lá descem os ids de arquivo. As chaves de
    `configuracoes` que descem saem do catálogo novo (`packages/shared/src/configuracoes.ts`, MD 3.1.2: grupos
    `geral`, `estoque`, `pdv`, `fiscal`, `tributacao`, `financeiro`, `vendas`, `erp`; integrações e OS entram com as
    fases delas) — antes era o prefixo `pdv.` mais uma lista de `geral.*`; agora `fiscal.*`, `tributacao.*`,
    `financeiro.*` e `vendas.*` marcadas PDV também descem.
37. **Triggers**: `fn_versao` + `ix_<tabela>_versao` em toda tabela nova lida pelo pull; `fn_versao_local` em
    `planos_contas_lojas`, `cests`, `pessoas_emails`, `produtos_fornecedores`, `produtos_imagens`,
    `movimentos_estoque`, `acertos_estoque`, `itens_acerto_estoque` (`produtos_historico_precos` é L, sem `versao`).
    **Coluna de filtro imutável** (MD 6.4 regra 2): função genérica `fn_filtro_imutavel(colunas…)` (erro
    `FILTRO_IMUTAVEL`, P0001) nas tabelas novas da lista do MD e também nas da Fase 0 que não tinham o trigger
    (`usuarios_lojas`, `configuracoes`, `templates_documentos`, `atalhos_pdv`, `caixas`). Documentos:
    `fn_protege_imutavel` em `movimentos_estoque` e `acertos_estoque` (MD 1.6) e `tg_itens_acerto_estoque_rascunho`
    (itens só mudam com o acerto em `rascunho`; a efetivação grava saldo/diferença/custo nos itens antes de mudar o
    status).
38. **EAN único entre produtos no banco** (MD 3.6.5): o MD descreve a checagem na API com `select … for update`, que
    não trava linha inexistente. Virou o trigger `tg_produtos_codigos_barras_ean_unico`: com `geral.ean_duplicado =
    'bloquear'` (padrão, sem linha em `configuracoes`) um `gtin` não excluído não pode existir em outro produto
    (`EAN_DUPLICADO`, P0001); `avisar` deixa gravar (o ERP confirma antes); a importação/migração do Nuvem3 grava
    duplicados com `set local genesis.ean_duplicado_importacao = 'on'` e emite o relatório. Roda sob a trava de
    ordenação 7300001 (a tabela desce ao PDV e o trigger de versão a pegaria de qualquer forma), o que serializa duas
    gravações do mesmo EAN. Editar outras colunas de um código já duplicado (dados migrados) não é barrado.
39. **Composição sem ciclo no banco** (MD 3.6.7, "validação recursiva na API"): o trigger
    `fn_produtos_composicao_sem_ciclo` em `produtos_componentes` e `produtos_componentes_alternativas` recusa
    (`COMPOSICAO_CICLICA`) qualquer aresta que feche um ciclo, inclusive pela alternativa de uma posição (produto da
    posição → alternativa) e com ficha técnica de produto `produzido`; também sob a trava 7300001. As demais regras de
    tipo do MD (componente de kit não pode ser kit/matéria-prima/serviço/com complementos, posição com alternativa só
    em kit com `permite_substituicao`) continuam na API. CHECKs acrescentados além do MD: perda só na ficha técnica
    (`ck_produtos_componentes_perda`), faixas de `balanca_plu`, modalidades de BC, idade mínima e quantidades
    positivas em `produtos`, vigência em banners/restrições e `ck_acertos_estoque_efetivacao` (datas coerentes com o
    status).
40. **Faixas sem sobreposição**: `ex_produtos_precos_quantidade_sobreposicao`,
    `ex_grupos_preco_quantidade_faixas_sobreposicao` (MD 3.6.9, 3.6.13) e `ex_parametros_fiscais_uf_vigencia`
    (vigência por UF, `daterange` inclusivo) com `exclude using gist` (btree_gist); erro `23P01` → 409/422 na API. A
    faixa da loja convive com a de `loja_id` nulo (a da loja prevalece no PDV).
41. **Referências da Fase 1A**: `ncms` com os 10.516 códigos de 8 dígitos da Nomenclatura vigente em 30/10/2026
    (Resolução Gecex nº 926/2026), baixada do Portal Único Siscomex (`classif/api/publico/nomenclatura/download/json`)
    e convertida em `src/database/referencias/ncms.csv` (descrição = posição/subposição + item, sem HTML); NCM que
    sair do arquivo é excluído logicamente (a atualização pela plataforma, F2-B46, é a decisão 193: o encerrado ganha
    o fim de vigência, e a carga do arquivo não desfaz a tabela mais nova da plataforma). `paises` só com o Brasil (1058) até a tabela BACEN completa entrar com a
    NF-e (o cadastro de pessoa no exterior exige o país). `cests` existe vazia (não há fonte oficial em formato de
    dados; a carga entra com a fase fiscal e, até lá, a regra "CEST de bem listado" não tem como ser checada). F2-B41
    (decisão 187): o carregador do `cests.csv` e o formato existem, e o relatório NCMs inválidos confere o CEST × NCM
    quando houver carga; a lista oficial do CONFAZ ainda não entrou (pendência na decisão 187).
    `parametros_fiscais_uf`: só o PR, em `referencias/uf/PR/parametros-fiscais.json` (vigência a partir de 3.8.2026,
    data da redação atual do art. 25, VII), com os valores marcados **[oficial]** em `docs/fiscal/nfce-parana.md`; o
    que a pesquisa não confirmou fica nulo ou no padrão da coluna e listado em `pendencias` (urlChave, cancelamento
    extemporâneo, Nota Paraná como substituto do DANFE, intervalo mínimo de status, ST retido na NFC-e, vinculação do
    pagamento). QR Code: versões aceitas `{2,3}` e padrão 3 (a SEFA-PR documenta a v3; recomendação da pesquisa: usar
    a v3 onde a UF aceitar).
42. **Seed** (MD 7.12): "SEM MARCA" e os atributos de variação Tamanho, Sabor, Cor, Volume, idempotentes como os
    demais; o tipo de estoque `vasilhame_vazio` já vinha da Fase 0.
43. **Esquema do PDV** (`gerar:esquema-pdv`): arrays (`text[]`, `smallint[]`) viram `string[]`/`short[]` (JSON em TEXT
    no SQLite, MD 4.1) e `time` vira `TimeOnly` (TEXT `HH:MM:SS`); array de `numeric` é recusado. O `Esquema.g.cs`
    agora descreve as 59 tabelas espelho; o teste do PDV só confere as que o modelo EF mapeia.

### Fase 1 – cadastros base (API)

44. **Padrão dos cadastros** (`src/comum/cadastro.ts`): listagem com os filtros da URL e `ordenar=campo:dir` validado
    por lista de colunas; detalhe com `versao`, datas e autor; alteração com `select … for update` + versão conferida →
    409 `CONFLITO_VERSAO` com quem alterou; unicidade conferida antes (409 `CONFLITO` com `campos`); exclusão lógica;
    auditoria na mesma transação; `travaVersao` em toda gravação. Os schemas `zod` ficam em `@genesis/shared` e o ERP
    valida com os mesmos. Erros do banco também viram envelope: `23P01` (faixa sobreposta) → `CONFLITO`,
    `FILTRO_IMUTAVEL` → `REGRA_NEGOCIO`, `23503`/`23514` → `VALIDACAO` (o filtro desembrulha o `DrizzleQueryError`).
45. **Subconsulta correlacionada no `select`**: o Drizzle escreve a coluna sem a tabela (`"id"`) na lista do `select`
    de consultas de uma tabela só — dentro de `(select … where t.pessoa_id = "id")` isso aponta para a tabela interna.
    Use `ref('tabela')` (`"tabela"."id"`) nessas subconsultas.
46. **`jsonb` de `configuracoes`**: o Drizzle faz `JSON.parse` de novo sobre o que o `pg` já converteu (a string
    `"1500.00"` virava o número 1500). As leituras usam `valorJson` (`valor::text` + `JSON.parse` uma vez).
47. **Versão do cadastro inteiro**: o trigger de versão não muda a linha-mãe quando só as filhas mudam (UPDATE sem
    mudança real mantém a versão). Pessoas (com categorias, endereços, telefones, e-mails) e perfis (com
    `perfis_permissoes`) expõem `versao = greatest(mãe, filhas — inclusive excluídas)`, e o 409 compara essa versão.
48. **Assistente da loja** (MD 7.13): `POST /lojas` com `estoqueId` nulo cria o estoque homônimo (tipo `deposito` para
    loja depósito; nome editável em `nomeEstoque`), o caixa 0 (`sistema`), a conta "Caixa – {loja}"
    (`chave_sistema = 'caixa_loja:<id>'`; nome repetido ganha "(2)") e as numerações. Numerações (idempotente, refeita a
    cada gravação da loja/caixa): `venda` do caixa 0 (dono `nuvem`), `nfe` modelo 55 da série da loja **no ambiente da
    NFC-e da loja** (a loja não tem ambiente próprio de NF-e), e por caixa de PDV `venda`, `vale` (dono `terminal`) e
    `nfce` modelo 65 da série do caixa — **só quando o caixa tem série** (sem série não há chave para a numeração);
    série/ambiente trocados criam a numeração nova e a antiga fica. Quem cria a loja sem ser Master ganha a loja nas
    permitidas. O código (1–99) é o seguinte ao maior já usado, inclusive de lojas excluídas (não reaproveita o código
    que compõe números de venda antigos); esgotado, o primeiro livre. Limite do plano: `empresas.limite_lojas` ??
    `planos.limite_lojas`, conferido ao criar/reativar loja ativa (`LIMITE_PLANO`).
49. **Lojas, abas desta fase**: Dados Gerais, Fiscal (só as colunas de `lojas`: regime, tipo de emissão, ambiente,
    série NF-e, prazo de cancelamento, valor que exige CPF; certificado, CSC, TEF e inutilização com a Fase 3F),
    Caixas e Parâmetros (chaves Loja = S). Anexos (logotipo/foto) dependem do envio de arquivos (`<UploadArquivo>`) e
    ficam para a próxima entrega. Inativar/excluir loja com terminal `ativo`/`desativando` → 422; excluir loja exclui
    logicamente os caixas e as numerações. Depósito não aceita caixa de PDV.
50. **Caixas**: o caixa 0 é somente leitura; série NFC-e única entre os caixas vivos da loja; nº inicial da NFC-e
    (`ultimo_numero = n − 1`) só enquanto o caixa nunca teve terminal (`terminal_id` e `terminal_anterior_id` nulos);
    trocar a série com terminal ativo é recusado (série nova na substituição, SYNC 13).
51. **Locais de estoque** não têm `loja_id`. Até a 0018, quem não enxergava todas as lojas via os estoques sem loja e
    os das lojas permitidas; desde o F2-B5 vale só a lista de estoques permitidos (`usuarios_estoques`, inclusive o
    CD; decisão 149). Inativar exige saldo zero (`saldos_estoque`) e nenhuma loja ativa vinculada; excluir é bloqueado com
    loja vinculada ou movimentos (a checagem de "transferência em trânsito" entra com as transferências, Fase 2).
    Excluir encerra, na mesma transação, os vínculos dos usuários com o estoque (`usuarios_estoques`).
52. **Empresa**: o PUT exige o cadastro completo do ERP 10.1 (razão social, fantasia, CNPJ e endereço obrigatórios);
    CNPJ só o Master altera; `email_contador` aceita lista (vírgula/ponto e vírgula) gravada como "a, b" (a coluna é
    `varchar(254)`). Razão social, fantasia e CNPJ são replicados para `genesis_control.empresas` **depois** do commit
    da empresa (bancos diferentes; a próxima gravação corrige uma falha da réplica) e o cache do resolvedor é limpo.
53. **PIN do PDV** (`PUT /usuarios/:id/pin`, o próprio usuário ou quem tem `usuarios.editar` sobre um subordinado):
    regras da SYNC 4.3 em `validarPin` (`@genesis/shared`, mesmo código na tela); PIN curto conforme
    `pdv.permite_pin_curto` **da empresa** (a chave aceita valor por loja, mas o PIN é do usuário, não da loja). Hash
    argon2id com os parâmetros da SYNC 4.2 (m = 64 MiB, t = 3, p = 1, hash 32) — a senha do ERP continua com m = 19 MiB
    (decisão 13; nunca desce). O node-argon2 escreve `m=,p=,t=`; o hash do PIN é regravado na ordem canônica do PHC
    (`m=,t=,p=`), a única que o `crypto_pwhash_str_verify` do libsodium no PDV lê. A senha de liberação da forma de
    pagamento e a senha do cliente do crediário usam o mesmo hash do PIN.
54. **Usuários – restante do ERP 11.2**: RG, endereço, totem (sem perfil), estoques adicionais (`usuarios_estoques`),
    salário só com `usuarios.ver_dados_rh` (sem a permissão o valor nem volta nem é alterado), redefinir senha
    (provisória exibida uma vez, encerra as sessões, zera o bloqueio; ninguém redefine a própria), ajustes
    individuais (`GET|PUT /usuarios/:id/permissoes`, `usuarios.permissoes`, escalada: só concede o que tem; ninguém
    altera as próprias; Master não tem ajuste). Sessões ativas/últimos logins (aba Acessos) ficam para depois.
55. **Perfis**: alterar as permissões incrementa `permissoes_versao` dos usuários do perfil e audita
    `permissoes_alteradas` (incluídas/removidas); escalada como nos usuários (quem não é Master não acrescenta
    permissão que não tem; manter as já existentes é permitido); excluir com usuários → 422; perfis do seed são
    editáveis e excluíveis (o seed não os ressuscita, decisão 10).
56. **Formas de pagamento**: as regras dos CHECKs do MD 3.10.1 são repetidas no `zod` com mensagem por campo; meio
    fiscal inativo só é aceito se a forma já o tinha (migração do Nuvem3); plano de contas analítico, de receita (ou de
    despesa para `consumo_interno`); descrição única por loja (`loja_id` nulo = todas). Exclusão lógica livre até a
    tabela de vendas existir (depois: forma com vendas só inativa). Filtro de loja: forma de loja fora das permitidas
    some da listagem e dá 403. Desde o C8b (decisão 136), as lojas da forma estão em `formas_pagamento_lojas` e a
    descrição é única na empresa.
57. **Configurações**: `GET /configuracoes?grupos=&lojaId=` devolve o valor efetivo, o padrão, o valor da empresa e o
    da loja e quantas lojas sobrepõem; `PUT` com `null` = voltar ao herdado. No escopo empresa um valor igual ao padrão
    **exclui** a linha (só existem linhas diferentes do padrão, ERP 9.0); na loja, "Personalizar" grava mesmo igual. A
    exclusão é lógica (a tabela desce ao PDV e precisa do tombstone). Chaves `fiscal.*`/`tributacao.*` exigem
    `configuracoes.editar_fiscal`; segredos (nenhum no catálogo ainda) terão rota própria. Um "nulo explícito" na loja
    sobre valor da empresa (ex.: tirar o limite de sangria só numa loja) não é possível — nulo é "herdar".
58. **Atalhos do PDV**: só os da empresa (`loja_id` nulo); atalhos por loja ficam para quando houver pedido. Teclas
    aceitas (PDV 28.3, ajustado ao seed MD 7.8, que usa `Shift+F4`, `Ctrl+Espaço` e `Ctrl+Shift+T`): `F1`–`F12` com ou
    sem modificadores, letra/dígito/Espaço com Ctrl ou Alt (+ Shift); Shift sozinho com letra e `Alt+F4` são
    recusados; a forma é canônica (`Ctrl+Alt+Shift+X`). A gravação desabilita primeiro as linhas que mudam e depois
    aplica os valores, para trocar teclas entre ações numa vez só sem violar `uq_atalhos_pdv_tecla`.
59. **Pessoas**: filhas gravadas junto (linhas com `id` atualizadas, novas inseridas, as que saíram excluídas
    logicamente; "principal" é desligado antes para trocar entre linhas sem violar os índices parciais); `busca` =
    nome + apelido + documento sem acento (filtro Nome usa o índice trigram); CPF/CNPJ repetido → 409 com
    `detalhes.pessoaId` para o link; limite de compras e bloqueio exigem `pessoas.editar_credito`; exclusão bloqueada
    com parcelas em aberto ou usuário vinculado (vendas a prazo e documentos fiscais entram com as fases deles). O
    telefone aceita "(41) 99999-0000" num campo só (DDD = 2 primeiros dígitos). Abas Vendas e Financeiro/Total,
    anonimização (LGPD), consulta de CNPJ e o alerta de mesmo nome + telefone ficam para depois.
60. **CEP** (`GET /utilitarios/cep/:cep`): ViaCEP com 3 s de limite, cache de 24 h em memória; falha, demora ou CEP
    inexistente → 404 e a tela segue com o endereço digitado. O município vem pelo código IBGE conferido na tabela
    local. Em produção sem saída para a internet, `CEP_CONSULTA_URL=desligada`.
61. **Categorias**: `caminho` com ids, `caminho_nomes` e `nivel` recalculados na subárvore ao mover ou renomear;
    profundidade conferida com a altura da subárvore; mover para dentro de si → 422. A edição (`PUT`) não muda o pai: é
    o `POST /:id/mover` (arrastar e soltar). Excluir com produtos exige `?confirmar=true` e remove só os vínculos.
62. **Marcas**: descrição única sem acento/caixa (`fn_unaccent`); "Mesclar" exige `marcas.editar` e `marcas.excluir`
    e move os produtos (inclusive inativos) antes de excluir as origens. O logotipo depende do envio de arquivos.

### Fase 1 – produtos (API)

63. **Um "Gravar" para o produto inteiro** (`PUT /produtos/:id` com as filhas, ERP 8.2): códigos de barras da unidade
    (os das variações, Fase 2, ficam como estão), `produtos_lojas` por loja (`loja_id` imutável: a linha é da loja;
    lojas fora das permitidas não podem ser enviadas — 403 — e as linhas delas são preservadas), faixas de preço por
    quantidade (a faixa que mudou é excluída logicamente e recriada: o `exclude` de sobreposição não é adiável e
    nenhuma ordem de `UPDATE` cria sobreposição transitória), categorias N:N com a principal, posições do combo /
    insumos da ficha técnica e alternativas (exclusões primeiro, depois alterações e inclusões). A versão do 409 é a
    agregada (produto + filhas, decisão 47). `busca` = nome + código + código interno + códigos de barras.
64. **Custo do combo automático** (MD 3.6.3 regra "Kit"; ERP 8.2.17; roadmap D16): migração
    `0005_produtos_custo_combo` com `fn_recalcular_custo_kits(uuid[])` e os triggers `tg_produtos_componentes_custo_kit`
    (posição criada/alterada/excluída), `tg_produtos_custo_kit` (`preco_custo`/`custo_medio` de um componente padrão ou
    `preco_venda`/`tipo` do próprio combo) e `tg_produtos_variacoes_custo_kit`. Assim **qualquer** caminho que mude o
    custo (cadastro, recebimento, NF-e, projeção do custo médio, importação, `UPDATE` manual) recalcula o combo na
    mesma transação, como o MD pede, sem depender de cada serviço lembrar de chamar. `preco_custo` = Σ (custo do padrão
    — o da variação, se houver — × qtd), `custo_medio` = Σ (custo médio do padrão × qtd), `markup_pct` acompanha;
    alternativas não entram (o custo da venda é o dos escolhidos); o preço nunca é derivado. `CustoCombos`
    (`src/produtos/custo-combo.ts`, em `Servicos`) é a porta da API para o mesmo cálculo (chamado ao gravar o combo e
    `recalcularTodos` para conferência depois de cargas). A API ignora custo/markup enviados para o combo. O custo
    recalculado pelo banco entra em `produtos_historico_precos` (decisão 97).
65. **EAN** (ERP 8.2.1, 8.2.3; MD 3.6.5): DV GTIN-8/12/13/14 no `zod` compartilhado (`validarGtin`); duplicidade
    conferida na API só para códigos novos ou alterados do produto (dado migrado já duplicado não trava outras
    edições, decisão 38): `bloquear` → 409 `CONFLITO` com o campo `codigosBarras.N.codigo` e
    `detalhes.eanDuplicado = { modo, confirmar: false, duplicados }`; `avisar` → 409 com `confirmar: true` e a
    mensagem "O EAN … já está no produto X. Gravar mesmo assim?"; o ERP reenvia com `confirmarEanDuplicado: true`. O
    trigger da 0004 continua como rede (`EAN_DUPLICADO` → 409). `GET /produtos/verificar-ean` responde DV, modo e
    duplicados; `GET /produtos/codigo-interno-livre` dá o próximo `2` + 11 dígitos + DV (formato EAN-13, `interno`).
66. **Composição** (MD 3.6.7): regras de tipo na API (componente/alternativa de combo não pode ser combo,
    matéria-prima, serviço nem com complementos; insumo de ficha técnica só matéria-prima ou simples; com variações
    exige a variação; nunca o próprio produto) e as de forma no `zod` (combo com ≥ 1 posição, "Permite troca" ⇔ ≥ 1
    alternativa, alternativa ≠ padrão e sem repetir, perda só na ficha). Como combo não contém combo, ciclo só é
    possível pela ficha técnica: o trigger `COMPOSICAO_CICLICA` vira 422 `REGRA_NEGOCIO` em `componentes`. A mesma
    posição pode repetir o produto padrão (duas posições "Gelo de sabor"). O combo mantém `controla_estoque` como
    vier (não é usado: a venda baixa os componentes).
67. **Tributação e emissão** (MD 3.6.3): NCM precisa existir em `ncms`; é obrigatório quando há loja ativa com
    `tipo_emissao <> 'nao_fiscal'`, exceto combo (não vai para a NFC-e), serviço e matéria-prima. CFOP dentro do
    estado 5xxx e fora 6xxx (e existentes), 5405 ⇔ CST 60/CSOSN 500, CEST obrigatório com CST/CSOSN de ST (no
    `zod`). No combo, componente ou alternativa sem NCM válido ou com CFOP × CST incoerente aparece em
    `avisos` do detalhe (não bloqueia, ERP 8.2.17). Ficam para a fase fiscal: tributação por UF
    (`produtos_tributacao_uf`), "Sugerir pela regra da UF", cBenef × `beneficios_fiscais_uf`, CEST × NCM (a tabela
    `cests` está vazia, decisão 41) e o ST retido por loja manual.
68. **Permissões de custo e preço**: sem `produtos.ver_custo` custo, custo médio e markup voltam `null` (listagem,
    detalhe, busca, saldos), o custo enviado é ignorado e ordenar por custo é 403. Com `geral.altera_preco_produto_erp
    = false`, alterar preço do produto, da loja, das faixas ou o preço adicional dos complementos (F2-B51, decisão
    194) exige `produtos.alterar_preco` (403); na criação o preço é livre (é obrigatório). Preço de venda > 0 exceto matéria-prima.
69. **Troca de tipo com movimento** (ERP 8.2.1): só entre Simples, Matéria-prima e Serviço, e Serviço só sem saldo.
    **Exclusão** (ERP 8.2 "Regras"): bloqueada com saldo ≠ 0 ou se o produto é padrão/alternativa ativa de combo ou
    insumo de ficha técnica de produto não excluído; exclui logicamente as filhas junto.
70. **Saldos** (`GET /produtos/:id/saldos`, ERP 8.2.11): por estoque × tipo, custo médio ponderado pelas linhas com
    saldo positivo, últimas entrada/saída; estoques de lojas fora das permitidas não aparecem (decisão 51). Combo:
    combos montáveis por estoque das lojas ativas, com saldo só dos tipos vendáveis (`combosMontaveis` de
    `@genesis/shared`). Saldo em trânsito (e a divergência a tratar) entrou com as transferências (F2-B26, decisão
    174); o "Ajustar" rápido entrou na Fase 2 (F2-B12, decisão 157).
71. **Grupos de preço por quantidade** (ERP 8.10; MD 3.6.13): `produtos` do corpo é o conjunto completo dos membros
    (inserir/remover), conferido por tipo, sem fração e mesma unidade entre todos; produto de outro grupo → 409 com
    `detalhes.moverDeOutroGrupo` até vir `confirmarMover: true`. O produto também valida o vínculo pelo lado dele
    (unidade dos demais membros). Modo `produto` exclui as faixas; excluir o grupo desvincula os membros. Versão =
    grupo + faixas. Permissões novas no catálogo (ERP 11.4): `grupos_preco.ver/editar` e
    `restricoes_horario.ver/editar` (Gerente: todas; Estoquista: ver).
72. **Restrições de horário** (ERP 8.9; MD 3.6.12): `loja_id` só na criação (o `PUT` não o aceita, MD 6.4 regra 2);
    restrição de loja fora das permitidas some e dá 403; horas como `HH:MM:SS`; dias da semana ordenados sem
    repetir (vazio = todos).
73. **Duplicar** (`/produtos/:id/duplicar`, ERP 8.2) é feito no ERP: o formulário abre como novo com os dados
    copiados (sem códigos de barras, código interno e ids das filhas) e o usuário grava pelo `POST`; o
    `POST /produtos/:id/duplicar` listado no ERP 8.2 não foi criado (gravaria uma cópia sem revisão).
74. **Fora desta entrega** (Fase 2 do roadmap ou fiscal): variações e "Gerar variações", complementos, relacionados
    (entraram no F2-B12, decisão 157),
    validade/lotes, fornecedores (entraram no F2-B13, decisão 158), imagens/foto, impressora destino, tributação por UF, histórico de preços por faixa
    (`quantidade`), `POST /produtos/:id/variacoes/gerar`. Enquanto variações e complementos não chegam, os dois tipos
    ficam travados na criação (decisão 145).

### Fase 1 – estoque, importação e dashboard (API)

75. **Acerto de estoque** (ERP 13.5; MD 3.7.5): o rascunho grava cabeçalho + itens (`gravarItensRascunho`: mantidos
    atualizados, saídos excluídos logicamente, novos com a próxima sequência) e recalcula os totais com o saldo e o
    custo médio do momento; a versão do documento é a maior entre cabeçalho e itens. **Efetivar** trava o acerto,
    trava os saldos em ordem estável (evita deadlock entre acertos simultâneos), lança um movimento por item
    (`ACERTO_ENTRADA`/`ACERTO_SAIDA`/`ACERTO_DEFINIR`; diferença zero não gera movimento) com o custo gravado, atualiza
    `saldos_estoque` e grava saldo anterior, diferença e custo nos itens **antes** de mudar o status (o trigger só deixa
    mexer em itens de rascunho) — tudo na mesma transação com a trava de versão. Entrada: custo digitado ou custo
    médio (ou o custo do cadastro sem saldo); Saída/Definir: custo médio vigente. Saída que deixaria saldo negativo só
    com `estoque.permite_negativo_erp` ou Master (422 por item). **Estorno**: `ESTORNO_ACERTO` de sinal oposto por
    movimento, com motivo (a mudança de tipo, desde o F2-B8, pelo par invertido: decisão 153). Rascunho pode ser excluído (lógico); efetivado/estornado é imutável (409/422). Desde o
    F2-B4 (decisão 148), a Entrada e a Saída lançam no momento da efetivação (a `data_contagem` é a "Data" do
    cabeçalho) e só o "Definir" lança na hora da contagem.
76. **Definir** (ERP 13.1.5): na efetivação a diferença é `contado − (saldo atual − Σ movimentos com data depois da
    contagem)`, então vendas posteriores à contagem não são "desfeitas". A compensação dos eventos do PDV que chegam
    depois da efetivação (`ACERTO_COMPENSACAO`) **já existe desde a 1C** (T23; decisão 133), na venda, no cancelamento e
    na devolução de cascos, e o estorno do "Definir" estorna as compensações. Desde o F2-B4 a compensação é do motor
    (`estoques/compensacao.ts`) e vale também para o próprio acerto, com a regra de data dos documentos do ERP
    (decisão 148).
77. **Saldos** (`GET /saldos-estoque`, ERP 8.2.11/16.4 simplificado): por estoque × tipo, filtros de situação do saldo
    (positivo, zerado, negativo, abaixo do mínimo da loja do estoque) e "incluir sem movimento"; totais de custo e
    venda na mesma consulta; custo só com `produtos.ver_custo`. `GET /saldos-estoque/itens` alimenta a coluna "Saldo
    atual" da grade do acerto. O ajuste no clique, "Em trânsito" e a data-base ficam com o relatório Estoque Atual
    (o "Em trânsito" chegou aqui também no F2-B26, decisão 174; o relatório, no F2-B31, decisão 178).
78. **Importação** (ERP 8.6, 23.14): `previa` (multipart `arquivo` + opções, até 10 MB, xlsx ou csv com `;`/`,`/tab
    detectado e UTF-8 ou Windows-1252) valida **todas** as linhas sem gravar e guarda a planilha no armazenamento
    (`arquivos`, categoria `planilha_importacao`, retenção 30 dias); `confirmar` só aceita a planilha enviada pelo
    próprio usuário e cria a tarefa (ERP 3.6), que relê o arquivo, refaz a análise com o banco do momento e grava
    linha a linha numa transação curta cada (uma linha com erro não derruba as outras). O executor monta a sessão do
    usuário da tarefa com as permissões **do momento** (perdeu `produtos.importar` → a tarefa falha).
79. **Colunas** (`packages/shared/importacao.ts`): nosso layout (8.5, "ida e volta") e os nomes do Nuvem3 (Id Produto,
    Ref. Interna, Código de Barras, Produto, Departamento, Preço Custo, Venda, Est. Mínimo, Est. Atual…) comparados sem
    acento, caixa e pontuação; colunas desconhecidas são listadas como ignoradas. Números aceitam `1.234,56`,
    `R$ 9,90` e célula numérica; EAN/NCM numéricos do Excel viram texto sem perder dígitos.
80. **Identificação e gravação de produtos**: `id` → `codigo` (decisão 102) → `codigo_interno` → `ean` (pelo EAN só se a linha não traz código
    interno ou o produto achado não tem um — com códigos internos diferentes é outro produto com EAN duplicado, comum
    no Nuvem3). Criar passa pelo `criarProdutoSchema` inteiro; atualizar parte do detalhe gravado
    (`entradaDoDetalhe`) e troca só as colunas presentes, pela mesma rotina do formulário (`inserirProduto`/
    `atualizarProduto`, extraídas do controller), com auditoria de origem `importacao`. "Atualizar preços" desligado
    ignora custo, markup e preços em produto existente; preço zerado na planilha mantém o atual. Produto com
    variações não é criado pela planilha (a grade fica no ERP); combo entra pela coluna `composicao` (decisão 95).
81. **Inconsistências do relatório** (roadmap Fase 1 "carga do Nuvem3"): **EAN duplicado** (em outro produto ou
    repetido na planilha) é gravado com `genesis.ean_duplicado_importacao` e avisado; **EAN inválido** vira código
    de barras `interno`; **NCM inválido/ausente** grava o produto sem NCM mesmo com loja fiscal (`ncmOpcional` só na
    importação: a emissão recusa o item até o cadastro ser corrigido) e entra no card do dashboard; **sem preço**
    impede só a criação (não existe produto vendável com preço zero); marca/categoria inexistente é criada (opção
    "Criar marcas e categorias", caminho `A > B` até 5 níveis) ou avisada. Unidade inexistente, número inválido e
    código interno repetido na planilha impedem a linha. O relatório final (xlsx no armazenamento, link na tarefa)
    traz só as linhas com erro ou aviso.
82. **Estoque pela planilha** (8.6): "Atualizar estoque" gera **um** acerto "Definir" efetivado (`origem
    importacao`, motivo "Importação de planilha", movimento `AJUSTE_IMPORTACAO`) no estoque da loja escolhida, com os
    produtos gravados que controlam estoque (até 5.000 itens por acerto); "Atualizar estoque mínimo" e o preço da loja
    vão para `produtos_lojas` da loja escolhida.
83. **Clientes**: identificação `id` → CPF/CNPJ → código; tipo pela coluna ou pelo tamanho do documento; documento
    inválido grava sem documento (aviso); endereço só completo e com a cidade achada no IBGE por nome + UF (aviso
    "Cidade não encontrada"); telefone e e-mail inválidos são avisados e descartados; limite de compras só com
    `pessoas.editar_credito`; `pessoas.origem = 'importacao'`. Na atualização o endereço principal, o telefone e o
    e-mail da planilha passam a principais e os demais são mantidos.
84. **Dashboard** (`GET /dashboard?mes=&lojaId=`, ERP 6): pessoas ativas/novas no mês, produtos ativos/sem preço/NCM
    inválido, vendas do dia e do mês por loja e por dia do mês (**zero** até a aplicação das vendas do PDV, que é o
    próximo item do roadmap), PDVs (online = contato há menos de 2 min, o `LIMIARES_CONEXAO` da tela de Terminais, decisão 110) com `terminais.ver`, estoque abaixo do mínimo
    (top 10, tipos vendáveis) com `estoque_saldos.ver`, financeiro (zero, Fase 4) só com `dashboard.ver_financeiro`.
    Cache em memória por instância de 60 s (`DASHBOARD_CACHE_MS`).

### Fase 1 – políticas de acesso e pendências (API)

Política adotada e o teste que cobre cada caso (revisão de segurança da Fase 1A; o arquivo
`test/integracao/revisao-acesso.test.ts` reúne os casos de acesso).

85. **Permissões da importação** (ERP 8.6, 11.2, 11.4). `produtos.importar`/`pessoas.importar` abrem a prévia e a
    confirmação e são conferidas de novo com as permissões do usuário no momento da execução (decisão 78). A planilha
    não faz o que o mesmo usuário não faria no formulário: linha `criar` sem `produtos.criar`/`pessoas.criar` e linha
    `atualizar` sem `produtos.editar`/`pessoas.editar` viram erro da linha; custo e markup só com `produtos.ver_custo`;
    preço com a regra de "Altera Preço do Produto no ERP"; "Criar marcas e categorias" cria marca só com `marcas.criar`
    e categoria só com `categorias.editar` (sem elas, aviso de inexistente, como com a opção desligada); "Atualizar
    estoque" exige `estoque_acertos.criar` (403 na prévia, na confirmação e na execução) e o acerto da importação
    respeita `estoque.permite_negativo_erp` (ou Master), como o manual; limite de compras só com
    `pessoas.editar_credito`; loja da importação dentro das permitidas, conferida também na execução (perdeu a loja
    depois de confirmar → a tarefa falha). `confirmar` só aceita a planilha enviada pelo próprio usuário na prévia do
    **mesmo tipo** (`arquivos.entidade`) e o relatório final é gravado como `planilha_exportacao` (não pode ser
    "confirmado"). Testes: "Estoquista: sem marcas.criar…" e "erros do arquivo e permissões"
    (`importacao-dashboard.test.ts`).
86. **Ajustes individuais e "negar"** (ERP 11.2; erp-web decisão 3). Para quem não é Master vale o **resultado
    efetivo**: com os ajustes novos e o perfil do alvo calcula-se `calcularPermissoesEfetivas`; toda permissão que o
    alvo passa a ter (por `conceder` ou pela retirada de um `negar`) precisa estar nas do editor (403 com a lista).
    Pôr `negar` é sempre permitido. Na troca de perfil (`PUT /usuarios/:id`) o perfil inteiro precisa estar nas
    permissões do editor (`garantirPerfil`, mais estrito que o resultado efetivo). Teste: "retirar o negar…".
87. **Usuário com lojas restritas × linhas sem loja** (`loja_id` nulo = todas as lojas). Faixas do produto (MD 3.6.9),
    faixas do mix (MD 3.6.13) e restrições de horário (MD 3.6.12) com `loja_id` nulo são vistas e alteradas por quem
    tem a permissão do cadastro, mesmo com lojas restritas, como as formas de pagamento (decisão 56) e a auditoria
    sem loja (decisão 15): regra da empresa, não de uma loja. Os membros do mix também (o grupo não tem loja). As
    linhas **de uma loja** seguem as lojas permitidas (decisão 88).
88. **Linhas de outras lojas no produto e no mix** (ERP 8.2.9, 8.2.10, 8.10). O detalhe (`GET /produtos/:id`,
    `GET /grupos-preco-quantidade/:id` e o resumo da listagem) **não mostra** `produtos_lojas` nem faixas de lojas fora
    das permitidas; a gravação as **preserva** (só remove o que é da loja permitida ou sem loja) e enviá-las dá 403.
    Mudar o grupo para o modo "por produto" (que apaga todas as faixas) com faixa oculta → 403. A regra de alterar
    preço compara só as faixas visíveis. Testes: "o detalhe esconde a loja 2…" e "mix: faixa da loja 2…".
89. **Estoques permitidos** (ERP 2.1 "Estoques permitidos"). `usuarios_estoques` segue a regra das lojas
    (`resolverLojas`): o editor só concede/retira estoques que enxerga (`estoqueVisivel`; estoque fora dos estoques
    permitidos dele → 403) e os invisíveis que o usuário já tinha são preservados; usuário com estoque que o editor não
    vê conta como "mais acesso" (`garantirAlvoSubordinado`). Desde o F2-B5 o `estoqueVisivel` lê `usuarios_estoques`
    (`estoques/permitidos.ts`, decisão 149; até a 0018 ele seguia as lojas permitidas): o editor só concede o que está
    nos estoques permitidos dele (Master e `estoques.todos`, todos), e a lista do usuário é a única que vale, sem
    herdar das lojas. O vínculo com estoque excluído não conta (nem no detalhe nem na escalada), como na lista da
    sessão; `estoques-permitidos.test.ts` cobre a escalada por id e por filtro.
90. **`pessoas.senha_hash` no fluxo `pessoas`** (SYNC 4.1, 4.3 item 4). Projeção condicional em `src/sync/fluxos.ts`:
    desce só com `pdv.crediario_exige_senha_cliente` efetiva da loja do terminal (loja ?? empresa ?? padrão, em SQL) e
    crediário habilitado (`coalesce(limite_compras, financeiro.limite_credito_padrao) > 0` e não bloqueada); senão
    `null`. Mudar limite/bloqueio gera versão nova da pessoa (toque); mudar uma das duas configurações (empresa ou
    loja) toca as pessoas com `senha_hash` (na loja, só as relevantes para ela), se houver terminal ativo no escopo
    (decisão 124). Testes: "pessoas.senha_hash só desce…" e "trocar a exigência de senha…" (`sync.test.ts`).
91. **Pendências de cadastro desta fase** (roadmap Fase 1 › ERP – cadastros base, itens "parcial"): **Anexos** da loja
    (logotipo/foto; também os de marca/categoria) esperam o envio de arquivos → Fase 2, com as imagens do produto (os
    da loja e o envio ficaram prontos no F2-B43, decisão 189; os de marca e categoria são o F2-B44);
    **variações na importação** → importação completa da Fase 2 (o combo entra, decisão 95); **Tipos de estoque**: tela
    somente leitura `/estoque/tipos` (o CRUD do ERP 13.6 é da Fase 2); **ficha técnica**: o cadastro está pronto e
    segue a interpretação adotada da **D17** (produto `produzido` não tem saldo próprio — acerto e importação recusam
    — e a venda baixa os insumos); a baixa (`BAIXA_INSUMO`/`ESTORNO_BAIXA_INSUMO`) entra com a aplicação da venda e
    ainda depende da confirmação da D17 pelo dono (roadmap seção 16).
92. **Usuários são dados da loja** (LGPD; ERP 11.1). Para quem tem lojas restritas, `GET /usuarios`, `/exportar`,
    `GET /usuarios/:id` e `/:id/permissoes` mostram só os usuários com alguma loja em comum, os sem loja (não Master) e
    o próprio; Master e usuários só de outras lojas ficam ocultos (404 no detalhe). As gravações já exigiam o alvo
    subordinado. Teste: "restrito à loja 1 não lista…".
93. **Limites de recurso do processo** (o processo é de todas as empresas). Semáforo global para o argon2
    (`ARGON2_CONCORRENCIA`, 4: o PIN usa 64 MiB) e para a leitura de planilha (`PLANILHA_CONCORRENCIA`, 2); limite por
    usuário e por minuto nas rotas que geram hash fora do login (`PUT /usuarios/:id/pin`, senha do cliente em
    `POST/PUT /pessoas`, senha de liberação da forma de pagamento: `HASH_LIMITE_POR_MINUTO`, 10) e na prévia da
    importação (`IMPORTACAO_PREVIAS_POR_MINUTO`, 10), 429 acima. Em memória da instância, como o throttler do login.
    Planilha: o `.xlsx` (zip) tem o diretório central conferido antes do `readSheet` — até 100 entradas, 120 MiB por
    entrada, 150 MiB no total e taxa ≤ 100:1 acima de 1 MiB — e cada entrada é descompactada de verdade com
    `maxOutputLength` = tamanho declarado (cabeçalho mentiroso é recusado); o CSV conta linhas com dados
    (≤ limite + 1), linhas físicas (≤ 2 × limite) e colunas (≤ 300) **durante** a leitura. O tipo do objeto no
    armazenamento vem do conteúdo (`formatoPlanilha`), nunca do `Content-Type` do cliente; o multer limita campos e
    partes; o erro da biblioteca vai para o log e o usuário recebe uma mensagem genérica. A leitura em `worker_thread`
    com `resourceLimits` não foi adotada: o teto de descompactação já limita a memória e o executor roda o mesmo código
    em TS (dev/teste) e JS (build). Testes: "zip-bomba…" e "PIN: limite de hashes…".
94. **Dinheiro e quantidade em decimal** (ADR-05). `@genesis/shared` exporta `Dec` (`decimal.js` com `ROUND_HALF_UP`,
    o `MidpointRounding.AwayFromZero` do PDV) e `dec`/`decTexto`/`decNumero`; as funções de `precos.ts` (margem,
    markup, "Calcular", resumo do combo, combos montáveis, Simular) e `estoque.ts` (custo médio, diferença do
    Definir, totais do acerto) calculam em decimal — as variantes `…Texto` devolvem o texto com as casas da coluna, as
    demais o `number` já arredondado (só para exibir). O razão (`movimentos.ts`) e o acerto (`acertos.ts`) andam com
    texto do `numeric` do começo ao fim (quantidade, custo unitário, custo total, custo médio, saldos e totais). A
    importação arredonda **célula numérica** do Excel às casas da coluna (`lerDecimalPlanilha`: 4 para preço/custo,
    como `numeric(15,4)` e o `CasasPreco` do PDV; 3 para quantidade) e lê o preço da loja como dinheiro (não
    negativo), não como quantidade.
95. **Combo na importação** (ERP 8.2.17; decisão 1 do dono: "grupo de itens" = combo). Coluna `composicao` (aliases
    "Componentes", "Itens do grupo", "Grupo de itens"…): `código*qtd [rótulo]` separados por `|`, `;` ou quebra de
    linha; o código é o interno, o de barras ou o número do componente (de produto já cadastrado ou da própria
    planilha — os combos são gravados por último). Posições sem alternativas (`permite_substituicao = false`; a troca
    é cadastrada no ERP). Sem a composição, o combo novo é criado **inativo** com o aviso `combo_sem_posicoes` (o
    schema aceita combo inativo sem posições; ativo exige ≥ 1). Combo existente só recebe a composição da planilha se
    ainda não tiver posições (as do ERP, com alternativas, não são trocadas). As colunas próprias da exportação de
    "grupo de itens" do Nuvem3 entram quando o arquivo real for validado na homologação (F2-Q14 = D66: até lá, o
    mapeamento provisório fica num ponto só, `MAPEAMENTO_PROVISORIO_NUVEM3`, decisão 186).
96. **Projeção `produtos.custo_medio`** (MD 3.6.3; ERP 8.2.1). Migração `0006_produtos_custo_medio_historico`: trigger
    `tg_saldos_estoque_custo_medio` recalcula, na mesma transação, a média ponderada das linhas de `saldos_estoque`
    com saldo > 0 (sem nenhuma, fica o último custo médio); o `tg_produtos_custo_kit` leva a mudança aos combos.
    Variação não tem custo médio próprio nesta fase: entra na média do produto (e o combo com componente de variação
    usa o custo médio do produto). Exclusão física de posição (`after delete`) também recalcula o combo.
97. **Histórico do custo do combo** (ERP 8.2 "alteração de preço… alimenta o histórico"). `fn_recalcular_custo_kits`
    grava `produtos_historico_precos` (`tipo_preco = 'custo'`, anterior/novo) sempre que o `preco_custo` do combo
    muda; a origem vem de `genesis.origem_preco` da transação (a importação grava `importacao`; o recebimento,
    `recebimento`, decisão 160), senão `cadastro`. Isso substitui a frase "o custo recalculado pelo trigger não gera
    histórico" da decisão 64.
98. **Avisos do combo e NCM vigente** (ERP 8.2.17; MD 3.6.3). `avisosCombo` (estruturado: produto, motivo, `fiscal`)
    cobre componente/alternativa inativo, preço de venda zero (peso zero no rateio), sem NCM, NCM fora de vigência,
    CFOP × CST e CEST ausente com ST; a gravação recusa **padrão inativo** em combo ativo e o detalhe de um produto
    inativo usado em combos avisa com a lista. "NCM existente e vigente" é um helper só (`src/produtos/ncm.ts`: não
    excluído e `vigencia_fim` nula ou futura) usado no cadastro, nos avisos, no filtro "Situação de cadastro", na
    importação e no dashboard.
99. **Acerto sem `produtos.ver_custo` e responsável** (ERP 13.5). Sem `produtos.ver_custo` o custo digitado na Entrada
    é ignorado (fica o já gravado no item ou o custo médio/de referência na efetivação): mudar o custo médio sem ver o
    custo distorceria as margens. O responsável de estoque de loja precisa ser Master ou ter a loja
    (`usuarios_lojas`); estoque sem loja (CD) aceita qualquer usuário ativo.
100. **Auditoria redigida na leitura** (ERP 17.3). `GET /auditoria` remove de `antes`/`depois` (recursivo) o salário
     sem `usuarios.ver_dados_rh`, custo/custo médio/markup/totais de custo sem `produtos.ver_custo` e filtra listas por
     loja (`lojas`, `precosQuantidade`, `faixas`) pelas lojas permitidas. O registro gravado continua completo (é a
     trilha). Testes: "auditoria do produto…" e "auditoria de usuário…".
101. **Faixa por quantidade e combos montáveis** (PDV 11.3, `FaixaPreco.Contem`). No ERP a quantidade final da faixa
     é inclusiva (6–11 vale para 11), como no PDV; entre faixas que se tocam (6–12 e 12+) vence a de maior início.
     Combos montáveis somam as posições com o mesmo componente (duas posições "Gelo de sabor" de 1 = 2 por combo). O
     Simular do grupo de preço usa os preços próprios dos membros (preço da loja simulada, promoção vigente, faixas do
     produto; `precosMembros` no detalhe) e soma as linhas do mesmo produto; continua supondo "Usa Produto Preço
     Volume" ligado e avisa as lojas em que está desligado (`GET /produtos/preco-volume`).
102. **Planilha do Nuvem3: identificação pelo código** (ERP 8.6; o dono: "a planilha cruza o IdProduto; se for o mesmo,
     edita as informações"). Ordem `id` → `codigo` (Id Produto; a coluna `IdProduto` é alias) → `codigo_interno` →
     `ean`. Na criação o código livre da linha vai para `produtos.codigo` (`inserirProduto(..., { codigo })`): os
     operadores conhecem o IdProduto do Nuvem3. A importação **não** reposiciona a sequência: quem cria sem código
     usa `proximoCodigoProduto`, que tira `nextval('seq_codigo_produtos')` e, se o número está ocupado, salta de uma
     vez (`setval`, nunca para trás) para o fim da faixa contígua ocupada — códigos baixos importados (1..15000 de outro
     sistema) não viram 15000 `nextval` nem esgotam o laço; por isso a role de runtime tem `update` só nessa
     sequência (o default da coluna fica como está; os gatilhos de versão/sync não mudam). Código não inteiro, fora do
     `integer`, repetido na planilha ou de produto excluído (o índice único inclui excluídos) é erro da linha; em
     produto existente o código nunca é trocado. Duas linhas no mesmo produto existente se sobrescreveriam: a linha que
     só chega nele pelo código interno/EAN quando outra o identifica pelo Id/código, ou a 2ª que o identifica, é erro.
     Contra cruzamento errado, aviso `codigo_conflito` (não bloqueia, requisito do dono): o código achou o produto mas
     o EAN da linha é só de outro produto, ou os nomes são diferentes (`nomesParecidos`: palavras de 3+ letras sem
     dígitos, sem o prefixo de categoria "CERVEJA - " do Nuvem3 e sem as genéricas de embalagem — LATA, LONG, NECK,
     SEM, GAS, ZERO, COLA…; parecidos = mesma 1ª palavra, em geral a marca, ou Jaccard ≥ 0,5, com abreviação de 4+
     letras valendo como a palavra), ou a linha traz um código diferente do produto achado pelo Id/código interno/EAN. `CodigoInterno` com GTIN (outro EAN do produto): o PDV
     (`CatalogoLocal.ResolverAsync`: código de barras e, sem ele, código interno/código numérico) e a busca da API
     (`busca` inclui o código interno) já acham o produto ao bipar — não é duplicado como código de barras.
103. **"O que muda" e `sem_alteracao`** (ERP 8.6 edição em massa). A análise carrega o estado gravado dos candidatos
     (`carregarEstado`: colunas, categorias, códigos de barras, posições do combo e, da loja escolhida, estoque
     mínimo, preço e saldo no tipo de estoque padrão) e `compararComAtual` compara campo a campo — decimais com
     `mesmoDecimal` (`decimal.js`, 2,5 = 2,50; nunca `number`), unidade/categorias/marca por id, o EAN da planilha só
     muda se o produto ainda não o tem — **tirando da linha** o que é igual. Sobra diferença → `atualizar` com
     `alteracoes: [{campo, rotulo, de, para}]` (já formatadas em pt-BR para a tela e o relatório) e a gravação recebe
     só esses campos sobre o detalhe atual; nada mudou → `sem_alteracao`, que a tarefa pula (sem auditoria, sem
     `versao` nova, sem item no acerto). Só o estoque mudou → só o acerto, o cadastro não é regravado. Sem
     `produtos.ver_custo` o custo/markup não entram na comparação (a prévia revelaria o custo; a gravação já os
     ignora). A prévia ordena: erros, depois o que será gravado, depois o igual. `Excluir` afirmativo (S, Sim, X, 1,
     true) em produto existente ativo = ação `inativar` (só `ativo = false`, histórico preservado, as outras colunas
     da linha não valem; já inativo = `sem_alteracao`); em produto que não existe = `ignorar` com aviso
     `exclusao_sem_produto`. Resumo e resultado ganham `sem_alteracao`/`inativar` (`semAlteracao`/`inativados`).
     Produto que não controla estoque (`controla_estoque = false`): o estoque atual sai do diff (o acerto não o
     lançaria; sem isso a linha seria um `atualizar` fantasma a cada reimportação). A tela abre no filtro "Com erro"
     só se alguma linha tem erro (`ignorar` também conta o Excluir sem produto, que não tem erro). Os clientes ganharam
     o mesmo "Sem alteração" e "O que muda" no F2-B40 (decisão 186).
104. **Formato do Nuvem3 nas colunas** (`packages/shared/importacao.ts`). Categoria em lista (`CERVEJA,`,
     `MERCEARIA,PIPOCA,`) separada pela vírgula **não** seguida de espaço (`NICSALTS, JUICE E PODS,` é uma só), a 1ª é a
     principal, cada item pode ser caminho `A > B`; um nome só também acha a única subcategoria com esse nome — com o
     id, que segue junto dos caminhos a criar (`categoriaNova: [{id, caminho}]`) para `criarMarcasCategorias` não a
     recriar na raiz quando outra categoria da mesma célula é nova; no máximo 50 por célula (o limite do formulário),
     conferido antes de criar qualquer uma. Unidade
     por sigla, descrição de `unidades_medida` ou sinônimo (`SINONIMOS_UNIDADE_PLANILHA`: Unidade→UN, Conjunto→CJ,
     Pacote→PCT…; todas já estão no seed `UNIDADES_MEDIDA_PADRAO`, nada a semear). NCM de 7 dígitos ganha o zero à
     esquerda (só capítulos 01–09 perdem um zero). `EstoqueAtual` negativo é aceito com aviso `estoque_negativo` e o
     "Definir" leva o saldo a ele: a migração `0007_acerto_definir_negativo` troca o `ck_itens_acerto_estoque_quantidade`
     por um trigger que só aceita quantidade negativa em acerto `definir` (o formulário continua ≥ 0 no schema). Vale a
     regra da Saída manual: só com Master ou `estoque.permite_negativo_erp` da loja; sem isso a análise não lança o
     saldo negativo (aviso "não lançado") e `efetivarAcerto` recusa "Definir" com alvo negativo.
     `UsaNoMenuDigital` → `usa_menu_digital`; `UsaBalancaEtiquetadoraStr` → `balanca_tipo` (Peso/Sim = `peso`,
     Unidade = `unidade`, Não = `nao_usa`) — **provisório**: a coluna veio vazia na exportação real e não se sabe que
     textos o Nuvem3 escreve nela; **pendência**: confirmar com o dono uma exportação com a coluna preenchida (e só
     então aceitar `S`/`N` ou outros textos; os textos ficam em `MAPEAMENTO_PROVISORIO_NUVEM3`, decisão 186). `PrecoPJ` não tem equivalente (não há preço para pessoa jurídica) e fica
     ignorada com o motivo na prévia (`COLUNAS_SEM_EQUIVALENTE`). Validado com a planilha real do cliente (1.664
     produtos, não versionada): 1.664 criar; reimportação 100% `sem_alteracao`.

### Fase 1B – sincronização real (API)

Bloco B1 do plano da 1B (contratos compartilhados e correções de base) e as decisões do dono de 30/10/2026
(roadmap, seção 16: D18–D21).

105. **Contratos do sync no `@genesis/shared`** (SYNC 17). Os schemas zod das requisições e, agora, das **respostas**
     (`ativar`, `estado`, `pull` com `desde`/`cursor_teto`, `push`, `heartbeat`, envelope de erro) ficam em
     `packages/shared/src/sync/contratos.ts`; `src/sync/contratos.ts` só reexporta e mantém `validarSync`, e
     `FLUXOS` também mudou para lá (`fluxos.ts` reexporta). As respostas são `strictObject` e os serviços do sync
     retornam os tipos inferidos delas (`RespostaAtivacao`, `RespostaEstado`…): campo novo na API sem o schema não
     compila, e `test/integracao/sync.test.ts` passa toda resposta real pelos schemas. As fixtures de
     `packages/shared/testes/sync/*.json` (ativação, estado, pull com tombstone, lote de push com hash JCS, heartbeat e
     envelopes de erro) rodam no Vitest do shared e no xUnit do PDV (`GenesisPDV.Sync.Tests`, por link no csproj); o
     corpo da ativação do teste de integração sai da fixture. As requisições continuam `z.object` tolerante (a API
     ignora campo desconhecido), então o Vitest confere que o parse não descartou nenhuma chave das fixtures de
     requisição: chave com nome errado na fixture e no record C# não passa calada. O caso `IP_BLOQUEADO` de `erros.json`
     traz o `Retry-After` (o mesmo que a API manda, conferido no teste de integração), lido pelo cliente do PDV.
106. **Substituição de terminal** (SYNC 3.4, 13.3). Dois defeitos corrigidos em `src/sync/ativacao.ts`: (1) no 1º commit
     o antigo ia para `desativando` já apontando `substituido_por_terminal_id` para um id que ainda não existia (a FK
     não é adiável → 500); agora o status muda antes do insert do novo e o ponteiro depois dele; (2) na etapa da
     empresa o antigo continuava `ativo` em `terminais` e o `uq_terminais_caixa_ativo` recusava o novo (503 e
     compensação). Antes do insert, os terminais anteriores do caixa que o controle já tirou de `ativo` saem de
     `ativo` também no banco da empresa (`desativando`, ou `revogado` com a data e o motivo do controle). Teste de
     integração: o antigo informou venda 37/vale 3 sem confirmar a desativação → o novo recebe 1037/1003, fica `ativo`,
     o antigo `desativando` nos dois bancos (com carência) e continua autenticando para enviar as pendências.
     Falha na etapa da empresa (503 e compensação) desfaz também a substituição: o antigo volta a `ativo` no controle
     (sem carência nem `substituido_por_terminal_id`; no banco da empresa ele nunca saiu, a etapa fez rollback), só se
     ainda apontar para o novo que falhou; senão o heartbeat seguinte lhe entregaria `revogar` e o caixa ficaria sem
     terminal, e a nova tentativa com o mesmo código não regravaria o ponteiro. Repetição de uma ativação já `ativa`
     cuja etapa falha não compensa nada. O 1º commit trava por caixa (`pg_advisory_xact_lock`): duas ativações
     simultâneas do mesmo caixa davam 500 no `uq_terminais_pdv_caixa_ativo`; agora a segunda recebe `CAIXA_OCUPADO` e
     entra em `tentativas_ativacao`. Testes de integração para as duas (falha simulada por gatilho; corrida
     determinística com `terminais_pdv` em `SHARE`).
107. **Substituir exige `terminais.revogar`** além de `terminais.ativar` (ERP 12): gerar código com
     `substituiTerminalId` tira o terminal atual do caixa. Sem a permissão, 403 com a mensagem própria.
108. **`Esquema.g.cs` diz como cada coluna desce** (MD 6.2). O gerador lê o registro de fluxos e marca
     `Descida: DescidaColuna.Omitida` (nunca desce, não pode existir no espelho) ou `Projetada` (projeção condicional
     e segredos `bytea`, que descem nulos); o `EsquemaNuvemTests` do PDV deixou a lista manual de colunas que não
     descem. Coluna citada no fluxo que não existe na tabela falha a geração. Peso do produto
     (`peso_g`/`peso_abatimento_g`/`peso_pacote_kg`) não desce, como no registro: saiu do espelho do PDV (migração
     `ProdutosSemPeso`). O CI roda `verificar:esquema-pdv` no job `ts`.
109. **D19 (LGPD) e D20 (alerta)**: notas para os próximos blocos. D19: o fluxo `pessoas` vai descer só as pessoas
     relevantes por `funcionario` (categoria ou `usuarios.pessoa_id`), `crediario` e `manual` (o `compra` fica para a
     1C), e `usuarios.telefone`/`admissao`/`demissao` deixam de descer no fluxo `acesso` — hoje ainda descem (B4,
     que também troca a regra 3 do PDV 7.2, "demissão nula ou futura", por algo que não precise da data no caixa).
     D20: desativar ou substituir terminal com eventos `erro`/`retido` continua liberando a série e a numeração na hora
     (`decidirNumeracao` não espera os eventos) e passa a gerar um alerta no ERP para alguém resolver os eventos
     (B2, na revogação/substituição e na desativação confirmada; decisão 115).

#### Bloco B2 – PDVs/Terminais no ERP

110. **Status de conexão compartilhado** (ERP 12.1). `packages/shared/src/terminais.ts` traz `statusConexao()`
     (online < 2 min ≤ offline < 24 h ≤ sem contato; nunca contatou = sem contato) e `comPendencias()` (eventos
     pendentes no último heartbeat e mais de 1 h sem contato), usados pela listagem, pelos contadores e pela tela. O
     "último contato" é o mais recente entre `terminais_pdv.ultimo_contato_em` (qualquer chamada `/sync/*`, gravado
     no máximo 1×/min) e `terminais.ultimo_contato_em` (heartbeat). O card PDVs do dashboard usa o mesmo
     `statusConexao` sobre o mesmo último contato (uma consulta por banco); o "com pendências" dele segue o ERP 6
     (eventos pendentes ou NFC-e em contingência no último heartbeat), de propósito diferente do badge da listagem. Os schemas de entrada (gerar código, revogar, ressincronizar,
     mensagem, renomear, filtro) e os DTOs também ficam lá; o `gerarCodigoAtivacaoSchema` saiu do controller.
111. **Uma consulta por banco** (ERP 12.2, 12.4). `src/terminais/terminais.service.ts` lê `terminais_pdv` (estado da
     autenticação, lojas permitidas pelo `filtroLojas`) no controle e, no banco da empresa, a telemetria de `terminais`,
     os nomes de loja e operador, a contagem de `eventos_recebidos` em `erro`/`retido` e os alertas abertos, e junta
     em memória; contadores e filtros (situação, conexão, versão) são aplicados depois, sobre os mesmos dados. A versão
     mínima vem de `versoes_app_pdv` (canal da empresa) por plataforma; `terminais_pdv` não guarda a plataforma (ela
     só vem no cabeçalho), então ela é inferida do SO informado. "Ativos" inclui `provisionando`. Terminal fora das
     lojas permitidas → 403 no detalhe e nas ações. Histórico = auditoria do terminal + `comandos_terminal`.
112. **"Liberar ativações"** (ERP 12.2; SYNC 3.1). Coluna nova `empresas.ativacoes_liberadas_em` no controle
     (migração `0004_liberar_ativacoes`): as falhas anteriores a ela não contam para o bloqueio do código da empresa
     (o bloqueio por IP continua). `GET /terminais/ativacoes` devolve, além dos pendentes não vencidos (mascarados),
     `bloqueio {bloqueado, falhas, limite, ate}` (`ate` = a 20ª falha mais recente + 1 h). A 20ª falha cria o alerta
     crítico `ATIVACAO_FORCA_BRUTA` no banco da empresa (um enquanto aberto, com falhas e "até" atualizados; só se a
     empresa existe e está ativa); liberar (`terminais.ativar`) fecha o alerta e grava auditoria `liberacao`, e a
     manutenção o fecha quando o bloqueio cai sozinho (decisão 113). Um bloqueio novo depois disso abre outro.
113. **Manutenção periódica** (`src/terminais/manutencao.ts`). Fila `genesis-manutencao-terminais` agendada com o
     `schedule` do pg-boss a cada 5 min (cron no banco: várias instâncias com trabalhador geram um job por ocorrência),
     e uma execução por vez pela trava consultiva `genesis:manutencao_terminais`. Faz: códigos `pendente` vencidos →
     `expirado`; `desativando` com `carencia_ate` vencida → `revogado` (`carencia_vencida`, sem confirmação: o próximo
     terminal do caixa recebe o salto); `provisionando` há mais de 15 min (a janela de repetição da ativação) → `ativo`
     se a etapa da empresa já existe, senão a mesma compensação da falha da ativação (`AtivacaoTerminais.compensar`,
     extraída de `concluir`); e reconcilia o banco da empresa com o controle para os terminais `desativando`/`revogado`
     alterados nos últimos 7 dias (destino `revogado` com `travaVersao`, porque libera `caixas`; o `desativando` de
     uma substituição em andamento fica com a etapa da empresa e a compensação). Fechar alertas não tem janela: o da
     D20 é conferido em toda empresa com terminal `desativando`/`revogado` (os eventos podem ser resolvidos semanas
     depois) e o `ATIVACAO_FORCA_BRUTA` nas empresas com falhas de ativação nos últimos 7 dias, fechado quando
     `estadoBloqueio` não está mais bloqueado. Uma empresa com erro não para as outras (`falhas` no resumo). Os testes chamam `executar()` direto; o agendamento é conferido
     em `servicos-fundo.test.ts`. O `provisionando` só é compensado depois de 20 min (`PROVISIONANDO_ESQUECIDO_MIN`:
     a janela de repetição de 15 min mais a margem da etapa da empresa, decisão 124).
114. **Revogação pelo ERP** (ERP 12.4; SYNC 3.8, 4.3 item 6). `POST /terminais/:id/revogar {modo, confirmacaoCaixa,
     observacao}` (`terminais.revogar`). Ordem: controle primeiro (o 401 ou o `desativando` valem na próxima chamada),
     depois a empresa em `src/terminais/revogacao.ts` (`aplicarEstadoNaEmpresa`, idempotente, também usada pela
     manutenção). `aceitar_pendencias`: só de `ativo`; `desativando` com carência de 7 dias nos dois bancos, comando
     `revogar` já enfileirado (o heartbeat também o garante). `imediato`/`perdido`: exigem o nº do caixa digitado
     (conferido também na API, 422 em `confirmacaoCaixa`); `revogado` com data, autor e motivo
     (`revogado_imediato`/`perdido_roubado`), o caixa fica livre (`caixas.terminal_id → terminal_anterior_id`, como na
     desativação confirmada e na carência vencida) e auditoria `terminal_revogado`. Todo destino `revogado` roda com
     `travaVersao` (libera `caixas`, que tem `fn_versao`; MD 1.5). `perdido` anula, na mesma transação,
     `usuarios.senha_pdv_hash` de quem acessa a loja (master ou `usuarios_lojas`) e `pessoas.senha_hash` das pessoas
     cuja senha desce para a loja: a mesma condição da projeção do fluxo `pessoas` (`pessoaRelevante` +
     `senhaClienteDesce` de `sync/fluxos.ts`: relevante, exigência de senha ligada na loja, limite > 0, não
     bloqueada), como pede a ERP 12.4 ("as que desceram para aquele terminal"); quem não atende hoje não tem hash no
     PDV da loja. Auditoria `senha_redefinida` por registro; o `fn_versao` faz o `null` descer nos fluxos
     `acesso`/`pessoas` dos outros terminais. `perdido` também vale num terminal **já revogado** por outro motivo
     (furto descoberto depois, ou outra revogação que ganhou a corrida): o controle passa a `perdido_roubado` e a
     empresa só anula e audita (menos `falha_ativacao`, que nunca recebeu dados → 422; e nunca 200 sem anular).
     `aplicarEstadoNaEmpresa` decide o que falta pelas auditorias `terminal_revogado` (`depois.status`/`motivo`), não
     só pelo status: a etapa da empresa da ativação passa os anteriores revogados por ela (a revogação que só ficou
     no controle é completada ali, com anulação, auditoria e alerta) e a desativação confirmada do heartbeat grava a
     própria auditoria (motivo `MOTIVOS_REVOGACAO.confirmada`, empresa antes do controle, com `travaVersao`).
     Repetir a mesma revogação só refaz a etapa da empresa; outro modo num terminal já revogado → 422.
     "Não reconheço" (troca de hardware) é a revogação imediata com observação. O `sync.test.ts` deixou de revogar
     por SQL.
115. **D20 no código**: a numeração continua passando ao substituto na hora (`decidirNumeracao` não olha os eventos) e
     o terminal que sai do caixa com eventos em `erro`/`retido` gera o alerta crítico
     `TERMINAL_DESATIVADO_COM_EVENTOS` (um por terminal enquanto aberto, com as contagens), na revogação (3 modos e
     carência), na substituição (etapa da empresa da ativação do novo, também quando o código novo é de um caixa cujo
     terminal estava em desativação) e na desativação confirmada do heartbeat. A listagem e o detalhe mostram os
     alertas abertos (não há tela de alertas ainda); a manutenção fecha o alerta quando os eventos são resolvidos
     (fila de decisão, 1C), sem janela de tempo (decisão 113).
116. **Comandos pelo ERP** (SYNC 21.1). `src/sync/comandos.ts` (`enfileirarComando`/`enfileirarComandos`, na transação
     de quem pede) é o único produtor de `comandos_terminal`, também usado pela revogação e pelo heartbeat (a troca
     das chaves de crediário passou ao toque, decisão 124); `revogar`, `ressincronizar` e
     `ressincronizar_fluxo` do mesmo fluxo não se repetem enquanto um igual estiver `pendente`. O `revogar` do
     `desativando` passa por `garantirComandoRevogar` (ERP e heartbeat): um por terminal, qualquer status menos
     `cancelado`/excluído. `POST /terminais/:id/ressincronizar {fluxo?}` (só
     terminal `ativo`) e `POST /terminais/:id/mensagem {texto}` (`terminais.gerenciar`, auditados como `criar
     comandos_terminal`). `POST /terminais/:id/hardware/confirmar {idHardwarePendente}` copia o pendente exibido para
     `id_hardware` nos dois bancos (auditoria `hardware_alterado`; 409 se o pendente mudou, decisão 124);
     `PATCH /terminais/:id` renomeia nos dois bancos.
117. **Aba "Eventos com erro" somente leitura** (ERP 12.5): `GET /terminais/:id/eventos-erro` lista `erro`/`retido`
     (até 500, por sequência) com `terminais.ver`; o payload só vai com `terminais.gerenciar` (pode ter dados
     pessoais). O retido traz `aguardando` (os `evento_id_bloqueador` que o push gravou em `dependencias`, com
     sequência e tipo) e as `dependencias` do envelope ("Retido aguardando qual evento"). `GET
     /terminais/caixas-livres?lojaId=` (`terminais.ativar`) lista para o modal de gerar código os caixas sem terminal
     `provisionando`/`ativo` no controle (a regra de `gerarCodigo`), inclusive o de um terminal `desativando` (com
     `terminalDesativandoId`), sem exigir `lojas.ver`. Reprocessar, aplicar com novo número e descartar entraram na
     1C (fila de decisão, decisão 135, que também pagina a listagem). Também fora do B2:
     renovar token (B3), solicitar logs (`/sync/arquivos`), código de recuperação e "Perdas prováveis" (22.3, 22.4),
     "Novo caixa" e série NFC-e nova no modal (fiscal, 3F) e o comando `atualizar_app`.
118. **Rotação do token** (SYNC 3.7; Fase 1B, B3). `POST /sync/token/renovar {novo_token_hash, requisicao_id}`
     (`src/sync/token.ts`; schemas `renovarTokenSchema`/`respostaRenovarTokenSchema` no shared, com fixtures
     `token.renovar.*.json` que o PDV também testa): o PDV gera o segredo e só o `sha256_hex` dele sobe. Numa
     transação com `select … for update` em `terminais_pdv`: mesmo `requisicao_id` que `token_renovacao_requisicao_id`
     → sem efeito, `200` com o `token_emitido_em` gravado (a repetição pode vir pelo anterior ou pelo novo; com outro
     hash, `400`); `requisicao_id` novo só com o token **atual**, conferido de novo sob a trava (o anterior → `401
     TOKEN_INVALIDO`, para um token antigo copiado não "roubar" a rotação); hash igual ao atual ou ao anterior → `400`.
     Aplicada: `token_hash_anterior` = atual, `token_anterior_valido_ate` = agora + 7 dias, `token_atual_usado_em` =
     nulo e auditoria de plataforma `terminal_token_renovado` (sem hash nem token: as chaves com "token" seriam
     mascaradas). Hardware divergente responde `409 HARDWARE_ALTERADO`, como o push (PDV 5.3); a regra mora num lugar
     só (`exigirHardware` em `terminal.ts`, chamada pelo controller). O uso do **anterior depois que o novo já
     funcionou** (`token_atual_usado_em` preenchido há mais de 30 s, `MARGEM_TOKEN_ANTERIOR_MS`: a margem absorve a
     corrida do próprio PDV, uma chamada recusada com o novo antes do commit da renovação que cai para o anterior
     enquanto outra já usou o novo) continua aceito dentro da janela, mas gera o alerta crítico
     `TOKEN_ANTERIOR_REUTILIZADO` e a auditoria `token_anterior_reutilizado` (origem `pdv`), uma vez por terminal
     enquanto o alerta estiver aberto (`chave_deduplicacao` `token_anterior:<terminal>`); o `AutenticacaoTerminal` só
     marca (`tokenAnteriorReutilizado`) e o controller grava no contexto da empresa antes do 409 de hardware e da rota
     (o clone em outra máquina, o caso típico, também é registrado). O alerta aparece em PDVs/Terminais (listagem e
     detalhe) e é o único de terminal resolvido na tela: `POST /api/terminais/:id/alertas/:alertaId/resolver
     {resolucao}` (`terminais.gerenciar`; "Máquina conferida"), que grava `resolvido_por_id`/`resolucao` e a
     auditoria `conferir` do terminal ("Alerta resolvido" no histórico); se a cópia for real, o caminho é "Revogar
     terminal", no próprio alerta. Resolvido, o próximo uso do anterior abre outro. Os demais (D20, força bruta) fecham
     sozinhos e a rota responde `422`. A ação "Renovar token" do ERP (flag para o próximo heartbeat) não entrou: o heartbeat continua pedindo a
     renovação pelos 30 dias de `token_emitido_em`. Testes em `test/integracao/token.test.ts`.
119. **Relevância de pessoas mantida pela API** (MD 3.5.4; D19; Fase 1B, B4). `src/pessoas/relevancia.ts`
     (`recalcularRelevancia`) recalcula, na transação do fato, os motivos que a 1B mantém, todos com `loja_id` nulo:
     `funcionario` (categoria Funcionário viva ou usuário não excluído com `usuarios.pessoa_id`), `crediario`
     (`limite_compras > 0` ou `saldos_credito_pessoas.saldo_aberto > 0`; o limite padrão da empresa **não** conta, senão
     todo cliente seria relevante e a minimização perderia o sentido) e `manual` (campo novo "Manter no PDV" do
     cadastro, `manterNoPdv` no shared e no detalhe). Chamado em `inserirPessoa`/`atualizarPessoa` (o formulário e a
     importação do Nuvem3 passam por eles; a importação de pessoa existente preserva a marcação manual), na exclusão da
     pessoa (todas as linhas saem) e na edição/exclusão de usuário (vínculo `pessoa_id`; hoje a API não grava esse
     campo, mas o recálculo já o considera). Linha que deixa de valer é excluída logicamente (as colunas são imutáveis,
     MD 6.4 regra 2) e desce para o PDV purgar a pessoa. `compra` (1C) e `delivery` ficam com quem os produz, e a tarefa
     diária de expiração entra com eles. As pessoas gravadas antes do B4 (cadastro da 1A, importação do Nuvem3) ganham
     `funcionario`/`crediario` pela migração `0009_relevancia_inicial_motivos_login` (as mesmas regras em SQL,
     idempotente, sem toque: nenhum PDV tinha espelho de pessoas). A marcação "Manter no PDV" entra no `antes`/`depois`
     da auditoria do cadastro (`manterNoPdv`): é ela que expõe os dados pessoais aos caixas (LGPD).
120. **Toque** (MD 6.4 regra 1; `src/sync/toque.ts`; migração `0008_toque_versao`). O `fn_versao` passou a aceitar
     `set_config('genesis.forcar_versao', 'on', true)`: só durante os UPDATEs do toque (ligado e desligado na mesma
     transação) um UPDATE sem mudança real ganha versão nova. Assim nenhuma coluna artificial entra nas tabelas (nem no
     espelho do PDV). `tocarPessoas` toca a pessoa e as filhas vivas do fluxo `pessoas` **depois** de inserir a
     relevância (versões maiores que a da linha nova). Só a pessoa que ganhou linha nova é tocada; regravar o cadastro
     sem mudar a relevância não toca nada.
121. **Projeções da D19.** `usuarios` (fluxo `acesso`) não desce mais `telefone`, `admissao` nem `demissao`; `ativo`
     desce projetado como `ativo and (demissao is null or demissao > hoje)` (regra 3 do PDV 7.2 sem a data no
     caixa). No dia da demissão a manutenção dos terminais (passo 6, a cada 5 min) toca os usuários com `demissao <=
     hoje` e `atualizado_em` anterior à meia-noite dela, nas empresas com terminal `ativo`/`desativando`: um toque por
     usuário (depois dele o `atualizado_em` já é do dia). `hoje` e a meia-noite são do fuso da empresa
     (`src/comum/fuso.ts`, `empresa.fuso_horario`): a sessão do Postgres fica em UTC e `current_date` viraria o dia às
     21:00 de Brasília; projeção e manutenção usam a mesma regra para virar o dia juntas. `pessoas_telefones` e `pessoas_enderecos` só descem de quem
     é relevante por outro motivo além de `funcionario` (o funcionário desce para login e identificação, sem contato); o
     PDV purga o contato local quando só sobra `funcionario`. O `Esquema.g.cs` reflete as omissões e passa a trazer a
     chave primária e o fluxo de cada tabela (o aplicador do pull do PDV usa a chave no `on conflict`).
122. **`ressincronizar_fluxo` estrutural** (MD 6.4 regra 3; `lojas/fluxos-afetados.ts` › `fluxosAfetados`, com teste
     unitário, e `sync/comandos.ts` › `ressincronizarFluxosDaLoja`). No `PUT /lojas/:id`: `estoque_id` → `estoque`,
     `catalogo` e `configuracao` (a linha de `estoques` da loja); UF
     ou município → `referencia` e `catalogo`; `tipo_emissao` (entrando ou saindo de `nfce`, o certificado muda de
     filtro) → `configuracao`; para os terminais `ativo`/`desativando` da loja, um comando por fluxo (o pendente igual não
     se repete). `tipos_estoque.vendavel`, `lojas_banners.exibir_em` e chave PDV nova no catálogo ainda não geram o
     comando (não há edição desses campos no ERP hoje). Testes em `test/integracao/descida.test.ts`; vetores argon2 da
     API para o PDV em `packages/shared/testes/sync/argon2.vetores.json` (conferidos em `src/seguranca/senhas.spec.ts`).
123. **Auditoria do login offline no catálogo** (SYNC 4.2, 4.5; PDV 7.2). `hash_fora_dos_limites` entrou em
     `ACOES_AUDITORIA`, e `sem_acesso_pdv`, `totem` e `hash_fora_dos_limites` em `MOTIVOS_FALHA_LOGIN` e no check
     `ck_historico_logins_motivo_falha` (migração 0009): sem isso o `auditoria.registros` do caixa voltaria
     `PAYLOAD_INVALIDO` e levaria junto os registros válidos do mesmo evento. O payload v1 passou para o shared
     (`payloadAuditoriaRegistrosSchema`); a fixture `auditoria.registros.payload.json` traz o que o PDV grava e é
     conferida pelo zod, pelo xUnit (`ContratosTests`, contra as constantes do `AutenticadorOffline`) e por um push real
     em `descida.test.ts`.
124. **Revisão integrada da 1B (lado da API).** (1) **Limite de comandos no heartbeat**: a resposta traz no máximo
     `MAX_COMANDOS_HEARTBEAT` (100, `@genesis/shared`, o mesmo `.max` de `comandos_resultado`), por `criado_em`; os
     demais saem conforme os acks chegam. A requisição continua recusando mais de 100 acks (400): o PDV fatia.
     (2) **Substituição em andamento** (`substituicaoEmAndamento` em `sync/terminal.ts`): o antigo `desativando` cujo
     `substituido_por_terminal_id` ainda está `provisionando` autentica com status efetivo `ativo` — heartbeat sem
     `garantirComandoRevogar` nem confirmação de desativação, `status_terminal`/`GET /sync/estado` `ativo`, pull de
     todos os fluxos, e um `revogar` já gravado não desce; "aceitar pendências" no ERP é recusado (422), porque a
     compensação o desfaria. `compensar()` cancela os `revogar` pendentes/entregues do antigo no banco da empresa,
     dentro da transação do controle (se a empresa falhar, a compensação inteira fica para a manutenção). A
     confirmação da desativação exige `desativando` também no banco da empresa. (3) **3º commit da ativação**:
     `concluir()` confere o `returning` do `update … 'ativo'`; sem linha, relê: `ativo` → 201; senão 503 `MANUTENCAO`
     sem token (o código compensado voltou a `pendente` e a nova tentativa ativa; a etapa já commitada do terminal
     compensado é alcançada pela reconciliação, mas numa substituição o antigo fica `desativando` só no banco da
     empresa até a próxima ativação do caixa — resíduo aceito: exige a etapa nunca ter commitado, a repetição no
     último minuto da janela e a manutenção depois da margem de 5 min). A janela de repetição (`REPETICAO_MIN`) é medida pelo `now()` do
     controle, e a manutenção só compensa depois de `REPETICAO_MIN + 5`. (4) **Chaves da senha do cliente**: trocar
     `pdv.crediario_exige_senha_cliente` ou `financeiro.limite_credito_padrao` toca (`toque.ts`) as pessoas com
     `senha_hash` em vez de mandar `ressincronizar_fluxo {pessoas}`: a linha refeita voltava com a mesma versão e o
     PDV a descartava. O toque manda os ids em fatias de 10 mil (`IDS_POR_TOQUE`), abaixo do limite de 65.535
     parâmetros por consulta do PostgreSQL (teste "o toque de muitas pessoas…"). (5) **Hardware divergente** (SYNC 20.5): migração de controle `0005_hardware_pendente`
     (`hardware_pendente_desde`/`_ip`/`_so`), gravados na primeira chamada de cada id pendente (o SO, no primeiro
     heartbeat dele); a chamada de outra máquina não grava contato/IP no controle nem a telemetria em `terminais`
     (IP, SO, numeração, pendências) e não confirma a desativação (o `revogar` continua garantido). O detalhe traz
     `hardwarePendente {id, desde, ip, sistemaOperacional}` e a tela os mostra no alerta e no modal; a confirmação
     manda o id exibido e vale só para ele (409 `CONFLITO` se outra máquina chamou depois). Testes: describe
     "revisão integrada da 1B" (`terminais.test.ts`), "provisionando esquecido…" (margem de 20 min) e "trocar a
     exigência de senha…" (`sync.test.ts`).

### Fase 1C – vendas e caixa (API)

Bloco C1 do plano da 1C (base da aplicação de eventos): nenhum tipo de evento novo ainda; prepara o reprocessamento
(C8), os handlers de caixa e venda (C5–C7) e o teste de carga (C13). Decisões técnicas T1 e T14 do plano. Bloco C2
(fim do ruído de `custo_medio`): decisões T3 e T10. Bloco C3 (tabelas de venda e caixa): decisões T2, T5 e T8.
Bloco C4 (contratos dos eventos): decisões T17 e T18, novas neste bloco. Bloco C5 (handlers de caixa e
`sessao_caixa_aberta`): decisões T11, T12 e T16, mais a T19, nova neste bloco. Bloco C6a (motor de estoque para o
documento do PDV): decisão T4, mais as T20 e T21, novas neste bloco. Bloco C6b (handler `venda.finalizada`): decisão
T15, mais as T22 e T23, novas neste bloco, e as respostas do dono O8, O15 e O24 (roadmap §16, D26–D28). Bloco C7
(`venda.cancelada` A e B, `vasilhame.movimentado`, `alerta.cadastro`): decisões T2 e T20, mais as T24 a T26, novas
neste bloco, e as respostas do dono O6, O14 e O22 (roadmap §16, D3, D23 e D24); a T24 virou a pergunta D29 (o destino
dos vazios trazidos no cancelamento), respondida pelo dono em 31/10/2026: voltam ao cliente (`pdv.cancelamento_devolve_vazios`
ligada por padrão).
Bloco C8 (fila de decisão mínima, adiantada do PR 1C-2 para o PR 1C-1 pela crítica do plano, item 1): decisão T9, mais
as T27 e T28, novas neste bloco, e a D20 do dono (reprocessar o evento de terminal revogado).
Bloco C12 (consultas do ERP e dashboard, depois do C7 e em paralelo ao PDV): decisões T30 a T33, novas neste bloco, e
as respostas do dono O1/D7 (dia operacional), O3/D12 (só o gerente vê o esperado, no ERP) e O10/D39 (loja de treino
dentro da empresa real, filtrável e fora por padrão).
Bloco C16 (relógio na nuvem, PR 1C-2): decisão T9 (os nomes `RELOGIO_SUSPEITO` e `relogio_regrediu`), mais a T40,
nova neste bloco (o desvio do heartbeat com tipo próprio, `RELOGIO_DESVIO`); nenhuma resposta do dono envolvida.
Bloco C17 (recuperação e backup, PR 1C-2): decisões T6 e T7, mais as T41 a T45, novas neste bloco (na API, a T41: o
`recuperar` exige o hardware e aceita a empresa suspensa), e a resposta do dono O12 (roadmap §16, D41: backup
automático e "Restaurar backup" já na 1C, sem cifra).

125. **Envelope guardado e `aplicarEvento` extraído** (T1; SYNC 8.1, 8.3, 12.4, 22.2; MD 3.15.2). Migração
     `0010_eventos_recebidos_envelope`: `eventos_recebidos.envelope jsonb not null default '{}'`, gravado na linha nova
     do push com o envelope inteiro **menos** o `payload` (que já tem coluna e é anulado aos 13 meses). Antes se
     perdiam `usuario_id`, `contexto` e o relógio, de que o reprocessamento, o `recuperar` e o `RELOGIO_SUSPEITO`
     precisam. `envelopeDaLinha` remonta o envelope (linhas antigas: colunas e contexto do terminal, sem
     `usuario_id`). A aplicação saiu de `push.ts` para `src/sync/aplicacao.ts` (`aplicarEvento(tx, c,
     TerminalDoEvento, ev)`). A ordem das travas (`push:<terminal>` → 7300001 → linhas) é do **chamador**: ele pega
     `travarTerminal` como primeira trava da transação, que nunca é aberta com `transacao({ travaVersao: true })` nem
     pega trava de linha antes. `aplicarEvento` reentra na `push:<terminal>` antes da `fn_trava_versao()` (sem
     espera, já é dele), o que não corrige uma ordem já invertida: quem tiver a 7300001 e esperar a `push:` de um push
     simultâneo, que espera a 7300001, entra em deadlock. `gravarFalha` e o Descartar, que não aplicam, chamam
     `travarTerminal` direto. A aplicação confere o escopo (loja, caixa e terminal do envelope × terminal dono)
     também fora do push.
     `TerminalDoEvento` (id, loja, caixa, número do caixa, IP) vem do token no push e de `terminais` com `caixas` no
     reprocessamento (`carregarTerminalDoEvento`, qualquer status, D20); o handler não vê token, cabeçalhos nem
     hash. Fora do push a resolução fica com `resolucao_entregue_em` nulo (o heartbeat entrega). A SYNC 8.1 passou a
     dizer "só as transações de evento pegam `push:`".
126. **Erros do PostgreSQL → SYNC 11.2** (T14; `traduzirErroBanco` em `src/sync/erros.ts`, tabela na SYNC 11.2).
     Aplicado no `catch` do push, **depois** do `rollback` e das 3 repetições de `transacao()` (não esconde o
     40P01/40001 da repetição): 23505 em `uq_vendas_numero` → `NUMERO_VENDA_DUPLICADO`, outra unicidade →
     `AGREGADO_DIVERGENTE`, 23503 → `REFERENCIA_INEXISTENTE`, 23514 → `PAYLOAD_INVALIDO` (erro de regra já na 1ª vez,
     com SQLSTATE, restrição, tabela e os nomes das colunas da chave em `resultado.detalhes`); 40P01/40001 →
     transitório `CONCORRENCIA_BANCO` e classe 08/57P01–57P03 ou a conexão perdida no driver, sem SQLSTATE
     (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, "Connection terminated…", "not queryable") → transitório
     `BANCO_INDISPONIVEL` (o lote para, nada é gravado e não conta para o `ERRO_INTERNO`). Violação nas tabelas do
     próprio protocolo (`eventos_recebidos`, `entidades_evento`) continua exceção não classificada. Antes, uma FK ou
     unicidade quebrada parava o lote duas vezes antes de virar `ERRO_INTERNO`. O SQLSTATE é lido pelo
     `erroDoDriver` (`src/database/erro-postgres.ts`), que desce até o erro do `pg` por trás do `DrizzleQueryError`:
     toda consulta feita pelo `tx` do Drizzle chega embrulhada, com o código só em `.cause`. O mesmo vale para o
     `semParticao` e para as repetições de `transacao()` em 40P01/40001 (`src/tenancy/tenancy.ts`). O `detail` do
     PostgreSQL nunca é guardado: traz os valores da chave (CPF…) e, no 23514, a linha inteira, e `resultado` fica
     depois da anulação do `payload` aos 13 meses (D19). Pela mesma razão o `ERRO_INTERNO` grava em `erro_mensagem`
     só a mensagem do PostgreSQL, sem o SQL e os parâmetros que o `DrizzleQueryError` põe na dele.
127. **Auditoria comum e medição da trava** (crítica da 1C, itens 6 e 18). `registrarAuditoriaPdv`
     (`src/sync/handlers/comum.ts`) é a gravação de `auditoria` dos handlers (rodapé da SYNC 10.1): `origem = 'pdv'`,
     `evento_id`, terminal, loja, IP, usuário do envelope por padrão, `antes`/`depois` mascarados, partição
     inexistente → `PAYLOAD_INVALIDO`. O `terminal.configuracao_alterada` já a usa; o `auditoria.registros` continua
     gravando os registros do próprio PDV com os ids locais. O `ContextoHandler` ganhou `c` (SQL cru na mesma
     transação) e passou a receber `TerminalDoEvento`. `MedidorTravaVersao` (`servicos.push.medidorTrava`) guarda,
     por processo, as últimas 2.000 durações de `fn_trava_versao()` até o `commit` de cada evento aplicado no push,
     com p50, p95 e máximo; o C13 confere o p95 contra a meta de 50 ms da SYNC 8.3. Ainda sem exportar para as
     métricas da plataforma (SYNC 21.4).
128. **`produtos.custo_medio` isento de versão** (T3, T10; MD 1.5 "Colunas isentas", 3.6.3; SYNC 15.5; crítica da
     1C, item 12). Migração `0011_fn_versao_colunas_isentas`: o `fn_versao` passa a aceitar, como argumentos do
     trigger, colunas que não contam na comparação do UPDATE; se só elas mudam, a linha grava o valor e fica com a
     mesma `versao` e o mesmo `atualizado_em`, sem pegar a trava 7300001. Junto de outra coluna, ou no toque
     (`genesis.forcar_versao`, migração 0008), a versão é nova. O `tg_produtos_versao` foi recriado com
     `fn_versao('custo_medio')`; os demais triggers seguem sem argumento (mesmo comportamento da 0008). Motivo: a
     projeção do custo médio (0006) muda a cada saída quando o CD e as lojas têm custos diferentes (o peso de cada
     estoque na média muda), e o UPDATE versionava o produto e, pelo `tg_produtos_custo_kit` (0005), cada combo que o
     tem como componente: os dois desciam de novo no fluxo `catalogo` a cada venda (sem a coluna, que o pull omite),
     a aplicação da venda segurava a trava por mais tempo e o `versaoAgregada` dava 409 falso a quem estava com o
     produto aberto no ERP. **Só** `custo_medio` é isento, não `preco_custo` nem `markup_pct`: no combo eles só mudam
     quando muda o cadastro de outro produto, e aí versionar é o certo (sem isso, dois usuários editando o custo ao
     mesmo tempo: o segundo apagaria o primeiro sem 409). As colunas omitidas do pull e editadas no ERP
     (`descricao_longa`, dimensões, peso…) também versionam. Regra para novas isenções (`COLUNAS_ISENTAS_VERSAO` em
     `src/database/empresa/versionamento.ts`): projeção mantida pelo banco, nunca editada no ERP, e no `omitir` do
     fluxo da tabela; o teste `versionamento` confere os argumentos dos triggers × a lista, a existência das colunas
     e o `omitir`, e o comportamento do `fn_versao` com argumento (sem trava, com outra coluna, no toque). Testes de
     ponta a ponta em `test/integracao/custo-medio-versao.test.ts`: produto com saldo no CD e em duas lojas a custos
     diferentes, a saída muda o `custo_medio` do produto e do combo sem mudar versão nem `atualizado_em`; 10 saídas
     nas duas lojas deixam o pull `catalogo` vazio e mudam o `estoque` (só o saldo da loja do terminal); o formulário
     aberto antes da saída salva sem 409; preço e `preco_custo` versionam (o combo junto) e a versão velha dá 409. O
     `atualizado_em` do produto deixa de refletir a mudança do custo médio (não é edição do cadastro); a data da
     última mudança do custo fica no razão (`movimentos_estoque`).
129. **Tabelas de venda e caixa na nuvem, alinhadas ao PDV** (MD 3.11.2–3.11.6, 3.12.1–3.12.3, 3.12.6; SYNC 9.26,
     13.1; crítica da 1C, itens 8, 11 e 18). Schemas `schema/vendas.ts` (`vendas`, `itens_venda`,
     `itens_venda_complementos`, `pagamentos_venda`, `parcelas_venda`, `transacoes_tef`, `cobrancas_pix`) e
     `schema/caixa.ts` (`sessoes_caixa`, `movimentos_caixa`, `fechamentos_caixa`, `fechamentos_caixa_formas`,
     `movimentos_vasilhame`); migração `0012_vendas_caixa` gerada pelo drizzle-kit com a parte que ele não gera no
     fim. Nenhum handler ainda (C5–C7): as tabelas só existem. Ficam de fora `reservas_vale` (depende de `vales`, Fase
     3) e `vendas_status_pdv` (Fase 3). Pontos decididos aqui:
     - **Guarda**: o primeiro comando da migração falha (`EVENTOS_DE_VENDA_ANTES_DAS_TABELAS`) se houver evento
       `venda.*`, `caixa.*` ou `vasilhame.*` em `eventos_recebidos`. O plano pedia `venda.*`; `caixa.*` e
       `vasilhame.*` entram pelo mesmo motivo: sem handler até aqui, um evento desses gravado teria sido "aplicado"
       sem efeito e se perderia. A empresa fica em manutenção (como qualquer migração que falha) até alguém olhar.
     - **Versão e triggers**: todas em `fn_versao_local` (nenhum fluxo as lê nesta fase; `TABELAS_FN_VERSAO_LOCAL`).
       `cobrancas_pix` é ↕ no MD e troca para `fn_versao` no bloco que criar o fluxo `operacao` do PIX dinâmico (Fase
       6), que precisará de `ressincronizar_fluxo`; já tem `tg_cobrancas_pix_filtro_imutavel('terminal_id')` (MD 6.4
       regra 2). A 0012 redefine `fn_versao_local` com os argumentos de colunas isentas da 0011: a `diferenca` gerada
       dos fechamentos (`COLUNAS_ISENTAS_VERSAO`) chegava nula no NEW do trigger BEFORE e fazia todo UPDATE (reaplicação
       do `caixa.fechado`, `usuario_subsequente_id` repetido) gerar versão nova; o teste `versionamento` falha se uma
       coluna gerada de tabela com trigger de versão ficar fora da lista. `vendas` tem bloco AU
       (`TABELAS_COM_AUTORIA`, FKs na parte customizada). Imutabilidade (`fn_protege_imutavel`): `vendas` fora dos
       estados abertos (`STATUS_VENDA_ABERTOS`: tudo menos `finalizada` e `cancelada`; o teste confere o argumento do
       trigger contra a constante) só muda `status`, `status_fiscal`, `devolucao`, `custo_total` e as colunas de
       cancelamento (forma A do `venda.cancelada`). Como esse trigger só olha o estado anterior, `tg_vendas_transicao`
       fecha a máquina de estados: `finalizada` só continua `finalizada` (sem mexer no cancelamento) ou vai a
       `cancelada`, e `cancelada` é terminal, com as colunas de cancelamento congeladas; sem ele, voltar a um estado
       aberto num UPDATE liberava tudo no seguinte, e a cancelada podia ser "descancelada". `movimentos_caixa` e
       `movimentos_vasilhame` só mudam as colunas de cancelamento. Itens, pagamentos, sessões e fechamentos não têm
       trigger de imutabilidade (o MD não pede; a nuvem preenche `custo_unitario`/comissão no insert e o
       `caixa.aberto` grava `usuario_subsequente_id` no fechamento anterior).
     - **`txid` do PIX**: `uq_cobrancas_pix_txid` é único só com `tipo = 'dinamico'` (o `txid` vem do PSP), mais o
       índice comum `ix_cobrancas_pix_txid` para a conciliação. No estático o `txid` é o número da venda (PDV 16.7):
       a venda paga com dois PIX tem duas cobranças com o mesmo `txid`, e a unicidade global faria o 23505 virar
       `AGREGADO_DIVERGENTE` e recusar o `venda.finalizada` inteiro (MD 3.11.6).
     - **FKs**: toda coluna `→` do MD para tabela que já existe tem FK e índice (MD 1.8), inclusive
       `vendas.cliente_id` (o handler resolve por `pessoas_aliases` antes, crítica item 7) e `itens_venda.kit_*`; o
       23503 vira `REFERENCIA_INEXISTENTE` (decisão 126). Sem FK por enquanto: orçamento, comanda, pedido, promoção,
       vale, complemento, troca, conta financeira e movimento de conta corrente (tabelas de fases seguintes).
       `transacoes_tef` e `cobrancas_pix` não têm FK em `venda_id`/`pagamento_venda_id`: a cobrança PIX dinâmica (e a
       transação TEF resolvida por `tef.resolvida`) existe na nuvem antes da venda; quem aponta com FK é o pagamento
       (`tef_transacao_id`, `pix_cobranca_id`), o que também evita o ciclo pagamento ↔ transação no insert.
       `terminais.sessao_caixa_id` continua **sem** FK (T8): o heartbeat grava a sessão informada pelo PDV antes de o
       `caixa.aberto` chegar.
     - **`vendas.relogio_confiavel boolean not null default true`** (T5; SYNC 12.4): o handler do `venda.finalizada`
       copia o campo do envelope; o ERP mostra "hora não confirmada" quando `false`. Venda do ERP: hora do servidor.
     - **`movimentos_vasilhame.destino = 'entrada'`** (T2; dono, O14): a devolução avulsa da Fase 1 só dá entrada nos
       vazios (sem comodato nem vale, que são da Fase 3); `ck_movimentos_vasilhame_destino` aceita `entrada`,
       `baixa_comodato` e `vale`, e `entrada` não exige pessoa nem `vale_id`.
     - **Uma sessão aberta por terminal** (`uq_sessoes_caixa_aberta (terminal_id) where status <> 'fechada' and
       excluido_em is null`), não por caixa: o substituto de um PC queimado abre a sua. Além dos CHECKs do MD, só
       `ck_sessoes_caixa_forcado_motivo` (enumeração do motivo, MD 1.7). `diferenca` de `fechamentos_caixa` e de
       `fechamentos_caixa_formas` é coluna gerada (`stored`): o handler do `caixa.fechado` (C6) nunca a inclui no
       INSERT (428C9), e o gerador do `Esquema.g.cs` a marca `Gerada: true` (`ColunaPdv.gerada`).
     - **Listas do código**: `TABELAS_MOVIMENTO_PDV` (`src/database/esquema-pdv.ts`) ganhou `cobrancas_pix` (PIX
       estático nasce no caixa) e `movimentos_vasilhame`; o `Esquema.g.cs` do PDV descreve as 12 tabelas de
       movimento, e o PDV alinhou `vendas`/`pagamentos_venda` no mesmo bloco (README do PDV, decisão 48).
     Testes: `test/integracao/vendas-schema.test.ts` (um caso inválido por CHECK de cada tabela, com a tradução para
     `PAYLOAD_INVALIDO`; 23505 de número → `NUMERO_VENDA_DUPLICADO` e o mesmo número em outro caixa; 23503 →
     `REFERENCIA_INEXISTENTE`; imutabilidade da venda com as transições recusadas — reabrir a finalizada, descancelar,
     reescrever o cancelamento — e dos movimentos, com o cancelamento do vasilhame passando; `txid` repetido no
     estático e recusado no dinâmico; filtro imutável de `cobrancas_pix`; sessão por terminal com substituto e motivo
     do fechamento forçado; fechamento com diferença gerada e UPDATE sem mudança real sem versão nova; destino
     `entrada`; a guarda da migração executada como o executor a corta). Cada teste abre a própria sessão num caixa e
     terminal só seus, e roda sozinho com `-t`. `versionamento`, `sync-triggers` e `cadastros-fase1` (FKs de autoria)
     conferem as listas; `esquema-pdv.spec.ts` confere as tabelas de movimento do gerador e as colunas geradas.

130. **Contratos dos eventos de caixa, venda, vasilhame e alerta** (T17, T18; SYNC 9.1, 9.3–9.9, 9.24, 9.26; dono, O6 e
     O22; crítica da 1C, itens 9, 13 e 30). Os schemas ficam em `@genesis/shared` (`packages/shared/src/sync/eventos.ts`),
     não aqui: o PDV confere as mesmas fixtures (`packages/shared/testes/sync/<tipo>.payload.json`). Nenhum handler
     novo: a API continua sem anunciar esses tipos em `versoes_schema` (o push os trata como `SCHEMA_DESCONHECIDO`
     até o C5–C7), e o handler de cada um, quando entrar, valida com o schema de `CONTRATOS_EVENTOS` (teste abaixo).
     Pontos decididos aqui:
     - **Forma das linhas (T17)**: chaves = colunas da tabela menos as padrão, as que só a nuvem preenche e as da
       venda do ERP (`COLUNAS_FORA_DO_PAYLOAD`); `not null` sem padrão é obrigatória, com padrão é opcional, anulável
       aceita `null` ou ausente; decimal em texto com a escala exata da coluna (`"38.28"`, `"3.1900"`, `"12.000"`). O
       objeto aceita chave desconhecida (um PDV mais novo não trava o outbox); quem pega o nome errado é a suíte: a
       fixture tem todas as chaves de cada linha e nenhuma é descartada pelo parse. Os CHECKs da 0012 e a coerência
       interna (linhas da própria venda, sequências, casco de item da venda, combo completo, sangria com quem retira,
       zera só no fechamento, forma repetida no fechamento, abertura = fundo) recusam como `PAYLOAD_INVALIDO` antes do
       banco; as somas (P6) não recusam. `fechamentos_caixa.resumo` é `looseObject` (o `jsonb` guarda tudo).
     - **`liberacoes` preenchido (T18)**: `[{acao, item_venda_id, valor_pct, autorizado_por_id, motivo,
       ocorrido_em}]`; `acao` é texto livre (`ACOES_LIBERACAO_VENDA` lista o que o PDV já gera), para uma ação nova
       num PDV mais novo não recusar a venda inteira; `tipo_alerta` do `alerta.cadastro`, ao contrário, é fechado na
       v1 (decide a chave de deduplicação).
     - **`venda.cancelada`**: uma versão, duas formas; a forma vem da chave (`itens_venda` = B) e cada uma é validada
       só pelo seu schema (`payloadVendaCanceladaSchema`), para o erro da B não sair misturado com o da A. Motivo de
       15 a 255 caracteres nas duas (O6, roadmap D23). Forma A: `estorno_venda` por forma, presente se e só se algum
       pagamento tem estorno efetivado (`ESTORNOS_COM_MOVIMENTO_CAIXA`); com a O22 (roadmap D24) o cartão/PIX pode
       voltar no meio original (linha na forma original, nada sai da gaveta, conta a receber da forma cancelada) ou em
       dinheiro (`devolvido_em_dinheiro`, linha na forma Dinheiro). O valor é próprio, e não o `dinheiro_devolvido` do
       pagamento em dinheiro, porque a transação do cartão/PIX não foi desfeita: o handler do C7 mantém a conta a
       receber e a conciliação dessa forma (SYNC 10.4) e confere o `estorno` com o `tipo_forma` gravado
       (`dinheiro_devolvido` só na forma dinheiro, `devolvido_em_dinheiro` só fora dela; divergência é
       `PAYLOAD_INVALIDO`). O motivo da forma B é o mesmo campo da A (aparado antes de contar e de gravar).
     - **`vasilhame.movimentado`**: o contrato aceita os três destinos; recusar `baixa_comodato` e `vale` na 1C é do
       handler (C7).
     - **Formas personalizadas (O9a, roadmap D25)**: o contrato não muda por elas: o pagamento leva
       `forma_pagamento_id` e os snapshots (`descricao_forma`, `tipo_forma` de `TIPOS_FORMA_PAGAMENTO`,
       `meio_pagamento_fiscal`). A migração (habilitação em várias lojas, flags "dá troco" e "exige supervisor", tipo
       base), o CRUD e a tela no ERP, a descida no fluxo e o espelho no PDV ficam para o bloco próprio **C8b**, depois
       do C8 e antes do C9/C10a (decisão de sequenciamento de 31/10/2026; a decisão 131 registra a troca); o uso no PDV
       fica para o C11a e o fechamento por forma para o C10a. Feito no C8b (decisão 136), sem mudar o contrato.
     Testes: `packages/shared/src/sync/eventos.spec.ts` (cada fixture passa sem descartar chave e traz todas as chaves
     do contrato; `agregadoId` de cada tipo; os casos recusados acima e os que não podem recusar: chave nova, ação de
     liberação nova, soma errada; `eventos.conferencias.json`, que o PDV confere igual: bordas de 14/15 e 255/256
     caracteres do motivo, ações de liberação e o `payload_sha256` do JCS de cada fixture);
     `src/sync/contratos-eventos.spec.ts` (chaves do contrato = colunas do Drizzle menos `COLUNAS_FORA_DO_PAYLOAD`,
     `not null` sem padrão obrigatória no contrato, cada `z.enum`/`z.literal` das linhas igual à lista do CHECK da
     coluna — as listas são constantes exportadas por `schema/vendas.ts` e `schema/caixa.ts` e usadas nos `check(...)`,
     e uma coluna com enum sem lista conhecida quebra o teste — e handler de tipo contratado usando o schema do
     contrato). O detector de chave descartada e a leitura das fixtures são de `sync/fixtures.teste.ts`, comum às duas
     suítes do `shared`; o payload da auditoria (Fase 0) passa só pela do protocolo.

131. **Handlers de caixa e `sessao_caixa_aberta`** (T11, T12, T16, T19; SYNC 8.5, 9.3–9.6, 10.1, 11.2, 21.3; MD
     3.12.1–3.12.3; crítica da 1C, itens 3, 4 e 5). `src/sync/handlers/caixa.ts` aplica os cinco `caixa.*` com o
     schema de `CONTRATOS_EVENTOS`, e `versoes_schema` passa a anunciá-los (T13: o PDV só gera o que é anunciado). Só
     o que veio do caixa: transferência da sangria, consolidação por sessão e quebra/sobra (SYNC 10.1, 10.3 passos 2 a
     4) são da Fase 4. Pontos decididos:
     - **Dependências recalculadas na nuvem** (SYNC 8.5, "vale a união"): `HandlerEvento.dependencias(ctx, payload)`
       roda antes da trava 7300001, só lendo, e soma as do payload às do envelope (movimento → sessão; cancelamento
       → movimento; fechamento → sessão; abertura → sessão anterior). A coluna `dependencias` do evento `retido` guarda
       a união e os bloqueadores. O próprio evento nunca é bloqueador de si mesmo (no reprocessamento ele está em
       `erro` e o `caixa.fechado` depende do próprio agregado). O `erro` `AGREGADO_DIVERGENTE` também não bloqueia
       (`eventoPendente`, `handlers/comum.ts`): é a duplicata de um agregado que já está aplicado, reprocessar não a
       resolve, e segurar os dependentes por ela retinha em cascata o turno seguinte a um segundo `caixa.fechado`
       divergente até alguém descartá-la (e aí tudo ia a `DEPENDENCIA_DESCARTADA`). Continua contando como evento não
       resolvido (alertas da D20, aba do terminal).
     - **T11 (abertura com a sessão anterior pendente)**: a abertura também depende da **outra sessão aberta do mesmo
       terminal na nuvem**, mesmo sem troca de turno. Se algum evento dela está em `erro`/`retido` (o `caixa.fechado`
       que falhou), a abertura fica `retido` com `DEPENDENCIA_PENDENTE`, e as vendas e movimentos da sessão nova
       também (a sessão nasce num evento retido, `entidades_evento`); reprocessar o fechamento e depois os retidos, em
       ordem, aplica tudo (C8 automatiza). `SESSAO_DUPLICADA` só quando nada dessa sessão está pendente (banco local
       perdido, SYNC 22.1).
     - **T12 (`terminais.sessao_caixa_id` com condição)**: o heartbeat continua gravando o que o PDV informa; o
       `caixa.fechado` limpa o campo só `where sessao_caixa_id = <sessão fechada>` e o `caixa.aberto` grava só sobre
       nulo, a própria sessão ou a `sessao_anterior_id`. Assim o fechamento tardio de A não apaga a B que o heartbeat
       já informou, nem a abertura tardia de A sobrescreve uma C mais nova. `operador_id` segue a mesma condição.
     - **T16 (abertura de terminal substituído ou revogado)**: a sessão entra já fechada à força
       (`substituicao_terminal` se o terminal está `desativando` e o caixa já é de outro terminal;
       `revogacao_terminal` se está `revogado`), com o alerta `SESSAO_FECHADA_POR_SUBSTITUICAO`, e não vai para
       `terminais.sessao_caixa_id`. O `desativando` por aceitar pendências, que continua dono do caixa, abre a sessão
       normalmente: ele ainda envia o fechamento, e fechar à força dava o alerta falso e a sessão marcada como forçada
       na conferência, com o `caixa.fechado` do operador no mesmo lote; se o turno ficar aberto, a desativação
       confirmada (heartbeat) ou a revogação o fecham. A linha de `terminais` é travada (`for update`) antes de ler o
       status: a revogação, a substituição e a desativação confirmada gravam `terminais` antes de fechar as sessões,
       então ou a abertura vê o status novo, ou quem fecha espera o commit dela e fecha a sessão gravada.
     - **Fechamento forçado** (MD 3.12.1; `src/sync/sessoes-caixa.ts` › `fecharSessoesDoTerminal`): na mesma
       transação da etapa da empresa da ativação do substituto (`substituicao_terminal`), do destino `revogado` de
       `aplicarEstadoNaEmpresa` (ERP, manutenção e a etapa da ativação, `revogacao_terminal`) e da desativação
       confirmada do heartbeat (um turno deixado aberto com tudo já recebido). O `desativando` por aceitar pendências
       não fecha: o caixa ainda envia o fechamento. Alerta um por sessão (`sessao_forcada:<id>`), severidade aviso.
       Eventos tardios do terminal antigo continuam aceitos: movimento entra na sessão fechada (`resultado.sessao_fechada`)
       e o `caixa.fechado` grava o fechamento, mantendo `fechamento_forcado = true` e o `fechada_em` da nuvem
       (`resultado.sessao_fechada_a_forca`). A venda tardia na sessão forçada também entra (C6b, decisão 133).
     - **T19 (agregado do envelope conferido)**: para tipo com contrato, `aplicarEvento` exige `agregado_tipo` e
       `agregado_id` iguais aos do payload (`CONTRATOS_EVENTOS[tipo].agregadoId`), senão `PAYLOAD_INVALIDO`. As
       dependências e a fila de decisão acham o evento pelo agregado: um `caixa.fechado` com o agregado errado deixaria
       a sessão "sem pendência" e a abertura seguinte viraria `SESSAO_DUPLICADA`.
     - **Mesmo agregado num evento novo** (camada 2 da idempotência, SYNC 8.4): sessão, movimento, fechamento e
       cancelamento que já existem com o mesmo conteúdo respondem `ja_existia` sem efeito (nem auditoria); com outro
       conteúdo, `AGREGADO_DIVERGENTE` (`colunasDivergentes`, que compara datas pelo instante, decimais pelo valor e
       `jsonb` na forma canônica). Segundo fechamento da mesma sessão: `AGREGADO_DIVERGENTE` (PDV 21.5). O mesmo
       fechamento (mesmo `id`) compara também as formas (`fechamentos_caixa_formas`, pelo `id`) e a
       `sangria_fechamento`, e a mesma sessão compara o movimento de `abertura`: a contagem repartida de outro jeito
       com o mesmo total, outra sangria ou um movimento de id novo é `AGREGADO_DIVERGENTE`, sem gravar nada.
     - **Outros erros de regra**: linha do payload com loja, caixa, número ou terminal de outro → `ESCOPO_INVALIDO`;
       movimento ou fechamento de sessão nunca recebida, e troca de turno com sessão anterior nunca recebida →
       `SESSAO_INEXISTENTE`; sessão anterior de outro terminal → `ESCOPO_INVALIDO` (como nos movimentos: a troca de
       turno é no mesmo terminal, e a sessão de outro terminal do mesmo caixa nunca volta ao novo, MD 3.12.1); cancelamento de movimento que a nuvem não tem, ou de tipo que não é sangria/reforço
       (PDV 20.3; o estorno da venda sai com o `venda.cancelada`) → `TRANSICAO_INVALIDA`. A sessão fechada aceita
       movimento tardio (não se confere "sessão aberta": a ordem por terminal garante o resto).
     - **Efeitos**: troca de turno preenche `fechamentos_caixa.usuario_subsequente_id` da sessão anterior, só no
       fechamento deste terminal e só se ainda está nulo (depois de uma perda do banco local, SYNC 22.1, outra
       abertura pode citar a mesma anterior: a primeira, que continuou o turno, prevalece); a contagem
       de cédulas vai em `auditoria.depois.contagem_cedulas` da abertura (o "registro `caixa_contagem_cedulas`" da PDV
       8.2; `caixa_contagem_cedulas` não é ação do catálogo `ACOES_AUDITORIA`). Auditoria: abertura e fechamento como
       `criar`, sangria/reforço como `movimentar`, cancelamento como `cancelar` (com o autorizador). Alertas novos na
       SYNC 21.3: `SANGRIA_ACIMA_DO_ESTIMADO` (SYNC 10.1: valor > `dinheiro_estimado_antes`; o PDV bloqueia, O5) e
       `FECHAMENTO_EVENTOS_PENDENTES` (eventos do turno, da abertura da sessão até `resumo.ultima_sequencia_evento`,
       em `erro`/`retido`; fica aberto até alguém resolver no ERP). A ordem estrita do push (`fora_de_ordem`) garante
       que tudo até a sequência citada já chegou, então comparar a citada com a maior recebida dava sempre zero: o que
       pode faltar é aplicar. `resultado.eventos_pendentes` é o número deles; `dados.sequencias_pendentes`, a lista.
     - **`/sync/estado`**: `sessao_caixa_aberta` real, filtrada pelo terminal do token (`sessaoAbertaDoTerminal`); a
       sessão de outro terminal do mesmo caixa nunca aparece.
     - **Formas de pagamento personalizadas (O9a)**: não entram no C5. O bloco C5 do plano corrigido é só dos handlers
       de caixa e elas mudam a tabela espelhada `formas_pagamento` (vínculo com várias lojas, flags "dá troco" e "exige
       supervisor", tipo base: migração, `Esquema.g.cs` e migração EF no PDV). Pela decisão de sequenciamento de
       31/10/2026 ficam para o bloco próprio **C8b**, depois do C8 e antes do C9/C10a: migração, CRUD e tela no ERP,
       descida no fluxo, espelho no PDV (roadmap §16, D25; a decisão 130 foi ajustada para o mesmo bloco). O contrato
       do evento não muda (decisão 130). Feito no C8b (decisão 136).
     Testes: `test/integracao/caixa-eventos.test.ts` (ciclo abrir, reforçar, sangrar acima do estimado, cancelar e
     fechar pelo push, com a auditoria e a sessão no `/sync/estado`; reenvio do lote sem linha nova nem versão nova;
     `ja_existia` e `AGREGADO_DIVERGENTE`; agregado errado, sessão nunca recebida, movimento inexistente e escopo da
     linha; fechamento em erro → abertura e sangria da sessão nova retidas, reprocessadas em ordem; `SESSAO_DUPLICADA`
     sem pendência; troca de turno, anterior de outro terminal (`ESCOPO_INVALIDO`) e subsequente gravado uma vez só;
     formas, `sangria_fechamento` e fundo de abertura comparados no agregado que já existe; duplicata divergente em
     erro que não retém a troca de turno seguinte; disputa heartbeat × fechamento e abertura × sessão mais nova;
     alerta de eventos pendentes com uma sangria do turno em erro, sem contar a do turno anterior; substituição com a
     sessão fechada à força, sangria, fechamento e abertura tardios do antigo, e o `/sync/estado` do novo sem a sessão
     do antigo; aceitar pendências com o `desativando` ainda abrindo e fechando turnos normalmente, a desativação
     confirmada fechando o turno deixado aberto e a abertura reprocessada do revogado já fechada; revogação imediata
     e o fechamento reprocessado depois dela).

132. **Motor de estoque para o documento do PDV** (T4, T20, T21; SYNC 8.3, 10.2, 10.4, 15.1, 15.4; MD 3.7.2; ERP
     13.1.4; crítica da 1C, itens 6, 14 e 15). Só o motor (`src/estoques/movimentos.ts`) e a base da aplicação: o
     handler `venda.finalizada` que monta as linhas é o C6b, e o cancelamento que usa o estorno, o C7.
     - **Colunas do PDV no movimento**: `NovoMovimento` ganhou `terminalId`, `eventoId`, `pessoaId`, `loteId`,
       `fator` (padrão 1; a quantidade já vem na unidade base) e `compensaMovimentoId` (`ACERTO_COMPENSACAO`, 15.3,
       do C6b); `unidadeDocumento` é cortada em 6 caracteres. `data_movimento` continua sendo a do fato (a venda usa
       `vendas.finalizada_em`). O acerto e a importação não mudam (deixam as novas nulas).
     - **`lancarDocumento(tx, linhas)`**: lança o documento inteiro **antes** do `INSERT` dele (`documento_id` não tem
       FK) e devolve `custoPorItem` (Σ `custo_total` por `documento_item_id`, para `itens_venda.custo_unitario` e
       `vendas.custo_total` sem `UPDATE` em documento imutável), os movimentos e as linhas de saldo que terminaram
       negativas (o alerta `ESTOQUE_NEGATIVO` deduplicado é do handler; a nuvem nunca recusa, 15.1). As linhas de
       saldo são criadas e travadas **uma vez cada, na ordem de `ordenarChaves`**, com dois comandos (`insert … on
       conflict do nothing` com todas e um `select … for update` ordenado pela posição na lista, que trava nessa
       ordem); os movimentos vão num `INSERT` só e as projeções num `UPDATE` só. Foi o que trouxe a venda de 10 itens
       com ficha e cascos de ~37 ms para ~18 ms de p95 com a 7300001 presa (um comando por movimento antes).
       `lancarMovimento` usa a mesma conta (`calcularMovimento`) para um movimento só. Cada um desses comandos vai em
       blocos de `LINHAS_POR_COMANDO` (1000) linhas, na mesma transação e na mesma ordem: o protocolo do PostgreSQL
       aceita no máximo 65535 parâmetros por comando, e com 28 por movimento uma comanda grande (300 drinques com 8
       insumos cada) passava do limite a partir de 2341 movimentos e caía em `ERRO_INTERNO` a cada reenvio. Os ids das
       linhas entram em minúsculas antes de agrupar e somar (o `z.uuid()` aceita as duas caixas e o banco as trata como
       o mesmo `uuid`: o mesmo produto em caixas diferentes virava dois grupos sobre a mesma linha de saldo, e o
       `UPDATE … from (values …)` aplicava só uma das contas); duas chaves que resolvam para a mesma linha de saldo
       são recusadas.
     - **T4 (linhas iguais e id derivado)**: `somarLinhasIguais` junta as linhas com a mesma chave do
       `uq_movimentos_estoque_idempotencia` (mais o estoque): dois insumos iguais na ficha, ou o mesmo insumo em duas
       linhas de `componentes_estoque` do item, viram **um** `BAIXA_INSUMO` com a soma (o índice não aceita dois);
       soma zero sai; entradas somadas têm de ter o mesmo custo. Os movimentos do bloco `vasilhames` da venda, que não
       têm item, ganham `documento_item_id = itemDerivadoDocumento(venda_id, 'vasilhames')`, UUIDv5
       (`src/comum/uuid-v5.ts`, RFC 9562) num namespace fixo (`NAMESPACE_ITEM_DOCUMENTO`, que não pode mudar): sem
       isso o índice, que só vale com `documento_item_id`, não os cobria. É a **segunda** barreira: a proteção contra
       aplicação dupla continua sendo `eventos_recebidos` e o rollback da transação do evento (crítica, item 15).
     - **T20 (estorno sem distorcer o custo médio)**: movimento de entrada com `estornoDeId` (cancelamento de venda,
       estorno de baixa de insumo, estorno de acerto de saída) exige `custoUnitario` = o custo da saída original (sem
       ele é erro de programa) e usa `custoMedioAposEstornoTexto` (`@genesis/shared`): com saldo positivo antes, a
       média ponderada de sempre, que dá exatamente o custo médio de quem nunca tivesse vendido; com saldo zero ou
       negativo, **mantém** o custo médio vigente (sem ele, o da saída), em vez da regra da compra (`cm' = c`). O
       estorno não traz custo novo: redefinir o custo médio com ele puxava para um custo antigo a linha que segue
       negativa (caixa offline vendendo sem estoque) e que já tinha recebido o custo da última compra. Vale também para
       o estorno de acerto do ERP 13.5 (`estornarAcerto`), que já passava o custo original.
     - **T21 (cadastros lidos antes da trava 7300001)**: `HandlerEvento.preparar(ctx, payload)` roda em
       `aplicarEvento` depois das dependências, do schema e do agregado e **antes** da `fn_trava_versao()`, só lendo
       (sem `for update`), e o que devolve chega ao `aplicar` como terceiro argumento. `lerCadastrosEstoque` lê numa
       vez produtos (mesmo excluídos, com `controla_estoque`, `preco_custo` e a sigla da unidade), códigos de barras
       (fator e sigla da embalagem), quais estoques pedidos estão válidos e os tipos de estoque padrão e
       `vasilhame_vazio`. Em READ COMMITTED, um cadastro alterado pelo ERP entre a leitura e a trava vale a partir do
       evento seguinte, como se este tivesse sido aplicado antes da alteração. A trava, que serializa todos os caixas
       e o ERP da empresa, fica presa só enquanto o handler grava.
     Testes: `src/estoques/movimentos.spec.ts` (soma das linhas, linhas que não se somam, custos diferentes, id
     derivado, ids em outra caixa, ordem das travas), `src/comum/uuid-v5.spec.ts` (vetores da RFC/Python), `packages/shared` (T20) e
     `src/sync/aplicacao.spec.ts` (`preparar` antes da 7300001 e não roda com payload inválido);
     `test/integracao/estoque-documento.test.ts`: colunas do PDV gravadas e custo do item antes de existir a venda;
     um `BAIXA_INSUMO` com a soma, vasilhame com id derivado, reaplicação barrada pelo índice (inclusive o vasilhame);
     negativo devolvido e não recusado; estorno com saldo positivo (= nunca ter vendido) e negativo (custo médio da
     última compra mantido), estorno sem custo recusado; documento de 2500 movimentos (acima do limite de parâmetros
     de um comando) e blocos menores que o documento; o mesmo produto em maiúsculas e minúsculas numa linha de saldo
     só; duas vendas cruzadas só pelo motor, com uma terceira transação segurando a linha do meio: a de ordem inversa
     trava a primeira e para na do meio **sem** ter travado a última (`for update nowait` confere), o que só passa
     com as travas na ordem de `ordenarChaves`; a leitura dos cadastros não espera a 7300001 presa pelo ERP e a
     gravação espera; venda do caixa ao mesmo tempo que um acerto efetivado pela rota e o `acertoEstoque` real da
     importação (o método privado, chamado como a tarefa chama, com a configuração de negativo e a auditoria), todos
     gravando e o razão fechando com a projeção; e o teto: p95 com a 7300001 presa < 50 ms (meta da SYNC 8.3;
     `TETO_TRAVA_VERSAO_MS` muda o limite, 100 ms no CI, que divide o PostgreSQL entre dois arquivos) em 100
     aplicações por `aplicarEvento` de uma venda de 10 itens com ficha e cascos. `test/integracao/estoque.test.ts`:
     estorno de acerto de Saída pela rota com saldo negativo (entra ao custo da saída, o custo médio da última compra
     fica).

133. **Handler `venda.finalizada`** (T15, T22, T23; SYNC 8.4, 8.5, 9.7, 10.2, 11.2, 13.1, 15.1, 15.3, 15.5; MD 3.5.4,
     3.7.2, 3.11; ERP 13.1.5; dono, O8, O15 e O24). `src/sync/handlers/vendas.ts`, anunciado em `versoes_schema`. O
     `preparar` (antes da 7300001, T21) confere o escopo do cabeçalho e das linhas de TEF/PIX, a sessão (existe na
     nuvem e é deste terminal; nunca recebida → `SESSAO_INEXISTENTE`; a sessão fechada à força continua aceitando a
     venda, MD 3.12.1), o número (outro id com o mesmo `(loja, caixa, número)` → `NUMERO_VENDA_DUPLICADO`, com o 23505
     de `uq_vendas_numero` como segunda barreira), recusa `emprestados` > 0 (comodato, Fase 3) e venda sem sessão
     (`PAYLOAD_INVALIDO`), resolve `cliente_id` e os `pessoa_id` por `pessoas_aliases` e lê os cadastros
     (`lerCadastrosEstoque`; produto que nunca existiu → `REFERENCIA_INEXISTENTE`). As dependências recalculadas são a
     sessão e as pessoas citadas (SYNC 8.5): a venda de uma sessão cujo `caixa.aberto` está em `erro` fica `retido`.
     - **Estoque (SYNC 10.2)**: `contexto.estoque_id` se ainda válido, senão `lojas.estoque_id` com o alerta
       `ESTOQUE_CONTEXTO_INVALIDO` (deduplicado por terminal e estoque); tipo `padrao`. Baixa o item não cancelado cujo
       produto, pelo cadastro **atual** da nuvem, controla estoque e não é `kit`, `produzido` nem `servico`: o combo
       chega desmembrado e cada componente escolhido é um item (a troca pelo Monster baixa o Monster, nunca o Red Bull
       nem o combo); o item com `componentes_estoque` baixa a lista como `BAIXA_INSUMO` no lugar dele (D17; o legado
       `origem = 'kit'` também), somando o mesmo insumo (T4); o casco cobrado (`vasilhame_item_origem_id`) sai como
       `VASILHAME_VENDIDO` no tipo padrão, no lugar do `VENDA_PDV`; os `devolvidos` do bloco `vasilhames` entram como
       `VASILHAME_DEVOLVIDO` no `vasilhame_vazio`, ao custo médio da linha (não trazem custo novo), com o id derivado
       (T4). A quantidade já vem na unidade base (o fardo de 12 baixa 12 UN), com `unidade_documento`/`fator` do
       código de barras lido quando ele é do produto. Insumo ou casco que não controla estoque não baixa.
     - **Negativo (15.1; O15 do dono: vende com aviso)**: nunca recusa; a linha que termina negativa gera
       `ESTOQUE_NEGATIVO` com `chave_deduplicacao = estoque_negativo:<estoque>:<produto>:<variação>` (um alerta aberto
       por linha, por mais vendas que cheguem).
     - **Compensação do "Definir" (15.3; ERP 13.1.5 regra 3)**: cada movimento da venda com `data_movimento` anterior à
       `data_contagem` de um "Definir" já efetivado (não estornado) da mesma linha ganha **um** `ACERTO_COMPENSACAO`
       de sinal oposto contra o último deles (`documento_tipo = 'acerto'`, o acerto, o item dele e
       `compensa_movimento_id`), na **mesma data do fato** (os dois se anulam em qualquer janela que um "Definir"
       futuro some) e, quando compensa uma saída, ao custo dela (o custo médio fica). Lançada pelo mesmo motor, na
       mesma transação, depois da venda.
     - **T23 (compensação no índice de idempotência)**: migração `0013_movimentos_compensacao`. O
       `uq_movimentos_estoque_idempotencia` não tinha `compensa_movimento_id`: a segunda venda tardia do mesmo produto
       contra o mesmo "Definir", ou dois itens do mesmo produto numa venda, gerava a segunda compensação com a mesma
       chave (mesmo item do acerto) e a venda caía em `AGREGADO_DIVERGENTE` a cada reenvio. A coluna entrou no índice
       (nula nos demais movimentos, que seguem como antes) e `uq_movimentos_estoque_compensacao (compensa_movimento_id)`
       garantia uma compensação por movimento (desde a 0018, uma por "Definir", `(compensa_movimento_id,
       documento_id)`: o estorno do "Definir" mais novo compensa de novo contra o anterior, decisão 148);
       `somarLinhasIguais` também separa por ela. Pelo mesmo motivo entrou
       `estorno_de_id`: estornar o "Definir" (ERP 13.5) lança um `ESTORNO_ACERTO` para o movimento do acerto e um para
       cada compensação, todos com o mesmo item do acerto, e o segundo dava 23505: o acerto que já tinha compensado
       uma venda nunca mais podia ser estornado. Com a coluna no índice (e em `somarLinhasIguais`) os estornos ficam
       distintos, e `uq_movimentos_estoque_estorno (estorno_de_id)` assume a barreira contra estornar o mesmo
       movimento duas vezes, que antes vinha da colisão no índice. O estorno desfaz a contagem e as vendas tardias
       passam a valer.
     - **Custo (10.2) e T22**: `itens_venda.custo_unitario = Σ custo_total dos movimentos do item ÷ quantidade` (4
       casas, de `custoPorItem`) e `vendas.custo_total` = Σ dos itens, já no `INSERT` (decisão 132). O item **sem
       baixa** (não controla estoque, serviço, produzido cuja ficha ainda não veio no payload) recebe o custo de
       referência do cadastro (`preco_custo`), em vez de nulo ou zero: a margem da venda não sai inflada por uma taxa
       ou um drinque; o item cancelado fica sem custo e fora do total. No item com ficha (`componentes_estoque`), o
       insumo que não controla estoque não baixa, mas entra no custo pelo de referência (`round(preco_custo ×
       quantidade, 2)`, `custoDosItens`): a caipirinha com a cachaça controlada e o limão e o açúcar sem controle
       ficava só com o custo da cachaça, e a margem saía inflada justamente onde a T22 queria evitar.
     - **Conferências sem recusa (SYNC 9.7, 16.2; P6)**: `conferirSomasVenda` confere Σ pagamentos aprovados =
       `total`, `troco` = Σ troco, `subtotal_bruto` = Σ `valor_bruto` dos itens não cancelados, o `valor_liquido` de
       cada item pela fórmula da MD 3.11.3 e, por `kit_grupo_id`, Σ `valor_bruto` = `arred2(kit_quantidade ×
       kit_preco_unitario)`, em decimal exato. Diferença não recusa: a venda grava como veio e cria
       `VENDA_INCONSISTENTE` (aviso, as diferenças em `dados.diferencas`, um por venda). O item não cancelado de
       produto excluído ou inativo **antes** de `finalizada_em` gera `PRODUTO_INATIVO_VENDIDO` (deduplicado por loja e
       produto). Instante da inativação: `excluido_em`; no inativo sem exclusão, `atualizado_em`, o último momento em
       que o cadastro mudou e a partir do qual ele com certeza já estava inativo (não há coluna da hora da inativação;
       a comparação nunca dá alerta falso, só deixa de avisar quando o cadastro foi editado de novo depois da venda).
     - **Comissão (O24 do dono)**: não há vendedor no balcão; `comissao_pct`/`valor_comissao` ficam nulos (a regra da
       SYNC 10.2 entra com o vendedor, Fase 3). O financeiro da venda (10.2, contas a receber, vale, crédito) é da
       Fase 4; `liberacoes` (só payload) vão na `auditoria` da venda; `nfe_solicitada`/`nfe_pendente_erp` ficam para o
       fiscal.
     - **Gravação**: as linhas do payload viram colunas pelo nome (T17; só as da tabela, instantes em `Date`, uuids em
       minúsculas para o reenvio comparar com o que o banco devolve); `terminal_id` = o terminal dono, `cliente_id` e
       `pagamentos_venda.pessoa_id` resolvidos, `relogio_confiavel` do envelope (T5); TEF e PIX do caixa ligados à
       venda. Cada tabela num comando por bloco (`inserirEmBlocos`: até `LINHAS_POR_COMANDO` linhas e nunca mais de
       65535 parâmetros por comando; uma comanda de uns 1100 itens completos passava do limite e caía em
       `ERRO_INTERNO` a cada reenvio), na ordem das FKs, com os itens cheios antes dos cascos cobrados
       (`ordenarCheiosAntes`: a FK do casco é conferida no fim de cada comando). Depois: `numeracoes` (`greatest`, só
       avança e grava quem usou o número; cria a linha se faltar) e a auditoria `origem = 'pdv'` da venda.
     - **Reenvio (8.4)**: a venda que já existe é comparada no cabeçalho e em todas as linhas (itens, complementos,
       pagamentos, parcelas, TEF, PIX), fora o que a nuvem preenche ou muda depois (status, fiscal, custo, comissão,
       cancelamento, relógio): igual → `ja_existia`, sem estoque nem compensação de novo; diferente →
       `AGREGADO_DIVERGENTE`.
     - **Relevância `compra` (MD 3.5.4; O8 do dono: escolher cliente cadastrado na 1C) e T15**: com `cliente_id` de
       pessoa viva, a linha `compra` da loja é criada com `ultima_ocorrencia_em = finalizada_em` e toca a pessoa e as
       filhas (descem aos PDVs da loja); se já existe, só avança quando a venda é pelo menos
       `INTERVALO_RELEVANCIA_COMPRA` (1 dia) mais nova, sem toque. Desvio da MD 3.5.4 ("a cada compra"): cada UPDATE
       dá versão e desce a todos os PDVs da loja, o mesmo ruído do `custo_medio`, e a expiração conta meses. A tarefa
       diária de expiração é do C14.
     Testes: `test/integracao/venda-eventos.test.ts` (um por critério do roadmap: fardo de 12 com `FD`/fator 12,
     custo, `numeracoes` com `greatest`, auditoria e `relogio_confiavel`; combo de whisky com o Monster; casco faltante
     e vazios trazidos, comodato recusado; mix de 12 latas; reenvio do lote, venda gerada de novo e conteúdo
     divergente; número duplicado em `erro` sem estoque; duas lojas sem versão nova em `produtos`; um alerta só de
     estoque negativo; "Definir" com vendas tardias, dois itens do mesmo produto e reenvio sem compensar de novo; e
     também ficha técnica somada com o legado `kit` e o custo de referência (T22), estoque do contexto válido,
     inativo e excluído, cliente por alias com a relevância criada, mantida e avançada, sessão retida, inexistente e
     fechada à força (a venda tardia entra), produto inexistente; a fixture `venda.finalizada.payload.json` do C4
     aplicada com os ids do ambiente e reenviada; TEF, PIX, complemento e parcela gravados e ligados, com reenvio;
     total e combo errados com `VENDA_INCONSISTENTE`; produto excluído e inativo com `PRODUTO_INATIVO_VENDIDO`;
     ficha mista (T22); estorno do "Definir" com compensações; venda de 1200 itens em blocos);
     `src/sync/handlers/vendas.spec.ts` (`conferirSomasVenda`, `custoDosItens`, `ordenarCheiosAntes`);
     `src/estoques/movimentos.spec.ts` (T23 em `somarLinhasIguais`, com `estorno_de_id`). `sync.test.ts` passou a
     usar `nfce.autorizada` (1D) como o tipo ainda sem handler.

134. **Cancelamento, devolução de cascos e alerta de cadastro** (T2, T20, T24–T26, D29; SYNC 8.4, 8.5, 9.9, 9.24,
     9.26, 10.1, 10.4, 11.2, 15.3; MD 3.1.2, 3.11, 3.12.6, 7.3; dono, O6, O14 e O22). `src/sync/handlers/cancelamento.ts`,
     `handlers/vasilhame.ts` e `handlers/alertas.ts`, os três tipos anunciados em `versoes_schema`. O `venda.finalizada`
     (`handlers/vendas.ts`) passou a exportar o que os três reaproveitam, sem mudar de comportamento: a conferência do
     documento (`conferirDocumentoVenda`: escopo, sessão, número, aliases), a da sessão (`conferirSessaoDoDocumento`),
     `montarLinhas`/`gravarLinhasVenda`/`conferirVendaGravada`, `avancarNumeracao`, a escolha do estoque do contexto
     com o alerta (`escolherEstoque`, `alertarEstoqueContexto`) e a compensação do "Definir" (`compensarDefinir`, com o
     documento na observação; desde o F2-B4 em `estoques/compensacao.ts`, no motor, decisão 148).
     - **`venda.cancelada` forma B (9.9 B)**: o documento completo da venda em andamento cancelada, conferido e gravado
       como o `venda.finalizada` (escopo, sessão, `NUMERO_VENDA_DUPLICADO`, aliases), **sem** estoque, custo
       (`custo_total`/`custo_unitario` nulos) nem financeiro; `numeracoes` avança com `greatest` (é por ela que os
       números reservados e não finalizados aparecem no ERP; os da 1B continuam vagos, O13). Reenvio: comparado em todas
       as colunas, inclusive status e cancelamento (só o relógio do envelope fica de fora); a mesma venda já gravada
       como finalizada → `AGREGADO_DIVERGENTE`. Depende da sessão e das pessoas citadas.
     - **`venda.cancelada` forma A (9.9 A, 10.4)**: o `preparar` (antes da 7300001, T21) confere o escopo das linhas, a
       venda (nunca recebida → `TRANSICAO_INVALIDA`; de outro terminal → `ESCOPO_INVALIDO`, a SYNC 11.2 diz o mesmo),
       a sessão do cancelamento (existe e é deste terminal; a fechada à força aceita), cada pagamento citado contra os
       da venda, uma vez só, e o `estorno` contra o pagamento gravado (`estornosInvalidos`, O22 e D24:
       `dinheiro_devolvido` só na forma dinheiro, `devolvido_em_dinheiro` fora dela e com um `estorno_venda` na forma
       Dinheiro, `tef_*` com `tef_transacao_id`, `pos_cancelado_na_maquininha` em cartão de crédito, débito, VA ou VR,
       `pix_*` em PIX; senão `PAYLOAD_INVALIDO` — o mesmo pagamento com dois estornos contaria a devolução duas vezes,
       e um `pix_*` num cartão deixaria a TEF aprovada sem alerta), a transação TEF do payload (só `operacao =
       'cancelamento'`) e lê os movimentos da venda ainda sem estorno. O `aplicar` trava a linha
       da venda e decide pelo estado dela: `finalizada` → estorna o estoque, grava as colunas de cancelamento (motivo
       já aparado pelo contrato, O6; `status_fiscal` se veio), os pagamentos citados `estornado`, os `estorno_venda` da
       sessão do cancelamento (`gravarMovimentos` do C5), as transações TEF de cancelamento (ligadas à venda,
       idempotentes pelo `id`; a conferência da camada 2 do `venda.finalizada`, `conferirVendaGravada`, deixa de fora as
       de `operacao = 'cancelamento'` que o documento não trouxe, senão o `venda.finalizada` gerado de novo depois do
       cancelamento viraria `AGREGADO_DIVERGENTE`); `tef_cancelado` marca a transação de origem `cancelada` e
       `pix_devolvido_api`/`pix_devolucao_manual` marcam a cobrança `devolvida` (valor devolvido = o da cobrança);
       `devolvido_em_dinheiro` não mexe nelas (a credenciadora/PSP ainda paga, O22) e
       `tef_estorno_pendente`/`pix_devolucao_pendente` geram `ESTORNO_PENDENTE` (aviso, um por venda). O financeiro
       (parcelas, baixas, consolidação, vale, crédito) é da Fase 4. A auditoria `cancelar` guarda o `estorno` de cada
       pagamento (só do payload) e o que saiu da gaveta. Pagamento não citado fica como está. A sessão do cancelamento
       diferente da sessão da venda é aceita (o dinheiro já saiu; O6 limita isso no caixa).
     - **Estorno do estoque (10.4, T20) e vazios trazidos (T24 → D29)**: cada `VENDA_PDV` e `BAIXA_INSUMO` da venda volta como
       `CANC_VENDA_PDV`/`ESTORNO_BAIXA_INSUMO` com `estorno_de_id`, a mesma quantidade com sinal oposto, no mesmo
       estoque, tipo, lote, item, embalagem e pessoa, ao **custo da saída original** (com saldo positivo a média
       recalcula como entrada, o mesmo que a venda não ter acontecido; com zero ou negativo fica), `data_movimento =
       cancelada_em`, pelo `lancarDocumento` do C6a; o combo devolve cada componente escolhido ao custo dele. O casco
       cobrado (`VASILHAME_VENDIDO`, que substitui o `VENDA_PDV` do item de casco, 10.2) também volta, como
       `CANC_VENDA_PDV` (é item vendido: "cancelar a cerveja cancela o casco", PDV 10.12). Os vazios trazidos
       (`VASILHAME_DEVOLVIDO` do bloco `vasilhames`) são regra de negócio do dono (D29, respondida em 31/10/2026; a T24 do C7 os
       deixava na loja sem configuração, e a nuvem ficava com cascos que o cliente levou de volta): seguem
       `pdv.cancelamento_devolve_vazios` da loja do terminal, lida na aplicação — **ligada por padrão (decisão do dono:
       voltam ao cliente)**, a entrada dos vazios volta como `ESTORNO_VASILHAME_DEVOLVIDO` (tipo novo no seed, sinal −1, saída do
       `vasilhame_vazio` com `estorno_de_id`, ao custo médio da linha, como toda saída do motor) e a tela do C11b
       orienta devolver os cascos (README do PDV › decisão 55); desligada, ficam na loja. A escolha vai na auditoria (`devolve_vazios`). Lacuna: o
       estorno dos vazios pode deixar o `vasilhame_vazio` negativo sem `ESTOQUE_NEGATIVO` (só a venda alerta). Estorno anterior à
       contagem de um "Definir" efetivado ganha o `ACERTO_COMPENSACAO` (15.3), como a venda. Segunda barreira contra
       estornar duas vezes: `uq_movimentos_estoque_estorno` (T23).
     - **Cancelar duas vezes (8.4, 10.4)**: a venda já cancelada pelo caixa com as mesmas colunas e os mesmos
       `estorno_venda` → `ja_existia`, sem estornar de novo; outro motivo, outra hora ou um `estorno_venda` que a nuvem
       não tem (seria uma saída de gaveta em dobro) → `AGREGADO_DIVERGENTE`. Venda já cancelada **pelo ERP** (Fase 3;
       corrida da 10.4): não repete o estorno lógico (estoque, pagamentos), grava o que é físico (o `estorno_venda` e o
       TEF de cancelamento, idempotentes pelo `id`) e cria `CANCELAMENTO_DUPLO` (aviso, um por venda) com os dois
       registros; as colunas de cancelamento continuam as do ERP e o do caixa fica na auditoria. Um segundo
       cancelamento do caixa para essa venda é conferido com o da auditoria (`divergenciasDoCaixa`) e segue a regra do
       caminho do caixa: o mesmo → `ja_existia`, outro (outro motivo ou outro `estorno_venda`) → `AGREGADO_DIVERGENTE`
       — antes ele gravava mais um `estorno_venda` e o alerta deduplicado não acusava. Venda cancelada em andamento
       (forma B) ou em outro estado → `TRANSICAO_INVALIDA`.
     - **Dependências (8.5)**: a forma A depende do agregado `venda` (o `venda.finalizada` em `erro`/`retido` retém o
       cancelamento) e da sessão do cancelamento. Pela mesma regra, um `venda.cancelada` rejeitado (por exemplo
       `PAYLOAD_INVALIDO`) retém o cancelamento seguinte da mesma venda até a fila de decisão (C8) resolver o primeiro
       (o `AGREGADO_DIVERGENTE` não retém, `eventoPendente`).
     - **`vasilhame.movimentado` (9.26; T2, O14)**: só o destino `entrada`; `baixa_comodato` e `vale` (e qualquer
       `vales`/`movimentos_vale`) → `PAYLOAD_INVALIDO` até a Fase 3. Confere o escopo, a sessão (`SESSAO_INEXISTENTE`)
       e o casco (`REFERENCIA_INEXISTENTE`; produto que não é do tipo `vasilhame` → `PAYLOAD_INVALIDO`, por
       `conferirCascos`, que o bloco `vasilhames` do `venda.finalizada` também passou a usar: outro produto que controla
       estoque entraria no `vasilhame_vazio` sem erro), resolve a pessoa por `pessoas_aliases` e grava `movimentos_vasilhame` e o
       `VASILHAME_DEVOLVIDO` no `vasilhame_vazio` do estoque do contexto (ou da loja, com `ESTOQUE_CONTEXTO_INVALIDO`),
       ao custo médio da linha ou ao de referência do casco (não traz custo novo), na hora do fato. **T26**:
       `documento_tipo = 'vasilhame'` e `documento_id = documento_item_id = movimentos_vasilhame.id` — o documento tem
       uma linha só, e o índice de idempotência fica coberto sem id derivado (o UUIDv5 da T4 é para o bloco
       `vasilhames` da venda, que não tem item). Casco que não controla estoque grava só o movimento. Entrada anterior
       a um "Definir" ganha a compensação. Reenvio igual → `ja_existia`; outro conteúdo → `AGREGADO_DIVERGENTE`.
       Depende da sessão e da pessoa.
     - **`alerta.cadastro` (9.24) e T25**: um tipo só de alerta, `CADASTRO_PRODUTO` (aviso), com o `tipo_alerta` do
       caixa no título e em `dados` (com a variação, o terminal e os `detalhes`) e `chave_deduplicacao =
       cadastro:<tipo_alerta>:<produto_id>` (com o alerta aberto, o caixa que avisa de novo não repete: `ja_aberto`).
       A chave é da empresa, e o alerta também: `loja_id` nulo (todo gerente com acesso aos alertas o vê; preso à
       loja do primeiro caixa, sumia para quem só vê as outras lojas que avisaram), a primeira loja em `dados.loja_id`
       e as que avisaram em `dados.lojas`. Um tipo por motivo encheria o filtro do Dashboard com seis nomes para a
       mesma tela de correção. **T25** também
       nomeia o alerta da 10.4 sem nome na especificação: `ESTORNO_PENDENTE`. Produto ou variação que nunca existiu →
       `REFERENCIA_INEXISTENTE` (o excluído é aceito). Auditoria `origem = 'pdv'` em todos os três.
     Testes: `test/integracao/cancelamento-vasilhame-eventos.test.ts` (um por critério do plano: cancelar o combo
     devolve os 3 componentes ao custo original com o custo médio mudado depois da venda, venda, pagamento, gaveta e
     auditoria; cancelar duas vezes — reenvio do lote, gerado de novo, outro motivo e outro movimento de gaveta —; a
     corrida com o ERP e `CANCELAMENTO_DUPLO`, com o reenvio `ja_existia` e o segundo cancelamento divergente; o casco
     cobrado que volta e os vazios que voltam com a chave ligada e ficam com ela desligada (D29); a ficha técnica
     (`ESTORNO_BAIXA_INSUMO` ao custo da baixa); o estorno por forma com a cobrança PIX devolvida, o devolvido em
     dinheiro, o pendente com `ESTORNO_PENDENTE` e os incompatíveis; o pagamento citado duas vezes e o devolvido em
     dinheiro sem a linha na forma Dinheiro; o TEF cancelado com a transação de cancelamento e o `venda.finalizada`
     gerado de novo `ja_existia`; a fixture da forma A aplicada pelo push (`status_fiscal`, os dois `estorno_venda`) e
     reenviada; venda nunca recebida, retida, cancelada em andamento (forma B → A) e sessão inexistente; cancelamento
     anterior a um "Definir"; a fixture da forma B aplicada e reenviada; a forma B sobre venda finalizada e com número
     de outra venda; a devolução avulsa com reenvio do lote, gerada de novo e divergente; comodato, vale, sessão e
     casco inexistentes e a fixture do C4; o casco sem estoque, o estoque do contexto inválido e o produto que não é
     casco, na devolução e na venda; o alerta de cadastro da fixture deduplicado entre duas lojas e o produto
     inexistente; e, do C11c, a fixture `venda.finalizada.cascos.payload.json` gerada pelo PDV — os cascos descontados
     na venda chegam como desconto no total de origem `cliente` e `devolvidos` além dos devidos, aplicados sem nada novo
     no handler, e a forma A devolve os 5 vazios e o valor pago); `src/sync/handlers/cancelamento.spec.ts` (`estornosInvalidos`, `estornosDaVenda`,
     `tiposEstornados`, `divergenciasDoCaixa`).

135. **Fila de decisão mínima** (T9, T27, T28, D20; SYNC 8.1, 8.5, 11.2–11.4, 13.1, 21.1; MD 3.11.2, 3.15.2; ERP 12.5,
     12.6, 17.1). `src/terminais/fila-decisao.ts` (`FilaDecisao`) e `eventos-recebidos.controller.ts`, todas as ações
     com `terminais.gerenciar`, a loja do evento entre as do usuário e auditoria na mesma transação.
     - **`EVENTO_COM_ERRO` (11.3, T9)**: `marcarEvento` (`src/sync/aplicacao.ts`) abre o alerta de todo evento que vai a
       `erro` — no push (regra, hash divergente, 3ª exceção) e no reprocessamento —, `critico` para `venda.*`,
       `caixa.*` e `nfce.*` (`eventoCritico` em `@genesis/shared`) e `aviso` para os outros, com `chave_deduplicacao =
       evento_erro:<evento_id>` e o `eventos_recebidos.id` em `registro_id`. O `retido` não abre alerta (quem decide é o
       bloqueador). Fecha ao reprocessar (aplicado ou retido de novo) e ao descartar; o evento que volta a `erro` com
       **outro** código fecha o anterior e abre um novo, com o mesmo código o aberto fica (sem repetir a cada clique).
     - **Reprocessar (11.4)**: uma transação de evento (`travarTerminal` primeiro, como o push, SYNC 8.1), a linha
       relida sob a trava (já resolvida → 409 `CONFLITO`: dois cliques ou o push aplicaram antes), `tentativas + 1`,
       o envelope remontado da linha (`envelopeDaLinha`, com o `usuario_id` e o contexto gravados, T1) e
       `aplicarEvento` com `entregueNaResposta = false` (`resolucao_entregue_em` nulo: o heartbeat entrega o
       `aplicado`, com os marcadores e o `resultado`, até o ack). O `payload_sha256` não é conferido de novo: o hash
       divergente é diagnóstico do serializador (8.1) e o payload gravado é o que chegou. Ainda com dependência
       pendente → `retido` de novo. Erro de regra ou exceção → `rollback` e transação nova grava o `erro` (a exceção
       já é `ERRO_INTERNO`: quem clicou vê o desfecho; não há as três tentativas do push); transitório
       (`SCHEMA_DESCONHECIDO`, `CONCORRENCIA_BANCO`, `BANCO_INDISPONIVEL`) → 409 sem mudar nada. Aplicado, os `retido`
       do mesmo terminal que o push segurou por ele (`{evento_id_bloqueador}` em `dependencias`) são reaplicados na
       mesma requisição, **um por vez, sempre o de menor sequência** cujo bloqueador já foi aplicado aqui: numa cadeia
       (a sessão retida pelo fechamento anterior, a venda retida pela sessão, o cancelamento retido pela venda) a ordem
       do terminal vale, e não a ordem de "rodadas". Cada dependente na própria transação de evento, auditado (`modo:
       'dependente'`). A resposta traz o desfecho do evento e de cada dependente. **Precondição sob a trava**: além
       de `erro`/`retido`, `relerPendente` confere de novo a situação em que a ação foi decidida — o dependente da
       cadeia precisa continuar `retido` (se outro gerente descartou o outro bloqueador no meio, ele foi a `erro`
       `DEPENDENCIA_DESCARTADA` e espera a decisão humana da 8.5, em vez de ser aplicado sozinho), o "Aplicar com novo
       número" precisa continuar `NUMERO_VENDA_DUPLICADO` e o lote, com o código pedido; senão 409 "mudou de
       situação" (na cadeia e no lote, pulado).
     - **Terminal revogado ou substituído (D20)**: o terminal vem de `terminais` em qualquer status
       (`carregarTerminalDoEvento`); o `caixa.aberto` reprocessado depois da revogação entra fechado à força (T16) e as
       vendas dele são aceitas na sessão fechada (MD 3.12.1). Toda ação roda `resolverAlertasSemEventos`: o alerta
       `TERMINAL_DESATIVADO_COM_EVENTOS` fecha na hora em que o último evento pendente do terminal se resolve, sem
       esperar a manutenção.
     - **Descartar (8.5, 11.4)**: justificativa de 15 a 500 caracteres (aparada) e, nos tipos críticos, a confirmação
       digitada (`confirmacao`); grava `descartado`, `descartado_em/por` e a justificativa, com
       `resolucao_entregue_em` nulo (o PDV recebe o `descartado` no heartbeat); fecha o `EVENTO_COM_ERRO`, abre o
       `EVENTO_DESCARTADO` (`critico`, `evento_descartado:<evento_id>`, com o resumo do agregado sem dado pessoal e os
       dependentes) e leva
       os `retido` que o push segurou por ele a `erro` `DEPENDENCIA_DESCARTADA` (cada um com o seu `EVENTO_COM_ERRO`:
       decisão humana para cada um). Auditoria `evento_descartado`. **T28**: a confirmação é o número exibido da
       venda (`numero_exibicao` do payload; na forma A do cancelamento, que não o traz, o da venda gravada); o evento de
       caixa não tem número de venda e a SYNC 11.4 não diz o que digitar, então vale a **sequência do evento**, que a
       fila mostra em toda linha (a mesma regra para o payload ilegível). Confere sem maiúsculas, espaços e, no número
       da venda, só pelos dígitos do fim (`123` confere `L01-C02-000123`); a tela mostra o que digitar
       (`confirmacaoDescarte`).
     - **Aplicar com novo número (11.2, 13.1; T27)**: só o `erro` `NUMERO_VENDA_DUPLICADO` de um `venda.*`
       (`aceitaNovoNumero`), senão 422. É o Reprocessar com `ContextoHandler.novoNumero`: a conferência do número
       (`conferirDocumentoVenda`) não recusa e o `aplicar` do `venda.finalizada` e da forma B do `venda.cancelada` grava
       a venda com `renumerarVenda`, **sob a 7300001**. **T27**: o "próximo livre do caixa" da SYNC 11.2 colidiria de
       novo — o terminal ativo do caixa continua contando pela sequência local dele, e o número logo acima do último
       usado é a próxima venda dele (e a renumerada empurraria `numeracoes` para a faixa do terminal). Por isso a venda
       renumerada vai para a **faixa de renumeração** do caixa, a partir de `INICIO_FAIXA_RENUMERACAO` (9.000.001, o
       maior já usado na faixa + 1; nove milhões de vendas num caixa são décadas), com `numero_exibicao` trocando só
       os dígitos do fim (`L01-C02-9000001`) e o número do caixa em `vendas.observacao` ("Número original do caixa:
       …"), no `resultado` (`numero_original`, `numero_exibicao_original`, `numero`, `numero_exibicao`: o PDV recebe
       no heartbeat) e na auditoria do handler e da fila. `numeracoes` avança com o número **do PDV** (a faixa fica
       fora: é a base da próxima ativação, 13.3). O payload gravado não muda. Lacuna: o PDV guarda a venda com o
       número dele (o cupom já saiu com ele); a reimpressão e a reconciliação de `resumo_vendas` (1D) mostram o do
       caixa.
     - **Reprocessar todos com este código (11.4)**: `POST /eventos-recebidos/reprocessar-lote {terminalId, codigo}`
       cria a tarefa `reprocessar_eventos` (ERP 3.6, pg-boss, `202` com `tarefaId` e a quantidade; nenhum evento com o
       código → 422). O executor reaplica os `erro` do código daquele terminal em ordem de sequência, como o
       Reprocessar (com os dependentes, auditados com `modo: 'lote'`). O pedido é auditado na transação que cria a
       tarefa (`evento_reprocessado` com `modo: 'lote_agendado'`, o código, a quantidade e o id da tarefa, na
       entidade `terminais`: aparece no histórico do terminal, mesmo que nenhum evento chegue a ser reaplicado), e a
       tarefa guarda em `parametros.origem` o nome, o IP, o user agent e a requisição de quem pediu: a auditoria de
       cada evento do lote sai com eles, como a do Reprocessar da tela. O que já foi resolvido ou tirado do código no
       meio do caminho é contado em `ignorados`; o transitório do banco (409 com `detalhes.codigo`: deadlock, conexão
       perdida, `SCHEMA_DESCONHECIDO`) é tentado de novo até 3 vezes e, se persistir, contado em `adiados` (o evento
       continua em `erro`, sem tentativa registrada). Resultado da tarefa: `total`, `aplicados`, `retidos`, `erros`,
       `ignorados`, `adiados`, `dependentes`. Por terminal, como a aba (a correção que vale para todos os caixas pede
       um lote por terminal; um lote da empresa fica para quando houver a tela de alertas, C14).
     - **Listagem (ERP 12.5)**: `GET /terminais/:id/eventos-erro?status=&codigo=&pagina=&tamanho=` (até 200 por
       página, padrão 50) devolve `{itens, total, pagina, tamanho, codigos}` — `codigos` são os códigos de `erro` do
       terminal com a quantidade, sem o filtro, para o lote. Cada item ganhou `resumo` ("Venda L01-C02-000123 · R$
       71,58 · 4 itens", lido do payload: a venda nunca aplicada não existe na nuvem; vem também sem
       `terminais.gerenciar`, mas aí sem dado pessoal — o nome digitado de quem retira a sangria, que pode ser alguém
       de fora do sistema, só vai a quem vê o payload, D19; o alerta e a auditoria do descarte também ficam sem ele) e
       `confirmacaoDescarte`. O número da venda gravada (forma A do cancelamento, `nfce.*`) é buscado só para o id em
       formato UUID: o `PAYLOAD_INVALIDO` guarda o payload como chegou, e um `vendas.id` malformado faria o PostgreSQL
       recusar a consulta (22P02) e travaria a fila e o descarte daquele terminal; sem número, a confirmação é a
       sequência. O link para a venda espera a consulta de vendas do ERP (C12).
     - **Alertas da fila na tela (ERP 12.5: "venda nunca é descartada sem gerar alerta")**: o detalhe e a listagem de
       terminais mostram, além dos alertas de terminal, o `EVENTO_DESCARTADO` (um a um, até 50) e o `EVENTO_COM_ERRO`
       **somado por terminal** ("Caixa 02: N eventos com erro", crítico se algum for, com o id e a mensagem do mais
       recente; até 50 terminais), com o terminal tirado de `dados.terminal_id` (os dois são por evento,
       `entidade = 'eventos_recebidos'`). Cada grupo tem o seu limite, para centenas de eventos com erro não
       esconderem o alerta de token anterior ou da D20. O `EVENTO_COM_ERRO` fecha sozinho (reprocessar ou descartar);
       o `EVENTO_DESCARTADO` fica aberto até alguém com `terminais.gerenciar` marcar "Ciente" pela rota de resolver
       alerta do terminal (`POST /terminais/:id/alertas/:alertaId/resolver`, só para o alerta daquele terminal,
       auditado como `conferir`).
     - **Ação de auditoria `evento_reprocessado` (T9)**: nova no catálogo (`ACOES_AUDITORIA` e o espelho
       `CatalogosNuvem` do PDV, conferido pelo `CicloOnlineTests`), uma por evento reaplicado, com o `modo` (`manual`,
       `dependente`, `lote`, `novo_numero`), a situação antes e depois e, no novo número, os dois números.
     - **Fora deste bloco**: o painel de alertas críticos do Dashboard (O11, C14: até lá, os alertas da fila aparecem
       no detalhe e na listagem de terminais, acima), `GET /sync/eventos-status` (C14), a lacuna (C15) e o que o PDV
       faz com o descartado no saldo estimado (C11a).
     Testes: `test/integracao/fila-decisao.test.ts` (um por critério do plano: reprocessar com os dependentes — a
     abertura com hash divergente segurando venda, cancelamento e sangria, aplicados em ordem, o alerta fechado, a
     auditoria e o heartbeat; o que falha de novo; descartar com os dependentes, a confirmação, a justificativa curta, o
     heartbeat, o descarte da venda pelo número, os alertas no detalhe e na listagem e o "Ciente" (que não acha o
     alerta pelo terminal errado); o payload com `vendas.id` fora do formato UUID listado e descartado; o não crítico
     com aviso e sem confirmação; aplicar com novo número no `venda.finalizada` e na forma B, a segunda colisão,
     `numeracoes` intacta e o resultado no heartbeat; o código que muda enquanto o "Aplicar com novo número" espera a
     trava (409, nada aplicado); a recusa fora do `NUMERO_VENDA_DUPLICADO`; a concorrência com o push — o
     reprocessamento esperando a `push:` de um push em andamento e, na outra direção, um reprocessamento parado com a
     `push:` (o teste segura a 7300001 que ele espera) fazendo o push receber 409 `PUSH_EM_ANDAMENTO` e o segundo
     clique esperar e receber 409 —; o terminal revogado com o alerta da D20 fechado; o lote por código numa tarefa,
     com os alertas somados, o nome de quem pediu e a auditoria do pedido; a permissão e o resumo sem o payload e sem
     o nome de quem retira a sangria); `src/terminais/fila-decisao.spec.ts` (resumo, confirmação, `aceitaNovoNumero`);
     e os testes de tela em `apps/erp-web/src/paginas/terminais/Terminais.test.tsx` (inclusive a página que esvazia
     depois da ação, o 409 do descarte e o "Ciente").
136. **Formas de pagamento personalizadas por loja** (C8b; dono, O9a/D25 e O23/D30; MD 3.10.1, 7.7; ERP 10.2; SYNC 9.7;
     migração `0014_formas_pagamento_lojas`). O ERP cadastra formas próprias (nome, tipo base em `tipo_forma`, "dá
     troco", "exige supervisor", ativa) e escolhe em quais lojas cada uma vale; elas descem só ao caixa dessas lojas.
     - **Vínculo forma × loja**: `formas_pagamento.loja_id` (uma loja ou todas) saiu e entrou
       `formas_pagamento_lojas` (CP, AU, `forma_pagamento_id`, `loja_id`), com **uma linha de `loja_id` nulo para
       "todas"**, o desenho de `pessoas_relevancia_loja` (MD 3.5.4), e não o "sem linha = todas" de
       `planos_contas_lojas`: o caixa só recebe os vínculos de "todas" e da própria loja, então, se "todas" fosse a
       ausência de linha, a troca de "todas" para "só a Loja Treino" nunca chegaria ao caixa da Hermes (nenhuma linha
       dele muda). Com a linha nula, a troca a exclui e a exclusão desce. Sem vínculo vivo, a forma não vale em loja
       nenhuma (só acontece fora da API). `uq_formas_pagamento_lojas (forma_pagamento_id, loja_id) nulls not distinct
       where excluido_em is null`; `forma_pagamento_id` e `loja_id` imutáveis (`fn_filtro_imutavel`). A migração cria
       a linha da loja que a forma tinha, ou a de "todas", também para as formas excluídas (a exclusão continua
       descendo pelo filtro).
     - **Descida (fluxo `configuracao`)**: `formas_pagamento_lojas` com o filtro `loja_id is null or = X` (vivas e
       excluídas); `formas_pagamento` só com vínculo de "todas" ou da loja X, **vivo ou excluído** — a forma de outra
       loja nunca desce, e a que deixou de valer continua no filtro para a exclusão (dela ou do vínculo) descer. O PDV
       oferece a forma com um vínculo vivo (`CatalogoLocal.FormasPagamentoAsync`; a tela é do C11a). Quem muda as lojas
       **toca** a forma (`sync/toque.ts`): sem isso, a forma antiga ficaria abaixo do cursor do caixa da loja que
       acabou de ganhar e não desceria (o vínculo desce antes, versão menor; o PDV não tem FK nos espelhos). Gravar sem
       mudar as lojas não toca nem cria vínculo.
     - **CRUD (`formas-pagamento.controller.ts`)**: `lojaIds` no corpo (vazio = todas, repetidas ignoradas) e no
       detalhe; a listagem devolve `lojas` (`id`, `codigo`, `nome`; vazio = todas) e o filtro `lojaId` traz as de
       "todas" e as da loja. Permissões `formas_pagamento.*` (já existiam). Por loja (ERP 2.1): vê a forma quem tem
       uma das lojas dela (ou ela é de "todas"); grava (editar, excluir) só quem tem **todas** as lojas dela — a forma
       da Hermes e da Treino é só leitura para o gerente da Hermes, para ele não tirar, sem ver, a loja alheia —, e só
       concede lojas que tem. A de "todas" continua editável por quem tem só algumas lojas, como antes. Auditoria com
       `lojaIds` no antes/depois. A exclusão continua lógica e livre (a venda guarda o snapshot da forma; o "com vendas,
       só inativar" do ERP 10.2 fica para as consultas de venda, C12).
     - **Loja excluída** (`lojas.controller.ts › excluir`): exclui também os vínculos dela, como já fazia com caixas e
       numerações; sem isso o detalhe da forma trazia o id da loja excluída em `lojaIds` e gravar sem mexer dava 422
       "Loja inexistente ou excluída". A forma que só valia nela é excluída junto (auditoria `excluir` da forma, com a
       descrição "Excluída com a loja, a única em que valia."): sem vínculo vivo ela não valeria em loja nenhuma, mas o
       ERP a mostraria como "todas". Nada disso precisa descer: a loja excluída não tem terminal.
     - **Descrição única na empresa** (era por loja): a forma vale em várias lojas e o fechamento por forma e as
       consultas agrupam pelo nome. A migração renomeia as repetidas de lojas diferentes com o código da loja no fim
       ("Ticket (loja 2)"); a de "todas" fica igual. O nome gerado nunca colide (uma colisão abortaria a migração
       daquele banco): já em uso — outra forma "Ticket (loja 2)", ou duas descrições longas iguais depois do corte em
       40 caracteres —, o sufixo ganha um contador ("Ticket (loja 2-2)"); a renomeação é linha a linha num `do $$`,
       conferindo as formas vivas da empresa inteira, então não viola o índice antigo (por loja) nem o novo. Na mesma
       migração, o vínculo de uma loja já excluída nasce excluído e a forma viva que só valia nela é excluída, a regra
       da exclusão de loja acima.
     - **`exige_supervisor`** (novo, padrão desligado): o caixa pede a liberação de um supervisor (PIN, PDV 31.3) para
       lançar a forma — o uso é do C11a, que soma esta flag à `pdv.pix_manual_exige_supervisor` (O9b). É diferente da
       `senha_liberacao_hash` do Nuvem3 (senha da própria forma), que continua.
     - **Troco (O23)**: "dá troco" é a `permite_troco` que já existia (padrão desligado; só o Dinheiro do seed liga).
       `ck_formas_pagamento_troco` e a regra do zod (`TIPOS_SEM_TROCO`): troco só em forma **sem integração** e fora
       de `cartao_credito`, `cartao_debito` e `pix` — cartão e PIX não passam do total, e nada que passe pela
       maquininha, TEF ou PIX dá troco em dinheiro (pega também VA/VR e formas personalizadas com POS). A forma
       personalizada sem integração segue a flag. A migração desliga o troco que já estivesse assim antes do CHECK.
     - **Tipo base**: o `tipo_forma` existente (dinheiro, PIX, cartão débito/crédito, outros e os demais do MD 3.10.1);
       não houve coluna nova.
     - **Seed (MD 7.7; O9a)**: cada forma nova nasce com o vínculo de "todas"; **Vale Alimentação e Vale Refeição
       nascem inativas** (a Ice Beer não aceita VA/VR no piloto). Empresa já provisionada não muda (o seed não altera
       o que existe): desligar na tela. O seed procura a forma pela descrição na empresa toda.
     - **Contrato**: não muda (decisão 130). O handler da venda não confere se a forma vale na loja: a venda feita no
       caixa com o espelho de antes da troca é aceita.
     - **PDV**: `Esquema.g.cs` regenerado; `FormaPagamentoRegistro` sem `LojaId` e com `ExigeSupervisor`;
       `FormaPagamentoLojaRegistro`; migração EF `FormasPagamentoLojas`, que volta a 0 o cursor de `configuracao` e a
       versão local das formas (SYNC 17.4.2): o PDV anterior, ao puxar da API já com a 0014, descarta a tabela e a
       coluna novas (desconhecidas) e avança o cursor além dos vínculos; sem isso, depois da atualização, o caixa ficaria
       sem forma nenhuma e com `exige_supervisor` falso. **Implantação: API primeiro** (com a migração EF, essa ordem se
       resolve no primeiro pull do app novo). Na ordem contrária, o PDV novo contra uma API sem a 0014 não recebe
       vínculo e não oferece forma até a 0014 rodar (aí os vínculos nascem com versão acima do cursor e descem; o C9
       confere o que a API anuncia).
     Testes: `test/integracao/formas-pagamento-lojas.test.ts` (o seed com os vínculos de "todas" e VA/VR inativas na
     carga inicial das duas lojas; o critério de pronto — "Fiado Balcão" só na Loja Treino desce só para o caixa dela —;
     ganhar a Hermes toca a forma e ela desce, perder tira só da Hermes; "todas" → uma loja exclui o vínculo nulo na
     outra e a volta para "todas"; gravar sem mudar as lojas não versiona; a exclusão da forma descendo; as permissões
     por loja do gerente; a exclusão da loja levando os vínculos e a forma que só valia nela; a descrição única, a loja
     inexistente, o troco recusado no PIX e no POS, o CHECK e a auditoria); `migracao-formas-lojas.test.ts` (a 0014
     sobre um banco com o esquema da 0013 e formas repetidas: "Ticket (loja 2)" já existente e duas longas iguais
     depois do corte renomeadas sem colidir, e o vínculo da loja excluída); `formas-configuracoes.test.ts` ajustado (9
     ativas, `lojaIds`, descrição única); `packages/shared/src/cadastros.spec.ts` (troco e lojas);
     `apps/erp-web/src/paginas/formas-pagamento/FormasPagamento.test.tsx` (a forma só na Loja Treino com supervisor, o
     troco desligado pela maquininha, a coluna Lojas, a forma de loja alheia só leitura); no PDV, `AplicadorPullTests`
     (o pull aplica o vínculo e a exclusão dele tira a forma do caixa; o PDV anterior que descartou vínculo e coluna
     recebe os dois depois da migração), `MigracaoFormasPagamentoLojasTests` e o `EsquemaNuvemTests`.

137. **Consultas do ERP sobre as vendas e o caixa do PDV, e o dashboard real** (C12; T30–T33; dono, O1/D7, O3/D12 e
     O10/D39; ERP 6, 10.3.1, 14.9, 15.2–15.4; MD 3.2.2, 3.11, 3.12, 6.2; migração `0015_lojas_treino`). Tudo só de
     leitura, em `src/vendas/` (`consultas.ts` com as peças comuns e um controller por consulta); a venda ERP, cancelar
     e devolver pela nuvem são da Fase 3, assim como a conferência do fechamento (Conferida/Divergente,
     `fechamentos_caixa.conferir`, como no roadmap); a quebra/sobra no financeiro é da Fase 4.
     - **Rotas**: `GET /vendas` e `/vendas/:id` (`vendas.ver`); `GET /movimentos-caixa/reforcos` (abertura e reforço),
       `/movimentos-caixa/sangrias` (sangria e `sangria_fechamento`) e `/movimentos-caixa/:id` (`movimentos_caixa.ver`);
       `GET /sessoes-caixa` e `/sessoes-caixa/:id` (`fechamentos_caixa.ver`, a permissão da ERP 14.9 — não a de
       movimentos, crítica da 1C, item 16). Filtros e respostas em `packages/shared/src/vendas.ts` (zod para a query,
       interfaces para a resposta); paginação, ordenação (`ordemDaQuery`, 422 fora da lista) e os totalizadores de
       **todas** as linhas do filtro, não só da página.
     - **Loja visível**: só as lojas do usuário (`sessao.lojas`); a loja escolhida fora delas é 403 na listagem e o
       registro dela é 404 no detalhe (não conta que existe).
     - **T30 – loja de treino (O10/D39)**: coluna `lojas.treino` (padrão falso), no cadastro da loja (zod, detalhe e
       `/auth/eu`, para os seletores marcarem "(treino)" e as telas oferecerem o filtro). É do ERP: fica no `omitir`
       do fluxo `configuracao` (o `Esquema.g.cs` ganha a coluna como `Omitida`; nenhuma mudança no modelo do PDV) e,
       como é editada à mão, versiona a loja normalmente. Filtro `treino` = `excluir` (padrão) / `incluir` /
       `somente` nas três consultas e no dashboard; **a loja escolhida no filtro vale mesmo sendo de treino** (quem
       escolhe a Loja Treino quer vê-la, e a loja de contexto do ERP pode ser ela). O handler da venda não sabe de
       treino: grava como nas outras lojas. No dashboard, as vendas e o "Estoque abaixo do mínimo" seguem o filtro;
       o painel PDVs conta o terminal da loja de treino (ele também precisa de acompanhamento). **A loja de treino é
       não fiscal** (O10): `regrasLoja` (zod, criar e alterar) recusa `treino` com `tipoEmissao` diferente de
       `nao_fiscal`, e o check `ck_lojas_treino_nao_fiscal` (na `0015`) segura a mesma regra no banco. Sem isso, uma
       loja NFC-e marcada como treino por engano continuaria emitindo e o faturamento fiscal dela sumiria dos totais
       do ERP sem aviso (revisão do C12).
     - **T31 – data das consultas = dia operacional (D7)**: Vendas por `vendas.dia_operacional`; Fechamento por
       `sessoes_caixa.dia_operacional`; Reforço e Sangria pelo **dia operacional da sessão** do movimento (e não pela
       data do relógio do `ocorrido_em`): a sangria da 1h da manhã fica no dia de quem abriu o caixa, o mesmo do 14.9.
       As datas dos filtros são datas de calendário de verdade (`z.iso.date()`: `2026-02-31` é 422 no zod, e não 500
       no `::date` do PostgreSQL). A Sangria lista também a `sangria_fechamento` (a retirada do fechamento sai da
       gaveta; a ERP 14.9 a soma no cálculo do dinheiro), com o tipo próprio. O totalizador de reforço/sangria soma só
       os não cancelados; o de vendas conta as canceladas à parte e tira os valores delas (total bruto, descontos =
       `desconto_itens + desconto_total`, total líquido), a mesma regra do dashboard.
     - **T32 – cálculo do dinheiro refeito na nuvem** (14.9): o detalhe da sessão traz, além do calculado × informado ×
       diferença por forma que o PDV mandou (`fechamentos_caixa_formas`; com a O3, só o gerente vê), a fórmula da PDV
       20.4 refeita com o que já chegou (a do `ApuracaoCaixa` do PDV, conferida pelo vetor compartilhado
       `packages/shared/testes/sync/caixa.apuracao.vetores.json`: o PDV o roda no `ApuracaoVetoresTests` e a API o
       aplica pelo push no teste de integração, com troco em outra forma, troco do dinheiro, estorno em dinheiro e
       no cartão, `devolucao_troca` e sangria cancelada): fundo + pagamentos em dinheiro aprovados ou
       estornados de vendas **finalizadas na sessão** (a cancelada depois continua somando; o estorno subtrai pelo
       movimento, na sessão em que o dinheiro saiu) − troco de outras formas + reforços − sangrias − `estorno_venda` em
       dinheiro − `devolucao_troca`, todos não cancelados = esperado na gaveta antes da `sangria_fechamento`. Igual ao
       calculado do Dinheiro do PDV quando tudo chegou; diferente = evento da sessão pendente ou retido (a tela avisa e
       aponta a fila de decisão). Sessão aberta: o esperado até agora. A situação `fechada_forcado` marca a sessão
       fechada à força na substituição/revogação **cujo `caixa.fechado` ainda não chegou**: sai de
       `fechamento_forcado` **e** da falta de `fechamentos_caixa`. O handler grava o fechamento tardio do terminal
       antigo mantendo `fechamento_forcado` (auditoria, MD 3.12.1); com ele gravado a sessão volta a `fechada`, e o
       detalhe guarda a marca em `fechamentoForcadoMotivo` (a tela troca o alerta laranja por uma nota).
     - **T33 – dashboard e "hoje"**: vendas `finalizada` do mês pelo `dia_operacional` (a cancelada abate; devolução na
       Fase 3), por loja (dia e mês) e por dia com o mesmo dia do mês anterior (`vendasPorDia`, para o gráfico da Fase
       5); ticket médio = total ÷ quantidade, em decimal (`dec`). O "hoje" de cada loja é calculado no banco
       (`diaOperacionalAtual`): hora local no `fuso_horario` da loja menos a hora de corte efetiva (configuração da
       loja ?? da empresa ?? padrão do catálogo, 05:00), a conta do `DiaOperacional.Calcular` do PDV, num `lateral` por
       loja. Cache de 60 s com o filtro de treino na chave. Já o padrão "hoje" dos **filtros de data** das telas usa o
       corte padrão da empresa (05:00) no navegador: só escolhe a data que aparece no campo; a consulta compara com o
       `dia_operacional` que o caixa gravou. **O mês padrão** (sem `mes`) é o do dia operacional da **empresa**
       (`mesOperacionalEm`, do shared: fuso de Brasília e o corte da empresa), não o do calendário: em 01/11 às 02:00,
       com o corte das 05:00, o "hoje" das lojas ainda é 31/10 e o mês continua outubro (antes o card zerava com a
       coluna do dia em 31/10). O ERP não manda o mês até o usuário escolher um e mostra o que a API devolveu; a loja
       com corte próprio pode ficar uma ou duas horas fora desse mês na virada. **Lojas inativas**: as vendas contam
       a loja desativada no mês em que ela vendeu (a listagem de Vendas, para onde o card leva, não olha
       `lojas.ativa`, e os totais precisam bater); na tabela por loja a inativa só aparece com venda no mês ou no dia;
       o estoque abaixo do mínimo e os PDVs continuam só com as ativas.
     - **Detalhe da venda**: cabeçalho, itens (com combo, casco e item cancelado), pagamentos (situação, `estornado`
       no cancelamento, bandeira/NSU) e o **lucro só com `vendas.ver_lucro`** (`custo_total` gravado na aplicação,
       lucro e margem em decimal; sem a permissão, `custoUnitario` dos itens também vem nulo). Somas em
       `numeric(15,2)` no SQL (o zero sai `0.00`).
     Testes: `test/integracao/consultas-vendas-caixa.test.ts` (as fixtures do C4 — `caixa.aberto`, `caixa.reforco`,
     `caixa.sangria`, `caixa.movimento_cancelado`, `venda.cancelada` forma A e `caixa.fechado` — aplicadas pelo push
     real com os ids do ambiente, mais três vendas e uma loja de treino: filtros, ordenação, totais, detalhe com e sem
     lucro, permissões e lojas, reforço/sangria com a cancelada fora do total, o fechamento com a diferença, a sessão
     aberta, o dashboard do mês, do dia — também com o corte da loja em 00:00, sem depender da hora em que a suíte roda
     (`noMesmoDia` repete a consulta se o corte passar no meio dela) — e do mês anterior, e a loja de treino em cada
     consulta; depois, a sessão fechada pela nuvem com o `caixa.fechado` tardio, o turno do vetor da apuração e o
     dashboard com a loja inativa, o estoque abaixo do mínimo e os PDVs da loja de treino; a loja de treino fiscal
     recusada na API e no banco); `importacao-dashboard.test.ts` ajustado (mês padrão operacional);
     `packages/shared/src/vendas.spec.ts` (filtros, data impossível, `diaOperacionalEm` e a coerência do vetor),
     `cadastros.spec.ts` (loja de treino só não fiscal) e `estoque.spec.ts` (filtros).

138. **Trava de ordenação sob carga: espera limitada no ERP, carga de 4 terminais e o e2e do caixa** (C13; crítica da
     1C, itens 6 e 24; MD 1.5; SYNC 8.1, 8.3, 19.3; PDV 30.7). A 7300001 serializa toda gravação sincronizável da
     empresa: cada evento do push a segura do `fn_trava_versao()` ao `commit` (`aplicacao.ts`), e o ERP também.
     - **Espera limitada no ERP** (`Tenancy.transacao`): com `travaVersao`, a transação faz
       `set local lock_timeout = <ERP_ESPERA_TRAVA_MS>` (padrão 5 000 ms; 0 = sem limite), pega a trava e volta o
       `lock_timeout` ao padrão da sessão — só a espera pela trava tem limite, nunca as travas de linha depois dela. O
       `55P03` (`lock_not_available`, `TRAVA_OCUPADA`) não é repetido como o deadlock: o `FiltroErros` responde
       **503 `SISTEMA_OCUPADO`** (código novo no shared, `Retry-After: 5`) com "O sistema está ocupado recebendo as
       vendas dos caixas. Nada foi gravado: tente salvar de novo em alguns segundos." — a transação inteira voltou. As
       tarefas em segundo plano (importação, manutenção dos terminais) passam `esperaSemLimite`: sem ninguém olhando a
       tela, esperar é melhor que falhar no meio. O push do PDV não usa `transacao({ travaVersao })` (pega a trava
       depois da `push:<terminal>`, SYNC 8.1) e continua esperando sem limite; as outras rotas do PDV que pegam a trava
       — `/sync/ativar` e o `/sync/heartbeat` que confirma a desativação (D22) — também passam `esperaSemLimite`: um
       caixa nunca recebe erro por causa do ERP. Como defesa, o `converterSync` do `FiltroErros` responde o `55P03`
       com **503 `MANUTENCAO`** e `Retry-After: 5` (SYNC 2.5), sem o log de "erro não tratado no sync", se uma rota
       do `/sync` vier a ter limite.
     - **Carga** (`test/integracao/carga-terminais.test.ts`): 4 terminais ativados pelo `/sync/ativar` real com o
       turno offline no outbox (abertura, `CARGA_VENDAS_POR_TERMINAL` vendas de 10 itens espalhadas pelas últimas 4 h,
       sangria e fechamento cego) reconectam ao mesmo tempo, cada um mandando os seus lotes de 50 em ordem como o
       `EnvioPush`, enquanto o gerente salva um produto vendido (`PUT /api/produtos/:id` com a versão lida) e efetiva
       acertos de Entrada, alternando. Confere: tudo `aplicado`; uma venda por evento, os itens, os eventos recebidos
       uma vez, as sessões fechadas e as sangrias; o razão (saldo final = inicial − vendas + entradas do ERP, produto a
       produto); o ERP sem nenhuma recusa (nem 409: a venda só muda `custo_medio`, isento de versão, T10; nem 503); o
       reenvio do primeiro lote de cada terminal com o mesmo `lote_id` todo `duplicado`, sem mudar vendas nem saldos;
       o p95 da trava presa por evento abaixo do teto (`medidorTrava` do `PushSync`, o mesmo do log; meta de 50 ms da
       SYNC 8.3; no CI, `TETO_TRAVA_CARGA_MS` de 250 ms, no job do PostgreSQL 18) e o ERP sempre abaixo da espera máxima. No CI roda com 50 vendas por
       terminal; o workflow manual `.github/workflows/aceite-pdv.yml` roda com 200 e anexa o `carga.json`
       (`RELATORIO_CARGA`). Rodada local com 200 × 4 (812 eventos, PostgreSQL 16 local): trava p50 20,8 ms, p95
       28,1 ms, máximo 91,8 ms; ~40 eventos/s com os quatro juntos (a trava serializa, como esperado); lote de 50 em
       ~5 s com os quatro disputando; `PUT` de produto p95 125 ms e acerto p95 168 ms durante a carga; zero recusas. O
       mesmo arquivo prende a 7300001 numa conexão e confere o `SISTEMA_OCUPADO` depois da espera (nada gravado), o
       push do mesmo instante esperando e aplicando quando a trava sai e, do mesmo jeito, o `/sync/ativar` e a
       confirmação da desativação no heartbeat esperando além do limite do ERP e concluindo sem erro.
     - **E2E do caixa e PDV 30.7** (`test/e2e-pdv/servidor.ts`, README do PDV › decisão 57): o servidor do e2e passa a
       montar o piloto da O10 (D39) — a loja é a "Treino" (`lojas.treino`, não fiscal), com três caixas, o gerente
       com PIN (perfil `gerente`, libera o cancelamento da venda paga, O6) e o catálogo do caixa pelas rotas do ERP:
       lata com o DUN do fardo de 12, retornável com o casco, o combo de whisky com a troca do energético, e o saldo
       por um acerto de Entrada. O `estado.exemplo.json` ganhou `gerente`, `estoqueId` e `catalogo` (o servidor
       confere o formato contra ele; o `EstadoE2ETests` do PDV lê o mesmo arquivo).
     - Fora deste bloco: o painel de alertas e o `eventos-status` (C14), lacunas (C15), relógio (C16) e recuperação
       (C17); a trava por loja ou por fluxo (evolução prevista na MD 1.5, sem necessidade com os números acima).

### Implantação do piloto (I1) – VPS da Hostinger, Cloud SQL PostgreSQL 18

> As decisões da implantação na VPS (I1, I1b) usam a série **200**, para não disputar a numeração com os blocos
> da Fase 1C e da Fase 2, que foram feitos em paralelo.


200. **Produção no Cloud SQL PostgreSQL 18 com o usuário `genesis` sem SUPERUSER** (I1; `infra/producao/README.md`):
     - **Role de runtime no PostgreSQL 16+ sem superusuário**: `garantirRoleAplicacao` roda depois de toda migração e,
       com a role já existente, fazia `alter role ... nosuperuser ... noreplication nobypassrls`. No PostgreSQL 16+
       um `alter role` que **cite** SUPERUSER, REPLICATION ou BYPASSRLS — mesmo com o valor atual — exige que quem
       executa os tenha; no Cloud SQL o `genesis` é `cloudsqlsuperuser` (CREATEDB e CREATEROLE, sem SUPERUSER), então
       a segunda migração de toda empresa falhava com `permission denied to alter role` (achado no teste local da
       stack, onde o `genesis` tem os mesmos privilégios). Agora a criação usa todos os atributos e a atualização só
       `login nocreatedb nocreaterole noinherit` + senha, e confere que a role não ganhou SUPERUSER/REPLICATION/
       BYPASSRLS por fora (só um superusuário liga; se ligou, erro). Teste em `roles.test.ts` com uma dona do banco só
       com CREATEDB e CREATEROLE (falhava antes da correção, no 16 e no 18).
     - **PostgreSQL 17+**: `pg_database.daticulocale` virou `datlocale`; só o teste do provisionamento lia a coluna (o
       `create database ... locale_provider icu icu_locale 'pt-BR'` vale nas duas versões). A consulta lê pelo JSON da
       linha para valer no 16 e no 18. Fora isso a suíte inteira passou no 18 sem mudança; o CI roda a integração
       também contra `postgres:18` (job `integracao-pg18`, em paralelo). Desde 05/11/2026 (economia de minutos;
       escolha técnica decidida pelo dono em 05/11/2026, roadmap D59) a integração roda **só** no 18; o job
       TypeScript ficou com os unitários (CONTRIBUTING.md › CI).
     - **Imagem**: `pnpm deploy --prod` (com `inject-workspace-packages` só no build, para usar o lockfile) e a pasta
       final montada à mão: `node_modules`, `dist/` sem mapas, `drizzle/` (SQL das migrações, lido por
       `journal.ts`) e `src/database/referencias/` só com os dados (o `carregar.ts` lê de lá também a partir de
       `dist/`). Usuário `node`, healthcheck com `fetch` no `/saude` (a imagem slim não tem curl).

### Implantação do piloto (I1b) – backup lógico e painel do monitoramento

201. **`GET /api/saude/detalhada` com token de monitoramento** (I1b; formato em `infra/producao/README.md` ›
     Monitoramento; código em `src/saude/`):
     - **Token próprio, só desta rota**: `@Publico()` (o guard global não tenta ler o token como JWT do ERP) e a
       conferência no próprio controller (`autorizarMonitor`). O ambiente guarda só o SHA-256 (`MONITOR_TOKEN_SHA256`,
       64 hexadecimais; o `implantar.sh token-monitor` gera 32 bytes aleatórios e grava o hash): a comparação é
       `timingSafeEqual` entre hashes de 32 bytes (tempo constante, sem vazar o tamanho). Sem hash configurado, 401 para
       qualquer token. O JWT do ERP nesta rota é 401, e o token de monitoramento em qualquer outra rota também (o guard
       tenta lê-lo como JWT e recusa).
     - **Limite por IP antes da conferência** (`garantirLimitePorMinuto`, `MONITOR_LIMITE_POR_MINUTO`, 30): as
       tentativas com token errado gastam a cota (429 `LIMITE_TAXA` com `Retry-After: 60`). O IP é o do `TRUST_PROXY`.
     - **Autorizado, sempre 200** (`Cache-Control: no-store`): o `status` do corpo (`ok`/`degradado`) diz se o banco, a
       consulta dos terminais ou a das tarefas falhou; um monitor que só olha o código HTTP usa o `/saude` (503 sem
       banco). Uma parte que falha não derruba as outras (empresa sem resposta conta em `empresas_sem_resposta`).
     - **Sem dado pessoal**: terminais só com código da empresa, código e nome da loja, número do caixa, status e a
       última sincronização (nada de descrição livre do caixa, nome da máquina, IP, operador); contagens em vez de
       eventos; do backup só data, tamanho e status (a mensagem de erro do backup, que cita bancos, fica no bucket).
       Teste de integração com a lista exata das chaves permitidas.
     - **Terminais**: `ativo`/`provisionando`/`desativando` e os revogados nos últimos 7 dias (`desativado`; depois
       saem da lista). Online = contato em menos de 2 min (`statusConexao`, ERP 12.1).
     - **Tarefas atrasadas**: `pgboss.job` em `created`/`retry` com `start_after` há mais de 5 min (a fila parada ou o
       trabalhador fora do ar); 0 se o schema do pg-boss ainda não existe.
     - **Último backup**: lido do `backups/estado.json` que o `genesis-backup` grava no bucket (cache de 60 s). Um
       objeto no bucket, e não uma tabela no controle: o backup que falhou porque o banco caiu ainda consegue registrar
       a falha. `ausente` = nunca houve backup; `indisponivel` = o bucket não respondeu.
     - **Memória**: do cgroup do container (v2 `memory.current` − `inactive_file` e `memory.max`; v1 equivalentes),
       como o `docker stats`; fora de container, o RSS do processo e `limite_bytes: null`. Desde a decisão 166, também
       `processo`: o tempo no ar e a memória do próprio Node (heap usado, reservado e o teto do V8; RSS), em MiB.
     - O `backups_empresas` (painel da plataforma, ERP 19.3) continua vazio: o backup do I1b é da instância inteira,
       não um registro por empresa com retenção contratual (fica para o painel de backups).

139. **Rede de segurança dos `rejeitado`, painel mínimo de alertas e a expiração da relevância** (C14; T6, T34, T35;
     dono, O11 — padrão aplicado, roadmap D40; SYNC 1.4, 3.8, 7.2, 18.2, 21.1; MD 3.5.4; ERP 6, 14.9).
     - **`GET /sync/eventos-status?ids=`** (`HeartbeatSync.eventosStatus`): até 200 ids separados por vírgula (ou o
       parâmetro repetido; sem repetição, `MAXIMO_IDS_EVENTOS_STATUS`), 400 `REQUISICAO_INVALIDA` fora disso. Resposta
       `{ agora_servidor, eventos }` com o formato dos itens de `eventos_resolvidos` (o mesmo mapeamento,
       `itemResolvido`) mais `erro` e `retido`, estes com `erro: { codigo, mensagem }` gravado (schema novo
       `respostaEventosStatusSchema` em `shared`, fixture `eventos-status.resposta.json`, que o PDV também lê). Só os
       eventos **deste** terminal (filtro pelo `terminal_id` do token), na ordem da sequência: id de outro terminal e id
       desconhecido ficam fora da resposta, sem distinguir os dois (T34). Só leitura: não grava
       `resolucao_entregue_em` — a entrega continua confirmada pelo ack do heartbeat, que repete o resolvido até lá
       (T34). Estados do terminal (T6): os mesmos do `recuperar` na tabela 3.8 — 200 em `ativo` e `desativando` (o
       PDV em desativação precisa saber o que o ERP decidiu para esvaziar a quarentena), 503 em `provisionando`, 401
       em `revogado`; com o hardware divergente responde normalmente, como o heartbeat (a situação de um evento não é
       segredo); empresa suspensa é 403, como as outras rotas que não são o push.
     - **Painel mínimo de alertas críticos no Dashboard** (O11, `alertasCriticos`): os alertas `critico` abertos das
       lojas filtradas e os sem loja (força bruta na ativação), com o total, a contagem por tipo e os 10 mais recentes
       (título, mensagem, loja e o terminal de `terminalDoAlerta`: `registro_id` quando a entidade é `terminais`,
       senão `dados.terminal_id` e, na falta dele, o da linha de `eventos_recebidos`, para o link ao detalhe, onde se
       decide). Só os tipos que têm essa tela (`TIPOS_ALERTA_PAINEL`): `EVENTO_DESCARTADO`, `EVENTO_COM_ERRO` de
       `venda.*`/`caixa.*`/`nfce.*`, `EVENTO_DIVERGENTE`, `TERMINAL_DESATIVADO_COM_EVENTOS`,
       `TOKEN_ANTERIOR_REUTILIZADO` e `ATIVACAO_FORCA_BRUTA` (sem terminal: leva à listagem, onde fica o "Liberar
       ativações"); um crítico de outro tipo só entra quando ganhar onde decidir. Todos são do PDV e dos terminais,
       então o painel exige `terminais.ver` (`null` sem ela). O **`EVENTO_DIVERGENTE`** (SYNC 8.4 camada 3) passou a
       levar o terminal que mandou em `dados.terminal_id` e entrou nos alertas do detalhe e da listagem do terminal,
       um a um, com o **"Ciente"** (`terminais.gerenciar`, com auditoria) como o `EVENTO_DESCARTADO`: nada o fecha
       sozinho, e antes ele contava no painel para sempre, sem link, sem nome e sem onde resolver. Os avisos ficam
       de fora; todos os tipos e severidades e o "Ciente" no próprio painel são da Fase 5.
       Junto, **sessões de caixa abertas há mais de `pdv.horas_alerta_sessao`** (loja ?? empresa ?? 24 h; o
       "Alerta no Dashboard" da ERP 14.9, que o C12 deixou para cá; `sessoesAntigas`, com `fechamentos_caixa.ver`):
       calculado na consulta, sem linha em `alertas` (a sessão fechada some sozinha), da mais antiga para a mais nova,
       com o total e as 10 primeiras. Os dois seguem a loja do filtro com a de treino junto, como o painel PDVs.
     - **Expiração diária da relevância** (`pessoas/expiracao-relevancia.ts`, fila `genesis-expiracao-relevancia`,
       `schedule` do pg-boss às 07:17 UTC = 04:17 em Brasília, fora do movimento): em cada empresa ativa ou suspensa,
       `expirarRelevancias` exclui logicamente as linhas `compra`/`delivery` com `ultima_ocorrencia_em` anterior a
       `pdv.pessoas_meses_relevancia` meses (loja da linha ?? empresa ?? 12) e as `crediario` cuja pessoa ficou sem
       limite próprio e sem saldo em aberto (a rede de segurança do recálculo na transação do fato). Em lotes de 500
       (T35): uma transação com a trava de versão por lote (`esperaSemLimite`, como as outras tarefas), `for update
       skip locked` para não esperar a linha que uma venda está tocando, até sobrar menos que um lote; uma execução
       por vez (trava consultiva no controle); empresa com erro não impede as outras, mas vai para o log (o id da
       empresa e a mensagem) e faz o job falhar no fim, para o pg-boss tentar de novo (`trabalhoPorEmpresas` em
       `infra/fila.ts`, também na manutenção dos terminais; antes o job concluía com sucesso e a purga LGPD daquela
       empresa parava em silêncio). A exclusão ganha versão e desce como tombstone no fluxo `pessoas`; o PDV purga a
       pessoa (`AplicadorPull`). Sem toque e sem auditoria (projeção). **Data no futuro**: `ultima_ocorrencia_em` vem do
       relógio do caixa (`finalizada_em`), então `relevanciaCompra` grava `least(finalizada_em, now())`, e a linha que
       já está no futuro volta na venda seguinte; a tarefa, antes dos lotes, faz a `compra`/`delivery` no futuro valer
       hoje (`corrigirRelevanciasFuturas`). Sem isso, o caixa com a BIOS em 2028 (SYNC 12.3) segurava o cliente no
       espelho até 2029, além do prazo da LGPD. O alerta do relógio (C16) não corrige a linha; o teto vale só para o
       prazo, e as datas do movimento seguem a do caixa (SYNC 12.4).
     Testes: `test/integracao/fila-decisao.test.ts` (`eventos-status`: erro e retido com o código, o aplicado e o
     descartado depois do reprocessamento e do descarte, só o próprio terminal, sem ack e igual ao heartbeat; ids
     inválidos, acima de 200, desativando 200, revogado 401, hardware divergente 200; Dashboard: o erro crítico com o
     terminal, o aviso do mesmo tipo e o crítico de tipo sem tela fora, a sessão de 30 h, o prazo da loja de 48 h,
     outra loja no filtro, o gerente só de outra loja, o reprocessamento que tira o alerta, o usuário sem as
     permissões; o `EVENTO_DIVERGENTE` no painel com o link, no detalhe do terminal, o terminal achado pela linha
     recebida e o "Ciente", que outro terminal não acha), `test/integracao/relevancia-expiracao.test.ts` (prazo da loja
     e da empresa, `delivery`, `crediario` com e sem limite, com saldo em aberto, com saldo zero e com o saldo
     excluído, os outros motivos e a já excluída intactos, lote de 2 contado em transações, a versão nova, repetir
     sem efeito, a data no futuro, a empresa que falha em `falhas`, a trava consultiva), `venda-eventos.test.ts` (a
     linha `compra` no futuro volta e a data nova não passa do agora), `src/infra/fila.spec.ts` (o log e o erro do
     `trabalhoPorEmpresas`), `servicos-fundo.test.ts` (o agendamento diário) e `contratos.spec.ts` (query e
     fixture).
     - Fora deste bloco: lacunas (C15, decisão 140), relógio na nuvem (C16), recuperação e backup (C17), com o
       critério do PDV 30.7 do rejeitado em quarentena que o ERP reprocessa contra a API de verdade no e2e do C17
       (README do PDV › decisão 58); o painel completo de alertas (Fase 5).
140. **Lacunas de sequência: declarar, recuperar e reprocessar em ordem** (C15; T7, T9, T36–T39; SYNC 7.4, 8.1,
     8.6, 11.3; MD 3.15.2; ERP 12.4; `sync/lacunas.ts`).
     - **Contrato** (`shared`): `pushSchema` ganha `declarar_lacuna {de, ate, motivo, observacao?, autorizado_por_id}`
       (`MOTIVOS_LACUNA`: `banco_local_perdido`, `restauracao_backup`, `outro`) e `recuperar_lacuna {de, ate,
       autorizado_por_id}`, com faixa de no máximo `MAXIMO_SEQUENCIAS_LACUNA` (5.000) sequências; o lote pode ir sem
       eventos só com a declaração, e as duas não vão juntas. Status novo `lacuna_recuperavel`, com
       `resultado.lacuna = {de, ate}` (a faixa declarada) e `erro.codigo = 'LACUNA_RECUPERAVEL'`. Fixtures
       `push.lacuna.requisicao.json` (a declaração de 1048–1049), `push.recuperar_lacuna.requisicao.json` (os dois
       eventos achados depois, com a liberação) e `push.lacuna.resposta.json` (a resposta ao envio deles **sem** a
       liberação, outro `lote_id`: `lacuna_recuperavel` e `nao_processado`), lidas também pelo xUnit do PDV. Códigos novos da SYNC 2.5: 409 `LACUNA_INVALIDA` e 422 `LIBERACAO_INVALIDA`.
     - **Liberação conferida na nuvem** (T37): `autorizado_por_id` tem de ser um usuário ativo da empresa com
       `pdv.config.fiscal` **e acesso à loja do terminal** **agora** (`PermissoesEfetivas`, o mesmo cálculo e cache do
       ERP; `lojas = null` é o Master). Senão o lote inteiro volta 422 `LIBERACAO_INVALIDA`, antes de qualquer
       gravação: declarar é admitir perda de dados, e a liberação do caixa foi conferida offline, com as permissões e
       as lojas da última descida (o hash do PIN só desce para o Master e para quem tem a loja em `usuarios_lojas`):
       quem perdeu a loja depois dela não responde mais pelo caixa, mesmo com a permissão por outra loja. No perfil padrão a permissão é só do Master
       (`SOMENTE_MASTER` em `perfis-padrao.ts`): o gerente que deve poder declarar ganha a permissão no cadastro. O
       "ou suporte" da 8.6 (declarar pelo ERP) não entra na 1C.
     - **Declarar** (T36), numa transação de evento própria (trava `push:<terminal>` na forma `try`, 409
       `PUSH_EM_ANDAMENTO` se ocupada), antes dos eventos do lote: só a faixa que **começa na sequência esperada** —
       começar antes cobriria sequências recebidas, começar depois deixaria outra lacuna antes, e o `esperado =
       max + 1` a pularia em silêncio. A **mesma** declaração repetida (a faixa inteira já é placeholder dessa faixa:
       reenvio sem resposta) responde 200 sem gravar; qualquer outra coisa é 409 `LACUNA_INVALIDA` com a
       `proxima_sequencia_esperada` em `detalhes`. Grava um **placeholder** por sequência (T7): `tipo =
       'terminal.lacuna'`, `status = 'descartado'`, `evento_id` v7 próprio, agregado = o terminal, `payload` = a
       declaração (`lacuna`, `motivo`, `observacao`, `autorizado_por_id`) com o hash do JCS, `descartado_por_id` = quem
       liberou, a justificativa com o motivo e o nome, **`resolucao_entregue_em` preenchido** (o heartbeat não o
       entrega ao PDV como "descartado") e **sem `entidades_evento`** (nada depende dele, e a troca do `evento_id` na
       substituição não esbarra na `fk_entidades_evento_evento_id`). Inserção em blocos de 500. Alerta crítico
       **`LACUNA_DECLARADA`** no terminal (`entidade = 'terminais'`, chave `lacuna_declarada:<terminal>:<de>-<ate>`)
       com a faixa, o motivo, a observação, quem liberou e os `eventos_pendentes` que o terminal tinha informado (para
       estimar a perda, 22.4); aparece no detalhe e na listagem de terminais e no painel de alertas críticos do
       Dashboard (C14), com o "Ciente" (`terminais.gerenciar`, auditoria `conferir`) quando a perda é conferida.
     - **Recuperar**: a sequência abaixo da esperada com `evento_id` novo é procurada **antes** da regressão; caindo
       num placeholder, com `recuperar_lacuna` cobrindo a sequência, a **mesma linha** passa a ser a do evento real
       (`evento_id`, tipo, agregado, dependências, payload, envelope, hash; nada do descarte; `status = 'recebido'`) e
       ele é aplicado normalmente por `aplicarEvento`; a auditoria **`lacuna_substituida`** (origem PDV, ação nova do
       catálogo, T9) guarda o placeholder em `antes` e quem liberou em `usuario_id`/`autorizado_por_id`, com a data de
       agora (o `ocorrido_em` do evento pode estar num mês sem partição). Erro de regra desfaz e a transação nova que
       grava o `erro` substitui de novo (o evento recuperado com erro entra na fila de decisão como qualquer outro).
       Sem a autorização: `lacuna_recuperavel` e o lote para (os seguintes, `nao_processado`). Fora de placeholder,
       continua `REGRESSAO_DETECTADA`; `evento_id` já gravado em outra sequência continua `EVENTO_DIVERGENTE`.
     - **Fecho do lote** (T38): com alguma substituição, uma transação de evento grava o aviso
       **`LACUNA_RECUPERADA`** (chave `lacuna_recuperada:<lote_id>`: as faixas com os placeholders que restam, a
       quantidade, as sequências e os números das vendas recuperadas), resolve o `LACUNA_DECLARADA` de cada faixa sem
       placeholder restante e cria a tarefa **`reprocessar_apos_lacuna`** (ERP 3.6) em nome de quem liberou, que
       reaplica em ordem de sequência, uma transação de evento por vez (`FilaDecisao.reaplicar`), os eventos do
       terminal acima do início da faixa e de outro lote que a lacuna explica: os `retido` e os `erro`
       `SESSAO_INEXISTENTE`, `REFERENCIA_INEXISTENTE` e `DEPENDENCIA_DESCARTADA` (`CODIGOS_CAUSADOS_POR_LACUNA`, os da
       SYNC 8.6), conferidos de novo sob a trava. Os outros códigos — `PAYLOAD_INVALIDO` do hash divergente (o
       `reaplicar` não reconfere o hash), `NUMERO_VENDA_DUPLICADO`, `AGREGADO_DIVERGENTE`, `ESCOPO_INVALIDO`,
       `ERRO_INTERNO` — ficam para a decisão de alguém na fila do ERP: o supervisor liberou a lacuna, não esses
       eventos. Auditoria `evento_reprocessado` de origem PDV e `modo = 'lacuna'`; o resultado chega ao PDV pelo
       heartbeat. Em tarefa, e não no push, para a resposta do lote não esperar centenas de reaplicações. Falha no
       fecho fica no log: os eventos já foram gravados. A faixa maior que um lote (o PDV manda até 50 eventos por lote
       e a liberação vale para todos) gera um `LACUNA_RECUPERADA` e uma tarefa por lote: a de um lote do meio pode
       achar o erro ainda sem a causa (o evento dela vem no lote seguinte) e deixá-lo como está, e a do lote seguinte o
       reaplica; o `com_erro` do alerta conta os recuperados que caíram em erro de regra (seguem na fila de decisão).
     Testes: `test/integracao/lacunas.test.ts` (liberação sem `pdv.config.fiscal` recusada sem gravar; com a permissão
     mas sem a loja do caixa, recusada na declaração e na recuperação, e aceita com a loja de volta; faixa depois
     e antes da esperada; placeholders `descartado`, entregues e sem entidades; o alerta no detalhe e no Dashboard; a
     repetição sem efeito; a fila andando; o "Ciente"; lote vazio sem declaração; a venda com `SESSAO_INEXISTENTE` por
     causa da abertura perdida, a abertura achada sem a liberação (`lacuna_recuperavel`, não regressão) e com ela —
     a mesma linha, a auditoria, os dois alertas, a venda reprocessada em ordem pela tarefa, o `EVENTO_COM_ERRO`
     fechado, o heartbeat e o reenvio `duplicado`; a recuperação parcial — o `LACUNA_DECLARADA` aberto e "Ainda
     faltam 1" —, as duas vendas com `SESSAO_INEXISTENTE` reprocessadas em ordem e a de hash divergente
     (`PAYLOAD_INVALIDO`) intocada, e o recuperado que cai em erro de regra, com a linha em `erro` pelo `evento_id`
     real, a auditoria `lacuna_substituida`, o `com_erro` e nenhuma tarefa nova; a sequência abaixo fora de
     placeholder continua regressão) e
     `contratos.spec.ts` (fixtures, faixa e motivo inválidos, lote vazio, as duas juntas).
     - Fora deste bloco: a re-hidratação pelo `GET /sync/recuperar` antes de declarar (C17), com os placeholders
       devolvidos como `terminal.lacuna` (T7); a importação 22.3 como autorização da recuperação e a aba "Perdas
       prováveis" (1D).
141. **Relógio na nuvem: `RELOGIO_SUSPEITO` por evento e `RELOGIO_DESVIO` pelo heartbeat** (C16; T9, T40; SYNC 12.3,
     12.4, 21.2, 21.3; MD 3.1.8, 4.4.4; ERP 6, 12.2, 12.4, 17.1; `sync/relogio.ts`).
     - **Por evento** (`alertarRelogioDoEvento`), na transação que dá linha ao evento em `eventos_recebidos` — a nova do
       push, a do `erro` gravada à parte (`gravarFalha`) e a do placeholder de lacuna substituído (C15) —, então uma
       avaliação por evento recebido: o reenvio (`duplicado`) e o reprocessamento pelo ERP não avaliam de novo, o evento
       que cai em `erro` é avaliado (uma vez: a falha transitória desfaz tudo e a próxima tentativa avalia). O evento é
       aplicado do mesmo jeito, com a hora do caixa (a ordem é a de `sequencia_terminal`). Comparações (pura,
       `suspeitasDoRelogio`): `ocorrido_em` com a hora de chegada do lote (o `recebido_em` da resposta do push), com
       `terminais.ativado_em` e com o evento anterior do terminal (o de maior sequência abaixo, sem os placeholders
       `terminal.lacuna`, numa consulta pelo `uq_eventos_recebidos_terminal_sequencia`).
       - **futuro** (> 5 min), **passado** (antes da ativação − 1 dia, ou > 400 dias) e **regressão sem a marca**
         (> 1 s, defeito do PDV): aviso, um aberto por terminal e motivo (`relogio_suspeito:<terminal>:<motivo>`); com
         ele aberto, o `ON CONFLICT` na chave parcial só soma `dados.ocorrencias` e guarda o último evento
         (`ultimo_evento_id`, `ultima_sequencia`, `ultimo_ocorrido_em`, `ultima_diferenca_ms`). Futuro e passado se
         excluem; a regressão é avaliada à parte (um evento ainda adiantado pode ser anterior a outro mais adiantado).
       - **regressão marcada** (`relogio_regrediu = true` e a hora menor que a do anterior; o PDV marca só o evento que
         deixou de seguir o anterior adiantado, SYNC 12.3): `info`, um por regressão (`relogio_regrediu:<evento_id>`). A
         marca sem regressão de fato não alerta. Sem deduplicação por terminal, é o alerta que mais cresce até o
         "Ciente" (um caixa com o relógio instável marca uma por correção): na tela vem **somado por terminal** ("Caixa
         NN: relógio do computador voltou N vezes", com o id e a mensagem da mais recente), num grupo próprio da
         `alertasAbertos`, como o `EVENTO_COM_ERRO`; o "Ciente" dessa linha fecha a mais recente e as anteriores do
         terminal (as que a tela mostrava; a que chegou depois fica aberta), numa auditoria `conferir` só, com os ids em
         `depois.alertas_ids`.
       - No terminal (`entidade = 'terminais'`, `registro_id` = o terminal, `dados.terminal_id`), com o primeiro evento,
         a diferença, o `relogio_confiavel` e o `desvio_relogio_ms` do envelope e o evento anterior em `dados`; aparece
         na listagem e no detalhe do terminal com o **"Ciente"** (`terminais.gerenciar`, auditoria `conferir`; entrou em
         `RESOLVIDOS_NA_TELA`); o próximo suspeito abre outro. É aviso: fora do painel de críticos do Dashboard.
       - `alertasAbertos` aplica o filtro de lojas da sessão (os sem loja, como o `ATIVACAO_FORCA_BRUTA`, sempre) e, no
         detalhe, o do terminal **no SQL, antes do limite de 50** de cada grupo: antes eles vinham depois, em memória, e
         50 alertas mais novos de outras lojas ou de outros terminais tiravam da tela um crítico mais antigo (um
         `TOKEN_ANTERIOR_REUTILIZADO`, um `LACUNA_DECLARADA`) junto com o botão que o resolve, enquanto o painel do
         Dashboard continuava levando ao detalhe.
     - **Pelo heartbeat** (`alertarDesvioRelogio`, na transação da telemetria, só com o hardware que confere): **T40** —
       tipo próprio `RELOGIO_DESVIO` (`relogio_desvio:<terminal>`), e não o `RELOGIO_SUSPEITO`: um mede o computador
       agora e fecha sozinho; o outro registra fatos já gravados com a hora errada, que alguém confere. Severidade pela
       faixa do último heartbeat (`nivelDesvioRelogio` em `shared`: aviso > 2 min, crítico > 5 min, os limites da SYNC
       12.3 e da ERP 12.4, `DESVIO_RELOGIO_AVISO_MS`/`DESVIO_RELOGIO_CRITICO_MS`), título e mensagem com o sentido
       (desvio = servidor − local: positivo é o computador atrasado), `dados.desvio_relogio_ms` e `maior_desvio_ms`. O
       alerta aberto só é regravado quando a severidade muda ou o desvio anda 10 s ou mais (`setWhere`): o heartbeat
       chega a cada 30 s. Até 2 min, o heartbeat fecha o aberto ("O desvio do relógio voltou a até 2 min"); sem amostra
       (`null`), nada muda. A revogação (`aplicarEstadoNaEmpresa`, destino `revogado`) e a desativação confirmada
       (`confirmarDesativacao`, também no atalho do heartbeat que repete a confirmação já gravada na empresa) também o
       fecham, porque sem heartbeat ele nunca voltaria ao normal. Sem "Ciente" (`resolverAlerta` recusa com 422). Por
       isso a telemetria **não abre nem atualiza o alerta de terminal já `revogado` no banco da empresa**: a
       autenticação lê o status no controle antes da transação, e uma revogação (pelo ERP ou pela carência vencida) ou
       a confirmação de um heartbeat anterior cujo passo do controle falhou pode ter feito o commit nesse meio, já com
       o alerta fechado; o `insert ... on conflict` do heartbeat entraria depois (o índice é parcial) e deixaria um
       crítico que nada mais fecha. O status vem do `returning` do `update terminais` da telemetria, que já trava a
       linha (a revogação faz `select ... for update` nela: uma espera a outra). A manutenção (passo 5,
       `resolverDesviosDeRevogados`) ainda fecha o `RELOGIO_DESVIO` aberto de terminal `revogado` que tenha escapado
       (`alertasRelogioResolvidos` no resumo). O crítico entra no painel de alertas críticos do Dashboard
       (`TIPOS_ALERTA_PAINEL`), com o link ao terminal.
     - **Listagem** (`TerminalResumo`): `desvioRelogioMs` (saiu do `TerminalDetalhe`, que o herda) e `relogioConfiavel`
       do último heartbeat, para a coluna "Relógio" da SYNC 21.2 (README do ERP web › decisão 44).
     - **Auditoria `relogio_regrediu`** (T9): ação nova do catálogo `ACOES_AUDITORIA` (sem CHECK de banco desde a 0003),
       gravada pelo PDV no commit do evento marcado e recebida pelo `auditoria.registros` (README do PDV › decisão 60).
     - **Duração legível** (`duracaoLegivel` em `shared`, junto de `nivelDesvioRelogio`): a mesma no título e na
       mensagem dos alertas e na coluna "Relógio" do ERP ("45 s", "3 h 12 min", a partir de 48 h "3 dias"), para o
       alerta e o campo da mesma tela dizerem o mesmo; o PDV usa as mesmas faixas na auditoria `relogio_regrediu`.
     Testes: `src/sync/relogio.spec.ts` (os limites de cada regra, a regressão marcada e a sem regressão, futuro com
     regressão, as chaves), `packages/shared/src/terminais.spec.ts` (as faixas do desvio e a duração legível) e
     `test/integracao/relogio.test.ts` (o futuro aplicado
     com o alerta, o reenvio que não soma, o próximo que soma, no detalhe e na listagem, fora do painel, o "Ciente" e o
     novo depois dele; o passado antes da ativação e o atraso de horas sem alerta; a regressão de 800 ms sem alerta, a
     de 3 min sem marca e as duas marcadas, `info` e uma por regressão, somadas numa linha na tela; três marcadas
     somadas com o id da mais recente, um `TOKEN_ANTERIOR_REUTILIZADO` de ontem que continua na listagem e no detalhe
     com 60 regressões marcadas e 60 avisos mais novos de outro caixa, o "Ciente" que fecha as três numa auditoria e a
     seguinte que abre outra; o placeholder de lacuna fora do "anterior" e os eventos reais que o substituem avaliados,
     o aplicado e o em erro gravado à parte, contra o evento real anterior; o evento em erro na mesma transação e na
     gravada à parte, avaliado uma vez cada; o `relogio_regrediu` do caixa na `auditoria`; o desvio de 90 s sem
     alerta, 3 min aviso com a coluna na listagem, a variação pequena sem regravar, 2 h crítico no mesmo alerta e no
     Dashboard, o "Ciente" recusado, o heartbeat sem amostra, a volta ao normal que fecha e o erro de novo que abre
     outro; a revogação que fecha; a desativação confirmada que fecha, o heartbeat seguinte com o controle ainda em
     `desativando` ou em `ativo` e a empresa já `revogado` que não reabre, e a manutenção que fecha o que escapou).
     - Fora deste bloco: recalcular o `dia_operacional` quando divergir do `ocorrido_em` no fuso da loja (1D, com a D7 e
       a NFC-e; os eventos seguem com o dia e as datas do caixa); o ícone "hora não confirmada" na venda já vem da
       `vendas.relogio_confiavel` (T5, C6b/C12).
142. **`GET /sync/recuperar`: a re-hidratação do banco local restaurado** (C17; T6, T7, T41; SYNC 3.8, 22.1, 22.2;
     `sync/recuperar.ts`, `recuperarQuerySchema` e `respostaRecuperarSchema` no `@genesis/shared`, fixture
     `recuperar.resposta.json`). Os eventos do terminal do token com `sequencia_terminal > desde_sequencia`, em ordem,
     até `limite` (1–200, padrão 50; uma linha a mais diz o `tem_mais`), com a maior sequência que a nuvem tem
     (`ultima_recebida`, placeholders incluídos). Cada item traz o **envelope original** — `envelopeRecuperado` em
     `aplicacao.ts`, a mesma base do `envelopeDaLinha` do reprocessamento (`envelopeGravado`: colunas, por cima o
     `envelope` gravado, T1; a linha anterior à 0010 sai só das colunas, com o contexto do terminal e `usuario_id`
     nulo), só com as chaves do contrato e o `payload` nulo quando anulado — e a situação pela mesma função do
     `eventos-status` e do heartbeat (`situacaoNaNuvem`, `sync/situacao-evento.ts`): `aplicado` com os marcadores,
     `descartado` sempre `{ descartado, justificativa }` (o placeholder também com a faixa, `lacuna`; nunca o
     `resultado` do erro que o evento descartado no ERP guardava), `erro`/`retido` com o código e a mensagem. O placeholder de lacuna volta com `lacuna: true` (T7).
     `recebido` nunca sai (não fica gravado fora da transação do evento). Só leitura. Estados: os do `eventos-status`
     (`ativo` e `desativando` 200, `provisionando` 503, `revogado` 401; T6), mais a **T41**: o `recuperar` entrou no
     `exigirHardware` (409 `HARDWARE_ALTERADO`: os payloads têm CPF na nota e quem retirou a sangria, e a reidratação só
     serve ao push, que já exige o hardware) e no `verificarEmpresa` como o push (a empresa suspensa responde: os dados
     são do cliente, e é o que deixa o push do banco restaurado não perder nem duplicar; com o `/sync/estado` recusado
     pela suspensão, o PDV reidrata sem ele quando o push recebeu a regressão ou há reidratação interrompida). Testes:
     `test/integracao/recuperar.test.ts` (páginas de 2 em ordem, com o aplicado, o erro `REFERENCIA_INEXISTENTE`, o
     placeholder declarado e o aplicado depois dele; o envelope igual ao enviado mais o `terminal_id`; `ultima_recebida`
     e `tem_mais`; só o próprio terminal; o payload anulado nulo e a linha sem envelope remontada das colunas; a query
     inválida 400, o hardware divergente 409, a empresa suspensa 200 com o estado 403, `desativando` 200 e `revogado`
     401; o evento recusado e descartado no ERP com a mesma situação do `eventos-status`) e `contratos.spec.ts` (a query e a
     fixture estrita, com o hash de cada payload). A reidratação no caixa, o salto e o backup são do PDV (README do
     PDV › decisão 61).
     - Fora deste bloco: o alerta `PERDA_PROVAVEL` e a aba "Perdas prováveis" (22.4), a custódia da chave de backup e a
       importação de terminal antigo (22.3), todos da 1D.

### Implantação do piloto – prontidão e ensaio (API)

143. **Prontidão da loja (`GET /api/implantacao/prontidao?lojaId=`) e o ensaio com a carga real** (implantação I5;
     `implantacao/prontidao.ts`, `implantacao.controller.ts`, contrato `prontidaoQuerySchema`/`Prontidao` em
     `@genesis/shared` `implantacao.ts`). Só leitura, com **`configuracoes.ver`** (a permissão de administração do
     catálogo que o gerente e o administrador já têm; uma permissão nova ficaria de fora dos perfis já gravados) e a
     loja entre as permitidas (403), 404 da loja inexistente. A rota usa `lojaId` (camelCase, como `/dashboard` e as
     consultas do ERP), não o `loja_id` do plano. Itens `{ codigo, grupo, titulo, situacao, mensagem, linkErp }` com
     `situacao` `falta` (o caixa não abre, não vende ou não conclui um fluxo do piloto), `aviso` (vende, mas convém
     olhar) ou `ok`; `pronta` = nenhum `falta`. Avalia como o caixa: configurações efetivas (loja ?? empresa ?? padrão),
     usuários com acesso à loja do jeito do fluxo `acesso` (Master ou `usuarios_lojas`, ativos e não demitidos pelo
     `hojeNaEmpresa`, PIN `senha_pdv_hash`) e que passam no login do caixa (não são totem e, fora o Master, têm
     `pdv.acesso.entrar`), permissões efetivas (`calcularPermissoesEfetivas`: perfil ∪ concedidas − negadas), quem
     libera = PIN + `pdv.supervisor` + a permissão e não ser o próprio operador (`AutenticadorOffline.LiberarAsync`;
     nas liberações que o caixa sempre pede — PIX manual com a chave ligada, forma "exige supervisor", desconto pelos
     cascos acima do teto — o único liberador que também é o único operador conta como ninguém, e com outros operadores
     a mensagem avisa que ninguém libera quando ele estiver no caixa), as formas que o `CatalogoLocal` oferece (ativa, "usa
     PDV", vínculo vivo de todas ou da loja), o código de barras que o `ResolverAsync` acha (o repetido entra pelo
     primeiro). Grupos e regras: **empresa** (status `ativa` no controle e `geral.ativa`); **loja** (ativa, ponto de
     venda, "Usa PDV"; o dia operacional com o corte e o fuso, `aviso` com sessão aberta além de
     `pdv.horas_alerta_sessao` (O1b); caixas ativos fora o 0); **usuários** (operador com PIN, entrar/abrir/vender; as
     liberações: cancelar venda paga (O6) e em andamento, o PIX manual (O9b, com PIX ativo; com
     `pdv.pix_manual_exige_supervisor` desligado (D37) a regra continua enquanto houver operador sem
     `pdv.pagamento.confirmar_pix_manual`, como o `ServicoVenda.PermissoesParaLancar`, e fica `ok` quando todos a têm),
     a forma "exige supervisor", o limite de gaveta (só com `pdv.valor_limite_sangria`) e a configuração do terminal
     (`pdv.config.terminal` com `pdv.supervisor`: o Ctrl+Alt+C do login e o "Restaurar backup" chamam o `LiberarAsync`
     sem operador; só o F11 › 8 aceita o próprio operador, e a mensagem diz quem só tem a permissão) são `falta`;
     cancelar sangria/reforço (O5), o desconto pelos cascos (D38, só com teto > 0) e a lacuna (`pdv.config.fiscal`, só
     do Master no seed) são `aviso`; os valores em dinheiro saem em pt-BR, "R$ 800,00"); **formas** (Dinheiro `falta`; PIX com QR exige a chave
     válida e o nome do recebedor na loja (`falta`), sem forma PIX é `aviso`; débito e crédito `aviso`); **catálogo**
     (nenhum produto com preço `falta`; sem preço, sem código, código numérico de tamanho GTIN com dígito errado — a
     importação grava como interno —, código em mais de um produto, combo com componente inativo, NCM ausente (fiscal
     depois) e estoque negativo são `aviso`); **terminais** (nenhum ativo `falta`; abaixo da versão mínima `falta`;
     sem contato em 2 min, relógio não confiável ou com alerta (C16), evento com erro/retido e lacuna declarada (C15)
     `aviso`), pela mesma listagem do ERP 12.2 (`TerminaisErp.listar`), só com **`terminais.ver`**: sem ela o grupo
     vira um item `aviso` (`terminais.sem_permissao`, sem link), como o Dashboard faz com `pdvs`; **operação** (último `backups_empresas`
     concluído nas últimas 26 h `ok`; sem registro = `aviso` "não verificável aqui", porque o genesis-backup da VPS
     grava no bucket e quem confere é o `/api/saude/detalhada`; tarefas `na_fila` da empresa e trabalhos do pg-boss
     parados há mais de 5 min `aviso` — no pg-boss, que é um só no banco de controle, só os da empresa (`data.empresaId`)
     e os recorrentes da plataforma (manutenção dos terminais, expiração da relevância), sem o `genesis-tarefa`, que a
     linha `tarefas` já conta; a fila inteira fica no `/api/saude/detalhada`). Sem dado pessoal: só contagens, situações e os números dos caixas (o teste
     confere nomes e logins fora da resposta). Junto, a **chave PIX da loja** passou a ser editável (`chavePix`,
     `pixNomeRecebedor` até 25, `pixCidadeRecebedor` até 15 no `criarLojaSchema`/`alterarLojaSchema`; a coluna já
     descia ao caixa): a chave é conferida pelo formato do DICT (`tipoChavePix`: CPF/CNPJ com dígito, e-mail, `+55` com
     DDD, aleatória) e gravada como vai para o QR (CPF/CNPJ só dígitos, e-mail minúsculo), e chave sem o nome do
     recebedor é 422 — sem isso a regra do PIX não teria tela que a resolvesse (quem pode trocá-la: decisão 144).
     **Ensaio com a carga real**:
     `test/e2e-pdv/ensaio-piloto.ts` + `ensaio-piloto.sh` (seção Testes), com o banco de controle, o bloco de códigos e a
     limpeza do `servidor.ts` extraídos para `test/e2e-pdv/recursos.ts` (os dois servidores usam a mesma trava). A
     planilha real importou sem erro nenhum (1.664 linhas, 1.664 criadas; avisos de NCM, EAN inválido, EAN duplicado
     e estoque negativo, os mesmos da prévia de 30/10): nada a corrigir no importador. Os números do ensaio ficam no
     PR e no roteiro do piloto (`docs/implantacao/roteiro-piloto.md`). O `ensaio-piloto.ts` exige `E2E_ESTADO` (sai com
     2 sem ela): o estado leva a amostra do catálogo real e não tem padrão no diretório atual; o `.gitignore` cobre
     `ensaio-piloto-estado.json` e `e2e-pdv-estado.json`. O `EnsaioPilotoTests` compara o total local com o total da
     nuvem e os ativos com os ativos (a descida leva os inativos) e soma à baixa esperada de um produto da amostra a dos
     combos vendidos que o têm como componente.
144. **Recebedor do PIX da loja só com `lojas.editar_pix`** (implantação I5; `lojas/lojas.controller.ts`,
     `PERMISSOES` em `@genesis/shared`). A chave, o nome e a cidade do recebedor decidem para qual conta vai o dinheiro
     de todo QR feito no caixa; com só `lojas.editar`, que o Gerente padrão tem, um gerente trocaria a chave pela dele e
     ainda liberaria a confirmação manual. **Padrão até a confirmação do dono**: a permissão nova
     `lojas.editar_pix` ("Lojas: Alterar o recebedor do PIX") vai só para o Administrador no seed (que tem tudo fora o
     `SOMENTE_MASTER`; nas empresas já criadas o pós-migração acrescenta ao perfil Administrador) e o Master; o
     `criar` e o `alterar` recusam com 403 quando algum dos três campos muda em relação ao que está gravado (no criar,
     em relação a vazio), e o resto da loja segue com `lojas.criar`/`lojas.editar`. Cada mudança grava, além do
     `editar` (ou `criar`) da loja, a auditoria `pix_recebedor_alterado` (`ACOES_AUDITORIA` e `CatalogosNuvem` do PDV)
     com só os três campos em `antes`/`depois`, para achar a troca sem ler o diff inteiro. No ERP, sem a permissão, os
     três campos ficam travados com a explicação. Alerta no Dashboard fica para quando o dono decidir (a auditoria já
     tem o registro).

### Fase 2 – produtos e estoque (API)

145. **Trava dos tipos sem suporte: "Com variações" e "Com complementos"** (Fase 2, F2-B1; roadmap D43 (**decidida pelo dono: complementos sim,
     variações não**) e D44; PDV 10.2; decisão 74; `CHAVES_TIPO_PRODUTO`, `tiposProdutoHabilitados` e
     `motivoTipoProdutoBloqueado` em `@genesis/shared` `produtos.ts`; `produtos/gravacao.ts` › `tiposHabilitados` e
     `validarNoBanco`). O ERP deixava escolher "Com variações" sem grade nenhuma, e o caixa resolve o EAN da variação
     para o pai e vende com o preço e o saldo dele. Duas chaves novas no catálogo, grupo `produtos` (entrou em
     `GRUPOS_CONFIGURACAO`), `produtos.variacoes_habilitadas` e `produtos.complementos_habilitados`, padrão `false` (a de complementos nasce ligada desde o F2-B51, decisão 194),
     só na empresa e sem descer ao PDV (não há seed: o catálogo só grava o que difere do padrão); quem as liga são os
     blocos da grade (F2-B49) e do modal (F2-B51), e até lá aparecem em Configurações › Geral › Produtos marcadas como
     "módulo futuro". Com a chave desligada, **escolher** o tipo é recusado: o `POST /produtos` com o tipo e o `PUT` que
     troca um produto para ele dão 422 no campo `tipo` ("Tipo disponível em breve: …"), pela mesma regra no
     formulário, na API e na importação (`inserirProduto`/`atualizarProduto`). O **produto já gravado** com o tipo
     (legado do Nuvem3) continua: o `PUT` que mantém o tipo é aceito, sem obrigar a trocar. **Sair de "Com variações"**
     é livre quando não há variação ativa (`produtos_variacoes` ativa e não excluída → 422 "O produto tem variações
     ativas…"); o legado sem grade que já vendeu só movimentou o pai, então troca como se fosse Simples na regra de
     troca com movimento (ERP 8.2.1: Simples ↔ Matéria-prima ↔ Serviço); com movimento de alguma variação
     (`movimentos_estoque.variacao_id`) vale a regra antiga. `GET /produtos/tipos-habilitados` (`produtos.ver`) devolve os
     tipos que o formulário oferece na criação. A listagem ganhou "Situação de cadastro = **Tipo sem suporte**"
     (`tipo_sem_suporte`: os tipos travados agora, lidos das chaves só quando o filtro pede; vale também na
     exportação). A **importação** recusa só a criação desses tipos e a troca para eles, com o mesmo motivo; a
     atualização do produto existente segue normal (o "Com complementos" da carga do Nuvem3 passa, e a reimportação
     continua 100% sem alteração); com a chave das variações ligada, "Com variações" novo continua fora da planilha
     (a grade fica no ERP). **Caixa**: nada muda neste bloco; "Com complementos" continua vendável sem complementos
     (PDV 10.2), e a recusa do produto com variações no caixa (`pdv.recusa_produto_com_variacoes`, D44) é do F2-B34.
     Os 8 valores do enum `produtos.tipo` ficam (ERP 23.2, questão 18). Sem migração.
146. **Ordem de lançamento do razão = `seq_lancamento`** (Fase 2, F2-B2; ADR-05; T20, T23; SYNC 8.3; MD 3.7.2;
     migrações `0016_movimentos_seq_a` e `0017_movimentos_seq_b`; `src/estoques/seq-lancamento.ts`, `cadeia.ts`;
     `aplicarMovimentoNoSaldo` em `@genesis/shared` `estoque.ts`). O custo médio depende da ordem em que os movimentos
     foram **lançados** na linha de saldo (estoque × produto × variação × tipo), não da `data_movimento`, e essa ordem
     não ficava gravada: o `id` é um UUIDv7 gerado no Node e o `criado_em` é a hora de início da transação, igual para
     o documento todo. **Coluna nova** `movimentos_estoque.seq_lancamento bigint not null`, com
     `default nextval('seq_movimentos_estoque')` (`cache 1`, início em 10¹²): o `nextval` roda no `INSERT`, que o motor
     faz depois do `select … for update` da linha de saldo, então cresce por linha na ordem em que o custo médio foi
     calculado, com qualquer número de processos da API; o motor não cita a coluna (o código antigo, durante o deploy,
     grava igual). Índice `ix_movimentos_estoque_linha_seq (estoque_id, produto_id, variacao_id, tipo_estoque_id,
     seq_lancamento)`, o cursor do replay. **Migração em etapas**, sem reescrever a tabela nem segurar trava exclusiva
     além do instante do DDL: a **A** cria a sequência, a coluna vazia sem default (só metadado), o default (só para as
     linhas novas) e o `check (seq_lancamento is not null) not valid` (vale para as novas e para o preenchimento); a
     **B** faz o `VALIDATE` (SHARE UPDATE EXCLUSIVE: as vendas continuam gravando), o `SET NOT NULL` pelo check validado
     (sem varrer de novo, PG ≥ 12), descarta o check e cria o índice só se ele ainda não existir. Entre as duas, **fora
     da transação**, o preenchimento (`preencherSeqLancamento`): o executor de migrações ganhou as **preparações por
     tag** (`PREPARACOES_MIGRACAO_EMPRESA`, seção "Migrações"), então o `db:migrate:empresas` faz A → preenchimento →
     B numa passada; à mão, `db:preencher-seq-lancamento`. Sem o preenchimento (journal aplicado à mão num banco com
     movimentos), a B falha com a instrução e não grava nada. O **preenchimento** pega uma linha de saldo por
     transação curta, sem a 7300001 e sem `versao` nova (o push não espera), encadeia os movimentos antigos pelo saldo
     — cada passo, o movimento cujo `saldo_anterior` é o `saldo_posterior` do anterior, a partir de zero, e entre
     vários (a linha voltou ao mesmo saldo) o de menor `id`, que cresce com o lançamento porque é gerado já com a linha
     travada; o `criado_em` **não** é critério — e numera 1…N, abaixo de todo movimento lançado depois da A. A **quebra
     de cadeia não aborta**: a linha fica na ordem (`criado_em`, `id`), entra no relatório e abre o alerta
     `RAZAO_CADEIA_QUEBRADA` (aviso, um por linha, `dados` com o movimento, os saldos e a `origem`), salvo quando
     essa ordem é ela mesma contínua (o desempate escolheu um ramo sem saída). A quebra também pode estar só na
     **emenda**: os antigos se encadeiam (e ficam nessa ordem), mas o primeiro lançado depois da 0016 partiu do saldo
     da projeção, que já não era o fim do razão; o alerta diz qual dos dois (`origem` `antigos` ou `emenda`). Quem
     corrige o saldo é o `db:recalcular-saldos` (F2-B3). **Relatório**: pelo `db:migrate:empresas` (e pelo "Aplicar"),
     a preparação devolve o relato do preenchimento ao migrador (quando havia movimento a preencher): aviso no
     resultado da empresa quando há quebra e o relato (contagens e até 200 quebras) em `auditoria_plataforma`
     `migracao_preparada`; o
     `db:preencher-seq-lancamento --saida=quebras.csv` lista as linhas quebradas pelo estado do razão
     (`linhasComCadeiaQuebrada`), então serve também depois da migração. **Grant da sequência**: a 0016 dá
     `usage, select` em `seq_movimentos_estoque` à role de runtime na mesma transação, porque o default roda o
     `nextval` com a role que insere e o `garantirRoleAplicacao` só vem depois do preenchimento e da 0017 (seção
     "Migrações"). Também cria o índice com `create index concurrently` (o inválido de uma execução
     interrompida é refeito) e é idempotente. **Imutabilidade**: o movimento continua imutável; a única mudança aceita
     é a `seq_lancamento` passar de nula a preenchida, uma vez (`fn_protege_imutavel` com a coluna livre +
     `tg_movimentos_estoque_seq_lancamento`, que recusa mudar ou apagar a ordem gravada com `DOCUMENTO_IMUTAVEL`); o
     `fn_versao_local` aceita colunas isentas como o `fn_versao` desde a 0011 (sem argumentos, igual a antes) e o
     trigger de versão do razão isenta `seq_lancamento`. **Função pura comum**: `aplicarMovimentoNoSaldo(saldo,
     custoMedio, mov)` (entrada com custo médio ponderado, saída ao custo médio vigente ou ao de referência sem custo
     médio, estorno de saída ao custo original sem redefinir o custo médio do saldo ≤ 0 (T20), compensação e "Definir"
     pelo sinal; 3 casas na quantidade, 4 nos custos e 2 no total, em cada passo) é a conta do motor online
     (`calcularMovimento`, sem mudar o comportamento) e a do replay (`movimentoGravadoNoSaldo` relê o movimento
     gravado: o `custo_unitario` vale como custo do documento, custo original e referência). Teste de propriedade
     com semente fixa (`estoque.propriedade.spec.ts`, 300 sequências com saldo zero e negativo, estornos,
     compensações e "Definir"): online passo a passo e replay da lista dão o mesmo saldo e custo médio em decimal.
     `verificarCadeia(linha)` (SQL com o `lag` do `saldo_posterior` na ordem gravada) e `linhasComCadeiaQuebrada` ficam
     para o F2-B3. As suítes que movimentam estoque (venda, cancelamento e vasilhame, acerto, documento do PDV,
     importações) terminam conferindo o banco: toda linha fecha por `seq_lancamento`, o encadeamento pelo saldo chega
     à mesma ordem e o replay repete cada movimento e o `saldos_estoque`. Sem espelho no PDV (`movimentos_estoque` não
     desce).
147. **`db:recalcular-saldos`: a projeção refeita pelo razão por `seq_lancamento`** (Fase 2, F2-B3; MD 3.7, 3.1.8;
     ERP 13.1.1; roadmap Fase 2 › Definição de pronto; `src/estoques/recalcular.ts`, `src/cli/recalcular-saldos.ts`,
     `src/estoques/verificacao-razao.ts`). **Replay**: cada linha de saldo (estoque × produto × variação × tipo) é
     refeita a partir de zero, na ordem de lançamento (`seq_lancamento`, decisão 146; desempate por `id`), pela mesma
     conta do motor online (`aplicarMovimentoNoSaldo` sobre `movimentoGravadoNoSaldo`); as datas de última entrada e
     saída são as maiores `data_movimento` pelo sinal (o `greatest` do motor) e o `ultimo_movimento_id` é o último
     lançado. Compara `quantidade`, `custo_medio`, `ultima_entrada_em`, `ultima_saida_em` e `ultimo_movimento_id`;
     acha também a linha **órfã** (linha de saldo sem razão, com saldo ou custo), o razão **sem linha** de saldo e o
     `produtos.custo_medio` diferente da média ponderada dos saldos positivos (a conta exata da 0006, em SQL; fora os
     combos). **Memória constante**: uma transação `repeatable read read only` (razão e projeção no mesmo instante: a
     venda que entra no meio não vira divergência falsa) com dois cursores do servidor em ordem de chave — o do razão
     segue a ordem do `ix_movimentos_estoque_linha_seq`, que o cursor favorece, em páginas de 10 mil —, juntados em ordem no Node; só as divergências
     ficam na memória (200 mil movimentos abaixo de 256 MB de heap no teste; a planilha real com o saldo do Nuvem3,
     1.664 linhas, em 2,5 s). O `order by` é qualificado: a coluna de saída `seq_lancamento::text` ordenaria como
     texto. **Relatório** por linha divergente: situação (`divergente`, `orfa`, `sem_linha`), cada campo com o
     gravado, o recalculado e a diferença, e o primeiro movimento divergente; `--saida` grava o CSV (uma linha por
     campo). **Razão inconsistente** (a cadeia gravada quebrada, a regra do `verificarCadeia`, ou um movimento cujo
     saldo ou custo o replay não repete) é **histórico**, não divergência: o movimento lançado sobre uma projeção
     errada fica assim para sempre (o razão é imutável), e a linha com a projeção certa só sai como aviso. "Idêntico"
     = nenhuma divergência de projeção. **`--corrigir`** nunca altera movimento: em blocos de até 500 linhas por
     transação, a 7300001 primeiro (`fn_trava_versao`, MD 1.5), cria a linha que falta, trava as linhas com
     `select … for update` na ordem de `ordenarChaves` e **continua o replay** a partir do estado da verificação com
     os movimentos de `seq_lancamento` maior (na linha travada, a ordem de lançamento é a de commit): a venda que
     chegou entre a verificação e a correção, ou que disputa a trava com ela, não se perde, e a trava fica presa só
     pelo que mudou. Regrava só o que ainda diverge, com a auditoria **`recalcular_saldos`** (ação nova no catálogo;
     `origem = 'sistema'`, `usuario_nome = cli:<usuário>`, a linha em `antes`/`depois`), e a `versao` sobe, então o
     saldo certo desce ao PDV pelo fluxo `estoque`. O `produtos.custo_medio` acompanha pelo trigger da 0006; o
     divergente com os saldos certos é refeito por `fn_projetar_custo_medio_produto` (auditado em `produtos`). Depois
     resolve os `RAZAO_CADEIA_QUEBRADA` abertos das linhas do filtro (MD 3.1.8). **Comando**: `--empresa=<código>[,…]`
     ou `--todas` (um dos dois), `--estoque` e `--produto` (UUID conferido: entram como literal no `declare cursor`),
     com a role dona, como o `db:migrate:empresas`; recusa a empresa sem a 0016 ou com movimento sem ordem. Código de
     saída 0 (idêntico ou corrigido), 2 (diverge sem `--corrigir`), 1 (falha de alguma empresa). **Verificação
     periódica opcional, desligada por padrão** (`VERIFICACAO_RAZAO_CRON`, cron em UTC no `schedule` do pg-boss): só
     verifica, pela role de runtime, e abre o alerta `RAZAO_SALDO_DIVERGENTE` (aviso, um aberto por empresa,
     `razao_saldos`, com as contagens e as 20 primeiras linhas), que a verificação seguinte idêntica resolve (ou a
     conferência idêntica da empresa inteira pelo comando, sem `--estoque`/`--produto`: com a verificação desligada,
     o alerta aberto antes não fica parado no painel); nunca corrige. O cron é validado na configuração pela mesma
     regra do pg-boss (`cron-parser`): um digitado errado recusa a subida, em vez de rejeitar o início da fila e
     derrubar todo envio (e-mails, tarefas); e cada `schedule` do `FilaTrabalhos.iniciar()` é isolado (o que falha vai
     para o log). Como o cron fica no banco, esvaziar a variável faz a instância com trabalhador remover o agendamento
     (`desagendar` → `unschedule`), em vez de o pg-boss seguir criando um job por dia sem consumidor. O lote
     (`saldos_lote`) e a última compra entraram no F2-B6, estendendo o mesmo núcleo (decisão 151). As suítes que
     movimentam estoque terminam também com o `verificarSaldos` idêntico (`test/integracao/razao.ts`). Sem migração e
     sem espelho no PDV; o PDV só ganhou a ação nova na cópia do catálogo (`CatalogosNuvem`), que não muda nada no
     caixa.

148. **Compensação no motor e regra de data dos documentos do ERP** (Fase 2, F2-B4; ERP 13.1.5, 13.5; SYNC 15.3; T23;
     roadmap Fase 2 › Definição de pronto; plano da Fase 2 › "Padrões aplicados sem pergunta", **padrão até a
     confirmação do dono**; `src/estoques/compensacao.ts`, `movimentos.ts` › `conferirDataMovimentos`, `acertos.ts`).
     O objetivo é que nenhum documento novo da Fase 2 (recebimento, NF-e, transferência) fure um "Definir" já
     efetivado. **Compensação no motor**: `compensarDefinir` (e a busca do último "Definir" efetivado com contagem
     posterior ao fato) saiu do handler da venda para `estoques/compensacao.ts`; a venda, o cancelamento e a
     devolução de cascos só a importam, sem mudar o comportamento (a mesma compensação, a mesma observação, o mesmo
     `resultado.compensacoes`), e o acerto passou a usá-la: depois de lançar os itens, ainda em `rascunho` (não se
     compensa a si mesmo), os movimentos dele passam pela mesma busca. Efeito: o **"Definir" de contagem anterior à de
     outro já efetivado** na mesma linha (a contagem de terça lançada depois da de quarta) é anulado pelo mais novo, na
     data da própria contagem — a contagem mais nova vale; e a Entrada/Saída lançada antes de um "Definir" com a
     contagem informada no futuro (a folga de 5 min do `criarAcertoSchema`) também é compensada. **Estorno**: o
     `estornarAcerto` estorna, além dos movimentos do acerto e das compensações que ele lançou (como antes), as
     compensações que **outro** "Definir" lançou contra os movimentos dele (`compensacoesDoDocumento`), no item do
     movimento compensado; sem isso o estorno do "Definir" antigo, em `now()`, desfazia o movimento e deixava a
     compensação valendo. Estornar o mais novo estorna as compensações dele, e a contagem antiga volta a valer
     **por inteiro**: o fato compensado pelo mais novo que também é anterior à contagem de outro "Definir" efetivado
     (a venda tardia de segunda, anterior às contagens de terça e de quarta) não passa a valer, porque a contagem de
     terça já o tinha visto; ele ganha uma nova compensação contra esse "Definir", na data do fato
     (`fatosCompensados` + `definirPosteriores` sem o acerto em estorno + `lancarCompensacoes`). Para isso a
     **migração 0018** troca `uq_movimentos_estoque_compensacao (compensa_movimento_id)` por
     `(compensa_movimento_id, documento_id)`: um fato pode ter uma compensação por "Definir" (o estornado não volta a
     ser efetivado), e só uma viva por vez, garantia do motor. O saldo negativo do estorno (Master ou
     `estoque.permite_negativo_erp`) é conferido pelo **efeito líquido de cada linha de saldo**, na primeira trava
     dela: o estorno do movimento de um "Definir" anulado e o da compensação que o anulava se cancelam, e o par
     estorno + nova compensação também; conferido movimento a movimento, o estorno do "Definir" antigo com diferença
     positiva (ou da Entrada anulada por uma contagem à frente) era recusado com 422 sem mudar o saldo. A auditoria
     da efetivação diz quantos movimentos foram anulados por um "Definir" de contagem posterior, e a do estorno,
     quantos fatos foram compensados de novo. **Regra de data**: todo documento do ERP lança com
     `data_movimento = now()`; a data do documento (a "Data" do acerto, a emissão ou a entrada da nota, a data da
     transferência) é atributo do cabeçalho. Só lançam no passado o "Definir" (na `data_contagem`, inclusive o
     AJUSTE_IMPORTACAO da planilha, e a hora da contagem informada do F2-B11) e a compensação (na data do fato
     compensado), pela flag **`retroativoPermitido`** de `lancarDocumento` e `lancarMovimento` (o nome evita a
     confusão com "compensar"). Sem a flag, o movimento que não é do PDV (o do PDV traz o `evento_id`, e a
     compensação de um movimento do PDV o herda) com data anterior a `now() − 1 min` é recusado com
     `ErroDataRetroativa`, um erro de programação (500): no `lancarDocumento`, antes de travar qualquer linha; no
     `lancarMovimento`, que recebe a linha já travada por quem chama, antes de gravar. A folga
     (`FOLGA_RETROATIVO_MS`) cobre a espera entre montar a linha e lançá-la; o documento que lança linha a linha (a
     Entrada/Saída do acerto aceita até 5.000 itens, cerca de 5 comandos cada) passa **`inicioDocumento`**, o
     instante capturado antes do laço, e a folga é medida contra ele: um acerto grande num banco lento não estoura a
     regra no fim do laço. **Mudança visível**: a Entrada e a Saída do acerto lançavam na `data_contagem` digitada e
     agora lançam no momento da efetivação — a Entrada com a "Data" de ontem, efetivada hoje depois de uma contagem,
     é posterior a ela (a contagem não a viu) e não é desfeita pelo "Definir"; o relatório de movimentação mostra a
     hora do lançamento, e a "Data" segue no acerto (a tela diz abaixo dela, na Entrada e na Saída: "Data do
     documento: o estoque muda ao efetivar"). O estorno do acerto já lançava em `now()`. Teste da Definição de pronto
     (`definir-offline.test.ts`): o caixa 1 vende 3 antes da contagem e o caixa 2 vende 2 depois, nas três ordens de
     chegada (todas antes de efetivar, as anteriores depois, as posteriores depois), e o saldo final é a contagem
     menos as vendas posteriores; o estorno do "Definir" desfaz as compensações e o razão refaz a projeção idêntica
     depois de cada caso. O mesmo arquivo cobre os dois "Definir" com a venda tardia anterior aos dois (nas duas
     ordens de efetivação), o estorno líquido por um usuário sem o negativo e a Entrada anulada por um "Definir" com
     a contagem 4 min à frente. Sem espelho no PDV (a 0018 é só da nuvem).
149. **Estoques permitidos de verdade, com a virada sem perda de acesso** (Fase 2, F2-B5; ERP 2.1, 11.2; MD 3.3.5;
     F2-Q4 = roadmap D45, **padrão até a confirmação do dono**; `src/estoques/permitidos.ts`, migração 0019).
     **Regra única**: o Master vê e movimenta todos os estoques; quem tem a permissão nova **`estoques.todos`**
     também (catálogo do shared, "Locais de estoque: Ver e movimentar todos"; fica em `SOMENTE_MASTER` dos perfis
     padrão, então só o Master a tem no seed, e a empresa pode concedê-la a um perfil ou usuário); os demais veem
     **só os estoques de `usuarios_estoques`, inclusive os sem loja** (o CD). As lojas permitidas não entram mais na
     conta: até a 0018 o restrito via os estoques das lojas dele e todo estoque sem loja (decisão 51). A lista é
     calculada com as permissões (`PermissoesEfetivas` → `AcessoUsuario.estoques` → `SessaoErp.estoques`, `null` =
     todos), com o mesmo cache de 60 s, e `usuarios_estoques` entrou na geração das permissões: conceder ou retirar
     um estoque vale na requisição seguinte em todas as instâncias. **Helper**: `estoquesPermitidos(sessao, 'ver' |
     'movimentar')`, `estoqueVisivel(sessao, coluna, modo)` (`coluna = any(lista)`; sem estoque nenhum, não casa com
     nada) e `estoquePermitido`/`garantirEstoquePermitido`. Os dois modos dão hoje a mesma lista
     (`usuarios_estoques` não separa as ações); quem chama declara o que confere. **Aplicado em**: locais de
     estoque (listagem, detalhe, alterar, excluir → 404 fora da lista), acertos (listagem e detalhe filtram; criar
     ou alterar com o estoque fora da lista → **403** no campo `estoqueId`; abrir, alterar, excluir, efetivar e
     estornar pelo id → 404, `movimentar`), saldos (a listagem e o "sem movimento" só nos permitidos; a grade do
     acerto `GET /saldos-estoque/itens` fora da lista → 404), `GET /produtos/:id/saldos` (e os combos montáveis),
     o dashboard (o "abaixo do mínimo" exige o estoque da loja na lista, e a lista entra na chave do cache) e a
     importação de produtos com "Atualizar estoque" (o estoque da loja escolhida tem de estar na lista, `movimentar`:
     403 no campo `atualizarEstoque` na prévia, na confirmação e de novo na tarefa; sem a opção, basta a loja).
     **Quem cria** um local de estoque, ou a loja cujo assistente cria o estoque, sem ver todos, passa a tê-lo em
     `usuarios_estoques` (`concederEstoqueAoCriador`, como a loja recém-criada em `usuarios_lojas`); a resposta da
     criação não filtra pela lista antiga da sessão. Vincular a loja (nova ou na edição) a um estoque **existente**
     fora da lista é 403, senão a criação viraria concessão. **Usuários** (decisão 89): a lista do formulário é a
     lista inteira do que o usuário vê; o editor concede só o que está na dele, os estoques que ele não vê são
     preservados, e o alvo com estoque fora do alcance do editor (ou com `estoques.todos`, que o editor não tem)
     conta como "mais acesso". **Estoque excluído**: `DELETE /estoques/:id` encerra na mesma transação os vínculos
     dele em `usuarios_estoques`, e a lista do usuário (detalhe, gravação e escalada) só conta estoque vivo, como a
     da sessão; sem isso, o estoque excluído contava como "estoque que o editor não vê" (403 "mais acesso" para todo
     editor restrito) e voltava no detalhe (422 "Estoque inexistente ou excluído" até para o Master). **Virada**
     (`0019_usuarios_estoques_virada`, só dados, idempotente): para cada usuário não Master não excluído (ativo ou
     não), insere os estoques que ele via pela regra antiga — os das lojas permitidas mais os sem loja —, então
     **ninguém perde acesso no deploy** (F2-Q4 (a)); o gerente restringe depois pela tela de usuários. **Nem ganha**:
     os "Estoques adicionais" gravados na Fase 1 não davam acesso (a tabela não era lida); a linha de estoque de loja
     fora das lojas do usuário passaria a valer no deploy sem ninguém ter decidido, então a virada a encerra
     (`excluido_em`, o histórico fica), e também a que aponta para estoque já excluído; a que cabe na regra antiga
     fica como está (antes = depois, critério do plano; o gerente concede de novo pela tela, se quiser). Usuário criado depois da virada começa **sem estoque nenhum**; o ERP, ao marcar uma loja
     no formulário, põe o estoque dela na lista (o gerente pode tirá-lo), e desmarcar a loja não mexe nos estoques
     (README do ERP › decisão 47). **Alternativas da D45** (sem código novo): "só o Master e `estoques.todos`" é tirar
     o CD de todos na tela; "lista nominal" é deixá-lo só para os escolhidos. Testes (`estoques-permitidos.test.ts`):
     o gerente com as lojas 1 e 2 e só o estoque da loja 1 não vê o CD nem o estoque da loja 2 (listagem e detalhe;
     alterar e excluir pelo id → 404), não cria, abre, altera, exclui, efetiva nem estorna acerto deles (por id; nem
     troca o estoque do próprio rascunho para o CD → 403), não os acha por filtro (acertos, saldos, grade, saldo do
     produto, dashboard), não importa com "Atualizar estoque" na loja 2 (prévia e confirmação) e não vincula loja ao
     CD (na criação nem na edição → 403); quem cria um estoque ou uma loja com estoque novo passa a vê-lo;
     `estoques.todos` vê todos; retirar só um estoque vale na requisição seguinte (o passo deixa o cache quente antes
     e muda só `usuarios_estoques`); o estoque excluído some da lista de quem o tinha, e o editor restrito e o Master
     continuam gravando esse usuário (também com o vínculo antigo ainda vivo); o usuário criado sem estoques não vê
     nenhum; e a **regressão da virada**: para os 7 perfis padrão × (sem loja, loja 1, lojas 1 e 2), a lista
     antes = o gabarito literal da combinação (a reescrita da regra antiga fica só como conferência extra) = a lista
     depois (banco e `GET /estoques`); o "adicional" da Fase 1 fora das lojas e o vínculo com estoque excluído são
     encerrados (o que cabia na regra fica, na mesma linha); o excluído e o Master não recebem linhas e rodar de novo
     não muda nada. Sem teste: a reconferência do estoque na tarefa assíncrona da importação (a confirmação síncrona
     tem). O `criarUsuario` dos testes de integração dá ao usuário o que a virada daria (`estoques` explícito
     muda isso). Fica de fora: a auditoria (`GET /auditoria`) continua filtrada pelas lojas, e o responsável do
     acerto continua conferido pela loja do estoque. Sem espelho no PDV (`usuarios_estoques` não desce).
151. **Lote no motor de estoque: `saldos_lote` mantido pelo razão, divisão FEFO e última compra** (Fase 2, F2-B6;
     MD 3.6.9, 3.7.3, 3.7.4; ERP 13.1.1; PDV 10.8; F2-Q7 = roadmap D48, **decidida pelo dono em 05/11/2026**;
     `src/estoques/movimentos.ts`, `acertos.ts`, `compensacao.ts`, `recalcular.ts`, migração 0020). Antes deste bloco
     `saldos_lote` descia ao PDV e ninguém o gravava, e as colunas de última compra ficavam nulas. **Motor**: o
     movimento com `lote_id` (o `loteId` opcional de `ChaveSaldo`) soma também na linha de `saldos_lote` da chave +
     lote, na mesma transação. As linhas de `saldos_lote` são criadas (`on conflict do nothing`) e travadas
     (`select … for update`) **depois** de todas as de `saldos_estoque` do documento, em `ordenarChaves` (que desempata
     pelo lote: os lotes em ordem e o sem lote por último); como toda gravação em `saldos_lote` (o motor e o
     `--corrigir`) segura antes a linha de `saldos_estoque` da chave, a do lote nunca é disputada sozinha e não há ordem
     cruzada. Quem garante a ordem são os testes unitários de `movimentos.spec.ts` (o desempate de `ordenarChaves` e a
     sequência de comandos do `lancarDocumento`: todas as travas de `saldos_estoque` antes da primeira de `saldos_lote`);
     o teste de 20 acertos de saída concorrentes com vendas do PDV no mesmo produto com lote só confirma que nada quebra
     sob a 7300001, que serializa os dois documentos antes de qualquer trava de linha. O `lancarMovimento` (o acerto)
     passou a ir pelo `lancarDocumento` (a segunda trava da linha já travada não espera) e devolve a lista de
     movimentos: um, ou um por lote. **Lote válido** = do produto e da variação do movimento e do estoque dele ou sem
     estoque (MD 3.6.9). O documento do ERP com lote inválido é erro (`ErroLoteInvalido`; o acerto confere antes, com
     422 no campo `itens.N.loteId`); a linha do PDV com lote inválido segue **sem o lote** (SYNC 15.1, a nuvem não
     recusa a venda) e, sendo saída, entra na divisão FEFO. A **migração 0020** é a segunda barreira: o trigger
     `tg_movimentos_estoque_lote` (só no movimento com lote) recusa o inválido com `LOTE_INVALIDO` (o filtro de erros
     traduz para 422), e `tg_produtos_lotes_produto_imutavel` torna o produto e a variação do lote imutáveis (o
     `estoque_id` já era, filtro do pull da 0004): mudar o produto do lote levaria o saldo dele de um produto para outro
     sem movimento. **Saída sem lote** (a venda do PDV-1, que ainda não informa o lote; a Saída do acerto sem lote; a
     diferença negativa do "Definir"), de produto com lote de saldo positivo naquele estoque e tipo, conforme
     **`estoque.lote_baixa_sem_informar`** (catálogo do shared, só empresa, não desce ao PDV; Configurações › Geral ›
     Estoque): **`fefo`** (padrão, F2-Q7 (a)) divide a saída em um movimento por lote, na ordem FEFO (validade
     crescente, sem validade por último, `id` do lote no empate; `ordenarLotesFefo`/`dividirSaidaFefo` do shared), cada
     um até o saldo do lote, com o `lote_id` gravado e ao custo médio da linha; o lote zerado ou negativo fica de fora, e
     a **sobra** sem saldo de lote sai sem lote. **O lote informado é reservado antes**: as linhas com lote da mesma
     linha de saldo, em qualquer posição do documento, somam ou tiram do saldo corrente antes de a saída sem lote ser
     dividida (seguir a ordem do documento deixava a saída sem lote que vinha antes consumir o lote que a linha seguinte
     pediu, e o lote terminava negativo com o outro ainda com saldo); no acerto, em que cada item é um documento do motor,
     o mesmo vale pela ordem de `ordenarChaves` (o item com lote antes do sem lote da mesma linha de saldo). As partes que
     caem na mesma chave de idempotência são somadas de novo (o índice já inclui `lote_id`). **Custo das partes**: cada
     parte arredonda o `custo_total` dela a 2 casas (o razão é refeito movimento a movimento, decisões 146 e 147), e o custo do
     item é sempre a **soma das partes** — na venda (`custoPorItem`) e, desde a revisão do bloco, no `total_custo` do item
     e do cabeçalho do acerto —, o mesmo CMV que sai do razão; a diferença para a mesma saída sem lotes é de no máximo
     R$ 0,01 por parte (custo médio 0,3333, três lotes de 1: 0,99 em vez de 1,00). **`nao_baixar`** (F2-Q7 (b)) não mexe no saldo
     por lote, que passa a divergir do total (a saída fica sem lote, reconstruível do mesmo jeito). A chave só é lida
     quando a linha tem lote com saldo: a venda de produto sem lote paga só uma consulta indexada (`uq_saldos_lote_chave`).
     A entrada sem lote (a diferença positiva do "Definir", a Entrada do acerto sem lote) fica sem lote. **Estorno e
     compensação** nunca são divididos: herdam o lote do movimento que desfazem (o cancelamento do PDV já copiava o
     `lote_id`; o estorno do acerto e o das compensações de outro "Definir" passaram a copiá-lo), então cada parte FEFO
     volta ao lote de onde saiu. O estorno do acerto confere, além do efeito líquido da linha de saldo, o de cada **linha
     de lote** contra `saldoDoLote`, pela mesma regra do saldo negativo (Master ou `estoque.permite_negativo_erp`): sem
     isso, o estorno da Entrada de um lote já vendido em FEFO deixava o lote negativo (e a parte sem lote positiva) sem
     a permissão que a Saída com lote exige. O mesmo vale para o estorno do recebimento quando ele chegar (PR-4).
     **Acerto**: `itens_acerto_estoque.lote_id` passou a valer — o `itemAcertoSchema` aceita
     `loteId` (o mesmo produto em lotes diferentes não é "repetido"), a Entrada e a Saída lançam com ele e a Saída com
     lote também confere o saldo do lote (a mesma regra do saldo negativo: Master ou `estoque.permite_negativo_erp`); o
     **"Definir" não aceita lote** (o contrato recusa: a contagem é do produto inteiro, e a compensação dos eventos
     tardios é por linha de saldo, não por lote — o inventário por lote fica para quando houver o bloco de lotes, F2-B17).
     A tela de acertos ainda não escolhe lote (F2-B17): mostra o lote do item gravado e o devolve ao salvar. **Última
     compra**: `atualizarSaldos` grava `ultima_compra_em` e `ultimo_custo_compra` (o custo unitário na unidade base) da
     **última entrada de compra lançada** do grupo (`RECEB_MANUAL` ou `RECEB_NFE`, não estorno; `movimentoDeCompra`),
     e sem compra no documento a gravada fica. O estorno do recebimento (`ESTORNO_RECEB_*`) não volta a última compra:
     ela é o registro da última compra lançada (o relatório e o F2-B13 mostram o vínculo de onde ela veio). Os
     documentos que geram RECEB_* são do PR-4/PR-5; o teste lança o movimento direto no motor. **Recalcular** (decisão
     147): o replay refaz, por linha, o saldo de cada lote (a soma dos movimentos com o lote) e a última compra pela
     mesma regra, na ordem de lançamento; as linhas de `saldos_lote` vêm agregadas na própria linha de `saldos_estoque`
     (`json_agg` no cursor: continua um cursor de saldos e memória constante; 200 mil movimentos seguem abaixo de 256 MB),
     e as sem linha de saldo (que o motor nunca deixa) numa consulta à parte, como órfãs. Os campos novos do relatório:
     `ultima_compra_em`, `ultimo_custo_compra` e `saldo_lote` (com o `lote_id`, coluna nova no fim do CSV). O
     `--corrigir` trava as linhas de `saldos_lote` depois das de `saldos_estoque` e regrava o lote divergente (cria a
     linha que falta; o lote sem movimento fica zerado), com o saldo por lote e a última compra no `antes`/`depois` da
     auditoria. É também o **backfill**: até aqui nenhum movimento tinha lote, e o lote que entrar antes desta versão se
     refaz com ele. A identidade Σ `saldos_lote` + a parte sem lote = `saldos_estoque` é **consequência** do replay (o
     lote é a soma dos movimentos com ele, e o total a de todos): vale em qualquer modo, inclusive `nao_baixar`, e não
     prova a divisão FEFO. Quem a prova no `lotes-motor.test.ts` são as quantidades esperadas explícitas e o
     `conferirFefo` (nenhuma saída sem lote lançada com lote de saldo positivo, contando o lote reservado no mesmo
     documento), que falha de propósito com `nao_baixar`. **PDV**: nenhum schema novo — `saldos_lote` (só do
     tipo vendável) e `produtos_lotes` (filtrado pelo estoque da loja ou sem estoque) já estavam no `Esquema.g.cs` e
     descem como antes, agora com valores; o PDV antigo continua igual (sem tipo nem versão de evento novos). Testes:
     `lotes-motor.test.ts` (a venda de 10 com A, que vence antes, com 6 e B com 8 baixa 6 de A e 4 de B; o cancelamento
     devolve aos mesmos lotes; o pull do `estoque` traz o saldo por lote antes e depois; a sobra sem lote e o
     `nao_baixar`; a Saída do acerto em FEFO e o estorno; o "Definir" negativo em FEFO e positivo sem lote; o lote de
     outro estoque ou produto recusado no acerto, no motor e no banco, e aceito sem lote do PDV; o filtro do pull —
     `produtos_lotes` sem o lote do CD e `saldos_lote` sem o do CD nem o da avaria; o acerto com o mesmo produto com e sem
     lote; a recusa do saldo do lote na Saída e no estorno para o estoquista, e o "Lote não encontrado"; a compensação
     do "Definir" com lote e o estorno nos mesmos lotes, inclusive o das compensações de outro "Definir"; o custo do item
     como soma das partes; a última compra; os 20 concorrentes; o `--corrigir` do lote divergente e do órfão), `recalcular.spec.ts`, `estoque.spec.ts` do shared e
     o `AplicadorPullTests` do PDV.
152. **Cadastro de Tipo de Estoque com ressincronização** (Fase 2, F2-B7; ERP 13.6; MD 3.2.6, 6.4 regra 3, 7.4; SYNC
     6.7, 6.11; roadmap D55, **decidida pelo dono em 05/11/2026**; `src/estoques/tipos-estoque.controller.ts`,
     `src/sync/comandos.ts` › `ressincronizarFluxos`; `criarTipoEstoqueSchema`, `alterarTipoEstoqueSchema`,
     `errosRegraTipoEstoque`, `VENDAVEL_TRAVADO_POR_CHAVE` e `CHAVES_TIPO_ESTOQUE_SEMPRE_ATIVAS` no shared `estoque.ts`).
     O controller saiu de `saldos.controller.ts` e ganhou `GET /:id` (`tipos_estoque.ver`), `POST` (`.criar`), `PUT`
     (`.editar`, com a versão) e `DELETE` (`.excluir`, exclusão lógica), todos com `travaVersao` e auditoria
     (`tipos_estoque`, "Estoque › Tipo de Estoque"); o `GET` da lista continua aberto a qualquer usuário autenticado
     (os seletores do acerto e dos saldos) e passou a trazer `chaveSistema` e `versao`. **Regras**: nome único sem
     diferença de maiúsculas (409 no campo `nome`); **exatamente um padrão**, sempre vendável e ativo (o zod recusa o
     padrão não vendável ou inativo, 422); o padrão não se desmarca (422 no campo `padrao`: "marque Padrão em outro
     tipo"), e marcar outro tipo como padrão (no `POST` ou no `PUT`) tira a marca do anterior **na mesma transação**,
     antes de gravar o novo (o `uq_tipos_estoque_padrao` admite um só; a `fn_trava_versao` serializa duas trocas), com
     a auditoria nos dois tipos; os **tipos do sistema** (`chave_sistema`) não se excluem; o `vendavel` fica **travado**
     em dois deles — o Disponível vendável e o Vasilhame vazio não vendável (os cascos devolvidos, PDV 10.12, que por
     isso nunca pode ser o padrão: a tela desabilita o "Padrão" nele) —, e o **Vasilhame vazio não se inativa** (o
     handler da venda e o da devolução de cascos exigem o tipo ativo, `lerCadastrosEstoque`; inativo, o evento iria para
     erro); Avaria, Vencido e Uso e consumo são livres. A trava do Disponível é uma **escolha conservadora**: as vendas
     do caixa, o cancelamento e o acerto sem tipo baixam do tipo **padrão**, qualquer que seja
     (`lerCadastrosEstoque` › `tipoEstoquePadraoId`, `resolverTipoEstoque`), e nenhum código procura a chave
     `disponivel`; o Disponível é o padrão de fábrica e pode voltar a sê-lo a qualquer momento, e o padrão é sempre
     vendável. **Inativar** exige saldo zero em todos os estoques (`saldos_estoque.quantidade <> 0` em qualquer linha
     do tipo, 422 no campo `ativo`) e nenhum acerto em rascunho no tipo (422 no campo `ativo`, "efetive ou exclua o
     rascunho antes") nem recebimento em rascunho com o tipo de destino (F2-B14, decisão 159; 422 no campo `ativo`,
     "Há N recebimento(s) em rascunho neste tipo"): saldo esquecido num tipo inativo some dos seletores e o acerto novo não o aceita mais
     (`resolverTipoEstoque`). O rascunho só confere o tipo ao ser gravado, por isso a **efetivação e o estorno** do
     acerto também recusam o tipo inativo (`exigirTipoEstoqueAtivo`, 422 no campo `tipoEstoqueId`: troque o tipo do
     rascunho, ou reative o tipo antes de estornar); sem isso, o rascunho antigo ou o estorno de uma Saída que zerou o
     tipo devolviam saldo ao tipo inativo. **Tirar o `vendavel`** também exige saldo zero (422 no campo `vendavel`): a
     linha que sai do filtro do pull não ganha versão nem tombstone, e o PDV instalado não tem a ressincronização em
     sombra da SYNC 6.11 (o `ressincronizar_fluxo` só zera o cursor e baixa de novo, sem apagar o que não voltou;
     `ProcessadorComandos` do PDV), então a linha ficaria no espelho com a última quantidade e o saldo estimado do
     caixa a contaria para sempre. Zerado antes, o PDV recebe a linha com 0 enquanto o tipo ainda é vendável, e o que
     fica no espelho vale 0. Fica uma limitação: o PDV que estava offline enquanto o saldo foi zerado e o tipo deixou de
     ser vendável guarda a última quantidade recebida; a partir do PDV desta versão o saldo estimado ignora a linha
     cujo tipo está não vendável no espelho `tipos_estoque` (README do PDV, `SaldosEstimadosAsync`), e o PDV antigo só
     se corrige com a sombra da 6.11 (backlog). **Excluir** só o tipo da
     empresa que não é o padrão e nunca foi usado (sem movimento, acerto nem recebimento não excluído com ele, em
     qualquer situação: o rascunho ainda vai lançar e o movimentado/estornado é histórico); usado, só se inativa. **Tipo novo
     nasce não vendável** (o padrão do contrato; a coluna do banco continua `default true`, como no MD): quem cria
     "Quebra" não manda saldo para o caixa sem querer. **Ressincronização**: mudar o `vendavel` ou o padrão manda
     `ressincronizar_fluxo {fluxo: 'estoque'}` a **todos os terminais `ativo`/`desativando` de todas as lojas** na
     mesma transação (`ressincronizarFluxos(tx, 'todas', …)`, a generalização do `ressincronizarFluxosDaLoja`, que
     passou a chamá-la), porque o saldo que entra ou sai do filtro do pull (`saldoVendavelDoEstoque`: só tipos
     vendáveis) não ganha versão nova — o pull do cursor 0 põe no espelho o que entrou no filtro; o que saiu continua
     lá (daí a regra do saldo zero acima). O comando é idempotente: uma segunda mudança antes de o PDV buscar o primeiro não empilha
     outro. A troca do padrão também ressincroniza (as vendas futuras passam a baixar do tipo novo, e o plano pede o
     aviso ao caixa), mesmo sem mudar o conjunto de tipos vendáveis. O tipo criado vendável não ressincroniza (não tem
     saldo), nem a mudança de nome ou de `ativo`. A resposta do `POST`/`PUT` traz `terminaisRessincronizados` (a tela
     avisa quantos PDVs foram alcançados). O próprio `tipos_estoque` desce no fluxo `configuracao`, sem filtro, como
     antes: o PDV antigo recebe a linha nova e o comando que já conhece, sem schema nem versão de evento novos.
     Testes: `tipos-estoque.test.ts` (cada regra recusada com 409/422/403; o gerente cria "Quebra" não vendável sem
     comando; tirar o vendável com saldo recusado; zerado, um comando por terminal ativo das duas lojas, sem o
     revogado, e o pull do cursor 0 deixa de trazer a linha do tipo e volta a trazê-la quando ele volta a ser
     vendável; inativar com saldo ou com rascunho no tipo e excluir o usado recusados; a efetivação de rascunho e o
     estorno num tipo inativo recusados, e o estorno aceito depois de reativar; a troca do padrão com o histórico nos
     dois tipos; o padrão nunca usado não se exclui), `estoque.spec.ts` do shared, `TiposEstoque.test.tsx` do ERP e
     `VendaRealDadosTests` do PDV (o saldo estimado sem a linha de tipo não vendável).
153. **Mudança de tipo de estoque: o par `MUDANCA_TIPO_ESTOQUE` no acerto** (Fase 2, F2-B8; ERP 13.1.4, 13.5, 13.6;
     MD 3.7.3, 3.7.5; roadmap D55; migração `0021_acerto_mudanca_tipo`; `src/estoques/acertos.ts` › `efetivarAcerto`,
     `acertos.controller.ts`; `TIPOS_AJUSTE`, `tipoMovimentoAcerto` e `criarAcertoSchema` no shared `estoque.ts`). O
     **veículo** é o próprio acerto: novo `tipo_ajuste` `'mudanca_tipo'` ("Mudar tipo"), com o tipo de origem em
     `tipo_estoque_id` (vazio = o padrão, como nos demais) e o novo `tipo_estoque_destino_id` no cabeçalho. Um documento
     só, com rascunho, efetivação, estorno, auditoria, versão e a trava `travaVersao`, em vez de uma tabela nova: o
     estorno, a compensação do "Definir", a regra do saldo negativo e o lote já existiam aí. `tipo_ajuste` passou de
     `varchar(8)` para `varchar(12)` (só metadado no PostgreSQL); `ck_acertos_estoque_mudanca_tipo` exige o destino
     **só** na mudança de tipo e diferente da origem, e o zod e a API conferem o mesmo antes (422 no campo
     `tipoEstoqueDestinoId`: "Escolha o tipo de destino", "O tipo de destino só vale na mudança de tipo", "O tipo de
     destino tem de ser diferente do de origem" — a API compara depois de resolver o padrão —, e o destino inexistente
     ou inativo, como a origem). **Nenhum trigger mudou**, ao contrário do que o plano previa: o
     `tg_acertos_estoque_imutavel` compara a linha inteira fora do rascunho (já protege a coluna nova), e os triggers dos
     itens não olham o tipo de ajuste, salvo o da quantidade negativa (só no "Definir"; a mudança, como a Saída, só
     aceita > 0). **Efetivar**: cada item gera o par com o **mesmo `documento_item_id`**; as duas pernas não colidem em
     `uq_movimentos_estoque_idempotencia`, que tem o `tipo_estoque_id`, e a perna repetida colide (a segunda barreira,
     além do `for update` e da versão do acerto: a segunda efetivação recebe 409 ou 422). A **perna de saída**, na origem,
     é a Saída: custo médio da origem, regra do saldo negativo na linha e no lote (Master ou
     `estoque.permite_negativo_erp`; 422 no item, "Saldo insuficiente…") e, no item sem lote de produto com lote, a
     divisão FEFO (`estoque.lote_baixa_sem_informar`, D48). A **perna de entrada**, no destino, repete cada parte da
     saída com o **mesmo lote** e o **mesmo custo unitário** (um `lancarDocumento` com as partes): o custo total sai e
     entra igual (o valor do estoque a custo não muda) e o custo médio do destino é recalculado pela média ponderada de
     13.1.4. As duas pernas lançam no momento da efetivação (regra de data do F2-B4, como a Entrada e a Saída) e passam
     pela `compensarDefinir`, cada uma na sua linha. As linhas de saldo da origem e do destino de todos os itens são
     travadas antes do laço, juntas, em `ordenarChaves` (a do destino pode vir antes da da origem; as de lote vêm
     depois, no lançamento); hoje a 7300001 já serializa os documentos da empresa, e a ordem estável é a regra do motor
     sem ela. O item grava `saldo_anterior` da origem, `diferenca` com o sinal da perna de saída (−) e o `total_custo`
     dela. **Estornar**: `estornarAcerto` estorna cada movimento do documento (as duas pernas e as partes de cada lote)
     com o saldo negativo pelo efeito líquido de cada linha e de cada lote, mas o par é estornado pelo **par
     invertido**, também `MUDANCA_TIPO_ESTOQUE` com `estorno_de_id` (e não `ESTORNO_ACERTO`), com as duas pernas ao
     **mesmo custo unitário**. A regra de toda saída (estorno de entrada ao custo médio vigente) não servia aqui: a
     perna do destino sairia ao médio dele, já misturado com o da origem, e a da origem voltaria ao custo original, e a
     diferença `q × (médio do destino − custo da perna)` sumia (ou aparecia) do valor do estoque a custo num documento
     só interno — bastava o destino já ter saldo a outro custo (Disponível 20 a 2,50 e Avaria 5 a 4,00: o estorno
     deixava 66,25 de 70,00). Agora a perna do destino sai primeiro, **ao custo gravado na entrada**, com o custo médio
     refeito pela conta inversa da média ponderada, `cm' = (s × cm − |q| × c) / (s − |q|)`
     (`custoMedioAposSaidaAoCustoTexto` no shared; o modo `saidaAoCusto` de `aplicarMovimentoNoSaldo`), e a da origem
     entra (como estorno de saída, T20) **ao custo que de fato saiu do destino**, achada pelo mesmo item e lote. Sem nada
     no meio, origem e destino voltam ao custo médio de antes e o valor volta ao de antes; com outro movimento no destino
     no meio, o valor do estoque a custo continua igual, e o destino fica com o médio do que sobrou. Quando a conta
     inversa não vale (o destino sem saldo positivo, nada que sobre depois, ou o médio que ficaria ≤ 0: o destino
     vendido ou baixado no meio), a perna do destino é a saída comum, ao médio vigente, e a origem recebe esse mesmo
     custo (o médio da origem então não volta ao de antes, mas o valor não muda). O replay do razão reconhece o modo
     pelo próprio movimento gravado (`estornoDeMudancaTipo`: o tipo `MUDANCA_TIPO_ESTOQUE` com `estorno_de_id`;
     `movimentoGravadoNoSaldo` recebe o tipo), sem coluna nova nem linha de `tipos_movimento_estoque`: a saída comum
     gravada tem o custo igual ao médio vigente, e a conta inversa com `c = cm` devolve o próprio `cm`, então o
     `db:recalcular-saldos` repete os dois casos. Como o lançamento segue a ordem destino → origem, as linhas de saldo
     do acerto são travadas antes, na ordem estável. A efetivação e o estorno também exigem o destino
     ativo, e o tipo que é destino de um rascunho não se inativa nem se exclui (`tipos-estoque.controller.ts` ›
     `usaTipo`). **PDV**: nada muda — o saldo do tipo vendável que caiu desce no fluxo `estoque` como qualquer
     movimento, e o do tipo não vendável não desce (`saldoVendavelDoEstoque`). **Fica para depois**: o modal do Estoque
     Atual (ERP 13.6, 16.4; F2-B31) usa o mesmo veículo com a origem `relatorio_estoque` (`tipoMovimentoAcerto` já dá
     `MUDANCA_TIPO_ESTOQUE` em qualquer origem); `TROCA_PDV` e `BAIXA_INTERNA` são da Fase 3 (anotado para o
     fechamento, F2-B53). Testes: `mudanca-tipo.test.ts` (mover 5 de Disponível 20 a 2,50 para Avaria 5 a 4,00: o par a
     2,50, Avaria 10 a 3,25, valor do estoque igual, e o estorno pelo par invertido a 2,50, Avaria de volta a 5 a 4,00 e
     o valor de volta a 70,00; o estorno com uma entrada no destino no meio, e com o destino zerado no meio (a saída
     comum, a origem ao mesmo custo), o valor do estoque igual nos dois; o pull do PDV com o Disponível caindo e sem a
     Avaria; o lote em FEFO e o informado, e o estorno nos lotes; o saldo insuficiente, também no lote, sem permissão, e
     o Master passa; cada regra do cabeçalho, no zod, na API e no check do banco, a imutabilidade e o destino de rascunho
     que não se inativa; a efetivação e o estorno com o destino inativo, recusados em `tipoEstoqueDestinoId` e aceitos
     depois de reativar; mudanças opostas em paralelo; a efetivação em dobro e o índice; o razão refeito idêntico em
     cada teste), `estoque.spec.ts` e `estoque.propriedade.spec.ts` do shared (a conta inversa, a queda na saída comum e
     o replay de sequências com o estorno da mudança) e `Acertos.test.tsx` do ERP.
154. **Importar contagem, folha de contagem e divisão acima de 5.000 itens** (Fase 2, F2-B9; ERP 13.5, 13.1.5;
     F2-Q5 = roadmap D46, decidida pelo dono: a carga do Nuvem3 na virada e depois as contagens com a loja aberta;
     `src/estoques/contagem.ts`, `acertos.controller.ts`, `saldos.controller.ts` › `lotes`; `lerArquivoContagem`,
     `consolidarContagem`, `dividirEmRascunhos` e os contratos no shared `estoque.ts`; sem migração).
     **`POST /acertos/:id/importar-contagem`** (multipart: `arquivo` `.csv`/`.txt` até 5 MB e 200.000 linhas, e
     `modo`, `zerarNaoContados`, `itensExistentes` e `versao`; `estoque_acertos.criar`; 20 por minuto por usuário,
     `CONTAGEM_IMPORTACOES_POR_MINUTO`) só no **"Definir" em rascunho**: fora do rascunho é **409 `CONFLITO`**, outro
     tipo de ajuste 422 no campo `tipoAjuste` (a contagem é o "Definir"; Entrada pelo coletor fica para o recebimento),
     e o estoque fora dos permitidos é 404, como o acerto. O **parser** é puro, no shared: UTF-16 (com o BOM `FF FE`/
     `FE FF` do "Texto Unicode" do Excel, ou com cara de UTF-16), UTF-8 com ou sem BOM ou Windows-1252
     (`decodificarTexto` da importação; sem o UTF-16 o U+0000 entre os caracteres derrubava a consulta com 22021),
     `\r\n`/`\n`/`\r`, linhas vazias ignoradas, o cabeçalho ignorado só quando a primeira linha é o rótulo conhecido
     inteiro (`EAN`, `Código de barras`, `Cód. interno`, `SKU`…, sem acento e pontuação; `COD0001` e `ITEM10` são
     leitura) e mostrado na prévia (`cabecalho` e um aviso), o separador detectado nas primeiras linhas (`;`,
     tabulação, `|` e, por último, `,`), os campos com aspas (RFC 4180: `7891…,"1,5"` do Google Sheets é 1,5), as
     colunas além da segunda ignoradas (data e operador do coletor) e a linha só com o código valendo 1 (o coletor que
     grava uma linha por leitura). A quantidade aceita vírgula ou ponto decimal (um único sinal é a casa decimal; com
     os dois, o último), até 3 casas, ≥ 0 (o zero é contagem) e até `MAXIMO_QUANTIDADE_ACERTO` (999.999.999.999, o teto
     do contrato e da coluna `numeric(15,3)`: o EAN bipado no campo da quantidade é linha inválida, e não 500); com o
     separador vírgula, a linha com mais de dois campos fora das aspas é recusada em vez de ler "1,5" como 1. O único
     sinal seguido de exatamente 3 dígitos (`1.000`, `2,500`) continua casa decimal (o coletor que grava 3 casas), mas
     a prévia avisa as linhas (`milharAmbiguo`: pode ser o milhar `#.##0` do Excel em pt-BR, e a tela pede salvar sem
     ele). O código com caractere de controle é recusado. A linha inválida não para a leitura: volta na prévia, com o
     código quando ele é aproveitável (a quantidade ruim não apaga o código). A **resolução** do código procura no
     código de barras (exato, com o `fator` da embalagem: o fardo de 12 lido 2 vezes conta 24), no código interno do
     produto (fator 1, sem diferença de maiúsculas) e no da variação, casando os códigos lidos por índice (linear: o
     arquivo pode ter dezenas de milhares de códigos e a conta roda com o acerto travado). O produto cujo total (a soma
     × fator, ou a soma com o já gravado) passa do teto volta como problema `acima_do_maximo`; o 22003 que ainda
     sobrar, de uma conta derivada (o total do item em `numeric(15,2)`), o filtro de erros devolve como 422
     `VALIDACAO`. O código que casa com mais de um produto (o EAN duplicado
     entre produtos da migração do Nuvem3, `geral.ean_duplicado = 'avisar'`, ou o interno de um igual ao código de
     barras de outro) é **ambíguo e não grava**; combo, produzido, serviço e o produto sem controle de estoque são
     recusados como no acerto, e a variação e o "Com variações" contado no pai também (D43). As leituras do mesmo
     produto, por qualquer código, **somam** em unidades (decimal; só a soma é arredondada a 3 casas). A **prévia**
     (`modo=previa`, o padrão) não grava e devolve os itens (o lido, o que o rascunho já tinha e o que fica), os
     problemas por código com as linhas do arquivo e a quantidade lida, os totais e os avisos; a **gravação**
     (`modo=gravar`, com a `versao` do acerto: a versão velha é 409 `CONFLITO_VERSAO`) refaz a mesma conta com o mesmo
     arquivo (sem guardar o arquivo entre as duas chamadas: ele é pequeno, e o catálogo de agora é o que vale) e grava
     pela `gravarItensRascunho` do PUT (os totais do cabeçalho e as regras dos itens). A **contagem** é o grupo dos
     rascunhos "Definir" do mesmo estoque, tipo e `data_contagem` (o atual e os da divisão). O produto que **já é item**
     de algum deles tem a quantidade do arquivo **somada** à gravada (padrão: a contagem por setor com mais de um
     coletor; a prévia avisa) ou, com `itensExistentes=substituir`, trocada (a recontagem de um setor), **no rascunho em
     que ele está**: a prévia mostra o Nº (`outroAcerto`, `outrosAcertos`), a gravação trava os outros rascunhos do
     grupo (`for update`, em ordem de id; o deadlock com a importação simultânea no outro é repetido pela transação),
     regrava os alterados, troca o autor (a versão sobe) e audita `editar` em cada um. Assim a importação nunca deixa o
     mesmo produto em dois rascunhos da mesma hora (efetivados na mesma hora, o último venceria sem somar: a
     compensação só olha o que é posterior à contagem). O item que não está no arquivo fica como está. **"Zerar os não
     contados"** (desligada por padrão) acrescenta, com contado 0, os produtos com saldo ≠ 0 (inclusive negativo) no
     estoque × tipo do acerto que não estão no arquivo nem em algum rascunho do grupo, para o arquivo de um setor não
     zerar o que o outro rascunho já contou; o produto que o arquivo trouxe com a leitura recusada (os produtos do
     código ambíguo, o da linha inválida com código, o acima do máximo) também foi contado e não é zerado (a prévia
     avisa quantos, para corrigir o arquivo). **Divisão**: os itens novos enchem o rascunho até
     `LIMITE_ITENS_ACERTO` (5.000, o mesmo teto do contrato) e o resto vai para rascunhos novos, com o cabeçalho copiado
     (estoque, tipo, "Definir", a **mesma `data_contagem`**, motivo e responsável) e a observação "Continuação do acerto
     Nº …"; a prévia mostra quantos rascunhos e o aviso de efetivar todos. Os rascunhos de uma contagem são
     independentes: cada um é efetivado com a fórmula de 13.1.5 na mesma hora; a importação não põe o mesmo produto em
     dois deles (o lançamento à mão no PUT ainda pode, e aí o último efetivado vence: a efetivação não confere o
     grupo). Sem nada a gravar (nenhum item novo, alterado ou zerado: o arquivo só com problemas, mesmo num rascunho
     que já tem itens), 422 `REGRA_NEGOCIO`, sem regravar os itens nem mudar a versão. A auditoria registra `importar`
     no acerto (o arquivo e os totais), `criar` em cada rascunho novo e `editar` em cada outro rascunho alterado. **Folha de contagem** (`GET
     /acertos/folha-contagem`, `estoque_acertos.ver`, declarada antes de `:id`): os produtos com estoque próprio e
     controle de estoque (fora combo, produzido, serviço e "Com variações"), ativos ou inativos com saldo, do estoque ×
     tipo (vazio = o padrão), por localização (`produtos.localizacao`, a vazia por último) ou por nome, filtrados por
     marca e categoria (com as subcategorias), com o EAN da unidade e a localização; **cega por padrão** (sem o saldo;
     `cega=false` traz o saldo, como a coluna "Saldo atual" da grade, que a mesma permissão já mostra), até 20.000
     linhas (acima, 422: filtre por marca ou categoria). O ERP a imprime pelo navegador. **Lotes da grade**
     (`GET /saldos-estoque/lotes`, `estoque_acertos.ver`): os lotes do produto do estoque ou sem estoque, ativos (ou
     inativos com saldo), com o saldo do lote no estoque × tipo, em FEFO, para a coluna "Lote" do acerto (F2-B6).
     Testes: `contagem.test.ts` (o coletor de 300 linhas com fardos de 12 e caixas de 24 virando 1.420 e 180 unidades,
     a prévia sem gravar e a efetivação com o saldo contado; o ambíguo, o não encontrado, o combo, o "Com variações" e a
     linha inválida fora, com as linhas; 409, 422 e a versão velha; somar e substituir; "Zerar" com a Entrada antes da
     contagem; o "Zerar" que não zera os produtos do código ambíguo nem o da linha inválida, e o arquivo só com
     problemas num rascunho com itens em 422 sem mudar a versão; a quantidade acima do máximo na prévia, sem 500;
     6.000 itens em 2 rascunhos com a mesma hora, o "Zerar" que respeita o outro rascunho e a soma (e a troca) gravada
     no outro rascunho em que o produto está, sem abrir um terceiro; a folha cega, com saldo, por localização, por
     nome, por marca e por categoria com as subcategorias, com o saldo criado no próprio teste; os lotes; o razão
     idêntico no fim), `contagem.spec.ts` do shared (separadores, BOM, cabeçalho só com o rótulo inteiro, aspas,
     decimal com vírgula, o `1.000` ambíguo, o teto, o caractere de controle, linha só com o código, fator 12 e 24,
     problemas, acima do máximo, divisão e opções), `planilha.spec.ts` (UTF-16 com e sem BOM) e
     `filtro-erros.spec.ts` (22003).
155. **Compensações visíveis no acerto** (Fase 2, F2-B10; ERP 13.1.5 regra 4; SYNC 15.3; `src/estoques/
     compensacoes-acerto.ts`, `detalheAcerto` em `acertos.ts`; os contratos `CompensacaoAcerto` e
     `MOTIVOS_RELOGIO_COMPENSACAO` no shared `estoque.ts`; sem migração). O detalhe do acerto (`GET /api/acertos/:id` e a
     resposta de efetivar e estornar) ganhou `compensacoes` (até `LIMITE_COMPENSACOES_DETALHE`, 5.000, na ordem da hora
     do fato) e `totalCompensacoes`, vazios no rascunho (sem movimento, não consulta). Entra cada `ACERTO_COMPENSACAO`
     ligada ao acerto, nos dois sentidos: **`lancada`** (`documento_id` = ele: o fato anterior à contagem recebido depois
     da efetivação, ou o acerto lançado antes dela) e **`recebida`** (um movimento deste acerto, sem os estornos, que
     outro "Definir" de contagem posterior anulou, a mesma busca de `compensacoesDoDocumento`). Cada uma traz o "Definir"
     que a lançou, o produto e o lote, a quantidade com o sinal, o custo (só com `produtos.ver_custo`), a hora do fato
     (a data do movimento compensado), quando foi lançada, o **movimento compensado** (tipo com o nome do seed,
     quantidade e o documento de origem já rotulado, "Venda L01-C01-000012", "Acerto Nº 7", "Devolução de cascos"; o
     terminal como "Caixa 01 · PC do balcão", o evento, a sequência e o `criado_em` de `eventos_recebidos` como hora de
     chegada), o **estorno** que a desfez (o `ESTORNO_ACERTO` com `estorno_de_id` = ela: a data, o acerto estornado, o
     motivo gravado na observação e `substituidaPor`, a compensação viva do mesmo movimento que entrou no lugar dela: no
     estorno de um "Definir", o fato que outro "Definir" efetivado também contou é compensado de novo contra ele e
     continua anulado) e o **relógio** do evento. Na lacuna recuperada (SYNC 8.6) a linha de `eventos_recebidos` é a do
     placeholder, criada na declaração: `substituirPlaceholder` passa o `criado_em` para a hora do lote do evento real (a
     mesma `recebidoEm` do `alertarRelogioDoEvento`) e guarda a da declaração na auditoria `lacuna_substituida`
     (`antes.declarada_em`); as linhas substituídas antes desta versão continuam com a hora da declaração. O relógio é **reavaliado no evento**, e não lido do alerta:
     o `RELOGIO_SUSPEITO` aberto soma as ocorrências do terminal num registro só (guarda o primeiro e o último evento) e
     some com o "Ciente", então não diz se *esta* venda tinha a hora errada. Os motivos (`motivosRelogioDoEvento`):
     `nao_confiavel` (o envelope com `relogio_confiavel = false`), `futuro`, `passado` e `regressao` (as regras da SYNC
     12.4 pela mesma `suspeitasDoRelogio` que grava o alerta, com a chegada = `eventos_recebidos.criado_em`, a ativação do
     terminal e o evento anterior pela sequência, sem os placeholders de lacuna), `desvio` (o `desvio_relogio_ms` do
     envelope acima do crítico de 5 min, `DESVIO_RELOGIO_CRITICO_MS`, **só sem `relogio_confiavel = true`**) e
     `regressao_marcada` (a correção para trás marcada pelo caixa, esperada pela 12.3). Com a hora confiável o
     `ocorrido_em` já é o `agora_local + desvio` de uma amostra do boot atual (SYNC 12.2; o `desvio_relogio_ms` é o
     "desvio usado na correção", `HoraDoFato.Calcular` no PDV): o desvio grande diz que o relógio do Windows está fora e
     que a hora do fato foi corrigida, não que está errada, e destacá-lo marcaria toda compensação do PC com o relógio
     errado de forma estável, afogando os casos reais; ele fica só na dica. O desvio persistido reaplicado depois de um
     reboot já chega como `relogio_confiavel = false` (`nao_confiavel`). `relogioSuspeito` (o destaque da tela) é qualquer motivo menos a regressão
     marcada; o fato que não veio do PDV (o acerto anulado) vem com `relogio: null`. Uma consulta só, com o total por
     janela e os `lateral` do evento anterior e do estorno pelos índices existentes (`compensa_movimento_id`,
     `estorno_de_id`, `uq_eventos_recebidos_evento_id`, `uq_eventos_recebidos_terminal_sequencia`). Testes:
     `definir-offline.test.ts` (o cenário do F2-B4 com as vendas anteriores chegando depois da efetivação: as duas
     compensações com o terminal, a hora do fato, o documento, a sequência e a chegada, a segunda com o relógio sem
     hora confiável e 10 min de desvio destacada; o estorno em cada uma; o "Definir" anulado com a recebida e o que
     anulou com a lançada contra o acerto; o estoquista sem o custo; o relógio reavaliado pela consulta, com a
     regressão contra o evento anterior do mesmo caixa, a marcada sem destaque, 10 min de desvio com a hora confiável
     sem destaque, antes da ativação e no futuro; a venda da lacuna recuperada com a chegada do lote, e não a da
     declaração; o estorno do "Definir" mais novo com a substituta contra o anterior, e sem ela depois do estorno dos
     dois), `lacunas.test.ts` (o `criado_em` da linha substituída e o `declarada_em` da auditoria) e
     `compensacoes-acerto.spec.ts` (os motivos, a ordem, o desvio só sem a hora confiável e a regressão marcada que não
     destaca).
156. **Hora da contagem e CD na planilha, conferência do "Definir" com tolerância** (Fase 2, F2-B11; F2-Q5 = roadmap
     D46, decidida pelo dono; F2-Q6 = roadmap **D47, decidida pelo dono em 05/11/2026 (ajustável)**; ERP 8.6, 13.1.5 regras 6 e 8,
     13.5; SYNC 15.3; `src/importacao/importacao.ts`, `importacao/produtos.ts`, `conferenciaAcerto` em
     `src/estoques/acertos.ts`, `GET /acertos/:id/conferencia`; `opcoesImportacaoSchema` no shared `importacao.ts`,
     `avaliarConferencia` e os contratos no shared `conferencia.ts`, as chaves no `configuracoes.ts`; sem migração: as
     chaves têm padrão no catálogo e só ganham linha quando mudam). **Importação com "Atualizar estoque"**: o campo
     **`dataContagem`** (hora da contagem, a regra do `criarAcertoSchema`: válida e não futura, com a folga de 5 min) é
     obrigatório com ele, no lugar do `new Date()` da tarefa; o acerto "Definir" de origem `importacao`
     (AJUSTE_IMPORTACAO) grava essa `data_contagem` e lança nela com `retroativoPermitido` (decisão 148), e a efetivação
     desconta o que foi lançado depois (ERP 13.1.5 regra 2). A tarefa confirmada antes desta versão, sem o campo, usa a
     hora em que a tarefa foi criada (a confirmação, o que era o `new Date()` de antes). O campo **`estoqueId`**
     (opcional) escolhe o estoque que recebe a contagem, inclusive o **sem loja (o CD)**; vazio = o estoque da loja.
     Com o `estoqueId` e "Atualizar estoque" a **loja deixa de ser obrigatória** (o usuário do CD não precisa ter uma
     loja); sem eles, continua (`conferirLoja`), e as colunas de estoque mínimo e preço da loja sem loja são erro da
     linha. O estoque tem de existir, estar ativo e estar entre os **permitidos para movimentar** (decisão 149): fora
     deles, 403 no campo `estoqueId` (ou `atualizarEstoque`, o da loja), antes de ler a planilha, na prévia, na
     confirmação e de novo na tarefa; o `estoque.permite_negativo_erp` é lido na loja do estoque (o CD, na empresa). A
     **comparação** da prévia ("Estoque atual: X → Y") usa o saldo do estoque escolhido **na hora da contagem** (o
     de agora menos a soma dos movimentos com `data_movimento` posterior a ela, a mesma conta da efetivação): comparar
     com o de agora pulava como "sem alteração" o produto contado ontem cujo saldo, depois das vendas de hoje,
     coincidiu com a contagem, e o "Definir" não descontava essas vendas. O acerto só é gerado quando algum saldo muda,
     e então leva **todos os produtos contados** (`LinhaProduto.estoqueContado`), inclusive os iguais ao saldo e as
     linhas "sem alteração" do cadastro, com diferença zero e sem movimento: é o **item** do "Definir" que a
     compensação procura (`definirPosteriores`), e sem ele a venda offline anterior à contagem que chegasse depois
     baixaria o saldo contado do produto que conferia; a conferência também precisa da base inteira. O "Definir" de 0
     numa linha de saldo que não existe (o produto contado zerado que nunca movimentou) não a cria
     (`travarSaldoExistente`): saldo 0, diferença 0 e o item gravado, sem a linha zerada em `saldos_estoque`. Fica fora
     o produto **com variações** (o legado da D43, que segue importável): o saldo é por variação e o item sem ela seria
     recusado ("Escolha a variação"), derrubando a parte inteira; a análise tira o estoque atual dele da prévia, com o
     aviso "Estoque atual ignorado" quando difere do saldo, e o `acertoEstoque` o exclui de novo na consulta. Acima de
     `LIMITE_ITENS_ACERTO` (5.000) produtos, um acerto por parte (antes a tarefa cortava em 5.000 sem avisar), com a
     mesma hora, a observação "Continuação do acerto Nº …" e uma auditoria `efetivar` cada, **cada parte na sua
     transação** (`travaVersao` por parte): a 7300001 e as linhas de saldo travadas são soltas entre as partes, e o
     push dos PDVs e as gravações do ERP (o `lock_timeout` de 5 s, `SISTEMA_OCUPADO`) não esperam a planilha inteira
     (12 mil produtos do Nuvem3 em horário de venda prenderiam a trava de ponta a ponta); o pior caso de uma transação
     volta a ser o de antes, 5.000 itens. Cada parte é um acerto completo, estornável sozinho: a que falha não desfaz as
     anteriores, e a tarefa falha com "Estoque definido só em parte: acerto(s) Nº … efetivado(s); a parte n de N
     falhou (…)". `ResultadoImportacao.acertos` lista todos (`acertoId`/`acertoCodigo` = o primeiro, como antes). **Conferência**
     (`GET /acertos/:id/conferencia`, `estoque_acertos.ver`, o estoque visível; 404 fora dele): só do "Definir" (outro
     tipo de ajuste ou o estornado, 422 `REGRA_NEGOCIO`). Por item: o contado, o **saldo do sistema na hora da
     contagem** e a diferença, em quantidade, em % do saldo e a custo. Efetivado: `contado − diferença gravada −
     compensado`, onde `compensado` é a soma das `ACERTO_COMPENSACAO` lançadas por este "Definir" no item (sem as
     estornadas): cada uma é um fato anterior à contagem que chegou depois, e o sistema "na hora" já devia tê-lo (a
     venda offline de 2 anterior à contagem: o sistema tinha 48, não 50); o custo é o gravado no item. Rascunho:
     estimativa com o saldo de agora menos os movimentos posteriores à contagem e o custo médio da linha (sem ele, o
     preço de custo). O veredito (`avaliarConferencia`, pura e em decimal, ADR-05) é **Conferido** quando a soma dos
     **módulos** das diferenças a custo (a sobra de um item não paga a falta de outro; a diferença com sinal vem à
     parte) fica até `estoque.tolerancia_conferencia_total_pct` (padrão 1) do valor contado a custo (o módulo do
     contado, pela contagem negativa do Nuvem3) **e** nenhum item tem a diferença acima de
     `estoque.tolerancia_conferencia_item_pct` (padrão 5) do módulo do próprio saldo; no limite exato fica dentro, e a
     comparação usa o percentual **exato** (o texto de 2 casas é só para mostrar: 5,004% aparece "5.00" e fica fora). O
     item com saldo zero e diferença ≠ 0 não tem percentual (`null`) e fica fora; sem nada contado a custo, o total sem
     diferença é 0% e com diferença fica fora. As chaves são percentuais com sobreposição por loja (o CD usa a da
     empresa), e a consulta as troca só para ela (`toleranciaTotalPct`, `toleranciaItemPct`: 0 a 100, vírgula ou
     ponto). Os itens vêm com os fora primeiro, depois pela maior diferença em % e a custo. Sem `produtos.ver_custo`
     os valores a custo vêm `null` (o percentual e o veredito vêm sempre: o percentual do item não depende do custo).
     Fora daqui: a tela de reconciliação por setor (a aba é por acerto; a loja é conferida quando os acertos dos setores
     saem "Conferido", roteiro em `docs/implantacao/roteiro-inventario.md`). Testes: `definir-offline.test.ts` (o
     "Definir" do CD pela planilha com a hora de ontem, sem loja: a prévia com o saldo da hora da contagem, o produto
     igual com diferença zero, o AJUSTE_IMPORTACAO na hora da contagem, as saídas de hoje descontadas, a conferência
     com 338,00 contados, 22,00 de diferença, 6,51% e o item de 20% fora, e os limites da consulta no limite exato e um
     centésimo abaixo; a planilha da loja com a venda posterior descontada e a anterior, que chega depois, compensada e
     somada ao saldo do sistema; o rascunho estimativa, o item sem saldo, o limite da loja, o estoquista sem custo, o
     limite inválido, o estornado, a Entrada e o 404; o razão idêntico; acima de 5.000 produtos, 5.002 produtos por SQL
     no `acertoEstoque`: a parte 2 que falha pelo saldo negativo deixa a 1 efetivada com a mensagem, depois os 2 acertos
     com a mesma hora, 5.000 + 1 itens, a observação da parte 2 com o código da 1, uma auditoria cada, o `xmin` de
     cada um outro (transações separadas), sem linha de saldo nova para os contados com 0 e sem o produto com
     variações), `estoques-permitidos.test.ts` (o CD fora dos
     permitidos 403 no campo, o estoque sem "Atualizar estoque" que não dispensa a loja, a hora obrigatória e o
     estoquista só do CD com a prévia pelo saldo do CD na hora da contagem), `estoque-documento.test.ts` (o caminho da
     tarefa sob concorrência com a assinatura nova), as suítes de importação com a hora, `produtos.spec.ts` (o legado
     com variações sem o estoque atual na prévia), `conferencia.spec.ts` (logo acima do limite no item e no total, e o
     total sem percentual do setor contado vazio) e `importacao.spec.ts` do shared.

157. **Formulário do produto: "Ajustar", relacionados e categorias em árvore** (Fase 2, F2-B12; ERP 8.2.7, 8.2.8,
     8.2.11; `POST /produtos/:id/ajustar-estoque` em `src/produtos/produtos.controller.ts`, `ajustarEstoqueDefinir` (antes `ajustarEstoqueDoCadastro`; desde o F2-B31 também o do Estoque Atual, decisão 178)
     e `conferirCabecalhoAcerto` em `src/estoques/acertos.ts`, `gravarRelacionados` em `src/produtos/gravacao.ts`;
     `ajusteEstoqueProdutoSchema` no shared `estoque.ts`, `relacionadoSchema` no `produtos.ts`; sem migração:
     `produtos_relacionados` existe desde a 1A e já desce ao PDV no fluxo de catálogo). **"Ajustar"**
     (`estoque_acertos.criar`, a mesma do acerto da tela): cria e efetiva na mesma transação (`travaVersao`) um
     **"Definir" de um item** com a origem `cadastro_produto`, que lança `AJUSTE_CADASTRO` (`tipoMovimentoAcerto`). O
     corpo é o estoque, o tipo de estoque (vazio = o padrão), a **nova** quantidade contada (≥ 0, a regra do item do
     acerto), o motivo, as observações e a **hora da contagem** (opcional; sem ela, o momento da requisição, que é o
     que o ERP manda quando o usuário não mexe no campo, para não descontar da contagem as vendas feitas entre a
     abertura do modal e o clique): lança
     nela com `retroativoPermitido` e desconta os movimentos posteriores (decisão 148), com a compensação das vendas
     tardias (F2-B4) e a regra do saldo negativo do acerto (`estoque.permite_negativo_erp` da loja do estoque, ou
     Master). O cabeçalho passa pela mesma conferência da tela (`conferirCabecalhoAcerto`, que saiu do controller dos
     acertos para ser reaproveitada): o estoque **permitido para movimentar** (decisão 149; fora dele, 403 no campo
     `estoqueId`) e ativo, o tipo ativo e o responsável = o usuário. O produto sem saldo próprio é recusado antes, com
     a mensagem no topo do modal (422 `REGRA_NEGOCIO`): combo, serviço, **produzido** (a venda baixa os insumos da
     ficha técnica, decisão 91), "Com variações" (o saldo é por variação; o legado da D43) e o produto sem controle de
     estoque. A resposta traz o acerto (id e número, para o link) e a diferença lançada; a auditoria fica no acerto
     (`criar` com o corpo e `efetivar` com o resumo), com a localização "Produtos › Cadastro de produtos", e o acerto
     aparece na tela de acertos com a origem "Cadastro de produtos" (estornável por lá). **Relacionados** (8.2.8): a
     lista `relacionados` (até 50; produto, tipo `sugestao`/`substituto`/`acessorio`, ordem e `criarInversa`) grava
     com o produto, na mesma transação. **Ausente = mantém os gravados**: a importação de planilha (`entradaDoDetalhe`
     a omite) e o ERP de antes desta versão (aba aberta no deploy) não a mandam e não podem apagá-la; o formulário novo
     manda sempre a lista inteira (vazia = remove todos). A linha é identificada por (relacionado, tipo), a chave de
     `uq_produtos_relacionados`: a que saiu é excluída logicamente antes das inclusões (trocar o tipo = excluir e
     incluir), a que ficou só atualiza a ordem. O zod recusa o mesmo produto repetido com o mesmo tipo (com outro tipo
     é outra relação); a API, o próprio produto e o inexistente/excluído (422 no campo `relacionados.N.relacionadoId`).
     **"Criar relação inversa"** grava no outro produto a relação para este, do mesmo tipo, quando ela ainda não
     existe, com a ordem depois das dele e uma auditoria `editar` **no outro produto** ("Relação inversa (tipo) criada
     pelo cadastro do produto N - nome", `antes`/`depois` com as relações dele). Como altera o cadastro do outro
     produto (desce ao PDV, sobe a versão e o histórico dele), exige **`produtos.editar`** também no `POST /produtos`
     (`garantirCriarInversa`; sem ela, 403 `SEM_PERMISSAO` no campo `relacionados.N.criarInversa`, e quem só tem
     `produtos.criar` grava a relação só neste sentido). E não leva o outro produto além do teto
     (`MAXIMO_RELACIONADOS` = 50, o mesmo do zod da lista): o formulário manda a lista inteira, e um produto com 51
     não gravaria mais nem para mudar o preço; `validarNoBanco` conta as relações vivas do outro (a inversa que já
     existe não conta; duas linhas para o mesmo outro produto somam) e recusa com 422 no campo
     `relacionados.N.criarInversa` ("O produto N - nome já tem 50 produtos relacionados"), sem gravar nada. Remover daqui **não** remove a inversa
     (ERP 8.2.8: a relação não é automaticamente bidirecional; cada sentido é do seu produto). O detalhe traz
     `relacionados` com o `ProdutoOpcao` do outro e `inversa` (o outro já aponta para este com o mesmo tipo), só de
     produtos não excluídos; a versão agregada do cadastro (decisão 47) inclui `produtos_relacionados` do produto, e a
     relação inversa gravada por outro cadastro também muda a versão deste (o 409 é o certo: a lista dele mudou). A
     auditoria do produto tem `relacionados` no `antes` (o detalhe) e no `depois` (quando vieram). **Excluir o
     produto** tira as relações nos dois sentidos (as dele e as de outros para ele: o PDV não sugere um produto
     excluído). **Categorias em árvore**: só no ERP (README do ERP); a API continua com `categorias` +
     `categoriaPrincipalId` (decisão da Fase 1), e a "Nova categoria" do modal usa o `POST /categorias` (8.4, com
     `categorias.editar`). As decisões 70 ("Ajustar" rápido) e 74 (relacionados) deixam de ser pendências. Testes:
     `produto-formulario.test.ts` (o "Ajustar" da Loja 1 com o AJUSTE_CADASTRO no razão, o acerto de origem
     `cadastro_produto` efetivado, a diferença −3 do segundo ajuste e a linha de saldo no pull do fluxo `estoque` do
     PDV, a auditoria; a hora da contagem de 1 h atrás com a entrada posterior descontada; o produzido e o produto sem
     controle de estoque recusados sem gravar nada; o vendedor sem `estoque_acertos.criar` 403, o estoquista fora do CD
     403 no campo e o CD pelo admin; o contrato; a relação inversa com a auditoria do outro produto, o corpo sem
     `relacionados` que mantém, a troca de tipo e a remoção que não tiram a inversa; o próprio produto, o inexistente,
     o repetido e o mesmo produto com dois tipos; o teto da inversa (duas para o mesmo outro produto no corpo, a que já
     existe que não conta, o outro cheio, e ele com 50 gravando pelo formulário); a inversa sem `produtos.editar` 403
     no POST sem tocar no outro produto; a exclusão nos dois sentidos; o razão idêntico).

158. **Fornecedores no produto, cadastro rápido de fornecedor e busca pelo CNPJ normalizado** (Fase 2, F2-B13; ERP 3.4,
     8.2.14, 13.3; MD 3.6.9; D49 do roadmap; `gravarFornecedores` e `validarNoBanco` em `src/produtos/gravacao.ts`,
     `src/pessoas/fornecedores.ts` › `acharOuCriarFornecedorPorDocumento`, `POST /pessoas/fornecedor-rapido` em
     `src/pessoas/pessoas.controller.ts`; `fornecedorProdutoSchema` no shared `produtos.ts`,
     `cadastroRapidoFornecedorSchema` no `pessoas.ts`; migração `0022_produtos_fornecedores_custo`). **Vínculos**: a
     lista `fornecedores` (até 30; fornecedor, código no fornecedor = o `cProd` da NF-e, EAN do fornecedor, unidade de
     compra, fator > 0, custo do fornecedor, principal e `moverVinculo`) grava com o produto, na mesma transação, com a
     auditoria antes/depois do produto e a versão agregada (decisão 47) incluindo `produtos_fornecedores`. **Ausente =
     mantém os gravados**, como os relacionados: a importação de planilha (`entradaDoDetalhe` a omite), o ERP de antes
     desta versão e o formulário com o bloco escondido (`geral.produto_usa_fornecedores` desligada, o padrão do
     catálogo) não a mandam e não apagam o vínculo que a NF-e vai aprender (F2-B20/F2-B21). O código é gravado como
     veio, só sem os espaços das pontas (a vinculação da nota compara o texto exato, com maiúsculas); a unidade de
     compra em maiúsculas; o EAN com o DV conferido. O zod recusa o mesmo (fornecedor, código) duas vezes, o mesmo
     fornecedor sem código duas vezes (a linha ficaria sem chave) e mais de um principal; o mesmo fornecedor com códigos
     diferentes (CX 12 e CX 24) são dois vínculos. A API recusa (422 no campo `fornecedores.N.fornecedorId`) a pessoa
     inexistente ("Fornecedor inexistente: remova a linha") e, na linha nova ou que troca de pessoa, a pessoa excluída
     ("Fornecedor excluído: remova a linha") ou sem a categoria Fornecedor. **A linha gravada (o mesmo `id` com a mesma
     pessoa) continua gravável** se a pessoa perdeu a categoria ou foi **excluída** depois: excluir a pessoa (`DELETE
     /pessoas/:id`) não mexe nos vínculos dela, e o formulário, que manda a lista inteira, grava a mudança de preço sem
     obrigar a mexer no vínculo (a regra é uma só para a categoria perdida e a pessoa excluída; a revisão escolheu isso
     em vez de excluir os vínculos junto, que apagaria em silêncio o código que a NF-e usa, ou de recusar a exclusão da
     pessoa duplicada até alguém limpar cada produto). O detalhe marca a pessoa excluída em `fornecedor.excluida` (o
     bloco mostra o selo "excluído"), e o fornecedor do vínculo vem **sem o documento** (`cpfCnpj: null`,
     `opcoesPessoaPorId` › `semDocumento`): `GET /produtos/:id` exige só `produtos.ver`, e o CPF do produtor rural (PF)
     só sai pela API de pessoas, com `pessoas.ver` (minimização, LGPD; decisões 92 e 109). Os vínculos saem na ordem
     principal, inclusão e id (`criado_em` é o da transação, igual nas linhas gravadas juntas: o id desempata e a grade
     não troca as linhas de lugar depois do UPDATE de uma delas). Cada linha do corpo casa com uma gravada pelo `id` e,
     sem ele, pela chave (fornecedor, código): **a referência digitada de novo que já está neste produto é
     reaproveitada** (a mesma linha, sem conflito); as que não casaram saem por exclusão lógica antes das inclusões, e o
     código das que mudam de código é limpo antes (trocar os códigos entre duas linhas não colide em
     `uq_produtos_fornecedores_codigo`). **Conflito**: (fornecedor, código) já ligado a **outro** produto é 409
     `CONFLITO` ("O código X deste fornecedor já está ligado ao produto N - nome"), com o campo
     `fornecedores.N.codigoFornecedor` de cada linha em conflito e `detalhes` = `DetalhesConflitoFornecedor` do shared:
     o primeiro conflito (o da mensagem; `ConflitoVinculoFornecedor` com linha, fornecedor, código e o produto atual) e,
     em `conflitos`, todos eles na ordem das linhas; com `moverVinculo` o vínculo sai de lá (exclusão lógica, auditoria
     `editar` **no outro produto**, uma por produto: "Vínculo do fornecedor (código "X") movido para o produto N -
     nome", com `antes`/`depois` dos vínculos vivos dele, o `antes` com o que saiu) e entra neste. Mover altera o outro
     cadastro e exige **`produtos.editar`** também no `POST` (sem ela, 403 no campo `fornecedores.N.moverVinculo`, sem
     gravar nada), como a relação inversa do F2-B12. As linhas do outro produto ficam travadas (`for update`) durante a
     conferência; a corrida que escapar dela cai no índice único (23505 → 409). **Excluir o produto** passa a excluir os
     vínculos dele (o código fica livre para outro produto; não sobra vínculo vivo de produto excluído, então a
     conferência não trata esse caso). **Custos** (D49, decidida pelo dono): o **custo do fornecedor**
     (`custo_fornecedor`, coluna nova da 0022, `numeric(15,4)`, ≥ 0 pelo `ck_produtos_fornecedores_custos`, que também
     vale para `ultimo_custo`) é digitado no cadastro e fica **na unidade do produto**, a mesma de `preco_custo` e de
     `ultimo_custo`, para o ERP levá-lo ao preço de custo sem conta (o botão "Usar como preço de custo" do bloco só
     preenche o campo do formulário: a gravação segue as regras do preço de custo, com `produtos.ver_custo` e o
     histórico de preços). O recebimento e a NF-e não mexem nele: gravam `ultimo_custo` e `ultima_compra_em`
     (F2-B15/F2-B21), que o corpo nunca traz (somente leitura). Sem **`produtos.ver_custo`** o detalhe traz os dois
     custos nulos e a gravação ignora o custo do corpo (o gravado fica; a linha nova nasce sem custo). **Auditoria do
     produto**: o `depois.fornecedores` é relido do banco depois da gravação (`fornecedoresDoProduto`, no formato do
     `antes`, com custo, último custo e última compra), e não copiado do corpo: sem `produtos.ver_custo` o corpo traz o
     custo nulo que a gravação ignora, e o histórico mostraria um custo apagado (ou nascido) que não existiu. A linha
     com variação (legado; variações travadas pela D43) não é tocada. `produtos_fornecedores` não desce ao PDV (MD
     3.6.9, "—"): o `Esquema.g.cs` não muda. **Bloco no formulário**: `GET /produtos/tipos-habilitados` passa a levar
     `usaFornecedores` (`geral.produto_usa_fornecedores`), para o formulário não depender de `configuracoes.ver`; a API
     aceita a lista com a chave desligada (a chave é de exibição, ERP 8.2.14). A Ice Beer liga a chave junto da
     importação de NF-e por XML (PR-5; padrão aplicado do plano da Fase 2). **Cadastro rápido** (`POST
     /pessoas/fornecedor-rapido`, sempre 200 com `ResultadoFornecedorRapido`: a pessoa, `criada` e
     `categoriaAdicionada`): CNPJ ou CPF com ou sem máscara, nome, fantasia, IE, telefone num campo só (com o DDD) e o
     endereço opcional — **a UF só entra com o endereço completo** (`ck_pessoas_enderecos_completo`; o plano listava a
     UF solta, mas a pessoa não tem coluna de UF fora do endereço). `acharOuCriarFornecedorPorDocumento` acha a pessoa
     pelo documento **normalizado** (`normalizarCnpj`: sem a máscara, letras do CNPJ alfanumérico em maiúsculas) entre
     as não excluídas — a unicidade já é o `uq_pessoas_cpf_cnpj`, então não houve índice novo — e: já fornecedora,
     devolve como está (basta `pessoas.ver`); existe sem a categoria (um cliente), só ganha a categoria Fornecedor, sem
     mudar nome, IE nem endereço (exige `pessoas.editar` — desde a decisão 165, `pessoas.criar` ou `pessoas.criar_fornecedor` também bastam; auditoria `editar` da pessoa com as categorias antes/depois);
     não existe, cria como PJ (CNPJ) ou PF (CPF) com a categoria Fornecedor, a IE (só na PJ; "ISENTO" = indicador
     isento, outra = contribuinte), o telefone principal e a origem `erp` (exige `pessoas.criar`; a auditoria é a do
     `inserirPessoa`). A pessoa inativa é reaproveitada como está. Uma trava de transação pelo documento
     (`pg_advisory_xact_lock`) serializa duas chamadas com o mesmo CNPJ: a segunda acha a pessoa que a primeira criou
     (dois cliques no modal; duas notas do mesmo emitente num ZIP, F2-B19, que chama o serviço com a origem `nfe` e sem
     conferir `pessoas.*`, porque o emitente entra com a permissão de importar a nota). O perfil Estoquista do seed tinha
     `pessoas.ver`, mas não `pessoas.criar` nem `pessoas.editar` (reaproveitava fornecedores, sem o "+" do seletor); pela
     decisão do dono de 05/11/2026 ganhou `pessoas.criar_fornecedor` (só o cadastro rápido) e cadastra o fornecedor no recebimento (decisão 165), e depois também `pessoas.criar` (o cadastro completo, decisão 168). A decisão 74 deixa de
     listar os fornecedores como pendência. Testes: `fornecedores-produto.test.ts` (o critério de pronto: o fornecedor X
     com "CX24-ABC" e fator 24 e o mesmo CNPJ sem máscara que não duplica a pessoa; o cliente que vira fornecedor com a
     auditoria e o 403 do estoquista; criar sem `pessoas.criar`, documento, telefone e endereço inválidos, o CPF como
     PF; três chamadas simultâneas com o mesmo CNPJ e uma pessoa só; o produto com 2 fornecedores, a regravação sem
     linhas novas, a versão e a auditoria; o mesmo código no mesmo produto reaproveitado, o 409 no outro com o produto
     atual e todos os conflitos em `detalhes`, e o mover com a auditoria no outro (antes e depois com o vínculo que
     ficou); mover sem `produtos.editar` 403; a troca de códigos entre duas linhas; o corpo sem a lista que mantém, a
     lista vazia que remove e a exclusão que libera o código; o custo escondido e preservado sem `produtos.ver_custo`,
     com a auditoria do que ficou no banco; a categoria perdida (a linha gravada grava, a troca de pessoa e a linha nova
     não); a pessoa excluída (o detalhe a marca sem o documento, o produto grava com a lista inteira, a linha nova e a
     troca de pessoa são 422); a ordem estável depois de editar o código de uma linha; as recusas do zod e da API;
     `usaFornecedores` nos tipos habilitados) e `produtos.spec.ts` do shared (normalização da linha, recusas, chave, o
     teto de 30 vínculos e o cadastro rápido).

159. **Recebimento manual: schema, contratos e rascunho** (Fase 2, F2-B14; ERP 13.3; MD 3.8.1; D43, D45 e D6 do
     roadmap; `src/database/empresa/schema/entradas.ts`, migração `0023_recebimentos`, `src/entradas/recebimentos.ts` e
     `recebimentos.controller.ts`; contrato no shared `recebimentos.ts`). **Schema**: `recebimentos` (CP, AU; `codigo`
     de `seq_codigo_recebimentos`, criada antes da tabela na mesma migração; loja destinatária, estoque **e tipo de
     estoque** de destino — o tipo é coluna nova em relação ao MD de antes, para o casco vazio e a avaria entrarem no
     tipo certo sem um acerto depois —, fornecedor, `data_recebimento` = a data do documento, `codigo_remessa`, `tem_validade`,
     `qtd_itens` — também nova, para a listagem —, os valores de produtos/frete/desconto/outras/total, situação
     rascunho/movimentado/estornado com quem e quando movimentou e estornou e o motivo, e as colunas do financeiro
     **gravadas e sem uso até a Fase 4**: `gerar_financeiro`, plano de contas, forma de pagamento, `financeiro_parcelas`
     (jsonb) e `conta_financeira_id`, **sem FK** até `contas_financeiras` existir, como o `documento_fiscal_id` da
     transferência) e `itens_recebimento` (produto, `variacao_id` sempre nula enquanto as variações estão travadas —
     D43: o produto "Com variações" é recusado —, embalagem usada `codigo_barras_id`, unidade de compra, fator,
     quantidade na embalagem e `quantidade_estoque` = quantidade × fator, preço de compra por embalagem, markup e preço
     de venda propostos com `atualizar_preco` geral/loja/nao, lote/validade/fabricação digitados, `lote_id`, rateios,
     custo final e total). CHECKs do MD 3.8.1 e mais os de valores ≥ 0, a coerência situação × datas
     (`ck_recebimentos_movimentacao`, o padrão do acerto) e fabricação ≤ validade. **Imutável fora do rascunho**:
     `tg_recebimentos_imutavel` (`fn_protege_imutavel` com as colunas do estorno livres, como o acerto) e
     `tg_itens_recebimento_rascunho` (`DOCUMENTO_IMUTAVEL` em qualquer insert/update de item de documento que não está
     em rascunho; a movimentação do F2-B15 grava rateios, custo final e `lote_id` nos itens **antes** de mudar o
     status). Versão: `fn_versao_local` nas duas (não descem ao PDV; `Esquema.g.cs` em dia pelo
     `verificar:esquema-pdv`), autoria pelo `TABELAS_COM_AUTORIA`. **API** (`/api/recebimentos`): `GET` (filtros
     fornecedor, Id, Cód. remessa por "contém", estoque, loja, período pela data do documento e situação; ordenação
     por código, data, fornecedor, remessa, estoque, loja, total e situação) e `GET /:id`, com `recebimentos.ver`;
     `POST` com `recebimentos.criar`; `PUT` e `DELETE` (exclusão lógica do rascunho e dos itens, `?versao=` opcional)
     com `recebimentos.editar` — o catálogo não tem `recebimentos.excluir`, e quem edita o rascunho o descarta, como no
     acerto. O `PUT` confere a versão agregada do documento (cabeçalho e itens, inclusive os excluídos; decisão 47) e
     dá 409 `CONFLITO_VERSAO` com quem alterou; fora do rascunho, `PUT` e `DELETE` são 422 antes de o trigger chegar.
     A versão agregada é lida numa **segunda instrução, depois do `for update`** do cabeçalho: em READ COMMITTED quem
     esperou a trava relê só a linha travada, e a subconsulta dos itens na mesma instrução ficava no instantâneo de
     antes da espera — com a outra transação mexendo só nos itens (o cabeçalho mantém a versão, `fn_versao_local`), a
     versão velha passava e a gravação anterior se perdia sem 409. O `travar` do acerto tinha o mesmo desenho e foi
     corrigido junto (testes de concorrência com duas conexões em `recebimentos.test.ts` e `estoque.test.ts`).
     Itens: os mantidos (mesmo `id` e produto) são atualizados, os que saíram excluídos logicamente e os novos entram
     com a sequência depois da maior já usada; o mesmo `id` duas vezes no corpo é recusado pelo contrato (422 em
     `itens.<i>.id`, "Item repetido") — o produto pode repetir, o item não: seriam dois UPDATEs na mesma linha —, e a
     API, se chegar assim mesmo, grava a segunda como item novo. Os totais do cabeçalho são refeitos a cada gravação
     **a partir das linhas gravadas** (`count`/`sum` dos itens vivos com o frete, o desconto e as outras despesas do
     cabeçalho; cada item a 2 casas, total = produtos + frete + outras − desconto), e não do corpo: o total sempre fecha
     com os itens, a base do rateio do F2-B15. O contrato recusa o desconto que deixaria o total negativo e as contas
     que não cabem nas colunas — `quantidade × fator` em `numeric(15,3)` e `quantidade × preço` em `numeric(15,2)`, no
     campo `itens.<i>.quantidade`, e a soma do cabeçalho no campo `itens` —, em vez do 22003 genérico sem o item. Rateio,
     custo final e o lote em `produtos_lotes` ficam em 0/nulo no rascunho e são do núcleo de entrada (F2-B15).
     **Acesso** (decisão 149): a loja entre as lojas permitidas e o estoque entre os permitidos para movimentar,
     senão **403 no campo** (`lojaId`/`estoqueId`); vê-se só o recebimento de estoque visível (o de fora é 404 pelo id
     e some da listagem). **Alterar e excluir** exigem também a loja **já gravada** entre as permitidas (403
     `SEM_PERMISSAO`, antes de qualquer outra conferência): ver continua só pelo estoque (D45), e o rascunho de outra
     loja num estoque compartilhado (o CD) aparece na listagem e no detalhe, mas quem não tem a loja não o descarta nem
     o toma trocando a loja no `PUT` — o mesmo `PUT` mantendo a loja já daria 403 no campo. A loja destinatária e o estoque de destino são independentes (F2-Q3 = D6, respondida: o CD
     tem CNPJ próprio e a nota pode vir em nome de qualquer loja; o estoque é escolhido entre os permitidos; vazio = o
     vinculado à loja). **Cabeçalho**: tipo de estoque ativo (vazio = o padrão), fornecedor não excluído **com a
     categoria Fornecedor** (inativo só continua no rascunho que já o tinha), data **não futura no fuso da loja
     destinatária** (ERP 1.5, `lojas.fuso_horario`; vazia = hoje nesse fuso), e a fabricação dos itens pela mesma régua
     (422 em `itens.<i>.fabricacao`). Quem confere é a API (`conferirCabecalhoRecebimento`, `(now() at time zone
     l.fuso_horario)::date`): o contrato não sabe a loja e só valida a forma (a data vazia sai nula); com o fuso fixo
     de Brasília, Rio Branco às 22:30 gravava o dia seguinte e Noronha à 00:30 recusava o dia de hoje. A `hojeNoFuso`
     do shared fica para a tela sugerir o dia com o fuso da loja escolhida. Os filtros de período da listagem recusam a
     data impossível (30/02) com 422, em vez do 22008 do `::date` (500). **Itens**: produto com saldo próprio (combo, serviço e produzido recusados com a orientação de receber os
     componentes/insumos; "Com variações" recusado; sem controle de estoque recusado); a embalagem tem de ser do
     produto, marcada "usa na compra" e com o mesmo fator do item (a unidade de compra vem dela; sem embalagem e fator 1,
     a unidade do produto); "Tem prazo de validade" e o produto com `solicita_lote_pdv` exigem lote e validade, e
     validade/fabricação sem lote são recusadas (o lote é a chave de `produtos_lotes`); atualizar o preço exige o preço
     de venda (a permissão `produtos.alterar_preco` e a pergunta geral/loja/não são conferidas ao movimentar, F2-B15);
     até 990 itens (o teto da NF-e, para o núcleo comum). **Remessa repetida**: o detalhe (e a resposta do `POST`/`PUT`)
     traz `remessaRepetida` com os outros recebimentos não estornados do mesmo fornecedor com o mesmo código (sem
     diferenciar maiúsculas nem espaços nas pontas) e o texto em `avisos`; **só avisa**, não impede salvar (ERP 13.3; a
     remessa estornada pode entrar de novo). **Preços do documento**: preço de compra, totais e custo final do
     recebimento saem com `recebimentos.ver`, sem exigir `produtos.ver_custo` — são o conteúdo da nota do fornecedor que
     o estoquista digita (o perfil Estoquista do seed não tem `produtos.ver_custo`); o custo do produto (preço de custo e
     custo médio, nas opções de produto dos itens) continua só com `produtos.ver_custo`. As opções de produto do
     detalhe incluem o **produto excluído** (`opcoesPorId`): a exclusão do produto só olha o saldo, e o item do rascunho
     com um produto novo, ainda sem saldo, saía sem `produto`, fora do contrato; no rascunho ele pode ser tirado
     regravando sem ele. Fornecedor no detalhe sem o
     CPF/CNPJ quando falta `pessoas.ver`. **Auditoria**: `criar`, `editar` (antes/depois) e `excluir` na entidade
     `recebimentos`, com a loja destinatária. Testes: `recebimentos.test.ts` (o critério de pronto: 20 itens com fardos
     criado, editado e excluído com auditoria e o 409 da versão velha; a remessa repetida nos dois sentidos, de outro
     fornecedor e estornada; as validações de fornecedor, combo, embalagem, desconto, data e lote; a API e o trigger fora
     do rascunho, com as colunas do estorno livres e os CHECKs; 403 na loja e no estoque, 404 e listagem sem o CD para o
     restrito; filtros e ordenação, cada um com o registro esperado criado no próprio teste; 403 sem `recebimentos.*`,
     e com só `recebimentos.ver` 403 no `POST`, no `PUT` e no `DELETE`; o rascunho de outra loja no CD visível mas sem
     excluir nem trocar a loja; o item repetido e os totais pelas linhas gravadas; "hoje" e "não futura" no fuso da
     loja, Kiritimati × Pago Pago; o produto excluído no detalhe; as travas do tipo de estoque com recebimento; o 409
     depois da espera pela trava), `migracao-recebimentos.test.ts` (empresa nova e empresa
     existente na 0022 com cadastro e acerto terminam com a mesma estrutura; o primeiro recebimento da existente é o Nº
     1) e `recebimentos.spec.ts` do shared (normalização, padrões, recusas — inclusive o `id` repetido, as contas que
     não cabem nas colunas e a data impossível no filtro — e as contas do rascunho).

160. **Núcleo de entrada de mercadoria: movimentar e estornar o recebimento, e a origem do histórico de preços** (Fase 2,
     F2-B15; ERP 13.3; MD 3.6.9, 3.6.10, 3.7.3, 3.8.1; D49 e D56 do roadmap; `src/entradas/entrada.ts` — o núcleo comum
     com a NF-e do F2-B21 —, `movimentarRecebimento`/`estornarRecebimento` em `src/entradas/recebimentos.ts`, `POST
     /recebimentos/:id/movimentar` e `/estornar` em `recebimentos.controller.ts`; `ratearProporcionalTexto`,
     `contasEntradaRecebimentoTexto` e os contratos no shared `recebimentos.ts`; `linhasHistoricoPrecos` em
     `src/produtos/gravacao.ts`). **Sem migração nova**: o razão já aceitava `documento_tipo = 'recebimento'`, o seed já
     tinha `RECEB_MANUAL`/`ESTORNO_RECEB_MANUAL` e o `ck_produtos_historico_precos_origem` já aceitava as origens
     (conferido). **Movimentar** (`recebimentos.movimentar`, a loja gravada entre as permitidas e o estoque entre os
     permitidos para movimentar, como a edição; transação com `travaVersao`): o estoque e o tipo de destino continuam
     ativos (422 no campo), os itens são conferidos de novo (produto com saldo próprio e a embalagem com o mesmo fator:
     podem ter mudado depois do rascunho) e o rascunho sem item é 422. **Rateio** do frete, do desconto e das outras
     despesas pelo total de cada item (`valor_total`), cada um em decimal a 2 casas, com o resíduo dos arredondamentos
     no item de **maior valor** (o primeiro, no empate): o rateio fecha sempre com o cabeçalho. Quando o resíduo
     negativo deixaria esse item abaixo de zero (poucos centavos para muitos itens), os demais são **truncados** no
     centavo e o resíduo, então ≥ 0, fica com o maior — nenhuma parte negativa; sem valor nenhum (tudo a R$ 0,00), por
     partes iguais. **Custo final** = `(total + frete + outras − desconto) / quantidade_estoque`, a 4 casas, ≥ 0. O
     **lote** digitado é achado no produto (vivo, sem estoque ou do estoque de destino, o do estoque primeiro) ou
     criado com `estoque_id` nulo e o fornecedor do documento; a validade/fabricação vazias do lote existente são
     preenchidas, diferentes dão 422 no item (`itens.<i>.validade`), e o lote inativo volta a ativo. Um `RECEB_MANUAL`
     por item pelo `lancarDocumento`, com `data_movimento` = o início da movimentação (a "Data" do documento fica no
     cabeçalho, decisão 148), quantidade × fator, o custo final, o fator e a unidade de compra, o fornecedor em
     `pessoa_id`, o lote e a loja do estoque; o custo médio ponderado com o saldo anterior, `saldos_lote` e a última
     compra do saldo são do motor (decisão 151), e a `compensarDefinir` anula a entrada lançada antes de um "Definir"
     com a contagem um pouco à frente, como no acerto. **Preço de custo** (D49, decidida pelo dono):
     `estoque.compra_atualiza_preco_custo` (catálogo, padrão `perguntar`; `sempre`/`nunca`): com `perguntar`, o corpo
     traz `atualizarPrecoCusto`; sem resposta e com algum `preco_custo` diferente do custo da compra, **422** em
     `campos.atualizarPrecoCusto` com `detalhes.precosCusto` (produto, nome, o atual e o novo) e nada é lançado — a
     tela do F2-B16 pergunta e repete o movimentar; com `sempre`/`nunca` a resposta do corpo não vale. **Só quem tem
     `produtos.ver_custo` decide**: sem ela (o Estoquista do seed) não há pergunta e a resposta do corpo não vale — o
     preço de custo fica, como o formulário do produto descarta o `precoCusto` de quem não vê o custo e o acerto
     ignora o custo digitado (decisão 99); o `sempre` é decisão do dono pela chave e vale para todos (a revisão do
     F2-B15 tirou a pergunta "às cegas", com o atual e o novo nulos, que deixava sobrescrever o preço de custo manual
     sem vê-lo, contra a D49). O custo levado é o do **último item** do produto no documento (o mesmo do
     `ultimo_custo_compra` do saldo). **Fornecedor**: em todos os vínculos vivos do fornecedor com o produto (sem variação), `ultimo_custo` e
     `ultima_compra_em` pela **data do documento**, sem voltar para trás (o recebimento mais antigo movimentado depois
     não troca o último custo); a unidade e o fator da compra só no vínculo **sem código** (o com código é o que a NF-e
     aprendeu do `cProd`, com a embalagem dela); sem vínculo, cria um sem código (principal se o produto não tem
     outro). **Preço de venda** por item (`atualizar_preco`): `geral` (`produtos.preco_venda`) ou `loja`
     (`produtos_lojas` da loja destinatária, criada se faltava; desce no `catalogo`); o último item de cada produto com
     cada escolha vale. Com "Altera Preço do Produto no ERP" desligada, quem não tem `produtos.alterar_preco` recebe
     **403** no item que muda o preço (o mesmo preço não é alteração), como no formulário. A loja sem preço próprio
     (sem linha em `produtos_lojas` ou com `preco_venda` nulo, MD 3.6.9) **segue o geral**: o "só da loja" igual ao
     preço geral que vale depois do documento não cria nem preenche a linha nem entra no histórico (fixaria na loja um
     preço que deixa de acompanhar o geral, sem a permissão); com a permissão e o geral mudando no mesmo documento, o
     "só da loja" diferente do geral novo fixa o preço próprio. O `markup_pct` do produto é
     refeito pelo preço de custo e de venda novos (o teto do combo, 0005). As gravações de vários produtos (`produtos`,
     `produtos_lojas`, histórico, vínculos, itens) vão em **comandos de até 500 linhas** (SYNC 6.13) **na mesma
     transação** do documento: o recebimento é atômico (até 990 itens) — o plano falava em blocos de 500, e a revisão
     preferiu o bloco por comando a quebrar o documento em transações. Rateios, custo final e `lote_id` são gravados
     nos itens **antes** de o cabeçalho passar a `movimentado` (o trigger só libera os itens em rascunho). **Idempotente**:
     o recebimento já movimentado devolve o detalhe (200) sem lançar nada nem conferir a versão — o clique repetido, a
     resposta perdida e duas chamadas juntas (a trava do cabeçalho serializa; a segunda relê `movimentado`) não dobram
     a entrada; o estornado é 422. Auditoria `movimentar` com o resumo (itens, movimentos, lotes criados, preços,
     vínculos criados, compensações). **Estornar** (`recebimentos.estornar`, motivo obrigatório): um
     `ESTORNO_RECEB_MANUAL` de cada `RECEB_MANUAL` ainda não estornado, no mesmo lote, ao custo médio vigente (a saída
     comum, ERP 13.1.4), e um **`ESTORNO_ACERTO`** de cada compensação que um "Definir" lançou contra ele (como o
     estorno do acerto, decisão 148), no item e no lote da entrada: a compensação é uma saída e o estorno dela, uma
     entrada, e o catálogo (MD 7.3) define `ESTORNO_RECEB_MANUAL`/`ESTORNO_RECEB_NFE` com `sinal = -1` (só saída) e
     `ESTORNO_ACERTO` com `sinal = 0` — a revisão trocou o `ESTORNO_RECEB_*` positivo que saía antes; o efeito
     líquido de cada linha de saldo e de cada lote é conferido com as linhas travadas na ordem estável: com saldo
     insuficiente (a mercadoria já vendida), **422** com os produtos, salvo Master ou
     `estoque.permite_negativo_erp` da loja do estoque — D56, **decidida pelo dono em 05/11/2026, com aviso**: com a
     permissão, o negativo pede a confirmação (decisão 165). O estorno **não desfaz** preço, preço de custo, vínculo com
     o fornecedor, lote nem a última compra: são o registro da compra lançada. Auditoria `estornar` com o motivo.
     **Origem do histórico de preços** (MD 3.6.10): `registrarHistoricoPrecos` passa a receber a origem
     (`OrigemHistoricoPreco` do shared: `cadastro`, `importacao`, `cadastro_massa`, `recebimento`, `nota_entrada`,
     `api`); o formulário passa `cadastro` e a **importação de planilha `importacao`** (antes as cargas do Nuvem3
     apareciam como alteração no cadastro); o recebimento grava `recebimento` com o id do documento em `origem_id`. O
     custo do combo recalculado pelo banco (0005) entra com a origem da transação (`genesis.origem_preco`, decisão 97):
     o recebimento a define como `recebimento`. A lista das origens é `ORIGENS_HISTORICO_PRECO` do shared e o
     `ck_produtos_historico_precos_origem` continua escrito à mão (mudar a expressão geraria migração);
     `src/produtos/historico-precos.spec.ts` confere os dois conjuntos (origem nova vai nos dois, com a migração).
     Testes: `recebimento-movimentar.test.ts` (o critério de pronto: 10 FD ×
     12 a R$ 60,00 com R$ 12,00 de frete = +120 a R$ 5,10, o custo médio 4,88 com 30 a R$ 4,00 antes, a última compra
     do saldo e do vínculo, o preço de custo e de venda com o histórico `recebimento`, a pergunta do preço de custo, o
     movimentar repetido e simultâneo sem lançar de novo, o estorno que desfaz o estoque e não o preço; o lote com
     validade criado sem estoque, reaproveitado e com a validade divergente recusada, o `saldos_lote` e o estorno no
     mesmo lote; o preço da loja no pull do `catalogo`; o custo do combo no histórico; `sempre`/`nunca`; o 403 do
     preço sem `produtos.alterar_preco`, com o mesmo preço no geral e no "só da loja" sem preço próprio aceito sem
     criar a linha da loja; o 'perguntar' sem `produtos.ver_custo`; o "Definir" com a contagem à frente que anula a
     entrada e o estorno líquido das duas pernas, com `ESTORNO_ACERTO` na compensação e nenhum movimento contra o sinal
     do catálogo; o estorno depois da venda do PDV, 422 sem Master, na linha e no lote vendido em FEFO; o lote inativo
     que volta a ativo; o vínculo com o fornecedor com a compra mais antiga movimentada depois e o vínculo com código
     que não muda unidade e fator; as permissões; e o razão refeito idêntico, `conferirRazaoDoBanco`),
     `importacao-dashboard.test.ts` (o histórico da importação com a origem `importacao`), `historico-precos.spec.ts`
     e `recebimentos.spec.ts` do shared (o rateio fecha com o total em 1.000 casos aleatórios, sem parte negativa e a
     menos de 1 centavo da conta exata fora do maior, com o gerador de casos de `gerador.teste.ts`, o mesmo do
     `estoque.propriedade.spec.ts`; o critério de R$ 5,10; os contratos). Os blocos de 500 linhas são um só lugar
     (`emBlocos`/`LINHAS_POR_BLOCO_ENTRADA` de `entrada.ts`, também nos itens do recebimento).
161. **Recebimento manual: dados de compra da tela e a base do markup** (Fase 2, F2-B16; ERP 13.3; D49 do roadmap;
     `dadosCompraProdutos` em `src/entradas/recebimentos.ts`, `GET /recebimentos/dados-produtos` em
     `recebimentos.controller.ts`; `consultaDadosCompraSchema`, `DadosCompraProdutos`, `baseMarkupRecebimentoTexto` e
     `markupPrecoRecebimento` no shared `recebimentos.ts`; `CHAVE_CUSTO_BASE_MARGEM` no shared `precos.ts`). As telas
     são do ERP (README do ERP › decisão 56); a API só ganhou a leitura que a grade precisa, **sem migração**.
     `GET /recebimentos/dados-produtos?produtoIds=&estoqueId=&tipoEstoqueId=&lojaId=` (`recebimentos.ver`; até 200 ids,
     `LIMITE_PRODUTOS_DADOS_COMPRA`, como o `/saldos-estoque/itens` — o recebimento aceita 990 itens, e a tela consulta
     em blocos de 100, para a URL ficar abaixo de 4 KB, e junta; declarado antes de `:id`, que o Nest casaria primeiro)
     devolve, por produto não excluído:
     as **embalagens de compra** (`produtos_codigos_barras` vivos com "Usa na compra" e sem variação, com o código, a
     descrição, a unidade e o fator — a tela acha pelo código lido a embalagem do fardo e preenche o fator, que a
     gravação continua conferindo, decisão 159), `solicitaLotePdv` e `temLotes` (lote ativo sem estoque ou do estoque de
     destino: a grade mostra Lote e Validade), o **saldo** no estoque × tipo de destino (o tipo padrão quando vazio; zero
     sem linha; `null` sem estoque ou com o estoque fora dos visíveis, para não revelar o saldo de outro estoque) e o
     **custo médio** desse saldo (só com `produtos.ver_custo`), o **preço de venda próprio da loja destinatária**
     (`precoVendaLoja`, de `produtos_lojas`; `null` = a loja segue o geral, ou sem `lojaId`) — o "preço atual" da tela:
     a proposta do item e a referência da pergunta geral/loja/não são o preço que a loja pratica, como o movimentar
     compara o "só da loja" (decisão 160), e não o geral, que na loja com preço próprio não vale —; e as chaves
     `produtos.custo_base_margem` e
     `estoque.compra_atualiza_preco_custo` (a tela as lê sem `configuracoes.ver`). **Chave nova**
     `produtos.custo_base_margem` (D49, decidida pelo dono: "a margem e o preço sugerido podem usar o preço de custo, o
     custo médio ou o último custo"; catálogo, da empresa, padrão `preco_custo`; opções `preco_custo`, `custo_medio`,
     `ultimo_custo`). A **base do markup** do item, decidida aqui (`baseMarkupRecebimentoTexto`, a mesma conta na tela e
     no teste): `ultimo_custo` = o custo final do item nesta compra; `preco_custo` = o preço de custo que o produto terá
     **depois** da compra — o custo final, que a movimentação leva ao preço de custo (`sempre`, ou `perguntar` com o
     "Sim"), salvo `estoque.compra_atualiza_preco_custo = 'nunca'`, em que fica o preço de custo atual; `custo_medio` =
     o custo médio do estoque de destino depois da entrada (ponderado com o saldo, ERP 13.1.4). Sem o custo do produto
     (quem não tem `produtos.ver_custo`), a base é o custo final da compra — o documento é visível com
     `recebimentos.ver` (decisão 159), o custo do cadastro não, e o markup da tela não pode revelá-lo. O markup ⇄ preço
     (`markupPrecoRecebimento`): vale o último digitado — o markup digitado refaz o preço (2 casas) e o preço digitado
     refaz o markup (4 casas; sem markup sobre a base zero); o `markup_pct` gravado no item é o desse cálculo, e a
     movimentação refaz o `markup_pct` do produto pelo preço de custo e de venda novos (decisão 160), sem depender
     dele. Como o `markup_pct` do item é sobre a base de quem gravou (o custo médio, ou o preço de custo com `nunca`),
     junto com o preço de venda ele revelaria essa base: o **detalhe do recebimento devolve `markupPct: null` sem
     `produtos.ver_custo`** (a tela mostra "—"; a base em vigor quando o item foi gravado não fica registrada, então a
     máscara vale para todas). O **cadastro rápido de produto** do formulário (`CadastroRapidoProduto`) usa o
     `POST /produtos` de sempre
     (`produtos.criar`, a mesma validação e auditoria do formulário completo, o EAN repetido conforme
     `geral.ean_duplicado`): um Simples ativo, com controle de estoque e a **tributação vazia** — a "tributação padrão"
     da Fase 2, sem nada fiscal (não há chave de tributação padrão; os campos fiscais só entram gravados no F2-B52). O
     corpo sai de `corpoProdutoRapido` do shared, a mesma função que o modal e o teste de integração usam.
     Testes: `recebimento-movimentar.test.ts` (as embalagens só de compra, o saldo e o custo médio no destino, sem
     custo para o Estoquista, sem saldo sem o estoque e fora dos visíveis, `temLotes`, a chave lida, o preço próprio da
     loja, 422 com a lista vazia ou inválida; o `markupPct` do item nulo para o Estoquista; e o critério de pronto pela
     API: o produto novo pelo corpo de `corpoProdutoRapido`, o fardo achado pelo código, o item do fardo com o markup de
     50% e o preço pelas mesmas contas do shared que a grade usa — `contasEntradaRecebimentoTexto`,
     `baseMarkupRecebimentoTexto` e `markupPrecoRecebimento`; o item em si é montado à mão, porque o `itemParaApi` da
     tela é do ERP —, o recebimento sem nota com frete movimentado com a pergunta do preço de custo, +120 e +24 no
     saldo, o preço novo e o produto novo no `/sync/pull` do `catalogo` e o saldo no `estoque` do PDV de teste, e o
     razão refeito idêntico), `recebimentos.spec.ts` e `configuracoes.spec.ts` do shared (as três bases, sem o custo do
     produto, o markup ⇄ preço, a chave, a consulta com a loja e o teto de ids) e `produtos.spec.ts` (o corpo do
     cadastro rápido válido no contrato). O e2e do ERP, o único que manda o item montado pela tela à API real, não roda
     no CI (README do ERP, "e2e no CI").
162. **Bloco Validade do produto: lotes no cadastro e o saldo de cada lote** (Fase 2, F2-B17; ERP 8.2.12; MD 3.6.9,
     3.7.4; D48 e D57 do roadmap; `gravarLotes` em `src/produtos/gravacao.ts`, `lotesDoProduto` em `consultas.ts`,
     `GET /produtos/:id/saldos` › `lotes` em `produtos.controller.ts`; `loteProdutoSchema`, `chaveLoteProduto`,
     `MAXIMO_LOTES_PRODUTO`, `TIPOS_SEM_SALDO_PROPRIO`, `LoteProdutoDetalhe` e `SaldosProduto.lotes` no shared
     `produtos.ts`; `dataCampo` e `dataOpcionalValida` passaram de `recebimentos.ts` para `campos.ts`), **sem migração**
     (o trigger `tg_produtos_lotes_filtro_imutavel` já impedia mudar o `estoque_id`, e a 0020 o produto e a variação).
     O corpo do produto ganhou **`lotes`, só os lotes novos e os alterados** (a linha com `id` altera o gravado; a sem
     `id` é nova ou, com a (loja, texto) de um gravado, reaproveita-o), e **`lotesExcluidos`**, os ids a excluir: **o
     lote gravado que não vem fica como está**, e as duas listas ausentes não mudam nada (a importação de planilha e o
     ERP antigo não as conhecem, e os lotes que o recebimento cria não podem sumir). O teto de 200
     (`MAXIMO_LOTES_PRODUTO`) vale para cada lista, ou seja, para o que muda numa gravação: na primeira versão do bloco o
     formulário mandava a lista inteira e o teto valia para os lotes do produto, que só crescem (o recebimento cria um
     lote por texto novo, sem teto, e o lote com histórico não se exclui, D57) — o perecível com lote novo a cada
     entrega passava de 200 lotes em meses e nenhum "Gravar" do produto voltava a passar, nem uma troca de preço.
     Cada lote: `estoqueId` (o estoque vinculado da loja escolhida, `lojas.estoque_id`; `null` = todas as lojas),
     `lote` (texto(30), gravado como veio sem os espaços das pontas: o recebimento acha o lote pelo texto exato),
     validade e fabricação (datas que existem; a fabricação não passa da validade, `ck_produtos_lotes_datas`),
     fornecedor e ativo; no zod, um por (loja, texto) e um por `id` em `lotes`, o id alterado não vem também em
     `lotesExcluidos`, e **os tipos sem saldo próprio não têm lote** (`TIPOS_SEM_SALDO_PROPRIO`: combo, serviço,
     produzido — a venda baixa os insumos — e "Com variações" — o saldo é por variação, e o lote do bloco é da unidade
     —, a mesma lista do "Ajustar" e do recebimento; na primeira versão só combo e serviço). A gravação casa cada linha
     com uma gravada pelo `id` e, sem ele, pela chave (loja, texto) entre as que não vão ser excluídas, e recusa com 422
     por campo: **o estoque do lote gravado não muda** (`lotes.N.estoqueId`; trocar = excluir e criar outro, o trigger
     repete a regra como erro do banco), o lote novo só com o estoque de uma loja não excluída (o "Loja" da grade; o
     depósito antigo sem loja só aparece nos lotes que já tem), a linha que cairia na (loja, texto) de um gravado que
     não veio no corpo (`lotes.N.lote`, "já existe nesta loja": o zod só vê o corpo, e sem a regra seria o 23505 do
     índice único), o fornecedor como em `gravarFornecedores` (o novo, ou que troca de pessoa, exige a categoria e a
     pessoa não excluída; o gravado continua gravável) e, no campo `lotes`, **não se exclui lote com saldo** em
     `saldos_lote`, **com movimento** no razão ou **usado num acerto em rascunho**: inativa-se (o saldo é refeito pelo
     razão e o estorno volta ao lote do movimento, decisão 151, então o lote com histórico fica). Os excluídos saem por
     exclusão lógica antes das inclusões, o texto das que trocam de texto passa por um valor provisório (`~` + o id)
     para a troca entre duas linhas não colidir no índice único, e a linha igual à gravada não é regravada (cada
     `UPDATE` sobe a versão e desce de novo ao PDV; o fornecedor é comparado sem a caixa). Só os lotes da unidade (sem
     variação, o legado das variações não é tocado) e de estoque permitido ao usuário (decisão 149) ou sem estoque
     entram: o detalhe esconde os de outros estoques (`detalheProduto(…, estoquesVisiveis)`, como as lojas na decisão
     88), a gravação os preserva (o id deles em `lotesExcluidos` é ignorado, como o de um lote já excluído), e mandar
     um estoque fora dos permitidos é 403. O detalhe traz `lotes` na ordem FEFO (validade, sem validade por último,
     texto, id) com o nome da loja e do estoque (a grade mostra os dois), o fornecedor sem o documento e
     `temMovimento` (a tela tira o "Remover"); a auditoria do produto traz os lotes no `antes` e no `depois` (relidos
     do banco), e a versão agregada do cadastro passou a incluir `produtos_lotes` (o recebimento que cria um lote
     também sobe a versão, como o vínculo com o fornecedor). **Saldo de cada lote**, somente leitura:
     `GET /produtos/:id/saldos` devolve `lotes` (estoque, tipo, vendável e quantidade) das linhas ≠ 0 de `saldos_lote`
     dos estoques permitidos — o mesmo que desce ao PDV, que recebe só o tipo vendável do estoque da loja (fluxo
     `estoque`); o combo devolve a lista vazia. O `/auth/eu` ganhou `lojas[].estoqueId` (opcional no contrato), o
     estoque vinculado só quando está entre os estoques permitidos (liberar a loja não libera o estoque dela): é o
     "Loja" do bloco, sem o ERP depender de `estoques.ver`. A exclusão do produto (só sem saldo) exclui também os
     lotes. Desce ao PDV sem mudança no protocolo nem no espelho: `produtos_lotes` já ia no fluxo `catalogo` com o
     filtro `estoque_id is null or = E`, e o PDV antigo continua vendendo (o PDV ainda não pede o lote;
     `solicita_lote_pdv` só faz o recebimento exigir lote e validade até a Fase 3; enquanto isso a venda sem lote segue
     `estoque.lote_baixa_sem_informar`, D48, e a descrição da tela remete à chave). Testes: `produto-lotes.test.ts` (o
     critério de pronto: 2 recebimentos com validades diferentes, o saldo de cada lote no `/saldos` igual ao
     `saldos_lote` do pull do PDV e os dois lotes no `catalogo`, com o razão refeito idêntico; o filtro da loja no pull;
     a troca e a retirada do estoque 422; o estoque sem loja 422; o lote que não vem mantido; o lote com saldo e,
     zerado por um acerto, com movimento não excluídos; as listas ausentes e o id desconhecido mantêm; inativar e
     excluir o vazio; o acerto em rascunho; a troca de textos; o repetido; a colisão com um gravado que não veio; o
     fornecedor sem a categoria; a linha igual não regravada, com o fornecedor em maiúsculas — a `versao` dos lotes e o
     cursor não sobem —, e a linha sem id reaproveitando o gravado pela chave, sem exclusão; 205 lotes criados por um
     recebimento, a troca de preço, a inativação parcial e o teto do que muda; o restrito sem ver o lote nem o saldo de
     lote do outro estoque, sem apagá-lo, o `/auth/eu` e o 403) e `produtos.spec.ts` do shared (o schema do lote, as
     datas, o repetido, os tipos sem saldo próprio, o teto por gravação, o id repetido e o alterado e excluído).
163. **NF-e de fornecedor por XML: schema, parser seguro e validações** (Fase 2, F2-B18; ERP 13.4; MD 3.8.2;
     F2-Q3 = D6; F2-Q9 = roadmap **D50, decidida pelo dono em 05/11/2026: avisar**; migração `0024_notas_entrada`;
     `src/database/empresa/schema/entradas.ts`; `src/entradas/xml/{parser,assinatura,validacoes,zip}.ts`;
     `notas-entrada.ts` do shared; fixtures em `test/fixtures/nfe/`). **Sem SEFAZ, sem conversão de CFOP e sem nada
     fiscal** (restrição do dono): o bloco cria as tabelas e lê/valida o XML; o upload (F2-B19), a vinculação (F2-B20)
     e movimentar/estornar (F2-B21) vêm depois, sem migração nova. Nenhuma tabela desce ao PDV (`fn_versao_local`;
     o `Esquema.g.cs` não muda e o PDV instalado nem as vê).
     - **Tabelas** (MD 3.8.2): `notas_entrada` com o destino da nota como o recebimento (loja, estoque e **tipo de
       estoque**, que o MD não tinha), o fornecedor, a cópia do XML (emitente, `destinatario_cnpj`, totais do ICMSTot —
       com `valor_ipi_devolvido`, `valor_ii`, `valor_icms` e `valor_icms_desonerado`, para os totais gravados fecharem
       o vNF —, transporte, volumes, informações complementares), o **protocolo** (`protocolo_numero`, `_data`,
       `_status` 100/150) e a **assinatura** (`assinatura` = `valida`/`invalida`/`ausente`/`nao_conferida` e o
       detalhe); `origem` só `upload` (`ck_notas_entrada_origem`), `modelo` só 55, `dfe_documento_id` nulo e sem FK, o
       XML em `arquivos` (`xml_arquivo_id`, NOT NULL). `gerar_financeiro` nasce `false` (o MD dizia `true`): sem uso
       até a Fase 4, com o mesmo CHECK do recebimento. `itens_nota_entrada` guarda o `det` inteiro — cProd, cEAN e
       cEANTrib ("SEM GTIN" vira nulo), xProd, NCM, CEST, **o CFOP do XML**, uCom/qCom (4 casas)/vUnCom
       (`numeric(21,10)`), uTrib/qTrib/**vUnTrib** (10 casas), os valores, os impostos **só gravados** (ICMS,
       PIS/COFINS, IPI, ST, FCP-ST), infAdProd e o **`rastro` inteiro em jsonb** (até 500 lotes por item no layout; as
       colunas `lote`/`validade`/`fabricacao` vêm do primeiro e são editáveis) — e a vinculação do F2-B20 (produto,
       variação, **embalagem** `codigo_barras_id`, fator, quantidade no estoque, custo calculado, preço proposto,
       "Ignorar item" com motivo); **`cfop_entrada` fica nulo e reservado para a 3F/4**, e a nota não depende dele para
       ficar "Pronta". `notas_entrada_duplicatas` tem a `sequencia` como chave (no layout 4.00 nDup e dVenc são
       opcionais; o MD tinha `numero` e `vencimento` obrigatórios e o único por número).
     - **Imutabilidade**: o que veio do XML nunca muda, em situação nenhuma (`tg_notas_entrada_xml_imutavel` e
       `tg_itens_nota_entrada_xml_imutavel`: `fn_protege_imutavel` sem coluna de estado, com a lista do que é livre —
       destino, situação, movimentação, estorno, financeiro, exclusão; no item, a vinculação); depois de movimentada a
       nota só recebe o estorno (`tg_notas_entrada_imutavel`, abertas `pendente`, `pronta` e `ignorada`, que o
       "Reabrir" volta a pendente); **a estornada é o fim** (`tg_notas_entrada_estornada_final`: nada muda depois do
       estorno, nem a volta a `movimentada`, que o trigger anterior e o `ck_notas_entrada_movimentacao` deixavam passar
       e "desestornaria" a nota sem lançar de novo o `RECEB_NFE`), e a mesma regra vale desde a 0024 para o recebimento
       estornado (`tg_recebimentos_estornado_final`; a 0023 tinha a mesma brecha); itens e duplicatas só mudam com a nota pendente ou pronta
       (`fn_filhos_nota_entrada_aberta`) e as duplicatas são só a cópia do XML. **A chave é única entre as notas não
       excluídas, inclusive a ignorada** (`uq_notas_entrada_chave where excluido_em is null`; o MD excluía a ignorada,
       e a reaberta colidiria com a reimportada). A FK `fk_produtos_lojas_st_nota_entrada_id` que o MD 3.6.9 esperava
       entra na mesma migração (a coluna continua nula até o F2-B52; sem efeito no PDV, ela é omitida na descida).
     - **Parser seguro** (`lerXmlNfe`): teto de 1 MiB antes de decodificar (`LIMITES_XML_NFE.bytes`; a SEFAZ recusa
       NF-e acima de 500 KB), UTF-8 estrito (com ou sem BOM); **qualquer `<!DOCTYPE` ou `<!ENTITY` recusa o arquivo
       antes do parser** (XXE e "bilhão de risadas": a NF-e não tem DTD); `XMLValidator` (iterativo) para o
       malformado; `fast-xml-parser` com `processEntities: false`, `parseTagValue: false` (nada passa por `number`:
       os zeros à esquerda e as 10 casas ficam como vieram) e `maxNestedTags` 24; só as 5 entidades do XML e as
       referências numéricas são decodificadas, à mão. Os números são conferidos contra o formato do layout (inteiros
       e casas máximas; o que passa das casas é recusado, nunca arredondado) e completados até as casas da coluna;
       datas existem; textos respeitam o tamanho do layout; tetos de 990 itens, 120 duplicatas, 5.000 volumes e 500
       lotes por item; grupo repetido onde o layout tem um só (duas `infNFe`, dois `protNFe`, dois grupos de ICMS) e
       `nItem` repetido são recusados — a leitura nunca escolhe um deles. O resultado é a `NfeLida` do shared.
     - **Validações** (`validarNfe`, puras, e `lerEValidarXmlNfe`, com o contexto do banco: as lojas não excluídas,
       a nota viva com a mesma chave e a chave da assinatura). **Sempre recusa**, nesta ordem e com o motivo do shared
       (`MOTIVOS_RECUSA_NFE`): modelo ≠ 55 (a NFC-e); **nota de homologação** (tpAmb 2: sem valor fiscal, não estava
       no plano, decisão técnica deste bloco); sem `protNFe`, ou protocolo que não é de autorização (cStat 100/150,
       com o cStat e o xMotivo no detalhe); chave com DV errado (`validarChaveAcesso`), diferente da do protocolo, ou
       que **não confere com a própria nota** (cUF, AAMM do dhEmi, CNPJ/CPF do emitente, modelo, série, número,
       tpEmis, cNF e o cDV); destinatário que não é o CNPJ de uma loja da empresa — **qualquer loja, inclusive a do
       tipo depósito** (F2-Q3 = D6: o CD tem CNPJ próprio; a loja do CNPJ é o padrão da nota e o estoque de destino
       é escolhido entre os permitidos no upload); e a chave já importada (com a nota existente, para o link da
       ERP 13.4). O XSD não é validado na Fase 2. Os totais que não batem com a soma dos itens ou com a fórmula do
       vNF (regra 610 da SEFAZ, com e sem a dedução do ICMS desonerado da NT 2023.004) **só avisam**: a SEFAZ já recusa
       a nota que não fecha.
     - **Assinatura** (`conferirAssinaturaNfe`, `xml-crypto` sobre o texto já aceito pelo parser): a assinatura que
       vale é a **filha da `NFe`** (a `ds:Signature` opcional do `protNFe`, que o layout 4.00 prevê para a autorizadora
       assinar o protocolo, não conta, e a falta do namespace XMLDSig tem mensagem própria); a Reference tem de ser `#`
       + o Id do `infNFe`, há uma só assinatura na `NFe`, o DigestValue e o SignatureValue conferem com o certificado
       do próprio `KeyInfo`, e o resumo é o `digVal` do protocolo (a assinatura que a SEFAZ autorizou). Contra o
       "embrulho" da assinatura (o `xml-crypto` conferir um `infNFe` e o parser ler outro): o `infNFe` é achado no DOM
       pelo mesmo caminho do parser (`nfeProc/NFe/infNFe`) e o `Id` dele tem de ser, **sem aparar** e sem prefixo, o
       que o parser leu (o parser apara os valores, e `Id="NFe<chave> "` seria lido como a nota sem ser o assinado), e
       nenhum outro elemento pode ter um Id (`Id`/`ID`/`id`, como o `xml-crypto`) que, aparado, seja o da nota (o
       assinado escondido no `protNFe`, que o parser não lê). É **integridade**: sem SEFAZ e sem certificado na Fase 2, a
       cadeia ICP-Brasil, a validade do certificado e o CNPJ dele não são conferidos. Conforme
       `notas_entrada.assinatura_invalida` (chave nova do catálogo, grupo novo `notas_entrada` — o
       `REGEX_CHAVE_CONFIGURACAO` passou a aceitar `_` no grupo —, na aba Geral do ERP, bloco "NF-e de entrada"):
       `avisar` (padrão) deixa a nota entrar com o aviso `ASSINATURA_INVALIDA`/`ASSINATURA_AUSENTE` e quem importa
       (com `notas_entrada.importar`, em `criado_por_id`) confirma; `recusar` recusa; `nao_conferir` grava
       `nao_conferida`.
     - **ZIP** (`extrairXmlsDoZip`, para o upload em lote do F2-B19, que o teste de zip-bomba do plano pedia já aqui):
       o mesmo método contra zip-bomba da importação de planilha — o percurso comum `percorrerZip`
       (`src/comum/zip.ts`), que o `conferirZip` da planilha passou a usar: diretório central conferido antes, cada
       entrada descompactada de verdade com `maxOutputLength` igual ao tamanho declarado, sem ZIP64 nem criptografia —,
       com **limites próprios**: 1.000 entradas (a planilha, 100), 100 MiB descompactados no total (150 MiB), taxa ≤ 100
       conferida acima de 64 KiB (1 MiB) e cada XML até 1 MiB (120 MiB por entrada). O que não é `.xml` é pulado e o
       XML acima de 1 MiB é recusado sozinho (`grandesDemais`), sem derrubar o lote. Na planilha, o percurso comum
       passou a recusar também a entrada criptografada, a truncada e a que descompacta menos do que declara.
     - **Fixtures** (`test/fixtures/nfe/`, 8 XMLs `nfeProc` 4.00): ICMS-ST com caixa e fardo, FCP-ST, IPI com seguro,
       desconto, outras despesas, transportadora e volumes, embalagens CX/FD/PCT do Simples, qTrib ≠ qCom em KG com
       10 casas, produtor rural com CPF e "SEM GTIN" (e entidades `&amp;`/`&lt;` no texto), `rastro` com dois lotes e
       destinatário CD, e uma NFC-e para recusar. **São notas de teste montadas no layout, não notas reais
       anonimizadas** (nenhuma nota real do dono chegou ainda): empresas, CNPJs (DV calculado sobre bases de teste) e
       GTINs fictícios, assinadas com um certificado autoassinado gerado na hora pelo `gerar.ts` (que monta os totais
       com decimal); as notas reais do dono ficam em `test/fixtures/nfe/reais/` **só na máquina de quem testa** (a
       pasta está no `.gitignore`: o repositório é público, D60; o teste com elas roda só localmente; a anonimização
       muda o `infNFe` e a assinatura delas deixa de conferir, o que na importação só vira aviso): o
       `parser.spec.ts` exige a assinatura válida só das geradas e, das reais, a leitura inteira, os totais e a
       assinatura presente. Os CNPJs das lojas de teste (`CNPJ_LOJA_1`, `CNPJ_PETISCARIA_2`, `CNPJ_CD`) saem do
       `fixtures.ts`, que o gerador e os testes importam.
     Testes: `parser.spec.ts` (todas as fixtures lidas com os totais batendo com o vNF e, nas geradas, a assinatura
     válida, os
     valores exatos de cada uma escritos à mão — qCom com 4 casas, vUnCom e vUnTrib com 10, ST, FCP-ST, IPI, rastro,
     duplicatas —, DOCTYPE com entidade externa, "bilhão de risadas", entidade solta sem expandir, malformado, grande,
     profundo, fora de UTF-8, BOM, grupo repetido e campo fora do layout), `validacoes.spec.ts` (cada recusa com o
     motivo, o CD e a Petiscaria como destinatárias, a assinatura alterada como aviso e como recusa, ausente, de outro
     protocolo, duplicada, sem o namespace XMLDSig, o protocolo assinado no `protNFe` como válida, o "embrulho" com
     o Id repetido, com o Id forjado com espaço e o assinado escondido no `protNFe`, e com o Id com prefixo, e com o
     certificado de outra nota, os totais divergentes), `zip.spec.ts` (os XMLs, os pulados, o grande demais, a taxa,
     o cabeçalho que mente, o total, as entradas, o corrompido e os limites próprios contra os da planilha),
     `notas-entrada.spec.ts` e `configuracoes.spec.ts` do shared, e `migracao-notas-entrada.test.ts` (empresa nova ×
     existente com a mesma estrutura, os triggers e os CHECKs, a chave única com a ignorada, os dados do XML e a nota
     movimentada imutáveis, a estornada e o recebimento estornado sem volta a movimentado, o vUnCom com 10 casas no banco, e a leitura + validação contra o banco: Loja 1, CD, loja
     inexistente, NFC-e, sem protocolo, chave inválida, XXE, chave já importada e os três modos da chave).

164. **NF-e de fornecedor por XML: upload, fornecedor pelo emitente, listagem e ações** (Fase 2, F2-B19; ERP 13.4 "Por
     Arquivo"; MD 3.8.2; F2-Q3 = D6; D50 da decisão 163; `src/entradas/notas-entrada.{ts,controller.ts}`;
     `notas-entrada.ts` do shared; sem migração). **Sem SEFAZ e sem nada fiscal** (restrição do dono): a nota entra
     sempre com o aviso fixo "Sem consulta à SEFAZ: confira se a nota não foi cancelada pelo emitente." (no detalhe e
     na tela de upload), e não há "Pela Sefaz", manifestação nem conversão de CFOP.
     - **`POST /api/notas-entrada/importar`** (`notas_entrada.importar`): multipart com `arquivos` (um ou vários `.xml`
       e `.zip`, até 100 arquivos e **20 MB no pedido**, conferido pelo `Content-Length` **antes** do multer ler as
       partes para a memória — o multer só limita cada arquivo — e de novo pela soma) e as opções `estoqueId`/
       `tipoEstoqueId`. **Antes do multer** (o interceptor `LimiteEnvioNfe`, porque o processo é de todas as empresas
       e do `/sync`): o `Content-Length`, o limite de envios por minuto, **um envio por vez de cada usuário**
       (`NFE_ENVIOS_SIMULTANEOS_USUARIO`, padrão 1; o segundo simultâneo é 429 `LIMITE_TAXA`) e a vaga do semáforo do
       processo (`NFE_ENVIOS_SIMULTANEOS`, padrão 3: o seguinte espera a vaga sem o corpo lido), liberada quando a
       resposta termina; os erros do multer (mais de 100 arquivos, arquivo acima do teto) voltam como 422 no campo
       `arquivos`, com a mensagem da tela. O "20 MB" das mensagens vem do shared (`TETO_UPLOAD_NFE_TEXTO`). O `.zip`
       (pela extensão ou pelo conteúdo) é aberto com os limites de zip-bomba da decisão 163 (`extrairXmlsDoZip`), que
       valem também **somados para o envio inteiro** (`OrcamentoZipNfe`: 1.000 entradas e 100 MiB descompactados para
       todos os `.zip` do pedido; sem isso, 100 `.zip` de 200 KB descompactariam GBs): o `.zip` que passaria do que
       resta é recusado como `ENVIO_GRANDE_DEMAIS` pelo diretório central, sem descompactar, e os seguintes também até
       um caber; a tarefa do lote grande refaz a separação com o mesmo orçamento. Cada XML passa por
       `lerEValidarXmlNfe`. **Resposta sempre 200, com o resultado de cada
       arquivo** na ordem do envio (`lote.zip › nota.xml` para os de dentro do ZIP): `importada`, `duplicada` (a chave
       já importada, inclusive a ignorada, com o `notaId` e o código da existente para o link da ERP 13.4 **só quando
       quem importa vê a nota** — a loja dela entre as permitidas e o estoque entre os visíveis, D45; sem esse acesso a
       duplicada volta sem o link e sem o código, como a recusa por loja ou estoque não diria nada da nota nova) ou
       `recusada`, com o
       motivo do shared — os do XML (`MOTIVOS_RECUSA_NFE`) e os novos do arquivo/acesso (`MOTIVOS_RECUSA_ARQUIVO_NFE`:
       `NAO_E_XML`, `ZIP_CORROMPIDO`, `ZIP_GRANDE_DEMAIS`, `ZIP_SEM_XML`, `LOJA_NAO_PERMITIDA`, `LOJA_INATIVA`,
       `ESTOQUE_NAO_PERMITIDO`, `ESTOQUE_INATIVO`, `EMITENTE_INVALIDO`, `ENVIO_GRANDE_DEMAIS`, `ERRO_AO_GRAVAR`) —,
       os avisos (assinatura, totais e o lote do `rastro` com a fabricação depois da validade,
       `RASTRO_FABRICACAO_APOS_VALIDADE`: o schema da SEFAZ não impede, a nota entra, o rastro fica como veio e a
       sugestão do item vai sem a fabricação, que o `ck_itens_nota_entrada_validade` recusaria) e se o fornecedor foi
       criado. Um arquivo recusado nunca derruba os outros: o erro inesperado ao importar uma nota (o banco, a trava
       ocupada além de `ERP_ESPERA_TRAVA_MS`, o armazenamento) vira a recusa `ERRO_AO_GRAVAR` **só daquele arquivo**,
       com o erro no log (a mensagem diz "sistema ocupado" na trava, e nada do erro cru do banco), e os seguintes
       seguem — no envio direto e na tarefa. Limite de 20 envios por usuário por minuto
       (`NFE_IMPORTACOES_POR_MINUTO`).
     - **Acesso** (decisão técnica deste bloco, como o recebimento, decisões 149 e 159): a loja da nota é a do CNPJ do
       destinatário (qualquer loja da empresa, inclusive o CD como depósito, D6) e tem de estar entre as **lojas
       permitidas** e ativa; o estoque de destino é o escolhido no upload (fora dos permitidos para movimentar = **403
       no campo `estoqueId`**, para o envio inteiro, porque o usuário o escolheu) ou o vinculado à loja da nota (fora
       dos permitidos = a **nota recusada** com `ESTOQUE_NAO_PERMITIDO`, e as outras seguem). O tipo de estoque vazio é
       o padrão.
     - **Gravação**: o XML vai para o armazenamento **antes** da transação (MD 1.5), endereçado pelo conteúdo
       (`chaveXmlFiscal`: `emp/<codigo>/xml/<sha256>.xml`; o mesmo XML de novo é o mesmo objeto, e o objeto de uma
       transação que falhou fica sem linha, inofensivo); depois, **uma transação curta por XML** (`travaVersao`: o
       fornecedor criado desce ao PDV) com o fornecedor, a linha de `arquivos` (categoria `xml_nfe_entrada`,
       `entidade = 'notas_entrada'`, `registro_id` = a nota), o cabeçalho `pendente`, os itens (o primeiro lote do
       `rastro` vira a sugestão editável `lote`/`validade`/`fabricacao` do F2-B20, e o rastro inteiro fica no jsonb),
       as duplicatas e a auditoria `importar`. Duas importações da mesma chave ao mesmo tempo: o 23505 de
       `uq_notas_entrada_chave` (lido por `erroDoDriver`, com o erro do `pg` em qualquer nível do `cause`) vira
       `duplicada` com a nota que ganhou, com a mesma regra do link. O `contextoValidacaoNfe` (decisão 163) passou a fazer as três
       leituras uma depois da outra: no upload ele roda numa conexão só, e o `Promise.all` no mesmo cliente do `pg` é
       enfileirado com aviso de descontinuação.
     - **Fornecedor pelo emitente**: `acharOuCriarFornecedorPorDocumento` (decisão 158) com o CNPJ/CPF do XML
       normalizado, o nome (`xNome`), a fantasia, a IE, o telefone e o endereço do `enderEmit` (com a cidade do IBGE
       conferida na UF; o que não passa no contrato do cadastro rápido — telefone fora do formato, endereço incompleto —
       fica de fora sem impedir a nota), `pessoas.origem = 'nfe'` e sem conferir `pessoas.criar` (o emitente entra com a
       permissão de importar a nota, como a decisão 158 previa). A pessoa que já existe, **com qualquer máscara gravada
       antes**, é achada pelo documento normalizado e **não é alterada** (só ganha a categoria Fornecedor, se não a
       tem). No mesmo envio as notas são gravadas uma depois da outra, então a segunda nota do mesmo emitente já acha a
       pessoa pela busca; a trava pelo documento (decisão 158, com o teste de concorrência dela) é o que cobre os
       envios simultâneos.
     - **Lote grande na tarefa `importar_xml_nfe`** (`registrarTipo`; ERP 3.6): acima de 20 XMLs no envio
       (`LIMITE_IMPORTACAO_SINCRONA_NFE`, ou `NFE_IMPORTACAO_SINCRONA_MAX`) os arquivos enviados vão para o
       armazenamento (categoria `outro`, retenção de 7 dias) e a resposta traz só o `tarefaId`; a tarefa relê os
       arquivos, refaz a sessão de quem pediu **com o acesso do momento** (`sessaoDaTarefa`, agora em
       `tarefas/tarefas.ts`, a mesma da importação de planilha: sem `notas_entrada.importar` ou sem o estoque escolhido
       a tarefa falha com a mensagem) e importa cada XML como no envio direto, com o progresso — mas com a transação de
       cada nota **esperando a trava de versão sem limite** (`esperaSemLimite`, como as outras tarefas: sem ninguém na
       tela, esperar os caixas é melhor que falhar no meio); o `resultado` da tarefa é o mesmo `ResultadoImportacaoNfe`,
       que a tela do upload mostra quando a tarefa termina (README do ERP › decisão 59).
     - **Consulta**: `GET /api/notas-entrada` (`notas_entrada.ver`) com os filtros da ERP 13.4 — fornecedor, Nome
       (razão social ou fantasia do emitente), loja, estoque, período pela emissão ou pelo recebimento (o dia no fuso da
       loja destinatária), situação e Número/Chave (o número exato ou o começo da chave) —, só das notas de estoque
       permitido (D45, como o recebimento); `GET /:id` com o emitente, o fornecedor (o CPF/CNPJ dele só com
       `pessoas.ver`), os totais, o transporte, o protocolo, a assinatura, os itens (a vinculação, decisão 167), as
       duplicatas e os avisos (a assinatura que não confere ou ausente, D50, e o aviso fixo da SEFAZ); `GET /:id/xml`
       devolve o XML como foi enviado (a tela formata e baixa).
     - **Ações** (`notas_entrada.importar`, porque o catálogo não tem "editar" para a nota; a loja **gravada** também
       entre as permitidas, e a nota de estoque fora dos permitidos é 404, como o recebimento): "Ignorar nota"
       (`POST /:id/ignorar`, a pendente ou a pronta, motivo obrigatório; a chave continua ocupada), "Reabrir"
       (`POST /:id/reabrir`, a ignorada volta a `pendente` e o motivo sai, ficando na auditoria) e a troca do destino na
       aba Dados (`PUT /:id/destino`: loja entre as permitidas e ativa, estoque — vazio = o da loja — entre os
       permitidos e ativo, tipo ativo, com a nota pendente ou pronta; a loja pode não ser a do CNPJ do destinatário, que
       continua gravado). Todas com a versão do documento (409) e a auditoria `editar`.
     Testes: `notas-entrada.test.ts` (integração: um XML com a nota pendente, o fornecedor `origem = 'nfe'` com a IE e o
     endereço e o XML no armazenamento; o emitente já cadastrado com máscara reaproveitado sem mudar; **ZIP com 3 notas,
     1 já importada: 2 pendentes, 1 duplicada com o link, e duas notas do mesmo emitente criando a pessoa uma vez só**;
     a mesma nota de novo recusada como já importada; o CD como destinatário; NFC-e, XXE, `.txt`, ZIP corrompido e ZIP
     sem XML recusados com o motivo; a permissão `notas_entrada.importar`; o estoque escolhido fora dos permitidos (403),
     o da loja (nota recusada) e a loja fora das permitidas; listagem com os filtros e a visibilidade por estoque;
     detalhe com o aviso da SEFAZ e as duplicatas; o XML; Ignorar/Reabrir com a versão; a troca do destino; e o lote
     grande na tarefa; e, da revisão do bloco: o `Content-Length` acima de 20 MB recusado sem chegar ao serviço e os 101
     arquivos com a mensagem da tela; a duplicada de uma loja que o estoquista não vê sem o link; o período pela
     emissão e pelo recebimento no fuso da loja (o CD em outro fuso muda o dia), o fornecedor e o estoque; a mesma
     chave em dois envios simultâneos com a trava segura até os dois esperarem — o 23505 vira a duplicada com a nota
     que ganhou — e o segundo envio simultâneo do mesmo usuário em 429; a trava ocupada além da espera do ERP
     recusando só aquele arquivo; o rastro com as datas trocadas no meio de um ZIP; a tarefa esperando a trava além da
     espera do ERP; e a tarefa de quem perdeu a permissão ou o estoque escolhido falhando sem gravar),
     `notas-entrada.spec.ts` (a separação dos arquivos, o orçamento do envio em entradas e em bytes, o teto somado do
     pedido e os dados do fornecedor), `limites-processo.spec.ts` (a vaga do `Semaforo` segura até a resposta), o
     `notas-entrada.spec.ts` do shared e o `variarFixtureNfe` do `gerar.ts` (outra nota de uma fixture, assinada na
     hora, para o mesmo emitente duas vezes ou com o rastro trocado; o `montarZip` dos testes saiu do `zip.spec.ts` para
     `test/fixtures/nfe/montar-zip.ts`).

165. **Respostas do dono de 05/11/2026: estorno com negativo confirmado, Estoquista cadastra fornecedor e o preço no
     recebimento** (Fase 2; roadmap §16 D42, D43, D47, D48, D50, D55, D56 e D57, todas decididas; `entradas/entrada.ts`,
     `entradas/recebimentos{,.controller}.ts`, `pessoas/pessoas.controller.ts`, `perfis-padrao.ts` e `recebimentos.ts`
     do shared; **sem migração**).
     - **Estorno que deixa saldo negativo, com aviso (D56 = A)**: a regra saiu do corpo do `estornarEntrada` para
       `conferirNegativosEstorno` (núcleo de entrada, a mesma para a NF-e do F2-B21). Os saldos que ficariam
       negativos são apurados **sempre** (a linha de saldo e cada lote, pelo efeito líquido, como antes), agora também
       com a permissão, em `SaldoNegativoEstorno` (`produtoId`, `nome`, `lote` — nulo na linha —, `saldoAtual`,
       `saldoFinal`). Sem a permissão (não Master e `estoque.permite_negativo_erp` desligada na loja do estoque): 422
       com a mensagem de sempre (a da linha, ou a do lote quando só o lote fica negativo) e os saldos em
       `detalhes.saldosNegativos`; a confirmação não vale. Com a permissão e sem `confirmarNegativo` no corpo do
       `POST /recebimentos/:id/estornar` (novo; `confirmarNegativoSchema` do shared, para a NF-e usar o mesmo): 422 em
       `campos.confirmarNegativo` com a lista ("O saldo ficará negativo em: Cerveja (saldo 2 → -8)… confirme para
       estornar mesmo assim."; o número sai com o hífen comum do `toLocaleString`), nada lançado. **A confirmação é a
       lista mostrada, não um booleano**: `confirmarNegativo` é a lista `{ produtoId, lote, saldoFinal }` (vazia por
       padrão; o ERP devolve os `saldosNegativos` que recebeu, os outros campos são ignorados), e o núcleo só aceita se
       cada saldo negativo de agora estiver nela (o mesmo produto e lote) e não ficar mais negativo que o confirmado.
       Assim a venda do PDV que sincroniza enquanto a pergunta está aberta (outro produto ou lote, ou o saldo mais
       fundo) não passa sem ser vista: volta o 422, com "O saldo mudou desde a confirmação" e a lista de agora, e
       nada é lançado; o "sim" às cegas (`true`) é recusado pelo contrato. Com a confirmação: estorna, e a auditoria `estornar`
       ganha "; saldo negativo confirmado em: …" na descrição e `depois = { saldoNegativoConfirmado: true,
       saldosNegativos }` (o estorno sem negativo fica como antes, sem `depois`). O `ResultadoEstornoEntrada` devolve
       os `saldosNegativos`. A chave ligada na loja não muda a regra: dá a quem estorna ali a permissão do Master, sempre
       com o aviso.
     - **Preço no recebimento sem permissão**: `podeAlterarPrecoNaEntrada` (núcleo; "Altera Preço do Produto no ERP"
       ligada, o padrão, ou `produtos.alterar_preco`) decide o 403 do item que muda o preço na movimentação, como
       antes, e agora vai também em `GET /recebimentos/dados-produtos` como `podeAlterarPreco` (contrato
       `DadosCompraProdutos`), para a tela não perguntar "geral / só desta loja" a quem não pode (README do ERP ›
       decisão 60).
     - **Estoquista cadastra fornecedor**: permissão nova e estreita `pessoas.criar_fornecedor` ("Pessoas: Cadastrar
       fornecedor (cadastro rápido)"), que vale **só** no `POST /pessoas/fornecedor-rapido`, e o perfil de sistema
       Estoquista a ganhou em `PERFIS_PADRAO` — não o `pessoas.criar`: o dono respondeu que o Estoquista cadastra
       fornecedor, e o `pessoas.criar` abriria o `POST /pessoas` completo (a categoria Funcionário, que libera o
       crédito de funcionário no PDV, o desconto padrão da pessoa até 100%, a senha de compra a prazo, o "manter no
       PDV") e as linhas "Criar" da importação de clientes (que exige também `pessoas.importar`, decisão 85; ver a
       168). O cadastro rápido só grava documento, nome, fantasia, IE, telefone e endereço, sempre com a categoria
       Fornecedor.
       Nas empresas já criadas entra pelo **seed idempotente do pós-migração** (`db:migrate:empresas` reaplica o seed
       em toda empresa, decisão 10: acrescenta ao perfil a permissão que ele nunca teve e sobe o `permissoes_versao`
       dos usuários dele; a empresa que tirou a permissão do perfil não a recebe de volta) — o mesmo caminho de
       `lojas.editar_pix` (decisão 144) e `estoques.todos` (149); por isso **não há migração SQL 0025**: as migrações
       de empresa nunca mexeram em `perfis_permissoes`, e uma SQL faria a mesma inserção que o seed já faz. Dar a
       categoria Fornecedor a uma pessoa que já existe exigia `pessoas.editar`; no `POST /pessoas/fornecedor-rapido`
       passa a bastar `pessoas.criar_fornecedor`, `pessoas.criar` ou `pessoas.editar`, porque ali só se acrescenta a
       categoria (nome, IE, telefones e endereço da pessoa não mudam, decisão 158); criar a pessoa ali aceita
       `pessoas.criar_fornecedor` ou `pessoas.criar`. O `POST /pessoas` continua exigindo `pessoas.criar` e o
       `PUT /pessoas/:id`, `pessoas.editar`. **Atualizado pela decisão 168**: na resposta seguinte do dono (mesmo dia),
       o Estoquista ganhou também o `pessoas.criar` (o cadastro completo de pessoas), sem o `pessoas.editar`.
     - **Venda do PDV com saldo negativo (D55)**: conferido sem mudar nada — `pdv.bloqueia_venda_sem_estoque` e
       `vendas.valida_estoque` nascem desligadas (D27), o motor nunca recusa saldo negativo (`lancarDocumento`, SYNC
       15.1) e o `venda.finalizada` só abre o `ESTOQUE_NEGATIVO`; não há ponto da nuvem que recuse ou descarte a venda
       do caixa por saldo.
     - **Tolerância da conferência (D47)**: as chaves `estoque.tolerancia_conferencia_total_pct`/`_item_pct` já eram
       por loja e editáveis (Configurações › Geral › Estoque e Lojas › Parâmetros); nada mudou na API.
     - Testes: `recebimento-movimentar.test.ts` (sem a permissão, com e sem a confirmação, é 422 sem
       `campos.confirmarNegativo`; o Master sem a confirmação recebe a lista e nada é lançado, e com ela estorna com a
       auditoria; com "Permite saldo negativo no ERP" o estoquista estorna confirmando; o lote negativo também pede a
       confirmação; o estorno sem negativo não pergunta; `podeAlterarPreco` do estoquista com a chave desligada e do
       admin; a confirmação booleana é recusada; a venda que sincroniza depois da pergunta faz a lista confirmada não
       cobrir o saldo mais fundo e volta o 422 com a lista nova; a confirmação de outro produto, ou da linha sem o lote,
       não cobre), `fornecedores-produto.test.ts` (o Estoquista cria o fornecedor e dá a categoria sem mudar o resto,
       sem poder `PUT` nem `POST /pessoas` — a do `POST /pessoas` foi substituída pela 168; o vendedor, sem nenhuma
       das três, é 403), `provisionamento.test.ts` (o pós-migração devolve `pessoas.criar_fornecedor` ao Estoquista da
       empresa antiga, com o `permissoes_versao`, e não a do perfil que a tirou) e os unitários do shared (a lista do
       `confirmarNegativo` no contrato e o perfil Estoquista sem `pessoas.criar`, também substituído pela 168).

167. **NF-e de fornecedor por XML: vinculação dos itens com o fator e o fornecedor aprendido** (Fase 2, F2-B20; ERP
     13.4.1, 8.2.14; MD 3.8.2; `src/entradas/vinculacao.ts`, `notas-entrada{,.controller}.ts`, `recebimentos.ts`;
     `notas-entrada.ts` e `produtos.ts` do shared; **sem migração**: só as colunas de vinculação que a 0024 já deixou
     livres no `tg_itens_nota_entrada_xml_imutavel`). Sem SEFAZ e sem conversão de CFOP: **o CFOP não entra na regra**
     da nota "pronta".
     - **Sugestão, nesta ordem** (`sugestoesVinculoNfe`, duas consultas para a nota inteira): (1) o **vínculo
       aprendido** em `produtos_fornecedores` (fornecedor da nota + cProd, sem variação), com o fator dele; (2) o **EAN
       do XML** num código de barras do produto (`produtos_codigos_barras`, o principal ou um código adicional): o
       cEAN (a unidade comercial — o EAN do fardo cadastrado com fator 12 sugere o fator **12**, e a embalagem vai em
       `codigoBarrasId` quando é "de compra") e, sem ele, o cEANTrib (a unidade tributável, quase sempre a do produto:
       o fator da embalagem × qTrib/qCom). **O cEAN igual ao cEANTrib segue a regra do cEANTrib** (revisão do bloco):
       o fornecedor que repete o GTIN da lata nos dois com uCom CX e qTrib/qCom = 12 sugere 12, não o fator 1 do código
       da lata (que daria 10 latas para 10 CX e o custo por unidade 12 vezes maior); a embalagem só vai junto quando o
       fator sugerido é o dela (qTrib = qCom); (3) nenhuma ("manual"; o "SEM GTIN" cai aqui). Só sugere produto **ativo,
       com saldo próprio e controle de estoque** (o que a vinculação aceita). **O EAN de variação não sugere nada**
       enquanto as variações estão travadas (D43: vincular ao pai baixaria o estoque do pai, o risco do F2-B1/B34), e o
       EAN que está em **mais de um produto** (`geral.ean_duplicado = 'avisar'`) também não: o usuário escolhe. O fator
       pelas quantidades (`fatorPelasQuantidadesNfe`, qTrib/qCom a 3 casas, no detalhe como `fatorTributavel`) é o
       sugerido quando o usuário escolhe o produto à mão.
     - **A sugestão nunca é gravada sozinha** (decisão técnica deste bloco): o `GET /notas-entrada/:id` a calcula na
       hora (o EAN cadastrado depois da importação já aparece; o vínculo aprendido no F2-B21 vale para as notas
       pendentes) e a tela a mostra preenchida, **com o fator por confirmar**. O **fator confirmado é a quantidade no
       estoque gravada** (`quantidade_estoque` = qCom × fator, nula enquanto o usuário não confirmou: `fatorConfirmado`
       no detalhe) e a **origem** do vínculo gravado ("Vínculo anterior", "EAN da embalagem" ou "Manual",
       `ORIGENS_VINCULO_NFE`) sai da comparação com a sugestão de agora (o mesmo produto e o mesmo fator = a origem da
       sugestão; senão, manual): nenhuma coluna nova, como o plano previa ("sem migração"). O detalhe traz também o
       `vinculoAnterior` (produto e fator aprendidos) para o destaque do fator divergente, o produto vinculado
       (`ProdutoOpcao`, inclusive o excluído depois), a embalagem, o preço proposto (o markup só com
       `produtos.ver_custo`, decisão 161), e em `vinculacao` as chaves da aba (as parcelas do custo
       `estoque.custo_inclui_st/ipi/frete` e as da base do markup, da loja destinatária, e `podeAlterarPreco`) e a
       contagem de itens resolvidos.
     - **`PUT /api/notas-entrada/:id/itens`** (`notas_entrada.importar`; `vincularItensNfeSchema`): só os itens enviados
       mudam, com a versão do documento (409), a nota pendente ou pronta (a ignorada é reaberta antes; a movimentada e a
       estornada recusam) e a loja gravada entre as permitidas (como as outras ações). Cada item: o produto (vazio =
       desvincular), a embalagem, o fator e `fatorConfirmado` (o fator vazio só vale 1 no item por confirmar ou
       ignorado: confirmado, é "Informe o fator", revisão do bloco), o lote/validade/fabricação do rastro (editáveis; a
       fabricação não futura no fuso da loja), o preço de venda proposto com o markup e "Atualizar preço" (só gravados:
       aplicados ao movimentar, F2-B21, com a regra do `podeAlterarPrecoNaEntrada`), ou "Ignorar item" com motivo (o
       ignorado perde o vínculo e o preço e guarda o lote do rastro). A conferência do produto e da embalagem é **a mesma do recebimento** (`conferirItens`,
       agora exportada com a posição de cada item no corpo): combo, serviço, produzido e "Com variações" recusados, a
       embalagem do produto, de compra e com o fator dela; o lote do produto que pede lote (`solicita_lote_pdv`) só é
       exigido **no item com o fator confirmado**. qCom × fator que arredonda a zero ou passa de `numeric(15,3)` é 422
       no fator. Só as linhas que mudaram são gravadas (um UPDATE por bloco de 500, SYNC 6.13), e sem mudança nenhuma
       a nota, a versão e a auditoria ficam como estavam.
     - **Nota "pronta"** (o SQL de `recalcularStatusNotaEntrada` é a fonte da regra; o `itemResolvidoNfe` do shared,
       com a mesma condição, só conta os resolvidos do detalhe): todos os itens vinculados com o fator confirmado ou
       ignorados; algum por vincular ou confirmar a devolve a "pendente". O "Reabrir" da nota
       ignorada passa a recalcular também (a reaberta com tudo resolvido volta direto a "pronta"). Auditoria `editar`
       com a contagem de itens alterados, a situação nova e o antes/depois de cada item (produto, fator, confirmação,
       ignorado e motivo, preço).
     - **Custo de entrada** (`custoEntradaItemNfeTexto`, shared): (vProd + vFrete + vSeg + vOutro − vDesc + vIPI +
       vICMSST + vFCPST) / (qCom × fator), a 4 casas, com o ST/FCP-ST, o IPI e o frete pelas chaves (F2-Q8 = D49:
       entram todos). `estoque.custo_inclui_frete` é "Custo da NF-e inclui frete e despesas" na tela (ERP 9.1): ligada
       ou desligada, leva o frete, o seguro e as outras despesas juntos (revisão do bloco; antes o seguro e as outras
       entravam sempre, contra o rótulo). No F2-B20
       é a base do markup ⇄ preço da aba; o F2-B21 grava o mesmo número em `custo_unitario` ao movimentar (a função
       fica no shared para as duas pontas).
     - **Dados de compra**: `GET /api/notas-entrada/dados-produtos` (`notas_entrada.ver`) devolve o mesmo
       `DadosCompraProdutos` do recebimento (embalagens, lote, saldo e custo médio no destino da nota, preço da loja),
       para quem trabalha a nota sem `recebimentos.ver`.
     - **Cadastro rápido de produto**: `corpoProdutoRapido` aceita o CEST do item da NF-e (só gravado; o modal do ERP
       o pré-preenche, README do ERP › decisão 61).
     Testes: `notas-entrada-vinculacao.test.ts` (integração, critério de pronto com a nota de bebidas `01-icms-st.xml`:
     o EAN da caixa sugere a cerveja com fator 12 e a embalagem, o EAN da garrafa sugere o refrigerante com 30/5 = 6, a
     água sem produto fica manual; vinculados sem confirmar a nota fica pendente, confirmados fica pronta com 120, 30 e
     24 no estoque, e volta a pendente quando o fator perde a confirmação; o item ignorado com motivo; a gravação sem
     mudança não toca na nota; a versão; o `PUT` recusado a um perfil só com `notas_entrada.ver` e os dados de compra
     servidos a ele (sem `recebimentos.ver`, que dá 403 na rota do recebimento) e recusados sem `notas_entrada.ver`; o
     cEAN = cEANTrib da `03-ipi-industria.xml` (4 CX, 48 UN, o EAN da garrafa com fator 1) sugerindo 12 e gravando 48,
     e a água com qTrib = qCom levando a embalagem; "SEM GTIN" no manual com o fator pelas quantidades; o vínculo
     aprendido com o fator dele e a origem "manual" quando o usuário diverge; a loja gravada fora das permitidas (com o
     estoque da nota permitido) recusando o `PUT`; o vínculo anterior com a embalagem do cEAN (e sem ela com outro
     fator); o EAN só numa variação, num EAN que não está em mais nenhum produto (o mesmo EAN no produto sugere o pai,
     o que prova a regra da variação), e o EAN em dois produtos, em casos separados; as recusas da conferência, a
     fabricação futura e o fator vazio confirmado; o lote exigido só ao confirmar; a nota ignorada e o "Reabrir" que
     volta a pronta) e o `notas-entrada.spec.ts` do shared (fator pelas quantidades, quantidade no estoque, custo com as
     parcelas ligadas e desligadas, inclusive só a do frete e despesas, o item resolvido e o contrato do `PUT` com o
     fator vazio). O `produtos.spec.ts` confere o CEST no corpo do cadastro rápido.

168. **Resposta do dono de 05/11/2026: o Estoquista também faz o cadastro completo de pessoas** (Fase 2; completa a
     decisão 165; roadmap §16, "Outras respostas do dono"; `perfis-padrao.ts` do shared; **sem migração**).
     - O dono respondeu que o Estoquista deve ter **as duas**: cadastrar o fornecedor no recebimento (o cadastro rápido,
       `pessoas.criar_fornecedor`, decisão 165) **e** o cadastro de pessoas completo. O perfil de sistema Estoquista
       ganhou `pessoas.criar` em `PERFIS_PADRAO`, mantendo `pessoas.criar_fornecedor` (que um perfil personalizado
       continua podendo dar sozinho). Com ela vale o `POST /pessoas` inteiro — todas as categorias (inclusive
       Funcionário, que libera o crédito de funcionário no PDV), o desconto padrão da pessoa, a senha de compra a
       prazo, o "manter no PDV", endereços, telefones e e-mails — e, no cadastro rápido, criar e dar a categoria
       Fornecedor (o `pessoas.criar` já bastava ali). Os riscos que a 165 apontou para não dar o `pessoas.criar` foram
       aceitos pelo dono ao pedir o cadastro completo.
     - **O cadastro completo é criar**: o perfil **não** ganhou `pessoas.editar` (o `PUT /pessoas/:id`; corrigir a
       pessoa depois de gravada fica com o Gerente e o Administrador, ou com a empresa que conceder a permissão ao
       perfil ou ao usuário), `pessoas.excluir`, `pessoas.editar_credito` (limite de compras e bloqueio: no
       `POST /pessoas` continuam 403 sem ela), `pessoas.anonimizar` nem `pessoas.importar`. A planilha de clientes
       (ERP 8.6) tem permissão própria e é trabalho da implantação, não do recebimento; se a empresa conceder
       `pessoas.importar` ao Estoquista, as linhas "Criar" passam pelo `pessoas.criar` e as "Atualizar" viram erro da
       linha sem `pessoas.editar` (decisão 85). No ERP nada mudou no código: a tela de Pessoas já mostra o "Novo" com
       `pessoas.criar` e só abre editável o formulário da pessoa nova (o gravado fica somente leitura sem
       `pessoas.editar`).
     - A **descrição** do perfil ("Produtos (sem preço), acertos…") não mudou: o seed só cria o perfil que falta e não
       reescreve a descrição das empresas existentes (a empresa pode tê-la editado); trocá-la só nas novas deixaria
       duas descrições para o mesmo perfil. A lista de permissões do perfil, em Perfis de acesso, mostra a nova.
     - **Empresas já criadas**: o mesmo seed idempotente do pós-migração (`db:migrate:empresas`, decisão 10) acrescenta
       `pessoas.criar` ao perfil que nunca a teve, sobe o `permissoes_versao` dos usuários dele (o cache de acesso das
       instâncias da API renova) e não a devolve à empresa que a tirou do perfil (a linha excluída fica). Pelo mesmo
       motivo da 165, não há migração SQL: a última migração de empresa continua `0024_notas_entrada`. Nada desce ao
       PDV (o fluxo de `perfis_permissoes` só leva as `pdv.%`; o cadastro de cliente no caixa é o
       `pdv.cliente.cadastro_rapido`), então o caixa instalado não muda.
     - Testes: `permissoes.spec.ts` do shared (o Estoquista com `pessoas.criar` e `pessoas.criar_fornecedor`, sem
       `pessoas.editar`, `pessoas.excluir`, `pessoas.importar`, `pessoas.editar_credito`, `pessoas.anonimizar` nem
       `produtos.alterar_preco`), `provisionamento.test.ts` (o caso da 165 virou um por permissão: a empresa antiga
       sem a linha ganha `pessoas.criar` e `pessoas.criar_fornecedor` no pós-migração, com o `permissoes_versao` do
       usuário estoquista, e a que tirou não ganha de volta nem renova a versão) e `fornecedores-produto.test.ts` (o
       Estoquista do seed faz o `POST /pessoas` completo — cliente e funcionário, desconto, senha, endereço, telefone e
       e-mail — com a auditoria em nome dele; com limite de compras é 403 e nada é gravado; `PUT`, `DELETE` e a
       planilha de clientes são 403).

169. **NF-e de fornecedor por XML: movimentar e estornar (`RECEB_NFE`/`ESTORNO_RECEB_NFE`) com a composição do custo e o
     vínculo aprendido** (Fase 2, F2-B21; ERP 13.4, 13.4.1; MD 3.6.10, 3.8.2; F2-Q8 = D49; D56; F2-Q7 = D48;
     `src/entradas/movimentar-nfe.ts` (novo), `entrada.ts`, `recebimentos.ts`, `vinculacao.ts`, `notas-entrada{,.controller}.ts`;
     `notas-entrada.ts` do shared; **sem migração**: a 0024 já deixou `custo_unitario`, `lote_id`, `data_movimentacao`,
     `movimentada_por_id` e as colunas do estorno livres nos triggers; a última migração de empresa continua
     `0024_notas_entrada`). Sem SEFAZ e sem conversão de CFOP. Fecha o primeiro item da Definição de pronto da Fase 2
     ("NF-e por XML entra no estoque"), sem a parte da SEFAZ.
     - **`POST /api/notas-entrada/:id/movimentar`** (`notas_entrada.movimentar`; `movimentarNotaEntradaSchema`: `versao`
       opcional e `atualizarPrecoCusto`), com `travaVersao`, o estoque da nota entre os permitidos para movimentar (fora
       dele, 404) e a loja gravada entre as permitidas (403), como as outras ações da nota. Só a nota **"pronta"** entra;
       a pendente ("vincule ou ignore todos os itens"), a ignorada ("reabra") e a estornada são 422; a nota com **todos
       os itens ignorados** também (não há o que lançar: "Ignorar nota"). **Idempotente** como o recebimento: a já
       movimentada devolve o detalhe sem lançar nada nem conferir a versão.
     - **O núcleo do recebimento** (`movimentarEntrada`, decisão 160) faz o resto, com a NF-e só compondo o custo e
       conferindo de novo o que pode ter mudado desde a vinculação: o estoque e o tipo de destino ativos
       (`exigirDestinoAtivoEntrada`, agora do núcleo, com a mensagem "troque … na aba Dados"), o produto e a embalagem
       (`conferirItens`, com o lote exigido do produto que pede lote; os erros em `itens.N.campo` com N = a posição do
       item na nota inteira, a mesma da aba e do `PUT`). Um `RECEB_NFE` por item vinculado (o ignorado não entra), com
       `data_movimento = now()` (F2-B4), a **unidade comercial do XML (uCom)** em `unidade_documento`, o fator confirmado,
       o fornecedor em `pessoa_id`, o lote achado ou criado (F2-B6), a última compra do saldo e a compensação do
       "Definir" (F2-B4). A pergunta do preço de custo (D49, `estoque.compra_atualiza_preco_custo`) passou para o núcleo
       (`resolverAtualizarPrecoCusto`) e é a mesma do recebimento: 422 em `atualizarPrecoCusto` com os produtos, só para
       quem tem `produtos.ver_custo`. O preço de venda proposto por item ("geral"/"só da loja", gravado na vinculação)
       segue a permissão de alterar preço (403 no item) e vai para o histórico com a origem **`nota_entrada`** e o id da
       nota. Depois do lançamento, o custo e o lote são gravados em cada item (com a nota ainda aberta: o trigger só deixa
       mexer nos itens da pendente/pronta) e a nota fica `movimentada` com a data e quem movimentou. Auditoria
       `movimentar` com o resumo do recebimento (itens, movimentos, lotes, preços, vínculos).
     - **Custo por item** = (vProd + vFrete + vSeg + vOutro − vDesc + vIPI + vICMSST + vFCPST) / (qCom × fator), a 4
       casas: o **mesmo `custoEntradaItemNfeTexto` do shared** que a aba de itens mostra (F2-B20; a função pura do custo
       pedida pelo plano ficou em `notas-entrada.ts` do shared, não em `estoque.ts`), com as chaves
       `estoque.custo_inclui_st` (ST e FCP-ST), `_ipi` e `_frete` (frete, seguro e outras despesas) **da loja
       destinatária** (`lerParcelasCustoNfe`, a mesma leitura da aba: a tela mostra o custo que vai entrar);
       `estoque.custo_abate_creditos` é ignorada (fiscal). D49 decidida pelo dono: entram todas. O custo gravado em
       `itens_nota_entrada.custo_unitario` é o de quando a nota entrou (a aba da nota movimentada mostra ele, não a prévia
       pelas chaves de agora).
     - **Vínculo aprendido** (`aprenderVinculosPorCodigo` no núcleo; o item da NF-e leva o cProd em `codigoFornecedor`):
       para cada cProd (o último item, se ele se repete), o vínculo fornecedor + código aponta para o produto, o fator e a
       uCom **confirmados nesta nota**, com o custo do item e o dia da emissão no fuso da loja como "última compra", em
       quatro passos por bloco de 500: (0) o **código ligado na vinculação a outro produto** sai do produto antigo como no
       "mover vínculo" do cadastro (decisão 158; decisão técnica da revisão do bloco, para a NF-e não ser um atalho que
       altera outro cadastro sem a permissão nem o registro): exige **`produtos.editar`** — sem ela, 403 em
       `itens.N.produtoId` com o produto onde o código está, conferido antes da pergunta do preço de custo e de qualquer
       lançamento (`exigirPermissaoMoverVinculos`); a linha antiga é **excluída logicamente** (o custo do fornecedor, o
       último custo e a última compra eram do produto antigo e ficam com ela), o código segue para os passos 2 e 3 como
       um código novo do produto da nota, e o produto antigo ganha a auditoria **`editar`** com os vínculos de antes e
       de depois ("Vínculo do fornecedor movido pela NF-e Nº …: código … para o produto …",
       `auditarVinculosMovidosNfe`; o produto antigo pode ficar sem principal, como no cadastro); (1) o vínculo que já
       tem o código no mesmo produto é atualizado — fator e unidade sempre os desta nota (decisão técnica: a última
       confirmação do usuário é o que vale, também na nota mais antiga movimentada depois), último custo e última compra
       sem voltar para trás pela data; (2) sem ele, o **vínculo sem código** do mesmo produto com o fornecedor (o do
       recebimento manual) **ganha o cProd** (decisão técnica: o produto não fica com dois vínculos do mesmo fornecedor;
       dois códigos do mesmo produto na nota: um o adota e o outro segue para o 3); (3) sem nenhum, cria o vínculo com o
       código, principal só o **primeiro** do produto que não tem vínculo nenhum (dois códigos movidos ou novos para o
       mesmo produto não deixam dois principais, que o formulário do produto recusaria). O passo comum do núcleo (último
       custo e última compra nos vínculos do fornecedor com o produto, e o vínculo sem código que falta) não mexe nos
       vínculos que a nota acabou de aprender. A vinculação do F2-B20 já lê esse vínculo: a **próxima nota do fornecedor
       chega com todos os itens sugeridos pelo "vínculo anterior"**, com o fator aprendido, e fica pronta com "Confirmar
       todos os fatores" (a sugestão continua nunca gravada sozinha, decisão 167). O vínculo é aprendido com
       `geral.produto_usa_fornecedores` ligada ou não (a chave só mostra o bloco Fornecedores no produto; na Ice Beer o
       plano a liga junto da PR-5).
     - **Lotes do `rastro`** (decisão técnica, F2-Q7 = D48: o saldo por lote do FEFO tem de ser o da nota): o item com
       **mais de um lote** no `rastro`, com o lote sugerido mantido na vinculação (o do primeiro `rastro`), entra em cada
       lote com a sua parte (`partesLoteRastroNfe` do shared): a quantidade no estoque repartida na proporção do qLote
       (que não depende da unidade em que o emitente o escreveu), a 3 casas, com o resíduo na maior parte; o mesmo lote
       repetido soma numa parte; a primeira parte leva a validade e a fabricação da vinculação e as outras as do `rastro`
       (a fabricação depois da validade fica nula, como na importação); da 2ª parte em diante, o lote **já cadastrado
       com outra validade ou fabricação** fica com as datas do cadastro (`datasDoRastro` no `ItemEntrada`; decisão
       técnica da revisão do bloco: essas datas vêm do XML e não se editam na aba, e o erro em `itens.N.validade`
       apontaria a validade da 1ª parte, que o usuário corrigiria sem efeito), enquanto a 1ª parte (a da vinculação,
       editável) continua o 422 no item. Um movimento por lote do **mesmo item**
       (`documentoItemId` novo no `ItemEntrada` do núcleo, como a divisão FEFO da venda; o índice de idempotência tem o
       `lote_id`), todos ao custo do item; `itens_nota_entrada.lote_id` guarda o lote da primeira parte. O lote trocado na
       vinculação é a decisão do usuário: o item entra inteiro nele. A aba de itens avisa a divisão ("Entra em 2 lotes do
       rastro…", README do ERP › decisão 62).
     - **`POST /api/notas-entrada/:id/estornar`** (`notas_entrada.estornar`; `estornarNotaEntradaSchema`: motivo
       obrigatório e `confirmarNegativo`, o do recebimento), com `travaVersao` e a versão: o núcleo lança o
       `ESTORNO_RECEB_NFE` de cada movimento da nota (os dos lotes do rastro também, cada um no seu lote) e das
       compensações contra eles, com a **regra do saldo negativo do recebimento** (D56, decidida pelo dono em 05/11/2026,
       `conferirNegativosEstorno`): sem Master nem `estoque.permite_negativo_erp` da loja do estoque, 422 com a lista; com
       a permissão, 422 em `confirmarNegativo` até a lista mostrada ser devolvida, e o negativo confirmado vai para a
       auditoria. A nota fica `estornada` com quem, quando e o motivo, e não volta (a 0024 a trata como o fim; a chave
       continua ocupada); a não movimentada é 422. O estorno não desfaz preço, preço de custo, vínculo aprendido nem lote.
     - **Detalhe**: a nota ganhou `movimentadaPorNome`, `estornadaEm`, `estornadaPorNome` e `motivoEstorno`; o item,
       `custoUnitario` e `loteId`.
     Testes: `notas-entrada-movimentar.test.ts` (integração: a nota de bebidas `01-icms-st.xml` com a conta à mão —
     466,16 / 120 = 3,8847 na caixa de 12, 264,61 / 30 = 8,8203, 33 / 24 = 1,3750 —, os movimentos com uCom, fator e
     fornecedor, o saldo e o custo médio, a pergunta do preço de custo e a resposta, o preço de venda com o histórico na
     origem `nota_entrada`, o vínculo aprendido e o vínculo sem código do refrigerante que ganha o cProd, a versão, o
     movimentar repetido, a pendente e sem permissão recusadas; a segunda nota do mesmo fornecedor (`variarFixtureNfe`)
     100% sugerida pelo "vínculo anterior", movimentada, e o cProd da água ligado a outro produto que move o vínculo; o
     FCP-ST/ST desligados na `02-fcp-st.xml` — 6,4900 e 4,3333 — e o IPI desligado na `03-ipi-industria.xml` — 10,7958 e
     3,9344, com seguro, outras despesas e desconto —; o Estoquista sem `produtos.ver_custo` movimentando sem a pergunta;
     o estorno, a estornada que não volta, o estorno que deixaria −110 recusado sem a permissão e confirmado com a lista
     pelo Master, com a auditoria; a nota com todos os itens ignorados e a ignorada recusadas; a `07-rastro-cd.xml` com o
     iogurte em 72 + 48 nos dois lotes e o leite em um, o `saldos_lote` e o estorno de cada lote; e o
     `conferirRazaoDoBanco` no fim; na revisão do bloco: o código movido sem `produtos.editar` recusado com 403 no item e
     sem lançar nada, a linha antiga excluída com o custo do fornecedor dela, a nova sem ele e não principal no produto
     que já tinha o principal, a auditoria `editar` do produto antigo, dois códigos movidos para o mesmo produto com um
     principal só, a nota mais antiga movimentada depois sem recuar o último custo, dois códigos do mesmo produto na
     nota com o custo de cada item, o Estoquista conferido na água com gás, cujo custo da nota difere do cadastro, e o
     lote da 2ª parte do rastro já cadastrado com outra validade) e o `notas-entrada.spec.ts` do shared (a divisão pelo rastro — proporção, resíduo,
     qLote em outra unidade, datas da primeira parte, lote repetido, fabricação depois da validade e os casos que não
     dividem — e os contratos de movimentar e estornar). As suítes do recebimento e da vinculação continuam verdes com a
     pergunta do preço de custo e o destino ativo movidos para o núcleo.

170. **Transferência entre estoques: schema e contratos** (Fase 2, F2-B22; ERP 13.7, 13.6; MD 3.7.6; D6, D43 e D51 do
     roadmap; `src/database/empresa/schema/estoque.ts`, migração `0025_transferencias`; contrato no shared
     `transferencias.ts`). Primeiro bloco do PR-6 ("Transferência CD ⇄ loja"): só o schema e os contratos, **sem
     endpoint** (rascunho, enviar e cancelar no F2-B23; receber, tratar divergência e o modo de uma etapa no F2-B24;
     sugestão no F2-B25; em trânsito e alerta no F2-B26; telas no F2-B27). O que já existia e foi reaproveitado: os
     tipos `TRANSF_SAIDA`/`TRANSF_ENTRADA`/`TRANSF_RETORNO` no seed, `documento_tipo = 'transferencia'` no razão, a
     origem de acerto `perda_transferencia`, as permissões `transferencias.ver/criar/enviar/receber/cancelar`, a chave
     `estoque.transferencia_recebimento_automatico` e o item de menu; não havia tabela nem código de transferência.
     **Schema**: `transferencias_estoque` (CP, AU; `codigo` de `seq_codigo_transferencias_estoque`, criada antes da
     tabela na mesma migração; origem ≠ destino; **`tipo_estoque_id` no cabeçalho**, o mesmo nas duas pontas, com o
     padrão = o tipo padrão aplicado pela API, como no recebimento — o banco não tem default por subconsulta —, para o
     Vasilhame vazio levar os cascos de volta ao CD; `data` do documento; motivo até 120; observações; situação
     rascunho/em_transito/recebida/recebida_divergencia/cancelada; quem e quando enviou, recebeu e cancelou, com o motivo
     do cancelamento; `documento_fiscal_id` nulo e **sem FK** até `documentos_fiscais` existir; `qtd_itens`) e
     `itens_transferencia` (produto, `variacao_id` sempre nula enquanto as variações estão travadas — D43 —, `lote_id`
     nulo = FEFO no envio, quantidade enviada e recebida, `diferenca` gerada = enviada − coalesce(recebida, enviada),
     tratamento `retorno_origem`/`perda` com a hora e o `custo_unitario` do envio). **NF-e emitida por fora (D6,
     decidida pelo dono)**: o CD e as lojas têm CNPJs próprios, e a transferência entre eles exige NF-e, que o Genesis
     só emitirá na fase fiscal; até lá ela sai pelo Nuvem3/contador e a transferência **só anota** a chave
     (`nfe_externa_chave`, `varchar(44)`, formato no CHECK e DV no contrato, com o CNPJ alfanumérico) e/ou o número e
     série (`nfe_externa_numero`), opcionais, anotáveis também depois do envio (a nota costuma sair na expedição) e
     travados na cancelada — nada se emite nem se consulta (sem SEFAZ). **CHECKs**: origem ≠ destino, situação
     conhecida, situação × datas de cada etapa (`ck_transferencias_estoque_etapas`: rascunho sem etapa nenhuma; envio em
     trânsito e depois; recebimento só nas duas recebidas; cancelamento só na cancelada, com o motivo), a forma da
     chave, enviada > 0, recebida entre 0 e a enviada, custo ≥ 0, tratamento conhecido e só com diferença (recebida
     gravada e menor que a enviada: sem o `is not null`, o `null < x` passaria no CHECK), com a hora. **Etapas no banco** (a última barreira; a API dos próximos blocos confere antes, com a
     mensagem no campo): `tg_transferencias_estoque_imutavel` (`fn_protege_imutavel`: fora do rascunho só as colunas
     do recebimento, do cancelamento e da NF-e de fora mudam, inclusive a exclusão lógica, que fica só no rascunho) e
     `tg_transferencias_estoque_etapa` (as transições do diagrama do ERP 13.7 — rascunho → em trânsito ou cancelada; em
     trânsito → recebida, recebida com divergência ou cancelada; recebida com divergência → recebida; **recebida e
     cancelada são o fim**, a lição da 0024: sem isso, um update "descancelaria" sem lançar o `TRANSF_SAIDA` de novo —
     e em que transição cada coluna muda; não se pula a 1ª etapa: o modo de uma etapa passa pelo trânsito na mesma
     transação); `tg_itens_transferencia_etapa` (o item entra e sai só no rascunho, onde o envio grava o custo antes de
     mudar a situação; no trânsito só a quantidade recebida muda — a conferência é gravada antes de a situação sair
     do trânsito —; na recebida com divergência só o tratamento, **uma vez**; a recebida e a cancelada não mudam
     mais). `DOCUMENTO_IMUTAVEL` (P0001) vira o 422 de sempre no filtro de erros. Um produto (e lote) por transferência:
     `uq_itens_transferencia_produto` com `nulls not distinct`, como o acerto (sem lote é uma linha; cada lote, outra).
     Índices: origem × situação e destino × situação (a listagem, o "em trânsito" do destino e o alerta do F2-B26) e um
     por FK. **Versão**: `fn_versao_local` nas duas (não descem ao PDV; os saldos descem pelo fluxo `estoque`; o
     `Esquema.g.cs` não muda e o `verificar:esquema-pdv` continua em dia), com a `diferenca` gerada isenta no item
     (`fn_versao_local('diferenca')` e `COLUNAS_ISENTAS_VERSAO`, o padrão da 0012: o NEW da coluna gerada chega nulo no
     BEFORE); autoria pelo `TABELAS_COM_AUTORIA`. **Contratos** (`transferencias.ts` do shared): o rascunho
     (`criar`/`alterarTransferenciaSchema`: origem ≠ destino sem diferenciar maiúsculas, tipo e data vazios = o padrão
     e hoje — quem aplica e confere o dia é a API —, motivo obrigatório até 120, a NF-e de fora, até **990 itens** — o
     teto da NF-e, para a transferência entre CNPJs caber numa nota na fase fiscal —, quantidade > 0 com 3 casas
     (ADR-05), o mesmo `id` ou o mesmo produto × lote duas vezes recusados), `excluir` (`?versao=` opcional),
     `nfeExternaTransferenciaSchema` (anotar depois do envio), `enviar` (só a versão; o saldo da origem e o negativo
     do Master/`estoque.permite_negativo_erp` são da API, SYNC 15.1), `receber` ("Receber tudo como enviado" **sem**
     itens, ou a quantidade de **cada** item, ≥ 0 e sem repetir — a API recusará a conferência que deixa item de fora,
     para o esquecido não virar "recebido como enviado" sem ninguém conferir), `tratarDivergencia` (por item, ao menos
     um, sem repetir), `cancelar` (motivo obrigatório até 255), os filtros da listagem (Nº, origem, destino, situação e
     o período pela data de criação ou de envio, com a data impossível em 422) e a consulta da sugestão de reposição
     (`?origem&destino`, diferentes, e o tipo opcional), com as respostas (resumo, detalhe com o saldo na origem e o
     custo nulo sem `produtos.ver_custo`, sugestão com o mínimo, o máximo, o em trânsito, a embalagem e os avisos) e os
     rótulos. Regras puras: `TRANSICOES_TRANSFERENCIA`/`podeTransitarTransferencia` (iguais às do trigger),
     `diferencaItemTransferenciaTexto` (a conta da coluna gerada) e `situacaoAposRecebimento`. **Padrão até a
     confirmação do dono (F2-Q10 = D51)**: o tratamento "Baixar como perda" é o retorno da diferença à origem mais um
     acerto de saída de origem `perda_transferencia` (motivo `MOTIVO_PERDA_TRANSFERENCIA`, "Perda em transferência"):
     o saldo da origem fica igual e a perda fica registrada a custo, com os tipos de movimento que já existem (o
     lançamento é do F2-B24). Testes: `migracao-transferencias.test.ts` (empresa nova e existente na 0024, com
     cadastro, acerto e recebimento, terminam com a mesma estrutura — sequência, triggers, CHECKs e índices —, a
     primeira transferência da existente é o Nº 1, a diferença gerada não gera versão no UPDATE sem mudança; os CHECKs
     — origem = destino e recebida > enviada recusadas, enviada ≤ 0, custo negativo, tratamento sem diferença, sem
     recebimento, sem hora ou desconhecido, produto repetido, chave fora do formato, situação × datas no UPDATE e no
     INSERT, com cada cláusula sozinha: recebida sem a hora do recebimento, cancelada sem a hora do cancelamento e
     recebimento fora da recebida, que o trigger de etapa aceita e só o CHECK recusa —; as etapas no banco — rascunho
     editável, envio com o custo gravado antes, trânsito só com a recebida e a NF-e de fora, o item que não muda de
     transferência, tratamento uma vez, recebida como fim; cancelamento do rascunho e do trânsito e a cancelada
     travada) e o
     `transferencias.spec.ts` do shared (normalização e padrões, recusas e casos-limite de cada contrato, as transições e
     as regras da situação).
171. **Transferência entre estoques: rascunho, enviar e cancelar** (Fase 2, F2-B23; ERP 13.7, 13.1.4; MD 3.7.6; SYNC
     15.1; T20; D6 e D43 do roadmap; `src/transferencias/transferencias{,.controller}.ts` (novo módulo); as travas em
     `estoques.controller.ts` e `tipos-estoque.controller.ts`). **Sem migração nova**: as tabelas, os triggers de etapa e
     os contratos são do F2-B22 (decisão 170, migração `0025_transferencias`), e o seed já tinha `TRANSF_SAIDA` (−1) e
     `TRANSF_RETORNO` (+1). Rotas: `GET|POST /transferencias`, `GET /transferencias/destinos`, `GET|PUT|DELETE
     /transferencias/:id`, `POST /transferencias/:id/enviar|cancelar` e `PUT /transferencias/:id/nfe-externa`.
     - **Acesso** (decisão 149): a transferência é **visível** para quem vê a origem **ou** o destino (o CD que
       despacha e a loja que vai receber no F2-B24; fora dos dois, 404 como inexistente, também na listagem); gravar,
       excluir, enviar, cancelar e anotar a NF-e exigem a **origem gravada** entre os estoques permitidos para
       movimentar (403; na criação e na troca da origem, 403 em `estoqueOrigemId`), e o **destino não precisa** estar
       permitido (o expedidor do CD despacha para a loja que não enxerga). O detalhe mostra o "Saldo na origem" (o da
       linha origem × tipo; no item com lote, o do lote) só a quem vê a origem, e o custo do item só com
       `produtos.ver_custo`. Permissões do catálogo: `transferencias.ver`, `.criar` (criar, alterar e excluir o
       rascunho: não há `.editar`), `.enviar` (enviar e anotar a NF-e de fora) e `.cancelar`.
     - **Seletor de destino** (`GET /transferencias/destinos`, `transferencias.criar`; `DestinoTransferenciaOpcao` do
       shared): como o destino não precisa ser permitido e o `GET /estoques` só mostra os estoques visíveis (e exige
       `estoques.ver`), a tela do rascunho (F2-B27) lê daqui **todo estoque vivo e ativo** da empresa, sem o filtro dos
       permitidos — o expedidor do CD escolhe a Loja 2 que não enxerga, e a loja devolve os cascos ao CD —, com id,
       código, nome, tipo e a loja do estoque (a de menor código; nula no CD). Só a identificação: sem saldo nem custo,
       que continuam restritos aos estoques visíveis. A própria origem não sai da lista (a tela a esconde; o schema
       recusa origem = destino).
     - **Rascunho** (`transferencias.criar`): a origem existe, é permitida e está ativa; o destino existe e está ativo;
       o tipo de estoque ativo (vazio = o padrão, como o recebimento); a data não futura no fuso da **loja do estoque de
       origem** e, no estoque sem loja (o CD), no fuso da empresa (vazia = hoje nesse fuso); os itens com produto de
       saldo próprio (combo, serviço e produzido não; "Com variações" também não e a `variacaoId` tem de vir vazia
       enquanto as variações estão travadas, D43) e o lote do produto e da origem, ou sem estoque (`conferirLotesItens`,
       a regra do motor). Os itens são gravados como no recebimento: mantido = mesmo id, produto **e lote** (só a
       quantidade muda); trocar o produto ou o lote é excluir + inserir, para duas linhas que trocam de lote não
       colidirem no `uq_itens_transferencia_produto` no meio da gravação; `qtd_itens` sai das linhas vivas. `PUT` com a
       versão agregada (cabeçalho + itens, decisão 47; lida numa segunda instrução depois da trava, como o recebimento)
       e `DELETE` (exclusão lógica, `?versao=` opcional) só no rascunho (422 depois; o trigger repete a regra). O
       rascunho sem item é gravável, mas não se envia.
     - **Enviar** (`POST :id/enviar`, `transferencias.enviar`; `travaVersao`): confere de novo os dois estoques vivos e
       ativos e o tipo ativo (422 no campo, "troque … no rascunho ou reative"), os produtos e os lotes; trava as linhas
       de saldo da origem uma vez cada, em `ordenarChaves`, e confere o saldo (SYNC 15.1: o ERP não deixa negativo,
       salvo Master ou `estoque.permite_negativo_erp` da loja da origem — no CD, a da empresa —, como a Saída do
       acerto, sem a pergunta de confirmação do estorno: é uma saída pedida, não um estorno): a linha soma todos os
       itens do produto (422 em `itens.N.quantidade` com o saldo), e o item com lote também confere o saldo do lote.
       Um `TRANSF_SAIDA` por item pelo `lancarDocumento`, em `now()` (F2-B4), **ao custo médio vigente** da linha (a
       saída comum, ERP 13.1.4), com o lote informado ou, sem lote, dividido em **FEFO** pelo motor (F2-B6; um movimento
       por lote, todos com o `documento_item_id` do item; o item com lote da mesma linha reserva o lote antes), com a
       loja do estoque de origem (nula no CD) e a unidade do produto. Os movimentos passam pela `compensarDefinir` (a
       saída lançada antes de um "Definir" com a contagem um pouco à frente é anulada, como no acerto e no
       recebimento). O custo unitário de cada item (o do primeiro movimento: as partes FEFO saem pelo mesmo custo
       médio) é gravado **antes** de a situação sair do rascunho (o trigger só libera os itens nele), e a transferência
       passa a `em_transito` com quem e quando enviou. O destino não recebe nada até o F2-B24. **Idempotente** como o
       movimentar do recebimento: a já enviada (em trânsito ou recebida) devolve o detalhe sem lançar nem conferir a
       versão (o clique repetido, a resposta perdida e duas chamadas juntas — a trava do cabeçalho serializa e a
       segunda relê a situação); a cancelada é 422. Auditoria `movimentar` ("Transferência Nº … enviada: itens,
       movimentos e anulados por "Definir"") — o catálogo de ações não tem `enviar`, e criar uma ação nova exigiria
       migração do `ck_auditoria_acao`.
     - **Cancelar** (`POST :id/cancelar`, `transferencias.cancelar`, motivo obrigatório; `travaVersao`): do rascunho,
       sem efeito no estoque; do trânsito, um **`TRANSF_RETORNO`** de cada `TRANSF_SAIDA` ainda não estornado, com
       `estorno_de_id` = a saída (o `uq_movimentos_estoque_estorno` garante um estorno por movimento), no mesmo lote e
       **ao custo gravado nela** (o estorno de saída do T20: o valor que saiu volta igual, e o custo médio volta ao de
       antes quando nada entrou no meio), e um `ESTORNO_ACERTO` (sinal 0) de cada compensação que um "Definir" lançou
       contra as saídas (`compensacoesDoDocumento`, como o estorno do recebimento, decisão 160): o documento volta a
       não ter efeito nenhum. Sem regra de saldo negativo: o retorno é entrada e o estorno de cada compensação anula a
       entrada dela na mesma linha e lote; os retornos vão antes na ordem do documento. A recebida (ou com
       divergência) é 422 ("faça uma transferência no sentido inverso"; o retorno parcial do tratamento da divergência
       do F2-B24 também usa o `estorno_de_id`), e a já cancelada também (como o estorno repetido). Auditoria `cancelar`
       com o resumo e o motivo.
     - **NF-e de fora** (`PUT :id/nfe-externa`, `nfeExternaTransferenciaSchema`; `transferencias.enviar` e a origem
       permitida): anota a chave (DV conferido) e/ou o número e série em qualquer situação menos a cancelada (o trigger
       repete a regra; no rascunho também vai pelo `PUT`). Só anota, sem SEFAZ (D6). Auditoria `editar` com o antes e o
       depois.
     - **Travas novas** (o "saldo zero" não vê a mercadoria em trânsito, que não está no `saldos_estoque` de nenhuma
       das pontas): **inativar estoque** com transferência `em_transito` ou `recebida_divergencia` na origem ou no
       destino é 422 em `ativo` (a em trânsito ainda entra no destino ou volta à origem; a divergência ainda devolve a
       diferença); o rascunho não trava o estoque (o envio confere de novo). **Excluir estoque** usado em qualquer
       transferência viva é 422 ("inative em vez de excluir"), como o tipo usado em recebimento. **Inativar tipo de
       estoque** com transferência em rascunho, em trânsito ou com divergência no tipo é 422 (como o acerto e o
       recebimento em rascunho), e **excluir** o tipo usado em qualquer transferência também.
     - **Para o F2-B24** (feito; decisão 172): `enviarTransferencia` é exportada para o modo de uma etapa chamá-la na
       mesma transação; a entrada no destino deve repetir cada movimento da saída (lote e custo de cada parte FEFO, como
       a perna de entrada da mudança de tipo). O lote preso ao estoque de origem (`produtos_lotes.estoque_id` = a origem)
       não pode entrar no destino (MD 3.6.9; `ErroLoteInvalido`): o F2-B24 decide entre entrar sem lote ou no lote do
       mesmo código do destino (ou sem estoque).
     Testes: `transferencias.test.ts` (integração: o critério de pronto — 60 unidades do CD a R$ 4,70 de custo médio
     com saldo 100 saem a R$ 4,70 com o item, o saldo e o destino conferidos, e o cancelamento devolve 60 a R$ 4,70 com
     o custo médio igual —; o retorno ao custo da saída com o custo médio mudado no meio, (20 × 7 + 10 × 6) / 30; o envio
     sem saldo recusado no item sem lançar nada e aceito com a chave da empresa e pelo Master; o envio com a versão velha
     (409), repetido e simultâneo sem segunda saída; o lote de outro estoque recusado, o lote sem saldo recusado e a
     divisão FEFO com o lote informado reservado (o lote informado é o que vence primeiro e o item sem lote vem antes
     no documento: sem a reserva, a FEFO o esvaziaria), com o retorno de cada parte ao seu lote; o "Definir" com a contagem à
     frente que anula a saída e o cancelamento com o `ESTORNO_ACERTO`, sem movimento contra o sinal do catálogo; o
     cancelamento do rascunho e a recebida que não se cancela; o rascunho com o tipo e a data padrão, a alteração com o
     item mantido, a versão, a exclusão e o envio sem item; as conferências do cabeçalho e dos itens; quem vê e quem
     grava; o seletor de destino (a Loja 2 e o CD fora dos permitidos, o inativo de fora, 403 sem
     `transferencias.criar`); a NF-e de fora; as travas do estoque e do tipo (a exclusão do tipo usado só num rascunho,
     sem movimento nem acerto, recusada pela trava da transferência); o envio da Loja 1 disparado junto da venda do PDV
     na Loja 1, 20 vezes, os dois terminando com o saldo certo e o saldo novo no pull do fluxo `estoque` — o envio e o
     push pegam a 7300001 como primeira trava e rodam em série, então o teste não confere a ordem das travas de linha
     (`ordenarChaves`), só que os dois convivem; os itens do rascunho vão fora da ordem crescente e a venda na inversa —;
     e o `conferirRazaoDoBanco` no fim).
172. **Transferência entre estoques: receber, tratar a divergência e o modo de uma etapa** (Fase 2, F2-B24; ERP 13.7
     "Divergência" e "Uma etapa"; MD 3.7.6, 3.6.9; T20; F2-Q10 = D51 e D61 do roadmap; `src/transferencias/recebimento.ts`
     (novo), as rotas em `transferencias.controller.ts`, `lancarPerdaTransferencia`/`exigirAcertoEstornavel` em
     `src/estoques/acertos.ts`). **Sem migração**: as colunas do recebimento e do tratamento, os triggers de etapa e os
     contratos (`receberTransferenciaSchema`, `tratarDivergenciaTransferenciaSchema`, `situacaoAposRecebimento`) são do
     F2-B22 (decisão 170), e o seed já tinha `TRANSF_ENTRADA` (+1) e a origem de acerto `perda_transferencia`. Fecha o
     segundo item da Definição de pronto da Fase 2. Rotas novas: `POST /transferencias/:id/receber` e
     `POST /transferencias/:id/tratar-divergencia`.
     - **As partes da saída.** O envio (decisão 171) lança um `TRANSF_SAIDA` por item ou, no item sem lote de produto
       com saldo de lote, um por lote da divisão FEFO, todos com o `documento_item_id` do item e o mesmo custo médio. A
       entrada no destino **repete cada parte** (o lote e o custo dela, como a perna de entrada da mudança de tipo,
       decisão 153), e a quantidade recebida do item enche as partes **na ordem do lançamento** (`repartirRecebida`,
       função pura com teste unitário): o lote que vence primeiro chega primeiro, e o que faltou fica nas últimas
       partes. O tratamento da diferença refaz a mesma conta a partir das saídas e da recebida gravada (sem coluna
       nova) e devolve de cada parte o que faltou dela.
     - **Receber** (`POST :id/receber`, `transferencias.receber`; `travaVersao`): exige o **destino** entre os estoques
       permitidos para movimentar (403; quem só tem a origem não recebe pela loja, e quem não vê nenhum dos dois tem
       404). A quantidade conferida de **todos** os itens (o item que falta é 422 com o nome dos produtos: o esquecido
       não vira "recebido como enviado" sem ninguém conferir), ou "Receber tudo como enviado" (`receberTudo`); a
       recebida acima da enviada é 422 no item ("faça outra transferência"), e o item de outra transferência também.
       A recebida é gravada nos itens **antes** de a situação sair do trânsito (o trigger só a libera nele); um
       `TRANSF_ENTRADA` por parte com quantidade recebida, em `now()` (F2-B4), **ao custo unitário da parte** (o custo
       da saída: o custo médio do destino é refeito pela média ponderada), com a loja do estoque de destino (nula no
       CD) e a unidade da saída, passado pela `compensarDefinir` (o "Definir" do destino com a contagem um pouco à
       frente); a situação passa a `recebida` ou, com algum item a menor, `recebida_divergencia`
       (`situacaoAposRecebimento`), com quem e quando recebeu. A entrada não deixa saldo negativo: sem regra de
       negativo. **Idempotente** como o envio: a já recebida (com ou sem divergência) devolve o detalhe sem lançar nem
       conferir a versão; o rascunho ("ainda não foi enviada") e a cancelada são 422. Auditoria `movimentar` na loja
       do destino ("Transferência Nº … recebida [com divergência]: itens, movimentos, itens a menor, lotes criados e
       anulados por "Definir"").
     - **Lote preso ao estoque de origem** (decidida pelo dono em 06/11/2026, D61): o lote com
       `produtos_lotes.estoque_id` = a origem não vale no destino (MD 3.6.9; `ErroLoteInvalido`). A entrada vai ao lote
       do **mesmo código** do produto no destino (o vivo antes do excluído; entre os vivos, o preso ao destino e
       depois o sem estoque, a ordem em que o recebimento acha o lote digitado, e o ativo antes do inativo), com a
       validade e a fabricação que faltarem completadas e reativado se estava inativo ou excluído (o excluído só sem
       nenhum vivo do mesmo código: o cadastro deixa excluir o lote sem histórico e digitar o código de novo, e
       reativá-lo ao lado do vivo daria duas linhas vivas com a mesma chave, 23505); sem ele, um lote novo **preso ao destino** com o código, a validade, a fabricação e o
       fornecedor do de origem (`loteNoDestino`). O do mesmo código já cadastrado no destino com **outra validade (ou
       fabricação)** recusa o recebimento no item (422 em `itens.N.loteId`, N = a posição no documento, "corrija o
       cadastro do lote antes de receber"): juntar duas validades num lote só inventaria um lote errado, e entrar sem
       lote perderia a validade. O lote sem estoque (o que o recebimento e a NF-e criam) entra como está. Alternativas
       que o dono pode escolher: entrar sem lote no destino, ou sempre criar o lote no destino sem estoque.
     - **Tratar a divergência** (`POST :id/tratar-divergencia`, `transferencias.receber`; `travaVersao`, versão
       conferida quando informada): só na `recebida_divergencia` (422 nas outras: "não tem diferença a tratar"); por
       item, uma vez cada (o item recebido como enviado, o já tratado e o de outra transferência são 422 em
       `itens.N.itemId`; o trigger repete a regra). Exige a **origem ou o destino** entre os permitidos para movimentar
       (decidida pelo dono em 06/11/2026, D61: quem recebeu e conferiu ou quem enviou decide; os movimentos são todos
       na origem, e no "perda" o saldo dela não muda). Para cada item, um **`TRANSF_RETORNO`** na origem por parte com
       diferença, com `estorno_de_id` = a parte, no lote dela e **ao custo dela** (o estorno de saída do T20, como o
       cancelamento), em `now()`, passado pela `compensarDefinir`. **"Baixar como perda"** (F2-Q10 = D51, padrão até a
       confirmação do dono): depois dos retornos, **um** acerto de **Saída** na origem para a chamada
       (`lancarPerdaTransferencia`: origem `perda_transferencia`, `origem_id` = a transferência, motivo
       `MOTIVO_PERDA_TRANSFERENCIA` "Perda em transferência", responsável = quem tratou, observação com o Nº), com
       um item por produto × lote somando as partes (`uq_itens_acerto_estoque_produto`), efetivado na hora pelo
       `efetivarAcerto`. Cada retorno é baixado por um `ACERTO_SAIDA` que o **estorna** (`estorno_de_id` = o
       `TRANSF_RETORNO`; `saidaDaPerdaTransferencia` no shared, o único `ACERTO_SAIDA` com estorno): na linha e **no
       lote** do retorno, sem a divisão FEFO (estorno não se divide), e **ao custo dele**, com a conta inversa da média
       ponderada (`saidaAoCusto`, a mesma do estorno da mudança de tipo, decisão 153; o motor e o replay do razão
       decidem por `saidaAoCustoInformado`). Antes, a perda da parte que saiu sem lote ia ao motor como Saída sem lote
       e era dividida em FEFO pelos lotes com saldo na hora do tratamento (o lote B que entrou pela NF-e depois do envio
       perdia unidades que nunca saíram, e a sobra sem lote ganhava as que não existem), e saía ao custo médio já
       misturado com o retorno (com uma compra entre o envio e o tratamento, o custo médio e o valor do CD mudavam num
       documento só interno). Assim o par retorno + perda tem efeito líquido **zero** no saldo, no saldo de cada lote e
       no custo médio da origem, e a perda fica registrada **ao custo do envio** (o valor que de fato se perdeu no
       caminho). Sem saldo que sobre ou com o médio que ficaria ≤ 0, a conta inversa não vale e a saída é a comum, ao
       custo médio vigente (o retorno também não tinha mexido no médio, T20). A saída da perda não passa pela regra do
       saldo negativo (é a baixa obrigatória do que acabou de voltar, não uma saída pedida). A lista de compensações do
       acerto (`compensacoesDoAcerto`) inclui as que um "Definir" lançou contra essas saídas (o `estorno_de_id` delas
       não é o estorno de um movimento do próprio acerto). O tratamento e a hora vão nos itens e, sem diferença pendente, a
       transferência passa a `recebida`. Auditoria `movimentar` na loja da origem ("Diferença da transferência Nº …
       tratada: …, acerto Nº …") e, para o acerto, `criar` e `efetivar` em `acertos_estoque`, como o "Ajustar" do
       produto (decisão 157).
     - **O acerto da perda não se estorna** pela tela de acertos (`exigirAcertoEstornavel`, 422): faz parte do
       documento da transferência, e estorná-lo deixaria o retorno valendo na origem com o item dizendo "Baixar como
       perda" (para devolver a mercadoria, uma Entrada). Ele aparece na listagem de acertos com a origem "Perda na
       transferência".
     - **Um estorno por movimento.** O retorno da diferença é o estorno (parcial) da parte que saiu, então a parte
       devolvida em parte já não se estorna de novo (`uq_movimentos_estoque_estorno`, migração 0013): a recebida não se
       cancela (decisão 171), e nem um cancelamento forçado lançaria um segundo retorno da mesma saída.
     - **Modo de uma etapa** (`estoque.transferencia_recebimento_automatico`, padrão Não, chave **da empresa**:
       Configurações › Geral; o catálogo não a aceita por loja, MD 3.1.2 e ERP 9.0, então ligada vale para toda
       transferência da empresa, inclusive CD → loja distante; quem quiser o modo só entre estoques do mesmo endereço
       pede a chave por loja, que é uma mudança de catálogo): o `POST :id/enviar` chama o
       `receberTransferencia` logo depois do `enviarTransferencia`, **na mesma transação**, com "Receber tudo como
       enviado" e quem enviou como quem recebeu (a situação passa pelo trânsito, como o trigger exige). A chave é a
       autorização (ERP 13.7: "para estoques do mesmo endereço"): quem envia **não precisa** do destino permitido nem
       de `transferencias.receber`. Um lote que não pode entrar no destino recusa o envio inteiro (nada é lançado).
       Auditoria do envio e, à parte, a do recebimento ("recebida no envio (recebimento automático)").
     - **PDV:** nada muda no protocolo nem no `Esquema.g.cs`; os saldos novos das duas pontas descem pelo fluxo
       `estoque` (o PDV de cada loja recebe só o saldo vendável do estoque da sua loja).
     Testes: `recebimento.spec.ts` (a repartição: uma parte, a divisão FEFO, 3 casas) e `transferencias.test.ts`
     (integração: o critério de pronto — CD → Loja 2 com 10 enviados a R$ 5,00 e 8 recebidos, tratado como retorno (o
     CD volta a 22, a Loja 2 fica com (4 × 6 + 8 × 5) / 12 = R$ 5,3333, o retorno com `estorno_de_id` = a saída) e
     como perda (o CD fica igual, o acerto de Saída de R$ 10,00 com a origem `perda_transferencia`, que estorna o
     retorno e não se estorna), quem recebe e quem trata, o recebimento repetido, as auditorias e o saldo novo no pull
     do PDV da Loja 2 —; a versão velha (409, sem lançar nada) no receber e no tratar, e o tratamento parcial (um item
     tratado deixa a `recebida_divergencia` com "ainda há diferença a tratar", o mesmo item de novo é 422 "já foi
     tratada", o outro conclui); a perda da sobra sem lote da divisão FEFO com um lote novo entrando no CD antes do
     tratamento (o saldo de cada lote do CD não muda) e com uma compra a outro custo no meio (o custo médio do CD volta
     ao de antes, e a perda fica ao custo do envio); a conferência de todos os itens, a recebida acima da enviada, o
     item de fora, o rascunho, o item com nada recebido e o "Receber tudo como enviado"; a divisão FEFO repartida em
     ordem e o retorno parcial que impede o cancelamento, com o segundo estorno da mesma saída recusado pelo banco; o
     casco vazio (Vasilhame vazio) da Loja 1 para o CD; o lote preso à origem no recebimento em duas etapas (o sem
     estoque do mesmo código usado, o preso ao destino inativo e sem validade reativado e completado, o vivo escolhido
     com um excluído do mesmo código ao lado, e o de outra fabricação recusado com a transferência ainda em trânsito e
     a recebida sem gravar); o modo de uma etapa Loja 1 → Loja 2 com a chave da empresa (recusada por loja), o lote
     preso à origem (o lote novo preso ao destino, o reaproveitado na segunda vez e o de outra validade recusado sem
     lançar nada) e o saldo novo nos PDVs das duas lojas; e o `conferirRazaoDoBanco` no fim).
173. **Transferência: sugestão de reposição** (Fase 2, F2-B25; ERP 13.7 "Sugerir reposição"; MD 3.6.9, 3.6.5; F2-Q11 =
     D52 do roadmap, **decidida pelo dono em 06/11/2026**; `src/transferencias/reposicao.ts` e `em-transito.ts` (novos),
     a rota em `transferencias.controller.ts`, a chave em `packages/shared/src/configuracoes.ts`). **Sem migração**: o
     contrato (`sugestaoReposicaoSchema`, `SugestaoReposicao`) é do F2-B22 (decisão 170), só com o `?tipoEstoqueId=`
     vazio passando a valer o padrão; a chave nova não tem seed (só existe linha para o valor diferente do padrão).
     Rota nova: `GET /transferencias/sugestao-reposicao?origem&destino[&tipoEstoqueId]`, declarada antes de `:id`.
     - **Acesso** (as conferências de quem cria o rascunho, `conferirCabecalhoTransferencia`, e mais uma):
       `transferencias.criar`, a **origem** entre os estoques permitidos para movimentar (403 em `estoqueOrigemId`) e
       ativa, o **destino** ativo e **entre os estoques permitidos para ver** (403 em `estoqueDestinoId`), e o tipo de
       estoque ativo (vazio = o padrão). O destino permitido é o que difere do rascunho (que aceita qualquer destino
       ativo, decisão 170): a sugestão mostra o saldo, o em trânsito, o mínimo e o máximo do destino, e a própria
       quantidade (máximo − saldo − em trânsito) os entrega, então o destino fora dos permitidos vazaria o saldo de uma
       loja que o usuário não vê (D45; decisões 89 e 149). O expedidor do CD que monta a carga tem em
       `usuarios_estoques` os estoques das lojas que abastece. **Todos os erros saem nos campos do rascunho**
       (`estoqueOrigemId`, `estoqueDestinoId`, `tipoEstoqueId`), de onde a tela (F2-B27) pede a sugestão, inclusive os
       do schema: `validarSugestaoReposicao` traduz `origem` → `estoqueOrigemId` e `destino` → `estoqueDestinoId`
       (parâmetro faltando ou malformado, e origem = destino, o `.refine` do schema, em `estoqueDestinoId`). Só
       leitura, sem auditoria: quem grava o rascunho confere tudo de novo (`gravarItensTransferencia`). O custo do
       produto na opção só com `produtos.ver_custo`.
     - **Quem entra**: os produtos da loja do estoque de destino (a de menor código, `lojaDoEstoque`) com
       `produtos_lojas.estoque_minimo` preenchido, vivos, ativos, ativos na loja (`ativo_na_loja`) e que controlam
       estoque, **abaixo do mínimo** contando o que está a caminho: `saldo + em trânsito < mínimo` (o mesmo `<` do
       filtro "Abaixo do mínimo" dos saldos; o que já foi mandado e não chegou não é pedido de novo, nem dispara a
       sugestão). Ficam de fora o combo, o serviço e o produzido (sem saldo próprio, `TIPOS_SEM_ESTOQUE`) e o "Com
       variações" (saldo por variação, travado pelo D43). Saldo do destino, saldo da origem e em trânsito são os do
       **tipo de estoque** pedido (o Vasilhame vazio repõe os cascos com o saldo de cascos), sem variação. Ordem: nome.
       **Destino sem loja** (o CD): sugestão vazia com aviso (o mínimo e o máximo são da loja).
     - **A conta** (`calcularReposicao`, função pura em decimal com teste unitário): falta = `máximo − (saldo + em
       trânsito)` ou, sem máximo, `mínimo × 2 − (saldo + em trânsito)`; o produto sem fração (`permite_fracao` falso)
       sobe ao inteiro; com `estoque.reposicao_arredonda_embalagem` (bool, padrão **Sim**, da empresa), sobe ao
       próximo múltiplo do fator da **embalagem de compra de maior fator** do produto (o código de barras vivo com
       `usa_compra`, sem variação e fator > 1; empate pelo principal e pelo código), que volta em `embalagem` com a
       sigla da unidade (nula = em unidades); por fim, **nunca passa do saldo da origem** (o negativo conta como zero;
       sem fração, o saldo desce ao inteiro) — o limitado ao saldo pode ficar fora do múltiplo do fardo: é o que o CD
       tem. Mínimo 24, máximo 72, saldo 10 e 12 em trânsito → 50, ou 60 com o fardo de 12 (o critério de pronto).
     - **Avisos**: o produto abaixo do mínimo sem saldo na origem sai da lista (a grade não aceita quantidade zero) e
       é citado ("N produtos abaixo do mínimo ficaram de fora por não ter saldo na origem: …", os 5 primeiros nomes e
       "e mais N"); acima de `LIMITE_ITENS_TRANSFERENCIA` (990) itens, ficam os primeiros por nome, com aviso.
     - **Em trânsito reaproveitável** (`sqlEmTransito` em `em-transito.ts`): a subconsulta da soma das quantidades
       **enviadas** dos itens das transferências `em_transito`, por estoque de destino, tipo de estoque, produto e
       variação, com filtros opcionais de destinos, produtos e tipo (usa o `ix_transferencias_estoque_destino_status`).
       Não contam o rascunho, a cancelada, a recebida nem a `recebida_divergencia` (a diferença a menor é a
       "divergência a tratar", pendência separada). A coluna "Em trânsito" do produto e dos saldos (F2-B26) usa a
       mesma subconsulta.
     - **F2-Q11 = D52** (decidida pelo dono em 06/11/2026): arredondar ao fardo ou à caixa fechada (a recomendação (a)
       do plano). Alternativa: desligar a chave (Configurações › Geral › Estoque, "Sugestão de reposição arredonda para
       a embalagem de compra"), e a sugestão sai em unidades; o em trânsito é descontado sempre.
     - **Testes**: unitário da conta (`reposicao.spec.ts`: com e sem máximo, em trânsito, arredondamento, fator 1,
       limite ao saldo da origem, negativo, frações de 3 casas, produto sem fração), dos avisos e do corte
       (`limitarSugestao`: singular, plural, "e mais N" e o corte em `LIMITE_ITENS_TRANSFERENCIA`) e dos erros da query
       nos campos do rascunho (`validarSugestaoReposicao`), e integração
       (`test/integracao/transferencias-reposicao.test.ts`): o critério de pronto com `produtos_lojas` e o fardo de 12
       (a embalagem só de venda de fator 24 ignorada), o em trânsito só das `em_transito` para o destino (o rascunho,
       a cancelada, a recebida e a de outro destino não contam), a chave desligada (50 em unidades), o limite ao saldo
       do CD (55) e a sugestão gravada como rascunho sem retoque; sem máximo, o limite e o aviso do sem saldo na
       origem, e de fora o produto no mínimo, o sem mínimo na loja (o da outra loja não conta), o inativo na loja, a
       embalagem excluída, o inativo, o excluído, o que não controla estoque (simples), o serviço, o combo, o
       produzido e o "Com variações" (cada filtro sozinho); o tipo de estoque (Vasilhame vazio, com o em trânsito do
       tipo: o casco abaixo do mínimo no Disponível não desconta os vazios a caminho) e o tipo inexistente; o destino
       sem loja, a origem fora dos permitidos (403 em `estoqueOrigemId`), o destino que o usuário não vê (403 em
       `estoqueDestinoId`), sem `transferencias.criar` (403), origem = destino, parâmetro faltando ou malformado (422
       nos campos do rascunho) e destino inativo (422).
174. **Transferência: "Em trânsito", "Divergência a tratar" e o alerta da transferência parada** (Fase 2, F2-B26; ERP
     8.2.11, 13.7, 16.4; MD 3.1.2, 3.1.8; padrão "divergência separada" do plano da Fase 2, aplicado sem pergunta;
     `src/transferencias/em-transito.ts` e `alertas.ts` (novo), as consultas de `GET /produtos/:id/saldos` e
     `GET /saldos-estoque`, a fila `genesis-alerta-transferencias` em `src/infra/fila.ts` e `src/servicos.ts`, a chave em
     `packages/shared/src/configuracoes.ts`). **Sem migração**: as tabelas e os índices são do F2-B22 (decisão 170), e a
     chave nova não tem seed (só existe linha para o valor diferente do padrão, como a da decisão 173).
     - **Em trânsito** (`sqlEmTransito`, o mesmo da sugestão de reposição, decisão 173): a soma das enviadas das
       transferências `em_transito`, no estoque de **destino** × tipo da transferência. Fica fora de qualquer saldo
       (ERP 13.7: "a quantidade não está em nenhum estoque").
     - **Divergência a tratar** (`sqlDivergenciaATratar`): a soma de `itens_transferencia.diferenca` (enviada −
       recebida) dos itens **sem tratamento** das transferências `recebida_divergencia`, uma pendência **separada**: não
       conta como em trânsito nem como saldo, e a sugestão de reposição não a desconta. Fica no estoque de **origem** ×
       tipo: o tratamento (decisão 172) lança tudo nela ("Retornar à origem" devolve a diferença ao saldo dela; "Baixar
       como perda" devolve e baixa), e ao destino ela não chega mais (o em trânsito dele zerou no recebimento, e a
       sugestão volta a pedir o que faltou). A diferença por item basta: a repartição pelas partes da saída (o lote de
       cada uma) só importa para o próprio tratamento, que a refaz das saídas e da recebida gravada. Alternativa que o
       dono pode pedir: mostrar a divergência também (ou só) no destino.
     - **As colunas** (`emTransito` e `divergenciaATratar`, `numeric(15,3)` em texto, zero sem pendência, nos contratos
       `SaldosProduto` e `SaldoEstoqueLinha` do shared): `sqlPendenciasTransferencia` junta as duas por estoque × tipo ×
       produto × variação, e `sqlSaldosComPendencias` devolve as linhas de `saldos_estoque` **mais uma linha zerada**
       para cada chave só com pendência — as 60 unidades a caminho de uma loja que nunca recebeu o produto aparecem nela
       com saldo zero e "Em trânsito: 60" (o critério de pronto), no produto e na listagem, também no filtro do tipo de
       estoque e com "Incluir produtos sem movimento". No produto, somadas as variações como o saldo (travadas, D43). Os
       **estoques permitidos** (decisão 149) valem como no saldo: quem não vê o destino não vê o que está a caminho dele,
       e quem não vê a origem não vê a divergência dela. As linhas zeradas entram na situação "Zerado" e não mudam os
       totais (custo e venda são do saldo).
     - **O alerta** `TRANSFERENCIA_PARADA` (aviso; `ALERTA_TRANSFERENCIA_PARADA` no shared): a transferência em trânsito
       há mais de `estoque.transferencia_alerta_dias` (inteiro de 1 a 365, padrão **3**, chave da empresa: Configurações ›
       Geral › Estoque) desde o envio, ou recebida com divergência e com item ainda sem tratamento há mais desses dias
       desde o recebimento. Um aberto por transferência e situação (`transferencia_parada:<id>:<situação>`, o
       `uq_alertas_chave_deduplicacao`), no documento (`entidade = 'transferencias_estoque'`), na loja do **destino** no
       trânsito (quem tem de receber) e na da **origem** na divergência (onde o tratamento lança), nula no CD (a loja de
       um estoque é a de menor código, `lojaDoEstoque`); `dados` com a situação, o Nº, os dias, o prazo, as pontas, o
       tipo, os itens e a quantidade pendente. A varredura seguinte **atualiza** o aberto (título, mensagem, dias), sem
       abrir outro. Fecha sozinho quando a transferência sai da situação: na própria transação do receber (o do
       trânsito; a divergência, se houver, conta o prazo do recebimento), do último item tratado e do cancelar
       (`resolverAlertasTransferencia`, com a resolução "Transferência recebida", "… recebida com divergência",
       "Diferença tratada" ou "… cancelada") e, por garantia, na varredura seguinte (a transição feita por fora da API).
       A varredura fecha também o aberto cuja transferência continua na situação mas voltou para dentro do prazo porque
       a chave **aumentou** ("Prazo do alerta alterado"; sem isso ele ficaria congelado com os dias e o prazo antigos);
       quando o prazo novo vence, abre outro. O rascunho não alerta. O painel mínimo do Dashboard (C14) mostra só os críticos com tela de decisão; este alerta
       aparece no painel completo da Fase 5 e na tela de transferências (F2-B27).
     - **A varredura** (`AlertaTransferencias`): a cada hora (`CRON_ALERTA_TRANSFERENCIAS = '23 * * * *'`, o `schedule`
       do pg-boss, um job por ocorrência mesmo com várias instâncias), em cada empresa ativa ou suspensa (em manutenção
       ou migrando fica para a próxima), uma transação curta por empresa, uma execução por vez (trava consultiva
       `genesis:alerta_transferencias` no controle), por `trabalhoPorEmpresas` (a empresa com erro vai para o log e faz o
       job falhar no fim). O prazo e os dias pelo relógio do banco (`now()`); a data na mensagem no fuso da loja do
       alerta e, sem loja (o CD), no da empresa (ERP 1.5; `fusoDaEmpresa` de `src/comum/fuso.ts`). De hora em hora basta
       para um prazo em dias, e o alerta não espera o dia seguinte. As transferências escolhidas são lidas com
       `for share of t skip locked`: a que um receber, tratar ou cancelar está mudando (o controller a lê com
       `for update`) fica para a próxima varredura, e a que mudou depois da foto do comando é relida pelo Postgres na
       versão nova. Sem a trava, a varredura que leu a transferência ainda parada reabria o alerta que o recebimento
       acabara de fechar (o índice parcial da chave já não acha o aberto, e o `insert` grava outro).
     - **PDV:** nada muda (`alertas` e as transferências não descem; o `Esquema.g.cs` não muda).
     - **Testes** (`test/integracao/transferencias-em-transito.test.ts`): o critério de pronto (60 enviados do CD para a
       Loja 2 sem saldo lançado: a linha zerada com "Em trânsito: 60" no produto e na listagem; 2 dias não alertam; 4
       dias abrem um alerta só, na Loja 2, com os dados; a varredura repetida o mantém com os dias atualizados); o
       recebimento a menor (50 de 60: o trânsito zera, os 10 viram divergência a tratar no CD, fora do saldo; o alerta
       do trânsito fecha no recebimento; o da divergência conta do recebimento, sem loja no CD, e fecha no tratamento,
       com o CD de volta a 50); o rascunho antigo e a transferência dentro do prazo sem alerta; o cancelamento fechando
       o alerta e tirando o trânsito; a chave com 1 dia; a varredura fechando o alerta da transição feita por fora; o
       tipo de estoque (os cascos vazios a caminho do CD só no Vasilhame vazio, com e sem o filtro do tipo e com
       "Incluir produtos sem movimento"); os estoques permitidos (quem só tem a Loja 1 não vê o trânsito da Loja 2 nem
       a divergência do CD); o recebimento integral fechando o alerta com "Transferência recebida"; a data da mensagem
       no fuso da empresa (Manaus, para o CD) e no da loja (Rio Branco, para a Loja 2), às 23:30 locais, que em
       Brasília já seriam o dia seguinte; o prazo aumentado de 3 para 10 dias fechando o aberto e reabrindo aos 11; e a
       varredura com a transferência travada por outra transação (que a cancela e fecha o alerta sem confirmar): não
       espera nem reabre o alerta.

175. **Transferência: o que as telas leem (dados da grade, embalagem, alerta aberto e romaneio)** (Fase 2, F2-B27; ERP
     13.7 "Imprime romaneio"; padrão "impressão pelo navegador" do plano da Fase 2; `src/transferencias/romaneio.ts`
     (novo), `transferencias.ts` e o controller; contratos em `packages/shared/src/transferencias.ts`). **Sem migração**
     e sem mudança no PDV (`Esquema.g.cs` igual). Só leitura; as telas são do ERP (README do ERP › decisão 64).
     - **`GET /transferencias/dados-produtos?estoqueOrigemId&tipoEstoqueId&produtoIds`**
       (`consultaDadosProdutosTransferenciaSchema`, até 200 ids por consulta; a tela consulta em blocos de 100): por
       produto, o **saldo na origem** × tipo (zero sem linha), a **embalagem** de compra e os **lotes** ativos (ou com
       saldo) que são da origem ou sem estoque, em FEFO — os mesmos que o envio aceita (`conferirLotesItens`). Exige
       `transferencias.criar` e a origem entre os estoques permitidos para movimentar (403 no campo `estoqueOrigemId`,
       a conferência do rascunho). Existe porque o `/saldos-estoque/itens` e o `/saldos-estoque/lotes` (que a grade do
       acerto usa) exigem `estoque_acertos.ver`, que o expedidor do CD pode não ter. O tipo informado não precisa estar
       ativo (o rascunho gravado com um tipo inativado depois continua mostrando o saldo); vazio = o padrão.
     - **Embalagem** (`EmbalagemTransferencia`, `sqlEmbalagemTransferencia`): a embalagem de compra viva (`usa_compra`)
       de **maior fator > 1** do produto, sem variação — a mesma da sugestão de reposição (decisão 173, que passou a usar
       o mesmo SQL). Vai em cada item do detalhe (`ItemTransferenciaDetalhe.embalagem`), nos dados da grade e no
       romaneio, para a quantidade aparecer em fardos fechados e avulsas ("5 FD + 3 UN", `quantidadeEmEmbalagens` no
       shared). É a embalagem **de agora** (o item não grava a embalagem): o documento é em unidades do produto, e a
       embalagem só ajuda quem conta a carga.
     - **Alerta aberto no detalhe** (`TransferenciaDetalhe.alertaParada`): o `TRANSFERENCIA_PARADA` ainda aberto da
       transferência (decisão 174) — situação, título, mensagem, dias e quando abriu —, achado pelas duas chaves de
       deduplicação (`transferencia_parada:<id>:<situação>`, o índice parcial dos abertos), o mais recente. A tela o
       mostra no topo sem o painel de alertas da Fase 5. Quem vê a transferência vê o alerta dela (a loja do alerta não
       filtra: é o mesmo documento).
     - **Quem tem cada ponta no detalhe** (`TransferenciaDetalhe.origemPermitida` e `destinoPermitido`): a origem e o
       destino entre os estoques permitidos **para movimentar** de quem lê (`estoquePermitido`), as mesmas conferências
       das ações (gravar, excluir, enviar, cancelar e a NF-e com a origem; receber com o destino; tratar com um dos
       dois). A tela tira os botões daqui, e não da lista de estoques: o estoque **inativado** depois do rascunho (o
       rascunho não impede a inativação, decisão 171) continua sendo de quem o tem, que exclui, cancela ou troca a
       origem por uma ativa, como a própria mensagem do envio orienta.
     - **`GET /transferencias/origens`** (`OrigemTransferenciaOpcao`: a identificação do destino mais `ativo`): os
       estoques vivos permitidos para movimentar de quem está na tela, **também os inativos**, marcados (Master e
       `estoques.todos`: todos). Exige só `transferencias.ver`: o seletor "Origem" do rascunho (os ativos, mais a origem
       gravada) e o filtro "Estoque origem" da listagem. Existe porque o `GET /estoques` exige `estoques.ver` (o
       cadastro de locais), que o conferente da loja (`transferencias.ver` e `receber`) ou o expedidor do CD num perfil
       personalizado pode não ter: sem ela a tela ficava sem Receber, sem a origem e sem os botões. O `GET
       /transferencias/destinos` passou a usar a mesma consulta (`estoquesDaTransferencia`), só com os ativos.
     - **`GET /transferencias/:id/romaneio`** (`RomaneioTransferencia`): o **cabeçalho da empresa** (razão social,
       fantasia, CNPJ, IE, endereço montado de `empresa` + `municipios`, telefone), as **duas pontas** (o estoque, a loja
       dele — a de menor código, nula no CD — com razão social e CNPJ, e o endereço: o do cadastro do estoque ou, sem ele,
       o da loja), o documento (o mesmo detalhe, com as regras de quem vê: a origem **ou** o destino visível, 404 fora
       dos dois) e a hora em que foi gerado. Exige só `transferencias.ver`, **não** `empresa.ver`: são os dados que saem
       no papel que acompanha a carga, e a loja que recebe também imprime o seu.
     - **Testes** (`test/integracao/transferencias.test.ts` › "telas", `transferencias-em-transito.test.ts`): os dados
       da grade (o saldo, só o lote do CD — o preso à Loja 2 fica fora —, o fardo de 12 entre o de 6 e a caixa só de
       venda, o produto sem embalagem), o 403 no campo para quem não tem a origem e o 422 sem produtos; a embalagem nos
       itens do detalhe; o romaneio pela loja que recebe (empresa, CD sem loja, Loja 2 com CNPJ e endereço montado, os
       itens com o fardo), o 404 de quem não vê nenhuma ponta e o endereço do estoque valendo mais que o da loja; o
       `alertaParada` no detalhe aberto no trânsito, nulo depois do recebimento e de novo aberto na divergência; os
       **perfis personalizados** sem `estoques.ver` nem `estoque_acertos.*` (o `GET /estoques` dá 403 a eles): o
       expedidor do CD lê os dados da grade (200), o conferente sem `transferencias.criar` recebe 403 neles, as origens
       de cada um (o Master também com o inativo marcado; sem `transferencias.ver`, 403), `origemPermitida` e
       `destinoPermitido` no detalhe de cada um, o conferente recebendo tudo como enviado, e o rascunho com a origem
       inativada depois, ainda da origem e excluído.

176. **Desempenho do razão: massa de carga, planos de consulta, os índices da 0026 e "sem particionamento na Fase
     2"** (Fase 2, F2-B28; MD 3.7.2; implantação de 03/11/2026, 2 GB; `test/carga/massa-razao.ts` (novo),
     `src/estoques/indices-razao.ts` (novo), `drizzle/empresa/0026_indices_razao.sql`, `PREPARACOES_MIGRACAO_EMPRESA`).
     Medido **antes** de escrever os relatórios do PR-7 (F2-B29 a F2-B33), para que eles já nasçam com os índices.
     O PDV não muda (`movimentos_estoque` não desce; `Esquema.g.cs` igual).
     - **Massa** (`pnpm --filter api carga:razao`, fora do CI): ambiente descartável no PostgreSQL de `DATABASE_URL`
       (o dos testes de integração), uma empresa com 3 lojas, o CD (estoque `deposito` sem loja) e a Treino, 2.000
       produtos e **4 milhões de movimentos em 12 meses** (01/11/2025 a 01/11/2026), em ordem de lançamento, pela
       regra do motor (`aplicarMovimentoNoSaldo`, a do replay) e gravados em lotes de 5.000 por `unnest` (o COPY
       pediria outro pacote); a projeção é a do fim de cada linha, e o replay do recalcular no fim confere as duas
       (**0 divergência**: a massa é um razão válido). Determinística (`--semente`). Mistura: VENDA_PDV 92% (cupons de
       1 a 4 itens, popularidade de Zipf, 1% offline tardia até 48 h), TRANSF_SAIDA e TRANSF_ENTRADA 2,4% cada (a
       reposição da loja pelo CD), CANC_VENDA_PDV 0,7% (estorno ao custo da venda), RECEB_NFE 0,6%, ACERTO_DEFINIR
       0,5% (com o inventário inicial de cada estoque), ACERTO_ENTRADA/SAÍDA 0,6%, RECEB_MANUAL 0,3%,
       ACERTO_COMPENSACAO 0,3%; por estoque: Loja 1 1,62 M, Loja 2 1,28 M, Loja 3 0,93 M, CD 0,11 M, Treino 0,06 M;
       12.157 linhas de saldo. Tabela de 1.077 MB; os índices que ela já tinha somam de ~2,5 a ~3,2 GB, conforme a execução (o inchaço dos índices varia com a ordem das gravações). Gera em ~7 min; a execução
       inteira (roteiro antes e depois, candidato descartado, replay) leva ~20 min e **apaga os bancos no fim**
       (`--manter` ou `--so-massa` os deixam; `test:limpar` apaga).
     - **Como foi medido**: PostgreSQL 16 local (4 CPUs, 15 GB, `shared_buffers` 128 MB e `work_mem` 4 MB, os padrões),
       `EXPLAIN (ANALYZE, BUFFERS)`, o melhor de 3 ("quente": tudo no cache do Linux) e as **páginas** de 8 kB que a
       consulta toca (cache + disco). Em produção (Cloud SQL PG 18 com 2 GB) a tabela e os índices de um ano
       (~4,2 GB) não cabem na memória, então o número que importa é o de páginas e o **frio**: o PostgreSQL
       reiniciado e o cache do Linux esvaziado antes de cada consulta (pior caso, medido à mão com o mesmo SQL do
       roteiro). A exportação é lida de verdade por um cursor do servidor (`declare` + `fetch 10000`), como no
       F2-B29: o planejador otimiza o cursor para a primeira fração.
     - **Resultado** (12 meses; "todas as lojas" = as 3 lojas e o CD, sem a Treino; quente antes → depois; frio
       antes → depois; páginas antes → depois):

       | Consulta (bloco que a usa) | Quente | Frio | Páginas | Plano depois |
       |---|---:|---:|---:|---|
       | Analítica, 1ª página de 101 de uma loja (B32) | 389 → 0,1 ms | 699 → 3 ms | 138.009 → 99 | Index Scan `estoque_data` |
       | Analítica, página do meio pelo cursor (B32) | 315 → 0,1 ms | 608 → 1 ms | 137.949 → 19 | Index Scan `estoque_data` |
       | Analítica, só as compras (B32) | 99 → 5 ms | — | 34.173 → 3.933 | Index Scan `estoque_data` |
       | Analítica, um produto (B32) | 0,5 → 0,5 ms | — | 457 → 457 | Index Scan `linha_data` + top-N |
       | Saldo anterior das linhas da página (B32, "por janela") | 1.019 → 83 ms | 2.977 → 152 ms | 375.346 → 8.340 | Index Only Scan `linha_data` |
       | Sintética de uma loja (B33) | 745 → 728 ms | 1.017 ms | 137.991 | Seq Scan + agregação |
       | Saldo numa data-base (ontem), soma até a data (B31) | 769 → 985 ms | 1.060 → 1.277 ms | 137.931 → 95.839 | Index Only Scan `linha_data` |
       | Saldo numa data-base (ontem), projeção − razão depois da data (B31) | 12 → 11 ms | 30 ms | 717 → 740 | Bitmap `estoque_data` |
       | Idem, data-base 6 meses atrás (B31) | 905 → 683 ms | — | 75.458 → 84.576 | Index Only Scan `linha_data` |
       | Última compra até o fim do período, uma loja / o CD (B33) | 108 / 35 ms | 1.322 ms (loja) | 34.173 / 11.805 | `ix_..._tipo_movimento` |
       | Detalhe do acerto de 2.000 itens | 0,8 ms | — | 71 | `ix_..._documento` |
       | Exportação de 12 meses de uma loja por cursor, 1,62 M linhas (B29/B33) | 1ª página 1.183 → 107 ms; total 6,9 → 6,4 s | — | — | o cursor deixa de ordenar 1,6 M linhas (Sort em disco) e lê o índice |
       | Replay do recalcular, 1ª página de 10 mil | 18 → 13 ms | — | 9.897 → 9.902 | — |

     - **Os dois índices da 0026** (`INDICES_RAZAO`): (1) `ix_movimentos_estoque_estoque_data (estoque_id,
       data_movimento, id)` — a Movimentação de um local por período na ordem do cursor e a exportação em streaming;
       225 MB por 4 M de movimentos, 3,8 s para criar aqui; também no schema Drizzle. (2)
       `ix_movimentos_estoque_linha_data (estoque_id, produto_id, variacao_id, tipo_estoque_id, data_movimento, id)
       include (quantidade)` — o saldo de cada linha até um ponto do cursor **só pelo índice**: é o "saldo anterior
       recalculado por janela" da página da Movimentação, que sem ele lê a história inteira de cada linha da página na
       tabela (3 s com o cache frio, e a página tem de abrir em menos de 1 s); 434 MB, 7,3 s para criar aqui. Fica
       **fora do schema Drizzle** (o Drizzle 0.45 não declara `include`), como o BRIN e os únicos parciais desta
       tabela. O `id` no índice é necessário: sem ele o desempate do cursor `(data_movimento, id) <= (…)` volta à
       tabela (medido: 2,3 s com o cache frio).
     - **Descartados pela medição**: o parcial `(estoque_id, produto_id, data_movimento desc) where tipo_movimento in
       ('RECEB_MANUAL','RECEB_NFE')` (2 MB) — o CD cai de 35 para 5,5 ms, mas a loja fica igual (108 ms quente,
       1,3 s frio: o planejador continua no `ix_movimentos_estoque_tipo_movimento`, que já separa as compras), e a
       última compra é uma coluna da sintética, que roda em tarefa (B33); a medição repete em `CANDIDATOS_DESCARTADOS`.
       Nenhum índice para a sintética e o saldo numa data-base pela soma: varrem a história do local (1,6 M a 3,9 M
       linhas) e ficam em ~0,7–1 s quente e ~1–1,3 s frio, dentro do critério; um índice de cobertura para elas teria o
       tamanho da tabela.
     - **Critério de pronto** (com 4 milhões): a página de 12 meses de uma loja abre em **0,1 ms** quente e **3 ms**
       frio (com o saldo anterior das linhas dela, 83 ms e 152 ms: < 1 s); o saldo numa data-base de todas as lojas sai
       em **0,8–1,0 s** pela soma até a data (1,1–1,3 s frio) e em **11 ms** pela projeção menos o razão depois da data
       (ontem): < 3 s; o recalcular da empresa inteira (`verificarSaldos`, 4 M de movimentos, 12.157 linhas, 89 s) fica
       com o **pico de heap em 348 MB** (< 512 MB; RSS 537 MB) — o heap não cresce com o razão (páginas de 10 mil,
       decisão 147), só o tempo.
     - **`concurrently` fora da transação**: o executor (`aplicarMigracoes`) roda cada migração **dentro de uma
       transação** (`begin` … `commit`, com `lock_timeout`), e `create index concurrently` não roda em transação. Segue
       o padrão da 0017 (decisão 146): a preparação da tag `0026_indices_razao` (`garantirIndicesRazao`) cria os dois
       com `concurrently` antes do `begin` da migração — as vendas do PDV continuam gravando; o inválido de um
       `concurrently` interrompido é apagado e refeito; idempotente. Isso vale para todo caminho do executor, inclusive o
       provisionamento da empresa nova (com a tabela vazia). A `.sql` só cria quando o journal é aplicado sem as
       preparações, num bloco `do $$` que consulta o `pg_class` e roda o `create index` só se o nome não existir (e
       refaz o inválido). Não usa o `create index if not exists` solto: ele pega a trava SHARE da tabela (que barra as
       gravações) **antes** de ver que o índice existe, e na empresa existente a migração entraria na fila das vendas
       até o `lock_timeout` (10 s) e falharia; com os índices da preparação prontos o bloco não pega trava nenhuma em
       `movimentos_estoque`. O teste `migracao-indices-razao` aplica o journal sem as preparações e compara o
       `pg_get_indexdef` com o da empresa provisionada, refaz um inválido pela `.sql` e reaplica a 0026 com uma
       gravação aberta na tabela. Relato a quem migra (`relatoIndicesRazao`: os índices criados e o tempo, em
       `auditoria_plataforma` `migracao_preparada`) só numa empresa com movimentos.
     - **Produção** (Cloud SQL PG 18, 2 GB): a criação lê a tabela duas vezes (`concurrently`) e espera as transações
       abertas; aqui foram 3,8 s + 7,3 s para 4 M de movimentos, e a empresa de hoje tem bem menos (o piloto é recente):
       segundos, sem trava de escrita. Disco: +~660 MB por 4 M de movimentos (~+20% sobre os
       índices que a tabela já tinha). Gravação: 100 mil movimentos num `insert` levaram ~10,3 s sem os dois, ~10,6 s só
       com o primeiro e ~12,4 s com os dois (medida ruidosa, ~0,02 ms a mais por movimento; a venda do PDV grava
       poucos movimentos por evento).
     - **Para os blocos seguintes**: B32 pagina por `(data_movimento, id)` com `estoque_id` e o período (o
       `ix_..._estoque_data` dá a ordem sem ordenar, inclusive com o filtro de tipos) e calcula o saldo anterior de cada
       linha da página com a soma até o cursor pela chave da linha (o `linha_data`, só pelo índice); B29/B33 leem por
       cursor do servidor (`declare`/`fetch`), que usa o mesmo índice; B31 calcula o saldo numa data-base pela
       **projeção menos o razão depois da data** quando a data está na metade recente da história (11 ms ontem, 0,7 s seis
       meses atrás) e pela soma até a data na metade antiga — os dois só leem a parte menor da história (o resultado é o
       mesmo enquanto a projeção bate com o razão, que o recalcular confere). O `ix_movimentos_estoque_estoque_produto_data`
       ficou quase coberto pelo `linha_data` (o planejador já prefere o novo na analítica de um produto): candidato a
       remover depois dos relatórios, medindo (fora deste bloco).
     - **Sem particionamento na Fase 2.** Com 4 milhões (um ano das 3 lojas) todas as consultas dos relatórios ficam
       dentro dos critérios, e particionar `movimentos_estoque` mexe nas chaves: no PostgreSQL a tabela particionada só
       aceita chave primária e índice único que contenham a coluna de partição (`data_movimento`), então a `pk(id)`, o
       `uq_movimentos_estoque_idempotencia`, o `uq_..._compensacao` e o `uq_..._estorno` e as FKs que apontam para o
       movimento (`estorno_de_id`, `compensa_movimento_id`) teriam de mudar, com o motor e o PDV dependendo da
       idempotência. **Gatilho para particionar** (o primeiro que disparar; anual por `data_movimento`, MD 3.7.2): (1)
       `movimentos_estoque` passar de **20 milhões** de linhas (~5 anos no ritmo de hoje); (2) em produção, o saldo
       numa data-base de todas as lojas pela soma passar de **3 s**, ou a sintética de 12 meses de uma loja passar de
       **5 s** (`EXPLAIN (ANALYZE, BUFFERS)` do roteiro da massa) — antes de particionar, a primeira resposta para esses
       dois é um **fechamento mensal de saldos** por linha, que corta a história lida sem mexer nas chaves; (3) o replay do
       recalcular da empresa inteira passar de **15 min** (89 s a 4 M; cresce linear). A massa de carga refaz a medição
       (`--movimentos=20000000` simula ~5 anos; ~4,2 GB de disco, tabela e índices, por 4 M).
     - **Testes**: `test/integracao/migracao-indices-razao.test.ts` — empresa nova e existente (esquema da 0025 com
       10 mil movimentos) terminam com os mesmos dois índices válidos (definição lida do catálogo); na existente eles
       vieram da preparação, com o relato; o inválido é refeito e a segunda passada só confere; a Movimentação sai do
       `estoque_data` sem `Sort` e o saldo da linha até o cursor sai em `Index Only Scan` do `linha_data`. O
       `seq-lancamento.test.ts` passou a filtrar o relato da 0017 (a 0026 também relata numa empresa com movimentos). A
       carga com os tempos é a desta decisão (reproduzível pela semente; os tempos variam com a máquina).

177. **Exportação de relatório em tarefa, em streaming** (Fase 2, F2-B29; ERP 3.5, 3.6; MD 3.1.6, 3.1.8; decisão 93;
     `src/tarefas/exportar-relatorio.ts` (novo), `src/comum/exportacao.ts`, `src/infra/armazenamento.ts`
     (`gravarFluxo`), `src/relatorios/relatorios.controller.ts` (novo), `packages/shared/src/paginacao.ts`;
     `test/carga/exportacao-razao.ts` (novo); **sem migração**: a categoria `planilha_exportacao` já está no
     `ck_arquivos_categoria` desde a 0001 e a `tarefas` já tinha tudo). A infraestrutura comum que os relatórios do
     F2-B31 a F2-B33 vão usar; nenhum relatório de verdade a usa ainda (o PDV não muda).
     - **Provedor por relatório** (`ProvedorRelatorio`, registrado em `servicos.exportacoes.registrar`): `chave` (a
       rota `GET /relatorios/<chave>/exportar?formato=xlsx|csv&<filtros>`), `nomeArquivo` (`Relatorio_…`; o arquivo sai
       `Relatorio_…_DD_MM_AAAA_HH_MM.xlsx` por `nomeArquivoExportacao`), `permissao` do relatório, `entidade` e
       `localizacao` da auditoria, os `filtros` (zod; a entrada crua vai para `tarefas.parametros` e é validada de novo
       na execução), as `colunas` (`ColunaExportacao`, com `custo: true` nas de custo) e a `consulta` (o SQL inteiro,
       com a ordem estável e o filtro dos estoques/lojas permitidos da sessão). `contar` é opcional: o padrão é
       `count(*)` da consulta embrulhada, que mantém as junções e a ordenação (0,6 s para 1 milhão com duas junções);
       os relatórios grandes do B32/B33 devem dar o seu, só na tabela do razão.
     - **Regra comum** (`ExportacaoRelatorios.exportar`): exige `relatorios.exportar` (`@Permissao` da rota e de novo
       no provedor) **e** a permissão do relatório (403 com as que faltam); valida os filtros (422); conta; até
       `LIMITE_EXPORTACAO` (50.000, ERP 3.5) baixa na hora pelo `write-excel-file` de sempre (`200`, as linhas lidas
       pelo mesmo cursor, auditoria `exportar` no download); acima, cria a tarefa **`exportar_relatorio`**
       (`TAREFA_EXPORTAR_RELATORIO` no shared) e responde **`202`** com `{ tarefaId, linhas }`
       (`exportacaoEmTarefaSchema`), que o ERP acompanha em `GET /tarefas/:id` (o ícone Tarefas é do F2-B30). O critério
       é só o número de linhas (o "ou 30 s" do ERP 3.5 não se sabe antes de rodar). **Teto numérico**: acima de
       `LIMITE_EXPORTACAO_TAREFA` (5 milhões) a API pede para refinar os filtros (422) — o `.xlsx` tem até 1.048.575
       linhas de dados por aba (`LINHAS_POR_ABA_XLSX`): passou, o arquivo continua numa aba nova "Relatório (2)" com o
       cabeçalho (5 milhões = 5 abas; o `.csv` não tem limite). Sem `produtos.ver_custo`, as colunas `custo` saem do
       arquivo (`colunasVisiveis`), no download na hora e na tarefa. **Teto por usuário**: no máximo 2 exportações em
       tarefa na fila ou executando (`EXPORTACOES_PENDENTES_POR_USUARIO`; 422 "Você já tem 2 exportação(ões) em
       andamento…"): a fila roda uma tarefa por vez, e sem o teto um usuário enfileiraria horas de exportação na
       frente das importações e dos outros (teto "macio": dois pedidos no mesmo instante podem passar juntos).
     - **Executor**: a sessão de quem pediu com o acesso **do momento** (`sessaoDaTarefa`): quem perdeu a permissão ou o
       estoque entre o pedido e a execução não exporta com o acesso antigo (as colunas de custo também são decididas
       aí). Lê a consulta por um **cursor do servidor** (`declare … no scroll cursor` + `fetch 10000`, num instantâneo
       `repeatable read read only`, `lerPorCursor` sobre `lotesPorCursor` — o mesmo embrulho na exportação na hora e
       na tarefa, para as duas lerem com as mesmas regras): o `declare` aceita os `$n` do protocolo estendido (o roteiro da
       massa usava literais; os parâmetros funcionam no 16 e no 18), e o planejador otimiza o cursor para a primeira
       fração, o que no razão é o `ix_movimentos_estoque_estoque_data` sem ordenar (decisão 176). Cada lote vai para o
       escritor (`abrirEscritorPlanilha`): o `.xlsx` pelo `WorkbookWriter` do **exceljs 4.4.0** (versão exata; strings em
       linha, sem a tabela de strings compartilhadas, que cresceria com o arquivo; cabeçalho em negrito e congelado),
       o `.csv` com as regras do síncrono reaproveitadas (`textoCsv`: proteção contra fórmula com o apóstrofo, BOM,
       `;`, vírgula decimal; datas `dd/mm/aaaa hh:mm` na hora de Brasília, `horaDeParede`, também no `.xlsx`). Texto que
       começa com `=` no `.xlsx` é célula de texto, nunca fórmula (como no `write-excel-file`; teste). O progresso
       (`progresso_pct` até 95, "N de M linhas") usa o total contado no pedido.
     - **Envio em multipart enquanto escreve** (`ArmazenamentoObjetos.gravarFluxo`): junta 8 MiB
       (`TAMANHO_PARTE_BYTES`; o S3, o MinIO e o XML API do Google Cloud Storage, o de produção, pedem ≥ 5 MiB por
       parte menos a última) e envia uma parte por vez com os comandos do `@aws-sdk/client-s3` que já estava (sem o
       `@aws-sdk/lib-storage`); o arquivo menor que uma parte vai num `PutObject` só; o sha256 é calculado no caminho
       (no multipart ele fica só em `arquivos`, não nos metadados do objeto); falhou → `AbortMultipartUpload`. O envio
       que falha destrói a saída e a tarefa falha com "O arquivo não pôde ser gravado no armazenamento: …"; o gerador
       que falha destrói a saída com o erro dele. Só o executor destrói a saída: o envio a lê pelo
       `saida.iterator({ destroyOnReturn: false })`, porque o `for await` que sai com erro a destruiria na hora com um
       `AbortError` ("The operation was aborted"), antes do `AbortMultipartUpload`, e o gerador parado na folga saía
       com essa mensagem crua no lugar da do armazenamento (teste com a folga pequena e o aborto atrasado no S3 em
       memória). **Parte pendurada**: o `S3Client` não tinha limite de tempo nenhum
       (no `@smithy/node-http-handler` 4.14 os três valem 0), e uma parte presa numa conexão meio aberta deixaria o
       gerador parado na pressão de volta com a transação do cursor aberta ("idle in transaction": travas de leitura
       no razão, que fariam a migração do próximo deploy cair no `lock_timeout`, o horizonte do vacuum preso, uma
       conexão do pool, uma vaga do semáforo e a fila inteira, com o sinal em dia). Agora o cliente tem limite de
       **inatividade** (`socketTimeout` = `ARMAZENAMENTO_INATIVIDADE_MS`, 2 min; nenhum byte indo ou vindo — o envio
       lento que anda continua) e 10 s para conectar: a parte parada falha, o SDK repete (3 tentativas), o envio é
       abortado e o gerador sai com `rollback`. Defesa no banco: a transação do cursor leva
       `set local idle_in_transaction_session_timeout = '10min'` (o cliente escuta o `error` da sessão derrubada
       enquanto está emprestado; sem ouvinte, derrubaria o processo). Processo que morre no meio deixa um multipart aberto no bucket: a
       regra de ciclo de vida "AbortIncompleteMultipartUpload" (o GCS tem) os limpa — a configurar junto das regras
       de `backups/` (`infra/producao/README.md`, Pendências). Tarefa interrompida: "Nenhum arquivo foi gerado: peça a
       exportação de novo." (decisão 150).
     - **Pressão de volta** (o ponto que a medição achou): entre o gerador e o envio há um `PassThrough` de 1 MiB; o
       gerador só lê o próximo lote quando ele tem folga (`folga`), então o envio lento segura a leitura do banco. No
       `.xlsx` isso não bastava: o exceljs escreve a aba num `StreamBuf` que o archiver embrulha num `PassThrough` do
       `readable-stream` 2 sem respeitar o `write() === false`, e o deflate precisa de uma volta do laço de eventos
       por pedaço de 64 KiB enquanto gerar 10 mil linhas segura o laço por ~0,3 s. Resultado, medido: a planilha quase
       inteira sem comprimir (**339 a 370 MB fora do heap** com 1 milhão de linhas, mesmo com o envio rápido) ficava
       na memória esperando o deflate. A `folga` passou a esperar também essa entrada do zip esvaziar
       (`entradaDoZip`, que lê o encanamento interno do exceljs 4.4.0; o `exportacao.spec.ts` quebra se uma versão nova
       o mudar): fora do heap caiu para ~20 MB no gerador isolado, sem perder velocidade. A espera escuta o `error` e
       o `close` do destino (um `destroy(erro)` sem ouvinte derrubaria o processo), e o `fechar` do `.xlsx` também
       (`aoTerminarOuFalhar`): o `WorkbookWriter.commit` espera o `finish` do destino, e com o envio caído depois da
       última linha a tarefa ficava "executando" para sempre, com o sinal em dia (achado na suíte inteira; teste
       unitário). A rejeição do envio é tratada assim que ele começa (sem isso, o envio que falha enquanto o gerador
       espera o banco seria um `unhandledRejection`, que encerra o processo, decisão 166).
     - **Concorrência** (decisão 93): `semaforoExportacao` (`EXPORTACAO_CONCORRENCIA`, 2) agora vale para a geração
       de **todo** arquivo de exportação — a das listagens (`arquivoExportacao`), o relatório da importação
       (`gerarArquivoPlanilha`, as duas pelo mesmo `gerarConteudo`) e a tarefa (que segura a vaga do começo ao fim,
       por minutos). A fila `genesis-tarefa` roda uma tarefa por vez por processo e o **mínimo é 2** (um valor menor
       no ambiente vale 2: com 1, toda exportação na hora e o modelo de importação esperariam a tarefa acabar, com a
       requisição pendurada), então sempre sobra vaga para quem baixa na hora. O cursor segura uma conexão do pool
       da empresa durante a leitura (1 milhão: ~48 s no `.xlsx`, ~16 s no `.csv`) num instantâneo só de leitura, sem
       trava de versão (MD 1.5 fala da transação que segura a trava); o fechamento do zip e o fim do envio vêm depois
       de soltar a conexão.
     - **Resultado** em `arquivos` (`planilha_exportacao`, `entidade = 'tarefas'`, `registro_id` = a tarefa,
       `retencao_ate` = hoje + 7 dias, UTC) e `tarefas.resultado`
       (`resultadoExportacaoRelatorioSchema`: relatório, formato, linhas, abas, tamanho, nome do arquivo). A
       auditoria `exportar` vai na mesma transação do `arquivos` (a tarefa que falha não exportou nada), com a origem
       da requisição guardada nos parâmetros (IP, user agent, requisição), os filtros, as linhas, a tarefa e o arquivo.
     - **Link do `GET /tarefas` dentro da retenção** (ERP 3.6, "link expira em 7 dias"): o `doUsuario` assinava um link
       novo de 7 dias a cada consulta, sem olhar `arquivos.retencao_ate`, e ninguém apaga o objeto — a exportação do
       dia 1 ainda baixava no dia 30, com o custo de um mês atrás, mesmo depois de a pessoa perder
       `produtos.ver_custo` ou o estoque. Agora a validade é `validadeDownloadS`: 7 dias, sem passar do fim do dia
       `retencao_ate` (UTC); vencida → `download: null` e **`downloadExpirado: true`** (campo novo da resposta; o
       ERP da importação mostra "O relatório de inconsistências expirou…"). Vale para todo arquivo de tarefa (o
       relatório da importação, 30 dias); arquivo sem retenção continua com 7 dias. O objeto ainda fica no bucket
       até a limpeza (`infra/producao/README.md`, Pendências), mas não se baixa mais pelo sistema.
     - **exceljs** (versões escolhidas): MIT, 23 MB e ~120 pacotes transitivos (a parte de leitura — unzipper, jszip,
       fast-csv — vem junto e fica sem uso); o `uuid@8` que ele traz tem um alerta moderado (GHSA-w5hq-g745-h8pq, só
       `v3`/`v5`/`v6` com `buf`) que não se aplica (o exceljs só chama `v4`). Era o que o plano pedia; um gerador de
       `.xlsx` próprio (zip com `node:zlib` e `zlib.crc32`) seria ~200 linhas sem dependência e fica como alternativa se
       o exceljs der trabalho.
     - **Carga de 1 milhão de linhas** (`pnpm --filter api carga:exportacao`, fora do CI, ~3 min; a massa do F2-B28 por
       `gerarMassa` — o `massa-razao.ts` passou a ser importável, sem rodar o roteiro — com 1 milhão de movimentos e
       2.000 produtos, o razão inteiro pelo provedor de exemplo, pela rota de verdade, com a API, a fila e o S3 em
       memória no mesmo processo, `--max-old-space-size=1536` como em produção; PostgreSQL 16 local, 4 CPUs; apaga os
       bancos no fim): **`.xlsx`** 1.000.000 de linhas em 1 aba, 58,2 MB, 8 partes, **45–48 s** (~21 a 22 mil
       linhas/s), **pico de heap 115–116 MB** (85 MB no início; três execuções), fora do heap 135 MB (o arquivo inteiro
       guardado pelo S3 em memória entra na conta; sem ele, 10,5 MB); **`.csv`** 81,8 MB, 10 partes, **13–16 s** (~63
       a 75 mil linhas/s), **pico de heap 165–179 MB** (89 MB no início; o `.csv` gera mais lixo de texto por segundo,
       e o pico é o heap com o lixo ainda não coletado), fora do heap 255 MB (idem: o S3 em memória guarda as partes e
       o arquivo; sem ele, ~0). O arquivo abre e tem o total de linhas (o `.xlsx` relido pelo leitor em streaming do
       exceljs). Critério de pronto (< 300 MB de heap): ok. A contagem do pedido levou 0,5–0,8 s. Sem a correção da
       pressão de volta, o `.xlsx` deixava ~340 MB fora do heap — e o heap não acusa: a carga reprova também pelo
       fora do heap sem as duas cópias do S3 em memória (as partes e o objeto montado) acima de 100 MB
       (`LIMITE_EXTERNO_MB`; com a correção tirada, deu 180 MB e reprovou).
     - **Testes**: `test/integracao/exportacao-relatorio.test.ts` (no CI, com a massa pequena — 6 mil movimentos —, o
       S3 em memória com multipart e limites pequenos: na hora até 1.000, lotes de 500, abas de 2.500, partes de
       64 KiB): o `.xlsx` em tarefa (202, `concluida`, as abas com o cabeçalho, o total, as datas e números como
       células, a ordem do cursor, o link de 7 dias, `arquivos` com o sha256 e o tamanho do que se baixa, a auditoria) e
       **o streaming**: a primeira parte do multipart chegou ao S3 antes de a última linha ser escrita, e nada ficou
       aberto no bucket; o `.csv` (BOM, `;`, vírgula decimal, uma linha por movimento); o filtro do provedor na tarefa;
       no limite baixa na hora (200, `write-excel-file`, auditoria sem tarefa); 404 do relatório desconhecido e 422 do
       filtro inválido; a terceira exportação em andamento do mesmo usuário (422; a na hora passa); 403 sem
       `relatorios.exportar` (Estoquista) e sem a permissão do relatório (Financeiro); sem
       `produtos.ver_custo` as colunas de custo saem e os estoques permitidos limitam as linhas; o teto (422); a parte
       que falha no meio (`.csv` e `.xlsx`): multipart abortado, tarefa `falhou` com a mensagem, nada em `arquivos` nem
       na auditoria; a parte **pendurada** (o S3 em memória recebe e não responde; inatividade de 3 s no teste):
       tarefa `falhou`, multipart abortado e nenhuma sessão "idle in transaction" no banco; o link sem passar da
       retenção (vencida → `download: null`, `downloadExpirado`; no último dia, no máximo até o fim dele); o acesso
       do momento na execução (a tarefa de quem não tem `relatorios.exportar` falha sem gravar; a de quem trocou de
       estoque traz só as linhas do estoque de agora); o semáforo (com as vagas ocupadas a tarefa fica em "Aguardando
       a vez" e segue quando uma abre); a retenção conferida contra o dia de antes e o de depois do pedido (meia-noite
       UTC no meio); e o `gravarFluxo` pequeno num PUT só. Unitários (`src/comum/exportacao.spec.ts`): as abas acima do
       teto, `=1+1` como texto, a data na hora de Brasília, Sim/Não, o `.csv` igual ao síncrono, a pressão de volta (o
       lote só termina quando o destino esvazia; no `.xlsx`, com a entrada do zip esvaziada — 10 mil linhas por lote,
       quebra sem a correção), o destino destruído rejeitando, o encanamento do exceljs e o corte do custo;
       `src/tarefas/tarefas.spec.ts`: a validade do link (`validadeDownloadS`).

178. **Relatório Estoque Atual com o modal de ajuste** (Fase 2, F2-B31; ERP 16.4, 13.6, 13.1.5, 3.5; D39; decisões 157,
     174, 176 e 177; `src/relatorios/estoque-atual.ts` (novo), `src/relatorios/relatorios.controller.ts`,
     `ajustarEstoqueDefinir` em `src/estoques/acertos.ts`, `src/tarefas/exportar-relatorio.ts` (`preparar` e
     `semJit` no provedor), `src/servicos.ts` (o provedor registrado), `packages/shared/src/relatorios.ts` (novo);
     `test/carga/estoque-atual.ts` (novo, `pnpm --filter api carga:estoque-atual`); **sem migração** (usa os índices
     da 0026); o PDV não muda (o ajuste é um acerto, e o saldo desce no fluxo `estoque` como qualquer outro)).
     - **`GET /relatorios/estoque-atual`** (`relatorios.estoque_atual`; `consultaEstoqueAtualSchema`): uma linha por
       estoque × tipo de estoque × produto (× variação, nula enquanto travadas, D43) com Ref. interna, marca,
       unidade, saldo, mínimo (o da loja do estoque), custo médio e custo total (só com `produtos.ver_custo`; a
       ordenação por custo sem ela é recusada), Venda (o preço da loja do estoque, ou o do produto), Atacado, iFood e
       venda total, o "Em trânsito" e a "Divergência a tratar" (as subconsultas do F2-B26, `em-transito.ts`, as
       mesmas do `/saldos-estoque`, com a linha zerada da chave que só tem pendência). Filtros: nome/código interno/
       EAN, **marca**, **departamento** (a categoria e as filhas, pelo `caminho` da árvore, como a listagem de
       produtos), estoque, tipo de estoque, situação do saldo, produtos ativos/inativos/todos, `produtoId`, `treino`,
       **`vencendoEmDias`** e **`dataBase`**. Paginado no servidor (`pagina`/`tamanho`), com o **total e os totais do
       relatório inteiro na mesma ida ao banco** (funções de janela `count(*) over ()`/`sum(...) over ()`; só a
       página além do fim conta à parte).
     - **"Todas"** (`estoqueId` vazio ou `todas`): uma linha por produto × variação × tipo com a **soma dos estoques
       permitidos** (decisão 149: o estoquista da Loja 1 vê só ela); custo e venda totais = a soma das linhas (cada
       uma ao preço da loja do seu estoque); o custo médio da soma é a média ponderada pelos saldos positivos (sem
       saldo positivo, o maior custo médio das linhas); o mínimo é a soma dos mínimos. A **loja de treino** fica de
       fora por padrão (D39; `treino` = `excluir`/`incluir`/`somente`, como nas consultas de vendas); o estoque de
       treino escolhido aparece.
     - **"Vencendo em N dias"** (0 a 3650): só as linhas com lote de validade até hoje + N (no fuso da empresa;
       inclusive os já vencidos, que são os mais urgentes) e saldo de lote positivo (`saldos_lote`), com a quantidade
       desses lotes e a validade mais próxima (`vencendo`). Não combina com a data-base (422 no campo): os lotes são
       os de hoje.
     - **Data-base "Saldo em <data>"** (até hoje; futura → 422): o saldo no fim do dia (`data_movimento` antes da
       meia-noite seguinte no fuso da empresa), pelo caminho que a decisão 176 mediu: **a projeção menos o razão
       depois da data** quando a data está na metade recente da história dos estoques escolhidos (o meio entre o
       primeiro movimento deles e agora) e **a soma do razão até a data** na metade antiga. A escolha fica no próprio
       SQL (um filtro de uma vez só; o ramo que não vale nem roda), então a tela e a exportação em tarefa calculam
       igual, e os dois ramos dão o mesmo resultado (o teste confere os dois em cada data). Na projeção, a linha que
       só nasceu depois da data fica de fora (zerada nela e sem movimento até ela), como na soma. O **custo médio da
       data** é o `custo_medio_posterior` do último movimento da linha **pela ordem de lançamento** (`seq_lancamento`,
       a da cadeia do custo, `ix_movimentos_estoque_linha_seq`) com data até ela e lançado antes do primeiro movimento
       da linha com data depois dela (um passo à frente no `ix_movimentos_estoque_linha_data`); sem movimento depois,
       o último lançado. Pela data só (como era na primeira versão do bloco), o movimento lançado depois com data no
       passado — a venda do PDV offline sincronizada tarde (`dataMovimento` = `finalizada_em`), o cancelamento, o
       "Definir" retroativo — trazia para a data o custo das entradas posteriores, porque a saída grava o custo
       vigente no lançamento (a venda do dia 05 sincronizada no dia 07, depois da NF-e do dia 06, mostrava no "Saldo
       em 05" o custo da NF-e). **Limitação aceita**: o "primeiro depois" é o primeiro pela data, não pelo lançamento
       (pelo lançamento, a metade antiga leria de novo toda a parte da linha até a data); só erra com dois lançamentos
       retroativos cruzados (um com data depois da data-base lançado depois de outro ainda mais novo, e um com data
       até ela lançado entre os dois), e aí o custo é o do estado do razão logo antes do primeiro deles. A quantidade
       não depende da ordem (é soma). As duas buscas repetem na ordem todas as colunas do índice porque o planejador
       não trata o `variacao_id is null` como igualdade e, só com a data, lia a história inteira de cada linha e
       ordenava (medido: **20 s** com 4 milhões); a CTE das linhas é `materialized` (no "Todas" o custo é usado três
       vezes, e a CTE embutida repetia a busca). "Em trânsito" e "Divergência a tratar" ficam nulos (só existem os de
       hoje). O ajuste não abre nesse modo (ERP 16.4).
     - **Sem movimento** (situação do saldo **"Zerado"** e **"Abaixo do mínimo"**, os filtros em que o saldo 0 conta):
       o produto que controla estoque e não tem linha no estoque (no tipo do filtro, ou em nenhum tipo) entra com
       saldo 0, custo 0 e o tipo do filtro ou o padrão, uma linha por estoque, como o `incluirSemMovimento` do
       `/saldos-estoque` — a cerveja recém-cadastrada com mínimo de 24 e ainda não recebida é a mais abaixo do
       mínimo, e o clique no saldo lança a contagem inicial. No "Todas", só o produto sem linha em nenhum dos
       estoques escolhidos (soma dos mínimos de todos): o que tem linha em algum continua a soma das linhas, igual em
       qualquer filtro. Nas outras situações não entra (seria o catálogo inteiro em cada estoque); na data-base vale
       igual (saldo 0 na data, sem pendências).
     - **O fuso como parâmetro e o JIT desligado** (achados da carga): com o fuso numa subconsulta (`fusoDaEmpresa`)
       o fim do dia é um valor que o planejador não conhece; ele estimava um terço do razão "depois da data" e varria
       o `linha_data` inteiro de cada estoque em vez do `estoque_data` (0,7 s em vez de 0,2 s). Agora
       `prepararFiltrosEstoqueAtual` lê o fuso antes (com a conferência da data futura) e ele vai como parâmetro. E a
       consulta, com muitas CTEs e subconsultas, tem custo estimado alto: com o `jit` ligado (o padrão do PostgreSQL),
       ele gastava **~1,5 s compilando** de 1,8 s no total; a página roda numa transação `read only` com `set local jit
       = off`, e o provedor da exportação ganhou `semJit` (o cursor do F2-B29 faz o mesmo `set local`) e `preparar`
       (completa os filtros com o que a consulta lê do banco antes; roda no pedido e de novo na execução da tarefa) —
       os dois opcionais, para os próximos relatórios (B32/B33).
     - **Exportação** pela rota comum (decisão 177): o provedor `estoque-atual` (`Relatorio_Estoque_Atual_…`; a
       permissão do relatório; auditoria `exportar` em `saldos_estoque`, "Relatórios › Estoque Atual"), com as
       colunas da tela (a do saldo vira "Saldo em dd/mm/aaaa" na data-base; sem "Em trânsito"/"Divergência" nela; as
       do "Vencendo" só com o filtro) e a **mesma consulta** com a sessão do momento: na tarefa, os estoques
       permitidos e o "Ver custo" são os de agora (`sessaoDaTarefa`), e as colunas de custo saem sem ele.
     - **Modal de ajuste** (`POST /relatorios/estoque-atual/ajustar`, `relatorios.estoque_atual` **e**
       `estoque_acertos.criar`; `ajusteEstoqueRelatorioSchema` = o do "Ajustar" do produto com o `produtoId`): o
       **mesmo núcleo** do "Ajustar" do produto (decisão 157) — `ajustarEstoqueDoCadastro` virou
       `ajustarEstoqueDefinir(tx, sessao, produtoId, dados, origem)` com a origem `cadastro_produto` (padrão) ou
       `relatorio_estoque` —: cria e efetiva na mesma transação (`travaVersao`) um "Definir" de um item com a origem
       `relatorio_estoque`, que a efetivação já traduz em **`AJUSTE_RELATORIO`** (`tipoMovimentoAcerto`; a origem
       estava no enum, no `ck_acertos_estoque_origem` e no seed desde a Fase 1, sem uso), na hora da contagem
       informada (padrão: o instante da requisição), com a diferença descontando os movimentos posteriores à contagem
       e a compensação das vendas offline anteriores a ela que chegarem depois (13.1.5), a regra do saldo negativo do
       acerto (o "Definir" não pede quantidade negativa) e o estoque permitido para **movimentar** (403 no campo). Os
       produtos sem saldo próprio e os que não controlam estoque são recusados como no produto. O acerto aparece na
       lista de acertos com a origem "Relatório Estoque Atual"; a auditoria (criar + efetivar) vai no acerto com a
       localização "Relatórios › Estoque Atual". Mover saldo entre tipos continua pelo acerto "Mudar tipo" (13.5).
     - **Carga** (`pnpm --filter api carga:estoque-atual`, fora do CI, ~7 min aqui, quase tudo gerando a massa; a
       massa do F2-B28 com **4 milhões de movimentos**, 12.157 linhas de saldo, pela rota de verdade com a API no
       mesmo processo; a primeira página de 50 com o total e os totais; o pior de 3; apaga os bancos no fim). O meio da
       história anda com o relógio (a massa tem datas fixas, 01/11/2025 a 01/11/2026), então as datas-base saem do
       meio real (uma entre ele e o fim da massa, uma no primeiro terço da história) e a carga confere antes de medir
       que cada data-base vai mesmo pelo caminho do rótulo (a coluna `recente` de `sqlEstoqueAtual`), senão falha.
       Medido em 07/11/2026, já com o custo da data pela ordem de lançamento e o "sem movimento" (meio em 05/05/2026):
       "Todas" agora (3.040 linhas) **131 ms**; Loja 1 agora (2.454) **50 ms**; "Todas" com a data-base de ontem, pela
       projeção, **300 ms**; em 03/08/2026 (metade recente, três meses antes do fim da massa), pela projeção,
       **1,38 s**; em 04/03/2026 (primeiro terço), pela soma até a data, **1,78 s** no "Todas" e **713 ms** na Loja 1;
       "abaixo do mínimo" ordenado por venda total **97 ms** (a massa não tem mínimo nem produto sem movimento: mede só
       a ordenação e o filtro); a exportação na hora em CSV do "Todas" com a data-base de ontem (3.040 linhas)
       **688 ms**. Critério de pronto (< 3 s): ok em todos. Na primeira medição (custo pela data só, a data recente um
       mês antes do fim e a antiga oito meses antes): 140 ms, 47 ms, 196 ms, 857 ms, 1,55 s, 510 ms, 79 ms e 343 ms. O
       caso mais lento é a soma até a data no "Todas" (lê a parte antiga do razão de todos os estoques); fica abaixo do
       limite, e a regra da metade garante que nenhuma data lê mais da metade da história.
     - **Testes**: `test/integracao/relatorio-estoque-atual.test.ts` (as colunas, os totais e o custo só com "Ver
       custo"; marca e departamento com as filhas; o "Todas" só com os permitidos e a loja de treino fora/dentro/só;
       o "Vencendo"; a "Divergência a tratar" de uma transferência recebida com menos itens na linha da origem e
       somada no "Todas"; o produto sem movimento no "Zerado" e no "Abaixo do mínimo" (por estoque, no tipo escolhido,
       na data-base e no "Todas"; o que não controla estoque fora; some depois da primeira entrada); a data-base de 4
       dias atrás a hoje igual ao saldo da época pelos dois caminhos (forçados com o fuso da empresa, a expressão da
       produção), o custo médio da época, o "Definir" retroativo lançado depois de uma compra (o custo da data é o de
       antes dela), o "Todas" na data-base com dois estoques (a soma e a média ponderada do custo da época), a escolha
       pela metade e a data futura; o ajuste com a origem e o movimento, na lista de acertos, na
       auditoria e no pull do PDV; a venda offline anterior à hora do ajuste compensada; as permissões e o contrato;
       a exportação na hora em CSV e em tarefa em `.xlsx` sem o custo e só com o estoque permitido; o razão idêntico
       no fim), `relatorios.spec.ts` no shared e o `produto-formulario.test.ts` de sempre (o "Ajustar" do produto
       pelo núcleo renomeado). O ERP é a decisão 66 do README do ERP.
179. **Relatório Movimentação de Estoque, visão analítica** (Fase 2, F2-B32; ERP 16.5; MD 3.7.1–3.7.3; decisões 176,
     177 e 178; `src/relatorios/movimentacao.ts` (novo), `src/relatorios/relatorios.controller.ts`,
     `src/referencias/referencias.controller.ts` (`GET /referencias/tipos-movimento-estoque`),
     `packages/shared/src/relatorios.ts`; `test/carga/movimentacao.ts` (novo, `pnpm --filter api carga:movimentacao`);
     **sem migração** (usa os dois índices da 0026); o PDV não muda (`movimentos_estoque` não desce)).
     - **`GET /relatorios/movimentacao-estoque`** (`relatorios.movimentacao_estoque`;
       `consultaMovimentacaoEstoqueSchema`): um movimento do razão por linha. **Local de estoque** e **período**
       obrigatórios — `dataInicial`/`dataFinal` em dias de calendário no fuso da empresa (do começo do dia inicial
       ao começo do dia seguinte ao final), até **366 dias contando as pontas** (`MAXIMO_DIAS_MOVIMENTACAO`; de
       07/11 a 07/11 do ano seguinte passa, 367 é 422 no campo), o final não antes do inicial. Filtros opcionais:
       `produtoId`, **`tiposMovimento`** (multisseleção: `A,B` ou o parâmetro repetido; o código desconhecido é 422),
       `usuarioId`, `pessoaId` (`movimentos_estoque.pessoa_id`, em qualquer documento: o fornecedor do recebimento e
       da nota; o cliente da venda, da troca, da devolução avulsa de cascos — `documento_tipo = 'vasilhame'` — e da
       compensação, que herda a pessoa da venda compensada),
       `documentoTipo` e `documentoNumero` (o número da coluna Documento: o `numero_exibicao` da venda, o `codigo` do
       acerto, do recebimento e da transferência, o **Nº da NF-e** do fornecedor na nota de entrada; sem tipo, ou num
       tipo sem número — troca e vasilhame —, 422; o número que não é inteiro num documento de código numérico não
       acha nada, sem erro do banco). O local fora dos **estoques permitidos** é 403 (decisão 149; conferido antes de
       procurar o local, então quem não o vê não descobre se existe), e a consulta repete o filtro da sessão (para o
       provedor da exportação do F2-B33, que roda com a sessão do momento). Treino: o local é escolhido, então o de
       treino aparece quando escolhido (como no Estoque Atual, D39).
     - **Paginação por cursor** `(data_movimento, id)`, sem total nem página (um ano de uma loja passa de 1,6 milhão
       de movimentos): `tamanho` (20, 25, 35 ou 50; padrão 50) e o `cursor` opaco da resposta (`proximoCursor`;
       `null` na última). A página lê `tamanho + 1` movimentos do `ix_movimentos_estoque_estoque_data (estoque_id,
       data_movimento, id)` depois do cursor, na ordem e sem ordenar (o a mais diz se há próxima e não volta). O
       cursor é o base64url de `<data em UTC com os microssegundos>|<id>` do último movimento da página: a data vai em
       texto com os microssegundos do banco (`to_char(... 'US')`), porque o `Date` do JavaScript perderia os
       microssegundos e o movimento do mesmo milissegundo seria repetido ou pulado; vários movimentos no mesmo instante
       (um acerto de 25 itens grava todos com a mesma `data_movimento`) se desempatam pelo `id`. O cursor inválido é
       422 no campo ("volte para a primeira página"). O movimento lançado durante a leitura com data já passada (a
       venda offline que chega) não desloca as páginas: só aparece se cair depois do cursor.
     - **Saldo anterior e posterior recalculados na ordem de `data_movimento`** (ERP 16.5: "recalculados na ordem de
       `data_movimento`"), não os gravados (que seguem a ordem de lançamento): o saldo anterior de um movimento é a
       soma do razão da sua linha de saldo (estoque × produto × variação × tipo) antes dele pela chave `(data_movimento,
       id)`, e o posterior, o anterior mais a quantidade. Na página, cada movimento lê só a **parte** do razão da
       linha **entre o movimento anterior da mesma linha na página e ele** (para o primeiro da linha, a história antes
       dele; `lag` na janela da linha), pelo `ix_movimentos_estoque_linha_data (…, data_movimento, id) include
       (quantidade)` **só pelo índice**, com as duas pontas como condição do índice (`(data_movimento, id) > (anterior)`
       e `< (ele)`; sem anterior, `-infinity` e o uuid zero, para não virar um `or` que o índice não usa). As partes não
       se sobrepõem; a janela soma as partes e as quantidades da página antes do movimento. Assim cada linha de saldo
       lê a sua história **uma vez** por página, e não uma vez por movimento (o produto mais vendido de uma loja tem
       135 mil movimentos num ano). Com filtro de tipo, usuário, pessoa ou documento, as partes incluem os movimentos
       que o filtro esconde: o saldo continua o **da linha de saldo**, não o do filtro (a compra no meio das vendas
       mostra o estoque de verdade antes dela). A variação nula vai pelo `is null` e a outra pela igualdade (o
       `is not distinct from` não é condição do índice; decisão 178). A mesma conta serve à leitura inteira da
       exportação do F2-B33 (lá sem o limite; as partes continuam disjuntas).
     - **O gravado vai junto** (`saldoAnteriorGravado`/`saldoPosteriorGravado`): o recalculado difere do gravado quando
       um lançamento tem data no passado — a venda offline sincronizada tarde (`data_movimento` = `finalizada_em`), o
       "Definir" na hora da contagem, a compensação —; o ERP mostra a nota e os gravados no ícone. O recalculado
       **fecha com `saldos_estoque`**: com o período até hoje, o saldo posterior do último movimento de cada linha é a
       projeção (o teste confere em todas as linhas).
     - **Colunas** (compatíveis com o export do Nuvem3 na MD 3.7.2): `CodigoInterno`/`NomeProduto` (com o código do
       produto), `EstoqueAnterior`/`QtdMovimentada`/`EstoqueAtual` (os recalculados), `DataHora` (ISO com os
       microssegundos), `Usuario`, `TipoMovimento` (código e nome), **`idmovimentacaoestoquetipo`** (o
       `tipos_movimento_estoque.id_nuvem3`, nulo quando não confirmado: no levantamento só o 28 das transferências),
       `Estoque` e `nomeLoja` (a loja do documento), `idmovimentacaoestoque` (o `id`; o movimento não tem código
       legível próprio, o número que a pessoa reconhece é o do documento), `idvenda` (o `documento.id` da venda) e
       `PessoaVenda` (o cliente), **`fornecedornf`** (o fornecedor do recebimento ou da nota, que no Nuvem3 vinha
       vazio), `sigla` (a unidade do documento; sem ela, a do produto) e `nomeVariacao`; mais o tipo de estoque, a
       **`unidadeBase`** (a sigla do produto: a unidade da quantidade e dos saldos, que estão sempre na unidade base,
       MD 3.7.2) e o **`fator`** do documento (o recebimento de 2 CX com fator 12 grava 24 com `sigla` = CX: sem os
       dois, a tela leria 24 caixas), a observação, **`CustoUnitario`/`CustoTotal`** gravados no movimento (só com
       `produtos.ver_custo`: sem ela as duas vêm nulas, nem saem do banco) e o **Documento** (tipo, id para o link e o número). Os nomes do local, do
       produto e da pessoa escolhidos voltam em `referencias` (o seletor reaberto pelo link mostra o nome). **A
       pessoa sai sempre que o movimento tem `pessoa_id`** (o filtro Pessoa acha o movimento em qualquer documento, e a
       coluna mostra quem ele achou): em `fornecedor` no recebimento e na nota, em `pessoaVenda` nos demais (a
       devolução avulsa de cascos e o `ACERTO_COMPENSACAO` saíam com "—" no filtro de um cliente). A constante da
       localização da auditoria fica para o F2-B33, com o provedor da exportação que a usa.
     - **`prepararFiltrosMovimentacao`** (uma ida ao banco antes da página; servirá de `preparar` ao provedor do
       F2-B33): o fuso da empresa como **parâmetro** (decisão 178: com o fuso numa subconsulta o planejador não conhece
       o começo e o fim do período), a existência do local, os tipos de movimento e os nomes de `referencias`. A
       página roda numa transação `read only` com `set local jit = off` (as subconsultas do saldo têm custo estimado
       alto; decisão 178).
     - **`GET /referencias/tipos-movimento-estoque`** (qualquer usuário autenticado, como as outras referências):
       código, nome, sinal, documento, `idNuvem3` e ativo, inclusive os inativos (o razão antigo ainda os tem), para a
       multisseleção do ERP.
     - **Carga** (`pnpm --filter api carga:movimentacao`, fora do CI; ~8 min aqui, quase tudo gerando a massa do
       F2-B28 com **4 milhões de movimentos**; pela rota de verdade com a API no mesmo processo; páginas de 50; o pior
       de 3; apaga os bancos no fim). 12 meses (01/11/2025 a 31/10/2026) da Loja 1 (1,62 milhão de movimentos; o
       produto mais movimentado com 135.532): **1ª página 40 ms**; **página do meio pelo cursor 98 ms**; **última
       página 170 ms** (o saldo anterior lê a história mais longa); só as compras 29 ms; o produto mais movimentado
       27 ms; um fornecedor 51 ms; o operador com menos movimentos 23 ms. Critério de pronto (< 5 s): ok em todos.
       **EXPLAIN (ANALYZE, BUFFERS)** registrado pela carga (`resultado.explain`, o melhor de 3, com o JIT
       desligado): 1ª página 1,8 ms e 509 páginas de 8 kB (Index Scan `ix_movimentos_estoque_estoque_data` 51 linhas
       ← Index Only Scan `ix_movimentos_estoque_linha_data` para o saldo); página do meio 94 ms e 6.396 páginas
       (o mesmo caminho; o `linha_data` lê 236 mil entradas: a história das linhas da página antes delas, só pelo
       índice); o produto mais movimentado 3,7 ms e 2.551 páginas. O frio não foi medido neste bloco: a página do meio toca
       ~6.400 páginas (~50 MB), e a decisão 176 mediu ~8.300 páginas do mesmo índice em 152 ms com o cache frio.
     - **Testes**: `test/integracao/relatorio-movimentacao.test.ts` (a ordem e o cursor sem repetir nem pular, com 25
       movimentos no mesmo instante atravessando a página; o saldo que fecha com `saldos_estoque` em todas as linhas e
       encadeia na ordem da data; o "Definir" com a hora da contagem antes de três lançamentos e lançado depois deles,
       com o gravado diferente do recalculado; o período que começa do saldo de antes dele; a linha de saldo que
       atravessa a página — o primeiro movimento dela na 2ª página soma desde o começo, não desde o cursor —, sem e
       com filtro; o filtro que esconde um movimento entre dois da página — o recebimento entre a entrada e a saída
       no filtro "Acerto" — sem mudar o saldo; a venda pelo `/sync` com o cliente, chegada depois de um "Definir" de
       contagem posterior — o `numero_exibicao` na coluna e no filtro por texto, o recalculado diferente do gravado e
       a compensação com o nome do cliente no filtro Pessoa —; o recebimento com fator 12 em `unidadeBase`/`fator`;
       os filtros de tipos — em vírgulas e repetido —, documento com número, pessoa, usuário e produto com o saldo da
       linha de saldo; o
       fornecedor, o documento e o `id_nuvem3`; o custo só com "Ver custo"; o estoque fora dos permitidos e sem a
       permissão do relatório; a validação do período, do cursor, dos tipos e do documento; o razão idêntico no fim) e
       `relatorios.spec.ts` no shared. O ERP é a decisão 67 do README do ERP. A sintética, a exportação de 12 meses
       em tarefa e o "Ver movimentação" ficaram no F2-B33 (decisão 180, que também tirou da página sem filtro de
       movimento as buscas da parte do saldo que é sempre vazia).

180. **Movimentação de Estoque: visão sintética, exportação das duas visões em tarefa e a parte vazia do saldo**
     (Fase 2, F2-B33; ERP 16.5, 3.5, 3.6, 8.2.11; MD 3.7.2, 3.7.3; decisões 176, 177, 179 e 151;
     `src/relatorios/movimentacao.ts`, `src/relatorios/relatorios.controller.ts`, `src/servicos.ts`,
     `packages/shared/src/relatorios.ts`; `test/carga/movimentacao-exportacao.ts` (novo, `pnpm --filter api
     carga:movimentacao-exportacao`); **sem migração** (os índices da 0026 e o `ix_movimentos_estoque_tipo_movimento`
     que já existia); o PDV não muda (`movimentos_estoque` não desce)).
     - **`GET /relatorios/movimentacao-estoque/sintetica`** (`relatorios.movimentacao_estoque`;
       `consultaMovimentacaoSinteticaSchema`: os filtros da analítica, `pagina` e `tamanho` 20/25/35/50, padrão 50):
       uma linha por **linha de saldo do local** (produto × variação × tipo de estoque) com movimento no período nos
       filtros, na ordem do nome do produto (sem acento e sem caixa; desempate pelos ids, a ordem estável que o cursor
       da exportação lê), com o **total** e os **custos do relatório inteiro** pela janela (`count(*) over ()`), numa
       transação só de leitura com o JIT desligado, como a analítica; a página além do fim conta à parte (como o
       Estoque Atual). Paginada por página e não por cursor: são milhares de linhas numa loja (as linhas de saldo com
       movimento), não milhões, e a agregação do período tem de rodar inteira de qualquer jeito.
     - **Consulta** (`sqlMovimentacaoSintetica`): as condições saem de `condicoesMovimentacao`, a mesma da analítica,
       em três partes — `local` (o local, os estoques permitidos da sessão, o produto: escolhem as linhas de saldo),
       `periodo` e `filtro` (tipos, usuário, pessoa, documento: escolhem os movimentos). **Uma passada pelo período**
       do local agrega, por linha, a soma de **todos** os movimentos (`no_periodo`) e, com `filter (where <filtro>)`,
       a contagem, as entradas, as saídas (sem o sinal) e o custo gravado (`custo_total`, que é sempre positivo) das
       entradas e das saídas; a linha sem movimento filtrado sai (`having`). **Saldo inicial** = a soma do razão da linha
       antes do começo do período (`sqlSaldoAntes`, só pelo `ix_movimentos_estoque_linha_data`, a variação nula pelo
       `is null`), e o **final** = inicial + `no_periodo`: os saldos da linha de saldo no começo e no fim do período,
       com ou sem filtro. **Sem filtro de movimento** a sintética **fecha com a analítica** em tudo: o inicial é o
       "Est. anterior" recalculado do primeiro movimento da linha, o final o "Est. atual" do último (teste: em todas as
       linhas, inclusive com saldo inicial diferente de zero e em dois tipos de estoque do mesmo produto). **Com filtro
       de movimento** fecham só as entradas, as saídas, os movimentos e os custos (teste: as somas da analítica com o
       mesmo filtro); os saldos não, e de propósito: o "Est. anterior" do primeiro movimento filtrado na analítica já
       inclui os movimentos escondidos do começo do período (a regra da decisão 179), e o da sintética é o do começo do
       período. Por isso, com filtro, o final deixa de ser inicial + entradas − saídas (a nota da tela diz).
     - **Última compra** (`compras`): o último `RECEB_MANUAL`/`RECEB_NFE` de entrada que não é estorno (a regra do
       `movimentoDeCompra` do F2-B6, decisão 151) do produto × variação **no local**, pela `data_movimento` antes do fim
       do período, em **qualquer tipo de estoque** e **fora dos filtros de movimento** (o filtro "Acerto" não apaga a
       última compra), com a data e o `custo_unitario` dela (o custo só com `produtos.ver_custo`; a data sai sempre).
       Um `distinct on` pelo `ix_movimentos_estoque_tipo_movimento` (decisão 176: 108 ms numa loja com 4 milhões; o
       índice parcial das compras foi descartado lá), juntado à linha pelo `coalesce` da variação com o uuid zero (a
       igualdade que o hash usa). **Não reaproveita `saldos_estoque.ultima_compra_em`/`ultimo_custo_compra`** (F2-B6):
       elas são a última compra **lançada** (a ordem de lançamento), de hoje e por tipo de estoque; o relatório pede a
       última pela data até o fim de um período que pode estar no passado (a nota mais antiga movimentada depois teria
       a data dela no saldo). A NF-e entra com `data_movimento` = o início da movimentação (F2-B4), então a "última
       compra" da sintética é a do dia em que a nota foi movimentada, não o da emissão (o vínculo com o fornecedor guarda
       a emissão).
     - **Exportação** (`provedorMovimentacao`, chave `movimentacao-estoque`, registrado em `servicos.exportacoes`):
       `GET /relatorios/movimentacao-estoque/exportar?visao=analitica|sintetica&formato=xlsx|csv&<filtros>`
       (`exportacaoMovimentacaoEstoqueSchema`: os filtros e a `visao`, padrão a analítica; a entrada crua vai para
       `tarefas.parametros` e é validada de novo na execução). Arquivo `Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM`;
       auditoria `exportar` em `movimentos_estoque`, localização "Relatórios › Movimentação de Estoque". O `preparar` é
       o `prepararFiltrosMovimentacao` (o fuso como parâmetro; o local fora dos permitidos **agora** é 403 também na
       execução da tarefa, com a sessão do momento) e `semJit`. Colunas da **analítica**: as da tela na ordem do export
       do Nuvem3 (Data/hora, Ref. Interna, Código, Produto, Variação, Tipo de movimento, Tipo de estoque, Est. anterior,
       Qtd. movimentada, Est. atual, Unidade, Unid. do documento, Fator, Custo unit. e Custo total marcados como custo,
       Documento e Nº do documento, Cliente, Fornecedor, Usuário, Estoque, Loja, Observação) e no fim os gravados no
       lançamento e os ids do Nuvem3 (`idmovimentacaoestoquetipo`, `idmovimentacaoestoque`, `idvenda`). Da
       **sintética**: as da tela, com a Data da última compra e o Último custo (custo). A consulta é a da tela sem a
       página (a analítica inteira na ordem `(data_movimento, id)`, que o cursor do servidor lê; a sintética na ordem
       do nome).
     - **Contagem própria e barata** (`contar`, como a decisão 177 recomenda): `sqlContagemMovimentacao` conta **só na
       tabela do razão** — a analítica, os movimentos do período nos filtros (sem as junções, o saldo de cada
       movimento e a ordenação que o `count(*)` da consulta embrulhada faria); a sintética, as linhas de saldo
       distintas com movimento filtrado.
     - **A parte vazia do saldo** (`sqlParteAnterior(semFiltro)`, muda a analítica da decisão 179): sem filtro de
       movimento, a parte do razão entre dois movimentos da mesma linha na página é sempre vazia — todo movimento do
       local no trecho da página está nela, e o produto filtrado é o da linha —, então só o primeiro de cada linha da
       página lê o índice (`case when p.ant_id is null`). Na página de 50 é pouco; na exportação da analítica inteira
       são duas buscas no índice a menos por movimento (1,6 milhão numa loja). Com filtro continua lendo (a compra no
       meio das vendas escondidas).
     - **Carga** (`pnpm --filter api carga:movimentacao-exportacao`, fora do CI; a massa do F2-B28 com 4 milhões de
       movimentos, pela rota de verdade com a API, a fila e o S3 em memória no mesmo processo; apaga os bancos no fim):
       ~14 min aqui (7,7 min gerando a massa; rodada em primeiro plano, sem nada em paralelo). 12 meses (01/11/2025 a
       31/10/2026) da Loja 1 (**1.620.913** movimentos; **2.454** linhas na sintética). **Sintética** pela rota, o pior
       de 3: 1ª página **968 ms**, última página 932 ms, só as compras 1.012 ms, outubro (o saldo inicial lê 11 meses de
       história) 358 ms, o CD 451 ms — critério (< 5 s, o gatilho da decisão 176): ok. **EXPLAIN (ANALYZE, BUFFERS)**
       (o melhor de 3, JIT desligado): 12 meses 928 ms, 172.712 páginas de 8 kB e 10.733 temporárias (Seq Scan do
       razão com 1,62 M linhas do local ← agregação; `ix_..._tipo_movimento` 13.605 compras; o saldo antes do período
       não lê nada: a massa começa nele); outubro 305 ms, 47.833 páginas (Bitmap do período, 137 mil linhas; o
       saldo inicial só pelo `linha_data`, e só nas 50 linhas da página: o PostgreSQL deixa a subconsulta cara para
       depois do `limit`, e na exportação inteira são 719 entradas do índice por linha, ~0,4 ms cada). **Contagem
       própria** dos 12 meses: analítica 237 ms (1.620.913), sintética 430 ms (2.454). **Exportação da sintética** dos
       12 meses na hora: 2,7 s, 2.454 linhas conferidas no arquivo. **Exportação da analítica dos 12 meses em tarefa**
       (`.xlsx`, `202` → tarefa → link): **247 s**, 1.620.913 linhas conferidas no arquivo (lido em streaming), em 2
       abas, 225 MB; **pico de heap 224 MB** (de 89 MB; critério < 300 MB), fora do heap sem o S3 em memória 6 MB, RSS
       de pico 901 MB (o S3 em memória guarda o arquivo duas vezes no mesmo processo). O ritmo, ~6.600 linhas/s, é o
       da escrita do `.xlsx` (28 colunas; ~185 mil células/s, o mesmo da decisão 177 com 9 colunas): a leitura da
       analítica inteira pelo cursor faz ~48 mil linhas/s (medido com 300 mil movimentos, 120 mil da loja em 2,5 s).
     - **Testes**: `test/integracao/relatorio-movimentacao-sintetica.test.ts` (com a fila e o S3 em memória: cada linha
       da sintética fecha com a analítica — saldos, entradas, saídas, movimentos e custos — e o final é a projeção; a
       última compra do `RECEB_NFE` da NF-e importada e movimentada, a do recebimento manual no período que termina
       antes da nota, nenhuma para o produto comprado só em outro local nem para o acerto de entrada; o período só de
       hoje com o saldo inicial de antes; o filtro de compras com os saldos da linha e as somas da analítica, produto e
       fornecedor; a página com o total, a ordem pelo nome, os totais de custo e a página além do fim; sem "Ver custo"
       sem os custos e com a data; 403 fora dos permitidos; 422 do período; a exportação na hora das duas visões com o
       nome, as colunas, a ordem da analítica e o corte do custo, 403 e 422 da visão; os 12 meses (366 dias) das duas
       visões **em tarefa** com o limite da hora pequeno, o arquivo inteiro e a auditoria com a visão; o razão idêntico
       no fim) e `relatorios.spec.ts` no shared. O ERP é a decisão 68 do README do ERP.
181. **Produto com variações vendido sem a variação: aceito, com o alerta de cadastro; e o aviso dos caixas antigos**
     (Fase 2, F2-B34; F2-Q2 = roadmap D44, **decidida pelo dono em 05/11/2026: recusar no caixa**; SYNC 9.24, 15.1;
     PDV 10.2; `src/sync/handlers/vendas.ts`, `src/sync/handlers/alertas.ts`, `src/sync/handlers/comum.ts`,
     `src/configuracoes/configuracoes.controller.ts`, `packages/shared/src/produtos.ts`, `packages/shared/src/configuracoes.ts`;
     **sem migração**; sem tipo nem versão de evento novos; o PDV é a decisão 81 do README do PDV e o ERP a 69 do README
     do ERP).
     - **Chave `pdv.recusa_produto_com_variacoes`** (bool, padrão `true`, por loja, desce ao PDV no fluxo `configuracao`
       pelo catálogo, como toda `pdv.*`): ligada, o caixa da R1 recusa o código de uma variação e o pai "Com variações"
       com variação ativa; desligada, vende o pai. Escrita por extenso na linha do catálogo (e igual a
       `CHAVE_RECUSA_PRODUTO_COM_VARIACOES` do `produtos.ts`), porque o teste do PDV confere o padrão pela linha.
     - **A venda nunca é recusada por isso** (SYNC 15.1): o PDV 0.10.0 das lojas não tem a guarda e continua vendendo o
       pai, e o da R1 com a chave desligada também. No `preparar` do `venda.finalizada` (só lendo, com os cadastros
       atuais), `produtosSemVariacao` acha o item não cancelado sem `variacao_id` cujo `codigo_barras_id` é o de uma
       variação (`produtos_codigos_barras.variacao_id`) ou cujo produto é `com_variacoes` com variação ativa e não
       excluída na nuvem — o legado "Com variações" sem grade (ou só com inativas) vende como simples, sem alerta, como
       no caixa. No `aplicar`, um `CADASTRO_PRODUTO` por produto, da empresa (`loja_id` nulo), com
       `dados.tipo_alerta = 'venda_sem_variacao'`, a variação do código lido (quando foi o código), o terminal e em
       `detalhes` a venda, o item, o código lido e a versão do app do contexto do envelope; a chave
       `cadastro:venda_sem_variacao:<produto_id>` deduplica, e outra loja que vende com o alerta aberto entra em
       `dados.lojas`, igual ao `alerta.cadastro` do caixa (SYNC 9.24). A baixa fica no pai, como veio (a correção é o
       inventário das variações quando a grade chegar). O resultado do evento lista `CADASTRO_PRODUTO` em `alertas`
       quando abriu um novo.
     - **Por que o `CADASTRO_PRODUTO` e não um tipo novo:** é um problema de cadastro da empresa (o produto tem
       variações que o caixa não vende), e o gerente já trata esse alerta na mesma fila do aviso do caixa; o motivo vai
       em `dados.tipo_alerta`, que é texto livre na tabela. `venda_sem_variacao` **não** entra em
       `TIPOS_ALERTA_CADASTRO`: aquele enum é o contrato do evento que o caixa manda, e este motivo só a nuvem abre.
       Para o handler da venda e o do `alerta.cadastro` abrirem o mesmo alerta, `abrirAlertaCadastro` saiu do
       `aplicarAlerta` (`alertas.ts`), e o `gravarAlerta` foi para o `comum.ts` (todos os handlers a importam de lá; o
       `vendas.ts` não a reexporta) — sem o ciclo `vendas.ts` ⇄ `alertas.ts`.
     - **`GET /configuracoes/terminais-sem-guarda-variacoes`** (`configuracoes.editar`, a mesma de quem grava a chave):
       os terminais `ativo`/`desativando` do banco da empresa com a `versao_app` do último heartbeat abaixo de
       `VERSAO_PDV_GUARDA_VARIACOES` (`0.11.0`, a R1 prevista; se a release sair com outro número, troca-se a constante
       no shared) ou sem versão conhecida, com a loja, o número do caixa e a descrição, pela `compararVersoes` do sync.
       Os detalhes vêm só das lojas permitidas ao usuário (ERP 2.1, como a listagem de terminais); como a chave vale
       para a empresa toda, os antigos das outras lojas entram só na contagem `outrasLojas`. O ERP consulta antes de
       gravar `produtos.variacoes_habilitadas` ligada. Uma rota própria, e não um aviso na resposta do
       `PUT /configuracoes`: o aviso vem **antes** de gravar, e a resposta do `PUT` não muda para os outros blocos.
     - Testes: `venda-eventos.test.ts` (a venda com o pai com variação ativa, o legado só com variação inativa e
       excluída, o código de uma variação e um produto com variação ativa só cancelado na venda: aplicada, baixa no pai,
       o alerta do pai e o do código com a variação e os detalhes, nenhum do legado nem do só cancelado; a venda de
       outro caixa da mesma loja não repete o alerta nem a loja; a venda com a variação informada, sem alerta),
       `terminais.test.ts` (o abaixo da versão listado com a loja e o caixa, o da versão e o revogado fora, o sem versão
       listado, o usuário só de uma loja com o da outra só na contagem, 403 sem `configuracoes.editar`) e
       `configuracoes.spec.ts` no shared (a chave: padrão, por loja e no PDV).

182. **Saldo das outras lojas para o F4 do caixa: uma consulta online dentro do `/sync/*`** (Fase 2, F2-B35; F2-Q12 =
     roadmap D53, **vale a recomendação, sem resposta explícita do dono** — padrão até a confirmação do dono; PDV 10.3;
     SYNC 1.4, 17.5, 20.2; `src/sync/consultas.ts`, `src/sync/sync.controller.ts`, `src/sync/terminal.ts`,
     `src/servicos.ts`, `packages/shared/src/sync/contratos.ts`, `packages/shared/src/configuracoes.ts`; **sem
     migração**; sem tipo nem versão de evento novos; o PDV é a decisão 82 do README do PDV e o ERP a 70 do README do
     ERP).
     - **Rota `GET /sync/consultas/saldos-outras-lojas?produto_id=`**, e não o `GET /estoque/saldos` que a SYNC 1.4
       previa: dentro do `/sync/*` ela reaproveita a autenticação do token do terminal (`noTerminal`), a exclusão do
       prefixo `/api`, o `X-Agora-Servidor` e o envelope de erro do protocolo, que o `ClienteSyncHttp` do PDV já
       traduz. Endpoint novo de `EndpointSync` (`consulta-saldos`), que entra no `exigirHardware` (agora um conjunto,
       `ENDPOINTS_COM_HARDWARE`): a cópia do token em outra máquina não lê o estoque da empresa (409
       `HARDWARE_ALTERADO`). Empresa suspensa ou cancelada recusa como qualquer rota que não é push/recuperar.
     - **Escopo da recomendação (F2-Q12 (a)):** os estoques ativos e não excluídos que são o estoque de uma loja ativa,
       não excluída e **não de treino** (pelo `lojas.estoque_id`) ou um **depósito sem loja** (o CD); o estoque
       `loja`/`outro` sem loja e o da loja inativa ficam de fora. A quantidade é a soma das linhas de
       `saldos_estoque` do produto nos **tipos vendáveis** (todas as variações; avaria e vasilhame vazio, que não são
       vendáveis, não entram), como `numeric(15,3)` em texto, podendo ser negativa; o local sem linha vem com `0.000`
       (o operador vê que lá não tem). Ordem: a loja do terminal (`loja_do_terminal`), as outras lojas pelo código e os
       depósitos (primeiro a loja do tipo depósito pelo código, depois os depósitos sem loja pelo nome). **Nenhum custo** sai: a resposta é `strictObject` com estoque, tipo (`loja`/`deposito` — a loja do tipo
       depósito sai como depósito, com o código), código e nome da loja, a marca da loja do terminal e a quantidade, mais
       `controla_estoque` (falso no produto sem controle e nos tipos sem saldo próprio, `TIPOS_SEM_SALDO_PROPRIO` do
       shared: o combo, o serviço e o **produzido**, que nunca tem linha em `saldos_estoque` porque a venda baixa os
       insumos da ficha técnica, decisão 91; o "Com variações" fica de fora da lista de propósito, porque as variações
       gravam o `produto_id` do pai e a soma delas é o saldo que o F4 mostra). Liberada a qualquer operador: o
       principal é o terminal e nenhum operador vai no pedido. **Terminal em desativação** (SYNC 3.8) recusado como no
       pull: 403 `ESCOPO_INVALIDO` sem `detalhes.chave` (o caixa mostra a mensagem da API, não "desligada no ERP"); o
       `desativando` de uma substituição em andamento já chega como `ativo` e consulta.
     - **Chave `pdv.consulta_outras_lojas`** (bool, padrão `true`, por loja, desce ao PDV como toda `pdv.*`; escrita por
       extenso na linha do catálogo = `CHAVE_CONSULTA_OUTRAS_LOJAS`): desligada na loja do terminal → 403
       `ESCOPO_INVALIDO` com `detalhes.chave`. O PDV confere antes pelo espelho e nem chama; a API confere de novo para o
       espelho atrasado.
     - **Limite por terminal**, na memória da instância (o `garantirLimitePorMinuto` do `limites-processo.ts`, com a
       chave do `terminal_id`): `SYNC_CONSULTA_SALDOS_POR_MINUTO` (padrão 30, lido a cada chamada) → 429 `LIMITE_TAXA`
       com `Retry-After: 60`, antes de ler o banco. Por terminal e não por IP: os caixas de uma loja saem pelo mesmo IP.
     - **Produto desconhecido → 404 `NAO_ENCONTRADO` com `detalhes.produto_id`.** O 404 da rota que a API anterior não
       tem vem sem esse detalhe: é por ele que o PDV separa "produto não encontrado na nuvem" de "requer conexão".
     - **Fora do T13 (SYNC 17.5):** só leitura, nenhum evento; a Fase 2 mantém `venda.finalizada` v1 e não anuncia nada
       novo em `versoes_schema`. Compatível com o PDV 0.10.0 das lojas (que não chama a rota). **Publicar a API antes
       do PDV** da R1: o PDV novo diante da API antiga mostra "requer conexão" e a venda segue.
     - Contrato: `saldosOutrasLojasQuerySchema` e `respostaSaldosOutrasLojasSchema` no shared, a fixture
       `saldos-outras-lojas.resposta.json` (o zod, o record C# `RespostaSaldosOutrasLojas` e a integração passam por
       ela).
     - Testes: `consulta-saldos-outras-lojas.test.ts` (Loja 1, 2 e 3, a Treino, uma inativa, o CD e um estoque "outro"
       sem loja: só as lojas reais e o CD, só o vendável, a Loja 1 sem saldo em zero e primeiro, o negativo, nenhum
       custo na resposta, o serviço com `controla_estoque` falso; a chave desligada na Loja 1 → 403 e a Loja 2 segue;
       query inválida 400 e o produto desconhecido 404 com o `produto_id`; o token de outra empresa não vê o produto, o
       forjado com o id de um terminal e o segredo de outro → 401, o hardware divergente → 409 e o revogado → 401; o
       limite de 3 por minuto → 429 com `Retry-After` e outro terminal segue), `contratos.spec.ts` e
       `configuracoes.spec.ts` no shared.

183. **Histórico de preços: a consulta, as faixas e as variações** (Fase 2, F2-B37; MD 3.6.10; ERP 8.2 "Alteração de
     preço"; decisões 97, 100 e 160; `src/produtos/historico-precos.ts`, `src/produtos/gravacao.ts`,
     `src/produtos/produtos.controller.ts`, `packages/shared/src/produtos.ts`; **sem migração**; PDV sem mudança; o ERP
     é a decisão 71 do README do ERP).
     - **`GET /produtos/:id/historico-precos`** (`produtos.ver`): a página (`pagina`, `tamanho`, com o total) das
       mudanças do produto não excluído (404 senão), a mais recente primeiro (`criado_em desc, id desc`), com os
       filtros **tipo** (`TIPOS_PRECO_HISTORICO`, agora no shared; `historico-precos.spec.ts` confere a lista com o
       CHECK do schema), **loja** (uma loja ou `geral` = só as linhas sem loja) e **período** (`dataInicial`..
       `dataFinal`, dias de calendário no fuso da empresa, as pontas incluídas, cada uma opcional), pelo
       `ix_produtos_historico_precos_produto_id_criado_em`. Cada linha traz a loja e a variação pelo nome, o intervalo
       da faixa, o anterior e o novo, a origem, o **documento** (o recebimento pelo `codigo`, a NF-e pelo `numero`, do
       `origem_id`) e o nome do usuário.
     - **O corte é na consulta** (o histórico não é redigido na leitura, como a auditoria da decisão 100): sem
       `produtos.ver_custo` o tipo `custo` (`TIPOS_PRECO_HISTORICO_CUSTO`) fica fora do `where` e o filtro "Custo" é
       403; a linha de uma loja fora das permitidas fica fora (a linha sem loja — o preço geral, o custo, a faixa de
       todas as lojas — é de todos), e o filtro de uma loja fora delas é 403. O total conta só o que a sessão vê. O
       número do documento aparece mesmo quando o documento é de uma loja não permitida (a linha é do preço geral; o
       link do ERP exige a permissão do documento).
     - **Faixa por quantidade (`quantidade`).** O formulário (`inserirProduto`/`atualizarProduto`) compara as faixas
       vigentes **lidas do banco** antes e depois do "Gravar" (`precosFilhosGravados`, `linhasHistoricoFilhos`), pela
       chave variação × loja × intervalo: uma linha por faixa criada (anterior nulo), removida (novo nulo) ou com o
       preço trocado no mesmo intervalo; o intervalo trocado é uma removida e uma criada. Do banco, e não da entrada,
       porque a gravação preserva a faixa de loja fora das permitidas (decisão 88) e recria a faixa alterada com outro
       id. A tabela não tem coluna para o intervalo e o bloco é sem migração: **na linha `quantidade`, `origem_id` é a
       faixa** (`produtos_precos_quantidade.id`: a atual, ou a removida, que continua na tabela com `excluido_em`), e a
       consulta tira dela o intervalo. Nenhum documento muda faixa (o recebimento e a NF-e mudam o custo, a venda e o
       preço da loja), então não há `origem_id` de documento numa linha `quantidade`; quem passar a mudar faixa por
       documento precisa de uma coluna própria (migração).
     - **Variação (`variacao_id`).** O mesmo diff lê o `preco_venda` e o `preco_custo` das variações e grava `venda`/
       `custo` com a `variacao_id` quando mudam. Hoje o formulário não edita variação (só a partir do F2-B48), então
       nada muda na prática; a variação nova sem preço não gera linha, e a excluída não é mudança de preço (fica na
       auditoria).
     - Custo do caminho do formulário e da importação: uma consulta curta a mais antes e outra depois do "Gravar" (a
       criação só lê quando há faixa). A origem continua a do F2-B15 (`cadastro`/`importacao`, decisão 160), e o custo
       do combo pelo banco segue a decisão 97.
     - Testes: `historico-precos.test.ts` (o cadastro e a alteração com as faixas criada, trocada e removida, as lojas,
       a página com o total, os filtros tipo, loja, geral e período no fuso — a virada do dia em horas fixas, 23:30 de
       09/11 e 00:30 de 10/11 em Brasília, para não depender da hora em que o teste roda —, sem `ver_custo` sem custo e
       com 403 no filtro, o restrito à Loja 1 sem a Loja 2 e com 403 no filtro dela, 404 e 422); a rota com a origem e
       o documento em `recebimento-movimentar.test.ts` (o código), `notas-entrada-movimentar.test.ts` (o número) e
       `importacao-dashboard.test.ts` (`importacao`, sem documento); `historico-precos.spec.ts` (o CHECK do tipo × shared
       e o diff das faixas — com a `variacao_id` e a `loja_id` da faixa — e das variações); `produtos.spec.ts` no shared
       (a query). O período usa o `inicioDoDiaNaEmpresa` (`comum/fuso.ts`), a mesma regra dos outros filtros de
       período.

184. **Relatório de EAN duplicado: a regra do trigger, a página pelos códigos e a permissão do cadastro** (Fase 2,
     F2-B38; MD 3.6.5; ERP 8.2 "Regras", 16.3.1 e 20 item 2; `src/relatorios/ean-duplicado.ts`,
     `src/relatorios/relatorios.controller.ts`, `packages/shared/src/relatorios.ts`; **sem migração**; PDV sem
     mudança; o ERP é a decisão 72 do README do ERP).
     - **`GET /relatorios/ean-duplicado`**: os códigos repetidos (`group by codigo having count(distinct produto_id) >
       1`) com os produtos de cada um, para a empresa limpar o que a importação e a migração do Nuvem3 deixaram e
       voltar `geral.ean_duplicado` de `avisar` para `bloquear`. **A regra é a do trigger**
       `tg_produtos_codigos_barras_ean_unico` e a do filtro "EAN duplicado" da listagem: só o tipo `gtin` (o
       `interno` não entra na unicidade), a linha de código e o produto não excluídos, o produto **inativo incluído**
       (ele também trava o cadastro do mesmo EAN com "bloquear") e o produto distinto (o código no pai e numa variação
       do mesmo produto não é repetição). Diferente do item `catalogo.ean_duplicado` da prontidão (decisão 143), que
       olha só os vendáveis ativos com `usa_venda` e conta também o interno: aquele avisa do que sai errado no
       caixa; este é a lista para zerar a regra.
     - **Página pelos códigos** (`pagina`, `tamanho` de `TAMANHOS_PAGINA`, padrão 50, com o total de códigos pela
       janela numa ida ao banco; depois da última página, uma contagem à parte) e os produtos dos códigos da página
       numa segunda leitura (`cb.codigo in (...)`), agrupados na API: cada linha é um código com a lista dos produtos
       (o código, o nome, a Ref. interna, a marca, a variação, se é o EAN principal ou uma embalagem com o fator e a
       sigla, e se está ativo), na ordem do código do produto, o pai antes das variações. A resposta traz o
       `geral.ean_duplicado` de agora (`modo`), para a tela lembrar de voltar a "bloquear".
     - **Filtros**: `ean` (o começo do código, só dígitos, até 14) filtra o código; `nome` (nome, código interno ou
       EAN, pelo `produtos.busca`) filtra **pelo grupo** (`bool_or` no `having`): o código achado pelo nome de um
       produto vem com todos os produtos dele, senão o par sumiria da tela.
     - **Índice**: o agrupamento lê o `ix_produtos_codigos_barras_codigo` (`codigo where excluido_em is null`) em ordem
       (`GroupAggregate` com o `Incremental Sort` pré-ordenado pelo código e o produto pelo `pk_produtos`, sem ordenar
       a tabela inteira); com poucas linhas o planejador prefere ler a tabela, e o teste confere o plano sem a leitura
       sequencial.
     - **Permissão `produtos.ver`**, não uma `relatorios.ean_duplicado` nova: o filtro "EAN duplicado" da listagem já
       mostra os mesmos produtos a quem vê o cadastro, o relatório não tem custo nem dado de loja (o código de barras é
       da empresa), e uma permissão nova ficaria desligada nos perfis já gravados até alguém marcá-la. A exportação
       (`provedorEanDuplicado` na rota comum do F2-B29, decisão 177; `Relatorio_EAN_Duplicado_DD_MM_AAAA_HH_MM`) exige
       também `relatorios.exportar` e sai com uma linha por código × produto (o código repetido em cada linha, para a
       planilha filtrar e ordenar); auditoria `exportar` em `produtos_codigos_barras`, "Relatórios › EAN duplicado".
     - Só leitura: corrigir é editar o produto (o formulário e a regra da decisão 38 continuam iguais), e o par sai do
       relatório na próxima consulta. Volume: o catálogo da Ice Beer tem dezenas de milhares de códigos, não milhões; a
       consulta não precisa de carga própria.
     - Testes: `relatorio-ean-duplicado.test.ts` (3 produtos e 2 códigos repetidos — um no fardo de um e no principal de
       outro, inativo —, o interno repetido e o produto excluído fora, os filtros, a página depois da última com o
       total, 422 dos filtros, `produtos.ver` sim e o financeiro 403, a exportação `.xlsx` e `.csv`, o EXPLAIN pelo
       índice e a correção de dois produtos zerando o relatório com o `modo` de volta a "bloquear");
       `relatorios.spec.ts` no shared (os filtros e a página).
185. **Cadastro em massa por estoque: a grade numa transação, as regras do formulário e um acerto de Entrada** (Fase
     2, F2-B39; ERP 8.3; F2-Q13 = D54 (a), **padrão até a confirmação do dono**; `src/produtos/cadastro-massa.ts`,
     `inserirProduto`/`atualizarProduto` em `src/produtos/produtos.controller.ts` (a opção `cadastroMassa`),
     `sqlVersaoAgregada` em `src/produtos/consultas.ts`; contratos `cadastroMassaSchema`, `linhaCadastroMassaSchema`,
     `pesquisaEanCadastroMassaSchema`, `ResultadoCadastroMassa`, `LIMITE_LINHAS_CADASTRO_MASSA` (100, D65),
     `LIMITE_CODIGOS_PESQUISA_EAN_MASSA` (500) e `MOTIVO_CADASTRO_MASSA` no shared `produtos.ts`; **sem migração**; PDV sem mudança (os produtos e o saldo descem
     pelo pull de sempre); o ERP é a decisão 73 do README do ERP).
     - **`POST /produtos/cadastro-em-massa/pesquisar-ean`** (`{ estoqueId, codigos }`, até 500): os códigos na **base da
       empresa** — qualquer código vivo do produto (o EAN, o interno, a embalagem com o fator) —, um por produto, o pai
       antes da variação, com os valores que a "Atualização" mostra (nome, unidade, NCM, marca, categoria principal,
       preço, o estoque mínimo da loja do estoque, a **versão agregada** do cadastro — a do 409 do formulário, decisão
       47 — e se tem saldo próprio). Custo e markup só com `produtos.ver_custo` (o markup junto do preço revelaria o
       custo). Sem base externa de GTIN: a F2-Q13 (D54) ficou sem resposta explícita e vale a recomendação (a); a base
       externa é o F2-B47, no backlog. POST, e não GET, porque 500 códigos não cabem na URL.
     - **`POST /produtos/cadastro-em-massa`** (`{ estoqueId, linhas, confirmarEanDuplicado }`): **uma transação** com a
       7300001 (`travaVersao`), até **100 linhas** (D65, **confirmado pelo dono em 11/11/2026**; a ERP 8.3 dizia 500). A
       espera pela trava tem o limite do ERP e, vencida, o 503 "sistema ocupado" amigável com nada gravado (C13). Com a
       trava, os outros escritores (o push do PDV, o formulário) ficam em série: a conferência e a gravação veem o
       mesmo banco.
     - **Por que 100 e não 500** (revisão do bloco): a MD 1.5 e a SYNC 6.13 contam **linhas de tabela** por transação
       ("blocos de até 500 linhas"), e uma linha da grade grava várias linhas sincronizáveis (o produto, o código de
       barras, a categoria, a loja, o saldo e o movimento). Contadas as consultas com o Postgres local, a gravação faz
       umas 26 idas ao banco por produto novo, umas 9 pela linha só de estoque e umas 51 pela Atualização que muda o
       preço, todas com a trava presa; com os ~3 ms de ida e volta entre a VPS e o Cloud SQL (pelo Auth Proxy, D13),
       500 linhas seguravam a trava por 40 a 75 s em horário de venda (o push dos caixas esperando, o ERP respondendo
       "sistema ocupado" a qualquer gravação; medido pela revisão com um atraso simulado de 3 ms: 5,4 s → 42 s em 500
       linhas novas). Com 100, uns 8 s (novos) a 15 s (Atualizações com preço), o tempo de uma importação de bloco.
       Para voltar a 500 basta trocar a constante do shared (o ERP e a API a leem); a importação de planilha continua o
       caminho para catálogos grandes (um produto por transação). Junto, a gravação deixou de repetir o que a
       conferência já fez na mesma transação: o `validarNoBanco` (a opção `validado` do `inserirProduto` e do
       `atualizarProduto`; a troca de tipo valida mesmo assim, com o saldo), o detalhe e a validação da linha só de
       estoque (que não regrava o produto) e o código e o nome do resultado, numa consulta só (de ~30, ~24 e ~56 idas
       por linha para as de cima). O `POST …/pesquisar-ean` aceita até 500 códigos (a grade colada pode passar do
       limite da gravação, que se faz em partes).
     - **A linha**: `produtoId` nulo = **produto novo** — um **Simples**, ativo, com controle de estoque e a tributação
       vazia (a padrão da Fase 2, decisão 161), pelo `inserirProduto`, com o EAN (GTIN válido) como principal; com o
       `produtoId` e a `versao` que a pesquisa achou, a **Atualização** pelo `atualizarProduto` sobre o detalhe gravado
       (o que o usuário vê: as lojas e faixas fora das permitidas ficam como estão), com a versão, o "Altera Preço do
       Produto no ERP" (`produtos.alterar_preco`), a auditoria e a descida ao PDV. Na Atualização, **o campo vazio
       mantém o gravado**; a categoria digitada vira a principal (as outras ficam); a marca digitada que não existe é
       **criada na mesma transação** (`marcaNova`, reaproveitada pelo nome sem acento e caixa, exige `marcas.criar`). O
       markup gravado é o digitado ou o do preço sobre o custo (4 casas, a conta do formulário). O **preço da grade é o
       preço geral** do produto (o do cabeçalho do formulário), não o da loja do estoque — onde a ERP 8.3 diz "destino
       dos preços por loja", a grade grava da loja só o estoque mínimo: o CD não tem loja, e o preço próprio da loja
       continua no formulário (bloco Lojas). A Atualização que não
       muda o cadastro (só soma estoque) não regrava o produto (sem versão nova nem auditoria à toa, como a importação):
       a linha sem nenhum campo do cadastro (o ERP manda nulo no que não mudou desde a pesquisa, decisão 73 do ERP) nem
       lê o detalhe; a que traz os valores gravados de volta é comparada depois do contrato (os decimais com 4 casas).
     - **Unicidade de EAN do formulário, não a da importação**: o EAN de um produto novo que já está em outro produto
       segue `geral.ean_duplicado` — "bloquear" recusa (409 com `detalhes.eanDuplicado`, nada gravado, nem a marca
       nova); "avisar" pede a confirmação (409 com `confirmar: true`, só quando nada mais está errado) e grava com
       `confirmarEanDuplicado`. O EAN (ou o produto) repetido na própria grade é sempre recusado pelo contrato.
     - **Estoque**: o estoque a somar vira **um** acerto de **Entrada** efetivado na hora, com a origem `cadastro_massa`
       (`AJUSTE_CADASTRO`, lançado agora, `data_movimento = now()`, regra de data da decisão 148), o motivo "Cadastro
       em massa", o tipo padrão (Disponível) e o custo da linha (com `produtos.ver_custo`; sem ele, o custo
       médio/de referência da efetivação). O estoque é sempre **na unidade do produto** (o código de uma embalagem acha
       o produto, e a tela avisa o fator). O produto sem saldo próprio (combo, serviço, produzido, com variações) e o
       que não controla estoque são recusados na linha, e a quantidade fracionada só com a fração. O **estoque mínimo**
       vai para `produtos_lojas` da loja do estoque (`lojaDoEstoque`, a de menor código); no estoque sem loja (o CD) é
       recusado, e a loja fora das permitidas também. Auditoria do acerto (criar + efetivar) com a localização
       "Produtos › Cadastro em massa", a mesma dos produtos e das marcas criadas. O histórico de preços grava a origem
       `cadastro_massa` (`OpcoesGravacaoProduto.cadastroMassa`).
     - **Erros por linha**: a conferência junta os erros de **todas** as linhas antes de gravar — o contrato, o
       `validarNoBanco` do formulário (unidade, marca, categoria, NCM conforme a loja) e as regras do estoque — em
       `linhas.N.campo` com o nome da coluna da grade (`codigosBarras.*` → `ean`, `categorias` → `categoriaId`,
       `lojas.*` → `estoqueMinimo`), e responde 422 "Verifique as linhas destacadas" com nada gravado. O que só aparece
       na gravação (com a trava, raro: o "Alterar preço" sem `produtos.alterar_preco`, que o `atualizarProduto` confere)
       volta com "Linha N:" e o campo `linhas.N._linha` e desfaz tudo — N é a posição entre as linhas **enviadas**; o
       ERP a traduz para a linha da grade. A Atualização com a versão diferente da
       pesquisa é recusada na linha ("pesquise o EAN de novo"), não com o 409 do formulário.
     - **Permissões**: `produtos.cadastro_massa` abre a tela e as duas rotas; as gravações seguem as do formulário e do
       acerto — produto novo exige `produtos.criar`; a Atualização que muda o cadastro, `produtos.editar`; somar
       estoque, `estoque_acertos.criar`; o estoque permitido para movimentar e ativo (`conferirCabecalhoAcerto`,
       decisão 149). Assim o cadastro em massa não abre um caminho para quem não pode criar ou editar produto pelo
       formulário. O perfil Gerente tem tudo pelo prefixo; o Estoquista não tem `produtos.cadastro_massa` (o dono
       libera em Usuários › Perfis, se quiser).
     - Resultado: quantos criados e atualizados, um item por linha (código, nome, criado/atualizado) para os links, o
       acerto (código, itens, movimentos) e as marcas criadas.
     - Testes: `cadastro-massa.test.ts` (o critério de pronto — 30 produtos novos com estoque no CD, a marca nova uma
       vez para duas grafias, um acerto `cadastro_massa` com 30 `AJUSTE_CADASTRO` ao custo da linha, o histórico e a
       auditoria —; a pesquisa com a embalagem e o fator; a Atualização com o preço, o estoque e o mínimo da loja, a
       versão velha recusada e a linha só de estoque sem regravar; o mínimo no CD recusado; o limite de linhas com a
       última errada na conferência sem gravar nada, as válidas gravando e uma a mais recusada; o erro que só aparece na
       gravação (o preço da última linha sem "Alterar preço", com 99 produtos já inseridos) com "Linha 100:", o campo da
       linha e nada gravado (nem produto, nem acerto); a linha só de estoque com o corpo inteiro de volta (o custo
       3,4567) sem versão nova, histórico nem `produtos.editar`, e a Entrada a 3,4567; o EAN com "bloquear"
       e "avisar"; o contrato; 403 sem a permissão e fora dos estoques; o perfil só com a tela e o acerto; 10 gravações
       junto de 10 vendas do push do PDV; o razão refeito idêntico) e `produtos.spec.ts` no shared (o contrato).

186. **Exportação do catálogo de ida e volta e o mapeamento provisório do Nuvem3 num ponto só** (Fase 2, F2-B40; ERP
     8.5, 8.6; decisões 88, 95, 103 e 104; F2-Q14 = roadmap §16, D66: **vale a recomendação (b)**, sem resposta explícita
     do dono; `src/produtos/exportacao.ts`, as rotas `GET /produtos/exportacao` e `GET /pessoas/exportacao`,
     `src/tarefas/exportar-relatorio.ts` (`limiteNaHora` e `garantirAcesso` do provedor), `src/importacao/produtos.ts`;
     contratos `filtrosExportacaoProdutosSchema`, `filtrosExportacaoClientesSchema`, `LIMITE_EXPORTACAO_CATALOGO`
     (5.000), `rotuloColunaImportacao`, `MAPEAMENTO_PROVISORIO_NUVEM3`, `lerComposicao`, `formatarBalancaPlanilha` no
     shared `importacao.ts`; **sem migração**; PDV sem mudança; o ERP é a decisão 74 do README do ERP).
     - **Layout = o da importação**: os cabeçalhos são os rótulos de `COLUNAS_IMPORTACAO_*` (`rotuloColunaImportacao`;
       o teste do shared confere que cada rótulo volta para a mesma coluna) e cada valor sai como a análise da
       importação o lê e compara com o cadastro (decisão 103): `id`, `codigo`, `codigo_interno`, o EAN **principal**
       sem as variações (os outros códigos ficam; a importação só acrescenta o que falta), nome, tipo pelo rótulo,
       unidade pela sigla, ativo, marca, as categorias pelo **caminho** (`BEBIDAS > CERVEJA,PROMOÇÕES`: a principal
       primeiro, vírgula sem espaço, a regra do Nuvem3 de `lerListaCategorias`, que aceita "GELO, CARVÃO E LENHA" como
       uma só; só as não excluídas), todos os preços como **número** (o `numeric(15,4)` cabe no `double` sem perda; o
       CSV sai com a vírgula decimal), localização, peso, descrição curta, menu digital e a balança pelo texto do
       mapeamento (`Não usa`/`Peso`/`Unidade`). As colunas NF (`informacoesNf`) são só os valores gravados, os códigos
       como **texto** (o `00` do CST e o `04022130` do NCM não perdem o zero). Sem a coluna `composicao`: a posição do
       combo existente não muda pela planilha (decisão 95), e o código do componente não identifica o produto sem
       ambiguidade (interno × EAN × número).
     - **Loja, CD e "Todas"**: `lojaId` (entre as lojas permitidas, senão 403) dá `preco_loja` e `estoque_minimo`
       (`produtos_lojas` da loja) e `estoque_atual` do estoque dela — **só se esse estoque estiver entre os permitidos
       para ver** (decisão 149: a loja permitida não basta); senão a planilha sai sem a coluna do estoque, e o filtro
       de estoque zerado é 403. `estoqueId` (o CD, estoque sem loja; fora dos permitidos, 403) dá só o `estoque_atual`.
       Nenhum dos dois ("Todas"): sem as colunas da loja (a importação exige a loja para elas). Os dois juntos: 422. O
       `estoque_atual` é o saldo do **tipo padrão**, sem variação, no estoque — o mesmo que a importação compara e o
       "Definir" muda —, 0 sem saldo gravado e **vazio** no produto sem saldo próprio (combo, serviço, produzido, com
       variações, sem controle de estoque), que a importação ignora. Para reimportar o estoque, escolhe-se na
       Importação a mesma loja (ou o mesmo estoque, o CD).
     - **Filtros** (ERP 8.5): "Somente ativos" (padrão Sim; o excluído nunca sai), "Com NCM inválido" (a regra do
       "Sem NCM" da listagem: vazio ou fora da tabela vigente, `ncmVigente`) e "Estoque zerado ou negativo" (o
       `estoque_atual` ≤ 0, só produto com saldo próprio; exige a loja ou o estoque, 422).
     - **Na hora ou em tarefa**: são provedores da exportação comum do F2-B29 (decisão 177): lidos por cursor num
       instantâneo, na hora até **5.000 linhas** (ERP 8.5; `limiteNaHora` novo do provedor, vale o menor entre ele e o
       da instância) e acima disso a tarefa `exportar_relatorio` com o link de 7 dias no ícone Tarefas. A auditoria
       `exportar` vai com a localização "Produtos › Exportação".
     - **Acesso do cadastro** (`garantirAcesso` novo do provedor, no pedido e na execução da tarefa, no lugar do
       `relatorios.exportar` + permissão do relatório): produtos exigem `produtos.ver` e `produtos.exportar` (ou
       `relatorios.exportar`, ERP 3.1); clientes, `pessoas.ver` e `pessoas.exportar` (ou `relatorios.exportar`). A rota
       comum `GET /relatorios/catalogo-*/exportar` passa pelo mesmo `garantirAcesso` (não contorna o cadastro). O custo e
       o markup são `custo: true` (saem sem `produtos.ver_custo`; a importação de quem não vê o custo também não o
       compara, então a planilha dele volta igual).
     - **Clientes** ("Exportar Clientes" no mesmo mecanismo): as pessoas da categoria Cliente, não excluídas e **não
       anonimizadas** (LGPD), com o telefone e o e-mail principais, o endereço principal no Brasil com a cidade pelo
       IBGE, o nascimento em `dd/mm/aaaa` (texto, sem o fuso), o limite e as categorias pelos rótulos. Reimportada,
       cada linha acha o próprio cliente pelo Id, sem erro nem cadastro novo.
     - **"Sem alteração" e "O que muda" também nos clientes** (a decisão 103 estendida, para a ida e volta não regravar a
       base): `carregarReferenciasClientes` lê o estado de cada cliente achado com as mesmas escolhas da exportação (o
       telefone e o e-mail principais, senão o primeiro; o endereço principal no Brasil) e `compararClienteComAtual`
       tira de `dados` o que não muda (o RG/IE em maiúsculas, o limite como decimal, as categorias como conjunto, o
       telefone pelos dígitos, o e-mail sem caixa, o endereço pelas colunas da planilha). Sem diferença, a linha é
       `sem_alteracao` e a confirmação não grava nada (nem versão nova para os PDVs nem auditoria); com diferença, só o
       que mudou é gravado e a prévia mostra cada "de → para" (a planilha exportada antes de uma alteração no ERP aparece
       como mudança, não sobrescreve calada). Sem `pessoas.editar_credito` o limite não é comparado (já não era gravado).
       **Sem `pessoas.ver` a linha não é comparada** (revisão de segurança do PR-9, D63): a prévia só exige
       `pessoas.importar`, e o "de" traria o CPF/CNPJ, o RG, o nascimento, o telefone, o e-mail e o endereço de qualquer
       pessoa achada pelo código (o "Sem alteração" serviria de oráculo para adivinhá-los). A linha fica "Atualizar" com
       o que veio na planilha, como antes do F2-B40. A linha que vira "ignorar" por falta de `pessoas.editar` (ou
       `produtos.editar`) também sai sem o `alteracoes`, na prévia e no relatório do resultado.
       **Correção na gravação** (`gravarCliente`): o telefone ou o e-mail da planilha que já existe no cadastro ficava
       sem a marca de principal (o atual perdia a marca e o da planilha era descartado como repetido); agora o existente
       só ganha a marca, com o id e os outros campos. O endereço principal recebia o da planilha sem id e perdia a
       referência; agora as colunas da planilha sobrescrevem o principal, que mantém o id e a referência (o principal no
       exterior, que a exportação não leva, passa a "Outro" em vez de ser apagado).
     - **Mapeamento provisório do Nuvem3 num ponto só** (F2-Q14, D66, recomendação (b)): `MAPEAMENTO_PROVISORIO_NUVEM3`
       no shared guarda os cabeçalhos e os textos da balança (`UsaBalancaEtiquetadoraStr`, decisão 104) e os do combo
       (os aliases de `composicao`, os nomes do tipo que viram Combo, os separadores das posições; decisão 95). A
       leitura (`lerBalancaPlanilha`, `lerComposicao`, agora só no shared), o reconhecimento das
       colunas, o `TIPO_POR_NOME` da análise e a exportação (`formatarBalancaPlanilha`) leem dele: quando o dono mandar
       as exportações reais, troca-se só esse objeto. O andamento da importação já aparece no ícone Tarefas (F2-B30).
     - **Correção na importação**: o **serviço** novo da planilha caía em "controlaEstoque: Serviço não controla
       estoque" (a regra do formulário) e era ignorado; agora o tipo decide (`controlaEstoque = false`), e o serviço já
       gravado continua "Sem alteração".
     - Testes: `exportacao-catalogo.test.ts` (a massa inventada — combo com posições, serviço, matéria-prima, inativo,
       categorias em caminho e com vírgula, códigos fiscais com zero, preços de 4 casas, estoque negativo e
       fracionado, EAN inválido, dois códigos de barras —: o `.xlsx` da loja com a NF, o `.csv` e o arquivo da tarefa
       reimportados com 100% "Sem alteração", confirmados sem versão nova nem acerto; a célula editada vira um só
       "Atualizar"; o CD só com o estoque; os três filtros; sem `produtos.ver_custo`; a loja e o estoque fora dos
       permitidos; o estoque da loja fora dos permitidos; o acesso do cadastro, também pela rota comum; os clientes; e
       a ida e volta dos clientes confirmada sem gravar nada (versão, filhas, referência e auditoria iguais), a
       edição de uma célula (só ela gravada; o telefone que já existia passa a principal; o endereço mantém o id e a
       referência); o limite de 5.000 do provedor abaixo do da instância (um provedor de teste igual ao de produtos com o
       limite baixo vai para a tarefa com a instância em 100.000); e a **planilha real só local**: o arquivo fica em
       `test/fixtures/planilhas/reais/` (no `.gitignore`, D60) e o teste é pulado sem ele — carga numa empresa nova,
       exportação e reimportação com 100% "Sem alteração", com 9 min para cada espera de tarefa), o
       `importacao.spec.ts` do shared (o mapeamento, a balança de ida e volta, a composição, os rótulos, os filtros e o
       `LIMITE_EXPORTACAO_CATALOGO`), o `produtos.spec.ts` da API (o serviço) e o `clientes.spec.ts` (o "Sem alteração"
       e o "O que muda" dos clientes).
     - **Pendente: a ida e volta com a planilha real.** O critério de pronto do plano ("a exportação completa da Ice
       Beer, reimportada, dá 100% 'Sem alteração'") **ainda não foi conferido**: nesta sessão não havia a planilha real,
       e o teste dela foi pulado; só a massa inventada rodou. Fica para quem tiver o arquivo rodar
       `exportacao-catalogo.test.ts` com ele em `test/fixtures/planilhas/reais/` (antes do merge do PR-9) e registrar o
       resultado no andamento.
187. **Relatórios Produtos geral e NCMs inválidos, o "Definir NCM" em lote e a carga do CEST** (Fase 2, F2-B41; ERP
     16.1, 16.3; decisões 41, 47, 67, 88, 98, 177; `src/relatorios/produtos-geral.ts`, `src/relatorios/ncm-invalidos.ts`,
     as rotas `GET /relatorios/produtos-geral`, `GET /relatorios/ncm-invalidos`, `POST
     /relatorios/ncm-invalidos/definir-ncm` e as exportações `…/exportar` pela rota comum; `lerCests`/`carregarCests`
     em `src/database/referencias/carregar.ts`; a opção `localizacao` do `atualizarProduto`; contratos no shared
     `relatorios-produtos.ts`; **sem migração** (a tabela `cests` existe desde a 1A); PDV sem mudança: `cests` não
     desce; o ERP é a decisão 75 do README do ERP).
     - **Produtos geral** (`relatorios.produtos_geral`): uma linha por produto não excluído (todos os tipos), com o
       **preço de custo do cadastro** (`preco_custo`, o do markup do formulário; o custo médio do estoque é o do Estoque
       Atual e a `produtos.custo_base_margem` da D49 continua só a base do markup da compra), a venda (com `lojaId`, a da
       loja quando ela tem preço próprio, senão a do produto; a loja tem de estar entre as permitidas, 403), o atacado,
       o **lucro R$** (venda − custo), o **lucro %** (lucro ÷ venda; nulo sem venda) e o **markup %** (lucro ÷ custo;
       nulo sem custo), o EAN principal e os departamentos (os `caminho_nomes`, a principal primeiro). Filtros: nome
       (nome, código interno ou EAN), marca, departamento (a categoria e as filhas pelo `caminho`), sem preço (a venda,
       com a loja, = 0), loja e situação (padrão ativos); ordenação por nome, código, código interno, venda, custo,
       lucro, lucro % e markup %. A coluna WooComm fica fora (integração da Fase 7).
     - **Contas em decimal no banco**: tudo em `numeric`, o lucro e as porcentagens com `round(…, 2)` ("meio para longe
       do zero", o ADR-05). Os **totais** são do relatório inteiro, numa segunda consulta: a quantidade e a **média
       simples** do lucro, do lucro % (só dos produtos com venda) e do markup % (só dos com custo), tiradas das linhas
       **antes** do arredondamento de cada uma e arredondadas no fim. O teste confere a média 3,005 → 3,01, que o
       `float` dá 3,00.
     - **Custo só com `produtos.ver_custo`**: sem ela, o custo, o lucro, as porcentagens e as médias voltam nulos (o
       lucro com a venda revelaria o custo) e ordenar por eles é 403; no arquivo, as colunas são `custo: true`.
     - **NCMs inválidos** (`relatorios.ncm_invalidos`, sem filtros como no Nuvem3): os produtos não excluídos, sem
       combo e serviço (não vão para a NFC-e, decisão 67; o inativo entra), com **um motivo** nesta ordem: NCM
       **vazio**; **inexistente** (fora de `ncms` ou excluído dela, o que saiu da Nomenclatura); **fora de vigência**
       (`vigencia_fim` no passado) — os três juntos saem do próprio `not ncmVigente` da decisão 98 no SQL (o que não é
       vigente fica "inexistente" sem a linha em `ncms` e "fora de vigência" com ela; o teste compara o conjunto com o
       helper), então mudam junto se a regra dele mudar —; e **CEST incompatível**, só quando `cests` tem algum CEST não excluído: o CEST do produto fora da
       tabela vigente (`vigencia_inicio`/`vigencia_fim`) ou o NCM que não começa por nenhum NCM da lista do CEST. O
       convênio lista capítulos, posições, subposições e itens, então a comparação é pelo **começo do código** (o
       2203.00.00 cabe no CEST que lista "2203"): sem isso, todo CEST de posição seria falso positivo. Com a tabela
       vazia nada de CEST é conferido. A resposta traz o detalhe em texto ("Vigência até 31/12/2020", "O NCM não está
       na lista do CEST …"), a versão agregada de cada produto (decisão 47), a contagem por motivo e o `cestCarregado`.
       O "CEST obrigatório para NCM listado" (`exige_cest_bem_listado`) não entra: é regra de emissão (fase fiscal).
     - **"Definir NCM" em lote** (`relatorios.ncm_invalidos` + `produtos.editar`): o NCM (existente e vigente, 422) para
       até `LIMITE_DEFINIR_NCM` = **50** produtos (uma página do relatório; cada produto faz dezenas de idas ao banco
       com a trava 7300001 presa, como no cadastro em massa, D65), cada um com a versão que o relatório mostrou, numa
       transação com `travaVersao` (o 503 "sistema ocupado" amigável), **tudo ou nada**. Primeiro confere todos e junta
       os erros por produto (`produtos.N`, cada um com o "código - nome": o excluído depois de abrir o relatório
       também; versão mudada — só conflitos = 409, senão 422 —, as regras do formulário pelo `validarNoBanco`); depois grava cada um pelo **`atualizarProduto`** com a entrada montada do
       detalhe **como o formulário o vê** (as lojas e os estoques permitidos: as linhas das lojas de fora ficam, como no
       PUT, decisão 88) e só o NCM trocado: a versão de novo com a linha travada, a auditoria `editar` própria com a
       localização **"Relatórios › NCMs inválidos"** (opção `localizacao` nova do `atualizarProduto`) e a versão nova
       do produto, que desce ao PDV. O produto que já tem o NCM não é regravado (`semMudanca`). O histórico de preços
       fica com a origem `cadastro` (nenhum preço muda).
     - **Carga do CEST** (`cests.csv`, `lerCests` e `carregarCests` no `carregarReferencias`, idempotente como a dos
       NCMs): `codigo;descricao;segmento;ncms;vigencia_inicio;vigencia_fim`, com a lista de NCMs separada por vírgula
       (os pontos do convênio podem vir, são tirados; 2 a 8 dígitos) e a descrição entre aspas quando tem `;`. Linha
       fora do formato derruba a carga com o número dela. Só as linhas novas ou diferentes são gravadas; o CEST que sair
       do arquivo é excluído logicamente; **o arquivo vazio (ou ausente) não mexe na tabela** ("ainda sem a lista", não
       "revogados"). É tabela de referência pública do Convênio ICMS 142/2018 e alterações, não emissão fiscal. A
       atualização periódica pela plataforma é o F2-B46 (decisão 193).
     - **Pendente: a lista oficial do CEST.** O `cests.csv` versionado está **só com o cabeçalho**: a sessão do
       F2-B41 não conseguiu baixar o Convênio ICMS 142/2018 do CONFAZ (`www.confaz.fazenda.gov.br` recusou a conexão
       a partir do ambiente da sessão), e as linhas nunca são inventadas. Até a carga, o motivo "CEST incompatível" não
       aparece (o card da tela mostra "Tabela não carregada"). Quem tiver acesso converte os anexos do convênio
       vigente para o formato acima, anota aqui **a fonte (URL do CONFAZ) e a data da redação** e roda `db:referencias`.
       Os testes usam a fixture **inventada** `test/fixtures/referencias/cests-inventado.csv` (CEST 99xxxxx, que não
       existem no convênio).
     - Testes: `relatorios-produtos.test.ts` (as médias em decimal, a loja, os filtros, a ordenação que inverte a do
       nome, sem `produtos.ver_custo`, a loja fora das permitidas, as exportações; os motivos e o conjunto do próprio
       `ncmVigente`, o CEST que some com a tabela vazia — esvaziada pelo teste, para valer também depois da lista
       oficial — e aparece com a carga, a exclusão lógica do CEST que sai do arquivo e a volta dele, a posição que
       aceita o item; o "Definir NCM" de 50 produtos com a versão nova, uma auditoria por produto e as filhas
       preservadas; tudo ou nada com um produto válido no lote, só conflitos 409 e conflito + não encontrado 422, o
       excluído identificado, o NCM fora da tabela 422, o mesmo NCM sem regravar; as permissões, inclusive só o
       relatório sem `produtos.editar`), `cests.spec.ts` (o arquivo versionado lido sem erro, o formato e os erros por
       linha) e o `relatorios-produtos.spec.ts` do shared. As checagens repetidas dentro do `definirNcmEmLote`
       (`produtos.editar`) e do `sqlProdutosGeral` (ordenar por custo) são defensivas: as rotas já barram antes.

188. **Relatório Histórico de produtos e a descrição legível da gravação do produto** (Fase 2, F2-B42; ERP 16.2, 17;
     MD 3.1.7; decisões 87, 88, 100, 187; `src/relatorios/historico-produtos.ts`, `src/auditoria/diferenca-produto.ts`,
     as rotas `GET /relatorios/historico-produtos` e `GET /relatorios/historico-produtos/:id?ocorridoEm=`, a gravação
     em `src/produtos/produtos.controller.ts`, `precosPorLojaDoProduto` em `src/produtos/consultas.ts`,
     `auditarPrecosEntrada` em `src/entradas/entrada.ts`, a exportação pelo `provedorHistoricoProdutos` com o
     `converterLote` de `src/tarefas/exportar-relatorio.ts`; contratos no shared `relatorios-produtos.ts`; **sem
     migração**; PDV sem mudança; o ERP é a decisão 76 do README do ERP).
     - **Sobre a auditoria** (`relatorios.historico_produtos`): as linhas das entidades do produto e das filhas
       (`ENTIDADES_HISTORICO_PRODUTOS`: hoje as filhas vão no `antes`/`depois` do próprio `produtos`; as sub-tabelas
       ficam na lista para quando tiverem linha própria) e só as ações de cadastro (`criar`, `editar`, `excluir`,
       `restaurar`, `importar`; a exportação do catálogo, `exportar`, fica fora). Fica fora também o **aviso de
       cadastro do caixa** (`alerta.cadastro`, SYNC 9.24: a auditoria `criar` do produto com a origem `pdv` e a
       localização `LOCALIZACAO_ALERTA_CADASTRO_PDV`, "PDV › Alerta de cadastro"): ele não muda nada no cadastro, e
       entraria como gravação "G" do caixa, com "Tipo alerta" e "Detalhes" como campos do produto no "ver diferença"
       (o aviso continua na tela de auditoria e no painel de alertas). A legenda: **G** = criar/editar,
       **E** = excluir, **R** = restaurar, **I** = a gravação de origem `importacao` (ou a ação `importar`). A
       **localização** é mapeada ("Cad. prod.", "Cadastro em massa", "Importação", "Recebimento", "NF-e", "NCMs
       inválidos"); a origem que não é o ERP vence ("API", "PDV", "Integração", "Sistema", "Suporte": a chamada pela
       API ao `PUT /produtos` grava a localização do formulário). O produto vem pelo `registro_id`, também o excluído
       (marcado). A linha com `loja_id` fora das lojas permitidas não aparece (a do produto não tem loja).
     - **Período obrigatório** (`dataInicial`..`dataFinal`, dias no fuso da empresa, até 366 dias como a Movimentação;
       422 sem ele): a tabela é particionada por mês em `ocorrido_em`, então os limites vão como **parâmetros** e o
       fuso é lido antes, numa ida própria (com o `fusoDaEmpresa` dentro do `where`, uma subconsulta, as partições só
       seriam descartadas na execução, não no plano). O teste confere com `EXPLAIN` que só a partição do período entra. Paginação
       por página com o total (a contagem com o mesmo `where`); a ordem é fixa, a mais recente primeiro (`ocorrido_em`,
       `id`). Filtros: **texto** (contido em `descricao`, sem acento nem caixa — `fn_unaccent` + `ilike`, o `%`/`_`
       literais), **usuário**, **tipo** e **produto** (`registro_id`, pelo `ix_auditoria_entidade_registro_id`).
       O texto é procurado **no escopo de quem consulta** (`textoPesquisavel`): sem `produtos.ver_custo`, a
       `descricao` sem os trechos de custo (`TRECHO_CUSTO_GRAVADO`: "Preço de custo: (alterado)", "Markup %:
       (preenchido)", "Custo do fornecedor (alterado)", tirados com `regexp_replace` antes do `ilike`); com lojas ou
       estoques restritos, sem o aviso "Dados de loja alterados" (que pode ser de uma loja de fora). Sem isso, procurar
       "custo" ou "dados de loja" diria em qual produto e quando mudou o que a permissão esconde (o valor nunca vaza:
       o texto gravado não o tem), mesmo com o texto da linha sem citá-lo.
     - **A descrição legível passa a ser gravada** (ERP 16.2: "a edição de produto passa a gravar a `descricao`
       legível, para o filtro de texto funcionar"): o `inserirProduto` e o `atualizarProduto` — o formulário, a
       importação, o cadastro em massa (F2-B39) e o "Definir NCM" (F2-B41), todos por eles — gravam em
       `auditoria.descricao` o texto de `descricaoGravacaoProduto`, e a exclusão grava "Produto N - NOME excluído".
       **Nada muda no produto nem na versão**: só a linha de auditoria ganha o texto. Como a tela de auditoria (17.3)
       mostra a `descricao` a todos com `auditoria.ver`, o texto gravado é o **neutro** (`ESCOPO_GRAVADO`): o custo só
       com o rótulo ("Preço de custo: (alterado)") e o que é de loja (a linha da loja, a faixa de uma loja, o lote de
       um estoque) num aviso só, "Dados de loja alterados", sem loja nem valor. Até 2.000 caracteres (o "ver diferença
       completa" recalcula tudo do `antes`/`depois`). As linhas de antes do F2-B42 não têm o texto (o filtro de texto
       não as acha; o relatório as mostra mesmo assim, com o texto montado na leitura).
     - **O formatador** (`diferenca-produto.ts`, puro e com teste próprio): compara `antes` (o detalhe do produto) e
       `depois` (a linha gravada mais as filhas) com os rótulos dos campos do formulário ("Preço de venda: 9,90 →
       10,90"; o decimal `"9.9000"` do banco é igual ao `"9.9"` do corpo), as referências pelo nome ("Marca: — →
       HEINEKEN", a categoria pelo caminho, a loja, o produto "código - nome", o fornecedor, o estoque; os nomes numa
       ida por cadastro para a página inteira, também os excluídos) e as **filhas** com a chave natural de cada uma
       (o código de barras pelo código, a loja pela loja, a faixa pela loja + quantidade inicial, o componente pelo
       tipo + produto + variação, o relacionado pelo produto + tipo, o fornecedor pelo (fornecedor, código), o lote pelo
       id, as categorias pelo id): adicionada ("EAN adicionado 789…", com o resumo), removida e alterada ("Loja Centro:
       Preço de venda 9,90 → 10,90"). Só entram os campos presentes **dos dois lados** (o detalhe e a linha gravada
       têm campos diferentes, como `unidadeSigla` e `grupoPreco`, que não são mudança); na criação, os preenchidos fora
       do padrão. **Campo desconhecido** entra com o nome da chave ("Campo novo: A → B"; objeto só "(alterado)"; o de
       nome com "custo"/"markup" segue a regra do custo).
     - **O `depois` das lojas e das faixas vem do banco** (`precosPorLojaDoProduto`, no formato do `antes`): o corpo
       de quem só vê algumas lojas não traz as outras, que a gravação preserva (decisão 88), e o histórico as daria
       como removidas. Muda só o conteúdo dessas duas listas no `depois` da auditoria (como já era com os fornecedores
       e os lotes, F2-B13 e F2-B17); as linhas gravadas antes do F2-B42 por quem tinha lojas restritas podem mostrar
       a loja de fora como "removida" (só a quem a vê).
     - **O que se mostra é montado para quem consulta** (`escopoDaSessao`), na linha e no "ver diferença completa":
       o `antes`/`depois` passa por `redigirParaVisao` (decisão 100) e a diferença pelo escopo — o custo com os
       valores só com `produtos.ver_custo` (sem ela, nem o rótulo), só as lojas e os estoques permitidos (a faixa de
       todas as lojas e o lote sem estoque são de todos). Os nomes buscados também respeitam o escopo (a loja de fora
       nem é lida). A linha com uma filha só (a relação inversa criada por outro produto, o vínculo de fornecedor
       movido por outro produto ou pela NF-e) mostra a `descricao` gravada, que conta de onde veio.
     - **"Ver diferença completa"** (`GET /relatorios/historico-produtos/:id?ocorridoEm=`): a tabela campo × antes ×
       depois de todos os campos que mudaram (a filha no rótulo, "Loja Centro › Preço de venda"); na exclusão, o
       cadastro que existia. O `ocorridoEm` escolhe a partição (uma janela de 1 ms: a página o manda em milissegundos e
       o banco guarda microssegundos); fora do produto, das ações ou das lojas permitidas (e no aviso do caixa), 404.
       A rota fica depois de `:relatorio/exportar`, para `historico-produtos/exportar` não cair nela.
     - **A importação** passa a gravar a localização "Produtos › Importação" na auditoria do produto (antes ia a do
       formulário; o relatório também a reconhece pela origem `importacao`).
     - **O preço mudado pela entrada** (o recebimento manual e a NF-e de fornecedor, ERP 13.3/13.4 "Altera Preço do
       Produto"/"Atualiza Preço de Custo") passa a ter a auditoria do produto, a mudança de preço mais comum da loja:
       antes só ia ao Histórico de preços (F2-B37), e a localização "Recebimento"/"NF-e" do relatório nunca aparecia.
       `movimentarEntrada` devolve `precosAlterados` (os produtos com o custo, a venda geral ou o preço da loja
       destinatária mudados, no formato do `antes`/`depois` do cadastro: `precoCusto`, `precoVenda`, `markupPct` e a
       loja em `lojas`, com o `nome` igual dos dois lados, que marca a linha como do cadastro inteiro), e o
       controlador grava, na mesma transação, uma linha `editar` de `produtos` por produto
       (`auditarPrecosEntrada`), com a localização da tela (`Estoque › Recebimentos` ou `Estoque › Recebimento de
       NFe`) e a `descricao` neutra precedida do documento ("Recebimento Nº 12: Preço de custo: (alterado); Preço de
       venda: 8,00 → 8,90"). A linha é da empresa, sem `loja_id` (como a do cadastro): o preço da loja sai do texto
       de quem não vê a loja pelo escopo. O Histórico de preços continua com a origem e o id do documento.
     - **Exportação** (Excel/CSV pela rota comum, ERP 3.5; F2-B29, decisão 177): `GET
       /relatorios/historico-produtos/exportar` (`relatorios.exportar` e `relatorios.historico_produtos`), com os
       filtros da tela (a página é ignorada) e as colunas Usuário, Tipo, Localização, Data/hora, Código, Produto e
       Histórico. O texto do Histórico é montado **no escopo de quem exporta**, como na tela: o provedor ganhou dois
       opcionais, `converterLote` (cada lote lido do cursor vira as linhas das colunas, com os nomes citados numa ida
       por cadastro por lote, na conexão e no instantâneo do cursor) e `linhasPorLote` (1.000 aqui: cada linha traz o
       `antes`/`depois` inteiros do produto; vale o menor entre ele e o da instância).
     - **Uma base só para a página, a exportação e o detalhe** (`sqlLinhas`, as colunas e o `left join produtos`, e
       `condicaoBase`, as entidades, as ações, o aviso do caixa de fora e as lojas da sessão): uma coluna ou um filtro
       de visão novo vale nas três consultas.
     - Testes: `diferenca-produto.spec.ts` (o critério de pronto, o decimal igual, a referência pelo nome, filhas
       adicionadas, removidas e alteradas, campos desconhecidos, o custo nos três escopos, o que é de loja com as
       permitidas e o aviso do texto gravado, os trechos de custo que o filtro tira, a criação, a tabela),
       `historico-produtos.test.ts` (a edição pelo formulário com o texto do critério de pronto, a `descricao`
       gravada sem custo nem loja, o usuário de uma loja que não deixa a outra "removida", o escopo sem
       `produtos.ver_custo` e só com uma loja no texto e no detalhe, a linha de loja de fora e o 404, a outra entidade e a exportação de fora, a legenda e a localização, os filtros e
       a paginação, o filtro de texto sem achar o custo nem o aviso de loja para quem não os vê, o aviso do caixa de
       fora (e o 404) com outra linha do PDV dentro, a exportação CSV com o escopo de quem exporta, o período
       obrigatório e o teto, a linha antiga fora do período, o `EXPLAIN` com as partições; as consultas de ontem a
       hoje, para a meia-noite de Brasília no meio da execução não tirar as linhas do período),
       `recebimento-movimentar.test.ts` e `notas-entrada-movimentar.test.ts` (a mudança de preço como "Recebimento" e
       "NF-e", com o texto legível e a `descricao` gravada com o documento), `importacao-nuvem3.test.ts` (a
       localização "Produtos › Importação" e a `descricao` da criação e da edição pela planilha),
       `cadastro-massa.test.ts` (a `descricao` do cadastro em massa) e o `relatorios-produtos.spec.ts` do shared.

189. **Envio de arquivos e imagens: o tipo pelo conteúdo, os limites no stream e a variante `pdv_256`** (Fase 2,
     F2-B43; MD 3.1.6; SYNC 6.12; ERP 8.2.6, 10.3.4; decisões 91 e 93; `src/arquivos/` (o controlador, o serviço
     `Arquivos`, `vincularArquivo` e `imagens.ts`), `chaveVariante` e `excluir` em `src/infra/armazenamento.ts`, os
     Anexos no `PUT /lojas/:id`; contratos no shared `arquivos.ts` e os códigos `ARQUIVO_GRANDE` (413) e
     `TIPO_NAO_SUPORTADO` (415) em `erros.ts`; migração **`0027_arquivos_variantes`**; PDV sem mudança: o
     `/sync/arquivos` e o `foto_url` são o F2-B45; o ERP é a decisão 77 do README do ERP).
     - **`POST /api/arquivos?destino=…`** (multipart, um arquivo no campo `arquivo`, nenhum campo de texto). O
       **destino** (`DESTINOS_ARQUIVO` no shared: `produto_foto`, `categoria_imagem`, `marca_logotipo`,
       `loja_logotipo` e `loja_foto`, estes dois com `&lojaId=`) decide a categoria e a entidade gravadas, os tipos, o
       limite e as variantes. Vem na **query**, não no corpo: assim tudo é decidido **antes** de ler o corpo.
     - **Antes de o multer ler** (o interceptor `LimiteEnvioArquivo`, como o da NF-e, decisão 164): a query; a
       **permissão do destino** (basta uma: `produtos.criar` ou `produtos.editar`, `categorias.editar`,
       `marcas.criar` ou `marcas.editar`, `lojas.editar`; sem ela, 403 sem ler nada) e a loja entre as permitidas
       (fora delas, 404); o `Content-Length` contra o limite do destino mais 16 KiB do multipart (acima, 413
       `ARQUIVO_GRANDE`; sem ele, o envio em pedaços, 422); o limite por usuário por minuto
       (`ARQUIVOS_ENVIOS_POR_MINUTO`, 30) e o de envios simultâneos do usuário (`ARQUIVOS_ENVIOS_SIMULTANEOS_USUARIO`,
       2: o logotipo e a foto da loja juntos; o terceiro, 429 na hora), que é o que limita a memória da leitura
       (2 × o limite do destino por usuário).
       Depois, o **multer corta o stream** no limite do destino (`limits` como função da requisição, multer ≥ 2.4:
       2 MB; 1 MB no logotipo, o da loja vai ao cupom e ao DANFE): o `Content-Length` que mente não passa de lá, e a
       memória de um envio é a do limite. Um arquivo só, `fields: 0`, `parts: 1`.
     - **A vaga do semáforo do processo** (`ARQUIVOS_ENVIOS_SIMULTANEOS`, 4; o interceptor `VagaEnvioArquivo`, depois
       do multer) é pega com o corpo **já lido** e solta quando a resposta termina: protege a memória e a CPU (o
       buffer juntado, a variante e a gravação), não a rede. Na primeira versão do bloco ela vinha antes da leitura, e
       a revisão mostrou que dois usuários quaisquer (o limite por usuário é por usuário, o semáforo é do processo)
       com 2 envios lentos cada (o `Content-Length` de ~1 MB e o corpo a poucos bytes por segundo, até o
       `requestTimeout` de 300 s do Node, ou os 60 s do `readTimeout` do Traefik) prendiam as 4 vagas e deixavam os
       envios de todas as outras empresas na fila, sem resposta. Agora o envio lento segura só a vaga do próprio
       usuário; quem espera o semáforo espera só o processamento dos outros, que tem fim. O envio da NF-e (decisão 164)
       tem o mesmo desenho antigo e fica como está (fora do bloco; o corpo dele vai a 20 MB).
     - **O tipo é o do conteúdo** (`detectarTipoArquivo`, os magic bytes: PNG pela assinatura de 8 bytes, JPEG por
       `FF D8 FF`, WebP pelo `RIFF….WEBP`, PDF por `%PDF-`), nunca a extensão nem o `Content-Type` do cliente; fora
       dos tipos do destino, 415 `TIPO_NAO_SUPORTADO`. **SVG nunca** (é documento com script, não imagem: o ERP 9.1
       ainda o citava no logotipo da empresa e foi corrigido), nem GIF, HEIC ou TIFF. **O PDF** é reconhecido, mas
       nenhum destino do F2-B43 o aceita: o "pdf só nos anexos" do plano ficou para os anexos que são documento (o
       boleto e o comprovante do financeiro, ERP 15), com a tela deles; os Anexos da loja (ERP 10.3.4) são as duas
       imagens.
     - **A imagem é decodificada de verdade** (`processarImagem`, sharp 0.35.5): o PNG truncado ou o HTML com o
       cabeçalho de PNG voltam 415 ("corrompido ou não é uma imagem"), e o formato que o libvips vê tem de ser o
       detectado. Contra a **bomba de descompressão**: o cabeçalho é lido primeiro (`metadata`, que não decodifica) e
       acima de `IMAGENS_LIMITE_PIXELS` (36 MP: a foto do celular tem 12 a 24) ou com várias páginas (animação) volta
       422 com o tamanho; o `limitInputPixels` do sharp é a segunda barreira. **Uma imagem por vez no processo**
       (`IMAGENS_CONCORRENCIA`, 1, como o argon2 e a planilha da decisão 93), `sharp.concurrency(1)` (uma thread do
       libvips) e `sharp.cache(false)`. **Só os leitores de PNG, JPEG e WebP em memória** ficam liberados no processo
       inteiro (`sharp.block({ operation: ['VipsForeignLoad'] })` + `unblock` dos três): SVG, PDF, TIFF, HEIF, GIF e
       os leitores de arquivo do libvips não rodam nem chamando o sharp direto.
     - **A variante `pdv_256`** (SYNC 6.12): WebP qualidade 80, até 256 px no maior lado (`fit: 'inside'`, sem
       ampliar a imagem menor), com a orientação do EXIF aplicada e **sem metadados** (o EXIF do original, com o GPS do
       celular, não vai para a variante; o original fica como enviado, para o sha256 ser o do arquivo). Todas as
       imagens dos destinos de hoje ganham a variante (a miniatura do ERP também a usa); a `cupom_mono` do logotipo
       e a `banner_1366` entram com o uso delas (o caixa ainda não imprime o logotipo da loja: pendência em
       `docs/andamento.md`, sem bloco na Fase 2; a dica da tela avisa).
     - **Gravação.** A chave é do servidor (`chaveArquivo`: `emp/<codigo>/<categoria>/<aaaa>/<mm>/<uuidv7>.<ext>`,
       a extensão do tipo detectado; a variante ao lado, `….pdv_256.webp`, `chaveVariante`): o nome do cliente só vai
       para `nome_original` (sem as pastas nem caracteres de controle, `nomeOriginalSeguro`), nunca para o caminho nem
       para um cabeçalho. O original e a variante vão ao armazenamento **antes** da linha (E/S fora de transação, MD
       1.5), com o sha256 nos metadados do objeto; a linha guarda o sha256, o tipo detectado e **`variantes`** (jsonb:
       `{ "pdv_256": { chave, tipoMime, tamanhoBytes, sha256, largura, altura } }`, a coluna nova da `0027`, `not
       null default '{}'`, que no PostgreSQL 11+ não reescreve a tabela). A linha falhou → os objetos são apagados
       (`excluir`). A resposta (`ArquivoInfo`) nunca traz a chave.
     - **Quem vê** (`GET /api/arquivos/:id`, os metadados; `GET /api/arquivos/:id/conteudo[?variante=pdv_256]`): a
       empresa é a do banco do token (o id de outra empresa não existe aqui: 404), e o arquivo só aparece a quem vê o
       cadastro dono (`produtos.ver`, `categorias.ver`, `marcas.ver`; `lojas.ver` com a loja do arquivo entre as
       permitidas), também 404 (não revela que existe). As outras categorias (XML, planilhas, logs) têm as rotas delas
       e aqui são 404. O conteúdo passa pela API (são até 2 MB; o `<img>` do ERP não manda o token, então a tela
       baixa como blob), com o `Content-Type` **gravado** (o detectado: nunca `text/html` nem `image/svg+xml`),
       `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` (quem abrir o
       endereço direto não roda nada), `Content-Disposition` com o nome gerado `<id>[.<variante>].<ext>` (`inline` na
       imagem, `attachment` no PDF), `ETag` = o sha256 e `Cache-Control: private, max-age=300`.
     - **Os Anexos da loja** (ERP 10.3.4, a pendência da decisão 91): `logotipoArquivoId` e `fotoArquivoId` no
       `PUT /lojas/:id` (`alterarLojaSchema`): o id de um envio `loja_logotipo`/`loja_foto` **da própria loja**,
       `null` tira, ausente mantém (o ERP de antes do F2-B43 não manda e não apaga nada). `vincularArquivo` confere na
       transação a categoria, a entidade, a loja e que o arquivo não é de outro registro (senão 422 no campo) e grava o
       `registro_id`. A coluna já descia ao PDV no fluxo `configuracao` como texto (o PDV ignora: quem baixa a imagem é
       o F2-B45); trocar o anexo só dá versão nova à linha da loja. A foto do produto, a imagem da categoria e o
       logotipo da marca ligam pelo mesmo `vincularArquivo` no F2-B44.
     - **Divergência com o documento:** a ERP 10.3.4 dizia o logotipo da loja "≤ 500 KB"; vale o 1 MB do plano
       (`DESTINOS_ARQUIVO.loja_logotipo`), e a especificação foi corrigida.
     - **Fora do bloco:** a limpeza dos envios abandonados (enviados e nunca gravados num cadastro: `registro_id`
       nulo; o índice `ix_arquivos_entidade_registro_id` já serve a ela) e o logotipo da empresa (Configurações ›
       Geral, `geral.logotipo_arquivo_id`), que entra com a tela dele, também sem SVG.
     - **A dependência nova na imagem Docker:** o `sharp` traz o libvips pré-compilado (versões escolhidas). O
       `pnpm install --frozen-lockfile` e o `pnpm --filter api deploy --prod` (o passo do `apps/api/Dockerfile`)
       foram conferidos no Linux (glibc) da sessão: o `node_modules` de produção traz `@img/sharp-linux-x64` e
       `@img/sharp-libvips-linux-x64` e o sharp carrega a partir dele. O `docker build` em si não rodou na sessão (sem
       o daemon do Docker); a CI da `main` monta a imagem.
     - Testes: `arquivos.spec.ts` do shared (os magic bytes, os destinos, as mensagens e a loja no envio),
       `src/arquivos/arquivos.spec.ts` (o nome seguro, a chave da variante, a variante sem ampliar e com o EXIF
       girado, a bomba, o formato trocado, o truncado e o SVG bloqueado no sharp) e `arquivos.test.ts` (o critério de
       pronto: o JPEG 800 × 600 gravado com o sha256 no banco e no objeto e a `pdv_256` WebP 256 × 192; PNG e WebP com o
       tipo do conteúdo e não o do cliente; o HTML renomeado para `.png` 415 sem gravar nada (a contagem de `arquivos`
       antes e depois, sem depender da ordem dos testes); SVG, GIF, PDF na foto e o PNG truncado 415; 2,1 MB e o
       logotipo de 1,1 MB 413 pelo `Content-Length` (só o cabeçalho da parte é mandado: o 413 chega sem o corpo); 1
       byte acima do limite cortado no stream (o serviço não chega a ser chamado, e no limite exato chega); o terceiro
       envio simultâneo do mesmo usuário 429 (e as vagas de volta quando os outros terminam); 4 envios lentos de dois
       usuários sem prender o envio da outra empresa; o envio em pedaços 422; a bomba 50.000 × 50.000 422 sem a memória subir; a permissão 403, o destino e a
       loja 422/404, o campo extra 422; o path traversal; outra empresa 404 nos dois sentidos; o arquivo de cadastro que
       o usuário não vê, o da outra loja e a planilha 404; os cabeçalhos do conteúdo; os Anexos da loja gravados,
       mantidos sem o campo e tirados com `null`, e recusados com outra categoria, outra loja ou id inexistente; 20
       envios seguidos de ~1,1 MB sem a memória crescer, medidos depois do `gc()` (o `vitest.integracao.config.ts`
       liga o `--expose-gc`, e o teste exige o GC): o heap, o `external`/`arrayBuffers` (menos os bytes exatos que o
       S3 em memória guardou) e o rss abaixo de 10 MB (40 MB no rss), que guardar o buffer de cada envio (22 MB)
       estoura, e o cache do libvips desligado (`sharp.cache()` com o máximo 0); 4 envios ao mesmo tempo com uma
       tarefa do libvips por vez, `sharp.counters()`). Conferido tirando cada proteção (o `sharp.cache(false)`, o
       semáforo de `imagens.ts`, o `fileSize` do multer, o `Content-Length`, a vaga depois da leitura, e guardando o
       buffer de cada envio): o teste correspondente falha. Imagens inventadas, geradas no teste (`test/fixtures/imagens.ts`).

190. **Foto e galeria do produto, imagem da categoria, logotipo da marca, a reordenação das categorias e a ficha da
     marca** (Fase 2, F2-B44; ERP 8.2.6, 8.4, 8.7; decisões 61, 62 e 189; `src/produtos/gravacao.ts`
     (`vincularImagensProduto`, `gravarImagens`), `consultas.ts` (`imagensDoProduto`, a galeria na versão do cadastro),
     `produtos.controller.ts`, `src/catalogo/categorias.controller.ts` (`POST /categorias/reordenar`) e
     `marcas.controller.ts` (`GET /marcas/:id/ficha`), a filha `imagens` em `src/auditoria/diferenca-produto.ts`;
     contratos no shared `catalogo.ts` (`reordenarCategoriasSchema`, `FichaMarca`), `produtos.ts`
     (`fotoPrincipalArquivoId`, `imagens`, `MAXIMO_IMAGENS_PRODUTO`) e `idArquivoAnexo` em `arquivos.ts`; **sem migração**:
     as colunas e a `produtos_imagens` já existiam; PDV sem mudança: o `foto_url` e o `/sync/arquivos` são o F2-B45; o ERP
     é a decisão 78 do README do ERP).
     - **O anexo nos cadastros** (`idArquivoAnexo`, o mesmo dos Anexos da loja): o id de um envio do destino do campo
       (`produto_foto`, `categoria_imagem`, `marca_logotipo`), `null` tira e **ausente mantém**. É o que deixa a
       importação de planilha, o cadastro em massa, o "Definir NCM" em lote (que partem de `entradaDoDetalhe`, que agora
       tira a foto e a galeria) e o ERP de antes desta versão gravarem sem apagar a imagem. `vincularArquivo` (decisão
       189) confere **na transação da gravação** que o id é um envio vivo desta empresa com a categoria e a entidade do
       campo e ainda sem dono (ou já deste registro), e grava o `registro_id`; senão 422 no campo
       (`fotoPrincipalArquivoId`, `imagens.N`, `imagemArquivoId`, `logotipoArquivoId`) e nada é gravado. O id que já
       estava gravado não é conferido de novo. O arquivo de outra empresa não existe no banco desta: é o mesmo 422 (o
       `GET` dele continua 404). O registro novo ganha o id **antes** da linha (`uuidv7`, como a categoria já fazia),
       para a conferência rodar antes do `insert` (a FK de `foto_principal_arquivo_id` só confere que o arquivo existe,
       não o destino). A foto do produto vale para quem tem `produtos.criar`/`editar` (o Estoquista inclusive), a da
       categoria `categorias.editar` e o logotipo `marcas.criar`/`editar`, as mesmas do envio.
     - **A galeria do produto** (`produtos_imagens`, até `MAXIMO_IMAGENS_PRODUTO` = 10 além da foto; não desce ao PDV):
       a lista de ids na ordem, inteira (vazia = tira todas; ausente = mantém), identificada pelo arquivo
       (`uq_produtos_imagens`): a que saiu é excluída logicamente, a nova entra, a que ficou só muda a ordem (1, 2, 3…);
       repetida na lista é 422 no zod. O arquivo que sai fica guardado (o histórico mostra a troca; a limpeza dos
       envios sem dono continua fora, decisão 189). A **versão do cadastro** (`sqlVersaoAgregada`, decisão 47) passa a
       contar a `produtos_imagens`: mexer só na galeria e gravar com a versão de antes é 409. A **auditoria** tem a
       filha `imagens` ("Imagem da galeria adicionada (posição 1)", "removida", "Posição 2 → 1"); a foto continua
       "Foto principal: (alterado)" (o id não tem nome legível). A cópia do produto (Duplicar, no ERP) sai sem imagens:
       o arquivo é do produto de origem, e a API recusaria.
     - **`POST /categorias/reordenar`** (`categorias.editar`; o soltar entre duas categorias, ERP 8.4): `{ categoriaPaiId,
       itens: [{ id, versao }] }` com a lista **inteira** das filhas vivas do pai (vazio = as raízes, até 500) na ordem
       nova. Numa transação com a `fn_trava_versao` (as reordenações e os `mover` da empresa ficam em fila, então duas
       telas não montam um ciclo nem se atropelam): prende o pai e as categorias pedidas e as filhas do pai, na ordem do
       id; o id que não existe nesta empresa é 404; a versão diferente, a categoria que outro moveu para outro pai ou
       excluiu e a filha nova que a lista não traz são **409** `CONFLITO_VERSAO` com quem alterou, e nada muda. Grava
       `ordem` = posição × `PASSO_ORDEM_CATEGORIAS` (10, 20, 30…: o campo Ordem do painel continua servindo para
       encaixar entre duas) **só nas que mudaram** (só elas ganham versão nova, descem ao PDV e ganham uma linha de
       auditoria "Categoria reordenada" com a ordem antes e depois). O pai, o caminho, o nível e o nome não mudam: a
       árvore não muda de forma. Devolve a árvore. **Mudar de pai** continua o `POST /categorias/:id/mover` (decisão 61:
       sem ciclo pelo caminho materializado, até 5 níveis com a subárvore, nome único entre as irmãs), que o soltar
       "dentro" chama com a ordem do fim da lista; o soltar entre duas de outro nível chama o `mover` e depois o
       `reordenar` (duas transações: se o segundo der 409, a categoria fica no pai novo e o ERP recarrega e avisa).
     - **`GET /marcas/:id/ficha`** (`marcas.ver` **e** `produtos.ver`: a lista é do cadastro de produtos): a marca e os
       produtos dela, ativos e inativos e não excluídos, pelo nome, com o código, o EAN principal, a unidade e o preço de
       venda; nada de custo. Até `LIMITE_PRODUTOS_FICHA_MARCA` (5.000) produtos, com o total à parte. A marca de outra
       empresa é 404. O ERP a imprime pelo navegador (padrão "Impressão" do plano).
     - Testes: `imagens-catalogo.test.ts` (o critério de pronto: o produto com foto e galeria e os arquivos ligados a ele;
       reordenar, tirar e incluir na galeria com a auditoria; a versão velha depois de mexer só na galeria 409; o corpo
       sem os campos mantém, `null`/`[]` tiram; o anexo de outro destino, de outro produto, de outra empresa e o
       inexistente 422 no campo sem gravar nada; o Estoquista grava a foto; a imagem da categoria na criação e na
       alteração e a de outro destino 422; "Cervejas long neck" movida para dentro de "Cervejas" e reordenada antes de
       "Cervejas lata", só a que mudou com versão nova e auditoria; as raízes; o 409 da versão velha, da irmã fora da
       lista, da categoria de outro pai e da excluída no meio, com as ordens e versões intactas; o 404 da outra empresa,
       o 422 do pai inexistente e o 403 sem `categorias.editar`; o ciclo do `mover`; o logotipo da marca e a ficha com
       os produtos, sem custo; a de outra empresa 404 e sem `produtos.ver` 403) e, no shared, `produtos.spec.ts` (a
       foto e a galeria ausentes, o repetido e o teto) e `cadastros.spec.ts` (o `reordenarCategoriasSchema`). Imagens
       inventadas, geradas no teste.

191. **Complementos do produto: as tabelas, a FK segura da venda e só inativação** (Fase 2, F2-B45; F2-Q1 = roadmap D43:
     complementos sim; MD 3.6.8; migração **`0028_complementos`**; `src/database/empresa/schema/produtos.ts`
     (`produtosGruposComplementos`, `produtosComplementos`), `vendas.ts` (a FK de `itens_venda_complementos`),
     `src/sync/fluxos.ts` (as duas no `catalogo`) e `src/sync/handlers/vendas.ts` (`complementosConhecidos`)).
     - **As tabelas**: `produtos_grupos_complementos` (`produto_id` → produtos, `nome` varchar(40), `minimo`/`maximo`
       smallint, `obrigatorio`, `ordem`) e `produtos_complementos` (`grupo_id` → grupos, `produto_id` → produtos
       anulável — a opção vinculada — ou `descricao` varchar(60) — a livre —, `preco_adicional` numeric(15,4),
       `baixa_estoque`, `quantidade_baixa` numeric(15,3), `ordem`, `ativo`), com CP e AU. CHECKs da MD 3.6.8:
       `ck_produtos_grupos_complementos_quantidades` (`minimo >= 0 and maximo >= minimo and (not obrigatorio or minimo >=
       1)`), `ck_produtos_complementos_origem` (vinculada ou livre), `_baixa` (baixa estoque só a vinculada) e
       `_valores` (preço adicional ≥ 0 e quantidade da baixa > 0). Que o grupo seja de um produto `com_complementos`
       fica para a gravação do ERP (F2-B51), como as outras regras de tipo das filhas do produto.
     - **Descem no `catalogo`** com todas as colunas e sem filtro (o produto desce a todas as lojas): `fn_versao` (trava
       de ordenação), `ix_<tabela>_versao` e as FKs de autoria, como as demais filhas; `TABELAS_COM_AUTORIA` e o
       `Esquema.g.cs` (espelhos novos no PDV 0.12.0, decisão 85 do README do PDV) acompanham. O PDV anterior descarta as
       tabelas que não conhece sem travar o cursor (SYNC 6.10). Até o F2-B51 elas ficam vazias e
       `produtos.complementos_habilitados` continua desligada (ligada por padrão desde o F2-B51, decisão 194).
     - **Exclusão física recusada** (`fn_exclusao_fisica_proibida`, `before delete` por linha e `before truncate` por
       comando, nas duas): o erro `P0001 EXCLUSAO_FISICA_PROIBIDA`. Só a exclusão lógica (`excluido_em`, que desce como
       tombstone) e o `ativo`: o caixa offline pode ter na venda o id de uma opção, e a nuvem continua conhecendo esse
       id quando o evento chegar. O `truncate ... cascade` também para no trigger (antes de esvaziar as vendas).
     - **`itens_venda_complementos.complemento_id` → `produtos_complementos` com `on delete set null`** (antes sem FK,
       "futuro"), com o índice da FK. A migração zera o id que existisse antes de criar a FK (nenhum caixa publicado manda
       complementos: a lista vai vazia, então em produção nada muda). Para a FK nunca recusar uma venda, o
       `conferirDocumentoVenda` lê quais `complemento_id` do documento existem (`complementosConhecidos`, uma consulta) e
       o `montarLinhas` grava **nulo** o que a nuvem não conhece (o nome do grupo e a descrição ficam no item). O reenvio
       do mesmo evento passa pela mesma regra, então a conferência da camada 2 (SYNC 8.4) não acusa divergência. Era o
       que o plano deixava para a Fase 3; entrou aqui porque a FK nasce aqui.
     - `venda.finalizada` continua v1 e `versoes_schema` não muda (SYNC 17.5): o bloco `itens_venda_complementos` já
       existia no payload.
     - Testes: `sync-arquivos.test.ts` (as duas tabelas no pull com todas as colunas; os CHECKs, cada um pelo nome; o
       DELETE e o TRUNCATE recusados com o código; a inativação que desce como tombstone; a FK com `set null`),
       `venda-eventos.test.ts` (o `complemento_id` conhecido gravado, o desconhecido nulo, o reenvio `ja_existia`),
       `versionamento.test.ts` e `sync-triggers.test.ts` (os triggers e a autoria pelas listas) e `esquema-pdv.spec.ts`.

192. **`GET /sync/arquivos/{id}?variante=pdv_256` e os campos calculados das imagens no pull** (Fase 2, F2-B45; SYNC
     6.12, 17.2; MD 6.2; decisões 189 e 190; `src/sync/arquivos.ts` (`camposImagemPdv`, `ArquivosSync`),
     `src/sync/sync.controller.ts`, `fluxos.ts` (`calculadas`), `pull.ts`, `src/database/esquema-pdv.ts`; contrato
     `arquivoSyncQuerySchema` no shared `sync/contratos.ts`; sem migração).
     - **Campos calculados** (`TabelaFluxo.calculadas`): campos que descem na linha sem existir na tabela, depois das
       colunas. `foto_url`/`foto_sha256` nos produtos, `imagem_url`/`imagem_sha256` nas categorias e
       `logotipo_url`/`logotipo_sha256` nas marcas: o caminho **estável** `/sync/arquivos/{arquivo_id}?variante=pdv_256`
       (nunca uma URL assinada, que expiraria e mudaria a linha) e o sha256 **da variante** (`arquivos.variantes`), por
       uma subconsulta pela PK de `arquivos` que exige o envio vivo do destino certo (categoria e entidade) e com a
       variante; senão os dois descem nulos. O arquivo não muda depois do envio: trocar a imagem troca o id na linha do
       cadastro, que ganha versão nova e desce (a projeção sozinha nunca muda a linha, então dois pulls dão o mesmo
       valor). O gerador do `Esquema.g.cs` lista cada campo calculado no fim da tabela como coluna **projetada e
       anulável** (o PDV confere tipo e nulidade como as outras; o nome que colide com uma coluna é erro do gerador). O
       `logotipo` e a `foto` da loja não descem (pendência do cupom, `docs/andamento.md`).
     - **O endpoint** (`EndpointSync` `arquivos`): o token do terminal, como o pull; não exige o hardware registrado
       (são os mesmos cadastros que o pull entrega a ele), e o terminal em desativação recebe 403 `ESCOPO_INVALIDO` como
       no pull do `catalogo`. Só a variante `pdv_256` (outra ou ausente: 400 `REQUISICAO_INVALIDA`); o id no caminho,
       sem diferença de caixa. **Escopo:** só o arquivo ligado a um cadastro **vivo** que desce ao terminal — a foto
       principal de um produto, a imagem de uma categoria ou o logotipo de uma marca —, com a categoria e a entidade do
       destino (a mesma regra dos campos calculados). A empresa é a do banco do terminal: o arquivo de outra empresa, o
       envio solto, o do produto excluído, o de outra categoria (logotipo e foto da loja, XML, planilhas, anexos) e o id
       inválido dão **404 `NAO_ENCONTRADO`**, sem dizer qual (a SYNC 6.12 falava em 403 para a outra categoria; o 404
       não confirma que o id existe). A galeria (`produtos_imagens`) não desce.
     - **A resposta**: o conteúdo sai pela própria API, e não pelo `302` para a URL assinada da SYNC 6.12: a variante tem
       10–20 KB, e assim o `Content-Type` é o **fixo** do caixa (`image/webp`; a variante gravada com outro tipo, com o
       sha256 fora do formato ou acima de `LIMITE_BYTES_VARIANTE_PDV` = 512 KB é 404), com `X-Content-Type-Options:
       nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline;
       filename="<id>.pdv_256.webp"` (nunca o nome do cliente), `Cache-Control: private, no-cache` e o **`ETag` com o
       sha256**: o `If-None-Match` com ele (ou `*`) responde `304` sem ler o objeto. O PDV confere o sha256 do que
       baixou antes de gravar no disco (decisão 86 do README do PDV).
     - **Limite por terminal** (`SYNC_ARQUIVOS_POR_MINUTO`, padrão 120 por minuto, na memória da instância como o da
       consulta de saldos): `429 LIMITE_TAXA` com `Retry-After: 60`. O caixa baixa sob demanda, 2 por vez.
     - **Compatibilidade**: campo novo na linha do pull e rota nova são mudanças compatíveis (SYNC 17.2): o PDV 0.11.0
       grava `foto_url`/`foto_sha256` (as colunas existem no espelho dele desde a 1A) e descarta os campos das marcas e
       das categorias e as tabelas de complementos; a API vai para a produção **antes** do PDV 0.12.0.
     - Testes: `sync-arquivos.test.ts` (o critério de pronto: `foto_url`/`foto_sha256` no pull, o sha256 da variante e
       não o do original, nulos sem foto, `imagem_*` e `logotipo_*`; estável entre dois pulls e sem versão nova; trocar a
       foto desce a URL e o sha256 novos; o download com o tipo fixo, `nosniff`, a CSP, o nome gerado, o `ETag` e o
       `304`; a marca, a categoria e o terminal de outra loja da mesma empresa; outra empresa, o envio solto, o logotipo
       da loja, o produto excluído e os ids inválido e desconhecido 404; a variante ausente ou outra 400, sem token 401;
       o terminal em desativação 403; o limite 429 por terminal) e `esquema-pdv.spec.ts` (os campos calculados no fim,
       projetados e anuláveis). Imagens inventadas, geradas no teste.

193. **Atualização da tabela NCM (e do CEST) pela plataforma, sem uso fiscal** (Fase 2, F2-B46; ERP 18.13; SYNC 6.13;
     MD 1.4; decisões 41, 98 e 187; `src/plataforma/ncm-atualizacao.ts`, o comando `src/cli/ncm-atualizar.ts`
     (`pnpm --filter api db:ncm:atualizar`; na produção `implantar.sh tarefa ncm-atualizar`), `carregarNcms` e
     `NCMS_CSV_VIGENTE_EM` em `src/database/referencias/carregar.ts`, a guarda no `posMigracaoSemAdmin`
     (`provisionamento.ts`), `SISCOMEX_NCM_URL` na configuração; **sem migração de schema** e PDV sem mudança). A tabela
     é referência do cadastro: o que muda é o que o cadastro, o filtro "Situação de cadastro", o relatório NCMs
     inválidos e o PDV leem de `ncms`; nada de emissão.
     - **Como é disparada: comando de operação**, como as outras tarefas da plataforma que escrevem nos bancos de todas
       as empresas (`migrar-empresas`, `referencias`, `particoes`): roda no container de tarefa com a imagem da versão
       atual, com a role dona de cada banco (a das migrações e da carga das referências, MD 1.4), e não ganha rota nem
       botão (a API no ar não precisa de acesso de escrita com essa role, e a tarefa é rara). Opções: `--simular` (o
       mesmo relatório, tudo desfeito no fim), `--empresas 1,2`, `--arquivo <caminho>` ou `--arquivo -` (a entrada
       padrão: o JSON baixado no navegador, quando o servidor não alcança o portal), `--url` e
       `--permitir-encerramento-em-massa`. Um item do `--empresas` que não é inteiro positivo (`emp100001`, `1O`, a
       vírgula sobrando) recusa o comando antes do download, com saída 1: o filtro inválido nunca vira "todas as
       empresas" (`codigosEmpresas`, `src/cli/comum.ts`; no serviço, `codigos: []` também é nenhuma empresa). Saída 1 se
       alguma empresa falhou, o arquivo ou o `--empresas` foi recusado; a empresa `ignorada` (em migração naquele
       momento, ou com tabela mais nova) não muda a saída: a linha dela diz o motivo e, na migração, roda-se de novo.
     - **Entrada externa, conferida inteira antes de qualquer empresa**: o endereço oficial fica em `SISCOMEX_NCM_URL`
       (padrão `https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO`; sem o
       `perfil` o portal responde 307), só `http(s)`, **sem seguir redirecionamento** (o endereço mudou → trocar a
       variável), 2 min de tempo limite, status 200, `Content-Type` JSON e no máximo `LIMITE_BYTES_TABELA_NCM` = 32 MB
       (o cabeçalho e a leitura em partes; o arquivo de 12/11/2026 tem 3,1 MB). Depois: UTF-8 estrito (byte inválido
       recusa, o BOM é descartado), JSON com `Data_Ultima_Atualizacao_NCM` ("Vigente em DD/MM/AAAA", a data da tabela),
       `Ato` opcional e `Nomenclaturas`, cada item com `Codigo` num dos níveis da Nomenclatura (`01`, `01.01`,
       `0101.2`, `0101.21`, `0102.29.1`, `0101.21.00`), `Descricao` texto (até 4.000 caracteres, não vazia sem o HTML e
       os travessões), `Data_Inicio`/`Data_Fim` em DD/MM/AAAA válidas e em ordem (`31/12/9999` = sem fim), sem código
       repetido, e pelo menos `MINIMO_NCMS_TABELA` = 5.000 NCMs de 8 dígitos. Campo a mais é ignorado; campo a menos,
       renomeado ou com tipo trocado **recusa o arquivo e nada é aplicado** ("o formato mudou"). Também é recusado o
       arquivo que encerraria mais de `LIMITE_ENCERRADOS_FRACAO` = 20% dos NCMs do `ncms.csv` versionado (download pela
       metade), salvo `--permitir-encerramento-em-massa` (a revisão da Nomenclatura do SH). O `cests.csv` versionado é
       lido na mesma etapa.
     - **A descrição como no `ncms.csv`** (decisão 41, que não guardou o script da conversão): a do item de 8 dígitos
       precedida das subposições e itens acima dele (5 a 7 dígitos), sem o HTML (`<i>`, `<sub>`), os travessões da
       frente, os dois pontos do fim e com o `;` trocado por vírgula; o nível que só repete o de cima ("-- Outros" /
       "Outros") entra uma vez; e a posição (4 dígitos) vai na frente quando o primeiro nível é genérico ("Outros",
       "Outras", "Com …", "Sem …", "Em …", "De peso …", "De capacidade …"). Conferido com o download real de
       12/11/2026 (fora do repositório): os **10.516 NCMs saem iguais** ao `ncms.csv` (descrição e vigência), então a
       primeira execução não muda nada. A tabela real nunca é versionada; os testes usam arquivos inventados.
     - **Uma transação por empresa**, uma empresa de cada vez, com a trava 7300001 (`fn_trava_versao`) e a **mesma
       trava consultiva das migrações** (`genesis:migracao_empresa`; a empresa em migração fica `ignorada`): a
       diferença com o que a empresa tem (**incluídos**: novos, excluídos ou encerrados antes que voltam; **alterados**:
       descrição ou vigência; **encerrados**: os que saíram do arquivo), o upsert (`carregarNcms`, o mesmo do
       `carregarReferencias`: só as linhas novas ou diferentes ganham versão), a carga do `cests.csv` versionado
       (F2-B41: sem lista, a tabela fica como está) e o **`ressincronizar_fluxo {fluxo: "referencia"}`** para os
       terminais `ativo`/`desativando` da empresa quando `ncms` mudou (SYNC 6.13; o CEST não desce, decisão 187). É o
       comando que os PDVs 0.11.0 e 0.12.0 já executam (o cursor do fluxo volta a 0 e o pull baixa de novo; sem mudança
       de protocolo nem do `Esquema.g.cs`); as linhas novas também descem pelo pull normal, pela versão. Falha numa
       empresa desfaz só ela, inteira; as outras seguem.
     - **O NCM que sumiu do arquivo não é excluído**: ganha `vigencia_fim` na **véspera da data da tabela** (o Siscomex
       não publica a data do encerramento na tabela vigente; o que já terminava antes fica como está). O produto que o
       usa passa a "fora de vigência — Vigência até DD/MM/AAAA" no relatório NCMs inválidos (o `ncmVigente` da decisão
       98: em todos os lugares juntos). A carga do `ncms.csv` continua excluindo logicamente (decisão 41).
     - **Relatório e registro** (`auditoria_plataforma`): `ncm_atualizada` por empresa (a data, o ato, o sha256 do
       arquivo, as contagens, até 200 códigos de cada lista, os terminais avisados e **os produtos que ficam com NCM
       inválido**: código, nome e NCM, até 200, sem kit e serviço, como o relatório) e `ncm_atualizacao_executada` com
       o resumo de todas. O `ncm_atualizada` é gravado **antes** do commit da empresa: falhou, nada fica; o commit que
       falha depois deixa um registro sem a mudança, o que só faz a guarda abaixo manter a tabela como estava. A
       saída do comando mostra o mesmo relatório. A simulação não registra.
     - **A migração não desfaz a tabela da plataforma**: a carga das referências (`posMigracaoSemAdmin`, de toda
       migração e do `referencias`) compara a última `ncm_atualizada` da empresa com `NCMS_CSV_VIGENTE_EM` (a data do
       `ncms.csv`, "2026-10-30"; **atualize junto com o arquivo**) e, com a da plataforma mais nova, não mexe em `ncms`
       (as outras referências seguem). A empresa nova recebe o `ncms.csv` no provisionamento e a tabela da plataforma na
       próxima execução. A tabela **mais antiga** que a da empresa (a aplicada antes ou a do arquivo) é `ignorada`.
     - Testes: `ncm-atualizacao.spec.ts` (a descrição montada com HTML, entidade, `;`, NBSP, o nível repetido e a
       posição na frente; o BOM e os campos a mais; 16 formatos alterados recusados; o mínimo e o limite de tamanho; a
       diferença com os incluídos que voltam, os alterados, os encerrados e os que já tinham terminado; o download pelo
       servidor HTTP falso com o 500, o HTML, o tamanho declarado e o lido acima do limite, o redirecionamento, o tempo
       limite e o endereço que não é http(s)), `cli/comum.spec.ts` (o `--empresas` inválido recusado) e
       `ncm-atualizacao.test.ts` (duas empresas e uma terceira criada depois, que a lista vazia não alcança:
       a tabela igual à versionada não muda nada; simular sem gravar; o formato quebrado e o encerramento em massa sem
       aplicar nada; o critério de pronto — o NCM encerrado no relatório NCMs inválidos da empresa que o usa, a outra
       sem produto afetado —, o comando ao terminal, os registros; rodar de novo sem mudança nem comando; a migração
       sem desfazer; a tabela mais antiga e a empresa em migração ignoradas; a falha numa empresa desfeita inteira).
       Arquivos inventados (capítulo 77, que a Nomenclatura não usa) e a tabela de integração montada do `ncms.csv`.
     - **Fora**: a atualização automática (agendada) e o botão no painel da plataforma (o dono roda o comando quando
       quiser, ver `infra/producao/README.md` › Tabela NCM); a lista oficial do CEST (pendência da decisão 187: sem
       fonte oficial em formato de dados, segue o arquivo versionado); IBPT e qualquer uso fiscal.

194. **Complementos no cadastro do produto e a liberação do tipo "Com complementos"** (Fase 2, F2-B51; F2-Q1 = roadmap
     D43, decidida pelo dono: complementos sim; ERP 8.2.16; MD 3.6.8; decisões 145 e 191; `@genesis/shared` `produtos.ts`
     (`grupoComplementosSchema`, `complementoSchema`, `TIPOS_COMPLEMENTO_VINCULADO`, `rotuloGrupoComplementos`, os
     tetos `MAXIMO_GRUPOS_COMPLEMENTOS` = 20, `MAXIMO_COMPLEMENTOS_GRUPO` = 50 ativos e
     `MAXIMO_LINHAS_COMPLEMENTOS_GRUPO` = 300 linhas), `configuracoes.ts`;
     `src/produtos/gravacao.ts` (`gravarComplementos`, as regras de tipo em `validarNoBanco`), `consultas.ts`
     (`complementosDoProduto`, `complementoDe`, `sqlVersaoAgregada`), `produtos.controller.ts` (gravação, exclusão,
     `entradaDoDetalhe`) e `src/auditoria/diferenca-produto.ts`; **sem migração** (as tabelas são da 0028), protocolo,
     `Esquema.g.cs` e PDV sem mudança).
     - **A liberação**: `produtos.complementos_habilitados` passa a nascer **ligada** (padrão `true` no catálogo). Como
       o catálogo só grava o que difere do padrão (decisão 145), toda empresa que nunca mexeu na chave passa a poder
       criar (e trocar para) "Com complementos" no formulário, na importação e no cadastro em massa; quem gravar "Não"
       em Configurações › Geral › Produtos volta à trava do F2-B1 (o legado continua editável). O que a chave libera é
       só **escolher o tipo**: o modal vale para qualquer produto do tipo, inclusive o legado do Nuvem3. Nada desce ao
       PDV: o caixa continua vendendo o produto sem complementos (PDV 10.2) até a Fase 3, mas já recebe os grupos e as
       opções no `catalogo` (PDV 0.12.0, decisão 85 do README do PDV; o 0.11.0 os descarta sem travar o cursor).
     - **Gravação junto do produto** (`gruposComplementos` no `POST`/`PUT /produtos`, as permissões do formulário:
       `produtos.criar`/`produtos.editar`). **Ausente = mantém os gravados** (a planilha, o cadastro em massa e o ERP
       antigo não conhecem a lista; `entradaDoDetalhe` a tira); presente = a lista inteira. O grupo casa pelo `id` entre
       os do próprio produto e o complemento pelo `id` dentro do mesmo grupo (o id de outro produto ou de outro grupo
       vale como linha nova). **Nada se apaga** (a 0028 recusa o DELETE): o grupo que não veio é **excluído
       logicamente** com os complementos (`excluido_em` e `ativo = false`, tombstone ao caixa), e o complemento que não
       veio no grupo que ficou é só **inativado** (`ativo = false`; continua no detalhe e pode ser reativado). A linha
       igual à gravada não é regravada (a versão não sobe nem desce de novo ao caixa). A ordem é a posição na lista.
     - **Regras** (422 por campo). No zod, as dos CHECKs (`minimo ≥ 0`, `maximo ≥ minimo`, obrigatório ⇒ mínimo ≥ 1,
       vinculado ou livre, baixa só no vinculado, preço adicional ≥ 0 e quantidade da baixa > 0) e as da tela: máximo
       ≥ 1 e ≤ 99, nome do grupo único no produto, um complemento por produto vinculado (e por descrição livre) no
       grupo, o grupo obrigatório com ao menos um complemento ativo, até 20 grupos e até 50 complementos **ativos**
       por grupo (o inativo não conta, porque o gravado nunca sai: o grupo "Sabores" que troca as frutas da estação
       acumula inativos e continua aceitando a fruta nova; a lista inteira, com os inativos, tem só o limite técnico
       de 300 linhas) e **grupos só no tipo "Com complementos"**. O preço
       adicional tem 4 casas e a quantidade da baixa 3, como o resto do catálogo (`precoCampo`, `quantidadePositiva`).
       Na API, o produto vinculado: existe e não está excluído, não é o próprio produto, é Simples, Matéria-prima ou
       Produzido (`TIPOS_COMPLEMENTO_VINCULADO`: os que têm o que baixar; o Produzido baixa os insumos da ficha, decisão
       91; fora o combo, o "Com variações" — a opção não tem a variação —, o "Com complementos", o serviço e o casco),
       está ativo no complemento ativo, e a baixa é inteira quando ele não permite fração. O complemento gravado que
       não muda o vínculo nem a baixa não é conferido de novo (o produto que ficou inativo depois não trava o resto;
       reativar o complemento dele, sim). A gravação do complemento ao mesmo tempo que a exclusão ou a troca de tipo do
       vinculado não passa junto com ela: as duas começam pela trava de ordenação (`travaVersao`, MD 1.5), e o
       vinculado conferido ainda é lido com `for share` (espera o `for update` da exclusão e relê a linha: "Produto
       inexistente" ou o tipo recusado), para a regra não depender só da trava de ordenação.
     - **Preço adicional e a trava de preço**: com Configurações › Geral › "Altera Preço do Produto no ERP" = Não
       (`geral.altera_preco_produto_erp`), mudar o preço adicional de um complemento gravado, ou criar um complemento
       com preço, exige `produtos.alterar_preco` (403, como os preços do produto, da loja e das faixas, decisão 68;
       `garantirAlterarPreco` casa o complemento como `gravarComplementos`). Repetir o preço de agora, inativar e o
       complemento novo sem preço não contam; a lista ausente mantém os gravados.
     - **Tipo e exclusão**: sair de "Com complementos" com grupos vivos exige mandar a lista (vazia exclui os grupos;
       sem ela, 422 em `tipo`); o produto que é complemento **ativo** de outro (`complementoDe`) não troca para um tipo
       fora de `TIPOS_COMPLEMENTO_VINCULADO` nem se exclui (422, "O produto é complemento de …": a venda da Fase 3
       baixaria o estoque dele); o complemento inativo não conta. Excluir o produto exclui logicamente os grupos e os
       complementos dele (pelo grupo: `produtos_complementos.produto_id` é o vinculado, não o dono).
     - **Versão e auditoria**: as duas tabelas entram na versão agregada do cadastro (`sqlVersaoAgregada`, decisão 47:
       quem abriu antes da mudança dos complementos recebe o 409). O detalhe traz `gruposComplementos` (os grupos vivos
       com os complementos não excluídos, os inativos inclusive, e o produto vinculado como `ProdutoOpcao`), e a
       auditoria do produto leva a lista relida do banco no `depois`; o texto legível (decisão 188) ganha duas filhas:
       "Grupo de complementos adicionado Molhos (Máximo 2)", "Complemento Molhos: Barbecue: Preço adicional 2,00 →
       2,50", "Complemento Molhos: Barbecue: Ativo Sim → Não" (a filha dos complementos sai de dentro dos grupos pelo
       novo `Filha.de`). O preço adicional não entra no histórico de preços (MD 3.6.10 não tem o tipo; a auditoria o
       registra).
     - Testes: `produtos.spec.ts` do shared (o zod e a chave ligada), `diferenca-produto.spec.ts` (o texto),
       `produto-complementos.test.ts` (o critério de pronto pelo pull HTTP do `catalogo` com todas as colunas; a
       inativação, o tombstone, as linhas que continuam na nuvem, a linha igual sem versão nova, o 409, a lista
       ausente mantendo, o 403 sem `produtos.editar`, as regras do vinculado, o vinculado ativo que não se exclui nem
       troca de tipo, o vinculado inativado depois que não trava o resto e o complemento dele que não se reativa, o
       403 do preço adicional sem `produtos.alterar_preco`, a corrida com a exclusão do vinculado em outra transação,
       o complemento inativo num grupo vivo que libera a exclusão, a troca de tipo que exige a lista, a exclusão do
       produto) e, no PDV, o `AplicadorPullTests` com as mesmas páginas aplicadas no SQLite (a inativação e a exclusão
       do grupo, com o tombstone em todas as opções, como a API grava). Os testes da trava do F2-B1 (`produtos.test.ts`, `importacao-nuvem3.test.ts`)
       desligam a chave antes.
     - **Fora** (Fase 3): a escolha dos complementos na venda do PDV (o diálogo, o preço somado, a baixa do vinculado e
       o `itens_venda_complementos` preenchido), o cardápio e o e-commerce.

### Operação – tarefas em segundo plano (API)

150. **Tarefa interrompida: "último sinal", retentativa e varredura** (incidente de 04/11/2026; ERP 3.6; MD 3.1.8;
     `src/tarefas/tarefas.ts`, `src/tarefas/interrompidas.ts`, `src/infra/fila.ts`). **Problema**: a importação de 1.590
     produtos parou na linha 903 quando o processo da API reiniciou (18:05:42Z, sem implantação), e o ERP mostrou
     "executando" para sempre: `executar` só começava a tarefa `na_fila`, então a retentativa do job (expirado em 15
     min) saía sem fazer nada e a linha ficava `executando` no banco da empresa. **Último sinal**: enquanto o executor
     roda, o processo renova `tarefas.atualizado_em` (coluna que já existia e que nenhum gatilho mexe; sem migração) com
     o relógio do banco a cada 30 s (`SINAL_TAREFA_MS`; `sinalMs` no construtor, para o teste), além de no início, no
     progresso e no fim. **Critério de órfã**: `executando` **e** sem sinal há mais de 3 min (`LIMITE_SINAL_TAREFA_MS`,
     6 sinais perdidos) **e** fora das que este processo executa (`emExecucaoLocal`); a condição vai no próprio `update`
     (`now()` do banco), então um sinal que chega no meio vence. A tarefa `na_fila` nunca entra (ela não começou).
     **Onde roda**: (1) **retentativa** — o job chega e a tarefa já está `executando`: órfã → `falhou`; sinal recente →
     não mexe (é de outra instância viva; o log registra `job.retryCount`, que sozinho não distingue: a retentativa de
     uma instância viva e a de um processo morto têm o mesmo número). O caso "handler ainda rodando no mesmo processo"
     não chega aqui: o pg-boss 12 falha o job expirado e aborta o `job.signal`, mas o worker não busca nada, nem a
     retentativa, até o handler voltar (`#awaitHandlerOverrun` no `manager.js`, evento `warning` `handler_overrun`),
     então quando ela roda a tarefa já concluiu ou falhou; ainda assim a lista local a protege. (2) **varredura**
     (`VarreduraTarefasInterrompidas`, fila `genesis-tarefas-interrompidas`): um job quando a instância com trabalhador
     inicia (`executarAoIniciar`) e a cada 2 min (`schedule` do pg-boss, um job por ocorrência mesmo com várias
     instâncias), em cada empresa ativa ou suspensa (em manutenção ou migrando fica para a próxima), por
     `trabalhoPorEmpresas` (uma empresa com erro vai para o log e não impede as outras). Só no início não bastaria: o
     reinício do incidente levou segundos, e no início o sinal ainda é recente; a recorrência a pega em até ~5 min, sem
     esperar a expiração do job. **Por que é seguro**: a viva renova o sinal 6 vezes dentro do limite, e a do próprio
     processo nunca é marcada, mesmo com o laço de eventos travado; produção roda uma instância com
     `FILA_TRABALHADOR=true`, e o `implantar.sh` não sobrepõe versões (`genesis-api` tem `container_name` fixo: o
     `compose up` para o container antigo antes de subir o novo; o `stop` gracioso do pg-boss, 5 s, falha o job ativo, e
     a retentativa que chega ao novo ainda com sinal recente não marca — a varredura marca depois do limite); com mais
     de uma instância o critério continua valendo, porque a outra viva também renova o sinal. Se a varredura erra (sinal
     atrasado mais de 3 min), o fim do executor grava o resultado real por cima (`concluida`, `erro` nulo). **Mensagem**
     (`erro`, que o ERP mostra em "A importação falhou"): a genérica "A tarefa foi interrompida (o servidor reiniciou
     durante a execução) e não terminou." (a expiração do job não leva a ela: só o processo parado, sem sinal) mais o
     complemento do tipo (`registrarTipo(tipo, executor, { seInterrompida })`); sem complemento, "Confira o que já foi
     feito antes de pedir de novo." — só o tipo sabe o que repetir faz. **Como o usuário recupera**: cada linha da
     importação é uma transação, então o que já entrou ficou, e o "Definir" de `estoque_atual` só roda no fim; o
     complemento manda importar a mesma planilha de novo **conferindo a prévia**, porque repetir só é seguro para a
     linha que a identificação reconhece. Produto: Id → código → código interno → EAN; o que já entrou volta "Sem
     alteração", ou "Atualizar" só no estoque quando "Atualizar estoque" está ligado (o saldo ainda não foi acertado); a
     linha sem nenhuma dessas chaves (granel, serviço; o modelo do ERP não traz a coluna `codigo`) volta "Criar" e seria
     duplicada. Cliente: Id → CPF/CNPJ → código, mas o código da planilha não é gravado no cliente novo, então o cliente
     sem CPF/CNPJ que já entrou volta "Criar" (duplicaria) e o código pode apontar outro cliente ("Atualizar" errado). A
     mensagem diz isso e pede para tirar essas linhas da planilha. **Log**: os eventos `error` (antes iam para um
     `aoErro` que ninguém passava) e `warning` do pg-boss vão para o `Logger` do Nest (`FilaTrabalhos`), só com a
     mensagem do pg-boss, o tipo, a fila e os ids dos jobs (o resto do `data` traz SQL e números internos); cada tarefa
     marcada sai em `TarefasSegundoPlano` com os ids e o tipo. **Expiração**: a fila `genesis-tarefa` passou a expirar
     em 1 h (`OPCOES_FILAS`; as outras seguem em 15 min). A importação grande passa dos 15 min, e o job expirado com o
     handler rodando só gerava o aviso e uma retentativa vazia; quem recupera a tarefa de um processo morto é o sinal,
     não a expiração. O `createQueue` não altera uma fila que já existe, então o `iniciar` aplica as mesmas opções com
     `updateQueue` (idempotente; as opções do código valem também nas filas criadas antes). Testes
     (`tarefas-interrompidas.test.ts`, com o pg-boss de verdade): a varredura do início (o job sem `singleton_key`; o do
     agendamento leva a chave da ocorrência) marca a órfã com a mensagem da importação e não toca na viva nem na
     `na_fila`; a de 4 min sem sinal é marcada e a de 2 min não; o job repetido de uma órfã a marca; a de sinal recente
     e a que roda no próprio processo (mesmo com o sinal forçado para trás) não; o tipo sem complemento recebe a
     genérica; com a fila expirando em 2 s e o executor levando 4 s, a retentativa só chega ao `executar` depois que o
     executor terminou (o `warning` `handler_overrun` chega) e não marca nada (uma execução, `concluida`); uma segunda
     instância de `TarefasSegundoPlano` (sinal a cada 200 ms), presa sem progresso com o sinal posto a meio segundo do
     limite, segue renovando e nem a varredura nem a retentativa da outra a marcam; a fila `genesis-tarefa` deixada
     com 15 min (como a de produção) passa a 1 h no `iniciar`; na tarefa normal o `progresso` renova o sinal.
     Unitários: a mensagem por tipo (`tarefas.spec.ts`) e o log dos eventos e as opções das filas (`fila.spec.ts`). A
     causa do reinício de 04/11 fica para a investigação na VPS (`infra/producao/README.md` › Operação).

### Operação – diagnóstico do processo da API

166. **A próxima queda deixa a causa no log, e o reinício fica visível** (correção de operação do reinício de
     04/11/2026, 18:05:42Z; `src/comum/processo.ts`, `src/main.ts`, `src/saude/saude-detalhada.ts`,
     `infra/producao/implantar.sh`; a numeração pula 163–165, já usadas no `funcionalidade/fase2-p5`, ainda fora da
     `main`). **O que se sabe do 04/11**: a VPS não reiniciou (ligada desde 23/10) e o `dmesg -T` não tem nenhum
     `Out of memory`/`Killed process`. É **indício, não confirmação**, de que não foi o OOM do cgroup (2 GiB): o
     buffer do `dmesg` é circular e pode ter perdido o começo em 13 dias no ar, e o `journalctl -k` foi rodado sem
     `UTC` (o `--since` é lido no fuso da VPS, que não foi conferido; fora de UTC, a janela 17:30–18:30 não cobre as
     18:05Z). Os 4,8 GiB `available` do `free -h` são de 05/11, depois da implantação que recriou o container, e não
     medem a memória da hora da queda (nem decidem o OOM do cgroup, que dispara no `mem_limit` do container). Pedido
     ao dono: `timedatectl`, o `journalctl -k` com `UTC` e o `dmesg -T | head -n 1` (`infra/producao/README.md` ›
     O 04/11/2026). Seguem abertas, então, o SIGKILL do OOM do cgroup (saída 137) e o próprio Node saindo —
     exceção não tratada, rejeição de promise não tratada (no Node 22 o padrão `--unhandled-rejections=throw`
     derruba o processo) ou o heap do V8 esgotado (`JavaScript heap out of memory`, saída 134, que o kernel não vê).
     O log do container antigo sumiu porque a implantação de 05/11 recriou o container: **a causa não foi
     determinada**. **(1) Ouvintes do processo**
     (`registrarDiagnosticoProcesso`, ligados no `main.ts` antes de criar a aplicação, para pegar também a falha na
     subida): `uncaughtException` e `unhandledRejection` vão para o log em `fatal` (nível 60) com a pilha (`err`, o
     serializador do pino; motivo que não é `Error` sai em `motivo`, pelo `util.inspect`), a origem, a memória do
     processo e o tempo no ar, e o processo **sai com código 1**, como sairia sem o ouvinte (o Docker sobe de novo;
     o erro nunca é engolido, e depois de uma exceção não tratada o estado do processo não é confiável para seguir).
     Uma segunda falha durante a saída não repete a linha. `SIGTERM`/`SIGINT` saem em `warn` com o sinal (o
     `docker stop` e o `compose up` da implantação mandam `SIGTERM`): o ouvinte é `once` e não troca o do Nest
     (`enableShutdownHooks`, que fecha a aplicação e repete o sinal para si; com um ouvinte nosso permanente, o sinal
     repetido seria engolido e o processo só morreria no `SIGKILL` dos 30 s do `stop_grace_period`); se não houver
     outro ouvinte (sinal antes de a aplicação subir), o nosso repete o sinal e o processo termina como terminaria
     sem ele (saída 143). O `exit` registra o código (`error` quando diferente de 0). Cada subida escreve "API no ar"
     com a versão, o pid, o Node e a memória: o reinício sem implantação aparece no log. **Logger síncrono**: estas
     linhas usam um logger próprio, `pino.destination({ sync: true })` no mesmo stdout (`context: "Processo"`), e não o
     da aplicação: o padrão do pino é o sonic-boom assíncrono (`sync: false`), e a escrita em andamento (no pool do
     libuv) se perde num `process.exit` imediato. Com o síncrono, a linha está no pipe do Docker antes do `exit`
     (teste lendo o arquivo logo depois de emitir; conferido também com um processo de verdade, com o stdout num
     pipe, nos três casos). Ligar o síncrono no logger da aplicação inteira bloquearia o laço de eventos a cada
     requisição; para as poucas linhas do processo, não pesa. **(2) Heap perto do teto** (`vigiarHeap`, a cada 30 s,
     timer `unref`): o estouro do heap não passa por nenhum ouvinte (o V8 aborta e só escreve no stderr, que o
     `docker logs` guarda); um `warn` ao passar de 85 % do `heap_size_limit` (uma vez por cruzamento; rearma abaixo de
     75 %) deixa no log, antes, o crescimento e a hora. Nada de `--heapsnapshot-near-heap-limit` nem
     `--report-on-fatalerror`: o snapshot tem o tamanho do heap (1,5 GB num sistema de arquivos só leitura) e o
     relatório sai em milhares de linhas que empurrariam o resto para fora das 5.000 guardadas. **(3) Importação de
     planilha**: conferido que nada cresce por linha. A planilha é lida inteira (`lerPlanilha`, com os limites
     contra planilha-bomba) e analisada (`analisarProdutos`, as referências carregadas uma vez) **antes** da primeira
     gravação; o pico de memória é aí, não na linha 903. No laço de gravação, cada linha é uma transação curta (o
     cliente volta ao pool e o `drizzle(cliente)` é descartado), a auditoria vai para o banco na mesma transação (o
     `AuditoriaService` não guarda nada), o progresso é um `update` a cada 25 linhas, e o que fica em memória é só
     `gravadas` (uma referência à linha já analisada e o id, por linha gravada: dezenas de KB em 1.590 linhas) e a
     mensagem de erro da linha que falha. Não há cache de módulo que cresça com a importação (os `Map` de módulo são
     constantes, o limite por minuto e o cache de CEP). Sem crescimento real, nada foi mudado na importação. **(4)
     Saúde detalhada**: `processo` com `no_ar_segundos` (`process.uptime()`), `heap_usado_mb`, `heap_total_mb`,
     `heap_limite_mb` (`v8.getHeapStatistics().heap_size_limit`: o `--max-old-space-size=1536` mais o espaço novo) e
     `rss_mb`, em MiB com uma casa; o `memoria` do container continua (decisão 201). **(5) Logs guardados na VPS**:
     antes de recriar o `genesis-api` (`implantar`, `voltar`, a volta automática da implantação que falhou e o
     `token-monitor`), o `implantar.sh` guarda o `docker logs --timestamps` (stdout e stderr) em
     `/opt/genesis/logs/api-<AAAAMMDDTHHMMSSZ>-<versão do container>.log` (pasta 700, arquivos 600: os logs têm ids
     e IPs), com o início, os reinícios do container e o motivo na primeira linha; uma falha só avisa e não impede a
     troca. As últimas 5.000 linhas são só as horas antes da **troca** (o pino-http escreve uma linha por requisição;
     o healthcheck sozinho dá ~5.760 por dia, e com o sync e o ERP elas cobrem de 3 a 20 horas), e a troca pode vir
     dias depois da queda. Por isso, quando o Docker já reiniciou o container (`RestartCount > 0`), vai antes delas o
     trecho de 30 min antes a 2 min depois do `State.StartedAt` (a subida do processo novo, logo depois da queda; até
     5.000 linhas): o aviso do heap, a linha fatal e o `API no ar` da volta ficam no arquivo enquanto o `json-file`
     (10 MB × 5) ainda os tiver. Só o último reinício (o Docker não guarda o `StartedAt` dos anteriores).
     Retenção: nada com mais de 30 dias e no máximo os 20 mais recentes (alguns MB cada). `implantar.sh logs` mostra o
     container (desde quando está no ar, reinícios) e os arquivos, sem a trava das implantações; `logs guardar`
     guarda na hora (antes de um `docker compose up -d` à mão). Testes: `processo.spec.ts` (os três ouvintes num
     emissor falso, sem matar o processo de teste; o logger síncrono num arquivo; o `once` com e sem o ouvinte do
     Nest; o nível `silent`; o aviso do heap com relógio falso), a integração da saúde detalhada (o formato e a lista
     de chaves permitidas) e `infra/producao/teste/testar-implantar-logs.sh` (sem Docker, no CI, com um `docker`
     dublê: a queda seguida de 6.000 linhas de healthcheck, com a linha fatal no arquivo pelo trecho do reinício; o
     `implantar`, o `voltar`, a volta automática e o `token-monitor`, cada um com o motivo no cabeçalho; o
     `testar-local.sh` confere, pelo motivo do cabeçalho, os arquivos guardados no token-monitor e na troca de versão
     de verdade). O que olhar na próxima queda:
     `infra/producao/README.md` › A API reiniciou sozinha.

## O que ainda não foi feito (Fase 0)

Acesso como suporte; aba Acessos do usuário (sessões ativas, últimos logins); anexos de loja/marca/categoria (envio
de arquivos); atalhos por loja; rotina de backup que
preenche `backups_empresas` (o backup lógico diário da instância existe desde o I1b, `infra/producao/backup`); no sync, SSE, snapshot, recuperação, lacunas declaradas e a
entrega de segredos cifrados para o terminal (ver `src/sync/README.md`; o `GET /sync/recuperar` chegou no C17, decisão
142); role de runtime separada também no banco de
controle; homologação (o piloto vai direto para a VPS de produção, I1). A CI está em `.github/workflows/ci.yml`; a
implantação, em `.github/workflows/implantacao.yml` e `infra/producao/`.
