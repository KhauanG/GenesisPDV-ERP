/**
 * Produtos (ERP 8.1, 8.2, 8.2.17, 8.9, 8.10; MD 3.6): cadastro com as filhas, EAN (DV e duplicidade por
 * configuração), combo com posições/alternativas e custo automático, ciclo, saldos e combos montáveis, exclusão,
 * permissões de custo e de preço, grupos de preço por quantidade (mix) e restrições de horário.
 */
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

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let estoquista: string;
let vendedor: string;
let un: string;
let kg: string;
let cx: string;
let lojaId: string;
let estoqueLoja: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const EAN_BRAHMA = '7891149103102';
const DUN_BRAHMA = '17891149103109';

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  const sigla = (s: string) =>
    (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === s)!.id;
  un = sigla('UN');
  kg = sigla('KG');
  cx = sigla('CX');
  lojaId = await criarLoja(emp.nomeBanco, 1, 'Loja Centro');
  const [l] = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [lojaId],
  );
  estoqueLoja = l!.estoque_id;
});

afterAll(async () => {
  await amb?.fechar();
});

async function criar(corpo: Record<string, unknown>, token = admin) {
  return amb
    .http()
    .post('/api/produtos')
    .set(bearer(token))
    .send({ unidadeId: un, precoVenda: '10', ...corpo });
}

async function obter(id: string, token = admin) {
  return (await amb.http().get(`/api/produtos/${id}`).set(bearer(token))).body;
}

async function alterar(id: string, mudancas: Record<string, unknown>, token = admin) {
  const atual = await obter(id);
  return amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer(token))
    .send({ ...atual, ...mudancas });
}

async function saldo(produtoId: string, quantidade: number) {
  await consultar(
    emp.nomeBanco,
    `insert into saldos_estoque (estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio)
     values ($1, $2, (select id from tipos_estoque where chave_sistema = 'disponivel'), $3, 1)`,
    [estoqueLoja, produtoId, quantidade],
  );
}

