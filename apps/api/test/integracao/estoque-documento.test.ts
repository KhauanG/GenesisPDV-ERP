/**
 * Motor de estoque para o documento do PDV (Fase 1C, bloco C6a; SYNC 8.3, 10.2, 10.4, 15.4; MD 3.7.2): o movimento
 * grava terminal, evento, cliente, lote, fator e embalagem; o documento é lançado antes de existir (custo por item
 * para o `INSERT` da venda), com as linhas de saldo travadas uma vez cada em ordem estável, o mesmo insumo somado
 * num `BAIXA_INSUMO` só e o bloco de vasilhames com `documento_item_id` derivado (T4); o estorno entra ao custo da
 * saída original sem distorcer o custo médio (T20); os cadastros são lidos antes da trava 7300001 (`preparar`); duas
 * vendas cruzadas, e uma venda junto de um acerto e de uma importação do ERP, terminam sem deadlock e com o razão
 * consistente; e o tempo com a 7300001 presa numa venda de 10 itens fica abaixo da meta da SYNC 8.3.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { jcs, type Ativar } from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SessaoErp } from '../../src/auth/auth.service.js';
import { verificarCadeia } from '../../src/estoques/cadeia.js';
import {
  itemDerivadoDocumento,
  lancarDocumento,
  lerCadastrosEstoque,
  ordenarChaves,
  type CadastrosEstoque,
  type NovoMovimento,
} from '../../src/estoques/movimentos.js';
import type { LinhaProduto } from '../../src/importacao/produtos.js';
import {
  aplicarEvento,
  carregarTerminalDoEvento,
  MedidorTravaVersao,
  travarTerminal,
} from '../../src/sync/aplicacao.js';
import { eventoSchema } from '../../src/sync/contratos.js';
import type { CatalogoHandlers } from '../../src/sync/eventos.js';
import type { ContextoEmpresa } from '../../src/tenancy/contexto.js';
import type { ClienteEmpresa, DbEmpresa } from '../../src/tenancy/tenancy.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { conferirRazaoDasEmpresas } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

/**
 * Meta da SYNC 8.3: < 50 ms com a 7300001 presa por evento de venda de 10 itens. O CI, com o PostgreSQL dividido
 * entre dois arquivos de integração, afrouxa por `TETO_TRAVA_VERSAO_MS` (ci.yml); o p95 medido sai no log.
 */
const TETO_TRAVA_MS = Number(process.env.TETO_TRAVA_VERSAO_MS ?? 50);

let amb: Ambiente;
let emp: EmpresaTeste;
let contexto: ContextoEmpresa;
let admin: string;
let adminId: string;
let lojaId: string;
let caixaId: string;
let estoqueId: string;
let terminalId: string;
let tipoPadrao: string;
let tipoVazio: string;
let fd: string;
/** Dez produtos de venda, o insumo da ficha (limão), o casco e o fardo com código de barras de fator 12. */
const produtos: string[] = [];
let insumo: string;
let casco: string;
let fardo: string;
let codigoFardo: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const naEmpresa = <T>(fn: () => Promise<T>) => amb.servicos.tenancy.executarNaEmpresa(contexto, fn);

