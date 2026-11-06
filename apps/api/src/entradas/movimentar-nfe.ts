/**
 * NF-e de fornecedor por XML: movimentar e estornar (`RECEB_NFE`/`ESTORNO_RECEB_NFE`), com a composição do custo e o
 * vínculo aprendido (Fase 2, F2-B21; ERP 13.4, 13.4.1; MD 3.6.10, 3.8.2; F2-Q8 = D49; D56; README da API › decisão
 * 169). Sem SEFAZ e sem conversão de CFOP: a nota entra pelo que o XML diz e pela vinculação confirmada (F2-B20).
 *
 * Movimentar a nota "pronta" (`movimentarNotaEntrada`) é o recebimento manual com outra origem do custo: aqui só se
 * confere de novo o que pode ter mudado desde a vinculação (o destino ativo, o produto e a embalagem, o lote do produto
 * que pede lote) e se compõe o custo de cada item pelo XML, e o resto é o núcleo de entrada comum (`entrada.ts`):
 * - o custo por unidade do produto = (vProd + vFrete + vSeg + vOutro − vDesc + vIPI + vICMSST + vFCPST) / (qCom ×
 *   fator), a 4 casas (`custoEntradaItemNfeTexto` do shared, o mesmo número que a aba de itens mostra), com o ST e o
 *   FCP-ST, o IPI e o frete com as despesas pelas chaves `estoque.custo_inclui_st/ipi/frete` da loja destinatária;
 *   `estoque.custo_abate_creditos` é ignorada (fiscal);
 * - o lançamento: um `RECEB_NFE` por item vinculado (o ignorado não entra), com `data_movimento = now()` (F2-B4), a
 *   unidade comercial do XML (uCom) e o fator, o lote do rastro achado ou criado (F2-B6) — o item com mais de um lote
 *   no `rastro`, com o lote sugerido mantido, entra em cada lote com a sua parte (`partesLoteRastroNfe`, um movimento
 *   por lote do mesmo item) —, a última compra do saldo, a
 *   pergunta do preço de custo (D49), o preço de venda proposto por item com a permissão de alterar preço e o
 *   histórico com a origem `nota_entrada`;
 * - o **vínculo aprendido** fornecedor + cProd → produto, fator e unidade (`aprenderVinculosPorCodigo`): a próxima
 *   nota do fornecedor chega com a sugestão "vínculo anterior" em todos esses itens. O código que o usuário ligou a
 *   outro produto tira o vínculo do produto antigo como o "mover vínculo" do cadastro: exige `produtos.editar` (403 no
 *   item, antes da pergunta do preço de custo) e o produto antigo ganha a auditoria `editar`
 *   (`auditarVinculosMovidosNfe`);
 * - o custo e o lote gravados em cada item **antes** de a nota virar "movimentada" (o trigger só deixa mexer nos itens
 *   da nota aberta), com a data e quem movimentou.
 *
 * Estornar (`estornarNotaEntrada`): o núcleo lança o `ESTORNO_RECEB_NFE` de cada item (e das compensações contra ele),
 * com a regra do saldo negativo do recebimento (D56 com aviso), e a nota fica "estornada" com quem, quando e o motivo.
 * O preço, o preço de custo, o vínculo aprendido e o lote ficam como a movimentação os deixou. A nota estornada não
 * volta: a chave continua ocupada (entrar de novo seria lançar a mesma nota duas vezes).
 */
import {
  custoEntradaItemNfeTexto,
  partesLoteRastroNfe,
  type AtualizarPrecoRecebimento,
  type ItemNotaEntradaDetalhe,
  type RastroNfeLido,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { fornecedoresDoProduto } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  emBlocos,
  estornarEntrada,
  exigirDestinoAtivoEntrada,
  exigirPermissaoMoverVinculos,
  lerPrecosProdutos,
  movimentarEntrada,
  podeAlterarPrecoNaEntrada,
  resolverAtualizarPrecoCusto,
  type DocumentoEntrada,
  type ItemEntrada,
  type QuemEstorna,
  type ResultadoEstornoEntrada,
  type VinculoMovidoNfe,
} from './entrada.js';
import { conferirItens, type ResultadoMovimentacao } from './recebimentos.js';
import { lerParcelasCustoNfe } from './vinculacao.js';

type Linha = Record<string, unknown>;

