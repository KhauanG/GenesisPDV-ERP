#!/usr/bin/env bash
# Genesis: implantação pela própria VPS, sem o GitHub Actions (D70-Q1, OP-B2; README desta pasta › Implantar sem o
# GitHub Actions). Faz na VPS o que o workflow Implantação (.github/workflows/implantacao.yml) faz no runner, com as
# mesmas conferências: baixa o commit da main do repositório público, monta as 3 imagens aqui mesmo (no lugar do
# `docker save | ssh docker load`), copia os arquivos da versão e roda os mesmos instalar.sh e implantar.sh.
#
#   bash implantar-sem-actions.sh [--simular] [--publicar-pdv] [--sem-conferir-url] [<commit da main>]
#   bash implantar-sem-actions.sh --acompanhar
#     <commit>            hash da main, curto (7 a 40 hexadecimais, como no workflow; os 12 de versoes/historico)
#                         ou completo; sem commit, o último da main
#     --simular           confere tudo (root, espaço, travas, commit na main) e mostra o que faria, sem montar
#                         imagem nem trocar nada
#     --publicar-pdv      publica na página de download o instalador do último GitHub Release pdv-vX.Y.Z (o campo
#                         publicar_pdv do workflow)
#     --sem-conferir-url  não confere a API, o ERP e a página pelas URLs públicas no fim
#     --acompanhar        volta a mostrar a implantação em andamento (até o fim) ou, sem nenhuma, a saída da última
#
# Fora do terminal: depois das conferências, o script se roda de novo numa sessão própria (setsid, sem terminal e sem
# entrada), com a saída em $PASTA/logs/implantar-sem-actions-<data>.log, e o terminal só a acompanha, até a última
# linha (mostrar_ate_o_fim). Fechar a aba do navegador, perder a conexão, o notebook dormir ou o Ctrl+C param de
# mostrar, não a implantação: o SIGHUP do terminal que cai não chega às migrações nem à troca de versão (o
# `implantar.sh implantar` pela metade, sem a volta automática nem a versão registrada). O `--simular` roda no
# próprio terminal (não muda nada).
#
# Etapas, na ordem do workflow:
#   1. commit: formato, fonte em /opt/genesis/fonte (clone do repositório público, root 700, sem token) e ancestral
#      da origin/main;
#   2. versão = o commit em 12 caracteres (a tag das imagens e o nome da release, como no workflow);
#   3. imagens genesis-api, genesis-web e genesis-backup :<versão>, com os mesmos Dockerfiles, sob nice/ionice;
#   4. arquivos da versão em /opt/genesis/releases/<versão>;
#   5. (--publicar-pdv) o instalador do último GitHub Release, baixado e conferido antes da troca de versão;
#   6. instalar.sh e implantar.sh implantar <versão> (proxy do Cloud SQL, migrações, troca, saúde, volta automática);
#   7. (--publicar-pdv) implantar.sh pdv publicar (ou pdv retirar, sem release publicado);
#   8. conferência pelas URLs públicas; depois, a limpeza das imagens antigas e o resumo.
# Recusa sem root, com o commit fora da main, com menos de GENESIS_ESPACO_MINIMO_GB livres no disco do Docker ou do
# /opt/genesis e com outra implantação em andamento (a trava do implantar.sh ou outra execução deste script). A
# recusa pela trava sai com o código 75 (EX_TEMPFAIL: "tente de novo depois"), e as outras falhas com 1: o vigia da
# implantação (vigia/vigia-implantacao.sh, OP-B4) deixa o pedido para a próxima rodada em vez de dá-lo por falho.
#
# Variáveis: GENESIS_PASTA (padrão /opt/genesis), GENESIS_ESPACO_MINIMO_GB (padrão 5), GENESIS_MANTER_IMAGENS (padrão
# 3), GENESIS_API_URL, GENESIS_ERP_URL e GENESIS_DOWNLOAD_URL (padrão: https:// e os domínios do /opt/genesis/.env).
# Só para os testes: GENESIS_REPOSITORIO (o ensaio local usa um clone local), GENESIS_BUILD_OPCOES (opções extras do
# `docker build`, ex.: o proxy de uma sessão), GENESIS_CONFERIR_TENTATIVAS e GENESIS_CONFERIR_INTERVALO. As do
# implantar.sh (GENESIS_COMPOSE_EXTRA, GENESIS_ESPERA_SEGUNDOS) passam direto para ele.
set -euo pipefail
umask 022

