/**
 * Núcleo de entrada de mercadoria (Fase 2, F2-B15; ERP 13.3, 13.4; MD 3.6.9, 3.6.10, 3.7.3, 3.8; README da API ›
 * decisão 160): o que o recebimento manual e a NF-e de fornecedor (F2-B21) fazem igual ao movimentar e ao estornar,
 * escrito uma vez. Quem chama já abriu a transação com `travaVersao` (saldos, preços e lotes descem ao PDV), travou o
 * documento e calculou o custo final de cada item, na unidade do produto (o recebimento rateia frete, desconto e outras
 * despesas, `contasEntradaRecebimentoTexto`; a NF-e compõe o custo pelo XML).
 *
 * Movimentar (`movimentarEntrada`):
 * - o lote digitado é achado ou criado em `produtos_lotes` com `estoque_id` nulo (vale em qualquer estoque; F2-B6) e o
 *   movimento é lançado com o `lote_id`;
 * - um movimento de entrada por item (`RECEB_MANUAL`/`RECEB_NFE`), quantidade = quantidade × fator, ao custo final,
 *   pelo `lancarDocumento` com `data_movimento` = o início da movimentação (regra de data, F2-B4): o custo médio
 *   ponderado, `saldos_lote` e a última compra do saldo são do motor; depois, a `compensarDefinir` (o "Definir" com a
 *   hora da contagem informada um pouco à frente anula a entrada, como no acerto);
 * - o preço de custo do produto (`produtos.preco_custo` = o custo final do último item do produto), conforme
 *   `estoque.compra_atualiza_preco_custo` (D49: 'perguntar' por padrão, a resposta vem de quem movimenta e tem
 *   `produtos.ver_custo`);
 * - o vínculo produto × fornecedor (`produtos_fornecedores`): último custo e última compra (pela data do documento,
 *   sem voltar para trás), e unidade e fator da compra no vínculo sem código; sem vínculo, cria um. O item da NF-e
 *   traz o cProd (`codigoFornecedor`, F2-B21): antes, o vínculo **aprendido** fornecedor + cProd → produto, fator e
 *   unidade da nota é gravado (`aprenderVinculosPorCodigo`), e é ele que a sugestão da próxima nota do fornecedor lê;
 * - o preço de venda por item, "geral" (`produtos.preco_venda`) ou "só da loja" (`produtos_lojas` da loja
 *   destinatária), respeitando "Altera Preço do Produto no ERP" e `produtos.alterar_preco` (a loja sem preço próprio
 *   segue o geral: o "só da loja" igual ao geral não fixa preço nenhum), com o markup refeito e o histórico de preços
 *   com a origem do documento (`recebimento`/`nota_entrada`) e o id dele. O custo do combo que o banco recalcula
 *   (trigger da 0005) entra no histórico com a mesma origem (`genesis.origem_preco`, migração 0006).
 *   Os produtos com preço alterado voltam em `precosAlterados`, e quem chama grava a auditoria `editar` de cada um com
 *   a localização da tela (`auditarPrecosEntrada`; o Histórico de produtos, ERP 16.2, os mostra como "Recebimento"
 *   ou "NF-e"; F2-B42, decisão 188).
 *   As gravações de vários produtos vão em comandos de até 500 linhas (SYNC 6.13), na mesma transação do documento.
 *
 * Estornar (`estornarEntrada`): um estorno (`ESTORNO_RECEB_*`) de cada entrada ainda não estornada, no mesmo lote, e
 * um `ESTORNO_ACERTO` de cada compensação que um "Definir" lançou contra ela (como o estorno do acerto: o
 * `ESTORNO_RECEB_*` é só saída no catálogo, `sinal = -1`, e o da compensação é uma entrada); bloqueado se deixar saldo
 * negativo na linha ou no lote, salvo Master ou `estoque.permite_negativo_erp` (D56, decidida pelo dono em 05/11/2026),
 * e mesmo com a permissão o negativo não passa em silêncio: sem `confirmarNegativo` (a lista confirmada), 422 com a
 * lista dos saldos (`conferirNegativosEstorno`; README da API › decisão 165). O estorno sai ao custo médio vigente (a
 * saída comum) e não desfaz preço, preço de custo, vínculo nem última compra: são o registro da compra lançada.
 */
import {
  CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO,
  dec,
  decTexto,
  markupPct,
  type Dec,
  type ModoCompraAtualizaPrecoCusto,
  type OrigemHistoricoPreco,
  type PrecoCustoAAtualizar,
  type SaldoNegativoConfirmado,
  type SaldoNegativoEstorno,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import { descricaoGravacaoProduto } from '../auditoria/diferenca-produto.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { produtosHistoricoPrecos } from '../database/empresa/schema/index.js';
import { compensacoesDoDocumento, compensarDefinir } from '../estoques/compensacao.js';
import {
  lancarDocumento,
  ordenarChaves,
  saldoDoLote,
  travarSaldo,
  type ChaveSaldo,
  type NovoMovimento,
} from '../estoques/movimentos.js';
import { linhasHistoricoPrecos, type LinhaHistoricoPreco } from '../produtos/gravacao.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Linhas por comando nas gravações de vários produtos (SYNC 6.13: blocos de até 500 linhas). */
export const LINHAS_POR_BLOCO_ENTRADA = 500;

/** `itens` em blocos de `tamanho` (o padrão é `LINHAS_POR_BLOCO_ENTRADA`), um comando por bloco. */
export function emBlocos<T>(itens: readonly T[], tamanho = LINHAS_POR_BLOCO_ENTRADA): T[][] {
  const blocos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) blocos.push(itens.slice(i, i + tamanho));
  return blocos;
}

const lista = (ids: Iterable<string>) => `{${[...new Set([...ids].map((i) => i.toLowerCase()))].join(',')}}`;

/** O documento de entrada, do ponto de vista do núcleo. */
export interface DocumentoEntrada {
  documentoTipo: 'recebimento' | 'nota_entrada';
  documentoId: string;
  tipoMovimento: 'RECEB_MANUAL' | 'RECEB_NFE';
  tipoEstorno: 'ESTORNO_RECEB_MANUAL' | 'ESTORNO_RECEB_NFE';
  origemPreco: Extract<OrigemHistoricoPreco, 'recebimento' | 'nota_entrada'>;
  /** Para a observação da compensação e as mensagens ("recebimento Nº 12"). */
  rotulo: string;
  estoqueId: string;
  tipoEstoqueId: string;
  /** Loja destinatária: a do preço "só da loja". */
  lojaId: string;
  fornecedorId: string;
  /** Data do documento (`AAAA-MM-DD`): a "última compra" do vínculo com o fornecedor. */
  dataDocumento: string;
}

