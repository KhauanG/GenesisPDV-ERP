import {
  diferencaConferencia,
  OBSERVACAO_CONFERENCIA_MAX,
  ROTULOS_FECHAMENTO_FORCADO,
  ROTULOS_SITUACAO_SESSAO,
  ROTULOS_TIPO_FECHAMENTO,
  ROTULOS_TIPO_MOVIMENTO_CAIXA,
  SITUACOES_SESSAO_CAIXA,
  situacaoConferencia,
  type ConferirSessaoEntrada,
  type PaginaSessoesCaixa,
  type SessaoCaixaDetalhe,
  type SessaoCaixaResumo,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowLeft, IconChecklist, IconInfoCircle } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { segmento } from '../../api/caminho';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
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

const CORES_SITUACAO: Record<string, string> = {
  aberta: 'blue',
  fechada_forcado: 'orange',
  conferida: 'green',
  divergente: 'red',
};

export function BadgeSituacaoSessao({ situacao }: { situacao: string }) {
  const cor = CORES_SITUACAO[situacao] ?? 'gray';
  return (
    <Badge variant="light" color={cor}>
      {ROTULOS_SITUACAO_SESSAO[situacao] ?? situacao}
    </Badge>
  );
}

/**
 * Fechamento de caixa / troca de turno (ERP 14.9; Fase 1C, bloco C12): as sessões dos PDVs pelo dia operacional (D7,
 * padrão hoje), com o calculado, o informado, a diferença e o conferido pelo gerente. Com o fechamento cego do dono
 * (O3), o gerente vê aqui o esperado que o operador não viu no caixa. As situações Conferida/Divergente vêm da
 * conferência (Fase 3, F3-B9; D114) e "Somente com diferença" olha o conferido quando há conferência; a quebra/sobra
 * no financeiro chega com a Fase 4.
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
          campo: 'totalConferido',
          rotulo: 'Conferido',
          alinhamento: 'right',
          formato: (s) =>
            s.totalConferido === null ? (
              '—'
            ) : (
              <Stack gap={0} align="flex-end">
                <span>{reais(s.totalConferido)}</span>
                <Diferenca valor={s.diferencaConferida} />
              </Stack>
            ),
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
    queryFn: ({ signal }) =>
      apiErp.get<SessaoCaixaDetalhe>(`/sessoes-caixa/${segmento(id)}`, { sinal: signal }),
    enabled: !!id,
  });
  const s = r.data;
  useDocumentTitle(
    `${s ? `Caixa ${s.numeroCaixa} · ${formatarData(s.diaOperacional)}` : 'Fechamento de caixa'} · GenesisPDV`,
  );
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!s) return <Skeleton h={300} />;
  const c = s.calculoDinheiro;
  // Uma fonte só para "o caixa calculou outro dinheiro": o aviso da API (comparação decimal, `calculo_divergente`),
  // mostrado aqui no cálculo e filtrado do bloco Conferência.
  const calculoDivergente = s.avisosConferencia.find((a) => a.codigo === 'calculo_divergente');
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
          {calculoDivergente && (
            <Alert
              color="yellow"
              icon={<IconAlertTriangle size={16} />}
              mt="xs"
              p="xs"
              data-testid="aviso-calculo-divergente"
            >
              {calculoDivergente.mensagem} Veja a fila de decisão do terminal.
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

      {/* `key`: o estado do formulário é por forma de pagamento, e Dinheiro/PIX têm o mesmo id em todas as sessões;
          ao trocar de sessão com o detalhe já no cache (sem passar pelo Skeleton), o bloco tem de recomeçar. */}
      <BlocoConferencia key={s.id} s={s} />

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

/** Valor como o operador digita ("223,50"), a partir do texto da API ("223.50"). */
const paraCampo = (v: string) => v.replace('.', ',');
const VALOR_VALIDO = /^\d{1,13}([.,]\d{1,2})?$/;

