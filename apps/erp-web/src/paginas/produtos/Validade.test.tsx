/**
 * Bloco Validade do produto (F2-B17; ERP 8.2.12; MD 3.6.9): os lotes gravados com a loja e o estoque só leitura (o
 * estoque não muda depois de gravado), o saldo de cada lote vindo de `saldos_lote` (`GET /produtos/:id/saldos`), o lote
 * com movimento sem "Remover", os inativos escondidos, o lote novo com a loja escolhida entre as lojas de estoque
 * permitido, o "Solicita lote no PDV" no bloco, o corpo só com o que mudou (e os excluídos à parte), o repetido com um
 * gravado sem mudança, o 422 da API na linha da grade, a cópia sem lotes e os tipos sem saldo próprio sem o bloco (e
 * sem a lista no corpo). O relógio do navegador é fixo em 05/11/2026 (o selo "vencido").
 */
import {
  alterarProdutoSchema,
  type LoteProdutoDetalhe,
  type PessoaOpcao,
  type ProdutoDetalhe,
  type SaldosProduto,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { errosParaFormulario, paraCorpo, paraValores, produtoVazio } from './valores';

// Só o Date é falso (o selo "vencido" usa a data do navegador): o userEvent e o react-query seguem com os timers reais.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const UN = '0190a000-0000-7000-8000-0000000000a1';
const LOJA1 = '0190a000-0000-7000-8000-0000000000f1';
const LOJA2 = '0190a000-0000-7000-8000-0000000000f2';
const EST1 = '0190a000-0000-7000-8000-0000000000e1';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d9';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const PERMISSOES = ['produtos.ver', 'produtos.criar', 'produtos.editar', 'pessoas.ver'];
// A Loja 2 é permitida, mas o estoque dela não (F2-B5): não entra no "Loja" do lote.
const LOJAS = [
  { id: LOJA1, codigo: 1, nome: 'Loja 1', ativa: true, estoqueId: EST1 },
  { id: LOJA2, codigo: 2, nome: 'Petiscaria 2', ativa: true, estoqueId: null },
];

const FORN: PessoaOpcao = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  codigo: 7,
  tipo: 'PJ',
  nome: 'DISTRIBUIDORA X LTDA',
  apelido: null,
  cpfCnpj: null,
  ativa: true,
  excluida: false,
};

/** Criado pelo recebimento (sem estoque), com movimento e saldo em dois tipos. */
const LOTE_A: LoteProdutoDetalhe = {
  id: '0190a000-0000-7000-8000-00000000aa01',
  estoqueId: null,
  estoqueNome: null,
  lojaNome: null,
  lote: 'L2611',
  validade: '2026-11-30',
  fabricacao: '2026-05-01',
  fornecedorId: FORN.id,
  fornecedor: FORN,
  ativo: true,
  temMovimento: true,
};
/** Digitado no cadastro para a Loja 1 (estoque "Estoque Loja 1"), já vencido e sem movimento. */
const LOTE_B: LoteProdutoDetalhe = {
  id: '0190a000-0000-7000-8000-00000000aa02',
  estoqueId: EST1,
  estoqueNome: 'Estoque Loja 1',
  lojaNome: 'Loja 1',
  lote: 'L-VELHO',
  validade: '2020-01-31',
  fabricacao: null,
  fornecedorId: null,
  fornecedor: null,
  ativo: true,
  temMovimento: false,
};
/** Antigo, inativo e com movimento: escondido até "Mostrar os inativos". */
const LOTE_C: LoteProdutoDetalhe = {
  ...LOTE_A,
  id: '0190a000-0000-7000-8000-00000000aa03',
  lote: 'L2510',
  validade: '2025-10-31',
  ativo: false,
};

const SALDOS: SaldosProduto = {
  combo: false,
  montaveis: [],
  saldos: [],
  lotes: [
    {
      loteId: LOTE_A.id,
      estoqueId: EST1,
      estoqueNome: 'Estoque Loja 1',
      tipoEstoqueId: DISPONIVEL,
      tipoEstoqueNome: 'Disponível',
      vendavel: true,
      quantidade: '12.000',
    },
    {
      loteId: LOTE_A.id,
      estoqueId: EST1,
      estoqueNome: 'Estoque Loja 1',
      tipoEstoqueId: '0190a000-0000-7000-8000-0000000000d8',
      tipoEstoqueNome: 'Avaria',
      vendavel: false,
      quantidade: '1.500',
    },
  ],
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
    criadoEm: '2026-10-30T12:00:00Z',
    atualizadoEm: '2026-10-30T12:00:00Z',
    atualizadoPorNome: 'MARIA',
    codigo: 50,
    nome: 'IOGURTE 170G',
    tipo: 'simples',
    ativo: true,
    controlaEstoque: true,
    solicitaLotePdv: false,
    unidadeId: UN,
    unidadeSigla: 'UN',
    precoCusto: null,
    custoMedio: null,
    markupPct: null,
    precoVenda: '5.0000',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    relacionados: [],
    fornecedores: [],
    lotes: [LOTE_A, LOTE_B],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    avisosCombo: [],
    temMovimento: true,
    ...extra,
  } as ProdutoDetalhe;
}

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/tipos-habilitados'
      ? { corpo: { tipos: ['simples', 'materia_prima', 'produzido', 'kit'], usaFornecedores: false } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
  ({ url }: { url: URL }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: SALDOS } : undefined),
];

