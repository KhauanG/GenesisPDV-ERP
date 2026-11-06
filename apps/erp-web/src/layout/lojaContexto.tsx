import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { gravarLocal, lerLocal } from '../util/armazenamento';

interface LojaContexto {
  /** `null` = "Todas as lojas". */
  lojaId: string | null;
  definir(lojaId: string | null): void;
}

const Contexto = createContext<LojaContexto>({ lojaId: null, definir: () => undefined });

/**
 * Loja de contexto do cabeçalho (ERP 5.2): só conveniência para pré-preencher filtros e documentos; a segurança
 * está nas lojas permitidas da API. Guardada por empresa + usuário; loja que deixou de ser permitida volta a "Todas".
 */
export function ProvedorLojaContexto({
  chave,
  permitidas,
  children,
}: {
  chave: string;
  permitidas: readonly string[];
  children: ReactNode;
}) {
  const [salva, setSalva] = useState<string | null>(() => lerLocal(chave));
  const lojaId = salva && permitidas.includes(salva) ? salva : null;
  const definir = useCallback(
    (id: string | null) => {
      setSalva(id);
      gravarLocal(chave, id);
    },
    [chave],
  );
  const valor = useMemo(() => ({ lojaId, definir }), [lojaId, definir]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useLojaContexto(): LojaContexto {
  return useContext(Contexto);
}
