/**
 * Razão de estoque (ERP 13.1; MD 3.7): todo efeito sobre o estoque é um movimento em `movimentos_estoque`
 * (append-only) e a projeção `saldos_estoque` é atualizada na **mesma transação**, com `select … for update` na linha
 * do saldo (criada com `on conflict do nothing` quando ainda não existe). O custo é gravado no movimento: entradas com
 * o custo do documento (recalculando o custo médio ponderado da linha), saídas com o custo médio vigente, e o estorno
 * de uma saída entra ao custo da saída original sem redefinir o custo médio de saldo zerado ou negativo (T20).
 *
 * Quem chama abre a transação com `travaVersao` (saldos descem ao PDV) e trava as linhas em ordem estável
 * (`ordenarChaves`) para dois documentos não se travarem em ordens opostas. O documento do PDV (venda, cancelamento,
 * devolução de cascos; Fase 1C, bloco C6a) usa `lancarDocumento`, que já trava tudo na ordem e soma as linhas de mesma
 * chave de idempotência, e lê os cadastros com `lerCadastrosEstoque` **antes** da trava 7300001 (`preparar` do
 * handler, SYNC 8.3): a trava serializa toda gravação sincronizável da empresa, e só o que grava fica sob ela.
 *
 * Ordem de lançamento (Fase 2, F2-B2): o `INSERT` não cita `seq_lancamento`; o default (`nextval`) roda nele, depois
 * do `select … for update` da linha, e grava a ordem em que o custo médio foi calculado — a do replay do razão.
 *
 * Regra de data (Fase 2, F2-B4; ERP 13.1.5; SYNC 15.3; README da API › decisão 148): o movimento do PDV grava a hora
 * do fato; o documento do ERP lança em `now()` (a data do documento é atributo do cabeçalho) e só o "Definir" (na
 * `data_contagem`) e a compensação (na data do fato compensado) lançam no passado, com `retroativoPermitido`
 * (`conferirDataMovimentos`). A compensação contra o "Definir" já efetivado é de `compensacao.ts`.
 *
 * Lote e última compra (Fase 2, F2-B6; MD 3.6.9, 3.7.3, 3.7.4; F2-Q7 = D48; README da API › decisão 151): o movimento
 * com `lote_id` mantém também a linha de `saldos_lote`, travada **depois** de todas as de `saldos_estoque` do documento,
 * na mesma ordem estável (`ordenarChaves`, que desempata pelo lote). Toda gravação em `saldos_lote` passa por aqui (ou
 * pelo `--corrigir` do recálculo, que trava na mesma ordem) com a linha de `saldos_estoque` já travada, então a linha do
 * lote nunca é disputada sozinha e não há ordem cruzada. O lote é do produto, da variação e do estoque do movimento (ou
 * sem estoque): do ERP o contrário é `ErroLoteInvalido`; do PDV a nuvem não recusa a venda (SYNC 15.1) e a linha segue
 * sem o lote. A saída sem lote (venda do PDV-1, acerto sem lote) de produto com saldo de lote naquele estoque é
 * dividida em FEFO (`dividirSaidaFefo`, `estoque.lote_baixa_sem_informar` = 'fefo'): um movimento por lote, ao custo
 * médio da linha, e a sobra sem saldo de lote sem `lote_id`. Estorno e compensação nunca são divididos: herdam o lote
 * do movimento que desfazem. A entrada de compra (`RECEB_MANUAL`, `RECEB_NFE`) grava a última compra da linha.
 */
import {
  CHAVE_LOTE_BAIXA_SEM_INFORMAR,
  aplicarMovimentoNoSaldo,
  dec,
  decTexto,
  dividirSaidaFefo,
  estornoDeMudancaTipo,
  movimentoDeCompra,
  type LoteDisponivel,
  type ModoLoteBaixaSemInformar,
  type Valor,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { uuidv5 } from '../comum/uuid-v5.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/*
 * Quantidades e custos andam como texto do `numeric` e são calculados em decimal (`dec`, ADR-05): o razão é
 * permanente e não pode divergir um centavo do `decimal` do PDV nem dos relatórios.
 */

export interface ChaveSaldo {
  estoqueId: string;
  produtoId: string;
  variacaoId: string | null;
  tipoEstoqueId: string;
  /**
   * Lote (`produtos_lotes`, F2-B6): não faz parte da linha de `saldos_estoque` (a mesma para todos os lotes); com ele, o
   * movimento mantém também a linha de `saldos_lote` da chave + lote.
   */
  loteId?: string | null;
}

export interface SaldoTravado extends ChaveSaldo {
  id: string;
  /** `numeric(15,3)` como texto. */
  quantidade: string;
  /** `numeric(15,4)` como texto. */
  custoMedio: string;
}

export interface NovoMovimento extends ChaveSaldo {
  tipoMovimento: string;
  /** Com sinal, na unidade base (+ entrada, − saída). */
  quantidade: Valor;
  /**
   * Entrada: custo do documento (padrão = custo médio, ou `custoReferencia` sem saldo). Estorno de saída
   * (`estornoDeId` com quantidade positiva): obrigatório, o custo da saída original (T20). Saída: ignorado, salvo no
   * estorno da perna de entrada da mudança de tipo (`estornoDeMudancaTipo`, F2-B8): obrigatório, o custo da entrada.
   */
  custoUnitario?: Valor | null;
  /** Custo usado quando a linha de saldo ainda não tem custo médio (ex.: `produtos.preco_custo`). */
  custoReferencia: Valor;
  precoVenda: Valor | null;
  dataMovimento: Date;
  lojaId: string | null;
  usuarioId: string | null;
  documentoTipo:
    'venda' | 'troca' | 'acerto' | 'recebimento' | 'nota_entrada' | 'transferencia' | 'vasilhame';
  documentoId: string | null;
  documentoItemId: string | null;
  /** Sigla da unidade/embalagem do documento (`varchar(6)`); com `fator`, a do código de barras lido (SYNC 10.2). */
  unidadeDocumento?: string | null;
  /** Fator da embalagem lida (`produtos_codigos_barras.fator`); padrão 1. A quantidade já vem na unidade base. */
  fator?: Valor | null;
  /** Cliente da venda / fornecedor (MD 3.7.2). */
  pessoaId?: string | null;
  /** Origem PDV: terminal dono e evento que gerou o movimento (MD 3.7.2). */
  terminalId?: string | null;
  eventoId?: string | null;
  estornoDeId?: string | null;
  /** `ACERTO_COMPENSACAO` (SYNC 15.3): o movimento tardio compensado. */
  compensaMovimentoId?: string | null;
  observacao?: string | null;
}

export interface MovimentoAplicado {
  id: string;
  saldoAnterior: string;
  saldoPosterior: string;
  custoUnitario: string;
  custoTotal: string;
  custoMedioPosterior: string;
}

/*
 * Ids comparados em minúsculas: o PostgreSQL trata `ABC…` e `abc…` como o mesmo `uuid` (e o `z.uuid()` dos contratos
 * aceita as duas caixas). Comparados como texto cru, o mesmo produto em caixas diferentes virava dois grupos para a
 * mesma linha de saldo, as duas contas partiam do mesmo saldo travado e a projeção divergia do razão.
 */
const minusculo = (v: string) => v.toLowerCase();
const minusculoNulo = (v: string | null | undefined) =>
  v === null || v === undefined ? null : v.toLowerCase();

const chaveTexto = (c: ChaveSaldo) =>
  `${minusculo(c.estoqueId)}|${minusculo(c.produtoId)}|${minusculoNulo(c.variacaoId) ?? ''}|${minusculo(c.tipoEstoqueId)}`;

/**
 * Teto de linhas por comando nos `INSERT`/`UPDATE`/`select … for update` de várias linhas. O protocolo do PostgreSQL
 * aceita no máximo 65535 parâmetros por comando (o contador do `Bind` é de 16 bits): com 28 por movimento, um comando
 * só passava do limite a partir de 2341 movimentos (uma comanda grande de drinques com ficha técnica), e a venda caía
 * em `ERRO_INTERNO` a cada reenvio. Em blocos, na mesma transação e na mesma ordem, o efeito é o mesmo.
 */
export const LINHAS_POR_COMANDO = 1000;

function emBlocos<T>(itens: readonly T[], tamanho: number): T[][] {
  const blocos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) blocos.push(itens.slice(i, i + tamanho));
  return blocos;
}

