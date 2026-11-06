/**
 * Contexto imutável da empresa de uma requisição/tarefa (visao-geral.md 4.3.1). Só carrega identificadores;
 * conexões saem exclusivamente de `Tenancy.cx()`, que lê o contexto ativo do AsyncLocalStorage.
 */
export interface ContextoEmpresa {
  readonly empresaId: string;
  readonly codigo: number;
  readonly nomeBanco: string;
  readonly servidorBancoId: string;
  readonly geracao: number;
  readonly nome: string;
}

export function criarContexto(e: {
  id: string;
  codigo: number;
  nomeBanco: string;
  servidorBancoId: string;
  geracaoBanco: number;
  razaoSocial: string;
  nomeFantasia: string | null;
}): ContextoEmpresa {
  return Object.freeze({
    empresaId: e.id,
    codigo: e.codigo,
    nomeBanco: e.nomeBanco,
    servidorBancoId: e.servidorBancoId,
    geracao: e.geracaoBanco,
    nome: e.nomeFantasia ?? e.razaoSocial,
  });
}

export function chavePool(c: ContextoEmpresa): string {
  return `${c.empresaId}|${c.servidorBancoId}|${c.nomeBanco}|${c.geracao}`;
}
