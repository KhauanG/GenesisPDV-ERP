# Plano da Fase 3 – PDV com a operação completa e vendas no ERP (sem a parte fiscal)

> **Versão 2 (revisada).** Montada a partir de cinco levantamentos feitos só com leitura (preços e itens no caixa, cliente e
> vales, operação do caixa, ERP, e API e sincronização) e revisada por duas críticas, uma de completude e outra de viabilidade
> e risco, conferidas no código. Base: `main` em `d97eb34` (D70).
>
> **Versão do PDV nas lojas:** o **0.13.0** está na página de download desde 17/11/2026, mas o `docs/andamento.md` registra
> "falta atualizar os caixas" desde o PR-8. Os caixas podem estar no 0.10, 0.11, 0.12 ou 0.13. O **primeiro passo do PR-17** é o
> dono conferir no ERP › Terminais a versão de cada caixa ativo. Daqui em diante, "o PDV mais antigo em uso" é a versão mais
> baixa dessa lista, e toda matriz de compatibilidade usa ela, com as tags `pdv-v0.10.0` a `pdv-v0.13.0` que já existem. Se algum
> caixa estiver abaixo do 0.10 (sem tag para compilar), ele é atualizado antes da R3, pelo roteiro atual.
>
> A última migração de empresa é a `0028_complementos` e a do controle é a `0006`. **Toda numeração abaixo é provisória e precisa
> ser conferida no merge:**
> - migrações: empresa `0029` em diante, controle `0007` em diante (cada bloco traz a sua linha "Migrações");
> - decisões técnicas: API a partir da **215** (a 214 já está ocupada no working tree pelo OP-B1), ERP a partir da **86**,
>   PDV a partir da **93**;
> - decisões do dono: **D72** em diante;
> - PRs: a Fase 3 começa no **PR-17**, porque o PR-16 está reservado para a operação sem o Actions (OP-B1..B3).

**Restrição do dono:** tudo funcional, **sem a parte fiscal**. Nada de NFC-e, NF-e, SEFAZ, certificado A1/A3 nem DF-e até a 3F.
Os dados que a nota vai precisar (lote do `rastro`, desconto da promoção, acréscimo, complemento dentro do item, vale como forma de
pagamento) **só são gravados** nesta fase.

**Verificação (D70):** o GitHub Actions está sem cota. O portão antes de cada commit de bloco, de cada PR e de cada merge é a
verificação local completa, `scripts/verificar-local.sh` (OP-B1), e a tabela de resultado vai no corpo do PR. **Os PR-17 a PR-30
dependem do PR-16 (OP-B1) juntado na `main`.** Enquanto ele não estiver juntado, o portão é a lista de checks do `CLAUDE.md`
(rodada à mão, com o mesmo resultado no corpo do PR). O que só o Windows cobre fica registrado como **não coberto** e vai para o
roteiro manual da release (seção "O que a sessão não testa"). Nenhum bloco depende de `workflow_dispatch`.

---

## Estado atual

O que as Fases 1 e 2 já entregaram e que a Fase 3 usa, e o que falta, por área. Os caminhos citados são da `main`.

### Protocolo e sincronização
- **Pronto:**
  - os handlers de `auditoria.registros`, `terminal.configuracao_alterada`, `caixa.*`, `venda.finalizada` v1,
    `venda.cancelada` v1 (formas A e B), `vasilhame.movimentado` v1 e `alerta.cadastro` (`apps/api/src/sync/eventos.ts`);
  - o T13: o PDV só grava o tipo e a versão que a nuvem anuncia em `versoes_schema` (`GravadorOutbox.cs:75`). É isso que deixa
    ligar tipos novos sem quebrar o PDV instalado. **Duas exceções que pesam na Fase 3:**
    - `auditoria.registros` e `terminal.configuracao_alterada` estão em `TiposSempreAceitos` e não passam pelo portão. Só que a
      API recusa com `PAYLOAD_INVALIDO` (erro definitivo) o lote de auditoria que traz uma ação fora do catálogo
      (`sync/eventos.ts:60`). Um PDV novo que grave uma ação nova diante de uma API antiga trava esse evento para sempre;
    - com `estado_conexao.versoes_schema_nuvem` nulo (nenhum handshake desde a atualização), `TipoAnunciado` responde "aceito"
      para qualquer tipo e versão (`GravadorOutbox.cs:239-243`);
  - o aplicador do pull ignora tabela ou coluna desconhecida e o cursor avança (README do PDV › decisões 51 e 85); uma tabela nova
    num fluxo exige uma migração EF que volte o cursor (padrão do F2-B45, release R2);
  - a retenção por dependência em `erro`/`retido` (SYNC 8.5), só entre eventos do **mesmo** terminal;
  - os comandos `ressincronizar` e `ressincronizar_fluxo` (no PDV, o cursor volta a 0, sem a sombra da SYNC 6.11);
  - a numeração do vale do lado do contador (`numeracoes` tipo `vale`, herança na ativação com salto, contador do heartbeat,
    `VALE_NUMERO_MAXIMO`; README da API › decisão 212);
  - o heartbeat devolve `versao_minima` e `versao_disponivel` **já filtradas pelo canal da empresa** (`empresas.canal_pdv` e
    `versoes_app_pdv.canal` existem na migração 0001 do controle; `sync/heartbeat.ts:466-478` e `terminais.service.ts:973-984`);
    `atualizar_ate` sai sempre nulo (`heartbeat.ts:491`);
  - as consultas online do caixa ficam dentro de `/sync/consultas/*`, fora do T13 (precedente da decisão 182, F4 "Outras lojas");
  - o ensaio do PDV real contra a API (`apps/api/test/e2e-pdv/`) e as tags `pdv-v0.10.0` a `pdv-v0.13.0`: dá para compilar as
    versões instaladas **de verdade** contra a API nova.
- **Falta:**
  - upcasters (`grep upcast` não acha nada) e mais de uma versão por tipo;
  - o fluxo `operacao` (hoje `operacao: []` em `sync/fluxos.ts:379`);
  - os eventos `troca.registrada`, `vale.*`, `pessoa.criada_no_caixa` e `orcamento.*`;
  - a idempotência das requisições online que alteram estado (`X-Requisicao-Id` é lido e validado em `sync/terminal.ts:129`, mas
    a resposta não é guardada, SYNC 20.4);
  - o código `VC…` com o DV Luhn (não existe em lugar nenhum);
  - os índices compostos de pull da SYNC 6.13 (não existem nas migrações 0001 a 0028) e as medições de catálogo grande e de longo
    período offline (SYNC 19.3).

### Vendas, caixa e estoque na nuvem
- **Pronto:**
  - o schema completo da venda do PDV (`schema/vendas.ts`), com as colunas que a Fase 3 vai preencher: `vendas.tipo_preco`,
    `vendedor_id`, `orcamento_id`, `devolucao`; `itens_venda.origem_entrada`, `peso_digitado`, `preco_tabela`, `origem_preco`,
    `desconto_promocao`, `promocao_id`, `lote_id`, `lote`, `validade_lote`, `acrescimo_rateado`, `vendedor_id`, `comissao_pct`,
    `valor_comissao`, `item_orcamento_id` e `quantidade_devolvida` (com `ck_itens_venda_devolvida`); `itens_venda_complementos`;
    `pagamentos_venda.vale_id` (sem FK); `movimentos_caixa.troca_id` e o tipo `devolucao_troca`;
  - o `venda.finalizada` v1 já aceita quase tudo isso, então a maior parte da Fase 3 do lado do item **não muda o contrato**;
  - os CHECKs de `itens_venda` que limitam o que o handler pode anular (`0012_vendas_caixa.sql:254-260`): em especial
    `ck_itens_venda_promocao (desconto_promocao = 0 or promocao_id is not null)` e `ck_itens_venda_valores` (líquido ≥ 0). O
    `lote_id` e o `vendedor_id` têm FK; o `promocao_id`, não;
  - as travas `tg_vendas_imutavel` (que libera `status`, `status_fiscal`, `devolucao`, `custo_total`, as colunas de cancelamento,
    `versao` e `atualizado_em`, e **não** libera `vendedor_id` nem `observacao`) e `tg_vendas_transicao`;
  - o caixa 0 (`caixas.sistema`) e a numeração `venda` de dono `nuvem` (`lojas/numeracoes.ts:66-76`);
  - o motor de estoque (`estoques/movimentos.ts`): FEFO quando a saída vem sem lote (D48), estorno ao custo original (T20),
    compensação do Definir (T23), `itemDerivadoDocumento`;
  - os tipos de movimento do seed `TROCA_PDV`, `ESTORNO_TROCA_PDV`, `VASILHAME_EMPRESTADO`, `BAIXA_INTERNA`, `VENDA_ERP`,
    `CANC_VENDA_ERP`, `DEVOLUCAO_ERP` e `ESTORNO_DEVOLUCAO_ERP`, **sem gerador** (README da API › decisão 196);
  - a corrida "o ERP cancelou e depois o caixa cancelou" (`aplicarCancelamentoDuplo`, alerta `CANCELAMENTO_DUPLO`);
  - `saldos_vasilhame_pessoas` (com `ck_saldos_vasilhame_pessoas_quantidade CHECK (quantidade >= 0)`, `0004:157`) e
    `pessoas_aliases` (descem no fluxo `pessoas`, vazias); `resolverAliases` na venda;
  - `uq_pessoas_cpf_cnpj` (só pessoas não excluídas) e a trava `genesis:pessoa_documento:<doc>` do cadastro do ERP
    (`pessoas/fornecedores.ts:99`);
  - as formas "Vale Compra" (`tipo_forma = 'vale'`), "Avarias" e "Baixas de utilização em loja" (`consumo_interno`, inativas)
    no seed, com a conta de despesa validada.
- **Falta:**
  - **não existem** as tabelas `promocoes`, `promocoes_itens`, `trocas`, `itens_troca`, `vales`, `movimentos_vale`,
    `reservas_vale`, `orcamentos`, `itens_orcamento`, `vendas_status_pdv`, `conferencias_caixa` e `conferencias_caixa_formas`;
  - **não existe** o tipo de estorno do comodato (`ESTORNO_VASILHAME_EMPRESTADO`) nem o da baixa interna (lacuna do MD 7.3);
  - o handler da venda **não baixa** o produto vinculado ao complemento (`montarMovimentos`, `handlers/vendas.ts:712-790`), grava
    o `lote_id` desconhecido cru no item (só o motor o descarta; com a FK, isso viraria 23503) e recusa a venda com
    `emprestados > 0` (`:530-535`);
  - um `vendedor_id` inexistente viraria 23503 e a venda seria recusada (hoje o PDV manda sempre nulo);
  - não existe nenhum `update(itensVenda)` em `apps/api/src` (o custo é gravado no `INSERT`).

### PDV
- **Pronto:**
  - o espelho local (`Esquema.g.cs`) já tem as colunas de balança, `preco_parcelado`, `solicita_*`, `acrescimo_gelada`, os lotes,
    `saldos_lote`, os complementos, `atalhos_pdv`, `saldos_vasilhame_pessoas` e `pessoas_aliases`;
  - o `MotorPreco` trata o tipo `atacado`; `AplicarAcrescimoTotal` e o rateio do acréscimo existem, sem tela; o limite de desconto
    já conta a redução de preço manual (`ItemVenda.cs:190`);
  - a coluna de estoque estimado na pesquisa F2 (FTS5, F2-B36), o F4 "Outras lojas" (F2-B35), o cache de imagens com sha256
    (`CacheImagens.cs`, F2-B45);
  - o login e a liberação já aceitam o código numérico do usuário (base do crachá);
  - o esperado da gaveta já desconta `devolucao_troca` (`ApuracaoCaixa.cs:97`);
  - `SequenciaLocal.Vale`, o salto da numeração e o mecanismo `criado_localmente` (MD 4.2);
  - a forma `vale` e a `consumo_interno` aparecem como **indisponíveis** (`PagamentoVenda.TiposDaFase`, `:71`). Isso protege o
    caixa instalado: se o ERP ativar essas formas, o caixa antigo não as usa;
  - `Core/Numeros/Arredondamento.cs` (o arredondamento comercial do caixa).
- **Falta:**
  - **os atalhos configuráveis (PDV 28.1, critérios 28.4, PDV-1):** o espelho `atalhos_pdv` desce, mas o caixa não aplica a
    tabela. A barra é fixa em `VendaViewModel.cs:31-49` e a entidade `AtalhoPdvRegistro` só aparece no mapeamento
    (`PdvDbContext.cs:579`). Todas as teclas novas da fase dependem desse mecanismo;
  - as teclas que aparecem como "Futuro" (`VendaViewModel.cs:39-46`): F7 Vendedor, F8 Tipo de preço, F9 Pedidos/Orç., Ctrl+N
    Nova venda, Ctrl+T Troca;
  - "Solicita preço PDV" e "Produto genérico" (PDV 10.4, lacuna da Fase 1 que não está nas "Lacunas conhecidas" do README do PDV:
    o produto com preço zero é recusado em `Venda.cs:1357`); o serviço avulso `Ctrl+S` (PDV 10.4, `geral.utiliza_servico_avulso`);
  - o peso digitado (PDV 10.7): `ItemVenda.PesoDigitado` existe, mas nenhum caminho o liga e nada confere `pdv.venda.peso_manual`;
  - os complementos (o "Com complementos" vende sem complementos), o lote (a `FabricaEventos` manda `lote_id` sempre nulo), a
    etiqueta e a balança serial (só a `BalancaSimulada`), a gelada, o parcelado, as promoções;
  - suspender venda (o status `suspensa` existe e ninguém usa), os limites, a consulta de preço `Ctrl+L`, a tabela de preços,
    a foto no painel, o crachá, o logotipo da loja no cupom (SYNC 6.12, deixado "para depois" no F2-B45);
  - o atualizador: o comando `atualizar_app` responde "não suportado" e o login só **avisa** quando a versão está abaixo da
    mínima (`LoginViewModel.cs:61-73`). A distribuição é o instalador Inno por cima (README do PDV › decisão 62), sem assinatura
    (o dono nunca teve certificado). **Nenhuma linha de Velopack** no repositório;
  - o Code128 na impressão (o `EscPos.cs` só tem QR).

### ERP
- **Pronto:**
  - Vendas, Reforços, Sangrias e Fechamentos de caixa só de leitura (`paginas/vendas/`), com o calculado × enviado × diferença;
  - as abas Geral, Parâmetros (9.3.1) e PDV (9.9) das Configurações, com a tabela de atalhos (que o caixa ainda não aplica);
    Lojas › Parâmetros com "Herdar"/"Personalizar";
  - `GET /configuracoes/terminais-sem-guarda-variacoes`, o modelo do aviso "caixas abaixo da versão" (README do ERP › decisão 69);
  - as permissões `vendas.*`, `orcamentos.*` (inclusive `excluir` e `converter`), `fechamentos_caixa.conferir` e as `pdv.*` da
    Fase 3 no catálogo (`pdv.venda.peso_manual`, `pdv.venda.vender_vencido`, `pdv.troca.*`, `pdv.vale.emitir`,
    `pdv.orcamento.importar`, `pdv.orcamento.criar`; `permissoes.ts:247-290`);
  - todas as chaves `pdv.*` e `vendas.*` da especificação no catálogo (`packages/shared/src/configuracoes.ts`), inclusive
    `pdv.limite_padrao_cliente_pdv` (`:199`), `pdv.orcamento_pdv` (`:148`), `pdv.vasilhame_comodato` (`:161`),
    `pdv.tolerancia_diferenca_caixa` (`:169`) e `geral.utiliza_servico_avulso` (`:69`).
- **Falta:**
  - as telas de Promoções (o menu aponta `/produtos/promocoes` com a permissão `produtos.ver`, porque `promocoes.*` não existe),
    Orçamentos, Vales, a venda no ERP, o cancelamento e a devolução pelo ERP, a conferência do fechamento e a aba Vendas (9.10);
  - o "Imprimir comprovante" de reforço e sangria (ERP 15.2/15.3 "espera os templates de impressão"; não há tipo de template para
    eles em `TIPOS_TEMPLATE`);
  - a API e a tela de `templates_documentos` (a tabela existe e desce ao PDV);
  - o índice `uq_templates_documentos_padrao` do MD 3.1.3 e a numeração `vale` do caixa 0 (correção no F3-B2: o índice já
    existe desde a migração 0002, SQL customizado fora do snapshot; README da API › decisão 221);
  - as faixas de 6 chaves do catálogo estão mais largas que a ERP 9.3.1 (ver o F3-B12).

### Documentação
- O roadmap (Fase 3 › Definição de pronto) cita os "critérios 10.10" da especificação do PDV, mas **a seção 10.10 não existe**
  (vai da 10.9 à 10.11). Os critérios de balança, de peso digitado e de lote são escritos **no começo** do PR-20 (F3-B19).
- O roadmap ainda lista as **variações** na Fase 3, embora a D43 (confirmada em 05/11/2026 com a D44) as tenha mandado para o
  backlog, e a **pré-venda**, que depende da resposta F3-Q47. A entrega "instalador assinado" depende da F3-Q35(b).
- A SYNC não define: o estorno do comodato no cancelamento (10.4) e o evento de cancelamento de troca pelo caixa. A MD 4.5 não tem
  a fórmula do saldo estimado do comodato. Cada bloco corrige o que usa. (A troca imediata **já está definida** na SYNC 9.16: o vale
  de todo o crédito sobe dentro do `troca.registrada`, a venda nova usa parte dele e o restante é o saldo do mesmo vale.)
- As rotas de vale e de orçamento estão escritas como `GET /vales/{codigo}`, `POST /vales/{id}/reservar` e
  `POST /orcamentos/{id}/reservar` (SYNC 14.4, PDV 16.11, PDV 24.1, ERP 15.4.4). Pelo precedente da decisão 182, elas passam a
  `/sync/consultas/*`, e esses quatro textos são corrigidos.
- O `andamento.md` mostra "API 208, ERP 83, PDV 88" como próximos números: está desatualizado.

---

## Fora da Fase 3

| Item | Motivo |
|---|---|
| Emissão de NFC-e/NF-e, SEFAZ, DF-e, certificado A1/A3, `tPag` do vale, NF-e de devolução (`pdv.devolucao_emite_nfe_entrada`), aba Documento fiscal da venda, "Emitir NF-e", grupo `rastro`, `vDesc`/`vOutro` | Restrição do dono: Fase 3F (NFC-e) e Fase 6 (NF-e). Os dados ficam gravados. `trocas.documento_fiscal_id` fica nulo e sem uso. |
| Upcaster do `fiscal_snapshot` (SYNC 17.5, `schema_fiscal` 1→2) | Fase 3F: só a nota usa o snapshot fiscal. O mecanismo de upcast do F3-B4 serve a ele sem mudança. |
| Preparação administrativa da 3F (credenciamento da NFC-e, CSC, certificados A1, biblioteca fiscal) | O roadmap pede que ela comece "durante esta fase", mas a ordem do dono (2 → 3 → 4 → 5 → 3F) põe a 3F depois das Fases 4 e 5. Ver a F3-Q37: por padrão, começa no início da Fase 5 (o A1 vale 1 ano; comprar agora desperdiça a validade). |
| Comandas, taxa de serviço, faixas de numeração de comanda (SYNC 13.5), pedidos e delivery (`comanda.*`, `pedido.*`), cardápio interno, impressoras de produção, taxas de entrega | D4: fluxo de balcão; módulos FUT na Fase 8. |
| Crediário, crédito de funcionário, boleto, cartão integrado (TEF) e PIX dinâmico (`cobrancas_pix`) | Fora da PDV-2 (roadmap); TEF e PIX dinâmico na Fase 6. |
| Lançamentos financeiros: contas a receber da venda ERP e do parcelado, despesa da baixa interna pelo custo, quebra e sobra da conferência, saída de conta na devolução em dinheiro e no resgate de vale | Fase 4. Nesta fase os valores ficam gravados, com `conta_financeira_id` nulo. |
| Relatórios de comissão, Produtos × Vendedor, trocas, promoções e peso digitado; o **Relatório Geral de Vendas com o Tipo "Trocas"** (critério 23.3 nº 4) | Fase 5 (o menu já os marca). A Fase 3 grava os dados e mostra no detalhe da venda, na listagem de Vendas (filtro "Com devolução") e na Movimentação de estoque. O critério 23.3 nº 4 recebe a nota "relatório na Fase 5". |
| **Variações na venda** (PDV 10.2) e a grade F2-B48..B50 | D43 e D44 (complementos sim, variações não; confirmadas em 05/11/2026): o roadmap é corrigido (não é pergunta). |
| **Pré-venda de balcão** (PDV 24.2, modo utilitário) | Pela recomendação da F3-Q47: depende de um terminal "utilitário" na loja e de internet entre os terminais. O roadmap e o critério PDV-2 do Objetivo são corrigidos; volta ao plano se o dono responder (B). |
| Serviço avulso `Ctrl+S` (PDV 10.4) | Pela recomendação da F3-Q6: as lojas são obrigadas à NFC-e (D1), onde o serviço avulso fica bloqueado por padrão (PDV 10.4). Fica no backlog; `geral.utiliza_servico_avulso` continua desligada. |
| Trocar o vendedor de uma venda finalizada pelo ERP (PDV 15) | Pela F3-Q10 (D28: a loja não usa vendedor). Exige liberar `vendedor_id` no `tg_vendas_imutavel` e recalcular a comissão; entra com o relatório de comissão (Fase 5) se o dono ligar o vendedor. |
| Banners da loja (`banner_1366`, SYNC 6.12) | Não há segunda tela nos caixas. O logotipo do cupom entra (F3-B25). |
| Vale-presente vendido, cardápio digital | FUT. |
| Mescla manual de pessoas no ERP | Só se o dono pedir (F3-Q12). |
| SSE e snapshot (`GET /sync/eventos`, `GET /sync/snapshot`) | Não estão na lista da Fase 3; ficam como referência na SYNC. |
| Auditoria completa de segurança nova | Já feita no fim da Fase 2 (D64/D69). Aqui vale a revisão de segurança do PR inteiro (D63), com atenção ao PR do atualizador, às consultas online e às rotas públicas. |

---

## Perguntas ao dono

**Respondidas pelo dono em 25/11/2026: todas pela recomendação (★)** — D72 a D118 e a D15 (F3-Q27); a F3-Q35(b) depende de o dono
conferir o Smart App Control nos caixas. Registro em `docs/planos/decisoes-do-dono.md` › Fase 3.

**Regra:** enquanto a pergunta não for respondida, vale a **recomendação (★)**, implementada de forma **configurável** quando há
chave. O dono responde "1A, 2B…". Cada resposta é registrada em `docs/planos/decisoes-do-dono.md` e na tabela do roadmap §16, a
partir da **D72**. As perguntas já abertas que esta fase fecha são citadas pelo código antigo (D15, D66).

**Contexto da Ice Beer que vale para todas** (decisões já tomadas): hoje **não há gerentes**; toda liberação de supervisor é feita
com o **PIN do dono** (Master), e o dono vai criar um login com o perfil de sistema **"Encarregado"** (PC-8) para liberar na loja.
"O supervisor libera", abaixo, quer dizer: o dono ou o Encarregado digita o PIN.

**Não são perguntas** (já decididas ou definidas na especificação; entram em "Padrões"):
- variações fora da Fase 3 (D43, D44);
- lote vencido bloqueado, com liberação do supervisor e motivo por `pdv.venda.vender_vencido` (PDV 10.8);
- crachá = código de barras do usuário + PIN (PDV 31.3).

Em cada pergunta, "na loja" diz o que muda para quem está no balcão.

### Escopo e itens no caixa

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q1** | A loja usa balança? Qual modelo? | (A) Não usa: balança fora. **★(B)** Fazer já a etiqueta de balança (código que começa com 2, impresso pela balança do açougue/petiscaria) e o peso digitado com permissão, e deixar a balança ligada no caixa para quando o dono disser o modelo. (C) Balança no caixa já (informar o modelo; Toledo Prix é o mais comum). O pedido dos arquivos reais do Nuvem3 é o da **D66** (aberta, vale a recomendação dela); falta só o que significa o tipo "Unidade" no cadastro. | Com (B), o operador passa a etiqueta e o caixa lança o peso e o valor certos. | F3-B22 |
| **F3-Q2** | No Nuvem3, o preço de atacado vale por quantidade, por escolha do operador ("Tipo de preço", F8) ou pelos dois? (PDV 35, item 3) | **★(A)** Os dois, como na especificação: o atacado por quantidade (já existe) continua, e o F8 troca a venda inteira para atacado com `pdv.venda.tipo_preco_atacado` ou liberação. (B) Só por quantidade: o F8 fica fora. | Com (A), o operador vende a um bar pelo preço de atacado mesmo com poucas unidades, com a permissão. | F3-B17 |
| **F3-Q3** | O preço parcelado (preço maior quando o cliente parcela no cartão) é usado? | **★(A)** Fazer como na especificação; produto sem "Preço parcelado" cadastrado não muda nada. (B) Tirar da Fase 3. | Com o preço preenchido: ao escolher 2× ou mais, o caixa mostra "total passa de R$ X para R$ Y" e pede confirmação. | parte do F3-B18 |
| **F3-Q4** | Complemento repetido (2× o mesmo molho): | **★(A)** Cada opção 0 ou 1 vez por unidade do item; o "máximo" do grupo conta opções. (B) Permite quantidade por opção. | Com (A), "2 molhos" são dois molhos diferentes. | F3-B15 |
| **F3-Q5** | Lote digitado que não está na lista do caixa: | **★(A)** A nuvem procura o lote pelo código no produto, só entre os lotes com `estoque_id` nulo ou igual ao estoque da venda (regra da MD 3.6.9); achou, baixa esse lote; não achou, baixa pelo FEFO e guarda o texto do lote no item. (B) Sempre FEFO. (C) O caixa não deixa digitar lote fora da lista. | Com (A), o lote certo é baixado mesmo quando o caixa ainda não recebeu o cadastro novo. | F3-B20 |
| **F3-Q6** | A loja usa "Serviço avulso" (`Ctrl+S`: um item de serviço com descrição e preço digitados)? | (A) Sim, fazer agora (só funciona em loja "Não fiscal"; em loja NFC-e fica bloqueado, PDV 10.4). **★(B)** Não agora: as lojas são obrigadas à NFC-e (D1); fica no backlog. | Com (B), nada muda. | — |

