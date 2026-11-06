import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argumentos } from './comum.js';
import * as schema from '../database/empresa/schema/index.js';
import { gerarCsharp, tabelasPdv } from '../database/esquema-pdv.js';

const args = argumentos({ verificar: { type: 'boolean' } });
const destino = fileURLToPath(new URL('../../../pdv/src/GenesisPDV.Data/Esquema.g.cs', import.meta.url));

/**
 * `gerar:esquema-pdv`: grava o Esquema.g.cs do PDV (MD 4.1). Com `--verificar` só compara com o arquivo versionado e
 * sai com 1 se estiver desatualizado (passo do CI).
 */
const gerado = gerarCsharp(tabelasPdv(schema));
if (args.verificar) {
  const atual = await readFile(destino, 'utf8').catch(() => '');
  if (atual.replace(/\r\n/g, '\n') !== gerado) {
    console.error(
      `${destino} está desatualizado: rode "pnpm --filter api gerar:esquema-pdv" e versione o resultado.`,
    );
    process.exitCode = 1;
  } else {
    console.log('Esquema.g.cs em dia.');
  }
} else {
  await writeFile(destino, gerado, 'utf8');
  console.log(`Gerado ${destino}`);
}
