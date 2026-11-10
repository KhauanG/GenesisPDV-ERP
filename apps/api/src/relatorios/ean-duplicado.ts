/**
 * Relatório **EAN duplicado** (Fase 2, F2-B38; MD 3.6.5; ERP 8.2 "Regras", 20 item 2; README da API › decisão 184):
 * os códigos de barras `gtin` que estão em mais de um produto não excluído, com os produtos de cada um e o link para
 * editar. É o que a importação e a migração do Nuvem3 deixam para corrigir (elas aceitam o repetido mesmo com
 * "bloquear"); quando ele zera, a empresa volta `geral.ean_duplicado` de "avisar" para "bloquear".
 *
 * A regra é a do trigger `tg_produtos_codigos_barras_ean_unico` e a do filtro "EAN duplicado" da listagem: só o tipo
 * `gtin` (o código `interno` não entra na unicidade), a linha de código não excluída, o produto não excluído (ativo
 * ou não: o inativo também trava o cadastro do mesmo EAN) e o produto **distinto** (o mesmo código no pai e numa
 * variação do mesmo produto não é repetição). O agrupamento lê o `ix_produtos_codigos_barras_codigo` em ordem.
 *
 * Uma consulta (`sqlLinhasEanDuplicado`, uma linha por código × produto) serve à exportação (o provedor da rota comum
 * do F2-B29); a tela pagina pelos códigos (`paginaEanDuplicado`): a página dos códigos com o total, e os produtos dos
 * códigos da página numa segunda leitura, pelo mesmo índice. Só leitura, sem custo nem loja (o produto é da empresa).
 */
