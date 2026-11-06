import {
  ROTULOS_FECHAMENTO_FORCADO,
  ROTULOS_SITUACAO_SESSAO,
  ROTULOS_TIPO_FECHAMENTO,
  ROTULOS_TIPO_MOVIMENTO_CAIXA,
  SITUACOES_SESSAO_CAIXA,
  type PaginaSessoesCaixa,
  type SessaoCaixaDetalhe,
  type SessaoCaixaResumo,
} from '@genesis/shared';
import { Alert, Anchor, Badge, Group, SimpleGrid, Skeleton, Stack, Table, Text, Title } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowLeft, IconInfoCircle } from '@tabler/icons-react';
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
  Diferenca,
  diaOperacionalHoje,
  reais,
  RotuloLoja,
  useFiltroTreino,
  useOpcoesLojas,
  useOpcoesOperadores,
} from './comum';
import { ROTA_VENDAS } from './Vendas';

export const ROTA_FECHAMENTOS = '/financeiro/fechamentos-caixa';

export function BadgeSituacaoSessao({ situacao }: { situacao: string }) {
  const cor = situacao === 'aberta' ? 'blue' : situacao === 'fechada_forcado' ? 'orange' : 'gray';
  return (
    <Badge variant="light" color={cor}>
      {ROTULOS_SITUACAO_SESSAO[situacao] ?? situacao}
    </Badge>
  );
}

/**
 * Fechamento de caixa / troca de turno (ERP 14.9), só leitura (Fase 1C, bloco C12): as sessões dos PDVs pelo dia
 * operacional (D7, padrão hoje), com o calculado, o informado e a diferença. Com o fechamento cego do dono (O3), o
 * gerente vê aqui o esperado que o operador não viu no caixa. Situações Conferida/Divergente e a conferência
 * (`fechamentos_caixa.conferir`) chegam com a Fase 3; a quebra/sobra no financeiro, com a Fase 4.
 */
