# Decisões do dono

Fonte da verdade das respostas do dono (Fase 2: perguntas F2-Q1..F2-Q14 do `fase2-plano.md`; Central do PDV: PC-1..PC-13 do `pdv-central-plano.md`; e as decisões D do roadmap §16). Enquanto uma pergunta não tiver
resposta aqui, vale a RECOMENDAÇÃO do plano (configurável), registrada no README como "padrão até a confirmação do dono".

## Respondidas

Respostas do dono em 04/11/2026 (as demais seguem a recomendação do plano, "padrão até a confirmação do dono"):

- **F2-Q1 (D43) — RESPONDIDA (04/11/2026): complementos SIM, variações NÃO.** A Petiscaria 2 vende com adicionais
  escolhidos na hora (ex.: porção + cheddar/bacon; caipirinha escolhendo fruta e bebida). Logo:
  - **Complementos entram na Fase 2:** as tabelas de complementos no F2-B45 e o F2-B51 (cadastro de grupos/itens no ERP,
    com preço adicional e baixa de estoque; liga `produtos.complementos_habilitados`). A **venda com complementos no caixa
    vai para a Fase 3** (PDV-2), não para o backlog/Fase 8: registrar no roadmap.
  - **Variações continuam travadas** (opção (a) para variações): F2-B48–B50 vão para o backlog; `produtos.variacoes_habilitadas`
    = false. F2-Q2 (D44) segue a recomendação (recusar no caixa o EAN de variação).
- **F2-Q3 (D6) — RESPONDIDA: (b).** O CD TEM CNPJ próprio, e cada loja tem o seu CNPJ. O CD é cadastrado como loja do
  tipo "depósito" com o CNPJ dele; a NF-e de compra pode vir com o CNPJ do CD ou de qualquer loja, e o estoque de
  destino é escolhido entre os permitidos. Avisado ao dono: transferência física entre CNPJs diferentes exige NF-e de
  transferência, que o Genesis só emitirá na fase fiscal — até lá, o documento fiscal da transferência sai por fora
  (Nuvem3/contador) e o Genesis registra o movimento de estoque (F2-B22..B27 devem deixar um campo para a chave/número
  da NF-e de transferência emitida por fora, opcional).
- **F2-Q5 (D46) — RESPONDIDA: (c).** Saldo inicial pela exportação de saldos do Nuvem3 na virada; depois contagens
  ("vamos auditando") com a loja aberta.
- **F2-Q8 (D49) — RESPONDIDA: (a) + preço de custo maleável.** Entram todos (ICMS-ST, FCP-ST, IPI, frete, seguro,
  outras despesas) e os créditos não são descontados. ALÉM disso, o dono quer o **"Preço de custo" cadastrável à mão**
  (já existe `produtos.preco_custo`) e o **custo do produto por fornecedor** editável: em `produtos_fornecedores`,
  além do último custo (somente leitura, vindo da compra), um **custo do fornecedor editável** (F2-B13), com a opção de
  levar esse custo para o preço de custo do produto. A NF-e/recebimento atualiza custo médio e último custo; o preço de
  custo manual NÃO é sobrescrito sem confirmação (chave `estoque.compra_atualiza_preco_custo` = 'perguntar', opções
  'sempre' | 'perguntar' | 'nunca'). "Bem maleável": a margem/preço sugerido pode usar preço de custo, custo médio ou
  último custo (chave `produtos.custo_base_margem`, padrão 'preco_custo').
- Demais (F2-Q2, Q4, Q6, Q7, Q9–Q14): sem resposta explícita; vale a recomendação do plano.

## Contexto da implantação informado pelo dono (04/11/2026)

