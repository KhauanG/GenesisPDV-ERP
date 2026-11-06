import type { LoginEntrada, RespostaEu, RespostaLogin } from '@genesis/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiErp } from '../api/clientes';
import { ProvedorPermissoes } from './permissoes';

export type EstadoSessao =
  | { status: 'carregando' }
  | { status: 'anonimo'; motivo?: 'expirada' | 'saiu' }
  | { status: 'autenticado'; eu: RespostaEu; trocarSenha: boolean };

export interface Sessao {
  estado: EstadoSessao;
  entrar(dados: LoginEntrada): Promise<RespostaLogin>;
  trocarSenha(dados: { senhaAtual: string; novaSenha: string; confirmacao: string }): Promise<void>;
  sair(): Promise<void>;
  pode(chave: string): boolean;
  /** Relê `/auth/eu` (lojas e permissões) depois de criar/alterar lojas ou o próprio acesso. */
  recarregarEu(): Promise<void>;
}

const SessaoContext = createContext<Sessao | null>(null);

const CANAL = 'genesis-erp-sessao';

/**
 * Sessão do ERP: renova pelo cookie ao abrir (o token de acesso nunca é persistido), carrega `/auth/eu`
 * (permissões efetivas e lojas permitidas) e propaga o "Sair" para as outras abas (ERP 4.1, "Várias abas").
 */
export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoSessao>({ status: 'carregando' });
  const queryClient = useQueryClient();
  const canal = useRef<BroadcastChannel | null>(null);

  const encerrarLocal = useCallback(
    (motivo: 'expirada' | 'saiu') => {
      apiErp.limpar();
      queryClient.clear();
      setEstado({ status: 'anonimo', motivo });
    },
    [queryClient],
  );

  const carregarEu = useCallback(async (trocarSenha: boolean) => {
    const eu = await apiErp.get<RespostaEu>('/auth/eu');
    setEstado({ status: 'autenticado', eu, trocarSenha: trocarSenha || eu.usuario.senhaProvisoria });
  }, []);

  useEffect(() => {
    const desligar = apiErp.ouvir({
      aoExpirar: () => encerrarLocal('expirada'),
      aoTrocaSenhaObrigatoria: () =>
        setEstado((e) => (e.status === 'autenticado' ? { ...e, trocarSenha: true } : e)),
    });
    let ativo = true;
    void (async () => {
      const r = (await apiErp.renovar()) as RespostaLogin | null;
      if (!ativo) return;
      if (!r) {
        setEstado({ status: 'anonimo' });
        return;
      }
      try {
        await carregarEu(r.trocarSenha);
      } catch {
        if (ativo) encerrarLocal('expirada');
      }
    })();
    if (typeof BroadcastChannel !== 'undefined') {
      canal.current = new BroadcastChannel(CANAL);
      canal.current.onmessage = (ev: MessageEvent<{ tipo: string }>) => {
        if (ev.data?.tipo === 'saiu') encerrarLocal('saiu');
      };
    }
    return () => {
      ativo = false;
      desligar();
      canal.current?.close();
      canal.current = null;
    };
  }, [carregarEu, encerrarLocal]);

  const entrar = useCallback(
    async (dados: LoginEntrada) => {
      const r = await apiErp.post<RespostaLogin>('/auth/login', dados, { semRenovar: true });
      apiErp.definirSessao(r);
      await carregarEu(r.trocarSenha);
      return r;
    },
    [carregarEu],
  );

  const trocarSenha = useCallback(
    async (dados: { senhaAtual: string; novaSenha: string; confirmacao: string }) => {
      const r = await apiErp.post<RespostaLogin>('/auth/trocar-senha', dados);
      apiErp.definirSessao(r);
      await carregarEu(false);
    },
    [carregarEu],
  );

  const sair = useCallback(async () => {
    await apiErp.post('/auth/logout', undefined, { semRenovar: true }).catch(() => undefined);
    encerrarLocal('saiu');
    canal.current?.postMessage({ tipo: 'saiu' });
  }, [encerrarLocal]);

  const permissoes = useMemo(
    () => new Set(estado.status === 'autenticado' ? estado.eu.permissoes : []),
    [estado],
  );
  const pode = useCallback((chave: string) => permissoes.has(chave), [permissoes]);

  const recarregarEu = useCallback(async () => {
    const eu = await apiErp.get<RespostaEu>('/auth/eu');
    setEstado((e) => (e.status === 'autenticado' ? { ...e, eu } : e));
  }, []);

  const valor = useMemo<Sessao>(
    () => ({ estado, entrar, trocarSenha, sair, pode, recarregarEu }),
    [estado, entrar, trocarSenha, sair, pode, recarregarEu],
  );

  return (
    <SessaoContext.Provider value={valor}>
      <ProvedorPermissoes value={pode}>{children}</ProvedorPermissoes>
    </SessaoContext.Provider>
  );
}

export function useSessao(): Sessao {
  const s = useContext(SessaoContext);
  if (!s) throw new Error('useSessao fora do ProvedorSessao');
  return s;
}

/** Atalho para telas dentro da área autenticada. */
export function useEu(): RespostaEu {
  const { estado } = useSessao();
  if (estado.status !== 'autenticado') throw new Error('useEu fora da área autenticada');
  return estado.eu;
}
