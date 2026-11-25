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
  - **13/11/2026 (dono):** "Use o da cloudflare" — a auditoria do fim da Fase 2 roda com a skill
    `cloudflare/security-audit-skill` (o repositório público dela, lido por inteiro antes do uso), no perfil
    `standard`, com o método completo de 6 fases e o código só executado num sandbox isolado (sem rede, alvo somente
    leitura, limites de CPU, memória e tempo). Os resultados ficam fora do repositório (que é público) até as correções.
    O `claude-security` não foi instalado.
- **D69 — RESPONDIDA (14/11/2026): "1A e 2A".** A auditoria completa (D64) terminou com achados confirmados e
  pistas que dependem de checagens do dono; os detalhes ficam **fora do repositório** (público, D60) até as correções
  estarem em produção.
  - **(1A)** Um **PR-15 de segurança**, em blocos, cada um com a revisão completa (3 lentes), a tentativa de refutar
    cada achado e todos os checks: primeiro o achado mais grave e os médios, depois os leves. Merge só com a liberação
    do dono, como sempre; o texto do PR e dos commits descreve as proteções, não como explorar.
  - **(2A)** As pontas que a auditoria deixou em aberto (os itens sem decisão final e a parte não examinada) são
    verificadas no começo do PR-15, na área isolada de testes; os que se confirmarem são corrigidos no mesmo PR.
  - Opções que não foram escolhidas: (1B) só os graves e médios agora; (1C) dois PRs; (2B) uma segunda auditoria
    completa depois das correções; (2C) deixar para depois. Roadmap §16, D69.
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

- **D68 — RESPONDIDA (13/11/2026): (A).** O dono respondeu "1A" à pergunta D68 em 13/11/2026, depois da abertura do
  PR-14: os valores em R$ do ST retido são dado de custo, só com `produtos.ver_custo`. A revisão do F2-B52 achou que o ST
  retido por loja (vICMSSubstituto, vBCSTRet e os demais valores em R$) aparecia no detalhe do produto, na auditoria e
  no Histórico de produtos para quem tem `produtos.ver` mas não `produtos.ver_custo`, e que com eles dá para chegar ao
  preço de compra (vICMSSubstituto ÷ alíquota própria; vBCSTRet ÷ (1 + MVA)). Opções: (A) tratá-los como custo, só com
  `produtos.ver_custo` (recomendada, a escolhida e implementada); (B) registrar que não são sensíveis e mostrá-los a todos que veem
  o produto. Efeito da (A): sem a permissão, os cinco valores em R$ (vBCSTRet, vICMSSubstituto, vICMSSTRet,
  vBCFCPSTRet, vFCPSTRet) saem vazios no ERP e na API, não são gravados nem apagados por esse usuário e somem da
  auditoria e do histórico dele; os percentuais (pST, pFCPSTRet) continuam visíveis. README da API › decisão 195; do
  ERP › 80; roadmap §16, D68.

## Fechamento da Fase 2 (13/11/2026)

- **Nenhuma resposta nova do dono neste fechamento** (F2-B53). O quadro das F2-Q1 a F2-Q14 com a situação de cada uma
  está no fim do roadmap §16: respondidas ou confirmadas pelo dono as F2-Q1 a F2-Q11 (D43, D44, D6, D45, D46 a D52);
  **valem as recomendações, sem resposta explícita**, a F2-Q12 (D53), a F2-Q13 (D54) e a F2-Q14 (D66). A **D68** (ST
  retido em R$ como custo) foi respondida pelo dono depois, no mesmo dia: (A) (seção acima).
- **Para o dono:** a execução real que fecha a Fase 2 na loja piloto (importação, carga do Nuvem3, contagens, NF-e
  reais, transferência, conferência e `db:recalcular-saldos`) está em `docs/implantacao/checklist-fechamento-fase2.md`;
  o resultado de cada passo é anotado lá e no `docs/andamento.md`, sem dado real.