/** A linha de `saldos_lote`: a de `saldos_estoque` mais o lote. */
const chaveLoteTexto = (c: ChaveSaldo) => `${chaveTexto(c)}|${minusculoNulo(c.loteId) ?? ''}`;

/**
 * Ordem estável de travamento das linhas de saldo: a da linha de `saldos_estoque` e, nela, a do lote (os lotes em
 * ordem e o sem lote **por último**). Quem trava as de `saldos_lote` trava antes todas as de `saldos_estoque` (F2-B6).
 * O sem lote no fim é o que o documento lançado item a item (o acerto) precisa: o item com o lote informado reserva o
 * lote antes de a Saída sem lote da mesma linha ser dividida em FEFO, que senão consumia justamente esse lote. A ordem
 * entre linhas de `saldos_estoque` diferentes não depende do lote.
 */
export function ordenarChaves<T extends ChaveSaldo>(chaves: readonly T[]): T[] {
  return [...chaves].sort((a, b) => {
    const x = chaveTexto(a);
    const y = chaveTexto(b);
    if (x !== y) return x < y ? -1 : 1;
    const la = minusculoNulo(a.loteId);
    const lb = minusculoNulo(b.loteId);
    if (la === lb) return 0;
    if (la === null) return 1;
    if (lb === null) return -1;
    return la < lb ? -1 : 1;
  });
}

/**
 * O lote do movimento não é do produto, da variação ou do estoque dele (MD 3.6.9: `produtos_lotes.estoque_id` nulo ou
 * igual ao do movimento). Erro do documento do ERP, que confere o lote do item antes (acerto: 422 no campo); a
 * migração 0020 recusa o mesmo no banco (`LOTE_INVALIDO`).
 */
export class ErroLoteInvalido extends Error {
  constructor(
    readonly loteId: string,
    readonly produtoId: string,
  ) {
    super(`Lote ${loteId} não é do produto ${produtoId} ou é de outro estoque`);
    this.name = 'ErroLoteInvalido';
  }
}

/**
 * Folga da regra de data: o documento do ERP monta as linhas com `new Date()` e só depois as lança, às vezes depois
 * de esperar a trava de uma linha de saldo, então a data é um pouco anterior ao instante da conferência. Um minuto
 * cobre essa espera sem abrir espaço para um lançamento retroativo de verdade. O documento que lança linha a linha
 * (a Entrada/Saída do acerto, até 5.000 itens) passa `inicioDocumento`, e a folga é medida contra o início dele, não
 * contra o relógio de cada linha: a duração do laço não conta.
 */
export const FOLGA_RETROATIVO_MS = 60_000;

export interface OpcoesLancamento {
  /**
   * Libera `data_movimento` anterior a `now() − FOLGA_RETROATIVO_MS` num movimento que não é do PDV. Só o "Definir"
   * (inclusive o AJUSTE_IMPORTACAO, na hora da contagem) e a compensação (`compensarDefinir`) passam `true`; o nome
   * evita a confusão com "compensar".
   */
  retroativoPermitido?: boolean;
  /**
   * O instante em que o documento começou a lançar (capturado uma vez, antes do laço): a regra de data mede a folga
   * contra ele, e não contra o `Date.now()` de cada chamada. Sem ele, "agora".
   */
  inicioDocumento?: Date;
}

/**
 * Erro de programação (não é regra de negócio nem chega ao usuário como 422): um documento do ERP montou um movimento
 * no passado sem `retroativoPermitido`. Lançado assim, ele entraria antes da contagem de um "Definir" já efetivado (ou
 * entre a contagem e a efetivação) e furaria a contagem, porque só o PDV e o próprio "Definir" são compensados.
 */
export class ErroDataRetroativa extends Error {
  constructor(m: Pick<NovoMovimento, 'tipoMovimento' | 'documentoTipo' | 'dataMovimento'>) {
    super(
      `Movimento ${m.tipoMovimento} do documento ${m.documentoTipo} com data_movimento ${m.dataMovimento.toISOString()} no passado sem retroativoPermitido`,
    );
    this.name = 'ErroDataRetroativa';
  }
}

/**
 * Regra de data do razão (F2-B4): recusa, com `ErroDataRetroativa`, o movimento que não é do PDV (o do PDV traz o
 * `evento_id` que o gerou, e a compensação de um movimento do PDV o herda) com `data_movimento` anterior a
 * `agora − FOLGA_RETROATIVO_MS` (`agora` = o `inicioDocumento`, ou o relógio), salvo com `retroativoPermitido`. A
 * data futura não é conferida aqui: o "Definir" tem a folga de 5 min do `criarAcertoSchema`, e o PDV, o
 * `RELOGIO_SUSPEITO` (SYNC 12.4).
 */
export function conferirDataMovimentos(
  linhas: readonly NovoMovimento[],
  opcoes: OpcoesLancamento = {},
  agora = opcoes.inicioDocumento?.getTime() ?? Date.now(),
): void {
  if (opcoes.retroativoPermitido) return;
  const limite = agora - FOLGA_RETROATIVO_MS;
  const fora = linhas.find((l) => !l.eventoId && l.dataMovimento.getTime() < limite);
  if (fora) throw new ErroDataRetroativa(fora);
}

