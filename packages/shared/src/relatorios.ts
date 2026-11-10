/**
 * Relatórios de estoque (ERP 16.4; Fase 2, F2-B31): o **Estoque Atual** — saldo por estoque × tipo × produto com o
 * custo, as pendências da transferência, o "Vencendo em N dias" pelos lotes, o "Todas" (a soma dos estoques
 * permitidos) e a data-base "Saldo em <data>" pelo razão — e o modal de ajuste no clique do saldo (um "Definir" de um
 * item, origem `relatorio_estoque`, movimento `AJUSTE_RELATORIO`); e a **Movimentação de Estoque** (ERP 16.5): a
 * visão analítica, um movimento por linha, paginada por cursor (F2-B32), e a sintética por produto, com a última compra,
 * paginada por página, e a exportação das duas (F2-B33).
 */
import { z } from 'zod';
import { ajusteEstoqueProdutoSchema, SITUACOES_SALDO } from './estoque.js';
import { paginacaoQuerySchema, TAMANHOS_PAGINA } from './paginacao.js';
import { FILTROS_TREINO } from './vendas.js';

const vazioIndefinido = (v: unknown) => (v === '' || v === null ? undefined : v);
const uuidOpcional = z.preprocess(vazioIndefinido, z.uuid().optional());

/** Chave do relatório na rota comum da exportação (`GET /relatorios/estoque-atual/exportar`, F2-B29). */
export const RELATORIO_ESTOQUE_ATUAL = 'estoque-atual';

export const ORDENACOES_ESTOQUE_ATUAL = [
  'produto',
  'codigo_interno',
  'estoque',
  'quantidade',
  'custo_medio',
  'custo_total',
  'venda_total',
] as const;

/** Maior "Vencendo em N dias" aceito (10 anos). */
export const MAXIMO_DIAS_VENCENDO = 3650;

/**
 * Filtros do Estoque Atual (ERP 16.4). `estoqueId` vazio ou `todas` = **Todas**: uma linha por produto × tipo com a
 * soma dos estoques permitidos (sem a loja de treino, salvo o filtro `treino`; D39). `dataBase` (`AAAA-MM-DD`, até
 * hoje) = "Saldo em <data>": o saldo no fim do dia, no fuso da empresa, recalculado pelo razão (sem ajuste nesse
 * modo); não combina com o "Vencendo", que é dos lotes de hoje.
 */
const camposFiltro = {
  /** Nome, código interno ou EAN. */
  nome: z.string().trim().max(120).optional(),
  marcaId: uuidOpcional,
  /** Departamento: a categoria e as filhas (árvore). */
  categoriaId: uuidOpcional,
  estoqueId: z.preprocess((v) => (v === 'todas' ? undefined : vazioIndefinido(v)), z.uuid().optional()),
  tipoEstoqueId: uuidOpcional,
  /** Um produto só (o saldo dos tipos do produto no modal de ajuste). */
  produtoId: uuidOpcional,
  situacaoSaldo: z.preprocess(vazioIndefinido, z.enum(SITUACOES_SALDO).default('todos')),
  situacao: z.preprocess(vazioIndefinido, z.enum(['ativos', 'inativos', 'todos']).default('ativos')),
  /** A loja de treino no "Todas" (D39): fora por padrão; o estoque escolhido aparece mesmo sendo de treino. */
  treino: z.preprocess(vazioIndefinido, z.enum(FILTROS_TREINO).default('excluir')),
  /** Só os produtos com lote de validade até hoje + N dias (inclusive os já vencidos) com saldo no estoque × tipo. */
  vencendoEmDias: z.preprocess(
    vazioIndefinido,
    z.coerce
      .number('Informe o número de dias')
      .int('Informe um número inteiro de dias')
      .min(0, 'Informe 0 ou mais dias')
      .max(MAXIMO_DIAS_VENCENDO, `No máximo ${MAXIMO_DIAS_VENCENDO} dias`)
      .optional(),
  ),
  dataBase: z.preprocess(vazioIndefinido, z.iso.date('Data inválida').optional()),
  ordenar: paginacaoQuerySchema.shape.ordenar,
};

