/**
 * Percurso seguro de um `.zip` em memória, contra zip-bomba (o processo é de todas as empresas), usado pela
 * importação de planilha (o `.xlsx`, `conferirZip` em `src/importacao/planilha.ts`) e pelos XMLs de NF-e
 * (`extrairXmlsDoZip` em `src/entradas/xml/zip.ts`), cada um com os **próprios limites** (`LimitesZip`).
 *
 * O diretório central é conferido antes de descompactar qualquer coisa: o fim (`PK\x05\x06`) está nos últimos 65 557
 * bytes; cada entrada (`PK\x01\x02`) tem o tamanho declarado somado ao total e a taxa de compressão conferida (a da
 * entrada grande e a do arquivo inteiro). ZIP64 de verdade (> 4 GiB ou > 65 535 entradas, com 0xFFFFFFFF/0xFFFF no
 * diretório central ou no fim) não existe nos uploads (de 10 a 20 MB) e é recusado; o arquivo pequeno gravado com os
 * cabeçalhos ZIP64 (quem gera em fluxo com o ZIP64 sempre ligado) é aceito, conferido igual ao resto. A entrada só é descompactada quando quem percorre pede (`ler`), e **de verdade**, com `maxOutputLength`
 * igual ao tamanho declarado: o cabeçalho que mente também para aqui. Nada vai para o disco.
 *
 * **Um zip só, sem bytes de fora** (README da API › decisão 197): o arquivo tem de ser exatamente o que o diretório
 * central descreve — os cabeçalhos locais, um atrás do outro a partir do byte 0, cada um com o mesmo nome, método,
 * flags e tamanhos da entrada central (no descritor de dados, quando a entrada usa a flag 0x08), sem sobreposição,
 * sem bytes antes, entre ou depois das entradas, e o diretório central seguido do fim, que fecha o arquivo (entre os
 * dois, só o registro de fim ZIP64 e o localizador dele, coerentes com o fim). Assim um
 * leitor que percorre o zip pelos cabeçalhos locais (como o da planilha) vê as mesmas entradas que foram conferidas.
 */
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

const inflar = promisify(inflateRaw);

export interface LimitesZip {
  /** Entradas no diretório central. */
  entradas: number;
  /** Soma dos tamanhos descompactados declarados. */
  totalBytes: number;
  /**
   * Taxa máxima (descompactado ÷ compactado) das entradas acima de `taxaAPartirDeBytes`, e a do arquivo inteiro
   * (a soma das entradas) quando o total passa de `taxaAPartirDeBytes`.
   */
  taxa: number;
  taxaAPartirDeBytes: number;
}

/** O zip foi recusado: corrompido (ou fora do que se lê: ZIP64, criptografia, método) ou grande demais. */
export class RecusaZip extends Error {
  constructor(readonly motivo: 'corrompido' | 'grande_demais') {
    super(motivo === 'corrompido' ? 'zip corrompido' : 'zip grande demais');
    this.name = 'RecusaZip';
  }
}

export interface EntradaZip {
  nome: string;
  /** Tamanho descompactado declarado no diretório central (o `ler` confere o real). */
  descompactado: number;
  /** Descompacta a entrada (com o teto do tamanho declarado); recusa com `RecusaZip`. */
  ler(): Promise<Buffer>;
}

const ASSINATURA_LOCAL = 0x04034b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_FIM = 0x06054b50;
const ASSINATURA_DESCRITOR = 0x08074b50;
const ASSINATURA_FIM_ZIP64 = 0x06064b50;
const ASSINATURA_LOCALIZADOR_ZIP64 = 0x07064b50;
/** O registro de fim ZIP64 sem dados extensíveis: 12 bytes de cabeçalho e 44 declarados. */
const TAMANHO_FIM_ZIP64 = 56;
const TAMANHO_LOCALIZADOR_ZIP64 = 20;
/** Flags que têm de bater entre o cabeçalho local e o central: criptografia (0x01) e descritor de dados (0x08). */
const FLAGS_CONFERIDAS = 0x01 | 0x08;

