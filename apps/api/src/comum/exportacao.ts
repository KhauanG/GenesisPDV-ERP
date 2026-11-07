import type { Writable } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { permissaoExiste, type FormatoExportacao } from '@genesis/shared';
import ExcelJS from 'exceljs';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from './erros.js';
import { limiteDoAmbiente, Semaforo } from './limites-processo.js';

export type ValorExportado = string | number | boolean | Date | null | undefined;

export interface ColunaExportacao<T> {
  rotulo: string;
  valor: (linha: T) => ValorExportado;
  /** Custo, custo médio, markup ou total a custo: sai do arquivo sem `produtos.ver_custo` (`colunasVisiveis`). */
  custo?: boolean;
  /** Largura no `.xlsx` em streaming, em caracteres (padrão: a do rótulo, entre 10 e 60). */
  largura?: number;
}

/** Tira as colunas de custo de quem não tem `produtos.ver_custo` (MD 3.6.3; o mesmo corte das telas). */
export function colunasVisiveis<T>(
  colunas: readonly ColunaExportacao<T>[],
  sessao: Pick<SessaoErp, 'permissoes'>,
): ColunaExportacao<T>[] {
  const verCusto = sessao.permissoes.has('produtos.ver_custo');
  return colunas.filter((c) => verCusto || !c.custo);
}

/**
 * Concorrência da geração de arquivo no processo (decisão 93, como a leitura de planilha): a exportação na hora e a
 * de relatório em tarefa (F2-B29) disputam as mesmas vagas (`EXPORTACAO_CONCORRENCIA`, 2). A tarefa segura a vaga
 * por minutos e a fila das tarefas roda uma por vez por processo; por isso o mínimo é 2 (um valor menor no ambiente
 * vale 2): sempre sobra ao menos uma vaga para quem baixa na hora.
 */
export const semaforoExportacao = new Semaforo(Math.max(2, limiteDoAmbiente('EXPORTACAO_CONCORRENCIA', 2)));

const FUSO = 'America/Sao_Paulo';
const partesDataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partes(d: Date): Record<'day' | 'month' | 'year' | 'hour' | 'minute' | 'second', string> {
  const p = Object.fromEntries(partesDataHora.formatToParts(d).map((x) => [x.type, x.value]));
  return p as Record<'day' | 'month' | 'year' | 'hour' | 'minute' | 'second', string>;
}

