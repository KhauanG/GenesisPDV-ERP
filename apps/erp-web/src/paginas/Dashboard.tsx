import type { Dashboard as DadosDashboard } from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconBox,
  IconClockExclamation,
  IconCash,
  IconChartBar,
  IconDeviceDesktop,
  IconInfoCircle,
  IconReceipt,
  IconUsers,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../api/clientes';
import { query } from '../api/http';
import { usePode } from '../auth/permissoes';
import { useEu } from '../auth/sessao';
import { formatarDecimal } from '../componentes/grade/decimal';
import { SeletorLoja } from '../componentes/seletores/SeletorLoja';
import { useLojaContexto } from '../layout/lojaContexto';
import { formatarDataHora, formatarInteiro } from '../util/formato';
import { CampoMes } from '../componentes/campos/CamposData';

const reais = (v: string | number) => `R$ ${formatarDecimal(Number(v), 2)}`;

/** Primeiro e último dia do mês `AAAA-MM` (link "Listagem" do card de vendas: `/vendas?dataInicial=…&dataFinal=…`). */
export function intervaloDoMes(mes: string): { dataInicial: string; dataFinal: string } {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a!, m!, 0)).getUTCDate();
  return { dataInicial: `${mes}-01`, dataFinal: `${mes}-${String(ultimo).padStart(2, '0')}` };
}

/**
 * Início – Dashboard (ERP 6): filtros Mês/Ano, Loja e, se a empresa tem loja de treino, "Incluir loja de treino"
 * (O10, fora por padrão); cards de pessoas, produtos e vendas do mês (vendas do PDV pelo dia operacional, D7, a
 * cancelada abatendo; Fase 1C, C12), vendas do dia e do mês por loja, PDVs e estoque abaixo do mínimo; o painel
 * mínimo de alertas críticos e as sessões de caixa abertas há muito tempo (Fase 1C, C14; O11), cada um levando ao
 * detalhe onde se decide (terminal, fechamento); os cards financeiros chegam com a Fase 4 e os gráficos e o painel
 * completo de alertas com a Fase 5.
 *
 * O mês começa vazio no filtro (`null`): a API usa o mês do dia operacional da empresa (corte da empresa, D7), o mesmo
 * do "hoje" das lojas, e o campo mostra o mês que ela devolveu. Assim, em 01/11 de madrugada, antes do corte, o card
 * do mês continua outubro junto com a coluna do dia; escolher um mês o manda explícito.
 */
