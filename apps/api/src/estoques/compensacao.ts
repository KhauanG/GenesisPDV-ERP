/**
 * Compensação dos movimentos tardios contra o acerto "Definir" (ERP 13.1.5 regra 3; SYNC 15.3; T23), no motor do
 * estoque (Fase 2, F2-B4; README da API › decisão 148). Até a 1C ficava no handler da venda; agora todo documento que
 * lança movimento usa a mesma função: a venda, o cancelamento e a devolução de cascos do PDV, o próprio acerto (o
 * "Definir" com contagem anterior a outro já efetivado, e a Entrada/Saída lançada antes de um "Definir" com a hora da
 * contagem um pouco à frente) e os documentos do ERP da Fase 2 (recebimento, NF-e, transferência).
 *
 * Os documentos do ERP lançam em `now()` (regra de data, `conferirDataMovimentos` em `movimentos.ts`): depois da
 * efetivação de um "Definir", eles só caem antes da contagem dele quando a contagem foi informada no futuro (a folga
 * de 5 min do `criarAcertoSchema`). O que lança no passado é o PDV (a hora do fato) e o "Definir"/AJUSTE_IMPORTACAO
 * (a hora da contagem, com `retroativoPermitido`): para esses a compensação é o que mantém valendo a contagem já
 * efetivada. O estorno do "Definir" (`estornarAcerto`) compensa de novo, contra o "Definir" efetivado anterior, o fato
 * que os dois contaram (`fatosCompensados`, `lancarCompensacoes`; migração 0018: uma compensação por "Definir").
 */
import { dec, decTexto } from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { lancarDocumento, type MovimentoDoDocumento, type NovoMovimento } from './movimentos.js';

/** O "Definir" efetivado que já contou o movimento tardio (ERP 13.1.5 regra 3): o último da linha depois do fato. */
export interface DefinirPosterior {
  acertoId: string;
  codigo: number;
  itemId: string;
}

/** Até quantos movimentos por consulta das compensações (6 parâmetros cada; ver `LINHAS_POR_COMANDO`). */
const MOVIMENTOS_POR_CONSULTA = 1000;

/**
 * Para cada movimento (pela posição na lista), o último "Definir" efetivado da linha com contagem posterior a ele.
 * `excetoAcertoId`: o "Definir" em estorno, que ainda está `efetivado` na transação e não pode ser o escolhido.
 */
export async function definirPosteriores(
  tx: DbEmpresa,
  movimentos: readonly MovimentoDoDocumento[],
  opcoes: { excetoAcertoId?: string } = {},
): Promise<Map<number, DefinirPosterior>> {
  const achados = new Map<number, DefinirPosterior>();
  const exceto = opcoes.excetoAcertoId ? sql`and ac.id <> ${opcoes.excetoAcertoId}::uuid` : sql``;
  for (let inicio = 0; inicio < movimentos.length; inicio += MOVIMENTOS_POR_CONSULTA) {
    const bloco = movimentos.slice(inicio, inicio + MOVIMENTOS_POR_CONSULTA);
    const { rows } = await tx.execute<{
      ordem: number;
      acerto_id: string;
      codigo: number;
      item_id: string;
    }>(sql`
      select v.ordem, a.acerto_id, a.codigo, a.item_id
        from (values ${sql.join(
          bloco.map(
            (m, i) =>
              sql`(${inicio + i}::int, ${m.linha.estoqueId}::uuid, ${m.linha.produtoId}::uuid,
                   ${m.linha.variacaoId}::uuid, ${m.linha.tipoEstoqueId}::uuid,
                   ${m.linha.dataMovimento.toISOString()}::timestamptz)`,
          ),
          sql`, `,
        )}) as v(ordem, estoque_id, produto_id, variacao_id, tipo_estoque_id, data)
        cross join lateral (
          select ac.id as acerto_id, ac.codigo, it.id as item_id
            from acertos_estoque ac
            join itens_acerto_estoque it on it.acerto_id = ac.id and it.excluido_em is null
           where ac.estoque_id = v.estoque_id and ac.tipo_estoque_id = v.tipo_estoque_id
             and ac.tipo_ajuste = 'definir' and ac.status = 'efetivado' and ac.excluido_em is null
             and ac.data_contagem > v.data ${exceto}
             and it.produto_id = v.produto_id and it.variacao_id is not distinct from v.variacao_id
           order by ac.data_contagem desc, ac.efetivado_em desc
           limit 1) a`);
    for (const r of rows) {
      achados.set(Number(r.ordem), { acertoId: r.acerto_id, codigo: Number(r.codigo), itemId: r.item_id });
    }
  }
  return achados;
}

