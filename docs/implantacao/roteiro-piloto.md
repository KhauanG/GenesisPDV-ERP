# Roteiro do piloto do GenesisPDV na Ice Beer

Passo a passo para o dono colocar um caixa do GenesisPDV para funcionar numa loja, em paralelo com o Nuvem3, sem
terminal: tudo pelo ERP (navegador) e pelo próprio caixa. Vale para o **piloto assistido** (roadmap, seção 15.1): pela
decisão do dono (D42), o **Genesis é o caixa principal** da loja do piloto e a **NFC-e é emitida no Nuvem3** (o Genesis
não emite nada fiscal até a Fase 3F). Veja a seção 5.

O que você vai usar:

- **ERP**: `https://erp.grupoicebeer.com.br` (o endereço que a implantação da VPS definiu), com o usuário `admin`.
- **Instalador do caixa**: `GenesisPDV-Setup-X.Y.Z.exe` (README do PDV › [Instalar na loja](../../apps/pdv/README.md#instalar-na-loja)).
- **Planilha de produtos do Nuvem3** (a "edição em massa" exportada no dia).
- **Prontidão da loja**, no ERP em **Cadastros › Implantação › Prontidão da loja**: a lista do que ainda falta para a
  loja vender. Cada linha tem um ícone (verde = ok, amarelo = aviso, vermelho = falta) e o link **Resolver**, que abre a
  tela certa. **Vermelho impede o caixa; amarelo não impede, mas leia.** Use **Só o que falta resolver** para ver só
  o que tem pendência e **Conferir de novo** depois de cada ajuste.

> Os termos deste roteiro são os das telas. Quando aparecer "(O9b)", "(D38)" etc., é a decisão do dono registrada no
> roadmap (`docs/roadmap.md`, seção 16), só para consulta.

---

## 1. Dois dias antes (D-2): a nuvem e os cadastros

### 1.1 Servidor no ar

A instalação da VPS (Hostinger) e do banco (Cloud SQL) é feita pelos passos 2 a 8 de
[`infra/producao/README.md`](../../infra/producao/README.md) (vem no PR da infraestrutura, `infra/producao`). No fim
dele, o monitoramento pelo Hermes mostra o `GET /api/saude/detalhada` com `status: ok` e o backup diário configurado.

### 1.2 Empresa

1. No **painel da plataforma**, crie a empresa (Ice Beer) e anote o **código da empresa** e a senha provisória do
   `admin` (aparece uma vez só).
2. Entre no ERP com o código, `admin` e a senha provisória; troque a senha.
3. **Cadastros › Empresa**: confira razão social, CNPJ e endereço.
4. **Cadastros › Configurações › Geral**: deixe **Ativa** ligada ("Não" = modo implantação: o caixa não abre) e
   confira a **Hora de corte do dia operacional** (05:00, D7).

### 1.3 Loja do piloto

1. **Cadastros › Lojas › Nova**: a loja "Treino" (D39) — marque **Loja de treino**, tipo de emissão **Não fiscal**,
   **Usa PDV nesta loja** ligado. O estoque é criado junto ("Criar estoque com o nome da loja").
2. Na mesma tela, bloco **PIX do recebedor (QR no caixa)**: a **chave PIX** da loja (CPF, CNPJ, e-mail, celular com
   +55 e DDD ou chave aleatória), o **nome do recebedor** como aparece no app do banco (até 25 letras) e a cidade. Sem
   a chave o PIX funciona só por confirmação manual, sem QR. Esse bloco é a conta que recebe o dinheiro: só quem tem
   **Lojas: Alterar o recebedor do PIX** (o admin e o perfil Administrador) troca; o Gerente vê e edita o resto da loja.
3. Aba **Caixas**: cadastre o **Caixa 01** (o caixa 0 é do sistema e não serve para o PDV).

### 1.4 Usuários, PINs e permissões

1. **Cadastros › Usuários › Novo** para cada pessoa, com o **perfil** e a **loja** do piloto marcada:
   - operadoras do caixa: perfil **Operador de caixa**;
   - quem libera (cancela venda paga, confirma PIX, cancela sangria): perfil **Gerente** (ou **Supervisor de caixa**,
     que não cancela venda paga — só o gerente e o encarregado cancelam, O6 —, e não configura o terminal: no login o
     **Ctrl+Alt+C** e o **Restaurar backup** pedem o gerente).
   - loja sem gerente: perfil **Encarregado** para quem libera no lugar do dono (as permissões do Supervisor de caixa
     **e o cancelamento da venda paga do caixa aberto**, resposta do dono de 05/11/2026; venda de caixa já fechado não
     se cancela no caixa, D23; não configura o terminal nem vê o histórico de uso). O desconto acima do limite depende
     do **Limite de desconto %** do usuário: defina o do encarregado (ex.: 10%). Se a empresa já tinha
     um perfil próprio "Encarregado", o do sistema aparece como "Encarregado (padrão)": confira qual dos dois vai no
     usuário.
   - quem libera **não pode ser o próprio operador**: no PIX confirmado à mão e na forma "exige supervisor" o caixa
     sempre pede o PIN de outra pessoa. Se o gerente também opera o caixa, outra pessoa precisa poder liberar quando
     ele estiver no caixa (a Prontidão avisa).
2. Em cada usuário, botão **PIN do PDV** (6 a 8 dígitos, sem sequência como 123456 nem repetição como 111111). É
   com login e PIN que se entra no caixa e que o gerente libera as ações.
3. Dê PIN também ao **admin** (Master): só ele declara uma "lacuna de eventos" (raro, item 4.7).
4. **Cadastros › Perfis de acesso**: só mexa se a Prontidão apontar alguém faltando para uma liberação. Cada função
   da barra do caixa é liberada pelo login: tirar do perfil **Operador de caixa** a permissão **PDV – Venda › Cancelar
   item** faz o F4 (e o "Remover item" da janela do item) pedir o PIN do gerente com o motivo; o desconto segue o
   **Limite de desconto %** do usuário (0% = todo desconto pede o gerente). Para exigir o gerente em todo cancelamento
   de item, mesmo com a permissão, ligue **Configurações › Avançado › Cancelar item sempre pede supervisor**.

### 1.5 Formas de pagamento

**Cadastros › Formas de Pagamento**: o piloto usa **Dinheiro, PIX, Cartão de Débito e Cartão de Crédito** (O9a);
Vale Alimentação/Refeição ficam desligados. Confira que cada uma está **Ativa** e vale para a loja do piloto (ou
"todas as lojas"). O PIX com **Gera QR Code Pix** usa a chave da loja (1.3); a confirmação manual do PIX pede o
gerente (O9b). Se o dono desligar **PIX manual exige supervisor** (D37), a operadora só confirma sozinha se tiver a
permissão **Confirmar PIX manual**, que o perfil Operador de caixa não tem: sem ela o caixa continua pedindo o gerente. No cartão o caixa pede a **bandeira** (lista fixa); NSU e autorização são opcionais.

### 1.6 Produtos

1. No Nuvem3, exporte a planilha de **edição em massa de produtos**.
2. **Produtos › Importação**: escolha a loja do piloto, marque **Atualizar estoque**, **Atualizar estoque mínimo**,
   **Atualizar preços** e **Criar marcas e categorias**, informe a **Data/hora da contagem** (a hora em que a planilha
   foi exportada: o vendido depois dela é descontado), envie a planilha e confira a **prévia** (nada é gravado ainda).
   A carga de cada estoque (inclusive o CD, sem loja), as contagens por setor e a conferência com a tolerância estão
   no [`roteiro-inventario.md`](roteiro-inventario.md).
3. **Confirmar**: a importação roda em segundo plano (com 1,7 mil produtos, menos de 1 minuto). O relatório lista os
   avisos. No ensaio com a planilha real de 30/10 (item 6) foram 1.664 produtos criados, nenhum erro, e estes avisos:
   **NCM ausente** (569 — não impede a venda não fiscal, só a NFC-e), **EAN inválido** (369 — gravado como código
   interno: o leitor ainda bipa se o rótulo for igual), **EAN repetido** (2) e **estoque negativo** (2).
4. Depois do piloto começar, todo produto novo ou preço mudado no Nuvem3 chega ao Genesis **importando a planilha de
   novo**: só as diferenças são gravadas.

### 1.7 Primeira conferência da Prontidão

**Cadastros › Implantação › Prontidão da loja**, loja do piloto. Neste ponto é normal ainda faltar **PDV ativado**
(vermelho) e aparecer em amarelo o backup ("não verificável aqui") e os avisos do catálogo. Resolva tudo o que estiver
vermelho, menos o PDV (item 2).

---

## 2. Véspera (D-1): o caixa

### 2.1 Instalar o PDV

Siga o README do PDV › [Instalar na loja › Windows, passo a passo](../../apps/pdv/README.md#windows-passo-a-passo):
baixar o instalador e o `.sha256`, conferir o arquivo, instalar (aviso do SmartScreen: **Mais informações ›
Executar assim mesmo**), **sempre com a conta do Windows do caixa**. Requisitos mínimos: Windows 10 22H2 ou 11 64 bits,
4 GB de memória, SSD, nobreak recomendado.

### 2.2 Ativar

1. No ERP, **Cadastros › PDVs / Terminais › Gerar código de ativação**: loja do piloto, Caixa 01. Anote o código da
   empresa e o código de ativação: vale **24 horas** pelo padrão do campo **Validade** (dá para escolher 1 h, 24 h
   ou 72 h); gerado no D-2, escolha 72 h.
2. No caixa, o **Assistente de ativação** abre sozinho com o endereço do servidor preenchido: Enter, digite os dois
   códigos, confira loja e caixa e espere a **carga inicial** (no ensaio, menos de 5 s para o catálogo inteiro).
3. Na Prontidão, **PDV ativado** fica verde, e **Último contato**, **Versão do PDV** e **Relógio do computador** também.

### 2.3 Impressora

Siga o README do PDV › [Configurar a impressora](../../apps/pdv/README.md#configurar-a-impressora-e-a-gaveta): driver
da Epson/Bematech, no login **Ctrl+Alt+C** (a Central do PDV) com o login e PIN do gerente › **3 Impressora e gaveta**,
modelo, conexão (a impressora do Windows),
papel, **F5 Imprimir teste** (acentos, colunas, QR) e **F2 Salvar**. A gaveta fica **desligada** (as lojas não têm
gaveta ligada à impressora). Sem impressora o caixa vende assim mesmo e avisa na barra.

### 2.4 Treinar a operadora (no próprio caixa, loja de treino)

Desde a versão **0.9.1** (README do PDV › decisão 65) cada tecla abaixo também é um **botão na barra de baixo** da
venda (clique com o mouse ou toque): o botão faz exatamente o que a tecla faz, com as mesmas permissões e liberações, e
depois o cursor volta ao campo de código (o leitor continua bipando). Os diálogos (pagamento, F11, F12, desconto,
quantidade, remover, cliente, liberação do supervisor) e a tela do fechamento têm botões também, inclusive o
**Voltar [Esc]** (quem não tem a tecla Esc sai pelo botão). **Duplo clique num item** já lançado abre a **janela do
item**: quantidade, desconto e "Remover item", com as mesmas regras do F3, F6 e F4. No desconto (janela ou F6) digite
só o número e clique em **"Aplicar em %"** ou **"Aplicar em R$"** (o teclado numérico não tem a tecla %). Para o caixa
**só com teclado numérico**, na Central do PDV › **3 Impressora e gaveta** (**Ctrl+Alt+C** no login ou **F11 › 8 › 3**,
com o gerente) ligue
"Pesquisa de produto só por números" (a pesquisa procura pelo código interno, EAN e códigos adicionais, primeiro o
exato; o código do fardo aparece como "FD 12" e entra como fardo) e deixe a "Barra de funções" em **Botões** (o
padrão; "Texto" volta à legenda antiga). Com ela ligada, digitar **parte do código** no campo de código e Enter já
abre a pesquisa com esses números (não precisa do F2).

| Tecla (ou botão) | O que faz |
|---|---|
| Leitor ou digitar o código + Enter | inclui o produto (`3*código` = 3 unidades) |
| **F2** | pesquisar produto pelo nome (ou só pelo código, com a pesquisa só por números ligada) |
| **F6** | desconto no item ou no total (sem "Desconto no item/total" no perfil, ou acima do limite, o gerente libera) |
| **F3** / **F4** | quantidade do item / remover item (o remover — e diminuir a quantidade, que é tirar parte do item — pede o supervisor se o perfil da operadora não tiver "Cancelar item"; o gerente vê qual item libera) |
| **F10** | pagamento (escolha a forma pelo número; Enter confirma) |
| **F5** | CPF na nota ou cliente (só quando o cliente pedir) |
| **F11** | funções: **1** sangria, **2** reforço, **3** fechamento, **6** resumo do dia, **S** status da sincronização, **V** cascos, **8** Central do PDV (a impressora fica na aba **3**) |
| **F12** | gestão de vendas da sessão: reimprimir (**Ctrl+R**) e cancelar venda paga (**Ctrl+Del**, com o gerente) |
| **Shift+F4** | cancelar a venda em andamento (pede o supervisor) |
| **F1** | ajuda com todas as teclas |
| Duplo clique no item | janela do item: quantidade, desconto e remover (item cancelado não abre) |

Treine: venda em dinheiro com troco, PIX (o QR na tela, o cliente paga, a operadora confere **no app do banco da
loja**, digita o nome de quem pagou e o horário, e o gerente libera), débito e crédito (bandeira), sangria (quem
retira é obrigatório), cancelar uma venda paga com o gerente (motivo de 15 a 255 letras) e o **fechamento cego**: a
operadora conta o dinheiro e informa por forma, **sem ver o esperado** (O3); a diferença só o gerente vê, no ERP.

### 2.5 Conferência final

Prontidão da loja **sem nenhum vermelho** ("pronta para vender"). Os amarelos que podem ficar: avisos do catálogo
(NCM, EAN), backup "não verificável aqui" (confira pelo Hermes) e, se ninguém tiver PIN de Master, a lacuna.

---

## 3. Dia D

1. **Abrir o caixa:** a operadora entra com login e PIN e conta o **fundo de troco** (F2 conta as cédulas).
2. **Primeiras vendas:** depois das 3 primeiras, abra no ERP **Vendas › Vendas** com o filtro **Loja de treino ›
   Só a loja de treino** (a loja de treino fica fora das consultas por padrão, O10) e confira número, valor e forma de cada uma.
3. **Durante o dia:** a barra do caixa mostra "● Online" e o número de pendentes; offline ele continua vendendo.
   Uma vez por turno, olhe no ERP **Cadastros › PDVs / Terminais** (contato, pendências) e a Prontidão.
4. **Sangria:** F11 › 1, valor e quem retira; no ERP, **Vendas › Sangria** (Loja de treino › Só a loja de treino).
5. **Fechamento:** F11 › 3, contagem por forma, Enter; o relatório sai na impressora sem o esperado. No ERP,
   **Financeiro › Fechamento de caixa** com o filtro **Loja de treino › Só a loja de treino** (ou escolhendo a loja
   Treino no filtro de loja) mostra esperado × contado × diferença (só para o gerente).
6. **Backup:** o caixa faz backup a cada 2 h, no fechamento e ao sair (`C:\ProgramData\GenesisPDV\backup\`); a nuvem
   faz o backup diário. Confira no fim do dia, pelo **Hermes**, o `GET /api/saude/detalhada`: `ultimo_backup` com
   `status: ok`, terminais online e `eventos_fila_decisao` 0.

---

## 4. Contingências

| Situação | O que fazer |
|---|---|
| **4.1 Sem internet** | Nada. O caixa vende offline (sem limite de dias, O18) e manda tudo quando a rede volta. O ERP mostra o terminal sem contato. |
| **4.2 PDV travou ou o computador reiniciou** | Abra o GenesisPDV de novo. A venda em andamento volta ("Venda recuperada após interrupção") e o caixa continua aberto. |
| **4.3 Banco do caixa corrompido** ("o banco local não abre") | O caixa abre **sozinho** a tela **Banco local com problema — restaurar backup**, sem passar pelo login e sem pedir PIN (o PIN fica no banco que falhou): escolha o backup mais recente e confirme; o caixa recupera da nuvem o que já tinha enviado depois dele. Sem nenhum backup, aparece a tela de erro com a pasta do backup: chame o suporte. O caminho **Ctrl+Alt+C** com o gerente › **3** › **F9 Restaurar backup**, no login, é para voltar um banco que ainda abre (a tela pede de novo o login e o PIN do gerente na hora). |
| **4.4 Impressora parada** | A venda conclui assim mesmo e o documento fica na fila. Resolvido o papel/cabo, **F11 › 8 › 3 › F7 Imprimir pendentes**; ou reimprima pelo **F12 › Ctrl+R**. |
| **4.5 Relógio do computador errado** | Acerte data, hora e fuso de Brasília no Windows (automático). O ERP mostra "Relógio" em âmbar/vermelho no terminal e o alerta fecha sozinho quando o relógio volta ao normal. |
| **4.6 "Caixa ativado com outra conta"** | Alguém entrou no Windows com outra conta. Saia (Alt+F4), entre com a conta do caixa e abra de novo; nada se perde. |
| **4.7 "Lacuna de eventos — chame o supervisor"** | Raro (banco do caixa restaurado de backup antigo). **F11 › S › F4 Declarar a lacuna** com o PIN do admin (Master). Depois, no ERP, **PDVs / Terminais › o caixa** mostra o que se perdeu; confira com a operadora. |
| **4.8 Evento com erro** (Prontidão: "Fila de decisão") | ERP › **PDVs / Terminais › o caixa › Eventos com erro**: leia a mensagem e use **Reprocessar** (depois de corrigir o cadastro) ou chame o suporte. A venda nunca some: está no caixa. |
| **4.9 PDV abaixo da versão mínima** | O login mostra em âmbar qual instalador usar. Saia pelo programa (Alt+F4) e instale a versão nova por cima. |
| **4.10 Algo grave** (o caixa não abre, dúvida no valor) | Pare o caixa do Genesis e siga vendendo pelo Nuvem3, que já emite a NFC-e (D42). As vendas já feitas no Genesis ficam guardadas no caixa e sobem para a nuvem quando ele voltar. Anote o horário e chame o suporte. |

---

## 5. Convivência com o Nuvem3 durante o piloto

**Decidida pelo dono (roadmap D42): o Genesis é o caixa principal e a NFC-e é emitida no Nuvem3 durante o piloto.**

| Onde | O quê |
|---|---|
| **Genesis** (o caixa principal da loja do piloto) | a venda no caixa (registro, pagamento, sangria, reforço e fechamento) |
| **Nuvem3** | a **NFC-e** da venda (o Genesis não emite nada fiscal até a Fase 3F) |
| **Do Nuvem3 para o Genesis** | produto novo ou preço mudado: reimportar a planilha (item 1.6, só as diferenças) |

> **A combinar com o dono antes do dia D** (roadmap D42): como a NFC-e de cada venda do Genesis é lançada no Nuvem3
> (quem lança, quando e como conferir os totais do dia), em qual loja do Genesis o caixa do piloto vende (o item 1.3 e
> o checklist ainda falam da loja "Treino", que serve para o ensaio) e qual sistema fica com o estoque oficial, o
> cadastro e o financeiro durante o piloto. Até lá, este roteiro vale para o ensaio na loja "Treino".

---

## 6. Ensaio já feito com a planilha real (04/11/2026)

O roteiro foi ensaiado de ponta a ponta com a planilha real da Ice Beer (`apps/api/test/e2e-pdv/ensaio-piloto.sh`,
local, sem a planilha no repositório): importação (1.664 produtos em 37 s, nenhum erro), loja e caixa criados pelo
ERP, PDV ativado e carregado (3,8 s; banco do caixa com 10,6 MB), busca por código em 7 ms (p95) e por nome em 23 ms
(p95), 30 vendas sorteadas do catálogo (dinheiro, PIX com o gerente, débito e crédito; p95 de 1,6 s do primeiro bipe
ao caixa livre), sangria, fechamento cego, tudo conferido no ERP (30 vendas com o mesmo total, sessão fechada, nenhum
evento com erro, estoque baixado certo) e a Prontidão **pronta**, com estes amarelos: produtos sem código (6), EAN com
dígito errado (34 códigos), código repetido entre produtos (3), NCM ausente (569), estoque negativo (2) e o backup "não
verificável aqui".

---

## 7. Checklist (imprima esta página)

**D-2**

- [ ] Servidor no ar; Hermes mostra `/api/saude/detalhada` ok
- [ ] Empresa criada, senha do admin trocada, Configurações › Geral › **Ativa** ligada
- [ ] Loja "Treino" (não fiscal, Usa PDV), **chave PIX** e nome do recebedor, **Caixa 01**
- [ ] Operadoras (Operador de caixa) e gerente (Gerente) com a loja e **PIN**; PIN do admin
- [ ] Dinheiro, PIX, Débito e Crédito ativos na loja; VA/VR desligados
- [ ] Planilha do Nuvem3 importada (prévia conferida, tarefa concluída)
- [ ] Prontidão: só falta o PDV

**D-1**

- [ ] Instalador conferido pelo sha256 e instalado com a conta do caixa
- [ ] Código gerado no ERP e caixa ativado; carga inicial concluída
- [ ] Impressora configurada e **teste impresso** com acentos e QR
- [ ] Operadora treinada: venda, PIX, cartão, sangria, cancelamento com o gerente, fechamento cego
- [ ] Prontidão **pronta para vender** (nenhum vermelho)

**Dia D**

- [ ] Caixa aberto com o fundo contado
- [ ] Primeiras vendas conferidas no ERP (Vendas, Loja de treino › Só a loja de treino)
- [ ] Sangria conferida (Vendas › Sangria, Loja de treino › Só a loja de treino)
- [ ] Fechamento feito; conferido em Financeiro › Fechamento de caixa (Loja de treino › Só a loja de treino)
- [ ] Backup do dia ok no Hermes; nenhum evento com erro em PDVs / Terminais
- [ ] Anotar o que estranhou para a próxima rodada
