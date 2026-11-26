/**
 * Códigos do vale e do cupom de troca (Fase 3, F3-B5; SYNC 13.4, MD 3.13.2, PDV 23.2): a regra num ponto só, com os
 * vetores em `testes/sync/vale.codigo.vetores.json`, que o Vitest daqui e o `CodigoValeVetoresTests` do PDV conferem.
 *
 * - **Vale** (`VC` + loja 2 + caixa 2 + sequencial 7 + DV Luhn 1 = `ck_vales_codigo ^VC[0-9]{12}$`): único sem consultar
 *   a nuvem, como o número da venda (um terminal ativo por caixa e a numeração `vale` do caixa, com o salto da
 *   ativação). O vale emitido no ERP usa o caixa `00` (o caixa do sistema).
 * - **Cupom de troca** (`CT` + loja 2 + caixa 2 + número da venda 12 + DV Luhn 1): o comprovante sem preços que o
 *   cliente traz para trocar (D95); o DV impede que um erro de digitação ache outra venda.
 * - **Código de conferência do vale** (D96, `pdv.vale_exige_conferencia`): 4 dígitos aleatórios impressos no vale;
 *   a nuvem e o caixa guardam só o resumo (`vales.conferencia_hash`), PBKDF2-HMAC-SHA-256 com sal aleatório sobre
 *   `<código do vale>:<4 dígitos>` (o resumo copiado de um vale não serve em outro). Usa a Web Crypto
 *   (`globalThis.crypto`), que existe no Node e no navegador: este pacote também vai para o ERP.
 *
 * README da API › decisão 224.
 */
import { NUMERO_VENDA_MAXIMO, VALE_NUMERO_MAXIMO } from './sync/contratos.js';

/** Código da loja nos códigos (`ck_lojas_codigo`: 1 a 99). */
export const LOJA_CODIGO_MINIMO = 1;
export const LOJA_CODIGO_MAXIMO = 99;
/** Número do caixa nos códigos (`ck_caixas_numero`: 0 a 99; o 0 é o caixa do sistema, o do ERP). */
export const CAIXA_NUMERO_MAXIMO = 99;
/** Caixa dos vales e das vendas do ERP (o caixa do sistema, `caixas.sistema`). */
export const CAIXA_ERP = 0;

/** `ck_vales_codigo` (MD 3.13.2). */
export const PADRAO_CODIGO_VALE_REGEX = /^VC[0-9]{12}$/;
/** Cupom de troca: `CT` + 17 dígitos (loja 2 + caixa 2 + número da venda 12 + DV). */
export const PADRAO_CUPOM_TROCA_REGEX = /^CT[0-9]{17}$/;

/**
 * Normaliza o código lido (do leitor ou digitado): tira das pontas só espaço, tab, CR e LF, e passa a maiúsculas só as
 * letras ASCII. A lista é explícita porque o `trim()` do JS e o `Trim()` do .NET não tiram os mesmos caracteres (o JS
 * tira o BOM U+FEFF e mantém o NEL U+0085; o .NET faz o contrário); o PDV usa a mesma lista (`CodigoVale.cs`).
 */
function normalizarLido(lido: string): string {
  return lido.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[a-z]+/g, (letras) => letras.toUpperCase());
}

/** Dígito verificador de Luhn (mod 10) de uma sequência de dígitos: dobra a partir do último, como no cartão. */
export function digitoLuhn(digitos: string): number {
  if (!/^[0-9]+$/.test(digitos)) throw new RangeError('Luhn: só dígitos');
  let soma = 0;
  for (let i = digitos.length - 1, dobra = true; i >= 0; i--, dobra = !dobra) {
    let d = digitos.charCodeAt(i) - 48;
    if (dobra) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    soma += d;
  }
  return (10 - (soma % 10)) % 10;
}

function inteiroEntre(nome: string, valor: number, minimo: number, maximo: number): void {
  if (!Number.isSafeInteger(valor) || valor < minimo || valor > maximo) {
    throw new RangeError(`${nome} fora do intervalo ${minimo}–${maximo}: ${valor}`);
  }
}

const doisDigitos = (n: number) => String(n).padStart(2, '0');

