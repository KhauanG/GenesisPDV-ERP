/**
 * Relatório **Produtos geral** (ERP 16.1; Fase 2, F2-B41; README da API › decisão 187): as margens do catálogo — o
 * preço de custo, a venda (a da loja escolhida, quando ela tem preço próprio), o atacado, o lucro em R$ (venda −
 * custo), o lucro % (lucro ÷ venda) e o markup % (lucro ÷ custo), com os departamentos —, e os totais do relatório
 * inteiro: a quantidade de produtos e as médias do lucro, do lucro % e do markup %.
 *
 * As contas ficam no PostgreSQL, em `numeric` (decimal exato): o lucro e as porcentagens com 2 casas por `round`, que
 * arredonda "meio para longe do zero" (ADR-05, o mesmo do `decimal.ts` e do C# `decimal`); as médias são a média
 * simples das linhas **antes** do arredondamento de cada uma (o lucro % só dos produtos com venda > 0; o markup % só
 * dos com custo > 0), arredondada no fim. O custo é o **preço de custo** do cadastro (`produtos.preco_custo`, o do markup
 * do formulário; o custo médio do estoque é o do Estoque Atual). Sem `produtos.ver_custo`, o custo, o lucro, as
 * porcentagens e as médias saem nulos (e ordenar por eles é 403), também no arquivo.
 *
 * Uma consulta (`sqlProdutosGeral`, as linhas na ordem estável) serve à exportação (o provedor da rota comum do
 * F2-B29) e à tela, que lê a página e, numa segunda ida, os totais do relatório inteiro. A coluna WooComm (publicado no
 * WooCommerce) fica fora até a integração da Fase 7. Só leitura.
 */
