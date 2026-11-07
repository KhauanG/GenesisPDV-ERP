/**
 * Relatório **Estoque Atual** (ERP 16.4; Fase 2, F2-B31; README da API › decisão 178): o `/saldos-estoque` (ERP
 * 8.2.11) estendido com a marca e o departamento (a categoria e as filhas), o "Todas" (uma linha por produto × tipo
 * com a soma dos estoques permitidos, sem a loja de treino por padrão, D39), o Atacado e o iFood, o "Em trânsito" e a
 * "Divergência a tratar" das transferências (F2-B26, as subconsultas de `transferencias/em-transito.ts`), o "Vencendo
 * em N dias" pelos lotes (`saldos_lote`) e a data-base "Saldo em <data>" pelo razão. O custo só sai com
 * `produtos.ver_custo`.
 *
 * Uma consulta só (`sqlEstoqueAtual`) serve à tela (com a página, o total e os totais pela janela, numa ida ao
 * banco) e à exportação (o provedor `provedorEstoqueAtual` da rota comum do F2-B29, com a sessão do momento na
 * execução da tarefa: os estoques permitidos e o custo são conferidos de novo).
 *
 * **Data-base** (decisão 176): o saldo no fim do dia (no fuso da empresa) sai pela **projeção menos o razão depois
 * da data** quando a data está na metade recente da história dos estoques escolhidos e pela **soma do razão até a
 * data** na metade antiga — as duas leem só a parte menor da história e dão o mesmo resultado enquanto a projeção bate
 * com o razão (o recalcular confere). A escolha fica no próprio SQL (`recente`, um filtro de uma vez só: o ramo que
 * não vale nem roda), então a tela e a tarefa calculam igual. O custo médio da data é o gravado
 * (`custo_medio_posterior`) no último movimento da linha **pela ordem de lançamento** (`seq_lancamento`, a da cadeia
 * do custo) antes do primeiro movimento com data depois dela: o lançado depois com data no passado (a venda offline
 * que sincroniza tarde, o cancelamento, o "Definir" retroativo) não traz para a data o custo das entradas posteriores.
 * Em trânsito e divergência não têm história: ficam nulos na data-base.
 *
 * **Sem movimento** (situação do saldo "Zerado" e "Abaixo do mínimo"): o produto que controla estoque e nunca teve
 * linha no estoque (no tipo escolhido, ou em nenhum tipo) entra com saldo 0 no tipo do filtro ou no padrão, como o
 * `incluirSemMovimento` do `/saldos-estoque` — a cerveja recém-cadastrada com mínimo e ainda não recebida é a mais
 * abaixo do mínimo.
 */