/** Garante a linha de saldo e a trava (`for update`) até o fim da transação. */
export async function travarSaldo(tx: DbEmpresa, c: ChaveSaldo): Promise<SaldoTravado> {
  await tx.execute(sql`
    insert into saldos_estoque (id, estoque_id, produto_id, variacao_id, tipo_estoque_id)
    values (${uuidv7()}, ${c.estoqueId}, ${c.produtoId}, ${c.variacaoId}, ${c.tipoEstoqueId})
    on conflict (estoque_id, produto_id, variacao_id, tipo_estoque_id) do nothing`);
  return (await travarSaldoExistente(tx, c))!;
}

/**
 * Trava (`for update`) a linha de saldo **se ela existir**, sem criá-la; `null` sem linha (nenhum movimento nunca:
 * o motor cria a linha antes do primeiro). Para o "Definir" de 0, que não lança nada e não precisa da linha zerada.
 */
export async function travarSaldoExistente(tx: DbEmpresa, c: ChaveSaldo): Promise<SaldoTravado | null> {
  const { rows } = await tx.execute<{ id: string; quantidade: string; custo_medio: string }>(sql`
    select id, quantidade::text, custo_medio::text from saldos_estoque
     where estoque_id = ${c.estoqueId} and produto_id = ${c.produtoId}
       and variacao_id is not distinct from ${c.variacaoId} and tipo_estoque_id = ${c.tipoEstoqueId}
       for update`);
  const r = rows[0];
  return r ? { ...c, id: r.id, quantidade: r.quantidade, custoMedio: r.custo_medio } : null;
}

/**
 * Saldo de um lote na linha (`saldos_lote.quantidade`, texto; '0' sem linha). Quem chama já travou a linha de
 * `saldos_estoque` (`travarSaldo`), e só quem a trava grava a do lote: a leitura fica estável até o fim da transação.
 */
export async function saldoDoLote(tx: DbEmpresa, c: ChaveSaldo & { loteId: string }): Promise<string> {
  const { rows } = await tx.execute<{ q: string }>(sql`
    select quantidade::text as q from saldos_lote
     where estoque_id = ${c.estoqueId} and produto_id = ${c.produtoId}
       and variacao_id is not distinct from ${c.variacaoId} and tipo_estoque_id = ${c.tipoEstoqueId}
       and lote_id = ${c.loteId}`);
  return rows[0]?.q ?? '0';
}

/** Soma dos movimentos já aplicados depois de `data` na linha de saldo (ERP 13.1.5 regra 2), texto. */
export async function somaMovimentosPosteriores(tx: DbEmpresa, c: ChaveSaldo, data: Date): Promise<string> {
  const { rows } = await tx.execute<{ s: string | null }>(sql`
    select coalesce(sum(quantidade), 0)::text as s from movimentos_estoque
     where estoque_id = ${c.estoqueId} and produto_id = ${c.produtoId}
       and variacao_id is not distinct from ${c.variacaoId} and tipo_estoque_id = ${c.tipoEstoqueId}
       and data_movimento > ${data.toISOString()}`);
  return rows[0]?.s ?? '0';
}

/** Um movimento calculado sobre a linha de saldo travada, pronto para o `INSERT` (texto do `numeric`). */
interface MovimentoCalculado extends MovimentoAplicado {
  m: NovoMovimento;
  saldoId: string;
  quantidade: string;
  fator: string;
  precoVenda: string | null;
}

/**
 * A conta de um movimento (ERP 13.1.4; T20) sobre a linha de saldo travada, sem tocar no banco: custo gravado, custo
 * médio e saldo depois dele, pela função pura `aplicarMovimentoNoSaldo` do shared (F2-B2), a mesma do replay do razão.
 * Deixa `saldo` com os valores novos (para o próximo movimento da mesma linha).
 */
function calcularMovimento(saldo: SaldoTravado, m: NovoMovimento): MovimentoCalculado {
  const r = aplicarMovimentoNoSaldo(saldo.quantidade, saldo.custoMedio, {
    quantidade: m.quantidade,
    custoUnitario: m.custoUnitario,
    custoReferencia: m.custoReferencia,
    estorno: Boolean(m.estornoDeId),
    saidaAoCusto: estornoDeMudancaTipo(m),
  });
  saldo.quantidade = r.saldoPosterior;
  saldo.custoMedio = r.custoMedioPosterior;
  return {
    id: uuidv7(),
    m,
    saldoId: saldo.id,
    quantidade: r.quantidade,
    fator: m.fator === null || m.fator === undefined ? '1' : decTexto(m.fator, 3),
    precoVenda: m.precoVenda === null ? null : decTexto(m.precoVenda, 4),
    saldoAnterior: r.saldoAnterior,
    saldoPosterior: r.saldoPosterior,
    custoUnitario: r.custoUnitario,
    custoTotal: r.custoTotal,
    custoMedioPosterior: r.custoMedioPosterior,
  };
}

const aplicado = (c: MovimentoCalculado): MovimentoAplicado => ({
  id: c.id,
  saldoAnterior: c.saldoAnterior,
  saldoPosterior: c.saldoPosterior,
  custoUnitario: c.custoUnitario,
  custoTotal: c.custoTotal,
  custoMedioPosterior: c.custoMedioPosterior,
});

/** `INSERT` de um ou mais movimentos calculados, em blocos de `porComando` (`LINHAS_POR_COMANDO`). */
async function inserirMovimentos(
  tx: DbEmpresa,
  movimentos: readonly MovimentoCalculado[],
  porComando = LINHAS_POR_COMANDO,
): Promise<void> {
  for (const bloco of emBlocos(movimentos, porComando)) await inserirBlocoMovimentos(tx, bloco);
}