function regrasFiltro(v: { dataBase?: string; vencendoEmDias?: number }, ctx: z.RefinementCtx): void {
  if (v.dataBase && v.vencendoEmDias !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['vencendoEmDias'],
      message: 'O "Vencendo" é dos lotes de hoje: tire a data-base para usá-lo',
    });
}

/** Os filtros sem a página: os da exportação (`tarefas.parametros` guarda a entrada crua, validada de novo). */
export const filtrosEstoqueAtualSchema = z.object(camposFiltro).superRefine(regrasFiltro);
export type FiltrosEstoqueAtual = z.output<typeof filtrosEstoqueAtualSchema>;

/** `GET /relatorios/estoque-atual`: os filtros e a página. */
export const consultaEstoqueAtualSchema = paginacaoQuerySchema.extend(camposFiltro).superRefine(regrasFiltro);
export type ConsultaEstoqueAtual = z.output<typeof consultaEstoqueAtualSchema>;

export interface LinhaEstoqueAtual {
  /** `estoqueId|todas:produtoId:variacaoId:tipoEstoqueId`. */
  chave: string;
  /** `null` no "Todas" (a soma dos estoques permitidos). */
  estoqueId: string | null;
  estoqueNome: string;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  /** Nulo enquanto as variações estão travadas (D43). */
  variacaoId: string | null;
  codigoInterno: string | null;
  marcaNome: string | null;
  unidadeSigla: string;
  /** Saldo (`numeric(15,3)` em texto); na data-base, o do fim do dia. */
  quantidade: string;
  /** Em trânsito para o estoque (F2-B26); `null` na data-base (só existe o de hoje). */
  emTransito: string | null;
  /** Divergência a tratar na origem (F2-B26); `null` na data-base. */
  divergenciaATratar: string | null;
  estoqueMinimo: string | null;
  /** Custo médio (no "Todas", a média ponderada pelos saldos positivos); `null` sem `produtos.ver_custo`. */
  custoMedio: string | null;
  custoTotal: string | null;
  /** Preço de venda da loja do estoque (o do produto no "Todas"). */
  precoVenda: string;
  precoAtacado: string | null;
  precoIfood: string | null;
  vendaTotal: string;
  /** Com o filtro "Vencendo": o saldo dos lotes que vencem até o limite e a validade mais próxima. */
  vencendo: { quantidade: string; validade: string } | null;
}