## Operação sem o GitHub Actions (24/11/2026)

- **D70 — RESPONDIDA (24/11/2026):** "minha cota de Actions acabou, continue o projeto, usando sandbox para testes,
  para não precisarmos dos actions". A verificação local completa na sessão (OP-B1) passa a ser o portão no lugar da
  CI; os workflows ficam no repositório para quando a cota voltar. Plano: `docs/planos/operacao-sem-actions-plano.md`.
  - **D70-Q1 = (A) e D70-Q2 = (A) — RESPONDIDAS (24/11/2026), com autonomia:** "Eu autorizo você a fazer as duas
    coisas de forma autonoma, usar o VPS para os comandos de terminal e tambem tudo relacionado ao release no
    GitHub". Efeito:
    - **Implantação (D70-Q1):** pela VPS, com o `infra/producao/implantar-sem-actions.sh` (OP-B2). Como a sessão não
      alcança a VPS por SSH (a rede da sessão só sai por HTTPS), o dono instala **uma vez** o vigia da implantação
      (OP-B4): a VPS confere de tempos em tempos o repositório público e implanta o commit da `main` que a sessão
      marcar com uma tag `implantar/…`. A sessão passa a poder pedir a implantação de um commit **que já está na
      `main`** sem esperar o dono; o merge na `main` continua só com a liberação explícita do dono, PR a PR.
    - **Release do PDV (D70-Q2):** a sessão monta o instalador pelo Wine (OP-B3), confere e cria o GitHub Release
      `pdv-vX.Y.Z` (tag na `main`) com o `.exe` e o `.exe.sha256`, e pede a publicação na página de download pelo
      vigia. A atualização dos caixas nas lojas continua com o dono, um caixa de cada vez.