/** Um item a lançar, já com o custo final na unidade do produto. */
export interface ItemEntrada {
  /** `documento_item_id` do movimento (sem `documentoItemId`) e a chave do lote em `ResultadoEntrada.lotes`. */
  id: string;
  /**
   * O item do documento no movimento, quando não é o `id`: a NF-e que divide o item pelos lotes do `rastro` (F2-B21)
   * manda uma parte por lote, cada uma com o seu `id` e o do item aqui (um movimento por lote do mesmo item, como a
   * divisão FEFO da venda).
   */
  documentoItemId?: string;
  /** Posição do item no documento (0, 1, …): o campo do erro, `itens.<i>.…`. */
  indice: number;
  produtoId: string;
  /** Unidade e fator da embalagem de compra (o movimento e o vínculo com o fornecedor). */
  unidadeCompra: string | null;
  fator: string;
  /** Quantidade × fator, na unidade do produto (`numeric(15,3)`). */
  quantidadeEstoque: string;
  /** Custo final por unidade do produto (`numeric(15,4)`). */
  custoUnitario: string;
  lote: string | null;
  validade: string | null;
  fabricacao: string | null;
  /**
   * A validade e a fabricação vêm do `rastro` do XML, não do que o usuário confirmou (a 2ª parte em diante do item da
   * NF-e dividido pelos lotes do rastro, F2-B21): não se editam na tela, então o lote já cadastrado com outra data não
   * é erro no item — valem as datas do cadastro do lote (`resolverLotes`).
   */
  datasDoRastro?: boolean;
  precoVenda: string | null;
  atualizarPreco: 'geral' | 'loja' | 'nao';
  /**
   * O código do produto no fornecedor (o cProd da NF-e, F2-B21): o vínculo fornecedor + código que a movimentação
   * aprende. Ausente ou nulo no recebimento manual (o vínculo dele é o sem código).
   */
  codigoFornecedor?: string | null;
}

export interface QuemMovimenta {
  usuarioId: string;
  /** A resposta à pergunta do preço de custo, já resolvida por quem chama (a chave e `produtos.ver_custo`). */
  atualizarPrecoCusto: boolean;
  /** "Altera Preço do Produto no ERP" ligada ou a permissão `produtos.alterar_preco`. */
  podeAlterarPreco: boolean;
  /**
   * `produtos.editar`: a NF-e (F2-B21) pode tirar de **outro** produto o vínculo fornecedor + cProd que o usuário ligou
   * a este (como o "mover vínculo" do cadastro, F2-B13). Sem ela, 403 no item (`exigirPermissaoMoverVinculos`). O
   * recebimento manual não manda código e não precisa dela.
   */
  podeMoverVinculo?: boolean;
}

export interface ResultadoEntrada {
  /** Item (o `id` do `ItemEntrada`) → lote lançado (achado ou criado). */
  lotes: Map<string, string>;
  movimentos: number;
  compensacoes: number;
  lotesCriados: number;
  precosCusto: number;
  precosVenda: number;
  vinculosCriados: number;
  /** Vínculos fornecedor + cProd gravados (novos, trocados de produto ou atualizados) pela NF-e (F2-B21). */
  vinculosAprendidos: number;
  /** Os vínculos fornecedor + cProd que a NF-e tirou de outro produto (para a auditoria dele, F2-B21). */
  vinculosMovidos: VinculoMovidoNfe[];
  /** Os produtos com preço de custo, de venda geral ou da loja alterado (a auditoria de cada um, F2-B42). */
  precosAlterados: PrecoAlteradoEntrada[];
}

/**
 * O preço que a entrada mudou num produto, no formato do `antes`/`depois` da auditoria do produto (os campos do
 * cadastro; o da loja na lista `lojas`, só a loja destinatária, como a diferença do cadastro a lê). O `nome`, igual
 * dos dois lados, marca a linha como do cadastro inteiro: o Histórico de produtos monta o texto da diferença no
 * escopo de quem consulta, em vez de mostrar a `descricao` gravada.
 */
export interface PrecoAlteradoEntrada {
  produtoId: string;
  antes: Record<string, unknown>;
  depois: Record<string, unknown>;
}

/** Vínculo fornecedor + cProd que a NF-e tirou de **outro** produto (F2-B21), como o "mover vínculo" do cadastro. */
export interface VinculoMovidoNfe {
  /** A linha de `produtos_fornecedores` do outro produto (excluída logicamente). */
  id: string;
  /** O outro produto, de onde o vínculo saiu. */
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  codigoFornecedor: string;
  /** O produto do item desta nota, para onde o código foi. */
  produtoNovoId: string;
  /** A posição do item na nota (o campo do erro, `itens.<i>.produtoId`). */
  indice: number;
}

/**
 * Se quem grava a entrada pode mudar o preço de venda (ERP 8.2.1): "Altera Preço do Produto no ERP"
 * (`geral.altera_preco_produto_erp`) ligada, o padrão, ou a permissão `produtos.alterar_preco`. A movimentação usa
 * para recusar o item que muda o preço (403) e a tela do recebimento, pelos dados de compra, para não perguntar
 * "geral / só desta loja" a quem não pode (README da API › decisão 165). A NF-e (F2-B21) usa a mesma regra.
 */
export async function podeAlterarPrecoNaEntrada(
  db: DbEmpresa,
  permissoes: ReadonlySet<string>,
): Promise<boolean> {
  return (
    permissoes.has('produtos.alterar_preco') ||
    (await lerConfiguracao<boolean>(db, 'geral.altera_preco_produto_erp')) !== false
  );
}

type ProdutoPreco = {
  id: string;
  nome: string;
  preco_custo: string;
  preco_venda: string;
  markup_pct: string | null;
};

/** Os produtos dos itens, travados (`for update`, em ordem de id), com os preços de agora. */
export async function lerPrecosProdutos(
  tx: DbEmpresa,
  produtoIds: Iterable<string>,
): Promise<Map<string, ProdutoPreco>> {
  const { rows } = await tx.execute<ProdutoPreco>(sql`
    select id, nome, preco_custo::text, preco_venda::text, markup_pct::text from produtos
     where id = any(${lista(produtoIds)}::uuid[])
     order by id
       for update`);
  return new Map(rows.map((r) => [r.id, r]));
}

/** O custo final do **último** item de cada produto (a ordem do documento): o "último custo" da compra. */
export function ultimoCustoPorProduto(itens: readonly ItemEntrada[]): Map<string, ItemEntrada> {
  const ultimo = new Map<string, ItemEntrada>();
  for (const it of itens) ultimo.set(it.produtoId.toLowerCase(), it);
  return ultimo;
}

/** Os produtos cujo preço de custo mudaria com a compra (a pergunta de `estoque.compra_atualiza_preco_custo`). */
export function precosCustoDiferentes(
  itens: readonly ItemEntrada[],
  produtos: ReadonlyMap<string, ProdutoPreco>,
): Array<{ produtoId: string; nome: string; atual: string; novo: string }> {
  const saida: Array<{ produtoId: string; nome: string; atual: string; novo: string }> = [];
  for (const [produtoId, it] of ultimoCustoPorProduto(itens)) {
    const p = produtos.get(produtoId);
    if (p && !dec(p.preco_custo).eq(it.custoUnitario))
      saida.push({ produtoId, nome: p.nome, atual: p.preco_custo, novo: decTexto(it.custoUnitario, 4) });
  }
  return saida;
}

/**
 * A pergunta do preço de custo (D49, `estoque.compra_atualiza_preco_custo`), a mesma no recebimento e na NF-e:
 * 'sempre' e 'nunca' valem para todos; com 'perguntar', só quem tem `produtos.ver_custo` decide (a pergunta mostra o
 * atual e o novo): sem resposta e com algum preço de custo diferente, 422 em `atualizarPrecoCusto` com os produtos em
 * `detalhes.precosCusto`; sem a permissão, a resposta não vale e o preço de custo fica (como o formulário do produto
 * descarta o `precoCusto` de quem não vê o custo e o acerto ignora o custo digitado, decisão 99).
 */