/** `dd/mm/aaaa hh:mm` no fuso da empresa (ERP 1.5). */
export function dataHoraBr(d: Date): string {
  const p = partes(d);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/**
 * O xlsx não tem fuso: a célula guarda a hora "de parede". Desloca o instante para que o Excel mostre a hora de
 * Brasília, e não a UTC.
 */
function horaDeParede(d: Date): Date {
  const p = partes(d);
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}

/**
 * Texto que começa com `= + - @` (ou tab/CR) vira fórmula no Excel/LibreOffice ao abrir o CSV ("CSV injection"):
 * prefixar com apóstrofo mantém o valor visível sem executá-lo.
 */
function neutralizarFormula(texto: string): string {
  return /^[=+\-@\t\r]/.test(texto) ? `'${texto}` : texto;
}

function textoCsv(v: ValorExportado): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return dataHoraBr(v);
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  // Separador decimal brasileiro: o Excel em pt-BR abre o CSV com `;` e `,`.
  if (typeof v === 'number') return String(v).replace('.', ',');
  const t = neutralizarFormula(v);
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

const BOM = '\uFEFF';

function gerarCsv<T>(colunas: ColunaExportacao<T>[], linhas: T[]): Buffer {
  const saida = [colunas.map((c) => textoCsv(c.rotulo)).join(';')];
  for (const l of linhas) saida.push(colunas.map((c) => textoCsv(c.valor(l))).join(';'));
  // BOM: sem ele o Excel abre o UTF-8 como Latin-1 e estraga os acentos.
  return Buffer.from(`${BOM}${saida.join('\r\n')}\r\n`, 'utf8');
}

async function gerarXlsx<T>(colunas: ColunaExportacao<T>[], linhas: T[]): Promise<Buffer> {
  const dados: SheetData = [
    colunas.map((c) => ({ value: c.rotulo, fontWeight: 'bold' as const })),
    ...linhas.map((l) =>
      colunas.map((c) => {
        const v = c.valor(l);
        if (v === null || v === undefined) return null;
        if (v instanceof Date) return { value: horaDeParede(v), format: 'dd/mm/yyyy hh:mm' };
        if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
        return v;
      }),
    ),
  ];
  return writeXlsxFile(dados, { stickyRowsCount: 1 }).toBuffer();
}

export const TIPOS_EXPORTACAO: Record<FormatoExportacao, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

// ---------------------------------------------------------------- Em streaming (F2-B29)

/** Linhas de dados por aba do `.xlsx` (o Excel abre até 1.048.576 linhas, contando o cabeçalho). */
export const LINHAS_POR_ABA_XLSX = 1_048_575;

export interface EscritorPlanilha<T> {
  /** Escreve um lote e espera o destino ter folga (o lote seguinte só é lido depois). */
  escrever(linhas: readonly T[]): Promise<void>;
  /** Fecha o arquivo (termina o destino). */
  fechar(): Promise<{ linhas: number; abas: number }>;
}

export interface OpcoesEscritorPlanilha {
  /** Nome da aba (a 2ª em diante leva " (2)", " (3)"…). */
  nomeAba?: string;
  /** Teto de linhas por aba do `.xlsx` (padrão `LINHAS_POR_ABA_XLSX`; o teste usa um pequeno). */
  linhasPorAba?: number;
}

const interrompido = (destino: Writable) =>
  destino.errored ?? new Error('O envio do arquivo foi interrompido.');

/**
 * Espera `fluxo` esvaziar (`drain`); rejeita se o `destino` (ou o próprio fluxo) falhar ou fechar antes. Escuta o
 * `error` dos dois enquanto espera: sem ouvinte, o `destroy(erro)` do destino derrubaria o processo.
 */
function esvaziar(fluxo: Writable, destino: Writable): Promise<void> {
  const fluxos = fluxo === destino ? [fluxo] : [fluxo, destino];
  return new Promise((ok, falha) => {
    const soltar = () => {
      fluxo.off('drain', aoEsvaziar);
      for (const f of fluxos) {
        f.off('close', aoFechar);
        f.off('error', aoFalhar);
      }
    };
    const aoEsvaziar = () => {
      soltar();
      ok();
    };
    const aoFalhar = (erro: Error) => {
      soltar();
      falha(erro);
    };
    const aoFechar = () => {
      soltar();
      falha(interrompido(destino));
    };
    fluxo.on('drain', aoEsvaziar);
    for (const f of fluxos) {
      f.on('close', aoFechar);
      f.on('error', aoFalhar);
    }
  });
}

/**
 * `promessa`, ou a falha do destino se ele quebrar ou fechar antes de terminar: o `WorkbookWriter.commit` espera o
 * `finish` do destino e, com o destino destruído sem erro (o envio que parou de ler), esperaria para sempre — a
 * tarefa ficaria "executando" com o sinal em dia.
 */
function aoTerminarOuFalhar<T>(promessa: Promise<T>, destino: Writable): Promise<T> {
  if (destino.destroyed && !destino.writableFinished) return Promise.reject(interrompido(destino));
  return new Promise((ok, falha) => {
    const soltar = () => {
      destino.off('error', aoFalhar);
      destino.off('close', aoFechar);
    };
    const aoFalhar = (erro: Error) => {
      soltar();
      falha(erro);
    };
    const aoFechar = () => {
      if (destino.writableFinished) return;
      soltar();
      falha(interrompido(destino));
    };
    destino.on('error', aoFalhar);
    destino.on('close', aoFechar);
    promessa.then(
      (v) => {
        soltar();
        ok(v);
      },
      (erro: unknown) => {
        soltar();
        falha(erro as Error);
      },
    );
  });
}

/**
 * Pressão de volta: o destino (o envio ao armazenamento) está cheio → espera ele esvaziar antes do próximo lote. Sem
 * isso o arquivo inteiro se acumularia na memória quando o envio é mais lento que a leitura do banco. No `.xlsx` vale
 * também para a entrada do zip (`interno`): a planilha é comprimida mais devagar do que é gerada, e o exceljs escreve
 * nela sem olhar a pressão (abaixo). Rejeita se o destino fechar com erro.
 */
async function folga(destino: Writable, interno?: Writable): Promise<void> {
  for (const fluxo of interno ? [interno, destino] : [destino]) {
    if (destino.destroyed) throw interrompido(destino);
    if (precisaEsvaziar(fluxo)) await esvaziar(fluxo, destino);
  }
}

/** `writableNeedDrain` do Node, ou o estado interno do `readable-stream` 2 (o `PassThrough` do archiver não o tem). */
function precisaEsvaziar(fluxo: Writable): boolean {
  return (
    fluxo.writableNeedDrain ??
    (fluxo as unknown as { _writableState?: { needDrain?: boolean } })._writableState?.needDrain ??
    false
  );
}

/**
 * A entrada do zip de uma aba do exceljs 4.4.0 (versão fixada): o `WorksheetWriter.stream` é um `StreamBuf` que o
 * archiver embrulha num `PassThrough` do `readable-stream` 2 (`archiver-utils.normalizeInputSource`), e o `StreamBuf`
 * escreve nele sem respeitar o `write() === false`. Cada pedaço de 64 KiB precisa de uma volta do laço de eventos no
 * deflate, e gerar 10 mil linhas segura o laço por ~0,3 s: medido com 1 milhão de linhas, sem esperar esse
 * `PassThrough` esvaziar a planilha quase inteira sem comprimir (~350 MB) ficava em memória fora do heap; esperando,
 * fica em poucos MB. O teste `exportacao.spec.ts` confere o encanamento (e quebra se uma versão nova do exceljs o
 * mudar) e que o lote do `.xlsx` só termina com essa entrada esvaziada.
 */
export function entradaDoZip(aba: ExcelJS.Worksheet | null): Writable | undefined {
  const fluxo = (aba as unknown as { stream?: { pipes?: unknown[] } } | null)?.stream?.pipes?.[0];
  return fluxo && typeof (fluxo as Writable).write === 'function' ? (fluxo as Writable) : undefined;
}

/**
 * Gera a planilha lote a lote no `destino`, sem guardar as linhas (exportação de relatório em tarefa, F2-B29): o
 * `.xlsx` pelo `WorkbookWriter` do exceljs (cada linha vai para o zip ao ser escrita; strings em linha, sem a tabela
 * de strings compartilhadas, que cresceria com o arquivo), o `.csv` com as mesmas regras do síncrono — proteção
 * contra fórmula, BOM, `;` e vírgula decimal. Datas como no síncrono (hora de parede de Brasília, `dd/mm/aaaa
 * hh:mm`). Texto no `.xlsx` é sempre célula de texto (nunca fórmula), como no `write-excel-file`. Passou de
 * `linhasPorAba` → nova aba com o cabeçalho. Quem chama trata o erro destruindo o `destino`.
 */
export function abrirEscritorPlanilha<T>(
  formato: FormatoExportacao,
  colunas: readonly ColunaExportacao<T>[],
  destino: Writable,
  opcoes: OpcoesEscritorPlanilha = {},
): EscritorPlanilha<T> {
  let linhas = 0;
  if (formato === 'csv') {
    destino.write(`${BOM}${colunas.map((c) => textoCsv(c.rotulo)).join(';')}\r\n`);
    return {
      async escrever(lote) {
        if (destino.destroyed) throw interrompido(destino);
        if (!lote.length) return;
        let texto = '';
        for (const l of lote) texto += `${colunas.map((c) => textoCsv(c.valor(l))).join(';')}\r\n`;
        linhas += lote.length;
        destino.write(texto);
        await folga(destino);
      },
      async fechar() {
        if (destino.destroyed) throw interrompido(destino);
        destino.end();
        return { linhas, abas: 1 };
      },
    };
  }
  const nomeAba = opcoes.nomeAba ?? 'Relatório';
  const linhasPorAba = Math.max(1, Math.min(opcoes.linhasPorAba ?? LINHAS_POR_ABA_XLSX, LINHAS_POR_ABA_XLSX));
  const livro = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: destino,
    useStyles: true,
    useSharedStrings: false,
  });
  let aba: ExcelJS.Worksheet | null = null;
  let abas = 0;
  let naAba = 0;
  const novaAba = () => {
    aba?.commit();
    abas++;
    aba = livro.addWorksheet(abas === 1 ? nomeAba : `${nomeAba} (${abas})`, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    aba.columns = colunas.map((c) => ({
      width: c.largura ?? Math.min(60, Math.max(10, c.rotulo.length + 2)),
    }));
    const cabecalho = aba.addRow(colunas.map((c) => c.rotulo));
    cabecalho.font = { bold: true };
    cabecalho.commit();
    naAba = 0;
  };
  return {
    async escrever(lote) {
      for (const l of lote) {
        if (!aba || naAba >= linhasPorAba) novaAba();
        const valores: Array<string | number | Date | null> = [];
        const datas: number[] = [];
        colunas.forEach((c, i) => {
          const v = c.valor(l);
          if (v === null || v === undefined) valores.push(null);
          else if (v instanceof Date) {
            valores.push(horaDeParede(v));
            datas.push(i + 1);
          } else if (typeof v === 'boolean') valores.push(v ? 'Sim' : 'Não');
          else valores.push(v);
        });
        const linha = aba!.addRow(valores);
        for (const i of datas) linha.getCell(i).numFmt = 'dd/mm/yyyy hh:mm';
        linha.commit();
        naAba++;
        linhas++;
      }
      await folga(destino, entradaDoZip(aba));
    },
    async fechar() {
      if (destino.destroyed) throw interrompido(destino);
      if (!aba) novaAba();
      aba!.commit();
      await aoTerminarOuFalhar(livro.commit(), destino);
      return { linhas, abas };
    },
  };
}

