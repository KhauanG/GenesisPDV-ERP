/**
 * O Voltar do formulário volta à listagem com a pesquisa que estava na URL (ERP 3.1, "Filtros na URL"), mesmo
 * quando o formulário foi aberto direto ou após várias navegações internas.
 */
const prefixo = 'genesis:listagem:url:';

export function lembrarFiltros(rota: string, busca: string): void {
  try {
    window.sessionStorage.setItem(prefixo + rota, busca);
  } catch {
    // sem sessionStorage o Voltar só perde os filtros
  }
}

export function rotaComFiltros(rota: string): string {
  try {
    return rota + (window.sessionStorage.getItem(prefixo + rota) ?? '');
  } catch {
    return rota;
  }
}