async function inserirBlocoMovimentos(
  tx: DbEmpresa,
  movimentos: readonly MovimentoCalculado[],
): Promise<void> {
  const linhas = movimentos.map(
    ({ m, ...c }) => sql`(
      ${c.id}, ${m.estoqueId}, ${m.lojaId}, ${m.tipoEstoqueId}, ${m.produtoId}, ${m.variacaoId}, ${m.loteId ?? null},
      ${m.tipoMovimento}, ${c.quantidade}::numeric, ${m.unidadeDocumento?.slice(0, 6) ?? null}, ${c.fator}::numeric,
      ${c.saldoAnterior}::numeric, ${c.saldoPosterior}::numeric, ${c.custoUnitario}::numeric,
      ${c.custoTotal}::numeric, ${c.custoMedioPosterior}::numeric, ${c.precoVenda}::numeric,
      ${m.dataMovimento.toISOString()}::timestamptz, ${m.usuarioId}::uuid, ${m.pessoaId ?? null}::uuid,
      ${m.documentoTipo}, ${m.documentoId}::uuid, ${m.documentoItemId}::uuid, ${m.terminalId ?? null}::uuid,
      ${m.eventoId ?? null}::uuid, ${m.estornoDeId ?? null}::uuid, ${m.compensaMovimentoId ?? null}::uuid,
      ${m.observacao ?? null})`,
  );
  await tx.execute(sql`
    insert into movimentos_estoque (
      id, estoque_id, loja_id, tipo_estoque_id, produto_id, variacao_id, lote_id, tipo_movimento, quantidade,
      unidade_documento, fator, saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior,
      preco_venda, data_movimento, usuario_id, pessoa_id, documento_tipo, documento_id, documento_item_id,
      terminal_id, evento_id, estorno_de_id, compensa_movimento_id, observacao)
    values ${sql.join(linhas, sql`, `)}`);
}

/**
 * Projeção depois dos movimentos, num `UPDATE` para todas as linhas de saldo (em blocos de `porComando`; cada grupo =
 * os movimentos de uma linha, na ordem): quantidade e custo médio do último, datas de última entrada/saída pelo
 * `greatest` das datas dos fatos (o `greatest` ignora o nulo) e `ultimo_movimento_id` = o último lançado. A última
 * compra (F2-B6) é a da última entrada de compra lançada (`movimentoDeCompra`): a data e o custo unitário dela; sem
 * compra no grupo, fica a gravada. O replay do razão (`recalcular.ts`) segue a mesma regra na ordem de lançamento.
 */
async function atualizarSaldos(
  tx: DbEmpresa,
  grupos: ReadonlyArray<readonly MovimentoCalculado[]>,
  porComando = LINHAS_POR_COMANDO,
): Promise<void> {
  const linhas = grupos
    .filter((g) => g.length)
    .map((g) => {
      const ultimo = g.at(-1)!;
      const data = (sinal: 1 | -1) => {
        const d = g
          .filter((c) => dec(c.quantidade).times(sinal).gt(0))
          .map((c) => c.m.dataMovimento.getTime());
        return d.length ? new Date(Math.max(...d)).toISOString() : null;
      };
      const compra = g.findLast((c) =>
        movimentoDeCompra({
          tipoMovimento: c.m.tipoMovimento,
          quantidade: c.quantidade,
          estornoDeId: c.m.estornoDeId,
        }),
      );
      return sql`(${ultimo.saldoId}::uuid, ${ultimo.saldoPosterior}::numeric, ${ultimo.custoMedioPosterior}::numeric,
        ${data(1)}::timestamptz, ${data(-1)}::timestamptz, ${ultimo.id}::uuid,
        ${compra ? compra.m.dataMovimento.toISOString() : null}::timestamptz,
        ${compra ? compra.custoUnitario : null}::numeric)`;
    });
  for (const bloco of emBlocos(linhas, porComando)) {
    await tx.execute(sql`
      update saldos_estoque s
         set quantidade = v.quantidade,
             custo_medio = v.custo_medio,
             ultima_entrada_em = greatest(s.ultima_entrada_em, v.entrada),
             ultima_saida_em = greatest(s.ultima_saida_em, v.saida),
             ultimo_movimento_id = v.ultimo,
             ultima_compra_em = coalesce(v.compra_em, s.ultima_compra_em),
             ultimo_custo_compra = coalesce(v.custo_compra, s.ultimo_custo_compra)
        from (values ${sql.join(bloco, sql`, `)})
          as v(id, quantidade, custo_medio, entrada, saida, ultimo, compra_em, custo_compra)
       where s.id = v.id`);
  }
}

/** A linha de `saldos_lote` travada (F2-B6), com a quantidade corrente na transação. */
interface SaldoLoteTravado {
  id: string;
  quantidade: string;
}

/** Grava a quantidade final das linhas de `saldos_lote` tocadas, num `UPDATE` por bloco. */
async function atualizarSaldosLote(
  tx: DbEmpresa,
  lotes: readonly SaldoLoteTravado[],
  porComando = LINHAS_POR_COMANDO,
): Promise<void> {
  for (const bloco of emBlocos(lotes, porComando)) {
    await tx.execute(sql`
      update saldos_lote s set quantidade = v.quantidade
        from (values ${sql.join(
          bloco.map((l) => sql`(${l.id}::uuid, ${l.quantidade}::numeric)`),
          sql`, `,
        )}) as v(id, quantidade)
       where s.id = v.id`);
  }
}

/**
 * Lança um movimento sobre uma linha de saldo **já travada** (por `travarSaldo`) e atualiza a projeção (a de
 * `produtos.custo_medio` é do trigger `tg_saldos_estoque_custo_medio`, migração 0006). Desde o F2-B6 passa pelo
 * `lancarDocumento` (a nova trava da linha já travada não espera), pelo lote e pela divisão FEFO: a saída sem lote de
 * produto com saldo de lote vira um movimento por lote. Devolve os movimentos lançados (um, ou um por lote, na ordem) e
 * deixa `saldo` com os valores depois do último (para o próximo movimento da mesma linha na mesma transação).
 */
export async function lancarMovimento(
  tx: DbEmpresa,
  saldo: SaldoTravado,
  m: NovoMovimento,
  opcoes: OpcoesLancamento = {},
): Promise<MovimentoDoDocumento[]> {
  const { movimentos } = await lancarDocumento(tx, [m], opcoes);
  const ultimo = movimentos.at(-1);
  if (ultimo) {
    saldo.quantidade = ultimo.saldoPosterior;
    saldo.custoMedio = ultimo.custoMedioPosterior;
  }
  return movimentos;
}

// ---------------------------------------------------------------- Documento do PDV (Fase 1C, bloco C6a)

/**
 * Namespace dos ids derivados (T4). Fixo para sempre: mudar faz o mesmo documento gerar outro `documento_item_id` e
 * a segunda barreira (`uq_movimentos_estoque_idempotencia`) deixar de reconhecer a reaplicação.
 */
export const NAMESPACE_ITEM_DOCUMENTO = '56aece6d-47ec-4852-960a-3e470df99465';

/**
 * `documento_item_id` determinístico (UUIDv5, T4) para movimento sem linha própria no documento: o bloco `vasilhames`
 * da venda (`VASILHAME_DEVOLVIDO`, `VASILHAME_EMPRESTADO`), que não tem item. Sem ele o índice de idempotência (que só
 * vale com `documento_item_id`) não protegia esses movimentos. A proteção principal continua sendo
 * `eventos_recebidos` e o rollback da transação do evento; esta é a segunda barreira (MD 3.7.2).
 */
