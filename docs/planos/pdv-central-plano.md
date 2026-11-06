# Plano final: Central do PDV (a "engrenagem")

Base: `wt-pdv-ux` (cópia da main, PDV 0.9.0, commit 02ed8e2), lida sem alterações. Considero já existentes a barra de funções clicável, a pesquisa numérica, a janela do item (duplo clique) e a permissão `pdv.venda.cancelar_item`, que outro agente está implementando.
Caminhos relativos a `apps/pdv/src`, salvo indicação. Fontes: os três mapas (configurações, vendas/caixas, diagnóstico), as propostas A e B e a crítica. As correções factuais da crítica foram conferidas no código: a quarta trava `ExigirSessaoAsync` (RepositorioCaixa.cs:252) e a auditoria com a sessão da venda (:314); `EsquemaNuvemTests.ColunasSoLocais` fixo (Data.Tests/EsquemaNuvemTests.cs:15); a coluna de data das tabelas de log é `OcorridoEm`, não `CriadoEm`; `CancelamentoVenda.cs:11-29` define `DinheiroNaoDevolvido` e `DevolvidoEmDinheiro`; `pdv.troca.*` existe no catálogo (permissoes.ts:266-268).

---

## 1. Objetivo e o que o dono vai ver

**Objetivo.** Um lugar só no caixa, a engrenagem ⚙, para:
- ver se algo está errado e o que fazer;
- achar qualquer venda e qualquer fechamento de caixa antigo, e reimprimir;
- ver o que aconteceu: erros, logs e quem fez o quê;
- ajustar o que é do próprio caixa (impressora, gaveta, pasta do backup, bloqueio de tela);
- gerar um pacote para o suporte num pendrive;
- e, se o dono aprovar (PC-1), cancelar uma venda de um caixa já fechado sem bagunçar esse fechamento.

Tudo funciona **sem internet**. Nada fiscal (NFC-e é a Fase 3F).

**O que o dono vai ver, em palavras simples:**
1. Um botão ⚙ **"Central do PDV"** na tela de login e no fim da barra de funções da venda. `Ctrl+Alt+C` no login e `F11 › 8` na venda abrem a mesma Central.
2. A Central abre no **Painel de saúde**: uma lista com bolinha verde, amarela ou vermelha (internet e envio ao ERP, impressora, gaveta, disco, backup, relógio, caixa aberto há muito tempo, erros recentes). Cada item vermelho diz **o que está acontecendo, o que fazer** e qual tecla resolve. Qualquer operador vê o Painel (PC-7).
3. Abas no menu lateral: **Vendas** (todas, com filtro por dia, número, CPF, operador), **Caixas** (fechamentos antigos, com reimpressão idêntica), **Sincronização**, **Logs/Erros**, **Histórico de uso** (quem fez o quê), **Parâmetros**, **Backup**, **Impressora e gaveta**, **Pacote de suporte** e **Sobre o terminal**.
4. Uma aba que a pessoa não pode ver aparece com **cadeado**. Ao clicar, o caixa pede o usuário e o PIN de quem pode, hoje o PIN do dono.
5. **Cancelamento posterior** (se o dono aprovar): na aba Vendas, a venda de ontem é cancelada com o PIN do dono, o dinheiro sai do caixa aberto agora, o fechamento de ontem **não muda** e sai um comprovante com linha para o cliente assinar.
6. As regras da loja (fechamento cego, limite de sangria, estoque etc.) aparecem na aba Parâmetros com o valor que está valendo e o selo **"definido no ERP"**, e onde mudar (PC-2).

---

## 2. Decisões e perguntas ao dono

As decisões do projeto ficam registradas depois das respostas: a **D46** no roadmap (revisa a D23), decisões novas no `apps/pdv/README.md` e a correção de `docs/arquitetura/sincronizacao.md:2424`.

> **RESPOSTA DO DONO (04/11/2026) À PC-1: opção A — a D23 continua.** Venda de caixa fechado só se cancela pelo ERP, na
> Fase 3 (o dono preferiu esperar a Fase 3; não antecipar). Consequências neste plano: **PC-3, PC-4, PC-5, PC-6 e PC-10 caem**;
> a permissão `pdv.venda.cancelar_venda_sessao_fechada` **não** é criada; a seção 5.1 e os blocos **G12, G13 e G14 saem**.
> Na aba Vendas, venda de sessão fechada fica só para consulta e reimpressão, com o aviso "Venda de caixa fechado: cancele
> pelo ERP" no lugar do botão de cancelar.
>
> **Demais respostas (04/11/2026):** PC-7 sim (Painel e Sobre só leitura sem PIN); PC-8 sim (perfil "Encarregado");
> PC-9 opção A (caixas antigos como impressos; calculado só no ERP); PC-13 existe, desligado por padrão. PC-2, PC-11 e
> PC-12 seguem a recomendação.
>
> **Vendas/Caixas (04/11/2026), substitui o teto de 90 dias:** a aba Vendas abre só com as vendas do caixa aberto; um filtro
> escolhe um dos caixas fechados do terminal nos **últimos 30 dias** (ajuste do dono: 30 dias no lugar de 10 caixas); mais
> antigos, só no ERP. A aba Caixas lista os mesmos. Nada é
> apagado do banco local.

### PC-1. Cancelar venda de caixa já fechado (conflita com a D23)
Hoje (D23, 31/10): só o gerente cancela venda paga, e só da sessão de caixa aberta; a de caixa fechado, pelo ERP na Fase 3. O pedido "cancelar vendas passadas" muda isso.
- **Opção A.** Mantém a D23. Venda antiga só pelo ERP, quando a Fase 3 existir.
- **Opção B. Cancelamento posterior no PDV.** A venda do caixa X (fechado) é cancelada no caixa Y (aberto agora). O dinheiro sai da gaveta de Y, o fechamento de X fica como foi impresso (no PDV e no ERP) e ganha só a nota "cancelada depois em dd/mm". Liga e desliga por loja no ERP, com prazo máximo, só com PIN do gerente/dono digitado na hora, motivo obrigatório e alerta para o dono no ERP.
- **Opção C.** Como a B, mas sem devolver dinheiro: só "anula" a venda (estoque volta, dinheiro não sai).
- **Recomendação: B**, entrando **desligada** (prazo 0) e ligada por loja. A C é proibida pelo desenho (seção 5.1, regra 6), porque apagaria uma venda antiga sem mexer no caixa.
- Sub-perguntas (respondidas nas PCs seguintes): prazo (PC-3), quem autoriza (PC-4), formas e limites de valor (PC-5), mercadoria (PC-6).

### PC-2. Onde as regras da loja são editadas
O dono pediu um PDV "extremamente editável". As regras `pdv.*` e `geral.*` já existem (cerca de 70 no catálogo) e são editadas no ERP (Configurações).
- **Opção A.** Continuam só no ERP. O PDV mostra cada uma com o valor efetivo, a origem (loja, empresa ou padrão), o selo "definido no ERP" e o caminho no ERP para mudar.
- **Opção B.** Editáveis também no PDV, com o PIN do gerente.
- **Recomendação: A.** Editar no PDV faria caixas da mesma loja divergirem e daria conflito quando o caixa está offline. "Muito configurável" fica no ERP; no PDV ficam editáveis só as coisas do próprio caixa (impressora, gaveta, barra, pesquisa, pasta do backup, bloqueio de tela, tema).

### PC-3. Prazo máximo do cancelamento posterior
- Opções: 1, 3, 7, 15 ou 30 dias (teto do sistema: 30), contados em dias operacionais (respeita a hora de corte do dia).
- **Recomendação: 7 dias.** Acima disso, pelo ERP na Fase 3.

### PC-4. Quem autoriza o cancelamento posterior
- **Opção A.** Só gerente ou dono (Master), com o PIN digitado na hora, mesmo que esteja logado.
- **Opção B.** Também o supervisor.
- **Recomendação: A.** Hoje isso significa o PIN do dono nas duas lojas. Ver também a PC-8 (encarregado).

### PC-5. Formas de pagamento e limites no cancelamento posterior
O risco aqui é desvio: cancelar uma venda antiga paga no cartão e "devolver em dinheiro" tira dinheiro da gaveta enquanto a maquininha continua pagando a loja.
- **Opção A.** Só vendas pagas **inteiramente em dinheiro**, devolução em dinheiro.
- **Opção B.** Também cartão, PIX e vale devolvidos **em dinheiro** (o que a O22 já permite na sessão aberta).
- **Opção C.** Também estorno no meio original (maquininha, PIX). Distorce o fechamento atual (calculado negativo ou sobra fictícia na forma) e exige mudar a apuração; fica para depois.
- Limites: valor máximo por cancelamento e soma máxima por dia operacional, por caixa.
- **Recomendação: A na primeira versão**, com limite de **R$ 300 por cancelamento e R$ 500 por dia** por caixa (configuráveis no ERP; 0 = sem limite). Venda a prazo/crediário sempre recusada ("cancele pelo ERP"). A opção B fica como chave da loja (`pdv.cancelamento_posterior_formas`), desligada.

