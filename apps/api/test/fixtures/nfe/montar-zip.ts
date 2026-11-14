/**
 * Zip mínimo para os testes (F2-B18 e F2-B19): entradas com deflate ou guardadas, com o tamanho declarado à escolha
 * (o cabeçalho que mente) e, se pedido, gravadas em fluxo (descritor de dados). Sem CRC: a leitura não confere, e o
 * tamanho real é conferido na descompactação. Também as peças de um zip fora da estrutura (entrada só no cabeçalho
 * local, fim sem entradas) e as variantes ZIP64 de arquivo pequeno (o extra 0x0001 no cabeçalho local, o registro de
 * fim ZIP64), para os testes do percurso comum (README da API › decisão 197).
 */
import { deflateRawSync } from 'node:zlib';

export interface Entrada {
  nome: string;
  dados: Buffer;
  /** Guardar sem compressão (método 0). */
  guardar?: boolean;
  /** Tamanho descompactado declarado (para o cabeçalho que mente). */
  declarado?: number;
  /**
   * Gravado em fluxo (flag 0x08): o cabeçalho local sem os tamanhos e o descritor de dados (com a assinatura) depois
   * dos dados, como fazem os geradores de planilha que escrevem sem voltar no arquivo.
   */
  descritor?: boolean;
  /**
   * Cabeçalho local ZIP64, como quem grava com o ZIP64 sempre ligado (Python `force_zip64`, Info-ZIP lendo da entrada
   * padrão): os tamanhos em 0xFFFFFFFF e os de verdade no extra 0x0001 (zerados com o `descritor`, que passa a ter os
   * tamanhos com 8 bytes). O diretório central continua com os tamanhos de 32 bits.
   */
  zip64?: boolean;
}

/** Monta um zip mínimo (sem CRC: a leitura não confere, e o tamanho real é conferido na descompactação). */
export function montarZip(entradas: Entrada[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const corpo = e.guardar ? e.dados : deflateRawSync(e.dados);
    const declarado = e.declarado ?? e.dados.length;
    const flags = 0x800 | (e.descritor ? 0x08 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.guardar ? 0 : 8, 8);
    local.writeUInt32LE(e.zip64 ? 0xffffffff : e.descritor ? 0 : corpo.length, 18);
    local.writeUInt32LE(e.zip64 ? 0xffffffff : e.descritor ? 0 : declarado, 22);
    local.writeUInt16LE(nome.length, 26);
    const extra = Buffer.alloc(e.zip64 ? 20 : 0);
    if (e.zip64) {
      local.writeUInt16LE(extra.length, 28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeUInt32LE(e.descritor ? 0 : declarado, 4);
      extra.writeUInt32LE(e.descritor ? 0 : corpo.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(e.guardar ? 0 : 8, 10);
    central.writeUInt32LE(corpo.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    const larg = e.zip64 ? 8 : 4;
    const descritor = Buffer.alloc(e.descritor ? 8 + 2 * larg : 0);
    if (e.descritor) {
      descritor.writeUInt32LE(0x08074b50, 0);
      descritor.writeUInt32LE(corpo.length, 8);
      descritor.writeUInt32LE(declarado, 8 + larg);
    }
    locais.push(local, nome, extra, corpo, descritor);
    centrais.push(central, nome);
    deslocamento += 30 + nome.length + extra.length + corpo.length + descritor.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

/** Bytes inseridos logo antes do diretório central de um zip sem comentário (o fim aponta o diretório no lugar novo). */
export function inserirAntesDoCentral(zip: Buffer, extra: Buffer): Buffer {
  const fim = zip.length - 22;
  const inicioCentral = zip.readUInt32LE(fim + 16);
  const novo = Buffer.concat([zip.subarray(0, inicioCentral), extra, zip.subarray(inicioCentral)]);
  novo.writeUInt32LE(inicioCentral + extra.length, novo.length - 22 + 16);
  return novo;
}

/**
 * Um cabeçalho local com os dados (deflate), sem entrada no diretório central; com `descritor`, gravado em fluxo
 * (flag 0x08, os tamanhos só no descritor de dados depois dos dados).
 */
export function entradaSoLocal(nome: string, dados: Buffer, descritor = false): Buffer {
  const n = Buffer.from(nome);
  const corpo = deflateRawSync(dados);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(descritor ? 0x08 : 0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(descritor ? 0 : corpo.length, 18);
  local.writeUInt32LE(descritor ? 0 : dados.length, 22);
  local.writeUInt16LE(n.length, 26);
  if (!descritor) return Buffer.concat([local, n, corpo]);
  const fimDados = Buffer.alloc(16);
  fimDados.writeUInt32LE(0x08074b50, 0);
  fimDados.writeUInt32LE(corpo.length, 8);
  fimDados.writeUInt32LE(dados.length, 12);
  return Buffer.concat([local, n, corpo, fimDados]);
}

/**
 * O mesmo zip (sem comentário) com o registro de fim ZIP64 (`PK\x06\x06`) e o localizador (`PK\x06\x07`) entre o
 * diretório central e o fim, coerentes com ele, como grava o Info-ZIP lendo da entrada padrão.
 */
export function comFimZip64(zip: Buffer): Buffer {
  const fim = zip.length - 22;
  const entradas = zip.readUInt16LE(fim + 10);
  const tamanhoCentral = zip.readUInt32LE(fim + 12);
  const inicioCentral = zip.readUInt32LE(fim + 16);
  const registro = Buffer.alloc(56);
  registro.writeUInt32LE(0x06064b50, 0);
  registro.writeUInt32LE(44, 4);
  registro.writeUInt16LE(0x031e, 12);
  registro.writeUInt16LE(45, 14);
  registro.writeUInt32LE(entradas, 24);
  registro.writeUInt32LE(entradas, 32);
  registro.writeUInt32LE(tamanhoCentral, 40);
  registro.writeUInt32LE(inicioCentral, 48);
  const localizador = Buffer.alloc(20);
  localizador.writeUInt32LE(0x07064b50, 0);
  localizador.writeUInt32LE(fim, 8);
  localizador.writeUInt32LE(1, 16);
  return Buffer.concat([zip.subarray(0, fim), registro, localizador, zip.subarray(fim)]);
}

/** O fim (EOCD) de um zip sem entradas no diretório central, que começa em `inicioCentral`. */
export function fimSemEntradas(inicioCentral: number): Buffer {
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt32LE(inicioCentral, 16);
  return fim;
}
