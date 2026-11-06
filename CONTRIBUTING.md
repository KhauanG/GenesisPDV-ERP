# Como contribuir

Regras do repositório (ADR-01, ADR-12 e roadmap › Fase 0). Documentação, mensagens de commit, nomes de domínio e
textos de interface em **português do Brasil**; termos técnicos podem ficar em inglês (ADR-06).

## Branches

- `main` só recebe merge de pull request com os checks locais verdes e a liberação explícita do dono. É regra do
  time, conferida por quem faz o merge. Com o repositório público (D60), o GitHub passa a oferecer proteção de branch
  e ruleset também no plano gratuito: o dono liga na `main` (Settings › Rules › Rulesets › New branch ruleset) só
  **"Require a pull request before merging" com 0 aprovações obrigatórias** (e bloquear o push direto e o force push).
  **Não** ligue "Require review from Code Owners" nem aprovações obrigatórias: todo PR é aberto pela conta do dono
  (as sessões usam o token dele) e o GitHub não deixa o autor aprovar o próprio PR, então nenhum merge passaria (o
  ruleset vem sem bypass). O `CODEOWNERS` fica só como pedido automático de revisão (e para os PRs do Dependabot, que
  o dono aprova). Como a CI roda só no push da `main`, não há check de PR para tornar obrigatório.
- Uma branch por assunto, a partir da `main`: `tipo/descricao-curta` — ex.: `funcionalidade/cadastro-produtos`,
  `correcao/refresh-concorrente`, `documentacao/sync-24`, `setup/arquitetura-inicial`.
- Mantenha a branch atualizada com `git rebase origin/main` (não com merge da `main` dentro dela).

## Commits

Formato (Conventional Commits, em pt-BR):

```
tipo(escopo): descrição no imperativo, minúscula, sem ponto final

Corpo opcional explicando o porquê (não o quê), quebrado em ~100 colunas.
Referências: ERP 4.1, MD 3.3.6, SYNC 8.4.
```

| Tipo | Quando |
|---|---|
| `feat` | funcionalidade nova |
| `fix` | correção de bug |
| `docs` | só documentação |
| `refactor` | mudança interna sem alterar comportamento |
| `test` | testes |
| `build` / `ci` | dependências, build, pipeline |
| `chore` | manutenção que não entra nas outras |

Escopos usuais: `api`, `erp-web`, `pdv`, `shared`, `sync`, `auth`, `banco`, `infra`, `docs`.
Exemplos: `feat(sync): adiciona POST /sync/push idempotente`, `fix(auth): bloqueia reuso do mesmo código TOTP`,
`docs(md): acrescenta backups_empresas`. Um commit = uma mudança coerente; migração e o código que a usa no mesmo
commit.

## Pull requests

