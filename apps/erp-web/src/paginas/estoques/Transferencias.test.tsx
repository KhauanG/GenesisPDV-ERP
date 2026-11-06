import type {
  ItemSugestaoReposicao,
  ItemTransferenciaDetalhe,
  ProdutoOpcao,
  RomaneioTransferencia,
  StatusTransferencia,
  TransferenciaDetalhe,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import {
  acoesTransferencia,
  corpoConferencia,
  corpoTratamento,
  dadosTransferenciaEmBlocos,
  errosConferencia,
  errosLinhaTransferencia,
  linhasConferencia,
  linhasTratamento,
  mesclarSugestao,
  novaLinhaTransferencia,
  quantidadeNaEmbalagem,
  type ContextoAcoesTransferencia,
} from './transferenciaItens';
import { FormularioTransferencia, ListaTransferencias } from './Transferencias';
import { RomaneioTransferenciaImpressao } from './TransferenciasRomaneio';

afterEach(() => vi.unstubAllGlobals());

const CD = '0190a000-0000-7000-8000-0000000000e1';
const LOJA2 = '0190a000-0000-7000-8000-0000000000e2';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d1';
const TRANSF = '0190a000-0000-7000-8000-0000000000c1';
const ITEM1 = '0190a000-0000-7000-8000-0000000000b1';
const ITEM2 = '0190a000-0000-7000-8000-0000000000b2';
const TODAS = [
  'transferencias.ver',
  'transferencias.criar',
  'transferencias.enviar',
  'transferencias.receber',
  'transferencias.cancelar',
  'produtos.ver_custo',
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
const GELO: ProdutoOpcao = {
  ...PILSEN,
  id: '0190a000-0000-7000-8000-000000000012',
  codigo: 12,
  nome: 'GELO 5KG',
};
const FARDO = { unidadeSigla: 'FD', fator: '12.000' };

const ANTIGO = '0190a000-0000-7000-8000-0000000000e3';
const ESTOQUE = (id: string, nome: string, tipo: 'loja' | 'deposito', ativo = true) => ({
  id,
  codigo: id === CD ? 1 : id === LOJA2 ? 2 : 3,
  nome,
  tipo,
  ativo,
  lojaId: tipo === 'loja' ? 'loja-2' : null,
  lojaNome: tipo === 'loja' ? 'Loja 2 - Bairro' : null,
});

/**
 * As referências; `visiveis` = o `GET /transferencias/origens` de quem está na tela (os permitidos), `inativos` os
 * permitidos já inativados. O `GET /estoques` (que exige `estoques.ver`) responde 403: as telas não dependem dele.
 */
const referencias = (visiveis: string[] = [CD, LOJA2], inativos: string[] = []) => [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/estoques'
      ? { status: 403, corpo: { codigo: 'SEM_PERMISSAO', mensagem: 'Sem permissão.' } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/transferencias/origens'
      ? {
          corpo: [
            ESTOQUE(CD, 'CD - Estoque Ice Beer', 'deposito', !inativos.includes(CD)),
            ESTOQUE(ANTIGO, 'Depósito antigo', 'deposito', !inativos.includes(ANTIGO)),
            ESTOQUE(LOJA2, 'Estoque Loja 2', 'loja', !inativos.includes(LOJA2)),
          ].filter((e) => visiveis.includes(e.id)),
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/transferencias/destinos'
      ? {
          corpo: [
            {
              id: CD,
              codigo: 1,
              nome: 'CD - Estoque Ice Beer',
              tipo: 'deposito',
              lojaId: null,
              lojaNome: null,
            },
            {
              id: LOJA2,
              codigo: 2,
              nome: 'Estoque Loja 2',
              tipo: 'loja',
              lojaId: 'loja-2',
              lojaNome: 'Loja 2 - Bairro',
            },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/tipos-estoque'
      ? { corpo: [{ id: DISPONIVEL, nome: 'Disponível', vendavel: true, padrao: true, ativo: true }] }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/produtos/busca' ? { corpo: [PILSEN, GELO] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === '/api/transferencias/dados-produtos'
      ? {
          corpo: {
            produtos: (url.searchParams.get('produtoIds') ?? '').split(',').map((produtoId) => ({
              produtoId,
              saldoOrigem: '100.000',
              embalagem: produtoId === PILSEN.id ? FARDO : null,
              lotes: [],
            })),
          },
        }
      : undefined,
];

const item = (parcial: Partial<ItemTransferenciaDetalhe> = {}): ItemTransferenciaDetalhe => ({
  id: ITEM1,
  sequencia: 1,
  produtoId: PILSEN.id,
  produto: PILSEN,
  variacaoId: null,
  loteId: null,
  lote: null,
  validade: null,
  quantidadeEnviada: '60.000',
  quantidadeRecebida: null,
  diferenca: '0.000',
  tratamentoDivergencia: null,
  divergenciaTratadaEm: null,
  custoUnitario: null,
  saldoOrigem: '40.000',
  embalagem: FARDO,
  ...parcial,
});

function detalhe(
  status: StatusTransferencia = 'rascunho',
  parcial: Partial<TransferenciaDetalhe> = {},
): TransferenciaDetalhe {
  const enviada = status !== 'rascunho';
  return {
    id: TRANSF,
    versao: 3,
    criadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoPorNome: 'MARIA SILVA',
    codigo: 7,
    estoqueOrigemId: CD,
    estoqueOrigemNome: 'CD - Estoque Ice Beer',
    estoqueDestinoId: LOJA2,
    estoqueDestinoNome: 'Estoque Loja 2',
    tipoEstoqueId: DISPONIVEL,
    tipoEstoqueNome: 'Disponível',
    data: '2026-11-05',
    motivo: 'Reposição semanal',
    observacoes: null,
    status,
    enviadaEm: enviada ? '2026-11-05T13:00:00.000Z' : null,
    enviadaPorNome: enviada ? 'MARIA SILVA' : null,
    recebidaEm: null,
    recebidaPorNome: null,
    canceladaEm: null,
    canceladaPorNome: null,
    motivoCancelamento: null,
    nfeExternaChave: null,
    nfeExternaNumero: null,
    qtdItens: 1,
    itens: [item(enviada ? { custoUnitario: '4.0000' } : {})],
    alertaParada: null,
    origemPermitida: true,
    destinoPermitido: true,
    ...parcial,
  };
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
          { path: '/estoque/transferencias', element: comSessao(<ListaTransferencias />) },
          { path: '/estoque/transferencias/novo', element: comSessao(<FormularioTransferencia />) },
          {
            path: '/estoque/transferencias/:id/romaneio',
            element: comSessao(<RomaneioTransferenciaImpressao />),
          },
          { path: '/estoque/transferencias/:id', element: comSessao(<FormularioTransferencia />) },
        ],
      },
    ],
    url,
  );
}

const sessao = (permissoes = TODAS) => rotasSessao({ permissoes });

/** O detalhe servido pelo `GET` (mutável: as ações trocam a situação). */
function rotaDetalhe(atual: () => TransferenciaDetalhe) {
  return ({ url, metodo }: { url: URL; metodo: string }) =>
    metodo === 'GET' && url.pathname === `/api/transferencias/${TRANSF}` ? { corpo: atual() } : undefined;
}

const ctx = (parcial: Partial<ContextoAcoesTransferencia> = {}): ContextoAcoesTransferencia => ({
  novo: false,
  sujo: false,
  pode: (p) => TODAS.includes(p),
  origemPermitida: true,
  destinoPermitido: true,
  ...parcial,
});
const lista = (s: Set<string>) => [...s].sort();

describe('botões por situação e permissão (as transições do ERP 13.7)', () => {
  it('rascunho: salvar, sugerir, enviar, excluir e cancelar com a origem; o novo não exclui nem cancela', () => {
    expect(lista(acoesTransferencia('rascunho', ctx()))).toEqual(
      ['cancelar', 'enviar', 'excluir', 'romaneio', 'salvar', 'sugerir'].sort(),
    );
    expect(lista(acoesTransferencia('rascunho', ctx({ novo: true, origemPermitida: false })))).toEqual(
      ['enviar', 'salvar', 'sugerir'].sort(),
    );
    // Quem só vê pelo destino (a loja) não mexe no rascunho do CD.
    expect(lista(acoesTransferencia('rascunho', ctx({ origemPermitida: false })))).toEqual(['romaneio']);
    // Só `enviar` (sem `criar`): envia o gravado, mas não o alterado nem o novo (gravar antes exige `criar`).
    const soEnviar = (p: string) => p === 'transferencias.enviar';
    expect(lista(acoesTransferencia('rascunho', ctx({ pode: soEnviar })))).toEqual(['enviar', 'romaneio']);
    expect(lista(acoesTransferencia('rascunho', ctx({ pode: soEnviar, sujo: true })))).toEqual(['romaneio']);
    expect(lista(acoesTransferencia('rascunho', ctx({ pode: soEnviar, novo: true })))).toEqual([]);
  });

  it('em trânsito: receber com o destino, cancelar o envio e a NF-e com a origem', () => {
    expect(lista(acoesTransferencia('em_transito', ctx()))).toEqual(
      ['cancelar', 'nfe', 'receber', 'romaneio'].sort(),
    );
    // A loja (só o destino): recebe e imprime.
    expect(lista(acoesTransferencia('em_transito', ctx({ origemPermitida: false })))).toEqual([
      'receber',
      'romaneio',
    ]);
    // O CD (só a origem): cancela o envio, não recebe pela loja.
    expect(lista(acoesTransferencia('em_transito', ctx({ destinoPermitido: false })))).toEqual(
      ['cancelar', 'nfe', 'romaneio'].sort(),
    );
    const semReceber = (p: string) => p !== 'transferencias.receber';
    expect(acoesTransferencia('em_transito', ctx({ pode: semReceber })).has('receber')).toBe(false);
  });

  it('com divergência: tratar com a origem ou o destino; recebida e cancelada sem transição', () => {
    expect(acoesTransferencia('recebida_divergencia', ctx({ origemPermitida: false })).has('tratar')).toBe(
      true,
    );
    expect(acoesTransferencia('recebida_divergencia', ctx({ destinoPermitido: false })).has('tratar')).toBe(
      true,
    );
    expect(
      acoesTransferencia(
        'recebida_divergencia',
        ctx({ origemPermitida: false, destinoPermitido: false }),
      ).has('tratar'),
    ).toBe(false);
    expect(lista(acoesTransferencia('recebida', ctx()))).toEqual(['nfe', 'romaneio']);
    expect(lista(acoesTransferencia('cancelada', ctx()))).toEqual(['romaneio']);
  });
});

describe('grade, sugestão, conferência e embalagem (regras puras)', () => {
  it('a linha do rascunho: produto com estoque, quantidade > 0 e inteira no produto sem fração', () => {
    const l = { ...novaLinhaTransferencia(), produto: PILSEN, quantidade: '60' };
    expect(errosLinhaTransferencia(l)).toEqual({});
    expect(errosLinhaTransferencia({ ...l, quantidade: '0' })).toEqual({
      quantidade: 'Quantidade maior que zero',
    });
    expect(errosLinhaTransferencia({ ...l, quantidade: '1,5' })).toEqual({
      quantidade: 'O produto não aceita quantidade fracionada',
    });
    expect(errosLinhaTransferencia({ ...l, produto: { ...PILSEN, tipo: 'kit' } }).produto).toBe(
      'Tipo de produto sem estoque próprio',
    );
  });

  it('a sugestão atualiza o produto já na grade (sem lote), acrescenta os novos e mantém o resto', () => {
    const comLote = { ...novaLinhaTransferencia(), produto: PILSEN, loteId: 'lote-1', quantidade: '5' };
    const semLote = { ...novaLinhaTransferencia(), produto: PILSEN, quantidade: '12' };
    const sugerido = (produto: ProdutoOpcao, quantidade: string): ItemSugestaoReposicao => ({
      produtoId: produto.id,
      produto,
      estoqueMinimo: '24.000',
      estoqueMaximo: '72.000',
      saldoDestino: '10.000',
      emTransito: '12.000',
      saldoOrigem: '100.000',
      embalagem: FARDO,
      quantidade,
    });
    const m = mesclarSugestao(
      [comLote, semLote, novaLinhaTransferencia()],
      [sugerido(PILSEN, '60.000'), sugerido(GELO, '7.000')],
    );
    expect(m).toMatchObject({ atualizados: 1, novos: 1 });
    expect(m.linhas.map((l) => [l.produto?.nome ?? null, l.loteId, l.quantidade])).toEqual([
      ['CERV PILSEN LT 350ML', 'lote-1', '5'],
      ['CERV PILSEN LT 350ML', '', '60'],
      ['GELO 5KG', '', '7'],
      [null, '', ''],
    ]);
  });

  it('a conferência começa com a enviada, não passa dela e manda todos os itens', () => {
    const linhas = linhasConferencia([
      item(),
      item({ id: ITEM2, sequencia: 2, quantidadeEnviada: '10.000' }),
    ]);
    expect(linhas.map((l) => l.recebida)).toEqual(['60', '10']);
    expect(errosConferencia({ ...linhas[0]!, recebida: '61' }).recebida).toMatch(/^Acima da enviada \(60\)/);
    expect(errosConferencia({ ...linhas[0]!, recebida: '' }).recebida).toMatch(/Informe a quantidade/);
    expect(errosConferencia({ ...linhas[0]!, recebida: '0' })).toEqual({});
    expect(corpoConferencia([linhas[0]!, { ...linhas[1]!, recebida: '8' }], 3)).toEqual({
      versao: 3,
      receberTudo: false,
      itens: [
        { itemId: ITEM1, quantidadeRecebida: '60' },
        { itemId: ITEM2, quantidadeRecebida: '8' },
      ],
    });
  });

  it('o tratamento só lista o que tem diferença sem tratar e manda só o escolhido', () => {
    const itens = [
      item({ quantidadeRecebida: '58.000', diferenca: '2.000' }),
      item({ id: ITEM2, diferenca: '1.000', tratamentoDivergencia: 'perda' }),
      item({ id: 'sem-dif', quantidadeRecebida: '60.000' }),
    ];
    const linhas = linhasTratamento(itens);
    expect(linhas.map((l) => l.chave)).toEqual([ITEM1]);
    expect(corpoTratamento(linhas, 5)).toEqual({ versao: 5, itens: [] });
    expect(corpoTratamento([{ ...linhas[0]!, tratamento: 'retorno_origem' }], 5)).toEqual({
      versao: 5,
      itens: [{ itemId: ITEM1, tratamento: 'retorno_origem' }],
    });
  });

  it('a quantidade na embalagem do romaneio e a consulta em blocos', async () => {
    expect(quantidadeNaEmbalagem('60.000', FARDO, 'UN')).toBe('5 FD');
    expect(quantidadeNaEmbalagem('63.000', FARDO, 'UN')).toBe('5 FD + 3 UN');
    expect(quantidadeNaEmbalagem('7.5', null, 'KG')).toBe('7,5 KG');
    const ids = Array.from({ length: 230 }, (_, i) => `p${i}`);
    const pedidos: number[] = [];
    const r = await dadosTransferenciaEmBlocos(ids, async (bloco) => {
      pedidos.push(bloco.length);
      return {
        produtos: bloco.map((produtoId) => ({ produtoId, saldoOrigem: '0', embalagem: null, lotes: [] })),
      };
    });
    expect(pedidos).toEqual([100, 100, 30]);
    expect(r.produtos).toHaveLength(230);
  });
});

describe('telas da transferência (F2-B27)', () => {
  it('listagem: colunas, situação e o filtro do destino fora dos visíveis', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias([CD, ANTIGO], [ANTIGO]), ({ url }) =>
      url.pathname === '/api/transferencias'
        ? {
            corpo: {
              itens: [
                {
                  id: TRANSF,
                  codigo: 7,
                  estoqueOrigemId: CD,
                  estoqueOrigemNome: 'CD - Estoque Ice Beer',
                  estoqueDestinoId: LOJA2,
                  estoqueDestinoNome: 'Estoque Loja 2',
                  data: '2026-11-05',
                  enviadaEm: '2026-11-05T13:00:00.000Z',
                  recebidaEm: null,
                  qtdItens: 3,
                  status: 'em_transito',
                  versao: 3,
                },
              ],
              total: 1,
              pagina: 1,
              tamanho: 20,
            },
          }
        : undefined,
    );
    renderizar('/estoque/transferencias?status=em_transito');
    const linha = await screen.findByRole('link', { name: '7' });
    const tr = linha.closest('tr')!;
    expect(within(tr).getByText('Estoque Loja 2')).toBeInTheDocument();
    expect(within(tr).getByText('Em trânsito')).toBeInTheDocument();
    expect(within(tr).getByText('05/11/2026')).toBeInTheDocument();
    const busca = chamadas.find((c) => c.url.pathname === '/api/transferencias')!;
    expect(busca.url.searchParams.get('status')).toBe('em_transito');
    expect(busca.url.searchParams.get('ordenar')).toBe('codigo:desc');
    expect(screen.getByRole('link', { name: /Nova transferência/ })).toBeInTheDocument();
    // A origem: os permitidos, também o inativo (o documento antigo continua achável).
    const entrada = (rotulo: RegExp) => screen.getAllByLabelText(rotulo).find((e) => e.tagName === 'INPUT')!;
    const opcoes = (rotulo: RegExp) =>
      within(screen.getAllByLabelText(rotulo).find((e) => e.getAttribute('role') === 'listbox')!)
        .getAllByRole('option', { hidden: true })
        .map((o) => o.textContent ?? '');
    await usuario.click(entrada(/^Estoque origem$/));
    await waitFor(() =>
      expect(opcoes(/^Estoque origem$/)).toEqual(['CD - Estoque Ice Beer', 'Depósito antigo']),
    );
    // O destino: os permitidos mais os de `/transferencias/destinos` fora deles (a Loja 2 que o CD não vê).
    await usuario.click(entrada(/^Estoque destino$/));
    await waitFor(() =>
      expect(opcoes(/^Estoque destino$/)).toEqual([
        'CD - Estoque Ice Beer',
        'Depósito antigo',
        'Estoque Loja 2',
      ]),
    );
    await usuario.click(screen.getByRole('option', { name: 'Estoque Loja 2', hidden: true }));
    await usuario.click(screen.getByRole('button', { name: 'Pesquisar' }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/transferencias' && c.url.searchParams.get('estoqueDestinoId') === LOJA2,
        ),
      ).toBe(true),
    );
    expect(chamadas.some((c) => c.url.pathname === '/api/estoques')).toBe(false);
  }, 30_000);

  it('rascunho com a origem inativada depois: quem tem a origem ainda salva, troca a origem, exclui e cancela', async () => {
    simularApi(
      ...sessao(),
      ...referencias([CD, LOJA2], [CD]),
      rotaDetalhe(() => detalhe('rascunho')),
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    await screen.findByRole('heading', { name: 'Transferência Nº 7' });
    expect(await screen.findByRole('button', { name: 'Excluir' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Salvar/ })).toBeEnabled();
    // A origem gravada (inativa) continua no seletor, que não fica travado; as outras opções são as ativas.
    const origem = screen.getAllByLabelText(/^Estoque de origem/).find((e) => e.tagName === 'INPUT')!;
    expect(origem).toHaveValue('CD - Estoque Ice Beer');
    expect(origem).toBeEnabled();
  }, 30_000);

  it('rascunho: "Sugerir reposição" preenche a grade; o 403 do destino tem mensagem própria; enviar com 422 no item', async () => {
    const usuario = userEvent.setup();
    let negar = true;
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias(),
      rotaDetalhe(() => detalhe('rascunho', { itens: [], qtdItens: 0 })),
      ({ url }) => {
        if (url.pathname !== '/api/transferencias/sugestao-reposicao') return undefined;
        if (negar) {
          negar = false;
          return {
            status: 403,
            corpo: {
              codigo: 'SEM_PERMISSAO',
              mensagem: 'O estoque de destino está fora dos seus estoques permitidos.',
              campos: { estoqueDestinoId: ['Fora dos seus estoques permitidos'] },
            },
          };
        }
        return {
          corpo: {
            itens: [
              {
                produtoId: PILSEN.id,
                produto: PILSEN,
                estoqueMinimo: '24.000',
                estoqueMaximo: '72.000',
                saldoDestino: '10.000',
                emTransito: '12.000',
                saldoOrigem: '100.000',
                embalagem: FARDO,
                quantidade: '60.000',
              },
            ],
            avisos: [],
          },
        };
      },
      ({ url, metodo, corpo }) =>
        metodo === 'PUT' && url.pathname === `/api/transferencias/${TRANSF}`
          ? {
              corpo: detalhe('rascunho', {
                versao: 4,
                itens: [
                  item({
                    quantidadeEnviada: (corpo as { itens: [{ quantidade: string }] }).itens[0].quantidade,
                  }),
                ],
              }),
            }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/transferencias/${TRANSF}/enviar`
          ? {
              status: 422,
              corpo: {
                codigo: 'REGRA_NEGOCIO',
                mensagem: 'Saldo insuficiente na origem.',
                campos: {
                  'itens.0.quantidade': ['Saldo insuficiente de CERV PILSEN LT 350ML na origem: 40 UN'],
                },
              },
            }
          : undefined,
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    await screen.findByRole('heading', { name: 'Transferência Nº 7' });
    const sugerir = await screen.findByRole('button', { name: 'Sugerir reposição' });
    await waitFor(() => expect(sugerir).toBeEnabled());
    await usuario.click(sugerir);
    expect(
      await screen.findByText(/está fora dos seus estoques permitidos\. Monte a carga à mão/),
    ).toBeInTheDocument();
    await usuario.click(sugerir);
    const grade = screen.getByRole('table', { name: 'Itens da transferência' });
    await waitFor(() => expect(within(grade).getByLabelText('Quant. da linha 1')).toHaveValue('60'));
    expect(await within(grade).findByText('5 FD')).toBeInTheDocument();
    expect(await within(grade).findByText('100')).toBeInTheDocument();
    const consulta = chamadas.find((c) => c.url.pathname === '/api/transferencias/sugestao-reposicao')!;
    expect(Object.fromEntries(consulta.url.searchParams)).toEqual({
      origem: CD,
      destino: LOJA2,
      tipoEstoqueId: DISPONIVEL,
    });
    // Salvar e enviar: grava (PUT com a versão) e envia; o 422 do saldo volta no item.
    await usuario.click(screen.getByRole('button', { name: 'Salvar e enviar' }));
    await usuario.click(await screen.findByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Saldo insuficiente na origem.')).toBeInTheDocument();
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(put.corpo).toMatchObject({
      versao: 3,
      estoqueOrigemId: CD,
      estoqueDestinoId: LOJA2,
      itens: [{ id: null, produtoId: PILSEN.id, loteId: null, quantidade: '60' }],
    });
    expect(chamadas.find((c) => c.url.pathname.endsWith('/enviar'))!.corpo).toEqual({ versao: 4 });
    await waitFor(() =>
      expect(within(grade).getByLabelText('Quant. da linha 1')).toHaveAttribute('aria-invalid', 'true'),
    );
  }, 30_000);

  it('em trânsito na loja: o alerta parado, Receber com diferença e o aviso da divergência', async () => {
    const usuario = userEvent.setup();
    let atual = detalhe('em_transito', {
      itens: [
        item(),
        item({
          id: ITEM2,
          sequencia: 2,
          produtoId: GELO.id,
          produto: GELO,
          quantidadeEnviada: '10.000',
          embalagem: null,
        }),
      ],
      qtdItens: 2,
      alertaParada: {
        situacao: 'em_transito',
        titulo: 'Transferência Nº 7 em trânsito há 4 dias',
        mensagem:
          'Enviada de CD - Estoque Ice Beer para Estoque Loja 2 em 01/11/2026 e ainda não recebida (2 item(ns)).',
        dias: 4,
        abertoEm: '2026-11-05T13:00:00.000Z',
      },
      origemPermitida: false,
    });
    const { chamadas } = simularApi(
      // A loja: só o destino entre os permitidos.
      ...sessao(),
      ...referencias([LOJA2]),
      rotaDetalhe(() => atual),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/transferencias/${TRANSF}/receber`) return undefined;
        atual = detalhe('recebida_divergencia', {
          versao: 4,
          recebidaEm: '2026-11-06T10:00:00.000Z',
          recebidaPorNome: 'JOÃO LOJA',
          itens: [
            item({ quantidadeRecebida: '60.000' }),
            item({
              id: ITEM2,
              sequencia: 2,
              produtoId: GELO.id,
              produto: GELO,
              quantidadeEnviada: '10.000',
              quantidadeRecebida: '8.000',
              diferenca: '2.000',
              embalagem: null,
            }),
          ],
          qtdItens: 2,
          origemPermitida: false,
        });
        return { corpo: atual };
      },
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    expect(await screen.findByTestId('alerta-parada')).toHaveTextContent(
      'Transferência Nº 7 em trânsito há 4 dias',
    );
    // A loja não tem a origem: sem "Cancelar envio" nem a NF-e de fora.
    expect(screen.queryByRole('button', { name: 'Cancelar envio' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'NF-e de fora' })).not.toBeInTheDocument();
    await usuario.click(await screen.findByRole('button', { name: 'Receber' }));
    const modal = await screen.findByRole('dialog', { name: 'Receber a transferência Nº 7' });
    const conferencia = within(modal).getByRole('table', { name: 'Conferência do recebimento' });
    expect(within(conferencia).getByText('5 FD')).toBeInTheDocument();
    const recebida2 = within(conferencia).getByLabelText('Recebida da linha 2');
    await usuario.clear(recebida2);
    await usuario.type(recebida2, '11');
    expect(within(modal).getByRole('button', { name: 'Confirmar recebimento' })).toBeDisabled();
    await usuario.clear(recebida2);
    await usuario.type(recebida2, '8');
    expect(within(modal).getByTestId('aviso-divergencia')).toHaveTextContent('1 item(ns) com diferença');
    await usuario.click(within(modal).getByRole('button', { name: 'Confirmar recebimento' }));
    expect(await screen.findByText(/recebida com divergência: trate a diferença/)).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/receber'))!.corpo).toEqual({
      versao: 3,
      receberTudo: false,
      itens: [
        { itemId: ITEM1, quantidadeRecebida: '60' },
        { itemId: ITEM2, quantidadeRecebida: '8' },
      ],
    });
    // Agora com divergência: a grade mostra a diferença "A tratar" e o botão Tratar diferença (a loja tem o destino).
    const grade = screen.getByRole('table', { name: 'Itens da transferência' });
    expect(await within(grade).findByText('A tratar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tratar diferença' })).toBeInTheDocument();
  }, 30_000);

  it('o conferente da loja, só com ver e receber (sem `estoques.ver`): "Receber tudo como enviado"', async () => {
    const usuario = userEvent.setup();
    let atual = detalhe('em_transito', { origemPermitida: false });
    const { chamadas } = simularApi(
      ...sessao(['transferencias.ver', 'transferencias.receber']),
      ...referencias([LOJA2]),
      rotaDetalhe(() => atual),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/transferencias/${TRANSF}/receber`) return undefined;
        atual = detalhe('recebida', {
          versao: 4,
          recebidaEm: '2026-11-06T10:00:00.000Z',
          itens: [item({ quantidadeRecebida: '60.000' })],
          origemPermitida: false,
        });
        return { corpo: atual };
      },
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    await usuario.click(await screen.findByRole('button', { name: 'Receber' }));
    const modal = await screen.findByRole('dialog', { name: 'Receber a transferência Nº 7' });
    await usuario.click(within(modal).getByRole('button', { name: 'Receber tudo como enviado' }));
    // A confirmação abre por cima da conferência.
    const confirmacao = await screen.findByRole('dialog', { name: 'Receber tudo como enviado' });
    expect(confirmacao).toHaveTextContent('chegou exatamente o que foi enviado');
    await usuario.click(within(confirmacao).getByRole('button', { name: 'Receber tudo' }));
    expect(
      await screen.findByText('Transferência Nº 7 recebida: o estoque de destino foi atualizado'),
    ).toBeInTheDocument();
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/receber')).map((c) => c.corpo)).toEqual([
      { versao: 3, receberTudo: true, itens: [] },
    ]);
    expect(chamadas.some((c) => c.url.pathname === '/api/estoques')).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Receber a transferência Nº 7' })).not.toBeInTheDocument(),
    );
  }, 30_000);

  it('com divergência: o CD trata a diferença como perda', async () => {
    const usuario = userEvent.setup();
    let atual = detalhe('recebida_divergencia', {
      recebidaEm: '2026-11-06T10:00:00.000Z',
      itens: [item({ quantidadeRecebida: '58.000', diferenca: '2.000' })],
      destinoPermitido: false,
    });
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias([CD]),
      rotaDetalhe(() => atual),
      ({ url, metodo }) => {
        if (metodo !== 'POST' || !url.pathname.endsWith('/tratar-divergencia')) return undefined;
        atual = detalhe('recebida', {
          versao: 5,
          recebidaEm: '2026-11-06T10:00:00.000Z',
          itens: [item({ quantidadeRecebida: '58.000', diferenca: '2.000', tratamentoDivergencia: 'perda' })],
          destinoPermitido: false,
        });
        return { corpo: atual };
      },
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    await usuario.click(await screen.findByRole('button', { name: 'Tratar diferença' }));
    const modal = await screen.findByRole('dialog', { name: /Tratar a diferença/ });
    expect(within(modal).getByRole('button', { name: 'Confirmar tratamento' })).toBeDisabled();
    await usuario.selectOptions(within(modal).getByLabelText('Tratamento da linha 1'), 'perda');
    await usuario.click(within(modal).getByRole('button', { name: 'Confirmar tratamento' }));
    expect(await screen.findByText('Diferença tratada: transferência Nº 7 recebida')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/tratar-divergencia'))!.corpo).toEqual({
      versao: 3,
      itens: [{ itemId: ITEM1, tratamento: 'perda' }],
    });
    expect(await screen.findByText(/Transferência recebida: o documento não muda mais/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tratar diferença' })).not.toBeInTheDocument();
  }, 30_000);

  it('em trânsito no CD: cancelar o envio com motivo; o 409 vira o aviso de outro usuário', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias([CD]),
      rotaDetalhe(() => detalhe('em_transito', { destinoPermitido: false })),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname.endsWith('/cancelar')
          ? {
              status: 409,
              corpo: {
                codigo: 'CONFLITO_VERSAO',
                mensagem: 'Registro alterado por outro usuário.',
                detalhes: { alteradoPorNome: 'JOÃO LOJA', alteradoEm: '2026-11-06T10:00:00.000Z' },
              },
            }
          : undefined,
    );
    renderizar(`/estoque/transferencias/${TRANSF}`);
    // O CD não tem o destino: não recebe pela loja.
    await screen.findByRole('button', { name: 'Cancelar envio' });
    expect(screen.queryByRole('button', { name: 'Receber' })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    const modal = await screen.findByRole('dialog', { name: 'Cancelar o envio' });
    await usuario.type(within(modal).getByLabelText(/Motivo do cancelamento/), 'Caminhão quebrou');
    await usuario.click(within(modal).getByRole('button', { name: 'Cancelar envio' }));
    expect(await screen.findByText('Registro alterado por outro usuário')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/cancelar'))!.corpo).toEqual({
      versao: 3,
      motivo: 'Caminhão quebrou',
    });
  }, 30_000);

  it('romaneio: cabeçalho da empresa, origem, destino, itens na embalagem e as assinaturas', async () => {
    const romaneio: RomaneioTransferencia = {
      empresa: {
        razaoSocial: 'ICE BEER COMERCIO DE BEBIDAS LTDA',
        nomeFantasia: 'Ice Beer',
        cnpj: '11222333000181',
        ie: '123456789',
        endereco: 'Av. Higienópolis, 500, Centro, Londrina/PR, CEP 86020-000',
        telefone: '4333334444',
      },
      origem: {
        estoqueId: CD,
        estoqueCodigo: 1,
        estoqueNome: 'CD - Estoque Ice Beer',
        endereco: 'Galpão 3',
        lojaNome: null,
        lojaRazaoSocial: null,
        lojaCnpj: null,
      },
      destino: {
        estoqueId: LOJA2,
        estoqueCodigo: 2,
        estoqueNome: 'Estoque Loja 2',
        endereco: 'Rua das Flores, 10, Centro, Londrina/PR',
        lojaNome: 'Loja 2 - Bairro',
        lojaRazaoSocial: 'ICE BEER LOJA 2 LTDA',
        lojaCnpj: '11222333000262',
      },
      transferencia: detalhe('em_transito', { itens: [item({ quantidadeEnviada: '63.000' })] }),
      geradoEm: '2026-11-06T10:00:00.000Z',
    };
    const print = vi.fn();
    vi.stubGlobal('print', print);
    simularApi(...sessao(), ({ url }) =>
      url.pathname === `/api/transferencias/${TRANSF}/romaneio` ? { corpo: romaneio } : undefined,
    );
    renderizar(`/estoque/transferencias/${TRANSF}/romaneio?imprimir=1`);
    expect(
      await screen.findByRole('heading', { name: 'Romaneio de transferência Nº 7 – Em trânsito' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('romaneio-empresa')).toHaveTextContent('CNPJ 11.222.333/0001-81');
    expect(screen.getByTestId('romaneio-origem')).toHaveTextContent('Origem: 1 - CD - Estoque Ice Beer');
    expect(screen.getByTestId('romaneio-destino')).toHaveTextContent(
      'Loja: Loja 2 - Bairro (ICE BEER LOJA 2 LTDA)',
    );
    const itens = screen.getByRole('table', { name: 'Itens do romaneio' });
    expect(within(itens).getByText('FD × 12')).toBeInTheDocument();
    expect(within(itens).getByText('5 FD + 3 UN')).toBeInTheDocument();
    expect(within(itens).getByText('63 UN')).toBeInTheDocument();
    expect(within(itens).getByText('Conferido')).toBeInTheDocument();
    expect(screen.getByTestId('romaneio-assinaturas')).toHaveTextContent('Recebido e conferido por');
    await waitFor(() => expect(print).toHaveBeenCalled(), { timeout: 2000 });
  }, 30_000);
});
