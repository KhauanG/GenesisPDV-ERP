# Operação sem o GitHub Actions — plano (OP-B1 a OP-B6)

Pedido do dono (24/11/2026): "minha cota de Actions acabou, continue o projeto, usando sandbox para testes, para não
precisarmos dos actions". Decisão **D70** (roadmap §16; `docs/planos/decisoes-do-dono.md`).

## Estado atual

- A CI (`.github/workflows/ci.yml`) roda no push da `main` e à mão: jobs `ts`, `integracao-pg18`, `imagens`
  (imagens Docker, shellcheck, testes do backup e dos logs do `implantar.sh`, compose de produção), `pdv`
  (`windows-latest`: build, impressora de teste, testes, instalador e o teste dele), `pdv-formatacao` e `e2e-sync`.
- A implantação (`.github/workflows/implantacao.yml`) monta as 3 imagens no runner, manda por SSH
  (`docker save | ssh docker load`), copia os arquivos da versão para `/opt/genesis/releases/<versão>`, roda o
  `instalar.sh` e o `implantar.sh implantar <versão>`, publica o instalador do PDV do último GitHub Release e confere as
  URLs públicas. O release do PDV (`pdv-release.yml`) monta o instalador no `windows-latest` (Inno Setup) e cria o
  GitHub Release `pdv-vX.Y.Z`.
- Sem cota de Actions, nenhum desses três roda. As sessões do Claude Code têm Docker (o `dockerd` sobe na sessão),
  PostgreSQL 16 local, o .NET SDK e o `shellcheck`; o PostgreSQL 18 vem da imagem `postgres:18-alpine`.

## Fora do escopo

- Mudar a arquitetura de produção (VPS, Traefik, Cloud SQL) ou a ordem das fases.
- Disparar ou apagar workflows do GitHub; os arquivos de `.github/workflows` continuam valendo para quando a cota
  voltar (nada é removido).
- Qualquer credencial na sessão: a sessão nunca recebe a chave SSH da VPS nem segredo de produção.

## Perguntas ao dono

- **D70-Q1 = (A) e D70-Q2 = (A) — respondidas (24/11/2026), com autonomia para a sessão:** "Eu autorizo você a fazer
  as duas coisas de forma autonoma, usar o VPS para os comandos de terminal e tambem tudo relacionado ao release no
  GitHub" (`docs/planos/decisoes-do-dono.md`). A sessão não alcança a VPS por SSH (só HTTPS sai da sessão) e não
  recebe credencial da produção: por isso o OP-B4 (a VPS busca o pedido no repositório público, nunca o contrário).
  O merge na `main` continua só com a liberação do dono; a sessão só pede a implantação de commit que já está nela.

## Blocos

### OP-B1 — Verificação local completa (substitui a CI)

- **Objetivo:** um comando, `scripts/verificar-local.sh` (e `pnpm verificar:local`), que reproduz **todos os jobs
  da CI que rodam em Linux**, na ordem e com os mesmos comandos do `ci.yml` (leia o `ci.yml` e o
  `.github/scripts/mudancas.sh`), e imprime uma tabela final job × resultado × tempo, com saída ≠ 0 se algum falhar.
  - `ts`: install frozen, format, lint, typecheck, schemas Drizzle × migrações versionadas, `verificar:esquema-pdv`,
    testes unitários (shared, API, ERP) e build.
  - integração da API no **PostgreSQL 16** (o local) **e no 18** (container `postgres:18-alpine` numa porta livre,
    derrubado no fim, mesmo com falha), com as mesmas variáveis do job `integracao-pg18`.
  - `imagens`: build das 3 imagens Docker (sem push), shellcheck dos scripts de produção, testes do backup e dos
    logs do `implantar.sh`, validação do compose de produção (inclusive o teto somado de 2,5 GB).
  - PDV no Linux: `dotnet restore --locked-mode`, build Release, testes (os que exigem Windows ficam pulados, como
    hoje no Linux) e `dotnet format --verify-no-changes`, de dentro de `apps/pdv`.
  - `e2e-sync`: API local + PDV headless (`apps/api/test/e2e-pdv/rodar.sh`).
  - Opções: `--so <job,...>`, `--pular <job,...>`, `--mudancas <base>` (usa o `mudancas.sh` para rodar só o que mudou,
    como a CI). Sobe o `dockerd` e o PostgreSQL 16 local se não estiverem no ar (como o hook da sessão). Logs de cada
    job em `.verificacao-local/` (no `.gitignore`).
