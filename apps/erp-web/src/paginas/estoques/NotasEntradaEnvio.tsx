import {
  AVISO_SEM_SEFAZ,
  LIMITES_UPLOAD_NFE,
  MENSAGEM_ENVIO_GRANDE_NFE,
  ROTULOS_SITUACAO_ARQUIVO_NFE,
  TETO_UPLOAD_NFE_TEXTO,
  tarefaEmAndamento,
  type EstoqueResumo,
  type Pagina,
  type ResultadoArquivoNfe,
  type ResultadoImportacaoNfe,
  type SituacaoArquivoNfe,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  CloseButton,
  FileButton,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileUpload, IconInfoCircle, IconUpload } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { AndamentoTarefa } from '../../componentes/tarefas/AndamentoTarefa';
import { CHAVE_LISTA_TAREFAS, useTarefa } from '../../componentes/tarefas/tarefas';

export const ROTA_NOTAS_ENTRADA = '/estoque/notas-entrada';

const CORES_SITUACAO: Record<SituacaoArquivoNfe, string> = {
  importada: 'green',
  duplicada: 'yellow',
  recusada: 'red',
};
const EXTENSOES = /\.(xml|zip)$/i;
const MB = 1024 * 1024;

/** Os estoques ativos (o "Estoque de destino" do envio e o Destino da aba Dados). */
export function useEstoques() {
  return useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    staleTime: 60_000,
  });
}

/** Junta os arquivos novos aos já escolhidos (o mesmo nome e tamanho entra uma vez só). */
export function juntarArquivos(atuais: readonly File[], novos: readonly File[]): File[] {
  const r = [...atuais];
  for (const f of novos)
    if (!r.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified))
      r.push(f);
  return r;
}

/** O que a tela recusa antes de enviar: o tipo, a quantidade e o tamanho do envio (a API confere de novo). */
export function problemaDoEnvio(arquivos: readonly File[]): string | null {
  const outros = arquivos.filter((f) => !EXTENSOES.test(f.name));
  if (outros.length) return `Só .xml e .zip: ${outros.map((f) => f.name).join(', ')}.`;
  if (arquivos.length > LIMITES_UPLOAD_NFE.arquivos)
    return `No máximo ${LIMITES_UPLOAD_NFE.arquivos} arquivos por envio (use um .zip).`;
  const total = arquivos.reduce((s, f) => s + f.size, 0);
  if (total > LIMITES_UPLOAD_NFE.bytes) return MENSAGEM_ENVIO_GRANDE_NFE;
  return null;
}