export async function resolverAtualizarPrecoCusto(
  tx: DbEmpresa,
  permissoes: ReadonlySet<string>,
  itens: readonly ItemEntrada[],
  produtos: ReadonlyMap<string, ProdutoPreco>,
  resposta: boolean | null,
): Promise<boolean> {
  const modo = await lerConfiguracao<ModoCompraAtualizaPrecoCusto>(tx, CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO);
  if (modo !== 'perguntar' || !permissoes.has('produtos.ver_custo')) return modo === 'sempre';
  const diferentes = precosCustoDiferentes(itens, produtos);
  if (diferentes.length && resposta === null) {
    const precosCusto: PrecoCustoAAtualizar[] = diferentes.map((d) => ({
      produtoId: d.produtoId,
      nome: d.nome,
      atual: d.atual,
      novo: d.novo,
    }));
    throw new ErroApi(
      'REGRA_NEGOCIO',
      `O custo desta compra é diferente do preço de custo de ${diferentes.length} produto(s): confirme se o preço de custo passa a ser o custo da compra.`,
      {
        campos: {
          atualizarPrecoCusto: ['Atualizar o preço de custo dos produtos com o custo desta compra?'],
        },
        detalhes: { precosCusto },
      },
    );
  }
  return resposta ?? false;
}

/**
 * O estoque e o tipo de estoque de destino continuam ativos (o documento só os conferiu ao ser gravado): a mercadoria
 * não entra num estoque inativado nem num tipo que sumiu dos seletores (ERP 13.6), como na efetivação do acerto.
 * `troca`: o que o usuário faz para seguir ("troque o estoque do rascunho", "troque o destino da nota").
 */
export async function exigirDestinoAtivoEntrada(
  tx: DbEmpresa,
  destino: { estoqueId: string; tipoEstoqueId: string },
  troca: { estoque: string; tipo: string },
): Promise<void> {
  const { rows } = await tx.execute<{
    estoque: string;
    estoque_ativo: boolean;
    tipo: string;
    tipo_ativo: boolean;
  }>(sql`
    select e.nome as estoque, e.ativo and e.excluido_em is null as estoque_ativo,
           t.nome as tipo, t.ativo and t.excluido_em is null as tipo_ativo
      from estoques e, tipos_estoque t
     where e.id = ${destino.estoqueId} and t.id = ${destino.tipoEstoqueId}`);
  const d = rows[0]!;
  if (!d.estoque_ativo)
    throw erroCampo('estoqueId', `O estoque "${d.estoque}" está inativo: ${troca.estoque}`, 'REGRA_NEGOCIO');
  if (!d.tipo_ativo)
    throw erroCampo(
      'tipoEstoqueId',
      `O tipo de estoque "${d.tipo}" está inativo: ${troca.tipo}`,
      'REGRA_NEGOCIO',
    );
}

/** Markup do cadastro (`numeric(9,4)`): o mesmo teto do recálculo do combo (0005); sem custo, fica o gravado. */
function markupTexto(custo: string, venda: string): string | null {
  const m = markupPct(custo, venda);
  if (m === null) return null;
  return decTexto(Math.min(Math.max(m, -99_999.9999), 99_999.9999), 4);
}

/**
 * Acha ou cria o lote de cada item com lote (MD 3.6.9): o lote vivo do produto com o mesmo texto, sem estoque ou do
 * estoque de destino (o do estoque primeiro); sem ele, cria com `estoque_id` nulo e o fornecedor do documento. A
 * validade e a fabricação vazias do lote existente são preenchidas pelo item; diferentes, 422 no item (o mesmo lote
 * do fabricante não tem duas validades), e o lote inativo volta a ativo (está recebendo mercadoria).
 */
async function resolverLotes(
  tx: DbEmpresa,
  doc: DocumentoEntrada,
  itens: readonly ItemEntrada[],
  usuarioId: string,
): Promise<{ lotes: Map<string, string>; criados: number }> {
  const lotes = new Map<string, string>();
  const porChave = new Map<string, { id: string; validade: string | null; fabricacao: string | null }>();
  const campos: Record<string, string[]> = {};
  let criados = 0;
  for (const it of itens) {
    if (it.lote === null) continue;
    const chave = `${it.produtoId.toLowerCase()}|${it.lote}`;
    let lote = porChave.get(chave);
    if (!lote) {
      const { rows } = await tx.execute<{
        id: string;
        validade: string | null;
        fabricacao: string | null;
        ativo: boolean;
      }>(sql`
        select id, validade::text, fabricacao::text, ativo from produtos_lotes
         where produto_id = ${it.produtoId} and variacao_id is null and lote = ${it.lote} and excluido_em is null
           and (estoque_id is null or estoque_id = ${doc.estoqueId})
         order by estoque_id nulls last
         limit 1
           for update`);
      if (rows[0]) {
        lote = { id: rows[0].id, validade: rows[0].validade, fabricacao: rows[0].fabricacao };
        if (!rows[0].ativo)
          await tx.execute(sql`
            update produtos_lotes set ativo = true, atualizado_por_id = ${usuarioId} where id = ${lote.id}`);
      } else {
        const { rows: novo } = await tx.execute<{ id: string }>(sql`
          insert into produtos_lotes (produto_id, lote, validade, fabricacao, fornecedor_id, criado_por_id,
                                      atualizado_por_id)
          values (${it.produtoId}, ${it.lote}, ${it.validade}::date, ${it.fabricacao}::date, ${doc.fornecedorId},
                  ${usuarioId}, ${usuarioId})
          returning id`);
        lote = { id: novo[0]!.id, validade: it.validade, fabricacao: it.fabricacao };
        criados += 1;
      }
      porChave.set(chave, lote);
    }
    // As datas do rastro (a 2ª parte em diante do item da NF-e) não se editam na tela: com o lote já cadastrado com
    // outra data, valem as do cadastro (o mesmo lote do fabricante não tem duas validades, e a do cadastro já foi
    // confirmada); o erro no item apontaria a validade da 1ª parte, que o usuário corrige sem efeito.
    const validade = it.datasDoRastro && lote.validade !== null ? lote.validade : it.validade;
    // (A fabricação do rastro que passaria da validade do cadastro fica de fora, como na divisão pelo rastro.)
    const fabricacao =
      it.datasDoRastro && lote.fabricacao !== null
        ? lote.fabricacao
        : it.datasDoRastro && it.fabricacao !== null && validade !== null && it.fabricacao > validade
          ? null
          : it.fabricacao;
    if (validade !== null && lote.validade !== null && validade !== lote.validade) {
      campos[`itens.${it.indice}.validade`] = [
        `O lote ${it.lote} já está cadastrado com a validade ${lote.validade.split('-').reverse().join('/')}`,
      ];
      continue;
    }
    if (fabricacao !== null && lote.fabricacao !== null && fabricacao !== lote.fabricacao) {
      campos[`itens.${it.indice}.fabricacao`] = [
        `O lote ${it.lote} já está cadastrado com a fabricação ${lote.fabricacao.split('-').reverse().join('/')}`,
      ];
      continue;
    }
    if ((lote.validade === null && validade !== null) || (lote.fabricacao === null && fabricacao !== null)) {
      await tx.execute(sql`
        update produtos_lotes
           set validade = coalesce(validade, ${validade}::date), fabricacao = coalesce(fabricacao, ${fabricacao}::date),
               atualizado_por_id = ${usuarioId}
         where id = ${lote.id}`);
      lote.validade ??= validade;
      lote.fabricacao ??= fabricacao;
    }
    lotes.set(it.id.toLowerCase(), lote.id);
  }
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os lotes destacados.', { campos });
  return { lotes, criados };
}

