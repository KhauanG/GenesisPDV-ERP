/**
 * Exportação de relatório (ERP 3.5, 3.6; MD 3.1.6, 3.1.8; Fase 2, F2-B29; README da API › decisão 177): a regra comum
 * que os relatórios do PR-7 em diante usam. Cada relatório registra um **provedor** (filtros, colunas e a consulta já
 * restrita aos estoques/lojas da sessão); esta classe decide o resto:
 *
 * - até `LIMITE_EXPORTACAO` linhas o arquivo baixa na hora (o `write-excel-file` de sempre, `arquivoExportacao`);
 * - acima, vira a tarefa `exportar_relatorio` (resposta `202` com o id): o executor lê a consulta por um **cursor do
 *   servidor** (`declare` + `fetch`, num instantâneo `repeatable read read only`), escreve o `.xlsx` (exceljs
 *   `WorkbookWriter`) ou o `.csv` lote a lote e envia ao armazenamento em multipart enquanto escreve: a memória é a de
 *   um lote mais uma parte do envio, não a do arquivo;
 * - acima de `LIMITE_EXPORTACAO_TAREFA`, pede para refinar os filtros.
 *
 * Exportar exige `relatorios.exportar` e a permissão do relatório, conferidas no pedido e de novo na execução, com o
 * acesso do momento (`sessaoDaTarefa`). As colunas de custo saem sem `produtos.ver_custo`. O arquivo fica em `arquivos`
 * (`planilha_exportacao`, retenção de 7 dias), com o link assinado de 7 dias em `GET /tarefas`, e a auditoria
 * `exportar` é gravada com ele (na tarefa) ou no download na hora.
 */
import { PassThrough } from 'node:stream';
import {
  FORMATOS_EXPORTACAO,
  LIMITE_EXPORTACAO,
  LIMITE_EXPORTACAO_TAREFA,
  TAREFA_EXPORTAR_RELATORIO,
  type ExportacaoEmTarefa,
  type FormatoExportacao,
  type ResultadoExportacaoRelatorio,
} from '@genesis/shared';
import type { StreamableFile } from '@nestjs/common';
import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { ErroApi } from '../comum/erros.js';
import { limiteDoAmbiente } from '../comum/limites-processo.js';
import {
  abrirEscritorPlanilha,
  arquivoExportacao,
  colunasVisiveis,
  nomeArquivoExportacao,
  semaforoExportacao,
  TIPOS_EXPORTACAO,
  type ColunaExportacao,
} from '../comum/exportacao.js';
import { validar } from '../comum/zod.js';
import { arquivos, tarefas } from '../database/empresa/schema/index.js';
import { chaveArquivo, type ArmazenamentoObjetos } from '../infra/armazenamento.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { sessaoDaTarefa, type ExecucaoTarefa, type TarefasSegundoPlano } from './tarefas.js';

/** Linhas por `fetch` do cursor (o lote que fica na memória; o do recalcular e o da massa do F2-B28). */
export const LINHAS_POR_LOTE_EXPORTACAO = 10_000;
/** Folga entre o gerador e o envio ao armazenamento (o `highWaterMark` da saída). */
export const FOLGA_ENVIO_BYTES = 1024 * 1024;
/** Retenção do arquivo gerado: a do link (ERP 3.6, "link expira em 7 dias"). */
const RETENCAO_DIAS = 7;

/**
 * Um relatório exportável. `F` é a saída do zod dos filtros; `L` é a linha como o `pg` a devolve (numeric e bigint
 * chegam como texto: a coluna converte).
 */
