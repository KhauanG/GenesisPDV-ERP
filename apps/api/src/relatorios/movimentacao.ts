/**
 * Relatório **Movimentação de Estoque** (ERP 16.5). Visão analítica (Fase 2, F2-B32; README da API › decisão 179): um
 * movimento do razão por linha, de um local de estoque num período (até 366 dias), com os filtros de produto, tipos de
 * movimento, usuário, documento e pessoa, nas colunas do export do Nuvem3 (MD 3.7.2) mais o custo gravado (só com
 * `produtos.ver_custo`), o documento com o número, o fornecedor do recebimento e a unidade base com o fator (a
 * quantidade está na unidade do produto; `sigla` é a do documento, como no Nuvem3). A visão sintética por produto com
 * a última compra (`sqlMovimentacaoSintetica`) e a exportação das duas (`provedorMovimentacao`) são do F2-B33
 * (decisão 180).
 *
 * **Paginação por cursor** `(data_movimento, id)` (decisão 176): a página sai do `ix_movimentos_estoque_estoque_data
 * (estoque_id, data_movimento, id)` na ordem, sem ordenar nem contar (um ano de uma loja passa de um milhão de
 * movimentos). O cursor é opaco para o ERP (`codificarCursor`): a data com os microssegundos do banco e o id da última
 * linha da página; a próxima página continua do que vem depois dele, então o movimento lançado no meio da leitura com
 * data já passada não desloca as páginas (ele só aparece se cair depois do cursor).
 *
 * **Saldo anterior e posterior recalculados** na ordem de `data_movimento` (não os gravados, que seguem a ordem de
 * lançamento): o saldo anterior de cada movimento é a soma do razão da sua linha de saldo (estoque × produto ×
 * variação × tipo) antes dele, pela chave `(data_movimento, id)`. Por linha da página, só a parte do razão **entre o
 * movimento anterior da mesma linha na página e ele** é lida (para o primeiro, a história antes dele), pelo
 * `ix_movimentos_estoque_linha_data (…, data_movimento, id) include (quantidade)` só pelo índice; as partes não se
 * sobrepõem e a janela soma as partes e as quantidades anteriores da página (`sqlParteAnterior`). Com filtro de tipo,
 * usuário ou documento, as partes incluem os movimentos que o filtro esconde: o saldo é o da linha de saldo, não o do
 * filtro. O gravado vai junto (`saldoAnteriorGravado`): os dois diferem quando uma venda offline chega tarde ou um
 * lançamento tem data no passado (o "Definir" na hora da contagem, a compensação).
 *
 * A consulta (`sqlMovimentacaoAnalitica`) recebe o fuso da empresa como parâmetro (`prepararFiltrosMovimentacao`, como
 * no Estoque Atual, decisão 178) e o filtro dos estoques permitidos da sessão; o provedor da exportação a usa sem mudar
 * (sem o limite; a soma por partes também serve à leitura inteira).
 */
