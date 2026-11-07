/**
 * Relatórios de estoque (ERP 16.4; Fase 2, F2-B31): o **Estoque Atual** — saldo por estoque × tipo × produto com o
 * custo, as pendências da transferência, o "Vencendo em N dias" pelos lotes, o "Todas" (a soma dos estoques
 * permitidos) e a data-base "Saldo em <data>" pelo razão — e o modal de ajuste no clique do saldo (um "Definir" de um
 * item, origem `relatorio_estoque`, movimento `AJUSTE_RELATORIO`).
 */
import { z } from 'zod';
import { ajusteEstoqueProdutoSchema, SITUACOES_SALDO } from './estoque.js';
import { paginacaoQuerySchema } from './paginacao.js';
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