export interface ProvedorRelatorio<F = Record<string, unknown>, L = Record<string, unknown>> {
  /** Chave na rota (`GET /relatorios/<chave>/exportar`) e em `tarefas.parametros.relatorio`. */
  chave: string;
  /** Base do nome: `Relatorio_Movimentacao_Estoque` → `Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM.xlsx`. */
  nomeArquivo: string;
  /** Permissão de ver o relatório (ex.: `relatorios.movimentacao_estoque`), além de `relatorios.exportar`. */
  permissao: string;
  /** Auditoria `exportar`: entidade (tabela ou área) e localização (tela). */
  entidade: string;
  localizacao: string;
  /**
   * Filtros da query (sem `formato`). A entrada crua vai para `tarefas.parametros` e é validada de novo na execução,
   * então o schema tem de aceitar a própria entrada (strings da query).
   */
  filtros: z.ZodType<F>;
  /** Colunas na ordem do arquivo; as `custo: true` saem sem `produtos.ver_custo`. */
  colunas(sessao: SessaoErp, filtros: F): ColunaExportacao<L>[];
  /**
   * A consulta inteira, com a ordem estável (o cursor lê nela) e o filtro do acesso da sessão (estoques e lojas
   * permitidos). Só leitura.
   */
  consulta(sessao: SessaoErp, filtros: F): SQL;
  /** Total de linhas (decide entre baixar na hora e a tarefa, e dá o progresso); padrão: `count(*)` da consulta. */
  contar?(db: DbEmpresa, sessao: SessaoErp, filtros: F): Promise<number>;
}

/** O que a requisição guarda para a auditoria da tarefa (o executor não tem a requisição). */
const origemSchema = z.object({
  ip: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  requisicaoId: z.string().nullable().optional(),
});

const parametrosSchema = z.object({
  relatorio: z.string(),
  formato: z.enum(FORMATOS_EXPORTACAO),
  filtros: z.record(z.string(), z.unknown()),
  linhas: z.number().int().min(0),
  origem: origemSchema.default({}),
});

export interface OpcoesExportacao {
  /** Linhas por `fetch` (padrão `LINHAS_POR_LOTE_EXPORTACAO`). */
  linhasPorLote?: number;
  /** Parte do multipart (padrão `TAMANHO_PARTE_BYTES`; o teste com o S3 em memória usa uma pequena). */
  tamanhoParte?: number;
  /** Folga entre o gerador e o envio (padrão `FOLGA_ENVIO_BYTES`; o teste usa uma pequena, para o gerador esperar). */
  folgaBytes?: number;
  /** Linhas por aba do `.xlsx` (padrão: o teto do Excel; o teste usa um pequeno). */
  linhasPorAba?: number;
  /** Até quantas linhas baixa na hora (padrão `LIMITE_EXPORTACAO`; o teste usa um pequeno). */
  limiteNaHora?: number;
  /** Teto da tarefa (padrão `LIMITE_EXPORTACAO_TAREFA`). */
  limiteTarefa?: number;
  /** Exportações em tarefa na fila ou executando por usuário (padrão `EXPORTACOES_PENDENTES_POR_USUARIO`, 2). */
  pendentesPorUsuario?: number;
}

interface Dependencias {
  tenancy: Tenancy;
  tarefas: TarefasSegundoPlano;
  armazenamento: ArmazenamentoObjetos;
  auditoria: AuditoriaService;
  permissoes: PermissoesEfetivas;
}

export type ResultadoExportacao =
  { tipo: 'arquivo'; arquivo: StreamableFile } | { tipo: 'tarefa'; tarefa: ExportacaoEmTarefa };

const dialeto = new PgDialect();

/** A conexão que segura o cursor (a do `cx.consulta`): o `query` do driver e o evento `error`. */
export interface ClienteCursor {
  query(texto: string, valores?: unknown[]): Promise<{ rows: unknown[] }>;
  on(evento: 'error', ouvinte: (erro: Error) => void): unknown;
  off(evento: 'error', ouvinte: (erro: Error) => void): unknown;
}

/**
 * Tempo máximo da transação do cursor parada entre um `fetch` e outro (`idle_in_transaction_session_timeout`): o
 * executor espera o envio ao armazenamento esvaziar com o instantâneo aberto (a pressão de volta).
 */
const INATIVIDADE_CURSOR = '10min';

