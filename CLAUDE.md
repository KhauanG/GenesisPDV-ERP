# GenesisPDV & ERP — guia para sessões do Claude Code

Sistema de frente de caixa (PDV) e ERP da **Ice Beer** (dono do produto: Khauan). Objetivo atual: **tudo funcional,
deixando a parte fiscal por último**. Este arquivo é lido automaticamente por qualquer sessão conectada ao repositório.
Leia também **`docs/andamento.md`** (o estado atual: o que está pronto, PRs e branches abertos, próximos passos).

## Como falar com o dono

- Sempre em **português do Brasil**, respostas detalhadas e com o passo a passo quando houver algo para ele fazer.
- O dono não é programador: explique o efeito na loja, não só o código. Termos técnicos com uma frase de explicação.
- Pergunta ao dono: liste as opções com a recomendada marcada, para ele responder "1A, 2B…". Registre a resposta em
  `docs/planos/decisoes-do-dono.md` e na tabela de decisões do `docs/roadmap.md` §16.
- Nunca peça para colar senha, token, chave ou dado de cartão no chat.

## Regras de trabalho (decisões do dono)

- **Ordem das fases:** 2 → 3 → 4 → 5 → 3F (NFC-e por último). **Nada fiscal** (emissão NFC-e/NF-e, SEFAZ, DF-e,
  certificado) até a fase fiscal. A NF-e de **fornecedor** por XML (entrada de mercadoria, sem SEFAZ) faz parte da Fase 2.
- **Cada bloco do plano:** implementar → revisar (3 lentes) → verificar os achados (tentar refutar) → corrigir → verificação
  final com todos os checks. Use o workflow `.claude/workflows/genesis-bloco.js` (ver abaixo).
- **Um commit por bloco verificado.** Não commite trabalho pela metade (o hook de parada vai pedir; recuse enquanto o bloco
  não passou na verificação final).
- **Antes de abrir cada PR** (D63, desde o PR-9): revisão de segurança do PR inteiro (skill `security-review`), com os
  achados confirmados corrigidos no próprio PR.
- **PR por fatia do plano** (ex.: PR-5 = F2-B18..B21). **Merge só com a liberação explícita do dono**, e nunca push direto
  na `main`.
- **Deploy em produção é do dono** (workflow Implantação). Não dispare workflows do GitHub sem necessidade (a fila e
  o log público pesam, mesmo sem cobrar minutos): nada de `workflow_dispatch` ou re-run "para ver".
- Nunca commitar: `.env`, `.db`, `bin/`, `obj/`, `dist/`, `publish/`, instaladores, `.pfx`, planilhas/dados reais, testes
  temporários. Sem identificador de modelo em commits, PRs ou código.
- O repositório é **público** (D60, 06/11/2026): tudo que entra fica visível para qualquer pessoa, inclusive o
  histórico e os logs do Actions. Nunca versionar dado real de cliente, funcionário, fornecedor, catálogo, planilha,
  XML de nota real, log de produção, IP ou credencial; fixtures e exemplos sempre inventados (CNPJ/CPF de teste,
  `<IP_DA_VPS>`, `<terminal_id>.<segredo>`). Os XMLs reais de fornecedores que o dono mandar **não** entram: ficam
  em `apps/api/test/fixtures/nfe/reais/` só na máquina de quem testa (está no `.gitignore`) e o teste com eles roda só
  localmente. Workflow não imprime saída da VPS (estado, logs, versões): isso se vê na própria VPS.
- O sistema "Hermes" é somente leitura.

## Mapa do repositório

- `apps/api` — API NestJS + Drizzle (Postgres; um banco por empresa `genesis_emp_<codigo>` e o `genesis_control`).
  Migrações em `apps/api/drizzle/empresa` e `drizzle/controle` (geradas com drizzle-kit: snapshot + journal; confira a
  numeração real). **Decisões técnicas numeradas** em `apps/api/README.md` (continue a numeração).
- `apps/erp-web` — ERP React + Mantine (vitest; Playwright em `e2e/`, fora do CI). Decisões em `apps/erp-web/README.md`.
- `packages/shared` — contratos zod e regras puras compartilhadas (API e ERP).
- `apps/pdv` — PDV C#/.NET 10 + Avalonia + EF Core SQLite, offline-first (outbox/sync). Decisões em `apps/pdv/README.md`.
  O PDV instalado nas lojas precisa continuar funcionando com a API nova (compatibilidade retroativa, `versoes_schema`).
- `infra/producao` — VPS Hostinger (docker compose + Traefik), Cloud SQL (PG 18), backup. Ver o README da pasta.
- `docs/` — `roadmap.md` (fases e decisões §16), especificações: `arquitetura/modelo-de-dados.md` (MD),
  `arquitetura/sincronizacao.md` (SYNC), `erp/especificacao-erp.md` (ERP), `pdv/especificacao-pdv.md` (PDV);
  `planos/` (planos detalhados por bloco e as decisões do dono); `implantacao/` (roteiros do piloto e do inventário).