### PC-6. A mercadoria volta?
Cancelar devolve todo o estoque da venda. Na prática, "cancelar venda passada" costuma ser uma devolução, às vezes parcial ou sem a mercadoria voltar.
- **Opção A.** Cancelamento posterior sempre devolve tudo ao estoque (como o cancelamento de hoje). Devolução parcial fica para o fluxo de troca/devolução (permissões `pdv.troca.*`, que já existem no catálogo), num projeto próprio.
- **Opção B.** Perguntar item a item se volta ao estoque.
- **Recomendação: A**, deixando claro que o cancelamento posterior é para **desfazer a venda inteira**. Pede-se ao dono que diga se a devolução parcial é frequente; se for, a troca/devolução sobe de prioridade no roadmap.

### PC-7. O operador vê o Painel de saúde sem PIN?
- **Recomendação: sim, só leitura** (Painel e Sobre). Ele mesmo resolve papel, fila de impressão (F7/F8 já são da permissão de hardware ou ficam visíveis só como orientação) e internet, sem chamar o dono.

### PC-8. Perfil "Encarregado" nas lojas sem gerente
Sem gerente, toda liberação cai no PIN do dono.
- **Recomendação: sim**, criar um perfil de sistema "Encarregado" = Supervisor + ver vendas antigas + ver caixas antigos + diagnóstico + pacote de suporte. **Sem** cancelamento posterior, sem histórico de uso e sem parâmetros. O dono cadastra um por loja se quiser.

### PC-9. Ver calculado e diferença de caixas antigos no PDV
O fechamento cego (O3) esconde o esperado.
- **Opção A.** A tela mostra só o que o relatório impresso daquele fechamento mostrou (reimpressão dos bytes). Conferência no ERP.
- **Opção B.** O gerente vê calculado e diferença de caixas **já fechados** no PDV (nunca do aberto), com `pdv.caixa.ver_calculado_fechamento`.
- **Recomendação: A.** Mantém a O3 sem exceção; o ERP já mostra a conferência.

### PC-10. Como os relatórios mostram a venda cancelada depois
- **Recomendação:** relatório de **vendas pelo dia da venda** (a venda aparece como "cancelada depois em dd/mm"); relatório de **caixa pelo dia em que o dinheiro saiu** (aparece no caixa Y, na linha "cancelamentos posteriores"). O fechamento antigo fica como foi impresso, com uma nota.

### PC-11. Quanto histórico no caixa
O banco local guarda tudo desde a ativação (não há expurgo) e o ERP já tem as consultas de vendas e de fechamentos.
- **Recomendação:** não apagar nada agora, só medir o tamanho (aba Sobre e heartbeat). As **telas** do PDV consultam até **90 dias**; para mais, a tela diz "consulte no ERP (Vendas / Fechamentos de caixa)". Expurgo e retenção ficam para uma decisão futura, com números reais.

### PC-12. Pacote de suporte
- **Recomendação:** salvar em **pendrive agora**; o envio pelo ERP (o suporte pede e recebe sem ir à loja) numa fase seguinte, que depende de rota e armazenamento novos na nuvem. Confirma que quer o envio remoto depois?

### PC-13. Bloqueio de tela por inatividade
- **Recomendação:** disponível e **desligado por padrão**; ligado por caixa na aba Parâmetros (por exemplo 10 min). O desbloqueio pede o PIN do operador logado.

---

## 3. Permissões

### 3.1 Existentes (sentido revisado, sem mudar código de perfil)

| Permissão | Na Central |
|---|---|
| `pdv.acesso.entrar` | Painel de saúde (só leitura) e Sobre o terminal (PC-7). |
| `pdv.venda.consultar` | Aba Vendas limitada à **sessão aberta** (o F12 de hoje). |
| `pdv.documento.reimprimir` | Reimprimir cupom de qualquer venda visível e o fechamento de caixa visível. |
| `pdv.venda.cancelar_venda_finalizada` | Cancelar venda da **sessão aberta** (D23, sem mudança). |
| `pdv.caixa.ver_calculado_fechamento` | Sem mudança (O3; PC-9 recomenda não estender a caixas antigos). |
| `pdv.relatorio.resumo_diario` | Resumo diário (atalho na aba Caixas). |
| `pdv.config.terminal` | Impressora, gaveta, barra, pesquisa, fila de impressão (F7/F8) **e restaurar backup** (sem mudança; não se cria `pdv.backup.restaurar`, evitando migração de perfis e equivalência de transição). |
| `pdv.config.fiscal` | Sem mudança: lacuna e salto, só Master, sem liberação. |

### 3.2 Novas (7)

| Código | Rótulo | Perfis padrão | Liberação |
|---|---|---|---|
| `pdv.venda.consultar_historico` | Ver vendas de outras sessões e dias | Supervisor, Gerente | sim |
| `pdv.caixa.consultar_fechamentos` | Ver e reimprimir caixas fechados | Supervisor, Gerente | sim |
| `pdv.venda.cancelar_venda_sessao_fechada` | Cancelamento posterior (venda de caixa já fechado) | **só Gerente** (e Master) | sim, **sempre com PIN digitado na hora** |
| `pdv.diagnostico.ver` | Sincronização detalhada, outbox, logs, ocorrências, lista de backups | Supervisor, Gerente | sim |
| `pdv.diagnostico.pacote_suporte` | Gerar o pacote para o suporte | Supervisor, Gerente | sim |
| `pdv.auditoria.ver_local` | Histórico de uso (auditoria local) | **só Gerente** (e Master) | sim |
| `pdv.config.parametros_locais` | Editar parâmetros do caixa (bloqueio de tela, pasta secundária do backup) e "Fazer backup agora" | Gerente | sim |

- Entram em `packages/shared/src/permissoes.ts` e `perfis-padrao.ts`, com espelho em `GenesisPDV.Core/Caixa/PermissoesPdv.cs`. O teste do PDV já confere o espelho.
- `PDV_GERENTE = pdv.* − SOMENTE_MASTER` recebe as 7 automaticamente; `PDV_SUPERVISOR` recebe as quatro marcadas. Um teste no shared confere a tabela acima.
- **Perfis existentes:** o seed idempotente da API (`seed-empresa.ts:197-215`, rodado pelo `db:referencias`) acrescenta o que falta aos perfis de sistema e incrementa `permissoes_versao`. **Não há migração de concessão** para perfis personalizados no G1: antes de implementar, conferir no banco do piloto se existe algum perfil personalizado com `pdv.*`; se existir, o G1 inclui uma migração de dados pequena (quem tem `pdv.supervisor` ganha as quatro de supervisor; quem tem `pdv.config.terminal` ganha `parametros_locais`).
- Perfil "Encarregado" (PC-8): entra no seed só se o dono aprovar; caso contrário, não é criado.
- Não se cria `central.timeout_elevacao_min`, `pdv.backup.restaurar`, `pdv.backup.gerenciar` nem `pdv.diagnostico.ver_logs` (escopo demais para 2 lojas onde o dono é o único que libera).

### 3.3 Acesso à Central e liberação por aba

- **Na venda:** o operador logado entra com as permissões dele. Exige caixa livre (sem venda em andamento) e fora da confirmação de desativação (D22), como hoje no F11 › 8.
- **No login:** a Central pede usuário e PIN. Hoje a liberação no login usa `IAutenticadorOperador.LiberarAsync` (Operadores.cs:44), que exige `pdv.supervisor` e confere uma permissão por vez; isso não serve para "abrir nas abas que esse usuário pode ver". **Novo método** `IAutenticadorOperador.AutenticarParaCentralAsync(usuario, pin, agora)`: confere o PIN pela mesma regra do `AutenticarAsync` (Operadores.cs:38/56: bloqueio por tentativas, hash, usuário ativo), **não abre sessão de operador** e devolve o conjunto de permissões efetivas. Quem tem `pdv.acesso.entrar` vê o Painel e o Sobre; o resto segue as permissões.
- **Elevação ("Liberar", F2 na Central):** um supervisor digita usuário e PIN; as abas passam a abrir com o conjunto de permissões dele (o mesmo método). Vale até sair da Central ou 5 min sem uso (constante no código). Grava a auditoria `liberacao` com as abas no `depois`.
- **PIN na hora, sempre:** cancelamento posterior e restaurar backup pedem o PIN de quem tem a permissão no momento da ação, mesmo com elevação ativa e mesmo que o próprio usuário logado tenha a permissão.
- **Auditoria de acesso:** ação local `central_acessada` (abas sensíveis abertas no `depois`). Fica **fora** de `CatalogosNuvem.AcoesAuditoria`: o `OutboxSync` filtra pela lista e ela não sobe nem derruba lote (sem dependência de deploy).
- **Desativação (D22):** o gatilho bloqueia INSERT de auditoria; a Central trata a `RegraNegocioException`, fica só leitura e mostra "terminal em desativação".

