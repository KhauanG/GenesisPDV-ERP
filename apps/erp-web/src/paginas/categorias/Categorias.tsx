import {
  alterarCategoriaSchema,
  criarCategoriaSchema,
  montarArvoreCategorias,
  PROFUNDIDADE_MAXIMA_CATEGORIAS,
  type CategoriaArvore,
  type CategoriaNo,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  ColorInput,
  Grid,
  Group,
  Loader,
  Menu,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDocumentTitle } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { errosDaApi, errosDoZod } from '../../util/erros';

interface Valores {
  nome: string;
  categoriaPaiId: string | null;
  ordem: number | string;
  ativa: boolean;
  exibePdv: boolean;
  exibeMenuDigital: boolean;
  exibeTotem: boolean;
  exibeSite: boolean;
  cor: string;
}

const VAZIO: Valores = {
  nome: '',
  categoriaPaiId: null,
  ordem: 0,
  ativa: true,
  exibePdv: true,
  exibeMenuDigital: false,
  exibeTotem: false,
  exibeSite: false,
  cor: '',
};

type Edicao = { modo: 'nova'; paiId: string | null } | { modo: 'editar'; no: CategoriaNo };

/** Nós que casam com a busca e os ancestrais deles (para expandir até o resultado). */
function filtrarArvore(nos: CategoriaArvore[], termo: string): CategoriaArvore[] {
  if (!termo) return nos;
  const t = termo.toLowerCase();
  return nos
    .map((n) => ({ ...n, filhas: filtrarArvore(n.filhas, termo) }))
    .filter((n) => n.nome.toLowerCase().includes(t) || n.filhas.length > 0);
}

