/**
 * Tributação só gravada no formulário do produto (F2-B52; ERP 8.2.10, 8.2.15; MD 3.6.3, 3.6.9; restrição do dono:
 * nada fiscal até a fase fiscal): o bloco Tributação mostra o aviso fixo "Somente registro…", e a Tributação por UF, o
 * ST retido por loja, a unidade tributável e o Imposto Seletivo vão no corpo do "Salvar" (sem mexer no preço); a loja
 * só com o ST entra no corpo; o erro do ST volta à linha certa da grade; e a cópia não leva o ST (é das compras do
 * produto de origem). Dados inventados.
 */
import { AVISO_TRIBUTACAO_SO_REGISTRO, type ProdutoDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { errosParaFormulario, paraCorpo, paraValores, produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const LT = '0190a000-0000-7000-8000-0000000000a3';
const LOJA1 = '0190a000-0000-7000-8000-0000000000f1';
const LOJA2 = '0190a000-0000-7000-8000-0000000000f2';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const PERMISSOES = ['produtos.ver', 'produtos.criar', 'produtos.editar', 'produtos.ver_custo'];
const LOJAS = [
  { id: LOJA1, codigo: 1, nome: 'Loja 1', ativa: true },
  { id: LOJA2, codigo: 2, nome: 'Loja 2', ativa: true },
];

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

const ST_VAZIO = {
  stBcRetidoUnitario: null,
  stAliquotaPct: null,
  stIcmsSubstitutoUnitario: null,
  stIcmsRetidoUnitario: null,
  fcpStBcRetidoUnitario: null,
  fcpStAliquotaPct: null,
  fcpStRetidoUnitario: null,
  stAtualizadoEm: null,
};

const PR: ProdutoDetalhe['tributacaoUf'][number] = {
  uf: 'PR',
  cfopVendaEstado: '5405',
  icmsSituacao: '60',
  icmsModalidadeBc: null,
  icmsAliquota: '19.5000',
  icmsReducaoBcPct: null,
  icmsModalidadeBcst: '4',
  icmsMvaPct: '70.0001',
  icmsAliquotaSt: null,
  fcpAliquota: '2.0000',
  fcpStAliquota: null,
  beneficioFiscalCodigo: null,
};

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
    codigo: 70,
    nome: 'CERVEJA PILSEN LATA 350ML',
    tipo: 'simples',
    ativo: true,
    controlaEstoque: true,
    unidadeId: UN,
    unidadeSigla: 'UN',
    ncm: '22030000',
    cest: '0302100',
    precoCusto: '3.0000',
    custoMedio: '3.0000',
    markupPct: '66.3333',
    precoVenda: '4.9900',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [
      {
        lojaId: LOJA1,
        estoqueMinimo: null,
        estoqueMaximo: null,
        precoVenda: '5.4900',
        ativoNaLoja: true,
        acrescimoGelada: null,
        ...ST_VAZIO,
      },
    ],
    tributacaoUf: [],
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

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? {
          corpo: [
            { id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
            { id: LT, sigla: 'L', descricao: 'Litro', permiteFracao: true },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/ufs'
      ? {
          corpo: [
            { sigla: 'PR', nome: 'Paraná' },
            { sigla: 'SC', nome: 'Santa Catarina' },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/tipos-habilitados'
      ? { corpo: { tipos: ['simples', 'materia_prima'], usaFornecedores: false } }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
];

const corpoDoPut = (chamadas: Array<{ metodo: string; url: URL; corpo: unknown }>) =>
  chamadas.filter((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)[0]?.corpo as
    Record<string, unknown> | undefined;

describe('formulário ⇄ corpo da tributação só gravada (F2-B52)', () => {
  const lojas = [
    { id: LOJA1, nome: 'Loja 1' },
    { id: LOJA2, nome: 'Loja 2' },
  ];

  it('o detalhe vira o formulário (4 casas no ST e na UF) e volta no corpo; a loja só com o ST entra no corpo', () => {
    const v = paraValores(
      detalhe({
        unidadeTributavelId: LT,
        fatorTributavel: '0.350',
        isCst: '000',
        isAliquotaEspecifica: '1.5000',
        isUnidade: 'L',
        tributacaoUf: [PR],
        lojas: [
          {
            ...detalhe().lojas[0]!,
            stBcRetidoUnitario: '6.1234',
            stAliquotaPct: '19.5000',
            stAtualizadoEm: '2026-11-12T15:00:00Z',
          },
        ],
      }),
      lojas,
    );
    expect(v.unidadeTributavelId).toBe(LT);
    expect(v.fatorTributavel).toBe('0,35');
    expect(v.isAliquotaEspecifica).toBe('1,5');
    expect(v.lojas[0]).toMatchObject({ stBcRetidoUnitario: '6,1234', stAliquotaPct: '19,5' });
    expect(v.tributacaoUf[0]).toMatchObject({ uf: 'PR', icmsAliquota: '19,5', icmsMvaPct: '70,0001' });
    // A Loja 2 só com o ST preenchido entra no corpo (cria a linha da loja).
    v.lojas[1]!.stIcmsRetidoUnitario = '0,7373';
    const c = paraCorpo(v);
    expect(c).toMatchObject({
      unidadeTributavelId: LT,
      fatorTributavel: '0,35',
      isCst: '000',
      isClassificacao: null,
      isAliquotaEspecifica: '1,5',
      isUnidade: 'L',
      precoVenda: '4,99',
    });
    expect(c.tributacaoUf).toEqual([
      {
        uf: 'PR',
        cfopVendaEstado: '5405',
        icmsSituacao: '60',
        icmsModalidadeBc: null,
        icmsModalidadeBcst: '4',
        beneficioFiscalCodigo: null,
        icmsAliquota: '19,5',
        icmsReducaoBcPct: null,
        icmsMvaPct: '70,0001',
        icmsAliquotaSt: null,
        fcpAliquota: '2',
        fcpStAliquota: null,
      },
    ]);
    const corpoLojas = c.lojas as Array<Record<string, unknown>>;
    expect(corpoLojas.map((l) => l.lojaId)).toEqual([LOJA1, LOJA2]);
    expect(corpoLojas[0]).toMatchObject({ stBcRetidoUnitario: '6,1234', stIcmsRetidoUnitario: null });
    expect(corpoLojas[1]).toMatchObject({ stIcmsRetidoUnitario: '0,7373', precoVenda: null });
    // O erro do ST da segunda loja do corpo volta à linha dela na grade.
    expect(errosParaFormulario(v, { 'lojas.1.stIcmsRetidoUnitario': 'Valor inválido' })).toEqual({
      'lojas.1.stIcmsRetidoUnitario': 'Valor inválido',
    });
    v.lojas[1]!.stIcmsRetidoUnitario = '';
    v.lojas = [
      v.lojas[0]!,
      { ...v.lojas[1]!, lojaId: 'sem-dados' },
      { ...v.lojas[1]!, lojaId: LOJA2, stAliquotaPct: '101' },
    ];
    expect(errosParaFormulario(v, { 'lojas.1.stAliquotaPct': 'x' })).toEqual({
      'lojas.2.stAliquotaPct': 'x',
    });
  });

  it('a cópia leva a tributação do produto e a da UF, mas não o ST retido das lojas', () => {
    const v = paraValores(
      detalhe({
        isCst: '000',
        tributacaoUf: [PR],
        lojas: [
          { ...detalhe().lojas[0]!, stIcmsRetidoUnitario: '0.7373', stAtualizadoEm: '2026-11-12T15:00:00Z' },
        ],
      }),
      lojas,
      true,
    );
    expect(v.isCst).toBe('000');
    expect(v.tributacaoUf.map((t) => t.uf)).toEqual(['PR']);
    expect(v.lojas[0]).toMatchObject({ stIcmsRetidoUnitario: '', stAtualizadoEm: null, existente: false });
  });

  it('o detalhe da API de antes desta versão (sem os campos) abre sem erro', () => {
    const { tributacaoUf: _t, unidadeTributavelId: _u, ...antigo } = detalhe();
    const v = paraValores(antigo as ProdutoDetalhe, lojas);
    expect(v.tributacaoUf).toEqual([]);
    expect(v.unidadeTributavelId).toBeNull();
  });
});

describe('<FormularioProduto>: bloco Tributação (F2-B52)', () => {
  it('o aviso fixo; a UF do PR e o ST retido da Loja 1 vão no corpo do Salvar, sem mexer no preço', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Tributação/ }));
    expect(screen.getByText(AVISO_TRIBUTACAO_SO_REGISTRO)).toBeInTheDocument();

    // Tributação por UF: a linha do PR.
    await usuario.click(screen.getByRole('button', { name: 'Inserir UF' }));
    const linha = screen.getByTestId('tributacao-uf-0');
    await usuario.click(within(linha).getByRole('combobox', { name: 'UF da linha 1' }));
    await usuario.click(await screen.findByRole('option', { name: 'PR', hidden: true }));
    await usuario.type(within(linha).getByLabelText('CST/CSOSN'), '60');
    await usuario.type(within(linha).getByLabelText('Alíquota %'), '19,5');
    await usuario.type(within(linha).getByLabelText('FCP %'), '2');

    // ST retido da Loja 1 e o Imposto Seletivo.
    await usuario.type(screen.getByLabelText('BC do ST retido (vBCSTRet) Loja 1'), '6,1234');
    await usuario.type(screen.getByLabelText('ICMS-ST retido (vICMSSTRet) Loja 1'), '0,7373');
    await usuario.type(screen.getByLabelText('IS – situação (CST)'), '000');

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    const corpo = corpoDoPut(chamadas)!;
    expect(corpo.tributacaoUf).toEqual([
      expect.objectContaining({ uf: 'PR', icmsSituacao: '60', icmsAliquota: '19,5', fcpAliquota: '2' }),
    ]);
    expect(corpo.isCst).toBe('000');
    expect(corpo.precoVenda).toBe('4,99');
    const lojasCorpo = corpo.lojas as Array<Record<string, unknown>>;
    expect(lojasCorpo).toEqual([
      expect.objectContaining({
        lojaId: LOJA1,
        precoVenda: '5,49',
        stBcRetidoUnitario: '6,1234',
        stIcmsRetidoUnitario: '0,7373',
        stAliquotaPct: null,
      }),
    ]);
  }, 30_000);

  it('o erro do ST (zod) marca e abre só o bloco Tributação e cai no campo da loja, sem chamar a API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    const controle = (nome: RegExp) => screen.getByRole('button', { name: nome });
    await usuario.click(await screen.findByRole('button', { name: /^Tributação/ }));
    await usuario.type(screen.getByLabelText('Alíquota ST % (pST) Loja 2'), '101');
    // Fecha a Tributação antes do Salvar: quem a reabre é o erro.
    await usuario.click(controle(/^Tributação/));
    expect(controle(/^Tributação/)).toHaveAttribute('aria-expanded', 'false');
    expect(controle(/^Lojas/)).toHaveAttribute('aria-expanded', 'false');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('Informe um percentual entre 0 e 100')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(false);
    // O marcador "!" e o bloco aberto só na Tributação; o bloco Lojas (sem o campo) fica sem marcador e fechado.
    await waitFor(() => expect(controle(/^Tributação/)).toHaveAttribute('aria-expanded', 'true'));
    expect(within(controle(/^Tributação/)).getByText('!')).toBeInTheDocument();
    expect(controle(/^Lojas/)).toHaveAttribute('aria-expanded', 'false');
    expect(within(controle(/^Lojas/)).queryByText('!')).toBeNull();
  }, 30_000);

  it('sem produtos.ver_custo, o ST retido mostra só os percentuais e o corpo não leva os valores em R$ (D68)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES.filter((p) => p !== 'produtos.ver_custo'), lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? {
              corpo: detalhe({
                precoCusto: null,
                custoMedio: null,
                markupPct: null,
                lojas: [{ ...detalhe().lojas[0]!, stAliquotaPct: '19.5000' }],
              }),
            }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Tributação/ }));
    expect(screen.getByLabelText('Alíquota ST % (pST) Loja 1')).toHaveValue('19,5');
    expect(screen.getByLabelText('FCP-ST retido % (pFCPSTRet) Loja 1')).toBeInTheDocument();
    expect(screen.queryByLabelText('ICMS do substituto (vICMSSubstituto) Loja 1')).toBeNull();
    expect(screen.queryByLabelText('BC do ST retido (vBCSTRet) Loja 1')).toBeNull();
    expect(screen.queryByText('ICMS-ST retido (vICMSSTRet)')).toBeNull();
    await usuario.clear(screen.getByLabelText('Alíquota ST % (pST) Loja 1'));
    await usuario.type(screen.getByLabelText('Alíquota ST % (pST) Loja 1'), '18');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    const [loja] = corpoDoPut(chamadas)!.lojas as Array<Record<string, unknown>>;
    expect(loja).toMatchObject({ lojaId: LOJA1, stAliquotaPct: '18', fcpStAliquotaPct: null });
    // Ausentes: a API mantém os gravados (ela também ignora os que viessem).
    for (const c of [
      'stBcRetidoUnitario',
      'stIcmsSubstitutoUnitario',
      'stIcmsRetidoUnitario',
      'fcpStBcRetidoUnitario',
      'fcpStRetidoUnitario',
    ])
      expect(loja).not.toHaveProperty(c);
  }, 30_000);
});
