import type { Dashboard as DadosDashboard, PreviaImportacao } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { Dashboard } from '../Dashboard';
import { Importacao } from './Importacao';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ARQUIVO = '0190a000-0000-7000-8000-0000000000aa';
const TAREFA = '0190a000-0000-7000-8000-0000000000bb';
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }];

const PREVIA: PreviaImportacao = {
  tipo: 'produtos',
  arquivoId: ARQUIVO,
  nomeArquivo: 'Exportacao Nuvem3.csv',
  colunasReconhecidas: ['codigo_interno', 'ean', 'nome', 'preco_venda', 'ncm'],
  colunasIgnoradas: ['Cor do rótulo'],
  resumo: {
    linhas: 4,
    criar: 1,
    atualizar: 1,
    sem_alteracao: 1,
    inativar: 0,
    ignorar: 1,
    comAviso: 2,
    porAviso: { sem_preco: 1, ncm_invalido: 1 },
  },
  linhas: [
    {
      linha: 3,
      acao: 'ignorar',
      descricao: 'GELO 5KG',
      registroId: null,
      erros: ['Sem preço de venda: o produto não é criado'],
      avisos: [{ codigo: 'sem_preco', campo: 'preco_venda', mensagem: 'Sem preço de venda' }],
    },
    {
      linha: 4,
      acao: 'criar',
      descricao: 'CARVAO 3KG',
      registroId: null,
      erros: [],
      avisos: [
        { codigo: 'ncm_invalido', campo: 'ncm', mensagem: 'NCM 99999999 inexistente na tabela vigente' },
      ],
    },
    {
      linha: 2,
      acao: 'atualizar',
      descricao: 'CERV BRAHMA LT 350ML',
      registroId: 'p1',
      erros: [],
      avisos: [],
      alteracoes: [{ campo: 'precoVenda', rotulo: 'Preço de venda', de: '4,49', para: '4,99' }],
    },
    {
      linha: 5,
      acao: 'sem_alteracao',
      descricao: 'AGUA CRYSTAL 500ML',
      registroId: 'p2',
      erros: [],
      avisos: [],
      alteracoes: [],
    },
  ],
};

