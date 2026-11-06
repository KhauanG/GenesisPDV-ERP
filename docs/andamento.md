# Andamento do projeto

> Estado de trabalho para quem continua (pessoa ou sessão do Claude Code). Atualize **no fim de cada bloco** e a cada
> merge/implantação: o que mudou, o que está aberto e o próximo passo. As regras estão no `CLAUDE.md`; o histórico das
> decisões técnicas fica nos READMEs; as respostas do dono, em `docs/planos/decisoes-do-dono.md`.

_Última atualização: 06/11/2026 (PR-6: F2-B22 a F2-B26 commitados)._

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

- **ERP/API:** a `main` deste repositório (commit `a66397f`), implantada em 06/11/2026 16:27 UTC pela "Implantação"
  daqui (a primeira com a chave SSH nova). Migrações de empresa até a **0024** (notas de entrada). Saúde:
  https://erp.grupoicebeer.com.br/saude.
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
| **PR-6 transferências** | **B22–B27** | **em andamento** no branch `claude/blissful-cray-cvroui` (abaixo) |
| PR-7 em diante | | não iniciados |

### PR-6 — blocos

| Bloco | Situação |
|---|---|
| F2-B22 schema e contratos (migração `0025_transferencias`, `packages/shared/src/transferencias.ts`; README da API › decisão 170) | **commitado** (`9d8ed39`) |
| F2-B23 rascunho, enviar e cancelar (`apps/api/src/transferencias/`, sem migração; travas de inativar/excluir estoque e tipo de estoque; NF-e de fora depois do envio; README da API › decisão 171) | **commitado** |
| F2-B24 receber, divergência e modo de uma etapa (`apps/api/src/transferencias/recebimento.ts`, rotas `receber` e `tratar-divergencia`, sem migração; perda = retorno + acerto de Saída `perda_transferencia` que estorna o retorno (mesmo lote, custo do envio; efeito líquido zero) e não se estorna; lote preso à origem → lote do mesmo código e validade no destino; README da API › decisão 172; D61 padrão até a confirmação do dono) | **commitado** |
| F2-B25 sugestão de reposição (`GET /transferencias/sugestao-reposicao`; `apps/api/src/transferencias/reposicao.ts` e `em-transito.ts` — a subconsulta do em trânsito que o F2-B26 reaproveita —, sem migração; chave `estoque.reposicao_arredonda_embalagem` = Sim, D52 padrão até a confirmação do dono; README da API › decisão 173) | **commitado** |
| F2-B26 em trânsito, divergência a tratar e alerta (`em-transito.ts`: `sqlDivergenciaATratar`, `sqlPendenciasTransferencia`, `sqlSaldosComPendencias`; `apps/api/src/transferencias/alertas.ts` e a fila `genesis-alerta-transferencias` a cada hora; colunas em `GET /produtos/:id/saldos`, `GET /saldos-estoque`, no bloco Estoque do produto e na tela Saldos; a divergência fica na origem, fora do em trânsito; chave `estoque.transferencia_alerta_dias` = 3, padrão aplicado sem pergunta; sem migração; README da API › decisão 174; README do ERP › decisão 63) | **commitado** |
| F2-B27 telas e romaneio | não iniciado |

## Próximo passo

1. Rodar o workflow `genesis-bloco` no F2-B27 (telas e romaneio; branch `claude/blissful-cray-cvroui`,
   `docs/planos/fase2-plano.md`). A tela da transferência pode mostrar o alerta `TRANSFERENCIA_PARADA` aberto (README
   da API › decisão 174).
2. Perguntar ao dono no fechamento do PR-6: D51 (perda na transferência), D52 (a sugestão de reposição arredonda ao
   fardo) e D61 (quem trata a diferença, o modo de uma etapa sem o destino e o lote preso à origem), todas com o padrão
   aplicado.
3. Numeração das próximas decisões nos READMEs: **API 175**, **ERP 64**, **PDV 81** (confira o último número no próprio
   README antes de acrescentar). Próxima decisão D do roadmap §16: **D62**.

## Pendências e lembretes

- **Proteger o SSH da VPS** (dono; `infra/producao/README.md` › Proteger o SSH da VPS): só chave, firewall da
  Hostinger e fail2ban. A chave antiga do GitHub Actions já foi revogada em 06/11/2026 (sobrou só a nova).
- **PRs do Dependabot #1 e #2** (`docker/setup-buildx-action` v3→v4 e `docker/build-push-action` v6→v7): mudanças de
  versão principal das Actions que montam as imagens Docker; revisar o que mudou antes de juntar (não juntar sem
  revisão).
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
