import type { CategoriaNo } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { irmasNaOrdem, planejarSoltura } from './soltura';

const no = (id: string, nome: string, pai: string | null, nivel: number, ordem = 0): CategoriaNo => ({
  id,
  nome,
  categoriaPaiId: pai,
  caminhoNomes: nome,
  nivel,
  ordem,
  ativa: true,
  exibePdv: true,
  exibeMenuDigital: false,
  exibeTotem: false,
  exibeSite: false,
  cor: null,
  imagemArquivoId: null,
  produtos: 0,
  versao: 1,
});

// Cervejas (Lata 10, Garrafa 20), Vinhos, e "Cervejas long neck" ainda na raiz.
const NOS = [
  no('c', 'Cervejas', null, 1, 10),
  no('v', 'Vinhos', null, 1, 20),
  no('ln', 'Cervejas long neck', null, 1, 30),
  no('lt', 'Lata', 'c', 2, 10),
  no('gf', 'Garrafa', 'c', 2, 20),
];

describe('planejarSoltura (arrastar e soltar das categorias, F2-B44)', () => {
  it('dentro de outra: só o mover, para o fim das filhas', () => {
    expect(planejarSoltura(NOS, 'ln', 'c', 'dentro')).toEqual({
      mover: { categoriaPaiId: 'c', ordem: 30 },
      reordenar: null,
    });
    // Dentro da que já é o pai: nada muda.
    expect(planejarSoltura(NOS, 'lt', 'c', 'dentro')).toBeNull();
  });

  it('entre duas irmãs de outro nível: move e reordena a lista inteira do pai novo', () => {
    expect(planejarSoltura(NOS, 'ln', 'gf', 'antes')).toEqual({
      mover: { categoriaPaiId: 'c' },
      reordenar: { categoriaPaiId: 'c', ids: ['lt', 'ln', 'gf'] },
    });
    expect(planejarSoltura(NOS, 'ln', 'gf', 'depois')).toEqual({
      mover: { categoriaPaiId: 'c' },
      reordenar: { categoriaPaiId: 'c', ids: ['lt', 'gf', 'ln'] },
    });
  });

  it('entre irmãs do mesmo pai: só reordena; no mesmo lugar, nada', () => {
    expect(planejarSoltura(NOS, 'gf', 'lt', 'antes')).toEqual({
      mover: null,
      reordenar: { categoriaPaiId: 'c', ids: ['gf', 'lt'] },
    });
    expect(planejarSoltura(NOS, 'lt', 'gf', 'antes')).toBeNull();
    expect(planejarSoltura(NOS, 'v', 'c', 'antes')).toEqual({
      mover: null,
      reordenar: { categoriaPaiId: null, ids: ['v', 'c', 'ln'] },
    });
  });

  it('recusa o ciclo, os 5 níveis e o nome repetido no nível novo', () => {
    expect(planejarSoltura(NOS, 'c', 'lt', 'dentro')).toEqual({
      erro: 'Não é possível mover a categoria para dentro dela mesma.',
    });
    expect(planejarSoltura(NOS, 'c', 'gf', 'antes')).toEqual({
      erro: 'Não é possível mover a categoria para dentro dela mesma.',
    });
    const fundo = [
      no('n1', 'N1', null, 1),
      no('n2', 'N2', 'n1', 2),
      no('n3', 'N3', 'n2', 3),
      no('n4', 'N4', 'n3', 4),
      no('x', 'X', null, 1),
      no('y', 'Y', 'x', 2),
    ];
    expect(planejarSoltura(fundo, 'x', 'n4', 'dentro')).toEqual({ erro: 'A árvore aceita até 5 níveis.' });
    expect(planejarSoltura(fundo, 'y', 'n4', 'dentro')).toEqual({
      mover: { categoriaPaiId: 'n4', ordem: 10 },
      reordenar: null,
    });
    const repetido = [...NOS, no('l2', 'lata', null, 1, 40)];
    expect(planejarSoltura(repetido, 'l2', 'c', 'dentro')).toEqual({
      erro: 'Já existe uma categoria com este nome neste nível.',
    });
  });

  it('irmasNaOrdem segue a tela (ordem, depois nome)', () => {
    expect(irmasNaOrdem(NOS, null).map((n) => n.id)).toEqual(['c', 'v', 'ln']);
    expect(irmasNaOrdem(NOS, 'c').map((n) => n.id)).toEqual(['lt', 'gf']);
    expect(irmasNaOrdem(NOS, 'lt')).toEqual([]);
  });
});