describe('Importação por planilha (ERP 8.6)', () => {
  it('pré-visualiza com as opções, mostra as inconsistências e acompanha a tarefa até o relatório', async () => {
    const usuario = userEvent.setup();
    let consultas = 0;
    const { chamadas } = simularApi(
      ...rotasSessao({
        permissoes: [
          'produtos.importar',
          'pessoas.importar',
          'estoque_acertos.criar',
          'marcas.criar',
          'categorias.editar',
        ],
        lojas: LOJAS,
      }),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/importacoes/produtos/previa'
          ? { corpo: PREVIA }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/importacoes/produtos/confirmar'
          ? { status: 202, corpo: { tarefaId: TAREFA } }
          : undefined,
      ({ url }) => {
        if (url.pathname !== `/api/tarefas/${TAREFA}`) return undefined;
        consultas++;
        return {
          corpo:
            consultas < 2
              ? {
                  id: TAREFA,
                  status: 'executando',
                  progressoPct: 40,
                  mensagem: 'Linha 1 de 3',
                  resultado: null,
                  erro: null,
                  download: null,
                }
              : {
                  id: TAREFA,
                  status: 'concluida',
                  progressoPct: 100,
                  mensagem: null,
                  erro: null,
                  download: 'http://s3/relatorio.xlsx',
                  resultado: {
                    tipo: 'produtos',
                    criados: 1,
                    atualizados: 1,
                    inativados: 0,
                    semAlteracao: 1,
                    comErro: 1,
                    comAviso: 2,
                    porAviso: { sem_preco: 1, ncm_invalido: 1 },
                    acertoId: 'a1',
                    acertoCodigo: 12,
                  },
                },
        };
      },
    );
    const { container } = renderizarComSessao(<Importacao />, '/produtos/importacao');
    expect(await screen.findByRole('heading', { name: 'Importação' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText(/^Loja/)[0]).toBeInTheDocument());
    // Loja escolhida no seletor (sem loja de contexto).
    await usuario.click(screen.getAllByLabelText(/^Loja/)[0]!);
    await usuario.click(
      await screen.findByRole('option', { name: '1 - Loja 1 - Ice Beer Hermes', hidden: true }),
    );
    await usuario.click(screen.getByLabelText(/Atualizar estoque \(a coluna/));
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(
      entrada,
      new File(['Produto;Venda\nX;1'], 'Exportacao Nuvem3.csv', { type: 'text/csv' }),
    );
    // Sem a hora da contagem (F2-B11) não pré-visualiza; o atalho "Ontem, 23:00" a preenche.
    expect(screen.getByRole('button', { name: 'Pré-visualizar' })).toBeDisabled();
    await usuario.click(screen.getByRole('button', { name: /Data\/hora da contagem/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Ontem, 23:00 (depois de fechar)' }));
    await usuario.click(screen.getByRole('button', { name: 'Pré-visualizar' }));

    const resumo = await screen.findByTestId('resumo-importacao');
    expect(within(resumo).getByText('Ignorar').nextSibling).toHaveTextContent('1');
    expect(within(resumo).getByText('Sem alteração').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Sem preço: 1')).toBeInTheDocument();
    expect(screen.getByText('NCM inválido: 1')).toBeInTheDocument();
    expect(screen.getByText(/Ignoradas: Cor do rótulo/)).toBeInTheDocument();
    // Com erro há o filtro "Com erro" ligado: só a linha ignorada.
    const tabela = screen.getByRole('table', { name: 'Linhas da planilha' });
    expect(within(tabela).getByText('GELO 5KG')).toBeInTheDocument();
    expect(within(tabela).queryByText('CARVAO 3KG')).not.toBeInTheDocument();
    await usuario.click(screen.getByText('Todas'));
    expect(within(tabela).getByText('CARVAO 3KG')).toBeInTheDocument();
    // "O que muda" e as ações novas; filtro por ação.
    const brahma = within(tabela).getByText('CERV BRAHMA LT 350ML').closest('tr')!;
    expect(brahma).toHaveTextContent('Preço de venda: 4,49 → 4,99');
    expect(within(tabela).getByText('Sem alteração')).toBeInTheDocument();
    await usuario.click(screen.getAllByLabelText('Ação')[0]!);
    await usuario.click(await screen.findByRole('option', { name: 'Atualizar (1)', hidden: true }));
    expect(within(tabela).getByText('CERV BRAHMA LT 350ML')).toBeInTheDocument();
    expect(within(tabela).queryByText('AGUA CRYSTAL 500ML')).not.toBeInTheDocument();
    expect(within(tabela).queryByText('CARVAO 3KG')).not.toBeInTheDocument();

    const envio = chamadas.find((c) => c.url.pathname === '/api/importacoes/produtos/previa')!;
    expect(envio.cabecalhos.get('Content-Type')).toBeNull();
    await usuario.click(screen.getByRole('button', { name: 'Confirmar importação' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname === '/api/importacoes/produtos/confirmar')?.corpo).toEqual({
        arquivoId: ARQUIVO,
        lojaId: LOJA,
        atualizarEstoque: true,
        atualizarEstoqueMinimo: false,
        atualizarPrecos: true,
        criarMarcasCategorias: true,
        estoqueId: null,
        dataContagem: expect.any(String),
      }),
    );
    // O atalho é calculado na renderização: confere que é 23:00 local de um dia anterior a hoje (sem depender de a
    // renderização e esta conta caírem no mesmo dia, perto da meia-noite).
    const corpo = chamadas.find((c) => c.url.pathname === '/api/importacoes/produtos/confirmar')!.corpo as {
      dataContagem: string;
    };
    const enviada = new Date(corpo.dataContagem);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    expect([enviada.getHours(), enviada.getMinutes(), enviada.getSeconds()]).toEqual([23, 0, 0]);
    expect(enviada.getTime()).toBeLessThan(hoje.getTime());
    expect(hoje.getTime() - enviada.getTime()).toBeLessThanOrEqual(2 * 86_400_000);
    const resultado = await screen.findByTestId('resultado-importacao');
    expect(
      await within(resultado).findByText(/Importação concluída/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(
      within(resultado).getByText(
        /1 criado\(s\), 1 atualizado\(s\), 0 inativado\(s\), 1 sem alteração, 1 com erro/,
      ),
    ).toBeInTheDocument();
    expect(within(resultado).getByRole('link', { name: 'acerto Nº 12' })).toHaveAttribute(
      'href',
      '/estoque/acertos/a1',
    );
    expect(
      within(resultado).getByRole('link', { name: 'Baixar relatório de inconsistências' }),
    ).toHaveAttribute('href', 'http://s3/relatorio.xlsx');
  });

  it('ignorar sem erro (Excluir de produto inexistente) abre em "Todas"; ação escolhida sai de "Com erro"', async () => {
    const usuario = userEvent.setup();
    const semErro: PreviaImportacao = {
      ...PREVIA,
      resumo: { ...PREVIA.resumo, linhas: 2, criar: 0, sem_alteracao: 0, ignorar: 1, atualizar: 1 },
      linhas: [
        {
          linha: 2,
          acao: 'ignorar',
          descricao: 'NAO EXISTE',
          registroId: null,
          erros: [],
          avisos: [
            {
              codigo: 'exclusao_sem_produto',
              campo: 'excluir',
              mensagem: 'Marcado para excluir, mas o produto não existe: linha ignorada',
            },
          ],
        },
        PREVIA.linhas[2]!,
      ],
    };
    let previa = semErro;
    simularApi(...rotasSessao({ permissoes: ['produtos.importar'], lojas: LOJAS }), ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/importacoes/produtos/previa'
        ? { corpo: previa }
        : undefined,
    );
    const { container } = renderizarComSessao(<Importacao />, '/produtos/importacao');
    await waitFor(() => expect(screen.getAllByLabelText(/^Loja/)[0]).toBeInTheDocument());
    await usuario.click(screen.getAllByLabelText(/^Loja/)[0]!);
    await usuario.click(
      await screen.findByRole('option', { name: '1 - Loja 1 - Ice Beer Hermes', hidden: true }),
    );
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(entrada, new File(['IdProduto;Excluir\n1;S'], 'Produtos.csv', { type: 'text/csv' }));
    await usuario.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    const tabela = await screen.findByRole('table', { name: 'Linhas da planilha' });
    expect(within(tabela).getByText('NAO EXISTE')).toBeInTheDocument();
    expect(within(tabela).getByText('CERV BRAHMA LT 350ML')).toBeInTheDocument();

    // Com erro de verdade abre em "Com erro"; escolher "Atualizar" volta para "Todas" (senão a tabela ficaria vazia).
    previa = PREVIA;
    await usuario.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    await waitFor(() => expect(within(tabela).queryByText('CERV BRAHMA LT 350ML')).not.toBeInTheDocument());
    await usuario.click(screen.getAllByLabelText('Ação')[0]!);
    await usuario.click(await screen.findByRole('option', { name: 'Atualizar (1)', hidden: true }));
    expect(within(tabela).getByText('CERV BRAHMA LT 350ML')).toBeInTheDocument();
    expect(within(tabela).queryByText('Nenhuma linha neste filtro.')).not.toBeInTheDocument();
  });

  it('clientes não pedem loja; erro da API aparece', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: ['pessoas.importar'], lojas: LOJAS }), ({ url }) =>
      url.pathname === '/api/importacoes/clientes/previa'
        ? {
            status: 422,
            corpo: {
              codigo: 'VALIDACAO',
              mensagem: 'Nenhuma coluna reconhecida para identificar o registro',
            },
          }
        : undefined,
    );
    const { container } = renderizarComSessao(<Importacao tipoInicial="clientes" />, '/pessoas/importacao');
    await screen.findByRole('heading', { name: 'Importação' });
    expect(screen.queryByLabelText(/^Loja/)).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'O que importar' })).not.toBeInTheDocument();
    await usuario.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['Cor\nazul'], 'clientes.csv', { type: 'text/csv' }),
    );
    await usuario.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nenhuma coluna reconhecida');
  });
});