### Promoções

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q7** | Quais tipos de promoção primeiro? | **★(A)** "Leve 3 pague 2", % no item (com faixas por quantidade), preço fixo em horário (happy hour) e % por forma de pagamento (ex.: PIX à vista). O combo promocional depois. (B) Os 5 tipos. (C) Só "leve-pague" e % no item. | O caixa aplica sozinho e o cupom mostra a linha da promoção; o operador não precisa de senha. | F3-B35, B36 |
| **F3-Q8** | Duas promoções no mesmo item ("acumulativa")? O item da venda só guarda uma. | **★(A)** Uma promoção por item: vale a de maior desconto (a regra da PDV 11.4 sem `acumulativa`); a marca "acumulativa" fica guardada para depois. (B) Tabela nova para várias promoções por item (mais migração e protocolo). | Com (A), o cliente sempre leva a melhor promoção. | F3-B35 |
| **F3-Q9** | Desconto por forma de pagamento com pagamento misto (parte PIX, parte dinheiro): | **★(A)** Só quando a venda inteira é paga nas formas da promoção; ao lançar a forma, o caixa oferece "pagar tudo no PIX com 5%". (B) Proporcional ao valor pago na forma. | Com (A), a regra é simples de explicar ao cliente. | F3-B36 |

### Vendedor, cliente e comodato

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q10** | **Confirmação da D28** ("não há vendedor nem comissão no balcão"). | **★(A)** Mantém a D28: o recurso do vendedor fica pronto e **desligado** (`pdv.forca_escolha_vendedor` = Não; o F7 existe; a comissão só é calculada para quem tiver %); trocar o vendedor de venda já finalizada pelo ERP fica para a Fase 5, com o relatório de comissão. (B) Ligar já, com "Força escolha do vendedor" e a troca do vendedor pelo ERP nesta fase. | Com (A), nada muda no balcão. | F3-B28 (só as chaves) |
| **F3-Q11** | Cadastro rápido de cliente no caixa: CPF obrigatório? | **★(A)** Obrigatório para pessoa física: evita cliente duplicado e permite juntar automaticamente com o cadastro da nuvem (sem CPF, o operador usa só "nome na nota"). (B) Opcional, como na especificação (risco de duplicados). | O operador cadastra o cliente no balcão, mesmo sem internet. | F3-B38 |
| **F3-Q12** | O cliente criado no caixa tem o CPF de um cliente que já existe: | **★(A)** A nuvem junta automaticamente (mantém o cadastro da nuvem, preenche só o que estava vazio e guarda o apelido); sem tela de mescla manual no ERP por ora. (B) Junta, mas abre um alerta para alguém conferir o nome. (C) Não junta; o ERP mostra o duplicado e ganha a tela "Mesclar pessoas". | Com (A), o cliente nunca aparece duas vezes. | F3-B37 |
| **F3-Q13** | A Ice Beer **empresta cascos em comodato** a clientes identificados (PDV 35, item 4)? Se sim, quem pode emprestar e com que limite? | (A) Não empresta: o comodato sai da fase e o item da Definição de pronto vira "não se aplica". **★(B)** Empresta (ou pode vir a emprestar): o recurso fica pronto, desligado em `pdv.vasilhame_comodato` até o dono ligar; com permissão nova `pdv.vasilhame.comodato` e limite por cliente (`pdv.vasilhame_comodato_max_por_cliente`, ex.: 6 cascos); acima, o supervisor libera. (C) Empresta, qualquer operador, sem limite. (D) Empresta, só o supervisor. **Com o contador:** o tratamento fiscal da remessa em comodato (PDV 35, item 4). | O cliente leva o casco emprestado com o termo assinado em 2 vias. | F3-B39, B40 |
| **F3-Q14** | Venda com cascos emprestados é cancelada: os cascos voltam? | **★(A)** Sim: o cancelamento devolve o empréstimo (os vazios voltam ao estoque e saem do saldo do cliente), como a D29 faz com os cascos trazidos; o caixa orienta recolher os cascos. (B) Não: o empréstimo continua com o cliente. | Com (A), o saldo de cascos do cliente fica certo. | F3-B39 |
| **F3-Q15** | O cliente devolve cascos que comprou e leva crédito em vale? | **★(A)** Sim, pelo preço atual do casco, com o mesmo teto e liberação da D38 (R$ 50,00 por operação sem supervisor). (B) Só o desconto na venda do momento (como hoje), sem vale. | Com (A), o cliente leva um vale impresso com o código. | F3-B49 |

### Trocas e vales

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q16** | Prazo da troca e validade do vale: | **★(A)** 30 dias para trocar (`pdv.dias_validade_cupom_troca`) e vale válido por 90 dias (`pdv.vale_compra_validade_dias`), os padrões atuais. (B) Outros números (informar). | O cupom de troca e o vale mostram as datas. | — |
| **F3-Q17** | Vale vencido com saldo: | **★(A)** O saldo continua registrado e aparece no extrato; o caixa recusa o vale vencido, e o supervisor pode liberar (`pdv.troca.fora_prazo`); a nuvem não zera nada sozinha. (B) Uma tarefa diária zera o saldo dos vencidos (sem volta). (C) O vale não vence. | Com (A), o dono ou o Encarregado decide caso a caso. | F3-B41, B50 |
| **F3-Q18** | O caixa pode aceitar vale sem internet? | **★(A)** Sim (`pdv.vale_exige_online` = Não): aceita o vale que o caixa conhece; se o mesmo vale for usado em dois caixas sem internet, o saldo fica negativo e o alerta aparece no Dashboard. (B) Só com internet acima de um valor (chave nova `pdv.vale_offline_ate`). (C) Sempre com internet. | Com (A), a queda da internet não para o balcão. O vale emitido agora num caixa sem internet só vale nos outros caixas depois que ele subir para a nuvem. | F3-B46 |
| **F3-Q19** | Quais vales ficam guardados em cada caixa? | **★(A)** Os ativos e os que mudaram nos últimos 90 dias; o caixa apaga sozinho os que saíram da janela (vencidos ou zerados há mais de 90 dias); online, o caixa consulta qualquer vale. (B) Todos, sempre (o texto atual da MD 6.2). (C) Só os da própria loja. | Com (A), o caixa não acumula vales antigos para sempre. | F3-B7 |
| **F3-Q20** | Devolução em dinheiro na troca (e o resgate do vale em dinheiro): | **★(A)** Só com `pdv.troca.devolver_dinheiro`, que nos perfis de sistema fica com o Administrador (o dono) e o Encarregado (PC-8); o operador pede a liberação, e hoje quem libera é o dono com o PIN. (B) Qualquer operador com `pdv.troca.realizar`. (C) Nunca dinheiro, só vale ou troca imediata. | Com (A), todo dinheiro que sai da gaveta por troca passa pelo PIN do dono ou do Encarregado e entra na conferência do fechamento. | F3-B47, B48 |
| **F3-Q21** | Troca sem a venda de origem (cliente sem cupom, ou o caixa offline e a venda de outro caixa): | **★(A)** Só com o supervisor (`pdv.troca.fora_prazo`), pelo preço de venda atual como teto, e só como vale (sem dinheiro); a mercadoria volta ao estoque pelo custo médio atual. (B) Permitida em qualquer resolução com supervisor. (C) Proibida. | Com (A), a troca sem cupom é possível sem virar saída de dinheiro. | F3-B44, B47 |
| **F3-Q22** | Para onde vai o produto devolvido? | **★(A)** O operador escolhe "volta ao estoque" ou "avaria" (padrão "volta ao estoque"); drink ou porção feitos na loja (ficha técnica) nunca voltam ao estoque. (B) Tudo para avaria, e o dono reclassifica no ERP. | Com (A), a lata fechada volta para a venda e a amassada vai para avaria. | F3-B43 |
| **F3-Q23** | Troca de uma venda feita em outra loja? | **★(A)** Sim, com internet (busca da venda na empresa toda, com os limites de privacidade do F3-B45); a mercadoria entra no estoque da loja que recebeu a troca. (B) Só na loja da venda. | — | F3-B45 |
| **F3-Q24** | Cupom de troca (comprovante sem preços para o cliente trocar depois): | **★(A)** Só a pedido (Ctrl+Shift+T logo após a venda ou pela Gestão de vendas), com `pdv.imprime_cupom_troca` = Não. (B) Automático em toda venda. | Com (A), não gasta papel em toda venda. | F3-B49 |
| **F3-Q25** | O código do vale (`VC` + loja + caixa + sequência + 1 dígito) é **previsível**: quem tem o vale ...80 pode tentar o ...81 de outro cliente, e sem internet o caixa aceita qualquer vale que conheça. Proteger? | **★(A)** Um código de conferência de 4 dígitos aleatórios impresso no vale (guardado só como resumo criptográfico); no uso, o leitor lê o código e o operador digita os 4 dígitos (chave `pdv.vale_exige_conferencia`, padrão Sim). (B) Aceitar o risco: sem conferência, só a auditoria e o alerta. (C) Vale sempre nominal (cliente obrigatório e conferido). | Com (A), um passo a mais no uso do vale; um vale adivinhado não passa. | F3-B1, B41, B46, B49 |
| **F3-Q26** | Operações de vale **fora** da troca, no caixa (SYNC 9.17): emitir um vale avulso (ex.: crédito por reclamação), devolver o saldo do vale em dinheiro e cancelar um vale emitido errado na mesma sessão. A loja usa? | **★(A)** Sim, as três: o contrato na nuvem já sai no F3-B41; as permissões já existem (`pdv.vale.emitir`, `pdv.troca.devolver_dinheiro`, `pdv.troca.realizar`). (B) Só o cancelamento (o resto só pelo ERP). (C) Nenhuma no caixa. | Com (A), o vale emitido errado se cancela no próprio caixa, e o cliente pode resgatar o saldo em dinheiro com o PIN do dono ou do Encarregado. | F3-B48 |

### Balcão do caixa

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q27 (= D15)** | O que fazem "Limite de Valor de Vendas PDV" e "Limite Venda em Aberto" (PDV 35, item 1)? | **★(A)** Como na especificação: venda acima do valor pede o supervisor ao concluir; o "em aberto" é o máximo de vendas suspensas por caixa. Vazio = sem limite; 0 no "em aberto" = não deixa suspender. Sugestão para a Ice Beer: valor vazio e 3 suspensas. (B) Têm outro sentido no Nuvem3 (o dono descreve). (C) Não usar os dois. | O operador "estaciona" a venda do cliente que foi buscar algo e atende o próximo. | F3-B23, B24 |
| **F3-Q28** | Fechar o caixa com venda suspensa: | **★(A)** Bloqueia e lista as suspensas para retomar ou cancelar (PDV 21.2). (B) Cancela sozinho, com o motivo "suspensa no fechamento". (C) Passa para o caixa seguinte. | — | F3-B23 |
| **F3-Q29** | Preço da venda suspensa ao recuperar: | **★(A)** Fica como estava (o que o cliente viu), como na venda recuperada depois de uma queda. (B) Recalcula pelo catálogo atual. (C) Recalcula só se ficou suspensa mais de 24 h. | — | F3-B23 |
| **F3-Q30** | Tabela de preços no caixa: | **★(A)** Na tela e impressa na impressora do caixa, só a lista filtrada, com confirmação acima de 200 linhas. (B) Só na tela. | O operador imprime os preços de uma categoria para a gôndola. | F3-B26 |
| **F3-Q31** | Foto do produto no caixa: | **★(A)** Ligar `pdv.exibe_foto_produto` na Ice Beer, no painel do item e na consulta, só para produto com foto. (B) Deixar desligada. | Ajuda o operador a conferir o produto passado. | F3-B24 (só a chave) |
| **F3-Q32** | Avaria e consumo interno são registrados no caixa hoje (no Nuvem3)? (ERP 23.2, questão 20) | **★(A, se usam)** Sim: as formas "Avarias" e "Baixas de utilização em loja" são ativadas, com liberação do supervisor e motivo; a baixa sai do estoque e não conta como venda. (B) Não: fica só o Acerto de saída no ERP, e os blocos de baixa interna saem do plano. | Com (A), a lata quebrada sai no caixa com motivo, sem dinheiro. | F3-B51, B52 |

### Atualização do caixa, homologação e a fase fiscal

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q33** | Como atualizar os caixas? | **★(A)** Velopack por usuário do Windows. A R3 (0.14.0, com as funções novas) sai ainda pelo instalador atual; depois, uma versão **sem nenhuma mudança de venda** (0.14.1) faz a passagem, com **uma** instalação manual em cada caixa, caixa por caixa; daí em diante as versões chegam sozinhas, sem senha de administrador, só com o caixa livre (no login ou depois do fechamento). (B) Manter o instalador atual e atualizar por um serviço do Windows (pede administrador na instalação e roda com privilégio). (C) Continuar manual, só com o aviso de versão. **Com (B) ou (C),** o item da Definição de pronto sobre a atualização muda no roadmap (o PR-22 não é feito). | Com (A), ninguém precisa ir a cada loja a cada versão; um problema da passagem não se mistura com um defeito de venda. | F3-B31..B33 |
| **F3-Q34** | Canal "beta" (versão de teste antes de todos): | **★(A)** O canal da empresa (já existe) mais uma exceção por terminal no ERP: a Ice Beer é uma empresa só, então sem a exceção o "beta" atualizaria todos os caixas; o beta vai primeiro ao caixa da loja Treino. (B) Só por empresa (ERP 19.3). | Com (A), só o caixa de teste recebe a versão nova primeiro. | F3-B31 |
| **F3-Q35** | Assinatura das atualizações e do instalador: | **(a) Atualizações: ★(A)** uma chave de assinatura própria, gerada e guardada **no PC do dono** (nunca na VPS nem na sessão); a parte pública vai dentro do PDV e o caixa recusa pacote sem a assinatura certa. Sem custo. (B) Confiar só no HTTPS e no sha256 (não recomendado). **(b) Certificado Authenticode (o "selo" do Windows):** ★ conferir antes se algum PC de caixa tem o "Controle Inteligente de Aplicativos" (Smart App Control) ligado; se tiver, (A) comprar um certificado OV (hoje só vem em token USB ou em nuvem; não existe mais arquivo `.pfx`) e assinar no PC do dono; se não tiver, (C) não comprar por ora, e o roadmap troca "instalador assinado" por "atualização com assinatura própria; Authenticode quando houver Smart App Control". | Sem a assinatura (a), quem invadir o servidor de download poderia mandar um programa falso a todos os caixas. | F3-B32, B33 |
| **F3-Q36** | O servidor da Oracle (ARM Ampere, 2 CPU, 12 GB) que o dono ofereceu de novo ("quer testar por lá?"). A D70 já o deixou "como opção de homologação na Fase 3"; a pergunta agora é **como**. | **★(A)** Usar como **homologação**, operado por **roteiros que o dono cola no terminal do servidor** (como o OP-B2): um roteiro monta o ambiente (API, ERP e PostgreSQL 18 com dados inventados, TLS e um nome separado, ex.: `homolog.<domínio>`), outro busca o branch e roda os checks, a carga do F3-B66 e o teste de dois caixas do F3-B70 e imprime **só a tabela de resultado**, que o dono cola no chat. A sessão **nunca** recebe chave nem senha. (B) Como (A), mas a sessão opera o servidor pelo **Remote Control** (o dono compartilha uma pasta de trabalho e aprova a conexão): mais rápido, porém pode não estar disponível num servidor Linux sem o aplicativo do Claude; conferir antes. (C) Não usar; tudo na sessão. **Em qualquer caso:** nada de runner do GitHub Actions nele (repositório público); nenhum segredo da produção; Postgres sem porta pública; abrir a porta 443 na "security list" da Oracle **e** no `iptables` da imagem Ubuntu; tudo recriável por roteiro, porque a Oracle pode recuperar uma instância gratuita ociosa por 7 dias. O que ele **não** prova: nada do Windows (instalador, Velopack, impressora, balança, desempenho do caixa). | Com (A), o dono vê o sistema novo funcionando com dados de teste antes de ir à produção. | F3-B66, B70 (opcional) |
| **F3-Q37** | A preparação administrativa da fase fiscal (credenciamento da NFC-e na SEFAZ-PR, CSC, certificado A1 de cada loja, conversa com o contador). O roadmap manda começar "durante a Fase 3", mas a ordem do dono põe a 3F depois das Fases 4 e 5. | (A) Começar agora. **★(B)** Começar no início da Fase 5: o certificado A1 vale 1 ano e comprar agora desperdiça a validade; o credenciamento e o CSC levam poucas semanas. Agora, só a conversa com o contador sobre as dúvidas da PDV 35, itens 4 e 6, sem compromisso. (C) Só quando a Fase 5 acabar. | Nada muda agora. | — |

### ERP: venda, cancelamento, conferência e orçamentos

| Código | Pergunta | Opções (★ = recomendada) | Na loja | Bloqueia |
|---|---|---|---|---|
| **F3-Q38** | Para que a venda feita no ERP vai servir antes da fase fiscal? | **★(A)** Venda a bares e clientes a prazo e lançar venda esquecida, **sem documento fiscal**, com o aviso fixo "Sem documento fiscal: emita a nota no Nuvem3 até a fase fiscal" e o filtro "Documento fiscal: Sem documento" da listagem (ERP 15.4.1). (B) Só correções internas. (C) Não usar até a 3F (os blocos da venda ERP vão para o fim). **Aviso:** em loja obrigada a emitir NFC-e, venda sem nota é omissão de receita (D67). | O escritório registra a venda grande sem passar no caixa. | F3-B56..B58 |
| **F3-Q39** | A venda do ERP pode deixar o estoque negativo? | **★(A)** Segue `vendas.valida_estoque` (padrão Não), como a D27 decidiu para o caixa ("a loja nunca trava a venda por falta de estoque"), com o alerta `ESTOQUE_NEGATIVO`. (B) Segue `estoque.permite_negativo_erp` (bloqueia, salvo Master, como o acerto). | — | F3-B57 |
| **F3-Q40** | A venda do ERP aplica as promoções automáticas do caixa? | **★(A)** Não: preço da loja, quantidade, mix e atacado; promoção vira desconto manual. (B) Sim (motor de promoções também no ERP). | — | F3-B54 |
| **F3-Q41** | Antes do financeiro (Fase 4), o que a venda do ERP grava do pagamento? | **★(A)** Pagamentos e parcelas gravados, sem contas a receber; a Fase 4 gera as contas das vendas antigas. (B) Só formas "Lança quitada". | — | F3-B57 |
| **F3-Q42** | Cancelar pelo ERP uma venda do caixa cuja sessão **ainda está aberta**: | **★(A)** Bloquear com "cancele no caixa": o dinheiro está na gaveta e o fechamento ficaria errado. (B) Permitir; o fechamento mostra a diferença. | — | F3-B11 |
| **F3-Q43** | Venda de **caixa já fechado** cancelada no ERP: como registrar a devolução ao cliente? | **★(A)** Escolher a forma (dinheiro do cofre, estorno no cartão ou PIX, ou vale), só registrada até a Fase 4; o vale vira vale de verdade quando os vales entrarem. (B) Só por vale. | Resolve as vendas "registradas com erro" desde a 1C (PC-1/D23), que hoje não se cancelam em lugar nenhum. | F3-B11 |
| **F3-Q44** | Conferência do fechamento: tolerância e correção (PDV 35, item 7). | **★(A)** "Conferida" quando a diferença de cada forma está dentro de `pdv.tolerancia_diferenca_caixa`, senão "Divergente"; quem tem `fechamentos_caixa.conferir` pode refazer, com auditoria. **Atenção:** o padrão é R$ 0,00, e aí qualquer centavo deixa a sessão "Divergente"; se o dono preferir, informar outro valor (ex.: R$ 0,05). (B) A conferência é definitiva. | O dono confere o envelope de cada caixa pelo ERP. | F3-B9 |
| **F3-Q45** | Devolução no ERP com "dinheiro" antes da Fase 4: | **★(A)** Registrada como "devolvido em dinheiro" (informativo, sem saída de conta). (B) No ERP, só vale-troca até a Fase 4. | — | F3-B59 |
| **F3-Q46** | Orçamentos: até onde ir? | **★(A)** Orçamento no ERP com impressão/PDF pelo navegador, importado no caixa (F9 ou "ORC" + código) e criado no caixa; sem e-mail e sem link público por ora (o texto se copia para o WhatsApp à mão). (B) Também e-mail e link público para o cliente aprovar. (C) A Ice Beer não usa orçamento: só no backlog. | O atendente monta o orçamento, o cliente volta e o caixa puxa pelo código. | F3-B60..B64 |
| **F3-Q47** | Pré-venda (o atendente monta a venda num computador e o caixa recebe pelo código): | **★(A)** Não agora (depende de um terminal "utilitário" na loja e de internet entre os terminais); sai do roadmap da Fase 3 e vai para o backlog. (B) Sim. | — | — |
| **F3-Q48** | Orçamento criado **no caixa sem internet**: o número do orçamento (`ORC00321`) é dado pela nuvem só quando o caixa sobe o orçamento (SYNC 9.19), então a impressão feita offline sairia sem número. | **★(A)** "Salvar como orçamento" só com internet: o caixa sobe na hora e imprime com o número; offline, a tecla avisa "requer conexão". (B) Imprimir um número provisório do caixa (loja + caixa + sequência + dígito, como o vale) e a importação aceitar os dois números. | Com (A), o cliente sempre leva um número que o outro caixa e o ERP acham. | F3-B63 |

### Padrões aplicados sem pergunta (registrar nos READMEs como "padrão até a confirmação do dono")

**Protocolo e compatibilidade**
- **Versões por onda (SYNC 17.5).** Toda ampliação de semântica de um tipo de evento existente vira uma **versão nova**, com upcaster
  da anterior e o payload original sempre gravado. Planejado:
  - `venda.finalizada` **v2** (onda da R3): baixa do complemento, regra do lote (F3-Q5), vendedor e comissão;
  - `venda.finalizada` **v3** e `vasilhame.movimentado` **v2** (onda da R4): vale como pagamento, comodato, baixa do comodato,
    crédito em vale e baixa interna;
  - os tipos novos (`troca.registrada`, `vale.*`, `pessoa.criada_no_caixa`, `orcamento.*`) entram em v1 e são protegidos pelo T13.
- **Regras do upcaster:**
  - é **puro** (não lê o banco), para o Reprocessar dar sempre o mesmo resultado;
  - leva a `versao_origem` até o handler, e **as regras de recusa da versão de origem continuam valendo** para quem veio dela (um
    `venda.finalizada` v1 com `emprestados > 0`, que hoje vai para `erro`, não passa a ser aceito como comodato no Reprocessar);
  - a v1 de `venda.finalizada` e de `vasilhame.movimentado` **nunca sai** de `versoes_schema` dentro da janela de 12 meses (o PDV
    instalado grava sempre a v1).
- **Anúncio no fim da onda.** A versão nova só entra em `versoes_schema` no último bloco da onda (F3-B30 e F3-B53); até lá, o handler
  já a aceita, mas ela fica fora da lista. Um PDV novo diante de uma API antiga continua no v1.
- **O PDV escolhe a versão assim:** a maior versão comum **anunciada**; com `versoes_schema_nuvem` nulo (nenhum handshake depois da
  atualização), **sempre a v1**, e os recursos novos ficam indisponíveis até o primeiro handshake. `RecursoDisponivel(tipo, versao)`
  é o portão de toda tela nova da onda, **inclusive das que não mudam evento nenhum** (suspender, crachá, F6 › acréscimo), porque elas
  gravam ações novas de auditoria.
- **Auditoria com ação desconhecida.** Duas proteções juntas: (1) o PDV só grava as ações novas de auditoria quando o recurso da onda
  está disponível (item acima); (2) a API passa a gravar uma ação desconhecida **vinda do PDV** como `acao_desconhecida`, com o texto
  original (limitado) e um alerta, em vez de recusar o lote inteiro. As ações **reservadas ao servidor** (SEG-B10) continuam
  recusadas. Isso protege também as versões futuras.
- **Ordem de publicação:** a API sempre antes do PDV (SYNC 17.2). Com a D70 o dono implanta à mão; o corpo de cada PR de release diz
  "implantar a API do PR-x antes de publicar o PDV".
- **Chaves que mudam o preço ou o pagamento** (promoções, comodato, vale como pagamento, baixa interna, preço parcelado) têm **trava
  dura** no ERP: só ligam com **0 terminais ativos** abaixo da versão que as entende (lista do F3-B12). O PDV instalado só avisa
  quando está abaixo da mínima (`LoginViewModel.cs:61-73`) e não atualiza sozinho, então a "mínima" não basta: com as promoções
  ligadas e um caixa antigo, cada caixa cobraria um preço. As demais chaves só mostram o aviso "N caixas desatualizados".
- **Uma volta de cursor por release do PDV.** O custo para o caixa é a volta de cursor (migração EF), não o número de arquivos SQL na
  nuvem. Por isso o esquema da nuvem pode vir em várias migrações (0029 a 0031), mas todas as tabelas novas que descem na Fase 3
  entram numa só migração EF `FaseTres`, que volta os cursores de `catalogo`, `pessoas` e `operacao` a 0 na R3. Tabelas só locais do
  caixa (ex.: `vendas_suspensas_locais`, `pessoas_locais`) podem ter migração EF própria, sem volta de cursor.
- **Sem FK nova nas colunas que o PDV envia** (`orcamento_id`, `promocao_id`, `vale_id`, `item_orcamento_id`,
  `trocas.venda_origem_id`, `itens_troca.item_venda_origem_id`): a ordem entre terminais não é garantida e um 23503 recusaria um fato
  consumado. O handler confere e abre alerta. **Antes de anular qualquer coluna, conferir os CHECKs** de `itens_venda`, `vendas` e
  `pagamentos_venda`: o `promocao_id` desconhecido **fica com o id cru** (anular quebraria o `ck_itens_venda_promocao`) e abre
  `PROMOCAO_DESCONHECIDA`; só as colunas com FK (`lote_id`, `vendedor_id`) são anuladas, com o alerta.
