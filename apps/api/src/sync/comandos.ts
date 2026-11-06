/**
 * Produtores de `comandos_terminal` (SYNC 21.1; ERP 12.4): o heartbeat entrega os `pendente`/`entregue` em ordem e
 * recebe o resultado. Grava na transação de quem pede (o comando só existe se a mudança que o motivou for
 * confirmada). Comandos idempotentes (`revogar`, `ressincronizar`, `ressincronizar_fluxo` do mesmo fluxo) não se
 * repetem enquanto um igual ainda não foi entregue; `mensagem` sempre gera um novo. O `revogar` do `desativando`
 * tem regra própria (`garantirComandoRevogar`), usada pelo heartbeat e pela revogação no ERP.
 */
import type { Fluxo } from '@genesis/shared';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { comandosTerminal, terminais, TIPOS_COMANDO_TERMINAL } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

export type TipoComando = (typeof TIPOS_COMANDO_TERMINAL)[number];

const IDEMPOTENTES: ReadonlySet<TipoComando> = new Set(['revogar', 'ressincronizar', 'ressincronizar_fluxo']);

export interface PedidoComando {
  tipo: TipoComando;
  parametros?: Record<string, unknown>;
  usuarioId?: string | null;
}

/** Enfileira o mesmo comando para cada terminal; devolve os ids gravados (o pendente igual, quando já existia). */
export async function enfileirarComandos(
  tx: DbEmpresa,
  terminalIds: readonly string[],
  pedido: PedidoComando,
): Promise<string[]> {
  if (!terminalIds.length) return [];
  const parametros = pedido.parametros ?? {};
  const ids: string[] = [];
  const novos: string[] = [];
  if (IDEMPOTENTES.has(pedido.tipo)) {
    const pendentes = await tx
      .select({ id: comandosTerminal.id, terminalId: comandosTerminal.terminalId })
      .from(comandosTerminal)
      .where(
        and(
          inArray(comandosTerminal.terminalId, [...terminalIds]),
          eq(comandosTerminal.tipo, pedido.tipo),
          eq(comandosTerminal.status, 'pendente'),
          isNull(comandosTerminal.excluidoEm),
          sql`${comandosTerminal.parametros} = ${JSON.stringify(parametros)}::jsonb`,
        ),
      );
    const jaTem = new Map(pendentes.map((p) => [p.terminalId, p.id]));
    for (const t of terminalIds) {
      const id = jaTem.get(t);
      if (id) ids.push(id);
      else novos.push(t);
    }
  } else {
    novos.push(...terminalIds);
  }
  if (novos.length) {
    const gravados = await tx
      .insert(comandosTerminal)
      .values(
        novos.map((terminalId) => ({
          terminalId,
          tipo: pedido.tipo,
          parametros,
          criadoPorId: pedido.usuarioId ?? null,
          atualizadoPorId: pedido.usuarioId ?? null,
        })),
      )
      .returning({ id: comandosTerminal.id });
    ids.push(...gravados.map((g) => g.id));
  }
  return ids;
}

/** Um comando para um terminal. */
export async function enfileirarComando(
  tx: DbEmpresa,
  terminalId: string,
  pedido: PedidoComando,
): Promise<string> {
  const [id] = await enfileirarComandos(tx, [terminalId], pedido);
  return id!;
}

/**
 * SYNC 3.8: o `desativando` recebe `revogar` até confirmar. Um por terminal: o existente (pendente, entregue,
 * executado ou com falha) vale, porque o PDV já o tem e repetir a cada heartbeat só empilharia comandos; só um
 * cancelado ou excluído dá lugar a outro. Devolve o id do existente ou do novo.
 */
export async function garantirComandoRevogar(
  tx: DbEmpresa,
  terminalId: string,
  usuarioId: string | null = null,
): Promise<string> {
  const [existente] = await tx
    .select({ id: comandosTerminal.id })
    .from(comandosTerminal)
    .where(
      and(
        eq(comandosTerminal.terminalId, terminalId),
        eq(comandosTerminal.tipo, 'revogar'),
        ne(comandosTerminal.status, 'cancelado'),
        isNull(comandosTerminal.excluidoEm),
      ),
    )
    .limit(1);
  if (existente) return existente.id;
  return enfileirarComando(tx, terminalId, { tipo: 'revogar', usuarioId });
}

/**
 * Mudança estrutural (MD 6.4 regra 3; SYNC 6.7): `ressincronizar_fluxo` de cada fluxo para os terminais que ainda
 * falam com a nuvem (`ativo`/`desativando`) da loja informada ou, com `'todas'`, de todas as lojas (mudança de cadastro
 * da empresa inteira, como `tipos_estoque.vendavel`). Devolve quantos terminais foram alcançados.
 */
export async function ressincronizarFluxos(
  tx: DbEmpresa,
  lojas: { lojaId: string } | 'todas',
  fluxos: readonly Fluxo[],
  usuarioId: string | null = null,
): Promise<number> {
  if (!fluxos.length) return 0;
  const alvos = await tx
    .select({ id: terminais.id })
    .from(terminais)
    .where(
      and(
        lojas === 'todas' ? undefined : eq(terminais.lojaId, lojas.lojaId),
        inArray(terminais.status, ['ativo', 'desativando']),
        isNull(terminais.excluidoEm),
      ),
    );
  const ids = alvos.map((t) => t.id);
  for (const fluxo of [...new Set(fluxos)]) {
    await enfileirarComandos(tx, ids, { tipo: 'ressincronizar_fluxo', parametros: { fluxo }, usuarioId });
  }
  return ids.length;
}

/** Mudança estrutural da loja (troca do estoque, UF, município…): `ressincronizarFluxos` dos terminais dela. */
export async function ressincronizarFluxosDaLoja(
  tx: DbEmpresa,
  lojaId: string,
  fluxos: readonly Fluxo[],
  usuarioId: string | null = null,
): Promise<number> {
  return ressincronizarFluxos(tx, { lojaId }, fluxos, usuarioId);
}