export function itemDerivadoDocumento(documentoId: string, rotulo: string): string {
  // Em minúsculas: o mesmo documento em outra caixa derivava outro id e escapava do índice.
  return uuidv5(`${minusculo(documentoId)}:${rotulo}`, NAMESPACE_ITEM_DOCUMENTO);
}

/**
 * Chave de `uq_movimentos_estoque_idempotencia` (mais o estoque), para somar as linhas iguais. Desde a migração 0013
 * (T23) o índice inclui `compensa_movimento_id` e `estorno_de_id`: duas compensações contra o mesmo item do acerto, de
 * movimentos tardios diferentes, não são a mesma linha, nem dois estornos de movimentos diferentes do mesmo item.
 */
const chaveIdempotencia = (m: NovoMovimento) =>
  [
    minusculo(m.estoqueId),
    m.documentoTipo,
    minusculoNulo(m.documentoItemId),
    minusculo(m.produtoId),
    minusculoNulo(m.variacaoId) ?? '',
    minusculoNulo(m.loteId) ?? '',
    minusculo(m.tipoEstoqueId),
    m.tipoMovimento,
    minusculoNulo(m.compensaMovimentoId) ?? '',
    minusculoNulo(m.estornoDeId) ?? '',
  ].join('|');

/** Os ids da linha em minúsculas (ver `minusculo`), para o documento agrupar, somar e gravar como o banco compara. */
const normalizarIds = (m: NovoMovimento): NovoMovimento => ({
  ...m,
  estoqueId: minusculo(m.estoqueId),
  produtoId: minusculo(m.produtoId),
  variacaoId: minusculoNulo(m.variacaoId),
  tipoEstoqueId: minusculo(m.tipoEstoqueId),
  lojaId: minusculoNulo(m.lojaId),
  usuarioId: minusculoNulo(m.usuarioId),
  documentoId: minusculoNulo(m.documentoId),
  documentoItemId: minusculoNulo(m.documentoItemId),
  loteId: minusculoNulo(m.loteId),
  pessoaId: minusculoNulo(m.pessoaId),
  terminalId: minusculoNulo(m.terminalId),
  eventoId: minusculoNulo(m.eventoId),
  estornoDeId: minusculoNulo(m.estornoDeId),
  compensaMovimentoId: minusculoNulo(m.compensaMovimentoId),
});

/**
 * Soma as linhas com a mesma chave de idempotência (T4): dois insumos iguais na mesma ficha técnica, ou o mesmo
 * insumo vindo de duas linhas de `componentes_estoque` do item, viram **um** `BAIXA_INSUMO` com a soma (o índice não
 * aceita dois). Linha sem `documento_item_id` não é somada (o índice não a cobre). Soma zero sai da lista. Linhas
 * somadas têm de concordar no custo informado (entrada); a primeira dá os demais campos.
 */
export function somarLinhasIguais(linhas: readonly NovoMovimento[]): NovoMovimento[] {
  const porChave = new Map<string, NovoMovimento>();
  const saida: NovoMovimento[] = [];
  for (const l of linhas) {
    if (l.documentoItemId === null) {
      saida.push({ ...l });
      continue;
    }
    const chave = chaveIdempotencia(l);
    const ja = porChave.get(chave);
    if (!ja) {
      const nova = { ...l, quantidade: decTexto(l.quantidade, 3) };
      porChave.set(chave, nova);
      saida.push(nova);
      continue;
    }
    const custo = (v: Valor | null | undefined) => (v === null || v === undefined ? null : decTexto(v, 4));
    if (custo(ja.custoUnitario) !== custo(l.custoUnitario)) {
      throw new Error(`Linhas do mesmo movimento com custos diferentes (${l.tipoMovimento} ${l.produtoId})`);
    }
    ja.quantidade = decTexto(dec(ja.quantidade).plus(dec(decTexto(l.quantidade, 3))), 3);
  }
  return saida.filter((l) => !dec(decTexto(l.quantidade, 3)).isZero());
}

export interface MovimentoDoDocumento extends MovimentoAplicado {
  linha: NovoMovimento;
}

export interface SaldoNegativo extends ChaveSaldo {
  saldoPosterior: string;
}

export interface ResultadoDocumento {
  /** Na ordem em que foram lançados (a das chaves travadas); `linha` com os ids em minúsculas. */
  movimentos: MovimentoDoDocumento[];
  /**
   * `documento_item_id` (em minúsculas) → Σ `custo_total` dos movimentos do item (SYNC 10.2: custo do item e da
   * venda).
   */
  custoPorItem: Map<string, string>;
  /**
   * Linhas de saldo que terminaram **este lançamento** negativas, antes de qualquer movimento lançado depois na mesma
   * transação. O handler da venda não usa: o alerta `ESTOQUE_NEGATIVO` sai do saldo final de cada linha depois das
   * compensações do "Definir" (SYNC 15.1, 15.3), que podem tirar a linha do negativo.
   */
  negativos: SaldoNegativo[];
}

/**
 * Lança todos os movimentos de um documento (SYNC 10.2, 10.4): soma as linhas iguais (`somarLinhasIguais`), trava as
 * linhas de saldo **uma vez cada, em `ordenarChaves`** (duas vendas com os mesmos produtos em ordens diferentes não se
 * travam; SYNC 8.3 "Ordem de travas de linha") e lança, na ordem do documento, os movimentos de cada linha, com um
 * `INSERT` para todos os movimentos e um `UPDATE` para todas as linhas de saldo. Roda
 * **antes** do `INSERT` do documento ("saída lançada antes do documento"): `documento_id` não tem FK, e o custo de
 * cada item (`custoPorItem`) já sai daqui para o `INSERT` de `itens_venda`/`vendas`, sem `UPDATE` em documento
 * imutável. Nunca recusa saldo negativo (15.1: a nuvem não recusa venda); quem chama decide o alerta. Os ids
 * entram em minúsculas (`normalizarIds`) e os comandos vão em blocos de `LINHAS_POR_COMANDO` (`porComando` só muda
 * nos testes, para cruzar os blocos com poucos produtos). A regra de data (`conferirDataMovimentos`) vale antes de
 * qualquer trava: o documento do ERP no passado sem `retroativoPermitido` não chega a lançar nada.
 *
 * Lote (F2-B6, ver o topo do módulo): com as linhas de `saldos_estoque` travadas, `prepararLotes` confere os lotes
 * informados, divide em FEFO as saídas sem lote e trava as linhas de `saldos_lote`; cada movimento com lote soma na
 * linha do lote, gravada num `UPDATE` no fim.
 */
