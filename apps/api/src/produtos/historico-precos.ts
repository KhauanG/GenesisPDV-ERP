/**
 * Consulta do histórico de preços de um produto (Fase 2, F2-B37; MD 3.6.10; ERP 8.2 "Alteração de preço"; README da
 * API › decisão 183): `GET /produtos/:id/historico-precos`, a página das mudanças de preço e de custo com a origem
 * (cadastro, importação, cadastro em massa, recebimento, NF-e, API), o documento, a loja, a variação e a faixa.
 *
 * O histórico **não é redigido na leitura** (decisão 100 vale para a auditoria): o corte é na consulta. Sem
 * `produtos.ver_custo` os tipos de custo (`TIPOS_PRECO_HISTORICO_CUSTO`) ficam fora do `where` (e o filtro "Custo"
 * recusa com 403); a linha de uma loja fora das permitidas também (a linha sem loja — o preço geral, o custo, a faixa
 * de todas as lojas — é de todos), e o filtro de uma loja fora delas recusa com 403.
 */
import {
  LOJA_HISTORICO_GERAL,
  TIPOS_PRECO_HISTORICO_CUSTO,
  type HistoricoPrecoProduto,
  type HistoricoPrecosQuery,
  type OrigemHistoricoPreco,
  type Pagina,
  type TipoPrecoHistorico,
  limiteDeslocamento,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { inicioDoDiaNaEmpresa } from '../comum/fuso.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const verCusto = (s: Pick<SessaoErp, 'permissoes'>) => s.permissoes.has('produtos.ver_custo');

/** As condições do `where` (alias `h`), com o corte do custo e das lojas da sessão. */
function condicoes(
  produtoId: string,
  q: HistoricoPrecosQuery,
  sessao: Pick<SessaoErp, 'permissoes' | 'lojas'>,
): SQL[] {
  const c: SQL[] = [sql`h.produto_id = ${produtoId}`];
  if (!verCusto(sessao))
    c.push(sql`h.tipo_preco <> all(${`{${TIPOS_PRECO_HISTORICO_CUSTO.join(',')}}`}::text[])`);
  if (sessao.lojas !== null)
    c.push(sql`(h.loja_id is null or h.loja_id = any(${`{${sessao.lojas.join(',')}}`}::uuid[]))`);
  if (q.tipo) c.push(sql`h.tipo_preco = ${q.tipo}`);
  if (q.loja === LOJA_HISTORICO_GERAL) c.push(sql`h.loja_id is null`);
  else if (q.loja) c.push(sql`h.loja_id = ${q.loja}::uuid`);
  // Dias de calendário no fuso da empresa (a sessão do Postgres é UTC; `inicioDoDiaNaEmpresa`, a regra de todos os
  // filtros de período): da meia-noite do inicial à do dia seguinte ao final, pelo
  // `ix_produtos_historico_precos_produto_id_criado_em`.
  if (q.dataInicial) c.push(sql`h.criado_em >= ${inicioDoDiaNaEmpresa(sql`${q.dataInicial}::date`)}`);
  if (q.dataFinal) c.push(sql`h.criado_em < ${inicioDoDiaNaEmpresa(sql`(${q.dataFinal}::date + 1)`)}`);
  return c;
}

/**
 * Página do histórico de um produto não excluído (404 senão), a mudança mais recente primeiro (`criado_em`, e o `id`
 * para desempatar as linhas do mesmo "Gravar"), com o total. O intervalo da faixa vem da própria faixa
 * (`origem_id` da linha `quantidade`, `linhasHistoricoFilhos`), e o documento pelo `origem_id` do recebimento (o
 * código) ou da NF-e (o número).
 */
export async function paginaHistoricoPrecos(
  db: DbEmpresa,
  sessao: SessaoErp,
  produtoId: string,
  q: HistoricoPrecosQuery,
): Promise<Pagina<HistoricoPrecoProduto>> {
  if (q.tipo && TIPOS_PRECO_HISTORICO_CUSTO.includes(q.tipo) && !verCusto(sessao))
    throw ErroApi.semPermissao('O histórico do custo exige "Produtos: Ver custo".');
  if (q.loja && q.loja !== LOJA_HISTORICO_GERAL) garantirLoja(sessao, q.loja);
  const { rows: existe } = await db.execute(
    sql`select 1 from produtos where id = ${produtoId} and excluido_em is null`,
  );
  if (!existe.length) throw ErroApi.naoEncontrado('Produto não encontrado.');
  const onde = sql.join(condicoes(produtoId, q, sessao), sql` and `);
  const { limite, deslocamento } = limiteDeslocamento(q);
  const { rows } = await db.execute<{
    id: string;
    criado_em: Date | string;
    tipo_preco: TipoPrecoHistorico;
    variacao_id: string | null;
    variacao_nome: string | null;
    loja_id: string | null;
    loja_nome: string | null;
    quantidade_inicial: string | null;
    quantidade_final: string | null;
    valor_anterior: string | null;
    valor_novo: string | null;
    origem: OrigemHistoricoPreco;
    origem_id: string | null;
    documento_numero: string | null;
    usuario_nome: string | null;
  }>(sql`
    select h.id, h.criado_em, h.tipo_preco, h.variacao_id, v.nome as variacao_nome, h.loja_id, l.nome as loja_nome,
           f.quantidade_inicial::text as quantidade_inicial, f.quantidade_final::text as quantidade_final,
           h.valor_anterior::text as valor_anterior, h.valor_novo::text as valor_novo, h.origem, h.origem_id,
           case h.origem
             when 'recebimento' then (select r.codigo::text from recebimentos r where r.id = h.origem_id)
             when 'nota_entrada' then (select n.numero::text from notas_entrada n where n.id = h.origem_id)
           end as documento_numero,
           u.nome as usuario_nome
      from produtos_historico_precos h
      left join produtos_variacoes v on v.id = h.variacao_id
      left join lojas l on l.id = h.loja_id
      left join produtos_precos_quantidade f on h.tipo_preco = 'quantidade' and f.id = h.origem_id
      left join usuarios u on u.id = h.usuario_id
     where ${onde}
     order by h.criado_em desc, h.id desc
     limit ${limite} offset ${deslocamento}`);
  const { rows: contagem } = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from produtos_historico_precos h where ${onde}`,
  );
  return {
    itens: rows.map((r) => ({
      id: r.id,
      criadoEm: new Date(r.criado_em).toISOString(),
      tipoPreco: r.tipo_preco,
      variacaoId: r.variacao_id,
      variacaoNome: r.variacao_nome,
      lojaId: r.loja_id,
      lojaNome: r.loja_nome,
      quantidadeInicial: r.quantidade_inicial,
      quantidadeFinal: r.quantidade_final,
      valorAnterior: r.valor_anterior,
      valorNovo: r.valor_novo,
      origem: r.origem,
      documento:
        r.origem_id && r.documento_numero !== null ? { id: r.origem_id, numero: r.documento_numero } : null,
      usuarioNome: r.usuario_nome,
    })),
    total: contagem[0]?.n ?? 0,
    pagina: q.pagina,
    tamanho: q.tamanho,
  };
}
