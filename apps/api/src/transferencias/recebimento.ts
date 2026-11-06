/**
 * Transferência entre estoques, 2ª etapa (ERP 13.7; MD 3.7.6; Fase 2, F2-B24; README da API › decisão 172): o destino
 * **recebe** (`TRANSF_ENTRADA` com o custo da saída, a quantidade conferida por item ou "receber tudo como enviado") e,
 * com diferença recebida a menor, a diferença é **tratada** por item: "Retornar à origem" (`TRANSF_RETORNO` da
 * diferença) ou "Baixar como perda" (F2-Q10 = D51, decidida pelo dono em 06/11/2026: o mesmo retorno mais um acerto de
 * Saída na origem com a origem `perda_transferencia`, `lancarPerdaTransferencia`). O modo de uma etapa
 * (`estoque.transferencia_recebimento_automatico`) chama `receberTransferencia` logo depois do `enviarTransferencia`,
 * na mesma transação.
 *
 * As **partes** da saída: o envio lança um `TRANSF_SAIDA` por item ou, no item sem lote de produto com saldo de lote,
 * um por lote da divisão FEFO, todos com o `documento_item_id` do item e o mesmo custo médio da linha. A entrada no
 * destino repete cada parte (o lote e o custo dela, como a perna de entrada da mudança de tipo) e a quantidade
 * recebida do item enche as partes **na ordem do lançamento** (`repartirRecebida`: o lote que vence primeiro chega
 * primeiro); o que faltou fica nas últimas partes, e é delas que o tratamento da diferença devolve, cada retorno com
 * `estorno_de_id` = a parte (o `uq_movimentos_estoque_estorno`: um estorno por movimento, então a parte devolvida em
 * parte já não se cancela). A repartição é refeita no tratamento a partir das saídas e da recebida gravada: a mesma
 * conta, sem coluna nova.
 *
 * O lote **preso ao estoque de origem** (`produtos_lotes.estoque_id` = a origem; MD 3.6.9) não vale no destino
 * (`ErroLoteInvalido`): a entrada vai ao lote do **mesmo código** do produto no destino (o preso ao destino, ou o sem
 * estoque), com a mesma validade, e, sem ele, o lote é criado preso ao destino com o código, a validade, a fabricação
 * e o fornecedor do de origem (`loteNoDestino`). O lote do mesmo código já cadastrado com outra validade (ou
 * fabricação) recusa o recebimento no item (422): juntar as duas validades num lote só inventaria um lote errado, e
 * entrar sem lote perderia a validade. O lote sem estoque (o criado pelo recebimento e pela NF-e) entra como está.
 *
 * Quem chama abre a transação com `travaVersao` (os saldos descem ao PDV das lojas pelo fluxo `estoque`) e trava o
 * cabeçalho antes.
 */
