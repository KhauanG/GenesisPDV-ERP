import {
  alterarRecebimentoSchema,
  ATUALIZAR_PRECO_RECEBIMENTO,
  criarRecebimentoSchema,
  dec,
  hojeNoFuso,
  ROTULOS_ATUALIZAR_PRECO,
  ROTULOS_STATUS_RECEBIMENTO,
  STATUS_RECEBIMENTO,
  totaisRecebimentoTexto,
  type AtualizarPrecoRecebimento,
  type DadosCompraProdutos,
  type EstoqueResumo,
  type Pagina,
  type PessoaOpcao,
  type PessoaResumo,
  type PrecoCustoAAtualizar,
  type ProdutoOpcao,
  type RecebimentoDetalhe,
  type RecebimentoResumo,
  type SaldoNegativoEstorno,
  type StatusRecebimento,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  List,
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
  IconArrowBackUp,
  IconCircleCheck,
  IconInfoCircle,
  IconPackageImport,
  IconPrinter,
} from '@tabler/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao, query } from '../../api/http';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { CadastroRapidoProduto } from '../../componentes/CadastroRapidoProduto';
import { useCadastro } from '../../componentes/cadastro';
import { CampoData } from '../../componentes/campos/CamposData';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { dataParaGrade, formatarDecimal, textoDecimal } from '../../componentes/grade/decimal';
import { GradeItens, type ColunaGrade } from '../../componentes/grade/GradeItens';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { SeletorLoja } from '../../componentes/seletores/SeletorLoja';
import { SeletorPessoa } from '../../componentes/seletores/SeletorPessoa';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { useLojaContexto } from '../../layout/lojaContexto';
import { errosDaApi, errosDoZod } from '../../util/erros';
import { formatarData, formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import {
  ConfirmacaoNegativoEstorno,
  PerguntaPrecoCusto,
  precosCustoDoErro,
  useConfirmacaoNegativo,
} from './ConfirmacoesEntrada';
import {
  COLUNA_DO_CAMPO,
  contasDasLinhas,
  dadosCompraEmBlocos,
  errosDaLinha,
  exigeLote,
  itemParaApi,
  linhaVazia,
  novaLinhaRecebimento,
  pedeMudancaPreco,
  precoAlterado,
  precoEMarkup,
  semResposta,
  TIPOS_RECEBIMENTO,
  type LinhaRecebimento,
} from './recebimentoItens';

export const ROTA_RECEBIMENTOS = '/estoque/recebimentos';
/** O espelho impresso pelo navegador (aba nova; padrão "Impressão" do plano da Fase 2). */
export const urlEspelhoRecebimento = (id: string) => `${ROTA_RECEBIMENTOS}/${id}/espelho?imprimir=1`;

const CORES_STATUS: Record<StatusRecebimento, string> = {
  rascunho: 'yellow',
  movimentado: 'green',
  estornado: 'gray',
};
const OPCOES_STATUS = STATUS_RECEBIMENTO.map((s) => ({ value: s, label: ROTULOS_STATUS_RECEBIMENTO[s] }));

const reais = (v: string | number) => `R$ ${formatarDecimal(Number(v), 2)}`;
const qtd = (v: string | number) => formatarDecimal(Number(v), 3);
/** Decimal da API ("2.1000") para o campo ("2,1"). */
const paraTela = (v: string | null | undefined, casas = 4) =>
  v === null || v === undefined ? '' : formatarDecimal(Number(v), casas).replace(/\./g, '');

export const badgeStatusRecebimento = (s: StatusRecebimento) => (
  <Badge color={CORES_STATUS[s]} variant="light">
    {ROTULOS_STATUS_RECEBIMENTO[s]}
  </Badge>
);

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

/** Fornecedores para o filtro da listagem (só com `pessoas.ver`). */
function useFornecedores(habilitado: boolean) {
  return useQuery({
    queryKey: ['opcoes', 'fornecedores'],
    queryFn: () =>
      apiErp.get<Pagina<PessoaResumo>>(
        `/pessoas${query({ categorias: 'fornecedor', tamanho: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: habilitado,
    staleTime: 60_000,
  });
}

/** Recebimento manual de produtos – listagem (ERP 13.3). */
export function ListaRecebimentos() {
  const estoques = useEstoques();
  const podeVerPessoas = usePode()('pessoas.ver');
  const fornecedores = useFornecedores(podeVerPessoas);
  const config = useMemo<ConfigListagem<RecebimentoResumo>>(
    () => ({
      recurso: 'recebimentos',
      titulo: 'Recebimento manual de produtos',
      ordenacaoPadrao: 'data:desc',
      rotaNovo: `${ROTA_RECEBIMENTOS}/novo`,
      rotuloNovo: 'Novo recebimento',
      rotaEdicao: (r) => `${ROTA_RECEBIMENTOS}/${r.id}`,
      chaveLinha: (r) => r.id,
      filtros: [
        ...(podeVerPessoas
          ? [
              {
                campo: 'fornecedorId',
                rotulo: 'Fornecedor',
                tipo: 'selecao' as const,
                opcoes: (fornecedores.data?.itens ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.codigo} - ${p.nome}`,
                })),
              },
            ]
          : []),
        { campo: 'codigo', rotulo: 'Id recebimento', tipo: 'numero' },
        { campo: 'codigoRemessa', rotulo: 'Cód. remessa', tipo: 'texto' },
        {
          campo: 'estoqueId',
          rotulo: 'Estoque',
          tipo: 'selecao',
          opcoes: (estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome })),
        },
        { campo: 'dataInicial', rotulo: 'Data inicial', tipo: 'data' },
        { campo: 'dataFinal', rotulo: 'Data final', tipo: 'data' },
        { campo: 'status', rotulo: 'Movimentado?', tipo: 'selecao', opcoes: OPCOES_STATUS },
      ],
      colunas: [
        // A primeira coluna já é o link para o recebimento (`<Listagem>`).
        { campo: 'fornecedor', rotulo: 'Fornecedor', ordenavel: true, formato: (r) => r.fornecedorNome },
        {
          campo: 'data',
          rotulo: 'Data recebimento',
          ordenavel: true,
          formato: (r) => formatarData(r.dataRecebimento),
        },
        { campo: 'remessa', rotulo: 'Cód. remessa', ordenavel: true, formato: (r) => r.codigoRemessa ?? '—' },
        {
          campo: 'status',
          rotulo: 'Movimentado?',
          ordenavel: true,
          formato: (r) => badgeStatusRecebimento(r.status),
        },
        { campo: 'codigo', rotulo: 'Id', ordenavel: true, largura: 80 },
        { campo: 'estoque', rotulo: 'Estoque', ordenavel: true, formato: (r) => r.estoqueNome },
        {
          campo: 'total',
          rotulo: 'Total',
          ordenavel: true,
          alinhamento: 'right',
          formato: (r) => reais(r.valorTotal),
        },
      ],
      buscar: (params, sinal) =>
        apiErp.get<Pagina<RecebimentoResumo>>(`/recebimentos${query(params)}`, { sinal }),
    }),
    [estoques.data, podeVerPessoas, fornecedores.data],
  );
  return <Listagem config={config} />;
}

