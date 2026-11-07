import { AVISO_SEM_SEFAZ, type NotaEntradaDetalhe, type ResultadoImportacaoNfe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { CHAVE_TAREFAS } from '../../componentes/tarefas/tarefas';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { salvarArquivo } from '../../util/arquivos';
import { formatarXml, FormularioNotaEntrada, ListaNotasEntrada } from './NotasEntrada';
import { juntarArquivos, problemaDoEnvio } from './NotasEntradaEnvio';

vi.mock('../../util/arquivos', () => ({ salvarArquivo: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const CD = '0190a000-0000-7000-8000-0000000000e2';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d1';
const NOTA = '0190a000-0000-7000-8000-0000000000c1';
const FORNECEDOR = '0190a000-0000-7000-8000-0000000000b1';
const CHAVE = '35261099887766000105550010000123451123456786';
const TODAS = ['notas_entrada.ver', 'notas_entrada.importar', 'pessoas.ver'];

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/estoques'
      ? {
          corpo: {
            itens: [
              {
                id: ESTOQUE,
                codigo: 1,
                nome: 'Estoque Loja 1',
                tipo: 'loja',
                lojaId: LOJA,
                lojaNome: 'Loja 1',
              },
              {
                id: CD,
                codigo: 2,
                nome: 'CD - Estoque Ice Beer',
                tipo: 'deposito',
                lojaId: null,
                lojaNome: null,
              },
            ].map((e) => ({ ...e, ativo: true, versao: 1 })),
            total: 2,
            pagina: 1,
            tamanho: 'todos',
          },
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/tipos-estoque'
      ? { corpo: [{ id: DISPONIVEL, nome: 'Disponível', vendavel: true, padrao: true, ativo: true }] }
      : undefined,
  ({ url, metodo }: { url: URL; metodo: string }) =>
    metodo === 'GET' && url.pathname === '/api/notas-entrada'
      ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 20 } }
      : undefined,
];

function detalhe(parcial: Partial<NotaEntradaDetalhe> = {}): NotaEntradaDetalhe {
  return {
    id: NOTA,
    versao: 3,
    criadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoEm: '2026-11-05T12:00:00.000Z',
    atualizadoPorNome: 'MARIA SILVA',
    codigo: 7,
    chave: CHAVE,
    modelo: 55,
    serie: 1,
    numero: 12345,
    dataEmissao: '2026-10-20T11:15:00.000Z',
    dataRecebimento: '2026-11-05T12:00:00.000Z',
    dataMovimentacao: null,
    naturezaOperacao: 'VENDA DE MERCADORIA',
    emitenteCnpj: '99887766000105',
    emitenteNome: 'DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA',
    emitenteFantasia: 'DISTRIBUIDORA EXEMPLO',
    emitenteIe: '110042490114',
    emitenteUf: 'SP',
    destinatarioCnpj: '11222333000181',
    fornecedorId: FORNECEDOR,
    fornecedor: {
      id: FORNECEDOR,
      codigo: 9,
      tipo: 'PJ',
      nome: 'DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA',
      apelido: null,
      cpfCnpj: '99887766000105',
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
      produtos: '657.00',
      frete: '20.00',
      seguro: '0.00',
      desconto: '0.00',
      outras: '0.00',
      ipi: '0.00',
      ipiDevolvido: '0.00',
      ii: '0.00',
      icms: '0.00',
      icmsDesonerado: '0.00',
      icmsSt: '86.77',
      fcpSt: '0.00',
      total: '763.77',
    },
    transportadoraCnpj: null,
    transportadoraNome: null,
    modalidadeFrete: '0',
    volumes: [],
    informacoesComplementares: 'PEDIDO 4521.',
    protocoloNumero: '135260000000101',
    protocoloData: '2026-10-20T11:16:02.000Z',
    protocoloStatus: 100,
    assinatura: 'valida',
    assinaturaDetalhe: null,
    status: 'pendente',
    motivoIgnorada: null,
    criadoPorNome: 'MARIA SILVA',
    movimentadaPorNome: null,
    estornadaEm: null,
    estornadaPorNome: null,
    motivoEstorno: null,
    avisos: [AVISO_SEM_SEFAZ],
    vinculacao: {
      parcelasCusto: { incluiSt: true, incluiIpi: true, incluiFrete: true },
      custoBaseMargem: 'preco_custo',
      compraAtualizaPrecoCusto: 'perguntar',
      podeAlterarPreco: true,
      resolvidos: 0,
      total: 0,
    },
    itens: [],
    duplicatas: [
      { sequencia: 1, numero: '001', vencimento: '2026-11-19', valor: '700.00' },
      { sequencia: 2, numero: '002', vencimento: '2026-12-19', valor: '63.77' },
    ],
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
          { path: '/estoque/notas-entrada', element: comSessao(<ListaNotasEntrada />) },
          { path: '/estoque/notas-entrada/:id/:aba?', element: comSessao(<FormularioNotaEntrada />) },
        ],
      },
    ],
    url,
  );
}

