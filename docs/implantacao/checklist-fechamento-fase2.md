# Checklist do fechamento da Fase 2: a execução real na loja piloto

Passo a passo para o dono (com o encarregado do estoque) **provar na loja de verdade** que o GenesisPDV virou o
controle oficial de estoque da Ice Beer. É o último passo da Fase 2 (bloco F2-B53 do plano): o código está pronto, e
o que falta é usá-lo com os dados reais e anotar o resultado. Enquanto este checklist não estiver feito e anotado, a
**Definição de pronto da Fase 2** (`docs/roadmap.md`, Fase 2) continua aberta.

> **Nada fiscal aqui.** A NFC-e de cada venda continua saindo pelo Nuvem3 (D42), e a NF-e de fornecedor entra só
> pelo **arquivo XML** (sem consultar a SEFAZ e sem certificado digital: isso é da fase fiscal, 3F). Os termos são os
> das telas; "(D46)", "(D47)" etc. são as decisões do roadmap (`docs/roadmap.md`, seção 16).

**Quem faz:** o dono (Master) ou quem ele indicar, pelo ERP no navegador; o passo 7 é na VPS, pelo terminal (o
mesmo jeito da Implantação). **Quanto tempo:** os passos 1 e 2 cabem num dia (de preferência com a loja fechada ou
fora do pico); os passos 3 a 6 se espalham pelas semanas seguintes, com a loja aberta; o passo 7 leva poucos minutos.

## Onde anotar o resultado

O repositório é **público** (D60): **não** escreva aqui nem no `docs/andamento.md` nenhum dado real (nome de
fornecedor, número ou chave de nota, CNPJ, valores, nomes de produtos, quantidades da loja). Anote só **a data, se
deu certo e uma observação genérica**. O jeito mais simples: ao terminar cada passo, mande na conversa com o Claude
Code uma frase como "passo 4 feito em 20/11, o vínculo veio sugerido na segunda nota" — a sessão preenche a tabela
do fim deste arquivo e o `docs/andamento.md`. Guarde os detalhes (prints, planilhas, relatórios) com você, fora do
repositório.

---

## 0. Antes de começar

- [ ] **Versão nova no ar.** A Implantação da `main` com os PRs 11, 13 e 14 (o último da Fase 2) feita e a saúde
      verde em https://erp.grupoicebeer.com.br/saude.
- [ ] **Caixas atualizados** para o PDV **0.12.0**, um de cada vez (roteiro em `docs/andamento.md` › Próximo passo,
      item 3b, passo 5). Na Central do PDV › Sincronização, todos os fluxos "em dia".
- [ ] **Backup recente** da produção (`infra/producao/README.md` › Backup). Nada deste checklist apaga dados, mas a
      carga mexe em todo o estoque de uma vez.
- [ ] **Permissões** de quem vai executar (Cadastros › Usuários; o Master já tem todas): Acertos de estoque (Ver,
      Criar), Produtos (Importar, Exportar, **Criar**, **Editar**, Ver custo), Marcas (**Criar**) e Categorias
      (**Editar**) — sem Criar e Editar de Produtos, as linhas da importação viram "ignorar"; sem as de Marcas e
      Categorias, as marcas e categorias novas da planilha não são criadas —, Pessoas (**Importar**, **Criar**,
      **Editar**) se os clientes forem importados, NF-e de entrada (Ver, Importar XML, Movimentar estoque),
      Transferências (Ver, Criar, Enviar, Receber), os relatórios Estoque Atual e Movimentação com a de Exportar e, em
      **Estoques permitidos**, o CD e as lojas que vai mexer (liberar a loja não libera o CD; D45). Mais simples:
      os passos 1 e 2 (importação e carga) feitos pelo **Master**.
- [ ] **Configurações** (Cadastros › Configurações › Geral):
  - Estoque › **Permitir saldo negativo em documentos do ERP**: ligado durante a carga (a exportação do Nuvem3
    traz saldo negativo; sem a chave, e sem ser Master, o negativo vira aviso e não entra);
  - Estoque › **Conferência: tolerância total (%)** = 1 e **por item (%)** = 5 (D47);
  - Geral › **Produto usa fornecedores**: ligado (é o bloco do produto que mostra o vínculo aprendido da NF-e);
  - Estoque › **Transferência com recebimento automático**: desligado (a Ice Beer usa as duas etapas: o CD envia e a
    loja confere e recebe; D62).
