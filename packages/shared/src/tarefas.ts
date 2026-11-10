import { z } from 'zod';
import { STATUS_TAREFA } from './enums.js';

/**
 * Tarefas em segundo plano do próprio usuário (ERP 3.6; MD 3.1.8; Fase 2, F2-B30; README do ERP › decisão 65): a
 * forma de cada item de `GET /tarefas` e de `GET /tarefas/:id`, que o ícone Tarefas do cabeçalho, a Importação, o
 * upload de NF-e e a exportação dos relatórios acompanham. Sem permissão própria: cada um vê só as suas.
 */
export type StatusTarefa = (typeof STATUS_TAREFA)[number];

export const tarefaUsuarioSchema = z.object({
  id: z.uuid(),
  tipo: z.string(),
  status: z.enum(STATUS_TAREFA),
  progressoPct: z.number().int().min(0).max(100),
  mensagem: z.string().nullable(),
  /** O resultado do executor (cada tipo tem o seu: o da importação, o da exportação de relatório…). */
  resultado: z.unknown(),
  erro: z.string().nullable(),
  criadoEm: z.string(),
  concluidaEm: z.string().nullable(),
  /** Link assinado do arquivo (7 dias, sem passar da retenção dele); `null` sem arquivo ou com ele expirado. */
  download: z.string().nullable(),
  /** O arquivo passou da retenção: não se baixa mais. */
  downloadExpirado: z.boolean(),
});

/** Uma tarefa do usuário, com o `resultado` do tipo `R`. */
export type TarefaUsuario<R = unknown> = Omit<z.infer<typeof tarefaUsuarioSchema>, 'resultado'> & {
  resultado: R | null;
};

/** `GET /tarefas`: as 50 mais recentes do usuário e quantas delas estão na fila ou executando. */
export interface RespostaTarefas {
  pendentes: number;
  itens: TarefaUsuario[];
}

/** Na fila ou executando: o ícone Tarefas conta e acompanha. */
export function tarefaEmAndamento(t: Pick<TarefaUsuario, 'status'>): boolean {
  return t.status === 'na_fila' || t.status === 'executando';
}

/** O nome de cada tipo de tarefa no ícone Tarefas (tipo sem rótulo aparece pelo próprio código). */
export const ROTULOS_TIPO_TAREFA: Readonly<Record<string, string>> = {
  importacao_produtos: 'Importação de produtos',
  importacao_clientes: 'Importação de clientes',
  importar_xml_nfe: 'Importação de NF-e (XML)',
  exportar_relatorio: 'Exportação de relatório',
  reprocessar_eventos: 'Reprocessamento de eventos do PDV',
  reprocessar_apos_lacuna: 'Reprocessamento depois da lacuna do PDV',
};

export const ROTULOS_STATUS_TAREFA: Readonly<Record<StatusTarefa, string>> = {
  na_fila: 'Na fila',
  executando: 'Executando',
  concluida: 'Concluída',
  falhou: 'Falhou',
  cancelada: 'Cancelada',
};
