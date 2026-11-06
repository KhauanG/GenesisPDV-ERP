/**
 * Tarefa diária da expiração de `pessoas_relevancia_loja` (MD 3.5.4; C14): em cada empresa acessível (ativa ou
 * suspensa: os dados pessoais saem do PC do caixa mesmo com o contrato suspenso), `expirarRelevancias` em lotes, uma
 * transação curta com a trava de versão por lote, até sobrar menos que um lote. Agendada pelo `schedule` do pg-boss
 * (um job por ocorrência, mesmo com várias instâncias) às 04:17 de Brasília, fora do movimento das lojas; uma
 * execução por vez (trava consultiva de sessão no controle); uma empresa com erro não impede as outras, mas vai para o
 * log e faz o job falhar no fim, para o pg-boss tentar de novo (`trabalhoPorEmpresas`, `infra/fila.ts`). Antes dos
 * lotes, a data futura vira hoje (`corrigirRelevanciasFuturas`).
 */
import { and, inArray, isNull } from 'drizzle-orm';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas } from '../database/controle/schema.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import {
  corrigirRelevanciasFuturas,
  expirarRelevancias,
  LOTE_EXPIRACAO_RELEVANCIA,
  type ExpiradasRelevancia,
} from './relevancia.js';

/** 07:17 UTC = 04:17 em Brasília (UTC−3, sem horário de verão). */
export const CRON_EXPIRACAO_RELEVANCIA = '17 7 * * *';

export interface ResumoExpiracaoRelevancia extends ExpiradasRelevancia {
  executada: boolean;
  empresas: number;
  /** Linhas com data no futuro que passaram a valer hoje (`corrigirRelevanciasFuturas`). */
  datasFuturasCorrigidas: number;
  /** Lotes (transações) de `expirarRelevancias`, somadas as empresas. */
  lotes: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

export class ExpiracaoRelevancia {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly lote = LOTE_EXPIRACAO_RELEVANCIA,
  ) {}

  async executar(): Promise<ResumoExpiracaoRelevancia> {
    const resumo: ResumoExpiracaoRelevancia = {
      executada: false,
      empresas: 0,
      compra: 0,
      delivery: 0,
      crediario: 0,
      datasFuturasCorrigidas: 0,
      lotes: 0,
      falhas: [],
    };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:expiracao_relevancia')) as ok",
      );
      if (!rows[0]?.ok) return resumo;
      try {
        resumo.executada = true;
        await this.executarEmpresas(resumo);
      } finally {
        await trava.query("select pg_advisory_unlock(hashtext('genesis:expiracao_relevancia'))");
      }
    } finally {
      trava.release();
    }
    return resumo;
  }

  private async executarEmpresas(resumo: ResumoExpiracaoRelevancia): Promise<void> {
    const lista = await this.controle.db
      .select({ id: empresas.id })
      .from(empresas)
      .where(and(inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)));
    for (const { id } of lista) {
      try {
        const empresa = await this.resolvedor.porId(id);
        if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') continue;
        await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), async () => {
          resumo.datasFuturasCorrigidas += await this.tenancy
            .cx()
            .transacao((tx) => corrigirRelevanciasFuturas(tx), { travaVersao: true, esperaSemLimite: true });
          for (;;) {
            const r = await this.tenancy.cx().transacao((tx) => expirarRelevancias(tx, this.lote), {
              travaVersao: true,
              esperaSemLimite: true,
            });
            resumo.lotes++;
            resumo.compra += r.compra;
            resumo.delivery += r.delivery;
            resumo.crediario += r.crediario;
            if (r.compra + r.delivery + r.crediario < this.lote) break;
          }
        });
        resumo.empresas++;
      } catch (e) {
        resumo.falhas.push({ empresaId: id, erro: (e as Error).message });
      }
    }
  }
}