/** `Usuarios_30_10_2026_15_30.xlsx` (mesmo padrão de nome dos relatórios, ERP 16.5). */
export function nomeArquivoExportacao(base: string, formato: FormatoExportacao, agora = new Date()): string {
  const p = partes(agora);
  return `${base}_${p.day}_${p.month}_${p.year}_${p.hour}_${p.minute}.${formato}`;
}

/** O arquivo inteiro na memória (a geração síncrona), dentro de uma vaga do `semaforoExportacao`. */
function gerarConteudo<T>(
  formato: FormatoExportacao,
  colunas: ColunaExportacao<T>[],
  linhas: T[],
): Promise<Buffer> {
  return semaforoExportacao.executar(async () =>
    formato === 'csv' ? gerarCsv(colunas, linhas) : await gerarXlsx(colunas, linhas),
  );
}

/** Conteúdo do arquivo (relatórios gravados no armazenamento, como o da importação). */
export async function gerarArquivoPlanilha<T>(
  formato: FormatoExportacao,
  colunas: ColunaExportacao<T>[],
  linhas: T[],
): Promise<{ conteudo: Buffer; tipoMime: string }> {
  return { conteudo: await gerarConteudo(formato, colunas, linhas), tipoMime: TIPOS_EXPORTACAO[formato] };
}