const DASHBOARD: DadosDashboard = {
  mes: '2026-10',
  rotuloMes: 'Outubro/2026',
  lojaId: null,
  geradoEm: '2026-10-30T15:00:00.000Z',
  pessoas: { ativas: 3, novasNoMes: 2 },
  produtos: { ativos: 5, semPreco: 1, ncmInvalido: 2 },
  vendas: {
    total: '0.00',
    quantidade: 0,
    ticketMedio: '0.00',
    porLoja: [
      {
        lojaId: LOJA,
        lojaCodigo: 1,
        lojaNome: 'Loja 1 - Ice Beer Hermes',
        lojaTreino: false,
        totalDia: '0.00',
        quantidadeDia: 0,
        totalMes: '0.00',
        quantidadeMes: 0,
      },
    ],
  },
  vendasPorDia: [],
  financeiro: null,
  pdvs: { total: 2, online: 1, offline: 1, comPendencias: 0 },
  alertasCriticos: { total: 0, porTipo: [], recentes: [] },
  sessoesAntigas: { total: 0, recentes: [] },
  estoqueBaixo: [
    {
      produtoId: 'p1',
      produtoNome: 'CERV BRAHMA LT 350ML',
      lojaNome: 'Loja 1 - Ice Beer Hermes',
      quantidade: '10.000',
      estoqueMinimo: '24.000',
    },
  ],
};

