/**
 * NF-e de fornecedor por XML: vinculação dos itens aos produtos, com o fator e o fornecedor aprendido (Fase 2, F2-B20;
 * ERP 13.4.1, 8.2.14; MD 3.8.2; README da API › decisão 167). Sem migração: a vinculação usa as colunas que a
 * `0024_notas_entrada` já deixou nos itens.
 *
 * A **sugestão** de cada item é procurada nesta ordem, e só sugere produto ativo com saldo próprio (o que a vinculação
 * aceita):
 * 1. o vínculo aprendido com o fornecedor (`produtos_fornecedores`: fornecedor da nota + cProd), com o fator dele;
 * 2. o EAN do XML num código de barras do produto: o cEAN (a unidade comercial, ex.: o EAN do fardo cadastrado como
 *    código adicional com fator 12) dá o fator da embalagem; o cEANTrib (a unidade tributável, quase sempre a do
 *    produto) dá o fator da embalagem × qTrib/qCom, e o cEAN igual ao cEANTrib também (o GTIN da lata nos dois, com
 *    uCom CX: o fator 1 do código da lata daria 10 CX = 10 latas). O EAN de **variação** não sugere nada enquanto
 *    as variações estão travadas (D43: vincular ao pai baixaria o estoque errado), e o EAN em mais de um produto
 *    também não (`geral.ean_duplicado = 'avisar'` deixa repetir): o usuário escolhe;
 * 3. sem sugestão ("manual"; o "SEM GTIN" do XML cai aqui).
 *
 * A sugestão **nunca é gravada sozinha**: o detalhe a calcula na hora (o EAN cadastrado depois já aparece) e a tela
 * a mostra preenchida; o vínculo só vale gravado pelo `PUT /notas-entrada/:id/itens` com o **fator confirmado**. O
 * fator confirmado é a quantidade no estoque gravada (`quantidade_estoque` = qCom × fator, nula enquanto o fator não
 * foi confirmado) e a origem do vínculo gravado ("vínculo anterior", "EAN da embalagem" ou "manual") sai da comparação
 * com a sugestão de agora: nenhuma coluna nova. A nota fica "pronta" quando todos os itens estão vinculados com o
 * fator confirmado ou ignorados (com motivo), e volta a "pendente" quando algum deixa de estar; o CFOP não entra na
 * regra. O vínculo com o fornecedor só é aprendido ao movimentar (F2-B21, `aprenderVinculosPorCodigo` do núcleo de
 * entrada): a próxima nota do fornecedor vem com a sugestão "vínculo anterior" em todos os itens já movimentados.
 */
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  CHAVE_CUSTO_BASE_MARGEM,
  dec,
  fatorPelasQuantidadesNfe,
  quantidadeEstoqueNfeTexto,
  type BaseCustoMargem,
  type ModoCompraAtualizaPrecoCusto,
  type NotaEntradaDetalhe,
  type ParcelasCustoNfe,
  type ProdutoOpcao,
  type StatusNotaEntrada,
  type SugestaoVinculoNfe,
  type VincularItensNfe,
  type VinculoAnteriorNfe,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracoes } from '../configuracoes/valores.js';
import { TIPOS_SEM_ESTOQUE } from '../estoques/acertos.js';
import { opcoesPorId } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { emBlocos, podeAlterarPrecoNaEntrada } from './entrada.js';
import { conferirItens } from './recebimentos.js';

type Linha = Record<string, unknown>;

/** Maior valor de `numeric(15,3)` (`quantidade_estoque`). */
const MAXIMO_QUANTIDADE_ESTOQUE = '999999999999.999';

/** O que a sugestão de um item lê dele. */
export interface ItemParaSugestao {
  id: string;
  codigoFornecedor: string;
  ean: string | null;
  eanTributavel: string | null;
  quantidadeComercial: string;
  quantidadeTributavel: string | null;
}

export interface SugestaoDoItem {
  sugestao: SugestaoVinculoNfe | null;
  vinculoAnterior: VinculoAnteriorNfe | null;
}

