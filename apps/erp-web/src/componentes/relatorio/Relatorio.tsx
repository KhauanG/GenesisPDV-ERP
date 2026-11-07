import {
  TAMANHOS_PAGINA,
  type ExportacaoEmTarefa,
  type FormatoExportacao,
  type ResultadoExportacaoRelatorio,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  CloseButton,
  Group,
  Menu,
  Paper,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconCsv,
  IconDownload,
  IconFileTypePdf,
  IconFilter,
  IconPrinter,
  IconRefresh,
  IconTable,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams, type NavigateOptions } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query, type ArquivoBaixado } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { useLojaContexto } from '../../layout/lojaContexto';
import { salvarArquivo } from '../../util/arquivos';
import { formatarDataHora, formatarInteiro } from '../../util/formato';
import { CampoFiltro, type FiltroListagem } from '../listagem/Listagem';
import { AndamentoTarefa, DownloadTarefa } from '../tarefas/AndamentoTarefa';
import { CHAVE_LISTA_TAREFAS, useTarefa } from '../tarefas/tarefas';

export interface ColunaRelatorio<T> {
  campo: string;
  rotulo: string;
  alinhamento?: 'left' | 'center' | 'right';
  formato?: (linha: T) => ReactNode;
}

export interface ResultadoRelatorio<T> {
  /** Cards de resumo no topo (ex.: "Total vendido", "Ticket médio"). */
  resumo?: Array<{ rotulo: string; valor: string }>;
  /** As linhas da página (ou todas, no relatório sem paginação). */
  linhas: T[];
  /** Linha de totais da tabela, por campo, já formatada pela API (do relatório inteiro, não da página). */
  totais?: Partial<Record<string, string>>;
  /** Paginação `pagina`: o total de linhas com os filtros, contado pela API. */
  total?: number;
  /** Paginação `cursor`: o cursor da próxima página; `null` (ou ausente) na última. */
  proximoCursor?: string | null;
}

/**
 * Paginação no servidor (F2-B30): `pagina` manda `pagina` e `tamanho` e espera o `total`; `cursor` manda `tamanho` e
 * o `cursor` (vazio na primeira) e espera o `proximoCursor` — para o relatório que lê o razão em ordem
 * (`data_movimento`, `id`) e não conta o total. Sem ela, a API devolve tudo de uma vez.
 */
export type PaginacaoRelatorio = 'pagina' | 'cursor';
export type TamanhoPaginaRelatorio = (typeof TAMANHOS_PAGINA)[number];

/** A resposta da exportação: o arquivo (até 50 mil linhas) ou a tarefa em segundo plano (F2-B29). */
export type RespostaExportacao = ArquivoBaixado | ExportacaoEmTarefa;

export interface SelecaoRelatorio<T> {
  /** As ações sobre as linhas marcadas (ex.: "Definir NCM"), na barra que aparece com a seleção. */
  acoes: (selecionadas: T[], limpar: () => void) => ReactNode;
  /** Nome da linha para o leitor de tela ("Selecionar <nome>"); padrão: "linha N". */
  rotuloLinha?: (linha: T) => string;
}

export interface ConfigRelatorio<T> {
  /** `/relatorios/<nome>` (ERP 3.5) e chave do cache. */
  nome: string;
  titulo: string;
  filtros: FiltroListagem[];
  colunas: ColunaRelatorio<T>[];
  chaveLinha: (linha: T, indice: number) => string;
  /** Recebe os filtros e, com `paginacao`, `pagina`/`tamanho` ou `cursor`/`tamanho`. */
  buscar: (params: Record<string, string>, sinal: AbortSignal) => Promise<ResultadoRelatorio<T>>;
  paginacao?: PaginacaoRelatorio;
  /** Tamanho da página quando a URL não diz (padrão 50). */
  tamanhoPadrao?: TamanhoPaginaRelatorio;
  /** Seleção de linhas (da página aberta) com as ações em lote. */
  selecao?: SelecaoRelatorio<T>;
  /**
   * Excel (.xlsx) ou CSV gerado pela API com os mesmos filtros (sem a página): `exportarPelaApi(<chave>)`. Sem ela, o
   * menu só tem PDF e Imprimir.
   */
  exportar?: (params: Record<string, string>, formato: FormatoExportacao) => Promise<RespostaExportacao>;
  /** Gráfico opcional abaixo dos cards. */
  grafico?: (resultado: ResultadoRelatorio<T>) => ReactNode;
  /** Relatório leve: gera ao abrir. Os demais só geram depois do Filtrar (ou com filtros na URL). */
  gerarAoAbrir?: boolean;
}