/**
 * Movimenta o documento de entrada (ver o topo do módulo). `itens` na ordem do documento, com o custo final; os
 * produtos já conferidos por quem chama (existem, têm saldo próprio). `produtos`: `lerPrecosProdutos` dos itens.
 */
export async function movimentarEntrada(
  tx: DbEmpresa,
  doc: DocumentoEntrada,
  itens: readonly ItemEntrada[],
  produtos: ReadonlyMap<string, ProdutoPreco>,
  quem: QuemMovimenta,
): Promise<ResultadoEntrada> {
  const inicio = new Date();
  // O custo do combo recalculado pelo banco (0005) entra no histórico com a origem do documento (0006).
  await tx.execute(sql.raw(`set local genesis.origem_preco = '${doc.origemPreco}'`));
  const { rows: lojaEstoque } = await tx.execute<{ id: string }>(sql`
    select id from lojas where estoque_id = ${doc.estoqueId} and excluido_em is null order by codigo limit 1`);
  const { rows: precosLoja } = await tx.execute<{ produto_id: string; preco_venda: string | null }>(sql`
    select produto_id, preco_venda::text from produtos_lojas
     where loja_id = ${doc.lojaId} and excluido_em is null and produto_id = any(${lista(itens.map((i) => i.produtoId))}::uuid[])
     order by produto_id
       for update`);
  const lojaAntes = new Map(precosLoja.map((r) => [r.produto_id, r.preco_venda]));

  // Preços de venda pedidos (o último item de cada produto com cada escolha) e a permissão de alterar preço.
  const novaGeral = new Map<string, string>();
  const novaLoja = new Map<string, string>();
  const negados: Record<string, string[]> = {};
  for (const it of itens) {
    if (it.atualizarPreco === 'nao' || it.precoVenda === null) continue;
    const pid = it.produtoId.toLowerCase();
    const p = produtos.get(pid)!;
    const novo = decTexto(it.precoVenda, 4);
    // O preço da loja sem linha própria (ou sem preço nela) é o geral: repeti-lo não é alteração.
    const atual = it.atualizarPreco === 'geral' ? p.preco_venda : (lojaAntes.get(pid) ?? p.preco_venda);
    if (!quem.podeAlterarPreco && !dec(atual).eq(novo)) {
      negados[`itens.${it.indice}.precoVenda`] = ['Alterar preço no ERP exige "Produtos: Alterar preço"'];
      continue;
    }
    (it.atualizarPreco === 'geral' ? novaGeral : novaLoja).set(pid, novo);
  }
  if (Object.keys(negados).length)
    throw new ErroApi('SEM_PERMISSAO', 'Alterar preço no ERP exige "Produtos: Alterar preço".', {
      campos: negados,
    });
  // A loja sem preço próprio (sem linha ou com `preco_venda` nulo, MD 3.6.9) segue o geral: o "só da loja" igual ao
  // geral que vale depois do documento não cria nem preenche a linha (fixaria um preço que deixa de acompanhar o
  // geral, sem a permissão de alterar preço) nem entra no histórico. Com a permissão, o preço próprio é o pedido.
  for (const [pid, v] of novaLoja)
    if (
      (lojaAntes.get(pid) ?? null) === null &&
      dec(v).eq(novaGeral.get(pid) ?? produtos.get(pid)!.preco_venda)
    )
      novaLoja.delete(pid);

  const { lotes, criados } = await resolverLotes(tx, doc, itens, quem.usuarioId);
  const lojaMovimento = lojaEstoque[0]?.id ?? null;
  const linhas: NovoMovimento[] = itens.map((it) => {
    const pid = it.produtoId.toLowerCase();
    return {
      estoqueId: doc.estoqueId,
      produtoId: it.produtoId,
      variacaoId: null,
      tipoEstoqueId: doc.tipoEstoqueId,
      loteId: lotes.get(it.id.toLowerCase()) ?? null,
      tipoMovimento: doc.tipoMovimento,
      quantidade: it.quantidadeEstoque,
      custoUnitario: it.custoUnitario,
      custoReferencia: it.custoUnitario,
      precoVenda: novaGeral.get(pid) ?? produtos.get(pid)!.preco_venda,
      dataMovimento: inicio,
      lojaId: lojaMovimento,
      usuarioId: quem.usuarioId,
      documentoTipo: doc.documentoTipo,
      documentoId: doc.documentoId,
      documentoItemId: it.documentoItemId ?? it.id,
      unidadeDocumento: it.unidadeCompra,
      fator: it.fator,
      pessoaId: doc.fornecedorId,
    };
  });
  const lancado = await lancarDocumento(tx, linhas, { inicioDocumento: inicio });
  const compensacoes = await compensarDefinir(tx, lancado.movimentos, doc.rotulo);

  // Preço de custo, preço de venda geral e markup, num UPDATE por bloco; o histórico com a origem do documento.
  const ultimo = ultimoCustoPorProduto(itens);
  const historico: LinhaHistoricoPreco[] = [];
  const alterados: Array<{ id: string; custo: string; venda: string; markup: string | null }> = [];
  const precosAlterados: PrecoAlteradoEntrada[] = [];
  let precosCusto = 0;
  for (const [pid, p] of produtos) {
    const custoNovo = quem.atualizarPrecoCusto ? decTexto(ultimo.get(pid)!.custoUnitario, 4) : p.preco_custo;
    const vendaNova = novaGeral.get(pid) ?? p.preco_venda;
    const mudouCusto = !dec(custoNovo).eq(p.preco_custo);
    const mudouVenda = !dec(vendaNova).eq(p.preco_venda);
    const markup = markupTexto(custoNovo, vendaNova);
    if (mudouCusto) precosCusto += 1;
    if (mudouCusto || mudouVenda) alterados.push({ id: pid, custo: custoNovo, venda: vendaNova, markup });
    const lojaNova = novaLoja.get(pid);
    // O preço só da loja que muda (o mesmo critério do `insert` em `produtos_lojas` abaixo).
    const mudouLoja = lojaNova !== undefined && !dec(lojaNova).eq(lojaAntes.get(pid) ?? -1);
    if (mudouCusto || mudouVenda || mudouLoja) {
      const loja = (precoVenda: string | null) =>
        mudouLoja ? { lojas: [{ lojaId: doc.lojaId, precoVenda }] } : {};
      precosAlterados.push({
        produtoId: pid,
        antes: {
          nome: p.nome,
          precoCusto: p.preco_custo,
          precoVenda: p.preco_venda,
          markupPct: p.markup_pct,
          ...loja(lojaAntes.get(pid) ?? null),
        },
        depois: {
          nome: p.nome,
          precoCusto: custoNovo,
          precoVenda: vendaNova,
          markupPct: mudouCusto || mudouVenda ? (markup ?? p.markup_pct) : p.markup_pct,
          ...loja(lojaNova ?? null),
        },
      });
    }
    historico.push(
      ...linhasHistoricoPrecos(
        quem.usuarioId,
        pid,
        {
          produto: { custo: p.preco_custo, venda: p.preco_venda },
          lojas: lojaNova !== undefined ? { [doc.lojaId]: lojaAntes.get(pid) ?? null } : {},
        },
        {
          produto: { custo: custoNovo, venda: vendaNova },
          lojas: lojaNova !== undefined ? { [doc.lojaId]: lojaNova } : {},
        },
        doc.origemPreco,
        doc.documentoId,
      ),
    );
  }
  for (const bloco of emBlocos(alterados))
    await tx.execute(sql`
      update produtos p
         set preco_custo = v.custo, preco_venda = v.venda, markup_pct = coalesce(v.markup, p.markup_pct),
             atualizado_por_id = ${quem.usuarioId}
        from (values ${sql.join(
          bloco.map(
            (a) => sql`(${a.id}::uuid, ${a.custo}::numeric, ${a.venda}::numeric, ${a.markup}::numeric)`,
          ),
          sql`, `,
        )}) as v(id, custo, venda, markup)
       where p.id = v.id`);
  // Preço só da loja: a linha de `produtos_lojas` da loja destinatária, criada se o produto ainda não a tinha.
  for (const bloco of emBlocos([...novaLoja].filter(([pid, v]) => !dec(v).eq(lojaAntes.get(pid) ?? -1))))
    await tx.execute(sql`
      insert into produtos_lojas (produto_id, loja_id, preco_venda, criado_por_id, atualizado_por_id)
      values ${sql.join(
        bloco.map(
          ([pid, v]) =>
            sql`(${pid}::uuid, ${doc.lojaId}::uuid, ${v}::numeric, ${quem.usuarioId}::uuid, ${quem.usuarioId}::uuid)`,
        ),
        sql`, `,
      )}
      on conflict (produto_id, loja_id) where excluido_em is null
      do update set preco_venda = excluded.preco_venda, atualizado_por_id = excluded.atualizado_por_id`);
  for (const bloco of emBlocos(historico)) await tx.insert(produtosHistoricoPrecos).values(bloco);
  const precosVenda = historico.filter((h) => h.tipoPreco !== 'custo').length;

  // O vínculo aprendido da NF-e (fornecedor + cProd) primeiro: com ele gravado, o produto já tem vínculo com o
  // fornecedor e o passo seguinte não cria o sem código.
  const aprendidos = await aprenderVinculosPorCodigo(tx, doc, itens, quem);
  // Vínculo produto × fornecedor: último custo e última compra (sem voltar para trás pela data do documento) em todos
  // os vínculos do fornecedor com o produto, menos os que a nota acabou de aprender (já têm o custo do item deles);
  // unidade e fator da compra só no vínculo sem código (o com código é o que a NF-e aprendeu do `cProd`, com a
  // embalagem dela). Sem vínculo nenhum, cria um sem código (principal se o produto não tem outro).
  const codigosAprendidos = textoArray(aprendidos.codigos);
  const vinculos = [...ultimo].map(([pid, it]) => ({
    pid,
    custo: decTexto(it.custoUnitario, 4),
    fator: decTexto(it.fator, 3),
    unidade: it.unidadeCompra,
  }));
  let vinculosCriados = 0;
  for (const bloco of emBlocos(vinculos)) {
    const valores = sql.join(
      bloco.map(
        (v) =>
          sql`(${v.pid}::uuid, ${v.custo}::numeric, ${v.fator}::numeric, ${v.unidade}::varchar, ${doc.dataDocumento}::date)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      update produtos_fornecedores pf
         set ultimo_custo = case when pf.ultima_compra_em is null or pf.ultima_compra_em <= v.data
                                 then v.custo else pf.ultimo_custo end,
             unidade_compra = case when pf.codigo_fornecedor is null
                                    and (pf.ultima_compra_em is null or pf.ultima_compra_em <= v.data)
                                   then v.unidade else pf.unidade_compra end,
             fator = case when pf.codigo_fornecedor is null
                           and (pf.ultima_compra_em is null or pf.ultima_compra_em <= v.data)
                          then v.fator else pf.fator end,
             ultima_compra_em = greatest(pf.ultima_compra_em, v.data),
             atualizado_por_id = ${quem.usuarioId}
        from (values ${valores}) as v(produto_id, custo, fator, unidade, data)
       where pf.produto_id = v.produto_id and pf.fornecedor_id = ${doc.fornecedorId} and pf.variacao_id is null
         and pf.excluido_em is null
         and (pf.codigo_fornecedor is null or not pf.codigo_fornecedor = any(${codigosAprendidos}::text[]))`);
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into produtos_fornecedores (produto_id, fornecedor_id, unidade_compra, fator, ultimo_custo,
                                         ultima_compra_em, principal, criado_por_id, atualizado_por_id)
      select v.produto_id, ${doc.fornecedorId}::uuid, v.unidade, v.fator, v.custo, v.data,
             not exists (select 1 from produtos_fornecedores o where o.produto_id = v.produto_id and o.excluido_em is null),
             ${quem.usuarioId}::uuid, ${quem.usuarioId}::uuid
        from (values ${valores}) as v(produto_id, custo, fator, unidade, data)
       where not exists (select 1 from produtos_fornecedores pf
                          where pf.produto_id = v.produto_id and pf.fornecedor_id = ${doc.fornecedorId}
                            and pf.variacao_id is null and pf.excluido_em is null)
      returning id`);
    vinculosCriados += rows.length;
  }

  return {
    lotes,
    movimentos: lancado.movimentos.length,
    compensacoes: compensacoes.length,
    lotesCriados: criados,
    precosCusto,
    precosVenda,
    vinculosCriados,
    vinculosAprendidos: aprendidos.gravados,
    vinculosMovidos: aprendidos.movidos,
    precosAlterados,
  };
}

/**
 * A auditoria do preço que a entrada mudou (F2-B42; ERP 16.2: o Histórico de produtos mostra a mudança de preço do
 * recebimento e da NF-e, a mais comum da loja): uma linha `editar` do produto por produto alterado, com a localização
 * da tela (`Estoque › Recebimentos` ou `Estoque › Recebimento de NFe`), o `antes`/`depois` de `PrecoAlteradoEntrada`
 * e a `descricao` neutra da gravação do produto (`descricaoGravacaoProduto`: o custo só com o rótulo, o da loja no
 * aviso "Dados de loja alterados") precedida do documento ("Recebimento Nº 12: Preço de venda: 9,90 → 10,90"). A
 * linha é da empresa (sem `loja_id`, como a do cadastro): o preço da loja sai de quem não vê a loja pelo escopo.
 * O histórico de preços (F2-B37) continua com a origem e o id do documento.
 */
export async function auditarPrecosEntrada(
  auditoria: AuditoriaService,
  tx: DbEmpresa,
  origem: OrigemAcao,
  documento: string,
  localizacao: string,
  alterados: readonly PrecoAlteradoEntrada[],
): Promise<void> {
  if (!alterados.length) return;
  const registros = [];
  for (const a of alterados) {
    const texto = await descricaoGravacaoProduto(tx, a.antes, a.depois);
    registros.push({
      acao: 'editar' as const,
      entidade: 'produtos',
      registroId: a.produtoId,
      localizacao,
      descricao: texto ? `${documento}: ${texto}` : documento,
      antes: a.antes,
      depois: a.depois,
    });
  }
  await auditoria.registrarVarios(tx, origem, registros);
}

/** Um array do Postgres em texto (`{"a","b"}`), com as aspas e as barras escapadas (o cProd vem do XML). */
const textoArray = (v: Iterable<string>) =>
  `{${[...new Set(v)].map((x) => `"${x.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;

/** O último item de cada cProd (o código que se repete na nota vale pelo último item com ele). */
function itensPorCodigo(itens: readonly ItemEntrada[]): Map<string, ItemEntrada> {
  const porCodigo = new Map<string, ItemEntrada>();
  for (const it of itens) if (it.codigoFornecedor) porCodigo.set(it.codigoFornecedor, it);
  return porCodigo;
}

/**
 * Os vínculos fornecedor + cProd dos itens que estão em **outro** produto (o usuário ligou o código a outro produto na
 * vinculação), travados (`for update`, em ordem de id). Mover um deles altera o cadastro do outro produto, como o
 * "mover vínculo" do formulário do produto (F2-B13, README da API › decisão 158), e exige o mesmo `produtos.editar`:
 * sem ela, 403 em `itens.N.produtoId` de cada item (N = a posição do item na nota), antes da pergunta do preço de
 * custo e de qualquer lançamento. Devolve os vínculos a mover.
 */
export async function exigirPermissaoMoverVinculos(
  tx: DbEmpresa,
  fornecedorId: string,
  itens: readonly ItemEntrada[],
  podeMoverVinculo: boolean,
): Promise<VinculoMovidoNfe[]> {
  const porCodigo = itensPorCodigo(itens);
  if (!porCodigo.size) return [];
  const { rows } = await tx.execute<{
    id: string;
    produto_id: string;
    codigo_fornecedor: string;
    codigo: number;
    nome: string;
  }>(sql`
    select pf.id, pf.produto_id, pf.codigo_fornecedor, p.codigo, p.nome
      from produtos_fornecedores pf join produtos p on p.id = pf.produto_id
     where pf.fornecedor_id = ${fornecedorId} and pf.excluido_em is null
       and pf.codigo_fornecedor = any(${textoArray(porCodigo.keys())}::text[])
     order by pf.id
       for update of pf`);
  const movidos: VinculoMovidoNfe[] = [];
  for (const r of rows) {
    const it = porCodigo.get(r.codigo_fornecedor)!;
    if (r.produto_id.toLowerCase() === it.produtoId.toLowerCase()) continue;
    movidos.push({
      id: r.id,
      produtoId: r.produto_id,
      produtoCodigo: r.codigo,
      produtoNome: r.nome,
      codigoFornecedor: r.codigo_fornecedor,
      produtoNovoId: it.produtoId.toLowerCase(),
      indice: it.indice,
    });
  }
  if (movidos.length && !podeMoverVinculo)
    throw new ErroApi(
      'SEM_PERMISSAO',
      'Ligar ao produto o código do fornecedor que está em outro produto altera o outro cadastro e exige "Produtos: Editar".',
      {
        campos: Object.fromEntries(
          movidos.map((m) => [
            `itens.${m.indice}.produtoId`,
            [
              `O código "${m.codigoFornecedor}" deste fornecedor está ligado ao produto ${m.produtoCodigo} - ${m.produtoNome}: mover o vínculo exige "Produtos: Editar"`,
            ],
          ]),
        ),
      },
    );
  return movidos;
}

/**
 * O vínculo aprendido da NF-e (F2-B21; ERP 13.4.1, 8.2.14; MD 3.6.10): para cada cProd dos itens (o último item com o
 * código, se ele se repete), o vínculo fornecedor + cProd passa a apontar para o produto, o fator e a unidade
 * comercial (uCom) **confirmados nesta nota**, com o custo do item e a data do documento. Em quatro passos, um comando
 * por bloco de 500 (SYNC 6.13):
 * 0. o vínculo do código que está em **outro** produto sai de lá como no "mover vínculo" do cadastro (F2-B13): exige
 *    `produtos.editar` (`exigirPermissaoMoverVinculos`), a linha antiga é excluída logicamente (o custo do fornecedor
 *    digitado, o último custo e a última compra eram do outro produto e ficam com ela) e o código segue para os passos
 *    2 e 3 como um código novo deste produto; o outro produto ganha a auditoria `editar` (quem chama, com
 *    `vinculosMovidos`);
 * 1. o vínculo que já tem o código, no mesmo produto (`uq_produtos_fornecedores_codigo`), é atualizado: o fator e a
 *    unidade são sempre os desta nota (a última confirmação do usuário é o que vale, também na nota mais antiga
 *    movimentada depois); o último custo e a última compra não voltam para trás pela data;
 * 2. sem ele, o vínculo **sem código** do mesmo produto com o fornecedor (o que o recebimento manual criou) ganha o
 *    cProd, o fator e a unidade: o produto não fica com dois vínculos do mesmo fornecedor;
 * 3. sem nenhum dos dois, cria o vínculo com o código (principal só o primeiro do produto que não tem vínculo nenhum:
 *    dois códigos novos do mesmo produto na nota não deixam dois principais).
 * Devolve os códigos gravados (o passo comum do núcleo não mexe neles), quantos foram e os vínculos movidos.
 */
async function aprenderVinculosPorCodigo(
  tx: DbEmpresa,
  doc: DocumentoEntrada,
  itens: readonly ItemEntrada[],
  quem: QuemMovimenta,
): Promise<{ codigos: string[]; gravados: number; movidos: VinculoMovidoNfe[] }> {
  const usuarioId = quem.usuarioId;
  const porCodigo = itensPorCodigo(itens);
  if (!porCodigo.size) return { codigos: [], gravados: 0, movidos: [] };
  // 0. O código que está em outro produto sai de lá (quem chama já conferiu a permissão; conferida de novo aqui).
  const movidos = await exigirPermissaoMoverVinculos(
    tx,
    doc.fornecedorId,
    itens,
    quem.podeMoverVinculo ?? false,
  );
  if (movidos.length)
    await tx.execute(sql`
      update produtos_fornecedores set excluido_em = now(), atualizado_por_id = ${usuarioId}
       where id = any(${lista(movidos.map((m) => m.id))}::uuid[])`);
  const linhas = [...porCodigo].map(([codigo, it]) => ({
    codigo,
    pid: it.produtoId.toLowerCase(),
    custo: decTexto(it.custoUnitario, 4),
    fator: decTexto(it.fator, 3),
    unidade: it.unidadeCompra,
  }));
  const valores = (bloco: typeof linhas) =>
    sql.join(
      bloco.map(
        (v) =>
          sql`(${v.codigo}::varchar, ${v.pid}::uuid, ${v.custo}::numeric, ${v.fator}::numeric, ${v.unidade}::varchar, ${doc.dataDocumento}::date)`,
      ),
      sql`, `,
    );
  const feitos = new Set<string>();
  // 1. O vínculo que já tem o código, no mesmo produto (o de outro produto saiu no passo 0).
  for (const bloco of emBlocos(linhas)) {
    const { rows } = await tx.execute<{ codigo_fornecedor: string }>(sql`
      update produtos_fornecedores pf
         set variacao_id = null, fator = v.fator, unidade_compra = v.unidade,
             ultimo_custo = case when pf.ultima_compra_em is null or pf.ultima_compra_em <= v.data
                                 then v.custo else pf.ultimo_custo end,
             ultima_compra_em = greatest(pf.ultima_compra_em, v.data),
             atualizado_por_id = ${usuarioId}
        from (values ${valores(bloco)}) as v(codigo, produto_id, custo, fator, unidade, data)
       where pf.fornecedor_id = ${doc.fornecedorId} and pf.codigo_fornecedor = v.codigo and pf.excluido_em is null
         and pf.produto_id = v.produto_id
      returning pf.codigo_fornecedor`);
    for (const r of rows) feitos.add(r.codigo_fornecedor);
  }
  // 2. O vínculo sem código do mesmo produto ganha o código (dois códigos do mesmo produto na nota: um o adota e o
  // outro segue para o passo 3, pelo `returning`).
  for (const bloco of emBlocos(linhas.filter((l) => !feitos.has(l.codigo)))) {
    const { rows } = await tx.execute<{ codigo_fornecedor: string }>(sql`
      update produtos_fornecedores pf
         set codigo_fornecedor = v.codigo, fator = v.fator, unidade_compra = v.unidade,
             ultimo_custo = case when pf.ultima_compra_em is null or pf.ultima_compra_em <= v.data
                                 then v.custo else pf.ultimo_custo end,
             ultima_compra_em = greatest(pf.ultima_compra_em, v.data),
             atualizado_por_id = ${usuarioId}
        from (values ${valores(bloco)}) as v(codigo, produto_id, custo, fator, unidade, data)
       where pf.id = (select o.id from produtos_fornecedores o
                       where o.produto_id = v.produto_id and o.fornecedor_id = ${doc.fornecedorId}
                         and o.variacao_id is null and o.codigo_fornecedor is null and o.excluido_em is null
                       order by o.principal desc, o.criado_em, o.id
                       limit 1)
      returning pf.codigo_fornecedor`);
    for (const r of rows) feitos.add(r.codigo_fornecedor);
  }
  // 3. O vínculo novo; principal só o primeiro do produto que não tem vínculo nenhum.
  const novos = linhas.filter((l) => !feitos.has(l.codigo));
  const primeiro = new Set<string>();
  for (const bloco of emBlocos(novos)) {
    await tx.execute(sql`
      insert into produtos_fornecedores (produto_id, fornecedor_id, codigo_fornecedor, unidade_compra, fator,
                                         ultimo_custo, ultima_compra_em, principal, criado_por_id, atualizado_por_id)
      select v.produto_id, ${doc.fornecedorId}::uuid, v.codigo, v.unidade, v.fator, v.custo, v.data,
             v.primeiro and not exists (select 1 from produtos_fornecedores o
                                         where o.produto_id = v.produto_id and o.excluido_em is null),
             ${usuarioId}::uuid, ${usuarioId}::uuid
        from (values ${sql.join(
          bloco.map((v) => {
            const eh = !primeiro.has(v.pid);
            primeiro.add(v.pid);
            return sql`(${v.codigo}::varchar, ${v.pid}::uuid, ${v.custo}::numeric, ${v.fator}::numeric, ${v.unidade}::varchar, ${doc.dataDocumento}::date, ${eh}::boolean)`;
          }),
          sql`, `,
        )}) as v(codigo, produto_id, custo, fator, unidade, data, primeiro)`);
    for (const l of bloco) feitos.add(l.codigo);
  }
  return { codigos: [...feitos], gravados: feitos.size, movidos };
}

export interface ResultadoEstornoEntrada {
  estornos: number;
  /** Os saldos que o estorno deixou negativos, com a confirmação de quem pode (D56 com aviso); vazio no comum. */
  saldosNegativos: SaldoNegativoEstorno[];
}

/** Quem estorna, do ponto de vista do núcleo (o recebimento e a NF-e resolvem a permissão antes). */
export interface QuemEstorna {
  usuarioId: string;
  /** Master ou `estoque.permite_negativo_erp` da loja do estoque. */
  permiteNegativo: boolean;
  /**
   * A confirmação do saldo negativo (`confirmarNegativo` do corpo): os saldos da lista que foi mostrada a quem estorna.
   * Só vale com `permiteNegativo` e só cobre o que estiver nela (`conferirNegativosEstorno`).
   */
  confirmarNegativo: readonly SaldoNegativoConfirmado[];
  motivo: string;
}

/** Os saldos negativos em texto, para as mensagens e a auditoria ("Cerveja (saldo 2 → -8), Requeijão (lote RQ-01: 7 → -5)"). */
export function textoSaldosNegativos(negativos: readonly SaldoNegativoEstorno[]): string {
  const n = (v: string) => Number(v).toLocaleString('pt-BR');
  return negativos
    .map((s) =>
      s.lote === null
        ? `${s.nome} (saldo ${n(s.saldoAtual)} → ${n(s.saldoFinal)})`
        : `${s.nome} (lote ${s.lote}: ${n(s.saldoAtual)} → ${n(s.saldoFinal)})`,
    )
    .join(', ');
}

/**
 * A regra do saldo negativo no estorno de uma entrada (D56, decidida pelo dono em 05/11/2026: **bloqueado, salvo
 * Master ou `estoque.permite_negativo_erp`, com aviso**), escrita uma vez para o recebimento e a NF-e (F2-B21):
 * - sem a permissão, 422 com a mensagem de sempre (linha ou lote) e os saldos em `detalhes.saldosNegativos`;
 * - com a permissão e sem a confirmação, 422 em `campos.confirmarNegativo` com os mesmos `detalhes`: o estorno não
 *   deixa negativo em silêncio, a tela mostra a lista e pede a confirmação;
 * - com a permissão e a confirmação, segue (quem chama registra na auditoria o negativo confirmado). A confirmação é a
 *   lista mostrada, não um "sim" geral: cada saldo negativo de agora tem de estar nela (o mesmo produto e lote) e não
 *   pode ficar mais negativo que o confirmado. Se uma venda sincronizada mudou a conta enquanto a pergunta estava
 *   aberta (outro produto ou lote, ou o saldo mais fundo), volta o 422 com a lista de agora para confirmar de novo.
 */
export function conferirNegativosEstorno(
  negativos: readonly SaldoNegativoEstorno[],
  quem: Pick<QuemEstorna, 'permiteNegativo' | 'confirmarNegativo'>,
): void {
  if (!negativos.length) return;
  const chave = (produtoId: string, lote: string | null) => JSON.stringify([produtoId.toLowerCase(), lote]);
  const confirmados = new Map(quem.confirmarNegativo.map((c) => [chave(c.produtoId, c.lote), c.saldoFinal]));
  const coberto = (s: SaldoNegativoEstorno) => {
    const c = confirmados.get(chave(s.produtoId, s.lote));
    return c !== undefined && dec(s.saldoFinal).gte(dec(c));
  };
  if (quem.permiteNegativo && negativos.every(coberto)) return;
  const detalhes = { saldosNegativos: negativos };
  if (!quem.permiteNegativo) {
    const linhas = negativos.filter((s) => s.lote === null);
    throw new ErroApi(
      'REGRA_NEGOCIO',
      linhas.length
        ? `O estorno deixaria saldo negativo em: ${linhas
            .map((s) => `${s.nome} (saldo ${Number(s.saldoAtual).toLocaleString('pt-BR')})`)
            .join(
              ', ',
            )}. A mercadoria já saiu do estoque: só com a permissão de saldo negativo (Master ou "Permite saldo negativo no ERP").`
        : `O estorno deixaria saldo negativo no lote: ${negativos
            .map((s) => `${s.nome} (lote ${s.lote}: ${Number(s.saldoAtual).toLocaleString('pt-BR')})`)
            .join(', ')}. Só com a permissão de saldo negativo (Master ou "Permite saldo negativo no ERP").`,
      { detalhes },
    );
  }
  const mudou = quem.confirmarNegativo.length > 0;
  throw new ErroApi(
    'REGRA_NEGOCIO',
    `${mudou ? 'O saldo mudou desde a confirmação. ' : ''}O saldo ficará negativo em: ${textoSaldosNegativos(negativos)}. A mercadoria já saiu do estoque: confirme para estornar mesmo assim.`,
    {
      campos: {
        confirmarNegativo: [
          mudou
            ? 'O saldo mudou desde a confirmação: confira a lista e confirme de novo.'
            : 'O saldo ficará negativo: confirme o estorno.',
        ],
      },
      detalhes,
    },
  );
}

type MovimentoAEstornar = {
  id: string;
  estoque_id: string;
  loja_id: string | null;
  produto_id: string;
  variacao_id: string | null;
  tipo_estoque_id: string;
  lote_id: string | null;
  quantidade: string;
  custo_unitario: string;
  preco_venda: string | null;
  documento_item_id: string | null;
  unidade_documento: string | null;
  fator: string;
  pessoa_id: string | null;
  nome: string;
  /** Uma `ACERTO_COMPENSACAO` contra a entrada (o estorno dela é `ESTORNO_ACERTO`). */
  compensacao?: boolean;
};

/**
 * Estorna as entradas do documento (ver o topo do módulo). O efeito **líquido** de cada linha de saldo e de cada lote
 * (o estorno da entrada e o da compensação que a anulava se cancelam) é conferido contra o saldo travado, como no
 * estorno do acerto: com saldo insuficiente (a mercadoria já vendida), 422 sem `permiteNegativo`, e 422 com a lista
 * em `confirmarNegativo` com a permissão e sem a confirmação (`conferirNegativosEstorno`).
 */
export async function estornarEntrada(
  tx: DbEmpresa,
  doc: Pick<DocumentoEntrada, 'documentoTipo' | 'documentoId' | 'tipoMovimento' | 'tipoEstorno'>,
  quem: QuemEstorna,
): Promise<ResultadoEstornoEntrada> {
  const inicio = new Date();
  const { rows: movs } = await tx.execute<MovimentoAEstornar>(sql`
    select m.id, m.estoque_id, m.loja_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.lote_id,
           m.quantidade::text, m.custo_unitario::text, m.preco_venda::text, m.documento_item_id, m.unidade_documento,
           m.fator::text, m.pessoa_id, p.nome
      from movimentos_estoque m join produtos p on p.id = m.produto_id
     where m.documento_tipo = ${doc.documentoTipo} and m.documento_id = ${doc.documentoId}
       and m.tipo_movimento = ${doc.tipoMovimento} and m.estorno_de_id is null
       and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)`);
  // As compensações que um "Definir" lançou contra estas entradas: estornadas junto, no item da entrada compensada.
  for (const c of await compensacoesDoDocumento(tx, doc.documentoTipo, doc.documentoId))
    movs.push({ ...c, fator: '1', pessoa_id: null, compensacao: true });
  const ordenados = ordenarChaves(
    movs.map((m) => ({
      m,
      estoqueId: m.estoque_id,
      produtoId: m.produto_id,
      variacaoId: m.variacao_id,
      tipoEstoqueId: m.tipo_estoque_id,
      loteId: m.lote_id,
    })) satisfies Array<ChaveSaldo & { m: MovimentoAEstornar }>,
  );
  const chave = (c: ChaveSaldo) =>
    `${c.estoqueId}|${c.produtoId}|${c.variacaoId ?? ''}|${c.tipoEstoqueId}`.toLowerCase();
  const liquido = new Map<string, { c: ChaveSaldo; nome: string; q: Dec }>();
  const liquidoLote = new Map<string, { c: ChaveSaldo & { loteId: string }; nome: string; q: Dec }>();
  for (const c of ordenados) {
    const k = chave(c);
    const l = liquido.get(k) ?? { c, nome: c.m.nome, q: dec(0) };
    l.q = l.q.minus(c.m.quantidade);
    liquido.set(k, l);
    if (c.loteId) {
      const kl = `${k}|${c.loteId.toLowerCase()}`;
      const ll = liquidoLote.get(kl) ?? { c: { ...c, loteId: c.loteId }, nome: c.m.nome, q: dec(0) };
      ll.q = ll.q.minus(c.m.quantidade);
      liquidoLote.set(kl, ll);
    }
  }
  // As linhas de saldo travadas na ordem estável antes da conferência (o lançamento as trava de novo sem esperar).
  // Os negativos são apurados sempre (também com a permissão): quem pode deixar negativo confirma vendo a lista.
  const negativos: SaldoNegativoEstorno[] = [];
  for (const { c, nome, q } of liquido.values()) {
    const saldo = await travarSaldo(tx, c);
    const final = dec(saldo.quantidade).plus(q);
    if (q.lt(0) && final.lt(0))
      negativos.push({
        produtoId: c.produtoId,
        nome,
        lote: null,
        saldoAtual: decTexto(dec(saldo.quantidade), 3),
        saldoFinal: decTexto(final, 3),
      });
  }
  for (const { c, nome, q } of liquidoLote.values()) {
    if (!q.lt(0)) continue;
    const doLote = await saldoDoLote(tx, c);
    const final = dec(doLote).plus(q);
    if (final.lt(0)) {
      const { rows } = await tx.execute<{ lote: string }>(
        sql`select lote from produtos_lotes where id = ${c.loteId}`,
      );
      negativos.push({
        produtoId: c.produtoId,
        nome,
        lote: rows[0]?.lote ?? c.loteId,
        saldoAtual: decTexto(dec(doLote), 3),
        saldoFinal: decTexto(final, 3),
      });
    }
  }
  conferirNegativosEstorno(negativos, quem);
  if (!movs.length) return { estornos: 0, saldosNegativos: [] };
  const linhas: NovoMovimento[] = ordenados.map(({ m }) => {
    const q = dec(m.quantidade).neg();
    return {
      estoqueId: m.estoque_id,
      produtoId: m.produto_id,
      variacaoId: m.variacao_id,
      tipoEstoqueId: m.tipo_estoque_id,
      loteId: m.lote_id,
      // O estorno da compensação (uma entrada, oposta à dela) é `ESTORNO_ACERTO` (sinal 0, como no estorno do acerto),
      // e não o `ESTORNO_RECEB_*`, que o catálogo (MD 7.3) define como saída.
      tipoMovimento: m.compensacao ? 'ESTORNO_ACERTO' : doc.tipoEstorno,
      quantidade: decTexto(q, 3),
      // A saída sai ao custo médio vigente; o estorno da compensação (uma entrada) volta ao custo dela (T20).
      custoUnitario: q.gt(0) ? m.custo_unitario : null,
      custoReferencia: m.custo_unitario,
      precoVenda: m.preco_venda,
      dataMovimento: inicio,
      lojaId: m.loja_id,
      usuarioId: quem.usuarioId,
      documentoTipo: doc.documentoTipo,
      documentoId: doc.documentoId,
      documentoItemId: m.documento_item_id,
      unidadeDocumento: m.unidade_documento,
      fator: m.fator,
      pessoaId: m.pessoa_id,
      estornoDeId: m.id,
      observacao: quem.motivo.slice(0, 255),
    };
  });
  const r = await lancarDocumento(tx, linhas, { inicioDocumento: inicio });
  return { estornos: r.movimentos.length, saldosNegativos: negativos };
}