/**
 * SYNC 15.3: cada movimento do documento anterior à contagem de um "Definir" já efetivado (não estornado) ganha **um**
 * `ACERTO_COMPENSACAO` de sinal oposto, na mesma data do fato (as duas se anulam em qualquer janela que um "Definir"
 * futuro some), contra o último "Definir" da linha, com `compensa_movimento_id` = o movimento (T23). A entrada que
 * compensa uma saída entra ao custo dela (o custo médio fica como estava). `documento` vai na observação ("venda",
 * "cancelamento de venda", "acerto 12"…). Quem chama passa os movimentos que **acabou de lançar** na mesma transação,
 * com as linhas de saldo ainda travadas; o acerto em efetivação ainda está em `rascunho` e não compensa a si mesmo.
 * A compensação repete a data de um fato já lançado: vai ao motor com `retroativoPermitido`.
 */
export async function compensarDefinir(
  tx: DbEmpresa,
  movimentos: readonly MovimentoDoDocumento[],
  documento = 'venda',
): Promise<MovimentoDoDocumento[]> {
  if (!movimentos.length) return [];
  const achados = await definirPosteriores(tx, movimentos);
  return lancarCompensacoes(
    tx,
    movimentos,
    achados,
    (codigo) => `Compensação do acerto ${codigo}: ${documento} anterior à contagem recebida depois`,
  );
}

/**
 * Lança os `ACERTO_COMPENSACAO` de `achados` (posição do movimento → "Definir" que o anula), com a observação de
 * `observacao(código do "Definir")`. O `compensarDefinir` e o estorno do "Definir" (`estornarAcerto`, que compensa de
 * novo contra o "Definir" anterior o fato cuja compensação estornou) passam por aqui.
 */
export async function lancarCompensacoes(
  tx: DbEmpresa,
  movimentos: readonly MovimentoDoDocumento[],
  achados: ReadonlyMap<number, DefinirPosterior>,
  observacao: (codigo: number) => string,
): Promise<MovimentoDoDocumento[]> {
  if (!achados.size) return [];
  const linhas: NovoMovimento[] = [];
  for (const [ordem, d] of achados) {
    const m = movimentos[ordem]!;
    linhas.push({
      ...m.linha,
      tipoMovimento: 'ACERTO_COMPENSACAO',
      quantidade: decTexto(dec(m.linha.quantidade).neg(), 3),
      custoUnitario: m.custoUnitario,
      custoReferencia: m.custoUnitario,
      precoVenda: null,
      documentoTipo: 'acerto',
      documentoId: d.acertoId,
      documentoItemId: d.itemId,
      estornoDeId: null,
      compensaMovimentoId: m.id,
      observacao: observacao(d.codigo).slice(0, 255),
    });
  }
  return (await lancarDocumento(tx, linhas, { retroativoPermitido: true })).movimentos;
}

/**
 * Os fatos compensados pelas compensações `compensacaoIds` (as que um "Definir" lançou e o estorno dele vai estornar),
 * como `MovimentoDoDocumento` (o que a compensação herda do fato: linha, data, loja, usuário, terminal, evento…), para
 * o estorno procurar outro "Definir" que também os contou (`definirPosteriores` com `excetoAcertoId`).
 */