- [ ] **Escolher a loja piloto** desta conferência (Loja 1 ou Petiscaria 2) e anotar qual foi.

## 1. Importação completa (produtos e clientes)

**O que fazer:** seguir o [`roteiro-inventario.md`](roteiro-inventario.md), seção 2, passo 1 — Produtos › Importação
com a planilha de produtos exportada do Nuvem3, **sem** marcar "Atualizar estoque" (o saldo entra no passo 2). Os
clientes, se forem entrar agora, por Pessoas › Importação de clientes.

**O que conferir:**
- [ ] A prévia sai **sem erro** (reimporte, corrigindo a planilha, até sair limpa) e o resultado final não traz
      linha com falha.
- [ ] A quantidade de produtos em Produtos (filtro "Todos") bate com a quantidade de linhas da planilha.
- [ ] Abrir 5 produtos ao acaso (um fardo, um a granel ou por kg, um combo, um com casco e um comum) e conferir
      preço, embalagens com fator, código de barras e categoria.
- [ ] **Ida e volta** (o critério que ficou pendente do F2-B40): em Produtos › Exportação, exportar o catálogo
      inteiro com a **loja piloto** (ou com "Todas", que não traz as colunas da loja); em Produtos › Importação,
      escolher a **mesma loja piloto**, **sem** marcar "Atualizar estoque", mandar **esse mesmo arquivo** e só
      **pré-visualizar** (não confirmar): todas as linhas devem sair "**Sem alteração**". (Exportar com uma loja e
      importar escolhendo outra faz o "Preço da loja" aparecer como mudança sem defeito nenhum: o preço é o de cada
      loja.) Se alguma sair "Atualizar", anote quantas e qual coluna aparece em "O
      que muda" (sem o nome do produto) e avise a sessão.
- [ ] Relatórios › Produtos › **EAN duplicado**: anotar quantos códigos aparecem. Quando zerar, voltar
      Configurações › Geral › **EAN duplicado** para **Bloquear** (padrão do plano).

## 2. Carga do Nuvem3 com a hora (a virada do saldo)

**O que fazer:** [`roteiro-inventario.md`](roteiro-inventario.md), seção 3: no Nuvem3, exportar a planilha com o
estoque atual de cada estoque (cada loja e o CD), **anotando a hora da exportação**, e importar no Genesis com
"Atualizar estoque", o estoque certo (para o CD, "CD - Estoque Ice Beer (sem loja)") e a **Data/hora da contagem** =
a hora da exportação. Os cascos vazios entram por um "Definir" próprio no tipo **Vasilhame vazio** (seção 1, item 3
do roteiro).

**O que conferir:**
- [ ] O resultado de cada importação traz o link do acerto **"Definir"** (origem Importação), já **efetivado**, com a
      hora da exportação. Acima de 5.000 produtos são vários acertos com a mesma hora: todos efetivados.
- [ ] Relatórios › Estoque › **Estoque Atual**, por estoque: escolher 10 produtos (incluindo um com saldo negativo
      no Nuvem3, se houver) e comparar com o Nuvem3 na hora da exportação. O que foi vendido **depois** dessa hora
      já aparece descontado (é o esperado).
- [ ] O saldo do caixa: na pesquisa F2 do PDV da loja piloto, os mesmos produtos mostram o saldo novo (estimado)
      depois do próximo ciclo de sincronização.

## 3. Contagens por setor (D46)

**O que fazer:** [`roteiro-inventario.md`](roteiro-inventario.md), seção 4: nas semanas seguintes, com a loja
aberta, um acerto **"Definir"** por setor (Estoque › Acerto de Estoque › Novo), com a **Data** = a hora em que o
setor foi contado, a folha de contagem impressa (cega) e o **Importar contagem** do coletor ou a digitação na grade.

**O que conferir:**
- [ ] Cada setor contado tem o seu "Definir" efetivado.
- [ ] A aba **Compensações** de cada acerto: se aparecer linha com o relógio do caixa destacado como suspeito,
      conferir a data e a hora daquele computador e avisar a sessão.
- [ ] **Teste do caixa sem internet (opcional, mas é a prova de um item da Definição de pronto):** durante a contagem
      de um setor pequeno, tirar o cabo de rede de **um** caixa da loja piloto e continuar vendendo normalmente (o
      caixa vende offline). Anotar a hora da contagem do setor, vender alguns itens desse setor **antes** e **depois**
      dessa hora, efetivar o "Definir" ainda com o caixa sem cabo, e só então recolocar o cabo. Depois que o caixa
      sincronizar: o saldo do item deve ficar **igual à contagem menos o que foi vendido depois da hora da contagem**
      (as vendas de antes já estavam fora da prateleira e não contam duas vezes). A aba Compensações mostra as vendas
      compensadas.

