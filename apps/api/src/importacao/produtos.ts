/**
 * Importação de produtos (ERP 8.6): análise linha a linha (prévia e tarefa usam a mesma conta) e a gravação pela mesma
 * regra do formulário (`inserirProduto`/`atualizarProduto`). Identificação do existente: `id` → `codigo` (o Id Produto,
 * inclusive o `IdProduto` do Nuvem3) → `codigo_interno` → `ean`. Produto existente: a prévia calcula o que muda campo a
 * campo (`alteracoes`) e só isso é gravado; sem diferença a linha fica `sem_alteracao` (decisão 103). Inconsistências
 * que não impedem a linha (EAN duplicado/inválido, NCM inválido, marca/categoria inexistente, código a conferir,
 * estoque negativo) entram no relatório; sem preço, unidade inexistente e valores inválidos impedem.
 */
import {
  criarProdutoSchema,
  dec,
  lerBalancaPlanilha,
  lerBooleanoPlanilha,
  lerCodigoPlanilha,
  lerDecimalPlanilha,
  lerComposicao,
  lerExcluirPlanilha,
  lerListaCategorias,
  lerNcmPlanilha,
  lerNumeroPlanilha,
  mesmoDecimal,
  motivoTipoProdutoBloqueado,
  nomesParecidos,
  precoCampo,
  resolverUnidadePlanilha,
  ROTULOS_TIPO_PRODUTO,
  TIPOS_PRODUTO,
  validarGtin,
  type AlteracaoImportacao,
  MAPEAMENTO_PROVISORIO_NUVEM3,
  type CriarProdutoEntrada,
  type ItemComposicao,
  type LinhaPreviaImportacao,
  type OcorrenciaImportacao,
  type OpcoesImportacao,
  type TipoProduto,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { ErroApi } from '../comum/erros.js';
import { tiposHabilitados } from '../produtos/gravacao.js';
import { NCM_VIGENTE_SQL } from '../produtos/ncm.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import type { Celula, LinhaPlanilha } from './planilha.js';

/** Linha analisada: o que a prévia mostra + o necessário para gravar. */
export interface LinhaProduto extends LinhaPreviaImportacao {
  /** Criar: entrada completa; atualizar: só os campos que mudam (o resto vem do cadastro na gravação). */
  dados: Partial<CriarProdutoEntrada>;
  /** Criar com este código (Id Produto da planilha, ex.: o IdProduto do Nuvem3); `null` = sequência. */
  codigo: number | null;
  /** `estoque_atual` (com "Atualizar estoque") quando difere do saldo na hora da contagem (o que muda). */
  estoqueAtual: string | null;
  /**
   * `estoque_atual` aceito (com "Atualizar estoque"), mesmo igual ao saldo na hora da contagem: é a quantidade que
   * entra no "Definir" (F2-B11). `null` = não lançado (sem a coluna, produto sem saldo próprio ou negativo sem
   * permissão).
   */
  estoqueContado: string | null;
  /** `estoque_minimo` (com "Atualizar estoque mínimo"); `''` = limpar. */
  estoqueMinimo: string | null;
  /** `preco_loja` (com "Atualizar preços" ou produto novo). */
  precoLoja: string | null;
  marcaNova: string | null;
  /**
   * Todas as categorias da linha, na ordem (a 1ª é a principal), quando alguma precisa ser criada: as existentes já
   * vêm com o `id` (inclusive a subcategoria achada só pelo nome, que não pode ser recriada na raiz); as de `id` nulo
   * são criadas pelo `caminho` a partir da raiz.
   */
  categoriaNova: CategoriaDaLinha[] | null;
  /** Posições do combo lidas da coluna `composicao` (só na criação ou em combo sem posições). */
  composicao: ItemComposicao[] | null;
}

/** Categoria da célula: existente (`id`, caminho real para a prévia) ou a criar (`id` nulo, caminho da planilha). */
export interface CategoriaDaLinha {
  id: string | null;
  caminho: string[];
}

/** O que a sessão pode criar junto com os produtos (decisão 85). */
export interface PermissoesAnaliseProdutos {
  criarMarcas: boolean;
  criarCategorias: boolean;
  /** `produtos.ver_custo`: sem ela o custo não entra na comparação (nem é gravado, como no formulário). */
  verCusto: boolean;
  /**
   * Master ou `estoque.permite_negativo_erp` da loja: sem isso o estoque atual negativo da planilha não é lançado
   * (a mesma regra da Saída manual).
   */
  estoqueNegativo: boolean;
}

/** Produto existente como está gravado (base da comparação com a planilha). */
export type EstadoProduto = {
  id: string;
  codigo: number;
  nome: string;
  tipo: string;
  ativo: boolean;
  /** Sem controle de estoque o acerto não lança o saldo (a coluna `estoque_atual` não vale para ele). */
  controlaEstoque: boolean;
  codigoInterno: string | null;
  unidadeId: string;
  ncm: string | null;
  cest: string | null;
  precoCusto: string;
  markupPct: string;
  precoVenda: string;
  precoAtacado: string | null;
  qtdMinimaAtacado: string | null;
  precoPromocional: string | null;
  precoMenuDigital: string | null;
  precoIfood: string | null;
  precoParcelado: string | null;
  cfopVendaEstado: string | null;
  icmsSituacao: string | null;
  icmsOrigem: string | null;
  icmsAliquota: string | null;
  pisSituacao: string | null;
  cofinsSituacao: string | null;
  ipiSituacao: string | null;
  localizacao: string | null;
  pesoG: string | null;
  descricaoCurta: string | null;
  marcaId: string | null;
  categoriaPrincipalId: string | null;
  categorias: string[];
  codigosBarras: string[];
  usaMenuDigital: boolean;
  balancaTipo: string;
  temPosicoes: boolean;
  /** Da loja escolhida na importação. */
  estoqueMinimo: string | null;
  precoLoja: string | null;
  /** Saldo do estoque da loja no tipo de estoque padrão (o que o acerto "Definir" muda). */
  saldo: string | null;
};

type Achado = { id: string; nome: string; tipo: string; codigo: number };

export interface ReferenciasProdutos {
  unidades: Array<{ id: string; sigla: string; descricao: string; permiteFracao: boolean }>;
  unidadePadrao: string;
  marcas: Map<string, string>;
  nomesMarcas: Map<string, string>;
  categorias: Map<string, string>;
  /** Nome da categoria (sem caminho) → ids: "DIVERSOS" acha a única subcategoria com esse nome. */
  categoriasPorNome: Map<string, string[]>;
  nomesCategorias: Map<string, string>;
  ncms: Set<string>;
  cfops: Set<string>;
  porId: Map<string, Achado>;
  /** Código (Id Produto) → produto, inclusive excluído (o código continua ocupado no índice único). */
  porCodigo: Map<number, Achado & { excluido: boolean }>;
  porCodigoInterno: Map<string, Achado>;
  /** Códigos (interno, de barras ou número, minúsculos) dos componentes citados na coluna `composicao` que existem. */
  codigosComponentes: Set<string>;
  /** EAN → produtos que já o têm. */
  porEan: Map<string, Array<Achado & { codigo_interno: string | null }>>;
  /** Estado atual dos produtos que a planilha pode atualizar. */
  atuais: Map<string, EstadoProduto>;
  /** Tipos que a planilha pode criar ou para os quais pode trocar (F2-B1; `tiposHabilitados`). */
  tiposHabilitados: readonly TipoProduto[];
}

/** Maior código aceito (`produtos.codigo integer`). */
const CODIGO_MAXIMO = 2_147_483_647;

/** Categorias por célula: o mesmo limite do formulário (`criarProdutoSchema.categorias`), conferido antes de criar. */
export const MAX_CATEGORIAS_LINHA = 50;

/** Comparação de nomes (marca, categoria, tipo): sem acento, minúsculo, espaços simples. */
export const chaveNome = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "CERVEJA > LATA" ou "CERVEJA/LATA" → ['CERVEJA', 'LATA']. */
export const partesCategoria = (t: string) =>
  t
    .split(/\s*[>/\\]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

const TIPO_POR_NOME = new Map<string, TipoProduto>([
  ...TIPOS_PRODUTO.map((t) => [chaveNome(t.replace(/_/g, ' ')), t] as [string, TipoProduto]),
  ...Object.entries(ROTULOS_TIPO_PRODUTO).map(
    ([t, r]) => [chaveNome(r), t as TipoProduto] as [string, TipoProduto],
  ),
  ['produto', 'simples'],
  ['normal', 'simples'],
  ...MAPEAMENTO_PROVISORIO_NUVEM3.composicao.tiposCombo.map((t) => [t, 'kit'] as [string, TipoProduto]),
  ['materia prima', 'materia_prima'],
  ['servico', 'servico'],
  ['produzido', 'produzido'],
  ['vasilhame', 'vasilhame'],
  ['casco', 'vasilhame'],
]);

const texto = (v: Celula | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = String(v).trim();
  return t || null;
};

/** Carrega as referências que a análise consulta (uma ida ao banco por tipo, não por linha). */
export async function carregarReferencias(
  db: DbEmpresa,
  linhas: readonly LinhaPlanilha[],
  indices: Record<string, number>,
  lojaId: string | null,
  /** Estoque do "Atualizar estoque" e a hora da contagem: o saldo comparado é o do estoque nessa hora (F2-B11). */
  contagem: { estoqueId: string; dataContagem: string } | null = null,
): Promise<ReferenciasProdutos> {
  const coluna = (chave: string) =>
    indices[chave] === undefined
      ? []
      : linhas.map((l) => lerCodigoPlanilha(l.valores[indices[chave]!])).filter((v): v is string => !!v);
  const ids = coluna('id').filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  const codigos = coluna('codigo').filter((v) => /^\d{1,10}$/.test(v) && Number(v) <= CODIGO_MAXIMO);
  const internos = coluna('codigo_interno');
  const eans = coluna('ean').map((v) => v.replace(/\s/g, ''));
  const codigosComposicao =
    indices.composicao === undefined
      ? []
      : linhas.flatMap((l) => {
          const v = l.valores[indices.composicao!];
          return v === null || v === undefined ? [] : lerComposicao(String(v)).itens.map((i) => i.codigo);
        });
  const arr = (v: string[]) => `{${[...new Set(v)].map((x) => `"${x.replace(/["\\]/g, '')}"`).join(',')}}`;
  const componentes = codigosComposicao.length
    ? await db.execute<{ c: string }>(sql`
        select lower(p.codigo_interno) as c from produtos p
         where p.excluido_em is null and lower(p.codigo_interno) = any(${arr(codigosComposicao.map((c) => c.toLowerCase()))}::text[])
        union select cb.codigo from produtos_codigos_barras cb join produtos p on p.id = cb.produto_id and p.excluido_em is null
         where cb.excluido_em is null and cb.codigo = any(${arr(codigosComposicao)}::text[])
        union select p.codigo::text from produtos p
         where p.excluido_em is null and p.codigo::text = any(${arr(codigosComposicao.filter((c) => /^\d{1,9}$/.test(c)))}::text[])`)
    : { rows: [] as Array<{ c: string }> };
  const [un, mar, cat, ncm, cfop, pid, pcod, pint, pean] = await Promise.all([
    db.execute<{ id: string; sigla: string; descricao: string; permite_fracao: boolean }>(
      sql`select id, sigla, descricao, permite_fracao from unidades_medida where excluido_em is null and ativo order by sigla`,
    ),
    db.execute<{ id: string; descricao: string }>(
      sql`select id, descricao from marcas where excluido_em is null`,
    ),
    db.execute<{ id: string; nome: string; caminho_nomes: string }>(
      sql`select id, nome, caminho_nomes from categorias where excluido_em is null`,
    ),
    db.execute<{ codigo: string }>(sql`select n.codigo from ncms n where ${NCM_VIGENTE_SQL}`),
    db.execute<{ codigo: string }>(sql`select codigo from cfops where excluido_em is null`),
    db.execute<Achado>(sql`
      select id, nome, tipo, codigo from produtos where excluido_em is null and id = any(${arr(ids)}::uuid[])`),
    db.execute<Achado & { excluido: boolean }>(sql`
      select id, nome, tipo, codigo, excluido_em is not null as excluido from produtos
       where codigo = any(${arr(codigos)}::int[])`),
    db.execute<Achado & { codigo_interno: string }>(sql`
      select id, nome, tipo, codigo, codigo_interno from produtos
       where excluido_em is null and lower(codigo_interno) = any(${arr(internos.map((i) => i.toLowerCase()))}::text[])`),
    db.execute<Achado & { codigo_interno: string | null; ean: string }>(sql`
      select p.id, p.nome, p.tipo, p.codigo, p.codigo_interno, cb.codigo as ean
        from produtos_codigos_barras cb join produtos p on p.id = cb.produto_id and p.excluido_em is null
       where cb.excluido_em is null and cb.codigo = any(${arr(eans)}::text[])
       order by cb.principal desc, p.codigo`),
  ]);
  const porEan: ReferenciasProdutos['porEan'] = new Map();
  for (const r of pean.rows) porEan.set(r.ean, [...(porEan.get(r.ean) ?? []), r]);
  const unidades = un.rows.map((u) => ({
    id: u.id,
    sigla: u.sigla,
    descricao: u.descricao,
    permiteFracao: u.permite_fracao,
  }));
  const categoriasPorNome = new Map<string, string[]>();
  for (const c of cat.rows)
    categoriasPorNome.set(chaveNome(c.nome), [...(categoriasPorNome.get(chaveNome(c.nome)) ?? []), c.id]);
  const candidatos = [
    ...pid.rows.map((p) => p.id),
    ...pcod.rows.filter((p) => !p.excluido).map((p) => p.id),
    ...pint.rows.map((p) => p.id),
    ...pean.rows.map((p) => p.id),
  ];
  return {
    unidades,
    unidadePadrao: unidades.find((u) => u.sigla.toUpperCase() === 'UN')?.id ?? unidades[0]?.id ?? '',
    marcas: new Map(mar.rows.map((m) => [chaveNome(m.descricao), m.id])),
    nomesMarcas: new Map(mar.rows.map((m) => [m.id, m.descricao])),
    categorias: new Map(
      cat.rows.map((c) => [partesCategoria(c.caminho_nomes).map(chaveNome).join('>'), c.id]),
    ),
    categoriasPorNome,
    nomesCategorias: new Map(cat.rows.map((c) => [c.id, c.caminho_nomes])),
    ncms: new Set(ncm.rows.map((n) => n.codigo)),
    cfops: new Set(cfop.rows.map((c) => c.codigo)),
    porId: new Map(pid.rows.map((p) => [p.id, p])),
    porCodigo: new Map(pcod.rows.map((p) => [p.codigo, p])),
    porCodigoInterno: new Map(pint.rows.map((p) => [p.codigo_interno.toLowerCase(), p])),
    porEan,
    codigosComponentes: new Set(componentes.rows.map((r) => r.c.toLowerCase())),
    atuais: await carregarEstado(db, candidatos, lojaId, contagem),
    tiposHabilitados: await tiposHabilitados(db),
  };
}

