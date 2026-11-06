/**
 * Zip mínimo para os testes (F2-B18 e F2-B19): entradas com deflate ou guardadas, com o tamanho declarado à escolha
 * (o cabeçalho que mente). Sem CRC: a leitura não confere, e o tamanho real é conferido na descompactação.
 */
import { deflateRawSync } from 'node:zlib';

export interface Entrada {
  nome: string;
  dados: Buffer;
  /** Guardar sem compressão (método 0). */
  guardar?: boolean;
  /** Tamanho descompactado declarado (para o cabeçalho que mente). */
  declarado?: number;
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
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.guardar ? 0 : 8, 8);
    local.writeUInt32LE(corpo.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nome.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(e.guardar ? 0 : 8, 10);
    central.writeUInt32LE(corpo.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    locais.push(local, nome, corpo);
    centrais.push(central, nome);
    deslocamento += 30 + nome.length + corpo.length;
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
