/** Oferece o arquivo para salvar (download pelo navegador, sem abrir nova aba). */
export function salvarArquivo(blob: Blob, nome: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Alguns navegadores leem a URL depois do clique: revoga no próximo ciclo.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