/**
 * `VC` + loja + caixa + sequencial (`sequencias_locais['vale']`, 1 a `VALE_NUMERO_MAXIMO`) + DV Luhn sobre os 11
 * dígitos. Fora dos limites é erro de programação (`RangeError`): o contador do caixa nunca passa do máximo (o
 * heartbeat o recusa acima disso, decisão 212).
 */
export function montarCodigoVale(lojaCodigo: number, numeroCaixa: number, sequencial: number): string {
  inteiroEntre('loja', lojaCodigo, LOJA_CODIGO_MINIMO, LOJA_CODIGO_MAXIMO);
  inteiroEntre('caixa', numeroCaixa, 0, CAIXA_NUMERO_MAXIMO);
  inteiroEntre('sequencial do vale', sequencial, 1, VALE_NUMERO_MAXIMO);
  const corpo = `${doisDigitos(lojaCodigo)}${doisDigitos(numeroCaixa)}${String(sequencial).padStart(7, '0')}`;
  return `VC${corpo}${digitoLuhn(corpo)}`;
}

/** Por que um código lido não vale (a tela mostra uma mensagem só; o motivo vai para o log). */
export type MotivoCodigoInvalido = 'FORMATO' | 'DIGITO_VERIFICADOR' | 'LOJA' | 'NUMERO';

export type CodigoValeConferido =
  | { valido: true; codigo: string; lojaCodigo: number; numeroCaixa: number; sequencial: number }
  | { valido: false; motivo: MotivoCodigoInvalido };

/**
 * Lê um código de vale (do leitor ou digitado): sem espaço, tab, CR e LF nas pontas e com o prefixo em qualquer caixa
 * de letra;
 * devolve o código normalizado e as partes. O DV é conferido antes dos limites, para que um dígito trocado sempre
 * apareça como erro de digitação.
 */
export function conferirCodigoVale(lido: string): CodigoValeConferido {
  const codigo = normalizarLido(lido);
  if (!PADRAO_CODIGO_VALE_REGEX.test(codigo)) return { valido: false, motivo: 'FORMATO' };
  const corpo = codigo.slice(2, 13);
  if (digitoLuhn(corpo) !== Number(codigo[13])) return { valido: false, motivo: 'DIGITO_VERIFICADOR' };
  const lojaCodigo = Number(corpo.slice(0, 2));
  const numeroCaixa = Number(corpo.slice(2, 4));
  const sequencial = Number(corpo.slice(4));
  if (lojaCodigo < LOJA_CODIGO_MINIMO) return { valido: false, motivo: 'LOJA' };
  if (sequencial < 1) return { valido: false, motivo: 'NUMERO' };
  return { valido: true, codigo, lojaCodigo, numeroCaixa, sequencial };
}

/**
 * `CT` + loja + caixa + número da venda (12 dígitos, 1 a `NUMERO_VENDA_MAXIMO`, o limite da SYNC 13.1, inclusive a
 * faixa de renumeração) + DV Luhn sobre os 16 dígitos. A venda do ERP usa o caixa `00`.
 */
export function montarCupomTroca(lojaCodigo: number, numeroCaixa: number, numeroVenda: number): string {
  inteiroEntre('loja', lojaCodigo, LOJA_CODIGO_MINIMO, LOJA_CODIGO_MAXIMO);
  inteiroEntre('caixa', numeroCaixa, 0, CAIXA_NUMERO_MAXIMO);
  inteiroEntre('número da venda', numeroVenda, 1, NUMERO_VENDA_MAXIMO);
  const corpo = `${doisDigitos(lojaCodigo)}${doisDigitos(numeroCaixa)}${String(numeroVenda).padStart(12, '0')}`;
  return `CT${corpo}${digitoLuhn(corpo)}`;
}

export type CupomTrocaConferido =
  | { valido: true; codigo: string; lojaCodigo: number; numeroCaixa: number; numeroVenda: number }
  | { valido: false; motivo: MotivoCodigoInvalido };