- Duas lojas no piloto: **Loja 1** e **Petiscaria 2**, cada uma com CNPJ próprio; CD com CNPJ próprio.
- PCs: Windows 10 numa loja e Windows 11 na outra; rede por cabo; impressora térmica USB (modelo a comprar).
- Usuários: o dono (Master); Loja 1: 3 atendentes (Atendente 1, 2 e 3); Petiscaria 2: 1 atendente ("Caixa
  Central"). Sem gerentes por enquanto.
- **Convivência com o Nuvem3 (D42) — RESPONDIDA (04/11/2026): Genesis no caixa + NFC-e no Nuvem3.** O Genesis é o caixa
  principal e o estoque oficial nas lojas reais (Loja 1 e Petiscaria 2, não a loja Treino); a NFC-e de cada venda continua
  sendo emitida no Nuvem3 até a Fase 3F (digitação dupla, decisão do dono, ciente). Atualizar D42 no roadmap e a seção 5 do
  docs/implantacao/roteiro-piloto.md. Ordem das fases mantida: 2 → 3 → 4 → 5 → 3F (fiscal por último).
- **Liberações (supervisor) — RESPONDIDA (04/11/2026):** por enquanto só o PIN do dono (Master), nas duas lojas; o dono criará
  depois, no ERP, um login de "Encarregado" para liberar. Avisado: com o padrão atual, todo PIX confirmado à mão pede o PIN do
  supervisor (chave `pdv.pix_manual_exige_supervisor` e permissão `pdv.pagamento.confirmar_pix_manual`).
  **Confirmado pelo dono (04/11/2026): cada PIX confirmado à mão pede o PIN dele** (mantém o padrão:
  `pdv.pix_manual_exige_supervisor = true` e os atendentes sem `pdv.pagamento.confirmar_pix_manual`). Ciente de que, sem ele
  na loja, a venda em PIX manual não fecha até o login de "Encarregado" existir.


## Central do PDV (engrenagem) — decisões do dono

- **PC-1 / D23 mantida (04/11/2026):** venda de caixa FECHADO só se cancela pelo ERP (Fase 3). Na Central do PDV, as vendas e os
  caixas antigos ficam só para consulta e reimpressão; o cancelamento no PDV continua só para a sessão de caixa aberta.
- **Cancelamento de venda de caixa fechado pelo ERP (04/11/2026):** o dono prefere ESPERAR a Fase 3 (não antecipar). Até lá,
  venda de caixa fechado não se cancela em lugar nenhum; o erro fica registrado e é corrigido na Fase 3.
- **PC-7 (04/11/2026):** sim — o operador vê o Painel de saúde e o Sobre, só leitura, sem PIN.
- **PC-8 (04/11/2026):** sim — criar o perfil de sistema "Encarregado" (Supervisor + vendas/caixas antigos + diagnóstico +
  pacote de suporte; sem histórico de uso e sem parâmetros). Ninguém recebe sozinho.
- **PC-9 (04/11/2026):** não — caixas antigos no PDV só como foram impressos; calculado/diferença só no ERP (O3 mantida).
- **PC-13 (04/11/2026):** bloqueio de tela por inatividade existe, desligado por padrão, configurável por caixa.
- PC-2, PC-11, PC-12: valem as recomendações (regras da loja só no ERP; não apagar histórico, telas até 90 dias; pacote de
  suporte em pendrive agora, envio pelo ERP depois).
- **Vendas e caixas antigos na Central (04/11/2026), no lugar dos "90 dias":** a aba Vendas abre só com as vendas do CAIXA
  ABERTO (no topo); um filtro escolhe um dos **10 últimos caixas fechados** deste terminal; mais antigos, só no ERP. A aba
  Caixas segue o mesmo limite (10 últimos fechamentos). O banco local continua guardando tudo (nada é apagado, PC-11).
- **Ajuste (04/11/2026):** o limite passa a ser **30 dias** (não 10 caixas): o filtro lista os caixas fechados deste terminal
  nos **últimos 30 dias** (pelo dia operacional do fechamento); mais antigos, só no ERP. Vale para Vendas e Caixas.

## Respostas de 05/11/2026

Todas as decisões abaixo saem de "padrão até a confirmação do dono" e passam a "Decidida (dono, 05/11/2026)" no roadmap §16.

- **D47 (tolerância da conferência do inventário):** confirmada — 1% do valor contado a custo no total e 5% por item, e
  **ajustável** por loja nas Configurações (`estoque.tolerancia_conferencia_total_pct` / `_item_pct`).
- **D48 (venda sem lote):** confirmada — baixa por FEFO (o que vence primeiro sai primeiro).
- **D55 (Tipos de Estoque):** confirmada — tipo novo nasce não vendável; só deixa de ser vendável com saldo zero. O dono
  acrescentou: **a loja nunca deve travar a venda por estoque negativo** (`pdv.bloqueia_venda_sem_estoque` = false é o
  padrão; a API nunca recusa venda do PDV por saldo negativo).
- **Importação dividida (planilha > 5.000 itens):** 4A — as partes já efetivadas ficam valendo e o aviso diz qual parte
  falhou (cada parte é um acerto estornável sozinho).
- **D56 (estorno de recebimento/NF-e que deixa saldo negativo):** A **com aviso** — bloqueado, salvo Master ou
  `estoque.permite_negativo_erp`; quando permitido, a tela mostra os produtos que ficarão negativos e pede confirmação, e a
  auditoria registra a confirmação.
- **D57 (lotes):** confirmada — o estoque do lote não muda depois de gravado; lote com saldo/movimento/acerto em rascunho só
  se inativa.
- **Estoquista:** pode cadastrar fornecedor **e pessoas** (cadastro completo): ganha `pessoas.criar_fornecedor` (cadastro
  rápido de fornecedor no recebimento, inclusive dar a categoria Fornecedor a uma pessoa existente) e `pessoas.criar`;
  não ganha editar, excluir nem importar pessoas. README da API › decisões 165 e 168.
- **Pergunta "preço geral / só desta loja" no recebimento:** escondida para quem não pode alterar preço.
- **D50 (assinatura do XML que não confere):** confirmada — avisa (`notas_entrada.assinatura_invalida = 'avisar'`).
- **XMLs reais de fornecedores:** o dono envia depois. Com o repositório público (D60), **não entram no repositório**:
  ficam em `apps/api/test/fixtures/nfe/reais/` só na máquina de quem testa (no `.gitignore`), e o teste com eles roda
  só localmente.
- **Encarregado:** **pode** cancelar venda paga com o caixa aberto (diferente do Supervisor).
- **Painel de saúde do PDV:** vermelho com o caixa sem internet e venda pendente há mais de **1 h** (confirmado).
- **2ª via do fechamento (Central › Caixas):** quem não vê o "calculado" precisa do PIN de quem vê (confirmado).
- **Histórico de uso (Central):** o filtro "Quem" inclui também quem **liberou** com o PIN.
- **Decisões antigas confirmadas em bloco:** D31 (abertura de caixa), D37 (PIX manual e maquininha), D40 (alertas críticos
  no Dashboard), D44 (produto com variações recusado no caixa), D45 (acesso ao CD como antes da virada).
- **Infra:** GitHub Pro assinado em 05/11/2026 (Actions voltou); o dono roda a Implantação.
- **PDV só no Windows (D58):** o dono pediu para focar só no Windows daqui para frente — o Linux era só para os testes,
  foi o que mais gastou minutos no Actions e nenhum computador dos PDVs usa Linux. O PDV na CI roda só no Windows (a
  formatação do C# num job leve no Linux), o `.deb` sai do CI e do release (só o `.exe`), e o Linux deixa de ser
  plataforma de distribuição (o código continua compilando e os testes rodam no Linux do desenvolvimento). README do
  PDV › decisão 80; CONTRIBUTING.md › CI.
- **Integração da API na CI só no PostgreSQL 18 (D59):** o dono mandou seguir a recomendação (05/11/2026). A suíte de
  integração roda só no job do PostgreSQL 18 (a versão da produção); o 16 fica no `pnpm test` local. CONTRIBUTING.md › CI.
- **Pedidos de economia (05/11/2026):** CI só no push da `main` (#27); a memória do projeto fica no repositório
  (`CLAUDE.md`, `docs/andamento.md`, este arquivo) para qualquer sessão do Claude Code continuar; o dono vai pôr US$ 10
  de orçamento no Actions.

## Repositório público (06/11/2026)

- **D60 — RESPONDIDA (06/11/2026): opção B.** Para o GitHub Actions deixar de cobrar minutos, o código vai para um
  **repositório público novo**, com uma única versão limpa (sem histórico), feita a partir da branch
  `infra/repositorio-publico` (bloco PUB-1); o repositório atual fica **privado, como arquivo**, sem reescrever o
  histórico. O relatório do Nuvem3 (a pasta de referências) saiu do repositório: o dono recebeu uma cópia em
  06/11/2026 e a guarda fora dele. Regra nova (`CLAUDE.md`): nada de dado real (cliente, funcionário, fornecedor, catálogo, planilha,
  XML de nota real), log de produção, IP ou credencial no repositório; os XMLs reais de fornecedores ficam só na
  máquina de quem testa. Ficam com o dono: criar o repositório novo, recadastrar os segredos, environments e variáveis,
  ligar a proteção da `main` (PR obrigatório com 0 aprovações, sem a revisão do `CODEOWNERS`: os PRs saem da conta do
  dono, e o GitHub não deixa o autor aprovar o próprio PR; o `CODEOWNERS` só pede a revisão), a regra de branch dos
  environments (`producao`: só `main`; `release-pdv`: `main` e tags `pdv-v*`, com o tag ruleset), apagar os logs antigos do Actions e endurecer o SSH da
  VPS (`infra/producao/README.md` › Proteger o SSH da VPS). Roadmap §16, D60.
  **Feito em 06/11/2026:** o repositório antigo virou `KhauanG/GenesisPDV-ERP-arquivo` (privado; como fica privado,
  os logs antigos do Actions não precisaram ser apagados) e o novo `KhauanG/GenesisPDV-ERP` (público) começou com a
  versão única `a66397f`. O dono configurou os environments, o ruleset da `main`, as permissões do Actions e o secret
  scanning, gerou a chave SSH nova da implantação e revogou a antiga; o PDV 0.10.0 e a `main` foram implantados pelo
  repositório novo. Sem certificado de assinatura do PDV (o dono nunca teve; padrão do README do PDV). A chave PIX
  `pix@icebeer.com.br` dos testes é só de teste (confirmado pelo dono). Falta: proteger o SSH da VPS.

## Transferência CD ⇄ loja — PR-6 (06/11/2026)

O dono concordou com todas as recomendações ("Concordei com tudo!", 06/11/2026). Todas já eram o padrão aplicado
nos blocos F2-B22..B26; nada muda no código, só deixam de ser "padrão até a confirmação do dono".

- **F2-Q10 (D51) — RESPONDIDA: (b).** A diferença recebida a menor que é perda volta ao CD (`TRANSF_RETORNO`) e
  sai de lá na hora como perda (acerto de Saída de origem `perda_transferencia`): o saldo do CD não muda e a perda
  fica registrada ao custo do envio. README da API › decisões 170 e 172.
- **F2-Q11 (D52) — RESPONDIDA: (a).** A sugestão de reposição arredonda para cima até o fardo ou a caixa fechada (a
  embalagem de compra de maior fator), sem passar do saldo do CD (`estoque.reposicao_arredonda_embalagem` = true,
  configurável). README da API › decisão 173.
- **D61 — RESPONDIDA: as recomendações.** (1) Trata a diferença quem tem a origem **ou** o destino entre os estoques
  permitidos, com `transferencias.receber`. (2) No modo de uma etapa, quem envia não precisa ter o destino: a chave é
  a autorização e o recebimento fica em nome de quem enviou. (3) O lote preso ao estoque de origem entra no lote de
  mesmo código e validade no destino (criado com os mesmos dados se não existir); com o mesmo código e outra validade
  no destino, o item é recusado. README da API › decisão 172.
- **D62 — RESPONDIDA: as recomendações.** (1) A Ice Beer usa a transferência em **duas etapas** (o CD envia e a
  loja confere e recebe; `estoque.transferencia_recebimento_automatico` fica desligada). (2) A sugestão de reposição
  exige o estoque da loja de destino entre os permitidos de quem pede, porque mostra o saldo, o mínimo e o máximo
  dela: quem monta as cargas no CD precisa ter liberados o CD e as lojas que abastece (Usuários › Estoques
  permitidos); criar e enviar à mão continua sem exigir o destino. (3) A "Divergência a tratar" aparece no estoque de
  **origem**, onde a diferença se trata. (4) O alerta de transferência parada sai depois de **3 dias**
  (`estoque.transferencia_alerta_dias`, configurável). README da API › decisões 173 e 174.

## PDV: guarda e consulta — PR-8 (10/11/2026)

- **F2-Q12 (D53) — vale a recomendação (sem resposta explícita do dono).** Pela regra acima ("Demais (F2-Q2, Q4, Q6,
  Q7, Q9–Q14): sem resposta explícita; vale a recomendação do plano"), o `F4` "Outras lojas" da pesquisa do caixa
  mostra a opção (a): só o estoque vendável das lojas reais e do CD, sem a loja Treino, liberado a qualquer operador,
  só quantidades e nunca o custo, desligável por `pdv.consulta_outras_lojas` (padrão Sim, por loja). Implementado no
  F2-B35 (README da API › decisão 182, do ERP › 70, do PDV › 82; roadmap §16, D53). Se o dono preferir (b) — também
  avaria e vasilhame vazio — ou (c) — só com permissão de supervisor —, muda a consulta da API e o diálogo do PDV.

## Catálogo operacional — PR-9 (10/11/2026)

- **F2-Q13 (D54) — vale a recomendação (sem resposta explícita do dono).** Pela regra acima ("Demais (F2-Q2, Q4, Q6,
  Q7, Q9–Q14): sem resposta explícita; vale a recomendação do plano"), a opção (a): a Ice Beer não contrata agora uma
  base externa de códigos de barras; o "Pesquisar EAN" do cadastro em massa procura só na base da empresa (o código já
  cadastrado vira "Atualização"). Implementado no F2-B39 (README da API › decisão 185, do ERP › 73; roadmap §16, D54).
  Se o dono preferir (b) — contratar um serviço como o Cosmos —, ele indica o serviço e quem contrata, e o F2-B47 sai
  do backlog para sugerir nome, NCM, marca e foto na mesma pesquisa.
- **F2-Q14 (D66) — vale a recomendação (sem resposta explícita do dono).** Pela regra acima ("Demais (F2-Q2, Q4, Q6,
  Q7, Q9–Q14): sem resposta explícita; vale a recomendação do plano"), a opção (b): até o dono mandar exportações reais
  do Nuvem3 com a coluna `UsaBalancaEtiquetadoraStr` preenchida e com o "grupo de itens" (combo), a importação mantém o
  mapeamento provisório da balança (Peso/Sim = pesado, Unidade = por unidade, Não = não usa; README da API › decisão
  104) e o combo pela coluna `composicao` (decisão 95), isolados num ponto só (`MAPEAMENTO_PROVISORIO_NUVEM3`).
  Implementado no F2-B40 (README da API › decisão 186; roadmap §16, D66). Se o dono mandar os arquivos — opção (a) —,
  fecha-se o mapeamento definitivo trocando só esse ponto.
- **D65 — RESPONDIDA (11/11/2026): (A) 100 linhas por gravação do cadastro em massa, tudo ou nada.** A ERP 8.3
  dizia 500; a revisão do F2-B39 mediu que cada linha da grade faz de 9 a ~50 idas ao banco com a trava de ordenação
  presa, e 500 linhas prenderiam os caixas e o ERP por 40 a 75 s na produção (100 ficam em 8 a 15 s). Opções
  apresentadas: (a) 100 linhas, tudo ou nada (recomendada, a escolhida); (b) voltar a 500, aceitando a espera; (c)
  gravar em partes de 100 sem o "tudo ou nada" da grade inteira. Catálogos grandes continuam pela importação de
  planilha. README da API › decisão 185; roadmap §16, D65.

## Segurança: revisão por PR e auditoria completa (10/11/2026)

- **D63 — RESPONDIDA: (A) sim, a partir do PR-9.** Antes de abrir cada PR, além da revisão por bloco do
  `genesis-bloco`, roda a revisão de segurança do PR inteiro (skill `security-review`, já disponível nas sessões). Os
  achados confirmados são corrigidos no próprio PR e citados no corpo dele. Roadmap §16, D63; CLAUDE.md › Regras de
  trabalho.
- **D64 — RESPONDIDA: (A) no fim da Fase 2.** Auditoria completa de segurança do sistema inteiro antes de levá-lo a
  todas as lojas: principal pelo plugin oficial `claude-security` (catálogo da Anthropic; o dono instala na hora) e,
  como segunda opinião, a skill `cloudflare/security-audit-skill`. Nada a instalar antes. Roadmap §16, D64;
  `docs/andamento.md` › Pendências.
- **Plugins sugeridos pelo dono (caveman, claude-mem, karpathy-guidelines):** não adotados, pela recomendação — o
  caveman encurta as respostas (o contrário do que o dono pede), a memória do projeto já é o `andamento.md` e este
  arquivo (versionados; as sessões na nuvem são descartáveis e o repositório é público) e as diretrizes de código já
  estão cobertas pelo processo de bloco.

## Documento da venda na fase fiscal (11/11/2026)

- **D67 — RESPONDIDA: as três situações ("As três opções são ótimas para se ter").** Vale para a fase fiscal (3F);
  nada muda antes dela.
  1. **Loja de regime dispensado da NFC-e** (no PR, o MEI: Res. SEFA 145/2015, art. 7º;
     `parametros_fiscais_uf.regime_dispensa_nfce`): o padrão é o comprovante "Não fiscal", com uma tecla no caixa
     para **emitir a NFC-e só para o cliente que pedir**. A opção só aparece em loja desse regime: em loja obrigada o
     ERP não deixa ligar.
  2. **Loja obrigada a emitir:** a NFC-e sai em **toda venda**, em segundo plano. O CPF na nota só entra quando o
     cliente pede (F5), e a impressão segue a forma mais curta que a UF permitir. **Não existe "venda sem nota"** em
     loja obrigada: o dono perguntou pela nota só a pedido também nessas lojas, e foi explicado que isso é omissão de
     receita (Lei 8.137/1990, art. 1º, V).
  3. **Cliente PJ:** NF-e modelo 55 a pedido (`nfe_solicitada`, especificação do PDV, Fase 6).
  - Para o dono, antes da fase fiscal: confirmar com o contador o regime de cada CNPJ da Ice Beer e se os produtos com
    ICMS-ST e PIS/COFINS monofásico estão sendo separados no DAS.
  - Roadmap §16, D67; especificação do PDV › 18.

## ST retido por loja: dado de custo (13/11/2026)

- **D68 — ABERTA (13/11/2026); vale a recomendação (A) até o dono responder.** A revisão do F2-B52 achou que o ST
  retido por loja (vICMSSubstituto, vBCSTRet e os demais valores em R$) aparecia no detalhe do produto, na auditoria e
  no Histórico de produtos para quem tem `produtos.ver` mas não `produtos.ver_custo`, e que com eles dá para chegar ao
  preço de compra (vICMSSubstituto ÷ alíquota própria; vBCSTRet ÷ (1 + MVA)). Opções: (A) tratá-los como custo, só com
  `produtos.ver_custo` (recomendada, a implementada); (B) registrar que não são sensíveis e mostrá-los a todos que veem
  o produto. Efeito da (A): sem a permissão, os cinco valores em R$ (vBCSTRet, vICMSSubstituto, vICMSSTRet,
  vBCFCPSTRet, vFCPSTRet) saem vazios no ERP e na API, não são gravados nem apagados por esse usuário e somem da
  auditoria e do histórico dele; os percentuais (pST, pFCPSTRet) continuam visíveis. README da API › decisão 195; do
  ERP › 80; roadmap §16, D68.