REPOSITORIO_PUBLICO=KhauanG/GenesisPDV-ERP
REPOSITORIO=${GENESIS_REPOSITORIO:-https://github.com/$REPOSITORIO_PUBLICO}
API_GITHUB=https://api.github.com/repos/$REPOSITORIO_PUBLICO
DOWNLOAD_GITHUB=https://github.com/$REPOSITORIO_PUBLICO/releases/download
PASTA=${GENESIS_PASTA:-/opt/genesis}
FONTE=$PASTA/fonte
ESPACO_MINIMO_GB=${GENESIS_ESPACO_MINIMO_GB:-5}
MANTER_IMAGENS=${GENESIS_MANTER_IMAGENS:-3}
TENTATIVAS=${GENESIS_CONFERIR_TENTATIVAS:-20}
INTERVALO=${GENESIS_CONFERIR_INTERVALO:-6}
# O que o workflow envia para releases/<versão> (o passo "Envio dos arquivos da versão").
ARQUIVOS_DA_VERSAO=(docker-compose.yml implantar.sh instalar.sh compose.env.exemplo genesis.env.exemplo)
# Saída da execução fora do terminal (desacoplar): um arquivo por execução, o link para a última e o processo dela.
LOGS=$PASTA/logs
LOG_ULTIMO=$LOGS/implantar-sem-actions.log
LOGS_MANTER=10
PID_ARQUIVO=$PASTA/.implantar-sem-actions.pid
TRAVA=$PASTA/.implantar-sem-actions.lock

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32mOK:\033[0m %s\n' "$*"; }
aviso() { printf '\033[1;33mATENÇÃO: %s\033[0m\n' "$*" >&2; }
erro() {
  printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2
  exit 1
}
# A trava de outra implantação: "tente de novo depois" (o comentário do começo).
ocupado() {
  printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2
  exit 75
}
simulado() { printf '\033[1;36m[simulação]\033[0m faria: %s\n' "$*"; }
uso() { sed -n '7,16p' "$0" | sed 's/^# \{0,1\}//'; }

COMMIT=''
SIMULAR=0
PUBLICAR_PDV=0
CONFERIR_URL=1
ACOMPANHAR=0
for arg in "$@"; do
  case "$arg" in
    --simular) SIMULAR=1 ;;
    --publicar-pdv) PUBLICAR_PDV=1 ;;
    --sem-conferir-url) CONFERIR_URL=0 ;;
    --acompanhar) ACOMPANHAR=1 ;;
    -h | --ajuda)
      uso
      exit 0
      ;;
    -*)
      uso >&2
      erro "opção desconhecida: '$arg'."
      ;;
    *)
      [ -z "$COMMIT" ] || erro "informe um commit só (veio '$COMMIT' e '$arg')."
      COMMIT=$arg
      ;;
  esac
done
for n in "$ESPACO_MINIMO_GB" "$MANTER_IMAGENS" "$TENTATIVAS" "$INTERVALO"; do
  [[ $n =~ ^[0-9]+$ ]] || erro "valor numérico inválido numa variável GENESIS_*: '$n'."
done
[ "$MANTER_IMAGENS" -ge 2 ] || erro "GENESIS_MANTER_IMAGENS tem de ser 2 ou mais (a atual e a anterior)."
[ "$ACOMPANHAR" = 0 ] || [ "$#" = 1 ] || erro "--acompanhar vai sozinho (sem commit nem outra opção)."

# Estado da execução, para o resumo (o "Resumo" do workflow).
VERSAO=''
SHA=''
TEMP=''
INICIO=$SECONDS
IMPLANTACAO='' # '' = não chegou na troca; sucesso; falha
PDV_ACAO=''    # '' = não mexe; publicar; retirar; ja (já publicado)
PDV_VERSAO=''
PDV_PUBLICADO=''
PDV_EXE=''
if [ "$PUBLICAR_PDV" = 1 ]; then
  PAGINA="não mexida: a implantação parou antes do passo do instalador do PDV"
else
  PAGINA="não mexida (sem --publicar-pdv)"
fi

# --- Conferências antes de qualquer coisa -------------------------------------------------------------------------

# GiB livres no sistema de arquivos de $1 (ou da pasta mais próxima que exista: o /opt/genesis na primeira vez).
livre_gb() {
  local d=$1
  while [ ! -e "$d" ]; do d=$(dirname "$d"); done
  df -Pk -- "$d" | awk 'NR == 2 { print int($4 / 1048576) }'
}

# A trava do implantar.sh (flock em $PASTA/.implantacao.lock) está livre agora: abre, tenta e solta (o subshell
# fecha o descritor). Este script não a segura: o implantar.sh, chamado na etapa 6, a pega ele mesmo.
trava_do_implantar_livre() { (exec 7>"$PASTA/.implantacao.lock" && flock -n 7); }