---

## 4. Desenho das abas

Navegação: menu lateral numerado (0 a 9 e a letra P para o pacote), clique ou dígito com o foco no menu; Esc volta; nas listas ↑/↓, Enter detalhe, PgUp/PgDn (ou `+`/`−` no numérico) para paginar, `*` abre as ações da linha. Alvos de no mínimo 44 px. Listas paginadas com 50 por página, por cursor, `AsNoTracking`, projeção em DTO, nunca `Include` de lista inteira, um `DbContext` curto por consulta, fora da thread de UI.

| # | Aba | Permissão | Conteúdo | Ações | Auditoria |
|---|---|---|---|---|---|
| 0 | **Painel de saúde** (abre por padrão) | `acesso.entrar` | Verificações com semáforo, frase, "o que fazer" e a tecla (4.1) | Atalhos para a aba certa; F7/F8/F5/F6 de impressora/gaveta só com `config.terminal`; "Sincronizar agora" | — |
| 1 | **Vendas** | `venda.consultar` (sessão) / `venda.consultar_historico` (até 90 dias) | Filtros (4.2), lista com selo CANCELADA / CANCELADA DEPOIS | Enter detalhe; Ctrl+R reimprimir; Ctrl+Del cancelar (sessão aberta: fluxo D23; sessão fechada: posterior, seção 5) | `reimpressao`, `venda_cancelada`, `liberacao` |
| 2 | **Caixas** | `caixa.consultar_fechamentos` | Sessões deste terminal pelo **retrato** (4.3) | Enter detalhe; Ctrl+R reimprimir fechamento (bytes); F6 resumo diário | `reimpressao` (entidade `fechamento`) |
| 3 | **Impressora e gaveta** | `config.terminal` | A `ConfiguracaoTerminalViewModel` atual movida, mais barra e pesquisa do outro agente | F2, F5, F6, F7, F8 como hoje | `editar` (`configuracao_terminal`), como hoje |
| 4 | **Sincronização** | `diagnostico.ver` | Tudo do F11 › S (`StatusDetalhadoSync`), outbox completo paginado por status e tipo, detalhe do evento **sem payload** (tipo, sequência, criado, tentativas, próxima tentativa, último erro, dependências, lote), `comandos_recebidos` | Enter = Sincronizar agora; F4 lacuna (`config.fiscal`). Rejeitado: "só o ERP resolve (Terminal › Fila de decisão)" | `central_acessada` |
| 5 | **Logs e ocorrências** | `diagnostico.ver` | F3 alterna: **Ocorrências** (`log_local`, com dica do `CatalogoOcorrencias`) e **Arquivo técnico** (Serilog do dia escolhido, lido pelo final) | Filtro por nível, período, origem, texto; Enter detalhe com exceção | `central_acessada` |
| 6 | **Histórico de uso** | `auditoria.ver_local` | `log_auditoria_local` em frases ("14:32 · João cancelou o item … · liberado por Maria"), filtros, marca "enviado/só local" | F6 Resumo por operador | `central_acessada` |
| 7 | **Parâmetros** | ver: `diagnostico.ver`; editar: `config.parametros_locais` | Do caixa (editáveis) e da loja (só leitura, "definido no ERP") (4.5) | F2 salvar com validação; "Testar pasta" | `editar` com antes/depois por chave |
| 8 | **Backup** | ver: `diagnostico.ver`; agir: `config.parametros_locais`; restaurar: `config.terminal` | Arquivos (data, motivo, tamanho, local principal/secundária), último sucesso, última falha | F5 Fazer backup agora; Restaurar só na Central aberta pelo login | `criar` (entidade `backup_local`) |
| 9 | **Sobre o terminal** | `acesso.entrar` | Empresa, loja, caixa nº, código curto do terminal (8 primeiros do `terminal_id` + caixa), ambiente, versão do app e do schema, migração aplicada, Windows, ativado em, pastas e tamanhos (banco, logs, backups) | Copiar código para o suporte | — |
| P | **Pacote de suporte** | `diagnostico.pacote_suporte` | O que entra e o que não entra (4.6) | Gerar e salvar (pendrive) | `exportar` (entidade `pacote_suporte`, hash do zip) |

- **F12 na venda** abre a aba Vendas da Central já no escopo "Sessão atual". F11 › S continua como atalho para a aba 4; F11 › 6 continua o resumo diário.
- `Ctrl+Alt+T` (tema) continua sem permissão (preferência visual), mas passa a gravar por `ServicoParametrosLocais` com auditoria `editar`.
- Ícone de alerta na barra de status da venda quando o Painel tem item vermelho; clique abre a Central no Painel.

### 4.1 Painel de saúde
`IVerificacaoSaude` + `VerificadorSaude`: todas locais, **em paralelo**, fora da thread de UI, limite de 2 s cada, resultado em cache. O ícone da barra de status usa só as verificações baratas, a cada 60 s; nenhuma roda `integrity_check`.

| Verificação | Amarelo / vermelho | Ação |
|---|---|---|
| Sincronização | pendente mais antigo > 1 h / offline perto de `pdv.dias_max_offline` | Enter Sincronizar; aba 4 |
| Rejeitados / quarentena | > 0 | "Resolva no ERP › Terminal › Fila de decisão" |
| Lacuna (C15) | declarada ou pendente | F4 com `config.fiscal` |
| Relógio (C16) | desvio além do limite / regressão | "Acerte a hora do Windows" |
| Impressora | fila pendente / com erro ou impressora não encontrada | F7, F8, F5 |
| Gaveta | erro no último pulso (`log_local`) | F6 |
| Disco (spec 32.2) | < 1 GB / < 200 MB | Mostra banco, logs e backups; abaixo de 200 MB bloqueia **abrir caixa novo** (nunca a venda em curso), com "liberar por 1 h" pelo supervisor (auditado `liberacao`) |
| Backup | último sucesso > 4 h / última tentativa falhou | aba 8, F5 |
| Banco | `integrity_check` do último start falhou (resultado guardado em memória na partida) | "Restaure pelo login" |
| Caixa | sessão aberta além de `pdv.horas_alerta_sessao` / de dia anterior | "Feche o caixa (F11 › 3)" |
| Versão | abaixo da mínima do heartbeat | texto |
| Erros recentes | `log_local` erro/crítico nas últimas 24 h | aba 5 filtrada |

### 4.2 Vendas
- Escopo: Sessão atual / Hoje / Ontem / 7 dias / De–até (dia operacional, `geral.dia_operacional_hora_corte`), **teto de 90 dias** (PC-11); sem `consultar_historico`, preso à sessão atual.
- Filtros no SQL: status (todas, finalizadas, canceladas, canceladas depois), número local ou da nuvem (T27), CPF/CNPJ (igualdade com o número normalizado), operador, forma, valor mínimo e máximo, sessão.
- Lista: número, data/hora, operador, total, formas, selo. CPF mascarado na lista (`***.456.789-**`), completo no detalhe. Rodapé com quantidade; o total do filtro só aparece com `ver_calculado_fechamento` (O3).
- Detalhe: o `DialogoDetalheVendaViewModel` atual, mais "Sessão de caixa X (aberta/fechada em …)" com atalho para a aba 2.
- Ctrl+R: `ServicoVenda.ReimprimirAsync` (já não depende da sessão).
- Ctrl+Del: o PDV escolhe o caminho; fora do prazo ou recurso desligado, mensagem direta ("Venda de 28/10 está fora do prazo de 7 dias desta loja. Cancele pelo ERP.").

### 4.3 Caixas
- Lista de sessões deste terminal, mais novas primeiro: abertura, fechamento, operador, tipo de fechamento, quantidade de vendas, contado, status do `caixa.fechado` no outbox. Diferença e calculado **não** aparecem (PC-9 A).
- Selo "canceladas depois: n · R$ x": vendas da sessão X com `CanceladaEm > X.FechadaEm`. Calculado ao vivo, sem alterar o retrato.
- Detalhe pelo **retrato**: `FechamentoCaixaRegistro`, `FechamentoCaixaFormaRegistro` (só o contado), movimentos da sessão, atalho "vendas desta sessão" (aba 1 filtrada) e bloco "depois do fechamento" (data e sessão onde o dinheiro saiu).
- Ctrl+R: bytes da `fila_impressao` (tipo `fechamento_caixa`, `ReferenciaId = fechamento.Id`) com a marca "2ª VIA". Sem bytes (por exemplo, depois de reidratação): "comprovante indisponível; consulte no ERP". **Nunca** remonta a partir do `Resumo` (ele não tem formas, sangria nem as flags da O3) e **nunca** chama `ApurarAsync` nem `EstornosEscolhidosAsync`.

