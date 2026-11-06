import { z } from 'zod';

/** Mensagens padrão do zod em português (ADR-12), para a API e o ERP web. */
export function configurarZodPtBr(): void {
  z.config(z.locales.pt());
}