/**
 * Estado gravado dos produtos candidatos à atualização: com a loja, o estoque mínimo e o preço; com a contagem, o saldo
 * do estoque escolhido (o da loja ou o CD) **na hora da contagem** (F2-B11): o saldo de agora menos os movimentos
 * posteriores a ela, a mesma conta do "Definir" (ERP 13.1.5). Comparar com o saldo de agora pulava o produto contado
 * ontem cujo saldo, depois das vendas de hoje, coincidiu com a contagem, e o "Definir" não descontava essas vendas.
 */
async function carregarEstado(
  db: DbEmpresa,
  ids: readonly string[],
  lojaId: string | null,
  contagem: { estoqueId: string; dataContagem: string } | null,
): Promise<Map<string, EstadoProduto>> {
  const mapa = new Map<string, EstadoProduto>();
  const unicos = [...new Set(ids)];
  for (let i = 0; i < unicos.length; i += 2000) {
    const lote = `{${unicos.slice(i, i + 2000).join(',')}}`;
    const { rows } = await db.execute<EstadoProduto>(sql`
      select p.id, p.codigo, p.nome, p.tipo, p.ativo, p.controla_estoque as "controlaEstoque",
             p.codigo_interno as "codigoInterno", p.unidade_id as "unidadeId",
             p.ncm, p.cest, p.preco_custo::text as "precoCusto", p.markup_pct::text as "markupPct",
             p.preco_venda::text as "precoVenda", p.preco_atacado::text as "precoAtacado",
             p.qtd_minima_atacado::text as "qtdMinimaAtacado", p.preco_promocional::text as "precoPromocional",
             p.preco_menu_digital::text as "precoMenuDigital", p.preco_ifood::text as "precoIfood",
             p.preco_parcelado::text as "precoParcelado", p.cfop_venda_estado as "cfopVendaEstado",
             p.icms_situacao as "icmsSituacao", p.icms_origem as "icmsOrigem", p.icms_aliquota::text as "icmsAliquota",
             p.pis_situacao as "pisSituacao", p.cofins_situacao as "cofinsSituacao", p.ipi_situacao as "ipiSituacao",
             p.localizacao, p.peso_g::text as "pesoG", p.descricao_curta as "descricaoCurta", p.marca_id as "marcaId",
             p.categoria_principal_id as "categoriaPrincipalId", p.usa_menu_digital as "usaMenuDigital",
             p.balanca_tipo as "balancaTipo",
             coalesce((select array_agg(pc.categoria_id::text order by pc.principal desc, pc.categoria_id)
                         from produtos_categorias pc
                        where pc.produto_id = p.id and pc.excluido_em is null), '{}') as categorias,
             coalesce((select array_agg(cb.codigo order by cb.principal desc, cb.codigo) from produtos_codigos_barras cb
                        where cb.produto_id = p.id and cb.variacao_id is null and cb.excluido_em is null), '{}')
               as "codigosBarras",
             exists (select 1 from produtos_componentes k
                      where k.produto_id = p.id and k.tipo = 'kit' and k.excluido_em is null) as "temPosicoes",
             pl.estoque_minimo::text as "estoqueMinimo", pl.preco_venda::text as "precoLoja",
             (select (s.quantidade - coalesce((
                       select sum(m.quantidade) from movimentos_estoque m
                        where m.estoque_id = s.estoque_id and m.produto_id = s.produto_id and m.variacao_id is null
                          and m.tipo_estoque_id = s.tipo_estoque_id
                          and m.data_movimento > ${contagem?.dataContagem ?? null}::timestamptz), 0))::text
                from saldos_estoque s
                join tipos_estoque t on t.id = s.tipo_estoque_id and t.padrao and t.excluido_em is null
               where s.estoque_id = ${contagem?.estoqueId ?? null}::uuid
                 and s.produto_id = p.id and s.variacao_id is null limit 1) as saldo
        from produtos p
        left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ${lojaId}::uuid and pl.excluido_em is null
       where p.excluido_em is null and p.id = any(${lote}::uuid[])`);
    for (const r of rows) mapa.set(r.id, r);
  }
  return mapa;
}

