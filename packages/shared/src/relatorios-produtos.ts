/**
 * Relatórios de produto (ERP 16.1 e 16.3; Fase 2, F2-B41): o **Produtos geral** — as margens do catálogo, com o
 * custo, a venda (a da loja escolhida), o atacado, o lucro em R$, o lucro %, o markup % e os departamentos, e as médias
 * do relatório inteiro em decimal — e o **NCMs inválidos** — os produtos com o NCM vazio, inexistente ou fora de
 * vigência e, com a tabela `cests` carregada, o CEST incompatível com o NCM —, com a ação em lote "Definir NCM". E o
 * **Histórico de produtos** (ERP 16.2; F2-B42): quem mudou o quê no cadastro, sobre a auditoria, em texto legível.
 */
import { z } from 'zod';
import { TAMANHOS_PAGINA } from './paginacao.js';

const vazioIndefinido = (v: unknown) => (v === '' || v === null ? undefined : v);
const uuidOpcional = z.preprocess(vazioIndefinido, z.uuid().optional());

/** Booleano da query (`true`/`1`/`on` e `false`/`0`); vazio = o padrão. */
const booleanoQuery = (padrao: boolean) =>
  z.preprocess(
    (v) =>
      v === 'true' || v === 'on' || v === '1' || v === true
        ? true
        : v === 'false' || v === '0' || v === false
          ? false
          : v === '' || v === null || v === undefined
            ? undefined
            : v,
    z.boolean('Use true ou false').default(padrao),
  );

/** A página dos dois relatórios (`tamanho` de `TAMANHOS_PAGINA`, padrão 50). */
const camposPagina = {
  pagina: z.preprocess(vazioIndefinido, z.coerce.number().int().min(1).default(1)),
  tamanho: z.preprocess(
    vazioIndefinido,
    z.coerce
      .number()
      .int()
      .refine((t) => (TAMANHOS_PAGINA as readonly number[]).includes(t), {
        message: `Tamanho de página inválido (${TAMANHOS_PAGINA.join(', ')})`,
      })
      .default(50),
  ),
};

// ---------------------------------------------------------------- Produtos geral (ERP 16.1)

/** Chave do relatório (rota `GET /relatorios/produtos-geral` e a da exportação, `…/exportar`). */
export const RELATORIO_PRODUTOS_GERAL = 'produtos-geral';

export const ORDENACOES_PRODUTOS_GERAL = [
  'produto',
  'codigo',
  'codigo_interno',
  'preco_venda',
  'preco_custo',
  'lucro',
  'lucro_pct',
  'markup_pct',
] as const;
/** As ordenações que leem o custo (exigem `produtos.ver_custo`). */
export const ORDENACOES_PRODUTOS_GERAL_CUSTO: readonly string[] = [
  'preco_custo',
  'lucro',
  'lucro_pct',
  'markup_pct',
];

const camposProdutosGeral = {
  /** Nome, código interno ou EAN. */
  nome: z.preprocess(vazioIndefinido, z.string().trim().max(120).optional()),
  marcaId: uuidOpcional,
  /** Departamento: a categoria e as filhas (árvore). */
  categoriaId: uuidOpcional,
  /** Só os produtos sem preço de venda (o da loja, com a loja). */
  semPreco: booleanoQuery(false),
  /** A loja (entre as permitidas): o preço de venda dela, quando tem; sem loja, o preço do produto. */
  lojaId: uuidOpcional,
  situacao: z.preprocess(vazioIndefinido, z.enum(['ativos', 'inativos', 'todos']).default('ativos')),
  /** `campo:asc|desc` de `ORDENACOES_PRODUTOS_GERAL` (padrão `produto:asc`). */
  ordenar: z.preprocess(
    vazioIndefinido,
    z
      .string()
      .regex(
        new RegExp(`^(${ORDENACOES_PRODUTOS_GERAL.join('|')}):(asc|desc)$`),
        `Use campo:asc ou campo:desc, com o campo entre ${ORDENACOES_PRODUTOS_GERAL.join(', ')}`,
      )
      .optional(),
  ),
};