interface Valores extends Record<string, unknown> {
  lojaId: string | null;
  estoqueId: string;
  tipoEstoqueId: string;
  fornecedor: PessoaOpcao | null;
  dataRecebimento: string;
  codigoRemessa: string;
  temValidade: boolean;
  valorFrete: string;
  valorDesconto: string;
  valorOutrasDespesas: string;
  observacoes: string;
  itens: LinhaRecebimento[];
}

/** O que falta responder antes de gravar: a pergunta geral/loja/não dos itens com o preço de venda alterado. */
interface PerguntaPreco {
  chaves: string[];
  /** Quantos desses itens são de produto com preço próprio na loja (o "geral" não vale nela). */
  comPrecoDaLoja: number;
  depois: () => void;
}

/**
 * Recebimento manual de produtos – formulário (ERP 13.3; MD 3.8.1; Fase 2, F2-B16; README do ERP › decisão 56): o
 * cabeçalho (loja, estoque e tipo de destino, fornecedor com o cadastro rápido, data, Cód. remessa, validade, frete,
 * desconto e outras despesas) e a grade (produto ou EAN — o código da embalagem de compra preenche o fator —,
 * quantidade, preço de compra, rateio e custo final como a movimentação vai gravar, markup ⇄ preço de venda sobre a
 * base de `produtos.custo_base_margem` com a pergunta geral/loja/não, lote e validade quando o produto pede ou tem
 * lote). "Cadastrar novo produto" abre o cadastro rápido. Salvar (rascunho), "Salvar e movimentar" (com a pergunta do
 * preço de custo, D49), Estornar com motivo e o espelho impresso pelo navegador. "Gerar financeiro" fica para a Fase 4.
 */