### 4.4 Histórico de uso
- `DescritorAuditoria` (ação → frase); grupos: Acessos (login, logout, liberação, central_acessada), Vendas (cancelamentos, descontos, itens), Caixa (sangria, reforço, gaveta, reimpressão), Configuração, Sistema.
- F6 Resumo por operador no período: logins, primeira e última atividade, vendas, itens cancelados, vendas canceladas, descontos (quantidade e valor), gavetas avulsas, liberações pedidas.
- Antes/depois aparece mascarado e só para chaves de `ChavesExibiveis`.

### 4.5 Parâmetros
- **Do caixa (editáveis, `ServicoParametrosLocais`, num commit com a auditoria `editar`, mesmo padrão de `ServicoHardware.GravarAsync`):**
  - `tela.tema` (claro/escuro);
  - `tela.bloqueio_inatividade_min`: 0 a 120, 0 = desligado (padrão). Implementa a spec 6.2.2; o desbloqueio pede o PIN do operador logado; ação `bloqueio` (já no catálogo);
  - `backup.pasta_secundaria`: caminho absoluto; recusa a pasta do próprio PDV; testa escrita antes de gravar; aviso "o backup contém o banco inteiro, sem cifra, com CPFs; use uma pasta só desta máquina ou um pendrive guardado".
  - As chaves da barra e da pesquisa (do outro agente) ficam na aba 3.
- **Da loja/empresa (só leitura):** cada chave de `RepositorioConfiguracoes.ChavesConfiguracao`, com rótulo, valor efetivo, origem (Loja / Empresa / Padrão), selo "definido no ERP" e data do último pull (spec 6.9). Chave marcada `sensivel` no catálogo do shared aparece como `••••`.
- Nível de log Debug temporário **não** tem tela: fica fora (o suporte pede um pacote; ver seção 8).

### 4.6 Pacote de suporte
- Nome `suporte-<loja>-cx<n>-AAAAMMDD-HHMM.zip`. Destino escolhido na lista de unidades removíveis (`DriveInfo` `Removable`); sem pendrive, `Documentos\GenesisPDV-suporte`. Gerado em segundo plano, o caixa continua vendendo.
- Conteúdo por **lista de permitidos**:

| Arquivo | Conteúdo |
|---|---|
| `manifesto.json` | versão, Windows, código do terminal, nomes de empresa/loja/caixa, schema e migração, gerado por (nome) e quando, SHA-256 de cada arquivo |
| `saude.json` | resultado do Painel |
| `status-sync.json` | `StatusDetalhadoSync`, contagem do outbox por status e tipo |
| `outbox.csv` | id, tipo, sequência, status, tentativas, próxima, último erro, dependências, **sem payload** |
| `comandos.csv` | `comandos_recebidos` |
| `ocorrencias.csv` | `log_local` dos últimos 30 dias, mascarado |
| `logs/` | Serilog dos últimos 7 dias, mascarado |
| `configuracao-terminal.json` | só `ChavesExibiveis` |
| `configuracoes-efetivas.json` | `pdv.*`/`geral.*` com origem; sensíveis mascaradas |
| `backups.csv` | nome, tamanho, data, local |
| `fila-impressao.csv` | tipo, status, tentativas, erro, **sem bytes** |
| `disco.json` | livre, banco, logs, backups |
| `auditoria-resumo.csv` | contagem por ação e dia, 7 dias, sem antes/depois nem motivo |

- **Nunca:** `pdv.db`, `-wal`, `-shm`, `*.gz`, `chave_terminal`, `ChavesConfiguracaoTerminal.Internas`, `identidade_terminal.TokenProtegido`, hashes de PIN, payloads de evento, bytes de impressão, `encerramento.json`.
- **Na tela de erro fatal** (`EstadoTerminalViewModels.MontarDiagnostico`): botão "Gerar pacote para o suporte" que funciona **sem login e sem abrir o banco**: só `manifesto.json` (sem o "gerado por"), `logs/` mascarados e o texto do diagnóstico, com o aviso "o pacote contém registros técnicos do caixa; entregue só ao suporte". Grava a ação em `log_local` só se o banco abrir.

---

## 5. Regras de negócio novas

### 5.1 Cancelamento posterior (só depois de PC-1 = B; vira a D46)

**Ideia.** A venda da sessão X (fechada) é cancelada na sessão Y (aberta agora, deste terminal). `sessao_caixa_cancelamento_id = Y`, o `estorno_venda` sai da gaveta de Y, o retrato de X não muda, no PDV e na nuvem. O contrato já aceita isso: `payloadVendaCanceladaFinalizadaSchema` (packages/shared/src/sync/eventos.ts:836-870) não exige a mesma sessão, `conferirSessaoDoDocumento` (apps/api/src/sync/handlers/vendas.ts:278-298) só confere que a sessão existe e é do terminal, e `CancelamentoFinalizada` já separa `SessaoCaixaCancelamentoId`. **Sem schema novo, sem coluna nova** (uma coluna "só local" quebraria `EsquemaNuvemTests` e o MD 4.1).

**Chaves novas da loja** (packages/shared/src/configuracoes.ts, zod, rótulos no ERP):
- `pdv.cancelamento_posterior_dias_max`: inteiro 0 a 30, padrão 0 (desligado);
- `pdv.cancelamento_posterior_limite_valor`: R$ por cancelamento, padrão 0 = sem limite (PC-5 recomenda 300);
- `pdv.cancelamento_posterior_limite_dia`: R$ somados no dia operacional, por terminal, padrão 0 = sem limite (PC-5 recomenda 500);
- `pdv.cancelamento_posterior_formas`: `so_dinheiro` (padrão: venda paga inteiramente em dinheiro) | `dinheiro_para_todas` (cartão, PIX e vale devolvidos em dinheiro).

**Pré-condições (conferidas em Core, App e Data):**

| # | Regra | Camada |
|---|---|---|
| 1 | `dias_max > 0` | App (monta `PoliticaCancelamento`) |
| 2 | `DiaOperacional(hoje) − DiaOperacional(venda) ≤ dias_max`, com a hora corrigida (C16). Relógio não confiável ou regredido: recusa ("relógio do caixa suspeito; cancele pelo ERP") | Core |
| 3 | Há sessão aberta Y neste terminal; a venda é deste terminal, está finalizada e a sua sessão X está **fechada** e é ≠ Y | Core e Data |
| 4 | Permissão `pdv.venda.cancelar_venda_sessao_fechada`, PIN digitado na hora | App |
| 5 | Motivo de 15 a 255 caracteres | Core |
| 6 | Estornos permitidos: `DinheiroDevolvido` (forma dinheiro) e, só com `dinheiro_para_todas`, `DevolvidoEmDinheiro`. **Proibidos sempre no posterior:** `DinheiroNaoDevolvido`, `PosCanceladoNaMaquininha`, `PixDevolucaoManual`, `CreditoCancelado` e qualquer forma a prazo | Core (`RegrasEstorno.Opcoes` filtradas pela política) |
| 7 | Valor devolvido ≤ `limite_valor` (se > 0) e soma do dia operacional + valor ≤ `limite_dia` (se > 0) | App (consulta) e Core (regra) |
| 8 | Dinheiro a devolver ≤ `DinheiroGaveta(Y)`; senão "faça um reforço antes" | App |
| 9 | O `venda.finalizada` da venda **existe no outbox local** e não está rejeitado, em erro, retido, em quarentena nem descartado (`FinalizadaDescartadaAsync`). Pendente é aceito (a dependência garante a ordem). Sem o evento local (venda re-hidratada ou restaurada sem outbox): recusa "esta venda não foi feita neste caixa desde a última recuperação; cancele pelo ERP" | App |
| 10 | `venda.cancelada` anunciado (T13), caixa livre, fora da desativação (como hoje) | App |
| 11 | Guarda futura: venda com documento fiscal autorizado é recusada ("use devolução", Fase 3F) | Core |