describe('cadastro de produto (ERP 8.2)', () => {
  let id: string;

  it('cria com EAN principal, fardo (DUN-14) com fator e preço, preços complementares, loja e faixas', async () => {
    const r = await criar({
      nome: 'CERV BRAHMA LT 350ML',
      codigoInterno: 'BRH350',
      ncm: '2203.00.00',
      precoCusto: '2,10',
      markupPct: '66,19',
      precoVenda: '3,49',
      precoAtacado: '3,19',
      qtdMinimaAtacado: '12',
      precoPromocional: '2,99',
      promocaoInicio: '2026-11-01T00:00:00-03:00',
      promocaoFim: '2026-11-30T23:59:00-03:00',
      precoParcelado: '3,59',
      idadeMinima: 18,
      solicitaPrecoPdv: false,
      generico: false,
      qtdMinimaVenda: '1',
      cfopVendaEstado: '5405',
      icmsSituacao: '500',
      cest: '0302100',
      icmsOrigem: '0',
      pisSituacao: '04',
      cofinsSituacao: '04',
      fcpAliquota: '2',
      codigosBarras: [
        { codigo: EAN_BRAHMA, principal: true },
        { codigo: DUN_BRAHMA, descricao: 'Fardo 12 un', unidadeId: cx, fator: '12', preco: '36,90' },
      ],
      lojas: [{ lojaId, estoqueMinimo: '24', precoVenda: '3,39', acrescimoGelada: '0,50' }],
      precosQuantidade: [
        { lojaId: null, quantidadeInicial: '6', quantidadeFinal: '12', preco: '3,29' },
        { lojaId, quantidadeInicial: '6', quantidadeFinal: null, preco: '3,25' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({
      nome: 'CERV BRAHMA LT 350ML',
      tipo: 'simples',
      ncm: '22030000',
      ean: EAN_BRAHMA,
      unidadeSigla: 'UN',
      precoCusto: '2.1000',
      precoVenda: '3.4900',
      precoAtacado: '3.1900',
      qtdMinimaAtacado: '12.000',
      idadeMinima: 18,
      fcpAliquota: '2.0000',
    });
    expect(r.body.codigosBarras).toHaveLength(2);
    expect(r.body.codigosBarras[1]).toMatchObject({ codigo: DUN_BRAHMA, fator: '12.000', preco: '36.9000' });
    expect(r.body.lojas[0]).toMatchObject({ lojaId, precoVenda: '3.3900', estoqueMinimo: '24.000' });
    expect(r.body.precosQuantidade).toHaveLength(2);
    const hist = await consultar<{ tipo_preco: string }>(
      emp.nomeBanco,
      'select tipo_preco from produtos_historico_precos where produto_id = $1 order by tipo_preco',
      [id],
    );
    expect(hist.map((h) => h.tipo_preco)).toEqual([
      'atacado',
      'custo',
      'loja',
      'parcelado',
      'promocional',
      'venda',
    ]);
    const [{ busca }] = (await consultar<{ busca: string }>(
      emp.nomeBanco,
      'select busca from produtos where id = $1',
      [id],
    )) as [{ busca: string }];
    expect(busca).toContain(EAN_BRAHMA);
    expect(busca).toContain('brh350');
  });

  it('422: DV do EAN, NCM inexistente, unidade e regras de tributação', async () => {
    const r = await criar({
      nome: 'X',
      ncm: '99999999',
      unidadeId: '0190a000-0000-7000-8000-000000000001',
      codigosBarras: [{ codigo: '7891149103103', principal: true }],
    });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual(['codigosBarras.0.codigo', 'nome']);
    const banco = await criar({
      nome: 'XY',
      ncm: '99999999',
      unidadeId: '0190a000-0000-7000-8000-000000000001',
    });
    expect(banco.status).toBe(422);
    expect(Object.keys(banco.body.campos).sort()).toEqual(['ncm', 'unidadeId']);
  });

  it('código interno único (409) e versão (409 CONFLITO_VERSAO)', async () => {
    const dup = await criar({ nome: 'OUTRA', codigoInterno: 'brh350' });
    expect(dup.status).toBe(409);
    expect(dup.body.campos.codigoInterno[0]).toContain('CERV BRAHMA');
    const atual = await obter(id);
    const ok = await amb
      .http()
      .put(`/api/produtos/${id}`)
      .set(bearer(admin))
      .send({ ...atual, localizacao: 'G1' });
    expect(ok.status).toBe(200);
    const velho = await amb
      .http()
      .put(`/api/produtos/${id}`)
      .set(bearer(admin))
      .send({ ...atual, localizacao: 'G2' });
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
  });

  it('alterar faixas e lojas: faixa trocada é recriada; loja retirada é excluída logicamente', async () => {
    const atual = await obter(id);
    const r = await alterar(id, {
      lojas: [],
      precosQuantidade: [
        { lojaId: null, quantidadeInicial: '6', quantidadeFinal: '24', preco: '3,29' },
        { lojaId: null, quantidadeInicial: '24', quantidadeFinal: null, preco: '3,09' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lojas).toEqual([]);
    expect(r.body.precosQuantidade.map((f: { preco: string }) => f.preco)).toEqual(['3.2900', '3.0900']);
    expect(r.body.versao).toBeGreaterThan(atual.versao);
    const sobreposta = await alterar(id, {
      precosQuantidade: [
        { lojaId: null, quantidadeInicial: '6', quantidadeFinal: '24', preco: '3,29' },
        { lojaId: null, quantidadeInicial: '12', quantidadeFinal: null, preco: '3,09' },
      ],
    });
    expect(sobreposta.status).toBe(422);
  });

  it('listagem: filtros de nome, código de barras (fardo), NCM por prefixo, tipo e situação; custo só com permissão', async () => {
    const q = (p: string, token = admin) => amb.http().get(`/api/produtos?${p}`).set(bearer(token));
    expect((await q('nome=brahma')).body.itens.map((p: { id: string }) => p.id)).toContain(id);
    expect((await q(`codigoBarras=${DUN_BRAHMA}`)).body.total).toBe(1);
    expect((await q('ncm=2203')).body.itens[0]).toMatchObject({ id, ean: EAN_BRAHMA, precoCusto: '2.1000' });
    expect((await q('tipo=kit')).body.total).toBe(0);
    expect(
      (await q('situacaoCadastro=sem_codigo_barras')).body.itens.some((p: { id: string }) => p.id === id),
    ).toBe(false);
    const semCusto = await q('ncm=2203', estoquista);
    expect(semCusto.status).toBe(200);
    expect(semCusto.body.itens[0].precoCusto).toBeNull();
    expect((await obter(id, estoquista)).precoCusto).toBeNull();
    expect((await q('ordenar=preco_custo:asc', estoquista)).status).toBe(403);
    expect((await q('ordenar=preco_venda:desc')).status).toBe(200);
    const csv = await amb.http().get('/api/produtos/exportar?formato=csv&nome=brahma').set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('CERV BRAHMA LT 350ML');
  });

  it('permissões: vendedor não cria; sem "Alterar preço" com a configuração desligada só muda o que não é preço', async () => {
    expect((await criar({ nome: 'PROIBIDO' }, vendedor)).status).toBe(403);
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.altera_preco_produto_erp', 'false')`,
    );
    const atual = await obter(id);
    const preco = await amb
      .http()
      .put(`/api/produtos/${id}`)
      .set(bearer(estoquista))
      .send({ ...atual, precoVenda: '3.99' });
    expect(preco.status).toBe(403);
    const outro = await amb
      .http()
      .put(`/api/produtos/${id}`)
      .set(bearer(estoquista))
      .send({ ...atual, localizacao: 'G9' });
    expect(outro.status, JSON.stringify(outro.body)).toBe(200);
    // Sem `produtos.ver_custo` o custo enviado é ignorado (o gravado fica).
    expect((await obter(id)).precoCusto).toBe('2.1000');
    await consultar(
      emp.nomeBanco,
      `delete from configuracoes where chave = 'geral.altera_preco_produto_erp'`,
    );
  });
});

describe('EAN duplicado (geral.ean_duplicado)', () => {
  it('bloquear (padrão) recusa; avisar pede confirmação e grava; filtro "EAN duplicado"', async () => {
    const b = await criar({
      nome: 'BRAHMA DUPLICADA',
      codigosBarras: [{ codigo: EAN_BRAHMA, principal: true }],
    });
    expect(b.status).toBe(409);
    expect(b.body.campos['codigosBarras.0.codigo'][0]).toContain('CERV BRAHMA');
    expect(b.body.detalhes.eanDuplicado).toMatchObject({ modo: 'bloquear', confirmar: false });

    const v = await amb.http().get(`/api/produtos/verificar-ean?codigo=${EAN_BRAHMA}`).set(bearer(admin));
    expect(v.body).toMatchObject({ valido: true, modo: 'bloquear' });
    expect(v.body.duplicados).toHaveLength(1);

    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"')`,
    );
    const a = await criar({
      nome: 'BRAHMA DUPLICADA',
      codigosBarras: [{ codigo: EAN_BRAHMA, principal: true }],
    });
    expect(a.status).toBe(409);
    expect(a.body.detalhes.eanDuplicado).toMatchObject({ modo: 'avisar', confirmar: true });
    const ok = await criar({
      nome: 'BRAHMA DUPLICADA',
      confirmarEanDuplicado: true,
      codigosBarras: [{ codigo: EAN_BRAHMA, principal: true }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const lista = await amb.http().get('/api/produtos?situacaoCadastro=ean_duplicado').set(bearer(admin));
    expect(lista.body.total).toBe(2);
    // De volta a bloquear: editar outras colunas do produto já duplicado (migração) continua possível.
    await consultar(emp.nomeBanco, `delete from configuracoes where chave = 'geral.ean_duplicado'`);
    expect((await alterar(ok.body.id, { localizacao: 'X' })).status).toBe(200);
    expect((await amb.http().delete(`/api/produtos/${ok.body.id}`).set(bearer(admin))).status).toBe(204);
  });
});

describe('tipos sem suporte (F2-B1; D43)', () => {
  const tipo = async (id: string, t: string) =>
    consultar(emp.nomeBanco, 'update produtos set tipo = $2 where id = $1', [id, t]);
  const semSuporte = async () =>
    (
      await amb
        .http()
        .get('/api/produtos?situacaoCadastro=tipo_sem_suporte&situacao=todos')
        .set(bearer(admin))
    ).body.itens.map((p: { nome: string }) => p.nome) as string[];

  it('POST recusa Com variações e Com complementos com 422 no campo tipo; os habilitados não os listam', async () => {
    for (const t of ['com_variacoes', 'com_complementos']) {
      const r = await criar({ nome: `NOVO ${t}`, tipo: t });
      expect(r.status, t).toBe(422);
      expect(r.body.campos.tipo[0]).toMatch(/^Tipo disponível em breve/);
    }
    const h = await amb.http().get('/api/produtos/tipos-habilitados').set(bearer(estoquista));
    expect(h.status).toBe(200);
    expect(h.body.tipos).toEqual(['simples', 'kit', 'materia_prima', 'servico', 'produzido', 'vasilhame']);
  });

  it('o legado continua editável (PUT 200); trocar um Simples para o tipo travado é 422; o filtro lista o legado', async () => {
    const lanche = (await criar({ nome: 'LANCHE LEGADO' })).body.id as string;
    await tipo(lanche, 'com_complementos');
    const editado = await alterar(lanche, { localizacao: 'BALCAO' });
    expect(editado.status, JSON.stringify(editado.body)).toBe(200);
    expect(editado.body).toMatchObject({ tipo: 'com_complementos', localizacao: 'BALCAO' });
    const simples = (await criar({ nome: 'AGUA SIMPLES' })).body.id as string;
    const troca = await alterar(simples, { tipo: 'com_variacoes' });
    expect(troca.status).toBe(422);
    expect(troca.body.campos.tipo[0]).toMatch(/^Tipo disponível em breve/);
    expect(await semSuporte()).toContain('LANCHE LEGADO');
    expect(await semSuporte()).not.toContain('AGUA SIMPLES');
  });

  it('Com variações sem variação ativa troca para Simples, mesmo com movimento; com variação ativa, não', async () => {
    const vendido = (await criar({ nome: 'CERVEJA SEM GRADE' })).body.id as string;
    const acerto = await amb
      .http()
      .post('/api/acertos')
      .set(bearer(admin))
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'entrada',
        motivo: 'Saldo inicial',
        dataContagem: new Date(Date.now() - 3_600_000).toISOString(),
        itens: [{ produtoId: vendido, quantidade: '10', custoUnitario: '2' }],
      });
    expect(acerto.status, JSON.stringify(acerto.body)).toBe(201);
    const efetivado = await amb
      .http()
      .post(`/api/acertos/${acerto.body.id}/efetivar`)
      .set(bearer(admin))
      .send({ versao: acerto.body.versao });
    expect(efetivado.status, JSON.stringify(efetivado.body)).toBe(200);
    await tipo(vendido, 'com_variacoes');
    expect(await semSuporte()).toContain('CERVEJA SEM GRADE');
    const convertido = await alterar(vendido, { tipo: 'simples' });
    expect(convertido.status, JSON.stringify(convertido.body)).toBe(200);
    expect(convertido.body).toMatchObject({ tipo: 'simples', temMovimento: true });
    expect(await semSuporte()).not.toContain('CERVEJA SEM GRADE');

    const comGrade = (await criar({ nome: 'CAMISETA COM GRADE' })).body.id as string;
    await tipo(comGrade, 'com_variacoes');
    await consultar(emp.nomeBanco, `insert into produtos_variacoes (produto_id, nome) values ($1, 'P')`, [
      comGrade,
    ]);
    const recusada = await alterar(comGrade, { tipo: 'simples' });
    expect(recusada.status).toBe(422);
    expect(recusada.body.campos.tipo).toEqual([
      'O produto tem variações ativas: inative as variações antes de trocar o tipo',
    ]);
  });

  it('variação inativa ou excluída não trava a saída; movimento de variação mantém a regra da troca com movimento', async () => {
    // Só variações inativas/excluídas e nenhum movimento delas: sai do tipo (o filtro é `ativo and excluido_em is null`).
    const inativas = (await criar({ nome: 'BERMUDA GRADE INATIVA' })).body.id as string;
    await tipo(inativas, 'com_variacoes');
    await consultar(
      emp.nomeBanco,
      `insert into produtos_variacoes (produto_id, nome, ativo, excluido_em) values ($1, 'P', false, null), ($1, 'M', true, now())`,
      [inativas],
    );
    const saiu = await alterar(inativas, { tipo: 'simples' });
    expect(saiu.status, JSON.stringify(saiu.body)).toBe(200);
    expect(saiu.body).toMatchObject({ tipo: 'simples' });

    // A variação (já inativa) movimentou estoque: vale a regra antiga e "Com variações" com movimento não troca.
    const movimentada = (await criar({ nome: 'BONE GRADE MOVIMENTADA' })).body.id as string;
    await tipo(movimentada, 'com_variacoes');
    const [variacao] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into produtos_variacoes (produto_id, nome, ativo) values ($1, 'U', false) returning id`,
      [movimentada],
    );
    await consultar(
      emp.nomeBanco,
      `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, variacao_id, tipo_movimento, quantidade,
         saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento, documento_tipo)
       values ($1, (select id from tipos_estoque where chave_sistema = 'disponivel'), $2, $3, 'ACERTO_ENTRADA', 5, 0, 5,
         0, 0, 0, now(), 'acerto')`,
      [estoqueLoja, movimentada, variacao!.id],
    );
    expect((await obter(movimentada)).temMovimento).toBe(true);
    const recusada = await alterar(movimentada, { tipo: 'simples' });
    expect(recusada.status).toBe(422);
    expect(recusada.body.campos.tipo).toEqual([
      'O produto já tem movimento de estoque: só troca entre Simples, Matéria-prima e Serviço (sem saldo)',
    ]);
  });

  it('a chave ligada libera a criação do tipo (configurável); desligada volta a recusar', async () => {
    const config = (valor: boolean | null) =>
      amb
        .http()
        .put('/api/configuracoes')
        .set(bearer(admin))
        .send({ valores: { 'produtos.complementos_habilitados': valor } });
    expect((await config(true)).status).toBe(200);
    expect((await amb.http().get('/api/produtos/tipos-habilitados').set(bearer(admin))).body.tipos).toContain(
      'com_complementos',
    );
    const r = await criar({ nome: 'DRINK COM COMPLEMENTOS', tipo: 'com_complementos' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await criar({ nome: 'AINDA TRAVADO', tipo: 'com_variacoes' })).status).toBe(422);
    expect((await config(null)).status).toBe(200);
    expect((await criar({ nome: 'DE NOVO TRAVADO', tipo: 'com_complementos' })).status).toBe(422);
  });
});

describe('combo (kit) – ERP 8.2.17', () => {
  const ids: Record<string, string> = {};
  let combo: string;

  beforeAll(async () => {
    const itens: Array<[string, string, string]> = [
      ['WHISKY 1L', '80', '120'],
      ['RED BULL 2L', '10', '18'],
      ['MONSTER 2L', '12', '20'],
      ['GELO COCO', '2', '5'],
      ['GELO MELANCIA', '2', '5'],
    ];
    for (const [nome, custo, venda] of itens) {
      const r = await criar({ nome, precoCusto: custo, precoVenda: venda, ncm: '22029900' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids[nome] = r.body.id;
    }
    const mp = await criar({ nome: 'XAROPE', tipo: 'materia_prima', precoVenda: '0' });
    ids.XAROPE = mp.body.id;
  });

  const posicoes = () => [
    { tipo: 'kit', componenteId: ids['WHISKY 1L']!, quantidade: '1' },
    {
      tipo: 'kit',
      componenteId: ids['RED BULL 2L']!,
      quantidade: '1',
      rotuloPosicao: 'Energético 2L',
      permiteSubstituicao: true,
      alternativas: [{ produtoId: ids['MONSTER 2L']!, acrescimo: '2,00' }],
    },
    {
      tipo: 'kit',
      componenteId: ids['GELO COCO']!,
      quantidade: '2',
      rotuloPosicao: 'Gelo de sabor',
      permiteSubstituicao: true,
      alternativas: [{ produtoId: ids['GELO MELANCIA']! }],
    },
  ];

  it('cria o combo com posições e alternativas; custo = Σ custo × qtd, somente leitura', async () => {
    const r = await criar({
      nome: 'COMBO DE WHISKY 1L',
      tipo: 'kit',
      precoVenda: '139,90',
      precoCusto: '1',
      componentes: posicoes(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    combo = r.body.id;
    expect(r.body.precoCusto).toBe('94.0000');
    expect(Number(r.body.markupPct)).toBeCloseTo(48.8298, 3);
    expect(r.body.componentes).toHaveLength(3);
    expect(r.body.componentes[1]).toMatchObject({
      rotuloPosicao: 'Energético 2L',
      permiteSubstituicao: true,
    });
    expect(r.body.componentes[1].alternativas[0]).toMatchObject({ acrescimo: '2.0000', ativo: true });
    expect(r.body.componentes[1].alternativas[0].produto.nome).toBe('MONSTER 2L');
    expect(r.body.componentes[0].componente).toMatchObject({ nome: 'WHISKY 1L', precoCusto: '80.0000' });
    // Componentes sem CFOP×CST incoerente, mas o Whisky tem NCM: nenhum aviso de NCM.
    expect(r.body.avisos).toEqual([]);
    expect((await obter(ids['RED BULL 2L']!)).usadoEm.map((u: { id: string }) => u.id)).toEqual([combo]);
  });

  it('mudar o custo de um componente recalcula o custo do combo sem mudar o preço (API e banco)', async () => {
    const r = await alterar(ids['RED BULL 2L']!, { precoCusto: '11' });
    expect(r.status).toBe(200);
    let c = await obter(combo);
    expect(c.precoCusto).toBe('95.0000');
    expect(c.precoVenda).toBe('139.9000');
    // Qualquer caminho (recebimento, NF-e, importação) que mude o custo dispara o trigger.
    await consultar(emp.nomeBanco, 'update produtos set preco_custo = 3 where id = $1', [ids['GELO COCO']!]);
    c = await obter(combo);
    expect(c.precoCusto).toBe('97.0000');
    expect(Number(c.markupPct)).toBeCloseTo((139.9 / 97 - 1) * 100, 3);
    // Componente com custo e alternativa só muda o custo pelo padrão: o Monster não entra no custo.
    await consultar(emp.nomeBanco, 'update produtos set preco_custo = 50 where id = $1', [
      ids['MONSTER 2L']!,
    ]);
    expect((await obter(combo)).precoCusto).toBe('97.0000');
  });

  it('mudar a composição recalcula; desligar "Permite troca" exige tirar as alternativas', async () => {
    const atual = await obter(combo);
    const semGelo = atual.componentes.slice(0, 2);
    const r = await amb
      .http()
      .put(`/api/produtos/${combo}`)
      .set(bearer(admin))
      .send({ ...atual, componentes: semGelo });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.precoCusto).toBe('91.0000');
    const desligar = await alterar(combo, {
      componentes: [{ ...r.body.componentes[1], permiteSubstituicao: false }],
    });
    expect(desligar.status).toBe(422);
    const volta = await alterar(combo, { componentes: posicoes() });
    expect(volta.status).toBe(200);
    expect(volta.body.precoCusto).toBe('97.0000');
  });

  it('componente não pode ser combo, matéria-prima nem o próprio produto', async () => {
    const outro = await criar({
      nome: 'COMBO DUPLO',
      tipo: 'kit',
      componentes: [
        { tipo: 'kit', componenteId: combo, quantidade: '1' },
        { tipo: 'kit', componenteId: ids.XAROPE!, quantidade: '1' },
      ],
    });
    expect(outro.status).toBe(422);
    expect(outro.body.campos['componentes.0.componenteId'][0]).toContain('não pode ser componente de combo');
    expect(outro.body.campos['componentes.1.componenteId'][0]).toContain('Matéria-prima');
    const si = await alterar(combo, {
      componentes: [{ tipo: 'kit', componenteId: combo, quantidade: '1' }],
    });
    expect(si.status).toBe(422);
    expect(si.body.campos['componentes.0.componenteId'][0]).toContain('si mesmo');
  });

  it('ficha técnica sem ciclo (A → B → A recusado pelo banco)', async () => {
    const a = await criar({ nome: 'BALDE A', precoVenda: '50' });
    const b = await criar({
      nome: 'BALDE B',
      precoVenda: '50',
      usaFichaTecnica: true,
      componentes: [{ tipo: 'ficha_tecnica', componenteId: a.body.id, quantidade: '1', perdaPct: '5' }],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const ciclo = await alterar(a.body.id, {
      usaFichaTecnica: true,
      componentes: [{ tipo: 'ficha_tecnica', componenteId: b.body.id, quantidade: '1' }],
    });
    expect(ciclo.status).toBe(422);
    expect(ciclo.body.campos.componentes[0]).toContain('ciclo');
    const produzido = await criar({
      nome: 'CAIPIRINHA',
      tipo: 'produzido',
      usaFichaTecnica: true,
      componentes: [{ tipo: 'ficha_tecnica', componenteId: ids.XAROPE!, quantidade: '0,05', perdaPct: '10' }],
    });
    expect(produzido.status, JSON.stringify(produzido.body)).toBe(201);
    expect(produzido.body.componentes[0]).toMatchObject({ perdaPct: '10.0000', quantidade: '0.050' });
  });

  it('combos montáveis por estoque = mínimo de ⌊saldo ÷ qtd⌋, com o componente que limita', async () => {
    await saldo(ids['WHISKY 1L']!, 10);
    await saldo(ids['RED BULL 2L']!, 4);
    await saldo(ids['GELO COCO']!, 7);
    const r = await amb.http().get(`/api/produtos/${combo}/saldos`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.combo).toBe(true);
    expect(r.body.montaveis).toEqual([
      { estoqueId: estoqueLoja, estoqueNome: 'Estoque Loja Centro', quantidade: 3, limitadoPor: 'GELO COCO' },
    ]);
    const s = await amb.http().get(`/api/produtos/${ids['GELO COCO']!}/saldos`).set(bearer(admin));
    expect(s.body.saldos).toEqual([
      expect.objectContaining({ estoqueId: estoqueLoja, tipoEstoqueNome: 'Disponível', quantidade: '7.000' }),
    ]);
  });

  it('exclusão: bloqueada para componente de combo e para produto com saldo; livre no combo', async () => {
    const comp = await amb.http().delete(`/api/produtos/${ids['GELO MELANCIA']!}`).set(bearer(admin));
    expect(comp.status).toBe(422);
    expect(comp.body.mensagem).toContain('COMBO DE WHISKY');
    const comSaldo = await amb.http().delete(`/api/produtos/${ids['WHISKY 1L']!}`).set(bearer(admin));
    expect(comSaldo.status).toBe(422);
    expect((await amb.http().delete(`/api/produtos/${combo}`).set(bearer(admin))).status).toBe(204);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from produtos_componentes where produto_id = $1 and excluido_em is null`,
      [combo],
    );
    expect(n!.n).toBe(0);
    expect(
      (await amb.http().delete(`/api/produtos/${ids['GELO MELANCIA']!}`).set(bearer(admin))).status,
    ).toBe(204);
  });
});

describe('vasilhame (ERP 8.2.6)', () => {
  it('o cheio aponta para um produto do tipo vasilhame', async () => {
    const casco = await criar({ nome: 'CASCO 600ML', tipo: 'vasilhame', precoVenda: '1,50' });
    expect(casco.status).toBe(201);
    const cheio = await criar({
      nome: 'CERV ORIGINAL 600ML',
      vasilhameProdutoId: casco.body.id,
      vasilhameQuantidade: 1,
    });
    expect(cheio.status, JSON.stringify(cheio.body)).toBe(201);
    expect(cheio.body.vasilhame).toMatchObject({ id: casco.body.id, tipo: 'vasilhame' });
    const errado = await criar({ nome: 'ERRADO', vasilhameProdutoId: cheio.body.id, vasilhameQuantidade: 1 });
    expect(errado.status).toBe(422);
    expect(Object.keys(errado.body.campos)).toEqual(['vasilhameProdutoId']);
  });
});

describe('grupos de preço por quantidade – mix (ERP 8.10)', () => {
  let brahma: string;
  let skol: string;
  let granel: string;
  let grupo: string;

  beforeAll(async () => {
    brahma = (await criar({ nome: 'MIX BRAHMA LT', precoVenda: '3,49' })).body.id;
    skol = (await criar({ nome: 'MIX SKOL LT', precoVenda: '3,39' })).body.id;
    granel = (await criar({ nome: 'AMENDOIM GRANEL', unidadeId: kg, permiteFracao: true, precoVenda: '30' }))
      .body.id;
  });

  it('cria no modo grupo com faixas e membros; listagem com nº de produtos e resumo das faixas', async () => {
    const r = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({
        nome: 'Mix latas 350ml',
        modoPreco: 'grupo',
        faixas: [{ quantidadeInicial: '12', preco: '2,99' }],
        produtos: [brahma, skol],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    grupo = r.body.id;
    expect(r.body.produtos.map((p: { nome: string }) => p.nome)).toEqual(['MIX BRAHMA LT', 'MIX SKOL LT']);
    const lista = await amb.http().get('/api/grupos-preco-quantidade?nome=latas').set(bearer(admin));
    expect(lista.body.itens[0]).toMatchObject({ produtos: 2, faixasResumo: '12+ R$ 2,99' });
    expect((await obter(brahma)).grupoPreco).toMatchObject({ id: grupo, modoPreco: 'grupo' });
    const dup = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({ nome: 'MIX LATAS 350ML' });
    expect(dup.status).toBe(409);
  });

  it('recusa membro fracionado; produto de outro grupo pede confirmação; modo produto apaga as faixas', async () => {
    const atual = (await amb.http().get(`/api/grupos-preco-quantidade/${grupo}`).set(bearer(admin))).body;
    const fr = await amb
      .http()
      .put(`/api/grupos-preco-quantidade/${grupo}`)
      .set(bearer(admin))
      .send({ ...atual, produtos: [brahma, granel] });
    expect(fr.status).toBe(422);
    const outro = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({ nome: 'Outro mix', produtos: [skol] });
    expect(outro.status).toBe(409);
    expect(outro.body.detalhes.moverDeOutroGrupo[0].id).toBe(skol);
    const movido = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({ nome: 'Outro mix', produtos: [skol], confirmarMover: true });
    expect(movido.status).toBe(201);
    const modo = await amb
      .http()
      .put(`/api/grupos-preco-quantidade/${grupo}`)
      .set(bearer(admin))
      .send({ ...atual, produtos: [brahma], modoPreco: 'produto', faixas: atual.faixas });
    expect(modo.status, JSON.stringify(modo.body)).toBe(200);
    expect(modo.body.faixas).toEqual([]);
    // Pelo produto: membro com unidade diferente da do grupo é recusado.
    const kgNoGrupo = await alterar(granel, { permiteFracao: false, grupoPrecoQuantidadeId: grupo });
    expect(kgNoGrupo.status).toBe(422);
    expect(kgNoGrupo.body.campos.grupoPrecoQuantidadeId[0]).toContain('unidade UN');
  });

  it('excluir o grupo desvincula os produtos; estoquista só consulta', async () => {
    expect((await amb.http().get('/api/grupos-preco-quantidade').set(bearer(estoquista))).status).toBe(200);
    expect(
      (await amb.http().delete(`/api/grupos-preco-quantidade/${grupo}`).set(bearer(estoquista))).status,
    ).toBe(403);
    expect((await amb.http().delete(`/api/grupos-preco-quantidade/${grupo}`).set(bearer(admin))).status).toBe(
      204,
    );
    expect((await obter(brahma)).grupoPrecoQuantidadeId).toBeNull();
  });
});

describe('restrições de horário de venda (ERP 8.9)', () => {
  it('cria por idade mínima atravessando a meia-noite; exige alvo; loja imutável', async () => {
    const r = await amb
      .http()
      .post('/api/restricoes-horario-venda')
      .set(bearer(admin))
      .send({
        descricao: 'Lei municipal 1.234/2020',
        lojaId,
        idadeMinimaProduto: 18,
        diasSemana: [6, 5],
        horaInicio: '22:00',
        horaFim: '06:00',
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      lojaNome: 'Loja Centro',
      diasSemana: [5, 6],
      horaInicio: '22:00',
      horaFim: '06:00',
    });
    const semAlvo = await amb
      .http()
      .post('/api/restricoes-horario-venda')
      .set(bearer(admin))
      .send({ descricao: 'Sem alvo', horaInicio: '22:00', horaFim: '06:00' });
    expect(semAlvo.status).toBe(422);
    const alterada = await amb
      .http()
      .put(`/api/restricoes-horario-venda/${r.body.id}`)
      .set(bearer(admin))
      .send({ ...r.body, lojaId: null, ativo: false });
    expect(alterada.status).toBe(200);
    expect(alterada.body).toMatchObject({ lojaId, ativo: false });
    const lista = await amb.http().get('/api/restricoes-horario-venda?situacao=todos').set(bearer(admin));
    expect(lista.body.total).toBe(1);
    expect((await amb.http().get('/api/restricoes-horario-venda').set(bearer(vendedor))).status).toBe(403);
  });
});

describe('referências do formulário', () => {
  it('busca de NCM por código e por descrição; CFOPs de saída; busca de produtos', async () => {
    const porCodigo = await amb.http().get('/api/ncms?busca=2203').set(bearer(admin));
    expect(porCodigo.body[0]).toMatchObject({ codigo: '22030000', descricao: 'Cervejas de malte.' });
    const porTexto = await amb.http().get('/api/ncms?busca=uisques').set(bearer(admin));
    expect(porTexto.body.some((n: { codigo: string }) => n.codigo === '22083020')).toBe(true);
    expect((await amb.http().get('/api/ncms/99999999').set(bearer(admin))).status).toBe(404);
    const cfops = await amb.http().get('/api/referencias/cfops?prefixo=5').set(bearer(admin));
    expect(cfops.body.map((c: { codigo: string }) => c.codigo)).toContain('5405');
    const busca = await amb.http().get(`/api/produtos/busca?termo=${EAN_BRAHMA}`).set(bearer(admin));
    expect(busca.body[0]).toMatchObject({
      nome: 'CERV BRAHMA LT 350ML',
      ean: EAN_BRAHMA,
      unidadeSigla: 'UN',
    });
    const livre = await amb.http().get('/api/produtos/codigo-interno-livre').set(bearer(admin));
    expect(livre.body.codigo).toMatch(/^2\d{12}$/);
  });
});