type ProdutoSugerivel = { ativo: boolean; tipo: string; controla_estoque: boolean };

/** O produto que a vinculação aceitaria: ativo, com saldo próprio e controle de estoque (como o recebimento). */
const sugerivel = (p: ProdutoSugerivel) =>
  p.ativo &&
  p.controla_estoque &&
  p.tipo !== 'com_variacoes' &&
  !(TIPOS_SEM_ESTOQUE as readonly string[]).includes(p.tipo);

/** Um array do Postgres em texto (`{"a","b"}`), com as aspas e as barras escapadas (cProd e EAN vêm do XML). */
const arrayTexto = (v: Iterable<string>) =>
  `{${[...new Set(v)].map((x) => `"${x.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;

/**
 * As sugestões dos itens da nota (a ordem do cabeçalho do arquivo) e o vínculo aprendido de cada cProd. Duas consultas
 * para a nota inteira (os vínculos do fornecedor e os códigos de barras dos EANs), mais as opções dos produtos
 * sugeridos (`verCusto`: o custo só com `produtos.ver_custo`).
 */
export async function sugestoesVinculoNfe(
  db: DbEmpresa,
  fornecedorId: string,
  itens: readonly ItemParaSugestao[],
  verCusto: boolean,
): Promise<Map<string, SugestaoDoItem>> {
  const resultado = new Map<string, SugestaoDoItem>();
  if (!itens.length) return resultado;
  const codigos = arrayTexto(itens.map((i) => i.codigoFornecedor));
  const { rows: vinculos } = await db.execute<Linha>(sql`
    select pf.codigo_fornecedor, pf.produto_id, pf.fator::text, p.ativo, p.tipo, p.controla_estoque
      from produtos_fornecedores pf join produtos p on p.id = pf.produto_id
     where pf.fornecedor_id = ${fornecedorId} and pf.excluido_em is null and pf.variacao_id is null
       and p.excluido_em is null and pf.codigo_fornecedor = any(${codigos}::text[])`);
  const listaEans = itens.flatMap((i) => [i.ean, i.eanTributavel].filter((e): e is string => !!e));
  const eans = arrayTexto(listaEans);
  const { rows: codigosBarras } = listaEans.length
    ? await db.execute<Linha>(sql`
        select c.id, c.codigo, c.produto_id, c.variacao_id, c.fator::text, c.usa_compra, p.ativo, p.tipo,
               p.controla_estoque
          from produtos_codigos_barras c join produtos p on p.id = c.produto_id
         where c.excluido_em is null and p.excluido_em is null and c.codigo = any(${eans}::text[])
         order by c.usa_compra desc, c.principal desc, c.id`)
    : { rows: [] as Linha[] };
  /** O código do EAN que identifica um produto só (sem variação; ambíguo ou de variação = nenhum). */
  const doEan = (ean: string | null) => {
    if (!ean) return null;
    const achados = codigosBarras.filter((c) => c.codigo === ean);
    if (achados.some((c) => c.variacao_id !== null)) return null;
    const produtos = new Set(achados.map((c) => c.produto_id as string));
    if (produtos.size !== 1) return null;
    const c = achados[0]!;
    return sugerivel(c as unknown as ProdutoSugerivel) ? c : null;
  };
  const parciais = itens.map((i) => {
    const v = vinculos.find((x) => x.codigo_fornecedor === i.codigoFornecedor);
    const vinculoAnterior: VinculoAnteriorNfe | null = v
      ? { produtoId: v.produto_id as string, fator: v.fator as string }
      : null;
    let sugestao: Omit<SugestaoVinculoNfe, 'produto'> | null = null;
    if (v && sugerivel(v as unknown as ProdutoSugerivel)) {
      // A embalagem do cEAN, quando é deste produto, de compra e com o mesmo fator do vínculo.
      const c = doEan(i.ean);
      const embalagem =
        c && c.produto_id === v.produto_id && c.usa_compra && dec(c.fator as string).eq(v.fator as string)
          ? (c.id as string)
          : null;
      sugestao = {
        origem: 'vinculo_anterior',
        produtoId: v.produto_id as string,
        codigoBarrasId: embalagem,
        fator: dec(v.fator as string).toFixed(3),
      };
    } else {
      const c = doEan(i.ean);
      // O cEAN repetido no cEANTrib é o EAN da unidade tributável (comum em NF-e de bebidas: o GTIN da lata nos dois,
      // com uCom CX e qTrib/qCom = 12): vale a regra do cEANTrib, não o fator 1 do código da lata.
      const daUnidadeTributavel = c !== null && i.ean === i.eanTributavel;
      const ct = c ? (daUnidadeTributavel ? c : null) : doEan(i.eanTributavel);
      if (c && !daUnidadeTributavel)
        sugestao = {
          origem: 'ean',
          produtoId: c.produto_id as string,
          codigoBarrasId: c.usa_compra ? (c.id as string) : null,
          fator: dec(c.fator as string).toFixed(3),
        };
      else if (ct) {
        // O EAN da unidade tributável: a embalagem dela vezes quantas unidades tributáveis vêm em cada comercial. A
        // embalagem só vai quando o fator sugerido é o dela (o cEAN = cEANTrib com qTrib = qCom): com outro fator, a
        // conferência a recusaria.
        const porTrib = fatorPelasQuantidadesNfe(i.quantidadeComercial, i.quantidadeTributavel) ?? '1';
        const fator = dec(ct.fator as string)
          .times(porTrib)
          .toDecimalPlaces(3);
        const mesmoFator = fator.eq(ct.fator as string);
        if (fator.gt(0))
          sugestao = {
            origem: 'ean',
            produtoId: ct.produto_id as string,
            codigoBarrasId: ct === c && mesmoFator && ct.usa_compra ? (ct.id as string) : null,
            fator: fator.toFixed(3),
          };
      }
    }
    return { id: i.id, sugestao, vinculoAnterior };
  });
  const opcoes = await opcoesPorId(
    db,
    parciais.flatMap((p) => (p.sugestao ? [p.sugestao.produtoId] : [])),
    verCusto,
  );
  for (const p of parciais) {
    const produto: ProdutoOpcao | undefined = p.sugestao ? opcoes.get(p.sugestao.produtoId) : undefined;
    resultado.set(p.id, {
      sugestao: p.sugestao && produto ? { ...p.sugestao, produto } : null,
      vinculoAnterior: p.vinculoAnterior,
    });
  }
  return resultado;
}

