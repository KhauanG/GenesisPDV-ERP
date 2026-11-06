const dataHora = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
const data = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' });
const inteiro = new Intl.NumberFormat('pt-BR');

/** `dd/mm/aaaa hh:mm` no fuso da empresa (ERP 1.5; o fuso por loja chega com o cadastro de lojas). */
export function formatarDataHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dataHora.format(d).replace(',', '');
}

/** Data sem hora (`AAAA-MM-DD` do banco) como `dd/mm/aaaa`. */
export function formatarData(valor: string | null | undefined): string {
  if (!valor) return '—';
  const d = new Date(`${valor.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '—' : data.format(d);
}

export function formatarInteiro(n: number): string {
  return inteiro.format(n);
}

export function formatarCnpj(v: string): string {
  return v.length === 14
    ? `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`
    : v;
}