interface RegistroZip {
  nome: string;
  flags: number;
  metodo: number;
  compactado: number;
  descompactado: number;
  /** Início do cabeçalho local. */
  local: number;
  /** Início dos dados compactados. */
  dados: number;
  /** Fim da entrada (depois dos dados e do descritor, quando há). */
  fim: number;
}

/**
 * Confere o diretório central inteiro contra os limites e a estrutura do arquivo (um zip só, sem bytes de fora) e
 * depois chama `aoLerEntrada` para cada entrada, na ordem do diretório central; quem percorre decide o que pular, o
 * que recusar e o que `ler`.
 */
export async function percorrerZip(
  conteudo: Buffer,
  limites: LimitesZip,
  aoLerEntrada: (entrada: EntradaZip) => Promise<void> | void,
): Promise<void> {
  const registros = conferirEstrutura(conteudo, limites);
  for (const r of registros) {
    await aoLerEntrada({ nome: r.nome, descompactado: r.descompactado, ler: () => lerEntrada(conteudo, r) });
  }
}

const corrompido = () => new RecusaZip('corrompido');
const grandeDemais = () => new RecusaZip('grande_demais');

/** O diretório central, os limites e a estrutura (sem descompactar nada); recusa com `RecusaZip`. */
function conferirEstrutura(conteudo: Buffer, limites: LimitesZip): RegistroZip[] {
  if (conteudo.length < 22) throw corrompido();
  const inicioBusca = Math.max(0, conteudo.length - 65_557);
  let fim = -1;
  for (let i = conteudo.length - 22; i >= inicioBusca; i--) {
    if (conteudo.readUInt32LE(i) === ASSINATURA_FIM) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw corrompido();
  const entradas = conteudo.readUInt16LE(fim + 10);
  const tamanhoCentral = conteudo.readUInt32LE(fim + 12);
  const inicioCentral = conteudo.readUInt32LE(fim + 16);
  if (entradas === 0xffff || inicioCentral === 0xffffffff || tamanhoCentral === 0xffffffff)
    throw grandeDemais();
  if (entradas > limites.entradas) throw grandeDemais();
  // Um disco só, todas as entradas nele, e o comentário do fim fecha o arquivo (nada depois).
  if (
    conteudo.readUInt16LE(fim + 4) !== 0 ||
    conteudo.readUInt16LE(fim + 6) !== 0 ||
    conteudo.readUInt16LE(fim + 8) !== entradas ||
    fim + 22 + conteudo.readUInt16LE(fim + 20) !== conteudo.length
  )
    throw corrompido();

  const registros: RegistroZip[] = [];
  let p = inicioCentral;
  let total = 0;
  let totalCompactado = 0;
  for (let n = 0; n < entradas; n++) {
    if (p + 46 > fim || conteudo.readUInt32LE(p) !== ASSINATURA_CENTRAL) throw corrompido();
    const flags = conteudo.readUInt16LE(p + 8);
    const metodo = conteudo.readUInt16LE(p + 10);
    const crc = conteudo.readUInt32LE(p + 16);
    const compactado = conteudo.readUInt32LE(p + 20);
    const descompactado = conteudo.readUInt32LE(p + 24);
    const tamNome = conteudo.readUInt16LE(p + 28);
    const tamExtra = conteudo.readUInt16LE(p + 30);
    const tamComentario = conteudo.readUInt16LE(p + 32);
    const local = conteudo.readUInt32LE(p + 42);
    if (p + 46 + tamNome > fim) throw corrompido();
    const nomeBytes = conteudo.subarray(p + 46, p + 46 + tamNome);
    const nome = nomeBytes.toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + tamNome + tamExtra + tamComentario;
    if (p > fim) throw corrompido();
    if (compactado === 0xffffffff || descompactado === 0xffffffff || local === 0xffffffff)
      throw grandeDemais();
    total += descompactado;
    totalCompactado += compactado;
    if (total > limites.totalBytes) throw grandeDemais();
    if (descompactado > limites.taxaAPartirDeBytes && descompactado > compactado * limites.taxa)
      throw grandeDemais();

    // O cabeçalho local tem de ser o desta entrada: mesmo nome, método e flags; os tamanhos iguais (ou zerados, com
    // os de verdade no descritor de dados logo depois dos dados, quando a entrada usa a flag 0x08).
    if (local + 30 > fim || conteudo.readUInt32LE(local) !== ASSINATURA_LOCAL) throw corrompido();
    const flagsLocal = conteudo.readUInt16LE(local + 6);
    const compactadoLocal = conteudo.readUInt32LE(local + 18);
    const descompactadoLocal = conteudo.readUInt32LE(local + 22);
    const tamNomeLocal = conteudo.readUInt16LE(local + 26);
    const dados = local + 30 + tamNomeLocal + conteudo.readUInt16LE(local + 28);
    if (
      dados > fim ||
      conteudo.readUInt16LE(local + 8) !== metodo ||
      ((flagsLocal ^ flags) & FLAGS_CONFERIDAS) !== 0 ||
      !conteudo.subarray(local + 30, local + 30 + tamNomeLocal).equals(nomeBytes)
    )
      throw corrompido();
    const comDescritor = (flags & 0x08) !== 0;
    const tamanhoBate = (lido: number, declarado: number) =>
      lido === declarado || (comDescritor && lido === 0);
    // Cabeçalho local ZIP64 (os dois tamanhos em 0xFFFFFFFF): os de verdade estão no extra 0x0001 do próprio
    // cabeçalho local, com 8 bytes cada (descompactado e depois compactado), iguais aos do diretório central (ou
    // zerados, com o descritor). Com esse extra, o descritor também traz os tamanhos com 8 bytes.
    const extra = extraZip64(conteudo, local + 30 + tamNomeLocal, dados);
    if (compactadoLocal === 0xffffffff || descompactadoLocal === 0xffffffff) {
      if (
        compactadoLocal !== 0xffffffff ||
        descompactadoLocal !== 0xffffffff ||
        !extra ||
        extra.tamanho < 16 ||
        !tamanhoBate(ler64(conteudo, extra.inicio), descompactado) ||
        !tamanhoBate(ler64(conteudo, extra.inicio + 8), compactado)
      )
        throw corrompido();
    } else if (!tamanhoBate(compactadoLocal, compactado) || !tamanhoBate(descompactadoLocal, descompactado))
      throw corrompido();
    let fimEntrada = dados + compactado;
    if (fimEntrada > fim) throw corrompido();
    if (comDescritor) {
      // O descritor (com ou sem a assinatura) repete o CRC e os tamanhos do diretório central (de 8 bytes cada,
      // quando o cabeçalho local tem o extra ZIP64).
      const d =
        fimEntrada + 4 <= fim && conteudo.readUInt32LE(fimEntrada) === ASSINATURA_DESCRITOR
          ? fimEntrada + 4
          : fimEntrada;
      const larg = extra ? 8 : 4;
      const lerTamanho = (i: number) => (extra ? ler64(conteudo, i) : conteudo.readUInt32LE(i));
      if (
        d + 4 + 2 * larg > fim ||
        conteudo.readUInt32LE(d) !== crc ||
        lerTamanho(d + 4) !== compactado ||
        lerTamanho(d + 4 + larg) !== descompactado
      )
        throw corrompido();
      fimEntrada = d + 4 + 2 * larg;
    }
    registros.push({ nome, flags, metodo, compactado, descompactado, local, dados, fim: fimEntrada });
  }
  // A taxa do arquivo inteiro: muitas entradas pequenas (abaixo do limite da taxa por entrada) também respeitam o limite total.
  if (total > limites.taxaAPartirDeBytes && total > totalCompactado * limites.taxa) throw grandeDemais();
  // O diretório central vai até o fim (ou até o registro de fim ZIP64 e o localizador), com o tamanho que o fim declara.
  if (tamanhoCentral !== p - inicioCentral) throw corrompido();
  if (p !== fim) conferirFimZip64(conteudo, p, fim, entradas, inicioCentral, tamanhoCentral);
  // As entradas cobrem o arquivo do byte 0 até o diretório central, uma atrás da outra: nada antes, entre ou por
  // cima de outra (duas entradas centrais no mesmo cabeçalho local), nenhuma entrada fora do diretório central.
  let cursor = 0;
  for (const r of [...registros].sort((a, b) => a.local - b.local)) {
    if (r.local !== cursor) throw corrompido();
    cursor = r.fim;
  }
  if (cursor !== inicioCentral) throw corrompido();
  return registros;
}

/**
 * Entre o diretório central (que termina em `p`) e o fim só cabe o par do ZIP64: o registro de fim ZIP64
 * (`PK\x06\x06`, sem dados extensíveis) logo depois do diretório central e o localizador (`PK\x06\x07`) logo antes do
 * fim, apontando para ele; os dois de um disco só e com o mesmo número de entradas, início e tamanho do diretório
 * central que o fim declara. Fora disso, `corrompido`.
 */
function conferirFimZip64(
  conteudo: Buffer,
  p: number,
  fim: number,
  entradas: number,
  inicioCentral: number,
  tamanhoCentral: number,
): void {
  const localizador = fim - TAMANHO_LOCALIZADOR_ZIP64;
  if (
    p + TAMANHO_FIM_ZIP64 !== localizador ||
    conteudo.readUInt32LE(p) !== ASSINATURA_FIM_ZIP64 ||
    ler64(conteudo, p + 4) !== TAMANHO_FIM_ZIP64 - 12 ||
    conteudo.readUInt32LE(p + 16) !== 0 ||
    conteudo.readUInt32LE(p + 20) !== 0 ||
    ler64(conteudo, p + 24) !== entradas ||
    ler64(conteudo, p + 32) !== entradas ||
    ler64(conteudo, p + 40) !== tamanhoCentral ||
    ler64(conteudo, p + 48) !== inicioCentral ||
    conteudo.readUInt32LE(localizador) !== ASSINATURA_LOCALIZADOR_ZIP64 ||
    conteudo.readUInt32LE(localizador + 4) !== 0 ||
    ler64(conteudo, localizador + 8) !== p ||
    conteudo.readUInt32LE(localizador + 16) > 1
  )
    throw corrompido();
}

/**
 * O extra ZIP64 (0x0001) no campo extra de `inicio` a `fim` de um cabeçalho local: o início e o tamanho dos dados dele.
 * Um registro que passa do campo (o enchimento de alinhamento de alguns geradores) encerra a busca.
 */
function extraZip64(
  conteudo: Buffer,
  inicio: number,
  fim: number,
): { inicio: number; tamanho: number } | null {
  for (let q = inicio; q + 4 <= fim;) {
    const id = conteudo.readUInt16LE(q);
    const tamanho = conteudo.readUInt16LE(q + 2);
    if (q + 4 + tamanho > fim) return null;
    if (id === 0x0001) return { inicio: q + 4, tamanho };
    q += 4 + tamanho;
  }
  return null;
}

/** Inteiro de 8 bytes; o que passa de 32 bits vira -1 (nunca bate com um tamanho ou deslocamento de 32 bits). */
function ler64(conteudo: Buffer, i: number): number {
  return conteudo.readUInt32LE(i + 4) === 0 ? conteudo.readUInt32LE(i) : -1;
}

async function lerEntrada(conteudo: Buffer, r: RegistroZip): Promise<Buffer> {
  if (r.flags & 0x1) throw corrompido(); // criptografado
  if (r.metodo !== 0 && r.metodo !== 8) throw corrompido();
  const bruto = conteudo.subarray(r.dados, r.dados + r.compactado);
  if (bruto.length !== r.compactado) throw corrompido();
  if (r.metodo === 0) {
    if (bruto.length !== r.descompactado) throw corrompido();
    return Buffer.from(bruto);
  }
  let saida: Buffer;
  try {
    saida = await inflar(bruto, { maxOutputLength: Math.max(r.descompactado, 1) });
  } catch (e) {
    if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
      throw grandeDemais();
    throw corrompido();
  }
  if (saida.length !== r.descompactado) throw corrompido();
  return saida;
}
