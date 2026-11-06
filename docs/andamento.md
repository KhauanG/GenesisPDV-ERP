# Andamento do projeto

> Estado de trabalho para quem continua (pessoa ou sessão do Claude Code). Atualize **no fim de cada bloco** e a cada
> merge/implantação: o que mudou, o que está aberto e o próximo passo. As regras estão no `CLAUDE.md`; o histórico das
> decisões técnicas fica nos READMEs; as respostas do dono, em `docs/planos/decisoes-do-dono.md`.

_Última atualização: 06/11/2026 (PUB-1: versão limpa para o repositório público, D60)._

## Em produção

- **ERP/API:** `main` até o PR #22 (commit `757752e`), implantada em 05/11/2026 13:51 UTC. Migrações de empresa até a
  **0023** (recebimentos). Saúde: https://erp.grupoicebeer.com.br/saude.
- **PDV na página de download:** **0.9.1** (publicado em 05/11/2026 13:25 UTC).
- **Na `main`, ainda não implantado** (#23–#29): a Central do PDV e o **PDV 0.10.0**, o diagnóstico de queda da API
  (README da API › decisão 166), os testes de tempo estáveis no runner, a CI só no push da `main` e o PDV só no Windows.
  **Para implantar (o dono roda, em Actions):** 1) "PDV release" e esperar verde; 2) "Implantação" com `publicar_pdv`
  marcado. A implantação automática (`IMPLANTACAO_AUTOMATICA`) está desligada: a Implantação disparada pela CI sai
  "skipped".
- **Lojas do piloto:** Loja 1 e Petiscaria 2 (CNPJs próprios) e o CD (CNPJ próprio, loja do tipo depósito).

## Fases