/** Os filtros sem a página: os da exportação (`tarefas.parametros` guarda a entrada crua, validada de novo). */
export const filtrosProdutosGeralSchema = z.object(camposProdutosGeral);
export type FiltrosProdutosGeral = z.output<typeof filtrosProdutosGeralSchema>;

/** `GET /relatorios/produtos-geral`: os filtros e a página. */
export const consultaProdutosGeralSchema = z.object({ ...camposProdutosGeral, ...camposPagina });
export type ConsultaProdutosGeral = z.output<typeof consultaProdutosGeralSchema>;

/**
 * Uma linha do Produtos geral. Os valores são `numeric` em texto (decimal, sem `float`): o lucro em R$ = venda −
 * custo, o lucro % = lucro ÷ venda × 100 (nulo sem venda) e o markup % = lucro ÷ custo × 100 (nulo sem custo), os dois
 * com 2 casas, "meio para longe do zero". O custo é o **preço de custo** do cadastro (o do markup do formulário); sem
 * `produtos.ver_custo`, o custo, o lucro, o lucro % e o markup % vêm nulos.
 */
export interface LinhaProdutosGeral {
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  ativo: boolean;
  unidadeSigla: string;
  codigoInterno: string | null;
  /** O EAN principal (ou o primeiro código de barras). */
  codigoBarras: string | null;
  marcaNome: string | null;
  ncm: string | null;
  precoCusto: string | null;
  /** O preço de venda da loja escolhida (quando ela tem um próprio) ou o do produto. */
  precoVenda: string;
  precoAtacado: string | null;
  lucro: string | null;
  lucroPct: string | null;
  markupPct: string | null;
  /** Os caminhos das categorias (a principal primeiro), ex.: "BEBIDAS › CERVEJAS". */
  departamentos: string[];
}

export interface TotaisProdutosGeral {
  quantidadeProdutos: number;
  /** As médias simples do relatório inteiro (não da página), em decimal com 2 casas; nulas sem `produtos.ver_custo`. */
  mediaLucro: string | null;
  /** Média do lucro % dos produtos com venda > 0. */
  mediaLucroPct: string | null;
  /** Média do markup % dos produtos com custo > 0. */
  mediaMarkupPct: string | null;
}

export interface RespostaProdutosGeral {
  itens: LinhaProdutosGeral[];
  total: number;
  pagina: number;
  tamanho: number;
  totais: TotaisProdutosGeral;
}

// ---------------------------------------------------------------- NCMs inválidos (ERP 16.3)

/** Chave do relatório (rota `GET /relatorios/ncm-invalidos` e a da exportação, `…/exportar`). */
export const RELATORIO_NCM_INVALIDOS = 'ncm-invalidos';

/**
 * O motivo de o produto estar no relatório, nesta ordem de precedência: o NCM vazio, inexistente (fora da tabela
 * `ncms` ou excluído dela), fora de vigência (`vigencia_fim` no passado; a regra do `ncmVigente`) e, só com a tabela
 * `cests` carregada, o CEST incompatível (o CEST fora da tabela vigente ou o NCM fora da lista de NCMs do CEST).
 */
export const MOTIVOS_NCM_INVALIDO = ['vazio', 'inexistente', 'fora_vigencia', 'cest_incompativel'] as const;
export type MotivoNcmInvalido = (typeof MOTIVOS_NCM_INVALIDO)[number];
export const ROTULOS_MOTIVO_NCM_INVALIDO: Record<MotivoNcmInvalido, string> = {
  vazio: 'NCM vazio',
  inexistente: 'NCM inexistente',
  fora_vigencia: 'NCM fora de vigência',
  cest_incompativel: 'CEST incompatível',
};

/** Os filtros sem a página (o relatório não tem filtros, como no Nuvem3): os da exportação. */
export const filtrosNcmInvalidosSchema = z.object({});
export type FiltrosNcmInvalidos = z.output<typeof filtrosNcmInvalidosSchema>;

/** `GET /relatorios/ncm-invalidos`: só a página. */
export const consultaNcmInvalidosSchema = z.object(camposPagina);
export type ConsultaNcmInvalidos = z.output<typeof consultaNcmInvalidosSchema>;

