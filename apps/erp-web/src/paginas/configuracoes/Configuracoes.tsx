import { normalizarTeclaAtalho, type AtalhoPdv } from '@genesis/shared';
import {
  Alert,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconDeviceFloppy, IconRestore } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { CamposConfiguracoes } from './CamposConfiguracoes';
import { ABA_GERAL, ABA_PARAMETROS, ABA_PDV, ROTULOS_ACOES_ATALHO } from './rotulos';

const ROTA = '/cadastros/configuracoes';
const ABAS = ['geral', 'parametros', 'pdv'] as const;

/** Cadastros › Configurações (ERP 9): abas Geral, Parâmetros (PDV) e PDV com a tabela de atalhos. */
export function Configuracoes() {
  useDocumentTitle('Configurações · GenesisPDV');
  const { aba } = useParams();
  const navigate = useNavigate();
  const pode = usePode();
  const somenteLeitura = !pode('configuracoes.editar');
  const ativa = (ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'geral';
  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        Configurações
      </Title>
      {somenteLeitura && (
        <Alert color="gray" variant="light">
          Somente leitura: você não tem permissão para alterar as configurações.
        </Alert>
      )}
      <Tabs
        value={ativa}
        onChange={(v) => v && navigate(`${ROTA}/${v}`, { replace: true })}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="geral">Geral</Tabs.Tab>
          <Tabs.Tab value="parametros">Parâmetros</Tabs.Tab>
          <Tabs.Tab value="pdv">PDV</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="geral">
          <CamposConfiguracoes itens={ABA_GERAL} somenteLeitura={somenteLeitura} />
        </Tabs.Panel>
        <Tabs.Panel value="parametros">
          <CamposConfiguracoes itens={ABA_PARAMETROS} somenteLeitura={somenteLeitura} />
        </Tabs.Panel>
        <Tabs.Panel value="pdv">
          <Stack gap="lg">
            <CamposConfiguracoes itens={ABA_PDV} somenteLeitura={somenteLeitura} />
            <TabelaAtalhos somenteLeitura={somenteLeitura} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <Text size="xs" c="dimmed">
        As abas Ordem de Serviço, Fiscal, Tributação, Orçamentos, Financeiro, CFOP&apos;s e Vendas entram com
        as fases que usam essas configurações. Valores por loja: Lojas › Parâmetros.
      </Text>
    </Stack>
  );
}

type Linha = Omit<AtalhoPdv, 'id'> & { erro?: string };

/** Valida as teclas na tela (mesmas regras da API, PDV 28.3): formato e tecla única entre habilitados. */
export function validarAtalhos(linhas: Linha[]): Linha[] {
  const usadas = new Map<string, string>();
  return linhas.map((l) => {
    const tecla = normalizarTeclaAtalho(l.tecla);
    if (!tecla) return { ...l, erro: 'Tecla inválida (F1–F12, Ctrl/Alt + letra ou número)' };
    if (l.habilitado) {
      const outra = usadas.get(tecla.toLowerCase());
      if (outra) return { ...l, erro: `Tecla já usada em ${ROTULOS_ACOES_ATALHO[outra] ?? outra}` };
      usadas.set(tecla.toLowerCase(), l.acao);
    }
    return { ...l, tecla, erro: undefined };
  });
}