- **Documentação:** `CONTRIBUTING.md` › CI e `CLAUDE.md` (Checks e "GitHub nas sessões na nuvem"): enquanto não houver
  cota (D70), o `verificar-local.sh` completo é o portão antes de cada PR e antes de cada merge na `main`, e o
  resultado (tabela) vai no corpo do PR. O que só o Windows cobre (testes do spooler/impressora reais, instalador e
  o teste dele) fica registrado como **não coberto** até o OP-B3.
- **Pronto:** o script roda inteiro na sessão, verde, na `main` atual; um teste do próprio script com um job forçado a
  falhar mostra a tabela e a saída ≠ 0; o PostgreSQL 18 sai sempre (trap).

### OP-B2 — Implantação pela VPS, sem o Actions

- **Objetivo:** `infra/producao/implantar-sem-actions.sh <commit-da-main>` — o dono roda como root no terminal da VPS
  (um comando, passo a passo no README da produção). Ele reproduz o `implantacao.yml`, com as mesmas conferências:
  1. o commit tem o formato aceito pelo workflow (12 a 40 hexadecimais) e é **ancestral da `origin/main`** do
     repositório público `https://github.com/KhauanG/GenesisPDV-ERP` (clone ou fetch num diretório próprio,
     `/opt/genesis/fonte`, root 700, sem token);
  2. a versão é o commit de 12 caracteres, igual ao workflow;
  3. monta as 3 imagens com os mesmos Dockerfiles e tags (`genesis-api:<versão>`, `genesis-web:<versão>`,
     `genesis-backup:<versão>`), com `nice`/`ionice` e aviso de que leva alguns minutos e usa CPU da VPS;
  4. copia `docker-compose.yml`, `implantar.sh`, `instalar.sh`, `compose.env.exemplo` e `genesis.env.exemplo` para
     `/opt/genesis/releases/<versão>` (chmod +x nos .sh);
  5. roda `instalar.sh` e `implantar.sh implantar <versão>` (que já faz proxy do Cloud SQL, migrações, troca de versão,
     saúde e a volta automática);
  6. opcional `--publicar-pdv`: baixa do GitHub Release mais recente `pdv-v*` (API pública) o instalador e o `.sha256`,
     confere e chama `implantar.sh pdv publicar` exatamente como o workflow (mesmo formato do sha256);
  7. confere as URLs públicas como o passo "Conferência pelas URLs públicas" do workflow e imprime o resumo (sem
     imprimir segredo nem estado sensível).
  - Recusa se não for root, se o commit não for da `main`, se faltar espaço em disco (limiar documentado) ou se já
    houver outra implantação rodando (a trava do `implantar.sh`). `--simular` mostra o que faria sem montar nem
    trocar nada. Limpa imagens antigas do Genesis além das N mais recentes (as que o `implantar.sh voltar` precisa
    continuam).
- **Teste na sessão:** `shellcheck`; teste de unidade com `docker`, `git`, `curl` e o `implantar.sh` falsos
  (formato do commit, ancestralidade, ordem das etapas, `--simular`, `--publicar-pdv` com sha256 certo e errado); e
  um ensaio de ponta a ponta no Docker da sessão com o `testar-local.sh` (raiz `/opt/genesis` falsa num diretório
  temporário, sem tocar produção).
- **Documentação:** `infra/producao/README.md` › nova seção "Implantar sem o GitHub Actions (D70)", com o passo a passo
  para o dono (abrir o terminal da VPS, colar o comando, o que esperar, como voltar com `implantar.sh voltar`).
- **Pronto:** testes acima verdes; o README tem o roteiro; nada muda no `implantacao.yml`.

### OP-B3 — Instalador do PDV sem o runner Windows, e o release pela sessão (D70-Q2 = A)