conferir_requisitos() {
  [ "$(id -u)" = 0 ] ||
    erro "rode como root (o terminal da VPS na Hostinger já entra como root; senão, sudo -i antes): o instalar.sh e o implantar.sh mexem em $PASTA e nos segredos."
  if [ -n "$COMMIT" ] && ! [[ $COMMIT =~ ^[0-9a-f]{7,40}$ ]]; then
    erro "commit inválido: '$COMMIT' (use o hash da main, curto ou completo, em minúsculas, ex.: 1a2b3c4d5e6f)."
  fi
  local c
  for c in docker git curl flock setsid tail tar sha256sum nice df awk; do
    command -v "$c" >/dev/null || erro "falta o comando $c (no Ubuntu: apt-get install -y git curl util-linux)."
  done
  docker info >/dev/null 2>&1 || erro "o Docker não respondeu (o serviço está rodando?)."
  # Os Dockerfiles usam o BuildKit (RUN --mount=type=cache): sem o plugin buildx, o `docker build` cai no construtor
  # antigo e falha.
  docker buildx version >/dev/null 2>&1 ||
    erro "falta o Docker Buildx (o BuildKit que os Dockerfiles usam): apt-get install -y docker-buildx-plugin."
  local raiz_docker livre d
  raiz_docker=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  for d in ${raiz_docker:+"$raiz_docker"} "$PASTA"; do
    livre=$(livre_gb "$d")
    [[ $livre =~ ^[0-9]+$ ]] || erro "não foi possível medir o espaço livre em $d (df)."
    [ "$livre" -ge "$ESPACO_MINIMO_GB" ] ||
      erro "só ${livre} GB livres em $d (mínimo: $ESPACO_MINIMO_GB GB para as imagens e o cache do build). Libere espaço (docker image prune -a, com cuidado; docker builder prune) e rode de novo."
  done
  ok "root, Docker com Buildx, git e curl; espaço livre acima de $ESPACO_MINIMO_GB GB"
  mkdir -p "$PASTA"
  # Uma execução deste script por vez (o build leva minutos, antes de o implantar.sh pegar a trava dele).
  exec 8>"$TRAVA"
  flock -n 8 || ocupado "outra implantação sem o Actions está em andamento ($TRAVA): espere ela terminar (bash $0 --acompanhar mostra)."
  trava_do_implantar_livre ||
    ocupado "outra implantação está em andamento (a trava do implantar.sh, $PASTA/.implantacao.lock): espere ela terminar."
  ok "nenhuma outra implantação em andamento"
}

# O processo $1 ainda roda: existe e não é zumbi. O zumbi (o filho que já terminou e o bash ainda não recolheu, ou o
# órfão que o init de um container não recolhe) ainda responde ao `kill -0`, e o `tail --pid` o seguia para sempre.
# Sem o /proc legível (o processo sumiu entre as duas conferências), conta como vivo: a próxima volta decide.
processo_vivo() {
  local linha estado
  kill -0 "$1" 2>/dev/null || return 1
  read -r linha 2>/dev/null <"/proc/$1/stat" || return 0
  # O 2º campo (o nome, entre parênteses) pode ter espaços: o estado é o primeiro campo depois do último ") ".
  estado=${linha##*') '}
  case "${estado%% *}" in
    Z | X) return 1 ;;
  esac
}

# Mostra o log $2 inteiro, do começo, até o processo $1 terminar, sem perder o fim (OP-B6). O `tail -f --pid` podia
# sair sem ler o que a implantação escreveu pouco antes de terminar (na CI, o --acompanhar parou na etapa 6, sem o
# resumo). Aqui, a cada volta, a conferência do processo vem ANTES da leitura do que falta (um descritor aberto uma
# vez só: o `cat` continua de onde a leitura anterior parou), e a última leitura é feita com ele já terminado: o que
# ele escreveu antes de sair já está no arquivo. Falha (1) só se não der para abrir o log ou para escrever na saída
# (o terminal que caiu); quem chama decide.
mostrar_ate_o_fim() {
  local pid=$1 log=$2 fd vivo=1
  exec {fd}<"$log" || return 1
  while [ "$vivo" = 1 ]; do
    processo_vivo "$pid" || vivo=0
    if ! cat <&"$fd"; then
      exec {fd}<&-
      return 1
    fi
    [ "$vivo" = 0 ] || sleep 0.2
  done
  exec {fd}<&-
}

