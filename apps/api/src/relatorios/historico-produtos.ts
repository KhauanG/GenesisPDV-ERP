/**
 * Relatório **Histórico de produtos** (ERP 16.2; Fase 2, F2-B42; README da API › decisão 188): quem mudou o quê no
 * cadastro do produto, sobre a auditoria (ERP 17; MD 3.1.7), com o texto legível das diferenças ("Preço de venda: 9,90
 * → 10,90; EAN adicionado 7891234567895"), a legenda G/E/R/I e a localização mapeada ("Cad. prod.", "Cadastro em
 * massa", "Importação", "Recebimento", "NF-e", "API", "PDV").
 *
 * - **Só o produto e as filhas**: `entidade` em `ENTIDADES_HISTORICO_PRODUTOS` (hoje as filhas vão no `antes`/`depois`
 *   do próprio produto; as sub-tabelas ficam na lista para quando tiverem linha própria) e as ações de cadastro
 *   (`criar`, `editar`, `excluir`, `restaurar`, `importar`). A exportação do catálogo (`exportar`) não entra, nem o
 *   aviso de cadastro do caixa (`criar` com a localização `LOCALIZACAO_ALERTA_CADASTRO_PDV`: não muda o cadastro).
 * - **Período obrigatório**: a tabela é particionada por mês em `ocorrido_em`. Os limites (dias de calendário no fuso da
 *   empresa) entram como parâmetros, com o fuso lido antes (`fusoDaEmpresa` numa ida própria): o planejador descarta as
 *   partições fora do período (o teste confere com `EXPLAIN`). Com o produto, o `ix_auditoria_entidade_registro_id`.
 * - **Texto** ("Histórico"): o contido em `descricao` (sem acento nem caixa), o texto gravado pela gravação do produto
 *   (`descricaoGravacaoProduto`, sem os valores de custo nem o que é de loja). As linhas de antes do F2-B42 não têm
 *   esse texto (só o filtro de texto deixa de achá-las). A busca é no escopo de quem consulta (`textoPesquisavel`):
 *   sem `produtos.ver_custo`, sem os rótulos de custo; com lojas ou estoques restritos, sem o "Dados de loja
 *   alterados" — senão o filtro diria quais linhas mexeram no que a permissão esconde.
 * - **O que se mostra é montado para quem consulta** (`escopoDaSessao`): o `antes`/`depois` passa por
 *   `redigirParaVisao` (custo sem `produtos.ver_custo`, lojas fora das permitidas) e a diferença, pelo escopo (o
 *   custo, as lojas e os estoques permitidos) — no texto da linha e no "ver diferença completa". As linhas com loja
 *   (`auditoria.loja_id`) fora das permitidas não aparecem (a do produto é da empresa, sem loja).
 * - **Exportação** (Excel/CSV, ERP 3.5; `provedorHistoricoProdutos`): os mesmos filtros e as colunas da tela, com o
 *   texto montado para quem exporta lote a lote (`converterLote`: os nomes numa ida por cadastro por lote).
 */
