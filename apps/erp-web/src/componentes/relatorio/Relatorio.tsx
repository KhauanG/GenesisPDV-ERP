import {
  Alert,
  Button,
  Card,
  Group,
  Menu,
  Paper,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDownload,
  IconFileTypePdf,
  IconFilter,
  IconPrinter,
  IconRefresh,
  IconTable,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { ArquivoBaixado } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { useLojaContexto } from '../../layout/lojaContexto';
import { salvarArquivo } from '../../util/arquivos';
import { formatarDataHora } from '../../util/formato';
import { CampoFiltro, type FiltroListagem } from '../listagem/Listagem';

export interface ColunaRelatorio<T> {
  campo: string;
  rotulo: string;
  alinhamento?: 'left' | 'center' | 'right';
  formato?: (linha: T) => ReactNode;
}

export interface ResultadoRelatorio<T> {
  /** Cards de resumo no topo (ex.: "Total vendido", "Ticket médio"). */
  resumo?: Array<{ rotulo: string; valor: string }>;
  linhas: T[];
  /** Linha de totais da tabela, por campo, já formatada pela API. */
  totais?: Partial<Record<string, string>>;
}

export interface ConfigRelatorio<T> {
  /** `/relatorios/<nome>` (ERP 3.5) e chave do cache. */
  nome: string;
  titulo: string;
  filtros: FiltroListagem[];
  colunas: ColunaRelatorio<T>[];
  chaveLinha: (linha: T, indice: number) => string;
  buscar: (params: Record<string, string>, sinal: AbortSignal) => Promise<ResultadoRelatorio<T>>;
  /** Excel (.xlsx) gerado pela API com os mesmos filtros. Sem ela, o menu só tem PDF e Imprimir. */
  exportar?: (params: Record<string, string>) => Promise<ArquivoBaixado>;
  /** Gráfico opcional abaixo dos cards. */
  grafico?: (resultado: ResultadoRelatorio<T>) => ReactNode;
  /** Relatório leve: gera ao abrir. Os demais só geram depois do Filtrar (ou com filtros na URL). */
  gerarAoAbrir?: boolean;
}

/**
 * Casca dos relatórios (ERP 3.5): filtros no topo com **Filtrar** (gravados na URL, então o link reabre o mesmo
 * relatório), cards de resumo, gráfico e tabela, e Exportar em Excel (API), PDF e Imprimir. PDF e Imprimir usam o
 * layout de impressão do navegador com o cabeçalho da empresa, os filtros usados, a data/hora e o usuário.
 */
export function Relatorio<T>({ config }: { config: ConfigRelatorio<T> }) {
  useDocumentTitle(`${config.titulo} · GenesisPDV`);
  const eu = useEu();
  const pode = usePode();
  const { lojaId } = useLojaContexto();
  const [params, setParams] = useSearchParams();
  const [exportando, setExportando] = useState(false);

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
  const [vistos, setVistos] = useState(chaveAplicados);
  if (vistos !== chaveAplicados) {
    setVistos(chaveAplicados);
    setRascunho(aplicados);
  }

  const consulta = useMemo(() => {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(aplicados)) if (v) q[k] = v;
    return q;
  }, [aplicados]);
  const gerar = config.gerarAoAbrir || params.has('gerado');

  const resultado = useQuery({
    queryKey: ['relatorio', config.nome, consulta],
    queryFn: ({ signal }) => config.buscar(consulta, signal),
    enabled: gerar,
    placeholderData: keepPreviousData,
  });

  function filtrar() {
    const novo = new URLSearchParams();
    for (const f of config.filtros) {
      const v = (rascunho[f.campo] ?? '').trim();
      if (v !== (padroes[f.campo] ?? '')) novo.set(f.campo, v);
    }
    // Marca que o relatório foi pedido: o link compartilhado já abre gerado.
    novo.set('gerado', '1');
    setParams(novo);
  }

  function limpar() {
    setRascunho(padroes);
  }

  async function exportarExcel() {
    if (!config.exportar) return;
    setExportando(true);
    try {
      const { blob, nome } = await config.exportar(consulta);
      salvarArquivo(blob, nome);
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

  return (
    <Stack gap="md">
      <div className="so-impressao">
        <Text fw={700}>{eu.empresa.nome}</Text>
        <Text size="sm">{config.titulo}</Text>
        <Text size="xs">Filtros: {filtrosUsados || 'nenhum'}</Text>
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
                <Menu.Item leftSection={<IconTable size={14} />} onClick={() => void exportarExcel()}>
                  Excel (.xlsx)
                </Menu.Item>
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
          <Paper p={0} style={{ overflow: 'hidden' }}>
            <Table.ScrollContainer minWidth={600}>
              <Table striped="even" aria-label={config.titulo} aria-busy={resultado.isFetching}>
                <Table.Thead>
                  <Table.Tr>
                    {config.colunas.map((c) => (
                      <Table.Th key={c.campo} scope="col" ta={c.alinhamento}>
                        {c.rotulo}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {dados.linhas.map((l, i) => (
                    <Table.Tr key={config.chaveLinha(l, i)}>
                      {config.colunas.map((c) => (
                        <Table.Td key={c.campo} ta={c.alinhamento}>
                          {c.formato ? c.formato(l) : String((l as Record<string, unknown>)[c.campo] ?? '—')}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
                {dados.totais && (
                  <Table.Tfoot>
                    <Table.Tr>
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
          </Paper>
        </>
      )}
    </Stack>
  );
}