export interface LinhaNcmInvalido {
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  /** A versão do cadastro inteiro (decisão 47): o "Definir NCM" a manda de volta (409 se mudou). */
  versao: number;
  ativo: boolean;
  codigoInterno: string | null;
  codigoBarras: string | null;
  ncm: string | null;
  cest: string | null;
  motivo: MotivoNcmInvalido;
  /** O porquê em texto ("Vigência até 31/12/2025", "O NCM não está na lista do CEST 0300100"). */
  detalhe: string | null;
}

export interface RespostaNcmInvalidos {
  itens: LinhaNcmInvalido[];
  total: number;
  pagina: number;
  tamanho: number;
  /** Quantos produtos por motivo, no relatório inteiro. */
  porMotivo: Record<MotivoNcmInvalido, number>;
  /** A tabela `cests` tem carga: sem ela, o motivo "CEST incompatível" não é conferido. */
  cestCarregado: boolean;
}

/**
 * Produtos por "Definir NCM" (uma página do relatório, a seleção é da página aberta). Cada produto passa pelo
 * `atualizarProduto` com a trava de ordenação presa: o teto segura o tempo da trava (como o do cadastro em massa).
 */
export const LIMITE_DEFINIR_NCM = 50;

/**
 * `POST /relatorios/ncm-invalidos/definir-ncm`: o NCM (8 dígitos, existente e vigente) para os produtos marcados, cada
 * um com a versão que o relatório mostrou. Tudo ou nada.
 */
export const definirNcmLoteSchema = z.object({
  ncm: z.string('Escolha o NCM').regex(/^\d{8}$/, 'NCM com 8 dígitos'),
  produtos: z
    .array(
      z.object({
        id: z.uuid('Produto inválido'),
        versao: z.coerce.number().int().min(0),
      }),
    )
    .min(1, 'Marque ao menos um produto')
    .max(LIMITE_DEFINIR_NCM, `No máximo ${LIMITE_DEFINIR_NCM} produtos por vez`)
    .refine((ps) => new Set(ps.map((p) => p.id.toLowerCase())).size === ps.length, {
      message: 'Produto repetido na lista',
    }),
});
export type DefinirNcmLoteEntrada = z.input<typeof definirNcmLoteSchema>;
export type DefinirNcmLote = z.output<typeof definirNcmLoteSchema>;

export interface ResultadoDefinirNcm {
  /** Os produtos gravados (cada um com a própria auditoria e versão nova). */
  atualizados: Array<{ id: string; codigo: number; nome: string }>;
  /** Os que já tinham o NCM (não regravados). */
  semMudanca: number;
}

// ---------------------------------------------------------------- Histórico de produtos (ERP 16.2)

/** Chave do relatório (rota `GET /relatorios/historico-produtos`). */
export const RELATORIO_HISTORICO_PRODUTOS = 'historico-produtos';

/**
 * A legenda do Nuvem3 e as letras novas (ERP 16.2): **G** = Gravação (a criação ou a alteração do cadastro), **E** =
 * Exclusão, **R** = Restauração e **I** = Importação (a gravação que veio da planilha, origem `importacao`).
 */
export const TIPOS_HISTORICO_PRODUTO = ['G', 'E', 'R', 'I'] as const;
export type TipoHistoricoProduto = (typeof TIPOS_HISTORICO_PRODUTO)[number];
export const ROTULOS_TIPO_HISTORICO_PRODUTO: Record<TipoHistoricoProduto, string> = {
  G: 'Gravação (criação ou alteração)',
  E: 'Exclusão',
  R: 'Restauração',
  I: 'Importação',
};

/**
 * Maior período do relatório, contando os dois dias das pontas (o da Movimentação). A auditoria é particionada por mês
 * (MD 3.1.7): o período é obrigatório e a consulta só lê as partições dele.
 */
export const MAXIMO_DIAS_HISTORICO_PRODUTOS = 366;

