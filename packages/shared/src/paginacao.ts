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
 * Teto da exportação síncrona. Acima de `LIMITE_TODOS` o ERP 3.1 prevê gerar o arquivo em segundo plano (3.6); até
 * a central de tarefas chegar ao cabeçalho, a exportação responde na hora até este limite.
 */
export const LIMITE_EXPORTACAO = 50_000;
