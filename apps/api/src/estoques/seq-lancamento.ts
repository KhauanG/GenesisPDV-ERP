/**
 * Preenchimento da ordem de lançamento dos movimentos antigos (Fase 2, F2-B2; README da API › decisão 146). A migração
 * `0016_movimentos_seq_a` cria `seq_lancamento` vazia, com o `nextval` só para as linhas novas; isto dá a ordem às que
 * já existiam, encadeando-as pelo saldo (`ordenarCadeia`), e cria o índice da linha sem trava de escrita. Roda **fora
 * da transação da migração**: pelo executor, logo antes da `0017_movimentos_seq_b` (`PREPARACOES_MIGRACAO_EMPRESA`), e
 * à mão pelo `db:preencher-seq-lancamento`. É idempotente: a segunda passada não acha nada para preencher.
 *
 * Cada linha de saldo é uma transação curta, sem a trava 7300001 nem `versao` nova (`seq_lancamento` é isenta no
 * `fn_versao_local` e só pode passar de nula a preenchida, migração 0016): as vendas do PDV seguem gravando. Os
 * movimentos antigos recebem 1…N por linha, sempre abaixo do início da sequência (10¹²), então ficam antes dos que
 * entraram depois da 0016. Uma quebra de cadeia não aborta: a linha fica na ordem (`criado_em`, `id`) — ou na da
 * cadeia, se a quebra está só na emenda com os lançados depois da 0016 (`origem`) —, entra no relatório e abre o
 * alerta `RAZAO_CADEIA_QUEBRADA` (quem corrige o saldo é o `db:recalcular-saldos`, F2-B3). Pelo executor, o relatório
 * vira o aviso e o registro da migração (`relatoSeqLancamento`, `preparacoes-empresa.ts`).
 */
import { createHash } from 'node:crypto';
import { ALERTA_RAZAO_CADEIA_QUEBRADA } from '@genesis/shared';
import {
  ordenarCadeia,
  primeiraQuebra,
  type ConexaoSql,
  type EloCadeia,
  type QuebraCadeia,
} from './cadeia.js';
import type { ChaveSaldo } from './movimentos.js';

/** Início de `seq_movimentos_estoque` (0016): os movimentos antigos ficam abaixo, numerados por linha. */
export const INICIO_SEQ_LANCAMENTO = 1_000_000_000_000;
export const INDICE_LINHA_SEQ = 'ix_movimentos_estoque_linha_seq';
/** Movimentos por `UPDATE` (o protocolo aceita até 65535 parâmetros; dois por movimento). */
const POR_COMANDO = 1000;

export interface QuebraLinha extends ChaveSaldo, QuebraCadeia {
  /** Movimentos da linha (os preenchidos agora e os que já tinham ordem); a `posicao` é a da ordem final da linha. */
  movimentos: number;
  /**
   * `antigos`: os movimentos sem ordem não se encadeiam pelo saldo e ficaram na ordem de gravação (`criado_em`, `id`).
   * `emenda`: os antigos se encadearam (e ficaram nessa ordem), mas um lançado depois da 0016 não parte do saldo do
   * anterior — o saldo da linha já não era o do fim do razão quando ele entrou.
   */
  origem: 'antigos' | 'emenda';
}

export interface RelatorioSeqLancamento {
  /** Linhas de saldo que tinham movimento sem ordem. */
  linhas: number;
  /** Movimentos que receberam `seq_lancamento` nesta passada. */
  preenchidos: number;
  quebras: QuebraLinha[];
  indice: 'existente' | 'criado' | 'recriado';
}

interface LinhaMovimento {
  id: string;
  saldo_anterior: string;
  saldo_posterior: string;
  seq_lancamento: string | null;
}

/**
 * Preenche `seq_lancamento` de todos os movimentos que ainda não têm, linha a linha, e garante o
 * `ix_movimentos_estoque_linha_seq` (`create index concurrently`). Precisa da 0016 aplicada e de uma conexão fora de
 * transação, com a role dona (o índice).
 */
