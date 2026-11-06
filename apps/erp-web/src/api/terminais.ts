import type {
  AtivacoesPendentes,
  BloqueioAtivacoes,
  CaixaParaAtivacao,
  CodigoAtivacaoGerado,
  DescartarEventoEntrada,
  GerarCodigoAtivacaoEntrada,
  ListagemEventosComErro,
  ListagemTerminais,
  ModoRevogacao,
  ReprocessamentoAgendado,
  ReprocessarLoteEntrada,
  ResultadoDescarte,
  ResultadoReprocessamento,
  ResultadoRevogacao,
  TerminalDetalhe,
} from '@genesis/shared';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePode } from '../auth/permissoes';
import { apiErp } from './clientes';
import { query } from './http';

/** ERP 12.2: a listagem, o detalhe e os códigos pendentes se atualizam sozinhos a cada 30 s. */
export const ATUALIZACAO_TERMINAIS_MS = 30_000;
export const ROTA_TERMINAIS = '/cadastros/pdvs';

export interface FiltroTela {
  lojaId: string | null;
  situacao: string;
  conexao: string;
  versaoApp: string;
}

export function useTerminais(filtro: FiltroTela) {
  return useQuery({
    queryKey: ['terminais', 'lista', filtro],
    queryFn: () =>
      apiErp.get<ListagemTerminais>(
        `/terminais${query({
          lojaId: filtro.lojaId,
          situacao: filtro.situacao,
          conexao: filtro.conexao,
          versaoApp: filtro.versaoApp,
        })}`,
      ),
    refetchInterval: ATUALIZACAO_TERMINAIS_MS,
    placeholderData: keepPreviousData,
  });
}

export function useAtivacoesPendentes() {
  return useQuery({
    queryKey: ['terminais', 'ativacoes'],
    queryFn: () => apiErp.get<AtivacoesPendentes>('/terminais/ativacoes'),
    refetchInterval: ATUALIZACAO_TERMINAIS_MS,
  });
}

export function useTerminal(id: string | undefined) {
  return useQuery({
    queryKey: ['terminais', 'detalhe', id],
    queryFn: () => apiErp.get<TerminalDetalhe>(`/terminais/${id}`),
    enabled: !!id,
    refetchInterval: ATUALIZACAO_TERMINAIS_MS,
  });
}

export interface FiltroFila {
  pagina: number;
  status: 'erro' | 'retido' | null;
  codigo: string | null;
}

/** Tamanho da página da fila de decisão (ERP 12.5). */
export const TAMANHO_PAGINA_FILA = 50;

export function useEventosComErro(id: string | undefined, filtro: FiltroFila) {
  return useQuery({
    queryKey: ['terminais', 'eventos-erro', id, filtro],
    queryFn: () =>
      apiErp.get<ListagemEventosComErro>(
        `/terminais/${id}/eventos-erro${query({
          pagina: filtro.pagina,
          tamanho: TAMANHO_PAGINA_FILA,
          status: filtro.status,
          codigo: filtro.codigo,
        })}`,
      ),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });
}

/**
 * Ações da fila de decisão (ERP 12.5; SYNC 11.4) sobre a linha de `eventos_recebidos`. O desfecho fica com quem chama
 * (a tela mostra o resultado de cada uma); todas invalidam o detalhe e a fila do terminal.
 */
export function useAcoesFila() {
  const queryClient = useQueryClient();
  const atualizar = () => void queryClient.invalidateQueries({ queryKey: ['terminais'] });
  return {
    reprocessar: useMutation({
      mutationFn: (id: string) =>
        apiErp.post<ResultadoReprocessamento>(`/eventos-recebidos/${id}/reprocessar`),
      onSettled: atualizar,
    }),
    aplicarNovoNumero: useMutation({
      mutationFn: (id: string) =>
        apiErp.post<ResultadoReprocessamento>(`/eventos-recebidos/${id}/aplicar-novo-numero`),
      onSettled: atualizar,
    }),
    descartar: useMutation({
      mutationFn: ({ id, ...corpo }: DescartarEventoEntrada & { id: string }) =>
        apiErp.post<ResultadoDescarte>(`/eventos-recebidos/${id}/descartar`, corpo),
      // Também no 409 (outra pessoa resolveu antes): a lista volta sem a linha velha.
      onSettled: atualizar,
    }),
    reprocessarLote: useMutation({
      mutationFn: (entrada: ReprocessarLoteEntrada) =>
        apiErp.post<ReprocessamentoAgendado>('/eventos-recebidos/reprocessar-lote', entrada),
      onSettled: atualizar,
    }),
  };
}