/** As chaves das parcelas do custo de entrada da NF-e (F2-Q8 = D49; `estoque.custo_abate_creditos` é ignorada). */
const CHAVES_PARCELAS_CUSTO = [
  'estoque.custo_inclui_st',
  'estoque.custo_inclui_ipi',
  'estoque.custo_inclui_frete',
] as const;

const parcelasDe = (c: ReadonlyMap<string, unknown>): ParcelasCustoNfe => ({
  incluiSt: c.get('estoque.custo_inclui_st') !== false,
  incluiIpi: c.get('estoque.custo_inclui_ipi') !== false,
  incluiFrete: c.get('estoque.custo_inclui_frete') !== false,
});

/**
 * As parcelas do custo de entrada pelas chaves da loja destinatária da nota: a aba de itens (a prévia) e a
 * movimentação (o custo gravado, F2-B21) leem as mesmas, então a tela mostra o custo que vai entrar.
 */
export async function lerParcelasCustoNfe(db: DbEmpresa, lojaId: string): Promise<ParcelasCustoNfe> {
  return parcelasDe(await lerConfiguracoes(db, CHAVES_PARCELAS_CUSTO, lojaId));
}

/** O que a aba "Itens e vinculação" lê das configurações (as da loja destinatária da nota). */
export async function configuracaoVinculacao(
  db: DbEmpresa,
  lojaId: string,
  sessao: SessaoErp,
): Promise<Omit<NotaEntradaDetalhe['vinculacao'], 'resolvidos' | 'total'>> {
  const chaves = [...CHAVES_PARCELAS_CUSTO, CHAVE_CUSTO_BASE_MARGEM, CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO];
  const c = await lerConfiguracoes(db, chaves, lojaId);
  return {
    parcelasCusto: parcelasDe(c),
    custoBaseMargem: c.get(CHAVE_CUSTO_BASE_MARGEM) as BaseCustoMargem,
    compraAtualizaPrecoCusto: c.get(CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO) as ModoCompraAtualizaPrecoCusto,
    podeAlterarPreco: await podeAlterarPrecoNaEntrada(db, sessao.permissoes),
  };
}

