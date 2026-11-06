/**
 * Transferência de estoque em duas etapas (ERP 13.7; MD 3.7.6; Fase 2, F2-B22): o documento que leva mercadoria de um
 * estoque da empresa a outro (CD ⇄ loja, loja ⇄ loja), rascunho → em trânsito → recebida (ou recebida com divergência
 * → recebida), ou cancelada. Este arquivo tem os contratos do rascunho, das etapas (enviar, receber, tratar a
 * divergência, cancelar), da NF-e emitida por fora, dos filtros, da sugestão de reposição e as respostas, com as
 * regras puras da situação. Os endpoints entram nos F2-B23 (rascunho, enviar, cancelar), F2-B24 (receber, tratar
 * divergência), F2-B25 (sugestão) e F2-B26 (em trânsito); as telas, no F2-B27.
 *
 * Quantidades na unidade do produto, com 3 casas (ADR-05); o custo, com 4 (`numeric(15,4)`).
 */
import { z } from 'zod';
import {
  dataCampo,
  dataOpcionalValida,
  decimal,
  textoObrigatorio,
  textoOpcional,
  type MetadadosRegistro,
} from './campos.js';
import { dec, decTexto, type Valor } from './decimal.js';
import type { TIPOS_ESTOQUE_LOCAL } from './enums.js';
import { paginacaoQuerySchema } from './paginacao.js';
import type { ProdutoOpcao } from './produtos.js';
import { validarChaveAcesso } from './validadores.js';

// ---------------------------------------------------------------- Situações e tratamentos

export const STATUS_TRANSFERENCIA = [
  'rascunho',
  'em_transito',
  'recebida',
  'recebida_divergencia',
  'cancelada',
] as const;
export type StatusTransferencia = (typeof STATUS_TRANSFERENCIA)[number];
/** ERP 13.7, filtro e coluna "Situação". */
export const ROTULOS_STATUS_TRANSFERENCIA: Record<StatusTransferencia, string> = {
  rascunho: 'Rascunho',
  em_transito: 'Em trânsito',
  recebida: 'Recebida',
  recebida_divergencia: 'Recebida com divergência',
  cancelada: 'Cancelada',
};

/**
 * As transições do diagrama do ERP 13.7, iguais às do trigger `tg_transferencias_estoque_etapa` (migração
 * `0025_transferencias`): Enviar (rascunho → em trânsito), Receber (em trânsito → recebida ou recebida com
 * divergência), tratar a diferença (recebida com divergência → recebida) e Cancelar (do rascunho, sem efeito no
 * estoque, ou do trânsito, com o `TRANSF_RETORNO` integral). Recebida e cancelada são o fim: a recebida não se cancela
 * (faz-se uma transferência inversa).
 */
export const TRANSICOES_TRANSFERENCIA: Record<StatusTransferencia, readonly StatusTransferencia[]> = {
  rascunho: ['em_transito', 'cancelada'],
  em_transito: ['recebida', 'recebida_divergencia', 'cancelada'],
  recebida_divergencia: ['recebida'],
  recebida: [],
  cancelada: [],
};

export function podeTransitarTransferencia(de: StatusTransferencia, para: StatusTransferencia): boolean {
  return TRANSICOES_TRANSFERENCIA[de].includes(para);
}

/**
 * O que fazer com a diferença recebida a menor (ERP 13.7 "Divergência"; F2-Q10 = D51, padrão até a confirmação do
 * dono): `retorno_origem` devolve a diferença à origem (`TRANSF_RETORNO`); `perda` devolve e baixa na hora como perda
 * (`TRANSF_RETORNO` + acerto de saída na origem com a origem `perda_transferencia`): o saldo da origem não muda e a
 * perda fica registrada a custo.
 */
export const TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA = ['retorno_origem', 'perda'] as const;
export type TratamentoDivergenciaTransferencia = (typeof TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA)[number];
export const ROTULOS_TRATAMENTO_DIVERGENCIA: Record<TratamentoDivergenciaTransferencia, string> = {
  retorno_origem: 'Retornar à origem',
  perda: 'Baixar como perda',
};

/** Motivo do acerto de saída automático da perda (ERP 13.7; o acerto leva `origem_id` = a transferência). */
export const MOTIVO_PERDA_TRANSFERENCIA = 'Perda em transferência';

/**
 * Itens por transferência: o teto de itens da NF-e (990, MOC), o mesmo do recebimento — a transferência entre CNPJs
 * diferentes vira uma NF-e de transferência na fase fiscal, e o documento já cabe numa só.
 */
