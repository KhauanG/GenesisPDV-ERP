/**
 * Tributação só gravada no cadastro do produto (Fase 2, F2-B52; ERP 8.2.10, 8.2.15; MD 3.6.3, 3.6.9; README da API ›
 * decisão 195; restrição do dono: nada fiscal até a fase fiscal). O critério de pronto: o contador preenche a
 * tributação do PR (a Tributação por UF, o Imposto Seletivo, a unidade tributável) e o ST retido da Loja 1 pelo
 * `PUT /api/produtos/:id` do ERP, e os valores ficam gravados (nas casas das colunas) e auditados (no histórico do
 * produto), sem efeito em preço nem em venda: o preço não muda, o histórico de preços não ganha linha, e a Tributação
 * por UF continua descendo ao caixa da loja da UF como antes (o protocolo e o `Esquema.g.cs` não mudam).
 *
 * Também: os campos e as listas ausentes mantêm o gravado (o ERP antigo, o "Definir NCM" e a importação); a linha
 * igual não é regravada (sem versão nova à toa); a versão do cadastro cobre a Tributação por UF (409); o ST retido só
 * nas lojas permitidas ao usuário, e o de outra loja fica como está; os valores em R$ do ST são custo (D68: sem
 * `produtos.ver_custo` não aparecem no detalhe nem no histórico, e o corpo não os grava); as FKs e os CHECKs viram
 * 422 no campo; tirar a UF a exclui logicamente (tombstone ao caixa); a exclusão do produto a leva junto; e as
 * permissões são as do formulário. Dados inventados.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  respostaPullSchema,
  type Ativar,
  type DetalheHistoricoProduto,
  type ProdutoDetalhe,
  type RespostaHistoricoProdutos,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
/** O contador: Gerente só da Loja 1 (edita o produto; o ST retido só da loja dele). */
let contador: string;
let contadorId: string;
/** Gerente só da Loja 1 sem `produtos.ver_custo` (D68: os valores em R$ do ST são custo). */
let semCusto: string;
let vendedor: string;
let un: string;
let lt: string;
let loja1: string;
let loja2: string;
let terminal: { id: string; token: string };
let produto: string;

const bearer = (tk = admin) => ({ Authorization: `Bearer ${tk}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.12.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

/** Terminal da Loja 1 (no PR) ativado pelo `/sync/ativar` real (só o pull é usado). */
async function ativarTerminal(): Promise<{ id: string; token: string }> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja1],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja1, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.terminal_id as string, token: r.body.token as string };
}

type Linha = Record<string, unknown>;

/** O pull do `catalogo` desde `desde`, até o fim: a última versão de cada linha por tabela, e o cursor novo. */
async function puxar(desde = 0): Promise<{ linhas: Map<string, Map<string, Linha>>; cursor: number }> {
  const linhas = new Map<string, Map<string, Linha>>();
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=catalogo&desde=${cursor}&limite=2000`)
      .set(cabecalhos(terminal.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    for (const a of r.body.alteracoes as Array<{ tabela: string; linha: Linha }>) {
      if (!linhas.has(a.tabela)) linhas.set(a.tabela, new Map());
      linhas.get(a.tabela)!.set(a.linha.id as string, a.linha);
    }
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { linhas, cursor };
  }
  throw new Error('pull não terminou');
}
const daTabela = (p: Awaited<ReturnType<typeof puxar>>, tabela: string) => [
  ...(p.linhas.get(tabela)?.values() ?? []),
];

const detalhe = async (id: string, token = admin) => {
  const r = await amb.http().get(`/api/produtos/${id}`).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ProdutoDetalhe;
};

/** O `PUT` como o formulário manda: o detalhe com as mudanças (o zod ignora os campos só de leitura). */
async function alterar(id: string, mudancas: Record<string, unknown>, token = admin, base?: ProdutoDetalhe) {
  const atual = base ?? (await detalhe(id, token));
  return amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer(token))
    .send({ ...atual, ...mudancas });
}

/** O corpo do ERP de antes desta versão: sem os campos fiscais novos, sem a lista e sem o ST nas lojas. */
function corpoErpAntigo(d: ProdutoDetalhe): Record<string, unknown> {
  const {
    tributacaoUf: _t,
    unidadeTributavelId: _u,
    fatorTributavel: _f,
    isCst: _c,
    isClassificacao: _cl,
    isAliquotaPct: _a,
    isAliquotaEspecifica: _e,
    isUnidade: _un,
    ...resto
  } = d;
  return {
    ...resto,
    lojas: d.lojas.map((l) => ({
      lojaId: l.lojaId,
      estoqueMinimo: l.estoqueMinimo,
      estoqueMaximo: l.estoqueMaximo,
      precoVenda: l.precoVenda,
      ativoNaLoja: l.ativoNaLoja,
      acrescimoGelada: l.acrescimoGelada,
    })),
  };
}