/** Lê um cupom de troca, com a mesma normalização e a mesma ordem de conferência de `conferirCodigoVale`. */
export function conferirCupomTroca(lido: string): CupomTrocaConferido {
  const codigo = normalizarLido(lido);
  if (!PADRAO_CUPOM_TROCA_REGEX.test(codigo)) return { valido: false, motivo: 'FORMATO' };
  const corpo = codigo.slice(2, 18);
  if (digitoLuhn(corpo) !== Number(codigo[18])) return { valido: false, motivo: 'DIGITO_VERIFICADOR' };
  const lojaCodigo = Number(corpo.slice(0, 2));
  const numeroCaixa = Number(corpo.slice(2, 4));
  const numeroVenda = Number(corpo.slice(4));
  if (lojaCodigo < LOJA_CODIGO_MINIMO) return { valido: false, motivo: 'LOJA' };
  if (numeroVenda < 1) return { valido: false, motivo: 'NUMERO' };
  return { valido: true, codigo, lojaCodigo, numeroCaixa, numeroVenda };
}

// ---------------------------------------------------------------------------------------------------------------
// Código de conferência do vale (D96)
// ---------------------------------------------------------------------------------------------------------------

/** Quantos dígitos o código de conferência tem (D96). */
export const VALE_CONFERENCIA_DIGITOS = 4;
/** Iterações do PBKDF2 que o resumo novo usa (gravadas no próprio resumo). */
export const VALE_CONFERENCIA_ITERACOES = 100_000;
/**
 * Faixa de iterações que a conferência aceita num resumo recebido: deixa subir o custo depois sem invalidar os vales
 * já impressos, e um resumo forjado com um número absurdo não prende a CPU do caixa nem da API.
 */
export const VALE_CONFERENCIA_ITERACOES_MINIMO = 10_000;
export const VALE_CONFERENCIA_ITERACOES_MAXIMO = 1_000_000;
/** Bytes do sal aleatório de cada vale. */
export const VALE_CONFERENCIA_SAL_BYTES = 16;
const RESUMO_BYTES = 32;
const PREFIXO_RESUMO = 'pbkdf2-sha256';
/**
 * `pbkdf2-sha256$<iterações>$<sal>$<resumo>`, sal (16 bytes) e resumo (32 bytes) em base64url sem `=`: 87 caracteres
 * com as iterações padrão, dentro do `varchar(100)` de `vales.conferencia_hash`.
 */
export const PADRAO_RESUMO_CONFERENCIA_VALE_REGEX =
  /^pbkdf2-sha256\$([1-9][0-9]{4,6})\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
const PADRAO_CONFERENCIA = /^[0-9]{4}$/;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function paraBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const quantos = Math.min(3, bytes.length - i) + 1;
    for (let j = 0; j < quantos; j++) s += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return s;
}

function deBase64Url(texto: string): Uint8Array {
  const saida: number[] = [];
  let acumulado = 0;
  let bits = 0;
  for (const c of texto) {
    const v = B64URL.indexOf(c);
    if (v < 0) throw new RangeError('base64url inválido');
    acumulado = (acumulado << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      saida.push((acumulado >> bits) & 0xff);
    }
  }
  return Uint8Array.from(saida);
}

/**
 * O pedaço da Web Crypto que este arquivo usa, tipado aqui: o pacote compila sem a lib DOM, e o tipo global do Node
 * não é o mesmo nome no navegador.
 */
interface WebCrypto {
  getRandomValues<T extends Uint8Array | Uint16Array>(destino: T): T;
  subtle: {
    importKey(
      formato: 'raw',
      chave: Uint8Array,
      algoritmo: 'PBKDF2',
      extraivel: false,
      usos: ['deriveBits'],
    ): Promise<unknown>;
    deriveBits(
      algoritmo: { name: 'PBKDF2'; hash: 'SHA-256'; salt: Uint8Array; iterations: number },
      chave: unknown,
      bits: number,
    ): Promise<ArrayBuffer>;
  };
}

function cripto(): WebCrypto {
  const c = (globalThis as { crypto?: WebCrypto }).crypto;
  if (!c?.subtle) throw new Error('Web Crypto indisponível');
  return c;
}

/**
 * Os 4 dígitos (com zeros à esquerda) sorteados pelo gerador criptográfico, sem viés: o sorteio de 16 bits é
 * descartado acima de 59.999 (o maior múltiplo de 10.000 que cabe).
 */
