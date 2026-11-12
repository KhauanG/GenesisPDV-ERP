/**
 * Leituras do cadastro de produtos (ERP 8.1, 8.2; MD 3.6): resumo dos produtos para seletores, detalhe com as filhas,
 * versão agregada do cadastro e saldos/combos montáveis.
 */
import {
  CST_COM_ST,
  type AvisoComboComponente,
  type ComponenteDetalhe,
  type ImagemProdutoDetalhe,
  type FornecedorProdutoDetalhe,
  type LoteProdutoDetalhe,
  type ProdutoDetalhe,
  type ProdutoOpcao,
  type RelacionadoDetalhe,
  type TipoProduto,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { opcoesPessoaPorId } from '../pessoas/fornecedores.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { ncmVigente } from './ncm.js';

type Linha = Record<string, unknown>;

const SELECT_OPCAO = sql`
  select p.id, p.codigo, p.nome, p.tipo, p.ativo, p.unidade_id, u.sigla as unidade_sigla, p.permite_fracao,
         p.controla_estoque, p.preco_venda::text as preco_venda, p.preco_atacado::text as preco_atacado,
         p.qtd_minima_atacado::text as qtd_minima_atacado, p.preco_custo::text as preco_custo,
         p.custo_medio::text as custo_medio, p.grupo_preco_quantidade_id, p.ncm,
         (select cb.codigo from produtos_codigos_barras cb
           where cb.produto_id = p.id and cb.variacao_id is null and cb.principal and cb.excluido_em is null
           limit 1) as ean
    from produtos p
    join unidades_medida u on u.id = p.unidade_id`;

export function paraOpcao(r: Linha, verCusto: boolean): ProdutoOpcao {
  return {
    id: r.id as string,
    codigo: Number(r.codigo),
    nome: r.nome as string,
    tipo: r.tipo as TipoProduto,
    ativo: r.ativo as boolean,
    unidadeId: r.unidade_id as string,
    unidadeSigla: r.unidade_sigla as string,
    permiteFracao: r.permite_fracao as boolean,
    controlaEstoque: r.controla_estoque as boolean,
    ean: (r.ean as string | null) ?? null,
    precoVenda: r.preco_venda as string,
    precoAtacado: (r.preco_atacado as string | null) ?? null,
    qtdMinimaAtacado: (r.qtd_minima_atacado as string | null) ?? null,
    precoCusto: verCusto ? (r.preco_custo as string) : null,
    custoMedio: verCusto ? (r.custo_medio as string) : null,
    grupoPrecoQuantidadeId: (r.grupo_preco_quantidade_id as string | null) ?? null,
  };
}

/** Resumo de vários produtos pelo id (inclusive excluídos: o cadastro antigo continua legível). */
export async function opcoesPorId(
  db: DbEmpresa,
  ids: readonly string[],
  verCusto: boolean,
): Promise<Map<string, ProdutoOpcao>> {
  if (!ids.length) return new Map();
  const lista = sql.join(
    [...new Set(ids)].map((i) => sql`${i}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute<Linha>(sql`${SELECT_OPCAO} where p.id in (${lista})`);
  return new Map(rows.map((r) => [r.id as string, paraOpcao(r, verCusto)]));
}

/** Busca para seletores: nome/código/código interno/código de barras, só não excluídos. */
export async function buscarOpcoes(
  db: DbEmpresa,
  f: {
    termo: string;
    tipos?: readonly string[];
    ids?: readonly string[];
    incluirInativos: boolean;
    limite: number;
  },
  verCusto: boolean,
): Promise<ProdutoOpcao[]> {
  const condicoes: SQL[] = [sql`p.excluido_em is null`];
  if (!f.incluirInativos) condicoes.push(sql`p.ativo`);
  if (f.tipos?.length)
    condicoes.push(
      sql`p.tipo in (${sql.join(
        f.tipos.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  if (f.ids?.length)
    condicoes.push(
      sql`p.id in (${sql.join(
        f.ids.map((i) => sql`${i}::uuid`),
        sql`, `,
      )})`,
    );
  const termo = f.termo.trim();
  if (termo) {
    const numero = /^\d{1,9}$/.test(termo) ? Number(termo) : null;
    condicoes.push(sql`(p.busca like lower(fn_unaccent(${`%${termo.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}))
      or p.codigo = ${numero ?? -1}
      or exists (select 1 from produtos_codigos_barras cb where cb.produto_id = p.id and cb.codigo = ${termo}
                  and cb.excluido_em is null))`);
  }
  const { rows } = await db.execute<Linha>(sql`${SELECT_OPCAO}
    where ${sql.join(condicoes, sql` and `)}
    order by (p.codigo::text = ${termo}) desc, lower(fn_unaccent(p.nome)), p.codigo
    limit ${f.limite}`);
  return rows.map((r) => paraOpcao(r, verCusto));
}

/**
 * Versão do cadastro inteiro (decisão 47 do README): o trigger de versão não muda `produtos` quando só as filhas
 * mudam; o 409 do ERP 1.4 compara a maior versão entre o produto e as filhas, inclusive as excluídas logicamente.
 * `id`: o produto (um parâmetro ou a coluna da consulta de quem chama, como o "Pesquisar EAN" do cadastro em massa).
 */
export const sqlVersaoAgregada = (id: SQL) => sql`greatest(
    (select versao from produtos where id = ${id}),
    (select max(versao) from produtos_codigos_barras where produto_id = ${id}),
    (select max(versao) from produtos_lojas where produto_id = ${id}),
    (select max(versao) from produtos_precos_quantidade where produto_id = ${id}),
    (select max(versao) from produtos_categorias where produto_id = ${id}),
    (select max(versao) from produtos_componentes where produto_id = ${id}),
    (select max(versao) from produtos_relacionados where produto_id = ${id}),
    (select max(versao) from produtos_fornecedores where produto_id = ${id}),
    (select max(versao) from produtos_lotes where produto_id = ${id}),
    (select max(versao) from produtos_imagens where produto_id = ${id}),
    (select max(a.versao) from produtos_componentes_alternativas a
       join produtos_componentes pc on pc.id = a.componente_id where pc.produto_id = ${id}))`;

export async function versaoAgregada(db: DbEmpresa, id: string): Promise<number> {
  const { rows } = await db.execute<{ v: string }>(
    sql`select ${sqlVersaoAgregada(sql`${id}::uuid`)}::text as v`,
  );
  return Number(rows[0]!.v);
}

/** Produtos que usam este: combos (padrão ou alternativa ativa) e fichas técnicas, não excluídos. */
export async function usadoEm(db: DbEmpresa, id: string): Promise<ProdutoDetalhe['usadoEm']> {
  const { rows } = await db.execute<Linha>(sql`
    select distinct k.id, k.codigo, k.nome, k.tipo
      from produtos_componentes pc
      join produtos k on k.id = pc.produto_id and k.excluido_em is null
      left join produtos_componentes_alternativas a
        on a.componente_id = pc.id and a.excluido_em is null and a.ativo
     where pc.excluido_em is null and (pc.componente_id = ${id} or a.produto_id = ${id})
     order by k.nome`);
  return rows.map((r) => ({
    id: r.id as string,
    codigo: Number(r.codigo),
    nome: r.nome as string,
    tipo: r.tipo as TipoProduto,
  }));
}

/**
 * Avisos do combo (ERP 8.2.17), por componente ou alternativa ativa — a gravação segue, com o aviso:
 * - fiscais (combo não vendável em loja NFC-e): sem NCM vigente, NCM fora de vigência, CFOP × CST incoerente, CEST
 *   ausente com CST/CSOSN de ST;
 * - de venda (qualquer loja): produto inativo (padrão inativo deixa o combo invendável; alternativa inativa some do
 *   diálogo do PDV) e preço de venda zero (peso zero no rateio proporcional da NFC-e, decisão 2 do dono).
 */
async function avisosCombo(db: DbEmpresa, id: string): Promise<AvisoComboComponente[]> {
  const { rows } = await db.execute<Linha>(sql`
    with itens as (
      select pc.componente_id as produto_id, true as padrao from produtos_componentes pc
       where pc.produto_id = ${id} and pc.tipo = 'kit' and pc.excluido_em is null
      union
      select a.produto_id, false from produtos_componentes_alternativas a
        join produtos_componentes pc on pc.id = a.componente_id
       where pc.produto_id = ${id} and pc.excluido_em is null and a.excluido_em is null and a.ativo
    )
    select p.id, p.codigo, p.nome, bool_or(i.padrao) as padrao, p.ativo, p.preco_venda <= 0 as sem_preco,
           (p.ncm is null or not exists (select 1 from ncms n where n.codigo = p.ncm and n.excluido_em is null)) as sem_ncm,
           (p.ncm is not null and exists (select 1 from ncms n where n.codigo = p.ncm and n.excluido_em is null)
             and not ${ncmVigente(sql`p.ncm`)}) as ncm_vencido,
           ((p.cfop_venda_estado = '5405' and coalesce(p.icms_situacao, '') not in ('60','500'))
             or (p.cfop_venda_estado in ('5101','5102') and p.icms_situacao in ('60','500'))) as cfop_cst,
           (p.icms_situacao in (${sql.join(
             CST_COM_ST.map((c) => sql`${c}`),
             sql`, `,
           )}) and p.cest is null) as sem_cest
      from itens i join produtos p on p.id = i.produto_id
     group by p.id
     order by p.nome`);
  const avisos: AvisoComboComponente[] = [];
  for (const r of rows) {
    const base = { produtoId: r.id as string, codigo: Number(r.codigo), nome: r.nome as string };
    const add = (motivo: string, fiscal: boolean) => avisos.push({ ...base, motivo, fiscal });
    if (!r.ativo)
      add(
        r.padrao ? 'inativo: o combo fica invendável no PDV' : 'inativo: some das alternativas no PDV',
        false,
      );
    if (r.sem_preco) add('preço de venda zero: distorce o rateio do combo na NFC-e', false);
    if (r.sem_ncm) add('sem NCM válido', true);
    if (r.ncm_vencido) add('NCM fora de vigência', true);
    if (r.cfop_cst) add('CFOP incoerente com o CST', true);
    if (r.sem_cest) add('CEST ausente com substituição tributária', true);
  }
  return avisos;
}

/** Texto de cada aviso (campo `avisos`, compatível com quem lê só as mensagens). */
const textoAvisoCombo = (a: AvisoComboComponente) =>
  a.fiscal ? `${a.nome}: ${a.motivo} — o combo não é vendável em loja NFC-e.` : `${a.nome}: ${a.motivo}.`;

const txt = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * Fornecedores do produto no formato do detalhe (8.2.14; F2-B13): só os vivos, da unidade (sem variação); o principal
 * primeiro e, entre os demais, a ordem de inclusão. `criado_em` é o da transação, igual nas linhas da mesma gravação,
 * e a tabela não tem coluna de ordem: o id desempata, senão a ordem física decidiria e o UPDATE de uma linha a mudaria
 * de lugar na grade (com o id a ordem fica estável). O fornecedor vem sem o documento
 * (`opcoesPessoaPorId` › `semDocumento`). `incluirIds` traz também essas linhas já excluídas (o `antes` da auditoria
 * do produto de onde o "mover vínculo" tirou o vínculo). Também é o `depois` da auditoria da gravação (o que ficou no
 * banco, não o corpo: sem `produtos.ver_custo` o custo do corpo é ignorado).
 */
export async function fornecedoresDoProduto(
  db: DbEmpresa,
  id: string,
  verCusto: boolean,
  incluirIds: readonly string[] = [],
): Promise<FornecedorProdutoDetalhe[]> {
  const { rows } = await db.execute<Linha>(sql`
    select id, fornecedor_id, codigo_fornecedor, ean_fornecedor, unidade_compra, fator::text as fator,
           custo_fornecedor::text as custo_fornecedor, ultimo_custo::text as ultimo_custo,
           ultima_compra_em::text as ultima_compra_em, principal
      from produtos_fornecedores
     where produto_id = ${id} and variacao_id is null
       and (excluido_em is null or id = any(${`{${incluirIds.join(',')}}`}::uuid[]))
     order by principal desc, criado_em, id`);
  const pessoas = await opcoesPessoaPorId(
    db,
    rows.map((f) => f.fornecedor_id as string),
    { semDocumento: true },
  );
  return rows.map((f) => ({
    id: f.id as string,
    fornecedorId: f.fornecedor_id as string,
    fornecedor: pessoas.get(f.fornecedor_id as string)!,
    codigoFornecedor: txt(f.codigo_fornecedor),
    eanFornecedor: txt(f.ean_fornecedor),
    unidadeCompra: txt(f.unidade_compra),
    fator: f.fator as string,
    custoFornecedor: verCusto ? txt(f.custo_fornecedor) : null,
    ultimoCusto: verCusto ? txt(f.ultimo_custo) : null,
    ultimaCompraEm: txt(f.ultima_compra_em),
    principal: f.principal as boolean,
  }));
}

/** A galeria do produto (`produtos_imagens`, 8.2.6; F2-B44): só as vivas, pela ordem. */
export async function imagensDoProduto(db: DbEmpresa, produtoId: string): Promise<ImagemProdutoDetalhe[]> {
  const { rows } = await db.execute<Linha>(sql`
    select id, arquivo_id, ordem from produtos_imagens
     where produto_id = ${produtoId} and excluido_em is null
     order by ordem, criado_em`);
  return rows.map((r) => ({ id: r.id as string, arquivoId: r.arquivo_id as string, ordem: Number(r.ordem) }));
}

/**
 * Lotes do bloco Validade (8.2.12; F2-B17): só os vivos, da unidade (sem variação), na ordem FEFO (validade, sem validade
 * por último, depois o texto e o id, para a ordem ficar estável). `estoquesVisiveis` (estoques permitidos da sessão;
 * `null` = todos) esconde os lotes de outros estoques, que a gravação preserva (o lote sem estoque é de todos).
 * `temMovimento` = há movimento de estoque com o lote ou um acerto em rascunho que o usa (não se exclui: inativa-se).
 * O fornecedor vem sem o documento (`opcoesPessoaPorId` › `semDocumento`).
 */
export async function lotesDoProduto(
  db: DbEmpresa,
  id: string,
  estoquesVisiveis: readonly string[] | null = null,
): Promise<LoteProdutoDetalhe[]> {
  const visivel =
    estoquesVisiveis === null
      ? sql``
      : sql` and (l.estoque_id is null or l.estoque_id = any(${`{${estoquesVisiveis.join(',')}}`}::uuid[]))`;
  const { rows } = await db.execute<Linha>(sql`
    select l.id, l.estoque_id, e.nome as estoque_nome, lj.nome as loja_nome, l.lote, l.validade::text as validade,
           l.fabricacao::text as fabricacao, l.fornecedor_id, l.ativo,
           (exists (select 1 from movimentos_estoque m where m.lote_id = l.id)
             or exists (select 1 from itens_acerto_estoque i join acertos_estoque a on a.id = i.acerto_id
                         where i.lote_id = l.id and i.excluido_em is null and a.excluido_em is null
                           and a.status = 'rascunho')) as tem_movimento
      from produtos_lotes l
      left join estoques e on e.id = l.estoque_id
      left join lojas lj on lj.estoque_id = l.estoque_id and lj.excluido_em is null
     where l.produto_id = ${id} and l.variacao_id is null and l.excluido_em is null${visivel}
     order by l.validade nulls last, l.lote, l.id`);
  const pessoas = await opcoesPessoaPorId(
    db,
    rows.filter((l) => l.fornecedor_id).map((l) => l.fornecedor_id as string),
    { semDocumento: true },
  );
  return rows.map((l) => ({
    id: l.id as string,
    estoqueId: txt(l.estoque_id),
    estoqueNome: txt(l.estoque_nome),
    lojaNome: txt(l.loja_nome),
    lote: l.lote as string,
    validade: txt(l.validade),
    fabricacao: txt(l.fabricacao),
    fornecedorId: txt(l.fornecedor_id),
    fornecedor: l.fornecedor_id ? (pessoas.get(l.fornecedor_id as string) ?? null) : null,
    ativo: l.ativo as boolean,
    temMovimento: l.tem_movimento as boolean,
  }));
}

/**
 * As linhas por loja (`produtos_lojas`) e as faixas de preço por quantidade do produto (sem variação), no formato do
 * detalhe. `lojasVisiveis` (lojas permitidas; `null` = todas) esconde as de outras lojas (decisão 88). Também é o
 * `depois` dessas filhas na auditoria da gravação (F2-B42; decisão 188): o corpo traz só as lojas permitidas de quem
 * grava e a gravação preserva as outras, então copiar o corpo registraria como removidas as que só não vieram.
 */
export async function precosPorLojaDoProduto(
  db: DbEmpresa,
  id: string,
  lojasVisiveis: readonly string[] | null = null,
): Promise<Pick<ProdutoDetalhe, 'lojas' | 'precosQuantidade'>> {
  const lojaVisivel =
    lojasVisiveis === null
      ? sql``
      : lojasVisiveis.length
        ? sql` and (loja_id is null or loja_id in (${sql.join(
            lojasVisiveis.map((l) => sql`${l}::uuid`),
            sql`, `,
          )}))`
        : sql` and loja_id is null`;
  const lojas = await db.execute<Linha>(sql`
    select loja_id, estoque_minimo::text as estoque_minimo, estoque_maximo::text as estoque_maximo,
           preco_venda::text as preco_venda, ativo_na_loja, acrescimo_gelada::text as acrescimo_gelada
      from produtos_lojas where produto_id = ${id} and excluido_em is null${lojaVisivel}
     order by criado_em`);
  const faixas = await db.execute<Linha>(sql`
    select id, loja_id, quantidade_inicial::text as qi, quantidade_final::text as qf, preco::text as preco
      from produtos_precos_quantidade
     where produto_id = ${id} and variacao_id is null and excluido_em is null${lojaVisivel}
     order by loja_id nulls first, quantidade_inicial`);
  return {
    lojas: lojas.rows.map((l) => ({
      lojaId: l.loja_id as string,
      estoqueMinimo: txt(l.estoque_minimo),
      estoqueMaximo: txt(l.estoque_maximo),
      precoVenda: txt(l.preco_venda),
      ativoNaLoja: l.ativo_na_loja as boolean,
      acrescimoGelada: txt(l.acrescimo_gelada),
    })),
    precosQuantidade: faixas.rows.map((f) => ({
      id: f.id as string,
      lojaId: txt(f.loja_id),
      quantidadeInicial: f.qi as string,
      quantidadeFinal: txt(f.qf),
      preco: f.preco as string,
    })),
  };
}

/** Detalhe do produto com as filhas (sem custo quando o usuário não tem `produtos.ver_custo`). */
/**
 * Detalhe do produto. `lojasVisiveis` (lojas permitidas da sessão; `null` = todas) esconde `produtos_lojas` e
 * faixas de preço (do produto e do grupo) de outras lojas (decisão 88): a gravação preserva as que não vêm.
 * `estoquesVisiveis` (estoques permitidos; `null` = todos) faz o mesmo com os lotes de outros estoques (F2-B17).
 */
export async function detalheProduto(
  db: DbEmpresa,
  id: string,
  verCusto: boolean,
  lojasVisiveis: readonly string[] | null = null,
  estoquesVisiveis: readonly string[] | null = null,
): Promise<ProdutoDetalhe | null> {
  const lojaVisivel = (coluna: string) =>
    lojasVisiveis === null
      ? sql``
      : lojasVisiveis.length
        ? sql` and (${sql.raw(coluna)} is null or ${sql.raw(coluna)} in (${sql.join(
            lojasVisiveis.map((l) => sql`${l}::uuid`),
            sql`, `,
          )}))`
        : sql` and ${sql.raw(coluna)} is null`;
  const { rows } = await db.execute<Linha>(sql`
    select p.*, u.sigla as unidade_sigla, autor.nome as autor_nome,
           exists (select 1 from movimentos_estoque m where m.produto_id = p.id) as tem_movimento
      from produtos p
      join unidades_medida u on u.id = p.unidade_id
      left join usuarios autor on autor.id = p.atualizado_por_id
     where p.id = ${id} and p.excluido_em is null`);
  const p = rows[0];
  if (!p) return null;

  const codigos = await db.execute<Linha>(sql`
    select id, codigo, tipo, principal, descricao, unidade_id, fator::text as fator, preco::text as preco,
           usa_venda, usa_compra
      from produtos_codigos_barras
     where produto_id = ${id} and variacao_id is null and excluido_em is null
     order by principal desc, criado_em`);
  const { lojas, precosQuantidade } = await precosPorLojaDoProduto(db, id, lojasVisiveis);
  const categorias = await db.execute<{ categoria_id: string }>(sql`
    select categoria_id from produtos_categorias where produto_id = ${id} and excluido_em is null
     order by principal desc, criado_em`);
  const comps = await db.execute<Linha>(sql`
    select id, tipo, componente_id, componente_variacao_id, quantidade::text as quantidade,
           perda_pct::text as perda_pct, rotulo_posicao, permite_substituicao, ordem
      from produtos_componentes where produto_id = ${id} and excluido_em is null
     order by tipo, ordem, criado_em`);
  const alts = comps.rows.length
    ? await db.execute<Linha>(sql`
        select a.id, a.componente_id, a.produto_id, a.variacao_id, a.acrescimo::text as acrescimo, a.ordem, a.ativo
          from produtos_componentes_alternativas a
          join produtos_componentes pc on pc.id = a.componente_id
         where pc.produto_id = ${id} and pc.excluido_em is null and a.excluido_em is null
         order by a.ordem, a.criado_em`)
    : { rows: [] as Linha[] };
  // Relacionados (8.2.8; F2-B12): só os vivos e de produto não excluído; `inversa` = o outro já aponta para este.
  const rels = await db.execute<Linha>(sql`
    select r.id, r.relacionado_id, r.tipo, r.ordem,
           exists (select 1 from produtos_relacionados x
                    where x.produto_id = r.relacionado_id and x.relacionado_id = r.produto_id and x.tipo = r.tipo
                      and x.excluido_em is null) as inversa
      from produtos_relacionados r
      join produtos o on o.id = r.relacionado_id and o.excluido_em is null
     where r.produto_id = ${id} and r.excluido_em is null
     order by r.ordem, r.criado_em`);

  const idsOpcao = [
    ...rels.rows.map((r) => r.relacionado_id as string),
    ...comps.rows.map((c) => c.componente_id as string),
    ...alts.rows.map((a) => a.produto_id as string),
    ...(p.vasilhame_produto_id ? [p.vasilhame_produto_id as string] : []),
  ];
  const opcoes = await opcoesPorId(db, idsOpcao, verCusto);

  let grupoPreco: ProdutoDetalhe['grupoPreco'] = null;
  if (p.grupo_preco_quantidade_id) {
    const g = await db.execute<Linha>(sql`
      select id, codigo, nome, modo_preco, ativo from grupos_preco_quantidade where id = ${p.grupo_preco_quantidade_id as string}`);
    const gf = await db.execute<Linha>(sql`
      select loja_id, quantidade_inicial::text as qi, quantidade_final::text as qf, preco::text as preco
        from grupos_preco_quantidade_faixas
       where grupo_id = ${p.grupo_preco_quantidade_id as string} and excluido_em is null${lojaVisivel('loja_id')}
       order by loja_id nulls first, quantidade_inicial`);
    const linha = g.rows[0];
    if (linha) {
      grupoPreco = {
        id: linha.id as string,
        codigo: Number(linha.codigo),
        nome: linha.nome as string,
        modoPreco: linha.modo_preco as 'produto' | 'grupo',
        ativo: linha.ativo as boolean,
        faixas: gf.rows.map((f) => ({
          lojaId: (f.loja_id as string | null) ?? null,
          quantidadeInicial: f.qi as string,
          quantidadeFinal: (f.qf as string | null) ?? null,
          preco: f.preco as string,
        })),
      };
    }
  }

  const usados = await usadoEm(db, id);
  const avisosDoCombo = p.tipo === 'kit' ? await avisosCombo(db, id) : [];
  const componentes: ComponenteDetalhe[] = comps.rows.map((c) => ({
    id: c.id as string,
    tipo: c.tipo as 'kit' | 'ficha_tecnica',
    componenteId: c.componente_id as string,
    componenteVariacaoId: (c.componente_variacao_id as string | null) ?? null,
    quantidade: c.quantidade as string,
    perdaPct: c.perda_pct as string,
    rotuloPosicao: (c.rotulo_posicao as string | null) ?? null,
    permiteSubstituicao: c.permite_substituicao as boolean,
    ordem: Number(c.ordem),
    componente: opcoes.get(c.componente_id as string)!,
    alternativas: alts.rows
      .filter((a) => a.componente_id === c.id)
      .map((a) => ({
        id: a.id as string,
        produtoId: a.produto_id as string,
        variacaoId: (a.variacao_id as string | null) ?? null,
        acrescimo: a.acrescimo as string,
        ordem: Number(a.ordem),
        ativo: a.ativo as boolean,
        produto: opcoes.get(a.produto_id as string)!,
      })),
  }));

  const relacionados: RelacionadoDetalhe[] = rels.rows.map((r) => ({
    id: r.id as string,
    relacionadoId: r.relacionado_id as string,
    tipo: r.tipo as RelacionadoDetalhe['tipo'],
    ordem: Number(r.ordem),
    inversa: r.inversa as boolean,
    produto: opcoes.get(r.relacionado_id as string)!,
  }));

  const fornecedores = await fornecedoresDoProduto(db, id, verCusto);
  const lotes = await lotesDoProduto(db, id, estoquesVisiveis);
  const imagens = await imagensDoProduto(db, id);

  const codigosBarras = codigos.rows.map((c) => ({
    id: c.id as string,
    codigo: c.codigo as string,
    tipo: c.tipo as 'gtin' | 'interno',
    principal: c.principal as boolean,
    descricao: (c.descricao as string | null) ?? null,
    unidadeId: (c.unidade_id as string | null) ?? null,
    fator: c.fator as string,
    preco: (c.preco as string | null) ?? null,
    usaVenda: c.usa_venda as boolean,
    usaCompra: c.usa_compra as boolean,
  }));
  const data = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

  return {
    id,
    versao: await versaoAgregada(db, id),
    criadoEm: new Date(p.criado_em as string).toISOString(),
    atualizadoEm: new Date(p.atualizado_em as string).toISOString(),
    atualizadoPorNome: (p.autor_nome as string | null) ?? null,
    codigo: Number(p.codigo),
    nome: p.nome as string,
    tipo: p.tipo as TipoProduto,
    ativo: p.ativo as boolean,
    codigoInterno: txt(p.codigo_interno),
    unidadeId: p.unidade_id as string,
    unidadeSigla: p.unidade_sigla as string,
    permiteFracao: p.permite_fracao as boolean,
    ncm: txt(p.ncm),
    cest: txt(p.cest),
    precoCusto: verCusto ? txt(p.preco_custo) : null,
    custoMedio: verCusto ? txt(p.custo_medio) : null,
    markupPct: verCusto ? txt(p.markup_pct) : null,
    precoVenda: txt(p.preco_venda)!,
    precoAtacado: txt(p.preco_atacado),
    qtdMinimaAtacado: txt(p.qtd_minima_atacado),
    precoPromocional: txt(p.preco_promocional),
    promocaoInicio: data(p.promocao_inicio),
    promocaoFim: data(p.promocao_fim),
    precoMenuDigital: txt(p.preco_menu_digital),
    precoIfood: txt(p.preco_ifood),
    precoParcelado: txt(p.preco_parcelado),
    grupoPrecoQuantidadeId: txt(p.grupo_preco_quantidade_id),
    usaFichaTecnica: p.usa_ficha_tecnica as boolean,
    larguraCm: txt(p.largura_cm),
    alturaCm: txt(p.altura_cm),
    profundidadeCm: txt(p.profundidade_cm),
    pesoG: txt(p.peso_g),
    pesoAbatimentoG: txt(p.peso_abatimento_g),
    pesoPacoteKg: txt(p.peso_pacote_kg),
    localizacao: txt(p.localizacao),
    qtdMinimaVenda: txt(p.qtd_minima_venda),
    material: txt(p.material),
    comissaoPct: txt(p.comissao_pct),
    marcaId: txt(p.marca_id),
    categoriaPrincipalId: txt(p.categoria_principal_id),
    categorias: categorias.rows.map((c) => c.categoria_id),
    solicitaPrecoPdv: p.solicita_preco_pdv as boolean,
    solicitaLotePdv: p.solicita_lote_pdv as boolean,
    generico: p.generico as boolean,
    usaMenuDigital: p.usa_menu_digital as boolean,
    insumo: p.insumo as boolean,
    reposicaoRodizio: p.reposicao_rodizio as boolean,
    usaTotem: p.usa_totem as boolean,
    maisVendido: p.mais_vendido as boolean,
    descricaoCurta: txt(p.descricao_curta),
    descricaoLonga: txt(p.descricao_longa),
    controlaEstoque: p.controla_estoque as boolean,
    fotoPrincipalArquivoId: txt(p.foto_principal_arquivo_id),
    imagens,
    idadeMinima: p.idade_minima === null ? null : Number(p.idade_minima),
    vasilhameProdutoId: txt(p.vasilhame_produto_id),
    vasilhameQuantidade: p.vasilhame_quantidade === null ? null : Number(p.vasilhame_quantidade),
    balancaTipo: p.balanca_tipo as 'nao_usa' | 'peso' | 'unidade',
    balancaPlu: p.balanca_plu === null ? null : Number(p.balanca_plu),
    balancaValidadeDias: p.balanca_validade_dias === null ? null : Number(p.balanca_validade_dias),
    cfopVendaEstado: txt(p.cfop_venda_estado),
    cfopVendaForaEstado: txt(p.cfop_venda_fora_estado),
    icmsSituacao: txt(p.icms_situacao),
    icmsOrigem: txt(p.icms_origem),
    icmsModalidadeBc: txt(p.icms_modalidade_bc),
    icmsModalidadeBcst: txt(p.icms_modalidade_bcst),
    icmsAliquota: txt(p.icms_aliquota),
    icmsReducaoBcPct: txt(p.icms_reducao_bc_pct),
    icmsMvaPct: txt(p.icms_mva_pct),
    icmsAliquotaSt: txt(p.icms_aliquota_st),
    fcpAliquota: txt(p.fcp_aliquota),
    fcpStAliquota: txt(p.fcp_st_aliquota),
    beneficioFiscalCodigo: txt(p.beneficio_fiscal_codigo),
    pisSituacao: txt(p.pis_situacao),
    cofinsSituacao: txt(p.cofins_situacao),
    ipiSituacao: txt(p.ipi_situacao),
    pisAliquota: txt(p.pis_aliquota),
    cofinsAliquota: txt(p.cofins_aliquota),
    ipiAliquota: txt(p.ipi_aliquota),
    ipiEnquadramento: txt(p.ipi_enquadramento),
    ibsCbsCst: txt(p.ibs_cbs_cst),
    ibsCbsClassificacao: txt(p.ibs_cbs_classificacao),
    servicoCodigoLc116: txt(p.servico_codigo_lc116),
    ean: codigosBarras.find((c) => c.principal)?.codigo ?? null,
    codigosBarras,
    lojas,
    precosQuantidade,
    componentes,
    relacionados,
    fornecedores,
    lotes,
    grupoPreco,
    vasilhame: p.vasilhame_produto_id ? (opcoes.get(p.vasilhame_produto_id as string) ?? null) : null,
    usadoEm: usados,
    avisos: [
      ...avisosDoCombo.map(textoAvisoCombo),
      ...(!p.ativo && usados.some((u) => u.tipo === 'kit')
        ? [
            `Produto inativo usado nos combos ${usados
              .filter((u) => u.tipo === 'kit')
              .map((u) => `${u.codigo} - ${u.nome}`)
              .join(', ')}: reveja as posições.`,
          ]
        : []),
    ],
    avisosCombo: avisosDoCombo,
    temMovimento: p.tem_movimento as boolean,
  };
}
