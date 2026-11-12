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
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconFolder,
  IconGripVertical,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { tiposELimiteArquivo, UploadArquivo } from '../../componentes/campos/UploadArquivo';
import { errosDaApi, errosDoZod } from '../../util/erros';
import { irmasNaOrdem, planejarSoltura, type PlanoSoltura, type PosicaoSoltura } from './soltura';

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
  imagemArquivoId: string | null;
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
  imagemArquivoId: null,
};

type Edicao = { modo: 'nova'; paiId: string | null } | { modo: 'editar'; no: CategoriaNo };

/**
 * As versões que as solturas desta tela deram a cada categoria: id → (versão antes → versão depois). O painel aberto
 * usa para saber se a versão nova da árvore veio só da soltura daqui (que muda só a ordem e o pai) ou de outra gravação.
 */
type VersoesDaSoltura = ReadonlyMap<string, ReadonlyMap<number, number>>;

/** Os valores do formulário a partir da categoria gravada. */
function valoresDe(no: CategoriaNo): Valores {
  return {
    nome: no.nome,
    categoriaPaiId: no.categoriaPaiId,
    ordem: no.ordem,
    ativa: no.ativa,
    exibePdv: no.exibePdv,
    exibeMenuDigital: no.exibeMenuDigital,
    exibeTotem: no.exibeTotem,
    exibeSite: no.exibeSite,
    cor: no.cor ?? '',
    imagemArquivoId: no.imagemArquivoId,
  };
}

/** Os campos em que o formulário difere da versão em que se baseia (o que a pessoa digitou e ainda não gravou). */
function camposAlterados(v: Valores, base: Valores): (keyof Valores)[] {
  return (Object.keys(base) as (keyof Valores)[]).filter((k) => String(v[k] ?? '') !== String(base[k] ?? ''));
}

/** Nós que casam com a busca e os ancestrais deles (para expandir até o resultado). */
function filtrarArvore(nos: CategoriaArvore[], termo: string): CategoriaArvore[] {
  if (!termo) return nos;
  const t = termo.toLowerCase();
  return nos
    .map((n) => ({ ...n, filhas: filtrarArvore(n.filhas, termo) }))
    .filter((n) => n.nome.toLowerCase().includes(t) || n.filhas.length > 0);
}

/** O alvo da soltura em destaque enquanto se arrasta. */
type Alvo = { id: string; posicao: PosicaoSoltura };