/** A exportação pela rota comum da API (`GET /relatorios/<chave>/exportar`, F2-B29): arquivo na hora ou tarefa. */
export function exportarPelaApi(chave: string): NonNullable<ConfigRelatorio<unknown>['exportar']> {
  return (params, formato) =>
    apiErp.baixarOuTarefa(
      `/relatorios/${encodeURIComponent(chave)}/exportar${query({ ...params, formato })}`,
    );
}

const ehTarefa = (r: RespostaExportacao): r is ExportacaoEmTarefa => 'tarefaId' in r;

/**
 * Os cursores das páginas anteriores da paginação por cursor, guardados no estado da entrada do histórico (não no
 * estado do componente): cada Próxima/Anterior cria uma entrada com o cursor na URL e a pilha dela, então o Voltar e o
 * Avançar do navegador trazem os dois juntos, e o rótulo "Página N" e o botão Anterior continuam certos. O link aberto
 * de fora (ou recarregado num navegador sem o histórico) não tem pilha: "Página aberta pelo link".
 */
function cursoresAnteriores(estado: unknown): string[] {
  const pilha = (estado as { cursoresAnteriores?: unknown } | null)?.cursoresAnteriores;
  return Array.isArray(pilha) && pilha.every((c) => typeof c === 'string') ? pilha : [];
}

/**
 * Casca dos relatórios (ERP 3.5): filtros no topo com **Filtrar** (gravados na URL, então o link reabre o mesmo
 * relatório), cards de resumo, gráfico e tabela, e Exportar em Excel/CSV (API), PDF e Imprimir. PDF e Imprimir usam o
 * layout de impressão do navegador com o cabeçalho da empresa, os filtros usados, a data/hora e o usuário.
 *
 * Para volume grande (F2-B30; README do ERP › decisão 65): a página e o tamanho (ou o cursor) também ficam na URL e a
 * API devolve só a página; a seleção de linhas é opcional; e a exportação que passa de 50 mil linhas vira tarefa
 * (`202`), com o aviso e o andamento aqui e o link no ícone Tarefas do cabeçalho quando termina.
 */