export const LIMITE_ITENS_TRANSFERENCIA = 990;

/**
 * Teto da quantidade digitada (cabe em `numeric(15,3)` com folga, como no recebimento); o banco recusa a recebida
 * acima da enviada (`ck_itens_transferencia_quantidades`) e a API confere antes, com o erro no item.
 */
const MAXIMO_QUANTIDADE = 999_999_999;

const idOpcional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.uuid().nullable().default(null),
);
const quantidadeCampo = decimal({
  min: 0,
  max: MAXIMO_QUANTIDADE,
  casas: 3,
  mensagem: 'Quantidade inválida',
});

/**
 * Chave de acesso da NF-e de transferência emitida por fora (Nuvem3/contador; D6): opcional, sem espaços, em
 * maiúsculas (o CNPJ alfanumérico) e com o DV conferido. O Genesis só anota: não emite nem consulta (nada fiscal).
 */
const chaveNfeExterna = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(/\s/g, '').toUpperCase() || null : (v ?? null)),
  z
    .string()
    .refine(validarChaveAcesso, 'Chave de acesso inválida (44 dígitos, confira o dígito verificador)')
    .nullable()
    .default(null),
);
const camposNfeExterna = {
  nfeExternaChave: chaveNfeExterna,
  /** Número e série da NF-e emitida por fora (ex.: "1234/1"), quando não se tem a chave. */
  nfeExternaNumero: textoOpcional(20),
};

// ---------------------------------------------------------------- Rascunho

export const itemTransferenciaSchema = z.object({
  /** Item já gravado (mantido na edição); vazio = item novo. */
  id: idOpcional,
  produtoId: z.uuid('Escolha o produto'),
  /** Sempre vazio enquanto as variações estão travadas (D43): a API recusa outra coisa (F2-B23). */
  variacaoId: idOpcional,
  /**
   * Lote do produto (do estoque de origem, ou sem estoque). Vazio, o envio baixa em FEFO
   * (`estoque.lote_baixa_sem_informar`, F2-B6) e o lote de cada parte fica nos movimentos.
   */
  loteId: idOpcional,
  /** Quantidade enviada, na unidade do produto. */
  quantidade: quantidadeCampo,
});
export type ItemTransferenciaEntrada = z.input<typeof itemTransferenciaSchema>;
export type ItemTransferencia = z.output<typeof itemTransferenciaSchema>;

const camposTransferencia = z.object({
  /** Estoque que envia (entre os permitidos de quem cria e envia). */
  estoqueOrigemId: z.uuid('Escolha o estoque de origem'),
  /** Estoque que recebe (diferente da origem; não precisa ser permitido para quem envia). */
  estoqueDestinoId: z.uuid('Escolha o estoque de destino'),
  /**
   * Tipo de estoque que sai da origem e entra no destino. Vazio = o tipo padrão (Disponível); o Vasilhame vazio leva os
   * cascos de volta ao CD.
   */
  tipoEstoqueId: idOpcional,
  /** Data do documento. Vazio = hoje, e não pode ser futura: quem aplica e confere o dia é a API (ERP 1.5). */
  data: dataOpcionalValida,
  motivo: textoObrigatorio(120, 'Informe o motivo'),
  observacoes: textoOpcional(2000),
  ...camposNfeExterna,
  itens: z
    .array(itemTransferenciaSchema)
    .max(LIMITE_ITENS_TRANSFERENCIA, `No máximo ${LIMITE_ITENS_TRANSFERENCIA} itens por transferência`)
    .default([]),
});

function regrasTransferencia(v: z.output<typeof camposTransferencia>, ctx: z.RefinementCtx) {
  if (v.estoqueOrigemId.toLowerCase() === v.estoqueDestinoId.toLowerCase())
    ctx.addIssue({
      code: 'custom',
      path: ['estoqueDestinoId'],
      message: 'O destino tem de ser diferente da origem',
    });
  const ids = new Map<string, number>();
  const produtos = new Map<string, number>();
  v.itens.forEach((it, i) => {
    if (Number(it.quantidade) <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'quantidade'],
        message: 'Informe uma quantidade maior que zero',
      });
    if (it.id !== null) {
      const chave = it.id.toLowerCase();
      const anterior = ids.get(chave);
      if (anterior !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'id'],
          message: `Item repetido (linha ${anterior + 1})`,
        });
      else ids.set(chave, i);
    }
    // Uma linha por produto e lote (`uq_itens_transferencia_produto`): sem lote é uma, cada lote é outra.
    const chave = `${it.produtoId}:${it.variacaoId ?? ''}:${it.loteId ?? ''}`.toLowerCase();
    const anterior = produtos.get(chave);
    if (anterior !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'produtoId'],
        message: `Produto repetido (linha ${anterior + 1})`,
      });
    else produtos.set(chave, i);
  });
}

