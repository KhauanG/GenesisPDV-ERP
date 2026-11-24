# Operação sem o GitHub Actions — plano (OP-B1 a OP-B3)

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

- **D70-Q1 — Implantação sem o Actions.** (A) **recomendada**: o dono cola **um comando** no terminal da VPS
  (Hostinger › VPS › Terminal); ele baixa o commit da `main` do repositório público, confere, monta as imagens na
  própria VPS (com prioridade baixa, fora do horário de pico), e roda os mesmos `instalar.sh`/`implantar.sh` de
  hoje. (B) esperar a cota voltar e implantar pelo Actions. Padrão até a resposta: (A) disponível, sem obrigar.
- **D70-Q2 — Instalador do PDV sem o runner Windows.** (A) **recomendada**: a sessão monta e testa o instalador
  (publicação `win-x64` pelo .NET no Linux + Inno Setup pelo Wine), confere o sha256 e o dono cria o GitHub Release
  `pdv-vX.Y.Z` com o arquivo (passo a passo) ou autoriza a sessão a criá-lo; a VPS publica do release como hoje.
  (B) montar no PC Windows do dono com o `gerar-instalador.ps1`. (C) esperar a cota. Padrão até a resposta: (A),
  implementada só depois da resposta (OP-B3).

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

### OP-B3 — Instalador do PDV sem o runner Windows (depois da D70-Q2)

- Se (A): `apps/pdv/instalador/linux-wine/gerar-instalador.sh` publica `win-x64` e compila o `GenesisPDV.iss` pelo Inno
  Setup no Wine (versão fixada e sha256 do instalador do Inno conferido), gera o `.sha256` no formato do release, e um
  teste confere o conteúdo do instalador (lista de arquivos, versão). O teste "instala, abre, reinstala e desinstala"
  continua só no Windows: registrado como não coberto, com o roteiro manual de conferência no primeiro caixa.
- Se (B): roteiro no README do PDV para o PC do dono. Se (C): nada.