export async function fatosCompensados(
  tx: DbEmpresa,
  compensacaoIds: readonly string[],
): Promise<Array<{ compensacaoId: string; fato: MovimentoDoDocumento }>> {
  if (!compensacaoIds.length) return [];
  const { rows } = await tx.execute<{
    compensacao_id: string;
    id: string;
    estoque_id: string;
    loja_id: string | null;
    tipo_estoque_id: string;
    produto_id: string;
    variacao_id: string | null;
    lote_id: string | null;
    tipo_movimento: string;
    quantidade: string;
    unidade_documento: string | null;
    fator: string;
    saldo_anterior: string;
    saldo_posterior: string;
    custo_unitario: string;
    custo_total: string;
    custo_medio_posterior: string;
    preco_venda: string | null;
    data_movimento: Date;
    usuario_id: string | null;
    pessoa_id: string | null;
    documento_tipo: NovoMovimento['documentoTipo'];
    documento_id: string | null;
    documento_item_id: string | null;
    terminal_id: string | null;
    evento_id: string | null;
  }>(sql`
    select c.id as compensacao_id, f.id, f.estoque_id, f.loja_id, f.tipo_estoque_id, f.produto_id, f.variacao_id,
           f.lote_id, f.tipo_movimento, f.quantidade::text, f.unidade_documento, f.fator::text,
           f.saldo_anterior::text, f.saldo_posterior::text, f.custo_unitario::text, f.custo_total::text,
           f.custo_medio_posterior::text, f.preco_venda::text, f.data_movimento, f.usuario_id, f.pessoa_id,
           f.documento_tipo, f.documento_id, f.documento_item_id, f.terminal_id, f.evento_id
      from movimentos_estoque c join movimentos_estoque f on f.id = c.compensa_movimento_id
     where c.id = any(${`{${compensacaoIds.join(',')}}`}::uuid[])
     order by c.id`);
  return rows.map((r) => ({
    compensacaoId: r.compensacao_id,
    fato: {
      id: r.id,
      saldoAnterior: r.saldo_anterior,
      saldoPosterior: r.saldo_posterior,
      custoUnitario: r.custo_unitario,
      custoTotal: r.custo_total,
      custoMedioPosterior: r.custo_medio_posterior,
      linha: {
        estoqueId: r.estoque_id,
        produtoId: r.produto_id,
        variacaoId: r.variacao_id,
        tipoEstoqueId: r.tipo_estoque_id,
        tipoMovimento: r.tipo_movimento,
        quantidade: r.quantidade,
        custoUnitario: r.custo_unitario,
        custoReferencia: r.custo_unitario,
        precoVenda: r.preco_venda,
        dataMovimento: new Date(r.data_movimento),
        lojaId: r.loja_id,
        usuarioId: r.usuario_id,
        documentoTipo: r.documento_tipo,
        documentoId: r.documento_id,
        documentoItemId: r.documento_item_id,
        unidadeDocumento: r.unidade_documento,
        fator: r.fator,
        loteId: r.lote_id,
        pessoaId: r.pessoa_id,
        terminalId: r.terminal_id,
        eventoId: r.evento_id,
      },
    },
  }));
}

/** Uma compensação ainda não estornada de um movimento do documento (`compensacoesDoDocumento`). */
export type CompensacaoDoDocumento = {
  id: string;
  estoque_id: string;
  loja_id: string | null;
  produto_id: string;
  variacao_id: string | null;
  tipo_estoque_id: string;
  quantidade: string;
  custo_unitario: string;
  preco_venda: string | null;
  /** O item do documento cujo movimento foi compensado (o estorno da compensação vai no item dele). */
  documento_item_id: string | null;
  unidade_documento: string | null;
  /** O lote da compensação (o do fato compensado, F2-B6): o estorno volta a ele. */
  lote_id: string | null;
  nome: string;
};

/**
 * As compensações (ainda não estornadas) que **outros** "Definir" lançaram contra os movimentos de um documento: o
 * "Definir" com contagem anterior a outro já efetivado foi anulado por ele, na data da própria contagem. Estornar o
 * documento sem estornar também essas compensações deixava o efeito delas no saldo (o estorno do movimento sai em
 * `now()`, a compensação fica): quem estorna lança um estorno para cada uma, no item do movimento compensado, e o
 * documento volta a não ter efeito nenhum. As compensações que o próprio documento lançou (documento_id = ele) não
 * entram aqui: o estorno do "Definir" já as estorna junto (ERP 13.5).
 */
export async function compensacoesDoDocumento(
  tx: DbEmpresa,
  documentoTipo: NovoMovimento['documentoTipo'],
  documentoId: string,
): Promise<CompensacaoDoDocumento[]> {
  const { rows } = await tx.execute<CompensacaoDoDocumento>(sql`
    select c.id, c.estoque_id, c.loja_id, c.produto_id, c.variacao_id, c.tipo_estoque_id, c.quantidade::text,
           c.custo_unitario::text, c.preco_venda::text, o.documento_item_id, c.unidade_documento, c.lote_id, p.nome
      from movimentos_estoque o
      join movimentos_estoque c on c.compensa_movimento_id = o.id and c.tipo_movimento = 'ACERTO_COMPENSACAO'
      join produtos p on p.id = c.produto_id
     where o.documento_tipo = ${documentoTipo} and o.documento_id = ${documentoId} and o.estorno_de_id is null
       and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = c.id)`);
  return rows;
}
