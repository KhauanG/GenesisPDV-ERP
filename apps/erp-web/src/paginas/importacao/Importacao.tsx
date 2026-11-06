import {
  ACOES_LINHA_IMPORTACAO,
  LIMITE_ARQUIVO_IMPORTACAO,
  ROTULOS_AVISO_IMPORTACAO,
  type AcaoLinhaImportacao,
  type CodigoAvisoImportacao,
  type EstoqueResumo,
  type LinhaPreviaImportacao,
  type Pagina,
  type PreviaImportacao,
  type ResultadoImportacao,
  type TipoImportacao,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileInput,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { IconCheck, IconDownload, IconFileSpreadsheet, IconUpload } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { CampoDataHora } from '../../componentes/campos/CamposData';
import { SeletorLoja } from '../../componentes/seletores/SeletorLoja';
import { useLojaContexto } from '../../layout/lojaContexto';
import { salvarArquivo } from '../../util/arquivos';
import { formatarInteiro } from '../../util/formato';
import { ROTA_ACERTOS } from '../estoques/Acertos';

export const ROTA_IMPORTACAO = '/produtos/importacao';

interface Tarefa {
  id: string;
  status: 'na_fila' | 'executando' | 'concluida' | 'falhou';
  progressoPct: number;
  mensagem: string | null;
  resultado: ResultadoImportacao | null;
  erro: string | null;
  download: string | null;
}

const ROTULOS_ACAO: Record<AcaoLinhaImportacao, { rotulo: string; cor: string }> = {
  criar: { rotulo: 'Criar', cor: 'green' },
  atualizar: { rotulo: 'Atualizar', cor: 'blue' },
  sem_alteracao: { rotulo: 'Sem alteração', cor: 'gray' },
  inativar: { rotulo: 'Inativar', cor: 'grape' },
  ignorar: { rotulo: 'Ignorar', cor: 'red' },
};

type FiltroLinhas = 'todas' | 'erros' | 'avisos';

/** `AAAA-MM-DD HH:mm:ss` local (o formato do `DateTimePicker`). */
const paraPicker = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

/**
 * Atalhos da hora da contagem (F2-B11): a contagem com a loja fechada é a de antes de abrir ou a de depois de fechar;
 * "Agora", a da carga feita na hora. A data e a hora continuam editáveis.
 */
function atalhosContagem() {
  const agora = new Date();
  const hoje7 = new Date(agora);
  hoje7.setHours(7, 0, 0, 0);
  const ontem23 = new Date(agora);
  ontem23.setDate(ontem23.getDate() - 1);
  ontem23.setHours(23, 0, 0, 0);
  return [
    { value: paraPicker(agora), label: 'Agora' },
    ...(hoje7 < agora ? [{ value: paraPicker(hoje7), label: 'Hoje, 07:00 (antes de abrir)' }] : []),
    { value: paraPicker(ontem23), label: 'Ontem, 23:00 (depois de fechar)' },
  ];
}

/**
 * Importação de produtos e clientes por planilha (ERP 8.6, 23.14): aceita o nosso layout (8.5) e as colunas das
 * exportações do Nuvem3. Fluxo: planilha → pré-visualização (todas as linhas validadas) → Confirmar → tarefa em
 * segundo plano com o resultado e o relatório de inconsistências para download. Produto existente mostra o que muda
 * campo a campo ("O que muda"); linha igual ao cadastro fica "Sem alteração" e não é gravada.
 */
export function Importacao({ tipoInicial = 'produtos' }: { tipoInicial?: TipoImportacao }) {
  useDocumentTitle('Importação · GenesisPDV');
  const pode = usePode();
  const { lojaId: lojaContexto } = useLojaContexto();
  const tiposPermitidos = (['produtos', 'clientes'] as const).filter((t) =>
    pode(t === 'produtos' ? 'produtos.importar' : 'pessoas.importar'),
  );
  const [tipo, setTipo] = useState<TipoImportacao>(
    tiposPermitidos.includes(tipoInicial) ? tipoInicial : (tiposPermitidos[0] ?? 'produtos'),
  );
  const [lojaId, setLojaId] = useState<string | null>(lojaContexto);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [opcoes, setOpcoes] = useState({
    atualizarEstoque: false,
    atualizarEstoqueMinimo: false,
    atualizarPrecos: true,
    criarMarcasCategorias: true,
  });
  // "Atualizar estoque" (F2-B11): o estoque (vazio = o da loja; o CD, sem loja) e a hora da contagem, obrigatória.
  const [estoqueId, setEstoqueId] = useState<string | null>(null);
  const [dataContagem, setDataContagem] = useState('');
  const [previa, setPrevia] = useState<PreviaImportacao | null>(null);
  const [tarefaId, setTarefaId] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<FiltroLinhas>('todas');
  const [filtroAcao, setFiltroAcao] = useState<AcaoLinhaImportacao | null>(null);

  const estoques = useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: tipo === 'produtos' && opcoes.atualizarEstoque,
    staleTime: 60_000,
  });
  const comEstoque = tipo === 'produtos' && opcoes.atualizarEstoque;
  // A loja só é dispensada quando o estoque escolhido vai receber a contagem (a carga do CD).
  const exigeLoja = tipo === 'produtos' && !(comEstoque && estoqueId);
  const dataIso = dataContagem ? new Date(dataContagem).toISOString() : null;
  const corpoOpcoes = () => ({
    ...(tipo === 'produtos' ? { lojaId, ...opcoes } : {}),
    ...(comEstoque ? { estoqueId, dataContagem: dataIso } : {}),
  });
  const reiniciar = () => {
    setPrevia(null);
    setTarefaId(null);
  };

  const modelo = useMutation({
    mutationFn: () => apiErp.baixar(`/importacoes/${tipo}/modelo`),
    onSuccess: (a) => salvarArquivo(a.blob, a.nome),
  });
  const enviar = useMutation({
    mutationFn: () => {
      const f = new FormData();
      f.set('arquivo', arquivo!);
      for (const [k, v] of Object.entries(corpoOpcoes()))
        if (v !== null && v !== undefined) f.set(k, String(v));
      return apiErp.enviar<PreviaImportacao>(`/importacoes/${tipo}/previa`, f);
    },
    onSuccess: (p) => {
      setPrevia(p);
      // Abre em "Com erro" só se há erro: `ignorar` também conta linha sem erro (Excluir de produto inexistente).
      setFiltro(p.linhas.some((l) => l.erros.length) ? 'erros' : 'todas');
      setFiltroAcao(null);
    },
  });
  const confirmar = useMutation({
    mutationFn: () =>
      apiErp.post<{ tarefaId: string }>(`/importacoes/${tipo}/confirmar`, {
        arquivoId: previa!.arquivoId,
        ...corpoOpcoes(),
      }),
    onSuccess: (r) => setTarefaId(r.tarefaId),
  });
  const tarefa = useQuery({
    queryKey: ['tarefas', tarefaId],
    queryFn: () => apiErp.get<Tarefa>(`/tarefas/${tarefaId}`),
    enabled: !!tarefaId,
    refetchInterval: (q) =>
      q.state.data && ['concluida', 'falhou'].includes(q.state.data.status) ? false : 1000,
  });

  const erroEnvio = enviar.error ?? confirmar.error ?? modelo.error;
  const grande = arquivo && arquivo.size > LIMITE_ARQUIVO_IMPORTACAO;
  const linhas = (previa?.linhas ?? []).filter(
    (l) =>
      (filtro === 'erros' ? l.erros.length > 0 : filtro === 'avisos' ? l.avisos.length > 0 : true) &&
      (filtroAcao === null || l.acao === filtroAcao),
  );
  const t = tarefa.data;

  return (
    <Stack gap="md">
      <Title order={2} size="h3">
        Importação
      </Title>
      <Paper p="md">
        <Stack>
          {tiposPermitidos.length > 1 && (
            <SegmentedControl
              aria-label="O que importar"
              value={tipo}
              onChange={(v) => {
                setTipo(v as TipoImportacao);
                reiniciar();
              }}
              data={[
                { value: 'produtos', label: 'Produtos' },
                { value: 'clientes', label: 'Clientes' },
              ]}
              w={{ base: '100%', sm: 320 }}
            />
          )}
          <Text size="sm" c="dimmed">
            Aceita o layout da nossa exportação e as colunas das planilhas exportadas do Nuvem3 (cabeçalho na
            primeira linha; .xlsx ou .csv até 10 MB). Identificação do registro existente:{' '}
            {tipo === 'produtos'
              ? 'Id → código (IdProduto do Nuvem3) → código interno → EAN'
              : 'Id → CPF/CNPJ → código'}
            .
          </Text>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {tipo === 'produtos' && (
              <SeletorLoja
                label="Loja"
                description={
                  exigeLoja
                    ? 'Preço da loja, estoque mínimo e estoque atual'
                    : 'Opcional: só para o preço da loja e o estoque mínimo'
                }
                required={exigeLoja}
                value={lojaId}
                onChange={(v) => {
                  setLojaId(v);
                  reiniciar();
                }}
              />
            )}
            <FileInput
              label="Planilha"
              required
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              placeholder="Escolha o arquivo .xlsx ou .csv"
              leftSection={<IconFileSpreadsheet size={16} />}
              value={arquivo}
              onChange={(f) => {
                setArquivo(f);
                reiniciar();
              }}
              error={grande ? 'O arquivo passa de 10 MB' : undefined}
              clearable
            />
          </SimpleGrid>
          {tipo === 'produtos' && (
            <Group gap="lg">
              <Checkbox
                label="Atualizar estoque (a coluna Estoque atual define o saldo)"
                description={pode('estoque_acertos.criar') ? undefined : 'Exige "Acertos de estoque: Criar"'}
                disabled={!pode('estoque_acertos.criar')}
                checked={opcoes.atualizarEstoque}
                onChange={(e) => {
                  setOpcoes({ ...opcoes, atualizarEstoque: e.currentTarget.checked });
                  reiniciar();
                }}
              />
              <Checkbox
                label="Atualizar estoque mínimo"
                checked={opcoes.atualizarEstoqueMinimo}
                onChange={(e) => {
                  setOpcoes({ ...opcoes, atualizarEstoqueMinimo: e.currentTarget.checked });
                  reiniciar();
                }}
              />
              <Checkbox
                label="Atualizar preços de produtos existentes"
                checked={opcoes.atualizarPrecos}
                onChange={(e) => {
                  setOpcoes({ ...opcoes, atualizarPrecos: e.currentTarget.checked });
                  reiniciar();
                }}
              />
              <Checkbox
                label="Criar marcas e categorias inexistentes"
                description={
                  pode('marcas.criar') && pode('categorias.editar')
                    ? undefined
                    : 'Sem "Marcas: Criar"/"Categorias: Editar" a inexistente só é avisada'
                }
                checked={opcoes.criarMarcasCategorias}
                onChange={(e) => {
                  setOpcoes({ ...opcoes, criarMarcasCategorias: e.currentTarget.checked });
                  reiniciar();
                }}
              />
            </Group>
          )}
          {comEstoque && (
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <Select
                label="Estoque que recebe a contagem"
                description="Vazio = o estoque da loja. O CD (sem loja) também pode ser escolhido"
                placeholder="O estoque da loja"
                clearable
                data={(estoques.data?.itens ?? []).map((e) => ({
                  value: e.id,
                  label: e.lojaNome ? e.nome : `${e.nome} (sem loja)`,
                }))}
                value={estoqueId}
                onChange={(v) => {
                  setEstoqueId(v);
                  reiniciar();
                }}
                comboboxProps={{ withinPortal: true }}
              />
              <CampoDataHora
                label="Data/hora da contagem"
                description="Quando o estoque foi contado (ou exportado do Nuvem3): o que vendeu depois é descontado"
                required
                presets={atalhosContagem()}
                value={dataContagem}
                onChange={(v) => {
                  setDataContagem(v);
                  reiniciar();
                }}
              />
            </SimpleGrid>
          )}
          {erroEnvio && (
            <Alert color="red" role="alert">
              {erroEnvio instanceof ErroRequisicao ? erroEnvio.message : (erroEnvio as Error).message}
            </Alert>
          )}
          <Group>
            <Button
              leftSection={<IconUpload size={16} />}
              disabled={
                !arquivo || !!grande || (exigeLoja && !lojaId) || (comEstoque && !dataIso) || !!tarefaId
              }
              loading={enviar.isPending}
              onClick={() => enviar.mutate()}
            >
              Pré-visualizar
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              loading={modelo.isPending}
              onClick={() => modelo.mutate()}
            >
              Baixar modelo
            </Button>
          </Group>
        </Stack>
      </Paper>

      {previa && (
        <Paper p="md">
          <Stack>
            <Group justify="space-between">
              <Title order={3} size="h4">
                Pré-visualização · {previa.nomeArquivo}
              </Title>
              {!tarefaId && (
                <Button
                  color="green"
                  leftSection={<IconCheck size={16} />}
                  disabled={
                    previa.resumo.criar + previa.resumo.atualizar + (previa.resumo.inativar ?? 0) === 0
                  }
                  loading={confirmar.isPending}
                  onClick={() => confirmar.mutate()}
                >
                  Confirmar importação
                </Button>
              )}
            </Group>
            <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} data-testid="resumo-importacao">
              <Numero rotulo="Linhas" valor={previa.resumo.linhas} />
              <Numero rotulo="Criar" valor={previa.resumo.criar} cor="green" />
              <Numero rotulo="Atualizar" valor={previa.resumo.atualizar} cor="blue" />
              <Numero rotulo="Sem alteração" valor={previa.resumo.sem_alteracao ?? 0} cor="dimmed" />
              <Numero rotulo="Inativar" valor={previa.resumo.inativar ?? 0} cor="grape" />
              <Numero rotulo="Ignorar" valor={previa.resumo.ignorar} cor="red" />
              <Numero rotulo="Com inconsistência" valor={previa.resumo.comAviso} cor="orange" />
            </SimpleGrid>
            {Object.keys(previa.resumo.porAviso).length > 0 && (
              <Group gap="xs">
                {(Object.entries(previa.resumo.porAviso) as Array<[CodigoAvisoImportacao, number]>).map(
                  ([c, n]) => (
                    <Badge key={c} color="orange" variant="light">
                      {ROTULOS_AVISO_IMPORTACAO[c]}: {n}
                    </Badge>
                  ),
                )}
              </Group>
            )}
            <Text size="xs" c="dimmed">
              Colunas reconhecidas: {previa.colunasReconhecidas.join(', ')}
              {previa.colunasIgnoradas.length > 0 && ` · Ignoradas: ${previa.colunasIgnoradas.join(', ')}`}
            </Text>
            <Group gap="sm" align="end">
              <SegmentedControl
                aria-label="Filtrar linhas"
                size="xs"
                value={filtro}
                onChange={(v) => setFiltro(v as FiltroLinhas)}
                data={[
                  { value: 'todas', label: 'Todas' },
                  {
                    value: 'erros',
                    label: `Com erro (${previa.linhas.filter((l) => l.erros.length).length})`,
                  },
                  { value: 'avisos', label: `Com inconsistência (${previa.resumo.comAviso})` },
                ]}
                w={{ base: '100%', sm: 460 }}
              />
              <Select
                label="Ação"
                size="xs"
                placeholder="Todas"
                clearable
                value={filtroAcao}
                onChange={(v) => {
                  setFiltroAcao(v as AcaoLinhaImportacao | null);
                  // Só "Ignorar" tem linha com erro: as outras ações somadas a "Com erro" dariam uma tabela vazia.
                  if (v && v !== 'ignorar' && filtro === 'erros') setFiltro('todas');
                }}
                data={ACOES_LINHA_IMPORTACAO.map((a) => ({
                  value: a,
                  label: `${ROTULOS_ACAO[a].rotulo} (${formatarInteiro(previa.resumo[a] ?? 0)})`,
                }))}
                w={{ base: '100%', sm: 220 }}
              />
            </Group>
            <TabelaPrevia linhas={linhas} />
            {previa.resumo.linhas > previa.linhas.length && (
              <Text size="xs" c="dimmed">
                Mostrando {formatarInteiro(previa.linhas.length)} de {formatarInteiro(previa.resumo.linhas)}{' '}
                linhas (as com erro primeiro, depois as que serão gravadas); o relatório final traz todas.
              </Text>
            )}
          </Stack>
        </Paper>
      )}

      {tarefaId && (
        <Paper p="md" data-testid="resultado-importacao">
          <Stack>
            <Title order={3} size="h4">
              Importação em segundo plano
            </Title>
            {(!t || t.status === 'na_fila' || t.status === 'executando') && (
              <>
                <Progress value={t?.progressoPct ?? 0} animated aria-label="Progresso da importação" />
                <Text size="sm" c="dimmed">
                  {t?.mensagem ?? 'Na fila…'} Você pode sair desta tela: a importação continua.
                </Text>
              </>
            )}
            {t?.status === 'falhou' && (
              <Alert color="red" role="alert" title="A importação falhou">
                {t.erro}
              </Alert>
            )}
            {t?.status === 'concluida' && t.resultado && (
              <>
                <Alert color="green" title="Importação concluída">
                  {formatarInteiro(t.resultado.criados)} criado(s), {formatarInteiro(t.resultado.atualizados)}{' '}
                  atualizado(s), {formatarInteiro(t.resultado.inativados ?? 0)} inativado(s),{' '}
                  {formatarInteiro(t.resultado.semAlteracao ?? 0)} sem alteração,{' '}
                  {formatarInteiro(t.resultado.comErro)} com erro e {formatarInteiro(t.resultado.comAviso)}{' '}
                  com inconsistência.
                  {t.resultado.acertoId && (
                    <>
                      {' '}
                      Estoque definido pelo{(t.resultado.acertos?.length ?? 1) > 1 ? 's' : ''}{' '}
                      {(
                        t.resultado.acertos ?? [
                          { id: t.resultado.acertoId, codigo: t.resultado.acertoCodigo ?? 0 },
                        ]
                      ).map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ', '}
                          <Anchor component={Link} to={`${ROTA_ACERTOS}/${a.id}`}>
                            acerto Nº {a.codigo}
                          </Anchor>
                        </span>
                      ))}
                      . A aba &quot;Conferência&quot; do acerto mostra a diferença a custo e se a contagem
                      ficou dentro da tolerância.
                    </>
                  )}
                </Alert>
                {t.download && (
                  <Group>
                    <Button
                      component="a"
                      href={t.download}
                      variant="default"
                      leftSection={<IconDownload size={16} />}
                    >
                      Baixar relatório de inconsistências
                    </Button>
                  </Group>
                )}
              </>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

function Numero({ rotulo, valor, cor }: { rotulo: string; valor: number; cor?: string }) {
  return (
    <Paper withBorder p="xs">
      <Text size="xs" c="dimmed">
        {rotulo}
      </Text>
      <Text fw={700} size="lg" c={cor}>
        {formatarInteiro(valor)}
      </Text>
    </Paper>
  );
}

function TabelaPrevia({ linhas }: { linhas: LinhaPreviaImportacao[] }) {
  if (!linhas.length)
    return (
      <Text size="sm" c="dimmed">
        Nenhuma linha neste filtro.
      </Text>
    );
  return (
    <Table.ScrollContainer minWidth={860} mah={480}>
      <Table striped stickyHeader aria-label="Linhas da planilha">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={70}>Linha</Table.Th>
            <Table.Th w={150}>Ação</Table.Th>
            <Table.Th>Descrição</Table.Th>
            <Table.Th>O que muda</Table.Th>
            <Table.Th>Erros e inconsistências</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {linhas.slice(0, 500).map((l) => (
            <Table.Tr key={l.linha}>
              <Table.Td>{l.linha}</Table.Td>
              <Table.Td>
                <Badge color={ROTULOS_ACAO[l.acao].cor} variant="light" miw="fit-content">
                  {ROTULOS_ACAO[l.acao].rotulo}
                </Badge>
              </Table.Td>
              <Table.Td>{l.descricao}</Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  {(l.alteracoes ?? []).map((a) => (
                    <Text key={a.campo} size="xs">
                      <Text span size="xs" fw={600}>
                        {a.rotulo}:
                      </Text>{' '}
                      {a.de ?? '—'} → {a.para ?? '—'}
                    </Text>
                  ))}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  {l.erros.map((e) => (
                    <Text key={e} size="xs" c="red">
                      {e}
                    </Text>
                  ))}
                  {l.avisos.map((a) => (
                    <Text key={`${a.codigo}:${a.mensagem}`} size="xs" c="orange">
                      {ROTULOS_AVISO_IMPORTACAO[a.codigo]}: {a.mensagem}
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
