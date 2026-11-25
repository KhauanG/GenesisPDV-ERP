#!/usr/bin/env bash
# Substituído pelo scripts/acompanhar-implantacao.sh (OP-B7; D119, 25/11/2026). A sessão não cria mais a tag de pedido
# implantar/… do OP-B4 (a rede da sessão recusa escrita em git/refs na API do GitHub): o vigia da VPS implanta sozinho
# cada commit novo da main, uma vez por commit, fora das 17h à meia-noite (horário de Brasília), e publica o PDV do
# release mais novo na página de download. A tag continua valendo só como pedido manual do dono (README de
# infra/producao › Vigia da implantação).
#
#   scripts/pedir-implantacao.sh <commit da main> [--publicar-pdv] [--sem-estado] [--sem-acompanhar]
#
# Fica só para quem ainda o chama: avisa e passa o commit ao acompanhar-implantacao.sh. O --publicar-pdv e o
# --sem-estado não valem mais (o PDV o vigia publica sozinho; a volta para antes do OP-B4 o dono confere na VPS); o
# --sem-acompanhar só avisa e sai.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aviso() { printf 'ATENÇÃO: %s\n' "$*" >&2; }

aviso "o pedir-implantacao.sh não cria mais a tag de pedido (D119): o vigia da VPS implanta sozinho cada commit novo da main, fora das 17h à meia-noite (horário de Brasília). Use scripts/acompanhar-implantacao.sh <commit>."
args=()
for arg in "$@"; do
  case "$arg" in
    --publicar-pdv) aviso "--publicar-pdv ignorado: o vigia publica sozinho o PDV do release mais novo na página de download." ;;
    --sem-estado) aviso "--sem-estado ignorado: a volta para um commit anterior ao OP-B4 o dono faz e confere na VPS." ;;
    --sem-acompanhar)
      aviso "--sem-acompanhar: nada a pedir; saindo sem acompanhar."
      exit 0
      ;;
    *) args+=("$arg") ;;
  esac
done
exec bash "$RAIZ/scripts/acompanhar-implantacao.sh" "${args[@]}"