- **Nenhuma coluna nova nas tabelas de movimento do PDV** (`vendas`, `itens_venda`, `pagamentos_venda`, `parcelas_venda`,
  `sessoes_caixa`…), sem exceção: elas estão em `TABELAS_MOVIMENTO_PDV` (`esquema-pdv.ts:21-35`) e qualquer mudança regenera o
  `Esquema.g.cs`. Por isso: o gelado fica **dentro** do `preco_unitario` e do `preco_tabela` (PDV 11.4) e a marca "gelado" é só local
  no caixa; a baixa interna é reconhecida pela forma (`pagamentos_venda` → `formas_pagamento.tipo_forma`), sem `vendas.baixa_interna`;
  a situação "Conferida/Divergente" do fechamento é derivada de `conferencias_caixa`, sem mexer no `ck_sessoes_caixa_status` (que
  desce ao caixa).
- **Corrida offline aplica e alerta, nunca recusa** (P6, SYNC 11.6/15.1): vale negativo, devolução acima do vendido, comodato
  negativo, orçamento convertido duas vezes, vendedor inválido, baixa interna misturada. Nunca `erro`, para não travar a fila do
  terminal nem reter o `caixa.fechado` da sessão.
- **Ações novas de auditoria** (`peso_digitado`, `preco_alterado`, `tipo_preco_alterado`, `lote_vencido_liberado`,
  `venda_suspensa`, `venda_recuperada`, `limite_valor_liberado`, `comodato_emprestado`, …) entram todas em `ACOES_AUDITORIA` no
  F3-B3, antes de qualquer PDV que as grave.
- **Ações novas de liberação** (`limite_valor`, `consumo_interno`, `alterar_preco`, `tipo_preco`, `lote_vencido`, `peso_manual`,
  `comodato`, `troca_fora_prazo`, `troca_dinheiro`, `vale_avulso`) só entram como constantes: o campo `liberacoes.acao` é texto livre.
- **Consultas e reservas online** ficam dentro de `/sync/consultas/*` (precedente da decisão 182), com o token do terminal e a
  idempotência por `X-Requisicao-Id` (F3-B6); SYNC 14.4, PDV 16.11, PDV 24.1 e ERP 15.4.4 são corrigidas para essas rotas. O PDV novo
  diante de uma API antiga recebe 404 e cai no caminho offline.
- **Ordem das travas na transação:** a trava global de ordenação de versões (7300001, `fn_versao`) é pega **o mais tarde possível**
  (padrão de `fila-decisao.ts:5`), porque `vales`, `vendas_status_pdv` e `saldos_vasilhame_pessoas` descem e cada push com vale,
  troca ou comodato passa a pegá-la. Exceção: nas chamadas online (F3-B6, SYNC 20.4) a 7300001 é a **primeira** instrução
  (`travaVersao` da rota), antes da linha de `requisicoes_terminal`, cuja FK trava a linha do terminal que o push trava
  depois da 7300001.

**Preços, itens e dinheiro**
- Quantidade do complemento por unidade do item; o adicional entra no `preco_unitario` e no `preco_tabela`.
- Ordem de aplicação do preço: regra 11.3 → adicionais do complemento → gelada → promoções. Promoção não se aplica a componente de
  combo, casco, item de orçamento nem preço manual. Categoria da promoção inclui as subcategorias.
- **Gelada:** o acréscimo está **dentro** do `preco_unitario`, do `preco_tabela` e do `valor_bruto` (o `conferirSomasVenda`,
  `handlers/vendas.ts:175-181`, não teria onde somá-lo à parte); `origem_preco` mantém a origem. A nuvem não guarda a marca.
- O F8 recalcula também a embalagem (vale o menor preço, PDV 11.3.1), resolvendo a divergência com a 11.2.
- O código interno gerado pelo ERP nunca tem o formato da etiqueta de balança (a parte do PLU sempre zero), para o código exato não
  "roubar" uma etiqueta.
- Baixa do complemento pela lista **calculada no caixa** (como a ficha técnica, D17), não pelo cadastro atual da nuvem.
- **Líquido mínimo:** nenhuma regra nova da Fase 3 (promoção, acréscimo ou desconto rateado, restante da devolução, rateio da venda ERP)
  deixa abaixo de R$ 0,01 um item não cancelado que tinha líquido ≥ R$ 0,01 antes dela (a NFC-e recusa desconto ≥ valor do item). O
  "leve 3 pague 2" distribui o desconto entre as linhas sem zerar nenhuma. Uma regra só, no shared e no C#.