**Mudanças no código:**
- **Core.** `PoliticaCancelamento` (record novo: `SessaoAbertaId`, `PrazoDias`, `DiaOperacionalHoje`, `DiaOperacionalVenda`, `RelogioConfiavel`, `EstornosPermitidosPosterior`, `LimiteValor`, `SomaDia`, `LimiteDia`). `Venda.CancelarFinalizada` (Venda.cs:2002-2075) recebe a política: sessão igual segue o fluxo atual; diferente aplica as regras 2, 3, 5, 6, 7, 11. `CancelamentoFinalizada` (CancelamentoVenda.cs:112-121) ganha `Posterior` e `SessaoOrigemId`. A mensagem de :1982 vira três (desligado nesta loja, fora do prazo, forma não permitida).
- **App.** `ServicoVenda.PrepararCancelamentoAsync` (:1057-1105, trava em :1086-1089) monta a política (chaves da loja, dia operacional, relógio, soma do dia, evento local). `CancelarFinalizadaAsync` (:1130-1210) exige a permissão nova com PIN na hora quando `Posterior`. Novo `DialogoCancelamentoPosteriorViewModel` derivado do `DialogoCancelarVendaFinalizadaViewModel`, com o aviso "O dinheiro sai do caixa aberto agora. O fechamento de dd/mm não muda." e "dia n de N".
- **Data.** `RepositorioCaixa.CancelarVendaFinalizadaAsync` (:230-318) passa a receber explicitamente a sessão do cancelamento e a usar em **todos** os pontos: a trava das linhas `estorno_venda` (:241-249) compara com Y; `ExigirSessaoAsync` (:252) exige Y aberta; a trava de :261-265 aceita X fechada deste terminal só com `Posterior` marcado, conferindo de novo prazo e sessão fechada (defesa em profundidade); `AdicionarAuditoria` (:314) grava com Y.
- **Sync.** Nenhuma mudança: `FabricaEventos.VendaCanceladaFinalizada` (:54-118) já manda `sessao_caixa_cancelamento_id` e a dependência da venda e da sessão do cancelamento.
- **Auditoria.** Sem ação nova: a `venda_cancelada` local ganha no `depois` `posterior`, `sessao_origem_id`, `sessao_cancelamento_id`, `dias_desde_venda`, `estornos`, `liberado_por`; mais a `liberacao`.

**Efeitos:**
- **Caixa Y.** A apuração já subtrai o `estorno_venda` em dinheiro. `ResumoTurno`, `LayoutsCaixa.Fechamento` e `ResumoDiario` ganham a linha "Cancelamentos posteriores (vendas de caixas anteriores): n · R$ x" (no cego, só a quantidade). Critério sem coluna nova: vendas canceladas com `SessaoCaixaId ≠ Y` e `CanceladaEm` dentro do período aberto de Y (só existe uma sessão aberta por terminal, `uq_sessoes_caixa_aberta`). O `Resumo` do `caixa.fechado` é `z.looseObject` (eventos.ts:352): a linha nova não muda o contrato.
- **Retrato de X.** Não muda; a aba Caixas mostra a nota.
- **Comprovante.** Layout novo "CANCELAMENTO POSTERIOR": venda nº, data, sessão de origem e quem fechou, motivo, quem liberou, valor devolvido e linha "Recebi R$ x ____ (cliente)". Imprime duas vias (cliente e caixa).
- **Gaveta.** Abre só se sair dinheiro (como hoje).
- **Estoque.** Volta com `data_movimento = cancelada_em` (a nuvem já faz); a compensação contra um "Definir" já existe. Cascos: `pdv.cancelamento_devolve_vazios` (D29), com o aviso "confira os cascos".

### 5.2 Caixas antigos
Fonte única: o retrato e os bytes da fila. Um teste garante que a aba Caixas e a reimpressão não chamam `ApurarAsync` nem `EstornosEscolhidosAsync` para sessão fechada (recalcular mudaria o calculado das formas a prazo depois de um cancelamento posterior).

### 5.3 Histórico de vendas
`ConsultasHistoricoLocal.VendasAsync(filtro, cursor)` com paginação por cursor `(FinalizadaEm desc, Id)`, todos os filtros no SQL, teto de 90 dias. `ConsultasVendaLocal.VendasDaSessaoAsync` vira um caso particular (escopo = sessão).

### 5.4 Mascaramento e chaves exibíveis
- `ChavesExibiveis` (lista de permitidos em `TabelasLocais.cs`, ao lado de `ChavesConfiguracaoTerminal.Internas`): `ChavesHardware` + parâmetros do caixa + chaves da barra/pesquisa. Teste: interseção com `Internas` vazia, e toda chave usada em `configuracao_terminal` está classificada em uma das duas listas.
- `MascaradorSuporte` (um só, usado no visor, no pacote e no diff da auditoria), **por contexto**, para não comer `payload_sha256` nem GTIN-14:
  - `Bearer …`, `Authorization:` e valores de `token=`, `chave=`, `senha=`, `pin=`, `secret=`;
  - campos JSON chamados `token`, `chave*`, `senha`, `pin`, `cpf_cnpj*`, `br_code`/`payload_pix`;
  - CPF/CNPJ **com pontuação** (`000.000.000-00`, `00.000.000/0000-00`);
  - BR Code (começa com `000201` e contém `br.gov.bcb.pix`);
  - caminho do perfil do Windows → `%USERPROFILE%`.
- Aplicado na exibição e na exportação, **não** no sink do Serilog (evita reescrever o formatter no caminho de toda linha). Hoje nenhum log grava token, PIN ou CPF; um teste com segredos plantados prova o pacote.

### 5.5 Logs
- `Program.cs:39-47`: `MinimumLevel.Override("System.Net.Http.HttpClient", Warning)` e `Override("Microsoft", Warning)` (acaba o ruído do heartbeat a cada 30 s); `fileSizeLimitBytes` 20 MB com `rollOnFileSizeLimit`; `retainedFileCountLimit` 30 mantido; enrich `caixa` e `terminal` (código curto), nada de pessoa. Template de texto igual. Sem pacote NuGet novo.
- `LeitorLogArquivo`: abre com `FileShare.ReadWrite`, lê pelo final em blocos, paginado; linha que começa com data abre registro, as seguintes são a exceção. Nunca carrega o arquivo inteiro.
- `log_local` como "ocorrências": `Origem` padronizada (impressora, gaveta, sync, backup, caixa, venda, sistema) e `Codigo` curto dentro de `Detalhes` (JSON, sem mudar schema). Novos pontos de gravação: falha de impressão, evento rejeitado, falha de comando, parâmetro alterado, backup manual, pacote gerado. `CatalogoOcorrencias` liga código → dica em português de balcão.
- **Sem sink do Serilog para o `log_local`** (laço quando o erro é do banco; trava da D22).

---

## 6. Mudanças na nuvem e no ERP

**Ordem obrigatória:** a nuvem antes do PDV, a cada bloco. Nenhuma ação nova entra em `CatalogosNuvem.AcoesAuditoria` neste plano (`central_acessada` fica só local; as demais usam `editar`, `criar`, `exportar`, `reimpressao`, `liberacao`, `bloqueio`, `cancelar`, que já estão no catálogo). Assim não há risco de `PAYLOAD_INVALIDO` no lote.

| Bloco | Onde | O quê |
|---|---|---|
| G1 | `packages/shared/src/permissoes.ts`, `perfis-padrao.ts` | 7 permissões e perfis da tabela 3.2 (e o "Encarregado" se PC-8 = sim) |
| G1 | `packages/shared/src/configuracoes.ts` | 4 chaves `pdv.cancelamento_posterior_*` (zod, padrões desligados); marca `sensivel` nas chaves que `eventos.ts` já mascara |
| G1 | `apps/erp-web` (rótulos de permissão e `CamposConfiguracoes.tsx`) | Rótulos; os campos do cancelamento posterior ficam **ocultos** até a D46 |
| G1 | API | Seed idempotente já concede aos perfis de sistema; migração de perfis personalizados só se a conferência no piloto achar algum |
| G12 | `apps/api/src/sync/handlers/cancelamento.ts` | Quando `sessao_caixa_cancelamento_id ≠ vendas.sessao_caixa_id`: **aceita sempre** (o dinheiro já saiu); descrição da auditoria `cancelar` com "posterior (sessão X → Y)"; alerta `CANCELAMENTO_POSTERIOR` (aviso) com valor e quem liberou; `CANCELAMENTO_POSTERIOR_FORA_DA_POLITICA` (crítico) se passou do prazo ou dos limites pelas chaves vigentes. A nuvem não exige que Y ainda esteja aberta quando o evento chega |
| G12 | `packages/shared` (tipos de alerta) | Os dois tipos de alerta novos |
| G12 | `apps/api/src/vendas/sessoes-caixa.controller.ts:163-186` | Na sessão X: separar "canceladas na sessão" de "canceladas depois" (`cancelada_em > fechada_em`); o esperado de X já não muda. Na sessão Y: bloco "cancelamentos posteriores" (estornos em Y de vendas de outra sessão) |
| G12 | `apps/erp-web/.../FechamentosCaixa.tsx` | Mostrar os dois blocos acima |
| G12 | Relatórios de venda e dashboard | Convenção da PC-10 documentada (venda pelo dia da venda, caixa pelo dia do movimento); conferir `vendas.controller.ts:99-104` |
| G12 | Teste de integração na API | Sessão da venda ≠ sessão do cancelamento: estoque com `data_movimento = cancelada_em`, `estorno_venda` em Y, fechamento de X intacto, alertas |
| G12 | ERP Configurações | Libera os campos do cancelamento posterior (depois da D46) |
| G15 | `apps/erp-web/src/paginas/terminais/DetalheTerminal.tsx` | Mostrar `disco_livre_mb`, `tamanho_banco_mb` e `fila_impressao_pendentes`, que já chegam no heartbeat |
| Docs | `docs/arquitetura/sincronizacao.md:2424`; spec PDV 6.1, 6.2.2, 6.9, 13.3, 22.1, 32.1, 32.2; roadmap D46; `apps/pdv/README.md` (Central, permissões, pacote, cancelamento posterior); README da API | Junto do bloco correspondente |

