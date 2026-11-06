import {
  diaOperacionalEm,
  FILTROS_TREINO,
  ROTULOS_FILTRO_TREINO,
  type FormaPagamentoResumo,
  type Pagina,
  type UsuarioResumo,
} from '@genesis/shared';
import { Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { formatarDecimal } from '../../componentes/grade/decimal';
import type { FiltroListagem, OpcaoFiltro } from '../../componentes/listagem/Listagem';

/**
 * Peças comuns das consultas do caixa e das vendas do PDV (Fase 1C, bloco C12; ERP 14.9, 15.2–15.4): valores em
 * reais, o filtro da loja de treino (O10), os filtros de operador e de forma de pagamento e os blocos do detalhe.
 */

export const reais = (v: string | null | undefined) =>
  v === null || v === undefined ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`;

/** Valor com sinal em cor: negativo vermelho (falta), positivo azul (sobra), zero neutro. */
export function Diferenca({ valor }: { valor: string | null }) {
  if (valor === null) return <>—</>;
  const n = Number(valor);
  return (
    <Text span size="sm" fw={n === 0 ? undefined : 600} c={n < 0 ? 'red' : n > 0 ? 'blue' : undefined}>
      {reais(valor)}
    </Text>
  );
}

/**
 * Dia operacional de hoje pelo corte padrão da empresa (05:00, D7), para o padrão "hoje" dos filtros de data: à 1h
 * da manhã o movimento da noite ainda é o do dia anterior. A consulta filtra pelo `dia_operacional` que o PDV gravou
 * (com o corte da loja); o padrão só escolhe a data que aparece no campo.
 */
export function diaOperacionalHoje(agora = new Date()): string {
  return diaOperacionalEm(agora, '05:00');
}

/** Rótulo da loja nas tabelas: "1 - Loja Centro", com a marca "treino" na loja de treino (O10). */
export function RotuloLoja({ codigo, nome, treino }: { codigo: number; nome: string; treino: boolean }) {
  return (
    <Group gap={4} wrap="nowrap">
      <span>
        {codigo} - {nome}
      </span>
      {treino && (
        <Badge size="xs" variant="light" color="grape">
          treino
        </Badge>
      )}
    </Group>
  );
}

/** Filtro "Loja de treino" (O10): só aparece quando a empresa tem loja de treino entre as lojas do usuário. */
export function useFiltroTreino(): FiltroListagem | null {
  const eu = useEu();
  if (!eu.lojas.some((l) => l.treino)) return null;
  return {
    campo: 'treino',
    rotulo: 'Loja de treino',
    tipo: 'selecao',
    padrao: 'excluir',
    opcoes: FILTROS_TREINO.map((t) => ({ value: t, label: ROTULOS_FILTRO_TREINO[t] })),
  };
}

export function useOpcoesLojas(): OpcaoFiltro[] {
  const eu = useEu();
  return eu.lojas.map((l) => ({
    value: l.id,
    label: `${l.codigo} - ${l.nome}${l.treino ? ' (treino)' : ''}`,
  }));
}

/** Operadores para o filtro (precisa de `usuarios.ver`; sem ela o filtro não aparece). */
export function useOpcoesOperadores(): OpcaoFiltro[] | null {
  const pode = usePode();
  const permitido = pode('usuarios.ver');
  const r = useQuery({
    queryKey: ['opcoes', 'usuarios-todos'],
    queryFn: () =>
      apiErp.get<Pagina<UsuarioResumo>>(
        `/usuarios${query({ situacao: 'todos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: permitido,
    staleTime: 60_000,
  });
  if (!permitido) return null;
  return (r.data?.itens ?? []).map((u) => ({ value: u.id, label: `${u.codigo} - ${u.nome}` }));
}

/** Formas de pagamento para o filtro (precisa de `formas_pagamento.ver`; sem ela o filtro não aparece). */
export function useOpcoesFormas(): OpcaoFiltro[] | null {
  const pode = usePode();
  const permitido = pode('formas_pagamento.ver');
  const r = useQuery({
    queryKey: ['opcoes', 'formas-pagamento-todas'],
    queryFn: () =>
      apiErp.get<Pagina<FormaPagamentoResumo>>(
        `/formas-pagamento${query({ situacao: 'todos', tamanho: 'todos', ordenar: 'descricao:asc' })}`,
      ),
    enabled: permitido,
    staleTime: 60_000,
  });
  if (!permitido) return null;
  return (r.data?.itens ?? []).map((f) => ({ value: f.id, label: f.descricao }));
}

export function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed">
        {rotulo}
      </Text>
      <Text size="sm" ta="right" component="div">
        {children}
      </Text>
    </Group>
  );
}

export function Bloco({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text fw={600} size="sm" mb="xs">
        {titulo}
      </Text>
      <Stack gap={4}>{children}</Stack>
    </Paper>
  );
}