const corpoDoPut = (chamadas: Array<{ metodo: string; url: URL; corpo: unknown }>, n = 0) =>
  chamadas.filter((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)[n]?.corpo as
    Record<string, unknown> | undefined;

describe('bloco Validade do produto (F2-B17; ERP 8.2.12)', () => {
  it('mostra os lotes com a loja só leitura, o saldo de cada lote e o vencido; o lote com movimento não sai', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }), ...referencias, ({ url }) =>
      url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined,
    );
    renderizar(`/produtos/${ID}`);
    // Resumo do bloco fechado: lotes e o próximo vencimento entre os ativos.
    const cabecalho = await screen.findByRole('button', { name: /^Validade/ });
    expect(cabecalho).toHaveTextContent('2 lote(s) · próximo vencimento 31/01/2020');
    await usuario.click(cabecalho);
    const tabela = await screen.findByTestId('lotes');
    const linhas = within(tabela).getAllByRole('row').slice(1);
    // O lote do recebimento vale em todas as lojas; o do cadastro mostra a loja e o estoque vinculado dela (8.2.12),
    // mesmo sem saldo. Nenhum dos dois tem o seletor.
    expect(within(linhas[0]!).getByText('Todas as lojas')).toBeInTheDocument();
    expect(within(linhas[1]!).getByText('Loja 1 · Estoque Loja 1')).toBeInTheDocument();
    expect(within(tabela).queryByLabelText(/^Loja do lote/)).toBeNull();
    // O saldo por estoque e tipo, de `saldos_lote`.
    expect(await within(linhas[0]!).findByText('Estoque Loja 1 · Disponível: 12')).toBeInTheDocument();
    expect(within(linhas[0]!).getByText('Estoque Loja 1 · Avaria: 1,5')).toBeInTheDocument();
    expect(within(linhas[1]!).getByText('Sem saldo')).toBeInTheDocument();
    // Hoje é 05/11/2026: o L-VELHO venceu, o L2611 (30/11/2026) não.
    expect(within(linhas[1]!).getByText('vencido')).toBeInTheDocument();
    expect(within(linhas[0]!).queryByText('vencido')).toBeNull();
    // A descrição do "Solicita lote no PDV" remete à chave da saída sem lote (D48), sem prometer o FEFO.
    expect(screen.getByText(/Saída sem lote de produto com lote/)).toBeInTheDocument();
    expect(within(tabela).getByLabelText('Remover o lote L2611')).toBeDisabled();
    expect(within(tabela).getByLabelText('Remover o lote L-VELHO')).toBeEnabled();
  }, 30_000);

  it('inclui um lote para a Loja 1 (só as lojas de estoque permitido), tira o vencido e manda só o que mudou', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Validade/ }));
    const tabela = await screen.findByTestId('lotes');
    await usuario.click(within(tabela).getByLabelText('Lote L-VELHO ativo'));
    await usuario.click(within(tabela).getByLabelText('Remover o lote L-VELHO'));
    await usuario.click(screen.getByLabelText('Solicita lote no PDV'));
    await usuario.click(screen.getByRole('button', { name: 'Incluir lote' }));
    await usuario.type(within(tabela).getByLabelText('Lote linha 2'), 'L2612');
    await usuario.click(within(tabela).getByLabelText('Loja do lote L2612'));
    // A Petiscaria 2 não aparece: o estoque dela está fora dos permitidos.
    expect(screen.queryByRole('option', { name: 'Petiscaria 2', hidden: true })).toBeNull();
    await usuario.click(await screen.findByRole('option', { name: 'Loja 1', hidden: true }));

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    const corpo = corpoDoPut(chamadas)!;
    expect(corpo.solicitaLotePdv).toBe(true);
    // O L2611 não mudou e não vai (a API o mantém); o L-VELHO removido vai em `lotesExcluidos`.
    expect(corpo.lotesExcluidos).toEqual([LOTE_B.id]);
    expect(corpo.lotes).toEqual([
      {
        id: null,
        estoqueId: EST1,
        lote: 'L2612',
        validade: null,
        fabricacao: null,
        fornecedorId: null,
        ativo: true,
      },
    ]);
  }, 30_000);

  it('os inativos ficam escondidos; o repetido com um gravado sem mudança é apontado na linha da grade', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ lotes: [LOTE_A, LOTE_B, LOTE_C] }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Validade/ }));
    const tabela = await screen.findByTestId('lotes');
    expect(within(tabela).queryByLabelText('Lote L2510')).toBeNull();
    await usuario.click(screen.getByLabelText('Mostrar os inativos (1)'));
    expect(within(tabela).getByLabelText('Lote L2510')).toBeInTheDocument();

    // Uma linha nova com o texto do L2611 (todas as lojas): o gravado sem mudança vai junto e o zod aponta o repetido.
    await usuario.click(screen.getByRole('button', { name: 'Incluir lote' }));
    await usuario.type(within(tabela).getByLabelText('Lote linha 4'), 'L2611');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('Lote repetido na mesma loja (linha 1)')).toBeInTheDocument();
    expect(corpoDoPut(chamadas)).toBeUndefined();
  }, 30_000);

  it('o 422 da API cai no bloco: a troca de loja na linha da grade e o lote com saldo na lista', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url, metodo }) => {
        if (url.pathname !== `/api/produtos/${ID}`) return undefined;
        if (metodo === 'PUT')
          return {
            status: 422,
            corpo: {
              codigo: 'VALIDACAO',
              mensagem: 'Verifique os lotes destacados.',
              campos: {
                // A linha 0 do corpo (só o L-VELHO mudou) é a linha 1 da grade.
                'lotes.0.estoqueId': [
                  'A loja do lote não muda depois de gravado: exclua o lote e crie outro',
                ],
                lotes: ['O lote L-ANTIGO tem saldo em estoque: não pode ser excluído (inative-o)'],
              },
            },
          };
        return { corpo: detalhe() };
      },
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Validade/ }));
    const tabela = await screen.findByTestId('lotes');
    await usuario.click(within(tabela).getByLabelText('Lote L-VELHO ativo'));
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    const linhas = within(tabela).getAllByRole('row').slice(1);
    expect(
      await within(linhas[1]!).findByText(
        'A loja do lote não muda depois de gravado: exclua o lote e crie outro',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('O lote L-ANTIGO tem saldo em estoque: não pode ser excluído (inative-o)'),
    ).toBeInTheDocument();
  }, 30_000);

  it('os tipos sem saldo próprio não têm o bloco nem mandam a lista; sem mudança o corpo não leva lotes; a cópia não leva os lotes', async () => {
    simularApi(...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }), ...referencias, ({ url }) =>
      url.pathname === `/api/produtos/${ID}`
        ? { corpo: detalhe({ tipo: 'kit', lotes: [], temMovimento: false }) }
        : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await screen.findByRole('button', { name: /^Combo \(kit\)/ });
    expect(screen.queryByRole('button', { name: /^Validade/ })).toBeNull();

    // Produzido e "Com variações" também não têm saldo próprio (TIPOS_SEM_SALDO_PROPRIO): mesmo com um lote alterado
    // (o legado de antes da troca de tipo), o corpo não leva a lista.
    for (const tipo of ['kit', 'servico', 'produzido', 'com_variacoes'] as const) {
      const v = paraValores(detalhe({ tipo }), []);
      v.lotes[0]!.validade = '2026-12-31';
      expect(paraCorpo(v), tipo).not.toHaveProperty('lotes');
    }
    expect(paraValores(detalhe(), [], true).lotes).toEqual([]);
    // Nada mudou no bloco (a troca de preço, de nome): o corpo não leva as listas, e a API mantém os lotes.
    const semMudanca = paraValores(detalhe(), []);
    semMudanca.precoVenda = '6,00';
    expect(paraCorpo(semMudanca)).not.toHaveProperty('lotes');
    expect(paraCorpo(semMudanca)).not.toHaveProperty('lotesExcluidos');
    // O erro da linha N do corpo volta para a linha da grade, e o do excluído para cima da grade.
    const mudou = paraValores(detalhe(), []);
    mudou.lotes[1]!.fabricacao = '2019-01-01';
    expect((paraCorpo(mudou).lotes as unknown[]).length).toBe(1);
    expect(
      errosParaFormulario(mudou, { 'lotes.0.fabricacao': 'x', 'lotesExcluidos.0': 'y', lotesExcluidos: 'z' }),
    ).toEqual({ 'lotes.1.fabricacao': 'x', lotes: 'y' });
  }, 30_000);

  it('com mais de 200 lotes gravados, o corpo de uma gravação passa no zod (só o que mudou vai)', () => {
    const muitos = Array.from({ length: 250 }, (_, i) => ({
      ...LOTE_A,
      id: `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      lote: `PF-${i}`,
    }));
    const v = paraValores(detalhe({ lotes: muitos }), []);
    v.precoVenda = '6,00';
    v.lotes[7]!.ativo = false;
    const corpo: Record<string, unknown> = { ...paraCorpo(v), versao: 3 };
    expect(corpo.lotes).toEqual([expect.objectContaining({ id: muitos[7]!.id, ativo: false })]);
    expect(alterarProdutoSchema.safeParse(corpo).success).toBe(true);
  });

  it('o produzido não mostra o bloco Validade', async () => {
    simularApi(...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }), ...referencias, ({ url }) =>
      url.pathname === `/api/produtos/${ID}`
        ? { corpo: detalhe({ tipo: 'produzido', usaFichaTecnica: true, temMovimento: false }) }
        : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await screen.findByRole('button', { name: /^Estoque/ });
    expect(screen.queryByRole('button', { name: /^Validade/ })).toBeNull();
  }, 30_000);
});
