import {
  alterarAcertoSchema,
  criarAcertoSchema,
  MOTIVOS_ACERTO,
  ROTULOS_ORIGEM_ACERTO,
  ROTULOS_STATUS_ACERTO,
  ROTULOS_TIPO_AJUSTE,
  STATUS_ACERTO,
  TIPOS_AJUSTE,
  totaisAcerto,
  valoresItemAcerto,
  type AcertoDetalhe,
  type AcertoResumo,
  type EstoqueResumo,
  type LoteSaldoItem,
  type Pagina,
  type PreviaContagem,
  type UsuarioResumo,
  type ProdutoOpcao,
  type SaldoItem,
  type StatusAcerto,
  type TipoAjuste,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Grid,
  Group,
  Modal,
  NativeSelect,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowBackUp,
  IconCircleCheck,
  IconFileImport,
  IconInfoCircle,
  IconPrinter,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { formatarDecimal, lerDecimal } from '../../componentes/grade/decimal';
import { GradeItens, type ColunaGrade } from '../../componentes/grade/GradeItens';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { SeletorUsuario } from '../../componentes/seletores/SeletorUsuario';
import { useLojaContexto } from '../../layout/lojaContexto';
import { errosDaApi } from '../../util/erros';
import { formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import { CampoDataHora } from '../../componentes/campos/CamposData';
import { AbaCompensacoes } from './CompensacoesAcerto';
import { AbaConferencia } from './ConferenciaAcerto';
import { ModalFolhaContagem } from './FolhaContagem';
import { ModalImportarContagem } from './ImportarContagem';

export const ROTA_ACERTOS = '/estoque/acertos';

const CORES_STATUS: Record<StatusAcerto, string> = {
  rascunho: 'yellow',
  efetivado: 'green',
  estornado: 'gray',
};
const OPCOES_TIPO = TIPOS_AJUSTE.map((t) => ({ value: t, label: ROTULOS_TIPO_AJUSTE[t] }));
const OPCOES_STATUS = STATUS_ACERTO.map((s) => ({ value: s, label: ROTULOS_STATUS_ACERTO[s] }));

/** Tipos com saldo próprio (combo/kit e serviço não têm; variações entram com a Fase 2). */
/** Produzido não tem saldo próprio (a venda baixa os insumos, ERP 8.2.4; D17): fora do acerto, como combo e serviço. */
const TIPOS_COM_ESTOQUE = ['simples', 'materia_prima', 'vasilhame', 'com_complementos'] as const;

const reais = (n: number) => `R$ ${formatarDecimal(n, 2)}`;
const qtd = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? '—' : formatarDecimal(Number(v), 3);
/** Decimal da API ("2.1000") para o campo ("2,1"). */
const paraTela = (v: string | null | undefined, casas = 4) =>
  v === null || v === undefined ? '' : formatarDecimal(Number(v), casas).replace(/\./g, '');

export const badgeStatusAcerto = (s: StatusAcerto) => (
  <Badge color={CORES_STATUS[s]} variant="light">
    {ROTULOS_STATUS_ACERTO[s]}
  </Badge>
);

/** Estoques ativos visíveis (seletor e filtro). */
function useEstoques() {
  return useQuery({
    queryKey: ['opcoes', 'estoques'],
    queryFn: () =>
      apiErp.get<Pagina<EstoqueResumo>>(
        `/estoques${query({ situacao: 'ativos', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
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

/** Usuários para o filtro "Responsável" (só com `usuarios.ver`). */
function useResponsaveis(habilitado: boolean) {
  return useQuery({
    queryKey: ['opcoes', 'usuarios-responsaveis'],
    queryFn: () =>
      apiErp.get<Pagina<UsuarioResumo>>(
        `/usuarios${query({ tamanho: 'todos', situacao: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: habilitado,
    staleTime: 60_000,
  });
}

/** Acerto de Estoque – listagem (ERP 13.5). */
export function ListaAcertos() {
  const estoques = useEstoques();
  const podeVerUsuarios = usePode()('usuarios.ver');
  const responsaveis = useResponsaveis(podeVerUsuarios);
  const config = useMemo<ConfigListagem<AcertoResumo>>(
    () => ({
      recurso: 'estoque_acertos',
      titulo: 'Acerto de Estoque',
      ordenacaoPadrao: 'data:desc',
      rotaNovo: `${ROTA_ACERTOS}/novo`,
      rotuloNovo: 'Novo acerto',
      rotaEdicao: (a) => `${ROTA_ACERTOS}/${a.id}`,
      chaveLinha: (a) => a.id,
      filtros: [
        // ERP 13.5: "Responsável" é o primeiro filtro (seleção de usuário; só com usuarios.ver).
        ...(podeVerUsuarios
          ? [
              {
                campo: 'responsavelId',
                rotulo: 'Responsável',
                tipo: 'selecao' as const,
                opcoes: (responsaveis.data?.itens ?? []).map((u) => ({ value: u.id, label: u.nome })),
              },
            ]
          : []),
        {
          campo: 'estoqueId',
          rotulo: 'Estoque',
          tipo: 'selecao',
          opcoes: (estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome })),
        },
        { campo: 'tipoAjuste', rotulo: 'Tipo de ajuste', tipo: 'selecao', opcoes: OPCOES_TIPO },
        { campo: 'status', rotulo: 'Situação', tipo: 'selecao', opcoes: OPCOES_STATUS },
        { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data' },
        { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data' },
      ],
      colunas: [
        { campo: 'codigo', rotulo: 'Nº', ordenavel: true, largura: 80 },
        {
          campo: 'data',
          rotulo: 'Data',
          ordenavel: true,
          formato: (a) => (
            <Anchor component={Link} to={`${ROTA_ACERTOS}/${a.id}`} c="inherit">
              {formatarDataHora(a.dataContagem)}
            </Anchor>
          ),
        },
        { campo: 'responsavel', rotulo: 'Responsável', ordenavel: true, formato: (a) => a.responsavelNome },
        {
          campo: 'motivo',
          rotulo: 'Motivo',
          ordenavel: true,
          formato: (a) => (
            <>
              {a.motivo}
              {a.origem !== 'manual' && (
                <Text span size="xs" c="dimmed">
                  {' '}
                  · {ROTULOS_ORIGEM_ACERTO[a.origem]}
                </Text>
              )}
            </>
          ),
        },
        { campo: 'estoque', rotulo: 'Estoque', ordenavel: true, formato: (a) => a.estoqueNome },
        { campo: 'tipo', rotulo: 'Tipo', ordenavel: true, formato: (a) => ROTULOS_TIPO_AJUSTE[a.tipoAjuste] },
        {
          campo: 'qtd_itens',
          rotulo: 'Qtd. itens',
          ordenavel: true,
          alinhamento: 'right',
          formato: (a) => a.qtdItens,
        },
        {
          campo: 'total_custo',
          rotulo: 'Valor de custo',
          ordenavel: true,
          alinhamento: 'right',
          permissao: 'produtos.ver_custo',
          formato: (a) => (a.totalCusto === null ? '—' : reais(Number(a.totalCusto))),
        },
        { campo: 'status', rotulo: 'Situação', ordenavel: true, formato: (a) => badgeStatusAcerto(a.status) },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<AcertoResumo>>(`/acertos${query(params)}`, { sinal }),
    }),
    [estoques.data, podeVerUsuarios, responsaveis.data],
  );
  return <Listagem config={config} />;
}

interface LinhaItem {
  chave: string;
  id: string | null;
  produto: ProdutoOpcao | null;
  /**
   * Lote do item (F2-B6, F2-B9): escolhido na coluna "Lote" (Entrada, Saída e Mudar tipo) entre os lotes do produto
   * no estoque. Só vai no salvar enquanto o produto da linha for o do lote (trocar o produto descarta o lote).
   */
  lote?: { id: string; codigo: string; produtoId: string } | null;
  quantidade: string;
  custoUnitario: string;
  // Colunas só de exibição da grade (a chave da coluna é um campo da linha).
  saldo?: undefined;
  diferenca?: undefined;
  preco?: undefined;
  total?: undefined;
  totalCusto?: undefined;
}

interface Valores extends Record<string, unknown> {
  estoqueId: string;
  tipoEstoqueId: string;
  tipoAjuste: TipoAjuste;
  /** Só na mudança de tipo (F2-B8). */
  tipoEstoqueDestinoId: string;
  dataContagem: string;
  motivo: string;
  responsavelId: string | null;
  observacoes: string;
  itens: LinhaItem[];
}

let sequencia = 0;
const novaLinha = (): LinhaItem => ({
  chave: `n${++sequencia}`,
  id: null,
  produto: null,
  quantidade: '',
  custoUnitario: '',
});
const vazia = (l: LinhaItem) => !l.produto && !l.quantidade.trim() && !l.custoUnitario.trim();

/** Data e hora local do formulário (`AAAA-MM-DDTHH:mm`, CampoDataHora) ↔ ISO. */
function paraDataLocal(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function paraCorpo(v: Valores): Record<string, unknown> {
  const data = new Date(v.dataContagem);
  return {
    estoqueId: v.estoqueId,
    tipoEstoqueId: v.tipoEstoqueId || null,
    tipoAjuste: v.tipoAjuste,
    // O destino só vai na mudança de tipo (o contrato recusa nos demais): trocar o tipo de ajuste não o apaga da tela.
    tipoEstoqueDestinoId: v.tipoAjuste === 'mudanca_tipo' ? v.tipoEstoqueDestinoId || null : null,
    dataContagem: Number.isNaN(data.getTime()) ? v.dataContagem : data.toISOString(),
    motivo: v.motivo,
    responsavelId: v.responsavelId,
    observacoes: v.observacoes,
    itens: v.itens
      .filter((l) => !vazia(l))
      .map((l) => ({
        id: l.id,
        produtoId: l.produto?.id ?? '',
        variacaoId: null,
        loteId: l.lote && l.lote.produtoId === l.produto?.id ? l.lote.id : null,
        quantidade: l.quantidade,
        custoUnitario: v.tipoAjuste === 'entrada' && l.custoUnitario.trim() ? l.custoUnitario : null,
      })),
  };
}

/**
 * Acerto de Estoque – formulário (ERP 13.5; MD 3.7.5): cabeçalho, grade de itens (F9 insere; saldo atual, diferença
 * do "Definir", custo e totais), Salvar (rascunho), Efetivar (gera os movimentos e atualiza os saldos na mesma
 * transação) e Estornar. "Mudar tipo" (F2-B8; ERP 13.6) leva a quantidade do tipo de origem para o de destino, no
 * mesmo estoque e ao custo médio da origem (o par `MUDANCA_TIPO_ESTOQUE`). F2-B9: "Importar contagem" (só no
 * "Definir" em rascunho e salvo) carrega o arquivo do coletor com prévia; "Imprimir" abre a folha de contagem (cega ou
 * com saldo) do estoque × tipo; a coluna "Lote" escolhe o lote na Entrada, na Saída e na mudança de tipo.
 */
export function FormularioAcerto() {
  const { id } = useParams();
  const pode = usePode();
  const eu = useEu();
  const { lojaId } = useLojaContexto();
  const estoques = useEstoques();
  const tipos = useTiposEstoque();
  const queryClient = useQueryClient();
  const [mostrarErros, setMostrarErros] = useState(false);
  const [estornando, setEstornando] = useState(false);
  const [motivoEstorno, setMotivoEstorno] = useState('');
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);
  const [imprimindo, setImprimindo] = useState(false);
  const verCusto = pode('produtos.ver_custo');

  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: {
      estoqueId: '',
      tipoEstoqueId: '',
      tipoAjuste: 'entrada',
      tipoEstoqueDestinoId: '',
      dataContagem: paraDataLocal(new Date().toISOString()),
      motivo: '',
      responsavelId: null,
      observacoes: '',
      itens: [novaLinha()],
    },
  });
  const c = useCadastro<AcertoDetalhe, Valores>({
    api: '/acertos',
    rota: ROTA_ACERTOS,
    recurso: 'estoque_acertos',
    id,
    form,
    paraValores: (a) => ({
      estoqueId: a.estoqueId,
      tipoEstoqueId: a.tipoEstoqueId,
      tipoAjuste: a.tipoAjuste,
      tipoEstoqueDestinoId: a.tipoEstoqueDestinoId ?? '',
      dataContagem: paraDataLocal(a.dataContagem),
      motivo: a.motivo,
      responsavelId: a.responsavelId,
      observacoes: a.observacoes ?? '',
      itens: [
        ...a.itens.map((i) => ({
          chave: i.id,
          id: i.id,
          produto: i.produto,
          lote: i.loteId ? { id: i.loteId, codigo: i.lote ?? '', produtoId: i.produtoId } : null,
          quantidade: paraTela(i.quantidade, 3),
          custoUnitario: a.tipoAjuste === 'entrada' ? paraTela(i.custoInformado) : '',
        })),
        ...(a.status === 'rascunho' ? [novaLinha()] : []),
      ],
    }),
    paraCorpo,
    schemaCriar: criarAcertoSchema,
    schemaAlterar: alterarAcertoSchema,
    aoErroCampos: () => setMostrarErros(true),
  });
  const a = c.registro.data;
  const v = form.getValues();

  // Estoque padrão: o da loja de contexto (ERP 13.5); tipo padrão: Disponível.
  const estoquePadrao =
    estoques.data?.itens.find((e) => e.lojaId === lojaId)?.id ?? estoques.data?.itens[0]?.id ?? '';
  const tipoPadrao = tipos.data?.find((t) => t.padrao)?.id ?? '';
  useEffect(() => {
    if (!c.novo) return;
    const atuais = form.getValues();
    const novos = {
      ...atuais,
      estoqueId: atuais.estoqueId || estoquePadrao,
      tipoEstoqueId: atuais.tipoEstoqueId || tipoPadrao,
    };
    if (novos.estoqueId === atuais.estoqueId && novos.tipoEstoqueId === atuais.tipoEstoqueId) return;
    form.setValues(novos);
    if (!form.isDirty()) form.resetDirty(novos);
    // `form` muda a cada render; só os padrões carregados importam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.novo, estoquePadrao, tipoPadrao]);

  const status: StatusAcerto = a?.status ?? 'rascunho';
  const rascunho = status === 'rascunho';
  const somenteLeitura = !pode('estoque_acertos.criar') || !rascunho;
  const tipo = v.tipoAjuste;
  const mudanca = tipo === 'mudanca_tipo';
  // Tipos ativos para os seletores; o gravado continua na lista mesmo inativo (o acerto antigo mostra o nome).
  const opcoesTipo = (atual: string) =>
    (tipos.data ?? []).filter((t) => t.ativo || t.id === atual).map((t) => ({ value: t.id, label: t.nome }));
  const destino = tipos.data?.find((t) => t.id === v.tipoEstoqueDestinoId);
  const origem = tipos.data?.find((t) => t.id === v.tipoEstoqueId);

  // Saldo atual e custo médio dos produtos da grade no estoque × tipo (rascunho); efetivado usa o gravado.
  const ids = [...new Set(v.itens.map((l) => l.produto?.id).filter((x): x is string => !!x))].sort();
  const saldos = useQuery({
    queryKey: ['acerto-saldos', v.estoqueId, v.tipoEstoqueId, ids.join(',')],
    queryFn: () =>
      apiErp.get<SaldoItem[]>(
        `/saldos-estoque/itens${query({ estoqueId: v.estoqueId, tipoEstoqueId: v.tipoEstoqueId || undefined, produtoIds: ids.join(',') })}`,
      ),
    enabled: rascunho && !!v.estoqueId && ids.length > 0,
    staleTime: 10_000,
  });
  // Lotes dos produtos da grade (F2-B9): a coluna "Lote" da Entrada, da Saída e da mudança de tipo.
  const comLote = tipo !== 'definir';
  const lotes = useQuery({
    queryKey: ['acerto-lotes', v.estoqueId, v.tipoEstoqueId, ids.join(',')],
    queryFn: () =>
      apiErp.get<LoteSaldoItem[]>(
        `/saldos-estoque/lotes${query({ estoqueId: v.estoqueId, tipoEstoqueId: v.tipoEstoqueId || undefined, produtoIds: ids.join(',') })}`,
      ),
    enabled: rascunho && comLote && !!v.estoqueId && ids.length > 0,
    staleTime: 10_000,
  });
  const lotesDo = (produtoId: string) => (lotes.data ?? []).filter((x) => x.produtoId === produtoId);
  const loteDaLinha = (l: LinhaItem) => (l.lote && l.lote.produtoId === l.produto?.id ? l.lote : null);
  const mostrarLote = comLote && (v.itens.some((l) => loteDaLinha(l)) || (lotes.data?.length ?? 0) > 0);
  // Por item gravado (o mesmo produto pode aparecer em linhas de lotes diferentes).
  const gravados = new Map((a?.itens ?? []).map((i) => [i.id, i]));
  const saldoDe = (l: LinhaItem) => {
    if (!l.produto) return null;
    if (!rascunho) {
      const g = l.id ? gravados.get(l.id) : undefined;
      return g ? { quantidade: Number(g.saldoAtual), custo: Number(g.custoUnitario ?? 0) } : null;
    }
    const s = saldos.data?.find((x) => x.produtoId === l.produto!.id);
    return s
      ? { quantidade: Number(s.quantidade), custo: Number(s.custoMedio ?? l.produto.precoCusto ?? 0) }
      : null;
  };
  const valores = (l: LinhaItem) => {
    const s = saldoDe(l);
    const informado = lerDecimal(l.custoUnitario);
    const custo =
      tipo === 'entrada' && informado !== null ? informado : (s?.custo ?? Number(l.produto?.precoCusto ?? 0));
    return valoresItemAcerto({
      tipo,
      quantidade: lerDecimal(l.quantidade) ?? 0,
      saldoAtual: s?.quantidade ?? 0,
      custoUnitario: custo,
      precoVenda: Number(l.produto?.precoVenda ?? 0),
    });
  };
  const efetivadoItem = (l: LinhaItem) => (l.produto && l.id ? gravados.get(l.id) : undefined);

  const errosForm = form.errors;
  const validar = (l: LinhaItem) => {
    const e: Partial<Record<keyof LinhaItem | '_linha', string>> = {};
    const i = v.itens.filter((x) => !vazia(x)).indexOf(l);
    const api = (campo: string) => errosForm[`itens.${i}.${campo}`] as string | undefined;
    if (!l.produto) e.produto = api('produtoId') ?? 'Escolha o produto';
    else if (!l.produto.controlaEstoque) e.produto = 'Produto sem controle de estoque';
    else if (api('produtoId')) e.produto = api('produtoId');
    const q = lerDecimal(l.quantidade);
    if (q === null || q < 0 || (tipo !== 'definir' && q === 0))
      e.quantidade = tipo === 'definir' ? 'Quantidade contada ≥ 0' : 'Quantidade maior que zero';
    else if (api('quantidade')) e.quantidade = api('quantidade');
    if (l.custoUnitario.trim() && lerDecimal(l.custoUnitario) === null) e.custoUnitario = 'Custo inválido';
    return e;
  };

  const colunas: ColunaGrade<LinhaItem>[] = [
    {
      campo: 'produto',
      rotulo: 'Produto',
      tipo: 'texto',
      largura: '32%',
      editor: ({ linha, aoMudar, campo }) => (
        <>
          <SeletorProduto
            value={linha.produto?.id ?? null}
            produto={linha.produto}
            onChange={(_, p) => aoMudar(p)}
            // No "Definir" o produto é contado uma vez; nos demais, o mesmo produto pode vir em lotes diferentes.
            excluir={
              tipo === 'definir'
                ? v.itens.filter((x) => x !== linha && x.produto).map((x) => x.produto!.id)
                : undefined
            }
            tipos={TIPOS_COM_ESTOQUE}
            size="xs"
            error={!!campo['aria-invalid']}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
            disabled={campo.disabled}
          />
          {linha.lote && linha.lote.produtoId === linha.produto?.id && (
            <Text size="xs" c="dimmed">
              Lote {linha.lote.codigo}
            </Text>
          )}
        </>
      ),
    },
    ...(mostrarLote
      ? [
          {
            campo: 'lote',
            rotulo: 'Lote',
            tipo: 'texto',
            largura: 170,
            editor: ({ linha, aoMudar, campo }) => {
              const atual = loteDaLinha(linha);
              const opcoes = linha.produto ? lotesDo(linha.produto.id) : [];
              if (campo.disabled || !linha.produto || (!opcoes.length && !atual))
                return (
                  <Text size="sm" c="dimmed">
                    {atual?.codigo ?? '—'}
                  </Text>
                );
              const data = [
                { value: '', label: tipo === 'entrada' ? 'Sem lote' : 'Sem lote (FEFO)' },
                ...(atual && !opcoes.some((o) => o.loteId === atual.id)
                  ? [{ value: atual.id, label: atual.codigo }]
                  : []),
                ...opcoes.map((o) => ({
                  value: o.loteId,
                  label: [
                    o.lote,
                    o.validade && `val. ${o.validade.split('-').reverse().join('/')}`,
                    `saldo ${qtd(o.quantidade)}`,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                })),
              ];
              return (
                <NativeSelect
                  size="xs"
                  data={data}
                  value={atual?.id ?? ''}
                  onChange={(e) => {
                    const o = opcoes.find((x) => x.loteId === e.currentTarget.value);
                    aoMudar(
                      o
                        ? { id: o.loteId, codigo: o.lote, produtoId: o.produtoId }
                        : e.currentTarget.value && atual
                          ? atual
                          : null,
                    );
                  }}
                  ref={campo.ref as never}
                  onKeyDown={campo.onKeyDown as never}
                  aria-label={campo['aria-label']}
                />
              );
            },
          } satisfies ColunaGrade<LinhaItem>,
        ]
      : []),
    {
      campo: 'saldo',
      rotulo: mudanca ? 'Saldo na origem' : 'Saldo atual',
      tipo: 'leitura',
      largura: 100,
      formato: (l) => {
        const s = saldoDe(l);
        return (
          <Text size="sm" ta="right">
            {s ? `${qtd(s.quantidade)} ${l.produto?.unidadeSigla ?? ''}` : '—'}
          </Text>
        );
      },
    },
    {
      campo: 'quantidade',
      rotulo: tipo === 'definir' ? 'Contado' : 'Quant.',
      tipo: 'numero',
      largura: 100,
    },
    ...(tipo === 'definir'
      ? [
          {
            campo: 'diferenca',
            rotulo: 'Diferença',
            tipo: 'leitura',
            largura: 100,
            formato: (l: LinhaItem) => {
              if (!l.produto || !l.quantidade.trim()) return '—';
              const g = efetivadoItem(l);
              const d = g && !rascunho ? Number(g.diferenca) : valores(l).diferenca;
              return (
                <Text size="sm" ta="right" c={d < 0 ? 'red' : d > 0 ? 'green' : undefined}>
                  {d > 0 ? '+' : ''}
                  {qtd(d)}
                </Text>
              );
            },
          } satisfies ColunaGrade<LinhaItem>,
        ]
      : []),
    ...(verCusto
      ? [
          tipo === 'entrada' && rascunho
            ? ({
                campo: 'custoUnitario',
                rotulo: 'Custo unit.',
                tipo: 'dinheiro',
                largura: 110,
              } satisfies ColunaGrade<LinhaItem>)
            : ({
                campo: 'custoUnitario',
                rotulo: 'Custo unit.',
                tipo: 'leitura',
                largura: 110,
                formato: (l: LinhaItem) => {
                  const g = efetivadoItem(l);
                  if (g && !rascunho)
                    return (
                      <Text size="sm" ta="right">
                        {reais(Number(g.custoUnitario ?? 0))}
                      </Text>
                    );
                  const s = saldoDe(l);
                  return (
                    <Text size="sm" ta="right">
                      {l.produto ? reais(s?.custo ?? 0) : '—'}
                    </Text>
                  );
                },
              } satisfies ColunaGrade<LinhaItem>),
        ]
      : []),
    {
      campo: 'preco',
      rotulo: 'Preço venda',
      tipo: 'leitura',
      largura: 100,
      formato: (l) => (
        <Text size="sm" ta="right">
          {l.produto ? reais(Number(l.produto.precoVenda)) : '—'}
        </Text>
      ),
    },
    {
      campo: 'total',
      rotulo: 'Total',
      tipo: 'leitura',
      largura: 110,
      formato: (l) => (
        <Text size="sm" ta="right">
          {l.produto ? reais(valores(l).totalVenda) : '—'}
        </Text>
      ),
    },
    ...(verCusto
      ? [
          {
            campo: 'totalCusto',
            rotulo: 'Total custo',
            tipo: 'leitura',
            largura: 110,
            formato: (l: LinhaItem) => (
              <Text size="sm" ta="right">
                {l.produto ? reais(valores(l).totalCusto) : '—'}
              </Text>
            ),
          } satisfies ColunaGrade<LinhaItem>,
        ]
      : []),
  ];

  const preenchidas = v.itens.filter((l) => !vazia(l) && l.produto);
  const totais = totaisAcerto(
    preenchidas.map((l) => {
      const s = saldoDe(l);
      const informado = lerDecimal(l.custoUnitario);
      return {
        tipo,
        quantidade: lerDecimal(l.quantidade) ?? 0,
        saldoAtual: s?.quantidade ?? 0,
        custoUnitario: tipo === 'entrada' && informado !== null ? informado : (s?.custo ?? 0),
        precoVenda: Number(l.produto!.precoVenda),
      };
    }),
  );

  const depoisDaAcao = (d: AcertoDetalhe, mensagem: string) => {
    setErroAcao(null);
    queryClient.setQueryData(['estoque_acertos', d.id], d);
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_acertos'] });
    void queryClient.invalidateQueries({ queryKey: ['acerto-saldos'] });
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_saldos'] });
    notifications.show({ color: 'green', message: mensagem });
  };
  const aoErroAcao = (e: unknown) => {
    if (e instanceof ErroRequisicao) {
      setErroAcao(e.message);
      if (e.campos) {
        form.setErrors(errosDaApi(e.campos));
        setMostrarErros(true);
      }
    } else setErroAcao((e as Error).message);
  };
  const efetivar = useMutation({
    mutationFn: () => apiErp.post<AcertoDetalhe>(`/acertos/${id}/efetivar`, { versao: a!.versao }),
    onSuccess: (d) => depoisDaAcao(d, 'Acerto efetivado: estoque atualizado'),
    onError: aoErroAcao,
  });
  const estornar = useMutation({
    mutationFn: () =>
      apiErp.post<AcertoDetalhe>(`/acertos/${id}/estornar`, { versao: a!.versao, motivo: motivoEstorno }),
    onSuccess: (d) => {
      setEstornando(false);
      setMotivoEstorno('');
      depoisDaAcao(d, 'Acerto estornado');
    },
    onError: aoErroAcao,
  });

  // Contagem gravada (F2-B9): recarrega o rascunho; a divisão acima de 5.000 itens avisa os rascunhos novos, e o
  // produto somado noutro rascunho da mesma contagem avisa qual.
  const aposImportar = (p: PreviaContagem) => {
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_acertos'] });
    c.recarregar();
    const outros = p.outrosAcertos.length
      ? ` Também alterado(s), por já ter(em) o produto: Nº ${p.outrosAcertos.map((x) => x.codigo).join(', ')}.`
      : '';
    notifications.show({
      color: 'green',
      message:
        (p.acertos.length > 1
          ? `Contagem gravada em ${p.acertos.length} rascunhos: Nº ${p.acertos.map((x) => x.codigo).join(', ')} (mesma hora da contagem). Efetive todos.`
          : `Contagem gravada: ${p.totais.produtos + p.totais.zerados} produto(s) no rascunho.`) + outros,
      autoClose: p.acertos.length > 1 || outros ? false : undefined,
    });
  };

  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_ACERTOS} />;
  const sujo = form.isDirty();
  const podeEfetivar = !c.novo && rascunho && pode('estoque_acertos.criar');

  const salvar = () => {
    setMostrarErros(true);
    form.setFieldValue(
      'itens',
      v.itens.filter((l) => !vazia(l)),
    );
    c.salvar();
  };

  const acoes = (
    <>
      {podeEfetivar && (
        <Tooltip label="Salve as alterações antes de efetivar" disabled={!sujo}>
          <Button
            color="green"
            leftSection={<IconCircleCheck size={16} />}
            disabled={sujo || !a?.itens.length}
            loading={efetivar.isPending}
            onClick={() => efetivar.mutate()}
          >
            Efetivar
          </Button>
        </Tooltip>
      )}
      {podeEfetivar && tipo === 'definir' && (
        <Tooltip label="Salve as alterações antes de importar" disabled={!sujo}>
          <Button
            variant="default"
            leftSection={<IconFileImport size={16} />}
            disabled={sujo}
            onClick={() => setImportando(true)}
          >
            Importar contagem
          </Button>
        </Tooltip>
      )}
      {!!v.estoqueId && (
        <Button variant="default" leftSection={<IconPrinter size={16} />} onClick={() => setImprimindo(true)}>
          Imprimir
        </Button>
      )}
      {status === 'efetivado' && pode('estoque_acertos.estornar') && (
        <Button
          variant="default"
          color="red"
          leftSection={<IconArrowBackUp size={16} />}
          onClick={() => setEstornando(true)}
        >
          Estornar
        </Button>
      )}
    </>
  );

  return (
    <>
      <FormularioEntidade
        titulo={c.novo ? 'Novo acerto de estoque' : `Acerto de estoque Nº ${a?.codigo ?? ''}`}
        codigo={a?.codigo}
        situacao={a ? { rotulo: ROTULOS_STATUS_ACERTO[a.status], cor: CORES_STATUS[a.status] } : null}
        alteradoEm={a?.atualizadoEm}
        alteradoPor={a?.atualizadoPorNome}
        carregando={!c.novo && c.registro.isPending}
        salvando={c.salvando}
        somenteLeitura={somenteLeitura}
        avisoSomenteLeitura={
          !rascunho
            ? `Acerto ${ROTULOS_STATUS_ACERTO[status].toLowerCase()}: o documento não muda mais${status === 'efetivado' ? ' (use Estornar)' : ''}.`
            : undefined
        }
        sujo={sujo}
        rotaVoltar={ROTA_ACERTOS}
        rotaNovo={pode('estoque_acertos.criar') ? `${ROTA_ACERTOS}/novo` : undefined}
        aoSalvar={salvar}
        aoExcluir={!c.novo && rascunho ? c.excluir : undefined}
        erro={c.erro}
        aoRecarregar={c.recarregar}
        historico={a ? { entidade: 'acertos_estoque', registroId: a.id } : undefined}
        acoesExtras={acoes}
        abas={[
          {
            valor: 'dados',
            rotulo: 'Acerto',
            conteudo: (
              <Stack>
                {erroAcao && (
                  <Alert color="red" role="alert" withCloseButton onClose={() => setErroAcao(null)}>
                    {erroAcao}
                  </Alert>
                )}
                {a?.avisos.map((m) => (
                  <Alert key={m} color="yellow" icon={<IconInfoCircle size={18} />}>
                    {m}
                  </Alert>
                ))}
                {a && a.status !== 'rascunho' && (
                  <Text size="sm" c="dimmed">
                    {a.efetivadoEm &&
                      `Efetivado em ${formatarDataHora(a.efetivadoEm)} por ${a.efetivadoPorNome ?? '—'}. `}
                    {a.estornadoEm &&
                      `Estornado em ${formatarDataHora(a.estornadoEm)} por ${a.estornadoPorNome ?? '—'}: ${a.motivoEstorno ?? ''}`}
                    {a.origem !== 'manual' && ` Origem: ${ROTULOS_ORIGEM_ACERTO[a.origem]}.`}
                  </Text>
                )}
                <Grid>
                  <Grid.Col span={{ base: 12, md: 4 }}>
                    <Select
                      label="Estoque (loja)"
                      required
                      allowDeselect={false}
                      data={(estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome }))}
                      {...form.getInputProps('estoqueId')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 3 }}>
                    <Select
                      label={mudanca ? 'Tipo de origem' : 'Tipo de estoque'}
                      required
                      allowDeselect={false}
                      data={opcoesTipo(v.tipoEstoqueId)}
                      {...form.getInputProps('tipoEstoqueId')}
                    />
                  </Grid.Col>
                  {/* A primeira linha não muda com o tipo de ajuste (12 colunas: o controle não sai do lugar ao
                      escolher "Mudar tipo"); na mudança de tipo, o destino abre a segunda, que também fecha em 12. */}
                  <Grid.Col span={{ base: 12, md: 5 }}>
                    <Text size="sm" fw={500} mb={4}>
                      Tipo de ajuste
                    </Text>
                    <SegmentedControl
                      aria-label="Tipo de ajuste"
                      fullWidth
                      data={OPCOES_TIPO}
                      disabled={somenteLeitura || (!!a && a.qtdItens > 0)}
                      {...form.getInputProps('tipoAjuste')}
                    />
                    {!!a && a.qtdItens > 0 && rascunho && (
                      <Text size="xs" c="dimmed">
                        O tipo não muda depois de haver itens gravados.
                      </Text>
                    )}
                  </Grid.Col>
                  {mudanca && (
                    <Grid.Col span={{ base: 12, md: 3 }}>
                      <Select
                        label="Tipo de destino"
                        required
                        allowDeselect={false}
                        placeholder="Para onde vai o saldo"
                        data={opcoesTipo(v.tipoEstoqueDestinoId).filter((t) => t.value !== v.tipoEstoqueId)}
                        {...form.getInputProps('tipoEstoqueDestinoId')}
                      />
                    </Grid.Col>
                  )}
                  <Grid.Col span={{ base: 12, md: 3 }}>
                    <CampoDataHora
                      label="Data"
                      required
                      clearable={false}
                      // Só o "Definir" lança na data informada; Entrada e Saída lançam na efetivação (F2-B4).
                      description={
                        tipo === 'definir'
                          ? 'Hora da contagem'
                          : 'Data do documento: o estoque muda ao efetivar'
                      }
                      {...form.getInputProps('dataContagem')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: mudanca ? 3 : 5 }}>
                    <Autocomplete
                      label="Motivo"
                      required
                      maxLength={120}
                      data={[...MOTIVOS_ACERTO]}
                      comboboxProps={{ withinPortal: true }}
                      {...form.getInputProps('motivo')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: mudanca ? 3 : 4 }}>
                    {pode('usuarios.ver') ? (
                      <SeletorUsuario
                        label="Responsável"
                        description="Vazio = você"
                        value={v.responsavelId}
                        onChange={(uid) => form.setFieldValue('responsavelId', uid)}
                      />
                    ) : (
                      <TextInput label="Responsável" readOnly value={a?.responsavelNome ?? eu.usuario.nome} />
                    )}
                  </Grid.Col>
                  <Grid.Col span={12}>
                    <Textarea
                      label="Observações"
                      autosize
                      minRows={1}
                      {...form.getInputProps('observacoes')}
                    />
                  </Grid.Col>
                </Grid>
                {tipo === 'definir' && rascunho && (
                  <Text size="xs" c="dimmed">
                    Definir: informe a quantidade contada. A diferença é recalculada ao efetivar, descontando
                    as vendas e movimentos posteriores à hora da contagem (ERP 13.1.5).
                  </Text>
                )}
                {mudanca && rascunho && (
                  <Text size="xs" c="dimmed">
                    Mudar tipo: a quantidade sai do tipo de origem ao custo médio dele e entra no tipo de
                    destino com o mesmo custo, no mesmo estoque (ERP 13.6). O estorno devolve as duas partes.
                  </Text>
                )}
                {mudanca && rascunho && origem?.vendavel && destino && !destino.vendavel && (
                  <Alert color="blue" icon={<IconInfoCircle size={18} />}>
                    &quot;{destino.nome}&quot; não é vendável: ao efetivar, a quantidade sai do saldo que os
                    PDVs vendem.
                  </Alert>
                )}
                <GradeItens
                  rotulo="Itens do acerto"
                  linhas={v.itens}
                  aoMudar={(linhas) => form.setFieldValue('itens', linhas)}
                  colunas={colunas}
                  novaLinha={novaLinha}
                  chave={(l) => l.chave}
                  validar={validar}
                  vazia={vazia}
                  mostrarErros={mostrarErros}
                  somenteLeitura={somenteLeitura}
                />
                <Group justify="flex-end" gap="xl" data-testid="totais-acerto">
                  <Text size="sm">
                    Qtd produtos: <b>{totais.qtdItens}</b>
                  </Text>
                  <Text size="sm">
                    Total (venda): <b>{reais(a && !rascunho ? Number(a.totalVenda) : totais.totalVenda)}</b>
                  </Text>
                  {verCusto && (
                    <Text size="sm">
                      Total (custo):{' '}
                      <b>{reais(a && !rascunho ? Number(a.totalCusto ?? 0) : totais.totalCusto)}</b>
                    </Text>
                  )}
                </Group>
              </Stack>
            ),
          },
          // As compensações das vendas offline (F2-B10): só o efetivado ou estornado tem movimento.
          ...(a && !rascunho
            ? [
                {
                  valor: 'compensacoes',
                  rotulo: a.totalCompensacoes
                    ? `Compensações (${a.totalCompensacoes.toLocaleString('pt-BR')})`
                    : 'Compensações',
                  comAviso: a.compensacoes.some((x) => x.relogioSuspeito),
                  conteudo: <AbaCompensacoes acerto={a} verCusto={verCusto} />,
                },
              ]
            : []),
          // A conferência da contagem (F2-B11): o "Definir" com itens gravados; o estornado não vale mais.
          ...(a && a.tipoAjuste === 'definir' && a.status !== 'estornado' && a.itens.length > 0
            ? [
                {
                  valor: 'conferencia',
                  rotulo: 'Conferência',
                  consulta: true,
                  conteudo: <AbaConferencia acerto={a} verCusto={verCusto} />,
                },
              ]
            : []),
        ]}
      />
      {a && podeEfetivar && (
        <ModalImportarContagem
          aberto={importando}
          aoFechar={() => setImportando(false)}
          acertoId={a.id}
          versao={a.versao}
          aoGravar={aposImportar}
        />
      )}
      <ModalFolhaContagem
        aberto={imprimindo}
        aoFechar={() => setImprimindo(false)}
        estoqueId={v.estoqueId}
        tipoEstoqueId={v.tipoEstoqueId}
      />
      <Modal opened={estornando} onClose={() => setEstornando(false)} title="Estornar acerto">
        <Stack>
          <Text size="sm">
            O estorno lança um movimento de sinal oposto para cada item e devolve o estoque ao que era antes
            do acerto.
          </Text>
          <TextInput
            label="Motivo do estorno"
            required
            data-autofocus
            value={motivoEstorno}
            onChange={(e) => setMotivoEstorno(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEstornando(false)}>
              Cancelar
            </Button>
            <Button
              color="red"
              disabled={!motivoEstorno.trim()}
              loading={estornar.isPending}
              onClick={() => estornar.mutate()}
            >
              Estornar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