/**
 * Resolve as posições do combo na gravação (os componentes criados antes na mesma tarefa já existem): código
 * interno → código de barras → código numérico. Componente não achado → erro da linha.
 */
export async function resolverComposicao(
  db: DbEmpresa,
  itens: readonly ItemComposicao[],
): Promise<NonNullable<CriarProdutoEntrada['componentes']>> {
  const componentes: NonNullable<CriarProdutoEntrada['componentes']> = [];
  for (const [i, item] of itens.entries()) {
    const { rows } = await db.execute<{ id: string }>(sql`
      select id from (
        select p.id, 1 as ordem from produtos p
         where p.excluido_em is null and lower(p.codigo_interno) = lower(${item.codigo})
        union all
        select p.id, 2 from produtos_codigos_barras cb join produtos p on p.id = cb.produto_id and p.excluido_em is null
         where cb.excluido_em is null and cb.codigo = ${item.codigo}
        union all
        select p.id, 3 from produtos p
         where p.excluido_em is null and p.codigo::text = ${item.codigo}
      ) x order by ordem limit 1`);
    if (!rows[0]) throw new ErroApi('VALIDACAO', `Composição: componente "${item.codigo}" não encontrado`);
    componentes.push({
      id: null,
      tipo: 'kit',
      componenteId: rows[0].id,
      componenteVariacaoId: null,
      quantidade: item.quantidade,
      perdaPct: '0',
      rotuloPosicao: item.rotulo,
      permiteSubstituicao: false,
      ordem: i,
      alternativas: [],
    });
  }
  return componentes;
}

/** Colunas de preço (ignoradas em produto existente com "Atualizar preços" desligado). */
const PRECOS: Array<[string, keyof CriarProdutoEntrada]> = [
  ['preco_custo', 'precoCusto'],
  ['markup_pct', 'markupPct'],
  ['preco_venda', 'precoVenda'],
  ['preco_atacado', 'precoAtacado'],
  ['qtd_minima_atacado', 'qtdMinimaAtacado'],
  ['preco_promocional', 'precoPromocional'],
  ['preco_menu_digital', 'precoMenuDigital'],
  ['preco_ifood', 'precoIfood'],
  ['preco_parcelado', 'precoParcelado'],
];

/** Colunas de código fiscal (dígitos; o Excel guarda como número). */
const CODIGOS: Array<[string, keyof CriarProdutoEntrada, number]> = [
  ['cest', 'cest', 7],
  ['cfop_venda_estado', 'cfopVendaEstado', 4],
  ['icms_situacao', 'icmsSituacao', 0],
  ['icms_origem', 'icmsOrigem', 1],
  ['pis_situacao', 'pisSituacao', 2],
  ['cofins_situacao', 'cofinsSituacao', 2],
  ['ipi_situacao', 'ipiSituacao', 2],
];

const shape = criarProdutoSchema.shape;

