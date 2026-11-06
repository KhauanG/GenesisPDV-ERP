/**
 * Recebimento manual de mercadoria (ERP 13.3; MD 3.8.1; Fase 2, F2-B14; README da API › decisão 159): conferência do
 * cabeçalho (loja e estoque permitidos, tipo de estoque, fornecedor), gravação dos itens do rascunho com os totais e o
 * detalhe com o aviso de remessa repetida. Movimentar e estornar (F2-B15; README da API › decisão 160): o rateio e o
 * custo final dos itens e a pergunta do preço de custo são daqui; o resto é o núcleo de entrada comum com a NF-e
 * (`entrada.ts`). A tela (F2-B16; README da API › decisão 161) lê daqui os dados de compra dos produtos da grade.
 */
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  CHAVE_CUSTO_BASE_MARGEM,
  contasEntradaRecebimentoTexto,
  type BaseCustoMargem,
  type DadosCompraProdutos,
  valoresItemRecebimentoTexto,
  type AtualizarPrecoRecebimento,
  type ModoCompraAtualizaPrecoCusto,
  type CriarRecebimento,
  type ItemRecebimento,
  type ItemRecebimentoDetalhe,
  type RecebimentoDetalhe,
  type RecebimentoRemessaRepetida,
  type StatusRecebimento,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { TIPOS_SEM_ESTOQUE, resolverTipoEstoque } from '../estoques/acertos.js';
import { estoquePermitido, estoqueVisivel } from '../estoques/permitidos.js';
import { lerConfiguracoes } from '../configuracoes/valores.js';
import { opcoesPessoaPorId } from '../pessoas/fornecedores.js';
import { opcoesPorId } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  emBlocos,
  estornarEntrada,
  exigirDestinoAtivoEntrada,
  podeAlterarPrecoNaEntrada,
  lerPrecosProdutos,
  movimentarEntrada,
  resolverAtualizarPrecoCusto,
  type ItemEntrada,
  type ResultadoEntrada,
  type QuemEstorna,
  type ResultadoEstornoEntrada,
} from './entrada.js';

type Linha = Record<string, unknown>;

/** Cabeçalho conferido: o estoque, o tipo de estoque e a data já resolvidos (os padrões aplicados). */
export interface CabecalhoRecebimento {
  lojaId: string;
  estoqueId: string;
  tipoEstoqueId: string;
  fornecedorId: string;
  dataRecebimento: string;
}

const lista = (ids: readonly string[]) => `{${[...new Set(ids.map((i) => i.toLowerCase()))].join(',')}}`;

/**
 * Cabeçalho do recebimento: a loja destinatária entre as lojas permitidas e ativa; o estoque de destino (padrão: o
 * vinculado à loja) entre os permitidos para movimentar e ativo — fora deles, 403 no campo (decisão 149), como no
 * acerto —; o tipo de estoque ativo (padrão: o padrão); o fornecedor, pessoa não excluída com a categoria
 * Fornecedor (a inativa só continua no rascunho que já a tinha); e a data do documento, não futura no fuso da loja
 * destinatária (ERP 1.5, `lojas.fuso_horario`; vazia = hoje nesse fuso), com a fabricação dos itens pela mesma régua.
 * O contrato não confere o "futuro" porque não sabe a loja: em Rio Branco às 22:30 já é o dia seguinte em Brasília.
 */
