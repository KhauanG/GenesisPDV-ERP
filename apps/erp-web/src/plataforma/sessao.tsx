import type { LoginPlataforma, PapelAdmin } from '@genesis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiPlataforma } from '../api/clientes';
import { INTERVALO_NOVA_SAIDA_MS } from '../auth/sessao';

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

/** `saidaPendente`: o "Sair" não foi confirmado pelo servidor (o mesmo tratamento do ERP, decisão 82). */
type Estado =
  | { status: 'carregando' }
  | { status: 'anonimo'; saidaPendente?: boolean }
  | { status: 'autenticado'; admin: AdminPlataforma };

interface SessaoPlataforma {
  estado: Estado;
  entrar(dados: LoginPlataforma): Promise<void>;
  sair(): Promise<void>;
  /** Nova tentativa do logout que falhou; `true` quando o servidor confirmou ou não havia mais saída pendente. */
  concluirSaida(): Promise<boolean>;
  /** Papéis que podem a ação (o `superadmin` pode tudo), mesma regra da API (README da API, decisão 16). */
  temPapel(...papeis: PapelAdmin[]): boolean;
}

const Contexto = createContext<SessaoPlataforma | null>(null);

/**
 * Sessão do painel da plataforma: token próprio só em memória, refresh por cookie em `/api/plataforma/auth`. O "Sair"
 * só vale com o 2xx do servidor; sem ele, nada renova pelo cookie até o logout dar certo (README do ERP › decisão 82).
 * A nova tentativa (`repetirSaida`) nunca regrava o marcador e não chama o servidor se outra aba já o apagou.
 */
export function ProvedorSessaoPlataforma({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ status: 'carregando' });
  const queryClient = useQueryClient();

  useEffect(() => {
    const desligar = apiPlataforma.ouvir({
      aoExpirar: () => {
        apiPlataforma.limpar();
        setEstado({ status: 'anonimo', saidaPendente: apiPlataforma.saidaPendente() });
      },
    });
    let ativo = true;
    void (async () => {
      if (apiPlataforma.saidaPendente()) {
        const saiu = await apiPlataforma.repetirSaida().then(
          () => true,
          () => false,
        );
        if (ativo) setEstado({ status: 'anonimo', saidaPendente: !saiu });
        return;
      }
      const s = (await apiPlataforma.renovar()) as RespostaSessaoAdmin | null;
      if (!ativo) return;
      setEstado(s ? { status: 'autenticado', admin: s.admin } : { status: 'anonimo' });
    })();
    // Outra aba concluiu a saída ou entrou de novo (marcador apagado): nada mais a encerrar por esta.
    const desligarMarcador = apiPlataforma.aoConcluirSaidaEmOutraAba(() =>
      setEstado((e) => (e.status === 'anonimo' && e.saidaPendente ? { status: 'anonimo' } : e)),
    );
    return () => {
      ativo = false;
      desligar();
      desligarMarcador();
    };
  }, []);

  const entrar = useCallback(async (dados: LoginPlataforma) => {
    await apiPlataforma.repetirSaida().catch(() => false);
    const r = await apiPlataforma.abrirSessao<RespostaSessaoAdmin>('/auth/login', dados);
    setEstado({ status: 'autenticado', admin: r.admin });
  }, []);

  const sair = useCallback(async () => {
    let pendente = false;
    try {
      await apiPlataforma.encerrarSessao();
    } catch {
      pendente = true;
    }
    queryClient.removeQueries({ queryKey: ['plataforma'] });
    setEstado({ status: 'anonimo', saidaPendente: pendente });
  }, [queryClient]);

  const concluirSaida = useCallback(async () => {
    try {
      await apiPlataforma.repetirSaida();
    } catch {
      return false;
    }
    setEstado((e) => (e.status === 'anonimo' ? { status: 'anonimo' } : e));
    return true;
  }, []);

  const saidaPendente = estado.status === 'anonimo' && !!estado.saidaPendente;
  useEffect(() => {
    if (!saidaPendente) return;
    const tentar = () => void concluirSaida();
    const intervalo = setInterval(tentar, INTERVALO_NOVA_SAIDA_MS);
    window.addEventListener('online', tentar);
    return () => {
      clearInterval(intervalo);
      window.removeEventListener('online', tentar);
    };
  }, [saidaPendente, concluirSaida]);

  const temPapel = useCallback(
    (...papeis: PapelAdmin[]) =>
      estado.status === 'autenticado' &&
      (estado.admin.papel === 'superadmin' || papeis.includes(estado.admin.papel)),
    [estado],
  );

  const valor = useMemo(
    () => ({ estado, entrar, sair, concluirSaida, temPapel }),
    [estado, entrar, sair, concluirSaida, temPapel],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessaoPlataforma(): SessaoPlataforma {
  const s = useContext(Contexto);
  if (!s) throw new Error('useSessaoPlataforma fora do provedor');
  return s;
}