describe('Dashboard (ERP 6, casca)', () => {
  it('cards, vendas por loja, PDVs e estoque baixo; Filtrar manda o mês e a loja', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['dashboard.ver', 'produtos.ver', 'pessoas.ver'], lojas: LOJAS }),
      ({ url }) => (url.pathname === '/api/dashboard' ? { corpo: DASHBOARD } : undefined),
    );
    renderizarComSessao(<Dashboard />, '/');
    const cards = await screen.findByTestId('cards-dashboard');
    expect(within(cards).getByText('5')).toBeInTheDocument();
    expect(within(cards).getByText('1 sem preço · 2 NCM inválido')).toBeInTheDocument();
    expect(within(cards).getByText('R$ 0,00')).toBeInTheDocument();
    expect(within(cards).queryByText('Contas a pagar no mês')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Vendas por loja' })).toHaveTextContent(
      '1 - Loja 1 - Ice Beer Hermes',
    );
    expect(screen.getByText(/2 terminal\(is\): 1 online, 1 offline/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Estoque abaixo do mínimo' })).toHaveTextContent('10 / mín. 24');
    // Sem nada a resolver, os painéis do C14 não aparecem.
    expect(screen.queryByRole('table', { name: 'Alertas críticos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Caixas abertos há muito tempo' })).not.toBeInTheDocument();
    // Mês/ano em pt-BR (MonthPickerInput): abre o seletor e escolhe setembro.
    await usuario.click(screen.getByLabelText('Mês/Ano'));
    await usuario.click(await screen.findByRole('button', { name: 'set', hidden: true }));
    await usuario.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) => c.url.pathname === '/api/dashboard' && c.url.searchParams.get('mes') === '2026-09',
        ),
      ).toBe(true),
    );
  });
});

describe('Dashboard: alertas críticos e caixas esquecidos abertos (Fase 1C, C14; O11)', () => {
  it('mostra o total por tipo e os recentes com o link do terminal, e as sessões antigas com o link do fechamento', async () => {
    simularApi(
      ...rotasSessao({
        permissoes: ['dashboard.ver', 'terminais.ver', 'fechamentos_caixa.ver'],
        lojas: LOJAS,
      }),
      ({ url }) =>
        url.pathname === '/api/dashboard'
          ? {
              corpo: {
                ...DASHBOARD,
                alertasCriticos: {
                  total: 3,
                  porTipo: [
                    { tipo: 'EVENTO_COM_ERRO', quantidade: 1 },
                    { tipo: 'EVENTO_DESCARTADO', quantidade: 1 },
                    { tipo: 'EVENTO_DIVERGENTE', quantidade: 1 },
                  ],
                  recentes: [
                    {
                      id: 'a1',
                      tipo: 'EVENTO_DESCARTADO',
                      titulo: 'Caixa 02: venda L01-C02-000123 descartada',
                      mensagem: 'Venda de teste lançada por engano',
                      lojaNome: 'Loja 1 - Ice Beer Hermes',
                      terminalId: 't1',
                      criadoEm: '2026-10-30T14:00:00.000Z',
                    },
                    {
                      id: 'a2',
                      tipo: 'ATIVACAO_FORCA_BRUTA',
                      titulo: 'Ativações bloqueadas por 1 h',
                      mensagem: null,
                      lojaNome: null,
                      terminalId: null,
                      criadoEm: '2026-10-30T13:00:00.000Z',
                    },
                  ],
                },
                sessoesAntigas: {
                  total: 1,
                  recentes: [
                    {
                      sessaoId: 's1',
                      lojaNome: 'Loja 1 - Ice Beer Hermes',
                      numeroCaixa: 2,
                      operadorNome: 'MARIA',
                      abertaEm: '2026-10-28T11:00:00.000Z',
                      horas: 52,
                    },
                  ],
                },
              } satisfies DadosDashboard,
            }
          : undefined,
    );
    renderizarComSessao(<Dashboard />, '/');
    const alertas = await screen.findByRole('table', { name: 'Alertas críticos' });
    expect(screen.getByText('Alertas críticos (3)')).toBeInTheDocument();
    expect(screen.getByText('Evento com erro: 1')).toBeInTheDocument();
    expect(screen.getByText('Evento descartado: 1')).toBeInTheDocument();
    expect(screen.getByText('Evento divergente: 1')).toBeInTheDocument();
    expect(
      within(alertas).getByRole('link', { name: 'Caixa 02: venda L01-C02-000123 descartada' }),
    ).toHaveAttribute('href', '/cadastros/pdvs/t1');
    // Sem terminal (força bruta na ativação, da empresa): leva à listagem, onde fica o "Liberar ativações".
    expect(within(alertas).getByRole('link', { name: 'Ativações bloqueadas por 1 h' })).toHaveAttribute(
      'href',
      '/cadastros/pdvs',
    );
    expect(within(alertas).getByText('Empresa')).toBeInTheDocument();
    const sessoes = screen.getByRole('table', { name: 'Caixas abertos há muito tempo' });
    expect(
      within(sessoes).getByRole('link', { name: 'Loja 1 - Ice Beer Hermes · Caixa 02' }),
    ).toHaveAttribute('href', '/financeiro/fechamentos-caixa/s1');
    expect(sessoes).toHaveTextContent('aberto há 52 h');
    expect(sessoes).toHaveTextContent('MARIA');
  });
});