export interface RespostaEstoqueAtual {
  itens: LinhaEstoqueAtual[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
  totais: { quantidadeItens: number; custoTotal: string | null; vendaTotal: string };
  /** A data-base usada (`AAAA-MM-DD`) ou `null` no saldo de agora. */
  dataBase: string | null;
}

/**
 * Modal de ajuste do Estoque Atual (ERP 16.4, 13.6): o "Ajustar" do produto (F2-B12) com o produto da linha — cria e
 * efetiva um "Definir" de um item com a origem `relatorio_estoque` (AJUSTE_RELATORIO), na hora da contagem (padrão:
 * agora), com a regra do saldo negativo e a compensação das vendas tardias. Resposta: `ResultadoAjusteProduto`.
 */
export const ajusteEstoqueRelatorioSchema = ajusteEstoqueProdutoSchema.extend({
  produtoId: z.uuid('Escolha o produto'),
});
export type AjusteEstoqueRelatorioEntrada = z.input<typeof ajusteEstoqueRelatorioSchema>;
export type AjusteEstoqueRelatorio = z.output<typeof ajusteEstoqueRelatorioSchema>;

// ---------------------------------------------------------------- Movimentação de Estoque (ERP 16.5; F2-B32)

/** Chave do relatório (rota `GET /relatorios/movimentacao-estoque` e a da exportação, `…/exportar`). */
export const RELATORIO_MOVIMENTACAO_ESTOQUE = 'movimentacao-estoque';

/** Maior período da Movimentação (ERP 16.5: "máx. 366 dias", contando os dois dias das pontas). */
export const MAXIMO_DIAS_MOVIMENTACAO = 366;

/** Tamanho padrão da página da Movimentação (a do `<Relatorio>`). */
export const TAMANHO_PADRAO_MOVIMENTACAO = 50;

/** Documentos de origem do movimento (`movimentos_estoque.documento_tipo`, MD 3.7.2): o filtro "Documento". */
export const DOCUMENTOS_MOVIMENTACAO = [
  'venda',
  'troca',
  'acerto',
  'recebimento',
  'nota_entrada',
  'transferencia',
  'vasilhame',
] as const;
export type DocumentoMovimentacao = (typeof DOCUMENTOS_MOVIMENTACAO)[number];
export const ROTULOS_DOCUMENTO_MOVIMENTACAO: Record<DocumentoMovimentacao, string> = {
  venda: 'Venda',
  troca: 'Troca/devolução',
  acerto: 'Acerto de estoque',
  recebimento: 'Recebimento manual',
  nota_entrada: 'Nota de entrada (NF-e)',
  transferencia: 'Transferência',
  vasilhame: 'Vasilhame',
};
/** Os documentos que têm número para o filtro (troca e vasilhame não têm um número próprio). */
export const DOCUMENTOS_COM_NUMERO: readonly DocumentoMovimentacao[] = [
  'venda',
  'acerto',
  'recebimento',
  'nota_entrada',
  'transferencia',
];

/** Tipo de movimento (`GET /referencias/tipos-movimento-estoque`; MD 3.7.1, seed 7.3). */
export interface TipoMovimentoEstoqueOpcao {
  codigo: string;
  nome: string;
  /** `1` entrada, `-1` saída, `0` qualquer. */
  sinal: -1 | 0 | 1;
  documentoTipo: string;
  /** `idmovimentacaoestoquetipo` do Nuvem3, quando confirmado no levantamento (só o 28). */
  idNuvem3: number | null;
  ativo: boolean;
}

/** A data `AAAA-MM-DD` existe no calendário (o `Date.parse` aceita 30/02 e devolve 02/03). */
const dataExiste = (d: unknown): d is string =>
  typeof d === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
  new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/** Diferença em dias entre duas datas `AAAA-MM-DD` (calendário, sem fuso). */
function diasEntre(inicial: string, final: string): number {
  return Math.round((Date.parse(`${final}T00:00:00Z`) - Date.parse(`${inicial}T00:00:00Z`)) / 86_400_000);
}

/** Lista da query (`a,b` ou `?t=a&t=b`), sem vazios nem repetidos. */
const listaDaQuery = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  const itens = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  return itens.length ? [...new Set(itens)] : undefined;
};

/**
 * Filtros da Movimentação (ERP 16.5). **Local de estoque** e **período** (`dataInicial`..`dataFinal`, dias de
 * calendário no fuso da empresa, até `MAXIMO_DIAS_MOVIMENTACAO` contando as pontas) obrigatórios; produto, tipos de
 * movimento (multisseleção, `tiposMovimento=VENDA_PDV,RECEB_NFE`), usuário, documento (tipo e, opcional, o número
 * mostrado na coluna Documento) e pessoa (`movimentos_estoque.pessoa_id`: o cliente — da venda, da troca, dos cascos
 * devolvidos, da venda compensada — ou o fornecedor do recebimento e da nota) opcionais.
 */