export function Relatorio<T>({ config }: { config: ConfigRelatorio<T> }) {
  useDocumentTitle(`${config.titulo} · GenesisPDV`);
  const eu = useEu();
  const pode = usePode();
  const queryClient = useQueryClient();
  const { lojaId } = useLojaContexto();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [exportando, setExportando] = useState(false);
  const [exportacao, setExportacao] = useState<ExportacaoEmTarefa | null>(null);

  const padroes = useMemo(() => {
    const p: Record<string, string> = {};
    for (const f of config.filtros) p[f.campo] = f.tipo === 'loja' ? (lojaId ?? '') : (f.padrao ?? '');
    return p;
  }, [config.filtros, lojaId]);

  const aplicados = useMemo(() => {
    const p: Record<string, string> = {};
    for (const f of config.filtros) p[f.campo] = params.get(f.campo) ?? padroes[f.campo] ?? '';
    return p;
  }, [config.filtros, params, padroes]);

  const [rascunho, setRascunho] = useState(aplicados);
  const chaveAplicados = JSON.stringify(aplicados);
  const chavePadroes = JSON.stringify(padroes);
  const temPosicao = params.has('pagina') || params.has('cursor');
  const [vistos, setVistos] = useState({ aplicados: chaveAplicados, padroes: chavePadroes });
  // A página ou o cursor da URL eram de outros filtros: o padrão de um filtro que não está na URL mudou por fora do
  // Filtrar (a loja de contexto do cabeçalho, por exemplo). Até a URL ser corrigida (o efeito abaixo), a consulta já
  // vai sem eles, para não juntar o cursor da loja anterior com a loja nova.
  const [descartarPosicao, setDescartarPosicao] = useState(false);
  if (vistos.aplicados !== chaveAplicados || vistos.padroes !== chavePadroes) {
    if (vistos.aplicados !== chaveAplicados) setRascunho(aplicados);
    if (vistos.padroes !== chavePadroes && vistos.aplicados !== chaveAplicados && temPosicao)
      setDescartarPosicao(true);
    setVistos({ aplicados: chaveAplicados, padroes: chavePadroes });
  }
  if (descartarPosicao && !temPosicao) setDescartarPosicao(false);
  useEffect(() => {
    if (!descartarPosicao || !temPosicao) return;
    setParams(
      (atual) => {
        const novo = new URLSearchParams(atual);
        novo.delete('pagina');
        novo.delete('cursor');
        return novo;
      },
      { replace: true },
    );
  }, [descartarPosicao, temPosicao, setParams]);

  const paginacao = config.paginacao;
  const tamanho =
    TAMANHOS_PAGINA.find((t) => String(t) === params.get('tamanho')) ?? config.tamanhoPadrao ?? 50;
  const pagina = descartarPosicao ? 1 : Math.max(1, Math.trunc(Number(params.get('pagina'))) || 1);
  const cursor = descartarPosicao ? '' : (params.get('cursor') ?? '');
  // Cursores das páginas já vistas (o "Anterior" da paginação por cursor), da entrada do histórico.
  const anteriores = descartarPosicao ? [] : cursoresAnteriores(location.state);

  /** Só os filtros: o que a exportação recebe (o arquivo é do relatório inteiro, não da página). */
  const consultaFiltros = useMemo(() => {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(aplicados)) if (v) q[k] = v;
    return q;
  }, [aplicados]);
  const consulta = useMemo(() => {
    if (paginacao === 'pagina')
      return { ...consultaFiltros, pagina: String(pagina), tamanho: String(tamanho) };
    if (paginacao === 'cursor')
      return { ...consultaFiltros, tamanho: String(tamanho), ...(cursor ? { cursor } : {}) };
    return consultaFiltros;
  }, [consultaFiltros, paginacao, pagina, tamanho, cursor]);
  const gerar = config.gerarAoAbrir || params.has('gerado');

  const resultado = useQuery({
    queryKey: ['relatorio', config.nome, consulta],
    queryFn: ({ signal }) => config.buscar(consulta, signal),
    enabled: gerar,
    placeholderData: keepPreviousData,
  });

  // Seleção da página aberta: some ao trocar de página ou de filtros.
  const [selecionadas, setSelecionadas] = useState<ReadonlyMap<string, T>>(new Map());
  const chaveConsulta = JSON.stringify(consulta);
  const [consultaVista, setConsultaVista] = useState(chaveConsulta);
  if (consultaVista !== chaveConsulta) {
    setConsultaVista(chaveConsulta);
    setSelecionadas(new Map());
  }

  function atualizarUrl(mudancas: Record<string, string | null>, opcoes?: NavigateOptions) {
    const novo = new URLSearchParams(params);
    for (const [k, v] of Object.entries(mudancas)) {
      if (v === null || v === '') novo.delete(k);
      else novo.set(k, v);
    }
    setParams(novo, opcoes);
  }

  function filtrar() {
    const novo = new URLSearchParams();
    for (const f of config.filtros) {
      const v = (rascunho[f.campo] ?? '').trim();
      if (v !== (padroes[f.campo] ?? '')) novo.set(f.campo, v);
    }
    // O tamanho escolhido continua; a página (ou o cursor) volta para a primeira.
    if (params.get('tamanho')) novo.set('tamanho', params.get('tamanho')!);
    // Marca que o relatório foi pedido: o link compartilhado já abre gerado.
    novo.set('gerado', '1');
    setParams(novo);
  }

  function limpar() {
    setRascunho(padroes);
  }

  async function exportarArquivo(formato: FormatoExportacao) {
    if (!config.exportar) return;
    setExportando(true);
    try {
      const r = await config.exportar(consultaFiltros, formato);
      if (ehTarefa(r)) {
        setExportacao(r);
        void queryClient.invalidateQueries({ queryKey: CHAVE_LISTA_TAREFAS });
        notifications.show({
          color: 'blue',
          title: 'Exportação em segundo plano',
          message: `${formatarInteiro(r.linhas)} linhas: o arquivo é gerado em segundo plano e o link aparece no ícone Tarefas quando terminar.`,
        });
      } else {
        salvarArquivo(r.blob, r.nome);
      }
    } catch (e) {
      notifications.show({ color: 'red', title: 'Não foi possível exportar', message: (e as Error).message });
    } finally {
      setExportando(false);
    }
  }

  const podeExportar = pode('relatorios.exportar');
  const dados = resultado.data;
  const filtrosUsados = config.filtros
    .map((f) => {
      const v = aplicados[f.campo];
      if (!v) return null;
      const rotulo = f.opcoes?.find((o) => o.value === v)?.label ?? v;
      return `${f.rotulo}: ${rotulo}`;
    })
    .filter(Boolean)
    .join(' · ');

  const total = dados?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / tamanho));
  const paginaCursor = anteriores.length + 1;
  const proximoCursor = dados?.proximoCursor ?? null;
  const descricaoPagina =
    paginacao === 'pagina'
      ? `Página ${formatarInteiro(Math.min(pagina, paginas))} de ${formatarInteiro(paginas)}`
      : paginacao === 'cursor'
        ? cursor && !anteriores.length
          ? 'Página aberta pelo link'
          : `Página ${formatarInteiro(paginaCursor)}`
        : null;

  function irPara(p: number) {
    atualizarUrl({ pagina: p <= 1 ? null : String(Math.min(p, paginas)) });
  }

  // A pilha vai no estado da nova entrada do histórico (`cursoresAnteriores`); sem estado, ela recomeça vazia.
  function proximaPorCursor() {
    if (!proximoCursor) return;
    atualizarUrl({ cursor: proximoCursor }, { state: { cursoresAnteriores: [...anteriores, cursor] } });
  }

  function anteriorPorCursor() {
    const volta = anteriores.at(-1) ?? '';
    atualizarUrl({ cursor: volta || null }, { state: { cursoresAnteriores: anteriores.slice(0, -1) } });
  }

  function primeiraPorCursor() {
    atualizarUrl({ cursor: null });
  }

  function mudarTamanho(t: string | null) {
    if (!t) return;
    atualizarUrl({ tamanho: t, pagina: null, cursor: null });
  }

  const linhasPagina = dados?.linhas ?? [];
  const chaves = linhasPagina.map((l, i) => config.chaveLinha(l, i));
  const marcadasNaPagina = chaves.filter((c) => selecionadas.has(c)).length;

  function alternarLinha(chave: string, linha: T, marcar: boolean) {
    setSelecionadas((atual) => {
      const novo = new Map(atual);
      if (marcar) novo.set(chave, linha);
      else novo.delete(chave);
      return novo;
    });
  }

  function alternarTodas(marcar: boolean) {
    setSelecionadas(marcar ? new Map(linhasPagina.map((l, i) => [chaves[i]!, l])) : new Map());
  }

  const limparSelecao = () => setSelecionadas(new Map());

  return (
    <Stack gap="md">
      <div className="so-impressao">
        <Text fw={700}>{eu.empresa.nome}</Text>
        <Text size="sm">{config.titulo}</Text>
        <Text size="xs">Filtros: {filtrosUsados || 'nenhum'}</Text>
        {descricaoPagina && dados && (
          <Text size="xs">
            {descricaoPagina}
            {paginacao === 'pagina' ? ` (${formatarInteiro(total)} registros)` : ''}
          </Text>
        )}
        <Text size="xs">
          Emitido em {formatarDataHora(new Date().toISOString())} por {eu.usuario.nome}
        </Text>
      </div>

      <Group justify="space-between" align="center" wrap="wrap" className="nao-imprimir">
        <Title order={2} size="h3">
          {config.titulo}
        </Title>
        {podeExportar && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                variant="default"
                leftSection={<IconDownload size={16} />}
                loading={exportando}
                disabled={!dados}
              >
                Exportar
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {config.exportar && (
                <>
                  <Menu.Item
                    leftSection={<IconTable size={14} />}
                    onClick={() => void exportarArquivo('xlsx')}
                  >
                    Excel (.xlsx)
                  </Menu.Item>
                  <Menu.Item leftSection={<IconCsv size={14} />} onClick={() => void exportarArquivo('csv')}>
                    CSV
                  </Menu.Item>
                </>
              )}
              <Menu.Item leftSection={<IconFileTypePdf size={14} />} onClick={() => window.print()}>
                PDF
              </Menu.Item>
              <Menu.Item leftSection={<IconPrinter size={14} />} onClick={() => window.print()}>
                Imprimir
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      {exportacao && (
        <ExportacaoEmAndamento
          key={exportacao.tarefaId}
          exportacao={exportacao}
          aoFechar={() => setExportacao(null)}
        />
      )}

      {config.filtros.length > 0 && (
        <Paper p="md" className="nao-imprimir">
          <form
            role="search"
            aria-label={`Filtros de ${config.titulo}`}
            onSubmit={(e) => {
              e.preventDefault();
              filtrar();
            }}
          >
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
              {config.filtros.map((f) => (
                <CampoFiltro
                  key={f.campo}
                  filtro={f}
                  valor={rascunho[f.campo] ?? ''}
                  aoMudar={(v) => setRascunho((r) => ({ ...r, [f.campo]: v }))}
                />
              ))}
            </SimpleGrid>
            <Group justify="flex-end" mt="sm" gap="xs">
              <Button variant="default" onClick={limpar}>
                Limpar
              </Button>
              <Button type="submit" leftSection={<IconFilter size={16} />}>
                Filtrar
              </Button>
            </Group>
          </form>
        </Paper>
      )}

      {resultado.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Não foi possível gerar o relatório">
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

      {!gerar && (
        <Text c="dimmed" ta="center" py="xl">
          Escolha os filtros e clique em Filtrar.
        </Text>
      )}

      {gerar && resultado.isPending && <Skeleton h={160} />}

      {dados && (
        <>
          {dados.resumo && dados.resumo.length > 0 && (
            <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm">
              {dados.resumo.map((r) => (
                <Card key={r.rotulo} withBorder padding="sm">
                  <Text size="xs" c="dimmed">
                    {r.rotulo}
                  </Text>
                  <Text fw={700} size="lg">
                    {r.valor}
                  </Text>
                </Card>
              ))}
            </SimpleGrid>
          )}
          {config.grafico?.(dados)}
          {config.selecao && selecionadas.size > 0 && (
            <Paper p="xs" className="nao-imprimir" withBorder>
              <Group gap="sm" wrap="wrap" aria-label="Linhas selecionadas" role="toolbar">
                <Text size="sm" fw={500}>
                  {formatarInteiro(selecionadas.size)} selecionada(s)
                </Text>
                {config.selecao.acoes([...selecionadas.values()], limparSelecao)}
                <Button size="xs" variant="subtle" onClick={limparSelecao}>
                  Limpar seleção
                </Button>
              </Group>
            </Paper>
          )}
          <Paper p={0} style={{ overflow: 'hidden' }}>
            <Table.ScrollContainer minWidth={600}>
              <Table striped="even" aria-label={config.titulo} aria-busy={resultado.isFetching}>
                <Table.Thead>
                  <Table.Tr>
                    {config.selecao && (
                      <Table.Th w={40} className="nao-imprimir">
                        <Checkbox
                          aria-label="Selecionar todas as linhas da página"
                          checked={linhasPagina.length > 0 && marcadasNaPagina === linhasPagina.length}
                          indeterminate={marcadasNaPagina > 0 && marcadasNaPagina < linhasPagina.length}
                          disabled={linhasPagina.length === 0}
                          onChange={(e) => alternarTodas(e.currentTarget.checked)}
                        />
                      </Table.Th>
                    )}
                    {config.colunas.map((c) => (
                      <Table.Th key={c.campo} scope="col" ta={c.alinhamento}>
                        {c.rotulo}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {linhasPagina.map((l, i) => {
                    const chave = chaves[i]!;
                    return (
                      <Table.Tr key={chave}>
                        {config.selecao && (
                          <Table.Td className="nao-imprimir">
                            <Checkbox
                              aria-label={`Selecionar ${config.selecao.rotuloLinha?.(l) ?? `linha ${i + 1}`}`}
                              checked={selecionadas.has(chave)}
                              onChange={(e) => alternarLinha(chave, l, e.currentTarget.checked)}
                            />
                          </Table.Td>
                        )}
                        {config.colunas.map((c) => (
                          <Table.Td key={c.campo} ta={c.alinhamento}>
                            {c.formato
                              ? c.formato(l)
                              : String((l as Record<string, unknown>)[c.campo] ?? '—')}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
                {dados.totais && (
                  <Table.Tfoot>
                    <Table.Tr>
                      {config.selecao && <Table.Th className="nao-imprimir" />}
                      {config.colunas.map((c, i) => (
                        <Table.Th key={c.campo} ta={c.alinhamento}>
                          {dados.totais![c.campo] ?? (i === 0 ? 'Total' : '')}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Tfoot>
                )}
              </Table>
            </Table.ScrollContainer>
            {dados.linhas.length === 0 && (
              <Text c="dimmed" ta="center" py="xl">
                Nenhum dado encontrado com os filtros informados.
              </Text>
            )}
            {paginacao && (
              <Box
                px="md"
                py="xs"
                className="nao-imprimir"
                style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
              >
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Group gap="xs">
                    <Text size="sm">Mostrar</Text>
                    <Select
                      aria-label="Linhas por página"
                      w={96}
                      size="xs"
                      allowDeselect={false}
                      value={String(tamanho)}
                      onChange={mudarTamanho}
                      data={TAMANHOS_PAGINA.map(String)}
                    />
                    <Text size="sm">por página</Text>
                    {paginacao === 'pagina' && (
                      <Text size="sm" c="dimmed" ml="sm" aria-live="polite">
                        {formatarInteiro(total)} {total === 1 ? 'registro' : 'registros'}
                      </Text>
                    )}
                  </Group>
                  {paginacao === 'pagina' ? (
                    <Group gap={4}>
                      <BotaoPagina
                        rotulo="Primeira página"
                        desabilitado={pagina <= 1}
                        aoClicar={() => irPara(1)}
                      >
                        <IconChevronsLeft size={16} />
                      </BotaoPagina>
                      <BotaoPagina
                        rotulo="Página anterior"
                        desabilitado={pagina <= 1}
                        aoClicar={() => irPara(Math.min(pagina, paginas) - 1)}
                      >
                        <IconChevronLeft size={16} />
                      </BotaoPagina>
                      <Text size="sm" px="xs">
                        {descricaoPagina}
                      </Text>
                      <BotaoPagina
                        rotulo="Próxima página"
                        desabilitado={pagina >= paginas}
                        aoClicar={() => irPara(pagina + 1)}
                      >
                        <IconChevronRight size={16} />
                      </BotaoPagina>
                      <BotaoPagina
                        rotulo="Última página"
                        desabilitado={pagina >= paginas}
                        aoClicar={() => irPara(paginas)}
                      >
                        <IconChevronsRight size={16} />
                      </BotaoPagina>
                    </Group>
                  ) : (
                    <Group gap={4}>
                      <BotaoPagina
                        rotulo="Primeira página"
                        desabilitado={!cursor}
                        aoClicar={primeiraPorCursor}
                      >
                        <IconChevronsLeft size={16} />
                      </BotaoPagina>
                      <BotaoPagina
                        rotulo="Página anterior"
                        desabilitado={!anteriores.length}
                        aoClicar={anteriorPorCursor}
                      >
                        <IconChevronLeft size={16} />
                      </BotaoPagina>
                      <Text size="sm" px="xs">
                        {descricaoPagina}
                      </Text>
                      <BotaoPagina
                        rotulo="Próxima página"
                        desabilitado={!proximoCursor || resultado.isPlaceholderData}
                        aoClicar={proximaPorCursor}
                      >
                        <IconChevronRight size={16} />
                      </BotaoPagina>
                    </Group>
                  )}
                </Group>
              </Box>
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}

function BotaoPagina({
  rotulo,
  desabilitado,
  aoClicar,
  children,
}: {
  rotulo: string;
  desabilitado: boolean;
  aoClicar: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={rotulo}>
      <ActionIcon variant="default" aria-label={rotulo} disabled={desabilitado} onClick={aoClicar}>
        {children}
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * A exportação que virou tarefa (F2-B29): o aviso com as linhas, o andamento (`GET /tarefas/:id` até terminar) e, no
 * fim, o link do arquivo — o mesmo que fica no ícone Tarefas do cabeçalho.
 */
function ExportacaoEmAndamento({
  exportacao,
  aoFechar,
}: {
  exportacao: ExportacaoEmTarefa;
  aoFechar: () => void;
}) {
  const tarefa = useTarefa<ResultadoExportacaoRelatorio>(exportacao.tarefaId);
  const t = tarefa.data;
  return (
    <Paper withBorder p="sm" className="nao-imprimir" data-testid="exportacao-em-tarefa">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Text fw={600} size="sm">
          Exportação em segundo plano · {formatarInteiro(exportacao.linhas)} linhas
        </Text>
        <CloseButton aria-label="Fechar o aviso da exportação" onClick={aoFechar} />
      </Group>
      <AndamentoTarefa
        tarefa={t}
        erroConsulta={tarefa.error}
        aoTentarNovamente={() => void tarefa.refetch()}
        tentando={tarefa.isFetching}
        rotulo="exportação"
        aviso="Você pode sair desta tela: o link do arquivo aparece no ícone Tarefas quando terminar."
      >
        {t && (
          <Stack gap="xs">
            <Text size="sm">
              Exportação concluída
              {t.resultado
                ? `: ${t.resultado.nomeArquivo} (${formatarInteiro(t.resultado.linhas)} linhas)`
                : ''}
              .
            </Text>
            <DownloadTarefa
              tarefa={t}
              rotulo="Baixar o arquivo"
              rotuloExpirado="O arquivo expirou e não pode mais ser baixado."
            />
          </Stack>
        )}
      </AndamentoTarefa>
    </Paper>
  );
}