export function gerarCodigoConferenciaVale(): string {
  const caixa = new Uint16Array(1);
  for (;;) {
    cripto().getRandomValues(caixa);
    const v = caixa[0]!;
    if (v < 60_000) return String(v % 10_000).padStart(VALE_CONFERENCIA_DIGITOS, '0');
  }
}

async function derivar(codigoVale: string, conferencia: string, sal: Uint8Array, iteracoes: number) {
  const c = cripto();
  const chave = await c.subtle.importKey(
    'raw',
    // Só ASCII (os dois códigos já foram conferidos): um byte por caractere, igual ao UTF-8 do PDV.
    Uint8Array.from(`${codigoVale}:${conferencia}`, (c) => c.charCodeAt(0)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await c.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(sal), iterations: iteracoes },
    chave,
    RESUMO_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function exigirCodigos(codigoVale: string, conferencia: string): void {
  if (!PADRAO_CODIGO_VALE_REGEX.test(codigoVale)) throw new RangeError('Código do vale inválido');
  if (!PADRAO_CONFERENCIA.test(conferencia)) throw new RangeError('Código de conferência: 4 dígitos');
}

/**
 * Resumo do código de conferência de um vale, no formato de `PADRAO_RESUMO_CONFERENCIA_VALE_REGEX`. O sal é sorteado
 * quando não é passado (os vetores passam o deles).
 */
export async function resumirCodigoConferenciaVale(
  codigoVale: string,
  conferencia: string,
  opcoes: { sal?: Uint8Array; iteracoes?: number } = {},
): Promise<string> {
  exigirCodigos(codigoVale, conferencia);
  const iteracoes = opcoes.iteracoes ?? VALE_CONFERENCIA_ITERACOES;
  inteiroEntre('iterações', iteracoes, VALE_CONFERENCIA_ITERACOES_MINIMO, VALE_CONFERENCIA_ITERACOES_MAXIMO);
  const sal = opcoes.sal ?? cripto().getRandomValues(new Uint8Array(VALE_CONFERENCIA_SAL_BYTES));
  if (sal.length !== VALE_CONFERENCIA_SAL_BYTES) throw new RangeError('Sal: 16 bytes');
  const resumo = await derivar(codigoVale, conferencia, sal, iteracoes);
  return `${PREFIXO_RESUMO}$${iteracoes}$${paraBase64Url(sal)}$${paraBase64Url(resumo)}`;
}

/** O resumo gravado tem o formato aceito (o handler do F3-B41 recusa o resto com `PAYLOAD_INVALIDO`). */
export function resumoConferenciaValeValido(resumo: string): boolean {
  const m = PADRAO_RESUMO_CONFERENCIA_VALE_REGEX.exec(resumo);
  if (!m) return false;
  const iteracoes = Number(m[1]);
  return iteracoes >= VALE_CONFERENCIA_ITERACOES_MINIMO && iteracoes <= VALE_CONFERENCIA_ITERACOES_MAXIMO;
}

/**
 * Confere os 4 dígitos digitados contra o resumo do vale. Resumo fora do formato, código do vale inválido ou
 * conferência que não tem 4 dígitos dão `false` (nunca exceção: é dado digitado ou recebido). A comparação final não
 * para no primeiro byte diferente.
 */
export async function conferirCodigoConferenciaVale(
  codigoVale: string,
  conferencia: string,
  resumo: string,
): Promise<boolean> {
  if (!PADRAO_CODIGO_VALE_REGEX.test(codigoVale) || !PADRAO_CONFERENCIA.test(conferencia)) return false;
  if (!resumoConferenciaValeValido(resumo)) return false;
  const [, iteracoes, sal, esperado] = PADRAO_RESUMO_CONFERENCIA_VALE_REGEX.exec(resumo)!;
  const calculado = await derivar(codigoVale, conferencia, deBase64Url(sal!), Number(iteracoes));
  const alvo = deBase64Url(esperado!);
  if (alvo.length !== calculado.length) return false;
  let diferenca = 0;
  for (let i = 0; i < alvo.length; i++) diferenca |= alvo[i]! ^ calculado[i]!;
  return diferenca === 0;
}
