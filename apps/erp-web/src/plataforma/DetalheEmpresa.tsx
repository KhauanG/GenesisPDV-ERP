import type { EmpresaResumo, ResultadoProvisionamento } from '@genesis/shared';
import {
  Alert,
  Button,
  Grid,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useDisclosure, useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPlayerPause, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiPlataforma } from '../api/clientes';
import { ErroRequisicao } from '../api/http';
import { NaoEncontrado } from '../paginas/Erros';
import { formatarCnpj, formatarDataHora } from '../util/formato';
import { BadgeStatus } from './Empresas';
import { useSessaoPlataforma } from './sessao';

interface Migracao {
  id: string;
  migracao: string;
  status: string;
  iniciadaEm: string | null;
  concluidaEm: string | null;
  erro: string | null;
}

type Detalhe = EmpresaResumo & { migracaoComFalha: boolean; migracoes: Migracao[] };

const MOTIVOS = ['Inadimplência', 'Pedido do cliente', 'Uso indevido', 'Outro'];

/** Painel › Empresa (ERP 19.3/19.4): dados, migrações e as ações de status. */
export function DetalheEmpresa() {
  const { codigo } = useParams();
  useDocumentTitle(`Empresa ${codigo} · Plataforma`);
  const { temPapel } = useSessaoPlataforma();
  const queryClient = useQueryClient();
  const [suspensao, modalSuspensao] = useDisclosure(false);
  const [motivo, setMotivo] = useState<string | null>(MOTIVOS[0]!);
  const [detalheMotivo, setDetalheMotivo] = useState('');
  const chave = ['plataforma', 'empresa', codigo];
  const r = useQuery({ queryKey: chave, queryFn: () => apiPlataforma.get<Detalhe>(`/empresas/${codigo}`) });

  const atualizar = () => {
    void queryClient.invalidateQueries({ queryKey: chave });
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'plataforma_empresas'] });
  };
  const acao = useMutation({
    mutationFn: ({ caminho, corpo }: { caminho: string; corpo?: unknown }) =>
      apiPlataforma.post<ResultadoProvisionamento | { status: string }>(
        `/empresas/${codigo}/${caminho}`,
        corpo,
      ),
    onSuccess: (_d, v) => {
      notifications.show({
        color: 'green',
        message:
          v.caminho === 'suspender'
            ? 'Empresa suspensa'
            : v.caminho === 'reativar'
              ? 'Empresa reativada'
              : 'Provisionamento concluído',
      });
      modalSuspensao.close();
      atualizar();
    },
    onError: (e) =>
      notifications.show({ color: 'red', title: 'Não foi possível concluir', message: (e as Error).message }),
  });

  if (r.isError) {
    if (r.error instanceof ErroRequisicao && r.error.status === 404)
      return <NaoEncontrado inicio="/plataforma/empresas" />;
    return <Alert color="red">{(r.error as Error).message}</Alert>;
  }
  const e = r.data;
  const podeStatus = temPapel('suporte', 'financeiro');
  const textoMotivo = [motivo, detalheMotivo.trim()].filter(Boolean).join(': ');

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Group gap="sm">
          <Title order={2} size="h3">
            {e ? `${e.codigo} · ${e.nomeFantasia ?? e.razaoSocial}` : `Empresa ${codigo}`}
          </Title>
          {e && <BadgeStatus status={e.status} falha={e.migracaoComFalha} />}
        </Group>
        <Group gap="xs">
          <Button
            component={Link}
            to="/plataforma/empresas"
            variant="default"
            leftSection={<IconArrowLeft size={16} />}
          >
            Voltar
          </Button>
          {e?.status === 'ativa' && podeStatus && (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerPause size={16} />}
              onClick={modalSuspensao.open}
            >
              Suspender
            </Button>
          )}
          {(e?.status === 'suspensa' || e?.status === 'cancelada') && podeStatus && (
            <Button
              color="green"
              leftSection={<IconPlayerPlay size={16} />}
              loading={acao.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: 'Reativar empresa',
                  children: <Text size="sm">O ERP e os PDVs voltam a funcionar no próximo contato.</Text>,
                  labels: { confirm: 'Reativar', cancel: 'Cancelar' },
                  onConfirm: () => acao.mutate({ caminho: 'reativar' }),
                })
              }
            >
              Reativar
            </Button>
          )}
          {e?.status === 'provisionando' && podeStatus && (
            <Button
              leftSection={<IconRefresh size={16} />}
              loading={acao.isPending}
              onClick={() => acao.mutate({ caminho: 'provisionamento/tentar-novamente', corpo: {} })}
            >
              Tentar novamente
            </Button>
          )}
        </Group>
      </Group>

      {e?.motivoStatus && (
        <Alert color="red" variant="light" title="Motivo do status">
          {e.motivoStatus}
        </Alert>
      )}

      <Paper p="md">
        {e ? (
          <Grid>
            {(
              [
                ['Razão social', e.razaoSocial],
                ['Nome fantasia', e.nomeFantasia ?? '—'],
                ['CNPJ', formatarCnpj(e.cnpj)],
                ['Plano', e.plano],
                ['Versão do schema', e.versaoSchema ?? '—'],
                ['Canário', e.canario ? 'Sim' : 'Não'],
                ['Criada em', formatarDataHora(e.criadoEm)],
                ['Ativada em', formatarDataHora(e.ativadaEm)],
              ] as const
            ).map(([rotulo, valor]) => (
              <Grid.Col key={rotulo} span={{ base: 12, sm: 6, md: 3 }}>
                <Text size="xs" c="dimmed">
                  {rotulo}
                </Text>
                <Text size="sm">{valor}</Text>
              </Grid.Col>
            ))}
          </Grid>
        ) : (
          <Text c="dimmed">Carregando…</Text>
        )}
      </Paper>

      <Paper p="md">
        <Title order={3} size="h5" mb="sm">
          Migrações
        </Title>
        <Table.ScrollContainer minWidth={500}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Migração</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Concluída em</Table.Th>
                <Table.Th>Erro</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(e?.migracoes ?? []).map((m) => (
                <Table.Tr key={m.id}>
                  <Table.Td>{m.migracao}</Table.Td>
                  <Table.Td>{m.status}</Table.Td>
                  <Table.Td>{formatarDataHora(m.concluidaEm)}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="red" lineClamp={2}>
                      {m.erro ?? ''}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Paper>

      <Modal opened={suspensao} onClose={modalSuspensao.close} title="Suspender empresa" centered>
        <Stack gap="sm">
          <Text size="sm">
            O login no ERP e o caixa (PDV) ficam bloqueados no próximo contato; as vendas já feitas continuam
            sendo recebidas. O motivo aparece para o cliente.
          </Text>
          <Select label="Motivo" data={MOTIVOS} value={motivo} onChange={setMotivo} allowDeselect={false} />
          <Textarea
            label="Detalhe (opcional)"
            value={detalheMotivo}
            onChange={(ev) => setDetalheMotivo(ev.currentTarget.value)}
            maxLength={200}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={modalSuspensao.close}>
              Cancelar
            </Button>
            <Button
              color="red"
              loading={acao.isPending}
              onClick={() =>
                acao.mutate({ caminho: 'suspender', corpo: { motivo: textoMotivo.slice(0, 255) } })
              }
            >
              Suspender
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