- **Objetivo:** `apps/pdv/instalador/linux-wine/gerar-instalador.sh [--versao X.Y.Z]` monta, no Linux da sessão, o
  mesmo instalador que o `pdv-release.yml` monta no Windows (leia o workflow, o `gerar-instalador.ps1` e o
  `GenesisPDV.iss`): `dotnet publish` `win-x64` com as mesmas opções (autocontido, `PDV_URL_API` padrão igual), e o
  `GenesisPDV.iss` compilado pelo Inno Setup **6 (versão fixada, a mesma do script do Windows)** no Wine (`wine64`
  do apt; o instalador do Inno baixado de `files.jrsoftware.org` com o **sha256 fixado no script e conferido** antes de
  rodar, num prefixo do Wine próprio e descartável). Saída: `GenesisPDV-Setup-X.Y.Z.exe` e o `.exe.sha256` no mesmo
  formato do release (confira no `pdv-release.yml` e no `implantar.sh pdv publicar`). Sem assinatura (o release atual
  já sai sem certificado: confira com `osslsigncode verify` no `pdv-v0.13.0` publicado; se ele estiver assinado,
  pare e registre como não coberto). Nada vai para o repositório além dos scripts (saída em pasta ignorada).
- **Teste na sessão:** um teste confere o instalador gerado sem instalar: é um PE do Windows, a versão do arquivo é a
  pedida, a lista de arquivos dentro dele (extraída com `innoextract` do apt) bate com a da publicação `win-x64` e com
  a do instalador `pdv-v0.13.0` publicado (só as diferenças esperadas de versão), e o sha256 confere. O "instala, abre,
  reinstala e desinstala" (`testar-instalador.ps1`) continua só no Windows: registrado como **não coberto**, com o
  roteiro manual de conferência no primeiro caixa (README do PDV).
- **Release pela sessão:** `apps/pdv/instalador/linux-wine/publicar-release.sh X.Y.Z` cria, pela API REST do GitHub
  (`gh api`), a tag `pdv-vX.Y.Z` num commit **da `main`** (recusa se não for ancestral da `origin/main`, se a versão
  não for a do `apps/pdv/Directory.Build.props` desse commit ou se o release já tiver arquivos, como o workflow) e o
  release com o `.exe` e o `.exe.sha256` (upload em `uploads.github.com`), com as mesmas notas do workflow. Teste com o
  `gh` falso (a ordem das chamadas e as recusas); nenhum release de verdade no teste.
- **Documentação:** README do PDV (decisão nova, "Instalar na loja" com o caminho sem o Actions), `CONTRIBUTING.md`,
  e o `verificar-local.sh` ganha o job opcional `pdv-instalador` (fora da rodada padrão se o Wine não estiver
  instalado, com o aviso).
- **Pronto:** o instalador da versão atual (0.13.0) gerado na sessão passa no teste acima; os testes do
  `publicar-release.sh` verdes; nenhum release criado por este bloco.

### OP-B4 — Vigia da implantação na VPS (a sessão pede, a VPS busca)

- **Por quê:** o dono autorizou a sessão a implantar (D70), mas a sessão não abre conexão com a VPS e não deve ter
  credencial dela. O vigia inverte o sentido: a **VPS** consulta o repositório **público** (só leitura, sem token) e
  implanta o que a `main` pedir. Ninguém de fora do repositório consegue pedir: criar tag exige permissão de escrita
  nele (as mesmas pessoas que já podem juntar na `main`).
- **Pedido:** uma tag no repositório público com o nome `implantar/<AAAAMMDD-HHMMSS>` (implantar) ou
  `implantar-pdv/<AAAAMMDD-HHMMSS>` (implantar e publicar o PDV do último release, o `--publicar-pdv`), apontando para
  um commit **ancestral da `origin/main`** (o `implantar-sem-actions.sh` já recusa o resto). Pedidos antigos não
  rodam: na instalação, o vigia marca as tags que já existem como vistas; depois, roda só o pedido mais novo ainda não
  visto e marca os anteriores como pulados. Pedido de um commit mais velho que o atual é permitido (é a "volta").
- **Peças (em `infra/producao/vigia/`):** `vigia-implantacao.sh` (uma rodada: `git ls-remote --tags` do repositório
  público, escolhe o pedido, chama `implantar-sem-actions.sh [--publicar-pdv] <commit>` com a trava de sempre, grava o
  estado em `/opt/genesis/vigia/` root 700); `genesis-vigia.service` + `genesis-vigia.timer` do systemd (a cada 2
  minutos, `Nice`/`IOSchedulingClass=idle`, sem rede além do HTTPS de saída que a VPS já tem); `instalar-vigia.sh`
  idempotente (instala/atualiza as unidades, marca as tags existentes como vistas, liga o timer) e
  `--desligar`/`--estado`. Depois de cada implantação que deu certo, o vigia se atualiza com a versão dele do commit
  implantado (só se o arquivo mudou, conferido pelo sha256; uma falha aqui não desfaz a implantação).