const sessao = (permissoes = TODAS) =>
  rotasSessao({ permissoes, lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }] });

const arquivo = (nome: string, conteudo = '<nfeProc/>') => new File([conteudo], nome, { type: 'text/xml' });

describe('funções da tela (F2-B19)', () => {
  it('formatarXml: uma marca por linha, recuo por nível, texto na linha da marca', () => {
    expect(formatarXml('<?xml version="1.0"?><a x="1"><b>1</b><c/><d><e>texto &amp; mais</e></d></a>')).toBe(
      [
        '<?xml version="1.0"?>',
        '<a x="1">',
        '  <b>1</b>',
        '  <c/>',
        '  <d>',
        '    <e>texto &amp; mais</e>',
        '  </d>',
        '</a>',
      ].join('\n'),
    );
  });

  it('o envio: só .xml e .zip, o mesmo arquivo uma vez, até 100 arquivos e 20 MB', () => {
    const a = arquivo('a.xml');
    expect(juntarArquivos([a], [a, arquivo('b.ZIP')]).map((f) => f.name)).toEqual(['a.xml', 'b.ZIP']);
    expect(problemaDoEnvio([a, arquivo('danfe.pdf')])).toBe('Só .xml e .zip: danfe.pdf.');
    expect(problemaDoEnvio(Array.from({ length: 101 }, (_, i) => arquivo(`${i}.xml`)))).toMatch(
      /No máximo 100/,
    );
    const grande = arquivo('grande.zip');
    Object.defineProperty(grande, 'size', { value: 21 * 1024 * 1024 });
    expect(problemaDoEnvio([grande])).toMatch(/20 MB/);
    expect(problemaDoEnvio([a])).toBeNull();
  });
});

