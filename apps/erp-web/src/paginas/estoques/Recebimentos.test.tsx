import {
  corpoProdutoRapido,
  type DadosCompraProdutos,
  type ProdutoDetalhe,
  type ProdutoOpcao,
  type RecebimentoDetalhe,
  type StatusRecebimento,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import {
  BLOCO_DADOS_COMPRA,
  contasDasLinhas,
  dadosCompraEmBlocos,
  errosDaLinha,
  novaLinhaRecebimento,
  precoAlterado,
  precoEMarkup,
  semResposta,
} from './recebimentoItens';
import { FormularioRecebimento, ListaRecebimentos } from './Recebimentos';
import { EspelhoRecebimento } from './RecebimentosEspelho';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d1';
const RECEBIMENTO = '0190a000-0000-7000-8000-0000000000c1';
const FORNECEDOR = '0190a000-0000-7000-8000-0000000000b1';
const FARDO = '0190a000-0000-7000-8000-0000000000a1';
const UN = '0190a000-0000-7000-8000-000000000071';
const TODAS = [
  'recebimentos.ver',
  'recebimentos.criar',
  'recebimentos.editar',
  'recebimentos.movimentar',
  'recebimentos.estornar',
  'produtos.criar',
  'produtos.ver_custo',
  'pessoas.ver',
];

const PILSEN: ProdutoOpcao = {
  id: '0190a000-0000-7000-8000-000000000011',
  codigo: 11,
  nome: 'CERV PILSEN LT 350ML',
  tipo: 'simples',
  ativo: true,
  unidadeId: 'u1',
  unidadeSigla: 'UN',
  permiteFracao: false,
  controlaEstoque: true,
  ean: '7891149103102',
  precoVenda: '8.0000',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: '4.0000',
  grupoPrecoQuantidadeId: null,
};

const DADOS: DadosCompraProdutos = {
  custoBaseMargem: 'preco_custo',
  compraAtualizaPrecoCusto: 'perguntar',
  podeAlterarPreco: true,
  produtos: [
    {
      produtoId: PILSEN.id,
      solicitaLotePdv: false,
      temLotes: false,
      embalagens: [
        { id: FARDO, codigo: '17891149103109', descricao: 'Fardo', unidadeSigla: 'FD', fator: '12.000' },
      ],
      saldo: '30.000',
      custoMedio: '4.0000',
      precoVendaLoja: null,
    },
  ],
};

const FORNECEDOR_X = {
  id: FORNECEDOR,
  codigo: 5,
  tipo: 'PJ' as const,
  nome: 'DISTRIBUIDORA X LTDA',
  apelido: null,
  cpfCnpj: '11222333000181',
  ativa: true,
  excluida: false,
};

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/estoques'
      ? {
          corpo: {
            itens: [
              {
                id: ESTOQUE,
                codigo: 1,
                nome: 'Loja 1 - Ice Beer Hermes',
                tipo: 'loja',
                lojaId: LOJA,
                lojaNome: 'Loja 1',
                ativo: true,
                versao: 1,
              },
            ],
            total: 1,
            pagina: 1,
            tamanho: 'todos',
          },
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/tipos-estoque'
      ? { corpo: [{ id: DISPONIVEL, nome: 'Disponível', vendavel: true, padrao: true, ativo: true }] }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/produtos/busca' ? { corpo: [PILSEN] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === '/api/recebimentos/dados-produtos' ? { corpo: DADOS } : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/pessoas'
      ? {
          corpo: {
            itens: [{ ...FORNECEDOR_X, categorias: ['fornecedor'] }],
            total: 1,
            pagina: 1,
            tamanho: 20,
          },
        }
      : undefined,
];

function detalhe(parcial: Partial<RecebimentoDetalhe> = {}, status: StatusRecebimento = 'rascunho') {
  const movimentado = status !== 'rascunho';
  const r: RecebimentoDetalhe = {
    id: RECEBIMENTO,
    versao: 4,
    criadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoPorNome: 'MARIA SILVA',
    codigo: 12,
    lojaId: LOJA,
    lojaNome: 'Loja 1 - Ice Beer Hermes',
    estoqueId: ESTOQUE,
    estoqueNome: 'Loja 1 - Ice Beer Hermes',
    tipoEstoqueId: DISPONIVEL,
    tipoEstoqueNome: 'Disponível',
    fornecedorId: FORNECEDOR,
    fornecedor: FORNECEDOR_X,
    dataRecebimento: '2026-11-05',
    codigoRemessa: 'NF 777',
    temValidade: false,
    observacoes: null,
    status,
    movimentadoEm: movimentado ? '2026-11-05T13:00:00.000Z' : null,
    movimentadoPorNome: movimentado ? 'MARIA SILVA' : null,
    estornadoEm: status === 'estornado' ? '2026-11-05T14:00:00.000Z' : null,
    estornadoPorNome: status === 'estornado' ? 'MARIA SILVA' : null,
    motivoEstorno: status === 'estornado' ? 'Lançado em duplicidade' : null,
    qtdItens: 1,
    valorProdutos: '600.00',
    valorFrete: '12.00',
    valorDesconto: '0.00',
    valorOutrasDespesas: '0.00',
    valorTotal: '612.00',
    itens: [
      {
        id: 'i1',
        sequencia: 1,
        produtoId: PILSEN.id,
        produto: PILSEN,
        codigoBarrasId: FARDO,
        codigoBarras: '17891149103109',
        unidadeCompra: 'FD',
        fator: '12.000',
        quantidade: '10.000',
        quantidadeEstoque: '120.000',
        precoCompra: '60.0000',
        markupPct: '74.5098',
        precoVenda: '8.9000',
        atualizarPreco: 'geral',
        lote: null,
        validade: null,
        fabricacao: null,
        loteId: null,
        rateioFrete: movimentado ? '12.00' : '0.00',
        rateioDesconto: '0.00',
        rateioOutras: '0.00',
        custoUnitarioFinal: movimentado ? '5.1000' : '0.0000',
        valorTotal: '600.00',
      },
    ],
    remessaRepetida: [],
    avisos: [],
    ...parcial,
  };
  return r;
}

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

function renderizar(url: string) {
  const comSessao = (e: ReactNode) => <Autenticado>{e}</Autenticado>;
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          { path: '/estoque/recebimentos', element: comSessao(<ListaRecebimentos />) },
          { path: '/estoque/recebimentos/novo', element: comSessao(<FormularioRecebimento />) },
          { path: '/estoque/recebimentos/:id/espelho', element: comSessao(<EspelhoRecebimento />) },
          { path: '/estoque/recebimentos/:id', element: comSessao(<FormularioRecebimento />) },
        ],
      },
    ],
    url,
  );
}

