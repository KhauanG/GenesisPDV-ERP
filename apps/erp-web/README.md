# ERP web – GenesisPDV & ERP

Aplicação web do ERP (React + Vite + TypeScript + Mantine, ADR-10) e o **painel da plataforma** em `/plataforma`
(mesmo build, sessão e token próprios, ERP 19.1). Entrega da **Fase 0** do roadmap: base de navegação, login e os
componentes genéricos usados por todas as telas das fases seguintes.

## O que tem aqui

| Área | Onde | Referência |
|---|---|---|
| Login (código da empresa + usuário + senha, "lembrar código"), troca obrigatória da senha provisória, trocar senha, sair | `src/paginas/Login.tsx`, `TrocarSenha.tsx`, `Sair.tsx` | ERP 4.1, 4.2, 4.4 |
| Sessão: token de acesso **só em memória**, refresh pelo cookie `httpOnly` (renovação 1 min antes de vencer e num 401, uma só por vez e serializada entre abas com Web Locks), 401 → login com `?voltar=`, 403 `TROCA_SENHA_OBRIGATORIA` → troca de senha, "Sair" propagado às outras abas (BroadcastChannel) | `src/api/http.ts`, `src/auth/sessao.tsx`, `src/auth/RotaProtegida.tsx` | ERP 4.1 |
| Layout: cabeçalho (empresa, ambiente, loja de contexto, tema claro/escuro, menu do usuário), menu lateral recolhível com a árvore completa do ERP 5.4, trilha, versão | `src/layout/Layout.tsx`, `src/menu.ts` | ERP 5.1, 5.2, 5.4 |
| Menu por permissão: item sem a permissão de acesso some; grupo vazio some; rota digitada sem permissão mostra "Sem permissão"; telas ainda não entregues mostram "Em construção · Fase N" | `src/menu.ts`, `src/rotas.tsx`, `src/paginas/EmConstrucao.tsx` | ERP 2.2, 5.1 |
| `<Listagem>`: filtros, página, tamanho e ordenação na URL; ordenação no servidor (asc → desc → padrão); 20/25/35/50/Todos (aviso acima de 5.000) lembrado no `localStorage`; Primeiro/Ant./Próx./Último; clique na 1ª coluna ou na linha (Ctrl+clique = nova aba; ↑↓ e Enter pelo teclado); Novo só com `<recurso>.criar`; **Exportar** Excel (.xlsx) ou CSV pela API (`GET /api/<recurso>/exportar?formato=&<filtros>&ordenar=`, ERP 1.8) com `<recurso>.exportar` ou `relatorios.exportar`; vazio, carregando (esqueleto, mantém a página anterior) e erro com "Tentar novamente"; cartões abaixo de 768 px; filtros `loja` pré-preenchidos com a loja de contexto | `src/componentes/listagem/Listagem.tsx` | ERP 3.1 |
| `<FormularioEntidade>`: cabeçalho (título, Cód., situação, última alteração e autor), abas ou acordeão com marcador de erro, Salvar (Ctrl+S), Voltar (Esc, restaura os filtros da listagem), Novo, Excluir com confirmação, **Histórico** (gaveta com a trilha de `GET /api/auditoria`), aviso de 409 "alterado por outro usuário" com Recarregar, confirmação ao sair com alterações não salvas, somente leitura sem permissão | `src/componentes/FormularioEntidade.tsx` | ERP 3.2, 1.4, 1.7 |
| `<GradeItens>`: linhas editáveis (texto, número, dinheiro, seleção, leitura ou editor próprio); **F9**/"Inserir item" cria a linha e foca a 1ª coluna; Enter avança e, na última coluna, vai para a próxima linha (criando-a); ↑↓ mudam de linha; Delete na alça da linha (ou Ctrl+Delete num campo) remove, confirmando se houver dados; rodapé com itens, soma das quantidades e total; linha com erro em vermelho com a dica (`errosDaGrade` bloqueia o gravar); colar várias linhas do Excel | `src/componentes/grade` | ERP 3.3 |
| Seletores: `<SeletorLoja>` (lojas permitidas e ativas, "Todas" onde a tela permite; usado na loja de contexto do cabeçalho) e `<SeletorUsuario>` (busca no servidor por nome, login ou código a partir de 2 caracteres; valor vindo da URL resolvido pelo id) | `src/componentes/seletores` | ERP 3.4 |
| Casca de `<Relatorio>`: filtros no topo com **Filtrar** (na URL, o link reabre gerado), cards de resumo, gráfico opcional, tabela com totais; Exportar Excel (API), PDF e Imprimir com cabeçalho de impressão (empresa, filtros usados, data/hora, usuário) | `src/componentes/relatorio` | ERP 3.5 |
| Usuários: listagem (filtros Nome/código, Situação, Perfil, Loja; colunas Cód., Nome, Login, Perfil, Último acesso, Ativo) e formulário (Dados Gerais com lojas e estoques permitidos, limite de desconto, flags, RG, salário com `usuarios.ver_dados_rh`, endereço; PIN do PDV; Redefinir senha e Desbloquear; abas Menus do sistema e Permissões Gerais com ajustes individuais em três estados) | `src/paginas/usuarios` | ERP 11.1, 11.2 |
| Cadastros da Fase 1: **Empresa**; **Lojas** (assistente da primeira configuração, abas Dados Gerais, Fiscal, Caixas e Parâmetros por loja); **Locais de estoque** (CD como `deposito`); **Perfis de acesso** (Menus do sistema, Permissões Gerais, Duplicar); **Formas de pagamento** (todas as flags do MVP, senha de liberação, lojas em que vale e "exige supervisor", decisão 40); **Configurações** › Geral, Parâmetros e PDV com a tabela de atalhos; **Pessoas** (endereços, telefones, e-mails, categorias, CPF/CNPJ, busca de CEP, exportar); **Marcas** (Mesclar); **Categorias** em árvore | `src/paginas/{empresa,lojas,estoques,perfis,formas-pagamento,configuracoes,pessoas,marcas,categorias}` | ERP 7.1–7.2, 8.4, 8.7, 9.1, 9.3.1, 9.9, 10.1–10.3, 11.3, 13.2 |
| **Produtos**: listagem (filtros Nome, Cód., Cód. interno, Cód. barras, NCM, Marca, Categoria, Ativos, Local, Tipo, Situação de cadastro; custo só com `produtos.ver_custo`; Exportar) e formulário em acordeão (Cabeçalho com EAN principal, "Gerar código interno", NCM com busca, custo ⇄ markup ⇄ preço e margem; preços complementares; embalagens e códigos adicionais com fator e preço; Combo com posições, alternativas com acréscimo e resumo de custo/margem/desconto; Ficha técnica com perda e "Usar como preço de custo"; outras informações com vasilhame e as flags do PDV; categorias; preço por quantidade por loja e grupo de preço; lojas; estoque/combos montáveis; balança; tributação), Duplicar; **Grupos de preço por quantidade** com Simular; **Restrições de horário de venda** | `src/paginas/produtos`, `src/componentes/seletores/SeletorProduto.tsx`, `src/componentes/campos/BuscaNcm.tsx`, `src/api/produtos.ts` | ERP 8.1, 8.2, 8.9, 8.10 |
| Peças dos cadastros: `useCadastro` (carrega, grava com versão, erros por campo, exclui), `<CamposEndereco>` (CEP com busca, UF e cidade do IBGE), `<EditorPermissoes>` (perfil 2 estados, usuário 3 estados) e `<CamposConfiguracoes>` (empresa ou loja com Herdar/Personalizar) | `src/componentes/cadastro.ts`, `src/componentes/campos`, `src/componentes/EditorPermissoes.tsx`, `src/paginas/configuracoes/CamposConfiguracoes.tsx` | ERP 3.2, 9.0, 10.3.9, 11.2 |
| Painel da plataforma: login com TOTP, empresas (listar, filtrar, criar com a senha provisória do admin exibida uma vez, detalhe com migrações, suspender com motivo, reativar, tentar novamente o provisionamento) | `src/plataforma` | ERP 19.1–19.4 |
| Painel › **Migrações**: versão do código × versão de cada empresa (pendentes, erro, última execução), filtros Atrasadas/Com erro, **Aplicar em todas** (canário primeiro; "parar no primeiro erro"), **Aplicar** e **Simular** por empresa (pendentes e SQL), log das execuções | `src/plataforma/Migracoes.tsx` | ERP 19.7 |
| Painel › **Planos**: limites padrão (lojas, terminais, usuários), módulos, valor mensal e situação | `src/plataforma/Planos.tsx` | ERP 19.8 |
| **Acerto de Estoque**: listagem (Estoque, Tipo de ajuste, Situação, Período; Nº, Data, Responsável, Motivo com a origem, Estoque, Tipo, Qtd. itens, Valor de custo com `produtos.ver_custo`, Situação) e formulário (estoque da loja de contexto, tipo de estoque, Entrada/Saída/Definir, data/hora da contagem, motivo com sugestões, responsável, grade com F9, saldo atual, diferença do Definir, custo da Entrada, preço e totais), **Salvar** (rascunho), **Efetivar**, **Estornar** (motivo), Excluir rascunho, Histórico | `src/paginas/estoques/Acertos.tsx` | ERP 13.5 |
| **Saldos de estoque**: consulta por estoque × tipo (Nome/código, Estoque, Tipo, Situação do saldo, Produtos, Sem movimento), Est. mínimo/atual destacados, custo médio e custo total com `produtos.ver_custo`, venda total, totais no rodapé | `src/paginas/estoques/Saldos.tsx` | ERP 8.2.11, 16.4 (simples) |
| **Importação** de produtos (`/produtos/importacao`) e clientes (`/pessoas/importacao`): loja, planilha .xlsx/.csv, opções do 8.6, Baixar modelo, **Pré-visualizar** (resumo com Criar/Atualizar/Sem alteração/Inativar/Ignorar, inconsistências por tipo, colunas reconhecidas/ignoradas com o motivo, linhas filtráveis por erro/inconsistência e por ação, coluna **O que muda** com "Preço de venda: 4,49 → 4,99"), **Confirmar** → progresso da tarefa → resultado com o acerto gerado e o relatório de inconsistências | `src/paginas/importacao/Importacao.tsx` | ERP 8.6, 23.14 |
| **Dashboard** (casca): Mês/Ano + Loja + Filtrar; cards Pessoas, Produtos (sem preço · NCM inválido), Vendas no mês, Contas a receber/pagar (com `dashboard.ver_financeiro`); vendas do dia e do mês por loja; PDVs; estoque abaixo do mínimo; **Alertas críticos** (com `terminais.ver`) e **Caixas abertos há muito tempo** (com `fechamentos_caixa.ver`), só com algo a resolver (decisão 42) | `src/paginas/Dashboard.tsx` | ERP 6, 14.9 |
| **PDVs / Terminais** (`/cadastros/pdvs`): contadores Online/Offline/Sem contato, faixa de bloqueio com Liberar ativações, alertas de terminais, códigos pendentes (Cancelar), filtros e as 9 colunas, atualização a cada 30 s; Gerar código; detalhe com blocos, histórico, Revogar (3 modos), Substituir, Ressincronizar, Mensagem, Renomear, troca de hardware (mostra horário, IP e SO da primeira chamada da outra máquina e confirma só o id exibido; 409 recarrega) e a aba Eventos com erro (fila de decisão: reprocessar, aplicar com novo número, descartar, reprocessar todos com o código; decisão 39); bloco **Saúde do computador** com disco livre, banco do caixa e fila de impressão do último heartbeat (Central do PDV G15, README do PDV › decisão 77) | `src/paginas/terminais` | ERP 12 |

## Rodar localmente (API + ERP web), passo a passo

Pré-requisitos: Node 22.13+, pnpm 10 e um PostgreSQL 16 com uma role que possa criar bancos (o
`infra/docker-compose.yml` sobe um com `genesis`/`genesis_dev` e o banco `genesis_control`).

```bash
# 1. Dependências (na raiz do monorepo). O postinstall já compila o @genesis/shared; ao editar
#    packages/shared/src, deixe `pnpm dev:shared` rodando para recompilar.
pnpm install

# 2. Banco local (ou use um PostgreSQL 16 já instalado)
docker compose -f infra/docker-compose.yml up -d

# 3. Banco de controle: migrações + plano "padrao" + servidor de banco padrão
pnpm --filter api db:migrate:controle

# 4. Administrador da plataforma (mostra a senha e o segredo TOTP uma única vez; cadastre o otpauth:// no
#    autenticador do celular – Google Authenticator, Authy, 1Password…)
pnpm --filter api admin:criar --email voce@genesis.dev --nome "Seu Nome" --papel superadmin

# 5. API em http://localhost:3000 (deixe rodando num terminal)
pnpm --filter api dev

# 6. ERP web em http://localhost:5173 (outro terminal). O Vite encaminha /api e /saude para a API
cp apps/erp-web/.env.example apps/erp-web/.env.local   # opcional: os padrões já servem
pnpm --filter erp-web dev
```

Depois:

1. Abra <http://localhost:5173/plataforma/login>, entre com o e-mail, a senha e o código do autenticador.
2. **Nova empresa** → preencha razão social e CNPJ (ex.: `11.222.333/0001-81`) → Salvar. Anote o **código** e a
   **senha provisória** do `admin` (aparece uma única vez). Pela linha de comando dá no mesmo:
   `pnpm --filter api empresa:criar --razao-social "Ice Beer Ltda" --cnpj 11222333000181`.
3. Abra <http://localhost:5173/login>, informe o código da empresa, `admin` e a senha provisória; o sistema pede a
   nova senha e abre o Início. Cadastre usuários em **Cadastros › Usuários**.

Variáveis (`.env.example`): `VITE_API_PROXY` (destino do proxy, padrão `http://localhost:3000`), `VITE_PORTA`
(padrão 5173 — a API aceita CORS dessa origem por padrão) e `VITE_AMBIENTE` (selo no cabeçalho; vazio ou
`producao` esconde). Em produção o ERP é servido no mesmo domínio da API (o cookie de refresh é `SameSite=Strict`
e restrito a `/api/auth`), por isso não há URL de API no código: tudo é relativo a `/api`.

## Comandos (`pnpm --filter erp-web <comando>`)

| Comando | O que faz |
|---|---|
| `dev` | Servidor de desenvolvimento com recarga (proxy para a API) |
| `build` | Verificação de tipos + build de produção em `dist/` (bibliotecas em arquivos separados: `react`, `mantine`, `vendor`) |
| `preview` | Serve o `dist/` em <http://localhost:4173> com o mesmo proxy |
| `typecheck` | `tsc` do app (navegador) e do `vite.config.ts` (Node) |
| `test` | Vitest + Testing Library (jsdom) |
| `test:e2e` | Playwright de ponta a ponta contra a API e o PostgreSQL locais (fora do CI por enquanto; ver "Testes") |

Na raiz: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Produção (Implantação do piloto, I1)