## Checks (rodar antes de qualquer commit)

```bash
pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck
pnpm test                                   # shared, API (unitários + integração com Postgres local) e ERP
pnpm --filter api verificar:esquema-pdv     # Esquema.g.cs do PDV × schema Drizzle
pnpm build
```

PDV (rode **de dentro de `apps/pdv`**, onde está o `global.json`; da raiz o `dotnet test` falha com "testhost.dll"):

```bash
cd apps/pdv && dotnet restore GenesisPDV.slnx --locked-mode && dotnet build GenesisPDV.slnx -c Release && dotnet test --solution GenesisPDV.slnx -c Release
dotnet format GenesisPDV.slnx --verify-no-changes --no-restore   # com o SDK do global.json (10.0.100), igual à CI
```

- Postgres local: `pg_ctlcluster 16 main start` se não estiver no ar. dotnet: `export PATH=$HOME/.dotnet:$PATH DOTNET_ROOT=$HOME/.dotnet`.
- Testes sensíveis a tempo (`carga-terminais` p95, `Terminais.test.tsx`, heap do `recalcular-saldos`) podem falhar sob
  carga paralela: rode o arquivo sozinho antes de concluir que é defeito.
- Rode os testes em primeiro plano e espere o resultado.

## GitHub nas sessões na nuvem

- A API GraphQL é bloqueada: use REST pelo `gh api`. Criar PR:
  `jq -n --rawfile b corpo.md '{title:"…",head:"<branch>",base:"main",body:$b}' | gh api repos/KhauanG/GenesisPDV-ERP/pulls --input -`
- Merge (só com a liberação do dono): `PUT repos/KhauanG/GenesisPDV-ERP/pulls/<n>/merge` com `merge_method: "merge"`
  (PRs empilhados: nunca squash).
- **Actions (decisões do dono, 05/11 e 06/11/2026):** com o repositório público (D60), os runners padrão do GitHub
  não cobram minutos. Continua valendo, porque é bom de qualquer jeito: a CI roda **só no push da `main`** (e à mão),
  não em PR — os checks do PR rodam localmente antes de abri-lo — e só os jobs do que mudou
  (`.github/scripts/mudancas.sh`). Junte merges e cancele a execução intermediária que sobrar rodando. As Actions de
  terceiros ficam **fixadas pelo SHA** com a versão em comentário (`uses: actions/checkout@<sha> # v7`); o Dependabot
  (`.github/dependabot.yml`) abre o PR mensal que as atualiza. `.github/CODEOWNERS` pede a revisão do dono em tudo.
- **PDV na CI só no Windows (decisão do dono, 05/11/2026):** as lojas usam só Windows. O job do PDV roda só no
  `windows-latest` (build, testes, impressora de teste, instalador e o teste dele); o `dotnet format` fica num job leve
  no Linux. Não há `.deb` nem CI Linux do PDV (os scripts de `apps/pdv/instalador/linux` ficam sem uso); no Linux da
  sessão o PDV continua compilando e os testes rodam normalmente (checks acima). README do PDV › decisão 80;
  CONTRIBUTING.md › CI.
- **Integração da API na CI só no PostgreSQL 18 (decidida pelo dono em 05/11/2026, seguindo a recomendação; roadmap
  §16, D59).** O job TypeScript roda os unitários, e a integração roda só no
  job do PostgreSQL 18; o 16 (o do `infra/docker-compose.yml`) fica no `pnpm test` local e no e2e. CONTRIBUTING.md › CI.

## Workflow de bloco

`.claude/workflows/genesis-bloco.js` implementa um bloco de um plano de `docs/planos/` com o processo completo. Exemplo:
`Workflow({name: "genesis-bloco", args: {plano: "docs/planos/fase2-plano.md", bloco: "F2-B20", branch: "funcionalidade/fase2-p5"}})`.
Com `enxuto: true` usa 1 lente de revisão (mais barato, menos rigoroso).

**Qual rigor usar (recomendação; vale até o dono decidir outra coisa):**
- **Completo (3 lentes, o padrão)** nos blocos de risco: motor de estoque e custo, dinheiro e arredondamento, sincronização
  e protocolo com o PDV, migrações de banco, permissões e segurança, importação de arquivos (XML, ZIP, planilha) e tudo
  que grava ou estorna documento.
- **Enxuto (`enxuto: true`)** nos blocos de tela simples, relatórios só de leitura, ajustes pequenos e documentação.
- Na dúvida, completo. Conversas e perguntas do dono se respondem direto, sem workflow.

## Ambiente das sessões na nuvem

O hook `.claude/hooks/session-start.sh` roda ao abrir a sessão: `pnpm install` (só quando o lock muda), o .NET SDK do
`apps/pdv/global.json` em `~/.dotnet`, o `dotnet restore` do PDV e o PostgreSQL local dos testes (papel `genesis`).
As permissões dos comandos de rotina estão em `.claude/settings.json`; merge, push na `main` e disparo de workflow
continuam pedindo confirmação.