function cabecalhosPdv() {
  return {
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

/** Transação numa conexão própria, fora do `transacao()` da API: deadlock aparece como erro (sem repetição). */
async function transacaoCrua() {
  const c = await conectar(emp.nomeBanco);
  await c.query('begin');
  return {
    c,
    cx: c as unknown as ClienteEmpresa,
    tx: drizzle(c) as unknown as DbEmpresa,
    pid: (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid,
    async fim(confirmar = true) {
      try {
        await c.query(confirmar ? 'commit' : 'rollback');
      } finally {
        await c.end();
      }
    },
  };
}

/** Espera até `n` conexões da empresa (fora `ignorar`) estarem paradas numa trava (advisory ou de linha). */
async function esperarEmTrava(n: number, ignorar: number[] = [], pids?: number[]) {
  for (let i = 0; i < 250; i++) {
    const linhas = await consultar<{ pid: number }>(
      emp.nomeBanco,
      `select pid from pg_stat_activity
        where datname = $1 and wait_event_type = 'Lock' and not (pid = any($2::int[]))
          and ($3::int[] is null or pid = any($3::int[]))`,
      [emp.nomeBanco, ignorar, pids ?? null],
    );
    if (linhas.length >= n) return;
    await esperar(20);
  }
  throw new Error(`nenhuma das ${n} conexões chegou a esperar a trava`);
}

/** Uma venda do caixa: `VENDA_PDV` por item, no estoque da loja, como o handler do C6b vai montar. */
function venda(
  itens: Array<[produto: string, quantidade: string]>,
  extra: Partial<NovoMovimento> = {},
): { documentoId: string; itens: string[]; linhas: NovoMovimento[] } {
  const documentoId = uuidv7();
  const eventoId = uuidv7();
  const ids = itens.map(() => uuidv7());
  return {
    documentoId,
    itens: ids,
    linhas: itens.map(([produtoId, q], i) => ({
      estoqueId,
      produtoId,
      variacaoId: null,
      tipoEstoqueId: tipoPadrao,
      tipoMovimento: 'VENDA_PDV',
      quantidade: `-${q}`,
      custoReferencia: '1',
      precoVenda: '5',
      dataMovimento: new Date(Date.now() - 60_000),
      lojaId,
      usuarioId: adminId,
      documentoTipo: 'venda',
      documentoId,
      documentoItemId: ids[i]!,
      terminalId,
      eventoId,
      unidadeDocumento: 'UN',
      ...extra,
    })),
  };
}

/** Movimento avulso de entrada (fixture de saldo e custo), no tipo padrão. */
const entrada = (produtoId: string, quantidade: string, custo: string): NovoMovimento => ({
  estoqueId,
  produtoId,
  variacaoId: null,
  tipoEstoqueId: tipoPadrao,
  tipoMovimento: 'ACERTO_ENTRADA',
  quantidade,
  custoUnitario: custo,
  custoReferencia: custo,
  precoVenda: null,
  dataMovimento: new Date(),
  lojaId,
  usuarioId: adminId,
  documentoTipo: 'acerto',
  documentoId: null,
  documentoItemId: null,
});

/** Lança um documento numa transação de ERP (`travaVersao`). */
const lancar = (linhas: NovoMovimento[]) =>
  naEmpresa(() =>
    amb.servicos.tenancy.cx().transacao((tx) => lancarDocumento(tx, linhas), { travaVersao: true }),
  );

async function saldo(produtoId: string, tipo = tipoPadrao) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select quantidade::text, custo_medio::text from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueId, produtoId, tipo],
  );
  return s ?? { quantidade: '0.000', custo_medio: '0.0000' };
}

/**
 * O razão fecha com a projeção: saldo = Σ movimentos, e o último movimento gravado na linha termina no saldo. Com
 * travas erradas (duas transações lendo o mesmo saldo), a soma e a projeção divergem.
 */
