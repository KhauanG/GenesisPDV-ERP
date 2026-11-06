import {
  dec,
  decTexto,
  DEVOLUCOES_FILTRO_VENDA,
  ROTULOS_DEVOLUCAO_VENDA,
  ROTULOS_STATUS_VENDA,
  ROTULOS_TIPO_VENDA,
  SITUACOES_FILTRO_VENDA,
  TIPOS_EXIBIDOS_VENDA,
  type PaginaVendas,
  type VendaDetalhe,
  type VendaResumo,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowLeft } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { Historico } from '../../componentes/FormularioEntidade';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { Listagem, type ConfigListagem, type FiltroListagem } from '../../componentes/listagem/Listagem';
import { formatarData, formatarDataHora, formatarInteiro } from '../../util/formato';
import {
  Bloco,
  Campo,
  diaOperacionalHoje,
  reais,
  RotuloLoja,
  useFiltroTreino,
  useOpcoesFormas,
  useOpcoesLojas,
  useOpcoesOperadores,
} from './comum';

export const ROTA_VENDAS = '/vendas';

const ROTULOS_SITUACAO_FILTRO: Record<(typeof SITUACOES_FILTRO_VENDA)[number], string> = {
  todas: 'Todas (exceto rascunho)',
  finalizada: 'Finalizada (OK)',
  cancelada: 'Cancelada',
  pedido_pendente: 'Pedido pendente',
};

export function BadgeSituacaoVenda({ status }: { status: string }) {
  const cor = status === 'finalizada' ? 'green' : status === 'cancelada' ? 'red' : 'gray';
  return (
    <Badge variant="light" color={cor}>
      {ROTULOS_STATUS_VENDA[status] ?? status}
    </Badge>
  );
}

/**
 * Vendas (ERP 15.4.1), só leitura das vendas do PDV (Fase 1C, bloco C12): filtros pelo dia operacional (padrão
 * hoje, D7), loja de contexto, caixa, tipo, situação, devolução, operador, forma de pagamento e loja de treino (O10,
 * fora por padrão); totalizadores de todas as vendas do filtro, com as canceladas fora dos valores. A "Nova venda"
 * (venda ERP) é da Fase 3 e a coluna do documento fiscal, da 1D.
 */
