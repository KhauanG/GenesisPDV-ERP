/**
 * Percurso seguro de um `.zip` em memória, contra zip-bomba (o processo é de todas as empresas), usado pela
 * importação de planilha (o `.xlsx`, `conferirZip` em `src/importacao/planilha.ts`) e pelos XMLs de NF-e
 * (`extrairXmlsDoZip` em `src/entradas/xml/zip.ts`), cada um com os **próprios limites** (`LimitesZip`).
 *
 * O diretório central é conferido antes de descompactar qualquer coisa: o fim (`PK\x05\x06`) está nos últimos 65 557
 * bytes; cada entrada (`PK\x01\x02`) tem o tamanho declarado somado ao total e a taxa de compressão conferida. ZIP64
 * (> 4 GiB ou > 65 535 entradas) não existe nos uploads (de 10 a 20 MB) e é recusado. A entrada só é descompactada
 * quando quem percorre pede (`ler`), e **de verdade**, com `maxOutputLength` igual ao tamanho declarado: o cabeçalho
 * que mente também para aqui. Nada vai para o disco.
 */
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';

const inflar = promisify(inflateRaw);

export interface LimitesZip {
  /** Entradas no diretório central. */
  entradas: number;
  /** Soma dos tamanhos descompactados declarados. */
  totalBytes: number;
  /** Taxa máxima (descompactado ÷ compactado) das entradas acima de `taxaAPartirDeBytes`. */
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

/**
 * Confere o diretório central inteiro contra os limites e chama `aoLerEntrada` para cada entrada, na ordem; quem
 * percorre decide o que pular, o que recusar e o que `ler`.
 */
export async function percorrerZip(
  conteudo: Buffer,
  limites: LimitesZip,
  aoLerEntrada: (entrada: EntradaZip) => Promise<void> | void,
): Promise<void> {
  const corrompido = () => new RecusaZip('corrompido');
  const grandeDemais = () => new RecusaZip('grande_demais');
  if (conteudo.length < 22) throw corrompido();
  const inicioBusca = Math.max(0, conteudo.length - 65_557);
  let fim = -1;
  for (let i = conteudo.length - 22; i >= inicioBusca; i--) {
    if (conteudo.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw corrompido();
  const entradas = conteudo.readUInt16LE(fim + 10);
  let p = conteudo.readUInt32LE(fim + 16);
  if (entradas === 0xffff || p === 0xffffffff || entradas > limites.entradas) throw grandeDemais();
  let total = 0;
  for (let n = 0; n < entradas; n++) {
    if (p + 46 > conteudo.length || conteudo.readUInt32LE(p) !== 0x02014b50) throw corrompido();
    const flags = conteudo.readUInt16LE(p + 8);
    const metodo = conteudo.readUInt16LE(p + 10);
    const compactado = conteudo.readUInt32LE(p + 20);
    const descompactado = conteudo.readUInt32LE(p + 24);
    const tamNome = conteudo.readUInt16LE(p + 28);
    const tamExtra = conteudo.readUInt16LE(p + 30);
    const tamComentario = conteudo.readUInt16LE(p + 32);
    const local = conteudo.readUInt32LE(p + 42);
    if (p + 46 + tamNome > conteudo.length) throw corrompido();
    const nome = conteudo.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + tamNome);
    p += 46 + tamNome + tamExtra + tamComentario;
    if (compactado === 0xffffffff || descompactado === 0xffffffff || local === 0xffffffff)
      throw grandeDemais();
    total += descompactado;
    if (total > limites.totalBytes) throw grandeDemais();
    if (descompactado > limites.taxaAPartirDeBytes && descompactado > compactado * limites.taxa)
      throw grandeDemais();
    const ler = async (): Promise<Buffer> => {
      if (flags & 0x1) throw corrompido(); // criptografado
      if (metodo !== 0 && metodo !== 8) throw corrompido();
      if (local + 30 > conteudo.length || conteudo.readUInt32LE(local) !== 0x04034b50) throw corrompido();
      const dados = local + 30 + conteudo.readUInt16LE(local + 26) + conteudo.readUInt16LE(local + 28);
      const bruto = conteudo.subarray(dados, dados + compactado);
      if (bruto.length !== compactado) throw corrompido();
      if (metodo === 0) {
        if (bruto.length !== descompactado) throw corrompido();
        return Buffer.from(bruto);
      }
      let saida: Buffer;
      try {
        saida = await inflar(bruto, { maxOutputLength: Math.max(descompactado, 1) });
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
          throw grandeDemais();
        throw corrompido();
      }
      if (saida.length !== descompactado) throw corrompido();
      return saida;
    };
    await aoLerEntrada({ nome, descompactado, ler });
  }
}
