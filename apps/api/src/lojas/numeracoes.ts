import { and, eq, isNull, sql } from 'drizzle-orm';
import { caixas, lojas, numeracoes } from '../database/empresa/schema/index.js';
import { ref } from '../comum/cadastro.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

type Escopo = {
  tipo: 'venda' | 'nfce' | 'vale' | 'nfe';
  caixaId: string | null;
  modelo: number | null;
  serie: number | null;
  ambiente: number | null;
  dono: 'nuvem' | 'terminal';
  ultimoNumero?: number;
};

/** Insere a numeração do escopo se ainda não existir (mesma chave de `uq_numeracoes_escopo`). */
async function garantir(tx: DbEmpresa, lojaId: string, e: Escopo): Promise<void> {
  const igual = (
    col:
      | typeof numeracoes.caixaId
      | typeof numeracoes.modelo
      | typeof numeracoes.serie
      | typeof numeracoes.ambiente,
    v: string | number | null,
  ) => (v === null ? isNull(col) : eq(col, v as never));
  const [existe] = await tx
    .select({ id: numeracoes.id })
    .from(numeracoes)
    .where(
      and(
        eq(numeracoes.tipo, e.tipo),
        eq(numeracoes.lojaId, lojaId),
        igual(numeracoes.caixaId, e.caixaId),
        igual(numeracoes.modelo, e.modelo),
        igual(numeracoes.serie, e.serie),
        igual(numeracoes.ambiente, e.ambiente),
        isNull(numeracoes.excluidoEm),
      ),
    );
  if (existe) return;
  await tx.insert(numeracoes).values({
    tipo: e.tipo,
    lojaId,
    caixaId: e.caixaId,
    modelo: e.modelo,
    serie: e.serie,
    ambiente: e.ambiente,
    dono: e.dono,
    ultimoNumero: e.ultimoNumero ?? 0,
  });
}

/**
 * Numerações da loja (MD 7.13, 3.1.4), idempotente: `venda` do caixa 0 (dono `nuvem`), `nfe` da série da loja,
 * e para cada caixa de PDV `venda`, `vale` e `nfce` da série do caixa no ambiente da loja (dono `terminal`). Série ou
 * ambiente trocados criam a numeração nova; a antiga fica (histórico da série).
 */
export async function garantirNumeracoesLoja(tx: DbEmpresa, lojaId: string): Promise<void> {
  const [loja] = await tx.select().from(lojas).where(eq(lojas.id, lojaId));
  if (!loja) return;
  const lista = await tx
    .select()
    .from(caixas)
    .where(and(eq(caixas.lojaId, lojaId), isNull(caixas.excluidoEm)))
    .orderBy(caixas.numero);
  for (const c of lista) {
    if (c.sistema) {
      await garantir(tx, lojaId, {
        tipo: 'venda',
        caixaId: c.id,
        modelo: null,
        serie: null,
        ambiente: null,
        dono: 'nuvem',
      });
      continue;
    }
    for (const tipo of ['venda', 'vale'] as const) {
      await garantir(tx, lojaId, {
        tipo,
        caixaId: c.id,
        modelo: null,
        serie: null,
        ambiente: null,
        dono: 'terminal',
      });
    }
    if (c.nfceSerie !== null) {
      await garantir(tx, lojaId, {
        tipo: 'nfce',
        caixaId: c.id,
        modelo: 65,
        serie: c.nfceSerie,
        ambiente: loja.nfceAmbiente,
        dono: 'terminal',
      });
    }
  }
  if (loja.nfeSerie !== null) {
    await garantir(tx, lojaId, {
      tipo: 'nfe',
      caixaId: null,
      modelo: 55,
      serie: loja.nfeSerie,
      ambiente: loja.nfceAmbiente,
      dono: 'nuvem',
    });
  }
}

/** Último número da NFC-e do caixa na série/ambiente atuais. */
export async function numeracaoNfce(
  db: DbEmpresa,
  caixa: { id: string; nfceSerie: number | null },
  ambiente: number,
): Promise<{ id: string; ultimoNumero: number } | null> {
  if (caixa.nfceSerie === null) return null;
  const [n] = await db
    .select({ id: numeracoes.id, ultimoNumero: numeracoes.ultimoNumero })
    .from(numeracoes)
    .where(
      and(
        eq(numeracoes.tipo, 'nfce'),
        eq(numeracoes.caixaId, caixa.id),
        eq(numeracoes.serie, caixa.nfceSerie),
        eq(numeracoes.ambiente, ambiente),
        isNull(numeracoes.excluidoEm),
      ),
    );
  return n ?? null;
}

export const sqlUltimoNumero = (tipo: string) =>
  sql<
    number | null
  >`(select n.ultimo_numero from numeracoes n where n.caixa_id = ${ref('caixas')} and n.tipo = ${tipo} and n.excluido_em is null order by n.criado_em desc limit 1)`;