- **Arredondamento:** todo arredondamento novo passa por `Core/Numeros/Arredondamento.cs` (C#) e por `dec`/`decTexto` (shared); um
  teste varre o código do PDV e recusa `Math.Round`/`decimal.Round` com decimal fora desse arquivo (o padrão do .NET é o bancário).
  Vale para a etiqueta por valor, a comissão, o rateio e as promoções. Na etiqueta por valor, `valor_bruto` ≠ `preço × quantidade`, e
  nada novo (venda ERP, paridade) exige essa igualdade para `origem_preco = 'balanca'`.
- **Lote vencido** (PDV 10.8): bloqueado; liberação com `pdv.venda.vender_vencido` (supervisor) e motivo.
- **Peso digitado** (PDV 10.7): sem balança configurada (ou com falha), o peso só se digita com `pdv.venda.peso_manual` ou liberação,
  com `peso_digitado = true`, `origem_entrada = 'teclado'` e auditoria `peso_digitado`; `<qtd>*<código>` com produto pesável segue a
  mesma regra. Vale com ou sem a balança serial.
- **Comissão:** `valor_comissao` é a comissão **prevista** no momento da venda e nunca é reescrita (o item finalizado é imutável).
  "Cancelamentos e devoluções estornam" (ERP 15.4.3) fica no cálculo do relatório (Fase 5): exclui venda e item cancelados e desconta a
  parte devolvida (`valor_comissao × quantidade_devolvida ÷ quantidade`).

**Cliente, vale e troca**
- Custo da entrada `TROCA_PDV`: o `custo_unitario` do item de origem (como o estorno, T20); sem venda de origem, o custo médio atual.
- Lote da troca: o dos movimentos da venda de origem; sem origem, sem lote.
- Troca acima do vendido: `quantidade_devolvida` limitada ao vendido, alerta `TROCA_ACIMA_DO_VENDIDO`.
- Devolução parcial repetida: a devolução que zera o item leva o restante (`valor_liquido − Σ devolvido`); nenhuma passa do líquido.
- **Troca × cancelamento da mesma venda:** troca sobre venda já cancelada aplica a parte financeira (vale ou dinheiro, fato consumado),
  **não** dá a entrada da quantidade que o estorno já devolveu e abre `TROCA_DE_VENDA_CANCELADA`. No sentido inverso, cancelar uma venda
  com `quantidade_devolvida > 0` estorna só o vendido menos o devolvido; o ERP bloqueia com "cancele a troca primeiro".
- **Saldo do comodato:** projeção comutativa (Σ dos movimentos, na ordem que chegarem), que pode ficar negativa por um tempo, com o
  alerta `VASILHAME_COMODATO_NEGATIVO`, como o vale. O caixa mostra no mínimo 0. (Limitar a 0 na chegada daria um saldo final errado
  quando a baixa de um caixa chega antes do empréstimo de outro.)
- Vendedor inexistente, excluído ou não vendedor: gravado nulo, alerta `VENDA_VENDEDOR_INVALIDO`.
- Código do cupom de troca: `CT` + loja(2) + caixa(2) + número da venda (12 dígitos, o limite do SEG-B15) + DV Luhn, para um erro de
  digitação não achar outra venda.
- **Troca imediata** (SYNC 9.16, PDV 23.2): o vale de **todo** o crédito sobe dentro do `troca.registrada`; a venda nova paga com ele
  (`tipo_forma = vale`); o restante é o **saldo do mesmo vale**, impresso como vale-troca. **Nunca** sai `vale.emitido` na troca (a
  nuvem contaria a emissão duas vezes). `trocas.venda_nova_id` é preenchida pela nuvem ao aplicar a venda que usa o vale.
- **`vale.utilizado` só para o resgate em dinheiro** (SYNC 9.17), nunca para pagamento de venda; o pagamento baixa pelo
  `venda.finalizada` com o `pagamento_venda_id`, e o `uq_movimentos_vale_pagamento` barra a repetição.
- Cancelamento de troca: só pelo ERP (a SYNC não tem o evento do caixa), com `ESTORNO_TROCA_PDV`, bloqueado se o vale já foi usado.
- Produzido (ficha técnica) devolvido: só o valor, sem volta dos insumos.
- Comodato e saldo de cascos no ERP: só leitura nesta fase.

**Caixa e ERP**
- As vendas suspensas contam no saldo estimado do caixa ("reservado em venda suspensa").
- **Baixa interna:** valor integral, sem desconto nem acréscimo, sem troco nem gaveta; fora dos totais de venda e dentro da Movimentação
  de estoque. A nuvem decide pela forma **do pagamento recebido** e, se vier misturada com forma comum ou com forma divergente do
  cadastro, **aplica como venda comum** com o alerta `BAIXA_INTERNA_MISTURADA` (nunca recusa). Para o Reprocessar dar sempre o mesmo
  resultado, o ERP **não deixa mudar o `tipo_forma`** de uma forma que já foi usada em alguma venda.
- Venda ERP: `data_movimento` = momento do Finalizar, `dia_operacional` pelo corte da loja (D7); número reservado no rascunho
  (rascunho excluído deixa o número sem uso, ERP 15.4.2); não cobra nem empresta casco automaticamente.
- `vendas_status_pdv` é gravada na mesma transação de qualquer mudança feita fora do terminal de origem (`registrarStatusPdv`) e desce
  pelo **caixa** da venda (`caixa_id`, imutável), não pelo terminal: assim o terminal que substituiu outro no mesmo caixa recebe o status
  das vendas antigas.
- Impressão de orçamento, venda, recibo, crachá A4 e comprovante de reforço e sangria: pela impressão do navegador, como na Fase 2 (sem
  motor de PDF na API).
- Editor de template: `@mantine/tiptap` (versão fixada no lock), HTML sanitizado no servidor por lista de tags, variáveis com escape.
- A conferência do fechamento só existe para sessão com `fechamentos_caixa`; a sessão "fechada pela nuvem" sem o fechamento mostra o
  motivo.
- **Crachá** (PDV 31.3): código de barras com o código do usuário; o PIN continua obrigatório (perder o crachá não basta).
- Fixtures sempre inventadas (repositório público, D60): CPF de teste, nomes e códigos fictícios.

**Testes (valem para todo bloco)**
- Todo bloco com migração roda a integração nos PostgreSQL **16 e 18** (OP-B1).
- Todo endpoint novo do ERP testa a permissão (403) e a **loja não permitida**.
- Todo bloco que move estoque (inclusive o cancelamento e a devolução pelo ERP e a venda ERP) termina com `recalcular-saldos`
  **idêntico** ao saldo incremental.
- Os blocos do PDV que mudam a sincronização rodam a matriz de compatibilidade com **o PDV mais antigo em uso** (tag compilada contra a
  API nova, `test/e2e-pdv`).

---
## O que a sessão não testa (D70) e como cobrir

**Só no Windows** (nem a sessão nem o servidor ARM da Oracle cobrem):
- instalador Inno e Velopack: instalação por usuário, aplicar a atualização, voltar à versão anterior, mutex, atalho, permissões da
  pasta `%ProgramData%`;
- Smart App Control e Authenticode;
- spooler e impressora térmica reais, gaveta;
- balança serial (porta COM);
- leitor de código de barras real com o crachá Code128 (velocidade do "teclado");
- desempenho no hardware do caixa (as metas da PDV 32.4).

**Como cobrir:**
- tudo o que é lógica fica atrás de interfaces (`IUpdateManager`, `IPortaSerial`, `IImpressora`) testadas com dublês na sessão;
- cada release (R3, 0.14.1, R4, R5, R6) traz um **roteiro manual numerado**, que o dono roda no caixa da loja Treino ou no PC
  Windows dele, com a tabela "coberto na sessão / coberto no roteiro / não coberto" no corpo do PR;
- antes da R3, da R4 e da R5, o dono roda também o `dotnet test` do PDV no Windows dele (a CI Windows está parada pela D70), pelo
  roteiro do OP-B3;
- os números de desempenho medidos na sessão são **referência**; a medida que vale é a repetida no caixa da Treino;
- nenhum item da Definição de pronto que dependa do Windows é marcado como feito sem o roteiro **executado e registrado**.

**Servidor da Oracle** (pela F3-Q36): ver a pergunta. Resumo das ressalvas que entram nos blocos que o usam (F3-B66, F3-B70):
- a produção usa o Cloud SQL, acessado pela rede a partir da VPS, e a trava 7300001 fica presa durante cada ida e volta. Com o
  Postgres local a medida sai otimista; o F3-B66 mede antes a latência VPS → Cloud SQL (pelo dono, na VPS, sem imprimir nada da VPS
  no repositório) e a injeta no servidor de homologação (`tc netem` ou toxiproxy);
- o ARM de 2 núcleos não equivale à CPU da VPS: os números das duas máquinas são registrados e não se comparam em valor absoluto;
- as imagens Docker são montadas para arm64 no próprio servidor (o `sharp` e o `argon2` têm binários arm64); a produção é x86.

---

## PRs

Cada PR termina com a revisão de segurança do PR inteiro (D63) e o `scripts/verificar-local.sh` completo verde (D70), com a tabela no
corpo. Merge só com a liberação do dono. A API do PR vai à produção **antes** da release do PDV que a usa.

| PR | Blocos | Conteúdo | Release do PDV |
|---|---|---|---|
| **PR-17 "Base do protocolo e do esquema da Fase 3"** | F3-B1..B8 | Esquema da nuvem em 3 migrações, upcasters e versões, código do vale e do cupom de troca, idempotência online, fluxos e espelho do PDV numa só volta de cursor, spike do Velopack | código da `FaseTres` entra no PDV (sai na R3) |
| **PR-18 "ERP: conferência, cancelamento e parâmetros"** | F3-B9..B12 | Conferência do fechamento e comprovantes de reforço e sangria, núcleo de estorno, cancelar venda pelo ERP (inclusive de caixa fechado), Parâmetros-PDV, aba Vendas e trava por versão | — (o F12 lendo o status sai na R3, F3-B29) |
| **PR-19 "Caixa: atalhos, complementos e preços"** | F3-B13..B18 | Atalhos configuráveis e Nova venda, complementos (nuvem e caixa), preço digitado, alteração de preço, acréscimo, F8, gelada, parcelado | R3 |
| **PR-20 "Caixa: lote, etiqueta e peso"** | F3-B19..B22 | Critérios escritos, lote e vencidos, etiqueta de balança e peso digitado, balança serial (condicional à F3-Q1) | R3 |
| **PR-21 "Caixa: balcão" + release R3** | F3-B23..B30 | Suspender, limites, painel com estoque e foto, logotipo no cupom, consulta e tabela de preços, crachá, vendedor, F12 com o status da nuvem; anúncio da v2; **PDV 0.14.0 pelo instalador atual** | **R3 = 0.14.0** |
| **PR-22 "Atualização automática" + passagem** | F3-B31..B33 | Canal por terminal e carência, atualizador com manifesto assinado, empacotamento e a passagem do Inno para o Velopack (condicional à F3-Q33 = A) | **0.14.1** (só a passagem) |
| **PR-23 "Promoções"** | F3-B34..B36 | Cadastro no ERP, motor puro no PDV, promoções na venda, no pagamento, no cupom e na consulta de preço | R4 |
| **PR-24 "Cliente no caixa e comodato"** | F3-B37..B40 | `pessoa.criada_no_caixa` com mescla, cadastro rápido, comodato na nuvem e no caixa | R4 |
| **PR-25 "Vales e trocas: nuvem"** | F3-B41..B45 | `vale.*` e saldo, vale como pagamento e estorno, `troca.registrada` (origem conhecida; origem desconhecida e venda cancelada), consultas e reservas online | — (API primeiro) |
| **PR-26 "Vales e trocas: caixa e ERP"** | F3-B46..B50 | Vale como pagamento, Ctrl+T, operações avulsas de vale, impressões e crédito do casco, tela de Vales e alertas | R4 |
| **PR-27 "Baixa interna" + release R4** | F3-B51..B53 | Baixa interna (condicional à F3-Q32), anúncio da v3; **PDV 0.15.0** | **R4 = 0.15.0** |
| **PR-28 "Venda no ERP e devolução"** | F3-B54..B59 | Cálculo decimal no shared, templates, rascunho, finalizar, telas, devolução no ERP | — |
| **PR-29 "Orçamentos" + release R5** | F3-B60..B65 | Orçamentos na nuvem, no ERP, conversão, F9 no caixa, envio (condicional); **PDV 0.16.0** | **R5 = 0.16.0** |
| **PR-30 "Escala, ressincronização e fechamento"** | F3-B66..B70 | Catálogos grandes e longo offline (com a meta de 150 ms), ressincronização em sombra (nuvem e caixa, **PDV 0.17.0**, ou junto da R5 se o dono preferir), material de treinamento, teste com dois caixas e fechamento da fase | R6 = 0.17.0 |

**Por que esta ordem:**
- O PR-17 tira do caminho tudo o que mexe em protocolo e em esquema, para que os PRs seguintes sejam funcionais e o caixa instalado
  continue sincronizando o tempo todo. O esquema vem **antes** dos blocos que o usam (a idempotência do F3-B6 precisa da tabela
  `requisicoes_terminal` do F3-B1).
- O PR-18 entrega cedo o que o dono espera desde a 1C (cancelar venda de caixa fechado, PC-1/D23) e não depende do caixa novo.
- O PR-19 começa pelos atalhos configuráveis: todas as teclas novas da fase passam por eles.
- A R3 sai pelo **instalador atual** (o Inno, montado pelo OP-B3 ou no PC Windows do dono). A passagem para o Velopack (PR-22) é uma
  versão **sem nenhuma mudança de venda** (0.14.1), feita caixa por caixa: um problema de instalação não se confunde com um defeito
  de venda, e o PR-22 sai do caminho crítico da R3. Sem o PR-22 (F3-Q33 B ou C), a R4 em diante continuam pelo instalador atual.
- Vales e trocas na nuvem (PR-25) entram antes do caixa (PR-26), e a v3 só é anunciada no fim da onda (F3-B53).
- A venda no ERP (PR-28) vem depois dos vales, porque a devolução no ERP emite vale; os orçamentos (PR-29) dependem do rascunho da
  venda ERP para a conversão.

---

## Blocos

### PR-17 – Base do protocolo e do esquema da Fase 3

**Antes do primeiro bloco:** o dono confere no ERP › Terminais a versão de cada caixa ativo (ver o cabeçalho) e a lista vai para o
corpo do PR-17.

#### F3-B1 – Esquema da nuvem 1: vales, trocas, reservas e requisições (MD 3.13, 3.11.3; SYNC 20.4)
- **Tamanho:** M · **Rigor:** completo (migração, dinheiro)
- **Objetivo:** as tabelas do dinheiro que muda de mão (vale e troca) e o registro das requisições online, com os checks da MD.
- **Entregas:**
  - **tabelas:** `trocas` (`seq_codigo_trocas`), `itens_troca`, `vales` (`ck_vales_codigo ~ '^VC[0-9]{12}$'`, `uq_vales_codigo`,
    saldo sem `CHECK >= 0`; `conferencia_hash` anulável pela F3-Q25), `movimentos_vale` (`uq_movimentos_vale_pagamento`,
    `ck_movimentos_vale_valor <> 0`), `reservas_vale` (`uq_reservas_vale_pagamento`), `requisicoes_terminal (terminal_id,
    requisicao_id, endpoint, status_http, resposta jsonb, criada_em, concluida_em)` com pk `(terminal_id, requisicao_id)`;
  - **triggers:** `fn_versao` em `vales` (desce) e `fn_versao_local` nas que só sobem; imutabilidade de `trocas`, `itens_troca` e
    `movimentos_vale` que **deixa livres** `versao`, `atualizado_em` e, em `trocas`, `venda_nova_id` (preenchida depois pelo handler
    da venda, SYNC 9.16), `status` e as colunas de cancelamento;
  - **trigger novo em `itens_venda`:** com a venda finalizada ou cancelada (consulta ao pai), só mudam `quantidade_devolvida`,
    `versao` e `atualizado_em` (e as colunas de custo, **se** algum código as atualizar: hoje nenhum `update(itensVenda)` em `src`;
    o bloco confere com grep e com o `recalcular-saldos` e a compensação do Definir); com a venda em estado aberto (rascunho do ERP,
    F3-B56), inclusão, alteração e exclusão continuam livres;
  - **seed por SQL** para as empresas existentes (padrão das decisões 78/196): `ESTORNO_VASILHAME_EMPRESTADO` e `ESTORNO_BAIXA_INTERNA`;
    a numeração `vale` do caixa 0 (dono `nuvem`) em `garantirNumeracoesLoja` e a carga nas lojas existentes;
  - **diagnóstico antes da implantação** (não dentro da migração): um comando só de leitura no `preparar` do OP-B2 conta
    `pagamentos_venda.vale_id`, `vendas.orcamento_id` e `itens_venda.promocao_id` preenchidos em cada banco de empresa (deve dar zero;
    o resultado sai só na tela da VPS). Uma `raise` dentro da migração deixaria um banco de empresa migrado e outro não.
- **Arquivos:** `apps/api/src/database/empresa/schema/{vendas,caixa}.ts`, `schema/trocas-vales.ts` (novo),
  `apps/api/drizzle/empresa/0029_fase3_vales_trocas.sql` com snapshot e journal (drizzle-kit), `apps/api/src/database/seed/dados/tabelas-md.ts`,
  `apps/api/src/lojas/numeracoes.ts`, `infra/producao/` (diagnóstico do `preparar`).
- **Migrações:** empresa `0029` (provisória).
- **Testes:** `test:sync-triggers` (`fn_versao` + `ix_vales_versao`); integração do esquema (checks, imutabilidade com as colunas
  livres, `ck_vales_codigo`, o trigger de `itens_venda` com venda finalizada e com rascunho); a migração aplicada numa base com vendas
  das Fases 1 e 2 sem tocar nos dados; PostgreSQL 16 e 18.
- **Pronto:** migração aplicada numa empresa de teste com dados das Fases 1 e 2; nenhum dado existente muda.
- **Depende de:** PR-16 (OP-B1) juntado.

#### F3-B2 – Esquema da nuvem 2: promoções, orçamentos, status, conferência e templates (MD 3.6.11, 3.11.1, 3.11.9, 3.12.4, 3.1.3)
- **Tamanho:** M · **Rigor:** completo (migração)
- **Entregas:**
  - **tabelas:** `promocoes`, `promocoes_itens`, `orcamentos` (`seq_codigo_orcamentos`, `valido_ate` gerada,
    `reservado_terminal_id`/`reservado_ate`), `itens_orcamento`, `vendas_status_pdv` (`caixa_id` e `terminal_id` imutáveis,
    `ix_vendas_status_pdv_caixa_id_versao`), `conferencias_caixa` (`uq_conferencias_caixa_fechamento`), `conferencias_caixa_formas`;
  - **triggers:** `fn_versao` nas que descem (`promocoes`, `promocoes_itens`, `orcamentos`, `itens_orcamento`, `vendas_status_pdv`);
    exclusão física proibida em `promocoes` (padrão da 0028); filtro imutável de `orcamentos.loja_id` e `vendas_status_pdv.caixa_id`
    (MD 6.4 regra 2);
  - **comodato comutativo:** tira o `ck_saldos_vasilhame_pessoas_quantidade` (o saldo pode ficar negativo por um tempo, Padrões). Se o
    gerador do `Esquema.g.cs` levar o CHECK ao espelho, a mudança entra na `FaseTres` (F3-B7);
  - **índice** `uq_templates_documentos_padrao` (`nulls not distinct (tipo, loja_id) where padrao and excluido_em is null`)
    [**feito no F3-B2:** o índice já existia desde a 0002, então não houve o que desmarcar; o teste confere a definição e o
    efeito, decisão 221], **depois**
    de desmarcar os "padrão" duplicados do mesmo tipo e loja (fica o mais antigo), com uma linha de auditoria por desmarcação.
- **Arquivos:** `schema/produtos.ts`, `schema/orcamentos.ts` (novo), `schema/vendas.ts`, `schema/caixa.ts`, `schema/pessoas.ts`,
  `apps/api/drizzle/empresa/0030_fase3_promocoes_orcamentos.sql` (drizzle-kit).
- **Migrações:** empresa `0030` (provisória).
- **Testes:** `test:sync-triggers`; integração do esquema (checks, filtro imutável, comodato negativo aceito); **a migração sobre uma base
  com dois templates "padrão" do mesmo tipo e loja** (sobra um, com a auditoria); PostgreSQL 16 e 18.
- **Pronto:** migração aplicada numa empresa de teste com dados das Fases 1 e 2.
- **Depende de:** F3-B1.

#### F3-B3 – Permissões, perfis, chaves e ações de auditoria da fase (shared)
- **Tamanho:** P/M · **Rigor:** completo (permissões)
- **Entregas:**
  - `promocoes.ver/criar/editar/excluir` e `pdv.vasilhame.comodato` no catálogo e nos perfis padrão (sem ampliar o acesso de ninguém);
    o menu de Promoções passa de `produtos.ver` para `promocoes.ver`;
  - **migração de dados:** quem hoje tem `produtos.editar` num **perfil personalizado** ganha `promocoes.ver/criar/editar` (senão perde
    o menu que já via), com auditoria;
  - a chave nova `pdv.vasilhame_comodato_max_por_cliente` e, pela F3-Q25, `pdv.vale_exige_conferencia` (a
    `pdv.limite_padrao_cliente_pdv` **já existe**, `configuracoes.ts:199`); todas as `ACOES_AUDITORIA` e as constantes de liberação da
    fase; `COLUNAS_FORA_DO_PAYLOAD` das tabelas novas;
  - **matriz perfis × permissões novas:** confere que os perfis de sistema que liberam (Supervisor de caixa, Encarregado,
    Administrador) recebem as `pdv.*` novas que a especificação dá ao supervisor, e que `pdv.troca.devolver_dinheiro` fica com o
    Administrador e o Encarregado (F3-Q20).
- **Arquivos:** `packages/shared/src/{permissoes,perfis-padrao,configuracoes,enums}.ts`, `apps/erp-web/src/menu.ts`,
  `apps/api/drizzle/empresa/0031_fase3_permissoes.sql`.
- **Migrações:** empresa `0031` (só dados; provisória).
- **Testes:** perfis padrão; a migração de dados num perfil personalizado com e sem `produtos.editar`; vitest do menu.
- **Pronto:** nenhuma permissão ampliada além da regra acima; o menu de Promoções aparece para quem já editava produtos.
- **Depende de:** F3-B2.
- [**Feito no F3-B3** (README da API › decisão 222): a regra da migração vale para **todo** perfil com `produtos.editar`
  (o de sistema também, com a auditoria) e para os ajustes por usuário (concedida e negada, senão o usuário com
  `produtos.editar` negada passaria a criar promoções); o perfil de sistema que a empresa tirou de produtos fica com a
  linha de promoções já excluída, que o seed respeita. O Estoquista ganha ver/criar/editar pela mesma regra; como ele
  não tem `produtos.alterar_preco`, o F3-B34 tem de aplicar às promoções a trava de preço do cadastro do produto
  (`geral.altera_preco_produto_erp` = Não, `trava-preco.ts`; ver as entregas do F3-B34). Comodato
  no Operador (a D84 é "até o limite, sem o supervisor"; "só o supervisor" seria a opção D) e, por ele, no Supervisor e
  no Encarregado. `pdv.pagamento.consumo_interno` no Supervisor (✔ na PDV 31.2 e D102). As ações de auditoria entram
  em `ACOES_AUDITORIA_FASE3`, espalhada em `ACOES_AUDITORIA`; o `CatalogosNuvem` do PDV continua sem elas até o
  F3-B4. Constantes de liberação em `ACOES_LIBERACAO_FASE3`. A `acao_desconhecida` fica para o F3-B4.]

#### F3-B4 – Upcasters, versões por tipo e a auditoria desconhecida (SYNC 17.5)
- **Tamanho:** M · **Rigor:** completo (protocolo)
- **Objetivo:** a API aceita várias versões de payload por tipo, com o upcast em toda aplicação e no Reprocessar, sem mudar nenhum tipo
  ainda; o PDV escolhe a versão com segurança.
- **Entregas:**
  - `HandlerEvento` ganha `versoes` com `upcast` encadeado (vN → vN+1 → atual), **puro**, levando a `versao_origem` ao handler (as
    regras de recusa da versão de origem continuam valendo);
  - `eventos_recebidos.payload` continua o original; versão acima da maior conhecida continua `SCHEMA_DESCONHECIDO` (transitório);
  - o reaplicar da fila de decisão usa o mesmo caminho;
  - `versoesSchemaAceitas()` passa a listar **só as versões anunciadas** (formato `Record<string, number[]>` mantido,
    `eventos.ts:156`); a versão aceita pelo handler e ainda não anunciada fica fora da lista; a v1 nunca sai;
  - **auditoria:** ação desconhecida vinda do PDV gravada como `acao_desconhecida` com o texto original (até 64 caracteres) e um
    alerta; as reservadas ao servidor continuam recusadas;
  - no PDV, o `GravadorOutbox` grava a maior versão comum anunciada; com `VersoesSchemaNuvem` nulo, a v1;
    `RecursoDisponivel(tipo, versao)` passa a ser o portão das telas novas e das ações novas de auditoria.
- **Arquivos:** `apps/api/src/sync/aplicacao.ts`, `sync/handlers/comum.ts`, `sync/eventos.ts`, `terminais/fila-decisao.ts`,
  `packages/shared/src/sync/eventos.ts` (`CONTRATOS_EVENTOS[...].versoes`), `apps/pdv/src/GenesisPDV.Data/Outbox/GravadorOutbox.cs`.
- **Migrações:** nenhuma; `versoes_schema` não muda neste bloco.
- **Testes:**
  - unitário com um tipo de teste v1/v2 injetado: v1 aplica pelo upcast, v3 é transitório, a v2 não anunciada fica fora da lista;
  - integração: evento v1 em `erro` por bug do upcaster, upcaster corrigido e Reprocessar resolvem; um v1 recusado pela regra da v1
    continua recusado depois do upcast;
  - `versoesSchemaAceitas()` contém sempre a v1 de `venda.finalizada` e de `vasilhame.movimentado`;
  - lote de auditoria com uma ação desconhecida: aplicado, com a linha `acao_desconhecida` e o alerta; com uma ação reservada ao
    servidor: recusado como hoje;
  - `contratos-eventos.spec.ts`: toda fixture vN passa no upcast até a atual;
  - Sync.Tests do PDV: grava a maior versão comum; com o `VersoesSchemaNuvem` nulo, grava a v1 e o recurso fica indisponível.
- **Pronto:** um tipo com duas versões aplica as duas, o payload gravado é o original e o PDV escolhe a versão certa. Decisão 215 no
  README da API e 93 no do PDV.
- **Depende de:** F3-B3 (as ações de auditoria no catálogo).
- [**Feito no F3-B4** (README da API › decisão 223, do PDV › 96 e do ERP › 87): o `CatalogoHandlers` continua tipo → versão →
  handler; o handler ganha `versoes` (schema do contrato + `upcast` para a seguinte) e `anunciada`. A falha da conversão
  (schema da versão, payload convertido inválido ou exceção do upcaster) é `PAYLOAD_INVALIDO`, nunca `ERRO_INTERNO`; o
  Reprocessar recebe o catálogo pela `FilaDecisao`. A `acao_desconhecida` leva o texto original na frente da descrição, é
  reservada ao servidor e abre o `AUDITORIA_ACAO_DESCONHECIDA` (aviso, um por terminal e ação, com o "Ciente" no detalhe do
  terminal); o lote aceita a `acao` até 64 caracteres. No PDV, `VersaoParaGravar`, `RecursoDisponivel` e as ações da fase pelo
  recurso da onda (`CatalogosNuvem.AcoesAuditoriaFase3`: a R3 pelo `venda.finalizada` v2, o comodato pelo
  `vasilhame.movimentado` v2); nenhuma fábrica de evento muda ainda (todas na v1). Versão do PDV mais antiga em uso tratada
  como 0.10.0 até a lista do dono, que vai no corpo do PR-17.]

#### F3-B5 – Código do vale e do cupom de troca, e a janela do protocolo (SYNC 13.4, 17.2)
- **Tamanho:** P/M · **Rigor:** completo (dinheiro e protocolo)
- **Objetivo:** a regra dos códigos `VC…` e `CT…` num ponto só, com vetores para o C#.
- **Entregas:**
  - `packages/shared/src/vales.ts`: `montarCodigoVale(lojaCodigo, numeroCaixa, sequencial)`, `conferirCodigoVale`, Luhn sobre os 11
    dígitos, caixa `00` para o ERP, limites de loja (1–99), caixa (0–99) e `VALE_NUMERO_MAXIMO`; `montarCupomTroca`/`conferirCupomTroca`
    (`CT` + loja + caixa + número com 12 dígitos + DV Luhn); o código de conferência do vale (F3-Q25: 4 dígitos aleatórios e o
    resumo com sal);
  - vetores `packages/shared/testes/sync/vale.codigo.vetores.json`, lidos também por um teste xUnit do PDV;
  - política da janela de protocolo (atual e anterior por 12 meses; push até 18) documentada e testada com `X-Genesis-Protocolo: 0`.
- **Arquivos:** `packages/shared/src/vales.ts` (novo), `apps/api/src/sync/terminal.ts`, `apps/pdv/tests/GenesisPDV.Core.Tests` (vetores).
- **Migrações:** nenhuma.
- **Testes:** os vetores (exemplo da SYNC: loja 1, caixa 2, sequencial 8 → `VC010200000080`; DV errado recusado; caixa 100 recusado;
  `CT` com um dígito trocado recusado).
- **Pronto:** vetores verdes na API e no PDV. (O `atualizar_ate` do heartbeat fica todo no F3-B31.)
- **Depende de:** —.
- [**Feito no F3-B5** (README da API › decisão 224, do PDV › 97): o resumo da conferência é
  `pbkdf2-sha256$<iterações>$<sal>$<resumo>` (PBKDF2-HMAC-SHA-256 sobre `<código do vale>:<4 dígitos>`, sal de 16 bytes,
  100.000 iterações; a conferência aceita de 10.000 a 1.000.000), pela Web Crypto no shared e pela BCL no Core
  (`GenesisPDV.Core/Vales/CodigoVale.cs`); o F3-B41 usa o formato (a MD 3.13.2 já aponta para ele). A leitura do código
  tira os espaços e aceita o prefixo minúsculo, e confere o DV antes dos limites (motivos `FORMATO`, `DIGITO_VERIFICADOR`,
  `LOJA`, `NUMERO`). A janela do protocolo é `JANELA_PROTOCOLO` (o atual e a data em que cada anterior deixou de sê-lo) com
  `protocoloAceito`/`protocoloMinimo`; o `X-Genesis-Protocolo: 0` passa de 400 a 426, o ausente continua 400. Versão do
  PDV mais antiga em uso tratada como 0.10.0 até a lista do dono, que vai no corpo do PR-17 (todas mandam o protocolo 1).]

#### F3-B6 – Idempotência das requisições online (SYNC 20.4)
- **Tamanho:** M · **Rigor:** completo (protocolo, concorrência)
- **Objetivo:** um canal online que altera estado e pode ser repetido sem efeito duplo, base das reservas de vale e de orçamento.
- **Entregas:**
  - helper da API para os endpoints que alteram estado: insere em `requisicoes_terminal` **no começo da mesma transação do efeito**
    (`on conflict` esperando a linha da outra transação), executa o efeito e grava a resposta **no mesmo commit**; a repetição devolve
    a resposta gravada; de outro terminal, isolada; retenção de 24 h limpa pela tarefa por minuto;
  - PDV (`GenesisPDV.Sync/Cliente`): repetir com o mesmo id depois de um timeout.
- **Arquivos:** `apps/api/src/sync/consultas.ts` (ou `sync/online/`), `sync/sync.controller.ts`, `sync/terminal.ts`,
  `packages/shared/src/sync/contratos.ts`, `apps/pdv/src/GenesisPDV.Sync/Cliente/`.
- **Migrações:** nenhuma (a tabela é do F3-B1).
- **Testes:** integração com um endpoint de teste chamado duas vezes com o mesmo `X-Requisicao-Id` **em sequência e ao mesmo tempo**
  (um efeito, a mesma resposta), de outro terminal e depois da expiração; Sync.Tests da repetição depois de um timeout.
- **Pronto:** o mecanismo pronto e documentado na SYNC 20.4 e no README da API.
- **Depende de:** F3-B1.
- [**Feito no F3-B6** (README da API › decisão 225, do PDV › 98): `sync/online/idempotencia.ts` (`IdempotenciaOnline`),
  `sync/atendimento.ts` (`atenderOnline`, endpoint `online` com o hardware) e a tarefa por minuto
  `sync/online/manutencao-online.ts` (fila `genesis-manutencao-online`, onde a expiração das reservas do F3-B45 entra).
  Códigos novos `409 REQUISICAO_EM_ANDAMENTO` (a espera de 10 s pela original vencida, `Retry-After: 1`) e
  `422 REQUISICAO_DIVERGENTE` (o mesmo id com outra rota ou outro pedido). Só o sucesso fica gravado; a primeira resposta
  e as repetições saem do mesmo `jsonb`. No PDV, `ChamadaOnline.AlterarComRepeticaoAsync` (3 tentativas com o mesmo id).
  O limite de 120/min por terminal (SYNC 20.3) entra com as rotas do F3-B45. Versão do PDV mais antiga em uso tratada
  como 0.10.0 até a lista do dono, que vai no corpo do PR-17 (nada muda para o instalado).]

#### F3-B7 – Fluxos de pull da Fase 3 e o espelho do PDV numa só volta de cursor (SYNC 6.1, 16.3, 17.4)
- **Tamanho:** M/G · **Rigor:** completo (sincronização)
- **Objetivo:** o caixa novo recebe promoções, vales, orçamentos e o estado das suas vendas alteradas fora dele; o PDV instalado
  continua sincronizando sem perceber.
- **Entregas:**
  - `REGISTRO_FLUXOS`: `catalogo` + `promocoes`/`promocoes_itens` (todas as linhas); `pessoas` + `vales` (filtro da F3-Q19);
    `operacao` + `orcamentos` (`loja_id = X`), `itens_orcamento` (pelo pai) e `vendas_status_pdv` (`caixa_id = C and atualizado_em >
    now() − 90 dias`, pelo **caixa** do terminal, para o terminal substituto receber o status das vendas antigas);
  - **purga local no PDV** pelo mesmo critério dos filtros por tempo (vale vencido ou zerado há mais de 90 dias; status com mais de 90
    dias), no padrão da purga do SEG-B13: uma linha que sai da janela pelo relógio não ganha versão nova e nunca "desceria" a saída;
  - corrigir `TEMPLATES_PDV` (`recibo_venda`, `orcamento_*` descem; `recibo_receber` conforme a MD 3.1.3);
  - `Esquema.g.cs` regenerado; entidades do PDV; migração EF **`FaseTres`** que volta os cursores de `catalogo`, `pessoas` e
    `operacao` a 0 (o restante do estado preservado). Na R3, a volta de cursor é só essa; a publicação de `ressincronizar_fluxo` por
    migração da nuvem começa no F3-B67.
- **Arquivos:** `apps/api/src/sync/fluxos.ts`, `apps/api/src/database/esquema-pdv.ts`, `apps/pdv/src/GenesisPDV.Data/{Esquema.g.cs,
  PdvDbContext.cs,Entidades/*,Migrations/*,Manutencao/*}`, `apps/api/test/e2e-pdv/`.
- **Migrações:** EF `FaseTres` no PDV; nenhuma na nuvem.
- **Testes:**
  - integração: o orçamento da loja 2 não desce ao terminal da loja 1; a linha de status de 91 dias não desce; o teto avança com o
    fluxo vazio; o **terminal substituto** do mesmo caixa recebe o status das vendas do terminal antigo;
  - `pnpm --filter api verificar:esquema-pdv`; `EsquemaNuvemTests`; `AplicadorPullTests` com as tabelas novas;
  - `MigracaoFaseTresTests`: só os três cursores voltam, sobre um banco do PDV mais antigo em uso, com dados;
  - Data.Tests da purga local (vale zerado há 91 dias some; o de 89 fica; o vale criado localmente e ainda não confirmado nunca some);
  - **compatibilidade:** o PDV compilado da tag do mais antigo em uso (e do `pdv-v0.13.0`) puxa da API nova, ignora as tabelas e o
    cursor avança (`test/e2e-pdv`).
- **Pronto:** o PDV novo recebe as linhas no SQLite; o PDV instalado continua sincronizando e vendendo.
- **Depende de:** F3-B2.
- [**Feito no F3-B7** (README da API › decisão 226, do PDV › 99): a `FaseTres` volta **quatro** cursores — o
  `configuracao` também, porque a correção do `TEMPLATES_PDV` passa a descer `recibo_venda` e `orcamento_*`, cujas linhas
  do seed são antigas — e apaga as cópias locais do `recibo_receber`, que saiu do filtro (MD 3.1.3). A janela dos vales
  (D90) é "mudou nos últimos 90 dias **ou** ainda utilizável (ativo, com saldo, vencido há no máximo 90 dias)", e a purga
  local é o complemento exato, que também segura o vale de venda ou evento local em curso. A `valido_ate` do orçamento
  desce como gerada e o SQLite a calcula. O e2e do PDV não tem o status de venda (precisa de uma venda de terminal): fica
  na integração. A matriz com o PDV das tags é o `apps/api/test/e2e-pdv/compatibilidade.sh` (local); a lista de versões
  do dono vai no corpo do PR-17.]

#### F3-B8 – Spike do Velopack sem o Actions
- **Tamanho:** M · **Rigor:** enxuto (documentação e protótipo descartável), com critérios de "segue / não segue"
- **Objetivo:** responder com teste o que o PR-22 precisa. O Velopack confere o sha do feed, mas **não** tem assinatura própria nem volta
  automática depois de uma migração que falhou, e as duas coisas são da Definição de pronto.
- **Critérios (todos precisam passar para o PR-22 começar):**
  - (a) `vpk` empacotando para Windows a partir do Linux, com a versão fixada;
  - (b) manifesto assinado (Ed25519) com o sha256 dos pacotes completo e delta, conferido pelo app **antes** de aplicar;
  - (c) volta local ao pacote anterior guardado em cache, disparada **só** pelo próprio app depois de uma falha de migração, nunca
    por ordem remota, com uma "versão mínima permitida" dentro do manifesto assinado (contra o ataque de voltar a uma versão velha);
  - (d) convivência com o Inno (mutex `Global\GenesisPDV.Instancia`, atalho de inicialização) e os dados no `%ProgramData%\GenesisPDV`.
  - (b) e (c) **comprovados num Windows** pelo roteiro do dono; sem isso, o PR-22 não começa e a F3-Q33 volta ao dono.
- **Arquivos:** README do PDV (decisão nova) e `docs/planos/operacao-sem-actions-plano.md` (OP-B3 ampliado). Nenhum código de produção.
- **Migrações:** nenhuma.
- **Testes:** um pacote de teste gerado na sessão; o roteiro do Windows com o resultado de (b) e (c) registrado.
- **Pronto:** decisão registrada, com o desenho do F3-B32/B33 confirmado ou ajustado.
- **Depende de:** —.
- [**Feito no F3-B8** (README do PDV › decisão 100; `operacao-sem-actions-plano.md` › OP-B3 ampliado): protótipo
  descartável em `apps/pdv/instalador/velopack-spike/` (fora do `GenesisPDV.slnx`; sai no F3-B33). (a) **comprovado na
  sessão** com o vpk 1.2.161 fixo, sem Wine (só o `zstd`). (b) o manifesto é assinado no formato SSHSIG do
  `ssh-keygen -Y sign` (Ed25519, o OpenSSH que já vem no Windows: o dono não instala nada), conferido por um
  `IUpdateSource` na frente do `UpdateManager` antes de qualquer download, com o piso da mínima permitida que só sobe.
  (c) a volta pelo pacote guardado na pasta própria, com o banco restaurado e a versão que falhou recusada localmente;
  a volta fica "em andamento" (a pendente e o backup mantidos) até a versão anterior abrir, e se repete sem migrar se a
  que falhou abrir de novo; a mínima permitida do manifesto nunca é a versão publicada (regra do F3-B31).
  (d) instalação por usuário, sem administrador, o mutex do app visto entre as duas instalações e os dados em
  `%ProgramData%` intocados. **Ensaio no Wine verde** (`ensaiar-no-wine.sh --com-inno`, com o 0.13.0 do Inno instalado).
  Achados que ajustam o F3-B32: o completo remontado pelos deltas tem outro sha256 (os mesmos arquivos em outro zip),
  então o manifesto leva o sha256 de cada arquivo de dentro do completo; o Velopack apaga o pacote instalado quando um
  download é recusado e aplica sozinho na abertura o mais novo da pasta, e o `UpdateExe.Apply` aplica o mais novo quando
  o pacote pedido não está na pasta. **Pendente:** o `ROTEIRO-WINDOWS.txt` no Windows do dono (o pacote
  `velopack-spike-roteiro.zip` gerado pelo `gerar-pacotes-teste.sh`), que decide se o PR-22 começa; a lista de versões
  dos caixas do dono vai no corpo do PR-17 (até lá, o mais antigo em uso é tratado como 0.10.0; nada muda para ele
  neste bloco).]

### PR-18 – ERP: conferência, cancelamento e parâmetros

#### F3-B9 – Conferência gerencial do fechamento e comprovantes de reforço e sangria (ERP 14.9, 15.2, 15.3; MD 3.12.4)
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Objetivo:** o dono confere cada fechamento por forma de pagamento e a sessão aparece como Conferida ou Divergente; reforço e sangria
  ganham o comprovante impresso.
- **Entregas:**
  - shared: `conferirSessaoSchema` (valor por forma em texto decimal, observação até 2.000), `situacaoConferencia()` com a tolerância
    (F3-Q44) e `SITUACOES_SESSAO_CAIXA` com `conferida` e `divergente` **derivadas** de `conferencias_caixa` (sem mudar o
    `ck_sessoes_caixa_status`, que desce ao caixa);
  - `POST /sessoes-caixa/:id/conferir` (`fechamentos_caixa.conferir`): só sessão com fechamento; trava com `for update`;
    `diferenca = conferido − calculado` em decimal; aviso quando há eventos pendentes ou retidos da sessão, ou quando o calculado
    da nuvem difere do enviado; refazer com auditoria legível;
  - listagem com as 4 situações e o filtro "Somente com diferença" sobre o conferido;
  - ERP: bloco "Conferência" em `FechamentosCaixa.tsx`, com o informado pré-preenchido, a diferença ao vivo e o selo;
  - "Imprimir comprovante" de reforço e sangria (2 vias, com a assinatura de quem retira), layout fixo pela impressão do navegador (não
    há tipo de template para eles em `TIPOS_TEMPLATE`).
- **Arquivos:** `apps/api/src/vendas/sessoes-caixa.controller.ts`, `packages/shared/src/vendas.ts`,
  `apps/erp-web/src/paginas/vendas/{FechamentosCaixa,Reforcos,Sangrias}.tsx`. Sem PDV.
- **Migrações:** nenhuma (as tabelas são do F3-B2).
- **Testes:** vitest da situação (dentro e fora da tolerância, forma sem venda); integração (conferir, refazer, 403, sessão aberta 422,
  duas conferências ao mesmo tempo, loja não permitida); vitest das telas e do comprovante.
- **Pronto:** sessão fechada aparece Conferida ou Divergente; nada do que veio do caixa muda; `conta_financeira_id` nulo até a Fase 4.
- **Depende de:** F3-B2.
- **[Feito (F3-B9):** como descrito, com dois ajustes registrados no README da API › decisão 227: as telas de reforço e de
  sangria são uma só, `paginas/vendas/MovimentosCaixa.tsx` (não há `Reforcos.tsx` nem `Sangrias.tsx`), e o comprovante
  ganhou `GET /movimentos-caixa/:id/comprovante` (`movimentos_caixa.imprimir`, com a empresa e a loja, sem exigir
  `empresa.ver`), para a permissão de imprimir ser conferida na API; "Somente com diferença" olha cada forma, além do
  total. README do ERP › decisões 88 e 89.]

#### F3-B10 – Núcleo de estorno e `registrarStatusPdv`, sem mudar comportamento (SYNC 10.4, 16.3)
- **Tamanho:** M · **Rigor:** completo (estorna documento, estoque)
- **Objetivo:** separar o que o cancelamento pelo ERP vai reusar, provando que o caixa continua igual.
- **Entregas:**
  - extrair de `handlers/cancelamento.ts` o núcleo comum de estorno (`ESTORNO_DO_MOVIMENTO`, `tiposEstornados`, vazios pela
    `pdv.cancelamento_devolve_vazios`, `compensarDefinir`) para `apps/api/src/vendas/estorno-venda.ts`, usado pelo handler;
  - o núcleo já recebe a quantidade a estornar por item (vendido − devolvido), mesmo que hoje o devolvido seja sempre 0;
  - `registrarStatusPdv(tx, vendaId, origem)` em `apps/api/src/sync/status-pdv.ts`: grava só quando a origem não é o terminal da venda.
- **Arquivos:** `sync/handlers/cancelamento.ts`, `apps/api/src/vendas/estorno-venda.ts` (novo), `sync/status-pdv.ts` (novo).
- **Migrações:** nenhuma.
- **Testes:** `movimentos.spec` e a integração do cancelamento **sem mudança**; `recalcular-saldos` idêntico; unitário do
  `registrarStatusPdv`.
- **Pronto:** extração sem diferença de comportamento.
- **Depende de:** F3-B7.
- [**Feito (F3-B10)** (README da API › decisão 228; SYNC 16.3): o núcleo em `vendas/estorno-venda.ts`
  (`movimentosParaEstornar`, `quantidadesDevolvidas` lido com a venda travada,
  `partesDevolvidas`/`quantidadesAEstornar`/`linhasDeEstorno` na proporção do vendido menos o devolvido, por grupo de
  movimentos do item (a saída dividida em FEFO soma exatamente o que sobrou; o devolvido ocupa os lotes na ordem do id,
  o critério do lote da troca no F3-B43) — o `VENDA_PDV` exato, o `BAIXA_INSUMO` na mesma proporção, o item devolvido
  por inteiro de fora, os vazios inteiros — e `estornarEstoqueDaVenda`, o motor com o `compensarDefinir`), usado pelo
  handler, que continua exportando os nomes antigos. `registrarStatusPdv(tx, vendaId, 'nuvem' | { terminalId })`, com um
  ajuste: a mudança do próprio terminal não cria a linha, mas atualiza a que já existe (senão a linha antiga, que
  prevalece no caixa, contradiria o cancelamento dele); a forma A o chama no fim (hoje sem efeito: nada cria a linha
  antes do F3-B11). Além dos testes previstos, a integração simula a troca pondo o `quantidade_devolvida` à mão.]

#### F3-B11 – Cancelar venda pelo ERP (ERP 15.4.3; SYNC 10.4)
- **Tamanho:** M · **Rigor:** completo (estorna documento, estoque)
- **Objetivo:** cancelar a venda do caixa, inclusive a de sessão fechada (PC-1/D23), e o caixa de origem ficar sabendo.
- **Entregas:**
  - `POST /vendas/:id/cancelar` (`vendas.cancelar`, motivo de 15 a 255): trava a venda; bloqueia com `vendas_cancelamento_pendente` do
    terminal (`CANCELAMENTO_PENDENTE_NO_CAIXA`); avisa, com confirmação, quando o terminal está offline ou com eventos pendentes; sessão
    aberta pela F3-Q42; sessão fechada pede a forma de devolução (F3-Q43, vale desabilitado até o F3-B50); venda com troca
    (`quantidade_devolvida > 0`) bloqueada com "cancele a troca primeiro" (Padrões); `cancelamento_origem = 'erp'`, `cancelada_por_id`,
    `registrarStatusPdv`, auditoria do que fica para a Fase 4;
  - ERP: botão e modal com o aviso de terminal offline ou abaixo da versão que lê a projeção.
- **Arquivos:** `apps/api/src/vendas/vendas.controller.ts`, `apps/api/src/vendas/cancelamento-erp.ts` (novo), `packages/shared/src/vendas.ts`,
  `apps/erp-web/src/paginas/vendas/Vendas.tsx`.
- **Migrações:** nenhuma.
- **Testes:** integração (venda de sessão fechada: estoque volta ao custo original; bloqueio por pendente; aviso de offline; depois o
  `venda.cancelada` do caixa vira `CANCELAMENTO_DUPLO` com o físico aplicado; Definir posterior gera a compensação; já cancelada 409;
  venda com troca bloqueada; a linha da projeção desce ao caixa de origem; loja não permitida); `movimentos.spec` verde;
  `recalcular-saldos` idêntico; vitest do modal.
- **Pronto:** as vendas de caixa fechado "registradas com erro" desde a 1C podem ser canceladas.
- **Depende de:** F3-B10.
- [**Feito (F3-B11)** (README da API › decisão 229, README do ERP › decisão 90; ERP 15.4.3; SYNC 10.4): como descrito,
  com a prévia `GET /vendas/:id/cancelamento` para o modal (o bloqueio, os avisos e se pede a forma, pelas mesmas funções
  da gravação, sem travar). Escolhas técnicas: a 7300001 primeiro (`travaVersao`) e só então a venda com `for update`, a
  ordem do push; uma forma de devolução para a venda inteira, pedida só na sessão fechada com total acima de zero e
  guardada na auditoria (`pendente_fase_4`); a venda com documento fiscal (`status_fiscal` ≠ `nao_aplicavel`) bloqueada
  até a fase fiscal; os pagamentos aprovados passam a `estornado`; o aviso da versão que não lê a projeção (abaixo do
  0.14.0) só informa, e o de offline ou eventos pendentes, só do terminal de origem, pede o "Estou ciente"
  (`confirmarAvisos`, 409 `CONFIRMAR_AVISOS` sem ele). O "Definir posterior" testado é o efetivado com a contagem logo
  depois do cancelamento (a folga de 5 min do relógio). Da revisão: o `CANCELAMENTO_PENDENTE_NO_CAIXA` vale também para o
  `venda.cancelada` do caixa que chegou à nuvem e parou em `erro`/`retido` (ou ainda `recebido`), lido de
  `eventos_recebidos`, porque o **PDV ainda não envia** `vendas_cancelamento_pendente` no heartbeat (o campo fica `[]`;
  a API já o lê, e fazê-lo enviar é trabalho do PDV, sem bloco no plano ainda); o `POST` exige também `vendas.ver`,
  porque devolve o detalhe.]

#### F3-B12 – Parâmetros-PDV completo, aba Vendas (9.10), Lojas › Parâmetros (10.3.9) e trava por versão
- **Tamanho:** M · **Rigor:** enxuto (tela de configuração), com a numeração do caixa 0 e a trava revisadas com atenção
- **Objetivo:** toda chave aparece onde a especificação manda, e nenhuma chave sem efeito no caixa instalado parece funcionar.
- **Entregas:**
  - `ABA_VENDAS` com as chaves 9.10 (as de NF-e desabilitadas "Fase 6"); `PARAMETROS_LOJA` com as chaves 9.10 de Loja = S;
  - "Nº da próxima venda" do caixa 0: `PUT /lojas/:id/numeracao-venda-erp` (só com "Numeração própria"; recusa ≤ último usado; trava
    com `for update`; auditoria);
  - `VERSAO_PDV_DA_CHAVE` no shared e `GET /configuracoes/terminais-desatualizados?chave=`, generalizando o
    `VERSAO_PDV_GUARDA_VARIACOES`; o ERP mostra "Tem efeito a partir do PDV x.y; N caixas desatualizados" (com o nome de cada caixa);
  - **trava dura** (Padrões) nas chaves que mudam preço ou pagamento: a gravação é recusada (422, com a lista) enquanto houver terminal
    **ativo** abaixo da versão; o caixa parado há muito tempo precisa ser atualizado ou desativado;
  - faixas do catálogo alinhadas com a 9.3.1 (`pdv.dias_validade_cupom_troca` 0–365, `pdv.fonte_lista` 10–32, `pdv.fonte_total`
    20–72, `pdv.fonte_codigo` 10–40, `pdv.vale_compra_validade_dias` 1–730, `pdv.aviso_vencimento_dias` 1–365), sem rejeitar valor
    já gravado (fora da faixa cai no padrão com aviso);
  - ajuda da D15 conforme a F3-Q27.
- **Arquivos:** `apps/erp-web/src/paginas/configuracoes/{rotulos.ts,Configuracoes.tsx}`, `paginas/lojas/Lojas.tsx`,
  `packages/shared/src/configuracoes.ts`, `apps/api/src/configuracoes/configuracoes.controller.ts`, `apps/api/src/lojas/`.
- **Migrações:** nenhuma.
- **Testes:** vitest do catálogo; integração da numeração (corrida e ≤ último) e da trava (um terminal ativo abaixo recusa; desativado não
  conta; loja não permitida); vitest das abas.
- **Pronto:** toda chave Loja = S aparece em Lojas › Parâmetros; a aba Vendas grava; o aviso e a trava aparecem.
- **Depende de:** F3-B3.
- [**Feito (F3-B12)** (README da API › decisão 230, README do ERP › decisão 91; ERP 9.3.1, 9.10, 10.3.9; MD 3.1.2):
  como descrito. Escolhas técnicas: `VERSAO_PDV_DA_CHAVE` conferido nas tags `pdv-v0.10.0`..`pdv-v0.13.0` (o 0.13.0 lê as
  mesmas chaves que a `main`) e nos blocos que passam a ler cada chave (R3 0.14.0, R4 0.15.0, R5 0.16.0), com a trava só
  em `pdv.vasilhame_comodato` por ora (as promoções entram no F3-B34; o vale como pagamento e a baixa interna são formas
  de pagamento, e os blocos delas decidem); a consulta aceita várias chaves (`?chave=a,b`, uma ida por bloco da tela) e
  `lojaId`; a trava recusa só quando o valor efetivo **passa** de desligado a ligado numa loja com terminal ativo abaixo
  (na empresa, as lojas sem valor próprio; na loja, inclusive o "Herdar"), e o terminal ativado depois com PDV antigo
  fica com o aviso; a rota das variações e o modal "Gravar mesmo assim" ficam, pela mesma consulta; o valor fora da faixa
  cai no nível seguinte (a loja na empresa), e o pull o manda como está (nenhum PDV lê as seis chaves ainda); o "último
  usado" do caixa 0 conta também a maior venda gravada; `configuracoes.ver/editar` nas rotas da numeração (o campo é da
  aba Vendas). Além do pedido, para "nenhuma chave sem efeito parecer funcionar": o selo "sem efeito ainda" nas chaves
  que nenhuma versão do PDV nem a nuvem lê, e as chaves de loja da 9.4/9.7 e da 9.3.7 em Lojas › Parâmetros,
  desabilitadas com a fase.]