export async function lancarDocumento(
  tx: DbEmpresa,
  linhas: readonly NovoMovimento[],
  opcoes: { porComando?: number } & OpcoesLancamento = {},
): Promise<ResultadoDocumento> {
  conferirDataMovimentos(linhas, opcoes);
  const porComando = opcoes.porComando ?? LINHAS_POR_COMANDO;
  const somadas = somarLinhasIguais(linhas.map(normalizarIds));
  const grupos = new Map<string, NovoMovimento[]>();
  for (const l of somadas) {
    const k = chaveTexto(l);
    const g = grupos.get(k);
    if (g) g.push(l);
    else grupos.set(k, [l]);
  }
  const chaves = ordenarChaves([...grupos.values()].map((g) => g[0]!));
  const saldos = await travarSaldos(tx, chaves, porComando);
  const lotes = await prepararLotes(tx, chaves, grupos, porComando);
  const porChave: MovimentoCalculado[][] = [];
  const negativos: SaldoNegativo[] = [];
  chaves.forEach((chave, i) => {
    const saldo = saldos[i]!;
    porChave.push(
      grupos.get(chaveTexto(chave))!.map((l) => {
        const c = calcularMovimento(saldo, l);
        if (l.loteId) {
          const lote = lotes.get(chaveLoteTexto(l))!;
          lote.quantidade = decTexto(dec(lote.quantidade).plus(c.quantidade), 3);
        }
        return c;
      }),
    );
    if (dec(saldo.quantidade).lt(0)) {
      negativos.push({
        estoqueId: saldo.estoqueId,
        produtoId: saldo.produtoId,
        variacaoId: saldo.variacaoId,
        tipoEstoqueId: saldo.tipoEstoqueId,
        saldoPosterior: saldo.quantidade,
      });
    }
  });
  const calculados = porChave.flat();
  // Um INSERT e um UPDATE para o documento todo (por bloco): a 7300001 fica presa o mínimo (SYNC 8.3).
  await inserirMovimentos(tx, calculados, porComando);
  await atualizarSaldos(tx, porChave, porComando);
  if (lotes.size) await atualizarSaldosLote(tx, [...lotes.values()], porComando);
  const custoPorItem = new Map<string, string>();
  for (const c of calculados) {
    if (c.m.documentoItemId === null) continue;
    const ant = custoPorItem.get(c.m.documentoItemId) ?? '0';
    custoPorItem.set(c.m.documentoItemId, decTexto(dec(ant).plus(c.custoTotal), 2));
  }
  return { movimentos: calculados.map((c) => ({ ...aplicado(c), linha: c.m })), custoPorItem, negativos };
}

/** A saída que a divisão FEFO pode dividir: sem lote, nem estorno, nem compensação (essas herdam o lote do fato). */
const saidaSemLote = (l: NovoMovimento) =>
  !l.loteId && !l.estornoDeId && !l.compensaMovimentoId && dec(decTexto(l.quantidade, 3)).lt(0);

/**
 * O lote do documento (F2-B6), com as linhas de `saldos_estoque` de `chaves` já travadas (o que deixa estáveis as de
 * `saldos_lote` delas): confere os lotes informados (`conferirLotes`), divide em FEFO as saídas sem lote das linhas que
 * têm saldo de lote (`dividirFefo`; troca as linhas do grupo em `grupos`) e trava as linhas de `saldos_lote` que o
 * documento vai mexer, criando as que faltam, em `ordenarChaves`. Devolve chave + lote → linha travada.
 */
async function prepararLotes(
  tx: DbEmpresa,
  chaves: readonly ChaveSaldo[],
  grupos: Map<string, NovoMovimento[]>,
  porComando: number,
): Promise<Map<string, SaldoLoteTravado>> {
  await conferirLotes(tx, grupos);
  await dividirFefo(tx, chaves, grupos, porComando);
  const porLote = new Map<string, ChaveSaldo>();
  for (const g of grupos.values()) {
    for (const l of g) if (l.loteId && !porLote.has(chaveLoteTexto(l))) porLote.set(chaveLoteTexto(l), l);
  }
  const travadas = new Map<string, SaldoLoteTravado>();
  const lista = ordenarChaves([...porLote.values()]);
  for (const bloco of emBlocos(lista, porComando)) {
    const valores = (comOrdem: boolean) =>
      sql.join(
        bloco.map(
          (c, i) =>
            sql`(${comOrdem ? sql`${i}::int, ` : sql``}${c.estoqueId}::uuid, ${c.produtoId}::uuid, ${c.variacaoId}::uuid,
                 ${c.loteId}::uuid, ${c.tipoEstoqueId}::uuid)`,
        ),
        sql`, `,
      );
    await tx.execute(sql`
      insert into saldos_lote (id, estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id)
      select fn_uuid_v7(), v.* from (values ${valores(false)})
        as v(estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id)
      on conflict (estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id) do nothing`);
    const { rows } = await tx.execute<{ ordem: number; id: string; quantidade: string }>(sql`
      select v.ordem, s.id, s.quantidade::text
        from saldos_lote s
        join (values ${valores(true)}) as v(ordem, estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id)
          on s.estoque_id = v.estoque_id and s.produto_id = v.produto_id
         and s.variacao_id is not distinct from v.variacao_id and s.lote_id = v.lote_id
         and s.tipo_estoque_id = v.tipo_estoque_id
       order by v.ordem
         for update of s`);
    if (rows.length !== bloco.length)
      throw new Error('Linha de saldo do lote não encontrada depois de criada');
    for (const r of rows) {
      travadas.set(chaveLoteTexto(bloco[Number(r.ordem)]!), { id: r.id, quantidade: r.quantidade });
    }
  }
  return travadas;
}

/**
 * Os lotes informados são do produto, da variação e do estoque da linha (ou sem estoque; MD 3.6.9). O do ERP recusa o
 * documento (`ErroLoteInvalido`); a linha do PDV (com `evento_id`, fora estorno e compensação) segue sem o lote — a
 * nuvem não recusa a venda (SYNC 15.1) — e, se for saída, entra na divisão FEFO. Lote excluído logicamente continua
 * valendo: o saldo dele ainda existe e o estorno tem de voltar a ele.
 */
