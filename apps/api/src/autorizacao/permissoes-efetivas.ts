import { and, eq, isNull, sql } from 'drizzle-orm';
import { calcularPermissoesEfetivas } from '@genesis/shared';
import {
  estoques,
  lojas,
  perfisPermissoes,
  usuariosEstoques,
  usuariosLojas,
  usuariosPermissoes,
} from '../database/empresa/schema/index.js';
import { PERMISSAO_TODOS_ESTOQUES } from '../estoques/permitidos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

export interface AcessoUsuario {
  permissoes: ReadonlySet<string>;
  /** `null` = todas as lojas (Master). */
  lojas: readonly string[] | null;
  /**
   * Estoques permitidos (`usuarios_estoques`, inclusive os sem loja; decisão 149); `null` = todos (Master ou
   * `estoques.todos`).
   */
  estoques: readonly string[] | null;
}

/**
 * Geração das permissões da empresa: maior `versao` das tabelas que compõem a permissão efetiva (cada `max` é uma
 * descida no índice `ix_<tabela>_versao`). Qualquer mudança de perfil, item de perfil, ajuste individual, loja
 * permitida, estoque permitido ou loja (inclusive exclusão lógica, que é UPDATE) muda a geração e invalida o cache em todas as
 * instâncias da API, mesmo quando quem alterou não incrementou `usuarios.permissoes_versao`.
 */
export const SQL_GERACAO_PERMISSOES = sql<string>`(select greatest(
  (select coalesce(max(versao), 0) from perfis),
  (select coalesce(max(versao), 0) from perfis_permissoes),
  (select coalesce(max(versao), 0) from usuarios_permissoes),
  (select coalesce(max(versao), 0) from usuarios_lojas),
  (select coalesce(max(versao), 0) from usuarios_estoques),
  (select coalesce(max(versao), 0) from lojas)
)::text)`;

/** Rede de segurança: nenhuma entrada vive mais que isso, mesmo que a geração não mude. */
const VALIDADE_MS = 60_000;

/**
 * Permissão efetiva = (perfil ∪ concedidas) − negadas; Master = todas (MD 3.3.4). Cache por (empresa, usuário,
 * `permissoes_versao`, master, perfil, geração da empresa), com validade de 60 s.
 */
export class PermissoesEfetivas {
  private readonly cache = new Map<string, { acesso: AcessoUsuario; expira: number }>();

  constructor(private readonly maximo = 5000) {}

  async obter(
    db: DbEmpresa,
    empresaId: string,
    usuario: { id: string; master: boolean; perfilId: string | null; permissoesVersao: number },
    geracao?: string,
  ): Promise<AcessoUsuario> {
    const ger =
      geracao ?? (await db.execute<{ g: string }>(sql`select ${SQL_GERACAO_PERMISSOES} as g`)).rows[0]!.g;
    const chave = `${empresaId}|${usuario.id}|${usuario.permissoesVersao}|${usuario.master}|${usuario.perfilId}|${ger}`;
    const agora = Date.now();
    const emCache = this.cache.get(chave);
    if (emCache && emCache.expira > agora) return emCache.acesso;
    const acesso = await this.calcular(db, usuario);
    this.cache.delete(chave);
    while (this.cache.size >= this.maximo) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(chave, { acesso, expira: agora + VALIDADE_MS });
    return acesso;
  }

  private async calcular(
    db: DbEmpresa,
    u: { id: string; master: boolean; perfilId: string | null },
  ): Promise<AcessoUsuario> {
    if (u.master)
      return {
        permissoes: calcularPermissoesEfetivas({ master: true, doPerfil: [] }),
        lojas: null,
        estoques: null,
      };
    const doPerfil = u.perfilId
      ? await db
          .select({ p: perfisPermissoes.permissao })
          .from(perfisPermissoes)
          .where(and(eq(perfisPermissoes.perfilId, u.perfilId), isNull(perfisPermissoes.excluidoEm)))
      : [];
    const ajustes = await db
      .select({ p: usuariosPermissoes.permissao, efeito: usuariosPermissoes.efeito })
      .from(usuariosPermissoes)
      .where(and(eq(usuariosPermissoes.usuarioId, u.id), isNull(usuariosPermissoes.excluidoEm)));
    const lojasPermitidas = await db
      .select({ id: usuariosLojas.lojaId })
      .from(usuariosLojas)
      .innerJoin(lojas, eq(lojas.id, usuariosLojas.lojaId))
      .where(
        and(eq(usuariosLojas.usuarioId, u.id), isNull(usuariosLojas.excluidoEm), isNull(lojas.excluidoEm)),
      );
    const permissoes = calcularPermissoesEfetivas({
      master: false,
      doPerfil: doPerfil.map((r) => r.p),
      concedidas: ajustes.filter((a) => a.efeito === 'conceder').map((a) => a.p),
      negadas: ajustes.filter((a) => a.efeito === 'negar').map((a) => a.p),
    });
    // Estoques permitidos (decisão 149): só `usuarios_estoques`, sem herdar das lojas; `estoques.todos` = todos.
    const estoquesPermitidos = permissoes.has(PERMISSAO_TODOS_ESTOQUES)
      ? null
      : (
          await db
            .select({ id: usuariosEstoques.estoqueId })
            .from(usuariosEstoques)
            .innerJoin(estoques, eq(estoques.id, usuariosEstoques.estoqueId))
            .where(
              and(
                eq(usuariosEstoques.usuarioId, u.id),
                isNull(usuariosEstoques.excluidoEm),
                isNull(estoques.excluidoEm),
              ),
            )
        ).map((e) => e.id);
    return { permissoes, lojas: lojasPermitidas.map((l) => l.id), estoques: estoquesPermitidos };
  }
}