import {
  ORDENACOES_PRODUTOS_GERAL_CUSTO,
  RELATORIO_PRODUTOS_GERAL,
  filtrosProdutosGeralSchema,
  type ConsultaProdutosGeral,
  type FiltrosProdutosGeral,
  type LinhaProdutosGeral,
  type RespostaProdutosGeral,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { erroCampo, escaparLike } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Localização da auditoria da exportação. */
export const LOCALIZACAO_PRODUTOS_GERAL = 'Relatórios › Produtos geral';

const verCusto = (s: Pick<SessaoErp, 'permissoes'>) => s.permissoes.has('produtos.ver_custo');

/** Colunas da ordenação (`ordenar=campo:dir`); o desempate é sempre o nome e o código. */
const COLUNAS_ORDENACAO: Record<string, SQL> = {
  produto: sql`lower(fn_unaccent(x.nome))`,
  codigo: sql`x.codigo`,
  codigo_interno: sql`lower(x.codigo_interno)`,
  preco_venda: sql`x.venda`,
  preco_custo: sql`x.custo`,
  lucro: sql`x.lucro`,
  lucro_pct: sql`x.lucro_pct`,
  markup_pct: sql`x.markup_pct`,
};

/**
 * Confere a loja (entre as permitidas, 403; existente, 422) e a ordenação por custo (`produtos.ver_custo`, 403). Roda
 * no pedido e de novo na execução da tarefa (o `preparar` do provedor), com o acesso de agora.
 */
export async function prepararProdutosGeral<F extends FiltrosProdutosGeral>(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'lojas' | 'permissoes'>,
  f: F,
): Promise<F> {
  const campo = f.ordenar?.split(':')[0];
  if (campo && ORDENACOES_PRODUTOS_GERAL_CUSTO.includes(campo) && !verCusto(sessao))
    throw new ErroApi('SEM_PERMISSAO', 'Ordenar por custo, lucro ou markup exige "Ver custo".', {
      campos: { ordenar: ['Ordenar por custo, lucro ou markup exige "Ver custo"'] },
    });
  if (f.lojaId) {
    if (!lojaPermitida(sessao as SessaoErp, f.lojaId))
      throw new ErroApi('SEM_PERMISSAO', 'A loja está fora das suas lojas permitidas.', {
        campos: { lojaId: ['Fora das suas lojas permitidas'] },
      });
    const { rows } = await db.execute<{ id: string }>(
      sql`select id from lojas where id = ${f.lojaId} and excluido_em is null`,
    );
    if (!rows[0]) throw erroCampo('lojaId', 'Loja não encontrada');
  }
  return f;
}

/**
 * As linhas do relatório em `x` (o produto com a venda da loja, o custo, o lucro e as porcentagens sem arredondar),
 * já filtradas. A loja vem conferida (`prepararProdutosGeral`).
 */
function sqlBase(f: FiltrosProdutosGeral): SQL {
  const cond: SQL[] = [sql`p.excluido_em is null`];
  if (f.situacao === 'ativos') cond.push(sql`p.ativo`);
  if (f.situacao === 'inativos') cond.push(sql`not p.ativo`);
  if (f.marcaId) cond.push(sql`p.marca_id = ${f.marcaId}`);
  if (f.categoriaId)
    cond.push(sql`exists (select 1 from produtos_categorias pc join categorias c on c.id = pc.categoria_id
                     join categorias alvo on alvo.id = ${f.categoriaId}
                    where pc.produto_id = p.id and pc.excluido_em is null and c.excluido_em is null
                      and (c.caminho = alvo.caminho or c.caminho like alvo.caminho || '/%'))`);
  const nome = f.nome?.trim();
  if (nome)
    cond.push(sql`(p.busca like lower(fn_unaccent(${`%${escaparLike(nome)}%`})) or lower(p.codigo_interno) = lower(${nome})
        or exists (select 1 from produtos_codigos_barras cb where cb.produto_id = p.id and cb.excluido_em is null and cb.codigo = ${nome}))`);
  // O preço da loja, quando ela tem um próprio; sem loja (ou sem preço próprio), o do produto.
  const venda = f.lojaId ? sql`coalesce(pl.preco_venda, p.preco_venda)` : sql`p.preco_venda`;
  if (f.semPreco) cond.push(sql`${venda} = 0`);
  return sql`
    select p.id, p.codigo, p.nome, p.ativo, u.sigla, p.codigo_interno, m.descricao as marca_nome, p.ncm,
           p.categoria_principal_id, p.preco_custo as custo, ${venda} as venda, p.preco_atacado as atacado,
           ${venda} - p.preco_custo as lucro,
           case when ${venda} > 0 then (${venda} - p.preco_custo) / ${venda} * 100 end as lucro_pct,
           case when p.preco_custo > 0 then (${venda} - p.preco_custo) / p.preco_custo * 100 end as markup_pct
      from produtos p
      join unidades_medida u on u.id = p.unidade_id
      left join marcas m on m.id = p.marca_id
      ${f.lojaId ? sql`left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ${f.lojaId}::uuid and pl.excluido_em is null` : sql``}
     where ${sql.join(cond, sql` and `)}`;
}

/**
 * A consulta inteira, na ordem pedida com o desempate estável, com o EAN principal e os departamentos (a principal
 * primeiro) lidos só para as linhas que saem (`limite`/`deslocamento` na tela; a exportação lê tudo pelo cursor).
 */
export function sqlProdutosGeral(
  sessao: Pick<SessaoErp, 'permissoes'>,
  f: FiltrosProdutosGeral,
  pagina: { limite: number; deslocamento: number } | null = null,
): SQL {
  const [campo, direcao] = (f.ordenar ?? 'produto:asc').split(':') as [string, 'asc' | 'desc'];
  const coluna = COLUNAS_ORDENACAO[campo];
  if (!coluna) throw erroCampo('ordenar', `Use um de: ${Object.keys(COLUNAS_ORDENACAO).join(', ')}`);
  // Defensiva: a tela e a tarefa passam antes pelo `prepararProdutosGeral`, que já recusa; vale para quem montar a
  // consulta fora delas.
  if (ORDENACOES_PRODUTOS_GERAL_CUSTO.includes(campo) && !verCusto(sessao))
    throw ErroApi.semPermissao('Ordenar por custo, lucro ou markup exige "Ver custo".');
  const ordem = sql`${coluna} ${sql.raw(direcao)} nulls last, lower(fn_unaccent(x.nome)), x.codigo`;
  return sql`
    select x.id, x.codigo, x.nome, x.ativo, x.sigla, x.codigo_interno, x.marca_nome, x.ncm,
           x.custo::text as custo, x.venda::text as venda, x.atacado::text as atacado,
           round(x.lucro, 2)::text as lucro, round(x.lucro_pct, 2)::text as lucro_pct,
           round(x.markup_pct, 2)::text as markup_pct,
           (select cb.codigo from produtos_codigos_barras cb
             where cb.produto_id = x.id and cb.variacao_id is null and cb.excluido_em is null
             order by cb.principal desc, cb.id limit 1) as codigo_barras,
           array(select c.caminho_nomes from produtos_categorias pc
                   join categorias c on c.id = pc.categoria_id and c.excluido_em is null
                  where pc.produto_id = x.id and pc.excluido_em is null
                  order by (c.id = x.categoria_principal_id) desc, c.caminho_nomes, c.id) as departamentos
      from (select * from (${sqlBase(f)}) x
             order by ${ordem}
             ${pagina ? sql`limit ${pagina.limite} offset ${pagina.deslocamento}` : sql``}) x
     order by ${ordem}`;
}

interface LinhaBanco {
  id: string;
  codigo: number | string;
  nome: string;
  ativo: boolean;
  sigla: string;
  codigo_interno: string | null;
  marca_nome: string | null;
  ncm: string | null;
  custo: string;
  venda: string;
  atacado: string | null;
  lucro: string;
  lucro_pct: string | null;
  markup_pct: string | null;
  codigo_barras: string | null;
  departamentos: string[];
  [k: string]: unknown;
}

const linhaProdutosGeral = (r: LinhaBanco, custo: boolean): LinhaProdutosGeral => ({
  produtoId: r.id,
  produtoCodigo: Number(r.codigo),
  produtoNome: r.nome,
  ativo: r.ativo,
  unidadeSigla: r.sigla,
  codigoInterno: r.codigo_interno,
  codigoBarras: r.codigo_barras,
  marcaNome: r.marca_nome,
  ncm: r.ncm,
  precoCusto: custo ? r.custo : null,
  precoVenda: r.venda,
  precoAtacado: r.atacado,
  lucro: custo ? r.lucro : null,
  lucroPct: custo ? r.lucro_pct : null,
  markupPct: custo ? r.markup_pct : null,
  departamentos: r.departamentos ?? [],
});

/** A página da tela e os totais do relatório inteiro (a quantidade e as médias, em decimal). */
export async function paginaProdutosGeral(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'lojas' | 'permissoes'>,
  q: ConsultaProdutosGeral,
): Promise<RespostaProdutosGeral> {
  await prepararProdutosGeral(db, sessao, q);
  const custo = verCusto(sessao);
  const { rows } = await db.execute<LinhaBanco>(
    sqlProdutosGeral(sessao, q, { limite: q.tamanho, deslocamento: (q.pagina - 1) * q.tamanho }),
  );
  const { rows: t } = await db.execute<{
    n: number;
    lucro: string | null;
    lucro_pct: string | null;
    markup_pct: string | null;
  }>(sql`
    select count(*)::int as n, round(avg(x.lucro), 2)::text as lucro,
           round(avg(x.lucro_pct), 2)::text as lucro_pct, round(avg(x.markup_pct), 2)::text as markup_pct
      from (${sqlBase(q)}) x`);
  const totais = t[0]!;
  return {
    itens: rows.map((r) => linhaProdutosGeral(r, custo)),
    total: totais.n,
    pagina: q.pagina,
    tamanho: q.tamanho,
    totais: {
      quantidadeProdutos: totais.n,
      mediaLucro: custo ? totais.lucro : null,
      mediaLucroPct: custo ? totais.lucro_pct : null,
      mediaMarkupPct: custo ? totais.markup_pct : null,
    },
  };
}

const numero = (v: string | null) => (v === null ? null : Number(v));

/**
 * Provedor da exportação (`GET /relatorios/produtos-geral/exportar`, F2-B29; decisão 177): as colunas da tela, as de
 * custo marcadas (saem sem `produtos.ver_custo`), a loja e a ordenação conferidas de novo na execução da tarefa.
 */
export function provedorProdutosGeral(): ProvedorRelatorio<FiltrosProdutosGeral, LinhaBanco> {
  return {
    chave: RELATORIO_PRODUTOS_GERAL,
    nomeArquivo: 'Relatorio_Produtos_Geral',
    permissao: 'relatorios.produtos_geral',
    entidade: 'produtos',
    localizacao: LOCALIZACAO_PRODUTOS_GERAL,
    filtros: filtrosProdutosGeralSchema,
    preparar: (db, sessao, f) => prepararProdutosGeral(db, sessao, f),
    colunas: () => {
      const colunas: ColunaExportacao<LinhaBanco>[] = [
        { rotulo: 'Código', valor: (r) => Number(r.codigo) },
        { rotulo: 'Produto', valor: (r) => r.nome, largura: 40 },
        { rotulo: 'Unidade', valor: (r) => r.sigla },
        { rotulo: 'Código Interno', valor: (r) => r.codigo_interno },
        { rotulo: 'Código Barras', valor: (r) => r.codigo_barras, largura: 16 },
        { rotulo: 'Marca', valor: (r) => r.marca_nome },
        { rotulo: 'NCM', valor: (r) => r.ncm },
        { rotulo: 'Preço custo', valor: (r) => numero(r.custo), custo: true },
        { rotulo: 'Preço venda', valor: (r) => numero(r.venda) },
        { rotulo: 'Preço atacado', valor: (r) => numero(r.atacado) },
        { rotulo: 'Lucro R$', valor: (r) => numero(r.lucro), custo: true },
        { rotulo: 'Lucro %', valor: (r) => numero(r.lucro_pct), custo: true },
        { rotulo: 'Markup %', valor: (r) => numero(r.markup_pct), custo: true },
        { rotulo: 'Departamentos', valor: (r) => (r.departamentos ?? []).join(' | '), largura: 40 },
        { rotulo: 'Ativo', valor: (r) => (r.ativo ? 'Sim' : 'Não') },
      ];
      return colunas;
    },
    consulta: (sessao, f) => sqlProdutosGeral(sessao, f),
  };
}