- **Resultado visível para a sessão:** o único dado novo público é `https://<DOWNLOAD_DOMINIO>/implantacao/estado.json`
  com **só** `{pedido, commit (12), resultado: recebido|em_andamento|ok|falhou|recusado, inicio, fim}` — o nome da
  tag e o commit já são públicos no repositório; nada de log, versão de software, estado da VPS ou mensagem de erro
  (isso fica no log do vigia na VPS, que o dono vê com `instalar-vigia.sh --estado`). Sirva pelo mesmo caminho do
  `pdv/atual.json` (descubra como o `implantar.sh pdv publicar` grava a página de download e use o mesmo volume).
  Registre no CLAUDE.md que este arquivo é a única saída pública da VPS, por decisão do dono (D70).
- **Lado da sessão:** `scripts/pedir-implantacao.sh <commit> [--publicar-pdv]` confere que o commit está na
  `origin/main`, cria a tag pela API REST (`gh api repos/<repo>/git/refs`), e acompanha o `estado.json` e o
  `/saude` (o `no_ar_desde` muda) até `ok`/`falhou`/`recusado` ou o tempo limite, imprimindo o resultado. Teste com
  `gh` e `curl` falsos.
- **Teste na sessão:** shellcheck; teste de unidade do vigia com `git`, `implantar-sem-actions.sh` e `systemctl`
  falsos (escolha do pedido, pedidos antigos ignorados, trava ocupada = tenta na próxima rodada, recusa de commit fora
  da `main`, `implantar-pdv/` passa o `--publicar-pdv`, estado.json só com os campos permitidos, autoatualização);
  `systemd-analyze verify` nas unidades.
- **Documentação:** README da produção › "Vigia da implantação" com o passo a passo do dono para instalar (um
  comando no terminal da VPS, o que esperar, como desligar e como ver o log); README da API (decisão nova);
  CLAUDE.md (como a sessão pede a implantação e confere o resultado).
- **Pronto:** testes verdes; o passo a passo no README; nada roda na produção até o dono instalar.

### OP-B5 — Memória do container de tarefa

- **Por quê:** no ensaio do OP-B2 (`testar-local.sh --sem-actions`), o `implantar.sh tarefa empresa-criar` passou dos
  128 MB do `genesis-tarefa` (o kernel registrou "Memory cgroup out of memory"; pico de ~114 MiB numa tarefa que o
  README dava como 82 MiB). Em produção, o "criar empresa" (ou uma migração maior) pode falhar por falta de memória.
- **Objetivo:** medir o pico de cada comando da tarefa (`migrar-controle`, migrações de empresa, `empresa-criar`,
  `admin-criar`, as referências) com a imagem de produção, separar o que é da sessão (o certificado extra do proxy nas
  imagens base) do que é da aplicação, e escolher: reduzir o pico (o que carrega memória à toa) e/ou redistribuir os
  limites **sem passar do teto de 2,5 GB somados** da decisão do dono de 03/11/2026 (ex.: tarefa 192 MB e API
  1984 MB, o heap de 1,5 GB da API continua cabendo). O CI e o teste local já conferem a soma.
- **Teste:** o `testar-local.sh` passa inteiro, sem ajuste, com o limite final; o pico medido fica registrado no
  comentário do compose e no README da produção.
- **Pronto:** ensaio `testar-local.sh --sem-actions` verde no repositório como está.

### OP-B6 — `--acompanhar` sem perder o fim da saída (correção da CI da `main`)

- **Por quê:** na CI da `main` depois do merge do PR-16 (25/11/2026), o passo "Implantação sem o Actions (testes de
  unidade)" falhou no cenário "Fora do terminal": o `--acompanhar` mostrou a implantação até a etapa 6 e saiu sem o
  resumo ("Versão: … no ar."), embora a implantação tenha terminado. Na sessão o teste passa (6 rodadas seguidas). O
  `--acompanhar` e o `desacoplar` dependem do `tail -f --pid`, que pode encerrar sem ler o que foi escrito no log
  pouco antes de o processo da implantação sair (corrida entre a última escrita e a conferência do pid). O código de
  saída já vinha certo (o `wait`); só a saída mostrada no terminal ficava cortada.