### PR-19 – Caixa: atalhos, complementos e preços

#### F3-B13 – Atalhos configuráveis no caixa e Nova venda (PDV 28.1–28.4, PDV-1)
- **Tamanho:** M · **Rigor:** completo (todas as teclas da fase passam por aqui)
- **Objetivo:** o caixa passa a aplicar a tabela `atalhos_pdv` que já desce, e as teclas novas da fase entram por ela.
- **Entregas:**
  - `MapaAtalhos` no Core: lê `atalhos_pdv` (empresa, sobrescrita por loja), com os padrões das tabelas 28.1 e 28.2 quando a linha
    falta; as teclas fixas da 28.3 nunca são reatribuídas; tecla repetida ou proibida que chegar da nuvem cai no padrão com um
    `alerta.cadastro`;
  - a barra de `VendaViewModel.cs:31-49` passa a ser montada pelo mapa, por `ordem`, até caber; o F1 lista todos com a tecla
    configurada; ação desabilitada ou sem permissão: bipe e "Ação indisponível";
  - os códigos de ação novos da fase registrados (`tipo_preco`, `pedidos_orcamentos`, `troca_produtos`, `tabela_precos`,
    `produtos_vencidos`, `alterar_preco`, `vendedor`, `consulta_preco`, `gelada`, `suspender`, `recuperar_suspensa`,
    `cupom_troca`), cada um ligado à tela quando o bloco dela entrar (até lá, "Ação indisponível");
  - **Nova venda (`Ctrl+N`, 28.3):** sem itens, limpa cliente, vendedor e tipo de preço; com itens, "Cancelar (C) / Voltar (Esc)", e
    "Suspender (S)" quando o F3-B23 entrar;
  - ERP: a validação da tabela ao salvar (28.3: tecla única por ação habilitada, teclas fixas e `Alt+F4`/`Ctrl+Alt+Del` proibidas),
    se ainda não existir.
- **Arquivos:** `apps/pdv/src/GenesisPDV.Core/Atalhos/MapaAtalhos.cs` (novo), `GenesisPDV.App/ViewModels/VendaViewModel.cs`,
  `GenesisPDV.Data/Repositorios/`, `apps/api/src/configuracoes/` e `apps/erp-web/src/paginas/configuracoes/` (validação).
- **Migrações:** nenhuma (a tabela já desce).
- **Testes:** os critérios 28.4 (trocar Remover Item para `Ctrl+R` vale depois do pull e o `F4` deixa de fazer a ação; ação desabilitada
  não aparece e só bipa; o ERP recusa duas ações com a mesma tecla; o roteiro sem mouse); Core do mapa (padrão, sobrescrita por loja,
  tecla proibida); TelasTests.
- **Pronto:** os critérios 28.4 num caixa de teste.
- **Depende de:** F3-B7.

#### F3-B14 – Complementos na nuvem: baixa e custo (MD 3.6.8, 3.11.3; D43)
- **Tamanho:** M · **Rigor:** completo (estoque e custo)
- **Entregas:**
  - `venda.finalizada` **v2** (aceita e ainda não anunciada): `componentes_estoque` opcional na linha do complemento (a lista
    calculada no caixa);
  - `montarMovimentos`: baixa do produto vinculado com `baixa_estoque` (quantidade = qtd do item × qtd do complemento ×
    `quantidade_baixa`) como `VENDA_PDV`, ou `BAIXA_INSUMO` da ficha quando o vinculado é Produzido; `documento_item_id` = id da linha
    do complemento (idempotência, T4); o custo do complemento somado ao `custo_unitario` do item;
  - `lote_id` desconhecido vira nulo no `INSERT` do item (tem FK; hoje só o motor o descarta), com o texto do lote mantido;
    `promocao_id` desconhecido **fica com o id cru** (o `ck_itens_venda_promocao` exige o id quando há desconto) e abre
    `PROMOCAO_DESCONHECIDA`.
- **Arquivos:** `apps/api/src/sync/handlers/vendas.ts`, `packages/shared/src/sync/eventos.ts`,
  `apps/api/test/integracao/venda-eventos.test.ts`.
- **Migrações:** nenhuma.
- **Testes:** porção com 2 molhos baixa os vinculados; o cancelamento estorna; o reenvio é idempotente; complemento livre e vinculado
  sem controle de estoque não baixam; `promocao_id` desconhecido com desconto grava e alerta (sem 23514); `recalcular-saldos`
  idêntico; o v1 do PDV mais antigo igual a antes.
- **Pronto:** saldo e custo certos na nuvem para uma venda com complementos.
- **Depende de:** F3-B4.

