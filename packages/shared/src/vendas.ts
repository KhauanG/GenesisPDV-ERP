/**
 * Consultas só de leitura das vendas e do caixa do PDV no ERP (Fase 1C, bloco C12): Vendas (ERP 15.4, sem a venda
 * ERP, o cancelamento pelo ERP e a devolução, que são da Fase 3), Reforço e abertura (15.2), Sangria (15.3) e
 * Fechamento de caixa (14.9, sem a conferência `fechamentos_caixa.conferir`, que é da Fase 3; a quebra/sobra no
 * financeiro é da Fase 4). Tudo nasce no PDV e chega pelos eventos `venda.*` e `caixa.*` (SYNC 9.3–9.9); as datas
 * filtram pelo **dia operacional** (D7) gravado pelo caixa.
 *
 * Loja de treino (dono, O10): `lojas.treino` marca a loja "Treino" dentro da empresa real. As consultas e o dashboard
 * deixam essas lojas de fora por padrão (`treino = 'excluir'`); escolher a loja no filtro mostra a loja escolhida
 * mesmo que seja de treino.
 */
import { z } from 'zod';
import { paginacaoQuerySchema } from './paginacao.js';
import { CANAIS_VENDA } from './sync/eventos.js';

// Data de calendário de verdade (`2026-02-31` não passa): a consulta faz `::date` no PostgreSQL, que recusaria a data
// impossível com erro interno (500) em vez da validação (422).
const data = z.iso.date('Data inválida').optional();
const vazioIndefinido = (v: unknown) => (v === '' ? undefined : v);
const uuidOpcional = z.preprocess(vazioIndefinido, z.uuid().optional());

/**
 * Dia operacional (`AAAA-MM-DD`, D7) do instante `agora`: a data e a hora locais no `fuso` menos a hora de corte
 * (`HH:MM`, `geral.dia_operacional_hora_corte`), a mesma conta do PDV (`DiaOperacional.Calcular`) e da API
 * (`diaOperacionalAtual`, que faz `(now() at time zone fuso) - corte` no PostgreSQL). Às 02:00 de 01/11 com o corte das
 * 05:00 o dia ainda é 31/10.
 */
export function diaOperacionalEm(agora: Date, horaCorte: string, fuso = 'America/Sao_Paulo'): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value]),
  );
  // A hora "de parede" do fuso como se fosse UTC: subtrair o corte nela é o `timestamp - interval` do PostgreSQL.
  const local = Date.UTC(
    Number(partes.year),
    Number(partes.month) - 1,
    Number(partes.day),
    Number(partes.hour),
    Number(partes.minute),
    Number(partes.second),
  );
  const [h, m] = horaCorte.split(':').map(Number);
  return new Date(local - ((h ?? 0) * 60 + (m ?? 0)) * 60_000).toISOString().slice(0, 10);
}

/** Mês (`AAAA-MM`) do dia operacional de `agora` (o mês padrão do dashboard, ERP 6). */
export const mesOperacionalEm = (agora: Date, horaCorte: string, fuso?: string): string =>
  diaOperacionalEm(agora, horaCorte, fuso).slice(0, 7);

/** Filtro das lojas de treino (O10): fora (padrão), junto com as reais ou só elas. */
export const FILTROS_TREINO = ['excluir', 'incluir', 'somente'] as const;
export type FiltroTreino = (typeof FILTROS_TREINO)[number];
export const ROTULOS_FILTRO_TREINO: Record<FiltroTreino, string> = {
  excluir: 'Sem a loja de treino',
  incluir: 'Com a loja de treino',
  somente: 'Só a loja de treino',
};
const treino = z.preprocess(vazioIndefinido, z.enum(FILTROS_TREINO).default('excluir'));

// ---------------------------------------------------------------------------------------------------------------
// Vendas (ERP 15.4)

