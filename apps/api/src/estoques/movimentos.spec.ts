import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import {
  conferirDataMovimentos,
  ErroDataRetroativa,
  ErroLimiteEstoque,
  FOLGA_RETROATIVO_MS,
  itemDerivadoDocumento,
  lancarDocumento,
  lancarMovimento,
  NAMESPACE_ITEM_DOCUMENTO,
  ordenarChaves,
  somarLinhasIguais,
  type NovoMovimento,
} from './movimentos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { uuidv5 } from '../comum/uuid-v5.js';

const E = '0190a000-0000-7000-8000-0000000000e1';
const T = '0190a000-0000-7000-8000-0000000000f1';
const VENDA = '0190a000-0000-7000-8000-000000000100';
const ITEM = '0190a000-0000-7000-8000-000000000101';
const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';

const linha = (extra: Partial<NovoMovimento>): NovoMovimento => ({
  estoqueId: E,
  produtoId: A,
  variacaoId: null,
  tipoEstoqueId: T,
  tipoMovimento: 'BAIXA_INSUMO',
  quantidade: '-1',
  custoReferencia: '1',
  precoVenda: null,
  dataMovimento: new Date('2026-10-31T12:00:00Z'),
  lojaId: null,
  usuarioId: null,
  documentoTipo: 'venda',
  documentoId: VENDA,
  documentoItemId: ITEM,
  ...extra,
});