export async function conferirCabecalhoRecebimento(
  tx: DbEmpresa,
  dados: Pick<
    CriarRecebimento,
    'lojaId' | 'estoqueId' | 'tipoEstoqueId' | 'fornecedorId' | 'dataRecebimento' | 'itens'
  >,
  sessao: SessaoErp,
  fornecedorAnterior: string | null = null,
): Promise<CabecalhoRecebimento> {
  const { rows: lj } = await tx.execute<{ id: string; ativa: boolean; estoque_id: string; hoje: string }>(sql`
    select id, ativa, estoque_id, (now() at time zone fuso_horario)::date::text as hoje
      from lojas where id = ${dados.lojaId} and excluido_em is null`);
  if (!lj[0]) throw erroCampo('lojaId', 'Loja não encontrada');
  if (!lojaPermitida(sessao, lj[0].id))
    throw new ErroApi('SEM_PERMISSAO', 'Você não tem acesso a esta loja.', {
      campos: { lojaId: ['Fora das suas lojas permitidas'] },
    });
  if (!lj[0].ativa) throw erroCampo('lojaId', 'Loja inativa');
  const estoqueId = (dados.estoqueId ?? lj[0].estoque_id).toLowerCase();
  const { rows: est } = await tx.execute<{ ativo: boolean }>(sql`
    select ativo from estoques where id = ${estoqueId} and excluido_em is null`);
  if (!est[0]) throw erroCampo('estoqueId', 'Estoque não encontrado');
  if (!estoquePermitido(sessao, estoqueId, 'movimentar'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
      campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
    });
  if (!est[0].ativo) throw erroCampo('estoqueId', 'Estoque inativo');
  const tipoEstoqueId = await resolverTipoEstoque(tx, dados.tipoEstoqueId);
  const { rows: f } = await tx.execute<{ ativa: boolean; fornecedor: boolean }>(sql`
    select p.ativa, exists (select 1 from pessoas_categorias c
                             where c.pessoa_id = p.id and c.categoria = 'fornecedor' and c.excluido_em is null) as fornecedor
      from pessoas p where p.id = ${dados.fornecedorId} and p.excluido_em is null`);
  if (!f[0]) throw erroCampo('fornecedorId', 'Fornecedor não encontrado');
  if (!f[0].fornecedor) throw erroCampo('fornecedorId', 'A pessoa não é fornecedor (categoria Fornecedor)');
  if (!f[0].ativa && fornecedorAnterior?.toLowerCase() !== dados.fornecedorId.toLowerCase())
    throw erroCampo('fornecedorId', 'Fornecedor inativo');
  // `AAAA-MM-DD` compara como texto.
  const hoje = lj[0].hoje;
  const dataRecebimento = dados.dataRecebimento ?? hoje;
  if (dataRecebimento > hoje) throw erroCampo('dataRecebimento', 'A data não pode ser futura');
  const campos: Record<string, string[]> = {};
  dados.itens.forEach((it, i) => {
    if (it.fabricacao !== null && it.fabricacao > hoje)
      campos[`itens.${i}.fabricacao`] = ['A fabricação não pode ser futura'];
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
  return {
    lojaId: lj[0].id,
    estoqueId,
    tipoEstoqueId,
    fornecedorId: dados.fornecedorId.toLowerCase(),
    dataRecebimento,
  };
}

type ProdutoRecebimento = {
  id: string;
  tipo: string;
  controla_estoque: boolean;
  solicita_lote_pdv: boolean;
  sigla: string;
};

type EmbalagemRecebimento = {
  id: string;
  produto_id: string;
  variacao_id: string | null;
  fator: string;
  usa_compra: boolean;
  sigla: string | null;
};

/**
 * Confere os itens: o produto existe e tem saldo próprio (combo, serviço e produzido não; "Com variações" também não,
 * enquanto as variações estão travadas, D43), o lote e a validade do produto que pede lote, e a embalagem (do produto,
 * de compra e com o mesmo fator do item). Devolve a unidade de compra de cada item. A vinculação da NF-e (F2-B20)
 * usa a mesma conferência: `indices` dá a posição de cada item no corpo (os erros saem em `itens.N.campo`) e
 * `exigeLote` diz em quais itens o lote do produto que pede lote já é obrigatório (só no item com o fator confirmado).
 */
export async function conferirItens(
  tx: DbEmpresa,
  itens: readonly Pick<ItemRecebimento, 'produtoId' | 'codigoBarrasId' | 'fator' | 'lote' | 'validade'>[],
  opcoes: { indices?: readonly number[]; exigeLote?: readonly boolean[] } = {},
): Promise<Array<string | null>> {
  const campos: Record<string, string[]> = {};
  const { rows: produtos } = itens.length
    ? await tx.execute<ProdutoRecebimento>(sql`
        select p.id, p.tipo, p.controla_estoque, p.solicita_lote_pdv, u.sigla
          from produtos p join unidades_medida u on u.id = p.unidade_id
         where p.excluido_em is null and p.id = any(${lista(itens.map((i) => i.produtoId))}::uuid[])`)
    : { rows: [] as ProdutoRecebimento[] };
  const embalagensIds = itens.flatMap((i) => (i.codigoBarrasId ? [i.codigoBarrasId] : []));
  const { rows: embalagens } = embalagensIds.length
    ? await tx.execute<EmbalagemRecebimento>(sql`
        select c.id, c.produto_id, c.variacao_id, c.fator::text, c.usa_compra, u.sigla
          from produtos_codigos_barras c left join unidades_medida u on u.id = c.unidade_id
         where c.excluido_em is null and c.id = any(${lista(embalagensIds)}::uuid[])`)
    : { rows: [] as EmbalagemRecebimento[] };
  const unidades = itens.map((it, i) => {
    const campo = (c: string) => `itens.${opcoes.indices?.[i] ?? i}.${c}`;
    const exigeLote = opcoes.exigeLote?.[i] ?? true;
    const p = produtos.find((x) => x.id === it.produtoId.toLowerCase());
    if (!p) {
      campos[campo('produtoId')] = ['Produto não encontrado'];
      return null;
    }
    if ((TIPOS_SEM_ESTOQUE as readonly string[]).includes(p.tipo))
      campos[campo('produtoId')] = [
        p.tipo === 'kit'
          ? 'Combo não tem estoque próprio: receba os componentes'
          : p.tipo === 'produzido'
            ? 'Produto produzido não tem estoque próprio: receba os insumos da ficha técnica'
            : 'Serviço não tem estoque',
      ];
    else if (p.tipo === 'com_variacoes')
      campos[campo('produtoId')] = [
        'Produto com variações: o saldo é por variação, que o recebimento ainda não lança',
      ];
    else if (!p.controla_estoque) campos[campo('produtoId')] = ['Produto sem controle de estoque'];
    if (exigeLote && p.solicita_lote_pdv && it.lote === null)
      campos[campo('lote')] = ['O produto pede lote: informe o lote'];
    if (exigeLote && p.solicita_lote_pdv && it.validade === null)
      campos[campo('validade')] = ['O produto pede lote: informe a validade'];
    if (!it.codigoBarrasId) return it.fator === '1.000' ? p.sigla : null;
    const e = embalagens.find((x) => x.id === it.codigoBarrasId!.toLowerCase());
    if (!e || e.produto_id !== p.id || e.variacao_id !== null) {
      campos[campo('codigoBarrasId')] = ['A embalagem não é deste produto'];
      return null;
    }
    if (!e.usa_compra) campos[campo('codigoBarrasId')] = ['O código não está marcado para uso na compra'];
    if (Number(e.fator) !== Number(it.fator))
      campos[campo('fator')] = [`O fator é o da embalagem (${Number(e.fator)})`];
    return e.sigla ?? (Number(e.fator) === 1 ? p.sigla : null);
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
  return unidades;
}

/**
 * Grava os itens do rascunho como o acerto: os que saíram são excluídos logicamente, os mantidos (mesmo id e mesmo
 * produto) atualizados e os novos inseridos com a sequência depois da maior já usada. O `id` repetido no corpo é
 * recusado pelo contrato; se chegar assim mesmo, a segunda linha entra como item novo (não dois UPDATEs na mesma).
 * Recalcula os totais do cabeçalho (produtos e "Total geral") **a partir das linhas gravadas**, com o frete, o
 * desconto e as outras despesas já gravados no cabeçalho: o total sempre fecha com os itens vivos, a base do rateio
 * do F2-B15. Rateios e custo final ficam para a movimentação.
 */
export async function gravarItensRecebimento(
  tx: DbEmpresa,
  recebimento: { id: string },
  dados: Pick<CriarRecebimento, 'itens'>,
): Promise<void> {
  const unidades = await conferirItens(tx, dados.itens);
  const { rows: atuais } = await tx.execute<{ id: string; produto_id: string }>(sql`
    select id, produto_id from itens_recebimento where recebimento_id = ${recebimento.id} and excluido_em is null`);
  const mantidos = new Set(
    dados.itens.flatMap((it) =>
      it.id &&
      atuais.some((a) => a.id === it.id!.toLowerCase() && a.produto_id === it.produtoId.toLowerCase())
        ? [it.id.toLowerCase()]
        : [],
    ),
  );
  const sair = atuais.filter((a) => !mantidos.has(a.id)).map((a) => a.id);
  if (sair.length)
    await tx.execute(sql`
      update itens_recebimento set excluido_em = now() where id = any(${lista(sair)}::uuid[])`);
  const { rows: seq } = await tx.execute<{ n: number }>(sql`
    select coalesce(max(sequencia), 0)::int as n from itens_recebimento where recebimento_id = ${recebimento.id}`);
  let sequencia = seq[0]?.n ?? 0;
  const atualizados = new Set<string>();
  for (const [i, it] of dados.itens.entries()) {
    const v = valoresItemRecebimentoTexto(it);
    const valores = sql`
      codigo_barras_id = ${it.codigoBarrasId}, unidade_compra = ${unidades[i] ?? null}, fator = ${it.fator}::numeric,
      quantidade = ${it.quantidade}::numeric, quantidade_estoque = ${v.quantidadeEstoque}::numeric,
      preco_compra = ${it.precoCompra}::numeric, markup_pct = ${it.markupPct}::numeric,
      preco_venda = ${it.precoVenda}::numeric, atualizar_preco = ${it.atualizarPreco}, lote = ${it.lote},
      validade = ${it.validade}::date, fabricacao = ${it.fabricacao}::date, valor_total = ${v.valorTotal}::numeric`;
    const idMantido = it.id?.toLowerCase();
    if (idMantido && mantidos.has(idMantido) && !atualizados.has(idMantido)) {
      atualizados.add(idMantido);
      await tx.execute(sql`update itens_recebimento set ${valores} where id = ${idMantido}`);
    } else {
      sequencia += 1;
      await tx.execute(sql`
        insert into itens_recebimento (id, recebimento_id, sequencia, produto_id, codigo_barras_id, unidade_compra,
                                       fator, quantidade, quantidade_estoque, preco_compra, markup_pct, preco_venda,
                                       atualizar_preco, lote, validade, fabricacao, valor_total)
        values (${uuidv7()}, ${recebimento.id}, ${sequencia}, ${it.produtoId}, ${it.codigoBarrasId},
                ${unidades[i] ?? null}, ${it.fator}::numeric, ${it.quantidade}::numeric,
                ${v.quantidadeEstoque}::numeric, ${it.precoCompra}::numeric, ${it.markupPct}::numeric,
                ${it.precoVenda}::numeric, ${it.atualizarPreco}, ${it.lote}, ${it.validade}::date,
                ${it.fabricacao}::date, ${v.valorTotal}::numeric)`);
    }
  }
  // Os mesmos números de `totaisRecebimentoTexto` (cada item já está a 2 casas em `valor_total`).
  await tx.execute(sql`
    update recebimentos r
       set qtd_itens = s.n, valor_produtos = s.produtos,
           valor_total = s.produtos + r.valor_frete + r.valor_outras_despesas - r.valor_desconto
      from (select count(*)::int as n, coalesce(sum(valor_total), 0) as produtos
              from itens_recebimento where recebimento_id = ${recebimento.id} and excluido_em is null) s
     where r.id = ${recebimento.id}`);
}

/**
 * Os outros recebimentos do fornecedor com o mesmo "Cód. remessa" (sem diferenciar maiúsculas nem espaços nas
 * pontas), menos os estornados (a remessa estornada pode entrar de novo) e o próprio.
 */
export async function remessasRepetidas(
  db: DbEmpresa,
  r: { id: string | null; fornecedorId: string; codigoRemessa: string | null },
): Promise<RecebimentoRemessaRepetida[]> {
  if (!r.codigoRemessa) return [];
  const { rows } = await db.execute<Linha>(sql`
    select id, codigo, data_recebimento::text, status from recebimentos
     where fornecedor_id = ${r.fornecedorId} and excluido_em is null and status <> 'estornado'
       and lower(trim(codigo_remessa)) = lower(trim(${r.codigoRemessa}))
       ${r.id ? sql`and id <> ${r.id}` : sql``}
     order by codigo
     limit 20`);
  return rows.map((x) => ({
    id: x.id as string,
    codigo: x.codigo as number,
    dataRecebimento: x.data_recebimento as string,
    status: x.status as StatusRecebimento,
  }));
}

/** O aviso de remessa repetida (ERP 13.3), com os números dos outros recebimentos. */
export function avisoRemessa(codigoRemessa: string | null, repetidas: readonly RecebimentoRemessaRepetida[]) {
  if (!repetidas.length) return [];
  const nums = repetidas.map((r) => `Nº ${r.codigo}`).join(', ');
  return [
    `O Cód. remessa "${codigoRemessa}" já foi usado para este fornecedor (recebimento ${nums}). Confira se a entrada não está repetida.`,
  ];
}

/** Versão do documento inteiro (cabeçalho + itens, inclusive excluídos; decisão 47, como o acerto). */
export const sqlVersaoRecebimento = sql`greatest(r.versao, coalesce((select max(i.versao) from itens_recebimento i where i.recebimento_id = r.id), 0))`;

/**
 * Detalhe do recebimento; `null` = inexistente, excluído ou fora dos estoques visíveis. Os preços de compra são o
 * conteúdo do documento e saem com `recebimentos.ver` (decisão 159); o custo do produto (`preco_custo`, custo médio)
 * nas opções de produto e o markup gravado no item (que, com o preço de venda, revela a base) continuam exigindo
 * `produtos.ver_custo`.
 */
export async function detalheRecebimento(
  db: DbEmpresa,
  id: string,
  sessao: SessaoErp,
  filtroEstoque: SQL | undefined,
): Promise<RecebimentoDetalhe | null> {
  const { rows } = await db.execute<Linha>(sql`
    select r.*, r.data_recebimento::text as data_texto, r.valor_produtos::text as v_produtos,
           r.valor_frete::text as v_frete, r.valor_desconto::text as v_desconto,
           r.valor_outras_despesas::text as v_outras, r.valor_total::text as v_total,
           l.nome as loja_nome, e.nome as estoque_nome, t.nome as tipo_estoque_nome,
           au.nome as autor_nome, mv.nome as movimentado_por_nome, es.nome as estornado_por_nome,
           ${sqlVersaoRecebimento} as versao_documento
      from recebimentos r
      join lojas l on l.id = r.loja_id
      join estoques e on e.id = r.estoque_id
      join tipos_estoque t on t.id = r.tipo_estoque_id
      left join usuarios au on au.id = r.atualizado_por_id
      left join usuarios mv on mv.id = r.movimentado_por_id
      left join usuarios es on es.id = r.estornado_por_id
     where r.id = ${id} and r.excluido_em is null ${filtroEstoque ? sql`and ${filtroEstoque}` : sql``}`);
  const r = rows[0];
  if (!r) return null;
  const { rows: itens } = await db.execute<Linha>(sql`
    select i.id, i.sequencia, i.produto_id, i.codigo_barras_id, c.codigo as codigo_barras, i.unidade_compra,
           i.fator::text, i.quantidade::text, i.quantidade_estoque::text, i.preco_compra::text, i.markup_pct::text,
           i.preco_venda::text, i.atualizar_preco, i.lote, i.validade::text, i.fabricacao::text, i.lote_id,
           i.rateio_frete::text, i.rateio_desconto::text, i.rateio_outras::text, i.custo_unitario_final::text,
           i.valor_total::text
      from itens_recebimento i
      left join produtos_codigos_barras c on c.id = i.codigo_barras_id
     where i.recebimento_id = ${id} and i.excluido_em is null
     order by i.sequencia`);
  // Inclusive o produto excluído depois de entrar no documento (a exclusão só olha o saldo): o item continua legível,
  // e no rascunho pode ser tirado (regravar sem ele) — a conferência dos itens só recusa o produto enviado.
  const verCusto = sessao.permissoes.has('produtos.ver_custo');
  const opcoes = await opcoesPorId(
    db,
    itens.map((i) => i.produto_id as string),
    verCusto,
  );
  const fornecedores = await opcoesPessoaPorId(db, [r.fornecedor_id as string], {
    semDocumento: !sessao.permissoes.has('pessoas.ver'),
  });
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const texto = (v: unknown) => (v as string | null) ?? null;
  const itensDetalhe: ItemRecebimentoDetalhe[] = itens.map((i) => ({
    id: i.id as string,
    sequencia: i.sequencia as number,
    produtoId: i.produto_id as string,
    produto: opcoes.get(i.produto_id as string)!,
    codigoBarrasId: texto(i.codigo_barras_id),
    codigoBarras: texto(i.codigo_barras),
    unidadeCompra: texto(i.unidade_compra),
    fator: i.fator as string,
    quantidade: i.quantidade as string,
    quantidadeEstoque: i.quantidade_estoque as string,
    precoCompra: i.preco_compra as string,
    // Com o preço de venda, o markup gravado revela a base (o custo médio ou o preço de custo do cadastro): só com
    // `produtos.ver_custo` (decisão 161).
    markupPct: verCusto ? texto(i.markup_pct) : null,
    precoVenda: texto(i.preco_venda),
    atualizarPreco: i.atualizar_preco as AtualizarPrecoRecebimento,
    lote: texto(i.lote),
    validade: texto(i.validade),
    fabricacao: texto(i.fabricacao),
    loteId: texto(i.lote_id),
    rateioFrete: i.rateio_frete as string,
    rateioDesconto: i.rateio_desconto as string,
    rateioOutras: i.rateio_outras as string,
    custoUnitarioFinal: i.custo_unitario_final as string,
    valorTotal: i.valor_total as string,
  }));
  const codigoRemessa = texto(r.codigo_remessa);
  const repetidas = await remessasRepetidas(db, {
    id,
    fornecedorId: r.fornecedor_id as string,
    codigoRemessa,
  });
  return {
    id: r.id as string,
    versao: Number(r.versao_documento),
    criadoEm: iso(r.criado_em)!,
    atualizadoEm: iso(r.atualizado_em)!,
    atualizadoPorNome: texto(r.autor_nome),
    codigo: r.codigo as number,
    lojaId: r.loja_id as string,
    lojaNome: r.loja_nome as string,
    estoqueId: r.estoque_id as string,
    estoqueNome: r.estoque_nome as string,
    tipoEstoqueId: r.tipo_estoque_id as string,
    tipoEstoqueNome: r.tipo_estoque_nome as string,
    fornecedorId: r.fornecedor_id as string,
    fornecedor: fornecedores.get(r.fornecedor_id as string)!,
    dataRecebimento: r.data_texto as string,
    codigoRemessa,
    temValidade: r.tem_validade as boolean,
    observacoes: texto(r.observacoes),
    status: r.status as StatusRecebimento,
    movimentadoEm: iso(r.movimentado_em),
    movimentadoPorNome: texto(r.movimentado_por_nome),
    estornadoEm: iso(r.estornado_em),
    estornadoPorNome: texto(r.estornado_por_nome),
    motivoEstorno: texto(r.motivo_estorno),
    qtdItens: r.qtd_itens as number,
    valorProdutos: r.v_produtos as string,
    valorFrete: r.v_frete as string,
    valorDesconto: r.v_desconto as string,
    valorOutrasDespesas: r.v_outras as string,
    valorTotal: r.v_total as string,
    itens: itensDetalhe,
    remessaRepetida: repetidas,
    avisos: avisoRemessa(codigoRemessa, repetidas),
  };
}

// ---------------------------------------------------------------- Movimentar e estornar (F2-B15)

/** O cabeçalho que a movimentação e o estorno leem (o recebimento já travado pelo controller). */
export interface RecebimentoAMovimentar {
  id: string;
  codigo: number;
  lojaId: string;
  estoqueId: string;
  tipoEstoqueId: string;
  fornecedorId: string;
  dataRecebimento: string;
  valorFrete: string;
  valorDesconto: string;
  valorOutrasDespesas: string;
}

export async function lerRecebimentoAMovimentar(tx: DbEmpresa, id: string): Promise<RecebimentoAMovimentar> {
  const { rows } = await tx.execute<Linha>(sql`
    select id, codigo, loja_id, estoque_id, tipo_estoque_id, fornecedor_id, data_recebimento::text as data,
           valor_frete::text as frete, valor_desconto::text as desconto, valor_outras_despesas::text as outras
      from recebimentos where id = ${id}`);
  const r = rows[0]!;
  return {
    id: r.id as string,
    codigo: r.codigo as number,
    lojaId: r.loja_id as string,
    estoqueId: r.estoque_id as string,
    tipoEstoqueId: r.tipo_estoque_id as string,
    fornecedorId: r.fornecedor_id as string,
    dataRecebimento: r.data as string,
    valorFrete: r.frete as string,
    valorDesconto: r.desconto as string,
    valorOutrasDespesas: r.outras as string,
  };
}

/** O que a movimentação fez (auditoria e resposta). */
export interface ResultadoMovimentacao extends ResultadoEntrada {
  itens: number;
}

const documentoRecebimento = (r: RecebimentoAMovimentar) =>
  ({
    documentoTipo: 'recebimento',
    documentoId: r.id,
    tipoMovimento: 'RECEB_MANUAL',
    tipoEstorno: 'ESTORNO_RECEB_MANUAL',
    origemPreco: 'recebimento',
    rotulo: `recebimento Nº ${r.codigo}`,
    estoqueId: r.estoqueId,
    tipoEstoqueId: r.tipoEstoqueId,
    lojaId: r.lojaId,
    fornecedorId: r.fornecedorId,
    dataDocumento: r.dataRecebimento,
  }) as const;

/**
 * Movimenta o recebimento **já travado** em rascunho (ERP 13.3 "Salvar e movimentar"): confere de novo os itens (o
 * produto e a embalagem podem ter mudado depois do rascunho), rateia o frete, o desconto e as outras despesas pelo
 * total de cada item e calcula o custo final (`contasEntradaRecebimentoTexto`), resolve a pergunta do preço de custo
 * (`estoque.compra_atualiza_preco_custo`: 'sempre', 'nunca' ou 'perguntar' com a resposta de quem movimenta e tem
 * `produtos.ver_custo`; sem resposta e com algum preço de custo diferente, 422 em `atualizarPrecoCusto` com os
 * produtos em `detalhes`; sem a permissão, o preço de custo fica), passa
 * pelo núcleo de entrada e grava rateios, custo final e lote nos itens **antes** de mudar a situação (o trigger só deixa
 * mexer nos itens em rascunho).
 */
export async function movimentarRecebimento(
  tx: DbEmpresa,
  r: RecebimentoAMovimentar,
  sessao: SessaoErp,
  resposta: { atualizarPrecoCusto: boolean | null },
): Promise<ResultadoMovimentacao> {
  await exigirDestinoAtivoEntrada(tx, r, {
    estoque: 'troque o estoque do rascunho',
    tipo: 'troque o tipo do rascunho ou reative o tipo antes de movimentar',
  });
  const { rows } = await tx.execute<Linha>(sql`
    select id, produto_id, codigo_barras_id, unidade_compra, fator::text, quantidade::text, quantidade_estoque::text,
           preco_compra::text, preco_venda::text, atualizar_preco, lote, validade::text, fabricacao::text
      from itens_recebimento where recebimento_id = ${r.id} and excluido_em is null
     order by sequencia`);
  if (!rows.length) throw new ErroApi('REGRA_NEGOCIO', 'Inclua ao menos um item antes de movimentar.');
  const texto = (v: unknown) => (v as string | null) ?? null;
  await conferirItens(
    tx,
    rows.map((i) => ({
      produtoId: i.produto_id as string,
      codigoBarrasId: texto(i.codigo_barras_id),
      fator: i.fator as string,
      lote: texto(i.lote),
      validade: texto(i.validade),
    })),
  );
  const itensContas = rows.map((i) => ({
    quantidade: i.quantidade as string,
    fator: i.fator as string,
    precoCompra: i.preco_compra as string,
  }));
  const contas = contasEntradaRecebimentoTexto(itensContas, r);
  const itens: ItemEntrada[] = rows.map((i, indice) => ({
    id: i.id as string,
    indice,
    produtoId: i.produto_id as string,
    unidadeCompra: texto(i.unidade_compra),
    fator: i.fator as string,
    quantidadeEstoque: i.quantidade_estoque as string,
    custoUnitario: contas[indice]!.custoUnitarioFinal,
    lote: texto(i.lote),
    validade: texto(i.validade),
    fabricacao: texto(i.fabricacao),
    precoVenda: texto(i.preco_venda),
    atualizarPreco: i.atualizar_preco as AtualizarPrecoRecebimento,
  }));
  const produtos = await lerPrecosProdutos(
    tx,
    itens.map((i) => i.produtoId),
  );
  // A pergunta do preço de custo (D49), a mesma da NF-e (`resolverAtualizarPrecoCusto`).
  const atualizarPrecoCusto = await resolverAtualizarPrecoCusto(
    tx,
    sessao.permissoes,
    itens,
    produtos,
    resposta.atualizarPrecoCusto,
  );
  const podeAlterarPreco = await podeAlterarPrecoNaEntrada(tx, sessao.permissoes);
  const resultado = await movimentarEntrada(tx, documentoRecebimento(r), itens, produtos, {
    usuarioId: sessao.usuarioId,
    atualizarPrecoCusto,
    podeAlterarPreco,
  });
  // Rateios, custo final e lote nos itens, ainda em rascunho (um UPDATE por bloco, SYNC 6.13).
  for (const bloco of emBlocos(itens))
    await tx.execute(sql`
      update itens_recebimento ir
         set rateio_frete = v.frete, rateio_desconto = v.desconto, rateio_outras = v.outras,
             custo_unitario_final = v.custo, lote_id = v.lote
        from (values ${sql.join(
          bloco.map((it) => {
            const c = contas[it.indice]!;
            return sql`(${it.id}::uuid, ${c.rateioFrete}::numeric, ${c.rateioDesconto}::numeric,
                        ${c.rateioOutras}::numeric, ${c.custoUnitarioFinal}::numeric,
                        ${resultado.lotes.get(it.id.toLowerCase()) ?? null}::uuid)`;
          }),
          sql`, `,
        )}) as v(id, frete, desconto, outras, custo, lote)
       where ir.id = v.id`);
  await tx.execute(sql`
    update recebimentos
       set status = 'movimentado', movimentado_em = now(), movimentado_por_id = ${sessao.usuarioId},
           atualizado_por_id = ${sessao.usuarioId}
     where id = ${r.id}`);
  return { ...resultado, itens: itens.length };
}

/** O resumo da movimentação na auditoria. */
export function resumoMovimentacao(r: ResultadoMovimentacao): string {
  const partes = [`${r.itens} item(ns), ${r.movimentos} movimento(s)`];
  if (r.lotesCriados) partes.push(`${r.lotesCriados} lote(s) criado(s)`);
  if (r.precosCusto) partes.push(`preço de custo atualizado em ${r.precosCusto} produto(s)`);
  if (r.precosVenda) partes.push(`${r.precosVenda} preço(s) de venda atualizado(s)`);
  if (r.vinculosCriados) partes.push(`${r.vinculosCriados} vínculo(s) com o fornecedor criado(s)`);
  if (r.vinculosAprendidos)
    partes.push(`${r.vinculosAprendidos} vínculo(s) fornecedor + código aprendido(s)`);
  if (r.compensacoes)
    partes.push(`${r.compensacoes} anulado(s) por "Definir" já efetivado de contagem posterior`);
  return partes.join(', ');
}

/**
 * Estorna o recebimento **já travado** e movimentado (ERP 13.3): o núcleo lança o `ESTORNO_RECEB_MANUAL` de cada item
 * (e das compensações contra ele), com a regra do saldo negativo (D56 com aviso: a permissão e a confirmação,
 * `conferirNegativosEstorno`); o cabeçalho fica estornado com quem, quando e o
 * motivo. O preço, o preço de custo, o vínculo com o fornecedor e o lote ficam como a movimentação os deixou.
 */
export async function estornarRecebimento(
  tx: DbEmpresa,
  r: RecebimentoAMovimentar,
  quem: QuemEstorna,
): Promise<ResultadoEstornoEntrada> {
  const resultado = await estornarEntrada(tx, documentoRecebimento(r), quem);
  await tx.execute(sql`
    update recebimentos
       set status = 'estornado', estornado_em = now(), estornado_por_id = ${quem.usuarioId},
           motivo_estorno = ${quem.motivo.slice(0, 255)}, atualizado_por_id = ${quem.usuarioId}
     where id = ${r.id}`);
  return resultado;
}

/**
 * Dados de compra dos produtos da grade (F2-B16; README da API › decisão 161): as embalagens de compra (o EAN do fardo
 * preenche o fator), se o produto pede lote ou já tem lote cadastrado (a grade mostra Lote e Validade), o saldo e o
 * custo médio no estoque × tipo de destino (a base `custo_medio` do markup) e as duas chaves que decidem a base do
 * markup (D49), e o preço de venda próprio da loja destinatária (o "preço atual" da proposta e da pergunta
 * geral/loja/não). O custo médio só com `produtos.ver_custo`; o saldo só de estoque visível (fora dele, `null`). Produto
 * inexistente ou excluído não volta (a tela já o tem pela busca).
 */
export async function dadosCompraProdutos(
  db: DbEmpresa,
  q: { produtoIds: readonly string[]; estoqueId?: string; tipoEstoqueId?: string; lojaId?: string },
  sessao: SessaoErp,
): Promise<DadosCompraProdutos> {
  const ids = lista(q.produtoIds);
  const visivel = q.estoqueId ? estoqueVisivel(sessao, sql`e.id`) : undefined;
  const { rows: est } = q.estoqueId
    ? await db.execute<{ id: string }>(sql`
        select e.id from estoques e where e.id = ${q.estoqueId} and e.excluido_em is null
          ${visivel ? sql`and ${visivel}` : sql``}`)
    : { rows: [] as Array<{ id: string }> };
  const estoqueId = est[0]?.id ?? null;
  const tipo = q.tipoEstoqueId
    ? sql`${q.tipoEstoqueId}::uuid`
    : sql`(select id from tipos_estoque where padrao and excluido_em is null limit 1)`;
  const { rows: produtos } = await db.execute<Linha>(sql`
    select p.id, p.solicita_lote_pdv,
           exists (select 1 from produtos_lotes pl
                    where pl.produto_id = p.id and pl.variacao_id is null and pl.excluido_em is null and pl.ativo
                      and (pl.estoque_id is null or pl.estoque_id = ${estoqueId}::uuid)) as tem_lotes,
           s.quantidade::text as saldo, s.custo_medio::text as custo_medio,
           (select pl.preco_venda::text from produtos_lojas pl
             where pl.produto_id = p.id and pl.loja_id = ${q.lojaId ?? null}::uuid and pl.excluido_em is null
             limit 1) as preco_loja
      from produtos p
      left join saldos_estoque s on s.produto_id = p.id and s.variacao_id is null
            and s.estoque_id = ${estoqueId}::uuid and s.tipo_estoque_id = ${tipo}
     where p.excluido_em is null and p.id = any(${ids}::uuid[])`);
  const { rows: embalagens } = await db.execute<Linha>(sql`
    select c.id, c.produto_id, c.codigo, c.descricao, u.sigla, c.fator::text
      from produtos_codigos_barras c left join unidades_medida u on u.id = c.unidade_id
     where c.excluido_em is null and c.usa_compra and c.variacao_id is null and c.produto_id = any(${ids}::uuid[])
     order by c.fator, c.codigo`);
  const verCusto = sessao.permissoes.has('produtos.ver_custo');
  const config = await lerConfiguracoes(db, [CHAVE_CUSTO_BASE_MARGEM, CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO]);
  return {
    custoBaseMargem: config.get(CHAVE_CUSTO_BASE_MARGEM) as BaseCustoMargem,
    compraAtualizaPrecoCusto: config.get(CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO) as ModoCompraAtualizaPrecoCusto,
    podeAlterarPreco: await podeAlterarPrecoNaEntrada(db, sessao.permissoes),
    produtos: produtos.map((p) => ({
      produtoId: p.id as string,
      solicitaLotePdv: p.solicita_lote_pdv as boolean,
      temLotes: p.tem_lotes as boolean,
      embalagens: embalagens
        .filter((e) => e.produto_id === p.id)
        .map((e) => ({
          id: e.id as string,
          codigo: e.codigo as string,
          descricao: (e.descricao as string | null) ?? null,
          unidadeSigla: (e.sigla as string | null) ?? null,
          fator: e.fator as string,
        })),
      // Sem linha de saldo no estoque visível: zero (o produto ainda não entrou ali).
      saldo: estoqueId ? ((p.saldo as string | null) ?? '0.000') : null,
      custoMedio: estoqueId && verCusto ? ((p.custo_medio as string | null) ?? '0.0000') : null,
      // Sem linha da loja (ou com `preco_venda` nulo, MD 3.6.9), a loja segue o geral.
      precoVendaLoja: (p.preco_loja as string | null) ?? null,
    })),
  };
}
