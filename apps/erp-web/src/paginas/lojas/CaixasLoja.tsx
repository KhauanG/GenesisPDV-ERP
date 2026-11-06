import { criarCaixaSchema, alterarCaixaSchema, type CaixaDetalhe, type LojaDetalhe } from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Grid,
  Group,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { errosDaApi, errosDoZod } from '../../util/erros';

interface ValoresCaixa {
  numero: number | string;
  descricao: string;
  nfceSerie: number | string;
  nfceNumeroInicial: number | string;
  tefTerminal: string;
  posIdTerminal: string;
  ativo: boolean;
}

const VAZIO: ValoresCaixa = {
  numero: '',
  descricao: '',
  nfceSerie: '',
  nfceNumeroInicial: '',
  tefTerminal: '',
  posIdTerminal: '',
  ativo: true,
};

/** Lojas › Caixas (ERP 10.3.10): o caixa 0 é do sistema; série NFC-e única na loja; nº inicial só antes do terminal. */
export function CaixasLoja({ loja, somenteLeitura }: { loja: LojaDetalhe; somenteLeitura?: boolean }) {
  const queryClient = useQueryClient();
  const chave = ['caixas', loja.id];
  const caixas = useQuery({
    queryKey: chave,
    queryFn: () => apiErp.get<CaixaDetalhe[]>(`/lojas/${loja.id}/caixas`),
  });
  const [editando, setEditando] = useState<CaixaDetalhe | 'novo' | null>(null);
  const excluir = useMutation({
    mutationFn: (id: string) => apiErp.del(`/lojas/${loja.id}/caixas/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chave });
      notifications.show({ color: 'green', message: 'Caixa excluído' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
  });

  if (caixas.isPending) return <Loader />;
  if (caixas.isError) return <Alert color="red">{(caixas.error as Error).message}</Alert>;
  const deposito = loja.tipo === 'deposito';
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {deposito
            ? 'Depósito/CD não tem caixas de PDV: só o caixa 0, das vendas e notas do ERP.'
            : 'Posições de caixa da loja; cada PDV ativado ocupa um caixa.'}
        </Text>
        {!somenteLeitura && !deposito && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditando('novo')}>
            Novo caixa
          </Button>
        )}
      </Group>
      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={70}>Nº</Table.Th>
            <Table.Th>Descrição</Table.Th>
            <Table.Th>Série NFC-e</Table.Th>
            <Table.Th>Último nº NFC-e</Table.Th>
            <Table.Th>Terminal</Table.Th>
            <Table.Th>Ativo</Table.Th>
            <Table.Th w={90} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {caixas.data.map((c) => (
            <Table.Tr key={c.id}>
              <Table.Td>{String(c.numero).padStart(2, '0')}</Table.Td>
              <Table.Td>
                {c.descricao ?? '—'}{' '}
                {c.sistema && (
                  <Badge size="xs" variant="light" color="gray">
                    sistema
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>{c.nfceSerie ?? '—'}</Table.Td>
              <Table.Td>{c.nfceUltimoNumero ?? '—'}</Table.Td>
              <Table.Td>
                {c.terminalId ? (
                  <Badge color="green" variant="light">
                    Ativo
                  </Badge>
                ) : (
                  '—'
                )}
              </Table.Td>
              <Table.Td>{c.ativo ? 'Sim' : 'Não'}</Table.Td>
              <Table.Td>
                {!c.sistema && !somenteLeitura && (
                  <Group gap={4}>
                    <ActionIcon
                      variant="subtle"
                      aria-label={`Editar caixa ${c.numero}`}
                      onClick={() => setEditando(c)}
                    >
                      <IconPencil size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Excluir caixa ${c.numero}`}
                      disabled={!!c.terminalId}
                      onClick={() =>
                        modals.openConfirmModal({
                          title: 'Excluir caixa',
                          children: <Text size="sm">Excluir o caixa {c.numero}?</Text>,
                          labels: { confirm: 'Excluir', cancel: 'Cancelar' },
                          confirmProps: { color: 'red' },
                          onConfirm: () => excluir.mutate(c.id),
                        })
                      }
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {editando && (
        <ModalCaixa
          lojaId={loja.id}
          caixa={editando === 'novo' ? null : editando}
          proximo={Math.max(0, ...caixas.data.map((c) => c.numero)) + 1}
          fechar={() => setEditando(null)}
        />
      )}
    </Stack>
  );
}

function ModalCaixa({
  lojaId,
  caixa,
  proximo,
  fechar,
}: {
  lojaId: string;
  caixa: CaixaDetalhe | null;
  proximo: number;
  fechar: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<ValoresCaixa>({
    mode: 'controlled',
    initialValues: caixa
      ? {
          numero: caixa.numero,
          descricao: caixa.descricao ?? '',
          nfceSerie: caixa.nfceSerie ?? '',
          nfceNumeroInicial: '',
          tefTerminal: caixa.tefTerminal ?? '',
          posIdTerminal: caixa.posIdTerminal ?? '',
          ativo: caixa.ativo,
        }
      : { ...VAZIO, numero: proximo },
  });
  const [erro, setErro] = useState<string | null>(null);
  const gravar = useMutation({
    mutationFn: (corpo: unknown) =>
      caixa
        ? apiErp.put<CaixaDetalhe>(`/lojas/${lojaId}/caixas/${caixa.id}`, corpo)
        : apiErp.post<CaixaDetalhe>(`/lojas/${lojaId}/caixas`, corpo),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['caixas', lojaId] });
      notifications.show({ color: 'green', message: 'Caixa gravado' });
      fechar();
    },
    onError: (e) => {
      if (e instanceof ErroRequisicao && e.campos) form.setErrors(errosDaApi(e.campos));
      setErro((e as Error).message);
    },
  });
  function salvar() {
    const v = form.getValues();
    const corpo = {
      ...v,
      numero: caixa ? undefined : Number(v.numero),
      ...(caixa ? { versao: caixa.versao } : {}),
    };
    const r = (caixa ? alterarCaixaSchema : criarCaixaSchema).safeParse(corpo);
    if (!r.success) return form.setErrors(errosDoZod(r.error));
    setErro(null);
    gravar.mutate(corpo);
  }
  return (
    <Modal opened onClose={fechar} title={caixa ? `Caixa ${caixa.numero}` : 'Novo caixa'} centered size="lg">
      <Stack gap="sm">
        <Grid>
          <Grid.Col span={4}>
            <NumberInput
              label="Nº do caixa"
              required
              min={1}
              max={99}
              allowDecimal={false}
              disabled={!!caixa}
              {...form.getInputProps('numero')}
            />
          </Grid.Col>
          <Grid.Col span={8}>
            <TextInput
              label="Descrição"
              maxLength={40}
              placeholder="Ex.: Caixa balcão"
              {...form.getInputProps('descricao')}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              label="Série NFC-e"
              description="Única na loja (uma série por caixa)"
              min={1}
              max={889}
              allowDecimal={false}
              disabled={!!caixa?.terminalId}
              {...form.getInputProps('nfceSerie')}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <NumberInput
              label="Nº inicial da NFC-e"
              description={
                caixa?.jaTeveTerminal ? 'O PDV já é o dono da numeração' : 'Só antes da primeira ativação'
              }
              min={1}
              allowDecimal={false}
              disabled={!!caixa?.jaTeveTerminal}
              {...form.getInputProps('nfceNumeroInicial')}
            />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput label="Nº terminal TEF" maxLength={20} {...form.getInputProps('tefTerminal')} />
          </Grid.Col>
          <Grid.Col span={6}>
            <TextInput
              label="Nº lógico/serial do POS"
              maxLength={40}
              {...form.getInputProps('posIdTerminal')}
            />
          </Grid.Col>
          <Grid.Col span={12}>
            <Switch label="Ativo" {...form.getInputProps('ativo', { type: 'checkbox' })} />
          </Grid.Col>
        </Grid>
        {erro && <Alert color="red">{erro}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          <Button loading={gravar.isPending} onClick={salvar}>
            Gravar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
