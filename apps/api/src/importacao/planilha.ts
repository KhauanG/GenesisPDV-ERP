/**
 * Leitura da planilha da importação (ERP 8.6): `.xlsx` (primeira aba) ou `.csv` (separador `;`, `,` ou tab
 * detectado pelo cabeçalho; UTF-8 com ou sem BOM ou Windows-1252, que é como o Excel em pt-BR salva o CSV). Devolve o
 * cabeçalho e as linhas como valores crus (número/booleano/data do xlsx, texto do CSV); linhas totalmente vazias
 * saem, mas o número da linha original é mantido para o relatório.
 */
import { Logger } from '@nestjs/common';
import { LIMITE_LINHAS_IMPORTACAO } from '@genesis/shared';
import { readSheet } from 'read-excel-file/node';
import { ErroApi } from '../comum/erros.js';
import { limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';
import { percorrerZip, RecusaZip, type LimitesZip } from '../comum/zip.js';

const log = new Logger('Planilha');

/**
 * Limites contra planilha-bomba (o processo é de todas as empresas): o `.xlsx` é um zip e o `read-excel-file`
 * descompacta tudo em memória sem teto. Antes de ler, o diretório central é conferido (entradas, tamanho
 * descompactado por entrada e total, taxa de compressão) e cada entrada é descompactada **de verdade** com
 * `maxOutputLength` igual ao tamanho declarado (cabeçalho mentiroso também é recusado), pelo percurso comum
 * (`percorrerZip`, o mesmo dos XMLs de NF-e, com limites próprios). No máximo `PLANILHA_CONCORRENCIA` (padrão 2)
 * leituras ao mesmo tempo no processo.
 */
export const LIMITES_ZIP: LimitesZip & { porEntradaBytes: number } = {
  entradas: 100,
  porEntradaBytes: 120 * 1024 * 1024,
  totalBytes: 150 * 1024 * 1024,
  /** Taxa máxima (descompactado ÷ compactado) para entradas acima de 1 MiB. */
  taxa: 100,
  taxaAPartirDeBytes: 1024 * 1024,
};
/** Colunas por linha (o layout tem ~45; o Nuvem3 exporta menos de 100). */
export const LIMITE_COLUNAS_PLANILHA = 300;
const semaforoPlanilha = new Semaforo(limiteDoAmbiente('PLANILHA_CONCORRENCIA', 2));
const MENSAGEM_ILEGIVEL =
  'Não foi possível ler a planilha: salve de novo como .xlsx ou .csv e envie outra vez.';

export type Celula = string | number | boolean | Date | null;

export interface LinhaPlanilha {
  /** Número da linha na planilha (cabeçalho = 1). */
  numero: number;
  valores: Celula[];
}

export interface Planilha {
  cabecalho: string[];
  linhas: LinhaPlanilha[];
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function formatoPlanilha(nome: string, conteudo: Buffer): 'xlsx' | 'csv' {
  if (conteudo.subarray(0, 4).equals(ZIP)) return 'xlsx';
  if (/\.xlsx$/i.test(nome)) throw new ErroApi('VALIDACAO', 'O arquivo .xlsx está corrompido.');
  if (/\.xls$/i.test(nome))
    throw new ErroApi('VALIDACAO', 'Planilha .xls (Excel 97–2003) não é aceita: salve como .xlsx ou .csv.');
  return 'csv';
}

export async function lerPlanilha(nome: string, conteudo: Buffer): Promise<Planilha> {
  const linhas = await semaforoPlanilha.executar(async () =>
    formatoPlanilha(nome, conteudo) === 'xlsx' ? await lerXlsx(conteudo) : lerCsv(conteudo),
  );
  const primeira = linhas.findIndex((l) => l.some((c) => !vazia(c)));
  if (primeira < 0) throw new ErroApi('VALIDACAO', 'A planilha está vazia.');
  const cabecalho = linhas[primeira]!.map((c) => (c === null ? '' : String(c).trim()));
  const dados: LinhaPlanilha[] = [];
  for (let i = primeira + 1; i < linhas.length; i++) {
    const valores = linhas[i]!;
    if (valores.every(vazia)) continue;
    dados.push({ numero: i + 1, valores });
  }
  if (dados.length > LIMITE_LINHAS_IMPORTACAO) {
    throw new ErroApi(
      'VALIDACAO',
      `A planilha tem ${dados.length.toLocaleString('pt-BR')} linhas; o limite é ${LIMITE_LINHAS_IMPORTACAO.toLocaleString('pt-BR')}. Divida o arquivo.`,
    );
  }
  return { cabecalho, linhas: dados };
}

const vazia = (c: Celula) => c === null || (typeof c === 'string' && c.trim() === '');

const grandeDemais = () =>
  new ErroApi(
    'VALIDACAO',
    'A planilha é grande demais depois de descompactada. Divida o arquivo ou salve como .csv.',
  );

/**
 * Confere o zip do `.xlsx` antes do `readSheet` (LIMITES_ZIP), com o percurso comum (`percorrerZip`, `comum/zip.ts`):
 * o diretório central e cada entrada descompactada de verdade, com o teto do tamanho declarado.
 */
export async function conferirZip(conteudo: Buffer): Promise<void> {
  try {
    await percorrerZip(conteudo, LIMITES_ZIP, async (entrada) => {
      if (entrada.descompactado > LIMITES_ZIP.porEntradaBytes) throw new RecusaZip('grande_demais');
      await entrada.ler();
    });
  } catch (e) {
    if (!(e instanceof RecusaZip)) throw e;
    throw e.motivo === 'grande_demais'
      ? grandeDemais()
      : new ErroApi('VALIDACAO', 'O arquivo .xlsx está corrompido.');
  }
}

async function lerXlsx(conteudo: Buffer): Promise<Celula[][]> {
  await conferirZip(conteudo);
  let dados: unknown[][];
  try {
    dados = (await readSheet(conteudo)) as unknown[][];
  } catch (e) {
    // A mensagem da biblioteca fica no log (não é útil ao usuário e expõe detalhes internos).
    log.warn(`Falha ao ler .xlsx: ${(e as Error).message}`);
    throw new ErroApi('VALIDACAO', MENSAGEM_ILEGIVEL);
  }
  if (dados.length > LIMITE_LINHAS_IMPORTACAO * 2 + 1) throw linhasDemais(dados.length);
  if (dados.some((l) => l.length > LIMITE_COLUNAS_PLANILHA)) throw colunasDemais();
  return dados.map((linha) => linha.map((c) => (c === undefined ? null : (c as Celula))));
}

const linhasDemais = (n: number | null) =>
  new ErroApi(
    'VALIDACAO',
    `A planilha tem ${n === null ? 'mais de ' : ''}${(n ?? LIMITE_LINHAS_IMPORTACAO).toLocaleString('pt-BR')} linhas; o limite é ${LIMITE_LINHAS_IMPORTACAO.toLocaleString('pt-BR')}. Divida o arquivo.`,
  );
const colunasDemais = () =>
  new ErroApi(
    'VALIDACAO',
    `A planilha tem mais de ${LIMITE_COLUNAS_PLANILHA} colunas. Confira o separador do CSV ou apague as colunas extras.`,
  );

/**
 * Cara de UTF-16 sem BOM: nas primeiras centenas de bytes, quase todo byte de uma das posições (par ou ímpar) é zero e
 * os da outra não (o texto ASCII gravado em UTF-16). O texto simples nunca tem tantos bytes zero.
 */
function utf16SemBom(conteudo: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(conteudo.length, 512) & ~1;
  if (n < 4) return null;
  let zeroPar = 0;
  let zeroImpar = 0;
  for (let i = 0; i < n; i += 2) {
    if (conteudo[i] === 0) zeroPar++;
    if (conteudo[i + 1] === 0) zeroImpar++;
  }
  const metade = n / 2;
  if (zeroImpar >= metade * 0.9 && zeroPar <= metade * 0.1) return 'utf-16le';
  if (zeroPar >= metade * 0.9 && zeroImpar <= metade * 0.1) return 'utf-16be';
  return null;
}

/**
 * UTF-16 com BOM (`FF FE`/`FE FF`, o "Texto Unicode" do Excel) ou com cara de UTF-16, UTF-8 válido (com ou sem BOM)
 * ou Windows-1252. Sem a conferência do UTF-16 ele caía no Windows-1252 com um U+0000 entre os caracteres, que o
 * Postgres recusa (22021).
 */
export function decodificarTexto(conteudo: Buffer): string {
  if (conteudo[0] === 0xff && conteudo[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(conteudo.subarray(2));
  if (conteudo[0] === 0xfe && conteudo[1] === 0xff)
    return new TextDecoder('utf-16be').decode(conteudo.subarray(2));
  const utf16 = utf16SemBom(conteudo);
  if (utf16) return new TextDecoder(utf16).decode(conteudo);
  const semBom =
    conteudo[0] === 0xef && conteudo[1] === 0xbb && conteudo[2] === 0xbf ? conteudo.subarray(3) : conteudo;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(semBom);
  } catch {
    return new TextDecoder('windows-1252').decode(semBom);
  }
}

/** CSV (RFC 4180 com aspas duplas); o separador é o que mais aparece no cabeçalho fora de aspas. */
export function lerCsv(conteudo: Buffer): Celula[][] {
  const texto = decodificarTexto(conteudo);
  const primeiraLinha = texto.slice(0, texto.search(/\r?\n|$/));
  const contar = (s: string) => primeiraLinha.replace(/"[^"]*"/g, '').split(s).length - 1;
  const separador = [';', '\t', ','].reduce((melhor, s) => (contar(s) > contar(melhor) ? s : melhor), ';');
  const linhas: Celula[][] = [];
  let linha: Celula[] = [];
  let campo = '';
  let aspas = false;
  // Limites conferidos durante a leitura (10 MB de quebras de linha ou de separadores não viram milhões de células).
  let comDados = 0;
  const fecharLinha = () => {
    if (linha.length > 1 || (linha[0] !== undefined && linha[0] !== '')) comDados++;
    if (comDados > LIMITE_LINHAS_IMPORTACAO + 1) throw linhasDemais(null);
    if (linhas.length > LIMITE_LINHAS_IMPORTACAO * 2) throw linhasDemais(null);
    linhas.push(linha);
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
    } else if (c === '"' && campo === '') aspas = true;
    else if (c === separador) {
      linha.push(campo);
      campo = '';
      if (linha.length >= LIMITE_COLUNAS_PLANILHA) throw colunasDemais();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo);
      fecharLinha();
      linha = [];
      campo = '';
    } else campo += c;
  }
  if (campo !== '' || linha.length) {
    linha.push(campo);
    fecharLinha();
  }
  // Apóstrofo inicial é a proteção contra fórmula da nossa exportação (comum/exportacao.ts).
  return linhas.map((l) => l.map((v) => (typeof v === 'string' ? v.replace(/^'(?=[=+\-@])/, '') : v)));
}