/** O cabeçalho que a movimentação e o estorno leem (a nota já travada pelo controller). */
export interface NotaAMovimentar {
  id: string;
  numero: number;
  serie: number;
  lojaId: string;
  estoqueId: string;
  tipoEstoqueId: string;
  fornecedorId: string;
  /** O dia da emissão no fuso da loja destinatária (`AAAA-MM-DD`): a "última compra" do vínculo com o fornecedor. */
  dataEmissao: string;
}

export async function lerNotaAMovimentar(tx: DbEmpresa, id: string): Promise<NotaAMovimentar> {
  const { rows } = await tx.execute<Linha>(sql`
    select n.id, n.numero, n.serie, n.loja_id, n.estoque_id, n.tipo_estoque_id, n.fornecedor_id,
           (n.data_emissao at time zone l.fuso_horario)::date::text as data
      from notas_entrada n join lojas l on l.id = n.loja_id
     where n.id = ${id}`);
  const n = rows[0]!;
  return {
    id: n.id as string,
    numero: n.numero as number,
    serie: n.serie as number,
    lojaId: n.loja_id as string,
    estoqueId: n.estoque_id as string,
    tipoEstoqueId: n.tipo_estoque_id as string,
    fornecedorId: n.fornecedor_id as string,
    dataEmissao: n.data as string,
  };
}

const documentoNota = (n: NotaAMovimentar): DocumentoEntrada => ({
  documentoTipo: 'nota_entrada',
  documentoId: n.id,
  tipoMovimento: 'RECEB_NFE',
  tipoEstorno: 'ESTORNO_RECEB_NFE',
  origemPreco: 'nota_entrada',
  rotulo: `NF-e Nº ${n.numero}`,
  estoqueId: n.estoqueId,
  tipoEstoqueId: n.tipoEstoqueId,
  lojaId: n.lojaId,
  fornecedorId: n.fornecedorId,
  dataDocumento: n.dataEmissao,
});

/** Os valores do item que compõem o custo (as colunas do XML, em texto). */
type ValoresCusto = Pick<
  ItemNotaEntradaDetalhe,
  | 'valorProduto'
  | 'valorFrete'
  | 'valorSeguro'
  | 'valorOutros'
  | 'valorDesconto'
  | 'valorIpi'
  | 'valorIcmsSt'
  | 'valorFcpSt'
>;

/**
 * Movimenta a nota **já travada** e "pronta" (ver o topo do módulo). Os itens vão na ordem da nota (`numero_item`) e
 * os erros saem em `itens.N.campo` com N = a posição do item na nota inteira (a mesma da aba de itens e do `PUT`).
 */
