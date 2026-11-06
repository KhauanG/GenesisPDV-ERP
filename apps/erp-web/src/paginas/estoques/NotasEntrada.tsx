import {
  PERIODOS_NOTA_ENTRADA,
  ROTULOS_ASSINATURA_NFE,
  ROTULOS_MODALIDADE_FRETE,
  ROTULOS_STATUS_NOTA_ENTRADA,
  STATUS_NOTA_ENTRADA,
  type NotaEntradaDetalhe,
  type NotaEntradaResumo,
  type Pagina,
  type StatusNotaEntrada,
  type TipoEstoqueOpcao,
  type XmlNotaEntrada,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  List,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowLeft,
  IconBan,
  IconDownload,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { formatarDecimal } from '../../componentes/grade/decimal';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { SeletorLoja } from '../../componentes/seletores/SeletorLoja';
import { salvarArquivo } from '../../util/arquivos';
import { formatarCnpj, formatarData, formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import { Bloco, Campo } from '../vendas/comum';
import { EnvioNotasEntrada, ROTA_NOTAS_ENTRADA, useEstoques } from './NotasEntradaEnvio';
import { AbaItensNota } from './NotasEntradaItens';
import { AcoesMovimentacaoNota, type ErroAcaoNota } from './NotasEntradaMovimentar';

const CORES_STATUS: Record<StatusNotaEntrada, string> = {
  pendente: 'yellow',
  pronta: 'blue',
  movimentada: 'green',
  estornada: 'gray',
  ignorada: 'gray',
};
const OPCOES_STATUS = STATUS_NOTA_ENTRADA.map((s) => ({ value: s, label: ROTULOS_STATUS_NOTA_ENTRADA[s] }));
const ROTULOS_PERIODO: Record<(typeof PERIODOS_NOTA_ENTRADA)[number], string> = {
  emissao: 'Emissão',
  recebimento: 'Recebimento',
};
const ABAS = ['dados', 'itens', 'duplicatas', 'xml'] as const;

const reais = (v: string | number) => `R$ ${formatarDecimal(Number(v), 2)}`;
const qtd = (v: string, casas = 4) => formatarDecimal(Number(v), casas);

const badgeStatusNotaEntrada = (s: StatusNotaEntrada) => (
  <Badge color={CORES_STATUS[s]} variant="light">
    {ROTULOS_STATUS_NOTA_ENTRADA[s]}
  </Badge>
);

/** CNPJ (14) com a máscara; o CPF (11) do produtor rural também. */
const documento = (v: string) =>
  v.length === 11 ? `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}` : formatarCnpj(v);

/**
 * O XML com uma marca por linha e recuo de 2 espaços por nível (a aba XML; o arquivo baixado é o original). Texto
 * entre as marcas fica na linha da marca que o abre; comentários e a declaração ficam como vieram.
 */
export function formatarXml(xml: string): string {
  const partes = xml
    .replace(/>\s+</g, '><')
    .trim()
    .split(/(?=<)|(?<=>)/)
    .filter((p) => p.length);
  const linhas: string[] = [];
  let nivel = 0;
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i]!;
    const recuo = (n: number) => '  '.repeat(Math.max(0, n));
    if (p.startsWith('</')) {
      nivel--;
      linhas.push(recuo(nivel) + p);
    } else if (p.startsWith('<?') || p.startsWith('<!') || p.endsWith('/>')) {
      linhas.push(recuo(nivel) + p);
    } else if (p.startsWith('<')) {
      // `<a>texto</a>` numa linha só.
      const texto = partes[i + 1];
      const fecha = partes[i + 2];
      if (texto !== undefined && !texto.startsWith('<') && fecha?.startsWith('</')) {
        linhas.push(recuo(nivel) + p + texto + fecha);
        i += 2;
      } else {
        linhas.push(recuo(nivel) + p);
        nivel++;
      }
    } else linhas.push(recuo(nivel) + p);
  }
  return linhas.join('\n');
}

