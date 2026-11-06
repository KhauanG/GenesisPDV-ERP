/**
 * Recálculo da projeção `saldos_estoque` pelo razão (Fase 2, F2-B3; MD 3.7; ERP 13.1.1; README da API › decisão 147):
 * o núcleo do `db:recalcular-saldos` e da verificação periódica opcional. Refaz cada linha de saldo (estoque × produto
 * × variação × tipo) a partir de `movimentos_estoque`, na ordem de lançamento (`seq_lancamento`, decisão 146), com a
 * mesma conta do motor online (`aplicarMovimentoNoSaldo`), e compara com o que está gravado: `quantidade`,
 * `custo_medio`, `ultima_entrada_em`, `ultima_saida_em` e `ultimo_movimento_id`. Também confere a cadeia gravada
 * (`saldo_anterior` = `saldo_posterior` do anterior, a regra do `verificarCadeia`), os movimentos que o replay não
 * repete, as linhas sem razão com saldo (órfãs), o razão sem linha de saldo e a projeção `produtos.custo_medio`
 * (migração 0006).
 *
 * **Memória constante.** A verificação é uma transação `repeatable read read only` (movimentos e saldos no mesmo
 * instante: uma venda no meio não vira divergência falsa) com dois cursores ordenados pela chave da linha — o do razão
 * segue a ordem do `ix_movimentos_estoque_linha_seq`, que o cursor favorece, em páginas de 10 mil —, juntados em
 * ordem aqui: cada linha é refeita movimento a movimento e esquecida; só as divergências ficam.
 *
 * **Correção segura com o PDV sincronizando** (`corrigirDivergencias`). Nunca altera movimento: só a projeção. Em
 * blocos de até 500 linhas por transação, com a trava 7300001 primeiro (`fn_trava_versao`, MD 1.5) e o `select … for
 * update` das linhas na ordem de `ordenarChaves` (a do motor). Sob a trava, o replay continua a partir do estado da
 * verificação com os movimentos lançados depois dela (`seq_lancamento` maior; na linha travada a ordem de lançamento é
 * a de commit, decisão 146): uma venda que entrou no meio não se perde, e a trava fica presa só pelo que mudou. Grava
 * só as linhas que ainda divergem, com a auditoria `recalcular_saldos` (antes e depois); a `versao` das linhas sobe,
 * então o saldo certo desce ao PDV pelo fluxo `estoque`. A projeção do produto se corrige sozinha pelo trigger da 0006
 * quando o saldo muda; a divergente com o saldo certo é refeita por `fn_projetar_custo_medio_produto`.
 *
 * Lote e última compra (F2-B6; README da API › decisão 151): o mesmo replay refaz, por linha, o saldo de cada lote
 * (a soma dos movimentos com aquele `lote_id`, comparada com `saldos_lote`) e a última compra (a da última entrada de
 * compra lançada, `movimentoDeCompra`, comparada com `ultima_compra_em` e `ultimo_custo_compra`). As linhas de
 * `saldos_lote` vêm agregadas na própria linha de `saldos_estoque` (o cursor continua um só), e as sem linha de saldo
 * (que o motor nunca deixa) numa consulta à parte. O `--corrigir` trava as de `saldos_lote` depois das de
 * `saldos_estoque`, como o motor, e regrava o lote divergente (criando a linha que falta).
 */