export function ListaVendas() {
  const lojas = useOpcoesLojas();
  const operadores = useOpcoesOperadores();
  const formas = useOpcoesFormas();
  const treino = useFiltroTreino();
  const hoje = diaOperacionalHoje();
  const config = useMemo<ConfigListagem<VendaResumo>>(() => {
    const filtros: FiltroListagem[] = [
      { campo: 'codigo', rotulo: 'Código', tipo: 'texto', placeholder: 'L01-C02-000123 ou 123' },
      { campo: 'cliente', rotulo: 'Cliente', tipo: 'texto', placeholder: 'Nome ou CPF/CNPJ' },
      { campo: 'dataInicial', rotulo: 'Data inicial (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'dataFinal', rotulo: 'Data final (dia operacional)', tipo: 'data', padrao: hoje },
      { campo: 'lojaId', rotulo: 'Loja', tipo: 'loja', placeholder: 'Todas as lojas', opcoes: lojas },
      { campo: 'numeroCaixa', rotulo: 'Num. caixa', tipo: 'numero' },
      {
        campo: 'tipo',
        rotulo: 'Tipo',
        tipo: 'selecao',
        opcoes: TIPOS_EXIBIDOS_VENDA.map((t) => ({ value: t, label: ROTULOS_TIPO_VENDA[t] })),
      },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        padrao: 'todas',
        opcoes: SITUACOES_FILTRO_VENDA.map((s) => ({ value: s, label: ROTULOS_SITUACAO_FILTRO[s] })),
      },
      {
        campo: 'devolucao',
        rotulo: 'Devolução',
        tipo: 'selecao',
        padrao: 'todas',
        opcoes: DEVOLUCOES_FILTRO_VENDA.map((d) => ({
          value: d,
          label: d === 'todas' ? 'Todas' : ROTULOS_DEVOLUCAO_VENDA[d]!,
        })),
      },
    ];
    if (operadores)
      filtros.push({ campo: 'operadorId', rotulo: 'Operador PDV', tipo: 'selecao', opcoes: operadores });
    if (formas)
      filtros.push({
        campo: 'formaPagamentoId',
        rotulo: 'Forma de pagamento',
        tipo: 'selecao',
        opcoes: formas,
      });
    if (treino) filtros.push(treino);
    filtros.push({
      campo: 'sessaoCaixaId',
      rotulo: 'Sessão de caixa',
      tipo: 'texto',
      oculto: true,
      rotuloOculto:
        'Mostrando só as vendas de uma sessão de caixa (link do fechamento). Remova o filtro para ver as vendas de todos os caixas.',
    });
    return {
      recurso: 'vendas',
      titulo: 'Vendas',
      ordenacaoPadrao: 'data:desc',
      permissaoNovo: null,
      rotaEdicao: (v) => `${ROTA_VENDAS}/${v.id}`,
      chaveLinha: (v) => v.id,
      filtros,
      colunas: [
        {
          campo: 'cliente',
          rotulo: 'Cliente',
          ordenavel: true,
          formato: (v) => v.clienteNome ?? 'Consumidor final',
        },
        { campo: 'codigo', rotulo: 'Código', ordenavel: true, formato: (v) => v.numeroExibicao },
        {
          campo: 'data',
          rotulo: 'Data',
          ordenavel: true,
          formato: (v) => (
            <Stack gap={0}>
              <span>{formatarDataHora(v.finalizadaEm)}</span>
              <Text size="xs" c="dimmed">
                Dia {formatarData(v.diaOperacional)}
              </Text>
            </Stack>
          ),
        },
        { campo: 'tipo', rotulo: 'Tipo', ordenavel: true, formato: (v) => ROTULOS_TIPO_VENDA[v.tipo] },
        {
          campo: 'situacao',
          rotulo: 'Situação',
          ordenavel: true,
          formato: (v) => <BadgeSituacaoVenda status={v.status} />,
        },
        {
          campo: 'total_bruto',
          rotulo: 'Total bruto',
          ordenavel: true,
          alinhamento: 'right',
          formato: (v) => reais(v.subtotalBruto),
        },
        {
          campo: 'total',
          rotulo: 'Total líquido',
          ordenavel: true,
          alinhamento: 'right',
          formato: (v) => reais(v.total),
        },
        {
          campo: 'loja',
          rotulo: 'Loja / Caixa',
          ordenavel: true,
          formato: (v) => (
            <Group gap={4} wrap="nowrap">
              <RotuloLoja codigo={v.lojaCodigo} nome={v.lojaNome} treino={v.lojaTreino} />
              <Text span size="sm" c="dimmed">
                · Cx {v.numeroCaixa}
              </Text>
            </Group>
          ),
        },
      ],
      buscar: (params, sinal) => apiErp.get<PaginaVendas>(`/vendas${query(params)}`, { sinal }),
      rodape: (p) => {
        const t = (p as PaginaVendas).totais;
        return (
          <Group justify="flex-end" gap="xl" data-testid="totais-vendas">
            <Text size="sm">
              Vendas: <b>{formatarInteiro(t.quantidade)}</b>
              {t.canceladas > 0 && ` (${formatarInteiro(t.canceladas)} cancelada(s), fora dos valores)`}
            </Text>
            <Text size="sm">
              Total bruto: <b>{reais(t.totalBruto)}</b>
            </Text>
            <Text size="sm">
              Descontos: <b>{reais(t.descontos)}</b>
            </Text>
            <Text size="sm">
              Total líquido: <b>{reais(t.totalLiquido)}</b>
            </Text>
          </Group>
        );
      },
    };
  }, [lojas, operadores, formas, treino, hoje]);
  return <Listagem config={config} />;
}

const ABAS = ['dados', 'financeiro', 'fiscal', 'historico'] as const;
const qtd = (v: string) => formatarDecimal(Number(v), 3);

/**
 * Venda (ERP 15.4.2) só de leitura: abas Dados gerais (cabeçalho, cliente e itens), Financeiro (pagamentos, totais e
 * o lucro com `vendas.ver_lucro`), Documento fiscal (vazio até a 1D) e Histórico. Cancelar, devolução e emitir NF-e
 * não aparecem: a venda do PDV é imutável no ERP nesta fase.
 */
