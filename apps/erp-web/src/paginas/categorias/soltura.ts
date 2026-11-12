import {
  montarArvoreCategorias,
  PASSO_ORDEM_CATEGORIAS,
  PROFUNDIDADE_MAXIMA_CATEGORIAS,
  type CategoriaArvore,
  type CategoriaNo,
} from '@genesis/shared';

/** Onde a categoria arrastada é solta: antes ou depois de uma irmã (reordena), ou dentro de outra (muda o pai). */
export type PosicaoSoltura = 'antes' | 'dentro' | 'depois';

/**
 * O que gravar ao soltar (F2-B44; README do ERP › decisão 78): o `mover` (`POST /categorias/:id/mover`) quando o pai
 * muda e o `reordenar` (`POST /categorias/reordenar`, a lista inteira das irmãs na ordem nova) quando a posição entre
 * as irmãs importa. Dentro de outra, a categoria vai para o fim (a ordem depois da maior das filhas), sem reordenar.
 */
export interface PlanoSoltura {
  mover: { categoriaPaiId: string | null; ordem?: number } | null;
  reordenar: { categoriaPaiId: string | null; ids: string[] } | null;
}

/** As filhas de `paiId` (vazio = as raízes) na ordem da tela (ordem, depois nome), da lista plana da API. */
export function irmasNaOrdem(nos: readonly CategoriaNo[], paiId: string | null): CategoriaNo[] {
  const porId = new Map(nos.map((n) => [n.id, n]));
  const arvore = montarArvoreCategorias(nos);
  const achar = (l: CategoriaArvore[]): CategoriaArvore[] | null => {
    for (const n of l) {
      if (n.id === paiId) return n.filhas;
      const f = achar(n.filhas);
      if (f) return f;
    }
    return null;
  };
  const lista = paiId === null ? arvore : (achar(arvore) ?? []);
  return lista.map((n) => porId.get(n.id)!);
}

/** A altura da subárvore abaixo do nó (0 = sem filhas). */
function altura(nos: readonly CategoriaNo[], id: string): number {
  const filhas = nos.filter((n) => n.categoriaPaiId === id);
  return filhas.length ? 1 + Math.max(...filhas.map((f) => altura(nos, f.id))) : 0;
}

/** `ancestral` está no caminho de `id` até a raiz (ou é o próprio). */
function descendeDe(nos: readonly CategoriaNo[], id: string | null, ancestral: string): boolean {
  const porId = new Map(nos.map((n) => [n.id, n]));
  for (let atual = id; atual; atual = porId.get(atual)?.categoriaPaiId ?? null)
    if (atual === ancestral) return true;
  return false;
}

/**
 * O plano de uma soltura, as recusas que a tela já sabe (a API confere tudo de novo: o ciclo, os 5 níveis, o nome
 * entre as irmãs e a versão de cada uma) ou `null` quando nada muda (soltar no lugar em que já está).
 */
export function planejarSoltura(
  nos: readonly CategoriaNo[],
  arrastadoId: string,
  alvoId: string,
  posicao: PosicaoSoltura,
): PlanoSoltura | { erro: string } | null {
  const porId = new Map(nos.map((n) => [n.id, n]));
  const arrastado = porId.get(arrastadoId);
  const alvo = porId.get(alvoId);
  if (!arrastado || !alvo || arrastadoId === alvoId) return null;
  const novoPai = posicao === 'dentro' ? alvo.id : alvo.categoriaPaiId;
  if (novoPai && descendeDe(nos, novoPai, arrastado.id))
    return { erro: 'Não é possível mover a categoria para dentro dela mesma.' };
  const nivelPai = novoPai ? porId.get(novoPai)!.nivel : 0;
  if (nivelPai + 1 + altura(nos, arrastado.id) > PROFUNDIDADE_MAXIMA_CATEGORIAS)
    return { erro: `A árvore aceita até ${PROFUNDIDADE_MAXIMA_CATEGORIAS} níveis.` };
  const mudaPai = novoPai !== arrastado.categoriaPaiId;
  const irmas = irmasNaOrdem(nos, novoPai).filter((n) => n.id !== arrastado.id);
  if (mudaPai && irmas.some((n) => n.nome.toLowerCase() === arrastado.nome.toLowerCase()))
    return { erro: 'Já existe uma categoria com este nome neste nível.' };
  if (posicao === 'dentro') {
    if (!mudaPai) return null;
    const maior = Math.max(0, ...irmas.map((n) => n.ordem));
    return { mover: { categoriaPaiId: novoPai, ordem: maior + PASSO_ORDEM_CATEGORIAS }, reordenar: null };
  }
  const i = irmas.findIndex((n) => n.id === alvo.id) + (posicao === 'depois' ? 1 : 0);
  const ids = [...irmas.slice(0, i).map((n) => n.id), arrastado.id, ...irmas.slice(i).map((n) => n.id)];
  if (!mudaPai) {
    const atual = irmasNaOrdem(nos, novoPai).map((n) => n.id);
    if (atual.every((id, n) => id === ids[n])) return null;
  }
  return {
    mover: mudaPai ? { categoriaPaiId: novoPai } : null,
    reordenar: { categoriaPaiId: novoPai, ids },
  };
}
