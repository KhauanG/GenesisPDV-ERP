import { eq, sql, type SQL } from 'drizzle-orm';
import type { StatusEmpresa } from '@genesis/shared';
import { ErroApi } from '../comum/erros.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas } from '../database/controle/schema.js';
import { criarContexto, type ContextoEmpresa } from './contexto.js';

export interface EmpresaResolvida {
  id: string;
  codigo: number;
  razaoSocial: string;
  nomeFantasia: string | null;
  nomeBanco: string;
  servidorBancoId: string;
  geracaoBanco: number;
  status: StatusEmpresa;
  motivoStatus: string | null;
  /**
   * Migração com falha (inclusive hash divergente) ou schema abaixo do mínimo exigido por este código (MD 2.12;
   * ERP 19.7): a API responde 503 só para esta empresa. Migração em andamento não tira a empresa do ar
   * (expandir/contrair).
   */
  emManutencao: boolean;
  excluida: boolean;
}

/**
 * Schema mínimo que este código exige do banco da empresa: a última migração do journal com que ele foi
 * publicado (ordem). Tag desconhecida no journal = migração mais nova que o código (deploy anterior à migração em
 * massa terminar, ou código antigo ainda no ar): compatível por expandir/contrair.
 */
export interface ExigenciaSchema {
  ordemPorTag: ReadonlyMap<string, number>;
  ordemMinima: number;
}

export function schemaAtende(versaoSchema: string | null, exigencia: ExigenciaSchema | undefined): boolean {
  if (!exigencia) return true;
  if (!versaoSchema) return false;
  const ordem = exigencia.ordemPorTag.get(versaoSchema);
  return ordem === undefined || ordem >= exigencia.ordemMinima;
}

/** Busca a empresa no controle por código (login) ou id (token) com cache curto. */
export class ResolvedorEmpresas {
  private readonly cache = new Map<string, { valor: EmpresaResolvida | null; expira: number }>();

  constructor(
    private readonly controle: BancoControle,
    private readonly cacheMs: number,
    private readonly exigencia?: ExigenciaSchema,
  ) {}

  porCodigo(codigo: number): Promise<EmpresaResolvida | null> {
    return this.buscar(`c:${codigo}`, eq(empresas.codigo, codigo));
  }

  porId(id: string): Promise<EmpresaResolvida | null> {
    return this.buscar(`i:${id}`, eq(empresas.id, id));
  }

  invalidar(): void {
    this.cache.clear();
  }

  contexto(e: EmpresaResolvida): ContextoEmpresa {
    return criarContexto(e);
  }

  /** Regras de acesso do ERP por status (MD 2.3). `credenciaisValidas` = já passou da verificação de senha. */
  verificarAcessoErp(e: EmpresaResolvida, etapa: 'antes_credenciais' | 'depois_credenciais'): void {
    if (e.excluida) throw ErroApi.naoAutenticado();
    if (etapa === 'antes_credenciais') {
      if (e.status === 'migrando' || (e.emManutencao && e.status !== 'provisionando'))
        throw ErroApi.manutencao();
      return;
    }
    if (e.status === 'ativa') return;
    if (e.status === 'cancelada') {
      throw new ErroApi(
        'EMPRESA_CANCELADA',
        'O contrato desta empresa foi cancelado. Entre em contato com o suporte Genesis.',
      );
    }
    const motivo = e.status === 'suspensa' && e.motivoStatus ? ` Motivo: ${e.motivoStatus}` : '';
    throw new ErroApi(
      'EMPRESA_SUSPENSA',
      `Acesso suspenso. Entre em contato com o suporte Genesis.${motivo}`,
      e.motivoStatus ? { detalhes: { motivo: e.motivoStatus } } : {},
    );
  }

  private async buscar(chave: string, condicao: SQL): Promise<EmpresaResolvida | null> {
    const agora = Date.now();
    const emCache = this.cache.get(chave);
    if (emCache && emCache.expira > agora) return emCache.valor;
    const [e] = await this.controle.db
      .select({
        id: empresas.id,
        codigo: empresas.codigo,
        razaoSocial: empresas.razaoSocial,
        nomeFantasia: empresas.nomeFantasia,
        nomeBanco: empresas.nomeBanco,
        servidorBancoId: empresas.servidorBancoId,
        geracaoBanco: empresas.geracaoBanco,
        status: empresas.status,
        motivoStatus: empresas.motivoStatus,
        excluidoEm: empresas.excluidoEm,
        versaoSchema: empresas.versaoSchema,
        migracaoFalhou: sql<boolean>`exists (select 1 from migracoes_empresas m where m.empresa_id = empresas.id and m.status = 'falhou')`,
      })
      .from(empresas)
      .where(condicao);
    const valor: EmpresaResolvida | null = e
      ? {
          id: e.id,
          codigo: e.codigo,
          razaoSocial: e.razaoSocial,
          nomeFantasia: e.nomeFantasia,
          nomeBanco: e.nomeBanco,
          servidorBancoId: e.servidorBancoId,
          geracaoBanco: e.geracaoBanco,
          status: e.status as StatusEmpresa,
          motivoStatus: e.motivoStatus,
          emManutencao:
            e.migracaoFalhou ||
            (e.status !== 'provisionando' && !schemaAtende(e.versaoSchema, this.exigencia)),
          excluida: e.excluidoEm !== null,
        }
      : null;
    if (this.cacheMs > 0) this.cache.set(chave, { valor, expira: agora + this.cacheMs });
    return valor;
  }
}