import {
  exportacaoMovimentacaoEstoqueSchema,
  RELATORIO_MOVIMENTACAO_ESTOQUE,
  ROTULOS_DOCUMENTO_MOVIMENTACAO,
  type ConsultaMovimentacaoEstoque,
  type ConsultaMovimentacaoSintetica,
  type DocumentoMovimentacao,
  type FiltrosExportacaoMovimentacao,
  type FiltrosMovimentacaoEstoque,
  type LinhaMovimentacaoEstoque,
  type LinhaMovimentacaoSintetica,
  type RespostaMovimentacaoEstoque,
  type RespostaMovimentacaoSintetica,
  type VisaoMovimentacao,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import { fusoDaEmpresa } from '../comum/fuso.js';
import { estoquePermitido, estoqueVisivel } from '../estoques/permitidos.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const verCusto = (s: Pick<SessaoErp, 'permissoes'>) => s.permissoes.has('produtos.ver_custo');

/** O ponto da página: a data do último movimento (com os microssegundos, em UTC) e o id dele. */
export interface CursorMovimentacao {
  data: string;
  id: string;
}

const DATA_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const codificarCursor = (c: CursorMovimentacao): string =>
  Buffer.from(`${c.data}|${c.id}`, 'utf8').toString('base64url');

/** O cursor da query; o inválido (editado à mão, de outra versão) é `VALIDACAO` no campo. */
export function decodificarCursor(texto: string): CursorMovimentacao {
  const [data, id, ...resto] = Buffer.from(texto, 'base64url').toString('utf8').split('|');
  if (resto.length || !data || !id || !DATA_CURSOR.test(data) || !UUID.test(id))
    throw erroCampo('cursor', 'Página inválida: volte para a primeira página');
  return { data, id };
}

/**
 * O que `prepararFiltrosMovimentacao` acrescenta: o fuso da empresa (`empresa.fuso_horario`) como parâmetro (o
 * planejador usa o começo e o fim do período nas estimativas, decisão 178).
 */
export interface FiltrosPreparadosMovimentacao {
  fuso: string;
}

/** A tabela e a coluna do número de cada documento (o da coluna Documento e o do filtro). */
const NUMERO_DOCUMENTO: Partial<
  Record<DocumentoMovimentacao, { tabela: string; coluna: string; texto: boolean }>
> = {
  venda: { tabela: 'vendas', coluna: 'numero_exibicao', texto: true },
  acerto: { tabela: 'acertos_estoque', coluna: 'codigo', texto: false },
  recebimento: { tabela: 'recebimentos', coluna: 'codigo', texto: false },
  // O Nº da NF-e do fornecedor (o que está no papel), não o código interno da nota.
  nota_entrada: { tabela: 'notas_entrada', coluna: 'numero', texto: false },
  transferencia: { tabela: 'transferencias_estoque', coluna: 'codigo', texto: false },
};

/** O número do documento do movimento (alias `m`; nulo na troca e no vasilhame, que não têm um número próprio). */
function sqlNumeroDocumento(m: string): SQL {
  const casos = Object.entries(NUMERO_DOCUMENTO).map(
    ([tipo, d]) =>
      `when '${tipo}' then (select d.${d.coluna}::text from ${d.tabela} d where d.id = ${m}.documento_id)`,
  );
  return sql.raw(`(case ${m}.documento_tipo ${casos.join(' ')} end)`);
}

/**
 * O saldo da linha de saldo do movimento `p` (estoque × produto × variação × tipo) **entre** o movimento anterior da
 * mesma linha na página (`p.ant_data`, `p.ant_id`; sem ele, desde o começo) e `p`, exclusive, pela chave do cursor e
 * só pelo `ix_movimentos_estoque_linha_data`. A variação nula vai pelo `is null` e a outra pela igualdade (o
 * planejador não trata o `is not distinct from` como igualdade no índice; decisão 178).
 *
 * Sem filtro de movimento (`semFiltro`: tipos, usuário, pessoa, documento), a parte entre dois movimentos da mesma
 * linha na página é sempre vazia — todo movimento do local no trecho da página está nela, e o produto filtrado é o da
 * linha —, então só o primeiro de cada linha lê o índice (F2-B33: a exportação da analítica inteira, 1,6 milhão de
 * movimentos numa loja, faria duas buscas no índice por movimento para achar nada).
 */
function sqlParteAnterior(semFiltro: boolean): SQL {
  const parte = (variacao: 'nula' | 'igual') => sql`(
    select sum(x.quantidade) from movimentos_estoque x
     where x.estoque_id = p.estoque_id and x.produto_id = p.produto_id
       and x.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : '= p.variacao_id')}
       and p.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : 'is not null')}
       and x.tipo_estoque_id = p.tipo_estoque_id
       and (x.data_movimento, x.id) < (p.data_movimento, p.id)
       and (x.data_movimento, x.id) > (coalesce(p.ant_data, '-infinity'::timestamptz),
                                      coalesce(p.ant_id, '00000000-0000-0000-0000-000000000000'::uuid)))`;
  const soma = sql`coalesce(${parte('nula')}, ${parte('igual')}, 0)`;
  return semFiltro ? sql`(case when p.ant_id is null then ${soma} else 0 end)` : soma;
}

/**
 * As condições da Movimentação sobre o razão (alias `m`), em três partes: `local` — o local, os estoques permitidos da
 * sessão e o produto, que escolhem as **linhas de saldo** —, `periodo` (dias de calendário no fuso da empresa: do
 * começo do dia inicial, `inicio`, ao começo do dia seguinte ao final, `fim`) e `filtro` — tipos de movimento, usuário,
 * pessoa e documento, que escolhem os **movimentos** sem mudar o saldo da linha (a sintética soma as entradas e as
 * saídas só deles e os saldos da linha inteira). A analítica usa as três juntas.
 */
export function condicoesMovimentacao(
  sessao: Pick<SessaoErp, 'estoques'>,
  f: FiltrosMovimentacaoEstoque & FiltrosPreparadosMovimentacao,
): { local: SQL[]; periodo: SQL[]; filtro: SQL[]; inicio: SQL; fim: SQL } {
  const inicio = sql`(${f.dataInicial}::date::timestamp at time zone ${f.fuso}::text)`;
  const fim = sql`((${f.dataFinal}::date + 1)::timestamp at time zone ${f.fuso}::text)`;
  const local: SQL[] = [sql`m.estoque_id = ${f.estoqueId}`];
  const periodo = [sql`m.data_movimento >= ${inicio}`, sql`m.data_movimento < ${fim}`];
  const visivel = estoqueVisivel(sessao, sql`m.estoque_id`);
  if (visivel) local.push(visivel);
  if (f.produtoId) local.push(sql`m.produto_id = ${f.produtoId}`);
  const filtro: SQL[] = [];
  if (f.tiposMovimento?.length)
    filtro.push(
      sql`m.tipo_movimento in (${sql.join(
        f.tiposMovimento.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  if (f.usuarioId) filtro.push(sql`m.usuario_id = ${f.usuarioId}`);
  if (f.pessoaId) filtro.push(sql`m.pessoa_id = ${f.pessoaId}`);
  if (f.documentoTipo) {
    filtro.push(sql`m.documento_tipo = ${f.documentoTipo}`);
    const d = NUMERO_DOCUMENTO[f.documentoTipo];
    if (f.documentoNumero && d) {
      // O número que não é um inteiro não acha documento de código numérico (sem erro de conversão no banco).
      const numero = d.texto
        ? f.documentoNumero
        : /^\d{1,9}$/.test(f.documentoNumero)
          ? f.documentoNumero
          : null;
      filtro.push(
        numero === null
          ? sql`false`
          : sql`m.documento_id in (select d.id from ${sql.raw(d.tabela)} d where d.${sql.raw(d.coluna)} = ${
              d.texto ? sql`${numero}` : sql`${numero}::int`
            })`,
      );
    }
  }
  return { local, periodo, filtro, inicio, fim };
}

/**
 * A visão analítica inteira (com `limite`, a página depois do `cursor`), na ordem `(data_movimento, id)`, com o filtro
 * dos estoques permitidos da sessão. Colunas: as de `LinhaBancoMovimentacao`. Só leitura.
 */
export function sqlMovimentacaoAnalitica(
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  f: FiltrosMovimentacaoEstoque & FiltrosPreparadosMovimentacao,
  opcoes: { limite?: number; cursor?: CursorMovimentacao } = {},
): SQL {
  const { local, periodo, filtro } = condicoesMovimentacao(sessao, f);
  const cond = [...local, ...periodo, ...filtro];
  if (opcoes.cursor)
    cond.push(
      sql`(m.data_movimento, m.id) > (${opcoes.cursor.data}::timestamptz, ${opcoes.cursor.id}::uuid)`,
    );
  const limite = opcoes.limite !== undefined ? sql`limit ${opcoes.limite}` : sql``;
  const custo = verCusto(sessao);

  // `pag`: os movimentos da página, na ordem do índice, com o movimento anterior da mesma linha de saldo na página.
  // `materialized`: a página é lida uma vez (a janela e as partes do saldo leem dela).
  return sql`
    with pag as materialized (
      select m.id, m.data_movimento, m.estoque_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.loja_id,
             m.tipo_movimento, m.quantidade, m.unidade_documento, m.fator, m.saldo_anterior, m.saldo_posterior,
             m.custo_unitario, m.custo_total, m.usuario_id, m.pessoa_id, m.documento_tipo, m.documento_id,
             m.observacao
        from movimentos_estoque m
       where ${sql.join(cond, sql` and `)}
       order by m.data_movimento, m.id
       ${limite}),
    p as (
      select pag.*, lag(pag.data_movimento) over linha as ant_data, lag(pag.id) over linha as ant_id
        from pag
      window linha as (partition by pag.produto_id, pag.variacao_id, pag.tipo_estoque_id
                       order by pag.data_movimento, pag.id)),
    s as (
      select p.*, ${sqlParteAnterior(filtro.length === 0)} as parte from p),
    -- O saldo anterior: as partes do razão até o movimento (inclusive a dele) e as quantidades da página antes dele.
    sa as (
      select s.*,
             sum(s.parte) over linha
               + coalesce(sum(s.quantidade) over (linha rows between unbounded preceding and 1 preceding), 0)
               as saldo_recalculado
        from s
      window linha as (partition by s.produto_id, s.variacao_id, s.tipo_estoque_id order by s.data_movimento, s.id))
    select sa.id, to_char(sa.data_movimento at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as data_movimento,
           sa.produto_id, pr.codigo as produto_codigo, pr.codigo_interno, pr.nome as produto_nome,
           sa.variacao_id, pv.nome as variacao_nome, sa.tipo_movimento, tm.nome as tipo_movimento_nome,
           tm.id_nuvem3, sa.tipo_estoque_id, te.nome as tipo_estoque_nome, e.nome as estoque_nome,
           l.nome as loja_nome,
           sa.saldo_recalculado::numeric(15,3)::text as saldo_anterior,
           sa.quantidade::text as quantidade,
           (sa.saldo_recalculado + sa.quantidade)::numeric(15,3)::text as saldo_posterior,
           sa.saldo_anterior::text as saldo_anterior_gravado, sa.saldo_posterior::text as saldo_posterior_gravado,
           coalesce(sa.unidade_documento, u.sigla) as sigla, u.sigla as unidade_base, sa.fator::text as fator,
           us.nome as usuario_nome,
           ${custo ? sql`sa.custo_unitario::text` : sql`null::text`} as custo_unitario,
           ${custo ? sql`sa.custo_total::text` : sql`null::text`} as custo_total,
           sa.documento_tipo, sa.documento_id, ${sqlNumeroDocumento('sa')} as documento_numero,
           -- A pessoa sai sempre que o movimento tem (o filtro Pessoa acha o movimento, a coluna mostra quem): o
           -- fornecedor no recebimento e na nota; o cliente nos demais (venda, troca, cascos devolvidos avulsos e a
           -- compensação, que herda a pessoa da venda compensada).
           case when sa.documento_tipo not in ('recebimento', 'nota_entrada') then pe.nome end as pessoa_venda,
           case when sa.documento_tipo in ('recebimento', 'nota_entrada') then pe.nome end as fornecedor,
           sa.observacao
      from sa
      join produtos pr on pr.id = sa.produto_id
      join unidades_medida u on u.id = pr.unidade_id
      join tipos_movimento_estoque tm on tm.codigo = sa.tipo_movimento
      join tipos_estoque te on te.id = sa.tipo_estoque_id
      join estoques e on e.id = sa.estoque_id
      left join produtos_variacoes pv on pv.id = sa.variacao_id
      left join lojas l on l.id = sa.loja_id
      left join usuarios us on us.id = sa.usuario_id
      left join pessoas pe on pe.id = sa.pessoa_id
     order by sa.data_movimento, sa.id`;
}

/** A linha como o `pg` devolve (numeric em texto). */
export type LinhaBancoMovimentacao = {
  id: string;
  data_movimento: string;
  produto_id: string;
  produto_codigo: number;
  codigo_interno: string | null;
  produto_nome: string;
  variacao_id: string | null;
  variacao_nome: string | null;
  tipo_movimento: string;
  tipo_movimento_nome: string;
  id_nuvem3: number | null;
  tipo_estoque_id: string;
  tipo_estoque_nome: string;
  estoque_nome: string;
  loja_nome: string | null;
  saldo_anterior: string;
  quantidade: string;
  saldo_posterior: string;
  saldo_anterior_gravado: string;
  saldo_posterior_gravado: string;
  sigla: string;
  unidade_base: string;
  fator: string;
  usuario_nome: string | null;
  custo_unitario: string | null;
  custo_total: string | null;
  documento_tipo: DocumentoMovimentacao;
  documento_id: string | null;
  documento_numero: string | null;
  pessoa_venda: string | null;
  fornecedor: string | null;
  observacao: string | null;
};

export function linhaMovimentacao(r: LinhaBancoMovimentacao): LinhaMovimentacaoEstoque {
  return {
    id: r.id,
    dataMovimento: r.data_movimento,
    produtoId: r.produto_id,
    produtoCodigo: r.produto_codigo,
    codigoInterno: r.codigo_interno,
    produtoNome: r.produto_nome,
    variacaoId: r.variacao_id,
    variacaoNome: r.variacao_nome,
    tipoMovimento: r.tipo_movimento,
    tipoMovimentoNome: r.tipo_movimento_nome,
    idNuvem3: r.id_nuvem3,
    tipoEstoqueId: r.tipo_estoque_id,
    tipoEstoqueNome: r.tipo_estoque_nome,
    estoqueNome: r.estoque_nome,
    lojaNome: r.loja_nome,
    saldoAnterior: r.saldo_anterior,
    quantidade: r.quantidade,
    saldoPosterior: r.saldo_posterior,
    saldoAnteriorGravado: r.saldo_anterior_gravado,
    saldoPosteriorGravado: r.saldo_posterior_gravado,
    sigla: r.sigla,
    unidadeBase: r.unidade_base,
    fator: r.fator,
    usuarioNome: r.usuario_nome,
    custoUnitario: r.custo_unitario,
    custoTotal: r.custo_total,
    documento: { tipo: r.documento_tipo, id: r.documento_id, numero: r.documento_numero },
    pessoaVenda: r.pessoa_venda,
    fornecedor: r.fornecedor,
    observacao: r.observacao,
  };
}

type Referencias = RespostaMovimentacaoEstoque['referencias'];

/**
 * Os filtros prontos para a consulta (as duas visões da tela e o `preparar` da exportação), numa ida ao banco: o fuso da
 * empresa vira parâmetro; o local tem de existir e estar entre os permitidos (403 fora deles: o local é escolhido pelo
 * nome, e a lista da tela só mostra os permitidos); os tipos de movimento têm de existir; e os nomes do local, do
 * produto e da pessoa escolhidos voltam para a tela.
 */
export async function prepararFiltrosMovimentacao<T extends FiltrosMovimentacaoEstoque>(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'estoques'>,
  f: T,
): Promise<T & FiltrosPreparadosMovimentacao & { referencias: Referencias }> {
  const tipos = f.tiposMovimento ?? [];
  const { rows } = await db.execute<{
    fuso: string;
    estoque_nome: string | null;
    produto: { id: string; codigo: number; nome: string } | null;
    pessoa: { id: string; codigo: number; nome: string } | null;
    tipos_desconhecidos: string[] | null;
  }>(sql`
    select ${fusoDaEmpresa} as fuso,
           (select e.nome from estoques e where e.id = ${f.estoqueId} and e.excluido_em is null) as estoque_nome,
           (select json_build_object('id', p.id, 'codigo', p.codigo, 'nome', p.nome)
              from produtos p where p.id = ${f.produtoId ?? null}::uuid) as produto,
           (select json_build_object('id', pe.id, 'codigo', pe.codigo, 'nome', pe.nome)
              from pessoas pe where pe.id = ${f.pessoaId ?? null}::uuid) as pessoa,
           (select array_agg(t) from unnest(${`{${tipos.join(',')}}`}::text[]) t
             where not exists (select 1 from tipos_movimento_estoque tm where tm.codigo = t)) as tipos_desconhecidos`);
  const r = rows[0]!;
  if (!estoquePermitido(sessao, f.estoqueId, 'ver'))
    throw ErroApi.semPermissao('O local de estoque está fora dos seus estoques permitidos.');
  if (r.estoque_nome === null) throw erroCampo('estoqueId', 'Local de estoque não encontrado');
  if (r.tipos_desconhecidos?.length)
    throw erroCampo('tiposMovimento', `Tipo de movimento desconhecido: ${r.tipos_desconhecidos.join(', ')}`);
  return {
    ...f,
    fuso: r.fuso,
    referencias: { estoque: { id: f.estoqueId, nome: r.estoque_nome }, produto: r.produto, pessoa: r.pessoa },
  };
}

/**
 * Página da Movimentação analítica (`GET /relatorios/movimentacao-estoque`): `tamanho + 1` movimentos depois do
 * cursor (o a mais diz se há próxima página e não volta), numa transação só de leitura com o JIT desligado (as
 * subconsultas do saldo têm custo estimado alto, e o JIT compilaria mais do que a página executa; decisão 178).
 */
export async function paginaMovimentacao(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  consulta: ConsultaMovimentacaoEstoque,
): Promise<RespostaMovimentacaoEstoque> {
  const cursor = consulta.cursor ? decodificarCursor(consulta.cursor) : undefined;
  const { referencias, ...f } = await prepararFiltrosMovimentacao(db, sessao, consulta);
  const rows = await db.transaction(
    async (tx) => {
      await tx.execute(sql`set local jit = off`);
      const { rows } = await tx.execute<LinhaBancoMovimentacao>(
        sqlMovimentacaoAnalitica(sessao, f, { limite: consulta.tamanho + 1, cursor }),
      );
      return rows;
    },
    { accessMode: 'read only' },
  );
  const pagina = rows.slice(0, consulta.tamanho);
  const ultima = pagina.at(-1);
  return {
    itens: pagina.map(linhaMovimentacao),
    proximoCursor:
      rows.length > consulta.tamanho && ultima
        ? codificarCursor({ data: ultima.data_movimento, id: ultima.id })
        : null,
    tamanho: consulta.tamanho,
    referencias,
  };
}

// ---------------------------------------------------------------- Visão sintética (F2-B33)

/** O uuid zero: a variação nula na junção da última compra (o `coalesce` deixa a igualdade usar o hash). */
const UUID_ZERO = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

/**
 * O saldo da linha de saldo `s` (estoque × produto × variação × tipo) antes do começo do período, só pelo
 * `ix_movimentos_estoque_linha_data` (a variação nula pelo `is null`, a outra pela igualdade; decisão 178).
 */
function sqlSaldoAntes(estoqueId: string, inicio: SQL): SQL {
  const parte = (variacao: 'nula' | 'igual') => sql`(
    select sum(x.quantidade) from movimentos_estoque x
     where x.estoque_id = ${estoqueId} and x.produto_id = s.produto_id
       and x.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : '= s.variacao_id')}
       and s.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : 'is not null')}
       and x.tipo_estoque_id = s.tipo_estoque_id
       and x.data_movimento < ${inicio})`;
  return sql`coalesce(${parte('nula')}, ${parte('igual')}, 0)`;
}

/**
 * A visão **sintética por produto** (ERP 16.5; F2-B33; README da API › decisão 180): uma linha por linha de saldo do
 * local (produto × variação × tipo de estoque) com movimento no período nos filtros, na ordem do nome do produto (com o
 * desempate pelos ids: a ordem estável do cursor da exportação). Colunas: as de `LinhaBancoSintetica`. Só leitura.
 *
 * - **Uma passada pelo período** do local (`per`, pelo `ix_movimentos_estoque_estoque_data`): por linha, a soma de
 *   todos os movimentos (`no_periodo`, o que leva o saldo inicial ao final) e, com o `filter` dos filtros de movimento
 *   (`condicoesMovimentacao().filtro`), as entradas, as saídas (sem o sinal), os custos gravados e a contagem; a linha
 *   sem movimento filtrado não entra.
 * - **Saldo inicial**: a soma do razão da linha antes do começo do período (`sqlSaldoAntes`, só pelo índice) — o
 *   `saldoAnterior` recalculado do primeiro movimento da linha na analítica; o final é ele mais `no_periodo`.
 * - **Última compra** (`compras`): o último `RECEB_MANUAL`/`RECEB_NFE` de entrada (não estorno; `movimentoDeCompra`,
 *   F2-B6) do produto × variação no local com a data antes do fim do período, em qualquer tipo de estoque, pelo
 *   `ix_movimentos_estoque_tipo_movimento` (decisão 176: 108 ms numa loja com 4 milhões). Não usa
 *   `saldos_estoque.ultima_compra_em`: ela é a última compra **lançada** (a ordem de lançamento, F2-B6), hoje, não a
 *   última pela data até o fim do período.
 *
 * Com `janela`, o total de linhas e os totais de custo do relatório inteiro vão em cada linha (a página).
 */
export function sqlMovimentacaoSintetica(
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  f: FiltrosMovimentacaoEstoque & FiltrosPreparadosMovimentacao,
  opcoes: { limite?: number; deslocamento?: number; janela?: boolean } = {},
): SQL {
  const { local, periodo, filtro, inicio, fim } = condicoesMovimentacao(sessao, f);
  const nosFiltros = filtro.length ? sql.join(filtro, sql` and `) : sql`true`;
  const custo = verCusto(sessao);
  const pagina =
    opcoes.limite !== undefined ? sql`limit ${opcoes.limite} offset ${opcoes.deslocamento ?? 0}` : sql``;
  const janela = opcoes.janela
    ? sql`, count(*) over () as total_linhas,
          sum(s.custo_entradas) over ()::numeric(15,2)::text as total_custo_entradas,
          sum(s.custo_saidas) over ()::numeric(15,2)::text as total_custo_saidas`
    : sql``;
  return sql`
    with per as materialized (
      select m.produto_id, m.variacao_id, m.tipo_estoque_id,
             sum(m.quantidade) as no_periodo,
             count(*) filter (where ${nosFiltros}) as movimentos,
             coalesce(sum(m.quantidade) filter (where ${nosFiltros} and m.quantidade > 0), 0) as entradas,
             coalesce(-sum(m.quantidade) filter (where ${nosFiltros} and m.quantidade < 0), 0) as saidas,
             coalesce(sum(m.custo_total) filter (where ${nosFiltros} and m.quantidade > 0), 0) as custo_entradas,
             coalesce(sum(m.custo_total) filter (where ${nosFiltros} and m.quantidade < 0), 0) as custo_saidas
        from movimentos_estoque m
       where ${sql.join([...local, ...periodo], sql` and `)}
       group by m.produto_id, m.variacao_id, m.tipo_estoque_id
      having count(*) filter (where ${nosFiltros}) > 0),
    compras as (
      select distinct on (m.produto_id, m.variacao_id) m.produto_id, m.variacao_id, m.data_movimento,
             m.custo_unitario
        from movimentos_estoque m
       where ${sql.join(local, sql` and `)}
         and m.data_movimento < ${fim}
         and m.tipo_movimento in ('RECEB_MANUAL', 'RECEB_NFE') and m.estorno_de_id is null and m.quantidade > 0
       order by m.produto_id, m.variacao_id, m.data_movimento desc, m.id desc),
    s as (
      select s.*, ${sqlSaldoAntes(f.estoqueId, inicio)} as saldo_inicial from per s)
    select s.produto_id, pr.codigo as produto_codigo, pr.codigo_interno, pr.nome as produto_nome,
           s.variacao_id, pv.nome as variacao_nome, s.tipo_estoque_id, te.nome as tipo_estoque_nome,
           u.sigla as unidade_base,
           s.saldo_inicial::numeric(15,3)::text as saldo_inicial,
           s.entradas::numeric(15,3)::text as entradas,
           s.saidas::numeric(15,3)::text as saidas,
           (s.saldo_inicial + s.no_periodo)::numeric(15,3)::text as saldo_final,
           s.movimentos::int as movimentos,
           ${custo ? sql`s.custo_entradas::numeric(15,2)::text` : sql`null::text`} as custo_entradas,
           ${custo ? sql`s.custo_saidas::numeric(15,2)::text` : sql`null::text`} as custo_saidas,
           to_char(c.data_movimento at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ultima_compra_em,
           ${custo ? sql`c.custo_unitario::text` : sql`null::text`} as ultimo_custo
           ${janela}
      from s
      join produtos pr on pr.id = s.produto_id
      join unidades_medida u on u.id = pr.unidade_id
      join tipos_estoque te on te.id = s.tipo_estoque_id
      left join produtos_variacoes pv on pv.id = s.variacao_id
      left join compras c on c.produto_id = s.produto_id
                         and coalesce(c.variacao_id, ${UUID_ZERO}) = coalesce(s.variacao_id, ${UUID_ZERO})
     order by lower(fn_unaccent(pr.nome)), pr.codigo, s.produto_id, pv.nome nulls first, s.variacao_id nulls first,
              te.nome, s.tipo_estoque_id
     ${pagina}`;
}

/** A linha da sintética como o `pg` devolve (numeric em texto). */
export type LinhaBancoSintetica = {
  produto_id: string;
  produto_codigo: number;
  codigo_interno: string | null;
  produto_nome: string;
  variacao_id: string | null;
  variacao_nome: string | null;
  tipo_estoque_id: string;
  tipo_estoque_nome: string;
  unidade_base: string;
  saldo_inicial: string;
  entradas: string;
  saidas: string;
  saldo_final: string;
  movimentos: number;
  custo_entradas: string | null;
  custo_saidas: string | null;
  ultima_compra_em: string | null;
  ultimo_custo: string | null;
  total_linhas?: string;
  total_custo_entradas?: string | null;
  total_custo_saidas?: string | null;
};

export function linhaSintetica(r: LinhaBancoSintetica): LinhaMovimentacaoSintetica {
  return {
    chave: `${r.produto_id}:${r.variacao_id ?? ''}:${r.tipo_estoque_id}`,
    produtoId: r.produto_id,
    produtoCodigo: r.produto_codigo,
    codigoInterno: r.codigo_interno,
    produtoNome: r.produto_nome,
    variacaoId: r.variacao_id,
    variacaoNome: r.variacao_nome,
    tipoEstoqueId: r.tipo_estoque_id,
    tipoEstoqueNome: r.tipo_estoque_nome,
    unidadeBase: r.unidade_base,
    saldoInicial: r.saldo_inicial,
    entradas: r.entradas,
    saidas: r.saidas,
    saldoFinal: r.saldo_final,
    movimentos: r.movimentos,
    custoEntradas: r.custo_entradas,
    custoSaidas: r.custo_saidas,
    ultimaCompraEm: r.ultima_compra_em,
    ultimoCusto: r.ultimo_custo,
  };
}

/**
 * Quantas linhas a exportação vai ter, **só na tabela do razão** (decisão 177: o `count(*)` da consulta embrulhada
 * faria a analítica inteira — as junções, o saldo de cada movimento e a ordenação — só para contar): a analítica conta
 * os movimentos do período nos filtros (o `ix_movimentos_estoque_estoque_data`); a sintética, as linhas de saldo
 * distintas com movimento filtrado no período.
 */
export function sqlContagemMovimentacao(
  sessao: Pick<SessaoErp, 'estoques'>,
  f: FiltrosMovimentacaoEstoque & FiltrosPreparadosMovimentacao,
  visao: VisaoMovimentacao,
): SQL {
  const { local, periodo, filtro } = condicoesMovimentacao(sessao, f);
  const cond = sql.join([...local, ...periodo, ...filtro], sql` and `);
  return visao === 'analitica'
    ? sql`select count(*)::text as n from movimentos_estoque m where ${cond}`
    : sql`select count(*)::text as n from (
            select distinct m.produto_id, m.variacao_id, m.tipo_estoque_id
              from movimentos_estoque m where ${cond}) l`;
}

/**
 * Página da Movimentação sintética (`GET /relatorios/movimentacao-estoque/sintetica`): a página com o total e os
 * totais de custo pela janela, numa transação só de leitura com o JIT desligado (como a analítica); a página além do
 * fim (sem linhas) conta à parte.
 */
export async function paginaMovimentacaoSintetica(
  db: DbEmpresa,
  sessao: Pick<SessaoErp, 'estoques' | 'permissoes'>,
  consulta: ConsultaMovimentacaoSintetica,
): Promise<RespostaMovimentacaoSintetica> {
  const { referencias, ...f } = await prepararFiltrosMovimentacao(db, sessao, consulta);
  const deslocamento = (consulta.pagina - 1) * consulta.tamanho;
  const { rows, total, custoEntradas, custoSaidas } = await db.transaction(
    async (tx) => {
      await tx.execute(sql`set local jit = off`);
      const { rows } = await tx.execute<LinhaBancoSintetica>(
        sqlMovimentacaoSintetica(sessao, f, { limite: consulta.tamanho, deslocamento, janela: true }),
      );
      if (rows.length || deslocamento === 0)
        return {
          rows,
          total: Number(rows[0]?.total_linhas ?? 0),
          custoEntradas: rows[0]?.total_custo_entradas ?? null,
          custoSaidas: rows[0]?.total_custo_saidas ?? null,
        };
      const { rows: t } = await tx.execute<{ n: string; entradas: string | null; saidas: string | null }>(sql`
        select count(*)::text as n, sum(c.custo_entradas::numeric)::numeric(15,2)::text as entradas,
               sum(c.custo_saidas::numeric)::numeric(15,2)::text as saidas
          from (${sqlMovimentacaoSintetica(sessao, f)}) c`);
      return {
        rows,
        total: Number(t[0]?.n ?? 0),
        custoEntradas: t[0]?.entradas ?? null,
        custoSaidas: t[0]?.saidas ?? null,
      };
    },
    { accessMode: 'read only' },
  );
  return {
    itens: rows.map(linhaSintetica),
    total,
    pagina: consulta.pagina,
    tamanho: consulta.tamanho,
    totais: verCusto(sessao)
      ? { custoEntradas: custoEntradas ?? '0.00', custoSaidas: custoSaidas ?? '0.00' }
      : null,
    referencias,
  };
}

// ---------------------------------------------------------------- Exportação (F2-B33)

/** Localização da auditoria da exportação. */
export const LOCALIZACAO_MOVIMENTACAO = 'Relatórios › Movimentação de Estoque';

const numero = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const instante = (v: string | null) => (v === null ? null : new Date(v));

/** As colunas da analítica no arquivo: as da tela, na ordem do export do Nuvem3, com os ids dele no fim. */
function colunasAnalitica(): ColunaExportacao<LinhaBancoMovimentacao>[] {
  return [
    { rotulo: 'Data/hora', valor: (r) => instante(r.data_movimento) },
    { rotulo: 'Ref. Interna', valor: (r) => r.codigo_interno },
    { rotulo: 'Código', valor: (r) => r.produto_codigo },
    { rotulo: 'Produto', valor: (r) => r.produto_nome, largura: 40 },
    { rotulo: 'Variação', valor: (r) => r.variacao_nome },
    { rotulo: 'Tipo de movimento', valor: (r) => r.tipo_movimento_nome, largura: 28 },
    { rotulo: 'Tipo de estoque', valor: (r) => r.tipo_estoque_nome },
    { rotulo: 'Est. anterior', valor: (r) => numero(r.saldo_anterior) },
    { rotulo: 'Qtd. movimentada', valor: (r) => numero(r.quantidade) },
    { rotulo: 'Est. atual', valor: (r) => numero(r.saldo_posterior) },
    { rotulo: 'Unidade', valor: (r) => r.unidade_base },
    { rotulo: 'Unid. do documento', valor: (r) => r.sigla },
    { rotulo: 'Fator', valor: (r) => numero(r.fator) },
    { rotulo: 'Custo unit.', valor: (r) => numero(r.custo_unitario), custo: true },
    { rotulo: 'Custo total', valor: (r) => numero(r.custo_total), custo: true },
    {
      rotulo: 'Documento',
      valor: (r) => ROTULOS_DOCUMENTO_MOVIMENTACAO[r.documento_tipo] ?? r.documento_tipo,
    },
    { rotulo: 'Nº do documento', valor: (r) => r.documento_numero },
    { rotulo: 'Cliente', valor: (r) => r.pessoa_venda, largura: 30 },
    { rotulo: 'Fornecedor', valor: (r) => r.fornecedor, largura: 30 },
    { rotulo: 'Usuário', valor: (r) => r.usuario_nome },
    { rotulo: 'Estoque', valor: (r) => r.estoque_nome, largura: 24 },
    { rotulo: 'Loja', valor: (r) => r.loja_nome, largura: 24 },
    { rotulo: 'Observação', valor: (r) => r.observacao, largura: 40 },
    // Os gravados no lançamento (diferem do recalculado com a venda offline tardia ou a data no passado).
    { rotulo: 'Est. anterior gravado', valor: (r) => numero(r.saldo_anterior_gravado) },
    { rotulo: 'Est. atual gravado', valor: (r) => numero(r.saldo_posterior_gravado) },
    { rotulo: 'idmovimentacaoestoquetipo', valor: (r) => r.id_nuvem3 },
    { rotulo: 'idmovimentacaoestoque', valor: (r) => r.id, largura: 38 },
    {
      rotulo: 'idvenda',
      valor: (r) => (r.documento_tipo === 'venda' ? r.documento_id : null),
      largura: 38,
    },
  ];
}

function colunasSintetica(): ColunaExportacao<LinhaBancoSintetica>[] {
  return [
    { rotulo: 'Ref. Interna', valor: (r) => r.codigo_interno },
    { rotulo: 'Código', valor: (r) => r.produto_codigo },
    { rotulo: 'Produto', valor: (r) => r.produto_nome, largura: 40 },
    { rotulo: 'Variação', valor: (r) => r.variacao_nome },
    { rotulo: 'Tipo de estoque', valor: (r) => r.tipo_estoque_nome },
    { rotulo: 'Unidade', valor: (r) => r.unidade_base },
    { rotulo: 'Saldo inicial', valor: (r) => numero(r.saldo_inicial) },
    { rotulo: 'Entradas', valor: (r) => numero(r.entradas) },
    { rotulo: 'Saídas', valor: (r) => numero(r.saidas) },
    { rotulo: 'Saldo final', valor: (r) => numero(r.saldo_final) },
    { rotulo: 'Movimentos', valor: (r) => r.movimentos },
    { rotulo: 'Custo das entradas', valor: (r) => numero(r.custo_entradas), custo: true },
    { rotulo: 'Custo das saídas', valor: (r) => numero(r.custo_saidas), custo: true },
    { rotulo: 'Data da última compra', valor: (r) => instante(r.ultima_compra_em) },
    { rotulo: 'Último custo', valor: (r) => numero(r.ultimo_custo), custo: true },
  ];
}

type FiltrosProvedorMovimentacao = FiltrosExportacaoMovimentacao & FiltrosPreparadosMovimentacao;

/**
 * Provedor da exportação (`GET /relatorios/movimentacao-estoque/exportar?visao=analitica|sintetica`, F2-B29;
 * decisões 177 e 180): `Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM.xlsx` com as colunas da visão escolhida e a
 * mesma consulta da tela sem a página (a analítica inteira na ordem `(data_movimento, id)`, lida pelo cursor do
 * servidor no `ix_movimentos_estoque_estoque_data`), com a sessão do momento na execução da tarefa (o local fora dos
 * permitidos agora é 403 de novo no `preparar`, e o custo é decidido aí). A contagem é a própria
 * (`sqlContagemMovimentacao`), só no razão.
 */
export function provedorMovimentacao(): ProvedorRelatorio<
  FiltrosProvedorMovimentacao,
  LinhaBancoMovimentacao | LinhaBancoSintetica,
  FiltrosExportacaoMovimentacao
> {
  return {
    chave: RELATORIO_MOVIMENTACAO_ESTOQUE,
    nomeArquivo: 'Relatorio_Movimentacao_Estoque',
    permissao: 'relatorios.movimentacao_estoque',
    entidade: 'movimentos_estoque',
    localizacao: LOCALIZACAO_MOVIMENTACAO,
    filtros: exportacaoMovimentacaoEstoqueSchema,
    colunas: (_sessao, f) =>
      (f.visao === 'sintetica' ? colunasSintetica() : colunasAnalitica()) as ColunaExportacao<
        LinhaBancoMovimentacao | LinhaBancoSintetica
      >[],
    preparar: async (db, sessao, f) => {
      const { referencias: _referencias, ...preparados } = await prepararFiltrosMovimentacao(db, sessao, f);
      return preparados;
    },
    consulta: (sessao, f) =>
      f.visao === 'sintetica' ? sqlMovimentacaoSintetica(sessao, f) : sqlMovimentacaoAnalitica(sessao, f),
    semJit: true,
    contar: async (db, sessao, f) => {
      const { rows } = await db.execute<{ n: string }>(sqlContagemMovimentacao(sessao, f, f.visao));
      return Number(rows[0]?.n ?? 0);
    },
  };
}
