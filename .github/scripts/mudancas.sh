#!/usr/bin/env bash
# Quais jobs pesados do CI (.github/workflows/ci.yml) precisam rodar, pelos arquivos que mudaram (economia de minutos do
# GitHub Actions; CONTRIBUTING.md › CI). Só git e bash (e o gh, já instalado no runner, no push da main), sem ação de
# terceiros.
#
# No CI (job "mudancas"), sem argumentos: a base vem do evento (variáveis EVENTO, ANTES, BASE_PR e ESCOPO, além das do
# próprio Actions) e as saídas ts, pdv, imagens e e2e (true/false) vão para o $GITHUB_OUTPUT, com o resumo no
# $GITHUB_STEP_SUMMARY. Na dúvida, roda tudo: disparo manual (escopo "tudo", o padrão), `before` zerado, nenhum CI
# verde anterior na main, base que não se resolve, erro do git ou da API, arquivo fora dos lugares conhecidos.
#
# Local, para ver o que o CI rodaria no seu branch (só o que está commitado):
#   .github/scripts/mudancas.sh                # contra o merge-base com a origin/main (o que um PR veria)
#   .github/scripts/mudancas.sh BASE [HEAD]    # contra outra base
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

JOBS=(ts pdv imagens e2e)
declare -A RODAR=([ts]=false [pdv]=false [imagens]=false [e2e]=false)
MOTIVO=''
BASE=''
HEAD_REV=HEAD

marcar() {
  local job
  for job in "$@"; do RODAR[$job]=true; done
}

tudo() {
  MOTIVO="$1"
  marcar "${JOBS[@]}"
}