import {
  RELATORIO_EAN_DUPLICADO,
  filtrosEanDuplicadoSchema,
  type ConsultaEanDuplicado,
  type FiltrosEanDuplicado,
  type LinhaEanDuplicado,
  type ProdutoEanDuplicado,
  type RespostaEanDuplicado,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { escaparLike } from '../comum/cadastro.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Localização da auditoria da exportação. */
export const LOCALIZACAO_EAN_DUPLICADO = 'Relatórios › EAN duplicado';

/**
 * Os códigos repetidos com os filtros: `codigo` e `produtos` (os distintos). O começo do EAN filtra o código (o
 * grupo inteiro entra ou sai); o nome filtra pelo grupo (`bool_or`), então o código achado pelo nome de um produto
 * continua com todos os produtos dele.
 */
export function sqlCodigosDuplicados(f: FiltrosEanDuplicado): SQL {
  const nome = f.nome ? `%${escaparLike(f.nome)}%` : null;
  return sql`
    select cb.codigo, count(distinct cb.produto_id)::int as produtos
      from produtos_codigos_barras cb
      join produtos p on p.id = cb.produto_id and p.excluido_em is null
     where cb.excluido_em is null and cb.tipo = 'gtin'
       ${f.ean ? sql`and cb.codigo like ${`${f.ean}%`}` : sql``}
     group by cb.codigo
    having count(distinct cb.produto_id) > 1
       ${nome ? sql`and bool_or(p.busca like lower(fn_unaccent(${nome})))` : sql``}`;
}

/** As colunas de uma linha de código × produto (a tela e a exportação leem as mesmas). */
const colunasLinha = sql`
  cb.id as codigo_barras_id, cb.codigo, cb.principal, cb.descricao, cb.fator::text as fator,
  coalesce(uc.sigla, up.sigla) as unidade_sigla,
  p.id as produto_id, p.codigo as produto_codigo, p.nome as produto_nome, p.codigo_interno, p.ativo,
  m.descricao as marca_nome, cb.variacao_id, v.nome as variacao_nome`;

/** O de uma linha de código (o produto, a marca, a variação e as unidades). */
const juncoesLinha = sql`
  join produtos p on p.id = cb.produto_id and p.excluido_em is null
  join unidades_medida up on up.id = p.unidade_id
  left join unidades_medida uc on uc.id = cb.unidade_id
  left join marcas m on m.id = p.marca_id
  left join produtos_variacoes v on v.id = cb.variacao_id`;

/** Ordem estável das linhas de um código: o produto pelo código, o pai antes das variações, e o id da linha. */
const ordemLinha = sql`p.codigo, cb.variacao_id nulls first, v.nome, cb.id`;

interface LinhaBanco {
  codigo_barras_id: string;
  codigo: string;
  produtos: number;
  principal: boolean;
  descricao: string | null;
  fator: string;
  unidade_sigla: string;
  produto_id: string;
  produto_codigo: number | string;
  produto_nome: string;
  codigo_interno: string | null;
  ativo: boolean;
  marca_nome: string | null;
  variacao_id: string | null;
  variacao_nome: string | null;
  [k: string]: unknown;
}

/** Uma linha por código repetido × produto (e variação) com o código, na ordem do código: a da exportação. */
export function sqlLinhasEanDuplicado(f: FiltrosEanDuplicado): SQL {
  return sql`
    with d as (${sqlCodigosDuplicados(f)})
    select d.produtos, ${colunasLinha}
      from d
      join produtos_codigos_barras cb on cb.codigo = d.codigo and cb.excluido_em is null and cb.tipo = 'gtin'
      ${juncoesLinha}
     order by d.codigo, ${ordemLinha}`;
}

const produtoDaLinha = (r: LinhaBanco): ProdutoEanDuplicado => ({
  codigoBarrasId: r.codigo_barras_id,
  produtoId: r.produto_id,
  produtoCodigo: Number(r.produto_codigo),
  produtoNome: r.produto_nome,
  codigoInterno: r.codigo_interno,
  marcaNome: r.marca_nome,
  ativo: r.ativo,
  variacaoId: r.variacao_id,
  variacaoNome: r.variacao_nome,
  principal: r.principal,
  descricao: r.descricao,
  fator: r.fator,
  unidadeSigla: r.unidade_sigla,
});

/**
 * A página da tela: os códigos da página (em ordem, com o total pela janela, numa ida ao banco) e os produtos deles
 * (`cb.codigo in (...)`, pelo mesmo índice), agrupados aqui. Traz também o `geral.ean_duplicado` de agora.
 */
export async function paginaEanDuplicado(
  db: DbEmpresa,
  q: ConsultaEanDuplicado,
): Promise<RespostaEanDuplicado> {
  const modo =
    (await lerConfiguracao<string>(db, 'geral.ean_duplicado')) === 'avisar' ? 'avisar' : 'bloquear';
  const codigos = await db.execute<{ codigo: string; produtos: number; total: number }>(sql`
    with d as (${sqlCodigosDuplicados(q)})
    select d.codigo, d.produtos, (count(*) over ())::int as total
      from d
     order by d.codigo
     limit ${q.tamanho} offset ${(q.pagina - 1) * q.tamanho}`);
  let total = codigos.rows[0]?.total ?? 0;
  // A página depois da última não traz a janela: o total sai de uma contagem à parte (como nas listagens).
  if (!codigos.rows.length && q.pagina > 1) {
    const c = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from (${sqlCodigosDuplicados(q)}) d`,
    );
    total = c.rows[0]?.n ?? 0;
  }
  const itens: LinhaEanDuplicado[] = codigos.rows.map((r) => ({
    codigo: r.codigo,
    quantidadeProdutos: r.produtos,
    produtos: [],
  }));
  if (itens.length) {
    const porCodigo = new Map(itens.map((i) => [i.codigo, i]));
    const { rows } = await db.execute<LinhaBanco>(sql`
      select ${colunasLinha}
        from produtos_codigos_barras cb
        ${juncoesLinha}
       where cb.excluido_em is null and cb.tipo = 'gtin'
         and cb.codigo in (${sql.join(
           itens.map((i) => sql`${i.codigo}`),
           sql`, `,
         )})
       order by cb.codigo, ${ordemLinha}`);
    for (const r of rows) porCodigo.get(r.codigo)?.produtos.push(produtoDaLinha(r));
  }
  return { itens, total, pagina: q.pagina, tamanho: q.tamanho, modo };
}

/**
 * Provedor da exportação (`GET /relatorios/ean-duplicado/exportar`, F2-B29; decisão 177): uma linha por código ×
 * produto, com o código repetido em cada uma (a planilha filtra e ordena por ele). Ver o relatório é `produtos.ver`
 * (decisão 184), além do `relatorios.exportar` da rota comum.
 */
export function provedorEanDuplicado(): ProvedorRelatorio<FiltrosEanDuplicado, LinhaBanco> {
  return {
    chave: RELATORIO_EAN_DUPLICADO,
    nomeArquivo: 'Relatorio_EAN_Duplicado',
    permissao: 'produtos.ver',
    entidade: 'produtos_codigos_barras',
    localizacao: LOCALIZACAO_EAN_DUPLICADO,
    filtros: filtrosEanDuplicadoSchema,
    colunas: () => {
      const colunas: ColunaExportacao<LinhaBanco>[] = [
        { rotulo: 'EAN', valor: (r) => r.codigo, largura: 16 },
        { rotulo: 'Produtos no EAN', valor: (r) => Number(r.produtos) },
        { rotulo: 'Código', valor: (r) => Number(r.produto_codigo) },
        { rotulo: 'Ref. Interna', valor: (r) => r.codigo_interno },
        { rotulo: 'Produto', valor: (r) => r.produto_nome, largura: 40 },
        { rotulo: 'Variação', valor: (r) => r.variacao_nome },
        { rotulo: 'Marca', valor: (r) => r.marca_nome },
        { rotulo: 'EAN principal', valor: (r) => (r.principal ? 'Sim' : 'Não') },
        { rotulo: 'Embalagem', valor: (r) => r.descricao },
        { rotulo: 'Fator', valor: (r) => Number(r.fator) },
        { rotulo: 'Unidade', valor: (r) => r.unidade_sigla },
        { rotulo: 'Ativo', valor: (r) => (r.ativo ? 'Sim' : 'Não') },
      ];
      return colunas;
    },
    consulta: (_sessao, f) => sqlLinhasEanDuplicado(f),
  };
}
