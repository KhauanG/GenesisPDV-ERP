# Andamento do projeto

> Estado de trabalho para quem continua (pessoa ou sessão do Claude Code). Atualize **no fim de cada bloco** e a cada
> merge/implantação: o que mudou, o que está aberto e o próximo passo. As regras estão no `CLAUDE.md`; o histórico das
> decisões técnicas fica nos READMEs; as respostas do dono, em `docs/planos/decisoes-do-dono.md`.

_Última atualização: 07/11/2026 (PR-6 em produção desde 06/11/2026 23:35 UTC; PR-7 em andamento: F2-B28 commitado)._

## Repositório

- **Este repositório (`KhauanG/GenesisPDV-ERP`) é público desde 06/11/2026** (D60): começou com **uma única versão**
  (commit `a66397f`), sem o histórico antigo. Os runners padrão do Actions não cobram minutos.
- O histórico até 06/11/2026 (PRs **#1 a #31**, branches e releases `pdv-v0.9.x`) está no repositório **privado**
  `KhauanG/GenesisPDV-ERP-arquivo`, só para consulta. Quando um README, plano ou decisão citar um PR por número
  (ex.: "#25", "PR #30"), é o desse arquivo; os PRs deste repositório recomeçaram do #1.
- Configurado pelo dono em 06/11/2026: environments `producao` (só a `main`, com o dono como aprovador obrigatório) e
  `release-pdv` (a `main` e as tags `pdv-v*`; sem certificado de assinatura, padrão do README do PDV); ruleset `main`
  (PR obrigatório com 0 aprovações, sem apagar nem force-push); aprovação para workflows de quem é de fora; permissão
  dos workflows só de leitura; secret scanning e push protection ligados.

## Em produção

- **ERP/API:** a `main` deste repositório (commit `45b07ec`: PR-6 transferências e os PRs #1 e #2 do Dependabot),
  implantada pelo dono em 06/11/2026 23:35 UTC pela "Implantação" (CI verde; imagens montadas com
  `setup-buildx-action` v4.4.1 e `build-push-action` v7.4.0). Migrações de empresa até a **0025** (transferências).
  Saúde: https://erp.grupoicebeer.com.br/saude.
- **PDV na página de download:** **0.10.0** (release `pdv-v0.10.0` deste repositório, publicado em 06/11/2026 16:19
  UTC): Central do PDV (engrenagem ⚙) e saúde do terminal no ERP.
- Também em produção: a NF-e de fornecedor (F2-B18..B21), o diagnóstico de queda da API (README da API › decisão 166)
  e a saída do Actions sem dados da VPS (D60).
- A implantação automática (`IMPLANTACAO_AUTOMATICA`) continua desligada: a "Implantação" disparada pela CI sai
  "skipped"; o dono roda à mão e aprova o environment `producao`.
- **Lojas do piloto:** Loja 1 e Petiscaria 2 (CNPJs próprios) e o CD (CNPJ próprio, loja do tipo depósito).

## Fases

| Fase | Situação |
|---|---|
| 0 e 1 (fundação, cadastros, PDV MVP offline, implantação do piloto) | concluídas |
| **2 (produtos e estoque completos)** | em andamento — plano em `docs/planos/fase2-plano.md` (blocos F2-B1..B53, PR-1..PR-12) |
| Central do PDV (engrenagem ⚙, diagnóstico no caixa) | **concluída** e em produção (PDV 0.10.0) |
| Repositório público (D60) | **concluído** em 06/11/2026 (falta só o SSH da VPS, ver Pendências) |
| 3, 4, 5 e 3F (fiscal por último) | não iniciadas |

### Fase 2 — PRs

| PR do plano | Blocos | Situação |
|---|---|---|
| PR-1 base do estoque oficial | B1–B5 | concluído (arquivo #13) |
| PR-2 projeções e tipos de estoque | B6–B8 | concluído (arquivo #17) |
| PR-3 inventário inicial e ajustes | B9–B12 | concluído (arquivo #18) |
| PR-4 fornecedores e recebimento manual | B13–B17 | concluído (arquivo #19) |
| PR-5 NF-e de fornecedor por XML | B18–B21 | concluído (arquivo #30) e em produção |
| PR-6 transferências | B22–B27 | concluído (#4) e em produção (06/11/2026) |
| **PR-7 relatórios de estoque** | **B28–B33** | **em andamento** (branch `claude/blissful-cray-cvroui`, recomeçado da `main` com o PR-6) |
| PR-8 em diante | | não iniciados |

### PR-6 — blocos

| Bloco | Situação |
|---|---|
| F2-B22 schema e contratos (migração `0025_transferencias`, `packages/shared/src/transferencias.ts`; README da API › decisão 170) | **commitado** (`9d8ed39`) |
| F2-B23 rascunho, enviar e cancelar (`apps/api/src/transferencias/`, sem migração; travas de inativar/excluir estoque e tipo de estoque; NF-e de fora depois do envio; README da API › decisão 171) | **commitado** |
| F2-B24 receber, divergência e modo de uma etapa (`apps/api/src/transferencias/recebimento.ts`, rotas `receber` e `tratar-divergencia`, sem migração; perda = retorno + acerto de Saída `perda_transferencia` que estorna o retorno (mesmo lote, custo do envio; efeito líquido zero) e não se estorna; lote preso à origem → lote do mesmo código e validade no destino; README da API › decisão 172; D61 decidida pelo dono em 06/11/2026) | **commitado** |
| F2-B25 sugestão de reposição (`GET /transferencias/sugestao-reposicao`; `apps/api/src/transferencias/reposicao.ts` e `em-transito.ts` — a subconsulta do em trânsito que o F2-B26 reaproveita —, sem migração; chave `estoque.reposicao_arredonda_embalagem` = Sim, D52 decidida pelo dono em 06/11/2026; README da API › decisão 173) | **commitado** |
| F2-B26 em trânsito, divergência a tratar e alerta (`em-transito.ts`: `sqlDivergenciaATratar`, `sqlPendenciasTransferencia`, `sqlSaldosComPendencias`; `apps/api/src/transferencias/alertas.ts` e a fila `genesis-alerta-transferencias` a cada hora; colunas em `GET /produtos/:id/saldos`, `GET /saldos-estoque`, no bloco Estoque do produto e na tela Saldos; a divergência fica na origem, fora do em trânsito; chave `estoque.transferencia_alerta_dias` = 3, padrão aplicado sem pergunta; sem migração; README da API › decisão 174; README do ERP › decisão 63) | **commitado** |
| F2-B27 telas e romaneio (`apps/erp-web/src/paginas/estoques/Transferencias.tsx`, `transferenciaItens.ts` e `TransferenciasRomaneio.tsx`, rotas e menu; `GradeItens` com `linhasFixas`; na API, `GET /transferencias/dados-produtos`, `GET /transferencias/:id/romaneio`, a embalagem de compra nos itens e o alerta `TRANSFERENCIA_PARADA` aberto no detalhe — `apps/api/src/transferencias/romaneio.ts`; sem migração, PDV sem mudança; e2e `apps/erp-web/e2e/fluxo-transferencia.spec.ts` rodado localmente: verde; README da API › decisão 175; README do ERP › decisão 64) | **commitado** |

### PR-7 — blocos

| Bloco | Situação |
|---|---|
| F2-B28 desempenho do razão (massa de carga `apps/api/test/carga/massa-razao.ts` — `pnpm --filter api carga:razao`, fora do CI: 4 milhões de movimentos em 12 meses, 3 lojas, CD e Treino, roteiro de `EXPLAIN (ANALYZE, BUFFERS)` antes/depois e o heap do replay, apaga os bancos no fim; migração **`0026_indices_razao`** com `ix_movimentos_estoque_estoque_data (estoque_id, data_movimento, id)` e `ix_movimentos_estoque_linha_data (… tipo_estoque_id, data_movimento, id) include (quantidade)`, criados com `concurrently` pela preparação da tag (`apps/api/src/estoques/indices-razao.ts`); parcial de compras descartado; página de 12 meses de uma loja 0,1 ms quente / 3 ms frio, saldo numa data-base de todas as lojas 0,8–1,3 s, recalcular com pico de heap 348 MB; sem particionamento na Fase 2, com os gatilhos; PDV sem mudança; README da API › decisão 176) | **commitado** |
| F2-B29 exportação em tarefa, em streaming | a fazer |
| F2-B30 `<Relatorio>` paginado no servidor e ícone Tarefas | a fazer |
| F2-B31 Estoque Atual com modal de ajuste | a fazer |
| F2-B32 Movimentação analítica | a fazer |
| F2-B33 Movimentação sintética, exportação e "Ver movimentação" | a fazer |

## Próximo passo

1. **Dono, depois da implantação do PR-6:** em Usuários › Estoques permitidos, liberar o CD **e as lojas que ele
   abastece** para quem monta as cargas: a sugestão de reposição exige o destino permitido (D62 (2)).
2. **PR-7 "Relatórios de estoque"** (F2-B28 a F2-B33): workflow `genesis-bloco` bloco a bloco, no branch
   `claude/blissful-cray-cvroui`; F2-B28 commitado (migração **0026**), próximo o **F2-B29**
   (`docs/planos/fase2-plano.md`). Na implantação do PR-7, a 0026 cria os dois índices do razão com `concurrently`
   (segundos no volume de hoje, sem travar as vendas); a `.sql` da 0026 depois só confere pelo catálogo, sem pegar
   trava na tabela.
3. Numeração das próximas decisões nos READMEs: **API 177**, **ERP 65**, **PDV 81** (confira o último número no próprio
   README antes de acrescentar). Próxima decisão D do roadmap §16: **D63** (D51, D52, D61 e D62 respondidas pelo dono
   em 06/11/2026: as recomendações; `docs/planos/decisoes-do-dono.md`).

## Pendências e lembretes

- **Proteger o SSH da VPS** (dono; `infra/producao/README.md` › Proteger o SSH da VPS): só chave, firewall da
  Hostinger e fail2ban. A chave antiga do GitHub Actions já foi revogada em 06/11/2026 (sobrou só a nova).
- **PRs do Dependabot #1 e #2** (`docker/setup-buildx-action` v3→v4.4.1 e `docker/build-push-action` v6→v7.4.0):
  revisados e juntados em 06/11/2026 com a liberação do dono (os SHAs conferem com as tags oficiais; as versões novas
  só tiram opções que o Genesis não usa — `config`, `config-inline`, `install` e as variáveis `DOCKER_BUILD_NO_SUMMARY`
  e `DOCKER_BUILD_EXPORT_RETENTION_DAYS` — e passam ao Node 24). A primeira "Implantação" depois deles é a que prova a
  montagem das imagens com `load` e o cache `gha`.
- **Verificação em duas etapas (2FA)** na conta do GitHub do dono: o GitHub exige a partir de 19/12/2026.
- **XMLs reais de fornecedores** (para conferir a NF-e com notas de verdade, F2-B53): o dono envia depois; **não
  entram no repositório** (público, D60): ficam em `apps/api/test/fixtures/nfe/reais/` só na máquina de quem testa
  (a pasta está no `.gitignore`) e o teste com eles roda só localmente.
- **Reinício da API em 04/11 18:05 UTC** (travou uma importação): **causa não determinada**. A VPS não reiniciou e o
  `dmesg` não tem OOM (indício, não confirmação). O diagnóstico novo (README da API › decisão 166) está em produção
  desde 06/11: a API registra em `fatal` a exceção não tratada, o sinal e o heap alto; a saúde detalhada tem
  `processo`; o `implantar.sh` guarda o log da API em `/opt/genesis/logs` (`implantar.sh logs`). Na próxima queda:
  `infra/producao/README.md` › A API reiniciou sozinha.
- **Cloud SQL:** converter o trial antes de 26/11/2026.
- **G7 review** (achados menores da aba Sincronização da Central): conferir se algum ficou de fora antes de mexer de
  novo na Central.
