import type { LoginPlataforma, PapelAdmin } from '@genesis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiPlataforma } from '../api/clientes';

export interface AdminPlataforma {
  id: string;
  nome: string;
  email: string;
  papel: PapelAdmin;
}

interface RespostaSessaoAdmin {
  tokenAcesso: string;
  expiraEm: string;
  admin: AdminPlataforma;
}

type Estado =
  { status: 'carregando' } | { status: 'anonimo' } | { status: 'autenticado'; admin: AdminPlataforma };

interface SessaoPlataforma {
  estado: Estado;
  entrar(dados: LoginPlataforma): Promise<void>;
  sair(): Promise<void>;
  /** Papéis que podem a ação (o `superadmin` pode tudo), mesma regra da API (README da API, decisão 16). */
  temPapel(...papeis: PapelAdmin[]): boolean;
}

const Contexto = createContext<SessaoPlataforma | null>(null);

/** Sessão do painel da plataforma: token próprio só em memória, refresh por cookie em `/api/plataforma/auth`. */
export function ProvedorSessaoPlataforma({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ status: 'carregando' });
  const queryClient = useQueryClient();

  useEffect(() => {
    const desligar = apiPlataforma.ouvir({
      aoExpirar: () => {
        apiPlataforma.limpar();
        setEstado({ status: 'anonimo' });
      },
    });
    let ativo = true;
    void apiPlataforma.renovar().then((r) => {
      if (!ativo) return;
      const s = r as RespostaSessaoAdmin | null;
      setEstado(s ? { status: 'autenticado', admin: s.admin } : { status: 'anonimo' });
    });
    return () => {
      ativo = false;
      desligar();
    };
  }, []);

  const entrar = useCallback(async (dados: LoginPlataforma) => {
    const r = await apiPlataforma.post<RespostaSessaoAdmin>('/auth/login', dados, { semRenovar: true });
    apiPlataforma.definirSessao(r);
    setEstado({ status: 'autenticado', admin: r.admin });
  }, []);

  const sair = useCallback(async () => {
    await apiPlataforma.post('/auth/logout', undefined, { semRenovar: true }).catch(() => undefined);
    apiPlataforma.limpar();
    queryClient.removeQueries({ queryKey: ['plataforma'] });
    setEstado({ status: 'anonimo' });
  }, [queryClient]);

  const temPapel = useCallback(
    (...papeis: PapelAdmin[]) =>
      estado.status === 'autenticado' &&
      (estado.admin.papel === 'superadmin' || papeis.includes(estado.admin.papel)),
    [estado],
  );

  const valor = useMemo(() => ({ estado, entrar, sair, temPapel }), [estado, entrar, sair, temPapel]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessaoPlataforma(): SessaoPlataforma {
  const s = useContext(Contexto);
  if (!s) throw new Error('useSessaoPlataforma fora do provedor');
  return s;
}