const sessao = (permissoes = TODAS) =>
  rotasSessao({
    permissoes,
    lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
  });

const seletor = (rotulo: RegExp) => screen.getByRole('combobox', { name: rotulo });

async function escolherProduto(usuario: ReturnType<typeof userEvent.setup>, linha: number, busca: string) {
  const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
  await usuario.type(within(grade).getByLabelText(`Produto ou código de barras da linha ${linha}`), busca);
  await usuario.click(
    await screen.findByRole('option', { name: '11 - CERV PILSEN LT 350ML', hidden: true }, { timeout: 3000 }),
  );
  return grade;
}

describe('contas da grade (F2-B16)', () => {
  const cab = { valorFrete: '12,00', valorDesconto: '', valorOutrasDespesas: '', temValidade: false };
  const fardo = {
    ...novaLinhaRecebimento(),
    produto: PILSEN,
    codigoBarrasId: FARDO,
    fator: '12',
    quantidade: '10',
    precoCompra: '60,00',
    precoVenda: '8,00',
  };

  it('rateio e custo final como a movimentação: 10 FD × 12 a R$ 60,00 + R$ 12,00 = R$ 5,10', () => {
    const c = contasDasLinhas([fardo], cab).get(fardo.chave)!;
    expect(c).toEqual({
      quantidadeEstoque: '120.000',
      valorTotal: '600.00',
      rateio: '12.00',
      custoFinal: '5.1000',
    });
    // Markup do preço atual (R$ 8,00) sobre o custo da compra; digitado, o markup refaz o preço.
    expect(precoEMarkup(fardo, c, DADOS, DADOS.produtos[0])).toMatchObject({
      base: '5.1000',
      precoVenda: '8.0000',
      markupPct: '56.8627',
    });
    expect(precoEMarkup({ ...fardo, markup: '50' }, c, DADOS, DADOS.produtos[0]).precoVenda).toBe('7.65');
  });

  it('lote e validade obrigatórios com "Tem prazo de validade" ou o produto que pede lote', () => {
    expect(errosDaLinha(fardo, cab, DADOS.produtos[0])).toEqual({});
    expect(errosDaLinha(fardo, { ...cab, temValidade: true }, DADOS.produtos[0])).toEqual({
      lote: 'Informe o lote',
      validade: 'Informe a validade',
    });
    expect(
      errosDaLinha({ ...fardo, lote: 'L1', validade: '31/02/2027' }, cab, {
        ...DADOS.produtos[0]!,
        solicitaLotePdv: true,
      }),
    ).toEqual({ validade: 'Data inválida (dd/mm/aaaa)' });
    expect(errosDaLinha({ ...fardo, quantidade: '0', fator: '' }, cab, undefined)).toMatchObject({
      quantidade: 'Quantidade maior que zero',
      fator: 'Fator maior que zero',
    });
  });
});