# Caminho relativo à raiz, sem "." nem "..": apps/pdv/tests/X/../../../api/a.json → apps/api/a.json (bash puro; o
# `realpath -m` não existe no macOS).
normalizar() {
  local parte
  local -a partes saida=()
  IFS=/ read -ra partes <<<"$1" # read não expande glob (o *.json do csproj fica literal)
  for parte in "${partes[@]}"; do
    case "$parte" in
      '' | .) ;;
      ..) ((${#saida[@]})) && unset 'saida[${#saida[@]}-1]' ;;
      *) saida+=("$parte") ;;
    esac
  done
  local IFS=/
  echo "${saida[*]}"
}

# Arquivos de fora de apps/pdv que os projetos do PDV copiam para os testes (<None Include="..\..\..\..\packages\...">:
# fixtures e vetores de packages/shared/testes, enums.ts, configuracoes.ts, permissoes.ts, perfis-padrao.ts,
# validadores.casos.json, o apps/api/test/e2e-pdv/estado.exemplo.json). Lidos dos próprios csproj, para um link novo
# entrar sozinho. Padrões glob (o *.json do csproj continua glob).
LIDOS_PELO_PDV=()
while IFS= read -r proj; do
  pasta=$(dirname "$proj")
  while IFS= read -r inc; do
    inc=${inc//\\//}
    caminho=$(normalizar "$pasta/$inc")
    [[ $caminho == apps/pdv/* ]] || LIDOS_PELO_PDV+=("$caminho")
  done < <(grep -oE 'Include="[^"]*\.\.[^"]*"' "$proj" | sed -E 's/^Include="//; s/"$//')
done < <(git ls-files -- 'apps/pdv/*.csproj' 'apps/pdv/*.props' 'apps/pdv/*.targets')
# Sem nenhum (csproj mudou de formato?): todo o shared e o e2e-pdv da API contam para o PDV.
((${#LIDOS_PELO_PDV[@]})) || LIDOS_PELO_PDV=('packages/shared/*' 'apps/api/test/e2e-pdv/*')

lido_pelo_pdv() {
  local padrao
  for padrao in "${LIDOS_PELO_PDV[@]}"; do
    # shellcheck disable=SC2053 # o lado direito é glob de propósito
    [[ $1 == $padrao ]] && return 0
  done
  return 1
}

# Mapa caminho → jobs. A ordem importa (o primeiro padrão que casa vale) e o padrão final roda tudo: arquivo novo fora
# dos lugares conhecidos nunca passa sem CI. Quem lê o quê:
#   ts      prettier e eslint (a raiz inteira menos o .prettierignore: docs, *.md, apps/pdv, infra; o prettier também
#           lê .editorconfig e .gitignore), tipos, testes unitários, build e o `verificar:esquema-pdv`, que compara o
#           apps/pdv/src/GenesisPDV.Data/Esquema.g.cs com o schema Drizzle. O job "Integração da API (PostgreSQL 18)",
#           o único com a integração da API, usa a mesma saída.
#   pdv     os dois jobs do PDV: "PDV (.NET 10) – windows-latest" (build, testes, impressora de teste e instalador; o
#           PDV na CI é só Windows, README do PDV › decisão 80) e "PDV (.NET 10) – formatação" (o `dotnet format`, no
#           Linux). Leem apps/pdv, os arquivos de fora que os csproj copiam (LIDOS_PELO_PDV) e os contratos do sync que
#           o C# espelha (packages/shared/src/sync e packages/shared/testes inteiros, na dúvida). O resto do shared (ex.:
#           estoque.ts, produtos.ts) o PDV não compila nem lê; a conferência de ponta a ponta com a API é do e2e.
#   imagens os Dockerfiles (contexto = raiz menos o .dockerignore: apps/pdv, docs, infra e *.md ficam de fora) e
#           infra/producao (backup, shellcheck, compose).
#   e2e     a API (apps/api/test/e2e-pdv), o PDV e o shared, com o pnpm install da raiz.
classificar() {
  lido_pelo_pdv "$1" && marcar pdv
  case "$1" in
    .github/workflows/ci.yml | .github/scripts/*) marcar ts pdv imagens e2e ;;
    docs/* | *.md) ;; # documentação: prettier e eslint ignoram, nenhum build nem teste lê
    apps/pdv/src/GenesisPDV.Data/Esquema.g.cs) marcar ts pdv e2e ;;
    apps/pdv/*) marcar pdv e2e ;;
    apps/api/*) marcar ts imagens e2e ;;
    apps/erp-web/*) marcar ts imagens ;;
    packages/shared/src/sync/* | packages/shared/testes/*) marcar ts pdv imagens e2e ;;
    packages/*) marcar ts imagens e2e ;;
    infra/producao/*) marcar imagens ;;
    infra/docker-compose.yml) ;; # só o ambiente local; nenhum job lê
    .github/*) marcar ts ;;      # os outros workflows: o prettier confere o YAML
    .dockerignore) marcar imagens ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .npmrc | .nvmrc | tsconfig*.json) marcar ts imagens e2e ;;
    eslint.config.* | .prettierrc* | .prettierignore) marcar ts ;;
    *) marcar ts pdv imagens e2e ;; # .editorconfig, .gitattributes, .gitignore e o que aparecer: na dúvida, tudo
  esac
}

zeros='0000000000000000000000000000000000000000'

# push na main: a base é o commit anterior (`before`) se o CI dele ficou verde; senão (falhou, ou ficou pendente e foi
# cancelado pelo concurrency quando chegou um terceiro push), o último commit da main com CI verde que seja ancestral
# deste. Assim nada que entrou na main fica sem CI verde antes da implantação automática (workflow_run do
# implantacao.yml). Só contam os runs verdes de push (inclusive o "Re-run" de um push): um disparo manual pode ter
# rodado um job só (escopo ts, pdv, imagens, e2e ou mudancas) e ficar verde sem testar o commit, e a API não mostra o
# escopo escolhido. Desconsiderar o disparo manual só faz rodar mais, nunca menos.
base_do_push() {
  if [[ -z ${ANTES:-} || $ANTES == "$zeros" ]]; then
    tudo 'push sem commit anterior (before zerado ou ausente): roda tudo'
    return
  fi
  local verdes sha head
  head=$(git rev-parse HEAD) || {
    tudo 'falha no git rev-parse HEAD: roda tudo'
    return
  }
  verdes=$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs" \
    -f branch="$GITHUB_REF_NAME" -f status=success -f per_page=50 \
    --jq '.workflow_runs[] | select(.event == "push") | .head_sha') ||
    {
      tudo 'falha ao consultar os runs verdes do CI na API do GitHub: roda tudo'
      return
    }
  if [[ $ANTES != "$head" ]] && grep -qx "$ANTES" <<<"$verdes" && git merge-base --is-ancestor "$ANTES" HEAD 2>/dev/null; then
    BASE=$ANTES
    MOTIVO="push: diferença contra o commit anterior (${ANTES:0:12}, CI verde)"
    return
  fi
  while read -r sha; do
    # O próprio commit não serve de base: no "Re-run" de um push que já ficou verde, a diferença seria vazia e
    # nada rodaria.
    [[ -n $sha && $sha != "$head" ]] || continue
    if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
      BASE=$sha
      MOTIVO="push: o CI do commit anterior (${ANTES:0:12}) não ficou verde; diferença contra o último CI verde da $GITHUB_REF_NAME (${sha:0:12})"
      return
    fi
  done <<<"$verdes"
  tudo "push: nenhum CI verde anterior na $GITHUB_REF_NAME que seja ancestral deste commit: roda tudo"
}

base_do_pr() {
  # O checkout de um PR é o merge de teste (refs/pull/N/merge): o primeiro pai é a ponta da base usada no merge, e a
  # diferença contra ele é exatamente o que o PR muda.
  if git rev-parse -q --verify 'HEAD^2' >/dev/null && BASE=$(git rev-parse 'HEAD^1'); then
    MOTIVO="pull request: diferença contra a base (${BASE:0:12})"
    return
  fi
  if [[ -n ${BASE_PR:-} ]] && BASE=$(git merge-base "$BASE_PR" HEAD 2>/dev/null); then
    MOTIVO="pull request: diferença contra o merge-base com a base (${BASE:0:12})"
    return
  fi
  BASE=''
  tudo 'pull request sem base resolvível: roda tudo'
}

# Disparo manual: o escopo escolhido no "Run workflow" (padrão: tudo).
base_do_manual() {
  case "${ESCOPO:-tudo}" in
    ts | pdv | imagens | e2e)
      marcar "$ESCOPO"
      MOTIVO="disparo manual só com o job $ESCOPO"
      ;;
    mudancas)
      if ! BASE=$(git merge-base origin/main HEAD 2>/dev/null); then
        BASE=''
        tudo 'disparo manual pelas mudanças, mas sem merge-base com a origin/main: roda tudo'
      elif [[ $BASE == "$(git rev-parse HEAD)" ]]; then
        # Na própria main (ou num branch sem commit novo), a diferença seria vazia e nada rodaria.
        BASE=''
        tudo 'disparo manual pelas mudanças, mas o commit já está na origin/main (diferença vazia): roda tudo'
      else
        MOTIVO="disparo manual pelas mudanças: diferença contra o merge-base com a origin/main (${BASE:0:12})"
      fi
      ;;
    *) tudo 'disparo manual (workflow_dispatch): roda tudo' ;;
  esac
}

if [[ ${GITHUB_ACTIONS:-} == true ]]; then
  case "${EVENTO:-}" in
    pull_request) base_do_pr ;;
    push) base_do_push ;;
    workflow_dispatch) base_do_manual ;;
    *) tudo "evento ${EVENTO:-desconhecido}: roda tudo" ;;
  esac
else
  BASE=${1:-$(git merge-base origin/main HEAD)} || {
    echo "sem merge-base com a origin/main; informe a base: $0 BASE [HEAD]" >&2
    exit 2
  }
  HEAD_REV=${2:-HEAD}
  MOTIVO="local: diferença $BASE..$HEAD_REV"
fi

ARQUIVOS=()
if [[ -n $BASE ]]; then
  # -z: nomes com espaço ou acento chegam inteiros; --no-renames: o caminho antigo de um arquivo movido também conta.
  if lista=$(git diff --name-only --no-renames -z "$BASE" "$HEAD_REV" | tr '\0' '\n'; exit "${PIPESTATUS[0]}"); then
    while IFS= read -r f; do
      [[ -n $f ]] || continue
      ARQUIVOS+=("$f")
      classificar "$f"
    done <<<"$lista"
  else
    tudo "falha no git diff $BASE $HEAD_REV: roda tudo"
  fi
fi

echo "Motivo: $MOTIVO"
echo "Arquivos alterados: ${#ARQUIVOS[@]}"
for job in "${JOBS[@]}"; do echo "$job=${RODAR[$job]}"; done

if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  for job in "${JOBS[@]}"; do echo "$job=${RODAR[$job]}" >>"$GITHUB_OUTPUT"; done
fi

sim() { [[ ${RODAR[$1]} == true ]] && echo sim || echo 'não (pulado)'; }

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo '### O que este CI roda'
    echo
    echo "$MOTIVO. Arquivos alterados: ${#ARQUIVOS[@]}."
    echo
    echo '| Saída | Jobs | Roda |'
    echo '|---|---|---|'
    echo "| ts | TypeScript (API, ERP web, shared) e Integração da API (PostgreSQL 18) | $(sim ts) |"
    echo "| pdv | PDV (.NET 10) – windows-latest e PDV (.NET 10) – formatação | $(sim pdv) |"
    echo "| imagens | Imagens Docker (API, ERP e backup) | $(sim imagens) |"
    echo "| e2e | E2E PDV ↔ API | $(sim e2e) |"
    if ((${#ARQUIVOS[@]} > 0)); then
      echo
      echo '<details><summary>Arquivos</summary>'
      echo
      printf -- "- \`%s\`\n" "${ARQUIVOS[@]:0:300}"
      ((${#ARQUIVOS[@]} > 300)) && echo "- … e mais $((${#ARQUIVOS[@]} - 300))"
      echo
      echo '</details>'
    fi
  } >>"$GITHUB_STEP_SUMMARY"
fi
exit 0
