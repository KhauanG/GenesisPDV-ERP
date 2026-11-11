import type { LinhaNcmInvalido, RespostaNcmInvalidos } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { NcmInvalidos } from './NcmInvalidos';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`;

const linha = (n: number, extra: Partial<LinhaNcmInvalido> = {}): LinhaNcmInvalido => ({
  produtoId: id(n),
  produtoCodigo: n,
  produtoNome: `PRODUTO TESTE ${n}`,
  versao: 10 + n,
  ativo: true,
  codigoInterno: null,
  codigoBarras: null,
  ncm: null,
  cest: null,
  motivo: 'vazio',
  detalhe: null,
  ...extra,
});

const LINHAS = [
  linha(1),
  linha(2, { ncm: '99999999', motivo: 'inexistente', detalhe: 'O NCM 99999999 não está na tabela vigente' }),
  linha(3, { ncm: '01012100', motivo: 'fora_vigencia', detalhe: 'Vigência até 31/12/2020', ativo: false }),
];

function api(
  opcoes: {
    permissoes?: string[];
    cestCarregado?: boolean;
    definir?: (corpo: unknown) => { status?: number; corpo?: unknown };
  } = {},
) {
  return simularApi(
    ...rotasSessao({ permissoes: opcoes.permissoes ?? ['relatorios.ncm_invalidos', 'produtos.editar'] }),
    ({ url, metodo, corpo }) => {
      if (url.pathname === '/api/ncms')
        return {
          corpo: [
            { codigo: '22030000', descricao: 'Cervejas de malte.', vigenciaInicio: null, vigenciaFim: null },
          ],
        };
      if (metodo === 'POST' && url.pathname === '/api/relatorios/ncm-invalidos/definir-ncm')
        return opcoes.definir?.(corpo) ?? { corpo: { atualizados: [], semMudanca: 0 } };
      if (url.pathname !== '/api/relatorios/ncm-invalidos') return undefined;
      return {
        corpo: {
          itens: LINHAS,
          total: 3,
          pagina: 1,
          tamanho: 50,
          porMotivo: { vazio: 1, inexistente: 1, fora_vigencia: 1, cest_incompativel: 0 },
          cestCarregado: opcoes.cestCarregado ?? false,
        } satisfies RespostaNcmInvalidos,
      };
    },
  );
}

const relatorio = (chamadas: Array<{ url: URL; metodo: string }>) =>
  chamadas.filter((c) => c.metodo === 'GET' && c.url.pathname === '/api/relatorios/ncm-invalidos');

describe('<NcmInvalidos> (ERP 16.3; F2-B41)', () => {
  it('gera ao abrir: o motivo com o detalhe, o Editar e os cards; sem a tabela de CEST, o aviso', async () => {
    const { chamadas } = api();
    renderizarComSessao(<NcmInvalidos />, '/relatorios/ncm-invalidos');
    const tabela = await screen.findByRole('table', { name: 'NCMs inválidos' });
    const l2 = within(tabela).getByText('2 - PRODUTO TESTE 2').closest('tr')!;
    expect(within(l2).getByText('NCM inexistente')).toBeInTheDocument();
    expect(within(l2).getByText('O NCM 99999999 não está na tabela vigente')).toBeInTheDocument();
    expect(within(l2).getByText('9999.99.99')).toBeInTheDocument();
    expect(within(l2).getByRole('link', { name: 'Editar 2 - PRODUTO TESTE 2' })).toHaveAttribute(
      'href',
      `/produtos/${id(2)}`,
    );
    const l3 = within(tabela).getByText('3 - PRODUTO TESTE 3').closest('tr')!;
    expect(within(l3).getByText('Inativo')).toBeInTheDocument();
    expect(screen.getByText('Tabela não carregada')).toBeInTheDocument();
    expect(relatorio(chamadas)[0]!.url.searchParams.get('tamanho')).toBe('50');
  });

  it('"Definir NCM" em lote: marca, escolhe o NCM e grava com as versões; o relatório é gerado de novo', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api({
      definir: () => ({
        corpo: {
          atualizados: [
            { id: id(1), codigo: 1, nome: 'PRODUTO TESTE 1' },
            { id: id(3), codigo: 3, nome: 'PRODUTO TESTE 3' },
          ],
          semMudanca: 0,
        },
      }),
    });
    renderizarComSessao(<NcmInvalidos />, '/relatorios/ncm-invalidos');
    await screen.findByRole('table', { name: 'NCMs inválidos' });
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar 1 - PRODUTO TESTE 1' }));
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar 3 - PRODUTO TESTE 3' }));
    const barra = screen.getByRole('toolbar', { name: 'Linhas selecionadas' });
    await usuario.click(within(barra).getByRole('button', { name: 'Definir NCM' }));
    const modal = await screen.findByRole('dialog', { name: 'Definir NCM de 2 produto(s)' });
    await usuario.type(within(modal).getByLabelText(/^NCM/), '2203');
    await usuario.click(await screen.findByRole('option', { name: /2203\.00\.00/, hidden: true }));
    const antes = relatorio(chamadas).length;
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname.endsWith('/definir-ncm'))?.corpo).toEqual({
        ncm: '22030000',
        produtos: [
          { id: id(1), versao: 11 },
          { id: id(3), versao: 13 },
        ],
      }),
    );
    expect(await screen.findByText('NCM definido em 2 produto(s).')).toBeInTheDocument();
    await waitFor(() => expect(relatorio(chamadas).length).toBeGreaterThan(antes));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('o erro da API fica no modal, com a mensagem de cada produto', async () => {
    const usuario = userEvent.setup();
    api({
      definir: () => ({
        status: 409,
        corpo: {
          codigo: 'CONFLITO',
          mensagem:
            '1 produto(s) foram alterados depois de abrir o relatório. Gere o relatório de novo. Nada foi gravado.',
          campos: {
            'produtos.0': [
              '1 - PRODUTO TESTE 1: alterado depois de abrir o relatório; gere o relatório de novo',
            ],
          },
        },
      }),
    });
    renderizarComSessao(<NcmInvalidos />, '/relatorios/ncm-invalidos');
    await screen.findByRole('table', { name: 'NCMs inválidos' });
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar 1 - PRODUTO TESTE 1' }));
    await usuario.click(screen.getByRole('button', { name: 'Definir NCM' }));
    const modal = await screen.findByRole('dialog');
    await usuario.type(within(modal).getByLabelText(/^NCM/), '2203');
    await usuario.click(await screen.findByRole('option', { name: /2203\.00\.00/, hidden: true }));
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    const erro = await within(modal).findByTestId('erro-definir-ncm');
    expect(erro).toHaveTextContent('Nada foi gravado');
    expect(erro).toHaveTextContent('1 - PRODUTO TESTE 1: alterado depois de abrir o relatório');
  });

  it('a mensagem sem o produto ganha o "código - nome" pelo índice; as repetidas não colidem', async () => {
    const usuario = userEvent.setup();
    const erros = vi.spyOn(console, 'error');
    api({
      definir: () => ({
        status: 422,
        corpo: {
          codigo: 'VALIDACAO',
          mensagem: 'Verifique os produtos destacados (2 com erro). Nada foi gravado.',
          campos: { 'produtos.0': ['Produto não encontrado'], 'produtos.1': ['Produto não encontrado'] },
        },
      }),
    });
    renderizarComSessao(<NcmInvalidos />, '/relatorios/ncm-invalidos');
    await screen.findByRole('table', { name: 'NCMs inválidos' });
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar 2 - PRODUTO TESTE 2' }));
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar 3 - PRODUTO TESTE 3' }));
    await usuario.click(screen.getByRole('button', { name: 'Definir NCM' }));
    const modal = await screen.findByRole('dialog');
    await usuario.type(within(modal).getByLabelText(/^NCM/), '2203');
    await usuario.click(await screen.findByRole('option', { name: /2203\.00\.00/, hidden: true }));
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    const erro = await within(modal).findByTestId('erro-definir-ncm');
    // A ordem da lista enviada (a da seleção): `produtos.0` = o 2, `produtos.1` = o 3.
    expect([...erro.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '2 - PRODUTO TESTE 2: Produto não encontrado',
      '3 - PRODUTO TESTE 3: Produto não encontrado',
    ]);
    expect(erros.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    erros.mockRestore();
  });

  it('sem produtos.editar: só o relatório, sem a seleção', async () => {
    api({ permissoes: ['relatorios.ncm_invalidos'], cestCarregado: true });
    renderizarComSessao(<NcmInvalidos />, '/relatorios/ncm-invalidos');
    await screen.findByRole('table', { name: 'NCMs inválidos' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Tabela não carregada')).toBeNull();
  });
});
