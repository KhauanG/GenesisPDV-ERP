import {
  AVISO_SEM_SEFAZ,
  corpoProdutoRapido,
  type DadosCompraProdutos,
  type ItemNotaEntradaDetalhe,
  type NotaEntradaDetalhe,
  type ProdutoDetalhe,
  type ProdutoOpcao,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioNotaEntrada } from './NotasEntrada';
import {
  desfazerIgnorar,
  fatorDivergeDaNota,
  fatorDivergente,
  linhaConfirmavel,
  linhaDoItem,
  linhaParaApi,
  origemDaLinha,
  trocarProduto,
} from './notasEntradaItens';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d1';
const NOTA = '0190a000-0000-7000-8000-0000000000c1';
const FORNECEDOR = '0190a000-0000-7000-8000-0000000000b1';
const CERVEJA = '0190a000-0000-7000-8000-0000000000a1';
const QUEIJO = '0190a000-0000-7000-8000-0000000000a3';
const CAIXA = '0190a000-0000-7000-8000-000000000ca1';
const NOVO = '0190a000-0000-7000-8000-0000000000a5';
const UN = '0190a000-0000-7000-8000-0000000000f9';
const TODAS = ['notas_entrada.ver', 'notas_entrada.importar', 'produtos.ver_custo', 'produtos.criar'];

const produto = (id: string, nome: string, extra: Partial<ProdutoOpcao> = {}): ProdutoOpcao => ({
  id,
  codigo: 10,
  nome,
  tipo: 'simples',
  ativo: true,
  unidadeId: '0190a000-0000-7000-8000-0000000000u1',
  unidadeSigla: 'UN',
  permiteFracao: false,
  controlaEstoque: true,
  ean: null,
  precoVenda: '5.9900',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: '3.0000',
  grupoPrecoQuantidadeId: null,
  ...extra,
});

function item(n: number, parcial: Partial<ItemNotaEntradaDetalhe> = {}): ItemNotaEntradaDetalhe {
  return {
    id: `0190a000-0000-7000-8000-00000000010${n}`,
    numeroItem: n,
    codigoFornecedor: `COD-${n}`,
    descricao: `ITEM ${n}`,
    ean: null,
    eanTributavel: null,
    ncm: '22030000',
    cest: null,
    cfop: '5405',
    unidadeComercial: 'CX',
    quantidadeComercial: '10.0000',
    valorUnitarioComercial: '39.9000000000',
    unidadeTributavel: 'UN',
    quantidadeTributavel: '120.0000',
    valorProduto: '399.00',
    valorFrete: '15.00',
    valorSeguro: '0.00',
    valorDesconto: '0.00',
    valorOutros: '0.00',
    valorIpi: '0.00',
    valorIcmsSt: '66.00',
    valorFcpSt: '0.00',
    rastro: [],
    lote: null,
    validade: null,
    fabricacao: null,
    produtoId: null,
    produto: null,
    codigoBarrasId: null,
    codigoBarras: null,
    fator: '1.000',
    quantidadeEstoque: null,
    fatorConfirmado: false,
    markupPct: null,
    precoVenda: null,
    atualizarPreco: 'nao',
    ignorado: false,
    motivoIgnorado: null,
    fatorTributavel: '12.000',
    sugestao: null,
    vinculoAnterior: null,
    origemVinculo: null,
    custoUnitario: null,
    loteId: null,
    ...parcial,
  };
}

