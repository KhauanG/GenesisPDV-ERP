# Produção: VPS da Hostinger + Cloud SQL (Implantação do piloto, I1 e I1b)

O Genesis do piloto roda na VPS KVM 2 da Hostinger (Campinas, Ubuntu 24.04), ao lado do projeto `icebeer` (n8n,
Evolution, painel...), atrás do **Traefik v3 que já existe lá**. O banco é o **Google Cloud SQL PostgreSQL 18**
(São Paulo), alcançado só pelo Cloud SQL Auth Proxy. O deploy é pelo **GitHub Actions** por SSH. Desde o I1b, um
container de backup faz o `pg_dump` diário de todos os bancos para o bucket ([Backup](#backup-i1b)) e a API tem um
painel para o monitoramento, protegido por token ([Monitoramento](#monitoramento-hermes-i1b)). A página
`download.<domínio>` oferece o instalador do PDV do último GitHub Release, publicado pela própria implantação
([Página de download do PDV](#página-de-download-do-pdv)).

```
Internet ──443──▶ Traefik v3 (rede "proxy")
                   ├─ erp.grupoicebeer.com.br/api/*, /saude ─▶ genesis-api :3000 ─┐
                   ├─ erp.grupoicebeer.com.br (resto) ───────▶ genesis-web :8080   │ rede genesis-interna
                   ├─ api.grupoicebeer.com.br ──────────────▶ genesis-api :3000   │
                   └─ download.grupoicebeer.com.br ─────────▶ genesis-web :8080   ▼
                                                    genesis-cloudsql-proxy :5432 ──TLS──▶ Cloud SQL (PostgreSQL 18)
                                                                ▲
                                     genesis-backup (04:30) ────┘ pg_dump ──HTTPS──▶ bucket GCS backups/AAAA-MM-DD/
```

| Container | Imagem | Memória (teto) | Observação |
|---|---|---|---|
| `genesis-api` | `genesis-api:<versão>` (apps/api/Dockerfile) | 1984 MB (heap do Node 1,5 GB) | Usuário `node`, sistema de arquivos só leitura, healthcheck em `/saude` |
| `genesis-web` | `genesis-web:<versão>` (apps/erp-web/Dockerfile) | 128 MB | nginx sem root (uid 101), ERP estático e a página de download (o instalador do PDV vem de uma pasta do host, só leitura) |
| `genesis-cloudsql-proxy` | `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.21.0-alpine` | 192 MB | Usuário nonroot (65532), healthcheck em `/readiness` |
| `genesis-backup` | `genesis-backup:<versão>` (backup/Dockerfile) | 64 MB | Usuário `postgres` (70), clientes do PostgreSQL 18; `pg_dump` diário às 04:30 para o bucket |
| `genesis-tarefa` | a mesma da API | 192 MB (heap do Node 128 MB), só enquanto roda | Migrações na implantação e comandos (`admin-criar`, `empresa-criar`...); sem o healthcheck da imagem |

Soma dos limites: **2,5 GB** (decisão do dono, 03/11/2026: limite somado dos containers), contando a tarefa — ela
roda com a API no ar (na implantação, a versão anterior continua no ar durante as migrações): 1984 + 128 + 192 + 64 +
192 = 2560 MiB. No I1 o proxy tinha 256 MB; no I1b ele cedeu 64 MB ao backup (o pico medido do proxy é de dezenas de
MB; [Decisões técnicas (I1b)](#decisões-técnicas-i1b)). A API tinha 2 GB; no OP-B5 ela cedeu 64 MB à tarefa, que
passava dos 128 MB ao migrar 4 empresas
([Decisões técnicas (memória da tarefa, OP-B5)](#decisões-técnicas-memória-da-tarefa-op-b5-24112026)); só na primeira
implantação depois dele (e na seguinte a um `voltar` para uma versão anterior ao OP-B5) a soma passa por alguns
minutos a 2624 MiB, porque as migrações rodam com a tarefa nova enquanto a API antiga, de 2 GB, continua no ar. Sem
swap além do limite: se um container estourar, ele reinicia (`restart: unless-stopped`; a tarefa só falha) em vez de
deixar a VPS lenta. Nenhuma porta é publicada no host e nada do projeto `icebeer` é tocado; o Genesis só entra na rede `proxy`
e se anuncia ao Traefik por labels.

## Arquivos desta pasta

| Arquivo | Para quê |
|---|---|
| `docker-compose.yml` | Projeto Compose `genesis` (os cinco serviços acima, labels do Traefik, limites, logs com rotação) |
| `compose.env.exemplo` | Modelo do `/opt/genesis/.env`: domínios, rede do Traefik, instância do Cloud SQL, versão em produção |
| `genesis.env.exemplo` | Modelo do `/opt/genesis/genesis.env`: configuração **não secreta** da API (AMBIENTE, TRUST_PROXY, CORS...) |
| `instalar.sh` | Preparação da VPS, idempotente: confere pré-requisitos, gera os segredos da aplicação, acerta permissões |
| `implantar.sh` | `implantar <versão>`, `voltar`, `estado`, `tarefa <comando>`, `backup <...>`, `token-monitor`, `pdv <atual\|publicar\|retirar>`, `logs [guardar]` |
| `implantar-sem-actions.sh` | Implantação pela própria VPS, sem o GitHub Actions (D70): baixa o commit da `main`, monta as imagens na VPS e roda o `instalar.sh` e o `implantar.sh` ([Implantar sem o GitHub Actions](#implantar-sem-o-github-actions-d70)) |
| `vigia/` | Vigia da implantação (D70, OP-B4 e OP-B7): `vigia-implantacao.sh` (uma rodada: a tag de pedido do dono, a ponta nova da `main` fora da janela ou o release novo do PDV → `implantar-sem-actions.sh`), `genesis-vigia.service` + `genesis-vigia.timer` (a cada 2 minutos) e `instalar-vigia.sh` (instalar, `--estado`, `--desligar` e o `--autoatualizar` que o vigia roda depois de cada `ok`, OP-B9; uma cópia dele fica em `/opt/genesis/vigia`) ([Vigia da implantação](#vigia-da-implantação-d70-op-b4-e-op-b7)) |
| `backup/` | Imagem do `genesis-backup` (`Dockerfile`), o script `genesis-backup.sh` (agendar, agora, estado, listar, restaurar) e os testes de unidade dele (`testar-genesis-backup.sh`, sem Docker; rodam no CI) |
| `teste/` | Teste local da stack (override com PostgreSQL 18, Traefik e S3 locais, `testar-local.sh`; com `--sem-actions`, também o ensaio do `implantar-sem-actions.sh`) e os testes de unidade dos logs guardados pelo `implantar.sh` (`testar-implantar-logs.sh`), do `implantar-sem-actions.sh` (`testar-implantar-sem-actions.sh`) e do vigia da implantação (`testar-vigia-implantacao.sh`), sem Docker; rodam no CI e no `scripts/verificar-local.sh` |

Na VPS fica assim (o workflow cria tudo, menos os segredos do Google):

```
/opt/genesis/
  .env                     # interpolação do Compose (compose.env.exemplo)
  genesis.env              # configuração não secreta da API (genesis.env.exemplo)
  docker-compose.yml  ->   releases/<versão atual>/docker-compose.yml
  implantar.sh        ->   releases/<versão atual>/implantar.sh
  releases/<versão>/       # arquivos desta pasta, um por versão (guarda as 5 últimas)
  fonte/                   # root 700: clone do repositório público, só do implantar-sem-actions.sh (D70)
  vigia/                   # root 700: o vigia da implantação (OP-B4 e OP-B7): vigia-implantacao.sh, a cópia do
                           # implantar-sem-actions.sh, repo.git (clone parcial da main), vistos, main-tratados,
                           # pdv-tratados, janela (600), vigia.log e ultima-implantacao.log
  versoes/atual, anterior, historico
  logs/                    # root 700: api-<AAAAMMDDTHHMMSSZ>-<versão>.log (600), o log da API guardado antes de
                           # cada troca do container: o trecho em volta do último reinício pelo Docker (se houve)
                           # e as últimas 5.000 linhas (20 arquivos no máximo, até 30 dias)
  download/                # root 755 (instalar.sh)
    pdv/                     # instalador do PDV da página de download, root:101 750, arquivos 640; montada só
                             # leitura no genesis-web (/srv/download/pdv): atual.json, GenesisPDV-Setup-X.Y.Z.exe
                             # e o .sha256 (o atual e o anterior)
    implantacao/             # root:101 750: estado.json do vigia (640), montada só leitura no genesis-web
                             # (/srv/download/implantacao): a única saída pública da VPS (D70)
    .recebendo.*/            # temporários do `implantar.sh pdv publicar` (root 700; somem no fim)
  segredos/                # root, 700
    genesis-google.env       # banco e armazenamento (gerado no Cloud Shell), 600
    gcp-conta-servico.json   # chave da conta de serviço genesis-vps, root:65532 640
    genesis-app.env          # JWT_SEGREDO, JWT_SEGREDO_PLATAFORMA, CHAVE_MESTRA (instalar.sh) e o
                             # MONITOR_TOKEN_SHA256 (implantar.sh token-monitor), 600
```

E um volume Docker, `genesis-backup-trabalho`, onde o backup escreve cada dump antes de enviar (apagado depois do
envio). Os backups em si ficam no bucket, em `backups/`.

---

## Passo a passo do dono

### Passo 1. Segredos do Google na VPS (já feito)

O `configurar-genesis.sh` rodado no Cloud Shell do projeto ajustou a instância do Cloud SQL, criou a conta de
serviço `genesis-vps` (Cloud SQL Client), o bucket de arquivos em São Paulo, o usuário `genesis` do banco e imprimiu
**um bloco** para colar no terminal da VPS. Esse bloco grava `/opt/genesis/segredos/genesis-google.env` e
`gcp-conta-servico.json`.

> **O Google não faz backup do banco.** A instância de teste grátis **recusou** os backups automáticos e a
> recuperação em ponto no tempo (PITR) que o script pediu (conferido em 03/11/2026). Ficaram aplicados só: conexão
> cifrada obrigatória, IP público sem nenhuma rede autorizada, proteção contra exclusão e manutenção às terças, 04:00
> de Brasília. A **única** cópia dos bancos é o backup lógico diário do I1b (`genesis-backup`, [Backup](#backup-i1b)):
> confira o primeiro backup e a restauração no Passo 7 **antes de entrar dado real**.

Para conferir (não mostra nenhum segredo), no terminal da VPS:

```bash
ls -l /opt/genesis/segredos
grep -o '^[A-Z_]*=' /opt/genesis/segredos/genesis-google.env
```

O certo é ver, **antes da primeira implantação**, os 2 arquivos com `-rw-------` e dono `root`; **depois** dela
(o `instalar.sh` acerta as permissões e cria o `genesis-app.env`), 3 arquivos, com o `gcp-conta-servico.json` em
`-rw-r----- root 65532` (o grupo 65532 é o usuário do proxy do banco, que precisa ler a chave). E as 8 chaves:
`CLOUDSQL_INSTANCIA=`, `DATABASE_URL=`, `ARMAZENAMENTO_ENDPOINT=`, `ARMAZENAMENTO_REGIAO=`, `ARMAZENAMENTO_BUCKET=`,
`ARMAZENAMENTO_CHAVE_ACESSO=`, `ARMAZENAMENTO_CHAVE_SECRETA=`, `ARMAZENAMENTO_CAMINHO=`.

O que pode aparecer ao colar o bloco:

| Mensagem | O que significa | O que fazer |
|---|---|---|
| `inicio` e depois a listagem dos arquivos (2; ou 3, com o `genesis-app.env`, se já houve implantação) | Deu certo | Apagar a cópia do Cloud Shell: `rm -rf ~/genesis-segredos ~/configurar-genesis.sh` (lá no Cloud Shell). Se já houve implantação, rodar também o comando logo abaixo da tabela |
| `base64: invalid input` ou `gzip: stdin: unexpected end of file` / `tar: Unexpected EOF` | O bloco chegou cortado (o terminal do navegador às vezes corta linhas muito longas) | Colar de novo, a linha inteira; se repetir, abrir o terminal da VPS por SSH (PowerShell: `ssh <usuario>@<IP_DA_VPS>`) e colar lá |
| `tar: ...: Cannot change ownership` | Não deve aparecer (o bloco usa `--no-same-owner`); é só aviso | Conferir com os comandos acima |
| `No such file or directory` em `/opt/genesis/segredos/*` no fim | Nada foi extraído | Colar de novo |

O bloco pode ser colado de novo: ele sobrescreve os mesmos 2 arquivos. **Depois da primeira implantação**, porém,
ele recria o `gcp-conta-servico.json` como `root:root 600`, que o proxy do banco (usuário 65532) não lê. Nada
quebra na hora (o container segue com o arquivo que já abriu), mas na próxima reinicialização da VPS ou do proxy ele
não sobe, a API fica com `/saude` 503 e ERP e PDV param. Por isso, se colar o bloco de novo depois de implantar,
rode em seguida:

```bash
bash /opt/genesis/releases/$(cat /opt/genesis/versoes/atual)/instalar.sh && docker restart genesis-cloudsql-proxy
```

(o `instalar.sh` devolve `root:65532 640`; o restart já confere agora que o proxy lê a chave). O
`implantar.sh estado` avisa quando a chave está com outra permissão. Antes da primeira implantação não precisa: o
workflow roda o `instalar.sh`. Se ainda existir a pasta `~/genesis-segredos` no Cloud Shell, o bloco dela continua
valendo; **não** rode o `configurar-genesis.sh` de novo sem apagá-la (ele gera chaves novas).

### Passo 2. Chave SSH de implantação (na VPS)

O GitHub Actions entra na VPS com uma chave **só dele**. No terminal da VPS (como root), cole:

```bash
ssh-keygen -t ed25519 -N '' -C genesis-github-actions -f /root/genesis_deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
echo "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(cat /root/genesis_deploy.pub)" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo '----- VPS_CHAVE_SSH (copie as linhas BEGIN..END, inclusive) -----'
cat /root/genesis_deploy
echo '----- VPS_KNOWN_HOSTS (copie as linhas abaixo) -----'
IP_DA_VPS=203.0.113.10   # troque pelo IP da VPS (o mesmo do secret VPS_HOST; está no painel da Hostinger)
for f in /etc/ssh/ssh_host_*_key.pub; do echo "$IP_DA_VPS $(cut -d' ' -f1,2 "$f")"; done
```

Copie a chave privada para o secret `VPS_CHAVE_SSH` e as linhas de host para `VPS_KNOWN_HOSTS` (Passo 3). As linhas
ficam no formato `IP tipo chave` mesmo se o SSH estiver em outra porta (`VPS_PORTA`): o workflow procura a chave de
host pelo IP puro (`HostKeyAlias`), sem o `[IP]:porta`. **Depois de gravar os secrets**, apague a chave privada da
VPS:

```bash
rm -f /root/genesis_deploy /root/genesis_deploy.pub
```

A chave entra como root porque os segredos são do root e o Docker já equivale a root; ela não abre terminal
interativo nem túnel (`no-pty`, `no-port-forwarding`). Para revogar: apagar a linha `genesis-github-actions` de
`/root/.ssh/authorized_keys`.

#### Proteger o SSH da VPS

A VPS é achada pelo DNS dos domínios públicos, e robôs tentam entrar por senha o tempo todo; com o código público,
convém fechar a porta. Uma vez, no terminal da VPS como administrador, deixe o SSH aceitar só chave (a do GitHub
Actions e a sua):

1. **Confira antes que você entra por chave** (`ssh <usuario>@<IP_DA_VPS>` do seu computador entra sem pedir a senha
   da VPS). Se ainda pedir, cadastre a sua chave primeiro; senão você fica trancado do lado de fora. Deixe esse
   terminal aberto até o fim, para desfazer se algo der errado.
2. **Só chave, sem senha** (o root continua entrando, mas só com chave, como o deploy faz):

   ```bash
   printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' \
     > /etc/ssh/sshd_config.d/10-genesis.conf
   sshd -t && systemctl reload ssh
   ```

   O `sshd -t` confere o arquivo antes de recarregar (sem saída = certo). Num **segundo** terminal, entre de novo por
   chave para confirmar; só então feche o primeiro.
3. **Firewall da Hostinger** (hPanel › VPS › Segurança › Firewall): uma regra *aceitar* TCP para as portas **22**
   (ou a do `VPS_PORTA`), **80** e **443**, e *descartar* o resto; ative o firewall na VPS. Antes, veja com
   `ss -tlnp` se algum serviço do projeto `icebeer` escuta em outra porta aberta para fora: se escutar, libere-a
   também ou ele para.
4. **fail2ban** (bloqueia por um tempo o IP que erra a entrada várias vezes; no Ubuntu já vem com a regra do SSH):

   ```bash
   apt-get update && apt-get install -y fail2ban && systemctl enable --now fail2ban
   fail2ban-client status sshd
   ```

   O último comando mostra a regra `sshd` ativa e quantos IPs estão bloqueados.

### Passo 3. GitHub: environment `producao` e secrets

No repositório: **Settings › Environments › New environment** → `producao`.

- **Deployment branches and tags**: *Selected branches* → `main` (o workflow só recebe os secrets disparado na
  main). Essa regra olha só o branch do disparo; o commit em si é conferido pelo workflow: ele só implanta commit que
  está no histórico da `main`, mesmo informado à mão no campo **“Commit a implantar”** (um commit de branch não
  mergeado ou de PR é recusado antes do build).
- **Required reviewers** (opcional): marque você mesmo para cada implantação esperar sua aprovação.
- **Environment secrets** (ficam só para este environment):

| Secret | Valor |
|---|---|
| `VPS_HOST` | `<IP_DA_VPS>` |
| `VPS_USUARIO` | `<usuario>`: o administrador da VPS em cujo `authorized_keys` a chave do Passo 2 entrou (o Passo 2 usa o do root, ver o fim dele) |
| `VPS_CHAVE_SSH` | a chave privada do Passo 2 (de `-----BEGIN OPENSSH PRIVATE KEY-----` até `-----END ...-----`) |
| `VPS_KNOWN_HOSTS` | as linhas `<IP_DA_VPS> ssh-ed25519 ...` do Passo 2 (o mesmo formato com qualquer porta) |
| `VPS_PORTA` | opcional; só se o SSH não for na 22 |

- **Environment variables** (opcionais):

| Variável | Valor | Efeito |
|---|---|---|
| `GENESIS_API_URL` / `GENESIS_ERP_URL` | padrão `https://api.grupoicebeer.com.br` / `https://erp.grupoicebeer.com.br` | URLs da conferência pública no fim |
| `GENESIS_DOWNLOAD_URL` | padrão `https://download.grupoicebeer.com.br` | URL da página de download na conferência pública |

- **Variável do repositório** (opcional; em **Settings › Secrets and variables › Actions › Variables › Repository
  variables**, **não** no environment):

| Variável | Valor | Efeito |
|---|---|---|
| `IMPLANTACAO_AUTOMATICA` | `true` | Implanta sozinho depois de cada CI verde de push na `main` (sem ela, só manual) |

  Ela precisa ser do repositório porque o workflow decide se o job roda antes de entrar no environment, e nesse
  momento só enxerga as variáveis do repositório e da organização: criada no environment `producao`, a implantação
  automática nunca dispararia (o job aparece como *skipped*, sem erro).

Com o GitHub CLI, o mesmo (no seu computador, na pasta do repositório; cole o valor quando pedir). As duas primeiras
linhas criam o environment já com a regra "só `main`" (sem corpo, o `PUT` cria o environment aberto a qualquer
branch, e um `workflow_dispatch` de outro branch receberia a `VPS_CHAVE_SSH`):

```bash
gh api -X PUT repos/{owner}/{repo}/environments/producao --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/{owner}/{repo}/environments/producao/deployment-branch-policies -f name=main -f type=branch
gh api repos/{owner}/{repo}/environments/producao/deployment-branch-policies --jq '.branch_policies[].name'   # confira: só main
gh secret set VPS_HOST --env producao              # cole o IP da VPS e tecle Ctrl+D
gh secret set VPS_USUARIO --env producao           # cole o usuário administrador da VPS e tecle Ctrl+D
gh secret set VPS_CHAVE_SSH --env producao          # cole a chave privada e tecle Ctrl+D
gh secret set VPS_KNOWN_HOSTS --env producao        # cole as linhas de host e tecle Ctrl+D
gh variable set IMPLANTACAO_AUTOMATICA --body true   # opcional; do repositório, sem --env
```

Nada novo no GitHub para o I1b: o backup e o painel do monitoramento não usam secret do GitHub (o backup usa os
segredos do Google que já estão na VPS; o token do monitoramento é gerado na própria VPS, no Passo 8).

### Passo 4. DNS (já feito, 03/11/2026)

No painel do domínio `grupoicebeer.com.br`, três registros **A** para o IP da VPS (TTL 300), criados em 03/11/2026:

| Nome | Tipo | Valor |
|---|---|---|
| `erp` | A | `<IP_DA_VPS>` |
| `api` | A | `<IP_DA_VPS>` |
| `download` | A | `<IP_DA_VPS>` |

Para conferir: `getent hosts erp.grupoicebeer.com.br api.grupoicebeer.com.br download.grupoicebeer.com.br` (os
três com `<IP_DA_VPS>`). O Traefik pede o certificado ao Let's Encrypt no primeiro acesso de cada domínio (alguns
segundos). Com o DNS no ar, deixe **“Conferir a API e o ERP pelos domínios públicos” marcado** (o padrão) em toda
implantação: é a conferência de ponta a ponta (DNS, certificado, Traefik e `/saude`). Desmarcar só faz sentido se o
DNS for refeito.

### Passo 5. Primeira implantação

Depois do merge na `main`: **Actions › Implantação › Run workflow** (branch `main`, campo “Commit a implantar”
vazio, conferência pública marcada). O workflow:

1. builda as imagens `genesis-api:<commit>`, `genesis-web:<commit>` e `genesis-backup:<commit>` (cache do GitHub);
2. envia para a VPS com `docker save | ssh docker load` (sem registry e sem credencial de registry na VPS);
3. copia os arquivos desta pasta para `/opt/genesis/releases/<commit>`;
4. roda o `instalar.sh` (na primeira vez gera `genesis-app.env` e os arquivos `.env` e `genesis.env`; nas
   seguintes só confere);
5. roda o `implantar.sh implantar <commit>`: sobe o proxy do Cloud SQL, migra o `genesis_control` (cria o banco se
   faltar) e os bancos das empresas (canário primeiro) num container de tarefa e só então troca API, ERP e backup
   (`up --wait`, healthchecks). Se a nova versão não ficar saudável, volta sozinho para a anterior;
6. publica na página de download o instalador do último GitHub Release do PDV, se mudou
   ([Página de download do PDV](#página-de-download-do-pdv); sem release, só um aviso);
7. confere `https://api.../saude`, `https://erp.../saude`, o ERP pela internet, que
   `https://api.../api/saude/detalhada` sem token responde 401 e a página de download (com o `atual.json` da versão
   do PDV, quando há release).

Guarde uma cópia do `/opt/genesis/segredos/genesis-app.env` num cofre de senhas fora da VPS (sem a `CHAVE_MESTRA`,
o que foi cifrado no banco fica ilegível):

```bash
cat /opt/genesis/segredos/genesis-app.env   # copie para o cofre; não cole em chat nem e-mail
```

### Passo 6. Primeiro admin da plataforma e a empresa

Na VPS (a senha gerada e o segredo do 2FA aparecem **uma vez**, só no seu terminal):

```bash
/opt/genesis/implantar.sh tarefa admin-criar --email voce@grupoicebeer.com.br --nome 'Seu Nome'
```

Cadastre o 2FA no autenticador com o `otpauth://` impresso e entre em `https://erp.grupoicebeer.com.br/plataforma`.
A empresa pode ser criada pelo painel ou pela linha de comando (a senha provisória do `admin` da empresa aparece uma
vez; a troca é obrigatória no primeiro login):

```bash
/opt/genesis/implantar.sh tarefa empresa-criar --razao-social 'ICE BEER ...' --cnpj 00000000000000 --email-responsavel voce@grupoicebeer.com.br
```

### Passo 7. Primeiro backup e ensaio de restauração (I1b; antes de entrar dado real)

Depois da primeira implantação com o I1b, na VPS:

```bash
/opt/genesis/implantar.sh backup agora      # o mesmo backup das 04:30, agora (segundos, com bancos pequenos)
/opt/genesis/implantar.sh backup estado     # "último backup: ok em ..."
/opt/genesis/implantar.sh backup listar     # um dia por linha: AAAA-MM-DD  ok  N banco(s)  bytes  fim
```

`backup estado` responde "bucket indisponível: HTTP 403 ..." (e não "nenhum backup registrado") quando a chave HMAC
não alcança o bucket. No Cloud Shell, aplique também as **regras de ciclo de vida de `backups/`** ([Backup](#backup-i1b)):
sem elas, um container parado deixa os dumps no bucket por 90 dias.

Ensaio de restauração **sem tocar nos bancos de produção** (restaura uma cópia do controle ao lado, confere e apaga):

```bash
D=$(docker exec genesis-backup date +%F)
/opt/genesis/implantar.sh backup restaurar $D genesis_control --como genesis_control_ensaio
/opt/genesis/implantar.sh backup psql genesis_control_ensaio -Atc 'select count(*) from empresas'
/opt/genesis/implantar.sh backup psql postgres -c 'drop database genesis_control_ensaio'
```

O número de empresas tem de ser o mesmo do painel. Repita uma vez por mês, com uma empresa
(`genesis_emp_<código> --como genesis_emp_<código>_ensaio`). O `backup psql <banco>` abre o `psql` no servidor do
banco pelo container do backup, com o usuário `genesis` (sem digitar senha).

### Passo 8. Token do monitoramento (Hermes)

No **terminal da VPS** (o token aparece uma vez, só ali; nunca rode isto pelo GitHub Actions):

```bash
/opt/genesis/implantar.sh token-monitor
```

Sem terminal (ex.: para colar noutra ferramenta), `token-monitor --arquivo /root/hermes-token.txt` grava o token num
arquivo **novo** com permissão 600; o comando recusa um caminho que já existe ou que é link simbólico (num arquivo
existente a permissão antiga ficaria) e, recusado, não troca o token. Apague o arquivo depois de usar.

Copie o token para a configuração do Hermes e teste de qualquer lugar:

```bash
curl -s -H "Authorization: Bearer COLE_O_TOKEN" https://api.grupoicebeer.com.br/api/saude/detalhada
```

Formato da resposta e regras sugeridas de alerta em [Monitoramento](#monitoramento-hermes-i1b).

---

## Implantar sem o GitHub Actions (D70)

Desde 24/11/2026 a cota do GitHub Actions acabou (decisão do dono **D70**) e o workflow **Implantação** não roda. Até
a cota voltar (ou até o dono decidir outra coisa: pergunta **D70-Q1**, a opção (A) é o padrão até a confirmação), a
implantação é **um comando colado no terminal da VPS**: o `implantar-sem-actions.sh` faz na própria VPS o que o
workflow fazia no GitHub, com as mesmas conferências, e roda os mesmos `instalar.sh` e `implantar.sh`. Nada muda no
`implantacao.yml`: quando a cota voltar, o workflow continua valendo.

**Antes:** o que vai para a produção é um commit da `main` (o PR já juntado, com a verificação local verde). Anote o
hash do commit (no GitHub, na lista de commits da `main`: os 7 primeiros caracteres bastam) ou deixe sem commit para
implantar o último da `main`. Prefira um horário **fora do movimento das lojas**: as imagens são montadas na própria
VPS, o que leva alguns minutos e usa a CPU e o disco dela (a versão em produção continua no ar durante a montagem).

**Passo a passo:**

1. Abra o terminal da VPS: **Hostinger › VPS › Terminal** (o navegador abre um terminal já como `root`).
2. Cole o comando, trocando `COMMIT` pelo hash anotado (ou apagando-o, para o último da `main`):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/KhauanG/GenesisPDV-ERP/main/infra/producao/implantar-sem-actions.sh -o ~/implantar-sem-actions.sh && bash ~/implantar-sem-actions.sh --publicar-pdv COMMIT
   ```

   O primeiro trecho baixa o script da `main` do repositório público; o segundo roda. O `--publicar-pdv` faz o que o
   campo `publicar_pdv` do workflow fazia: atualiza a página de download com o último GitHub Release do PDV (tire-o
   para implantar sem mexer na página). Para só conferir, sem montar nem trocar nada, troque `--publicar-pdv` por
   `--simular`.
3. Espere o fim (de 5 a 15 minutos; a primeira vez demora mais, porque baixa o repositório e as imagens base). O
   script mostra cada etapa com `==>` e termina com o resumo. **Se puder, não feche a aba até o resumo**, mas, se
   ela fechar, a conexão cair ou o notebook dormir, a implantação **continua sozinha na VPS**: depois das
   conferências ela roda fora do terminal (o terminal só mostra o andamento; o Ctrl+C também só para de mostrar).
   Para ver de novo, abra o terminal da VPS e rode
   `bash ~/implantar-sem-actions.sh --acompanhar`: mostra a implantação em andamento até o fim ou, se ela já
   terminou, a saída inteira da última, com o resumo. A saída de cada implantação fica em
   `/opt/genesis/logs/implantar-sem-actions-<data>.log` (as 10 últimas). Resumo:

   ```
   ### Implantação sem o Actions: 1a2b3c4d5e6f (7 min 40 s)
   Versão: 1a2b3c4d5e6f no ar.
   Página de download: PDV 0.13.0 (já publicado).
   Estado da VPS (containers, memória, backup): bash /opt/genesis/implantar.sh estado
   Voltar para a versão anterior, se precisar: /opt/genesis/implantar.sh voltar
   Saída completa desta implantação: /opt/genesis/logs/implantar-sem-actions-20261124T220000Z-4242.log
   ```

4. Confira o ERP no navegador (`https://erp.grupoicebeer.com.br`). Se algo estiver errado depois de no ar, **volte
   para a versão anterior** com `/opt/genesis/implantar.sh voltar` (segundos; as migrações não são desfeitas, como
   sempre) e avise para a correção.

**O que o script faz, na ordem do workflow** (`bash ~/implantar-sem-actions.sh --ajuda` lista as opções):

| Etapa | O que faz |
|---|---|
| Conferências | Recusa se não for `root`, se o commit não tiver o formato do workflow (7 a 40 caracteres hexadecimais), se houver menos de **5 GB livres** no disco do Docker ou do `/opt/genesis` (`GENESIS_ESPACO_MINIMO_GB`) ou se outra implantação estiver rodando (a trava do `implantar.sh` ou outra execução deste script) |
| 1. Commit | Clona (na primeira vez) ou atualiza o repositório público em `/opt/genesis/fonte` (root, 700; sem token: o repositório é público) e confere que o commit está no histórico da `main` (commit de outro branch ou de PR é recusado) |
| 2. Versão | O commit em 12 caracteres, como no workflow: a tag das imagens e o nome da release |
| 3. Imagens | `genesis-api`, `genesis-web` e `genesis-backup` `:<versão>`, com os mesmos Dockerfiles do workflow, montadas na VPS (no lugar do `docker save \| ssh docker load`), com `nice`/`ionice` |
| 4. Arquivos | `docker-compose.yml`, `implantar.sh`, `instalar.sh` e os dois modelos do commit em `/opt/genesis/releases/<versão>` |
| 5. PDV (com `--publicar-pdv`) | Antes da troca: o instalador do GitHub Release `pdv-vX.Y.Z` publicado de versão mais alta e o `.sha256`, baixados e conferidos (sha256 errado ou `.sha256` fora do formato param aqui, com a produção intacta; GitHub fora do ar é só um aviso) |
| 6. Implantação | `instalar.sh` e `implantar.sh implantar <versão>`: o mesmo de sempre (proxy do banco, migrações, troca, saúde e a volta automática se a nova não ficar saudável) |
| 7. Página (com `--publicar-pdv`) | `implantar.sh pdv publicar` (ou `pdv retirar`, sem release publicado), como o workflow |
| Só o PDV (`--so-pdv`, OP-B7) | Sem commit: as conferências de sempre, a versão no ar (com a release e a imagem do backup dela) e as etapas 5 e 7 com as regras do `--publicar-pdv`, sem montar imagem nem trocar a versão; sem release publicado, a página fica como está; pede só o espaço do instalador (1 GB, `GENESIS_ESPACO_MINIMO_PDV_GB`), não o do build; o GitHub fora do ar, o release incompleto e, com `--tag=pdv-vX.Y.Z` (o vigia passa a tag que viu), o release dessa tag ainda não publicado saem com 69, o arquivo inválido com 65 e as outras falhas com 1 (o vigia usa) |
| 8. URLs públicas | A API, o ERP, o painel do monitoramento (401 sem token) e a página de download pelos domínios do `/opt/genesis/.env` (`--sem-conferir-url` pula) |
| Limpeza | Imagens do Genesis além das 3 mais recentes de cada (nunca a atual nem a anterior, as do `voltar`) e o cache do build com mais de uma semana |

**Se der errado:** a mensagem `ERRO:` diz em que etapa parou e o que fazer (se a aba fechou antes, o
`--acompanhar` mostra a saída com o erro e o resumo). Até a etapa 5 nada mudou na produção.
Na etapa 6 vale o de sempre: falha antes da troca (migração, trava) deixa a versão anterior no ar; a nova sem saúde
volta sozinha para a anterior, com o log da API guardado (`bash /opt/genesis/releases/<versão>/implantar.sh logs`).
Rodar de novo o mesmo comando é seguro (o `instalar.sh` é idempotente e a montagem reaproveita o cache).

**Testado sem a VPS:** `infra/producao/teste/testar-implantar-sem-actions.sh` (dublês, sem Docker nem rede; roda no
`scripts/verificar-local.sh`) e o ensaio de ponta a ponta `sudo infra/producao/teste/testar-local.sh --sem-actions`
([Teste local da stack](#teste-local-da-stack)). Decisões em
[Decisões técnicas (implantação sem o Actions)](#decisões-técnicas-implantação-sem-o-actions-d70-24112026).

## Vigia da implantação (D70, OP-B4 e OP-B7)

O dono autorizou a sessão do Claude Code a **implantar sozinha um commit que já está na `main`** (D70, 24/11/2026),
mas a sessão não abre conexão com a VPS e não recebe credencial nenhuma dela. O **vigia** inverte o sentido: a
própria VPS, a cada 2 minutos, olha o repositório **público** (só leitura, sem token) e roda o mesmo
`implantar-sem-actions.sh` da seção acima. Desde a **D119** (25/11/2026), **cada merge que o dono libera na `main`
vale também como "pode implantar"**: o vigia implanta sozinho cada commit novo da `main`. O merge na `main` continua
só com a liberação do dono; o vigia só implanta o que já entrou nela.

**O que o vigia faz, uma coisa por rodada, nesta ordem:**

1. **Pedido manual do dono** (forçar ou voltar uma versão): uma tag `implantar/<AAAAMMDD-HHMMSS>` (implantar) ou
   `implantar-pdv/<AAAAMMDD-HHMMSS>` (implantar e publicar o PDV do último release, o `--publicar-pdv`) num commit da
   `main`. Roda **na hora, a qualquer hora** (também entre as 17h e a meia-noite) e tem prioridade sobre o resto. Commit
   de outro branch é **recusado** sem rodar nada; roda só o pedido **mais novo** ainda não visto (os anteriores ficam
   como pulados); os que já existiam quando o vigia foi instalado nunca rodam; um commit mais velho que o do ar é
   permitido (é a "volta").
2. **A `main`:** quando a ponta da `main` (o último merge) é um commit que o vigia **ainda não tratou**, ele o
   implanta. **Uma vez por commit:** implantado, com falha ou recusado, o mesmo commit não roda de novo sozinho (o
   próximo merge, sim). Por isso o vigia **não desfaz uma volta** feita pelo dono com `implantar.sh voltar`: a ponta já
   foi tratada. A ponta que já é a versão no ar fica tratada sem implantar, e o commit de um pedido manual também.
3. **O PDV:** quando aparece um release novo do PDV (a tag `pdv-vX.Y.Z` de versão mais alta muda), o vigia publica
   na página de download o release `pdv-vX.Y.Z` **publicado** mais novo (rascunho e pre-release não contam), se o
   instalador for diferente (sha256) do que a página serve, **sem remontar nem trocar a versão no ar**
   (`implantar-sem-actions.sh --so-pdv --tag=<tag>`, com as mesmas conferências do `--publicar-pdv`). Um release com
   arquivo inválido não é tentado de novo (o log diz). A tag que aparece antes de o release dela ser publicado (o
   `publicar-release.sh` e o workflow criam a tag, depois o rascunho, enviam o instalador e só então publicam; ou um
   pre-release que vira release depois), o GitHub fora do ar e as falhas passageiras (o Docker, o espaço, a página que
   não respondeu) tentam de novo a cada 15 minutos, sem mexer no `estado.json`, até dar certo: um release deixado como
   pre-release com a tag mais alta fica nisso (uma linha no log) até sair um release publicado de versão igual ou
   maior. Sem release publicado, a página fica como está (só o `--publicar-pdv` de uma implantação manual retira o
   instalador). **Para o vigia tentar de novo uma tag que ficou `falhou`** (o release refeito com "substituir", na
   mesma tag): apague a linha dela em `/opt/genesis/vigia/pdv-tratados` (ex.: `sed -i '/^pdv-v0.14.0 /d'
   /opt/genesis/vigia/pdv-tratados`; vale na próxima rodada fora da janela) ou publique na hora com `bash
   ~/implantar-sem-actions.sh --so-pdv`.

**Horário (a janela):** nada automático (2 e 3) **começa entre as 17:00 e a meia-noite**, no horário de Brasília: o
movimento das lojas. Um merge feito nesse horário é implantado logo depois da meia-noite. Uma implantação que já
começou não é interrompida. A janela fica em `/opt/genesis/vigia/janela` (padrão `17-24`; horas cheias
`<início>-<fim>`, o fim antes do início passa pela meia-noite, ex.: `22-6`; ou `nenhuma` para implantar a qualquer
hora). Para trocar, no terminal da VPS: `echo 18-24 > /opt/genesis/vigia/janela` (vale na próxima rodada; um valor
fora do formato vale como o padrão, com uma linha no log).

**Instalar ou reinstalar (no terminal da VPS; a reinstalação depois do merge do PR-16b, com o OP-B7, é a última
feita à mão: desde o OP-B9 o vigia se atualiza por inteiro sozinho, abaixo):**

1. Abra o terminal da VPS: **Hostinger › VPS › Terminal** (já entra como `root`).
2. Cole o comando:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/KhauanG/GenesisPDV-ERP/main/infra/producao/vigia/instalar-vigia.sh -o ~/instalar-vigia.sh && bash ~/instalar-vigia.sh
   ```

3. O que esperar: sete etapas com `==>` (menos de um minuto) e, no fim, `Vigia da implantação instalado.` O
   script baixa a `main` do repositório público para `/opt/genesis/vigia/repo.git`, instala o vigia, o
   `implantar-sem-actions.sh` e uma cópia do próprio `instalar-vigia.sh` em `/opt/genesis/vigia`, as duas unidades do systemd (`genesis-vigia.service` e
   `genesis-vigia.timer`), marca os pedidos por tag antigos como vistos, cria a janela com o padrão (se ainda não
   existe), confere a ponta da `main` e liga o timer. **Nada é implantado durante a instalação.** A etapa 5 diz o que
   vem depois: se a ponta da `main` já é a versão no ar, nada a fazer; senão (o caso logo depois do merge do OP-B7),
   o vigia a implanta **sozinho na primeira rodada fora da janela** (1 a 2 minutos depois, ou depois da meia-noite).
   Rodar o mesmo comando de novo atualiza o vigia para a versão da `main` (sem perder o que já foi visto e tratado).
   A unidade e o timer da `main` só entram conferidos (o formato e o `systemd-analyze verify`); fora disso, o comando
   para sem trocar nada.
4. A página pública do resultado (`https://download.grupoicebeer.com.br/implantacao/estado.json`) responde depois da
   primeira implantação pelo vigia; até lá, 404.

**O vigia se atualiza sozinho, por inteiro (OP-B9; D121, 25/11/2026).** Depois de cada implantação `ok`, o vigia
aplica a instalação do commit que acabou de subir: o próprio programa (`vigia-implantacao.sh`), a cópia do
`implantar-sem-actions.sh` (a da `main`), a cópia do `instalar-vigia.sh` em `/opt/genesis/vigia` (a do `--estado` e
do `--desligar`, abaixo) e as duas unidades do systemd (`genesis-vigia.service` e `genesis-vigia.timer`), só o que
mudou, com o `daemon-reload`; o timer que mudou é reiniciado (se estava ligado). A unidade e o timer novos só entram
conferidos (o formato esperado e o `systemd-analyze verify` sem erro nem aviso); se a conferência ou a troca falhar
(mesmo com o disco cheio no meio: tudo é preparado antes, e a troca e a volta são só renames), **fica tudo como
estava** (o vigia continua rodando no agendamento de antes, a implantação continua `ok` e o motivo vai só ao
`vigia.log`; a próxima implantação `ok` tenta a dela). Ela não liga o timer: **o vigia desligado pelo dono continua
desligado**, também se o `--desligar` cair no meio da troca; não mexe nos pedidos vistos, nos commits tratados nem na
janela que existe. **Na transição, nada a fazer:** o vigia do OP-B7 (o da reinstalação depois do PR-16b) troca só o
programa quando implanta o primeiro commit com o OP-B9, e a rodada seguinte (2 minutos depois), já com o vigia novo,
aplica o resto. **O comando de instalar à mão só volta a ser preciso** se o vigia parou (o timer desligado com o
`--desligar`, que só o comando de instalar religa) ou se a pasta `/opt/genesis/vigia` (ou a lista `vistos`) se
perdeu. O que a última instalação aplicou aparece no `--estado` da cópia em `/opt/genesis/vigia` (abaixo), na linha
"Instalação do vigia aplicada por último": o commit e o resultado, que é um destes:

- `ok`: aplicada;
- `recusado`: a unidade ou o timer do commit não passaram na conferência (ficam os de antes; a próxima implantação
  `ok` tenta a dela);
- `falhou`: a troca falhou e foi desfeita, tudo como antes (a próxima implantação `ok` tenta a dela);
- `pendente`: um arquivo não veio do GitHub, ou a troca falhou e não voltou por inteiro: tenta de novo a cada rodada;
- `sem-autoatualizar`: o commit no ar é anterior ao OP-B9 (uma volta do dono): só o programa do vigia, como antes;
- `sem-commit`: a versão no ar não está na `main` (um commit implantado pelo terminal fora dela): fica a instalação
  atual, sem nova tentativa até a próxima implantação `ok`; não é preciso reinstalar;
- `instalacao`: a do comando de instalar à mão.

**Ver o que o vigia fez:** `bash /opt/genesis/vigia/instalar-vigia.sh --estado` mostra o timer (ligado ou não), a janela, a versão no
ar, os últimos commits da `main` tratados e as últimas publicações do PDV, a instalação do vigia aplicada por último,
a última rodada, o estado público e as 20 últimas linhas do log (`/opt/genesis/vigia/vigia.log`: recebido, em andamento, ok, falhou, recusado, pulado, a espera
da janela com a hora prevista). A saída completa da última chamada fica em `/opt/genesis/vigia/ultima-implantacao.log`,
e a da implantação em andamento (ou a última, com o resumo) aparece com
`bash /opt/genesis/vigia/implantar-sem-actions.sh --acompanhar`. Use a cópia em `/opt/genesis/vigia`, que o vigia
mantém na versão da instalação aplicada: a `~/instalar-vigia.sh` é a que o comando de instalar baixou e fica na versão
daquele dia (até a primeira implantação de um commit com o OP-B9 pelo vigia, a cópia em `/opt/genesis/vigia` ainda não
existe: use a de `~`).

**Desligar:** `bash /opt/genesis/vigia/instalar-vigia.sh --desligar` desliga o timer: nada novo é implantado, e uma implantação que já
estava em andamento termina normalmente (o comando nunca a interrompe). Para religar, o comando de instalar de novo:
a ponta da `main` que ainda não foi tratada é implantada na primeira rodada fora da janela; os pedidos **por tag**
feitos enquanto o vigia esteve desligado **não** rodam, e um pedido por tag que estava esperando (como `recebido`)
fica `recusado` no `estado.json`, com o fim (o motivo vai ao log do vigia). O mesmo vale se a pasta
`/opt/genesis/vigia` (ou só a lista `vistos`) se perder, mesmo com o timer ligado: o vigia para de implantar e pede o
comando de instalar, que marca todas as tags existentes como vistas.

**Forçar ou voltar uma versão pelo site do GitHub (pedido manual do dono).** O jeito mais rápido de voltar continua
sendo o `/opt/genesis/implantar.sh voltar` no terminal da VPS (segundos). Para implantar um commit da `main` pelo site:

1. No GitHub, **Releases › Draft a new release**.
2. Em **Choose a tag**, escreva o nome novo `implantar/AAAAMMDD-HHMMSS` com a data e a hora de agora em UTC (Brasília
   + 3 h; ex.: `implantar/20261126-140500`) e escolha **Create new tag on publish**. Em **Target**, escolha o commit da
   `main` (a lista **Recent commits**; para o último, deixe `main`).
3. Título qualquer (ex.: "pedido de implantação"), marque **Set as a pre-release** (para não aparecer como release
   do PDV) e **Publish release**. O vigia vê a tag em até 2 minutos e implanta na hora, mesmo entre as 17h e a
   meia-noite.
4. Depois do resultado, apague o release (**Delete**), deixando a tag: o vigia não precisa dele, e a tag fica como
   registro. Com `implantar-pdv/` no lugar de `implantar/`, a implantação também publica o PDV do último release.

**Como a sessão acompanha** (`scripts/acompanhar-implantacao.sh <commit>`, CLAUDE.md): depois de cada merge liberado
pelo dono, a sessão avisa o dono, confere que o commit está na `origin/main`, diz se está dentro da janela (a hora
prevista do começo) e acompanha o `estado.json` e o `/saude` da API (o `no_ar_desde` muda quando a versão nova sobe)
até `ok`, `falhou` ou `recusado` do commit ou de um commit da `main` que o inclui (sai com 0 no `ok`, 1 no `falhou` ou
`recusado` e 3 no tempo limite de 1 hora depois do fim da janela, quando o commit chega dentro dela: começando dentro
dela, ou vendo o `recebido` do vigia já dentro dela; sem resultado, a implantação ainda roda, a VPS está
fora ou o vigia está desligado, e o dono confere com `--estado`). A sessão **não cria tag** (a rede dela recusa escrita
no GitHub fora dos PRs); o `scripts/pedir-implantacao.sh` do OP-B4 ficou só avisando e passando ao acompanhamento.
O `estado.json` tem **só** `{pedido, commit (12 caracteres), resultado, inicio, fim}`: o `pedido` é o nome da tag,
`main` (o automático) ou `pdv` (a publicação só do PDV, com o commit da versão no ar, escrita só quando a página
mudou ou a publicação falhou); o nome da tag e o commit já são públicos no repositório; nenhum log, versão de
software, estado da VPS ou mensagem de erro sai da VPS (isso fica no `vigia.log`, que só o dono vê). É a **única
saída pública da VPS**, por decisão do dono (D70).

**Limites:** voltar **por tag** para um commit anterior ao OP-B4 (24/11/2026) implanta, mas o `genesis-web` dele não
serve o `estado.json` (404 depois da troca): o resultado só o dono vê com `--estado`. Voltar por tag para um commit
anterior ao OP-B7 troca o vigia pelo daquele commit (a autoatualização usa o vigia do commit implantado), que não
implanta a `main` sozinho: depois, rode de novo o comando de instalar (ele traz o vigia da `main`, sem desfazer a
volta: a ponta já foi tratada). Voltar por tag para um commit do OP-B7 ou do OP-B8 (anterior ao OP-B9) troca só o
programa do vigia, como antes (a unidade e o timer instalados ficam); o próximo merge implantado traz de volta a
instalação completa.

**Se der errado:** um `falhou` deixa a VPS como o `implantar-sem-actions.sh` deixaria (a mensagem `ERRO:` diz em que
etapa parou; antes da troca, a versão anterior continua no ar; a nova sem saúde volta sozinha). Se a VPS reiniciar no
meio de uma implantação, ela fica como `falhou` na rodada seguinte (confira com `bash /opt/genesis/implantar.sh
estado`). Com outra implantação em andamento (o dono pelo terminal, por exemplo), o vigia espera, como `recebido`, e
roda na rodada seguinte à que ela terminar; se ela implantou a mesma ponta da `main` que o vigia esperava, ele não
implanta de novo e o `estado.json` fica `ok` (a ponta está no ar). Para tentar de novo um commit da `main` que falhou: o próximo merge, ou um
pedido manual (acima).

**Testado sem a VPS:** `infra/producao/teste/testar-vigia-implantacao.sh` (dublês de `id`, `systemctl` e `date`, o
`git` de verdade sobre um repositório local com as tags e os merges, um `implantar-sem-actions.sh` falso; o
`systemd-analyze verify` das unidades; a autoatualização completa do OP-B9 e a transição com o vigia do OP-B7 de
verdade), o `--so-pdv` no `testar-implantar-sem-actions.sh` e
`scripts/testar-acompanhar-implantacao.sh` (`curl` e `date` falsos); a rota do `estado.json` no `testar-local.sh`.
Decisões em [Decisões técnicas (vigia da implantação)](#decisões-técnicas-vigia-da-implantação-op-b4-24112026),
[Decisões técnicas (implantação automática da main)](#decisões-técnicas-implantação-automática-da-main-op-b7-25112026) e
[Decisões técnicas (o vigia se atualiza por inteiro)](#decisões-técnicas-o-vigia-se-atualiza-por-inteiro-op-b9-25112026).

---

## Operação no dia a dia (na VPS)

| Para | Comando |
|---|---|
| Ver versões, containers, memória e a saúde | `/opt/genesis/implantar.sh estado` |
| Logs da API (JSON) | `docker logs genesis-api --tail 200` (`-f` para acompanhar; `--since 1h` para a última hora) |
| Logs da API de containers anteriores (guardados antes de cada implantação/volta) e os reinícios do atual | `/opt/genesis/implantar.sh logs` (`logs guardar` guarda agora, antes de recriar a API à mão) |
| Logs do proxy do banco / do ERP | `docker logs genesis-cloudsql-proxy --tail 100` / `docker logs genesis-web --tail 100` |
| Voltar para a versão anterior | `/opt/genesis/implantar.sh voltar` (de novo = volta para a que estava) |
| Mudar a configuração (`genesis.env`, `segredos/genesis-app.env`) | editar, `/opt/genesis/implantar.sh logs guardar` e `cd /opt/genesis && docker compose up -d` (recria a API: sem o `guardar`, o log dela some) |
| Reiniciar a API | `docker restart genesis-api` |
| Migrar as empresas de novo (ex.: depois de uma falha) | `/opt/genesis/implantar.sh tarefa migrar-empresas` |
| Comandos da API | `/opt/genesis/implantar.sh tarefa <comando> [--argumentos]` (`admin-criar`, `empresa-criar`, `empresa-provisionamento`, `migrar-controle`, `migrar-empresas`, `ncm-atualizar`, `particoes`, `recalcular-saldos`, `referencias`) |
| Conferir o saldo de estoque pelo razão (sem `--corrigir` não altera saldo nem movimento, só resolve o alerta de saldo divergente quando dá "idêntico"; "idêntico" é o esperado) | `/opt/genesis/implantar.sh tarefa recalcular-saldos --empresa=<código>` (README da API › decisão 147; `docs/implantacao/checklist-fechamento-fase2.md`, passo 7) |
| Atualizar a tabela NCM (simular antes) | `/opt/genesis/implantar.sh tarefa ncm-atualizar --simular` e, depois, sem o `--simular` ([Tabela NCM](#tabela-ncm-atualização-pela-plataforma-f2-b46)) |
| Uso de memória | `docker stats --no-stream genesis-api genesis-web genesis-cloudsql-proxy genesis-backup` |
| Backup: último, dias guardados, um backup agora | `/opt/genesis/implantar.sh backup estado` / `backup listar` / `backup agora` |
| Logs do backup | `docker logs genesis-backup --tail 100` (uma linha por banco; `FALHOU` quando algo deu errado) |
| Restaurar (um banco ao lado, ou tudo num servidor vazio) | [Backup › Restaurar](#restaurar) |
| Gerar ou trocar o token do monitoramento | `/opt/genesis/implantar.sh token-monitor` (o anterior para de valer na hora) |
| Ver o vigia da implantação (timer, janela, último pedido, commits tratados, instalação aplicada, log) ou desligá-lo | `bash /opt/genesis/vigia/instalar-vigia.sh --estado` / `bash /opt/genesis/vigia/instalar-vigia.sh --desligar` ([Vigia da implantação](#vigia-da-implantação-d70-op-b4-e-op-b7)) |
| Ver o instalador do PDV publicado na página de download | `cat /opt/genesis/download/pdv/atual.json` (ou a linha "Página de download" do `implantar.sh estado`) |

**A API reiniciou sozinha** (ex.: 04/11/2026, 18:05:42Z, no meio de uma importação). Primeiro a causa, depois o
efeito nas tarefas. Desde a decisão 166 do `apps/api/README.md`, a API escreve no log, antes de sair, o motivo de
toda saída que passa pelo JavaScript, e o `implantar.sh` guarda o log do container antes de recriá-lo. O que olhar,
nesta ordem:

1. **Reiniciou mesmo?** `implantar.sh logs` mostra desde quando o container está no ar e o `RestartCount`
   (reinícios > 0 = o processo caiu e o Docker subiu de novo, sem implantação). No monitoramento, o
   `processo.no_ar_segundos` do `/api/saude/detalhada` volta para perto de zero (e `api.no_ar_desde` muda) com a
   mesma `api.versao`.
2. **O log do container atual** (o reinício pelo `restart: unless-stopped` mantém o mesmo container, então o log de
   antes da queda continua lá; troque `1h` pelo tempo desde a queda). As linhas do processo têm
   `"context":"Processo"`:

   ```bash
   docker logs genesis-api --since 1h --timestamps 2>&1 |
     grep -E '"level":(50|60)|heap out of memory|FATAL ERROR|sinal SIG|API no ar' | tail -n 40
   ```

   - `"level":60` com `"origem":"uncaughtException"` ou `"unhandledRejection"` e o `err.stack`: a causa é o erro
     ali (mande a linha inteira para o desenvolvimento);
   - `FATAL ERROR: Reached heap limit … JavaScript heap out of memory` (do V8, no stderr; saída 134): o heap de
     1,5 GB acabou. Antes dele costuma haver o aviso `heap do Node acima de 85 % do limite` (`"level":40`), com a hora
     em que o heap começou a encher;
   - `sinal SIGTERM recebido`: alguém parou o container (`docker stop`/`restart`, implantação);
   - nenhuma das três, só um `API no ar` novo: o processo morreu sem passar pelo JavaScript (SIGKILL: veja o kernel
     abaixo).
3. **O container foi recriado** (implantação, `voltar`, troca do token) depois da queda: o log dele está em
   `/opt/genesis/logs/` — `implantar.sh logs` lista os arquivos (`api-<data UTC>-<versão>.log`, os 20 últimos, até
   30 dias); procure com o mesmo `grep` no arquivo de antes da troca. A primeira linha diz desde quando o container
   estava no ar e quantas vezes o Docker o reiniciou; com reinícios > 0, o arquivo começa pelo trecho
   `em volta do último reinício pelo Docker` (de 30 min antes a 2 min depois da subida do processo novo, ou seja, a
   queda e a volta), mesmo que a troca tenha vindo horas ou dias depois; depois vêm as últimas 5.000 linhas (só as
   horas antes da troca). Só o último reinício tem o trecho; dos anteriores, o `RestartCount` diz só quantos foram.
4. **A memória agora**: `processo` do `/api/saude/detalhada` (heap usado, reservado e o teto do V8, RSS, em MiB) e
   `memoria` (o container, como no `docker stats`).
5. **O kernel**, para o SIGKILL do OOM (o container passou do limite: 1984 MiB desde o OP-B5; 2 GB até ele). O `docker inspect` não guarda o motivo de um
   reinício feito pelo `restart: unless-stopped`: ao subir de novo, o Docker zera `State.ExitCode` e
   `State.OOMKilled`; o que fica é o `RestartCount` (e o `StartedAt`). O `journalctl` lê `--since` no fuso da VPS,
   então ponha `UTC` no horário:

```bash
docker inspect genesis-api --format '{{.State.StartedAt}} reinícios={{.RestartCount}}'   # reinícios > 0: o container caiu e voltou
journalctl -k --since '2026-11-04 17:50 UTC' --until '2026-11-04 18:10 UTC' | grep -i -E 'oom|killed process'   # OOM do kernel/cgroup (mem_limit 1984m)
journalctl -u docker -u containerd --since '2026-11-04 17:50 UTC' --until '2026-11-04 18:10 UTC' | grep -i -E 'oom|exit|die|restart'   # saída do container, com o código
docker logs genesis-api --since '2026-11-04T17:50:00Z' --until '2026-11-04T18:06:00Z' 2>&1 | tail -n 100
```

Linha `oom-kill`/`Killed process … (node)` no `journalctl -k` (saída 137, SIGKILL) = o container passou do limite;
saída 134 com `JavaScript heap out of memory` no log = o heap do Node (1,5 GB) acabou antes; saída 1 com a linha
`"level":60` = erro do código. O `docker events` não serve para o passado (o daemon só guarda os últimos eventos em
memória, e os healthchecks os renovam o tempo todo): use-o para acompanhar a próxima queda ao vivo,
`docker events --filter container=genesis-api --filter event=oom --filter event=die` (o `die` traz o `exitCode`).
**O 04/11/2026**: a VPS não reiniciou (ligada desde 23/10/2026 17:29) e o `dmesg -T` não tem nenhum
`Killed process`/`Out of memory`. Isso é **indício, não confirmação**, de que não foi o OOM do cgroup (2 GiB): o
buffer do `dmesg` é circular e, em 13 dias no ar, pode ter perdido o começo; e o `journalctl -k` foi rodado com
`--since "2026-11-04 17:30"` **sem `UTC`**, que é lido no fuso da VPS (não conferido): em `America/Sao_Paulo` a
janela seria 20:30–21:30Z e não cobriria as 18:05Z. Os 4,8 GiB do `free -h` são o `available` de **05/11**, depois
da implantação que recriou o container (o `free` era 281 MiB): não dizem nada da memória às 18:05Z, e o OOM do
cgroup dispara no `mem_limit` do container, seja qual for a memória da máquina. Para fechar (pedido ao dono):

```bash
timedatectl | grep -i 'time zone'
journalctl -k --since '2026-11-04 17:30 UTC' --until '2026-11-04 18:30 UTC' --no-pager | grep -i -E 'oom|killed process|out of memory'
dmesg -T | head -n 1   # até onde o buffer do kernel volta (se for depois de 04/11, o dmesg vazio não prova nada)
```

O log se perdeu na implantação de 05/11 (antes da decisão 166), então a causa ficou **sem determinar** (OOM do
cgroup, erro do código ou heap; a importação de planilha foi conferida e não acumula memória por linha). A próxima
queda fica registrada.
As tarefas que estavam rodando (importação…) viram `falhou` sozinhas em até ~5 min, com a mensagem de interrompida
(apps/api/README.md › decisão 150). Para terminar a importação, o usuário importa a mesma planilha de novo e confere a
prévia antes de confirmar: o que já entrou deve vir "Sem alteração" (ou "Atualizar" só no estoque); linha que já
entrou e vier "Criar" (produto sem código, código interno nem EAN; cliente sem CPF/CNPJ) seria cadastrada de novo e
sai da planilha.

**Volta atrás (rollback).** A VPS guarda as imagens e os arquivos da versão atual e da anterior. `implantar.sh voltar`
sobe API e ERP da anterior **sem desfazer migrações**: as migrações seguem o padrão expandir/contrair (a API
anterior funciona com o schema novo; apps/api/README.md › Migrações). Para voltar a uma versão mais antiga que a
anterior, rode o workflow manualmente na `main` informando a versão no campo **“Commit a implantar”**: serve o hash
de 12 caracteres que aparece em `implantar.sh estado`, em `/opt/genesis/versoes/historico` e na tag das imagens, ou
o hash completo. O commit tem de estar na `main` (o workflow recusa outro). O build sai daquele commit; as migrações
já aplicadas continuam, pelo mesmo motivo (sem a cota do Actions, D70: `bash ~/implantar-sem-actions.sh <hash>`
na VPS, [Implantar sem o GitHub Actions](#implantar-sem-o-github-actions-d70)). Uma falha de migração de empresa deixa só aquela empresa em manutenção (503) e a versão anterior no ar; o
`implantar.sh` para antes de trocar a API.

**Implantar sem o GitHub** (emergência, de um computador com Docker e o repositório; sem a cota do Actions, o
caminho normal é o da própria VPS, [Implantar sem o GitHub Actions](#implantar-sem-o-github-actions-d70)):

```bash
V=$(git rev-parse --short=12 HEAD)
docker build -f apps/api/Dockerfile --build-arg VERSAO=$V -t genesis-api:$V .
docker build -f apps/erp-web/Dockerfile --build-arg VERSAO=$V -t genesis-web:$V .
docker build -f infra/producao/backup/Dockerfile --build-arg VERSAO=$V -t genesis-backup:$V infra/producao/backup
VPS=usuario@203.0.113.10   # troque por <usuario>@<IP_DA_VPS> (os mesmos do VPS_USUARIO e do VPS_HOST)
docker save genesis-api:$V genesis-web:$V genesis-backup:$V | gzip -1 | ssh "$VPS" 'gunzip | docker load'
tar -C infra/producao -czf - docker-compose.yml implantar.sh instalar.sh compose.env.exemplo genesis.env.exemplo |
  ssh "$VPS" "mkdir -p /opt/genesis/releases/$V && tar -xzf - -C /opt/genesis/releases/$V"
ssh "$VPS" "bash /opt/genesis/releases/$V/instalar.sh && bash /opt/genesis/releases/$V/implantar.sh implantar $V"
```

Assim a página de download fica como está. Para publicar nela um release do PDV à mão (com o `gh` logado na sua
conta; X.Y.Z e a data de publicação do release):

```bash
VPS=usuario@203.0.113.10   # troque por <usuario>@<IP_DA_VPS>, como acima
P=0.9.0; gh release download pdv-v$P -p "GenesisPDV-Setup-$P.exe*" -D /tmp/pdv && (cd /tmp/pdv && sha256sum -c GenesisPDV-Setup-$P.exe.sha256)
D=$(gh release view pdv-v$P --json publishedAt --jq .publishedAt)
tar -C /tmp/pdv -cf - GenesisPDV-Setup-$P.exe GenesisPDV-Setup-$P.exe.sha256 |
  ssh "$VPS" "bash /opt/genesis/implantar.sh pdv publicar $P $D"
```

### Tabela NCM (atualização pela plataforma, F2-B46)

A tabela NCM é a lista oficial de códigos de mercadoria que o cadastro de produtos usa (o "BuscaNcm", o relatório
**NCMs inválidos**). Ela muda algumas vezes por ano, por resolução do Gecex; quando um NCM é encerrado, o produto que o
usa passa a aparecer no relatório NCMs inválidos para alguém trocar o NCM antes da fase fiscal. Nada aqui emite nota.
A atualização é um comando que **você** roda na VPS quando quiser (sugestão: uma vez por mês, ou quando o contador
avisar de uma resolução nova). Ele baixa a tabela do Portal Único Siscomex, confere se o arquivo está no formato de
sempre (se o formato mudou, **para sem mudar nada** e diz o motivo), e aplica em cada empresa, uma de cada vez, cada
uma inteira ou nada (README da API › decisão 193).

1. **Simular primeiro** (mostra o que mudaria, sem gravar nada):

   ```bash
   /opt/genesis/implantar.sh tarefa ncm-atualizar --simular
   ```

   A primeira linha diz a data da tabela e quantos NCMs ela tem. Depois, uma linha por empresa: quantos NCMs entram,
   quantos mudam de descrição, quantos são encerrados e quais produtos ficam com NCM inválido.

2. **Aplicar**, se a simulação fez sentido:

   ```bash
   /opt/genesis/implantar.sh tarefa ncm-atualizar
   ```

   Se algum NCM mudou, os caixas daquela empresa recebem o aviso de baixar a tabela de novo (acontece sozinho, em
   segundo plano, sem parar a venda). Os produtos listados aparecem no ERP em Relatórios › NCMs inválidos como "fora de
   vigência": dá para corrigir de 50 em 50 pelo "Definir NCM".

3. **Se o servidor não conseguir baixar do Siscomex** (mensagem "não foi possível baixar a tabela"): baixe no seu
   computador o JSON em
   `https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO`, copie para a
   VPS (ex.: `scp Tabela_NCM_Vigente_*.json <usuario>@<IP_DA_VPS>:/tmp/ncm.json`) e rode com o arquivo:

   ```bash
   /opt/genesis/implantar.sh tarefa ncm-atualizar --simular --arquivo - < /tmp/ncm.json
   /opt/genesis/implantar.sh tarefa ncm-atualizar --arquivo - < /tmp/ncm.json && rm /tmp/ncm.json
   ```

- **"encerraria N dos 10516 NCMs"**: o arquivo tiraria mais de 20% da tabela. Quase sempre é um download pela metade:
  baixe de novo. Numa revisão grande da Nomenclatura (a próxima do Sistema Harmonizado é a de 2027), confira a
  simulação e rode com `--permitir-encerramento-em-massa`.
- **Empresa "ignorada"**: estava migrando naquele momento (rode de novo depois) ou a tabela é mais antiga que a que ela
  já tem. **Empresa "falhou"**: ficou exatamente como estava; mande a mensagem para a próxima sessão de
  desenvolvimento. A saída é 1 só quando alguma empresa **falhou** ou o arquivo foi recusado; a empresa **ignorada** sai
  com 0 (não é erro), então olhe a linha de cada empresa e, se foi a migração, rode o comando de novo.
- **"--empresas recusado"**: algum código do `--empresas` não é número (uma letra no lugar de um dígito, um `;`, a
  vírgula sobrando). Nada foi feito, em nenhuma empresa: corrija e rode de novo (ex.: `--empresas 100001,100002`).
- O endereço do Siscomex fica em `SISCOMEX_NCM_URL` (`genesis.env`; o padrão é o oficial acima). Se o portal mudar o
  endereço, troque ali; o comando não segue redirecionamento de propósito.
- As migrações das próximas implantações **não desfazem** a tabela aplicada. Uma empresa criada depois recebe a tabela
  que veio no sistema e a mais nova na próxima vez que você rodar o comando.

## Página de download do PDV

Os PCs das lojas (Windows 10 e 11) baixam o instalador por um endereço fixo e simples, sem procurar o arquivo certo
no GitHub (a página nasceu quando o repositório era privado e o GitHub pedia login; continua com o repositório público,
D60). `https://download.grupoicebeer.com.br` serve o instalador do **GitHub Release `pdv-vX.Y.Z` mais novo
publicado** (rascunho e *pre-release* não contam), com a versão, o tamanho, o sha256 e as instruções curtas de
instalação na loja (os avisos do navegador e do SmartScreen para um instalador sem assinatura, o administrador que o
Windows pede e a ativação pelo código gerado no ERP). Sem release publicado, a página diz que o instalador ainda não
foi publicado.

**Como funciona.**

- A página (`apps/erp-web/nginx/download/`: `index.html`, `estilo.css` e `pagina.js`) vai na imagem do `genesis-web`.
  O `pagina.js` lê `/pdv/atual.json` e mostra o botão; `/pdv/atual.json` com 404 = "ainda não foi publicado".
- O instalador **não** entra na imagem: fica em `/opt/genesis/download/pdv`, montada só leitura no `genesis-web` em
  `/srv/download/pdv` (`docker-compose.yml`; caminho relativo ao `/opt/genesis`). O `instalar.sh` cria a pasta com
  `root:101` 750 e os arquivos 640: o nginx (uid/gid 101) só lê; só o root grava. O nginx só serve, em `/pdv/`, o
  `atual.json`, `GenesisPDV-Setup-X.Y.Z.exe` (sempre como download, `Content-Disposition: attachment`, com `Range`
  para retomar) e o `.sha256` em texto; qualquer outro nome é 404. A página tem CSP fechada
  (`cabecalhos-download.conf`: nada inline, só a própria origem) além dos cabeçalhos de sempre.
- O `atual.json` (gravado pelo `implantar.sh`, um campo por linha):

  ```json
  {
    "versao": "0.9.0",
    "arquivo": "GenesisPDV-Setup-0.9.0.exe",
    "tamanho_bytes": 73400320,
    "sha256": "<64 caracteres hexadecimais>",
    "publicado_em": "2026-11-04T15:20:00Z"
  }
  ```

- Quem publica é o workflow **Implantação**, em cada execução (manual ou automática):
  1. **Instalador do PDV (último GitHub Release)**, no runner, antes do `instalar.sh` e da troca de versão: lista os
     releases com o `GITHUB_TOKEN` do próprio workflow (`contents: read`; **nenhum segredo novo**), escolhe o
     `pdv-vX.Y.Z` publicado de **versão mais alta** e baixa o `.sha256` (uma linha só, o hash e o nome
     `GenesisPDV-Setup-X.Y.Z.exe`: o mesmo formato que a VPS exige). Se a VPS já serve esse instalador
     (`implantar.sh pdv atual` devolve o mesmo sha256, conferido no arquivo), não baixa nem envia nada. Senão, baixa
     o `GenesisPDV-Setup-X.Y.Z.exe` e compara o sha256 calculado dele com o do `.sha256`: **`.sha256` fora do
     formato ou sha256 diferente para a implantação aqui**, com a produção intacta. O GitHub sem responder (listar,
     ler o release ou baixar o `.sha256` ou o `.exe`: 5xx, tempo esgotado, conexão cortada) ou o release sem um dos
     dois arquivos: só um aviso (`::warning::`) e a implantação segue com a página como está (rode a Implantação de
     novo depois). **Nenhum** release `pdv-vX.Y.Z` publicado (a lista veio, vazia): aviso, e o passo 2 tira o
     instalador da página (`implantar.sh pdv retirar`).
  2. **Página de download (publica o instalador do PDV)**, depois da troca de versão: `tar | ssh implantar.sh pdv
     publicar X.Y.Z <publicado_em>`. Na VPS, o script extrai só os dois nomes esperados numa pasta temporária
     (`download/.recebendo.*`, no mesmo disco e fora da montagem), **confere o sha256 de novo** (o envio pode ter
     cortado), acerta dono e permissões e troca por `mv` (rename): o instalador, o `.sha256` e, por último, o
     `atual.json`. A página nunca serve um arquivo pela metade nem aponta para um que ainda não chegou. Guarda o
     instalador anterior, se for de versão menor (quem abriu a página antes da troca ainda baixa), e apaga os outros
     (inclusive um de versão maior, retirado do GitHub). Sem release publicado, `implantar.sh pdv retirar`: apaga
     primeiro o `atual.json` (a página passa a dizer "ainda não foi publicado") e depois os instaladores e os
     `.sha256`; sem nada publicado, não faz nada.
  3. A **conferência pública** abre a página, o `atual.json` (com a versão) e o primeiro byte do instalador (depois
     de um `retirar`, confere que o `atual.json` dá 404).
  4. O **resumo** da execução diz o que aconteceu com a página pelo resultado do passo 2 (publicado, retirado, já
     publicado, ou "não mexida" quando a implantação parou antes ou o envio falhou: aí é rodar de novo).
- **Implantar sem mexer na página**: Run workflow com **“publicar_pdv”** desmarcado (útil se o release estiver com
  problema e o ERP precisar sair mesmo assim).

**Publicar uma versão nova do PDV.**

1. **Actions › PDV release › Run workflow** na `main` com **publicar** marcado (ou a tag `pdv-vX.Y.Z` num commit da
   `main`): gera, testa e publica o GitHub Release com o instalador e o `.sha256` (README do PDV › Instalar na loja e
   decisão 62). O resumo da execução lembra que a página só muda na próxima implantação.
2. **Actions › Implantação › Run workflow** (branch `main`, campos padrão): a implantação publica o release novo na
   página (ou espere a próxima implantação automática, se ela estiver ligada).
3. Confira `https://download.grupoicebeer.com.br` (versão e sha256) ou, na VPS, `cat /opt/genesis/download/pdv/atual.json`.

Sem cota do Actions (D70), o passo 1 é da sessão do Claude Code (`apps/pdv/instalador/linux-wine/gerar-instalador.sh`,
`testar-instalador.sh`: README do PDV › decisão 93; desde a D120, o release o dono cria pelo site do GitHub com a pasta
do `preparar-release-manual.sh X.Y.Z`, README do PDV › Release pelo site do GitHub e decisão 94), e o passo 2 o vigia
faz sozinho: vê o release novo e publica na página, sem trocar a versão no ar (`implantar-sem-actions.sh --so-pdv`,
fora da janela das 17h à meia-noite; [Vigia da implantação](#vigia-da-implantação-d70-op-b4-e-op-b7)). À mão, no terminal da VPS: `bash
~/implantar-sem-actions.sh --so-pdv` (ou uma implantação com `--publicar-pdv`,
[Implantar sem o GitHub Actions](#implantar-sem-o-github-actions-d70)).

**Tirar uma versão da página** (ex.: saiu com defeito): no GitHub, edite o release e marque **“Set as a
pre-release”** (ou apague o release) e rode a Implantação (com **“publicar_pdv”** marcado): a página volta para o
release publicado de versão mais alta que sobrou, e o instalador retirado sai da pasta (a versão maior não fica como
"anterior"). Se **não sobrou nenhum** release `pdv-vX.Y.Z` publicado (hoje, só com a `pdv-v0.9.0`), a mesma
Implantação tira o instalador e a página volta a dizer que ainda não foi publicado. Sem esperar uma implantação, na
VPS:

```bash
/opt/genesis/implantar.sh pdv retirar   # apaga o atual.json e os instaladores; a página diz "ainda não foi publicado"
```

(Uma implantação seguinte com release publicado põe o instalador de volta; tire o release do GitHub antes.) Atenção:
o PDV não aceita voltar de versão num caixa que já instalou a nova (README do PDV › Atualizar); o normal é publicar uma
correção com versão maior.

**Decisões.**

- **Versão mais alta, não "o último criado"**: em geral é o mesmo release; escolher pela versão garante que a página
  nunca ofereça um instalador mais velho que um já publicado (um release antigo refeito, por exemplo), que o PDV
  recusaria por cima da versão nova.
- **Lista vazia retira; falha do GitHub não**: só uma resposta bem-sucedida sem nenhum `pdv-vX.Y.Z` publicado tira o
  instalador da página (o dono tirou o último release). Erro ao listar, ler ou baixar (5xx, tempo esgotado, conexão
  cortada) nunca mexe na página nem reprova a implantação; só o `.sha256` fora do formato ou um sha256 que não confere
  reprovam, antes da troca de versão.
- **Publicação na implantação, não no PDV release**: o PDV release não tem (nem deve ter) a chave SSH da VPS, e o
  environment `producao` continua o único com acesso à VPS. Custo: a página só muda na próxima implantação.
- **Sem jq na VPS**: o `implantar.sh` escreve e lê o `atual.json` com `printf`/`sed` (valores já validados por
  expressões: versão `X.Y.Z`, sha256 hexadecimal, tamanho numérico, data ISO).
- **`voltar` não mexe na página**: o instalador publicado continua. Voltar para uma versão anterior a esta mudança
  (sem a montagem) deixa a página dizendo "ainda não foi publicado" até a próxima implantação.
- **Memória**: nada muda nos limites (o `genesis-web` continua com 128 MB; o nginx só serve o arquivo do disco).

## Backup (I1b)

O Cloud SQL de teste grátis não faz backup (Passo 1). O container `genesis-backup` faz um **backup lógico diário** de
todos os bancos e guarda no bucket do Google Cloud Storage que a API já usa (pela mesma chave HMAC de
`segredos/genesis-google.env`), separado dos arquivos da aplicação pelo prefixo `backups/`.

**Como funciona.** Todo dia às **04:30 de Brasília** (`BACKUP_HORARIO` no `/opt/genesis/.env`; fora do pico e depois
da janela de manutenção do Cloud SQL, terças às 04:00), o container:

1. lista os bancos no servidor (o `genesis_control` e todo `genesis_emp_<código>`);
2. faz o `pg_dump --format=custom` de cada um, um por vez, pelo `genesis-cloudsql-proxy`, com o cliente do
   PostgreSQL 18 (a mesma versão do Cloud SQL), num volume em disco (`genesis-backup-trabalho`);
3. envia cada arquivo para `backups/AAAA-MM-DD/<banco>.dump` (com o sha256 nos metadados) e apaga o local;
4. grava `backups/AAAA-MM-DD/manifesto.json` (tamanho e sha256 de cada arquivo, falhas, versão do `pg_dump`) e
   `backups/estado.json` (último backup e último sucesso: é o que o painel do monitoramento mostra);
5. se tudo deu certo, aplica a retenção: apaga os dias que estão **ao mesmo tempo** fora dos 14 mais recentes
   guardados e fora dos últimos 14 dias do calendário (`BACKUP_RETENCAO_DIAS`). Um backup que falhou nunca apaga nada,
   e uma semana de falhas não apaga os dias bons que restaram. O bucket tem **versionamento** (o
   `configurar-genesis.sh` ligou, com as versões antigas guardadas 90 dias): um `DELETE` comum ou uma sobrescrita só
   transformaria o dump em versão antiga, então a retenção apaga **cada versão** (`generation`) dos dias vencidos e
   também as versões antigas que sobraram em `backups/` (de um `backup agora` repetido e do `estado.json`). Um
   `DELETE` que falha aparece no log como `FALHOU` (o dia continua no bucket e entra na retenção do dia seguinte).

Cada linha do log (`docker logs genesis-backup`) diz o banco, o tamanho e o sha256, ou `FALHOU` com o motivo. Uma
falha num banco não impede os outros; o dia fica com `status: falhou` no manifesto e no `estado.json`. O manifesto
sobe antes do `estado.json`: se ele não subir, o dia é falha (sem manifesto, ele não é restaurável) e o painel mostra
`falhou`. Rodar `backup agora` no mesmo dia substitui os arquivos do dia (a versão anterior sai na retenção desse
backup).

**Quanto tempo os dumps ficam guardados, de verdade.** No bucket, os 14 dias da retenção. Depois de apagado, um
objeto ainda fica recuperável pelo *soft delete* do GCS pelo prazo da política do bucket (7 dias no padrão; vale para
o bucket inteiro, também para os arquivos da aplicação) e é cobrado nesse período. Ou seja: até **~21 dias** com os
dados de todas as empresas, não 14 (conta para o custo e para um pedido de exclusão pela LGPD). Se a retenção falhar
ou o container parar, as regras de ciclo de vida abaixo limitam o que sobra.

**O que olhar.** `implantar.sh estado` mostra o último backup e o último sucesso, e o `docker logs genesis-backup` o
detalhe. O container só fica `unhealthy` no `docker ps` se o agendador parar (um backup com falha não muda a saúde:
travaria o `up --wait` da implantação). O Hermes vê o resultado em `ultimo_backup` do `/api/saude/detalhada`; a regra
é: **avisar se `status` não for `ok` ou se `data` tiver mais de 26 h**.

**Segurança.** O bucket é privado e o Google cifra tudo em repouso. Os dumps **não** têm uma cifra nossa por cima
(perder essa chave seria perder os backups) e ficam no mesmo projeto do Google que o banco: protegem contra erro,
banco apagado e corrupção, não contra a perda da conta do Google. Uma cópia fora do Google fica para depois
([Pendências](#pendências)). Quem lê o bucket lê os dados de todas as empresas: a chave HMAC continua só na VPS.

**Obrigatório (no Cloud Shell, uma vez): regras de ciclo de vida do bucket** (aplicadas pelo dono em 10/11/2026, as
quatro). As de `backups/` são a garantia da retenção quando o container não apaga (parado, chave sem permissão):
(a) versões antigas em `backups/` saem no dia seguinte, em vez dos 90 dias da regra geral; (b) dumps atuais com mais
de 30 dias viram versão antiga (e saem pela (a)). A `AbortIncompleteMultipartUpload` (1 dia) descarta o envio em
partes que ficou aberto: a exportação de relatório em tarefa envia o arquivo em partes (README da API › decisão 177),
e o processo que reinicia no meio deixa o envio aberto, cobrando, até ser abortado. O comando **substitui a lista
inteira**: confira antes as regras que o bucket já tem (o `configurar-genesis.sh` criou a das versões antigas em 90
dias) e ponha **todas** no arquivo.

```bash
gcloud storage buckets list --format="table(name,location)"   # o bucket de arquivos é o de SOUTHAMERICA-EAST1
B=NOME_DO_BUCKET
gcloud storage buckets describe gs://$B --format="yaml(lifecycle_config,soft_delete_policy,versioning_enabled)"
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":90}},{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":1,"matchesPrefix":["backups/"]}},{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["backups/"]}},{"action":{"type":"AbortIncompleteMultipartUpload"},"condition":{"age":1}}]}' > ciclo.json
cat ciclo.json                                                   # tem de terminar com AbortIncompleteMultipartUpload
gcloud storage buckets update gs://$B --lifecycle-file=ciclo.json
gcloud storage buckets describe gs://$B --format="yaml(lifecycle_config)"   # as quatro regras
```

- O `gcloud storage` usa os nomes `lifecycle_config`, `soft_delete_policy` e `versioning_enabled`: com os nomes da
  API JSON (`lifecycle`, `softDeletePolicy`) o `--format` responde `null`, que **não** quer dizer "sem regras".
- O arquivo vai numa linha só (`echo`): no Cloud Shell, colar um `cat <<'FIM'` de várias linhas às vezes não grava
  nada, e o `update` reaplica o `ciclo.json` antigo sem erro. Por isso o `cat ciclo.json` antes do `update`.
- O ciclo de vida do GCS roda uma vez por dia (pode levar até 24 h para valer). O `soft_delete_policy` mostra o prazo
  do *soft delete* (o padrão é 7 dias, `retentionDurationSeconds: '604800'`).

### Restaurar

A restauração **nunca escreve por cima** de um banco que existe: ela cria o banco (com a mesma codificação e a
colação ICU `pt-BR` do original, lidas do próprio dump), confere o sha256 do arquivo com o manifesto e restaura com
`pg_restore --no-owner --no-acl`. Os privilégios da role de runtime de cada empresa voltam com o `migrar-empresas`.
As extensões do provedor que o servidor de destino não oferece ficam de fora, com um aviso no log: o Cloud SQL cria
a `google_vacuum_mgmt` (esquema e extensão) em todo banco, o `pg_dump` a leva para o backup e o próprio Cloud SQL não
deixa recriá-la ("Could not open extension control file"); sem esse filtro a restauração parava no primeiro erro
(achado no primeiro ensaio de restauração, 04/11/2026). Se uma restauração falhar no meio, o banco de destino fica
criado pela metade: apague-o (`backup psql postgres -c 'drop database <nome>'`) antes de tentar de novo.
É preciso o `segredos/genesis-app.env` original: a `CHAVE_MESTRA` decifra a senha das roles das empresas guardada no
`genesis_control` (por isso a cópia dele no cofre de senhas, Passo 5).

**Uma empresa voltando a ontem** (ex.: alguém apagou dados): restaure ao lado, confira e só então troque.

```bash
/opt/genesis/implantar.sh backup listar                              # escolha o dia
/opt/genesis/implantar.sh backup restaurar 2026-11-10 genesis_emp_1001 --como genesis_emp_1001_restauro
# conferir os dados em genesis_emp_1001_restauro; para trocar (com a empresa sem uso, ex.: de madrugada):
docker stop genesis-api
/opt/genesis/implantar.sh backup psql postgres \
  -c 'alter database genesis_emp_1001 rename to genesis_emp_1001_antigo' \
  -c 'alter database genesis_emp_1001_restauro rename to genesis_emp_1001'
/opt/genesis/implantar.sh tarefa migrar-empresas                     # privilégios da role da empresa no banco novo
docker start genesis-api
```

Os caixas reenviam sozinhos o que a nuvem não tem (eventos idempotentes); o suporte pode forçar com o comando
`ressincronizar` do ERP. Apague o `_antigo` só depois de conferido:
`implantar.sh backup psql postgres -c 'drop database genesis_emp_1001_antigo'`.

**Tudo (instância perdida ou apagada).** Crie uma instância nova do Cloud SQL (PostgreSQL 18) com o usuário `genesis`
com a **mesma senha** do `DATABASE_URL` (o `genesis_control` guarda essa credencial, cifrada, em `servidores_banco`),
aponte o `CLOUDSQL_INSTANCIA` do `/opt/genesis/.env` (e o de `segredos/genesis-google.env`) para ela e:

```bash
cd /opt/genesis && docker compose up -d --wait genesis-cloudsql-proxy    # o proxy na instância nova
docker stop genesis-api
/opt/genesis/implantar.sh backup restaurar 2026-11-10 todos             # genesis_control e todas as empresas
/opt/genesis/implantar.sh tarefa migrar-empresas                        # recria a role de runtime de cada empresa
cd /opt/genesis && docker compose up -d --wait
```

Perde-se o que foi feito no ERP desde o backup da madrugada; as vendas dos caixas sobem de novo. Este roteiro
inteiro (servidor vazio → `restaurar todos` → contagens de linhas e colação iguais às de antes → `migrar-empresas` →
login no ERP) roda a cada `testar-local.sh` ([Teste local da stack](#teste-local-da-stack)).

## Monitoramento (Hermes, I1b)

O dono usa o **Hermes** (assistente no Telegram) para acompanhar a operação, **só leitura**: ele não tem acesso ao
Docker, à VPS nem ao banco; consulta duas URLs.

| URL | Autenticação | Para quê |
|---|---|---|
| `GET https://api.grupoicebeer.com.br/saude` | nenhuma | Está no ar? 200 com `"status":"ok"`; **503** sem o banco |
| `GET https://api.grupoicebeer.com.br/api/saude/detalhada` | `Authorization: Bearer <token>` | O painel abaixo (também em `https://erp.grupoicebeer.com.br/api/saude/detalhada`) |

**Token.** Gerado na VPS por `implantar.sh token-monitor` (Passo 8): 32 bytes aleatórios, mostrados uma vez; a VPS
guarda só o SHA-256 (`MONITOR_TOKEN_SHA256` em `segredos/genesis-app.env`) e a API compara em tempo constante. Rodar
de novo **troca** o token (a API é recriada e o anterior para de valer na hora). Para **revogar** sem um novo: apague
a linha `MONITOR_TOKEN_SHA256=` do `genesis-app.env` e rode `cd /opt/genesis && docker compose up -d genesis-api`. O
token só abre esta rota: não serve como sessão do ERP, do painel da plataforma nem do PDV, e a sessão do ERP não abre
esta rota.

**Respostas.**

| Código | Quando | Corpo |
|---|---|---|
| 200 | Token certo | O JSON abaixo (sempre 200 com o token: o `status` do corpo diz se algo está degradado) |
| 401 | Sem token, token errado ou nenhum token configurado | `{"codigo":"NAO_AUTENTICADO","mensagem":"Token de monitoramento ausente ou inválido."}` |
| 429 | Mais de 30 consultas por minuto do mesmo IP (as erradas também contam; `MONITOR_LIMITE_POR_MINUTO`) | `{"codigo":"LIMITE_TAXA",...}` com `Retry-After: 60` |

Consultar a cada 1 a 5 minutos é o esperado. **Formato exato** (exemplo):

```json
{
  "status": "ok",
  "gerado_em": "2026-11-10T12:00:00.000Z",
  "api": { "versao": "3dc47b0d23bd", "ambiente": "producao", "no_ar_desde": "2026-11-10T09:12:44.120Z" },
  "banco": { "status": "ok", "latencia_ms": 2.4 },
  "terminais": [
    { "empresa": 1001, "loja": { "codigo": 1, "nome": "Loja 1 - Centro" }, "caixa": 1,
      "status": "online", "ultima_sincronizacao": "2026-11-10T11:59:41.002Z" },
    { "empresa": 1001, "loja": { "codigo": 2, "nome": "Loja 2 - Bairro" }, "caixa": 1,
      "status": "offline", "ultima_sincronizacao": "2026-11-10T10:31:07.554Z" }
  ],
  "eventos_fila_decisao": 0,
  "tarefas_atrasadas": 0,
  "empresas_sem_resposta": 0,
  "ultimo_backup": { "status": "ok", "data": "2026-11-10T07:31:10Z", "tamanho_bytes": 1843200,
                     "ultimo_sucesso_em": "2026-11-10T07:31:10Z" },
  "memoria": { "usada_bytes": 412090368, "limite_bytes": 2080374784 },
  "processo": { "no_ar_segundos": 10036, "heap_usado_mb": 182.4, "heap_total_mb": 214.1, "heap_limite_mb": 1584,
                "rss_mb": 356.7 }
}
```

| Campo | Significado |
|---|---|
| `status` | `ok`, ou `degradado` se o banco, a consulta dos terminais ou a das tarefas falhou (ou alguma empresa não respondeu) |
| `gerado_em` | Hora da resposta (UTC, ISO 8601) |
| `api.versao` / `api.ambiente` / `api.no_ar_desde` | Commit em produção (12 caracteres), `producao`, e desde quando este processo da API está no ar (reinício = data nova) |
| `banco.status` / `banco.latencia_ms` | `ok`/`erro` e o tempo de um `select 1` no `genesis_control`, em ms (`null` com erro) |
| `terminais[]` | Um por caixa ativo, em ativação, desativando, ou revogado nos últimos 7 dias. `empresa` = código da empresa; `loja` = `{codigo, nome}` (`null` se a empresa não respondeu); `caixa` = número do caixa; `status` = `online` (contato nos últimos 2 min), `offline` (sem contato recente) ou `desativado` (desativando/revogado); `ultima_sincronizacao` = último heartbeat, pull ou push (`null` = nunca) |
| `eventos_fila_decisao` | Eventos dos caixas em `erro`/`retido` esperando decisão no ERP (PDVs/Terminais › fila de decisão); `null` se não deu para consultar |
| `tarefas_atrasadas` | Tarefas em segundo plano (pg-boss) que deviam ter começado há mais de 5 min; `null` se não deu para consultar |
| `empresas_sem_resposta` | Empresas cujo banco não respondeu (em manutenção ou fora do ar) |
| `ultimo_backup.status` | `ok`, `falhou`, `ausente` (nunca houve backup) ou `indisponivel` (o bucket não respondeu) |
| `ultimo_backup.data` / `tamanho_bytes` / `ultimo_sucesso_em` | Fim do último backup (UTC), o tamanho somado dos arquivos e o fim do último backup sem falha |
| `memoria.usada_bytes` / `limite_bytes` | Memória do container da API (como no `docker stats`) e o limite (1984 MiB; 2 GiB até o OP-B5) |
| `processo.no_ar_segundos` | Há quantos segundos este processo da API está no ar (volta para perto de zero a cada reinício) |
| `processo.heap_usado_mb` / `heap_total_mb` / `heap_limite_mb` | Heap do Node (V8) em MiB: o usado, o reservado e o teto (`--max-old-space-size=1536` mais o espaço novo); passar do teto derruba a API com `JavaScript heap out of memory` |
| `processo.rss_mb` | Memória do processo no sistema (heap, buffers, código), em MiB |

Nada pessoal (nomes de pessoas, CPF/CNPJ, e-mails, descrição dos caixas, nome das máquinas, IPs), nenhum valor de
venda e nenhum segredo aparecem na resposta (teste de integração `apps/api/test/integracao/saude-detalhada.test.ts`).

**Regras sugeridas para o Hermes avisar:**

| Situação | Regra |
|---|---|
| API fora do ar | `/saude` sem resposta ou diferente de 200 em 2 consultas seguidas |
| Algo degradado | `status` = `degradado`, `banco.status` = `erro`, ou `banco.latencia_ms` > 200 por 10 min |
| Caixa sem internet | terminal `offline` há mais de 15 min (pela `ultima_sincronizacao`) em horário de loja aberta |
| Fila de decisão | `eventos_fila_decisao` > 0 (alguém precisa decidir no ERP) |
| Fila parada | `tarefas_atrasadas` > 0 por 10 min |
| Backup | `ultimo_backup.status` diferente de `ok`, ou `ultimo_backup.data` com mais de 26 h |
| Memória | `memoria.usada_bytes` acima de 85 % de `limite_bytes` por 10 min |
| Reinício | `api.no_ar_desde` mudou sem implantação (`api.versao` igual), ou `processo.no_ar_segundos` voltou para menos de 300 com a mesma `api.versao` (olhar: README › Operação › A API reiniciou sozinha) |
| Heap do Node | `processo.heap_usado_mb` acima de 85 % de `processo.heap_limite_mb` em 2 consultas seguidas |

## Teste local da stack

`infra/producao/teste/testar-local.sh` sobe o `docker-compose.yml` de produção **sem mudança**, com o override
`teste/docker-compose.teste.yml`:

- `genesis-cloudsql-proxy` vira um **PostgreSQL 18** com o mesmo nome na rede interna e o usuário `genesis` com os
  privilégios do Cloud SQL (`CREATEDB` e `CREATEROLE`, **sem SUPERUSER**); o `genesis_control` não existe antes
  (a migração cria, como em produção); os dados ficam num tmpfs, que conta na memória do container (1536 MiB);
- um **Traefik v3** local (imagem com a versão fixada no override) na porta `127.0.0.1:18443`, lendo os mesmos labels;
- um **S3 local** (RustFS, o mesmo do desenvolvimento) no lugar do bucket do GCS, com a mesma assinatura (I1b).

E passa pelos scripts da VPS numa pasta temporária: `instalar.sh` duas vezes (a segunda não troca nenhum segredo;
permissões 700/600/640), `docker compose config`, `implantar.sh implantar` (migrações no container de tarefa,
`up --wait`), `admin-criar` e `empresa-criar` no container de tarefa, `migrar-empresas` de novo, e confere pelo
Traefik com os domínios de produção: `/saude` nos domínios da API e do ERP, o ERP (rotas do SPA caem no
`index.html`, HSTS), a página de download (CSP, `/pdv/atual.json` 404 sem instalador; `implantar.sh pdv publicar`
com instaladores de mentira: download inteiro com `attachment`, `.sha256`, recusa de sha256 errado sem tocar na página
nem deixar temporário, e a retenção da atual e da anterior), `/sync/*` só no domínio da API, o login no ERP pela origem do ERP com o cookie
`Secure` + `SameSite=Strict`, os limites de memória (a soma do compose de produção com a tarefa ≤ 2560 MiB; a tarefa
sem o healthcheck da imagem e o pico de cada comando dela no limite de 192 MiB — `migrar-controle`, três
`empresa-criar` até 4 empresas, o lote das migrações, `migrar-empresas`, `referencias` e `particoes`; OP-B5), os
usuários sem root, uma segunda versão seguida de `voltar` e o bloco
do Cloud Shell colado de novo (o `estado` avisa da chave `root:root 600`; o `instalar.sh` devolve `root:65532 640`).
Do I1b: o `genesis-backup` healthy e sem root; `backup agora`/`listar`/`estado` com os dois bancos no bucket e o pico
de memória dentro dos 64 MiB; o `token-monitor` (recusa sem terminal, grava só o hash, a troca invalida o anterior) e
o `/api/saude/detalhada` (401 sem token, 200 nos dois domínios com o último backup e a memória de 1984 MiB do
container); o **ensaio de desastre** (API parada, backup, o PostgreSQL trocado por um vazio, `restaurar todos`,
contagens de linhas de todas as tabelas e a colação iguais às de antes, `--como` ao lado, recusa por cima,
`migrar-empresas` e o login no ERP); e o pico do Cloud SQL Auth Proxy de verdade com 192 MiB (sem o Google: só a
subida e conexões recusadas). No fim remove containers, redes, volumes, imagens de teste e a pasta.

Roda **como root** (`sudo`), como na VPS: o `instalar.sh` exige root e põe a chave da conta de serviço no grupo
65532 (`chown`). Estar no grupo `docker` não basta; o script recusa logo no começo, antes do build.

```bash
sudo infra/producao/teste/testar-local.sh                 # builda as imagens genesis-*:teste-local
sudo infra/producao/teste/testar-local.sh --manter        # deixa a stack no ar para olhar
sudo infra/producao/teste/testar-local.sh --sem-actions   # e o ensaio do implantar-sem-actions.sh (D70)
```

Com `--sem-actions`, depois da volta atrás, o `implantar-sem-actions.sh` implanta o commit atual (`HEAD`, numa `main`
local no lugar do repositório público; o que não foi commitado não entra): `--simular` primeiro (nada muda), depois
o build das 3 imagens pelo script, a troca pelo `implantar.sh` (as migrações de verdade), as URLs públicas pelo Traefik
local (os domínios de produção levados a `127.0.0.1`), a API no ar com a versão do commit
(`/api/saude/detalhada`) e o `voltar` para a `teste-local`. As opções de build (`TESTE_BUILD_OPCOES` e as imagens
base) valem também para ele.

Precisa de `docker`, `openssl`, `curl` e `jq` na máquina. Atrás de um proxy corporativo com CA própria, passe imagens
base que confiem nela e, se o build só sai pelo proxy, as opções do `docker build`:

```bash
sudo TESTE_IMAGEM_NODE=<node com a CA> TESTE_IMAGEM_ALPINE=<alpine:3.24 com a CA> \
  TESTE_BUILD_OPCOES="--network host --build-arg https_proxy=http://127.0.0.1:3128" infra/producao/teste/testar-local.sh
```

## Decisões técnicas (I1)

- **Imagens transferidas por `docker save | ssh docker load`**, sem registry: a VPS não guarda credencial de
  registry e o GitHub não precisa publicar imagem. Custo: cada deploy envia as camadas inteiras (~125 MB
  comprimidos com `gzip -1`, medidos no teste local: API ~88 MiB, ERP ~22 e, desde o I1b, backup ~12). Se ficar
  lento, o caminho é o GHCR com um token só de leitura na VPS.
- **Uma imagem da API para tudo**: a mesma roda a API (`node dist/main.js`) e as tarefas (`node dist/cli/*.js`,
  os CLIs compilados), sem `tsx` nem dependências de desenvolvimento (`pnpm deploy --prod` com o
  `@genesis/shared` copiado). Os dados das referências nacionais e o SQL das migrações vão junto.
- **Migrações antes da troca, num container de tarefa** (`genesis-tarefa`, perfil `tarefa`): controle, depois
  empresas (canário e lotes). Falha → para e a versão anterior continua; nova versão sem saúde em 240 s → volta
  sozinha para a anterior.
- **Tarefa dentro do teto de 2,5 GB**: ela roda com a API no ar, então conta no limite somado da decisão do dono.
  No I1, 128 MB (heap do Node 96 MB), com o pico de 82 MiB medido no `referencias`; desde o OP-B5, **192 MB (heap
  128 MB)**, com os 64 MB tirados da API, e sem o healthcheck da imagem
  ([Decisões técnicas (memória da tarefa, OP-B5)](#decisões-técnicas-memória-da-tarefa-op-b5-24112026)). Um estouro
  derruba só a tarefa (a implantação para antes da troca e a versão anterior continua). O `genesis-backup` do I1b (64 MB) coube tirando
  64 MB do proxy do Cloud SQL ([Decisões técnicas (I1b)](#decisões-técnicas-i1b)).
- **Commit da implantação sempre da `main`**: o checkout traz o histórico inteiro, o workflow resolve o hash curto
  (o `actions/checkout` só aceita SHA completo em `ref`) e exige `git merge-base --is-ancestor <commit> origin/main`.
  A regra de branch do environment só olha o branch do disparo.
- **Chave de host do SSH por `HostKeyAlias`**: o `known_hosts` é procurado pelo `VPS_HOST` puro com qualquer
  `VPS_PORTA`, sem depender de o ssh tentar de novo sem o `[IP]:porta` (o OpenSSH atual tenta), e com
  `StrictHostKeyChecking yes` (chave diferente → recusa).
- **ERP na mesma origem da API**: o Traefik manda `erp.<domínio>/api/*` e `/saude` para a API (prioridade 100) e o
  resto para o nginx. O cookie de refresh (`SameSite=Strict`, caminho `/api/auth`) funciona sem CORS, como no Vite
  em desenvolvimento; nenhuma URL de API no build do ERP. `/sync/*` (PDV) só no domínio da API.
- **`TRUST_PROXY=1`**: o único proxy à frente da API é o Traefik, que reescreve o `X-Forwarded-For` de quem não é
  confiável. Ressalva: qualquer container na rede `proxy` (projeto icebeer) também fala direto com a API.
- **Proxy do Cloud SQL na variante `-alpine`** (tem `wget` para o healthcheck) com a chave da conta de serviço em
  `root:65532 640` (o proxy roda como 65532); a instância vem por `CSQL_PROXY_INSTANCE_CONNECTION_NAME`.
- **Rede `genesis-interna` sem `internal: true`**: o proxy precisa sair para o Google e a API para o GCS, a
  consulta de CEP e o SMTP. Nenhuma porta publicada no host.
- **Containers endurecidos**: sistema de arquivos só leitura (`tmpfs` em `/tmp`), `cap_drop: ALL`,
  `no-new-privileges`, usuários sem root, logs `json-file` com 10 MB × 5 arquivos por container.
- **Implantação automática desligada por padrão** (`IMPLANTACAO_AUTOMATICA`): sem os secrets, um merge na main não
  quebra nada. O `workflow_run` só aceita CI verde de **push** deste repositório (um PR de fork com um branch
  chamado `main` também dispara `workflow_run`).
- **PostgreSQL 18** (Cloud SQL): a suíte de integração passou no 18; duas correções saíram daí — a consulta de
  teste em `pg_database.daticulocale` (virou `datlocale` no 17) e o `alter role` da role de runtime, que citava
  `NOSUPERUSER`/`NOREPLICATION`/`NOBYPASSRLS` e é recusado no PostgreSQL 16+ para quem não é superusuário (o caso
  do `genesis` no Cloud SQL; apps/api/README.md, decisão da implantação). O CI roda a integração também no 18.
- **CI por caminhos (04/11/2026, cota de minutos do GitHub Free esgotada)**: o `ci.yml` só roda cada job pesado
  quando muda algo que ele confere (tabela em CONTRIBUTING.md › CI: o que roda quando). O job "Imagens Docker" roda
  quando muda o contexto do build (raiz menos o `.dockerignore`: `apps/api`, `apps/erp-web`, `packages`, os arquivos
  do pnpm na raiz) ou `infra/producao`; o shellcheck, os testes do backup e o compose de produção vão junto. Job
  pulado conta como sucesso, então o `workflow_run` desta implantação continua disparando depois do CI verde de
  push na `main`. Para não implantar commit sem CI, o push na `main` compara contra o último commit da `main` com CI
  verde de push (normalmente o anterior; se o dele falhou ou foi cancelado pelo `concurrency`, o último verde),
  nunca só contra o `before`. Disparo manual verde não conta como base: ele pode ter rodado um job só. A implantação em si continua buildando as três imagens sempre: um commit só de documentação
  implantado à mão sai igual ao anterior, com a nova versão no nome.

## Decisões técnicas (I1b)

- **Backup num container próprio, com os clientes do PostgreSQL 18** (`alpine:3.24` + `postgresql18-client`, `bash`,
  `curl`, `jq` e `tzdata`; usuário `postgres` (70), 64 MB): o `pg_dump` precisa ser da versão do servidor ou mais novo; a imagem da API (Node) não
  tem o cliente, e um cron no host da VPS ficaria fora do projeto `genesis` (e do teto de memória). O agendamento é um
  laço do próprio script (o `crond` exige root), com batimento a cada minuto para o healthcheck.
- **Envio ao GCS pelo `curl --aws-sigv4`** com a mesma chave HMAC da API (S3 interoperável do GCS): sem `aws-cli`
  (Python, pesado para 64 MB) nem credencial nova. As credenciais vão para arquivos 600 em `/tmp` (tmpfs; o `curl`
  lê a chave de um `-K`, o `pg_dump` a senha de um `PGPASSFILE`): nunca aparecem na linha de comando nem no log.
- **Dumps em disco, não em tmpfs**: o tmpfs conta no limite de memória do container; o volume
  `genesis-backup-trabalho` guarda um dump por vez, apagado depois do envio.
- **Formato custom, um arquivo por banco**: restaurar uma empresa não mexe nas outras (VG 11.2). O `CREATE DATABASE`
  sai do próprio dump (codificação e colação ICU `pt-BR` do original), o que permite criar o banco com outro nome
  (`--como`) ao lado do original. `--no-owner --no-acl`: os privilégios da role de runtime de cada empresa voltam com
  o `migrar-empresas` (`garantirRoleAplicacao`, que já roda depois de toda migração).
- **Estado no bucket (`backups/estado.json`), não numa tabela do controle**: o backup que falhou porque o banco caiu
  ainda registra a falha, e a API lê o objeto para o painel. O `backups_empresas` (painel da plataforma) fica para o
  backup por empresa com retenção contratual (ERP 19.10).
- **Retenção que não apaga com falhas**: só depois de um backup sem falha, e só o que está fora dos 14 dias mais
  recentes guardados **e** fora dos últimos 14 dias do calendário.
- **Retenção num bucket versionado**: o `DELETE` do S3 do GCS sem versão só deixa o objeto como versão antiga (e as
  versões antigas do bucket ficam 90 dias). A retenção lista as versões no formato próprio do XML do GCS
  (`?versions`, cada versão com `<Generation>` e `<IsLatest>`, página seguinte por `marker` + `generation-marker`;
  no S3 do teste local, `ListObjectVersions` com `VersionId`), apaga cada uma com `?generation=` (o parâmetro
  documentado do XML do GCS; no S3, `versionId`) e confere que o dia sumiu. O cabeçalho
  `x-goog-interop-list-objects-format` (que pediria o formato do S3) não pode ir: o GCS recusa cabeçalho `x-goog`
  junto da assinatura `x-amz` do curl (400 `ExcessHeaderValues`, achado em produção em 04/11/2026, quando a retenção
  falhava todo dia com "FALHOU a listagem das versões de backups/"). As regras de ciclo de vida de `backups/` (obrigatórias, [Backup](#backup-i1b)) cobrem o container parado.
  Sobra o *soft delete* do bucket (7 dias no padrão): os dumps ficam até ~21 dias, não 14.
- **Falhas tratadas sem depender do `set -e`**: dentro de uma função chamada com `||` ou `if`, o bash desliga o
  `set -e`; a retenção, a restauração e as listagens conferem cada passo, e o agendador roda o backup em outro
  processo (`genesis-backup agora`), onde o `set -e` vale. O `estado` só diz "nenhum backup registrado" quando o
  `estado.json` não existe (NoSuchKey); 403, rede ou 5xx saem como "bucket indisponível", com o motivo (código 1).
- **Senha do `DATABASE_URL` decodificada como na API**: só as sequências `%XX` (o `pg-connection-string` usa
  `decodeURIComponent`): `+` continua `+` e a barra invertida é literal. O teste local usa uma senha com `+`, `%2B` e
  `\`; o `testar-genesis-backup.sh` confere a decodificação contra o `pg-connection-string` de verdade.
- **Imagem do backup em Alpine com só o cliente do PostgreSQL 18** (`postgresql18-client`, ~12 MiB comprimidos, contra
  ~114 MiB da `postgres:18-alpine` inteira, que trazia servidor, JIT e um `VOLUME` que deixava volume anônimo órfão):
  o deploy envia todas as camadas a cada vez. O `ARG VERSAO` vem depois do `apk add`, que assim fica no cache do CI.
- **Proxy do Cloud SQL de 256 para 192 MB**: o pico medido do proxy de verdade (`testar-local.sh`, sem o Google:
  subida e conexões recusadas) ficou entre 12 e 35 MiB nas medições locais (11 MiB em repouso); o processo é Go e só
  repassa conexões. Os 64 MB liberados são do backup, e a soma continua 2560 MiB. O pico real em produção aparece no
  `implantar.sh estado`.
- **Painel com token próprio, só o hash no ambiente** (`MONITOR_TOKEN_SHA256`): o token não é sessão nem JWT, não
  expira sozinho e não abre outra rota; o `genesis-app.env` vazado não entrega o token. Limite por IP contando as
  tentativas erradas. Detalhes na decisão 201 de `apps/api/README.md`.
- **Token gerado só no terminal da VPS** (`implantar.sh token-monitor` recusa sem terminal, a não ser com
  `--arquivo`): o workflow roda o `instalar.sh` e o `implantar.sh` por SSH e guarda o log, então o token nunca passa
  por ele.
- **Voltar para uma versão anterior ao I1b** (`implantar.sh voltar`): o compose dela não tem o `genesis-backup`, então
  o `up --remove-orphans` tira o backup do ar até a próxima implantação (o `implantar.sh` só exige a imagem do backup
  das versões que a usam).

## Decisões técnicas (diagnóstico de queda da API, 05/11/2026)

- **Log guardado pelo `implantar.sh`, não um driver de log novo**: o `json-file` (10 MB × 5) já guarda o log entre
  os reinícios do mesmo container; ele só some quando o container é recriado, e quem recria é o `implantar.sh`
  (`implantar`, `voltar`, a volta automática, `token-monitor`). Guardar ali, antes do `up`, cobre o caso sem mudar o
  driver (journald ou um coletor somariam memória e configuração na VPS, que é dividida com o `icebeer`). O
  `docker compose up -d` à mão também recria: por isso o `logs guardar`.
- **O trecho em volta do último reinício, além das últimas 5.000 linhas**: o fim do log é a hora antes da
  **troca**, não da queda. O pino-http escreve uma linha por requisição (o healthcheck sozinho, a cada 15 s, dá
  ~5.760 por dia; com o sync dos PDVs, o ERP e o Hermes, as 5.000 linhas cobrem de 3 a 20 horas), e a troca pode vir
  dias depois da queda (a de 04/11 só foi recriada em 05/11). Com `RestartCount > 0`, o `State.StartedAt` é a subida
  do processo que o Docker pôs de volta, logo depois da queda: o `docker logs --since <StartedAt − 30 min> --until
  <StartedAt + 2 min>` pega o aviso do heap, a linha fatal (`"level":60` ou o `FATAL ERROR` do V8) e o `API no ar` da
  volta, enquanto o `json-file` (10 MB × 5) ainda tiver essas linhas. Até 5.000 linhas também (num pico de log, o
  fim do trecho, onde estão a queda e a volta). Não o `json-file` inteiro comprimido: até 50 MB lidos a cada troca
  para guardar sobretudo healthchecks, e o roteiro só precisa da queda. Só o último reinício: o Docker não guarda o
  `StartedAt` dos anteriores.
- **20 arquivos, 30 dias**: o arquivo fica em poucos MB; 20 arquivos cobrem semanas de implantações diárias e o teto
  de 30 dias não deixa log com IP e ids parado na VPS.
- **`logs` sem a trava das implantações**: é só leitura (ou um arquivo novo), e dá para olhar durante uma
  implantação travada.
- Detalhes na decisão 166 de `apps/api/README.md`.

## Decisões técnicas (repositório público, D60, 06/11/2026)

- **Nada da VPS no log do Actions**: com o repositório público, o log de cada workflow e o resumo da Implantação
  ficam visíveis para qualquer pessoa. Se a versão nova não fica saudável no passo 4, o `implantar.sh` não despeja mais
  `compose ps` nem as 80 últimas linhas do log da API: guarda o log com o `guardar_logs_api` (na volta automática ou,
  sem versão anterior, logo em seguida) e a mensagem de erro aponta o `logs` e o `estado` do script da **release
  nova** (`bash /opt/genesis/releases/<versão>/implantar.sh logs`): o link `/opt/genesis/implantar.sh` só passa para
  a versão nova no `registrar`, depois da troca; até lá é o da anterior (a `757752e` não tem o `logs`) e, na primeira
  instalação, nem existe. O passo 1/4 (proxy do Cloud SQL) também sai com `ERRO` (antes saía calado pelo `set -e`).
  O resumo, no caso de falha, não presume a etapa (pode ter sido o SSH, a trava, o proxy, uma migração ou a saúde):
  remete à mensagem `ERRO` do passo, que diz o que fazer, e cita o script da release nova. O teste
  `testar-implantar-logs.sh` confere que a saída do `implantar` (no ar, com volta automática e na primeira instalação
  que falha) não leva log da API, containers nem memória e que nenhum `compose logs`/`ps` ou `stats` é chamado.
  No fim de uma implantação boa sai só a versão (o `estado_curto`, com containers e memória, continua no `estado` e
  no `voltar`, que se rodam na VPS). O `instalar.sh` não mostra mais as versões do Docker e do Compose, o nome e a
  imagem do container do Traefik nem a instância do Cloud SQL; o workflow só confere o acesso SSH (sem `docker
  version`) e o resumo tem a versão, o resultado da implantação e a página de download. A saída das migrações (código
  das empresas e nome das migrações) continua: não é dado pessoal nem segredo, e é o que diz qual empresa falhou.
- **Marcadores no lugar dos dados da VPS**: `<IP_DA_VPS>` e `<usuario>` neste README; nos blocos de comando, uma
  variável com um IP de documentação (`203.0.113.10`, da faixa reservada para exemplos) a trocar, para o comando não
  rodar pela metade com um `<` que o shell lê como redirecionamento. O Traefik aparece só como "Traefik v3"; o teste
  local fixa a imagem dele para ser reprodutível.

## Decisões técnicas (implantação sem o Actions, D70, 24/11/2026)

- **As imagens são montadas na própria VPS.** Sem o runner, não há onde montar e de onde enviar (`docker save | ssh
  docker load`); a VPS já tem o Docker com o Buildx, e o código vem do repositório público (sem token, sem segredo
  novo, sem registry). Custo: alguns minutos de CPU e disco da VPS a cada implantação; por isso o aviso e a
  recomendação de um horário fora do movimento. A montagem roda sob `nice -n 19` e `ionice -c 3` (o pedido do
  plano), mas o trabalho pesado dos passos `RUN` é feito pelo BuildKit dentro do daemon do Docker, que não herda a
  prioridade do comando: o `nice` vale para o cliente e o envio do contexto. Uma prioridade de verdade pediria um
  construtor separado (`docker buildx create --driver docker-container` com limite de CPU e memória), com a imagem do
  BuildKit baixada na VPS e o cache noutro lugar; fica para se a montagem atrapalhar as lojas. A versão em produção
  continua no ar até a troca, e os limites de memória dos containers do Genesis não mudam.
- **Mesmas conferências do workflow.** Commit com 7 a 40 hexadecimais (o `[0-9a-f]{7,40}` do workflow; o plano dizia
  12 a 40, mas o objetivo era "o formato aceito pelo workflow", e o GitHub mostra os 7 primeiros), ancestral da
  `origin/main` (só o branch `main` é buscado: um commit de outro branch pelo hash curto não é encontrado; pelo
  completo, o clone parcial o busca sob demanda e a ancestralidade recusa), versão em 12 caracteres, os mesmos Dockerfiles, tags e `VERSAO`, os mesmos 5 arquivos na release
  e o mesmo `instalar.sh`/`implantar.sh`. Sem commit, o último da `main` (como o disparo manual sem o campo).
- **A fonte em `/opt/genesis/fonte`, root 700**, um clone parcial só da `main` e sem tags (`--single-branch --no-tags
  --filter=blob:none`: o histórico inteiro da `main` para a ancestralidade, os arquivos só do commit implantado; nenhuma
  tag que um hash curto pudesse casar), sem credencial (`credential.helper` vazio e
  `GIT_TERMINAL_PROMPT=0`: um repositório que deixasse de ser público falharia em vez de pedir senha), com o endereço
  do `origin` reposto a cada execução e o `checkout --force` + `clean -ffdx` antes do build (nada de sobra no
  contexto).
- **Duas travas.** O `implantar.sh` segura a dele (`.implantacao.lock`) só enquanto roda; o build vem antes, então o
  script confere que ela está livre no começo (não segura: o `implantar.sh` a pega na etapa 6) e segura a sua
  (`.implantar-sem-actions.lock`) do começo ao fim, para duas execuções não montarem e trocarem ao mesmo tempo.
- **Fora do terminal.** O terminal da Hostinger é uma aba do navegador; no workflow, o `implantar.sh` rodava por um
  SSH a partir de um runner estável. Fechar a aba, cair a conexão ou o notebook dormir mandaria SIGHUP ao script no
  meio do `implantar.sh implantar` (as migrações ou a troca pela metade, sem a volta automática, sem a versão
  registrada e sem o resumo para o dono saber). Por isso, depois das conferências (que respondem na hora, no
  terminal), o script se roda de novo numa sessão própria (`setsid`: sem terminal, o SIGHUP e o Ctrl+C não chegam),
  com a entrada em `/dev/null`, uma cópia de si mesmo (o comando do README baixa de novo por cima do
  `~/implantar-sem-actions.sh`, e o bash lê o script aos poucos) e a trava herdada; a saída vai para
  `logs/implantar-sem-actions-<data>.log` (pasta 700, arquivo 600, os 10 últimos; o link
  `logs/implantar-sem-actions.log` é o da última) e o terminal só a mostra, saindo com o código dela.
  `--acompanhar` volta a mostrar. Nem `trap '' HUP` sozinho (a escrita no terminal que caiu falharia e o `set -e`
  pararia o script do mesmo jeito), nem `systemd-run` (a saída iria para o journal). O `--simular` roda no terminal.
- **A saída mostrada até a última linha (OP-B6).** O terminal (e o `--acompanhar`) mostrava o log com o
  `tail -f --pid`, que podia sair sem ler o que a implantação escreveu pouco antes de terminar: na CI da `main` de
  25/11/2026, o `--acompanhar` parou na etapa 6, sem o resumo, embora a implantação tivesse terminado (o código de
  saída vinha certo; só a tela ficava cortada, e a mesma saída cortada ia para o `ultima-implantacao.log` do vigia).
  O `tail --pid` também seguia para sempre um processo zumbi (o que terminou e ainda não foi recolhido pelo pai,
  como o órfão num container sem um init que recolha). No lugar dele, o script lê o log por um descritor aberto uma
  vez e, a cada 0,2 s, **confere se o processo vive antes de ler o que falta**; a última leitura é feita com o
  processo já terminado (o zumbi conta como terminado), então tudo o que ele escreveu antes de sair aparece. O
  Ctrl+C continua só parando de mostrar; a saída que não aceita mais escrita (o terminal que caiu) também.
- **Espaço mínimo de 5 GB** (`GENESIS_ESPACO_MINIMO_GB`) no disco do Docker e no do `/opt/genesis`: as 3 imagens
  somam ~700 MB, e o cache do build (dependências do pnpm, as camadas intermediárias) passa de 2 GB na primeira
  montagem; com folga para os logs e o backup. Medido com `df` antes de qualquer coisa.
- **jq sem instalar na VPS.** O `--publicar-pdv` lê a API pública do GitHub (sem token: 60 consultas por hora bastam)
  com o `jq` da imagem `genesis-backup` que acabou de ser montada (`docker run --network none`), mantendo a decisão
  "sem jq na VPS" da página de download. O download do release vai só por `https` (`--proto =https`, também nos
  redirecionamentos). Mesmas regras do workflow: versão mais alta publicada, `.sha256` de uma linha, hash calculado
  do arquivo, falha do GitHub = aviso, lista vazia = `retirar`.
- **URLs públicas pelos domínios do `/opt/genesis/.env`** (o que o Traefik serve; o padrão do workflow se faltar;
  `GENESIS_API_URL`/`GENESIS_ERP_URL`/`GENESIS_DOWNLOAD_URL` como as variáveis do environment), com as mesmas 20
  tentativas de 6 s e as mesmas conferências.
- **Limpeza:** depois de uma implantação boa, o `limpar` do `implantar.sh` já deixa só a atual e a anterior; o script
  cobre a que falhou (ficam as 3 imagens mais recentes de cada nome, `GENESIS_MANTER_IMAGENS`, nunca a atual nem a
  anterior) e o cache do build com mais de uma semana (`docker builder prune --filter until=168h`: o da semana fica,
  para a próxima montagem ser rápida).
- **O script vem da `main`** (raw.githubusercontent.com), não do commit implantado: é o mesmo nível de confiança do
  código que vai para a produção, e um commit antigo é implantado com as regras de hoje. Voltar para a versão
  anterior continua sendo o `implantar.sh voltar` (as imagens dela ficam); um commit anterior ao I1b (sem o
  Dockerfile do backup) é recusado.
- **Só para os testes:** `GENESIS_PASTA`, `GENESIS_REPOSITORIO` (um clone local), `GENESIS_BUILD_OPCOES` (o proxy de
  uma sessão), `GENESIS_CONFERIR_TENTATIVAS`/`GENESIS_CONFERIR_INTERVALO`. O teste de unidade usa dublês de `docker`,
  `curl`, `df`, `id`, `nice` e `ionice` e o `git` de verdade; o ensaio de ponta a ponta é o `testar-local.sh
  --sem-actions`. Decisão 215 do `apps/api/README.md`.

## Decisões técnicas (vigia da implantação, OP-B4, 24/11/2026)

- **A VPS busca, a sessão nunca conecta.** A sessão só sai por HTTPS e não deve ter a chave SSH nem segredo da
  produção (plano OP › Fora do escopo). O pedido é uma tag do repositório público (escrita = as mesmas pessoas que
  juntam na `main`); a VPS lê com `git ls-remote --tags` sem credencial (`credential.helper` vazio,
  `GIT_TERMINAL_PROMPT=0`, limite de 5 min por comando). Nenhum workflow dispara com essas tags (o `ci.yml` só no
  push da `main`; o `pdv-release.yml` só nas `pdv-v*`).
- **Escolha do pedido.** Nome exato `implantar/` ou `implantar-pdv/` + `AAAAMMDD-HHMMSS` (UTC; outro nome não é
  pedido), a data e hora do nome ordena; a tag anotada vale pelo commit dela (`^{}`). Roda só o mais novo não visto;
  os anteriores ficam "pulado" quando ele começa. A lista `vistos` (uma linha por pedido, só acrescentada) é criada
  pelo `instalar-vigia.sh`, que marca as tags existentes como vistas na primeira instalação, depois de um
  `--desligar` (pedido feito com o vigia desligado não roda de surpresa) e sempre que a lista não existia, mesmo com
  o timer ligado (a pasta do vigia apagada ou restaurada sem ela); numa reinstalação com o timer ligado e a lista no
  lugar, os pendentes continuam valendo. Sem a lista, o vigia não implanta nada: senão, toda tag antiga pareceria
  nova (as tags não são apagadas depois de atendidas). Um pedido que esperava a trava (`recebido`) e fica como visto
  na reinstalação passa a `recusado` no `estado.json`, com o fim, para a sessão não esperar para sempre.
- **Volta para antes do OP-B4.** O vigia implanta, mas o `genesis-web` daquele commit não tem a rota nem a
  montagem do `estado.json` (404 depois da troca). Até o OP-B7, o `pedir-implantacao.sh` conferia as duas no commit
  (`git show` do `genesis.conf` e do `docker-compose.yml`) antes de criar a tag e recusava sem `--sem-estado`; desde
  o OP-B7 a sessão não cria tag, e essa volta (só por pedido manual do dono) se confere com `--estado`.
- **Recusa antes de chamar.** O vigia confere o commit num clone parcial próprio (`vigia/repo.git`, bare, só a
  `main`, sem tags e sem os arquivos) e dá "recusado" ao que não descende da `main`, sem chamar o script (que também
  recusaria). Rede fora: a rodada sai com 0 e tenta na seguinte (uma linha no log, não uma a cada 2 minutos).
- **Trava ocupada = próxima rodada.** O vigia confere livres as travas do `implantar-sem-actions.sh` e do
  `implantar.sh` antes de começar, e o `implantar-sem-actions.sh` passou a sair com **75** (EX_TEMPFAIL) quando a
  recusa é pela trava (as outras falhas continuam com 1): se outra implantação pegar a trava no mesmo instante, o
  pedido volta a "recebido", sem virar falha. O vigia tem a própria trava (uma rodada por vez).
- **O `implantar-sem-actions.sh` da `main` de agora**, copiado para `vigia/` antes de cada chamada (só se mudou),
  pela mesma regra da implantação sem o Actions ("um commit antigo é implantado com as regras de hoje"). A chamada é
  a de sempre (fora do terminal, log em `logs/`), com a entrada em `/dev/null` e a saída em
  `vigia/ultima-implantacao.log`.
- **Autoatualização** depois de cada `ok`: o `vigia-implantacao.sh` do commit implantado, só se o sha256 mudou, e
  só se for um script bash válido; gravado por rename (a rodada em andamento continua lendo o arquivo antigo). Numa
  volta a um commit antigo, vale o vigia daquele commit (o que está no ar; a próxima implantação da `main` traz o de
  hoje); commit sem o vigia (anterior ao OP-B4) mantém o atual. Falhar aqui não desfaz a implantação. As unidades do
  systemd só mudam pelo `instalar-vigia.sh`.
- **systemd:** `genesis-vigia.service` `Type=oneshot` com `Nice=10`, `IOSchedulingClass=idle`, `HOME=/root` e
  `TimeoutStartSec=3h`; `KillMode=process`: parar o serviço (ou o limite) encerra o vigia, nunca a implantação que
  ele chamou (o `implantar.sh` pela metade é o pior caso); a rodada seguinte espera ela terminar e dá o pedido como
  "falhou" (interrompida), com a versão no ar no log. `genesis-vigia.timer`: 1 minuto depois de ligado ou do boot e
  2 minutos depois do fim de cada rodada (`OnUnitInactiveSec`), então uma rodada que implanta nunca tem outra por
  cima. Nada escuta porta: só o HTTPS de saída que a VPS já tem.
- **Saída pública:** `download/implantacao/estado.json` (root:101 640, pasta 750, criada pelo `instalar.sh` e pelo
  vigia), montada só leitura no `genesis-web` ao lado do `pdv/` e servida em `/implantacao/estado.json`
  (`application/json`, `no-cache`; qualquer outro nome em `/implantacao` é 404, como no `/pdv`), gravada por arquivo
  novo + rename. Campos fixos, valores validados por expressão antes de escrever (sem jq na VPS). `inicio` = quando o
  vigia recebeu o pedido; `fim` = `null` até o resultado.
- **Testes:** os da seção acima; o `testar-local.sh` confere a rota e as permissões da pasta. Decisão 217 do
  `apps/api/README.md`.

## Decisões técnicas (memória da tarefa, OP-B5, 24/11/2026)

- **O que estourou.** No ensaio do OP-B2, o `empresa-criar` passou dos 128 MB do `genesis-tarefa` ("Memory cgroup
  out of memory"). Medido de novo, comando por comando: a imagem da API montada como em produção, o PostgreSQL 18,
  cada comando sozinho num container com folga (512 MiB) e depois no limite final. O número que importa é o pico do
  cgroup (`memory.peak` no cgroup v2 da VPS, `memory.max_usage_in_bytes` no v1 da sessão: o que o kernel compara com
  o limite, com o cache de arquivos); o anônimo e o heap do V8 foram medidos à parte.

  | Comando | Pico do cgroup | Heap do V8 usado |
  |---|---|---|
  | `migrar-controle` | 92–100 MiB | 60 MB |
  | `particoes` | 92–98 MiB | 60 MB |
  | `admin-criar` | 110–121 MiB | 59 MB (mais os 19 MiB do argon2, fora do heap) |
  | `empresa-criar` | 112–120 MiB | 71–76 MB (o argon2 da senha provisória, as migrações e as referências) |
  | `migrar-empresas`, 1 empresa | 117 MiB | 72 MB |
  | `migrar-empresas` e `referencias`, 4 ou mais empresas (4, 10, 11 e 31) | 124–138 MiB | 81–88 MB |

  O pico para de subir a partir de 4 empresas: o lote padrão (`MIGRACAO_LOTE` = 4) migra 4 bancos em paralelo. Com
  os 128 MB de antes, **o `migrar-empresas` da implantação estouraria assim que houvesse 4 empresas**, e o
  `empresa-criar` passava perto (o OOM do ensaio).
- **O que era da sessão e o que é da aplicação.** A suspeita do plano era o certificado do proxy da sessão nas imagens
  base (`NODE_EXTRA_CA_CERTS` com 123 certificados): a mesma pasta `/app` sobre a base com o certificado e sobre a
  `node` pura dá o mesmo pico (diferença dentro do ruído, ~2 MiB). Os 10 a 15 MiB a mais que apareciam vinham do
  **`HEALTHCHECK` da imagem da API**, que o container de tarefa herdava: o Docker o roda a cada 5 s no período inicial
  (40 s) e a cada 15 s depois, e cada verificação é um `node` a mais (~40 MB de RSS) dentro do mesmo limite, pedindo
  um `/saude` que ninguém serve. Isso vale em produção também. Da aplicação: só carregar o grafo de serviços da API
  (`criarServicos`, com Nest, AWS SDK, exceljs, pg-boss e os schemas do `@genesis/shared`) custa ~85 MiB do cgroup
  (~55 MB de heap) antes de qualquer trabalho; o lote de 4 migrações em paralelo soma ~40 MiB; o argon2, 19 MiB nos
  comandos que geram hash.
- **A escolha: tirar o que era à toa e redistribuir, sem passar do teto.** O `genesis-tarefa` desliga o healthcheck
  (`healthcheck: disable: true`) e fica com **192 MB e heap de 128 MB** (dois terços do container); a **API cede
  64 MB e fica com 1984 MB**, com o heap de 1,5 GB sem mudança (sobram 448 MB fora do heap, eram 512; o pico de heap
  medido na massa de carga de 4 milhões de movimentos foi de 348 MB, decisão 176 do README da API). Soma: 1984 + 128
  + 192 + 64 + 192 = 2560 MiB, o teto da decisão do dono de 03/11/2026, que não muda (por isso sem pergunta nova). No
  limite final, o maior pico medido foi 137 MiB de 192 (71 %), com o heap em 88 de 128 MB.
- **A transição (aceita como transitória).** O `implantar.sh implantar` roda o `migrar-controle` e o `migrar-empresas`
  com o compose da versão **nova** (a tarefa de 192 MB), e a `genesis-api` da versão em produção só é recriada no
  passo 4/4, depois das migrações. Na **primeira implantação com o OP-B5**, a API ainda está com o limite antigo de
  2048 MB enquanto as migrações rodam: por alguns minutos, os limites somados ficam em 2048 + 128 + 192 + 64 + 192 =
  **2624 MiB**, 64 MiB acima do teto da D13. É só limite (não uso: a API usa bem menos que o limite), a VPS tem 8 GB, e
  a partir da troca do passo 4/4 a soma volta a 2560 MiB; a mesma janela se repete na implantação seguinte a um
  `voltar` para uma versão anterior ao OP-B5. Não vale um passo a mais no `implantar.sh` (recriar a API antiga com
  1984 MB antes de migrar seria um reinício a mais da API em produção) por alguns minutos de folga de limite.
- **`voltar` para uma versão anterior ao OP-B5.** O `voltar` sobe a versão anterior com o compose dela, e o
  `implantar.sh tarefa` usa o compose da versão em produção: depois de voltar para uma release anterior ao OP-B5, a
  API volta a 2048 MB e a tarefa a **128 MB, heap de 96 MB e o healthcheck herdado**. Com 4 empresas ou mais, um
  `implantar.sh tarefa migrar-empresas` (ou `referencias`) estoura de novo, e o `empresa-criar` passa perto (o OOM
  do ensaio do OP-B2). Nesse caso, implante de novo uma versão com o OP-B5 antes de rodar esses comandos à mão; a
  migração da implantação seguinte já usa a tarefa nova.
- **Fora, de propósito.** Um grafo de serviços enxuto para os CLIs (cada comando importando só o que usa) tiraria
  ~35 MB de heap e ~50 MiB do pico, mas mexe no grafo que a API e os testes usam; fica para se a tarefa voltar a
  apertar. Baixar o lote das migrações na tarefa cortaria parte dos ~40 MiB, mas alonga a implantação com muitas
  empresas. O `recalcular-saldos` de uma empresa do tamanho da massa de carga (heap de 348 MB) não foi medido na
  tarefa e não caberia no heap dela.
- **Teste.** O `testar-local.sh` confere o healthcheck desligado e mede o pico de cada comando no limite de produção
  com 4 empresas (`migrar-controle`, três `empresa-criar`, `migrar-empresas`, `referencias` e `particoes`); um
  estouro é SIGKILL e falha o teste. O PostgreSQL do override passou de 512 para 1536 MiB: os dados ficam num tmpfs,
  que conta na memória do container, e com as 4 empresas e a cópia do ensaio de restauração os 512 MiB derrubavam o
  PostgreSQL de teste. Ensaio `testar-local.sh --sem-actions` em 24/11/2026: verde (picos de 92 a 134 MiB). Decisão
  216 do `apps/api/README.md`.

## Decisões técnicas (implantação automática da main, OP-B7, 25/11/2026)

- **Por quê.** A rede da sessão recusa escrita no caminho `git/refs` da API do GitHub (criar e juntar PR funcionam):
  a sessão não cria a tag de pedido do OP-B4. O dono decidiu (D119 = A) que o merge que ele libera vale também como
  "pode implantar". O vigia continua só lendo o repositório público.
- **Uma coisa por rodada, nesta prioridade:** o pedido manual por tag (na hora, fora da janela também), a ponta da
  `main` e o PDV. A leitura é um `git ls-remote --heads --tags` (a ponta da `main` sai dele, sem fetch a cada 2
  minutos); o `fetch` do clone parcial só roda quando há o que implantar (a ancestralidade e a cópia do
  `implantar-sem-actions.sh` da `main`).
- **Uma vez por commit.** `vigia/main-tratados` (só acrescentada, uma linha por commit: o commit, o resultado e
  quando) guarda cada ponta tratada: `ok`, `falhou`, `recusado` (a `main` reescrita entre o `ls-remote` e o `fetch`),
  `ja-no-ar` e `no-ar-na-instalacao` (a ponta já era a versão no ar) e o commit de um pedido manual. A ponta que já é a
  versão no ar (`versoes/atual`) fica tratada sem implantar: cobre a instalação, a autoatualização do vigia (o vigia
  novo não tem a lista e não implanta de novo o que acabou de subir) e a implantação feita pelo dono no terminal (se
  o `estado.json` mostrava o `recebido` dela, ele termina como `ok`, e o acompanhamento da sessão não fica sem
  resultado). Só a
  ponta conta: um merge que nunca foi a ponta numa rodada (dois merges seguidos) entra junto com o seguinte.
- **A volta do dono fica.** O `implantar.sh voltar` muda o `versoes/atual` para a anterior, mas a ponta já está na
  lista: o vigia não a implanta de novo. A falha também não repete sozinha (o próximo merge ou um pedido manual).
- **Janela no horário de Brasília**, `TZ=America/Sao_Paulo` (sem o tzdata, `<-03>3`: o Brasil não tem horário de
  verão desde 2019), em horas cheias. O arquivo `vigia/janela` (root 600) tem `17-24` (o padrão da D119) ou outra
  janela no mesmo formato, inclusive passando pela meia-noite, ou `nenhuma`; fora do formato vale o padrão, com uma
  linha no log (mais seguro implantar fora do pico que parar de implantar). Na janela, o `estado.json` mostra
  `recebido` e o log, uma vez, a hora prevista. A publicação só do PDV também espera a janela (nada automático no
  horário das lojas, mesmo sem reiniciar nada); o pedido manual não.
- **PDV pela tag `pdv-vX.Y.Z`.** O `ls-remote` já traz as tags: a de versão mais alta (`sort -V`) e o commit dela são
  a chave (`vigia/pdv-tratados`); quando a chave muda, o `implantar-sem-actions.sh --so-pdv` faz as conferências do
  `--publicar-pdv` (o release publicado mais novo, o sha256 do `.sha256` e do arquivo baixado, o que a página já
  serve). Assim a API do GitHub (60 consultas por hora sem token) só é lida quando há tag nova, não a cada 2 minutos.
  Uma tag por vez, passada ao `--so-pdv` (`--tag=<tag>`): sem ela, a tag que nasce antes do release (o
  `publicar-release.sh` e o workflow) achava o release anterior, que a página já servia, e ficava tratada como "nada
  a publicar" para sempre. Os códigos: `0` = tratada (publicada ou nada a publicar), `65` = arquivo inválido (tratada
  como `falhou`, não repete: o único definitivo), `69` = o GitHub sem responder, o release incompleto ou o da tag
  ainda não publicado, e qualquer outro (o `1`: o Docker, o espaço, a imagem, a página que não respondeu) = tenta de
  novo 15 minutos depois (só para a mesma tag), sem marcar a tag nem escrever no `estado.json`; `75` = trava (a
  próxima rodada). O `--so-pdv` não pede os 5 GB do build, só 1 GB para o instalador. A espera guarda o sha256 que a
  página servia e o inicio da primeira tentativa: a publicação que trocou a página e falhou na conferência da URL
  sai `ok` na tentativa seguinte, e o `inicio` do `estado.json` é o desta tag (o `pdv` com a mesma versão no ar
  casava com a publicação de outro dia).
- **O `--so-pdv` nunca retira o instalador** (sem release publicado, a página fica): retirar sozinho por um rascunho ou
  um pre-release seria pior que deixar o que está. Ele usa a versão no ar (a release dela para o `implantar.sh pdv
  publicar` e a imagem do backup para o `jq`) e confere pela URL só a página de download.
- **`estado.json` do PDV só quando muda algo.** `pedido` = `pdv` e `commit` = a versão no ar, escrito quando a página
  passou a servir outro sha256 (`ok`) ou o release tem arquivo inválido (`falhou`); o "nada a publicar" (o caso de
  toda instalação) e as esperas não apagam o resultado da última implantação. A sessão lê um `pdv` de um commit que inclui o dela como "está no ar".
- **A sessão só acompanha.** `scripts/acompanhar-implantacao.sh` confere a `origin/main`, avisa a janela (a padrão;
  a da VPS só o dono vê) e espera o `estado.json` de um commit que inclui o dela (o vigia implanta a ponta); o
  `pedir-implantacao.sh` ficou como aviso. Nenhum dos dois chama o `gh`.
- **Interrompida.** A implantação automática interrompida (a VPS reiniciou) fica `falhou` e tratada, como o pedido
  manual; a publicação só do PDV interrompida tenta de novo (troca só arquivos da página, por rename).
- **Testes:** `testar-vigia-implantacao.sh` (os cenários do OP-B4 com a versão no ar igual à ponta e, à parte, os do
  OP-B7: a ponta implantada uma vez, a falha que não repete, a volta do dono, 16:59/17:00/23:59/00:00, a janela 22-6 e
  fora do formato, a instalação com a versão no ar igual e diferente, o PDV publicado sozinho, o nada a publicar, a
  tag antes do release publicado, a falha passageira, o inválido, a tag manual com prioridade e dentro da janela, a
  `main` antes do PDV, a interrompida e a ponta implantada pelo terminal), o
  `--so-pdv` no `testar-implantar-sem-actions.sh` e o `scripts/testar-acompanhar-implantacao.sh`. Decisão 218 do
  `apps/api/README.md`. Nada roda na produção até o dono reinstalar o vigia.

## Decisões técnicas (o vigia se atualiza por inteiro, OP-B9, 25/11/2026)

- **Por quê.** A sessão não tem SSH (D121): a rede dela fecha a porta 22 e não há onde guardar a chave com segurança.
  Até o OP-B8, depois de um `ok` o vigia só trocava o próprio `vigia-implantacao.sh`; a unidade, o timer e o resto
  do que o `instalar-vigia.sh` prepara só mudavam quando o dono reinstalava. Agora a reinstalação depois do PR-16b é a
  última feita à mão.
- **A cópia do instalador em `/opt/genesis/vigia`.** A `~/instalar-vigia.sh` é a que o comando de instalar baixou e
  nada a atualiza; por isso a instalação (à mão e a autoatualização) deixa uma cópia do `instalar-vigia.sh` em
  `/opt/genesis/vigia` (700), sempre a da instalação aplicada, e o README e o CLAUDE.md mandam usar essa no
  `--estado` e no `--desligar`.
- **Quem instala é o instalador do commit implantado.** Depois do `ok`, o vigia lê do clone parcial o
  `instalar-vigia.sh` daquele commit e o roda com `--autoatualizar <commit>` (fora do terminal, `timeout` de 15
  minutos). O instalador do próprio commit sabe o que aquela versão precisa (uma etapa nova da instalação vem com
  ela). A linha `# genesis-vigia-autoatualizar: 1` diz ao vigia que ele aceita o `--autoatualizar`; sem ela (um
  commit anterior ao OP-B9: uma volta do dono), o vigia faz como antes, só o programa do vigia, e não desfaz a
  instalação. A trava do vigia passa ao instalador pelo descritor 9 (`GENESIS_VIGIA_TRAVA=herdada`): nenhuma rodada
  começa no meio da troca. A cópia do `implantar-sem-actions.sh` vem da `main` (a mesma regra do vigia: o script de
  implantar é o da `main`, não o do commit).
- **Tudo conferido antes de trocar qualquer coisa.** Os cinco arquivos são lidos primeiro (os scripts com o
  `#!/usr/bin/env bash` e o `bash -n`); a unidade e o timer passam pelo formato esperado (o serviço `oneshot` que roda
  `/opt/genesis/vigia/vigia-implantacao.sh` com `KillMode=process`; o timer `Unit=genesis-vigia.service`, com
  `OnUnitInactiveSec=` e `WantedBy=timers.target`: os mesmos nomes, nunca um segundo timer) e pelo
  `systemd-analyze verify`, que recusa com erro **ou aviso** sobre eles (ele sai com 0 numa chave desconhecida ou num
  valor que não entende: o systemd ignoraria a linha). A instalação à mão passou a fazer a mesma conferência.
- **Só o que mudou (sha256), por rename, unidades primeiro.** Antes da primeira troca, ao lado de cada destino ficam
  prontas a cópia nova e uma ligação (hard link) com o arquivo de antes: a troca e a volta são só renames, que não
  pedem espaço em disco (o disco que enche no meio não deixa a instalação pela metade). As novas unidades entram por
  rename, o `daemon-reload` roda, o timer que mudou leva um `try-restart` (que só mexe no timer ligado: o desligado
  pelo dono continua desligado; nunca `enable` nem `start`) e o timer que estava ligado tem de continuar ligado; se
  ele parou e não está mais habilitado, o dono o desligou no meio (o `--desligar` não espera a trava): não é falha e
  ele continua desligado. Depois, os scripts por rename: a rodada em andamento continua lendo o arquivo antigo (o
  bash lê o script aos poucos). Qualquer falha, nas unidades ou nos scripts, põe todos os arquivos de antes de volta
  (rename, `daemon-reload` e o timer religado só se tinha caído e continua habilitado): fica tudo como estava
  (`falhou`, código 1). Se nem a volta se completa (70), o registro fica `pendente` e a rodada seguinte refaz a
  instalação inteira. O que falta das etapas 5 e 6 (a janela com o
  padrão, as listas dos tratados, a pasta pública) é criado; o que existe não muda; a etapa 4 (os pedidos antigos por
  vistos) não roda.
- **O resultado fica em `vigia/instalacao`** (root 600: o commit, `ok`/`recusado`/`falhou`/`pendente`/
  `sem-autoatualizar`/`sem-commit`/`instalacao`, quando e o sha256 do vigia instalado depois) e o motivo só no
  `vigia.log`; nada vai ao `estado.json`. `recusado` e `falhou` não repetem (a próxima implantação `ok` tenta a dela);
  `pendente` (o arquivo não veio do repositório público, a rede, ou a volta que não se completou) tenta de novo a
  cada rodada, com uma linha no log, refeita como depois do `ok` que a deixou (numa volta a um commit anterior ao
  OP-B9, troca o programa, como a volta teria feito); `sem-commit` (a versão no ar não está na `main` do clone, mesmo
  depois de buscá-la: um commit implantado pelo terminal fora dela) deixa a instalação atual, sem nova tentativa até
  a próxima implantação `ok`.
- **A transição sem comando do dono.** O vigia do OP-B7 instalado, ao implantar o primeiro commit com o OP-B9, troca
  só o programa (a regra dele). No começo de cada rodada, o vigia novo confere a instalação: se o `vigia/instalacao`
  não existe ou o sha256 dele não é o do vigia instalado (outro vigia o trocou), aplica a instalação do commit no ar
  (o `versoes/atual`, resolvido no clone e conferido na `main`). Uma volta do dono pelo terminal (`implantar.sh
  voltar`) não troca o vigia, então não dispara nada; e o vigia novo nunca se troca sozinho, nessa conferência, por um
  de um commit anterior ao OP-B9 (`sem-autoatualizar`). Sem o `instalar-vigia.sh` do commit (a rede), a conferência
  não grava nada (não se sabe se o commit tem o `--autoatualizar`): a rodada seguinte decide de novo, com uma linha
  no log só.
- **Testes:** `testar-vigia-implantacao.sh` (a unidade e o timer que mudam, trocados e recarregados; só o service
  mudado, sem o `try-restart` do timer; os iguais, sem nada regravado; o timer fora do formato e a unidade com aviso
  do `systemd-analyze`, recusados, ficando as antigas, também na instalação à mão; o `daemon-reload` e o
  `try-restart` que falham e o timer que não fica ligado, desfeitos; o rename de um script que falha depois das
  unidades (o disco cheio), desfeito por inteiro, e a volta que também falha, `pendente` e refeita; o vigia desligado
  que continua desligado, também com o `--desligar` no meio da troca; a volta a um commit sem o `--autoatualizar`, o
  merge seguinte pelo vigia antigo e a rodada que compara o sha256 do registro; o arquivo que não veio, também numa
  volta a um commit anterior ao OP-B9; a conferência com o commit no ar anterior ao OP-B9 (`sem-autoatualizar`, sem
  trocar o vigia) e com a versão no ar fora da `main` (`sem-commit`); a cópia do `instalar-vigia.sh` em
  `/opt/genesis/vigia`; a transição com o vigia do OP-B7 de verdade, o do `e539ed0`, quando o histórico o tem; nada
  no `estado.json`). Decisão
  219 do `apps/api/README.md`. Vale na VPS a partir da primeira implantação de um commit com o OP-B9 pelo vigia.

## Pendências

- **Cópia do backup fora do Google** (outro provedor ou outra conta): hoje o dump fica no mesmo projeto do banco.
- Teste **mensal automatizado** de restauração em produção (hoje: o ensaio manual do Passo 7 e o roteiro completo no
  teste local) e o registro por empresa em `backups_empresas` para o painel da plataforma (ERP 19.3, 19.10).
- Instalador do PDV **assinado** (certificado de assinatura de código, decisão 62 do README do PDV): enquanto não
  houver, a página de download explica o aviso do SmartScreen.
- SMTP real (e-mail da Hostinger): sem ele, os e-mails (ex.: “esqueci a senha”) falham na fila e o resto funciona.
- `Content-Security-Policy` do ERP: fica para depois de conferida com o ERP de verdade no navegador (Mantine usa
  estilos inline; a URL assinada do armazenamento é de outro domínio; a miniatura do `<UploadArquivo>` é uma imagem
  `data:`, então `img-src 'self' data:`, README do ERP › decisão 77).
- Converter a instância de teste grátis do Cloud SQL em paga antes do fim do período de teste (~03/12/2026) e, nela,
  ligar backups automáticos e PITR (aí o dump do I1b vira a segunda cópia, fora do Cloud SQL).
- Apagar os arquivos com `retencao_ate` vencida (exportações, 7 dias; relatório da importação, 30): hoje ninguém os
  apaga. O sistema já não os oferece (o `GET /tarefas` não assina link além da retenção e mostra o arquivo como
  expirado), mas o objeto continua no bucket, ocupando espaço. (A regra `AbortIncompleteMultipartUpload` do bucket já
  foi aplicada em 10/11/2026: [Backup](#backup-i1b).)
- Configurar o Hermes com as regras de [Monitoramento](#monitoramento-hermes-i1b) (fora deste repositório) e, se
  quiser um segundo olhar independente, um monitor externo simples do `/saude` (VG 13).
