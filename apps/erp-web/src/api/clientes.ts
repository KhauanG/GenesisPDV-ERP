import { criarCliente } from './http';

/** API do ERP: token de audiência `erp`, cookie de refresh em `/api/auth`. */
export const apiErp = criarCliente({
  base: '/api',
  caminhoRefresh: '/auth/refresh',
  nomeTrava: 'genesis-erp-refresh',
});

/** Painel da plataforma: token próprio (audiência `plataforma`), cookie em `/api/plataforma/auth` (ERP 19.1). */
export const apiPlataforma = criarCliente({
  base: '/api/plataforma',
  caminhoRefresh: '/auth/refresh',
  nomeTrava: 'genesis-plataforma-refresh',
});
