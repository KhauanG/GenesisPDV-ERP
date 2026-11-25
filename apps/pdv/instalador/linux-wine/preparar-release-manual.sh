#!/usr/bin/env bash
# Prepara o release do PDV para o dono criar pelo site do GitHub (OP-B8, D120; README do PDV › decisão 94 e "Release
# pelo site do GitHub"): a rede da sessão recusa escrita no GitHub, então a sessão gera e confere o instalador
# (gerar-instalador.sh e testar-instalador.sh), prepara a pasta com o que o dono anexa e, depois que ele publica,
# confere o release publicado. Nada é escrito no GitHub.
#
#   apps/pdv/instalador/linux-wine/preparar-release-manual.sh X.Y.Z [--saida <pasta>] [--commit <sha>]
#       [--instalador <exe>] [--aceitar-referencia X.Y.Z]
#   apps/pdv/instalador/linux-wine/preparar-release-manual.sh X.Y.Z --conferir [--commit <sha>] [--instalador <exe>]
#       [--aceitar-referencia X.Y.Z]
#
# O preparo faz as mesmas conferências do publicar-release.sh antes de publicar (o .sha256 conferido, o .conferido do
# testar-instalador.sh e a origem do gerar-instalador.sh deste mesmo arquivo, com a árvore limpa; a URL da API de
# produção e nenhuma assinatura; a referência = o último release publicado; o commit da origin/main e o <Version> do
# Directory.Build.props dele; a tag e o release que já existam) e deixa em apps/pdv/publish/release-manual/pdv-vX.Y.Z
# (ou --saida, uma pasta nova ou vazia): GenesisPDV-Setup-X.Y.Z.exe e o .exe.sha256 (os dois a anexar),
# notas-do-release.md e PASSO-A-PASSO.txt (o roteiro do dono, com o estado do workflow "PDV release" — desligá-lo é o
# passo 1 quando ele está ligado, D71 — e o link do formulário já com a tag, o commit, o título e as notas).
# --conferir, depois que o dono publicou: a tag no commit do instalador, o release publicado sem pre-release só com os
# dois arquivos inteiros, o download público com o mesmo sha256 e o mesmo .sha256, e se a página de download já serve
# a versão (o vigia publica fora das 17h à meia-noite). Saída 1 em qualquer recusa, com o motivo.
# É o publicar-release.sh com --preparar-manual (ou --conferir-publicado); as variáveis dele valem aqui.
set -euo pipefail

aqui=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
modo=--preparar-manual
argumentos=()
for argumento in "$@"; do
  case "$argumento" in
    --conferir) modo=--conferir-publicado ;;
    -h | --ajuda)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    --preparar-manual | --conferir-publicado | --simular | --aceitar-disparo)
      echo "preparar-release-manual: opção do publicar-release.sh que não vale aqui: $argumento" >&2
      exit 1
      ;;
    *) argumentos+=("$argumento") ;;
  esac
done
exec "$aqui/publicar-release.sh" "$modo" ${argumentos[@]+"${argumentos[@]}"}