export async function movimentarNotaEntrada(
  tx: DbEmpresa,
  n: NotaAMovimentar,
  sessao: SessaoErp,
  resposta: { atualizarPrecoCusto: boolean | null },
): Promise<ResultadoMovimentacao> {
  await exigirDestinoAtivoEntrada(tx, n, {
    estoque: 'troque o estoque de destino na aba Dados',
    tipo: 'troque o tipo de estoque na aba Dados ou reative o tipo antes de movimentar',
  });
  const { rows } = await tx.execute<Linha>(sql`
    select id, codigo_fornecedor, unidade_comercial, quantidade_comercial::text, valor_produto::text,
           valor_frete::text, valor_seguro::text, valor_outros::text, valor_desconto::text, valor_ipi::text,
           valor_icms_st::text, valor_fcp_st::text, produto_id, codigo_barras_id, fator::text,
           quantidade_estoque::text, lote, validade::text, fabricacao::text, rastro, preco_venda::text,
           atualizar_preco, ignorado
      from itens_nota_entrada where nota_entrada_id = ${n.id} and excluido_em is null
     order by numero_item`);
  const texto = (v: unknown) => (v as string | null) ?? null;
  // A situação "pronta" já garante isto; conferido de novo porque é o que decide o que entra no estoque.
  const porResolver = rows.filter((i) => !i.ignorado && (!i.produto_id || i.quantidade_estoque === null));
  if (porResolver.length)
    throw new ErroApi(
      'REGRA_NEGOCIO',
      `Vincule ou ignore todos os itens (com o fator confirmado) antes de movimentar: falta(m) ${porResolver.length}.`,
    );
  const vinculados = rows.flatMap((i, indice) => (i.ignorado ? [] : [{ i, indice }]));
  if (!vinculados.length)
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Todos os itens da nota estão ignorados: não há o que movimentar (use "Ignorar nota").',
    );
  // O produto e a embalagem podem ter mudado depois da vinculação (excluído, virou combo, embalagem trocada): a mesma
  // conferência do recebimento, com o lote do produto que pede lote exigido em todos (estão todos confirmados).
  await conferirItens(
    tx,
    vinculados.map(({ i }) => ({
      produtoId: i.produto_id as string,
      codigoBarrasId: texto(i.codigo_barras_id),
      fator: i.fator as string,
      lote: texto(i.lote),
      validade: texto(i.validade),
    })),
    { indices: vinculados.map((v) => v.indice) },
  );
  const parcelas = await lerParcelasCustoNfe(tx, n.lojaId);
  const itens: ItemEntrada[] = vinculados.flatMap(({ i, indice }) => {
    const valores: ValoresCusto = {
      valorProduto: i.valor_produto as string,
      valorFrete: i.valor_frete as string,
      valorSeguro: i.valor_seguro as string,
      valorOutros: i.valor_outros as string,
      valorDesconto: i.valor_desconto as string,
      valorIpi: i.valor_ipi as string,
      valorIcmsSt: i.valor_icms_st as string,
      valorFcpSt: i.valor_fcp_st as string,
    };
    const item: ItemEntrada = {
      id: i.id as string,
      indice,
      produtoId: i.produto_id as string,
      unidadeCompra: i.unidade_comercial as string,
      fator: i.fator as string,
      quantidadeEstoque: i.quantidade_estoque as string,
      // O custo é do item inteiro (por unidade do produto): o mesmo em todas as partes do rastro.
      custoUnitario: custoEntradaItemNfeTexto(valores, i.quantidade_estoque as string, parcelas),
      lote: texto(i.lote),
      validade: texto(i.validade),
      fabricacao: texto(i.fabricacao),
      precoVenda: texto(i.preco_venda),
      atualizarPreco: i.atualizar_preco as AtualizarPrecoRecebimento,
      codigoFornecedor: i.codigo_fornecedor as string,
    };
    const partes = partesLoteRastroNfe(
      {
        lote: item.lote,
        validade: item.validade,
        fabricacao: item.fabricacao,
        rastro: (i.rastro as RastroNfeLido[] | null) ?? [],
      },
      item.quantidadeEstoque,
    );
    if (!partes) return [item];
    // Uma parte por lote: o `id` da parte é a chave do lote no resultado e o movimento leva o id do item. A partir da
    // 2ª, as datas são as do rastro (não se editam na aba): o lote já cadastrado com outra data fica com a dele.
    return partes.map((p, k) => ({
      ...item,
      id: idParte(item.id, k),
      documentoItemId: item.id,
      quantidadeEstoque: p.quantidade,
      lote: p.lote,
      validade: p.validade,
      fabricacao: p.fabricacao,
      ...(k > 0 ? { datasDoRastro: true } : {}),
    }));
  });
  // O código ligado a outro produto na vinculação muda o cadastro dele (`produtos.editar`): recusado antes da pergunta
  // do preço de custo, para quem não pode não responder a uma pergunta que não leva a nada.
  const podeMoverVinculo = sessao.permissoes.has('produtos.editar');
  await exigirPermissaoMoverVinculos(tx, n.fornecedorId, itens, podeMoverVinculo);
  const produtos = await lerPrecosProdutos(
    tx,
    itens.map((i) => i.produtoId),
  );
  const atualizarPrecoCusto = await resolverAtualizarPrecoCusto(
    tx,
    sessao.permissoes,
    itens,
    produtos,
    resposta.atualizarPrecoCusto,
  );
  const resultado = await movimentarEntrada(tx, documentoNota(n), itens, produtos, {
    usuarioId: sessao.usuarioId,
    atualizarPrecoCusto,
    podeAlterarPreco: await podeAlterarPrecoNaEntrada(tx, sessao.permissoes),
    podeMoverVinculo,
  });
  // O custo e o lote nos itens, com a nota ainda aberta (um UPDATE por bloco, SYNC 6.13); o item dividido pelo rastro
  // guarda o lote da primeira parte (o da vinculação).
  const gravar = itens.flatMap((it) =>
    it.documentoItemId === undefined
      ? [{ id: it.id, custo: it.custoUnitario, lote: resultado.lotes.get(it.id.toLowerCase()) ?? null }]
      : it.id === idParte(it.documentoItemId, 0)
        ? [
            {
              id: it.documentoItemId,
              custo: it.custoUnitario,
              lote: resultado.lotes.get(it.id.toLowerCase()) ?? null,
            },
          ]
        : [],
  );
  for (const bloco of emBlocos(gravar))
    await tx.execute(sql`
      update itens_nota_entrada i
         set custo_unitario = v.custo, lote_id = v.lote
        from (values ${sql.join(
          bloco.map((g) => sql`(${g.id}::uuid, ${g.custo}::numeric, ${g.lote}::uuid)`),
          sql`, `,
        )}) as v(id, custo, lote)
       where i.id = v.id`);
  await tx.execute(sql`
    update notas_entrada
       set status = 'movimentada', data_movimentacao = now(), movimentada_por_id = ${sessao.usuarioId},
           atualizado_por_id = ${sessao.usuarioId}
     where id = ${n.id}`);
  return { ...resultado, itens: vinculados.length };
}

