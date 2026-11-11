import type { LinhaEanDuplicado, ProdutoEanDuplicado, RespostaEanDuplicado } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { EanDuplicado } from './EanDuplicado';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
const EAN_A = '7899000000010';
const EAN_B = '7899000000027';

const produto = (n: number, extra: Partial<ProdutoEanDuplicado> = {}): ProdutoEanDuplicado => ({
  codigoBarrasId: id(50 + n),
  produtoId: id(n),
  produtoCodigo: n,
  produtoNome: `CERV TESTE ${n}`,
  codigoInterno: null,
  marcaNome: null,
  ativo: true,
  variacaoId: null,
  variacaoNome: null,
  principal: true,
  descricao: null,
  fator: '1.000',
  unidadeSigla: 'UN',
  ...extra,
});

const LINHAS: LinhaEanDuplicado[] = [
  { codigo: EAN_A, quantidadeProdutos: 2, produtos: [produto(1, { codigoInterno: 'PIL-350' }), produto(2)] },
  {
    codigo: EAN_B,
    quantidadeProdutos: 2,
    produtos: [
      produto(1, { codigoBarrasId: id(60), principal: false, descricao: 'Fardo', fator: '12.000' }),
      produto(3, { ativo: false }),
    ],
  },
];

function api(opcoes: { permissoes?: string[]; resposta?: Partial<RespostaEanDuplicado> } = {}) {
  return simularApi(
    ...rotasSessao({ permissoes: opcoes.permissoes ?? ['produtos.ver', 'relatorios.exportar'] }),
    ({ url }) =>
      url.pathname === '/api/relatorios/ean-duplicado'
        ? {
            corpo: {
              itens: LINHAS,
              total: 2,
              pagina: 1,
              tamanho: 50,
              modo: 'avisar',
              ...opcoes.resposta,
            } satisfies RespostaEanDuplicado,
          }
        : undefined,
  );
}

const relatorio = (chamadas: Array<{ url: URL }>) =>
  chamadas.filter((c) => c.url.pathname === '/api/relatorios/ean-duplicado');

describe('<EanDuplicado> (MD 3.6.5; F2-B38)', () => {
  it('gera ao abrir: cada EAN com os produtos (link para editar, embalagem, inativo) e a regra de agora', async () => {
    const { chamadas } = api();
    renderizarComSessao(<EanDuplicado />, '/relatorios/ean-duplicado');
    const tabela = await screen.findByRole('table', { name: 'EAN duplicado' });
    expect([...tabela.querySelectorAll('thead th')].map((c) => c.textContent)).toEqual([
      'EAN',
      'Produtos',
      'Produtos com o EAN',
    ]);
    const linhaA = within(tabela).getByText(EAN_A).closest('tr')!;
    expect(within(linhaA).getByRole('link', { name: 'Editar 1 - CERV TESTE 1' })).toHaveAttribute(
      'href',
      `/produtos/${id(1)}`,
    );
    expect(within(linhaA).getByRole('link', { name: 'Editar 2 - CERV TESTE 2' })).toBeInTheDocument();
    expect(linhaA).toHaveTextContent('Ref. PIL-350');
    const linhaB = within(tabela).getByText(EAN_B).closest('tr')!;
    expect(linhaB).toHaveTextContent('Fardo × 12 UN');
    expect(within(linhaB).getByText('Inativo')).toBeInTheDocument();
    expect(screen.getByText('EAN repetidos')).toBeInTheDocument();
    expect(screen.getByText('Avisar')).toBeInTheDocument();
    // Sem `configuracoes.ver`, a orientação sem o link.
    expect(screen.getByText(/Quando o relatório zerar/)).toBeInTheDocument();
    // A nota vai direto no `<Text>` do `<Relatorio>` (um `<p>`), sem outro `<p>` dentro (HTML inválido).
    const nota = screen.getByTestId('nota-relatorio');
    expect(nota).toHaveTextContent(/Quando o relatório zerar/);
    expect(nota.querySelector('p')).toBeNull();
    expect(screen.queryByRole('link', { name: /Configurações › Geral/ })).toBeNull();
    expect(relatorio(chamadas)[0]!.url.searchParams.get('pagina')).toBe('1');
  });

  it('manda os filtros e a página; com configuracoes.ver, o link da chave', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api({
      permissoes: ['produtos.ver', 'configuracoes.ver'],
      resposta: { itens: [], total: 0, modo: 'bloquear' },
    });
    renderizarComSessao(<EanDuplicado />, '/relatorios/ean-duplicado');
    expect(await screen.findByText('Bloquear')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Configurações › Geral/ })).toHaveAttribute(
      'href',
      '/cadastros/configuracoes/geral',
    );
    expect(screen.getByTestId('nota-relatorio').querySelector('p')).toBeNull();
    await usuario.type(screen.getByLabelText('EAN'), '7899');
    await usuario.type(screen.getByLabelText('Produto'), 'pilsen');
    await usuario.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => {
      const ultima = relatorio(chamadas).at(-1)!.url.searchParams;
      expect(ultima.get('ean')).toBe('7899');
      expect(ultima.get('nome')).toBe('pilsen');
    });
  });
});
