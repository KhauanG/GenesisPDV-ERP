/**
 * JSON canônico (JCS, RFC 8785) usado no `payload_sha256` dos eventos do PDV (SYNC 7.1): chaves ordenadas por
 * unidades UTF-16, sem espaços, números no formato ES6, não ASCII literal, escapes só de `"`, `\` e controles
 * (`\b \f \n \r \t` curtos, os demais `\u00xx` minúsculo). O PDV tem um serializador equivalente em C#; os dois
 * rodam os mesmos vetores (`packages/shared/testes/jcs/vetores.json`).
 */
export function jcs(valor: unknown): string {
  if (valor === null) return 'null';
  switch (typeof valor) {
    case 'boolean':
      return valor ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(valor)) throw new TypeError('JCS não aceita NaN nem Infinity');
      // ES6 Number.prototype.toString já é a serialização do RFC 8785 (e -0 vira 0).
      return Object.is(valor, -0) ? '0' : String(valor);
    case 'string':
      return texto(valor);
    case 'object': {
      if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? 'null' : jcs(v))).join(',')}]`;
      const obj = valor as Record<string, unknown>;
      // Comparação padrão de strings em JS = ordem por unidades UTF-16, como pede o RFC 8785.
      const chaves = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${chaves.map((k) => `${texto(k)}:${jcs(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS não serializa ${typeof valor}`);
  }
}

const CURTOS: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };

function texto(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) r += '\\"';
    else if (c === 0x5c) r += '\\\\';
    else if (c < 0x20) r += CURTOS[c] ?? `\\u${c.toString(16).padStart(4, '0')}`;
    else r += s[i];
  }
  return `${r}"`;
}
