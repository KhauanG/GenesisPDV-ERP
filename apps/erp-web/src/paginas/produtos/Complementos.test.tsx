/**
 * Modal Complementos do produto (F2-B51; ERP 8.2.16; MD 3.6.8): o bloco aparece no tipo "Com complementos"; o grupo
 * "Molhos (0 a 2)" com um complemento livre e um vinculado vai no corpo do "Salvar" (junto do produto); o complemento
 * gravado só se inativa; o grupo gravado excluído pede confirmação; a regra do zod cai no campo do modal; e o
 * formulário ⇄ corpo (a cópia leva os grupos sem os ids nem os inativos). Dados inventados.
 */
import type { ProdutoDetalhe, ProdutoOpcao } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { resumoComplementos } from './Complementos';
import { FormularioProduto } from './FormularioProduto';
import { paraCorpo, paraValores, produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const KG = '0190a000-0000-7000-8000-0000000000a2';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const GRUPO = '0190a000-0000-7000-8000-0000000000d1';
const BARBECUE = '0190a000-0000-7000-8000-0000000000d2';
const COM_CHEDDAR = '0190a000-0000-7000-8000-0000000000d3';
const PERMISSOES = ['produtos.ver', 'produtos.criar', 'produtos.editar', 'produtos.ver_custo'];
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }];

const CHEDDAR: ProdutoOpcao = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  codigo: 31,
  nome: 'CHEDDAR CREMOSO',
  tipo: 'materia_prima',
  ativo: true,
  unidadeId: KG,
  unidadeSigla: 'KG',
  permiteFracao: true,
  controlaEstoque: true,
  ean: null,
  precoVenda: '0.0000',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: '40.0000',
  grupoPrecoQuantidadeId: null,
};

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

const renderizar = (url: string) =>
  renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          {
            path: '/produtos/:id/:aba?',
            element: (
              <Autenticado>
                <FormularioProduto />
              </Autenticado>
            ),
          },
        ],
      },
    ],
    url,
  );

function detalhe(extra: Partial<ProdutoDetalhe> = {}): ProdutoDetalhe {
  const v = produtoVazio([], UN);
  return {
    ...(Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]),
    ) as unknown as ProdutoDetalhe),
    id: ID,
    versao: 3,
    criadoEm: '2026-11-12T12:00:00Z',
    atualizadoEm: '2026-11-12T12:00:00Z',
    atualizadoPorNome: 'MARIA',
    codigo: 60,
    nome: 'PORÇÃO DE BATATA FRITA',
    tipo: 'com_complementos',
    ativo: true,
    controlaEstoque: true,
    unidadeId: UN,
    unidadeSigla: 'UN',
    precoCusto: '8.0000',
    custoMedio: '8.0000',
    markupPct: '273.7500',
    precoVenda: '29.9000',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    relacionados: [],
    fornecedores: [],
    lotes: [],
    imagens: [],
    gruposComplementos: [],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    avisosCombo: [],
    temMovimento: false,
    ...extra,
  } as ProdutoDetalhe;
}

const GRAVADO: ProdutoDetalhe['gruposComplementos'] = [
  {
    id: GRUPO,
    nome: 'Molhos',
    minimo: 0,
    maximo: 2,
    obrigatorio: false,
    ordem: 1,
    complementos: [
      {
        id: BARBECUE,
        produtoId: null,
        produto: null,
        descricao: 'Barbecue',
        precoAdicional: '2.0000',
        baixaEstoque: false,
        quantidadeBaixa: '1.000',
        ordem: 1,
        ativo: true,
      },
      {
        id: COM_CHEDDAR,
        produtoId: CHEDDAR.id,
        produto: CHEDDAR,
        descricao: null,
        precoAdicional: '3.5000',
        baixaEstoque: true,
        quantidadeBaixa: '0.050',
        ordem: 2,
        ativo: true,
      },
    ],
  },
];

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/tipos-habilitados'
      ? { corpo: { tipos: ['simples', 'com_complementos', 'materia_prima'], usaFornecedores: false } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
];

