import type {
  LinhaMovimentacaoEstoque,
  RespostaMovimentacaoEstoque,
  TipoMovimentoEstoqueOpcao,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorLojaContexto } from '../../layout/lojaContexto';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { MovimentacaoEstoque, unidadeDocumento } from './MovimentacaoEstoque';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
const ESTOQUE = id(1);
const ESTOQUE_2 = id(2);
const PRODUTO = id(3);
const ACERTO = id(4);
const RECEBIMENTO = id(5);
const ESTOQUE_INATIVO = id(7);
const LOJA_2 = id(8);
const PESSOA = id(9);

const TIPOS: TipoMovimentoEstoqueOpcao[] = [
  {
    codigo: 'ACERTO_DEFINIR',
    nome: 'Acerto de estoque – Definir',
    sinal: 0,
    documentoTipo: 'acerto',
    idNuvem3: null,
    ativo: true,
  },
  {
    codigo: 'RECEB_MANUAL',
    nome: 'Recebimento manual de produtos',
    sinal: 1,
    documentoTipo: 'recebimento',
    idNuvem3: null,
    ativo: true,
  },
  {
    codigo: 'TRANSF_SAIDA',
    nome: 'Transferência de estoque – Saída',
    sinal: -1,
    documentoTipo: 'transferencia',
    idNuvem3: 28,
    ativo: true,
  },
];

const linha = (extra: Partial<LinhaMovimentacaoEstoque> = {}): LinhaMovimentacaoEstoque => ({
  id: id(10),
  dataMovimento: '2026-11-06T13:30:00.123456Z',
  produtoId: PRODUTO,
  produtoCodigo: 12,
  codigoInterno: 'IPA-600',
  produtoNome: 'CERV SERRA IPA 600',
  variacaoId: null,
  variacaoNome: null,
  tipoMovimento: 'RECEB_MANUAL',
  tipoMovimentoNome: 'Recebimento manual de produtos',
  idNuvem3: null,
  tipoEstoqueId: id(6),
  tipoEstoqueNome: 'Disponível',
  estoqueNome: 'Estoque Loja 1',
  lojaNome: 'Loja 1 - Centro',
  saldoAnterior: '25.000',
  quantidade: '5.000',
  saldoPosterior: '30.000',
  saldoAnteriorGravado: '25.000',
  saldoPosteriorGravado: '30.000',
  sigla: 'UN',
  unidadeBase: 'UN',
  fator: '1.000',
  usuarioNome: 'ADMINISTRADOR',
  custoUnitario: '6.0000',
  custoTotal: '30.00',
  documento: { tipo: 'recebimento', id: RECEBIMENTO, numero: '7' },
  pessoaVenda: null,
  fornecedor: 'Distribuidora X Ltda',
  observacao: null,
  ...extra,
});

const resposta = (
  itens: LinhaMovimentacaoEstoque[],
  extra: Partial<RespostaMovimentacaoEstoque> = {},
): RespostaMovimentacaoEstoque => ({
  itens,
  proximoCursor: null,
  tamanho: 50,
  referencias: { estoque: { id: ESTOQUE, nome: 'Estoque Loja 1' }, produto: null, pessoa: null },
  ...extra,
});

const PERMISSOES = [
  'relatorios.movimentacao_estoque',
  'produtos.ver_custo',
  'produtos.ver',
  'pessoas.ver',
  'recebimentos.ver',
];

function api(opcoes: { permissoes?: string[]; relatorio?: (url: URL) => RespostaMovimentacaoEstoque } = {}) {
  const permissoes = opcoes.permissoes ?? PERMISSOES;
  return simularApi(...rotasSessao({ permissoes }), ({ url, metodo }) => {
    if (url.pathname === '/api/referencias/tipos-movimento-estoque') return { corpo: TIPOS };
    // O inativo vem primeiro (a ordem por nome): o padrão pula ele. O da Loja 2 é o da loja de contexto.
    if (url.pathname === '/api/estoques')
      return {
        corpo: {
          itens: [
            { id: ESTOQUE_INATIVO, codigo: 3, nome: 'Depósito Antigo', lojaId: null, ativo: false },
            { id: ESTOQUE, codigo: 1, nome: 'Estoque Loja 1', lojaId: null, ativo: true },
            { id: ESTOQUE_2, codigo: 2, nome: 'Estoque Loja 2', lojaId: LOJA_2, ativo: true },
          ].map((e) => ({ ...e, tipo: 'loja', lojaNome: null, versao: 1 })),
          total: 3,
          pagina: 1,
          tamanho: 'todos',
        },
      };
    if (metodo === 'GET' && url.pathname === '/api/relatorios/movimentacao-estoque') {
      const r = opcoes.relatorio?.(url) ?? resposta([linha()]);
      return {
        corpo: permissoes.includes('produtos.ver_custo')
          ? r
          : { ...r, itens: r.itens.map((l) => ({ ...l, custoUnitario: null, custoTotal: null })) },
      };
    }
    return undefined;
  });
}