describe('preço da loja, "não" gravado e consulta em blocos (F2-B16)', () => {
  const linha = { ...novaLinhaRecebimento(), produto: PILSEN, precoVenda: '8,50' };
  const daLoja = { ...DADOS.produtos[0]!, precoVendaLoja: '8.5000' };

  it('o preço atual é o da loja destinatária quando ela tem preço próprio (como o movimentar compara o "só da loja")', () => {
    // Geral R$ 8,00, loja R$ 8,50: repetir o da loja não é alteração; o geral, na loja com preço próprio, é.
    expect(precoAlterado(linha, '8.5000', daLoja)).toBe(false);
    expect(precoAlterado(linha, '8.0000', daLoja)).toBe(true);
    // A loja que segue o geral (ou sem os dados): a referência é o geral.
    expect(precoAlterado(linha, '8.0000', DADOS.produtos[0])).toBe(false);
    expect(precoAlterado(linha, '8.5000', undefined)).toBe(true);
  });

  it('editar o preço ou o markup volta o "não" a "sem resposta"; geral e só da loja ficam', () => {
    expect(semResposta({ ...linha, atualizarPreco: 'nao' })).toBeNull();
    expect(semResposta({ ...linha, atualizarPreco: 'geral' })).toBe('geral');
    expect(semResposta({ ...linha, atualizarPreco: 'loja' })).toBe('loja');
  });

  it('mais produtos que o teto da consulta: blocos de até 100 ids, os produtos juntados', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const pedidos: string[][] = [];
    const r = await dadosCompraEmBlocos(ids, async (bloco) => {
      pedidos.push(bloco);
      return { ...DADOS, produtos: bloco.map((id) => ({ ...DADOS.produtos[0]!, produtoId: id })) };
    });
    expect(pedidos.map((b) => b.length)).toEqual([BLOCO_DADOS_COMPRA, BLOCO_DADOS_COMPRA, 50]);
    expect(r.custoBaseMargem).toBe('preco_custo');
    expect(r.produtos.map((p) => p.produtoId)).toEqual(ids);
    // Um bloco que falha derruba a consulta (a tela avisa e não grava).
    await expect(
      dadosCompraEmBlocos(ids, async (bloco) => {
        if (bloco[0] === 'p100') throw new Error('422');
        return DADOS;
      }),
    ).rejects.toThrow('422');
  });
});

