/**
 * Decimais digitados em pt-BR ("1.234,56", "1,5", "2") → número, ou `null` se não for número. Só para conta de tela
 * (rodapé da grade); o valor gravado segue como texto decimal até a API (ERP 1.5).
 */
export function lerDecimal(texto: string): number | null {
  const t = texto.trim().replace(/\s/g, '');
  if (!t) return null;
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^-?\d+(\.\d+)?$/.test(normal)) return null;
  return Number(normal);
}

const formatadores = new Map<number, Intl.NumberFormat>();

/** Número com `casas` decimais no padrão brasileiro; quantidade sem zeros à direita. */
export function formatarDecimal(n: number, casas: number): string {
  let f = formatadores.get(casas);
  if (!f) {
    f = new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: casas === 2 ? 2 : 0,
      maximumFractionDigits: casas,
    });
    formatadores.set(casas, f);
  }
  return f.format(n);
}

/**
 * O texto digitado em pt-BR como decimal com ponto ("1.234,56" → "1234.56"), sem passar por `number` (para as contas
 * em decimal do shared); `null` se não for número.
 */
export function textoDecimal(texto: string): string | null {
  const t = texto.trim().replace(/\s/g, '');
  if (!t) return null;
  const normal = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^-?\d+(\.\d+)?$/.test(normal) ? normal : null;
}

/** Data digitada na grade (`dd/mm/aaaa`) → `AAAA-MM-DD`; vazio = `null`; data impossível = `undefined`. */
export function dataDaGrade(texto: string): string | null | undefined {
  const t = texto.trim();
  if (!t) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/** `AAAA-MM-DD` → `dd/mm/aaaa` (o campo de data da grade). */
export const dataParaGrade = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
