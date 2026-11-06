import { StreamableFile } from '@nestjs/common';
import { permissaoExiste, type FormatoExportacao } from '@genesis/shared';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from './erros.js';

export type ValorExportado = string | number | boolean | Date | null | undefined;

export interface ColunaExportacao<T> {
  rotulo: string;
  valor: (linha: T) => ValorExportado;
}

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

const TIPOS: Record<FormatoExportacao, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

/** `Usuarios_30_10_2026_15_30.xlsx` (mesmo padrão de nome dos relatórios, ERP 16.5). */
export function nomeArquivoExportacao(base: string, formato: FormatoExportacao, agora = new Date()): string {
  const p = partes(agora);
  return `${base}_${p.day}_${p.month}_${p.year}_${p.hour}_${p.minute}.${formato}`;
}

/** Conteúdo do arquivo (relatórios gravados no armazenamento, como o da importação). */
export async function gerarArquivoPlanilha<T>(
  formato: FormatoExportacao,
  colunas: ColunaExportacao<T>[],
  linhas: T[],
): Promise<{ conteudo: Buffer; tipoMime: string }> {
  const conteudo = formato === 'csv' ? gerarCsv(colunas, linhas) : await gerarXlsx(colunas, linhas);
  return { conteudo, tipoMime: TIPOS[formato] };
}

/** Gera o arquivo da listagem já como resposta de download. */
export async function arquivoExportacao<T>(
  formato: FormatoExportacao,
  nomeBase: string,
  colunas: ColunaExportacao<T>[],
  linhas: T[],
): Promise<StreamableFile> {
  const conteudo = formato === 'csv' ? gerarCsv(colunas, linhas) : await gerarXlsx(colunas, linhas);
  const nome = nomeArquivoExportacao(nomeBase, formato);
  return new StreamableFile(conteudo, {
    type: TIPOS[formato],
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
