/**
 * Estoque (ERP 13.1, 13.5, 8.2.11; MD 3.7): acerto Entrada / Saída / Definir com movimentos e saldos na mesma
 * transação, custo médio ponderado, diferença do "Definir" que desconta os movimentos posteriores à contagem, saldo
 * negativo (configuração e Master), estorno, imutabilidade, versão, permissões, consulta de saldos e combos montáveis.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { conferirRazaoDasEmpresas } from './razao.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let estoquista: string;
let vendedor: string;
let un: string;
let lojaId: string;
let estoqueLoja: string;
let cerveja: string;
let energetico: string;
let combo: string;
let servico: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  lojaId = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Ice Beer Hermes');
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [lojaId] });
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [lojaId] });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const [l] = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [lojaId],
  );
  estoqueLoja = l!.estoque_id;
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const produto = async (corpo: Record<string, unknown>) => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ unidadeId: un, precoVenda: '10', ...corpo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  cerveja = await produto({ nome: 'CERV BRAHMA LT 350ML', precoCusto: '2', precoVenda: '3,49' });
  energetico = await produto({ nome: 'ENERGETICO RED BULL 2L', precoCusto: '12', precoVenda: '19,90' });
  servico = await produto({ nome: 'ENTREGA', tipo: 'servico', controlaEstoque: false, precoVenda: '5' });
  combo = await produto({
    nome: 'COMBO CERVEJA + ENERGETICO',
    tipo: 'kit',
    precoVenda: '30',
    componentes: [
      { tipo: 'kit', componenteId: cerveja, quantidade: '6', ordem: 0 },
      { tipo: 'kit', componenteId: energetico, quantidade: '1', ordem: 1 },
    ],
  });
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

async function criarAcerto(corpo: Record<string, unknown>, token = admin) {
  return (
    amb
      .http()
      .post('/api/acertos')
      .set(bearer(token))
      // Padrão: "Data" há 3 h. Só o "Definir" lança nela; a Entrada e a Saída lançam no momento da efetivação, e a
      // "Data" fica no cabeçalho (regra de data do F2-B4, ERP 13.1.5 regra 6).
      .send({ estoqueId: estoqueLoja, dataContagem: horasAtras(3), motivo: 'Saldo inicial', ...corpo })
  );
}

async function efetivar(id: string, token = admin) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer(admin));
  return amb
    .http()
    .post(`/api/acertos/${id}/efetivar`)
    .set(bearer(token))
    .send({ versao: atual.body.versao });
}

async function saldoDe(produtoId: string) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select quantidade::text, custo_medio::text from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id
      where s.estoque_id = $1 and s.produto_id = $2 and t.padrao`,
    [estoqueLoja, produtoId],
  );
  return s ? { quantidade: Number(s.quantidade), custoMedio: Number(s.custo_medio) } : null;
}

describe('acerto de estoque (ERP 13.5)', () => {
  let entradaId: string;

  it('rascunho de Entrada com saldo atual, diferença e totais; nada move o estoque antes de efetivar', async () => {
    const r = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [
        { produtoId: cerveja, quantidade: '120', custoUnitario: '2,10' },
        { produtoId: energetico, quantidade: '10' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    entradaId = r.body.id;
    expect(r.body).toMatchObject({
      status: 'rascunho',
      tipoAjuste: 'entrada',
      tipoEstoqueNome: 'Disponível',
      lojaId,
      qtdItens: 2,
      totalVenda: String((120 * 3.49 + 10 * 19.9).toFixed(2)),
      totalCusto: String((120 * 2.1 + 10 * 12).toFixed(2)),
    });
    expect(r.body.itens[0]).toMatchObject({
      saldoAtual: '0.000',
      diferenca: '120.000',
      custoUnitario: '2.1000',
    });
    expect(r.body.itens[1]).toMatchObject({ custoUnitario: '12.0000', custoInformado: null });
    expect(await saldoDe(cerveja)).toBeNull();
  });

  it('efetivar: um movimento por item com custo, saldo e custo médio na mesma transação; documento imutável', async () => {
    const r = await efetivar(entradaId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'efetivado', efetivadoPorNome: expect.any(String) });
    expect(r.body.itens[0]).toMatchObject({ saldoAtual: '0.000', diferenca: '120.000' });
    expect(await saldoDe(cerveja)).toEqual({ quantidade: 120, custoMedio: 2.1 });
    const movs = await consultar(
      emp.nomeBanco,
      `select tipo_movimento, quantidade::text, saldo_anterior::text, saldo_posterior::text, custo_unitario::text,
              custo_total::text, custo_medio_posterior::text, preco_venda::text, documento_tipo, loja_id
         from movimentos_estoque where documento_id = $1 order by produto_id = $2 desc`,
      [entradaId, cerveja],
    );
    expect(movs[0]).toEqual({
      tipo_movimento: 'ACERTO_ENTRADA',
      quantidade: '120.000',
      saldo_anterior: '0.000',
      saldo_posterior: '120.000',
      custo_unitario: '2.1000',
      custo_total: '252.00',
      custo_medio_posterior: '2.1000',
      preco_venda: '3.4900',
      documento_tipo: 'acerto',
      loja_id: lojaId,
    });
    const atual = await amb.http().get(`/api/acertos/${entradaId}`).set(bearer(admin));
    const put = await amb
      .http()
      .put(`/api/acertos/${entradaId}`)
      .set(bearer(admin))
      .send({ ...atual.body, motivo: 'Outro' });
    expect(put.status).toBe(422);
    expect((await efetivar(entradaId)).status).toBe(422);
    await expect(
      consultar(
        emp.nomeBanco,
        'update itens_acerto_estoque set quantidade_informada = 1 where acerto_id = $1',
        [entradaId],
      ),
    ).rejects.toThrow(/DOCUMENTO_IMUTAVEL/);
  });

  it('segunda entrada recalcula o custo médio ponderado; entrada sem custo usa o custo médio', async () => {
    const a = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: cerveja, quantidade: '60', custoUnitario: '2,40' }],
    });
    expect((await efetivar(a.body.id)).status).toBe(200);
    // (120 × 2,10 + 60 × 2,40) / 180 = 2,20
    expect(await saldoDe(cerveja)).toEqual({ quantidade: 180, custoMedio: 2.2 });
  });

  it('Saída sai pelo custo médio; não deixa saldo negativo sem a configuração (Master pode)', async () => {
    const s = await criarAcerto(
      { tipoAjuste: 'saida', motivo: 'Avaria', itens: [{ produtoId: cerveja, quantidade: '12' }] },
      estoquista,
    );
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.totalCusto).toBeNull(); // estoquista sem produtos.ver_custo
    expect((await efetivar(s.body.id, estoquista)).status).toBe(200);
    expect(await saldoDe(cerveja)).toEqual({ quantidade: 168, custoMedio: 2.2 });
    const [m] = await consultar(
      emp.nomeBanco,
      `select quantidade::text, custo_unitario::text from movimentos_estoque where documento_id = $1`,
      [s.body.id],
    );
    expect(m).toEqual({ quantidade: '-12.000', custo_unitario: '2.2000' });

    const demais = await criarAcerto(
      { tipoAjuste: 'saida', motivo: 'Furto/perda', itens: [{ produtoId: energetico, quantidade: '11' }] },
      estoquista,
    );
    const negado = await efetivar(demais.body.id, estoquista);
    expect(negado.status).toBe(422);
    expect(negado.body.campos['itens.0.quantidade'][0]).toMatch(/Saldo insuficiente/);
    expect(await saldoDe(energetico)).toEqual({ quantidade: 10, custoMedio: 12 });
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('estoque.permite_negativo_erp', 'true'::jsonb)`,
    );
    expect((await efetivar(demais.body.id, estoquista)).status).toBe(200);
    expect((await saldoDe(energetico))!.quantidade).toBe(-1);
    await consultar(emp.nomeBanco, `delete from configuracoes where chave = 'estoque.permite_negativo_erp'`);
  });

  it('Definir desconta os movimentos posteriores à contagem (ERP 13.1.5)', async () => {
    // Contagem agora = 150 (depois das Entradas e Saídas já efetivadas, que lançaram no momento da efetivação);
    // depois dela uma saída de 18 já efetivada; saldo 168 − 18 = 150.
    const contagem = await criarAcerto({
      tipoAjuste: 'definir',
      motivo: 'Inventário',
      dataContagem: agora(),
      itens: [{ produtoId: cerveja, quantidade: '150' }],
    });
    expect(contagem.body.itens[0]).toMatchObject({ saldoAtual: '168.000', diferenca: '-18.000' });
    // A "Data" de há 1 h fica no cabeçalho: a Saída lança agora, depois da contagem, e a contagem não a viu.
    const venda = await criarAcerto({
      tipoAjuste: 'saida',
      motivo: 'Consumo interno',
      dataContagem: horasAtras(1),
      itens: [{ produtoId: cerveja, quantidade: '18' }],
    });
    expect((await efetivar(venda.body.id)).status).toBe(200);
    const r = await efetivar(contagem.body.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // diferença = 150 − (150 − (−18)) = −18: a contagem não viu a saída posterior → saldo final 132.
    expect(r.body.itens[0]).toMatchObject({ saldoAtual: '150.000', diferenca: '-18.000' });
    expect((await saldoDe(cerveja))!.quantidade).toBe(132);
    // Definir com a mesma contagem e nada depois: diferença zero não gera movimento.
    const igual = await criarAcerto({
      tipoAjuste: 'definir',
      dataContagem: agora(),
      itens: [{ produtoId: cerveja, quantidade: '132' }],
    });
    const e = await efetivar(igual.body.id);
    expect(e.body.itens[0]).toMatchObject({ diferenca: '0.000' });
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from movimentos_estoque where documento_id = $1',
      [igual.body.id],
    );
    expect(n!.n).toBe(0);
  });

  it('estorno: ESTORNO_ACERTO de sinal oposto, saldo de volta e status estornado', async () => {
    const a = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: energetico, quantidade: '5', custoUnitario: '13' }],
    });
    await efetivar(a.body.id);
    const antes = (await saldoDe(energetico))!.quantidade;
    const atual = await amb.http().get(`/api/acertos/${a.body.id}`).set(bearer(admin));
    expect(
      (
        await amb
          .http()
          .post(`/api/acertos/${a.body.id}/estornar`)
          .set(bearer(admin))
          .send({ versao: atual.body.versao })
      ).status,
    ).toBe(422); // motivo obrigatório
    const r = await amb
      .http()
      .post(`/api/acertos/${a.body.id}/estornar`)
      .set(bearer(admin))
      .send({ versao: atual.body.versao, motivo: 'Lançado em duplicidade' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'estornado', motivoEstorno: 'Lançado em duplicidade' });
    expect((await saldoDe(energetico))!.quantidade).toBe(antes - 5);
    const [m] = await consultar(
      emp.nomeBanco,
      `select tipo_movimento, quantidade::text, estorno_de_id is not null as estorno from movimentos_estoque
        where documento_id = $1 and tipo_movimento = 'ESTORNO_ACERTO'`,
      [a.body.id],
    );
    expect(m).toEqual({ tipo_movimento: 'ESTORNO_ACERTO', quantidade: '-5.000', estorno: true });
    const de_novo = await amb
      .http()
      .post(`/api/acertos/${a.body.id}/estornar`)
      .set(bearer(admin))
      .send({ versao: r.body.versao, motivo: 'x' });
    expect(de_novo.status).toBe(422);
    // movimentos são imutáveis
    await expect(
      consultar(emp.nomeBanco, 'update movimentos_estoque set quantidade = 1 where documento_id = $1', [
        a.body.id,
      ]),
    ).rejects.toThrow(/DOCUMENTO_IMUTAVEL/);
  });

  it('estorno de Saída com saldo negativo: entra ao custo da saída e não redefine o custo médio (T20)', async () => {
    const r0 = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ nome: 'CERV ESTORNO SAIDA LT 350ML', unidadeId: un, precoVenda: '10', precoCusto: '5' });
    expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    const produto = r0.body.id as string;
    const lancar = async (corpo: Record<string, unknown>) => {
      const a = await criarAcerto(corpo);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      const e = await efetivar(a.body.id);
      expect(e.status, JSON.stringify(e.body)).toBe(200);
      return a.body.id as string;
    };
    // Entra 2 a 10,00 (cm 10); sai 5 a 10,00 (Master, saldo −3); compra 1 a 14 (saldo ≤ 0: cm 14, saldo −2).
    await lancar({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: produto, quantidade: '2', custoUnitario: '10' }],
    });
    const saida = await lancar({
      tipoAjuste: 'saida',
      motivo: 'Avaria',
      itens: [{ produtoId: produto, quantidade: '5' }],
    });
    await lancar({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: produto, quantidade: '1', custoUnitario: '14' }],
    });
    expect(await saldoDe(produto)).toEqual({ quantidade: -2, custoMedio: 14 });

    const atual = await amb.http().get(`/api/acertos/${saida}`).set(bearer(admin));
    const r = await amb
      .http()
      .post(`/api/acertos/${saida}/estornar`)
      .set(bearer(admin))
      .send({ versao: atual.body.versao, motivo: 'Avaria lançada no produto errado' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A regra da compra (`cm' = c`) puxaria o custo médio para 10; o estorno só devolve unidades a um custo antigo.
    expect(await saldoDe(produto)).toEqual({ quantidade: 3, custoMedio: 14 });
    const [m] = await consultar(
      emp.nomeBanco,
      `select e.quantidade::text, e.custo_unitario::text, e.custo_medio_posterior::text,
              o.tipo_movimento as original
         from movimentos_estoque e join movimentos_estoque o on o.id = e.estorno_de_id
        where e.documento_id = $1 and e.tipo_movimento = 'ESTORNO_ACERTO'`,
      [saida],
    );
    expect(m).toEqual({
      quantidade: '5.000',
      custo_unitario: '10.0000',
      custo_medio_posterior: '14.0000',
      original: 'ACERTO_SAIDA',
    });
  });

  it('recusa combo, serviço e produto repetido; tipo não muda com itens; 409 de versão; exclui rascunho', async () => {
    const r = await criarAcerto({
      itens: [
        { produtoId: combo, quantidade: '1' },
        { produtoId: servico, quantidade: '1' },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.produtoId'][0]).toMatch(/Combo/);
    expect(r.body.campos['itens.1.produtoId'][0]).toMatch(/Serviço/);
    const rep = await criarAcerto({
      itens: [
        { produtoId: cerveja, quantidade: '1' },
        { produtoId: cerveja, quantidade: '2' },
      ],
    });
    expect(rep.body.campos['itens.1.produtoId'][0]).toMatch(/repetido/);

    const a = await criarAcerto({ itens: [{ produtoId: cerveja, quantidade: '1' }] });
    const base = {
      ...a.body,
      itens: a.body.itens.map((i: Record<string, unknown>) => ({ ...i, custoUnitario: null })),
    };
    const tipo = await amb
      .http()
      .put(`/api/acertos/${a.body.id}`)
      .set(bearer(admin))
      .send({ ...base, tipoAjuste: 'saida' });
    expect(tipo.status).toBe(422);
    expect(tipo.body.campos.tipoAjuste).toBeDefined();
    // troca de item: sai a cerveja, entra o energético; a versão agregada muda
    const ok = await amb
      .http()
      .put(`/api/acertos/${a.body.id}`)
      .set(bearer(admin))
      .send({ ...base, itens: [{ produtoId: energetico, quantidade: '3' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.itens).toHaveLength(1);
    expect(ok.body.itens[0]).toMatchObject({ produtoId: energetico, quantidade: '3.000', sequencia: 2 });
    expect(ok.body.versao).toBeGreaterThan(a.body.versao);
    const velho = await amb.http().put(`/api/acertos/${a.body.id}`).set(bearer(admin)).send(base);
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
    expect((await amb.http().delete(`/api/acertos/${a.body.id}`).set(bearer(admin))).status).toBe(204);
    expect((await amb.http().get(`/api/acertos/${a.body.id}`).set(bearer(admin))).status).toBe(404);
  });

  it('409 com a versão velha quando quem tinha a trava só mexeu nos itens (a versão sai depois da trava)', async () => {
    const a = await criarAcerto({ itens: [{ produtoId: cerveja, quantidade: '1' }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const corpo = {
      ...a.body,
      itens: a.body.itens.map((i: Record<string, unknown>) => ({
        ...i,
        custoUnitario: null,
        quantidade: '4',
      })),
    };
    // Outra transação trava o cabeçalho sem mudá-lo (a versão dele fica) e muda só o custo do item.
    const outra = await conectar(emp.nomeBanco);
    try {
      const pid = (await outra.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await outra.query('begin');
      await outra.query('select id from acertos_estoque where id = $1 for update', [a.body.id]);
      await outra.query('update itens_acerto_estoque set custo_unitario = 9 where acerto_id = $1', [
        a.body.id,
      ]);
      const pu = amb
        .http()
        .put(`/api/acertos/${a.body.id}`)
        .set(bearer(admin))
        .send(corpo)
        .then((x) => x);
      for (let i = 0; ; i++) {
        const espera = await consultar(
          emp.nomeBanco,
          `select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and pid <> $2`,
          [emp.nomeBanco, pid],
        );
        if (espera.length) break;
        if (i > 250) throw new Error('o PUT não chegou a esperar a trava');
        await new Promise((ok) => setTimeout(ok, 20));
      }
      await outra.query('commit');
      const r = await pu;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
    } finally {
      await outra.end();
    }
    const [item] = await consultar<{ quantidade_informada: string; custo_unitario: string }>(
      emp.nomeBanco,
      `select quantidade_informada::text, custo_unitario::text from itens_acerto_estoque
        where acerto_id = $1 and excluido_em is null`,
      [a.body.id],
    );
    expect(item).toEqual({ quantidade_informada: '1.000', custo_unitario: '9.0000' });
    expect((await amb.http().delete(`/api/acertos/${a.body.id}`).set(bearer(admin))).status).toBe(204);
  });

  it('listagem com filtros, custo só com produtos.ver_custo e permissões', async () => {
    const todos = await amb.http().get('/api/acertos?tamanho=50').set(bearer(admin));
    expect(todos.status).toBe(200);
    expect(todos.body.total).toBeGreaterThanOrEqual(7);
    const saidas = await amb.http().get('/api/acertos?tipoAjuste=saida&status=efetivado').set(bearer(admin));
    expect(saidas.body.itens.every((a: { tipoAjuste: string }) => a.tipoAjuste === 'saida')).toBe(true);
    const est = await amb.http().get('/api/acertos?ordenar=codigo:asc').set(bearer(estoquista));
    expect(est.body.itens[0].totalCusto).toBeNull();
    expect(
      (await amb.http().get('/api/acertos?ordenar=total_custo:asc').set(bearer(estoquista))).status,
    ).toBe(403);
    expect((await amb.http().get('/api/acertos').set(bearer(vendedor))).status).toBe(403);
    expect((await criarAcerto({ itens: [] }, vendedor)).status).toBe(403);
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const periodo = await amb
      .http()
      .get(`/api/acertos?dataInicial=${hoje}&dataFinal=${hoje}`)
      .set(bearer(admin));
    expect(periodo.body.total).toBeGreaterThan(0);
    const auditoria = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from auditoria where entidade = 'acertos_estoque' and acao = 'efetivar'`,
    );
    expect(auditoria[0]!.n).toBeGreaterThanOrEqual(5);
  });
});

describe('consulta de saldos (ERP 8.2.11, 16.4) e combos montáveis', () => {
  it('saldo por estoque com custo total, venda total, filtros e totais', async () => {
    const r = await amb
      .http()
      .get(`/api/saldos-estoque?estoqueId=${estoqueLoja}&ordenar=produto:asc`)
      .set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const c = r.body.itens.find((i: { produtoId: string }) => i.produtoId === cerveja);
    expect(c).toMatchObject({
      estoqueNome: 'Estoque Loja 1 - Ice Beer Hermes',
      tipoEstoqueNome: 'Disponível',
      quantidade: '132.000',
      custoMedio: '2.2000',
      custoTotal: '290.40',
      precoVenda: '3.4900',
      vendaTotal: '460.68',
      unidadeSigla: 'UN',
    });
    expect(r.body.itens.some((i: { produtoId: string }) => i.produtoId === combo)).toBe(false);
    expect(r.body.totais.quantidadeItens).toBe(r.body.total);
    const neg = await amb.http().get('/api/saldos-estoque?situacaoSaldo=negativo').set(bearer(admin));
    expect(neg.body.itens.map((i: { produtoId: string }) => i.produtoId)).toEqual([energetico]);
    const nome = await amb.http().get('/api/saldos-estoque?nome=brahma').set(bearer(estoquista));
    expect(nome.body.itens).toHaveLength(1);
    expect(nome.body.itens[0].custoMedio).toBeNull();
    expect(nome.body.totais.custoTotal).toBeNull();
    const sem = await amb
      .http()
      .get(`/api/saldos-estoque?estoqueId=${estoqueLoja}&incluirSemMovimento=true&situacaoSaldo=zerado`)
      .set(bearer(admin));
    expect(sem.body.itens.every((i: { quantidade: string }) => i.quantidade === '0.000')).toBe(true);
    expect((await amb.http().get('/api/saldos-estoque').set(bearer(vendedor))).status).toBe(403);
  });

  it('saldo dos itens da grade e tipos de estoque', async () => {
    const r = await amb
      .http()
      .get(`/api/saldos-estoque/itens?estoqueId=${estoqueLoja}&produtoIds=${cerveja},${servico}`)
      .set(bearer(admin));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.find((i: { produtoId: string }) => i.produtoId === cerveja)).toMatchObject({
      quantidade: '132.000',
      custoMedio: '2.2000',
    });
    expect(r.body.find((i: { produtoId: string }) => i.produtoId === servico)).toMatchObject({
      quantidade: '0',
    });
    const tipos = await amb.http().get('/api/tipos-estoque').set(bearer(vendedor));
    expect(tipos.body[0]).toMatchObject({ nome: 'Disponível', padrao: true, vendavel: true });
  });

  it('combos montáveis = mínimo(saldo ÷ quantidade) com o saldo do acerto', async () => {
    const zera = await criarAcerto({
      tipoAjuste: 'definir',
      dataContagem: agora(),
      itens: [{ produtoId: energetico, quantidade: '4' }],
    });
    expect((await efetivar(zera.body.id)).status).toBe(200);
    const s = await amb.http().get(`/api/produtos/${combo}/saldos`).set(bearer(admin));
    expect(s.body.combo).toBe(true);
    // cerveja 132 ÷ 6 = 22; energético 4 ÷ 1 = 4 → 4 combos, limitados pelo energético
    expect(s.body.montaveis[0]).toMatchObject({ estoqueId: estoqueLoja, quantidade: 4 });
    expect(s.body.montaveis[0].limitadoPor).toMatch(/RED BULL/);
  });
});

describe('projeção do custo médio e custo do combo (MD 3.6.3; ERP 8.2.1, 8.2.17)', () => {
  it('acerto de Entrada → produtos.custo_medio ponderado em decimal; o combo acompanha e o custo entra no histórico', async () => {
    const criarProduto = async (corpo: Record<string, unknown>) => {
      const r = await amb
        .http()
        .post('/api/produtos')
        .set(bearer(admin))
        .send({ unidadeId: un, precoVenda: '10', ...corpo });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const agua = await criarProduto({ nome: 'AGUA TESTE CUSTO MEDIO', precoCusto: '1' });
    const kit = await criarProduto({
      nome: 'COMBO AGUA X2',
      tipo: 'kit',
      precoVenda: '5',
      componentes: [{ tipo: 'kit', componenteId: agua, quantidade: '2', ordem: 0 }],
    });
    const entrada = async (quantidade: string, custoUnitario: string) => {
      const r = await criarAcerto({
        tipoAjuste: 'entrada',
        itens: [{ produtoId: agua, quantidade, custoUnitario }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await efetivar(r.body.id)).status).toBe(200);
    };
    await entrada('3', '1,0005');
    const custo = async (id: string) =>
      (
        await consultar<{ custo_medio: string; preco_custo: string }>(
          emp.nomeBanco,
          'select custo_medio::text, preco_custo::text from produtos where id = $1',
          [id],
        )
      )[0]!;
    expect((await custo(agua)).custo_medio).toBe('1.0005');
    await entrada('1', '2,0005');
    // (3 × 1,0005 + 1 × 2,0005) ÷ 4 = 1,2505 exato (em binário daria 1,2504999…)
    expect((await custo(agua)).custo_medio).toBe('1.2505');
    expect((await custo(kit)).custo_medio).toBe('2.5010');
    // O cabeçalho do produto mostra o custo médio do razão.
    const d = await amb.http().get(`/api/produtos/${agua}`).set(bearer(admin));
    expect(d.body.custoMedio).toBe('1.2505');
    // Custo de componente alterado → custo do combo recalculado pelo banco entra no histórico de preços.
    await consultar(emp.nomeBanco, 'update produtos set preco_custo = 1.5 where id = $1', [agua]);
    expect((await custo(kit)).preco_custo).toBe('3.0000');
    const hist = await consultar<{ valor_anterior: string; valor_novo: string; origem: string }>(
      emp.nomeBanco,
      `select valor_anterior::text, valor_novo::text, origem from produtos_historico_precos
        where produto_id = $1 and tipo_preco = 'custo' order by criado_em`,
      [kit],
    );
    expect(hist.at(-1)).toEqual({ valor_anterior: '2.0000', valor_novo: '3.0000', origem: 'cadastro' });
  });

  it('produzido não tem saldo próprio: acerto recusa (ERP 8.2.4, D17)', async () => {
    const insumo = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ unidadeId: un, nome: 'INSUMO GELO', tipo: 'materia_prima', precoVenda: '0' });
    expect(insumo.status, JSON.stringify(insumo.body)).toBe(201);
    const drink = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        unidadeId: un,
        nome: 'DRINK DA CASA',
        tipo: 'produzido',
        usaFichaTecnica: true,
        precoVenda: '15',
        componentes: [{ tipo: 'ficha_tecnica', componenteId: insumo.body.id, quantidade: '1', ordem: 0 }],
      });
    expect(drink.status, JSON.stringify(drink.body)).toBe(201);
    const r = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: drink.body.id, quantidade: '5' }],
    });
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.produtoId'][0]).toContain('produzido');
  });
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
