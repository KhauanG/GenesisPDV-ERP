import { SetMetadata } from '@nestjs/common';
import { permissaoExiste, type PapelAdmin } from '@genesis/shared';

export const META_PUBLICO = 'genesis:publico';
export const META_PERMISSOES = 'genesis:permissoes';
export const META_PLATAFORMA = 'genesis:plataforma';
export const META_SENHA_PROVISORIA = 'genesis:senha_provisoria';

/** Rota sem autenticação (login, refresh, saúde). */
export const Publico = () => SetMetadata(META_PUBLICO, true);

/**
 * Exige as permissões do catálogo `packages/shared/permissoes.ts` (todas as listadas). Chave fora do catálogo é
 * erro de programação e falha já na carga do módulo.
 */
export const Permissao = (...chaves: string[]) => {
  for (const c of chaves) if (!permissaoExiste(c)) throw new Error(`Permissão fora do catálogo: ${c}`);
  return SetMetadata(META_PERMISSOES, chaves);
};

/** Rota do painel da plataforma (token de audiência `plataforma`); sem papéis = qualquer admin ativo. */
export const RotaPlataforma = (...papeis: PapelAdmin[]) => SetMetadata(META_PLATAFORMA, papeis);

/** Rota acessível enquanto a troca obrigatória da senha provisória não foi feita. */
export const PermiteSenhaProvisoria = () => SetMetadata(META_SENHA_PROVISORIA, true);
