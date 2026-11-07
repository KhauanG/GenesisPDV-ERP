import { z } from 'zod';

export const TAMANHOS_PAGINA = [20, 25, 35, 50] as const;
/** `tamanho=todos` é limitado a este número de linhas (ERP 1.8). */
export const LIMITE_TODOS = 5000;

const ordenarRegex = /^[a-z_][a-z0-9_]*:(asc|desc)$/;

export const paginacaoQuerySchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  tamanho: z
    .union([z.literal('todos'), z.coerce.number().int()])
    .default(20)
    .refine((v) => v === 'todos' || (TAMANHOS_PAGINA as readonly number[]).includes(v), {
      message: 'Tamanho de página inválido (20, 25, 35, 50 ou todos)',
    }),
  ordenar: z.string().regex(ordenarRegex, 'Use campo:asc ou campo:desc').optional(),
});

export type PaginacaoQuery = z.infer<typeof paginacaoQuerySchema>;

export interface Pagina<T> {
  itens: T[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
}

export function paginaSchema<T extends z.ZodType>(item: T) {
  return z.object({
    itens: z.array(item),
    total: z.number().int().min(0),
    pagina: z.number().int().min(1),
    tamanho: z.union([z.number().int(), z.literal('todos')]),
  });
}

/** Converte a query de paginação em limit/offset para o banco. */
export function limiteDeslocamento(q: PaginacaoQuery): { limite: number; deslocamento: number } {
  const limite = q.tamanho === 'todos' ? LIMITE_TODOS : q.tamanho;
  return { limite, deslocamento: q.tamanho === 'todos' ? 0 : (q.pagina - 1) * limite };
}

export function ordenacao(q: PaginacaoQuery): { campo: string; direcao: 'asc' | 'desc' } | undefined {
  if (!q.ordenar) return undefined;
  const [campo, direcao] = q.ordenar.split(':') as [string, 'asc' | 'desc'];
  return { campo, direcao };
}

/** Formatos do "Exportar" das listagens (ERP 3.1, 1.8: `GET /api/<recurso>/exportar?formato=`). */
export const FORMATOS_EXPORTACAO = ['xlsx', 'csv'] as const;
export type FormatoExportacao = (typeof FORMATOS_EXPORTACAO)[number];

export const exportacaoQuerySchema = z.object({
  formato: z.enum(FORMATOS_EXPORTACAO).default('xlsx'),
});

/**
 * Teto da exportação síncrona (ERP 3.5: "relatórios que passam de 50.000 linhas rodam como tarefa"). As listagens
 * (produtos, pessoas, usuários) recusam acima dele; a exportação de relatório (F2-B29, README da API › decisão 177)
 * baixa na hora até ele e vira tarefa `exportar_relatorio` acima.
 */
export const LIMITE_EXPORTACAO = 50_000;

/**
 * Teto da exportação de relatório em tarefa (F2-B29): acima disto a API pede para refinar os filtros. O `.xlsx` tem
 * até 1.048.575 linhas de dados por aba, então os 5 milhões saem em 5 abas (o `.csv` não tem limite de linhas).
 */
export const LIMITE_EXPORTACAO_TAREFA = 5_000_000;

/** Tipo da tarefa da exportação de relatório (ícone Tarefas, ERP 3.6). */
export const TAREFA_EXPORTAR_RELATORIO = 'exportar_relatorio';

/** Resposta `202` da exportação que virou tarefa: o ERP acompanha em `GET /tarefas/:id` e baixa pelo link dela. */
export const exportacaoEmTarefaSchema = z.object({
  tarefaId: z.uuid(),
  /** Linhas contadas no pedido (a leitura pode achar um pouco mais ou menos se o razão mudar no meio). */
  linhas: z.number().int().min(0),
});
export type ExportacaoEmTarefa = z.infer<typeof exportacaoEmTarefaSchema>;

/** `tarefas.resultado` da exportação de relatório concluída. */
export const resultadoExportacaoRelatorioSchema = z.object({
  relatorio: z.string(),
  formato: z.enum(FORMATOS_EXPORTACAO),
  linhas: z.number().int().min(0),
  /** Abas do `.xlsx` (1 no `.csv`). */
  abas: z.number().int().min(1),
  tamanhoBytes: z.number().int().min(0),
  nomeArquivo: z.string(),
});
export type ResultadoExportacaoRelatorio = z.infer<typeof resultadoExportacaoRelatorioSchema>;