async function conferirLotes(tx: DbEmpresa, grupos: Map<string, NovoMovimento[]>): Promise<void> {
  const ids = new Set<string>();
  for (const g of grupos.values()) for (const l of g) if (l.loteId) ids.add(l.loteId);
  if (!ids.size) return;
  const { rows } = await tx.execute<{
    id: string;
    produto_id: string;
    variacao_id: string | null;
    estoque_id: string | null;
  }>(sql`
    select id, produto_id, variacao_id, estoque_id from produtos_lotes where id = any(${uuids(ids)}::uuid[])`);
  const lotes = new Map(rows.map((r) => [r.id, r]));
  for (const [k, g] of grupos) {
    let mudou = false;
    for (const l of g) {
      if (!l.loteId) continue;
      const lote = lotes.get(l.loteId);
      const valido =
        lote !== undefined &&
        lote.produto_id === l.produtoId &&
        lote.variacao_id === l.variacaoId &&
        (lote.estoque_id === null || lote.estoque_id === l.estoqueId);
      if (valido) continue;
      if (!l.eventoId || l.estornoDeId || l.compensaMovimentoId)
        throw new ErroLoteInvalido(l.loteId, l.produtoId);
      l.loteId = null;
      mudou = true;
    }
    // Sem o lote, duas linhas do mesmo item podem ter virado a mesma chave de idempotência.
    if (mudou) grupos.set(k, somarLinhasIguais(g));
  }
}

/**
 * A divisão FEFO (F2-Q7 (a), `estoque.lote_baixa_sem_informar` = 'fefo'): nas linhas de saldo com saída sem lote
 * (`saidaSemLote`) e com lote de saldo positivo, cada uma dessas saídas vira uma linha por lote (`dividirSaidaFefo`),
 * consumindo o saldo corrente dos lotes, e a sobra fica sem lote. O saldo corrente parte do gravado com **todas** as
 * linhas com lote informado da mesma linha de saldo já aplicadas, em qualquer posição do documento (a quantidade com
 * lote é reservada antes): seguir a ordem do documento deixava a saída sem lote que vem antes consumir o lote que a
 * linha seguinte pediu, e o lote terminava negativo com o outro ainda com saldo. As saídas sem lote dividem entre si na
 * ordem do documento. A chave só é lida quando há lote com saldo: a venda de produto sem lote paga uma consulta
 * indexada, nada mais.
 */
async function dividirFefo(
  tx: DbEmpresa,
  chaves: readonly ChaveSaldo[],
  grupos: Map<string, NovoMovimento[]>,
  porComando: number,
): Promise<void> {
  const candidatas = chaves.filter((c) => grupos.get(chaveTexto(c))!.some(saidaSemLote));
  if (!candidatas.length) return;
  const disponiveis = new Map<string, LoteDisponivel[]>();
  for (const bloco of emBlocos(candidatas, porComando)) {
    const { rows } = await tx.execute<{
      ordem: number;
      lote_id: string;
      quantidade: string;
      validade: string | null;
    }>(sql`
      select v.ordem, l.lote_id, l.quantidade::text, pl.validade::text
        from (values ${sql.join(
          bloco.map(
            (c, i) =>
              sql`(${i}::int, ${c.estoqueId}::uuid, ${c.produtoId}::uuid, ${c.variacaoId}::uuid, ${c.tipoEstoqueId}::uuid)`,
          ),
          sql`, `,
        )}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id)
        join saldos_lote l on l.estoque_id = v.estoque_id and l.produto_id = v.produto_id
                          and l.variacao_id is not distinct from v.variacao_id
                          and l.tipo_estoque_id = v.tipo_estoque_id and l.quantidade > 0
        join produtos_lotes pl on pl.id = l.lote_id`);
    for (const r of rows) {
      const k = chaveTexto(bloco[Number(r.ordem)]!);
      const lista = disponiveis.get(k) ?? [];
      lista.push({ loteId: r.lote_id, validade: r.validade, disponivel: r.quantidade });
      disponiveis.set(k, lista);
    }
  }
  if (!disponiveis.size) return;
  const modo = await lerConfiguracao<ModoLoteBaixaSemInformar>(tx, CHAVE_LOTE_BAIXA_SEM_INFORMAR);
  if (modo !== 'fefo') return;
  for (const [k, lotesDaLinha] of disponiveis) {
    const corrente = new Map(lotesDaLinha.map((l) => [l.loteId, dec(l.disponivel)]));
    const grupo = grupos.get(k)!;
    for (const l of grupo) {
      const atual = l.loteId ? corrente.get(l.loteId) : undefined;
      if (atual) corrente.set(l.loteId!, atual.plus(decTexto(l.quantidade, 3)));
    }
    const divididas: NovoMovimento[] = [];
    for (const l of grupo) {
      if (l.loteId || !saidaSemLote(l)) {
        divididas.push(l);
        continue;
      }
      const partes = dividirSaidaFefo(
        l.quantidade,
        lotesDaLinha.map((x) => ({ ...x, disponivel: corrente.get(x.loteId)!.toFixed(3) })),
      );
      for (const p of partes) {
        divididas.push({ ...l, loteId: p.loteId, quantidade: p.quantidade });
        if (p.loteId) corrente.set(p.loteId, corrente.get(p.loteId)!.plus(p.quantidade));
      }
    }
    // A parte de um lote pode cair na mesma chave de idempotência de uma linha do mesmo item com esse lote.
    grupos.set(k, somarLinhasIguais(divididas));
  }
}

/**
 * `travarSaldo` de várias linhas com dois comandos por bloco de `porComando`: cria as que faltam (na ordem das chaves)
 * e trava todas com um `select … for update` ordenado pela posição na lista, que trava as linhas nessa ordem (o
 * `LockRows` fica acima do `Sort`); os blocos vão em sequência, então a ordem total continua a de `chaves`, que já vem
 * de `ordenarChaves`. Devolve nessa ordem. Duas chaves para a mesma linha de saldo são recusadas: o `UPDATE … from
 * (values …)` aplicaria só uma das contas, sem dizer qual.
 */
async function travarSaldos(
  tx: DbEmpresa,
  chaves: readonly ChaveSaldo[],
  porComando = LINHAS_POR_COMANDO,
): Promise<SaldoTravado[]> {
  const saldos: SaldoTravado[] = [];
  for (const bloco of emBlocos(chaves, porComando)) saldos.push(...(await travarBlocoSaldos(tx, bloco)));
  if (new Set(saldos.map((s) => s.id)).size !== saldos.length) {
    throw new Error('Duas chaves do documento para a mesma linha de saldo');
  }
  return saldos;
}