export async function preencherSeqLancamento(cliente: ConexaoSql): Promise<RelatorioSeqLancamento> {
  // Uma passada por banco de cada vez (o comando à mão e o executor ao mesmo tempo dariam a mesma ordem, mas em dobro).
  await cliente.query("select pg_advisory_lock(hashtext('genesis:seq_lancamento'))");
  try {
    return await preencherTudo(cliente);
  } finally {
    await cliente
      .query("select pg_advisory_unlock(hashtext('genesis:seq_lancamento'))")
      .catch(() => undefined);
  }
}

async function preencherTudo(cliente: ConexaoSql): Promise<RelatorioSeqLancamento> {
  const { rows: linhas } = await cliente.query<{
    estoque_id: string;
    produto_id: string;
    variacao_id: string | null;
    tipo_estoque_id: string;
  }>(
    `select distinct estoque_id, produto_id, variacao_id, tipo_estoque_id
       from movimentos_estoque where seq_lancamento is null
      order by estoque_id, produto_id, variacao_id, tipo_estoque_id`,
  );
  const relatorio: RelatorioSeqLancamento = {
    linhas: linhas.length,
    preenchidos: 0,
    quebras: [],
    indice: 'existente',
  };
  for (const l of linhas) {
    const chave: ChaveSaldo = {
      estoqueId: l.estoque_id,
      produtoId: l.produto_id,
      variacaoId: l.variacao_id,
      tipoEstoqueId: l.tipo_estoque_id,
    };
    const r = await preencherLinha(cliente, chave);
    relatorio.preenchidos += r.preenchidos;
    if (r.quebra) relatorio.quebras.push(r.quebra);
  }
  relatorio.indice = await garantirIndiceLinhaSeq(cliente);
  return relatorio;
}

