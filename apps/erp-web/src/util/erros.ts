import type { z } from 'zod';

/** Primeiro erro de cada campo, no formato `{ caminho: mensagem }` dos formulários. */
export function errosDoZod(erro: z.ZodError): Record<string, string> {
  const r: Record<string, string> = {};
  for (const i of erro.issues) {
    const chave = i.path.length ? i.path.join('.') : '_';
    r[chave] ??= i.message;
  }
  return r;
}

/** `campos` do envelope de erro da API (ERP 1.8) no mesmo formato. */
export function errosDaApi(campos: Record<string, string[]> | undefined): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(campos ?? {})) if (v[0]) r[k] = v[0];
  return r;
}
