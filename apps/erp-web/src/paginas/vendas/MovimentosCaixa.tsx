import {
  ROTULOS_TIPO_MOVIMENTO_CAIXA,
  SITUACOES_MOVIMENTO_CAIXA,
  TIPOS_MOVIMENTO_REFORCO,
  TIPOS_MOVIMENTO_SANGRIA,
  type MovimentoCaixaDetalhe,
  type MovimentoCaixaResumo,
  type PaginaMovimentosCaixa,
} from '@genesis/shared';
import { Alert, Anchor, Badge, Group, SimpleGrid, Skeleton, Stack, Text, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconArrowLeft } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { Historico } from '../../componentes/FormularioEntidade';
import { Listagem, type ConfigListagem, type FiltroListagem } from '../../componentes/listagem/Listagem';
import { formatarData, formatarDataHora, formatarInteiro } from '../../util/formato';
import {
  Bloco,
  Campo,
  diaOperacionalHoje,
  reais,
  RotuloLoja,
  useFiltroTreino,
  useOpcoesLojas,
  useOpcoesOperadores,
} from './comum';

export const ROTA_REFORCOS = '/vendas/reforcos';
export const ROTA_SANGRIAS = '/vendas/sangrias';

const ROTULOS_SITUACAO: Record<(typeof SITUACOES_MOVIMENTO_CAIXA)[number], string> = {
  ativos: 'Ativos',
  cancelados: 'Cancelados',
  todos: 'Todos',
};

type Grupo = 'reforcos' | 'sangrias';

const GRUPOS: Record<Grupo, { titulo: string; rota: string; tipos: readonly string[] }> = {
  reforcos: { titulo: 'Reforço de caixa', rota: ROTA_REFORCOS, tipos: TIPOS_MOVIMENTO_REFORCO },
  sangrias: { titulo: 'Sangria', rota: ROTA_SANGRIAS, tipos: TIPOS_MOVIMENTO_SANGRIA },
};

/**
 * Reforço de caixa e abertura (ERP 15.2) e Sangria (15.3), só leitura (Fase 1C, bloco C12): os movimentos são
 * lançados só no PDV, com a sessão aberta; o ERP consulta e usa no fechamento (14.9). A data é o dia operacional da
 * sessão (D7, padrão hoje); o totalizador soma só os não cancelados; a loja de treino fica de fora por padrão (O10).
 */
