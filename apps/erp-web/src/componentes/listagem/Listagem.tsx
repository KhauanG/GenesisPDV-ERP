import { LIMITE_TODOS, TAMANHOS_PAGINA, type FormatoExportacao, type Pagina } from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Group,
  Menu,
  Paper,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDocumentTitle, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowsSort,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconDownload,
  IconFilter,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSortAscending,
  IconSortDescending,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type SortingState,
  type Updater,
} from '@tanstack/react-table';
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ArquivoBaixado } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useLojaContexto } from '../../layout/lojaContexto';
import { gravarLocal, lerLocal } from '../../util/armazenamento';
import { salvarArquivo } from '../../util/arquivos';
import { formatarInteiro } from '../../util/formato';
import { lembrarFiltros } from './voltar';

export interface OpcaoFiltro {
  value: string;
  label: string;
}

export interface FiltroListagem {
  campo: string;
  rotulo: string;
  tipo: 'texto' | 'numero' | 'selecao' | 'loja' | 'data';
  opcoes?: OpcaoFiltro[];
  /** Valor quando o filtro não está na URL. Filtros `loja` usam a loja de contexto do cabeçalho (ERP 3.1). */
  padrao?: string;
  placeholder?: string;
  /**
   * Filtro que só vem pela URL (ex.: `sessaoCaixaId` do link "vendas da sessão", 14.9): vai à API e não tem campo no
   * formulário. Enquanto vale, aparece acima da grade como um aviso com "Remover" (`rotuloOculto`), para ninguém
   * estranhar a listagem restrita depois de trocar as datas; sai também com Limpar.
   */
  oculto?: boolean;
  /** Texto do aviso do filtro oculto ativo (padrão: "Filtrando por {rotulo}"). */
  rotuloOculto?: string;
}

export interface ColunaListagem<T> {
  campo: string;
  rotulo: string;
  ordenavel?: boolean;
  /** Nome do campo no `ordenar=campo:asc` da API (padrão: `campo`). */
  campoOrdenacao?: string;
  alinhamento?: 'left' | 'center' | 'right';
  largura?: number | string;
  formato?: (linha: T) => ReactNode;
  /** Coluna sensível: só aparece com esta permissão (ERP 2.2). */
  permissao?: string;
}

export interface ConfigListagem<T> {
  /** Chave do recurso: base das permissões (`<recurso>.criar`, `.exportar`) e da preferência de tamanho. */
  recurso: string;
  titulo: string;
  filtros: FiltroListagem[];
  colunas: ColunaListagem<T>[];
  ordenacaoPadrao: string;
  rotaEdicao: (linha: T) => string;
  rotaNovo?: string;
  rotuloNovo?: string;
  /** Permissão do botão Novo; `null` = sem botão. Padrão: `<recurso>.criar`. */
  permissaoNovo?: string | null;
  /** Qualquer uma libera o Exportar. Padrão: `<recurso>.exportar` ou `relatorios.exportar` (ERP 3.1). */
  permissoesExportar?: string[];
  chaveLinha: (linha: T) => string;
  buscar: (params: Record<string, string>, sinal: AbortSignal) => Promise<Pagina<T>>;
  /**
   * `GET /api/<recurso>/exportar?formato=&<filtros>&ordenar=` (ERP 1.8) com os filtros e a ordenação atuais, sem
   * paginação. Sem ela, o botão Exportar não aparece.
   */
  exportar?: (params: Record<string, string>, formato: FormatoExportacao) => Promise<ArquivoBaixado>;
  /** Linha de totais abaixo da tabela (ex.: custo e venda total dos saldos, ERP 16.4), com a página carregada. */
  rodape?: (pagina: Pagina<T>) => ReactNode;
}

const TAMANHOS = [...TAMANHOS_PAGINA.map(String), 'todos'] as const;
const features = tableFeatures({ rowSortingFeature });

function lerOrdenacao(valor: string): SortingState {
  const [id, dir] = valor.split(':');
  return id ? [{ id, desc: dir === 'desc' }] : [];
}

/**
 * Listagem genérica (ERP 3.1): filtros, página, tamanho e ordenação ficam na URL; a busca é feita no servidor
 * (TanStack Query, mantendo a página anterior visível durante a troca) e a tabela é montada com TanStack Table.
 */