async function preencherLinha(
  cliente: ConexaoSql,
  chave: ChaveSaldo,
): Promise<{ preenchidos: number; quebra: QuebraLinha | null }> {
  await cliente.query('begin');
  try {
    // A ordem da consulta é a de reserva (criado_em, id); os já numerados (depois da 0016) vêm à parte, pela ordem deles.
    const { rows } = await cliente.query<LinhaMovimento>(
      `select id, saldo_anterior::text, saldo_posterior::text, seq_lancamento::text
         from movimentos_estoque
        where estoque_id = $1 and produto_id = $2 and variacao_id is not distinct from $3 and tipo_estoque_id = $4
        order by seq_lancamento nulls first, criado_em, id`,
      [chave.estoqueId, chave.produtoId, chave.variacaoId, chave.tipoEstoqueId],
    );
    const elo = (r: LinhaMovimento): EloCadeia => ({
      id: r.id,
      saldoAnterior: r.saldo_anterior,
      saldoPosterior: r.saldo_posterior,
    });
    const semOrdem = rows.filter((r) => r.seq_lancamento === null).map(elo);
    const numerados = rows.filter((r) => r.seq_lancamento !== null).map(elo);
    const { ordem, quebra: quebraAntigos } = ordenarCadeia(semOrdem);
    if (ordem.length >= INICIO_SEQ_LANCAMENTO) throw new Error('Linha de saldo com movimentos demais');
    for (let i = 0; i < ordem.length; i += POR_COMANDO) {
      const bloco = ordem.slice(i, i + POR_COMANDO);
      const valores = bloco.map((_, j) => `($${2 * j + 1}::uuid, $${2 * j + 2}::bigint)`).join(', ');
      await cliente.query(
        `update movimentos_estoque m set seq_lancamento = v.seq
           from (values ${valores}) as v(id, seq)
          where m.id = v.id and m.seq_lancamento is null`,
        bloco.flatMap((e, j) => [e.id, i + j + 1]),
      );
    }
    // A emenda com os movimentos que já entraram com a sequência também precisa fechar. Nos dois casos a posição é a
    // da ordem final da linha (os antigos, de 1 a N, vêm antes dos numerados).
    const q = quebraAntigos ?? primeiraQuebra([...ordem, ...numerados]);
    const quebra: QuebraLinha | null = q
      ? { ...chave, ...q, movimentos: rows.length, origem: quebraAntigos ? 'antigos' : 'emenda' }
      : null;
    if (quebra) await alertarQuebra(cliente, quebra);
    await cliente.query('commit');
    return { preenchidos: ordem.length, quebra };
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
}

/** O texto do alerta, conforme a quebra esteja entre os movimentos antigos ou na emenda com os lançados depois. */
export function mensagemQuebra(q: QuebraLinha): string {
  const n = (v: string) => Number(v).toLocaleString('pt-BR');
  const inicio = `O movimento ${q.posicao} de ${q.movimentos} desta linha de saldo`;
  const saldos = `começa em ${n(q.saldoAnterior)}, mas o anterior terminou em ${n(q.saldoEsperado)}`;
  return q.origem === 'antigos'
    ? `${inicio} ${saldos}. Os movimentos antigos não se encadeiam pelo saldo e ficaram na ordem de gravação; confira o saldo pelo recálculo do razão.`
    : `${inicio}, lançado depois da migração da ordem, ${saldos}. Os movimentos antigos se encadearam e ficaram nessa ordem; o saldo da linha já não era o do fim do razão quando este entrou. Confira o saldo pelo recálculo do razão.`;
}

/** Um alerta aberto por linha de saldo (`chave_deduplicacao` com o hash da linha: as 4 chaves não cabem em 150). */
async function alertarQuebra(cliente: ConexaoSql, q: QuebraLinha): Promise<void> {
  const linha = `${q.estoqueId}:${q.produtoId}:${q.variacaoId ?? ''}:${q.tipoEstoqueId}`;
  const chave = `razao_cadeia:${createHash('sha256').update(linha).digest('hex').slice(0, 40)}`;
  await cliente.query(
    `insert into alertas (tipo, severidade, titulo, mensagem, loja_id, entidade, registro_id, dados, chave_deduplicacao)
     select $1, 'aviso', left('Razão de estoque com a cadeia quebrada: ' || p.nome, 150), $2,
            (select l.id from lojas l where l.estoque_id = $3::uuid and l.excluido_em is null limit 1),
            'produtos', p.id, $4::jsonb, $5
       from produtos p where p.id = $6::uuid
     on conflict do nothing`,
    [
      ALERTA_RAZAO_CADEIA_QUEBRADA,
      mensagemQuebra(q),
      q.estoqueId,
      JSON.stringify({
        estoque_id: q.estoqueId,
        produto_id: q.produtoId,
        variacao_id: q.variacaoId,
        tipo_estoque_id: q.tipoEstoqueId,
        movimento_id: q.movimentoId,
        posicao: q.posicao,
        movimentos: q.movimentos,
        saldo_esperado: q.saldoEsperado,
        saldo_anterior: q.saldoAnterior,
        origem: q.origem,
      }),
      chave,
      q.produtoId,
    ],
  );
}

/**
 * `ix_movimentos_estoque_linha_seq` sem bloquear as gravações (`concurrently`, fora de transação). Um `concurrently`
 * interrompido deixa o índice inválido com o mesmo nome (e o `if not exists` da 0017 o aceitaria): é recriado.
 */
export async function garantirIndiceLinhaSeq(
  cliente: ConexaoSql,
): Promise<'existente' | 'criado' | 'recriado'> {
  const { rows } = await cliente.query<{ valido: boolean }>(
    `select i.indisvalid as valido from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = $1 and c.relnamespace = 'public'::regnamespace`,
    [INDICE_LINHA_SEQ],
  );
  if (rows[0]?.valido) return 'existente';
  if (rows[0]) await cliente.query(`drop index concurrently if exists ${INDICE_LINHA_SEQ}`);
  await cliente.query(
    `create index concurrently if not exists ${INDICE_LINHA_SEQ}
       on movimentos_estoque (estoque_id, produto_id, variacao_id, tipo_estoque_id, seq_lancamento)`,
  );
  return rows[0] ? 'recriado' : 'criado';
}

/** A 0016 já foi aplicada neste banco (a coluna existe)? */
export async function temSeqLancamento(cliente: ConexaoSql): Promise<boolean> {
  const { rows } = await cliente.query<{ ok: boolean }>(
    `select exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'movimentos_estoque'
                       and column_name = 'seq_lancamento') as ok`,
  );
  return rows[0]?.ok ?? false;
}
