/**
 * XMLs de NF-e dentro de um `.zip` (Fase 2, F2-B18; o upload em lote é do F2-B19): o mesmo método contra zip-bomba da
 * importação de planilha (o percurso comum `percorrerZip`, `src/comum/zip.ts`), com **limites próprios**: 1.000
 * entradas (a planilha, 100), 100 MiB descompactados no total (150 MiB), taxa ≤ 100 conferida acima de 64 KiB (1 MiB:
 * um XML de NF-e tem dezenas de KB e comprime uns 10×) e o teto por entrada do parser da NF-e (1 MiB, contra 120 MiB).
 * O diretório central é conferido antes e cada `.xml` é descompactado **de verdade** com `maxOutputLength` igual ao
 * tamanho declarado: o cabeçalho que mente também para aqui. Pastas e arquivos que não são `.xml` são pulados (o
 * resultado diz quais); nada vai para o disco.
 *
 * Os mesmos 1.000 entradas e 100 MiB valem **somados para o envio inteiro** (F2-B19: até 100 arquivos por pedido;
 * sem isso, 100 `.zip` pequenos dentro dos 20 MB descompactariam GBs no processo de todas as empresas): quem separa
 * o envio passa o `OrcamentoZipNfe` de um `.zip` para o outro, e o `.zip` que passaria do que resta é recusado como
 * `ENVIO_GRANDE_DEMAIS` **pelo diretório central**, antes de descompactar qualquer entrada.
 */
import { LIMITES_XML_NFE } from '@genesis/shared';
import { percorrerZip, RecusaZip, type LimitesZip } from '../../comum/zip.js';

export const LIMITES_ZIP_NFE: LimitesZip & { porEntradaBytes: number } = {
  entradas: 1000,
  porEntradaBytes: LIMITES_XML_NFE.bytes,
  totalBytes: 100 * 1024 * 1024,
  /** Taxa máxima (descompactado ÷ compactado) para entradas acima de 64 KiB; XML comprime uns 10×. */
  taxa: 100,
  taxaAPartirDeBytes: 64 * 1024,
};

/**
 * O zip foi recusado inteiro (`motivo` diz se é corrompido, grande demais depois de descompactado ou se passaria do
 * que resta do orçamento do envio).
 */
export class RecusaZipNfe extends Error {
  constructor(readonly motivo: 'ZIP_CORROMPIDO' | 'ZIP_GRANDE_DEMAIS' | 'ENVIO_GRANDE_DEMAIS') {
    super(
      motivo === 'ZIP_CORROMPIDO'
        ? 'O arquivo .zip está corrompido.'
        : motivo === 'ZIP_GRANDE_DEMAIS'
          ? 'O arquivo .zip é grande demais depois de descompactado. Divida o arquivo.'
          : 'Os arquivos .zip do envio, somados, são grandes demais depois de descompactados.',
    );
    this.name = 'RecusaZipNfe';
  }
}

/** O que ainda cabe no envio (entradas e bytes descompactados declarados), gasto a cada `.zip` aceito. */
export interface OrcamentoZipNfe {
  entradas: number;
  bytes: number;
}

/** O orçamento de um envio: os mesmos limites de um `.zip`, para todos os `.zip` do pedido juntos. */
export const novoOrcamentoZipNfe = (): OrcamentoZipNfe => ({
  entradas: LIMITES_ZIP_NFE.entradas,
  bytes: LIMITES_ZIP_NFE.totalBytes,
});

export interface ArquivoDoZip {
  nome: string;
  conteudo: Buffer;
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function ehZip(conteudo: Buffer): boolean {
  return conteudo.subarray(0, 4).equals(ZIP);
}

/**
 * Os `.xml` do zip, na ordem do diretório central; os nomes que não são XML (`pulados`) e os XMLs acima do teto do
 * parser (`grandesDemais`, recusados um a um como `XML_GRANDE_DEMAIS` sem derrubar o lote). Com o `orcamento` do
 * envio: o diretório central é conferido primeiro (sem descompactar nada) contra os limites do `.zip` e contra o que
 * resta do envio, e o `.zip` aceito gasta do orçamento as entradas e os bytes declarados.
 */
export async function extrairXmlsDoZip(
  conteudo: Buffer,
  orcamento?: OrcamentoZipNfe,
): Promise<{ xmls: ArquivoDoZip[]; pulados: string[]; grandesDemais: string[] }> {
  const xmls: ArquivoDoZip[] = [];
  const pulados: string[] = [];
  const grandesDemais: string[] = [];
  try {
    if (orcamento) {
      let entradas = 0;
      let bytes = 0;
      await percorrerZip(conteudo, LIMITES_ZIP_NFE, (entrada) => {
        entradas++;
        bytes += entrada.descompactado;
      });
      if (entradas > orcamento.entradas || bytes > orcamento.bytes)
        throw new RecusaZipNfe('ENVIO_GRANDE_DEMAIS');
      orcamento.entradas -= entradas;
      orcamento.bytes -= bytes;
    }
    await percorrerZip(conteudo, LIMITES_ZIP_NFE, async (entrada) => {
      if (entrada.nome.endsWith('/')) return;
      if (!/\.xml$/i.test(entrada.nome)) {
        pulados.push(entrada.nome);
        return;
      }
      if (entrada.descompactado > LIMITES_ZIP_NFE.porEntradaBytes) {
        grandesDemais.push(entrada.nome);
        return;
      }
      xmls.push({ nome: entrada.nome, conteudo: await entrada.ler() });
    });
  } catch (e) {
    if (e instanceof RecusaZipNfe) throw e;
    if (!(e instanceof RecusaZip)) throw e;
    throw new RecusaZipNfe(e.motivo === 'corrompido' ? 'ZIP_CORROMPIDO' : 'ZIP_GRANDE_DEMAIS');
  }
  return { xmls, pulados, grandesDemais };
}
