/**
 * Utilidades de coleção para o trabalho em memória do processo da API, que atende todas as empresas no mesmo laço de
 * eventos (README da API › decisão 209): agrupar sem copiar a lista a cada item e percorrer uma lista longa cedendo o
 * laço de tempos em tempos, para que uma análise grande de uma empresa não segure as requisições das outras.
 */

/**
 * Acrescenta `valor` à lista de `chave`, criando-a na primeira vez. Custo constante por item: o agrupamento de M itens
 * na mesma chave é linear (a cópia da lista acumulada a cada item, `[...(mapa.get(k) ?? []), v]`, é quadrática).
 */
export function agruparEm<K, V>(mapa: Map<K, V[]>, chave: K, valor: V): void {
  const lista = mapa.get(chave);
  if (lista) lista.push(valor);
  else mapa.set(chave, [valor]);
}

/** Itens percorridos entre uma cessão do laço e a próxima (`coletarCedendo`). */
export const ITENS_POR_CESSAO = 2_000;

/** Devolve a vez ao laço de eventos: as requisições e os temporizadores que estavam esperando rodam antes de seguir. */
export const cederLaco = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Coleta os itens de um iterador (normalmente um gerador que faz o trabalho de cada item quando é pedido) cedendo o
 * laço a cada `aCada` itens. O resultado é o mesmo do `[...itens]`; só o trabalho fica repartido em fatias.
 */
export async function coletarCedendo<T>(itens: Iterable<T>, aCada = ITENS_POR_CESSAO): Promise<T[]> {
  const resultado: T[] = [];
  for (const item of itens) {
    resultado.push(item);
    if (resultado.length % aCada === 0) await cederLaco();
  }
  return resultado;
}
