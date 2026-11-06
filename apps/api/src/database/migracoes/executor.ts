import type pg from 'pg';
import type { Migracao } from './journal.js';

export class MigracaoAlteradaErro extends Error {
  constructor(readonly tag: string) {
    super(`A migração ${tag} foi alterada depois de aplicada (hash diferente). Crie uma migração nova.`);
    this.name = 'MigracaoAlteradaErro';
  }
}

export interface Ganchos {
  aoIniciar?(m: Migracao): Promise<void>;
  aoConcluir?(m: Migracao, duracaoMs: number): Promise<void>;
  aoFalhar?(m: Migracao, erro: unknown, duracaoMs: number): Promise<void>;
  /** Migração já registrada no banco com o mesmo hash (útil para sincronizar `migracoes_empresas`). */
  aoEncontrarAplicada?(m: Migracao): Promise<void>;
  /**
   * A preparação da migração terminou com um relato (antes do `begin` dela). Chamado mesmo que a migração falhe depois:
   * a próxima execução repete a preparação, mas ela pode não achar mais nada a relatar (já fez o trabalho).
   */
  aoPreparar?(m: Migracao, relato: RelatoPreparacao): Promise<void>;
}

/**
 * O que uma preparação conta a quem migra: `avisos` em texto curto (terminal do `db:migrate:empresas`, resultado e log
 * do "Aplicar") e `dados` para o registro (`auditoria_plataforma`, pelo `MigradorEmpresas`). Só quando houve o que
 * fazer: sem relato, nada é registrado.
 */
export interface RelatoPreparacao {
  avisos: string[];
  dados?: Record<string, unknown>;
}

/**
 * Passo de dados que roda **fora de transação**, na mesma conexão, logo antes de aplicar a migração da tag (Fase 2,
 * F2-B2): o que não cabe numa transação de migração sem travar o banco (preencher uma coluna nova em lotes, `create
 * index concurrently`). Só roda quando a migração ainda vai ser aplicada; tem de ser idempotente, porque uma falha
 * da migração depois dele o faz rodar de novo na próxima execução.
 */
export type PreparacaoMigracao = (cliente: pg.ClientBase) => Promise<RelatoPreparacao | void>;

/**
 * Executor próprio sobre o journal do drizzle-kit ("um schema, N bancos", roadmap Fase 0 › Riscos):
 * mantém a tabela interna do drizzle (`drizzle.__drizzle_migrations`, mesmo formato do migrador oficial), aplica
 * cada migração numa transação com `lock_timeout` (antes dela, a `preparacoes[tag]`, se houver) e confere o hash das
 * já aplicadas.
 */
export async function aplicarMigracoes(
  cliente: pg.ClientBase,
  migracoes: Migracao[],
  opcoes: {
    lockTimeout?: string;
    ganchos?: Ganchos;
    preparacoes?: Readonly<Record<string, PreparacaoMigracao>>;
  } = {},
): Promise<{ aplicadas: string[]; ultima: string | null }> {
  await cliente.query('create schema if not exists drizzle');
  await cliente.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  );
  const { rows } = await cliente.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
  );
  const aplicadasNoBanco = new Map(rows.map((r) => [Number(r.created_at), r.hash]));
  const aplicadas: string[] = [];
  let ultima: string | null = null;

  for (const m of migracoes) {
    const hashGravado = aplicadasNoBanco.get(m.quando);
    if (hashGravado !== undefined) {
      if (hashGravado !== m.hash) {
        const erro = new MigracaoAlteradaErro(m.tag);
        await opcoes.ganchos?.aoFalhar?.(m, erro, 0);
        throw erro;
      }
      await opcoes.ganchos?.aoEncontrarAplicada?.(m);
      ultima = m.tag;
      continue;
    }
    await opcoes.ganchos?.aoIniciar?.(m);
    const inicio = Date.now();
    try {
      const relato = await opcoes.preparacoes?.[m.tag]?.(cliente);
      if (relato) await opcoes.ganchos?.aoPreparar?.(m, relato);
      await cliente.query('begin');
      if (opcoes.lockTimeout)
        await cliente.query(`set local lock_timeout = '${opcoes.lockTimeout.replace(/'/g, '')}'`);
      for (const comando of m.comandos) await cliente.query(comando);
      await cliente.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
        m.hash,
        m.quando,
      ]);
      await cliente.query('commit');
    } catch (erro) {
      await cliente.query('rollback').catch(() => undefined);
      await opcoes.ganchos?.aoFalhar?.(m, erro, Date.now() - inicio);
      throw erro;
    }
    await opcoes.ganchos?.aoConcluir?.(m, Date.now() - inicio);
    aplicadas.push(m.tag);
    ultima = m.tag;
  }
  return { aplicadas, ultima };
}