/** O campo de digitação de um Select/MultiSelect (o rótulo também nomeia a lista de opções). */
const campoDe = (rotulo: string) => screen.getAllByLabelText(rotulo).find((e) => e.tagName === 'INPUT')!;

const doRelatorio = (chamadas: Array<{ url: URL }>) =>
  chamadas.filter((c) => c.url.pathname === '/api/relatorios/movimentacao-estoque');

const PERIODO = `estoqueId=${ESTOQUE}&dataInicial=2026-11-01&dataFinal=2026-11-07`;
const abrir = (busca = `gerado=1&${PERIODO}`) =>
  renderizarComSessao(<MovimentacaoEstoque />, `/relatorios/movimentacao-estoque?${busca}`);

describe('<MovimentacaoEstoque> (ERP 16.5; F2-B32)', () => {
  it('mostra as colunas do Nuvem3 com o custo, o documento com o link e manda os filtros e o tamanho, sem página', async () => {
    const { chamadas } = api();
    abrir(`gerado=1&${PERIODO}&tiposMovimento=RECEB_MANUAL,TRANSF_SAIDA`);
    const tabela = await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).toEqual([
      'Data/hora',
      'Ref. Interna',
      'Produto',
      'Tipo de movimento',
      'Tipo de estoque',
      'Est. anterior',
      'Qtd. movimentada',
      'Est. atual',
      'Unidade',
      'Unid. do documento',
      'Custo unit.',
      'Custo total',
      'Documento',
      'Cliente/Fornecedor',
      'Usuário',
      'Loja',
    ]);
    const l = within(tabela).getByRole('link', { name: '12 - CERV SERRA IPA 600' }).closest('tr')!;
    expect(l).toHaveTextContent('06/11/2026 10:30');
    expect(l).toHaveTextContent('+5');
    expect(l).toHaveTextContent('R$ 6,00');
    expect(l).toHaveTextContent('R$ 30,00');
    expect(l).toHaveTextContent('Distribuidora X Ltda');
    expect(within(l).getByRole('link', { name: 'Recebimento Nº 7' })).toHaveAttribute(
      'href',
      `/estoque/recebimentos/${RECEBIMENTO}`,
    );
    expect(screen.getByTestId('nota-relatorio')).toHaveTextContent('recalculados na ordem da data');
    const pedido = doRelatorio(chamadas)[0]!;
    expect(Object.fromEntries(pedido.url.searchParams)).toEqual({
      estoqueId: ESTOQUE,
      dataInicial: '2026-11-01',
      dataFinal: '2026-11-07',
      tiposMovimento: 'RECEB_MANUAL,TRANSF_SAIDA',
      tamanho: '50',
    });
    // Sem total nem "Página N de M": a paginação é por cursor, e a última página não tem Próxima.
    expect(screen.getAllByText('Página 1').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
  });

  it('o saldo recalculado diferente do gravado ganha o ícone com os gravados; sem permissão, o documento sem link', async () => {
    api({
      permissoes: ['relatorios.movimentacao_estoque'],
      relatorio: () =>
        resposta([
          linha({
            tipoMovimento: 'ACERTO_DEFINIR',
            tipoMovimentoNome: 'Acerto de estoque – Definir',
            quantidade: '-5.000',
            saldoAnterior: '20.000',
            saldoPosterior: '15.000',
            saldoAnteriorGravado: '32.000',
            saldoPosteriorGravado: '27.000',
            documento: { tipo: 'acerto', id: ACERTO, numero: '4' },
            fornecedor: null,
          }),
        ]),
    });
    abrir();
    const tabela = await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).not.toContain('Custo unit.');
    expect(cabecalho).not.toContain('Custo total');
    expect(within(tabela).getByLabelText('Saldo gravado no lançamento: 27')).toBeInTheDocument();
    expect(within(tabela).getByText('-5')).toBeInTheDocument();
    expect(within(tabela).queryByRole('link', { name: 'Acerto Nº 4' })).not.toBeInTheDocument();
    expect(within(tabela).getByText('Acerto Nº 4')).toBeInTheDocument();
    // Sem `produtos.ver` e `pessoas.ver`, sem os seletores de produto e de pessoa.
    expect(screen.queryByLabelText('Produto')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Pessoa (cliente ou fornecedor)')).not.toBeInTheDocument();
  });

  it('Próxima e Anterior andam pelo cursor da API', async () => {
    const { chamadas } = api({
      relatorio: (url) =>
        url.searchParams.get('cursor') === 'CURSOR-2'
          ? resposta([linha({ id: id(11), produtoNome: 'SEGUNDA PAGINA' })])
          : resposta([linha()], { proximoCursor: 'CURSOR-2' }),
    });
    abrir();
    await screen.findByRole('link', { name: '12 - CERV SERRA IPA 600' });
    await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await screen.findByRole('link', { name: '12 - SEGUNDA PAGINA' });
    expect(doRelatorio(chamadas).at(-1)!.url.searchParams.get('cursor')).toBe('CURSOR-2');
    expect(screen.getAllByText('Página 2').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
    await screen.findByRole('link', { name: '12 - CERV SERRA IPA 600' });
    expect(screen.getAllByText('Página 1').length).toBeGreaterThan(0);
  });

  it('o padrão é do primeiro dia do mês até hoje no primeiro local; só gera depois do Filtrar', async () => {
    const { chamadas } = api();
    abrir('');
    expect(await screen.findByText('Escolha os filtros e clique em Filtrar.')).toBeInTheDocument();
    expect(doRelatorio(chamadas)).toHaveLength(0);
    await waitFor(() => expect(screen.getByDisplayValue('Estoque Loja 1')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    expect(Object.fromEntries(doRelatorio(chamadas)[0]!.url.searchParams)).toEqual({
      estoqueId: ESTOQUE,
      dataInicial: `${hoje.slice(0, 8)}01`,
      dataFinal: hoje,
      tamanho: '50',
    });
    // Os locais vêm também os inativos, marcados (o histórico de um local desativado).
    const estoques = chamadas.find((c) => c.url.pathname === '/api/estoques')!;
    expect(estoques.url.searchParams.get('situacao')).toBe('todos');
    await userEvent.click(campoDe('Local de estoque'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Depósito Antigo (inativo)', hidden: true }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(doRelatorio(chamadas).at(-1)!.url.searchParams.get('estoqueId')).toBe(ESTOQUE_INATIVO),
    );
  });

  it('com a loja de contexto no cabeçalho, o padrão é o estoque ativo dela', async () => {
    const { chamadas } = api();
    window.localStorage.setItem('teste-movimentacao-loja', LOJA_2);
    renderizarComSessao(
      <ProvedorLojaContexto chave="teste-movimentacao-loja" permitidas={[LOJA_2]}>
        <MovimentacaoEstoque />
      </ProvedorLojaContexto>,
      '/relatorios/movimentacao-estoque',
    );
    await waitFor(() => expect(screen.getByDisplayValue('Estoque Loja 2')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    expect(doRelatorio(chamadas)[0]!.url.searchParams.get('estoqueId')).toBe(ESTOQUE_2);
  });

  it('a quantidade na unidade do produto; a do documento com o fator ao lado', async () => {
    api({
      relatorio: () =>
        resposta([linha({ quantidade: '24.000', saldoPosterior: '49.000', sigla: 'CX', fator: '12.000' })]),
    });
    abrir();
    const tabela = await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    const celulas = [...within(tabela).getAllByRole('row')[1]!.querySelectorAll('td')].map(
      (c) => c.textContent,
    );
    expect(celulas[cabecalho.indexOf('Qtd. movimentada')]).toBe('+24');
    expect(celulas[cabecalho.indexOf('Unidade')]).toBe('UN');
    expect(celulas[cabecalho.indexOf('Unid. do documento')]).toBe('CX ×12');
    expect(screen.getByTestId('nota-relatorio')).toHaveTextContent('2 CX ×12 entram como 24');
    expect(unidadeDocumento({ sigla: 'FD', fator: '6.500' })).toBe('FD ×6,5');
    expect(unidadeDocumento({ sigla: 'UN', fator: '1.000' })).toBe('UN');
  });

  it('marcar dois tipos na multisseleção manda os códigos; a impressão mostra os nomes, o produto e a pessoa', async () => {
    const { chamadas } = api({
      relatorio: () =>
        resposta([linha()], {
          referencias: {
            estoque: { id: ESTOQUE, nome: 'Estoque Loja 1' },
            produto: { id: PRODUTO, codigo: 12, nome: 'CERV SERRA IPA 600' },
            pessoa: { id: PESSOA, codigo: 31, nome: 'Bar do Zé' },
          },
        }),
    });
    abrir(`${PERIODO}&produtoId=${PRODUTO}&pessoaId=${PESSOA}`);
    await waitFor(() => expect(screen.getByDisplayValue('Estoque Loja 1')).toBeInTheDocument());
    await userEvent.click(campoDe('Tipos de movimento'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Recebimento manual de produtos', hidden: true }),
    );
    await userEvent.click(campoDe('Tipos de movimento'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'Transferência de estoque – Saída', hidden: true }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Filtrar' }));
    await screen.findByRole('table', { name: 'Movimentação de Estoque' });
    expect(doRelatorio(chamadas).at(-1)!.url.searchParams.get('tiposMovimento')).toBe(
      'RECEB_MANUAL,TRANSF_SAIDA',
    );
    // Os "Filtros" da impressão: os nomes dos tipos (não os códigos) e o produto e a pessoa pelo `descrever`.
    const filtros = await screen.findByText(/^Filtros: /);
    expect(filtros).toHaveTextContent(
      'Tipos de movimento: Recebimento manual de produtos, Transferência de estoque – Saída',
    );
    expect(filtros).toHaveTextContent('Produto: 12 - CERV SERRA IPA 600');
    expect(filtros).toHaveTextContent('Pessoa (cliente ou fornecedor): 31 - Bar do Zé');
    expect(filtros).not.toHaveTextContent('RECEB_MANUAL');
  });
});