import {
  consultaHistoricoProdutosSchema,
  RELATORIO_HISTORICO_PRODUTOS,
  type AlteracaoHistoricoProduto,
  type ConsultaHistoricoProdutos,
  type DetalheHistoricoProduto,
  type LinhaHistoricoProduto,
  type RespostaHistoricoProdutos,
  type TipoHistoricoProduto,
  limiteDeslocamento,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import {
  alteracoesDiferencas,
  carregarNomes,
  diferencasProduto,
  escopoDaSessao,
  referenciasDiferencas,
  referenciasVazias,
  RESUMO_LOJA,
  textoDiferencas,
  TRECHO_CUSTO_GRAVADO,
  type EscopoDiferenca,
  type ItemDiferenca,
  type Nomes,
} from '../auditoria/diferenca-produto.js';
import { redigirParaVisao } from '../auditoria/mascarar.js';
import { escaparLike } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import { fusoDaEmpresa } from '../comum/fuso.js';
import { LOCALIZACAO_ALERTA_CADASTRO_PDV } from '../sync/handlers/alertas.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Localização da auditoria da exportação. */
export const LOCALIZACAO_HISTORICO_PRODUTOS = 'Relatórios › Histórico de produtos';

/** As entidades do produto e das filhas (ERP 16.2: "`produtos` e sub-tabelas, preços, códigos de barras"). */
export const ENTIDADES_HISTORICO_PRODUTOS = [
  'produtos',
  'produtos_codigos_barras',
  'produtos_lojas',
  'produtos_precos_quantidade',
  'produtos_componentes',
  'produtos_categorias',
  'produtos_relacionados',
  'produtos_fornecedores',
  'produtos_lotes',
  'produtos_variacoes',
] as const;

/** As ações de cadastro (a legenda G/E/R/I). */
export const ACOES_HISTORICO_PRODUTOS = ['criar', 'editar', 'excluir', 'restaurar', 'importar'] as const;

/** O tipo da legenda pela ação e pela origem: a gravação vinda da planilha (origem `importacao`) é "I". */
const sqlTipo = sql`(case when a.origem = 'importacao' or a.acao = 'importar' then 'I'
                          when a.acao = 'excluir' then 'E'
                          when a.acao = 'restaurar' then 'R'
                          else 'G' end)`;

/** A localização gravada → a da coluna (ERP 16.2). */
const LOCALIZACOES: Record<string, string> = {
  'Produtos › Cadastro de produtos': 'Cad. prod.',
  'Produtos › Cadastro em massa': 'Cadastro em massa',
  'Produtos › Importação': 'Importação',
  'Estoque › Recebimentos': 'Recebimento',
  'Estoque › Recebimento de NFe': 'NF-e',
  'Relatórios › NCMs inválidos': 'NCMs inválidos',
};
const POR_ORIGEM: Record<string, string> = {
  api: 'API',
  pdv: 'PDV',
  importacao: 'Importação',
  integracao: 'Integração',
  sistema: 'Sistema',
  suporte: 'Suporte',
};

/**
 * A localização da coluna: a origem que não é o ERP vence (a chamada pela API ao `PUT /produtos` grava a localização
 * do formulário); depois a tela gravada; senão a gravada como veio.
 */
export function localizacaoHistorico(origem: string, localizacao: string | null): string {
  if (origem !== 'erp' && POR_ORIGEM[origem]) return POR_ORIGEM[origem];
  if (localizacao && LOCALIZACOES[localizacao]) return LOCALIZACOES[localizacao];
  return localizacao ?? 'ERP';
}

/** Fuso e filtros prontos para a consulta. */
type Filtros = Pick<
  ConsultaHistoricoProdutos,
  'dataInicial' | 'dataFinal' | 'texto' | 'usuarioId' | 'tipo' | 'produtoId'
> & {
  fuso: string;
};

/** Quem consulta, para o `where`: as lojas e os estoques permitidos e o custo (`produtos.ver_custo`). */
export type VisaoHistorico = Pick<SessaoErp, 'lojas' | 'estoques'> & {
  permissoes: { has(p: string): boolean };
};

/**
 * A condição comum da página e do detalhe (alias `a`): as entidades do produto, as ações de cadastro, fora o aviso de
 * cadastro do caixa (a auditoria `criar` do `alerta.cadastro`, que não muda nada no produto), e só as linhas sem loja
 * ou das lojas permitidas da sessão. Um filtro novo de visão entra aqui, para valer nas duas.
 */
function condicaoBase(sessao: Pick<SessaoErp, 'lojas'>): SQL {
  const c: SQL[] = [
    sql`a.entidade = any(${`{${ENTIDADES_HISTORICO_PRODUTOS.join(',')}}`}::text[])`,
    sql`a.acao = any(${`{${ACOES_HISTORICO_PRODUTOS.join(',')}}`}::text[])`,
    sql`(a.origem <> 'pdv' or a.localizacao is distinct from ${LOCALIZACAO_ALERTA_CADASTRO_PDV})`,
  ];
  if (sessao.lojas !== null)
    c.push(sql`(a.loja_id is null or a.loja_id = any(${`{${sessao.lojas.join(',')}}`}::uuid[]))`);
  return sql.join(c, sql` and `);
}

/**
 * Onde o filtro "Histórico" procura: a `descricao` gravada (`ESCOPO_GRAVADO`) sem o que quem consulta não vê — sem
 * `produtos.ver_custo`, os rótulos de custo ("Preço de custo: (alterado)", `TRECHO_CUSTO_GRAVADO`); com lojas ou
 * estoques restritos, o aviso "Dados de loja alterados" (que pode ser de uma loja de fora). Sem isso, procurar "custo"
 * ou "dados de loja" diria quais linhas mexeram no que a permissão esconde, mesmo com o texto da linha sem citá-lo.
 */
function textoPesquisavel(sessao: VisaoHistorico): SQL {
  let t = sql`a.descricao`;
  if (!sessao.permissoes.has('produtos.ver_custo'))
    t = sql`regexp_replace(${t}, ${TRECHO_CUSTO_GRAVADO}::text, '', 'gi')`;
  if (sessao.lojas !== null || sessao.estoques !== null) t = sql`replace(${t}, ${RESUMO_LOJA}::text, '')`;
  return t;
}

/** As condições da página (alias `a`): o período em parâmetros (a poda das partições), a base e os filtros. */
function condicoes(sessao: VisaoHistorico, f: Filtros): SQL {
  const c: SQL[] = [
    sql`a.ocorrido_em >= (${f.dataInicial}::date::timestamp at time zone ${f.fuso}::text)`,
    sql`a.ocorrido_em < ((${f.dataFinal}::date + 1)::timestamp at time zone ${f.fuso}::text)`,
    condicaoBase(sessao),
  ];
  if (f.produtoId) c.push(sql`a.registro_id = ${f.produtoId}::uuid`);
  if (f.usuarioId) c.push(sql`a.usuario_id = ${f.usuarioId}::uuid`);
  if (f.tipo) c.push(sql`${sqlTipo} = ${f.tipo}`);
  if (f.texto)
    c.push(sql`fn_unaccent(${textoPesquisavel(sessao)}) ilike fn_unaccent(${`%${escaparLike(f.texto)}%`})`);
  return sql.join(c, sql` and `);
}

interface LinhaBanco extends Record<string, unknown> {
  id: string;
  ocorrido_em: Date | string;
  origem: string;
  usuario_id: string | null;
  usuario_nome: string | null;
  acao: string;
  tipo: TipoHistoricoProduto;
  localizacao: string | null;
  descricao: string | null;
  antes: unknown;
  depois: unknown;
  registro_id: string | null;
  produto_codigo: number | null;
  produto_nome: string | null;
  produto_excluido: boolean | null;
}

/** As colunas de `LinhaBanco` e o `from`, iguais na página, na exportação e no detalhe. */
const sqlLinhas = sql`
    select a.id, a.ocorrido_em, a.origem, a.usuario_id, a.usuario_nome, a.acao, ${sqlTipo} as tipo, a.localizacao,
           a.descricao, a.antes, a.depois, a.registro_id,
           p.codigo as produto_codigo, p.nome as produto_nome, p.excluido_em is not null as produto_excluido
      from auditoria a
      left join produtos p on p.id = a.registro_id and a.entidade = 'produtos'`;

/**
 * As linhas do relatório, a mais recente primeiro; com `pagina`, só ela (exportada para o `EXPLAIN` do teste; sem
 * ela, a consulta inteira da exportação).
 */
export function sqlHistoricoProdutos(
  sessao: VisaoHistorico,
  f: Filtros,
  pagina?: { limite: number; deslocamento: number },
): SQL {
  return sql`${sqlLinhas}
     where ${condicoes(sessao, f)}
     order by a.ocorrido_em desc, a.id desc${pagina ? sql` limit ${pagina.limite} offset ${pagina.deslocamento}` : sql``}`;
}

/** O total com o mesmo `where`. */
async function contarHistorico(db: DbEmpresa, sessao: VisaoHistorico, f: Filtros): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from auditoria a where ${condicoes(sessao, f)}`,
  );
  return rows[0]?.n ?? 0;
}

/** O fuso da empresa (uma ida só: os limites do período vão como parâmetros, para a poda das partições). */
async function fuso(db: DbEmpresa): Promise<string> {
  const { rows } = await db.execute<{ fuso: string }>(sql`select ${fusoDaEmpresa} as fuso`);
  return rows[0]!.fuso;
}

/** A linha preparada: a diferença já no escopo de quem lê (`antes`/`depois` redigidos). */
interface Preparada {
  linha: LinhaBanco;
  itens: ItemDiferenca[];
  antes: unknown;
  depois: unknown;
}

function preparar(l: LinhaBanco, sessao: SessaoErp): Preparada {
  const visao = {
    verRh: false,
    verCusto: sessao.permissoes.has('produtos.ver_custo'),
    lojas: sessao.lojas,
  };
  const antes = redigirParaVisao(l.antes, visao);
  const depois = redigirParaVisao(l.depois, visao);
  // A exclusão compara o que existia com nada: a tabela mostra o cadastro excluído (ver `alteracoesDaLinha`).
  const itens =
    l.acao === 'criar' || l.acao === 'editar' || l.acao === 'importar'
      ? diferencasProduto(antes, depois)
      : [];
  return { linha: l, itens, antes, depois };
}

/**
 * A linha só com uma filha (a relação inversa criada por outro produto, o vínculo de fornecedor movido por outro
 * produto ou pela NF-e): a descrição gravada conta de onde veio, e vale mais que a diferença da lista.
 */
const parcial = (p: Preparada) =>
  p.linha.descricao !== null &&
  !(p.depois !== null && typeof p.depois === 'object' && 'nome' in (p.depois as object));

function historicoDaLinha(p: Preparada, nomes: Nomes, e: EscopoDiferenca): string {
  const { linha: l } = p;
  if (l.acao === 'excluir') return l.descricao ?? 'Produto excluído';
  if (l.acao === 'restaurar') return l.descricao ?? 'Produto restaurado';
  if (parcial(p)) return l.descricao!;
  if (!p.itens.length) return l.acao === 'criar' ? 'Produto criado' : 'Gravado sem alteração';
  return textoDiferencas(p.itens, nomes, e) || 'Sem alteração nos campos que você pode ver';
}

function linhaDe(p: Preparada, nomes: Nomes, e: EscopoDiferenca): LinhaHistoricoProduto {
  const { linha: l } = p;
  return {
    id: l.id,
    ocorridoEm: new Date(l.ocorrido_em).toISOString(),
    usuarioId: l.usuario_id,
    usuarioNome: l.usuario_nome,
    tipo: l.tipo,
    acao: l.acao,
    localizacao: localizacaoHistorico(l.origem, l.localizacao),
    produto:
      l.registro_id && l.produto_codigo !== null
        ? {
            id: l.registro_id,
            codigo: Number(l.produto_codigo),
            nome: l.produto_nome!,
            excluido: l.produto_excluido === true,
          }
        : null,
    historico: historicoDaLinha(p, nomes, e),
  };
}

/** Os nomes citados pelas linhas (no escopo de quem lê), numa ida por cadastro para a página inteira. */
async function nomesDas(db: DbEmpresa, ps: readonly Preparada[], e: EscopoDiferenca, comExclusao = false) {
  const refs = referenciasVazias();
  for (const p of ps) {
    referenciasDiferencas(p.itens, e, refs);
    if (comExclusao && p.linha.acao === 'excluir')
      referenciasDiferencas(diferencasProduto(null, p.antes), e, refs);
  }
  return carregarNomes(db, refs);
}

/** `GET /relatorios/historico-produtos`: a página, a mais recente primeiro, com o total. */
export async function paginaHistoricoProdutos(
  db: DbEmpresa,
  sessao: SessaoErp,
  q: ConsultaHistoricoProdutos,
): Promise<RespostaHistoricoProdutos> {
  const f: Filtros = { ...q, fuso: await fuso(db) };
  const { rows } = await db.execute<LinhaBanco>(sqlHistoricoProdutos(sessao, f, limiteDeslocamento(q)));
  return {
    itens: await linhasProntas(db, sessao, rows),
    total: await contarHistorico(db, sessao, f),
    pagina: q.pagina,
    tamanho: q.tamanho,
  };
}

/** As linhas do banco com o texto montado para quem consulta (os nomes numa ida por cadastro para o lote todo). */
async function linhasProntas(
  db: DbEmpresa,
  sessao: SessaoErp,
  rows: readonly LinhaBanco[],
): Promise<LinhaHistoricoProduto[]> {
  const e = escopoDaSessao(sessao);
  const ps = rows.map((l) => preparar(l, sessao));
  const nomes = await nomesDas(db, ps, e);
  return ps.map((p) => linhaDe(p, nomes, e));
}

/** A tabela da linha: a diferença; na exclusão, o cadastro que existia (como na criação, com "antes" e "depois" trocados). */
function alteracoesDaLinha(p: Preparada, nomes: Nomes, e: EscopoDiferenca): AlteracaoHistoricoProduto[] {
  if (p.linha.acao === 'excluir')
    return alteracoesDiferencas(diferencasProduto(null, p.antes), nomes, e).map((x) => ({
      campo: x.campo,
      antes: /^Adicionad[oa]$/.test(x.depois) ? 'Existia' : x.depois,
      depois: '—',
    }));
  return alteracoesDiferencas(p.itens, nomes, e);
}

/**
 * `GET /relatorios/historico-produtos/:id?ocorridoEm=`: o "ver diferença completa" de uma linha. O instante escolhe a
 * partição (uma janela de 1 ms em volta: o `ocorridoEm` da página vem em milissegundos e o banco guarda
 * microssegundos); a linha tem de ser do produto e da visão de quem consulta, senão 404.
 */
export async function detalheHistoricoProduto(
  db: DbEmpresa,
  sessao: SessaoErp,
  id: string,
  ocorridoEm: string,
): Promise<DetalheHistoricoProduto> {
  const { rows } = await db.execute<LinhaBanco>(sql`${sqlLinhas}
     where a.id = ${id}::uuid
       and a.ocorrido_em >= ${ocorridoEm}::timestamptz - interval '1 millisecond'
       and a.ocorrido_em < ${ocorridoEm}::timestamptz + interval '1 millisecond'
       and ${condicaoBase(sessao)}`);
  const l = rows[0];
  if (!l) throw ErroApi.naoEncontrado('Linha do histórico não encontrada.');
  const e = escopoDaSessao(sessao);
  const p = preparar(l, sessao);
  const nomes = await nomesDas(db, [p], e, true);
  return { ...linhaDe(p, nomes, e), alteracoes: alteracoesDaLinha(p, nomes, e) };
}

// ---------------------------------------------------------------- Exportação (ERP 3.5)

/** O nome do produto da coluna (o código vai na coluna dele), com o excluído marcado. */
const produtoDaLinha = (l: LinhaHistoricoProduto) =>
  l.produto ? `${l.produto.nome}${l.produto.excluido ? ' (excluído)' : ''}` : null;

/**
 * Excel/CSV pela API (`GET /relatorios/historico-produtos/exportar`), com os filtros da tela (a página é ignorada) e as
 * colunas dela. O texto do Histórico é montado no escopo de quem exporta, como na tela, lote a lote no cursor
 * (`converterLote`), com lotes menores que o padrão: cada linha traz o `antes`/`depois` inteiros do produto.
 */
export function provedorHistoricoProdutos(): ProvedorRelatorio<
  Filtros,
  LinhaHistoricoProduto,
  ConsultaHistoricoProdutos
> {
  return {
    chave: RELATORIO_HISTORICO_PRODUTOS,
    nomeArquivo: 'Relatorio_Historico_Produtos',
    permissao: 'relatorios.historico_produtos',
    entidade: 'auditoria',
    localizacao: LOCALIZACAO_HISTORICO_PRODUTOS,
    filtros: consultaHistoricoProdutosSchema,
    linhasPorLote: 1_000,
    preparar: async (db, _sessao, q) => ({
      dataInicial: q.dataInicial,
      dataFinal: q.dataFinal,
      texto: q.texto,
      usuarioId: q.usuarioId,
      tipo: q.tipo,
      produtoId: q.produtoId,
      fuso: await fuso(db),
    }),
    colunas: () => {
      const colunas: ColunaExportacao<LinhaHistoricoProduto>[] = [
        { rotulo: 'Usuário', valor: (l) => l.usuarioNome, largura: 24 },
        { rotulo: 'Tipo', valor: (l) => l.tipo },
        { rotulo: 'Localização', valor: (l) => l.localizacao, largura: 18 },
        { rotulo: 'Data/hora', valor: (l) => new Date(l.ocorridoEm) },
        { rotulo: 'Código', valor: (l) => l.produto?.codigo ?? null },
        { rotulo: 'Produto', valor: produtoDaLinha, largura: 40 },
        { rotulo: 'Histórico', valor: (l) => l.historico, largura: 60 },
      ];
      return colunas;
    },
    consulta: (sessao, f) => sqlHistoricoProdutos(sessao, f),
    contar: (db, sessao, f) => contarHistorico(db, sessao, f),
    converterLote: (db, sessao, _f, lote) => linhasProntas(db, sessao, lote as LinhaBanco[]),
  };
}
