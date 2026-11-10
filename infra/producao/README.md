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
| `genesis-api` | `genesis-api:<versão>` (apps/api/Dockerfile) | 2 GB (heap do Node 1,5 GB) | Usuário `node`, sistema de arquivos só leitura, healthcheck em `/saude` |
| `genesis-web` | `genesis-web:<versão>` (apps/erp-web/Dockerfile) | 128 MB | nginx sem root (uid 101), ERP estático e a página de download (o instalador do PDV vem de uma pasta do host, só leitura) |
| `genesis-cloudsql-proxy` | `gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.21.0-alpine` | 192 MB | Usuário nonroot (65532), healthcheck em `/readiness` |
| `genesis-backup` | `genesis-backup:<versão>` (backup/Dockerfile) | 64 MB | Usuário `postgres` (70), clientes do PostgreSQL 18; `pg_dump` diário às 04:30 para o bucket |
| `genesis-tarefa` | a mesma da API | 128 MB (heap do Node 96 MB), só enquanto roda | Migrações na implantação e comandos (`admin-criar`, `empresa-criar`...) |

Soma dos limites: **2,5 GB** (decisão do dono, 03/11/2026: limite somado dos containers), contando a tarefa — ela
roda com a API no ar (na implantação, a versão anterior continua no ar durante as migrações): 2048 + 128 + 192 + 64 +
128 = 2560 MiB. No I1 o proxy tinha 256 MB; no I1b ele cedeu 64 MB ao backup (o pico medido do proxy é de dezenas de
MB; [Decisões técnicas (I1b)](#decisões-técnicas-i1b)). Sem swap além do limite: se um container estourar, ele
reinicia (`restart: unless-stopped`; a tarefa só falha) em vez de deixar a VPS lenta. Nenhuma porta é publicada no host
e nada do projeto `icebeer` é tocado; o Genesis só entra na rede `proxy` e se anuncia ao Traefik por labels.

## Arquivos desta pasta

| Arquivo | Para quê |
|---|---|
| `docker-compose.yml` | Projeto Compose `genesis` (os cinco serviços acima, labels do Traefik, limites, logs com rotação) |
| `compose.env.exemplo` | Modelo do `/opt/genesis/.env`: domínios, rede do Traefik, instância do Cloud SQL, versão em produção |
| `genesis.env.exemplo` | Modelo do `/opt/genesis/genesis.env`: configuração **não secreta** da API (AMBIENTE, TRUST_PROXY, CORS...) |
| `instalar.sh` | Preparação da VPS, idempotente: confere pré-requisitos, gera os segredos da aplicação, acerta permissões |
| `implantar.sh` | `implantar <versão>`, `voltar`, `estado`, `tarefa <comando>`, `backup <...>`, `token-monitor`, `pdv <atual\|publicar\|retirar>`, `logs [guardar]` |
| `backup/` | Imagem do `genesis-backup` (`Dockerfile`), o script `genesis-backup.sh` (agendar, agora, estado, listar, restaurar) e os testes de unidade dele (`testar-genesis-backup.sh`, sem Docker; rodam no CI) |
| `teste/` | Teste local da stack (override com PostgreSQL 18, Traefik e S3 locais, `testar-local.sh`) e os testes de unidade dos logs guardados pelo `implantar.sh` (`testar-implantar-logs.sh`, sem Docker; rodam no CI) |

Na VPS fica assim (o workflow cria tudo, menos os segredos do Google):

```
/opt/genesis/
  .env                     # interpolação do Compose (compose.env.exemplo)
  genesis.env              # configuração não secreta da API (genesis.env.exemplo)
  docker-compose.yml  ->   releases/<versão atual>/docker-compose.yml
  implantar.sh        ->   releases/<versão atual>/implantar.sh
  releases/<versão>/       # arquivos desta pasta, um por versão (guarda as 5 últimas)
  versoes/atual, anterior, historico
  logs/                    # root 700: api-<AAAAMMDDTHHMMSSZ>-<versão>.log (600), o log da API guardado antes de
                           # cada troca do container: o trecho em volta do último reinício pelo Docker (se houve)
                           # e as últimas 5.000 linhas (20 arquivos no máximo, até 30 dias)
  download/                # root 755 (instalar.sh)
    pdv/                     # instalador do PDV da página de download, root:101 750, arquivos 640; montada só
                             # leitura no genesis-web (/srv/download/pdv): atual.json, GenesisPDV-Setup-X.Y.Z.exe
                             # e o .sha256 (o atual e o anterior)
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
| Comandos da API | `/opt/genesis/implantar.sh tarefa <comando> [--argumentos]` (`admin-criar`, `empresa-criar`, `empresa-provisionamento`, `migrar-controle`, `migrar-empresas`, `particoes`, `referencias`) |
| Uso de memória | `docker stats --no-stream genesis-api genesis-web genesis-cloudsql-proxy genesis-backup` |
| Backup: último, dias guardados, um backup agora | `/opt/genesis/implantar.sh backup estado` / `backup listar` / `backup agora` |
| Logs do backup | `docker logs genesis-backup --tail 100` (uma linha por banco; `FALHOU` quando algo deu errado) |
| Restaurar (um banco ao lado, ou tudo num servidor vazio) | [Backup › Restaurar](#restaurar) |
| Gerar ou trocar o token do monitoramento | `/opt/genesis/implantar.sh token-monitor` (o anterior para de valer na hora) |
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
5. **O kernel**, para o SIGKILL do OOM (o container passou dos 2 GB). O `docker inspect` não guarda o motivo de um
   reinício feito pelo `restart: unless-stopped`: ao subir de novo, o Docker zera `State.ExitCode` e
   `State.OOMKilled`; o que fica é o `RestartCount` (e o `StartedAt`). O `journalctl` lê `--since` no fuso da VPS,
   então ponha `UTC` no horário:

```bash
docker inspect genesis-api --format '{{.State.StartedAt}} reinícios={{.RestartCount}}'   # reinícios > 0: o container caiu e voltou
journalctl -k --since '2026-11-04 17:50 UTC' --until '2026-11-04 18:10 UTC' | grep -i -E 'oom|killed process'   # OOM do kernel/cgroup (mem_limit 2g)
journalctl -u docker -u containerd --since '2026-11-04 17:50 UTC' --until '2026-11-04 18:10 UTC' | grep -i -E 'oom|exit|die|restart'   # saída do container, com o código
docker logs genesis-api --since '2026-11-04T17:50:00Z' --until '2026-11-04T18:06:00Z' 2>&1 | tail -n 100
```

Linha `oom-kill`/`Killed process … (node)` no `journalctl -k` (saída 137, SIGKILL) = o container passou dos 2 GB;
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
já aplicadas continuam, pelo mesmo motivo. Uma falha de migração de empresa deixa só aquela empresa em manutenção (503) e a versão anterior no ar; o
`implantar.sh` para antes de trocar a API.

**Implantar sem o GitHub** (emergência, de um computador com Docker e o repositório):

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
  "memoria": { "usada_bytes": 412090368, "limite_bytes": 2147483648 },
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
| `memoria.usada_bytes` / `limite_bytes` | Memória do container da API (como no `docker stats`) e o limite (2 GiB) |
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
  (a migração cria, como em produção);
- um **Traefik v3** local (imagem com a versão fixada no override) na porta `127.0.0.1:18443`, lendo os mesmos labels;
- um **S3 local** (RustFS, o mesmo do desenvolvimento) no lugar do bucket do GCS, com a mesma assinatura (I1b).

E passa pelos scripts da VPS numa pasta temporária: `instalar.sh` duas vezes (a segunda não troca nenhum segredo;
permissões 700/600/640), `docker compose config`, `implantar.sh implantar` (migrações no container de tarefa,
`up --wait`), `admin-criar` e `empresa-criar` no container de tarefa, `migrar-empresas` de novo, e confere pelo
Traefik com os domínios de produção: `/saude` nos domínios da API e do ERP, o ERP (rotas do SPA caem no
`index.html`, HSTS), a página de download (CSP, `/pdv/atual.json` 404 sem instalador; `implantar.sh pdv publicar`
com instaladores de mentira: download inteiro com `attachment`, `.sha256`, recusa de sha256 errado sem tocar na página
nem deixar temporário, e a retenção da atual e da anterior), `/sync/*` só no domínio da API, o login no ERP pela origem do ERP com o cookie
`Secure` + `SameSite=Strict`, os limites de memória (a soma do compose de produção com a tarefa ≤ 2560 MiB e o
pico do `referencias` no limite de 128 MiB), os usuários sem root, uma segunda versão seguida de `voltar` e o bloco
do Cloud Shell colado de novo (o `estado` avisa da chave `root:root 600`; o `instalar.sh` devolve `root:65532 640`).
Do I1b: o `genesis-backup` healthy e sem root; `backup agora`/`listar`/`estado` com os dois bancos no bucket e o pico
de memória dentro dos 64 MiB; o `token-monitor` (recusa sem terminal, grava só o hash, a troca invalida o anterior) e
o `/api/saude/detalhada` (401 sem token, 200 nos dois domínios com o último backup e a memória de 2 GiB do
container); o **ensaio de desastre** (API parada, backup, o PostgreSQL trocado por um vazio, `restaurar todos`,
contagens de linhas de todas as tabelas e a colação iguais às de antes, `--como` ao lado, recusa por cima,
`migrar-empresas` e o login no ERP); e o pico do Cloud SQL Auth Proxy de verdade com 192 MiB (sem o Google: só a
subida e conexões recusadas). No fim remove containers, redes, volumes, imagens de teste e a pasta.

Roda **como root** (`sudo`), como na VPS: o `instalar.sh` exige root e põe a chave da conta de serviço no grupo
65532 (`chown`). Estar no grupo `docker` não basta; o script recusa logo no começo, antes do build.

```bash
sudo infra/producao/teste/testar-local.sh            # builda as imagens genesis-*:teste-local
sudo infra/producao/teste/testar-local.sh --manter   # deixa a stack no ar para olhar
```

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
- **Tarefa com 128 MB, dentro do teto de 2,5 GB**: ela roda com a API no ar, então conta no limite somado da
  decisão do dono e ocupa a folga de 128 MB (heap do Node 96 MB). Pico medido no teste local: 82 MiB no
  `referencias` (migra todas as empresas, recarrega as referências nacionais e o seed; inclui o cache de arquivos).
  Com mais empresas o pico pode subir; um estouro derruba só a tarefa (a implantação para antes da troca e a versão
  anterior continua) e aí o limite volta a ser conversa com o dono. O `genesis-backup` do I1b (64 MB) coube tirando
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

## Pendências

- **Cópia do backup fora do Google** (outro provedor ou outra conta): hoje o dump fica no mesmo projeto do banco.
- Teste **mensal automatizado** de restauração em produção (hoje: o ensaio manual do Passo 7 e o roteiro completo no
  teste local) e o registro por empresa em `backups_empresas` para o painel da plataforma (ERP 19.3, 19.10).
- Instalador do PDV **assinado** (certificado de assinatura de código, decisão 62 do README do PDV): enquanto não
  houver, a página de download explica o aviso do SmartScreen.
- SMTP real (e-mail da Hostinger): sem ele, os e-mails (ex.: “esqueci a senha”) falham na fila e o resto funciona.
- `Content-Security-Policy` do ERP: fica para depois de conferida com o ERP de verdade no navegador (Mantine usa
  estilos inline; a URL assinada do armazenamento é de outro domínio).
- Converter a instância de teste grátis do Cloud SQL em paga antes do fim do período de teste (~03/12/2026) e, nela,
  ligar backups automáticos e PITR (aí o dump do I1b vira a segunda cópia, fora do Cloud SQL).
- Apagar os arquivos com `retencao_ate` vencida (exportações, 7 dias; relatório da importação, 30): hoje ninguém os
  apaga. O sistema já não os oferece (o `GET /tarefas` não assina link além da retenção e mostra o arquivo como
  expirado), mas o objeto continua no bucket, ocupando espaço. (A regra `AbortIncompleteMultipartUpload` do bucket já
  foi aplicada em 10/11/2026: [Backup](#backup-i1b).)
- Configurar o Hermes com as regras de [Monitoramento](#monitoramento-hermes-i1b) (fora deste repositório) e, se
  quiser um segundo olhar independente, um monitor externo simples do `/saude` (VG 13).
