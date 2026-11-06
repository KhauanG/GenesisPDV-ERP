/**
 * Sugestão de reposição da transferência (Fase 2, F2-B25; ERP 13.7 "Sugerir reposição"; F2-Q11 = D52; README da API
 * › decisão 173), pela API do ERP com `produtos_lojas` de verdade. O critério de pronto: mínimo 24, máximo 72, saldo
 * 10 e 12 em trânsito → 50, ou 60 arredondada ao fardo de 12, nunca acima do saldo do CD. Também: o em trânsito conta
 * só as transferências `em_transito` para o destino e o tipo (não o rascunho, a cancelada, a recebida nem a de outro
 * destino); sem máximo, mínimo × 2; o limite ao saldo da origem e o aviso do produto sem saldo nela; ficam de fora o
 * produto no mínimo, o sem mínimo na loja, o inativo na loja, o inativo, o excluído, o que não controla estoque, o
 * serviço, o combo, o produzido e o "Com variações"; a embalagem só de venda e a excluída não arredondam; a chave
 * desligada sai em unidades; o tipo de estoque escolhido (saldos e em trânsito só do tipo); o destino sem loja (aviso);
 * quem pode pedir (a origem permitida para movimentar, o destino permitido para ver, `transferencias.criar`); os erros
 * nos campos do rascunho; e o rascunho gravado com a sugestão.
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
let tokenAdmin: string;
/** Expedidor do CD: tem em `usuarios_estoques` o CD e as lojas que ele abastece (a Loja 1 e a Loja 2). */
let tokenExpedicao: string;
/** Estoquista só da Loja 2: não pede sugestão saindo do CD nem para a Loja 1, que não enxerga. */
let tokenLoja2: string;
/** Vendedor (sem `transferencias.criar`). */
let tokenVendedor: string;
let un: string;
let fd: string;
let loja1: string;
let loja2: string;
let estoqueLoja1: string;
let estoqueLoja2: string;
let cd: string;
let tipoPadrao: string;
let tipoVasilhame: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Mínimo e máximo na Loja 2 (o estoque de destino da sugestão). */
const naLoja2 = (
  estoqueMinimo: string | null,
  estoqueMaximo: string | null,
  extra: Record<string, unknown> = {},
) => ({
  lojas: [{ lojaId: loja2, estoqueMinimo, estoqueMaximo, ...extra }],
});

const fardo = (codigo: string, fator: string, extra: Record<string, unknown> = {}) => ({
  codigo,
  tipo: 'interno',
  unidadeId: fd,
  fator,
  ...extra,
});

async function entrada(estoqueId: string, itens: Array<Record<string, unknown>>, tipoEstoqueId = tipoPadrao) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId,
      tipoEstoqueId,
      motivo: 'Saldo da reposição',
      dataContagem: new Date().toISOString(),
      tipoAjuste: 'entrada',
      itens: itens.map((i) => ({ custoUnitario: '4', ...i })),
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
}

/** Cria a transferência e, se pedido, envia (e recebe ou cancela). */
async function transferencia(
  origem: string,
  destino: string,
  itens: Array<Record<string, unknown>>,
  etapa: 'rascunho' | 'enviar' | 'receber' | 'cancelar',
  tipoEstoqueId: string | null = null,
) {
  const r = await amb
    .http()
    .post('/api/transferencias')
    .set(bearer())
    .send({ estoqueOrigemId: origem, estoqueDestinoId: destino, tipoEstoqueId, motivo: 'Reposição', itens });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (etapa === 'rascunho') return r.body.id as string;
  const e = await amb.http().post(`/api/transferencias/${r.body.id}/enviar`).set(bearer()).send({});
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  if (etapa === 'receber') {
    const rc = await amb
      .http()
      .post(`/api/transferencias/${r.body.id}/receber`)
      .set(bearer())
      .send({ receberTudo: true });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
  }
  if (etapa === 'cancelar') {
    const c = await amb
      .http()
      .post(`/api/transferencias/${r.body.id}/cancelar`)
      .set(bearer())
      .send({ motivo: 'Carga desfeita' });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  }
  return r.body.id as string;
}

type Sugestao = {
  itens: Array<{
    produtoId: string;
    produto: { id: string; nome: string; precoCusto: string | null };
    estoqueMinimo: string;
    estoqueMaximo: string | null;
    saldoDestino: string;
    emTransito: string;
    saldoOrigem: string;
    embalagem: { unidadeSigla: string | null; fator: string } | null;
    quantidade: string;
  }>;
  avisos: string[];
};