export const criarTransferenciaSchema = camposTransferencia.superRefine(regrasTransferencia);
export type CriarTransferenciaEntrada = z.input<typeof criarTransferenciaSchema>;
export type CriarTransferencia = z.output<typeof criarTransferenciaSchema>;
export const alterarTransferenciaSchema = camposTransferencia
  .extend({ versao: z.number().int() })
  .superRefine((v, ctx) => regrasTransferencia(v, ctx));
export type AlterarTransferenciaEntrada = z.input<typeof alterarTransferenciaSchema>;
export type AlterarTransferencia = z.output<typeof alterarTransferenciaSchema>;

/** `?versao=` da exclusão do rascunho (opcional, como no recebimento). */
export const excluirTransferenciaSchema = z.object({ versao: z.coerce.number().int().optional() });

/**
 * A NF-e de transferência emitida por fora, anotada depois do envio (em trânsito ou recebida; a cancelada não muda
 * mais — o trigger de etapa confere). No rascunho, ela vai junto do `PUT`.
 */
export const nfeExternaTransferenciaSchema = z.object({
  versao: z.number().int().optional(),
  ...camposNfeExterna,
});
export type NfeExternaTransferencia = z.output<typeof nfeExternaTransferenciaSchema>;

// ---------------------------------------------------------------- Etapas

/**
 * `POST /transferencias/:id/enviar` (1ª etapa): `TRANSF_SAIDA` ao custo médio da origem, com o saldo conferido (o ERP
 * não deixa negativo, salvo Master ou `estoque.permite_negativo_erp`; SYNC 15.1). `versao` é conferida no rascunho; na
 * transferência já enviada a chamada é idempotente.
 */
export const enviarTransferenciaSchema = z.object({ versao: z.number().int().optional() });
export type EnviarTransferencia = z.output<typeof enviarTransferenciaSchema>;

export const itemRecebimentoTransferenciaSchema = z.object({
  itemId: z.uuid(),
  /** Conferida no destino, entre 0 e a enviada (a API confere a enviada; o banco também). */
  quantidadeRecebida: quantidadeCampo,
});

/**
 * `POST /transferencias/:id/receber` (2ª etapa): ou "Receber tudo como enviado" (`receberTudo`, sem itens), ou a
 * quantidade conferida de **cada** item (a API recusa a conferência que deixa item de fora: o item esquecido não vira
 * "recebido como enviado" sem ninguém ter conferido). Recebida > enviada é recusada (fazer outra transferência).
 */
export const receberTransferenciaSchema = z
  .object({
    versao: z.number().int().optional(),
    receberTudo: z.boolean().default(false),
    itens: z.array(itemRecebimentoTransferenciaSchema).max(LIMITE_ITENS_TRANSFERENCIA).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.receberTudo && v.itens.length)
      ctx.addIssue({
        code: 'custom',
        path: ['itens'],
        message: 'Com "Receber tudo como enviado", não informe as quantidades',
      });
    if (!v.receberTudo && !v.itens.length)
      ctx.addIssue({
        code: 'custom',
        path: ['itens'],
        message: 'Informe a quantidade recebida de cada item ou use "Receber tudo como enviado"',
      });
    const vistos = new Map<string, number>();
    v.itens.forEach((it, i) => {
      const chave = it.itemId.toLowerCase();
      const anterior = vistos.get(chave);
      if (anterior !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'itemId'],
          message: `Item repetido (linha ${anterior + 1})`,
        });
      else vistos.set(chave, i);
    });
  });
export type ReceberTransferenciaEntrada = z.input<typeof receberTransferenciaSchema>;
export type ReceberTransferencia = z.output<typeof receberTransferenciaSchema>;

/**
 * `POST /transferencias/:id/tratar-divergencia`, por item com diferença ainda sem tratamento (cada item é tratado uma
 * vez só; o banco também confere). Quando o último é tratado, a transferência passa a `recebida`.
 */