describe('Importação com "Atualizar estoque" no CD (F2-B11)', () => {
  const CD = '0190a000-0000-7000-8000-0000000000c9';
  it('o estoque sem loja dispensa a loja; a hora da contagem e o estoque vão na prévia; vários acertos no fim', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['produtos.importar', 'estoque_acertos.criar'], lojas: LOJAS }),
      ({ url }) =>
        url.pathname === '/api/estoques'
          ? {
              corpo: {
                itens: [
                  {
                    id: CD,
                    codigo: 9,
                    nome: 'CD - Estoque Ice Beer',
                    tipo: 'deposito',
                    lojaId: null,
                    lojaNome: null,
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
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/importacoes/produtos/previa'
          ? { corpo: PREVIA }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/importacoes/produtos/confirmar'
          ? { status: 202, corpo: { tarefaId: TAREFA } }
          : undefined,
      ({ url }) =>
        url.pathname === `/api/tarefas/${TAREFA}`
          ? {
              corpo: {
                id: TAREFA,
                status: 'concluida',
                progressoPct: 100,
                mensagem: null,
                erro: null,
                // O relatório passou da retenção: a API não assina mais o link.
                download: null,
                downloadExpirado: true,
                resultado: {
                  tipo: 'produtos',
                  criados: 0,
                  atualizados: 6000,
                  inativados: 0,
                  semAlteracao: 0,
                  comErro: 0,
                  comAviso: 0,
                  porAviso: {},
                  acertoId: 'a1',
                  acertoCodigo: 12,
                  acertos: [
                    { id: 'a1', codigo: 12 },
                    { id: 'a2', codigo: 13 },
                  ],
                },
              },
            }
          : undefined,
    );
    const { container } = renderizarComSessao(<Importacao />, '/produtos/importacao');
    await waitFor(() => expect(screen.getAllByLabelText(/^Loja/)[0]).toBeInTheDocument());
    await usuario.click(screen.getByLabelText(/Atualizar estoque \(a coluna/));
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(entrada, new File(['Ref;Estoque\nX;1'], 'cd.csv', { type: 'text/csv' }));
    // Sem loja e sem estoque escolhido, a loja continua obrigatória.
    await usuario.click(screen.getByRole('button', { name: /Data\/hora da contagem/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Agora' }));
    expect(screen.getByRole('button', { name: 'Pré-visualizar' })).toBeDisabled();
    await usuario.click(screen.getAllByLabelText(/^Estoque que recebe a contagem/)[0]!);
    await usuario.click(
      await screen.findByRole('option', { name: 'CD - Estoque Ice Beer (sem loja)', hidden: true }),
    );
    expect(screen.getByText('Opcional: só para o preço da loja e o estoque mínimo')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    await screen.findByTestId('resumo-importacao');
    const envio = chamadas.find((c) => c.url.pathname === '/api/importacoes/produtos/previa')!;
    const campos = envio.corpo as FormData;
    expect(campos.get('estoqueId')).toBe(CD);
    expect(campos.get('lojaId')).toBeNull();
    expect(new Date(campos.get('dataContagem') as string).getTime()).toBeLessThanOrEqual(Date.now());
    await usuario.click(screen.getByRole('button', { name: 'Confirmar importação' }));
    const resultado = await screen.findByTestId('resultado-importacao');
    expect(await within(resultado).findByRole('link', { name: 'acerto Nº 13' })).toHaveAttribute(
      'href',
      '/estoque/acertos/a2',
    );
    expect(within(resultado).getByText(/Estoque definido pelos/)).toBeInTheDocument();
    expect(within(resultado).getByText(/O relatório de inconsistências expirou/)).toBeInTheDocument();
    expect(
      within(resultado).queryByRole('link', { name: 'Baixar relatório de inconsistências' }),
    ).not.toBeInTheDocument();
  });
});