export function Dashboard() {
  useDocumentTitle('Início · GenesisPDV');
  const eu = useEu();
  const pode = usePode();
  const { lojaId: lojaContexto } = useLojaContexto();
  const [rascunho, setRascunho] = useState<{
    mes: string | null;
    lojaId: typeof lojaContexto;
    treino: boolean;
  }>({
    mes: null,
    lojaId: lojaContexto,
    treino: false,
  });
  const [filtro, setFiltro] = useState(rascunho);
  const temTreino = eu.lojas.some((l) => l.treino);
  const primeiroNome = eu.usuario.nome.split(/\s+/)[0] ?? eu.usuario.nome;
  const dados = useQuery({
    queryKey: ['dashboard', filtro.mes, filtro.lojaId, filtro.treino],
    queryFn: () =>
      apiErp.get<DadosDashboard>(
        `/dashboard${query({ mes: filtro.mes, lojaId: filtro.lojaId, treino: filtro.treino ? 'incluir' : null })}`,
      ),
    enabled: pode('dashboard.ver'),
    placeholderData: keepPreviousData,
  });
  const d = dados.data;
  const alertas = d?.alertasCriticos?.total ? d.alertasCriticos : null;
  const sessoes = d?.sessoesAntigas?.total ? d.sessoesAntigas : null;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={2} size="h3">
            Olá, {primeiroNome[0]!.toUpperCase() + primeiroNome.slice(1).toLowerCase()}
          </Title>
          <Text c="dimmed">
            {eu.empresa.nome}
            {d ? ` · ${d.rotuloMes}` : ''}
          </Text>
        </div>
        {pode('dashboard.ver') && (
          <Group align="flex-end" gap="xs" wrap="wrap">
            <CampoMes
              label="Mês/Ano"
              value={rascunho.mes ?? dados.data?.mes ?? ''}
              onChange={(mes) => setRascunho({ ...rascunho, mes })}
              w={170}
            />
            <SeletorLoja
              label="Loja"
              permitirTodas
              value={rascunho.lojaId}
              onChange={(lojaId) => setRascunho({ ...rascunho, lojaId })}
              w={240}
            />
            {temTreino && (
              <Checkbox
                label="Incluir loja de treino"
                checked={rascunho.treino}
                onChange={(e) => setRascunho({ ...rascunho, treino: e.currentTarget.checked })}
                mb={8}
              />
            )}
            <Button onClick={() => setFiltro(rascunho)} loading={dados.isFetching}>
              Filtrar
            </Button>
          </Group>
        )}
      </Group>
      {eu.lojas.length === 0 && (
        <Alert icon={<IconInfoCircle size={18} />} title="Primeira configuração" variant="light">
          A empresa ainda não tem lojas.{' '}
          {pode('lojas.criar') ? (
            <Anchor component={Link} to="/cadastros/lojas/novo">
              Abra o assistente de primeira configuração
            </Anchor>
          ) : (
            'Peça a um administrador para cadastrar a primeira loja'
          )}{' '}
          (loja, estoque, caixa e numerações).
        </Alert>
      )}
      {dados.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {(dados.error as Error).message}
        </Alert>
      )}
      {!pode('dashboard.ver') ? (
        <Text c="dimmed">Use o menu ao lado para começar.</Text>
      ) : !d ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} h={110} />
          ))}
        </SimpleGrid>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: d.financeiro ? 5 : 3 }} data-testid="cards-dashboard">
            <Card
              icone={<IconUsers size={22} />}
              titulo="Pessoas"
              valor={formatarInteiro(d.pessoas.ativas)}
              detalhe={`${formatarInteiro(d.pessoas.novasNoMes)} nova(s) no mês`}
              link={pode('pessoas.ver') ? '/pessoas' : null}
            />
            <Card
              icone={<IconBox size={22} />}
              titulo="Produtos"
              valor={formatarInteiro(d.produtos.ativos)}
              detalhe={`${formatarInteiro(d.produtos.semPreco)} sem preço · ${formatarInteiro(d.produtos.ncmInvalido)} NCM inválido`}
              link={pode('produtos.ver') ? '/produtos' : null}
              alerta={d.produtos.semPreco + d.produtos.ncmInvalido > 0}
            />
            <Card
              icone={<IconChartBar size={22} />}
              titulo="Vendas no mês"
              valor={reais(d.vendas.total)}
              detalhe={`${formatarInteiro(d.vendas.quantidade)} venda(s) · ticket médio ${reais(d.vendas.ticketMedio)}`}
              link={
                pode('vendas.ver')
                  ? `/vendas${query({
                      ...intervaloDoMes(d.mes),
                      situacao: 'finalizada',
                      treino: filtro.treino ? 'incluir' : null,
                    })}${d.lojaId ? `&lojaId=${d.lojaId}` : '&lojaId='}`
                  : null
              }
            />
            {d.financeiro && (
              <>
                <Card
                  icone={<IconCash size={22} />}
                  titulo="Contas a receber no mês"
                  valor={reais(d.financeiro.receber.total)}
                  detalhe={`Recebido ${reais(d.financeiro.receber.recebido)} · em aberto ${reais(d.financeiro.receber.emAberto)}`}
                  link={null}
                />
                <Card
                  icone={<IconReceipt size={22} />}
                  titulo="Contas a pagar no mês"
                  valor={reais(d.financeiro.pagar.total)}
                  detalhe={`Pago ${reais(d.financeiro.pagar.pago)} · em aberto ${reais(d.financeiro.pagar.emAberto)}`}
                  link={null}
                />
              </>
            )}
          </SimpleGrid>

          <Paper p="md">
            <Group justify="space-between" mb="xs">
              <Text fw={600}>Vendas do dia e do mês por loja</Text>
              <Text size="xs" c="dimmed">
                Atualizado em {formatarDataHora(d.geradoEm)}
              </Text>
            </Group>
            {d.vendas.porLoja.length === 0 ? (
              <Text size="sm" c="dimmed">
                Nenhuma loja ativa no filtro.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={520}>
                <Table aria-label="Vendas por loja" striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Loja</Table.Th>
                      <Table.Th ta="right">Vendas hoje</Table.Th>
                      <Table.Th ta="right">Total hoje</Table.Th>
                      <Table.Th ta="right">Vendas no mês</Table.Th>
                      <Table.Th ta="right">Total no mês</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.vendas.porLoja.map((l) => (
                      <Table.Tr key={l.lojaId}>
                        <Table.Td>
                          {l.lojaCodigo} - {l.lojaNome}{' '}
                          {l.lojaTreino && (
                            <Badge size="xs" variant="light" color="grape">
                              treino
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td ta="right">{formatarInteiro(l.quantidadeDia)}</Table.Td>
                        <Table.Td ta="right">{reais(l.totalDia)}</Table.Td>
                        <Table.Td ta="right">{formatarInteiro(l.quantidadeMes)}</Table.Td>
                        <Table.Td ta="right">{reais(l.totalMes)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
            <Text size="xs" c="dimmed" mt="xs">
              Vendas do PDV finalizadas, pelo dia operacional (o "hoje" de cada loja segue o fuso e a hora de
              corte dela); as canceladas abatem do total.
            </Text>
          </Paper>

          {/* Só aparecem com algo a resolver: sem alerta e sem caixa esquecido, o Dashboard fica como era. */}
          {(alertas || sessoes) && (
            <SimpleGrid cols={{ base: 1, md: alertas && sessoes ? 2 : 1 }}>
              {alertas && <PainelAlertas alertas={alertas} />}
              {sessoes && <PainelSessoes sessoes={sessoes} />}
            </SimpleGrid>
          )}

          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {d.pdvs && (
              <Paper p="md">
                <Group gap="sm" mb="xs">
                  <ThemeIcon variant="light">
                    <IconDeviceDesktop size={18} />
                  </ThemeIcon>
                  <Text fw={600}>PDVs</Text>
                </Group>
                <Text size="sm">
                  {formatarInteiro(d.pdvs.total)} terminal(is): {formatarInteiro(d.pdvs.online)} online,{' '}
                  {formatarInteiro(d.pdvs.offline)} offline, {formatarInteiro(d.pdvs.comPendencias)} com
                  pendências.
                </Text>
              </Paper>
            )}
            {d.estoqueBaixo && (
              <Paper p="md">
                <Group justify="space-between" mb="xs">
                  <Group gap="sm">
                    <ThemeIcon variant="light" color="orange">
                      <IconAlertTriangle size={18} />
                    </ThemeIcon>
                    <Text fw={600}>Estoque abaixo do mínimo</Text>
                  </Group>
                  <Anchor component={Link} to="/estoque/saldos?situacaoSaldo=abaixo_minimo" size="sm">
                    Listagem
                  </Anchor>
                </Group>
                {d.estoqueBaixo.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    Nenhum produto abaixo do mínimo.
                  </Text>
                ) : (
                  <Table aria-label="Estoque abaixo do mínimo">
                    <Table.Tbody>
                      {d.estoqueBaixo.map((e) => (
                        <Table.Tr key={`${e.produtoId}:${e.lojaNome}`}>
                          <Table.Td>{e.produtoNome}</Table.Td>
                          <Table.Td>{e.lojaNome}</Table.Td>
                          <Table.Td ta="right">
                            {formatarDecimal(Number(e.quantidade), 3)} / mín.{' '}
                            {formatarDecimal(Number(e.estoqueMinimo), 3)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Paper>
            )}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

/** Tipos de alerta da 1C em português (o painel completo, com todos os tipos, é da Fase 5). */
const NOMES_ALERTA: Record<string, string> = {
  EVENTO_DESCARTADO: 'Evento descartado',
  EVENTO_COM_ERRO: 'Evento com erro',
  EVENTO_DIVERGENTE: 'Evento divergente',
  TERMINAL_DESATIVADO_COM_EVENTOS: 'Terminal desativado com eventos',
  TOKEN_ANTERIOR_REUTILIZADO: 'Token anterior reutilizado',
  ATIVACAO_FORCA_BRUTA: 'Tentativas de ativação',
  LACUNA_DECLARADA: 'Lacuna de eventos declarada',
  RELOGIO_DESVIO: 'Relógio do computador errado',
};

/**
 * Alertas críticos abertos (O11): total por tipo e os mais recentes, cada um levando ao terminal, onde se decide; o de
 * força bruta na ativação, sem terminal, leva à listagem (o "Liberar ativações" fica lá).
 */
function PainelAlertas({ alertas }: { alertas: NonNullable<DadosDashboard['alertasCriticos']> }) {
  return (
    <Paper p="md" withBorder style={{ borderColor: 'var(--mantine-color-red-4)' }}>
      <Group justify="space-between" mb="xs">
        <Group gap="sm">
          <ThemeIcon variant="light" color="red">
            <IconAlertOctagon size={18} />
          </ThemeIcon>
          <Text fw={600}>Alertas críticos ({formatarInteiro(alertas.total)})</Text>
        </Group>
        <Anchor component={Link} to="/cadastros/pdvs" size="sm">
          PDVs / Terminais
        </Anchor>
      </Group>
      <Group gap={6} mb="xs">
        {alertas.porTipo.map((t) => (
          <Badge key={t.tipo} color="red" variant="light">
            {NOMES_ALERTA[t.tipo] ?? t.tipo}: {formatarInteiro(t.quantidade)}
          </Badge>
        ))}
      </Group>
      <Table aria-label="Alertas críticos">
        <Table.Tbody>
          {alertas.recentes.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td>
                <Anchor
                  component={Link}
                  to={a.terminalId ? `/cadastros/pdvs/${a.terminalId}` : '/cadastros/pdvs'}
                  size="sm"
                  fw={500}
                >
                  {a.titulo}
                </Anchor>
                {a.mensagem && (
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {a.mensagem}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {a.lojaNome ?? 'Empresa'}
                </Text>
              </Table.Td>
              <Table.Td ta="right">
                <Text size="xs" c="dimmed">
                  {formatarDataHora(a.criadoEm)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

/**
 * Sessões de caixa abertas há mais de `pdv.horas_alerta_sessao` (ERP 14.9), da mais antiga para a mais nova, cada uma
 * levando ao detalhe dela em Fechamento de caixa (a listagem filtra por dia operacional e esconderia a sessão antiga).
 */
function PainelSessoes({ sessoes }: { sessoes: NonNullable<DadosDashboard['sessoesAntigas']> }) {
  return (
    <Paper p="md">
      <Group justify="space-between" mb="xs">
        <Group gap="sm">
          <ThemeIcon variant="light" color="orange">
            <IconClockExclamation size={18} />
          </ThemeIcon>
          <Text fw={600}>Caixas abertos há muito tempo ({formatarInteiro(sessoes.total)})</Text>
        </Group>
      </Group>
      <Table aria-label="Caixas abertos há muito tempo">
        <Table.Tbody>
          {sessoes.recentes.map((s) => (
            <Table.Tr key={s.sessaoId}>
              <Table.Td>
                <Anchor component={Link} to={`/financeiro/fechamentos-caixa/${s.sessaoId}`} size="sm">
                  {s.lojaNome} · Caixa {String(s.numeroCaixa).padStart(2, '0')}
                </Anchor>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{s.operadorNome ?? '—'}</Text>
              </Table.Td>
              <Table.Td ta="right">
                <Text size="sm" c="orange">
                  aberto há {formatarInteiro(s.horas)} h
                </Text>
                <Text size="xs" c="dimmed">
                  desde {formatarDataHora(s.abertaEm)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

function Card({
  icone,
  titulo,
  valor,
  detalhe,
  link,
  alerta,
}: {
  icone: ReactNode;
  titulo: string;
  valor: string;
  detalhe: string;
  link: string | null;
  alerta?: boolean;
}) {
  return (
    <Paper p="md">
      <Group gap="sm" mb="xs" justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" size="lg">
            {icone}
          </ThemeIcon>
          <Text fw={600}>{titulo}</Text>
        </Group>
        {link && (
          <Anchor component={Link} to={link} size="sm">
            Listagem
          </Anchor>
        )}
      </Group>
      <Text fw={700} size="xl">
        {valor}
      </Text>
      <Text size="sm" c={alerta ? 'orange' : 'dimmed'}>
        {detalhe}
      </Text>
    </Paper>
  );
}
