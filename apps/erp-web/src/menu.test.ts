import { describe, expect, it } from 'vitest';
import { CHAVES_PERMISSOES, PERFIS_PADRAO } from '@genesis/shared';
import { MENU, menuVisivel, podeAbrirExportacao } from './menu';

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

describe('menu: Produtos › Promoções (ERP 8.8; F3-B3)', () => {
  const temPromocoes = (permissoes: Iterable<string>) => {
    const lista = [...permissoes];
    return menuVisivel(com(lista))
      .flatMap((g) => g.itens)
      .some((i) => i.rota === '/produtos/promocoes');
  };

  it('segue `promocoes.ver`, não mais `produtos.ver`', () => {
    expect(temPromocoes(['promocoes.ver'])).toBe(true);
    expect(temPromocoes(['produtos.ver'])).toBe(false);
    expect(temPromocoes(['produtos.ver', 'produtos.editar'])).toBe(false);
  });

  it('aparece para os perfis padrão que editam produtos (o que a migração 0031 garante nos personalizados)', () => {
    for (const p of PERFIS_PADRAO) {
      expect(temPromocoes(p.permissoes), p.chaveSistema).toBe(p.permissoes.includes('produtos.editar'));
    }
  });

  it('toda permissão do menu existe no catálogo', () => {
    for (const item of MENU.flatMap((g) => g.itens))
      expect(CHAVES_PERMISSOES.has(item.permissao), item.rota).toBe(true);
  });
});