/** Tabela de atalhos do PDV (ERP 9.9): tecla, habilitado e ordem; Restaurar padrão. */
export function TabelaAtalhos({ somenteLeitura }: { somenteLeitura?: boolean }) {
  const queryClient = useQueryClient();
  const dados = useQuery({
    queryKey: ['atalhos-pdv'],
    queryFn: () => apiErp.get<AtalhoPdv[]>('/atalhos-pdv'),
  });
  // `null` = sem edição: mostra o que veio do servidor.
  const [edicao, setEdicao] = useState<Linha[] | null>(null);
  const linhas: Linha[] = edicao ?? (dados.data ?? []).map(({ id: _id, ...l }) => l);
  const setLinhas = (f: Linha[] | ((ls: Linha[]) => Linha[])) =>
    setEdicao(typeof f === 'function' ? f(linhas) : f);

  const aoGravar = (r: AtalhoPdv[]) => {
    queryClient.setQueryData(['atalhos-pdv'], r);
    setEdicao(null);
    notifications.show({ color: 'green', message: 'Atalhos gravados' });
  };
  const aoErro = (e: unknown) => {
    const campos = e instanceof ErroRequisicao ? e.campos : undefined;
    if (campos) {
      setLinhas((ls) => ls.map((l, i) => ({ ...l, erro: campos[`itens.${i}.tecla`]?.[0] ?? l.erro })));
    }
    notifications.show({ color: 'red', message: (e as Error).message });
  };
  const gravar = useMutation({
    mutationFn: (itens: Linha[]) =>
      apiErp.put<AtalhoPdv[]>('/atalhos-pdv', { itens: itens.map(({ erro: _e, ...l }) => l) }),
    onSuccess: aoGravar,
    onError: aoErro,
  });
  const restaurar = useMutation({
    mutationFn: () => apiErp.post<AtalhoPdv[]>('/atalhos-pdv/restaurar-padrao'),
    onSuccess: aoGravar,
    onError: aoErro,
  });

  function salvar() {
    const validadas = validarAtalhos(linhas);
    setLinhas(validadas);
    if (validadas.some((l) => l.erro)) return;
    gravar.mutate(validadas);
  }

  const mudar = (i: number, campo: keyof Linha, valor: unknown) =>
    setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, [campo]: valor, erro: undefined } : l)));

  if (dados.isPending) return <Loader />;
  if (dados.isError) return <Alert color="red">{(dados.error as Error).message}</Alert>;
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" mb="xs">
        <Title order={5}>Atalhos do PDV</Title>
        {!somenteLeitura && (
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconRestore size={14} />}
              loading={restaurar.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: 'Restaurar padrão',
                  children: (
                    <Text size="sm">Voltar todas as teclas, a ordem e o habilitado para o padrão?</Text>
                  ),
                  labels: { confirm: 'Restaurar', cancel: 'Cancelar' },
                  onConfirm: () => restaurar.mutate(),
                })
              }
            >
              Restaurar padrão
            </Button>
            <Button
              size="xs"
              leftSection={<IconDeviceFloppy size={14} />}
              loading={gravar.isPending}
              onClick={salvar}
            >
              Gravar atalhos
            </Button>
          </Group>
        )}
      </Group>
      <Table striped verticalSpacing={4}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Ação</Table.Th>
            <Table.Th w={200}>Atalho</Table.Th>
            <Table.Th w={110}>Habilitado</Table.Th>
            <Table.Th w={110}>Ordem</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {linhas.map((l, i) => (
            <Table.Tr key={l.acao}>
              <Table.Td>
                <Text size="sm">{ROTULOS_ACOES_ATALHO[l.acao] ?? l.acao}</Text>
              </Table.Td>
              <Table.Td>
                <TextInput
                  size="xs"
                  aria-label={`Tecla de ${ROTULOS_ACOES_ATALHO[l.acao] ?? l.acao}`}
                  value={l.tecla}
                  disabled={somenteLeitura}
                  error={l.erro}
                  onChange={(e) => mudar(i, 'tecla', e.currentTarget.value)}
                />
              </Table.Td>
              <Table.Td>
                <Switch
                  aria-label={`Habilitar ${ROTULOS_ACOES_ATALHO[l.acao] ?? l.acao}`}
                  checked={l.habilitado}
                  disabled={somenteLeitura}
                  onChange={(e) => mudar(i, 'habilitado', e.currentTarget.checked)}
                />
              </Table.Td>
              <Table.Td>
                <NumberInput
                  size="xs"
                  min={0}
                  max={999}
                  allowDecimal={false}
                  value={l.ordem}
                  disabled={somenteLeitura}
                  onChange={(v) => mudar(i, 'ordem', Number(v) || 0)}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}