/**
 * Páginas de um cursor do servidor sobre `consulta` (com os parâmetros dela: o `declare … cursor for` aceita os
 * `$n` do protocolo estendido), dentro da transação aberta por quem chama.
 */
export async function* lotesPorCursor<L>(
  cliente: ClienteCursor,
  consulta: SQL,
  porLote: number,
  nome = 'cursor_exportacao',
): AsyncGenerator<L[]> {
  const q = dialeto.sqlToQuery(consulta);
  await cliente.query(`declare ${nome} no scroll cursor for ${q.sql}`, q.params);
  try {
    for (;;) {
      const { rows } = await cliente.query(`fetch ${porLote} from ${nome}`);
      if (rows.length) yield rows as L[];
      if (rows.length < porLote) return;
    }
  } finally {
    await cliente.query(`close ${nome}`).catch(() => undefined);
  }
}

/**
 * Lê `consulta` por um cursor do servidor (`lotesPorCursor`) num instantâneo `repeatable read read only` — a mesma
 * regra na exportação na hora e na tarefa — e entrega cada lote a `aoLote`; o próximo `fetch` só vem depois que ele
 * termina. Enquanto `aoLote` espera (o envio ao armazenamento cheio), a transação fica parada segurando o instantâneo,
 * as travas de leitura e uma conexão: o limite de inatividade do armazenamento (`ARMAZENAMENTO_INATIVIDADE_MS`) faz
 * o envio parado falhar antes, e, como defesa, o banco derruba a sessão parada há mais de `INATIVIDADE_CURSOR`
 * (decisão 177). Erro → `rollback`.
 */
export async function lerPorCursor<L>(
  cliente: ClienteCursor,
  consulta: SQL,
  porLote: number,
  aoLote: (lote: L[]) => Promise<void> | void,
): Promise<void> {
  // A sessão derrubada pelo banco com a conexão parada chega como `error` no cliente emprestado, que o pool só escuta
  // depois de devolvido: sem ouvinte, derrubaria o processo. A consulta seguinte falha, e o pool descarta a conexão.
  const aoFalhar = () => undefined;
  cliente.on('error', aoFalhar);
  try {
    await cliente.query('begin isolation level repeatable read read only');
    try {
      await cliente.query(`set local idle_in_transaction_session_timeout = '${INATIVIDADE_CURSOR}'`);
      for await (const lote of lotesPorCursor<L>(cliente, consulta, porLote)) await aoLote(lote);
      await cliente.query('commit');
    } catch (e) {
      await cliente.query('rollback').catch(() => undefined);
      throw e;
    }
  } finally {
    cliente.off('error', aoFalhar);
  }
}

export class ExportacaoRelatorios {
  private readonly provedores = new Map<string, ProvedorRelatorio<unknown, unknown>>();

  constructor(
    private readonly d: Dependencias,
    readonly opcoes: OpcoesExportacao = {},
  ) {
    d.tarefas.registrarTipo(TAREFA_EXPORTAR_RELATORIO, (e) => this.executar(e), {
      seInterrompida: 'Nenhum arquivo foi gerado: peça a exportação de novo.',
    });
  }

  registrar<F, L>(provedor: ProvedorRelatorio<F, L>): void {
    if (this.provedores.has(provedor.chave)) throw new Error(`Relatório já registrado: ${provedor.chave}`);
    this.provedores.set(provedor.chave, provedor as unknown as ProvedorRelatorio<unknown, unknown>);
  }

  private get linhasPorLote(): number {
    return this.opcoes.linhasPorLote ?? LINHAS_POR_LOTE_EXPORTACAO;
  }

  private provedor(chave: string): ProvedorRelatorio<unknown, unknown> {
    const p = this.provedores.get(chave);
    if (!p) throw ErroApi.naoEncontrado('Relatório não encontrado.');
    return p;
  }