/**
 * A situação da nota aberta pela vinculação dos itens (ERP 13.4.1): "pronta" com todos os itens vinculados com o fator
 * confirmado ou ignorados, senão "pendente". Só mexe na nota pendente ou pronta (a ignorada continua ignorada até o
 * "Reabrir"); devolve a situação depois.
 */
export async function recalcularStatusNotaEntrada(
  tx: DbEmpresa,
  notaId: string,
  usuarioId: string,
): Promise<StatusNotaEntrada> {
  const { rows } = await tx.execute<{ status: StatusNotaEntrada }>(sql`
    update notas_entrada n
       set status = s.novo, atualizado_por_id = ${usuarioId}
      from (select case when count(*) > 0
                             and count(*) filter (where not i.ignorado
                                                    and (i.produto_id is null or i.quantidade_estoque is null)) = 0
                        then 'pronta' else 'pendente' end as novo
              from itens_nota_entrada i where i.nota_entrada_id = ${notaId} and i.excluido_em is null) s
     where n.id = ${notaId} and n.status in ('pendente', 'pronta') and n.status <> s.novo
    returning n.status`);
  if (rows[0]) return rows[0].status;
  const { rows: atual } = await tx.execute<{ status: StatusNotaEntrada }>(sql`
    select status from notas_entrada where id = ${notaId}`);
  return atual[0]!.status;
}

/** Um item como está gravado (o "antes" da auditoria e a base da comparação). */
interface ItemGravado {
  id: string;
  numeroItem: number;
  quantidadeComercial: string;
  produtoId: string | null;
  codigoBarrasId: string | null;
  fator: string;
  quantidadeEstoque: string | null;
  lote: string | null;
  validade: string | null;
  fabricacao: string | null;
  markupPct: string | null;
  precoVenda: string | null;
  atualizarPreco: string;
  ignorado: boolean;
  motivoIgnorado: string | null;
}

/** O que a vinculação grava num item (as colunas livres do `tg_itens_nota_entrada_xml_imutavel`). */
type Vinculo = Omit<ItemGravado, 'id' | 'numeroItem' | 'quantidadeComercial'>;

const mesmoDecimal = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : dec(a).eq(dec(b));

function mudou(a: Vinculo, b: Vinculo): boolean {
  return (
    a.produtoId !== b.produtoId ||
    a.codigoBarrasId !== b.codigoBarrasId ||
    !mesmoDecimal(a.fator, b.fator) ||
    !mesmoDecimal(a.quantidadeEstoque, b.quantidadeEstoque) ||
    a.lote !== b.lote ||
    a.validade !== b.validade ||
    a.fabricacao !== b.fabricacao ||
    !mesmoDecimal(a.markupPct, b.markupPct) ||
    !mesmoDecimal(a.precoVenda, b.precoVenda) ||
    a.atualizarPreco !== b.atualizarPreco ||
    a.ignorado !== b.ignorado ||
    a.motivoIgnorado !== b.motivoIgnorado
  );
}

/** O resumo de um item na auditoria (o que define o vínculo). */
const resumoAuditoria = (numeroItem: number, v: Vinculo) => ({
  numeroItem,
  produtoId: v.produtoId,
  fator: v.fator,
  fatorConfirmado: v.quantidadeEstoque !== null,
  ignorado: v.ignorado,
  ...(v.ignorado ? { motivoIgnorado: v.motivoIgnorado } : {}),
  ...(v.precoVenda !== null ? { precoVenda: v.precoVenda, atualizarPreco: v.atualizarPreco } : {}),
});