describe('documento do PDV no razão (C6a; T4)', () => {
  it('soma o mesmo insumo do mesmo item num BAIXA_INSUMO só, em decimal, e tira a soma zero', () => {
    const r = somarLinhasIguais([
      linha({ quantidade: '-0.1' }),
      linha({ produtoId: B, quantidade: '-2' }),
      linha({ quantidade: '-0.2' }),
      linha({ tipoMovimento: 'VENDA_PDV', produtoId: B, quantidade: '-1' }),
      linha({ produtoId: B, tipoMovimento: 'VENDA_PDV', quantidade: '1' }),
    ]);
    expect(r.map((l) => [l.produtoId, l.tipoMovimento, l.quantidade])).toEqual([
      [A, 'BAIXA_INSUMO', '-0.300'],
      [B, 'BAIXA_INSUMO', '-2.000'],
    ]);
  });

  it('não soma linha sem documento_item_id nem linhas de itens, estoques ou lotes diferentes', () => {
    const r = somarLinhasIguais([
      linha({ documentoItemId: null }),
      linha({ documentoItemId: null }),
      linha({ documentoItemId: '0190a000-0000-7000-8000-000000000102' }),
      linha({ estoqueId: '0190a000-0000-7000-8000-0000000000e2' }),
      linha({ loteId: '0190a000-0000-7000-8000-0000000000c1' }),
      linha({}),
    ]);
    expect(r).toHaveLength(6);
  });

  it('compensações de movimentos tardios diferentes contra o mesmo item do acerto não se somam (T23)', () => {
    const compensa = (movimento: string) =>
      linha({
        tipoMovimento: 'ACERTO_COMPENSACAO',
        documentoTipo: 'acerto',
        quantidade: '2',
        custoUnitario: '2',
        compensaMovimentoId: movimento,
      });
    const r = somarLinhasIguais([
      compensa('0190a000-0000-7000-8000-0000000000d1'),
      compensa('0190a000-0000-7000-8000-0000000000d2'),
    ]);
    expect(r.map((l) => [l.compensaMovimentoId, l.quantidade])).toEqual([
      ['0190a000-0000-7000-8000-0000000000d1', '2.000'],
      ['0190a000-0000-7000-8000-0000000000d2', '2.000'],
    ]);
  });

  it('estornos de movimentos diferentes do mesmo item do acerto não se somam (T23, estorno do "Definir")', () => {
    const estorna = (movimento: string) =>
      linha({
        tipoMovimento: 'ESTORNO_ACERTO',
        documentoTipo: 'acerto',
        quantidade: '-2',
        estornoDeId: movimento,
      });
    const r = somarLinhasIguais([
      estorna('0190a000-0000-7000-8000-0000000000e1'),
      estorna('0190a000-0000-7000-8000-0000000000e2'),
    ]);
    expect(r.map((l) => [l.estornoDeId, l.quantidade])).toEqual([
      ['0190a000-0000-7000-8000-0000000000e1', '-2.000'],
      ['0190a000-0000-7000-8000-0000000000e2', '-2.000'],
    ]);
  });

  it('entradas somadas precisam do mesmo custo informado', () => {
    expect(() =>
      somarLinhasIguais([
        linha({ tipoMovimento: 'ESTORNO_BAIXA_INSUMO', quantidade: '1', custoUnitario: '2' }),
        linha({ tipoMovimento: 'ESTORNO_BAIXA_INSUMO', quantidade: '1', custoUnitario: '2.5' }),
      ]),
    ).toThrow(/custos diferentes/);
  });

  it('id derivado do bloco de vasilhames: UUIDv5 fixo por documento e rótulo', () => {
    const id = itemDerivadoDocumento(VENDA, 'vasilhames');
    expect(id).toBe(uuidv5(`${VENDA}:vasilhames`, NAMESPACE_ITEM_DOCUMENTO));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(itemDerivadoDocumento(VENDA, 'vasilhames')).toBe(id);
    expect(itemDerivadoDocumento(ITEM, 'vasilhames')).not.toBe(id);
  });

  it('ids em outra caixa são o mesmo uuid: somam, derivam o mesmo id e ordenam juntos', () => {
    const r = somarLinhasIguais([
      linha({ quantidade: '-0.1' }),
      linha({ produtoId: A.toUpperCase(), documentoItemId: ITEM.toUpperCase(), quantidade: '-0.2' }),
    ]);
    expect(r.map((l) => l.quantidade)).toEqual(['-0.300']);
    expect(itemDerivadoDocumento(VENDA.toUpperCase(), 'vasilhames')).toBe(
      itemDerivadoDocumento(VENDA, 'vasilhames'),
    );
    const ordem = ordenarChaves([
      linha({ produtoId: B.toUpperCase() }),
      linha({ produtoId: A }),
      linha({ produtoId: B }),
    ]).map((l) => l.produtoId.toLowerCase());
    expect(ordem).toEqual([A, B, B]);
  });

  it('desempate pelo lote na mesma linha de saldo (F2-B6): os lotes em ordem, o sem lote por último', () => {
    const L1 = '0190a000-0000-7000-8000-0000000000c1';
    const L2 = '0190a000-0000-7000-8000-0000000000c2';
    const chaves = [
      linha({ produtoId: B, loteId: L1 }),
      linha({ loteId: null }),
      linha({ loteId: L2.toUpperCase() }),
      linha({ produtoId: B }),
      linha({ loteId: L1 }),
    ];
    const ordem = (lista: readonly NovoMovimento[]) =>
      ordenarChaves(lista).map((l) => [l.produtoId, l.loteId?.toLowerCase() ?? null]);
    // A linha de saldo manda (A antes de B, qualquer que seja o lote); dentro dela, L1, L2 e o sem lote.
    expect(ordem(chaves)).toEqual([
      [A, L1],
      [A, L2],
      [A, null],
      [B, L1],
      [B, null],
    ]);
    expect(ordem([...chaves].reverse())).toEqual(ordem(chaves));
  });

  it('ordem estável das travas: mesma ordem qualquer que seja a do documento', () => {
    const ida = ordenarChaves([linha({ produtoId: B }), linha({ produtoId: A })]).map((l) => l.produtoId);
    const volta = ordenarChaves([linha({ produtoId: A }), linha({ produtoId: B })]).map((l) => l.produtoId);
    expect(ida).toEqual([A, B]);
    expect(volta).toEqual(ida);
  });
});

