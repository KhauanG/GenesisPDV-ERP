import type {
  EmpresaSituacaoMigracao,
  ResultadoMigracaoEmMassa,
  SimulacaoMigracoes,
  SituacaoMigracaoEmpresa,
  SituacaoMigracoes,
} from '@genesis/shared';
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { IconAlertTriangle, IconDatabaseCog, IconEye, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiPlataforma } from '../api/clientes';
import { query } from '../api/http';
import { formatarDataHora } from '../util/formato';
import { BadgeStatus } from './Empresas';
import { useSessaoPlataforma } from './sessao';

const SITUACOES: Record<SituacaoMigracaoEmpresa, { rotulo: string; cor: string }> = {
  em_dia: { rotulo: 'Em dia', cor: 'green' },
  atrasada: { rotulo: 'Atrasada', cor: 'yellow' },
  com_erro: { rotulo: 'Com erro', cor: 'red' },
  aplicando: { rotulo: 'Aplicando', cor: 'blue' },
  desconhecida: { rotulo: 'Versão desconhecida', cor: 'gray' },
};

const STATUS_EXECUCAO: Record<string, { rotulo: string; cor: string }> = {
  ok: { rotulo: 'OK', cor: 'green' },
  falhou: { rotulo: 'Falhou', cor: 'red' },
  ignorada: { rotulo: 'Ignorada (outra em andamento)', cor: 'gray' },
  nao_executada: { rotulo: 'Não executada', cor: 'gray' },
};

type Filtro = 'todas' | 'atrasadas' | 'com_erro';

/**
 * Painel › Migrações (ERP 19.7): versão do código × versão de cada empresa, "Aplicar em todas" (canário primeiro,
 * depois lotes; opção de parar no primeiro erro), "Aplicar" e "Simular" por empresa, e o log das execuções.
 */