describe('Recebimento de NF-e (ERP 13.4; F2-B19)', () => {
  it('upload: escolhe os arquivos e o estoque, importa e mostra o resultado de cada arquivo com o link', async () => {
    const usuario = userEvent.setup();
    const resposta: ResultadoImportacaoNfe = {
      tarefaId: null,
      resumo: { importadas: 1, duplicadas: 1, recusadas: 1 },
      resultados: [
        {
          arquivo: 'notas.zip › 01.xml',
          situacao: 'importada',
          motivo: null,
          mensagem: null,
          chave: CHAVE,
          notaId: NOTA,
          notaCodigo: 7,
          numero: 12345,
          serie: 1,
          emitenteNome: 'DISTRIBUIDORA EXEMPLO',
          valorTotal: '763.77',
          fornecedorCriado: true,
          avisos: [],
        },
        {
          arquivo: 'notas.zip › 02.xml',
          situacao: 'duplicada',
          motivo: 'CHAVE_JA_IMPORTADA',
          mensagem: 'Esta NF-e já foi importada. (nota Nº 3)',
          chave: CHAVE,
          notaId: '0190a000-0000-7000-8000-0000000000c3',
          notaCodigo: 3,
          numero: null,
          serie: null,
          emitenteNome: null,
          valorTotal: null,
          fornecedorCriado: false,
          avisos: [],
        },
        {
          arquivo: 'nfce.xml',
          situacao: 'recusada',
          motivo: 'MODELO_NAO_ACEITO',
          mensagem: 'Só a NF-e modelo 55 é aceita.',
          chave: null,
          notaId: null,
          notaCodigo: null,
          numero: null,
          serie: null,
          emitenteNome: null,
          valorTotal: null,
          fornecedorCriado: false,
          avisos: [],
        },
      ],
    };
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/notas-entrada/importar' ? { corpo: resposta } : undefined,
    );
    const { container } = renderizar('/estoque/notas-entrada');
    await screen.findByText('Importar NF-e por arquivo');
    expect(screen.getByText(AVISO_SEM_SEFAZ)).toBeInTheDocument();
    const importar = screen.getByRole('button', { name: 'Importar NF' });
    expect(importar).toBeDisabled();
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(entrada, [arquivo('notas.zip'), arquivo('nfce.xml')]);
    expect(screen.getByText(/notas\.zip/)).toBeInTheDocument();
    await usuario.click(screen.getByRole('combobox', { name: 'Estoque de destino' }));
    await usuario.click(await screen.findByRole('option', { name: 'CD - Estoque Ice Beer', hidden: true }));
    await usuario.click(importar);
    const tabela = await screen.findByRole('table', { name: 'Resultado da importação' });
    const post = chamadas.find(
      (c) => c.metodo === 'POST' && c.url.pathname === '/api/notas-entrada/importar',
    )!;
    const corpo = post.corpo as FormData;
    expect(corpo.get('estoqueId')).toBe(CD);
    expect((corpo.getAll('arquivos') as File[]).map((f) => f.name)).toEqual(['notas.zip', 'nfce.xml']);
    expect(screen.getByText(/1 importada\(s\), 1 já importada\(s\), 1 recusada\(s\)/)).toBeInTheDocument();
    expect(within(tabela).getByRole('link', { name: 'Nº 12345/1' })).toHaveAttribute(
      'href',
      `/estoque/notas-entrada/${NOTA}`,
    );
    expect(within(tabela).getByRole('link', { name: 'Nota 3' })).toBeInTheDocument();
    expect(within(tabela).getByText('Fornecedor cadastrado pelo emitente.')).toBeInTheDocument();
    expect(within(tabela).getByText('Só a NF-e modelo 55 é aceita.')).toBeInTheDocument();
    expect(within(tabela).getByText('Já importada')).toBeInTheDocument();
  }, 30_000);

  it('arrastar e soltar os arquivos na área; o lote grande vira tarefa, acompanhada na tela até o resultado de cada arquivo', async () => {
    const usuario = userEvent.setup();
    // A tarefa responde "executando" até o teste mandar terminar (sem esperar o intervalo da consulta no relógio).
    let terminou = false;
    const resultadoTarefa: ResultadoImportacaoNfe = {
      tarefaId: 't1',
      resumo: { importadas: 0, duplicadas: 1, recusadas: 1 },
      resultados: [
        {
          arquivo: 'lote.zip › 07.xml',
          situacao: 'duplicada',
          motivo: 'CHAVE_JA_IMPORTADA',
          mensagem: 'Esta NF-e já foi importada.',
          chave: CHAVE,
          notaId: null,
          notaCodigo: null,
          numero: 7,
          serie: 1,
          emitenteNome: 'LATICINIOS SA',
          valorTotal: '886.80',
          fornecedorCriado: false,
          avisos: [],
        },
        {
          arquivo: 'lote.zip › 05.xml',
          situacao: 'recusada',
          motivo: 'LOJA_NAO_PERMITIDA',
          mensagem: 'A nota é de uma loja fora das suas lojas permitidas.',
          chave: CHAVE,
          notaId: null,
          notaCodigo: null,
          numero: 5,
          serie: 1,
          emitenteNome: null,
          valorTotal: null,
          fornecedorCriado: false,
          avisos: [
            {
              motivo: 'TOTAIS_DIVERGENTES',
              mensagem: 'Os totais da nota não batem com a soma dos itens.',
              detalhe: 'vNF',
            },
          ],
        },
      ],
    };
    simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'POST' && url.pathname === '/api/notas-entrada/importar')
        return {
          corpo: { tarefaId: 't1', resumo: { importadas: 0, duplicadas: 0, recusadas: 0 }, resultados: [] },
        };
      if (url.pathname === '/api/tarefas/t1') {
        return {
          corpo: !terminou
            ? {
                id: 't1',
                status: 'executando',
                progressoPct: 40,
                mensagem: 'Arquivo 1 de 2',
                resultado: null,
                erro: null,
              }
            : {
                id: 't1',
                status: 'concluida',
                progressoPct: 100,
                mensagem: null,
                resultado: resultadoTarefa,
                erro: null,
              },
        };
      }
      return undefined;
    });
    const { queryClient } = renderizar('/estoque/notas-entrada');
    const area = await screen.findByTestId('area-envio-nfe');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(area, { dataTransfer: { files: [arquivo('lote.zip')] } });
    expect(await screen.findByText(/lote\.zip/)).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Importar NF' }));
    // Enquanto roda: o progresso, com a mensagem da tarefa.
    expect(await screen.findByRole('progressbar', { name: 'Progresso da importação' })).toBeInTheDocument();
    expect(screen.getByText(/Arquivo 1 de 2/)).toBeInTheDocument();
    // No fim (a próxima consulta, que o intervalo faria, já acha a tarefa concluída): o resultado de cada arquivo,
    // com as recusas e os avisos que só a tarefa conhece.
    terminou = true;
    await queryClient.invalidateQueries({ queryKey: CHAVE_TAREFAS });
    const tabela = await screen.findByRole('table', { name: 'Resultado da importação' });
    expect(screen.getByText(/0 importada\(s\), 1 já importada\(s\), 1 recusada\(s\)/)).toBeInTheDocument();
    expect(
      within(tabela).getByText('A nota é de uma loja fora das suas lojas permitidas.'),
    ).toBeInTheDocument();
    expect(within(tabela).getByText(/Os totais da nota não batem/)).toBeInTheDocument();
    // A duplicada sem o link (a nota de uma loja que o usuário não vê).
    expect(within(tabela).queryByRole('link')).not.toBeInTheDocument();
  }, 15_000);

  it('a tarefa do lote grande que falha mostra a mensagem da falha', async () => {
    const usuario = userEvent.setup();
    simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'POST' && url.pathname === '/api/notas-entrada/importar')
        return {
          corpo: { tarefaId: 't2', resumo: { importadas: 0, duplicadas: 0, recusadas: 0 }, resultados: [] },
        };
      if (url.pathname === '/api/tarefas/t2')
        return {
          corpo: {
            id: 't2',
            status: 'falhou',
            progressoPct: 0,
            mensagem: null,
            resultado: null,
            erro: 'O usuário não tem mais a permissão de importar NF-e.',
          },
        };
      return undefined;
    });
    const { container } = renderizar('/estoque/notas-entrada');
    await screen.findByText('Importar NF-e por arquivo');
    const entrada = container.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(entrada, [arquivo('lote.zip')]);
    await usuario.click(screen.getByRole('button', { name: 'Importar NF' }));
    expect(await screen.findByText('A importação falhou')).toBeInTheDocument();
    expect(screen.getByText('O usuário não tem mais a permissão de importar NF-e.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Resultado da importação' })).not.toBeInTheDocument();
  });

  it('sem notas_entrada.importar: só a listagem, sem a área de upload', async () => {
    simularApi(...sessao(['notas_entrada.ver']), ...referencias);
    renderizar('/estoque/notas-entrada');
    await screen.findByRole('heading', { name: 'Recebimento de NF-e' });
    expect(screen.queryByText('Importar NF-e por arquivo')).not.toBeInTheDocument();
  });

  it('a nota: Dados com o aviso da SEFAZ e o destino, Duplicatas e o XML formatado com download', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined,
      ({ url }) =>
        url.pathname === `/api/notas-entrada/${NOTA}/xml`
          ? {
              corpo: {
                nomeArquivo: `${CHAVE}-nfe.xml`,
                xml: '<nfeProc><NFe><nNF>12345</nNF></NFe></nfeProc>',
              },
            }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'PUT' && url.pathname === `/api/notas-entrada/${NOTA}/destino`
          ? { corpo: detalhe({ estoqueId: CD, estoqueNome: 'CD - Estoque Ice Beer', versao: 4 }) }
          : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    await screen.findByRole('heading', { name: /NF-e Nº 12345\/1 – DISTRIBUIDORA EXEMPLO/ });
    expect(screen.getByText(AVISO_SEM_SEFAZ)).toBeInTheDocument();
    expect(screen.getByText('R$ 763,77')).toBeInTheDocument();
    expect(screen.getByText('99.887.766/0001-05')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '9 - DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA' }),
    ).toBeInTheDocument();
    // Destino: troca o estoque para o CD.
    const salvar = screen.getByRole('button', { name: 'Salvar destino' });
    expect(salvar).toBeDisabled();
    await usuario.click(screen.getByRole('combobox', { name: /^Estoque de destino/ }));
    await usuario.click(await screen.findByRole('option', { name: 'CD - Estoque Ice Beer', hidden: true }));
    await usuario.click(salvar);
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      versao: 3,
      lojaId: LOJA,
      estoqueId: CD,
      tipoEstoqueId: DISPONIVEL,
    });
    await usuario.click(screen.getByRole('tab', { name: 'Duplicatas (2)' }));
    const dup = await screen.findByRole('table', { name: 'Duplicatas da nota' });
    expect(within(dup).getByText('19/11/2026')).toBeInTheDocument();
    expect(within(dup).getByText('R$ 700,00')).toBeInTheDocument();
    await usuario.click(screen.getByRole('tab', { name: 'XML' }));
    const xml = await screen.findByLabelText('XML da nota');
    expect(xml.textContent).toBe('<nfeProc>\n  <NFe>\n    <nNF>12345</nNF>\n  </NFe>\n</nfeProc>');
    await usuario.click(screen.getByRole('button', { name: 'Baixar XML' }));
    // O arquivo baixado é o XML original, não o formatado.
    const [blob, nome] = vi.mocked(salvarArquivo).mock.calls[0]!;
    expect(nome).toBe(`${CHAVE}-nfe.xml`);
    expect(await blob.text()).toBe('<nfeProc><NFe><nNF>12345</nNF></NFe></nfeProc>');
  }, 30_000);

  it('"Ignorar nota" pede o motivo e manda a versão; a ignorada mostra "Reabrir"', async () => {
    const usuario = userEvent.setup();
    let atual = detalhe();
    const { chamadas } = simularApi(
      ...sessao(),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: atual } : undefined,
      ({ url, metodo }) => {
        if (metodo !== 'POST') return undefined;
        if (url.pathname === `/api/notas-entrada/${NOTA}/ignorar`) {
          atual = detalhe({ status: 'ignorada', motivoIgnorada: 'Brinde do fornecedor', versao: 4 });
          return { corpo: atual };
        }
        if (url.pathname === `/api/notas-entrada/${NOTA}/reabrir`) {
          atual = detalhe({ versao: 5 });
          return { corpo: atual };
        }
        return undefined;
      },
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    await usuario.click(await screen.findByRole('button', { name: 'Ignorar nota' }));
    const modal = await screen.findByRole('dialog', { name: 'Ignorar nota' });
    const confirmar = within(modal).getByRole('button', { name: 'Ignorar nota' });
    expect(confirmar).toBeDisabled();
    await usuario.type(within(modal).getByRole('textbox', { name: /Motivo/ }), 'Brinde do fornecedor');
    await usuario.click(confirmar);
    expect(await screen.findByText('Motivo: Brinde do fornecedor')).toBeInTheDocument();
    expect(chamadas.find((c) => c.url.pathname.endsWith('/ignorar'))!.corpo).toEqual({
      versao: 3,
      motivo: 'Brinde do fornecedor',
    });
    // Ignorada: sem o destino editável, e "Reabrir" volta a pendente.
    expect(screen.queryByRole('button', { name: 'Salvar destino' })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Reabrir' }));
    await waitFor(() => expect(screen.queryByText('Motivo: Brinde do fornecedor')).not.toBeInTheDocument());
    expect(chamadas.find((c) => c.url.pathname.endsWith('/reabrir'))!.corpo).toEqual({ versao: 4 });
  }, 30_000);
});