# Roda as etapas 1 a 8 fora do terminal (o comentário do começo): uma cópia deste script (o comando do README baixa
# de novo por cima do ~/implantar-sem-actions.sh, e o bash lê o script aos poucos) numa sessão própria, com a
# entrada em /dev/null e a saída no log; a trava (descritor 8) passa para ela. Este processo só mostra o log até ela
# terminar e sai com o código dela. Volta sem fazer nada no --simular e na própria execução desacoplada.
desacoplar() {
  [ "$SIMULAR" = 0 ] && [ -z "${GENESIS_SEM_ACTIONS_LOG:-}" ] || return 0
  [ -f "$0" ] || erro "salve o script num arquivo e rode com bash <arquivo> (o comando do README), não pela entrada padrão."
  local log copia=$PASTA/.implantar-sem-actions.em-execucao.sh pid codigo=0 antigos excesso
  mkdir -p "$LOGS"
  chmod 700 "$LOGS"
  log=$LOGS/implantar-sem-actions-$(date -u +%Y%m%dT%H%M%SZ)-$$.log
  (umask 077 && : >"$log")
  ln -sfn "$(basename "$log")" "$LOG_ULTIMO"
  antigos=("$LOGS"/implantar-sem-actions-*.log)
  excesso=$((${#antigos[@]} - LOGS_MANTER))
  [ "$excesso" -le 0 ] || rm -f -- "${antigos[@]:0:excesso}"
  cp -f -- "$0" "$copia"
  GENESIS_SEM_ACTIONS_LOG=$log setsid -w bash "$copia" "$@" </dev/null >>"$log" 2>&1 &
  pid=$!
  # O Ctrl+C (e o fim do terminal) chega a este processo e ao que mostra o log, não à implantação, que está noutra
  # sessão.
  trap 'echo; aviso "este terminal parou de mostrar, mas a implantação continua fora dele. Para acompanhar de novo: bash $0 --acompanhar"; exit 130' INT TERM
  ok "a implantação roda fora deste terminal: fechar a aba, perder a conexão ou o Ctrl+C não a interrompem (só param de mostrar). Para acompanhar de novo: bash $0 --acompanhar. Saída completa: $log"
  mostrar_ate_o_fim "$pid" "$log" || true
  wait "$pid" || codigo=$?
  exit "$codigo"
}

# --acompanhar: a implantação em andamento (o log até o processo dela terminar, mostrar_ate_o_fim) ou a saída da
# última.
acompanhar() {
  [ "$(id -u)" = 0 ] || erro "rode como root (a saída fica em $LOGS, só do root)."
  [ -e "$LOG_ULTIMO" ] || erro "nenhuma implantação sem o Actions registrada em $LOGS."
  local pid=''
  # Em andamento = a trava deste script presa (o pid sozinho poderia ser de outro processo, reaproveitado).
  if ! (exec 7>"$TRAVA" && flock -n 7); then pid=$(cat "$PID_ARQUIVO" 2>/dev/null || true); fi
  if [[ $pid =~ ^[0-9]+$ ]] && processo_vivo "$pid"; then
    ok "implantação em andamento ($(readlink "$LOG_ULTIMO")); o Ctrl+C só para de mostrar."
    mostrar_ate_o_fim "$pid" "$LOG_ULTIMO"
  else
    ok "nenhuma implantação sem o Actions em andamento; a saída da última ($(readlink "$LOG_ULTIMO")):"
    cat "$LOG_ULTIMO"
  fi
}

# --- 1 e 2. Commit da main e versão --------------------------------------------------------------------------------

# git na fonte, sem credencial nenhuma (nem a de um credential helper do root, nem pergunta no terminal): o
# repositório é público.
git_fonte() { GIT_TERMINAL_PROMPT=0 git -c credential.helper= -C "$FONTE" "$@"; }

preparar_fonte() {
  passo "1/8 Commit da main (fonte em $FONTE)"
  mkdir -p "$FONTE"
  chmod 700 "$FONTE"
  if [ ! -d "$FONTE/.git" ]; then
    [ -z "$(ls -A "$FONTE")" ] ||
      erro "$FONTE existe, mas não é um clone do repositório: confira o que há nela e apague (rm -rf $FONTE) para clonar de novo."
    # Só a main, sem tags e sem os arquivos (blob:none): o histórico, para conferir a ancestralidade; os arquivos do
    # commit vêm no checkout.
    GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --quiet --no-checkout --filter=blob:none --single-branch \
      --branch main --no-tags "$REPOSITORIO" "$FONTE" ||
      erro "não foi possível clonar $REPOSITORIO (rede da VPS ou o GitHub fora do ar?); tente de novo."
  fi
  # Sempre o repositório público (um `remote set-url` à mão na fonte não muda de onde vem o código).
  git_fonte remote set-url origin "$REPOSITORIO"
  git_fonte fetch --quiet --prune --no-tags origin '+refs/heads/main:refs/remotes/origin/main' ||
    erro "não foi possível buscar a main de $REPOSITORIO (rede da VPS ou o GitHub fora do ar?); tente de novo."
  git_fonte rev-parse --verify --quiet origin/main >/dev/null || erro "branch main não encontrado em $REPOSITORIO."
  # Só a main é buscada (e nenhuma tag, que um hash curto poderia casar): um commit de outro branch pelo hash curto
  # não é encontrado; pelo completo, o clone parcial o busca sob demanda, e a ancestralidade recusa.
  SHA=$(git_fonte rev-parse --verify --quiet "${COMMIT:-origin/main}^{commit}") ||
    erro "commit '$COMMIT' não encontrado na main de $REPOSITORIO (ou o hash curto é ambíguo: informe o completo)."
  git_fonte merge-base --is-ancestor "$SHA" origin/main ||
    erro "o commit $SHA não está na main: só vai para produção o que entrou na main (PR revisado, verificação local verde)."
  VERSAO=$(git_fonte rev-parse --short=12 "$SHA")
  local f
  for f in apps/api/Dockerfile apps/erp-web/Dockerfile infra/producao/backup/Dockerfile "${ARQUIVOS_DA_VERSAO[@]/#/infra/producao/}"; do
    [ -n "$(git_fonte ls-tree --name-only "$SHA" -- "$f")" ] ||
      erro "o commit $VERSAO não tem $f: este script implanta só commits com as 3 imagens (desde o I1b). Para voltar à versão anterior, use $PASTA/implantar.sh voltar."
  done
  if [ -n "$COMMIT" ]; then
    ok "commit $SHA está na main (informado: $COMMIT)"
  else
    ok "commit $SHA, o último da main"
  fi
  passo "2/8 Versão: $VERSAO (o commit em 12 caracteres, a tag das imagens e o nome da release)"
  if [ "$SIMULAR" = 1 ]; then
    simulado "git checkout $VERSAO em $FONTE"
    return 0
  fi
  git_fonte -c advice.detachedHead=false checkout --quiet --force --detach "$SHA"
  git_fonte clean -ffdxq
  ok "fonte no commit $VERSAO"
}

# --- 3 e 4. Imagens e arquivos da versão ---------------------------------------------------------------------------

montar_imagens() {
  passo "3/8 Imagens genesis-api, genesis-web e genesis-backup :$VERSAO (montadas aqui na VPS)"
  local prioridade=(nice -n 19) opcoes=() inicio=$SECONDS
  if command -v ionice >/dev/null && ionice -c 3 true 2>/dev/null; then prioridade+=(ionice -c 3); fi
  if [ -n "${GENESIS_BUILD_OPCOES:-}" ]; then read -r -a opcoes <<<"$GENESIS_BUILD_OPCOES"; fi
  # Imagem, Dockerfile e contexto (os do workflow).
  local imagens=(
    "genesis-api|$FONTE/apps/api/Dockerfile|$FONTE"
    "genesis-web|$FONTE/apps/erp-web/Dockerfile|$FONTE"
    "genesis-backup|$FONTE/infra/producao/backup/Dockerfile|$FONTE/infra/producao/backup"
  )
  local item nome arquivo contexto
  if [ "$SIMULAR" = 1 ]; then
    for item in "${imagens[@]}"; do
      IFS='|' read -r nome arquivo contexto <<<"$item"
      simulado "${prioridade[*]} docker build --build-arg VERSAO=$VERSAO -f $arquivo -t $nome:$VERSAO $contexto"
    done
    return 0
  fi
  aviso "a montagem leva alguns minutos (a primeira, mais: baixa as imagens base e os pacotes) e usa a CPU e o disco da VPS. A versão em produção continua no ar até a troca (etapa 6); prefira um horário fora do pico."
  for item in "${imagens[@]}"; do
    IFS='|' read -r nome arquivo contexto <<<"$item"
    echo "--- $nome:$VERSAO"
    "${prioridade[@]}" docker build "${opcoes[@]}" --build-arg "VERSAO=$VERSAO" -f "$arquivo" -t "$nome:$VERSAO" "$contexto" ||
      erro "a imagem $nome:$VERSAO não montou (mensagem acima); nada foi trocado: a versão em produção continua no ar."
  done
  ok "3 imagens montadas em $(((SECONDS - inicio) / 60)) min $(((SECONDS - inicio) % 60)) s"
}

copiar_arquivos() {
  local destino=$PASTA/releases/$VERSAO f
  passo "4/8 Arquivos da versão ($destino)"
  if [ "$SIMULAR" = 1 ]; then
    simulado "copiar ${ARQUIVOS_DA_VERSAO[*]} de infra/producao para $destino (chmod +x nos .sh)"
    return 0
  fi
  mkdir -p "$destino"
  for f in "${ARQUIVOS_DA_VERSAO[@]}"; do
    cp -f "$FONTE/infra/producao/$f" "$destino/$f"
  done
  chmod +x "$destino"/*.sh
  ok "${ARQUIVOS_DA_VERSAO[*]}"
}

# --- 5 e 7. Instalador do PDV do último GitHub Release -------------------------------------------------------------

# jq da imagem do backup que acabou de ser montada (a VPS não depende de jq: README › Página de download do PDV),
# sem rede e com o limite de memória do backup.
jq_imagem() { docker run --rm -i --network none --memory 64m --entrypoint jq "genesis-backup:$VERSAO" "$@"; }
api_github() {
  curl -fsS --proto '=https' --max-time 30 -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "$API_GITHUB/$1"
}
# Download público do release (redireciona para o armazenamento do GitHub; só https).
baixar_github() { curl -fsSL --proto '=https' --max-time 900 -o "$2" "$DOWNLOAD_GITHUB/$1"; }

# Falha do GitHub (listar, ler ou baixar) ou release incompleto: só um aviso, e a implantação segue com a página como
# está (o `pular` do workflow).
pular_pdv() {
  aviso "$* A página de download fica como está (README de infra/producao › Página de download do PDV)."
  PDV_ACAO=''
  PAGINA="não mexida (o GitHub não respondeu ou o release está incompleto: veja os avisos)"
}

preparar_pdv() {
  [ "$PUBLICAR_PDV" = 1 ] || return 0
  passo "5/8 Instalador do PDV (último GitHub Release), antes da troca de versão"
  if [ "$SIMULAR" = 1 ]; then
    simulado "procurar o GitHub Release pdv-vX.Y.Z publicado mais novo, baixar o instalador e o .sha256, conferir e publicar na página depois da troca (ou retirar o instalador, se não houver release publicado)"
    return 0
  fi
  local pagina=1 lote n tags='' tag info nome esperado calculado na_vps sha256
  while :; do
    lote=$(api_github "releases?per_page=100&page=$pagina") || {
      pular_pdv "Não foi possível listar os GitHub Releases."
      return 0
    }
    n=$(jq_imagem 'length' <<<"$lote") && [[ $n =~ ^[0-9]+$ ]] || {
      pular_pdv "Resposta inesperada do GitHub ao listar os releases."
      return 0
    }
    [ "$n" -gt 0 ] || break
    lote=$(jq_imagem -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' <<<"$lote") || {
      pular_pdv "Resposta inesperada do GitHub ao listar os releases."
      return 0
    }
    tags+=$lote$'\n'
    [ "$n" -eq 100 ] && [ "$pagina" -lt 10 ] || break
    pagina=$((pagina + 1))
  done
  tag=$(grep -E '^pdv-v[0-9]+\.[0-9]+\.[0-9]+$' <<<"$tags" | sort -V | tail -n 1 || true)
  if [ -z "$tag" ]; then
    aviso "Nenhum GitHub Release pdv-vX.Y.Z publicado (rascunho e pre-release não contam): depois da troca, a página de download volta a dizer que o instalador ainda não foi publicado (README de infra/producao › Página de download do PDV)."
    PDV_ACAO=retirar
    PAGINA="não mexida: a implantação parou antes de tirar o instalador (sem GitHub Release do PDV publicado); rode de novo"
    return 0
  fi
  PDV_VERSAO=${tag#pdv-v}
  PDV_EXE="GenesisPDV-Setup-$PDV_VERSAO.exe"
  info=$(api_github "releases/tags/$tag") || {
    pular_pdv "Não foi possível ler o release $tag."
    return 0
  }
  PDV_PUBLICADO=$(jq_imagem -r .published_at <<<"$info" || true)
  [[ $PDV_PUBLICADO =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || {
    pular_pdv "Data de publicação inesperada no release $tag: '$PDV_PUBLICADO'."
    return 0
  }
  for nome in "$PDV_EXE" "$PDV_EXE.sha256"; do
    jq_imagem -e --arg n "$nome" 'any(.assets[]; .name == $n)' <<<"$info" >/dev/null || {
      pular_pdv "O release $tag não tem o arquivo $nome (ainda enviando?)."
      return 0
    }
  done
  sha256=$TEMP/pdv/$PDV_EXE.sha256
  mkdir -p "$TEMP/pdv"
  baixar_github "$tag/$PDV_EXE.sha256" "$sha256" || {
    pular_pdv "Não foi possível baixar $PDV_EXE.sha256 do release $tag."
    return 0
  }
  # O mesmo formato que a VPS exige (implantar.sh pdv publicar): uma linha só, '<64 hex>  <nome do instalador>'.
  PAGINA="não mexida: o instalador do PDV do release $tag não conferiu (veja o erro acima)"
  [ "$(awk 'END { print NR }' "$sha256")" = 1 ] ||
    erro "$PDV_EXE.sha256 do release $tag deveria ter uma linha só ('<hash>  $PDV_EXE'): nada foi publicado e a produção não mudou. Refaça o release (PDV release com \"substituir\") ou implante sem --publicar-pdv."
  esperado=$(awk '{ print tolower($1) }' "$sha256")
  nome=$(awk '{ sub(/^\*/, "", $2); print $2 }' "$sha256")
  [[ $esperado =~ ^[0-9a-f]{64}$ ]] && [ "$nome" = "$PDV_EXE" ] ||
    erro "$PDV_EXE.sha256 do release $tag fora do formato do sha256sum ('<hash>  $PDV_EXE'): nada foi publicado e a produção não mudou. Refaça o release (PDV release com \"substituir\") ou implante sem --publicar-pdv."
  na_vps=$(bash "$PASTA/releases/$VERSAO/implantar.sh" pdv atual 2>/dev/null || true)
  if [ "$na_vps" = "$esperado" ]; then
    ok "A página de download já serve o PDV $PDV_VERSAO (sha256 $esperado): nada a baixar nem publicar."
    PDV_ACAO=ja
    PAGINA="PDV $PDV_VERSAO (já publicado)"
    return 0
  fi
  baixar_github "$tag/$PDV_EXE" "$TEMP/pdv/$PDV_EXE" || {
    pular_pdv "Não foi possível baixar $PDV_EXE do release $tag (rede ou GitHub; rode de novo)."
    return 0
  }
  # O hash calculado do arquivo baixado, não o `sha256sum -c` (que confere o nome que o próprio .sha256 traz).
  calculado=$(sha256sum "$TEMP/pdv/$PDV_EXE" | cut -d' ' -f1)
  [ "$calculado" = "$esperado" ] ||
    erro "o sha256 de $PDV_EXE baixado do release $tag ($calculado) não confere com o $PDV_EXE.sha256 do release ($esperado): nada foi publicado e a produção não mudou. Refaça o release (PDV release com \"substituir\") ou implante sem --publicar-pdv."
  ok "PDV $PDV_VERSAO baixado e conferido ($(stat -c %s "$TEMP/pdv/$PDV_EXE") bytes, sha256 $esperado); a VPS servia: ${na_vps:-nada}."
  PDV_ACAO=publicar
  PAGINA="não mexida: a implantação parou antes de publicar o PDV $PDV_VERSAO; rode de novo"
}

# Depois da troca (o instalador novo só aparece com a versão nova no ar), como o passo "Página de download" do
# workflow: o implantar.sh confere o sha256 de novo e troca por rename.
publicar_pdv() {
  if [ "$SIMULAR" = 1 ] && [ "$PUBLICAR_PDV" = 1 ]; then
    passo "7/8 Página de download"
    simulado "tar do instalador e do .sha256 | bash $PASTA/releases/$VERSAO/implantar.sh pdv publicar <X.Y.Z> <publicado_em> (ou pdv retirar)"
    return 0
  fi
  case "$PDV_ACAO" in
    publicar | retirar) ;;
    *) return 0 ;;
  esac
  local script=$PASTA/releases/$VERSAO/implantar.sh
  passo "7/8 Página de download"
  if [ "$PDV_ACAO" = retirar ]; then
    bash "$script" pdv retirar || {
      PAGINA="não mexida: falhou ao tirar o instalador (sem GitHub Release do PDV publicado); a página continua com o que servia, rode de novo"
      erro "implantar.sh pdv retirar falhou (mensagem acima); a versão $VERSAO está no ar."
    }
    PAGINA="instalador retirado nesta implantação (sem GitHub Release do PDV publicado): diz \"ainda não publicado\""
    return 0
  fi
  tar -C "$TEMP/pdv" -cf - "$PDV_EXE" "$PDV_EXE.sha256" | bash "$script" pdv publicar "$PDV_VERSAO" "$PDV_PUBLICADO" || {
    PAGINA="não mexida: falhou ao publicar o PDV $PDV_VERSAO; a página continua com o que servia, rode de novo"
    erro "implantar.sh pdv publicar falhou (mensagem acima); a versão $VERSAO está no ar."
  }
  PAGINA="PDV $PDV_VERSAO (publicado nesta implantação)"
}