`apps/erp-web/Dockerfile` (contexto = raiz do repositório) gera o build do Vite e o serve num nginx sem root
(`nginxinc/nginx-unprivileged`, porta 8080; configuração em `nginx/`): rotas do React Router caem no `index.html`
(sem cache), `/assets/*` com cache de 1 ano (nomes com hash), cabeçalhos de segurança (HSTS, `nosniff`,
`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) e `/saude-web` para o healthcheck. O mesmo nginx atende
`download.<domínio>` (página em `nginx/download/`, com CSP própria; o instalador do PDV vem de uma pasta do host
montada em `/srv/download/pdv`, publicada pela implantação: infra/producao/README.md › Página de download do PDV). **A API fica na mesma origem**:
o Traefik da VPS manda `erp.<domínio>/api/*` e `/saude` direto para a API, como o proxy do Vite em desenvolvimento —
o build não leva URL de API e o cookie de refresh (`SameSite=Strict`) funciona sem CORS. `VITE_AMBIENTE` (faixa de
ambiente) é argumento de build, vazio em produção. Passo a passo em `infra/producao/README.md`.

## Testes

`src/**/*.test.ts(x)`, com a API simulada (`fetch` falso em `src/teste/utilidades.tsx`) e o roteador em memória:

- `componentes/listagem/Listagem.test.tsx`: carga inicial com os filtros padrão; filtros na URL (Enter = Pesquisar,
  Limpar mantém a ordenação); URL compartilhada abre a mesma pesquisa; ordenação asc → desc → padrão; paginação e
  tamanho 20/25/35/50/Todos lembrado; clique na 1ª coluna/linha; Novo e Exportar por permissão; vazio e erro com
  "Tentar novamente".
- `paginas/Login.test.tsx`: sem sessão → `/login`; login lembra o código, usa o token só em memória e mostra o menu
  só com o permitido; erro genérico; validação antes da API; senha provisória obriga a troca e volta à rota pedida;
  sessão restaurada pelo cookie; Sair; rota sem permissão e tela "Em construção".
- `api/http.test.ts`: 401 → um único refresh para chamadas simultâneas e repetição com o token novo; refresh
  recusado → sessão expirada; 403 `TROCA_SENHA_OBRIGATORIA`; rotas de sessão sem refresh; falha de rede; download de
  arquivo com o nome do `Content-Disposition` (inclusive `filename*`).
- `componentes/listagem/Listagem.test.tsx` (exportar): baixa com os filtros e a ordenação atuais, sem paginação;
  sem função de exportação ou sem permissão não há botão; erro da API vira aviso.
- `componentes/grade/GradeItens.test.tsx`: F9 e Enter (inclusive criar a próxima linha), ↑↓, "Inserir item",
  Delete na alça (vazia direto, com dados confirma) e Ctrl+Delete, erro por linha e `errosDaGrade`, `mostrarErros`,
  colar do Excel, rodapé e `lerDecimal`.
- `componentes/seletores/Seletores.test.tsx`: lojas permitidas e ativas, "Todas" = `null`, inativa gravada visível;
  busca de usuário a partir de 2 caracteres com os parâmetros enviados, valor resolvido pelo id sem pesquisa extra.
- `componentes/relatorio/Relatorio.test.tsx`: só gera depois do Filtrar, filtros na URL, link já gerado, cards,
  tabela e totais, cabeçalho de impressão, Excel/PDF/Imprimir e permissão `relatorios.exportar`.
- `paginas/pessoas/Pessoas.test.tsx`: validação na tela sem chamar a API, busca de CEP que preenche o endereço e a
  cidade, corpo enviado com endereço/telefone/e-mail no formato da API, 409 de CPF com o link para o cadastro
  existente, limite de compras bloqueado sem `pessoas.editar_credito`.
- `paginas/lojas/Lojas.test.tsx`: assistente cria o estoque homônimo (`estoqueId` nulo + nome do estoque); CD com tipo
  Depósito/CD desliga o PDV e usa o estoque `deposito` existente; somente leitura sem `lojas.criar`.
- `componentes/EditorPermissoes.test.tsx`: divisão do catálogo em menus × gerais; perfil (desmarcar "Ver" desmarca as
  demais ações); usuário com os três estados; busca.
- `paginas/configuracoes/Configuracoes.test.tsx`: grava só as chaves alteradas, 🏬 de sobreposição, Herdar/Personalizar
  na loja, conversão para o catálogo; atalhos com tecla repetida/inválida não chegam à API.
- `paginas/produtos/Produtos.test.tsx`: corpo da API (EAN principal + adicionais, lojas só com dados, combo com
  alternativas) e erros da API/zod de volta aos campos; Duplicar sem EAN/código interno/ids; DV do EAN e preço
  validados na tela sem chamar a API; Calcular pelo markup e markup/margem recalculados ao digitar o preço; EAN
  duplicado com "avisar" (confirmação e regravação com `confirmarEanDuplicado`); combo com resumo (custo, soma,
  desconto, margem/markup e faixa com as trocas), custo somente leitura e combos montáveis no bloco Estoque;
  listagem sem a coluna de custo sem `produtos.ver_custo`; Simular do grupo (6 + 6 latas = preço do mix).
- `paginas/estoques/Acertos.test.tsx`: novo acerto com o estoque e o tipo padrão, produto pela busca, saldo atual e
  custo total na tela e o corpo da API; quantidade zero na Entrada barrada na grade sem chamar a API; rascunho
  "Definir" com a diferença e Efetivar com a versão (vira somente leitura com Estornar); Estornar pede o motivo;
  listagem com a origem e sem custo sem `produtos.ver_custo`; saldos com totais e filtros padrão.
- `paginas/importacao/Importacao.test.tsx`: loja e opções → prévia em multipart (sem `Content-Type` manual), resumo e
  inconsistências, filtro das linhas e por ação, "O que muda" e "Sem alteração", Confirmar com as opções e
  acompanhamento da tarefa até o resultado (acerto e relatório); filtro inicial "Todas" quando `ignorar` não tem erro
  (Excluir sem produto) e ação escolhida tirando o filtro "Com erro"; clientes sem loja e erro da API; dashboard com cards, vendas por loja, PDVs, estoque baixo e Filtrar.
- `paginas/terminais/Terminais.test.tsx`: "há N min" e rótulo Loja · Caixa; aviso da faixa reservada na substituição;
  listagem com contadores, badges (pendências, hardware, versão abaixo da mínima), alerta da D20 com link para a aba,
  códigos pendentes (Cancelar) e Liberar ativações; filtros na API; modal de código com o primeiro caixa livre e o
  código exibido uma vez; revogar imediato só com o nº do caixa digitado; a saúde do computador (G15: disco nos limites
  de 1 GB e 200 MB, fila "não impressos" em âmbar, o que fazer embaixo do campo nas duas faixas, heartbeat de mais de
  24 h com selos cinza e "Dado antigo", sem os campos e no revogado sem cor).
- `paginas/implantacao/Prontidao.test.tsx` (implantação I5): o resumo (pronta ou quantos faltam, ok/avisos/faltas),
  os grupos como regiões, a situação e o "Resolver" com o link de cada item (sem link fora do ERP), "Só o que falta
  resolver", a troca de loja e o erro da API; em `paginas/lojas/Lojas.test.tsx`, a chave e o nome do recebedor PIX no
  corpo da loja (nulos no CD) e os três campos travados sem `lojas.editar_pix`.
- `plataforma/Plataforma.test.tsx`: situação das migrações, filtro na URL e na API, aplicar em uma (com confirmação)
  e em todas ("parar no primeiro erro"), simular com SQL, somente leitura sem ações; planos.

**Ponta a ponta (Playwright, `e2e/`)**: `pnpm --filter erp-web test:e2e` percorre painel (login com TOTP) → nova
empresa (senha provisória exibida uma vez) → Migrações e Planos → login no ERP com troca obrigatória da senha →
cadastro de usuário (senha gerada) → Exportar CSV → suspender (o login no ERP é recusado com o motivo) → reativar (o
login volta). O `playwright.config.ts` sobe a API (`e2e/servidor-api.ts`: banco de controle descartável
`genesis_e2e_<aleatório>`, faixa de códigos de empresa livre entre 700000 e 799999 e um superadmin com senha e
segredo TOTP conhecidos) e o build de produção pelo `vite preview` (portas 3100 e 5174, `E2E_PORTA_API` e
`E2E_PORTA_WEB` mudam), e no fim remove os bancos e as roles criados (`e2e/limpeza.ts`). Precisa do PostgreSQL de
`DATABASE_URL` (padrão: o local) e, uma vez, do navegador: `pnpm --filter erp-web exec playwright install chromium`.
`e2e/fluxo-fase1a.spec.ts` percorre a Fase 1A: empresa nova → primeiro acesso → assistente da loja para o CD
(Depósito/CD com o estoque "CD - Estoque Ice Beer") e a "Loja 1 - Ice Beer Hermes" (estoque homônimo) → produto com
fardo (DUN-14 × 12), atacado, grupo de preço "CERVEJA 600ML" (mix) e casco pelo formulário → "COMBO DE WHISKY 1L" com
três posições e o Monster como alternativa do Red Bull → acerto de Entrada (rascunho → efetivado) → saldos → combos
montáveis (Loja 1 = 6, CD = 0) → importação de um CSV no formato do Nuvem3 (prévia, tarefa e relatório) → dashboard;
salva as telas em `E2E_TELAS` (padrão `test-results/telas-fase1a`). O `e2e/servidor-api.ts` sobe um S3 em memória
(o dos testes da API) e liga a fila para a tarefa da importação. Ainda não roda no CI (precisa de navegador e ~1,5 min);
entra lá quando a homologação existir.

## Versões escolhidas

| Pacote | Versão | Observação |
|---|---|---|
| React / React DOM | 19.3.1 | |
| Mantine (`core`, `hooks`, `form`, `dates`, `notifications`, `modals`) | 9.7.4 | `@mantine/form` valida com os mesmos schemas `zod` do `@genesis/shared` |
| React Router | 8.5.1 | modo "data router" (`createBrowserRouter`), necessário para o `useBlocker` (alterações não salvas) |
| TanStack Query / Table | 5.105.0 / 9.3.1 | Table v9 (`useTable` + `tableFeatures({ rowSortingFeature })`, ordenação manual vinda da URL) |
| Vite / Vitest / `@vitejs/plugin-react` | 8.3.5 / 5.0.5 / 6.1.2 | |
| TypeScript | **6.0.3** (não a 7) | mesmo motivo da API: o typescript-eslint ainda exige `< 6.1` |
| jsdom | **29.1.1** (não a 30) | o jsdom 30 exige Node ≥ 22.22.2; o ambiente local tem 22.22.0. Voltar à 30 quando o Node mínimo subir |
| Testing Library (`react`, `dom`, `user-event`, `jest-dom`) | 16.3.3 / 10.4.2 / 14.6.8 / 7.0.1 | |
| `eslint-plugin-react-hooks` | 7.1.1 | configuração `recommended-latest` (inclui as regras do React Compiler) |
| `@tabler/icons-react`, `dayjs` | 3.50.0, 1.11.23 | |
| `@playwright/test` | 1.64.1 | só o `test:e2e` (Chromium headless) |

## Decisões de implementação

Divergências e lacunas (precedência ADR > MD > SYNC > ERP/PDV) e escolhas técnicas:

1. **Token de acesso só em memória**; a sessão sobrevive ao F5 porque o app chama `POST /api/auth/refresh` ao abrir
   (cookie `httpOnly`). O refresh é rotativo com detecção de reuso na API, então duas abas renovando ao mesmo tempo
   derrubariam a sessão: a renovação passa por uma trava entre abas (`navigator.locks`) e por uma promessa única
   dentro da aba.
2. **Lojas permitidas exigidas só quando a empresa já tem lojas**: o ERP 11.2 pede "ao menos uma", mas na Fase 0 a
   empresa nasce sem lojas (a primeira vem no assistente da Fase 1, MD 7.13) e o admin precisa cadastrar a equipe.
3. **Usuários – regras da API** (ERP 11.2, 2.1): só Master marca/desmarca Master e só Master altera ou exclui outro
   Master (evita que um gerente troque o login de um Master); o último Master ativo não pode ser desmarcado,
   desativado nem excluído; ninguém altera o próprio perfil, lojas, limite de desconto ou flag Master, nem se exclui;
   quem não é Master só atribui perfil cujas permissões ele tem e só concede/retira lojas que ele enxerga (as demais
   lojas do usuário são preservadas). Mudança de perfil, Master ou lojas incrementa `permissoes_versao` e gera
   auditoria `permissoes_alteradas` além do `editar`.
4. **Toda senha definida por outra pessoa é provisória** (ERP 4.1): na criação, a senha digitada ou a gerada
   automaticamente obriga a troca no primeiro acesso; a gerada é exibida uma vez.
5. **Promoções** usa `produtos.ver` no menu: `promocoes.ver` (ERP 5.4) ainda não está no catálogo de permissões
   (promoções são da PDV-2). Restrições de horário e Grupos de preço usam as permissões próprias
   (`restricoes_horario.*`, `grupos_preco.*`), que entraram no catálogo com o cadastro de produtos.
6. **Fase de cada tela "Em construção"**: tirada do roadmap (Fase 1 para as telas de [P1] e as partes de [P2]/[P3]
   listadas lá; Download de XML na Fase 3F; Integrações na Fase 7; demais pela etiqueta [P2]…[P6]).
7. **Ordenação de uma coluna por vez**: a API aceita só `ordenar=campo:dir` (`packages/shared/paginacao.ts`); o
   Shift+clique para a segunda coluna (ERP 3.1) fica para quando a API aceitar listas.
8. **Esc no formulário** volta à listagem só quando não há modal/lista suspensa aberta (o Mantine mantém as listas
   de opções montadas, por isso a verificação é pelo `aria-expanded` do campo).
9. **Datas** exibidas no fuso `America/Sao_Paulo` até existir o fuso por loja/empresa no front (ERP 1.5).
10. **Esqueci minha senha**: enquanto `POST /auth/esqueci-senha` e o e-mail transacional não existem, o link mostra
    "Peça a um administrador da sua empresa para redefinir sua senha" (a resposta prevista no ERP 4.3 para quem não
    tem e-mail).

11. **Exportar** é síncrono (a API gera e devolve o arquivo; até 50.000 linhas). O ERP 3.1 manda gerar em segundo
    plano acima de 5.000 (3.6): isso entra junto com o ícone de Tarefas no cabeçalho. A listagem só mostra o botão
    quando a tela informa a função de exportação (`ConfigListagem.exportar`), além da permissão.
12. **PDF dos relatórios** usa o layout de impressão do navegador ("Salvar como PDF"), com o cabeçalho da empresa, os
    filtros, a data/hora e o usuário (classes `so-impressao`/`nao-imprimir` em `estilos.css`). O PDF gerado na API
    vem com os templates de impressão (ERP 3.7). A casca só gera depois do **Filtrar** (ou com `gerado=1` na URL),
    porque relatórios podem ser pesados; `gerarAoAbrir` liga a geração imediata nos leves.
13. **`<GradeItens>`**: números ficam como o texto digitado (vírgula decimal) até a API (ERP 1.5); o rodapé soma com
    `lerDecimal` só para exibição. "Delete remove a linha selecionada" (ERP 3.3) vale na alça da linha (nº da linha,
    focável) e como Ctrl+Delete num campo: Delete puro dentro de um campo continua apagando caracteres. O campo
    Produto (busca incremental, leitor de código de barras, variação) entra com o cadastro de produtos (Fase 1) como
    `editor` da coluna.
14. **Seletores na Fase 0**: `<SeletorLoja>` e `<SeletorUsuario>`; Pessoa, Produto, Estoque, `<ArvoreSelecao>`,
    `<BuscaNcm>` e `<UploadArquivo>` dependem de cadastros da Fase 1/2. `<SeletorUsuario>` consulta `GET /usuarios`,
    então exige `usuarios.ver` (as telas que o usarem para quem não tem essa permissão vão precisar de uma rota de
    consulta resumida). As lojas vêm de `/auth/eu`, que passou a trazer `ativa`.
15. **Painel › Planos** é só consulta (a API tem só `GET /planos`); criar/editar planos e "mudar o plano copia os
    limites" (ERP 19.8) entram com a edição de empresa. **Migrações**: "Aplicar" espera a execução terminar (sem
    progresso em tempo real) e o log é o resumo de cada execução gravado em `auditoria_plataforma`.
16. **E2E sobre o build de produção** (`vite preview`): no `vite dev`, a otimização de dependências na primeira
    visita a uma tela recarrega a página no meio do teste.

17. **Formulários de cadastro com `useCadastro`**: o hook concentra o ciclo do ERP 3.2 (carregar → `form.setValues`/
    `resetDirty`, gravar com `versao`, `campos` da API e do `zod` no formulário com foco na aba do erro, 409 para o
    `<FormularioEntidade>`, excluir). Novo registro grava e troca a URL para `/:id`. A validação na tela usa os mesmos
    schemas do `@genesis/shared` que a API.
18. **Selects de cidade** guardam o código IBGE como texto (valor do `<Select>` do Mantine) e viram número na gravação;
    a lista vem de `GET /referencias/municipios?uf=` (cache sem expiração na sessão). A busca de CEP é opcional: sem
    internet (404 da API) a tela avisa e segue com o endereço digitado.
19. **Configurações**: só as abas Geral, Parâmetros (9.3.1) e PDV (9.9, com o bloco Avançado e os atalhos) nesta fase;
    os rótulos ficam em `paginas/configuracoes/rotulos.ts` e tipo/padrão vêm do catálogo compartilhado. Cada bloco tem
    o próprio Gravar e manda só as chaves alteradas; a loja usa o mesmo componente com Herdar/Personalizar (Lojas ›
    Parâmetros). Chaves de módulos futuros (comandas, delivery, taxa de serviço) aparecem marcadas "módulo futuro".
20. **Permissões na tela** (ERP 11.2): "Menus do sistema" = ações `ver/criar/editar/excluir/exportar` de recursos do
    ERP; "Permissões Gerais" = as demais e as do PDV, por grupo. No usuário os ajustes têm Gravar próprio (rota
    `PUT /usuarios/:id/permissoes`, com a versão do usuário), separado do Salvar dos Dados Gerais. "Marcar Ver do grupo
    marca todos os itens" ainda não foi feito (o clique é por item).
21. **Lojas**: criar loja é o assistente (estoque homônimo ou existente); depois de gravar, `/auth/eu` é relido para a
    loja aparecer nos seletores (`recarregarEu` na sessão). A aba Fiscal tem só as colunas da loja (o certificado, o
    CSC e o TEF entram com a fase fiscal) e Anexos espera o `<UploadArquivo>`.
22. **Categorias**: a árvore é uma lista recolhível com menu ⋮ (Configurar, Adicionar subcategoria, Excluir) e painel
    lateral; "mover" é o campo Categoria pai do painel (a API tem `POST /categorias/:id/mover`); arrastar e soltar fica
    para a árvore completa da Fase 2.
23. **`document.fonts`** é simulado no `teste/setup.ts`: o `<Textarea autosize>` do Mantine 9 ouve esse evento e o
    jsdom não o implementa.

24. **Acordeão do `<FormularioEntidade>`** (ERP 8.2): o primeiro bloco fica sempre aberto, os demais abrem sob demanda
    e mostram um resumo quando fechados; bloco com erro de validação fica aberto enquanto o erro existir. O Mantine
    desmonta o conteúdo do bloco fechado (os valores ficam no `useForm`). O modo acordeão passou a respeitar o
    somente leitura (`fieldset disabled`).
25. **Formulário de produto**: decimais digitados como texto (vírgula) e enviados como string; o EAN principal é um
    campo do Cabeçalho e vira a linha `principal` de `codigosBarras`; posições do combo e insumos da ficha técnica são
    listas separadas no formulário (`componentes` na API). `useCadastro` ganhou `mapearErros` para levar
    `codigosBarras.N`/`componentes.N` de volta aos campos. As grades do produto (códigos, faixas, posições,
    alternativas, lojas) são linhas de formulário, não o `<GradeItens>`: F9 e Alt+↑/↓ não foram ligados (a posição
    sobe pelo botão ↑). Os produtos escolhidos ficam no formulário (`ProdutoOpcao`) para o resumo do combo ser
    calculado na tela com `resumoCombo` de `@genesis/shared` (mesma conta da API).
26. **Confirmações**: EAN duplicado com `geral.ean_duplicado = 'avisar'` (409 com `confirmar`) abre "Gravar mesmo
    assim?" e reenvia com `confirmarEanDuplicado`; combo com margem negativa pede confirmação ao gravar; desligar
    "Permite troca" com alternativas pede confirmação e as remove; produto de outro grupo de preço pede para mover.
27. **Lojas do produto**: uma linha por loja ativa permitida; só vão à API as linhas com algum dado (ou que já
    existiam). **Duplicar** abre `/produtos/:id/duplicar` como produto novo com os dados copiados (decisão 73 da API).
28. **Simular** do grupo de preço usa `simularGrupoPreco` de `@genesis/shared` (porta da regra do `MotorPreco` do
    PDV) com "Usa Produto Preço Volume" ligado e a loja escolhida para as faixas, o preço da loja, a promoção vigente
    e as faixas próprias de cada membro (`precosMembros` do detalhe, decisão 101 da API). Onde a chave está desligada
    (`GET /produtos/preco-volume`) o bloco "Preço por quantidade", o grupo e o resultado do Simular mostram o aviso
    amarelo com o link para Configurações › Parâmetros.

29. **Acerto na tela**: a grade é o `<GradeItens>` com o `<SeletorProduto>` como editor (só tipos com saldo próprio:
    combo/kit, serviço e produzido ficam fora); o saldo atual e o custo médio vêm de `GET /saldos-estoque/itens` para os produtos
    da grade (no efetivado, o saldo e o custo gravados no item). Totais pela mesma conta da API (`valoresItemAcerto`/
    `totaisAcerto` de `@genesis/shared`; Definir valoriza a diferença). Efetivar exige o rascunho salvo (botão
    desabilitado com alterações pendentes); efetivado/estornado vira somente leitura com o aviso próprio
    (`avisoSomenteLeitura` no `<FormularioEntidade>`). O responsável usa o `<SeletorUsuario>` só com `usuarios.ver`
    (sem ela, é quem grava); a listagem tem o filtro **Responsável** (primeiro do ERP 13.5, também só com
    `usuarios.ver`). "Importar contagem" (coletor), "Imprimir" (folha de contagem cega) e o "Ajustar" rápido
    do produto ficam para a Fase 2.
30. **Saldos de estoque** entrou no menu Estoque (`/estoque/saldos`, `estoque_saldos.ver`) como a consulta simples da
    Fase 1; o relatório Estoque Atual (16.4, Relatórios) continua "Em construção · Fase 2". A `<Listagem>` ganhou o
    filtro `data` e o `rodape` (totais da página carregada vindos da API).
31. **Importação**: uma tela para produtos e clientes (escolha por botões quando o usuário tem as duas permissões);
    `/pessoas/importacao` entrou no menu Pessoas (o ERP 8.6 põe os dois botões na tela de Produtos, mas quem só tem
    `pessoas.importar` não veria o menu). O upload usa `apiErp.enviar` (multipart, com a mesma renovação de sessão);
    a tarefa é acompanhada por `GET /tarefas/:id` a cada 1 s até concluir; o relatório é o link assinado da tarefa.
    Mudar loja, arquivo ou opção descarta a prévia (a confirmação usa as mesmas opções da prévia).
32. **Dashboard**: os filtros só valem no **Filtrar** (ERP 6); o mês é um `<CampoMes>` ("Outubro/2026"); os gráficos do ERP 6
    ficam para a Fase 5 (com vendas zeradas não informam nada) e os cards financeiros aparecem zerados com
    `dashboard.ver_financeiro` até a Fase 4.
33. **Itens "parcial" do roadmap (Fase 1 › ERP – cadastros base)** e fase de destino: aba **Anexos** da loja
    (logotipo/foto) e os anexos de marca/categoria esperam o `<UploadArquivo>` → **Fase 2**, com as imagens do produto
    (decisão 21); **produto com variações** não é criado pela importação (a grade fica no formulário) → importação
    completa da **Fase 2**; o combo entra pela coluna "Composição" (decisão 95 da API); **Tipo de Estoque** (ERP 13.6):
    `/estoque/tipos` era a listagem somente leitura (Nome, Uso, Vendável, Padrão, Ativo); a edição veio na Fase 2
    (decisão 49);
    **ficha técnica**: o bloco do produto (insumos, perda, custo calculado pelo custo médio dos insumos ou, sem ele, pelo
    custo do cadastro) está pronto, a baixa dos insumos na venda é da aplicação da venda desta mesma fase e depende da
    confirmação da **D17** (roadmap seção 16). As políticas de acesso que a tela precisa respeitar (importação,
    `negar`, lojas restritas) estão nas decisões 85–92 da API.
34. **Datas em pt-BR**: nada de `<input type="datetime-local|month|date">` (seguem o idioma do navegador:
    "mm/dd/yyyy", "October 2026"). `componentes/campos/CamposData.tsx` tem o `<CampoDataHora>` (`DateTimePicker`,
    "DD/MM/AAAA HH:mm", valor `AAAA-MM-DDTHH:mm` do formulário) e o `<CampoMes>` (`MonthPickerInput`, "Outubro/2026",
    valor `AAAA-MM`), com o `DatesProvider` pt-br do `App`; a data específica da restrição de horário usa `DateInput`.
35. **Acordeão do produto**: `AbaFormulario.fixo` mantém o bloco sempre aberto e sem seta, recalculado a cada
    renderização (o Cabeçalho e o "Combo (kit)" no tipo Combo — trocar o tipo abre o bloco). Os blocos fechados têm
    resumo (Combo "3 posição(ões) · custo · margem", Categorias com o caminho da principal, Outras informações, Preço
    por quantidade, Lojas, Balança, Tributação "NCM · CFOP · CST"). Campos calculados do Cabeçalho (custo e markup do
    combo, custo médio, margem) usam `variant="filled"`; no combo "Permite fração" fica desligado (a validação
    compartilhada recusa combo fracionado). "Gerar código de barras interno" (prefixo 2) preenche o campo de código de
    barras.
36. **Combo na tela** (ERP 8.2.17): posições com "Custo × qtd"/"Preço × qtd" (tooltip com a conta); alternativas com
    o preço de venda (peso do rateio), a diferença de custo × qtd e ↑/↓ que grava a `ordem` do diálogo do PDV;
    desconto do combo com o percentual ou, quando o combo custa mais que os itens avulsos, "Acréscimo sobre os itens
    avulsos" em laranja. Os avisos dos componentes (`avisosCombo` da API) ficam num só alerta recolhível com link para
    cada produto; os fiscais só se destacam com loja ativa que emite documento (`eu.lojas[].tipoEmissao`), senão viram
    uma nota discreta. Embalagens e códigos adicionais têm cabeçalho de colunas, sugerem a unidade FD/CX com fator > 1
    e mostram o preço unitário equivalente (R$ 108,00 ÷ 12 = R$ 9,00). As contas usam o decimal do `@genesis/shared`.
37. **Lojas › CD (depósito)**: sem campos de cupom e de menu digital (frase do rodapé, chave e "Usa menu digital"
    somem e vão vazios/desligados); "Fantasia" perde a dica "impresso no cupom".
38. **PDVs / Terminais** (ERP 12; `src/paginas/terminais`). Listagem (`/cadastros/pdvs`) com contadores por
    conexão, faixa "Ativações temporariamente bloqueadas" com **Liberar ativações**, alertas abertos de terminais
    (D20 e força bruta: ainda não há tela de alertas), códigos pendentes com Cancelar, filtros na URL (loja de
    contexto como padrão, situação, conexão, versão) e as 9 colunas da 12.2; detalhe (`/cadastros/pdvs/:id`) com os
    blocos da 12.4, histórico (auditoria + comandos) e as ações conforme a permissão: Revogar nos três modos
    (`<DialogoRevogar>`: imediato e perdido pedem o nº do caixa; a notificação do perdido diz quantos PINs e senhas
    foram anulados), Substituir (abre o `<ModalGerarCodigo>` travado no caixa, com o aviso da faixa reservada pelo
    salto de +1000 quando não houve confirmação), Ressincronizar (todos ou um fluxo), Enviar mensagem, Renomear e,
    com hardware alterado, Confirmar troca / Não reconheço. Terminal já revogado por outro motivo mantém só
    "Perdido/roubado" › "Terminal perdido/roubado" (`aceitaMarcarPerdido` do shared: o furto descoberto depois). O
    modal de gerar código lista os caixas por `GET /terminais/caixas-livres` (basta `terminais.ativar`, sem
    `lojas.ver`; o erro da consulta aparece no campo), inclusive o de um terminal em desativação, com aviso. A faixa
    de bloqueio substitui o alerta `ATIVACAO_FORCA_BRUTA` na listagem. Listagem, códigos e detalhe se atualizam a
    cada 30 s (`refetchInterval`). O status de conexão vem calculado da API com o `statusConexao` de
    `@genesis/shared` (mesmos limiares). A aba **Eventos com erro** (payload só com
    `terminais.gerenciar`); o retido mostra qual evento o segura ("Aguardando o evento nº 1 (tipo)", ERP 12.5); as
    ações da fila entraram na 1C (decisão 39). `renderizarComSessao` (testes) aceita o caminho da rota para telas com
    `useParams`. Fora desta versão: QR code do código (não há
    biblioteca de QR no ERP), "Novo caixa" e série NFC-e no modal (o caixa novo é cadastrado em Lojas › Caixas; série
    nova é fiscal, 3F), Renovar token, Solicitar logs, Código de recuperação e a aba Perdas prováveis. O cliente HTTP
    ganhou `patch`. O bloco **Saúde do computador** (disco livre, banco do caixa e fila de impressão do último
    heartbeat, com as cores do Painel de saúde do PDV e o que fazer escrito embaixo) chegou com a Central do PDV,
    bloco G15 (README do PDV › decisão 77; os limites em `nivelDiscoLivre`/`nivelFilaImpressao` do shared).
39. **Fila de decisão** (ERP 12.5; SYNC 11.4; Fase 1C, C8; `src/paginas/terminais/FilaDecisao.tsx`). A aba
    **Eventos com erro** carrega só quando aberta, paginada (`TAMANHO_PAGINA_FILA` = 50, `Pagination` do Mantine) e
    filtrável por situação e código; a coluna Agregado mostra o `resumo` da API ("Venda L01-C02-000123 · R$ 71,58 · 4
    itens"), também sem `terminais.gerenciar`. Com `terminais.gerenciar`, cada linha tem o menu **Ações**: Reprocessar
    e Aplicar com novo número (este só com `aceitaNovoNumero` do shared) pedem confirmação (`modals`) e mostram o
    desfecho numa notificação (`mensagemReprocessamento`: o evento e os dependentes reaplicados; o que continua com
    erro ou retido fica na tela até fechar); Descartar abre o `<DialogoDescartar>` com a justificativa (mínimo de
    `JUSTIFICATIVA_DESCARTE_MIN`) e, quando a API manda `confirmacaoDescarte`, o campo "Digite … para confirmar" (o
    botão só habilita com os dois; a API confere de novo); Ver payload. **Reprocessar todos com o código** lista os
    códigos de erro do terminal com a quantidade e cria a tarefa (ícone Tarefas). O menu da linha usa
    `hideDetached={false}`: dentro da tabela, o Floating UI dava a linha como fora da tela no jsdom e escondia o menu.
    Cada ação invalida `['terminais']` (detalhe, contador e fila) também no erro: o 409 do descarte ("já foi
    resolvido") fecha o diálogo e a lista volta sem a linha velha. Se a ação (ou o push, ou o lote) esvazia a página
    atual, a tela volta para a última página que ainda tem eventos, em vez de dizer que a fila está vazia; a
    paginação aparece também enquanto a página atual passa de 1. Os alertas da fila (`EVENTO_DESCARTADO` um a um,
    `EVENTO_COM_ERRO` somado por terminal) aparecem no detalhe e na listagem com "Ver eventos com erro"; o
    descartado tem **Ciente** (com `terminais.gerenciar`, a mesma janela "O que foi verificado" do token anterior).
    O "Ciente" continua só aqui no detalhe do terminal: o painel do Dashboard (C14, decisão 42) conta o alerta e leva
    a este detalhe; o "Ciente" no próprio painel é da Fase 5. O link para a venda espera a consulta de vendas (C12).
40. **Formas de pagamento por loja** (ERP 10.2; Fase 1C, C8b; dono, O9a/D25 e O23; README da API › decisão 136).
    O campo **Lojas** do formulário virou `MultiSelect` (vazio = todas as lojas, inclusive as novas; a forma só aparece
    no caixa das lojas escolhidas) e a listagem ganhou a coluna **Lojas** ("Todas" ou os nomes, `rotuloLojas`). Na aba
    Uso no PDV entrou **Exige liberação do supervisor no PDV**, e "Permite troco" virou **Dá troco**, desligado e
    bloqueado quando a integração não é "Nenhuma" ou o tipo é cartão ou PIX (`podeDarTroco`; trocar o tipo ou a
    integração para um desses desliga a flag), a mesma regra do zod e do CHECK. A forma que vale também numa loja que o
    usuário não tem (`detalhe.lojaIds` fora de `eu.lojas`, sem `todasLojas`) abre só leitura, com o aviso "esta forma
    também vale em loja a que você não tem acesso" — a API responderia 403 ao gravar —, e essa loja aparece no campo
    como **Loja sem acesso** em vez do id cru na pílula. A loja excluída não aparece: a exclusão da loja exclui os
    vínculos dela (README da API › decisão 136). Testes em `src/paginas/formas-pagamento/FormasPagamento.test.tsx` (a
    forma da Hermes e da Treino só leitura para o gerente da Hermes; a só da Hermes, editável).

41. **Consultas de vendas e caixa e dashboard real** (ERP 6, 14.9, 15.2–15.4; Fase 1C, C12; dono, O3/D12 e O10/D39;
    README da API › decisão 137; `src/paginas/vendas`). **Vendas** (`/vendas`, `/vendas/:id/:aba`), **Reforço de
    caixa** (`/vendas/reforcos`), **Sangria** (`/vendas/sangrias`) e **Fechamento de caixa**
    (`/financeiro/fechamentos-caixa`) saíram do "Em construção" (`pronto` no menu; `consulta()` em `rotas.tsx` dá à
    listagem e ao detalhe a mesma permissão de ver). As listagens usam o `<Listagem>` com o rodapé dos totais; as
    datas são o **dia operacional** (padrão "hoje" pelo corte de 05:00 da empresa, `diaOperacionalHoje`, D7); os
    filtros de operador e forma só aparecem com `usuarios.ver` e `formas_pagamento.ver` (as opções vêm dessas APIs);
    o filtro **Loja de treino** (sem / com / só ela; padrão sem) só aparece quando a empresa tem loja de treino
    (`eu.lojas[].treino`), e a loja de treino leva a marca "treino" nas tabelas e "(treino)" no `<SeletorLoja>`. O
    `<Listagem>` ganhou o filtro `oculto` (vem só pela URL, vai à API e sai com Limpar): o link "Ver as vendas da
    sessão" do fechamento abre `/vendas?sessaoCaixaId=…&dataInicial=&dataFinal=` (datas vazias explícitas: a sessão
    esquecida aberta tem vendas de mais de um dia). Enquanto o filtro oculto vale (continua em cada Pesquisar), a
    listagem mostra acima da grade um aviso (`rotuloOculto`) com **Remover**: sem ele, quem trocava as datas para ver o
    dia da loja inteira ficava preso a um caixa sem saber por quê. O detalhe da venda tem as abas Dados gerais, Financeiro (lucro só
    com `vendas.ver_lucro`), Documento fiscal (vazio até a 1D) e Histórico; o do movimento mostra o cancelamento feito
    no PDV e liga à sessão; o do fechamento mostra calculado × informado × diferença por forma (só aqui, O3), o cálculo
    do dinheiro refeito na nuvem com o aviso quando difere do calculado do PDV (evento da sessão ainda por chegar), os
    movimentos e as vendas; a sessão fechada pela nuvem mostra o alerta "o fechamento ainda não chegou" só enquanto
    não há fechamento (depois de o `caixa.fechado` tardio chegar, a situação é Fechada e fica uma nota). O `<Historico>` do `FormularioEntidade` passou a ser exportado para essas telas. No
    **Dashboard**, o card Vendas no mês ganhou o link Listagem (`/vendas` do mês, só as finalizadas, mesma loja), a
    tabela por loja marca a loja de treino e a caixa **Incluir loja de treino** manda `treino=incluir` (o link leva o
    mesmo). O mês começa vazio e a API escolhe o do dia operacional da empresa (D7; o campo mostra o que ela devolveu):
    antes do corte, no dia 1, o card continua no mês anterior junto com a coluna "hoje". No cadastro da loja entrou o
    switch **Loja de treino** (só não fiscal: o zod recusa com NFC-e/SAT). Fora: Exportar, Imprimir comprovante
    (templates, ERP 3.7), conferência do fechamento (Fase 3; quebra/sobra na Fase 4), Nova venda/cancelar/devolução
    (Fase 3) e os gráficos (Fase 5). Testes em `src/paginas/vendas/Vendas.test.tsx` (dia operacional, padrões e sessão
    da URL na listagem com o aviso e o Remover, venda cancelada e Financeiro, fechamento com a diferença e o aviso de
    divergência, sessão fechada pela nuvem antes e depois do fechamento tardio, Dashboard com a loja de treino e o mês
    da API) e `MovimentosCaixa.test.tsx` (Sangria: cancelada marcada, rodapé e o tipo de fechamento no filtro; detalhe
    com o cancelamento e o link da sessão só com `fechamentos_caixa.ver`; Fechamento de caixa: dia operacional padrão e
    "Somente com diferença").
42. **Painéis de alertas críticos e de caixas abertos no Dashboard** (ERP 6, 14.9; Fase 1C, C14; dono, O11 — padrão
    aplicado, roadmap D40; README da API › decisão 139; `src/paginas/Dashboard.tsx`). **Alertas críticos (N)** (com
    `terminais.ver`): os selos por tipo com o nome em português (`NOMES_ALERTA`: evento descartado, evento com erro,
    evento divergente, terminal desativado com eventos, token anterior reutilizado, tentativas de ativação) e os 10
    mais recentes, cada título com o link ao detalhe do terminal (`/cadastros/pdvs/:id`), onde se reprocessa, descarta
    ou dá "Ciente"; o de força bruta na ativação, sem terminal, leva à listagem (`/cadastros/pdvs`), onde fica o
    "Liberar ativações". A API só manda os tipos que têm essa tela, então nenhum selo sai com o código cru nem linha
    sem destino. **Caixas abertos há muito tempo** (com `fechamentos_caixa.ver`): loja · caixa com o link ao fechamento
    da sessão (`/financeiro/fechamentos-caixa/:id`), o operador e há quantas horas está aberto. Os dois só aparecem com
    algo a resolver. O **`EVENTO_DIVERGENTE`** (o mesmo evento recebido com outro conteúdo, SYNC 8.4) ganhou no detalhe
    do terminal só o **Ciente** (sem "Ver eventos com erro": ele não passa pela fila), com o exemplo "caixa conferido com
    o suporte", e na listagem o link "Ver o terminal". Testes em `src/paginas/importacao/Importacao.test.tsx` (os dois
    painéis, os nomes dos tipos e os links, inclusive o da força bruta) e `src/paginas/terminais/Terminais.test.tsx`
    (o "Ciente" do divergente).
43. **Alertas de lacuna de eventos no detalhe do terminal** (SYNC 8.6; Fase 1C, C15; README da API › decisão 140).
    O `LACUNA_DECLARADA` (crítico: o caixa declarou perdidos os eventos de uma faixa, com a liberação de um supervisor
    com `pdv.config.fiscal`) e o `LACUNA_RECUPERADA` (aviso: os eventos reais voltaram e substituíram os placeholders)
    aparecem no detalhe e na listagem do terminal com só o **Ciente** (`terminais.gerenciar`; sem "Ver eventos com
    erro": não passam pela fila), com o exemplo do que conferir. O declarado fecha sozinho quando todos os eventos da
    faixa voltam; entra também no painel de alertas críticos do Dashboard ("Lacuna de eventos declarada" em
    `NOMES_ALERTA`). Teste em `src/paginas/terminais/Terminais.test.tsx` (o "Ciente" da lacuna).
44. **Relógio dos terminais: coluna, campo e alertas** (SYNC 12.4, 21.2, 21.3; ERP 12.2, 12.4; Fase 1C, C16; README da
    API › decisão 141). A listagem ganhou a coluna **Relógio** e o bloco Sincronização do detalhe troca o "Atraso do
    relógio" em segundos pelo mesmo componente (`DesvioRelogio` em `rotulos.tsx`): o desvio do último heartbeat até
    2 min só com o valor ("30 s"); acima, um selo âmbar e, acima de 5 min, vermelho, com o sentido ("6 min adiantado";
    desvio = servidor − local, positivo é o computador atrasado) e a dica por extenso; o selo "hora não confirmada"
    quando o caixa não tem amostra confiável desde que o computador ligou (`relogioConfiavel = false`); "—" sem amostra
    e no revogado. Os limites são os de `nivelDesvioRelogio` (`shared`), os mesmos do alerta, e o texto da duração é o
    `duracaoLegivel` do `shared`, o mesmo do título do alerta (a partir de 48 h em dias: "3 dias atrasado" nos dois).
    O selo leva `data-nivel` (`normal`/`aviso`/`critico`). Alertas: o
    `RELOGIO_SUSPEITO` (a hora de um evento não bate com a da nuvem) tem o **Ciente** (`terminais.gerenciar`, com o
    exemplo "data, hora e fuso do computador acertados"); o `RELOGIO_DESVIO` não tem botão (fecha sozinho com o
    relógio acertado) e, crítico, entra no painel do Dashboard ("Relógio do computador errado"). Na listagem os dois
    levam a "Ver o terminal" (não à fila de eventos). O alerta `info` (a regressão que o caixa marcou) sai em azul
    (`corDoAlerta`); a API já as manda somadas por terminal ("voltou N vezes") e o "Ciente" dessa linha fecha todas.
    Testes em `src/paginas/terminais/Terminais.test.tsx` (o `<DesvioRelogio>` sozinho em cada faixa — normal sem selo,
    âmbar acima de 2 min, vermelho acima de 5 min, conferindo o `data-nivel` e a cor que o Mantine grava no selo, e os
    dias a partir de 48 h; a coluna com o nível crítico, o sentido, o "hora não confirmada" e o valor normal; no detalhe,
    o "Ciente" só no suspeito, o desvio crítico e a resolução enviada).

45. **Implantação › Prontidão da loja** (implantação do piloto, I5; README da API › decisão 143). Item novo no grupo
    Cadastros do menu, "Implantação › Prontidão da loja" (`/cadastros/implantacao/prontidao`), com `configuracoes.ver`
    (o gerente e o administrador já têm): só leitura, o seletor de loja (da URL, do contexto do cabeçalho ou a primeira
    ativa permitida), o resumo em faixa verde ("pronta para vender") ou vermelha ("faltam N itens"), com os contadores
    ok/avisos/faltas e a hora da conferência, e os grupos da API (Empresa, Loja e caixas, Usuários e liberações,
    Formas de pagamento, Catálogo, PDVs / Terminais, Operação da nuvem) com o ícone da situação (vermelho, âmbar,
    verde), a mensagem e o link da tela que resolve ("Resolver"; "Abrir" no ok; nenhum quando a solução está fora do
    ERP, como o backup da VPS). Dentro do grupo, falta antes de aviso antes de ok; "Só o que falta resolver" (na URL,
    `pendencias=1`) esconde os ok; "Conferir de novo" refaz a consulta (sem atualização automática: a tela é
    conferida de propósito no D-1 e no dia D, `docs/implantacao/roteiro-piloto.md`). No cadastro da loja (aba Dados,
    fora do CD), o bloco **PIX do recebedor (QR no caixa)**: chave, nome (até 25) e cidade (até 15) — o que a regra
    `formas.pix` pede. Os três campos só ficam editáveis com `lojas.editar_pix` (README da API › decisão 144; só o
    Administrador no seed): sem ela, ficam travados com a explicação e o resto da loja segue editável com `lojas.editar`.
    Sem `terminais.ver`, a Prontidão mostra o grupo PDVs / Terminais com um aviso só, sem o estado dos caixas.

46. **Tipos sem suporte no produto** (Fase 2, F2-B1; README da API › decisão 145; roadmap D43, **decidida pelo
    dono: complementos sim, variações não**). O select "Tipo" do formulário lista só os tipos de `GET /produtos/tipos-habilitados`
    (`useTiposProdutoHabilitados`; sem resposta da API vale o padrão do catálogo, com os dois tipos travados, nunca a
    lista inteira; guardada por 5 min, mas gravar uma dessas chaves em Configurações invalida a lista na hora): na criação e na cópia (Duplicar) não aparecem "Com variações" nem "Com complementos" enquanto as
    chaves `produtos.*_habilitados` estiverem desligadas; na edição aparece também o tipo gravado, e o tipo travado
    vindo da cópia de um legado mostra o motivo no próprio campo. O legado abre com o aviso "Tipo sem suporte nesta
    versão": no "Com variações", trocar para Simples antes da atualização do PDV que recusa produto com variações
    (F2-B34) — o select fica liberado mesmo com movimento, porque o legado sem grade troca como Simples (a API recusa
    se houver variação ativa); no "Com complementos", que o caixa continua vendendo sem os complementos (PDV 10.2).
    A listagem ganhou "Situação de cadastro = Tipo sem suporte" (vem de `SITUACOES_CADASTRO_PRODUTO`). As duas
    chaves aparecem em Configurações › Geral › Produtos como "módulo futuro", com a ajuda do que ligar cada uma faz.
    Testes em `Produtos.test.tsx` (o select da criação sem os dois tipos; o legado com o tipo gravado, o aviso e a
    troca liberada com movimento).

47. **Estoques permitidos no usuário e nos seletores** (Fase 2, F2-B5; README da API › decisão 149; roadmap D45,
    **padrão até a confirmação do dono**). Os seletores de estoque (Acertos, Saldos, Lojas, Usuários) leem
    `GET /estoques`, que já devolve só os estoques permitidos (Master e `estoques.todos`, todos): nenhuma tela filtra
    por conta própria. No formulário do usuário, o campo passou de "Estoques adicionais permitidos" para **Estoques
    permitidos** (a lista inteira do que o usuário vê e movimenta, inclusive o CD; some para o Master), com a contagem
    dos estoques que o editor não vê e que continuam liberados. Como liberar a loja não libera mais o estoque dela, ao
    **marcar uma loja** o estoque dela entra na lista (se o editor o vê), e o gerente pode tirá-lo; desmarcar a loja
    não mexe nos estoques. Teste em `usuarios/FormularioUsuario.test.tsx` (só os estoques que a API devolve; a loja
    marcada traz o estoque dela e a loja sem estoque visível não traz nada).
    O campo do usuário busca **ativos e inativos** (`situacao=todos`): o inativo que o usuário já tem aparece como
    "Nome (inativo)" e fica na lista (pode ser tirado), e o inativo que ele não tem não é oferecido; ao mexer no campo,
    os ids que não são opção continuam no formulário. Assim a contagem "a que você não tem acesso" vale só para o que a
    API não devolve ao editor, e gravar sem tocar no estoque inativo não o retira do usuário (antes o seletor só via os
    ativos, e a primeira mudança no campo o apagava em silêncio). Os testes do mesmo arquivo cobrem a edição (inativo,
    contagem, PUT com o oculto e o inativo) e o Master sem o campo; `estoques/Acertos.test.tsx` cobre o seletor do
    acerto (sem o estoque da loja de contexto, o padrão cai no primeiro permitido) e os filtros de Acertos e Saldos.
48. **Lote no acerto e a chave da saída sem lote** (Fase 2, F2-B6; README da API › decisão 151; roadmap D48, **decidida
    (dono, 05/11/2026): mantém o padrão**, a venda sem lote baixa por FEFO). A tela de acertos ainda não escolhe lote (o bloco Validade/lotes do produto é do
    F2-B17), mas o item gravado com lote (pela API) aparece com "Lote <código>" abaixo do produto e o `loteId` volta no
    salvar enquanto o produto da linha for o do lote: editar o rascunho não tira o lote do item (trocar o produto da
    linha tira). Configurações › Geral › Estoque ganhou **"Saída sem lote de produto com lote"**
    (`estoque.lote_baixa_sem_informar`): "Baixar dos lotes, o que vence primeiro (FEFO)" (padrão) ou "Não baixar o saldo
    por lote". Teste em `estoques/Acertos.test.tsx` (o rascunho com item de lote mostra o lote e o PUT o devolve).
49. **Tipo de Estoque editável** (Fase 2, F2-B7; ERP 13.6; README da API › decisão 152; roadmap D55, **decidida pelo
    dono em 05/11/2026**). `/estoque/tipos` virou cadastro (`cadastro('/estoque/tipos', 'tipos_estoque', …)`): a
    listagem continua a tabela inteira (o mesmo `GET /tipos-estoque` dos seletores, poucos registros, sem paginação),
    com o nome como link e **Novo tipo** para quem tem `tipos_estoque.criar`, e o formulário `/estoque/tipos/:id` usa o
    `useCadastro` (versão, 409, Histórico). A coluna **Uso** passou a sair da **chave de sistema** e não do nome (a chave
    derivada do nome procurava `'avariado'`, que nunca casava com o `'avaria'` do seed, e quebraria com o tipo
    renomeado); os tipos da empresa mostram "—". De onde o caixa vende **não** vem da chave: o tipo marcado como padrão
    (qualquer que seja) ganha "as vendas do caixa baixam deste tipo" no Uso, e o Disponível é só "o padrão de fábrica".
    As travas da API aparecem como chaves desabilitadas: o tipo padrão não se desmarca (só marcando "Padrão" em outro),
    e marcar "Padrão" liga e trava "Vendável" e "Ativo" (desmarcá-lo antes de salvar devolve os dois valores de antes);
    o "Vendável" do Disponível e do Vasilhame vazio não muda, o Vasilhame vazio não se inativa e **nunca é o padrão** (o
    "Padrão" fica desabilitado nele: padrão é sempre vendável, e a API recusaria com o erro num campo travado); as
    mesmas regras (`errosRegraTipoEstoque`) são conferidas antes do PUT, com o erro no campo; **Excluir** só aparece no
    tipo da empresa que não é o padrão (a API recusa o já usado). Antes de salvar, a tela **avisa**: marcar outro padrão
    ("as vendas futuras do caixa e os documentos sem tipo passam a baixar deste tipo, e \"Disponível\" deixa de ser o
    padrão") e mudar o "Vendável" ("o saldo deste tipo passa a descer para o caixa" / "deixa de descer, só com saldo
    zero"), as duas com os PDVs de todas as lojas ressincronizando o estoque; depois de salvar, a notificação diz
    quantos PDVs foram avisados (`terminaisRessincronizados`). Tipo novo nasce **não vendável**. A gravação e a
    exclusão (`aoExcluir` do `useCadastro`) invalidam também a lista dos seletores (`['opcoes', 'tipos-estoque']`) do
    acerto e dos saldos, e o padrão gravado invalida o detalhe em cache dos outros tipos (o anterior perdeu a marca e
    mudou de versão: sem isso, voltar a ele mostrava o padrão velho e salvar dava 409). Teste em
    `estoques/TiposEstoque.test.tsx`.
50. **"Mudar tipo" no acerto** (Fase 2, F2-B8; ERP 13.5, 13.6; README da API › decisão 153). O tipo de ajuste ganhou a
    quarta opção, **Mudar tipo**: o seletor do tipo vira **Tipo de origem** e aparece o **Tipo de destino** (obrigatório,
    sem a origem nas opções), a coluna do saldo vira "Saldo na origem" e o custo e os totais são os da Saída (o custo
    médio da origem). Com origem vendável e destino não vendável, um aviso diz que a quantidade sai do saldo que os PDVs
    vendem. O destino só vai à API na mudança de tipo (trocar o tipo de ajuste esconde o campo e não o manda), e o
    contrato recusa a falta dele antes do POST. Os seletores de tipo passaram a manter na lista o tipo gravado mesmo
    inativo (o acerto antigo mostra o nome dele). O cabeçalho fecha cada linha em 12 colunas: a primeira (estoque, tipo
    e tipo de ajuste) não muda com o tipo de ajuste, então o controle não sai do lugar ao escolher "Mudar tipo", e o
    destino abre a segunda linha, com a data, o motivo e o responsável estreitados para caber. Testes em `estoques/Acertos.test.tsx` (o destino exigido, o aviso, o
    corpo com origem e destino, e a Entrada sem o destino).
51. **Importar contagem, folha de contagem e lote na grade do acerto** (Fase 2, F2-B9; ERP 13.5; README da API ›
    decisão 154). No "Definir" em rascunho já salvo, **Importar contagem** abre o modal do arquivo do coletor ou da
    planilha (CSV/TXT, `código;quantidade`), com "Produto que já está no rascunho: Somar / Substituir" (padrão Somar) e
    "Zerar os não contados" (desligada): **Ver prévia** manda o arquivo sem gravar e mostra os totais, os avisos (a
    divisão acima de 5.000 itens, o que foi somado), a tabela "Não entram no rascunho" (ambíguo com os produtos, não
    encontrado, combo, variação e linha inválida, com as linhas do arquivo) e a dos itens (os códigos lidos com o
    fator do fardo, o lido em unidades, o que o rascunho tinha e o contado que fica; com divisão, ou com o produto que
    já estava noutro rascunho da mesma contagem, a coluna "Rascunho": "Este", "Novo N" ou o Nº do outro, onde a soma é
    gravada); os avisos trazem também o cabeçalho ignorado, o `1.000` lido como decimal (pode ser milhar) e os
    produtos com leitura recusada que o "Zerar" não zera. **Gravar no rascunho** manda o mesmo arquivo com a versão do
    acerto, recarrega o formulário e, na divisão ou com outro rascunho alterado, avisa os números (a notificação fica
    até ser fechada). Mudar o arquivo ou uma opção descarta a prévia. As
    tabelas desenham até 200 linhas (a gravação leva o arquivo inteiro). **Imprimir** (com o estoque escolhido, em
    qualquer situação) abre o modal da folha: cega (padrão) ou com o saldo, ordem por localização ou nome, marca e
    categoria; "Abrir para imprimir" abre `/estoque/folha-contagem` numa aba nova (`estoque_acertos.ver`), que chama a
    impressão do navegador assim que os dados chegam, com a coluna "Contado" em branco e a linha de assinatura; o
    cabeçalho e o menu não saem no papel. A grade ganhou a coluna **Lote** na Entrada, na Saída e na mudança de tipo,
    quando algum produto da grade tem lote no estoque (ou a linha já tem): o lote do produto com validade e saldo, ou
    "Sem lote" ("Sem lote (FEFO)" na saída); fora do "Definir" o mesmo produto pode vir em mais de uma linha (um lote em
    cada), e os itens gravados passaram a ser casados pelo id do item. Testes em `estoques/Acertos.test.tsx` (a prévia,
    com o produto somado no outro rascunho Nº 9, os campos do multipart e a gravação com a versão; o botão só no "Definir" em rascunho e a folha aberta com as
    opções; a folha cega sem a coluna de saldo e a com saldo, e a impressão chamada; o lote escolhido indo no PUT).
52. **Aba "Compensações" no acerto** (Fase 2, F2-B10; ERP 13.1.5 regra 4; README da API › decisão 155;
    `estoques/CompensacoesAcerto.tsx`). O acerto efetivado ou estornado ganhou a aba **Compensações** (com o número
    no rótulo; no rascunho não aparece): sem nenhuma, um texto explica quando elas surgem; com elas, duas tabelas, os
    movimentos anulados por este acerto e os deste acerto anulados por outro "Definir" (com o link para ele). Cada linha
    tem a hora do fato, o produto e o lote, a quantidade compensada, o custo (só com "Ver custo"), o movimento
    compensado com o documento (link para a venda com `vendas.ver`, e para o acerto), o terminal (link para o PDV com
    `terminais.ver`, e o nº do evento; "ERP" no fato do ERP), quando a nuvem o recebeu, o relógio e a situação
    ("Valendo" ou "Estornada", com a data, o acerto e o motivo na dica; quando outro "Definir" compensou o fato de novo
    no estorno, "Compensado de novo pelo Acerto Nº 5", com o link, porque o movimento continua anulado e o texto da aba
    diz isso). O relógio suspeito pinta a linha de laranja,
    mostra o selo "Suspeito" com os motivos e o desvio na dica, põe um aviso no topo da aba e o **marcador laranja na
    própria aba** (`comAviso` do `<FormularioEntidade>`, novo: a aba que pede atenção sem ser erro; o `comErro` continua
    vermelho e prevalece); a regressão marcada pelo caixa é o selo cinza "Corrigido", sem destaque, e o desvio grande
    com a hora confiável é "Confiável" com o desvio na dica ("a hora do fato já foi corrigida por ele"; a API só conta
    o desvio sem a hora confiável). Acima de 5.000, a aba avisa que mostra as primeiras. Testes em
    `estoques/Acertos.test.tsx` (a aba com o marcador, o aviso, os links, o custo, a linha suspeita com a dica, a
    recebida estornada; o aviso "Mostrando as primeiras 2 de 6.000", o "Corrigido" e o desvio corrigido sem destacar a
    linha nem a aba, a estornada com o link para a substituta; sem compensações, sem "Ver custo" e sem os links; o
    rascunho sem a aba).
53. **Hora da contagem e CD na importação; aba "Conferência" no acerto** (Fase 2, F2-B11; README da API › decisão
    156; roadmap D46 e **D47, decidida pelo dono em 05/11/2026 (ajustável)**; `importacao/Importacao.tsx`,
    `estoques/ConferenciaAcerto.tsx`). Na **Importação** de produtos, "Atualizar estoque" abre dois campos: **Estoque
    que recebe a contagem** (os estoques permitidos; vazio = o da loja; o sem loja aparece como "(sem loja)") e
    **Data/hora da contagem** (obrigatória, sem padrão: a hora da exportação do Nuvem3 ou da contagem, com os atalhos
    "Agora", "Hoje, 07:00 (antes de abrir)" e "Ontem, 23:00 (depois de fechar)" no calendário). Com um estoque
    escolhido a **Loja** fica opcional (a descrição avisa: só para o preço da loja e o estoque mínimo); sem a hora, o
    "Pré-visualizar" fica desabilitado. Mudar o estoque ou a hora descarta a prévia. O resultado lista todos os acertos
    gerados (acima de 5.000 produtos, mais de um) e lembra a aba "Conferência". O **acerto "Definir"** com itens
    gravados (rascunho ou efetivado; o estornado não) ganhou a aba **Conferência**: o veredito ("Conferido" verde ou
    "Fora da tolerância" vermelho), os totais a custo (contado, sistema, a diferença com sinal e a soma dos módulos,
    só com "Ver custo"), a diferença total em % com o limite e quantos itens passam do limite por item; a tabela com o
    contado, o sistema na hora da contagem (com o compensado das vendas tardias, quando há), a diferença, o %, o custo
    e a diferença a custo, com os itens fora em vermelho e primeiro; no rascunho, o aviso de estimativa. Os campos
    **Tolerância total (%)** e **Tolerância por item (%)** (vazios = o configurado, mostrado no placeholder) e
    **Recalcular** trocam os limites só na consulta. Para isso o `<FormularioEntidade>` ganhou a aba **`consulta`**,
    que fica fora do `fieldset` desabilitado do documento somente leitura (os campos da consulta funcionam no acerto
    efetivado). As tolerâncias estão em **Configurações › Geral › Estoque** ("Conferência: tolerância total/por
    item"). O `simularApi` dos testes passou a guardar o `FormData` do multipart em `corpo`. Testes em
    `estoques/Acertos.test.tsx` (o veredito, os totais, o item fora destacado com o compensado, os limites da consulta
    na query e o "Conferido"; o rascunho estimativa sem custo; a Entrada e o estornado sem a aba) e
    `importacao/Importacao.test.tsx` (a hora obrigatória pelo atalho, indo na confirmação; o CD sem loja, com o estoque
    e a hora no multipart e os dois acertos no resultado).
54. **Formulário do produto: categorias em árvore, relacionados e "Ajustar"** (Fase 2, F2-B12; ERP 8.2.7, 8.2.8,
    8.2.11; README da API › decisão 157; `produtos/BlocosProduto.tsx`). **Categorias**: no lugar do MultiSelect, a
    árvore (`montarArvoreCategorias`) com checkboxes, a **estrela** da principal ao lado de cada marcada e a busca
    (abre o caminho até o resultado). A primeira marcada vira a principal; desmarcar a principal passa a estrela à
    próxima marcada (como o MultiSelect fazia). Abre expandida até as marcadas; o resto, recolhido. **Nova
    categoria** (com `categorias.editar`) abre o modal com o nome e a categoria pai (até a profundidade máxima) e cria
    pelo `POST /categorias` da tela de categorias; a nova já vem marcada, com o caminho aberto. **Produtos
    relacionados** (bloco novo, depois de Categorias): Inserir (o `<SeletorProduto>` sem o próprio produto, o tipo
    Sugestão/Substituto/Acessório e "Criar relação inversa"), a grade com o tipo editável por linha, "Nos dois
    sentidos" quando o outro já aponta para este **com o tipo gravado** (`tipoGravado` da linha: trocar o tipo é
    excluir e incluir na API, e a inversa do tipo antigo não vale para o novo, então a linha volta a oferecer o
    checkbox "Criar relação inversa") e Remover; o mesmo produto com o mesmo tipo não entra duas vezes. A inversa
    altera o outro produto: sem `produtos.editar` o checkbox não aparece (a linha diz "Só neste sentido") e a API
    recusa. O erro da lista inteira (o teto de 50) aparece acima da grade, e o da inversa recusada (o outro produto
    já tem 50), no checkbox da linha. O formulário manda sempre a lista inteira (`paraCorpo`); o Duplicar
    copia os relacionados só neste sentido. **Estoque**: o botão **Ajustar** (com `estoque_acertos.criar`, no produto
    gravado) abre o modal com o estoque (os permitidos e ativos; padrão: o do primeiro saldo **que está nas opções**,
    pois os saldos trazem também o estoque inativo, ou o único), o tipo de estoque (padrão: o Disponível), o **saldo
    atual** do estoque × tipo, a **nova quantidade**, o motivo (as sugestões do acerto) e a **hora da contagem**
    (padrão: agora). O modal fica montado no bloco: a hora é renovada a cada abertura e, se o usuário não mexer nela,
    o POST vai **sem** `dataContagem` e a API usa o instante da requisição (a hora da tela, cortada no minuto ou da
    abertura, descontaria da contagem as vendas feitas até o clique). Valida pelo `ajusteEstoqueProdutoSchema` antes de chamar a API;
    o sucesso avisa "Acerto Nº N efetivado: +X na contagem" e recarrega os saldos do bloco. No produzido, no serviço,
    no "Com variações" e no produto sem controle de estoque (o tipo gravado), o bloco diz por que não há ajuste, sem
    o botão; no combo continua só a tabela dos montáveis. Testes em `produtos/BlocosProduto.test.tsx` (2 categorias
    com a principal pela estrela no PUT, a estrela que passa à próxima, a "Nova categoria" criada e marcada; o
    relacionado nos dois sentidos, a inserção com a inversa, a remoção e a lista no PUT, o repetido recusado, a troca
    de tipo que tira o selo e manda a inversa, sem `produtos.editar` sem o checkbox, os erros da lista e da inversa;
    o Ajustar com o POST sem `dataContagem` e o saldo recarregado, a hora da abertura com o relógio avançado entre a
    montagem, o fechamento e a reabertura, o estoque padrão fora do inativo, a validação sem chamar a API, o
    produzido e o usuário sem a permissão sem o botão).
55. **Bloco Fornecedores no produto, `<SeletorPessoa>` e cadastro rápido de fornecedor** (Fase 2, F2-B13; ERP 3.4,
    8.2.14, 13.3; README da API › decisão 158; `produtos/BlocosProduto.tsx` › `BlocoFornecedores`,
    `componentes/seletores/SeletorPessoa.tsx`, `componentes/CadastroRapidoFornecedor.tsx`). **Bloco** (depois de
    Produtos relacionados) só com `geral.produto_usa_fornecedores` ligada, lida em `useUsaFornecedores` da mesma
    consulta dos tipos habilitados (`GET /produtos/tipos-habilitados` › `usaFornecedores`; Configurações a invalida ao
    gravar a chave). **Escondido, o corpo não leva `fornecedores`** (`paraCorpo(v, { comFornecedores })`) e a API mantém
    os vínculos: desligar a chave não apaga o que a NF-e aprendeu. Inserir (o `<SeletorPessoa categoria="fornecedor">`;
    o primeiro vínculo nasce principal) e a grade com código no fornecedor, EAN, unidade de compra, fator, o **custo do
    fornecedor** (só com `produtos.ver_custo`, na unidade do produto; D49), o último custo e a última compra (só
    leitura, vêm da compra), o principal (marcar um desmarca os outros) e Remover. O fornecedor da linha mostra o selo
    "inativo" ou, quando a pessoa foi excluída depois do vínculo, "excluído" (`excluida` do `PessoaOpcao`; a linha
    continua gravável e volta inteira no PUT, README da API › decisão 158). **Usar como preço de custo** (o ícone R$ ao
    lado do custo, fora do combo, cujo custo é calculado) preenche o preço de custo do Cabeçalho e recalcula o markup
    com o preço atual, como o Cabeçalho faz ao mudar o preço; a gravação é a de sempre (com o histórico de preços). O
    **409** do código já ligado a outro produto cai no campo da linha ("Já ligado ao produto N - nome") e, com
    `produtos.editar`, a linha oferece **Mover o vínculo para este produto**, que marca `moverVinculo` (a linha avisa
    "Sai do outro produto ao gravar"; editar o código desfaz). O Duplicar copia o fornecedor, a unidade, o fator e o
    custo, **sem** o código e o EAN do fornecedor (o mesmo código na cópia seria o 409), um vínculo por fornecedor (sem
    o código, CX 12 e CX 24 do mesmo fornecedor seriam o mesmo; fica o principal, que vem antes) e sem o histórico de
    compra. **`<SeletorPessoa>`** (ERP 3.4): busca a partir de 2 caracteres no `GET /pessoas` (até 20 ativas, filtradas
    pela categoria), pelo nome/apelido/código ou, quando o termo tem cara de documento, pelo CPF/CNPJ sem a máscara; sem
    `pessoas.ver` avisa na lista. Com a categoria Fornecedor e `pessoas.criar_fornecedor`, `pessoas.criar` ou
    `pessoas.editar`, o **"+"** abre o
    **cadastro rápido** (o documento digitado na busca já vem no campo): CNPJ ou CPF, nome, fantasia, IE, telefone e o
    endereço opcional (o `<CamposEndereco>`; a UF só entra com ele), validado pelo `cadastroRapidoFornecedorSchema`
    antes da API; a resposta avisa se cadastrou, se a pessoa já existia e passou a ser fornecedora, ou se já era
    fornecedora, e já escolhe a pessoa no seletor. O perfil Estoquista do seed vê o "+" desde a decisão do dono de
    05/11/2026 (ganhou `pessoas.criar_fornecedor`, o cadastro rápido, README da API › decisão 165, e depois também
    `pessoas.criar`, o cadastro completo de pessoas, decisão 168). Testes em `produtos/Fornecedores.test.tsx` (escondido sem a chave e o PUT sem a lista; o vínculo
    X com "CX24-ABC" e fator 24, o principal único e a lista inteira no PUT; o 409 na linha (com os `detalhes` no
    formato real, `DetalhesConflitoFornecedor`) e o "Mover o vínculo" no segundo PUT; o fornecedor excluído com o selo e
    a linha inteira no PUT; o custo levado ao preço de custo com o markup; sem `produtos.ver_custo` sem as colunas de
    custo; o "+" com a validação local, o POST e a pessoa escolhida; só com `pessoas.criar_fornecedor` com o "+", sem
    nenhuma das três sem o "+"; o Duplicar com um
    vínculo por fornecedor e o corpo sem a lista com o bloco escondido).
56. **Recebimento manual: telas, cadastro rápido de produto e espelho** (Fase 2, F2-B16; ERP 13.3, 3.3, 3.7; README da
    API › decisões 159–161; `paginas/estoques/Recebimentos.tsx` (listagem e formulário), `recebimentoItens.ts` (as
    contas e regras da grade, sem React), `RecebimentosEspelho.tsx`, `componentes/CadastroRapidoProduto.tsx`; menu
    "Recebimento manual de produtos" pronto). **Listagem** `/estoque/recebimentos` com os filtros da ERP 13.3
    (Fornecedor — a lista dos fornecedores, com `pessoas.ver` —, Id, Cód. remessa, Estoque, período e "Movimentado?") e
    as colunas Fornecedor (o link), Data, Cód. remessa, Movimentado?, Id, Estoque e Total. **Formulário**
    `/estoque/recebimentos/:id`: Fornecedor (`<SeletorPessoa categoria="fornecedor">` com o "+" do cadastro rápido,
    decisão 55), Loja (a de contexto ou a primeira permitida que não é de treino), Estoque de destino (o vinculado à
    loja; troca junto com a loja enquanto não for escolhido à parte — a nota em nome de uma loja pode entrar no CD, D6),
    Tipo de estoque (o padrão), Data (hoje; a API confere no fuso da loja), Cód. remessa, Frete, Outras despesas,
    Desconto, "Tem prazo de validade" e Observações; "Gerar financeiro?" **escondido** até a Fase 4. Os **dados de
    compra** da grade (`GET /recebimentos/dados-produtos`, decisão 161 da API) são lidos em blocos de 100 produtos
    (`dadosCompraEmBlocos`; o recebimento aceita 990 itens e o contrato, 200 ids por consulta) e juntados; os anteriores
    ficam na tela enquanto a consulta com o produto novo responde (`keepPreviousData`), e o Salvar e o "Salvar e
    movimentar" esperam os novos (o botão fica carregando): sem eles, a base do markup, o lote obrigatório e o preço da
    loja cairiam no padrão sem aviso. Se a consulta falhar, um aviso com "Tentar de novo" aparece no topo e o
    recebimento não é gravado. **Grade**
    (`<GradeItens>`): Produto ou código de barras (o `<SeletorProduto>` só com os tipos com saldo próprio; agora
    devolve também o **termo digitado**: o código lido que é de uma **embalagem de compra** do produto — o fardo, pelo
    `GET /recebimentos/dados-produtos` — preenche a Embalagem e o Fator; o EAN lido põe a quantidade 1, ERP 3.3),
    Embalagem (a unidade do produto ou as embalagens de compra), Fator (o da embalagem, só leitura; digitável sem ela,
    a caixa sem EAN), Quant., No estoque (quantidade × fator), Preço compra, Total, **Rateio** (frete + outras −
    desconto) e **Custo final** — as mesmas contas do shared que a movimentação grava (`contasEntradaRecebimentoTexto`),
    então a tela mostra o R$ 5,10 do critério antes de movimentar —, **Markup % ⇄ Preço venda** (o preço proposto
    começa no preço atual **na loja do recebimento** — o próprio da loja, quando ela tem, ou o geral, como o movimentar
    compara o "só da loja" —; vale o último digitado: o markup refaz o preço e acompanha o custo final, o preço refaz o
    markup; a base é a de `produtos.custo_base_margem`, decisão 161, e a nota abaixo da grade diz qual), **Atualizar
    preço** (geral, só da loja ou não; o "Salvar" e o "Salvar e movimentar" **perguntam uma vez** para os itens com o
    preço diferente do atual na loja ainda sem resposta, e cada linha pode ser trocada depois; na loja com preço
    próprio, a pergunta avisa que o preço geral não vale nela. O "não" gravado **fica** ao reabrir — inclusive o dos
    itens com o preço igual, que vão como "não" —: só editar o preço ou o markup da linha a volta a "sem resposta" e
    à pergunta, então reabrir não pergunta de novo sobre o já respondido nem sobre o preço do produto mudado depois; quem
    não pode gravar o rascunho, só movimentar, nunca recebe a pergunta nem regrava) e Lote, Validade e Fabricação
    (`dd/mm/aaaa`) quando o
    cabeçalho pede validade, o produto pede lote no PDV ou já tem lote cadastrado. A linha fica vermelha com o erro
    (local ou da API, casado pela posição entre as linhas preenchidas; as vazias não vão no corpo). **"Cadastrar novo
    produto"** (com `produtos.criar`) abre o modal reutilizável `CadastroRapidoProduto`: nome, EAN, unidade (UN), NCM
    pelo `<BuscaNcm>`, marca, categoria e preço de venda, gravado pelo `POST /produtos` como um Simples com controle de
    estoque e a tributação vazia (nada fiscal na Fase 2), o EAN repetido confirmado conforme `geral.ean_duplicado`; o
    produto entra na primeira linha sem produto. O modal aceita valores iniciais (`inicial`: nome, EAN, unidade, NCM,
    custo e preço) para a vinculação da NF-e (F2-B19). **Ações** por situação e permissão: Salvar (rascunho, com
    `recebimentos.criar`/`editar`), Excluir (rascunho), **Salvar e movimentar** (`recebimentos.movimentar`; confirma,
    grava o rascunho só se for novo ou alterado — nunca sem `recebimentos.editar`: quem só movimenta movimenta o que
    está gravado — e movimenta; no novo, a tela passa a ser a do rascunho gravado **antes** do movimentar, para o
    movimentar recusado (sem "Produtos: Alterar preço", lote, conflito, rede) não deixar a tela em "novo" e a nova
    tentativa gravar um segundo rascunho com os mesmos itens; a **pergunta do preço de custo** (D49) volta como 422 e
    abre o modal com cada produto, o preço de custo atual e o desta compra — Sim/Não repete o movimentar com a
    resposta), **Estornar** (movimentado, `recebimentos.estornar`, com o motivo obrigatório num modal que avisa que o
    preço não volta) e **Imprimir**: o **espelho** `/estoque/recebimentos/:id/espelho` em aba nova, pela impressão do
    navegador (o padrão "Impressão" do plano da Fase 2; sem o motor de PDF da ERP 3.7), com o cabeçalho, os itens
    (embalagem, quantidade no estoque, preço de compra, rateio, custo final, preço de venda e lote) e os totais. O
    aviso de **remessa repetida** aparece no topo com o link para os outros recebimentos e numa notificação ao gravar.
    Testes em `estoques/Recebimentos.test.tsx` (as contas da grade e o R$ 5,10; lote e validade obrigatórios; o novo
    com o código do fardo preenchendo embalagem, fator e quantidade, o rateio e o custo final na linha, o markup que
    refaz o preço, a pergunta do preço e o corpo do POST; "Salvar e movimentar" sem regravar o que não mudou, com a
    pergunta do preço de custo e a resposta no segundo movimentar; o "não" gravado com o preço diferente do atual, sem
    pergunta nem PUT, e a pergunta de volta ao editar o preço; só `recebimentos.movimentar`, sem pergunta nem PUT; o novo
    com o movimentar recusado (403) que passa à tela do rascunho gravado e não cria outro; a loja com preço próprio na
    proposta e no aviso da pergunta; a falha dos dados de compra com o aviso e sem gravar; a consulta em blocos, o preço
    atual na loja e o "não" que volta a "sem resposta"; os botões do movimentado, a remessa repetida e o
    estorno com motivo; sem `recebimentos.movimentar` nem `produtos.criar`, sem os botões; o cadastro rápido de produto
    pondo o produto na grade, com o corpo de `corpoProdutoRapido` do shared; a listagem; o espelho) e o e2e curto
    `e2e/fluxo-recebimento.spec.ts` (o recebimento de
    fardo de ponta a ponta, com o produto novo no formulário, a movimentação, o espelho e o saldo).
57. **Bloco Validade do produto: lotes e o saldo de cada lote** (Fase 2, F2-B17; ERP 8.2.12; README da API › decisão
    162; D57 do roadmap; `produtos/BlocosProduto.tsx` › `BlocoValidade`, `valores.ts` › `LoteForm`). **Bloco** depois
    de Estoque (8.2.11 → 8.2.12), fora dos **tipos sem saldo próprio** (`TIPOS_SEM_SALDO_PROPRIO` do shared: combo,
    serviço, produzido e "Com variações", a mesma lista que tira o "Ajustar" do bloco Estoque e que o recebimento
    recusa; sem estoque próprio, sem lote; nesses tipos o corpo não leva `lotes` e a API mantém o que houver). O
    **"Solicita lote no PDV"** saiu de Outras informações para o bloco (o recebimento exige lote e validade do produto; a
    escolha do lote no caixa é da Fase 3, e a descrição diz que até lá a venda sem lote segue Configurações › Geral ›
    Estoque › "Saída sem lote de produto com lote", com o padrão FEFO entre parênteses: com "Não baixar" o saldo por
    lote não muda com a venda, D48). **Incluir lote** abre uma linha com **Loja** (as lojas ativas cujo estoque o
    usuário pode ver — `/auth/eu` › `lojas[].estoqueId`, sem depender de `estoques.ver` —, mais "Todas as lojas"), Lote,
    Validade, Fabricação, Fornecedor (`<SeletorPessoa categoria="fornecedor">`, decisão 55) e Ativo; no lote gravado a
    Loja vira texto com **a loja e o estoque vinculado** em que o lote vale ("Loja 1 · Estoque Loja 1", mesmo sem
    saldo; o estoque sem loja só, ou "Todas as lojas"): **o estoque não muda depois de gravado** (excluir e criar
    outro; o 422 da API cai na linha). Abaixo de cada lote, somente leitura, o **saldo por estoque e tipo** do
    `GET /produtos/:id/saldos` › `lotes` (a mesma consulta do bloco Estoque, em cache), "Sem saldo" no gravado sem
    saldo; o selo "vencido" pela data do navegador. O **lote com movimento** (do detalhe, `temMovimento`) não tem
    "Remover" (o tooltip diz para inativar); o 422 da lista (o lote com saldo, movimento ou acerto em rascunho que saiu)
    aparece acima da grade. Os **gravados inativos** ficam atrás de "Mostrar os inativos (N)" (a linha com erro aparece
    sempre). **O corpo leva só o que mudou** (revisão do bloco): `LoteForm.original` guarda os campos do detalhe, e
    `paraCorpo` manda em `lotes` só os lotes novos e os alterados — mais o gravado sem mudança com a mesma (loja, lote)
    de um deles, para o zod apontar o repetido em vez de a API reaproveitar o gravado em silêncio — e em
    `lotesExcluidos` os ids que o "Remover" tirou; sem mudança no bloco, o corpo não leva lotes. Assim o produto com
    centenas de lotes criados pelo recebimento (o lote com histórico não sai, D57) continua gravável: o teto de 200 é
    do que muda numa gravação. `errosParaFormulario` traz a linha N do corpo de volta à linha da grade (também o
    "(linha N)" da mensagem do repetido) e o erro de `lotesExcluidos` para cima da grade. Resumo do bloco fechado:
    quantos lotes, o próximo vencimento entre os ativos e "pede lote no PDV". O **Duplicar não copia os lotes** (são
    da mercadoria do produto de origem). Testes em `produtos/Validade.test.tsx`, com o `Date` do navegador fixo em
    05/11/2026 (os lotes com a loja e o estoque só leitura, o saldo de cada lote, o vencido, a descrição da chave e o
    "Remover" desligado com movimento; o lote novo com a loja escolhida, a loja de estoque não permitido fora da lista,
    o "Solicita lote no PDV" e o PUT só com o novo e o excluído; os inativos escondidos e o repetido com um gravado sem
    mudança; o 422 na linha certa da grade e na lista; os tipos sem saldo próprio sem o bloco e sem a lista no corpo, a
    troca de preço sem lotes, a cópia sem lotes; 250 lotes gravados e um alterado passando no zod).
58. **Chave da assinatura da NF-e de entrada em Configurações** (Fase 2, F2-B18; ERP 9.1, 13.4; README da API ›
    decisão 163; roadmap D50, **decidida pelo dono em 05/11/2026**). Configurações › Geral ganhou o bloco **"NF-e de
    entrada"** com **"Assinatura do XML que não confere"** (`notas_entrada.assinatura_invalida`): "Avisar (quem importa
    confirma)" (padrão), "Recusar a nota" ou "Não conferir a assinatura". É a primeira chave do grupo `notas_entrada`
    (o `CamposConfiguracoes` pede os grupos pelas chaves exibidas, então a API passou a aceitar o grupo no filtro). As
    telas da NF-e (`/estoque/notas-entrada`) são do F2-B19.
59. **Recebimento de NF-e: upload por arrastar, listagem e a nota em abas** (Fase 2, F2-B19; ERP 13.4; README da API
    › decisão 164; D6 e D50 do roadmap). O menu "Recebimento de NFe" ficou pronto (`/estoque/notas-entrada`).
    **Listagem** (`ListaNotasEntrada`, `paginas/estoques/NotasEntrada.tsx`): no topo, com `notas_entrada.importar`, a
    área de upload (`EnvioNotasEntrada`, `NotasEntradaEnvio.tsx`) — arrastar e soltar ou "Escolher arquivos" (`.xml` e
    `.zip`, vários; o mesmo arquivo não entra duas vezes; tipo, até 100 arquivos e 20 MB conferidos antes de enviar), o
    "Estoque de destino" opcional (vazio = o estoque da loja do CNPJ do destinatário de cada nota) e "Importar NF" — e
    o aviso fixo "Sem consulta à SEFAZ…"; o resultado mostra cada arquivo (importada, já importada com o link para a
    nota existente — só quando o usuário vê a loja e o estoque dela —, recusada com o motivo, o fornecedor cadastrado
    pelo emitente e os avisos de assinatura/totais/rastro). O lote grande vira tarefa, e a **própria tela a acompanha**
    (`AcompanharTarefa`: `GET /tarefas/:id` a cada segundo até `concluida`/`falhou`, com o progresso e a mensagem da
    tarefa; no fim, a mesma `TabelaResultados` com `tarefa.resultado.resultados`, ou a mensagem da falha — ex.: quem
    pediu perdeu a permissão ou o estoque), como a importação de planilha; o ícone Tarefas do cabeçalho é do F2-B30.
    Os estoques da área de envio e do Destino da nota vêm do mesmo `useEstoques` (`NotasEntradaEnvio.tsx`), e o "20
    MB" das mensagens vem do shared (`TETO_UPLOAD_NFE_TEXTO`/`MENSAGEM_ENVIO_GRANDE_NFE`). Sem `@mantine/dropzone` (nenhuma dependência
    nova): a área usa os eventos de arrastar do navegador e o `FileButton`. A listagem tem os filtros Nome (emitente),
    Loja, Período (emissão ou recebimento), Datas, Situação e Número/Chave e as colunas da ERP 13.4, sem
    "Manifestação" e sem "Novo" (a nota só nasce do XML). **A nota** (`FormularioNotaEntrada`, rota `:id/:aba?`):
    "Ignorar nota" (modal com o motivo obrigatório) e "Reabrir" no cabeçalho, os avisos (assinatura, SEFAZ) e as
    abas **Dados da nota** (nota, emitente com o link para o fornecedor, totais, transporte, protocolo e assinatura, e o
    **Destino** editável — loja permitida, estoque e tipo — com a nota pendente ou pronta), **Duplicatas** (somente
    leitura; viram contas a pagar na Fase 4) e **XML** (formatado por `formatarXml`, uma marca por linha com recuo, e
    "Baixar XML" com o arquivo original). A aba "Itens e vinculação" é do F2-B20 (decisão 61) e movimentar/estornar do
    F2-B21.
    Testes: `NotasEntrada.test.tsx` (formatação do XML, as regras do envio, o upload com o estoque e o resultado com os
    links, o arrastar com o lote em tarefa acompanhada até o resultado de cada arquivo, a tarefa que falha com a
    mensagem, a tela sem a permissão de importar, as abas com a troca do destino e o
    download do XML original, e Ignorar/Reabrir com a versão).

60. **Respostas do dono de 05/11/2026 no recebimento e nas configurações** (Fase 2; README da API › decisão 165;
    roadmap D47 e D56). **Estorno com saldo negativo** (`Recebimentos.tsx`): o "Estornar" manda `confirmarNegativo:
    []`; o 422 com `campos.confirmarNegativo` (quem pode deixar negativo: Master ou "Permite saldo negativo no ERP")
    troca o conteúdo do modal pela lista de `detalhes.saldosNegativos` ("O saldo ficará negativo em:", cada produto e
    lote com o saldo de agora e o final) e "Estornar mesmo assim", que repete o pedido com **a lista mostrada** em
    `confirmarNegativo` (não um "sim" geral: a API só estorna se ela cobrir os saldos de agora). Se uma venda
    sincronizou e a conta mudou, o 422 volta com a lista nova: o modal a mostra com "O saldo mudou desde a
    confirmação… confirme de novo" e o próximo "Estornar mesmo assim" manda a lista nova. Sem a permissão a recusa
    aparece como antes, sem a confirmação. **Preço no recebimento**: com `podeAlterarPreco = false` nos dados de
    compra ("Altera Preço do Produto no ERP" = Não e sem `produtos.alterar_preco`), o markup, o preço de venda e
    "Atualizar preço" da linha ficam só leitura, o salvar não abre a pergunta "geral / só desta loja" e todo item vai
    com "Não" (`itemParaApi` com `podeAlterarPreco`), inclusive a linha de um rascunho gravado com "geral" ou "só da
    loja" por quem podia: a coluna mostra "Não atualizar", um aviso (`preco-descartado`) diz que a mudança gravada não
    será aplicada, e o "Salvar e movimentar" regrava o rascunho com "Não" antes de movimentar (sem isso a
    movimentação do gravado seria 403 e não haveria como trocar a resposta na tela). Quem só movimenta (sem
    `recebimentos.editar`) não regrava e movimenta o que está gravado, como antes. Enquanto os dados não chegam vale o
    padrão da chave (ligada), e quem grava espera os dados. **Tolerância da conferência (D47)**: conferido que as duas
    chaves aparecem e se editam em Configurações › Geral › Estoque e, por loja, em Lojas › Parâmetros (Herdar ×
    Personalizar); nada mudou na tela. **Cadastro rápido de fornecedor**: o "+" do `<SeletorPessoa>` aparece também
    com `pessoas.criar_fornecedor` (a permissão estreita do Estoquista). Na resposta seguinte do dono o Estoquista
    ganhou também `pessoas.criar` (README da API › decisão 168): a tela de Pessoas já mostrava o "Novo" e o formulário
    da pessoa nova com ela, e a pessoa gravada fica somente leitura sem `pessoas.editar`; nada mudou no código. Testes: `Recebimentos.test.tsx` (a lista e a
    confirmação, a lista que mudou e a segunda confirmação, a recusa sem permissão, o recebimento sem poder mudar o
    preço e o rascunho gravado com "geral" regravado com "Não" antes de movimentar), `Fornecedores.test.tsx` (o "+"
    só com `pessoas.criar_fornecedor`) e `Configuracoes.test.tsx` (as duas chaves no bloco Estoque, editáveis na
    empresa e na loja).

61. **Recebimento de NF-e: aba "Itens e vinculação"** (Fase 2, F2-B20; ERP 13.4.1, 8.2.14; README da API › decisão
    166). A nota ganhou a aba **Itens e vinculação** (`AbaItensNota`, `paginas/estoques/NotasEntradaItens.tsx`, com as
    regras sem React em `notasEntradaItens.ts`; a contagem "resolvidos/total" no título da aba e no bloco Itens da aba
    Dados). Cada item do XML mostra o código, a descrição, os EANs ("SEM GTIN" quando falta), o NCM, o CFOP (só o do
    XML) e as quantidades comercial e tributável, e ao lado o **produto** (`<SeletorProduto>` com os tipos que têm
    estoque próprio), a **origem** ("Vínculo anterior", "EAN da embalagem" ou "Manual"), a embalagem de compra do
    produto (o fator vem dela), o **fator** com "Fator confirmado" e a quantidade no estoque (qCom × fator), o custo de
    entrada por unidade (o mesmo cálculo do shared que o F2-B21 grava), o lote e a validade quando o item tem `rastro`
    ou o produto tem lote, e o preço de venda proposto com o **markup ⇄ preço** do recebimento (o último digitado vale,
    sobre a base de `produtos.custo_base_margem`, decisão 56; o preço atual na loja) e "Atualizar preço" (escondido e
    "Não" sem `podeAlterarPreco`, decisão 60). **Sem vínculo gravado, a sugestão da API vem preenchida e com o fator
    por confirmar** (decisão técnica deste bloco: o usuário confere cada fator; "Confirmar todos os fatores" marca de
    uma vez os itens com produto e um fator válido); escolher outro produto volta o fator ao da sugestão (quando é o
    produto dela), ao do vínculo aprendido ou ao qTrib/qCom da nota, e qualquer mudança no fator ou na embalagem tira
    a confirmação. **O fator apagado ou inválido não se confirma** (revisão do bloco): "Fator confirmado" fica
    desativado e "Confirmar todos" pula a linha, e a API recusa o vazio confirmado com "Informe o fator" (antes ele
    virava 1 confirmado: 10 CX entravam 10 UN). O **fator que diverge do vínculo aprendido** com o fornecedor fica com
    a borda laranja e "Vínculo anterior: fator X" (e o produto diferente do aprendido, com um aviso); sem essa
    divergência, o fator que **diverge das quantidades da própria nota** (qTrib/qCom ≠ 1, `fatorDivergeDaNota`) fica
    com a mesma borda e "Pelas quantidades da nota: fator X" (a caixa de 12 vinculada com fator 1, por exemplo, na
    primeira nota do fornecedor). "Ignorar item" pede o motivo num modal (o item ignorado mostra o motivo e
    "Desfazer", que devolve a linha como estava antes de ignorar, com o produto e o fator confirmado; só o item que já
    veio ignorado do servidor volta pela sugestão de agora, `desfazerIgnorar`); "+" ao lado do produto (com
    `produtos.criar`) abre o **Cadastrar novo produto** do
    recebimento (decisão 56) pré-preenchido com o item: nome, EAN da unidade (cEANTrib, senão cEAN), a unidade
    tributável, o NCM, o **CEST** (campo novo no modal, que só aparece quando quem abre o conhece) e o custo por
    unidade; o produto criado entra na linha com o fator por confirmar. "Salvar vinculação" manda todos os itens ao
    `PUT /notas-entrada/:id/itens` com a versão; os erros da API (`itens.N.campo`) aparecem no item, e a nota que fica
    pronta avisa "pronta para movimentar". A aba fica sempre montada (trocar de aba não perde o que foi digitado) e
    recomeça pelo gravado quando a versão da nota muda. Sem `notas_entrada.importar`, ou com a nota fora de
    pendente/pronta, tudo fica só leitura. Os dados de compra (embalagens, lote, saldo e custo médio, preço da loja) vêm
    de `GET /notas-entrada/dados-produtos`, em blocos (`dadosCompraEmBlocos` do recebimento). Movimentar e estornar
    são do F2-B21 (decisão 62). Testes: `NotasEntradaItens.test.tsx` (a linha a partir da sugestão e do vínculo gravado, a origem, o
    fator divergente do vínculo e o das quantidades da nota, o fator vazio que não se confirma, o "Desfazer", a troca
    do produto e o corpo do `PUT`; a aba com a origem, o custo e o destaque, "Confirmar todos os fatores", ignorar com
    motivo e gravar; o erro da API na linha certa (`itens.0` na cerveja, e não nas outras) e o fator editado que perde
    a confirmação; o fator apagado com a caixa e o "Confirmar todos" desativados; o "Desfazer" num item já vinculado
    que grava o produto e o fator confirmado; o "Cadastrar novo produto" com o nome, o EAN da unidade, o CEST e o corpo
    do `POST /produtos` com o NCM e o custo 4,0000; e a aba só leitura sem a permissão e com a nota movimentada, mesmo
    com `notas_entrada.importar`).

62. **Recebimento de NF-e: Movimentar e Estornar** (Fase 2, F2-B21; ERP 13.4; README da API › decisão 169). O
    cabeçalho da nota ganhou as ações (`AcoesMovimentacaoNota`, `paginas/estoques/NotasEntradaMovimentar.tsx`), com as
    mesmas perguntas do recebimento manual (decisões 56 e 60): **Movimentar** (com `notas_entrada.movimentar`) aparece
    na nota aberta e só fica ativo na **"pronta"** (na pendente, desabilitado com a dica de vincular ou ignorar todos os
    itens); confirma num modal (o estoque de destino, os itens a lançar e os ignorados, e que entra o que está
    **gravado** na aba de itens) e, quando o custo da nota muda o preço de custo de algum produto (D49), abre "Atualizar
    o preço de custo?" com o atual e o desta nota ("Sim, atualizar" / "Não, manter"). **Estornar** (com
    `notas_entrada.estornar`, na movimentada) pede o motivo e, quando o estorno deixaria saldo negativo e quem estorna
    pode deixar (Master ou "Permite saldo negativo no ERP", D56 com aviso), mostra a lista "O saldo ficará negativo
    em…" e "Estornar mesmo assim" devolve a lista mostrada (se a API perguntar de novo, a lista nova e o aviso "o saldo
    mudou"). Abaixo do título, "Movimentada em … por …" e, na estornada, "Estornada em … por …: motivo"; o erro da ação
    aparece num alerta abaixo do cabeçalho. Na aba **Itens e vinculação**, a nota movimentada mostra o **custo gravado**
    (o das chaves de quando a nota entrou, `custoUnitario`), e não a prévia pelas chaves de agora; e o item com mais de
    um lote no `rastro`, com o lote sugerido mantido, avisa "Entra em N lotes do rastro: …" com a parte de cada lote (a
    mesma divisão da API, `partesLoteRastroNfe` do shared; trocar o lote tira o aviso). Testes: `NotasEntrada.test.tsx`
    (o "Movimentar" desabilitado na pendente e ausente sem a permissão; a pronta confirmada com a pergunta do preço de
    custo e os dois corpos, `atualizarPrecoCusto` nulo e depois `true`, e quem movimentou; o erro da movimentação no
    alerta; o estorno com o motivo obrigatório, a lista do saldo negativo e o corpo com a lista confirmada, e a
    estornada sem "Estornar") e `NotasEntradaItens.test.tsx` (o custo gravado da movimentada e o aviso da divisão pelo
    rastro, que some com o lote trocado).
    Na revisão do bloco: o **erro por item** do Movimentar (422/403 em `itens.N.campo`: o lote já cadastrado com outra
    validade, a embalagem que deixou de ser de compra, o produto que passou a pedir lote, o código do fornecedor ligado a
    outro produto sem "Produtos: Editar") deixou de virar só "Verifique os itens destacados": o alerta lista "Item
    <nItem>: <mensagem>" de cada item apontado (`erroAcaoNota`, com o número do item na nota, não a posição) e a aba
    Itens e vinculação destaca o campo na linha, como no erro do "Salvar vinculação" (`errosAcao` da `AbaItensNota`,
    até a linha ser alterada). A pergunta do preço de custo e a confirmação do saldo negativo no estorno passaram a ser
    um componente só para o recebimento e a NF-e (`paginas/estoques/ConfirmacoesEntrada.tsx`: `PerguntaPrecoCusto`,
    `ConfirmacaoNegativoEstorno` e `useConfirmacaoNegativo`; o texto muda só em "desta compra"/"desta nota"), para a
    regra D49/D56 não divergir entre as duas telas; o teste do "o saldo mudou" do recebimento cobre as duas. Teste:
    `NotasEntradaItens.test.tsx` (o 422 com `itens.0.validade` e `itens.1.produtoId`: o alerta com "Item 7: …" e
    "Item 2: …" e as duas linhas destacadas).

63. **Transferência: "Em trânsito" e "Divergência a tratar" no produto e nos saldos** (Fase 2, F2-B26; ERP 8.2.11,
    16.4; README da API › decisão 174). O bloco **Estoque** do produto (`BlocoEstoque` em `FormularioProduto.tsx`) e a
    tela **Saldos de estoque** (`paginas/estoques/Saldos.tsx`) ganharam a coluna **Em trânsito** (o enviado para o
    estoque e ainda não recebido) e a **Divergência a tratar** (a diferença recebida a menor ainda sem tratamento, na
    linha da **origem**, em laranja), com "—" quando zero (quase toda linha não tem pendência). No produto, a
    "Divergência a tratar" só aparece quando alguma linha a tem; o "Em trânsito", sempre. A linha do estoque que ainda
    não tem saldo lançado mas tem mercadoria a caminho vem da API com saldo zero (aparece no produto e na lista). Os
    estoques permitidos e o tipo de estoque de cada linha são os da API (a tela não filtra de novo); o "Ajustar" continua
    pelo saldo, sem contar o em trânsito. A chave `estoque.transferencia_alerta_dias` ("Alerta de transferência parada
    (dias)", Configurações › Geral › Estoque, inteiro) entrou em `rotulos.ts`. Testes: `BlocosProduto.test.tsx` (60 a
    caminho da Loja 2 sem saldo e 10 a tratar no CD; sem divergência, a coluna não aparece) e `Acertos.test.tsx` (o em
    trânsito na linha da lista e as duas colunas).

64. **Transferência de estoque: telas e romaneio** (Fase 2, F2-B27; ERP 13.7, 3.3, 3.7; README da API › decisões 171 a
    175). `paginas/estoques/Transferencias.tsx` (listagem e formulário), `transferenciaItens.ts` (as regras puras) e
    `TransferenciasRomaneio.tsx`; rotas `/estoque/transferencias`, `/novo`, `/:id` e `/:id/romaneio` (o segmento fixo
    ganha do `:id/:aba?`); o item do menu ficou pronto.
    - **Listagem**: filtros Nº, origem (os estoques permitidos de `GET /transferencias/origens`, também os inativos),
      destino (os mesmos mais os de `GET /transferencias/destinos`, porque o destino pode estar fora deles), situação, "Período por" (criação ou envio) e as datas; colunas Nº (o link),
      origem, destino, data de criação, de transferência (envio) e de recebimento, quantidade de itens e situação.
    - **Formulário** (o padrão do recebimento: `useCadastro`, `FormularioEntidade`, `GradeItens`, 409 com
      "Recarregar", 422 nos campos e nas linhas): origem entre os estoques permitidos e ativos (`GET
      /transferencias/origens`, mais a origem gravada; o padrão é o único permitido ou o primeiro depósito, o CD), destino de `GET /transferencias/destinos` **sem a origem** (trocar
      a origem para o destino escolhido limpa o destino), tipo de estoque, data, motivo, observações e a NF-e emitida por
      fora (só anotação, D6). Grade: produto (só os tipos com saldo próprio), **lote** (vazio = FEFO; aparece quando
      algum produto tem lote), **saldo na origem**, quantidade (enviada), **em embalagens** ("5 FD + 3 UN", pela
      embalagem de compra de maior fator), e depois do envio **recebida**, **diferença**, **tratamento** ("A tratar" ou o
      escolhido) e o custo do envio (com `produtos.ver_custo`). A coluna de variação fica para o PR-12 (D43). O saldo, os
      lotes e a embalagem do rascunho vêm de `GET /transferencias/dados-produtos` (sem as permissões do acerto); o
      gravado, do detalhe.
    - **Botões por situação e permissão** (`acoesTransferencia`, as transições do ERP 13.7 com as conferências da API;
      quem tem a origem ou o destino sai do próprio detalhe, `origemPermitida` e `destinoPermitido`, calculados pela
      API, e não de `GET /estoques`, que exige `estoques.ver` — a tela pede só as permissões da transferência, e o
      estoque de origem inativado depois do rascunho não tira os botões de quem o tem): no rascunho, Salvar, Excluir,
      **Sugerir reposição** e **Salvar e enviar** (grava antes; quem só tem `transferencias.enviar` envia o gravado sem
      alteração) com a origem, e Cancelar; em trânsito, **Receber** (o destino e `transferencias.receber`) e **Cancelar
      envio** (a origem); recebida com divergência, **Tratar diferença** (a origem ou o destino); a **NF-e de fora**
      depois do envio (a origem e `transferencias.enviar`); o **Romaneio** sempre que o documento está gravado (desligado
      com alteração não salva). Recebida e cancelada só imprimem.
    - **Sugerir reposição** mescla na grade: o produto já nela sem lote recebe a quantidade sugerida, o novo entra numa
      linha nova e o resto fica; os avisos da API viram notificação. O **403 em `estoqueDestinoId`** (decisão 173: a
      sugestão mostra o saldo do destino) marca o campo e explica: "o estoque de destino está fora dos seus estoques
      permitidos… Monte a carga à mão, ou peça a quem tem acesso ao destino".
    - **Receber** abre a conferência numa grade de **linhas fixas** (prop nova `linhasFixas` do `GradeItens`: edita os
      campos sem inserir nem remover linhas; Enter e ↑/↓ como na grade), com a enviada já preenchida (o conferente
      corrige o que faltou), a diferença por linha, o aviso de quantos itens vão ficar com divergência e o botão
      **Receber tudo como enviado** (com confirmação). A recebida acima da enviada bloqueia o Confirmar.
    - **Tratar diferença**: a grade fixa dos itens com diferença sem tratamento, um "Retornar à origem"/"Baixar como
      perda" por linha (e os atalhos "Todos: …"); manda só os escolhidos (o parcial deixa os outros a tratar).
    - **O alerta `TRANSFERENCIA_PARADA` aberto** (`alertaParada` do detalhe) aparece no topo, em laranja, com o título e
      a mensagem da varredura.
    - **Os erros por item da ação** (o saldo insuficiente do envio, `itens.N.quantidade`) ficam num estado à parte do
      `form.errors`, porque a recarga do rascunho gravado logo antes do envio (o `setValues` do `useCadastro`) podia
      limpá-los antes de a linha aparecer em vermelho; saem na edição da grade.
    - **Romaneio** (impressão pelo navegador, aba nova com `imprimir=1`, como o espelho do recebimento): o cabeçalho da
      empresa, a origem e o destino (estoque, loja com razão social e CNPJ, endereço), os itens com código, lote,
      embalagem, a quantidade na embalagem e em unidades, a coluna **Conferido** em branco (ou a recebida, depois do
      recebimento), os totais, as observações e três campos de **assinatura** (expedido, transportado, recebido e
      conferido). Avisa que não substitui a NF-e de transferência quando ela for exigida (nada fiscal).
    - Testes: `Transferencias.test.tsx` (as transições por situação e permissão — rascunho, em trânsito na loja e no
      CD, divergência, recebida e cancelada —, a linha, a sugestão mesclada, a conferência, o tratamento, a embalagem e
      a consulta em blocos; e as telas: a listagem com as opções dos filtros de origem — o inativo também — e de
      destino — a Loja 2 que o CD não vê, e a busca com ela —, o rascunho com a origem inativada depois (Salvar,
      Excluir, Cancelar e o seletor de origem continuam), o rascunho com o 403 da sugestão e depois a sugestão aplicada,
      o "Salvar e enviar" com o 422 no item, o recebimento a menor com o alerta parado, o conferente só com
      `transferencias.ver` e `receber` usando o "Receber tudo como enviado" — sem nenhuma chamada ao `GET /estoques`,
      que as referências do teste respondem com 403 —, o tratamento como perda, o 409 do cancelamento e o romaneio), `GradeItens.test.tsx` (linhas fixas) e o e2e `e2e/fluxo-transferencia.spec.ts` (CD →
      Loja 2 com 5 fardos, o romaneio, 58 recebidos de 60 e a perda; os saldos 40 e 58 no fim), fora do CI.

65. **`<Relatorio>` paginado no servidor e ícone Tarefas no cabeçalho** (Fase 2, F2-B30; ERP 3.5, 3.6, 5.1; README da
    API › decisão 177). A casca dos relatórios (`componentes/relatorio/Relatorio.tsx`) e o componente comum das tarefas
    (`componentes/tarefas/`) que os relatórios do PR-7 em diante usam; nenhum relatório real ainda (chegam no F2-B31..B33).
    - **Paginação no servidor** (`config.paginacao`): `pagina` manda `pagina` e `tamanho` e espera o `total` da API
      (primeira, anterior, "Página X de Y", próxima, última e "N registros"); `cursor` manda `tamanho` e o `cursor` e
      espera o `proximoCursor` (primeira, anterior e próxima), para o relatório que lê o razão em ordem e não conta o
      total (a Movimentação analítica, F2-B32). A página, o tamanho (20, 25, 35 ou 50, os do `paginacaoQuerySchema`;
      padrão 50 ou o `tamanhoPadrao`) e o cursor ficam na **URL** com os filtros: o link reabre a mesma página. O Filtrar
      e a troca de tamanho voltam à primeira (o tamanho escolhido continua), e também a troca da loja de contexto do
      cabeçalho quando o filtro de loja vem dela (fora da URL): a página ou o cursor da URL eram da loja anterior, e a
      tela os tira da URL (sem nova entrada no histórico) e já consulta a primeira página da loja nova. No cursor, o
      "Anterior" usa os cursores já vistos, guardados no **estado da entrada do histórico** junto com o cursor da URL
      (`cursoresAnteriores`), não no estado da tela: o Voltar e o Avançar do navegador trazem a página e a pilha juntas,
      e o rótulo "Página N", o botão Anterior e o cabeçalho da impressão continuam certos; o link aberto com cursor só
      tem "Primeira" ("Página aberta pelo link"). Os totais da tabela (`totais`) são do relatório
      inteiro, vindos da API. PDF e Imprimir saem da página aberta, com "Página X de Y (N registros)" no cabeçalho.
    - **Seleção de linhas opcional** (`config.selecao`): a coluna de marcação (da página aberta, com "todas da página"),
      a barra "N selecionada(s)" com as ações do relatório (`acoes(linhas, limpar)`, ex.: o "Definir NCM" em lote do
      F2-B41) e "Limpar seleção". Trocar de página ou de filtros limpa a seleção. Nada disso sai na impressão.
    - **Exportação** (`config.exportar`, normalmente `exportarPelaApi(<chave>)`, a rota comum `GET
      /relatorios/<chave>/exportar` do F2-B29, com os filtros e sem a página): Excel (.xlsx) e **CSV**. Até 50 mil linhas o
      arquivo baixa na hora; acima, a API responde `202 { tarefaId, linhas }` (o cliente HTTP ganhou o `baixarOuTarefa`,
      que lê o `202` como JSON) e a tela mostra a notificação, o aviso "Exportação em segundo plano · N linhas" com o
      andamento e, no fim, o link do arquivo; a mesma tarefa aparece no ícone Tarefas, que é atualizado na hora. A
      recusa (o teto de 5 milhões, as 2 exportações pendentes por usuário) vem na notificação de erro.
    - **Ícone Tarefas** (`componentes/tarefas/IconeTarefas.tsx`, no cabeçalho do `Layout.tsx`, entre a loja de contexto
      e o tema): o contador das tarefas do usuário na fila ou executando e o painel com as 50 mais recentes de `GET
      /tarefas` (o tipo, a data, a situação, o progresso e a mensagem, o motivo da falha, o link "Baixar arquivo" — 7
      dias, sem passar da retenção — ou "O arquivo expirou"). A forma da resposta virou contrato
      (`RespostaTarefas`/`TarefaUsuario` em `packages/shared/src/tarefas.ts`, com os rótulos dos tipos e das situações).
      Quando uma tarefa vista em andamento termina, uma notificação avisa (ERP 3.6).
    - **Consulta econômica** (`componentes/tarefas/tarefas.ts`): a lista é pedida uma vez ao abrir o ERP (válida por
      1 min) e só se repete a cada **5 s** enquanto houver tarefa em andamento ou com o painel aberto (abrir o painel
      consulta na hora); a tarefa acompanhada numa tela (`useTarefa`, `GET /tarefas/:id`) se repete a cada **2 s** só
      até terminar (antes, 1 s na Importação e no upload de NF-e), e ao terminar atualiza a lista. Com a aba do
      navegador em segundo plano nada se repete (o padrão do TanStack Query). Uma **falha passageira** (sem conexão,
      a API reiniciando na implantação, um 502) não para o acompanhamento: enquanto a última resposta mostrava tarefa
      em andamento, a consulta continua, a cada **15 s** (`INTERVALO_APOS_ERRO_MS`), e quando a API volta a tela chega
      ao resultado e o ícone avisa da conclusão sozinhos. Só a recusa da API (4xx: sem permissão, tarefa inexistente)
      para de vez, e a primeira lista que falha (sem lista nenhuma) espera o painel ser aberto. Na tela, o
      `AndamentoTarefa` mostra "Não foi possível acompanhar a …" com "Tentar novamente" acima da barra, que fica no
      último andamento recebido (o upload de NF-e também deixa fechar o quadro); o painel do ícone mostra o aviso com
      "Tentar novamente" também sobre a última lista recebida. Quem pede uma tarefa (exportação, importação, lote de NF-e)
      invalida a lista, e o ícone começa a acompanhar sem esperar.
    - **Permissão**: `GET /tarefas` não tem permissão própria (cada um vê as suas), mas o ícone só aparece — e só
      consulta — para o Master e para quem tem alguma permissão que cria tarefa em nome do usuário
      (`PERMISSOES_COM_TAREFA`: `relatorios.exportar`, `produtos.importar`, `pessoas.importar`,
      `notas_entrada.importar`, `terminais.gerenciar` e `pdv.config.fiscal`, a de quem autoriza a faixa no PDV e em
      nome de quem sai o reprocessamento depois da lacuna). Tipo novo de tarefa com outra permissão entra na lista.
    - **A Importação e o upload de NF-e** passaram a usar o mesmo componente (`AndamentoTarefa`: a barra, a mensagem, a
      falha e o conteúdo da concluída; `DownloadTarefa`: o botão do arquivo ou o aviso de expirado) e o mesmo
      `useTarefa`; o resultado de cada um continua na própria tela, e o aviso cita o ícone Tarefas.
    - Testes: `Relatorio.test.tsx` (o relatório de teste com **100 mil linhas** paginando num servidor simulado — só a
      página vai e volta, a URL com página e tamanho, a última página, a troca de tamanho, o Filtrar e o link com a
      página —, o cursor com próxima, anterior e primeira, a seleção, e o critério de pronto: no `Layout` de verdade, a
      exportação que vira tarefa mostra o aviso, o andamento e o contador do ícone e, quando termina, o link no aviso,
      a notificação e o link no painel), `Tarefas.test.tsx` (o intervalo da lista, o painel com cada situação, o vazio,
      quem não tem permissão — sem ícone e sem consulta — e a consulta que falha) e `http.test.ts` (o
      `baixarOuTarefa`). O relatório de teste só existe nos testes (nenhum relatório falso em produção); o e2e com um
      relatório real fica para o F2-B31 (Estoque Atual; decisão 66).
66. **Relatório Estoque Atual com o modal de ajuste** (Fase 2, F2-B31; ERP 16.4, 13.6, 13.1.5, 3.1, 3.5; README da
    API › decisão 178; `src/paginas/relatorios/EstoqueAtual.tsx` (novo), `ModalAjustarEstoque` em
    `src/paginas/produtos/BlocosProduto.tsx`, `menu.ts` (o item pronto), `rotas.tsx`; o primeiro relatório de verdade
    no `<Relatorio>` da decisão 65). Rota `/relatorios/estoque-atual` (`relatorios.estoque_atual`).
    - **Filtros** (gravados na URL pelo `<Relatorio>`, gerado só no Filtrar): Nome/código (nome, código interno ou
      EAN), **Loja (estoque)** — começa no estoque da loja de contexto (ERP 3.1; sem ela, ou fora dos permitidos,
      "Todas") e tem a opção **"Todas (soma dos permitidos)"** (`estoqueId=todas`, que a API lê como vazio) —, Marca,
      Departamento (a categoria e as filhas, pelo caminho da árvore), Tipo de estoque, Estoque (situação do saldo:
      Todos/Positivo/Zerado/Negativo/Abaixo do mínimo), Produtos (ativos/inativos/todos), **Vencendo em (dias)** e
      **Saldo em (data-base)**; "Loja de treino" (sem/com/só) quando a empresa tem uma (`useFiltroTreino`, D39).
    - **Colunas** (as do Nuvem3 e as novas): Ref. Interna, Produto (link para o cadastro), Preço Custo (custo médio),
      Venda, Atacado, iFood, Est. Mínimo, Est. Atual (na data-base, "Saldo em dd/mm/aaaa"), Em trânsito, Divergência a
      tratar (laranja; "—" sem pendência e na data-base), Vencendo (só com o filtro: a quantidade dos lotes e a
      validade mais próxima), Custo total, Venda total, Unidade, Estoque e Tipo. As de custo só aparecem com
      `produtos.ver_custo` (a API também as manda nulas). Cards e linha de totais do relatório inteiro (itens, custo
      total, venda total; o "Saldo em" com a data-base), paginação por página no servidor (`paginacao: 'pagina'`), e o
      Exportar com Excel/CSV pela API (`exportarPelaApi('estoque-atual')`: até 50 mil linhas baixa, acima vira tarefa
      no ícone Tarefas), PDF e Imprimir.
    - **Ajuste no clique do saldo** (com `estoque_acertos.criar`): o saldo é um botão ("Ajustar o saldo de <produto>
      em <estoque> (<tipo>)") que abre o **mesmo** `ModalAjustarEstoque` do "Ajustar" do produto (decisão 54), agora
      com opções: o estoque da linha fixo (`estoqueFixo`), o tipo da linha (`tipoInicial`, trocável), o nome do
      produto, os rótulos "Gravar"/"Fechar" (ERP 16.4) e o envio para `POST /relatorios/estoque-atual/ajustar`
      (origem `relatorio_estoque`). O "Saldo atual" de cada tipo vem do próprio relatório filtrado no produto e no
      estoque, então acompanha a troca do tipo; a hora da contagem segue a regra do modal (sem mexer, vai vazia e vale
      o instante da gravação). Depois de gravar, a notificação "Acerto Nº … efetivado" e o relatório consultado de
      novo. Não abre no **"Todas"** (a soma não é de um estoque; a dica pede para escolher a loja), na
      **data-base** (é o saldo de outro dia, ERP 16.4 "sem ajuste nesse modo") nem no **tipo de estoque inativo** (a
      API recusa acerto nele; a dica "Tipo de estoque inativo: reative o tipo para ajustar"). E o modal, se ainda
      receber um `tipoInicial` inativo, avisa e deixa o tipo vazio até o usuário escolher (antes caía calado no
      padrão, e o "Saldo atual" e o ajuste eram de outro tipo). Nos filtros **Zerado** e **Abaixo do mínimo** vêm
      também os produtos sem movimento no estoque (saldo 0, decisão 178 da API): o clique lança a contagem inicial.
      O "mover entre tipos" continua pelo acerto "Mudar tipo" (13.5).
    - Testes: `EstoqueAtual.test.tsx` (as colunas e os filtros mandados à API; sem "Ver custo" sem as colunas de
      custo e com o "Todas" como padrão sem loja de contexto; o clique no saldo com o modal, o "Saldo atual" da
      consulta do produto acompanhando a troca para Avaria, o corpo do ajuste e a tabela consultada de novo (contando
      só as consultas sem `produtoId`, as da tabela); o tipo inativo sem o clique e o modal com o tipo inicial
      inativo, que pede o tipo; a data-base e o "Todas" sem o clique; a coluna do "Vencendo"), o
      `BlocosProduto.test.tsx` de sempre (o "Ajustar" do produto com o modal generalizado) e o e2e
      `e2e/fluxo-estoque-atual.spec.ts` (também o e2e da casca da decisão 65 com um relatório de verdade: o filtro da
      marca, 20 por página e a página 2 com o total da API, a data-base de ontem, o ajuste no clique de 15 para 12, o
      acerto "Relatório Estoque Atual" na lista e o Excel que vira tarefa com o link no aviso e no ícone Tarefas; o
      servidor do e2e baixa na hora só até 10 linhas, `E2E_EXPORTACAO_NA_HORA`).
67. **Relatório Movimentação de Estoque, visão analítica** (Fase 2, F2-B32; ERP 16.5, 3.1, 3.5; README da API ›
    decisão 179; `src/paginas/relatorios/MovimentacaoEstoque.tsx` (novo), `src/componentes/listagem/Listagem.tsx`
    (os filtros `multisselecao` e `componente`), `src/componentes/relatorio/Relatorio.tsx` (a `nota` e os filtros
    usados das multisseleções), `menu.ts` (o item pronto), `rotas.tsx`). Rota `/relatorios/movimentacao-estoque`
    (`relatorios.movimentacao_estoque`).
    - **Filtros** (na URL, gerado só no Filtrar): **Local de estoque** (obrigatório, sem "Todas": começa no estoque
      ativo da loja de contexto, ERP 3.1; sem ela, no primeiro ativo permitido; a lista traz também os inativos,
      marcados "(inativo)", para o histórico de um local desativado — a API aceita o inativo, só recusa o excluído), **Data inicial** e **Data final** (padrão: do
      primeiro dia do mês até hoje, no fuso da empresa; a API recusa mais de 366 dias), **Tipos de movimento**
      (multisseleção das referências, `tiposMovimento=A,B`), **Produto** (o `<SeletorProduto>`, com `produtos.ver`),
      **Usuário** (com `usuarios.ver`, como o "Operador" das vendas), **Documento** (o tipo) e **Nº do documento**, e
      **Pessoa (cliente ou fornecedor)** (o `<SeletorPessoa>`, com `pessoas.ver`). Os seletores reabertos pelo link
      mostram o nome pelas `referencias` da resposta.
    - **Dois tipos novos de filtro** no `FiltroListagem` (servem a listagens e relatórios): `multisselecao` (o
      `MultiSelect` do Mantine, o valor em vírgulas) e `componente` (o campo desenhado por `renderizar`, para os
      seletores com busca no servidor; `descrever` dá o texto dos "Filtros" da impressão). O `<Relatorio>` ganhou a
      `nota` (o texto pequeno acima da tabela, também na impressão).
    - **Colunas** (as do export do Nuvem3 e as novas): Data/hora, Ref. Interna, Produto (link para o cadastro; com a
      variação quando houver), Tipo de movimento (com o tipo do Nuvem3 na dica quando confirmado), Tipo de estoque,
      Est. anterior, Qtd. movimentada (verde/vermelha, com o sinal), Est. atual, **Unidade** (a do produto: a da
      quantidade e dos saldos, sempre na unidade base), **Unid. do documento** (a `sigla` do Nuvem3 com o fator quando
      não é 1, ex.: "CX ×12" — 2 CX entram como +24; a nota também explica), Custo unit. e Custo total
      (só com `produtos.ver_custo`; a API também as manda nulas), **Documento** (o rótulo com o número — "Venda
      1-0042", "Acerto Nº 5", "Recebimento Nº 7", "NF-e 1234", "Transferência Nº 3" — e o link para a tela dele
      com a permissão de vê-la), Cliente/Fornecedor (a pessoa do movimento sempre que há: também a devolução de
      cascos e a compensação de uma venda, as que o filtro Pessoa acha), Usuário e Loja.
    - **Saldo recalculado**: a nota explica que Est. anterior e Est. atual seguem a ordem da data e hora de cada
      movimento e podem diferir do gravado no lançamento; quando diferem, o ícone laranja ao lado do saldo mostra os
      gravados na dica (a venda offline que chegou depois, o "Definir" na hora da contagem).
    - **Paginação por cursor** (`paginacao: 'cursor'`, decisão 65): Próxima/Anterior com o `proximoCursor` da API,
      "Página N" sem total (um ano de uma loja passa de um milhão de movimentos), 20/25/35/50 por página (padrão 50).
      O Exportar tem por enquanto só PDF e Imprimir (a página aberta): o Excel/CSV de 12 meses, em tarefa, é do
      F2-B33, com a visão sintética e o link "Ver movimentação" no produto e no Estoque Atual. O item do menu já fica
      pronto, porque a tela abre (a rota "Em construção" daria conflito com a rota de verdade).
    - Testes: `MovimentacaoEstoque.test.tsx` (as colunas, o custo, o documento com o link e os filtros da URL
      mandados à API sem página; sem "Ver custo" sem as colunas de custo, o ícone do gravado diferente e o documento
      sem link sem a permissão; Próxima/Anterior pelo cursor; o padrão do mês e do primeiro local ativo, só depois do
      Filtrar, e o inativo marcado que se escolhe à mão; o estoque da loja de contexto como padrão; a unidade do
      produto ao lado da quantidade e a do documento com o fator; a multisseleção marcada que manda os códigos e os
      "Filtros" da impressão com os nomes dos tipos e o `descrever` do produto e da pessoa).

68. **Movimentação de Estoque: visão sintética, exportação e "Ver movimentação"** (Fase 2, F2-B33; ERP 16.5, 3.5,
    3.6, 8.2.11; README da API › decisão 180; `src/paginas/relatorios/MovimentacaoEstoque.tsx`,
    `src/paginas/relatorios/EstoqueAtual.tsx`, `src/paginas/produtos/FormularioProduto.tsx` (o bloco Estoque)).
    - **Filtro Visão** na Movimentação: "Analítica (um movimento por linha)" (padrão) ou "Sintética por produto"; vai
      na URL como os outros filtros (`visao=sintetica`, só quando não é o padrão). A tela troca entre duas configurações
      do `<Relatorio>` com os mesmos filtros: a analítica por cursor (decisão 67) e a **sintética paginada por página**
      (`paginacao: 'pagina'`, com o total da API: uma linha por produto × tipo de estoque com movimento, milhares numa
      loja). A visão não vai na consulta da tela (cada uma tem a sua rota, `GET /relatorios/movimentacao-estoque` e
      `…/sintetica`), mas vai na exportação (a API escolhe as colunas e a consulta por ela).
    - **Colunas da sintética**: Ref. Interna, Produto (link para o cadastro, com a variação quando houver), Tipo de
      estoque, Saldo inicial, Entradas (verde, "+"), Saídas (vermelha, "−"; "—" quando zero), Saldo final, Unidade (a
      do produto), **Movimentos** (o número é o link para a analítica do produto com os mesmos filtros, sem a visão e
      sem a página; a analítica não filtra o tipo de estoque nem a variação, então o link abre **toda a movimentação
      do produto no local**, as outras linhas dele na sintética também, e o rótulo para o leitor de tela é "Ver toda a
      movimentação de X neste local", não "os N movimentos"; a nota diz o mesmo), Custo das entradas e Custo das saídas (só com `produtos.ver_custo`), **Última compra** (data e
      hora do último recebimento manual ou NF-e do produto no local até o fim do período; "—" sem compra) e Último
      custo (só com `produtos.ver_custo`, até 4 casas). A linha de totais traz o número de linhas e os custos do
      relatório inteiro. A nota explica que os saldos são os do estoque no começo e no fim do período e que, com
      filtro de tipo, usuário, documento ou pessoa, as entradas e as saídas são só as filtradas (o final deixa de ser
      o inicial + entradas − saídas).
    - **Exportação**: o Exportar ganhou Excel (.xlsx) e CSV pela API (`exportarPelaApi('movimentacao-estoque')`), com
      os filtros e a visão (`Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM.xlsx`); acima de 50 mil linhas (os 12
      meses de uma loja passam de um milhão) vira tarefa, com o aviso e o andamento na tela e o link no ícone Tarefas
      (decisão 65).
    - **"Ver movimentação"** (com `relatorios.movimentacao_estoque`): no bloco **Estoque do produto**, uma coluna
      Movimentação com o link em cada linha (estoque × tipo); no **Estoque Atual**, a coluna Movimentação com o link na
      linha de um estoque ("—" no "Todas": a soma de vários locais não é um local, e a Movimentação exige um). O link
      (`linkVerMovimentacao`) abre a analítica já gerada com o **local, o produto e o período na URL**: os últimos 30
      dias (`DIAS_VER_MOVIMENTACAO`, contando o dia final) até hoje no fuso da empresa — no Estoque Atual com data-base,
      até a data-base (a que não é uma data, editada à mão na URL, vira hoje). Período de 30 dias, e não o "do primeiro
      dia do mês" do padrão da tela: no começo do mês o padrão mostraria um dia só.
    - Testes: `MovimentacaoEstoque.test.tsx` (a sintética pela rota dela com a página e sem a visão, as colunas, os
      sinais, a última compra e o "—" sem compra, os totais, a nota, o link dos movimentos para a analítica; sem "Ver
      custo" sem as colunas de custo e com a data da última compra; escolher a visão no filtro troca a consulta, e a
      exportação leva a visão e vira tarefa; o `linkVerMovimentacao` com os 30 dias no fuso da empresa, até a data dada
      e com a data inválida), `EstoqueAtual.test.tsx` (o link com a data-base; no "Todas", sem link) e
      `BlocosProduto.test.tsx` (o link de cada linha do bloco Estoque; sem a permissão, sem a coluna).
69. **Guarda das variações: a chave do caixa e o aviso ao ligar "Com variações"** (Fase 2, F2-B34; F2-Q2 = roadmap
    D44, decidida pelo dono em 05/11/2026; README da API › decisão 181;
    `src/paginas/configuracoes/CamposConfiguracoes.tsx`, `src/paginas/configuracoes/rotulos.ts`).
    - **"Recusa produto com variações no caixa"** (`pdv.recusa_produto_com_variacoes`, padrão Sim) em Configurações ›
      Parâmetros › PDV e, por loja, em Lojas › Parâmetros, com a ajuda do que cada valor faz no caixa.
    - **Ligar "Cadastrar produtos Com variações" avisa dos caixas antigos:** ao gravar a chave da empresa passando para
      Sim, a tela consulta `GET /configuracoes/terminais-sem-guarda-variacoes` e, havendo terminal ativo com o PDV
      anterior à R1 (ou sem versão conhecida), abre "Caixas sem a guarda das variações" com a loja, o caixa, a descrição
      e a versão de cada um (só das lojas permitidas ao usuário; os das outras lojas aparecem como "E mais n caixa(s) de
      outras lojas, fora do seu acesso", porque a chave vale para a empresa toda): "Cancelar" não grava; "Gravar mesmo
      assim" grava. Sem nenhum, grava direto, sem perguntar. A consulta que falha não trava a gravação: o mesmo diálogo
      diz que não deu para conferir e deixa gravar. Só ao **ligar** (desligar, ou gravar outra chave, não consulta). Um
      modal da própria tela, e não o `openConfirmModal`, porque a lista vem da consulta e o teste confere o conteúdo.
    - Testes: `Configuracoes.test.tsx` (os caixas listados e a contagem das outras lojas, só a contagem também avisa,
      "Cancelar" sem `PUT` e "Gravar mesmo assim" com o `PUT` da chave; a consulta com erro avisa e deixa gravar; o
      teste de F2-B1 que liga a chave grava direto sem caixa antigo).

70. **Consulta do estoque das outras lojas no caixa: a chave em Parâmetros › PDV** (Fase 2, F2-B35; F2-Q12 = roadmap
    D53, **vale a recomendação, sem resposta explícita do dono** — padrão até a confirmação do dono; README da API ›
    decisão 182, do PDV › decisão 82; `src/paginas/configuracoes/rotulos.ts`).
    - **"Consulta do estoque das outras lojas no caixa (F4)"** (`pdv.consulta_outras_lojas`, padrão Sim) em
      Configurações › Parâmetros › PDV e, por loja, em Lojas › Parâmetros (a chave é por loja), com a ajuda do que cada
      valor faz no caixa: Sim, o `F4` da pesquisa mostra online a quantidade nas outras lojas e no CD, sem a loja de
      treino e sem custo; Não, o `F4` avisa que está desligada. Só o rótulo: o campo booleano, a gravação e a
      sobreposição por loja são os de sempre. Nenhuma tela nova no ERP.

71. **Histórico de preços do produto: botão e modal no formulário** (Fase 2, F2-B37; MD 3.6.10; ERP 8.2 "Alteração de
    preço"; README da API › decisão 183; `src/paginas/produtos/HistoricoPrecos.tsx`, `FormularioProduto.tsx`).
    - **Botão "Histórico de preços"** nas ações do formulário (produto gravado; ao lado do Duplicar e do Histórico da
      auditoria), abrindo um **modal** e não um bloco do acordeão: a consulta só roda com o modal aberto (`enabled`),
      sem pesar na abertura do produto, e o formulário de 1.900 linhas não cresce.
    - **Filtros:** Tipo (os tipos do `TIPOS_PRECO_HISTORICO`, sem "Custo" para quem não tem `produtos.ver_custo`), Loja
      ("Geral (sem loja)" e as lojas do `/eu`, que já são só as permitidas) e o período De/Até (dias). Mudar um
      filtro volta à primeira página; a página tem 20 linhas, com o total e a paginação.
    - **Colunas:** data e hora, o preço (o tipo com a faixa — "6 a 11", "12 ou mais" —, a variação e a loja, ou "todas
      as lojas" na faixa sem loja), anterior e novo ("—" quando não havia ou deixou de haver; o custo com até 4
      casas, os preços com 2), a variação em % (`variacaoPct`, vazia sem um dos dois ou com o anterior zero), a origem
      (o rótulo de `ROTULOS_ORIGEM_HISTORICO_PRECO`, com "nº" do documento e o link do recebimento ou da NF-e para quem
      tem `recebimentos.ver`/`notas_entrada.ver`) e o usuário.
    - O corte do custo e das lojas é da API; a tela não esconde linha nenhuma por conta própria.
    - Testes: `HistoricoPrecos.test.tsx` (a faixa, a variação, o custo com 4 casas, o link da NF-e; o filtro de tipo na
      query; trocado na página 2 de 3, a chamada volta com a página 1; sem `ver_custo` não há "Custo"; sem a
      permissão da nota, o número sem o link).

## O que ainda não foi feito (Fase 0)

Busca global (Ctrl+K) (o ícone Tarefas do cabeçalho chegou no F2-B30, decisão 65); avisos globais (certificado, PDV com pendências); exportação
em segundo plano acima de 5.000 linhas; "Ver diferenças" no conflito 409 e o antes × depois no Histórico; "Mostrar
excluídos" e Restaurar; seletores que dependem de cadastros futuros (`<SeletorEstoque>`, `<ArvoreSelecao>`,
`<UploadArquivo>`; o `<SeletorPessoa>` chegou no F2-B13, decisão 55); no produto, variações, complementos,
validade/lotes, foto e tributação por UF (Fase 2/fiscal; relacionados e "Ajustar" vieram no F2-B12, decisão 54, e
fornecedores no F2-B13, decisão 55); aba Acessos do usuário (sessões, últimos
logins); anexos de lojas/marcas/categorias; abas Vendas e Financeiro/Total da pessoa; edição de planos e
progresso em tempo real das migrações no painel; inatividade de sessão configurável por empresa; e2e no CI.