/** Produtos › Categorias (ERP 8.4): árvore com raiz "Departamentos", adicionar, configurar, mover e excluir. */
export function Categorias() {
  useDocumentTitle('Categorias · GenesisPDV');
  const pode = usePode();
  const podeEditar = pode('categorias.editar');
  const queryClient = useQueryClient();
  const arvore = useQuery({
    queryKey: ['categorias', 'arvore'],
    queryFn: () => apiErp.get<CategoriaNo[]>('/categorias/arvore'),
  });
  const [busca, setBusca] = useState('');
  const [abertas, setAbertas] = useState<Set<string>>(new Set());
  const [edicao, setEdicao] = useState<Edicao | null>(null);
  const raizes = useMemo(
    () => filtrarArvore(montarArvoreCategorias(arvore.data ?? []), busca.trim()),
    [arvore.data, busca],
  );

  const recarregar = () => queryClient.invalidateQueries({ queryKey: ['categorias'] });
  const excluir = useMutation({
    mutationFn: ({ id, confirmar }: { id: string; confirmar: boolean }) =>
      apiErp.del(`/categorias/${id}${confirmar ? '?confirmar=true' : ''}`),
    onSuccess: () => {
      void recarregar();
      setEdicao(null);
      notifications.show({ color: 'green', message: 'Categoria excluída' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
  });

  function pedirExclusao(no: CategoriaNo) {
    modals.openConfirmModal({
      title: 'Excluir categoria',
      children: (
        <Text size="sm">
          Excluir “{no.caminhoNomes}”?
          {no.produtos > 0 && ` ${no.produtos} produto(s) perdem o vínculo com ela (os produtos ficam).`}
        </Text>
      ),
      labels: { confirm: 'Excluir', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: () => excluir.mutate({ id: no.id, confirmar: no.produtos > 0 }),
    });
  }

  const alternar = (id: string) =>
    setAbertas((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderizar = (nos: CategoriaArvore[]) =>
    nos.map((no) => {
      const aberta = abertas.has(no.id) || !!busca.trim();
      return (
        <Box key={no.id} pl={no.nivel > 1 ? 'md' : 0}>
          <Group gap={4} wrap="nowrap" data-testid={`categoria-${no.nome}`}>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={aberta ? 'Recolher' : 'Expandir'}
              disabled={!no.filhas.length}
              onClick={() => alternar(no.id)}
            >
              {no.filhas.length ? (
                aberta ? (
                  <IconChevronDown size={14} />
                ) : (
                  <IconChevronRight size={14} />
                )
              ) : null}
            </ActionIcon>
            <UnstyledButton onClick={() => setEdicao({ modo: 'editar', no })} style={{ flex: 1 }}>
              <Group gap={6} wrap="nowrap">
                {no.cor ? (
                  <Box w={10} h={10} style={{ borderRadius: 2, background: no.cor }} />
                ) : (
                  <IconFolder size={14} />
                )}
                <Text
                  size="sm"
                  c={no.ativa ? undefined : 'dimmed'}
                  td={no.ativa ? undefined : 'line-through'}
                >
                  {no.nome}
                </Text>
                <Badge size="xs" variant="light" color="gray">
                  {no.produtos}
                </Badge>
              </Group>
            </UnstyledButton>
            {podeEditar && (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" size="sm" aria-label={`Ações de ${no.nome}`}>
                    <IconDots size={14} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<IconSettings size={14} />}
                    onClick={() => setEdicao({ modo: 'editar', no })}
                  >
                    Configurar categoria
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconPlus size={14} />}
                    disabled={no.nivel >= PROFUNDIDADE_MAXIMA_CATEGORIAS}
                    onClick={() => {
                      setAbertas((s) => new Set(s).add(no.id));
                      setEdicao({ modo: 'nova', paiId: no.id });
                    }}
                  >
                    Adicionar subcategoria
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconTrash size={14} />}
                    color="red"
                    onClick={() => pedirExclusao(no)}
                  >
                    Excluir
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
          {aberta && no.filhas.length > 0 && renderizar(no.filhas)}
        </Box>
      );
    });

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2} size="h3">
          Categorias
        </Title>
        {podeEditar && (
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setEdicao({ modo: 'nova', paiId: null })}
          >
            Nova categoria
          </Button>
        )}
      </Group>
      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder p="sm">
            <TextInput
              mb="sm"
              leftSection={<IconSearch size={14} />}
              placeholder="Buscar categoria"
              value={busca}
              onChange={(e) => setBusca(e.currentTarget.value)}
            />
            <Text fw={700} size="sm" mb={4}>
              Departamentos
            </Text>
            {arvore.isPending ? (
              <Loader size="sm" />
            ) : arvore.isError ? (
              <Alert color="red">{(arvore.error as Error).message}</Alert>
            ) : raizes.length ? (
              renderizar(raizes)
            ) : (
              <Text size="sm" c="dimmed">
                {busca ? 'Nenhuma categoria encontrada.' : 'Nenhuma categoria cadastrada.'}
              </Text>
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          {edicao ? (
            <PainelCategoria
              key={edicao.modo === 'editar' ? edicao.no.id + edicao.no.versao : `nova-${edicao.paiId}`}
              edicao={edicao}
              nos={arvore.data ?? []}
              somenteLeitura={!podeEditar}
              fechar={() => setEdicao(null)}
              aoGravar={(no) => {
                void recarregar();
                setEdicao({ modo: 'editar', no });
              }}
            />
          ) : (
            <Text size="sm" c="dimmed">
              Clique numa categoria para configurar, ou use ⋮ para adicionar subcategorias.
            </Text>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function PainelCategoria({
  edicao,
  nos,
  somenteLeitura,
  fechar,
  aoGravar,
}: {
  edicao: Edicao;
  nos: CategoriaNo[];
  somenteLeitura: boolean;
  fechar: () => void;
  aoGravar: (no: CategoriaNo) => void;
}) {
  const no = edicao.modo === 'editar' ? edicao.no : null;
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: no
      ? {
          nome: no.nome,
          categoriaPaiId: no.categoriaPaiId,
          ordem: no.ordem,
          ativa: no.ativa,
          exibePdv: no.exibePdv,
          exibeMenuDigital: no.exibeMenuDigital,
          exibeTotem: no.exibeTotem,
          exibeSite: no.exibeSite,
          cor: no.cor ?? '',
        }
      : { ...VAZIO, categoriaPaiId: edicao.modo === 'nova' ? edicao.paiId : null },
  });
  const [erro, setErro] = useState<string | null>(null);
  // Pai possível: fora da própria subárvore.
  const pais = nos
    .filter((n) => !no || (n.id !== no.id && !n.caminhoNomes.startsWith(`${no.caminhoNomes} > `)))
    .filter((n) => n.nivel < PROFUNDIDADE_MAXIMA_CATEGORIAS)
    .map((n) => ({ value: n.id, label: n.caminhoNomes }));

  const gravar = useMutation({
    mutationFn: async (v: Valores) => {
      const corpo = { ...v, ordem: Number(v.ordem || 0), cor: v.cor || null };
      if (!no) return apiErp.post<CategoriaNo>('/categorias', corpo);
      const { categoriaPaiId, ...dados } = corpo;
      let atual = no;
      if ((categoriaPaiId ?? null) !== no.categoriaPaiId) {
        atual = await apiErp.post<CategoriaNo>(`/categorias/${no.id}/mover`, {
          versao: no.versao,
          categoriaPaiId,
        });
      }
      return apiErp.put<CategoriaNo>(`/categorias/${no.id}`, { ...dados, versao: atual.versao });
    },
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: 'Categoria gravada' });
      aoGravar(r);
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
      ordem: Number(v.ordem || 0),
      cor: v.cor || null,
      ...(no ? { versao: no.versao } : {}),
    };
    const r = no ? alterarCategoriaSchema.safeParse(corpo) : criarCategoriaSchema.safeParse(corpo);
    if (!r.success) return form.setErrors(errosDoZod(r.error));
    setErro(null);
    gravar.mutate(v);
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Title order={4} size="h5">
          {no ? `Configurar: ${no.caminhoNomes}` : 'Nova categoria'}
        </Title>
        <fieldset disabled={somenteLeitura} style={{ border: 0, padding: 0, margin: 0 }}>
          <Stack gap="sm">
            <TextInput label="Nome" required maxLength={60} {...form.getInputProps('nome')} data-autofocus />
            <Select
              label="Categoria pai"
              placeholder="Departamentos (raiz)"
              clearable
              searchable
              data={pais}
              {...form.getInputProps('categoriaPaiId')}
            />
            <Group grow>
              <NumberInput label="Ordem" min={0} allowDecimal={false} {...form.getInputProps('ordem')} />
              <ColorInput label="Cor (botão no PDV)" format="hex" {...form.getInputProps('cor')} />
            </Group>
            <Switch label="Ativa" {...form.getInputProps('ativa', { type: 'checkbox' })} />
            <Switch
              label="Aparece no cardápio do PDV"
              {...form.getInputProps('exibePdv', { type: 'checkbox' })}
            />
            <Switch
              label="Exibe no menu digital"
              {...form.getInputProps('exibeMenuDigital', { type: 'checkbox' })}
            />
            <Switch label="Exibe no totem" {...form.getInputProps('exibeTotem', { type: 'checkbox' })} />
            <Switch label="Exibe no site" {...form.getInputProps('exibeSite', { type: 'checkbox' })} />
          </Stack>
        </fieldset>
        {erro && <Alert color="red">{erro}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Fechar
          </Button>
          {!somenteLeitura && (
            <Button loading={gravar.isPending} onClick={salvar}>
              Gravar
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