async function conferirRazao(produtoIds: string[]) {
  const linhas = await consultar<{ produto_id: string; quantidade: string; soma: string; ultimo: string }>(
    emp.nomeBanco,
    `select s.produto_id, s.quantidade::text,
            (select sum(m.quantidade) from movimentos_estoque m
              where m.estoque_id = s.estoque_id and m.produto_id = s.produto_id
                and m.tipo_estoque_id = s.tipo_estoque_id)::text as soma,
            (select m.saldo_posterior from movimentos_estoque m where m.id = s.ultimo_movimento_id)::text as ultimo
       from saldos_estoque s where s.estoque_id = $1 and s.produto_id = any($2::uuid[])`,
    [estoqueId, produtoIds],
  );
  expect(linhas).toHaveLength(produtoIds.length);
  for (const l of linhas) {
    expect(Number(l.soma), l.produto_id).toBe(Number(l.quantidade));
    expect(Number(l.ultimo), l.produto_id).toBe(Number(l.quantidade));
  }
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  lojaId = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  [{ id: caixaId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [lojaId],
  )) as [{ id: string }];
  [{ estoque_id: estoqueId }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [lojaId],
  )) as [{ estoque_id: string }];
  [{ id: adminId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  const tipos = await consultar<{ id: string; padrao: boolean; chave_sistema: string | null }>(
    emp.nomeBanco,
    'select id, padrao, chave_sistema from tipos_estoque',
  );
  tipoPadrao = tipos.find((t) => t.padrao)!.id;
  tipoVazio = tipos.find((t) => t.chave_sistema === 'vasilhame_vazio')!.id;

  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer(admin))).body as Array<{
    id: string;
    sigla: string;
  }>;
  const un = unidades.find((u) => u.sigla === 'UN')!.id;
  fd = unidades.find((u) => u.sigla === 'FD')!.id;
  const criar = async (corpo: Record<string, unknown>) => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ unidadeId: un, precoVenda: '5', precoCusto: '2', ...corpo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  for (let i = 1; i <= 10; i++) produtos.push(await criar({ nome: `CERV TESTE ${i} LT 350ML` }));
  insumo = await criar({ nome: 'LIMAO TAHITI', precoCusto: '0,40' });
  casco = await criar({ nome: 'CASCO 600ML', precoCusto: '1,50' });
  fardo = await criar({
    nome: 'CERV BRAHMA LT 350ML',
    codigosBarras: [
      { codigo: '7891149105106', principal: true },
      { codigo: '7891149103102', unidadeId: fd, fator: '12' },
    ],
  });
  [{ id: codigoFardo }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from produtos_codigos_barras where produto_id = $1 and fator = 12',
    [fardo],
  )) as [{ id: string }];

  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer(admin))
    .send({ lojaId, caixaId, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhosPdv())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  terminalId = r.body.terminal_id;

  // Saldo inicial de tudo a 2,00 (o insumo a 0,40, o casco a 1,50).
  await lancar([
    ...produtos.map((p) => entrada(p, '1000', '2')),
    entrada(insumo, '1000', '0.4'),
    entrada(casco, '100', '1.5'),
    entrada(fardo, '240', '2'),
  ]);
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('movimento do documento do PDV (C6a; MD 3.7.2; SYNC 10.2)', () => {
  it('grava terminal, evento, cliente, lote, fator e embalagem; o custo do item sai antes do documento', async () => {
    const [{ id: pessoaId }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into pessoas (nome) values ('CLIENTE DO BALCAO') returning id",
    )) as [{ id: string }];
    const [{ id: loteId }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_lotes (produto_id, estoque_id, lote) values ($1, $2, 'L2610') returning id",
      [fardo, estoqueId],
    )) as [{ id: string }];
    const cad = await naEmpresa(() =>
      amb.servicos.tenancy.cx().consulta((db) =>
        lerCadastrosEstoque(db, {
          produtoIds: [fardo],
          codigoBarrasIds: [codigoFardo],
          estoqueIds: [estoqueId],
        }),
      ),
    );
    const cb = cad.codigosBarras.get(codigoFardo)!;
    expect(cb).toMatchObject({ produtoId: fardo, fator: '12.000', sigla: 'FD' });
    const v = venda([[fardo, '24']], {
      pessoaId,
      loteId,
      fator: cb.fator,
      unidadeDocumento: cb.sigla,
      dataMovimento: new Date('2026-10-31T14:05:00.000Z'),
    });
    const r = await lancar(v.linhas);
    // Σ custo_total do item (24 × 2,00), para o INSERT de itens_venda/vendas que ainda não existem.
    expect(r.custoPorItem.get(v.itens[0]!)).toBe('48.00');
    expect(r.negativos).toEqual([]);
    expect(await consultar(emp.nomeBanco, 'select 1 from vendas where id = $1', [v.documentoId])).toEqual([]);
    const [m] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select terminal_id, evento_id, pessoa_id, lote_id, fator::text, unidade_documento, quantidade::text,
              custo_unitario::text, custo_total::text, data_movimento, documento_id, documento_item_id, loja_id
         from movimentos_estoque where documento_item_id = $1`,
      [v.itens[0]],
    );
    expect(m).toMatchObject({
      terminal_id: terminalId,
      evento_id: v.linhas[0]!.eventoId,
      pessoa_id: pessoaId,
      lote_id: loteId,
      fator: '12.000',
      unidade_documento: 'FD',
      quantidade: '-24.000',
      custo_unitario: '2.0000',
      custo_total: '48.00',
      documento_id: v.documentoId,
      loja_id: lojaId,
    });
    expect((m!.data_movimento as Date).toISOString()).toBe('2026-10-31T14:05:00.000Z');
  });

  it('o mesmo insumo da ficha vira um BAIXA_INSUMO só; o bloco de vasilhames ganha id derivado (T4)', async () => {
    const v = venda([[produtos[0]!, '2']]);
    const item = v.itens[0]!;
    const baixa = (q: string): NovoMovimento => ({
      ...v.linhas[0]!,
      produtoId: insumo,
      tipoMovimento: 'BAIXA_INSUMO',
      quantidade: q,
    });
    const devolvidos: NovoMovimento = {
      ...v.linhas[0]!,
      produtoId: casco,
      tipoEstoqueId: tipoVazio,
      tipoMovimento: 'VASILHAME_DEVOLVIDO',
      quantidade: '3',
      custoUnitario: '1.5',
      documentoItemId: itemDerivadoDocumento(v.documentoId, 'vasilhames'),
    };
    const linhas = [...v.linhas, baixa('-0.250'), baixa('-0.125'), devolvidos];
    const r = await lancar(linhas);
    expect(r.movimentos).toHaveLength(3);
    // 2 × 2,00 da cerveja + 0,375 × 0,40 do limão (0,15) no custo do item.
    expect(r.custoPorItem.get(item)).toBe('4.15');
    const movs = await consultar<{ tipo_movimento: string; quantidade: string; documento_item_id: string }>(
      emp.nomeBanco,
      `select tipo_movimento, quantidade::text, documento_item_id from movimentos_estoque
        where documento_id = $1 order by tipo_movimento`,
      [v.documentoId],
    );
    expect(movs).toEqual([
      { tipo_movimento: 'BAIXA_INSUMO', quantidade: '-0.375', documento_item_id: item },
      {
        tipo_movimento: 'VASILHAME_DEVOLVIDO',
        quantidade: '3.000',
        documento_item_id: itemDerivadoDocumento(v.documentoId, 'vasilhames'),
      },
      { tipo_movimento: 'VENDA_PDV', quantidade: '-2.000', documento_item_id: item },
    ]);
    expect((await saldo(casco, tipoVazio)).quantidade).toBe('3.000');
    // Reaplicar o mesmo documento (sem a barreira de eventos_recebidos) esbarra no índice, inclusive o vasilhame.
    for (const l of [v.linhas, [devolvidos]]) {
      await expect(lancar(l)).rejects.toMatchObject({
        cause: { code: '23505', constraint: 'uq_movimentos_estoque_idempotencia' },
      });
    }
    expect((await saldo(casco, tipoVazio)).quantidade).toBe('3.000');
  });

  it('saldo negativo nunca é recusado e volta em negativos para o alerta (SYNC 15.1)', async () => {
    const v = venda([[casco, '150']]);
    const r = await lancar(v.linhas);
    expect(r.negativos).toEqual([
      expect.objectContaining({ produtoId: casco, tipoEstoqueId: tipoPadrao, saldoPosterior: '-50.000' }),
    ]);
  });
});

describe('documento grande e ids em outra caixa (C6a)', () => {
  it('mais de 2340 movimentos (65535 parâmetros num comando só) entram em blocos, na mesma transação', async () => {
    // Uma comanda de 300 drinques com 8 insumos cada daria 2400 BAIXA_INSUMO: aqui 2500 itens de 0,001.
    const p = produtos[6]!;
    const antes = Number((await saldo(p)).quantidade);
    const v = venda(Array.from({ length: 2500 }, () => [p, '0.001'] as [string, string]));
    const r = await lancar(v.linhas);
    expect(r.movimentos).toHaveLength(2500);
    expect(r.custoPorItem.size).toBe(2500);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from movimentos_estoque where documento_id = $1',
      [v.documentoId],
    );
    expect(n!.n).toBe(2500);
    expect(Number((await saldo(p)).quantidade)).toBeCloseTo(antes - 2.5, 3);
    await conferirRazao([p]);
  });

  it('blocos menores que o documento: travas, movimentos e saldos de várias linhas continuam certos', async () => {
    const ps = produtos.slice(6, 9);
    const antes = await Promise.all(ps.map((p) => saldo(p)));
    const v = venda([
      [ps[2]!, '1'],
      [ps[0]!, '2'],
      [ps[1]!, '3'],
      [ps[0]!, '4'],
      [ps[2]!, '5'],
    ]);
    const r = await naEmpresa(() =>
      amb.servicos.tenancy
        .cx()
        .transacao((tx) => lancarDocumento(tx, v.linhas, { porComando: 2 }), { travaVersao: true }),
    );
    expect(r.movimentos).toHaveLength(5);
    const depois = await Promise.all(ps.map((p) => saldo(p)));
    expect(depois.map((s, i) => Number(s.quantidade) - Number(antes[i]!.quantidade))).toEqual([-6, -3, -6]);
    await conferirRazao(ps);
  });

  it('o mesmo produto com o id em maiúsculas e em minúsculas é a mesma linha de saldo', async () => {
    const p = produtos[9]!;
    const antes = Number((await saldo(p)).quantidade);
    const v = venda([
      [p.toUpperCase(), '1'],
      [p, '1'],
    ]);
    v.linhas[0] = { ...v.linhas[0]!, documentoItemId: v.itens[0]!.toUpperCase() };
    const r = await lancar(v.linhas);
    // As duas contas partem do saldo travado uma vez: 10 → 9 → 8, e não 10 → 9 duas vezes.
    expect(r.movimentos.map((m) => Number(m.saldoAnterior) - antes)).toEqual([0, -1]);
    expect(r.custoPorItem.get(v.itens[0]!)).toBe('2.00');
    expect(Number((await saldo(p)).quantidade)).toBe(antes - 2);
    await conferirRazao([p]);
  });
});

describe('estorno ao custo da saída original (C6a; T20; SYNC 10.4, 15.4)', () => {
  let produto: string;

  beforeAll(async () => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        nome: 'CERV ESTORNO LT 350ML',
        unidadeId: (
          await consultar<{ id: string }>(emp.nomeBanco, "select id from unidades_medida where sigla = 'UN'")
        )[0]!.id,
        precoVenda: '5',
        precoCusto: '5',
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    produto = r.body.id;
  });

  const estorno = async (documentoItemId: string, tipo = 'CANC_VENDA_PDV') => {
    const [m] = await consultar<{
      id: string;
      quantidade: string;
      custo_unitario: string;
      documento_id: string;
    }>(
      emp.nomeBanco,
      `select id, quantidade::text, custo_unitario::text, documento_id from movimentos_estoque
        where documento_item_id = $1`,
      [documentoItemId],
    );
    return {
      ...venda([[produto, '1']]).linhas[0]!,
      tipoMovimento: tipo,
      quantidade: String(-Number(m!.quantidade)),
      custoUnitario: m!.custo_unitario,
      documentoId: m!.documento_id,
      documentoItemId,
      estornoDeId: m!.id,
    } satisfies NovoMovimento;
  };

  it('saldo positivo: o custo médio fica como se a venda não tivesse acontecido', async () => {
    await lancar([entrada(produto, '10', '5')]);
    const v = venda([[produto, '4']]);
    await lancar(v.linhas);
    await lancar([entrada(produto, '6', '8')]);
    expect(await saldo(produto)).toEqual({ quantidade: '12.000', custo_medio: '6.5000' });
    const r = await lancar([await estorno(v.itens[0]!)]);
    expect(r.movimentos[0]).toMatchObject({ custoUnitario: '5.0000', custoTotal: '20.00' });
    // (10 × 5 + 6 × 8) ÷ 16: o mesmo que nunca ter vendido as 4.
    expect(await saldo(produto)).toEqual({ quantidade: '16.000', custo_medio: '6.1250' });
  });

  it('saldo negativo: devolver unidades a um custo antigo não redefine o custo médio da última compra', async () => {
    const atual = Number((await saldo(produto)).quantidade);
    // Zera; entra 2 a 10,00 (cm 10); vende 11 e 1 a 10,00 (saldo −10); compra 1 a 14 (com saldo ≤ 0 a compra
    // redefine: cm 14, saldo −9). O estorno da venda de 1 entra a 10,00 e o custo médio fica em 14.
    const zerar = venda([[produto, String(atual)]]);
    await lancar(zerar.linhas);
    await lancar([entrada(produto, '2', '10')]);
    const grande = venda([[produto, '11']]);
    const pequena = venda([[produto, '1']]);
    await lancar(grande.linhas);
    await lancar(pequena.linhas);
    await lancar([entrada(produto, '1', '14')]);
    expect(await saldo(produto)).toEqual({ quantidade: '-9.000', custo_medio: '14.0000' });
    const r = await lancar([await estorno(pequena.itens[0]!)]);
    expect(r.movimentos[0]).toMatchObject({ custoUnitario: '10.0000', custoMedioPosterior: '14.0000' });
    expect(await saldo(produto)).toEqual({ quantidade: '-8.000', custo_medio: '14.0000' });
  });

  it('estorno de saída sem o custo original é erro de programa, não entrada ao custo médio', async () => {
    const v = venda([[produto, '1']]);
    await lancar(v.linhas);
    const e = await estorno(v.itens[0]!);
    await expect(lancar([{ ...e, custoUnitario: null }])).rejects.toThrow(/custo da saída original/);
  });
});

describe('concorrência e trava 7300001 (C6a; SYNC 8.1, 8.3; crítica da 1C, item 6)', () => {
  it('duas vendas cruzadas (A,B,C × C,B,A): as linhas são travadas na ordem de ordenarChaves, sem deadlock', async () => {
    // Na ordem em que o motor trava (a mesma de `ordenarChaves`), qualquer que seja a do documento.
    const [a, b, c] = ordenarChaves(produtos.slice(0, 3).map((p) => entrada(p, '1', '1'))).map(
      (l) => l.produtoId,
    ) as [string, string, string];
    const antes = await Promise.all([a, b, c].map((p) => saldo(p)));
    const travarLinha = (cx: Awaited<ReturnType<typeof transacaoCrua>>, produtoId: string, nowait = false) =>
      cx.c.query(
        `select 1 from saldos_estoque where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3
            for update${nowait ? ' nowait' : ''}`,
        [estoqueId, produtoId, tipoPadrao],
      );
    /** `for update nowait` numa conexão à parte: `true` se a linha estava livre (55P03 = travada por outro). */
    const livre = async (produtoId: string) => {
      const sonda = await transacaoCrua();
      try {
        await travarLinha(sonda, produtoId, true);
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === '55P03') return false;
        throw e;
      } finally {
        await sonda.fim(false);
      }
    };
    // Uma terceira transação segura a linha do meio; t1 (documento C,B,A) tem de travar A e parar em B **sem** ter
    // travado C. Com as travas na ordem do documento, t1 pegaria C antes de B, e com t2 (A,B,C) segurando A as duas
    // fechariam um ciclo (40P01) assim que B fosse liberada.
    const meio = await transacaoCrua();
    const t1 = await transacaoCrua();
    const t2 = await transacaoCrua();
    try {
      await travarLinha(meio, b);
      const primeira = lancarDocumento(
        t1.tx,
        venda([
          [c, '3'],
          [b, '2'],
          [a, '1'],
        ]).linhas,
      );
      primeira.catch(() => undefined);
      await esperarEmTrava(1, [], [t1.pid]);
      const segunda = lancarDocumento(
        t2.tx,
        venda([
          [a, '1'],
          [b, '2'],
          [c, '3'],
        ]).linhas,
      );
      segunda.catch(() => undefined);
      await esperarEmTrava(1, [], [t2.pid]);
      expect(await livre(a)).toBe(false);
      expect(await livre(c)).toBe(true);
      await meio.fim(false);
      await primeira;
      await t1.fim();
      await segunda;
      await t2.fim();
    } catch (e) {
      for (const t of [meio, t1, t2]) await t.fim(false).catch(() => undefined);
      throw e;
    }
    const depois = await Promise.all([a, b, c].map((p) => saldo(p)));
    expect(depois.map((s, i) => Number(s.quantidade) - Number(antes[i]!.quantidade))).toEqual([-2, -4, -6]);
    await conferirRazao([a, b, c]);
  });

  it('a leitura dos cadastros não espera a 7300001; a gravação espera', async () => {
    const erp = await transacaoCrua();
    const pdv = await transacaoCrua();
    try {
      await erp.c.query('select fn_trava_versao()');
      await travarTerminal(pdv.cx, terminalId);
      const cad: CadastrosEstoque = await lerCadastrosEstoque(pdv.tx, {
        produtoIds: produtos,
        estoqueIds: [estoqueId, uuidv7()],
      });
      expect(cad.produtos.size).toBe(10);
      expect([...cad.estoquesValidos]).toEqual([estoqueId]);
      expect(cad.tipoEstoquePadraoId).toBe(tipoPadrao);
      expect(cad.tipoEstoqueVasilhameVazioId).toBe(tipoVazio);
      const gravar = (async () => {
        await pdv.c.query('select fn_trava_versao()');
        return lancarDocumento(pdv.tx, venda([[produtos[0]!, '1']]).linhas);
      })();
      await esperarEmTrava(1, [], [pdv.pid]);
      await erp.fim();
      expect((await gravar).movimentos).toHaveLength(1);
      await pdv.fim();
    } catch (e) {
      await erp.fim(false).catch(() => undefined);
      await pdv.fim(false).catch(() => undefined);
      throw e;
    }
  });

  it('venda do caixa ao mesmo tempo que um acerto e uma importação do ERP: todos gravam, razão consistente', async () => {
    const [p1, p2, p3] = produtos.slice(3, 6) as [string, string, string];
    // Acerto de saída do ERP em rascunho (efetivado pela rota, com `travaVersao`).
    const rascunho = await amb
      .http()
      .post('/api/acertos')
      .set(bearer(admin))
      .send({
        estoqueId,
        tipoAjuste: 'saida',
        dataContagem: new Date().toISOString(),
        motivo: 'Avaria',
        itens: [
          { produtoId: p3, quantidade: '5' },
          { produtoId: p2, quantidade: '4' },
        ],
      });
    expect(rascunho.status, JSON.stringify(rascunho.body)).toBe(201);
    const versao = (await amb.http().get(`/api/acertos/${rascunho.body.id}`).set(bearer(admin))).body.versao;

    // Transação de evento do caixa: terminal → leitura sem trava → 7300001 → saldos.
    const pdv = await transacaoCrua();
    try {
      await travarTerminal(pdv.cx, terminalId);
      await lerCadastrosEstoque(pdv.tx, { produtoIds: [p1, p2, p3] });
      await pdv.c.query('select fn_trava_versao()');
      await lancarDocumento(
        pdv.tx,
        venda([
          [p1, '1'],
          [p2, '2'],
          [p3, '3'],
        ]).linhas,
      );

      // `.then` dispara a requisição já (o supertest só envia quando alguém espera).
      const acerto = amb
        .http()
        .post(`/api/acertos/${rascunho.body.id}/efetivar`)
        .set(bearer(admin))
        .send({ versao })
        .then((r) => r);
      // O caminho real de estoque da importação (`Importacoes.acertoEstoque`, privado; chamado como a tarefa chama
      // depois de gravar os produtos): "Definir" efetivado com origem importação, na transação dele, com auditoria.
      const sessao = {
        usuarioId: adminId,
        usuarioNome: 'Administrador',
        master: false,
      } as unknown as SessaoErp;
      const importacao = naEmpresa(() =>
        amb.servicos.importacoes['acertoEstoque'](
          sessao,
          { origem: 'importacao', usuarioId: adminId, usuarioNome: 'Administrador' },
          { estoqueId, lojaId },
          new Date(),
          [
            { id: p2, linha: { estoqueAtual: '500', estoqueContado: '500' } as LinhaProduto },
            { id: p1, linha: { estoqueAtual: '400', estoqueContado: '400' } as LinhaProduto },
          ],
        ),
      );
      // Numa falha do teste as conexões fecham no catch: a rejeição tardia dela não vira erro solto.
      importacao.catch(() => undefined);
      await esperarEmTrava(2, [pdv.pid]);
      await pdv.fim();
      const [ra, ri] = await Promise.all([acerto, importacao]);
      expect(ra.status, JSON.stringify(ra.body)).toBe(200);
      expect(ri).toMatchObject([{ codigo: expect.any(Number) }]);
      const [ac] = await consultar<{ origem: string; status: string; movimentos: number; auditoria: number }>(
        emp.nomeBanco,
        `select a.origem, a.status,
                (select count(*)::int from movimentos_estoque m where m.documento_id = a.id) as movimentos,
                (select count(*)::int from auditoria x where x.registro_id = a.id) as auditoria
           from acertos_estoque a where a.id = $1`,
        [ri[0]!.id],
      );
      expect(ac).toEqual({ origem: 'importacao', status: 'efetivado', movimentos: 2, auditoria: 1 });
    } catch (e) {
      await pdv.fim(false).catch(() => undefined);
      throw e;
    }
    await conferirRazao([p1, p2, p3]);
    // A importação definiu 400/500 depois da venda e do acerto (ou antes do acerto, que tira mais 4 de p2).
    expect(Number((await saldo(p1)).quantidade)).toBe(400);
    expect([500, 496]).toContain(Number((await saldo(p2)).quantidade));
  });

  it('teto: a 7300001 fica presa menos que a meta numa venda de 10 itens com ficha e cascos (p95)', async () => {
    const payloadSchema = z.object({ seq: z.number() });
    const medidor = new MedidorTravaVersao();
    const handlers: CatalogoHandlers = {
      'teste.venda_estoque': {
        1: {
          schema: payloadSchema,
          preparar: ({ tx }) =>
            lerCadastrosEstoque(tx, {
              produtoIds: [...produtos, insumo, casco],
              codigoBarrasIds: [codigoFardo],
              estoqueIds: [estoqueId],
            }),
          async aplicar(ctx, _p, cad: CadastrosEstoque) {
            const v = venda(produtos.map((p) => [p, '1']));
            const linhas: NovoMovimento[] = v.linhas.map((l) => ({
              ...l,
              custoReferencia: cad.produtos.get(l.produtoId)!.precoCusto,
            }));
            const base = linhas[0]!;
            linhas.push(
              { ...base, produtoId: insumo, tipoMovimento: 'BAIXA_INSUMO', quantidade: '-0.1' },
              { ...base, produtoId: insumo, tipoMovimento: 'BAIXA_INSUMO', quantidade: '-0.1' },
              {
                ...base,
                produtoId: casco,
                tipoEstoqueId: cad.tipoEstoqueVasilhameVazioId!,
                tipoMovimento: 'VASILHAME_DEVOLVIDO',
                quantidade: '2',
                custoUnitario: '1.5',
                documentoItemId: itemDerivadoDocumento(v.documentoId, 'vasilhames'),
              },
            );
            const r = await lancarDocumento(ctx.tx, linhas);
            return { movimentos: r.movimentos.length };
          },
        },
      },
    };
    // 100 amostras depois do aquecimento: o p95 (posto mais próximo) é a 95ª, e não a segunda pior de 20; um GC ou
    // um fsync lento no runner não reprova sozinho.
    const AQUECIMENTO = 5;
    for (let i = 0; i < AQUECIMENTO + 100; i++) {
      const payload = { seq: i };
      const ev = eventoSchema.parse({
        evento_id: uuidv7(),
        sequencia: i + 1,
        tipo: 'teste.venda_estoque',
        versao_schema: 1,
        agregado_tipo: 'teste',
        agregado_id: uuidv7(),
        dependencias: [],
        ocorrido_em: new Date().toISOString(),
        usuario_id: adminId,
        contexto: { loja_id: lojaId, caixa_id: caixaId, numero_caixa: 1 },
        payload,
        payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
      });
      let travaEm = 0;
      const resultado = await naEmpresa(() =>
        amb.servicos.tenancy.cx().transacao(async (tx, c) => {
          await travarTerminal(c, terminalId);
          const t = (await carregarTerminalDoEvento(c, terminalId))!;
          const d = await aplicarEvento(tx, c, t, ev, { handlers });
          if (d.status !== 'aplicado') throw new Error(d.status);
          travaEm = d.travaVersaoEm;
          return d.resultado;
        }),
      );
      const ms = performance.now() - travaEm;
      expect(resultado).toEqual({ movimentos: 12 });
      // As primeiras aquecem o pool e o plano das consultas.
      if (i >= AQUECIMENTO) medidor.registrar(ms);
    }
    const resumo = medidor.resumo();
    console.info(
      `trava 7300001 por venda de 10 itens (meta da SYNC 8.3: 50 ms; teto deste teste: ${TETO_TRAVA_MS} ms): ${JSON.stringify(resumo)}`,
    );
    expect(resumo.p95!).toBeLessThan(TETO_TRAVA_MS);
    await conferirRazao([...produtos, insumo]);
  });
});

describe('ordem de lançamento na linha de saldo (F2-B2)', () => {
  it('venda do PDV × acerto do ERP na mesma linha: a seq_lancamento segue a trava e a cadeia fecha', async () => {
    const p = produtos[6]!;
    const pdv = await transacaoCrua();
    let movVenda: string;
    let movAcerto: string;
    try {
      await pdv.c.query('select fn_trava_versao()');
      movVenda = (await lancarDocumento(pdv.tx, venda([[p, '2']]).linhas)).movimentos[0]!.id;
      // O acerto do ERP espera a 7300001 e a linha da venda: entra depois dela, mesmo tendo começado antes do commit.
      const acerto = lancar([entrada(p, '5', '3')]);
      acerto.catch(() => undefined);
      await esperarEmTrava(1, [pdv.pid]);
      await pdv.fim();
      movAcerto = (await acerto).movimentos[0]!.id;
    } catch (e) {
      await pdv.fim(false).catch(() => undefined);
      throw e;
    }
    const seqs = await consultar<{ id: string; seq: string }>(
      emp.nomeBanco,
      'select id, seq_lancamento::text as seq from movimentos_estoque where id = any($1::uuid[])',
      [[movVenda, movAcerto]],
    );
    const seq = (id: string) => Number(seqs.find((x) => x.id === id)!.seq);
    expect(seq(movVenda)).toBeGreaterThanOrEqual(1_000_000_000_000);
    expect(seq(movAcerto)).toBeGreaterThan(seq(movVenda));

    // Rajada: vendas e acertos ao mesmo tempo na mesma linha; a ordem gravada é a do custo médio calculado. A linha já
    // tem os movimentos dos testes anteriores da suíte: a conta é sobre o que entra agora.
    const [{ n: antes }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from movimentos_estoque
        where estoque_id = $1 and produto_id = $2 and variacao_id is null and tipo_estoque_id = $3`,
      [estoqueId, p, tipoPadrao],
    )) as [{ n: number }];
    const rajada = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        i % 2 ? lancar(venda([[p, '1']]).linhas) : lancar([entrada(p, '1', `${2 + i / 10}`)]),
      ),
    );
    const c = await conectar(emp.nomeBanco);
    try {
      const cadeia = await verificarCadeia(c, {
        estoqueId,
        produtoId: p,
        variacaoId: null,
        tipoEstoqueId: tipoPadrao,
      });
      expect(cadeia).toMatchObject({ quebras: 0, primeiraQuebra: null });
      expect(cadeia.movimentos).toBe(antes + 16);
      expect(cadeia.saldoFinal).toBe((await saldo(p)).quantidade);
      // Cada lançamento da rajada gravou o seu movimento, com a ordem acima da do acerto (que veio antes de todos).
      const ids = rajada.map((r) => r.movimentos[0]!.id);
      const daRajada = await consultar<{ seq: string }>(
        emp.nomeBanco,
        'select seq_lancamento::text as seq from movimentos_estoque where id = any($1::uuid[])',
        [ids],
      );
      expect(daRajada).toHaveLength(16);
      expect(daRajada.every((m) => Number(m.seq) > seq(movAcerto))).toBe(true);
    } finally {
      await c.end();
    }
  });
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
