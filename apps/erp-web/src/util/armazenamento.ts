/** `localStorage` tolerante a falha (modo privado, cota, bloqueio): só conveniências, nunca estado que importa. */
export function lerLocal(chave: string): string | null {
  try {
    return window.localStorage.getItem(chave);
  } catch {
    return null;
  }
}

export function gravarLocal(chave: string, valor: string | null): void {
  try {
    if (valor === null) window.localStorage.removeItem(chave);
    else window.localStorage.setItem(chave, valor);
  } catch {
    // Sem armazenamento a tela continua funcionando com os padrões.
  }
}
