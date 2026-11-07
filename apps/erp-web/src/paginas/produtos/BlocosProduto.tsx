/**
 * Blocos do formulário do produto que dependem só do motor existente (Fase 2, F2-B12; ERP 8.2.7, 8.2.8, 8.2.11):
 * categorias em árvore com a principal pela estrela e "Nova categoria", produtos relacionados com a relação inversa e
 * o modal "Ajustar" do bloco Estoque (um "Definir" de um item, origem `cadastro_produto`). E o bloco Fornecedores
 * (F2-B13; ERP 8.2.14), com o cadastro rápido de fornecedor no seletor, e o bloco Validade com os lotes e o saldo de
 * cada lote (F2-B17; ERP 8.2.12).
 */
import {
  MOTIVOS_ACERTO,
  PROFUNDIDADE_MAXIMA_CATEGORIAS,
  ROTULOS_TIPO_RELACAO,
  TIPOS_RELACAO_PRODUTO,
  ajusteEstoqueProdutoSchema,
  criarCategoriaSchema,
  type AjusteEstoqueProduto,
  markupPct,
  montarArvoreCategorias,
  type CategoriaArvore,
  type CategoriaNo,
  type EstoqueResumo,
  type Pagina,
  type PessoaOpcao,
  type ProdutoOpcao,
  type ResultadoAjusteProduto,
  type SaldosProduto,
  type TipoEstoqueOpcao,
  type TipoRelacaoProduto,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { type UseFormReturnType } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronRight,
  IconCurrencyReal,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { useCategorias } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { CampoData, CampoDataHora } from '../../componentes/campos/CamposData';
import { SeletorPessoa } from '../../componentes/seletores/SeletorPessoa';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { errosDaApi, errosDoZod } from '../../util/erros';
import { formatarData } from '../../util/formato';
import { decimalParaTela, novaChave, numero, type ValoresProduto } from './valores';

type Form = UseFormReturnType<ValoresProduto>;

// ---------------------------------------------------------------- Categorias (8.2.7)

/** Nós que casam com a busca e os ancestrais deles (a busca abre o caminho até o resultado). */
function filtrarArvore(nos: CategoriaArvore[], termo: string): CategoriaArvore[] {
  return nos
    .map((n) => ({ ...n, filhas: filtrarArvore(n.filhas, termo) }))
    .filter((n) => n.nome.toLowerCase().includes(termo) || n.filhas.length > 0);
}

/**
 * Árvore de categorias com checkboxes (N:N), a estrela para a principal e "Nova categoria" em modal (ERP 8.2.7). A
 * primeira marcada vira a principal; desmarcar a principal passa a estrela à próxima marcada. Abre já expandido até
 * as categorias marcadas.
 */
export function BlocoCategorias({ form }: { form: Form }) {
  const categorias = useCategorias();
  const pode = usePode();
  const [busca, setBusca] = useState('');
  const [abertos, setAbertos] = useState<Set<string> | null>(null);
  const [nova, setNova] = useState(false);
  const v = form.getValues();
  const nos = useMemo(() => categorias.data ?? [], [categorias.data]);
  const arvore = useMemo(() => montarArvoreCategorias(nos), [nos]);
  const porId = useMemo(() => new Map(nos.map((n) => [n.id, n])), [nos]);
  const ancestrais = (id: string) => {
    const r: string[] = [];
    for (let n = porId.get(id); n?.categoriaPaiId; n = porId.get(n.categoriaPaiId)) r.push(n.categoriaPaiId);
    return r;
  };
  const expandidos = abertos ?? new Set(v.categorias.flatMap(ancestrais));
  const termo = busca.trim().toLowerCase();
  const visiveis = termo ? filtrarArvore(arvore, termo) : arvore;
  const principal = v.categoriaPrincipalId || v.categorias[0] || null;

  const marcar = (id: string, marcado: boolean) => {
    const atuais = form.getValues().categorias;
    const ids = marcado ? [...new Set([...atuais, id])] : atuais.filter((x) => x !== id);
    form.setFieldValue('categorias', ids);
    const p = form.getValues().categoriaPrincipalId;
    if (!p || !ids.includes(p)) form.setFieldValue('categoriaPrincipalId', ids[0] ?? null);
  };
  const alternar = (id: string) =>
    setAbertos(() => {
      const s = new Set(expandidos);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const renderizar = (lista: CategoriaArvore[], nivel: number) =>
    lista.map((n) => {
      const marcado = v.categorias.includes(n.id);
      const aberto = !!termo || expandidos.has(n.id);
      const ehPrincipal = principal === n.id;
      return (
        <Box key={n.id}>
          <Group gap={4} wrap="nowrap" pl={nivel * 20} py={2}>
            {n.filhas.length ? (
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`${aberto ? 'Recolher' : 'Expandir'} ${n.nome}`}
                onClick={() => alternar(n.id)}
              >
                {aberto ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              </ActionIcon>
            ) : (
              <Box w={22} />
            )}
            <Checkbox
              size="sm"
              label={n.nome}
              checked={marcado}
              onChange={(e) => marcar(n.id, e.currentTarget.checked)}
            />
            {!n.ativa && (
              <Badge size="xs" color="gray" variant="light">
                inativa
              </Badge>
            )}
            {marcado && (
              <Tooltip label={ehPrincipal ? 'Categoria principal' : 'Tornar principal'}>
                <ActionIcon
                  variant="subtle"
                  color="yellow"
                  size="sm"
                  aria-label={`Principal: ${n.nome}`}
                  aria-pressed={ehPrincipal}
                  onClick={() => form.setFieldValue('categoriaPrincipalId', n.id)}
                >
                  {ehPrincipal ? <IconStarFilled size={14} /> : <IconStar size={14} />}
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
          {aberto && n.filhas.length > 0 && renderizar(n.filhas, nivel + 1)}
        </Box>
      );
    });

  const erro = form.errors.categorias ?? form.errors.categoriaPrincipalId;
  const nomePrincipal = principal ? porId.get(principal)?.caminhoNomes.replace(/ > /g, ' › ') : null;
  return (
    <Stack gap="xs" data-testid="arvore-categorias">
      <Group justify="space-between" wrap="nowrap">
        <TextInput
          placeholder="Buscar categoria"
          aria-label="Buscar categoria"
          leftSection={<IconSearch size={14} />}
          value={busca}
          onChange={(e) => setBusca(e.currentTarget.value)}
          style={{ flex: 1, maxWidth: 320 }}
        />
        {pode('categorias.editar') && (
          <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setNova(true)}>
            Nova categoria
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        A primeira categoria marcada é a principal (relatórios e cardápio do PDV); troque pela estrela.
        {nomePrincipal ? ` Principal: ${nomePrincipal}.` : ''}
      </Text>
      {erro && (
        <Text size="xs" c="red">
          {String(erro)}
        </Text>
      )}
      {categorias.isPending && pode('categorias.ver') ? (
        <Text size="sm">Carregando…</Text>
      ) : !nos.length ? (
        <Text size="sm" c="dimmed">
          {pode('categorias.ver') ? 'Nenhuma categoria cadastrada.' : 'Sem acesso às categorias.'}
        </Text>
      ) : (
        <ScrollArea.Autosize mah={360} type="auto">
          {visiveis.length ? (
            renderizar(visiveis, 0)
          ) : (
            <Text size="sm" c="dimmed">
              Nenhuma categoria encontrada.
            </Text>
          )}
        </ScrollArea.Autosize>
      )}
      <ModalNovaCategoria
        aberto={nova}
        categorias={nos}
        aoFechar={() => setNova(false)}
        aoCriar={(c) => {
          setNova(false);
          marcar(c.id, true);
          // Abre o caminho até a nova (o pai e os ancestrais dele).
          const caminho = c.categoriaPaiId ? [c.categoriaPaiId, ...ancestrais(c.categoriaPaiId)] : [];
          setAbertos(new Set([...expandidos, ...caminho]));
        }}
      />
    </Stack>
  );
}

/** "Nova categoria" (ERP 8.2.7): nome e categoria pai; criada pela mesma API da tela de categorias (8.4). */
function ModalNovaCategoria({
  aberto,
  categorias,
  aoFechar,
  aoCriar,
}: {
  aberto: boolean;
  categorias: readonly CategoriaNo[];
  aoFechar: () => void;
  aoCriar: (c: CategoriaNo) => void;
}) {
  const cliente = useQueryClient();
  const [nome, setNome] = useState('');
  const [pai, setPai] = useState<string | null>(null);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [salvando, setSalvando] = useState(false);
  const opcoesPai = categorias
    .filter((c) => c.nivel < PROFUNDIDADE_MAXIMA_CATEGORIAS)
    .map((c) => ({ value: c.id, label: c.caminhoNomes.replace(/ > /g, ' › ') }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  const fechar = () => {
    setNome('');
    setPai(null);
    setErros({});
    aoFechar();
  };
  const criar = async () => {
    const r = criarCategoriaSchema.safeParse({ nome, categoriaPaiId: pai });
    if (!r.success) return setErros(errosDoZod(r.error));
    setSalvando(true);
    try {
      const c = await apiErp.post<CategoriaNo>('/categorias', r.data);
      await cliente.invalidateQueries({ queryKey: ['opcoes', 'categorias'] });
      setNome('');
      setPai(null);
      setErros({});
      aoCriar(c);
    } catch (e) {
      setErros(
        e instanceof ErroRequisicao
          ? { _: e.message, ...errosDaApi(e.corpo.campos) }
          : { _: (e as Error).message },
      );
    } finally {
      setSalvando(false);
    }
  };
  return (
    <Modal opened={aberto} onClose={fechar} title="Nova categoria">
      <Stack>
        {erros._ && <Alert color="red">{erros._}</Alert>}
        <TextInput
          label="Nome"
          required
          maxLength={60}
          data-autofocus
          value={nome}
          error={erros.nome}
          onChange={(e) => setNome(e.currentTarget.value)}
        />
        <Select
          label="Categoria pai"
          description="Vazio = departamento (raiz)"
          searchable
          clearable
          data={opcoesPai}
          value={pai}
          error={erros.categoriaPaiId}
          onChange={setPai}
          comboboxProps={{ withinPortal: true }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            Cancelar
          </Button>
          <Button loading={salvando} onClick={() => void criar()}>
            Criar e marcar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- Relacionados (8.2.8)

/**
 * Produtos relacionados (ERP 8.2.8): Inserir/Remover, o tipo por linha e "Criar relação inversa". A relação vale só
 * neste sentido; a inversa é gravada no outro produto ao gravar este, e remover daqui não a remove. A inversa altera o
 * cadastro do outro produto: só aparece para quem tem `produtos.editar` (a API recusa sem ela).
 */
export function BlocoRelacionados({ form, produtoId }: { form: Form; produtoId: string | null }) {
  const v = form.getValues();
  const pode = usePode();
  const podeInversa = pode('produtos.editar');
  const [produto, setProduto] = useState<ProdutoOpcao | null>(null);
  const [tipo, setTipo] = useState<TipoRelacaoProduto>('sugestao');
  const [inversa, setInversa] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const opcoesTipo = TIPOS_RELACAO_PRODUTO.map((t) => ({ value: t, label: ROTULOS_TIPO_RELACAO[t] }));
  const inserir = () => {
    if (!produto) return setAviso('Escolha o produto');
    if (v.relacionados.some((r) => r.relacionadoId === produto.id && r.tipo === tipo))
      return setAviso(`${produto.nome} já está na lista como ${ROTULOS_TIPO_RELACAO[tipo]}`);
    form.insertListItem('relacionados', {
      chave: novaChave(),
      id: null,
      relacionadoId: produto.id,
      produto,
      tipo,
      tipoGravado: null,
      criarInversa: podeInversa && inversa,
      inversa: false,
    });
    setProduto(null);
    setInversa(false);
    setAviso(null);
  };
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Sugestão no PDV (“leve também gelo”) e no e-commerce. A relação vale só neste sentido: marque “Criar
        relação inversa” para o outro produto também apontar para este. Remover daqui não remove a do outro
        produto.
      </Text>
      <Group align="flex-end" wrap="wrap">
        <SeletorProduto
          label="Produto relacionado"
          value={produto?.id ?? null}
          produto={produto}
          excluir={produtoId ? [produtoId] : []}
          onChange={(_, p) => {
            setProduto(p);
            setAviso(null);
          }}
          error={aviso}
          style={{ flex: 1, minWidth: 240 }}
        />
        <Select
          label="Tipo"
          allowDeselect={false}
          data={opcoesTipo}
          value={tipo}
          onChange={(t) => setTipo((t as TipoRelacaoProduto | null) ?? 'sugestao')}
          w={150}
        />
        {podeInversa && (
          <Checkbox
            label="Criar relação inversa"
            checked={inversa}
            onChange={(e) => setInversa(e.currentTarget.checked)}
            mb={8}
          />
        )}
        <Button variant="default" leftSection={<IconPlus size={16} />} onClick={inserir}>
          Inserir
        </Button>
      </Group>
      {/* Erro da lista inteira (o teto de relacionados do zod), que não cai em nenhuma linha. */}
      {form.errors.relacionados && (
        <Text size="xs" c="red">
          {String(form.errors.relacionados)}
        </Text>
      )}
      {v.relacionados.length > 0 && (
        <Table data-testid="relacionados">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Produto</Table.Th>
              <Table.Th>Tipo</Table.Th>
              <Table.Th>Outro sentido</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {v.relacionados.map((r, i) => (
              <Table.Tr key={r.chave}>
                <Table.Td>
                  <Text size="sm">
                    {r.produto.codigo} - {r.produto.nome}{' '}
                    {!r.produto.ativo && (
                      <Badge size="xs" color="gray" variant="light">
                        inativo
                      </Badge>
                    )}
                  </Text>
                  {form.errors[`relacionados.${i}.relacionadoId`] && (
                    <Text size="xs" c="red">
                      {String(form.errors[`relacionados.${i}.relacionadoId`])}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Select
                    aria-label={`Tipo ${r.produto.nome}`}
                    allowDeselect={false}
                    data={opcoesTipo}
                    w={150}
                    {...form.getInputProps(`relacionados.${i}.tipo`)}
                  />
                </Table.Td>
                <Table.Td>
                  {/* A inversa do detalhe é do tipo gravado: com o tipo trocado, ela não vale para a linha nova. */}
                  {r.inversa && r.tipo === r.tipoGravado ? (
                    <Badge color="teal" variant="light">
                      Nos dois sentidos
                    </Badge>
                  ) : podeInversa ? (
                    <Checkbox
                      label="Criar relação inversa"
                      {...form.getInputProps(`relacionados.${i}.criarInversa`, { type: 'checkbox' })}
                    />
                  ) : (
                    <Text size="xs" c="dimmed">
                      Só neste sentido
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Remover ${r.produto.nome}`}
                    onClick={() => form.removeListItem('relacionados', i)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------- Ajustar (8.2.11)

/** Data e hora local do campo (`AAAA-MM-DDTHH:mm`, CampoDataHora). */
function agoraLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * "Ajustar" (ERP 8.2.11; F2-B12): estoque permitido, tipo de estoque, nova quantidade, motivo e hora da contagem
 * (padrão: agora). Gera e efetiva na hora um "Definir" de um item com a origem `cadastro_produto` (AJUSTE_CADASTRO),
 * com as regras do acerto (diferença na hora da contagem, saldo negativo, compensação das vendas tardias).
 *
 * O modal fica montado dentro do bloco Estoque (só `aberto` muda): a hora é renovada a cada abertura e, se o usuário
 * não mexer nela, o corpo vai **sem** `dataContagem`, e a API usa o instante da requisição. Mandar a hora da tela
 * (cortada no minuto, ou a da abertura) faria as vendas feitas entre ela e o clique serem descontadas da contagem.
 *
 * O modal de ajuste do relatório Estoque Atual (ERP 16.4; F2-B31; README do ERP › decisão 66) é este mesmo, com o
 * estoque da linha fixo (`estoqueFixo`), o tipo da linha, o nome do produto e o envio para
 * `POST /relatorios/estoque-atual/ajustar` (origem `relatorio_estoque`, AJUSTE_RELATORIO): o núcleo do "Definir" é
 * um só, na tela e na API.
 */
export function ModalAjustarEstoque({
  aberto,
  produtoId,
  saldos,
  aoFechar,
  estoqueFixo,
  tipoInicial,
  nomeProduto,
  enviar,
  aoAjustar,
  titulo = 'Ajustar estoque',
  rotuloGravar = 'Ajustar',
  rotuloFechar = 'Cancelar',
}: {
  aberto: boolean;
  produtoId: string;
  saldos: ReadonlyArray<Pick<SaldosProduto['saldos'][number], 'estoqueId' | 'tipoEstoqueId' | 'quantidade'>>;
  aoFechar: () => void;
  /** Estoque fixo (o da linha do relatório): sem o seletor. */
  estoqueFixo?: { id: string; nome: string };
  /**
   * Tipo de estoque ao abrir (padrão: o tipo padrão, Disponível). Se ele estiver inativo, o modal avisa e pede o tipo
   * (não troca calado pelo padrão: o ajuste e o "Saldo atual" seriam de outro tipo que não o da linha clicada).
   */
  tipoInicial?: string | null;
  /** Nome do produto no topo do modal (o relatório; no formulário o produto já está na tela). */
  nomeProduto?: string;
  /** Envio do ajuste (padrão: o "Ajustar" do produto, `POST /produtos/:id/ajustar-estoque`). */
  enviar?: (corpo: AjusteEstoqueProduto) => Promise<ResultadoAjusteProduto>;
  /** Depois de gravar (padrão: recarrega os saldos do produto). */
  aoAjustar?: (r: ResultadoAjusteProduto) => Promise<unknown> | void;
  titulo?: string;
  rotuloGravar?: string;
  rotuloFechar?: string;
}) {
  const cliente = useQueryClient();
  const estoques = useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    staleTime: 60_000,
    enabled: aberto && !estoqueFixo,
  });
  const tipos = useQuery({
    queryKey: ['opcoes', 'tipos-estoque'],
    queryFn: () => apiErp.get<TipoEstoqueOpcao[]>('/tipos-estoque'),
    staleTime: 5 * 60_000,
    enabled: aberto,
  });
  const [estoqueId, setEstoqueId] = useState<string | null>(null);
  const [tipoId, setTipoId] = useState<string | null>(null);
  const [quantidade, setQuantidade] = useState('');
  const [motivo, setMotivo] = useState('');
  const [dataContagem, setDataContagem] = useState(agoraLocal);
  const [horaAlterada, setHoraAlterada] = useState(false);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [salvando, setSalvando] = useState(false);
  // Cada abertura começa em "agora" (o estado sobrevive ao fechar, porque o componente não desmonta): ajuste do
  // estado no próprio render quando `aberto` muda, sem efeito (react.dev, "You might not need an effect").
  const [abertoAntes, setAbertoAntes] = useState(aberto);
  if (aberto !== abertoAntes) {
    setAbertoAntes(aberto);
    if (aberto) {
      setDataContagem(agoraLocal());
      setHoraAlterada(false);
    }
  }
  const listaEstoques = estoques.data?.itens ?? [];
  const tiposAtivos = (tipos.data ?? []).filter((t) => t.ativo);
  // Padrões: o estoque fixo, ou o do primeiro saldo que está entre as opções (os saldos trazem também estoque
  // inativo, que o Select não lista e a API recusa), ou o único permitido; e o tipo inicial (ativo) ou o padrão. O
  // tipo inicial inativo não cai no padrão: fica sem tipo até o usuário escolher.
  const tipoInicialInativo =
    !!tipoInicial && tipos.isSuccess && !tiposAtivos.some((t) => t.id === tipoInicial);
  const estoque =
    estoqueFixo?.id ??
    estoqueId ??
    saldos.find((s) => listaEstoques.some((e) => e.id === s.estoqueId))?.estoqueId ??
    (listaEstoques.length === 1 ? listaEstoques[0]!.id : null);
  const tipo =
    tipoId ??
    (tipoInicial && tiposAtivos.some((t) => t.id === tipoInicial) ? tipoInicial : null) ??
    (tipoInicialInativo ? null : tiposAtivos.find((t) => t.padrao)?.id) ??
    null;
  const atual = saldos.find((s) => s.estoqueId === estoque && s.tipoEstoqueId === tipo)?.quantidade ?? '0';
  const fechar = () => {
    setEstoqueId(null);
    setTipoId(null);
    setQuantidade('');
    setMotivo('');
    setHoraAlterada(false);
    setErros({});
    aoFechar();
  };
  const ajustar = async () => {
    // Sem tipo, a API usaria o padrão: com o da linha inativo, o tipo tem de ser escolhido.
    if (tipoInicialInativo && !tipo) return setErros({ tipoEstoqueId: 'Escolha o tipo de estoque' });
    const data = new Date(dataContagem);
    const r = ajusteEstoqueProdutoSchema.safeParse({
      estoqueId: estoque ?? '',
      tipoEstoqueId: tipo,
      quantidade,
      motivo,
      // Sem mexer na hora, vai vazio: "agora" é o instante em que a API recebe (não o da abertura do modal).
      dataContagem: !horaAlterada
        ? undefined
        : Number.isNaN(data.getTime())
          ? dataContagem
          : data.toISOString(),
    });
    if (!r.success) return setErros(errosDoZod(r.error));
    setSalvando(true);
    try {
      const res = enviar
        ? await enviar(r.data)
        : await apiErp.post<ResultadoAjusteProduto>(`/produtos/${produtoId}/ajustar-estoque`, r.data);
      if (aoAjustar) await aoAjustar(res);
      else await cliente.invalidateQueries({ queryKey: ['produtos', produtoId, 'saldos'] });
      const dif = Number(res.diferenca);
      notifications.show({
        color: 'green',
        message: `Acerto Nº ${res.codigo} efetivado: ${dif > 0 ? '+' : ''}${decimalParaTela(res.diferenca, 3) || '0'} na contagem${res.compensacoes ? ` (${res.compensacoes} compensação(ões) de vendas tardias)` : ''}.`,
      });
      fechar();
    } catch (e) {
      setErros(
        e instanceof ErroRequisicao
          ? { _: e.message, ...errosDaApi(e.corpo.campos) }
          : { _: (e as Error).message },
      );
    } finally {
      setSalvando(false);
    }
  };
  return (
    <Modal opened={aberto} onClose={fechar} title={titulo}>
      <Stack>
        {erros._ && <Alert color="red">{erros._}</Alert>}
        {tipoInicialInativo && (
          <Alert color="yellow" data-testid="tipo-inicial-inativo">
            O tipo de estoque desta linha está inativo e não recebe ajuste: escolha o tipo abaixo.
          </Alert>
        )}
        {nomeProduto && <TextInput label="Produto" value={nomeProduto} readOnly variant="filled" />}
        {estoqueFixo ? (
          <TextInput
            label="Estoque"
            value={estoqueFixo.nome}
            readOnly
            variant="filled"
            error={erros.estoqueId}
          />
        ) : (
          <Select
            label="Estoque"
            required
            allowDeselect={false}
            data={listaEstoques.map((e) => ({ value: e.id, label: e.nome }))}
            value={estoque}
            error={erros.estoqueId}
            onChange={setEstoqueId}
            comboboxProps={{ withinPortal: true }}
          />
        )}
        <Select
          label="Tipo de estoque"
          required
          allowDeselect={false}
          data={tiposAtivos.map((t) => ({
            value: t.id,
            label: t.vendavel ? t.nome : `${t.nome} (não vendável)`,
          }))}
          value={tipo}
          error={erros.tipoEstoqueId}
          onChange={setTipoId}
          comboboxProps={{ withinPortal: true }}
        />
        <Text size="sm" data-testid="saldo-atual-ajuste">
          Saldo atual: <strong>{decimalParaTela(atual, 3) || '0'}</strong>
        </Text>
        <TextInput
          label="Nova quantidade"
          description="A quantidade contada; a diferença é lançada na hora da contagem"
          required
          inputMode="decimal"
          data-autofocus
          value={quantidade}
          error={erros.quantidade}
          onChange={(e) => setQuantidade(e.currentTarget.value)}
        />
        <Autocomplete
          label="Motivo"
          required
          maxLength={120}
          data={[...MOTIVOS_ACERTO]}
          value={motivo}
          error={erros.motivo}
          onChange={setMotivo}
          comboboxProps={{ withinPortal: true }}
        />
        <CampoDataHora
          label="Hora da contagem"
          required
          clearable={false}
          description={horaAlterada ? undefined : 'Sem alterar, vale o instante da gravação'}
          value={dataContagem}
          error={erros.dataContagem}
          onChange={(v) => {
            setDataContagem(v);
            setHoraAlterada(true);
          }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={fechar}>
            {rotuloFechar}
          </Button>
          <Button loading={salvando} onClick={() => void ajustar()}>
            {rotuloGravar}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------- Fornecedores (8.2.14)

/**
 * Bloco Fornecedores (ERP 8.2.14; F2-B13), visível com `geral.produto_usa_fornecedores`: fornecedor (seletor da
 * categoria Fornecedor, com o cadastro rápido), código no fornecedor (o `cProd` da NF-e), EAN, unidade de compra,
 * fator e principal; o custo do fornecedor (D49) só com `produtos.ver_custo`, com "Usar como preço de custo"; o último
 * custo e a última compra só leitura (vêm do recebimento e da NF-e). O código já ligado a outro produto volta da API
 * no campo da linha, com a opção de mover o vínculo para este produto (exige `produtos.editar`).
 */
export function BlocoFornecedores({ form, verCusto }: { form: Form; verCusto: boolean }) {
  const v = form.getValues();
  const pode = usePode();
  const [pessoa, setPessoa] = useState<PessoaOpcao | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const kit = v.tipo === 'kit';
  const inserir = () => {
    if (!pessoa) return setAviso('Escolha o fornecedor');
    form.insertListItem('fornecedores', {
      chave: novaChave(),
      id: null,
      fornecedorId: pessoa.id,
      fornecedor: pessoa,
      codigoFornecedor: '',
      eanFornecedor: '',
      unidadeCompra: '',
      fator: '1',
      custoFornecedor: '',
      // O primeiro vínculo nasce principal.
      principal: v.fornecedores.length === 0,
      moverVinculo: false,
      ultimoCusto: null,
      ultimaCompraEm: null,
    });
    setPessoa(null);
    setAviso(null);
  };
  const marcarPrincipal = (i: number, marcado: boolean) =>
    form.setFieldValue(
      'fornecedores',
      form.getValues().fornecedores.map((f, j) => ({ ...f, principal: marcado && i === j })),
    );
  const usarComoCusto = (custo: string) => {
    form.setFieldValue('precoCusto', custo);
    // Como no Cabeçalho ao mudar o preço: o markup acompanha o custo novo com o preço atual.
    const m = markupPct(numero(custo), numero(form.getValues().precoVenda));
    if (m !== null) form.setFieldValue('markupPct', decimalParaTela(String(m), 4));
    notifications.show({ color: 'blue', message: `Preço de custo: R$ ${custo}` });
  };
  const erroDa = (i: number, campo: string) => form.errors[`fornecedores.${i}.${campo}`];
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        O código no fornecedor e o fator (quantas unidades vêm na unidade de compra, ex.: CX → 24) ligam os
        itens das notas de compra a este produto. Os custos são por unidade do produto.
      </Text>
      <Group align="flex-end" wrap="wrap">
        <SeletorPessoa
          label="Fornecedor"
          categoria="fornecedor"
          value={pessoa?.id ?? null}
          pessoa={pessoa}
          onChange={(_, p) => {
            setPessoa(p);
            setAviso(null);
          }}
          error={aviso}
          style={{ flex: 1, minWidth: 280 }}
        />
        <Button variant="default" leftSection={<IconPlus size={16} />} onClick={inserir}>
          Inserir
        </Button>
      </Group>
      {/* Erro da lista inteira (teto, dois principais), que não cai em nenhuma linha. */}
      {form.errors.fornecedores && (
        <Text size="xs" c="red">
          {String(form.errors.fornecedores)}
        </Text>
      )}
      {v.fornecedores.length > 0 && (
        <ScrollArea>
          <Table data-testid="fornecedores" miw={verCusto ? 980 : 780}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Fornecedor</Table.Th>
                <Table.Th>Código no fornecedor</Table.Th>
                <Table.Th>EAN do fornecedor</Table.Th>
                <Table.Th>Un. compra</Table.Th>
                <Table.Th>Fator</Table.Th>
                {verCusto && <Table.Th>Custo do fornecedor</Table.Th>}
                {verCusto && <Table.Th>Último custo</Table.Th>}
                <Table.Th>Última compra</Table.Th>
                <Table.Th>Principal</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {v.fornecedores.map((f, i) => {
                const conflito = erroDa(i, 'codigoFornecedor');
                const nome = f.fornecedor.apelido || f.fornecedor.nome;
                return (
                  <Table.Tr key={f.chave}>
                    <Table.Td>
                      <Text size="sm">
                        {f.fornecedor.codigo} - {f.fornecedor.nome}{' '}
                        {/* Excluída depois do vínculo: a linha continua gravável (README da API › decisão 158). */}
                        {f.fornecedor.excluida ? (
                          <Badge size="xs" color="red" variant="light">
                            excluído
                          </Badge>
                        ) : (
                          !f.fornecedor.ativa && (
                            <Badge size="xs" color="gray" variant="light">
                              inativo
                            </Badge>
                          )
                        )}
                      </Text>
                      {erroDa(i, 'fornecedorId') && (
                        <Text size="xs" c="red">
                          {String(erroDa(i, 'fornecedorId'))}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Código no fornecedor ${nome}`}
                        maxLength={60}
                        w={150}
                        {...form.getInputProps(`fornecedores.${i}.codigoFornecedor`)}
                        onChange={(e) => {
                          form.setFieldValue(`fornecedores.${i}.codigoFornecedor`, e.currentTarget.value);
                          form.setFieldValue(`fornecedores.${i}.moverVinculo`, false);
                        }}
                      />
                      {conflito && !f.moverVinculo && pode('produtos.editar') && (
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          mt={4}
                          onClick={() => {
                            form.setFieldValue(`fornecedores.${i}.moverVinculo`, true);
                            form.clearFieldError(`fornecedores.${i}.codigoFornecedor`);
                          }}
                        >
                          Mover o vínculo para este produto
                        </Button>
                      )}
                      {f.moverVinculo && (
                        <Text size="xs" c="orange">
                          Sai do outro produto ao gravar
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`EAN do fornecedor ${nome}`}
                        inputMode="numeric"
                        maxLength={14}
                        w={150}
                        {...form.getInputProps(`fornecedores.${i}.eanFornecedor`)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Unidade de compra ${nome}`}
                        maxLength={6}
                        w={80}
                        {...form.getInputProps(`fornecedores.${i}.unidadeCompra`)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Fator ${nome}`}
                        w={80}
                        {...form.getInputProps(`fornecedores.${i}.fator`)}
                      />
                    </Table.Td>
                    {verCusto && (
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <TextInput
                            aria-label={`Custo do fornecedor ${nome}`}
                            leftSection="R$"
                            w={120}
                            {...form.getInputProps(`fornecedores.${i}.custoFornecedor`)}
                          />
                          {!kit && (
                            <Tooltip label="Usar como preço de custo do produto">
                              <ActionIcon
                                variant="default"
                                aria-label={`Usar o custo de ${nome} como preço de custo`}
                                disabled={!f.custoFornecedor.trim()}
                                onClick={() => usarComoCusto(f.custoFornecedor.trim())}
                              >
                                <IconCurrencyReal size={16} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                    )}
                    {verCusto && (
                      <Table.Td>
                        <Text size="sm">
                          {f.ultimoCusto ? `R$ ${decimalParaTela(f.ultimoCusto, 4)}` : '—'}
                        </Text>
                      </Table.Td>
                    )}
                    <Table.Td>
                      <Text size="sm">{f.ultimaCompraEm ? formatarData(f.ultimaCompraEm) : '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Checkbox
                        aria-label={`Principal ${nome}`}
                        checked={f.principal}
                        onChange={(e) => marcarPrincipal(i, e.currentTarget.checked)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Remover ${nome}`}
                        onClick={() => form.removeListItem('fornecedores', i)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------- Validade (8.2.12)

/** Hoje no relógio do navegador (`AAAA-MM-DD`): só para o selo "vencido" da grade. */
function hojeLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Bloco Validade (ERP 8.2.12; F2-B17): os lotes do produto (`produtos_lotes`) e o "Solicita lote no PDV". **Loja** =
 * o estoque vinculado da loja (só as lojas cujo estoque o usuário pode ver; vazio = todas as lojas), escolhida só no
 * lote novo: depois de gravado o estoque não muda (excluir e criar outro). Lote, validade, fabricação, fornecedor e
 * ativo são editáveis. Abaixo de cada lote, somente leitura, o saldo por estoque e tipo vem de `saldos_lote` (o razão,
 * o mesmo que desce ao PDV; `GET /produtos/:id/saldos`). O lote com movimento de estoque não tem "Remover" (a API
 * também recusa): inativa-se. Os lotes gravados inativos ficam escondidos atrás de "Mostrar os inativos" (o recebimento
 * cria um lote por texto novo, e o lote com histórico não sai: a lista só cresce); a linha com erro aparece sempre. O
 * "Remover" do lote gravado o põe em `lotesExcluidos`, e o corpo leva só o que mudou (`paraCorpo`).
 */
export function BlocoValidade({ form, produtoId }: { form: Form; produtoId: string | null }) {
  const v = form.getValues();
  const eu = useEu();
  const [mostrarInativos, setMostrarInativos] = useState(false);
  const saldos = useQuery({
    queryKey: ['produtos', produtoId, 'saldos'],
    queryFn: () => apiErp.get<SaldosProduto>(`/produtos/${produtoId}/saldos`),
    enabled: !!produtoId,
  });
  const lojas = useMemo(
    () => eu.lojas.filter((l) => l.ativa && l.estoqueId).map((l) => ({ value: l.estoqueId!, label: l.nome })),
    [eu.lojas],
  );
  const opcoesLoja = [{ value: '', label: 'Todas as lojas' }, ...lojas];
  const hoje = hojeLocal();
  const incluir = () =>
    form.insertListItem('lotes', {
      chave: novaChave(),
      id: null,
      estoqueId: '',
      rotuloLoja: null,
      gravado: false,
      lote: '',
      validade: '',
      fabricacao: '',
      fornecedorId: null,
      fornecedor: null,
      ativo: true,
      temMovimento: false,
      original: null,
    });
  const erroDa = (i: number, campo: string) => form.errors[`lotes.${i}.${campo}`];
  const comErro = (i: number) => Object.keys(form.errors).some((k) => k.startsWith(`lotes.${i}.`));
  /** Gravado inativo (como veio do detalhe): escondido até "Mostrar os inativos", salvo com erro. */
  const inativoGravado = (l: ValoresProduto['lotes'][number]) => l.original !== null && !l.original.ativo;
  const inativos = v.lotes.filter(inativoGravado).length;
  const visiveis = v.lotes.flatMap((l, i) =>
    mostrarInativos || !inativoGravado(l) || comErro(i) ? [{ l, i }] : [],
  );
  const remover = (i: number) => {
    const id = v.lotes[i]?.id;
    if (id) form.setFieldValue('lotesExcluidos', [...v.lotesExcluidos, id]);
    form.removeListItem('lotes', i);
  };
  return (
    <Stack gap="xs">
      <Checkbox
        label="Solicita lote no PDV"
        description={
          'O recebimento exige lote e validade deste produto. A escolha do lote no caixa vem numa próxima versão: até ' +
          'lá a venda sem lote segue Configurações › Geral › Estoque › "Saída sem lote de produto com lote" (o padrão ' +
          'baixa dos lotes o que vence primeiro; com "Não baixar" o saldo por lote não muda com a venda).'
        }
        {...form.getInputProps('solicitaLotePdv', { type: 'checkbox' })}
      />
      <Text size="xs" c="dimmed">
        A loja do lote não muda depois de gravado. Os lotes criados pelo recebimento valem em todas as lojas,
        e o saldo de cada lote vem das movimentações de estoque.
      </Text>
      <Group>
        <Button variant="default" leftSection={<IconPlus size={16} />} onClick={incluir}>
          Incluir lote
        </Button>
        {inativos > 0 && (
          <Switch
            label={`Mostrar os inativos (${inativos})`}
            checked={mostrarInativos}
            onChange={(e) => setMostrarInativos(e.currentTarget.checked)}
          />
        )}
      </Group>
      {/* Erro da lista inteira (teto, lote com saldo ou movimento que saiu da grade). */}
      {form.errors.lotes && (
        <Text size="xs" c="red">
          {String(form.errors.lotes)}
        </Text>
      )}
      {visiveis.length > 0 && (
        <ScrollArea>
          <Table data-testid="lotes" miw={1040}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Loja</Table.Th>
                <Table.Th>Lote</Table.Th>
                <Table.Th>Validade</Table.Th>
                <Table.Th>Fabricação</Table.Th>
                <Table.Th>Fornecedor</Table.Th>
                <Table.Th>Ativo</Table.Th>
                <Table.Th>Saldo por estoque</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {visiveis.map(({ l, i }) => {
                const nome = l.lote.trim() || `linha ${i + 1}`;
                const doLote = l.id ? (saldos.data?.lotes ?? []).filter((s) => s.loteId === l.id) : [];
                return (
                  <Table.Tr key={l.chave}>
                    <Table.Td>
                      {l.gravado ? (
                        <Text size="sm">{l.rotuloLoja ?? 'Todas as lojas'}</Text>
                      ) : (
                        <Select
                          aria-label={`Loja do lote ${nome}`}
                          allowDeselect={false}
                          w={180}
                          data={opcoesLoja}
                          {...form.getInputProps(`lotes.${i}.estoqueId`)}
                        />
                      )}
                      {l.gravado && erroDa(i, 'estoqueId') && (
                        <Text size="xs" c="red">
                          {String(erroDa(i, 'estoqueId'))}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Lote ${nome}`}
                        maxLength={30}
                        w={140}
                        {...form.getInputProps(`lotes.${i}.lote`)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <CampoData
                          aria-label={`Validade do lote ${nome}`}
                          w={140}
                          {...form.getInputProps(`lotes.${i}.validade`)}
                        />
                        {l.validade && l.validade < hoje && (
                          <Badge size="xs" color="red" variant="light">
                            vencido
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <CampoData
                        aria-label={`Fabricação do lote ${nome}`}
                        w={140}
                        {...form.getInputProps(`lotes.${i}.fabricacao`)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <SeletorPessoa
                        aria-label={`Fornecedor do lote ${nome}`}
                        categoria="fornecedor"
                        value={l.fornecedorId}
                        pessoa={l.fornecedor}
                        onChange={(id, p) => {
                          form.setFieldValue(`lotes.${i}.fornecedorId`, id);
                          form.setFieldValue(`lotes.${i}.fornecedor`, p);
                        }}
                        clearable
                        error={erroDa(i, 'fornecedorId')}
                        w={220}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Checkbox
                        aria-label={`Lote ${nome} ativo`}
                        {...form.getInputProps(`lotes.${i}.ativo`, { type: 'checkbox' })}
                      />
                    </Table.Td>
                    <Table.Td>
                      {doLote.length ? (
                        <Stack gap={0}>
                          {doLote.map((s) => (
                            <Text size="xs" key={`${s.estoqueId}:${s.tipoEstoqueId}`}>
                              {s.estoqueNome} · {s.tipoEstoqueNome}: {decimalParaTela(s.quantidade, 3)}
                            </Text>
                          ))}
                        </Stack>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {l.id ? 'Sem saldo' : '—'}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Tooltip
                        label="Lote com movimento de estoque: inative em vez de excluir"
                        disabled={!l.temMovimento}
                      >
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={`Remover o lote ${nome}`}
                          disabled={l.temMovimento}
                          onClick={() => remover(i)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Stack>
  );
}