/**
 * Recebimento de NF-e – listagem (ERP 13.4; Fase 2, F2-B19; README do ERP › decisão 59): o upload por arrastar no
 * topo (com `notas_entrada.importar`) e as notas com os filtros Nome (emitente), Loja, Período (emissão ou
 * recebimento), Situação e Número/Chave. Sem "Pela Sefaz" e sem a coluna Manifestação (restrição do dono).
 */
export function ListaNotasEntrada() {
  const pode = usePode();
  const config = useMemo<ConfigListagem<NotaEntradaResumo>>(
    () => ({
      recurso: 'notas_entrada',
      titulo: 'Recebimento de NF-e',
      ordenacaoPadrao: 'recebimento:desc',
      permissaoNovo: null,
      rotaEdicao: (n) => `${ROTA_NOTAS_ENTRADA}/${n.id}`,
      chaveLinha: (n) => n.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto', placeholder: 'Razão social ou fantasia do emitente' },
        { campo: 'lojaId', rotulo: 'Loja', tipo: 'loja' },
        {
          campo: 'periodo',
          rotulo: 'Período',
          tipo: 'selecao',
          padrao: 'emissao',
          opcoes: PERIODOS_NOTA_ENTRADA.map((p) => ({ value: p, label: ROTULOS_PERIODO[p] })),
        },
        { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data' },
        { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data' },
        { campo: 'status', rotulo: 'Situação', tipo: 'selecao', opcoes: OPCOES_STATUS },
        { campo: 'numeroChave', rotulo: 'Número / Chave', tipo: 'texto' },
      ],
      colunas: [
        // A primeira coluna já é o link para a nota (`<Listagem>`).
        {
          campo: 'emitente',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (n) => n.emitenteFantasia ?? n.emitenteNome,
        },
        {
          campo: 'recebimento',
          rotulo: 'Data recebimento',
          ordenavel: true,
          formato: (n) => formatarDataHora(n.dataRecebimento),
        },
        {
          campo: 'movimentacao',
          rotulo: 'Data movimentação',
          ordenavel: true,
          formato: (n) => formatarDataHora(n.dataMovimentacao),
        },
        {
          campo: 'numero',
          rotulo: 'Número/Série',
          ordenavel: true,
          formato: (n) => `${n.numero}/${n.serie}`,
        },
        { campo: 'loja', rotulo: 'Loja', ordenavel: true, formato: (n) => n.lojaNome },
        {
          campo: 'total',
          rotulo: 'Valor total',
          ordenavel: true,
          alinhamento: 'right',
          formato: (n) => reais(n.valorTotal),
        },
        {
          campo: 'status',
          rotulo: 'Situação',
          ordenavel: true,
          formato: (n) => badgeStatusNotaEntrada(n.status),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<NotaEntradaResumo>>(`/notas-entrada${query(params)}`, { sinal }),
    }),
    [],
  );
  return (
    <Stack gap="lg">
      {pode('notas_entrada.importar') && <EnvioNotasEntrada />}
      <Listagem config={config} />
    </Stack>
  );
}

/**
 * Aba Dados: a troca de loja e estoque de destino entre os permitidos (nota pendente ou pronta). Montado com a versão
 * da nota na `key`: a nota regravada (aqui ou pelo Ignorar/Reabrir) recomeça os campos com o destino gravado.
 */
function DestinoNota({ nota, podeAlterar }: { nota: NotaEntradaDetalhe; podeAlterar: boolean }) {
  const queryClient = useQueryClient();
  const estoques = useEstoques();
  const tipos = useQuery({
    queryKey: ['opcoes', 'tipos-estoque'],
    queryFn: () => apiErp.get<TipoEstoqueOpcao[]>('/tipos-estoque'),
    staleTime: 5 * 60_000,
  });
  const [lojaId, setLojaId] = useState<string | null>(nota.lojaId);
  const [estoqueId, setEstoqueId] = useState<string | null>(nota.estoqueId);
  const [tipoEstoqueId, setTipoEstoqueId] = useState<string | null>(nota.tipoEstoqueId);
  const [erros, setErros] = useState<Record<string, string>>({});
  const salvar = useMutation({
    mutationFn: () =>
      apiErp.put<NotaEntradaDetalhe>(`/notas-entrada/${nota.id}/destino`, {
        versao: nota.versao,
        lojaId,
        estoqueId,
        tipoEstoqueId,
      }),
    onSuccess: (d) => {
      setErros({});
      queryClient.setQueryData(['nota-entrada', nota.id], d);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
      notifications.show({ color: 'green', message: 'Destino da nota alterado.' });
    },
    onError: (e) => {
      if (e instanceof ErroRequisicao && e.campos)
        setErros(Object.fromEntries(Object.entries(e.campos).map(([k, v]) => [k, v[0] ?? ''])));
    },
  });
  const opcoesEstoque = (estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome }));
  if (!opcoesEstoque.some((o) => o.value === nota.estoqueId))
    opcoesEstoque.push({ value: nota.estoqueId, label: nota.estoqueNome });
  const opcoesTipo = (tipos.data ?? [])
    .filter((t) => t.ativo || t.id === nota.tipoEstoqueId)
    .map((t) => ({ value: t.id, label: t.nome }));
  if (!opcoesTipo.some((o) => o.value === nota.tipoEstoqueId))
    opcoesTipo.push({ value: nota.tipoEstoqueId, label: nota.tipoEstoqueNome });
  const mudou =
    lojaId !== nota.lojaId || estoqueId !== nota.estoqueId || tipoEstoqueId !== nota.tipoEstoqueId;
  if (!podeAlterar)
    return (
      <Bloco titulo="Destino">
        <Campo rotulo="Loja">{nota.lojaNome}</Campo>
        <Campo rotulo="Estoque de destino">{nota.estoqueNome}</Campo>
        <Campo rotulo="Tipo de estoque">{nota.tipoEstoqueNome}</Campo>
      </Bloco>
    );
  return (
    <Bloco titulo="Destino">
      <Stack gap="xs">
        <SeletorLoja label="Loja" required value={lojaId} onChange={setLojaId} error={erros.lojaId} />
        <Select
          label="Estoque de destino"
          required
          allowDeselect={false}
          data={opcoesEstoque}
          value={estoqueId}
          onChange={setEstoqueId}
          error={erros.estoqueId}
        />
        <Select
          label="Tipo de estoque"
          required
          allowDeselect={false}
          data={opcoesTipo}
          value={tipoEstoqueId}
          onChange={setTipoEstoqueId}
          error={erros.tipoEstoqueId}
        />
        {salvar.error && !(salvar.error instanceof ErroRequisicao && salvar.error.campos) && (
          <Text size="sm" c="red">
            {(salvar.error as Error).message}
          </Text>
        )}
        <Group justify="flex-end">
          <Button
            size="xs"
            disabled={!mudou || !lojaId}
            loading={salvar.isPending}
            onClick={() => salvar.mutate()}
          >
            Salvar destino
          </Button>
        </Group>
      </Stack>
    </Bloco>
  );
}

/** Aba XML: o XML enviado formatado e o download do arquivo original. */
function AbaXml({ nota }: { nota: NotaEntradaDetalhe }) {
  const r = useQuery({
    queryKey: ['nota-entrada-xml', nota.id],
    queryFn: ({ signal }) => apiErp.get<XmlNotaEntrada>(`/notas-entrada/${nota.id}/xml`, { sinal: signal }),
    staleTime: Infinity,
  });
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!r.data) return <Skeleton h={200} />;
  const { xml, nomeArquivo } = r.data;
  return (
    <Stack gap="sm">
      <Group justify="flex-end">
        <Button
          variant="default"
          leftSection={<IconDownload size={16} />}
          onClick={() => salvarArquivo(new Blob([xml], { type: 'application/xml' }), nomeArquivo)}
        >
          Baixar XML
        </Button>
      </Group>
      <ScrollArea h={520} type="auto">
        <Code block aria-label="XML da nota">
          {formatarXml(xml)}
        </Code>
      </ScrollArea>
    </Stack>
  );
}