/** Item 1: o EAN do fardo sugere a cerveja com fator 12; 2: "SEM GTIN", sem sugestão; 3: vínculo aprendido 12,107. */
const itens = (): ItemNotaEntradaDetalhe[] => [
  item(1, {
    descricao: 'CERVEJA PILSEN LATA 350ML CX C/12',
    ean: '17891000000011',
    eanTributavel: '7891000000014',
    cest: '0302100',
    sugestao: {
      origem: 'ean',
      produtoId: CERVEJA,
      produto: produto(CERVEJA, 'CERVEJA PILSEN LATA 350ML'),
      codigoBarrasId: CAIXA,
      fator: '12.000',
    },
  }),
  item(2, { descricao: 'LIMAO TAHITI CX 20KG', unidadeTributavel: 'KG', fatorTributavel: '20.000' }),
  item(3, {
    descricao: 'QUEIJO MUSSARELA PECA FD',
    quantidadeComercial: '3.5000',
    quantidadeTributavel: '42.3750',
    fatorTributavel: '12.107',
    produtoId: QUEIJO,
    produto: produto(QUEIJO, 'QUEIJO MUSSARELA KG', { unidadeSigla: 'KG' }),
    fator: '12.100',
    quantidadeEstoque: '42.350',
    fatorConfirmado: true,
    origemVinculo: 'manual',
    vinculoAnterior: { produtoId: QUEIJO, fator: '12.107' },
    sugestao: {
      origem: 'vinculo_anterior',
      produtoId: QUEIJO,
      produto: produto(QUEIJO, 'QUEIJO MUSSARELA KG'),
      codigoBarrasId: null,
      fator: '12.107',
    },
  }),
];

function detalhe(parcial: Partial<NotaEntradaDetalhe> = {}): NotaEntradaDetalhe {
  return {
    id: NOTA,
    versao: 3,
    criadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoPorNome: 'MARIA SILVA',
    codigo: 7,
    chave: '35261099887766000105550010000123451123456786',
    modelo: 55,
    serie: 1,
    numero: 12345,
    dataEmissao: '2026-10-20T11:15:00.000Z',
    dataRecebimento: '2026-11-05T12:00:00.000Z',
    dataMovimentacao: null,
    naturezaOperacao: 'VENDA',
    emitenteCnpj: '99887766000105',
    emitenteNome: 'DISTRIBUIDORA EXEMPLO LTDA',
    emitenteFantasia: null,
    emitenteIe: null,
    emitenteUf: 'SP',
    destinatarioCnpj: '11222333000181',
    fornecedorId: FORNECEDOR,
    fornecedor: {
      id: FORNECEDOR,
      codigo: 9,
      tipo: 'PJ',
      nome: 'DISTRIBUIDORA EXEMPLO LTDA',
      apelido: null,
      cpfCnpj: null,
      ativa: true,
      excluida: false,
    },
    lojaId: LOJA,
    lojaNome: 'Loja 1',
    estoqueId: ESTOQUE,
    estoqueNome: 'Estoque Loja 1',
    tipoEstoqueId: DISPONIVEL,
    tipoEstoqueNome: 'Disponível',
    totais: {
      produtos: '399.00',
      frete: '15.00',
      seguro: '0.00',
      desconto: '0.00',
      outras: '0.00',
      ipi: '0.00',
      ipiDevolvido: '0.00',
      ii: '0.00',
      icms: '0.00',
      icmsDesonerado: '0.00',
      icmsSt: '66.00',
      fcpSt: '0.00',
      total: '480.00',
    },
    transportadoraCnpj: null,
    transportadoraNome: null,
    modalidadeFrete: '0',
    volumes: [],
    informacoesComplementares: null,
    protocoloNumero: '135260000000101',
    protocoloData: '2026-10-20T11:16:02.000Z',
    protocoloStatus: 100,
    assinatura: 'valida',
    assinaturaDetalhe: null,
    status: 'pendente',
    motivoIgnorada: null,
    movimentadaPorNome: null,
    estornadaEm: null,
    estornadaPorNome: null,
    motivoEstorno: null,
    criadoPorNome: 'MARIA SILVA',
    avisos: [AVISO_SEM_SEFAZ],
    vinculacao: {
      parcelasCusto: { incluiSt: true, incluiIpi: true, incluiFrete: true },
      custoBaseMargem: 'ultimo_custo',
      compraAtualizaPrecoCusto: 'perguntar',
      podeAlterarPreco: true,
      resolvidos: 1,
      total: 3,
    },
    itens: itens(),
    duplicatas: [],
    ...parcial,
  };
}

