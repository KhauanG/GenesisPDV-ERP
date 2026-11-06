import { createContext, useContext } from 'react';

/** Quem pode o quê na tela (o ERP só esconde/desabilita: a API é a fonte da verdade, ERP 2.2). */
export type Pode = (chave: string) => boolean;

const PermissoesContext = createContext<Pode>(() => true);

export const ProvedorPermissoes = PermissoesContext.Provider;

export function usePode(): Pode {
  return useContext(PermissoesContext);
}