/**
 * Caixas que aceitam código (ERP 12.3) pela rota de terminais: basta `terminais.ativar`, sem `lojas.ver`. Inclui o
 * caixa de um terminal em desativação (o PDV novo o tira do caixa).
 */
export function useCaixasLivres(lojaId: string | null, habilitado: boolean) {
  return useQuery({
    queryKey: ['terminais', 'caixas-livres', lojaId],
    queryFn: () => apiErp.get<CaixaParaAtivacao[]>(`/terminais/caixas-livres${query({ lojaId })}`),
    enabled: !!lojaId && habilitado,
  });
}

/** Ações da tela; cada uma invalida as consultas de terminais e mostra a notificação de sucesso ou do erro. */
export function useAcoesTerminais() {
  const queryClient = useQueryClient();
  const pode = usePode();
  const atualizar = () => void queryClient.invalidateQueries({ queryKey: ['terminais'] });
  const erro = (e: unknown) => notifications.show({ color: 'red', message: (e as Error).message });
  const ok = (message: string) => () => {
    atualizar();
    notifications.show({ color: 'green', message });
  };
  return {
    pode,
    gerarCodigo: useMutation({
      mutationFn: (entrada: GerarCodigoAtivacaoEntrada) =>
        apiErp.post<CodigoAtivacaoGerado>('/terminais/ativacoes', entrada),
      onSuccess: atualizar,
    }),
    cancelarCodigo: useMutation({
      mutationFn: (id: string) => apiErp.del(`/terminais/ativacoes/${id}`),
      onSuccess: ok('Código de ativação cancelado'),
      onError: erro,
    }),
    liberarAtivacoes: useMutation({
      mutationFn: () => apiErp.post<BloqueioAtivacoes>('/terminais/ativacoes/liberar'),
      onSuccess: ok('Ativações liberadas'),
      onError: erro,
    }),
    renomear: useMutation({
      mutationFn: ({ id, descricao }: { id: string; descricao: string | null }) =>
        apiErp.patch<TerminalDetalhe>(`/terminais/${id}`, { descricao }),
      onSuccess: ok('Descrição alterada'),
      onError: erro,
    }),
    revogar: useMutation({
      mutationFn: ({
        id,
        ...corpo
      }: {
        id: string;
        modo: ModoRevogacao;
        confirmacaoCaixa?: number;
        observacao?: string | null;
      }) => apiErp.post<ResultadoRevogacao>(`/terminais/${id}/revogar`, corpo),
      onSuccess: atualizar,
    }),
    ressincronizar: useMutation({
      mutationFn: ({ id, fluxo }: { id: string; fluxo: string | null }) =>
        apiErp.post(`/terminais/${id}/ressincronizar`, fluxo ? { fluxo } : {}),
      onSuccess: ok('Comando enviado: o PDV ressincroniza no próximo contato'),
      onError: erro,
    }),
    mensagem: useMutation({
      mutationFn: ({ id, texto }: { id: string; texto: string }) =>
        apiErp.post(`/terminais/${id}/mensagem`, { texto }),
      onSuccess: ok('Mensagem enviada: aparece no PDV no próximo contato'),
      onError: erro,
    }),
    /** Manda o id pendente que a tela mostrou; 409 (outra máquina chamou depois) recarrega o detalhe com o novo. */
    confirmarHardware: useMutation({
      mutationFn: ({ id, idHardwarePendente }: { id: string; idHardwarePendente: string }) =>
        apiErp.post<TerminalDetalhe>(`/terminais/${id}/hardware/confirmar`, { idHardwarePendente }),
      onSuccess: ok('Troca de hardware confirmada'),
      onError: (e: unknown) => {
        atualizar();
        erro(e);
      },
    }),
    resolverAlerta: useMutation({
      mutationFn: ({ id, alertaId, resolucao }: { id: string; alertaId: string; resolucao: string }) =>
        apiErp.post<TerminalDetalhe>(`/terminais/${id}/alertas/${alertaId}/resolver`, { resolucao }),
      onSuccess: ok('Alerta resolvido'),
      onError: erro,
    }),
  };
}
