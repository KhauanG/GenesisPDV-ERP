import {
  alterarTransferenciaSchema,
  criarTransferenciaSchema,
  dec,
  hojeNoFuso,
  PERIODOS_TRANSFERENCIA,
  ROTULOS_PERIODO_TRANSFERENCIA,
  ROTULOS_STATUS_TRANSFERENCIA,
  ROTULOS_TRATAMENTO_DIVERGENCIA,
  STATUS_TRANSFERENCIA,
  TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA,
  type DadosProdutosTransferencia,
  type DestinoTransferenciaOpcao,
  type OrigemTransferenciaOpcao,
  type Pagina,
  type ProdutoOpcao,
  type StatusTransferencia,
  type SugestaoReposicao,
  type TipoEstoqueOpcao,
  type TransferenciaDetalhe,
  type TransferenciaResumo,
} from '@genesis/shared';
import {
  Alert,
  Badge,
  Button,
  Grid,
  Group,
  Modal,
  NativeSelect,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconBulb,
  IconCircleCheck,
  IconFileInvoice,
  IconPrinter,
  IconScale,
  IconTruckDelivery,
  IconX,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useCadastro } from '../../componentes/cadastro';
import { CampoData } from '../../componentes/campos/CamposData';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { formatarDecimal, textoDecimal } from '../../componentes/grade/decimal';
import { GradeItens, type ColunaGrade } from '../../componentes/grade/GradeItens';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { errosDaApi } from '../../util/erros';
import { formatarData, formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import {
  acoesTransferencia,
  COLUNA_DO_CAMPO_TRANSFERENCIA,
  corpoConferencia,
  corpoTratamento,
  dadosTransferenciaEmBlocos,
  diferencaConferencia,
  errosConferencia,
  errosLinhaTransferencia,
  itemTransferenciaParaApi,
  linhasConferencia,
  linhasTratamento,
  linhaVaziaTransferencia,
  mesclarSugestao,
  novaLinhaTransferencia,
  quantidadeNaEmbalagem,
  quantidadeParaTela,
  TIPOS_TRANSFERENCIA,
  type LinhaConferencia,
  type LinhaTransferencia,
  type LinhaTratamento,
} from './transferenciaItens';

export const ROTA_TRANSFERENCIAS = '/estoque/transferencias';
/** O romaneio impresso pelo navegador (aba nova; padrão "Impressão" do plano da Fase 2). */
export const urlRomaneioTransferencia = (id: string) => `${ROTA_TRANSFERENCIAS}/${id}/romaneio?imprimir=1`;

const CORES_STATUS: Record<StatusTransferencia, string> = {
  rascunho: 'yellow',
  em_transito: 'blue',
  recebida: 'green',
  recebida_divergencia: 'orange',
  cancelada: 'gray',
};
const OPCOES_STATUS = STATUS_TRANSFERENCIA.map((s) => ({ value: s, label: ROTULOS_STATUS_TRANSFERENCIA[s] }));
const OPCOES_PERIODO = PERIODOS_TRANSFERENCIA.map((p) => ({
  value: p,
  label: ROTULOS_PERIODO_TRANSFERENCIA[p],
}));

const qtd = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : formatarDecimal(Number(v), 3);
/** O texto alinhado à esquerda numa coluna `leitura` da grade (que alinha à direita). */
const aEsquerda = (conteudo: string) => (
  <span style={{ display: 'block', textAlign: 'left' }}>{conteudo}</span>
);

/**
 * Os estoques permitidos de quem está na tela (`GET /transferencias/origens`, só `transferencias.ver`; também os
 * inativos, marcados): o filtro "Estoque origem" e o seletor "Origem" (os ativos). Não usa o `GET /estoques`, que
 * exige `estoques.ver` (o cadastro de locais), que o conferente da loja ou o expedidor do CD pode não ter.
 */
function useOrigens() {
  return useQuery({
    queryKey: ['opcoes', 'transferencia-origens'],
    queryFn: () => apiErp.get<OrigemTransferenciaOpcao[]>('/transferencias/origens'),
    staleTime: 60_000,
  });
}

/** O seletor "Destino" (`GET /transferencias/destinos`): todo estoque ativo, também fora dos permitidos. */
function useDestinos(habilitado: boolean) {
  return useQuery({
    queryKey: ['opcoes', 'transferencia-destinos'],
    queryFn: () => apiErp.get<DestinoTransferenciaOpcao[]>('/transferencias/destinos'),
    enabled: habilitado,
    staleTime: 60_000,
  });
}

function useTiposEstoque() {
  return useQuery({
    queryKey: ['opcoes', 'tipos-estoque'],
    queryFn: () => apiErp.get<TipoEstoqueOpcao[]>('/tipos-estoque'),
    staleTime: 5 * 60_000,
  });
}

/** Transferência de estoque – listagem (ERP 13.7). */
export function ListaTransferencias() {
  const pode = usePode();
  const origens = useOrigens();
  const destinos = useDestinos(pode('transferencias.criar'));
  const config = useMemo<ConfigListagem<TransferenciaResumo>>(() => {
    // Os permitidos, também os inativos (o documento antigo continua achável pela origem).
    const visiveis = (origens.data ?? []).map((e) => ({ value: e.id, label: e.nome }));
    // O destino pode estar fora dos estoques visíveis (o CD despacha para a loja que não enxerga).
    const opcoesDestino = [
      ...visiveis,
      ...(destinos.data ?? [])
        .filter((d) => !visiveis.some((v) => v.value === d.id))
        .map((d) => ({ value: d.id, label: d.nome })),
    ];
    return {
      recurso: 'transferencias',
      titulo: 'Transferência de estoque',
      ordenacaoPadrao: 'codigo:desc',
      rotaNovo: `${ROTA_TRANSFERENCIAS}/novo`,
      rotuloNovo: 'Nova transferência',
      rotaEdicao: (t) => `${ROTA_TRANSFERENCIAS}/${t.id}`,
      chaveLinha: (t) => t.id,
      filtros: [
        { campo: 'codigo', rotulo: 'Nº', tipo: 'numero' },
        { campo: 'estoqueOrigemId', rotulo: 'Estoque origem', tipo: 'selecao', opcoes: visiveis },
        { campo: 'estoqueDestinoId', rotulo: 'Estoque destino', tipo: 'selecao', opcoes: opcoesDestino },
        { campo: 'status', rotulo: 'Situação', tipo: 'selecao', opcoes: OPCOES_STATUS },
        {
          campo: 'periodo',
          rotulo: 'Período por',
          tipo: 'selecao',
          opcoes: OPCOES_PERIODO,
          padrao: 'criacao',
        },
        { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data' },
        { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data' },
      ],
      colunas: [
        // A primeira coluna já é o link para a transferência (`<Listagem>`).
        { campo: 'codigo', rotulo: 'Nº', ordenavel: true, largura: 80 },
        { campo: 'origem', rotulo: 'Estoque origem', ordenavel: true, formato: (t) => t.estoqueOrigemNome },
        {
          campo: 'destino',
          rotulo: 'Estoque destino',
          ordenavel: true,
          formato: (t) => t.estoqueDestinoNome,
        },
        { campo: 'data', rotulo: 'Data criação', ordenavel: true, formato: (t) => formatarData(t.data) },
        {
          campo: 'enviada_em',
          rotulo: 'Data transferência',
          ordenavel: true,
          formato: (t) => (t.enviadaEm ? formatarDataHora(t.enviadaEm) : '—'),
        },
        {
          campo: 'recebida_em',
          rotulo: 'Data recebimento',
          ordenavel: true,
          formato: (t) => (t.recebidaEm ? formatarDataHora(t.recebidaEm) : '—'),
        },
        { campo: 'qtdItens', rotulo: 'Qtd. itens', alinhamento: 'right', formato: (t) => String(t.qtdItens) },
        {
          campo: 'status',
          rotulo: 'Situação',
          ordenavel: true,
          formato: (t) => badgeStatusTransferencia(t.status),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<TransferenciaResumo>>(`/transferencias${query(params)}`, { sinal }),
    };
  }, [origens.data, destinos.data]);
  return <Listagem config={config} />;
}

export const badgeStatusTransferencia = (s: StatusTransferencia) => (
  <Badge color={CORES_STATUS[s]} variant="light">
    {ROTULOS_STATUS_TRANSFERENCIA[s]}
  </Badge>
);

interface Valores extends Record<string, unknown> {
  estoqueOrigemId: string;
  estoqueDestinoId: string;
  tipoEstoqueId: string;
  data: string;
  motivo: string;
  observacoes: string;
  nfeExternaChave: string;
  nfeExternaNumero: string;
  itens: LinhaTransferencia[];
}

/**
 * Transferência de estoque – formulário (ERP 13.7; MD 3.7.6; Fase 2, F2-B27; README do ERP › decisão 64): o
 * cabeçalho (origem entre os estoques permitidos, destino de `GET /transferencias/destinos` sem a origem, tipo de
 * estoque, data, motivo, observações e a NF-e emitida por fora), a grade (produto, lote — vazio = FEFO —, a quantidade
 * em fardos, saldo na origem, enviada, recebida, diferença e o tratamento) e os botões por situação e permissão
 * (`acoesTransferencia`): Sugerir reposição, Salvar e enviar, Receber (com "Receber tudo como enviado"), Tratar
 * diferença, Cancelar, a NF-e de fora e o romaneio impresso pelo navegador. O alerta `TRANSFERENCIA_PARADA` aberto
 * aparece no topo.
 */
export function FormularioTransferencia() {
  const { id } = useParams();
  const pode = usePode();
  const origens = useOrigens();
  const destinos = useDestinos(pode('transferencias.criar'));
  const tipos = useTiposEstoque();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mostrarErros, setMostrarErros] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [processando, setProcessando] = useState(false);
  const [sugerindo, setSugerindo] = useState(false);
  const [conferencia, setConferencia] = useState<LinhaConferencia[] | null>(null);
  const [tratamento, setTratamento] = useState<LinhaTratamento[] | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const [motivoCancelamento, setMotivoCancelamento] = useState('');
  const [nfe, setNfe] = useState<{ chave: string; numero: string; erros: Record<string, string> } | null>(
    null,
  );
  const [errosModal, setErrosModal] = useState<string | null>(null);
  /**
   * Os erros por item da última ação (o saldo insuficiente do envio, `itens.N.campo`): à parte do `form.errors`, que a
   * recarga do detalhe gravado logo antes do envio (o `setValues` do `useCadastro`) pode limpar. Saem na edição da grade.
   */
  const [errosItensAcao, setErrosItensAcao] = useState<Record<string, string>>({});

  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: {
      estoqueOrigemId: '',
      estoqueDestinoId: '',
      tipoEstoqueId: '',
      data: hojeNoFuso(),
      motivo: '',
      observacoes: '',
      nfeExternaChave: '',
      nfeExternaNumero: '',
      itens: [novaLinhaTransferencia()],
    },
  });
  const v = form.getValues();

  const c = useCadastro<TransferenciaDetalhe, Valores>({
    api: '/transferencias',
    rota: ROTA_TRANSFERENCIAS,
    recurso: 'transferencias',
    id,
    form,
    paraValores: (t) => ({
      estoqueOrigemId: t.estoqueOrigemId,
      estoqueDestinoId: t.estoqueDestinoId,
      tipoEstoqueId: t.tipoEstoqueId,
      data: t.data,
      motivo: t.motivo,
      observacoes: t.observacoes ?? '',
      nfeExternaChave: t.nfeExternaChave ?? '',
      nfeExternaNumero: t.nfeExternaNumero ?? '',
      itens: [
        ...t.itens.map((i): LinhaTransferencia => ({
          chave: i.id,
          id: i.id,
          produto: i.produto,
          loteId: i.loteId ?? '',
          quantidade: quantidadeParaTela(i.quantidadeEnviada),
        })),
        ...(t.status === 'rascunho' ? [novaLinhaTransferencia()] : []),
      ],
    }),
    paraCorpo: (x) => paraCorpo(x),
    schemaCriar: criarTransferenciaSchema,
    schemaAlterar: alterarTransferenciaSchema,
    aoErroCampos: () => setMostrarErros(true),
  });
  const t = c.registro.data;
  const status: StatusTransferencia = t?.status ?? 'rascunho';
  const rascunho = status === 'rascunho';
  const sujo = form.isDirty();
  // Quem tem cada ponta vem no detalhe (a conferência da API, também com o estoque inativado depois do rascunho).
  const acoes = acoesTransferencia(status, {
    novo: c.novo,
    sujo,
    pode,
    origemPermitida: !!t?.origemPermitida,
    destinoPermitido: !!t?.destinoPermitido,
  });
  const somenteLeitura = !rascunho || !acoes.has('salvar');

  function paraCorpo(x: Valores): Record<string, unknown> {
    return {
      estoqueOrigemId: x.estoqueOrigemId,
      estoqueDestinoId: x.estoqueDestinoId,
      tipoEstoqueId: x.tipoEstoqueId || null,
      data: x.data || null,
      motivo: x.motivo,
      observacoes: x.observacoes,
      nfeExternaChave: x.nfeExternaChave,
      nfeExternaNumero: x.nfeExternaNumero,
      itens: x.itens.filter((l) => !linhaVaziaTransferencia(l)).map(itemTransferenciaParaApi),
    };
  }

  // Origem padrão do rascunho novo: o único estoque permitido ou o primeiro depósito (o CD); tipo: o padrão.
  const lista = (origens.data ?? []).filter((e) => e.ativo);
  const origemPadrao =
    lista.length === 1 ? lista[0]!.id : (lista.find((e) => e.tipo === 'deposito')?.id ?? '');
  const tipoPadrao = tipos.data?.find((x) => x.padrao)?.id ?? '';
  useEffect(() => {
    if (!c.novo) return;
    const atuais = form.getValues();
    const novos = {
      ...atuais,
      estoqueOrigemId: atuais.estoqueOrigemId || origemPadrao,
      tipoEstoqueId: atuais.tipoEstoqueId || tipoPadrao,
    };
    if (novos.estoqueOrigemId === atuais.estoqueOrigemId && novos.tipoEstoqueId === atuais.tipoEstoqueId)
      return;
    form.setValues(novos);
    if (!form.isDirty()) form.resetDirty(novos);
    // `form` muda a cada render; só os padrões carregados importam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.novo, origemPadrao, tipoPadrao]);

  // Saldo na origem, lotes e embalagem dos produtos da grade (rascunho), em blocos; o gravado vem no detalhe.
  const ids = [...new Set(v.itens.map((l) => l.produto?.id).filter((x): x is string => !!x))].sort();
  const dados = useQuery({
    queryKey: ['transferencia-dados', v.estoqueOrigemId, v.tipoEstoqueId, ids.join(',')],
    queryFn: () =>
      dadosTransferenciaEmBlocos(ids, (bloco) =>
        apiErp.get<DadosProdutosTransferencia>(
          `/transferencias/dados-produtos${query({
            estoqueOrigemId: v.estoqueOrigemId,
            tipoEstoqueId: v.tipoEstoqueId || undefined,
            produtoIds: bloco.join(','),
          })}`,
        ),
      ),
    enabled: rascunho && !somenteLeitura && !!v.estoqueOrigemId && ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const dadosDo = (produtoId: string | undefined) =>
    produtoId ? dados.data?.produtos.find((p) => p.produtoId === produtoId) : undefined;
  const gravados = new Map((t?.itens ?? []).map((i) => [i.id, i]));
  const gravado = (l: LinhaTransferencia) => (l.id ? gravados.get(l.id) : undefined);
  /** Item gravado e ainda igual ao da tela (mesmo produto, lote e origem): vale o que o detalhe mostra. */
  const gravadoIgual = (l: LinhaTransferencia) => {
    const g = gravado(l);
    return g &&
      t &&
      g.produtoId === l.produto?.id &&
      (g.loteId ?? '') === l.loteId &&
      t.estoqueOrigemId === v.estoqueOrigemId &&
      t.tipoEstoqueId === v.tipoEstoqueId
      ? g
      : undefined;
  };

  const errosForm = { ...errosItensAcao, ...form.errors };
  const validar = (l: LinhaTransferencia) => {
    const e: Partial<Record<keyof LinhaTransferencia | '_linha', string>> = { ...errosLinhaTransferencia(l) };
    const i = v.itens.filter((x) => !linhaVaziaTransferencia(x)).indexOf(l);
    for (const [k, msg] of Object.entries(errosForm)) {
      const m = /^itens\.(\d+)\.(\w+)$/.exec(k);
      if (m && Number(m[1]) === i && typeof msg === 'string') {
        const coluna = COLUNA_DO_CAMPO_TRANSFERENCIA[m[2]!] ?? 'produto';
        e[coluna] ??= msg;
      }
    }
    return e;
  };

  const alterarLinha = (chave: string, mudar: (l: LinhaTransferencia) => LinhaTransferencia) => {
    setErrosItensAcao({});
    form.setFieldValue(
      'itens',
      form.getValues().itens.map((l) => (l.chave === chave ? mudar(l) : l)),
    );
  };

  const mostrarLote =
    v.itens.some((l) => l.loteId) ||
    (t?.itens.some((i) => i.loteId || i.lote) ?? false) ||
    (dados.data?.produtos.some((p) => p.lotes.length > 0) ?? false);
  const comDiferenca = !!t?.itens.some((i) => dec(i.diferenca).gt(0));
  const comCusto = !!t?.itens.some((i) => i.custoUnitario !== null) && !rascunho;
  const unidade = (l: LinhaTransferencia) => l.produto?.unidadeSigla ?? '';

  const colunas: ColunaGrade<LinhaTransferencia>[] = [
    {
      campo: 'produto',
      rotulo: 'Produto ou código de barras',
      tipo: 'texto',
      largura: 280,
      editor: ({ linha, campo }) => (
        <SeletorProduto
          value={linha.produto?.id ?? null}
          produto={linha.produto}
          onChange={(_, p: ProdutoOpcao | null) =>
            alterarLinha(linha.chave, (l) => ({ ...l, produto: p, loteId: '' }))
          }
          tipos={TIPOS_TRANSFERENCIA}
          size="xs"
          error={!!campo['aria-invalid']}
          ref={campo.ref as never}
          onKeyDown={campo.onKeyDown as never}
          aria-label={campo['aria-label']}
          disabled={campo.disabled}
        />
      ),
    },
    ...(mostrarLote
      ? ([
          {
            campo: 'loteId',
            rotulo: 'Lote',
            tipo: 'selecao',
            largura: 170,
            editor: ({ linha, campo }) => {
              const g = gravado(linha);
              if (campo.disabled || !linha.produto) {
                const rotulo = g?.lote
                  ? `${g.lote}${g.validade ? ` · val. ${formatarData(g.validade)}` : ''}`
                  : linha.produto
                    ? 'FEFO'
                    : '—';
                return <Text size="sm">{rotulo}</Text>;
              }
              const lotes = dadosDo(linha.produto.id)?.lotes ?? [];
              const data = [
                { value: '', label: 'FEFO (o que vence primeiro)' },
                ...(linha.loteId && !lotes.some((x) => x.loteId === linha.loteId)
                  ? [{ value: linha.loteId, label: g?.lote ?? 'Lote gravado' }]
                  : []),
                ...lotes.map((x) => ({
                  value: x.loteId,
                  label: `${x.lote}${x.validade ? ` · val. ${formatarData(x.validade)}` : ''} (${qtd(x.quantidade)})`,
                })),
              ];
              return (
                <NativeSelect
                  size="xs"
                  data={data}
                  value={linha.loteId}
                  onChange={(ev) => {
                    const lote = ev.currentTarget.value;
                    alterarLinha(linha.chave, (l) => ({ ...l, loteId: lote }));
                  }}
                  error={!!campo['aria-invalid']}
                  ref={campo.ref as never}
                  onKeyDown={campo.onKeyDown as never}
                  aria-label={campo['aria-label']}
                />
              );
            },
          },
        ] satisfies ColunaGrade<LinhaTransferencia>[])
      : []),
    {
      campo: 'saldoOrigem',
      rotulo: 'Saldo na origem',
      tipo: 'leitura',
      largura: 110,
      formato: (l) => {
        if (!l.produto) return '—';
        const g = gravadoIgual(l);
        if (g && (!rascunho || somenteLeitura)) return g.saldoOrigem === null ? '—' : qtd(g.saldoOrigem);
        const d = dadosDo(l.produto.id);
        if (d) {
          const s = l.loteId ? d.lotes.find((x) => x.loteId === l.loteId)?.quantidade : d.saldoOrigem;
          if (s !== undefined) return qtd(s);
        }
        return g?.saldoOrigem ? qtd(g.saldoOrigem) : '—';
      },
    },
    { campo: 'quantidade', rotulo: rascunho ? 'Quant.' : 'Enviada', tipo: 'numero', largura: 90 },
    {
      campo: 'embalagem',
      rotulo: 'Em embalagens',
      tipo: 'leitura',
      largura: 130,
      formato: (l) => {
        if (!l.produto || !l.quantidade.trim()) return '—';
        // A embalagem é do produto (não depende do lote nem da origem): a dos dados da grade ou a do item gravado com
        // o mesmo produto.
        const g = gravado(l);
        const emb =
          dadosDo(l.produto.id)?.embalagem ?? (g && g.produtoId === l.produto.id ? g.embalagem : null);
        const q = textoDecimal(l.quantidade);
        return q === null ? '—' : quantidadeNaEmbalagem(q, emb, unidade(l));
      },
    },
    ...(!rascunho
      ? ([
          {
            campo: 'recebida',
            rotulo: 'Recebida',
            tipo: 'leitura',
            largura: 90,
            formato: (l) => qtd(gravado(l)?.quantidadeRecebida),
          },
          {
            campo: 'diferenca',
            rotulo: 'Diferença',
            tipo: 'leitura',
            largura: 90,
            formato: (l) => {
              const g = gravado(l);
              return g?.quantidadeRecebida === null || !g ? '—' : qtd(g.diferenca);
            },
          },
        ] satisfies ColunaGrade<LinhaTransferencia>[])
      : []),
    ...(comDiferenca
      ? ([
          {
            campo: 'tratamento',
            rotulo: 'Tratamento',
            tipo: 'leitura',
            largura: 150,
            formato: (l) => {
              const g = gravado(l);
              if (!g || !dec(g.diferenca).gt(0)) return '—';
              return aEsquerda(
                g.tratamentoDivergencia
                  ? ROTULOS_TRATAMENTO_DIVERGENCIA[g.tratamentoDivergencia]
                  : 'A tratar',
              );
            },
          },
        ] satisfies ColunaGrade<LinhaTransferencia>[])
      : []),
    ...(comCusto
      ? ([
          {
            campo: 'custo',
            rotulo: 'Custo unit.',
            tipo: 'leitura',
            largura: 100,
            formato: (l) => {
              const cu = gravado(l)?.custoUnitario;
              return cu ? `R$ ${formatarDecimal(Number(cu), 4)}` : '—';
            },
          },
        ] satisfies ColunaGrade<LinhaTransferencia>[])
      : []),
  ];

  /** Depois de uma ação: o detalhe novo no cache e no formulário, a listagem e os saldos invalidados. */
  const depoisDaAcao = (d: TransferenciaDetalhe, mensagem: string) => {
    setErroAcao(null);
    setErrosItensAcao({});
    queryClient.setQueryData(['transferencias', d.id], d);
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'transferencias'] });
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_saldos'] });
    void queryClient.invalidateQueries({ queryKey: ['transferencia-dados'] });
    notifications.show({ color: 'green', message: mensagem });
  };

  /**
   * Erro de uma ação: 409 (outro usuário mexeu) vai para o aviso com "Recarregar" do formulário; os campos (o saldo
   * insuficiente no item, a origem fora dos permitidos) vão para o formulário e a grade; o resto, para o alerta.
   */
  const aoErroAcao = (e: unknown) => {
    if (e instanceof ErroRequisicao && e.codigo === 'CONFLITO_VERSAO') {
      c.setErro(e);
      return;
    }
    setErroAcao((e as Error).message);
    if (e instanceof ErroRequisicao && e.campos) {
      const campos = errosDaApi(e.campos);
      form.setErrors(campos);
      setErrosItensAcao(Object.fromEntries(Object.entries(campos).filter(([k]) => k.startsWith('itens.'))));
      setMostrarErros(true);
    }
  };

  /** Grava o rascunho (se for novo ou tiver alteração) e devolve o detalhe gravado; `null` se não gravou. */
  async function gravarAntes(): Promise<TransferenciaDetalhe | null> {
    if (!c.novo && t && (!sujo || !pode('transferencias.criar'))) return t;
    const corpo = { ...paraCorpo(form.getValues()), ...(c.novo ? {} : { versao: t?.versao }) };
    const z = (c.novo ? criarTransferenciaSchema : alterarTransferenciaSchema).safeParse(corpo);
    if (!z.success) {
      const campos: Record<string, string> = {};
      for (const i of z.error.issues) campos[i.path.join('.') || '_'] ??= i.message;
      form.setErrors(campos);
      setMostrarErros(true);
      return null;
    }
    try {
      const d = c.novo
        ? await apiErp.post<TransferenciaDetalhe>('/transferencias', corpo)
        : await apiErp.put<TransferenciaDetalhe>(`/transferencias/${id}`, corpo);
      queryClient.setQueryData(['transferencias', d.id], d);
      return d;
    } catch (e) {
      aoErroAcao(e);
      return null;
    }
  }

  const salvarEEnviar = () => {
    setMostrarErros(true);
    modals.openConfirmModal({
      title: 'Enviar a transferência',
      children: (
        <Text size="sm">
          A mercadoria sai do estoque de origem agora, ao custo médio, e fica “Em trânsito” até o destino
          receber (se o recebimento automático estiver ligado em Configurações, já entra no destino). Depois
          do envio, os itens não mudam mais (só se cancela o envio).
        </Text>
      ),
      labels: { confirm: 'Enviar', cancel: 'Voltar' },
      confirmProps: { color: 'blue' },
      onConfirm: () => {
        void (async () => {
          setErroAcao(null);
          setProcessando(true);
          const novo = c.novo;
          const d = await gravarAntes();
          if (!d) {
            setProcessando(false);
            return;
          }
          // O rascunho novo já foi gravado: a tela passa a ser a dele antes de enviar (o envio recusado não deixa a
          // tela em "novo", e a próxima tentativa não grava um segundo rascunho).
          if (novo) {
            form.resetDirty();
            navigate(`${ROTA_TRANSFERENCIAS}/${d.id}`, { replace: true });
          }
          try {
            const e = await apiErp.post<TransferenciaDetalhe>(`/transferencias/${d.id}/enviar`, {
              versao: d.versao,
            });
            depoisDaAcao(
              e,
              e.status === 'recebida'
                ? `Transferência Nº ${e.codigo} enviada e já recebida no destino (recebimento automático)`
                : `Transferência Nº ${e.codigo} enviada: em trânsito até o destino receber`,
            );
          } catch (e) {
            // A grade é a do rascunho gravado: os erros por item (saldo insuficiente) casam com as linhas.
            aoErroAcao(e);
          } finally {
            setProcessando(false);
          }
        })();
      },
    });
  };

  /** "Sugerir reposição" (ERP 13.7; F2-B25): preenche a grade; o 403 do destino tem uma mensagem própria. */
  async function sugerir() {
    const x = form.getValues();
    if (!x.estoqueOrigemId || !x.estoqueDestinoId) {
      form.setErrors({
        ...(x.estoqueOrigemId ? {} : { estoqueOrigemId: 'Escolha o estoque de origem' }),
        ...(x.estoqueDestinoId ? {} : { estoqueDestinoId: 'Escolha o estoque de destino' }),
      });
      return;
    }
    setSugerindo(true);
    setErroAcao(null);
    try {
      const s = await apiErp.get<SugestaoReposicao>(
        `/transferencias/sugestao-reposicao${query({
          origem: x.estoqueOrigemId,
          destino: x.estoqueDestinoId,
          tipoEstoqueId: x.tipoEstoqueId || undefined,
        })}`,
      );
      const m = mesclarSugestao(x.itens, s.itens);
      setErrosItensAcao({});
      form.setFieldValue('itens', m.linhas);
      if (s.avisos.length)
        notifications.show({ color: 'yellow', message: s.avisos.join(' '), autoClose: false });
      notifications.show({
        color: s.itens.length ? 'green' : 'gray',
        message: s.itens.length
          ? `Sugestão aplicada: ${m.novos} produto(s) incluído(s)${m.atualizados ? ` e ${m.atualizados} atualizado(s)` : ''}. Confira as quantidades antes de enviar.`
          : 'Nenhum produto do destino abaixo do estoque mínimo.',
      });
    } catch (e) {
      if (e instanceof ErroRequisicao && e.status === 403 && e.campos?.estoqueDestinoId) {
        form.setErrors({ estoqueDestinoId: 'Fora dos seus estoques permitidos' });
        setErroAcao(
          'A sugestão de reposição usa o saldo e o estoque mínimo do destino, e o estoque de destino está fora dos seus estoques permitidos. Monte a carga à mão, ou peça a quem tem acesso ao destino (o cadastro do usuário › Estoques permitidos).',
        );
      } else aoErroAcao(e);
    } finally {
      setSugerindo(false);
    }
  }

  async function receber(corpo: Record<string, unknown>, mensagem: (d: TransferenciaDetalhe) => string) {
    setProcessando(true);
    setErrosModal(null);
    try {
      const d = await apiErp.post<TransferenciaDetalhe>(`/transferencias/${id}/receber`, corpo);
      setConferencia(null);
      depoisDaAcao(d, mensagem(d));
    } catch (e) {
      if (e instanceof ErroRequisicao && e.codigo === 'CONFLITO_VERSAO') {
        setConferencia(null);
        c.setErro(e);
      } else setErrosModal(conferenciaComErros(e));
    } finally {
      setProcessando(false);
    }
  }

  /** O erro do recebimento na conferência: os itens (`itens.N.quantidadeRecebida`, N = a linha) e a mensagem. */
  function conferenciaComErros(e: unknown): string {
    if (e instanceof ErroRequisicao && e.campos && conferencia) {
      const porLinha = new Map<number, string>();
      for (const [k, msgs] of Object.entries(e.campos)) {
        const m = /^itens\.(\d+)\./.exec(k);
        if (m && msgs[0]) porLinha.set(Number(m[1]), msgs[0]);
      }
      if (porLinha.size)
        return [...porLinha.entries()]
          .map(([n, msg]) => `Linha ${n + 1} (${conferencia[n]?.item.produto.nome ?? '?'}): ${msg}`)
          .join(' · ');
    }
    return (e as Error).message;
  }

  const mensagemRecebida = (d: TransferenciaDetalhe) =>
    d.status === 'recebida_divergencia'
      ? `Transferência Nº ${d.codigo} recebida com divergência: trate a diferença (retornar à origem ou baixar como perda)`
      : `Transferência Nº ${d.codigo} recebida: o estoque de destino foi atualizado`;

  const receberTudo = () =>
    modals.openConfirmModal({
      title: 'Receber tudo como enviado',
      children: (
        <Text size="sm">
          Confirma que chegou exatamente o que foi enviado, em todos os itens? O estoque de destino recebe
          agora, com o custo do envio.
        </Text>
      ),
      labels: { confirm: 'Receber tudo', cancel: 'Voltar' },
      confirmProps: { color: 'green' },
      onConfirm: () => void receber({ versao: t!.versao, receberTudo: true, itens: [] }, mensagemRecebida),
    });

  async function tratar() {
    const corpo = corpoTratamento(tratamento ?? [], t!.versao);
    if (!corpo.itens.length) {
      setErrosModal('Escolha o tratamento de pelo menos um item.');
      return;
    }
    setProcessando(true);
    setErrosModal(null);
    try {
      const d = await apiErp.post<TransferenciaDetalhe>(`/transferencias/${id}/tratar-divergencia`, corpo);
      setTratamento(null);
      depoisDaAcao(
        d,
        d.status === 'recebida'
          ? `Diferença tratada: transferência Nº ${d.codigo} recebida`
          : 'Diferença tratada nos itens escolhidos; os outros continuam a tratar',
      );
    } catch (e) {
      if (e instanceof ErroRequisicao && e.codigo === 'CONFLITO_VERSAO') {
        setTratamento(null);
        c.setErro(e);
      } else setErrosModal((e as Error).message);
    } finally {
      setProcessando(false);
    }
  }

  async function cancelar() {
    setProcessando(true);
    try {
      const d = await apiErp.post<TransferenciaDetalhe>(`/transferencias/${id}/cancelar`, {
        versao: t!.versao,
        motivo: motivoCancelamento,
      });
      setCancelando(false);
      setMotivoCancelamento('');
      form.resetDirty();
      depoisDaAcao(
        d,
        t?.status === 'em_transito'
          ? `Envio cancelado: a mercadoria voltou ao estoque de origem`
          : 'Rascunho cancelado',
      );
    } catch (e) {
      setCancelando(false);
      aoErroAcao(e);
    } finally {
      setProcessando(false);
    }
  }

  async function anotarNfe() {
    if (!nfe) return;
    setProcessando(true);
    try {
      const d = await apiErp.put<TransferenciaDetalhe>(`/transferencias/${id}/nfe-externa`, {
        versao: t!.versao,
        nfeExternaChave: nfe.chave,
        nfeExternaNumero: nfe.numero,
      });
      setNfe(null);
      depoisDaAcao(d, 'NF-e de transferência anotada');
    } catch (e) {
      if (e instanceof ErroRequisicao && e.campos) setNfe({ ...nfe, erros: errosDaApi(e.campos) });
      else {
        setNfe(null);
        aoErroAcao(e);
      }
    } finally {
      setProcessando(false);
    }
  }

  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_TRANSFERENCIAS} />;

  const opcoesOrigem = lista.map((e) => ({ value: e.id, label: e.nome }));
  if (t && !opcoesOrigem.some((o) => o.value === t.estoqueOrigemId))
    opcoesOrigem.push({ value: t.estoqueOrigemId, label: t.estoqueOrigemNome });
  const opcoesDestino = (destinos.data ?? [])
    .filter((d) => d.id !== v.estoqueOrigemId)
    .map((d) => ({
      value: d.id,
      label: d.lojaNome && d.lojaNome !== d.nome ? `${d.nome} (${d.lojaNome})` : d.nome,
    }));
  if (t && !opcoesDestino.some((o) => o.value === t.estoqueDestinoId))
    opcoesDestino.push({ value: t.estoqueDestinoId, label: t.estoqueDestinoNome });
  const opcoesTipo = (tipos.data ?? [])
    .filter((x) => x.ativo || x.id === v.tipoEstoqueId)
    .map((x) => ({ value: x.id, label: x.nome }));

  const avisoSomenteLeitura = !rascunho
    ? {
        em_transito:
          'Em trânsito: a mercadoria saiu da origem e ainda não entrou no destino. Os itens não mudam mais: receba no destino ou cancele o envio.',
        recebida:
          'Transferência recebida: o documento não muda mais (para devolver, faça uma transferência no sentido inverso).',
        recebida_divergencia:
          'Recebida com divergência: trate a diferença de cada item recebido a menor (retornar à origem ou baixar como perda).',
        cancelada: 'Transferência cancelada: o documento não muda mais.',
        rascunho: '',
      }[status]
    : undefined;

  const botoes = (
    <>
      {acoes.has('sugerir') && (
        <Button
          variant="default"
          leftSection={<IconBulb size={16} />}
          loading={sugerindo}
          disabled={!v.estoqueOrigemId || !v.estoqueDestinoId}
          onClick={() => void sugerir()}
        >
          Sugerir reposição
        </Button>
      )}
      {acoes.has('enviar') && (
        <Button
          color="blue"
          leftSection={<IconTruckDelivery size={16} />}
          loading={processando}
          disabled={!c.novo && !sujo && !t?.itens.length}
          onClick={salvarEEnviar}
        >
          {c.novo || sujo ? 'Salvar e enviar' : 'Enviar'}
        </Button>
      )}
      {acoes.has('receber') && (
        <Button
          color="green"
          leftSection={<IconCircleCheck size={16} />}
          onClick={() => {
            setErrosModal(null);
            setConferencia(linhasConferencia(t!.itens));
          }}
        >
          Receber
        </Button>
      )}
      {acoes.has('tratar') && (
        <Button
          color="orange"
          leftSection={<IconScale size={16} />}
          onClick={() => {
            setErrosModal(null);
            setTratamento(linhasTratamento(t!.itens));
          }}
        >
          Tratar diferença
        </Button>
      )}
      {acoes.has('nfe') && (
        <Button
          variant="default"
          leftSection={<IconFileInvoice size={16} />}
          onClick={() =>
            setNfe({ chave: t?.nfeExternaChave ?? '', numero: t?.nfeExternaNumero ?? '', erros: {} })
          }
        >
          NF-e de fora
        </Button>
      )}
      {acoes.has('romaneio') && (
        <Tooltip label="Salve as alterações antes de imprimir" disabled={!sujo}>
          <Button
            variant="default"
            leftSection={<IconPrinter size={16} />}
            disabled={sujo}
            onClick={() => window.open(urlRomaneioTransferencia(id!), '_blank')}
          >
            Romaneio
          </Button>
        </Tooltip>
      )}
      {acoes.has('cancelar') && (
        <Button
          variant="light"
          color="red"
          leftSection={<IconX size={16} />}
          onClick={() => setCancelando(true)}
        >
          {status === 'em_transito' ? 'Cancelar envio' : 'Cancelar'}
        </Button>
      )}
    </>
  );

  const colunasConferencia: ColunaGrade<LinhaConferencia>[] = [
    {
      campo: 'produto',
      rotulo: 'Produto',
      tipo: 'leitura',
      formato: (l) =>
        aEsquerda(
          `${l.item.produto.codigo} - ${l.item.produto.nome}${l.item.lote ? ` · lote ${l.item.lote}` : ''}`,
        ),
    },
    {
      campo: 'enviada',
      rotulo: 'Enviada',
      tipo: 'leitura',
      largura: 140,
      formato: (l) =>
        quantidadeNaEmbalagem(l.item.quantidadeEnviada, l.item.embalagem, l.item.produto.unidadeSigla),
    },
    { campo: 'recebida', rotulo: 'Recebida', tipo: 'numero', largura: 110 },
    {
      campo: 'diferenca',
      rotulo: 'Diferença',
      tipo: 'leitura',
      largura: 100,
      formato: (l) => qtd(diferencaConferencia(l)),
    },
  ];
  const colunasTratamento: ColunaGrade<LinhaTratamento>[] = [
    {
      campo: 'produto',
      rotulo: 'Produto',
      tipo: 'leitura',
      formato: (l) => aEsquerda(`${l.item.produto.codigo} - ${l.item.produto.nome}`),
    },
    {
      campo: 'enviada',
      rotulo: 'Enviada',
      tipo: 'leitura',
      largura: 90,
      formato: (l) => qtd(l.item.quantidadeEnviada),
    },
    {
      campo: 'recebida',
      rotulo: 'Recebida',
      tipo: 'leitura',
      largura: 90,
      formato: (l) => qtd(l.item.quantidadeRecebida),
    },
    {
      campo: 'diferenca',
      rotulo: 'Diferença',
      tipo: 'leitura',
      largura: 90,
      formato: (l) => qtd(l.item.diferenca),
    },
    {
      campo: 'tratamento',
      rotulo: 'Tratamento',
      tipo: 'selecao',
      largura: 180,
      opcoes: TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA.map((x) => ({
        value: x,
        label: ROTULOS_TRATAMENTO_DIVERGENCIA[x],
      })),
    },
  ];
  const comDiferencaNaConferencia = (conferencia ?? []).filter((l) => {
    const d = diferencaConferencia(l);
    return d !== null && dec(d).gt(0);
  }).length;
  const conferenciaValida = (conferencia ?? []).every((l) => !Object.keys(errosConferencia(l)).length);

  return (
    <>
      <FormularioEntidade
        titulo={c.novo ? 'Nova transferência' : `Transferência Nº ${t?.codigo ?? ''}`}
        codigo={t?.codigo}
        situacao={t ? { rotulo: ROTULOS_STATUS_TRANSFERENCIA[t.status], cor: CORES_STATUS[t.status] } : null}
        alteradoEm={t?.atualizadoEm}
        alteradoPor={t?.atualizadoPorNome}
        carregando={!c.novo && c.registro.isPending}
        salvando={c.salvando || processando}
        somenteLeitura={somenteLeitura}
        avisoSomenteLeitura={avisoSomenteLeitura}
        sujo={sujo}
        rotaVoltar={ROTA_TRANSFERENCIAS}
        rotaNovo={pode('transferencias.criar') ? `${ROTA_TRANSFERENCIAS}/novo` : undefined}
        aoSalvar={() => {
          setMostrarErros(true);
          c.salvar();
        }}
        aoExcluir={acoes.has('excluir') ? c.excluir : undefined}
        erro={c.erro}
        aoRecarregar={c.recarregar}
        historico={t ? { entidade: 'transferencias_estoque', registroId: t.id } : undefined}
        acoesExtras={botoes}
        abas={[
          {
            valor: 'dados',
            rotulo: 'Transferência',
            conteudo: (
              <Stack>
                {t?.alertaParada && (
                  <Alert
                    color="orange"
                    icon={<IconAlertTriangle size={18} />}
                    title={t.alertaParada.titulo}
                    data-testid="alerta-parada"
                  >
                    {t.alertaParada.mensagem}
                  </Alert>
                )}
                {erroAcao && (
                  <Alert color="red" role="alert" withCloseButton onClose={() => setErroAcao(null)}>
                    {erroAcao}
                  </Alert>
                )}
                {dados.isError && rascunho && !somenteLeitura && (
                  <Alert color="yellow" data-testid="falha-dados-transferencia">
                    <Group justify="space-between" wrap="nowrap">
                      <Text size="sm">
                        Não foi possível ler o saldo e os lotes da origem: {(dados.error as Error).message} (o
                        envio confere o saldo de novo).
                      </Text>
                      <Button size="xs" variant="light" onClick={() => void dados.refetch()}>
                        Tentar de novo
                      </Button>
                    </Group>
                  </Alert>
                )}
                {t && !rascunho && (
                  <Text size="sm" c="dimmed" data-testid="etapas-transferencia">
                    {t.enviadaEm &&
                      `Enviada em ${formatarDataHora(t.enviadaEm)} por ${t.enviadaPorNome ?? '—'}. `}
                    {t.recebidaEm &&
                      `Recebida em ${formatarDataHora(t.recebidaEm)} por ${t.recebidaPorNome ?? '—'}. `}
                    {t.canceladaEm &&
                      `Cancelada em ${formatarDataHora(t.canceladaEm)} por ${t.canceladaPorNome ?? '—'}: ${t.motivoCancelamento ?? ''}`}
                  </Text>
                )}
                <Grid>
                  <Grid.Col span={{ base: 12, md: 4 }}>
                    <Select
                      label="Estoque de origem"
                      required
                      allowDeselect={false}
                      data={opcoesOrigem}
                      {...form.getInputProps('estoqueOrigemId')}
                      onChange={(valor) => {
                        const atuais = form.getValues();
                        form.setValues({
                          estoqueOrigemId: valor ?? '',
                          // O destino não pode ser a própria origem.
                          estoqueDestinoId: atuais.estoqueDestinoId === valor ? '' : atuais.estoqueDestinoId,
                        });
                      }}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 4 }}>
                    <Select
                      label="Destino"
                      required
                      searchable
                      allowDeselect={false}
                      description="Qualquer estoque ativo da empresa"
                      data={opcoesDestino}
                      {...form.getInputProps('estoqueDestinoId')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 6, md: 2 }}>
                    <Select
                      label="Tipo de estoque"
                      required
                      allowDeselect={false}
                      data={opcoesTipo}
                      {...form.getInputProps('tipoEstoqueId')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 6, md: 2 }}>
                    <CampoData label="Data" required clearable={false} {...form.getInputProps('data')} />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 6 }}>
                    <TextInput
                      label="Motivo"
                      required
                      maxLength={120}
                      placeholder="Ex.: Reposição semanal"
                      {...form.getInputProps('motivo')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 4 }}>
                    <TextInput
                      label="NF-e de transferência (chave)"
                      description="Emitida por fora (Nuvem3/contador), só anotação"
                      maxLength={60}
                      {...form.getInputProps('nfeExternaChave')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 2 }}>
                    <TextInput
                      label="NF-e (nº/série)"
                      description="Sem a chave"
                      maxLength={20}
                      {...form.getInputProps('nfeExternaNumero')}
                    />
                  </Grid.Col>
                  <Grid.Col span={12}>
                    <Textarea
                      label="Observações"
                      autosize
                      minRows={1}
                      maxLength={2000}
                      {...form.getInputProps('observacoes')}
                    />
                  </Grid.Col>
                </Grid>
                <GradeItens
                  rotulo="Itens da transferência"
                  linhas={v.itens}
                  aoMudar={(linhas) => {
                    setErrosItensAcao({});
                    form.setFieldValue('itens', linhas);
                  }}
                  colunas={colunas}
                  novaLinha={novaLinhaTransferencia}
                  chave={(l) => l.chave}
                  validar={rascunho ? validar : undefined}
                  vazia={linhaVaziaTransferencia}
                  rodape={{ quantidade: 'quantidade' }}
                  mostrarErros={mostrarErros}
                  somenteLeitura={somenteLeitura}
                />
                {rascunho && !somenteLeitura && (
                  <Text size="xs" c="dimmed">
                    Lote vazio: o envio baixa do lote que vence primeiro (FEFO). O saldo é o da origem no tipo
                    de estoque escolhido; o envio confere de novo e recusa o item sem saldo.
                  </Text>
                )}
              </Stack>
            ),
          },
        ]}
      />
      <Modal
        opened={!!conferencia}
        onClose={() => setConferencia(null)}
        title={`Receber a transferência Nº ${t?.codigo ?? ''}`}
        size="xl"
      >
        <Stack>
          <Text size="sm">
            Informe a quantidade que chegou de cada item (já vem a enviada: corrija só o que faltou; 0 se não
            chegou). A recebida não passa da enviada: para mandar mais, faça outra transferência.
          </Text>
          {errosModal && (
            <Alert color="red" role="alert">
              {errosModal}
            </Alert>
          )}
          {conferencia && (
            <GradeItens
              rotulo="Conferência do recebimento"
              linhas={conferencia}
              aoMudar={setConferencia}
              colunas={colunasConferencia}
              novaLinha={() => conferencia[0]!}
              chave={(l) => l.chave}
              validar={errosConferencia}
              mostrarErros
              linhasFixas
            />
          )}
          {comDiferencaNaConferencia > 0 && (
            <Text size="sm" c="orange" data-testid="aviso-divergencia">
              {comDiferencaNaConferencia} item(ns) com diferença: a transferência fica “Recebida com
              divergência” até alguém tratar a diferença (retornar à origem ou baixar como perda).
            </Text>
          )}
          <Group justify="space-between">
            <Button variant="light" color="green" loading={processando} onClick={receberTudo}>
              Receber tudo como enviado
            </Button>
            <Group>
              <Button variant="default" onClick={() => setConferencia(null)}>
                Voltar
              </Button>
              <Button
                color="green"
                loading={processando}
                disabled={!conferenciaValida}
                onClick={() => void receber(corpoConferencia(conferencia ?? [], t!.versao), mensagemRecebida)}
              >
                Confirmar recebimento
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={!!tratamento}
        onClose={() => setTratamento(null)}
        title={`Tratar a diferença da transferência Nº ${t?.codigo ?? ''}`}
        size="xl"
      >
        <Stack>
          <Text size="sm">
            Cada item recebido a menor se trata uma vez: <b>Retornar à origem</b> devolve a diferença ao
            estoque de origem; <b>Baixar como perda</b> devolve e baixa na hora como perda (um acerto de saída
            na origem, registrado a custo). Os itens sem escolha continuam a tratar.
          </Text>
          {errosModal && (
            <Alert color="red" role="alert">
              {errosModal}
            </Alert>
          )}
          <Group gap="xs">
            <Text size="sm">Todos:</Text>
            {TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA.map((x) => (
              <Button
                key={x}
                size="xs"
                variant="light"
                onClick={() =>
                  setTratamento((linhas) => linhas?.map((l) => ({ ...l, tratamento: x })) ?? null)
                }
              >
                {ROTULOS_TRATAMENTO_DIVERGENCIA[x]}
              </Button>
            ))}
          </Group>
          {tratamento && (
            <GradeItens
              rotulo="Itens com diferença"
              linhas={tratamento}
              aoMudar={setTratamento}
              colunas={colunasTratamento}
              novaLinha={() => tratamento[0]!}
              chave={(l) => l.chave}
              linhasFixas
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setTratamento(null)}>
              Voltar
            </Button>
            <Button
              color="orange"
              loading={processando}
              disabled={!tratamento?.some((l) => l.tratamento)}
              onClick={() => void tratar()}
            >
              Confirmar tratamento
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={cancelando}
        onClose={() => setCancelando(false)}
        title={status === 'em_transito' ? 'Cancelar o envio' : 'Cancelar a transferência'}
      >
        <Stack>
          <Text size="sm">
            {status === 'em_transito'
              ? 'A mercadoria volta ao estoque de origem, ao custo do envio, e a transferência fica cancelada. Use quando a carga não saiu ou voltou inteira.'
              : 'O rascunho fica cancelado (o estoque não muda).'}
          </Text>
          <TextInput
            label="Motivo do cancelamento"
            required
            data-autofocus
            maxLength={255}
            value={motivoCancelamento}
            onChange={(e) => setMotivoCancelamento(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setCancelando(false)}>
              Voltar
            </Button>
            <Button
              color="red"
              disabled={!motivoCancelamento.trim()}
              loading={processando}
              onClick={() => void cancelar()}
            >
              {status === 'em_transito' ? 'Cancelar envio' : 'Cancelar transferência'}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={!!nfe} onClose={() => setNfe(null)} title="NF-e de transferência emitida por fora">
        <Stack>
          <Text size="sm">
            Só anotação (o Genesis não emite nem consulta a nota): a chave de acesso de 44 dígitos ou o número
            e a série.
          </Text>
          <TextInput
            label="Chave de acesso"
            maxLength={60}
            value={nfe?.chave ?? ''}
            error={nfe?.erros.nfeExternaChave}
            onChange={(e) => {
              const chave = e.currentTarget.value;
              setNfe((x) => (x ? { ...x, chave } : x));
            }}
          />
          <TextInput
            label="Número/série"
            maxLength={20}
            value={nfe?.numero ?? ''}
            error={nfe?.erros.nfeExternaNumero}
            onChange={(e) => {
              const numero = e.currentTarget.value;
              setNfe((x) => (x ? { ...x, numero } : x));
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setNfe(null)}>
              Voltar
            </Button>
            <Button loading={processando} onClick={() => void anotarNfe()}>
              Gravar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