const dadosCompra: DadosCompraProdutos = {
  custoBaseMargem: 'ultimo_custo',
  compraAtualizaPrecoCusto: 'perguntar',
  podeAlterarPreco: true,
  produtos: [
    {
      produtoId: CERVEJA,
      solicitaLotePdv: false,
      temLotes: false,
      embalagens: [
        { id: CAIXA, codigo: '17891000000011', descricao: 'Caixa', unidadeSigla: 'CX', fator: '12.000' },
      ],
      saldo: '0.000',
      custoMedio: '0.0000',
      precoVendaLoja: null,
    },
  ],
};

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

function renderizar(url: string) {
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          {
            path: '/estoque/notas-entrada/:id/:aba?',
            element: (
              <Autenticado>
                <FormularioNotaEntrada />
              </Autenticado>
            ),
          },
        ],
      },
    ],
    url,
  );
}

const sessao = (permissoes = TODAS) =>
  rotasSessao({ permissoes, lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }] });

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/notas-entrada/dados-produtos' ? { corpo: dadosCompra } : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
      : undefined,
];

describe('regras da linha (F2-B20)', () => {
  it('sem vínculo gravado, a sugestão vem preenchida e com o fator por confirmar', () => {
    const [cerveja, limao, queijo] = itens();
    expect(linhaDoItem(cerveja!)).toMatchObject({
      produto: { id: CERVEJA },
      codigoBarrasId: CAIXA,
      fator: '12',
      fatorConfirmado: false,
    });
    expect(origemDaLinha(linhaDoItem(cerveja!), cerveja!)).toBe('ean');
    // Sem sugestão: o fator pelas quantidades do XML, à espera do produto.
    expect(linhaDoItem(limao!)).toMatchObject({ produto: null, fator: '20', fatorConfirmado: false });
    expect(origemDaLinha(linhaDoItem(limao!), limao!)).toBeNull();
    // O vínculo gravado: o fator dele, confirmado, e a divergência do vínculo aprendido.
    const q = linhaDoItem(queijo!);
    expect(q).toMatchObject({ fator: '12,1', fatorConfirmado: true });
    expect(origemDaLinha(q, queijo!)).toBe('manual');
    expect(fatorDivergente(q, queijo!)).toBe('12.107');
    expect(fatorDivergente({ ...q, fator: '12,107' }, queijo!)).toBeNull();
    expect(origemDaLinha({ ...q, fator: '12,107' }, queijo!)).toBe('vinculo_anterior');
  });

  it('trocar o produto volta o fator ao da sugestão, ao do vínculo ou ao da nota, sem confirmação', () => {
    const [cerveja, limao] = itens();
    const outro = produto('0190a000-0000-7000-8000-0000000000a9', 'OUTRA');
    const l = { ...linhaDoItem(cerveja!), fatorConfirmado: true };
    expect(trocarProduto(l, cerveja!, outro)).toMatchObject({
      produto: { id: outro.id },
      codigoBarrasId: null,
      fator: '12',
      fatorConfirmado: false,
    });
    expect(trocarProduto(l, cerveja!, cerveja!.sugestao!.produto)).toMatchObject({ codigoBarrasId: CAIXA });
    expect(trocarProduto(linhaDoItem(limao!), limao!, outro).fator).toBe('20');
  });

  it('o fator que diverge das quantidades da nota e o fator vazio, que não se confirma', () => {
    const [cerveja, limao] = itens();
    const l = linhaDoItem(cerveja!);
    // 10 CX com 120 UN na nota: o fator 1 (o EAN da lata) entraria 10 latas.
    expect(fatorDivergeDaNota(l, cerveja!)).toBeNull();
    expect(fatorDivergeDaNota({ ...l, fator: '1' }, cerveja!)).toBe('12.000');
    // qTrib = qCom: o fator da embalagem vale sozinho.
    expect(fatorDivergeDaNota(l, { ...cerveja!, fatorTributavel: '1.000' })).toBeNull();
    expect(fatorDivergeDaNota(l, { ...cerveja!, fatorTributavel: null })).toBeNull();
    expect(linhaConfirmavel(l)).toBe(true);
    expect(linhaConfirmavel({ ...l, fator: '' })).toBe(false);
    expect(linhaConfirmavel({ ...l, fator: '0' })).toBe(false);
    expect(linhaConfirmavel(linhaDoItem(limao!))).toBe(false);
  });

  it('"Desfazer" o ignorar devolve a linha de antes; o item que já veio ignorado volta pela sugestão', () => {
    const [cerveja, , queijo] = itens();
    const q = linhaDoItem(queijo!);
    const ignorada = { ...q, ignorado: true, motivoIgnorado: 'Brinde' };
    expect(desfazerIgnorar(ignorada, queijo!)).toEqual(q);
    const gravadoIgnorado = { ...cerveja!, ignorado: true, motivoIgnorado: 'Brinde', lote: 'L1' };
    expect(desfazerIgnorar(linhaDoItem(gravadoIgnorado), gravadoIgnorado)).toMatchObject({
      ignorado: false,
      motivoIgnorado: '',
      produto: { id: CERVEJA },
      fator: '12',
      fatorConfirmado: false,
      lote: 'L1',
    });
  });

  it('o corpo do PUT: o confirmado com o produto, o ignorado só com o motivo, sem preço sem a permissão', () => {
    const [cerveja] = itens();
    const l = { ...linhaDoItem(cerveja!), fatorConfirmado: true, atualizarPreco: 'geral' as const };
    const contas = {
      quantidadeEstoque: '120.000',
      custo: '4.0000',
      base: '4.0000',
      precoVenda: '5.99',
      markupPct: '49.75',
    };
    expect(linhaParaApi(l, contas, true)).toMatchObject({
      id: cerveja!.id,
      produtoId: CERVEJA,
      codigoBarrasId: CAIXA,
      fator: '12',
      fatorConfirmado: true,
      precoVenda: '5.99',
      markupPct: '49.75',
      atualizarPreco: 'geral',
      validade: null,
    });
    expect(linhaParaApi(l, contas, false).atualizarPreco).toBe('nao');
    expect(linhaParaApi({ ...l, ignorado: true, motivoIgnorado: 'Brinde' }, null, true)).toEqual({
      id: cerveja!.id,
      ignorado: true,
      motivoIgnorado: 'Brinde',
    });
  });
});