function ListaMovimentos({ grupo }: { grupo: Grupo }) {
  const g = GRUPOS[grupo];
  const lojas = useOpcoesLojas();
  const operadores = useOpcoesOperadores();
  const treino = useFiltroTreino();
  const hoje = diaOperacionalHoje();
  const config = useMemo<ConfigListagem<MovimentoCaixaResumo>>(() => {
    const filtros: FiltroListagem[] = [
      { campo: 'dataInicial', rotulo: 'Data inicial (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'dataFinal', rotulo: 'Data final (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'lojaId', rotulo: 'Loja', tipo: 'loja', placeholder: 'Todas as lojas', opcoes: lojas },
      { campo: 'numeroCaixa', rotulo: 'Caixa', tipo: 'numero' },
      {
        campo: 'tipo',
        rotulo: 'Tipo',
        tipo: 'selecao',
        opcoes: g.tipos.map((t) => ({ value: t, label: ROTULOS_TIPO_MOVIMENTO_CAIXA[t] ?? t })),
      },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        padrao: 'todos',
        opcoes: SITUACOES_MOVIMENTO_CAIXA.map((s) => ({ value: s, label: ROTULOS_SITUACAO[s] })),
      },
    ];
    if (operadores)
      filtros.push({ campo: 'operadorId', rotulo: 'Operador', tipo: 'selecao', opcoes: operadores });
    if (treino) filtros.push(treino);
    return {
      recurso: `movimentos_caixa_${grupo}`,
      titulo: g.titulo,
      ordenacaoPadrao: 'data:desc',
      permissaoNovo: null,
      rotaEdicao: (m) => `${g.rota}/${m.id}`,
      chaveLinha: (m) => m.id,
      filtros,
      colunas: [
        { campo: 'data', rotulo: 'Data', ordenavel: true, formato: (m) => formatarDataHora(m.ocorridoEm) },
        {
          campo: 'valor',
          rotulo: 'Valor',
          ordenavel: true,
          alinhamento: 'right',
          formato: (m) => reais(m.valor),
        },
        {
          campo: 'tipo',
          rotulo: 'Tipo',
          ordenavel: true,
          formato: (m) => ROTULOS_TIPO_MOVIMENTO_CAIXA[m.tipo] ?? m.tipo,
        },
        {
          campo: 'loja',
          rotulo: 'Loja / Caixa',
          ordenavel: true,
          formato: (m) => (
            <Group gap={4} wrap="nowrap">
              <RotuloLoja codigo={m.lojaCodigo} nome={m.lojaNome} treino={m.lojaTreino} />
              <Text span size="sm" c="dimmed">
                · Cx {m.numeroCaixa}
              </Text>
            </Group>
          ),
        },
        { campo: 'operador', rotulo: 'Operador', ordenavel: true, formato: (m) => m.operadorNome ?? '—' },
        ...(grupo === 'sangrias'
          ? [
              {
                campo: 'quemRetira',
                rotulo: 'Quem retira',
                formato: (m: MovimentoCaixaResumo) => m.quemRetira ?? '—',
              },
            ]
          : []),
        {
          campo: 'cancelado',
          rotulo: 'Cancelado',
          formato: (m) =>
            m.cancelado ? (
              <Badge color="red" variant="light">
                Cancelado
              </Badge>
            ) : (
              'Não'
            ),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<PaginaMovimentosCaixa>(`/movimentos-caixa/${grupo}${query(params)}`, { sinal }),
      rodape: (p) => {
        const t = (p as PaginaMovimentosCaixa).totais;
        return (
          <Group justify="flex-end" gap="xl" data-testid={`totais-${grupo}`}>
            <Text size="sm">
              Não cancelados: <b>{formatarInteiro(t.quantidade)}</b>
            </Text>
            <Text size="sm">
              Valor: <b>{reais(t.valor)}</b>
            </Text>
          </Group>
        );
      },
    };
  }, [g, grupo, lojas, operadores, treino, hoje]);
  return <Listagem config={config} />;
}

export const ListaReforcos = () => <ListaMovimentos grupo="reforcos" />;
export const ListaSangrias = () => <ListaMovimentos grupo="sangrias" />;

/**
 * Detalhe só de leitura do movimento (15.2/15.3): tipo, operador, loja, caixa, data e hora, valor, quem retira,
 * observação, informações adicionais, cancelamento (feito no PDV) e o link para a sessão de caixa (14.9). Imprimir o
 * comprovante chega com os templates de impressão do ERP (3.7).
 */
function DetalheMovimento({ grupo }: { grupo: Grupo }) {
  const g = GRUPOS[grupo];
  const { id } = useParams();
  const pode = usePode();
  const r = useQuery({
    queryKey: ['movimento-caixa', id],
    queryFn: ({ signal }) => apiErp.get<MovimentoCaixaDetalhe>(`/movimentos-caixa/${id}`, { sinal: signal }),
    enabled: !!id,
  });
  const m = r.data;
  const rotulo = m ? (ROTULOS_TIPO_MOVIMENTO_CAIXA[m.tipo] ?? m.tipo) : g.titulo;
  useDocumentTitle(`${rotulo} · GenesisPDV`);
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!m) return <Skeleton h={300} />;
  return (
    <Stack gap="md">
      <Anchor component={Link} to={g.rota} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> {g.titulo}
        </Group>
      </Anchor>
      <Group gap="xs">
        <Title order={2} size="h3">
          {rotulo} de {reais(m.valor)}
        </Title>
        {m.cancelado && (
          <Badge color="red" variant="light">
            Cancelado
          </Badge>
        )}
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Bloco titulo="Movimento">
          <Campo rotulo="Tipo">{rotulo}</Campo>
          <Campo rotulo="Data/hora">{formatarDataHora(m.ocorridoEm)}</Campo>
          <Campo rotulo="Dia operacional">{formatarData(m.diaOperacional)}</Campo>
          <Campo rotulo="Valor">{reais(m.valor)}</Campo>
          {m.formaPagamentoDescricao && <Campo rotulo="Forma">{m.formaPagamentoDescricao}</Campo>}
          <Campo rotulo="Quem retira">{m.quemRetiraUsuarioNome ?? m.quemRetiraNome ?? '—'}</Campo>
          <Campo rotulo="Observação">{m.observacao ?? '—'}</Campo>
          <Campo rotulo="Inf. adicionais">{m.infAdicionais ?? '—'}</Campo>
          <Campo rotulo="Autorizado por">{m.autorizadoPorNome ?? '—'}</Campo>
        </Bloco>
        <Bloco titulo="Origem">
          <Campo rotulo="Loja">
            <RotuloLoja codigo={m.lojaCodigo} nome={m.lojaNome} treino={m.lojaTreino} />
          </Campo>
          <Campo rotulo="Número do caixa">{m.numeroCaixa}</Campo>
          <Campo rotulo="Terminal">{m.terminalDescricao ?? '—'}</Campo>
          <Campo rotulo="Operador">{m.operadorNome ?? '—'}</Campo>
          <Campo rotulo="Sessão de caixa">
            {pode('fechamentos_caixa.ver') ? (
              <Anchor component={Link} to={`/financeiro/fechamentos-caixa/${m.sessaoCaixaId}`} size="sm">
                Ver fechamento
              </Anchor>
            ) : (
              '—'
            )}
          </Campo>
        </Bloco>
      </SimpleGrid>
      {m.cancelado && (
        <Bloco titulo="Cancelamento (no PDV)">
          <Campo rotulo="Cancelado em">{formatarDataHora(m.canceladoEm)}</Campo>
          <Campo rotulo="Cancelado por">{m.canceladoPorNome ?? '—'}</Campo>
          <Campo rotulo="Autorizado por">{m.autorizadoCancelamentoPorNome ?? '—'}</Campo>
          <Campo rotulo="Motivo">{m.motivoCancelamento ?? '—'}</Campo>
        </Bloco>
      )}
      <Bloco titulo="Histórico">
        <Historico entidade="movimentos_caixa" registroId={m.id} />
      </Bloco>
    </Stack>
  );
}

export const DetalheReforco = () => <DetalheMovimento grupo="reforcos" />;
export const DetalheSangria = () => <DetalheMovimento grupo="sangrias" />;