const camposMovimentacao = {
  estoqueId: z.preprocess(vazioIndefinido, z.uuid('Escolha o local de estoque')),
  dataInicial: z.preprocess(vazioIndefinido, z.iso.date('Informe a data inicial')),
  dataFinal: z.preprocess(vazioIndefinido, z.iso.date('Informe a data final')),
  produtoId: uuidOpcional,
  tiposMovimento: z.preprocess(
    listaDaQuery,
    z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,29}$/, 'Tipo de movimento inválido'))
      .max(50, 'No máximo 50 tipos de movimento')
      .optional(),
  ),
  usuarioId: uuidOpcional,
  pessoaId: uuidOpcional,
  documentoTipo: z.preprocess(vazioIndefinido, z.enum(DOCUMENTOS_MOVIMENTACAO).optional()),
  /** O número do documento (o da coluna Documento): `numero_exibicao` da venda, o `codigo` dos demais, o Nº da NF-e. */
  documentoNumero: z.preprocess(vazioIndefinido, z.string().trim().max(30).optional()),
};

function regrasMovimentacao(
  v: { dataInicial: string; dataFinal: string; documentoTipo?: string; documentoNumero?: string },
  ctx: z.RefinementCtx,
): void {
  // As datas inválidas já têm o erro do campo (o zod 4 roda o refinamento mesmo assim).
  const dias =
    dataExiste(v.dataInicial) && dataExiste(v.dataFinal) ? diasEntre(v.dataInicial, v.dataFinal) : 0;
  if (dias < 0)
    ctx.addIssue({ code: 'custom', path: ['dataFinal'], message: 'A data final é anterior à inicial' });
  else if (dias + 1 > MAXIMO_DIAS_MOVIMENTACAO)
    ctx.addIssue({
      code: 'custom',
      path: ['dataFinal'],
      message: `O período vai até ${MAXIMO_DIAS_MOVIMENTACAO} dias`,
    });
  if (v.documentoNumero && !v.documentoTipo)
    ctx.addIssue({ code: 'custom', path: ['documentoTipo'], message: 'Escolha o tipo do documento' });
  else if (v.documentoNumero && !(DOCUMENTOS_COM_NUMERO as readonly string[]).includes(v.documentoTipo ?? ''))
    ctx.addIssue({
      code: 'custom',
      path: ['documentoNumero'],
      message: 'Este tipo de documento não tem número: filtre só pelo tipo',
    });
}

/** Os filtros sem a página (os das duas visões; a exportação acrescenta a `visao`). */
export const filtrosMovimentacaoEstoqueSchema = z.object(camposMovimentacao).superRefine(regrasMovimentacao);
export type FiltrosMovimentacaoEstoque = z.output<typeof filtrosMovimentacaoEstoqueSchema>;

/**
 * Visões da Movimentação (ERP 16.5): a **analítica** (um movimento por linha) e a **sintética por produto** (uma linha
 * por produto × variação × tipo de estoque, com o saldo inicial e o final, as entradas e as saídas, os custos e a última
 * compra; F2-B33).
 */
export const VISOES_MOVIMENTACAO = ['analitica', 'sintetica'] as const;
export type VisaoMovimentacao = (typeof VISOES_MOVIMENTACAO)[number];
export const ROTULOS_VISAO_MOVIMENTACAO: Record<VisaoMovimentacao, string> = {
  analitica: 'Analítica (um movimento por linha)',
  sintetica: 'Sintética por produto',
};

/**
 * Filtros da exportação (`GET /relatorios/movimentacao-estoque/exportar`, F2-B33): os da tela e a **visão** (padrão:
 * a analítica), que escolhe as colunas e a consulta. `tarefas.parametros` guarda a entrada crua (validada de novo na
 * execução).
 */
export const exportacaoMovimentacaoEstoqueSchema = z
  .object({
    ...camposMovimentacao,
    visao: z.preprocess(vazioIndefinido, z.enum(VISOES_MOVIMENTACAO).default('analitica')),
  })
  .superRefine(regrasMovimentacao);
export type FiltrosExportacaoMovimentacao = z.output<typeof exportacaoMovimentacaoEstoqueSchema>;

/**
 * `GET /relatorios/movimentacao-estoque`: os filtros, o `tamanho` (os da página, `TAMANHOS_PAGINA`) e o `cursor`
 * opaco da próxima página (`proximoCursor` da resposta; vazio na primeira). Sem `pagina` nem total: o razão de um ano
 * passa de um milhão de linhas, e a página sai do índice `(estoque_id, data_movimento, id)` sem contar (decisão 176).
 */