# --- 6. instalar.sh e implantar.sh ---------------------------------------------------------------------------------

implantar_versao() {
  local release=$PASTA/releases/$VERSAO
  passo "6/8 Preparação da VPS (instalar.sh) e implantação (implantar.sh implantar $VERSAO)"
  if [ "$SIMULAR" = 1 ]; then
    simulado "bash $release/instalar.sh"
    simulado "bash $release/implantar.sh implantar $VERSAO (proxy do Cloud SQL, migrações, troca de versão, saúde e volta automática)"
    return 0
  fi
  bash "$release/instalar.sh" ||
    erro "o instalar.sh falhou (mensagem acima); nada foi trocado: a versão em produção continua no ar."
  if bash "$release/implantar.sh" implantar "$VERSAO"; then
    IMPLANTACAO=sucesso
  else
    IMPLANTACAO=falha
    limpar_imagens
    exit 1
  fi
}

# --- 8. URLs públicas, limpeza e resumo ----------------------------------------------------------------------------

# https://<domínio> do $PASTA/.env (o que o Traefik serve), com o padrão do workflow se faltar.
url_do_dominio() {
  local d=''
  [ -f "$PASTA/.env" ] && d=$(sed -n "s/^$1=//p" "$PASTA/.env" | tail -n 1)
  [[ $d =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || d=$2
  echo "https://$d"
}

conferir() {
  local resposta=$TEMP/resposta _
  for _ in $(seq 1 "$TENTATIVAS"); do
    if curl -fsS --max-time 10 "$1" -o "$resposta"; then
      grep -q "$2" "$resposta" && {
        echo "OK: $1"
        return 0
      }
    fi
    sleep "$INTERVALO"
  done
  erro "$1 não respondeu como esperado (DNS, certificado ou Traefik?). Para voltar à versão anterior: $PASTA/implantar.sh voltar"
}

conferir_urls() {
  if [ "$CONFERIR_URL" = 0 ]; then
    aviso "conferência pelas URLs públicas pulada (--sem-conferir-url)."
    return 0
  fi
  local api erp download codigo
  api=${GENESIS_API_URL:-$(url_do_dominio API_DOMINIO api.grupoicebeer.com.br)}
  erp=${GENESIS_ERP_URL:-$(url_do_dominio ERP_DOMINIO erp.grupoicebeer.com.br)}
  download=${GENESIS_DOWNLOAD_URL:-$(url_do_dominio DOWNLOAD_DOMINIO download.grupoicebeer.com.br)}
  passo "8/8 Conferência pelas URLs públicas"
  if [ "$SIMULAR" = 1 ]; then
    simulado "conferir $api/saude, $erp/saude, $erp/, $api/api/saude/detalhada (401 sem token) e $download/"
    return 0
  fi
  conferir "$api/saude" '"status":"ok"'
  conferir "$erp/saude" '"status":"ok"'
  conferir "$erp/" '<div id="root">'
  # Painel do monitoramento (I1b): publicado e fechado sem o token.
  codigo=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$api/api/saude/detalhada" || true)
  [ "$codigo" = 401 ] || erro "$api/api/saude/detalhada sem token deveria responder 401 (veio $codigo)."
  echo "OK: $api/api/saude/detalhada sem token → 401"
  # Página de download e, com o instalador publicado, o atual.json e o primeiro byte do instalador.
  conferir "$download/" 'pagina.js'
  if [ "$PDV_ACAO" = publicar ] || [ "$PDV_ACAO" = ja ]; then
    conferir "$download/pdv/atual.json" "\"versao\": \"$PDV_VERSAO\""
    curl -fsS --max-time 10 -r 0-0 -o /dev/null "$download/pdv/$PDV_EXE" ||
      erro "$download/pdv/$PDV_EXE não foi servido."
    echo "OK: $download/pdv/$PDV_EXE"
  elif [ "$PDV_ACAO" = retirar ]; then
    codigo=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$download/pdv/atual.json" || true)
    [ "$codigo" = 404 ] || erro "$download/pdv/atual.json deveria responder 404 sem release publicado (veio $codigo)."
    echo "OK: $download/pdv/atual.json → 404 (página: ainda não publicado)"
  fi
}

# Imagens do Genesis além das MANTER_IMAGENS mais recentes de cada nome, nunca a atual nem a anterior (as do
# `implantar.sh voltar`), e o cache do build com mais de uma semana. Depois de uma implantação boa, o `limpar` do
# implantar.sh já deixou só a atual e a anterior; isto cobre a que falhou (as imagens novas ficam até a próxima).
limpar_imagens() {
  local atual anterior nome tag n removidas=0
  atual=$(cat "$PASTA/versoes/atual" 2>/dev/null || true)
  anterior=$(cat "$PASTA/versoes/anterior" 2>/dev/null || true)
  for nome in genesis-api genesis-web genesis-backup; do
    n=0
    while IFS=$'\t' read -r _ tag; do
      [ -n "$tag" ] && [ "$tag" != '<none>' ] || continue
      n=$((n + 1))
      if [ "$n" -le "$MANTER_IMAGENS" ] || [ "$tag" = "$atual" ] || [ "$tag" = "$anterior" ]; then continue; fi
      if [ "$SIMULAR" = 1 ]; then
        simulado "docker image rm $nome:$tag"
      elif docker image rm "$nome:$tag" >/dev/null 2>&1; then
        removidas=$((removidas + 1))
      fi
    done < <(docker image ls "$nome" --format '{{.CreatedAt}}'$'\t''{{.Tag}}' 2>/dev/null | sort -r)
  done
  if [ "$SIMULAR" = 1 ]; then
    simulado "docker builder prune -f --filter until=168h (cache do build com mais de uma semana)"
    return 0
  fi
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  ok "limpeza: $removidas imagem(ns) antiga(s) do Genesis removida(s) (ficam as $MANTER_IMAGENS mais recentes de cada, a atual e a anterior); cache do build com mais de uma semana removido"
}

# O "Resumo" do workflow: a versão, a página de download e onde ver o estado (sem segredo nem estado da VPS).
resumo() {
  local versao script=$PASTA/implantar.sh tempo=$((SECONDS - INICIO))
  case "$IMPLANTACAO" in
    sucesso) versao="$VERSAO no ar" ;;
    falha)
      versao="$VERSAO não ficou no ar: a mensagem ERRO acima diz em que etapa parou e o que fazer. Antes da troca de versão (migrações, trava), a anterior, se havia, continuou no ar; se a nova não ficou saudável, a VPS voltou sozinha para a anterior e o log da API ficou guardado (bash $PASTA/releases/$VERSAO/implantar.sh logs)"
      script=$PASTA/releases/$VERSAO/implantar.sh
      ;;
    *) versao="$VERSAO não foi implantada: parou antes da troca de versão (veja o ERRO acima); a versão em produção continua no ar" ;;
  esac
  printf '\n\033[1;34m### Implantação sem o Actions: %s\033[0m (%d min %d s)\n' "$VERSAO" $((tempo / 60)) $((tempo % 60))
  echo "Versão: $versao."
  echo "Página de download: $PAGINA."
  echo "Estado da VPS (containers, memória, backup): bash $script estado"
  [ "$IMPLANTACAO" != sucesso ] || echo "Voltar para a versão anterior, se precisar: $PASTA/implantar.sh voltar"
  [ -z "${GENESIS_SEM_ACTIONS_LOG:-}" ] || echo "Saída completa desta implantação: $GENESIS_SEM_ACTIONS_LOG"
}

