/**
 * Acerto de estoque (ERP 13.5; MD 3.7.5): gravação do rascunho com os itens, efetivação (um movimento por item com a
 * diferença de 13.1.5 e o custo gravado, saldo atualizado na mesma transação; na mudança de tipo, o par
 * `MUDANCA_TIPO_ESTOQUE`, F2-B8) e estorno. Usado pela tela de acertos e pelos ajustes de outras origens (importação de
 * planilha), que criam um acerto já efetivado com a `origem` própria.
 */
import {
  MOTIVO_PERDA_TRANSFERENCIA,
  TIPO_MOVIMENTO_MUDANCA_TIPO,
  avaliarConferencia,
  type AjusteEstoqueProduto,
  type CriarAcerto,
  type ResultadoAjusteProduto,
  dec,
  decTexto,
  quantidadeMovimentoTexto,
  tipoMovimentoAcerto,
  type AcertoDetalhe,
  type ConferenciaAcerto,
  type Dec,
  type ItemConferencia,
  type ItemAcertoDetalhe,
  type OrigemAcerto,
  type TipoAjuste,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { acertosEstoque } from '../database/empresa/schema/index.js';
import { buscarOpcoes } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  compensacoesDoDocumento,
  compensarDefinir,
  definirPosteriores,
  fatosCompensados,
  lancarCompensacoes,
} from './compensacao.js';
import { compensacoesDoAcerto } from './compensacoes-acerto.js';
import {
  lancarDocumento,
  lancarMovimento,
  ordenarChaves,
  saldoDoLote,
  somaMovimentosPosteriores,
  travarSaldo,
  travarSaldoExistente,
  type ChaveSaldo,
  type MovimentoDoDocumento,
  type NovoMovimento,
} from './movimentos.js';
import { estoquePermitido } from './permitidos.js';

/**
 * Tipos sem saldo próprio: combo (a venda baixa os componentes), serviço e produzido (a venda baixa os insumos da
 * ficha técnica — `BAIXA_INSUMO`, MD 3.6.7, ERP 8.2.4 — pela D17, decidida pelo dono, roadmap seção 16).
 */
export const TIPOS_SEM_ESTOQUE = ['kit', 'servico', 'produzido'] as const;

export interface ItemGravar {
  id: string | null;
  produtoId: string;
  variacaoId: string | null;
  /** Lote do item (F2-B6; só Entrada e Saída, o contrato recusa no Definir). */
  loteId?: string | null;
  quantidade: string;
  custoUnitario: string | null;
}

type ProdutoEstoque = {
  id: string;
  nome: string;
  tipo: string;
  controla_estoque: boolean;
  preco_venda: string;
  preco_custo: string;
  sigla: string;
};

/**
 * Tipo de estoque informado (ativo) ou o padrão (Disponível). `campo`: o do erro (o tipo de destino da mudança de tipo
 * também passa por aqui, sempre informado).
 */
export async function resolverTipoEstoque(
  tx: DbEmpresa,
  id: string | null,
  campo: 'tipoEstoqueId' | 'tipoEstoqueDestinoId' = 'tipoEstoqueId',
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(
    id
      ? sql`select id from tipos_estoque where id = ${id} and excluido_em is null and ativo`
      : sql`select id from tipos_estoque where padrao and excluido_em is null and ativo limit 1`,
  );
  if (!rows[0]) {
    if (id) throw erroCampo(campo, 'Tipo de estoque inexistente ou inativo');
    throw new ErroApi('REGRA_NEGOCIO', 'A empresa não tem tipo de estoque padrão.');
  }
  return rows[0].id;
}

/**
 * O tipo do acerto continua ativo na efetivação e no estorno (ERP 13.6): o rascunho só confere o tipo ao ser gravado
 * (`resolverTipoEstoque`), e o estorno devolve o saldo ao tipo dos movimentos. Sem isto, o saldo voltava a um tipo
 * inativado com saldo zero, que some dos seletores. A `fn_trava_versao` da transação serializa com o PUT do tipo.
 */
export async function exigirTipoEstoqueAtivo(
  tx: DbEmpresa,
  tipoEstoqueId: string,
  acao: 'efetivar' | 'estornar',
  campo: 'tipoEstoqueId' | 'tipoEstoqueDestinoId' = 'tipoEstoqueId',
): Promise<void> {
  const { rows } = await tx.execute<{ nome: string; ativo: boolean }>(sql`
    select nome, ativo from tipos_estoque where id = ${tipoEstoqueId} and excluido_em is null`);
  if (rows[0]?.ativo) return;
  const nome = rows[0] ? `"${rows[0].nome}"` : 'do acerto';
  throw erroCampo(
    campo,
    acao === 'efetivar'
      ? `O tipo de estoque ${nome} está inativo: troque o tipo do rascunho ou reative o tipo antes de efetivar`
      : `O tipo de estoque ${nome} está inativo: reative o tipo antes de estornar`,
    'REGRA_NEGOCIO',
  );
}

/** Confere os produtos dos itens (existem, controlam estoque, variação quando exigida). */
export async function conferirProdutos(
  tx: DbEmpresa,
  itens: ReadonlyArray<{ produtoId: string; variacaoId: string | null }>,
  prefixo = 'itens',
): Promise<Map<string, ProdutoEstoque>> {
  const ids = [...new Set(itens.map((i) => i.produtoId))];
  const mapa = new Map<string, ProdutoEstoque>();
  if (!ids.length) return mapa;
  const { rows } = await tx.execute<ProdutoEstoque>(sql`
    select p.id, p.nome, p.tipo, p.controla_estoque, p.preco_venda::text, p.preco_custo::text, u.sigla
      from produtos p join unidades_medida u on u.id = p.unidade_id
     where p.excluido_em is null and p.id = any(${`{${ids.join(',')}}`}::uuid[])`);
  for (const r of rows) mapa.set(r.id, r);
  const campos: Record<string, string[]> = {};
  itens.forEach((it, i) => {
    const p = mapa.get(it.produtoId);
    const campo = `${prefixo}.${i}.produtoId`;
    if (!p) campos[campo] = ['Produto não encontrado'];
    else if ((TIPOS_SEM_ESTOQUE as readonly string[]).includes(p.tipo))
      campos[campo] = [
        p.tipo === 'kit'
          ? 'Combo não tem estoque próprio: acerte os componentes'
          : p.tipo === 'produzido'
            ? 'Produto produzido não tem estoque próprio: acerte os insumos da ficha técnica'
            : 'Serviço não tem estoque',
      ];
    else if (!p.controla_estoque) campos[campo] = ['Produto sem controle de estoque'];
    else if (p.tipo === 'com_variacoes' && !it.variacaoId) campos[campo] = ['Escolha a variação'];
  });
  const comVariacao = itens.filter((i) => i.variacaoId);
  if (comVariacao.length) {
    const { rows: vs } = await tx.execute<{ id: string; produto_id: string }>(sql`
      select id, produto_id from produtos_variacoes
       where excluido_em is null and id = any(${`{${comVariacao.map((i) => i.variacaoId).join(',')}}`}::uuid[])`);
    itens.forEach((it, i) => {
      if (it.variacaoId && !vs.some((v) => v.id === it.variacaoId && v.produto_id === it.produtoId))
        campos[`${prefixo}.${i}.variacaoId`] = ['Variação não pertence ao produto'];
    });
  }
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
  return mapa;
}

/**
 * Confere os lotes dos itens (F2-B6; MD 3.6.9): existem, são do produto e da variação do item e do estoque do acerto
 * (ou sem estoque). A mesma regra do motor (`ErroLoteInvalido`), aqui com o erro no campo do item.
 */