/**
 * Bloco "Conferência" (ERP 14.9; Fase 3, F3-B9; D114): o gerente informa o valor conferido de cada forma (o dinheiro
 * recontado no cofre, os comprovantes de cartão), pré-preenchido com o informado pelo operador (ou com a conferência
 * anterior, ao refazer); a diferença (conferido − calculado) e o selo Conferida/Divergente mudam enquanto digita, pela
 * mesma regra da API (`situacaoConferencia`, com a tolerância de agora da loja). Sem `fechamentos_caixa.conferir`, só
 * mostra a conferência gravada. Os avisos (eventos do turno pendentes, cálculo da nuvem diferente) não impedem gravar.
 */
function BlocoConferencia({ s }: { s: SessaoCaixaDetalhe }) {
  const pode = usePode();
  const queryClient = useQueryClient();
  const c = s.conferencia;
  const inicial = () =>
    Object.fromEntries(
      s.formas.map((f) => {
        const conferida = c?.formas.find((x) => x.formaPagamentoId === f.formaPagamentoId);
        return [f.formaPagamentoId, paraCampo(conferida?.valorConferido ?? f.valorInformado)];
      }),
    );
  const [valores, setValores] = useState<Record<string, string>>(inicial);
  const [observacao, setObservacao] = useState(c?.observacao ?? '');
  const [erros, setErros] = useState<Record<string, string>>({});
  const conferir = useMutation({
    mutationFn: () =>
      apiErp.post<SessaoCaixaDetalhe>(`/sessoes-caixa/${segmento(s.id)}/conferir`, {
        versao: c?.versao ?? null,
        formas: s.formas.map((f) => ({
          formaPagamentoId: f.formaPagamentoId,
          valorConferido: valores[f.formaPagamentoId] ?? '',
        })),
        observacao,
      } satisfies ConferirSessaoEntrada),
    onSuccess: (d) => {
      setErros({});
      queryClient.setQueryData(['sessao-caixa', s.id], d);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'fechamentos_caixa'] });
      // O Histórico fica na mesma página: sem isto, a entrada da conferência só apareceria ao recarregar.
      void queryClient.invalidateQueries({ queryKey: ['auditoria', 'sessoes_caixa', s.id] });
      notifications.show({
        color: d.situacao === 'conferida' ? 'green' : 'yellow',
        message: `Conferência gravada: ${ROTULOS_SITUACAO_SESSAO[d.situacao] ?? d.situacao}.`,
      });
    },
    onError: (e) => {
      if (e instanceof ErroRequisicao && e.campos)
        setErros(Object.fromEntries(Object.entries(e.campos).map(([k, v]) => [k, v[0] ?? ''])));
    },
  });

  if (s.motivoSemConferencia)
    return (
      <Bloco titulo="Conferência">
        <Text size="sm" c="dimmed">
          {s.motivoSemConferencia}
        </Text>
      </Bloco>
    );
  const editavel = pode('fechamentos_caixa.conferir');
  const invalidos = s.formas.filter((f) => !VALOR_VALIDO.test((valores[f.formaPagamentoId] ?? '').trim()));
  const linhas = s.formas.map((f) => {
    const gravada = c?.formas.find((x) => x.formaPagamentoId === f.formaPagamentoId);
    const texto = (valores[f.formaPagamentoId] ?? '').trim().replace(',', '.');
    const valido = VALOR_VALIDO.test(texto);
    const conferido = editavel ? (valido ? texto : null) : (gravada?.valorConferido ?? null);
    return {
      f,
      conferido,
      diferenca: conferido === null ? null : diferencaConferencia(conferido, f.valorCalculado),
    };
  });
  // Com estes valores, como ficaria (a mesma regra da API, com a tolerância de agora da loja).
  const situacaoPrevista =
    editavel && invalidos.length === 0
      ? situacaoConferencia(
          linhas.map((l) => ({ valorCalculado: l.f.valorCalculado, valorConferido: l.conferido! })),
          s.toleranciaConferencia,
        )
      : null;
  const erroGeral =
    conferir.error && !(conferir.error instanceof ErroRequisicao && conferir.error.campos)
      ? (conferir.error as Error).message
      : (erros.formas ?? null);
  return (
    <Bloco titulo="Conferência">
      <Group gap="xs">
        <span data-testid="selo-conferencia">
          {c ? (
            <BadgeSituacaoSessao situacao={c.situacao} />
          ) : (
            <Badge variant="light" color="gray">
              Ainda não conferida
            </Badge>
          )}
        </span>
        {situacaoPrevista && (
          <Group gap={4} data-testid="selo-previsto">
            <Text size="xs" c="dimmed">
              Com estes valores:
            </Text>
            <BadgeSituacaoSessao situacao={situacaoPrevista} />
          </Group>
        )}
        <Text size="xs" c="dimmed">
          Tolerância por forma: {reais(s.toleranciaConferencia)} (Configurações › PDV)
        </Text>
      </Group>
      {c && (
        <Text size="sm" data-testid="conferida-por">
          {editavel ? 'Última conferência' : 'Conferida'} em {formatarDataHora(c.conferidoEm)} por{' '}
          {c.conferidoPorNome ?? '—'}: {ROTULOS_SITUACAO_SESSAO[c.situacao] ?? c.situacao}, conferido{' '}
          {reais(c.totalConferido)} (diferença <Diferenca valor={c.diferenca} />)
        </Text>
      )}
      {/* O `calculo_divergente` já sai no bloco "Cálculo do dinheiro", logo acima. */}
      {s.avisosConferencia
        .filter((a) => a.codigo !== 'calculo_divergente')
        .map((a) => (
          <Alert key={a.codigo} color="yellow" icon={<IconAlertTriangle size={16} />} p="xs">
            {a.mensagem}
          </Alert>
        ))}
      <Table.ScrollContainer minWidth={560}>
        <Table aria-label="Conferência por forma de pagamento">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Forma</Table.Th>
              <Table.Th ta="right">Calculado</Table.Th>
              <Table.Th ta="right">Informado</Table.Th>
              <Table.Th ta="right">Conferido</Table.Th>
              <Table.Th ta="right">Diferença</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {linhas.map(({ f, conferido, diferenca }) => (
              <Table.Tr key={f.formaPagamentoId}>
                <Table.Td>{f.descricaoForma}</Table.Td>
                <Table.Td ta="right">{reais(f.valorCalculado)}</Table.Td>
                <Table.Td ta="right">{reais(f.valorInformado)}</Table.Td>
                <Table.Td ta="right">
                  {editavel ? (
                    <TextInput
                      aria-label={`Conferido ${f.descricaoForma}`}
                      size="xs"
                      w={130}
                      ml="auto"
                      styles={{ input: { textAlign: 'right' } }}
                      leftSection={<Text size="xs">R$</Text>}
                      value={valores[f.formaPagamentoId] ?? ''}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        setValores((atual) => ({ ...atual, [f.formaPagamentoId]: v }));
                      }}
                      error={conferido === null ? 'Valor inválido' : undefined}
                    />
                  ) : (
                    reais(conferido)
                  )}
                </Table.Td>
                <Table.Td ta="right" data-testid={`diferenca-conferida-${f.formaPagamentoId}`}>
                  <Diferenca valor={diferenca} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {editavel ? (
        <>
          <Textarea
            label="Observação"
            autosize
            minRows={2}
            maxLength={OBSERVACAO_CONFERENCIA_MAX}
            value={observacao}
            onChange={(e) => setObservacao(e.currentTarget.value)}
            error={erros.observacao}
          />
          {erroGeral && (
            <Alert color="red" p="xs">
              {erroGeral}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button
              leftSection={<IconChecklist size={16} />}
              loading={conferir.isPending}
              disabled={invalidos.length > 0}
              onClick={() => conferir.mutate()}
            >
              {c ? 'Refazer conferência' : 'Conferir'}
            </Button>
          </Group>
        </>
      ) : (
        c?.observacao && <Campo rotulo="Observação">{c.observacao}</Campo>
      )}
    </Bloco>
  );
}
