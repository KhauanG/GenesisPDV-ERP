# Decisões de Arquitetura (ADRs) – GenesisPDV & ERP

> Documento-âncora. Todos os outros documentos e todo o código devem seguir estas decisões.
> Mudou uma decisão? Atualize este arquivo primeiro, depois o resto.

## Visão do produto

O **GenesisPDV & ERP** é um sistema de gestão para varejo, multiempresa e multiloja, inspirado no Nuvem3
(referência: o levantamento funcional do Nuvem3, que fica com o dono, fora do repositório). Tem duas partes:

| Parte | O que é | Onde roda |
|---|---|---|
| **ERP** | Site web de retaguarda: cadastros, estoque, financeiro, vendas, relatórios, configurações | Navegador (nuvem) |
| **PDV** | Frente de caixa instalada nos computadores das lojas | Windows (principal) e Linux |

As duas partes se conectam pela **API na nuvem**. O PDV **funciona sem internet**: grava tudo num banco local e
sincroniza com a nuvem quando a conexão volta.

---

## ADR-01 – Monorepo

Um único repositório com esta estrutura:

```
genesispdv-erp/
├── apps/
│   ├── api/          # API na nuvem (Node.js + TypeScript + NestJS) — atende o ERP web e a sincronização dos PDVs
│   ├── erp-web/      # ERP web (React + Vite + TypeScript)
│   └── pdv/          # PDV desktop (C# .NET 10 + Avalonia UI) — solução GenesisPDV.slnx
├── packages/
│   └── shared/       # Tipos/contratos TypeScript compartilhados entre api e erp-web (DTOs, enums)
├── infra/            # docker-compose (PostgreSQL local para desenvolvimento), scripts
└── docs/             # Documentação (arquitetura, especificações do PDV e do ERP, referências)
```