ao_sair() {
  local codigo=$?
  [ -z "$TEMP" ] || rm -rf "$TEMP"
  if [ "$SIMULAR" = 1 ] && [ "$codigo" = 0 ]; then
    printf '\n\033[1;36mSimulação de %s: tudo conferido; nada foi montado nem trocado.\033[0m\n' "$VERSAO"
  elif [ "$SIMULAR" = 0 ] && [ -n "$VERSAO" ]; then
    resumo
  fi
  exit "$codigo"
}

if [ "$ACOMPANHAR" = 1 ]; then
  acompanhar
  exit 0
fi
if [ -n "${GENESIS_SEM_ACTIONS_LOG:-}" ]; then
  # A execução desacoplada: as conferências e a trava (o descritor 8, herdado) vieram do terminal; sem a trava presa,
  # alguém pôs a variável à mão, e a execução para.
  flock -n 8 2>/dev/null || erro "execução desacoplada sem a trava ($TRAVA): rode bash $0, sem GENESIS_SEM_ACTIONS_LOG."
  echo "$$" >"$PID_ARQUIVO"
else
  conferir_requisitos
  desacoplar "$@"
fi
TEMP=$(mktemp -d "${TMPDIR:-/tmp}/genesis-sem-actions.XXXXXX")
trap ao_sair EXIT
preparar_fonte
montar_imagens
copiar_arquivos
preparar_pdv
implantar_versao
publicar_pdv
conferir_urls
limpar_imagens