/** Mensagens do zod de um campo isolado (atualização parcial) ou do produto inteiro (criação). */
function mensagens(resultado: {
  success: boolean;
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) {
  return resultado.success
    ? []
    : resultado.error!.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

const ROTULO_CAMPO: Partial<Record<keyof CriarProdutoEntrada, string>> = {
  precoCusto: 'Preço de custo',
  markupPct: 'Markup %',
  precoVenda: 'Preço de venda',
  precoAtacado: 'Preço de atacado',
  qtdMinimaAtacado: 'Qtd. mínima atacado',
  precoPromocional: 'Preço promocional',
  precoMenuDigital: 'Preço menu digital',
  precoIfood: 'Preço iFood',
  precoParcelado: 'Preço parcelado',
  cest: 'CEST',
  cfopVendaEstado: 'CFOP',
  icmsSituacao: 'CST/CSOSN',
  icmsOrigem: 'Origem',
  icmsAliquota: 'Alíquota do ICMS',
  pisSituacao: 'CST do PIS',
  cofinsSituacao: 'CST da COFINS',
  ipiSituacao: 'CST do IPI',
  pesoG: 'Peso (g)',
  nome: 'Nome',
  localizacao: 'Localização',
  descricaoCurta: 'Descrição curta',
  codigoInterno: 'Código interno',
};

/** Analisa as linhas (sem gravar). `eansNaPlanilha` acumula os EANs para achar duplicados dentro da própria planilha. */
export function analisarProdutos(
  linhas: readonly LinhaPlanilha[],
  indices: Record<string, number>,
  ref: ReferenciasProdutos,
  opcoes: OpcoesImportacao,
  pode: PermissoesAnaliseProdutos = {
    criarMarcas: true,
    criarCategorias: true,
    verCusto: true,
    estoqueNegativo: true,
  },
): LinhaProduto[] {
  // Códigos que a própria planilha cria (componentes do combo cadastrados na mesma carga).
  const codigosDaPlanilha = new Set<string>();
  for (const l of linhas) {
    for (const chave of ['codigo_interno', 'ean', 'codigo'] as const) {
      const i = indices[chave];
      const v = i === undefined ? null : lerCodigoPlanilha(l.valores[i]);
      if (v) codigosDaPlanilha.add(v.replace(/\s/g, '').toLowerCase());
    }
  }
  const eansNaPlanilha = new Map<string, number>();
  const internosNaPlanilha = new Map<string, number>();
  const codigosNaPlanilha = new Map<number, number>();
  const tem = (chave: string) => indices[chave] !== undefined;
  // Produto existente → 1ª linha que o identifica pelo Id ou pelo código (a identificação forte): uma linha que só
  // caia nele pelo código interno/EAN não o toma de outra linha.
  const pelaChave = new Map<string, number>();
  for (const l of linhas) {
    const id = tem('id') ? lerCodigoPlanilha(l.valores[indices.id!]) : null;
    const cod = tem('codigo') ? lerCodigoPlanilha(l.valores[indices.codigo!]) : null;
    const achado =
      (id ? ref.porId.get(id) : undefined) ??
      (cod && /^\d{1,10}$/.test(cod) ? ref.porCodigo.get(Number(cod)) : undefined);
    if (achado && !('excluido' in achado && achado.excluido) && !pelaChave.has(achado.id))
      pelaChave.set(achado.id, l.numero);
  }
  // Produto existente → linha que ficou com ele: duas linhas no mesmo produto se sobrescreveriam.
  const produtosNaPlanilha = new Map<string, number>();
  return linhas.map((l): LinhaProduto => {
    const cel = (chave: string): Celula | undefined => (tem(chave) ? l.valores[indices[chave]!] : undefined);
    const erros: string[] = [];
    const avisos: OcorrenciaImportacao[] = [];
    const aviso = (codigo: OcorrenciaImportacao['codigo'], campo: string | null, mensagem: string) =>
      avisos.push({ codigo, campo, mensagem });
    const dados: Partial<CriarProdutoEntrada> = {};
    const vazia = (): Omit<
      LinhaProduto,
      'linha' | 'acao' | 'descricao' | 'registroId' | 'erros' | 'avisos'
    > => ({
      dados,
      codigo: null,
      estoqueAtual: null,
      estoqueContado: null,
      estoqueMinimo: null,
      precoLoja: null,
      marcaNova: null,
      categoriaNova: null,
      composicao: null,
      alteracoes: [],
    });

    // Código (Id Produto): inteiro positivo do `integer`; repetido na planilha é erro.
    const codigoTexto = lerCodigoPlanilha(cel('codigo'));
    let codigo: number | null = null;
    if (codigoTexto) {
      if (!/^\d{1,10}$/.test(codigoTexto) || Number(codigoTexto) < 1 || Number(codigoTexto) > CODIGO_MAXIMO)
        erros.push(`Código "${codigoTexto}" inválido (número inteiro de 1 a ${CODIGO_MAXIMO})`);
      else {
        codigo = Number(codigoTexto);
        const anterior = codigosNaPlanilha.get(codigo);
        if (anterior !== undefined) erros.push(`Código ${codigo} repetido (linha ${anterior})`);
        else codigosNaPlanilha.set(codigo, l.numero);
      }
    }

    // Identificação: id → codigo → codigo_interno → ean.
    const id = lerCodigoPlanilha(cel('id'));
    const interno = texto(cel('codigo_interno'));
    const eanBruto = lerCodigoPlanilha(cel('ean'))?.replace(/\s/g, '') ?? null;
    let existente: Achado | null = null;
    let via: 'id' | 'codigo' | 'codigo_interno' | 'ean' | null = null;
    if (id) {
      existente = ref.porId.get(id) ?? null;
      if (!existente) erros.push(`Id ${id} não encontrado (apague a coluna Id para cadastrar como novo)`);
      else via = 'id';
    }
    if (!existente && !erros.length && codigo !== null) {
      const p = ref.porCodigo.get(codigo);
      if (p?.excluido)
        erros.push(
          `Código ${codigo} é de um produto excluído (apague o código para cadastrar com outro número)`,
        );
      else if (p) {
        existente = p;
        via = 'codigo';
      }
    }
    if (!existente && !erros.length && interno) {
      existente = ref.porCodigoInterno.get(interno.toLowerCase()) ?? null;
      if (existente) via = 'codigo_interno';
    }
    // Pelo EAN só quando a linha não traz código interno ou o produto achado não tem um (com códigos internos
    // diferentes é outro produto com o EAN duplicado, comum no Nuvem3).
    if (!existente && !erros.length && eanBruto) {
      const comEan = (ref.porEan.get(eanBruto) ?? []).filter((p) => !interno || !p.codigo_interno);
      if (comEan.length === 1) {
        existente = comEan[0]!;
        via = 'ean';
      } else if (comEan.length > 1)
        erros.push(`EAN ${eanBruto} está em ${comEan.length} produtos: informe o Id ou o código interno`);
    }
    if (existente && !erros.length) {
      const dono = pelaChave.get(existente.id);
      const anterior = produtosNaPlanilha.get(existente.id);
      const quem = `${existente.codigo} - ${existente.nome}`;
      if ((via === 'ean' || via === 'codigo_interno') && dono !== undefined && dono !== l.numero)
        erros.push(
          `O ${via === 'ean' ? 'EAN' : 'código interno'} aponta o produto ${quem}, que é o da linha ${dono} (pelo código): informe o Id/código desta linha ou corrija o ${via === 'ean' ? 'EAN' : 'código interno'}`,
        );
      else if (anterior !== undefined)
        erros.push(
          `Produto ${quem} já identificado pela linha ${anterior}: duas linhas não podem alterar o mesmo produto (informe o Id/código de cada uma)`,
        );
      else produtosNaPlanilha.set(existente.id, l.numero);
    }
    const nome = texto(cel('nome'));
    // Proteção contra cruzamento errado (decisão 102): avisa, não bloqueia.
    if (existente && codigo !== null && via !== 'codigo' && existente.codigo !== codigo)
      aviso(
        'codigo_conflito',
        'codigo',
        `Código ${codigo} da planilha ≠ código ${existente.codigo} do produto achado pelo ${via === 'id' ? 'Id' : via === 'ean' ? 'EAN' : 'código interno'} (${existente.nome}); o código do cadastro é mantido`,
      );
    if (existente && via === 'codigo') {
      const doEan = eanBruto ? (ref.porEan.get(eanBruto) ?? []) : [];
      const outro = doEan.find((p) => p.id !== existente!.id);
      if (outro && !doEan.some((p) => p.id === existente!.id))
        aviso(
          'codigo_conflito',
          'ean',
          `EAN ${eanBruto} é do produto ${outro.codigo} - ${outro.nome}, não do código ${codigo} (${existente.nome}): confira o código`,
        );
      if (nome && !nomesParecidos(nome, existente.nome))
        aviso(
          'codigo_conflito',
          'nome',
          `Nome muito diferente do cadastrado no código ${codigo} ("${existente.nome}"): confira o código`,
        );
    }
    const descricao = (nome ?? existente?.nome ?? eanBruto ?? interno ?? codigoTexto ?? '').slice(0, 120);

    // Excluir (Nuvem3): produto existente é inativado (o histórico fica); as demais colunas da linha não valem.
    const excluir = tem('excluir') ? lerExcluirPlanilha(cel('excluir')) : false;
    if (excluir === null)
      aviso(
        'outro',
        'excluir',
        `Excluir: "${String(cel('excluir'))}" não reconhecido (use S/Sim/X/1): ignorado`,
      );
    if (excluir) {
      const atual = existente ? ref.atuais.get(existente.id) : undefined;
      if (!erros.length && !existente)
        aviso(
          'exclusao_sem_produto',
          'excluir',
          'Marcado para excluir, mas o produto não existe: linha ignorada',
        );
      if (atual?.ativo) dados.ativo = false;
      const alteracoes: AlteracaoImportacao[] = atual?.ativo
        ? [{ campo: 'ativo', rotulo: 'Ativo', de: 'Sim', para: 'Não' }]
        : [];
      return {
        linha: l.numero,
        acao: erros.length || !existente ? 'ignorar' : alteracoes.length ? 'inativar' : 'sem_alteracao',
        descricao,
        registroId: existente?.id ?? null,
        erros,
        avisos,
        ...vazia(),
        alteracoes,
      };
    }

    // Nome.
    if (nome !== null) dados.nome = nome.slice(0, 120);
    else if (!existente) erros.push('Informe o nome do produto');

    // Tipo.
    const tipoTexto = texto(cel('tipo'));
    let tipo: TipoProduto | null = existente ? (existente.tipo as TipoProduto) : 'simples';
    if (tipoTexto) {
      const t = TIPO_POR_NOME.get(chaveNome(tipoTexto));
      if (!t) erros.push(`Tipo "${tipoTexto}" desconhecido`);
      else {
        tipo = t;
        dados.tipo = t;
      }
    }
    // Serviço não controla estoque (a regra do formulário, `criarProdutoSchema`): a planilha não tem a coluna, então o
    // tipo decide — sem isso o serviço novo da planilha caía em "controlaEstoque: Serviço não controla estoque"
    // (F2-B40). No serviço já gravado o valor é o mesmo e não entra no "O que muda".
    if (tipo === 'servico' && (!existente || dados.tipo === 'servico')) dados.controlaEstoque = false;
    // Combo: posições pela coluna `composicao`; sem ela o combo novo é criado inativo e avisado (decisão 95).
    let composicao: ItemComposicao[] | null = null;
    const composicaoTexto = texto(cel('composicao'));
    if (tipo === 'kit' && composicaoTexto) {
      const c = lerComposicao(composicaoTexto);
      erros.push(...c.erros);
      for (const item of c.itens) {
        const chave = item.codigo.toLowerCase();
        const conhecido =
          codigosDaPlanilha.has(chave) ||
          ref.porCodigoInterno.has(chave) ||
          ref.porEan.has(item.codigo) ||
          ref.codigosComponentes.has(chave);
        if (!conhecido) erros.push(`Composição: componente "${item.codigo}" não encontrado`);
      }
      if (c.itens.length) composicao = c.itens;
    } else if (composicaoTexto && tipo !== 'kit') {
      aviso('outro', 'composicao', 'Composição ignorada: só o tipo Combo / kit tem posições');
    }
    if (!existente && tipo === 'kit' && !composicao && !erros.length) {
      aviso(
        'combo_sem_posicoes',
        'composicao',
        'Combo sem posições: criado inativo; cadastre as posições no ERP (Produtos › Combo) e ative',
      );
      dados.ativo = false;
    }
    // Tipos sem suporte (F2-B1; D43): a planilha não cria nem troca para eles (mesma regra do formulário); o produto já
    // gravado com o tipo (o "Com complementos" da carga do Nuvem3) segue atualizando e reimportando normalmente.
    const tipoBloqueado = tipo
      ? motivoTipoProdutoBloqueado(
          tipo,
          existente ? (existente.tipo as TipoProduto) : null,
          ref.tiposHabilitados,
        )
      : null;
    if (tipoBloqueado) erros.push(tipoBloqueado);
    else if (!existente && tipo === 'com_variacoes')
      erros.push('Produto com variações não é criado pela planilha: cadastre a grade no ERP');

    // Unidade: sigla, descrição ou nome por extenso do Nuvem3 ("Unidade", "Conjunto", "Pacote").
    const unidadeTexto = texto(cel('unidade'));
    if (unidadeTexto) {
      const un = resolverUnidadePlanilha(unidadeTexto, ref.unidades);
      if (!un) erros.push(`Unidade "${unidadeTexto}" inexistente (Cadastros › Unidades)`);
      else {
        dados.unidadeId = un.id;
        dados.permiteFracao = tipo === 'kit' ? false : un.permiteFracao;
      }
    } else if (!existente) dados.unidadeId = ref.unidadePadrao;

    // Ativo.
    if (tem('ativo')) {
      const ativo = lerBooleanoPlanilha(cel('ativo'));
      if (ativo !== null && !(dados.ativo === false && tipo === 'kit' && !composicao)) dados.ativo = ativo;
    }

    // Código interno (único: 409 do banco vira erro da linha na gravação; repetido na planilha já aqui).
    if (interno) {
      dados.codigoInterno = interno;
      const anterior = internosNaPlanilha.get(interno.toLowerCase());
      if (anterior !== undefined) erros.push(`Código interno ${interno} repetido (linha ${anterior})`);
      else internosNaPlanilha.set(interno.toLowerCase(), l.numero);
    }

    // EAN: inválido vira código interno do produto; duplicado é gravado e avisado (MD 3.6.5, migração).
    if (eanBruto) {
      const gtin = /^\d+$/.test(eanBruto) && validarGtin(eanBruto);
      if (!gtin)
        aviso(
          'ean_invalido',
          'ean',
          `EAN ${eanBruto} inválido (dígito verificador ou tamanho): gravado como código de barras interno`,
        );
      const outros = (ref.porEan.get(eanBruto) ?? []).filter((p) => p.id !== existente?.id);
      const naPlanilha = eansNaPlanilha.get(eanBruto);
      if (gtin && outros.length)
        aviso(
          'ean_duplicado',
          'ean',
          `EAN ${eanBruto} já está no produto ${outros[0]!.codigo} - ${outros[0]!.nome}`,
        );
      else if (gtin && naPlanilha !== undefined)
        aviso('ean_duplicado', 'ean', `EAN ${eanBruto} repetido na planilha (linha ${naPlanilha})`);
      if (naPlanilha === undefined) eansNaPlanilha.set(eanBruto, l.numero);
      dados.codigosBarras = [
        { codigo: eanBruto.slice(0, 30), tipo: gtin ? 'gtin' : 'interno', principal: true, fator: '1' },
      ];
    }

    // Preços (8.6 "Atualizar preços").
    const usarPrecos = !existente || opcoes.atualizarPrecos;
    if (usarPrecos) {
      for (const [chave, campo] of PRECOS) {
        if (!tem(chave)) continue;
        // Célula numérica do Excel arredondada às casas da coluna (preço/custo `numeric(15,4)`, quantidade 3).
        const valor = lerDecimalPlanilha(cel(chave), campo === 'qtdMinimaAtacado' ? 3 : 4);
        if (valor === null) {
          if (campo !== 'precoVenda' && campo !== 'precoCusto' && campo !== 'markupPct')
            (dados as Record<string, unknown>)[campo] = null;
          continue;
        }
        if (valor === false) {
          erros.push(`${ROTULO_CAMPO[campo]}: "${String(cel(chave))}" não é um número`);
          continue;
        }
        const r = mensagens(shape[campo].safeParse(valor));
        if (r.length) erros.push(`${ROTULO_CAMPO[campo]}: ${r.join('; ')}`);
        else (dados as Record<string, unknown>)[campo] = valor;
      }
    }
    const venda = dados.precoVenda === undefined ? null : dec(dados.precoVenda);
    if (!existente && tipo !== 'materia_prima' && !(venda !== null && venda.gt(0))) {
      // Só o erro (a linha não é criada): o aviso `sem_preco` repetiria a mesma informação.
      erros.push('Sem preço de venda: o produto não é criado (informe o preço ou o tipo Matéria-prima)');
    } else if (
      existente &&
      usarPrecos &&
      tem('preco_venda') &&
      venda !== null &&
      !venda.gt(0) &&
      tipo !== 'materia_prima'
    ) {
      aviso('sem_preco', 'preco_venda', 'Preço de venda zerado na planilha: o preço atual foi mantido');
      delete dados.precoVenda;
    }

    // NCM: 7 dígitos = zero à esquerda perdido no Excel; inexistente na tabela vigente → gravado sem NCM e avisado.
    const ncmBruto = lerCodigoPlanilha(cel('ncm'));
    if (ncmBruto !== null || (tem('ncm') && !existente)) {
      const lido = lerNcmPlanilha(ncmBruto);
      if (!lido) {
        if (!existente && tipo !== 'servico' && tipo !== 'kit') aviso('ncm_invalido', 'ncm', 'Sem NCM');
      } else if (lido.ncm.length === 8 && ref.ncms.has(lido.ncm)) dados.ncm = lido.ncm;
      else
        aviso(
          'ncm_invalido',
          'ncm',
          `NCM ${ncmBruto}${lido.completado ? ` (com o zero à esquerda: ${lido.ncm})` : ''} ${lido.ncm.length === 8 ? 'inexistente na tabela vigente' : 'inválido'}`,
        );
    } else if (!existente && tipo !== 'servico' && tipo !== 'kit') aviso('ncm_invalido', 'ncm', 'Sem NCM');

    // Códigos fiscais e demais campos de texto/número.
    for (const [chave, campo, tamanho] of CODIGOS) {
      const v = lerCodigoPlanilha(cel(chave));
      if (v === null) continue;
      const digitos = tamanho ? v.replace(/\D/g, '').padStart(tamanho, '0') : v.replace(/\D/g, '');
      const r = mensagens(shape[campo].safeParse(digitos));
      if (r.length) erros.push(`${ROTULO_CAMPO[campo]}: ${r.join('; ')}`);
      else if (campo === 'cfopVendaEstado' && !ref.cfops.has(digitos))
        erros.push(`CFOP ${digitos} inexistente`);
      else (dados as Record<string, unknown>)[campo] = digitos;
    }
    if (tem('icms_aliquota')) {
      const n = lerNumeroPlanilha(cel('icms_aliquota'));
      if (n !== null && Number.isNaN(n)) erros.push('Alíquota do ICMS inválida');
      else if (n !== null) dados.icmsAliquota = String(n);
    }
    for (const [chave, campo, max] of [
      ['localizacao', 'localizacao', 40],
      ['descricao_curta', 'descricaoCurta', 250],
    ] as const) {
      const v = texto(cel(chave));
      if (v !== null) dados[campo] = v.slice(0, max);
    }
    if (tem('peso_g')) {
      const n = lerNumeroPlanilha(cel('peso_g'));
      if (n !== null && Number.isNaN(n)) erros.push('Peso (g) inválido');
      else if (n !== null) dados.pesoG = String(n);
    }

    // Menu digital e balança (colunas de edição em massa do Nuvem3).
    if (tem('usa_menu_digital') && texto(cel('usa_menu_digital')) !== null) {
      const b = lerBooleanoPlanilha(cel('usa_menu_digital'));
      if (b === null)
        aviso(
          'outro',
          'usa_menu_digital',
          `Usa no menu digital: "${String(cel('usa_menu_digital'))}" não reconhecido`,
        );
      else dados.usaMenuDigital = b;
    }
    if (tem('balanca')) {
      const b = lerBalancaPlanilha(cel('balanca'));
      if (b === false)
        aviso(
          'outro',
          'balanca',
          `Balança: "${String(cel('balanca'))}" não reconhecido (use Peso, Unidade ou Não)`,
        );
      else if (b !== null) dados.balancaTipo = b;
    }

    // Marca e categoria.
    let marcaNova: string | null = null;
    const marca = texto(cel('marca'));
    if (marca) {
      const idMarca = ref.marcas.get(chaveNome(marca));
      if (idMarca) dados.marcaId = idMarca;
      else if (opcoes.criarMarcasCategorias && pode.criarMarcas) marcaNova = marca.slice(0, 60);
      else aviso('marca_inexistente', 'marca', `Marca "${marca}" inexistente: produto gravado sem marca`);
    }
    // Lista do Nuvem3 ("MERCEARIA,PIPOCA,"): várias categorias, a primeira é a principal; cada uma pode ser um caminho.
    let categoriaNova: CategoriaDaLinha[] | null = null;
    const categoriaTexto = texto(cel('categoria'));
    const itensCategoria = categoriaTexto ? lerListaCategorias(categoriaTexto) : [];
    if (itensCategoria.length > MAX_CATEGORIAS_LINHA)
      erros.push(
        `Categoria: ${itensCategoria.length} categorias na célula (máximo ${MAX_CATEGORIAS_LINHA} por produto)`,
      );
    else if (itensCategoria.length) {
      const caminhos: CategoriaDaLinha[] = [];
      const idsCategoria: string[] = [];
      let criar = false;
      for (const item of itensCategoria) {
        const partes = partesCategoria(item);
        if (!partes.length) continue;
        const idCat = idCategoria(ref, partes);
        if (idCat) {
          idsCategoria.push(idCat);
          // Caminho real (a subcategoria achada só pelo nome não é a raiz homônima).
          caminhos.push({ id: idCat, caminho: (ref.nomesCategorias.get(idCat) ?? item).split(' > ') });
        } else if (opcoes.criarMarcasCategorias && pode.criarCategorias && partes.length <= 5) {
          criar = true;
          caminhos.push({ id: null, caminho: partes.map((p) => p.slice(0, 60)) });
        } else
          aviso(
            'categoria_inexistente',
            'categoria',
            `Categoria "${partes.join(' > ')}" inexistente: não vinculada ao produto`,
          );
      }
      if (criar) categoriaNova = caminhos;
      else if (idsCategoria.length) {
        dados.categorias = [...new Set(idsCategoria)];
        dados.categoriaPrincipalId = idsCategoria[0]!;
      }
    }

    // Estoque e preço da loja (8.6). O estoque atual pode ser negativo (saldo real do Nuvem3).
    const lerQtd = (chave: string, rotulo: string, negativo = false): string | null => {
      if (!tem(chave)) return null;
      const v = lerDecimalPlanilha(cel(chave), 3);
      if (v === null) return null;
      if (v === false || (!negativo && dec(v).lt(0))) {
        erros.push(`${rotulo}: "${String(cel(chave))}" inválido`);
        return null;
      }
      return v;
    };
    // Combo, serviço e produzido não têm saldo próprio (TIPOS_SEM_ESTOQUE do acerto).
    let estoqueAtual =
      opcoes.atualizarEstoque && tipo !== 'kit' && tipo !== 'servico' && tipo !== 'produzido'
        ? lerQtd('estoque_atual', 'Estoque atual', true)
        : null;
    const atualCadastro = existente ? ref.atuais.get(existente.id) : undefined;
    const igualAoSaldo = (v: string) => !!atualCadastro && mesmoDecimal(v, atualCadastro.saldo ?? '0');
    // Produto sem controle de estoque: o acerto não o lança (a prévia não promete o que a gravação não faz).
    if (estoqueAtual !== null && atualCadastro && !atualCadastro.controlaEstoque) {
      if (!igualAoSaldo(estoqueAtual))
        aviso(
          'outro',
          'estoque_atual',
          'Estoque atual ignorado: o produto não controla estoque (Produtos › Estoque)',
        );
      estoqueAtual = null;
    }
    // Produto com variações (o legado da D43, que segue importável): o saldo é por variação, e o "Definir" da planilha
    // lança só no produto (sem variação), que o acerto recusa ("Escolha a variação"). Fica fora da prévia e do acerto.
    if (estoqueAtual !== null && tipo === 'com_variacoes') {
      if (!igualAoSaldo(estoqueAtual))
        aviso(
          'outro',
          'estoque_atual',
          'Estoque atual ignorado: o estoque do produto com variações é por variação (Estoques › Acertos)',
        );
      estoqueAtual = null;
    }
    // Saldo negativo só com a permissão da Saída manual (Master ou "Permitir saldo negativo em documentos do ERP").
    if (estoqueAtual !== null && dec(estoqueAtual).lt(0) && !pode.estoqueNegativo) {
      if (!igualAoSaldo(estoqueAtual))
        aviso(
          'estoque_negativo',
          'estoque_atual',
          `Estoque atual negativo (${formatarQuantidade(estoqueAtual)}) não lançado: a loja não permite saldo negativo no ERP (Configurações › Geral); o saldo fica como está`,
        );
      estoqueAtual = null;
    }
    const estoqueMinimo = opcoes.atualizarEstoqueMinimo ? lerQtd('estoque_minimo', 'Estoque mínimo') : null;
    // Preço da loja: dinheiro (não quantidade), não negativo, nas casas do preço.
    let precoLoja: string | null = null;
    if (usarPrecos && tem('preco_loja')) {
      const v = lerDecimalPlanilha(cel('preco_loja'), 4);
      if (v === false || (v !== null && dec(v).lt(0)))
        erros.push(`Preço da loja: "${String(cel('preco_loja'))}" inválido`);
      else if (v !== null) {
        const r = mensagens(precoCampo.safeParse(v));
        if (r.length) erros.push(`Preço da loja: ${r.join('; ')}`);
        else precoLoja = v;
      }
    }
    // O estoque atual vai ao estoque escolhido (o CD não tem loja, F2-B11); o mínimo e o preço são da loja.
    if ((estoqueMinimo !== null || precoLoja !== null) && !opcoes.lojaId)
      erros.push('Escolha a loja para importar o estoque mínimo e o preço da loja');

    // Produto novo: o formulário inteiro tem de passar (regras cruzadas, como CEST com ST). A composição do combo
    // só é resolvida na gravação: aqui entra uma posição provisória para a regra "combo ativo tem posição".
    if (!existente && !erros.length) {
      const provisoria = composicao
        ? composicao.map((c, i) => ({
            id: null,
            tipo: 'kit' as const,
            componenteId: '00000000-0000-7000-8000-000000000000',
            componenteVariacaoId: null,
            quantidade: c.quantidade,
            perdaPct: '0',
            rotuloPosicao: c.rotulo,
            permiteSubstituicao: false,
            ordem: i,
            alternativas: [],
          }))
        : [];
      const r = criarProdutoSchema.safeParse({ ...dados, lojas: [], componentes: provisoria });
      erros.push(...mensagens(r));
    }

    const linha: LinhaProduto = {
      linha: l.numero,
      acao: erros.length ? 'ignorar' : existente ? 'atualizar' : 'criar',
      descricao,
      registroId: existente?.id ?? null,
      erros,
      avisos,
      dados,
      codigo: existente ? null : codigo,
      estoqueAtual,
      estoqueContado: estoqueAtual,
      estoqueMinimo,
      precoLoja,
      marcaNova,
      categoriaNova,
      composicao,
      alteracoes: [],
    };
    // Produto existente: só o que muda é gravado; nada mudou → `sem_alteracao` (decisão 103).
    if (linha.acao === 'atualizar') {
      const atual = ref.atuais.get(existente!.id);
      if (atual) {
        linha.alteracoes = compararComAtual(linha, atual, ref, pode.verCusto);
        if (!linha.alteracoes.length) linha.acao = 'sem_alteracao';
        estoqueAtual = linha.estoqueAtual;
      }
    }
    if (linha.acao !== 'ignorar' && estoqueAtual !== null && dec(estoqueAtual).lt(0))
      aviso(
        'estoque_negativo',
        'estoque_atual',
        `Estoque atual negativo (${formatarQuantidade(estoqueAtual)}): o acerto "Definir" deixa o saldo negativo, como na planilha`,
      );
    return linha;
  });
}

/** Categoria existente pelo caminho; um nome só também acha a única categoria (de qualquer nível) com esse nome. */
function idCategoria(ref: ReferenciasProdutos, partes: readonly string[]): string | null {
  const direto = ref.categorias.get(partes.map(chaveNome).join('>'));
  if (direto) return direto;
  if (partes.length !== 1) return null;
  const mesmoNome = ref.categoriasPorNome.get(chaveNome(partes[0]!)) ?? [];
  return mesmoNome.length === 1 ? mesmoNome[0]! : null;
}

// ---------------------------------------------------------------- O que muda (decisão 103)

/** Dinheiro/preço para a prévia: ao menos 2 casas, vírgula decimal (`4.4900` → `4,49`). */
export function formatarDinheiro(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = dec(v);
  return d.toFixed(Math.max(2, d.decimalPlaces())).replace('.', ',');
}

/** Quantidade/percentual para a prévia: sem zeros à direita (`120.000` → `120`, `2.500` → `2,5`). */
export function formatarQuantidade(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  return dec(v).toFixed().replace('.', ',');
}

const simNao = (v: boolean | null | undefined) => (v === null || v === undefined ? null : v ? 'Sim' : 'Não');
const ROTULOS_BALANCA: Record<string, string> = { nao_usa: 'Não usa', peso: 'Peso', unidade: 'Unidade' };

type CampoComparado =
  | 'nome'
  | 'tipo'
  | 'ativo'
  | 'codigoInterno'
  | 'precoCusto'
  | 'markupPct'
  | 'precoVenda'
  | 'precoAtacado'
  | 'qtdMinimaAtacado'
  | 'precoPromocional'
  | 'precoMenuDigital'
  | 'precoIfood'
  | 'precoParcelado'
  | 'ncm'
  | 'cest'
  | 'cfopVendaEstado'
  | 'icmsSituacao'
  | 'icmsOrigem'
  | 'icmsAliquota'
  | 'pisSituacao'
  | 'cofinsSituacao'
  | 'ipiSituacao'
  | 'localizacao'
  | 'pesoG'
  | 'descricaoCurta'
  | 'usaMenuDigital'
  | 'balancaTipo';

/** Campos simples comparados com o cadastro: rótulo e como comparar/exibir. */
const CAMPOS_COMPARADOS: Array<[CampoComparado, string, 'texto' | 'dinheiro' | 'quantidade' | 'booleano']> = [
  ['nome', 'Nome', 'texto'],
  ['tipo', 'Tipo', 'texto'],
  ['ativo', 'Ativo', 'booleano'],
  ['codigoInterno', 'Código interno', 'texto'],
  ['precoCusto', 'Preço de custo', 'dinheiro'],
  ['markupPct', 'Markup %', 'quantidade'],
  ['precoVenda', 'Preço de venda', 'dinheiro'],
  ['precoAtacado', 'Preço de atacado', 'dinheiro'],
  ['qtdMinimaAtacado', 'Qtd. mínima atacado', 'quantidade'],
  ['precoPromocional', 'Preço promocional', 'dinheiro'],
  ['precoMenuDigital', 'Preço menu digital', 'dinheiro'],
  ['precoIfood', 'Preço iFood', 'dinheiro'],
  ['precoParcelado', 'Preço parcelado', 'dinheiro'],
  ['ncm', 'NCM', 'texto'],
  ['cest', 'CEST', 'texto'],
  ['cfopVendaEstado', 'CFOP', 'texto'],
  ['icmsSituacao', 'CST/CSOSN', 'texto'],
  ['icmsOrigem', 'Origem', 'texto'],
  ['icmsAliquota', 'Alíquota do ICMS', 'quantidade'],
  ['pisSituacao', 'CST do PIS', 'texto'],
  ['cofinsSituacao', 'CST da COFINS', 'texto'],
  ['ipiSituacao', 'CST do IPI', 'texto'],
  ['localizacao', 'Localização', 'texto'],
  ['pesoG', 'Peso (g)', 'quantidade'],
  ['descricaoCurta', 'Descrição curta', 'texto'],
  ['usaMenuDigital', 'Usa no menu digital', 'booleano'],
  ['balancaTipo', 'Balança', 'texto'],
];

/**
 * Compara a linha com o produto gravado e **tira da linha** o que não muda (`dados`, estoque, preço da loja,
 * composição): a gravação só envia o que mudou. Decimais comparados como decimal (`2,5` = `2.50`). Sem
 * `produtos.ver_custo` o custo e o markup não entram (não seriam gravados e a prévia revelaria o custo).
 */
export function compararComAtual(
  l: LinhaProduto,
  atual: EstadoProduto,
  ref: ReferenciasProdutos,
  verCusto: boolean,
): AlteracaoImportacao[] {
  const alteracoes: AlteracaoImportacao[] = [];
  const d = l.dados as Record<string, unknown>;
  const mudou = (campo: string, rotulo: string, de: string | null, para: string | null) =>
    alteracoes.push({ campo, rotulo, de, para });
  if (!verCusto || l.dados.tipo === 'kit' || atual.tipo === 'kit') {
    delete d.precoCusto;
    delete d.markupPct;
  }
  for (const [campo, rotulo, forma] of CAMPOS_COMPARADOS) {
    if (!(campo in d)) continue;
    const novo = d[campo] as string | boolean | null | undefined;
    const velho = atual[campo] as string | boolean | null;
    const igual =
      forma === 'dinheiro' || forma === 'quantidade'
        ? mesmoDecimal(velho as string | null, novo as string | null)
        : forma === 'booleano'
          ? Boolean(velho) === Boolean(novo)
          : (velho ?? null) === (novo ?? null);
    if (igual) {
      delete d[campo];
      continue;
    }
    const exibir = (v: unknown): string | null =>
      forma === 'dinheiro'
        ? formatarDinheiro(v as string | null)
        : forma === 'quantidade'
          ? formatarQuantidade(v as string | null)
          : forma === 'booleano'
            ? simNao(v as boolean | null)
            : campo === 'tipo'
              ? (ROTULOS_TIPO_PRODUTO[v as TipoProduto] ?? (v as string))
              : campo === 'balancaTipo'
                ? (ROTULOS_BALANCA[v as string] ?? (v as string))
                : ((v as string | null) ?? null);
    mudou(campo, rotulo, exibir(velho), exibir(novo));
  }

  // Unidade (a fração acompanha a unidade só quando ela muda).
  if (l.dados.unidadeId !== undefined) {
    if (l.dados.unidadeId === atual.unidadeId) {
      delete d.unidadeId;
      delete d.permiteFracao;
    } else {
      const sigla = (id: string) => ref.unidades.find((u) => u.id === id)?.sigla ?? null;
      mudou('unidade', 'Unidade', sigla(atual.unidadeId), sigla(l.dados.unidadeId));
    }
  }

  // Código de barras: o da planilha entra se o produto ainda não o tem (os demais ficam).
  const novoCb = l.dados.codigosBarras?.[0];
  if (novoCb) {
    if (atual.codigosBarras.includes(novoCb.codigo)) delete d.codigosBarras;
    else
      mudou(
        'ean',
        'Código de barras',
        atual.codigosBarras.join(', ') || null,
        [...atual.codigosBarras, novoCb.codigo].join(', '),
      );
  }

  // Marca.
  if (l.marcaNova) mudou('marca', 'Marca', nomeMarca(ref, atual.marcaId), `${l.marcaNova} (nova)`);
  else if ('marcaId' in d) {
    const marcaId = (l.dados.marcaId as string | null | undefined) ?? null;
    if (marcaId === atual.marcaId) delete d.marcaId;
    else mudou('marca', 'Marca', nomeMarca(ref, atual.marcaId), nomeMarca(ref, marcaId));
  }

  // Categorias: o conjunto e a principal.
  const nomesCategorias = (ids: readonly string[]) =>
    ids.map((id) => ref.nomesCategorias.get(id) ?? id).join(', ') || null;
  const atuaisOrdenadas = [
    ...(atual.categoriaPrincipalId ? [atual.categoriaPrincipalId] : []),
    ...atual.categorias.filter((c) => c !== atual.categoriaPrincipalId),
  ];
  if (l.categoriaNova)
    mudou(
      'categorias',
      'Categorias',
      nomesCategorias(atuaisOrdenadas),
      l.categoriaNova.map((c) => `${c.caminho.join(' > ')}${c.id ? '' : ' (nova)'}`).join(', '),
    );
  else if (l.dados.categorias) {
    const novas = l.dados.categorias;
    const iguais =
      novas.length === atual.categorias.length &&
      novas.every((c) => atual.categorias.includes(c)) &&
      (l.dados.categoriaPrincipalId ?? novas[0] ?? null) === (atual.categoriaPrincipalId ?? null);
    if (iguais) {
      delete d.categorias;
      delete d.categoriaPrincipalId;
    } else mudou('categorias', 'Categorias', nomesCategorias(atuaisOrdenadas), nomesCategorias(novas));
  }

  // Composição: só combo ainda sem posições a recebe (decisão 95).
  if (l.composicao) {
    if (atual.temPosicoes) l.composicao = null;
    else
      mudou(
        'composicao',
        'Composição',
        null,
        l.composicao.map((c) => `${c.codigo}*${formatarQuantidade(c.quantidade)}`).join(' | '),
      );
  }

  // Loja: estoque mínimo, preço da loja e saldo.
  if (l.estoqueMinimo !== null) {
    if (mesmoDecimal(l.estoqueMinimo, atual.estoqueMinimo)) l.estoqueMinimo = null;
    else
      mudou(
        'estoque_minimo',
        'Estoque mínimo',
        formatarQuantidade(atual.estoqueMinimo),
        formatarQuantidade(l.estoqueMinimo),
      );
  }
  if (l.precoLoja !== null) {
    if (mesmoDecimal(l.precoLoja, atual.precoLoja)) l.precoLoja = null;
    else
      mudou('preco_loja', 'Preço da loja', formatarDinheiro(atual.precoLoja), formatarDinheiro(l.precoLoja));
  }
  if (l.estoqueAtual !== null) {
    if (mesmoDecimal(l.estoqueAtual, atual.saldo ?? '0')) l.estoqueAtual = null;
    else
      mudou(
        'estoque_atual',
        'Estoque atual',
        formatarQuantidade(atual.saldo ?? '0'),
        formatarQuantidade(l.estoqueAtual),
      );
  }
  return alteracoes;
}

const nomeMarca = (ref: ReferenciasProdutos, id: string | null) =>
  id === null ? null : (ref.nomesMarcas.get(id) ?? id);