/** "Tipo" exibido, derivado de `canal` (ERP 15.4.1): `erp` → Venda; `pdv`/`totem` → PDV; o resto → Integração. */
export const TIPOS_EXIBIDOS_VENDA = ['venda', 'pdv', 'integracao'] as const;
export type TipoExibidoVenda = (typeof TIPOS_EXIBIDOS_VENDA)[number];
export const ROTULOS_TIPO_VENDA: Record<TipoExibidoVenda, string> = {
  venda: 'Venda',
  pdv: 'PDV',
  integracao: 'Integração',
};
export const CANAIS_POR_TIPO_VENDA: Record<TipoExibidoVenda, readonly (typeof CANAIS_VENDA)[number][]> = {
  venda: ['erp'],
  pdv: ['pdv', 'totem'],
  integracao: ['ifood', '99food', 'woocommerce', 'nuvemshop', 'menu_digital'],
};
export function tipoExibidoVenda(canal: string): TipoExibidoVenda {
  if (canal === 'erp') return 'venda';
  if (canal === 'pdv' || canal === 'totem') return 'pdv';
  return 'integracao';
}

/** Situações filtráveis (ERP 15.4.1); `todas` = todas exceto Rascunho (o padrão). */
export const SITUACOES_FILTRO_VENDA = ['todas', 'finalizada', 'cancelada', 'pedido_pendente'] as const;
export const ROTULOS_STATUS_VENDA: Record<string, string> = {
  rascunho: 'Rascunho',
  em_andamento: 'Em andamento',
  em_pagamento: 'Em pagamento',
  suspensa: 'Suspensa',
  pedido_pendente: 'Pedido pendente',
  finalizada: 'OK',
  cancelada: 'Cancelada',
};
export const DEVOLUCOES_FILTRO_VENDA = ['todas', 'nenhuma', 'parcial', 'total'] as const;
export const ROTULOS_DEVOLUCAO_VENDA: Record<string, string> = {
  nenhuma: 'Sem devolução',
  parcial: 'Parcial',
  total: 'Total',
};

export const ORDENACOES_VENDAS = [
  'cliente',
  'codigo',
  'data',
  'tipo',
  'situacao',
  'total_bruto',
  'total',
  'loja',
] as const;

export const filtroVendasSchema = paginacaoQuerySchema.extend({
  /** Número da venda: `L01-C02-000123` (a exibição inteira) ou só o sequencial. */
  codigo: z.preprocess(vazioIndefinido, z.string().trim().max(20).optional()),
  clienteId: uuidOpcional,
  /** Nome, CPF/CNPJ do cliente ou o CPF/nome da nota. */
  cliente: z.preprocess(vazioIndefinido, z.string().trim().max(120).optional()),
  dataInicial: data,
  dataFinal: data,
  numeroCaixa: z.preprocess(vazioIndefinido, z.coerce.number().int().min(0).max(999).optional()),
  lojaId: uuidOpcional,
  tipo: z.preprocess(vazioIndefinido, z.enum(TIPOS_EXIBIDOS_VENDA).optional()),
  situacao: z.preprocess(vazioIndefinido, z.enum(SITUACOES_FILTRO_VENDA).default('todas')),
  devolucao: z.preprocess(vazioIndefinido, z.enum(DEVOLUCOES_FILTRO_VENDA).default('todas')),
  operadorId: uuidOpcional,
  formaPagamentoId: uuidOpcional,
  /** Link "vendas" do detalhe da sessão de caixa (14.9). */
  sessaoCaixaId: uuidOpcional,
  treino,
});
export type FiltroVendas = z.infer<typeof filtroVendasSchema>;

export interface VendaResumo {
  id: string;
  numero: number;
  numeroExibicao: string;
  clienteId: string | null;
  /** Nome do cliente cadastrado, ou o nome da nota, ou o CPF/CNPJ da nota; `null` = consumidor final. */
  clienteNome: string | null;
  diaOperacional: string | null;
  finalizadaEm: string | null;
  tipo: TipoExibidoVenda;
  canal: string;
  status: string;
  devolucao: string;
  statusFiscal: string;
  subtotalBruto: string;
  descontos: string;
  total: string;
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  lojaTreino: boolean;
  numeroCaixa: number;
  operadorNome: string | null;
}

