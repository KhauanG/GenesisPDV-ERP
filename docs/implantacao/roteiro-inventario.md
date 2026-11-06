# Roteiro do inventário: a carga do Nuvem3 e as contagens

Passo a passo para o dono (ou o encarregado do estoque) colocar o saldo de estoque no GenesisPDV e conferi-lo, nas 3
lojas, no CD e na loja Treino. É a decisão **D46** (F2-Q5 (c), dono, 04/11/2026): o saldo inicial entra pela
**exportação de saldos do Nuvem3 na virada**, e nas semanas seguintes as **contagens por setor** corrigem aos poucos,
com a loja aberta. A conferência usa a tolerância **D47** (decidida pelo dono em 05/11/2026: 1% no total e 5% por
item, ajustável em Configurações › Geral › Estoque e, por loja, em Lojas › Parâmetros). Tudo pelo ERP (navegador); nada fiscal.

> Os termos são os das telas. "(D46)", "(D47)" etc. são as decisões do roadmap (`docs/roadmap.md`, seção 16). O
> roteiro do caixa (cadastros, PDV, dia D) é o [`roteiro-piloto.md`](roteiro-piloto.md).

---

## 1. Antes de começar: os estoques e quem mexe neles

| Estoque | O que é | O que entra |
|---|---|---|
| **Loja 1**, **Petiscaria 2** (e a terceira loja, quando entrar) | o estoque de cada loja (criado com a loja) | carga do Nuvem3 da loja e as contagens por setor |
| **CD - Estoque Ice Beer** | estoque **sem loja**, tipo Depósito (CD); com CNPJ próprio, é cadastrado como loja do tipo "depósito" (D6) | carga do Nuvem3 do CD e as contagens do CD |
| **Treino** | o estoque da loja de treino (D39) | nada do Nuvem3: só o que o treino precisar, à mão. Fica fora das consultas por padrão |

1. **Cadastros › Usuários**: quem carrega e conta precisa de **Acertos de estoque: Criar** e do estoque em
   **Estoques permitidos** (o CD inclusive: liberar a loja não libera o CD, decisão 149 / D45). O Master vê todos.
2. **Cadastros › Configurações › Geral › Estoque**: confira **Permitir saldo negativo em documentos do ERP**. A
   exportação do Nuvem3 traz saldo negativo; sem a chave (ou sem ser Master) o negativo **não** é lançado e vira aviso.
   Ali também ficam as **tolerâncias da conferência** (total 1%, por item 5%; dá para mudar por loja).
3. **Cascos**: o saldo de **vasilhame vazio** (os cascos devolvidos) não é "Disponível": vai para o tipo de estoque
   **Vasilhame vazio**, que não é vendável. A planilha do Nuvem3 carrega só o tipo padrão (Disponível); os cascos
   vazios entram por um acerto **Definir** com o tipo **Vasilhame vazio** (Estoque › Acerto de Estoque › Novo, ou o
   **Importar contagem** nesse acerto). O casco cheio (a bebida) continua no Disponível.
4. **Combo (kit) e produzido ficam de fora**: não têm saldo próprio (a venda baixa os componentes e os insumos da
   ficha técnica). A planilha ignora a coluna de estoque deles, e a contagem os recusa. Conte os componentes e os
   insumos.

## 2. A ordem da virada

1. **Importação completa de produtos** (Produtos › Importação), **sem** "Atualizar estoque": cadastros, preços,
   marcas e categorias. Reimporte até a prévia sair sem erro (o relatório de inconsistências mostra o que falta).
2. **Carga do Nuvem3** (o saldo de cada estoque), um arquivo por estoque, como na seção 3.
3. **Contagens por setor** nas semanas seguintes, com a loja aberta (seção 4), cada uma conferida pela aba
   **Conferência** (seção 5).

## 3. Carga do Nuvem3 (a virada)

1. No Nuvem3, exporte a planilha de produtos com o **estoque atual** do estoque que vai carregar. **Anote a hora da
   exportação**: é a hora da contagem. O que for vendido depois dela, no Nuvem3 ou no Genesis, é descontado.
