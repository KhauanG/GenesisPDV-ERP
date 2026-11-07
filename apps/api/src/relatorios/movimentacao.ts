/**
 * Relatório **Movimentação de Estoque**, visão analítica (ERP 16.5; Fase 2, F2-B32; README da API › decisão 179): um
 * movimento do razão por linha, de um local de estoque num período (até 366 dias), com os filtros de produto, tipos de
 * movimento, usuário, documento e pessoa, nas colunas do export do Nuvem3 (MD 3.7.2) mais o custo gravado (só com
 * `produtos.ver_custo`), o documento com o número, o fornecedor do recebimento e a unidade base com o fator (a
 * quantidade está na unidade do produto; `sigla` é a do documento, como no Nuvem3). A sintética e a exportação são do
 * F2-B33.
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
 * no Estoque Atual, decisão 178) e o filtro dos estoques permitidos da sessão, para virar o provedor da exportação do
 * F2-B33 sem mudar (lá sem o limite; a soma por partes também serve à leitura inteira).
 */
import {
  type ConsultaMovimentacaoEstoque,
  type DocumentoMovimentacao,
  type FiltrosMovimentacaoEstoque,
  type LinhaMovimentacaoEstoque,
  type RespostaMovimentacaoEstoque,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { fusoDaEmpresa } from '../comum/fuso.js';
import { estoquePermitido, estoqueVisivel } from '../estoques/permitidos.js';
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
 */
function sqlParteAnterior(): SQL {
  const parte = (variacao: 'nula' | 'igual') => sql`(
    select sum(x.quantidade) from movimentos_estoque x
     where x.estoque_id = p.estoque_id and x.produto_id = p.produto_id
       and x.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : '= p.variacao_id')}
       and p.variacao_id ${sql.raw(variacao === 'nula' ? 'is null' : 'is not null')}
       and x.tipo_estoque_id = p.tipo_estoque_id
       and (x.data_movimento, x.id) < (p.data_movimento, p.id)
       and (x.data_movimento, x.id) > (coalesce(p.ant_data, '-infinity'::timestamptz),
                                      coalesce(p.ant_id, '00000000-0000-0000-0000-000000000000'::uuid)))`;
  return sql`coalesce(${parte('nula')}, ${parte('igual')}, 0)`;
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
  // O período em dias de calendário no fuso da empresa: do começo do dia inicial ao começo do dia seguinte ao final.
  const inicio = sql`(${f.dataInicial}::date::timestamp at time zone ${f.fuso}::text)`;
  const fim = sql`((${f.dataFinal}::date + 1)::timestamp at time zone ${f.fuso}::text)`;
  const cond: SQL[] = [
    sql`m.estoque_id = ${f.estoqueId}`,
    sql`m.data_movimento >= ${inicio}`,
    sql`m.data_movimento < ${fim}`,
  ];
  const visivel = estoqueVisivel(sessao, sql`m.estoque_id`);
  if (visivel) cond.push(visivel);
  if (f.produtoId) cond.push(sql`m.produto_id = ${f.produtoId}`);
  if (f.tiposMovimento?.length)
    cond.push(
      sql`m.tipo_movimento in (${sql.join(
        f.tiposMovimento.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
  if (f.usuarioId) cond.push(sql`m.usuario_id = ${f.usuarioId}`);
  if (f.pessoaId) cond.push(sql`m.pessoa_id = ${f.pessoaId}`);
  if (f.documentoTipo) {
    cond.push(sql`m.documento_tipo = ${f.documentoTipo}`);
    const d = NUMERO_DOCUMENTO[f.documentoTipo];
    if (f.documentoNumero && d) {
      // O número que não é um inteiro não acha documento de código numérico (sem erro de conversão no banco).
      const numero = d.texto
        ? f.documentoNumero
        : /^\d{1,9}$/.test(f.documentoNumero)
          ? f.documentoNumero
          : null;
      cond.push(
        numero === null
          ? sql`false`
          : sql`m.documento_id in (select d.id from ${sql.raw(d.tabela)} d where d.${sql.raw(d.coluna)} = ${
              d.texto ? sql`${numero}` : sql`${numero}::int`
            })`,
      );
    }
  }
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
      select p.*, ${sqlParteAnterior()} as parte from p),
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
 * Os filtros prontos para a consulta (a tela e, no F2-B33, o `preparar` da exportação), numa ida ao banco: o fuso da
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