const ultimaAuditoria = async (id: string) =>
  (
    await consultar<{ descricao: string; localizacao: string }>(
      emp.nomeBanco,
      `select descricao, localizacao from auditoria where entidade = 'produtos' and registro_id = $1
        order by ocorrido_em desc limit 1`,
      [id],
    )
  )[0]!;

/** Quantas linhas o histórico de preços do produto tem (a tributação não pode criar nenhuma). */
const linhasHistoricoPrecos = async () =>
  (
    await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from produtos_historico_precos where produto_id = $1',
      [produto],
    )
  )[0]!.n;

/** A Tributação do PR que o contador digita (como o formulário manda: texto com vírgula). */
const TRIBUTACAO_PR = {
  uf: 'PR',
  cfopVendaEstado: '5405',
  icmsSituacao: '60',
  icmsModalidadeBc: '3',
  icmsAliquota: '19,5',
  icmsReducaoBcPct: '',
  icmsModalidadeBcst: '4',
  icmsMvaPct: '70,0001',
  icmsAliquotaSt: '19,5',
  fcpAliquota: '2',
  fcpStAliquota: '2',
  beneficioFiscalCodigo: '',
};

/** O ST retido por unidade da Loja 1 (valores inventados). */
const ST_LOJA1 = {
  stBcRetidoUnitario: '6,1234',
  stAliquotaPct: '19,5',
  stIcmsSubstitutoUnitario: '0,4567',
  stIcmsRetidoUnitario: '0,7373',
  fcpStBcRetidoUnitario: '6,1234',
  fcpStAliquotaPct: '2',
  fcpStRetidoUnitario: '0,1225',
};

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer());
  const sigla = (s: string) =>
    (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === s)!.id;
  un = sigla('UN');
  lt = sigla('L');
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2');
  // As duas no PR (Curitiba): a Tributação do PR desce ao caixa da Loja 1.
  await consultar(
    emp.nomeBanco,
    "update lojas set uf = 'PR', municipio_ibge = 4106902 where id in ($1, $2)",
    [loja1, loja2],
  );
  contadorId = await criarUsuario(emp.nomeBanco, { login: 'contador', perfil: 'gerente', lojas: [loja1] });
  contador = await amb.entrar(emp.codigo, 'contador', SENHA_TESTE);
  const semCustoId = await criarUsuario(emp.nomeBanco, {
    login: 'semcusto',
    perfil: 'gerente',
    lojas: [loja1],
  });
  await consultar(
    emp.nomeBanco,
    "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'produtos.ver_custo', 'negar')",
    [semCustoId],
  );
  semCusto = await amb.entrar(emp.codigo, 'semcusto', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor' });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  terminal = await ativarTerminal();
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({
      nome: 'CERVEJA PILSEN LATA 350ML',
      unidadeId: un,
      ncm: '22030000',
      cest: '0302100',
      precoVenda: '4,99',
      lojas: [
        { lojaId: loja1, precoVenda: '5,49' },
        { lojaId: loja2, precoVenda: '5,29' },
      ],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  produto = r.body.id as string;
});

afterAll(async () => {
  await amb?.fechar();
});

describe('tributação só gravada no cadastro do produto (F2-B52)', () => {
  let cursor: number;

  it('critério de pronto: o contador grava a tributação do PR e o ST retido da Loja 1, sem efeito em preço nem venda', async () => {
    cursor = (await puxar()).cursor;
    const historicoAntes = await linhasHistoricoPrecos();
    const antes = await detalhe(produto, contador);
    // O restrito só vê a loja dele (decisão 88).
    expect(antes.lojas.map((l) => l.lojaId)).toEqual([loja1]);
    expect(antes.tributacaoUf).toEqual([]);
    expect(antes.lojas[0]).toMatchObject({ stBcRetidoUnitario: null, stAtualizadoEm: null });

    const r = await alterar(
      produto,
      {
        unidadeTributavelId: lt,
        fatorTributavel: '0,35',
        isCst: '000',
        isClassificacao: '000001',
        isAliquotaPct: '',
        isAliquotaEspecifica: '1,5',
        isUnidade: 'L',
        tributacaoUf: [TRIBUTACAO_PR],
        lojas: [{ ...antes.lojas[0], ...ST_LOJA1 }],
      },
      contador,
      antes,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    // Gravados nas casas das colunas (4 nos percentuais e valores, 3 no fator).
    expect(d).toMatchObject({
      unidadeTributavelId: lt,
      fatorTributavel: '0.350',
      isCst: '000',
      isClassificacao: '000001',
      isAliquotaPct: null,
      isAliquotaEspecifica: '1.5000',
      isUnidade: 'L',
    });
    expect(d.tributacaoUf).toEqual([
      {
        uf: 'PR',
        cfopVendaEstado: '5405',
        icmsSituacao: '60',
        icmsModalidadeBc: '3',
        icmsAliquota: '19.5000',
        icmsReducaoBcPct: null,
        icmsModalidadeBcst: '4',
        icmsMvaPct: '70.0001',
        icmsAliquotaSt: '19.5000',
        fcpAliquota: '2.0000',
        fcpStAliquota: '2.0000',
        beneficioFiscalCodigo: null,
      },
    ]);
    expect(d.lojas[0]).toMatchObject({
      lojaId: loja1,
      stBcRetidoUnitario: '6.1234',
      stAliquotaPct: '19.5000',
      stIcmsSubstitutoUnitario: '0.4567',
      stIcmsRetidoUnitario: '0.7373',
      fcpStBcRetidoUnitario: '6.1234',
      fcpStAliquotaPct: '2.0000',
      fcpStRetidoUnitario: '0.1225',
    });
    expect(d.lojas[0]!.stAtualizadoEm).not.toBeNull();
    expect(d.versao).toBeGreaterThan(antes.versao);

    // Sem efeito em preço: os preços ficam, e o histórico de preços não ganha linha.
    expect(d.precoVenda).toBe(antes.precoVenda);
    expect(d.lojas[0]!.precoVenda).toBe('5.4900');
    expect(await linhasHistoricoPrecos()).toBe(historicoAntes);

    // A Loja 2 (fora do contador) ficou como estava.
    const admin2 = (await detalhe(produto)).lojas.find((l) => l.lojaId === loja2)!;
    expect(admin2).toMatchObject({ precoVenda: '5.2900', stBcRetidoUnitario: null, stAtualizadoEm: null });

    // Desce ao caixa da Loja 1 como antes (as colunas que o espelho do PDV já tem): a Tributação do PR e a linha da
    // loja com o ST (sem `st_nota_entrada_id`, omitida no fluxo).
    const p = await puxar(cursor);
    cursor = p.cursor;
    const [uf] = daTabela(p, 'produtos_tributacao_uf');
    expect(uf).toMatchObject({
      produto_id: produto,
      uf: 'PR',
      cfop_venda_estado: '5405',
      icms_situacao: '60',
      icms_aliquota: '19.5000',
      icms_mva_pct: '70.0001',
      fcp_aliquota: '2.0000',
      excluido_em: null,
    });
    const lojasPull = daTabela(p, 'produtos_lojas');
    expect(lojasPull.map((l) => l.loja_id)).toEqual([loja1]);
    expect(lojasPull[0]).toMatchObject({
      st_bc_retido_unitario: '6.1234',
      st_icms_retido_unitario: '0.7373',
      fcp_st_retido_unitario: '0.1225',
      preco_venda: '5.4900',
    });
    expect(lojasPull[0]).not.toHaveProperty('st_nota_entrada_id');
    expect(p.linhas.get('produtos')?.get(produto)).toMatchObject({ preco_venda: '4.9900', is_cst: '000' });

    // Auditado: o texto gravado (lido por todos com `auditoria.ver`) e o "ver diferença completa" de quem consulta.
    const aud = await ultimaAuditoria(produto);
    expect(aud.descricao).toContain('Tributação da UF adicionada PR');
    expect(aud.descricao).toContain('IS – situação: — → 000');
    expect(aud.descricao).toContain('Fator tributável');
    expect(aud.descricao).toContain('Dados de loja alterados');
    expect(aud.descricao).not.toContain('Preço de venda');
    const h = await amb
      .http()
      .get('/api/relatorios/historico-produtos')
      .query({
        dataInicial: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        dataFinal: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
        produtoId: produto,
      })
      .set(bearer(contador));
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const linha = (h.body as RespostaHistoricoProdutos).itens.find((i) => i.acao === 'editar')!;
    expect(linha.historico).toContain('ICMS-ST retido (vICMSSTRet) — → 0,7373');
    const completo = await amb
      .http()
      .get(`/api/relatorios/historico-produtos/${linha.id}`)
      .query({ ocorridoEm: linha.ocorridoEm })
      .set(bearer(contador));
    expect(completo.status, JSON.stringify(completo.body)).toBe(200);
    const campos = (completo.body as DetalheHistoricoProduto).alteracoes.map((a) => a.campo);
    expect(campos).toEqual(
      expect.arrayContaining([
        expect.stringContaining('BC do ST retido (vBCSTRet)'),
        expect.stringContaining('Alíquota ST % (pST)'),
        expect.stringContaining('IS – alíquota específica'),
      ]),
    );
  });

  it('a linha igual não é regravada: o mesmo corpo de volta não sobe a versão nem a data do ST', async () => {
    const antes = await detalhe(produto, contador);
    const r = await alterar(produto, {}, contador, antes);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    expect(d.lojas[0]!.stAtualizadoEm).toBe(antes.lojas[0]!.stAtualizadoEm);
    // Outro usuário (o admin) salvando o mesmo corpo: sem a comparação, o `atualizado_por_id` mudaria, a versão
    // subiria e a linha da UF desceria de novo a todos os caixas da UF (o mesmo usuário o gatilho já segura).
    const doAdmin = await alterar(produto, {}, admin);
    expect(doAdmin.status, JSON.stringify(doAdmin.body)).toBe(200);
    const p = await puxar(cursor);
    cursor = p.cursor;
    expect(daTabela(p, 'produtos_tributacao_uf')).toEqual([]);
    expect(
      await consultar<{ atualizado_por_id: string }>(
        emp.nomeBanco,
        "select atualizado_por_id from produtos_tributacao_uf where produto_id = $1 and uf = 'PR'",
        [produto],
      ),
    ).toEqual([{ atualizado_por_id: contadorId }]);
  });

  it('ausentes mantêm o gravado: o ERP antigo e o "Definir NCM" não apagam a tributação nem o ST', async () => {
    const antes = await detalhe(produto);
    const r = await amb
      .http()
      .put(`/api/produtos/${produto}`)
      .set(bearer())
      .send({ ...corpoErpAntigo(antes), localizacao: 'GONDOLA 3' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    expect(d.localizacao).toBe('GONDOLA 3');
    const fiscais = (x: ProdutoDetalhe) => ({
      unidadeTributavelId: x.unidadeTributavelId,
      fatorTributavel: x.fatorTributavel,
      isCst: x.isCst,
      isClassificacao: x.isClassificacao,
      isAliquotaEspecifica: x.isAliquotaEspecifica,
      isUnidade: x.isUnidade,
      tributacaoUf: x.tributacaoUf,
      lojas: x.lojas,
    });
    expect(fiscais(d)).toEqual(fiscais(antes));

    // "Definir NCM" (relatório NCMs inválidos): o detalhe vira o corpo, e a tributação fica como está.
    const definir = await amb
      .http()
      .post('/api/relatorios/ncm-invalidos/definir-ncm')
      .set(bearer())
      .send({ ncm: '22029900', produtos: [{ id: produto, versao: d.versao }] });
    expect(definir.status, JSON.stringify(definir.body)).toBe(200);
    const depois = await detalhe(produto);
    expect(depois.ncm).toBe('22029900');
    expect(fiscais(depois)).toEqual(fiscais(antes));
  });

  it('a versão do cadastro cobre a Tributação por UF: quem abriu antes da mudança recebe 409', async () => {
    const velho = await detalhe(produto);
    const r = await alterar(
      produto,
      { tributacaoUf: [{ ...velho.tributacaoUf[0], icmsAliquota: '18' }] },
      admin,
      velho,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ProdutoDetalhe).tributacaoUf[0]!.icmsAliquota).toBe('18.0000');
    const conflito = await alterar(produto, { localizacao: 'DEPOSITO' }, admin, velho);
    expect(conflito.status, JSON.stringify(conflito.body)).toBe(409);
    expect((await ultimaAuditoria(produto)).descricao).toContain(
      'Tributação da UF PR: ICMS – alíquota % 19,50 → 18,00',
    );
  });

  it('o ST retido só nas lojas permitidas: a loja de fora é 403, e a gravação do contador mantém a dela', async () => {
    const r = await alterar(produto, {
      lojas: (await detalhe(produto)).lojas.map((l) =>
        l.lojaId === loja2 ? { ...l, stIcmsRetidoUnitario: '0,5', stBcRetidoUnitario: '5' } : l,
      ),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const doContador = await detalhe(produto, contador);
    const fora = await alterar(
      produto,
      {
        lojas: [
          ...doContador.lojas,
          { lojaId: loja2, stIcmsRetidoUnitario: '9', precoVenda: '5,29', ativoNaLoja: true },
        ],
      },
      contador,
      doContador,
    );
    expect(fora.status, JSON.stringify(fora.body)).toBe(403);
    const ok = await alterar(
      produto,
      { lojas: [{ ...doContador.lojas[0], stIcmsRetidoUnitario: '0,8' }] },
      contador,
      doContador,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const tudo = await detalhe(produto);
    expect(tudo.lojas.find((l) => l.lojaId === loja1)).toMatchObject({ stIcmsRetidoUnitario: '0.8000' });
    expect(tudo.lojas.find((l) => l.lojaId === loja2)).toMatchObject({
      stIcmsRetidoUnitario: '0.5000',
      stBcRetidoUnitario: '5.0000',
    });
    // Vazio apaga (o preenchimento manual também tira o valor).
    const limpo = await alterar(
      produto,
      { lojas: [{ ...(await detalhe(produto, contador)).lojas[0], stIcmsRetidoUnitario: '' }] },
      contador,
    );
    expect(limpo.status, JSON.stringify(limpo.body)).toBe(200);
    expect((limpo.body as ProdutoDetalhe).lojas[0]!.stIcmsRetidoUnitario).toBeNull();
  });

  it('os valores em R$ do ST são custo (D68): sem produtos.ver_custo, nem no detalhe, nem na gravação, nem no histórico', async () => {
    const tudoAntes = (await detalhe(produto)).lojas.find((l) => l.lojaId === loja1)!;
    expect(tudoAntes).toMatchObject({ stBcRetidoUnitario: '6.1234', stIcmsSubstitutoUnitario: '0.4567' });
    const d = await detalhe(produto, semCusto);
    expect(d.precoCusto).toBeNull();
    // Os valores saem nulos (vICMSSubstituto ÷ alíquota própria daria o preço de compra); os percentuais ficam.
    expect(d.lojas[0]).toMatchObject({
      lojaId: loja1,
      stBcRetidoUnitario: null,
      stIcmsSubstitutoUnitario: null,
      stIcmsRetidoUnitario: null,
      fcpStBcRetidoUnitario: null,
      fcpStRetidoUnitario: null,
      stAliquotaPct: '19.5000',
      fcpStAliquotaPct: '2.0000',
    });
    // O corpo dele (com os nulos do detalhe e um valor digitado) não apaga nem troca os valores; o percentual grava.
    // O custo vai como o formulário de quem não o vê manda (zero, ignorado).
    const r = await alterar(
      produto,
      {
        precoCusto: '0',
        markupPct: '0',
        lojas: [{ ...d.lojas[0], stIcmsSubstitutoUnitario: '9', stAliquotaPct: '18' }],
      },
      semCusto,
      d,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ProdutoDetalhe).lojas[0]).toMatchObject({
      stIcmsSubstitutoUnitario: null,
      stAliquotaPct: '18.0000',
    });
    expect((await detalhe(produto)).lojas.find((l) => l.lojaId === loja1)).toMatchObject({
      stBcRetidoUnitario: '6.1234',
      stIcmsSubstitutoUnitario: '0.4567',
      stIcmsRetidoUnitario: tudoAntes.stIcmsRetidoUnitario,
      fcpStBcRetidoUnitario: '6.1234',
      fcpStRetidoUnitario: '0.1225',
      stAliquotaPct: '18.0000',
    });
    // No histórico de quem não vê o custo, o ST da loja aparece só nos percentuais (no texto e na diferença completa).
    const h = await amb
      .http()
      .get('/api/relatorios/historico-produtos')
      .query({
        dataInicial: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        dataFinal: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
        produtoId: produto,
      })
      .set(bearer(semCusto));
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const itens = (h.body as RespostaHistoricoProdutos).itens;
    const comSt = itens.find((i) => i.historico.includes('Alíquota ST % (pST) — → 19,50'))!;
    expect(comSt).toBeDefined();
    expect(itens.map((i) => i.historico).join(' ')).not.toMatch(
      /vBCSTRet|vICMSSubstituto|vICMSSTRet|vBCFCPSTRet|vFCPSTRet|0,4567|6,1234/,
    );
    const completo = await amb
      .http()
      .get(`/api/relatorios/historico-produtos/${comSt.id}`)
      .query({ ocorridoEm: comSt.ocorridoEm })
      .set(bearer(semCusto));
    expect(completo.status, JSON.stringify(completo.body)).toBe(200);
    const campos = (completo.body as DetalheHistoricoProduto).alteracoes.map((a) => a.campo);
    expect(campos).toEqual(expect.arrayContaining([expect.stringContaining('Alíquota ST % (pST)')]));
    expect(campos.join(' ')).not.toMatch(/vBCSTRet|vICMSSubstituto|vICMSSTRet|vBCFCPSTRet|vFCPSTRet/);
  });

  it('as FKs e os CHECKs que já existem no banco viram 422 no campo; nenhuma regra fiscal nova', async () => {
    const recusa = async (mudancas: Record<string, unknown>) => {
      const r = await alterar(produto, mudancas);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return r.body.campos as Record<string, string[]>;
    };
    const d = await detalhe(produto);
    expect(
      await recusa({
        tributacaoUf: [{ uf: 'XX' }, { uf: 'SC', cfopVendaEstado: '5999' }],
      }),
    ).toEqual({
      'tributacaoUf.0.uf': ['UF inexistente'],
      'tributacaoUf.1.cfopVendaEstado': ['CFOP inexistente'],
    });
    expect(await recusa({ unidadeTributavelId: uuidv7() })).toEqual({
      unidadeTributavelId: ['Unidade inexistente ou inativa'],
    });
    // `ck_produtos_is`: com a unidade ausente (mantida), vale a gravada; apagar a unidade com a específica gravada não.
    expect(await recusa({ isUnidade: null })).toEqual({
      isUnidade: ['Informe a unidade da alíquota específica'],
    });
    const { isUnidade: _u, ...semUnidade } = d;
    const mantida = await amb
      .http()
      .put(`/api/produtos/${produto}`)
      .set(bearer())
      .send({ ...semUnidade, isAliquotaEspecifica: '2' });
    expect(mantida.status, JSON.stringify(mantida.body)).toBe(200);
    expect(await recusa({ fatorTributavel: '0' })).toHaveProperty('fatorTributavel');
    expect(
      await recusa({ lojas: (await detalhe(produto)).lojas.map((l) => ({ ...l, stAliquotaPct: '100,5' })) }),
    ).toHaveProperty(['lojas.0.stAliquotaPct']);
    // A regra de emissão (CFOP 5405 × CST 60) não vale na linha da UF nesta fase: só é guardada.
    const guardada = await alterar(produto, {
      tributacaoUf: [{ uf: 'SC', cfopVendaEstado: '5405', icmsSituacao: '00' }, TRIBUTACAO_PR],
    });
    expect(guardada.status, JSON.stringify(guardada.body)).toBe(200);
    expect((guardada.body as ProdutoDetalhe).tributacaoUf.map((t) => t.uf)).toEqual(['PR', 'SC']);
  });

  it('tirar a UF a exclui logicamente (tombstone ao caixa); quem não edita produto recebe 403', async () => {
    const negado = await alterar(produto, { tributacaoUf: [] }, vendedor, await detalhe(produto));
    expect(negado.status).toBe(403);
    const r = await alterar(produto, {
      tributacaoUf: (await detalhe(produto)).tributacaoUf.filter((t) => t.uf !== 'PR'),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ProdutoDetalhe).tributacaoUf.map((t) => t.uf)).toEqual(['SC']);
    const p = await puxar(cursor);
    cursor = p.cursor;
    // Só a do PR desce ao caixa da Loja 1 (a de SC é de outra UF), agora excluída.
    expect(daTabela(p, 'produtos_tributacao_uf')).toEqual([
      expect.objectContaining({ uf: 'PR', excluido_em: expect.any(String) }),
    ]);
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from produtos_tributacao_uf where produto_id = $1 and uf = 'PR'",
      [produto],
    )) as [{ n: number }];
    expect(n).toBe(1);
    expect((await ultimaAuditoria(produto)).descricao).toContain('Tributação da UF removida PR');
  });

  it('excluir o produto exclui a Tributação por UF (lógico)', async () => {
    const r = await amb.http().delete(`/api/produtos/${produto}`).set(bearer());
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    const vivas = await consultar(
      emp.nomeBanco,
      'select 1 from produtos_tributacao_uf where produto_id = $1 and excluido_em is null',
      [produto],
    );
    expect(vivas).toEqual([]);
  });
});