- **Objetivo:** trocar o `tail -f --pid` por um acompanhamento que **sempre** mostra o log inteiro: confere se o
  processo ainda vive **antes** de ler o que falta, e lê uma última vez depois de ele sair (inclusive o processo filho
  já terminado e ainda não recolhido pelo bash — zumbi — conta como terminado). Vale para o `desacoplar` e para o
  `--acompanhar`; o Ctrl+C continua só parando de mostrar. Procure o mesmo padrão no `vigia-implantacao.sh` e nos
  outros scripts de `infra/producao` e `scripts/`.
- **Teste:** um teste que reproduz a corrida de forma determinística (o processo escreve as últimas linhas e sai logo
  em seguida, repetido muitas vezes, ou com um dublê de `kill`/`tail` que force a ordem ruim) e falha com o código
  antigo; o cenário "Fora do terminal" continua verde; shellcheck.
- **Pronto:** testes verdes; o README da produção e a decisão 215 do README da API atualizados.

### OP-B7 — Vigia: implantar cada commit novo da `main` (D119 = A)

- **Por quê:** em 25/11/2026 a sessão não conseguiu criar a tag `implantar/…` (a rede da sessão recusa escrita no
  caminho `git/refs` da API do GitHub; criar e juntar PR funcionam). O dono decidiu (D119 = A): o merge que ele libera
  vale também como "pode implantar".
- **Regras do vigia (`infra/producao/vigia/vigia-implantacao.sh`):**
  - a cada rodada, `git fetch` só da `main` do repositório público (como hoje); se a ponta da `main` é um commit que o
    vigia **ainda não tratou**, ele o implanta com o `implantar-sem-actions.sh <commit>`. **Uma vez por commit**: um
    commit que falhou, foi recusado ou foi implantado não roda de novo sozinho (o próximo merge, sim). Isso também
    impede que o vigia desfaça uma volta feita pelo dono (`implantar.sh voltar`): a ponta da `main` já foi tratada.
  - **janela:** não começa implantação automática entre **17:00 e 23:59** no horário de Brasília
    (`TZ=America/Sao_Paulo`); configurável num arquivo do vigia (root 600, padrão `17-24`), com o formato conferido.
    Uma implantação que já começou não é interrompida.
  - **instalação:** se a versão no ar (o `versoes/atual` do `implantar.sh`) já é a ponta da `main`, marca a ponta como
    tratada; senão, deixa pendente e a implanta na próxima rodada dentro da janela (é o caso logo depois do merge deste
    bloco: o dono reinstala o vigia e a `main` nova entra no ar sozinha).
  - **PDV:** quando o release `pdv-vX.Y.Z` publicado mais novo (não rascunho, não pré-release; a mesma regra do
    `--publicar-pdv` de hoje) tem sha256 diferente do que a página de download serve, publica-o — junto com a
    implantação, se houver uma, ou sozinho, **sem** remontar nem trocar a versão (crie no `implantar-sem-actions.sh`
    uma opção só para isso, com as mesmas conferências do `--publicar-pdv`, ou chame o `implantar.sh pdv publicar` da
    versão atual com o download e o sha256 conferidos como hoje). Um release com arquivo inválido não é tentado de novo
    a cada rodada (fica registrado no log e no estado).
  - **tag de pedido do dono:** continua aceita como hoje (pedido manual: forçar ou voltar uma versão), roda na hora
    (fora da janela também) e tem prioridade sobre o automático da mesma rodada.
  - o `estado.json` continua só com `{pedido, commit, resultado, inicio, fim}`; no automático, `pedido` = `main` (ou
    `pdv` na publicação só do PDV). Nada de log, versão de software ou erro nele.
  - a autoatualização do vigia continua (depois de um `ok`, com o script do commit implantado).
- **Lado da sessão:** `scripts/pedir-implantacao.sh` vira só acompanhamento (o nome pode mudar para
  `scripts/acompanhar-implantacao.sh`; deixe o antigo avisando): dado um commit da `main`, espera o `estado.json`
  mostrar esse commit com `ok`/`falhou`/`recusado` (e o `no_ar_desde` do `/saude` mudar), imprime a hora prevista
  quando estiver dentro da janela, e nunca cria tag. Atualize o CLAUDE.md (Regras de trabalho › Deploy em produção):
  depois de cada merge liberado pelo dono, a sessão avisa o dono, acompanha e conta o resultado.
- **Teste:** os do vigia e do acompanhamento com dublês (git real num repositório local; `date`/`TZ` controlados):
  ponta nova implantada uma vez só; falha não repete; volta do dono não é desfeita; janela (16:59 roda, 17:00 e 23:59
  esperam, 00:00 roda); instalação com a versão no ar igual ou diferente da ponta; PDV novo publicado sozinho, sem
  rebuild; release inválido não repete; tag manual com prioridade e fora da janela; `estado.json` só com os campos
  permitidos; shellcheck; `systemd-analyze verify`.