export async function conferirLotesItens(
  tx: DbEmpresa,
  estoqueId: string,
  itens: ReadonlyArray<{ produtoId: string; variacaoId: string | null; loteId?: string | null }>,
  prefixo = 'itens',
): Promise<void> {
  const ids = [...new Set(itens.flatMap((i) => (i.loteId ? [i.loteId.toLowerCase()] : [])))];
  if (!ids.length) return;
  const { rows } = await tx.execute<{
    id: string;
    produto_id: string;
    variacao_id: string | null;
    estoque_id: string | null;
  }>(sql`
    select id, produto_id, variacao_id, estoque_id from produtos_lotes
     where excluido_em is null and id = any(${`{${ids.join(',')}}`}::uuid[])`);
  const campos: Record<string, string[]> = {};
  itens.forEach((it, i) => {
    if (!it.loteId) return;
    const l = rows.find((r) => r.id === it.loteId!.toLowerCase());
    if (!l) campos[`${prefixo}.${i}.loteId`] = ['Lote não encontrado'];
    else if (
      l.produto_id !== it.produtoId.toLowerCase() ||
      l.variacao_id !== (it.variacaoId?.toLowerCase() ?? null)
    )
      campos[`${prefixo}.${i}.loteId`] = ['O lote não é deste produto'];
    else if (l.estoque_id !== null && l.estoque_id !== estoqueId.toLowerCase())
      campos[`${prefixo}.${i}.loteId`] = ['O lote é de outro estoque'];
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
}

async function saldosAtuais(
  tx: DbEmpresa,
  estoqueId: string,
  tipoEstoqueId: string,
  produtoIds: readonly string[],
): Promise<Map<string, { quantidade: string; custoMedio: string }>> {
  const mapa = new Map<string, { quantidade: string; custoMedio: string }>();
  if (!produtoIds.length) return mapa;
  const { rows } = await tx.execute<{
    produto_id: string;
    variacao_id: string | null;
    q: string;
    cm: string;
  }>(sql`
    select produto_id, variacao_id, quantidade::text as q, custo_medio::text as cm from saldos_estoque
     where estoque_id = ${estoqueId} and tipo_estoque_id = ${tipoEstoqueId}
       and produto_id = any(${`{${[...new Set(produtoIds)].join(',')}}`}::uuid[])`);
  for (const r of rows)
    mapa.set(`${r.produto_id}:${r.variacao_id ?? ''}`, { quantidade: r.q, custoMedio: r.cm });
  return mapa;
}

/**
 * Grava os itens do rascunho: os que saíram são excluídos logicamente, os mantidos atualizados e os novos inseridos
 * (sequência depois da maior já usada). Trocar o produto de uma linha = excluir + inserir (o índice único por produto
 * vale só para os itens vivos). Recalcula os totais do cabeçalho com o saldo e o custo médio atuais.
 */
export async function gravarItensRascunho(
  tx: DbEmpresa,
  acerto: { id: string; estoqueId: string; tipoEstoqueId: string; tipoAjuste: TipoAjuste },
  itensInformados: readonly ItemGravar[],
  opcoes: { preservarCusto?: boolean } = {},
): Promise<void> {
  const produtos = await conferirProdutos(tx, itensInformados);
  await conferirLotesItens(tx, acerto.estoqueId, itensInformados);
  const { rows: atuais } = await tx.execute<{
    id: string;
    produto_id: string;
    variacao_id: string | null;
    lote_id: string | null;
    custo_unitario: string | null;
  }>(sql`
    select id, produto_id, variacao_id, lote_id, custo_unitario::text from itens_acerto_estoque
     where acerto_id = ${acerto.id} and excluido_em is null`);
  // Sem `produtos.ver_custo` o custo da Entrada não é aceito (mudaria o custo médio sem o usuário ver o custo): vale
  // o que já estava gravado no item ou, sem nada, o custo médio/de referência na efetivação.
  const itens = opcoes.preservarCusto
    ? itensInformados.map((it) => ({
        ...it,
        custoUnitario:
          (it.id
            ? atuais.find((a) => a.id === it.id && a.produto_id === it.produtoId)?.custo_unitario
            : null) ?? null,
      }))
    : itensInformados;
  const mantidos = new Map<string, ItemGravar>();
  for (const it of itens) {
    const a = it.id ? atuais.find((x) => x.id === it.id) : undefined;
    if (
      a &&
      a.produto_id === it.produtoId &&
      a.variacao_id === it.variacaoId &&
      a.lote_id === (it.loteId?.toLowerCase() ?? null)
    )
      mantidos.set(a.id, it);
  }
  const sair = atuais.filter((a) => !mantidos.has(a.id)).map((a) => a.id);
  if (sair.length)
    await tx.execute(sql`
      update itens_acerto_estoque set excluido_em = now()
       where id = any(${`{${sair.join(',')}}`}::uuid[])`);
  const saldos = await saldosAtuais(
    tx,
    acerto.estoqueId,
    acerto.tipoEstoqueId,
    itens.map((i) => i.produtoId),
  );
  const { rows: seq } = await tx.execute<{ n: number }>(sql`
    select coalesce(max(sequencia), 0)::int as n from itens_acerto_estoque where acerto_id = ${acerto.id}`);
  let sequencia = seq[0]?.n ?? 0;
  let totalVenda = dec(0);
  let totalCusto = dec(0);
  for (const it of itens) {
    const p = produtos.get(it.produtoId)!;
    const s = saldos.get(`${it.produtoId}:${it.variacaoId ?? ''}`) ?? { quantidade: '0', custoMedio: '0' };
    const custoMedio = dec(s.custoMedio).gt(0) ? s.custoMedio : p.preco_custo;
    const custo =
      acerto.tipoAjuste === 'entrada' && it.custoUnitario !== null ? it.custoUnitario : custoMedio;
    const base =
      acerto.tipoAjuste === 'definir'
        ? quantidadeMovimentoTexto('definir', it.quantidade, s.quantidade)
        : it.quantidade;
    const tv = decTexto(dec(base).times(p.preco_venda), 2);
    const tc = decTexto(dec(base).times(dec(custo)), 2);
    totalVenda = totalVenda.plus(tv);
    totalCusto = totalCusto.plus(tc);
    const valores = {
      quantidade: it.quantidade,
      custo: acerto.tipoAjuste === 'entrada' ? it.custoUnitario : null,
      preco: p.preco_venda,
    };
    const manter = it.id && mantidos.has(it.id);
    if (manter) {
      await tx.execute(sql`
        update itens_acerto_estoque
           set quantidade_informada = ${valores.quantidade}::numeric, custo_unitario = ${valores.custo}::numeric,
               preco_venda = ${valores.preco}::numeric, total_venda = ${tv}::numeric, total_custo = ${tc}::numeric
         where id = ${it.id}`);
    } else {
      sequencia += 1;
      await tx.execute(sql`
        insert into itens_acerto_estoque (id, acerto_id, sequencia, produto_id, variacao_id, lote_id,
                                          quantidade_informada, custo_unitario, preco_venda, total_venda, total_custo)
        values (${uuidv7()}, ${acerto.id}, ${sequencia}, ${it.produtoId}, ${it.variacaoId}, ${it.loteId ?? null},
                ${valores.quantidade}::numeric, ${valores.custo}::numeric, ${valores.preco}::numeric,
                ${tv}::numeric, ${tc}::numeric)`);
    }
  }
  await tx.execute(sql`
    update acertos_estoque
       set qtd_itens = ${itens.length}, total_venda = ${totalVenda.toFixed(2)}::numeric,
           total_custo = ${totalCusto.toFixed(2)}::numeric
     where id = ${acerto.id}`);
}

/** Loja do estoque (a de menor código, quando mais de uma o usa); `null` no estoque sem loja (o CD). */
export async function lojaDoEstoque(tx: DbEmpresa, estoqueId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    select id from lojas where estoque_id = ${estoqueId} and excluido_em is null order by codigo limit 1`);
  return rows[0]?.id ?? null;
}

/**
 * Cabeçalho do acerto (a tela de acertos e o "Ajustar" do produto, F2-B12): estoque permitido para movimentar e ativo,
 * tipo de estoque (padrão quando vazio), tipo de destino da mudança de tipo (ativo e diferente do de origem já
 * resolvido: o contrato não enxerga o padrão) e responsável ativo (padrão: o usuário logado).
 */
export async function conferirCabecalhoAcerto(
  tx: DbEmpresa,
  dados: Pick<CriarAcerto, 'estoqueId' | 'tipoEstoqueId' | 'tipoEstoqueDestinoId' | 'responsavelId'>,
  sessao: SessaoErp,
): Promise<{
  tipoEstoqueId: string;
  tipoEstoqueDestinoId: string | null;
  responsavelId: string;
  lojaId: string | null;
}> {
  const { rows: est } = await tx.execute<{ id: string; ativo: boolean }>(sql`
    select e.id, e.ativo from estoques e where e.id = ${dados.estoqueId} and e.excluido_em is null`);
  if (!est[0]) throw erroCampo('estoqueId', 'Estoque não encontrado');
  // Fora dos estoques permitidos (decisão 149): 403 no campo, como a loja fora das permitidas.
  if (!estoquePermitido(sessao, dados.estoqueId, 'movimentar'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
      campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
    });
  if (!est[0].ativo) throw erroCampo('estoqueId', 'Estoque inativo');
  const tipoEstoqueId = await resolverTipoEstoque(tx, dados.tipoEstoqueId);
  const tipoEstoqueDestinoId = dados.tipoEstoqueDestinoId
    ? await resolverTipoEstoque(tx, dados.tipoEstoqueDestinoId, 'tipoEstoqueDestinoId')
    : null;
  if (tipoEstoqueDestinoId === tipoEstoqueId)
    throw erroCampo('tipoEstoqueDestinoId', 'O tipo de destino tem de ser diferente do de origem');
  const responsavelId = dados.responsavelId ?? sessao.usuarioId;
  const { rows: u } = await tx.execute<{ id: string }>(sql`
    select id from usuarios where id = ${responsavelId} and excluido_em is null and ativo`);
  if (!u[0]) throw erroCampo('responsavelId', 'Responsável inexistente ou inativo');
  const lojaId = await lojaDoEstoque(tx, dados.estoqueId);
  // Responsável de estoque de loja: Master ou com acesso à loja (usuarios_lojas). Estoque sem loja (CD): qualquer
  // usuário ativo.
  if (lojaId && responsavelId !== sessao.usuarioId) {
    const { rows: acesso } = await tx.execute<{ id: string }>(sql`
      select u.id from usuarios u
       where u.id = ${responsavelId} and (u.master or exists (
         select 1 from usuarios_lojas ul where ul.usuario_id = u.id and ul.loja_id = ${lojaId} and ul.excluido_em is null))`);
    if (!acesso[0]) throw erroCampo('responsavelId', 'O responsável não tem acesso à loja deste estoque');
  }
  return { tipoEstoqueId, tipoEstoqueDestinoId, responsavelId, lojaId };
}

/**
 * "Ajustar" do bloco Estoque do produto (ERP 8.2.11; F2-B12; README da API › decisão 157): cria e efetiva, na
 * transação de quem chama (com `travaVersao`), um "Definir" de um item com a origem `cadastro_produto`
 * (`AJUSTE_CADASTRO`) — ou `relatorio_estoque` (`AJUSTE_RELATORIO`), o modal do Estoque Atual (ERP 16.4; F2-B31;
 * decisão 178), o mesmo núcleo —, na hora da contagem informada (padrão: agora) e com as mesmas regras do Definir da
 * tela: o estoque permitido para movimentar e ativo, o tipo de estoque ativo, a diferença descontando os movimentos
 * posteriores à contagem (13.1.5), a compensação das vendas tardias (F2-B4) e a regra do saldo negativo
 * (`estoque.permite_negativo_erp` da loja do estoque, ou Master). O produto sem saldo próprio (combo, serviço e o
 * produzido, que baixa os insumos da ficha técnica: decisão 91) e o que não controla estoque são recusados antes,
 * com a mensagem no topo do modal. Devolve o acerto e a loja (para a auditoria de quem chama).
 */
export async function ajustarEstoqueDefinir(
  tx: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  dados: AjusteEstoqueProduto,
  origem: Extract<OrigemAcerto, 'cadastro_produto' | 'relatorio_estoque'> = 'cadastro_produto',
): Promise<{ resultado: ResultadoAjusteProduto; lojaId: string | null }> {
  const { rows } = await tx.execute<{ tipo: string; controla_estoque: boolean; nome: string }>(sql`
    select tipo, controla_estoque, nome from produtos where id = ${produtoId} and excluido_em is null`);
  const p = rows[0];
  if (!p) throw ErroApi.naoEncontrado('Produto não encontrado.');
  if (p.tipo === 'kit')
    throw new ErroApi('REGRA_NEGOCIO', 'Combo não tem estoque próprio: ajuste os componentes.');
  if (p.tipo === 'produzido')
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Produto produzido não tem estoque próprio: a venda baixa os insumos da ficha técnica. Ajuste os insumos.',
    );
  if (p.tipo === 'servico') throw new ErroApi('REGRA_NEGOCIO', 'Serviço não tem estoque.');
  if (p.tipo === 'com_variacoes')
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Produto com variações: o saldo é por variação. Ajuste pelo acerto de estoque.',
    );
  if (!p.controla_estoque) throw new ErroApi('REGRA_NEGOCIO', 'O produto não controla estoque.');
  const cab = await conferirCabecalhoAcerto(
    tx,
    {
      estoqueId: dados.estoqueId,
      tipoEstoqueId: dados.tipoEstoqueId,
      tipoEstoqueDestinoId: null,
      responsavelId: null,
    },
    sessao,
  );
  const id = uuidv7();
  const dataContagem = dados.dataContagem ? new Date(dados.dataContagem) : new Date();
  const [a] = await tx
    .insert(acertosEstoque)
    .values({
      id,
      estoqueId: dados.estoqueId,
      tipoEstoqueId: cab.tipoEstoqueId,
      tipoAjuste: 'definir',
      dataContagem,
      motivo: dados.motivo,
      responsavelId: cab.responsavelId,
      observacoes: dados.observacoes,
      origem,
      criadoPorId: sessao.usuarioId,
      atualizadoPorId: sessao.usuarioId,
    })
    .returning({ codigo: acertosEstoque.codigo });
  const acerto = {
    id,
    estoqueId: dados.estoqueId,
    tipoEstoqueId: cab.tipoEstoqueId,
    tipoAjuste: 'definir' as const,
  };
  await gravarItensRascunho(tx, acerto, [
    { id: null, produtoId, variacaoId: null, quantidade: dados.quantidade, custoUnitario: null },
  ]);
  const permiteNegativo =
    sessao.master ||
    (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', cab.lojaId)) === true;
  const r = await efetivarAcerto(
    tx,
    { ...acerto, origem, dataContagem },
    { usuarioId: sessao.usuarioId, permiteNegativo },
  );
  const { rows: item } = await tx.execute<{ d: string }>(sql`
    select coalesce(diferenca, 0)::text as d from itens_acerto_estoque
     where acerto_id = ${id} and excluido_em is null limit 1`);
  return {
    resultado: {
      acertoId: id,
      codigo: a!.codigo,
      diferenca: item[0]?.d ?? '0',
      movimentos: r.movimentos,
      compensacoes: r.compensacoes,
    },
    lojaId: cab.lojaId,
  };
}

/**
 * "Baixar como perda" da divergência da transferência (ERP 13.7; F2-Q10 = D51, decidida pelo dono em 06/11/2026; Fase 2,
 * F2-B24; README da API › decisão 172): cria e efetiva, na transação de quem trata a diferença (com `travaVersao`), uma
 * **Saída** no estoque de origem com a origem `perda_transferencia`, `origem_id` = a transferência e o motivo
 * `MOTIVO_PERDA_TRANSFERENCIA`. Quem chama já lançou o `TRANSF_RETORNO` da diferença (um por parte da saída) e passa,
 * por item, os retornos que ele baixa: cada um vira um `ACERTO_SAIDA` com `estorno_de_id` = o retorno, na linha e no
 * lote dele e ao custo dele (`saidaDaPerdaTransferencia`: sem a divisão FEFO, que tirava a perda da parte sem lote de
 * um lote que nem saiu, e com a conta inversa da média ponderada, que devolve o custo médio da origem ao de antes do
 * retorno). O par retorno + perda tem efeito líquido zero no saldo, no saldo do lote e no custo médio da origem, e a
 * perda fica registrada ao custo do envio (o valor que de fato se perdeu no caminho). Por isso a saída não passa pela
 * regra do saldo negativo (é a baixa obrigatória do que acabou de voltar, não uma saída pedida). Um item por produto ×
 * lote (`uq_itens_acerto_estoque_produto`): quem chama junta os retornos do mesmo lote. O responsável é quem tratou; o
 * acerto aparece na tela de acertos com a origem "Perda na transferência" e não se estorna por lá (faz parte do
 * documento da transferência, `exigirAcertoEstornavel`).
 */
export async function lancarPerdaTransferencia(
  tx: DbEmpresa,
  dados: {
    estoqueId: string;
    tipoEstoqueId: string;
    transferenciaId: string;
    codigoTransferencia: number;
    itens: ReadonlyArray<{
      produtoId: string;
      variacaoId: string | null;
      loteId: string | null;
      /** Os `TRANSF_RETORNO` do produto × lote que a perda baixa (a quantidade do item é a soma). */
      retornos: readonly RetornoDaPerda[];
    }>;
  },
  usuarioId: string,
): Promise<{ acertoId: string; codigo: number; resultado: ResultadoEfetivacao }> {
  const id = uuidv7();
  const dataContagem = new Date();
  const [a] = await tx
    .insert(acertosEstoque)
    .values({
      id,
      estoqueId: dados.estoqueId,
      tipoEstoqueId: dados.tipoEstoqueId,
      tipoAjuste: 'saida',
      dataContagem,
      motivo: MOTIVO_PERDA_TRANSFERENCIA,
      responsavelId: usuarioId,
      observacoes: `Transferência Nº ${dados.codigoTransferencia}: diferença recebida a menor baixada como perda`,
      origem: 'perda_transferencia',
      origemId: dados.transferenciaId,
      criadoPorId: usuarioId,
      atualizadoPorId: usuarioId,
    })
    .returning({ codigo: acertosEstoque.codigo });
  let sequencia = 0;
  const retornosDaPerda = new Map<string, readonly RetornoDaPerda[]>();
  for (const it of dados.itens) {
    sequencia += 1;
    const itemId = uuidv7();
    retornosDaPerda.set(itemId, it.retornos);
    const quantidade = decTexto(
      it.retornos.reduce((s, r) => s.plus(r.quantidade), dec(0)),
      3,
    );
    // Os totais e o custo do item são gravados pela efetivação (o custo dos retornos).
    await tx.execute(sql`
      insert into itens_acerto_estoque (id, acerto_id, sequencia, produto_id, variacao_id, lote_id, quantidade_informada)
      values (${itemId}, ${id}, ${sequencia}, ${it.produtoId}, ${it.variacaoId}, ${it.loteId},
              ${quantidade}::numeric)`);
  }
  const resultado = await efetivarAcerto(
    tx,
    {
      id,
      estoqueId: dados.estoqueId,
      tipoEstoqueId: dados.tipoEstoqueId,
      tipoAjuste: 'saida',
      origem: 'perda_transferencia',
      dataContagem,
    },
    { usuarioId, permiteNegativo: true },
    { retornosDaPerda },
  );
  return { acertoId: id, codigo: a!.codigo, resultado };
}

/**
 * O acerto lançado por outro documento como parte dele não se estorna pela tela de acertos: a perda da transferência
 * (`perda_transferencia`, F2-B24) — estorná-la deixaria o retorno da diferença valendo na origem com a transferência
 * dizendo "Baixar como perda".
 */
export function exigirAcertoEstornavel(a: { origem: string }): void {
  if (a.origem === 'perda_transferencia')
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Este acerto é a perda de uma transferência (diferença recebida a menor) e faz parte dela: não se estorna. Para devolver a mercadoria, faça uma Entrada no estoque.',
    );
}

/** Um `TRANSF_RETORNO` que a perda da transferência baixa: o movimento, a quantidade (positiva) e o custo gravado. */
export interface RetornoDaPerda {
  movimentoId: string;
  quantidade: string;
  custoUnitario: string;
}

export interface ResultadoEfetivacao {
  movimentos: number;
  itens: number;
  /** `ACERTO_COMPENSACAO` lançadas contra um "Definir" já efetivado com contagem posterior (F2-B4). */
  compensacoes: number;
}

/**
 * Efetiva o acerto **já travado** (`for update`) em `rascunho`: trava os saldos em ordem estável, calcula a
 * quantidade de cada item (Definir: 13.1.5, descontando os movimentos posteriores à contagem), confere o saldo
 * negativo (Saída e Definir com saldo-alvo negativo: só com `estoque.permite_negativo_erp` ou Master), lança os movimentos e grava saldo anterior,
 * diferença, custo e totais nos itens **antes** de mudar o status (o trigger só deixa mexer nos itens em rascunho).
 *
 * Regra de data (Fase 2, F2-B4; ERP 13.1.5; README da API › decisão 148): só o "Definir" (inclusive o AJUSTE_IMPORTACAO
 * da planilha) lança na `data_contagem`, com `retroativoPermitido`; a Entrada e a Saída lançam no momento da
 * efetivação, e a `data_contagem` delas fica só no cabeçalho ("Data" do acerto). Depois de lançar, os movimentos
 * passam pela `compensarDefinir` do motor: o "Definir" com contagem anterior à de outro já efetivado na mesma linha é
 * anulado por ele (a contagem mais nova vale), e a Entrada/Saída lançada antes de um "Definir" com a contagem
 * informada um pouco no futuro (a folga do `criarAcertoSchema`) também.
 *
 * Lote (F2-B6): o item com lote (Entrada/Saída) lança com o `lote_id`, e a Saída com lote também confere o saldo do
 * lote (a mesma regra do saldo negativo). O item sem lote de produto com saldo de lote vai ao motor sem lote: a saída
 * (a Saída, e a diferença negativa do "Definir") é dividida em FEFO pelo motor, e a entrada (a positiva) fica sem lote.
 * Cada item é um documento do motor, e `ordenarChaves` põe na mesma linha de saldo os itens com lote antes do sem
 * lote: a quantidade do lote informado sai dele antes de a Saída sem lote ser dividida, que não o consome.
 *
 * Custo do item: `total_custo` = Σ `custo_total` dos movimentos lançados. Na divisão FEFO cada parte arredonda o custo
 * dela a 2 casas (o razão é refeito movimento a movimento, F2-B3), e o total do item e do cabeçalho tem de bater com o
 * CMV tirado do razão; a venda faz o mesmo (`custoPorItem`).
 *
 * Mudança de tipo (F2-B8; ERP 13.1.4, 13.6; README da API › decisão 153): cada item gera o par `MUDANCA_TIPO_ESTOQUE`
 * com o mesmo `documento_item_id`. A perna de saída, da origem (`tipoEstoqueId`), é a da Saída: custo médio da origem,
 * regra do saldo negativo (linha e lote) e divisão FEFO do item sem lote. A perna de entrada, no destino
 * (`tipoEstoqueDestinoId`), repete cada parte da saída com o lote e o custo unitário dela: o custo total sai e entra
 * igual, e o custo médio do destino é recalculado pela média ponderada. Antes do laço as linhas de saldo da origem e do
 * destino de todos os itens são travadas juntas em `ordenarChaves` (a do destino pode vir antes da da origem); as
 * linhas de lote vêm depois, no lançamento, como em todo documento. Hoje a 7300001 da transação (`travaVersao`) já
 * serializa os documentos da empresa; a ordem estável é a regra do motor para quando ela não estiver lá (SYNC 8.3). O
 * `total_custo` do item é o da perna de saída.
 */
export async function efetivarAcerto(
  tx: DbEmpresa,
  acerto: {
    id: string;
    estoqueId: string;
    tipoEstoqueId: string;
    tipoAjuste: TipoAjuste;
    /** Só na mudança de tipo: o tipo que recebe a quantidade. */
    tipoEstoqueDestinoId?: string | null;
    origem: OrigemAcerto;
    dataContagem: Date;
  },
  quem: { usuarioId: string; permiteNegativo: boolean },
  opcoes: {
    /**
     * Só na perda da transferência (`lancarPerdaTransferencia`): por item do acerto, os `TRANSF_RETORNO` que ele baixa.
     * O item sai em um `ACERTO_SAIDA` por retorno, com `estorno_de_id` = o retorno, no lote do item e ao custo do
     * retorno (`saidaDaPerdaTransferencia`), em vez da Saída comum.
     */
    retornosDaPerda?: ReadonlyMap<string, readonly RetornoDaPerda[]>;
  } = {},
): Promise<ResultadoEfetivacao> {
  // Início do documento (regra de data): a folga é medida contra ele, e um acerto grande não estoura no fim do laço.
  const inicio = new Date();
  const { rows: itens } = await tx.execute<{
    id: string;
    sequencia: number;
    produto_id: string;
    variacao_id: string | null;
    lote_id: string | null;
    quantidade_informada: string;
    custo_unitario: string | null;
  }>(sql`
    select id, sequencia, produto_id, variacao_id, lote_id, quantidade_informada::text, custo_unitario::text
      from itens_acerto_estoque where acerto_id = ${acerto.id} and excluido_em is null order by sequencia`);
  if (!itens.length) throw new ErroApi('REGRA_NEGOCIO', 'Inclua ao menos um item antes de efetivar.');
  const produtos = await conferirProdutos(
    tx,
    itens.map((i) => ({ produtoId: i.produto_id, variacaoId: i.variacao_id })),
  );
  const { rows: loja } = await tx.execute<{ id: string }>(sql`
    select id from lojas where estoque_id = ${acerto.estoqueId} and excluido_em is null order by codigo limit 1`);
  const lojaId = loja[0]?.id ?? null;
  const tipoMovimento = tipoMovimentoAcerto(acerto.origem, acerto.tipoAjuste);
  const definir = acerto.tipoAjuste === 'definir';
  // A mudança de tipo confere o saldo como a Saída (é a perna de saída que pode deixar a origem negativa).
  const mudanca = acerto.tipoAjuste === 'mudanca_tipo';
  const destinoId = mudanca ? acerto.tipoEstoqueDestinoId : null;
  if (mudanca && !destinoId) throw new Error('Mudança de tipo sem o tipo de destino');
  const comoSaida = acerto.tipoAjuste === 'saida' || mudanca;
  // Um instante só para todos os itens da Entrada/Saída: o documento inteiro lança "agora".
  const dataMovimento = definir ? acerto.dataContagem : new Date(inicio);
  const lancados: MovimentoDoDocumento[] = [];
  const chaves = ordenarChaves(
    itens.map((i) => ({
      item: i,
      estoqueId: acerto.estoqueId,
      produtoId: i.produto_id,
      variacaoId: i.variacao_id,
      tipoEstoqueId: acerto.tipoEstoqueId,
      loteId: i.lote_id,
    })),
  );
  if (destinoId) {
    // As linhas de saldo da origem e do destino (sem o lote: a de `saldos_estoque`), uma vez cada, em ordem estável.
    const linhas = new Map<string, ChaveSaldo>();
    for (const c of chaves)
      for (const tipoEstoqueId of [c.tipoEstoqueId, destinoId]) {
        const k: ChaveSaldo = {
          estoqueId: c.estoqueId,
          produtoId: c.produtoId,
          variacaoId: c.variacaoId,
          tipoEstoqueId,
        };
        linhas.set(`${k.produtoId}|${k.variacaoId ?? ''}|${k.tipoEstoqueId}`.toLowerCase(), k);
      }
    for (const k of ordenarChaves([...linhas.values()])) await travarSaldo(tx, k);
  }
  const negativos: Record<string, string[]> = {};
  let movimentos = 0;
  let totalVenda = dec(0);
  let totalCusto = dec(0);
  for (const c of chaves) {
    const it = c.item;
    const p = produtos.get(it.produto_id)!;
    // "Definir" de 0 numa linha de saldo que não existe (o produto contado zerado que nunca movimentou nela): saldo 0,
    // nada posterior e diferença 0, sem criar a linha zerada em `saldos_estoque` (a planilha leva ao "Definir" também
    // os produtos iguais ao saldo, F2-B11). O item fica no acerto: é ele que a compensação procura.
    const existente =
      definir && dec(it.quantidade_informada).isZero() ? await travarSaldoExistente(tx, c) : undefined;
    const semLinha = existente === null;
    const saldo =
      existente ?? (semLinha ? { ...c, id: '', quantidade: '0', custoMedio: '0' } : await travarSaldo(tx, c));
    const posteriores =
      definir && !semLinha ? await somaMovimentosPosteriores(tx, c, acerto.dataContagem) : '0';
    const q = quantidadeMovimentoTexto(
      acerto.tipoAjuste,
      it.quantidade_informada,
      saldo.quantidade,
      posteriores,
    );
    const saldoAnterior = saldo.quantidade;
    if (comoSaida && dec(saldoAnterior).plus(q).lt(0) && !quem.permiteNegativo) {
      negativos[`itens.${itens.indexOf(it)}.quantidade`] = [
        `Saldo insuficiente de ${p.nome}: ${Number(saldoAnterior).toLocaleString('pt-BR')} ${p.sigla}`,
      ];
      continue;
    }
    if (comoSaida && it.lote_id && !quem.permiteNegativo) {
      const doLote = await saldoDoLote(tx, { ...c, loteId: it.lote_id });
      if (dec(doLote).plus(q).lt(0)) {
        negativos[`itens.${itens.indexOf(it)}.quantidade`] = [
          `Saldo insuficiente do lote de ${p.nome}: ${Number(doLote).toLocaleString('pt-BR')} ${p.sigla}`,
        ];
        continue;
      }
    }
    // "Definir" com saldo-alvo negativo (importação do Nuvem3, migração 0007): a mesma permissão da Saída.
    if (acerto.tipoAjuste === 'definir' && dec(it.quantidade_informada).lt(0) && !quem.permiteNegativo) {
      negativos[`itens.${itens.indexOf(it)}.quantidade`] = [
        `Saldo negativo de ${p.nome} (${Number(it.quantidade_informada).toLocaleString('pt-BR')} ${p.sigla}) não permitido`,
      ];
      continue;
    }
    let custo: string;
    let custoLancado: string | null = null;
    if (!dec(q).isZero()) {
      const linha: NovoMovimento = {
        estoqueId: c.estoqueId,
        produtoId: c.produtoId,
        variacaoId: c.variacaoId,
        tipoEstoqueId: c.tipoEstoqueId,
        tipoMovimento,
        quantidade: q,
        custoUnitario:
          acerto.tipoAjuste === 'entrada' && it.custo_unitario !== null ? it.custo_unitario : null,
        custoReferencia: p.preco_custo,
        precoVenda: p.preco_venda,
        dataMovimento,
        lojaId,
        usuarioId: quem.usuarioId,
        documentoTipo: 'acerto',
        documentoId: acerto.id,
        documentoItemId: it.id,
        unidadeDocumento: p.sigla.slice(0, 6),
        loteId: it.lote_id,
      };
      const retornos = opcoes.retornosDaPerda?.get(it.id);
      if (retornos && !dec(q).eq(retornos.reduce((s, r) => s.minus(r.quantidade), dec(0))))
        throw new Error('A perda da transferência não bate com os retornos do item');
      // A Saída sem lote de produto com lote sai em um movimento por lote (FEFO), todos ao custo médio da linha. A da
      // perda da transferência sai uma por retorno, como estorno dele: no lote do retorno e ao custo dele.
      const ms = retornos
        ? (
            await lancarDocumento(
              tx,
              retornos.map((r) => ({
                ...linha,
                quantidade: decTexto(dec(r.quantidade).neg(), 3),
                custoUnitario: r.custoUnitario,
                custoReferencia: r.custoUnitario,
                estornoDeId: r.movimentoId,
              })),
              { inicioDocumento: inicio },
            )
          ).movimentos
        : await lancarMovimento(tx, saldo, linha, {
            retroativoPermitido: definir,
            inicioDocumento: inicio,
          });
      lancados.push(...ms);
      if (destinoId) {
        // A perna de entrada: cada parte da saída (um lote da divisão FEFO, ou a linha inteira) entra no destino com o
        // mesmo lote e o mesmo custo unitário. Uma linha de saldo só (já travada), lançada como um documento.
        const entradas = await lancarDocumento(
          tx,
          ms.map((m) => ({
            ...linha,
            tipoEstoqueId: destinoId,
            loteId: m.linha.loteId ?? null,
            quantidade: decTexto(dec(m.linha.quantidade).neg(), 3),
            custoUnitario: m.custoUnitario,
            custoReferencia: m.custoUnitario,
          })),
          { inicioDocumento: inicio },
        );
        lancados.push(...entradas.movimentos);
        movimentos += entradas.movimentos.length;
      }
      custo = ms[0]!.custoUnitario;
      movimentos += ms.length;
      // O sinal do "Definir" (a diferença negativa tem custo negativo no item, como a quantidade).
      const sinal = definir && dec(q).lt(0) ? -1 : 1;
      custoLancado = decTexto(ms.reduce((s, m) => s.plus(m.custoTotal), dec(0)).times(sinal), 2);
    } else {
      custo = decTexto(dec(saldo.custoMedio).gt(0) ? saldo.custoMedio : p.preco_custo, 4);
    }
    const base = acerto.tipoAjuste === 'definir' ? dec(q) : dec(q).abs();
    const tv = decTexto(base.times(p.preco_venda), 2);
    const tc = custoLancado ?? decTexto(base.times(custo), 2);
    totalVenda = totalVenda.plus(tv);
    totalCusto = totalCusto.plus(tc);
    await tx.execute(sql`
      update itens_acerto_estoque
         set saldo_anterior = ${saldoAnterior}::numeric, diferenca = ${q}::numeric, custo_unitario = ${custo}::numeric,
             preco_venda = ${p.preco_venda}::numeric, total_venda = ${tv}::numeric, total_custo = ${tc}::numeric
       where id = ${it.id}`);
  }
  if (Object.keys(negativos).length) {
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'O acerto deixaria saldo negativo. Ajuste as quantidades ou peça a um usuário Master (Configurações › Estoque › "Permite saldo negativo no ERP").',
      { campos: negativos },
    );
  }
  // Ainda em rascunho: o próprio acerto não entra na busca do "Definir" posterior (só os efetivados).
  const compensacoes = lancados.length
    ? await compensarDefinir(tx, lancados, `acerto ${await codigoDoAcerto(tx, acerto.id)}`)
    : [];
  await tx.execute(sql`
    update acertos_estoque
       set status = 'efetivado', efetivado_em = now(), efetivado_por_id = ${quem.usuarioId},
           qtd_itens = ${itens.length}, total_venda = ${totalVenda.toFixed(2)}::numeric,
           total_custo = ${totalCusto.toFixed(2)}::numeric, atualizado_por_id = ${quem.usuarioId}
     where id = ${acerto.id}`);
  return { movimentos, itens: itens.length, compensacoes: compensacoes.length };
}

/** O resumo da efetivação na auditoria: itens, movimentos e as compensações que ela lançou (F2-B4). */
export function resumoEfetivacao(r: ResultadoEfetivacao): string {
  const base = `${r.itens} item(ns), ${r.movimentos} movimento(s)`;
  return r.compensacoes
    ? `${base}, ${r.compensacoes} anulado(s) por "Definir" já efetivado de contagem posterior`
    : base;
}

/** O resumo do estorno na auditoria (sem o motivo). */
export function resumoEstorno(r: ResultadoEstorno): string {
  const base = `${r.estornos} movimento(s)`;
  return r.compensacoes
    ? `${base}, ${r.compensacoes} compensado(s) de novo contra o "Definir" anterior`
    : base;
}

async function codigoDoAcerto(tx: DbEmpresa, id: string): Promise<number> {
  const { rows } = await tx.execute<{ codigo: number }>(
    sql`select codigo from acertos_estoque where id = ${id}`,
  );
  return Number(rows[0]?.codigo);
}

/** O que o estorno lançou (auditoria). */
export interface ResultadoEstorno {
  /** `ESTORNO_ACERTO` lançados. */
  estornos: number;
  /** `ACERTO_COMPENSACAO` lançadas de novo contra o "Definir" anterior que também contou o fato (ERP 13.1.5 regra 7). */
  compensacoes: number;
}

/**
 * Estorno (ERP 13.5): um `ESTORNO_ACERTO` de sinal oposto para cada movimento do acerto (inclusive as compensações que
 * o "Definir" lançou contra vendas tardias, que passam a valer) e, desde o F2-B4, para cada compensação que **outro**
 * "Definir" lançou contra um movimento deste acerto (`compensacoesDoDocumento`: o "Definir" de contagem anterior que
 * foi anulado pelo mais novo), no item do movimento compensado; sem isso o estorno, em `now()`, desfazia o movimento
 * e deixava a compensação dele valendo. Estorno de entrada sai pelo custo médio vigente; estorno de saída entra pelo
 * custo gravado no movimento original. O estorno lança no momento do estorno (regra de data do F2-B4).
 *
 * Mudança de tipo (F2-B8; README da API › decisão 153): o par é estornado pelo par invertido, `MUDANCA_TIPO_ESTOQUE`
 * com `estorno_de_id`, e não por `ESTORNO_ACERTO`. A perna do destino sai primeiro, ao custo gravado na entrada (a
 * conta inversa da média ponderada, `custoMedioAposSaidaAoCustoTexto`: sem nada no meio, o destino volta ao custo médio
 * de antes), e a da origem entra ao custo que de fato saiu do destino. As duas andam com o mesmo custo unitário e o
 * valor do estoque a custo não muda; sem isso, a perna do destino saía ao médio dela (já misturado com o da origem) e a
 * da origem entrava ao custo original, e a diferença sumia do estoque (ou aparecia) num documento só interno. As linhas
 * de saldo são travadas antes, na ordem estável, porque o lançamento segue a ordem destino → origem.
 *
 * O fato compensado por este "Definir" que também é anterior à contagem de **outro** "Definir" efetivado (a venda
 * tardia anterior às duas contagens) não passa a valer: a contagem anterior já o tinha visto. Ele ganha uma nova
 * compensação contra esse outro "Definir", na data do fato (`fatosCompensados` + `definirPosteriores` sem este
 * acerto; migração 0018: uma compensação por "Definir"), e a contagem anterior volta a valer por inteiro (ERP 13.1.5
 * regra 7).
 *
 * Saldo negativo (mesma regra da Saída) pelo efeito **líquido** de cada linha de saldo: o estorno do movimento de um
 * "Definir" anulado e o da compensação que o anulava se cancelam, e o par estorno + nova compensação também; conferir
 * movimento a movimento recusava um estorno que não muda o saldo. O estorno volta ao lote do movimento (F2-B6), e o
 * efeito líquido de cada linha de lote (a de saldo + `lote_id`) passa pela mesma regra contra `saldoDoLote`, como a
 * Saída com lote: sem ela, o estorno da Entrada de um lote já vendido em FEFO deixava o lote negativo (e a parte sem
 * lote positiva) sem a permissão de saldo negativo, com o total da linha intacto.
 */
export async function estornarAcerto(
  tx: DbEmpresa,
  acerto: { id: string },
  quem: { usuarioId: string; permiteNegativo: boolean; motivo: string },
): Promise<ResultadoEstorno> {
  const { rows: movs } = await tx.execute<{
    id: string;
    estoque_id: string;
    loja_id: string | null;
    produto_id: string;
    variacao_id: string | null;
    tipo_estoque_id: string;
    quantidade: string;
    custo_unitario: string;
    preco_venda: string | null;
    documento_item_id: string | null;
    unidade_documento: string | null;
    lote_id: string | null;
    compensa_movimento_id: string | null;
    tipo_movimento: string;
    nome: string;
  }>(sql`
    select m.id, m.estoque_id, m.loja_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.quantidade::text,
           m.custo_unitario::text, m.preco_venda::text, m.documento_item_id, m.unidade_documento, m.lote_id,
           m.compensa_movimento_id, m.tipo_movimento, p.nome
      from movimentos_estoque m join produtos p on p.id = m.produto_id
     where m.documento_tipo = 'acerto' and m.documento_id = ${acerto.id} and m.estorno_de_id is null
       and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)`);
  // As compensações deste "Definir" cujo fato outro "Definir" efetivado também contou: compensadas de novo contra ele.
  const fatos = await fatosCompensados(
    tx,
    movs.filter((m) => m.compensa_movimento_id).map((m) => m.id),
  );
  const cobertos = await definirPosteriores(
    tx,
    fatos.map((f) => f.fato),
    { excetoAcertoId: acerto.id },
  );
  const recompensadas = new Set([...cobertos.keys()].map((i) => fatos[i]!.compensacaoId));
  for (const c of await compensacoesDoDocumento(tx, 'acerto', acerto.id)) {
    movs.push({ ...c, compensa_movimento_id: null, tipo_movimento: 'ACERTO_COMPENSACAO' });
  }
  const ordenados = ordenarChaves(
    movs.map((m) => ({
      m,
      estoqueId: m.estoque_id,
      produtoId: m.produto_id,
      variacaoId: m.variacao_id,
      tipoEstoqueId: m.tipo_estoque_id,
      // O estorno volta ao lote do movimento (F2-B6), inclusive o de cada parte da divisão FEFO.
      loteId: m.lote_id,
    })) satisfies Array<ChaveSaldo & { m: (typeof movs)[number] }>,
  );
  const chave = (c: ChaveSaldo) => `${c.estoqueId}|${c.produtoId}|${c.variacaoId ?? ''}|${c.tipoEstoqueId}`;
  const chaveLote = (c: ChaveSaldo) => `${chave(c)}|${c.loteId ?? ''}`;
  const liquido = new Map<string, Dec>();
  const liquidoLote = new Map<string, Dec>();
  for (const c of ordenados) {
    if (recompensadas.has(c.m.id)) continue;
    liquido.set(chave(c), (liquido.get(chave(c)) ?? dec(0)).minus(c.m.quantidade));
    if (c.loteId)
      liquidoLote.set(chaveLote(c), (liquidoLote.get(chaveLote(c)) ?? dec(0)).minus(c.m.quantidade));
  }
  // Mudança de tipo (F2-B8): o par é estornado pelo par invertido, também `MUDANCA_TIPO_ESTOQUE` (o replay reconhece
  // por ele a saída ao custo, `estornoDeMudancaTipo`). A perna do destino (a entrada original) sai primeiro, ao custo
  // gravado nela; a da origem entra depois, ao custo que de fato saiu do destino, achada pelo mesmo item e lote.
  const pernaMudanca = (c: (typeof ordenados)[number]) =>
    c.m.tipo_movimento === TIPO_MOVIMENTO_MUDANCA_TIPO
      ? dec(c.m.quantidade).gt(0)
        ? 'destino'
        : 'origem'
      : null;
  const parDaMudanca = (c: (typeof ordenados)[number]) =>
    `${c.m.documento_item_id ?? ''}|${c.m.lote_id ?? ''}`.toLowerCase();
  const custoSaidoDoDestino = new Map<string, string>();
  if (ordenados.some((c) => pernaMudanca(c))) {
    // As linhas de saldo travadas antes, na ordem estável, porque o lançamento sai dela (o destino antes da origem).
    const travadas = new Set<string>();
    for (const c of ordenados) {
      if (travadas.has(chave(c).toLowerCase())) continue;
      travadas.add(chave(c).toLowerCase());
      await travarSaldo(tx, c);
    }
  }
  const emOrdem = [
    ...ordenados.filter((c) => pernaMudanca(c) === 'destino'),
    ...ordenados.filter((c) => pernaMudanca(c) !== 'destino'),
  ];
  const conferidas = new Set<string>();
  const recusadas = new Set<string>();
  const negativos: string[] = [];
  const lotesNegativos: Array<{ nome: string; loteId: string; saldo: string }> = [];
  for (const c of emOrdem) {
    const k = chave(c);
    const kl = chaveLote(c);
    const saldo = await travarSaldo(tx, c);
    if (!conferidas.has(k)) {
      // Na primeira linha da chave o saldo ainda é o de antes do estorno.
      conferidas.add(k);
      const l = liquido.get(k) ?? dec(0);
      if (l.lt(0) && dec(saldo.quantidade).plus(l).lt(0) && !quem.permiteNegativo) {
        recusadas.add(k);
        negativos.push(c.m.nome);
      }
    }
    if (recusadas.has(k)) continue;
    if (c.loteId && !conferidas.has(kl)) {
      // Idem na primeira linha do lote: o estorno não divide em FEFO, então só ela e as do mesmo lote o mexem.
      conferidas.add(kl);
      const l = liquidoLote.get(kl) ?? dec(0);
      if (l.lt(0) && !quem.permiteNegativo) {
        const doLote = await saldoDoLote(tx, { ...c, loteId: c.loteId });
        if (dec(doLote).plus(l).lt(0)) {
          recusadas.add(kl);
          lotesNegativos.push({ nome: c.m.nome, loteId: c.loteId, saldo: doLote });
        }
      }
    }
    if (recusadas.has(kl)) continue;
    const q = dec(c.m.quantidade).neg();
    const perna = pernaMudanca(c);
    // A perna do destino sai ao custo gravado (a conta inversa da média, ou a saída comum quando ela não vale).
    const custoUnitario =
      perna === 'destino'
        ? c.m.custo_unitario
        : perna === 'origem'
          ? (custoSaidoDoDestino.get(parDaMudanca(c)) ?? c.m.custo_unitario)
          : q.gt(0)
            ? c.m.custo_unitario
            : null;
    const [lancado] = await lancarMovimento(tx, saldo, {
      ...c,
      tipoMovimento: perna ? TIPO_MOVIMENTO_MUDANCA_TIPO : 'ESTORNO_ACERTO',
      quantidade: q,
      custoUnitario,
      custoReferencia: c.m.custo_unitario,
      precoVenda: c.m.preco_venda,
      dataMovimento: new Date(),
      lojaId: c.m.loja_id,
      usuarioId: quem.usuarioId,
      documentoTipo: 'acerto',
      documentoId: acerto.id,
      documentoItemId: c.m.documento_item_id,
      unidadeDocumento: c.m.unidade_documento,
      estornoDeId: c.m.id,
      observacao: quem.motivo.slice(0, 255),
    });
    if (perna === 'destino' && lancado) custoSaidoDoDestino.set(parDaMudanca(c), lancado.custoUnitario);
  }
  if (negativos.length) {
    throw new ErroApi('REGRA_NEGOCIO', `O estorno deixaria saldo negativo em: ${negativos.join(', ')}.`);
  }
  if (lotesNegativos.length) {
    const { rows: nomes } = await tx.execute<{ id: string; lote: string; sigla: string }>(sql`
      select pl.id, pl.lote, u.sigla
        from produtos_lotes pl join produtos p on p.id = pl.produto_id join unidades_medida u on u.id = p.unidade_id
       where pl.id = any(${`{${lotesNegativos.map((l) => l.loteId).join(',')}}`}::uuid[])`);
    const texto = lotesNegativos.map((l) => {
      const n = nomes.find((x) => x.id === l.loteId.toLowerCase());
      const quantidade = [Number(l.saldo).toLocaleString('pt-BR'), n?.sigla].filter(Boolean).join(' ');
      return `${l.nome} (lote ${n?.lote ?? l.loteId}: ${quantidade})`;
    });
    throw new ErroApi(
      'REGRA_NEGOCIO',
      `O estorno deixaria saldo negativo no lote: ${texto.join(', ')}. Só com a permissão de saldo negativo (Master ou "Permite saldo negativo no ERP").`,
    );
  }
  const codigo = await codigoDoAcerto(tx, acerto.id);
  const novas = await lancarCompensacoes(
    tx,
    fatos.map((f) => f.fato),
    cobertos,
    (anterior) =>
      `Compensação do acerto ${anterior}: movimento anterior à contagem, compensado pelo acerto ${codigo} até o estorno dele`,
  );
  await tx.execute(sql`
    update acertos_estoque
       set status = 'estornado', estornado_em = now(), estornado_por_id = ${quem.usuarioId},
           motivo_estorno = ${quem.motivo.slice(0, 255)}, atualizado_por_id = ${quem.usuarioId}
     where id = ${acerto.id}`);
  return { estornos: movs.length, compensacoes: novas.length };
}

/**
 * Detalhe do acerto com os itens, o saldo atual (rascunho) ou o usado na efetivação, e as compensações ligadas a ele
 * (F2-B10, `compensacoesDoAcerto`).
 */
export async function detalheAcerto(
  db: DbEmpresa,
  id: string,
  verCusto: boolean,
  filtroEstoque: SQL | undefined,
): Promise<AcertoDetalhe | null> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    select a.*, e.nome as estoque_nome, t.nome as tipo_estoque_nome, td.nome as tipo_estoque_destino_nome,
           r.nome as responsavel_nome,
           au.nome as autor_nome, ef.nome as efetivado_por_nome, es.nome as estornado_por_nome,
           (select l.id from lojas l where l.estoque_id = a.estoque_id and l.excluido_em is null order by l.codigo limit 1) as loja_id
      from acertos_estoque a
      join estoques e on e.id = a.estoque_id
      join tipos_estoque t on t.id = a.tipo_estoque_id
      left join tipos_estoque td on td.id = a.tipo_estoque_destino_id
      join usuarios r on r.id = a.responsavel_id
      left join usuarios au on au.id = a.atualizado_por_id
      left join usuarios ef on ef.id = a.efetivado_por_id
      left join usuarios es on es.id = a.estornado_por_id
     where a.id = ${id} and a.excluido_em is null ${filtroEstoque ? sql`and ${filtroEstoque}` : sql``}`);
  const a = rows[0];
  if (!a) return null;
  const { rows: itens } = await db.execute<Record<string, unknown>>(sql`
    select i.id, i.sequencia, i.produto_id, i.variacao_id, i.lote_id, pl.lote, i.quantidade_informada::text as quantidade,
           i.saldo_anterior::text, i.diferenca::text, i.custo_unitario::text, i.preco_venda::text,
           i.total_venda::text, i.total_custo::text,
           s.quantidade::text as saldo_atual, s.custo_medio::text as custo_medio, p.preco_custo::text as preco_custo,
           p.preco_venda::text as preco_venda_atual
      from itens_acerto_estoque i
      join produtos p on p.id = i.produto_id
      left join produtos_lotes pl on pl.id = i.lote_id
      left join saldos_estoque s on s.estoque_id = ${a.estoque_id} and s.tipo_estoque_id = ${a.tipo_estoque_id}
                                and s.produto_id = i.produto_id and s.variacao_id is not distinct from i.variacao_id
     where i.acerto_id = ${id} and i.excluido_em is null
     order by i.sequencia`);
  const opcoes = itens.length
    ? await buscarOpcoes(
        db,
        {
          termo: '',
          ids: [...new Set(itens.map((i) => i.produto_id as string))],
          incluirInativos: true,
          limite: itens.length,
        },
        verCusto,
      )
    : [];
  const rascunho = a.status === 'rascunho';
  const tipo = a.tipo_ajuste as TipoAjuste;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const fx = (n: string, casas: number) => decTexto(n, casas);
  const itensDetalhe: ItemAcertoDetalhe[] = itens.map((i) => {
    const q = i.quantidade as string;
    const saldoAtual = ((rascunho ? i.saldo_atual : i.saldo_anterior) as string | null) ?? '0';
    const cm = dec(i.custo_medio as string | null).gt(0)
      ? (i.custo_medio as string)
      : (i.preco_custo as string);
    const custo = rascunho
      ? tipo === 'entrada' && i.custo_unitario !== null
        ? (i.custo_unitario as string)
        : cm
      : ((i.custo_unitario as string | null) ?? '0');
    const diferenca = rascunho
      ? quantidadeMovimentoTexto(tipo, q, saldoAtual)
      : ((i.diferenca as string | null) ?? '0');
    return {
      id: i.id as string,
      sequencia: i.sequencia as number,
      produtoId: i.produto_id as string,
      variacaoId: (i.variacao_id as string | null) ?? null,
      loteId: (i.lote_id as string | null) ?? null,
      lote: (i.lote as string | null) ?? null,
      produto: opcoes.find((o) => o.id === i.produto_id)!,
      quantidade: i.quantidade as string,
      saldoAtual: fx(saldoAtual, 3),
      diferenca: fx(diferenca, 3),
      custoUnitario: verCusto ? fx(custo, 4) : null,
      custoInformado:
        verCusto && rascunho && tipo === 'entrada' ? ((i.custo_unitario as string | null) ?? null) : null,
      precoVenda: rascunho ? (i.preco_venda_atual as string) : (i.preco_venda as string),
      totalVenda: i.total_venda as string,
      totalCusto: verCusto ? (i.total_custo as string) : null,
    };
  });
  const avisos: string[] = [];
  if (rascunho && tipo === 'definir' && a.loja_id) {
    const { rows: t } = await db.execute<{ offline: number; pendentes: number }>(sql`
      select count(*) filter (where ultimo_contato_em is null or ultimo_contato_em < now() - interval '5 minutes')::int as offline,
             count(*) filter (where eventos_pendentes > 0)::int as pendentes
        from terminais where loja_id = ${a.loja_id} and status in ('ativo','desativando') and excluido_em is null`);
    const offline = t[0]?.offline ?? 0;
    const pendentes = t[0]?.pendentes ?? 0;
    if (offline || pendentes)
      avisos.push(
        `${offline + pendentes} PDV(s) da loja estão offline ou com eventos pendentes; vendas ainda não recebidas serão compensadas automaticamente.`,
      );
  }
  // As compensações ligadas ao acerto (F2-B10): só o efetivado ou estornado tem movimento.
  const compensacoes = rascunho
    ? { compensacoes: [], total: 0 }
    : await compensacoesDoAcerto(db, a.id as string, verCusto);
  return {
    id: a.id as string,
    versao: a.versao as number,
    criadoEm: iso(a.criado_em)!,
    atualizadoEm: iso(a.atualizado_em)!,
    atualizadoPorNome: (a.autor_nome as string | null) ?? null,
    codigo: a.codigo as number,
    estoqueId: a.estoque_id as string,
    estoqueNome: a.estoque_nome as string,
    lojaId: (a.loja_id as string | null) ?? null,
    tipoEstoqueId: a.tipo_estoque_id as string,
    tipoEstoqueNome: a.tipo_estoque_nome as string,
    tipoAjuste: tipo,
    tipoEstoqueDestinoId: (a.tipo_estoque_destino_id as string | null) ?? null,
    tipoEstoqueDestinoNome: (a.tipo_estoque_destino_nome as string | null) ?? null,
    dataContagem: iso(a.data_contagem)!,
    motivo: a.motivo as string,
    responsavelId: a.responsavel_id as string,
    responsavelNome: a.responsavel_nome as string,
    observacoes: (a.observacoes as string | null) ?? null,
    origem: a.origem as OrigemAcerto,
    status: a.status as AcertoDetalhe['status'],
    efetivadoEm: iso(a.efetivado_em),
    efetivadoPorNome: (a.efetivado_por_nome as string | null) ?? null,
    estornadoEm: iso(a.estornado_em),
    estornadoPorNome: (a.estornado_por_nome as string | null) ?? null,
    motivoEstorno: (a.motivo_estorno as string | null) ?? null,
    qtdItens: a.qtd_itens as number,
    totalVenda: a.total_venda as string,
    totalCusto: verCusto ? (a.total_custo as string) : null,
    itens: itensDetalhe,
    avisos,
    compensacoes: compensacoes.compensacoes,
    totalCompensacoes: compensacoes.total,
  };
}