describe('regra de data dos documentos do ERP (F2-B4; ERP 13.1.5)', () => {
  const agora = Date.parse('2026-11-04T15:00:00Z');
  const acerto = (dataMovimento: Date, extra: Partial<NovoMovimento> = {}) =>
    linha({
      tipoMovimento: 'ACERTO_ENTRADA',
      quantidade: '1',
      documentoTipo: 'acerto',
      dataMovimento,
      ...extra,
    });
  /** Transação que falha em qualquer comando: a recusa tem de vir antes de tocar no banco. */
  const semBanco = {
    execute: () => {
      throw new Error('não devia chegar ao banco');
    },
  } as unknown as DbEmpresa;

  it('documento do ERP com data no passado e sem a flag é recusado com erro de programação', () => {
    const passado = new Date(agora - FOLGA_RETROATIVO_MS - 1);
    expect(() => conferirDataMovimentos([acerto(new Date(agora)), acerto(passado)], {}, agora)).toThrow(
      ErroDataRetroativa,
    );
    expect(() => conferirDataMovimentos([acerto(passado)], {}, agora)).toThrow(
      /ACERTO_ENTRADA.*acerto.*retroativoPermitido/,
    );
  });

  it('aceita a folga de 1 min, o futuro, a flag retroativoPermitido e o movimento do PDV (com evento_id)', () => {
    const passado = new Date(agora - 3_600_000);
    expect(() =>
      conferirDataMovimentos([acerto(new Date(agora - FOLGA_RETROATIVO_MS))], {}, agora),
    ).not.toThrow();
    expect(() => conferirDataMovimentos([acerto(new Date(agora + 60_000))], {}, agora)).not.toThrow();
    expect(() =>
      conferirDataMovimentos([acerto(passado)], { retroativoPermitido: true }, agora),
    ).not.toThrow();
    // A venda offline (hora do fato) e a compensação dela (herda o evento): o PDV lança no passado.
    expect(() =>
      conferirDataMovimentos(
        [linha({ dataMovimento: passado, eventoId: '0190a000-0000-7000-8000-0000000000aa' })],
        {},
        agora,
      ),
    ).not.toThrow();
  });

  it('a folga é medida contra o inicioDocumento: o fim de um laço longo não estoura, o retroativo de verdade sim', () => {
    // A Entrada de 5.000 itens começou há 5 min e todas as linhas têm a data do início.
    const inicio = new Date(Date.now() - 5 * 60_000);
    expect(() => conferirDataMovimentos([acerto(inicio)], { inicioDocumento: inicio })).not.toThrow();
    expect(() => conferirDataMovimentos([acerto(inicio)])).toThrow(ErroDataRetroativa);
    // A data do cabeçalho (há 2 h) continua recusada, mesmo medida contra o início.
    const cabecalho = new Date(inicio.getTime() - 2 * 3_600_000);
    expect(() => conferirDataMovimentos([acerto(cabecalho)], { inicioDocumento: inicio })).toThrow(
      ErroDataRetroativa,
    );
    expect(() =>
      conferirDataMovimentos([acerto(new Date(inicio.getTime() - FOLGA_RETROATIVO_MS - 1))], {
        inicioDocumento: inicio,
      }),
    ).toThrow(ErroDataRetroativa);
  });

  it('lancarDocumento recusa antes de travar ou gravar; lancarMovimento (saldo já travado por quem chama), antes de gravar', async () => {
    const velho = acerto(new Date(Date.now() - 2 * FOLGA_RETROATIVO_MS));
    await expect(lancarDocumento(semBanco, [velho])).rejects.toBeInstanceOf(ErroDataRetroativa);
    const saldo = {
      estoqueId: E,
      produtoId: A,
      variacaoId: null,
      tipoEstoqueId: T,
      id: A,
      quantidade: '0',
      custoMedio: '0',
    };
    await expect(lancarMovimento(semBanco, saldo, velho)).rejects.toBeInstanceOf(ErroDataRetroativa);
  });
});

const LA = '0190a000-0000-7000-8000-0000000000d1';
const LB = '0190a000-0000-7000-8000-0000000000d2';

/**
 * Banco falso para um documento de uma linha de saldo (produto A, `saldo` com `custoMedio`) com os lotes LA (vence
 * antes) e LB nas quantidades de `lotes`: responde cada comando pelo texto e registra a ordem deles.
 */
function bancoFalso({
  saldo = '14.000',
  custoMedio = '2.0000',
  lotes = ['6.000', '8.000'],
  soLote = null as 'LA' | 'LB' | null,
} = {}) {
  const log: string[] = [];
  const cliente = {
    query(q: string | { text: string }) {
      const texto = typeof q === 'string' ? q : q.text;
      log.push(texto);
      const linhas = (rows: unknown[]) => Promise.resolve({ rows, rowCount: rows.length, fields: [] });
      if (/from saldos_estoque s[\s\S]*for update/.test(texto))
        return linhas([{ ordem: 0, id: 'saldo-a', quantidade: saldo, custo_medio: custoMedio }]);
      if (texto.includes('from produtos_lotes where id = any'))
        return linhas([LA, LB].map((id) => ({ id, produto_id: A, variacao_id: null, estoque_id: null })));
      if (texto.includes('join saldos_lote l'))
        return linhas([
          { ordem: 0, lote_id: LA, quantidade: lotes[0], validade: '2026-12-01' },
          { ordem: 0, lote_id: LB, quantidade: lotes[1], validade: '2027-01-10' },
        ]);
      if (/from saldos_lote s[\s\S]*for update/.test(texto)) {
        const a = { id: 'lote-a', quantidade: lotes[0] };
        const b = { id: 'lote-b', quantidade: lotes[1] };
        // O documento que só mexe num lote trava só a linha dele.
        if (soLote) return linhas([{ ordem: 0, ...(soLote === 'LA' ? a : b) }]);
        return linhas([
          { ordem: 0, ...a },
          { ordem: 1, ...b },
        ]);
      }
      return linhas([]);
    },
  };
  return { tx: drizzle(cliente as never) as unknown as DbEmpresa, log };
}