export const consultaMovimentacaoEstoqueSchema = z
  .object({
    ...camposMovimentacao,
    tamanho: z.preprocess(
      vazioIndefinido,
      z.coerce
        .number()
        .int()
        .refine((t) => (TAMANHOS_PAGINA as readonly number[]).includes(t), {
          message: `Tamanho de página inválido (${TAMANHOS_PAGINA.join(', ')})`,
        })
        .default(TAMANHO_PADRAO_MOVIMENTACAO),
    ),
    cursor: z.preprocess(vazioIndefinido, z.string().max(200).optional()),
  })
  .superRefine(regrasMovimentacao);
export type ConsultaMovimentacaoEstoque = z.output<typeof consultaMovimentacaoEstoqueSchema>;

/** Uma linha da visão analítica: um movimento (colunas do export do Nuvem3 + custo, documento e fornecedor). */
export interface LinhaMovimentacaoEstoque {
  /** `idmovimentacaoestoque`. */
  id: string;
  /** `DataHora` (ISO, com os microssegundos do banco). */
  dataMovimento: string;
  produtoId: string;
  produtoCodigo: number;
  /** `CodigoInterno`. */
  codigoInterno: string | null;
  /** `NomeProduto`. */
  produtoNome: string;
  variacaoId: string | null;
  /** `nomeVariacao`. */
  variacaoNome: string | null;
  /** `TipoMovimento` (código e nome, 13.1.3). */
  tipoMovimento: string;
  tipoMovimentoNome: string;
  /** `idmovimentacaoestoquetipo`: `tipos_movimento_estoque.id_nuvem3` (nulo quando não confirmado). */
  idNuvem3: number | null;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  /** `Estoque`. */
  estoqueNome: string;
  /** `nomeLoja`: a loja do documento. */
  lojaNome: string | null;
  /**
   * `EstoqueAnterior`/`EstoqueAtual` **recalculados** na ordem de `data_movimento` (a soma do razão da linha de saldo
   * antes do movimento, e com ele): podem diferir dos gravados (na ordem de lançamento) por causa das vendas offline
   * que chegam tarde e dos lançamentos com data no passado.
   */
  saldoAnterior: string;
  /** `QtdMovimentada` (com sinal, na unidade base). */
  quantidade: string;
  saldoPosterior: string;
  /** Os gravados no lançamento (`movimentos_estoque.saldo_anterior`/`saldo_posterior`). */
  saldoAnteriorGravado: string;
  saldoPosteriorGravado: string;
  /**
   * `sigla`: a unidade do documento (sem ela, a do produto), como no export do Nuvem3. A quantidade e os saldos
   * **não** estão nela: estão na `unidadeBase` (o recebimento de 2 CX com fator 12 grava 24 e `sigla` = CX).
   */
  sigla: string;
  /** A sigla da unidade do produto: a de `quantidade` e dos saldos. */
  unidadeBase: string;
  /** O fator da unidade do documento (`movimentos_estoque.fator`; 1 na unidade base): a quantidade = documento × fator. */
  fator: string;
  /** `Usuario`. */
  usuarioNome: string | null;
  /** `CustoUnitario`/`CustoTotal` gravados no movimento; `null` sem `produtos.ver_custo`. */
  custoUnitario: string | null;
  custoTotal: string | null;
  /** Documento de origem: tipo, id (o link) e o número mostrado; `idvenda` é o `id` da venda. */
  documento: { tipo: DocumentoMovimentacao; id: string | null; numero: string | null };
  /**
   * `PessoaVenda`: o cliente (`movimentos_estoque.pessoa_id` fora do recebimento e da nota): o da venda e o da troca,
   * o da devolução avulsa de cascos e o da venda compensada por um "Definir" (`ACERTO_COMPENSACAO`).
   */
  pessoaVenda: string | null;
  /** `fornecedornf`: o fornecedor do recebimento ou da nota (no Nuvem3 vinha vazio). */
  fornecedor: string | null;
  observacao: string | null;
}