import {
  ALERTA_RAZAO_CADEIA_QUEBRADA,
  ALERTA_RAZAO_SALDO_DIVERGENTE,
  aplicarMovimentoNoSaldo,
  dec,
  decTexto,
  movimentoDeCompra,
  movimentoGravadoNoSaldo,
  TIPOS_MOVIMENTO_COMPRA,
  type AcaoAuditoria,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import type { ConexaoSql } from './cadeia.js';
import { LINHAS_POR_COMANDO, ordenarChaves, type ChaveSaldo } from './movimentos.js';

/** Movimentos por página do cursor do razão (o plano: páginas de 10 mil, memória constante). */
export const MOVIMENTOS_POR_PAGINA = 10_000;
/** Linhas de saldo por transação do `--corrigir` (cada uma segura a 7300001 só pelo bloco). */
export const LINHAS_POR_CORRECAO = 500;
export const ACAO_RECALCULAR_SALDOS: AcaoAuditoria = 'recalcular_saldos';
/** Chave de deduplicação do `RAZAO_SALDO_DIVERGENTE` (um aberto por empresa, MD 3.1.8). */
export const CHAVE_ALERTA_SALDO_DIVERGENTE = 'razao_saldos';

/**
 * Conexão própria (fora de transação): o cliente de um comando (role dona) ou o `ClienteEmpresa` do tenancy. O módulo
 * não abre conexão (o mínimo do `pg` que usa é o de `cadeia.ts`).
 */
export type ConexaoRecalculo = ConexaoSql;

export interface FiltroRecalculo {
  estoqueId?: string | null;
  produtoId?: string | null;
}

/** Instante de `timestamptz`: o texto do banco (em UTC, exato) e os microssegundos desde a época, para comparar. */
export interface Instante {
  texto: string;
  us: bigint;
}

/** A projeção de uma linha de saldo, gravada ou refeita pelo razão (texto do `numeric`). */
export interface ProjecaoSaldo {
  quantidade: string;
  custoMedio: string;
  ultimaEntradaEm: Instante | null;
  ultimaSaidaEm: Instante | null;
  ultimoMovimentoId: string | null;
  /** Última compra (F2-B6): data e custo unitário da última entrada de compra lançada. */
  ultimaCompraEm: Instante | null;
  ultimoCustoCompra: string | null;
  /** Saldo por lote (F2-B6): `lote_id` (minúsculas) → quantidade; o lote ausente vale zero. */
  lotes: ReadonlyMap<string, string>;
}

/** Onde o replay parou numa linha: a projeção refeita mais o último movimento lido, para continuar sob a trava. */
export interface EstadoReplay extends ProjecaoSaldo {
  /** `seq_lancamento` do último movimento lido (texto do `bigint`); nulo sem movimento. */
  ultimaSeq: string | null;
  movimentos: number;
}

export type CampoSaldo =
  | 'quantidade'
  | 'custo_medio'
  | 'ultima_entrada_em'
  | 'ultima_saida_em'
  | 'ultimo_movimento_id'
  | 'ultima_compra_em'
  | 'ultimo_custo_compra'
  | 'saldo_lote';

export interface CampoDivergente {
  campo: CampoSaldo;
  /** Só em `saldo_lote`: o lote da linha de `saldos_lote` divergente. */
  loteId?: string;
  gravado: string | null;
  recalculado: string | null;
  /** Recalculado − gravado, nos campos numéricos; nulo nos demais. */
  diferenca: string | null;
}

/** Um movimento na ordem de lançamento (posição a partir de 1 na linha). */
export interface MovimentoNaLinha {
  posicao: number;
  movimentoId: string;
  seqLancamento: string | null;
}

/**
 * O que o razão da linha tem de inconsistente em si, sem tocar na projeção: a cadeia gravada quebrada (o movimento foi
 * lançado sobre um saldo que não era o do fim do razão) e os movimentos cujo saldo ou custo gravado o replay não
 * repete. É histórico: o movimento é imutável e o comando nunca o altera; serve para achar quando a projeção desviou.
 */
export interface InconsistenciaRazao {
  quebras: number;
  primeiraQuebra: (MovimentoNaLinha & { saldoEsperado: string; saldoAnterior: string }) | null;
  movimentosDivergentes: number;
  primeiroMovimentoDivergente: MovimentoNaLinha | null;
}

export interface DivergenciaSaldo extends ChaveSaldo {
  /**
   * `divergente`: a linha gravada difere do replay. `orfa`: linha de saldo sem nenhum movimento, com saldo ou custo.
   * `sem_linha`: há razão e não há linha de saldo.
   */
  situacao: 'divergente' | 'orfa' | 'sem_linha';
  saldoId: string | null;
  campos: CampoDivergente[];
  gravado: ProjecaoSaldo | null;
  recalculado: EstadoReplay;
  razao: InconsistenciaRazao | null;
}

export interface DivergenciaCustoProduto {
  produtoId: string;
  gravado: string;
  /** A média ponderada dos saldos positivos (a conta de `fn_projetar_custo_medio_produto`). */
  recalculado: string;
  diferenca: string;
}

export interface RelatorioRecalculo {
  /** Linhas de saldo conferidas (com movimento, com linha gravada ou as duas). */
  linhas: number;
  movimentos: number;
  divergencias: DivergenciaSaldo[];
  /** Linhas com a projeção certa, mas com o razão inconsistente em si (histórico, só informativo). */
  razaoInconsistente: Array<ChaveSaldo & InconsistenciaRazao & { movimentos: number }>;
  /** Com `--estoque`, só os produtos que têm linha nele (a média continua sendo a de todos os estoques). */
  custoProdutos: DivergenciaCustoProduto[];
}

/** A projeção é idêntica ao razão: nenhuma linha de saldo nem `produtos.custo_medio` divergente. */
export const projecaoIdentica = (r: Pick<RelatorioRecalculo, 'divergencias' | 'custoProdutos'>) =>
  r.divergencias.length === 0 && r.custoProdutos.length === 0;

// ---------------------------------------------------------------- Leitura

/** Uma linha de `movimentos_estoque` como o replay a lê. */
export interface MovimentoLido {
  estoque_id: string;
  produto_id: string;
  variacao_id: string | null;
  tipo_estoque_id: string;
  id: string;
  seq_lancamento: string | null;
  quantidade: string;
  saldo_anterior: string;
  saldo_posterior: string;
  custo_unitario: string;
  custo_total: string;
  custo_medio_posterior: string;
  estorno_de_id: string | null;
  data_movimento: string;
  data_us: string;
  tipo_movimento: string;
  lote_id: string | null;
}

/** Uma linha de `saldos_estoque` como a conferência a lê. */
export interface SaldoLido {
  id: string;
  estoque_id: string;
  produto_id: string;
  variacao_id: string | null;
  tipo_estoque_id: string;
  quantidade: string;
  custo_medio: string;
  ultima_entrada_em: string | null;
  ultima_entrada_us: string | null;
  ultima_saida_em: string | null;
  ultima_saida_us: string | null;
  ultimo_movimento_id: string | null;
  ultima_compra_em: string | null;
  ultima_compra_us: string | null;
  ultimo_custo_compra: string | null;
  /** As linhas de `saldos_lote` da linha, `[lote_id, quantidade]` (o `json_agg` do cursor); nulo sem nenhuma. */
  lotes: Array<[string, string]> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O id do filtro em minúsculas (o `uuid` do banco sai assim), conferido antes de entrar no texto do cursor. */
function idDoFiltro(v: string | null | undefined, nome: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (!UUID.test(v)) throw new Error(`${nome} não é um UUID: ${v}`);
  return v.toLowerCase();
}

/**
 * `where` dos dois cursores. Os ids entram como literais (conferidos por `idDoFiltro`): o `declare … cursor` é uma
 * instrução utilitária, e o parâmetro do protocolo nem sempre chega ao plano dele.
 */
function condicoes(filtro: FiltroRecalculo, prefixo: string): string {
  const estoque = idDoFiltro(filtro.estoqueId, 'estoque');
  const produto = idDoFiltro(filtro.produtoId, 'produto');
  const c: string[] = [];
  if (estoque) c.push(`${prefixo}estoque_id = '${estoque}'::uuid`);
  if (produto) c.push(`${prefixo}produto_id = '${produto}'::uuid`);
  return c.length ? `where ${c.join(' and ')}` : '';
}

/** Microssegundos desde a época de uma coluna `timestamptz` (exatos: o `extract` devolve `numeric`). */
const instante = (coluna: string) => `(extract(epoch from ${coluna}) * 1000000)::bigint::text`;

/*
 * O `order by` qualificado (`m.`): sem o prefixo, `seq_lancamento` seria a coluna de saída `seq_lancamento::text`, e a
 * ordem de lançamento viraria a do texto ("10" antes de "2").
 */
const SQL_MOVIMENTOS = (filtro: FiltroRecalculo) => `
  select estoque_id, produto_id, variacao_id, tipo_estoque_id, id, seq_lancamento::text, quantidade::text,
         saldo_anterior::text, saldo_posterior::text, custo_unitario::text, custo_total::text,
         custo_medio_posterior::text, estorno_de_id, data_movimento::text, ${instante('data_movimento')} as data_us,
         tipo_movimento, lote_id
    from movimentos_estoque m ${condicoes(filtro, 'm.')}
   order by m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.seq_lancamento, m.id`;

/*
 * As linhas de `saldos_lote` vêm na linha de `saldos_estoque` (o `uq_saldos_lote_chave` começa pela chave dela): o
 * cursor continua um só, e a memória, a de uma página. No `--corrigir` elas são travadas à parte (`for update`).
 */
const COLUNAS_SALDO = (
  s: string,
  comLotes = true,
) => `${s}id, ${s}estoque_id, ${s}produto_id, ${s}variacao_id, ${s}tipo_estoque_id,
  ${s}quantidade::text, ${s}custo_medio::text, ${s}ultima_entrada_em::text,
  ${instante(`${s}ultima_entrada_em`)} as ultima_entrada_us, ${s}ultima_saida_em::text,
  ${instante(`${s}ultima_saida_em`)} as ultima_saida_us, ${s}ultimo_movimento_id,
  ${s}ultima_compra_em::text, ${instante(`${s}ultima_compra_em`)} as ultima_compra_us,
  ${s}ultimo_custo_compra::text${
    comLotes
      ? `,
  (select json_agg(json_build_array(l.lote_id, l.quantidade::text) order by l.lote_id)
     from saldos_lote l
    where l.estoque_id = ${s}estoque_id and l.produto_id = ${s}produto_id
      and l.variacao_id is not distinct from ${s}variacao_id and l.tipo_estoque_id = ${s}tipo_estoque_id) as lotes`
      : ', null::json as lotes'
  }`;

const SQL_SALDOS = (filtro: FiltroRecalculo) => `
  select ${COLUNAS_SALDO('s.')} from saldos_estoque s ${condicoes(filtro, 's.')}
   order by s.estoque_id, s.produto_id, s.variacao_id, s.tipo_estoque_id`;

/** Páginas de um cursor do servidor (`declare` + `fetch`), dentro da transação aberta por quem chama. */
async function* paginasCursor<T>(
  cliente: ConexaoRecalculo,
  nome: string,
  consulta: string,
  tamanho: number,
): AsyncGenerator<T[]> {
  await cliente.query(`declare ${nome} no scroll cursor for ${consulta}`);
  try {
    for (;;) {
      const { rows } = await cliente.query<T & object>(`fetch ${tamanho} from ${nome}`);
      if (rows.length) yield rows;
      if (rows.length < tamanho) return;
    }
  } finally {
    await cliente.query(`close ${nome}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Replay e comparação (puros)

/*
 * Ordem da chave igual à do `order by` dos cursores: `uuid` compara pelos bytes, que é a ordem do texto em minúsculas;
 * `variacao_id` nula fica por último (ASC NULLS LAST, padrão do PostgreSQL e do índice).
 */
const comparaId = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
const comparaNulo = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : comparaId(a, b);

export function compararChave(a: ChaveSaldo, b: ChaveSaldo): number {
  return (
    comparaId(a.estoqueId, b.estoqueId) ||
    comparaId(a.produtoId, b.produtoId) ||
    comparaNulo(a.variacaoId, b.variacaoId) ||
    comparaId(a.tipoEstoqueId, b.tipoEstoqueId)
  );
}

const chaveDe = (r: {
  estoque_id: string;
  produto_id: string;
  variacao_id: string | null;
  tipo_estoque_id: string;
}): ChaveSaldo => ({
  estoqueId: r.estoque_id,
  produtoId: r.produto_id,
  variacaoId: r.variacao_id,
  tipoEstoqueId: r.tipo_estoque_id,
});

const instanteLido = (texto: string | null, us: string | null): Instante | null =>
  texto === null || us === null ? null : { texto, us: BigInt(us) };

export function projecaoGravada(s: SaldoLido): ProjecaoSaldo {
  return {
    quantidade: s.quantidade,
    custoMedio: s.custo_medio,
    ultimaEntradaEm: instanteLido(s.ultima_entrada_em, s.ultima_entrada_us),
    ultimaSaidaEm: instanteLido(s.ultima_saida_em, s.ultima_saida_us),
    ultimoMovimentoId: s.ultimo_movimento_id,
    ultimaCompraEm: instanteLido(s.ultima_compra_em, s.ultima_compra_us),
    ultimoCustoCompra: s.ultimo_custo_compra,
    lotes: new Map((s.lotes ?? []).map(([id, q]) => [id.toLowerCase(), q])),
  };
}

/** A linha que o motor cria antes do primeiro movimento (`travarSaldo`): o ponto de partida do replay. */
export const estadoInicial = (): EstadoReplay => ({
  quantidade: '0.000',
  custoMedio: '0.0000',
  ultimaEntradaEm: null,
  ultimaSaidaEm: null,
  ultimoMovimentoId: null,
  ultimaCompraEm: null,
  ultimoCustoCompra: null,
  lotes: new Map(),
  ultimaSeq: null,
  movimentos: 0,
});

const TIPOS_COMPRA: ReadonlySet<string> = new Set(TIPOS_MOVIMENTO_COMPRA);

const maisRecente = (a: Instante | null, b: Instante): Instante => (a === null || b.us > a.us ? b : a);

/**
 * O replay de uma linha de saldo, movimento a movimento, na ordem de lançamento: a conta é a do motor online
 * (`aplicarMovimentoNoSaldo` sobre `movimentoGravadoNoSaldo`); as datas de última entrada e saída são as maiores
 * `data_movimento` pelo sinal (o `greatest` do motor) e o último movimento é o último lançado. Ao mesmo tempo confere a
 * cadeia gravada e se cada movimento gravado é o que o replay calcula. Desde o F2-B6 também o saldo de cada lote (a
 * soma dos movimentos com o lote) e a última compra (a última entrada de compra lançada, regra de `atualizarSaldos`).
 */
export class ReplayLinha {
  private quantidade: string;
  private custoMedio: string;
  private entrada: Instante | null;
  private saida: Instante | null;
  private compraEm: Instante | null;
  private custoCompra: string | null;
  private readonly lotes: Map<string, string>;
  private ultimoId: string | null;
  private ultimaSeq: string | null;
  private movimentos: number;
  private anteriorGravado: string;
  readonly razao: InconsistenciaRazao = {
    quebras: 0,
    primeiraQuebra: null,
    movimentosDivergentes: 0,
    primeiroMovimentoDivergente: null,
  };

  constructor(inicio: EstadoReplay = estadoInicial()) {
    this.quantidade = inicio.quantidade;
    this.custoMedio = inicio.custoMedio;
    this.entrada = inicio.ultimaEntradaEm;
    this.saida = inicio.ultimaSaidaEm;
    this.compraEm = inicio.ultimaCompraEm;
    this.custoCompra = inicio.ultimoCustoCompra;
    this.lotes = new Map(inicio.lotes);
    this.ultimoId = inicio.ultimoMovimentoId;
    this.ultimaSeq = inicio.ultimaSeq;
    this.movimentos = inicio.movimentos;
    this.anteriorGravado = inicio.quantidade;
  }

  aplicar(m: MovimentoLido): void {
    const r = aplicarMovimentoNoSaldo(
      this.quantidade,
      this.custoMedio,
      movimentoGravadoNoSaldo({
        quantidade: m.quantidade,
        custoUnitario: m.custo_unitario,
        estornoDeId: m.estorno_de_id,
        tipoMovimento: m.tipo_movimento,
      }),
    );
    this.movimentos++;
    const aqui: MovimentoNaLinha = {
      posicao: this.movimentos,
      movimentoId: m.id,
      seqLancamento: m.seq_lancamento,
    };
    if (!dec(m.saldo_anterior).eq(dec(this.anteriorGravado))) {
      this.razao.quebras++;
      this.razao.primeiraQuebra ??= {
        ...aqui,
        saldoEsperado: decTexto(this.anteriorGravado, 3),
        saldoAnterior: decTexto(m.saldo_anterior, 3),
      };
    }
    const repete =
      dec(r.saldoAnterior).eq(dec(m.saldo_anterior)) &&
      dec(r.saldoPosterior).eq(dec(m.saldo_posterior)) &&
      dec(r.custoUnitario).eq(dec(m.custo_unitario)) &&
      dec(r.custoTotal).eq(dec(m.custo_total)) &&
      dec(r.custoMedioPosterior).eq(dec(m.custo_medio_posterior));
    if (!repete) {
      this.razao.movimentosDivergentes++;
      this.razao.primeiroMovimentoDivergente ??= aqui;
    }
    this.anteriorGravado = m.saldo_posterior;
    this.quantidade = r.saldoPosterior;
    this.custoMedio = r.custoMedioPosterior;
    const quando: Instante = { texto: m.data_movimento, us: BigInt(m.data_us) };
    if (dec(r.quantidade).gt(0)) this.entrada = maisRecente(this.entrada, quando);
    else this.saida = maisRecente(this.saida, quando);
    // O tipo antes: o replay passa por milhões de movimentos, e a maioria não é compra (nem aloca o objeto).
    if (
      TIPOS_COMPRA.has(m.tipo_movimento) &&
      movimentoDeCompra({
        tipoMovimento: m.tipo_movimento,
        quantidade: r.quantidade,
        estornoDeId: m.estorno_de_id,
      })
    ) {
      this.compraEm = quando;
      this.custoCompra = r.custoUnitario;
    }
    if (m.lote_id) {
      const lote = m.lote_id.toLowerCase();
      this.lotes.set(lote, decTexto(dec(this.lotes.get(lote) ?? '0').plus(r.quantidade), 3));
    }
    this.ultimoId = m.id;
    this.ultimaSeq = m.seq_lancamento;
  }

  estado(): EstadoReplay {
    return {
      quantidade: this.quantidade,
      custoMedio: this.custoMedio,
      ultimaEntradaEm: this.entrada,
      ultimaSaidaEm: this.saida,
      ultimoMovimentoId: this.ultimoId,
      ultimaCompraEm: this.compraEm,
      ultimoCustoCompra: this.custoCompra,
      lotes: new Map(this.lotes),
      ultimaSeq: this.ultimaSeq,
      movimentos: this.movimentos,
    };
  }

  /** O razão da linha tem quebra ou movimento que o replay não repete. */
  inconsistente(): boolean {
    return this.razao.quebras > 0 || this.razao.movimentosDivergentes > 0;
  }
}

const textoInstante = (i: Instante | null) => i?.texto ?? null;

/** Os campos em que a projeção gravada difere da refeita (a ausente vale a linha zerada do `travarSaldo`). */
export function compararProjecao(gravado: ProjecaoSaldo | null, refeito: ProjecaoSaldo): CampoDivergente[] {
  const g = gravado ?? estadoInicial();
  const campos: CampoDivergente[] = [];
  if (!dec(g.quantidade).eq(dec(refeito.quantidade))) {
    campos.push({
      campo: 'quantidade',
      gravado: decTexto(g.quantidade, 3),
      recalculado: decTexto(refeito.quantidade, 3),
      diferenca: decTexto(dec(refeito.quantidade).minus(dec(g.quantidade)), 3),
    });
  }
  if (!dec(g.custoMedio).eq(dec(refeito.custoMedio))) {
    campos.push({
      campo: 'custo_medio',
      gravado: decTexto(g.custoMedio, 4),
      recalculado: decTexto(refeito.custoMedio, 4),
      diferenca: decTexto(dec(refeito.custoMedio).minus(dec(g.custoMedio)), 4),
    });
  }
  for (const [campo, a, b] of [
    ['ultima_entrada_em', g.ultimaEntradaEm, refeito.ultimaEntradaEm],
    ['ultima_saida_em', g.ultimaSaidaEm, refeito.ultimaSaidaEm],
  ] as const) {
    if (a?.us !== b?.us) {
      campos.push({ campo, gravado: textoInstante(a), recalculado: textoInstante(b), diferenca: null });
    }
  }
  const idG = g.ultimoMovimentoId?.toLowerCase() ?? null;
  const idR = refeito.ultimoMovimentoId?.toLowerCase() ?? null;
  if (idG !== idR) {
    campos.push({ campo: 'ultimo_movimento_id', gravado: idG, recalculado: idR, diferenca: null });
  }
  if (g.ultimaCompraEm?.us !== refeito.ultimaCompraEm?.us) {
    campos.push({
      campo: 'ultima_compra_em',
      gravado: textoInstante(g.ultimaCompraEm),
      recalculado: textoInstante(refeito.ultimaCompraEm),
      diferenca: null,
    });
  }
  const custoG = g.ultimoCustoCompra === null ? null : decTexto(g.ultimoCustoCompra, 4);
  const custoR = refeito.ultimoCustoCompra === null ? null : decTexto(refeito.ultimoCustoCompra, 4);
  if (custoG !== custoR) {
    campos.push({ campo: 'ultimo_custo_compra', gravado: custoG, recalculado: custoR, diferenca: null });
  }
  campos.push(...lotesDivergentes(g.lotes, refeito.lotes));
  return campos;
}

/** Os lotes cujo saldo gravado difere do refeito (o ausente de um lado vale zero), na ordem do id do lote. */
function lotesDivergentes(
  gravado: ReadonlyMap<string, string>,
  refeito: ReadonlyMap<string, string>,
): CampoDivergente[] {
  const ids = [...new Set([...gravado.keys(), ...refeito.keys()])].sort();
  const campos: CampoDivergente[] = [];
  for (const loteId of ids) {
    const a = dec(gravado.get(loteId) ?? '0');
    const b = dec(refeito.get(loteId) ?? '0');
    if (a.eq(b)) continue;
    campos.push({
      campo: 'saldo_lote',
      loteId,
      gravado: decTexto(a, 3),
      recalculado: decTexto(b, 3),
      diferenca: decTexto(b.minus(a), 3),
    });
  }
  return campos;
}

/** Lê uma sequência de páginas um item por vez, sem trazer mais de uma página para a memória. */
class Leitor<T> {
  private pagina: readonly T[] = [];
  private i = 0;
  private fim = false;

  constructor(
    private readonly paginas: AsyncIterator<readonly T[]>,
    private readonly aoPaginar?: () => void,
  ) {}

  async atual(): Promise<T | undefined> {
    while (!this.fim && this.i >= this.pagina.length) {
      const r = await this.paginas.next();
      if (r.done) {
        this.fim = true;
        break;
      }
      this.pagina = r.value;
      this.i = 0;
      this.aoPaginar?.();
    }
    return this.fim ? undefined : this.pagina[this.i];
  }

  avancar(): void {
    this.i++;
  }
}

/**
 * A conferência pura: junta o razão e as linhas de saldo, os dois em ordem de chave (o razão também por
 * `seq_lancamento`), refaz cada linha e compara. Recebe páginas de qualquer tamanho; o resultado não depende delas.
 */
export async function conferirProjecao(
  movimentos: AsyncIterable<readonly MovimentoLido[]>,
  saldos: AsyncIterable<readonly SaldoLido[]>,
  opcoes: { aoPaginar?: () => void } = {},
): Promise<Omit<RelatorioRecalculo, 'custoProdutos'>> {
  const mov = new Leitor(movimentos[Symbol.asyncIterator](), opcoes.aoPaginar);
  const sal = new Leitor(saldos[Symbol.asyncIterator](), opcoes.aoPaginar);
  const r: Omit<RelatorioRecalculo, 'custoProdutos'> = {
    linhas: 0,
    movimentos: 0,
    divergencias: [],
    razaoInconsistente: [],
  };
  for (;;) {
    const m = await mov.atual();
    const s = await sal.atual();
    if (!m && !s) return r;
    const cm = m ? chaveDe(m) : null;
    const cs = s ? chaveDe(s) : null;
    const ordem = cm && cs ? compararChave(cm, cs) : cm ? -1 : 1;
    const chave = ordem <= 0 ? cm! : cs!;
    const replay = new ReplayLinha();
    if (ordem <= 0) {
      for (let atual = m; atual && compararChave(chaveDe(atual), chave) === 0; atual = await mov.atual()) {
        replay.aplicar(atual);
        mov.avancar();
      }
    }
    const gravado = ordem >= 0 ? s! : null;
    if (gravado) sal.avancar();
    r.linhas++;
    const estado = replay.estado();
    r.movimentos += estado.movimentos;
    const projecao = gravado ? projecaoGravada(gravado) : null;
    const campos = compararProjecao(projecao, estado);
    const razao = replay.inconsistente() ? replay.razao : null;
    if (campos.length) {
      r.divergencias.push({
        ...chave,
        situacao: !gravado ? 'sem_linha' : estado.movimentos === 0 ? 'orfa' : 'divergente',
        saldoId: gravado?.id ?? null,
        campos,
        gravado: projecao,
        recalculado: estado,
        razao,
      });
    } else if (razao) {
      r.razaoInconsistente.push({ ...chave, ...razao, movimentos: estado.movimentos });
    }
  }
}

/**
 * `produtos.custo_medio` × a média ponderada dos saldos positivos gravados (a conta exata de
 * `fn_projetar_custo_medio_produto`, 0006, em SQL); fora os combos (custo dos componentes) e os produtos sem saldo
 * positivo (o último custo conhecido fica).
 */
async function conferirCustoProdutos(
  cliente: ConexaoRecalculo,
  filtro: FiltroRecalculo,
): Promise<DivergenciaCustoProduto[]> {
  const produto = idDoFiltro(filtro.produtoId, 'produto');
  const estoque = idDoFiltro(filtro.estoqueId, 'estoque');
  const { rows } = await cliente.query<{ produto_id: string; gravado: string; recalculado: string }>(
    `select p.id as produto_id, p.custo_medio::text as gravado, x.medio::text as recalculado
       from (select produto_id, round(sum(custo_medio * quantidade) / sum(quantidade), 4) as medio
               from saldos_estoque
              where quantidade > 0 and ($1::uuid is null or produto_id = $1::uuid)
              group by produto_id) as x
       join produtos p on p.id = x.produto_id
      where p.tipo <> 'kit' and p.custo_medio is distinct from x.medio
        and ($2::uuid is null or exists (select 1 from saldos_estoque s
                                          where s.produto_id = p.id and s.estoque_id = $2::uuid))
      order by p.id`,
    [produto, estoque],
  );
  return rows.map((p) => ({
    produtoId: p.produto_id,
    gravado: p.gravado,
    recalculado: p.recalculado,
    diferenca: decTexto(dec(p.recalculado).minus(dec(p.gravado)), 4),
  }));
}

/**
 * As linhas de `saldos_lote` com saldo e sem a linha de `saldos_estoque` da chave (F2-B6): o motor sempre grava as
 * duas juntas, então só um defeito as deixa assim, e o cursor (que traz os lotes dentro da linha de saldo) não as vê.
 * Entram em `divergencias`: na da chave que já diverge (o razão sem linha de saldo), refazendo os campos com esses
 * lotes; sem ela, como órfãs (o replay da chave, sem movimento, zera o lote no `--corrigir`).
 */
async function conferirLotesSemLinha(
  cliente: ConexaoRecalculo,
  filtro: FiltroRecalculo,
  divergencias: DivergenciaSaldo[],
): Promise<void> {
  const onde = condicoes(filtro, 'l.');
  const semLinha = `l.quantidade <> 0 and not exists (
      select 1 from saldos_estoque s
       where s.estoque_id = l.estoque_id and s.produto_id = l.produto_id
         and s.variacao_id is not distinct from l.variacao_id and s.tipo_estoque_id = l.tipo_estoque_id)`;
  const { rows } = await cliente.query<{
    estoque_id: string;
    produto_id: string;
    variacao_id: string | null;
    tipo_estoque_id: string;
    lote_id: string;
    quantidade: string;
  }>(
    `select l.estoque_id, l.produto_id, l.variacao_id, l.tipo_estoque_id, l.lote_id, l.quantidade::text
       from saldos_lote l ${onde ? `${onde} and ${semLinha}` : `where ${semLinha}`}
      order by l.estoque_id, l.produto_id, l.variacao_id, l.tipo_estoque_id, l.lote_id`,
  );
  if (!rows.length) return;
  const porChave = new Map<string, { chave: ChaveSaldo; lotes: Map<string, string> }>();
  for (const r of rows) {
    const k = `${r.estoque_id}|${r.produto_id}|${r.variacao_id ?? ''}|${r.tipo_estoque_id}`;
    const g = porChave.get(k) ?? { chave: chaveDe(r), lotes: new Map<string, string>() };
    g.lotes.set(r.lote_id, r.quantidade);
    porChave.set(k, g);
  }
  for (const { chave, lotes } of porChave.values()) {
    const gravado: ProjecaoSaldo = { ...estadoInicial(), lotes };
    const ja = divergencias.find((d) => compararChave(d, chave) === 0);
    if (ja) {
      ja.campos = compararProjecao(gravado, ja.recalculado);
      continue;
    }
    divergencias.push({
      ...chave,
      situacao: 'orfa',
      saldoId: null,
      campos: compararProjecao(gravado, estadoInicial()),
      gravado: null,
      recalculado: estadoInicial(),
      razao: null,
    });
  }
  divergencias.sort(compararChave);
}

/**
 * O razão pode ser refeito: a ordem de lançamento existe (0016) e está completa (0017 aplicada, ou nenhum movimento
 * sem ordem). Sem isso o replay não tem ordem confiável e o comando para com a instrução.
 */
export async function prontoParaRecalcular(cliente: ConexaoRecalculo): Promise<string | null> {
  const { rows } = await cliente.query<{ existe: boolean; obrigatoria: boolean }>(
    `select count(*) > 0 as existe, coalesce(bool_or(a.attnotnull), false) as obrigatoria
       from pg_attribute a
      where a.attrelid = 'public.movimentos_estoque'::regclass and a.attname = 'seq_lancamento'
        and not a.attisdropped`,
  );
  if (!rows[0]?.existe) return 'sem a migração 0016_movimentos_seq_a (rode db:migrate:empresas)';
  if (rows[0].obrigatoria) return null;
  const { rows: vazios } = await cliente.query<{ ha: boolean }>(
    'select exists (select 1 from movimentos_estoque where seq_lancamento is null) as ha',
  );
  return vazios[0]?.ha
    ? 'há movimentos sem ordem de lançamento (rode db:preencher-seq-lancamento ou db:migrate:empresas)'
    : null;
}

/**
 * A verificação: o razão e a projeção no mesmo instante (`repeatable read read only`), em páginas de
 * `porPagina` movimentos. Só lê; serve à role dona (comando) e à de runtime (tarefa periódica).
 */
export async function verificarSaldos(
  cliente: ConexaoRecalculo,
  filtro: FiltroRecalculo = {},
  opcoes: { porPagina?: number; aoPaginar?: () => void } = {},
): Promise<RelatorioRecalculo> {
  const porPagina = opcoes.porPagina ?? MOVIMENTOS_POR_PAGINA;
  await cliente.query('begin isolation level repeatable read read only');
  try {
    // Texto das datas em UTC: o mesmo instante sai sempre igual no relatório e volta exato no `--corrigir`.
    await cliente.query("set local timezone to 'UTC'");
    const base = await conferirProjecao(
      paginasCursor<MovimentoLido>(cliente, 'cursor_razao', SQL_MOVIMENTOS(filtro), porPagina),
      paginasCursor<SaldoLido>(cliente, 'cursor_saldos', SQL_SALDOS(filtro), porPagina),
      { aoPaginar: opcoes.aoPaginar },
    );
    await conferirLotesSemLinha(cliente, filtro, base.divergencias);
    const custoProdutos = await conferirCustoProdutos(cliente, filtro);
    await cliente.query('commit');
    return { ...base, custoProdutos };
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- Correção

export interface OrigemCorrecao {
  /** Quem roda (vai em `usuario_nome` da auditoria): `cli:<usuário>`, `vitest`… */
  executadoPor: string;
}

export interface ResultadoCorrecao {
  /** Linhas de saldo regravadas pelo replay. */
  corrigidas: number;
  /** Divergentes na verificação que, sob a trava, já estavam certas (outro processo corrigiu, ou a venda acertou). */
  jaCertas: number;
  transacoes: number;
  /** Produtos com `custo_medio` refeito por `fn_projetar_custo_medio_produto`. */
  custoProdutos: number;
}

const projecaoParaAuditoria = (p: ProjecaoSaldo) => ({
  quantidade: decTexto(p.quantidade, 3),
  custo_medio: decTexto(p.custoMedio, 4),
  ultima_entrada_em: textoInstante(p.ultimaEntradaEm),
  ultima_saida_em: textoInstante(p.ultimaSaidaEm),
  ultimo_movimento_id: p.ultimoMovimentoId,
  ultima_compra_em: textoInstante(p.ultimaCompraEm),
  ultimo_custo_compra: p.ultimoCustoCompra === null ? null : decTexto(p.ultimoCustoCompra, 4),
  lotes: Object.fromEntries([...p.lotes].map(([id, q]) => [id, decTexto(q, 3)])),
});

/**
 * Regrava as linhas divergentes pelo razão, em blocos de `porTransacao` (ver o topo do módulo) e depois a projeção do
 * custo médio dos produtos listados. Idempotente: o que já está certo sob a trava não é regravado nem auditado.
 */
export async function corrigirDivergencias(
  cliente: ConexaoRecalculo,
  relatorio: Pick<RelatorioRecalculo, 'divergencias' | 'custoProdutos'>,
  origem: OrigemCorrecao,
  opcoes: { porTransacao?: number } = {},
): Promise<ResultadoCorrecao> {
  const porTransacao = opcoes.porTransacao ?? LINHAS_POR_CORRECAO;
  const resultado: ResultadoCorrecao = { corrigidas: 0, jaCertas: 0, transacoes: 0, custoProdutos: 0 };
  const lista = ordenarChaves(relatorio.divergencias);
  for (let i = 0; i < lista.length; i += porTransacao) {
    const r = await corrigirBloco(cliente, lista.slice(i, i + porTransacao), origem);
    resultado.corrigidas += r.corrigidas;
    resultado.jaCertas += r.jaCertas;
    resultado.transacoes++;
  }
  const produtos = relatorio.custoProdutos.map((p) => p.produtoId);
  for (let i = 0; i < produtos.length; i += porTransacao) {
    resultado.custoProdutos += await corrigirCustoProdutos(
      cliente,
      produtos.slice(i, i + porTransacao),
      origem,
    );
    resultado.transacoes++;
  }
  return resultado;
}

const valoresChaves = (chaves: readonly ChaveSaldo[], extra = 0) =>
  chaves
    .map((_, i) => {
      const b = i * (5 + extra);
      const cols = [
        `$${b + 1}::int`,
        `$${b + 2}::uuid`,
        `$${b + 3}::uuid`,
        `$${b + 4}::uuid`,
        `$${b + 5}::uuid`,
      ];
      for (let j = 0; j < extra; j++) cols.push(`$${b + 6 + j}`);
      return `(${cols.join(', ')})`;
    })
    .join(', ');

const parametrosChaves = (chaves: readonly ChaveSaldo[]) =>
  chaves.flatMap((c, i) => [i, c.estoqueId, c.produtoId, c.variacaoId, c.tipoEstoqueId]);

async function corrigirBloco(
  cliente: ConexaoRecalculo,
  bloco: readonly DivergenciaSaldo[],
  origem: OrigemCorrecao,
): Promise<{ corrigidas: number; jaCertas: number }> {
  // A loja do estoque (auditoria) é lida antes da trava: não muda o resultado e não precisa segurá-la.
  const { rows: lojas } = await cliente.query<{ estoque_id: string; id: string }>(
    `select distinct on (estoque_id) estoque_id, id from lojas
      where estoque_id = any($1::uuid[]) and excluido_em is null order by estoque_id, codigo`,
    [[...new Set(bloco.map((d) => d.estoqueId))]],
  );
  const lojaDo = new Map(lojas.map((l) => [l.estoque_id, l.id]));
  await cliente.query('begin');
  try {
    await cliente.query("set local timezone to 'UTC'");
    // MD 1.5: a 7300001 antes de qualquer `for update` (a ordem do push), depois as linhas na ordem do motor.
    await cliente.query('select fn_trava_versao()');
    const semLinha = bloco.filter((d) => d.saldoId === null);
    if (semLinha.length) {
      await cliente.query(
        `insert into saldos_estoque (id, estoque_id, produto_id, variacao_id, tipo_estoque_id)
         select v.id, v.estoque_id, v.produto_id, v.variacao_id, v.tipo_estoque_id
           from (values ${semLinha
             .map(
               (_, i) =>
                 `($${5 * i + 1}::uuid, $${5 * i + 2}::uuid, $${5 * i + 3}::uuid, $${5 * i + 4}::uuid, $${5 * i + 5}::uuid)`,
             )
             .join(', ')}) as v(id, estoque_id, produto_id, variacao_id, tipo_estoque_id)
         on conflict (estoque_id, produto_id, variacao_id, tipo_estoque_id) do nothing`,
        semLinha.flatMap((d) => [uuidv7(), d.estoqueId, d.produtoId, d.variacaoId, d.tipoEstoqueId]),
      );
    }
    const { rows: travadas } = await cliente.query<SaldoLido & { ordem: number }>(
      `select v.ordem, ${COLUNAS_SALDO('s.', false)}
         from saldos_estoque s
         join (values ${valoresChaves(bloco)}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id)
           on s.estoque_id = v.estoque_id and s.produto_id = v.produto_id
          and s.variacao_id is not distinct from v.variacao_id and s.tipo_estoque_id = v.tipo_estoque_id
        order by v.ordem
          for update of s`,
      parametrosChaves(bloco),
    );
    if (travadas.length !== bloco.length) throw new Error('Linha de saldo não encontrada depois de criada');
    // As linhas de `saldos_lote` depois das de `saldos_estoque` (a ordem do motor, F2-B6).
    const { rows: lotesTravados } = await cliente.query<{
      ordem: number;
      lote_id: string;
      quantidade: string;
    }>(
      `select v.ordem, l.lote_id, l.quantidade::text
         from saldos_lote l
         join (values ${valoresChaves(bloco)}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id)
           on l.estoque_id = v.estoque_id and l.produto_id = v.produto_id
          and l.variacao_id is not distinct from v.variacao_id and l.tipo_estoque_id = v.tipo_estoque_id
        order by v.ordem, l.lote_id
          for update of l`,
      parametrosChaves(bloco),
    );
    for (const t of travadas) {
      const lotes = lotesTravados.filter((l) => Number(l.ordem) === Number(t.ordem));
      t.lotes = lotes.length ? lotes.map((l) => [l.lote_id, l.quantidade]) : null;
    }
    // O que entrou no razão depois da verificação: sob a 7300001 nada mais entra até o commit.
    const { rows: novos } = await cliente.query<MovimentoLido & { ordem: number }>(
      `select v.ordem, m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.id, m.seq_lancamento::text,
              m.quantidade::text, m.saldo_anterior::text, m.saldo_posterior::text, m.custo_unitario::text,
              m.custo_total::text, m.custo_medio_posterior::text, m.estorno_de_id, m.data_movimento::text,
              ${instante('m.data_movimento')} as data_us, m.tipo_movimento, m.lote_id
         from movimentos_estoque m
         join (values ${valoresChaves(bloco, 1)}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id, seq)
           on m.estoque_id = v.estoque_id and m.produto_id = v.produto_id
          and m.variacao_id is not distinct from v.variacao_id and m.tipo_estoque_id = v.tipo_estoque_id
          and m.seq_lancamento > coalesce(v.seq::bigint, 0)
        order by v.ordem, m.seq_lancamento, m.id`,
      bloco.flatMap((d, i) => [
        i,
        d.estoqueId,
        d.produtoId,
        d.variacaoId,
        d.tipoEstoqueId,
        d.recalculado.ultimaSeq,
      ]),
    );
    const replays = bloco.map((d) => new ReplayLinha(d.recalculado));
    for (const m of novos) replays[Number(m.ordem)]!.aplicar(m);
    const gravar: Array<{ saldo: SaldoLido; antes: ProjecaoSaldo; depois: ProjecaoSaldo }> = [];
    for (const t of travadas) {
      const depois = replays[Number(t.ordem)]!.estado();
      const antes = projecaoGravada(t);
      if (compararProjecao(antes, depois).length) gravar.push({ saldo: t, antes, depois });
    }
    if (gravar.length) {
      await cliente.query(
        `update saldos_estoque s
            set quantidade = v.quantidade, custo_medio = v.custo_medio, ultima_entrada_em = v.entrada,
                ultima_saida_em = v.saida, ultimo_movimento_id = v.ultimo, ultima_compra_em = v.compra_em,
                ultimo_custo_compra = v.custo_compra
           from (values ${gravar
             .map(
               (_, i) =>
                 `($${8 * i + 1}::uuid, $${8 * i + 2}::numeric, $${8 * i + 3}::numeric, $${8 * i + 4}::timestamptz, $${8 * i + 5}::timestamptz, $${8 * i + 6}::uuid, $${8 * i + 7}::timestamptz, $${8 * i + 8}::numeric)`,
             )
             .join(', ')}) as v(id, quantidade, custo_medio, entrada, saida, ultimo, compra_em, custo_compra)
          where s.id = v.id`,
        gravar.flatMap(({ saldo, depois }) => [
          saldo.id,
          decTexto(depois.quantidade, 3),
          decTexto(depois.custoMedio, 4),
          textoInstante(depois.ultimaEntradaEm),
          textoInstante(depois.ultimaSaidaEm),
          depois.ultimoMovimentoId,
          textoInstante(depois.ultimaCompraEm),
          depois.ultimoCustoCompra === null ? null : decTexto(depois.ultimoCustoCompra, 4),
        ]),
      );
      await gravarLotes(cliente, gravar);
      await inserirAuditoria(
        cliente,
        origem,
        gravar.map(({ saldo, antes, depois }) => ({
          lojaId: lojaDo.get(saldo.estoque_id) ?? null,
          entidade: 'saldos_estoque',
          registroId: saldo.id,
          descricao: 'Projeção do saldo refeita pelo razão de estoque (db:recalcular-saldos)',
          antes: projecaoParaAuditoria(antes),
          depois: projecaoParaAuditoria(depois),
        })),
      );
    }
    await cliente.query('commit');
    return { corrigidas: gravar.length, jaCertas: bloco.length - gravar.length };
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

/**
 * Regrava as linhas de `saldos_lote` divergentes das linhas corrigidas (F2-B6), já travadas: o saldo refeito pelo
 * razão, criando a linha que falta (o lote sem movimento fica zerado). Em blocos de `LINHAS_POR_COMANDO`.
 */
async function gravarLotes(
  cliente: ConexaoRecalculo,
  gravar: ReadonlyArray<{ saldo: SaldoLido; antes: ProjecaoSaldo; depois: ProjecaoSaldo }>,
): Promise<void> {
  const linhas = gravar.flatMap(({ saldo, antes, depois }) =>
    lotesDivergentes(antes.lotes, depois.lotes).map((c) => [
      uuidv7(),
      saldo.estoque_id,
      saldo.produto_id,
      saldo.variacao_id,
      c.loteId!,
      saldo.tipo_estoque_id,
      c.recalculado,
    ]),
  );
  for (let i = 0; i < linhas.length; i += LINHAS_POR_COMANDO) {
    const bloco = linhas.slice(i, i + LINHAS_POR_COMANDO);
    await cliente.query(
      `insert into saldos_lote (id, estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id, quantidade)
       values ${bloco
         .map((_, j) => {
           const b = 7 * j;
           return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}::uuid, $${b + 4}::uuid, $${b + 5}::uuid, $${b + 6}::uuid, $${b + 7}::numeric)`;
         })
         .join(', ')}
       on conflict (estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id)
       do update set quantidade = excluded.quantidade`,
      bloco.flat(),
    );
  }
}

interface LinhaAuditoria {
  lojaId: string | null;
  entidade: string;
  registroId: string;
  descricao: string;
  antes: unknown;
  depois: unknown;
}

/**
 * A auditoria `recalcular_saldos` (ERP 17.1) das linhas regravadas, num `insert` só, na transação da correção (a
 * linha só existe se a correção for confirmada). Origem `sistema`, com quem rodou em `usuario_nome`; nada sensível em
 * `antes`/`depois` (só saldos, custos, datas e ids).
 */
async function inserirAuditoria(
  cliente: ConexaoRecalculo,
  origem: OrigemCorrecao,
  linhas: readonly LinhaAuditoria[],
): Promise<void> {
  const valores = linhas.map((_, i) => {
    const b = 7 * i + 4;
    return `($${b}::uuid, $1::timestamptz, 'sistema', $2, $${b + 1}::uuid, $${b + 2}, $${b + 3}::uuid, $3, $${b + 4}, $${b + 5}::jsonb, $${b + 6}::jsonb)`;
  });
  await cliente.query(
    `insert into auditoria (id, ocorrido_em, origem, usuario_nome, loja_id, entidade, registro_id, acao, descricao,
                            antes, depois)
     values ${valores.join(', ')}`,
    [
      new Date().toISOString(),
      origem.executadoPor.slice(0, 100),
      ACAO_RECALCULAR_SALDOS,
      ...linhas.flatMap((l) => [
        uuidv7(),
        l.lojaId,
        l.entidade,
        l.registroId,
        l.descricao,
        JSON.stringify(l.antes),
        JSON.stringify(l.depois),
      ]),
    ],
  );
}

/** `fn_projetar_custo_medio_produto` dos produtos dados, sob a trava; devolve quantos mudaram (com auditoria). */
async function corrigirCustoProdutos(
  cliente: ConexaoRecalculo,
  produtoIds: readonly string[],
  origem: OrigemCorrecao,
): Promise<number> {
  await cliente.query('begin');
  try {
    await cliente.query('select fn_trava_versao()');
    const { rows: antes } = await cliente.query<{ id: string; custo_medio: string }>(
      'select id, custo_medio::text from produtos where id = any($1::uuid[]) order by id for update',
      [produtoIds],
    );
    await cliente.query('select fn_projetar_custo_medio_produto(id) from unnest($1::uuid[]) as id', [
      produtoIds,
    ]);
    const { rows: depois } = await cliente.query<{ id: string; custo_medio: string }>(
      'select id, custo_medio::text from produtos where id = any($1::uuid[])',
      [produtoIds],
    );
    const anterior = new Map(antes.map((p) => [p.id, p.custo_medio]));
    const mudaram = depois.filter((p) => anterior.get(p.id) !== p.custo_medio);
    if (mudaram.length) {
      await inserirAuditoria(
        cliente,
        origem,
        mudaram.map((p) => ({
          lojaId: null,
          entidade: 'produtos',
          registroId: p.id,
          descricao: 'Custo médio do produto refeito pelos saldos (db:recalcular-saldos)',
          antes: { custo_medio: anterior.get(p.id) },
          depois: { custo_medio: p.custo_medio },
        })),
      );
    }
    await cliente.query('commit');
    return mudaram.length;
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

/**
 * Resolve os `RAZAO_CADEIA_QUEBRADA` abertos das linhas do filtro (MD 3.1.8: quem o resolve é o recálculo). Só depois
 * do `--corrigir`, quando a projeção de todas elas acabou de ser conferida ou regravada pelo razão: a quebra continua no
 * razão como histórico (o movimento é imutável), mas o saldo que ela podia ter desviado está certo.
 */
export async function resolverAlertasCadeia(
  cliente: ConexaoRecalculo,
  filtro: FiltroRecalculo = {},
): Promise<number> {
  const { rows } = await cliente.query(
    `update alertas set resolvido_em = now(),
            resolucao = 'Saldo conferido e refeito pelo razão (db:recalcular-saldos)'
      where tipo = $1 and resolvido_em is null and excluido_em is null
        and ($2::text is null or dados ->> 'estoque_id' = $2)
        and ($3::text is null or dados ->> 'produto_id' = $3)
      returning id`,
    [
      ALERTA_RAZAO_CADEIA_QUEBRADA,
      idDoFiltro(filtro.estoqueId, 'estoque'),
      idDoFiltro(filtro.produtoId, 'produto'),
    ],
  );
  return rows.length;
}

/**
 * Resolve o `RAZAO_SALDO_DIVERGENTE` aberto da empresa (o da verificação periódica). Só com uma conferência da empresa
 * inteira (sem filtro) que deu idêntica: a da própria verificação, ou a do `db:recalcular-saldos` — sem esta, o alerta
 * aberto antes de a verificação ser desligada ficava no painel para sempre, mesmo com a projeção já corrigida.
 */
export async function resolverAlertaSaldoDivergente(
  cliente: ConexaoRecalculo,
  resolucao: string,
): Promise<number> {
  const { rows } = await cliente.query(
    `update alertas set resolvido_em = now(), resolucao = $3
      where tipo = $1 and chave_deduplicacao = $2 and resolvido_em is null and excluido_em is null
      returning id`,
    [ALERTA_RAZAO_SALDO_DIVERGENTE, CHAVE_ALERTA_SALDO_DIVERGENTE, resolucao],
  );
  return rows.length;
}