---

## 7. Blocos

Cada bloco cabe num ciclo implementar → revisar → corrigir. Versões: PDV 0.10.0 com G2-G11; G13-G14 em 0.10.x depois da D46.

### G1. Contratos na nuvem (permissões e chaves)
- **Objetivo:** a nuvem conhece as permissões e as chaves antes de qualquer PDV novo.
- **Entregas:** 7 permissões; perfis padrão; 4 chaves `pdv.cancelamento_posterior_*` desligadas e ocultas no ERP; marca `sensivel`; rótulos no ERP; conferência de perfis personalizados no piloto (e migração de dados só se houver); espelho em `PermissoesPdv.cs`.
- **Arquivos:** `packages/shared/src/{permissoes,perfis-padrao,configuracoes}.ts`; `apps/erp-web` (rótulos, `CamposConfiguracoes.tsx`); `apps/api/src/database/.../seed-empresa.ts` (só se o Encarregado for aprovado); `GenesisPDV.Core/Caixa/PermissoesPdv.cs`.
- **Migrações:** nenhuma de schema; dados só se houver perfil personalizado.
- **Testes:** espelho de permissões no PDV; perfis padrão (Supervisor tem as 4, Gerente as 7, Operador nenhuma); zod das chaves (dias aceita 0 e 30, recusa −1 e 31; formas só os dois valores); seed acrescenta e incrementa `permissoes_versao`.
- **Pronto quando:** API e ERP em produção com as permissões nos perfis do piloto, e o PDV 0.9.0 continua funcionando igual.
- **Depende de:** nada.

### G2. Fundação de segurança e logs no PDV (sem tela)
- **Objetivo:** ter as peças que impedem vazamento e limpar o log antes de qualquer visor.
- **Entregas:** `ChavesExibiveis`; `MascaradorSuporte`; overrides e limite de tamanho do Serilog, enrich `caixa`/`terminal`; `AutenticarParaCentralAsync` em `IAutenticadorOperador`; `AcessoCentral` (conjunto de permissões, elevação com 5 min, auditoria `liberacao` e `central_acessada`).
- **Arquivos:** `GenesisPDV.Data/Entidades/TabelasLocais.cs`; `GenesisPDV.App/Servicos/Diagnostico/{MascaradorSuporte,AcessoCentral}.cs`; `GenesisPDV.App/Servicos/Operadores.cs`; `GenesisPDV.App/Program.cs`.
- **Migrações:** nenhuma.
- **Testes:** mascarador (tabela de casos, inclusive o que **não** pode mascarar: sha256, GTIN-14, número de venda); `ChavesExibiveis ∩ Internas = ∅` e toda chave classificada; `AutenticarParaCentralAsync` respeita bloqueio por tentativas e não abre sessão de operador; elevação expira; `central_acessada` não sobe no lote (filtrada) e o lote continua válido; HttpClient não loga em Information.
- **Pronto quando:** o arquivo de log de um dia de piloto simulado não tem as linhas do heartbeat, e os testes de mascaramento passam.
- **Depende de:** G1 (espelho).

### G3. Casca da Central e aba Impressora e gaveta
- **Objetivo:** substituir a página única pela Central, sem mudar o que já funciona.
- **Entregas:** `CentralPdvViewModel/View` com menu, cadeado, F2 Liberar; ⚙ no login e na barra; `Ctrl+Alt+C` e `F11 › 8` levam à Central; `ConfiguracaoTerminalViewModel` vira `AbaHardwareViewModel` (aba 3); Restaurar backup continua pelo login com `config.terminal`; modo só leitura na desativação.
- **Arquivos:** novos `App/ViewModels/Central/{CentralPdvViewModel,AbaHardwareViewModel}.cs`, `Views/Central/*.axaml`; alterados `ConfiguracaoTerminalViewModel.cs`/`ConfiguracaoTerminalView.axaml` (movidos), `ShellViewModel.cs` (`IrParaConfiguracaoTerminalAsync`), `LoginView.axaml`/`LoginViewModel.cs`, `DialogosCaixa.cs` (case "8"), `VendaViewModel.cs` (`AbrirConfiguracaoTerminalAsync`).
- **Migrações:** nenhuma.
- **Testes:** todos os testes atuais de hardware passam; aba sem permissão mostra cadeado e libera com PIN; a Central não abre com venda em andamento; desativação não quebra (`RegraNegocioException` tratada); quem não tem `config.terminal` não vê Restaurar.
- **Pronto quando:** o fluxo de impressora e gaveta de hoje funciona igual dentro da Central, pelo login e pela venda.
- **Depende de:** G2.

### G4. Painel de saúde, Sobre e alerta de disco
- **Objetivo:** o operador vê o que está errado e o que fazer, sem PIN.
- **Entregas:** `VerificadorSaude` e as 12 verificações (4.1) em paralelo; aba 0 e aba 9; ícone na barra de status; disco < 200 MB bloqueia abrir caixa com "liberar por 1 h".
- **Arquivos:** `App/Servicos/Diagnostico/{VerificadorSaude,IVerificacaoSaude}.cs`, `Verificacoes/*.cs`; `App/ViewModels/Central/{AbaPainelViewModel,AbaSobreViewModel}.cs`; `ShellViewModel.cs` (guardar resultado do `integrity_check`); `ServicoCaixa.cs` (bloqueio na abertura); barra de status da venda.
- **Migrações:** nenhuma.
- **Testes:** cada verificação em verde/amarelo/vermelho com estado simulado; tempo total limitado mesmo com uma verificação travada; ícone não roda `integrity_check`; bloqueio de abertura e liberação de 1 h auditada; venda em curso nunca é bloqueada; tudo offline.
- **Pronto quando:** num terminal sem internet e com a fila parada, o operador abre o ⚙, vê o item vermelho com "o que fazer" e o código do terminal para o suporte.
- **Depende de:** G3.

### G5. Vendas: consulta histórica e F12
- **Objetivo:** achar e reimprimir qualquer venda dos últimos 90 dias, offline.
- **Entregas:** `ConsultasHistoricoLocal.VendasAsync` paginada; aba 1 e F12 com escopo e filtros; CPF mascarado na lista; detalhe com a sessão; selo "cancelada depois".
- **Arquivos:** `Data/Repositorios/{ConsultasHistoricoLocal,ConsultasVendaLocal}.cs`; `App/ViewModels/DialogosGestaoVendas.cs`; `App/Servicos/ServicoVenda.cs` (`VendasDaSessaoAsync`); `VendaViewModel.cs` (`AbrirGestaoVendasAsync`); `PdvDbContext.cs`.
- **Migrações:** `IndicesHistoricoVendas`: `vendas(finalizada_em)`, `vendas(cancelada_em)`, `vendas(dia_operacional, finalizada_em)`, `vendas(operador_id, dia_operacional)`, `vendas(cpf_cnpj_nota)`; `sessoes_caixa(aberta_em)`. Roda depois do backup `antes-migracao`; testar sobre cópia do banco do piloto. Conferir com `EsquemaNuvemTests` que índice local não quebra a comparação de colunas.
- **Testes:** filtros combinados no SQL; cursor sem repetir nem pular; sem `consultar_historico` preso à sessão; teto de 90 dias; 120 mil vendas sintéticas com página < 300 ms; F12 antigo (Enter, Ctrl+R, Ctrl+Del na sessão aberta) igual.
- **Pronto quando:** o supervisor acha a venda "nº 4512 da semana passada" em até 3 teclas e reimprime sem internet.
- **Depende de:** G3.