import {
  RELATORIO_ESTOQUE_ATUAL,
  filtrosEstoqueAtualSchema,
  limiteDeslocamento,
  type ConsultaEstoqueAtual,
  type FiltrosEstoqueAtual,
  type LinhaEstoqueAtual,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { escaparLike, erroCampo } from '../comum/cadastro.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import { fusoDaEmpresa, hojeNaEmpresa } from '../comum/fuso.js';
import { estoqueVisivel } from '../estoques/permitidos.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { sqlPendenciasTransferencia, sqlSaldosComPendencias } from '../transferencias/em-transito.js';

/** Localização da auditoria (o ajuste e a exportação). */
export const LOCALIZACAO_ESTOQUE_ATUAL = 'Relatórios › Estoque Atual';

const verCusto = (s: Pick<SessaoErp, 'permissoes'>) => s.permissoes.has('produtos.ver_custo');

/** Colunas da ordenação (`ordenar=campo:dir`); o desempate é sempre o mesmo (a ordem estável do cursor). */
const COLUNAS_ORDENACAO: Record<string, SQL> = {
  produto: sql`lower(fn_unaccent(x.produto_nome))`,
  codigo_interno: sql`lower(x.codigo_interno)`,
  estoque: sql`lower(x.estoque_nome)`,
  quantidade: sql`x.quantidade`,
  custo_medio: sql`x.custo_medio`,
  custo_total: sql`x.custo_bruto`,
  venda_total: sql`x.venda_bruta`,
};

/**
 * O que `prepararFiltrosEstoqueAtual` acrescenta: o fuso da empresa (`empresa.fuso_horario`), obrigatório na consulta
 * (o fim do dia da data-base sai dele; os testes e a carga passam o da empresa de teste).
 */
export interface FiltrosPreparados {
  fuso: string;
}

/** Como calcular o saldo da data-base: pela regra da metade (padrão) ou forçado (os testes conferem os dois). */
export type MetodoDataBase = 'automatico' | 'projecao' | 'soma';

/** A ordenação pedida, conferida (campo conhecido; o custo exige `produtos.ver_custo`). */
export function ordenacaoEstoqueAtual(
  sessao: Pick<SessaoErp, 'permissoes'>,
  ordenar: string | undefined,
): { coluna: SQL; direcao: 'asc' | 'desc' } {
  const [campo, direcao] = (ordenar ?? 'produto:asc').split(':') as [string, 'asc' | 'desc'];
  const coluna = COLUNAS_ORDENACAO[campo];
  if (!coluna) throw erroCampo('ordenar', `Use um de: ${Object.keys(COLUNAS_ORDENACAO).join(', ')}`);
  if (['custo_medio', 'custo_total'].includes(campo) && !verCusto(sessao))
    throw erroCampo('ordenar', 'Ordenar por custo exige "Ver custo"', 'REGRA_NEGOCIO');
  return { coluna, direcao };
}

/**
 * A consulta inteira do Estoque Atual, com a ordem estável e o filtro dos estoques permitidos da sessão, nas colunas
 * de `x` (as do `LinhaRelatorio`) mais `recente` (a data-base pela projeção) quando há data-base. Só leitura.
 */
export function sqlEstoqueAtual(
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  f: FiltrosEstoqueAtual & FiltrosPreparados,
  opcoes: { metodoDataBase?: MetodoDataBase; janela?: boolean; limite?: number; deslocamento?: number } = {},
): SQL {
  const { coluna, direcao } = ordenacaoEstoqueAtual(sessao, f.ordenar);
  const todas = !f.estoqueId;

  // Estoques do relatório: os permitidos (decisão 149), o escolhido ou, no "Todas", sem a loja de treino por padrão.
  const condEstoque: SQL[] = [sql`e.excluido_em is null`];
  const visivel = estoqueVisivel(sessao, sql`e.id`);
  if (visivel) condEstoque.push(visivel);
  const deTreino = sql`exists (select 1 from lojas lt where lt.estoque_id = e.id and lt.treino and lt.excluido_em is null)`;
  if (f.estoqueId) condEstoque.push(sql`e.id = ${f.estoqueId}`);
  else if (f.treino === 'excluir') condEstoque.push(sql`not ${deTreino}`);
  else if (f.treino === 'somente') condEstoque.push(deTreino);

  // Produtos do filtro (os com saldo próprio: combo e serviço não têm linha de saldo).
  const condProduto: SQL[] = [sql`p.excluido_em is null`, sql`p.tipo not in ('kit','servico')`];
  if (f.produtoId) condProduto.push(sql`p.id = ${f.produtoId}`);
  if (f.situacao === 'ativos') condProduto.push(sql`p.ativo`);
  if (f.situacao === 'inativos') condProduto.push(sql`not p.ativo`);
  if (f.marcaId) condProduto.push(sql`p.marca_id = ${f.marcaId}`);
  if (f.categoriaId)
    condProduto.push(sql`exists (select 1 from produtos_categorias pc join categorias c on c.id = pc.categoria_id
                     join categorias alvo on alvo.id = ${f.categoriaId}
                    where pc.produto_id = p.id and pc.excluido_em is null
                      and (c.caminho = alvo.caminho or c.caminho like alvo.caminho || '/%'))`);
  const nome = f.nome?.trim();
  if (nome)
    condProduto.push(sql`(p.busca like lower(fn_unaccent(${`%${escaparLike(nome)}%`})) or lower(p.codigo_interno) = lower(${nome})
        or exists (select 1 from produtos_codigos_barras cb where cb.produto_id = p.id and cb.excluido_em is null and cb.codigo = ${nome}))`);
  const produtoIds = f.produtoId ? [f.produtoId] : undefined;
  const doTipo = (col: SQL) => (f.tipoEstoqueId ? sql`and ${col} = ${f.tipoEstoqueId}` : sql``);

  const ctes: SQL[] = [
    sql`ea as (
      select e.id, e.nome, lj.id as loja_id
        from estoques e
        left join lateral (select l.id from lojas l where l.estoque_id = e.id and l.excluido_em is null
                            order by l.codigo limit 1) lj on true
       where ${sql.join(condEstoque, sql` and `)})`,
    sql`pf as (select p.id from produtos p where ${sql.join(condProduto, sql` and `)})`,
  ];

  // Linhas por estoque × produto × variação × tipo: quantidade, custo médio e as pendências da transferência.
  let recente: SQL | null = null;
  if (!f.dataBase) {
    ctes.push(sql`pd as (${sqlPendenciasTransferencia({ produtoIds })})`);
    ctes.push(sql`sl as (
      select s.estoque_id, s.produto_id, s.variacao_id, s.tipo_estoque_id, s.quantidade, s.custo_medio,
             coalesce(pdl.em_transito, 0) as em_transito, coalesce(pdl.divergencia, 0) as divergencia
        from (${sqlSaldosComPendencias({ produtoIds })}) s
        join ea on ea.id = s.estoque_id
        join pf on pf.id = s.produto_id
        left join pd pdl on pdl.estoque_id = s.estoque_id and pdl.produto_id = s.produto_id
                        and pdl.tipo_estoque_id = s.tipo_estoque_id
                        and pdl.variacao_id is not distinct from s.variacao_id
       where true ${doTipo(sql`s.tipo_estoque_id`)})`);
  } else {
    // Fim do dia da data-base (exclusivo), no fuso da empresa.
    const fim = sql`((${f.dataBase}::date + 1)::timestamp at time zone ${f.fuso}::text)`;
    // Metade recente: a data-base depois do meio entre o primeiro movimento dos estoques e agora (decisão 176).
    recente =
      opcoes.metodoDataBase === 'projecao'
        ? sql`true`
        : opcoes.metodoDataBase === 'soma'
          ? sql`false`
          : sql`(select coalesce(${fim} >= i.inicio + (now() - i.inicio) / 2, true)
                   from (select min(mi.inicio) as inicio from ea
                          cross join lateral (select min(m.data_movimento) as inicio from movimentos_estoque m
                                               where m.estoque_id = ea.id) mi) i)`;
    // `dep`: o razão depois da data, por linha, lido pelo `estoque_data` (só a parte recente; o filtro dos produtos fica
    // na junção com o saldo, senão o planejador desce o índice uma vez por estoque × produto).
    ctes.push(sql`dep as (
      select m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, sum(m.quantidade) as quantidade
        from movimentos_estoque m
        join ea on ea.id = m.estoque_id
       where m.data_movimento >= ${fim} ${doTipo(sql`m.tipo_estoque_id`)} and ${recente}
       group by m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id)`);
    // `sq`: a quantidade no fim da data, pela projeção menos o razão depois (metade recente) ou pela soma até a data
    // (metade antiga). Na projeção, a linha que só nasceu depois da data (zerada nela e sem movimento até ela) fica de
    // fora: a soma até a data também não a teria.
    ctes.push(sql`sq as (
      select s.estoque_id, s.produto_id, s.variacao_id, s.tipo_estoque_id,
             s.quantidade - coalesce(dep.quantidade, 0) as quantidade
        from saldos_estoque s
        join ea on ea.id = s.estoque_id
        join pf on pf.id = s.produto_id
        left join dep on dep.estoque_id = s.estoque_id and dep.produto_id = s.produto_id
                     and dep.tipo_estoque_id = s.tipo_estoque_id
                     and dep.variacao_id is not distinct from s.variacao_id
       where ${recente} ${doTipo(sql`s.tipo_estoque_id`)}
         and (s.quantidade - coalesce(dep.quantidade, 0) <> 0
              or exists (select 1 from movimentos_estoque m2
                          where m2.estoque_id = s.estoque_id and m2.produto_id = s.produto_id
                            and m2.variacao_id is not distinct from s.variacao_id
                            and m2.tipo_estoque_id = s.tipo_estoque_id and m2.data_movimento < ${fim}))
      union all
      select m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, sum(m.quantidade)
        from movimentos_estoque m
        join ea on ea.id = m.estoque_id
        join pf on pf.id = m.produto_id
       where not ${recente} and m.data_movimento < ${fim} ${doTipo(sql`m.tipo_estoque_id`)}
       group by m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id)`);
    // O custo médio da data: o `custo_medio_posterior` do último movimento da linha pela ordem de lançamento
    // (`seq_lancamento`, a da cadeia do custo; `ix_movimentos_estoque_linha_seq`) com data até ela e lançado antes do
    // primeiro movimento da linha com data depois dela (um passo à frente no `ix_movimentos_estoque_linha_data`). Pela
    // data só, a venda offline do dia 05 sincronizada no dia 07, depois da compra do dia 06, traria ao dia 05 o custo
    // dessa compra (a saída grava o custo vigente no lançamento). Sem movimento depois da data, é o último lançado.
    // Aproximação: o "primeiro depois" é o primeiro pela data, não pelo lançamento — só erra com dois lançamentos
    // retroativos cruzados (um com data depois da data-base lançado depois de outro ainda mais novo, e um com data até
    // ela lançado entre os dois). A variação nula vai pelo `is null` e a outra pela igualdade; a ordem repete todas as
    // colunas do índice (as quatro primeiras são fixas na linha) porque o planejador não trata o `is null` como
    // igualdade e, só com a data, leria a história inteira da linha e ordenaria (medido: 20 s com 4 milhões).
    // `materialized`: a coluna é usada três vezes no "Todas", e a CTE embutida repetiria a busca em cada uma.
    const daLinha = (m: string, variacao: 'nula' | 'igual') =>
      sql.raw(`${m}.estoque_id = sq.estoque_id and ${m}.produto_id = sq.produto_id
         and ${m}.variacao_id ${variacao === 'nula' ? 'is null' : '= sq.variacao_id'}
         and ${m}.tipo_estoque_id = sq.tipo_estoque_id`);
    const custoNaData = (variacao: 'nula' | 'igual') => sql`(
      select m.custo_medio_posterior from movimentos_estoque m
       where ${daLinha('m', variacao)} and m.data_movimento < ${fim}
         and sq.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : 'is not null')}
         and m.seq_lancamento < coalesce((
               select m3.seq_lancamento from movimentos_estoque m3
                where ${daLinha('m3', variacao)} and m3.data_movimento >= ${fim}
                order by m3.estoque_id, m3.produto_id, m3.variacao_id, m3.tipo_estoque_id, m3.data_movimento, m3.id
                limit 1), 9223372036854775807)
       order by m.estoque_id desc, m.produto_id desc, m.variacao_id desc, m.tipo_estoque_id desc,
                m.seq_lancamento desc
       limit 1)`;
    ctes.push(sql`sl as materialized (
      select sq.estoque_id, sq.produto_id, sq.variacao_id, sq.tipo_estoque_id, sq.quantidade,
             coalesce(${custoNaData('nula')}, ${custoNaData('igual')}, 0) as custo_medio,
             null::numeric as em_transito, null::numeric as divergencia
        from sq)`);
  }

  // Sem movimento ("Zerado" e "Abaixo do mínimo", os filtros em que o saldo 0 conta): o produto que controla estoque e
  // não tem linha no estoque (no tipo do filtro, ou em nenhum tipo) entra com 0 no tipo do filtro ou no padrão, uma
  // linha por estoque, como o `incluirSemMovimento` do `/saldos-estoque`. No "Todas", só o produto sem linha em nenhum
  // dos estoques escolhidos: o que tem linha em algum continua a soma das linhas, igual em qualquer filtro.
  const semMovimento = f.situacaoSaldo === 'zerado' || f.situacaoSaldo === 'abaixo_minimo';
  if (semMovimento) {
    const pendenciaZero = f.dataBase ? sql`null::numeric` : sql`0::numeric`;
    ctes.push(sql`sm as (
      select ea.id as estoque_id, p.id as produto_id, null::uuid as variacao_id, tp.id as tipo_estoque_id,
             0::numeric as quantidade, 0::numeric as custo_medio,
             ${pendenciaZero} as em_transito, ${pendenciaZero} as divergencia
        from ea
        cross join pf
        join produtos p on p.id = pf.id and p.controla_estoque
        cross join (select t.id from tipos_estoque t
                     where t.excluido_em is null and ${f.tipoEstoqueId ? sql`t.id = ${f.tipoEstoqueId}` : sql`t.padrao`}
                     limit 1) tp
       where not exists (select 1 from sl where sl.produto_id = p.id ${todas ? sql`` : sql`and sl.estoque_id = ea.id`}))`);
  }
  const linhas = semMovimento ? sql`(select * from sl union all select * from sm)` : sql`sl`;

  // "Vencendo em N dias": o saldo dos lotes com validade até hoje + N (inclusive os vencidos) e a validade mais próxima.
  const vencendo = f.vencendoEmDias !== undefined;
  if (vencendo)
    ctes.push(sql`vl as (
      select slt.estoque_id, slt.produto_id, slt.variacao_id, slt.tipo_estoque_id,
             sum(slt.quantidade) as quantidade, min(pl.validade) as validade
        from saldos_lote slt
        join produtos_lotes pl on pl.id = slt.lote_id
        join ea on ea.id = slt.estoque_id
        join pf on pf.id = slt.produto_id
       where slt.quantidade > 0 and pl.validade is not null
         and pl.validade <= ${hojeNaEmpresa} + ${f.vencendoEmDias}::int ${doTipo(sql`slt.tipo_estoque_id`)}
       group by slt.estoque_id, slt.produto_id, slt.variacao_id, slt.tipo_estoque_id)`);

  ctes.push(sql`lin as (
    select sl.estoque_id, ea.nome as estoque_nome, sl.tipo_estoque_id, t.nome as tipo_estoque_nome,
           sl.produto_id, sl.variacao_id, p.codigo as produto_codigo, p.nome as produto_nome, p.codigo_interno,
           mc.descricao as marca_nome, u.sigla, sl.quantidade, sl.custo_medio, sl.em_transito, sl.divergencia,
           p.preco_venda as preco_produto, coalesce(pl.preco_venda, p.preco_venda) as preco_venda,
           p.preco_atacado, p.preco_ifood, pl.estoque_minimo,
           ${vencendo ? sql`vl.quantidade` : sql`null::numeric`} as vencendo_qtd,
           ${vencendo ? sql`vl.validade` : sql`null::date`} as vencendo_validade
      from ${linhas} sl
      join ea on ea.id = sl.estoque_id
      join produtos p on p.id = sl.produto_id
      join unidades_medida u on u.id = p.unidade_id
      join tipos_estoque t on t.id = sl.tipo_estoque_id
      left join marcas mc on mc.id = p.marca_id
      left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ea.loja_id and pl.excluido_em is null
      ${
        vencendo
          ? sql`join vl on vl.estoque_id = sl.estoque_id and vl.produto_id = sl.produto_id
                       and vl.tipo_estoque_id = sl.tipo_estoque_id
                       and vl.variacao_id is not distinct from sl.variacao_id`
          : sql``
      })`);

  // Por estoque, a linha como está; no "Todas", a soma por produto × variação × tipo. O custo médio da soma é a média
  // ponderada pelos saldos positivos (sem saldo positivo, o maior custo médio das linhas); custo e venda totais são as
  // somas das linhas (cada uma ao preço da loja do seu estoque).
  ctes.push(
    todas
      ? sql`x as (
          select null::uuid as estoque_id, 'Todas'::text as estoque_nome, tipo_estoque_id, tipo_estoque_nome,
                 produto_id, variacao_id, produto_codigo, produto_nome, codigo_interno, marca_nome, sigla,
                 sum(quantidade) as quantidade,
                 coalesce(sum(quantidade * custo_medio) filter (where quantidade > 0)
                            / nullif(sum(quantidade) filter (where quantidade > 0), 0),
                          max(custo_medio)) as custo_medio,
                 sum(quantidade * custo_medio) as custo_bruto, sum(quantidade * preco_venda) as venda_bruta,
                 sum(em_transito) as em_transito, sum(divergencia) as divergencia,
                 preco_produto as preco_venda, preco_atacado, preco_ifood, sum(estoque_minimo) as estoque_minimo,
                 sum(vencendo_qtd) as vencendo_qtd, min(vencendo_validade) as vencendo_validade
            from lin
           group by tipo_estoque_id, tipo_estoque_nome, produto_id, variacao_id, produto_codigo, produto_nome,
                    codigo_interno, marca_nome, sigla, preco_produto, preco_atacado, preco_ifood)`
      : sql`x as (
          select estoque_id, estoque_nome, tipo_estoque_id, tipo_estoque_nome, produto_id, variacao_id,
                 produto_codigo, produto_nome, codigo_interno, marca_nome, sigla, quantidade, custo_medio,
                 quantidade * custo_medio as custo_bruto, quantidade * preco_venda as venda_bruta,
                 em_transito, divergencia, preco_venda, preco_atacado, preco_ifood, estoque_minimo,
                 vencendo_qtd, vencendo_validade
            from lin)`,
  );

  const situacaoSaldo =
    f.situacaoSaldo === 'positivo'
      ? sql`x.quantidade > 0`
      : f.situacaoSaldo === 'zerado'
        ? sql`x.quantidade = 0`
        : f.situacaoSaldo === 'negativo'
          ? sql`x.quantidade < 0`
          : f.situacaoSaldo === 'abaixo_minimo'
            ? sql`x.estoque_minimo is not null and x.quantidade < x.estoque_minimo`
            : sql`true`;
  const janela = opcoes.janela
    ? sql`, count(*) over () as total_linhas, round(sum(x.custo_bruto) over (), 2)::text as total_custo,
          round(sum(x.venda_bruta) over (), 2)::text as total_venda`
    : sql``;
  const paginacao =
    opcoes.limite !== undefined ? sql`limit ${opcoes.limite} offset ${opcoes.deslocamento ?? 0}` : sql``;
  return sql`
    with ${sql.join(ctes, sql`, `)}
    select x.estoque_id, x.estoque_nome, x.tipo_estoque_id, x.tipo_estoque_nome, x.produto_id, x.variacao_id,
           x.produto_codigo, x.produto_nome, x.codigo_interno, x.marca_nome, x.sigla,
           x.quantidade::numeric(15,3)::text as quantidade, round(x.custo_medio, 4)::text as custo_medio,
           round(x.custo_bruto, 2)::text as custo_total, round(x.venda_bruta, 2)::text as venda_total,
           x.em_transito::numeric(15,3)::text as em_transito, x.divergencia::numeric(15,3)::text as divergencia,
           x.preco_venda::text as preco_venda, x.preco_atacado::text as preco_atacado,
           x.preco_ifood::text as preco_ifood, x.estoque_minimo::numeric(15,3)::text as estoque_minimo,
           x.vencendo_qtd::numeric(15,3)::text as vencendo_qtd, to_char(x.vencendo_validade, 'YYYY-MM-DD') as vencendo_validade
           ${recente ? sql`, ${recente} as recente` : sql``} ${janela}
      from x
     where ${situacaoSaldo}
     order by ${coluna} ${sql.raw(direcao)} nulls last, x.produto_codigo, x.estoque_nome, x.tipo_estoque_nome,
              x.tipo_estoque_id, x.estoque_id, x.variacao_id
     ${paginacao}`;
}

/** A linha como o `pg` devolve (numeric em texto). */
export type LinhaBanco = {
  estoque_id: string | null;
  estoque_nome: string;
  tipo_estoque_id: string;
  tipo_estoque_nome: string;
  produto_id: string;
  variacao_id: string | null;
  produto_codigo: number;
  produto_nome: string;
  codigo_interno: string | null;
  marca_nome: string | null;
  sigla: string;
  quantidade: string;
  custo_medio: string | null;
  custo_total: string | null;
  venda_total: string;
  em_transito: string | null;
  divergencia: string | null;
  preco_venda: string;
  preco_atacado: string | null;
  preco_ifood: string | null;
  estoque_minimo: string | null;
  vencendo_qtd: string | null;
  vencendo_validade: string | null;
  recente?: boolean;
  total_linhas?: string;
  total_custo?: string | null;
  total_venda?: string | null;
};

export function linhaEstoqueAtual(r: LinhaBanco, custo: boolean): LinhaEstoqueAtual {
  return {
    chave: `${r.estoque_id ?? 'todas'}:${r.produto_id}:${r.variacao_id ?? ''}:${r.tipo_estoque_id}`,
    estoqueId: r.estoque_id,
    estoqueNome: r.estoque_nome,
    tipoEstoqueId: r.tipo_estoque_id,
    tipoEstoqueNome: r.tipo_estoque_nome,
    produtoId: r.produto_id,
    produtoCodigo: r.produto_codigo,
    produtoNome: r.produto_nome,
    variacaoId: r.variacao_id,
    codigoInterno: r.codigo_interno,
    marcaNome: r.marca_nome,
    unidadeSigla: r.sigla,
    quantidade: r.quantidade,
    emTransito: r.em_transito,
    divergenciaATratar: r.divergencia,
    estoqueMinimo: r.estoque_minimo,
    custoMedio: custo ? (r.custo_medio ?? '0.0000') : null,
    custoTotal: custo ? (r.custo_total ?? '0.00') : null,
    precoVenda: r.preco_venda,
    precoAtacado: r.preco_atacado,
    precoIfood: r.preco_ifood,
    vendaTotal: r.venda_total,
    vencendo:
      r.vencendo_qtd !== null && r.vencendo_validade !== null
        ? { quantidade: r.vencendo_qtd, validade: r.vencendo_validade }
        : null,
  };
}

/**
 * Os filtros prontos para a consulta (a tela e o `preparar` da exportação): o **fuso da empresa** vira um parâmetro
 * da consulta (com o fuso numa subconsulta, o fim do dia da data-base é um valor que o planejador não conhece, ele
 * estima um terço do razão "depois da data" e varre o índice da linha inteiro em vez do `estoque_data`: 0,7 s em vez
 * de 0,2 s com 4 milhões) e a data-base não pode passar de hoje (o "Saldo em" de amanhã seria o de agora com outro
 * nome).
 */
export async function prepararFiltrosEstoqueAtual<T extends FiltrosEstoqueAtual>(
  db: DbEmpresa,
  f: T,
): Promise<T & FiltrosPreparados> {
  const { rows } = await db.execute<{ fuso: string; futura: boolean | null }>(sql`
    select ${fusoDaEmpresa} as fuso, ${f.dataBase ?? null}::date > ${hojeNaEmpresa} as futura`);
  if (rows[0]?.futura) throw erroCampo('dataBase', 'A data-base não pode ser futura');
  return { ...f, fuso: rows[0]?.fuso ?? 'America/Sao_Paulo' };
}

/**
 * Página do Estoque Atual (`GET /relatorios/estoque-atual`): a consulta com a página e a janela (o total e os totais
 * do relatório inteiro na mesma ida ao banco); a página além do fim (sem linhas) conta à parte.
 */
export async function paginaEstoqueAtual(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  consulta: ConsultaEstoqueAtual,
) {
  const q = await prepararFiltrosEstoqueAtual(db, consulta);
  const { limite, deslocamento } = limiteDeslocamento(q);
  // Uma transação só de leitura com o JIT desligado (`semJit`): a consulta tem custo estimado alto e o JIT levaria
  // mais tempo compilando do que ela executando (1,5 s de 1,8 s com 4 milhões).
  const { rows, total, custoTotal, vendaTotal } = await db.transaction(
    async (tx) => {
      await tx.execute(sql`set local jit = off`);
      const { rows } = await tx.execute<LinhaBanco>(
        sqlEstoqueAtual(sessao, q, { janela: true, limite, deslocamento }),
      );
      if (rows.length || deslocamento === 0)
        return {
          rows,
          total: Number(rows[0]?.total_linhas ?? 0),
          custoTotal: rows[0]?.total_custo ?? null,
          vendaTotal: rows[0]?.total_venda ?? null,
        };
      // A página além do fim não traz a janela: o total e os totais à parte.
      const { rows: t } = await tx.execute<{ n: string; custo: string | null; venda: string | null }>(sql`
        select count(*)::text as n, round(sum(c.custo_total::numeric), 2)::text as custo,
               round(sum(c.venda_total::numeric), 2)::text as venda
          from (${sqlEstoqueAtual(sessao, q)}) c`);
      return {
        rows,
        total: Number(t[0]?.n ?? 0),
        custoTotal: t[0]?.custo ?? null,
        vendaTotal: t[0]?.venda ?? null,
      };
    },
    { accessMode: 'read only' },
  );
  const custo = verCusto(sessao);
  return {
    itens: rows.map((r) => linhaEstoqueAtual(r, custo)),
    total,
    pagina: q.pagina,
    tamanho: q.tamanho,
    totais: {
      quantidadeItens: total,
      custoTotal: custo ? (custoTotal ?? '0.00') : null,
      vendaTotal: vendaTotal ?? '0.00',
    },
    dataBase: q.dataBase ?? null,
  };
}

const numero = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/**
 * Provedor da exportação (`GET /relatorios/estoque-atual/exportar`, F2-B29; decisão 177): as colunas da tela, o
 * custo marcado (sai sem `produtos.ver_custo`) e a mesma consulta, com a sessão do momento (na tarefa, os estoques
 * permitidos e as permissões de agora).
 */
export function provedorEstoqueAtual(): ProvedorRelatorio<
  FiltrosEstoqueAtual & FiltrosPreparados,
  LinhaBanco,
  FiltrosEstoqueAtual
> {
  return {
    chave: RELATORIO_ESTOQUE_ATUAL,
    nomeArquivo: 'Relatorio_Estoque_Atual',
    permissao: 'relatorios.estoque_atual',
    entidade: 'saldos_estoque',
    localizacao: LOCALIZACAO_ESTOQUE_ATUAL,
    filtros: filtrosEstoqueAtualSchema,
    colunas: (_sessao, f) => {
      const colunas: ColunaExportacao<LinhaBanco>[] = [
        { rotulo: 'Ref. Interna', valor: (r) => r.codigo_interno },
        { rotulo: 'Código', valor: (r) => r.produto_codigo },
        { rotulo: 'Produto', valor: (r) => r.produto_nome, largura: 40 },
        { rotulo: 'Marca', valor: (r) => r.marca_nome },
        { rotulo: 'Estoque', valor: (r) => r.estoque_nome, largura: 24 },
        { rotulo: 'Tipo de estoque', valor: (r) => r.tipo_estoque_nome },
        { rotulo: 'Preço Custo', valor: (r) => numero(r.custo_medio), custo: true },
        { rotulo: 'Venda', valor: (r) => numero(r.preco_venda) },
        { rotulo: 'Atacado', valor: (r) => numero(r.preco_atacado) },
        { rotulo: 'iFood', valor: (r) => numero(r.preco_ifood) },
        { rotulo: 'Est. Mínimo', valor: (r) => numero(r.estoque_minimo) },
        {
          rotulo: f.dataBase ? `Saldo em ${f.dataBase.split('-').reverse().join('/')}` : 'Est. Atual',
          valor: (r) => numero(r.quantidade),
        },
      ];
      if (!f.dataBase)
        colunas.push(
          { rotulo: 'Em trânsito', valor: (r) => numero(r.em_transito) },
          { rotulo: 'Divergência a tratar', valor: (r) => numero(r.divergencia) },
        );
      if (f.vencendoEmDias !== undefined)
        colunas.push(
          { rotulo: 'Vencendo (qtd.)', valor: (r) => numero(r.vencendo_qtd) },
          {
            rotulo: 'Validade mais próxima',
            valor: (r) => r.vencendo_validade?.split('-').reverse().join('/'),
          },
        );
      colunas.push(
        { rotulo: 'Custo total', valor: (r) => numero(r.custo_total), custo: true },
        { rotulo: 'Venda total', valor: (r) => numero(r.venda_total) },
        { rotulo: 'Unidade', valor: (r) => r.sigla },
      );
      return colunas;
    },
    preparar: (db, _sessao, f) => prepararFiltrosEstoqueAtual(db, f),
    consulta: (sessao, f) => sqlEstoqueAtual(sessao, f),
    semJit: true,
    contar: (db, sessao, f) =>
      db.transaction(
        async (tx) => {
          await tx.execute(sql`set local jit = off`);
          const { rows } = await tx.execute<{ n: string }>(
            sql`select count(*)::text as n from (${sqlEstoqueAtual(sessao, f)}) c`,
          );
          return Number(rows[0]?.n ?? 0);
        },
        { accessMode: 'read only' },
      ),
  };
}