/** Algum comando gravou movimento ou saldo (a recusa do limite vem antes de qualquer gravação). */
const gravou = (log: readonly string[]) =>
  log.some(
    (t) =>
      t.includes('insert into movimentos_estoque') ||
      t.includes('update saldos_estoque') ||
      t.includes('update saldos_lote'),
  );

describe('limites do motor de estoque (README da API › decisão 210)', () => {
  /** Linha do PDV (com o evento: sem a regra de data do ERP). */
  const doPdv = (extra: Partial<NovoMovimento>) =>
    linha({ tipoMovimento: 'VENDA_PDV', eventoId: '0190a000-0000-7000-8000-0000000000e9', ...extra });
  const recusa = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (erro: unknown) => erro,
    );
    expect(e).toBeInstanceOf(ErroLimiteEstoque);
    return e as ErroLimiteEstoque;
  };

  it('custo total acima de numeric(15,2) → ErroLimiteEstoque com a mensagem do custo, nada gravado', async () => {
    const { tx, log } = bancoFalso({ saldo: '0.000', custoMedio: '0.0000', lotes: ['0.000', '0.000'] });
    // 999.999.999 × R$ 99.999 ≈ 1e14 > 9.999.999.999.999,99 (o saldo cabe: a recusa é só do custo).
    const e = await recusa(
      lancarDocumento(tx, [
        doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '999999999', custoUnitario: '99999' }),
      ]),
    );
    expect(e.message).toMatch(/custo do lançamento passa do limite do sistema/);
    expect(e.extras.detalhes).toMatchObject({ estoqueId: E, produtoId: A, tipoEstoqueId: T });
    expect(gravou(log)).toBe(false);
    // Logo abaixo do limite (99.999.999 × R$ 99.999 ≈ 1e13 − 1e8), passa.
    const ok = bancoFalso({ saldo: '0.000', custoMedio: '0.0000', lotes: ['0.000', '0.000'] });
    const r = await lancarDocumento(ok.tx, [
      doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '99999999', custoUnitario: '99999' }),
    ]);
    expect(r.movimentos[0]!.custoTotal).toBe('9999899900001.00');
    // A saída com custo médio alto também: 1.000 × R$ 99.999.999.999 = 1e14.
    const saida = bancoFalso({ saldo: '0.000', custoMedio: '99999999999.0000', lotes: ['0.000', '0.000'] });
    const s = await recusa(lancarDocumento(saida.tx, [doPdv({ quantidade: '-1000' })]));
    expect(s.message).toMatch(/custo do lançamento/);
    expect(gravou(saida.log)).toBe(false);
  });

  it('o saldo do lote passa do limite com a linha longe dele → ErroLimiteEstoque com o loteId, nada gravado', async () => {
    // A linha perto de zero: o lote LA muito positivo e a sobra sem lote muito negativa.
    const { tx, log } = bancoFalso({ saldo: '0.000', lotes: ['99999999990.000', '0.000'], soLote: 'LA' });
    const e = await recusa(
      lancarDocumento(tx, [doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '20', loteId: LA })]),
    );
    expect(e.message).toMatch(/saldo de um lote fora do limite/);
    expect(e.extras.detalhes).toMatchObject({ produtoId: A, loteId: LA });
    expect(gravou(log)).toBe(false);
    // A mesma entrada no outro lote (longe do limite) passa.
    const ok = bancoFalso({ saldo: '0.000', lotes: ['99999999990.000', '0.000'], soLote: 'LB' });
    const r = await lancarDocumento(ok.tx, [
      doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '20', loteId: LB }),
    ]);
    expect(r.movimentos).toHaveLength(1);
  });

  it('linha já acima do limite (dado antigo): o que aproxima de zero passa, mesmo ainda acima; o que afasta é recusado', async () => {
    const acima = { saldo: '-500000000000.000', custoMedio: '0.0100', lotes: ['0.000', '0.000'] };
    // Entrada que reduz o módulo e ainda fica acima do limite (−400.000.000.000): passa.
    const entrada = bancoFalso(acima);
    const r = await lancarDocumento(entrada.tx, [
      doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '100000000000' }),
    ]);
    expect(r.movimentos[0]!.saldoPosterior).toBe('-400000000000.000');
    expect(r.negativos).toHaveLength(1);
    // Saída que aumenta o módulo: recusada, nada gravado.
    const saida = bancoFalso(acima);
    const e = await recusa(lancarDocumento(saida.tx, [doPdv({ quantidade: '-1' })]));
    expect(e.message).toMatch(/saldo de um produto fora do limite/);
    expect(gravou(saida.log)).toBe(false);
    // O mesmo vale para o lote acima do limite: a saída dele que aproxima de zero passa, a entrada que afasta não.
    const doLote = bancoFalso({
      saldo: '500000000000.000',
      lotes: ['500000000000.000', '0.000'],
      soLote: 'LA',
    });
    const rl = await lancarDocumento(doLote.tx, [doPdv({ quantidade: '-100000000000', loteId: LA })]);
    expect(rl.movimentos[0]!.saldoPosterior).toBe('400000000000.000');
    // (a linha perto de zero, com a sobra sem lote negativa: só o lote se afasta)
    const afasta = bancoFalso({ saldo: '0.000', lotes: ['500000000000.000', '0.000'], soLote: 'LA' });
    const el = await recusa(
      lancarDocumento(afasta.tx, [doPdv({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '1', loteId: LA })]),
    );
    expect(el.message).toMatch(/saldo de um lote fora do limite/);
    expect(el.extras.detalhes).toMatchObject({ loteId: LA });
    expect(gravou(afasta.log)).toBe(false);
  });
});

