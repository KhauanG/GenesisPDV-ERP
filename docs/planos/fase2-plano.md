# Plano final da Fase 2 – Produtos e estoque completos (sem a parte fiscal)

Branch lido: `funcionalidade/pdv-piloto` (só leitura). Base: a proposta A ("valor primeiro"), com os enxertos da B no núcleo do
razão e todas as correções da crítica. A última migração de empresa hoje é `0015_lojas_treino.sql`. O I5 (implantação) está
editando o working tree, então **toda numeração de migração abaixo (`00NN_…`) é provisória e precisa ser conferida no merge**.

Restrição do dono: tudo funcional **sem a parte fiscal**. A importação de NF-e de fornecedor por **arquivo XML** entra (é
operacional). Os campos de tributação do produto só são gravados, sem cálculo, e ficam no último bloco.

---

## Estado atual

O que as Fases 0, 1A, 1B e 1C já deixaram pronto, e o que falta, por área.

### Razão e motor de estoque
- **Pronto.** `movimentos_estoque` tem todas as colunas do MD 3.7.2: lote, fator, custos, `custo_medio_posterior`, `terminal_id`,
  `evento_id`, `estorno_de_id` e `compensa_movimento_id`. Também tem os checks e os índices de idempotência, compensação e estorno,
  além do BRIN de `data_movimento` (migrações 0004 e 0013).
- **Pronto.** O seed traz todos os tipos de movimento do MD 7.3: RECEB_*, ESTORNO_RECEB_*, TRANSF_*, MUDANCA_TIPO_ESTOQUE,
  AJUSTE_RELATORIO etc. Só que nenhum código gera RECEB_*, TRANSF_*, MUDANCA_TIPO_ESTOQUE, TROCA_PDV nem BAIXA_INTERNA.
- **Pronto.** Motor `apps/api/src/estoques/movimentos.ts`:
  - trava as linhas em ordem estável (`ordenarChaves`) e trabalha em blocos de 1000;
  - aplica custo médio ponderado na entrada e o custo médio vigente na saída;
  - estorna a saída ao custo original (T20);
  - faz as contas em decimal (`custoMedioAposEntradaTexto` e `custoMedioAposEstornoTexto` no shared).
- **Pronto.** A projeção `produtos.custo_medio` é mantida por trigger (0006).
- **Pronto.** Acerto Entrada/Saída/Definir:
  - rascunho, efetivar e estornar;
  - `data_contagem` com a fórmula que desconta os movimentos posteriores;
  - bloqueio de saldo negativo, salvo `estoque.permite_negativo_erp` ou Master;
  - aviso de "PDVs offline/eventos pendentes".
- **Adiantado na 1C (T23).** A compensação dos eventos tardios (ACERTO_COMPENSACAO) já existe na venda, no cancelamento e na
  devolução de cascos (`sync/handlers/vendas.ts:700-735`, `cancelamento.ts:522`, `vasilhame.ts:160`), e o estorno do Definir
  estorna as compensações. A **decisão 76 do README da API está desatualizada**: ela ainda diz "Fase 2".
- **Pronto, com ressalvas.** A importação por planilha com "Atualizar estoque" gera um Definir de origem `importacao`, inclusive
  com saldo negativo do Nuvem3. Porém usa `dataContagem = new Date()` (`importacao.ts:701`) e exige loja (`importacao.ts:256-260`),
  então não serve ao CD.
- **Falta.**
  - Não há ordem de lançamento confiável. O id é um uuidv7 gerado no Node (`movimentos.ts:187`), e `criado_em` é a hora de início
    da transação.
  - Não existe `db:recalcular-saldos`.
  - Ninguém escreve em `saldos_lote` nem em `saldos_estoque.ultima_compra_em` / `ultimo_custo_compra`.

### Estrutura de estoque
- **Tipos de estoque.** O seed tem os 5 tipos do MD 7.4. Existe só `GET /tipos-estoque` e uma tela somente leitura, em que a chave
  USOS `'avariado'` nunca casa com o seed `'avaria'`. As permissões `tipos_estoque.*` já estão no catálogo, e
  `ressincronizarFluxosDaLoja` existe (`sync/comandos.ts:113`).
- **Acesso por estoque.** A tabela `usuarios_estoques` e a tela que a mantém existem, mas `estoqueVisivel` e
  `filtroEstoquesVisiveis` não a leem (decisão 89, "destino Fase 2"). Hoje quem tem lojas restritas enxerga todos os estoques sem
  loja, inclusive o CD.
- **O CD** "CD - Estoque Ice Beer" é um estoque `deposito` sem loja.

### Produtos e catálogo
- **Schema.** O schema Drizzle cobre quase todo o MD 3.6: variações, códigos de barras com `variacao_id`, componentes,
  relacionados, preço por quantidade, `produtos_lojas` (com o ST retido), tributação por UF, lotes, fornecedores, imagens e
  histórico de preços. **As tabelas de complementos não existem** (`vendas.ts:466` marca `complemento_id` como "futuro").
- **Formulário em acordeão** (`FormularioProduto.tsx`, 1.836 linhas). Tem preços, embalagens, combo/ficha, outras informações,
  categorias (MultiSelect), preço por quantidade, lojas, estoque somente leitura, balança e tributação, além de Duplicar, Excluir,
  Histórico (pela auditoria) e BuscaNcm.
  - **Faltam:** relacionados, validade/lotes, fornecedores, foto, "Ajustar", categorias em árvore e saldo em trânsito.
- **Histórico de preços.** Já é gravado, mas `registrarHistoricoPrecos` fixa a origem `'cadastro'` (`gravacao.ts:536, 549`), mesmo
  quando quem chama é a importação. Não há tela.
- **Risco aberto hoje.** O ERP deixa escolher o tipo "Com variações" (`FormularioProduto.tsx:498`) sem grade nenhuma. Além disso,
  o PDV resolve o EAN de uma variação para o produto pai (`CatalogoLocal.cs:28-44`) e vende com o preço e o saldo do pai.
- **Pronto:**
  - categorias em árvore com mover;
  - marcas com mesclar;
  - GTIN/EAN com `geral.ean_duplicado` e o filtro "EAN duplicado";
  - importação em tarefa com prévia, validada com a planilha real (1.664 produtos, reimportação 100% sem alteração);
  - tabela NCM vigente.
- **Tabela `cests` vazia** (decisão 41).

### Entradas
- `produtos_fornecedores` existe só no schema, sem API nem tela (decisão 74). Fornecedor é pessoa com a categoria `fornecedor`,
  e `validarCnpj`, `normalizarCnpj` e `validarChaveAcesso` estão no shared.
- Já existem: as permissões `recebimentos.*` e `notas_entrada.*`, os itens de menu marcados "Fase 2" (sem tela), `cfops`,
  `ArmazenamentoObjetos.chaveXmlFiscal`, a tabela `arquivos` e o upload multipart da importação.
- Não existem as tabelas `recebimentos`, `notas_entrada` e afins.

### Transferências e relatórios
- **Já existem:** os tipos TRANSF_* no seed, o documento `transferencia` aceito pelo razão, a origem de acerto
  `perda_transferencia`, as permissões `transferencias.*` e `relatorios.*`, e a chave `estoque.transferencia_recebimento_automatico`.
- **Não existem** as tabelas de transferência.
- **`<Relatorio>`.** A casca existe, com teste, mas nenhuma tela a usa e ela não pagina no servidor.
- **Exportação.** É síncrona, com `write-excel-file` e teto de 50.000 linhas.
- **Também prontos:** as tarefas em segundo plano (`TarefasSegundoPlano`, link de 7 dias), `GET /auditoria`, `GET /saldos-estoque`
  e `GET /produtos/:id/saldos`.
- **Limite de memória.** Pela decisão de implantação de 03/11/2026, a VPS da Hostinger dá 2 GB ao genesis-api
  (`--max-old-space-size=1536`).

### PDV e sincronização
- **Já descem e já estão no espelho** (`Esquema.g.cs`, `PdvDbContext.cs`): variações, valores de atributos, lotes (filtrados pelo
  estoque da loja), `saldos_lote` (só do tipo vendável), relacionados e tributação por UF.
- **Protocolo.** `venda.finalizada` v1 já leva `variacao_id` e `lote_id`, e o T13 (`versoes_schema`) está implementado. **A Fase 2
  não precisa de tipo nem de versão nova de evento.**
- **Padrões do C8b que valem aqui:** o aplicador ignora tabela ou coluna desconhecida, e uma tabela nova num fluxo exige uma
  migração EF que volte o cursor.
- **Ainda não existem:**
  - F4 "Outras lojas";
  - FTS5 (a pesquisa F2 filtra em memória);
  - `/sync/arquivos`;
  - `foto_url` no pull;
  - a guarda de produto com variações.

---

## Fora da Fase 2