export interface RespostaMovimentacaoEstoque {
  itens: LinhaMovimentacaoEstoque[];
  /** O cursor da próxima página; `null` na última. */
  proximoCursor: string | null;
  tamanho: number;
  /** Os nomes do que os filtros escolheram por id (o seletor reaberto pelo link mostra o nome). */
  referencias: {
    estoque: { id: string; nome: string };
    produto: { id: string; codigo: number; nome: string } | null;
    pessoa: { id: string; codigo: number; nome: string } | null;
  };
}

/**
 * `GET /relatorios/movimentacao-estoque/sintetica` (F2-B33): os filtros da Movimentação e a página (`pagina`, `tamanho`
 * de `TAMANHOS_PAGINA`, padrão 50). Paginada por página com o total: a visão tem uma linha por produto × variação × tipo
 * com movimento no período (milhares numa loja, não milhões), e o total e os totais saem na mesma ida ao banco.
 */
export const consultaMovimentacaoSinteticaSchema = z
  .object({
    ...camposMovimentacao,
    pagina: z.preprocess(vazioIndefinido, z.coerce.number().int().min(1).default(1)),
    tamanho: z.preprocess(
      vazioIndefinido,
      z.coerce
        .number()
        .int()
        .refine((t) => (TAMANHOS_PAGINA as readonly number[]).includes(t), {
          message: `Tamanho de página inválido (${TAMANHOS_PAGINA.join(', ')})`,
        })
        .default(TAMANHO_PADRAO_MOVIMENTACAO),
    ),
  })
  .superRefine(regrasMovimentacao);
export type ConsultaMovimentacaoSintetica = z.output<typeof consultaMovimentacaoSinteticaSchema>;

/**
 * Uma linha da visão sintética (ERP 16.5, "Sintética por produto"): a linha de saldo (produto × variação × tipo de
 * estoque) do local com movimento no período (nos filtros). O saldo inicial é a soma do razão da linha antes do começo
 * do período e o final a soma até o fim, com ou sem filtro; as entradas e as saídas, as somas das quantidades positivas
 * e das negativas. **Sem filtro de movimento, fecha com a analítica**: o saldo inicial é o `saldoAnterior` do primeiro
 * movimento da linha no período e o final o `saldoPosterior` do último. Com filtro de tipo, usuário, documento ou
 * pessoa, as entradas, as saídas, os movimentos e os custos são só os dos movimentos filtrados (e fecham com a analítica
 * filtrada), mas os saldos continuam os do começo e do fim do período: não são o `saldoAnterior` do primeiro movimento
 * filtrado nem o `saldoPosterior` do último (estes incluem os movimentos escondidos), e o final deixa de ser o inicial
 * + entradas − saídas.
 */
export interface LinhaMovimentacaoSintetica {
  /** `produtoId:variacaoId:tipoEstoqueId`. */
  chave: string;
  produtoId: string;
  produtoCodigo: number;
  codigoInterno: string | null;
  produtoNome: string;
  variacaoId: string | null;
  variacaoNome: string | null;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  /** A sigla da unidade do produto (a das quantidades e dos saldos). */
  unidadeBase: string;
  saldoInicial: string;
  /** Soma das entradas (quantidades positivas), na unidade base. */
  entradas: string;
  /** Soma das saídas **sem o sinal** (as quantidades negativas): 3 saídas de 2 são `6.000`. */
  saidas: string;
  saldoFinal: string;
  /** Movimentos da linha no período (nos filtros). */
  movimentos: number;
  /** Σ `custo_total` das entradas e das saídas (o custo gravado, sem sinal); `null` sem `produtos.ver_custo`. */
  custoEntradas: string | null;
  custoSaidas: string | null;
  /**
   * A última compra do produto (e da variação) **no local** até o fim do período: o último `RECEB_MANUAL` ou
   * `RECEB_NFE` (entrada, não estorno) pela data do movimento, em qualquer tipo de estoque e fora dos filtros. A data
   * (ISO) e o custo unitário dela (`null` sem `produtos.ver_custo`); `null` sem compra até lá.
   */
  ultimaCompraEm: string | null;
  ultimoCusto: string | null;
}