#### F3-B15 – Complementos no caixa (PDV 10.2)
- **Tamanho:** G · **Rigor:** completo (dinheiro)
- **Entregas:**
  - `ProdutoVenda` com os grupos e as opções ativas; diálogo por grupo, só pelo teclado, com o mínimo, o máximo, o obrigatório e a
    F3-Q4;
  - `preco_unitario` e `preco_tabela` = preço da 11.3 + Σ adicionais; o recálculo de atacado/mix/F8 preserva os adicionais ("camada de
    acréscimos do item", reutilizada pela gelada);
  - linhas com complementos diferentes não se agrupam; cancelar o item cancela os complementos;
  - cupom com os complementos; persistência local; `itens_venda_complementos` e `componentes_estoque` no evento (v2, só com o recurso
    disponível; sem ele, o produto "com complementos" vende como hoje).
- **Arquivos:** `apps/pdv/src/GenesisPDV.Core/{Produtos/ProdutoVenda.cs,Vendas/Venda.cs,Vendas/ItemVenda.cs}`,
  `GenesisPDV.Data/Repositorios/CatalogoLocal.cs`, `MapeadorVenda.cs`, `GenesisPDV.Sync/Eventos/FabricaEventos.cs`,
  `GenesisPDV.App/ViewModels/` (diálogo), `Fiscal/LayoutComprovanteVenda.cs`.
- **Migrações:** nenhuma.
- **Testes:** Core (mínimo/máximo/obrigatório, preço, agrupamento, atacado com adicional); headless do diálogo; o evento contra o zod
  (fixture compartilhada); impressão simulada.
- **Pronto:** "Porção + 2 molhos" vende, imprime e sobe; a nuvem baixa os molhos.
- **Depende de:** F3-B13, F3-B14.

#### F3-B16 – Preço digitado, alteração de preço e acréscimo no total (PDV 10.4, 10.5, 12.2)
- **Tamanho:** M · **Rigor:** completo (dinheiro, permissões)
- **Entregas:**
  - "Solicita preço PDV" e "Produto genérico" (lacuna da Fase 1; registrar no README do PDV), com o diálogo de preço e
    `pdv.limite_preco_digitado`;
  - `Ctrl+F6` com o item selecionado: só com `pdv.altera_preco_pdv` (loja) e `pdv.venda.alterar_preco`; `origem_preco = 'manual'`,
    `preco_tabela` mantido; a redução conta no limite de desconto (12.3) e acima dele pede o supervisor; auditoria `preco_alterado`;
  - F6 › 3 acréscimo em % ou R$ com `pdv.venda.acrescimo`, linha no cupom e o "Falta" recalculado (o rateio já existe);
  - as ações novas de auditoria só com o recurso da onda disponível (Padrões).
- **Arquivos:** `Core/Vendas/Venda.cs`, `Core/Vendas/LimiteDesconto.cs`, `App/ViewModels/VendaViewModel.cs`, diálogos,
  `PermissoesPdv.cs`.
- **Migrações:** nenhuma.
- **Testes:** os critérios da 12.5 ("10,00 → 8,00 com limite de 10% pede senha"); rateio do acréscimo em % (propriedade: Σ exata, a regra
  do líquido mínimo); genérico com preço zero recusado; o teste que recusa `Math.Round` fora do `Arredondamento`; TelasTests.
- **Pronto:** os critérios 10.4 (sem o serviço avulso, F3-Q6), 10.5 e 12.5 no caixa de teste.
- **Depende de:** F3-B13.

#### F3-B17 – Tipo de preço F8 (PDV 11.2)
- **Tamanho:** P/M · **Rigor:** completo (dinheiro); conforme a F3-Q2
- **Entregas:** `Venda.TipoPreco` muda durante a venda, com recálculo de todos os itens recalculáveis (inclusive a embalagem, ver
  Padrões), preservando manuais e adicionais; `pdv.venda.tipo_preco_atacado` ou supervisor; auditoria `tipo_preco_alterado`; a tecla
  passa pelo mapa de atalhos e a tela marca o tipo ativo.
- **Arquivos:** `Core/Vendas/Venda.cs`, `Core/Vendas/Constantes.cs` (`Recalculavel`), `Core/Precos/MotorPreco.cs`,
  `App/ViewModels/VendaViewModel.cs`.
- **Migrações:** nenhuma.
- **Testes:** critério 11.5 "Atacado recalcula e mantém os manuais"; fardo e mix com o F8; espelho em `packages/shared/src/precos.ts`
  conferido pelos vetores de preço.
- **Pronto:** o F8 funciona e grava `vendas.tipo_preco`.
- **Depende de:** F3-B16.

#### F3-B18 – Preço gelada e preço parcelado (PDV 11.3 passo 9, 11.4)
- **Tamanho:** M · **Rigor:** completo (dinheiro); o parcelado conforme a F3-Q3
- **Entregas:**
  - `TabelaPreco` com `AcrescimoGelada` e `PrecoParcelado`; passo 9 no `MotorPreco` e no espelho do shared;
  - `Alt+G` (pelo mapa de atalhos) liga e desliga o gelado no item, só com `acrescimo_gelada > 0` na loja; soma por unidade ao
    `preco_unitario` e ao `preco_tabela` (Padrões); item gelado e natural não se agrupam; fora do combo e da etiqueta por valor; a
    marca "gelado" fica **só no caixa** (coluna local fora do `Esquema.g.cs` ou tabela local, migração EF só local), para a venda
    recuperada depois de uma queda manter o agrupamento e o `Alt+G` saber desfazer; **nenhuma coluna nova na nuvem**;
  - parcelado: ao escolher mais de 1 parcela numa forma que permite parcelar, confirmação "total passa de R$ X para R$ Y",
    `origem_preco = 'parcelado'` e `vendas.tipo_preco = 'parcelado'`; remover o pagamento ou voltar a 1 parcela volta os preços e o
    tipo do F8; recusado com pagamento eletrônico aprovado; o operador escolhe as parcelas antes de passar o cartão (sem TEF).
- **Arquivos:** `Core/Precos/{MotorPreco.cs,TabelaPreco.cs}`, `packages/shared/src/precos.ts`,
  `App/ViewModels/DialogoPagamentoViewModel.cs`, `GenesisPDV.Data/Migrations/*` (local).
- **Migrações:** EF só local (a marca do gelado), sem volta de cursor.
- **Testes:** critério 11.5 "crédito 3× aplica o parcelado; remover volta"; gelada com atacado e com F8; a venda gelada passa no
  `conferirSomasVenda` da nuvem (integração com a fixture); venda recuperada mantém o gelado.
- **Pronto:** os dois critérios no caixa de teste.
- **Depende de:** F3-B15, F3-B17.

### PR-20 – Caixa: lote, etiqueta e peso

#### F3-B19 – Critérios de balança, peso digitado e lote escritos na especificação
- **Tamanho:** P · **Rigor:** enxuto (documentação)
- **Objetivo:** tirar a dependência circular: os testes do PR-20 precisam dos critérios que o roadmap chama de "10.10", que não existem.
- **Entregas:** a seção 10.10 "Critérios de aceite – balança, peso e lote" na especificação do PDV, com os casos do quadro da 10.6
  (valor e peso, DV inválido, multiplicador recusado, código exato tem prioridade), da 10.7 (peso estável, mínimo, negativo, peso
  digitado com e sem permissão, `<qtd>*<código>` com pesável) e da 10.8 (FEFO, lote não listado, vencido bloqueado e liberado, saldo
  menor só avisa, a regra do `estoque_id` da MD 3.6.9); a referência do roadmap corrigida.
- **Arquivos:** `docs/pdv/especificacao-pdv.md`, `docs/roadmap.md`.
- **Migrações:** nenhuma.
- **Testes:** nenhum (os blocos seguintes testam cada critério).
- **Pronto:** os critérios escritos e citados pelos F3-B20..B22.
- **Depende de:** —.

#### F3-B20 – Lote no caixa e produtos vencidos (PDV 10.8, 27.3)
- **Tamanho:** M/G · **Rigor:** completo (estoque)
- **Entregas:**
  - PDV: produto com "Solicita lote" lista os lotes da loja com `estoque_id` nulo ou igual ao estoque da loja, com o saldo de
    `saldos_lote`, em ordem FEFO (data no fuso da loja); vencido em vermelho, a vencer dentro de `pdv.aviso_vencimento_dias` em âmbar;
    lote fora da lista: aviso e `lote_id` nulo com o texto; vencido bloqueado, com liberação `pdv.venda.vender_vencido`, motivo e
    auditoria `lote_vencido_liberado` (PDV 10.8); saldo do lote menor: só aviso; lote diferente não se agrupa; `Alt+V` "Produtos
    vencidos" com os filtros; aviso de vencimento também sem "Solicita lote" quando `pdv.aviso_vencimento` está ligado; `lote_id`, `lote`
    e `validade_lote` no evento;
  - nuvem: a regra da F3-Q5 (v2): lote sem id procurado pelo código no produto, **só entre os lotes com `estoque_id` nulo ou igual ao
    estoque do movimento** (MD 3.6.9); o `lote_id` de outro estoque vira nulo e cai no FEFO.
- **Arquivos:** `Core/Vendas/`, `Data/Repositorios/CatalogoLocal.cs`, diálogos, `Sync/Eventos/FabricaEventos.cs`,
  `apps/api/src/sync/handlers/vendas.ts`, `estoques/movimentos.ts` (só uso).
- **Migrações:** nenhuma.
- **Testes:** os critérios de lote da 10.10 (F3-B19); Core (FEFO, fuso, vencido, agrupamento); integração (o lote informado baixa esse
  lote, o cancelamento devolve a ele, o lote sem id achado pelo código, o de outro estoque ignorado, o não achado cai no FEFO);
  `recalcular-saldos` idêntico.
- **Pronto:** os critérios de lote da 10.10 passam.
- **Depende de:** F3-B14, F3-B19.

#### F3-B21 – Etiqueta de balança EAN-13 prefixo 2 e peso digitado (PDV 10.6, 10.7)
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:**
  - leitor puro em `Core/Vendas` (prefixo, tamanho do código e do valor de `geral.balanca_*`, DV); o código exato tem prioridade;
  - por valor: quantidade = arred(valor ÷ preço, 3) pelo `Arredondamento`, `valor_bruto` = valor da etiqueta,
    `origem_preco = 'balanca'`; por peso: `valor_bruto` = arred2(peso × preço); multiplicador recusado; não fracionável aceito com KG
    e `alerta.cadastro` `unidade_nao_fracionavel_balanca`; `origem_entrada = 'etiqueta'`; índice local por `balanca_plu`;
  - **peso digitado (vale sem a balança serial):** produto pesável incluído sem quantidade e sem balança configurada pede o peso só com
    `pdv.venda.peso_manual` ou liberação; `<qtd>*<código>` com pesável segue a mesma regra; `peso_digitado = true`,
    `origem_entrada = 'teclado'` e auditoria `peso_digitado` (com quem liberou);
  - ERP: filtro "Peso digitado" na listagem de vendas e a marca no detalhe (o relatório por operador fica na Fase 5);
  - ERP e API: o PLU cabe em `geral.balanca_tamanho_codigo`; o "Gerar código interno" (`produtos.controller.ts` e o recurso de
    `FormularioProduto.tsx`) fora do formato da etiqueta.
- **Arquivos:** `Core/Vendas/`, `App/ViewModels/`, `apps/api/src/produtos/produtos.controller.ts`,
  `apps/erp-web/src/paginas/produtos/FormularioProduto.tsx`, `apps/erp-web/src/paginas/vendas/Vendas.tsx`.
- **Migrações:** nenhuma.
- **Testes:** os critérios de balança e de peso da 10.10; integração do gerador de código; vitest do PLU e do filtro.
- **Pronto:** etiqueta por peso e por valor vendem certo no caixa de teste; o peso digitado sem permissão pede a liberação.
- **Depende de:** F3-B13, F3-B19.

#### F3-B22 – Balança serial no caixa (PDV 6.5, 10.7) — condicional à F3-Q1 (C)
- **Tamanho:** M · **Rigor:** completo
- **Entregas:** `IBalanca` serial com `System.IO.Ports` (atrás de `IPortaSerial`) e os protocolos Toledo P03, Filizola, Urano, Elgin e
  ENQ genérico; configuração local na Central (modelo, porta, baud, paridade, bits, timeout, peso mínimo) com o botão "Ler peso"; peso
  estável = 2 leituras iguais; peso mínimo e negativo; falha de comunicação cai no peso digitado do F3-B21.
- **Migrações:** nenhuma.
- **Testes:** protocolo com porta simulada; `BalancaSimulada` no headless; teste real na loja no roteiro manual (não coberto na sessão).
- **Pronto:** item pesado no caixa com o modelo da loja (roteiro manual registrado).
- **Depende de:** F3-B21.

### PR-21 – Caixa: balcão e a release R3 (PDV 0.14.0)

#### F3-B23 – Suspender e recuperar venda, e o limite de vendas em aberto (PDV 22.3, 29.3, 32.3)
- **Tamanho:** M · **Rigor:** completo
- **Entregas:** `Venda.Suspender()`/`Recuperar()` (sem pagamento eletrônico aprovado); tabela local `vendas_suspensas_locais`
  (`venda_id`, `suspensa_em`, `suspensa_por_id`) fora do `Esquema.g.cs`; `Ctrl+Espaço` e `Ctrl+Shift+Espaço` pelo mapa de atalhos, com a
  lista (destaque acima de 24 h) e a ação no F12; o "Suspender (S)" do `Ctrl+N`; recuperar passa a venda para a sessão atual com
  confirmação; preço pela F3-Q29; fechamento pela F3-Q28; a regra da 32.3 com outro operador logado; `pdv.limite_venda_em_aberto`
  (F3-Q27); as suspensas no saldo estimado; auditorias `venda_suspensa`/`venda_recuperada`; aviso na desativação e na restauração do
  backup.
- **Migrações:** EF só local; sem mudança na nuvem.
- **Testes:** Core (transições e recusas); Data (sobrevive ao reinício e à migração `FaseTres`, critério 22.4); limite atingido;
  fechamento bloqueado; e2e-sync da suspensa finalizada **dias depois**, com número menor que outros já enviados (aceita pela margem da
  decisão 212 e pela regra do "número plausível" do SEG-B15); TelasTests.
- **Pronto:** critérios 22.4; duas vendas em paralelo no mesmo caixa; nada muda na nuvem.
- **Depende de:** F3-B13.

#### F3-B24 – Limite de valor da venda, painel do item com estoque, lote e foto (PDV 9.1, 29.1, 29.3; SYNC 6.12)
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** no F10, `total > pdv.limite_valor_venda` (decimal, depois de descontos, acréscimos e cascos) pede
  `pdv.venda.exceder_limite_valor` (liberação `limite_valor`); painel do item com estoque estimado, combos montáveis, origem do preço,
  lote e foto (`pdv.exibe_foto_produto`, `CacheImagens.ObterAsync`, placeholder offline); descarte LRU de 500 MB sem apagar a imagem em
  uso.
- **Migrações:** nenhuma.
- **Testes:** borda do limite (igual passa, um centavo acima pede), nulo, liberação negada; LRU; foto ausente, corrompida e offline.
- **Pronto:** critério 29.4; foto e estoque com a chave ligada e nada com ela desligada.
- **Depende de:** F3-B20, F3-B23.

#### F3-B25 – Logotipo da loja no cupom (SYNC 6.12)
- **Tamanho:** M · **Rigor:** completo (envio de arquivo e endpoint)
- **Objetivo:** o que o F2-B45 deixou "para depois": o cupom com o logotipo da loja, também offline.
- **Entregas:**
  - API: a variante `cupom_mono` (PNG de 1 bit, largura 384 e 576 px) gerada no envio do logotipo da loja; o campo calculado
    `logotipo_url`/`logotipo_sha256` da loja no pull; o `/sync/arquivos/:id` passa a aceitar o logotipo **da loja do terminal**, só na
    variante `cupom_mono` (o resto continua 404, como hoje);
  - PDV: baixa o logotipo **antes de liberar vendas** quando ele muda (sem internet, segue sem logo, nunca bloqueia), guarda no cache
    pelo sha256 e imprime no cabeçalho por imagem raster ESC/POS (`GS v 0`), nas larguras de 48 e 32 colunas.
- **Arquivos:** `apps/api/src/arquivos/` (variantes), `sync/fluxos.ts`, `sync/arquivos.controller.ts`, `apps/pdv/src/GenesisPDV.App/
  Servicos/CacheImagens.cs`, `Impressao/RenderizadorEscPos.cs`, `Impressao/EscPos.cs`.
- **Migrações:** nenhuma (coluna calculada no pull; o `Esquema.g.cs` muda na `FaseTres` do F3-B7 se a coluna for nova no espelho:
  conferir e, se for, levar a coluna para o F3-B7).
- **Testes:** variante gerada (tamanho e 1 bit); escopo do endpoint (logotipo de outra loja 404); impressão simulada com o raster;
  sem a imagem, o cupom sai igual a hoje.
- **Pronto:** o cupom do caixa de teste sai com o logotipo da loja, inclusive offline depois do primeiro download.
- **Depende de:** F3-B7.

#### F3-B26 – Consulta de preço (Ctrl+L) e tabela de preços (Ctrl+P) (PDV 27.1, 27.2)
- **Tamanho:** M · **Rigor:** enxuto (consulta só de leitura)
- **Entregas:** os dois diálogos com as colunas comuns (varejo, loja, o `preco_promocional` do cadastro, atacado, faixas, mix,
  embalagens; a coluna da promoção vigente do motor entra no F3-B36); filtros por categoria, marca e texto sobre o FTS5; impressão
  ESC/POS da lista filtrada (F3-Q30) pela fila; acesso no modo utilitário e sem caixa aberto.
- **Migrações:** nenhuma.
- **Testes:** critérios 27.4; 50.000 produtos em menos de 300 ms **como medida de referência** (repetida no caixa da Treino no roteiro);
  layout em 48 colunas; a consulta não altera a venda em andamento.
- **Pronto:** a lista impressa confere com a tela.
- **Depende de:** F3-B24.

#### F3-B27 – Crachá do supervisor (PDV 31.3)
- **Tamanho:** P · **Rigor:** enxuto, com revisão de segurança no próprio bloco
- **Entregas:** prefixo do crachá (Code128 `U` + código do usuário) aceito no campo Usuário do login e da liberação, levando o foco ao
  PIN, e recusado no campo de código da venda; impressão do crachá no ERP (Usuários › "Imprimir crachá", A4 pelo navegador, biblioteca de
  código de barras com versão fixada) e na térmica pela Central (Code128 no `EscPos.cs`, reusado pelo F3-B49); o PIN continua obrigatório
  com o bloqueio de 5 erros.
- **Migrações:** nenhuma.
- **Testes:** leitura do crachá, prefixo recusado na venda, bloqueio de 5 erros, usuário inativo; a velocidade do leitor real fica no
  roteiro manual.
- **Pronto:** o supervisor libera passando o crachá e digitando o PIN.
- **Depende de:** F3-B13.

#### F3-B28 – Vendedor no caixa e comissão na nuvem (PDV 15; SYNC 10.2; MD 3.11.3)
- **Tamanho:** M · **Rigor:** completo (dinheiro); desligado pela F3-Q10
- **Entregas:**
  - PDV: F7 escolhe ou troca o vendedor (ativos com `vendedor = true` e a loja); `pdv.forca_escolha_vendedor` (o primeiro item
    espera a escolha), `pdv.solicita_vendedor_finalizacao`, rótulo "Atendente" com `pdv.atendente_ao_inves_vendedor`; padrão = o
    operador quando ele é vendedor; "Vendedor: X" no cupom; `vendedor_id` na venda e nos itens;
  - nuvem (v2): `comissao_pct = produtos.comissao_pct ?? usuarios.comissao_pct`, `valor_comissao = arred2(valor_liquido × pct / 100)`
    só nos itens não cancelados e fora de `consumo_interno`; vendedor inválido → nulo e alerta; a comissão é a **prevista** (Padrões);
  - ERP: coluna e filtro "Vendedor" nas vendas.
- **Migrações:** nenhuma.
- **Testes:** Core das três chaves e os critérios da PDV 15; integração (comissão do produto prevalece, arredondamento, item cancelado,
  v1 igual a antes, idempotência, vendedor inválido); vitest da coluna.
- **Pronto:** com "Força escolha" ligada, o primeiro item abre o vendedor; o item tem `valor_comissao` na nuvem.
- **Depende de:** F3-B4, F3-B13.

#### F3-B29 – Gestão de vendas (F12) com o status da nuvem (SYNC 16.3)
- **Tamanho:** P/M · **Rigor:** completo (cancelamento)
- **Entregas:** a Gestão de vendas (F12) e o cancelamento no caixa leem `vendas_status_pdv` e não oferecem cancelar (nem, a partir do
  F3-B47, trocar) a venda já cancelada ou devolvida fora dele; a linha mostra "Cancelada no ERP" ou "Devolução no ERP".
- **Arquivos:** `apps/pdv/src/GenesisPDV.App/` (F12), `GenesisPDV.Core/Vendas/CancelamentoVenda.cs`.
- **Migrações:** nenhuma.
- **Testes:** Core.Tests e TelasTests do F12 com a projeção; a venda cancelada no ERP não aparece como cancelável.
- **Pronto:** o caixa novo fica sabendo do cancelamento feito no ERP.
- **Depende de:** F3-B11.

#### F3-B30 – Release R3 (PDV 0.14.0): anúncio da v2, ensaio e notas
- **Tamanho:** P · **Rigor:** enxuto (versão e documentação), mas com o ensaio completo
- **Entregas:** ligar o anúncio de `venda.finalizada` v2; versão 0.14.0 no `Directory.Build.props`; READMEs (API, ERP, PDV) com as
  decisões da onda; ensaio PDV 0.14 × API nova e **o PDV mais antigo em uso** e o 0.13 × API nova (`test/e2e-pdv`) com uma venda que
  junta complemento, lote, etiqueta, peso digitado, gelada, F8 e vendedor; o instalador pelo **caminho atual** (OP-B3 ou o PC Windows
  do dono); o roteiro manual da R3 (instalação, impressão com logotipo, leitor com o crachá, desempenho de referência); **nota de versão
  curta** para o operador e para o dono (o que mudou no balcão), que alimenta o material do F3-B69.
- **Migrações:** nenhuma.
- **Pronto:** a API da onda em produção antes da página de download receber a 0.14.0; `verificar-local.sh` verde; D63 feita; o
  `dotnet test` do PDV rodado no Windows do dono; o roteiro manual registrado.
- **Depende de:** F3-B13..B29 (os que entrarem).

### PR-22 – Atualização automática e a passagem para o Velopack (condicional à F3-Q33 = A e aos critérios do F3-B8)

#### F3-B31 – Exceção de canal por terminal, carência e a tela de versões (ERP 19.3, 19.5; SYNC 17.3)
- **Tamanho:** M · **Rigor:** completo (migração do controle, protocolo)
- **Objetivo:** só o que falta: o filtro pelo canal da empresa **já existe** no heartbeat e na tela de Terminais
  (`heartbeat.ts:466-478`, `terminais.service.ts:973-984`).
- **Entregas:**
  - migração do controle `0007`: `terminais_pdv.canal_pdv` nulo (exceção por terminal, F3-Q34; nulo = canal da empresa) e
    `terminais_pdv.abaixo_minima_desde`;
  - heartbeat: o canal efetivo (o do terminal, se houver, senão o da empresa) e `atualizar_ate` = publicação da mínima + 3 dias (o push
    nunca é bloqueado); `canal` no `app` (contrato e fixtures);
  - `infra/producao/implantar.sh pdv publicar --canal --minima`: grava em `versoes_app_pdv` e publica o feed em
    `download.<domínio>/pdv/<canal>/` (o comando roda na VPS pelo dono, OP-B2);
    [**ajuste do spike F3-B8** (README do PDV › decisão 100, regra de publicação): o `--minima` (o `versao_minima` do
    heartbeat, que força com a carência) e a `versao_minima_permitida` do manifesto assinado são **dois valores
    separados**; a do manifesto fica igual ou abaixo da versão anterior em uso nos caixas, e o comando **recusa** a
    mínima permitida igual ou acima da versão publicada (senão o caixa perde a volta automática dessa versão);]
  - ERP: a exceção de canal na tela Terminais e a tela 19.5 mínima (lista e marcar a mínima); o canal da empresa no painel da plataforma
    só se ainda não estiver lá.
- **Migrações:** controle `0007` (provisória).
- **Testes:** integração do heartbeat com a exceção por terminal e sem ela; carência (mínima publicada há 1 e há 4 dias); o PDV mais
  antigo em uso e o 0.13.0 lendo o `app` novo sem erro (JSON do teste de contrato do PDV); shellcheck do `implantar.sh`; PostgreSQL 16 e 18.
- **Pronto:** a versão publicada no beta aparece só para o terminal com a exceção beta.
- **Depende de:** F3-B8.

#### F3-B32 – Atualizador no PDV (PDV 32.6)
- **Tamanho:** G · **Rigor:** completo, com revisão de segurança dedicada (é um caminho para executar código em todos os caixas)
- **Entregas:**
  - serviço de atualização atrás de `IUpdateManager`: endereço do feed **fixo no build** (só `https`, nunca vindo do heartbeat), canal
    vindo do heartbeat (aceitável, porque o pacote é assinado), download em segundo plano;
  - conferência do **manifesto assinado** (Ed25519, chave pública embutida, F3-Q35 a) com o sha256 do pacote **antes** de aplicar;
    recusa de versão abaixo da "versão mínima permitida" do manifesto;
  - aplicar só no login ou depois do fechamento, nunca com venda em andamento, com as suspensas preservadas;
  - backup (PDV 32.5) e outbox persistido antes; migração EF depois; se falhar, restaura o banco e volta ao pacote anterior guardado
    no cache, **por decisão do próprio app** (nunca por comando remoto);
  - depois da carência, atualização obrigatória no login (o push continua); comando `atualizar_app` atendido (só "procure agora"; nunca
    escolhe versão); situação na Central.
  - [**Ajustes do spike F3-B8** (README do PDV › decisão 100): a conferência é um `IUpdateSource` na frente do
    `UpdateManager` (manifesto `manifesto.<canal>.json` + `.sig` SSHSIG, o sha256 do feed, cada pacote igual ao do
    manifesto, o piso da mínima permitida persistido e só subindo); o completo remontado pelos deltas é conferido pelo
    sha256 de cada arquivo de dentro dele (o manifesto leva a lista); `SetAutoApplyOnStartup(false)`; o pacote da versão
    que abriu sem erro guardado numa pasta própria já na abertura e devolvido à pasta do Velopack antes de procurar
    (o Velopack o apaga quando um download é recusado); antes da volta, a pasta do Velopack só com o pacote anterior (o
    `UpdateExe.Apply` aplica o mais novo quando o pedido falta); a versão que falhou recusada neste computador; a
    atualização pendente (com o backup) mantida até a versão de destino da volta abrir, a volta gravada como "em
    andamento" (não "feita") antes do `ApplyUpdatesAndRestart`, o "volta feita" só com a versão instalada igual à de
    destino, e, se a versão que falhou abrir de novo com a volta em andamento, o banco restaurado outra vez sem migrar e
    a volta repetida (até 3 tentativas, depois o suporte); busca de atualização recusada com a volta em andamento. Teste
    com feed falso: a aplicação da volta que lança exceção, e a abertura seguinte que restaura e volta.]
- **Arquivos:** `apps/pdv/src/GenesisPDV.App/Servicos/Atualizacao/` (novo), `GenesisPDV.Sync/Ciclo/ProcessadorComandos.cs`,
  `GenesisPDV.App/ViewModels/LoginViewModel.cs`, Central do PDV.
- **Migrações:** nenhuma.
- **Testes:** Sync e App Tests com feed falso (assinatura errada, sha trocado, versão abaixo da mínima permitida, canal trocado, falha de
  migração voltando com o banco íntegro, venda em andamento adia, comando remoto não força versão); o roteiro manual no caixa da Treino
  (não coberto na sessão, D70).
- **Pronto:** o critério da Definição de pronto de atualização passa no roteiro manual **executado e registrado**.
- **Depende de:** F3-B31.

#### F3-B33 – Empacotamento Velopack, assinatura e a passagem 0.14.1
- **Tamanho:** M · **Rigor:** completo (toca a instalação de todas as lojas)
- **Entregas:**
  - `apps/pdv/instalador/velopack/gerar-pacote.sh` na sessão: gera o pacote e um release **em rascunho** com o sha256;
  - **logística da assinatura (D70):** o dono baixa o rascunho no PC Windows, confere o sha256, assina o manifesto (e o Authenticode, se
    a F3-Q35 b pedir) com a chave que só existe no PC dele, e publica pelo comando do OP-B2; na mesma ida ao PC, roda o `dotnet test` do
    PDV e os itens do roteiro que só o Windows cobre;
  - a versão **0.14.1**: o mesmo código da 0.14.0, só com o atualizador e o empacotamento novos;
  - roteiro de instalação única por caixa, caixa por caixa: desinstalar o Inno sem apagar o `%ProgramData%`, instalar o Velopack com a
    conta do caixa, conferir a venda e a sincronização antes do caixa seguinte;
  - página de download atualizada; a mínima só sobe depois de todos os caixas migrados (senão a ativação recebe 426);
  - README do PDV e `infra/producao/README.md`.
  - [**Ajustes do spike F3-B8** (README do PDV › decisão 100; OP-B3 ampliado): o pacote sai do vpk fixo no Linux, sem
    Wine; o Setup.exe de cada versão se guarda logo depois do `pack` dela; a assinatura é o `ssh-keygen -Y sign -n
    genesispdv-atualizacao` no PC do dono (sem ferramenta nova), e a sessão confere o `.sig` antes da publicação; o
    Velopack instala por usuário, com o atalho da inicialização do usuário no lugar do "Iniciar com o Windows" do HKLM;
    um caixa novo, sem o Inno antes, não tem a ACL do `%ProgramData%\GenesisPDV` (decidir aqui como prepará-lo); a
    `versao_minima_permitida` de cada manifesto fica igual ou abaixo da versão anterior em uso nos caixas, nunca a
    publicada, e é um valor separado do `versao_minima` do heartbeat (o roteiro de publicação diz os dois).]
- **Migrações:** nenhuma.
- **Testes:** shellcheck; conteúdo do pacote (lista de arquivos, versão, sha256); roteiro manual no Windows registrado.
- **Pronto:** todos os caixas na 0.14.1 pelo Velopack; a R4 sai por este caminho.
- **Depende de:** F3-B32, F3-B30; OP-B3.

### PR-23 – Promoções

#### F3-B34 – Cadastro de promoções no ERP (ERP 8.8; MD 3.6.11)
- **Tamanho:** M · **Rigor:** enxuto (cadastro; as tabelas e as permissões vieram do F3-B2 e do F3-B3)
- **Entregas:** shared: zod dos `parametros` por tipo (`leve_pague`, `combo`, `desconto_pct_item` com faixas, `preco_fixo`,
  `forma_pagamento`), dinheiro e percentual em texto decimal; API `/promocoes` com versão (409) e auditoria legível; ERP: listagem
  (Nome, Tipo, Situação, Loja) e formulário com vigência, dias da semana, horário, lojas, prioridade e a grade de gatilhos e brindes
  por produto ou categoria; no produto, a promoção vigente que o atinge; a chave das promoções nos caixas com a **trava dura** do F3-B12
  (só liga com 0 terminais ativos abaixo da R4). **Trava de preço (F3-B3, README da API › decisão 222):** com
  `geral.altera_preco_produto_erp` = Não, criar ou editar promoção que mude preço (`preco_fixo`, `desconto_pct_item`,
  `leve_pague`, `combo`, `forma_pagamento`; na prática, todos os tipos de hoje) exige `produtos.alterar_preco`, a mesma
  regra de `apps/api/src/produtos/trava-preco.ts` e do `garantirAlterarPreco`; sem ela, o Estoquista (que ganhou
  `promocoes.criar/editar` no F3-B3) mudaria o preço cobrado nos caixas por uma promoção, contornando a trava do
  cadastro do produto.
- **Arquivos:** `packages/shared/src/promocoes.ts` (novo), `apps/api/src/produtos/promocoes*.ts`,
  `apps/erp-web/src/paginas/produtos/Promocoes*.tsx`.
- **Migrações:** nenhuma.
- **Testes:** zod; integração do CRUD (403, loja não permitida), da trava de preço (com a chave = Não, o Estoquista
  recebe 403 ao criar e ao editar a promoção; com `produtos.alterar_preco`, grava) e do pull; vitest.
- **Pronto:** promoção cadastrada chega ao SQLite do caixa novo; os caixas antigos seguem vendendo.
- **Depende de:** F3-B7, F3-B12.

#### F3-B35 – Motor de promoções puro no PDV (PDV 11.4)
- **Tamanho:** M/G · **Rigor:** completo (dinheiro)
- **Entregas:** `Core/Precos/MotorPromocao.cs` com os tipos da F3-Q7; vigência pela hora corrigida (PDV 30.5), dias e horário no fuso da
  loja, lojas; prioridade e F3-Q8; distribuição determinística do desconto em centavos entre as linhas pela regra do líquido mínimo
  (Padrões); exclusões dos Padrões; arredondamento pelo `Arredondamento`.
- **Migrações:** nenhuma.
- **Testes:** de propriedade (Σ exata, líquido mínimo, determinístico); vigência, horário e dia; prioridade; vetores JSON.
- **Pronto:** o motor isolado passa todos os vetores.
- **Depende de:** F3-B34.

#### F3-B36 – Promoções na venda, no pagamento, no cupom e na consulta
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** reavaliar a cada inclusão, cancelamento e pagamento; `desconto_promocao` + `promocao_id` por item, fora do limite do
  operador; a promoção por forma de pagamento entra ao lançar o pagamento e sai ao removê-lo (F3-Q9); cupom ("LEVE 3 PAGUE 2 – …
  −3,49", "Desconto PIX à vista"); filtro "Promoção" na pesquisa F2 (lacuna do F2-B36); a coluna "promocional vigente" na consulta e na
  tabela de preços (F3-B26); interação com o parcelado e com o desconto no item (o máximo já é `ValorBruto − DescontoPromocao`).
- **Migrações:** nenhuma.
- **Testes:** critério 11.5 "leve 3 pague 2 em 6 latas não pede senha"; PIX com pagamento misto; o rateio do desconto total depois da
  promoção; **medida da inclusão de item** com o motor (meta da PDV 32.4: < 150 ms p95 com 50 mil produtos e 200 promoções vigentes,
  medida de referência na sessão e repetida no caixa da Treino); TelasTests.
- **Pronto:** os critérios 11.5 de promoção no caixa de teste; a medida registrada no README do PDV.
- **Depende de:** F3-B35, F3-B18.

### PR-24 – Cliente no caixa e comodato

#### F3-B37 – `pessoa.criada_no_caixa` na nuvem, com mescla por CPF (SYNC 9.18; MD 3.5.2, 4.4.9)
- **Tamanho:** M · **Rigor:** completo (sincronização, LGPD)
- **Entregas:** contrato v1 (fixture com CPF de teste) e entrada em `CONTRATOS_EVENTOS`; handler `sync/handlers/pessoas.ts`: CPF novo
  ou sem CPF cria `pessoas` com `id` = id local, `origem = 'pdv'`, `origem_terminal_id`, `codigo`, `limite_compras =
  pdv.limite_padrao_cliente_pdv`, as filhas (endereço só completo); CPF existente funde pela F3-Q12 (só os vazios, alias
  `mesclada_cpf`); **a mesma trava do ERP** (`genesis:pessoa_documento:<doc>`, `pessoas/fornecedores.ts:99`, com o documento
  normalizado do mesmo jeito), para a corrida ERP × caixa e caixa × caixa; um 23505 do `uq_pessoas_cpf_cnpj` vira nova leitura e
  mescla, nunca `erro`; CPF de uma pessoa **excluída** cria uma pessoa nova (o índice só vale para as não excluídas) e guarda o alias
  para a excluída; relevância da loja para a pessoa e o alias descerem; dado inválido higienizado (nunca recusado: a venda dependente
  ficaria retida para sempre); `resultado {pessoa_id_final, mesclada, codigo, motivo}`; opcional `GET /sync/consultas/pessoas?q=`
  (até 20, sem `senha_hash`, CPF mascarado, limite de taxa e auditoria, como no F3-B45); ERP mostra a origem "Caixa" e os aliases.
- **Migrações:** nenhuma.
- **Testes:** CPF novo, CPF existente (mescla e alias), dois eventos com o mesmo CPF ao mesmo tempo, **o ERP e o caixa ao mesmo tempo**,
  CPF de pessoa excluída, sem CPF, endereço incompleto, repetição; venda retida pela pessoa e liberada depois com o cliente
  definitivo; o alias desce no `pessoas`.
- **Pronto:** a venda de um cliente criado no caixa aparece no ERP ligada à pessoa definitiva.
- **Depende de:** F3-B4.

#### F3-B38 – Cadastro rápido no caixa (F5 › Ins) e `pessoas_locais` (PDV 14.3)
- **Tamanho:** M · **Rigor:** completo
- **Entregas:** tabela local `pessoas_locais` (MD 4.4.9; migração EF só local); diálogo com `pdv.cliente.cadastro_rapido`, os campos e as
  validações da 14.3 e a F3-Q11; busca sobre `pessoas ∪ pessoas_locais pendentes`; CPF único local; o resultado do push marca
  `incorporada` e o `pessoa_id_final`; as vendas continuam com o id local (a nuvem resolve pelo alias).
- **Migrações:** EF só local.
- **Testes:** Core e Data (DV, campos, CPF único); fluxo offline → push → incorporada; TelasTests.
- **Pronto:** critério 14.5 "cliente criado offline aparece no ERP após o push; se o CPF já existia, não duplica".
- **Depende de:** F3-B37.

#### F3-B39 – Comodato na nuvem: empréstimo, baixa do comodato e estorno (PDV 10.12; MD 3.5.6, 7.3) — conforme a F3-Q13
- **Tamanho:** M · **Rigor:** completo (estoque)
- **Entregas:** `venda.finalizada` **v3** (aceita e não anunciada): `emprestados > 0` exige a pessoa, gera `VASILHAME_EMPRESTADO` (− no
  `vasilhame_vazio`) e soma em `saldos_vasilhame_pessoas` (upsert com trava, pela pessoa resolvida pelo alias); `vasilhame.movimentado`
  **v2**: `baixa_comodato` com a entrada `VASILHAME_DEVOLVIDO` e o abatimento **comutativo** (o saldo pode ficar negativo por um tempo,
  alerta `VASILHAME_COMODATO_NEGATIVO`, Padrões); cancelamento pela F3-Q14 (`ESTORNO_VASILHAME_EMPRESTADO` e a volta do saldo); o v1 com
  `emprestados > 0` continua recusado como hoje (regra da versão de origem); MD 3.5.6, 4.5, 7.3 e SYNC 10.1/10.4 atualizadas.
- **Migrações:** nenhuma (o CHECK saiu no F3-B2).
- **Testes:** 2 emprestados → saldo 2 no pull de `pessoas` e −2 vazios; baixa de 2 → 0; **ordem inversa entre dois caixas** (a baixa chega
  antes do empréstimo: saldo final 0, com o alerta enquanto esteve negativo); cancelamento devolve; cliente mesclado; duas baixas
  concorrentes; compensação do Definir; **a conta da loja** (com a D29: o estoque de vazios bate com a contagem física, sem contar duas
  vezes o casco que sai com a venda do cheio); `recalcular-saldos` idêntico, inclusive o saldo do comodato.
- **Pronto:** a Definição de pronto do comodato do lado da nuvem.
- **Depende de:** F3-B4, F3-B2.

#### F3-B40 – Comodato no caixa: emprestar, termo em 2 vias e baixa — conforme a F3-Q13
- **Tamanho:** M · **Rigor:** completo
- **Entregas:** "Emprestar cascos" no diálogo de cascos, com cliente, `pdv.vasilhame_comodato` e a F3-Q13; "Termo de empréstimo de
  vasilhame" em 2 vias (PDV 19.3, `FilaImpressao` tipo `vasilhame_termo`); F11 › V com "baixa do comodato" quando o cliente tem saldo;
  saldo estimado local (fórmula nova na MD 4.5, mostrado no mínimo 0) que continua descontando o movimento local enquanto a `versao` da
  linha no espelho for menor que a devolvida no resultado do push; tudo só com a v3 anunciada.
- **Migrações:** nenhuma.
- **Testes:** Core (faltantes → emprestados, recusa sem cliente, limite); impressão das 2 vias; o estimado com evento aplicado e ainda
  não puxado.
- **Pronto:** os critérios [PDV-2] da 10.12 num caixa de teste.
- **Depende de:** F3-B39, F3-B38 (recomendado).

### PR-25 – Vales e trocas: nuvem

#### F3-B41 – Vales: `vale.*`, saldo e alertas (SYNC 9.17; MD 3.13.2)
- **Tamanho:** M/G · **Rigor:** completo (dinheiro, concorrência)
- **Entregas:** contratos v1 `vale.emitido` (só a **emissão avulsa**, `origem_tipo = 'manual'`), `vale.utilizado` (só o **resgate em
  dinheiro**, com `devolucao_troca` sem `troca_id`; nunca pagamento de venda) e `vale.cancelado` (vale do próprio terminal na sessão
  aberta), com `saldo_local_antes`; `vales.saldo` = Σ movimentos e `status` derivado (F3-Q17); **`select … for update` na linha do
  vale** antes de inserir o movimento e recalcular o saldo (os pushes de terminais diferentes rodam em paralelo; a trava do push é por
  terminal, `aplicacao.ts:102`); conferência do código contra a loja e o caixa; o código de conferência (F3-Q25) guardado como resumo;
  vale desconhecido mantém o id e abre `VALE_DESCONHECIDO`; alertas `VALE_SALDO_NEGATIVO` (com as vendas) e `VALE_INVALIDO_UTILIZADO`,
  no painel da D40.
- **Arquivos:** `apps/api/src/sync/handlers/{vales.ts (novo),alertas.ts}`, `packages/shared/src/sync/eventos.ts`.
- **Migrações:** nenhuma.
- **Testes:** emissão avulsa; resgate em dinheiro; cancelamento; **dois pushes simultâneos de terminais diferentes no mesmo vale** (saldo
  certo); vale cancelado usado; reaplicar não baixa duas vezes; recálculo do saldo = Σ.
- **Pronto:** o saldo do vale é a soma dos movimentos em qualquer ordem e em qualquer concorrência.
- **Depende de:** F3-B4, F3-B5, F3-B1.

#### F3-B42 – Vale como pagamento na v3 e o estorno no cancelamento (SYNC 10.1, 10.4, 14.4)
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** v3 do `venda.finalizada`: pagamento `tipo_forma = vale` gera `utilizacao` (−) pelo `uq_movimentos_vale_pagamento` e
  consome a reserva; `venda.cancelada` (A e B) e o cancelamento pelo ERP (F3-B11): `estorno_utilizacao` e liberação das reservas; o v1
  com pagamento `vale` continua como hoje (a forma é indisponível no caixa antigo).
- **Arquivos:** `apps/api/src/sync/handlers/{vendas.ts,cancelamento.ts}`, `apps/api/src/vendas/estorno-venda.ts`.
- **Migrações:** nenhuma.
- **Testes:** uso parcial e total; **o mesmo vale em dois caixas offline: saldo negativo e o alerta (Definição de pronto)**; o mesmo
  pagamento chegando pela venda e por um `vale.utilizado` forjado baixa uma vez só; cancelamento devolve (caixa A, B e ERP); reaplicar
  não baixa duas vezes.
- **Pronto:** o cenário da Definição de pronto "vale em dois caixas offline" passa em integração com dois terminais.
- **Depende de:** F3-B41, F3-B11.

#### F3-B43 – `troca.registrada` com a venda de origem conhecida (SYNC 9.16, 10.1; PDV 23; MD 3.13.1)
- **Tamanho:** M/G · **Rigor:** completo (estoque, dinheiro)
- **Entregas:** contrato v1 e fixtures das 3 resoluções; handler `trocas.ts`: `trocas`/`itens_troca`; o vale da troca **dentro** do
  evento (vale-troca e troca imediata; nunca `vale.emitido`); `devolucao_troca` em `movimentos_caixa`; `TROCA_PDV` pelo
  `lancarDocumento` no tipo vendável ou no `avaria` (F3-Q22, sem entrada seguida de saída), ao custo do item de origem e no lote da
  origem (Padrões; com a saída dividida em FEFO, o lote que `partesDevolvidas` do F3-B10 dá a mais com o devolvido
  acumulado, para o cancelamento estornar os lotes que a troca não devolveu); `quantidade_devolvida` limitada com `TROCA_ACIMA_DO_VENDIDO`; `vendas.devolucao`; `registrarStatusPdv` quando a venda
  é de outro terminal; `trocas.venda_nova_id` preenchida pelo handler da venda que paga com o vale da troca; dependências (sessão;
  venda de origem do mesmo terminal); regra do restante na devolução parcial.
- **Migrações:** nenhuma.
- **Testes:** troca total e parcial com desconto rateado; avaria; combo; duas trocas concorrentes do mesmo item; venda do caixa 1 trocada
  no caixa 2; dinheiro com a apuração nos vetores `caixa.apuracao.vetores.json`; troca imediata com o vale usado na venda seguinte e o
  **restante como saldo do mesmo vale** (nenhuma emissão em dobro); **troca com vale-troca e uso do vale em outra loja (Definição de
  pronto)**; `recalcular-saldos` idêntico.
- **Pronto:** a Definição de pronto "troca com vale-troca e uso do vale em outra loja; estoque e caixa corretos" passa em integração.
- **Depende de:** F3-B42, F3-B10.

#### F3-B44 – Troca: origem desconhecida, venda cancelada e o acerto posterior
- **Tamanho:** M · **Rigor:** completo (estoque)
- **Entregas:** origem de outro terminal ainda desconhecida: aplica com `TROCA_ORIGEM_DESCONHECIDA` (custo médio atual, sem lote) e a
  `quantidade_devolvida` é acertada quando a venda chegar; **troca de venda cancelada** (pelo ERP ou pelo caixa): aplica a parte
  financeira, não dá a entrada já devolvida pelo estorno e abre `TROCA_DE_VENDA_CANCELADA`; **cancelamento de venda com troca** (caixa,
  forma A/B): estorna só o vendido menos o devolvido (núcleo do F3-B10); troca sem venda de origem pela F3-Q21.
- **Migrações:** nenhuma.
- **Testes:** troca antes da venda de outro caixa; essa venda chegando e **depois** sendo cancelada; troca chegando depois do
  cancelamento pelo ERP; cancelamento pelo caixa de venda já trocada (os dois sentidos); `recalcular-saldos` idêntico.
- **Pronto:** nenhuma ordem de chegada dá entrada dupla no estoque.
- **Depende de:** F3-B43.

#### F3-B45 – Consultas e reservas online de vale, e a busca da venda para a troca (SYNC 14.4, 1.4)
- **Tamanho:** M · **Rigor:** completo (concorrência, dinheiro, LGPD)
- **Entregas:** `GET /sync/consultas/vales/:codigo` (saldo e disponível), `POST /sync/consultas/vales/:id/reservar` (`for update`, 409
  `SALDO_INSUFICIENTE`), `PUT …/reservas/:pagamento_venda_id/em-uso` (até `pdv.dias_max_offline`, 7 dias se nula — D35),
  `DELETE …/reservas/:pagamento_venda_id`, todos com o F3-B6 e limite de taxa; tarefa por minuto que expira as reservas (TTL 10 min);
  `reservas_vale_em_uso` opcional no heartbeat; `GET /sync/consultas/vendas/busca?codigo_ct=|numero=|cpf=` na empresa (F3-Q23), só os
  campos da troca, sem custo; **limites de privacidade** em toda consulta por cliente: só a janela de `pdv.dias_validade_cupom_troca`,
  no máximo 20 resultados, CPF mascarado na resposta, limite de taxa por terminal, auditoria da consulta com o operador informado pelo
  caixa (só como registro, sem autoridade); contratos no zod e no `Protocolo/Contratos.cs`; SYNC 14.4, PDV 16.11 e ERP 15.4.4
  corrigidas para as rotas; **o prazo de cada tentativa das reservas no balcão** (pendência do F3-B6: hoje o
  `ChamadaOnline` usa o `TemposLimiteSync.Outras`, 30 s, e o pior caso das 3 tentativas é ≈ 91 s), com um teste que o fixe; as
  rotas que gravam tabela que desce declaram `travaVersao` no `atenderOnline` (a 7300001 antes da linha de
  `requisicoes_terminal`, decisão 225 da API).
- **Migrações:** nenhuma.
- **Testes:** duas reservas de R$ 3 num vale de R$ 4,50 (a segunda 409); reserva sem em-uso vence (relógio injetado); em-uso pelo
  heartbeat; repetição com o mesmo `X-Requisicao-Id` (em sequência e ao mesmo tempo); outra empresa recusada; busca por CPF fora da
  janela vazia, acima do limite de taxa 429, CPF mascarado; 404 numa API antiga tratado no Sync.Tests.
- **Pronto:** critério 23.3 "vale-troca do caixa 1 aceito no caixa 2 online, saldo parcial" do lado da API.
- **Depende de:** F3-B6, F3-B41.

### PR-26 – Vales e trocas: caixa e ERP

#### F3-B46 – Vale como pagamento no caixa (PDV 16.11; MD 4.5)
- **Tamanho:** G · **Rigor:** completo (dinheiro)
- **Entregas:** `vale` em `TiposDaFase` só com a v3 anunciada; leitura `VC…` com o Luhn (vetores do F3-B5) e o código de conferência
  (F3-Q25); saldo estimado local (MD 4.5) que **continua descontando** a utilização local enquanto a `versao` do vale no espelho for
  menor que a versão devolvida no resultado do push (a janela entre o ack e o pull); reserva online com o fallback offline e a F3-Q18;
  pagamento ≤ saldo e ≤ falta, sem troco; "Saldo restante do vale" no cupom; espelhos locais de `trocas`, `itens_troca` e
  `movimentos_vale` como movimento (migração EF só local, se precisar).
- **Migrações:** EF só local, se precisar.
- **Testes:** Core (limites, sem troco, conferência errada recusada); Sync (reserva, 409, timeout, repetição); **o estimado com o evento
  aplicado e ainda não puxado** não aceita de novo o valor já usado; TelasTests.
- **Pronto:** um vale emitido pela API de teste paga parte de uma venda online e offline, e o saldo restante sai no cupom.
- **Depende de:** F3-B45.

#### F3-B47 – Troca e devolução no caixa (Ctrl+T) (PDV 23)
- **Tamanho:** G · **Rigor:** completo (dinheiro, estoque)
- **Entregas:** `Core/Vendas/Troca.cs`: localizar por CT (com o DV), número, chave ou cliente (local, depois online; offline e sem a
  venda, só "sem venda de origem" pela F3-Q21); prazo `pdv.dias_validade_cupom_troca`; quantidade devolvível (local, projeção e online;
  venda cancelada fora do caixa não aparece, F3-B29); valor líquido com a regra do restante; kit inteiro ou parcial
  (`pdv.troca_kit_parcial`); destino (F3-Q22); resolução troca imediata, vale ou dinheiro (F3-Q20, saída da gaveta);
  `pdv.vale_exige_cliente_acima`; código do vale com `sequencias_locais['vale']`; `troca.registrada` com o vale dentro; a troca imediata
  abre a venda nova pagando com o mesmo vale (dependência `{troca}`) e imprime o restante como o saldo desse vale; **o estoque estimado do
  caixa** soma as devoluções locais com destino "estoque" ainda não refletidas (PDV 29.1, MD 4.5).
- **Migrações:** nenhuma.
- **Testes:** Core (critério 23.3 do valor líquido com desconto, item já devolvido recusado, prazo e liberação, sem origem com
  supervisor); a gaveta no fechamento; ordem do outbox; o estoque estimado depois da troca; TelasTests.
- **Pronto:** os critérios 23.3 nº 1 a 3 num caixa de teste (o nº 4, do relatório, fica para a Fase 5).
- **Depende de:** F3-B46, F3-B44.

#### F3-B48 – Operações de vale avulsas no caixa (SYNC 9.17) — conforme a F3-Q26
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** F11 › "Vales": emitir vale avulso (`pdv.vale.emitir`, motivo, `pdv.vale_exige_cliente_acima`, impressão); resgatar o
  saldo em dinheiro (`pdv.troca.devolver_dinheiro` ou liberação, saída da gaveta como `devolucao_troca`); cancelar um vale emitido neste
  terminal na sessão aberta (`pdv.troca.realizar`); os eventos `vale.emitido`, `vale.utilizado` e `vale.cancelado` do F3-B41, só com
  os tipos anunciados.
- **Migrações:** nenhuma.
- **Testes:** Core das três operações e das permissões; a gaveta no fechamento com o resgate; o vale cancelado recusado no uso seguinte;
  TelasTests.
- **Pronto:** as três operações num caixa de teste, com o saldo certo na nuvem.
- **Depende de:** F3-B46.

#### F3-B49 – Impressão do vale e do cupom de troca, e crédito do casco em vale (PDV 19.3, 16.11)
- **Tamanho:** M · **Rigor:** completo (dinheiro no crédito do casco)
- **Entregas:** Code128 do `VC…`/`CT…` (do F3-B27) no `RenderizadorEscPos`; layouts do vale (frases `vendas.vale_frase_bloqueio` e
  `vendas.vale_rodape`, o código de conferência da F3-Q25), do cupom de troca sem preços ("Válido para troca até") e do comprovante da
  troca; Ctrl+Shift+T e a F3-Q24; F11 › V destino `vale` (quantidade × preço do casco, teto e liberação da F3-Q15) e, na nuvem, o
  `vasilhame.movimentado` v2 com o destino `vale` (emite o vale dentro do evento).
- **Arquivos:** `apps/pdv/src/GenesisPDV.App/Impressao/`, `GenesisPDV.Core/Vasilhames/`, `apps/api/src/sync/handlers/vasilhame.ts`.
- **Migrações:** nenhuma.
- **Testes:** layouts na impressora simulada (48/32 colunas); o código lido de volta pelo `EntradaCodigo`; liberação acima do teto;
  integração do crédito do casco em vale (o vale aparece e o estoque de vazios entra).
- **Pronto:** o cupom de troca impresso é lido no Ctrl+T e acha a venda; o casco devolvido vira vale.
- **Depende de:** F3-B47.

#### F3-B50 – ERP: vales, trocas na venda, comodato na pessoa e alertas (ERP 15.4.4)
- **Tamanho:** M · **Rigor:** completo (o "Cancelar vale" e o "Liberar reserva" gravam; o resto é leitura)
- **Entregas:** `GET /vales` com filtros (código, cliente, loja, situação derivada pela F3-Q17), `GET /vales/:id` com o extrato,
  `POST /vales/:id/cancelar` (`vendas.cancelar` e motivo, como a ERP 15.4.4; movimento `cancelamento`; desce aos caixas) e
  `POST /vales/:id/liberar-reserva` (`vendas.cancelar`, motivo e auditoria: a reserva "em uso" de um caixa quebrado prende o saldo até
  7 dias); tela `/vendas/vales` com o menu; bloco "Trocas" no detalhe da venda e o filtro "Com devolução" na listagem de Vendas; cascos
  em comodato e o extrato na ficha da pessoa; os alertas novos no painel do Dashboard (D40); o vale passa a valer na forma de devolução
  do F3-B11.
- **Migrações:** nenhuma.
- **Testes:** integração do cancelamento (o vale cancelado desce; usado depois abre `VALE_INVALIDO_UTILIZADO`) e da liberação da
  reserva; 403 e loja não permitida; vitest das telas.
- **Pronto:** o alerta do vale negativo aparece no Dashboard; o dono acha qualquer vale pelo código.
- **Depende de:** F3-B42, F3-B43.

### PR-27 – Baixa interna e a release R4 (PDV 0.15.0)

#### F3-B51 – Baixa interna na nuvem (PDV 16.14; MD 7.3, 7.7) — condicional à F3-Q32 (A)
- **Tamanho:** M · **Rigor:** completo (estoque)
- **Entregas:** v3 do `venda.finalizada`: venda paga **só** com formas `consumo_interno` vira `BAIXA_INTERNA` no lugar de `VENDA_PDV`
  (componentes do kit e insumos também como `BAIXA_INTERNA`, registrado no README); mistura com forma comum ou forma divergente do
  cadastro **aplica como venda comum** com `BAIXA_INTERNA_MISTURADA` (nunca recusa, Padrões); comissão 0; cancelamento com
  `ESTORNO_BAIXA_INTERNA` ao custo original; a marca dos relatórios sai dos `pagamentos_venda` por junção (**sem**
  `vendas.baixa_interna`); o ERP recusa mudar o `tipo_forma` de uma forma já usada; MD 7.3 atualizada.
- **Migrações:** nenhuma.
- **Testes:** integração nos PostgreSQL 16 e 18: FEFO por lote, custo médio, cancelamento ao custo original, mistura aplicada como venda
  com o alerta, a forma editada depois da venda e o Reprocessar dando o mesmo resultado, o v1 do caixa antigo igual;
  `recalcular-saldos` idêntico.
- **Pronto:** critério 16.14 "o ERP mostra `BAIXA_INTERNA` na Movimentação e nada em vendas".
- **Depende de:** F3-B4, F3-B1.

#### F3-B52 – Baixa interna no caixa e no ERP
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** `consumo_interno` em `TiposDaFase` só com a v3; valor integral, sem mistura (o caixa impede na origem), liberação e motivo
  de 3 a 255 caracteres em `vendas.observacao`, comprovante "BAIXA INTERNA — NÃO É DOCUMENTO FISCAL", sem gaveta e sem troco; fora da
  contagem do fechamento (`ApuracaoCaixa`) e separada no resumo diário; `RegrasEstorno` só com `credito_cancelado`; no ERP, "Baixa
  interna" marcada e filtrada em Vendas, fora dos totais.
- **Migrações:** nenhuma.
- **Testes:** critérios 16.14; o fechamento não pede a contagem da forma; o cancelamento não tira dinheiro da gaveta; com a v3 não
  anunciada, a forma fica escondida; vitest.
- **Depende de:** F3-B51.

#### F3-B53 – Release R4 (PDV 0.15.0): anúncio da v3 e ensaio
- **Tamanho:** P · **Rigor:** enxuto
- **Entregas:** ligar o anúncio de `venda.finalizada` v3 e `vasilhame.movimentado` v2 (e dos tipos `troca.registrada`, `vale.*`,
  `pessoa.criada_no_caixa`); versão 0.15.0; READMEs; ensaio 0.15 × API nova e o mais antigo em uso, o 0.13 e o 0.14 × API nova com
  promoção, cliente novo, comodato, vale, troca e baixa interna; publicação pelo canal beta (caixa da Treino) e depois estável (pelo
  Velopack, ou pelo instalador atual sem o PR-22); as chaves das promoções, do comodato, do vale como pagamento e da baixa interna só
  ligam com a **trava dura** (0 terminais ativos abaixo da 0.15); roteiro manual e nota de versão.
- **Migrações:** nenhuma.
- **Pronto:** a API da onda em produção antes da 0.15.0; `dotnet test` do PDV no Windows do dono; roteiro registrado.
- **Depende de:** F3-B34..B52.

### PR-28 – Venda no ERP e devolução

#### F3-B54 – Cálculo da venda no shared, em decimal e com paridade com o caixa
- **Tamanho:** M · **Rigor:** completo (dinheiro)
- **Entregas:** `packages/shared/src/venda-calculo.ts`: `resolverPrecoDec` (o `resolverPreco` em `Dec`, com embalagem do F8, parcelado,
  manual e a F3-Q40), `ratearVenda` com as garantias do `Rateio.cs` e a regra do líquido mínimo, `calcularVenda` (totais e limite de
  desconto, excluído o de origem `cliente`); fixtures JSON de paridade **geradas depois do `MotorPreco` final** (F3-B17, F3-B18), lidas
  pelo vitest e por um xUnit do PDV.
- **Migrações:** nenhuma.
- **Testes:** propriedade (Σ partes = valor; líquido mínimo); paridade com o `Rateio.cs` e o `MotorPreco`; `calcularVenda` passa no
  `conferirSomasVenda`; nenhum vetor exige `valor_bruto = preço × quantidade` com `origem_preco = 'balanca'`.
- **Pronto:** o ERP e a API calculam igual ao caixa.
- **Depende de:** F3-B17, F3-B18.

#### F3-B55 – Templates de documentos (ERP 9.6)
- **Tamanho:** M · **Rigor:** completo (XSS)
- **Entregas:** `renderizarTemplate(conteudo, dados)` com escape e as variáveis da 9.6; CRUD `/templates-documentos` com as permissões
  de configurações e sanitização do HTML no servidor; ERP: editor (`@mantine/tiptap`), aba Orçamentos e seleção dos templates de venda
  e recibo na aba Vendas, pré-visualização com dados inventados.
- **Migrações:** nenhuma (o índice é do F3-B2).
- **Testes:** XSS (`<script>`, `onerror`, `javascript:`); um padrão por tipo e loja; renderização; 403 e loja não permitida.
- **Pronto:** imprimir venda e orçamento usa o template padrão.
- **Depende de:** F3-B2, F3-B12.

#### F3-B56 – Rascunho da venda ERP
- **Tamanho:** M · **Rigor:** completo (grava documento, migração)
- **Entregas:** `POST /vendas` (rascunho, número do caixa 0 reservado com `for update`, `canal = 'erp'`, `operador_id` = usuário),
  `PUT /vendas/:id` (itens, pagamentos, complementos), `DELETE /vendas/:id` (só rascunho, exclusão lógica); permissões
  `vendas.criar/editar/alterar_preco/desconto_acima_limite`; trigger `fn_vendas_complementos_erp` (libera as colunas de Complementos e
  a observação depois de finalizada, só no `canal = 'erp'`); o trigger de `itens_venda` do F3-B1 deixa o rascunho incluir, alterar e
  excluir; filtro "Rascunho".
- **Migrações:** empresa `0032_vendas_erp` (provisória).
- **Testes:** numeração em corrida; "Numeração própria"; permissões e loja não permitida; o trigger novo nos PostgreSQL 16 e 18;
  `contratos-eventos.spec` sem mudança.
- **Depende de:** F3-B54, F3-B12.

#### F3-B57 – Finalizar a venda ERP
- **Tamanho:** G · **Rigor:** completo (estoque, dinheiro)
- **Entregas:** `POST /vendas/:id/finalizar` numa transação: validações (estoque pela F3-Q39, vendedor, soma dos pagamentos = total,
  forma que exige pessoa); `finalizada_em` e `dia_operacional`; `VENDA_ERP`, `BAIXA_INSUMO` e componentes pela `montarMovimentos`
  extraída para `apps/api/src/vendas/movimentos-venda.ts` (usada também pelo handler); FEFO; custos; comissão prevista; pagamentos e
  parcelas pela F3-Q41; auditoria; alertas `ESTOQUE_NEGATIVO`; idempotente contra clique duplo; o cancelamento da venda ERP
  (`CANC_VENDA_ERP`) pelo endpoint do F3-B11.
- **Migrações:** nenhuma.
- **Testes:** kit e ficha técnica; lote FEFO; saldo negativo nas duas opções; cancelar a venda ERP; **a venda ERP aparece no Dashboard e
  na Movimentação junto com as do PDV (Definição de pronto)**; o handler do PDV verde depois da extração; `recalcular-saldos` idêntico.
- **Pronto:** "Venda feita no ERP (caixa 0) baixa o estoque da loja e aparece nos relatórios junto com as do PDV".
- **Depende de:** F3-B56, F3-B11.

#### F3-B58 – Telas da venda ERP e listagem completa (ERP 15.4)
- **Tamanho:** M · **Rigor:** enxuto (tela)
- **Entregas:** `/vendas/nova` e `/vendas/:id/:aba` (Dados Gerais com `GradeItens`: Produto, Lote, Qtd, Preço, Desconto, Total, Saldo;
  Complementos; Financeiro; Histórico; Documento fiscal "Fase 3F"); Gravar, Finalizar, Imprimir, Cancelar, Voltar; aviso fixo da
  F3-Q38; listagem com Vendedor, o filtro **"Documento fiscal: Sem documento"** (ERP 15.4.1), Exportar (`vendas.exportar`, tarefa em
  streaming) e Nova venda; detalhe mostrando complementos, lote, promoção, origem do preço e peso digitado.
- **Migrações:** nenhuma.
- **Testes:** vitest (totais ao vivo pelo shared; o filtro); e2e Playwright fora do CI, rodado localmente.
- **Pronto:** um usuário sem treino faz uma venda ERP do começo ao fim.
- **Depende de:** F3-B57, F3-B55.

#### F3-B59 – Devolução no ERP (ERP 15.4.3)
- **Tamanho:** G · **Rigor:** completo (estoque, dinheiro)
- **Entregas:** `POST /vendas/:id/devolucoes`: trava a venda; quantidade ≤ vendida − já devolvida; `DEVOLUCAO_ERP` ao
  `custo_unitario` do item, destino avaria no tipo Avaria; `quantidade_devolvida`, `vendas.devolucao` e `registrarStatusPdv`;
  `trocas.origem = 'erp'`; resolução vale-troca (vale do caixa `00`, validade por `pdv.vale_compra_validade_dias`, código de
  conferência da F3-Q25) ou dinheiro (F3-Q45); cancelar devolução com `ESTORNO_DEVOLUCAO_ERP`, bloqueado com o vale usado; modal no
  formulário da venda.
- **Migrações:** nenhuma.
- **Testes:** parcial e total; o restante na última unidade; avaria; duas devoluções concorrentes; devolução no ERP + troca offline no
  caixa da mesma venda (limita e alerta); cancelar com o vale usado bloqueia; 403 e loja não permitida; `recalcular-saldos` idêntico.
- **Pronto:** estoque e caixa corretos na nuvem para a devolução do ERP.
- **Depende de:** F3-B43, F3-B57.

### PR-29 – Orçamentos e a release R5 (PDV 0.16.0)

#### F3-B60 – Orçamentos na nuvem: eventos e reserva (SYNC 9.19; PDV 24)
- **Tamanho:** M · **Rigor:** completo (concorrência)
- **Entregas:** contratos v1 `orcamento.criado_no_caixa` (resultado `{codigo}`, `origem = 'pdv'`; `vendedor_id` e `pessoa_id` no padrão
  "sem FK, anula e alerta / alias") e `orcamento.convertido` (idempotente pela mesma venda; outra venda aplica com
  `ORCAMENTO_CONVERTIDO_DUAS_VEZES`; cancelado aplica com alerta); o `venda.finalizada` confere o `orcamento_id` sem recusar;
  `GET /sync/consultas/orcamentos/:codigo` e `POST /sync/consultas/orcamentos/:id/reservar` (2 h, F3-B6), com a regra de canal único
  (definida para as comandas na SYNC 9.20 e P24 e aplicada ao orçamento pela PDV 24.1); o ERP recusa a edição com reserva ativa; PDV 24.1
  corrigida para as rotas.
- **Migrações:** nenhuma.
- **Testes:** duas reservas do mesmo orçamento em dois terminais (a segunda 409); conversão offline dupla aplica e alerta; reserva
  expirada; o criado no caixa desce para o outro caixa da loja pelo `operacao`.
- **Pronto:** critério 24.3 "o mesmo orçamento não é convertido em dois caixas online" em integração.
- **Depende de:** F3-B6, F3-B7.

#### F3-B61 – Orçamentos no ERP: cadastro, situação e impressão (ERP 15.1)
- **Tamanho:** M/G · **Rigor:** completo (dinheiro, permissões)
- **Entregas:** shared: zod e `situacaoOrcamento` no fuso da loja; API: CRUD com `orcamentos.*` (inclusive **Excluir**,
  `orcamentos.excluir`), desconto dentro do limite do usuário, Marcar resposta, Duplicar, Cancelar, edição bloqueada pela reserva (SYNC
  16.2) e "Liberar reserva" (com permissão, motivo e auditoria, para o caixa que quebrou com o orçamento reservado); ERP: listagem com os
  filtros da ERP 15.1 (inclusive **Loja e Vendedor**) e formulário com a grade de itens e Imprimir pelo template `orcamento_logado`.
- **Migrações:** nenhuma.
- **Testes:** permissões e loja não permitida; limite de desconto; situação na virada do dia; dias de validade 0 a 365; excluir
  orçamento convertido recusado; liberar reserva; vitest.
- **Pronto:** critério 24.3 "orçamento criado no PDV aparece em Vendas › Orçamentos"; um orçamento do ERP importável pelo caixa.
- **Depende de:** F3-B55, F3-B60.

#### F3-B62 – Converter orçamento em venda no ERP
- **Tamanho:** M · **Rigor:** completo (grava documento)
- **Entregas:** `POST /orcamentos/:id/converter` cria o rascunho da venda ERP com `orcamento_id`, `item_orcamento_id` e
  `desconto_total_origem = 'orcamento'`; "Manter preços" ou "Atualizar"; expirado só com confirmação e recalculando por padrão; o
  orçamento vira Convertido na mesma transação, travado com `for update`.
- **Migrações:** nenhuma.
- **Testes:** duas conversões em corrida; inativo recusado; expirado; `orcamentos.converter`.
- **Depende de:** F3-B56, F3-B61.

#### F3-B63 – Orçamento no caixa: importar (F9) e criar
- **Tamanho:** G · **Rigor:** completo (dinheiro)
- **Entregas:**
  - F9 só habilitado com `pdv.orcamento_pdv` (ERP 15.1 "Converter no PDV"; PDV 28.1), pelo mapa de atalhos;
  - **importar** (`pdv.orcamento.importar`): F9 › Importar ou `ORC` + código, e a pergunta no início da venda com
    `vendas.solicita_id_orcamento`; válido mantém o preço (`origem_preco = 'orcamento'`) e o desconto (origem `orcamento`, fora do
    limite do operador), vencido recalcula com aviso; reserva online com o fallback offline e o aviso; a regra de canal único (PDV 24.1);
    `orcamento.convertido` na mesma transação do `venda.finalizada`;
  - **criar** (`pdv.orcamento.criar`): "Salvar como orçamento" pela F3-Q48 (com internet, sobe na hora e imprime com o número devolvido;
    offline, "requer conexão"); a venda em andamento é **encerrada sem venda** (PDV 24.2): os itens são descartados localmente sem gerar
    `venda.cancelada` (estado local "convertida em orçamento", que não sobe nem conta no fechamento).
- **Migrações:** EF só local, se o estado local precisar de valor novo.
- **Testes:** Core (válido mantém, vencido recalcula, desconto fora do limite, sem a chave o F9 bipa); ordem do outbox; reserva e canal
  único; o encerramento sem venda não aparece no fechamento nem na nuvem; TelasTests.
- **Pronto:** os três critérios 24.3 num caixa de teste.
- **Depende de:** F3-B60, F3-B61, F3-B13.

#### F3-B64 – Envio por e-mail e link público do orçamento — condicional à F3-Q46 (B)
- **Tamanho:** M · **Rigor:** completo, com revisão de segurança dedicada (rota pública)
- **Entregas:** `POST /orcamentos/:id/enviar` (SMTP de `apps/api/src/infra/email.ts`, `mensagens_enviadas`), `GET
  /publico/orcamentos/:token` com Aprovar e Recusar; token de 32 bytes guardado como hash, expira com a validade, limite de taxa,
  resposta sem dado além do orçamento; templates `orcamento_nao_logado`.
- **Migrações:** nenhuma.
- **Testes:** token errado, expirado, reutilizado; limite de taxa; nenhum dado de cadastro na resposta.
- **Depende de:** F3-B61.

#### F3-B65 – Release R5 (PDV 0.16.0)
- **Tamanho:** P · **Rigor:** enxuto
- **Entregas:** anúncio dos tipos `orcamento.*`; versão 0.16.0; READMEs; ensaio 0.16 × API nova e o mais antigo em uso até a 0.15 × API
  nova; beta e depois estável; roteiro manual e nota de versão.
- **Migrações:** nenhuma.
- **Pronto:** `dotnet test` do PDV no Windows do dono; roteiro registrado.
- **Depende de:** F3-B60..B63.

### PR-30 – Escala, ressincronização e fechamento

#### F3-B66 – Catálogos grandes e longo período offline (SYNC 6.13, 19.3; PDV 32.4)
- **Tamanho:** M · **Rigor:** completo (migração de índices, desempenho)
- **Entregas:** migração `0033_indices_pull`: `produtos_lojas (loja_id, versao)`, `saldos_estoque (estoque_id, versao)`, `saldos_lote
  (estoque_id, versao)` com `concurrently` pela preparação da tag (padrão do F2-B28); carga do pull com 50 mil produtos e a troca de
  preço de 10 mil (páginas, bytes, tempo, `EXPLAIN` usando o índice); carga do push com 8.000 eventos de um terminal (≈160 lotes de 50)
  com outros dois vendendo, **com vale, troca, comodato e cancelamento pelo ERP na massa**, medindo a espera na trava 7300001; **a
  latência VPS → Cloud SQL medida antes e injetada** (`tc netem` ou toxiproxy) quando rodar no servidor de homologação (F3-Q36); a
  evolução de `eventos_pendentes` no detalhe do terminal no ERP; **no PDV headless**, a inclusão de item por código com 50 mil produtos
  e as promoções vigentes (meta < 150 ms p95, PDV 32.4), registrada como referência e repetida no caixa da Treino.
- **Arquivos:** `apps/api/test/carga/pull-catalogo.ts`, `push-offline.ts` (novos), `apps/api/drizzle/empresa/0033_indices_pull.sql`,
  `apps/pdv/tests/` (medida da inclusão).
- **Migrações:** empresa `0033` (provisória).
- **Testes:** os de carga fora do `pnpm test` padrão (como os `test/carga` atuais), com os números das duas máquinas registrados no
  README, sem comparar valores absolutos.
- **Pronto:** números medidos; se passar de 5 min para 8.000 eventos, o bloco corrige (ex.: `preparar` mais leve, a trava pega mais
  tarde) antes de fechar.
- **Depende de:** F3-B43, F3-B42 (para a massa ter vale e troca).

#### F3-B67 – Ressincronização publicada pela nuvem (SYNC 6.11, 17.4, 17.6)
- **Tamanho:** M · **Rigor:** completo (sincronização)
- **Entregas:** as migrações que mudam projeção ou fluxo declaram, na própria migração, a lista de fluxos a ressincronizar; a
  implantação publica `ressincronizar_fluxo` aos terminais `ativo`/`desativando`; o ERP 12.4 manda o comando por fluxo.
- **Migrações:** nenhuma de esquema (só o mecanismo de declaração).
- **Testes:** integração (a migração marcada gera o comando para todo terminal ativo e em desativação; a não marcada, nenhum).
- **Pronto:** uma migração marcada chega ao caixa como `ressincronizar_fluxo`.
- **Depende de:** F3-B7.

#### F3-B68 – Ressincronização sem parar o caixa: banco sombra no PDV (SYNC 6.11; MD 4.4.12) e a R6
- **Tamanho:** G · **Rigor:** completo (sincronização)
- **Entregas:** banco sombra `pdv_ressinc.db`, troca por renomeação, as linhas só locais preservadas (vales escritos localmente,
  `pessoas_locais`, `vendas_suspensas_locais`, a marca do gelado), FTS em lotes, `alteracoes_adiadas` (MD 4.4.12). Release **0.17.0** (ou
  junto da R5, se o dono preferir), com o ensaio contra o mais antigo em uso, o roteiro manual e a nota de versão.
- **Migrações:** EF no PDV, se `alteracoes_adiadas` for tabela nova.
- **Testes:** Data.Tests da sombra (queda no meio, venda durante a ressincronização, renomeação); ensaio.
- **Pronto:** um `ressincronizar_fluxo` de `catalogo` com o caixa vendendo, sem perder venda nem dado local.
- **Depende de:** F3-B67.

#### F3-B69 – Material curto de treinamento da Fase 3 (roadmap §14)
- **Tamanho:** P · **Rigor:** enxuto (documentação)
- **Entregas:** a partir das notas de versão das releases, três roteiros curtos em `docs/implantacao/`: **operador de caixa** (suspender,
  troca e vale, comodato, etiqueta, peso digitado, promoções no cupom), **quem libera** (o dono e o Encarregado: liberações novas, crachá,
  conferência do fechamento) e **escritório** (venda ERP, cancelamento e devolução pelo ERP, vales, orçamentos, promoções). Sem dado real,
  com telas descritas em texto.
- **Migrações:** nenhuma.
- **Pronto:** os três roteiros revisados pelo dono.
- **Depende de:** F3-B30, F3-B53, F3-B65.

#### F3-B70 – Teste com dois caixas, homologação e fechamento da Fase 3
- **Tamanho:** P/M · **Rigor:** enxuto
- **Entregas:**
  - teste de ponta a ponta com dois PDVs simulados contra a API local (e, com a F3-Q36 (A), no servidor de homologação): vale em dois
    caixas offline; troca no caixa 1 com o vale usado no caixa 2 de outra loja; comodato de 2 cascos e a devolução (com a ordem inversa
    entre os caixas); o mesmo CPF em dois caixas e no ERP; o orçamento disputado; a troca de uma venda cancelada no ERP; a atualização
    beta (roteiro manual Windows);
  - SYNC (9.16/9.17, 10.1/10.4, 13.4 `CT`, 14.4, 17.5, 20.4), MD (4.5 comodato, 6.2 vales, 3.5.6, 7.3), PDV (10.10, 16.11, 23.3 nº 4,
    24.1, `CT`), ERP 15.4.4, READMEs, roadmap (itens [x] e as correções de "Decisões e documentos", D72 em diante), `andamento.md` com os
    próximos números;
  - roteiro do dono para a Definição de pronto (um dia de operação da loja piloto sem abrir o ERP para nada do balcão), sem dado real.
- **Pronto:** a Definição de pronto demonstrada e registrada, com cada item dependente do Windows marcado só depois do roteiro manual
  executado.
- **Depende de:** todos os blocos que entrarem na fase.

---

## Definição de pronto da Fase 3 × blocos

| Item da Definição de pronto (roadmap) | Onde é demonstrado |
|---|---|
| Critério PDV-2: um dia de operação da loja piloto sem abrir o ERP para nada do balcão (fora crediário, cartão integrado e PIX automático) | Roteiro do F3-B70, com as releases R3..R5 instaladas (F3-B30, B53, B65). **Ajuste de texto:** sem variações (D43) e, pela F3-Q47, sem pré-venda |
| Vale usado em dois caixas offline ao mesmo tempo: a nuvem aplica os dois, o saldo fica negativo e o alerta aparece no Dashboard | Integração do F3-B42; Dashboard no F3-B50; dois caixas no F3-B70 |
| Etiqueta de balança por peso e por valor e produto com lote vencido seguem as regras do PDV ("critérios 10.10") | Critérios escritos no F3-B19 (começo do PR-20); testes do F3-B20 e do F3-B21 |
| Cliente identificado leva 2 cascos em comodato; o termo sai em 2 vias e a devolução posterior baixa o saldo do cliente | F3-B39 (nuvem) e F3-B40 (caixa). Com a F3-Q13 (A), o item vira "não se aplica" |
| Troca com vale-troca e uso do vale em outra loja; estoque e caixa corretos na nuvem | F3-B43 (integração), F3-B45 (online), F3-B47 (caixa), F3-B70 |
| Atualização no canal `beta` chega a um caixa com o canal beta, nunca é aplicada com venda em andamento, e a falha de migração volta para a versão anterior com o banco intacto | F3-B31, F3-B32 (testes com feed falso) e o roteiro manual no Windows do F3-B33/B70, **executado e registrado**. **Ajustes de texto:** pela F3-Q34, o canal pode vir da exceção do terminal; com a F3-Q33 (B) ou (C), o item é reescrito para o caminho escolhido |
| Venda feita no ERP (caixa 0) baixa o estoque da loja e aparece nos relatórios junto com as do PDV | F3-B57 |

Itens de entrega do roadmap sem critério próprio, cobertos pelos critérios de cada bloco: atalhos configuráveis e Nova venda (F3-B13);
tipo de preço, parcelado, alteração de preço e acréscimo (F3-B16..B18); promoções e gelada (F3-B18, B34..B36); vendedor (F3-B28);
cadastro rápido (F3-B37, B38); orçamentos (F3-B60..B63); suspender e limites (F3-B23, B24); tabela de preços, foto e logotipo (F3-B24..B26);
crachá (F3-B27); baixa interna (F3-B51, B52); conferência e comprovantes (F3-B9); Parâmetros-PDV (F3-B12); fluxo `operacao` e
`vendas_status_pdv` (F3-B7, B10, B29); upcasters e versões do app (F3-B4, B31); catálogos grandes, longo offline e a meta de 150 ms
(F3-B36, B66); ressincronização (F3-B67, B68); material de treinamento (F3-B69). Variações e pré-venda: fora (D43; F3-Q47).

---

## Riscos

| Risco | Mitigação |
|---|---|
| **Base instalada heterogênea** (caixas no 0.10..0.13, "falta atualizar os caixas") | Conferir a versão de cada caixa no começo do PR-17; matriz de compatibilidade com o mais antigo em uso (tags `pdv-v0.10.0`..`pdv-v0.13.0`); caixa abaixo do 0.10 atualizado antes da R3 |
| **PDV novo diante de API antiga** (com a D70, a API é implantada pelo dono em outro momento): pagamento com vale gravado sem baixar o saldo, comodato recusado | Versões por onda (F3-B4): a v2/v3 só é anunciada no último bloco da onda; com `versoes_schema_nuvem` nulo, sempre a v1; o caixa só oferece o recurso com a versão anunciada; a API sempre antes do PDV, escrito no corpo de cada PR de release |
| **Auditoria com ação desconhecida** trava o evento para sempre (`auditoria.registros` não passa pelo T13) | As ações novas só com o recurso da onda disponível, e a API grava `acao_desconhecida` com alerta em vez de recusar (F3-B4); as ações no catálogo antes de qualquer PDV que as grave (F3-B3) |
| **Dois caixas da mesma loja em versões diferentes** (o antigo não aplica promoção nem pede complemento obrigatório) | Trava dura nas chaves de preço e pagamento: só ligam com 0 terminais ativos abaixo da versão (F3-B12); aviso nas demais; o canal beta só na Treino; o Velopack reduz a janela |
| **Volta de cursor** perde linhas que o caixa antigo já descartou | Uma migração EF `FaseTres` com os três cursores a 0 na R3 (F3-B7) e o teste com o mais antigo em uso compilado da tag |
| **Migrações grandes** (muitas tabelas, triggers e seed) | Três migrações menores (F3-B1..B3), cada uma revisada com 3 lentes, aplicadas numa base de teste com dados das Fases 1 e 2, nos PostgreSQL 16 e 18; o diagnóstico de órfãos só de leitura antes da implantação; a deduplicação dos templates "padrão" antes do índice |
| **Coluna nova em tabela de movimento** quebraria o `Esquema.g.cs` e o PDV num bloco só da nuvem | Nenhuma coluna nova nas tabelas de movimento (Padrões): gelado dentro do preço, baixa interna pela forma, situação do fechamento derivada |
| **Corridas offline** (vale em dois caixas, troca dupla, comodato em ordem inversa, mesmo CPF no ERP e no caixa, orçamento duplo) | Regra única "aplica e alerta" (P6); nenhum CHECK que estoure no handler (o `promocao_id` cru; o comodato comutativo); `for update` no vale; a mesma trava de documento do ERP na pessoa; reservas online com idempotência atômica; teste com dois caixas (F3-B70) |
| **Troca × cancelamento da mesma venda** (entrada dupla no estoque) | Regra nos dois sentidos (Padrões; F3-B11, F3-B44), testada nas duas ordens de chegada |
| **Troca antes da venda de outro caixa chegar** (a SYNC 8.5 só retém por evento do mesmo terminal) | Sem FK na origem de outro terminal; alerta `TROCA_ORIGEM_DESCONHECIDA` e o acerto da `quantidade_devolvida` quando a venda chega (F3-B44) |
| **Emissão do vale em dobro** na troca imediata | O vale de todo o crédito só dentro do `troca.registrada` (SYNC 9.16, PDV 23.2); `vale.utilizado` só no resgate em dinheiro (F3-B41, B43) |
| **Fraude com código de vale previsível** | F3-Q25: código de conferência de 4 dígitos impresso; o vale nominal acima de `pdv.vale_exige_cliente_acima`; auditoria do uso |
| **Reservas presas** por um caixa que quebrou (vale até 7 dias, orçamento 2 h) | "Liberar reserva" no ERP, com permissão e auditoria (F3-B50, F3-B61) |
| **LGPD**: vales com `pessoa_id` descendo a todos os caixas; pessoas criadas no caixa; busca de compras por CPF com o token de um terminal | F3-Q19 (janela de 90 dias e purga local); consultas com janela, limite de resultados, CPF mascarado, limite de taxa e auditoria (F3-B45, B37); fixtures inventadas |
| **Arredondamento** (promoção distribuída em centavos, devolução parcial repetida, etiqueta por valor, adicional com 4 casas, rateio da venda ERP) | Regra única do líquido mínimo; todo arredondamento pelo `Arredondamento`/`dec` com o teste que recusa `Math.Round` fora dele; testes de propriedade e vetores JSON compartilhados (F3-B35, B43, B54); decimal em tudo, nunca `number` para gravar |
| **Estoque** (complemento sem baixa, lote desconhecido no `INSERT`, custo da troca, baixa interna sem estorno próprio) | F3-B14, B20, B43, B51; `recalcular-saldos` "idêntico" em todo bloco que move estoque, inclusive o cancelamento e a devolução pelo ERP; tipos de estorno novos no seed |
| **Reprocessar não determinístico** (upcaster que lê o banco; forma editada depois da venda) | Upcaster puro com a regra da versão de origem (F3-B4); o `tipo_forma` de forma usada não muda (F3-B51) |
| **Código interno igual a uma etiqueta de balança** | O gerador fica fora do formato da etiqueta (F3-B21) |
| **Atalhos configuráveis** que não existem no caixa e são a base de todas as teclas novas | F3-B13 no começo do PR-19, com os critérios 28.4 |
| **Atualizador como porta de entrada** para executar código em todos os caixas | Feed fixo no build, só `https`, manifesto assinado com a chave no PC do dono, versão mínima permitida assinada, volta só por decisão local, revisão de segurança dedicada (F3-B32, D63) |
| **Velopack sem assinatura própria nem volta automática** | Spike com critérios de "segue / não segue" comprovados no Windows (F3-B8); o PR-22 não começa sem eles |
| **R3 com funções novas e troca de instalador juntas** | A R3 sai pelo instalador atual; a passagem é a 0.14.1, sem mudança de venda, caixa por caixa (F3-B33) |
| **Certificado Authenticode** demora e hoje só vem em token ou nuvem (o `.pfx` em segredo do `gerar-instalador.ps1` não serve mais) | F3-Q35: conferir o Smart App Control antes de comprar; assinar no PC do dono; o roadmap corrige "instalador assinado" |
| **Release do PDV sem o runner Windows** (D70) | OP-B3 (Wine) ou o PC Windows do dono; o `dotnet test` do PDV no Windows do dono antes da R3, R4 e R5; o que só o Windows cobre vai para o roteiro manual na Treino |
| **Primeira instalação Velopack em cada caixa** (duas cópias, mutex, atalho) | Roteiro de passagem do F3-B33, caixa por caixa; os dados em `%ProgramData%` não mudam; a mínima só sobe depois de todos migrados |
| **Balança** com protocolos variados e sem inventário | F3-Q1: etiqueta e peso digitado primeiro; a serial só com o modelo informado; D66 (arquivos do Nuvem3) |
| **Venda ERP sem nota em loja obrigada à NFC-e** (D67) | F3-Q38 com aviso fixo e o filtro "Documento fiscal: Sem documento" (F3-B58) |
| **Trava 7300001 com 8.000 eventos** compete com os outros caixas e o ERP | A trava pega o mais tarde possível (Padrões); medir no F3-B66 com vale, troca e comodato na massa antes de prometer "3–5 min" |
| **Medida de carga sem a latência do Cloud SQL** (otimista) | Latência VPS → Cloud SQL medida e injetada no servidor de homologação; números de máquinas diferentes registrados sem comparar valores absolutos (F3-B66) |
| **Servidor de homologação da Oracle** recuperado por ociosidade ou exposto | Tudo recriável por roteiro, sem dado que só exista nele; nenhum segredo de produção; Postgres sem porta pública; nada de runner do Actions (F3-Q36) |
| **Homologação da NFC-e (3F) esperar o fim das fases** | Com a ordem 2 → 3 → 4 → 5 → 3F, a preparação administrativa começa no início da Fase 5 (F3-Q37); o roadmap corrige o texto deste risco |
| **XSS nos templates e rota pública do orçamento** | Sanitização no servidor e escape (F3-B55); token em hash, expiração e limite de taxa (F3-B64); D63 |
| **Escopo grande** (70 blocos, muitos pequenos) | Ordem por valor e por dependência; blocos condicionais (F3-B22, B31..B33, B39, B40, B48, B51, B52, B64) só com a resposta do dono; o PR-18 entrega valor sem release do PDV |

---

## Decisões e documentos que este plano atualiza

- **Roadmap, Fase 3:**
  - Objetivo (critério PDV-2) e Entregas: tirar as **variações** (D43/D44, sem pergunta) e a **pré-venda** (F3-Q47); "Orçamentos e
    pré-vendas" vira "Orçamentos";
  - entrega de atualização: "instalador assinado" conforme a F3-Q35(b); o canal pela exceção do terminal (F3-Q34);
  - Definição de pronto: "critérios 10.10" passa a apontar a seção criada no F3-B19; o item da atualização conforme a F3-Q33 e a F3-Q34;
    o item do comodato conforme a F3-Q13;
  - Riscos: "Homologação da NFC-e" reescrito para a ordem 2 → 3 → 4 → 5 → 3F (F3-Q37); "Certificado Authenticode" conforme a F3-Q35;
  - §16 a partir da D72.
- `docs/planos/decisoes-do-dono.md`: as respostas F3-Q1..F3-Q48 (e a D15, a D66, a D28 confirmada e o servidor da Oracle da D70).
- READMEs: API a partir da 215, ERP a partir da 86, PDV a partir da 93 (conferir a numeração no merge), com os Padrões desta fase.
- **SYNC:** 9.16 e 9.17 (o restante da troca imediata como saldo do mesmo vale, já correto, só reforçado; o `vale.utilizado` só no
  resgate), 10.1, 10.4 (estorno do comodato, troca × cancelamento), 13.4 (`CT` com DV e o código de conferência), 14.4 (rotas em
  `/sync/consultas/*`), 17.5 (anúncio no fim da onda, `versoes_schema` nulo → v1, upcaster puro, auditoria desconhecida), 20.4, 6.11,
  6.12 (logotipo e `cupom_mono`).
- **MD:** 3.5.6 e 4.5 (comodato comutativo e o estimado), 6.2 (vales com a janela de 90 dias e a purga local), 7.3 (estornos novos),
  3.13 (vale com código de conferência), 3.11.3 (comissão prevista).
- **PDV:** 10.4 (lacuna), 10.10 (criada), 16.11 e 24.1 (rotas), 23.3 nº 4 (relatório na Fase 5), `CT`.
- **ERP:** 15.4.4 (rotas e "Liberar reserva"), 15.1 ("Liberar reserva" do orçamento), 15.2/15.3 (comprovante com layout fixo).