import {
  dec,
  decTexto,
  situacaoAposRecebimento,
  type ReceberTransferencia,
  type TratamentoDivergenciaTransferencia,
  type TratarDivergenciaTransferencia,
  type Valor,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { ErroApi } from '../comum/erros.js';
import { emBlocos } from '../entradas/entrada.js';
import { lancarPerdaTransferencia, lojaDoEstoque, type RetornoDaPerda } from '../estoques/acertos.js';
import { compensarDefinir } from '../estoques/compensacao.js';
import { lancarDocumento, type NovoMovimento } from '../estoques/movimentos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { resolverAlertasTransferencia } from './alertas.js';
import type { TransferenciaATratar } from './transferencias.js';

const lista = (ids: Iterable<string>) => `{${[...new Set([...ids].map((i) => i.toLowerCase()))].join(',')}}`;
const dataBr = (d: string) => d.split('-').reverse().join('/');

/**
 * Reparte a quantidade recebida do item pelas partes da saída (as quantidades enviadas de cada `TRANSF_SAIDA`, na
 * ordem do lançamento): cada parte recebe até a quantidade dela, em ordem, e o que faltou fica nas últimas. Devolve,
 * por parte, a recebida e a diferença (3 casas, ADR-05). A recebida acima da soma das partes é recusada antes (o
 * contrato, a API e o CHECK do banco).
 */
export function repartirRecebida(
  partes: readonly Valor[],
  recebida: Valor,
): Array<{ recebida: string; diferenca: string }> {
  let resta = dec(recebida);
  return partes.map((p) => {
    const parte = dec(decTexto(p, 3));
    const nela = resta.lt(parte) ? (resta.lt(0) ? dec(0) : resta) : parte;
    resta = resta.minus(nela);
    return { recebida: decTexto(nela, 3), diferenca: decTexto(parte.minus(nela), 3) };
  });
}

/** Uma parte da saída (`TRANSF_SAIDA` do item), com a quantidade enviada positiva. */
interface ParteSaida {
  id: string;
  itemId: string;
  estoqueId: string;
  lojaId: string | null;
  produtoId: string;
  variacaoId: string | null;
  tipoEstoqueId: string;
  loteId: string | null;
  quantidade: string;
  custoUnitario: string;
  precoVenda: string | null;
  unidadeDocumento: string | null;
}

/** As partes da saída de cada item, na ordem do lançamento (a da divisão FEFO). */
async function partesDaSaida(
  tx: DbEmpresa,
  transferenciaId: string,
  itemIds?: readonly string[],
): Promise<Map<string, ParteSaida[]>> {
  const { rows } = await tx.execute<{
    id: string;
    documento_item_id: string;
    estoque_id: string;
    loja_id: string | null;
    produto_id: string;
    variacao_id: string | null;
    tipo_estoque_id: string;
    lote_id: string | null;
    quantidade: string;
    custo_unitario: string;
    preco_venda: string | null;
    unidade_documento: string | null;
  }>(sql`
    select m.id, m.documento_item_id, m.estoque_id, m.loja_id, m.produto_id, m.variacao_id, m.tipo_estoque_id,
           m.lote_id, (-m.quantidade)::text as quantidade, m.custo_unitario::text, m.preco_venda::text,
           m.unidade_documento
      from movimentos_estoque m
     where m.documento_tipo = 'transferencia' and m.documento_id = ${transferenciaId}
       and m.tipo_movimento = 'TRANSF_SAIDA' and m.estorno_de_id is null
       ${itemIds ? sql`and m.documento_item_id = any(${lista(itemIds)}::uuid[])` : sql``}
     order by m.seq_lancamento`);
  const porItem = new Map<string, ParteSaida[]>();
  for (const r of rows) {
    const parte: ParteSaida = {
      id: r.id,
      itemId: r.documento_item_id,
      estoqueId: r.estoque_id,
      lojaId: r.loja_id,
      produtoId: r.produto_id,
      variacaoId: r.variacao_id,
      tipoEstoqueId: r.tipo_estoque_id,
      loteId: r.lote_id,
      quantidade: r.quantidade,
      custoUnitario: r.custo_unitario,
      precoVenda: r.preco_venda,
      unidadeDocumento: r.unidade_documento,
    };
    const g = porItem.get(parte.itemId);
    if (g) g.push(parte);
    else porItem.set(parte.itemId, [parte]);
  }
  return porItem;
}

/**
 * O lote da entrada no destino para o lote `loteId` da saída (ver o topo do módulo): o próprio, se não está preso a
 * estoque nenhum ou já é do destino; senão o do mesmo código do produto no destino (o vivo antes do excluído; entre os
 * vivos, o preso ao destino antes do sem estoque, como o recebimento acha o lote digitado, e o ativo antes do inativo),
 * reativado se estava inativo ou excluído, com a validade e a fabricação que faltavam completadas; e, sem ele, um lote
 * novo preso ao destino com os dados do de origem. Devolve o erro (texto) quando o do destino tem outra validade ou
 * fabricação. O excluído só é escolhido sem nenhum vivo do mesmo código no destino: o cadastro deixa excluir o lote sem
 * histórico e digitar o mesmo código de novo (outra linha; `uq_produtos_lotes` só vale entre os não excluídos), e
 * reativar o excluído com o vivo ao lado daria duas linhas vivas com a mesma chave (23505), ou recusaria o item pela
 * validade de um lote que nem está mais cadastrado.
 */
async function loteNoDestino(
  tx: DbEmpresa,
  loteId: string,
  destinoId: string,
  usuarioId: string,
): Promise<{ id: string; criado: boolean } | { erro: string }> {
  const { rows: o } = await tx.execute<{
    id: string;
    produto_id: string;
    variacao_id: string | null;
    estoque_id: string | null;
    lote: string;
    validade: string | null;
    fabricacao: string | null;
    fornecedor_id: string | null;
  }>(sql`
    select id, produto_id, variacao_id, estoque_id, lote, validade::text, fabricacao::text, fornecedor_id
      from produtos_lotes where id = ${loteId}`);
  const origem = o[0];
  if (!origem) throw new Error(`Lote ${loteId} da saída não encontrado`);
  if (origem.estoque_id === null || origem.estoque_id === destinoId.toLowerCase())
    return { id: origem.id, criado: false };
  const { rows: d } = await tx.execute<{
    id: string;
    validade: string | null;
    fabricacao: string | null;
    ativo: boolean;
    excluido: boolean;
  }>(sql`
    select id, validade::text, fabricacao::text, ativo, excluido_em is not null as excluido
      from produtos_lotes
     where produto_id = ${origem.produto_id} and variacao_id is not distinct from ${origem.variacao_id}
       and lote = ${origem.lote}
       and (estoque_id = ${destinoId} or (estoque_id is null and excluido_em is null))
     order by excluido_em is not null, estoque_id nulls last, ativo desc, id desc
     limit 1
       for update`);
  const achado = d[0];
  if (!achado) {
    const { rows: novo } = await tx.execute<{ id: string }>(sql`
      insert into produtos_lotes (produto_id, variacao_id, estoque_id, lote, validade, fabricacao, fornecedor_id,
                                  criado_por_id, atualizado_por_id)
      values (${origem.produto_id}, ${origem.variacao_id}, ${destinoId}, ${origem.lote}, ${origem.validade}::date,
              ${origem.fabricacao}::date, ${origem.fornecedor_id}, ${usuarioId}, ${usuarioId})
      returning id`);
    return { id: novo[0]!.id, criado: true };
  }
  if (origem.validade !== null && achado.validade !== null && origem.validade !== achado.validade)
    return {
      erro: `O lote ${origem.lote} já está cadastrado no destino com a validade ${dataBr(achado.validade)} (na origem, ${dataBr(origem.validade)}): corrija o cadastro do lote antes de receber`,
    };
  if (origem.fabricacao !== null && achado.fabricacao !== null && origem.fabricacao !== achado.fabricacao)
    return {
      erro: `O lote ${origem.lote} já está cadastrado no destino com a fabricação ${dataBr(achado.fabricacao)} (na origem, ${dataBr(origem.fabricacao)}): corrija o cadastro do lote antes de receber`,
    };
  if (
    !achado.ativo ||
    achado.excluido ||
    (achado.validade === null && origem.validade !== null) ||
    (achado.fabricacao === null && origem.fabricacao !== null)
  )
    await tx.execute(sql`
      update produtos_lotes
         set ativo = true, excluido_em = null, validade = coalesce(validade, ${origem.validade}::date),
             fabricacao = coalesce(fabricacao, ${origem.fabricacao}::date), atualizado_por_id = ${usuarioId}
       where id = ${achado.id}`);
  return { id: achado.id, criado: false };
}

/** O que o recebimento lançou (auditoria). */
export interface ResultadoRecebimento {
  status: 'recebida' | 'recebida_divergencia';
  itens: number;
  /** Itens recebidos a menor (a divergência a tratar). */
  comDiferenca: number;
  /** `TRANSF_ENTRADA` lançados no destino (um por parte da saída com quantidade recebida). */
  movimentos: number;
  /** `ACERTO_COMPENSACAO` lançadas contra um "Definir" do destino com a contagem um pouco à frente (F2-B4). */
  compensacoes: number;
  /** Lotes criados no destino para o lote preso à origem. */
  lotesCriados: number;
}

/**
 * Recebe a transferência **já travada** em `em_transito` (ERP 13.7, 2ª etapa): a quantidade conferida de cada item
 * (todos: a conferência que deixa item de fora é 422, para o esquecido não virar "recebido como enviado"; recebida
 * acima da enviada é 422 no item — fazer outra transferência) ou, com `receberTudo`, a enviada. Grava a recebida nos
 * itens **antes** de a situação sair do trânsito (o trigger só a libera nele), lança um `TRANSF_ENTRADA` no destino
 * por parte da saída com quantidade recebida (`repartirRecebida`), em `now()` (F2-B4), com o custo unitário da parte
 * (o custo da saída: o custo médio do destino é recalculado pela média ponderada), o lote dela no destino
 * (`loteNoDestino`) e a loja do estoque de destino (nula no CD), passa as entradas pela `compensarDefinir` e muda a
 * situação para `recebida` ou, com algum item a menor, `recebida_divergencia` (`situacaoAposRecebimento`), com quem e
 * quando recebeu. Entrada não deixa saldo negativo: não há regra de negativo.
 */
export async function receberTransferencia(
  tx: DbEmpresa,
  t: TransferenciaATratar,
  quem: { usuarioId: string },
  conferencia: Pick<ReceberTransferencia, 'receberTudo' | 'itens'>,
): Promise<ResultadoRecebimento> {
  const inicio = new Date();
  const { rows: itens } = await tx.execute<{
    id: string;
    produto_nome: string;
    sigla: string;
    quantidade_enviada: string;
  }>(sql`
    select i.id, p.nome as produto_nome, u.sigla, i.quantidade_enviada::text
      from itens_transferencia i
      join produtos p on p.id = i.produto_id
      join unidades_medida u on u.id = p.unidade_id
     where i.transferencia_id = ${t.id} and i.excluido_em is null
     order by i.sequencia`);
  const recebidas = new Map<string, string>();
  if (conferencia.receberTudo) for (const i of itens) recebidas.set(i.id, i.quantidade_enviada);
  else {
    const campos: Record<string, string[]> = {};
    conferencia.itens.forEach((c, n) => {
      const item = itens.find((i) => i.id === c.itemId.toLowerCase());
      if (!item) {
        campos[`itens.${n}.itemId`] = ['O item não é desta transferência'];
        return;
      }
      if (dec(c.quantidadeRecebida).gt(item.quantidade_enviada)) {
        campos[`itens.${n}.quantidadeRecebida`] = [
          `Acima da enviada (${Number(item.quantidade_enviada).toLocaleString('pt-BR')} ${item.sigla}): para mandar mais, faça outra transferência`,
        ];
        return;
      }
      recebidas.set(item.id, decTexto(c.quantidadeRecebida, 3));
    });
    if (Object.keys(campos).length)
      throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
    const faltam = itens.filter((i) => !recebidas.has(i.id));
    if (faltam.length)
      throw new ErroApi(
        'VALIDACAO',
        `Informe a quantidade recebida de todos os itens (ou use "Receber tudo como enviado"). Falta(m): ${faltam
          .map((i) => i.produto_nome)
          .join(', ')}.`,
      );
  }
  const partes = await partesDaSaida(tx, t.id);
  const lojaId = await lojaDoEstoque(tx, t.estoqueDestinoId);
  // O lote no destino de cada lote da saída (uma vez cada), com o erro no item (a posição dele no documento).
  const lotes = new Map<string, string>();
  const campos: Record<string, string[]> = {};
  let lotesCriados = 0;
  for (const [n, item] of itens.entries())
    for (const p of partes.get(item.id) ?? []) {
      if (!p.loteId || lotes.has(p.loteId) || campos[`itens.${n}.loteId`]) continue;
      const l = await loteNoDestino(tx, p.loteId, t.estoqueDestinoId, quem.usuarioId);
      if ('erro' in l) campos[`itens.${n}.loteId`] = [l.erro];
      else {
        lotes.set(p.loteId, l.id);
        if (l.criado) lotesCriados += 1;
      }
    }
  if (Object.keys(campos).length)
    throw new ErroApi('REGRA_NEGOCIO', 'O lote de um item não pode entrar no destino.', { campos });
  const linhas: NovoMovimento[] = [];
  for (const item of itens) {
    const doItem = partes.get(item.id) ?? [];
    const repartida = repartirRecebida(
      doItem.map((p) => p.quantidade),
      recebidas.get(item.id)!,
    );
    doItem.forEach((p, k) => {
      const q = repartida[k]!.recebida;
      if (dec(q).isZero()) return;
      linhas.push({
        estoqueId: t.estoqueDestinoId,
        produtoId: p.produtoId,
        variacaoId: p.variacaoId,
        tipoEstoqueId: p.tipoEstoqueId,
        loteId: p.loteId ? lotes.get(p.loteId)! : null,
        tipoMovimento: 'TRANSF_ENTRADA',
        quantidade: q,
        // O custo da saída (ERP 13.7): o valor que saiu da origem entra no destino.
        custoUnitario: p.custoUnitario,
        custoReferencia: p.custoUnitario,
        precoVenda: p.precoVenda,
        dataMovimento: inicio,
        lojaId,
        usuarioId: quem.usuarioId,
        documentoTipo: 'transferencia',
        documentoId: t.id,
        documentoItemId: item.id,
        unidadeDocumento: p.unidadeDocumento,
      });
    });
  }
  // A recebida antes de a situação sair do trânsito (o trigger só a libera nele).
  for (const bloco of emBlocos([...recebidas]))
    await tx.execute(sql`
      update itens_transferencia i set quantidade_recebida = v.q
        from (values ${sql.join(
          bloco.map(([id, q]) => sql`(${id}::uuid, ${q}::numeric)`),
          sql`, `,
        )}) as v(id, q)
       where i.id = v.id`);
  const r = linhas.length
    ? await lancarDocumento(tx, linhas, { inicioDocumento: inicio })
    : { movimentos: [] };
  const compensacoes = await compensarDefinir(tx, r.movimentos, `transferência ${t.codigo}`);
  const status = situacaoAposRecebimento(
    itens.map((i) => ({ quantidadeEnviada: i.quantidade_enviada, quantidadeRecebida: recebidas.get(i.id)! })),
  );
  await tx.execute(sql`
    update transferencias_estoque
       set status = ${status}, recebida_em = now(), recebida_por_id = ${quem.usuarioId},
           atualizado_por_id = ${quem.usuarioId}
     where id = ${t.id}`);
  // F2-B26: o alerta do trânsito parado fecha no recebimento (a divergência, se houver, conta o prazo de agora).
  await resolverAlertasTransferencia(tx, t.id);
  return {
    status,
    itens: itens.length,
    comDiferenca: itens.filter((i) => dec(i.quantidade_enviada).gt(recebidas.get(i.id)!)).length,
    movimentos: r.movimentos.length,
    compensacoes: compensacoes.length,
    lotesCriados,
  };
}

/** O resumo do recebimento na auditoria. */
export function resumoRecebimento(r: ResultadoRecebimento): string {
  const partes = [`${r.itens} item(ns), ${r.movimentos} movimento(s)`];
  if (r.comDiferenca) partes.push(`${r.comDiferenca} item(ns) recebido(s) a menor`);
  if (r.lotesCriados) partes.push(`${r.lotesCriados} lote(s) criado(s) no destino`);
  if (r.compensacoes)
    partes.push(`${r.compensacoes} anulado(s) por "Definir" já efetivado de contagem posterior`);
  return partes.join(', ');
}

/** O que o tratamento da diferença lançou (auditoria). */
export interface ResultadoTratamento {
  /** Itens tratados nesta chamada, por tratamento. */
  retornados: number;
  perdas: number;
  /** `TRANSF_RETORNO` lançados na origem (um por parte da saída com diferença). */
  retornos: number;
  /** O acerto de Saída da perda (`perda_transferencia`), quando algum item foi baixado como perda. */
  acerto: { id: string; codigo: number; movimentos: number; compensacoes: number; itens: number } | null;
  /** `ACERTO_COMPENSACAO` lançadas contra os retornos (um "Definir" da origem com a contagem um pouco à frente). */
  compensacoes: number;
  /** A transferência ficou `recebida` (nenhuma diferença sem tratamento). */
  concluida: boolean;
}

/**
 * Trata a diferença dos itens da transferência **já travada** em `recebida_divergencia` (ERP 13.7 "Divergência"):
 * cada item pedido tem de ter diferença (recebido a menor) e ainda não tratada (uma vez só; o trigger repete a regra).
 * Para cada um, um `TRANSF_RETORNO` na origem por parte da saída com diferença (`repartirRecebida`), com
 * `estorno_de_id` = a parte, no lote dela e **ao custo dela** (o estorno de saída do T20, como o cancelamento), em
 * `now()`, passado pela `compensarDefinir`; no "Baixar como perda" (F2-Q10 = D51), depois dos retornos, o acerto de
 * Saída da origem (`lancarPerdaTransferencia`), um só para a chamada, com um item por produto × lote somando as
 * partes, cada retorno baixado por uma saída que o estorna (no lote e ao custo dele: efeito líquido zero na origem,
 * lote a lote e no custo médio). O tratamento e a hora são gravados nos itens e, sem diferença pendente, a transferência passa a `recebida`.
 */
export async function tratarDivergenciaTransferencia(
  tx: DbEmpresa,
  t: TransferenciaATratar,
  quem: { usuarioId: string },
  pedido: TratarDivergenciaTransferencia['itens'],
): Promise<ResultadoTratamento> {
  const inicio = new Date();
  const { rows: itens } = await tx.execute<{
    id: string;
    produto_nome: string;
    quantidade_recebida: string | null;
    diferenca: string;
    tratamento_divergencia: TratamentoDivergenciaTransferencia | null;
  }>(sql`
    select i.id, p.nome as produto_nome, i.quantidade_recebida::text, i.diferenca::text, i.tratamento_divergencia
      from itens_transferencia i join produtos p on p.id = i.produto_id
     where i.transferencia_id = ${t.id} and i.excluido_em is null`);
  const campos: Record<string, string[]> = {};
  const tratar = new Map<string, TratamentoDivergenciaTransferencia>();
  pedido.forEach((p, n) => {
    const item = itens.find((i) => i.id === p.itemId.toLowerCase());
    if (!item) campos[`itens.${n}.itemId`] = ['O item não é desta transferência'];
    else if (!dec(item.diferenca).gt(0))
      campos[`itens.${n}.itemId`] = [
        `${item.produto_nome} foi recebido como enviado: não há diferença a tratar`,
      ];
    else if (item.tratamento_divergencia)
      campos[`itens.${n}.itemId`] = [
        `A diferença de ${item.produto_nome} já foi tratada (${item.tratamento_divergencia === 'perda' ? 'baixada como perda' : 'retornada à origem'})`,
      ];
    else tratar.set(item.id, p.tratamento);
  });
  if (Object.keys(campos).length)
    throw new ErroApi('REGRA_NEGOCIO', 'Verifique os itens destacados.', { campos });
  const partes = await partesDaSaida(tx, t.id, [...tratar.keys()]);
  const retornos: NovoMovimento[] = [];
  // A perda por produto × lote (o acerto tem um item por par), com as partes cujo retorno ela baixa.
  const perda = new Map<
    string,
    { produtoId: string; variacaoId: string | null; loteId: string | null; partes: string[] }
  >();
  for (const [itemId, tratamento] of tratar) {
    const item = itens.find((i) => i.id === itemId)!;
    const doItem = partes.get(itemId) ?? [];
    const repartida = repartirRecebida(
      doItem.map((p) => p.quantidade),
      item.quantidade_recebida!,
    );
    doItem.forEach((p, k) => {
      const q = repartida[k]!.diferenca;
      if (dec(q).isZero()) return;
      retornos.push({
        estoqueId: p.estoqueId,
        produtoId: p.produtoId,
        variacaoId: p.variacaoId,
        tipoEstoqueId: p.tipoEstoqueId,
        loteId: p.loteId,
        tipoMovimento: 'TRANSF_RETORNO',
        quantidade: q,
        // Estorno de saída (T20): a diferença volta ao custo da parte que saiu.
        custoUnitario: p.custoUnitario,
        custoReferencia: p.custoUnitario,
        precoVenda: p.precoVenda,
        dataMovimento: inicio,
        lojaId: p.lojaId,
        usuarioId: quem.usuarioId,
        documentoTipo: 'transferencia',
        documentoId: t.id,
        documentoItemId: itemId,
        unidadeDocumento: p.unidadeDocumento,
        estornoDeId: p.id,
        observacao:
          tratamento === 'perda'
            ? 'Diferença recebida a menor: retorno para a baixa como perda'
            : 'Diferença recebida a menor: retorno à origem',
      });
      if (tratamento === 'perda') {
        const chave = `${p.produtoId}|${p.variacaoId ?? ''}|${p.loteId ?? ''}`;
        const ja = perda.get(chave);
        if (ja) ja.partes.push(p.id);
        else
          perda.set(chave, {
            produtoId: p.produtoId,
            variacaoId: p.variacaoId,
            loteId: p.loteId,
            partes: [p.id],
          });
      }
    });
  }
  const r = retornos.length
    ? await lancarDocumento(tx, retornos, { inicioDocumento: inicio })
    : { movimentos: [] };
  const compensacoes = await compensarDefinir(tx, r.movimentos, `transferência ${t.codigo}`);
  let acerto: ResultadoTratamento['acerto'] = null;
  if (perda.size) {
    // O retorno de cada parte (o estorno dela): a perda o baixa na mesma linha, no mesmo lote e ao mesmo custo.
    const retornoDaParte = new Map<string, RetornoDaPerda>();
    for (const m of r.movimentos)
      if (m.linha.estornoDeId)
        retornoDaParte.set(m.linha.estornoDeId.toLowerCase(), {
          movimentoId: m.id,
          quantidade: decTexto(m.linha.quantidade, 3),
          custoUnitario: m.custoUnitario,
        });
    const a = await lancarPerdaTransferencia(
      tx,
      {
        estoqueId: t.estoqueOrigemId,
        tipoEstoqueId: t.tipoEstoqueId,
        transferenciaId: t.id,
        codigoTransferencia: t.codigo,
        itens: [...perda.values()].map(({ partes: ps, ...it }) => ({
          ...it,
          retornos: ps.map((id) => retornoDaParte.get(id.toLowerCase())!),
        })),
      },
      quem.usuarioId,
    );
    acerto = {
      id: a.acertoId,
      codigo: a.codigo,
      movimentos: a.resultado.movimentos,
      compensacoes: a.resultado.compensacoes,
      itens: a.resultado.itens,
    };
  }
  for (const bloco of emBlocos([...tratar]))
    await tx.execute(sql`
      update itens_transferencia i set tratamento_divergencia = v.t, divergencia_tratada_em = now()
        from (values ${sql.join(
          bloco.map(([id, tr]) => sql`(${id}::uuid, ${tr}::text)`),
          sql`, `,
        )}) as v(id, t)
       where i.id = v.id`);
  const concluida = itens.every(
    (i) => !dec(i.diferenca).gt(0) || i.tratamento_divergencia || tratar.has(i.id),
  );
  if (concluida) {
    await tx.execute(sql`
      update transferencias_estoque set status = 'recebida', atualizado_por_id = ${quem.usuarioId}
       where id = ${t.id}`);
    // F2-B26: o alerta da divergência parada fecha com o último item tratado.
    await resolverAlertasTransferencia(tx, t.id);
  }
  const tratados = [...tratar.values()];
  return {
    retornados: tratados.filter((x) => x === 'retorno_origem').length,
    perdas: tratados.filter((x) => x === 'perda').length,
    retornos: r.movimentos.length,
    acerto,
    compensacoes: compensacoes.length,
    concluida,
  };
}

/** O resumo do tratamento na auditoria. */
export function resumoTratamento(r: ResultadoTratamento): string {
  const partes: string[] = [];
  if (r.retornados) partes.push(`${r.retornados} item(ns) retornado(s) à origem`);
  if (r.perdas)
    partes.push(
      `${r.perdas} item(ns) baixado(s) como perda${r.acerto ? ` (acerto Nº ${r.acerto.codigo})` : ''}`,
    );
  partes.push(`${r.retornos} retorno(s)`);
  if (r.compensacoes)
    partes.push(`${r.compensacoes} anulado(s) por "Definir" já efetivado de contagem posterior`);
  return `${partes.join(', ')}${r.concluida ? '; diferenças tratadas' : '; ainda há diferença a tratar'}`;
}
