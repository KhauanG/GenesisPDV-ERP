import { criarCliente } from './http';

/** API do ERP: token de audiência `erp`, cookie de refresh em `/api/auth`. */
export const apiErp = criarCliente({
  base: '/api',
  caminhoRefresh: '/auth/refresh',
  caminhoLogout: '/auth/logout',
  nomeTrava: 'genesis-erp-refresh',
  chaveSaidaPendente: 'genesis:erp-saida-pendente',
});

/** Painel da plataforma: token próprio (audiência `plataforma`), cookie em `/api/plataforma/auth` (ERP 19.1). */
export const apiPlataforma = criarCliente({
  base: '/api/plataforma',
  caminhoRefresh: '/auth/refresh',
  caminhoLogout: '/auth/logout',
  nomeTrava: 'genesis-plataforma-refresh',
  chaveSaidaPendente: 'genesis:plataforma-saida-pendente',
});