describe('Movimentar e estornar a NF-e (ERP 13.4; F2-B21)', () => {
  const MOVIMENTAR = [...TODAS, 'notas_entrada.movimentar', 'notas_entrada.estornar'];
  const movimentada = (parcial: Partial<NotaEntradaDetalhe> = {}) =>
    detalhe({
      status: 'movimentada',
      versao: 6,
      dataMovimentacao: '2026-11-05T13:00:00.000Z',
      movimentadaPorNome: 'JOAO ESTOQUE',
      ...parcial,
    });

  it('a pendente mostra "Movimentar" desabilitado; sem notas_entrada.movimentar, nem aparece', async () => {
    simularApi(...sessao(MOVIMENTAR), ...referencias, ({ url, metodo }) =>
      metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: detalhe() } : undefined,
    );
    const { unmount } = renderizar(`/estoque/notas-entrada/${NOTA}`);
    expect(await screen.findByRole('button', { name: 'Movimentar' })).toBeDisabled();
    unmount();
    simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}`
        ? { corpo: detalhe({ status: 'pronta' }) }
        : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    expect(await screen.findByRole('button', { name: 'Ignorar nota' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Movimentar' })).not.toBeInTheDocument();
  }, 30_000);

  it('a pronta: confirma, responde a pergunta do preço de custo (D49) e mostra quem movimentou', async () => {
    const usuario = userEvent.setup();
    let atual = detalhe({ status: 'pronta' });
    const { chamadas } = simularApi(
      ...sessao(MOVIMENTAR),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: atual } : undefined,
      ({ url, metodo, corpo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/notas-entrada/${NOTA}/movimentar`) return undefined;
        if ((corpo as { atualizarPrecoCusto: boolean | null }).atualizarPrecoCusto === null)
          return {
            status: 422,
            corpo: {
              codigo: 'REGRA_NEGOCIO',
              mensagem: 'O custo desta compra é diferente do preço de custo de 1 produto(s).',
              campos: { atualizarPrecoCusto: ['Atualizar o preço de custo?'] },
              detalhes: {
                precosCusto: [
                  {
                    produtoId: FORNECEDOR,
                    nome: 'CERVEJA PILSEN LATA 350ML',
                    atual: '4.0000',
                    novo: '3.8847',
                  },
                ],
              },
            },
          };
        atual = movimentada();
        return { corpo: atual };
      },
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    const confirmar = await screen.findByRole('dialog', { name: 'Movimentar a NF-e' });
    expect(within(confirmar).getByText(/NF-e Nº 12345\/1/)).toBeInTheDocument();
    await usuario.click(within(confirmar).getByRole('button', { name: 'Movimentar' }));
    const pergunta = await screen.findByRole('dialog', { name: 'Atualizar o preço de custo?' });
    expect(within(pergunta).getByText('CERVEJA PILSEN LATA 350ML')).toBeInTheDocument();
    expect(within(pergunta).getByText('R$ 3,8847')).toBeInTheDocument();
    await usuario.click(within(pergunta).getByRole('button', { name: 'Sim, atualizar' }));
    expect(await screen.findByTestId('movimentacao-nota')).toHaveTextContent(
      /Movimentada em .* por JOAO ESTOQUE/,
    );
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/movimentar')).map((c) => c.corpo)).toEqual([
      { versao: 3, atualizarPrecoCusto: null },
      { versao: 3, atualizarPrecoCusto: true },
    ]);
    // Movimentada: sem "Movimentar" e sem "Ignorar nota"; com "Estornar".
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Movimentar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ignorar nota' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estornar' })).toBeInTheDocument();
  }, 30_000);

  it('o erro da movimentação aparece abaixo do cabeçalho', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...sessao(MOVIMENTAR),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}`
          ? { corpo: detalhe({ status: 'pronta' }) }
          : undefined,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/notas-entrada/${NOTA}/movimentar`
          ? {
              status: 422,
              corpo: { codigo: 'REGRA_NEGOCIO', mensagem: 'O estoque "Estoque Loja 1" está inativo.' },
            }
          : undefined,
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    await usuario.click(await screen.findByRole('button', { name: 'Movimentar' }));
    const confirmar = await screen.findByRole('dialog', { name: 'Movimentar a NF-e' });
    await usuario.click(within(confirmar).getByRole('button', { name: 'Movimentar' }));
    expect(await screen.findByText('O estoque "Estoque Loja 1" está inativo.')).toBeInTheDocument();
  }, 30_000);

  it('estornar: pede o motivo; o saldo negativo (D56 com aviso) mostra a lista e devolve a lista confirmada', async () => {
    const usuario = userEvent.setup();
    const negativo = {
      produtoId: FORNECEDOR,
      nome: 'CERVEJA PILSEN LATA 350ML',
      lote: null,
      saldoAtual: '10.000',
      saldoFinal: '-110.000',
    };
    let atual = movimentada();
    const { chamadas } = simularApi(
      ...sessao(MOVIMENTAR),
      ...referencias,
      ({ url, metodo }) =>
        metodo === 'GET' && url.pathname === `/api/notas-entrada/${NOTA}` ? { corpo: atual } : undefined,
      ({ url, metodo, corpo }) => {
        if (metodo !== 'POST' || url.pathname !== `/api/notas-entrada/${NOTA}/estornar`) return undefined;
        if (!(corpo as { confirmarNegativo: unknown[] }).confirmarNegativo.length)
          return {
            status: 422,
            corpo: {
              codigo: 'REGRA_NEGOCIO',
              mensagem: 'O saldo ficará negativo em: CERVEJA PILSEN LATA 350ML (saldo 10 → -110).',
              campos: { confirmarNegativo: ['O saldo ficará negativo: confirme o estorno.'] },
              detalhes: { saldosNegativos: [negativo] },
            },
          };
        atual = movimentada({
          status: 'estornada',
          versao: 7,
          estornadaEm: '2026-11-05T14:00:00.000Z',
          estornadaPorNome: 'MARIA SILVA',
          motivoEstorno: 'Devolvida ao fornecedor',
        });
        return { corpo: atual };
      },
    );
    renderizar(`/estoque/notas-entrada/${NOTA}`);
    expect(await screen.findByTestId('movimentacao-nota')).toHaveTextContent('JOAO ESTOQUE');
    await usuario.click(screen.getByRole('button', { name: 'Estornar' }));
    const modal = await screen.findByRole('dialog', { name: 'Estornar NF-e' });
    const botao = within(modal).getByRole('button', { name: 'Estornar' });
    expect(botao).toBeDisabled();
    await usuario.type(within(modal).getByLabelText(/Motivo do estorno/), 'Devolvida ao fornecedor');
    await usuario.click(botao);
    expect(await within(modal).findByText(/CERVEJA PILSEN LATA 350ML: de 10 para -110/)).toBeInTheDocument();
    await usuario.click(within(modal).getByRole('button', { name: 'Estornar mesmo assim' }));
    expect(await screen.findByTestId('movimentacao-nota')).toHaveTextContent(
      /Estornada em .* por MARIA SILVA: Devolvida ao fornecedor/,
    );
    expect(chamadas.filter((c) => c.url.pathname.endsWith('/estornar')).map((c) => c.corpo)).toEqual([
      { versao: 6, motivo: 'Devolvida ao fornecedor', confirmarNegativo: [] },
      { versao: 6, motivo: 'Devolvida ao fornecedor', confirmarNegativo: [negativo] },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Estornar' })).not.toBeInTheDocument();
  }, 30_000);
});