### G6. Caixas antigos
- **Objetivo:** ver e reimprimir fechamentos antigos sem recalcular nada.
- **Entregas:** `ConsultasHistoricoLocal.SessoesAsync`; aba 2 com lista, detalhe pelo retrato, movimentos, atalho para vendas, "canceladas depois"; Ctrl+R pelos bytes com "2ª VIA" ou "indisponível"; F6 resumo diário.
- **Arquivos:** `ConsultasHistoricoLocal.cs`; `RepositorioCaixa.cs` (leitura do retrato e dos bytes); `App/ViewModels/Central/AbaCaixasViewModel.cs`; `ServicoImpressao` (marca de 2ª via em bytes de fechamento, como o cupom).
- **Migrações:** índice `fila_impressao(tipo, referencia_id)` (pode ir na migração do G5 se os dois entrarem juntos).
- **Testes:** reimpressão = bytes originais + marca; sem bytes, "indisponível"; **mock que falha se `ApurarAsync` ou `EstornosEscolhidosAsync` forem chamados**; calculado e diferença nunca aparecem; auditoria `reimpressao` com entidade `fechamento`.
- **Pronto quando:** o fechamento de 15 dias atrás é reimpresso idêntico, offline.
- **Depende de:** G3 (paralelo ao G5).

### G7. Sincronização detalhada
> **Pedido do dono (04/11/2026), como no Nuvem3 ("vendas a copiar"):** a aba começa por **"Vendas não confirmadas pela nuvem"**,
> uma lista por VENDA (não por evento): pendente/enviando em **amarelo**, recusada em **vermelho** (com o motivo da nuvem, pelo
> `eventos-status`), confirmada some da lista. Abrir uma venda mostra os **itens**, os pagamentos, o histórico de tentativas
> (quantas, quando, último erro, sem payload) e o log ligado a ela. Botão **"Reenviar agora"** (força o ciclo de envio; é
> idempotente, nada duplica) para as pendentes; para as recusadas, a tela explica que a decisão é no ERP (Terminais › caixa ›
> Eventos com erro: reprocessar/descartar, C8) e a venda fica verde sozinha quando o ERP resolve. O indicador "⇅ N" da tela de
> venda vira clicável e abre essa lista. Também entram sangrias/reforços/fechamentos pendentes, numa segunda seção.
- **Objetivo:** ver por que algo não subiu, sem tocar no que é do ERP.
- **Entregas:** aba 4 com `StatusDetalhadoSync`, outbox paginado e detalhe sem payload, `comandos_recebidos`; F11 › S vira atalho.
- **Arquivos:** `ConsultasHistoricoLocal.cs` (outbox, comandos); `App/ViewModels/Central/AbaSincronizacaoViewModel.cs`; `DialogosCaixa.cs` (S).
- **Migrações:** índice `eventos_saida(status, criado_em)` se não existir.
- **Testes:** paginação estável; detalhe nunca expõe `Payload`/`Contexto`; não há ação de descartar ou reprocessar; F4 só com `config.fiscal`.
- **Pronto quando:** o supervisor vê qual evento está parado, desde quando e com qual erro.
- **Depende de:** G3.

### G8. Logs e ocorrências
- **Objetivo:** achar um erro de ontem em menos de 1 minuto sem abrir o Windows Explorer.
- **Entregas:** `LeitorLogArquivo`; aba 5 com as duas fontes, filtros e detalhe mascarado; `Origem` padronizada e `Codigo`; `CatalogoOcorrencias`; novos pontos de gravação em `log_local`.
- **Arquivos:** `App/Servicos/Diagnostico/{LeitorLogArquivo,CatalogoOcorrencias}.cs`; `RepositorioTerminal.RegistrarLogAsync`; `ServicoImpressao.cs`, `ProcessadorComandos.cs`, `EnvioPush.cs` (pontos de gravação); `App/ViewModels/Central/AbaLogsViewModel.cs`.
- **Migrações:** índice `log_local(ocorrido_em, nivel)` (já existe `ix_log_local_ocorrido_em`; acrescentar `nivel` só se a consulta precisar).
- **Testes:** leitura com o Serilog escrevendo (FileShare); exceção de várias linhas; leitura pelo final de arquivo de 20 MB sem carregar tudo; todo `Codigo` gravado tem dica no catálogo; exibição mascarada.
- **Pronto quando:** o erro de impressão de ontem aparece com a dica "o que fazer".
- **Depende de:** G2, G3.

### G9. Pacote de suporte
- **Objetivo:** o suporte entende o problema só com o zip, e o zip não tem segredo.
- **Entregas:** `ServicoPacoteSuporte` (4.6); aba P; botão no rodapé do Painel; botão na tela de erro fatal sem banco.
- **Arquivos:** `App/Servicos/Diagnostico/ServicoPacoteSuporte.cs`; `App/ViewModels/Central/AbaPacoteViewModel.cs`; `EstadoTerminalViewModels.cs`.
- **Migrações:** nenhuma.
- **Testes:** **varredura de segredos**: token, chave privada, `backup.chave`, hash de PIN, CPF e BR Code plantados no banco, na config e no log; nenhum aparece nos bytes do zip; o zip nunca tem `.db`, `-wal`, `-shm` nem `.gz`; manifesto confere os hashes; geração na tela de erro fatal com o banco inacessível; auditoria `exportar`.
- **Pronto quando:** o encarregado gera o zip no pendrive em 3 cliques e a varredura passa.
- **Depende de:** G4, G7, G8.

### G10. Histórico de uso
- **Objetivo:** o dono vê quem cancelou, deu desconto ou abriu a gaveta, por operador, sem internet.
- **Entregas:** `ConsultasHistoricoLocal.AuditoriaAsync`; `DescritorAuditoria`; aba 6 com filtros, marca "enviado/só local" e F6 resumo por operador.
- **Arquivos:** `ConsultasHistoricoLocal.cs`; `App/Servicos/Diagnostico/DescritorAuditoria.cs`; `App/ViewModels/Central/AbaHistoricoUsoViewModel.cs`.
- **Migrações:** índices `log_auditoria_local(ocorrido_em)`, `(usuario_id, ocorrido_em)`, `(acao, ocorrido_em)`.
- **Testes:** toda ação gravada hoje tem frase (falha se surgir ação sem frase); totais do resumo por operador; só Gerente/Master; antes/depois só de chaves exibíveis e mascarado.
- **Pronto quando:** o dono vê o resumo da semana por operador no caixa offline.
- **Depende de:** G3.

### G11. Parâmetros e backup
- **Objetivo:** ajustar o que é do caixa com validação e auditoria, e ver as regras da loja.
- **Entregas:** `ServicoParametrosLocais` (tema auditado, `tela.bloqueio_inatividade_min` com o bloqueio implementado, `backup.pasta_secundaria` com teste de escrita); aba 7 com as chaves da loja só leitura, origem e "definido no ERP"; aba 8 com lista de backups e F5 "Fazer backup agora" (motivo `manual`).
- **Arquivos:** `App/Servicos/{ServicoParametrosLocais,ServicoTema}.cs`; `RepositorioConfiguracoes.cs` (valor efetivo e origem); `App/Servicos/Diagnostico/CatalogoRotulosConfiguracao.cs`; `Data/Backup/BackupLocal.cs` (motivo `manual`, listagem); `App/Servicos/ServicoBackup.cs` (disparo manual); `App/ViewModels/Central/{AbaParametrosViewModel,AbaBackupViewModel}.cs`; `VendaViewModel.cs` (bloqueio por inatividade).
- **Migrações:** nenhuma (chaves novas em `configuracao_terminal`).
- **Testes:** toda chave de `ChavesConfiguracao` tem rótulo; nenhuma `Interna` listada; validações; auditoria antes/depois (inclusive `Ctrl+Alt+T`); bloqueio dispara e desbloqueia com o PIN do operador; backup manual respeita a retenção e grava nas duas pastas; backup manual com venda em andamento espera ou recusa.
- **Pronto quando:** o gerente troca a pasta secundária com a confirmação de que funciona, faz um backup agora e o Painel fica verde.
- **Depende de:** G3, G4.

### G12. Cancelamento posterior na nuvem e no ERP (só depois da D46)
- **Objetivo:** a nuvem aceita, avisa o dono e mostra direito as duas sessões.
- **Entregas:** tudo da linha G12 da seção 6; D46 no roadmap; correção da SYNC :2424; spec 13.3 e 22.1.
- **Arquivos:** `apps/api/src/sync/handlers/cancelamento.ts`; tipos de alerta no `packages/shared`; `apps/api/src/vendas/sessoes-caixa.controller.ts`; `apps/erp-web/.../FechamentosCaixa.tsx` e `CamposConfiguracoes.tsx`; `docs/roadmap.md`, `docs/arquitetura/sincronizacao.md`, `docs/pdv/especificacao-pdv.md`.
- **Migrações:** nenhuma de schema (o critério de "canceladas depois" usa `cancelada_em > fechada_em`).
- **Testes:** integração com sessão da venda ≠ sessão do cancelamento; alerta normal e fora da política (prazo e limites); fechamento de X intacto; contadores das duas sessões.
- **Pronto quando:** um evento de cancelamento posterior feito à mão no ambiente de teste aparece certo no ERP, com o alerta.
- **Depende de:** PC-1 = B (D46), G1.