export function ListaFechamentosCaixa() {
  const lojas = useOpcoesLojas();
  const operadores = useOpcoesOperadores();
  const treino = useFiltroTreino();
  const hoje = diaOperacionalHoje();
  const config = useMemo<ConfigListagem<SessaoCaixaResumo>>(() => {
    const filtros: FiltroListagem[] = [
      { campo: 'lojaId', rotulo: 'Loja', tipo: 'loja', placeholder: 'Todas as lojas', opcoes: lojas },
      { campo: 'dataInicial', rotulo: 'Data inicial (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'dataFinal', rotulo: 'Data final (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'numeroCaixa', rotulo: 'Caixa', tipo: 'numero' },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        opcoes: SITUACOES_SESSAO_CAIXA.map((s) => ({ value: s, label: ROTULOS_SITUACAO_SESSAO[s]! })),
      },
      {
        campo: 'somenteComDiferenca',
        rotulo: 'Somente com diferença',
        tipo: 'selecao',
        padrao: 'false',
        opcoes: [
          { value: 'false', label: 'Não' },
          { value: 'true', label: 'Sim' },
        ],
      },
    ];
    if (operadores)
      filtros.push({ campo: 'operadorId', rotulo: 'Operador', tipo: 'selecao', opcoes: operadores });
    if (treino) filtros.push(treino);
    return {
      recurso: 'fechamentos_caixa',
      titulo: 'Fechamento de caixa',
      ordenacaoPadrao: 'data:desc',
      permissaoNovo: null,
      rotaEdicao: (s) => `${ROTA_FECHAMENTOS}/${s.id}`,
      chaveLinha: (s) => s.id,
      filtros,
      colunas: [
        {
          campo: 'operador',
          rotulo: 'Usuário anterior',
          ordenavel: true,
          formato: (s) => s.operadorNome ?? '—',
        },
        {
          campo: 'usuarioSubsequenteNome',
          rotulo: 'Usuário subsequente',
          formato: (s) => s.usuarioSubsequenteNome ?? '—',
        },
        {
          campo: 'loja',
          rotulo: 'Loja / Caixa',
          ordenavel: true,
          formato: (s) => (
            <Group gap={4} wrap="nowrap">
              <RotuloLoja codigo={s.lojaCodigo} nome={s.lojaNome} treino={s.lojaTreino} />
              <Text span size="sm" c="dimmed">
                · Cx {s.numeroCaixa}
              </Text>
            </Group>
          ),
        },
        {
          campo: 'data',
          rotulo: 'Data',
          ordenavel: true,
          formato: (s) => (
            <Stack gap={0}>
              <span>{formatarDataHora(s.fechadaEm ?? s.abertaEm)}</span>
              <Text size="xs" c="dimmed">
                Dia {formatarData(s.diaOperacional)}
              </Text>
            </Stack>
          ),
        },
        {
          campo: 'tipoFechamento',
          rotulo: 'Tipo',
          formato: (s) => (s.tipoFechamento ? ROTULOS_TIPO_FECHAMENTO[s.tipoFechamento] : '—'),
        },
        {
          campo: 'valorCaixa',
          rotulo: 'Valor de caixa',
          alinhamento: 'right',
          formato: (s) => reais(s.valorCaixa),
        },
        {
          campo: 'calculado',
          rotulo: 'Calculado',
          ordenavel: true,
          alinhamento: 'right',
          formato: (s) => reais(s.totalCalculado),
        },
        {
          campo: 'informado',
          rotulo: 'Informado',
          ordenavel: true,
          alinhamento: 'right',
          formato: (s) => reais(s.totalInformado),
        },
        {
          campo: 'diferenca',
          rotulo: 'Diferença',
          ordenavel: true,
          alinhamento: 'right',
          formato: (s) => <Diferenca valor={s.diferenca} />,
        },
        {
          campo: 'situacao',
          rotulo: 'Situação',
          formato: (s) => <BadgeSituacaoSessao situacao={s.situacao} />,
        },
      ],
      buscar: (params, sinal) => apiErp.get<PaginaSessoesCaixa>(`/sessoes-caixa${query(params)}`, { sinal }),
      rodape: (p) => {
        const t = (p as PaginaSessoesCaixa).totais;
        return (
          <Group justify="flex-end" gap="xl" data-testid="totais-fechamentos">
            <Text size="sm">
              Sessões: <b>{formatarInteiro(p.total)}</b>
            </Text>
            <Text size="sm">
              Calculado: <b>{reais(t.calculado)}</b>
            </Text>
            <Text size="sm">
              Informado: <b>{reais(t.informado)}</b>
            </Text>
            <Text size="sm" component="div">
              Diferença: <Diferenca valor={t.diferenca} />
            </Text>
          </Group>
        );
      },
    };
  }, [lojas, operadores, treino, hoje]);
  return <Listagem config={config} />;
}

/**
 * Detalhe da sessão (14.9): cabeçalho, resumo por forma (calculado pelo PDV × informado pelo operador × diferença),
 * o cálculo do dinheiro (PDV 20.4) refeito com o que já chegou da sessão, os movimentos e as vendas. Um cálculo
 * diferente do calculado do PDV indica evento da sessão ainda pendente ou retido (fila de decisão do terminal, 12.5).
 */