export function FormularioRecebimento() {
  const { id } = useParams();
  const pode = usePode();
  const eu = useEu();
  const { lojaId: lojaContexto } = useLojaContexto();
  const estoques = useEstoques();
  const tipos = useTiposEstoque();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mostrarErros, setMostrarErros] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [processando, setProcessando] = useState(false);
  const [estornando, setEstornando] = useState(false);
  const [motivoEstorno, setMotivoEstorno] = useState('');
  /** Os saldos que o estorno deixará negativos, à espera da confirmação de quem pode (D56 com aviso). */
  const negativo = useConfirmacaoNegativo();
  const [perguntaPreco, setPerguntaPreco] = useState<PerguntaPreco | null>(null);
  const [perguntaCusto, setPerguntaCusto] = useState<{
    detalhe: RecebimentoDetalhe;
    produtos: PrecoCustoAAtualizar[];
  } | null>(null);
  const [cadastrando, setCadastrando] = useState(false);

  const lojaInicial =
    lojaContexto ??
    eu.lojas.find((l) => l.ativa && !l.treino)?.id ??
    eu.lojas.find((l) => l.ativa)?.id ??
    null;
  const form = useForm<Valores>({
    mode: 'controlled',
    initialValues: {
      lojaId: lojaInicial,
      estoqueId: '',
      tipoEstoqueId: '',
      fornecedor: null,
      dataRecebimento: hojeNoFuso(),
      codigoRemessa: '',
      temValidade: false,
      valorFrete: '',
      valorDesconto: '',
      valorOutrasDespesas: '',
      observacoes: '',
      itens: [novaLinhaRecebimento()],
    },
  });
  const v = form.getValues();
  const cab = {
    valorFrete: v.valorFrete,
    valorDesconto: v.valorDesconto,
    valorOutrasDespesas: v.valorOutrasDespesas,
    temValidade: v.temValidade,
  };

  // Dados de compra dos produtos da grade no estoque × tipo de destino (embalagens, lote, saldo, base do markup) e o
  // preço da loja destinatária, em blocos (o recebimento aceita até 990 itens; o contrato, 200 ids por consulta).
  const ids = [...new Set(v.itens.map((l) => l.produto?.id).filter((x): x is string => !!x))].sort();
  const consultaDados = (produtoIds: string[]) => ({
    queryKey: ['recebimento-dados', v.estoqueId, v.tipoEstoqueId, v.lojaId, produtoIds.join(',')],
    queryFn: () =>
      dadosCompraEmBlocos(produtoIds, (bloco) =>
        apiErp.get<DadosCompraProdutos>(
          `/recebimentos/dados-produtos${query({
            produtoIds: bloco.join(','),
            estoqueId: v.estoqueId || undefined,
            tipoEstoqueId: v.tipoEstoqueId || undefined,
            lojaId: v.lojaId || undefined,
          })}`,
        ),
      ),
    staleTime: 30_000,
  });
  const contas = contasDasLinhas(
    v.itens.filter((l) => !linhaVazia(l)),
    cab,
  );

  const c = useCadastro<RecebimentoDetalhe, Valores>({
    api: '/recebimentos',
    rota: ROTA_RECEBIMENTOS,
    recurso: 'recebimentos',
    id,
    form,
    paraValores: (r) => ({
      lojaId: r.lojaId,
      estoqueId: r.estoqueId,
      tipoEstoqueId: r.tipoEstoqueId,
      fornecedor: r.fornecedor,
      dataRecebimento: r.dataRecebimento,
      codigoRemessa: r.codigoRemessa ?? '',
      temValidade: r.temValidade,
      valorFrete: paraTela(r.valorFrete, 2),
      valorDesconto: paraTela(r.valorDesconto, 2),
      valorOutrasDespesas: paraTela(r.valorOutrasDespesas, 2),
      observacoes: r.observacoes ?? '',
      itens: [
        ...r.itens.map((i): LinhaRecebimento => ({
          chave: i.id,
          id: i.id,
          produto: i.produto,
          codigoBarrasId: i.codigoBarrasId,
          fator: paraTela(i.fator, 3),
          quantidade: paraTela(i.quantidade, 3),
          precoCompra: paraTela(i.precoCompra),
          precoVenda: paraTela(i.precoVenda),
          markup: null,
          // O "não" gravado fica (inclusive o dos itens com o preço igual): só a edição do preço ou do markup volta a
          // linha a "sem resposta" e a pergunta (`semResposta`). Reabrir não pergunta de novo sobre o que já foi
          // respondido nem sobre o preço do produto mudado depois, e quem só movimenta não precisa regravar.
          atualizarPreco: i.atualizarPreco,
          lote: i.lote ?? '',
          validade: dataParaGrade(i.validade),
          fabricacao: dataParaGrade(i.fabricacao),
        })),
        ...(r.status === 'rascunho' ? [novaLinhaRecebimento()] : []),
      ],
    }),
    paraCorpo: (x) => paraCorpo(x),
    schemaCriar: criarRecebimentoSchema,
    schemaAlterar: alterarRecebimentoSchema,
    mapearErros: (campos) => ({
      ...campos,
      ...(campos.fornecedorId ? { fornecedor: campos.fornecedorId } : {}),
    }),
    aoErroCampos: () => setMostrarErros(true),
    aoGravar: (d) => avisarRemessa(d),
  });
  const r = c.registro.data;
  const status: StatusRecebimento = r?.status ?? 'rascunho';
  const rascunho = status === 'rascunho';
  const podeGravar = c.novo ? pode('recebimentos.criar') : pode('recebimentos.editar');
  const somenteLeitura = !rascunho || !podeGravar;

  // Os dados anteriores ficam enquanto a consulta com o produto novo responde (a base do markup das outras linhas não
  // cai para o padrão); quem grava espera os dados novos (`aguardandoDados`) e, sem eles, não grava (`falhaDados`):
  // sem eles, a base do markup, o lote obrigatório e o preço da loja estariam errados sem aviso.
  const dados = useQuery({
    ...consultaDados(ids),
    enabled: rascunho && ids.length > 0,
    placeholderData: keepPreviousData,
  });
  const precisaDados = rascunho && podeGravar && ids.length > 0;
  const aguardandoDados = precisaDados && (dados.isPending || dados.isPlaceholderData) && !dados.isError;
  const falhaDados = precisaDados && dados.isError;
  // Quem não pode mudar o preço de venda ("Altera Preço do Produto no ERP" desligada e sem "Produtos: Alterar preço")
  // não vê a pergunta geral/loja/não nem edita markup e preço: a linha vai com "Não" (a API recusaria a mudança).
  // Enquanto os dados não chegam, vale o padrão da chave (ligada); quem grava espera os dados.
  const podeAlterarPreco = dados.data?.podeAlterarPreco ?? true;
  // O rascunho gravado por quem podia mudar o preço ("geral"/"só da loja"): sem a permissão, a linha vai com "Não"
  // (`itemParaApi`) e o aviso diz que a mudança gravada não será aplicada.
  const precoDescartado = (itens: LinhaRecebimento[]) =>
    rascunho && podeGravar && !podeAlterarPreco && itens.some((l) => !linhaVazia(l) && pedeMudancaPreco(l));
  const dadosDo = (produtoId: string | undefined) =>
    produtoId ? dados.data?.produtos.find((p) => p.produtoId === produtoId) : undefined;
  const pmDe = (l: LinhaRecebimento) =>
    precoEMarkup(l, contas.get(l.chave), dados.data, dadosDo(l.produto?.id));

  function paraCorpo(x: Valores): Record<string, unknown> {
    return {
      lojaId: x.lojaId ?? '',
      estoqueId: x.estoqueId || null,
      tipoEstoqueId: x.tipoEstoqueId || null,
      fornecedorId: x.fornecedor?.id ?? '',
      dataRecebimento: x.dataRecebimento || null,
      codigoRemessa: x.codigoRemessa,
      temValidade: x.temValidade,
      valorFrete: x.valorFrete,
      valorDesconto: x.valorDesconto,
      valorOutrasDespesas: x.valorOutrasDespesas,
      observacoes: x.observacoes,
      itens: x.itens.filter((l) => !linhaVazia(l)).map((l) => itemParaApi(l, pmDe(l), podeAlterarPreco)),
    };
  }

  function avisarRemessa(d: RecebimentoDetalhe) {
    if (d.avisos.length)
      notifications.show({ color: 'yellow', message: d.avisos.join(' '), autoClose: false });
  }

  // Estoque padrão: o vinculado à loja destinatária; tipo padrão: o padrão (Disponível).
  const estoqueDaLoja = (loja: string | null) =>
    estoques.data?.itens.find((e) => e.lojaId === loja)?.id ?? '';
  const tipoPadrao = tipos.data?.find((t) => t.padrao)?.id ?? '';
  const estoquePadrao = estoqueDaLoja(v.lojaId);
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

  /** Troca a loja: o estoque acompanha enquanto for o da loja anterior (ou vazio); escolhido à parte, fica. */
  const trocarLoja = (loja: string | null) => {
    const atuais = form.getValues();
    const anterior = estoqueDaLoja(atuais.lojaId);
    form.setValues({
      lojaId: loja,
      estoqueId: !atuais.estoqueId || atuais.estoqueId === anterior ? estoqueDaLoja(loja) : atuais.estoqueId,
    });
  };

  const alterarLinha = (chave: string, mudar: (l: LinhaRecebimento) => LinhaRecebimento) =>
    form.setFieldValue(
      'itens',
      form.getValues().itens.map((l) => (l.chave === chave ? mudar(l) : l)),
    );

  /**
   * Produto escolhido (pela busca ou pelo leitor): o preço de venda atual como proposta, sem embalagem; o código lido
   * de uma embalagem de compra do produto (o fardo) preenche a embalagem e o fator, e a quantidade 1 (ERP 3.3).
   */
  async function escolherProduto(chave: string, p: ProdutoOpcao | null, termo: string) {
    const proposto = p ? paraTela(p.precoVenda) : '';
    alterarLinha(chave, (l) => ({
      ...l,
      produto: p,
      codigoBarrasId: null,
      fator: '1',
      precoVenda: proposto,
      markup: null,
      atualizarPreco: null,
      quantidade: p && termo && termo === p.ean && !l.quantidade.trim() ? '1' : l.quantidade,
    }));
    if (!p) return;
    try {
      const d = (await queryClient.fetchQuery(consultaDados([p.id]))).produtos[0];
      const emb =
        /^\S{4,}$/.test(termo) && termo !== p.ean ? d?.embalagens.find((e) => e.codigo === termo) : undefined;
      // A loja com preço próprio: a proposta é o preço dela (o que o caixa cobra), enquanto não for mexida.
      const daLoja = d?.precoVendaLoja ? paraTela(d.precoVendaLoja) : null;
      if (emb || daLoja)
        alterarLinha(chave, (l) =>
          l.produto?.id === p.id
            ? {
                ...l,
                ...(emb
                  ? {
                      codigoBarrasId: emb.id,
                      fator: paraTela(emb.fator, 3),
                      quantidade: l.quantidade.trim() ? l.quantidade : '1',
                    }
                  : {}),
                ...(daLoja && l.precoVenda === proposto && l.markup === null ? { precoVenda: daLoja } : {}),
              }
            : l,
        );
    } catch {
      // Sem os dados, a embalagem fica para a coluna "Embalagem" (e a tela avisa da falha da consulta da grade).
    }
  }

  /** O produto novo do cadastro rápido entra na primeira linha sem produto (ou numa linha nova). */
  function usarProdutoNovo(p: ProdutoOpcao) {
    const linhas = form.getValues().itens;
    const livre = linhas.find((l) => !l.produto);
    if (livre) void escolherProduto(livre.chave, p, '');
    else {
      const nova = novaLinhaRecebimento();
      form.setFieldValue('itens', [...linhas, nova]);
      void escolherProduto(nova.chave, p, '');
    }
  }

  // Erros da API por item (`itens.N.campo`, N entre as linhas preenchidas) nas colunas da grade.
  const errosForm = form.errors;
  const validar = (l: LinhaRecebimento) => {
    const e: Partial<Record<keyof LinhaRecebimento | '_linha', string>> = {
      ...errosDaLinha(l, cab, dadosDo(l.produto?.id)),
    };
    const i = v.itens.filter((x) => !linhaVazia(x)).indexOf(l);
    for (const [k, msg] of Object.entries(errosForm)) {
      const m = /^itens\.(\d+)\.(\w+)$/.exec(k);
      if (m && Number(m[1]) === i && typeof msg === 'string') {
        const coluna = COLUNA_DO_CAMPO[m[2]!] ?? 'produto';
        e[coluna] ??= msg;
      }
    }
    return e;
  };

  const gravados = new Map((r?.itens ?? []).map((i) => [i.id, i]));
  const gravado = (l: LinhaRecebimento) => (!rascunho && l.id ? gravados.get(l.id) : undefined);
  const mostrarLote =
    v.temValidade ||
    v.itens.some((l) => l.lote.trim() || l.validade.trim()) ||
    (dados.data?.produtos.some((p) => p.temLotes || p.solicitaLotePdv) ?? false);
  const texto = (conteudo: string) => (
    <Text size="sm" ta="right">
      {conteudo}
    </Text>
  );

  const colunas: ColunaGrade<LinhaRecebimento>[] = [
    {
      campo: 'produto',
      rotulo: 'Produto ou código de barras',
      tipo: 'texto',
      largura: 260,
      editor: ({ linha, campo }) => (
        <SeletorProduto
          value={linha.produto?.id ?? null}
          produto={linha.produto}
          onChange={(_, p, termo) => void escolherProduto(linha.chave, p, termo)}
          tipos={TIPOS_RECEBIMENTO}
          size="xs"
          error={!!campo['aria-invalid']}
          ref={campo.ref as never}
          onKeyDown={campo.onKeyDown as never}
          aria-label={campo['aria-label']}
          disabled={campo.disabled}
        />
      ),
    },
    {
      campo: 'codigoBarrasId',
      rotulo: 'Embalagem',
      tipo: 'texto',
      largura: 150,
      editor: ({ linha, campo }) => {
        const g = gravado(linha);
        if (g || campo.disabled || !linha.produto)
          return (
            <Text size="sm" c={linha.produto ? undefined : 'dimmed'}>
              {g
                ? g.codigoBarrasId
                  ? `${g.unidadeCompra ?? 'Emb.'} × ${qtd(g.fator)}`
                  : (g.unidadeCompra ?? g.produto.unidadeSigla)
                : (linha.produto?.unidadeSigla ?? '—')}
            </Text>
          );
        const embalagens = dadosDo(linha.produto.id)?.embalagens ?? [];
        const data = [
          { value: '', label: `${linha.produto.unidadeSigla} (unidade)` },
          ...(linha.codigoBarrasId && !embalagens.some((e) => e.id === linha.codigoBarrasId)
            ? [{ value: linha.codigoBarrasId, label: `Embalagem × ${linha.fator}` }]
            : []),
          ...embalagens.map((e) => ({
            value: e.id,
            label: `${e.unidadeSigla ?? e.descricao ?? 'Emb.'} × ${qtd(e.fator)} · ${e.codigo}`,
          })),
        ];
        return (
          <NativeSelect
            size="xs"
            data={data}
            value={linha.codigoBarrasId ?? ''}
            onChange={(ev) => {
              const emb = embalagens.find((e) => e.id === ev.currentTarget.value);
              alterarLinha(linha.chave, (l) => ({
                ...l,
                codigoBarrasId: emb?.id ?? null,
                fator: emb ? paraTela(emb.fator, 3) : '1',
              }));
            }}
            error={!!campo['aria-invalid']}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
          />
        );
      },
    },
    {
      campo: 'fator',
      rotulo: 'Fator',
      tipo: 'numero',
      largura: 70,
      // Com a embalagem, o fator é o dela (a API confere); sem ela, digitável (a caixa sem EAN).
      editor: ({ linha, aoMudar, campo }) =>
        linha.codigoBarrasId || campo.disabled ? (
          texto(linha.fator || '1')
        ) : (
          <TextInput
            size="xs"
            value={linha.fator}
            onChange={(ev) => aoMudar(ev.currentTarget.value)}
            inputMode="decimal"
            styles={{ input: { textAlign: 'right' } }}
            error={campo['aria-invalid'] || undefined}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
          />
        ),
    },
    { campo: 'quantidade', rotulo: 'Quant.', tipo: 'numero', largura: 80 },
    {
      campo: 'qtdEstoque',
      rotulo: 'No estoque',
      tipo: 'leitura',
      largura: 90,
      formato: (l) => {
        const g = gravado(l);
        const q = g?.quantidadeEstoque ?? contas.get(l.chave)?.quantidadeEstoque;
        return l.produto && q !== undefined ? `${qtd(q)} ${l.produto.unidadeSigla}` : '—';
      },
    },
    { campo: 'precoCompra', rotulo: 'Preço compra', tipo: 'dinheiro', largura: 110 },
    {
      campo: 'total',
      rotulo: 'Total',
      tipo: 'leitura',
      largura: 100,
      formato: (l) => {
        const t = gravado(l)?.valorTotal ?? contas.get(l.chave)?.valorTotal;
        return l.produto && t !== undefined ? reais(t) : '—';
      },
    },
    {
      campo: 'rateio',
      rotulo: 'Rateio',
      tipo: 'leitura',
      largura: 90,
      formato: (l) => {
        const g = gravado(l);
        const t = g
          ? dec(g.rateioFrete).plus(g.rateioOutras).minus(g.rateioDesconto).toFixed(2)
          : contas.get(l.chave)?.rateio;
        return l.produto && t !== undefined ? reais(t) : '—';
      },
    },
    {
      campo: 'custoFinal',
      rotulo: 'Custo final',
      tipo: 'leitura',
      largura: 100,
      formato: (l) => {
        const t = gravado(l)?.custoUnitarioFinal ?? contas.get(l.chave)?.custoFinal;
        return l.produto && t !== undefined ? `R$ ${formatarDecimal(Number(t), 4)}` : '—';
      },
    },
    {
      campo: 'markup',
      rotulo: 'Markup %',
      tipo: 'numero',
      largura: 90,
      editor: ({ linha, campo }) => {
        const g = gravado(linha);
        if (g) return texto(g.markupPct === null ? '—' : formatarDecimal(Number(g.markupPct), 2));
        const pm = pmDe(linha);
        const derivado = pm.markupPct === null ? '' : paraTela(pm.markupPct, 2);
        if (campo.disabled || !podeAlterarPreco) return texto(derivado || '—');
        return (
          <TextInput
            size="xs"
            value={linha.markup ?? derivado}
            placeholder={linha.produto ? '—' : undefined}
            onChange={(ev) => {
              const valor = ev.currentTarget.value;
              alterarLinha(linha.chave, (l) => ({ ...l, markup: valor, atualizarPreco: semResposta(l) }));
            }}
            inputMode="decimal"
            styles={{ input: { textAlign: 'right' } }}
            error={campo['aria-invalid'] || undefined}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
          />
        );
      },
    },
    {
      campo: 'precoVenda',
      rotulo: 'Preço venda',
      tipo: 'dinheiro',
      largura: 110,
      editor: ({ linha, campo }) => {
        const g = gravado(linha);
        if (g) return texto(g.precoVenda === null ? '—' : reais(g.precoVenda));
        const pm = pmDe(linha);
        const valor = linha.markup?.trim() ? paraTela(pm.precoVenda, 2) : linha.precoVenda;
        if (campo.disabled || !podeAlterarPreco) return texto(valor ? `R$ ${valor}` : '—');
        return (
          <TextInput
            size="xs"
            value={valor}
            onChange={(ev) => {
              const novo = ev.currentTarget.value;
              // O preço digitado passa a valer: o markup volta a ser calculado.
              alterarLinha(linha.chave, (l) => ({
                ...l,
                precoVenda: novo,
                markup: null,
                atualizarPreco: semResposta(l),
              }));
            }}
            inputMode="decimal"
            leftSection={<Text size="xs">R$</Text>}
            styles={{ input: { textAlign: 'right' } }}
            error={campo['aria-invalid'] || undefined}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
          />
        );
      },
    },
    {
      campo: 'atualizarPreco',
      rotulo: 'Atualizar preço',
      tipo: 'selecao',
      largura: 150,
      editor: ({ linha, campo }) => {
        const g = gravado(linha);
        if (g) return <Text size="sm">{ROTULOS_ATUALIZAR_PRECO[g.atualizarPreco]}</Text>;
        if (campo.disabled || !linha.produto || !podeAlterarPreco) {
          // Sem a permissão, vai "Não" (`itemParaApi`): a mudança gravada por quem podia não é aplicada.
          const a = linha.atualizarPreco && !podeAlterarPreco ? 'nao' : linha.atualizarPreco;
          return (
            <Text size="sm" c="dimmed">
              {a ? ROTULOS_ATUALIZAR_PRECO[a] : '—'}
            </Text>
          );
        }
        const alterado = precoAlterado(linha, pmDe(linha).precoVenda, dadosDo(linha.produto.id));
        return (
          <NativeSelect
            size="xs"
            data={[
              { value: '', label: alterado ? 'Perguntar ao salvar' : '—' },
              ...ATUALIZAR_PRECO_RECEBIMENTO.map((a) => ({ value: a, label: ROTULOS_ATUALIZAR_PRECO[a] })),
            ]}
            value={linha.atualizarPreco ?? ''}
            onChange={(ev) => {
              const a = (ev.currentTarget.value || null) as AtualizarPrecoRecebimento | null;
              alterarLinha(linha.chave, (l) => ({ ...l, atualizarPreco: a }));
            }}
            error={!!campo['aria-invalid']}
            ref={campo.ref as never}
            onKeyDown={campo.onKeyDown as never}
            aria-label={campo['aria-label']}
          />
        );
      },
    },
    ...(mostrarLote
      ? ([
          { campo: 'lote', rotulo: 'Lote', tipo: 'texto', largura: 110 },
          { campo: 'validade', rotulo: 'Validade', tipo: 'texto', largura: 110 },
          { campo: 'fabricacao', rotulo: 'Fabricação', tipo: 'texto', largura: 110 },
        ] satisfies ColunaGrade<LinhaRecebimento>[])
      : []),
  ];

  const preenchidas = v.itens.filter((l) => !linhaVazia(l) && l.produto);
  const totais =
    r && !rascunho
      ? { qtdItens: r.qtdItens, valorProdutos: r.valorProdutos, valorTotal: r.valorTotal }
      : totaisRecebimentoTexto(
          preenchidas.map((l) => ({
            quantidade: textoDecimal(l.quantidade) ?? '0',
            fator: textoDecimal(l.fator) ?? '0',
            precoCompra: textoDecimal(l.precoCompra) ?? '0',
          })),
          {
            valorFrete: textoDecimal(v.valorFrete) ?? '0',
            valorDesconto: textoDecimal(v.valorDesconto) ?? '0',
            valorOutrasDespesas: textoDecimal(v.valorOutrasDespesas) ?? '0',
          },
        );

  const aoErroAcao = (e: unknown) => {
    if (e instanceof ErroRequisicao) {
      setErroAcao(e.message);
      if (e.campos) {
        form.setErrors(errosDaApi(e.campos));
        setMostrarErros(true);
      }
    } else setErroAcao((e as Error).message);
  };

  /** Depois de uma ação: o detalhe novo no cache e no formulário, a listagem e os saldos invalidados. */
  const depoisDaAcao = (d: RecebimentoDetalhe, mensagem: string) => {
    setErroAcao(null);
    queryClient.setQueryData(['recebimentos', d.id], d);
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'recebimentos'] });
    void queryClient.invalidateQueries({ queryKey: ['listagem', 'estoque_saldos'] });
    void queryClient.invalidateQueries({ queryKey: ['recebimento-dados'] });
    notifications.show({ color: 'green', message: mensagem });
    if (c.novo) {
      form.resetDirty();
      navigate(`${ROTA_RECEBIMENTOS}/${d.id}`, { replace: true });
    }
  };

  /**
   * "Atualizar preço" dos itens com o preço de venda alterado e sem resposta (ERP 13.3): pergunta uma vez para todos
   * (geral, só da loja ou não) e segue; cada linha ainda pode ser trocada na coluna.
   */
  function comPrecosRespondidos(depois: () => void) {
    // Quem não grava (só movimenta) não responde: o documento movimenta com o que está gravado (o PUT seria 403).
    if (somenteLeitura) return depois();
    // Sem poder mudar o preço de venda, não há o que perguntar: os itens vão com "Não" (`itemParaApi`).
    if (!podeAlterarPreco) return depois();
    const pendentes = form
      .getValues()
      .itens.filter(
        (l) =>
          !linhaVazia(l) && !l.atualizarPreco && precoAlterado(l, pmDe(l).precoVenda, dadosDo(l.produto?.id)),
      );
    if (!pendentes.length) return depois();
    setPerguntaPreco({
      chaves: pendentes.map((l) => l.chave),
      comPrecoDaLoja: pendentes.filter((l) => !!dadosDo(l.produto?.id)?.precoVendaLoja).length,
      depois,
    });
  }

  /**
   * Sem os dados de compra novos, não grava: a base do markup, o lote obrigatório e o preço da loja sairiam do padrão
   * sem aviso. `true` = pode seguir.
   */
  function dadosProntos(): boolean {
    if (falhaDados) {
      setErroAcao(
        'Os dados de compra dos produtos não carregaram (embalagens, lote, saldo, preço da loja e a base do markup): use "Tentar de novo" antes de salvar.',
      );
      return false;
    }
    return !aguardandoDados;
  }

  const responderPreco = (a: AtualizarPrecoRecebimento) => {
    const p = perguntaPreco!;
    setPerguntaPreco(null);
    form.setFieldValue(
      'itens',
      form.getValues().itens.map((l) => (p.chaves.includes(l.chave) ? { ...l, atualizarPreco: a } : l)),
    );
    // O estado do formulário já tem a resposta quando o `depois` monta o corpo.
    setTimeout(p.depois, 0);
  };

  // As linhas vazias não vão no corpo (`paraCorpo`) e os erros da API são casados pela posição entre as preenchidas.
  const salvar = () => {
    setMostrarErros(true);
    if (!dadosProntos()) return;
    comPrecosRespondidos(() => c.salvar());
  };

  /** Grava o rascunho (se for novo ou tiver alteração) e devolve o detalhe gravado; `null` se não gravou. */
  async function gravarAntes(): Promise<RecebimentoDetalhe | null> {
    // Quem só movimenta nunca regrava (o PUT exige `recebimentos.editar`). Sem poder mudar o preço, o rascunho com
    // "geral"/"só da loja" gravado por quem podia é regravado com "Não" (`itemParaApi`): movimentar o gravado seria 403.
    if (!c.novo && r && (!(form.isDirty() || precoDescartado(form.getValues().itens)) || !podeGravar))
      return r;
    const corpo = { ...paraCorpo(form.getValues()), ...(c.novo ? {} : { versao: r?.versao }) };
    const schema = c.novo ? criarRecebimentoSchema : alterarRecebimentoSchema;
    const z = schema.safeParse(corpo);
    if (!z.success) {
      form.setErrors(errosDoZod(z.error));
      setMostrarErros(true);
      return null;
    }
    try {
      const d = c.novo
        ? await apiErp.post<RecebimentoDetalhe>('/recebimentos', corpo)
        : await apiErp.put<RecebimentoDetalhe>(`/recebimentos/${id}`, corpo);
      queryClient.setQueryData(['recebimentos', d.id], d);
      avisarRemessa(d);
      return d;
    } catch (e) {
      c.setErro(e);
      if (e instanceof ErroRequisicao && e.campos) {
        const campos = errosDaApi(e.campos);
        form.setErrors({ ...campos, ...(campos.fornecedorId ? { fornecedor: campos.fornecedorId } : {}) });
        setMostrarErros(true);
      }
      return null;
    }
  }

  /** Movimenta; a pergunta do preço de custo (D49) volta como 422 e abre o modal com os produtos. */
  async function movimentar(d: RecebimentoDetalhe, atualizarPrecoCusto: boolean | null) {
    setProcessando(true);
    try {
      const m = await apiErp.post<RecebimentoDetalhe>(`/recebimentos/${d.id}/movimentar`, {
        versao: d.versao,
        atualizarPrecoCusto,
      });
      depoisDaAcao(m, 'Recebimento movimentado: estoque atualizado');
    } catch (e) {
      const produtos = precosCustoDoErro(e);
      if (produtos) setPerguntaCusto({ detalhe: d, produtos });
      else aoErroAcao(e);
    } finally {
      setProcessando(false);
    }
  }

  const salvarEMovimentar = () => {
    setMostrarErros(true);
    if (!dadosProntos()) return;
    comPrecosRespondidos(() =>
      modals.openConfirmModal({
        title: 'Salvar e movimentar',
        children: (
          <Text size="sm">
            O estoque recebe os itens agora, com o custo final de cada um. Depois de movimentado, o
            recebimento não muda mais (só se estorna).
          </Text>
        ),
        labels: { confirm: 'Movimentar', cancel: 'Cancelar' },
        confirmProps: { color: 'green' },
        onConfirm: () => {
          void (async () => {
            setErroAcao(null);
            setProcessando(true);
            const novo = c.novo;
            const d = await gravarAntes();
            setProcessando(false);
            if (!d) return;
            // O rascunho novo já foi gravado: a tela passa a ser a dele antes de movimentar, para o movimentar
            // recusado (sem permissão de preço, lote, conflito, rede) não deixar a tela em "novo" e a próxima
            // tentativa gravar um segundo rascunho com os mesmos itens.
            if (novo) {
              form.resetDirty();
              navigate(`${ROTA_RECEBIMENTOS}/${d.id}`, { replace: true });
            }
            await movimentar(d, null);
          })();
        },
      }),
    );
  };

  /**
   * Estorna. Quem pode deixar o saldo negativo (Master ou "Permite saldo negativo no ERP") recebe 422 em
   * `confirmarNegativo` com a lista dos saldos (D56 com aviso): o modal mostra a lista e pede a confirmação, que
   * devolve a lista mostrada (a API só aceita se ela cobrir os saldos de agora; senão pergunta de novo com a lista
   * nova); sem a permissão a API recusa como sempre e a mensagem aparece no erro da ação.
   */
  async function estornar(confirmarNegativo: SaldoNegativoEstorno[] = []) {
    setProcessando(true);
    try {
      const d = await apiErp.post<RecebimentoDetalhe>(`/recebimentos/${id}/estornar`, {
        versao: r!.versao,
        motivo: motivoEstorno,
        confirmarNegativo,
      });
      fecharEstorno();
      setMotivoEstorno('');
      depoisDaAcao(d, 'Recebimento estornado');
    } catch (e) {
      if (!negativo.tratar(e, confirmarNegativo)) aoErroAcao(e);
    } finally {
      setProcessando(false);
    }
  }

  function fecharEstorno() {
    setEstornando(false);
    negativo.limpar();
  }

  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_RECEBIMENTOS} />;
  const sujo = form.isDirty();
  const podeMovimentar = rascunho && pode('recebimentos.movimentar') && (podeGravar || (!c.novo && !sujo));
  const opcoesTipo = (tipos.data ?? [])
    .filter((t) => t.ativo || t.id === v.tipoEstoqueId)
    .map((t) => ({ value: t.id, label: t.nome }));
  const opcoesEstoque = (estoques.data?.itens ?? []).map((e) => ({ value: e.id, label: e.nome }));
  if (r && !opcoesEstoque.some((o) => o.value === r.estoqueId))
    opcoesEstoque.push({ value: r.estoqueId, label: r.estoqueNome });

  const acoes = (
    <>
      {podeMovimentar && (
        <Button
          color="green"
          leftSection={<IconCircleCheck size={16} />}
          loading={processando || aguardandoDados}
          disabled={!c.novo && !sujo && !r?.itens.length}
          onClick={salvarEMovimentar}
        >
          Salvar e movimentar
        </Button>
      )}
      {!c.novo && (
        <Tooltip label="Salve as alterações antes de imprimir" disabled={!sujo}>
          <Button
            variant="default"
            leftSection={<IconPrinter size={16} />}
            disabled={sujo}
            onClick={() => window.open(urlEspelhoRecebimento(id!), '_blank')}
          >
            Imprimir
          </Button>
        </Tooltip>
      )}
      {status === 'movimentado' && pode('recebimentos.estornar') && (
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
        titulo={c.novo ? 'Novo recebimento manual' : `Recebimento Nº ${r?.codigo ?? ''}`}
        codigo={r?.codigo}
        situacao={r ? { rotulo: ROTULOS_STATUS_RECEBIMENTO[r.status], cor: CORES_STATUS[r.status] } : null}
        alteradoEm={r?.atualizadoEm}
        alteradoPor={r?.atualizadoPorNome}
        carregando={!c.novo && c.registro.isPending}
        salvando={c.salvando || processando || aguardandoDados}
        somenteLeitura={somenteLeitura}
        avisoSomenteLeitura={
          !rascunho
            ? `Recebimento ${status === 'movimentado' ? 'movimentado' : 'estornado'}: o documento não muda mais${status === 'movimentado' ? ' (use Estornar)' : ''}.`
            : undefined
        }
        sujo={sujo}
        rotaVoltar={ROTA_RECEBIMENTOS}
        rotaNovo={pode('recebimentos.criar') ? `${ROTA_RECEBIMENTOS}/novo` : undefined}
        aoSalvar={salvar}
        aoExcluir={!c.novo && rascunho && pode('recebimentos.editar') ? c.excluir : undefined}
        erro={c.erro}
        aoRecarregar={c.recarregar}
        historico={r ? { entidade: 'recebimentos', registroId: r.id } : undefined}
        acoesExtras={acoes}
        abas={[
          {
            valor: 'dados',
            rotulo: 'Recebimento',
            conteudo: (
              <Stack>
                {erroAcao && (
                  <Alert color="red" role="alert" withCloseButton onClose={() => setErroAcao(null)}>
                    {erroAcao}
                  </Alert>
                )}
                {falhaDados && (
                  <Alert color="red" icon={<IconInfoCircle size={18} />} data-testid="falha-dados-compra">
                    <Group justify="space-between" wrap="nowrap">
                      <Text size="sm">
                        Não foi possível ler os dados de compra dos produtos (embalagens, lote, saldo, preço
                        da loja e a base do markup): {(dados.error as Error).message} Sem eles, o recebimento
                        não é gravado.
                      </Text>
                      <Button size="xs" variant="light" onClick={() => void dados.refetch()}>
                        Tentar de novo
                      </Button>
                    </Group>
                  </Alert>
                )}
                {precoDescartado(v.itens) && (
                  <Alert color="yellow" icon={<IconInfoCircle size={18} />} data-testid="preco-descartado">
                    Este rascunho foi gravado com mudança no preço de venda. Alterar o preço no ERP exige
                    "Produtos: Alterar preço": ao salvar ou movimentar, os itens vão com "Atualizar preço" =
                    "Não" e o preço de venda atual fica.
                  </Alert>
                )}
                {r && r.remessaRepetida.length > 0 && (
                  <Alert color="yellow" icon={<IconInfoCircle size={18} />} data-testid="remessa-repetida">
                    {r.avisos[0]}{' '}
                    {r.remessaRepetida.map((x, i) => (
                      <span key={x.id}>
                        {i > 0 && ', '}
                        <Anchor component={Link} to={`${ROTA_RECEBIMENTOS}/${x.id}`} size="sm">
                          Nº {x.codigo} ({formatarData(x.dataRecebimento)},{' '}
                          {ROTULOS_STATUS_RECEBIMENTO[x.status].toLowerCase()})
                        </Anchor>
                      </span>
                    ))}
                  </Alert>
                )}
                {r && !rascunho && (
                  <Text size="sm" c="dimmed">
                    {r.movimentadoEm &&
                      `Movimentado em ${formatarDataHora(r.movimentadoEm)} por ${r.movimentadoPorNome ?? '—'}. `}
                    {r.estornadoEm &&
                      `Estornado em ${formatarDataHora(r.estornadoEm)} por ${r.estornadoPorNome ?? '—'}: ${r.motivoEstorno ?? ''}`}
                  </Text>
                )}
                <Grid>
                  <Grid.Col span={{ base: 12, md: 4 }}>
                    <SeletorPessoa
                      label="Fornecedor"
                      required
                      categoria="fornecedor"
                      value={v.fornecedor?.id ?? null}
                      pessoa={v.fornecedor}
                      onChange={(_, p) => form.setFieldValue('fornecedor', p)}
                      error={form.errors.fornecedor}
                      disabled={somenteLeitura}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 3 }}>
                    <SeletorLoja
                      label="Loja"
                      required
                      value={v.lojaId}
                      onChange={trocarLoja}
                      error={form.errors.lojaId}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 3 }}>
                    <Select
                      label="Estoque de destino"
                      required
                      allowDeselect={false}
                      data={opcoesEstoque}
                      {...form.getInputProps('estoqueId')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 12, md: 2 }}>
                    <Select
                      label="Tipo de estoque"
                      required
                      allowDeselect={false}
                      data={opcoesTipo}
                      {...form.getInputProps('tipoEstoqueId')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 6, md: 2 }}>
                    <CampoData
                      label="Data"
                      required
                      clearable={false}
                      description="Do documento"
                      {...form.getInputProps('dataRecebimento')}
                    />
                  </Grid.Col>
                  <Grid.Col span={{ base: 6, md: 2 }}>
                    <TextInput
                      label="Cód. remessa"
                      description="Nº do documento"
                      maxLength={30}
                      {...form.getInputProps('codigoRemessa')}
                    />
                  </Grid.Col>
                  {(['valorFrete', 'valorOutrasDespesas', 'valorDesconto'] as const).map((campo) => (
                    <Grid.Col key={campo} span={{ base: 4, md: 2 }}>
                      <TextInput
                        label={
                          campo === 'valorFrete'
                            ? 'Frete'
                            : campo === 'valorDesconto'
                              ? 'Desconto'
                              : 'Outras despesas'
                        }
                        description="Rateado pelo valor"
                        inputMode="decimal"
                        leftSection={<Text size="xs">R$</Text>}
                        {...form.getInputProps(campo)}
                      />
                    </Grid.Col>
                  ))}
                  <Grid.Col span={{ base: 12, md: 2 }} style={{ alignSelf: 'center' }}>
                    <Checkbox
                      label="Tem prazo de validade"
                      description="Lote e validade em todos os itens"
                      {...form.getInputProps('temValidade', { type: 'checkbox' })}
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
                {/* "Gerar financeiro?" (ERP 13.3) fica escondido até a Fase 4 (contas a pagar). */}
                {!somenteLeitura && pode('produtos.criar') && (
                  <Group justify="flex-end">
                    <Button
                      variant="light"
                      size="xs"
                      leftSection={<IconPackageImport size={14} />}
                      onClick={() => setCadastrando(true)}
                    >
                      Cadastrar novo produto
                    </Button>
                  </Group>
                )}
                <GradeItens
                  rotulo="Itens do recebimento"
                  linhas={v.itens}
                  aoMudar={(linhas) => form.setFieldValue('itens', linhas)}
                  colunas={colunas}
                  novaLinha={novaLinhaRecebimento}
                  chave={(l) => l.chave}
                  validar={validar}
                  vazia={linhaVazia}
                  mostrarErros={mostrarErros}
                  somenteLeitura={somenteLeitura}
                />
                {rascunho && (
                  <Text size="xs" c="dimmed">
                    Rateio e custo final como a movimentação vai gravar (frete e outras despesas menos o
                    desconto, pelo valor de cada item). O markup é sobre{' '}
                    {
                      {
                        preco_custo: 'o preço de custo que o produto terá depois da compra',
                        custo_medio: 'o custo médio do estoque depois da entrada',
                        ultimo_custo: 'o custo desta compra',
                      }[dados.data?.custoBaseMargem ?? 'preco_custo']
                    }
                    ; alterar o markup recalcula o preço, e alterar o preço recalcula o markup.
                    {preenchidas.some((l) => exigeLote(cab, dadosDo(l.produto?.id))) &&
                      ' Lote e validade (dd/mm/aaaa) são obrigatórios nos itens destacados.'}
                  </Text>
                )}
                <Group justify="flex-end" gap="xl" data-testid="totais-recebimento">
                  <Text size="sm">
                    Qtd. itens: <b>{totais.qtdItens}</b>
                  </Text>
                  <Text size="sm">
                    Produtos: <b>{reais(totais.valorProdutos)}</b>
                  </Text>
                  <Text size="sm">
                    Total geral: <b>{reais(totais.valorTotal)}</b>
                  </Text>
                </Group>
              </Stack>
            ),
          },
        ]}
      />
      {cadastrando && (
        <CadastroRapidoProduto aberto aoFechar={() => setCadastrando(false)} aoSalvar={usarProdutoNovo} />
      )}
      <Modal
        opened={!!perguntaPreco}
        onClose={() => setPerguntaPreco(null)}
        title="Atualizar o preço de venda?"
      >
        <Stack>
          <Text size="sm">
            {perguntaPreco?.chaves.length === 1
              ? 'Um item tem o preço de venda diferente do atual nesta loja.'
              : `${perguntaPreco?.chaves.length ?? 0} itens têm o preço de venda diferente do atual nesta loja.`}{' '}
            O preço muda ao movimentar o recebimento.
          </Text>
          {!!perguntaPreco?.comPrecoDaLoja && (
            <Text size="sm" c="dimmed" data-testid="aviso-preco-da-loja">
              {perguntaPreco.comPrecoDaLoja === 1
                ? 'Um deles tem'
                : `${perguntaPreco.comPrecoDaLoja} deles têm`}{' '}
              preço próprio nesta loja: o preço geral não vale nela (vale nas lojas que seguem o geral). Para
              mudar o preço desta loja, use “{ROTULOS_ATUALIZAR_PRECO.loja}”.
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => responderPreco('nao')}>
              {ROTULOS_ATUALIZAR_PRECO.nao}
            </Button>
            <Button variant="light" onClick={() => responderPreco('loja')}>
              {ROTULOS_ATUALIZAR_PRECO.loja}
            </Button>
            <Button onClick={() => responderPreco('geral')}>{ROTULOS_ATUALIZAR_PRECO.geral}</Button>
          </Group>
        </Stack>
      </Modal>
      <PerguntaPrecoCusto
        produtos={perguntaCusto?.produtos ?? null}
        documento="compra"
        processando={processando}
        aoFechar={() => setPerguntaCusto(null)}
        aoResponder={(atualizar) => {
          const d = perguntaCusto!.detalhe;
          setPerguntaCusto(null);
          void movimentar(d, atualizar);
        }}
      />
      <Modal opened={estornando} onClose={fecharEstorno} title="Estornar recebimento">
        {negativo.negativos ? (
          <ConfirmacaoNegativoEstorno
            negativos={negativo.negativos}
            mudou={negativo.mudou}
            processando={processando}
            aoConfirmar={() => void estornar(negativo.negativos!)}
            aoCancelar={fecharEstorno}
          />
        ) : (
          <Stack>
            <Text size="sm">
              O estorno tira do estoque o que o recebimento lançou (o mesmo lote). Se a mercadoria já tiver
              sido vendida e o saldo ficar negativo, é recusado (salvo Master ou "Permite saldo negativo no
              ERP", que confirmam vendo a lista). O preço de venda e o preço de custo não voltam.
            </Text>
            <List size="sm">
              <List.Item>
                Recebimento Nº {r?.codigo}, {r?.qtdItens} item(ns), {reais(r?.valorTotal ?? 0)}
              </List.Item>
            </List>
            <TextInput
              label="Motivo do estorno"
              required
              data-autofocus
              maxLength={255}
              value={motivoEstorno}
              onChange={(e) => setMotivoEstorno(e.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={fecharEstorno}>
                Cancelar
              </Button>
              <Button
                color="red"
                disabled={!motivoEstorno.trim()}
                loading={processando}
                onClick={() => void estornar()}
              >
                Estornar
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