### G13. Cancelamento posterior: Core e Data
- **Objetivo:** a regra e a gravação, sem tela.
- **Entregas:** `PoliticaCancelamento`; regras 2, 3, 5, 6, 7, 11 no Core; as quatro travas e a auditoria do `RepositorioCaixa` usando a sessão do cancelamento; mensagens novas.
- **Arquivos:** `GenesisPDV.Core/Vendas/{Venda,CancelamentoVenda}.cs`; `GenesisPDV.Data/Repositorios/RepositorioCaixa.cs`; `GenesisPDV.Data/Repositorios/RepositorioConfiguracoes.cs` (`ChavesConfiguracao` das 4 chaves).
- **Migrações:** nenhuma.
- **Testes:** `CancelamentoFinalizadaTests` :108-112, `CancelamentoFinalizadaDadosTests` :235/:253 e `RepositorioCaixaTests` :342 continuam recusando com prazo 0; casos novos: dentro e fora do prazo, limite exato do dia operacional com hora de corte, relógio não confiável, sem sessão aberta, venda de outro terminal, `DinheiroNaoDevolvido` recusado, maquininha/PIX recusados, forma a prazo recusada, `so_dinheiro` com venda em cartão recusada, limites de valor e de dia; `estorno_venda` em Y; `FechamentoCaixaRegistro` e formas de X **iguais byte a byte**; auditoria com Y; evento com `sessao_caixa_cancelamento_id = Y` e dependências corretas.
- **Pronto quando:** com prazo 0 o comportamento é idêntico ao da 0.9.0 e os casos novos passam.
- **Depende de:** G12.

### G14. Cancelamento posterior: tela, comprovante e relatórios
- **Objetivo:** o gerente cancela uma venda de ontem em 4 passos, e o caixa de hoje mostra a saída.
- **Entregas:** `PrepararCancelamentoAsync`/`CancelarFinalizadaAsync` com a política, regras 4, 8, 9, 10 e PIN na hora; `DialogoCancelamentoPosteriorViewModel`; Ctrl+Del na aba Vendas escolhe o caminho; comprovante em duas vias com assinatura; linha "cancelamentos posteriores" em `ResumoTurno`, `LayoutsCaixa.Fechamento` e `ResumoDiario`; nota na aba Caixas; README do PDV.
- **Arquivos:** `App/Servicos/{ServicoVenda,ServicoCaixa}.cs`; `App/ViewModels/DialogosGestaoVendas.cs` e o diálogo novo; `LayoutsCaixa.cs` e layout de cupom; `RepositorioCaixa.ResumoDiarioAsync`; `apps/pdv/README.md`.
- **Migrações:** nenhuma.
- **Testes:** venda re-hidratada (sem `venda.finalizada` local) recusada; finalizada retida/rejeitada/descartada recusada, pendente aceita; gaveta insuficiente recusa; PIN pedido mesmo com o gerente logado; linha nova no fechamento de Y (cego só quantidade); comprovante com os campos; gaveta abre só com saída de dinheiro.
- **Pronto quando:** no piloto, com o prazo ligado numa loja, o gerente cancela uma venda de ontem, o dinheiro sai do caixa de hoje, o fechamento de ontem continua igual no PDV e no ERP, o dono recebe o alerta e o comprovante sai com a linha de assinatura.
- **Depende de:** G5, G6, G13.

### G15. ERP mostra a saúde do terminal
- **Objetivo:** o dono vê pelo ERP o que o heartbeat já manda.
- **Entregas:** disco livre, tamanho do banco e fila de impressão em `DetalheTerminal.tsx`, com cores da spec 32.2.
- **Arquivos:** `apps/erp-web/src/paginas/terminais/DetalheTerminal.tsx` (e o DTO da API, se não expõe os campos).
- **Migrações:** nenhuma.
- **Testes:** renderização com e sem os campos; cores nos limites.
- **Pronto quando:** o ERP mostra os três números de cada terminal do piloto.
- **Depende de:** nada (pode andar em paralelo).

**Ordem e paralelismo:** G1 → G2 → G3. Depois do G3: G4, G5, G6, G7, G10 em paralelo; G8 depois do G2/G3; G9 depois de G4, G7, G8; G11 depois do G4. G12 → G13 → G14 só com a D46. G15 a qualquer momento.

---

## 8. Riscos e o que fica fora

### Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Desvio de dinheiro com cancelamento posterior (venda em cartão "devolvida em dinheiro"; venda apagada sem devolver) | Desligado por padrão; `so_dinheiro` como padrão; `DinheiroNaoDevolvido` proibido no Core; PIN na hora; limites por cancelamento e por dia; comprovante assinado; alerta ao dono na nuvem |
| Voltar a hora do Windows para caber no prazo | Recusa com relógio não confiável ou regredido (C16); a nuvem alerta fora da política pelo dia operacional |
| Recalcular fechamento antigo muda números | Só retrato e bytes; teste com mock que falha se `ApurarAsync`/`EstornosEscolhidosAsync` forem chamados |
| Venda re-hidratada sem payload no outbox | Regra 9: exige o `venda.finalizada` local |
| Trava esquecida da D23 | As quatro travas e a auditoria usam a sessão do cancelamento recebida explicitamente; testes de Data cobrem cada uma |
| Coluna "só local" quebrar `EsquemaNuvemTests` | Nenhuma coluna nova; critério por horário de cancelamento |
| Catálogo de auditoria à frente da API derruba o lote | Nenhuma ação nova no catálogo; `central_acessada` fica só local |
| Segredo em tela ou pacote | `ChavesExibiveis`, `MascaradorSuporte` por contexto, sem payload nem bytes, varredura com segredos plantados, nunca banco nem backup |
| Pacote na tela de erro fatal sem login | Só manifesto, logs mascarados e diagnóstico, com aviso |
| Painel lento no PC da loja | Paralelo, fora da UI, 2 s por verificação, cache; ícone sem `integrity_check` |
| Bloqueio por disco parar a loja num falso positivo | Bloqueia só abrir caixa novo, nunca a venda em curso; liberação de 1 h pelo supervisor |
| Banco cresce sem limite; listas carregam tudo | Índices, cursor, teto de 90 dias nas telas, tamanho medido no Sobre e no heartbeat |
| Relatórios do ERP mudarem o passado | Convenção da PC-10; sessão antiga separa "canceladas depois" (G12) |
| PIN do dono vira gargalo | Perfil Encarregado (PC-8) |
| Trava da D22 durante desativação | Central só leitura, `RegraNegocioException` tratada |
| Migração de índices no piloto | Roda depois do backup `antes-migracao`; testada sobre cópia do banco real |

### Fora deste plano
- **Fiscal (NFC-e, Fase 3F).** `pdv.config.fiscal` não muda; no futuro, cancelamento posterior fiscal vira devolução (spec 13.3).
- **Estorno no meio original no posterior** (maquininha, PIX) e o bloco separado na apuração para isso: depende da PC-5.
- **Devolução parcial / troca** (`pdv.troca.*`): projeto próprio (PC-6).
- **Cancelamento de venda antiga pelo ERP** (Fase 3).
- **Envio remoto do pacote** (`enviar_logs`, `POST /sync/logs`, armazenamento `logs_terminal`, "Pedir logs" no ERP): fase seguinte (PC-12); até lá o PDV continua respondendo "não suportado".
- **Página de auditoria do PDV no ERP** e entrada de ações novas no catálogo de auditoria.
- **Emissão de `terminal.configuracao_alterada`** (continua adiada, README do PDV).
- **Retenção/expurgo** de `log_local`, `log_auditoria_local`, `eventos_saida`, `fila_impressao` e vendas: só medir (PC-11). `PRAGMA incremental_vacuum` não serve (o banco não liga `auto_vacuum`).
- **Nível de log Debug temporário** com tela e chave.
- **Reprocessar ou descartar evento no PDV** (continua só no ERP).
- **Editar regras da loja no PDV** (PC-2).
- **Exportar backup pela tela** (o backup tem o banco inteiro sem cifra até a D41).
- **Verificação de permissão do autorizador na nuvem** para o cancelamento posterior (o handler hoje não confere permissões; o alerta cobre prazo e limites).