export function Migracoes() {
  useDocumentTitle('Migrações · Plataforma');
  const { temPapel } = useSessaoPlataforma();
  const podeExecutar = temPapel('suporte');
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filtro = (
    ['atrasadas', 'com_erro'].includes(params.get('filtro') ?? '') ? params.get('filtro') : 'todas'
  ) as Filtro;
  const [pararNoErro, setPararNoErro] = useState(false);
  const [resultado, setResultado] = useState<ResultadoMigracaoEmMassa | null>(null);
  const [simulacao, setSimulacao] = useState<SimulacaoMigracoes | null>(null);

  const chave = ['plataforma', 'migracoes', filtro];
  const situacao = useQuery({
    queryKey: chave,
    queryFn: () =>
      apiPlataforma.get<SituacaoMigracoes>(
        `/migracoes${query({ filtro: filtro === 'todas' ? null : filtro })}`,
      ),
  });

  const aplicar = useMutation({
    mutationFn: (codigos?: number[]) =>
      apiPlataforma.post<ResultadoMigracaoEmMassa>('/migracoes/aplicar', {
        ...(codigos ? { codigos } : {}),
        pararNoPrimeiroErro: pararNoErro,
      }),
    onSuccess: (r) => {
      setResultado(r);
      void queryClient.invalidateQueries({ queryKey: ['plataforma', 'migracoes'] });
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'plataforma_empresas'] });
    },
  });

  const simular = useMutation({
    mutationFn: (codigo?: number) =>
      apiPlataforma.get<SimulacaoMigracoes>(`/migracoes/simular${query({ codigo })}`),
    onSuccess: setSimulacao,
  });

  function confirmarAplicar(empresa?: EmpresaSituacaoMigracao) {
    modals.openConfirmModal({
      title: empresa ? `Aplicar migrações na empresa ${empresa.codigo}` : 'Aplicar em todas as empresas',
      children: (
        <Text size="sm">
          {empresa
            ? 'As migrações pendentes serão aplicadas no banco desta empresa.'
            : 'Primeiro as empresas canário; se alguma falhar, as demais nem começam. Depois, as demais em lotes.'}{' '}
          A API continua atendendo; uma empresa cuja migração falhar fica em manutenção (503) até a correção.
        </Text>
      ),
      labels: { confirm: 'Aplicar', cancel: 'Cancelar' },
      onConfirm: () => aplicar.mutate(empresa ? [empresa.codigo] : undefined),
    });
  }

  const s = situacao.data;
  const ocupado = aplicar.isPending || simular.isPending;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Title order={2} size="h3">
          Migrações
        </Title>
        {podeExecutar && (
          <Group gap="xs">
            <Checkbox
              label="Parar no primeiro erro"
              checked={pararNoErro}
              onChange={(e) => setPararNoErro(e.currentTarget.checked)}
            />
            <Button
              variant="default"
              leftSection={<IconEye size={16} />}
              loading={simular.isPending && simular.variables === undefined}
              disabled={ocupado}
              onClick={() => simular.mutate(undefined)}
            >
              Simular
            </Button>
            <Button
              leftSection={<IconDatabaseCog size={16} />}
              loading={aplicar.isPending && aplicar.variables === undefined}
              disabled={ocupado}
              onClick={() => confirmarAplicar()}
            >
              Aplicar em todas
            </Button>
          </Group>
        )}
      </Group>

      {aplicar.isPending && (
        <Alert color="blue" title="Aplicando migrações…">
          A execução continua no servidor mesmo que esta página seja fechada; o resultado aparece no log
          abaixo.
        </Alert>
      )}
      {(aplicar.error || simular.error || situacao.error) && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {((aplicar.error ?? simular.error ?? situacao.error) as Error).message}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing="sm">
        {(
          [
            ['Versão do código', s?.versaoAtual ?? '—'],
            ['Empresas', s?.resumo.empresas],
            ['Em dia', s?.resumo.emDia],
            ['Atrasadas', s?.resumo.atrasadas],
            ['Com erro', s?.resumo.comErro],
          ] as const
        ).map(([rotulo, valor]) => (
          <Card key={rotulo} withBorder padding="sm">
            <Text size="xs" c="dimmed">
              {rotulo}
            </Text>
            {s ? (
              <Text fw={700} size={typeof valor === 'string' ? 'sm' : 'lg'}>
                {valor}
              </Text>
            ) : (
              <Skeleton h={22} mt={4} />
            )}
          </Card>
        ))}
      </SimpleGrid>

      <SegmentedControl
        w="fit-content"
        value={filtro}
        onChange={(v) => setParams(v === 'todas' ? {} : { filtro: v })}
        data={[
          { value: 'todas', label: 'Todas' },
          { value: 'atrasadas', label: 'Atrasadas' },
          { value: 'com_erro', label: 'Com erro' },
        ]}
        aria-label="Filtro de situação"
      />

      <Paper p={0} style={{ overflow: 'hidden' }}>
        <Table.ScrollContainer minWidth={900}>
          <Table striped="even" aria-label="Situação das empresas">
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Código</Table.Th>
                <Table.Th scope="col">Empresa</Table.Th>
                <Table.Th scope="col">Status</Table.Th>
                <Table.Th scope="col">Versão do schema</Table.Th>
                <Table.Th scope="col">Pendentes</Table.Th>
                <Table.Th scope="col">Situação</Table.Th>
                <Table.Th scope="col">Última execução</Table.Th>
                {podeExecutar && <Table.Th scope="col">Ações</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {situacao.isPending
                ? Array.from({ length: 3 }, (_, i) => (
                    <Table.Tr key={i}>
                      <Table.Td colSpan={8}>
                        <Skeleton h={14} />
                      </Table.Td>
                    </Table.Tr>
                  ))
                : (s?.empresas ?? []).map((e) => (
                    <Table.Tr key={e.id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/plataforma/empresas/${e.codigo}`} fw={500}>
                          {e.codigo}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        {e.nomeFantasia ?? e.razaoSocial}
                        {e.canario && (
                          <Badge ml={6} size="xs" variant="outline">
                            Canário
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <BadgeStatus status={e.status} />
                      </Table.Td>
                      <Table.Td>
                        <Code>{e.versaoSchema ?? '—'}</Code>
                      </Table.Td>
                      <Table.Td>
                        {e.pendentes.length === 0 ? (
                          '—'
                        ) : (
                          <Tooltip label={e.pendentes.join(', ')} multiline maw={360}>
                            <Text size="sm" span>
                              {e.pendentes.length}
                            </Text>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Badge color={SITUACOES[e.situacao].cor} variant="light">
                          {SITUACOES[e.situacao].rotulo}
                        </Badge>
                        {e.erro && (
                          <Text size="xs" c="red" lineClamp={2} title={e.erro}>
                            {e.migracaoComErro}: {e.erro}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>{formatarDataHora(e.ultimaExecucaoEm)}</Table.Td>
                      {podeExecutar && (
                        <Table.Td>
                          <Group gap={4} wrap="nowrap">
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              aria-label={`Simular ${e.codigo}`}
                              loading={simular.isPending && simular.variables === e.codigo}
                              disabled={ocupado}
                              onClick={() => simular.mutate(e.codigo)}
                            >
                              Simular
                            </Button>
                            <Button
                              size="compact-xs"
                              variant="light"
                              leftSection={<IconPlayerPlay size={12} />}
                              aria-label={`Aplicar em ${e.codigo}`}
                              loading={aplicar.isPending && aplicar.variables?.[0] === e.codigo}
                              disabled={ocupado}
                              onClick={() => confirmarAplicar(e)}
                            >
                              Aplicar
                            </Button>
                          </Group>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {s && s.empresas.length === 0 && (
          <Text c="dimmed" ta="center" py="lg">
            Nenhuma empresa nesta situação.
          </Text>
        )}
      </Paper>

      <Paper p="md">
        <Title order={3} size="h5" mb="sm">
          Log das execuções
        </Title>
        {s && s.execucoes.length === 0 && (
          <Text size="sm" c="dimmed">
            Nenhuma execução registrada.
          </Text>
        )}
        <Accordion variant="separated" chevronPosition="left">
          {(s?.execucoes ?? []).map((x) => (
            <Accordion.Item key={x.id} value={x.id}>
              <Accordion.Control>
                <Group gap="sm" wrap="wrap">
                  <Text size="sm" fw={500}>
                    {formatarDataHora(x.ocorridoEm)}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {x.adminNome ?? 'linha de comando'} · {x.executadoPor ?? '—'}
                  </Text>
                  <Badge color={x.falhas ? 'red' : 'green'} variant="light">
                    {x.falhas ? `${x.falhas} falha(s)` : 'Sem falhas'}
                  </Badge>
                  {x.interrompida && (
                    <Badge color="orange" variant="light">
                      Interrompida
                    </Badge>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <ResultadoEmpresas itens={x.empresas} />
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      </Paper>

      <Modal
        opened={resultado !== null}
        onClose={() => setResultado(null)}
        title="Resultado da migração"
        size="lg"
      >
        {resultado && (
          <Stack gap="sm">
            <Group gap="xs">
              <Badge color={resultado.falhas ? 'red' : 'green'} variant="light">
                {resultado.falhas ? `${resultado.falhas} falha(s)` : 'Sem falhas'}
              </Badge>
              {resultado.interrompida && (
                <Badge color="orange" variant="light">
                  Interrompida
                </Badge>
              )}
            </Group>
            <ResultadoEmpresas itens={[...resultado.canarios, ...resultado.demais]} />
          </Stack>
        )}
      </Modal>

      <Modal opened={simulacao !== null} onClose={() => setSimulacao(null)} title="Simulação" size="xl">
        {simulacao && (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {simulacao.fonte === 'banco'
                ? 'Lido do registro de migrações do banco da empresa. Nada foi aplicado.'
                : 'Estimado pela versão do schema registrada no controle. Nada foi aplicado.'}
            </Text>
            {simulacao.empresas.length === 0 && <Alert color="green">Nenhuma migração pendente.</Alert>}
            {simulacao.empresas.map((e) => (
              <Text key={e.codigo} size="sm">
                <b>{e.codigo}</b> {e.razaoSocial}:{' '}
                {e.pendentes.length ? e.pendentes.join(', ') : 'nada pendente'}
                {e.alteradas.length > 0 && (
                  <Text span c="red" size="sm">
                    {' '}
                    · alteradas depois de aplicadas: {e.alteradas.join(', ')}
                  </Text>
                )}
              </Text>
            ))}
            {simulacao.migracoes.map((m) => (
              <div key={m.tag}>
                <Text size="sm" fw={600}>
                  {m.tag}
                </Text>
                <Code block mah={240} style={{ overflow: 'auto' }}>
                  {m.sql}
                </Code>
              </div>
            ))}
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

function ResultadoEmpresas({
  itens,
}: {
  itens: Array<{ codigo: number; status: string; aplicadas: string[]; erro?: string; avisos?: string[] }>;
}) {
  return (
    <Table aria-label="Resultado por empresa">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Empresa</Table.Th>
          <Table.Th>Resultado</Table.Th>
          <Table.Th>Aplicadas</Table.Th>
          <Table.Th>Erro ou aviso</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {itens.map((i) => {
          const st = STATUS_EXECUCAO[i.status] ?? { rotulo: i.status, cor: 'gray' };
          return (
            <Table.Tr key={i.codigo}>
              <Table.Td>{i.codigo}</Table.Td>
              <Table.Td>
                <Badge color={st.cor} variant="light">
                  {st.rotulo}
                </Badge>
              </Table.Td>
              <Table.Td>{i.aplicadas.length ? i.aplicadas.join(', ') : '—'}</Table.Td>
              <Table.Td>
                <Text size="xs" c="red">
                  {i.erro ?? ''}
                </Text>
                {/* Avisos das preparações de dados (ex.: cadeia do razão quebrada, F2-B2): não são falha. */}
                {(i.avisos ?? []).map((a) => (
                  <Text key={a} size="xs" c="orange">
                    {a}
                  </Text>
                ))}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