| Fase | Situação |
|---|---|
| 0 e 1 (fundação, cadastros, PDV MVP offline, implantação do piloto) | concluídas |
| **2 (produtos e estoque completos)** | em andamento — plano em `docs/planos/fase2-plano.md` (blocos F2-B1..B53, PR-1..PR-12) |
| Central do PDV (engrenagem ⚙, diagnóstico no caixa) | **concluída** — na `main` (#23, PDV 0.10.0 em #24); falta só publicar o 0.10.0 |
| 3, 4, 5 e 3F (fiscal por último) | não iniciadas |
| **Repositório público (D60)** | **PUB-1 implementado**, sem commit (branch `infra/repositorio-publico`, a partir do `funcionalidade/fase2-p5`): limpeza e endurecimento para a cópia pública (resumo abaixo) |

### Repositório público — PUB-1

O dono decidiu (D60, 06/11/2026) um **repositório público novo** com uma versão única limpa, feita a partir desta
branch; o atual fica privado como arquivo. O PUB-1 tirou o relatório do Nuvem3 (a pasta de referências; fica com o
dono), os nomes reais dos atendentes (decisões do dono e o teste `estoques-permitidos`), o IP da VPS e a versão/nome do
container do Traefik (`infra/producao`), o token de exemplo com formato real (SYNC), a saída da VPS dos logs do
Actions (`implantar.sh` guarda o log da API na VPS; `instalar.sh` sem versões e nome de instância; o resumo da
Implantação só com a versão e a página de download), fixou as Actions pelo SHA (Dependabot mensal) e criou o
`CODEOWNERS`. Regra nova no `CLAUDE.md` (repositório público; XMLs reais fora, `reais/` no `.gitignore`).

### Fase 2 — PRs

| PR do plano | Blocos | Situação |
|---|---|---|
| PR-1 base do estoque oficial | B1–B5 | na `main` (#13) |
| PR-2 projeções e tipos de estoque | B6–B8 | na `main` (#17) |
| PR-3 inventário inicial e ajustes | B9–B12 | na `main` (#18) |
| PR-4 fornecedores e recebimento manual | B13–B17 | na `main` (#19) |
| **PR-5 NF-e de fornecedor por XML** | B18–B21 | **PR #30 aberto** (branch `funcionalidade/fase2-p5`), todos os blocos verificados; aguarda a liberação do dono. Traz a migração **0024** (notas de entrada) e as respostas do dono de 05/11 |
| **PR-6 transferências** | **B22+** | **próximo passo** (ver o plano); começar num branch novo a partir da `main` depois do merge do #30 |
| PR-7 em diante | | não iniciados |

## Próximo passo

1. Se o PR #30 já estiver na `main`: criar o branch do PR-6 a partir da `main` e rodar o workflow `genesis-bloco` no
   F2-B22 (`docs/planos/fase2-plano.md`). Se ainda não estiver, perguntar ao dono pela liberação do #30 antes (o PR-6
   depende do núcleo de entrada do PR-5).
2. Numeração das próximas decisões nos READMEs: **API 170**, **ERP 63**, **PDV 81** (confira o último número no próprio
   README antes de acrescentar). Próxima decisão D do roadmap §16: **D61**.

## Pendências e lembretes

- **Publicar o PDV 0.10.0 e implantar a `main`** (ver "Em produção"): o dono roda.
- **PR #30 (PR-5 da Fase 2):** aguarda "autorizo o merge do PR 30".
- **XMLs reais de fornecedores** (para conferir a NF-e com notas de verdade, F2-B53): o dono envia depois; **não
  entram no repositório** (público, D60): ficam em `apps/api/test/fixtures/nfe/reais/` só na máquina de quem testa
  (a pasta está no `.gitignore`) e o teste com eles roda só localmente.
- **Repositório público (D60), com o dono:** 1) juntar o PR #30 e o PUB-1 (commit e PR deste branch, com a liberação
  dele); 2) criar o repositório público novo e enviar a versão única (sem histórico) da `main` limpa; 3) recadastrar lá
  os environments `producao` (só a `main` em *Deployment branches*: é o que impede outro branch de receber os segredos
  `VPS_*`; `infra/producao/README.md` › Passo 3) e `release-pdv` (só a `main` e as tags `pdv-v*`, com o tag ruleset
  `pdv-v*`; README do PDV › decisão 62) com os segredos, a variável `IMPLANTACAO_AUTOMATICA` se quiser, e ligar a
  proteção da `main` só com "PR obrigatório" e **0 aprovações** (sem a revisão do `CODEOWNERS`: os PRs saem da conta
  do dono, que não pode aprovar o próprio PR; CONTRIBUTING.md › Branches); 4) apagar os logs antigos do Actions do repositório
  privado (ficou arquivo) e 5) endurecer o SSH da VPS (`infra/producao/README.md` › Proteger o SSH da VPS). Depois:
  trocar `KhauanG/GenesisPDV-ERP` no `CLAUDE.md`, no `.claude/settings.json` e no `CODEOWNERS` se o nome ou o dono do
  repositório novo mudar, e seguir com o PR-6 (F2-B22) no repositório novo. O orçamento de US$ 10 do Actions deixa de
  ser necessário (runners padrão grátis no público); a CI só no push da `main` (D58/D59) continua.
- **Reinício da API em 04/11 18:05 UTC** (travou uma importação): **causa não determinada**. A VPS não reiniciou e o
  `dmesg` não tem OOM (indício, não confirmação). O diagnóstico novo (#25, README da API › decisão 166) entra na próxima
  implantação: a API registra em `fatal` a exceção não tratada, o sinal e o heap alto; a saúde detalhada ganha
  `processo`; o `implantar.sh` guarda o log da API em `/opt/genesis/logs` (`implantar.sh logs`). Na próxima queda:
  `infra/producao/README.md` › A API reiniciou sozinha.
- **Cloud SQL:** converter o trial antes de 26/11/2026.
- **G7 review** (achados menores da aba Sincronização da Central): conferir se algum ficou de fora antes de mexer de
  novo na Central.