/**
 * Produtos › Categorias (ERP 8.4): árvore com raiz "Departamentos", adicionar, configurar, mover e excluir. **Arrastar
 * e soltar** (F2-B44; README do ERP › decisão 78): soltar sobre uma categoria a põe dentro dela (no fim); na faixa
 * entre duas, reordena (e muda o pai, se a faixa é de outro nível). "Subir"/"Descer" no ⋮ fazem o mesmo pelo teclado.
 * Com a busca preenchida não se arrasta (a árvore filtrada esconde irmãs).
 */
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
  // O painel aberto recebe a versão mais nova da árvore recarregada (o arrastar dá versão nova à categoria); é ele que
  // decide se a adota (sem nada digitado, ou só a soltura daqui no meio) ou avisa e mantém a edição (PainelCategoria).
  const naArvore = edicao?.modo === 'editar' ? arvore.data?.find((n) => n.id === edicao.no.id) : undefined;
  const edicaoAtual: Edicao | null =
    edicao?.modo === 'editar' && naArvore && naArvore.versao > edicao.no.versao
      ? { modo: 'editar', no: naArvore }
      : edicao;
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<Alvo | null>(null);
  const [versoesDaSoltura, setVersoesDaSoltura] = useState<VersoesDaSoltura>(new Map());
  const podeArrastar = podeEditar && !busca.trim();

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

  /**
   * Grava a soltura: o mover (o pai novo) e depois o reordenar (as irmãs do pai novo, com a versão que o mover
   * devolveu para a arrastada). Os dois são transações separadas: se o reordenar der 409 (outro usuário mexeu nas
   * irmãs), a categoria fica no pai novo, a árvore recarrega e a mensagem pede para soltar de novo.
   */
  const soltura = useMutation({
    mutationFn: async ({ id, plano }: { id: string; plano: PlanoSoltura }) => {
      const nos = new Map((arvore.data ?? []).map((n) => [n.id, n]));
      // Anota cada versão que a soltura deu (antes → depois), assim que a gravação volta (vale mesmo se o passo
      // seguinte der 409).
      const anotar = (pares: [string, number, number][]) =>
        setVersoesDaSoltura((atual) => {
          const novo = new Map(atual);
          for (const [x, antes, depois] of pares)
            if (depois !== antes) novo.set(x, new Map(novo.get(x)).set(antes, depois));
          return novo;
        });
      let versao = nos.get(id)!.versao;
      if (plano.mover) {
        const r = await apiErp.post<CategoriaNo>(`/categorias/${id}/mover`, { versao, ...plano.mover });
        anotar([[id, versao, r.versao]]);
        versao = r.versao;
      }
      if (plano.reordenar) {
        const itens = plano.reordenar.ids.map((x) => ({
          id: x,
          versao: x === id ? versao : nos.get(x)!.versao,
        }));
        const r = await apiErp.post<CategoriaNo[]>('/categorias/reordenar', {
          categoriaPaiId: plano.reordenar.categoriaPaiId,
          itens,
        });
        const depois = new Map(r.map((n) => [n.id, n.versao]));
        anotar(itens.map((i) => [i.id, i.versao, depois.get(i.id) ?? i.versao]));
      }
      return plano;
    },
    onSuccess: (plano) => {
      const pai = plano.mover?.categoriaPaiId ?? plano.reordenar?.categoriaPaiId ?? null;
      if (pai) setAbertas((s) => new Set(s).add(pai));
      notifications.show({ color: 'green', message: plano.mover ? 'Categoria movida' : 'Ordem gravada' });
    },
    onError: (e) => notifications.show({ color: 'red', message: (e as Error).message }),
    onSettled: () => void recarregar(),
  });

  function aplicar(id: string, alvoId: string, posicao: PosicaoSoltura) {
    const plano = planejarSoltura(arvore.data ?? [], id, alvoId, posicao);
    if (!plano) return;
    if ('erro' in plano) {
      notifications.show({ color: 'red', message: plano.erro });
      return;
    }
    soltura.mutate({ id, plano });
  }

  /** Subir/Descer no ⋮: antes da irmã anterior ou depois da próxima. */
  function deslocar(no: CategoriaNo, sentido: -1 | 1) {
    const irmas = irmasNaOrdem(arvore.data ?? [], no.categoriaPaiId);
    const vizinha = irmas[irmas.findIndex((n) => n.id === no.id) + sentido];
    if (vizinha) aplicar(no.id, vizinha.id, sentido < 0 ? 'antes' : 'depois');
  }

  const sobre = (id: string, posicao: PosicaoSoltura) => (e: DragEvent) => {
    if (!arrastando || arrastando === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (alvo?.id !== id || alvo.posicao !== posicao) setAlvo({ id, posicao });
  };
  const soltar = (id: string, posicao: PosicaoSoltura) => (e: DragEvent) => {
    e.preventDefault();
    const arrastado = arrastando ?? e.dataTransfer.getData('text/plain');
    setArrastando(null);
    setAlvo(null);
    if (arrastado && !soltura.isPending) aplicar(arrastado, id, posicao);
  };
  /** A faixa entre duas categorias (antes de `no`, ou depois dele no fim da lista), só enquanto se arrasta. */
  const faixa = (no: CategoriaNo, posicao: 'antes' | 'depois') =>
    arrastando ? (
      <Box
        h={8}
        data-testid={`soltar-${posicao}-${no.nome}`}
        onDragOver={sobre(no.id, posicao)}
        onDrop={soltar(no.id, posicao)}
        style={{
          borderRadius: 2,
          background:
            alvo?.id === no.id && alvo.posicao === posicao ? 'var(--mantine-color-blue-filled)' : undefined,
        }}
      />
    ) : null;

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
    nos.map((no, i) => {
      const aberta = abertas.has(no.id) || !!busca.trim();
      const dentro = alvo?.id === no.id && alvo.posicao === 'dentro';
      return (
        <Box key={no.id} pl={no.nivel > 1 ? 'md' : 0}>
          {faixa(no, 'antes')}
          <Group
            gap={4}
            wrap="nowrap"
            data-testid={`categoria-${no.nome}`}
            draggable={podeArrastar && !soltura.isPending}
            onDragStart={(e) => {
              if (!podeArrastar || soltura.isPending) {
                e.preventDefault();
                return;
              }
              e.dataTransfer.setData('text/plain', no.id);
              e.dataTransfer.effectAllowed = 'move';
              setArrastando(no.id);
            }}
            onDragEnd={() => {
              setArrastando(null);
              setAlvo(null);
            }}
            onDragOver={sobre(no.id, 'dentro')}
            onDrop={soltar(no.id, 'dentro')}
            style={{
              borderRadius: 4,
              opacity: arrastando === no.id ? 0.5 : undefined,
              outline: dentro ? '2px solid var(--mantine-color-blue-filled)' : undefined,
            }}
          >
            {podeArrastar && (
              <IconGripVertical size={14} color="var(--mantine-color-dimmed)" style={{ cursor: 'grab' }} />
            )}
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
                    leftSection={<IconArrowUp size={14} />}
                    disabled={i === 0 || !!busca.trim()}
                    onClick={() => deslocar(no, -1)}
                  >
                    Subir
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArrowDown size={14} />}
                    disabled={i === nos.length - 1 || !!busca.trim()}
                    onClick={() => deslocar(no, 1)}
                  >
                    Descer
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
          {i === nos.length - 1 && faixa(no, 'depois')}
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
          {edicaoAtual ? (
            <PainelCategoria
              key={edicaoAtual.modo === 'editar' ? edicaoAtual.no.id : `nova-${edicaoAtual.paiId}`}
              edicao={edicaoAtual}
              nos={arvore.data ?? []}
              versoesDaSoltura={versoesDaSoltura}
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
              {podeEditar &&
                ' Arraste uma categoria para dentro de outra, ou para a faixa entre duas para mudar a ordem.'}
            </Text>
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

/**
 * O painel de configurar/criar a categoria. Montado por categoria (a `key` é o id): quando a árvore recarrega com uma
 * versão mais nova dela (`edicao.no`), o painel só a adota se nada foi digitado, ou se a versão nova veio só da soltura
 * desta tela a partir da versão do formulário (aí leva a ordem e o pai novos e mantém o que foi digitado). Com algo
 * digitado e a categoria gravada em outro lugar, mantém a edição e avisa: o Gravar dá o 409 com quem alterou, e
 * "Descartar e carregar a versão nova" troca o formulário pela versão da árvore.
 */
function PainelCategoria({
  edicao,
  nos,
  versoesDaSoltura,
  somenteLeitura,
  fechar,
  aoGravar,
}: {
  edicao: Edicao;
  nos: CategoriaNo[];
  versoesDaSoltura: VersoesDaSoltura;
  somenteLeitura: boolean;
  fechar: () => void;
  aoGravar: (no: CategoriaNo) => void;
}) {
  const no = edicao.modo === 'editar' ? edicao.no : null;
  // A versão em que o formulário se baseia (a que o Gravar manda); `no` é a mais nova que a árvore conhece.
  const [base, setBase] = useState<CategoriaNo | null>(no);
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: no
      ? valoresDe(no)
      : { ...VAZIO, categoriaPaiId: edicao.modo === 'nova' ? edicao.paiId : null },
  });
  const [erro, setErro] = useState<string | null>(null);
  const defasada = !!no && !!base && no.versao > base.versao;

  /** Troca o formulário pela versão `nova`, mantendo os campos de `manter` com o que foi digitado. */
  function adotar(nova: CategoriaNo, manter: (keyof Valores)[] = []) {
    const atuais = form.getValues();
    const valores = valoresDe(nova);
    for (const k of manter) (valores as unknown as Record<string, unknown>)[k] = atuais[k];
    form.setValues(valores);
    setBase(nova);
    setErro(null);
  }

  // Sincroniza com a árvore que o react-query recarregou (fora do React): o setState aqui é a resposta a ela.
  useEffect(() => {
    if (!no || !base || no.versao <= base.versao) return;
    const alterados = camposAlterados(form.getValues(), valoresDe(base));
    // Segue as versões que a soltura daqui deu, a partir da do formulário: chegou à da árvore, só ela mexeu.
    const transicoes = versoesDaSoltura.get(no.id);
    let v = base.versao;
    while (transicoes?.has(v)) v = transicoes.get(v)!;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!alterados.length) adotar(no);
    else if (v === no.versao) adotar(no, alterados);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [no?.versao]);

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
      let atual = base ?? no;
      if ((categoriaPaiId ?? null) !== atual.categoriaPaiId) {
        atual = await apiErp.post<CategoriaNo>(`/categorias/${no.id}/mover`, {
          versao: atual.versao,
          categoriaPaiId,
        });
      }
      return apiErp.put<CategoriaNo>(`/categorias/${no.id}`, { ...dados, versao: atual.versao });
    },
    onSuccess: (r) => {
      notifications.show({ color: 'green', message: 'Categoria gravada' });
      if (no) adotar(r);
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
      ...(no ? { versao: (base ?? no).versao } : {}),
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
        <UploadArquivo
          rotulo="Imagem"
          descricao={`${tiposELimiteArquivo('categoria_imagem')} (menu digital, totem e site)`}
          destino="categoria_imagem"
          valor={form.getValues().imagemArquivoId}
          aoMudar={(id) => form.setFieldValue('imagemArquivoId', id)}
          somenteLeitura={somenteLeitura}
          erro={form.errors.imagemArquivoId as string | undefined}
        />
        {defasada && (
          <Alert color="yellow" data-testid="categoria-defasada">
            <Stack gap="xs">
              <Text size="sm">
                Esta categoria foi alterada (em outra tela ou por outro usuário) depois que você abriu o
                painel. O que você digitou continua aqui, mas o Gravar vai recusar com o nome de quem alterou.
              </Text>
              <Group>
                <Button size="xs" variant="default" onClick={() => no && adotar(no)}>
                  Descartar e carregar a versão nova
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
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