export function DetalheFechamentoCaixa() {
  const { id } = useParams();
  const pode = usePode();
  const r = useQuery({
    queryKey: ['sessao-caixa', id],
    queryFn: ({ signal }) => apiErp.get<SessaoCaixaDetalhe>(`/sessoes-caixa/${id}`, { sinal: signal }),
    enabled: !!id,
  });
  const s = r.data;
  useDocumentTitle(
    `${s ? `Caixa ${s.numeroCaixa} · ${formatarData(s.diaOperacional)}` : 'Fechamento de caixa'} · GenesisPDV`,
  );
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!s) return <Skeleton h={300} />;
  const c = s.calculoDinheiro;
  const dinheiroPdv = s.formas.find((f) => f.tipoForma === 'dinheiro');
  const divergeDoPdv = !!dinheiroPdv && dinheiroPdv.valorCalculado !== c.esperado;
  const linhasCalculo: Array<[string, string, string]> = [
    ['Abertura (fundo de troco)', '+', c.fundoTroco],
    ['Vendas em dinheiro', '+', c.vendasDinheiro],
    ['Troco dado por outras formas', '−', c.trocoOutrasFormas],
    ['Reforços', '+', c.reforcos],
    ['Sangrias', '−', c.sangrias],
    ['Estornos de vendas canceladas em dinheiro', '−', c.estornosDinheiro],
    ['Devoluções em dinheiro', '−', c.devolucoes],
  ];
  return (
    <Stack gap="md">
      <Anchor component={Link} to={ROTA_FECHAMENTOS} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> Fechamento de caixa
        </Group>
      </Anchor>
      <Group gap="xs">
        <Title order={2} size="h3">
          Caixa {s.numeroCaixa} · {s.lojaNome} · dia {formatarData(s.diaOperacional)}
        </Title>
        <BadgeSituacaoSessao situacao={s.situacao} />
        {s.lojaTreino && (
          <Badge variant="light" color="grape">
            Loja de treino
          </Badge>
        )}
      </Group>
      {/* "Fechada pela nuvem" só até o `caixa.fechado` do terminal antigo chegar; depois fica a marca, sem o alerta. */}
      {s.fechamentoForcadoMotivo &&
        (s.fechamento ? (
          <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />}>
            A nuvem fechou esta sessão na{' '}
            {ROTULOS_FECHAMENTO_FORCADO[s.fechamentoForcadoMotivo] ?? 'substituição do terminal'}; o
            fechamento do caixa chegou depois e está abaixo.
          </Alert>
        ) : (
          <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
            Sessão fechada pela nuvem na{' '}
            {ROTULOS_FECHAMENTO_FORCADO[s.fechamentoForcadoMotivo] ?? 'substituição do terminal'}; o
            fechamento do caixa ainda não chegou.
          </Alert>
        ))}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Bloco titulo="Abertura">
          <Campo rotulo="Loja">
            <RotuloLoja codigo={s.lojaCodigo} nome={s.lojaNome} treino={s.lojaTreino} />
          </Campo>
          <Campo rotulo="Caixa / terminal">
            {s.numeroCaixa} · {s.terminalDescricao ?? '—'}
          </Campo>
          <Campo rotulo="Operador">{s.operadorNome ?? '—'}</Campo>
          <Campo rotulo="Aberta em">{formatarDataHora(s.abertaEm)}</Campo>
          <Campo rotulo="Fundo de troco">{reais(s.fundoTroco)}</Campo>
          {s.sessaoAnteriorId && (
            <Campo rotulo="Recebido da sessão anterior">
              <Anchor component={Link} to={`${ROTA_FECHAMENTOS}/${s.sessaoAnteriorId}`} size="sm">
                {reais(s.valorRecebidoAnterior)}
              </Anchor>
              {s.diferencaRecebimento && Number(s.diferencaRecebimento) !== 0 && (
                <>
                  {' '}
                  (diferença <Diferenca valor={s.diferencaRecebimento} />)
                </>
              )}
            </Campo>
          )}
          <Campo rotulo="Dia operacional">{formatarData(s.diaOperacional)}</Campo>
        </Bloco>
        <Bloco titulo="Encerramento">
          {s.fechamento ? (
            <>
              <Campo rotulo="Tipo">{ROTULOS_TIPO_FECHAMENTO[s.fechamento.tipo] ?? s.fechamento.tipo}</Campo>
              <Campo rotulo="Encerrada em">{formatarDataHora(s.fechamento.ocorridoEm)}</Campo>
              <Campo rotulo="Usuário anterior">{s.fechamento.usuarioAnteriorNome ?? '—'}</Campo>
              <Campo rotulo="Usuário subsequente">{s.fechamento.usuarioSubsequenteNome ?? '—'}</Campo>
              <Campo rotulo="Valor de caixa">{reais(s.valorCaixa)}</Campo>
              <Campo rotulo="Fechamento cego">{s.fechamento.fechamentoCego ? 'Sim' : 'Não'}</Campo>
              <Campo rotulo="Justificativa">{s.fechamento.justificativa ?? '—'}</Campo>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              {s.situacao === 'aberta'
                ? 'Sessão ainda aberta no caixa.'
                : 'O fechamento do caixa ainda não chegou.'}
            </Text>
          )}
        </Bloco>
      </SimpleGrid>

      <Bloco titulo="Resumo por forma de pagamento">
        {s.formas.length === 0 ? (
          <Text size="sm" c="dimmed">
            Sem contagem: o fechamento do caixa ainda não chegou.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table aria-label="Resumo por forma de pagamento">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Forma</Table.Th>
                  <Table.Th ta="right">Pagamentos</Table.Th>
                  <Table.Th ta="right">Valor calculado</Table.Th>
                  <Table.Th ta="right">Valor informado</Table.Th>
                  <Table.Th ta="right">Diferença</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {s.formas.map((f) => (
                  <Table.Tr key={f.formaPagamentoId}>
                    <Table.Td>{f.descricaoForma}</Table.Td>
                    <Table.Td ta="right">{formatarInteiro(f.quantidadePagamentos)}</Table.Td>
                    <Table.Td ta="right">{reais(f.valorCalculado)}</Table.Td>
                    <Table.Td ta="right">{reais(f.valorInformado)}</Table.Td>
                    <Table.Td ta="right">
                      <Diferenca valor={f.diferenca} />
                    </Table.Td>
                  </Table.Tr>
                ))}
                <Table.Tr fw={600}>
                  <Table.Td>Total</Table.Td>
                  <Table.Td />
                  <Table.Td ta="right">{reais(s.totalCalculado)}</Table.Td>
                  <Table.Td ta="right">{reais(s.totalInformado)}</Table.Td>
                  <Table.Td ta="right">
                    <Diferenca valor={s.diferenca} />
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Bloco>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Bloco titulo="Cálculo do dinheiro (PDV 20.4)">
          {linhasCalculo.map(([rotulo, sinal, valor]) => (
            <Campo key={rotulo} rotulo={`${sinal} ${rotulo}`}>
              {reais(valor)}
            </Campo>
          ))}
          <Campo rotulo="= Esperado na gaveta">
            <b data-testid="esperado-gaveta">{reais(c.esperado)}</b>
          </Campo>
          <Campo rotulo="Retirado no fechamento">{reais(c.sangriaFechamento)}</Campo>
          {divergeDoPdv && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mt="xs" p="xs">
              O caixa calculou {reais(dinheiroPdv.valorCalculado)} em dinheiro: ainda falta chegar (ou está
              retido) algum evento desta sessão. Veja a fila de decisão do terminal.
            </Alert>
          )}
        </Bloco>
        <Bloco titulo="Vendas">
          <Campo rotulo="Vendas finalizadas">
            {formatarInteiro(s.vendas.quantidade)} · {reais(s.vendas.total)}
          </Campo>
          <Campo rotulo="Canceladas">
            {formatarInteiro(s.vendas.canceladas)} · {reais(s.vendas.totalCanceladas)}
          </Campo>
          {pode('vendas.ver') && (
            <Anchor
              component={Link}
              // Datas vazias explícitas: a sessão pode ter vendas de mais de um dia operacional (caixa esquecido aberto).
              to={`${ROTA_VENDAS}?sessaoCaixaId=${s.id}&lojaId=${s.lojaId}&dataInicial=&dataFinal=`}
              size="sm"
            >
              Ver as vendas da sessão
            </Anchor>
          )}
        </Bloco>
      </SimpleGrid>

      <Bloco titulo="Movimentos">
        {s.movimentos.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nenhum movimento de dinheiro na sessão.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={600}>
            <Table striped aria-label="Movimentos da sessão">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Data/hora</Table.Th>
                  <Table.Th>Tipo</Table.Th>
                  <Table.Th ta="right">Valor</Table.Th>
                  <Table.Th>Quem retira / forma</Table.Th>
                  <Table.Th>Observação</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {s.movimentos.map((m) => (
                  <Table.Tr key={m.id} style={m.cancelado ? { textDecoration: 'line-through' } : undefined}>
                    <Table.Td>{formatarDataHora(m.ocorridoEm)}</Table.Td>
                    <Table.Td>
                      {ROTULOS_TIPO_MOVIMENTO_CAIXA[m.tipo] ?? m.tipo}
                      {m.cancelado ? ' (cancelado)' : ''}
                    </Table.Td>
                    <Table.Td ta="right">{reais(m.valor)}</Table.Td>
                    <Table.Td>{m.quemRetira ?? m.formaPagamentoDescricao ?? '—'}</Table.Td>
                    <Table.Td>{m.observacao ?? '—'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Bloco>
      <Bloco titulo="Histórico">
        <Historico entidade="sessoes_caixa" registroId={s.id} />
      </Bloco>
    </Stack>
  );
}
