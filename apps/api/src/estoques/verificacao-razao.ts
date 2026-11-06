/**
 * Verificação periódica do razão de estoque (Fase 2, F2-B3; README da API › decisão 147), **opcional e desligada por
 * padrão**: só liga com `VERIFICACAO_RAZAO_CRON` (cron em UTC no `schedule` do pg-boss). Em cada empresa acessível,
 * `verificarSaldos` pela role de runtime (só lê, numa transação `repeatable read read only`) e, com divergência, o
 * alerta `RAZAO_SALDO_DIVERGENTE` (um aberto por empresa, com as contagens e as primeiras linhas); a verificação
 * seguinte idêntica o resolve (ou a conferência idêntica da empresa inteira pelo comando, com ela desligada). **Nunca corrige**: a correção é o `db:recalcular-saldos --corrigir`, rodado por quem
 * opera a plataforma, que olha o relatório antes. Uma execução por vez (trava consultiva de sessão no controle); uma
 * empresa com erro não impede as outras e faz o job falhar no fim (`trabalhoPorEmpresas`).
 */
import { ALERTA_RAZAO_SALDO_DIVERGENTE } from '@genesis/shared';
import { and, inArray, isNull } from 'drizzle-orm';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas } from '../database/controle/schema.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import {
  CHAVE_ALERTA_SALDO_DIVERGENTE,
  projecaoIdentica,
  resolverAlertaSaldoDivergente,
  verificarSaldos,
  type ConexaoRecalculo,
  type RelatorioRecalculo,
} from './recalcular.js';

/** Linhas que vão inteiras no `dados` do alerta (o resto fica nas contagens; a lista completa sai do comando). */
const LINHAS_NO_ALERTA = 20;

export interface ResumoVerificacaoRazao {
  executada: boolean;
  empresas: number;
  /** Empresas com alguma divergência (alerta aberto ou mantido). */
  divergentes: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

export class VerificacaoRazao {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
  ) {}

  async executar(): Promise<ResumoVerificacaoRazao> {
    const resumo: ResumoVerificacaoRazao = { executada: false, empresas: 0, divergentes: 0, falhas: [] };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:verificacao_razao')) as ok",
      );
      if (!rows[0]?.ok) return resumo;
      try {
        resumo.executada = true;
        await this.executarEmpresas(resumo);
      } finally {
        await trava.query("select pg_advisory_unlock(hashtext('genesis:verificacao_razao'))");
      }
    } finally {
      trava.release();
    }
    return resumo;
  }

  private async executarEmpresas(resumo: ResumoVerificacaoRazao): Promise<void> {
    const lista = await this.controle.db
      .select({ id: empresas.id })
      .from(empresas)
      .where(and(inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)));
    for (const { id } of lista) {
      try {
        const empresa = await this.resolvedor.porId(id);
        if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') continue;
        await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), async () => {
          const relatorio = await this.tenancy.cx().consulta((_db, cliente) => verificarSaldos(cliente));
          if (!projecaoIdentica(relatorio)) resumo.divergentes++;
          await this.tenancy.cx().transacao((_tx, cliente) => registrarAlerta(cliente, relatorio));
        });
        resumo.empresas++;
      } catch (e) {
        resumo.falhas.push({ empresaId: id, erro: (e as Error).message });
      }
    }
  }
}

/** Abre (ou atualiza) o alerta da empresa com divergência; resolve o aberto quando a projeção voltou a bater. */
async function registrarAlerta(cliente: ConexaoRecalculo, r: RelatorioRecalculo): Promise<void> {
  if (projecaoIdentica(r)) {
    await resolverAlertaSaldoDivergente(cliente, 'Verificação do razão idêntica');
    return;
  }
  const dados = {
    linhas_conferidas: r.linhas,
    movimentos_conferidos: r.movimentos,
    linhas_divergentes: r.divergencias.length,
    produtos_custo_divergente: r.custoProdutos.length,
    linhas_razao_inconsistente: r.razaoInconsistente.length,
    primeiras: r.divergencias.slice(0, LINHAS_NO_ALERTA).map((d) => ({
      estoque_id: d.estoqueId,
      produto_id: d.produtoId,
      variacao_id: d.variacaoId,
      tipo_estoque_id: d.tipoEstoqueId,
      situacao: d.situacao,
      campos: d.campos.map((c) => c.campo),
    })),
  };
  const mensagem =
    `${r.divergencias.length} linha(s) de saldo e ${r.custoProdutos.length} custo(s) médio(s) de produto diferentes ` +
    'do razão de estoque. Confira o relatório do db:recalcular-saldos e corrija com --corrigir.';
  await cliente.query(
    `insert into alertas (tipo, severidade, titulo, mensagem, entidade, dados, chave_deduplicacao)
     values ($1, 'aviso', 'Saldo de estoque diferente do razão', $2, 'saldos_estoque', $3::jsonb, $4)
     on conflict (chave_deduplicacao) where resolvido_em is null and excluido_em is null
     do update set mensagem = excluded.mensagem, dados = excluded.dados`,
    [ALERTA_RAZAO_SALDO_DIVERGENTE, mensagem, JSON.stringify(dados), CHAVE_ALERTA_SALDO_DIVERGENTE],
  );
}
