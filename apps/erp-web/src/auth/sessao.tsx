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

/** `saida_pendente`: o "Sair" não foi confirmado pelo servidor; o navegador fica fechado e tenta de novo. */
export type MotivoAnonimo = 'expirada' | 'saiu' | 'saida_pendente';

export type EstadoSessao =
  | { status: 'carregando' }
  | { status: 'anonimo'; motivo?: MotivoAnonimo }
  | { status: 'autenticado'; eu: RespostaEu; trocarSenha: boolean };

export interface Sessao {
  estado: EstadoSessao;
  entrar(dados: LoginEntrada): Promise<RespostaLogin>;
  trocarSenha(dados: { senhaAtual: string; novaSenha: string; confirmacao: string }): Promise<void>;
  sair(): Promise<void>;
  /**
   * Nova tentativa do logout que falhou (aviso do login); `true` quando o servidor confirmou ou quando não havia mais
   * saída pendente (outra aba concluiu a saída ou entrou de novo).
   */
  concluirSaida(): Promise<boolean>;
  pode(chave: string): boolean;
  /** Relê `/auth/eu` (lojas e permissões) depois de criar/alterar lojas ou o próprio acesso. */
  recarregarEu(): Promise<void>;
}

const SessaoContext = createContext<Sessao | null>(null);

const CANAL = 'genesis-erp-sessao';
/** Intervalo da nova tentativa automática do logout que falhou (também tenta quando a conexão volta). */
export const INTERVALO_NOVA_SAIDA_MS = 30_000;

/**
 * Sessão do ERP: renova pelo cookie ao abrir (o token de acesso nunca é persistido), carrega `/auth/eu`
 * (permissões efetivas e lojas permitidas) e propaga o "Sair" para as outras abas (ERP 4.1, "Várias abas").
 *
 * O "Sair" só vale com o 2xx do servidor (README do ERP › decisão 82): sem ele, o navegador fica fechado (o token sai
 * da memória e o marcador de saída pendente impede a renovação pelo cookie em qualquer aba e na próxima abertura) e o
 * logout é tentado de novo — ao abrir, a cada 30 s, quando a conexão volta e no botão do aviso. A nova tentativa
 * (`repetirSaida`) nunca regrava o marcador e só chama o servidor se ele ainda existe: se outra aba já saiu ou entrou
 * de novo, esta só passa a "saiu" (o evento `storage` avisa), sem derrubar a sessão nova.
 */
export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoSessao>({ status: 'carregando' });
  const queryClient = useQueryClient();
  const canal = useRef<BroadcastChannel | null>(null);

  const encerrarLocal = useCallback(
    (motivo: MotivoAnonimo) => {
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
      // Com a saída pendente o refresh nem é tentado: o aviso dela continua valendo.
      aoExpirar: () => encerrarLocal(apiErp.saidaPendente() ? 'saida_pendente' : 'expirada'),
      aoTrocaSenhaObrigatoria: () =>
        setEstado((e) => (e.status === 'autenticado' ? { ...e, trocarSenha: true } : e)),
    });
    let ativo = true;
    void (async () => {
      if (apiErp.saidaPendente()) {
        // Saída anterior não confirmada: encerra no servidor antes de qualquer renovação; sem sucesso, fica fechado.
        const saiu = await apiErp.repetirSaida().then(
          () => true,
          () => false,
        );
        if (ativo) setEstado({ status: 'anonimo', motivo: saiu ? 'saiu' : 'saida_pendente' });
        return;
      }
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
      canal.current.onmessage = (ev: MessageEvent<{ tipo: string; pendente?: boolean }>) => {
        if (ev.data?.tipo === 'saiu') encerrarLocal(ev.data.pendente ? 'saida_pendente' : 'saiu');
      };
    }
    // Outra aba concluiu a saída ou entrou de novo (marcador apagado): nada mais a encerrar por esta.
    const desligarMarcador = apiErp.aoConcluirSaidaEmOutraAba(() =>
      setEstado((e) =>
        e.status === 'anonimo' && e.motivo === 'saida_pendente' ? { status: 'anonimo', motivo: 'saiu' } : e,
      ),
    );
    return () => {
      ativo = false;
      desligar();
      desligarMarcador();
      canal.current?.close();
      canal.current = null;
    };
  }, [carregarEu, encerrarLocal]);

  const entrar = useCallback(
    async (dados: LoginEntrada) => {
      // Saída anterior pendente: tenta encerrá-la antes (o login troca o cookie e a sessão antiga ficaria sem dono).
      await apiErp.repetirSaida().catch(() => false);
      // Login e apagamento do marcador na trava entre abas: a nova tentativa de outra aba não sai com o cookie novo.
      const r = await apiErp.abrirSessao<RespostaLogin>('/auth/login', dados);
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
    let pendente = false;
    try {
      await apiErp.encerrarSessao();
    } catch {
      pendente = true;
    }
    encerrarLocal(pendente ? 'saida_pendente' : 'saiu');
    canal.current?.postMessage({ tipo: 'saiu', pendente });
  }, [encerrarLocal]);

  const concluirSaida = useCallback(async () => {
    try {
      await apiErp.repetirSaida();
    } catch {
      return false;
    }
    setEstado((e) =>
      e.status === 'anonimo' && e.motivo === 'saida_pendente' ? { status: 'anonimo', motivo: 'saiu' } : e,
    );
    return true;
  }, []);

  const saidaPendente = estado.status === 'anonimo' && estado.motivo === 'saida_pendente';
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
    () => ({ estado, entrar, trocarSenha, sair, concluirSaida, pode, recarregarEu }),
    [estado, entrar, trocarSenha, sair, concluirSaida, pode, recarregarEu],
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
