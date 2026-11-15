/**
 * Ids de rota e caminhos da API (README do ERP › decisão 85). Todo registro da API tem id UUID; o id que vem da URL
 * do ERP (`useParams`) só vira caminho da API quando é um único segmento nesse formato, e o caminho montado é
 * conferido de novo em `requisitar` antes do `fetch`: assim a tela de um tipo de registro só fala com a rota da API
 * daquele tipo.
 */

/** UUID (8-4-4-4-12 hexadecimais): o formato do id de todo registro da API. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Código da empresa no painel da plataforma: 6 dígitos (ERP 4.1). */
const CODIGO_EMPRESA = /^\d{6}$/;

/** O id da rota é um único segmento no formato de id de registro (UUID). */
export function idValido(id: string | null | undefined): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** O `:codigo` da rota da empresa no painel são exatamente 6 dígitos. */
export function codigoEmpresaValido(codigo: string | null | undefined): codigo is string {
  return typeof codigo === 'string' && CODIGO_EMPRESA.test(codigo);
}

/**
 * Um valor como um segmento só do caminho da API (`/`, `?`, `#` e `%` codificados). Ausente vira o texto, como na
 * interpolação (`undefined`): a API o recusa como id, e as consultas com o id ausente nem são feitas (`enabled`).
 */
export function segmento(valor: string | number | null | undefined): string {
  return encodeURIComponent(String(valor));
}

/** Parte do endereço antes da consulta (`?`) e do fragmento (`#`). */
function parteDoCaminho(endereco: string): string {
  const fim = endereco.search(/[?#]/);
  return fim < 0 ? endereco : endereco.slice(0, fim);
}

/**
 * O caminho não muda de rota quando o navegador o interpreta: sem barra invertida (o navegador a lê como `/`), sem
 * separador codificado (`%2F`, `%5C`), sem segmento de ponto (`.` e `..`, também escritos com `%2E`), que o navegador
 * resolve antes de enviar, e sem caractere de controle nem espaço: o leitor de endereço do navegador apaga TAB, LF e
 * CR em qualquer posição (`.<TAB>.` vira `..`, `/<TAB>/outro.site` vira `//outro.site`) e os de controle e o espaço
 * nas pontas (`/sair<espaço>` vira `/sair`). Só a parte antes do `?` é conferida: a consulta pode ter qualquer valor
 * codificado.
 */
export function caminhoSemDesvio(caminho: string): boolean {
  const parte = parteDoCaminho(caminho);
  // eslint-disable-next-line no-control-regex -- os caracteres de controle são justamente o que se recusa
  if (parte.includes('\\') || /%(2f|5c)/i.test(parte) || /[\u0000-\u0020\u007f]/.test(parte)) return false;
  return parte.split('/').every((s) => {
    const pontos = s.replace(/%2e/gi, '.');
    return pontos !== '.' && pontos !== '..';
  });
}

/**
 * A parte do caminho (antes do `?` e do `#`) como o roteador a lê para escolher a rota: cada segmento decodificado
 * (`/%70lataforma` é a rota `/plataforma`). `null` quando um segmento tem `%` que não decodifica — quem confere a
 * rota recusa, em vez de adivinhar o que o roteador faria com ele.
 */
export function caminhoDecodificado(caminho: string): string | null {
  try {
    return parteDoCaminho(caminho).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}