describe('lote no documento (F2-B6; README da API › decisão 151)', () => {
  /** Linha da venda do PDV (com o evento: a hora do fato vale, sem a regra de data do ERP). */
  const venda = (extra: Partial<NovoMovimento>) =>
    linha({ tipoMovimento: 'VENDA_PDV', eventoId: '0190a000-0000-7000-8000-0000000000e9', ...extra });
  /**
   * Banco falso para um documento de uma linha de saldo (produto A) com os lotes LA (vence antes, 6) e LB (8):
   * responde cada comando pelo texto e registra a ordem deles.
   */
  const bancoComLotes = () => bancoFalso();

  it('a saída sem lote antes da linha com o lote informado não consome esse lote (o lote informado é reservado antes)', async () => {
    const { tx } = bancoComLotes();
    const X = '0190a000-0000-7000-8000-000000000201';
    const Y = '0190a000-0000-7000-8000-000000000202';
    const r = await lancarDocumento(tx, [
      venda({ documentoItemId: X, quantidade: '-8' }),
      venda({ documentoItemId: Y, quantidade: '-6', loteId: LA }),
    ]);
    // Seguindo a ordem do documento, X tirava 6 de LA e 2 de LB, e Y deixava LA em −6 com LB ainda com 6.
    expect(r.movimentos.map((m) => [m.linha.documentoItemId, m.linha.loteId, m.linha.quantidade])).toEqual([
      [X, LB, '-8.000'],
      [Y, LA, '-6.000'],
    ]);
  });

  it('trava todas as linhas de saldos_estoque antes da primeira de saldos_lote', async () => {
    const { tx, log } = bancoComLotes();
    await lancarDocumento(tx, [
      venda({ quantidade: '-10' }),
      venda({ documentoItemId: VENDA, quantidade: '-1', loteId: LB }),
    ]);
    const travas = log
      .map(
        (t, i) =>
          [
            i,
            /from saldos_estoque s[\s\S]*for update/.test(t)
              ? 'estoque'
              : /from saldos_lote s[\s\S]*for update/.test(t)
                ? 'lote'
                : null,
          ] as const,
      )
      .filter(([, k]) => k);
    expect(travas.map(([, k]) => k)).toEqual(['estoque', 'lote']);
    // Nenhum comando grava saldos_lote antes da trava da linha de saldos_estoque.
    const primeiraTrava = travas[0]![0];
    expect(log.slice(0, primeiraTrava).some((t) => t.includes('saldos_lote'))).toBe(false);
  });
});