| Item | Motivo |
|---|---|
| Emissão de NFC-e/NF-e, SAT/MFE, certificado A1/A3 (D11) | Restrição do dono. A D11 deixa de bloquear a Fase 2. |
| Recebimento pela SEFAZ (Distribuição DF-e: aba "Pela Sefaz", `dfe_controle_nsu`, `dfe_documentos`, tarefa por CNPJ, cStat 137/656, origem `sefaz`) e o critério "outra NF-e pela SEFAZ" da Definição de pronto | Restrição do dono (consulta à SEFAZ exige certificado). |
| Manifestação do destinatário (`manifestacoes_destinatario`; `notas_entrada.manifestar` fica sem uso) e consulta de situação/protocolo da NF-e na SEFAZ | Restrição do dono. Sem certificado, a importação mostra só um aviso fixo de que não confere cancelamento nem denegação. |
| NF-e de transferência CD → loja e NF-e de devolução ao fornecedor | Fiscal (D6; Fase 6 ou 3F). `transferencias_estoque.documento_fiscal_id` fica nulo e sem FK. |
| **Conversão de CFOP** (`conversoes_cfop`, seed, CRUD, tela em Configurações › CFOP's, precedência e aba da nota) | Só tem uso na escrituração e no SPED, sem ganho operacional. Foi cortada das duas propostas pela crítica e vai para a 3F/4. Na Fase 2, o item da nota grava só o CFOP original do XML, e `cfop_entrada` fica nulo e reservado. A nota não depende de CFOP para ficar "Pronta". |
| Abatimento de créditos de ICMS/PIS/COFINS no custo (`estoque.custo_abate_creditos` continua desligado) e qualquer uso fiscal dos impostos do XML (livros, SPED) | Fiscal. Os valores só são gravados. |
| Repasse e preenchimento automático do ST retido por loja (`fiscal.st_retido_criterio`, cópia na transferência) | Fiscal. Só entra o preenchimento manual gravado (F2-B52). |
| "Sugerir pela regra da UF", aviso de tributação divergente, cBenef × benefícios, CEST × NCM para emissão, item não vendável em loja NFC-e, % aproximado de tributos (IBPT), cálculo de IBS/CBS/IS | Fiscal (P6). As validações leves que já existem no zod (5405 ⇔ CST 60/500, CEST com ST) ficam como estão. |
| Uso no caixa da tributação que já desce (`produtos_tributacao_uf`, ST em `produtos_lojas`) e o grupo `rastro` na NFC-e | Fase 3F. |
| Venda de variação, de complemento e escolha de lote no caixa | PDV-2 (Fase 3). Na Fase 2, o espelho, a guarda das variações (F2-B34) e o FEFO na nuvem (F2-B6). |
| Geração de TROCA_PDV e BAIXA_INTERNA | Fase 3 (roadmap, linha 497). O critério "todos os tipos de movimento do seed" da Fase 2 os exclui. |
| DANFE em PDF da nota de entrada; motor de PDF na API (romaneio, fichas) | Sem ganho operacional na Fase 2. A aba XML mostra o XML formatado, e o romaneio e as fichas são impressos pelo navegador. |
| Cache LRU das fotos e foto na tela de venda do PDV | `pdv.exibe_foto_produto` tem padrão `false`. Na Fase 2 entram só o `/sync/arquivos` e os campos `foto_url`/`foto_sha256`. |
| Coluna WooComm do Produtos geral | Integração da Fase 7: a coluna fica escondida. |
| "Gerar financeiro" do recebimento e duplicatas como contas a pagar | Fase 4. As colunas ficam gravadas e sem uso. |
| Mapeamento definitivo de `UsaBalancaEtiquetadoraStr` (decisão 104) e das colunas do "grupo de itens" do Nuvem3 (decisão 95) | Dependem dos arquivos reais do dono (F2-Q14). Até lá, vale o provisório. |
| Condicionais que vão para o backlog conforme as respostas | Variações (F2-B48–B50) e complementos (F2-B45, só a parte de complementos, e F2-B51), conforme a F2-Q1. Base externa de GTIN (F2-B47), conforme a F2-Q13. |

---

## Perguntas ao dono

**Regra:** enquanto a pergunta não for respondida, vale a **recomendação**, implementada de forma **configurável** (chave de
configuração indicada). Ao registrar no roadmap §16, as perguntas novas recebem os códigos **D43 em diante** (o D42 já existe:
convivência com o Nuvem3).

| Código | Pergunta | Opções | Recomendação (padrão) | Bloqueia |
|---|---|---|---|---|
| **F2-Q1** (registrar como D43) | A Ice Beer usa produtos **com variações** (mesmo produto em tamanhos, sabores ou cores, com estoque separado) ou **com complementos** (adicionais escolhidos na venda)? A planilha real do Nuvem3 não trouxe nenhuma variação. | (a) Nenhum dos dois: variações e complementos vão para o backlog e os tipos continuam travados na criação. (b) Só variações: F2-B48–B50 entram no fim da fase. (c) Os dois: F2-B48–B51, e as tabelas de complementos entram no F2-B45. | **(a)** até a resposta. A trava do F2-B1 e a guarda do F2-B34 fecham o risco a baixo custo. As variações atravessam o razão inteiro sem uso comprovado, e o fluxo é de balcão, sem comandas nem delivery (D4). Chaves `produtos.variacoes_habilitadas` e `produtos.complementos_habilitados` = `false`. | F2-B48, B49, B50, B51 e a parte de complementos do F2-B45 |
| **F2-Q2** (D44) | Enquanto o caixa não sabe escolher a variação (Fase 3), o que ele faz quando o operador passa o EAN de uma variação ou o código de um produto pai que tem variações? | (a) Recusa com "Produto com variações: venda disponível na próxima versão". (b) Vende como produto comum, com o preço e o estoque do pai (o que acontece hoje). (c) O ERP não deixa criar variações até a Fase 3. | **(a)**, por `pdv.recusa_produto_com_variacoes = true`. A (b) baixa o estoque errado sem aviso, e o erro só aparece no inventário. O pai **sem** variação ativa continua vendendo. | F2-B34 e a liberação do F2-B48 |
| **F2-Q3** (D6, já existe) | O CD tem CNPJ próprio? As notas das compras entregues no CD vêm com qual CNPJ de destinatário? | (a) Não tem: a nota vem em nome de uma loja, e na importação o estoque de destino é o CD. (b) Tem: o CD é cadastrado como loja do tipo "depósito", com o CNPJ dele. | Implementar o que serve aos dois casos: o destinatário pode ser o CNPJ de qualquer loja da empresa (inclusive depósito), e o estoque de destino é escolhido entre os permitidos. **Aviso ao dono:** se o CD e as lojas tiverem CNPJs diferentes, levar mercadoria sem NF-e de transferência é irregular até a fase fiscal. | F2-B19 (teste com nota real do CD) e o cadastro do CD |
| **F2-Q4** (D45) | Quem pode **ver e movimentar o CD** e os outros estoques sem loja, quando o acesso por estoque passar a valer? | (a) Manter como hoje: a virada copia para `usuarios_estoques` o acesso que cada usuário já tem, e o gerente ajusta depois. (b) Só o Master e os perfis com `estoques.todos`. (c) Uma lista nominal de usuários. | **(a)**. Ninguém perde acesso no deploy, e a restrição passa a ser uma decisão explícita do gerente na tela de usuários. | F2-B5 (virada) |
| **F2-Q5** (D46; ERP 23.1 nº 14) | Como entra o saldo inicial no Genesis, e quando se conta? | (a) Só contagem física com a hora da contagem informada; a loja pode estar vendendo. (b) Só a exportação de saldos do Nuvem3 na virada. (c) Primeiro a exportação do Nuvem3 na virada, depois contagens por setor com Definir nas semanas seguintes, com a loja aberta. | **(c)**. O Genesis vira o controle oficial no dia da virada, e as contagens corrigem aos poucos (a compensação cobre as vendas offline). Os dois caminhos ficam prontos (F2-B9 e F2-B11). | Roteiro do F2-B11 e ordem do F2-B53 (não muda código) |
| **F2-Q6** (D47) | Qual diferença entre o saldo do Genesis e a contagem física aceitamos para dar a loja piloto como conferida? | (a) Por valor: diferença total a custo de até 1% do valor contado, sem nenhum item acima de 5% do próprio saldo. (b) Por item: zero nos 100 itens de maior giro e até 1% no total. (c) Outro critério do dono. | **(a)**, com os limites configuráveis no relatório de conferência (`estoque.tolerancia_conferencia_total_pct = 1`, `estoque.tolerancia_conferencia_item_pct = 5`). É em percentual e valor, nunca em "unidades", porque há venda a granel ou por kg. | Aceite da Definição de pronto (F2-B11, F2-B53) |
| **F2-Q7** (D48) | Lote e validade: quais produtos controlam lote? E como a venda do caixa, que ainda não informa o lote (Fase 3), deve baixar o saldo por lote? | (a) **Dividir o movimento por lote** na nuvem: a saída sem lote vira um movimento por lote, em ordem FEFO (o que vence primeiro), com `lote_id` gravado; a sobra sem saldo de lote fica sem lote. (b) Não baixar: o saldo por lote só muda com movimento que informa o lote, e diverge do total. (c) Sem lote na Fase 2. | **(a)**, por `estoque.lote_baixa_sem_informar = 'fefo'` (a alternativa é `'nao_baixar'`). É a única opção em que o saldo por lote é **reconstruível pelo razão** e o estorno sabe para qual lote devolver. Só são afetados os produtos com lote cadastrado e com saldo. | F2-B6, e por consequência o lote no recebimento, na NF-e e na transferência |
| **F2-Q8** (D49) | No custo da mercadoria que vem pela NF-e entram ICMS-ST, FCP-ST, IPI, frete, seguro e outras despesas? Os créditos de impostos são descontados? | (a) Entram todos, e os créditos não são descontados (padrão de hoje). (b) Algum fica de fora (dizer qual). | **(a)**. É o padrão para quem compra bebida com ST, e as chaves `estoque.custo_inclui_st/ipi/frete` continuam configuráveis. **Confirmar com o contador** conforme o regime da Ice Beer, porque isso define o custo médio e o lucro. | Só o valor padrão no F2-B21 (o código não muda) |
| **F2-Q9** (D50) | Quando a assinatura digital do XML do fornecedor não confere, o Genesis recusa a nota ou só avisa? | (a) Recusa. (b) Avisa, e um usuário com `notas_entrada.importar` confirma. (c) Não confere a assinatura. | **(b)**, por `notas_entrada.assinatura_invalida = 'avisar'`. Sempre se recusa: XML malformado, sem protocolo autorizado, modelo ≠ 55, chave com DV errado, destinatário fora da empresa e chave já importada. O XSD não é validado na Fase 2. | F2-B18 (inclui a dependência de verificação de assinatura) |
| **F2-Q10** (D51) | Transferência: a loja recebeu menos do que o CD mandou, e a diferença é perda (quebra, extravio). Onde a perda é lançada? | (a) Só como registro, sem mexer em saldo (precisa de um tipo de movimento novo, de "baixa em trânsito"). (b) A diferença volta ao CD (TRANSF_RETORNO) e sai de lá na hora como perda (acerto de saída de origem `perda_transferencia`): o saldo do CD não muda e a perda fica registrada a custo. (c) A perda entra no estoque da loja de destino. | **(b)**. Usa os tipos de movimento que já existem e não tira o produto duas vezes do CD, como aconteceria com a especificação ao pé da letra. | F2-B24 |
| **F2-Q11** (D52) | A sugestão de reposição arredonda para o fardo ou a caixa fechada? | (a) Sim, para cima, até completar a embalagem de compra ativa de maior fator, sem passar do saldo do CD. (b) Não: a sugestão sai em unidades. | **(a)**, por `estoque.reposicao_arredonda_embalagem = true`. O que já está em trânsito para a loja é sempre descontado. | F2-B25 |
| **F2-Q12** (D53) | No caixa, o que a consulta F4 "Outras lojas" mostra, e quem pode usar? | (a) Só o estoque vendável das lojas reais e do CD, sem a loja Treino, liberado a qualquer operador. (b) Também avaria e vasilhame vazio. (c) Exige uma permissão própria (supervisor). | **(a)**, desligável por `pdv.consulta_outras_lojas`. Mostra só quantidades, nunca o custo. | F2-B35 (contrato do endpoint) |
| **F2-Q13** (D54; ERP 23.1 nº 17) | A Ice Beer vai contratar uma base externa de códigos de barras (ex.: Cosmos, paga) para sugerir nome, NCM, marca e foto no cadastro em massa? | (a) Não agora: o "Pesquisar EAN" procura só na base da empresa. (b) Sim: indicar o serviço e quem contrata. | **(a)**. O F2-B47 vai para o backlog, e o cadastro em massa não depende dele. | F2-B47 |
| **F2-Q14** (decisões 95 e 104 do README da API) | O dono consegue enviar exportações reais do Nuvem3 com a coluna `UsaBalancaEtiquetadoraStr` preenchida e com o "grupo de itens" (combo)? | (a) Sim: fechamos o mapeamento definitivo. (b) Não: mantemos o provisório da balança (decisão 104) e o combo pela coluna `composicao`. | **(b)** até os arquivos chegarem. O mapeamento fica isolado num ponto só, para trocar sem retrabalho. | Parte de importação do F2-B40 |

### Padrões aplicados sem pergunta (registrar no README; o dono pode mudar depois)

- **Estorno que deixa saldo negativo** (recebimento ou NF-e já vendidos, ERP 23.1 nº 4): bloqueado, salvo Master ou
  `estoque.permite_negativo_erp`, como no acerto. A confirmação entra na lista do fechamento (F2-B53).
- **Data dos documentos do ERP:** `data_movimento` é o momento do lançamento (`now()`). A data do documento, ou da entrada da nota,
  fica só no cabeçalho. Só lançam no passado o Definir (na `data_contagem`) e o AJUSTE_IMPORTACAO (na hora da contagem informada),
  pela flag `retroativoPermitido` (F2-B4).
- **Tipo de Estoque:** mantém o desenho atual (vendável, padrão, 5 tipos de sistema) até o Khauan confirmar a semântica do Nuvem3
  (ERP 23.1 nº 2).
- **Tipos de produto:** mantêm os 8 valores atuais do enum (ERP 23.2 questão 18).
- **Transferência:** leva `tipo_estoque_id` no cabeçalho, com padrão = o tipo padrão, para os cascos vazios voltarem ao CD. A
  diferença recebida a menor e ainda não tratada aparece como **pendência separada** ("Divergência a tratar") e não conta como em
  trânsito. Transferência parada em trânsito gera alerta depois de `estoque.transferencia_alerta_dias = 3`.
- **Impressão:** romaneio, folha de contagem, espelho do recebimento e ficha da marca saem pela impressão do navegador.
- **Exportação grande:** xlsx gerado em streaming, com csv como alternativa.
- **`geral.ean_duplicado`:** a Ice Beer volta de "avisar" para "bloquear" quando o relatório de EAN duplicado (F2-B38) zerar.
- **`geral.produto_usa_fornecedores`:** o padrão do catálogo continua `false`, mas na Ice Beer é ligada junto da importação de NF-e
  por XML (PR-5), porque é o bloco que mostra o vínculo aprendido.
- **`produtos_lotes.estoque_id`:** imutável depois de gravado (trocar exige excluir e recriar, e não se exclui lote com saldo).

---

## PRs

1. **PR-1 "Base do estoque oficial"** (F2-B1 a F2-B5)
   - Conteúdo: trava dos tipos sem suporte, ordem de lançamento gravada com a função pura comum, `db:recalcular-saldos`,
     compensação no motor com a regra de data e o teste da DoD "Definir com PDV offline", e estoques permitidos com virada sem
     perda de acesso.
   - Valor: o saldo passa a ser auditável e reconstruível.
2. **PR-2 "Projeções do razão e tipos de estoque"** (F2-B6 a F2-B8)
   - Conteúdo: `saldos_lote` mantido pelo motor (FEFO dividindo o movimento), última compra, cadastro de Tipo de Estoque com
     ressincronização e mudança de tipo.
   - Valor: o razão fica pronto para lotes e documentos.
3. **PR-3 "Inventário inicial e ajustes"** (F2-B9 a F2-B12)
   - Conteúdo: importar contagem do coletor, folha cega, divisão acima de 5.000 itens, compensações visíveis, hora da contagem e
     CD na planilha, conferência com tolerância, roteiro, e no formulário o Ajustar, as categorias em árvore e os relacionados.
   - Valor: a Ice Beer carrega e confere o estoque real.
4. **PR-4 "Fornecedores e recebimento manual"** (F2-B13 a F2-B17)
   - Conteúdo: fornecedores no produto, recebimento com núcleo de entrada compartilhado, rateio, fator, lote, última compra e
     preço com histórico de origem correta, e o bloco Validade/lotes.
   - Valor: toda compra entra pelo Genesis.
5. **PR-5 "NF-e de fornecedor por XML"** (F2-B18 a F2-B21)
   - Conteúdo: parser seguro com fixtures, validações sem SEFAZ, fornecedor automático, vinculação com fator aprendido, e custo com
     ST/IPI/frete.
   - Sem conversão de CFOP.
6. **PR-6 "Transferência CD ⇄ loja"** (F2-B22 a F2-B27)
   - Conteúdo: duas etapas, divergência, sugestão de reposição, em trânsito com alerta, telas e romaneio.
7. **PR-7 "Relatórios de estoque"** (F2-B28 a F2-B33)
   - Conteúdo: massa de 4 milhões de movimentos com índices medidos, exportação em tarefa por streaming, `<Relatorio>` paginado com
     o ícone Tarefas, Estoque Atual com ajuste e Movimentação analítica e sintética.
8. **PR-8 "PDV: guarda e consulta"** (F2-B34 a F2-B36)
   - Conteúdo: **release R1 do PDV** com a guarda das variações, o F4 "Outras lojas" e a pesquisa F2 com FTS5 (opcional).
   - Sem mudança no `Esquema.g.cs`. A API é publicada antes do PDV.
9. **PR-9 "Catálogo operacional"** (F2-B37 a F2-B42)
   - Conteúdo: histórico de preços, EAN duplicado, cadastro em massa, exportação de ida e volta, Produtos geral, NCMs inválidos com
     a carga do CEST e Histórico de produtos.
10. **PR-10 "Arquivos, imagens e protocolo do PDV"** (F2-B43 a F2-B45)
    - Conteúdo: upload com variante, foto, imagens, categorias e marcas completas, e a **release R2 do PDV**, com uma única volta de
      cursor do `catalogo` para `foto_url`/`sha256` e, se a F2-Q1 incluir complementos, as tabelas de complementos.
11. **PR-11 "Utilitários"** (F2-B46; F2-B47 só se a F2-Q13 for "sim")
    - Conteúdo: NCM/CEST pela plataforma e base de GTIN externa.
12. **PR-12 "Variações"** (F2-B48 a F2-B50), condicional à F2-Q1
    - Conteúdo: grade, saldo por variação nos documentos e planilha.
    - A chave só é ligada em produção no fim do PR, com a R1 do PDV já publicada.
13. **PR-13 "Complementos: modal"** (F2-B51), condicional à F2-Q1.
14. **PR-14 "Tributação gravada e fechamento"** (F2-B52, F2-B53)
    - Conteúdo: campos fiscais só guardados, documentação, Definição de pronto sem a SEFAZ e execução com o dono.

---

## Blocos

### PR-1 – Base do estoque oficial

#### F2-B1 – Trava dos tipos sem suporte (Com variações / Com complementos)
- **Tamanho:** P
- **Objetivo:** parar já o risco de produto "Com variações" criado sem grade, que vende com o preço e o saldo do pai, sem quebrar o
  legado nem a ida e volta da planilha.
- **Entregas:**
  - **Chaves de configuração.** `produtos.variacoes_habilitadas` e `produtos.complementos_habilitados` (padrão `false`) no catálogo
    de configurações, no lugar de uma lista fixa de tipos. Os blocos F2-B49 e F2-B51 é que as ligam.
  - **API.** `POST /produtos` recusa criar `com_variacoes` ou `com_complementos` com 422 ("Tipo disponível em breve") quando a
    chave está desligada.
    - O `PUT` de produto já gravado com esses tipos continua aceito, sem obrigar a trocar o tipo.
    - Trocar `com_variacoes` para outro tipo é permitido quando não há variação ativa.
  - **ERP.** Na criação, o select do `FormularioProduto.tsx:498` lista só os tipos habilitados. Na edição, mostra o tipo gravado.
  - **Importação.** Recusa só a **criação** desses tipos, com o mesmo motivo. A **atualização** de produto existente segue normal:
    um `com_complementos` vindo da carga do Nuvem3 continua passando, e a reimportação segue 100% sem alteração.
  - **Caixa.** `com_complementos` continua vendável no PDV, sem complementos (PDV 10.2). Nada muda no caixa neste bloco.
  - **Legado.** Filtro "Situação de cadastro = Tipo sem suporte" (`SITUACOES_CADASTRO_PRODUTO` e `condicoes()` do controller). A
    tela orienta a converter os `com_variacoes` sem grade para Simples antes da release do PDV com a guarda (F2-B34).
  - Decisão nova no README da API.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `packages/shared/src/configuracoes.ts`,
    `apps/api/src/produtos/produtos.controller.ts`, `apps/api/src/importacao/produtos.ts`,
    `apps/erp-web/src/paginas/produtos/FormularioProduto.tsx`.
  - Sem migração de schema; só o seed das chaves, se o catálogo exigir.
  - Sem mudança no PDV.
- **Testes:**
  - Vitest da regra.
  - Integração da API: `POST` com tipo bloqueado devolve 422; `PUT` de produto existente devolve 200; troca de `com_variacoes` para
    Simples sem variações é aceita.
  - Integração da importação: criação desses tipos recusada, atualização aceita, e a reimportação da planilha de teste dá 100% sem
    alteração.
  - ERP: o select de criação aparece sem os dois tipos.
- **Critério de pronto:** criar `com_variacoes` ou `com_complementos` pelo ERP, pela API ou pela planilha é recusado com mensagem
  clara. Os produtos existentes continuam editáveis e importáveis, e o filtro lista o legado.
- **Depende de:** nada.
- **Decisões usadas:** F2-Q1, F2-Q2; PDV 10.2; README da API, decisão 74; crítica (recusar só a criação).

#### F2-B2 – Ordem de lançamento gravada e função pura comum ao online e ao replay
- **Tamanho:** M
- **Objetivo:** dar ao razão uma ordem de lançamento estrita por linha de saldo. Hoje ela não existe: o uuidv7 é gerado no Node e
  o `criado_em` é a hora de início da transação. O custo médio depende da ordem de **lançamento**, não da `data_movimento`, então
  sem essa ordem o replay do razão não repete o custo médio.
- **Entregas:**
  - **Migração A** (rápida, sem reescrever a tabela):
    - cria a sequência `seq_movimentos_estoque` (`cache 1`), **iniciando em 1.000.000.000.000**;
    - faz `ADD COLUMN seq_lancamento bigint NULL` sem default, o que é só metadado;
    - faz `ALTER COLUMN … SET DEFAULT nextval(...)`, que vale só para as linhas novas.
    - O `nextval` roda no `INSERT`, depois do `select … for update` da linha de saldo, e por isso é monotônico por linha.
  - **Comando `db:preencher-seq-lancamento`**, que roda fora da transação da migração, em lotes por linha de saldo (estoque,
    produto, variação, tipo):
    - encadeia os movimentos antigos pelo `saldo_anterior` = `saldo_posterior` do anterior, com desempate por `id`, e **não** usa
      `criado_em` como critério;
    - atribui 1…N nessa ordem, sempre abaixo do início da sequência;
    - uma quebra de cadeia **não aborta**: a linha recebe a ordem (`criado_em`, `id`), entra no relatório e gera um alerta de
      plataforma.
  - **Migração B**, depois do preenchimento:
    - `CHECK (seq_lancamento is not null) NOT VALID` → `VALIDATE CONSTRAINT` → `SET NOT NULL` (no PG ≥ 12 usa o check validado, sem
      varrer de novo sob trava exclusiva);
    - índice `ix_movimentos_estoque_linha_seq (estoque_id, produto_id, variacao_id, tipo_estoque_id, seq_lancamento)` com
      `CREATE INDEX CONCURRENTLY` fora da transação. Se o `migrar-empresas` não suportar isso, o índice vai pelo próprio comando.
    - Rodar em janela combinada: o PDV só reenvia.
  - **Função pura `aplicarMovimentoNoSaldo(saldo, custoMedio, mov)`** em `packages/shared/src/estoque.ts`. Cobre entrada, saída,
    estorno T20, compensação e Definir, com o arredondamento a 4 casas em cada passo. O motor online (`movimentos.ts`) passa a
    usá-la sem mudar o comportamento.
  - SQL `verificarCadeia(linha)`, reaproveitado pelo F2-B3.
  - README da API:
    - corrigir a decisão 76 (a compensação existe desde a 1C);
    - registrar a decisão nova "ordem de lançamento = `seq_lancamento`".
- **Arquivos/migrações:**
  - Migrações: `00NN_movimentos_seq_a.sql` e `00NN_movimentos_seq_b.sql` (custom).
  - Arquivos: `apps/api/src/cli/preencher-seq-lancamento.ts`, `apps/api/package.json`,
    `apps/api/src/database/empresa/schema/estoque.ts`, `apps/api/src/estoques/movimentos.ts`, `packages/shared/src/estoque.ts`,
    `packages/shared/src/estoque.propriedade.spec.ts`.
  - Sem espelho no PDV.
- **Testes:**
  - Propriedade, com gerador de semente fixa (ou fast-check como devDependency): sequências aleatórias de entradas, saídas,
    estornos, compensações e Definir, inclusive com saldo zero e negativo. O motor online passo a passo e o replay da lista dão o
    mesmo saldo e o mesmo custo médio em decimal.
  - Integração: duas conexões fazem `lancarDocumento` na mesma linha (venda do PDV × acerto do ERP); a `seq_lancamento` sai
    crescente e a cadeia fica contínua.
  - Integração: o preenchimento sobre o banco das suítes da 1C termina com zero quebras; sobre uma cadeia corrompida de propósito,
    gera o relatório e não aborta; as linhas novas ficam acima das preenchidas.
  - `movimentos.spec.ts` continua verde sem mudar nenhuma expectativa.
- **Critério de pronto:** todo movimento tem `seq_lancamento`, e a cadeia de cada linha confere no banco de teste depois das suítes
  de venda, cancelamento, vasilhame, acerto, compensação e importação. O motor online usa a função pura do shared. O deploy não
  trava os pushes de venda além da janela combinada.
- **Depende de:** nada.
- **Decisões usadas:** ADR-05 (decimal); T20; T23; trava 7300001 (SYNC 8.3); crítica (migração em etapas).

#### F2-B3 – Comando `db:recalcular-saldos` com relatório e correção
- **Tamanho:** M
- **Objetivo:** atender o critério da Definição de pronto "reconstrói `saldos_estoque` idêntico". O comando refaz a projeção pelo
  razão, em streaming e dentro da memória da VPS, e tem uma correção opcional segura com o PDV sincronizando.
- **Entregas:**
  - `apps/api/src/cli/recalcular-saldos.ts` e o script `db:recalcular-saldos`, com as opções `--empresa=<id>|--todas`, `--estoque`,
    `--produto`, `--corrigir` e `--saida=relatorio.csv`. Usa a role dona, como o `migrar-empresas`.
  - Replay por linha de saldo, com cursor ordenado por (chave, `seq_lancamento`) em páginas de 10 mil e memória constante. Recalcula
    `quantidade`, `custo_medio`, `ultima_entrada_em`, `ultima_saida_em` e `ultimo_movimento_id` com `aplicarMovimentoNoSaldo`.
  - Também confere:
    - a cadeia gravada (`saldo_anterior`/`saldo_posterior`);
    - as linhas órfãs (saldo ≠ 0 sem razão);
    - a projeção `produtos.custo_medio` (migração 0006).
  - Relatório por linha divergente: valor gravado, valor recalculado, diferença e primeiro movimento divergente.
  - `--corrigir`:
    - trabalha em blocos de até 500 linhas por transação, com `travaVersao`, a trava 7300001 e `select … for update` na ordem de
      `ordenarChaves`;
    - grava auditoria `recalcular_saldos`;
    - a versão das linhas corrigidas sobe, então o saldo certo desce ao PDV pelo fluxo `estoque`;
    - **nunca altera movimentos**.
  - O lote e a última compra entram no F2-B6, estendendo este mesmo comando.
  - Tarefa de plataforma opcional (só verifica, desligada por padrão).
  - Decisão nova no README da API: replay por `seq_lancamento`.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/cli/recalcular-saldos.ts`, `apps/api/src/estoques/recalcular.ts` (núcleo testável),
    `apps/api/package.json`, `apps/api/test/integracao/recalcular-saldos.test.ts`.
  - Sem migração. Sem espelho novo.
- **Testes:**
  - Integração: depois dos cenários das suítes `venda-eventos`, `cancelamento-vasilhame-eventos`, `estoque` e importação, o resultado
    é zero divergências.
  - Integração: corromper de propósito um saldo, um `custo_medio` e um `ultimo_movimento_id` faz o relatório apontar exatamente essas
    linhas; o `--corrigir` as conserta, a versão sobe e uma segunda execução dá zero.
  - Integração: o `--corrigir` concorrente com um push de venda na mesma linha não perde a venda.
  - Unitário: a paginação sobre uma linha com mais de 10 mil movimentos dá o mesmo resultado que sem paginação.
  - Memória: replay de 200 mil movimentos sintéticos com heap abaixo de 256 MB.
- **Critério de pronto:** `pnpm --filter api db:recalcular-saldos --empresa=<teste>` termina com "idêntico" no banco das suítes. Uma
  corrupção proposital é detectada e corrigida, e o valor corrigido aparece no pull do fluxo `estoque`. Demonstração local com a
  planilha real importada.
- **Depende de:** F2-B2.
- **Decisões usadas:** MD 3.7; ERP 13.1.1; roadmap Fase 2 › Definição de pronto.

#### F2-B4 – Compensação no motor, regra de data dos documentos do ERP e teste da DoD "Definir com PDV offline"
- **Tamanho:** M
- **Objetivo:** impedir que algum documento novo da Fase 2 fure um Definir já efetivado, e provar o cenário da Definição de pronto.
- **Entregas:**
  - **Compensação no motor.** Mover `compensarDefinir` e `definirPosteriores` de `sync/handlers/vendas.ts` para
    `apps/api/src/estoques/compensacao.ts`. Os handlers de venda, cancelamento e vasilhame passam a só importar de lá, sem mudar o
    comportamento.
  - **Regra de data.**
    - Todo documento do ERP lança com `data_movimento = now()`; a data do documento ou de entrada da nota é atributo do cabeçalho.
    - O `lancarDocumento` recusa, com um erro de programação, `data_movimento` anterior a `now() − 1 min` vinda de documento que
      não é do PDV, salvo com a flag **`retroativoPermitido`**.
    - A flag é liberada só para o Definir (que lança na `data_contagem`, `acertos.ts:321`) e para o AJUSTE_IMPORTACAO (hora da
      contagem, F2-B11). O nome evita a confusão com "compensar".
  - Atualizar a SYNC 15.3 e o ERP 13.1.5 com a regra.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/estoques/compensacao.ts` (novo), `apps/api/src/sync/handlers/{vendas,cancelamento,vasilhame}.ts`,
    `apps/api/src/estoques/movimentos.ts`, `apps/api/src/estoques/acertos.ts`, `apps/api/test/integracao/definir-offline.test.ts`,
    `docs/arquitetura/sincronizacao.md`, `docs/erp/especificacao-erp.md`.
  - Sem migração.
- **Testes:**
  - Integração no cenário da DoD: o PDV vende 3 antes da hora da contagem e 2 depois, em três ordens de chegada:
    - todas antes de efetivar;
    - as anteriores depois de efetivar;
    - as posteriores depois de efetivar.
    - Em todas, o saldo final = contagem − vendas posteriores. O estorno do Definir desfaz as compensações, e o
      `db:recalcular-saldos` dá idêntico depois de cada caso.
  - Unitário: documento do ERP com data no passado e sem a flag é recusado.
  - As suítes de venda, cancelamento e vasilhame continuam verdes depois do refactor.
- **Critério de pronto:** o teste da DoD passa nas três ordens, com o recalcular idêntico, e nenhum handler duplica a lógica de
  compensação.
- **Depende de:** F2-B3.
- **Decisões usadas:** ERP 13.1.5; SYNC 15.3; T23; crítica (nome `retroativoPermitido`).

#### F2-B5 – Estoques permitidos de verdade, com virada sem perda de acesso
- **Tamanho:** M
- **Objetivo:** fazer cada usuário só ver e movimentar os estoques permitidos (decisão 89), antes de abrir recebimento, NF-e e
  transferência, sem tirar acesso de ninguém no deploy do piloto.
- **Entregas:**
  - **Regra única**, sem a contradição das propostas:
    - Master vê tudo;
    - quem tem a permissão nova `estoques.todos` vê tudo;
    - os demais veem só os estoques que estão em `usuarios_estoques`, inclusive os sem loja (o CD).
  - `estoqueVisivel` e `filtroEstoquesVisiveis` (`estoques.controller.ts:63, 234-248`) passam a ler `usuarios_estoques`.
  - Helper `estoquesPermitidos(sessao, 'ver' | 'movimentar')`, aplicado em acertos, saldos, `GET /produtos/:id/saldos`, dashboard e
    importação ("Atualizar estoque").
  - **Virada.** Migração de dados idempotente que, para cada usuário não Master, insere em `usuarios_estoques` os estoques que ele
    vê **hoje** (os das lojas permitidas mais os estoques sem loja). Assim o acesso fica igual no dia do deploy (F2-Q4 (a)), e o
    gerente restringe depois pela tela de usuários.
  - Seed de `estoques.todos` em `permissoes.ts` e `perfis-padrao.ts` (só o Master tem por padrão).
  - Os seletores de estoque do ERP mostram só os permitidos.
  - Atualizar a decisão 89 do README da API.
- **Arquivos/migrações:**
  - Migração: `00NN_usuarios_estoques_virada.sql` (dados).
  - Arquivos: `apps/api/src/estoques/{estoques,acertos,saldos}.controller.ts`, `apps/api/src/produtos/produtos.controller.ts`,
    `apps/api/src/dashboard/dashboard.controller.ts`, `apps/api/src/importacao/importacao.ts`, `packages/shared/src/permissoes.ts`,
    `packages/shared/src/perfis-padrao.ts`, seletores do ERP.
  - Sem espelho.
- **Testes:**
  - Integração de escalada (decisão 89): usuário sem o estoque recebe 403/404 ao efetivar acerto, ler saldo e importar com
    "Atualizar estoque", tanto por id direto na URL quanto por filtro.
  - **Regressão da virada:** para cada perfil padrão, a lista de estoques visíveis antes = depois da migração.
  - Um usuário criado depois da virada sem estoques não vê nenhum.
  - Vitest dos seletores.
- **Critério de pronto:** um usuário com só a Loja 1 permitida não vê nem movimenta o CD nem a Loja 2 em nenhuma tela ou rota. No
  dia do deploy, nenhum usuário do piloto perde o acesso que tinha. O Master continua vendo tudo.
- **Depende de:** nada.
- **Decisões usadas:** README da API, decisão 89; F2-Q4; D6.

### PR-2 – Projeções do razão e tipos de estoque

#### F2-B6 – `saldos_lote` mantido pelo motor e última compra
- **Tamanho:** M
- **Objetivo:** fazer o razão manter `saldos_lote`, que já desce ao PDV mas ninguém grava, e as colunas de última compra, **antes**
  de qualquer documento que traga lote ou custo de compra. Assim o saldo por lote é reconstruível pelo razão.
- **Entregas:**
  - **Chave com lote.** `ChaveSaldo` ganha `loteId` opcional.
    - O movimento com `lote_id` faz o upsert e trava a linha de `saldos_lote` **depois** da de `saldos_estoque`, na mesma ordem
      estável (`ordenarChaves` estendido).
    - O movimento exige `produtos_lotes.estoque_id` nulo ou igual ao estoque do movimento.
  - **Saída sem lote.** Vale para a venda do PDV-1 e para acerto ou transferência sem lote, em produto com lote que tem saldo
    naquele estoque. Conforme `estoque.lote_baixa_sem_informar` (`'fefo'`, o padrão, ou `'nao_baixar'`; F2-Q7):
    - o motor **divide a saída em movimentos por lote** em ordem FEFO (validade, depois id), com `lote_id` gravado;
    - a sobra sem saldo de lote fica com `lote_id` nulo;
    - o custo é o custo médio da linha;
    - o índice de idempotência já inclui `lote_id`.
  - **Estorno e compensação.** O estorno de saída (cancelamento, estorno de acerto) volta aos mesmos lotes dos movimentos originais,
    e a compensação herda o lote do movimento compensado.
  - **Acerto com lote.**
    - `efetivarAcerto` passa a ler `itens_acerto_estoque.lote_id`.
    - Um Definir sem lote em produto com lote ajusta a diferença negativa em FEFO e a positiva sem lote.
  - **Última compra.** `atualizarSaldos` grava `ultima_compra_em` e `ultimo_custo_compra` nos tipos RECEB_MANUAL e RECEB_NFE.
  - **Recalcular.** `db:recalcular-saldos` passa a refazer `saldos_lote` e as colunas de última compra.
  - **Backfill.** Hoje não há movimento com lote nem saldo de lote, então não há nada a migrar. Se algum lote entrar antes deste
    bloco, o `--corrigir` serve de backfill.
  - **Trigger.** Impede mudar `produtos_lotes.estoque_id`, se ainda não existir (o mapa só cita `tg_saldos_lote_filtro_imutavel`).
- **Arquivos/migrações:**
  - Migração: `00NN_lotes_motor.sql` (custom: o trigger e o seed da chave).
  - Arquivos: `apps/api/src/estoques/{movimentos,acertos,recalcular}.ts`, `apps/api/src/sync/handlers/{vendas,cancelamento}.ts`
    (passam pelo motor), `packages/shared/src/{configuracoes,estoque}.ts`.
  - PDV: nenhum schema novo (`saldos_lote` e `produtos_lotes` já estão no `Esquema.g.cs`); conferir com o `EsquemaNuvemTests`.
- **Testes:**
  - Integração: venda do PDV de 10 unidades com os lotes A (vence antes, 6) e B (8) baixa 6 de A e 4 de B. Cancelar devolve aos
    mesmos lotes. O pull do fluxo `estoque` traz `saldos_lote` atualizado, e o recalcular dá idêntico nas duas projeções.
  - Integração: lote de outro estoque é recusado; um movimento RECEB_* de teste preenche a última compra.
  - Integração: acerto de saída e venda do PDV concorrentes no mesmo produto com lote não entram em deadlock (20 iterações).
  - Unitário: a divisão FEFO com saldos de lote zerados ou negativos e com sobra sem lote.
  - PDV: `AplicadorPullTests` com `produtos_lotes` filtrado pelo estoque da loja e `saldos_lote` só do tipo vendável.
- **Critério de pronto:** em todos os cenários das suítes, a soma de `saldos_lote` mais a parte sem lote = `saldos_estoque`. O
  recalcular confere as duas projeções e a última compra é preenchida.
- **Depende de:** F2-B3, F2-B4.
- **Decisões usadas:** F2-Q7; MD 3.7.4, 3.6.9; ERP 13.1.1; PDV 10.8.

#### F2-B7 – Cadastro de Tipo de Estoque (ERP 13.6) com ressincronização
- **Tamanho:** P
- **Objetivo:** separar Avaria, Vencido e Vasilhame vazio do Disponível com regras seguras para o razão e para o espelho do PDV.
- **Entregas:**
  - Zod no shared e `POST/PUT/DELETE /tipos-estoque`, num controller próprio (tirado de `saldos.controller.ts:183`), com
    `travaVersao` e auditoria.
  - **Regras:**
    - exatamente um padrão, e o padrão é sempre vendável;
    - nome único;
    - tipos com `chave_sistema` não se excluem e têm `vendavel` travado onde o código depende deles (`disponivel`,
      `vasilhame_vazio`);
    - inativar só com saldo zero em todos os estoques.
  - **Ressincronização.** Mudar `vendavel` ou o padrão enfileira `ressincronizar_fluxo 'estoque'` para os terminais ativos de todas
    as lojas (generalizando o `sync/comandos.ts:113`). A tela avisa que trocar o padrão muda para onde vão as vendas futuras.
  - **Tela.** `TiposEstoque.tsx` vira tela de edição, com a correção da chave USOS `'avariado'` → `'avaria'`.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/estoques/tipos-estoque.controller.ts`, `apps/api/src/sync/comandos.ts`, `packages/shared/src/estoque.ts`,
    `apps/erp-web/src/paginas/estoques/TiposEstoque.tsx`.
  - Sem migração de schema.
  - Espelho sem mudança (`tipos_estoque` já desce).
- **Testes:**
  - Integração: cada regra é recusada (409/422).
  - Integração: tirar "vendável" cria um comando por terminal ativo, e o pull seguinte retira as linhas do tipo.
  - Vitest da tela.
- **Critério de pronto:** o gerente cria "Quebra", não vendável. Mudar o vendável de um tipo com saldo faz os PDVs receberem a
  ressincronização. O padrão não pode ficar não vendável.
- **Depende de:** F2-B5.
- **Decisões usadas:** ERP 13.6; MD 7.4, 6.4 regra 3; SYNC 6.7; padrão "semântica do Nuvem3".

#### F2-B8 – Mudança de tipo de estoque (par MUDANCA_TIPO_ESTOQUE)
- **Tamanho:** M
- **Objetivo:** mandar saldo do Disponível para Avaria ou Vencido (e de volta) sem perder o custo, num documento único com estorno
  e idempotência. Cobre a entrega que a proposta A esqueceu.
- **Entregas:**
  - **Veículo.** Novo `tipo_ajuste 'mudanca_tipo'` no acerto, com `tipo_estoque_destino_id` no cabeçalho: altera o
    `ck_acertos_estoque_tipo_ajuste` e o trigger de imutabilidade dos itens.
  - **Efetivar.** `efetivarAcerto` gera o par MUDANCA_TIPO_ESTOQUE: −origem ao custo médio dela e +destino com esse mesmo custo,
    com o mesmo `documento_item_id`. As duas pernas não colidem no índice, porque têm tipos de estoque diferentes. O lote acompanha
    (F2-B6).
  - **Estornar.** `estornarAcerto` devolve as duas pernas.
  - **Negativo.** A perna de saída segue a regra de saldo negativo.
  - **Tela.** Opção "Mudar tipo" na tela de acertos.
  - **Registro.** TROCA_PDV e BAIXA_INTERNA são da Fase 3; anotar no fechamento.
- **Arquivos/migrações:**
  - Migração: `00NN_acerto_mudanca_tipo.sql` (check, coluna, trigger).
  - Arquivos: `apps/api/src/estoques/acertos.ts`, `packages/shared/src/estoque.ts` (`tipoMovimentoAcerto`),
    `apps/erp-web/src/paginas/estoques/Acertos.tsx`.
  - Sem espelho novo.
- **Testes:**
  - Integração: mover 5 de Disponível para Avaria preserva o custo total, e o custo médio do destino é recalculado.
  - Integração: o estorno volta tudo, e o recalcular dá idêntico.
  - Integração: o fluxo `estoque` deixa de mostrar as 5 quando Avaria não é vendável.
  - Integração: reenvio idempotente; saldo insuficiente recusado sem Master.
- **Critério de pronto:** demonstração no ERP com o PDV vendo o saldo vendável cair na hora, e o recalcular idêntico.
- **Depende de:** F2-B6, F2-B7.
- **Decisões usadas:** ERP 13.1.4, 13.6; MD 3.7.3.

### PR-3 – Inventário inicial e ajustes

#### F2-B9 – Importar contagem, folha de contagem e divisão acima de 5.000 itens
- **Tamanho:** M
- **Objetivo:** contar a loja e o CD com coletor ou planilha e carregar num acerto Definir.
- **Entregas:**
  - **`POST /acertos/:id/importar-contagem`**: multipart `.csv`/`.txt`, com `EAN;quantidade` ou `codigo_interno;quantidade` e
    separador detectado. Só em rascunho.
    - Aplica o fator do código de barras de embalagem (`produtos_codigos_barras.fator`) e soma as leituras repetidas.
    - Devolve uma prévia com os itens não encontrados, os EAN ambíguos (duplicados entre produtos), os combos, produzidos e serviços
      recusados, e o produto com variações contado no pai (recusado).
  - **Divisão automática** acima de 5.000 itens (`packages/shared/src/estoque.ts:288`) em vários rascunhos, com a mesma hora da
    contagem e aviso.
  - **Folha de contagem** impressa pelo navegador, com saldo ou cega, em ordem de localização ou de nome, filtrável por marca e
    categoria.
  - **Opção "Zerar os não contados"**, desligada por padrão: gera linhas com quantidade 0 para os produtos com saldo no estoque que
    não estão no arquivo.
  - **Lote na grade do acerto** (F2-B6).
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/estoques/acertos.controller.ts`, `apps/api/src/estoques/acertos.ts`, `packages/shared/src/estoque.ts`
    (contrato da prévia), `apps/erp-web/src/paginas/estoques/Acertos.tsx`.
  - Sem migração.
- **Testes:**
  - Vitest do parser: separadores, BOM, decimal com vírgula, fator 12 e 24.
  - Integração: EAN de fardo vira unidades × fator; EAN ambíguo não grava; acerto fora de rascunho devolve 409; 6.000 itens geram
    2 rascunhos.
  - ERP: a prévia.
- **Critério de pronto:** um arquivo de coletor com 300 linhas (com fardos) vira um rascunho de Definir em unidades, e a folha cega
  sai sem a coluna de saldo.
- **Depende de:** F2-B5, F2-B6.
- **Decisões usadas:** ERP 13.5, 13.1.5; F2-Q5.

#### F2-B10 – Compensações visíveis no acerto
- **Tamanho:** P
- **Objetivo:** mostrar o que a compensação das vendas offline fez com o Definir, ao lado do alerta de relógio suspeito.
- **Entregas:**
  - O detalhe do acerto (`acertos.ts:437-560`) traz os movimentos ACERTO_COMPENSACAO e ESTORNO_ACERTO ligados a ele: o movimento
    compensado, o terminal, a hora do fato, o documento de origem e o `relogio_confiavel`/desvio do evento.
  - Aba "Compensações" na tela, com destaque quando há RELOGIO_SUSPEITO.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/estoques/acertos.ts`, `packages/shared/src/estoque.ts`, `apps/erp-web/src/paginas/estoques/Acertos.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: o detalhe traz as compensações do cenário do F2-B4.
  - Vitest da aba.
- **Critério de pronto:** um Definir com vendas tardias mostra cada compensação, com o terminal e a hora.
- **Depende de:** F2-B4.
- **Decisões usadas:** ERP 13.1.5 item 4; SYNC 15.3.

#### F2-B11 – Hora da contagem e CD na planilha, conferência com tolerância e roteiro do inventário
- **Tamanho:** M
- **Objetivo:** a carga pela planilha honrar a hora real da contagem (também no CD), e a conferência ter um critério objetivo.
- **Entregas:**
  - **Importação com "Atualizar estoque":**
    - campo obrigatório "Data/hora da contagem", no lugar de `new Date()` (`importacao.ts:701`), lançado como AJUSTE_IMPORTACAO com
      `retroativoPermitido`;
    - aceita estoque sem loja (o CD) quando o usuário o tem permitido, em vez de `conferirLoja` (`importacao.ts:256-260`).
  - **Relatório de conferência do Definir:** contado × saldo do sistema na hora da contagem × diferença valorizada a custo, com a
    tolerância de `estoque.tolerancia_conferencia_total_pct` e `estoque.tolerancia_conferencia_item_pct` (F2-Q6). Mostra
    "Conferido" ou "Fora da tolerância".
  - **Roteiro operacional em `docs/implantacao/`:**
    - 3 lojas, CD e Treino;
    - cascos no tipo `vasilhame_vazio`;
    - kit e produzido fora;
    - mais de 5.000 itens viram vários acertos;
    - ordem: importação completa de produtos → carga do Nuvem3 → contagens por setor (F2-Q5).
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/importacao/importacao.ts`, `packages/shared/src/{importacao,configuracoes}.ts`,
    `apps/api/src/estoques/acertos.ts`, `apps/erp-web/src/paginas/importacao/Importacao.tsx`,
    `apps/erp-web/src/paginas/estoques/Acertos.tsx`, `docs/implantacao/roteiro-inventario.md`.
  - Sem migração (só o seed das chaves).
- **Testes:**
  - Integração: planilha no CD com a hora de ontem desconta as vendas posteriores (F2-B4).
  - Integração: o relatório de conferência acerta os limites.
  - Vitest da importação e do relatório.
- **Critério de pronto:** um Definir do CD feito por planilha com a hora da contagem de ontem fica certo, e o relatório de
  conferência mostra a diferença valorizada e o veredito pela tolerância.
- **Depende de:** F2-B4, F2-B5, F2-B10.
- **Decisões usadas:** F2-Q5, F2-Q6; ERP 13.1.5 item 5.

#### F2-B12 – Formulário do produto: Ajustar, categorias em árvore e relacionados
- **Tamanho:** M
- **Objetivo:** completar os blocos não fiscais que só dependem do motor existente. Ficaram separados da foto, que depende do
  upload.
- **Entregas:**
  - **Bloco Estoque.** Modal "Ajustar" (estoque permitido, tipo, nova quantidade, motivo, hora da contagem com padrão "agora"), que
    cria e efetiva um Definir de um item, com origem `cadastro_produto` (AJUSTE_CADASTRO).
    - Respeita a regra de saldo negativo e o produzido sem saldo próprio (decisão 91).
    - Exige `estoque_acertos.criar`.
  - **Categorias.** Árvore com checkboxes, estrela para a principal e "Nova categoria" em modal, no lugar do MultiSelect
    (`FormularioProduto.tsx:1430`).
  - **Produtos relacionados (8.2.8).** Com "Criar relação inversa". O zod e a gravação da filha `produtos_relacionados` em
    `gravacao.ts`, com auditoria antes/depois.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/{gravacao,produtos.controller}.ts`, `FormularioProduto.tsx`.
  - Sem migração; `produtos_relacionados` já desce ao PDV.
- **Testes:**
  - Integração: o Ajustar gera AJUSTE_CADASTRO; produzido é recusado; relação inversa; o recalcular dá idêntico.
  - Vitest dos blocos.
- **Critério de pronto:** pelo produto, o usuário ajusta o saldo da Loja 1 (que aparece no razão e no PDV), marca 2 categorias com
  a principal e liga um relacionado nas duas direções.
- **Depende de:** F2-B4, F2-B5.
- **Decisões usadas:** ERP 8.2.7, 8.2.8, 8.2.11; README da API, decisões 70, 74 e 91.

### PR-4 – Fornecedores e recebimento manual

#### F2-B13 – Fornecedores: bloco no produto, cadastro rápido e busca por CNPJ normalizado
- **Tamanho:** M
- **Objetivo:** ter o vínculo produto × fornecedor e o cadastro rápido de fornecedor, que o recebimento e a NF-e reaproveitam.
- **Entregas:**
  - **Zod e gravação de `produtos_fornecedores`** junto com o produto: fornecedor, `codigo_fornecedor`, EAN, unidade de compra,
    fator > 0 e principal. O último custo e a última compra ficam somente leitura. Auditoria antes/depois.
  - **Bloco "Fornecedores"** no formulário, visível com `geral.produto_usa_fornecedores`, com SeletorPessoa filtrado na categoria
    fornecedor.
  - **Modal "Cadastro rápido de fornecedor"** reutilizável: CNPJ/CPF, nome, IE, UF e telefone.
  - **Serviço `acharOuCriarFornecedorPorDocumento`** com `normalizarCnpj`. Se a pessoa já existe, só adiciona a categoria
    fornecedor. Conferir a unicidade do CNPJ em `pessoas`; se não houver índice, a busca normalizada faz o papel dele.
  - **Conflito** no `uq_produtos_fornecedores_codigo` (fornecedor + cProd já ligado a outro produto): 409 com o produto atual e a
    opção de mover o vínculo. Se a referência cadastrada à mão for do mesmo produto, o vínculo é reaproveitado, sem conflito.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/{gravacao,produtos.controller}.ts`,
    `apps/api/src/pessoas/fornecedores.ts` (novo), `FormularioProduto.tsx`, componente `CadastroRapidoFornecedor.tsx`.
  - Sem migração. Não desce ao PDV.
- **Testes:**
  - Vitest do zod.
  - Integração: produto com 2 fornecedores; cProd repetido em outro produto devolve 409; mesmo cProd no mesmo produto é
    reaproveitado; `acharOuCriar` com o CNPJ em máscara diferente reaproveita a pessoa.
  - ERP: o bloco fica escondido sem a configuração.
- **Critério de pronto:** o usuário liga o fornecedor X com o código "CX24-ABC" e o fator 24, e criar o mesmo fornecedor com o
  CNPJ sem máscara não duplica a pessoa.
- **Depende de:** nada.
- **Decisões usadas:** ERP 8.2.14, 13.3; MD 3.6.9; README da API, decisão 74.

#### F2-B14 – Recebimento manual: schema, contratos e rascunho
- **Tamanho:** M
- **Objetivo:** criar o documento de entrada sem nota (ou com nota em papel).
- **Entregas:**
  - **Drizzle e migração:**
    - `recebimentos`: `seq_codigo_recebimentos`, fornecedor, loja, estoque e tipo de estoque de destino, código de remessa/número do
      documento, data do documento, frete, desconto, outras despesas, situação rascunho/movimentado/estornado, motivo e dados do
      estorno, e as colunas de financeiro gravadas e sem uso;
    - `itens_recebimento`: produto, variação nula, código de barras/embalagem, fator, quantidade, custo unitário, rateios, custo
      final, lote e validade, preço de venda proposto e markup;
    - CHECKs do MD 3.8.1;
    - imutabilidade fora do rascunho no padrão de `tg_itens_acerto_estoque`, com as colunas de estorno liberadas;
    - `fn_versao` e auditoria.
  - Zod em `packages/shared/src/recebimentos.ts`.
  - **API:**
    - `GET /recebimentos` (filtros fornecedor, id, remessa, estoque, período e situação) e `GET /recebimentos/:id`;
    - `POST`, `PUT` e `DELETE` em rascunho, com estoques permitidos e as permissões `recebimentos.*`;
    - aviso de código de remessa repetido para o mesmo fornecedor.
- **Arquivos/migrações:**
  - Migração: `00NN_recebimentos.sql` (gerada + custom).
  - Arquivos: `apps/api/src/database/empresa/schema/entradas.ts` (novo), `apps/api/src/entradas/recebimentos.controller.ts`,
    `packages/shared/src/recebimentos.ts`, `versionamento.ts`.
  - Rodar o `verificar:esquema-pdv` para confirmar que o `Esquema.g.cs` não muda.
- **Testes:**
  - Integração: CRUD do rascunho; editar movimentado dá erro no trigger; estoque não permitido devolve 403.
  - Teste de migração em empresa nova e em empresa existente.
- **Critério de pronto:** um rascunho com 20 itens (com fardos) é criado, editado e excluído pela API, com auditoria e trava de
  versão.
- **Depende de:** F2-B5, F2-B13.
- **Decisões usadas:** ERP 13.3; MD 3.8.1.

#### F2-B15 – Núcleo de entrada de mercadoria: movimentar e estornar o recebimento, e origem do histórico de preços
- **Tamanho:** M
- **Objetivo:** escrever **uma vez** o núcleo que o recebimento e a NF-e compartilham, e corrigir cedo a origem do histórico de
  preços.
- **Entregas:**
  - **Núcleo `apps/api/src/entradas/entrada.ts`:**
    - rateio de frete, desconto e outras despesas proporcional ao valor, em decimal, com o resíduo no maior item (fecha com o total);
    - quantidade = quantidade × fator;
    - custo final a 4 casas;
    - lote criado em `produtos_lotes` com `estoque_id` nulo e lançado com `lote_id` (F2-B6);
    - RECEB_MANUAL via `lancarDocumento`, com `data_movimento = now()` (F2-B4), numa transação com `travaVersao`.
  - **Atualizações ao movimentar:**
    - `produtos.preco_custo` (último custo);
    - `produtos_fornecedores` (último custo, última compra e fator; cria o vínculo se não existir);
    - a última compra no saldo (F2-B6).
  - **Preço de venda.** Por item: "geral", "só da loja" ou "não", respeitando `produtos.alterar_preco`. Gravação em blocos de até
    500 linhas (SYNC 6.13).
  - **Origem do histórico de preços.** `registrarHistoricoPrecos` (`gravacao.ts:521-558`) passa a **receber a origem**: `cadastro`,
    `importacao`, `cadastro_massa`, `recebimento` ou `nota_entrada`. A importação passa `importacao`, o que corrige as cargas
    futuras do Nuvem3.
  - **`POST /recebimentos/:id/movimentar`** (idempotente).
  - **`POST /recebimentos/:id/estornar`** com motivo: ESTORNO_RECEB_MANUAL, bloqueado se deixar saldo negativo (salvo Master ou
    `estoque.permite_negativo_erp`). O estorno não desfaz o preço.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/entradas/{entrada,recebimentos.controller}.ts`, `apps/api/src/produtos/gravacao.ts`,
    `apps/api/src/importacao/importacao.ts`, `packages/shared/src/recebimentos.ts`.
  - Sem migração nova; o CHECK de origem já aceita os valores, conferir.
- **Testes:**
  - Unitário: o rateio fecha com o total em 1.000 casos aleatórios.
  - Integração: fardo com fator 12 × 10 = 120 unidades; custo médio ponderado com o saldo anterior; lote com validade gera
    `saldos_lote`.
  - Integração: o preço da loja desce no `catalogo` e grava o histórico com a origem `recebimento`; a importação grava `importacao`.
  - Integração: o custo do combo recalculado pelo trigger 0005 entra no histórico.
  - Integração: estorno depois de venda devolve 422 sem Master; movimentar duas vezes é idempotente; o recalcular dá idêntico.
- **Critério de pronto:** 10 fardos × 12 a R$ 60,00 com frete de R$ 12,00 geram +120 unidades a R$ 5,10, atualizam a última compra e
  o preço escolhido, e o recalcular não acusa divergência. O estorno desfaz o estoque.
- **Depende de:** F2-B14, F2-B6.
- **Decisões usadas:** ERP 13.3; MD 3.6.10, 3.7.3; README da API, decisões 74 e 97; padrão "estorno com negativo".

#### F2-B16 – Recebimento manual: telas e cadastro rápido de produto
- **Tamanho:** M
- **Objetivo:** pôr o recebimento na mão do estoquista.
- **Entregas:**
  - Rotas `/estoque/recebimentos` e `/estoque/recebimentos/:id`; item do menu pronto (`menu.ts:190`).
  - **Formulário com GradeItens:**
    - produto ou EAN (o EAN de embalagem com `usa_compra` preenche o fator);
    - quantidade, custo, rateio visível e custo final;
    - markup ⇄ preço em decimal, com a pergunta geral/loja/não;
    - lote e validade quando o produto tem lotes ou `solicita_lote_pdv`.
  - **Cadastro rápido de produto** em modal reutilizável: nome, EAN, unidade, NCM pelo BuscaNcm, marca, categoria e preço. Cria um
    Simples com a tributação padrão. Mais o cadastro rápido de fornecedor (F2-B13).
  - **Ações:**
    - Movimentar e Estornar (com motivo), com confirmação;
    - aviso de remessa repetida;
    - imprimir o espelho pelo navegador;
    - "Gerar financeiro" oculto.
- **Arquivos/migrações:**
  - Arquivos: `apps/erp-web/src/paginas/estoques/Recebimentos*.tsx`, `apps/erp-web/src/componentes/CadastroRapidoProduto.tsx`,
    `menu.ts`, `rotas.tsx`.
  - Sem migração.
- **Testes:**
  - Vitest: grade, markup ⇄ preço, fator pelo EAN, botões por situação e permissão.
  - E2E Playwright curto: recebimento de fardo.
- **Critério de pronto:** o estoquista lança pelo ERP a entrada de um fornecedor sem nota, com um produto novo cadastrado no próprio
  formulário, movimenta e imprime o espelho, e o saldo e o preço chegam ao PDV de teste.
- **Depende de:** F2-B15.
- **Decisões usadas:** ERP 13.3, 3.7.

#### F2-B17 – Bloco Validade/lotes no produto
- **Tamanho:** P
- **Objetivo:** mostrar e manter os lotes no cadastro, com o saldo por lote vindo do razão.
- **Entregas:**
  - **Grade de `produtos_lotes`** no formulário (ERP 8.2.12): Loja → `estoque_id`, imutável depois de gravado (trocar exige excluir
    e recriar); fabricação, validade e fornecedor; saldo por lote somente leitura, vindo de `saldos_lote`.
  - Campo `solicita_lote_pdv`.
  - **Zod e gravação da filha.** Não se exclui lote com saldo nem lote com movimento.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/gravacao.ts`, `FormularioProduto.tsx`.
  - Sem migração (o trigger de imutabilidade vem do F2-B6).
- **Testes:**
  - Integração: trocar o estoque de um lote existente devolve 422; lote com saldo não é excluído; o lote desce ao PDV com o filtro
    da loja.
  - Vitest.
- **Critério de pronto:** depois de 2 recebimentos com validades diferentes, o produto mostra o saldo de cada lote, igual ao do PDV.
- **Depende de:** F2-B6, F2-B16.
- **Decisões usadas:** ERP 8.2.12; MD 3.6.9; F2-Q7.

### PR-5 – NF-e de fornecedor por XML (sem SEFAZ, sem conversão de CFOP)

#### F2-B18 – NF-e: schema, parser seguro e validações
- **Tamanho:** M
- **Objetivo:** ler e validar o XML de fornecedor com segurança e guardar a nota com os itens e as duplicatas.
- **Entregas:**
  - **Drizzle e migração:**
    - `notas_entrada`:
      - origem só `upload`; `dfe_documento_id` nulo e sem FK;
      - `uq_notas_entrada_chave`;
      - loja, estoque e tipo de estoque de destino; fornecedor; totais; `arquivo_id`;
      - situação pendente/pronta/movimentada/estornada/ignorada.
    - `itens_nota_entrada`:
      - dados do item: cProd, cEAN, cEANTrib, xProd, NCM, CEST, **CFOP do XML**;
      - quantidades e valores: uCom, qCom, vUnCom `numeric(21,10)`, uTrib, qTrib, impostos só gravados, rastro;
      - vínculo: produto, variação e embalagem vinculados, fator, quantidade no estoque, custo calculado;
      - "ignorado" e o motivo;
      - **`cfop_entrada` nulo e reservado para a 3F/4**.
    - `notas_entrada_duplicatas` (guardadas para a Fase 4).
    - CHECKs do MD 3.8.2, imutabilidade depois de movimentada e auditoria.
  - **Parser.** `fast-xml-parser` com versão fixada, sem DTD nem resolução de entidades (contra XXE e bilhão de risadas), com limite
    de tamanho e de profundidade.
  - **Validações (sempre recusa):**
    - XML malformado;
    - sem `protNFe` autorizado (cStat 100/150);
    - modelo ≠ 55 (NFC-e recusada);
    - chave com DV inválido (`validarChaveAcesso`) ou diferente da do protocolo;
    - destinatário que não é CNPJ de alguma loja da empresa (inclusive depósito, F2-Q3);
    - chave já importada.
  - **Assinatura XMLDSig** conforme a F2-Q9 (padrão: verifica e avisa).
  - **Biblioteca de XMLs de teste** em `apps/api/test/fixtures/nfe/` (pelo menos 8, inventados): ST, FCP-ST, IPI,
    CX/FD/PCT, qTrib ≠ qCom, "SEM GTIN", rastro, e uma NFC-e para recusar. Os XMLs reais de fornecedores não entram no
    repositório (público, D60): ficam em `reais/` só na máquina de quem testa (no `.gitignore`).
- **Arquivos/migrações:**
  - Migração: `00NN_notas_entrada.sql`.
  - Arquivos: `apps/api/src/database/empresa/schema/entradas.ts`, `apps/api/src/entradas/xml/{parser,validacoes}.ts`,
    `packages/shared/src/notas-entrada.ts`, `apps/api/package.json` (`fast-xml-parser` e `xml-crypto`).
  - Não desce ao PDV.
- **Testes:**
  - Vitest do parser sobre todas as fixtures: valores exatos com 10 casas e totais conferidos contra o vNF.
  - Vitest: XML com DOCTYPE ou entidade externa recusado; zip-bomba recusada; assinatura alterada gera aviso.
  - Teste de migração.
- **Critério de pronto:** todas as fixtures são lidas com os valores exatos. NFC-e, nota sem protocolo, chave inválida e XXE são
  recusadas com o motivo.
- **Depende de:** F2-B15 (núcleo e schema `entradas`).
- **Decisões usadas:** ERP 13.4; MD 3.8.2; F2-Q3, F2-Q9; restrição do dono; crítica (sem conversão de CFOP).

#### F2-B19 – NF-e: upload, fornecedor pelo emitente, listagem e abas Dados, Duplicatas e XML
- **Tamanho:** M
- **Objetivo:** subir um ou vários XMLs ou um ZIP e ver as notas pendentes, com o fornecedor criado sozinho.
- **Entregas:**
  - **`POST /notas-entrada/importar`:**
    - multipart `.xml`/`.zip` até 20 MB, com os limites de zip-bomba da importação;
    - XML guardado em `arquivos` via `chaveXmlFiscal`;
    - resultado por arquivo: importada, duplicada ou recusada, com o motivo;
    - lote grande vai para a tarefa `importar_xml_nfe`.
  - **Fornecedor.** O emitente passa por `acharOuCriarFornecedorPorDocumento` (F2-B13), com nome, IE, UF e endereço do XML, sem
    duplicar.
  - **Consulta e ações.** `GET /notas-entrada` (filtros fornecedor, loja, período, situação, número/chave) e `GET /:id`. Ações
    "Ignorar nota" (com motivo) e "Reabrir".
  - **Aviso fixo:** "Sem consulta à SEFAZ: confira se a nota não foi cancelada pelo emitente."
  - **Telas.**
    - `/estoque/notas-entrada`: listagem com upload por arrastar.
    - Formulário em abas:
      - Dados da nota, com a troca de loja e estoque de destino entre os permitidos;
      - Duplicatas, somente leitura;
      - XML, com visualização formatada e download.
    - Item do menu pronto (`menu.ts:196`).
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/entradas/notas-entrada.controller.ts`, `apps/api/src/entradas/notas-entrada.ts`,
    `apps/api/src/tarefas/tarefas.ts` (`registrarTipo`), `apps/erp-web/src/paginas/estoques/NotasEntrada*.tsx`, `menu.ts`,
    `rotas.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: ZIP com 3 notas, 1 duplicada; fornecedor criado uma vez só, mesmo com máscara de CNPJ diferente; arquivo no MinIO de
    teste; permissão `notas_entrada.importar`; estoque não permitido recusado.
  - Vitest das telas.
- **Critério de pronto:** um ZIP com notas reais cria as notas "pendente" com o fornecedor certo, e a mesma nota subida de novo é
  recusada como já importada.
- **Depende de:** F2-B18, F2-B13, F2-B5.
- **Decisões usadas:** ERP 13.4 (aba Por Arquivo); F2-Q3.

#### F2-B20 – NF-e: vinculação de itens com fator e fornecedor aprendido
- **Tamanho:** M
- **Objetivo:** ligar cada item ao produto certo, com o fator certo, e preparar o aprendizado do vínculo.
- **Entregas:**
  - **Sugestão automática, nesta ordem:**
    1. `produtos_fornecedores` (fornecedor + cProd);
    2. cEAN ou cEANTrib no produto, no código adicional (com o fator da embalagem) ou na variação;
    3. sem sugestão.
    - A origem da sugestão fica visível: "vínculo anterior", "EAN da embalagem" ou "manual".
  - **Fator.** Sugerido pelo vínculo, pelo código de barras ou por qTrib/qCom, sempre editável e **confirmado** pelo usuário.
    Quantidade no estoque = qCom × fator. Destaque quando o fator diverge do vínculo anterior.
  - **`PUT /notas-entrada/:id/itens`:** vincular, fator, lote/validade do rastro, preço proposto e "Ignorar item" com motivo.
  - **Nota "pronta"** quando todos os itens estão vinculados (com o fator confirmado) ou ignorados. **O CFOP não entra na regra.**
  - **"Cadastrar novo produto"** pré-preenchido (nome, NCM, CEST, EAN, unidade, custo) pelo modal do F2-B16.
  - Aba "Itens e vinculação", com markup ⇄ preço como no recebimento.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/entradas/vinculacao.ts`, `packages/shared/src/notas-entrada.ts`, aba de itens em
    `apps/erp-web/src/paginas/estoques/NotasEntrada*.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: EAN de fardo sugere o fator 12; "SEM GTIN" cai no manual; sem confirmação do fator a nota não fica pronta.
  - Vitest da aba.
- **Critério de pronto:** numa nota real de bebidas, os itens com EAN são sugeridos sozinhos. O usuário vincula o resto, confirma os
  fatores e a nota fica "pronta".
- **Depende de:** F2-B19, F2-B16.
- **Decisões usadas:** ERP 13.4.1, 8.2.14.

#### F2-B21 – NF-e: movimentar e estornar (RECEB_NFE) com composição do custo e vínculo aprendido
- **Tamanho:** M
- **Objetivo:** fazer a nota entrar no estoque certo, com o custo certo, e aprender o vínculo. Fecha o primeiro item da Definição
  de pronto, sem a SEFAZ.
- **Entregas:**
  - **Movimentar, pelo núcleo do F2-B15.**
    - Custo por item = (vProd + vFrete + vSeg + vOutro − vDesc + vIPI + vICMSST + vFCPST) / (qCom × fator).
    - Cada parcela liga ou desliga por `estoque.custo_inclui_st/ipi/frete` (F2-Q8), e `custo_abate_creditos` é ignorado.
    - Cálculo em decimal.
    - RECEB_NFE com `data_movimento = now()`.
  - **Atualizações ao movimentar:**
    - grava ou atualiza `produtos_fornecedores` (fornecedor + cProd → produto, variação, fator, último custo e última compra);
    - a última compra, o preço e o histórico com a origem `nota_entrada`;
    - os lotes do rastro.
  - **Estorno ESTORNO_RECEB_NFE** com motivo, na mesma regra de negativo do recebimento.
  - Uma função pura para o custo de entrada da NF-e, no shared.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/entradas/movimentar-nfe.ts`, `apps/api/src/entradas/entrada.ts`, `packages/shared/src/estoque.ts`.
  - Sem migração.
- **Testes:**
  - Integração com fixtures: custo com ST, FCP-ST e IPI ligados e desligados; qTrib ≠ qCom com fardo de 12, comparado com um
    cálculo feito à mão.
  - Integração: movimentar é idempotente; estorno.
  - Integração: a **segunda nota do mesmo fornecedor vem 100% vinculada** pelo vínculo aprendido.
  - Integração: o recalcular dá idêntico.
- **Critério de pronto:** uma NF-e real de bebida entra no estoque certo com o fator e o custo corretos, e a nota seguinte do mesmo
  fornecedor reaproveita o vínculo.
- **Depende de:** F2-B20, F2-B15.
- **Decisões usadas:** ERP 13.4; MD 3.8.2; F2-Q8; padrão "estorno com negativo".

### PR-6 – Transferência CD ⇄ loja

#### F2-B22 – Transferência: schema e contratos
- **Tamanho:** M
- **Objetivo:** criar o documento da transferência em duas etapas, já com tipo de estoque e lote.
- **Entregas:**
  - **Drizzle e migração.**
    - `transferencias_estoque`:
      - `seq_codigo_transferencias_estoque`; origem ≠ destino;
      - `tipo_estoque_id` no cabeçalho, com padrão = o tipo padrão;
      - data, motivo de até 120 caracteres e observações;
      - status rascunho/em_transito/recebida/recebida_divergencia/cancelada;
      - datas e usuários de envio, recebimento e cancelamento;
      - `documento_fiscal_id` nulo e sem FK.
    - `itens_transferencia`:
      - produto, `variacao_id` nulo e `lote_id`;
      - quantidade enviada e quantidade recebida (entre 0 e a enviada), com `diferenca` gerada;
      - `tratamento_divergencia` (retorno/perda) e `custo_unitario`.
    - Índices origem × status e destino × status, imutabilidade fora do rascunho, `fn_versao` e auditoria.
  - **Zod em `packages/shared/src/transferencias.ts`:** rascunho, receber (por item e "receber tudo"), tratar divergência,
    cancelar, filtros, sugestão de reposição e rótulos. Quantidades com 3 casas (ADR-05).
- **Arquivos/migrações:**
  - Migração: `00NN_transferencias.sql`.
  - Arquivos: `apps/api/src/database/empresa/schema/estoque.ts`, `packages/shared/src/transferencias.ts`, `versionamento.ts`.
  - Não desce ao PDV (os saldos descem pelo fluxo `estoque`).
- **Testes:**
  - Teste de migração.
  - Vitest dos contratos.
  - Integração dos CHECKs: origem = destino e recebida > enviada são recusadas.
- **Critério de pronto:** a migração roda em empresa nova e existente, e os contratos validam os casos-limite.
- **Depende de:** F2-B6, F2-B7.
- **Decisões usadas:** MD 3.7.6; ERP 13.7, 13.6; padrão "tipo de estoque no cabeçalho".

#### F2-B23 – Transferência: rascunho, enviar e cancelar
- **Tamanho:** M
- **Objetivo:** o CD monta e despacha, com a saída ao custo médio da origem.
- **Entregas:**
  - **Rascunho.** `GET`, `POST`, `PUT` e `DELETE /transferencias`. Quem cria e envia precisa ter a origem permitida; o destino não
    precisa estar permitido.
  - **`POST :id/enviar`:**
    - confere o saldo da origem (SYNC 15.1: o ERP não deixa negativo, salvo Master ou `estoque.permite_negativo_erp`);
    - gera TRANSF_SAIDA ao custo médio vigente, com lote quando informado e FEFO quando não (F2-B6);
    - grava o custo no item e passa a `em_transito`;
    - tudo numa transação, com `travaVersao` e trava ordenada.
  - **`POST :id/cancelar`** com motivo:
    - rascunho: sem efeito;
    - em trânsito: TRANSF_RETORNO integral, com `estorno_de_id` = a saída, ao custo original (T20);
    - recebida não se cancela: faz-se uma transferência inversa.
  - Bloquear inativar ou excluir estoque com transferência em trânsito.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/transferencias/` (novo módulo), `apps/api/src/estoques/estoques.controller.ts`.
  - Sem migração.
- **Testes:**
  - Integração: enviar sem saldo devolve 422; o custo do item = o custo médio da origem; cancelar em trânsito devolve saldo e custo.
  - Integração: envio concorrente com venda do PDV na origem sem deadlock (20 iterações); enviar duas vezes é idempotente; o
    recalcular dá idêntico.
- **Critério de pronto:** enviar 5 fardos do CD para a Loja 2 tira 60 unidades do CD ao custo médio, e cancelar devolve exatamente o
  que saiu.
- **Depende de:** F2-B22, F2-B5.
- **Decisões usadas:** ERP 13.7, 13.1.4; SYNC 15.1; T20.

#### F2-B24 – Transferência: receber, tratar divergência e modo de uma etapa
- **Tamanho:** M
- **Objetivo:** a loja confere e recebe, e a diferença é tratada sem distorcer os saldos. Fecha o segundo item da Definição de pronto.
- **Entregas:**
  - **`POST :id/receber`:** quantidade conferida por item ou "receber tudo como enviado"; TRANSF_ENTRADA no destino com o custo da
    saída; status `recebida` ou `recebida_divergencia`. Quem recebe precisa ter o destino permitido.
  - **`POST :id/tratar-divergencia`**, por item:
    - "Retornar à origem": TRANSF_RETORNO da diferença;
    - "Baixar como perda" (F2-Q10 (b)): TRANSF_RETORNO da diferença mais um acerto de saída na origem com origem
      `perda_transferencia` e `origem_id` = a transferência. O efeito no saldo da origem é líquido zero, e a perda fica registrada a
      custo.
  - **Modo de uma etapa** com `estoque.transferencia_recebimento_automatico`: enviar já recebe tudo na mesma transação.
  - Auditoria em cada etapa.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/transferencias/`, `apps/api/src/estoques/acertos.ts`,
    `apps/api/test/integracao/transferencias.test.ts`.
  - Sem migração.
- **Testes:**
  - Integração do critério da DoD: CD → Loja 2 com 10 enviados e 8 recebidos, tratado como retorno e como perda; saldos e
    movimentos certos nos dois estoques; custo médio no destino; o fluxo `estoque` desce os saldos novos para o PDV das duas lojas;
    o recalcular dá idêntico.
  - Integração: o retorno parcial impede o cancelamento (um só estorno por movimento).
  - Integração: um casco vazio (`vasilhame_vazio`) volta da loja para o CD.
- **Critério de pronto:** a transferência CD → Loja 2 com divergência termina com saldos e movimentos corretos nos dois estoques, e
  o PDV da Loja 2 recebe o saldo novo.
- **Depende de:** F2-B23.
- **Decisões usadas:** ERP 13.7 (Divergência); F2-Q10.

#### F2-B25 – Transferência: sugestão de reposição
- **Tamanho:** P
- **Objetivo:** o CD monta a carga da loja com um clique.
- **Entregas:**
  - **`GET /transferencias/sugestao-reposicao?origem&destino`:**
    - entram os produtos do destino abaixo do mínimo (`produtos_lojas` da loja do estoque de destino);
    - quantidade = máximo − (saldo + em trânsito para o destino), ou mínimo × 2 − (saldo + em trânsito) sem máximo;
    - arredondada à embalagem de compra ativa de maior fator (F2-Q11) e limitada ao saldo da origem;
    - ficam fora: combo, serviço e produzido.
  - Destino sem loja: sugestão vazia, com aviso.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/transferencias/reposicao.ts`, `packages/shared/src/configuracoes.ts`.
  - Sem migração.
- **Testes:**
  - Vitest da fórmula: com e sem máximo, com em trânsito, com arredondamento.
  - Integração com `produtos_lojas`.
- **Critério de pronto:** com mínimo 24, máximo 72, saldo 10 e 12 em trânsito, a sugestão é 50 (60 arredondada ao fardo de 12),
  nunca acima do saldo do CD.
- **Depende de:** F2-B23.
- **Decisões usadas:** ERP 13.7; F2-Q11.

#### F2-B26 – "Em trânsito", divergência a tratar e alerta de transferência parada
- **Tamanho:** P
- **Objetivo:** mostrar o que saiu e não chegou, para ninguém comprar nem transferir em dobro.
- **Entregas:**
  - **Coluna "Em trânsito"** em `GET /produtos/:id/saldos` (`produtos.controller.ts:350`) e em `GET /saldos-estoque`: enviado e
    ainda não recebido das transferências `em_transito` para o estoque.
  - **"Divergência a tratar"** como pendência separada; não conta como em trânsito.
  - **Alerta** em `alertas` para transferência em trânsito ou divergência sem tratamento há mais de
    `estoque.transferencia_alerta_dias` (padrão 3).
  - Bloco Estoque do produto e tela Saldos com as colunas novas.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/produtos/produtos.controller.ts`, `apps/api/src/estoques/saldos.controller.ts`,
    `apps/api/src/transferencias/alertas.ts`, `FormularioProduto.tsx`, `Saldos.tsx`, `packages/shared/src/configuracoes.ts`.
  - Sem migração (só o seed da chave).
- **Testes:**
  - Integração dos números com uma transferência em trânsito e outra com divergência; o alerta é gerado depois do prazo.
  - Vitest.
- **Critério de pronto:** com 60 unidades em trânsito para a Loja 2, o produto mostra "Em trânsito: 60" até o recebimento, e uma
  transferência parada há 4 dias gera o alerta.
- **Depende de:** F2-B24.
- **Decisões usadas:** ERP 8.2.11, 13.7; README da API, decisão 70; padrão "divergência separada".

#### F2-B27 – Transferência: telas e romaneio
- **Tamanho:** M
- **Objetivo:** o CD e as lojas operam a transferência pelo ERP.
- **Entregas:**
  - **Rotas.**
    - `/estoque/transferencias`: filtros origem, destino, situação e período; colunas Nº, criação, envio, recebimento, quantidade de
      itens e situação.
    - `/estoque/transferencias/:id`.
    - Item do menu pronto (`menu.ts:208`).
  - **Grade (GradeItens):** produto, lote, saldo na origem, enviada, recebida e diferença. A coluna de variação só aparece se o
    PR-12 entrar.
  - **Seletor de destino** do rascunho: `GET /transferencias/destinos` (F2-B23; README da API › decisão 171), todo estoque ativo
    da empresa, também fora dos permitidos de quem cria (não o `GET /estoques`, que só mostra os visíveis); esconder a origem.
  - **Botões por situação e permissão:** Sugerir reposição, Enviar, Receber (com "Receber tudo como enviado"), Tratar diferença e
    Cancelar.
  - **Romaneio** pela impressão do navegador: cabeçalho da empresa, origem, destino, itens com a embalagem e campo de assinatura.
- **Arquivos/migrações:**
  - Arquivos: `apps/erp-web/src/paginas/estoques/Transferencias*.tsx`, `menu.ts`, `rotas.tsx`.
  - Sem migração.
- **Testes:**
  - Vitest das transições.
  - E2E Playwright: CD → loja com divergência.
- **Critério de pronto:** o CD envia pelo ERP e imprime o romaneio; a loja recebe com diferença e trata, sem tocar na API.
- **Depende de:** F2-B24, F2-B25, F2-B26.
- **Decisões usadas:** ERP 13.7, 3.7; padrão "impressão pelo navegador".

### PR-7 – Relatórios de estoque

#### F2-B28 – Desempenho do razão: massa de carga, planos de consulta e índices
- **Tamanho:** M
- **Objetivo:** medir as consultas pesadas antes de escrever os relatórios (são de 3 a 4 milhões de movimentos por ano, sem
  particionamento) e criar os índices que faltarem.
- **Entregas:**
  - **Script de massa `apps/api/test/carga/massa-razao.ts`**, rodado por `pnpm --filter api carga:razao`, fora do CI normal:
    - 3 lojas, CD e Treino, 2.000 produtos e 12 meses;
    - mistura real: venda ≈ 90%, entradas, acertos, compensações, transferências;
    - gerado pelo motor em lotes ou por COPY seguido do `--corrigir`.
  - **Roteiro de `EXPLAIN (ANALYZE, BUFFERS)`** para:
    - a movimentação por loja e período, com cursor;
    - a visão sintética;
    - o saldo numa data-base;
    - a última compra;
    - o replay do recalcular;
    - o detalhe do acerto.
  - **Migração de índices conforme a medição.** Candidatos:
    - `(estoque_id, data_movimento, id)`;
    - um parcial `(estoque_id, produto_id, data_movimento desc) where tipo_movimento in ('RECEB_MANUAL','RECEB_NFE')`.
    - `CREATE INDEX CONCURRENTLY`, fora da transação.
  - **README da API:** decisão "sem particionamento na Fase 2", com os números medidos e o gatilho para particionar.
- **Arquivos/migrações:**
  - Migração: `00NN_indices_razao.sql` (custom).
  - Arquivos: `apps/api/test/carga/massa-razao.ts`, `apps/api/package.json`, README da API.
- **Testes:**
  - Carga reproduzível, com os tempos guardados no README.
  - Integração: confere se os índices existem.
- **Critério de pronto:** com 4 milhões de movimentos:
  - a página de 12 meses de uma loja abre em menos de 1 s no banco;
  - o saldo numa data-base de "todas as lojas" sai em menos de 3 s;
  - o recalcular da empresa inteira fica abaixo de 512 MB de heap.
- **Depende de:** F2-B3, F2-B24.
- **Decisões usadas:** implantação de 03/11/2026 (2 GB); MD 3.7.2.

#### F2-B29 – Exportação de relatório em tarefa, em streaming
- **Tamanho:** M
- **Objetivo:** exportar relatórios grandes sem estourar os 2 GB do container.
- **Entregas:**
  - **Tipo `exportar_relatorio`** em TarefasSegundoPlano:
    - lê por cursor;
    - escreve o `.xlsx` em streaming (exceljs `WorkbookWriter`, versão fixada; o `write-excel-file` continua no síncrono) ou `.csv`;
    - envia ao armazenamento em multipart e grava em `arquivos` (categoria `planilha_exportacao`);
    - link assinado de 7 dias e auditoria `exportar`.
  - **Regra comum:** até `LIMITE_EXPORTACAO` baixa na hora; acima disso vira tarefa. Concorrência limitada como o semáforo de
    planilha (decisão 93).
  - Proteção contra fórmula e o nome `Relatorio_..._DD_MM_AAAA_HH_MM` reaproveitados de `comum/exportacao.ts`.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/comum/exportacao.ts`, `apps/api/src/tarefas/tarefas.ts`, `apps/api/package.json`.
  - Sem migração.
- **Testes:**
  - Integração com a massa do F2-B28: exportar 1 milhão de linhas com **heap abaixo de 300 MB**, medido no teste; o arquivo abre e
    tem o total de linhas.
  - Integração: permissão `relatorios.exportar`; custo omitido sem `produtos.ver_custo`.
- **Critério de pronto:** a exportação de 1 milhão de linhas termina como tarefa, com link, e o pico de heap medido fica abaixo de
  300 MB.
- **Depende de:** F2-B28.
- **Decisões usadas:** ERP 3.5, 3.6; MD 3.1.6, 3.1.8; decisão 93; crítica (teto numérico).

#### F2-B30 – `<Relatorio>` paginado no servidor e ícone Tarefas no cabeçalho
- **Tamanho:** M
- **Objetivo:** preparar a casca dos relatórios para volume grande e dar um lugar único para os downloads.
- **Entregas:**
  - **`<Relatorio>` com:**
    - página e tamanho na URL, com o total vindo da API (ou cursor de "próxima página");
    - seleção de linhas opcional;
    - exportação assíncrona: quando a API devolve uma tarefa, mostra o aviso e o andamento.
  - **Ícone "Tarefas"** com contador no `Layout.tsx`, com a lista de `GET /tarefas`, o andamento e o download. A Importação passa a
    usar o mesmo componente.
- **Arquivos/migrações:**
  - Arquivos: `apps/erp-web/src/componentes/relatorio/Relatorio.tsx`, `apps/erp-web/src/layout/Layout.tsx`,
    `apps/erp-web/src/componentes/tarefas/`.
  - Sem migração.
- **Testes:** Vitest da paginação pela URL, da seleção, da exportação que vira tarefa e do painel de tarefas.
- **Critério de pronto:** um relatório de teste com 100 mil linhas pagina no servidor, e a exportação aparece no ícone Tarefas com o
  link quando termina.
- **Depende de:** F2-B29.
- **Decisões usadas:** ERP 3.5, 3.6.

#### F2-B31 – Relatório Estoque Atual (16.4) com modal de ajuste
- **Tamanho:** M
- **Objetivo:** dar ao gerente a visão diária do estoque com custo e o ajuste rápido no clique.
- **Entregas:**
  - **`GET /relatorios/estoque-atual`**, que estende o `/saldos-estoque` com:
    - marca e departamento (árvore com os filhos);
    - "Todas", somando os estoques permitidos;
    - colunas Atacado, iFood, Em trânsito e Divergência a tratar;
    - filtro "Vencendo em N dias" (por `saldos_lote`);
    - data-base "Saldo em <data>", pela soma do razão até a data.
    - O custo só aparece com `produtos.ver_custo`. Exclui a loja Treino por padrão (D39).
  - **Modal de ajuste no clique do saldo:** tipo de estoque, nova quantidade, motivo e hora da contagem com padrão "agora". Cria e
    efetiva um Definir de um item, com origem `relatorio_estoque` (AJUSTE_RELATORIO), com a regra de negativo e a compensação.
    Exige `estoque_acertos.criar`.
  - Tela no `<Relatorio>` com a exportação; item do menu pronto.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/estoque-atual.ts`, `apps/erp-web/src/paginas/relatorios/EstoqueAtual.tsx`, `menu.ts`,
    `rotas.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: a data-base no passado bate com o saldo da época; "Todas" respeita os estoques permitidos; o modal gera o acerto; a
    venda offline anterior à hora do ajuste é compensada.
  - Carga: menos de 3 s com a massa.
  - Vitest.
- **Critério de pronto:** o gerente filtra uma cervejaria, vê o saldo de ontem e corrige um item pelo clique; o acerto aparece na
  lista e o saldo chega ao PDV.
- **Depende de:** F2-B30, F2-B26, F2-B7.
- **Decisões usadas:** ERP 16.4, 13.6, 13.1.5; D39.

#### F2-B32 – Movimentação de Estoque (16.5): visão analítica
- **Tamanho:** M
- **Objetivo:** rastrear cada entrada e saída de um local, no formato do Nuvem3, rápido com 12 meses.
- **Entregas:**
  - **`GET /relatorios/movimentacao-estoque`:**
    - local e período (até 366 dias) obrigatórios;
    - filtros de produto, tipos (multisseleção), usuário, documento e pessoa;
    - paginação por cursor (`data_movimento`, `id`).
  - **Saldo anterior e posterior** recalculados por janela, na ordem de `data_movimento`, com a nota de que podem diferir do valor
    gravado por causa das vendas offline tardias.
  - **Colunas** compatíveis com o export do Nuvem3, mais custo unitário, custo total, documento com link, fornecedor e
    `id_nuvem3`. O custo só aparece com `produtos.ver_custo`.
  - Tela no `<Relatorio>`.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/movimentacao.ts`, `apps/erp-web/src/paginas/relatorios/MovimentacaoEstoque.tsx`.
  - Sem migração (usa os índices do F2-B28).
- **Testes:**
  - Integração: o saldo da janela fecha com `saldos_estoque`; filtros.
  - Carga: 12 meses de uma loja com a primeira página em menos de 5 s, com o EXPLAIN registrado.
- **Critério de pronto:** a movimentação de 12 meses de uma loja abre em menos de 5 s, paginada, com a massa.
- **Depende de:** F2-B30, F2-B28.
- **Decisões usadas:** ERP 16.5; MD 3.7.1-3.7.3; roadmap, Definição de pronto.

#### F2-B33 – Movimentação: visão sintética, exportação em tarefa e "Ver movimentação"
- **Tamanho:** M
- **Objetivo:** fechar o 16.5 com o resumo por produto e a exportação de 12 meses.
- **Entregas:**
  - **Visão sintética:** saldo inicial, entradas, saídas, saldo final, custos, data da última compra e último custo (último
    RECEB_MANUAL ou RECEB_NFE até o fim do período).
  - **Exportação** `Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM.xlsx`, das duas visões, pela tarefa do F2-B29.
  - **Link "Ver movimentação"** no bloco Estoque do produto e no Estoque Atual. Inclui a tela de Movimentação no menu como pronta.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/movimentacao.ts`, telas do relatório e do produto, `menu.ts`.
  - Sem migração.
- **Testes:**
  - Integração: a sintética fecha com a analítica; a última compra vem de RECEB_NFE; a exportação de 12 meses termina como tarefa.
  - Vitest.
- **Critério de pronto:** a movimentação de 12 meses de uma loja exporta em tarefa, e a sintética mostra a última compra das notas
  importadas.
- **Depende de:** F2-B32, F2-B29, F2-B21.
- **Decisões usadas:** ERP 16.5, 8.2.11.

### PR-8 – PDV: guarda e consulta (release R1 do PDV)

#### F2-B34 – Guarda de produto com variações no PDV
- **Tamanho:** P
- **Objetivo:** fechar o furo do caixa antes que exista qualquer variação gerada. Hoje o EAN da variação vende o pai com o preço e o
  saldo do pai.
- **Entregas:**
  - **PDV.** A resolução por código ou por pesquisa (`CatalogoLocal.cs:28-44`) recusa, com "Produto com variações: venda disponível
    na próxima versão":
    - o código que resolve para uma variação (`produtos_codigos_barras.variacao_id` não nulo);
    - o produto pai `com_variacoes` que tenha variação ativa no espelho.
    - O pai sem variação continua vendendo.
    - Comportamento por `pdv.recusa_produto_com_variacoes` (padrão `true`; com `false`, vende o pai como hoje). Conferir que a chave
      desce no fluxo `configuracao`.
  - **`com_complementos` NÃO é recusado**: continua vendendo sem complementos (PDV 10.2).
  - **Nuvem.** A venda recebida de produto com variações sem variação é aceita (SYNC 15.1) e abre `alerta.cadastro`.
  - **ERP.** Ligar `produtos.variacoes_habilitadas` avisa se houver terminal ativo com versão do PDV anterior à R1.
- **Arquivos/migrações:**
  - Arquivos: `apps/pdv/src/GenesisPDV.Data/Repositorios/CatalogoLocal.cs`, ViewModel de venda, `apps/api/src/sync/handlers/vendas.ts`
    (alerta), `packages/shared/src/configuracoes.ts`, tela de configurações do ERP.
  - Sem migração; sem mudança no `Esquema.g.cs`.
- **Testes:**
  - `GenesisPDV.Data.Tests`/`Core.Tests`: EAN de variação e pai com variação ativa recusados com a chave ligada e vendidos como pai
    com ela desligada; pai sem variação e `com_complementos` vendem.
  - TelasTests da mensagem.
  - Integração da API: o alerta é aberto.
- **Critério de pronto:** num PDV real, ler o EAN de uma variação mostra a recusa, e um produto com complementos continua vendendo.
- **Depende de:** F2-B1.
- **Decisões usadas:** F2-Q2; PDV 10.2; MD 6.1; crítica (só `com_variacoes`).

#### F2-B35 – PDV: F4 "Outras lojas" (saldo online das lojas e do CD)
- **Tamanho:** M
- **Objetivo:** o operador diz ao cliente onde tem o produto, sem ligar para outra loja.
- **Entregas:**
  - **`GET /sync/consultas/saldos-outras-lojas?produto_id=`**, dentro de `/sync/*` para reaproveitar a autenticação do terminal e a
    exclusão do prefixo, com `exigirHardware`:
    - só quantidades, sem custo;
    - escopo da F2-Q12: sem a Treino, só o tipo vendável, com o CD;
    - desligável por `pdv.consulta_outras_lojas`;
    - limite de taxa por terminal.
  - Contrato zod em `packages/shared/src/sync` e espelho C# em `Protocolo/Contratos.cs`.
  - Método no `ClienteSync`, com tempo limite de 3 s e cancelamento.
  - **Tecla F4** no `DialogoPesquisaViewModel` (`Dialogos.cs:216`; `VendaView.axaml:271-295`), que abre o diálogo de saldos por loja.
    Offline, ou 404 de API antiga: "Consulta indisponível (requer conexão)". A venda nunca trava.
  - **Registro no README do PDV e na SYNC:** endpoint online fora do T13; a Fase 2 mantém `venda.finalizada` v1 e não anuncia
    nenhum tipo novo em `versoes_schema`.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/sync/sync.controller.ts`, `apps/api/src/sync/terminal.ts:22`, `packages/shared/src/sync/`,
    `apps/pdv/src/GenesisPDV.Sync/` (Contratos, ClienteSync), `apps/pdv/src/GenesisPDV.App/ViewModels/Dialogos.cs`,
    `Views/VendaView.axaml`.
  - Sem migração. Publicar a API antes do PDV.
- **Testes:**
  - Integração da API: escopo sem custo; token de outra empresa ou terminal revogado recusado; limite de taxa.
  - Sync.Tests: tempo limite, 404 e offline.
  - TelasTests do F4 online e offline.
- **Critério de pronto:** no caixa da Loja 1, F2 → produto → F4 mostra as quantidades da Loja 2, da Loja 3 e do CD em menos de 1 s.
  Com o cabo desconectado, aparece "requer conexão" e a venda continua.
- **Depende de:** F2-B5, F2-B7.
- **Decisões usadas:** F2-Q12; PDV 10.3; SYNC 1.4, 17.5, 20.2; D39.

#### F2-B36 – PDV: pesquisa F2 completa com FTS5 (opcional)
- **Tamanho:** P
- **Objetivo:** pesquisa rápida com o catálogo completo e as informações que o operador precisa.
- **Entregas:**
  - **Tabela virtual FTS5 `produtos_busca`** no SQLite local (MD 4.2), mantida pelo aplicador do pull. É criada e populada por
    migração EF, sem voltar o cursor (os dados já estão no espelho), e não entra no `Esquema.g.cs`.
  - **Colunas novas:** Marca, Localização, atacado, promocional e estoque estimado quando `pdv.exibe_estoque_busca`.
- **Arquivos/migrações:**
  - Arquivos: `apps/pdv/src/GenesisPDV.Data/Repositorios/CatalogoLocal.cs:58-77`, migração EF nova, `VendaView.axaml`.
  - Sem migração na nuvem.
- **Testes:**
  - `Data.Tests` com 50.000 produtos: busca em menos de 300 ms.
  - Teste da migração EF.
  - TelasTests.
- **Critério de pronto:** com 50.000 produtos no espelho, "heineken 600" retorna em menos de 300 ms, com marca e estoque.
- **Depende de:** nada; sai na R1 junto do F2-B34.
- **Decisões usadas:** PDV 10.3; MD 4.2.

### PR-9 – Catálogo operacional

#### F2-B37 – Histórico de preços: consulta e aba no produto
- **Tamanho:** P
- **Objetivo:** ver quando e por que o preço e o custo mudaram, por loja.
- **Entregas:**
  - **`GET /produtos/:id/historico-precos`** (filtros tipo, loja, período). Sem os tipos de custo para quem não tem
    `produtos.ver_custo` e só das lojas permitidas, porque o histórico não é redigido na leitura (decisão 100).
  - `registrarHistoricoPrecos` grava também o tipo `quantidade` (faixas) e a `variacao_id`. A origem já foi corrigida no F2-B15.
  - Aba/modal "Histórico de preços" no formulário.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/produtos/{produtos.controller,gravacao}.ts`, `FormularioProduto.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: sem `ver_custo` não aparece custo; loja não permitida fica fora; as origens `recebimento`, `nota_entrada` e
    `importacao` aparecem.
  - Vitest.
- **Critério de pronto:** o gerente vê que o preço passou de 9,90 para 10,90 pela NF-e e que o custo mudou pela importação.
- **Depende de:** F2-B15.
- **Decisões usadas:** MD 3.6.10; README da API, decisões 97 e 100.

#### F2-B38 – Relatório de EAN duplicado
- **Tamanho:** P
- **Objetivo:** limpar os EAN repetidos herdados do Nuvem3, para poder voltar `geral.ean_duplicado` a "bloquear".
- **Entregas:**
  - **`GET /relatorios/ean-duplicado`**, agrupado por código (`group by codigo having count(distinct produto_id) > 1`, sobre o
    `ix_produtos_codigos_barras_codigo`), com os produtos de cada código e o link para editar.
  - Tela no `<Relatorio>` com exportação, e atalho a partir do filtro "EAN duplicado" da listagem.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/ean-duplicado.ts`, `apps/erp-web/src/paginas/relatorios/EanDuplicado.tsx`.
  - Sem migração.
- **Testes:** integração com 3 produtos e 2 códigos repetidos; o EXPLAIN usa o índice.
- **Critério de pronto:** o relatório lista cada EAN repetido com os produtos dele, e corrigir um produto tira o par do relatório.
- **Depende de:** F2-B30.
- **Decisões usadas:** MD 3.6.5; ERP 8.2 Regras, 20 item 2; padrão "volta a bloquear".

#### F2-B39 – Cadastro em massa por estoque (8.3)
- **Tamanho:** M
- **Objetivo:** cadastrar e dar entrada em muitos produtos novos de uma vez, como no Nuvem3.
- **Entregas:**
  - **Tela `/produtos/cadastro-em-massa` sobre GradeItens:**
    - seletor de estoque (só os permitidos);
    - EAN que vira "Atualização" (em azul) quando o produto já existe;
    - marca com criação inline e categoria em árvore;
    - custo, markup e preço;
    - estoque a somar e estoque mínimo da loja do estoque;
    - botão Limpar;
    - "Pesquisar EAN" na base da empresa.
  - **`POST /produtos/cadastro-em-massa`**, transacional, até 500 linhas, com `lock_timeout` e mensagem amigável:
    - cria Simples com a tributação padrão pelas regras de `inserirProduto`/`atualizarProduto`;
    - aplica a mesma unicidade de EAN do formulário (bloquear/avisar), não a da importação;
    - gera um acerto Entrada de origem `cadastro_massa` (AJUSTE_CADASTRO, `data_movimento = now()`);
    - grava `produtos_lojas` e o histórico com a origem `cadastro_massa`;
    - o resultado traz links.
  - Permissões `produtos.cadastro_massa` e `estoque_acertos.criar`; item do menu pronto (`menu.ts:69`).
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/produtos/cadastro-massa.ts`, `packages/shared/src/produtos.ts`,
    `apps/erp-web/src/paginas/produtos/CadastroEmMassa.tsx`, `menu.ts`, `rotas.tsx`.
  - Sem migração.
- **Testes:**
  - Integração: 500 linhas tudo ou nada; EAN duplicado com "bloquear" não grava nada; concorrência com o push do PDV; o recalcular
    dá idêntico.
  - Vitest da grade.
- **Critério de pronto:** 30 produtos novos com estoque no CD geram os produtos, um acerto de entrada e o histórico numa só
  confirmação.
- **Depende de:** F2-B15, F2-B5.
- **Decisões usadas:** ERP 8.3; F2-Q13.

#### F2-B40 – Exportação de produtos de ida e volta e o restante da importação
- **Tamanho:** M
- **Objetivo:** exportar o catálogo, editar na planilha e reimportar sem surpresa.
- **Entregas:**
  - **Tela `/produtos/exportacao` e API** com o layout que casa com os aliases de `COLUNAS_IMPORTACAO_PRODUTOS`:
    - colunas: id, código, código interno, EAN, nome, tipo, unidade, ativo, marca, caminho da categoria e todos os preços;
    - da loja escolhida: `preco_loja`, `estoque_minimo` e `estoque_atual`;
    - colunas NF opcionais (só os valores gravados), localização, peso e descrição curta.
    - Filtros "Com NCM inválido", "Estoque zerado ou negativo" e "Somente ativos".
    - Acima de 5.000 linhas, vai para a tarefa do F2-B29.
    - O custo só sai com `produtos.ver_custo`, e só das lojas permitidas.
  - **"Exportar Clientes"** no mesmo mecanismo.
  - **Importação:** o mapeamento de `UsaBalancaEtiquetadoraStr` e do grupo de itens fica isolado num ponto só (F2-Q14, padrão
    provisório); o andamento aparece no ícone Tarefas.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/produtos/exportacao.ts`, `apps/api/src/importacao/produtos.ts`, `packages/shared/src/importacao.ts`,
    `apps/erp-web/src/paginas/produtos/Exportacao.tsx`.
  - Sem migração.
- **Testes:**
  - **Ida e volta:** exportar → reimportar = 100% sem alteração, com a massa e com a planilha real.
  - Integração do filtro e da permissão de custo.
- **Critério de pronto:** a exportação completa da Ice Beer, reimportada, dá 100% "Sem alteração".
- **Depende de:** F2-B29, F2-B30, F2-B15.
- **Decisões usadas:** ERP 8.5, 8.6; README da API, decisões 88, 95 e 104; F2-Q14.

#### F2-B41 – Relatórios Produtos geral (16.1) e NCMs inválidos (16.3), com a carga do CEST
- **Tamanho:** M
- **Objetivo:** ver as margens do catálogo e limpar os NCM antes da fase fiscal.
- **Entregas:**
  - **16.1 Produtos geral.**
    - Filtros: nome, marca, departamento em árvore, sem preço, loja (usa o preço da loja) e situação.
    - Colunas: custo, venda, atacado, lucro em R$, lucro %, markup % e departamentos. WooComm fica escondida.
    - Totais e médias em decimal. Custo e lucro só com `produtos.ver_custo`.
  - **Carga da tabela `cests`** a partir de um arquivo versionado no repositório (`apps/api/src/database/referencias/cests.csv`,
    com a lista de NCMs de cada CEST), pelo `carregar.ts`. A atualização periódica fica no F2-B46.
  - **16.3 NCMs inválidos.**
    - Motivos: vazio, inexistente, fora de vigência (`ncmVigente`) e **CEST incompatível, que só aparece quando `cests` tiver
      carga**.
    - Exclui serviço e combo.
    - Ação Editar e ação em lote "Definir NCM" (BuscaNcm), que passa por `atualizarProduto` (versão, auditoria e descida ao PDV).
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/{produtos-geral,ncm-invalidos}.ts`, `apps/api/src/database/referencias/{cests.csv,carregar.ts}`,
    telas, `menu.ts`, `rotas.tsx`.
  - Sem migração de schema (a tabela `cests` existe).
- **Testes:**
  - Integração: médias em decimal; "Definir NCM" em lote com a versão e a auditoria por produto; o motivo CEST some com a tabela
    vazia e aparece com a carga.
  - Vitest.
- **Critério de pronto:** o gerente vê a margem por departamento e corrige o NCM de 50 produtos de uma vez, cada um com a própria
  auditoria, sem falso positivo de CEST.
- **Depende de:** F2-B30 (com a seleção de linhas).
- **Decisões usadas:** ERP 16.1, 16.3; README da API, decisões 41 e 98; crítica (CEST).

#### F2-B42 – Relatório Histórico de produtos (16.2)
- **Tamanho:** M
- **Objetivo:** saber quem mudou o quê no cadastro, em texto legível.
- **Entregas:**
  - **`GET /relatorios/historico-produtos`** sobre a auditoria, só das entidades de produto e das filhas, com **período obrigatório**
    (a tabela é particionada por mês). Filtros: texto, usuário, tipo e produto.
  - **Formatador de diferença** com rótulos de campo ("Preço de venda: 9,90 → 10,90"), incluindo as filhas.
    - A edição de produto passa a gravar a `descricao` legível, para o filtro de texto funcionar.
    - Legenda G/E/R/I e localização mapeada.
  - Ação "ver diferença completa".
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/relatorios/historico-produtos.ts`, `apps/api/src/auditoria/`, `apps/api/src/produtos/produtos.controller.ts`.
  - Sem migração.
- **Testes:**
  - Vitest do formatador: filhas adicionadas, removidas e alteradas; campos desconhecidos.
  - Integração com o período obrigatório.
- **Critério de pronto:** o relatório mostra "Fulano, 03/11 14:02, Cad. prod.: Preço de venda 9,90 → 10,90; EAN adicionado 789…".
- **Depende de:** F2-B30.
- **Decisões usadas:** ERP 16.2, 17; MD 3.1.7.

### PR-10 – Arquivos, imagens e protocolo do PDV (release R2 do PDV)

#### F2-B43 – Envio de arquivos e imagens, com a variante para o PDV
- **Tamanho:** M
- **Objetivo:** criar a base da foto do produto, do logotipo da marca, da imagem da categoria e dos Anexos da loja (pendência da
  Fase 1), sem mexer no protocolo.
- **Entregas:**
  - **`POST /api/arquivos`** (multipart):
    - o tipo é conferido pelo conteúdo, por magic bytes: png, jpeg e webp, e pdf só nos anexos;
    - limite de 2 MB (1 MB no logotipo);
    - autorização por empresa;
    - sha256 gravado em `arquivos` e no ArmazenamentoObjetos;
    - servido com `Content-Type` fixo e `nosniff`, nunca como HTML.
  - **Variante `pdv_256`** gerada com `sharp`, sob semáforo de concorrência 1 (como a decisão 93) e com limite de pixels contra bomba
    de descompressão.
  - **Componente `<UploadArquivo>`** no ERP.
  - **Aba Anexos da loja.**
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/arquivos/` (novo), `apps/api/src/infra/armazenamento.ts`, `apps/api/package.json` (`sharp`),
    `apps/erp-web/src/componentes/campos/UploadArquivo.tsx`, tela de lojas.
  - Migração só se faltar a coluna `arquivos.variantes jsonb` (`00NN_arquivos_variantes.sql`).
- **Testes:**
  - Integração: HTML renomeado para `.png` devolve 415; 2,1 MB devolve 413; outra empresa devolve 404; a variante sai com 256 px.
  - Memória estável com 20 uploads seguidos.
  - Vitest.
- **Critério de pronto:** uma foto enviada no ERP fica guardada com o sha256 e a variante `pdv_256`, e o upload malicioso é recusado.
- **Depende de:** nada.
- **Decisões usadas:** README da API, decisões 62, 91 e 93; implantação de 03/11/2026.

#### F2-B44 – Foto e imagens do produto, categorias e marcas completas
- **Tamanho:** M
- **Objetivo:** fechar os blocos visuais do catálogo (ERP 8.2.6, 8.4, 8.7).
- **Entregas:**
  - **Produto:** foto principal (`foto_principal_arquivo_id`) e `produtos_imagens` com `<UploadArquivo>`; zod e gravação.
  - **Categorias:**
    - arrastar e soltar para mover (`POST /categorias/:id/mover`, que já existe);
    - reordenar os irmãos por um endpoint em lote com trava de versão;
    - imagem da categoria.
  - **Marcas:** logotipo e botão Imprimir (ficha com a lista de produtos, pelo navegador).
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/gravacao.ts`,
    `apps/api/src/catalogo/{categorias,marcas}.controller.ts`, `FormularioProduto.tsx`, `Categorias.tsx`, `Marcas.tsx`.
  - Sem migração.
- **Testes:**
  - Integração da reordenação com conflito de versão; gravação das imagens.
  - Vitest do arrastar e do upload.
- **Critério de pronto:** o produto tem foto, "Cervejas long neck" é arrastada para dentro de "Cervejas" e reordenada, e a marca
  mostra o logotipo e imprime a ficha.
- **Depende de:** F2-B43.
- **Decisões usadas:** ERP 8.2.6, 8.4, 8.7; README da API, decisões 61 e 62.

#### F2-B45 – Protocolo do PDV: `/sync/arquivos`, `foto_url` estável e (se a F2-Q1 incluir) as tabelas de complementos, numa só volta de cursor
- **Tamanho:** M
- **Objetivo:** juntar numa única release do PDV todas as mudanças de `Esquema.g.cs` da Fase 2, com uma só volta do cursor do
  `catalogo`, e publicar a API antes.
- **Entregas:**
  - **`GET /sync/arquivos/{id}?variante=pdv_256`**, autorizado pelo token do terminal e restrito aos arquivos ligados a registros que
    descem para aquela loja.
  - **Campos calculados no pull** (MD 6.2), suportados pelo gerador do `Esquema.g.cs` como colunas projetadas:
    - `foto_url` e `foto_sha256` nos produtos;
    - `logotipo_url` e `logotipo_sha256` nas marcas;
    - `imagem_url` e `imagem_sha256` nas categorias.
    - **`*_url` é o caminho estável `/sync/arquivos/{id}?variante=pdv_256`, nunca uma URL assinada que expira.** O sha256 invalida o
      cache.
  - **Se a F2-Q1 for (c):** as tabelas `produtos_grupos_complementos` e `produtos_complementos`.
    - CHECKs do MD 3.6.8: mínimo ≤ máximo, obrigatório ⇒ mínimo ≥ 1, item vinculado ou livre, preço adicional ≥ 0.
    - `fn_versao` com índice de versão e auditoria; registro no fluxo `catalogo` com todas as colunas.
    - FK `itens_venda_complementos.complemento_id` → `produtos_complementos` com `ON DELETE SET NULL`.
    - **Exclusão física bloqueada por trigger (só inativação)**, para um PDV offline nunca mandar um id inexistente.
    - Na Fase 3, o handler grava `complemento_id` nulo se o id não existir.
  - **PDV:** entidades novas, registro no `PdvDbContext` e **uma única migração EF** que adiciona as colunas e as tabelas e volta o
    cursor do `catalogo` a 0 (SYNC 17.4.2, padrão do C8b). Assim, as fotos enviadas antes da atualização também chegam.
  - **Protocolo:** `venda.finalizada` continua v1, e `versoes_schema` não muda. Registrar no README do PDV e na SYNC 17.
  - O cache LRU fica fora (`pdv.exibe_foto_produto = false`). Ligar a foto depois não exige ressincronização, porque os campos já
    estão no espelho.
- **Arquivos/migrações:**
  - Migração Drizzle `00NN_complementos.sql`, só se a F2-Q1 for (c).
  - API: `apps/api/src/sync/{sync.controller,fluxos}.ts`, `apps/api/src/database/esquema-pdv.ts`.
  - PDV: `apps/pdv/src/GenesisPDV.Data/Esquema.g.cs`, `Entidades/TabelasCatalogoComplementar.cs` e as entidades de
    produto/marca/categoria, `PdvDbContext.cs`, `Migracoes/<data>_FaseDois.cs`.
- **Testes:**
  - `EsquemaNuvemTests` e `verificar:esquema-pdv`.
  - Teste de migração no padrão do `MigracaoFormasPagamentoLojasTests`: o cursor volta a 0, e o próximo pull traz as fotos e os
    complementos.
  - `AplicadorPullTests`: um PDV antigo descarta as colunas e as tabelas desconhecidas e avança o cursor sem travar.
  - Integração: terminal de outra loja ou empresa recebe 404 no `/sync/arquivos`; `foto_url` é estável entre dois pulls.
  - Se houver complementos: CHECKs, e a exclusão física é bloqueada.
- **Critério de pronto:** um PDV atualizado recebe `foto_url` e `foto_sha256` (e os complementos, se houver) e baixa a variante; um
  PDV da versão anterior continua sincronizando sem erro. CI verde.
- **Depende de:** F2-B43, F2-B44; F2-Q1 (para a parte de complementos).
- **Decisões usadas:** SYNC 6.12, 17.4.2, 17.5; MD 6.1, 6.2, 3.6.8; README do PDV, decisões 37, 38 e 50; D4; crítica (URL estável,
  FK segura, uma volta de cursor).

### PR-11 – Utilitários

#### F2-B46 – Atualização das tabelas NCM e CEST pela plataforma
- **Tamanho:** M
- **Objetivo:** manter a referência do cadastro atualizada, sem uso fiscal. Prioridade baixa.
- **Entregas:**
  - **Tarefa de plataforma:**
    - baixa a tabela do Siscomex e valida o formato (aborta se mudou);
    - calcula a diferença (incluídos, encerrados) e aplica a vigência em `ncms` de cada empresa, com a role da plataforma;
    - gera o relatório do que mudou e dos produtos que ficam com NCM inválido.
  - O CEST é atualizado a partir do arquivo versionado do F2-B41.
  - `ressincronizar_fluxo referencia` quando a tabela que desce mudar.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/plataforma/ncm-atualizacao.ts`, `apps/api/src/database/referencias/carregar.ts`,
    `apps/api/src/database/controle`.
  - Sem migração de schema.
- **Testes:**
  - Unitário do parser com um arquivo de exemplo e com o formato alterado.
  - Integração em duas empresas de teste (inclusão, encerramento, formato quebrado → nada aplicado).
- **Critério de pronto:** um arquivo novo encerra um NCM, que passa a aparecer no relatório de NCMs inválidos das empresas que o usam.
- **Depende de:** F2-B41.
- **Decisões usadas:** ERP 18.13; README da API, decisões 41 e 98.

#### F2-B47 – Base de GTIN externa (condicional à F2-Q13)
- **Tamanho:** M
- **Objetivo:** sugerir nome, NCM, marca e foto no "Pesquisar EAN" do cadastro em massa.
- **Entregas:**
  - Configuração por empresa, com a chave guardada cifrada.
  - Adaptador com tempo limite de 3 s, cache e falha silenciosa (como o CEP, decisão 60). A foto sugerida passa pelo F2-B43.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/produtos/gtin-externo.ts`, `packages/shared/src/configuracoes.ts`.
  - Sem migração.
- **Testes:** servidor externo simulado (tempo limite, 404, cota) e cache.
- **Critério de pronto:** com a chave, o EAN de uma cerveja preenche nome, NCM e marca; sem a chave, ou com o serviço fora, a grade
  segue normal.
- **Depende de:** F2-B39, F2-B43; F2-Q13 = "sim" (senão, vai para o backlog).
- **Decisões usadas:** ERP 18.13, 8.3; F2-Q13.

### PR-12 – Variações (condicional à F2-Q1 (b) ou (c))

#### F2-B48 – Variações: atributos, gerar variações e grade no produto
- **Tamanho:** M
- **Objetivo:** cadastrar o produto com grade (tamanho, sabor).
- **Entregas:**
  - CRUD de `atributos_variacao` e dos valores (zod, API e tela em Cadastros).
  - **Modal "Gerar variações":** até 3 atributos, grade de combinações, nome gerado, código interno, EAN em
    `produtos_codigos_barras` com `variacao_id`, preço e custo, e ativo.
  - **`POST /produtos/:id/variacoes/gerar`**, idempotente: não duplica uma combinação existente.
  - Grade das variações no produto.
  - Filtro Cód. Barras da listagem com o EAN das variações.
  - Unicidade de EAN cobrindo as variações (no formulário e no F2-B38).
  - **Ligação da chave.** `produtos.variacoes_habilitadas` é ligada só nos testes e na homologação. Em produção, só no fim do PR-12,
    depois do F2-B49 e com a R1 do PDV (F2-B34) publicada.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/catalogo/atributos.controller.ts`, `apps/api/src/produtos/variacoes.ts`, `packages/shared/src/produtos.ts`,
    telas.
  - Sem migração (as tabelas existem e já descem).
- **Testes:**
  - Integração: 2 × 3 combinações; gerar de novo não duplica; EAN repetido com "bloquear" devolve 409.
  - Vitest do modal.
- **Critério de pronto:** "Camiseta" com P/M/G × preta/branca gera 6 variações com EAN, que descem ao PDV, e o caixa as recusa
  (F2-B34).
- **Depende de:** F2-B1, F2-B34 (publicado); F2-Q1.
- **Decisões usadas:** ERP 8.2.1, 8.2.16; MD 3.6.6; README da API, decisões 63, 74 e 96; F2-Q1, F2-Q2.

#### F2-B49 – Variações no razão e nos documentos, e liberação do tipo
- **Tamanho:** M
- **Objetivo:** a variação com saldo próprio de ponta a ponta.
- **Entregas:**
  - **Variação obrigatória.** Acerto, mudança de tipo, recebimento, NF-e (vínculo pelo EAN da variação), transferência e Estoque
    Atual exigem e mostram a variação quando o produto tem variações. O saldo fica por `saldos_estoque.variacao_id`, sem custo médio
    próprio (decisão 96).
  - **Colunas de variação** na grade da transferência e no Estoque Atual.
  - **Liberação.** Ligar `produtos.variacoes_habilitadas` em produção. O ERP avisa se houver terminal com versão anterior à R1.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/estoques/acertos.ts`, `apps/api/src/entradas/`, `apps/api/src/transferencias/`,
    `apps/api/src/relatorios/estoque-atual.ts`, telas.
  - Sem migração; sem mudança no `Esquema.g.cs`.
- **Testes:**
  - Integração: o recebimento de uma variação sobe o saldo da variação; um acerto sem variação em produto com variações devolve 422;
    a NF-e com o EAN da M entra na M.
  - Integração: o recalcular dá idêntico com variações.
- **Critério de pronto:** a NF-e com o EAN da variação M entra no saldo da M, e o caixa recusa vender a variação sem baixar o saldo
  do pai.
- **Depende de:** F2-B48, F2-B16, F2-B21, F2-B27, F2-B31.
- **Decisões usadas:** PDV 10.2; MD 6.1; README da API, decisão 96.

#### F2-B50 – Variações na planilha e no cadastro em massa
- **Tamanho:** P
- **Objetivo:** fechar a ponta da planilha.
- **Entregas:**
  - **Importação** aceita as linhas de variação (pai + atributos), acabando com o erro em `importacao/produtos.ts:693`. A prévia
    separa "Criar variação" de "Atualizar produto", para evitar atualização em massa por engano.
  - **Exportação** (F2-B40) com as variações, mantendo a ida e volta.
  - **Cadastro em massa:** o EAN de variação vira "Atualização" da variação, e o estoque a somar vai para a variação.
- **Arquivos/migrações:**
  - Arquivos: `apps/api/src/importacao/produtos.ts`, `packages/shared/src/importacao.ts`, `apps/api/src/produtos/cadastro-massa.ts`,
    `apps/api/src/produtos/exportacao.ts`.
  - Sem migração.
- **Testes:** ida e volta com variações = 100% sem alteração; integração da prévia.
- **Critério de pronto:** uma planilha com 1 produto e 6 variações cria tudo, e a reimportação não muda nada.
- **Depende de:** F2-B48, F2-B39, F2-B40.
- **Decisões usadas:** ERP 8.6, 8.3; MD 3.6.6.

### PR-13 – Complementos: modal (condicional à F2-Q1 (c))

#### F2-B51 – Complementos: modal no ERP e liberação do tipo
- **Tamanho:** P
- **Objetivo:** cadastrar grupos e itens sobre as tabelas do F2-B45. O uso na venda é da Fase 3.
- **Entregas:**
  - **Zod e gravação junto do produto:** grupos com mínimo, máximo e obrigatório; itens vinculados ou livres, com preço adicional e
    baixa de estoque. Excluir um item só o inativa.
  - **Modal "Complementos"** no formulário.
  - **Liberação.** Ligar `produtos.complementos_habilitados`. O caixa continua vendendo sem complementos.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/gravacao.ts`, `FormularioProduto.tsx`.
  - Sem migração nova.
- **Testes:**
  - Integração: CHECKs, descida no fluxo `catalogo` e inativação no lugar da exclusão.
  - Vitest.
- **Critério de pronto:** um produto "Porção" com o grupo "Molhos (0 a 2)" é cadastrado no ERP e aparece no SQLite do caixa.
- **Depende de:** F2-B45 (com complementos); F2-Q1.
- **Decisões usadas:** ERP 8.2.16; MD 3.6.8; D4; F2-Q1.

### PR-14 – Tributação gravada e fechamento

#### F2-B52 – Tributação só gravada (último bloco funcional)
- **Tamanho:** P
- **Objetivo:** guardar os campos fiscais que existem no schema mas não estão no zod nem na tela, sem calcular nada.
- **Entregas:**
  - **Sub-grades:**
    - "Tributação por UF" (`produtos_tributacao_uf`, que já desce ao PDV);
    - "ST retido por loja", com preenchimento manual auditado em `produtos_lojas`.
  - **Campos novos no zod, na gravação e na tela:**
    - Imposto Seletivo: `is_cst`, `is_classificacao`, `is_aliquota_pct`, `is_aliquota_especifica`, `is_unidade`;
    - unidade tributável e fator: `unidade_tributavel_id`, `fator_tributavel`.
  - **Aviso fixo** no bloco: "Somente registro. Nenhum cálculo fiscal é feito nesta versão." Os CHECKs de faixa do banco
    (`ck_produtos_fcp` etc.) continuam valendo, sem nenhuma validação fiscal nova.
- **Arquivos/migrações:**
  - Arquivos: `packages/shared/src/produtos.ts`, `apps/api/src/produtos/gravacao.ts`, `FormularioProduto.tsx`.
  - Sem migração; o `Esquema.g.cs` não muda.
- **Testes:**
  - Vitest do zod.
  - Integração: gravação, auditoria e CHECKs; `produtos_tributacao_uf` continua descendo (o `EsquemaNuvemTests` não muda).
- **Critério de pronto:** o contador preenche a tributação do PR e o ST retido da Loja 1, e os valores ficam gravados e auditados,
  sem efeito em preço nem em venda.
- **Depende de:** nada (pode ser antecipado se houver folga).
- **Decisões usadas:** ERP 8.2.10, 8.2.15; MD 3.6.3, 3.6.9; README da API, decisão 67; restrição do dono.

#### F2-B53 – Fechamento da Fase 2: documentação, Definição de pronto e execução com o dono
- **Tamanho:** P
- **Objetivo:** deixar o roadmap e os READMEs fiéis ao que foi entregue e fazer a virada real com a Ice Beer.
- **Entregas:**
  - **Roadmap:**
    - tirar "pela SEFAZ" e o certificado A1 da Fase 2 e da Definição de pronto, e registrar que a D11 deixa de bloquear a fase;
    - marcar os itens [x];
    - registrar as respostas F2-Q1 a F2-Q14 no §16 (D43 em diante; F2-Q3 = D6);
    - anotar que a conversão de CFOP, TROCA_PDV e BAIXA_INTERNA ficaram para as fases seguintes.
  - **README da API:**
    - decisão 76 corrigida;
    - decisões novas: `seq_lancamento`, `retroativoPermitido`, estoques permitidos e virada, FEFO dividindo o movimento, perda na
      transferência, streaming, sem particionamento;
    - os padrões aplicados sem pergunta, inclusive a confirmação da regra de estorno com negativo.
  - **READMEs do ERP e do PDV:** R1 e R2 do PDV e a guarda das variações.
  - **Checklist da execução real:**
    1. importação completa;
    2. carga do Nuvem3 com a hora;
    3. contagens por setor (F2-Q5);
    4. primeiras NF-e reais, formando fornecedores e vínculos, com o vínculo reaproveitado na nota seguinte;
    5. primeira transferência CD → loja;
    6. conferência com a tolerância da F2-Q6;
    7. `db:recalcular-saldos` em produção, sem divergência.
- **Arquivos/migrações:**
  - Arquivos: `docs/roadmap.md`, `apps/api/README.md`, `apps/erp-web/README.md`, `apps/pdv/README.md`, `docs/implantacao/`.
  - Sem migração.
- **Testes:** CI completo verde (API, ERP, PDV, `verificar:esquema-pdv`) e o registro da execução real.
- **Critério de pronto:** todos os itens da Definição de pronto (sem a SEFAZ) estão demonstrados, com o registro na loja piloto, e os
  saldos estão dentro da tolerância combinada.
- **Depende de:** todos os blocos que entrarem na fase.
- **Decisões usadas:** roadmap Fase 2 › Definição de pronto; restrição do dono; F2-Q5, F2-Q6.
