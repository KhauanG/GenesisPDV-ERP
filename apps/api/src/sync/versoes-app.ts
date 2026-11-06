/** Compara versões SemVer `maior.menor.correcao[-pre]` (pré-lançamento vem antes da versão final). */
export function compararVersoes(a: string, b: string): number {
  const partes = (v: string) => {
    const [nucleo = '', pre] = v.split(/[-+]/, 2);
    return { n: nucleo.split('.').map((x) => Number(x) || 0), pre: v.includes('-') ? (pre ?? '') : null };
  };
  const pa = partes(a);
  const pb = partes(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.n[i] ?? 0) - (pb.n[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