- **D71 = (A) — RESPONDIDA (25/11/2026):** "Sobre o D71, faça o que você recomenda". A sessão desliga o workflow
  "PDV release" pela API na hora do primeiro release sem o Actions e avisa o dono. Pergunta original: **desligar o workflow "PDV release" enquanto durar a D70?** A tag `pdv-vX.Y.Z` criada
  pela sessão (OP-B3, `publicar-release.sh`) é um push de tag e dispara o `pdv-release.yml` (`on: push: tags`).
  ★(A) **recomendada**: a sessão desliga só esse workflow pela API do GitHub (reversível: "Enable workflow" na aba
  Actions, ou a sessão religa quando a cota voltar) na hora do primeiro release sem o Actions, e avisa. (B) manter
  ligado e criar a tag mesmo assim (`--aceitar-disparo`): uma execução fica na fila ou falha sem cota, e se rodar
  pode tentar publicar no mesmo release. Padrão até a resposta: o `publicar-release.sh` recusa enquanto o workflow
  estiver ligado (README do PDV › decisão 93); nenhum release está previsto antes do PDV 0.14.0 (Fase 3).
  - **D70-Q3 — SEM RESPOSTA (24/11/2026; levantada na revisão do OP-B3): vale a recomendação (A), padrão até a
    confirmação do dono.** Quando a sessão cria a tag `pdv-vX.Y.Z` para o release (`publicar-release.sh`), o GitHub
    dispara sozinho o workflow "PDV release" (`pdv-release.yml`, que roda em todo push de tag `pdv-v*`; a tag criada
    com o login de uma pessoa conta como push). Sem cota, cada release deixa uma execução falhada no histórico público
    do Actions; com cota, o Windows monta outro instalador ao mesmo tempo, e o job do release dele falha ("já tem
    arquivos") ou, se o da sessão parou no meio, sobe os binários dele no rascunho. O que fazer?
    - **(A) recomendada:** desligar o workflow "PDV release" no GitHub enquanto durar a D70 (o arquivo continua no
      repositório, só fica "desabilitado"; um comando o liga de novo quando a cota voltar, junto com a volta do release
      pelo Windows). Desligado, a tag não dispara nada. Até a resposta, o `publicar-release.sh` confere o estado do
      workflow (só leitura) e **recusa** criar a tag com ele ligado; `--aceitar-disparo` cria assim mesmo, com o aviso.
      Com a resposta (A), a sessão o desliga uma vez (comando no README do PDV › decisão 93).
    - (B) aceitar a execução disparada como esperada: o script só avisa, e cada release deixa uma execução vermelha do
      "PDV release" no histórico público.
    - (C) cancelar pela API a execução disparada logo depois de criar a tag: ela fica no histórico como cancelada e,
      com cota, pode já ter começado.
  - **Servidor da Oracle oferecido pelo dono (24/11/2026; ARM Ampere, 2 CPU, 12 GB):** não usado agora, pela
    recomendação: a sessão já roda todos os testes de Linux; ele é ARM (as imagens da produção x86 não sairiam dele
    sem montagem cruzada) e não roda os testes que só o Windows cobre; dar acesso a ele exigiria uma credencial nova
    na sessão. Fica como opção para um ambiente de homologação na Fase 3.
- **D119 = (A) — RESPONDIDA (25/11/2026):** "Opção A (recomendada)". A rede da sessão recusa escrita no caminho
  `git/refs` da API do GitHub (HTTP 403 do proxy da sessão; criar e juntar PR continua funcionando), então a sessão
  não cria a tag `implantar/…` do OP-B4. Decisão: o vigia passa a implantar **sozinho cada commit novo da `main`**
  (cada merge que o dono libera vale também como "pode implantar"), **uma vez por commit**, **fora das 17h à
  meia-noite** (horário de Brasília; o merge nesse horário é implantado depois da meia-noite), e publica na página de
  download o PDV do release mais novo quando ele for diferente do que a página serve. A tag continua valendo como
  pedido manual do dono (forçar ou voltar uma versão). Bloco OP-B7.
- **D120 — release do PDV sem a sessão escrever no GitHub (25/11/2026, "Faça o que você recomendar"):** pela mesma
  recusa da rede da sessão, o `publicar-release.sh` não cria o release daqui. Recomendação seguida: a sessão gera e
  confere o instalador (OP-B3) e manda os dois arquivos (`.exe` e `.exe.sha256`) ao dono; o dono cria o release
  `pdv-vX.Y.Z` pelo site do GitHub (Releases › Draft a new release, tag nova na `main`) com o passo a passo da sessão,
  e, antes, desliga o workflow "PDV release" pela aba Actions (a D71, feita pelo dono porque a sessão também não
  consegue). O vigia publica o release na página de download (D119). Bloco OP-B8.

## Fase 3 — perguntas F3-Q1 a F3-Q48 (25/11/2026)

- **RESPONDIDAS (25/11/2026):** "Sobre as perguntas, faça tudo pelo que você recomendou." Todas seguem a recomendação
  (★) do `docs/planos/fase3-plano.md` › Perguntas ao dono; o texto completo de cada uma (opções e o efeito na loja) está
  lá. Numeração: **D72 a D118**, na ordem das perguntas; a F3-Q27 fecha a **D15** (já aberta). A **D66** (arquivos
  reais do Nuvem3) continua aberta, com a recomendação dela valendo (citada na F3-Q1).

- **D72 (F3-Q1) = (B)** — A loja usa balança? Qual modelo?
  - Fazer já a etiqueta de balança (código que começa com 2, impresso pela balança do açougue/petiscaria) e o peso digitado com permissão, e deixar a balança ligada no caixa para quando o dono disser o modelo.
- **D73 (F3-Q2) = (A)** — No Nuvem3, o preço de atacado vale por quantidade, por escolha do operador ("Tipo de preço", F8) ou pelos dois? (PDV 35, item 3)
  - Os dois, como na especificação: o atacado por quantidade (já existe) continua, e o F8 troca a venda inteira para atacado com `pdv.venda.tipo_preco_atacado` ou liberação.
- **D74 (F3-Q3) = (A)** — O preço parcelado (preço maior quando o cliente parcela no cartão) é usado?
  - Fazer como na especificação; produto sem "Preço parcelado" cadastrado não muda nada.
- **D75 (F3-Q4) = (A)** — Complemento repetido (2× o mesmo molho)
  - Cada opção 0 ou 1 vez por unidade do item; o "máximo" do grupo conta opções.
- **D76 (F3-Q5) = (A)** — Lote digitado que não está na lista do caixa
  - A nuvem procura o lote pelo código no produto, só entre os lotes com `estoque_id` nulo ou igual ao estoque da venda (regra da MD 3.6.9); achou, baixa esse lote; não achou, baixa pelo FEFO e guarda o texto do lote no item.
- **D77 (F3-Q6) = (B)** — A loja usa "Serviço avulso" (`Ctrl+S`: um item de serviço com descrição e preço digitados)?
  - Não agora: as lojas são obrigadas à NFC-e (D1); fica no backlog.
- **D78 (F3-Q7) = (A)** — Quais tipos de promoção primeiro?
  - "Leve 3 pague 2", % no item (com faixas por quantidade), preço fixo em horário (happy hour) e % por forma de pagamento (ex.: PIX à vista). O combo promocional depois.
- **D79 (F3-Q8) = (A)** — Duas promoções no mesmo item ("acumulativa")? O item da venda só guarda uma.
  - Uma promoção por item: vale a de maior desconto (a regra da PDV 11.4 sem `acumulativa`); a marca "acumulativa" fica guardada para depois.
- **D80 (F3-Q9) = (A)** — Desconto por forma de pagamento com pagamento misto (parte PIX, parte dinheiro)
  - Só quando a venda inteira é paga nas formas da promoção; ao lançar a forma, o caixa oferece "pagar tudo no PIX com 5%".
- **D81 (F3-Q10) = (A)** — **Confirmação da D28** ("não há vendedor nem comissão no balcão").
  - Mantém a D28: o recurso do vendedor fica pronto e **desligado** (`pdv.forca_escolha_vendedor` = Não; o F7 existe; a comissão só é calculada para quem tiver %); trocar o vendedor de venda já finalizada pelo ERP fica para a Fase 5, com o relatório de comissão.
- **D82 (F3-Q11) = (A)** — Cadastro rápido de cliente no caixa: CPF obrigatório?
  - Obrigatório para pessoa física: evita cliente duplicado e permite juntar automaticamente com o cadastro da nuvem (sem CPF, o operador usa só "nome na nota").
- **D83 (F3-Q12) = (A)** — O cliente criado no caixa tem o CPF de um cliente que já existe
  - A nuvem junta automaticamente (mantém o cadastro da nuvem, preenche só o que estava vazio e guarda o apelido); sem tela de mescla manual no ERP por ora.
- **D84 (F3-Q13) = (B)** — A Ice Beer **empresta cascos em comodato** a clientes identificados (PDV 35, item 4)? Se sim, quem pode emprestar e com que limite?
  - Empresta (ou pode vir a emprestar): o recurso fica pronto, desligado em `pdv.vasilhame_comodato` até o dono ligar; com permissão nova `pdv.vasilhame.comodato` e limite por cliente (`pdv.vasilhame_comodato_max_por_cliente`, ex.: 6 cascos); acima, o supervisor libera.
- **D85 (F3-Q14) = (A)** — Venda com cascos emprestados é cancelada: os cascos voltam?
  - Sim: o cancelamento devolve o empréstimo (os vazios voltam ao estoque e saem do saldo do cliente), como a D29 faz com os cascos trazidos; o caixa orienta recolher os cascos.
- **D86 (F3-Q15) = (A)** — O cliente devolve cascos que comprou e leva crédito em vale?
  - Sim, pelo preço atual do casco, com o mesmo teto e liberação da D38 (R$ 50,00 por operação sem supervisor).
- **D87 (F3-Q16) = (A)** — Prazo da troca e validade do vale
  - 30 dias para trocar (`pdv.dias_validade_cupom_troca`) e vale válido por 90 dias (`pdv.vale_compra_validade_dias`), os padrões atuais.
- **D88 (F3-Q17) = (A)** — Vale vencido com saldo
  - O saldo continua registrado e aparece no extrato; o caixa recusa o vale vencido, e o supervisor pode liberar (`pdv.troca.fora_prazo`); a nuvem não zera nada sozinha.
- **D89 (F3-Q18) = (A)** — O caixa pode aceitar vale sem internet?
  - Sim (`pdv.vale_exige_online` = Não): aceita o vale que o caixa conhece; se o mesmo vale for usado em dois caixas sem internet, o saldo fica negativo e o alerta aparece no Dashboard.
- **D90 (F3-Q19) = (A)** — Quais vales ficam guardados em cada caixa?
  - Os ativos e os que mudaram nos últimos 90 dias; o caixa apaga sozinho os que saíram da janela (vencidos ou zerados há mais de 90 dias); online, o caixa consulta qualquer vale.
- **D91 (F3-Q20) = (A)** — Devolução em dinheiro na troca (e o resgate do vale em dinheiro)
  - Só com `pdv.troca.devolver_dinheiro`, que nos perfis de sistema fica com o Administrador (o dono) e o Encarregado (PC-8); o operador pede a liberação, e hoje quem libera é o dono com o PIN.
- **D92 (F3-Q21) = (A)** — Troca sem a venda de origem (cliente sem cupom, ou o caixa offline e a venda de outro caixa)
  - Só com o supervisor (`pdv.troca.fora_prazo`), pelo preço de venda atual como teto, e só como vale (sem dinheiro); a mercadoria volta ao estoque pelo custo médio atual.
- **D93 (F3-Q22) = (A)** — Para onde vai o produto devolvido?
  - O operador escolhe "volta ao estoque" ou "avaria" (padrão "volta ao estoque"); drink ou porção feitos na loja (ficha técnica) nunca voltam ao estoque.
- **D94 (F3-Q23) = (A)** — Troca de uma venda feita em outra loja?
  - Sim, com internet (busca da venda na empresa toda, com os limites de privacidade do F3-B45); a mercadoria entra no estoque da loja que recebeu a troca.
- **D95 (F3-Q24) = (A)** — Cupom de troca (comprovante sem preços para o cliente trocar depois)
  - Só a pedido (Ctrl+Shift+T logo após a venda ou pela Gestão de vendas), com `pdv.imprime_cupom_troca` = Não.
- **D96 (F3-Q25) = (A)** — O código do vale (`VC` + loja + caixa + sequência + 1 dígito) é **previsível**: quem tem o vale ...80 pode tentar o ...81 de outro cliente, e sem internet o caixa aceita qualquer vale que conheça. Proteger?
  - Um código de conferência de 4 dígitos aleatórios impresso no vale (guardado só como resumo criptográfico); no uso, o leitor lê o código e o operador digita os 4 dígitos (chave `pdv.vale_exige_conferencia`, padrão Sim).
- **D97 (F3-Q26) = (A)** — Operações de vale **fora** da troca, no caixa (SYNC 9.17): emitir um vale avulso (ex.: crédito por reclamação), devolver o saldo do vale em dinheiro e cancelar um vale emitido errado na mesma sessão. A loja usa?
  - Sim, as três: o contrato na nuvem já sai no F3-B41; as permissões já existem (`pdv.vale.emitir`, `pdv.troca.devolver_dinheiro`, `pdv.troca.realizar`).
- **D15 (F3-Q27) = (A)** — O que fazem "Limite de Valor de Vendas PDV" e "Limite Venda em Aberto" (PDV 35, item 1)?
  - Como na especificação: venda acima do valor pede o supervisor ao concluir; o "em aberto" é o máximo de vendas suspensas por caixa. Vazio = sem limite; 0 no "em aberto" = não deixa suspender. Sugestão para a Ice Beer: valor vazio e 3 suspensas.
- **D98 (F3-Q28) = (A)** — Fechar o caixa com venda suspensa
  - Bloqueia e lista as suspensas para retomar ou cancelar (PDV 21.2).
- **D99 (F3-Q29) = (A)** — Preço da venda suspensa ao recuperar
  - Fica como estava (o que o cliente viu), como na venda recuperada depois de uma queda.
- **D100 (F3-Q30) = (A)** — Tabela de preços no caixa
  - Na tela e impressa na impressora do caixa, só a lista filtrada, com confirmação acima de 200 linhas.
- **D101 (F3-Q31) = (A)** — Foto do produto no caixa
  - Ligar `pdv.exibe_foto_produto` na Ice Beer, no painel do item e na consulta, só para produto com foto.
- **D102 (F3-Q32) = (A, se usam)** — Avaria e consumo interno são registrados no caixa hoje (no Nuvem3)? (ERP 23.2, questão 20)
  - Sim: as formas "Avarias" e "Baixas de utilização em loja" são ativadas, com liberação do supervisor e motivo; a baixa sai do estoque e não conta como venda.
- **D103 (F3-Q33) = (A)** — Como atualizar os caixas?
  - Velopack por usuário do Windows. A R3 (0.14.0, com as funções novas) sai ainda pelo instalador atual; depois, uma versão **sem nenhuma mudança de venda** (0.14.1) faz a passagem, com **uma** instalação manual em cada caixa, caixa por caixa; daí em diante as versões chegam sozinhas, sem senha de administrador, só com o caixa livre (no login ou depois do fechamento).
- **D104 (F3-Q34) = (A)** — Canal "beta" (versão de teste antes de todos)
  - O canal da empresa (já existe) mais uma exceção por terminal no ERP: a Ice Beer é uma empresa só, então sem a exceção o "beta" atualizaria todos os caixas; o beta vai primeiro ao caixa da loja Treino.
- **D105 (F3-Q35) = ((a) = (A); (b) = conferir o Smart App Control antes)** — Assinatura das atualizações e do instalador
  - (a) uma chave de assinatura própria das atualizações, gerada e guardada no PC do dono (nunca na VPS nem na sessão); a parte pública vai dentro do PDV e o caixa recusa pacote sem a assinatura certa. (b) Certificado Authenticode: **o dono confere antes** se algum PC de caixa tem o "Controle Inteligente de Aplicativos" (Smart App Control) ligado; se tiver, (A) comprar um certificado OV e assinar no PC do dono; se não tiver, (C) não comprar por ora, e o roadmap troca "instalador assinado" por "atualização com assinatura própria; Authenticode quando houver Smart App Control". **Pendente (dono):** a conferência nos caixas.
- **D106 (F3-Q36) = (A)** — O servidor da Oracle (ARM Ampere, 2 CPU, 12 GB) que o dono ofereceu de novo ("quer testar por lá?"). A D70 já o deixou "como opção de homologação na Fase 3"; a pergunta agora é **como**.
  - Usar como **homologação**, operado por **roteiros que o dono cola no terminal do servidor** (como o OP-B2): um roteiro monta o ambiente (API, ERP e PostgreSQL 18 com dados inventados, TLS e um nome separado, ex.: `homolog.<domínio>`), outro busca o branch e roda os checks, a carga do F3-B66 e o teste de dois caixas do F3-B70 e imprime **só a tabela de resultado**, que o dono cola no chat. A sessão **nunca** recebe chave nem senha.
- **D107 (F3-Q37) = (B)** — A preparação administrativa da fase fiscal (credenciamento da NFC-e na SEFAZ-PR, CSC, certificado A1 de cada loja, conversa com o contador). O roadmap manda começar "durante a Fase 3", mas a ordem do dono põe a 3F depois das Fases 4 e 5.
  - Começar no início da Fase 5: o certificado A1 vale 1 ano e comprar agora desperdiça a validade; o credenciamento e o CSC levam poucas semanas. Agora, só a conversa com o contador sobre as dúvidas da PDV 35, itens 4 e 6, sem compromisso.
- **D108 (F3-Q38) = (A)** — Para que a venda feita no ERP vai servir antes da fase fiscal?
  - Venda a bares e clientes a prazo e lançar venda esquecida, **sem documento fiscal**, com o aviso fixo "Sem documento fiscal: emita a nota no Nuvem3 até a fase fiscal" e o filtro "Documento fiscal: Sem documento" da listagem (ERP 15.4.1).
- **D109 (F3-Q39) = (A)** — A venda do ERP pode deixar o estoque negativo?
  - Segue `vendas.valida_estoque` (padrão Não), como a D27 decidiu para o caixa ("a loja nunca trava a venda por falta de estoque"), com o alerta `ESTOQUE_NEGATIVO`.
- **D110 (F3-Q40) = (A)** — A venda do ERP aplica as promoções automáticas do caixa?
  - Não: preço da loja, quantidade, mix e atacado; promoção vira desconto manual.
- **D111 (F3-Q41) = (A)** — Antes do financeiro (Fase 4), o que a venda do ERP grava do pagamento?
  - Pagamentos e parcelas gravados, sem contas a receber; a Fase 4 gera as contas das vendas antigas.
- **D112 (F3-Q42) = (A)** — Cancelar pelo ERP uma venda do caixa cuja sessão **ainda está aberta**
  - Bloquear com "cancele no caixa": o dinheiro está na gaveta e o fechamento ficaria errado.
- **D113 (F3-Q43) = (A)** — Venda de **caixa já fechado** cancelada no ERP: como registrar a devolução ao cliente?
  - Escolher a forma (dinheiro do cofre, estorno no cartão ou PIX, ou vale), só registrada até a Fase 4; o vale vira vale de verdade quando os vales entrarem.
- **D114 (F3-Q44) = (A)** — Conferência do fechamento: tolerância e correção (PDV 35, item 7).
  - "Conferida" quando a diferença de cada forma está dentro de `pdv.tolerancia_diferenca_caixa`, senão "Divergente"; quem tem `fechamentos_caixa.conferir` pode refazer, com auditoria. **Atenção:** o padrão é R$ 0,00, e aí qualquer centavo deixa a sessão "Divergente"; se o dono preferir, informar outro valor (ex.: R$ 0,05).
- **D115 (F3-Q45) = (A)** — Devolução no ERP com "dinheiro" antes da Fase 4
  - Registrada como "devolvido em dinheiro" (informativo, sem saída de conta).
- **D116 (F3-Q46) = (A)** — Orçamentos: até onde ir?
  - Orçamento no ERP com impressão/PDF pelo navegador, importado no caixa (F9 ou "ORC" + código) e criado no caixa; sem e-mail e sem link público por ora (o texto se copia para o WhatsApp à mão).
- **D117 (F3-Q47) = (A)** — Pré-venda (o atendente monta a venda num computador e o caixa recebe pelo código)
  - Não agora (depende de um terminal "utilitário" na loja e de internet entre os terminais); sai do roadmap da Fase 3 e vai para o backlog.
- **D118 (F3-Q48) = (A)** — Orçamento criado **no caixa sem internet**: o número do orçamento (`ORC00321`) é dado pela nuvem só quando o caixa sobe o orçamento (SYNC 9.19), então a impressão feita offline sairia sem número.
  - "Salvar como orçamento" só com internet: o caixa sobe na hora e imprime com o número; offline, a tecla avisa "requer conexão".
