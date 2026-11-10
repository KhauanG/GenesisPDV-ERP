/**
 * Passos de dados dos bancos de empresa que rodam fora da transação, antes da migração da tag (`PreparacaoMigracao`
 * em `executor.ts`). O `MigradorEmpresas` sempre os passa; quem aplica o journal à mão num banco com dados também
 * precisa passar (ou rodar o comando correspondente antes).
 */
import { ALERTA_RAZAO_CADEIA_QUEBRADA } from '@genesis/shared';
import { garantirIndicesRazao, type IndiceGarantido } from '../../estoques/indices-razao.js';
import { preencherSeqLancamento, type RelatorioSeqLancamento } from '../../estoques/seq-lancamento.js';
import type { PreparacaoMigracao, RelatoPreparacao } from './executor.js';

/** Quebras que vão inteiras para a auditoria (o resto fica no total; a lista completa sai do comando com `--saida`). */
const QUEBRAS_NO_REGISTRO = 200;

/**
 * O relatório do preenchimento para quem migra (decisão 146): um aviso quando há linha com a cadeia quebrada, porque
 * a segunda passada não acha mais nada a preencher e o relatório não se repete; os dados vão para a auditoria. Sem
 * movimento a preencher (banco novo do provisionamento, ou a repetição depois de uma falha da 0017) não há relato.
 */
export function relatoSeqLancamento(r: RelatorioSeqLancamento): RelatoPreparacao | undefined {
  if (r.linhas === 0) return undefined;
  return {
    avisos: r.quebras.length
      ? [
          `${r.quebras.length} linha(s) de saldo com a cadeia do razão quebrada (alerta ${ALERTA_RAZAO_CADEIA_QUEBRADA} ` +
            'aberto em cada uma; lista: db:preencher-seq-lancamento --saida=quebras.csv)',
        ]
      : [],
    dados: {
      linhas: r.linhas,
      preenchidos: r.preenchidos,
      indice: r.indice,
      total_quebras: r.quebras.length,
      quebras: r.quebras.slice(0, QUEBRAS_NO_REGISTRO).map((q) => ({
        estoque_id: q.estoqueId,
        produto_id: q.produtoId,
        variacao_id: q.variacaoId,
        tipo_estoque_id: q.tipoEstoqueId,
        movimentos: q.movimentos,
        posicao: q.posicao,
        movimento_id: q.movimentoId,
        saldo_esperado: q.saldoEsperado,
        saldo_anterior: q.saldoAnterior,
        origem: q.origem,
      })),
    },
  };
}

/**
 * O relato dos índices do razão (decisão 176): só quando um foi criado ou refeito numa empresa que já tem movimentos
 * (no banco novo do provisionamento a tabela está vazia e não há o que contar), com quanto tempo levou.
 */
export function relatoIndicesRazao(
  indices: IndiceGarantido[],
  comMovimentos: boolean,
): RelatoPreparacao | undefined {
  const feitos = indices.filter((i) => i.situacao !== 'existente');
  if (!feitos.length || !comMovimentos) return undefined;
  return {
    avisos: [],
    dados: {
      indices: feitos.map((i) => ({ nome: i.nome, situacao: i.situacao, duracao_ms: i.duracaoMs })),
    },
  };
}

export const PREPARACOES_MIGRACAO_EMPRESA: Readonly<Record<string, PreparacaoMigracao>> = {
  // F2-B2 (decisão 146 do README): ordem dos movimentos antigos e o índice da linha, antes do NOT NULL da etapa B.
  '0017_movimentos_seq_b': async (cliente) => relatoSeqLancamento(await preencherSeqLancamento(cliente)),
  // F2-B28 (decisão 176): o índice da Movimentação com `concurrently`, sem travar as vendas da empresa existente.
  '0026_indices_razao': async (cliente) => {
    const indices = await garantirIndicesRazao(cliente);
    const { rows } = await cliente.query<{ ha: boolean }>(
      'select exists (select 1 from movimentos_estoque) as ha',
    );
    return relatoIndicesRazao(indices, rows[0]?.ha ?? false);
  },
};