- Título no mesmo formato do commit; descrição com o que muda, como testar e as seções dos documentos afetadas.
- **CI verde obrigatório** (`.github/workflows/ci.yml`): formatação, lint, tipos, testes unitários, a integração da API
  no PostgreSQL 18 (o do Cloud SQL de produção, job em paralelo; desde 05/11/2026 só nele, não mais também no 16, decidido
  pelo dono, roadmap D59), conferência schema Drizzle × migrações, build, o build das imagens Docker de
  produção (API, ERP e backup) com o `docker compose config` de `infra/producao` (e a soma dos limites de memória ≤ 2,5
  GB), o `shellcheck` dos scripts de `infra/producao` e os testes de unidade do script de backup
  (`infra/producao/backup/testar-genesis-backup.sh`) e dos logs guardados pelo `implantar.sh`
  (`infra/producao/teste/testar-implantar-logs.sh`),
  o PDV no Windows (build, testes, impressora de teste do spooler e o instalador instalado, aberto e desinstalado de
  verdade), a formatação do C# (`dotnet format`) num job leve no Linux e o e2e PDV ↔ API. Cada job só roda
  quando muda algo que ele confere ([CI: o que roda quando](#ci-o-que-roda-quando)).
- A implantação na VPS (`.github/workflows/implantacao.yml`) não roda em PR: só manual ou depois do CI verde na
  `main` (com a variável do repositório `IMPLANTACAO_AUTOMATICA=true`); só implanta commit da `main`; passo a passo
  em `infra/producao/README.md`.
- Migração aplicada **nunca** é editada (o hash é conferido): crie outra (`pnpm --filter api db:gerar:empresa`).
- Divergência entre documentos: siga a precedência ADR > MD > SYNC > ERP/PDV e registre a decisão no README do app
  ("Decisões de implementação").

## Antes de abrir o PR

Os checks locais continuam **obrigatórios antes de cada push**, mesmo com o CI filtrando por caminho: o CI é a
segunda conferência, não a primeira, e cada rodada dele ocupa a fila e deixa um log público.

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
cd apps/pdv && dotnet format GenesisPDV.slnx && dotnet test --solution GenesisPDV.slnx
```

## CI: o que roda quando

**Desde 05/11/2026 (decisão do dono): o CI roda no push da `main` e à mão, não em cada PR.** O PR e o merge rodavam
o mesmo CI duas vezes. Antes de abrir o PR, rode os checks localmente (seção "Antes de abrir o PR" e o `CLAUDE.md`);
quem quiser o CI do GitHub num branch dispara à mão (Actions › CI › Run workflow, no branch) com o escopo `mudancas`.
O CI da `main` continua obrigatório antes de qualquer implantação. Juntar vários merges seguidos gera uma rodada só
na `main` (a pendente substitui as outras) — cancele a intermediária que sobrar em andamento.

**Também desde 05/11/2026 (decisão do dono; então GitHub Pro, 3.000 minutos por mês, o Windows cobrando 2×; com o
repositório público, D60, os minutos deixaram de contar, e as duas regras abaixo continuam):**

- **PDV só no Windows.** As lojas usam só Windows (D21); o PDV no Linux era só de testes. O job do PDV deixou a
  matriz `ubuntu-latest`/`windows-latest` e roda só no `windows-latest`: build, testes, impressora de teste do
  spooler, o instalador e o teste dele (instala, abre até "Banco local pronto", reinstala e desinstala). Saíram o
  pacote `.deb` (gerar e testar), o artefato `GenesisPDV-deb` e a abertura com Xvfb no Linux; o workflow
  `pdv-release.yml` publica só o `.exe` e o `.exe.sha256`. A conferência de formatação (`dotnet format
  --verify-no-changes`), que rodava no PDV do Linux, ficou num job leve no `ubuntu-latest`, **PDV (.NET 10) –
  formatação** (só checkout, SDK do `global.json`, `restore --locked-mode` e o format; sem build nem teste), com a
  mesma condição de mudanças do PDV. O e2e PDV ↔ API continua no Linux (é o teste da sincronização com a API). O
  código do PDV continua compilando no Linux e os testes rodam no Linux do ambiente de desenvolvimento (CLAUDE.md ›
  Checks); README do PDV › decisão 80.
- **Integração da API só no PostgreSQL 18 (decidida pelo dono em 05/11/2026, seguindo a recomendação; roadmap §16,
  D59).** Entrou na mesma economia de minutos do D58 (que é só do PDV). O job TypeScript rodava
  o `pnpm test` da raiz, que na API é unitários **e** integração (no PostgreSQL 16), e o job "Integração da API
  (PostgreSQL 18)" repetia a mesma integração no 18, a versão da produção (Cloud SQL). Agora o TypeScript roda só os
  unitários (`pnpm --filter @genesis/shared test`, `pnpm --filter api test:unit`, `pnpm --filter erp-web test`), sem
  serviço de PostgreSQL, e a integração roda só no job do 18, com os tetos da trava do runner compartilhado
  (`TETO_TRAVA_VERSAO_MS=100`, `TETO_TRAVA_CARGA_MS=250`). Localmente o `pnpm test` continua rodando tudo (com o
  PostgreSQL 16 do ambiente). Na CI, uma regressão que só aparece no 16 fica sem cobertura (o e2e PDV ↔ API, no 16, não
  roda a suíte de integração); se o dono quiser o 16 de volta, o job TypeScript retoma o serviço `postgres:16` e o
  `pnpm test` da raiz.

Até 06/11/2026 o repositório era privado, com minutos de Actions contados (o runner Windows cobrava **2×**); desde a
D60 ele é público, e os runners padrão não cobram minutos. A economia abaixo continua, porque poupa fila e tempo de
espera. Em 04/11/2026 a cota acabou: desde 30/10, cada push em PR, cada merge na `main` e cada disparo manual rodava
tudo, mesmo quando só mudava TypeScript ou documentação (o job do PDV no Windows, sozinho, levou 882 dos minutos cobrados).
Desde então o primeiro job do CI, **Mudanças (o que roda)**, lista os arquivos alterados
(`.github/scripts/mudancas.sh`, só git e bash) e cada job pesado roda só se mudou algo que ele confere:

| Mudou | Roda |
|---|---|
| Só documentação: `*.md` (em qualquer pasta), `docs/**` | nada pesado (só o job de detecção) |
| `apps/api/**` | TypeScript, Integração PG 18, Imagens, E2E |
| `apps/erp-web/**` | TypeScript, Integração PG 18, Imagens |
| `apps/pdv/**` | PDV (Windows e formatação), E2E |
| `apps/pdv/src/GenesisPDV.Data/Esquema.g.cs` | PDV, E2E e TypeScript (o `verificar:esquema-pdv` compara com o schema) |
| `packages/shared/src/sync/**`, `packages/shared/testes/**` e os arquivos do shared que os csproj do PDV copiam (`enums.ts`, `configuracoes.ts`, `permissoes.ts`, `perfis-padrao.ts`, `validadores.casos.json`) | TypeScript, Integração PG 18, Imagens, **PDV**, E2E |
| resto de `packages/**` (ex.: `estoque.ts`, `produtos.ts`) | TypeScript, Integração PG 18, Imagens, E2E (o PDV não compila nem lê) |
| `apps/api/test/e2e-pdv/estado.exemplo.json` (o `EstadoE2ETests` do PDV lê) | tudo |
| `infra/producao/**`, `.dockerignore` | Imagens (Dockerfile do backup, shellcheck, testes do backup, compose) |
| `infra/docker-compose.yml` | nada pesado (só o ambiente local) |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig*.json` da raiz | TypeScript, Integração PG 18, Imagens, E2E |
| `eslint.config.*`, `.prettierrc*`, `.prettierignore` | TypeScript |
| outros workflows (`.github/**` fora do `ci.yml`) | TypeScript (o prettier confere o YAML) |
| `.github/workflows/ci.yml`, `.github/scripts/**` | tudo |
| qualquer outro arquivo (`.editorconfig`, `.gitattributes`, `.gitignore`, arquivo novo na raiz…) | tudo (na dúvida, roda) |

Um PR que mexe em várias áreas soma as linhas. "PDV" são os dois jobs do PDV, "PDV (.NET 10) – windows-latest" e
"PDV (.NET 10) – formatação". Os arquivos de fora de `apps/pdv` que o PDV lê saem dos próprios csproj (`<None Include="..\..\..\..\...">`):
um link novo passa a disparar o PDV sozinho.

- **Base da comparação.** PR: o merge de teste contra a base do PR (o que o PR muda, ainda que em vários commits).
  Push na `main`: o commit anterior (`github.event.before`); se o CI dele não ficou verde (falhou, ou foi cancelado
  pelo `concurrency` quando três pushes chegaram em seguida), o último commit da `main` com CI verde de **push**
  (o "Re-run" de um push conta; disparo manual não, porque pode ter rodado um job só). Assim nenhum
  commit chega à `main` sem CI verde de tudo o que ele mudou, e a implantação (que só aceita CI verde de push na
  `main`) continua protegida. `before` zerado ou ausente, base que não se resolve, erro do git ou da API: roda tudo.
- **Disparo manual** (Actions › CI › Run workflow): roda tudo por padrão. O campo `escopo` aceita `mudancas` (como
  num PR, contra o merge-base com a `main`; na própria `main` a diferença seria vazia, então roda tudo) ou um job só
  (`ts`, `pdv`, `imagens`, `e2e`), para repetir só o que falhou: um ajuste do instalador do Windows não precisa rodar
  o TypeScript de novo. Um disparo manual verde **não** vale como base do próximo push na `main`: para destravar um
  push que falhou na `main` (teste instável, por exemplo), use o "Re-run failed jobs" do próprio run do push. Prefira um PR (rascunho, se for
  o caso) a disparos manuais repetidos: 25 das 61 rodadas entre 30/10 e 04/11 foram manuais, todas completas.
- **Job pulado conta como sucesso.** O GitHub registra o job com `if` falso como *skipped*, que vale como verde: o
  CI termina com sucesso e o `workflow_run` da implantação segue. O job do Windows manteve o nome da antiga matriz,
  `PDV (.NET 10) – windows-latest`. Hoje não há check obrigatório; se um dia houver, exigir um job pulado pelo nome
  funciona (o *skipped* conta como verde), mas vale criar um job final que agregue os resultados e exigir só ele.
- **Falha da detecção nunca pula nada**: se o job de mudanças falhar, os jobs pesados rodam
  (`needs.mudancas.result != 'success'`); só o cancelamento (novo push no mesmo PR) os pula.
- O `concurrency` continua o mesmo: em PR, um push novo cancela a rodada anterior; na `main`, nada é cancelado em
  andamento.
- Para ver o que o CI rodaria no seu branch (o que está commitado): `.github/scripts/mudancas.sh` (contra o
  merge-base com a `origin/main`) ou `.github/scripts/mudancas.sh BASE [HEAD]`. O resumo de cada rodada (aba
  *Summary*) mostra o motivo, a tabela de jobs e os arquivos.
- Mudou um job do CI ou o que ele lê de fora da própria pasta? Atualize o mapa em `.github/scripts/mudancas.sh` e
  esta tabela juntos.
- Os outros workflows não disparam sozinhos em push nem em PR comum: `aceite-pdv.yml` só com a etiqueta `aceite-pdv`
  (outra etiqueta abre a rodada com os jobs pulados, sem minutos) ou à mão; `pdv-release.yml` só na tag `pdv-v*` ou
  à mão; `implantacao.yml` à mão ou, com `IMPLANTACAO_AUTOMATICA=true`, depois de CI verde de push na `main`.

Testes de integração interrompidos deixam bancos para trás: `pnpm --filter api test:limpar`.