## 4. Primeiras NF-e reais: fornecedores e vínculos

**O que fazer:** em Estoque › **Recebimento de NFe**, botão **Importar NF**, arrastar o XML de uma nota real de
fornecedor de bebidas (o arquivo que o fornecedor manda por e-mail). A tela avisa sempre que **a SEFAZ não foi
consultada** (cancelamento e denegação não são conferidos nesta fase). Abrir a nota, aba **Itens e vinculação**:
ligar cada item ao produto do Genesis e **confirmar o fator** (ex.: o fardo de 12 = fator 12). Com todos os itens
ligados (ou ignorados com motivo), a nota fica "Pronta": **Movimentar**.

**O que conferir:**
- [ ] O **fornecedor** foi criado sozinho pelo CNPJ do emitente (Cadastros › Pessoas), sem duplicar se já existia.
- [ ] A **entrada no estoque certo** (o estoque de destino escolhido na nota) e na **quantidade em unidades** (a
      quantidade da nota × o fator): conferir no Estoque Atual.
- [ ] O **custo**: no bloco Estoque do produto (ou na Movimentação), o custo por unidade deve ser o da conta à mão —
      valor do item na nota, **menos o desconto do item** (na DANFE, a coluna de desconto, separada do valor), mais a
      parte do ICMS-ST, FCP-ST, IPI, frete, seguro e outras despesas, tudo dividido pela quantidade em unidades (a
      quantidade da nota × o fator). O padrão D49 inclui todos esses acréscimos e não desconta créditos. Conferir em 2
      ou 3 itens, de preferência um fardo com ST e um com desconto.
- [ ] **O vínculo reaproveitado na nota seguinte:** importar uma **segunda nota do mesmo fornecedor** com algum
      produto repetido. Na aba Itens e vinculação, esses itens já devem vir sugeridos com a origem "**Vínculo
      anterior**" e o mesmo fator — é só conferir e movimentar.
- [ ] No produto, bloco **Fornecedores**: o código do produto no fornecedor e o fator aparecem ligados.
- [ ] (Para quem desenvolve, opcional) os mesmos XMLs reais podem rodar no teste local da API, pondo-os em
      `apps/api/test/fixtures/nfe/reais/` **só na máquina de quem testa** (a pasta está no `.gitignore`; nunca no
      repositório).

## 5. Primeira transferência CD → loja (com divergência)

**O que fazer:** em Estoque › **Transferência de estoque**, criar a transferência do **CD** para a **loja piloto**
(a sugestão de reposição ajuda a montar), **Salvar e enviar** e imprimir o romaneio. Na loja, quem recebe abre a
transferência, confere a mercadoria e informa o **recebido** de cada item.

Para provar o item da Definição de pronto **"com divergência"** sem perder mercadoria: escolha um item barato e
mande fisicamente **uma unidade a menos** do que está no romaneio (ela fica no CD). Na loja, informe o recebido real
(uma a menos). A diferença aparece como **"A tratar"**: trate-a com **Retornar à origem** (a unidade volta ao saldo
do CD, onde ela de fato ficou). Se houver uma perda de verdade (garrafa quebrada), use **Baixar como perda** nesse
item (D51).

**O que conferir:**
- [ ] No **CD**: saiu o enviado e voltou a diferença (o saldo do CD fica com a unidade que não foi).
- [ ] Na **loja**: entrou exatamente o recebido.
- [ ] Estoque Atual sem nada em **"Em trânsito"** nem em **"Divergência a tratar"** para essa transferência.
- [ ] Relatórios › Estoque › **Movimentação** (o CD e a loja, o dia da transferência): a saída no CD, a entrada na
      loja e o retorno, com o mesmo custo.
- [ ] No caixa da loja piloto, a pesquisa F2 mostra o saldo novo depois do ciclo de sincronização.
- [ ] **Aviso fiscal (D6):** o CD e as lojas têm CNPJs diferentes. Até a fase fiscal, a NF-e de transferência sai
      **por fora** (Nuvem3 ou contador); anote o número dela no campo da NF-e da própria transferência.

