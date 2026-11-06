/**
 * Passos de dados dos bancos de empresa que rodam fora da transação, antes da migração da tag (`PreparacaoMigracao`
 * em `executor.ts`). O `MigradorEmpresas` sempre os passa; quem aplica o journal à mão num banco com dados também
 * precisa passar (ou rodar o comando correspondente antes).
 */
import { ALERTA_RAZAO_CADEIA_QUEBRADA } from '@genesis/shared';
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

export const PREPARACOES_MIGRACAO_EMPRESA: Readonly<Record<string, PreparacaoMigracao>> = {
  // F2-B2 (decisão 146 do README): ordem dos movimentos antigos e o índice da linha, antes do NOT NULL da etapa B.
  '0017_movimentos_seq_b': async (cliente) => relatoSeqLancamento(await preencherSeqLancamento(cliente)),
};