export interface ResultadoVinculacao {
  alterados: number;
  statusAntes: StatusNotaEntrada;
  status: StatusNotaEntrada;
  antes: Array<ReturnType<typeof resumoAuditoria>>;
  depois: Array<ReturnType<typeof resumoAuditoria>>;
}

/**
 * `PUT /notas-entrada/:id/itens` com a nota **já travada** pendente ou pronta: confere os itens enviados (da nota, o
 * produto aceito pela mesma conferência do recebimento, a embalagem com o fator dela, o lote do produto que pede lote
 * só no item confirmado, a fabricação não futura no fuso da loja e a quantidade no estoque dentro da coluna), grava os
 * que mudaram (o item ignorado perde o vínculo; o confirmado grava qCom × fator) e recalcula a situação da nota.
 */
export async function vincularItensNotaEntrada(
  tx: DbEmpresa,
  nota: { id: string; lojaId: string; status: StatusNotaEntrada },
  usuarioId: string,
  dados: VincularItensNfe,
): Promise<ResultadoVinculacao> {
  const ids = dados.itens.map((i) => i.id.toLowerCase());
  const listaIds = `{${[...new Set(ids)].join(',')}}`;
  const { rows } = await tx.execute<Linha>(sql`
    select id, numero_item, quantidade_comercial::text, produto_id, codigo_barras_id, fator::text,
           quantidade_estoque::text, lote, validade::text, fabricacao::text, markup_pct::text, preco_venda::text,
           atualizar_preco, ignorado, motivo_ignorado
      from itens_nota_entrada
     where nota_entrada_id = ${nota.id} and excluido_em is null and id = any(${listaIds}::uuid[])`);
  const texto = (v: unknown) => (v as string | null) ?? null;
  const gravados = new Map<string, ItemGravado>(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id as string,
        numeroItem: r.numero_item as number,
        quantidadeComercial: r.quantidade_comercial as string,
        produtoId: texto(r.produto_id),
        codigoBarrasId: texto(r.codigo_barras_id),
        fator: r.fator as string,
        quantidadeEstoque: texto(r.quantidade_estoque),
        lote: texto(r.lote),
        validade: texto(r.validade),
        fabricacao: texto(r.fabricacao),
        markupPct: texto(r.markup_pct),
        precoVenda: texto(r.preco_venda),
        atualizarPreco: r.atualizar_preco as string,
        ignorado: r.ignorado as boolean,
        motivoIgnorado: texto(r.motivo_ignorado),
      },
    ]),
  );
  const campos: Record<string, string[]> = {};
  dados.itens.forEach((it, i) => {
    if (!gravados.has(ids[i]!)) campos[`itens.${i}.id`] = ['O item não é desta nota'];
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });

  // O produto e a embalagem pela conferência do recebimento (o item ignorado não confere produto).
  const vinculados = dados.itens.flatMap((it, i) => (!it.ignorado && it.produtoId ? [{ it, i }] : []));
  await conferirItens(
    tx,
    vinculados.map(({ it }) => ({
      produtoId: it.produtoId!,
      codigoBarrasId: it.codigoBarrasId,
      fator: it.fator,
      lote: it.lote,
      validade: it.validade,
    })),
    { indices: vinculados.map((v) => v.i), exigeLote: vinculados.map((v) => v.it.fatorConfirmado) },
  );
  const { rows: lj } = await tx.execute<{ hoje: string }>(sql`
    select (now() at time zone fuso_horario)::date::text as hoje from lojas where id = ${nota.lojaId}`);
  const hoje = lj[0]?.hoje ?? '9999-12-31';

  const novos = dados.itens.map((it, i): { gravado: ItemGravado; vinculo: Vinculo } => {
    const g = gravados.get(ids[i]!)!;
    const campo = (c: string) => `itens.${i}.${c}`;
    if (it.ignorado)
      return {
        gravado: g,
        vinculo: {
          produtoId: null,
          codigoBarrasId: null,
          // O lote do rastro fica como estava (o ignorado não manda lote): volta inteiro se o item deixar de ser
          // ignorado.
          fator: g.fator,
          quantidadeEstoque: null,
          lote: g.lote,
          validade: g.validade,
          fabricacao: g.fabricacao,
          markupPct: null,
          precoVenda: null,
          atualizarPreco: 'nao',
          ignorado: true,
          motivoIgnorado: it.motivoIgnorado,
        },
      };
    let quantidadeEstoque: string | null = null;
    if (it.fatorConfirmado) {
      quantidadeEstoque = quantidadeEstoqueNfeTexto(g.quantidadeComercial, it.fator);
      if (!dec(quantidadeEstoque).gt(0))
        campos[campo('fator')] = [
          'A quantidade no estoque (quantidade da nota × fator) dá zero: confira o fator ou ignore o item',
        ];
      else if (dec(quantidadeEstoque).gt(MAXIMO_QUANTIDADE_ESTOQUE))
        campos[campo('fator')] = ['Quantidade × fator passa do limite do sistema (999.999.999.999,999)'];
    }
    if (it.fabricacao !== null && it.fabricacao > hoje)
      campos[campo('fabricacao')] = ['A fabricação não pode ser futura'];
    return {
      gravado: g,
      vinculo: {
        produtoId: it.produtoId?.toLowerCase() ?? null,
        codigoBarrasId: it.produtoId ? (it.codigoBarrasId?.toLowerCase() ?? null) : null,
        fator: it.fator,
        quantidadeEstoque,
        lote: it.lote,
        validade: it.validade,
        fabricacao: it.fabricacao,
        markupPct: it.produtoId ? it.markupPct : null,
        precoVenda: it.produtoId ? it.precoVenda : null,
        atualizarPreco: it.produtoId ? it.atualizarPreco : 'nao',
        ignorado: false,
        motivoIgnorado: null,
      },
    };
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });

  const alterados = novos.filter((n) => mudou(n.gravado, n.vinculo));
  for (const bloco of emBlocos(alterados))
    await tx.execute(sql`
      update itens_nota_entrada i
         set produto_id = v.produto, codigo_barras_id = v.embalagem, fator = v.fator,
             quantidade_estoque = v.quantidade, lote = v.lote, validade = v.validade, fabricacao = v.fabricacao,
             markup_pct = v.markup, preco_venda = v.preco, atualizar_preco = v.atualizar, ignorado = v.ignorado,
             motivo_ignorado = v.motivo
        from (values ${sql.join(
          bloco.map(
            ({
              gravado: g,
              vinculo: v,
            }) => sql`(${g.id}::uuid, ${v.produtoId}::uuid, ${v.codigoBarrasId}::uuid,
              ${v.fator}::numeric, ${v.quantidadeEstoque}::numeric, ${v.lote}::varchar, ${v.validade}::date,
              ${v.fabricacao}::date, ${v.markupPct}::numeric, ${v.precoVenda}::numeric, ${v.atualizarPreco}::varchar,
              ${v.ignorado}::boolean, ${v.motivoIgnorado}::varchar)`,
          ),
          sql`, `,
        )}) as v(id, produto, embalagem, fator, quantidade, lote, validade, fabricacao, markup, preco, atualizar,
                 ignorado, motivo)
       where i.id = v.id`);
  const status = await recalcularStatusNotaEntrada(tx, nota.id, usuarioId);
  return {
    alterados: alterados.length,
    statusAntes: nota.status,
    status,
    antes: alterados.map(({ gravado: g }) => resumoAuditoria(g.numeroItem, g)),
    depois: alterados.map(({ gravado: g, vinculo: v }) => resumoAuditoria(g.numeroItem, v)),
  };
}