const sugerir = (query: Record<string, string>, token = tokenExpedicao) =>
  amb.http().get('/api/transferencias/sugestao-reposicao').query(query).set(bearer(token));

async function sugestao(query: Record<string, string>, token = tokenExpedicao): Promise<Sugestao> {
  const r = await sugerir(query, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Sugestao;
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const estoqueDa = async (loja: string) =>
    (
      await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])
    )[0]!.estoque_id;
  estoqueLoja1 = await estoqueDa(loja1);
  estoqueLoja2 = await estoqueDa(loja2);
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  )) as [{ id: string }];
  [{ id: tipoPadrao }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from tipos_estoque where padrao and excluido_em is null',
  )) as [{ id: string }];
  [{ id: tipoVasilhame }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from tipos_estoque where chave_sistema = 'vasilhame_vazio'",
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'expedicao',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [cd, estoqueLoja1, estoqueLoja2],
  });
  await criarUsuario(emp.nomeBanco, {
    login: 'loja2',
    perfil: 'estoquista',
    lojas: [loja2],
    estoques: [estoqueLoja2],
  });
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja1, loja2] });
  tokenExpedicao = await amb.entrar(emp.codigo, 'expedicao', SENHA_TESTE);
  tokenLoja2 = await amb.entrar(emp.codigo, 'loja2', SENHA_TESTE);
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  fd = unidades.find((u) => u.sigla === 'FD')!.id;
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('sugestão de reposição (F2-B25; ERP 13.7; F2-Q11 = D52)', () => {
  it('mínimo 24, máximo 72, saldo 10 e 12 em trânsito → 50, arredondada a 60 pelo fardo de 12, nunca acima do saldo do CD (critério de pronto)', async () => {
    // A embalagem de compra de maior fator é o FD × 12: a de venda (× 24, sem `usaCompra`) não conta.
    const pilsen = await produto('A Pilsen lata 350ml', {
      ...naLoja2('24', '72'),
      codigosBarras: [fardo('PIL-FD12', '12'), fardo('PIL-CX24', '24', { usaCompra: false })],
    });
    await entrada(cd, [{ produtoId: pilsen, quantidade: '100' }]);
    await entrada(estoqueLoja2, [{ produtoId: pilsen, quantidade: '10' }]);
    // Em trânsito para a Loja 2: 12 (a enviada). Não contam o rascunho, a cancelada (voltou ao CD), a recebida (já está
    // no saldo da loja) nem a enviada para a Loja 1.
    await transferencia(cd, estoqueLoja2, [{ produtoId: pilsen, quantidade: '12' }], 'enviar');
    await transferencia(cd, estoqueLoja2, [{ produtoId: pilsen, quantidade: '5' }], 'rascunho');
    await transferencia(cd, estoqueLoja2, [{ produtoId: pilsen, quantidade: '7' }], 'cancelar');
    await transferencia(cd, estoqueLoja1, [{ produtoId: pilsen, quantidade: '3' }], 'enviar');
    // A Loja 2 recebe 2 (saldo 12): o que chegou não é mais trânsito. Volta a 10 com uma saída.
    await transferencia(cd, estoqueLoja2, [{ produtoId: pilsen, quantidade: '2' }], 'receber');
    const saida = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja2,
        motivo: 'Quebra',
        dataContagem: new Date().toISOString(),
        tipoAjuste: 'saida',
        itens: [{ produtoId: pilsen, quantidade: '2' }],
      });
    expect(saida.status, JSON.stringify(saida.body)).toBe(201);
    expect(
      (
        await amb
          .http()
          .post(`/api/acertos/${saida.body.id}/efetivar`)
          .set(bearer())
          .send({ versao: saida.body.versao })
      ).status,
    ).toBe(200);

    const s = await sugestao({ origem: cd, destino: estoqueLoja2 });
    expect(s.avisos).toEqual([]);
    expect(s.itens).toHaveLength(1);
    expect(s.itens[0]).toMatchObject({
      produtoId: pilsen,
      produto: { id: pilsen, nome: 'A Pilsen lata 350ml', precoCusto: null },
      estoqueMinimo: '24.000',
      estoqueMaximo: '72.000',
      saldoDestino: '10.000',
      emTransito: '12.000',
      // 100 − 12 − 3 − 2 (a cancelada voltou).
      saldoOrigem: '83.000',
      embalagem: { unidadeSigla: 'FD', fator: '12.000' },
      quantidade: '60.000',
    });
    // O `?tipoEstoqueId=` vazio é o padrão.
    expect(
      (await sugestao({ origem: cd, destino: estoqueLoja2, tipoEstoqueId: '' })).itens[0]!.quantidade,
    ).toBe('60.000');

    // Com a chave desligada, a sugestão sai em unidades (a falta de 50).
    const desligada = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({ valores: { 'estoque.reposicao_arredonda_embalagem': false } });
    expect(desligada.status, JSON.stringify(desligada.body)).toBe(200);
    try {
      expect((await sugestao({ origem: cd, destino: estoqueLoja2 })).itens[0]).toMatchObject({
        embalagem: null,
        quantidade: '50.000',
      });
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'estoque.reposicao_arredonda_embalagem'",
      );
    }

    // Nunca acima do saldo do CD: com 55 no CD, a sugestão para em 55 (e não nos 60 do fardo).
    const ajuste = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: cd,
        motivo: 'Contagem',
        dataContagem: new Date().toISOString(),
        tipoAjuste: 'saida',
        itens: [{ produtoId: pilsen, quantidade: '28' }],
      });
    expect(ajuste.status, JSON.stringify(ajuste.body)).toBe(201);
    expect(
      (
        await amb
          .http()
          .post(`/api/acertos/${ajuste.body.id}/efetivar`)
          .set(bearer())
          .send({ versao: ajuste.body.versao })
      ).status,
    ).toBe(200);
    expect((await sugestao({ origem: cd, destino: estoqueLoja2 })).itens[0]).toMatchObject({
      saldoOrigem: '55.000',
      quantidade: '55.000',
    });

    // O admin (`produtos.ver_custo`) vê o custo no produto; e a sugestão grava como rascunho sem retoque.
    const admin = await sugestao({ origem: cd, destino: estoqueLoja2 }, tokenAdmin);
    expect(admin.itens[0]!.produto.precoCusto).not.toBeNull();
    const r = await amb
      .http()
      .post('/api/transferencias')
      .set(bearer(tokenExpedicao))
      .send({
        estoqueOrigemId: cd,
        estoqueDestinoId: estoqueLoja2,
        motivo: 'Reposição sugerida',
        itens: admin.itens.map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade })),
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.itens[0]).toMatchObject({ produtoId: pilsen, quantidadeEnviada: '55.000' });
    await amb.http().delete(`/api/transferencias/${r.body.id}`).set(bearer(tokenExpedicao));
  });

  it('quem entra: sem máximo (mínimo × 2), limite e aviso do saldo da origem, e o que fica de fora', async () => {
    // Os produtos do teste anterior continuam na Loja 2: a Pilsen sai nas contas abaixo pelo nome.
    const semMaximo = await produto('B Água sem gás 500ml', naLoja2('10', null));
    await entrada(cd, [{ produtoId: semMaximo, quantidade: '100' }]);
    await entrada(estoqueLoja2, [{ produtoId: semMaximo, quantidade: '4' }]);
    // Pouco no CD: sugere só os 30 que há (o fardo de 12 daria 72).
    const pouco = await produto('C Refrigerante 2L', {
      ...naLoja2('24', '72'),
      codigosBarras: [fardo('REF-FD6', '6'), fardo('REF-FD12', '12')],
    });
    await entrada(cd, [{ produtoId: pouco, quantidade: '30' }]);
    // No mínimo (24 = 24): não está abaixo.
    const noMinimo = await produto('D Energético 250ml', naLoja2('24', '72'));
    await entrada(cd, [{ produtoId: noMinimo, quantidade: '100' }]);
    await entrada(estoqueLoja2, [{ produtoId: noMinimo, quantidade: '24' }]);
    // Abaixo do mínimo, mas sem saldo no CD: fica de fora, com aviso.
    const semSaldo = await produto('E Vinho tinto 750ml', naLoja2('6', '12'));
    // Sem mínimo na Loja 2 (só máximo; e o mínimo na Loja 1 não conta).
    const semMinimo = await produto('F Gelo 5kg', {
      lojas: [
        { lojaId: loja2, estoqueMinimo: null, estoqueMaximo: '50' },
        { lojaId: loja1, estoqueMinimo: '10', estoqueMaximo: '20' },
      ],
    });
    // Inativo na Loja 2.
    const inativoNaLoja = await produto('G Cachaça 1L', naLoja2('6', '12', { ativoNaLoja: false }));
    // Embalagem de compra excluída: não arredonda.
    const excluida = await produto('H Suco 1L', {
      ...naLoja2('5', '10'),
      codigosBarras: [fardo('SUC-FD12', '12')],
    });
    await consultar(
      emp.nomeBanco,
      "update produtos_codigos_barras set excluido_em = now() where codigo = 'SUC-FD12'",
    );
    // Serviço, combo e produzido não têm saldo próprio, e o "Com variações" tem saldo por variação (o saldo no CD,
    // lançado antes da troca do tipo, não os faz entrar). Cada filtro sozinho: o combo, o produzido e o "Com
    // variações" controlam estoque; o que não controla estoque é simples; o serviço é os dois (o banco exige,
    // `ck_produtos_servico_sem_estoque`). Também o produto inativo e o excluído.
    const servico = await produto('I Taxa de entrega', naLoja2('1', '2'));
    const combo = await produto('J Combo churrasco', naLoja2('1', '2'));
    const produzido = await produto('L Pão de alho da casa', naLoja2('1', '2'));
    const comVariacoes = await produto('M Camiseta Ice Beer', naLoja2('1', '2'));
    const semControle = await produto('N Sacola retornável', naLoja2('1', '2'));
    const inativo = await produto('O Licor fora de linha', naLoja2('1', '2'));
    const excluido = await produto('P Cerveja descontinuada', naLoja2('1', '2'));
    const foraDaLista = [servico, combo, produzido, comVariacoes, semControle, inativo, excluido];
    for (const p of [semMinimo, inativoNaLoja, excluida, ...foraDaLista])
      await entrada(cd, [{ produtoId: p, quantidade: '100' }]);
    await consultar(
      emp.nomeBanco,
      "update produtos set tipo = 'servico', controla_estoque = false where id = $1",
      [servico],
    );
    await consultar(emp.nomeBanco, "update produtos set tipo = 'kit' where id = $1", [combo]);
    await consultar(
      emp.nomeBanco,
      "update produtos set tipo = 'produzido', usa_ficha_tecnica = true where id = $1",
      [produzido],
    );
    await consultar(emp.nomeBanco, "update produtos set tipo = 'com_variacoes' where id = $1", [
      comVariacoes,
    ]);
    await consultar(emp.nomeBanco, 'update produtos set controla_estoque = false where id = $1', [
      semControle,
    ]);
    await consultar(emp.nomeBanco, 'update produtos set ativo = false where id = $1', [inativo]);
    await consultar(emp.nomeBanco, 'update produtos set excluido_em = now() where id = $1', [excluido]);

    const s = await sugestao({ origem: cd, destino: estoqueLoja2 });
    const porId = new Map(s.itens.map((i) => [i.produtoId, i]));
    expect(s.itens.map((i) => i.produto.nome)).toEqual([
      'A Pilsen lata 350ml',
      'B Água sem gás 500ml',
      'C Refrigerante 2L',
      'H Suco 1L',
    ]);
    expect(porId.get(semMaximo)).toMatchObject({
      estoqueMaximo: null,
      saldoDestino: '4.000',
      emTransito: '0.000',
      embalagem: null,
      quantidade: '16.000',
    });
    expect(porId.get(pouco)).toMatchObject({
      saldoDestino: '0.000',
      saldoOrigem: '30.000',
      embalagem: { unidadeSigla: 'FD', fator: '12.000' },
      quantidade: '30.000',
    });
    expect(porId.get(excluida)).toMatchObject({ embalagem: null, quantidade: '10.000' });
    expect(s.avisos).toEqual([
      '1 produto abaixo do mínimo ficou de fora por não ter saldo na origem: E Vinho tinto 750ml.',
    ]);
    expect(porId.has(semSaldo)).toBe(false);
    for (const p of foraDaLista) expect(porId.has(p)).toBe(false);
  });

  it('o tipo de estoque escolhido: saldos e em trânsito do tipo (o Vasilhame vazio)', async () => {
    const casco = await produto('K Casco 600ml', naLoja2('24', '48'));
    await entrada(cd, [{ produtoId: casco, quantidade: '100' }]);
    await entrada(cd, [{ produtoId: casco, quantidade: '40' }], tipoVasilhame);
    await entrada(estoqueLoja2, [{ produtoId: casco, quantidade: '20' }]);
    await transferencia(cd, estoqueLoja2, [{ produtoId: casco, quantidade: '6' }], 'enviar', tipoVasilhame);
    // No Disponível, a Loja 2 tem 20 (abaixo do mínimo) e nada a caminho nesse tipo: os 6 cascos vazios em trânsito
    // não descontam (48 − 20 = 28; se descontassem, seriam 22). No Vasilhame vazio, 0 + 6 em trânsito → 42, limitada
    // aos 34 do CD nesse tipo.
    expect(
      (await sugestao({ origem: cd, destino: estoqueLoja2 })).itens.find((i) => i.produtoId === casco),
    ).toMatchObject({
      saldoDestino: '20.000',
      emTransito: '0.000',
      saldoOrigem: '100.000',
      quantidade: '28.000',
    });
    const v = await sugestao({ origem: cd, destino: estoqueLoja2, tipoEstoqueId: tipoVasilhame });
    expect(v.itens.find((i) => i.produtoId === casco)).toMatchObject({
      saldoDestino: '0.000',
      emTransito: '6.000',
      saldoOrigem: '34.000',
      quantidade: '34.000',
    });
    // Tipo inexistente: 422 no campo do rascunho.
    const r = await sugerir({ origem: cd, destino: estoqueLoja2, tipoEstoqueId: cd });
    expect(r.status).toBe(422);
    expect(r.body.campos.tipoEstoqueId).toBeDefined();
  });

  it('destino sem loja, quem pode pedir (a origem e o destino permitidos) e as recusas nos campos do rascunho', async () => {
    // O CD não é de loja: sugestão vazia, com aviso.
    const semLoja = await sugestao({ origem: estoqueLoja1, destino: cd });
    expect(semLoja.itens).toEqual([]);
    expect(semLoja.avisos[0]).toMatch(/não pertence a uma loja/);
    // A Loja 2 não tem o CD entre os permitidos: 403 no campo da origem, como ao criar.
    const loja2 = await sugerir({ origem: cd, destino: estoqueLoja2 }, tokenLoja2);
    expect(loja2.status).toBe(403);
    expect(loja2.body.campos.estoqueOrigemId).toBeDefined();
    // Nem saindo da própria loja para a Loja 1, que não enxerga: a sugestão mostraria o saldo, o em trânsito, o mínimo e
    // o máximo dela (D45). 403 no campo do destino; o rascunho para a Loja 1 continua aceito (a loja devolve ao CD).
    const paraLoja1 = await sugerir({ origem: estoqueLoja2, destino: estoqueLoja1 }, tokenLoja2);
    expect(paraLoja1.status).toBe(403);
    expect(paraLoja1.body.campos).toEqual({ estoqueDestinoId: ['Fora dos seus estoques permitidos'] });
    expect(paraLoja1.body).not.toHaveProperty('itens');
    // Sem `transferencias.criar`: 403.
    expect((await sugerir({ origem: cd, destino: estoqueLoja2 }, tokenVendedor)).status).toBe(403);
    // Origem = destino, parâmetro faltando e malformado: 422 nos campos do rascunho (não nos nomes da query).
    const iguais = await sugerir({ origem: cd, destino: cd });
    expect(iguais.status).toBe(422);
    expect(iguais.body.campos).toEqual({ estoqueDestinoId: ['O destino tem de ser diferente da origem'] });
    const faltando = await sugerir({ origem: cd });
    expect(faltando.status).toBe(422);
    expect(Object.keys(faltando.body.campos)).toEqual(['estoqueDestinoId']);
    const malformada = await sugerir({ origem: 'x', destino: estoqueLoja2 });
    expect(malformada.status).toBe(422);
    expect(Object.keys(malformada.body.campos)).toEqual(['estoqueOrigemId']);
    // Destino inativo: 422 no campo, como no rascunho.
    await consultar(emp.nomeBanco, 'update estoques set ativo = false where id = $1', [estoqueLoja1]);
    try {
      const inativo = await sugerir({ origem: cd, destino: estoqueLoja1 });
      expect(inativo.status).toBe(422);
      expect(inativo.body.campos.estoqueDestinoId).toEqual(['Estoque inativo']);
    } finally {
      await consultar(emp.nomeBanco, 'update estoques set ativo = true where id = $1', [estoqueLoja1]);
    }
  });
});
