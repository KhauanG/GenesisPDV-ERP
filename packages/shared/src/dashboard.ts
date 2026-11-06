/**
 * Início – Dashboard (ERP 6): filtros Mês/Ano e Loja, cards (pessoas, produtos, vendas, contas do mês) e os painéis
 * por permissão. Pessoas, produtos, vendas do PDV (Fase 1C, C12: pelo dia operacional, D7), PDVs e estoque abaixo do
 * mínimo são reais; o financeiro vem com a Fase 4 (zero).
 */
import { z } from 'zod';
import { FILTROS_TREINO } from './vendas.js';

export const dashboardQuerySchema = z.object({
  /** `AAAA-MM`; padrão = mês atual no fuso da empresa. */
  mes: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use AAAA-MM')
    .optional(),
  /** Vazio = todas as lojas permitidas. */
  lojaId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
  /** Lojas de treino (O10): fora por padrão; a loja escolhida em `lojaId` aparece mesmo sendo de treino. */
  treino: z.preprocess((v) => (v === '' ? undefined : v), z.enum(FILTROS_TREINO).default('excluir')),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export interface VendasLojaDashboard {
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  lojaTreino: boolean;
  /** Dia operacional de hoje na loja (fuso e hora de corte dela, D7). */
  totalDia: string;
  quantidadeDia: number;
  totalMes: string;
  quantidadeMes: number;
}

/** Máximo de alertas e de sessões listados nos painéis do Dashboard (o total vem à parte). */
export const MAXIMO_ITENS_PAINEL_DASHBOARD = 10;

/** Alerta crítico aberto no painel do Dashboard (O11; SYNC 11.3–11.4, ERP 12.5). */
export interface AlertaCriticoDashboard {
  id: string;
  tipo: string;
  titulo: string;
  mensagem: string | null;
  lojaNome: string | null;
  /** Terminal do alerta (o detalhe dele, ERP 12.4, é onde se decide: reprocessar, descartar, "Ciente"). */
  terminalId: string | null;
  criadoEm: string;
}

/** Sessão de caixa aberta há mais de `pdv.horas_alerta_sessao` (ERP 14.9: "Alerta no Dashboard"). */
export interface SessaoAntigaDashboard {
  sessaoId: string;
  lojaNome: string;
  numeroCaixa: number;
  operadorNome: string | null;
  abertaEm: string;
  /** Horas inteiras desde a abertura. */
  horas: number;
}

export interface Dashboard {
  mes: string;
  /** Rótulo "Outubro/2026". */
  rotuloMes: string;
  lojaId: string | null;
  geradoEm: string;
  pessoas: { ativas: number; novasNoMes: number };
  produtos: { ativos: number; semPreco: number; ncmInvalido: number };
  /**
   * Vendas finalizadas não canceladas do mês, pelo dia operacional; as canceladas abatem (saem do total) e as
   * devoluções entram com a Fase 3.
   */
  vendas: { total: string; quantidade: number; ticketMedio: string; porLoja: VendasLojaDashboard[] };
  /** Vendas por dia operacional do mês (gráfico da Fase 5), com o mesmo dia do mês anterior. */
  vendasPorDia: Array<{ dia: number; total: string; mesAnterior: string }>;
  /** `null` sem `dashboard.ver_financeiro`. */
  financeiro: {
    receber: { total: string; recebido: string; emAberto: string; atrasado: string };
    pagar: { total: string; pago: string; emAberto: string; atrasado: string };
  } | null;
  /** `null` sem `terminais.ver`. */
  pdvs: { total: number; online: number; offline: number; comPendencias: number } | null;
  /**
   * Painel mínimo de alertas críticos (Fase 1C, C14; O11): os abertos (`resolvido_em` nulo) das lojas filtradas e os
   * da empresa (sem loja), mais recentes primeiro, só dos tipos que têm onde decidir, todos do PDV e dos terminais
   * (`EVENTO_DESCARTADO`, `EVENTO_COM_ERRO` crítico, `EVENTO_DIVERGENTE`, `TERMINAL_DESATIVADO_COM_EVENTOS`,
   * `TOKEN_ANTERIOR_REUTILIZADO`, `ATIVACAO_FORCA_BRUTA`), cada um com o terminal para o link ao detalhe, onde se
   * decide (a força bruta, sem terminal, leva à listagem): `null` sem `terminais.ver`. O painel completo (todos os tipos
   * e severidades, "Ciente" no próprio painel) é da Fase 5.
   */
  alertasCriticos: {
    total: number;
    porTipo: Array<{ tipo: string; quantidade: number }>;
    recentes: AlertaCriticoDashboard[];
  } | null;
  /**
   * Sessões de caixa ainda abertas há mais de `pdv.horas_alerta_sessao` (loja ?? empresa ?? 24 h) nas lojas filtradas,
   * da mais antiga para a mais nova: `null` sem `fechamentos_caixa.ver`.
   */
  sessoesAntigas: { total: number; recentes: SessaoAntigaDashboard[] } | null;
  /** `null` sem `estoque_saldos.ver`: produtos abaixo do estoque mínimo nas lojas filtradas (top 10). */
  estoqueBaixo: Array<{
    produtoId: string;
    produtoNome: string;
    lojaNome: string;
    quantidade: string;
    estoqueMinimo: string;
  }> | null;
}

const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
] as const;

/** "2026-10" → "Outubro/2026". */
export function rotuloMes(mes: string): string {
  const [ano, m] = mes.split('-');
  return `${MESES[Number(m) - 1] ?? m}/${ano}`;
}