  private garantirAcesso(sessao: SessaoErp, provedor: ProvedorRelatorio<unknown, unknown>): void {
    const faltam = ['relatorios.exportar', provedor.permissao].filter((p) => !sessao.permissoes.has(p));
    if (faltam.length) {
      throw new ErroApi('SEM_PERMISSAO', 'Você não tem permissão para exportar este relatório.', {
        detalhes: { permissoes: faltam },
      });
    }
  }

  private async contar(
    db: DbEmpresa,
    sessao: SessaoErp,
    provedor: ProvedorRelatorio<unknown, unknown>,
    filtros: unknown,
  ): Promise<number> {
    if (provedor.contar) return provedor.contar(db, sessao, filtros);
    const r = await db.execute<{ n: string }>(
      sql`select count(*)::bigint as n from (${provedor.consulta(sessao, filtros)}) as consulta`,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * O pedido de exportação (`GET /relatorios/:chave/exportar`): confere o acesso, valida os filtros, conta e baixa
   * na hora ou cria a tarefa. A auditoria da tarefa vai com o arquivo, no fim: tarefa que falha não exportou nada.
   */
  async exportar(
    sessao: SessaoErp,
    origem: OrigemAcao,
    chave: string,
    query: Record<string, unknown>,
  ): Promise<ResultadoExportacao> {
    const provedor = this.provedor(chave);
    this.garantirAcesso(sessao, provedor);
    const { formato: formatoBruto, ...entrada } = query;
    const formato = validar(z.enum(FORMATOS_EXPORTACAO).default('xlsx'), formatoBruto);
    const filtros = validar(provedor.filtros, entrada);
    const cx = this.d.tenancy.cx();
    const total = await cx.consulta((db) => this.contar(db, sessao, provedor, filtros));
    const limiteTarefa = this.opcoes.limiteTarefa ?? LIMITE_EXPORTACAO_TAREFA;
    if (total > limiteTarefa) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        `A exportação passa de ${limiteTarefa.toLocaleString('pt-BR')} linhas. Refine os filtros.`,
        { detalhes: { linhas: total, limite: limiteTarefa } },
      );
    }
    if (total <= (this.opcoes.limiteNaHora ?? LIMITE_EXPORTACAO)) {
      return {
        tipo: 'arquivo',
        arquivo: await this.naHora(sessao, origem, provedor, formato, entrada, filtros),
      };
    }
    // A fila roda uma tarefa por vez: sem teto por usuário, um só poderia enfileirar horas de exportação na frente das
    // importações e das exportações dos outros. Teto "macio" (dois pedidos no mesmo instante podem passar juntos).
    const pendentesPorUsuario =
      this.opcoes.pendentesPorUsuario ?? limiteDoAmbiente('EXPORTACOES_PENDENTES_POR_USUARIO', 2);
    const [pendentes] = await cx.consulta((db) =>
      db
        .select({ n: count() })
        .from(tarefas)
        .where(
          and(
            eq(tarefas.tipo, TAREFA_EXPORTAR_RELATORIO),
            eq(tarefas.usuarioId, sessao.usuarioId),
            inArray(tarefas.status, ['na_fila', 'executando']),
          ),
        ),
    );
    if ((pendentes?.n ?? 0) >= pendentesPorUsuario) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        `Você já tem ${pendentesPorUsuario} exportação(ões) em andamento. Espere uma terminar (ícone Tarefas) e peça de novo.`,
        { detalhes: { pendentes: pendentes?.n ?? 0, limite: pendentesPorUsuario } },
      );
    }
    const tarefaId = await cx.transacao((tx) =>
      this.d.tarefas.criar(tx, {
        tipo: TAREFA_EXPORTAR_RELATORIO,
        usuarioId: sessao.usuarioId,
        parametros: {
          relatorio: provedor.chave,
          formato,
          filtros: entrada,
          linhas: total,
          origem: {
            ip: origem.ip ?? null,
            userAgent: origem.userAgent ?? null,
            requisicaoId: origem.requisicaoId ?? null,
          },
        } satisfies z.input<typeof parametrosSchema>,
      }),
    );
    await this.d.tarefas.agendar(cx.contexto.empresaId, tarefaId);
    return { tipo: 'tarefa', tarefa: { tarefaId, linhas: total } };
  }

  /** Até o limite: as linhas pelo mesmo cursor, a auditoria e o arquivo do `write-excel-file`. */
  private async naHora(
    sessao: SessaoErp,
    origem: OrigemAcao,
    provedor: ProvedorRelatorio<unknown, unknown>,
    formato: FormatoExportacao,
    entrada: Record<string, unknown>,
    filtros: unknown,
  ): Promise<StreamableFile> {
    const cx = this.d.tenancy.cx();
    const linhas = await cx.consulta(async (_db, cliente) => {
      const todas: unknown[] = [];
      await lerPorCursor<unknown>(cliente, provedor.consulta(sessao, filtros), this.linhasPorLote, (lote) => {
        todas.push(...lote);
      });
      return todas;
    });
    await cx.transacao((tx) =>
      this.d.auditoria.registrar(tx, origem, {
        acao: 'exportar',
        entidade: provedor.entidade,
        localizacao: provedor.localizacao,
        descricao: `Exportação ${formato.toUpperCase()} com ${linhas.length} linha(s)`,
        depois: { relatorio: provedor.chave, formato, filtros: entrada, linhas: linhas.length },
      }),
    );
    return arquivoExportacao(
      formato,
      provedor.nomeArquivo,
      colunasVisiveis(provedor.colunas(sessao, filtros), sessao),
      linhas,
    );
  }

  /** Executor da tarefa `exportar_relatorio`. */
  private async executar(
    e: ExecucaoTarefa,
  ): Promise<{ resultado: ResultadoExportacaoRelatorio; arquivoId: string }> {
    const p = parametrosSchema.parse(e.tarefa.parametros);
    const provedor = this.provedor(p.relatorio);
    const cx = this.d.tenancy.cx();
    const sessao = await cx.consulta((db) =>
      sessaoDaTarefa(db, this.d.tenancy, this.d.permissoes, e.tarefa.usuarioId, e.tarefa.id),
    );
    this.garantirAcesso(sessao, provedor);
    const filtros = validar(provedor.filtros, p.filtros);
    const colunas = colunasVisiveis(provedor.colunas(sessao, filtros), sessao);
    const tipoMime = TIPOS_EXPORTACAO[p.formato];
    const chave = chaveArquivo(cx.contexto.codigo, 'relatorios', p.formato);
    const nomeArquivo = nomeArquivoExportacao(provedor.nomeArquivo, p.formato);
    await e.progresso(0, 'Aguardando a vez');

    const gerado = await semaforoExportacao.executar(async () => {
      await e.progresso(1, 'Lendo o relatório');
      // A folga entre o gerador e o envio (1 MiB): cheia, o gerador espera a parte subir (`abrirEscritorPlanilha`).
      const saida = new PassThrough({ highWaterMark: this.opcoes.folgaBytes ?? FOLGA_ENVIO_BYTES });
      // O erro da saída chega por quem espera nela (o gerador na folga, o envio lendo): sem ouvinte nenhum no
      // instante do `destroy(erro)` (o gerador esperando o banco), o evento `error` derrubaria o processo.
      saida.on('error', () => undefined);
      // O envio que falha primeiro destrói a saída: o gerador parado esperando folga acorda, e a tarefa falha com o
      // erro do envio (o do gerador é consequência). O gerador que falha primeiro destrói a saída com o erro dele.
      let falhaEnvio: Error | null = null;
      let falhaGerador = false;
      const envio = this.d.armazenamento
        // `destroyOnReturn: false`: o `for await` do envio que sai com erro destruiria a saída na hora com um
        // `AbortError` ("The operation was aborted"), antes do `AbortMultipartUpload` e do `catch` abaixo; o gerador
        // na folga acordaria com ele e a tarefa falharia com essa mensagem crua no lugar da do armazenamento.
        .gravarFluxo(chave, saida.iterator({ destroyOnReturn: false }), tipoMime, {
          tamanhoParte: this.opcoes.tamanhoParte,
        })
        .catch((erro: unknown) => {
          if (falhaGerador) throw erro;
          falhaEnvio = new Error(
            `O arquivo não pôde ser gravado no armazenamento: ${(erro as Error).message}`,
            {
              cause: erro,
            },
          );
          saida.destroy(falhaEnvio);
          throw falhaEnvio;
        });
      // Tratada já: o envio pode falhar enquanto o gerador espera o banco, e a rejeição sem ouvinte derrubaria o
      // processo (`unhandledRejection`); quem espera o `envio` abaixo continua recebendo o erro.
      envio.catch(() => undefined);
      try {
        const escritor = abrirEscritorPlanilha<unknown>(p.formato, colunas, saida, {
          linhasPorAba: this.opcoes.linhasPorAba,
        });
        let lidas = 0;
        let ultimoPct = 1;
        // A conexão do cursor fica presa só durante a leitura; fechar o zip e terminar o envio vêm depois.
        await cx.consulta((_db, cliente) =>
          lerPorCursor<unknown>(
            cliente,
            provedor.consulta(sessao, filtros),
            this.linhasPorLote,
            async (lote) => {
              await escritor.escrever(lote);
              lidas += lote.length;
              const pct = Math.min(95, 1 + (lidas / Math.max(1, p.linhas)) * 94);
              if (pct - ultimoPct >= 1) {
                ultimoPct = pct;
                await e.progresso(
                  pct,
                  `${lidas.toLocaleString('pt-BR')} de ${p.linhas.toLocaleString('pt-BR')} linhas`,
                );
              }
            },
          ),
        );
        await e.progresso(96, 'Finalizando o arquivo');
        const { linhas, abas } = await escritor.fechar();
        const armazenado = await envio;
        return { linhas, abas, ...armazenado };
      } catch (erro) {
        if (!falhaEnvio) {
          falhaGerador = true;
          saida.destroy(erro as Error);
        }
        await envio.catch(() => undefined);
        throw falhaEnvio ?? erro;
      }
    });

    const resultado: ResultadoExportacaoRelatorio = {
      relatorio: provedor.chave,
      formato: p.formato,
      linhas: gerado.linhas,
      abas: gerado.abas,
      tamanhoBytes: gerado.tamanhoBytes,
      nomeArquivo,
    };
    const origem: OrigemAcao = {
      origem: 'erp',
      usuarioId: sessao.usuarioId,
      usuarioNome: sessao.usuarioNome,
      ip: p.origem.ip ?? null,
      userAgent: p.origem.userAgent ?? null,
      requisicaoId: p.origem.requisicaoId ?? null,
    };
    const arquivoId = await cx.transacao(async (tx) => {
      const [a] = await tx
        .insert(arquivos)
        .values({
          chaveArmazenamento: chave,
          nomeOriginal: nomeArquivo,
          tipoMime,
          tamanhoBytes: gerado.tamanhoBytes,
          sha256: gerado.sha256,
          categoria: 'planilha_exportacao',
          // O arquivo é o resultado da tarefa (como o relatório da importação, saída do sistema).
          entidade: 'tarefas',
          registroId: e.tarefa.id,
          retencaoAte: new Date(Date.now() + RETENCAO_DIAS * 86_400_000).toISOString().slice(0, 10),
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })
        .returning({ id: arquivos.id });
      await this.d.auditoria.registrar(tx, origem, {
        acao: 'exportar',
        entidade: provedor.entidade,
        localizacao: provedor.localizacao,
        descricao: `Exportação ${p.formato.toUpperCase()} com ${gerado.linhas} linha(s), em tarefa`,
        depois: {
          relatorio: provedor.chave,
          formato: p.formato,
          filtros: p.filtros,
          linhas: gerado.linhas,
          tarefaId: e.tarefa.id,
          arquivoId: a!.id,
        },
      });
      return a!.id;
    });
    return { resultado, arquivoId };
  }
}