/**
 * Recebimento de NF-e – a nota importada (ERP 13.4; F2-B19): abas Dados da nota (emitente, fornecedor, totais,
 * transporte, protocolo, assinatura e o destino editável), Itens e vinculação (F2-B20, `AbaItensNota`), Duplicatas
 * (somente leitura) e XML (formatado e download). "Ignorar nota" (com motivo) e "Reabrir" no cabeçalho, e desde o
 * F2-B21 "Movimentar" e "Estornar" (`AcoesMovimentacaoNota`), com quem movimentou e o estorno abaixo do título.
 */
export function FormularioNotaEntrada() {
  const { id, aba } = useParams();
  const navigate = useNavigate();
  const pode = usePode();
  const queryClient = useQueryClient();
  const [ignorando, setIgnorando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [erroMovimentacao, setErroMovimentacao] = useState<ErroAcaoNota | null>(null);
  const r = useQuery({
    queryKey: ['nota-entrada', id],
    queryFn: ({ signal }) => apiErp.get<NotaEntradaDetalhe>(`/notas-entrada/${id}`, { sinal: signal }),
    enabled: !!id,
  });
  const n = r.data;
  useDocumentTitle(`${n ? `NF-e ${n.numero}` : 'NF-e'} · GenesisPDV`);
  const acao = useMutation({
    mutationFn: (tipo: 'ignorar' | 'reabrir') =>
      apiErp.post<NotaEntradaDetalhe>(
        `/notas-entrada/${id}/${tipo}`,
        tipo === 'ignorar' ? { versao: n!.versao, motivo } : { versao: n!.versao },
      ),
    onSuccess: (d, tipo) => {
      queryClient.setQueryData(['nota-entrada', id], d);
      void queryClient.invalidateQueries({ queryKey: ['listagem', 'notas_entrada'] });
      setIgnorando(false);
      setMotivo('');
      notifications.show({
        color: 'green',
        message: tipo === 'ignorar' ? 'Nota ignorada.' : 'Nota reaberta.',
      });
    },
  });
  const atual = (ABAS as readonly string[]).includes(aba ?? '') ? aba! : 'dados';
  if (r.error instanceof ErroRequisicao && r.error.status === 404)
    return <NaoEncontrado inicio={ROTA_NOTAS_ENTRADA} />;
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (!n) return <Skeleton h={300} />;
  const podeImportar = pode('notas_entrada.importar');
  const aberta = n.status === 'pendente' || n.status === 'pronta';
  const t = n.totais;
  return (
    <Stack gap="md">
      <Anchor component={Link} to={ROTA_NOTAS_ENTRADA} size="sm">
        <Group gap={4}>
          <IconArrowLeft size={14} /> Recebimento de NF-e
        </Group>
      </Anchor>
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <Title order={2} size="h3">
            NF-e Nº {n.numero}/{n.serie} – {n.emitenteFantasia ?? n.emitenteNome}
          </Title>
          {badgeStatusNotaEntrada(n.status)}
        </Group>
        <Group gap="xs">
          <AcoesMovimentacaoNota nota={n} aoErro={setErroMovimentacao} />
          {podeImportar && aberta && (
            <Button
              variant="default"
              color="red"
              leftSection={<IconBan size={16} />}
              onClick={() => setIgnorando(true)}
            >
              Ignorar nota
            </Button>
          )}
          {podeImportar && n.status === 'ignorada' && (
            <Button
              variant="default"
              leftSection={<IconArrowBackUp size={16} />}
              loading={acao.isPending}
              onClick={() => acao.mutate('reabrir')}
            >
              Reabrir
            </Button>
          )}
        </Group>
      </Group>
      {n.dataMovimentacao && (
        <Text size="sm" c="dimmed" data-testid="movimentacao-nota">
          Movimentada em {formatarDataHora(n.dataMovimentacao)} por {n.movimentadaPorNome ?? '—'}.
          {n.estornadaEm &&
            ` Estornada em ${formatarDataHora(n.estornadaEm)} por ${n.estornadaPorNome ?? '—'}: ${n.motivoEstorno ?? ''}`}
        </Text>
      )}
      {erroMovimentacao && (
        <Alert color="red" role="alert" withCloseButton onClose={() => setErroMovimentacao(null)}>
          {erroMovimentacao.mensagem}
          {erroMovimentacao.itens.length > 0 && (
            <List size="sm" mt="xs" data-testid="erros-itens-movimentacao">
              {erroMovimentacao.itens.map((i, k) => (
                <List.Item key={k}>
                  Item {i.numeroItem}: {i.mensagem}
                </List.Item>
              ))}
            </List>
          )}
        </Alert>
      )}
      {n.status === 'ignorada' && (
        <Alert color="gray" title="Nota ignorada">
          Motivo: {n.motivoIgnorada ?? '—'}
        </Alert>
      )}
      {n.avisos.map((a) => (
        <Alert key={a} color="yellow" icon={<IconAlertTriangle size={18} />} p="xs">
          {a}
        </Alert>
      ))}
      {acao.error && !ignorando && <Alert color="red">{(acao.error as Error).message}</Alert>}
      <Tabs
        value={atual}
        onChange={(a) => navigate(`${ROTA_NOTAS_ENTRADA}/${n.id}/${a ?? 'dados'}`, { replace: true })}
      >
        <Tabs.List>
          <Tabs.Tab value="dados">Dados da nota</Tabs.Tab>
          <Tabs.Tab value="itens">
            Itens e vinculação ({n.vinculacao.resolvidos}/{n.vinculacao.total})
          </Tabs.Tab>
          <Tabs.Tab value="duplicatas">Duplicatas ({n.duplicatas.length})</Tabs.Tab>
          <Tabs.Tab value="xml">XML</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="dados" pt="md">
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            <Bloco titulo="Nota">
              <Campo rotulo="Número/Série">
                {n.numero}/{n.serie}
              </Campo>
              <Campo rotulo="Chave">
                <Text size="xs" ff="monospace">
                  {n.chave}
                </Text>
              </Campo>
              <Campo rotulo="Emissão">{formatarDataHora(n.dataEmissao)}</Campo>
              <Campo rotulo="Recebimento">{formatarDataHora(n.dataRecebimento)}</Campo>
              <Campo rotulo="Natureza da operação">{n.naturezaOperacao ?? '—'}</Campo>
              <Campo rotulo="Protocolo">
                {n.protocoloNumero} ({formatarDataHora(n.protocoloData)})
              </Campo>
              <Campo rotulo="Assinatura">{ROTULOS_ASSINATURA_NFE[n.assinatura]}</Campo>
              <Campo rotulo="Importada por">{n.criadoPorNome ?? '—'}</Campo>
            </Bloco>
            <Bloco titulo="Emitente">
              <Campo rotulo="Razão social">{n.emitenteNome}</Campo>
              <Campo rotulo="Fantasia">{n.emitenteFantasia ?? '—'}</Campo>
              <Campo rotulo="CNPJ/CPF">{documento(n.emitenteCnpj)}</Campo>
              <Campo rotulo="IE / UF">
                {n.emitenteIe ?? '—'} / {n.emitenteUf}
              </Campo>
              <Campo rotulo="Fornecedor">
                {pode('pessoas.ver') ? (
                  <Anchor component={Link} to={`/pessoas/${n.fornecedorId}`} size="sm">
                    {n.fornecedor.codigo} - {n.fornecedor.nome}
                  </Anchor>
                ) : (
                  `${n.fornecedor.codigo} - ${n.fornecedor.nome}`
                )}
              </Campo>
              <Campo rotulo="Destinatário (CNPJ)">{documento(n.destinatarioCnpj)}</Campo>
            </Bloco>
            <DestinoNota key={`${n.id}-${n.versao}`} nota={n} podeAlterar={podeImportar && aberta} />
            <Bloco titulo="Totais">
              <Campo rotulo="Produtos">{reais(t.produtos)}</Campo>
              <Campo rotulo="Frete">{reais(t.frete)}</Campo>
              <Campo rotulo="Seguro">{reais(t.seguro)}</Campo>
              <Campo rotulo="Desconto">{reais(t.desconto)}</Campo>
              <Campo rotulo="Outras despesas">{reais(t.outras)}</Campo>
              <Campo rotulo="IPI">{reais(t.ipi)}</Campo>
              <Campo rotulo="ICMS ST">{reais(t.icmsSt)}</Campo>
              <Campo rotulo="FCP ST">{reais(t.fcpSt)}</Campo>
              <Campo rotulo="Total da nota">
                <Text fw={700} size="sm">
                  {reais(t.total)}
                </Text>
              </Campo>
            </Bloco>
            <Bloco titulo="Transporte">
              <Campo rotulo="Frete">
                {n.modalidadeFrete ? (ROTULOS_MODALIDADE_FRETE[n.modalidadeFrete] ?? n.modalidadeFrete) : '—'}
              </Campo>
              <Campo rotulo="Transportadora">
                {n.transportadoraNome ?? '—'}
                {n.transportadoraCnpj ? ` (${documento(n.transportadoraCnpj)})` : ''}
              </Campo>
              {n.volumes.map((v, i) => (
                <Campo key={i} rotulo={`Volume ${i + 1}`}>
                  {[v.quantidade, v.especie, v.marca].filter(Boolean).join(' ') || '—'}
                  {v.pesoBruto ? ` · ${qtd(v.pesoBruto, 3)} kg` : ''}
                </Campo>
              ))}
            </Bloco>
            <Bloco titulo="Itens">
              <Campo rotulo="Quantidade de itens">{n.itens.length}</Campo>
              <Campo rotulo="Resolvidos">
                {n.vinculacao.resolvidos} de {n.vinculacao.total}
              </Campo>
              <Text size="xs" c="dimmed">
                A vinculação dos itens aos produtos fica na aba "Itens e vinculação".
              </Text>
            </Bloco>
          </SimpleGrid>
          {n.informacoesComplementares && (
            <Alert color="gray" title="Informações complementares" mt="md">
              {n.informacoesComplementares}
            </Alert>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="itens" pt="md">
          {/* Sempre montada (o painel escondido guarda o que foi digitado ao trocar de aba). */}
          <AbaItensNota
            key={`${n.id}-${n.versao}`}
            nota={n}
            podeEditar={podeImportar && aberta}
            errosAcao={erroMovimentacao?.campos}
          />
        </Tabs.Panel>
        <Tabs.Panel value="duplicatas" pt="md">
          {n.duplicatas.length ? (
            <Table striped aria-label="Duplicatas da nota" maw={560}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>#</Table.Th>
                  <Table.Th>Número</Table.Th>
                  <Table.Th>Vencimento</Table.Th>
                  <Table.Th ta="right">Valor</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {n.duplicatas.map((d) => (
                  <Table.Tr key={d.sequencia}>
                    <Table.Td>{d.sequencia}</Table.Td>
                    <Table.Td>{d.numero ?? '—'}</Table.Td>
                    <Table.Td>{formatarData(d.vencimento)}</Table.Td>
                    <Table.Td ta="right">{reais(d.valor)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text c="dimmed" size="sm">
              A nota não tem duplicatas (cobr/dup).
            </Text>
          )}
          <Text size="xs" c="dimmed" mt="xs">
            Somente leitura: as duplicatas viram contas a pagar na Fase 4.
          </Text>
        </Tabs.Panel>
        <Tabs.Panel value="xml" pt="md">
          {atual === 'xml' && <AbaXml nota={n} />}
        </Tabs.Panel>
      </Tabs>
      <Modal opened={ignorando} onClose={() => setIgnorando(false)} title="Ignorar nota">
        <Stack>
          <Text size="sm">
            A nota sai das pendentes e a chave continua ocupada: para trazê-la de volta, use "Reabrir".
          </Text>
          <Textarea
            label="Motivo"
            required
            autosize
            minRows={2}
            maxLength={255}
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
          />
          {acao.error && (
            <Text c="red" size="sm">
              {(acao.error as Error).message}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setIgnorando(false)}>
              Voltar
            </Button>
            <Button
              color="red"
              disabled={!motivo.trim()}
              loading={acao.isPending}
              onClick={() => acao.mutate('ignorar')}
            >
              Ignorar nota
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
