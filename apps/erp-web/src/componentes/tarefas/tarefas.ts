import { tarefaEmAndamento, type RespostaTarefas, type TarefaUsuario } from '@genesis/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';

/**
 * Consulta das tarefas em segundo plano do usuário (ERP 3.6; F2-B30; README do ERP › decisão 65), econômica: a lista
 * (`GET /tarefas`, ícone Tarefas) só se repete enquanto há tarefa na fila ou executando, ou com o painel aberto; a
 * tarefa de uma tela (`GET /tarefas/:id`: Importação, upload de NF-e, exportação do relatório) só até terminar. Com a
 * aba do navegador em segundo plano nenhuma das duas repete (o padrão do TanStack Query). Uma consulta que falha por
 * um motivo passageiro (sem conexão, a API reiniciando na implantação, um 502) continua sendo repetida, mais devagar
 * (`INTERVALO_APOS_ERRO_MS`), enquanto a última situação conhecida for "em andamento": a barra não congela em
 * silêncio e, quando a API volta, a tela chega ao resultado sozinha. Só a recusa da API (4xx: sem permissão, tarefa
 * inexistente) para de vez, porque repetir não muda a resposta.
 */

/** Chave de todas as consultas de tarefa: invalidar ela atualiza o ícone e as telas. */
export const CHAVE_TAREFAS = ['tarefas'] as const;
export const CHAVE_LISTA_TAREFAS = ['tarefas', 'lista'] as const;

/** Intervalo da lista com tarefa em andamento ou com o painel aberto. */
export const INTERVALO_LISTA_TAREFAS_MS = 5_000;
/** Intervalo da tarefa acompanhada numa tela (o progresso anda na frente de quem pediu). */
export const INTERVALO_TAREFA_MS = 2_000;
/** Intervalo depois de uma falha passageira (a lista e a tarefa): mais espaçado, para não insistir com a API fora. */
export const INTERVALO_APOS_ERRO_MS = 15_000;

/** A API recusou o pedido (4xx: sem permissão, não encontrado): repetir não muda a resposta. */
export function erroDefinitivo(erro: unknown): boolean {
  return erro instanceof ErroRequisicao && erro.status >= 400 && erro.status < 500;
}

/**
 * De quanto em quanto tempo repetir a lista: só com tarefa em andamento (na última lista que chegou) ou o painel
 * aberto. Depois de uma falha passageira, a cada `INTERVALO_APOS_ERRO_MS`; depois de uma recusa (4xx), ou sem
 * nenhuma lista ainda, não repete (o painel oferece "Tentar novamente").
 */
export function intervaloListaTarefas(
  dados: RespostaTarefas | undefined,
  aberto: boolean,
  erro: unknown,
): number | false {
  if (!dados || erroDefinitivo(erro)) return false;
  if (dados.pendentes === 0 && !aberto) return false;
  return erro ? INTERVALO_APOS_ERRO_MS : INTERVALO_LISTA_TAREFAS_MS;
}

/**
 * De quanto em quanto tempo repetir a tarefa acompanhada numa tela: até ela terminar (na última resposta que
 * chegou). Depois de uma falha passageira, a cada `INTERVALO_APOS_ERRO_MS`; depois de uma recusa (4xx), não repete.
 */
export function intervaloTarefa(dados: TarefaUsuario<unknown> | undefined, erro: unknown): number | false {
  if (erroDefinitivo(erro) || (dados && !tarefaEmAndamento(dados))) return false;
  return erro ? INTERVALO_APOS_ERRO_MS : INTERVALO_TAREFA_MS;
}

/** A lista do ícone Tarefas (as 50 mais recentes). `habilitada = false` não consulta nada. */
export function useTarefas({
  aberto = false,
  habilitada = true,
}: { aberto?: boolean; habilitada?: boolean } = {}) {
  return useQuery({
    queryKey: CHAVE_LISTA_TAREFAS,
    queryFn: ({ signal }) => apiErp.get<RespostaTarefas>('/tarefas', { sinal: signal }),
    enabled: habilitada,
    staleTime: 60_000,
    refetchInterval: (q) =>
      intervaloListaTarefas(q.state.data, aberto, q.state.status === 'error' ? q.state.error : null),
  });
}

/**
 * Uma tarefa acompanhada na tela que a pediu, até terminar. Quando termina, atualiza a lista do ícone (a contagem e
 * o link) sem esperar a vez dela.
 */
export function useTarefa<R = unknown>(tarefaId: string | null) {
  const queryClient = useQueryClient();
  const consulta = useQuery({
    queryKey: [...CHAVE_TAREFAS, tarefaId],
    queryFn: ({ signal }) => apiErp.get<TarefaUsuario<R>>(`/tarefas/${tarefaId}`, { sinal: signal }),
    enabled: !!tarefaId,
    refetchInterval: (q) => intervaloTarefa(q.state.data, q.state.status === 'error' ? q.state.error : null),
  });
  const terminou = !!consulta.data && !tarefaEmAndamento(consulta.data);
  useEffect(() => {
    if (terminou) void queryClient.invalidateQueries({ queryKey: CHAVE_LISTA_TAREFAS });
  }, [terminou, queryClient]);
  return consulta;
}
