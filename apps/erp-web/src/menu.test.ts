import { describe, expect, it } from 'vitest';
import { menuVisivel, podeAbrirExportacao } from './menu';

const com = (permissoes: string[]) => (chave: string) => permissoes.includes(chave);
const temExportacao = (permissoes: string[]) =>
  menuVisivel(com(permissoes))
    .flatMap((g) => g.itens)
    .some((i) => i.rota === '/produtos/exportacao');

describe('menu: Produtos › Exportação (ERP 8.5; README do ERP › decisão 74)', () => {
  it('aparece para quem exporta produtos ou clientes, com a mesma regra da tela e da API', () => {
    expect(temExportacao(['produtos.ver', 'produtos.exportar'])).toBe(true);
    // `relatorios.exportar` vale como a de exportar (ERP 3.1), com o ver do cadastro.
    expect(temExportacao(['produtos.ver', 'relatorios.exportar'])).toBe(true);
    // Só clientes (o perfil Financeiro: pessoas.ver e relatorios.exportar, sem produtos).
    expect(temExportacao(['pessoas.ver', 'relatorios.exportar'])).toBe(true);
    expect(temExportacao(['pessoas.ver', 'pessoas.exportar'])).toBe(true);
  });

  it('some sem o ver do cadastro ou sem a permissão de exportar', () => {
    expect(temExportacao(['produtos.exportar'])).toBe(false);
    expect(temExportacao(['produtos.ver'])).toBe(false);
    expect(temExportacao(['pessoas.exportar', 'relatorios.exportar'])).toBe(false);
    expect(podeAbrirExportacao(com(['produtos.ver', 'pessoas.ver']))).toBe(false);
  });
});