/** Gera o arquivo da listagem já como resposta de download. */
export async function arquivoExportacao<T>(
  formato: FormatoExportacao,
  nomeBase: string,
  colunas: ColunaExportacao<T>[],
  linhas: T[],
): Promise<StreamableFile> {
  const conteudo = await gerarConteudo(formato, colunas, linhas);
  const nome = nomeArquivoExportacao(nomeBase, formato);
  return new StreamableFile(conteudo, {
    type: TIPOS_EXPORTACAO[formato],
    length: conteudo.length,
    disposition: `attachment; filename="${nome}"`,
  });
}

/**
 * Exportar exige `<recurso>.exportar` ou `relatorios.exportar` (ERP 3.1). Recursos sem a chave própria no catálogo
 * (ex.: usuários) dependem só de `relatorios.exportar`.
 */
export function garantirPodeExportar(sessao: SessaoErp, recurso: string): void {
  const propria = `${recurso}.exportar`;
  const pode =
    sessao.permissoes.has('relatorios.exportar') ||
    (permissaoExiste(propria) && sessao.permissoes.has(propria));
  if (!pode) {
    throw new ErroApi('SEM_PERMISSAO', 'Você não tem permissão para exportar.', {
      detalhes: {
        permissoes: [permissaoExiste(propria) ? propria : null, 'relatorios.exportar'].filter(Boolean),
      },
    });
  }
}