export function Listagem<T extends RowData>({
  config,
  acoes,
}: {
  config: ConfigListagem<T>;
  acoes?: ReactNode;
}) {
  useDocumentTitle(`${config.titulo} · GenesisPDV`);
  const pode = usePode();
  const navigate = useNavigate();
  const { lojaId } = useLojaContexto();
  const [params, setParams] = useSearchParams();
  const estreita = useMediaQuery('(max-width: 48em)');
  const local = useLocation();
  useEffect(() => lembrarFiltros(local.pathname, local.search), [local.pathname, local.search]);
  const chaveTamanho = `genesis:listagem:${config.recurso}:tamanho`;

  const padroes = useMemo(() => {
    const p: Record<string, string> = {};
    for (const f of config.filtros) p[f.campo] = f.tipo === 'loja' ? (lojaId ?? '') : (f.padrao ?? '');
    return p;
  }, [config.filtros, lojaId]);

  const filtrosAplicados = useMemo(() => {
    const p: Record<string, string> = {};
    for (const f of config.filtros) p[f.campo] = params.get(f.campo) ?? padroes[f.campo] ?? '';
    return p;
  }, [config.filtros, params, padroes]);

  const pagina = Math.max(1, Number(params.get('pagina')) || 1);
  const tamanhoUrl = params.get('tamanho');
  const tamanhoSalvo = lerLocal(chaveTamanho);
  const tamanho =
    (TAMANHOS as readonly string[]).find((t) => t === tamanhoUrl) ??
    (TAMANHOS as readonly string[]).find((t) => t === tamanhoSalvo) ??
    '20';
  const ordenar = params.get('ordenar') ?? config.ordenacaoPadrao;

  const [rascunho, setRascunho] = useState(filtrosAplicados);
  const chaveFiltros = JSON.stringify(filtrosAplicados);
  const [filtrosVistos, setFiltrosVistos] = useState(chaveFiltros);
  // Voltar/avançar no navegador muda a URL: os campos acompanham (ajuste durante a renderização, sem efeito).
  if (filtrosVistos !== chaveFiltros) {
    setFiltrosVistos(chaveFiltros);
    setRascunho(filtrosAplicados);
  }

  const consulta = useMemo(() => {
    const q: Record<string, string> = { pagina: String(pagina), tamanho, ordenar };
    for (const [k, v] of Object.entries(filtrosAplicados)) if (v) q[k] = v;
    return q;
  }, [filtrosAplicados, pagina, tamanho, ordenar]);

  const resultado = useQuery({
    queryKey: ['listagem', config.recurso, consulta],
    queryFn: ({ signal }) => config.buscar(consulta, signal),
    placeholderData: keepPreviousData,
  });

  function atualizarUrl(mudancas: Record<string, string | null>) {
    const novo = new URLSearchParams(params);
    for (const [k, v] of Object.entries(mudancas)) {
      if (v === null || v === '') novo.delete(k);
      else novo.set(k, v);
    }
    setParams(novo);
  }

  function pesquisar() {
    const novo = new URLSearchParams(params);
    novo.delete('pagina');
    for (const f of config.filtros) {
      const v = (rascunho[f.campo] ?? '').trim();
      // Igual ao padrão sai da URL; diferente (mesmo vazio) fica explícito.
      if (v === (padroes[f.campo] ?? '')) novo.delete(f.campo);
      else novo.set(f.campo, v);
    }
    setParams(novo);
  }

  // Filtros ocultos que estão valendo (vieram pela URL e diferem do padrão).
  const ocultosAtivos = config.filtros.filter(
    (f) => f.oculto && filtrosAplicados[f.campo] && filtrosAplicados[f.campo] !== (padroes[f.campo] ?? ''),
  );

  function removerOculto(campo: string) {
    atualizarUrl({ [campo]: null, pagina: null });
  }

  function limpar() {
    setRascunho(padroes);
    const novo = new URLSearchParams();
    const ord = params.get('ordenar');
    if (ord) novo.set('ordenar', ord);
    if (params.get('tamanho')) novo.set('tamanho', params.get('tamanho')!);
    setParams(novo);
  }

  const colunasVisiveis = useMemo(
    () => config.colunas.filter((c) => !c.permissao || pode(c.permissao)),
    [config.colunas, pode],
  );

  const sorting = useMemo(() => lerOrdenacao(ordenar), [ordenar]);
  const columns = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      colunasVisiveis.map((c) => ({
        id: c.campoOrdenacao ?? c.campo,
        accessorFn: (linha: T) => (linha as Record<string, unknown>)[c.campo] as never,
        header: c.rotulo,
        enableSorting: !!c.ordenavel,
      })),
    [colunasVisiveis],
  );
  const vazio = useMemo<T[]>(() => [], []);

  const tabela = useTable({
    features,
    columns,
    data: resultado.data?.itens ?? vazio,
    state: { sorting },
    manualSorting: true,
    enableMultiSort: false,
    enableSortingRemoval: true,
    sortDescFirst: false,
    onSortingChange: (atualizacao: Updater<SortingState>) => {
      const novo = typeof atualizacao === 'function' ? atualizacao(sorting) : atualizacao;
      const s = novo[0];
      atualizarUrl({ ordenar: s ? `${s.id}:${s.desc ? 'desc' : 'asc'}` : null, pagina: null });
    },
  });

  const total = resultado.data?.total ?? 0;
  const tamanhoNumero = tamanho === 'todos' ? Math.max(total, 1) : Number(tamanho);
  const paginas = tamanho === 'todos' ? 1 : Math.max(1, Math.ceil(total / tamanhoNumero));
  const podeNovo =
    config.rotaNovo &&
    config.permissaoNovo !== null &&
    pode(config.permissaoNovo ?? `${config.recurso}.criar`);
  const podeExportar =
    !!config.exportar &&
    (config.permissoesExportar ?? [`${config.recurso}.exportar`, 'relatorios.exportar']).some(pode);
  const [exportando, setExportando] = useState<FormatoExportacao | null>(null);

  function irPara(p: number) {
    atualizarUrl({ pagina: p <= 1 ? null : String(Math.min(p, paginas)) });
  }

  function mudarTamanho(t: string | null) {
    if (!t) return;
    gravarLocal(chaveTamanho, t);
    atualizarUrl({ tamanho: t, pagina: null });
  }

  function abrir(linha: T, ev: MouseEvent | KeyboardEvent) {
    const rota = config.rotaEdicao(linha);
    if ('ctrlKey' in ev && (ev.ctrlKey || ev.metaKey)) window.open(rota, '_blank');
    else navigate(rota);
  }

  function aoClicarLinha(linha: T, ev: MouseEvent<HTMLTableRowElement>) {
    if ((ev.target as HTMLElement).closest('a,button,input')) return;
    abrir(linha, ev);
  }

  function aoTeclarLinha(linha: T, ev: KeyboardEvent<HTMLTableRowElement>) {
    if (ev.key === 'Enter') abrir(linha, ev);
    if (ev.key === 'ArrowDown') (ev.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    if (ev.key === 'ArrowUp') (ev.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
  }

  const celula = (c: ColunaListagem<T>, linha: T, i: number): ReactNode => {
    const bruto = (linha as Record<string, unknown>)[c.campo];
    const conteudo = c.formato
      ? c.formato(linha)
      : bruto === null || bruto === undefined
        ? '—'
        : String(bruto);
    if (i !== 0) return conteudo;
    return (
      <Anchor component={Link} to={config.rotaEdicao(linha)} fw={500}>
        {conteudo}
      </Anchor>
    );
  };

  async function exportar(formato: FormatoExportacao) {
    if (!config.exportar || exportando) return;
    const params: Record<string, string> = { ordenar };
    for (const [k, v] of Object.entries(filtrosAplicados)) if (v) params[k] = v;
    setExportando(formato);
    try {
      const { blob, nome } = await config.exportar(params, formato);
      salvarArquivo(blob, nome);
      notifications.show({ color: 'green', message: `Arquivo ${nome} gerado` });
    } catch (e) {
      notifications.show({
        color: 'red',
        title: 'Não foi possível exportar',
        message: (e as Error).message,
      });
    } finally {
      setExportando(null);
    }
  }

  const carregandoInicial = resultado.isPending;
  const linhas = tabela.getRowModel().rows;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <Title order={2} size="h3">
          {config.titulo}
        </Title>
        <Group gap="xs">
          {acoes}
          {podeExportar && (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button
                  variant="default"
                  leftSection={<IconDownload size={16} />}
                  loading={exportando !== null}
                >
                  Exportar
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => void exportar('xlsx')}>Excel (.xlsx)</Menu.Item>
                <Menu.Item onClick={() => void exportar('csv')}>CSV</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
          {podeNovo && (
            <Button component={Link} to={config.rotaNovo!} leftSection={<IconPlus size={16} />}>
              {config.rotuloNovo ?? 'Novo registro'}
            </Button>
          )}
        </Group>
      </Group>

      {config.filtros.length > 0 && (
        <Paper p="md">
          <form
            role="search"
            aria-label={`Filtros de ${config.titulo}`}
            onSubmit={(e) => {
              e.preventDefault();
              pesquisar();
            }}
          >
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
              {config.filtros
                .filter((f) => !f.oculto)
                .map((f) => (
                  <CampoFiltro
                    key={f.campo}
                    filtro={f}
                    valor={rascunho[f.campo] ?? ''}
                    aoMudar={(v) => setRascunho((r) => ({ ...r, [f.campo]: v }))}
                  />
                ))}
            </SimpleGrid>
            {ocultosAtivos.map((f) => (
              <Alert
                key={f.campo}
                mt="sm"
                variant="light"
                color="blue"
                icon={<IconFilter size={16} />}
                data-testid={`filtro-oculto-${f.campo}`}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm">{f.rotuloOculto ?? `Filtrando por ${f.rotulo.toLowerCase()}`}</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    aria-label={`Remover o filtro ${f.rotulo}`}
                    onClick={() => removerOculto(f.campo)}
                  >
                    Remover
                  </Button>
                </Group>
              </Alert>
            ))}
            <Group justify="flex-end" mt="sm" gap="xs">
              <Button variant="default" onClick={limpar}>
                Limpar
              </Button>
              <Button type="submit" leftSection={<IconSearch size={16} />}>
                Pesquisar
              </Button>
            </Group>
          </form>
        </Paper>
      )}

      {resultado.isError && (
        <Alert
          color="red"
          icon={<IconAlertTriangle size={18} />}
          title="Não foi possível carregar a listagem"
          role="alert"
        >
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">{(resultado.error as Error).message}</Text>
            <Button
              size="xs"
              variant="white"
              color="red"
              leftSection={<IconRefresh size={14} />}
              onClick={() => void resultado.refetch()}
            >
              Tentar novamente
            </Button>
          </Group>
        </Alert>
      )}

      {tamanho === 'todos' && total > LIMITE_TODOS && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
          Mostrando {formatarInteiro(LIMITE_TODOS)} de {formatarInteiro(total)}. Use Exportar para obter
          todos.
        </Alert>
      )}

      <Paper p={0} style={{ overflow: 'hidden' }}>
        {estreita ? (
          <Stack gap={0} p="xs">
            {carregandoInicial
              ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={72} mb="xs" />)
              : linhas.map((row) => (
                  <Card
                    key={config.chaveLinha(row.original)}
                    withBorder
                    mb="xs"
                    padding="sm"
                    className="linha-clicavel"
                    onClick={(e: MouseEvent<HTMLDivElement>) => {
                      if (!(e.target as HTMLElement).closest('a')) navigate(config.rotaEdicao(row.original));
                    }}
                  >
                    <Text fw={600}>{celula(colunasVisiveis[0]!, row.original, 0)}</Text>
                    {colunasVisiveis.slice(1, 4).map((c, i) => (
                      <Text key={c.campo} size="sm" c="dimmed">
                        {c.rotulo}: {celula(c, row.original, i + 1)}
                      </Text>
                    ))}
                  </Card>
                ))}
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={600}>
            <Table striped="even" highlightOnHover aria-busy={resultado.isFetching}>
              <Table.Thead>
                {tabela.getHeaderGroups().map((grupo) => (
                  <Table.Tr key={grupo.id}>
                    {grupo.headers.map((h, i) => {
                      const c = colunasVisiveis[i]!;
                      const dir = h.column.getIsSorted();
                      const alternar = h.column.getToggleSortingHandler();
                      return (
                        <Table.Th
                          key={h.id}
                          scope="col"
                          w={c.largura}
                          ta={c.alinhamento}
                          aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                        >
                          {h.column.getCanSort() ? (
                            <UnstyledButton
                              onClick={alternar}
                              w="100%"
                              fw="inherit"
                              fz="inherit"
                              aria-label={`Ordenar por ${c.rotulo}`}
                            >
                              <Group
                                gap={4}
                                wrap="nowrap"
                                justify={c.alinhamento === 'right' ? 'flex-end' : undefined}
                              >
                                <span>{c.rotulo}</span>
                                {dir === 'asc' ? (
                                  <IconSortAscending size={14} aria-hidden />
                                ) : dir === 'desc' ? (
                                  <IconSortDescending size={14} aria-hidden />
                                ) : (
                                  <IconArrowsSort size={14} opacity={0.35} aria-hidden />
                                )}
                              </Group>
                            </UnstyledButton>
                          ) : (
                            c.rotulo
                          )}
                        </Table.Th>
                      );
                    })}
                  </Table.Tr>
                ))}
              </Table.Thead>
              <Table.Tbody>
                {carregandoInicial
                  ? Array.from({ length: 5 }, (_, i) => (
                      <Table.Tr key={i}>
                        {colunasVisiveis.map((c) => (
                          <Table.Td key={c.campo}>
                            <Skeleton h={14} />
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))
                  : linhas.map((row) => (
                      <Table.Tr
                        key={config.chaveLinha(row.original)}
                        className="linha-clicavel"
                        tabIndex={0}
                        onClick={(e) => aoClicarLinha(row.original, e)}
                        onKeyDown={(e) => aoTeclarLinha(row.original, e)}
                      >
                        {colunasVisiveis.map((c, i) => (
                          <Table.Td key={c.campo} ta={c.alinhamento}>
                            {celula(c, row.original, i)}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        {!carregandoInicial && !resultado.isError && linhas.length === 0 && (
          <Stack align="center" gap="xs" py="xl">
            <Text c="dimmed">Nenhum registro encontrado com os filtros informados.</Text>
            <Button variant="light" size="xs" onClick={limpar}>
              Limpar filtros
            </Button>
          </Stack>
        )}

        {config.rodape && resultado.data && linhas.length > 0 && (
          <Box px="md" py="xs" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {config.rodape(resultado.data)}
          </Box>
        )}

        <Box px="md" py="xs" style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Group gap="xs">
              <Text size="sm">Mostrar</Text>
              <Select
                aria-label="Registros por página"
                w={96}
                size="xs"
                allowDeselect={false}
                value={tamanho}
                onChange={mudarTamanho}
                data={TAMANHOS.map((t) => ({ value: t, label: t === 'todos' ? 'Todos' : t }))}
              />
              <Text size="sm">registros</Text>
              <Text size="sm" c="dimmed" ml="sm" aria-live="polite">
                {formatarInteiro(total)} {total === 1 ? 'registro' : 'registros'}
              </Text>
            </Group>
            <Group gap={4}>
              <Tooltip label="Primeiro">
                <ActionIcon
                  variant="default"
                  aria-label="Primeira página"
                  disabled={pagina <= 1}
                  onClick={() => irPara(1)}
                >
                  <IconChevronsLeft size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Anterior">
                <ActionIcon
                  variant="default"
                  aria-label="Página anterior"
                  disabled={pagina <= 1}
                  onClick={() => irPara(pagina - 1)}
                >
                  <IconChevronLeft size={16} />
                </ActionIcon>
              </Tooltip>
              <Text size="sm" px="xs">
                página {Math.min(pagina, paginas)} de {paginas}
              </Text>
              <Tooltip label="Próxima">
                <ActionIcon
                  variant="default"
                  aria-label="Próxima página"
                  disabled={pagina >= paginas}
                  onClick={() => irPara(pagina + 1)}
                >
                  <IconChevronRight size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Último">
                <ActionIcon
                  variant="default"
                  aria-label="Última página"
                  disabled={pagina >= paginas}
                  onClick={() => irPara(paginas)}
                >
                  <IconChevronsRight size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Box>
      </Paper>
    </Stack>
  );
}

export function CampoFiltro({
  filtro,
  valor,
  aoMudar,
}: {
  filtro: FiltroListagem;
  valor: string;
  aoMudar: (valor: string) => void;
}) {
  if (filtro.tipo === 'selecao' || filtro.tipo === 'loja') {
    return (
      <Select
        label={filtro.rotulo}
        placeholder={filtro.placeholder ?? 'Todos'}
        data={filtro.opcoes ?? []}
        value={valor || null}
        clearable={!filtro.padrao}
        searchable={(filtro.opcoes?.length ?? 0) > 8}
        onChange={(v) => aoMudar(v ?? '')}
        comboboxProps={{ withinPortal: true }}
      />
    );
  }
  return (
    <TextInput
      label={filtro.rotulo}
      placeholder={filtro.placeholder}
      value={valor}
      inputMode={filtro.tipo === 'numero' ? 'numeric' : undefined}
      type={filtro.tipo === 'data' ? 'date' : undefined}
      onChange={(e) => aoMudar(e.currentTarget.value)}
    />
  );
}