export function DetalheVenda() {
  const { id, aba } = useParams();
  const navigate = useNavigate();
  const pode = usePode();
  const r = useQuery({
    queryKey: ['venda', id],
    queryFn: ({ signal }) => apiErp.get<VendaDetalhe>(`/vendas/${id}`, { sinal: signal }),
    enabled: !!id,
  });
  const v = r.data;
  useDocumentTitle(`${v ? `Venda ${v.numeroExibicao}` : 'Venda'} · GenesisPDV`);
  const atual = (ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados';
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!v) return <Skeleton h={300} />;
  return (
    <Stack gap="md">
      <Anchor component={Link} to={ROTA_VENDAS} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> Vendas
        </Group>
      </Anchor>
      <Group gap="xs">
        <Title order={2} size="h3">
          Venda {v.numeroExibicao}
        </Title>
        <BadgeSituacaoVenda status={v.status} />
        {v.lojaTreino && (
          <Badge variant="light" color="grape">
            Loja de treino
          </Badge>
        )}
      </Group>
      {v.status === 'cancelada' && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Venda cancelada">
          {formatarDataHora(v.canceladaEm)} no {v.cancelamentoOrigem === 'erp' ? 'ERP' : 'PDV'}
          {v.canceladaPorNome ? ` por ${v.canceladaPorNome}` : ''}
          {v.cancelamentoAutorizadoPorNome ? `, autorizado por ${v.cancelamentoAutorizadoPorNome}` : ''}.{' '}
          Motivo: {v.motivoCancelamento ?? '—'}
        </Alert>
      )}
      {!v.relogioConfiavel && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
          O relógio do caixa não estava confiável quando a venda foi feita: data e hora podem estar erradas.
        </Alert>
      )}
      <Tabs
        value={atual}
        onChange={(a) => navigate(`${ROTA_VENDAS}/${v.id}/${a ?? 'dados'}`, { replace: true })}
      >
        <Tabs.List>
          <Tabs.Tab value="dados">Dados gerais</Tabs.Tab>
          <Tabs.Tab value="financeiro">Financeiro</Tabs.Tab>
          <Tabs.Tab value="fiscal">Documento fiscal</Tabs.Tab>
          <Tabs.Tab value="historico">Histórico</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="dados" pt="md">
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <Bloco titulo="Venda">
                <Campo rotulo="Código">{v.numeroExibicao}</Campo>
                <Campo rotulo="Tipo">{ROTULOS_TIPO_VENDA[v.tipo]}</Campo>
                <Campo rotulo="Iniciada">{formatarDataHora(v.iniciadaEm)}</Campo>
                <Campo rotulo="Finalizada">{formatarDataHora(v.finalizadaEm)}</Campo>
                <Campo rotulo="Dia operacional">{formatarData(v.diaOperacional)}</Campo>
                <Campo rotulo="Tipo de preço">{v.tipoPreco}</Campo>
              </Bloco>
              <Bloco titulo="Loja e caixa">
                <Campo rotulo="Loja">
                  <RotuloLoja codigo={v.lojaCodigo} nome={v.lojaNome} treino={v.lojaTreino} />
                </Campo>
                <Campo rotulo="Caixa">{v.numeroCaixa}</Campo>
                <Campo rotulo="Terminal">{v.terminalDescricao ?? '—'}</Campo>
                <Campo rotulo="Operador">{v.operadorNome ?? '—'}</Campo>
                <Campo rotulo="Sessão de caixa">
                  {v.sessaoCaixaId && pode('fechamentos_caixa.ver') ? (
                    <Anchor
                      component={Link}
                      to={`/financeiro/fechamentos-caixa/${v.sessaoCaixaId}`}
                      size="sm"
                    >
                      Ver fechamento
                    </Anchor>
                  ) : (
                    '—'
                  )}
                </Campo>
              </Bloco>
              <Bloco titulo="Cliente">
                <Campo rotulo="Cliente">
                  {v.clienteId && pode('pessoas.ver') ? (
                    <Anchor component={Link} to={`/pessoas/${v.clienteId}`} size="sm">
                      {v.clienteNome}
                    </Anchor>
                  ) : (
                    (v.clienteNome ?? 'Consumidor final')
                  )}
                </Campo>
                <Campo rotulo="CPF/CNPJ na nota">{v.cpfCnpjNota ?? '—'}</Campo>
                <Campo rotulo="Observação">{v.observacao ?? '—'}</Campo>
              </Bloco>
            </SimpleGrid>
            <Table.ScrollContainer minWidth={720}>
              <Table striped aria-label="Itens da venda">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>#</Table.Th>
                    <Table.Th>Produto</Table.Th>
                    <Table.Th ta="right">Quantidade</Table.Th>
                    <Table.Th>Un.</Table.Th>
                    <Table.Th ta="right">Preço unitário</Table.Th>
                    <Table.Th ta="right">Desconto</Table.Th>
                    <Table.Th ta="right">Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.itens.map((i) => (
                    <Table.Tr key={i.id} style={i.cancelado ? { textDecoration: 'line-through' } : undefined}>
                      <Table.Td>{i.sequencia}</Table.Td>
                      <Table.Td>
                        <Stack gap={0}>
                          <span>
                            {i.produtoCodigo ? `${i.produtoCodigo} - ` : ''}
                            {i.descricao}
                          </span>
                          {(i.kitDescricao || i.cancelado) && (
                            <Text size="xs" c="dimmed">
                              {i.kitDescricao ? `Combo: ${i.kitDescricao}` : ''}
                              {i.cancelado
                                ? ` Item cancelado${i.canceladoPorNome ? ` por ${i.canceladoPorNome}` : ''}`
                                : ''}
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td ta="right">{qtd(i.quantidade)}</Table.Td>
                      <Table.Td>{i.unidade}</Table.Td>
                      <Table.Td ta="right">{`R$ ${formatarDecimal(Number(i.precoUnitario), 4)}`}</Table.Td>
                      <Table.Td ta="right">
                        {reais(decTexto(dec(i.descontoItem).plus(dec(i.descontoRateado)), 2))}
                      </Table.Td>
                      <Table.Td ta="right">{reais(i.valorLiquido)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="financeiro" pt="md">
          <Stack gap="md">
            <Table.ScrollContainer minWidth={600}>
              <Table striped aria-label="Pagamentos da venda">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Forma de pagamento</Table.Th>
                    <Table.Th ta="right">Valor</Table.Th>
                    <Table.Th ta="right">Recebido</Table.Th>
                    <Table.Th ta="right">Troco</Table.Th>
                    <Table.Th>Situação</Table.Th>
                    <Table.Th>Detalhes</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.pagamentos.map((pg) => (
                    <Table.Tr key={pg.id}>
                      <Table.Td>{pg.descricaoForma}</Table.Td>
                      <Table.Td ta="right">{reais(pg.valor)}</Table.Td>
                      <Table.Td ta="right">{reais(pg.valorRecebido)}</Table.Td>
                      <Table.Td ta="right">{reais(pg.troco)}</Table.Td>
                      <Table.Td>{pg.status}</Table.Td>
                      <Table.Td>
                        {[
                          pg.bandeiraNome,
                          pg.nsu && `NSU ${pg.nsu}`,
                          pg.autorizacao && `Aut. ${pg.autorizacao}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Bloco titulo="Totais">
                <Campo rotulo="Subtotal">{reais(v.subtotalBruto)}</Campo>
                <Campo rotulo="Desconto nos itens">{reais(v.descontoItens)}</Campo>
                <Campo rotulo="Desconto no total">{reais(v.descontoTotal)}</Campo>
                <Campo rotulo="Acréscimo">{reais(v.acrescimoTotal)}</Campo>
                <Campo rotulo="Total">
                  <b>{reais(v.total)}</b>
                </Campo>
                <Campo rotulo="Troco">{reais(v.troco)}</Campo>
              </Bloco>
              {v.lucro && (
                <Bloco titulo="Lucro">
                  <Campo rotulo="Custo">{reais(v.lucro.custo)}</Campo>
                  <Campo rotulo="Lucro">{reais(v.lucro.lucro)}</Campo>
                  <Campo rotulo="Margem">
                    {v.lucro.margemPct === null ? '—' : `${formatarDecimal(Number(v.lucro.margemPct), 2)}%`}
                  </Campo>
                </Bloco>
              )}
            </SimpleGrid>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="fiscal" pt="md">
          <Text c="dimmed">
            Sem documento fiscal: a NFC-e chega com a Fase 1D. Situação fiscal da venda: {v.statusFiscal}.
          </Text>
        </Tabs.Panel>
        <Tabs.Panel value="historico" pt="md">
          {atual === 'historico' && <Historico entidade="vendas" registroId={v.id} />}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