## 6. Conferência com a tolerância (D47)

**O que fazer:** abrir a aba **Conferência** de cada "Definir" das contagens por setor do passo 3 (na loja piloto).

**O que conferir:**
- [ ] Cada contagem mostra o veredito **Conferido**: a soma das diferenças a custo até **1%** do valor contado e
      nenhum item acima de **5%** do próprio saldo (a sobra de um item não paga a falta de outro).
- [ ] Os setores contados cobrem o estoque inteiro da loja piloto.
- [ ] Se algum sair **Fora da tolerância**: recontar os itens destacados (os primeiros da lista), fazer um "Definir"
      novo só com eles e conferir de novo. Anotar quantas recontagens foram precisas.

## 7. `db:recalcular-saldos` em produção, sem divergência

O comando refaz, a partir de todos os movimentos gravados (o "razão"), o saldo de cada produto em cada estoque e
compara com o saldo que o sistema mantém no dia a dia. "Idêntico" prova que o saldo mostrado é exatamente a soma do
que aconteceu. **Sem `--corrigir` ele não altera saldo nem movimento.** A única coisa que ele grava, e só quando dá
idêntico, é marcar como resolvido o alerta de saldo divergente que estiver aberto (o alerta deixou de valer).

**O que fazer:** depois dos passos 1 a 6, fora do horário de pico, na VPS (o mesmo acesso da Implantação):

```bash
/opt/genesis/implantar.sh tarefa recalcular-saldos --empresa=<código da empresa>
```

(o `<código da empresa>` é o número de 6 dígitos usado no login do ERP).

**O que conferir:**
- [ ] A saída traz a linha `<código>: idêntico (...)`. Duas linhas podem vir logo depois dela:
  - `<código>: alerta de saldo divergente do razão resolvido` — é **normal** (o alerta antigo foi fechado);
  - `aviso: N linha(s) com a projeção certa e o razão inconsistente ...` — o saldo está certo, mas há algo no
    histórico a olhar: **não** trava o fechamento; avise a sessão, dizendo só o número N.
- [ ] Se aparecer qualquer linha divergente: **não** rode com `--corrigir` por conta própria. Guarde a saída (fora do
      repositório) e avise a sessão, dizendo só quantas linhas divergiram; a correção é decidida junto.

## 8. Movimentação de 12 meses (conferência rápida)

A velocidade com 12 meses foi medida no teste de carga (4 milhões de movimentos: cada página em menos de 0,2 s; a
exportação dos 12 meses de uma loja em tarefa de segundo plano). Na produção ainda não há 12 meses de Genesis; basta
conferir que funciona:

- [ ] Relatórios › Estoque › **Movimentação**, a loja piloto, período dos últimos 12 meses: a primeira página abre em
      menos de 5 s, e a próxima também.
- [ ] **Exportar** (Excel): baixa na hora (até 50 mil linhas) ou vira uma **tarefa** no ícone Tarefas do cabeçalho,
      com o link quando terminar.

## Depois do checklist

1. A sessão do Claude Code marca a **Definição de pronto da Fase 2** no `docs/roadmap.md` com as datas anotadas e
   fecha a fase no `docs/andamento.md`.
2. **Auditoria completa de segurança (D64)**, antes de levar o sistema às outras lojas: o dono instala o plugin
   oficial `claude-security` (catálogo da Anthropic) e, como segunda opinião, a skill
   `cloudflare/security-audit-skill`; a sessão roda as duas e corrige o que for confirmado.
3. Só então as demais lojas e o CD entram, uma de cada vez (`docs/roadmap.md` › 15.1).

## Registro da execução

Preenchido pela sessão com o que o dono informar (só data, resultado e observação genérica, sem dado real).

| Passo | Data | Resultado | Observação |
|---|---|---|---|
| 0. Antes de começar | — | pendente | — |
| 1. Importação completa (e a ida e volta) | — | pendente | — |
| 2. Carga do Nuvem3 com a hora | — | pendente | — |
| 3. Contagens por setor (e o caixa sem internet) | — | pendente | — |
| 4. Primeiras NF-e reais e o vínculo reaproveitado | — | pendente | — |
| 5. Transferência CD → loja com divergência | — | pendente | — |
| 6. Conferência com a tolerância | — | pendente | — |
| 7. `db:recalcular-saldos` em produção | — | pendente | — |
| 8. Movimentação de 12 meses | — | pendente | — |