/**
 * Relatório de conferência do "Definir" (F2-B11; F2-Q6 = D47, decidida pelo dono em 05/11/2026, ajustável; README da API ›
 * decisão 156): por item, o contado, o saldo do sistema na hora da contagem e a diferença valorizada a custo, e o
 * veredito pela tolerância (`avaliarConferencia`). `null` = acerto inexistente ou fora dos estoques visíveis.
 *
 * - **Efetivado:** o saldo na hora da contagem é `contado − diferença gravada − compensado`: a diferença gravada é a
 *   da efetivação (que já descontou os movimentos posteriores), e cada compensação lançada por este "Definir" é um
 *   fato anterior à contagem que só chegou depois (a venda offline, F2-B4): o sistema "na hora" já devia tê-lo. Sem
 *   isso, a venda offline anterior à contagem aparecia como falta na conferência e sumia do saldo.
 * - **Rascunho:** estimativa com o saldo de agora menos os movimentos posteriores à contagem (a conta da efetivação);
 *   custo: o médio da linha ou, sem ele, o preço de custo, como no detalhe.
 * - **Estornado** ou outro tipo de ajuste → 422 (`REGRA_NEGOCIO`).
 */
export async function conferenciaAcerto(
  db: DbEmpresa,
  id: string,
  verCusto: boolean,
  filtroEstoque: SQL | undefined,
  tolerancias: { totalPct: string; itemPct: string },
): Promise<ConferenciaAcerto | null> {
  const { rows } = await db.execute<{
    id: string;
    codigo: number;
    status: string;
    tipo_ajuste: string;
    data_contagem: Date;
    estoque_nome: string;
    tipo_estoque_nome: string;
  }>(sql`
    select a.id, a.codigo, a.status, a.tipo_ajuste, a.data_contagem, e.nome as estoque_nome,
           t.nome as tipo_estoque_nome
      from acertos_estoque a
      join estoques e on e.id = a.estoque_id
      join tipos_estoque t on t.id = a.tipo_estoque_id
     where a.id = ${id} and a.excluido_em is null ${filtroEstoque ? sql`and ${filtroEstoque}` : sql``}`);
  const a = rows[0];
  if (!a) return null;
  if (a.tipo_ajuste !== 'definir')
    throw new ErroApi('REGRA_NEGOCIO', 'A conferência é do acerto "Definir" (a contagem).');
  if (a.status === 'estornado')
    throw new ErroApi('REGRA_NEGOCIO', 'Acerto estornado: a contagem não vale mais e não tem conferência.');
  const rascunho = a.status === 'rascunho';
  const { rows: itens } = await db.execute<{
    id: string;
    produto_id: string;
    codigo: number;
    nome: string;
    sigla: string;
    contado: string;
    sistema: string;
    compensado: string;
    custo: string;
  }>(
    rascunho
      ? sql`
    select i.id, i.produto_id, p.codigo, p.nome, u.sigla, i.quantidade_informada::text as contado,
           (coalesce(s.quantidade, 0) - coalesce((
              select sum(m.quantidade) from movimentos_estoque m
               where m.estoque_id = a.estoque_id and m.produto_id = i.produto_id
                 and m.variacao_id is not distinct from i.variacao_id and m.tipo_estoque_id = a.tipo_estoque_id
                 and m.data_movimento > a.data_contagem), 0))::text as sistema,
           '0' as compensado,
           (case when coalesce(s.custo_medio, 0) > 0 then s.custo_medio else p.preco_custo end)::text as custo
      from itens_acerto_estoque i
      join acertos_estoque a on a.id = i.acerto_id
      join produtos p on p.id = i.produto_id
      join unidades_medida u on u.id = p.unidade_id
      left join saldos_estoque s on s.estoque_id = a.estoque_id and s.tipo_estoque_id = a.tipo_estoque_id
                                and s.produto_id = i.produto_id and s.variacao_id is not distinct from i.variacao_id
     where i.acerto_id = ${id} and i.excluido_em is null
     order by i.sequencia`
      : sql`
    select i.id, i.produto_id, p.codigo, p.nome, u.sigla, i.quantidade_informada::text as contado,
           (i.quantidade_informada - coalesce(i.diferenca, 0) - c.compensado)::text as sistema,
           c.compensado::text as compensado, coalesce(i.custo_unitario, 0)::text as custo
      from itens_acerto_estoque i
      join produtos p on p.id = i.produto_id
      join unidades_medida u on u.id = p.unidade_id
      cross join lateral (
        select coalesce(sum(m.quantidade), 0) as compensado from movimentos_estoque m
         where m.documento_tipo = 'acerto' and m.documento_id = i.acerto_id and m.documento_item_id = i.id
           and m.tipo_movimento = 'ACERTO_COMPENSACAO'
           and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)) c
     where i.acerto_id = ${id} and i.excluido_em is null
     order by i.sequencia`,
  );
  const r = avaliarConferencia(
    itens.map((i) => ({ contado: i.contado, saldoSistema: i.sistema, custoUnitario: i.custo })),
    tolerancias,
  );
  const lista: ItemConferencia[] = itens.map((i, n) => {
    const c = r.itens[n]!;
    return {
      itemId: i.id,
      produtoId: i.produto_id,
      produtoCodigo: Number(i.codigo),
      produtoNome: i.nome,
      unidadeSigla: i.sigla,
      contado: decTexto(i.contado, 3),
      saldoSistema: decTexto(i.sistema, 3),
      compensado: decTexto(i.compensado, 3),
      diferenca: c.diferenca,
      custoUnitario: verCusto ? decTexto(i.custo, 4) : null,
      valorContado: verCusto ? c.valorContado : null,
      valorSistema: verCusto ? c.valorSistema : null,
      valorDiferenca: verCusto ? c.valorDiferenca : null,
      diferencaPct: c.diferencaPct,
      foraTolerancia: c.foraTolerancia,
    };
  });
  // Fora da tolerância primeiro; depois a maior diferença em % (o item sem % — saldo zero — antes), e a custo.
  const ordem = lista.map((item, n) => ({ item, calc: r.itens[n]! }));
  ordem.sort(
    (x, y) =>
      Number(y.item.foraTolerancia) - Number(x.item.foraTolerancia) ||
      Number(y.calc.diferencaPct === null) - Number(x.calc.diferencaPct === null) ||
      dec(y.calc.diferencaPct).cmp(dec(x.calc.diferencaPct)) ||
      dec(y.calc.valorDiferenca).abs().cmp(dec(x.calc.valorDiferenca).abs()),
  );
  return {
    acertoId: a.id,
    codigo: Number(a.codigo),
    estoqueNome: a.estoque_nome,
    tipoEstoqueNome: a.tipo_estoque_nome,
    dataContagem: new Date(a.data_contagem).toISOString(),
    estimativa: rascunho,
    toleranciaTotalPct: tolerancias.totalPct,
    toleranciaItemPct: tolerancias.itemPct,
    valorContado: verCusto ? r.totais.valorContado : null,
    valorSistema: verCusto ? r.totais.valorSistema : null,
    valorDiferenca: verCusto ? r.totais.valorDiferenca : null,
    valorDiferencaAbsoluta: verCusto ? r.totais.valorDiferencaAbsoluta : null,
    diferencaTotalPct: r.totais.diferencaTotalPct,
    totalForaTolerancia: r.totais.totalForaTolerancia,
    itensForaTolerancia: r.totais.itensForaTolerancia,
    veredito: r.totais.veredito,
    itens: ordem.map((o) => o.item),
  };
}