export const tratarDivergenciaTransferenciaSchema = z
  .object({
    versao: z.number().int().optional(),
    itens: z
      .array(
        z.object({
          itemId: z.uuid(),
          tratamento: z.enum(TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA, 'Escolha o tratamento da diferença'),
        }),
      )
      .min(1, 'Escolha o tratamento de pelo menos um item')
      .max(LIMITE_ITENS_TRANSFERENCIA),
  })
  .superRefine((v, ctx) => {
    const vistos = new Map<string, number>();
    v.itens.forEach((it, i) => {
      const chave = it.itemId.toLowerCase();
      const anterior = vistos.get(chave);
      if (anterior !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'itemId'],
          message: `Item repetido (linha ${anterior + 1})`,
        });
      else vistos.set(chave, i);
    });
  });
export type TratarDivergenciaTransferencia = z.output<typeof tratarDivergenciaTransferenciaSchema>;

/**
 * `POST /transferencias/:id/cancelar`, com motivo (ERP 13.7): do rascunho, sem efeito no estoque; do trânsito,
 * `TRANSF_RETORNO` integral na origem ao custo original (T20).
 */
export const cancelarTransferenciaSchema = z.object({
  versao: z.number().int().optional(),
  motivo: textoObrigatorio(255, 'Informe o motivo do cancelamento'),
});
export type CancelarTransferencia = z.output<typeof cancelarTransferenciaSchema>;

// ---------------------------------------------------------------- Regras puras da situação

/**
 * Diferença do item (enviada − recebida, 3 casas), a mesma conta da coluna gerada `itens_transferencia.diferenca`:
 * zero até o recebimento (sem recebida, não há divergência).
 */
export function diferencaItemTransferenciaTexto(enviada: Valor, recebida: Valor | null): string {
  return decTexto(dec(enviada).minus(recebida ?? enviada), 3);
}

/** A situação depois do recebimento: com algum item recebido a menor, a divergência fica a tratar. */
export function situacaoAposRecebimento(
  itens: ReadonlyArray<{ quantidadeEnviada: Valor; quantidadeRecebida: Valor }>,
): 'recebida' | 'recebida_divergencia' {
  return itens.some((it) =>
    dec(diferencaItemTransferenciaTexto(it.quantidadeEnviada, it.quantidadeRecebida)).gt(0),
  )
    ? 'recebida_divergencia'
    : 'recebida';
}

// ---------------------------------------------------------------- Listagem e detalhe

/** Qual data o período da listagem filtra (ERP 13.7, "data de criação ou de transferência"). */
export const PERIODOS_TRANSFERENCIA = ['criacao', 'envio'] as const;
export type PeriodoTransferencia = (typeof PERIODOS_TRANSFERENCIA)[number];
export const ROTULOS_PERIODO_TRANSFERENCIA: Record<PeriodoTransferencia, string> = {
  criacao: 'Data de criação',
  envio: 'Data da transferência',
};

/** Com o `dataCampo`: a data impossível (30/02) é 422 aqui, e não o 22008 do `::date` (500). */
const dataFiltro = dataCampo.optional();

/**
 * Filtros da listagem (ERP 13.7): Nº, estoque de origem, estoque de destino, situação e período (pela data de criação
 * ou pela de envio).
 */
export const filtroTransferenciasSchema = paginacaoQuerySchema.extend({
  codigo: z.coerce.number().int().min(1).optional(),
  estoqueOrigemId: z.uuid().optional(),
  estoqueDestinoId: z.uuid().optional(),
  status: z.enum(STATUS_TRANSFERENCIA).optional(),
  periodo: z.enum(PERIODOS_TRANSFERENCIA).default('criacao'),
  dataInicial: dataFiltro,
  dataFinal: dataFiltro,
});
export type FiltroTransferencias = z.infer<typeof filtroTransferenciasSchema>;

/**
 * Opção do seletor "Destino" (`GET /transferencias/destinos`; ERP 13.7): todo estoque **ativo** da empresa, sem o
 * filtro dos estoques permitidos, porque o destino não precisa ser permitido para quem envia (o expedidor do CD
 * despacha para a loja que não enxerga; a loja devolve os cascos ao CD). Só a identificação: sem saldo nem custo.
 */
export interface DestinoTransferenciaOpcao {
  id: string;
  codigo: number;
  nome: string;
  tipo: (typeof TIPOS_ESTOQUE_LOCAL)[number];
  /** A loja do estoque (a de menor código, como a origem); `null` no estoque sem loja (o CD). */
  lojaId: string | null;
  lojaNome: string | null;
}

