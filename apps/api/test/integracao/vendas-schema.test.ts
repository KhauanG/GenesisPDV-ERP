/**
 * Tabelas de venda e caixa da Fase 1C (bloco C3; migração 0012; MD 3.11.2–3.11.6, 3.12.1–3.12.3, 3.12.6): os CHECKs
 * do MD (um caso inválido por restrição), o 23505 de `uq_vendas_numero` que vira `NUMERO_VENDA_DUPLICADO` (SYNC 13.1),
 * a imutabilidade da venda finalizada/cancelada (com as transições de estado) e dos movimentos de caixa/vasilhame, o
 * `txid` único só no PIX dinâmico, uma sessão aberta por terminal (não por caixa), a versão dos fechamentos com coluna
 * gerada, o destino `entrada` da devolução avulsa (T2), a coluna `vendas.relogio_confiavel` (T5) e a guarda da
 * migração contra eventos de venda/caixa gravados antes das tabelas existirem.
 * Cada teste abre a própria sessão num caixa e terminal só seus (`novoPonto`): roda sozinho (`-t`) e em qualquer ordem.
 */
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATUS_VENDA, STATUS_VENDA_ABERTOS } from '../../src/database/empresa/schema/vendas.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { traduzirErroBanco } from '../../src/sync/erros.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let c: pg.Client;
let loja: string;
let caixa: string;
let terminal: string;
let admin: string;
let produto: string;
let casco: string;
let forma: string;

type Linha = Record<string, unknown>;