- **Documentação:** README da produção › Vigia da implantação (o que o dono faz: reinstalar uma vez depois do merge;
  como desligar; como forçar ou voltar com a tag pelo site do GitHub), README da API (decisão nova), CLAUDE.md.
- **Pronto:** testes verdes; nada roda na produção até o dono reinstalar o vigia.

### OP-B8 — Release do PDV pelo site do GitHub (D120)

- **Objetivo:** documentar e preparar o caminho do próximo release (PDV 0.14.0) sem a sessão escrever no GitHub:
  `apps/pdv/instalador/linux-wine/preparar-release-manual.sh X.Y.Z` (ou uma opção do `publicar-release.sh`) faz as
  mesmas conferências de antes de publicar (commit da `main`, versão do `Directory.Build.props`, árvore limpa, o
  `.conferido` e o sha256) e deixa numa pasta os dois arquivos a anexar e o texto das notas do release; o README do
  PDV ganha o passo a passo do dono (desligar o workflow "PDV release" na aba Actions — D71 —, Releases › Draft a new
  release, a tag `pdv-vX.Y.Z` nova na `main` no commit indicado, anexar os dois arquivos, publicar) e o que a sessão
  confere depois (a API pública de releases e, depois do vigia, o `pdv/atual.json`). O `publicar-release.sh` continua
  para quando a sessão tiver escrita no GitHub (aviso claro quando a escrita é recusada pela rede da sessão).
- **Teste:** com dublês, as recusas do preparo (fora da `main`, versão errada, sem conferência) e o conteúdo da pasta.
- **Pronto:** teste verde; o roteiro no README do PDV; CONTRIBUTING.md e CLAUDE.md apontam para ele.

### OP-B9 — O vigia se atualiza por inteiro a cada implantação (D121)

- **Objetivo:** depois da reinstalação do dono no PR-16b, nenhuma mudança do vigia volta a pedir comando na VPS.
  Hoje, depois de uma implantação "ok", o vigia só troca o próprio `vigia-implantacao.sh` pelo do commit implantado;
  a unidade e o timer do systemd (`genesis-vigia.service`, `genesis-vigia.timer`) e o resto do que o
  `instalar-vigia.sh` prepara (a cópia do `implantar-sem-actions.sh`, a janela, a pasta pública do estado) só mudam
  quando o dono reinstala. Passa a ser assim: depois do "ok", o vigia roda a atualização do commit implantado (por
  exemplo, `instalar-vigia.sh --autoatualizar` daquele commit, fora do terminal, sem a etapa que dá os pedidos
  antigos por vistos e sem mexer nos tratados nem na janela que existe), que troca só o que mudou, por rename, e faz o
  `daemon-reload`. Regras: a unidade e o timer novos só entram depois de conferidos (`systemd-analyze verify` e o
  formato esperado); se a conferência ou a troca falhar, fica tudo como estava (a implantação continua "ok", o motivo
  vai só para o `vigia.log`, nada no `estado.json`) e o vigia continua rodando no agendamento antigo; a rodada em
  andamento termina com os arquivos antigos; um commit anterior ao OP-B9 (uma volta do dono) mantém o comportamento
  de hoje (só o programa do vigia, como antes) e não desfaz a instalação; o timer não pode ficar desligado nem
  duplicado depois da troca. O `instalar-vigia.sh` à mão continua valendo (primeira instalação, `--estado`,
  `--desligar`).
- **Teste:** com dublês (o systemd e o git locais, como no `testar-vigia-implantacao.sh`): a unidade ou o timer que
  mudam no commit implantado são trocados e recarregados; os iguais não mexem em nada; a unidade inválida é recusada
  e a antiga fica; uma volta a um commit sem o `--autoatualizar` não quebra; o `--desligar` do dono é respeitado (o
  vigia desligado continua desligado); nada vai ao `estado.json`.
- **Pronto:** testes verdes; README de `infra/producao` › Vigia da implantação (a reinstalação do PR-16b é a última
  feita à mão; quando ainda é preciso o comando: só se o vigia parou ou foi desligado), README da API › decisões,
  CLAUDE.md; nada muda na API, no ERP, no PDV nem nas migrações.