export interface TransferenciaResumo {
  id: string;
  codigo: number;
  estoqueOrigemId: string;
  estoqueOrigemNome: string;
  estoqueDestinoId: string;
  estoqueDestinoNome: string;
  /** "Data criação" (a data do documento). */
  data: string;
  /** "Data transferência" (o envio). */
  enviadaEm: string | null;
  recebidaEm: string | null;
  qtdItens: number;
  status: StatusTransferencia;
  versao: number;
}

export interface ItemTransferenciaDetalhe {
  id: string;
  sequencia: number;
  produtoId: string;
  produto: ProdutoOpcao;
  variacaoId: string | null;
  loteId: string | null;
  /** O código do lote escolhido (nulo = FEFO no envio). */
  lote: string | null;
  validade: string | null;
  quantidadeEnviada: string;
  /** Nula até o recebimento. */
  quantidadeRecebida: string | null;
  /** Enviada − recebida (0 até o recebimento). */
  diferenca: string;
  tratamentoDivergencia: TratamentoDivergenciaTransferencia | null;
  divergenciaTratadaEm: string | null;
  /** Custo médio da origem gravado no envio; `null` no rascunho ou sem `produtos.ver_custo`. */
  custoUnitario: string | null;
  /** "Saldo na origem" (ERP 13.7) no estoque × tipo da transferência; `null` fora dos estoques visíveis. */
  saldoOrigem: string | null;
}

export interface TransferenciaDetalhe extends MetadadosRegistro {
  codigo: number;
  estoqueOrigemId: string;
  estoqueOrigemNome: string;
  estoqueDestinoId: string;
  estoqueDestinoNome: string;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  data: string;
  motivo: string;
  observacoes: string | null;
  status: StatusTransferencia;
  enviadaEm: string | null;
  enviadaPorNome: string | null;
  recebidaEm: string | null;
  recebidaPorNome: string | null;
  canceladaEm: string | null;
  canceladaPorNome: string | null;
  motivoCancelamento: string | null;
  nfeExternaChave: string | null;
  nfeExternaNumero: string | null;
  qtdItens: number;
  itens: ItemTransferenciaDetalhe[];
}

// ---------------------------------------------------------------- Sugestão de reposição (F2-B25)

/**
 * `GET /transferencias/sugestao-reposicao?origem&destino[&tipoEstoqueId]` (F2-B25; README da API › decisão 173): os
 * produtos do destino abaixo do mínimo da loja dele (`produtos_lojas`), contando o que já está em trânsito para ele,
 * no tipo de estoque escolhido (vazio = o padrão), arredondados à embalagem de compra
 * (`estoque.reposicao_arredonda_embalagem`) e limitados ao saldo da origem. Destino sem loja: sugestão vazia, com aviso.
 * A API devolve os erros de `origem` e `destino` nos campos do rascunho (`estoqueOrigemId`, `estoqueDestinoId`).
 */
export const sugestaoReposicaoSchema = z
  .object({
    origem: z.uuid('Escolha o estoque de origem'),
    destino: z.uuid('Escolha o estoque de destino'),
    // `?tipoEstoqueId=` vazio (o seletor sem escolha) = o padrão, como no rascunho.
    tipoEstoqueId: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.uuid().optional(),
    ),
  })
  .refine((v) => v.origem.toLowerCase() !== v.destino.toLowerCase(), {
    path: ['destino'],
    message: 'O destino tem de ser diferente da origem',
  });
export type SugestaoReposicaoConsulta = z.output<typeof sugestaoReposicaoSchema>;

export interface ItemSugestaoReposicao {
  produtoId: string;
  produto: ProdutoOpcao;
  estoqueMinimo: string;
  /** `null` = sem máximo (a conta usa mínimo × 2). */
  estoqueMaximo: string | null;
  saldoDestino: string;
  /** Já enviado para o destino e ainda não recebido (descontado da sugestão). */
  emTransito: string;
  saldoOrigem: string;
  /**
   * Embalagem de compra usada no arredondamento (a viva com `usa_compra` de maior fator > 1;
   * `estoque.reposicao_arredonda_embalagem`, F2-Q11 = D52); `null` = em unidades (chave desligada ou sem embalagem).
   */
  embalagem: { unidadeSigla: string | null; fator: string } | null;
  /** A sugerida (> 0), na unidade do produto, já arredondada e limitada ao saldo da origem. */
  quantidade: string;
}

export interface SugestaoReposicao {
  itens: ItemSugestaoReposicao[];
  /** Ex.: o destino sem loja (sem estoque mínimo para comparar). */
  avisos: string[];
}