function TabelaResultados({ resultados }: { resultados: ResultadoArquivoNfe[] }) {
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table striped aria-label="Resultado da importação">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Arquivo</Table.Th>
            <Table.Th>Situação</Table.Th>
            <Table.Th>Nota</Table.Th>
            <Table.Th>Emitente</Table.Th>
            <Table.Th ta="right">Valor</Table.Th>
            <Table.Th>Detalhe</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {resultados.map((r, i) => (
            <Table.Tr key={`${r.arquivo}-${i}`}>
              <Table.Td>{r.arquivo}</Table.Td>
              <Table.Td>
                <Badge color={CORES_SITUACAO[r.situacao]} variant="light">
                  {ROTULOS_SITUACAO_ARQUIVO_NFE[r.situacao]}
                </Badge>
              </Table.Td>
              <Table.Td>
                {r.notaId ? (
                  <Anchor component={Link} to={`${ROTA_NOTAS_ENTRADA}/${r.notaId}`} size="sm">
                    {r.numero !== null ? `Nº ${r.numero}/${r.serie}` : `Nota ${r.notaCodigo}`}
                  </Anchor>
                ) : r.numero !== null ? (
                  `Nº ${r.numero}/${r.serie}`
                ) : (
                  '—'
                )}
              </Table.Td>
              <Table.Td>{r.emitenteNome ?? '—'}</Table.Td>
              <Table.Td ta="right">
                {r.valorTotal !== null ? `R$ ${formatarDecimal(Number(r.valorTotal), 2)}` : '—'}
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  {r.mensagem && (
                    <Text size="sm" c={r.situacao === 'recusada' ? 'red' : undefined}>
                      {r.mensagem}
                    </Text>
                  )}
                  {r.fornecedorCriado && (
                    <Text size="sm" c="dimmed">
                      Fornecedor cadastrado pelo emitente.
                    </Text>
                  )}
                  {r.avisos.map((a) => (
                    <Text key={a.motivo} size="sm" c="orange">
                      {a.mensagem}
                      {a.detalhe ? ` (${a.detalhe})` : ''}
                    </Text>
                  ))}
                </Stack>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/** O resultado de um envio (o direto ou o da tarefa): o resumo e cada arquivo. */
function PainelResultado({
  resultado,
  aoFechar,
}: {
  resultado: ResultadoImportacaoNfe;
  aoFechar: () => void;
}) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Resultado: {resultado.resumo.importadas} importada(s), {resultado.resumo.duplicadas} já
          importada(s), {resultado.resumo.recusadas} recusada(s)
        </Text>
        <CloseButton aria-label="Fechar o resultado" onClick={aoFechar} />
      </Group>
      <TabelaResultados resultados={resultado.resultados} />
    </Paper>
  );
}

/**
 * O lote grande em segundo plano (tarefa `importar_xml_nfe`): a própria tela acompanha `GET /tarefas/:id` até a
 * tarefa terminar, com o progresso (o componente comum das tarefas, F2-B30), e no fim mostra o resultado de cada
 * arquivo (o mesmo do envio direto) ou a mensagem da falha (ex.: quem pediu perdeu a permissão ou o estoque). A mesma
 * tarefa aparece no ícone Tarefas do cabeçalho.
 */
function AcompanharTarefa({ tarefaId, aoFechar }: { tarefaId: string; aoFechar: () => void }) {
  const queryClient = useQueryClient();
  const tarefa = useTarefa<ResultadoImportacaoNfe>(tarefaId);
  const t = tarefa.data;
  const terminou = t?.status === 'concluida' || t?.status === 'falhou';
  useEffect(() => {
    // As notas da tarefa entram na listagem quando ela termina.
    if (terminou) void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
  }, [terminou, queryClient]);
  if (t?.status === 'concluida' && t.resultado)
    return <PainelResultado resultado={t.resultado} aoFechar={aoFechar} />;
  return (
    <Paper withBorder p="sm" radius="md" data-testid="tarefa-importacao-nfe">
      <Group justify="space-between" mb="xs">
        <Text fw={600} size="sm">
          Importação em segundo plano
        </Text>
        {/* Com a consulta falhando, também dá para fechar (a tarefa continua no ícone Tarefas). */}
        {((t && !tarefaEmAndamento(t)) || tarefa.isError) && (
          <CloseButton aria-label="Fechar o resultado" onClick={aoFechar} />
        )}
      </Group>
      <AndamentoTarefa
        tarefa={t}
        erroConsulta={tarefa.error}
        aoTentarNovamente={() => void tarefa.refetch()}
        tentando={tarefa.isFetching}
        rotulo="importação"
        aviso="São muitas notas: o resultado de cada arquivo aparece aqui quando terminar."
      />
    </Paper>
  );
}

/**
 * Upload das NF-e por arquivo (ERP 13.4 "Por Arquivo"; Fase 2, F2-B19; README do ERP › decisão 59): arrastar ou
 * escolher um ou vários `.xml` ou `.zip` (até 20 MB no envio), o estoque de destino opcional (vazio = o estoque da
 * loja do CNPJ do destinatário de cada nota) e "Importar NF". O resultado mostra cada arquivo (importada, já importada
 * com o link para a nota, ou recusada com o motivo); o lote grande vira tarefa, acompanhada aqui mesmo, com o mesmo
 * resultado quando termina.
 */
export function EnvioNotasEntrada() {
  const queryClient = useQueryClient();
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [estoqueId, setEstoqueId] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoImportacaoNfe | null>(null);
  const estoques = useEstoques();
  const problema = problemaDoEnvio(arquivos);
  const importar = useMutation({
    mutationFn: () => {
      const f = new FormData();
      if (estoqueId) f.set('estoqueId', estoqueId);
      for (const a of arquivos) f.append('arquivos', a);
      return apiErp.enviar<ResultadoImportacaoNfe>('/notas-entrada/importar', f);
    },
    onSuccess: (r) => {
      setArquivos([]);
      setResultado(r);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
      if (r.tarefaId) {
        // O ícone Tarefas passa a contar (e acompanhar) o lote.
        void queryClient.invalidateQueries({ queryKey: CHAVE_LISTA_TAREFAS });
        notifications.show({
          color: 'blue',
          title: 'Importação em segundo plano',
          message: 'São muitas notas: acompanhe o progresso abaixo da área de envio ou no ícone Tarefas.',
        });
      }
    },
  });

  function soltar(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setArrastando(false);
    setArquivos((atuais) => juntarArquivos(atuais, [...e.dataTransfer.files]));
  }

  return (
    <Stack gap="sm">
      <Paper
        withBorder
        p="md"
        radius="md"
        data-testid="area-envio-nfe"
        style={{
          borderStyle: 'dashed',
          borderWidth: 2,
          background: arrastando ? 'var(--mantine-color-blue-light)' : undefined,
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={soltar}
      >
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <IconFileUpload size={32} stroke={1.5} />
            <div>
              <Text fw={600}>Importar NF-e por arquivo</Text>
              <Text size="sm" c="dimmed">
                Arraste aqui os XMLs das notas (ou um .zip com vários), até {TETO_UPLOAD_NFE_TEXTO} por envio,
                ou escolha os arquivos. Cada nota entra na loja do CNPJ do destinatário (inclusive o CD).
              </Text>
            </div>
          </Group>
          <Group align="flex-end" gap="sm" wrap="wrap">
            <FileButton
              onChange={(f) => setArquivos((a) => juntarArquivos(a, f))}
              accept=".xml,.zip"
              multiple
            >
              {(props) => (
                <Button variant="default" leftSection={<IconUpload size={16} />} {...props}>
                  Escolher arquivos
                </Button>
              )}
            </FileButton>
            <Select
              label="Estoque de destino"
              placeholder="O estoque da loja de cada nota"
              clearable
              w={280}
              data={(estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome }))}
              value={estoqueId}
              onChange={setEstoqueId}
              comboboxProps={{ withinPortal: true }}
            />
            <Button
              onClick={() => importar.mutate()}
              disabled={!arquivos.length || !!problema}
              loading={importar.isPending}
            >
              Importar NF
            </Button>
          </Group>
          {arquivos.length > 0 && (
            <Group gap="xs" aria-label="Arquivos escolhidos">
              {arquivos.map((f) => (
                <Badge
                  key={`${f.name}-${f.size}-${f.lastModified}`}
                  variant="outline"
                  rightSection={
                    <CloseButton
                      size="xs"
                      aria-label={`Tirar ${f.name}`}
                      onClick={() => setArquivos((a) => a.filter((x) => x !== f))}
                    />
                  }
                >
                  {f.name} ({formatarDecimal(f.size / MB, 2)} MB)
                </Badge>
              ))}
            </Group>
          )}
          {problema && arquivos.length > 0 && (
            <Text size="sm" c="red">
              {problema}
            </Text>
          )}
          {importar.error && (
            <Alert color="red" title="Não foi possível importar">
              {(importar.error as Error).message}
            </Alert>
          )}
        </Stack>
      </Paper>
      <Alert color="yellow" icon={<IconInfoCircle size={18} />} p="xs">
        {AVISO_SEM_SEFAZ}
      </Alert>
      {resultado?.tarefaId ? (
        <AcompanharTarefa
          key={resultado.tarefaId}
          tarefaId={resultado.tarefaId}
          aoFechar={() => setResultado(null)}
        />
      ) : (
        resultado && <PainelResultado resultado={resultado} aoFechar={() => setResultado(null)} />
      )}
    </Stack>
  );
}