describe('Recebimento manual (ERP 13.3; F2-B16)', () => {
  it('novo: o EAN do fardo preenche embalagem e fator, rateio e custo final, markup ⇄ preço, a pergunta do preço e o corpo', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/recebimentos'
        ? { status: 201, corpo: detalhe() }
        : undefined,
    );
    renderizar('/estoque/recebimentos/novo');
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await waitFor(() => expect(seletor(/^Estoque de destino/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    expect(seletor(/^Tipo de estoque/)).toHaveValue('Disponível');
    expect(seletor(/^Loja/)).toHaveValue('1 - Loja 1 - Ice Beer Hermes');
    await usuario.type(seletor(/^Fornecedor/), 'distri');
    await usuario.click(await screen.findByRole('option', { name: /DISTRIBUIDORA X LTDA/, hidden: true }));
    await usuario.type(screen.getByRole('textbox', { name: /^Frete/ }), '12,00');
    // O código do fardo lido no campo Produto.
    const grade = await escolherProduto(usuario, 1, '17891149103109');
    await waitFor(() => expect(within(grade).getByLabelText('Embalagem da linha 1')).toHaveValue(FARDO));
    expect(within(grade).getByText('12')).toBeInTheDocument();
    expect(within(grade).getByLabelText('Quant. da linha 1')).toHaveValue('1');
    await usuario.clear(within(grade).getByLabelText('Quant. da linha 1'));
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '10');
    await usuario.type(within(grade).getByLabelText('Preço compra da linha 1'), '60,00');
    expect(within(grade).getByText('120 UN')).toBeInTheDocument();
    expect(within(grade).getByText('R$ 600,00')).toBeInTheDocument();
    expect(within(grade).getByText('R$ 12,00')).toBeInTheDocument();
    expect(within(grade).getByText('R$ 5,1')).toBeInTheDocument();
    // O preço atual (R$ 8,00) com o markup sobre o custo final; o markup digitado refaz o preço.
    expect(within(grade).getByLabelText('Preço venda da linha 1')).toHaveValue('8');
    expect(within(grade).getByLabelText('Markup % da linha 1')).toHaveValue('56,86');
    await usuario.clear(within(grade).getByLabelText('Markup % da linha 1'));
    await usuario.type(within(grade).getByLabelText('Markup % da linha 1'), '50');
    expect(within(grade).getByLabelText('Preço venda da linha 1')).toHaveValue('7,65');
    expect(screen.getByTestId('totais-recebimento')).toHaveTextContent('Total geral: R$ 612,00');
    // O preço mudou: o Salvar pergunta geral/loja/não.
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    const pergunta = await screen.findByRole('dialog', { name: 'Atualizar o preço de venda?' });
    await usuario.click(within(pergunta).getByRole('button', { name: 'Atualizar preço geral' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos')).toBe(true),
    );
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos')!;
    expect(post.corpo).toMatchObject({
      lojaId: LOJA,
      estoqueId: ESTOQUE,
      tipoEstoqueId: DISPONIVEL,
      fornecedorId: FORNECEDOR,
      valorFrete: '12,00',
      itens: [
        {
          id: null,
          produtoId: PILSEN.id,
          codigoBarrasId: FARDO,
          fator: '12',
          quantidade: '10',
          precoCompra: '60,00',
          markupPct: '50.0000',
          precoVenda: '7.65',
          atualizarPreco: 'geral',
        },
      ],
    });
  }, 30_000);

  it('"Salvar e movimentar": confirma, pergunta o preço de custo (D49) e movimenta com a resposta', async () => {
    const usuario = userEvent.setup();
    let pergunta = true;
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: detalhe() }
          : undefined,
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/recebimentos/${RECEBIMENTO}/movimentar`)
          return undefined;
        if (pergunta) {
          pergunta = false;
          return {
            status: 422,
            corpo: {
              codigo: 'REGRA_NEGOCIO',
              mensagem: 'O custo desta compra é diferente do preço de custo de 1 produto(s).',
              campos: { atualizarPrecoCusto: ['Atualizar o preço de custo?'] },
              detalhes: {
                precosCusto: [{ produtoId: PILSEN.id, nome: PILSEN.nome, atual: '4.0000', novo: '5.1000' }],
              },
            },
          };
        }
        return { corpo: detalhe({}, 'movimentado') };
      },
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    await usuario.click(await screen.findByRole('button', { name: 'Salvar e movimentar' }));
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    const modal = await screen.findByRole('dialog', { name: 'Atualizar o preço de custo?' });
    expect(within(modal).getByText('R$ 4')).toBeInTheDocument();
    expect(within(modal).getByText('R$ 5,1')).toBeInTheDocument();
    await usuario.click(within(modal).getByRole('button', { name: 'Sim, atualizar' }));
    expect(await screen.findByText('Recebimento movimentado: estoque atualizado')).toBeInTheDocument();
    const movimentos = chamadas.filter((c) => c.url.pathname.endsWith('/movimentar'));
    // Sem alteração, não regrava: só os dois movimentar (sem resposta e com "Sim").
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
    expect(movimentos.map((c) => c.corpo)).toEqual([
      { versao: 4, atualizarPrecoCusto: null },
      { versao: 4, atualizarPrecoCusto: true },
    ]);
    expect(await screen.findByText(/o documento não muda mais \(use Estornar\)/)).toBeInTheDocument();
  }, 30_000);

  it('botões por situação e permissão; Estornar com motivo; aviso de remessa repetida', async () => {
    const usuario = userEvent.setup();
    const repetida = detalhe(
      {
        remessaRepetida: [{ id: 'r9', codigo: 9, dataRecebimento: '2026-11-01', status: 'movimentado' }],
        avisos: ['O Cód. remessa "NF 777" já foi usado para este fornecedor (recebimento Nº 9).'],
      },
      'movimentado',
    );
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: repetida }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/recebimentos/${RECEBIMENTO}/estornar`
          ? { corpo: detalhe({}, 'estornado') }
          : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    expect(await screen.findByTestId('remessa-repetida')).toHaveTextContent('já foi usado');
    expect(screen.getByRole('link', { name: /Nº 9/ })).toBeInTheDocument();
    // Movimentado: os valores gravados, sem Salvar e movimentar nem Excluir.
    const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
    expect(within(grade).getByText('R$ 5,1')).toBeInTheDocument();
    expect(within(grade).getByText('FD × 12')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar e movimentar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Imprimir' })).toBeEnabled();
    await usuario.click(screen.getByRole('button', { name: 'Estornar' }));
    const modal = await screen.findByRole('dialog', { name: 'Estornar recebimento' });
    const confirmar = within(modal).getByRole('button', { name: 'Estornar' });
    expect(confirmar).toBeDisabled();
    await usuario.type(within(modal).getByLabelText(/Motivo do estorno/), 'Lançado em duplicidade');
    await usuario.click(confirmar);
    expect(await screen.findByText('Recebimento estornado')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/estornar'))!.corpo).toEqual({
      versao: 4,
      motivo: 'Lançado em duplicidade',
      confirmarNegativo: [],
    });
  }, 30_000);

  it('estorno que deixa saldo negativo (D56 com aviso): mostra a lista e só estorna confirmando a lista de agora', async () => {
    const usuario = userEvent.setup();
    const linha = {
      produtoId: PILSEN.id,
      nome: PILSEN.nome,
      lote: null,
      saldoAtual: '20.000',
      saldoFinal: '-100.000',
    };
    const lote = {
      produtoId: PILSEN.id,
      nome: PILSEN.nome,
      lote: 'L-77',
      saldoAtual: '5.000',
      saldoFinal: '-7.000',
    };
    // Depois da primeira pergunta, uma venda sincroniza: a linha fica mais negativa e a API pergunta de novo.
    const linhaDepois = { ...linha, saldoAtual: '18.000', saldoFinal: '-102.000' };
    const pergunta = (saldosNegativos: unknown[], mudou: boolean) => ({
      status: 422,
      corpo: {
        codigo: 'REGRA_NEGOCIO',
        mensagem: 'O saldo ficará negativo em: CERV PILSEN LT 350ML (saldo 20 → -100).',
        campos: {
          confirmarNegativo: [
            mudou
              ? 'O saldo mudou desde a confirmação: confira a lista e confirme de novo.'
              : 'O saldo ficará negativo: confirme o estorno.',
          ],
        },
        detalhes: { saldosNegativos },
      },
    });
    let chamada = 0;
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: detalhe({}, 'movimentado') }
          : undefined,
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/recebimentos/${RECEBIMENTO}/estornar`)
          return undefined;
        chamada += 1;
        if (chamada === 1) return pergunta([linha, lote], false);
        if (chamada === 2) return pergunta([linhaDepois, lote], true);
        return { corpo: detalhe({}, 'estornado') };
      },
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    await usuario.click(screen.getByRole('button', { name: 'Estornar' }));
    const modal = await screen.findByRole('dialog', { name: 'Estornar recebimento' });
    await usuario.type(within(modal).getByLabelText(/Motivo do estorno/), 'Nota devolvida');
    await usuario.click(within(modal).getByRole('button', { name: 'Estornar' }));
    expect(await within(modal).findByText('O saldo ficará negativo em:')).toBeInTheDocument();
    expect(within(modal).getByText(/CERV PILSEN LT 350ML: de 20 para -100/)).toBeInTheDocument();
    expect(within(modal).getByText(/CERV PILSEN LT 350ML \(lote L-77\): de 5 para -7/)).toBeInTheDocument();
    expect(within(modal).queryByTestId('negativo-mudou')).not.toBeInTheDocument();
    expect(screen.queryByText('Recebimento estornado')).not.toBeInTheDocument();
    await usuario.click(within(modal).getByRole('button', { name: 'Estornar mesmo assim' }));
    // A lista mudou: a tela mostra a de agora e pede a confirmação de novo.
    expect(await within(modal).findByTestId('negativo-mudou')).toHaveTextContent('confirme de novo');
    expect(within(modal).getByText(/CERV PILSEN LT 350ML: de 18 para -102/)).toBeInTheDocument();
    expect(screen.queryByText('Recebimento estornado')).not.toBeInTheDocument();
    await usuario.click(within(modal).getByRole('button', { name: 'Estornar mesmo assim' }));
    expect(await screen.findByText('Recebimento estornado')).toBeInTheDocument();
    // Cada confirmação é a lista que estava na tela (não um "sim" geral).
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/estornar')).map((c) => c.corpo)).toEqual([
      { versao: 4, motivo: 'Nota devolvida', confirmarNegativo: [] },
      { versao: 4, motivo: 'Nota devolvida', confirmarNegativo: [linha, lote] },
      { versao: 4, motivo: 'Nota devolvida', confirmarNegativo: [linhaDepois, lote] },
    ]);
  }, 30_000);

  it('estorno que deixa saldo negativo sem a permissão: a recusa aparece e não há confirmação', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: detalhe({}, 'movimentado') }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/recebimentos/${RECEBIMENTO}/estornar`
          ? {
              status: 422,
              corpo: {
                codigo: 'REGRA_NEGOCIO',
                mensagem: 'O estorno deixaria saldo negativo em: CERV PILSEN LT 350ML (saldo 20).',
                detalhes: {
                  saldosNegativos: [
                    {
                      produtoId: PILSEN.id,
                      nome: PILSEN.nome,
                      lote: null,
                      saldoAtual: '20.000',
                      saldoFinal: '-100.000',
                    },
                  ],
                },
              },
            }
          : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    await usuario.click(screen.getByRole('button', { name: 'Estornar' }));
    const modal = await screen.findByRole('dialog', { name: 'Estornar recebimento' });
    await usuario.type(within(modal).getByLabelText(/Motivo do estorno/), 'Nota devolvida');
    await usuario.click(within(modal).getByRole('button', { name: 'Estornar' }));
    expect(await screen.findByText(/O estorno deixaria saldo negativo em/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Estornar mesmo assim' })).not.toBeInTheDocument();
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/estornar'))).toHaveLength(1);
  }, 30_000);

  it('sem movimentar nem estornar: só o rascunho editável, sem os botões', async () => {
    simularApi(...sessao(['recebimentos.ver', 'recebimentos.editar']), ...referencias, ({ url, metodo }) =>
      metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
        ? { corpo: detalhe() }
        : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    expect(await screen.findByRole('button', { name: 'Salvar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar e movimentar' })).not.toBeInTheDocument();
    // Sem `produtos.criar`, sem o cadastro rápido.
    expect(screen.queryByRole('button', { name: 'Cadastrar novo produto' })).not.toBeInTheDocument();
  }, 20_000);

  it('cadastro rápido de produto: cria um Simples pelo POST /produtos e o põe na grade', async () => {
    const usuario = userEvent.setup();
    const novo = {
      ...PILSEN,
      id: '0190a000-0000-7000-8000-000000000099',
      codigo: 99,
      nome: 'CERV NOVA 350ML',
    };
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url }) =>
        url.pathname === '/api/referencias/unidades'
          ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/produtos'
          ? {
              status: 201,
              corpo: {
                ...novo,
                custoMedio: null,
                markupPct: null,
                codigosBarras: [],
              } as unknown as ProdutoDetalhe,
            }
          : undefined,
    );
    renderizar('/estoque/recebimentos/novo');
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await usuario.click(screen.getByRole('button', { name: 'Cadastrar novo produto' }));
    const modal = await screen.findByRole('dialog', { name: 'Cadastrar novo produto' });
    await waitFor(() =>
      expect(within(modal).getByRole('combobox', { name: /^Unidade/ })).toHaveValue('UN - Unidade'),
    );
    await usuario.type(within(modal).getByLabelText(/^Nome/), 'CERV NOVA 350ML');
    await usuario.type(within(modal).getByLabelText(/^Código de barras/), '7891000001233');
    await usuario.type(within(modal).getByLabelText(/^Preço de venda/), '4,99');
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos')).toBe(true),
    );
    // O corpo inteiro é o do shared (`corpoProdutoRapido`), o mesmo que o teste de integração do critério de pronto manda.
    const corpoProduto = chamadas.find(
      (c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos',
    )!.corpo;
    expect(corpoProduto).toEqual(
      corpoProdutoRapido({
        nome: 'CERV NOVA 350ML',
        ean: '7891000001233',
        unidadeId: UN,
        unidadePermiteFracao: false,
        ncm: null,
        marcaId: null,
        categoriaId: null,
        precoVenda: '4,99',
      }),
    );
    expect(corpoProduto).toMatchObject({
      tipo: 'simples',
      permiteFracao: false,
      codigosBarras: [{ codigo: '7891000001233', principal: true }],
    });
    const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
    await waitFor(() =>
      expect(within(grade).getByLabelText('Produto ou código de barras da linha 1')).toHaveValue(
        '99 - CERV NOVA 350ML',
      ),
    );
  }, 30_000);

  it('rascunho com "não" gravado e o preço diferente do atual: "Salvar e movimentar" sem pergunta e sem regravar', async () => {
    const usuario = userEvent.setup();
    const comNao = detalhe({
      itens: [{ ...detalhe().itens[0]!, precoVenda: '8.2500', markupPct: '61.7647', atualizarPreco: 'nao' }],
    });
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: comNao }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/recebimentos/${RECEBIMENTO}/movimentar`
          ? { corpo: detalhe({}, 'movimentado') }
          : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
    // O "não" gravado volta como "não" (antes voltava a "sem resposta" e a pergunta reaparecia).
    expect(within(grade).getByLabelText('Atualizar preço da linha 1')).toHaveValue('nao');
    const botao = await screen.findByRole('button', { name: 'Salvar e movimentar' });
    await waitFor(() => expect(botao).toBeEnabled());
    await usuario.click(botao);
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    expect(await screen.findByText('Recebimento movimentado: estoque atualizado')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Atualizar o preço de venda?' })).not.toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
  }, 30_000);

  it('editar o preço da linha com "não" gravado faz o Salvar perguntar de novo', async () => {
    const usuario = userEvent.setup();
    const comNao = detalhe({
      itens: [{ ...detalhe().itens[0]!, precoVenda: '8.0000', markupPct: '56.8627', atualizarPreco: 'nao' }],
    });
    simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}` ? { corpo: comNao } : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
    await waitFor(() =>
      expect(within(grade).getByLabelText('Atualizar preço da linha 1')).toHaveValue('nao'),
    );
    await usuario.clear(within(grade).getByLabelText('Preço venda da linha 1'));
    await usuario.type(within(grade).getByLabelText('Preço venda da linha 1'), '8,90');
    expect(within(grade).getByLabelText('Atualizar preço da linha 1')).toHaveValue('');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('dialog', { name: 'Atualizar o preço de venda?' })).toBeInTheDocument();
  }, 30_000);

  it('só "movimentar" (sem editar): o rascunho somente leitura movimenta com o que está gravado, sem pergunta nem PUT', async () => {
    const usuario = userEvent.setup();
    const comNao = detalhe({
      itens: [{ ...detalhe().itens[0]!, precoVenda: '8.2500', markupPct: null, atualizarPreco: 'nao' }],
    });
    const { chamadas } = simularApi(
      ...sessao(['recebimentos.ver', 'recebimentos.movimentar']),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: comNao }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/recebimentos/${RECEBIMENTO}/movimentar`
          ? { corpo: detalhe({}, 'movimentado') }
          : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
    await usuario.click(await screen.findByRole('button', { name: 'Salvar e movimentar' }));
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    expect(await screen.findByText('Recebimento movimentado: estoque atualizado')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Atualizar o preço de venda?' })).not.toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/movimentar')).map((c) => c.corpo)).toEqual([
      { versao: 4, atualizarPrecoCusto: null },
    ]);
  }, 30_000);

  it('novo: o movimentar recusado deixa a tela no rascunho gravado, e a nova tentativa não cria outro rascunho', async () => {
    const usuario = userEvent.setup();
    let recusar = true;
    const { chamadas, router } = (() => {
      const api = simularApi(
        ...sessao(),
        ...referencias,
        ({ url, metodo }) =>
          metodo === 'POST' && url.pathname === '/api/recebimentos'
            ? { status: 201, corpo: detalhe() }
            : undefined,
        ({ url, metodo }) =>
          metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
            ? { corpo: detalhe() }
            : undefined,
        ({ url, metodo }) => {
          if (metodo !== 'POST' || url.pathname !== `/api/recebimentos/${RECEBIMENTO}/movimentar`)
            return undefined;
          if (recusar) {
            recusar = false;
            return {
              status: 403,
              corpo: {
                codigo: 'SEM_PERMISSAO',
                mensagem: 'Alterar preço no ERP exige "Produtos: Alterar preço".',
                campos: { 'itens.0.precoVenda': ['Alterar preço no ERP exige "Produtos: Alterar preço"'] },
              },
            };
          }
          return { corpo: detalhe({}, 'movimentado') };
        },
      );
      return { ...api, ...renderizar('/estoque/recebimentos/novo') };
    })();
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await waitFor(() => expect(seletor(/^Estoque de destino/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    await usuario.type(seletor(/^Fornecedor/), 'distri');
    await usuario.click(await screen.findByRole('option', { name: /DISTRIBUIDORA X LTDA/, hidden: true }));
    const grade = await escolherProduto(usuario, 1, 'pilsen');
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '10');
    await usuario.type(within(grade).getByLabelText('Preço compra da linha 1'), '5,00');
    const botao = screen.getByRole('button', { name: 'Salvar e movimentar' });
    await waitFor(() => expect(botao).toBeEnabled());
    await usuario.click(botao);
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    expect(
      await screen.findByText(/exige "Produtos: Alterar preço"/, { selector: '[role="alert"] *' }),
    ).toBeInTheDocument();
    // O rascunho gravado passa a ser a tela, mesmo com o movimentar recusado.
    await waitFor(() => expect(router.state.location.pathname).toBe(`/estoque/recebimentos/${RECEBIMENTO}`));
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    await usuario.click(await screen.findByRole('button', { name: 'Salvar e movimentar' }));
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    expect(await screen.findByText('Recebimento movimentado: estoque atualizado')).toBeInTheDocument();
    expect(
      chamadas.filter((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos'),
    ).toHaveLength(1);
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/movimentar'))).toHaveLength(2);
  }, 30_000);

  it('a loja com preço próprio: a proposta é o preço dela, e mudar avisa que o geral não vale nela', async () => {
    const usuario = userEvent.setup();
    const daLoja: DadosCompraProdutos = {
      ...DADOS,
      produtos: [{ ...DADOS.produtos[0]!, precoVendaLoja: '8.5000' }],
    };
    const { chamadas } = simularApi(
      ...sessao(),
      ({ url }) => (url.pathname === '/api/recebimentos/dados-produtos' ? { corpo: daLoja } : undefined),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/recebimentos'
          ? { status: 201, corpo: detalhe() }
          : undefined,
    );
    renderizar('/estoque/recebimentos/novo');
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await waitFor(() => expect(seletor(/^Estoque de destino/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    const grade = await escolherProduto(usuario, 1, 'pilsen');
    await waitFor(() => expect(within(grade).getByLabelText('Preço venda da linha 1')).toHaveValue('8,5'));
    // A consulta leva a loja destinatária.
    expect(
      chamadas
        .find((c) => c.url.pathname === '/api/recebimentos/dados-produtos')!
        .url.searchParams.get('lojaId'),
    ).toBe(LOJA);
    // O preço da loja mantido não é alteração.
    expect(within(grade).getByLabelText('Atualizar preço da linha 1')).toHaveDisplayValue('—');
    await usuario.clear(within(grade).getByLabelText('Preço venda da linha 1'));
    await usuario.type(within(grade).getByLabelText('Preço venda da linha 1'), '9');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    const pergunta = await screen.findByRole('dialog', { name: 'Atualizar o preço de venda?' });
    expect(within(pergunta).getByTestId('aviso-preco-da-loja')).toHaveTextContent('preço próprio nesta loja');
  }, 30_000);

  it('sem poder mudar o preço ("Altera Preço do Produto no ERP" desligada, sem a permissão): sem a pergunta e com "Não"', async () => {
    const usuario = userEvent.setup();
    const semPreco: DadosCompraProdutos = { ...DADOS, podeAlterarPreco: false };
    const { chamadas } = simularApi(
      ...sessao(),
      ({ url }) => (url.pathname === '/api/recebimentos/dados-produtos' ? { corpo: semPreco } : undefined),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/recebimentos'
          ? { status: 201, corpo: detalhe() }
          : undefined,
    );
    renderizar('/estoque/recebimentos/novo');
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await waitFor(() => expect(seletor(/^Estoque de destino/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    await usuario.type(seletor(/^Fornecedor/), 'distri');
    await usuario.click(await screen.findByRole('option', { name: /DISTRIBUIDORA X LTDA/, hidden: true }));
    const grade = await escolherProduto(usuario, 1, 'pilsen');
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '10');
    await usuario.type(within(grade).getByLabelText('Preço compra da linha 1'), '5,00');
    // Preço, markup e "Atualizar preço" só leitura: o preço atual fica e não há o que perguntar.
    await waitFor(() =>
      expect(within(grade).queryByLabelText('Preço venda da linha 1')).not.toBeInTheDocument(),
    );
    expect(within(grade).queryByLabelText('Markup % da linha 1')).not.toBeInTheDocument();
    expect(within(grade).queryByLabelText('Atualizar preço da linha 1')).not.toBeInTheDocument();
    expect(within(grade).getByText('R$ 8')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos')).toBe(true),
    );
    expect(screen.queryByRole('dialog', { name: 'Atualizar o preço de venda?' })).not.toBeInTheDocument();
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos')!;
    expect(post.corpo).toMatchObject({ itens: [{ produtoId: PILSEN.id, atualizarPreco: 'nao' }] });
  }, 30_000);

  it('sem poder mudar o preço, o rascunho gravado com "geral" por quem podia: aviso, "Não atualizar" na linha, regrava com "Não" e movimenta', async () => {
    const usuario = userEvent.setup();
    const semPreco: DadosCompraProdutos = { ...DADOS, podeAlterarPreco: false };
    // A linha gravada com "geral" e o preço 8,90 (o atual é 8,00); o id é um UUID (o PUT valida o corpo).
    const linha = { ...detalhe().itens[0]!, id: '0190a000-0000-7000-8000-0000000000c2' };
    const gravado = detalhe({ itens: [linha] });
    const { chamadas } = simularApi(
      ...sessao(),
      ({ url }) => (url.pathname === '/api/recebimentos/dados-produtos' ? { corpo: semPreco } : undefined),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: gravado }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'PUT' && url.pathname === `/api/recebimentos/${RECEBIMENTO}`
          ? { corpo: detalhe({ versao: 5, itens: [{ ...linha, atualizarPreco: 'nao' }] }) }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/recebimentos/${RECEBIMENTO}/movimentar`
          ? { corpo: detalhe({}, 'movimentado') }
          : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}`);
    await screen.findByRole('heading', { name: 'Recebimento Nº 12' });
    expect(await screen.findByTestId('preco-descartado')).toHaveTextContent('"Produtos: Alterar preço"');
    const grade = screen.getByRole('table', { name: 'Itens do recebimento' });
    expect(within(grade).queryByLabelText('Atualizar preço da linha 1')).not.toBeInTheDocument();
    expect(within(grade).getByText('Não atualizar')).toBeInTheDocument();
    expect(within(grade).queryByText('Atualizar preço geral')).not.toBeInTheDocument();
    const botao = await screen.findByRole('button', { name: 'Salvar e movimentar' });
    await waitFor(() => expect(botao).toBeEnabled());
    await usuario.click(botao);
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    expect(await screen.findByText('Recebimento movimentado: estoque atualizado')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Atualizar o preço de venda?' })).not.toBeInTheDocument();
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(put.corpo).toMatchObject({ versao: 4, itens: [{ produtoId: PILSEN.id, atualizarPreco: 'nao' }] });
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/movimentar')).map((c) => c.corpo)).toEqual([
      { versao: 5, atualizarPrecoCusto: null },
    ]);
  }, 30_000);

  it('os dados de compra não carregam: o aviso com "Tentar de novo" e o Salvar não grava', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(),
      ({ url }) =>
        url.pathname === '/api/recebimentos/dados-produtos'
          ? { status: 422, corpo: { codigo: 'VALIDACAO', mensagem: 'Dados inválidos.' } }
          : undefined,
      ...referencias,
    );
    renderizar('/estoque/recebimentos/novo');
    await screen.findByRole('heading', { name: 'Novo recebimento manual' });
    await escolherProduto(usuario, 1, 'pilsen');
    const aviso = await screen.findByTestId('falha-dados-compra');
    expect(within(aviso).getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(/não carregaram/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/recebimentos')).toBe(false);
  }, 30_000);

  it('listagem: fornecedor (link), data, Cód. remessa, Movimentado?, Id, estoque e total, com os filtros na API', async () => {
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === '/api/recebimentos'
        ? {
            corpo: {
              itens: [
                {
                  id: RECEBIMENTO,
                  codigo: 12,
                  fornecedorId: FORNECEDOR,
                  fornecedorNome: 'DISTRIBUIDORA X LTDA',
                  dataRecebimento: '2026-11-05',
                  codigoRemessa: 'NF 777',
                  lojaId: LOJA,
                  lojaNome: 'Loja 1',
                  estoqueId: ESTOQUE,
                  estoqueNome: 'Loja 1 - Ice Beer Hermes',
                  qtdItens: 1,
                  valorTotal: '612.00',
                  status: 'movimentado',
                  versao: 4,
                },
              ],
              total: 1,
              pagina: 1,
              tamanho: 50,
            },
          }
        : undefined,
    );
    renderizar('/estoque/recebimentos?status=movimentado');
    expect(await screen.findByRole('link', { name: 'DISTRIBUIDORA X LTDA' })).toHaveAttribute(
      'href',
      `/estoque/recebimentos/${RECEBIMENTO}`,
    );
    const linha = screen.getByRole('row', { name: /DISTRIBUIDORA X LTDA/ });
    expect(linha).toHaveTextContent('05/11/2026');
    expect(linha).toHaveTextContent('NF 777');
    expect(linha).toHaveTextContent('Sim');
    expect(linha).toHaveTextContent('R$ 612,00');
    const busca = chamadas.find((c) => c.url.pathname === '/api/recebimentos')!;
    expect(busca.url.searchParams.get('status')).toBe('movimentado');
  });

  it('espelho: o documento gravado para a impressão do navegador', async () => {
    simularApi(...sessao(), ({ url }) =>
      url.pathname === `/api/recebimentos/${RECEBIMENTO}` ? { corpo: detalhe({}, 'movimentado') } : undefined,
    );
    renderizar(`/estoque/recebimentos/${RECEBIMENTO}/espelho`);
    expect(await screen.findByRole('heading', { name: /Espelho do recebimento Nº 12/ })).toBeInTheDocument();
    expect(screen.getByText(/DISTRIBUIDORA X LTDA/)).toBeInTheDocument();
    expect(screen.getByText('FD × 12 (17891149103109)')).toBeInTheDocument();
    expect(screen.getByTestId('totais-espelho')).toHaveTextContent('Total geral: R$ 612,00');
  });
});