export interface PaginaVendas {
  itens: VendaResumo[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
  /** Totais de todas as vendas do filtro (não só da página); as canceladas entram na quantidade e não nos valores. */
  totais: {
    quantidade: number;
    canceladas: number;
    totalBruto: string;
    descontos: string;
    totalLiquido: string;
  };
}

export interface ItemVendaDetalhe {
  id: string;
  sequencia: number;
  produtoId: string;
  produtoCodigo: number | null;
  descricao: string;
  codigoLido: string | null;
  unidade: string;
  quantidade: string;
  precoTabela: string;
  precoUnitario: string;
  origemPreco: string;
  valorBruto: string;
  descontoItem: string;
  descontoRateado: string;
  valorLiquido: string;
  /** Item do combo/kit: descrição do kit a que pertence. */
  kitDescricao: string | null;
  /** Casco cobrado (faltante) do item de origem. */
  vasilhameItemOrigemId: string | null;
  lote: string | null;
  cancelado: boolean;
  canceladoEm: string | null;
  canceladoPorNome: string | null;
  motivoCancelamento: string | null;
  /** `null` sem `vendas.ver_lucro`. */
  custoUnitario: string | null;
}

export interface PagamentoVendaDetalhe {
  id: string;
  sequencia: number;
  formaPagamentoId: string;
  descricaoForma: string;
  tipoForma: string;
  valor: string;
  valorRecebido: string | null;
  troco: string;
  parcelas: number;
  status: string;
  bandeiraNome: string | null;
  nsu: string | null;
  autorizacao: string | null;
  autorizadoPorNome: string | null;
}

export interface VendaDetalhe {
  id: string;
  numero: number;
  numeroExibicao: string;
  tipo: TipoExibidoVenda;
  canal: string;
  modo: string;
  status: string;
  statusFiscal: string;
  devolucao: string;
  diaOperacional: string | null;
  iniciadaEm: string;
  finalizadaEm: string | null;
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  lojaTreino: boolean;
  numeroCaixa: number;
  terminalId: string | null;
  terminalDescricao: string | null;
  sessaoCaixaId: string | null;
  operadorId: string;
  operadorNome: string | null;
  clienteId: string | null;
  clienteNome: string | null;
  cpfCnpjNota: string | null;
  nomeNota: string | null;
  tipoPreco: string;
  qtdItens: number;
  subtotalBruto: string;
  descontoItens: string;
  descontoTotal: string;
  descontoTotalOrigem: string | null;
  acrescimoTotal: string;
  total: string;
  troco: string;
  observacao: string | null;
  relogioConfiavel: boolean;
  canceladaEm: string | null;
  canceladaPorNome: string | null;
  cancelamentoAutorizadoPorNome: string | null;
  motivoCancelamento: string | null;
  cancelamentoOrigem: string | null;
  itens: ItemVendaDetalhe[];
  pagamentos: PagamentoVendaDetalhe[];
  /** `null` sem `vendas.ver_lucro` (ERP 15.4.2, aba Financeiro: custo, lucro R$ e margem %). */
  lucro: { custo: string; lucro: string; margemPct: string | null } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Reforço e abertura (15.2) e sangria (15.3): `movimentos_caixa`

export const TIPOS_MOVIMENTO_REFORCO = ['abertura', 'reforco'] as const;
/** A sangria do próprio fechamento (`sangria_fechamento`) também é retirada da gaveta (14.9, cálculo do dinheiro). */
export const TIPOS_MOVIMENTO_SANGRIA = ['sangria', 'sangria_fechamento'] as const;
export const ROTULOS_TIPO_MOVIMENTO_CAIXA: Record<string, string> = {
  abertura: 'Abertura',
  reforco: 'Reforço',
  sangria: 'Sangria',
  sangria_fechamento: 'Sangria de fechamento',
  estorno_venda: 'Estorno de venda',
  devolucao_troca: 'Devolução de troca',
};
export const SITUACOES_MOVIMENTO_CAIXA = ['ativos', 'cancelados', 'todos'] as const;
export const ORDENACOES_MOVIMENTOS_CAIXA = ['data', 'valor', 'tipo', 'loja', 'operador'] as const;

const filtroMovimentosBase = paginacaoQuerySchema.extend({
  dataInicial: data,
  dataFinal: data,
  lojaId: uuidOpcional,
  numeroCaixa: z.preprocess(vazioIndefinido, z.coerce.number().int().min(0).max(999).optional()),
  operadorId: uuidOpcional,
  situacao: z.preprocess(vazioIndefinido, z.enum(SITUACOES_MOVIMENTO_CAIXA).default('todos')),
  sessaoCaixaId: uuidOpcional,
  treino,
});
export const filtroReforcosSchema = filtroMovimentosBase.extend({
  tipo: z.preprocess(vazioIndefinido, z.enum(TIPOS_MOVIMENTO_REFORCO).optional()),
});
export type FiltroReforcos = z.infer<typeof filtroReforcosSchema>;
export const filtroSangriasSchema = filtroMovimentosBase.extend({
  tipo: z.preprocess(vazioIndefinido, z.enum(TIPOS_MOVIMENTO_SANGRIA).optional()),
});
export type FiltroSangrias = z.infer<typeof filtroSangriasSchema>;

export interface MovimentoCaixaResumo {
  id: string;
  tipo: string;
  ocorridoEm: string;
  diaOperacional: string;
  valor: string;
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  lojaTreino: boolean;
  numeroCaixa: number;
  operadorNome: string | null;
  /** Usuário que retirou, ou o nome livre (sangria). */
  quemRetira: string | null;
  cancelado: boolean;
}

export interface PaginaMovimentosCaixa {
  itens: MovimentoCaixaResumo[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
  /** Totalizador de valor (15.2): só os movimentos não cancelados do filtro. */
  totais: { quantidade: number; valor: string };
}

export interface MovimentoCaixaDetalhe extends MovimentoCaixaResumo {
  sessaoCaixaId: string;
  terminalId: string;
  terminalDescricao: string | null;
  operadorId: string;
  quemRetiraUsuarioNome: string | null;
  quemRetiraNome: string | null;
  observacao: string | null;
  infAdicionais: string | null;
  formaPagamentoDescricao: string | null;
  autorizadoPorNome: string | null;
  canceladoEm: string | null;
  canceladoPorNome: string | null;
  autorizadoCancelamentoPorNome: string | null;
  motivoCancelamento: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Fechamento de caixa / troca de turno (14.9): `sessoes_caixa` + `fechamentos_caixa`

/** "Conferida" e "Divergente" chegam com a conferência da Fase 3 (`fechamentos_caixa.conferir`). */
export const SITUACOES_SESSAO_CAIXA = ['aberta', 'fechada'] as const;
export const ROTULOS_SITUACAO_SESSAO: Record<string, string> = {
  aberta: 'Aberta',
  fechada: 'Fechada',
  fechada_forcado: 'Fechada pela nuvem',
};
export const ROTULOS_TIPO_FECHAMENTO: Record<string, string> = {
  fechamento: 'Fechamento',
  troca_turno: 'Troca de turno',
};
export const ROTULOS_FECHAMENTO_FORCADO: Record<string, string> = {
  substituicao_terminal: 'substituição do terminal',
  revogacao_terminal: 'revogação do terminal',
};
export const ORDENACOES_SESSOES_CAIXA = [
  'data',
  'loja',
  'operador',
  'calculado',
  'informado',
  'diferenca',
] as const;

export const filtroSessoesCaixaSchema = paginacaoQuerySchema.extend({
  lojaId: uuidOpcional,
  dataInicial: data,
  dataFinal: data,
  numeroCaixa: z.preprocess(vazioIndefinido, z.coerce.number().int().min(0).max(999).optional()),
  operadorId: uuidOpcional,
  situacao: z.preprocess(vazioIndefinido, z.enum(SITUACOES_SESSAO_CAIXA).optional()),
  somenteComDiferenca: z
    .preprocess(vazioIndefinido, z.enum(['true', 'false']).default('false'))
    .transform((v) => v === 'true'),
  treino,
});
export type FiltroSessoesCaixa = z.infer<typeof filtroSessoesCaixaSchema>;

export interface SessaoCaixaResumo {
  id: string;
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  lojaTreino: boolean;
  numeroCaixa: number;
  diaOperacional: string;
  abertaEm: string;
  fechadaEm: string | null;
  /** Operador da sessão (o "Usuário Anterior" de quem encerrou). */
  operadorNome: string | null;
  usuarioSubsequenteNome: string | null;
  /**
   * `aberta`, `fechada` ou `fechada_forcado`: fechada pela nuvem na substituição/revogação do terminal e cujo
   * `caixa.fechado` ainda não chegou. Quando o fechamento tardio do terminal antigo chega, a sessão volta a `fechada`
   * (a marca de que a nuvem a fechou fica em `fechamentoForcadoMotivo`, no detalhe).
   */
  situacao: string;
  /** `null` enquanto o `caixa.fechado` não chegou (sessão aberta ou fechada à força). */
  tipoFechamento: string | null;
  valorCaixa: string | null;
  totalCalculado: string | null;
  totalInformado: string | null;
  diferenca: string | null;
}

export interface PaginaSessoesCaixa {
  itens: SessaoCaixaResumo[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
  totais: { calculado: string; informado: string; diferenca: string };
}

export interface FormaFechamentoDetalhe {
  formaPagamentoId: string;
  descricaoForma: string;
  tipoForma: string;
  /** Calculado pelo PDV no fechamento (o operador não viu, fechamento cego, O3). */
  valorCalculado: string;
  /** Contado pelo operador no PDV. */
  valorInformado: string;
  diferenca: string;
  quantidadePagamentos: number;
}

export interface MovimentoSessaoDetalhe {
  id: string;
  tipo: string;
  ocorridoEm: string;
  valor: string;
  formaPagamentoDescricao: string | null;
  quemRetira: string | null;
  observacao: string | null;
  cancelado: boolean;
}

export interface SessaoCaixaDetalhe extends SessaoCaixaResumo {
  caixaId: string;
  terminalId: string;
  terminalDescricao: string | null;
  operadorId: string;
  fundoTroco: string;
  aberturaAutomatica: boolean;
  sessaoAnteriorId: string | null;
  valorRecebidoAnterior: string | null;
  diferencaRecebimento: string | null;
  fechamentoForcadoMotivo: string | null;
  /** Do `caixa.fechado`; `null` enquanto não chegou. */
  fechamento: {
    id: string;
    tipo: string;
    zeraCaixa: boolean;
    ocorridoEm: string;
    fechamentoCego: boolean;
    recontagem: boolean;
    justificativa: string | null;
    usuarioAnteriorNome: string | null;
    usuarioSubsequenteNome: string | null;
    /** Resumo que o PDV mandou (`fechamentos_caixa.resumo`, SYNC 9.6), como veio. */
    resumo: Record<string, unknown>;
  } | null;
  formas: FormaFechamentoDetalhe[];
  /**
   * Cálculo do dinheiro (PDV 20.4) refeito na nuvem com o que já chegou da sessão: fundo + vendas em dinheiro −
   * troco de outras formas + reforços − sangrias − estornos em dinheiro − devoluções = esperado na gaveta antes da
   * sangria do fechamento. Diferente do calculado do PDV quando ainda falta evento da sessão (pendente ou retido).
   */
  calculoDinheiro: {
    fundoTroco: string;
    vendasDinheiro: string;
    trocoOutrasFormas: string;
    reforcos: string;
    sangrias: string;
    estornosDinheiro: string;
    devolucoes: string;
    esperado: string;
    sangriaFechamento: string;
  };
  movimentos: MovimentoSessaoDetalhe[];
  /** Vendas gravadas na sessão: as canceladas entram na quantidade delas, não no total. */
  vendas: { quantidade: number; total: string; canceladas: number; totalCanceladas: string };
}