/** A data `AAAA-MM-DD` existe no calendário (o `Date.parse` aceita 30/02 e devolve 02/03). */
const dataDoCalendario = (d: unknown): d is string =>
  typeof d === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/**
 * `GET /relatorios/historico-produtos`: o **período** obrigatório (`dataInicial`..`dataFinal`, dias de calendário no
 * fuso da empresa, as pontas incluídas, até `MAXIMO_DIAS_HISTORICO_PRODUTOS`), o **histórico** (texto contido na
 * descrição gravada), o **usuário**, o **tipo** (G/E/R/I), o **produto** e a página. A ordem é fixa: o mais recente
 * primeiro.
 */
export const consultaHistoricoProdutosSchema = z
  .object({
    dataInicial: z.preprocess(vazioIndefinido, z.iso.date('Informe a data inicial')),
    dataFinal: z.preprocess(vazioIndefinido, z.iso.date('Informe a data final')),
    texto: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : vazioIndefinido(v)),
      z.string().trim().max(100).optional(),
    ),
    usuarioId: uuidOpcional,
    tipo: z.preprocess(vazioIndefinido, z.enum(TIPOS_HISTORICO_PRODUTO, 'Tipo inválido').optional()),
    produtoId: uuidOpcional,
    ...camposPagina,
  })
  .superRefine((v, ctx) => {
    // As datas inválidas já têm o erro do campo (o zod 4 roda o refinamento mesmo assim).
    if (!dataDoCalendario(v.dataInicial) || !dataDoCalendario(v.dataFinal)) return;
    const dias = Math.round(
      (Date.parse(`${v.dataFinal}T00:00:00Z`) - Date.parse(`${v.dataInicial}T00:00:00Z`)) / 86_400_000,
    );
    if (dias < 0)
      ctx.addIssue({ code: 'custom', path: ['dataFinal'], message: 'A data final é anterior à inicial' });
    else if (dias + 1 > MAXIMO_DIAS_HISTORICO_PRODUTOS)
      ctx.addIssue({
        code: 'custom',
        path: ['dataFinal'],
        message: `O período vai até ${MAXIMO_DIAS_HISTORICO_PRODUTOS} dias`,
      });
  });
export type ConsultaHistoricoProdutos = z.output<typeof consultaHistoricoProdutosSchema>;

/**
 * Uma linha do Histórico de produtos: uma linha da auditoria do produto. `historico` é o texto legível das
 * diferenças ("Preço de venda: 9,90 → 10,90; EAN adicionado 7891234567895") montado **para quem consulta**: o custo
 * só com `produtos.ver_custo` e o que é de loja (o preço da loja, a faixa da loja, o lote de um estoque) só das lojas
 * e dos estoques permitidos.
 */
export interface LinhaHistoricoProduto {
  id: string;
  /** Instante do fato (ISO 8601); com o `id`, a chave do "ver diferença completa". */
  ocorridoEm: string;
  usuarioId: string | null;
  usuarioNome: string | null;
  tipo: TipoHistoricoProduto;
  /** A ação da auditoria (`criar`, `editar`, `excluir`, `restaurar`, `importar`). */
  acao: string;
  /** De onde veio, mapeado ("Cad. prod.", "Cadastro em massa", "Importação", "Recebimento", "NF-e", "API", "PDV"). */
  localizacao: string;
  /** O produto (também o excluído, marcado); `null` se a linha não aponta para um. */
  produto: { id: string; codigo: number; nome: string; excluido: boolean } | null;
  historico: string;
}

export interface RespostaHistoricoProdutos {
  itens: LinhaHistoricoProduto[];
  total: number;
  pagina: number;
  tamanho: number;
}

/** `GET /relatorios/historico-produtos/:id`: o instante da linha (o `ocorridoEm` dela), que escolhe a partição. */
export const detalheHistoricoProdutoSchema = z.object({
  ocorridoEm: z.iso.datetime({ offset: true, message: 'Informe o instante da linha (ocorridoEm)' }),
});

/** Um campo do "ver diferença completa": o rótulo (com a filha: "Loja Centro › Preço de venda"), antes e depois. */
export interface AlteracaoHistoricoProduto {
  campo: string;
  antes: string;
  depois: string;
}

/** O "ver diferença completa": a linha e todos os campos que mudaram, com o mesmo corte de custo e de loja. */
export interface DetalheHistoricoProduto extends LinhaHistoricoProduto {
  alteracoes: AlteracaoHistoricoProduto[];
}