async function inserir(tabela: string, dados: Linha): Promise<string> {
  const colunas = Object.keys(dados);
  const { rows } = await c.query<{ id: string }>(
    `insert into ${tabela} (${colunas.join(', ')}) values (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(dados),
  );
  return rows[0]!.id;
}

/** Erro do banco que a promessa lança (para conferir SQLSTATE, restrição e a tradução da SYNC 11.2). */
async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await p;
  } catch (e) {
    return e as pg.DatabaseError;
  }
  throw new Error('esperava erro do banco');
}

async function novoTerminal(caixaId = caixa): Promise<string> {
  return inserir('terminais', { loja_id: loja, caixa_id: caixaId, ativado_em: new Date() });
}

/** Caixa e terminal só do teste (um terminal `ativo` por caixa, `uq_terminais_caixa_ativo`). */
interface Ponto {
  caixa: string;
  numero: number;
  terminal: string;
}

let numeroCaixa = 1;
async function novoPonto(): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  return { caixa: id, numero, terminal: await novoTerminal(id) };
}

const sessao = (p: Ponto, extra: Linha = {}) =>
  inserir('sessoes_caixa', {
    loja_id: loja,
    caixa_id: p.caixa,
    numero_caixa: p.numero,
    terminal_id: p.terminal,
    operador_id: admin,
    dia_operacional: '2026-10-31',
    aberta_em: new Date(),
    fundo_troco: '100.00',
    ...extra,
  });

let numero = 0;
const venda = (sessaoId: string | null, extra: Linha = {}) => {
  const n = (extra.numero as number | undefined) ?? ++numero;
  return inserir('vendas', {
    numero: n,
    numero_exibicao: `L01-C01-${String(n).padStart(6, '0')}`,
    loja_id: loja,
    caixa_id: caixa,
    numero_caixa: 1,
    terminal_id: terminal,
    sessao_caixa_id: sessaoId,
    tipo: 'pdv',
    operador_id: admin,
    iniciada_em: new Date(),
    ...extra,
  });
};

const item = (vendaId: string, extra: Linha = {}) =>
  inserir('itens_venda', {
    venda_id: vendaId,
    sequencia: 1,
    produto_id: produto,
    descricao: 'Cerveja lata 350ml',
    unidade: 'UN',
    quantidade: '1.000',
    preco_tabela: '5.0000',
    preco_unitario: '5.0000',
    valor_bruto: '5.00',
    valor_liquido: '5.00',
    incluido_em: new Date(),
    ...extra,
  });

const pagamento = (vendaId: string, extra: Linha = {}) =>
  inserir('pagamentos_venda', {
    venda_id: vendaId,
    sequencia: 1,
    forma_pagamento_id: forma,
    descricao_forma: 'Dinheiro',
    meio_pagamento_fiscal: '01',
    tipo_forma: 'dinheiro',
    valor: '5.00',
    lanca_quitada: true,
    ...extra,
  });

const cobrancaPix = (extra: Linha = {}) =>
  inserir('cobrancas_pix', {
    txid: 'L01C01000001',
    tipo: 'estatico',
    loja_id: loja,
    terminal_id: terminal,
    valor: '5.00',
    qrcode_payload: '00020126330014br.gov.bcb.pix',
    ...extra,
  });

/** Confere que cada caso viola exatamente a restrição esperada e que o push o traduziria para PAYLOAD_INVALIDO. */
async function recusados(casos: Array<[() => Promise<unknown>, string]>): Promise<void> {
  for (const [inserirCaso, restricao] of casos) {
    const e = await erroDe(inserirCaso());
    expect(e, restricao).toMatchObject({ code: '23514', constraint: restricao });
    expect(traduzirErroBanco(e), restricao).toMatchObject({ codigo: 'PAYLOAD_INVALIDO' });
  }
}

/** Argumentos de um trigger, como o `create trigger` os declarou. */
async function argumentosTrigger(tabela: string, trigger: string): Promise<string[]> {
  const [{ definicao }] = (await consultar<{ definicao: string }>(
    emp.nomeBanco,
    `select pg_get_triggerdef(t.oid) as definicao from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = $1 and t.tgname = $2`,
    [tabela, trigger],
  )) as [{ definicao: string }];
  const lista = /EXECUTE FUNCTION \w+\((.*)\)$/.exec(definicao)![1]!;
  return lista.split(', ').map((a) => a.replace(/^'|'$/g, ''));
}

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  emp = await amb.criarEmpresa();
  c = await conectar(emp.nomeBanco);
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja],
  )) as [{ id: string }];
  terminal = await novoTerminal();
  [{ id: admin }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  const [{ id: un }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from unidades_medida where sigla = 'UN' and excluido_em is null",
  )) as [{ id: string }];
  produto = await inserir('produtos', { nome: 'Cerveja lata 350ml', unidade_id: un });
  casco = await inserir('produtos', { nome: 'Casco 600ml', unidade_id: un, tipo: 'vasilhame' });
  [{ id: forma }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null limit 1",
  )) as [{ id: string }];
});

afterAll(async () => {
  await c?.end();
  await amb?.fechar();
});

describe('vendas (MD 3.11.2–3.11.4)', () => {
  it('venda com item e pagamento; relogio_confiavel padrão true; nada desce (fn_versao_local)', async () => {
    const p = await novoPonto();
    const s = await sessao(p);
    const v = await venda(s, {
      status: 'finalizada',
      finalizada_em: new Date(),
      total: '5.00',
      caixa_id: p.caixa,
      numero_caixa: p.numero,
      terminal_id: p.terminal,
    });
    await item(v);
    await pagamento(v);
    const { rows } = await c.query<{ relogio_confiavel: boolean; versao: string }>(
      'select relogio_confiavel, versao from vendas where id = $1',
      [v],
    );
    expect(rows[0]!.relogio_confiavel).toBe(true);
    expect(Number(rows[0]!.versao)).toBeGreaterThan(0);
  });

  it('CHECKs do MD: enumerações, finalizada sem data, cancelada sem motivo, CPF/CNPJ da nota, valores', async () => {
    const casos: Array<[Linha, string]> = [
      [{ status: 'aberta' }, 'ck_vendas_status'],
      [{ canal: 'balcao' }, 'ck_vendas_canal'],
      [{ status_fiscal: 'emitida' }, 'ck_vendas_status_fiscal'],
      [{ cancelamento_origem: 'api' }, 'ck_vendas_cancelamento_origem'],
      [{ status: 'finalizada' }, 'ck_vendas_finalizada'],
      [{ status: 'cancelada', cancelada_em: new Date() }, 'ck_vendas_cancelada'],
      [{ cpf_cnpj_nota: '123.456.789-09' }, 'ck_vendas_cpf_cnpj_nota'],
      [{ cpf_cnpj_nota: '12abc34501de35' }, 'ck_vendas_cpf_cnpj_nota'],
      [{ total: '-1.00' }, 'ck_vendas_valores'],
      [{ idade_confirmada_por_id: admin }, 'ck_vendas_idade_confirmada'],
    ];
    for (const [extra, restricao] of casos) {
      const e = await erroDe(venda(null, extra));
      expect(e, restricao).toMatchObject({ code: '23514', constraint: restricao });
      expect(traduzirErroBanco(e)).toMatchObject({ codigo: 'PAYLOAD_INVALIDO' });
    }
    // CPF e CNPJ alfanumérico válidos passam.
    await venda(null, { cpf_cnpj_nota: '12345678909' });
    await venda(null, { cpf_cnpj_nota: '12ABC34501DE35' });
  });

  it('CHECKs de itens, pagamentos, parcelas, TEF e PIX: um caso inválido por restrição', async () => {
    const v = await venda(null);
    await recusados([
      [() => item(v, { quantidade: '0.000' }), 'ck_itens_venda_quantidade'],
      [() => item(v, { desconto_item: '-1.00' }), 'ck_itens_venda_valores'],
      [() => item(v, { desconto_promocao: '1.00' }), 'ck_itens_venda_promocao'],
      [() => item(v, { quantidade_devolvida: '2.000' }), 'ck_itens_venda_devolvida'],
      [() => item(v, { origem_preco: 'tabela' }), 'ck_itens_venda_origem_preco'],
      [() => item(v, { origem_entrada: 'voz' }), 'ck_itens_venda_origem_entrada'],
      [() => item(v, { kit_grupo_id: uuidv7() }), 'ck_itens_venda_kit'],
      [() => pagamento(v, { valor: '0.00' }), 'ck_pagamentos_venda_valor'],
      [() => pagamento(v, { valor_taxa_servico: '6.00' }), 'ck_pagamentos_venda_valor'],
      [() => pagamento(v, { status: 'pago' }), 'ck_pagamentos_venda_status'],
      [() => pagamento(v, { parcelas: 0 }), 'ck_pagamentos_venda_parcelas'],
      [() => pagamento(v, { tipo_integracao: 3 }), 'ck_pagamentos_venda_tipo_integracao'],
      [() => pagamento(v, { indicador_pagamento: 2 }), 'ck_pagamentos_venda_indicador'],
      [() => pagamento(v, { cnpj_pagamento: '12345678000195' }), 'ck_pagamentos_venda_uf_pagamento'],
    ]);
    const pg1 = await pagamento(v, { tipo_forma: 'cartao_credito', parcelas: 2 });
    const parcela = (valor: string) =>
      inserir('parcelas_venda', { pagamento_venda_id: pg1, numero: 1, vencimento: '2026-11-30', valor });
    const tef = (extra: Linha) =>
      inserir('transacoes_tef', {
        loja_id: loja,
        terminal_id: terminal,
        provedor: 'sitef',
        valor: '5.00',
        iniciada_em: new Date(),
        ...extra,
      });
    await recusados([
      [() => parcela('0.00'), 'ck_parcelas_venda_valor'],
      [() => tef({ status: 'aprovada' }), 'ck_transacoes_tef_status'],
      [() => tef({ operacao: 'estorno' }), 'ck_transacoes_tef_operacao'],
      [() => cobrancaPix({ tipo: 'fixo' }), 'ck_cobrancas_pix_tipo'],
      [() => cobrancaPix({ status: 'pendente' }), 'ck_cobrancas_pix_status'],
    ]);
    // Os padrões passam.
    await parcela('2.50');
    await tef({});
  });

  it('cobrancas_pix: txid repetido só é recusado no dinâmico; terminal_id é filtro imutável (MD 6.4 regra 2)', async () => {
    // Venda dividida em dois PIX estáticos: as duas cobranças levam o número da venda como txid (PDV 16.7).
    const txid = 'L01C01000777';
    const estatica = await cobrancaPix({ txid });
    await cobrancaPix({ txid });
    await cobrancaPix({ txid: 'E2E-PSP-0001', tipo: 'dinamico' });
    const e = await erroDe(cobrancaPix({ txid: 'E2E-PSP-0001', tipo: 'dinamico' }));
    expect(e).toMatchObject({ code: '23505', constraint: 'uq_cobrancas_pix_txid' });
    // O dinâmico nasce na nuvem (Fase 6): repetido no push é divergência, não payload inválido.
    expect(traduzirErroBanco(e)).toMatchObject({ codigo: 'AGREGADO_DIVERGENTE' });
    // Um estático com o txid de um dinâmico também passa (o índice único é parcial).
    await cobrancaPix({ txid: 'E2E-PSP-0001' });
    const { terminal: outro } = await novoPonto();
    await expect(
      c.query('update cobrancas_pix set terminal_id = $2 where id = $1', [estatica, outro]),
    ).rejects.toMatchObject({ code: 'P0001', message: 'FILTRO_IMUTAVEL' });
    await c.query("update cobrancas_pix set status = 'paga', paga_em = now() where id = $1", [estatica]);
  });

  it('número repetido no mesmo caixa vira NUMERO_VENDA_DUPLICADO; outro caixa da loja pode usar o mesmo número', async () => {
    const n = 9_000;
    await venda(null, { numero: n });
    const e = await erroDe(venda(null, { numero: n }));
    expect(e).toMatchObject({ code: '23505', constraint: 'uq_vendas_numero' });
    expect(traduzirErroBanco(e)).toMatchObject({ codigo: 'NUMERO_VENDA_DUPLICADO' });
    await venda(null, { numero: n, numero_caixa: 2, numero_exibicao: 'L01-C02-009000' });
  });

  it('referência inexistente (produto) vira REFERENCIA_INEXISTENTE', async () => {
    const v = await venda(null);
    const e = await erroDe(
      inserir('itens_venda', {
        venda_id: v,
        sequencia: 1,
        produto_id: uuidv7(),
        descricao: 'Fantasma',
        unidade: 'UN',
        quantidade: '1.000',
        preco_tabela: '1.0000',
        preco_unitario: '1.0000',
        valor_bruto: '1.00',
        valor_liquido: '1.00',
        incluido_em: new Date(),
      }),
    );
    expect(e).toMatchObject({ code: '23503', constraint: 'fk_itens_venda_produto_id' });
    expect(traduzirErroBanco(e)).toMatchObject({ codigo: 'REFERENCIA_INEXISTENTE' });
  });

  it('imutável depois de finalizada: só estado, fiscal, devolução, custo e cancelamento mudam', async () => {
    const aberta = await venda(null);
    await c.query("update vendas set total = '10.00', observacao = 'livre' where id = $1", [aberta]);
    await c.query("update vendas set status = 'finalizada', finalizada_em = now() where id = $1", [aberta]);
    for (const sql of [
      "update vendas set total = '11.00' where id = $1",
      "update vendas set observacao = 'mudou' where id = $1",
      'update vendas set relogio_confiavel = false where id = $1',
      'update vendas set excluido_em = now() where id = $1',
    ]) {
      await expect(c.query(sql, [aberta]), sql).rejects.toMatchObject({
        code: 'P0001',
        message: 'DOCUMENTO_IMUTAVEL',
      });
    }
    await c.query("update vendas set custo_total = '4.20', status_fiscal = 'pendente' where id = $1", [
      aberta,
    ]);
    // Cancelamento da venda finalizada (forma A, SYNC 9.9): só as colunas de cancelamento.
    await c.query(
      `update vendas set status = 'cancelada', cancelada_em = now(), cancelada_por_id = $2,
         motivo_cancelamento = 'Cliente desistiu da compra', cancelamento_origem = 'pdv' where id = $1`,
      [aberta, admin],
    );
    await expect(
      c.query("update vendas set desconto_total = '1.00' where id = $1", [aberta]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
  });

  it('transições: finalizada não reabre; cancelada é terminal e não descancela (tg_vendas_transicao)', async () => {
    const imutavel = { code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' };
    const cancelar = (id: string) =>
      c.query(
        `update vendas set status = 'cancelada', cancelada_em = now(), cancelada_por_id = $2,
           motivo_cancelamento = 'Cliente desistiu da compra', cancelamento_origem = 'pdv' where id = $1`,
        [id, admin],
      );
    // Estados abertos andam livremente (inclusive para trás).
    const v = await venda(null);
    for (const status of ['em_pagamento', 'suspensa', 'em_andamento', 'pedido_pendente'])
      await c.query('update vendas set status = $2 where id = $1', [v, status]);
    await c.query("update vendas set status = 'finalizada', finalizada_em = now() where id = $1", [v]);
    // Reabrir a finalizada (o 1º passo de "reabre e edita") e mexer no cancelamento sem cancelar.
    for (const sql of [
      "update vendas set status = 'em_andamento' where id = $1",
      "update vendas set status = 'rascunho' where id = $1",
      "update vendas set motivo_cancelamento = 'Ainda não cancelada aqui' where id = $1",
      "update vendas set cancelamento_origem = 'erp' where id = $1",
    ])
      await expect(c.query(sql, [v]), sql).rejects.toMatchObject(imutavel);
    // Reaplicação sem mudança e o fiscal continuam passando na finalizada.
    await c.query("update vendas set status = 'finalizada', status_fiscal = 'autorizada' where id = $1", [v]);
    await cancelar(v);
    // Descancelar (voltar a finalizada limpando as colunas), reabrir ou reescrever o cancelamento.
    for (const sql of [
      `update vendas set status = 'finalizada', cancelada_em = null, cancelada_por_id = null,
         motivo_cancelamento = null, cancelamento_origem = null where id = $1`,
      "update vendas set status = 'em_andamento' where id = $1",
      "update vendas set motivo_cancelamento = 'Outro motivo qualquer aqui' where id = $1",
      "update vendas set cancelada_em = cancelada_em - interval '1 day' where id = $1",
    ])
      await expect(c.query(sql, [v]), sql).rejects.toMatchObject(imutavel);
    // Na cancelada ainda andam o fiscal (cancelamento da NFC-e), a devolução e o custo.
    await c.query(
      "update vendas set status_fiscal = 'cancelamento_pendente', custo_total = '3.10' where id = $1",
      [v],
    );
    const { rows } = await c.query<{ status: string; status_fiscal: string }>(
      'select status, status_fiscal from vendas where id = $1',
      [v],
    );
    expect(rows[0]).toEqual({ status: 'cancelada', status_fiscal: 'cancelamento_pendente' });
  });

  it('estados abertos do trigger de imutabilidade = STATUS_VENDA_ABERTOS; fechados = finalizada e cancelada', async () => {
    const [coluna, abertos] = await argumentosTrigger('vendas', 'tg_vendas_imutavel');
    expect(coluna).toBe('status');
    expect(abertos!.split(',')).toEqual([...STATUS_VENDA_ABERTOS]);
    // A máquina de estados de tg_vendas_transicao conhece só os dois fechados: estado novo cai num dos lados.
    expect(STATUS_VENDA.filter((s) => !(STATUS_VENDA_ABERTOS as readonly string[]).includes(s))).toEqual([
      'finalizada',
      'cancelada',
    ]);
  });
});

describe('caixa (MD 3.12.1–3.12.3)', () => {
  it('uma sessão aberta por terminal; o substituto do mesmo caixa abre a sua', async () => {
    const p = await novoPonto();
    const s1 = await sessao(p);
    const e = await erroDe(sessao(p));
    expect(e).toMatchObject({ code: '23505', constraint: 'uq_sessoes_caixa_aberta' });
    expect(traduzirErroBanco(e)).toMatchObject({ codigo: 'AGREGADO_DIVERGENTE' });
    // Terminal substituto (o antigo revogado com o turno aberto): sessão própria no mesmo caixa.
    await c.query("update terminais set status = 'revogado', revogado_em = now() where id = $1", [
      p.terminal,
    ]);
    const substituto = { ...p, terminal: await novoTerminal(p.caixa) };
    const s2 = await sessao(substituto);
    expect(s2).not.toBe(s1);
    // Fechamento forçado exige status fechada e motivo, e o motivo é da enumeração.
    await expect(
      c.query('update sessoes_caixa set fechamento_forcado = true where id = $1', [s1]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_sessoes_caixa_forcado' });
    await recusados([
      [() => sessao(substituto, { status: 'suspensa' }), 'ck_sessoes_caixa_status'],
      [
        () =>
          c.query(
            `update sessoes_caixa set status = 'fechada', fechada_em = now(), fechamento_forcado = true,
               fechamento_forcado_motivo = 'pc_queimado' where id = $1`,
            [s1],
          ),
        'ck_sessoes_caixa_forcado_motivo',
      ],
    ]);
    await c.query(
      `update sessoes_caixa set status = 'fechada', fechada_em = now(), fechamento_forcado = true,
         fechamento_forcado_motivo = 'substituicao_terminal' where id = $1`,
      [s1],
    );
    // Depois de fechada, o terminal pode abrir outra (o próximo turno).
    await c.query("update terminais set status = 'revogado', revogado_em = now() where id = $1", [
      substituto.terminal,
    ]);
    await c.query("update terminais set status = 'ativo', revogado_em = null where id = $1", [p.terminal]);
    await c.query("update sessoes_caixa set status = 'fechada', fechada_em = now() where id = $1", [s2]);
    await sessao(p);
  });

  it('movimentos: CHECKs de tipo, valor, sangria e estorno; imutável fora do cancelamento', async () => {
    const p = await novoPonto();
    const s = await sessao(p);
    const movimento = (extra: Linha) =>
      inserir('movimentos_caixa', {
        sessao_caixa_id: s,
        loja_id: loja,
        caixa_id: p.caixa,
        numero_caixa: p.numero,
        terminal_id: p.terminal,
        operador_id: admin,
        valor: '50.00',
        ocorrido_em: new Date(),
        ...extra,
      });
    const casos: Array<[Linha, string]> = [
      [{ tipo: 'retirada' }, 'ck_movimentos_caixa_tipo'],
      [{ tipo: 'reforco', valor: '0.00' }, 'ck_movimentos_caixa_valor'],
      [{ tipo: 'sangria' }, 'ck_movimentos_caixa_sangria'],
      [{ tipo: 'estorno_venda' }, 'ck_movimentos_caixa_estorno_forma'],
      [{ tipo: 'reforco', cancelado: true }, 'ck_movimentos_caixa_cancelado'],
    ];
    for (const [extra, restricao] of casos) {
      await expect(movimento(extra), restricao).rejects.toMatchObject({
        code: '23514',
        constraint: restricao,
      });
    }
    const sangria = await movimento({ tipo: 'sangria', quem_retira_nome: 'Gerente' });
    await movimento({ tipo: 'estorno_venda', forma_pagamento_id: forma });
    await expect(
      c.query("update movimentos_caixa set valor = '40.00' where id = $1", [sangria]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    await c.query(
      `update movimentos_caixa set cancelado = true, cancelado_em = now(), cancelado_por_id = $2,
         motivo_cancelamento = 'Lançada em duplicidade' where id = $1`,
      [sangria, admin],
    );
  });

  it('fechamento: um por sessão, zera só no fechamento, diferença gerada (total e por forma)', async () => {
    const p = await novoPonto();
    const s = await sessao(p);
    const fechamento = (extra: Linha) =>
      inserir('fechamentos_caixa', {
        sessao_caixa_id: s,
        loja_id: loja,
        caixa_id: p.caixa,
        terminal_id: p.terminal,
        numero_caixa: p.numero,
        tipo: 'fechamento',
        zera_caixa: true,
        usuario_anterior_id: admin,
        total_calculado: '150.00',
        total_digitado: '148.50',
        fechamento_cego: true,
        ocorrido_em: new Date(),
        dia_operacional: '2026-10-31',
        ...extra,
      });
    await expect(fechamento({ tipo: 'troca_turno' })).rejects.toMatchObject({
      constraint: 'ck_fechamentos_caixa_zera',
    });
    const f = await fechamento({});
    await expect(fechamento({})).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_fechamentos_caixa_sessao_caixa_id',
    });
    await inserir('fechamentos_caixa_formas', {
      fechamento_id: f,
      forma_pagamento_id: forma,
      descricao_forma: 'Dinheiro',
      tipo_forma: 'dinheiro',
      valor_calculado: '150.00',
      valor_digitado: '148.50',
    });
    const { rows } = await c.query<{ total: string; forma: string }>(
      `select f.diferenca as total, ff.diferenca as forma from fechamentos_caixa f
       join fechamentos_caixa_formas ff on ff.fechamento_id = f.id where f.id = $1`,
      [f],
    );
    expect(rows[0]).toEqual({ total: '-1.50', forma: '-1.50' });
  });

  it('fechamento: UPDATE sem mudança real não gera versão, apesar da coluna gerada (fn_versao_local isenta)', async () => {
    const p = await novoPonto();
    const s = await sessao(p);
    const f = await inserir('fechamentos_caixa', {
      sessao_caixa_id: s,
      loja_id: loja,
      caixa_id: p.caixa,
      terminal_id: p.terminal,
      numero_caixa: p.numero,
      tipo: 'troca_turno',
      zera_caixa: false,
      usuario_anterior_id: admin,
      total_calculado: '80.00',
      total_digitado: '80.00',
      fechamento_cego: true,
      ocorrido_em: new Date(),
      dia_operacional: '2026-10-31',
    });
    const ff = await inserir('fechamentos_caixa_formas', {
      fechamento_id: f,
      forma_pagamento_id: forma,
      descricao_forma: 'Dinheiro',
      tipo_forma: 'dinheiro',
      valor_calculado: '80.00',
      valor_digitado: '79.00',
    });
    const versao = async (tabela: string, id: string) =>
      (
        await c.query<{ versao: string; atualizado_em: Date; diferenca: string }>(
          `select versao, atualizado_em, diferenca from ${tabela} where id = $1`,
          [id],
        )
      ).rows[0]!;
    const f0 = await versao('fechamentos_caixa', f);
    const ff0 = await versao('fechamentos_caixa_formas', ff);
    // Reaplicação do `caixa.fechado` e o `usuario_subsequente_id` repetido do `caixa.aberto` (SYNC 9.3): no-op.
    await c.query('update fechamentos_caixa set total_digitado = total_digitado where id = $1', [f]);
    await c.query('update fechamentos_caixa_formas set valor_digitado = valor_digitado where id = $1', [ff]);
    expect(await versao('fechamentos_caixa', f)).toEqual(f0);
    expect(await versao('fechamentos_caixa_formas', ff)).toEqual(ff0);
    await c.query('update fechamentos_caixa set usuario_subsequente_id = $2 where id = $1', [f, admin]);
    const f1 = await versao('fechamentos_caixa', f);
    expect(Number(f1.versao)).toBeGreaterThan(Number(f0.versao));
    await c.query('update fechamentos_caixa set usuario_subsequente_id = $2 where id = $1', [f, admin]);
    expect(await versao('fechamentos_caixa', f)).toEqual(f1);
    // Mudança real versiona e a gerada acompanha.
    await c.query("update fechamentos_caixa_formas set valor_digitado = '80.00' where id = $1", [ff]);
    const ff1 = await versao('fechamentos_caixa_formas', ff);
    expect(Number(ff1.versao)).toBeGreaterThan(Number(ff0.versao));
    expect(ff1.diferenca).toBe('0.00');
  });
});

describe('movimentos_vasilhame (MD 3.12.6, T2)', () => {
  it('destino entrada (Fase 1) sem pessoa nem vale; comodato exige pessoa; vale exige vale_id; imutável', async () => {
    const p = await novoPonto();
    const s = await sessao(p);
    const devolucao = (extra: Linha) =>
      inserir('movimentos_vasilhame', {
        sessao_caixa_id: s,
        loja_id: loja,
        caixa_id: p.caixa,
        terminal_id: p.terminal,
        operador_id: admin,
        produto_vasilhame_id: casco,
        quantidade: '6.000',
        ocorrido_em: new Date(),
        ...extra,
      });
    const id = await devolucao({ destino: 'entrada' });
    const casos: Array<[Linha, string]> = [
      [{ destino: 'troca' }, 'ck_movimentos_vasilhame_destino'],
      [{ destino: 'baixa_comodato' }, 'ck_movimentos_vasilhame_comodato'],
      [{ destino: 'vale' }, 'ck_movimentos_vasilhame_vale'],
      [{ destino: 'entrada', vale_id: uuidv7() }, 'ck_movimentos_vasilhame_vale'],
      [{ destino: 'entrada', quantidade: '0.000' }, 'ck_movimentos_vasilhame_quantidade'],
    ];
    for (const [extra, restricao] of casos) {
      await expect(devolucao(extra), restricao).rejects.toMatchObject({
        code: '23514',
        constraint: restricao,
      });
    }
    await expect(
      c.query("update movimentos_vasilhame set quantidade = '5.000' where id = $1", [id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    // As colunas de cancelamento ficam livres (lista própria, sem `autorizado_cancelamento_por_id`), com o CHECK.
    await expect(
      c.query('update movimentos_vasilhame set cancelado = true where id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_movimentos_vasilhame_cancelado' });
    await c.query(
      `update movimentos_vasilhame set cancelado = true, cancelado_em = now(), cancelado_por_id = $2,
         motivo_cancelamento = 'Casco contado em dobro' where id = $1`,
      [id, admin],
    );
    await expect(
      c.query("update movimentos_vasilhame set destino = 'vale' where id = $1", [id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
  });
});

describe('guarda da migração 0012 (crítica da 1C, item 18)', () => {
  // Mesmo corte em comandos que o executor de migrações usa.
  const guarda = lerMigracoes(PASTA_MIGRACOES_EMPRESA).find((m) => m.tag.endsWith('_vendas_caixa'))!
    .comandos[0]!;

  it('é o primeiro comando da migração: falha com evento venda.*, caixa.* ou vasilhame.* gravado; passa sem', async () => {
    expect(guarda).toMatch(/^-- Fase 1C[\s\S]*do \$\$[\s\S]*EVENTOS_DE_VENDA_ANTES_DAS_TABELAS/);
    await c.query('begin');
    try {
      await c.query(guarda);
      for (const tipo of ['venda.finalizada', 'caixa.aberto', 'vasilhame.movimentado']) {
        await c.query('savepoint antes');
        await c.query(
          `insert into eventos_recebidos (evento_id, terminal_id, loja_id, sequencia_terminal, tipo, versao_schema,
             agregado_tipo, agregado_id, ocorrido_em, payload_sha256)
           values ($1, $2, $3, 1, $4, 1, 'venda', $1, now(), repeat('0', 64))`,
          [uuidv7(), terminal, loja, tipo],
        );
        await expect(c.query(guarda), tipo).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringMatching(/^EVENTOS_DE_VENDA_ANTES_DAS_TABELAS: 1 evento/),
        });
        await c.query('rollback to savepoint antes');
      }
    } finally {
      await c.query('rollback');
    }
  });
});