/**
 * Auditoria do vínculo fornecedor + cProd que a NF-e tirou de **outro** produto (F2-B21), como a do "mover vínculo"
 * do cadastro (F2-B13): quem abre o histórico do produto antigo vê para onde o código foi e por qual nota. Uma linha
 * `editar` por produto antigo, com `antes`/`depois` dos vínculos vivos dele (o `antes` traz de volta os que saíram).
 */
export async function auditarVinculosMovidosNfe(
  auditoria: AuditoriaService,
  tx: DbEmpresa,
  origem: OrigemAcao,
  n: Pick<NotaAMovimentar, 'numero'>,
  localizacao: string,
  movidos: readonly VinculoMovidoNfe[],
): Promise<void> {
  if (!movidos.length) return;
  const { rows: novos } = await tx.execute<{ id: string; codigo: number; nome: string }>(sql`
    select id, codigo, nome from produtos
     where id = any(${`{${[...new Set(movidos.map((m) => m.produtoNovoId))].join(',')}}`}::uuid[])`);
  const nomeNovo = (id: string) => {
    const p = novos.find((x) => x.id === id);
    return p ? `${p.codigo} - ${p.nome}` : id;
  };
  const porProduto = new Map<string, VinculoMovidoNfe[]>();
  for (const m of movidos) porProduto.set(m.produtoId, [...(porProduto.get(m.produtoId) ?? []), m]);
  for (const [antigo, deste] of porProduto) {
    const destinos = deste.map((m) => `"${m.codigoFornecedor}" para o produto ${nomeNovo(m.produtoNovoId)}`);
    await auditoria.registrar(tx, origem, {
      acao: 'editar',
      entidade: 'produtos',
      registroId: antigo,
      localizacao,
      descricao: `${deste.length === 1 ? 'Vínculo do fornecedor movido' : 'Vínculos do fornecedor movidos'} pela NF-e Nº ${n.numero}: código ${destinos.join(', código ')}`,
      antes: {
        fornecedores: await fornecedoresDoProduto(
          tx,
          antigo,
          true,
          deste.map((m) => m.id),
        ),
      },
      depois: { fornecedores: await fornecedoresDoProduto(tx, antigo, true) },
    });
  }
}

/** O `id` da parte `k` do item dividido pelos lotes do rastro (só a chave do lote no resultado do núcleo). */
const idParte = (itemId: string, k: number) => `${itemId.toLowerCase()}#${k}`;

/**
 * Estorna a nota **já travada** e movimentada (ver o topo do módulo): o `ESTORNO_RECEB_NFE` de cada item pelo núcleo,
 * com a regra do saldo negativo (D56 com aviso, `conferirNegativosEstorno`), e a nota estornada com quem, quando e o
 * motivo.
 */
export async function estornarNotaEntrada(
  tx: DbEmpresa,
  n: NotaAMovimentar,
  quem: QuemEstorna,
): Promise<ResultadoEstornoEntrada> {
  const resultado = await estornarEntrada(tx, documentoNota(n), quem);
  await tx.execute(sql`
    update notas_entrada
       set status = 'estornada', estornada_em = now(), estornada_por_id = ${quem.usuarioId},
           motivo_estorno = ${quem.motivo.slice(0, 255)}, atualizado_por_id = ${quem.usuarioId}
     where id = ${n.id}`);
  return resultado;
}
