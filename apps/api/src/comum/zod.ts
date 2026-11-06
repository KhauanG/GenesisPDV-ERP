import type { z } from 'zod';
import { ErroApi } from './erros.js';

/** Valida a entrada com um schema `zod` compartilhado; erro vira 422 VALIDACAO com `campos`. */
export function validar<S extends z.ZodType>(schema: S, valor: unknown): z.output<S> {
  const r = schema.safeParse(valor);
  if (!r.success) throw ErroApi.validacao(r.error);
  return r.data;
}
