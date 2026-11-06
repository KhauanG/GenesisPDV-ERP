import { hostname } from 'node:os';
import type {
  EmpresaSituacaoMigracao,
  ExecucaoMigracoes,
  ResultadoMigracaoEmMassa,
  ResultadoMigracaoEmpresa,
  SimulacaoMigracoes,
  SituacaoMigracaoEmpresa,
  SituacaoMigracoes,
  StatusMigracaoExecutada,
} from '@genesis/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type pg from 'pg';
import type { BancoControle } from '../database/controle/conexao.js';
import {
  adminsPlataforma,
  auditoriaPlataforma,
  empresas,
  migracoesEmpresas,
} from '../database/controle/schema.js';
import {
  aplicarMigracoes,
  type PreparacaoMigracao,
  type RelatoPreparacao,
} from '../database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA, type Migracao } from '../database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../database/migracoes/preparacoes-empresa.js';
import { garantirNomeBancoEmpresa } from '../database/nomes-bancos.js';
import type { ServidoresBanco } from '../database/servidores.js';
import { registrarAuditoriaPlataforma } from './auditoria-plataforma.js';

export interface EmpresaAlvo {
  id: string;
  codigo: number;
  nomeBanco: string;
  servidorBancoId: string;
  canario?: boolean;
}

export type StatusMigracaoEmpresa = StatusMigracaoExecutada;
export type { ResultadoMigracaoEmMassa, ResultadoMigracaoEmpresa };

export interface OpcoesMigracaoEmpresa {
  pasta?: string;
  /** Roda depois das migrações, na mesma conexão (referências, catálogo e seed idempotente). */
  posMigracao?: (cliente: pg.Client) => Promise<void>;
  /** Passos de dados por tag (padrão: `PREPARACOES_MIGRACAO_EMPRESA`; os testes trocam junto com a `pasta`). */
  preparacoes?: Readonly<Record<string, PreparacaoMigracao>>;
}

export interface OpcoesMigracaoEmMassa {
  codigos?: number[];
  lote?: number;
  pararNoPrimeiroErro?: boolean;
  pasta?: string;
  posMigracao?: (cliente: pg.Client, empresa: EmpresaAlvo) => Promise<void>;
  preparacoes?: Readonly<Record<string, PreparacaoMigracao>>;
  adminId?: string | null;
}

/** Só estas entram no "Aplicar" (o mesmo filtro de `migrarTodas`). */
const STATUS_MIGRAVEIS = ['ativa', 'suspensa'] as const;

function mensagemErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Migração dos bancos de empresa (ADR-02; MD 2.12; ERP 19.7): canário primeiro, depois lotes paralelos — no máximo
 * uma empresa por vez em cada servidor —, registro por migração em `migracoes_empresas` (com hash) e modo manutenção
 * (503) para a empresa cuja migração falhou, sem impedir as demais.
 */
export class MigradorEmpresas {
  readonly executadoPor: string;

  constructor(
    private readonly controle: BancoControle,
    private readonly servidores: ServidoresBanco,
    private readonly opcoes: { lote: number; lockTimeout: string; executadoPor?: string },
    private readonly aoAlterarEmpresa: (empresaId: string) => void = () => undefined,
  ) {
    this.executadoPor = (opcoes.executadoPor ?? `${hostname()}:${process.pid}`).slice(0, 100);
  }

  migracoesDisponiveis(pasta = PASTA_MIGRACOES_EMPRESA): Migracao[] {
    return lerMigracoes(pasta);
  }