async function travarBlocoSaldos(tx: DbEmpresa, chaves: readonly ChaveSaldo[]): Promise<SaldoTravado[]> {
  await tx.execute(sql`
    insert into saldos_estoque (id, estoque_id, produto_id, variacao_id, tipo_estoque_id)
    values ${sql.join(
      chaves.map(
        (c) =>
          sql`(${uuidv7()}, ${c.estoqueId}::uuid, ${c.produtoId}::uuid, ${c.variacaoId}::uuid, ${c.tipoEstoqueId}::uuid)`,
      ),
      sql`, `,
    )}
    on conflict (estoque_id, produto_id, variacao_id, tipo_estoque_id) do nothing`);
  const { rows } = await tx.execute<{
    ordem: number;
    id: string;
    quantidade: string;
    custo_medio: string;
  }>(sql`
    select v.ordem, s.id, s.quantidade::text, s.custo_medio::text
      from saldos_estoque s
      join (values ${sql.join(
        chaves.map(
          (c, i) =>
            sql`(${i}::int, ${c.estoqueId}::uuid, ${c.produtoId}::uuid, ${c.variacaoId}::uuid, ${c.tipoEstoqueId}::uuid)`,
        ),
        sql`, `,
      )}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id)
        on s.estoque_id = v.estoque_id and s.produto_id = v.produto_id
       and s.variacao_id is not distinct from v.variacao_id and s.tipo_estoque_id = v.tipo_estoque_id
     order by v.ordem
       for update of s`);
  if (rows.length !== chaves.length) throw new Error('Linha de saldo não encontrada depois de criada');
  return rows.map((r) => {
    const c = chaves[Number(r.ordem)]!;
    return {
      estoqueId: c.estoqueId,
      produtoId: c.produtoId,
      variacaoId: c.variacaoId,
      tipoEstoqueId: c.tipoEstoqueId,
      id: r.id,
      quantidade: r.quantidade,
      custoMedio: r.custo_medio,
    };
  });
}

export interface CadastroProdutoEstoque {
  id: string;
  nome: string;
  tipo: string;
  /** Valor **atual** da nuvem (SYNC 10.2 "Quem baixa"), não o do PDV. */
  controlaEstoque: boolean;
  /** Custo de referência da saída quando a linha de saldo ainda não tem custo médio. */
  precoCusto: string;
  /** Sigla da unidade base (`unidade_documento` sem código de barras). */
  sigla: string;
  excluido: boolean;
  /**
   * Instante (ms) a partir do qual o produto com certeza já estava excluído ou inativo (SYNC 16.2, alerta
   * `PRODUTO_INATIVO_VENDIDO`): `excluido_em`; no inativo sem exclusão, `atualizado_em` (a inativação foi no máximo
   * aí, e nada mudou depois). Nulo = ativo.
   */
  inativoDesde: number | null;
}

export interface CadastroCodigoBarras {
  id: string;
  produtoId: string;
  fator: string;
  /** Sigla da unidade da embalagem; nula = a do produto. */
  sigla: string | null;
}

export interface CadastrosEstoque {
  produtos: Map<string, CadastroProdutoEstoque>;
  codigosBarras: Map<string, CadastroCodigoBarras>;
  /** Dos estoques pedidos, os que existem, ativos e não excluídos (SYNC 10.2: `contexto.estoque_id` válido). */
  estoquesValidos: Set<string>;
  /** `tipos_estoque` com `padrao` (Disponível) e o de sistema `vasilhame_vazio`; nulo se a empresa não tem. */
  tipoEstoquePadraoId: string | null;
  tipoEstoqueVasilhameVazioId: string | null;
}

const uuids = (ids: Iterable<string>) => `{${[...new Set(ids)].join(',')}}`;

/**
 * Cadastros que o documento do PDV lê, numa leitura só e **sem trava** (Fase 1C, bloco C6a; crítica da 1C, item 6):
 * o handler chama isto no `preparar`, antes da `fn_trava_versao()`, e a transação só segura a 7300001 enquanto grava.
 * Em READ COMMITTED a leitura vê o que estava confirmado naquele instante; um cadastro alterado pelo ERP entre ela e a
 * trava vale para o próximo evento, como se este tivesse sido aplicado antes da alteração. Produto excluído também
 * vem (SYNC 10.2: referências existem "mesmo excluídas"; a venda offline já aconteceu).
 */
export async function lerCadastrosEstoque(
  tx: DbEmpresa,
  pedido: {
    produtoIds: Iterable<string>;
    codigoBarrasIds?: Iterable<string>;
    estoqueIds?: Iterable<string>;
  },
): Promise<CadastrosEstoque> {
  const produtoIds = uuids(pedido.produtoIds);
  const codigoIds = uuids(pedido.codigoBarrasIds ?? []);
  const estoqueIds = uuids(pedido.estoqueIds ?? []);
  const { rows: produtos } = await tx.execute<{
    id: string;
    nome: string;
    tipo: string;
    controla_estoque: boolean;
    preco_custo: string;
    sigla: string;
    excluido: boolean;
    inativo_desde: number | null;
  }>(sql`
    select p.id, p.nome, p.tipo, p.controla_estoque, p.preco_custo::text, u.sigla, p.excluido_em is not null as excluido,
           (extract(epoch from coalesce(p.excluido_em, case when not p.ativo then p.atualizado_em end))
             * 1000)::float8 as inativo_desde
      from produtos p join unidades_medida u on u.id = p.unidade_id
     where p.id = any(${produtoIds}::uuid[])`);
  const { rows: codigos } = await tx.execute<{
    id: string;
    produto_id: string;
    fator: string;
    sigla: string | null;
  }>(sql`
    select cb.id, cb.produto_id, cb.fator::text, u.sigla
      from produtos_codigos_barras cb left join unidades_medida u on u.id = cb.unidade_id
     where cb.id = any(${codigoIds}::uuid[])`);
  const { rows: estoques } = await tx.execute<{ id: string }>(sql`
    select id from estoques where id = any(${estoqueIds}::uuid[]) and ativo and excluido_em is null`);
  const { rows: tipos } = await tx.execute<{ id: string; padrao: boolean; chave_sistema: string | null }>(sql`
    select id, padrao, chave_sistema from tipos_estoque
     where excluido_em is null and ativo and (padrao or chave_sistema = 'vasilhame_vazio')`);
  return {
    produtos: new Map(
      produtos.map((p) => [
        p.id,
        {
          id: p.id,
          nome: p.nome,
          tipo: p.tipo,
          controlaEstoque: p.controla_estoque,
          precoCusto: p.preco_custo,
          sigla: p.sigla,
          excluido: p.excluido,
          inativoDesde: p.inativo_desde === null ? null : Number(p.inativo_desde),
        },
      ]),
    ),
    codigosBarras: new Map(
      codigos.map((c) => [c.id, { id: c.id, produtoId: c.produto_id, fator: c.fator, sigla: c.sigla }]),
    ),
    estoquesValidos: new Set(estoques.map((e) => e.id)),
    tipoEstoquePadraoId: tipos.find((t) => t.padrao)?.id ?? null,
    tipoEstoqueVasilhameVazioId: tipos.find((t) => t.chave_sistema === 'vasilhame_vazio')?.id ?? null,
  };
}