2. **Produtos › Importação**:
   - **Loja**: a loja do estoque (preço da loja e estoque mínimo). Para o **CD**, a loja é opcional;
   - marque **Atualizar estoque**;
   - **Estoque que recebe a contagem**: vazio = o estoque da loja; para o CD, escolha **CD - Estoque Ice Beer (sem
     loja)**;
   - **Data/hora da contagem**: a hora da exportação (os atalhos "Agora", "Hoje, 07:00 (antes de abrir)" e "Ontem,
     23:00 (depois de fechar)" ajudam; a data e a hora são editáveis);
   - **Pré-visualizar**. A coluna "O que muda" mostra "Estoque atual: X → Y", com X = o saldo do Genesis **na hora da
     contagem** (o de agora menos o que entrou e saiu depois dela).
3. **Confirmar importação**. No fim, o resultado traz o link do **acerto "Definir"** (origem Importação). Acima de
   **5.000 produtos** a contagem vira **vários acertos** com a mesma hora (o resultado lista todos), efetivados um a
   um: se um deles falhar, a tarefa diz quais já ficaram efetivados (confira ou estorne em Estoques › Acertos e
   importe de novo).
4. O acerto leva **todos os produtos contados**, inclusive os que já estavam certos (com diferença zero): a contagem
   também os viu, e a venda offline anterior a ela que chegar depois é compensada para eles também.

## 4. Contagens por setor (as semanas seguintes)

1. **Estoque › Acerto de Estoque › Novo**: estoque, tipo **Disponível**, tipo de ajuste **Definir**, **Data** = a hora
   em que o setor foi contado, motivo **Inventário**. Salve o rascunho.
2. **Imprimir** a folha de contagem (cega, por localização, filtrada pela marca ou categoria do setor), contar, e
   **Importar contagem** com o arquivo do coletor (`código;quantidade`; o fardo conta o fator do código de barras).
   Ou digite os itens na grade.
3. Antes de **Efetivar**, leia o aviso de PDVs offline: as vendas que ainda não chegaram serão compensadas sozinhas
   (ERP 13.1.5), desde que o relógio do caixa esteja certo (aba **Compensações**, depois de efetivar).
4. Conte com a loja aberta: o que for vendido **depois** da hora da contagem é descontado na efetivação; o que foi
   vendido **antes** já estava fora da prateleira e não é contado duas vezes.

## 5. Conferência (aba "Conferência" do acerto)

O "Definir" tem a aba **Conferência**: por item, o **contado**, o **saldo do sistema na hora da contagem** e a
**diferença**, em percentual do saldo e a custo, com o veredito:

- **Conferido**: a soma das diferenças a custo (a sobra de um item **não** paga a falta de outro) fica até **1%** do
  valor contado a custo **e** nenhum item passa de **5%** do próprio saldo no sistema;
- **Fora da tolerância**: recontar os itens destacados (os primeiros da lista) antes de dar o estoque como conferido.
  O item com saldo zero no sistema e contado diferente de zero não tem percentual e fica fora.

No rascunho a aba é uma **estimativa** (o saldo de agora); depois de efetivar, a venda offline anterior à contagem que
chegou depois entra no saldo do sistema (a linha diz quanto foi compensado). Os campos **Tolerância total** e
**Tolerância por item** trocam os limites só para a consulta. Sem **Ver custo**, a aba mostra só os percentuais e o
veredito.

A loja piloto é dada como conferida (Definição de pronto da Fase 2) quando as contagens por setor cobrem o estoque e
cada uma sai **Conferido**.

## 6. Checklist

- [ ] Usuários com "Acertos de estoque: Criar" e os estoques permitidos (o CD inclusive)
- [ ] "Permitir saldo negativo em documentos do ERP" conferido; tolerâncias da conferência (1% e 5%) conferidas
- [ ] Importação completa de produtos sem erro (sem "Atualizar estoque")
- [ ] Carga do Nuvem3 de cada loja com a hora da exportação
- [ ] Carga do Nuvem3 do CD (estoque sem loja) com a hora da exportação
- [ ] Cascos vazios no tipo Vasilhame vazio (acerto Definir próprio)
- [ ] Combo e produzido fora da contagem (conte os componentes e os insumos)
- [ ] Contagens por setor efetivadas, cada uma **Conferido** na aba Conferência