  async migrarEmpresa(
    empresa: EmpresaAlvo,
    opcoes: OpcoesMigracaoEmpresa = {},
  ): Promise<ResultadoMigracaoEmpresa> {
    const migracoes = lerMigracoes(opcoes.pasta ?? PASTA_MIGRACOES_EMPRESA);
    const base = { empresaId: empresa.id, codigo: empresa.codigo };
    // Avisos das preparações (ex.: cadeia do razão quebrada, F2-B2): no resultado mesmo que a migração falhe depois.
    const avisos: string[] = [];
    const comAvisos = () => (avisos.length ? { avisos: [...avisos] } : {});
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:migracao_empresa'), hashtext($1)) as ok",
        [empresa.id],
      );
      if (!rows[0]?.ok) {
        return {
          ...base,
          status: 'ignorada',
          aplicadas: [],
          versaoSchema: null,
          erro: 'Outra migração desta empresa em andamento',
        };
      }
      let cliente: pg.Client | undefined;
      try {
        garantirNomeBancoEmpresa(empresa.nomeBanco, empresa.codigo);
        cliente = await this.servidores.conectar(
          empresa.servidorBancoId,
          empresa.nomeBanco,
          'genesis_migracao',
        );
        const r = await aplicarMigracoes(cliente, migracoes, {
          lockTimeout: this.opcoes.lockTimeout,
          preparacoes: opcoes.preparacoes ?? PREPARACOES_MIGRACAO_EMPRESA,
          ganchos: {
            aoIniciar: (m) => this.registrar(empresa.id, m, 'aplicando'),
            aoConcluir: (m, ms) => this.registrar(empresa.id, m, 'aplicada', ms),
            aoFalhar: (m, erro, ms) => this.registrar(empresa.id, m, 'falhou', ms, mensagemErro(erro)),
            aoEncontrarAplicada: (m) => this.registrarJaAplicada(empresa.id, m),
            aoPreparar: (m, relato) => this.registrarPreparacao(empresa.id, m, relato, avisos),
          },
        });
        if (opcoes.posMigracao) await opcoes.posMigracao(cliente);
        // Tabelas novas entram nos privilégios da role de runtime (MD 1.4).
        await this.servidores.garantirRoleAplicacao(cliente, empresa);
        await this.controle.db
          .update(empresas)
          .set({ versaoSchema: r.ultima })
          .where(eq(empresas.id, empresa.id));
        return { ...base, status: 'ok', aplicadas: r.aplicadas, versaoSchema: r.ultima, ...comAvisos() };
      } catch (e) {
        return {
          ...base,
          status: 'falhou',
          aplicadas: [],
          versaoSchema: null,
          erro: mensagemErro(e),
          ...comAvisos(),
        };
      } finally {
        await cliente?.end().catch(() => undefined);
        await trava
          .query("select pg_advisory_unlock(hashtext('genesis:migracao_empresa'), hashtext($1))", [
            empresa.id,
          ])
          .catch(() => undefined);
        this.aoAlterarEmpresa(empresa.id);
      }
    } finally {
      trava.release();
    }
  }

  async migrarTodas(opcoes: OpcoesMigracaoEmMassa = {}): Promise<ResultadoMigracaoEmMassa> {
    const condicoes = [inArray(empresas.status, [...STATUS_MIGRAVEIS]), isNull(empresas.excluidoEm)];
    if (opcoes.codigos?.length) condicoes.push(inArray(empresas.codigo, opcoes.codigos));
    const alvos: EmpresaAlvo[] = await this.controle.db
      .select({
        id: empresas.id,
        codigo: empresas.codigo,
        nomeBanco: empresas.nomeBanco,
        servidorBancoId: empresas.servidorBancoId,
        canario: empresas.canario,
      })
      .from(empresas)
      .where(and(...condicoes))
      .orderBy(asc(empresas.codigo));

    // Sem empresa marcada como canário, a de menor código faz esse papel.
    let canarios = alvos.filter((a) => a.canario);
    if (canarios.length === 0 && alvos.length > 0) canarios = [alvos[0]!];
    const demaisAlvos = alvos.filter((a) => !canarios.includes(a));
    const migrar = (e: EmpresaAlvo) =>
      this.migrarEmpresa(e, {
        pasta: opcoes.pasta,
        preparacoes: opcoes.preparacoes,
        posMigracao: opcoes.posMigracao ? (c) => opcoes.posMigracao!(c, e) : undefined,
      });

    const resultado: ResultadoMigracaoEmMassa = { canarios: [], demais: [], falhas: 0, interrompida: false };
    for (const c of canarios) {
      const r = await migrar(c);
      resultado.canarios.push(r);
      if (r.status === 'falhou') {
        resultado.falhas++;
        resultado.interrompida = true;
      }
    }
    if (resultado.interrompida) {
      resultado.demais = demaisAlvos.map((e) => ({
        empresaId: e.id,
        codigo: e.codigo,
        status: 'nao_executada' as const,
        aplicadas: [],
        versaoSchema: null,
      }));
      await this.auditar(opcoes.adminId, resultado);
      return resultado;
    }

    // Uma fila por servidor (MD 2.12: uma empresa por vez por servidor); até `lote` servidores em paralelo.
    const filas = new Map<string, EmpresaAlvo[]>();
    for (const e of demaisAlvos) filas.set(e.servidorBancoId, [...(filas.get(e.servidorBancoId) ?? []), e]);
    const pendentes = [...filas.values()];
    const trabalhar = async (): Promise<void> => {
      for (;;) {
        const fila = pendentes.shift();
        if (!fila) return;
        for (const e of fila) {
          if (resultado.interrompida) {
            resultado.demais.push({
              empresaId: e.id,
              codigo: e.codigo,
              status: 'nao_executada',
              aplicadas: [],
              versaoSchema: null,
            });
            continue;
          }
          const r = await migrar(e);
          resultado.demais.push(r);
          if (r.status === 'falhou') {
            resultado.falhas++;
            if (opcoes.pararNoPrimeiroErro) resultado.interrompida = true;
          }
        }
      }
    };
    const lote = Math.max(1, opcoes.lote ?? this.opcoes.lote);
    await Promise.all(Array.from({ length: Math.min(lote, pendentes.length) }, trabalhar));
    resultado.demais.sort((a, b) => a.codigo - b.codigo);
    await this.auditar(opcoes.adminId, resultado);
    return resultado;
  }

  /**
   * Situação (ERP 19.7): a última migração do código × `empresas.versao_schema` de cada empresa, com o erro mais
   * recente de `migracoes_empresas` e o log das últimas execuções.
   */
  async situacao(opcoes: { pasta?: string; filtro?: 'todas' | 'atrasadas' | 'com_erro' } = {}) {
    const migracoes = lerMigracoes(opcoes.pasta ?? PASTA_MIGRACOES_EMPRESA);
    const ordemPorTag = new Map(migracoes.map((m) => [m.tag, m.ordem]));
    const alvos = await this.controle.db
      .select({
        id: empresas.id,
        codigo: empresas.codigo,
        razaoSocial: empresas.razaoSocial,
        nomeFantasia: empresas.nomeFantasia,
        status: empresas.status,
        canario: empresas.canario,
        versaoSchema: empresas.versaoSchema,
      })
      .from(empresas)
      .where(and(inArray(empresas.status, [...STATUS_MIGRAVEIS]), isNull(empresas.excluidoEm)))
      .orderBy(asc(empresas.codigo));
    const registros = alvos.length
      ? await this.controle.db
          .select({
            empresaId: migracoesEmpresas.empresaId,
            migracao: migracoesEmpresas.migracao,
            status: migracoesEmpresas.status,
            erro: migracoesEmpresas.erro,
            iniciadaEm: migracoesEmpresas.iniciadaEm,
            concluidaEm: migracoesEmpresas.concluidaEm,
          })
          .from(migracoesEmpresas)
          .where(
            inArray(
              migracoesEmpresas.empresaId,
              alvos.map((a) => a.id),
            ),
          )
      : [];
    const porEmpresa = new Map<string, typeof registros>();
    for (const r of registros) porEmpresa.set(r.empresaId, [...(porEmpresa.get(r.empresaId) ?? []), r]);

    const todas: EmpresaSituacaoMigracao[] = alvos.map((e) => {
      const regs = porEmpresa.get(e.id) ?? [];
      const ordemAtual = e.versaoSchema === null ? -1 : ordemPorTag.get(e.versaoSchema);
      const pendentes =
        ordemAtual === undefined ? [] : migracoes.filter((m) => m.ordem > ordemAtual).map((m) => m.tag);
      const falha = regs
        .filter((r) => r.status === 'falhou')
        .sort((a, b) => (b.concluidaEm?.getTime() ?? 0) - (a.concluidaEm?.getTime() ?? 0))[0];
      const instantes = regs.map((r) => (r.concluidaEm ?? r.iniciadaEm)?.getTime() ?? 0);
      const ultima = instantes.length ? Math.max(...instantes) : 0;
      // Versão gravada que o código não conhece: banco à frente desta versão da API (deploy antigo).
      const situacao: SituacaoMigracaoEmpresa = falha
        ? 'com_erro'
        : regs.some((r) => r.status === 'aplicando')
          ? 'aplicando'
          : ordemAtual === undefined
            ? 'desconhecida'
            : pendentes.length > 0
              ? 'atrasada'
              : 'em_dia';
      return {
        ...e,
        status: e.status as EmpresaSituacaoMigracao['status'],
        pendentes,
        situacao,
        migracaoComErro: falha?.migracao ?? null,
        erro: falha?.erro ?? null,
        ultimaExecucaoEm: ultima ? new Date(ultima).toISOString() : null,
      };
    });
    const filtro = opcoes.filtro ?? 'todas';
    const visiveis = todas.filter((e) =>
      filtro === 'atrasadas'
        ? e.pendentes.length > 0 || e.situacao === 'com_erro'
        : filtro === 'com_erro'
          ? e.situacao === 'com_erro'
          : true,
    );
    const resultado: SituacaoMigracoes = {
      versaoAtual: migracoes.at(-1)?.tag ?? null,
      migracoes: migracoes.map((m) => ({ ordem: m.ordem, tag: m.tag, hash: m.hash })),
      resumo: {
        empresas: todas.length,
        emDia: todas.filter((e) => e.situacao === 'em_dia').length,
        atrasadas: todas.filter((e) => e.pendentes.length > 0).length,
        comErro: todas.filter((e) => e.situacao === 'com_erro').length,
      },
      empresas: visiveis,
      execucoes: await this.execucoes(),
    };
    return resultado;
  }

  /** Log do "Aplicar": cada execução grava um resumo em `auditoria_plataforma` (ver `auditar`). */
  private async execucoes(limite = 20): Promise<ExecucaoMigracoes[]> {
    const linhas = await this.controle.db
      .select({
        id: auditoriaPlataforma.id,
        criadoEm: auditoriaPlataforma.criadoEm,
        depois: auditoriaPlataforma.depois,
        adminNome: adminsPlataforma.nome,
      })
      .from(auditoriaPlataforma)
      .leftJoin(adminsPlataforma, eq(adminsPlataforma.id, auditoriaPlataforma.adminId))
      .where(eq(auditoriaPlataforma.acao, 'migracao_executada'))
      .orderBy(desc(auditoriaPlataforma.criadoEm))
      .limit(limite);
    return linhas.map((l) => {
      const d = (l.depois ?? {}) as Partial<{
        executado_por: string;
        falhas: number;
        interrompida: boolean;
        empresas: ExecucaoMigracoes['empresas'];
      }>;
      return {
        id: l.id,
        ocorridoEm: l.criadoEm.toISOString(),
        adminNome: l.adminNome ?? null,
        executadoPor: d.executado_por ?? null,
        falhas: d.falhas ?? 0,
        interrompida: d.interrompida ?? false,
        empresas: d.empresas ?? [],
      };
    });
  }

  /**
   * "Simular" (ERP 19.7): migrações pendentes e o SQL, sem aplicar. Com `codigo`, lê o registro do próprio banco da
   * empresa (`drizzle.__drizzle_migrations`), o mesmo que o executor consulta, e aponta migrações alteradas depois
   * de aplicadas; sem `codigo`, estima pelo `versao_schema` de cada empresa, sem abrir conexão com os bancos.
   */
  async simular(opcoes: { codigo?: number; pasta?: string } = {}): Promise<SimulacaoMigracoes | null> {
    const migracoes = lerMigracoes(opcoes.pasta ?? PASTA_MIGRACOES_EMPRESA);
    const comSql = (tags: Set<string>) =>
      migracoes
        .filter((m) => tags.has(m.tag))
        .map((m) => ({ ordem: m.ordem, tag: m.tag, sql: m.comandos.join('\n\n') }));

    if (opcoes.codigo === undefined) {
      const s = await this.situacao({ pasta: opcoes.pasta, filtro: 'atrasadas' });
      const empresasPendentes = s.empresas
        .filter((e) => e.pendentes.length > 0)
        .map((e) => ({
          codigo: e.codigo,
          razaoSocial: e.razaoSocial,
          pendentes: e.pendentes,
          alteradas: [],
        }));
      return {
        fonte: 'versao_schema',
        empresas: empresasPendentes,
        migracoes: comSql(new Set(empresasPendentes.flatMap((e) => e.pendentes))),
      };
    }

    const [e] = await this.controle.db
      .select({
        id: empresas.id,
        codigo: empresas.codigo,
        razaoSocial: empresas.razaoSocial,
        nomeBanco: empresas.nomeBanco,
        servidorBancoId: empresas.servidorBancoId,
      })
      .from(empresas)
      .where(and(eq(empresas.codigo, opcoes.codigo), isNull(empresas.excluidoEm)));
    if (!e) return null;
    garantirNomeBancoEmpresa(e.nomeBanco, e.codigo);
    const cliente = await this.servidores.conectar(e.servidorBancoId, e.nomeBanco, 'genesis_migracao');
    try {
      const { rows: existe } = await cliente.query<{ ok: boolean }>(
        "select to_regclass('drizzle.__drizzle_migrations') is not null as ok",
      );
      const { rows } = existe[0]?.ok
        ? await cliente.query<{ hash: string; created_at: string }>(
            'select hash, created_at from drizzle.__drizzle_migrations',
          )
        : { rows: [] };
      const noBanco = new Map(rows.map((r) => [Number(r.created_at), r.hash]));
      const pendentes = migracoes.filter((m) => !noBanco.has(m.quando)).map((m) => m.tag);
      const alteradas = migracoes
        .filter((m) => noBanco.has(m.quando) && noBanco.get(m.quando) !== m.hash)
        .map((m) => m.tag);
      return {
        fonte: 'banco',
        empresas: [{ codigo: e.codigo, razaoSocial: e.razaoSocial, pendentes, alteradas }],
        migracoes: comSql(new Set(pendentes)),
      };
    } finally {
      await cliente.end().catch(() => undefined);
    }
  }

  private async auditar(adminId: string | null | undefined, r: ResultadoMigracaoEmMassa): Promise<void> {
    await registrarAuditoriaPlataforma(this.controle.db, {
      adminId,
      acao: 'migracao_executada',
      entidade: 'migracoes_empresas',
      depois: {
        executado_por: this.executadoPor,
        falhas: r.falhas,
        interrompida: r.interrompida,
        empresas: [...r.canarios, ...r.demais].map((x) => ({
          codigo: x.codigo,
          status: x.status,
          aplicadas: x.aplicadas,
          erro: x.erro,
          avisos: x.avisos,
        })),
      },
    });
  }

  private async registrar(
    empresaId: string,
    m: Migracao,
    status: 'aplicando' | 'aplicada' | 'falhou',
    duracaoMs?: number,
    erro?: string,
  ): Promise<void> {
    const agora = new Date();
    const valores = {
      status,
      ordem: m.ordem,
      hash: m.hash,
      executadoPor: this.executadoPor,
      erro: erro ?? null,
      ...(status === 'aplicando'
        ? { iniciadaEm: agora, concluidaEm: null, duracaoMs: null }
        : { concluidaEm: agora, duracaoMs: duracaoMs ?? null }),
    };
    await this.controle.db
      .insert(migracoesEmpresas)
      .values({ empresaId, migracao: m.tag, iniciadaEm: agora, ...valores })
      .onConflictDoUpdate({
        target: [migracoesEmpresas.empresaId, migracoesEmpresas.migracao],
        set: valores,
      });
  }

  /**
   * Relato de uma preparação (F2-B2): os avisos vão para o resultado (terminal do `db:migrate:empresas`, modal e log do
   * "Aplicar") e o relato inteiro para `auditoria_plataforma` (`migracao_preparada`, com a empresa), o registro que
   * sobra quando a segunda passada já não acha nada. Falhar ao registrar não falha a migração: vira aviso.
   */
  private async registrarPreparacao(
    empresaId: string,
    m: Migracao,
    relato: RelatoPreparacao,
    avisos: string[],
  ): Promise<void> {
    avisos.push(...relato.avisos.map((a) => `${m.tag}: ${a}`));
    await registrarAuditoriaPlataforma(this.controle.db, {
      empresaId,
      acao: 'migracao_preparada',
      entidade: 'migracoes_empresas',
      depois: { migracao: m.tag, executado_por: this.executadoPor, avisos: relato.avisos, ...relato.dados },
    }).catch((e: unknown) => {
      avisos.push(`${m.tag}: relato da preparação não registrado na auditoria (${mensagemErro(e)})`);
    });
  }

  private async registrarJaAplicada(empresaId: string, m: Migracao): Promise<void> {
    await this.controle.db
      .insert(migracoesEmpresas)
      .values({
        empresaId,
        migracao: m.tag,
        ordem: m.ordem,
        hash: m.hash,
        status: 'aplicada',
        executadoPor: this.executadoPor,
        concluidaEm: new Date(),
      })
      .onConflictDoUpdate({
        target: [migracoesEmpresas.empresaId, migracoesEmpresas.migracao],
        set: { status: 'aplicada', erro: null, hash: m.hash },
        setWhere: sql`${migracoesEmpresas.status} <> 'aplicada'`,
      });
  }
}