export interface RespostaMovimentacaoSintetica {
  itens: LinhaMovimentacaoSintetica[];
  total: number;
  pagina: number;
  tamanho: number;
  /** Os custos do relatório inteiro (não da página); `null` sem `produtos.ver_custo`. */
  totais: { custoEntradas: string; custoSaidas: string } | null;
  referencias: RespostaMovimentacaoEstoque['referencias'];
}

/**
 * **EAN duplicado** (Fase 2, F2-B38; MD 3.6.5; ERP 8.2 "Regras", 20 item 2): os códigos de barras `gtin` que estão em
 * mais de um produto não excluído (`group by codigo having count(distinct produto_id) > 1`), com os produtos de cada
 * um. É o relatório que a migração do Nuvem3 deixa para corrigir antes de voltar `geral.ean_duplicado` a "bloquear".
 * Chave da rota comum da exportação: `GET /relatorios/ean-duplicado/exportar`.
 */
export const RELATORIO_EAN_DUPLICADO = 'ean-duplicado';

const camposEanDuplicado = {
  /** Começo do código de barras (só dígitos). */
  ean: z.preprocess(
    vazioIndefinido,
    z
      .string()
      .trim()
      .regex(/^\d{1,14}$/, 'Informe só os dígitos do código de barras (até 14)')
      .optional(),
  ),
  /** Nome, código interno ou EAN de algum dos produtos do código (o código continua com todos os produtos). */
  nome: z.preprocess(vazioIndefinido, z.string().trim().max(120).optional()),
};

/** Os filtros sem a página: os da exportação (`tarefas.parametros` guarda a entrada crua, validada de novo). */
export const filtrosEanDuplicadoSchema = z.object(camposEanDuplicado);
export type FiltrosEanDuplicado = z.output<typeof filtrosEanDuplicadoSchema>;

/** `GET /relatorios/ean-duplicado`: os filtros e a página (`tamanho` de `TAMANHOS_PAGINA`, padrão 50). */
export const consultaEanDuplicadoSchema = z.object({
  ...camposEanDuplicado,
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
});
export type ConsultaEanDuplicado = z.output<typeof consultaEanDuplicadoSchema>;

/** Um produto (ou variação) com o código repetido. */
export interface ProdutoEanDuplicado {
  /** Id da linha de `produtos_codigos_barras` (o mesmo produto pode ter o código no pai e numa variação). */
  codigoBarrasId: string;
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  codigoInterno: string | null;
  marcaNome: string | null;
  ativo: boolean;
  variacaoId: string | null;
  variacaoNome: string | null;
  /** O EAN principal do produto (o da listagem) ou um código a mais (embalagem, fardo). */
  principal: boolean;
  /** Descrição da embalagem ("Fardo 12") e o fator (`numeric(15,3)` em texto) com a sigla da unidade do código. */
  descricao: string | null;
  fator: string;
  unidadeSigla: string;
}

export interface LinhaEanDuplicado {
  codigo: string;
  /** Produtos distintos com o código (2 ou mais). */
  quantidadeProdutos: number;
  produtos: ProdutoEanDuplicado[];
}

export interface RespostaEanDuplicado {
  itens: LinhaEanDuplicado[];
  /** Códigos repetidos com os filtros (sem filtro, o que falta zerar para voltar a "bloquear"). */
  total: number;
  pagina: number;
  tamanho: number;
  /** `geral.ean_duplicado` de agora: a tela lembra de voltar a "bloquear" quando o relatório zerar. */
  modo: 'bloquear' | 'avisar';
}