- Gerenciador de pacotes do lado TypeScript: **pnpm** com workspaces (`pnpm-workspace.yaml` na raiz).
- O PDV (C#) fica dentro de `apps/pdv/` com a própria solução .NET; não participa do workspace pnpm.

## ADR-02 – Multiempresa: um banco de dados por empresa ("código da empresa")

Cada empresa cliente recebe um **código numérico** (ex.: `100001`) e um **banco PostgreSQL próprio e completo**
(`genesis_emp_100001`), com tudo dela: lojas, estoques (lojas e CDs), usuários, produtos, pessoas, vendas,
financeiro, configurações.

Além disso existe **um banco de controle** (`genesis_control`), que guarda só o que é da plataforma:

| Tabela (controle) | Para quê |
|---|---|
| `empresas` | código, razão social, CNPJ principal, nome do banco, status (ativa/suspensa/cancelada), plano, limites (lojas, terminais) |
| `terminais_pdv` | registro de cada PDV instalado: empresa, loja, número do caixa, hash do token, último contato, versão do app |
| `ativacoes_pdv` | códigos de ativação de uso único gerados no ERP para instalar um novo PDV |
| `admins_plataforma` | usuários da equipe Genesis (suporte), separados dos usuários das empresas |
| `migracoes_empresas` | controle de qual versão de schema cada banco de empresa já recebeu |

Regras:
- **ERP: código da empresa + login + senha** (igual ao Nuvem3).
- **PDV: o código da empresa só é informado na ativação do terminal** (junto com o código de ativação, ADR-08); a
  partir daí o terminal já está vinculado a empresa + loja + caixa, e o **operador entra com login ou código + senha
  ou senha numérica** do PDV (a senha numérica é validada localmente e funciona offline; a senha do ERP, quando
  permitida no caixa, só vale online — ADR-08).
- A API descobre o banco da empresa pelo código (no login) ou pelo token (nas demais chamadas) e usa um
  pool de conexões por empresa (cache com limite, fechando os inativos).
- Migrações de schema são aplicadas **em todos os bancos de empresa** por um comando (`pnpm --filter api db:migrate:empresas`).
- Criar uma empresa = registrar em `empresas` + `CREATE DATABASE` + aplicar migrações + dados iniciais (seed: plano de contas padrão,
  formas de pagamento padrão, usuário administrador, tipos de movimento de estoque, CFOPs).
- Motivos da escolha: isolamento total entre clientes (um bug de filtro nunca vaza dado de outra empresa), backup e
  restauração por empresa, possibilidade de mover uma empresa grande para outro servidor.

## ADR-03 – Lojas e estoques são entidades separadas

Igual ao Nuvem3: **Loja** (ponto de venda com CNPJ, fiscal, PDVs) e **Estoque/Local de estoque** (onde o saldo fica:
Loja 1, Loja 2, CD...). Cada loja aponta para um estoque vinculado; um CD é um estoque sem loja de venda.
Usuários têm **lojas permitidas**.

## ADR-04 – Identificadores

- Chave primária de **todas** as tabelas de negócio: **UUID v7** (ordenado por tempo). O PDV gera UUIDs offline sem
  risco de colisão, e a ordenação por tempo ajuda os índices.
- Códigos legíveis por humanos ficam em colunas separadas: `codigo` (produto, pessoa, usuário), número da venda
  (`numero` sequencial **por caixa**: loja + nº do caixa + sequencial), número da NFC-e (série/número por caixa).
- URLs do ERP usam o UUID (nunca ids sequenciais expostos — recomendação do levantamento do Nuvem3).

## ADR-05 – Dinheiro, quantidades e datas

- Dinheiro: PostgreSQL `numeric(15,2)` (preço unitário e custo: `numeric(15,4)`, para permitir 4 casas decimais como o
  Nuvem3 permite). C#: `decimal`. TypeScript: **nunca `number` para dinheiro em cálculo** — trafegar como string
  e calcular com biblioteca decimal (ex.: `decimal.js`), ou em centavos inteiros quando fizer sentido.
- Quantidades: `numeric(15,3)` (produtos pesados em kg na balança).
- Datas/horas: `timestamptz` em UTC no banco; exibição no fuso da loja (padrão `America/Sao_Paulo`). Cada loja tem fuso.

## ADR-06 – Convenções de nomes

- Domínio em **português**: tabelas e colunas em `snake_case` português (`produtos`, `vendas`, `itens_venda`,
  `formas_pagamento`, `preco_venda`), código TypeScript em `camelCase`/`PascalCase` português (`Produto`, `precoVenda`),
  C# em `PascalCase` português (`Produto.PrecoVenda`). Termos técnicos consagrados podem ficar em inglês
  (`token`, `hash`, `payload`, `controller`, `service`).
- Colunas padrão em toda tabela de negócio:
  - `id uuid primary key` (UUID v7)
  - `criado_em timestamptz not null default now()`
  - `atualizado_em timestamptz not null default now()`
  - `excluido_em timestamptz null` (**exclusão lógica**: nada que sincroniza é apagado fisicamente)
  - `versao bigint not null` (cursor de sincronização — ver ADR-08)
- Tabelas de documentos imutáveis (venda finalizada, movimento de estoque, movimento de caixa) não são editadas:
  correções geram novos registros (cancelamento, estorno, ajuste).

## ADR-07 – PDV: C# .NET 10 + Avalonia UI + SQLite local

**Por que C# e não Python** (resumo; detalhes em `docs/arquitetura/visao-geral.md`):
- Integrações de hardware e fiscal do Brasil têm suporte maduro em .NET: TEF (SiTef, PayGo, etc. via DLL), impressoras
  térmicas ESC/POS, gaveta, balança serial (Toledo/Filizola), SAT/MFE, NFC-e (ACBrLib, Unimake.DFe, DFe.NET/Zeus).
- Aplicativo compilado: abre rápido, gera instalador único, é mais difícil de copiar/alterar que um script Python.
- Tipagem forte e `decimal` nativo (dinheiro sem erro de arredondamento).
- Python exigiria empacotadores pesados (PyInstaller), e o PyQt tem licença GPL/comercial.

Stack do PDV:
- **.NET 10 (LTS)**, **Avalonia UI 12** (roda em Windows e Linux; testes de interface "headless"), padrão **MVVM**
  com `CommunityToolkit.Mvvm`.
- **Banco local: SQLite** (arquivo único, embutido no aplicativo, nada para instalar à parte, modo WAL) via
  **EF Core SQLite**. Cada caixa tem seu próprio banco local e sincroniza direto com a nuvem — não precisa de
  servidor na loja.
- Organização: `GenesisPDV.Core` (domínio e regras, sem UI), `GenesisPDV.Data` (EF Core/SQLite),
  `GenesisPDV.Sync` (cliente de sincronização), `GenesisPDV.Hardware` (impressora, gaveta, balança, TEF — por interfaces
  com implementações simuladas para desenvolvimento), `GenesisPDV.Fiscal` (NFC-e, futuramente), `GenesisPDV.App`
  (Avalonia), e projetos de teste `GenesisPDV.*.Tests` (xUnit).

## ADR-08 – Sincronização offline (local-first)

O PDV **sempre grava primeiro no banco local** e sincroniza em segundo plano. A venda nunca espera a internet.
O protocolo completo (contratos, códigos de erro, catálogo de eventos) está em `docs/arquitetura/sincronizacao.md`;
aqui ficam as decisões que o resto do sistema deve respeitar.

**Descida (nuvem → PDV)** – cadastros e configurações:
- Toda tabela sincronizável tem `versao bigint`, preenchida por uma **sequência única por banco de empresa**
  (`seq_versao`) via trigger em todo INSERT/UPDATE. Exclusões são lógicas (`excluido_em`), então também descem.
- As tabelas são agrupadas em **7 fluxos** (`configuracao`, `acesso`, `referencia`, `catalogo`, `estoque`, `pessoas`,
  `operacao` — modelo de dados 6.1), e o PDV guarda **um cursor por fluxo** (`estado_sincronizacao.cursor`). Isso
  permite que a carga inicial priorize o necessário para vender e que um fluxo seja ressincronizado sem baixar tudo.
- Contrato: `GET /sync/pull?fluxo=<fluxo>&desde=<cursor>&limite=N` →
  `{ fluxo, alteracoes: [{ tabela, versao, linha }], novo_cursor, tem_mais, cursor_teto, agora_servidor }`, com as
  mudanças de todas as tabelas do fluxo em ordem de `versao`, filtradas para a loja do terminal (ex.: preços da loja
  dele, usuários com permissão na loja). O PDV aplica a página numa transação e guarda o novo cursor do fluxo.
- `novo_cursor` = `versao` da última linha devolvida **só quando a página é cortada** (`tem_mais = true`); página não
  cortada → `novo_cursor = cursor_teto`, calculado no mesmo snapshot `repeatable read` da leitura como
  `greatest(max(versao) de cada tabela do fluxo, max(eventos_recebidos.versao_nuvem_fim))` (modelo de dados 6.1;
  `sincronizacao.md` 6.3–6.4). Assim o cursor avança até o teto mesmo quando as últimas versões são de outra loja.
- Carga inicial de um terminal novo: por fluxo, na ordem do modelo 6.1, com snapshot pré-gerado opcional
  (`GET /sync/snapshot?fluxo=`) seguido do pull a partir da versão do snapshot. As vendas só são liberadas depois de
  `configuracao`, `acesso`, `referencia`, `catalogo` e `estoque`.
- Cadastros são **mestres na nuvem**: o PDV não os altera (exceção: cadastro rápido de cliente no caixa, que sobe como
  evento e a nuvem incorpora).

**Avisos em tempo real (SSE)**:
- `GET /sync/eventos` (`text/event-stream`, mesmo token do terminal) é o canal de avisos da nuvem para o PDV:
  `alteracao {fluxo, versao, prioridade}` (dispara pull imediato daquele fluxo; `acesso` tem prioridade alta),
  `comando`, `evento_resolvido`, `pix` e `ping` a cada 25 s. Escolhido **SSE** em vez de WebSocket porque o canal só
  vai da nuvem para o PDV, passa por proxies/antivírus e reconecta sozinho com `Last-Event-ID`.
- O aviso é **só uma dica** e nunca traz dados de negócio: aviso perdido não causa erro, porque o polling continua.
  Sem SSE, o PDV faz pull de todos os fluxos a cada 30 s quando online; com SSE, a cada 5 min (segurança) mais o pull
  imediato a cada aviso.

**Subida (PDV → nuvem)** – movimentos do caixa:
- O PDV grava cada fato numa tabela local **outbox** (`eventos_saida`), na mesma transação do fato: abertura de caixa,
  venda finalizada (itens + pagamentos), venda cancelada, sangria, reforço, fechamento/troca de turno, NFC-e,
  cliente criado no caixa, etc.
- Envia em lotes por `POST /sync/push`. Cada evento vai num **envelope** com, entre outros: `evento_id` (UUID v7,
  chave de idempotência), `terminal_id`, `sequencia` (= `eventos_saida.sequencia_terminal`), `tipo`,
  `versao_schema`, `agregado_tipo`, `agregado_id`, **`dependencias`** (lista de `{agregado_tipo, agregado_id}` deste
  terminal que precisam estar aplicados antes), `ocorrido_em`, `contexto`, `payload` e `payload_sha256`.
- **`sequencia_terminal` é contínua por terminal** (começa em 1 na ativação, nunca é reaproveitada) e a nuvem aplica
  os eventos de um terminal **estritamente em ordem**: só aplica o de `sequencia = esperado`. Não há ordem entre
  terminais (o que é compartilhado é comutativo ou tem regra de corrida). Sequência já usada por outro `evento_id`
  indica banco local restaurado/clonado e leva à recuperação (`REGRESSAO_DETECTADA`).
- A nuvem é **idempotente**: evento repetido não é reaplicado e devolve o resultado gravado; mesmo `evento_id` com
  `payload_sha256` diferente é `EVENTO_DIVERGENTE`.
- A nuvem aplica cada evento numa transação: grava a venda, gera os movimentos de estoque ("Venda pelo PDV"), gera
  contas a receber quando for venda a prazo, atualiza o caixa.
- **Retenção de dependentes na nuvem**: todo evento recebido é **gravado** em `eventos_recebidos`, mesmo quando não
  pode ser aplicado (ocupa sua sequência, então a sequência nunca fica com buraco). Se uma dependência tem evento
  deste terminal em `erro` ou `retido`, o evento fica com status **`retido`** (`DEPENDENCIA_PENDENTE`) e não é
  aplicado; quando o bloqueador é reprocessado com sucesso no ERP, a nuvem reprocessa os retidos dele em ordem de
  sequência; se o bloqueador é descartado, os retidos vão para `erro` (`DEPENDENCIA_DESCARTADA`). No PDV esses eventos
  ficam `rejeitado` (quarentena: a nuvem tem o evento, mas não o aplicou), sem reenvio e sem apagar o efeito local; a
  resolução chega pelo heartbeat. A retenção **não** fica no PDV: nenhum evento fica só num disco local.
- **Estoque é um razão de movimentos** (append-only): saldo = soma dos movimentos. Por isso duas lojas vendendo offline
  nunca geram conflito; a nuvem recalcula o saldo. O PDV mostra um saldo estimado (último saldo baixado − vendas locais
  ainda não refletidas no saldo baixado).

**Autenticação e ciclo de vida do terminal**:
- O PDV é ativado (`POST /sync/ativar`) com o **código da empresa + um código de ativação** gerado no ERP (uso único,
  expira), que o vincula a empresa + loja + número do caixa e devolve um token de terminal (guardado de forma
  protegida no computador). É o único momento em que o código da empresa é digitado no PDV (ADR-02).
- Estados do terminal (`terminais_pdv.status`, com `provisionando` só durante a ativação): `ativo` → **`desativando`**
  (ERP "Revogar – aceitar pendências" ou substituição do terminal do caixa) → `revogado`; ou `ativo` → `revogado`
  ("Revogar imediatamente"). Em **`desativando`** o PDV termina a venda em andamento, não abre caixa nem vende mais,
  não reserva mais número de venda/NFC-e/vale, permite fechar o caixa e envia todas as pendências (outbox, NFC-e em
  contingência, inutilizações); a nuvem continua aceitando o push. Quando o PDV confirma pendências zeradas
  (`desativando_confirmado`, com os números finais) ou vence `carencia_ate` (padrão 7 dias), o terminal vira
  `revogado`. Essa confirmação permite que o terminal substituto continue a mesma série e numeração do caixa.
- **Custódia da chave de backup**: na ativação, a nuvem gera a chave AES-256 dos backups locais do PDV e a devolve
  cifrada para a chave pública efêmera enviada pelo PDV (`chave_backup_publica`); guarda uma cópia cifrada com a chave
  mestra em `terminais_pdv.chave_backup_cifrada`. Se a máquina morrer, o gerente gera no ERP um **código de
  recuperação** (uso único, 24 h, permissão `terminais.gerenciar`, auditado) e o PDV substituto obtém a chave
  (`POST /sync/recuperacao/chave`), decifra o backup do terminal antigo e importa os eventos não enviados com a
  identidade e a sequência do terminal antigo (`POST /sync/recuperacao/importar`). Sem isso, um backup cifrado só
  pela proteção do sistema operacional de uma máquina perdida seria ilegível e as vendas não enviadas se perderiam.
- Operadores fazem login no PDV com **login ou código + senha ou senha numérica do PDV**. A senha numérica
  (`usuarios.senha_pdv_hash`) é validada **localmente** contra o hash baixado no fluxo `acesso` — funciona offline.
  A **senha do ERP nunca desce ao PDV**: quando a empresa permite usá-la no caixa, ela só é aceita online, validada
  pela API.

## ADR-09 – API na nuvem: Node.js + TypeScript + NestJS + Drizzle ORM + PostgreSQL

- **Node.js 22 LTS**, **NestJS**, **TypeScript** (usar a versão estável mais recente compatível com o NestJS e o
  ecossistema; se a mais nova der problema de compatibilidade, usar a anterior e registrar o motivo).
- **Drizzle ORM** + `pg` (schema em TypeScript, migrações SQL versionadas com drizzle-kit, aplicadas por empresa).
  Escolhido por ser leve e fácil de usar com um banco diferente por empresa.
- **PostgreSQL 16+**.
- Validação de entrada com `zod` (schemas também reaproveitados no `packages/shared`).
- Senhas com **argon2id**. Autenticação JWT (token de acesso curto + refresh token).
- Permissões: perfis + permissões granulares por menu/ação (RBAC), limite de desconto, lojas permitidas.
- **Auditoria** em todas as entidades (quem, quando, o quê, antes/depois em `jsonb`) — evolução do "Histórico de
  produtos" do Nuvem3.
- Testes com **Vitest** (unitários) e testes de integração contra um PostgreSQL real (docker-compose).

## ADR-10 – ERP web: React + Vite + TypeScript + Mantine

- **React**, **Vite**, **TypeScript**, **React Router**, **TanStack Query** (dados do servidor), **Mantine**
  (componentes de formulário, abas, acordeão, datas, notificações — bom para telas de ERP), **TanStack Table** para as
  listagens.
- **Componente genérico de listagem** (filtros + tabela ordenável + paginação 20/25/35/50/Todos + botão Novo + clique
  na 1ª coluna abre o formulário), reproduzindo o padrão `Consulta.aspx?id=N` do Nuvem3.
- Formulários em abas/acordeão, como no Nuvem3.

## ADR-11 – Fiscal, TEF e PIX dinâmico

- Documentos fiscais de saída no PDV: **NFC-e modelo 65 é o padrão**; **CF-e via SAT (SP, em extinção) ou MFE (CE)**
  só se a UF de alguma loja exigir, pela mesma interface `IEmissorFiscal` do `GenesisPDV.Fiscal`; "Não fiscal" como
  opção configurável por loja (o Nuvem3 oferece Tipo de emissão Não Fiscal / SAT / NFC-e).
- O tipo de emissão fica em `lojas.tipo_emissao` (`varchar(12)`, padrão `'nao_fiscal'`), com
  `ck_lojas_tipo_emissao` aceitando `nao_fiscal`, `sat`, `mfe`, `nfce`. O MFE (Módulo Fiscal Eletrônico do Ceará)
  emite o CF-e por meio do integrador da SEFAZ-CE; o SAT é o equipamento de SP, que está sendo substituído pela NFC-e.
  Nenhum dos dois tem contingência própria (funcionam offline por natureza); implementação só sob demanda.
- **A UF de cada loja da Ice Beer ainda precisa ser confirmada** (decisão D1 do roadmap, PDV 35.6): ela define se a
  trilha é NFC-e (padrão), MFE (CE) ou SAT (SP, enquanto existir).
- A NFC-e é emitida **pelo próprio PDV** direto na SEFAZ (certificado A1 da loja), com **contingência offline**
  (tpEmis=9) quando não há internet, e transmissão posterior automática.
- NF-e (modelo 55) é emitida pela nuvem (ERP).
- A **NFC-e (PDV) é implementada na Fase 3F** do roadmap (logo depois da Fase 3); **NF-e modelo 55, TEF e PIX
  dinâmico ficam na Fase 6**. Desde o início o modelo de dados já guarda os campos fiscais
  (NCM, CEST, CFOP, CSOSN/CST, origem, alíquotas) para não precisar de remodelagem depois.
- **TEF e PIX dinâmico** (cobrança com QR Code gerado por PSP e confirmação automática, aviso `pix` no SSE do ADR-08)
  ficam na **Fase 6**, junto com a NF-e, porque os dois dependem de contrato e homologação com terceiros
  (provedor TEF e PSP do PIX — decisão D5 do roadmap). Até lá o PIX é recebido como forma de pagamento com
  confirmação manual pelo operador. Se o PSP for definido cedo, o PIX dinâmico pode ser
  antecipado para a Fase 3 sem impacto no resto (roadmap, seção 3).

## ADR-12 – Idioma e documentação

- Documentação, mensagens de commit e textos de interface em **português do Brasil**.
- Comentários de código: só quando o "porquê" não é óbvio.