describe('aba "Itens e vinculação" (ERP 13.4.1; F2-B20)', () => {
  it('mostra a origem, o custo e o destaque do fator; confirma os fatores, ignora um item e grava', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (url.pathname !== `/api/notas-entrada/${NOTA}`) {
        if (metodo === 'PUT' && url.pathname === `/api/notas-entrada/${NOTA}/itens`)
          return { corpo: detalhe({ versao: 4, status: 'pronta' }) };
        return undefined;
      }
      return { corpo: detalhe() };
    });
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    expect(screen.getByRole('tab', { name: 'Itens e vinculação (1/3)' })).toBeInTheDocument();
    const cerveja = within(tabela).getByTestId('item-1');
    expect(within(cerveja).getByText('EAN da embalagem')).toBeInTheDocument();
    // (399 + 15 + 66) / (10 × 12) = 4,00 por lata.
    expect(within(cerveja).getByText('R$ 4')).toBeInTheDocument();
    expect(within(cerveja).getByText('= 120 UN')).toBeInTheDocument();
    expect(within(cerveja).getByRole('checkbox', { name: 'Fator confirmado' })).not.toBeChecked();
    const queijo = within(tabela).getByTestId('item-3');
    expect(within(queijo).getByText('Vínculo anterior: fator 12,107')).toBeInTheDocument();
    expect(within(queijo).getByText('Manual')).toBeInTheDocument();
    expect(within(tabela).getByTestId('item-2')).toHaveTextContent('EAN SEM GTIN');
    expect(
      screen.getByText(/1 de 3 item\(ns\) resolvido\(s\) · 1 com o fator por confirmar/),
    ).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Confirmar todos os fatores' }));
    expect(within(cerveja).getByRole('checkbox', { name: 'Fator confirmado' })).toBeChecked();
    await usuario.click(screen.getByRole('button', { name: 'Ignorar o item 2' }));
    const modal = await screen.findByRole('dialog', { name: 'Ignorar item' });
    await usuario.type(within(modal).getByRole('textbox', { name: /Motivo/ }), 'Devolvido na entrega');
    await usuario.click(within(modal).getByRole('button', { name: 'Ignorar item' }));
    await waitFor(() =>
      expect(within(tabela).getByTestId('item-2')).toHaveTextContent('Ignorado: Devolvido na entrega'),
    );
    expect(screen.getByText(/3 de 3 item\(ns\) resolvido\(s\)/)).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Salvar vinculação' }));
    await screen.findByText('Vinculação gravada: a nota está pronta para movimentar.');
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    const corpo = put.corpo as { versao: number; itens: Array<Record<string, unknown>> };
    expect(corpo.versao).toBe(3);
    expect(corpo.itens).toHaveLength(3);
    expect(corpo.itens[0]).toMatchObject({
      produtoId: CERVEJA,
      codigoBarrasId: CAIXA,
      fator: '12',
      fatorConfirmado: true,
      atualizarPreco: 'nao',
    });
    expect(corpo.itens[1]).toEqual({
      id: itens()[1]!.id,
      ignorado: true,
      motivoIgnorado: 'Devolvido na entrega',
    });
    expect(corpo.itens[2]).toMatchObject({ produtoId: QUEIJO, fator: '12,1', fatorConfirmado: true });
  }, 30_000);

  it('o erro da API aparece no item; mudar o fator tira a confirmação', async () => {
    const usuario = userEvent.setup();
    simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'PUT')
        return {
          status: 422,
          corpo: {
            codigo: 'VALIDACAO',
            mensagem: 'Verifique os itens destacados.',
            campos: { 'itens.0.fator': ['O fator é o da embalagem (12)'] },
          },
        };
      return url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined;
    });
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    const queijo = within(tabela).getByTestId('item-3');
    const confirmado = within(queijo).getByRole('checkbox', { name: 'Fator confirmado' });
    expect(confirmado).toBeChecked();
    const fator = within(queijo).getByRole('textbox', { name: 'Fator do item 3' });
    await usuario.clear(fator);
    await usuario.type(fator, '12,107');
    expect(confirmado).not.toBeChecked();
    expect(within(queijo).queryByText(/Vínculo anterior: fator/)).not.toBeInTheDocument();
    expect(within(queijo).getByText('Vínculo anterior')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar vinculação' }));
    // `itens.0` é a primeira linha (a cerveja), não outra.
    const cerveja = within(tabela).getByTestId('item-1');
    expect(await within(cerveja).findByText('O fator é o da embalagem (12)')).toBeInTheDocument();
    expect(within(queijo).queryByText('O fator é o da embalagem (12)')).not.toBeInTheDocument();
    expect(within(tabela).getByTestId('item-2')).not.toHaveTextContent('O fator é o da embalagem (12)');
    expect(screen.getByText('Verifique os itens destacados.')).toBeInTheDocument();
  }, 30_000);

  it('o fator apagado não se confirma, e o que diverge das quantidades da nota fica em destaque', async () => {
    const usuario = userEvent.setup();
    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    const cerveja = within(tabela).getByTestId('item-1');
    const fator = within(cerveja).getByRole('textbox', { name: 'Fator do item 1' });
    const confirmado = within(cerveja).getByRole('checkbox', { name: 'Fator confirmado' });
    await usuario.clear(fator);
    expect(confirmado).toBeDisabled();
    // A cerveja era a única por confirmar com fator: sem fator, não há o que confirmar.
    expect(screen.getByRole('button', { name: 'Confirmar todos os fatores' })).toBeDisabled();
    expect(within(cerveja).queryByText('R$ 4')).not.toBeInTheDocument();
    await usuario.type(fator, '1');
    expect(confirmado).toBeEnabled();
    expect(within(cerveja).getByText('Pelas quantidades da nota: fator 12')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Confirmar todos os fatores' }));
    expect(confirmado).toBeChecked();
    await usuario.clear(fator);
    await usuario.type(fator, '12');
    expect(within(cerveja).queryByText(/Pelas quantidades da nota/)).not.toBeInTheDocument();
  }, 30_000);

  it('"Desfazer" o ignorar num item já vinculado devolve o produto e o fator confirmado', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'PUT') return { corpo: detalhe({ versao: 4 }) };
      return url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined;
    });
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    await usuario.click(screen.getByRole('button', { name: 'Ignorar o item 3' }));
    const modal = await screen.findByRole('dialog', { name: 'Ignorar item' });
    await usuario.type(within(modal).getByRole('textbox', { name: /Motivo/ }), 'Engano');
    await usuario.click(within(modal).getByRole('button', { name: 'Ignorar item' }));
    await waitFor(() => expect(within(tabela).getByTestId('item-3')).toHaveTextContent('Ignorado: Engano'));
    await usuario.click(screen.getByRole('button', { name: 'Desfazer ignorar do item 3' }));
    const queijo = within(tabela).getByTestId('item-3');
    expect(within(queijo).getByRole('textbox', { name: 'Fator do item 3' })).toHaveValue('12,1');
    expect(within(queijo).getByRole('checkbox', { name: 'Fator confirmado' })).toBeChecked();
    expect(within(queijo).getByText('Manual')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar vinculação' }));
    await screen.findByText('Vinculação gravada.');
    const corpo = chamadas.find((c) => c.metodo === 'PUT')!.corpo as {
      itens: Array<Record<string, unknown>>;
    };
    expect(corpo.itens[2]).toMatchObject({ produtoId: QUEIJO, fator: '12,1', fatorConfirmado: true });
    expect(corpo.itens[2]).not.toHaveProperty('ignorado');
  }, 30_000);

  it('"Cadastrar novo produto" vem preenchido com o item (nome, EAN da unidade, NCM, CEST e o custo por unidade)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/produtos'
          ? {
              status: 201,
              corpo: {
                ...produto(NOVO, 'CERVEJA PILSEN LATA 350ML CX C/12', { codigo: 99 }),
                custoMedio: null,
                markupPct: null,
                codigosBarras: [],
              } as unknown as ProdutoDetalhe,
            }
          : undefined,
      ({ url }) => (url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    await usuario.click(within(tabela).getByRole('button', { name: 'Cadastrar novo produto do item 1' }));
    const modal = await screen.findByRole('dialog', { name: 'Cadastrar novo produto' });
    expect(within(modal).getByLabelText(/^Nome/)).toHaveValue('CERVEJA PILSEN LATA 350ML CX C/12');
    // O EAN da unidade (o cEANTrib, a lata), não o do fardo.
    expect(within(modal).getByLabelText(/^Código de barras/)).toHaveValue('7891000000014');
    expect(within(modal).getByLabelText('CEST')).toHaveValue('0302100');
    await waitFor(() =>
      expect(within(modal).getByRole('combobox', { name: /^Unidade/ })).toHaveValue('UN - Unidade'),
    );
    await usuario.type(within(modal).getByLabelText(/^Preço de venda/), '6,99');
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos')).toBe(true),
    );
    // O custo por unidade: (399 + 15 + 66) / (10 × 12) = 4,0000.
    expect(chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos')!.corpo).toEqual(
      corpoProdutoRapido({
        nome: 'CERVEJA PILSEN LATA 350ML CX C/12',
        ean: '7891000000014',
        unidadeId: UN,
        unidadePermiteFracao: false,
        ncm: '22030000',
        cest: '0302100',
        marcaId: null,
        categoriaId: null,
        precoVenda: '6,99',
        precoCusto: '4.0000',
      }),
    );
    // O produto novo entra na linha, com o fator pelas quantidades da nota e por confirmar.
    const cerveja = within(tabela).getByTestId('item-1');
    await waitFor(() => expect(within(cerveja).getByText('Manual')).toBeInTheDocument());
    expect(within(cerveja).getByRole('textbox', { name: 'Fator do item 1' })).toHaveValue('12');
    expect(within(cerveja).getByRole('checkbox', { name: 'Fator confirmado' })).not.toBeChecked();
  }, 30_000);

  it('somente leitura com a nota movimentada, mesmo com notas_entrada.importar', async () => {
    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/notas-entrada/${NOTA}`
        ? { corpo: detalhe({ status: 'movimentada', dataMovimentacao: '2026-11-05T13:00:00.000Z' }) }
        : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    expect(screen.queryByRole('button', { name: 'Salvar vinculação' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar todos os fatores' })).not.toBeInTheDocument();
    expect(within(tabela).queryByRole('button', { name: /Ignorar o item/ })).not.toBeInTheDocument();
    expect(within(tabela).queryByRole('button', { name: /Cadastrar novo produto/ })).not.toBeInTheDocument();
    expect(within(tabela).getByRole('textbox', { name: 'Fator do item 1' })).toBeDisabled();
    expect(within(tabela).getByRole('textbox', { name: 'Preço de venda do item 1' })).toBeDisabled();
    expect(within(tabela).getAllByRole('checkbox', { name: 'Fator confirmado' })[0]).toBeDisabled();
  }, 30_000);

  it('a movimentada mostra o custo gravado (F2-B21), não a prévia pelas chaves de agora', async () => {
    const [cerveja, limao, queijo] = itens();
    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/notas-entrada/${NOTA}`
        ? {
            corpo: detalhe({
              status: 'movimentada',
              dataMovimentacao: '2026-11-05T13:00:00.000Z',
              // As chaves mudaram depois: a prévia daria (399 + 15) / 120 = 3,45; o gravado é o de quando entrou.
              vinculacao: {
                ...detalhe().vinculacao,
                parcelasCusto: { incluiSt: false, incluiIpi: true, incluiFrete: true },
              },
              itens: [
                {
                  ...cerveja!,
                  produtoId: CERVEJA,
                  produto: cerveja!.sugestao!.produto,
                  fator: '12.000',
                  quantidadeEstoque: '120.000',
                  fatorConfirmado: true,
                  custoUnitario: '4.0000',
                },
                limao!,
                queijo!,
              ],
            }),
          }
        : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    expect(within(within(tabela).getByTestId('item-1')).getByText('R$ 4')).toBeInTheDocument();
  }, 30_000);

  it('o item em dois lotes do rastro avisa a divisão que a movimentação fará; o lote trocado não divide', async () => {
    const usuario = userEvent.setup();
    const [cerveja, limao, queijo] = itens();
    const rastro = [
      {
        lote: 'L2610A',
        quantidade: '72.000',
        fabricacao: '2026-10-10',
        validade: '2026-11-25',
        codigoAgregacao: null,
      },
      {
        lote: 'L2612B',
        quantidade: '48.000',
        fabricacao: '2026-10-12',
        validade: '2026-11-27',
        codigoAgregacao: null,
      },
    ];
    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/notas-entrada/${NOTA}`
        ? {
            corpo: detalhe({
              itens: [{ ...cerveja!, rastro, lote: 'L2610A', validade: '2026-11-25' }, limao!, queijo!],
            }),
          }
        : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    expect(await within(tabela).findByTestId('partes-rastro-1')).toHaveTextContent(
      'Entra em 2 lotes do rastro: L2610A (72), L2612B (48)',
    );
    const lote = within(tabela).getByRole('textbox', { name: 'Lote do item 1' });
    await usuario.clear(lote);
    await usuario.type(lote, 'OUTRO');
    expect(within(tabela).queryByTestId('partes-rastro-1')).not.toBeInTheDocument();
  }, 30_000);

  it('o Movimentar recusado por item (422 em itens.N.*) diz qual item no alerta e destaca a linha', async () => {
    const usuario = userEvent.setup();
    const [cerveja, limao, queijo] = itens();
    const rastro = [
      {
        lote: 'L2610A',
        quantidade: '120.000',
        fabricacao: '2026-10-10',
        validade: '2026-11-25',
        codigoAgregacao: null,
      },
    ];
    // O item na posição 0 é o nItem 7: o alerta mostra o número do item na nota, não a posição.
    simularApi(
      ...sessao([...TODAS, 'notas_entrada.movimentar']),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}`
          ? {
              corpo: detalhe({
                status: 'pronta',
                itens: [
                  { ...cerveja!, numeroItem: 7, rastro, lote: 'L2610A', validade: '2026-11-25' },
                  limao!,
                  queijo!,
                ],
              }),
            }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/notas-entrada/${NOTA}/movimentar`
          ? {
              status: 422,
              corpo: {
                codigo: 'VALIDACAO',
                mensagem: 'Verifique os lotes destacados.',
                campos: {
                  'itens.0.validade': ['O lote L2610A já está cadastrado com a validade 24/11/2026'],
                  'itens.1.produtoId': ['O produto foi excluído: escolha outro'],
                },
              },
            }
          : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    await usuario.click(screen.getByRole('button', { name: 'Movimentar' }));
    const confirmar = await screen.findByRole('dialog', { name: 'Movimentar a NF-e' });
    await usuario.click(within(confirmar).getByRole('button', { name: 'Movimentar' }));
    const lista = await screen.findByTestId('erros-itens-movimentacao');
    expect(lista.closest('[role="alert"]')).toHaveTextContent('Verifique os lotes destacados.');
    expect(lista).toHaveTextContent(
      'Item 7: O lote L2610A já está cadastrado com a validade 24/11/2026' +
        'Item 2: O produto foi excluído: escolha outro',
    );
    // A linha do item fica destacada no campo apontado, como no erro do "Salvar vinculação".
    const linha = within(tabela).getByTestId('item-7');
    expect(
      await within(linha).findByText('O lote L2610A já está cadastrado com a validade 24/11/2026'),
    ).toBeInTheDocument();
    expect(within(linha).getByRole('textbox', { name: 'Validade do item 7' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(
      within(within(tabela).getByTestId('item-2')).getByText('O produto foi excluído: escolha outro'),
    ).toBeInTheDocument();
  }, 30_000);

  it('somente leitura sem notas_entrada.importar', async () => {
    simularApi(...sessao(['notas_entrada.ver']), ...referencias, ({ url }) =>
      url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}/itens`);
    const tabela = await screen.findByRole('table', { name: 'Itens da nota' });
    expect(screen.queryByRole('button', { name: 'Salvar vinculação' })).not.toBeInTheDocument();
    expect(within(tabela).queryByRole('button', { name: /Ignorar o item/ })).not.toBeInTheDocument();
    expect(within(tabela).getByRole('textbox', { name: 'Fator do item 1' })).toBeDisabled();
    expect(within(tabela).getByText('10 - CERVEJA PILSEN LATA 350ML')).toBeInTheDocument();
  }, 30_000);
});