const corpoDoPut = (chamadas: Array<{ metodo: string; url: URL; corpo: unknown }>) =>
  chamadas.filter((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)[0]?.corpo as
    Record<string, unknown> | undefined;

describe('formulário ⇄ corpo dos complementos (F2-B51)', () => {
  it('o detalhe vira o formulário e volta no corpo com a ordem da tela; a cópia sai sem ids e sem os inativos', () => {
    const d = detalhe({
      gruposComplementos: [
        {
          ...GRAVADO[0]!,
          complementos: [
            ...GRAVADO[0]!.complementos,
            { ...GRAVADO[0]!.complementos[0]!, id: 'x', ativo: false, descricao: 'Ketchup' },
          ],
        },
      ],
    });
    const v = paraValores(d, LOJAS);
    expect(resumoComplementos(v)).toBe('1 grupo(s): Molhos (0 a 2)');
    expect(paraCorpo(v).gruposComplementos).toEqual([
      {
        id: GRUPO,
        nome: 'Molhos',
        minimo: '0',
        maximo: '2',
        obrigatorio: false,
        ordem: 1,
        complementos: [
          {
            id: BARBECUE,
            produtoId: null,
            descricao: 'Barbecue',
            precoAdicional: '2,00',
            baixaEstoque: false,
            quantidadeBaixa: '1',
            ordem: 1,
            ativo: true,
          },
          {
            id: COM_CHEDDAR,
            produtoId: CHEDDAR.id,
            descricao: null,
            precoAdicional: '3,50',
            baixaEstoque: true,
            quantidadeBaixa: '0,05',
            ordem: 2,
            ativo: true,
          },
          expect.objectContaining({ id: 'x', descricao: 'Ketchup', ativo: false, ordem: 3 }),
        ],
      },
    ]);
    const copia = paraCorpo(paraValores(d, LOJAS, true)).gruposComplementos as Array<{
      id: string | null;
      complementos: Array<{ id: string | null; descricao: string | null }>;
    }>;
    expect(copia[0]!.id).toBeNull();
    expect(copia[0]!.complementos.map((c) => [c.id, c.descricao])).toEqual([
      [null, 'Barbecue'],
      [null, null],
    ]);
    // O detalhe da API de antes do F2-B51 (sem a lista) e o produto de outro tipo: a lista vazia.
    const { gruposComplementos: _g, ...antigo } = detalhe({ tipo: 'simples' });
    expect(paraCorpo(paraValores(antigo as ProdutoDetalhe, LOJAS)).gruposComplementos).toEqual([]);
  });
});

describe('modal Complementos (F2-B51; ERP 8.2.16)', () => {
  it('a "Porção" ganha o grupo "Molhos (0 a 2)" com um livre, e o corpo do Salvar leva a lista', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Complementos/ }));
    expect(screen.getByText('Nenhum grupo de complementos.')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    const modal = await screen.findByRole('dialog', { name: 'Complementos' });
    await usuario.click(within(modal).getByRole('button', { name: 'Novo grupo' }));
    const grupo = within(modal).getByTestId('grupo-complementos-0');
    await usuario.type(within(grupo).getByLabelText(/^Grupo/), 'Molhos');
    await usuario.clear(within(grupo).getByLabelText('Máximo'));
    await usuario.type(within(grupo).getByLabelText('Máximo'), '2');
    await usuario.click(within(grupo).getByRole('button', { name: 'Inserir complemento' }));
    await usuario.type(within(grupo).getByLabelText('Descrição do complemento 1'), 'Barbecue');
    const preco = within(grupo).getByLabelText('Preço adicional Barbecue');
    await usuario.clear(preco);
    await usuario.type(preco, '2,00');
    // Sem produto vinculado, não há baixa de estoque.
    expect(within(grupo).getByLabelText('Baixa estoque Barbecue')).toBeDisabled();
    await usuario.click(within(modal).getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Complementos' })).toBeNull());
    expect(screen.getByTestId('resumo-complementos')).toHaveTextContent('Molhos (0 a 2): Barbecue +R$ 2,00');

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)!.gruposComplementos).toEqual([
      {
        id: null,
        nome: 'Molhos',
        minimo: '0',
        maximo: '2',
        obrigatorio: false,
        ordem: 1,
        complementos: [
          {
            id: null,
            produtoId: null,
            descricao: 'Barbecue',
            precoAdicional: '2,00',
            baixaEstoque: false,
            quantidadeBaixa: '1',
            ordem: 1,
            ativo: true,
          },
        ],
      },
    ]);
  }, 30_000);

  it('o complemento gravado só se inativa; o grupo gravado excluído pede confirmação', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ gruposComplementos: GRAVADO }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Complementos/ }));
    expect(screen.getByTestId('resumo-complementos')).toHaveTextContent(
      'Molhos (0 a 2): Barbecue +R$ 2,00, CHEDDAR CREMOSO +R$ 3,50',
    );
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    const modal = await screen.findByRole('dialog', { name: 'Complementos' });
    // O vinculado mostra a unidade da baixa do produto.
    expect(within(modal).getByLabelText('Quantidade da baixa CHEDDAR CREMOSO')).toHaveValue('0,05');
    await usuario.click(within(modal).getByRole('button', { name: 'Inativar Barbecue' }));
    expect(within(modal).getByLabelText('Ativo Barbecue')).not.toBeChecked();
    // O grupo gravado: a exclusão confirma (sai dos caixas com os complementos).
    await usuario.click(within(modal).getByRole('button', { name: 'Excluir o grupo Molhos' }));
    expect(await screen.findByText(/sai do cadastro e dos caixas com os 2 complemento/)).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Cancelar' }));
    await usuario.click(within(modal).getByRole('button', { name: 'Concluir' }));

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    const [g] = corpoDoPut(chamadas)!.gruposComplementos as Array<{
      id: string;
      complementos: Array<{ id: string; ativo: boolean }>;
    }>;
    expect(g!.id).toBe(GRUPO);
    expect(g!.complementos.map((c) => [c.id, c.ativo])).toEqual([
      [BARBECUE, false],
      [COM_CHEDDAR, true],
    ]);
  }, 30_000);

  it('a regra do zod (máximo menor que o mínimo) cai no campo do modal e o bloco avisa', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ gruposComplementos: GRAVADO }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Complementos/ }));
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    const modal = await screen.findByRole('dialog', { name: 'Complementos' });
    const minimo = within(modal).getByLabelText('Mínimo');
    await usuario.clear(minimo);
    await usuario.type(minimo, '3');
    await usuario.click(within(modal).getByRole('button', { name: 'Concluir' }));
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByTestId('erros-complementos')).toHaveTextContent(
      'O máximo não pode ser menor que o mínimo',
    );
    expect(corpoDoPut(chamadas)).toBeUndefined();
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    expect(
      await within(await screen.findByRole('dialog', { name: 'Complementos' })).findByText(
        'O máximo não pode ser menor que o mínimo',
      ),
    ).toBeInTheDocument();
  }, 30_000);

  it('o teto de 50 conta só os ativos: o grupo com 45 inativos gravados aceita a opção nova', async () => {
    const usuario = userEvent.setup();
    // "Sabores": 45 frutas de outras estações (inativas, gravadas) e 5 ativas.
    const frutas = (ativas: number) =>
      Array.from({ length: 50 }, (_, i) => ({
        ...GRAVADO[0]!.complementos[0]!,
        id: `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        descricao: `Fruta ${i}`,
        ordem: i + 1,
        ativo: i >= 50 - ativas,
      }));
    let ativas = 5;
    simularApi(...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }), ...referencias, ({ url }) =>
      url.pathname === `/api/produtos/${ID}`
        ? {
            corpo: detalhe({
              gruposComplementos: [{ ...GRAVADO[0]!, nome: 'Sabores', complementos: frutas(ativas) }],
            }),
          }
        : undefined,
    );
    const { unmount } = renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Complementos/ }));
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    let modal = await screen.findByRole('dialog', { name: 'Complementos' });
    expect(within(modal).getByRole('button', { name: 'Inserir complemento' })).toBeEnabled();
    unmount();

    // Com os 50 ativos, o teto trava a opção nova.
    ativas = 50;
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Complementos/ }));
    await usuario.click(screen.getByRole('button', { name: 'Complementos…' }));
    modal = await screen.findByRole('dialog', { name: 'Complementos' });
    expect(within(modal).getByRole('button', { name: 'Inserir complemento' })).toBeDisabled();
  }, 30_000);
});
