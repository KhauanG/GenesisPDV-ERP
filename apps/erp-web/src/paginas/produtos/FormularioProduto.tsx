import {
  alterarProdutoSchema,
  criarProdutoSchema,
  dec,
  gerarCodigoInterno,
  margemPct,
  markupPct,
  motivoTipoProdutoBloqueado,
  precoPeloMarkupTexto,
  resumoCombo,
  ROTULOS_MODO_PRECO_GRUPO,
  ROTULOS_TIPO_PRODUTO,
  TIPOS_INSUMO_FICHA,
  TIPOS_PRODUTO,
  TIPOS_PROIBIDOS_NO_COMBO,
  TIPOS_SEM_SALDO_PROPRIO,
  TIPOS_TROCA_COM_MOVIMENTO,
  UNIDADES_FRACIONADAS,
  validarGtin,
  type AvisoComboComponente,
  type ProdutoDetalhe,
  type SaldosProduto,
  type TipoProduto,
} from '@genesis/shared';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm, type UseFormReturnType } from '@mantine/form';
import { modals } from '@mantine/modals';
import {
  IconAdjustments,
  IconAlertTriangle,
  IconBarcode,
  IconCalculator,
  IconCopy,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { ErroRequisicao } from '../../api/http';
import {
  useCategorias,
  useCfops,
  useGruposPreco,
  useMarcas,
  useTiposProdutoHabilitados,
  useUnidades,
  useUsaFornecedores,
} from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { BuscaNcm } from '../../componentes/campos/BuscaNcm';
import { CampoDataHora } from '../../componentes/campos/CamposData';
import { useCadastro } from '../../componentes/cadastro';
import { FormularioEntidade } from '../../componentes/FormularioEntidade';
import { SeletorProduto } from '../../componentes/seletores/SeletorProduto';
import { formatarDataHora } from '../../util/formato';
import { NaoEncontrado } from '../Erros';
import { linkVerMovimentacao } from '../relatorios/MovimentacaoEstoque';
import {
  BlocoCategorias,
  BlocoFornecedores,
  BlocoRelacionados,
  BlocoValidade,
  ModalAjustarEstoque,
} from './BlocosProduto';
import { ROTA_PRODUTOS } from './ListaProdutos';
import {
  decimalParaTela,
  errosParaFormulario,
  novaChave,
  numero,
  paraCorpo,
  paraValores,
  produtoVazio,
  type PosicaoForm,
  type ValoresProduto,
} from './valores';

type Form = UseFormReturnType<ValoresProduto>;

const reais = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `R$ ${decimalParaTela(String(n))}`;
const pct = (n: number | null) => (n === null ? '—' : `${decimalParaTela(String(n))}%`);

const TIPOS_COMPONENTE_COMBO = TIPOS_PRODUTO.filter((t) => !TIPOS_PROIBIDOS_NO_COMBO.includes(t));

/** Campos de cada bloco do acordeão: o bloco com erro ganha o marcador e abre sozinho (ERP 3.2). */
const CAMPOS_BLOCO: Record<string, readonly string[]> = {
  cabecalho: [
    'nome',
    'tipo',
    'codigoInterno',
    'ean',
    'unidadeId',
    'ncm',
    'cest',
    'precoCusto',
    'markupPct',
    'precoVenda',
  ],
  precos: [
    'precoAtacado',
    'qtdMinimaAtacado',
    'precoPromocional',
    'promocaoInicio',
    'promocaoFim',
    'precoParcelado',
    'precoMenuDigital',
    'precoIfood',
  ],
  codigos: ['codigosAdicionais'],
  composicao: ['posicoes', 'insumos', 'usaFichaTecnica'],
  outras: [
    'localizacao',
    'qtdMinimaVenda',
    'material',
    'comissaoPct',
    'marcaId',
    'idadeMinima',
    'vasilhameProdutoId',
    'vasilhameQuantidade',
    'controlaEstoque',
    'descricaoCurta',
    'larguraCm',
    'alturaCm',
    'profundidadeCm',
    'pesoG',
    'pesoAbatimentoG',
    'pesoPacoteKg',
  ],
  categorias: ['categorias', 'categoriaPrincipalId'],
  relacionados: ['relacionados'],
  fornecedores: ['fornecedores'],
  validade: ['lotes', 'solicitaLotePdv'],
  quantidade: ['precosQuantidade', 'grupoPrecoQuantidadeId'],
  lojas: ['lojas'],
  balanca: ['balancaTipo', 'balancaPlu', 'balancaValidadeDias'],
  tributacao: [
    'cfopVendaEstado',
    'cfopVendaForaEstado',
    'icmsSituacao',
    'icmsOrigem',
    'icmsModalidadeBc',
    'icmsModalidadeBcst',
    'icmsAliquota',
    'icmsReducaoBcPct',
    'icmsMvaPct',
    'icmsAliquotaSt',
    'fcpAliquota',
    'fcpStAliquota',
    'beneficioFiscalCodigo',
    'pisSituacao',
    'cofinsSituacao',
    'ipiSituacao',
    'pisAliquota',
    'cofinsAliquota',
    'ipiAliquota',
    'ipiEnquadramento',
    'ibsCbsClassificacao',
  ],
};

/** Resumo do bloco Validade fechado: quantos lotes e o próximo vencimento entre os ativos. */
function resumoValidade(v: ValoresProduto): string | null {
  const proximo = v.lotes
    .filter((l) => l.ativo && l.validade)
    .map((l) => l.validade)
    .sort()[0];
  return (
    [
      v.lotes.length && `${v.lotes.length} lote(s)`,
      proximo && `próximo vencimento ${proximo.split('-').reverse().join('/')}`,
      v.solicitaLotePdv && 'pede lote no PDV',
    ]
      .filter(Boolean)
      .join(' · ') || null
  );
}

const temErro = (erros: Record<string, unknown>, campos: readonly string[]) =>
  Object.keys(erros).some((k) => campos.some((c) => k === c || k.startsWith(`${c}.`)));

/** Resumo do combo com os produtos já escolhidos nas posições (custo só com `produtos.ver_custo`). */
export function resumoDasPosicoes(posicoes: readonly PosicaoForm[], precoCombo: number) {
  return resumoCombo(
    posicoes
      .filter((p) => p.componente)
      .map((p) => ({
        quantidade: numero(p.quantidade),
        padrao: { custo: p.componente!.precoCusto ?? '0', preco: p.componente!.precoVenda },
        alternativas: p.permiteSubstituicao
          ? p.alternativas
              .filter((a) => a.produto)
              .map((a) => ({
                custo: a.produto!.precoCusto ?? '0',
                preco: a.produto!.precoVenda,
                acrescimo: numero(a.acrescimo),
                ativo: a.ativo,
              }))
          : [],
      })),
    precoCombo,
  );
}

/** Cadastro de produtos – formulário em acordeão (ERP 8.2), inclusive `/produtos/:id/duplicar`. */
export function FormularioProduto() {
  const { id: idUrl, aba } = useParams();
  const duplicando = aba === 'duplicar' && !!idUrl;
  const id = duplicando ? undefined : idUrl;
  const pode = usePode();
  const navigate = useNavigate();
  const eu = useEu();
  const lojas = useMemo(() => eu.lojas.filter((l) => l.ativa), [eu.lojas]);
  const unidades = useUnidades();
  const verCusto = pode('produtos.ver_custo');
  const usaFornecedores = useUsaFornecedores();
  const unidadePadrao = unidades.data?.find((u) => u.sigla === 'UN')?.id ?? null;
  const form = useForm<ValoresProduto>({ mode: 'controlled', initialValues: produtoVazio(lojas, null) });
  const confirmarEan = useRef(false);
  const categorias = useCategorias();
  const marcas = useMarcas();
  const precoVolume = useQuery({
    queryKey: ['produtos', 'preco-volume'],
    queryFn: () =>
      apiErp.get<{ lojasDesligadas: Array<{ id: string; nome: string }> }>('/produtos/preco-volume'),
    staleTime: 60_000,
  });

  const c = useCadastro<ProdutoDetalhe, ValoresProduto>({
    api: '/produtos',
    rota: ROTA_PRODUTOS,
    recurso: 'produtos',
    id,
    form,
    paraValores: (d) => paraValores(d, lojas),
    paraCorpo: (v) => ({
      ...paraCorpo(v, { comFornecedores: usaFornecedores }),
      confirmarEanDuplicado: confirmarEan.current,
    }),
    schemaCriar: criarProdutoSchema,
    schemaAlterar: alterarProdutoSchema,
    mapearErros: (campos) => errosParaFormulario(form.getValues(), campos),
  });

  // Produto novo: unidade UN; duplicar: copia o original sem EAN, sem código interno e sem estoque (ERP 8.2).
  const origem = useQuery({
    queryKey: ['produtos', idUrl, 'origem'],
    queryFn: () => apiErp.get<ProdutoDetalhe>(`/produtos/${idUrl}`),
    enabled: duplicando,
  });
  useEffect(() => {
    if (duplicando && origem.data) {
      form.setValues(paraValores(origem.data, lojas, true));
    } else if (!id && unidadePadrao && !form.getValues().unidadeId) {
      form.setFieldValue('unidadeId', unidadePadrao);
      form.resetDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicando, origem.data, unidadePadrao, id]);

  // EAN duplicado com `geral.ean_duplicado = 'avisar'`: confirma e grava (ERP 8.2, "Regras").
  useEffect(() => {
    const e = c.erro;
    if (!(e instanceof ErroRequisicao) || e.codigo !== 'CONFLITO') return;
    // O 409 do código no fornecedor (F2-B13) já caiu no campo da linha, com "Mover o vínculo".
    const ean = (e.corpo.detalhes as { eanDuplicado?: { confirmar: boolean } } | undefined)?.eanDuplicado;
    if (!ean?.confirmar) return;
    modals.openConfirmModal({
      title: 'EAN duplicado',
      children: <Text size="sm">{e.message}</Text>,
      labels: { confirm: 'Gravar mesmo assim', cancel: 'Cancelar' },
      onConfirm: () => {
        confirmarEan.current = true;
        c.salvar();
        confirmarEan.current = false;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.erro]);

  if (c.naoEncontrado) return <NaoEncontrado inicio={ROTA_PRODUTOS} />;
  const p = c.registro.data;
  const v = form.getValues();
  const avisosCombo = p?.avisosCombo ?? [];
  const kit = v.tipo === 'kit';
  const custo = numero(v.precoCusto);
  const venda = numero(v.precoVenda);
  const combo = kit ? resumoDasPosicoes(v.posicoes, venda) : null;
  const custoExibido = combo ? combo.custo : custo;
  const margem = margemPct(custoExibido, venda);

  const salvar = () => {
    if (combo && margem !== null && margem < 0) {
      modals.openConfirmModal({
        title: 'Margem negativa',
        children: (
          <Text size="sm">
            O preço do combo ({reais(venda)}) está abaixo do custo dos componentes ({reais(combo.custo)}).
            Gravar assim?
          </Text>
        ),
        labels: { confirm: 'Gravar', cancel: 'Revisar' },
        confirmProps: { color: 'red' },
        onConfirm: c.salvar,
      });
      return;
    }
    c.salvar();
  };

  const erros = form.errors;
  const bloco = (
    valor: string,
    rotulo: string,
    conteudo: ReactNode,
    resumo?: string | null,
    aberto?: boolean,
    fixo?: boolean,
  ) => ({
    valor,
    rotulo,
    conteudo,
    resumo,
    aberto,
    fixo,
    comErro: temErro(erros, CAMPOS_BLOCO[valor] ?? []),
  });
  // Resumos dos blocos fechados (ERP 8.2: "Categorias: CERVEJA › LATA").
  const categoriaPrincipal = categorias.data?.find(
    (cat) => cat.id === (v.categoriaPrincipalId || v.categorias[0]),
  );
  const marca = marcas.data?.itens.find((m) => m.id === v.marcaId);
  const resumoOutras =
    [
      marca && `Marca ${marca.descricao}`,
      v.idadeMinima && `+${v.idadeMinima}`,
      v.vasilhameProdutoId && 'casco',
      v.localizacao && `Local ${v.localizacao}`,
    ]
      .filter(Boolean)
      .join(' · ') || null;
  const resumoTributacao =
    [
      v.ncm && `NCM ${v.ncm}`,
      v.cfopVendaEstado && `CFOP ${v.cfopVendaEstado}`,
      v.icmsSituacao && `CST/CSOSN ${v.icmsSituacao}`,
    ]
      .filter(Boolean)
      .join(' · ') || null;
  const resumoComboFechado = combo
    ? [
        `${v.posicoes.length} posição(ões)`,
        verCusto && `custo ${reais(combo.custo)}`,
        verCusto && combo.margemPct !== null && `margem ${pct(combo.margemPct)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const abas = [
    bloco(
      'cabecalho',
      'Cabeçalho',
      <Cabecalho form={form} verCusto={verCusto} p={p} margem={margem} custoCombo={combo?.custo ?? null} />,
    ),
    bloco(
      'precos',
      'Preços complementares',
      <PrecosComplementares form={form} />,
      [
        v.precoAtacado &&
          `Atacado R$ ${v.precoAtacado}${v.qtdMinimaAtacado ? ` a partir de ${v.qtdMinimaAtacado}` : ''}`,
        v.precoPromocional && `Promocional R$ ${v.precoPromocional}`,
      ]
        .filter(Boolean)
        .join(' · ') || null,
    ),
    bloco(
      'codigos',
      'Embalagens e códigos adicionais',
      <CodigosAdicionais form={form} />,
      v.codigosAdicionais.length ? `${v.codigosAdicionais.length} código(s)` : null,
    ),
    kit
      ? bloco(
          'composicao',
          'Combo (kit)',
          <BlocoCombo
            form={form}
            verCusto={verCusto}
            produtoId={p?.id ?? null}
            avisos={avisosCombo}
            lojaFiscal={lojas.some((l) => l.tipoEmissao !== 'nao_fiscal')}
          />,
          resumoComboFechado,
          true,
          // ERP 8.2.17: no tipo Combo o bloco fica sempre aberto (as posições são obrigatórias).
          true,
        )
      : bloco(
          'composicao',
          'Ficha técnica',
          <FichaTecnica form={form} verCusto={verCusto} produtoId={p?.id ?? null} />,
          v.usaFichaTecnica ? `${v.insumos.length} insumo(s)` : null,
        ),
    bloco('outras', 'Outras informações', <OutrasInformacoes form={form} />, resumoOutras),
    bloco(
      'categorias',
      'Categorias',
      <BlocoCategorias form={form} />,
      categoriaPrincipal
        ? `${categoriaPrincipal.caminhoNomes.replace(/ > /g, ' › ')}${v.categorias.length > 1 ? ` (+${v.categorias.length - 1})` : ''}`
        : null,
    ),
    bloco(
      'relacionados',
      'Produtos relacionados',
      <BlocoRelacionados form={form} produtoId={p?.id ?? null} />,
      v.relacionados.length ? `${v.relacionados.length} produto(s)` : null,
    ),
    ...(usaFornecedores
      ? [
          bloco(
            'fornecedores',
            'Fornecedores',
            <BlocoFornecedores form={form} verCusto={verCusto} />,
            v.fornecedores.length
              ? [
                  `${v.fornecedores.length} fornecedor(es)`,
                  v.fornecedores.find((f) => f.principal) &&
                    `principal ${v.fornecedores.find((f) => f.principal)!.fornecedor.nome}`,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : null,
          ),
        ]
      : []),
    bloco(
      'quantidade',
      'Preço por quantidade',
      <PrecoPorQuantidade
        form={form}
        lojas={lojas}
        grupo={p?.grupoPreco ?? null}
        lojasSemPrecoVolume={precoVolume.data?.lojasDesligadas ?? []}
      />,
      v.precosQuantidade.length ? `${v.precosQuantidade.length} faixa(s)` : null,
    ),
    bloco(
      'lojas',
      'Lojas',
      <BlocoLojas form={form} />,
      `${v.lojas.filter((l) => l.precoVenda || l.estoqueMinimo).length} loja(s) com preço ou mínimo`,
    ),
    bloco(
      'estoque',
      'Estoque',
      p ? (
        <BlocoEstoque
          produtoId={p.id}
          combo={kit}
          verCusto={verCusto}
          semSaldoProprio={TIPOS_SEM_SALDO_PROPRIO.includes(p.tipo) || !p.controlaEstoque}
          tipoGravado={p.tipo}
        />
      ) : (
        <Text size="sm" c="dimmed">
          Grave o produto para ver os saldos.
        </Text>
      ),
    ),
    // Validade (8.2.12; F2-B17): os tipos sem saldo próprio (combo, serviço, produzido, "Com variações") não têm lote.
    ...(TIPOS_SEM_SALDO_PROPRIO.includes(v.tipo)
      ? []
      : [
          bloco(
            'validade',
            'Validade',
            <BlocoValidade form={form} produtoId={p?.id ?? null} />,
            resumoValidade(v),
          ),
        ]),
    bloco(
      'balanca',
      'Balança',
      <Balanca form={form} />,
      v.balancaTipo !== 'nao_usa' ? `PLU ${v.balancaPlu}` : null,
    ),
    bloco('tributacao', 'Tributação', <Tributacao form={form} kit={kit} />, resumoTributacao),
  ];

  return (
    <FormularioEntidade
      modo="acordeao"
      titulo={c.novo ? (duplicando ? 'Novo produto (cópia)' : 'Novo produto') : (p?.nome ?? 'Produto')}
      codigo={p?.codigo}
      situacao={p ? (p.ativo ? { rotulo: 'Ativo', cor: 'green' } : { rotulo: 'Inativo', cor: 'gray' }) : null}
      alteradoEm={p?.atualizadoEm}
      alteradoPor={p?.atualizadoPorNome}
      carregando={(!c.novo && c.registro.isPending) || (duplicando && origem.isPending)}
      salvando={c.salvando}
      somenteLeitura={!pode(c.novo ? 'produtos.criar' : 'produtos.editar')}
      sujo={form.isDirty()}
      rotaVoltar={ROTA_PRODUTOS}
      rotaNovo={!c.novo && pode('produtos.criar') ? `${ROTA_PRODUTOS}/novo` : undefined}
      aoSalvar={salvar}
      aoExcluir={!c.novo && pode('produtos.excluir') ? c.excluir : undefined}
      erro={c.erro instanceof ErroRequisicao && c.erro.corpo.detalhes?.eanDuplicado ? null : c.erro}
      aoRecarregar={c.recarregar}
      historico={p ? { entidade: 'produtos', registroId: p.id } : undefined}
      acoesExtras={
        p && pode('produtos.criar') ? (
          <Button
            variant="default"
            leftSection={<IconCopy size={16} />}
            onClick={() => navigate(`${ROTA_PRODUTOS}/${p.id}/duplicar`)}
          >
            Duplicar
          </Button>
        ) : undefined
      }
      abas={abas}
    />
  );
}

function Cabecalho({
  form,
  verCusto,
  p,
  margem,
  custoCombo,
}: {
  form: Form;
  verCusto: boolean;
  p: ProdutoDetalhe | undefined;
  margem: number | null;
  custoCombo: number | null;
}) {
  const unidades = useUnidades();
  const habilitados = useTiposProdutoHabilitados();
  const v = form.getValues();
  const kit = v.tipo === 'kit';
  // Tipos sem suporte (F2-B1; D43): a criação só oferece os habilitados; a edição mostra também o tipo gravado.
  const tipos = TIPOS_PRODUTO.filter((t) => habilitados.includes(t) || t === p?.tipo);
  const tipoBloqueado = motivoTipoProdutoBloqueado(v.tipo, p?.tipo ?? null, habilitados);
  const legadoSemSuporte = p && !habilitados.includes(p.tipo) ? p.tipo : null;
  // "Com variações" sem grade só movimentou o pai: troca como Simples (a API confere as variações).
  const trocaComMovimento = [...TIPOS_TROCA_COM_MOVIMENTO, 'com_variacoes'];
  const aoMudarVenda = (texto: string) => {
    form.setFieldValue('precoVenda', texto);
    const m = markupPct(kit ? (custoCombo ?? 0) : numero(v.precoCusto), numero(texto));
    if (m !== null) form.setFieldValue('markupPct', decimalParaTela(String(m), 4));
  };
  const ean = v.ean.trim();
  const eanInvalido = v.eanTipo === 'gtin' && /^\d{8,14}$/.test(ean) && !validarGtin(ean);
  return (
    <Grid>
      <Grid.Col span={{ base: 12, sm: 6 }}>
        <TextInput label="Nome" required maxLength={120} {...form.getInputProps('nome')} />
      </Grid.Col>
      <Grid.Col span={{ base: 8, sm: 4 }}>
        <Select
          label="Tipo"
          allowDeselect={false}
          data={tipos.map((t) => ({ value: t, label: ROTULOS_TIPO_PRODUTO[t] }))}
          disabled={!!p?.temMovimento && !trocaComMovimento.includes(p.tipo)}
          {...form.getInputProps('tipo')}
          error={form.errors.tipo ?? tipoBloqueado}
          onChange={(t) => {
            form.setFieldValue('tipo', (t ?? 'simples') as TipoProduto);
            if (t === 'servico') form.setFieldValue('controlaEstoque', false);
            if (t === 'produzido') form.setFieldValue('usaFichaTecnica', true);
            // Combo é vendido inteiro (validação "Combo não permite fração").
            if (t === 'kit') form.setFieldValue('permiteFracao', false);
          }}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 4, sm: 2 }}>
        <Switch mt={30} label="Ativo" {...form.getInputProps('ativo', { type: 'checkbox' })} />
      </Grid.Col>
      {legadoSemSuporte && (
        <Grid.Col span={12}>
          <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Tipo sem suporte nesta versão">
            {legadoSemSuporte === 'com_variacoes'
              ? 'Sem grade de variações, o caixa vende este produto com o preço e o saldo dele. Troque o tipo para Simples antes da atualização do PDV que recusa produto com variações.'
              : `O tipo "${ROTULOS_TIPO_PRODUTO[legadoSemSuporte]}" continua gravado e vendável no caixa, sem os complementos. O produto pode ser editado normalmente.`}
          </Alert>
        </Grid.Col>
      )}
      <Grid.Col span={{ base: 12, sm: 3 }}>
        <TextInput label="Código interno" maxLength={30} {...form.getInputProps('codigoInterno')} />
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 5 }}>
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            label={v.eanTipo === 'interno' ? 'Cód. barras (interno)' : 'Cód. barras (EAN-13)'}
            maxLength={30}
            inputMode="numeric"
            {...form.getInputProps('ean')}
            error={form.errors.ean ?? (eanInvalido ? 'Dígito verificador do GTIN inválido' : undefined)}
            onChange={(e) => {
              form.setFieldValue('ean', e.currentTarget.value);
              if (form.getValues().eanTipo === 'interno' && !e.currentTarget.value)
                form.setFieldValue('eanTipo', 'gtin');
            }}
          />
          <Tooltip label="Gera um código de barras de uso interno (prefixo 2, formato EAN-13) para este campo">
            <Button
              variant="default"
              leftSection={<IconBarcode size={16} />}
              onClick={async () => {
                const r = await apiErp
                  .get<{ codigo: string }>('/produtos/codigo-interno-livre')
                  .catch(() => ({ codigo: gerarCodigoInterno(Date.now() % 1e9) }));
                form.setFieldValue('ean', r.codigo);
                form.setFieldValue('eanTipo', 'interno');
              }}
            >
              Gerar código de barras interno
            </Button>
          </Tooltip>
        </Group>
      </Grid.Col>
      <Grid.Col span={{ base: 6, sm: 2 }}>
        <Select
          label="Unidade"
          required
          allowDeselect={false}
          data={(unidades.data ?? []).map((u) => ({ value: u.id, label: u.sigla }))}
          {...form.getInputProps('unidadeId')}
          onChange={(id) => {
            form.setFieldValue('unidadeId', id);
            const u = unidades.data?.find((x) => x.id === id);
            if (u)
              form.setFieldValue(
                'permiteFracao',
                u.permiteFracao || (UNIDADES_FRACIONADAS as readonly string[]).includes(u.sigla),
              );
          }}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 6, sm: 2 }}>
        <Switch
          mt={30}
          label="Permite fração"
          disabled={kit}
          title={kit ? 'Combo é vendido inteiro' : undefined}
          {...form.getInputProps('permiteFracao', { type: 'checkbox' })}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 12, sm: 6 }}>
        <BuscaNcm
          label="NCM"
          description={kit ? 'Não vai para a NFC-e: cada componente sai com o próprio NCM' : undefined}
          value={v.ncm}
          onChange={(n) => form.setFieldValue('ncm', n)}
          error={form.errors.ncm}
        />
      </Grid.Col>
      <Grid.Col span={{ base: 6, sm: 2 }}>
        <TextInput label="CEST" maxLength={9} {...form.getInputProps('cest')} />
      </Grid.Col>
      {verCusto && (
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput
            label="Preço de custo"
            leftSection="R$"
            readOnly={kit}
            variant={kit ? 'filled' : undefined}
            description={kit ? 'Calculado pela composição' : undefined}
            {...form.getInputProps('precoCusto')}
            value={kit ? decimalParaTela(String(custoCombo ?? 0)) : v.precoCusto}
          />
        </Grid.Col>
      )}
      {verCusto && p && (
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput
            label="Custo médio"
            leftSection="R$"
            readOnly
            variant="filled"
            description={kit ? 'Dos componentes padrão' : 'Do razão de estoque'}
            value={decimalParaTela(p.custoMedio)}
          />
        </Grid.Col>
      )}
      {verCusto && (
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <Group align="flex-end" gap={4} wrap="nowrap">
            <TextInput
              label="Markup %"
              readOnly={kit}
              variant={kit ? 'filled' : undefined}
              {...form.getInputProps('markupPct')}
            />
            {!kit && (
              <ActionIcon
                variant="default"
                size="lg"
                aria-label="Calcular preço pelo markup"
                title="Calcular: preço = custo × (1 + markup/100)"
                onClick={() =>
                  form.setFieldValue(
                    'precoVenda',
                    decimalParaTela(precoPeloMarkupTexto(numero(v.precoCusto), numero(v.markupPct))),
                  )
                }
              >
                <IconCalculator size={16} />
              </ActionIcon>
            )}
          </Group>
        </Grid.Col>
      )}
      <Grid.Col span={{ base: 6, sm: 2 }}>
        <TextInput
          label="Preço de venda"
          required={v.tipo !== 'materia_prima'}
          leftSection="R$"
          {...form.getInputProps('precoVenda')}
          onChange={(e) => aoMudarVenda(e.currentTarget.value)}
        />
      </Grid.Col>
      {verCusto && (
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput
            label="Margem %"
            readOnly
            variant="filled"
            value={pct(margem)}
            styles={{
              input: { color: margem !== null && margem < 0 ? 'var(--mantine-color-red-7)' : undefined },
            }}
          />
        </Grid.Col>
      )}
    </Grid>
  );
}

function PrecosComplementares({ form }: { form: Form }) {
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }}>
      <TextInput label="Atacado" leftSection="R$" {...form.getInputProps('precoAtacado')} />
      <TextInput
        label="Qtd. mínima atacado"
        description="A partir dela o atacado vale sozinho"
        {...form.getInputProps('qtdMinimaAtacado')}
      />
      <TextInput label="Promocional" leftSection="R$" {...form.getInputProps('precoPromocional')} />
      <TextInput
        label="Parcelado"
        leftSection="R$"
        description="Pagamento parcelado"
        {...form.getInputProps('precoParcelado')}
      />
      <CampoDataHora label="Promoção – início" {...form.getInputProps('promocaoInicio')} />
      <CampoDataHora label="Promoção – fim" {...form.getInputProps('promocaoFim')} />
      <TextInput label="Menu digital" leftSection="R$" {...form.getInputProps('precoMenuDigital')} />
      <TextInput label="iFood" leftSection="R$" {...form.getInputProps('precoIfood')} />
    </SimpleGrid>
  );
}

/** Preço unitário equivalente da embalagem (R$ 108,00 ÷ 12 = R$ 9,00), em decimal. */
const precoUnitarioEmbalagem = (preco: string, fator: string) =>
  dec(numero(preco)).div(numero(fator)).toDecimalPlaces(2).toFixed(2);

function CodigosAdicionais({ form }: { form: Form }) {
  const unidades = useUnidades();
  const v = form.getValues();
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Fardo/caixa (DUN-14) com fator: a leitura no PDV inclui o produto com quantidade = fator. Preço vazio
        = preço efetivo × fator.
      </Text>
      {v.codigosAdicionais.length > 0 && (
        <Group gap="xs" wrap="nowrap" visibleFrom="sm" aria-hidden data-testid="cabecalho-codigos">
          {(
            [
              ['Código', 170],
              ['Tipo', 110],
              ['Descrição', 150],
              ['Unid.', 90],
              ['Fator', 80],
              ['Preço', 120],
              ['Venda / Compra', 160],
            ] as const
          ).map(([t, w]) => (
            <Text key={t} size="xs" fw={500} c="dimmed" w={w}>
              {t}
            </Text>
          ))}
        </Group>
      )}
      {v.codigosAdicionais.map((c, i) => (
        <Group key={c.chave} align="flex-start" gap="xs" wrap="wrap" data-testid={`codigo-${i}`}>
          <TextInput
            aria-label="Código"
            placeholder="Código"
            w={170}
            {...form.getInputProps(`codigosAdicionais.${i}.codigo`)}
          />
          <Select
            aria-label="Tipo do código"
            w={110}
            allowDeselect={false}
            data={[
              { value: 'gtin', label: 'GTIN' },
              { value: 'interno', label: 'Interno' },
            ]}
            {...form.getInputProps(`codigosAdicionais.${i}.tipo`)}
          />
          <TextInput
            aria-label="Descrição"
            placeholder="Fardo 12 un"
            w={150}
            maxLength={40}
            {...form.getInputProps(`codigosAdicionais.${i}.descricao`)}
          />
          <Select
            aria-label="Unidade da embalagem"
            placeholder="Unid."
            w={90}
            data={(unidades.data ?? []).map((u) => ({ value: u.id, label: u.sigla }))}
            {...form.getInputProps(`codigosAdicionais.${i}.unidadeId`)}
          />
          <TextInput
            aria-label="Fator"
            placeholder="Fator"
            w={80}
            {...form.getInputProps(`codigosAdicionais.${i}.fator`)}
            onChange={(e) => {
              const fator = e.currentTarget.value;
              form.setFieldValue(`codigosAdicionais.${i}.fator`, fator);
              // Embalagem com fator > 1 sem unidade: sugere FD (fardo) ou CX.
              const atual = form.getValues().codigosAdicionais[i];
              if (numero(fator) > 1 && !atual?.unidadeId) {
                const sugestao = (unidades.data ?? []).find((u) => u.sigla === 'FD' || u.sigla === 'CX');
                if (sugestao) form.setFieldValue(`codigosAdicionais.${i}.unidadeId`, sugestao.id);
              }
            }}
          />
          <Stack gap={0}>
            <TextInput
              aria-label="Preço da embalagem"
              placeholder="Preço"
              leftSection="R$"
              w={120}
              {...form.getInputProps(`codigosAdicionais.${i}.preco`)}
            />
            {numero(c.fator) > 1 && numero(c.preco) > 0 && (
              <Text size="xs" c="dimmed" data-testid={`unitario-${i}`}>
                = R$ {decimalParaTela(precoUnitarioEmbalagem(c.preco, c.fator))} / un
              </Text>
            )}
          </Stack>
          <Checkbox
            mt={8}
            label="Venda"
            {...form.getInputProps(`codigosAdicionais.${i}.usaVenda`, { type: 'checkbox' })}
          />
          <Checkbox
            mt={8}
            label="Compra"
            {...form.getInputProps(`codigosAdicionais.${i}.usaCompra`, { type: 'checkbox' })}
          />
          <ActionIcon
            mt={4}
            color="red"
            variant="subtle"
            aria-label={`Remover código ${i + 1}`}
            onClick={() => form.removeListItem('codigosAdicionais', i)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            form.insertListItem('codigosAdicionais', {
              chave: novaChave(),
              id: null,
              codigo: '',
              tipo: 'gtin',
              descricao: '',
              unidadeId: null,
              fator: '1',
              preco: '',
              usaVenda: true,
              usaCompra: true,
            })
          }
        >
          Inserir código
        </Button>
      </Group>
    </Stack>
  );
}

const novaPosicao = (): PosicaoForm => ({
  chave: novaChave(),
  id: null,
  componenteId: null,
  componente: null,
  componenteVariacaoId: null,
  quantidade: '1',
  perdaPct: '',
  rotuloPosicao: '',
  permiteSubstituicao: false,
  alternativas: [],
});

/** Bloco Combo (kit) – ERP 8.2.17: posições com produto padrão, quantidade e alternativas com acréscimo. */
function BlocoCombo({
  form,
  verCusto,
  produtoId,
  avisos,
  lojaFiscal,
}: {
  form: Form;
  verCusto: boolean;
  produtoId: string | null;
  avisos: AvisoComboComponente[];
  /** Há loja ativa que emite documento fiscal (os avisos fiscais só importam nela). */
  lojaFiscal: boolean;
}) {
  const v = form.getValues();
  const resumo = resumoDasPosicoes(v.posicoes, numero(v.precoVenda));
  const lista = form.errors.posicoes;
  return (
    <Stack gap="sm">
      <AvisosCombo avisos={avisos} lojaFiscal={lojaFiscal} />
      {lista && (
        <Text size="sm" c="red">
          {lista}
        </Text>
      )}
      {v.posicoes.map((pos, i) => (
        <Paper key={pos.chave} withBorder p="sm" data-testid={`posicao-${i}`}>
          <Grid align="flex-end">
            <Grid.Col span={{ base: 12, sm: 3 }}>
              <TextInput
                label={`Posição ${i + 1}`}
                placeholder={pos.componente?.nome ?? 'Ex.: Energético 2L'}
                maxLength={40}
                {...form.getInputProps(`posicoes.${i}.rotuloPosicao`)}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <SeletorProduto
                label="Produto padrão"
                required
                tipos={TIPOS_COMPONENTE_COMBO}
                excluir={produtoId ? [produtoId] : []}
                value={pos.componenteId}
                produto={pos.componente}
                error={form.errors[`posicoes.${i}.componenteId`]}
                onChange={(id, prod) => {
                  form.setFieldValue(`posicoes.${i}.componenteId`, id);
                  form.setFieldValue(`posicoes.${i}.componente`, prod);
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 4, sm: 1 }}>
              <TextInput label="Qtd" {...form.getInputProps(`posicoes.${i}.quantidade`)} />
            </Grid.Col>
            {verCusto && (
              <Grid.Col span={{ base: 4, sm: 1 }}>
                <Text size="xs" c="dimmed">
                  Custo × qtd
                </Text>
                <Tooltip
                  disabled={!pos.componente}
                  label={
                    pos.componente
                      ? `${reais(Number(pos.componente.precoCusto ?? 0))} × ${pos.quantidade || '0'}`
                      : ''
                  }
                >
                  <Text size="sm">
                    {pos.componente ? reais(vezes(pos.componente.precoCusto ?? '0', pos.quantidade)) : '—'}
                  </Text>
                </Tooltip>
              </Grid.Col>
            )}
            <Grid.Col span={{ base: 4, sm: 1 }}>
              <Text size="xs" c="dimmed">
                Preço × qtd
              </Text>
              <Tooltip
                disabled={!pos.componente}
                label={
                  pos.componente
                    ? `${reais(Number(pos.componente.precoVenda))} × ${pos.quantidade || '0'}`
                    : ''
                }
              >
                <Text size="sm">
                  {pos.componente ? reais(vezes(pos.componente.precoVenda, pos.quantidade)) : '—'}
                </Text>
              </Tooltip>
            </Grid.Col>
            <Grid.Col span={{ base: 8, sm: 1 }}>
              <Switch
                label="Permite troca"
                {...form.getInputProps(`posicoes.${i}.permiteSubstituicao`, { type: 'checkbox' })}
                onChange={(e) => {
                  const ligado = e.currentTarget.checked;
                  const desligar = () => {
                    form.setFieldValue(`posicoes.${i}.permiteSubstituicao`, ligado);
                    if (!ligado) form.setFieldValue(`posicoes.${i}.alternativas`, []);
                  };
                  if (!ligado && pos.alternativas.length) {
                    modals.openConfirmModal({
                      title: 'Desligar a troca',
                      children: <Text size="sm">As alternativas desta posição serão excluídas.</Text>,
                      labels: { confirm: 'Excluir alternativas', cancel: 'Cancelar' },
                      onConfirm: desligar,
                    });
                  } else desligar();
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 4, sm: 1 }}>
              <Group justify="flex-end" gap={2}>
                <ActionIcon
                  variant="subtle"
                  aria-label={`Subir posição ${i + 1}`}
                  disabled={i === 0}
                  onClick={() => form.reorderListItem('posicoes', { from: i, to: i - 1 })}
                >
                  ↑
                </ActionIcon>
                <ActionIcon
                  color="red"
                  variant="subtle"
                  aria-label={`Remover posição ${i + 1}`}
                  onClick={() => form.removeListItem('posicoes', i)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Grid.Col>
          </Grid>
          {pos.permiteSubstituicao && (
            <Stack gap={4} mt="xs" pl="md">
              <Text size="xs" fw={500}>
                Alternativas{' '}
                {form.errors[`posicoes.${i}.alternativas`] && (
                  <Text span c="red" size="xs">
                    {form.errors[`posicoes.${i}.alternativas`]}
                  </Text>
                )}
              </Text>
              {pos.alternativas.map((a, j) => (
                <Group
                  key={a.chave}
                  gap="xs"
                  align="flex-start"
                  wrap="wrap"
                  data-testid={`alternativa-${i}-${j}`}
                >
                  <SeletorProduto
                    aria-label="Produto alternativo"
                    w={300}
                    tipos={TIPOS_COMPONENTE_COMBO}
                    excluir={[
                      ...(produtoId ? [produtoId] : []),
                      ...(pos.componenteId ? [pos.componenteId] : []),
                    ]}
                    value={a.produtoId}
                    produto={a.produto}
                    error={form.errors[`posicoes.${i}.alternativas.${j}.produtoId`]}
                    onChange={(id, prod) => {
                      form.setFieldValue(`posicoes.${i}.alternativas.${j}.produtoId`, id);
                      form.setFieldValue(`posicoes.${i}.alternativas.${j}.produto`, prod);
                    }}
                  />
                  <TextInput
                    aria-label="Acréscimo"
                    leftSection="+R$"
                    w={120}
                    {...form.getInputProps(`posicoes.${i}.alternativas.${j}.acrescimo`)}
                  />
                  {a.produto && (
                    <Text size="xs" c="dimmed" mt={8} data-testid={`alternativa-preco-${i}-${j}`}>
                      Preço {reais(Number(a.produto.precoVenda))}
                    </Text>
                  )}
                  {verCusto && a.produto && pos.componente && (
                    <Text size="xs" c="dimmed" mt={8} data-testid={`alternativa-custo-${i}-${j}`}>
                      {(() => {
                        // Diferença de custo da posição inteira (custo × qtd), que é o que muda a margem.
                        const dif = dec(vezes(a.produto.precoCusto ?? '0', pos.quantidade)).minus(
                          vezes(pos.componente.precoCusto ?? '0', pos.quantidade),
                        );
                        return `Custo × qtd ${reais(vezes(a.produto.precoCusto ?? '0', pos.quantidade))} (${dif.gte(0) ? '+' : ''}${decimalParaTela(dif.toFixed(2))})`;
                      })()}
                    </Text>
                  )}
                  <Checkbox
                    mt={8}
                    label="Ativa"
                    {...form.getInputProps(`posicoes.${i}.alternativas.${j}.ativo`, { type: 'checkbox' })}
                  />
                  <ActionIcon
                    mt={4}
                    variant="subtle"
                    aria-label={`Subir alternativa ${j + 1} da posição ${i + 1}`}
                    title="Ordem no diálogo do PDV"
                    disabled={j === 0}
                    onClick={() => form.reorderListItem(`posicoes.${i}.alternativas`, { from: j, to: j - 1 })}
                  >
                    ↑
                  </ActionIcon>
                  <ActionIcon
                    mt={4}
                    variant="subtle"
                    aria-label={`Descer alternativa ${j + 1} da posição ${i + 1}`}
                    title="Ordem no diálogo do PDV"
                    disabled={j === pos.alternativas.length - 1}
                    onClick={() => form.reorderListItem(`posicoes.${i}.alternativas`, { from: j, to: j + 1 })}
                  >
                    ↓
                  </ActionIcon>
                  <ActionIcon
                    mt={4}
                    color="red"
                    variant="subtle"
                    aria-label={`Remover alternativa ${j + 1}`}
                    onClick={() => form.removeListItem(`posicoes.${i}.alternativas`, j)}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
              <Group>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconPlus size={12} />}
                  onClick={() =>
                    form.insertListItem(`posicoes.${i}.alternativas`, {
                      chave: novaChave(),
                      id: null,
                      produtoId: null,
                      produto: null,
                      variacaoId: null,
                      acrescimo: '0,00',
                      ativo: true,
                    })
                  }
                >
                  Inserir alternativa
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => form.insertListItem('posicoes', novaPosicao())}
        >
          Inserir posição
        </Button>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 4 }} data-testid="resumo-combo">
        {verCusto && <Info rotulo="Custo do combo" valor={reais(resumo.custo)} />}
        <Info rotulo="Soma dos componentes" valor={reais(resumo.somaPrecos)} />
        {resumo.descontoCombo >= 0 ? (
          <Info
            rotulo="Desconto do combo"
            valor={`${reais(resumo.descontoCombo)}${resumo.descontoPct !== null ? ` (${pct(resumo.descontoPct)})` : ''}`}
          />
        ) : (
          <Info
            rotulo="Acréscimo sobre os itens avulsos"
            valor={reais(-resumo.descontoCombo)}
            cor="orange"
            dica="O combo está mais caro que os componentes"
          />
        )}
        {verCusto && (
          <Info
            rotulo="Margem / markup"
            valor={`${pct(resumo.margemPct)} / ${pct(resumo.markupPct)}`}
            cor={resumo.margemPct !== null && resumo.margemPct < 0 ? 'red' : undefined}
          />
        )}
        {verCusto && resumo.margemMinPct !== null && (
          <Info
            rotulo="Margem com as trocas"
            valor={`de ${pct(resumo.margemMinPct)} a ${pct(resumo.margemMaxPct)}`}
          />
        )}
      </SimpleGrid>
    </Stack>
  );
}

function Info({ rotulo, valor, cor, dica }: { rotulo: string; valor: string; cor?: string; dica?: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {rotulo}
      </Text>
      <Text size="sm" fw={500} c={cor}>
        {valor}
      </Text>
      {dica && (
        <Text size="xs" c={cor ?? 'dimmed'}>
          {dica}
        </Text>
      )}
    </Stack>
  );
}

/** Valor × quantidade em decimal (quantidade digitada em pt-BR). */
const vezes = (valor: string, quantidade: string) => dec(valor).times(numero(quantidade)).toNumber();

/**
 * Avisos do combo num só alerta (ERP 8.2.17): os de venda (inativo, preço zero) sempre; os fiscais em destaque só
 * com loja NFC-e/SAT ativa — sem ela, uma nota discreta. Lista recolhível com link para cada componente.
 */
function AvisosCombo({ avisos, lojaFiscal }: { avisos: AvisoComboComponente[]; lojaFiscal: boolean }) {
  const [aberto, setAberto] = useState(false);
  const venda = avisos.filter((a) => !a.fiscal);
  const fiscais = avisos.filter((a) => a.fiscal);
  const destacados = lojaFiscal ? avisos : venda;
  const item = (a: AvisoComboComponente) => (
    <li key={`${a.produtoId}:${a.motivo}`}>
      <Anchor component={Link} size="sm" to={`${ROTA_PRODUTOS}/${a.produtoId}`}>
        {a.codigo} - {a.nome}
      </Anchor>
      : {a.motivo}
    </li>
  );
  return (
    <>
      {destacados.length > 0 && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          p="xs"
          data-testid="avisos-combo"
          title={
            fiscais.length && lojaFiscal
              ? `Não vendável em loja NFC-e (${destacados.length} aviso(s))`
              : `Componentes com problema (${destacados.length})`
          }
        >
          <Anchor component="button" type="button" size="xs" onClick={() => setAberto((x) => !x)}>
            {aberto ? 'Ocultar detalhes' : 'Ver componentes e motivos'}
          </Anchor>
          {aberto && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{destacados.map(item)}</ul>}
        </Alert>
      )}
      {!lojaFiscal && fiscais.length > 0 && (
        <Text size="xs" c="dimmed" data-testid="nota-fiscal-combo">
          {fiscais.length} pendência(s) fiscal(is) nos componentes — só impedem a venda em loja que emite
          NFC-e (nenhuma ativa agora).
        </Text>
      )}
    </>
  );
}

/** Ficha técnica (ERP 8.2.4): insumos com quantidade e perda; custo calculado com "Usar como preço de custo". */
function FichaTecnica({
  form,
  verCusto,
  produtoId,
}: {
  form: Form;
  verCusto: boolean;
  produtoId: string | null;
}) {
  const v = form.getValues();
  // ERP 8.2.4: Σ (custo médio do insumo × qtd × (1 + perda)); insumo ainda sem custo médio usa o custo do cadastro.
  const custoDoInsumo = (i: (typeof v.insumos)[number]) =>
    dec(i.componente?.custoMedio ?? 0).gt(0) ? i.componente!.custoMedio! : (i.componente?.precoCusto ?? '0');
  const custo = v.insumos
    .reduce(
      (s, i) =>
        s.plus(
          dec(custoDoInsumo(i))
            .times(numero(i.quantidade))
            .times(dec(numero(i.perdaPct)).div(100).plus(1)),
        ),
      dec(0),
    )
    .toDecimalPlaces(4)
    .toNumber();
  return (
    <Stack gap="xs">
      <Switch
        label={
          v.tipo === 'produzido'
            ? 'Usa ficha técnica (a venda baixa os insumos)'
            : 'Usa ficha técnica (informativa: custo)'
        }
        disabled={v.tipo === 'produzido'}
        {...form.getInputProps('usaFichaTecnica', { type: 'checkbox' })}
      />
      {form.errors.insumos && (
        <Text size="sm" c="red">
          {form.errors.insumos}
        </Text>
      )}
      {v.usaFichaTecnica && (
        <>
          {v.insumos.map((ins, i) => (
            <Group key={ins.chave} gap="xs" align="flex-start" wrap="wrap">
              <SeletorProduto
                aria-label="Insumo"
                w={320}
                tipos={TIPOS_INSUMO_FICHA}
                excluir={produtoId ? [produtoId] : []}
                value={ins.componenteId}
                produto={ins.componente}
                error={form.errors[`insumos.${i}.componenteId`]}
                onChange={(id, prod) => {
                  form.setFieldValue(`insumos.${i}.componenteId`, id);
                  form.setFieldValue(`insumos.${i}.componente`, prod);
                }}
              />
              <TextInput
                aria-label="Quantidade do insumo"
                w={100}
                rightSection={<Text size="xs">{ins.componente?.unidadeSigla}</Text>}
                {...form.getInputProps(`insumos.${i}.quantidade`)}
              />
              <TextInput
                aria-label="Perda %"
                placeholder="Perda %"
                w={100}
                {...form.getInputProps(`insumos.${i}.perdaPct`)}
              />
              <ActionIcon
                mt={4}
                color="red"
                variant="subtle"
                aria-label={`Remover insumo ${i + 1}`}
                onClick={() => form.removeListItem('insumos', i)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group justify="space-between">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => form.insertListItem('insumos', novaPosicao())}
            >
              Inserir insumo
            </Button>
            {verCusto && (
              <Group gap="xs">
                <Text
                  size="sm"
                  title="Pelo custo médio dos insumos (ou o custo do cadastro, sem custo médio)"
                >
                  Custo calculado pelo custo médio dos insumos: {reais(custo)}
                </Text>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => form.setFieldValue('precoCusto', decimalParaTela(String(custo)))}
                >
                  Usar como preço de custo
                </Button>
              </Group>
            )}
          </Group>
        </>
      )}
    </Stack>
  );
}

const FLAGS: Array<[keyof ValoresProduto & string, string]> = [
  ['solicitaPrecoPdv', 'Solicita preço no PDV'],
  ['generico', 'Produto genérico'],
  ['controlaEstoque', 'Controla estoque'],
  ['insumo', 'Insumo'],
  ['usaMenuDigital', 'Menu digital'],
  ['usaTotem', 'Usa no totem'],
  ['maisVendido', 'Mais vendido'],
  ['reposicaoRodizio', 'Reposição rodízio'],
];

function OutrasInformacoes({ form }: { form: Form }) {
  const marcas = useMarcas();
  const v = form.getValues();
  return (
    <Stack gap="sm">
      <Grid>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <Select
            label="Marca"
            searchable
            clearable
            data={(marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao }))}
            {...form.getInputProps('marcaId')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput label="Localização" maxLength={40} {...form.getInputProps('localizacao')} />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput label="Qtd. mín. venda" {...form.getInputProps('qtdMinimaVenda')} />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput
            label="Idade mínima"
            description="Ex.: 18 (bebida alcoólica)"
            {...form.getInputProps('idadeMinima')}
          />
        </Grid.Col>
        <Grid.Col span={{ base: 6, sm: 2 }}>
          <TextInput label="Comissão %" {...form.getInputProps('comissaoPct')} />
        </Grid.Col>
        {v.tipo !== 'vasilhame' && (
          <>
            <Grid.Col span={{ base: 12, sm: 5 }}>
              <SeletorProduto
                label="Vasilhame (casco)"
                description="Casco devido por unidade vendida (retornável)"
                tipos={['vasilhame']}
                value={v.vasilhameProdutoId}
                produto={v.vasilhame}
                error={form.errors.vasilhameProdutoId}
                onChange={(id, prod) => {
                  form.setFieldValue('vasilhameProdutoId', id);
                  form.setFieldValue('vasilhame', prod);
                  if (id && !form.getValues().vasilhameQuantidade)
                    form.setFieldValue('vasilhameQuantidade', '1');
                  if (!id) form.setFieldValue('vasilhameQuantidade', '');
                }}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 2 }}>
              <TextInput label="Cascos por unidade" {...form.getInputProps('vasilhameQuantidade')} />
            </Grid.Col>
          </>
        )}
        <Grid.Col span={{ base: 6, sm: 3 }}>
          <TextInput label="Material" maxLength={60} {...form.getInputProps('material')} />
        </Grid.Col>
      </Grid>
      <SimpleGrid cols={{ base: 2, sm: 3 }}>
        {FLAGS.map(([campo, rotulo]) => (
          <Checkbox
            key={campo}
            label={rotulo}
            disabled={campo === 'controlaEstoque' && v.tipo === 'servico'}
            {...form.getInputProps(campo, { type: 'checkbox' })}
          />
        ))}
      </SimpleGrid>
      <Textarea
        label="Descrição curta"
        maxLength={250}
        autosize
        minRows={1}
        {...form.getInputProps('descricaoCurta')}
      />
      <SimpleGrid cols={{ base: 3, sm: 6 }}>
        <TextInput label="Largura (cm)" {...form.getInputProps('larguraCm')} />
        <TextInput label="Altura (cm)" {...form.getInputProps('alturaCm')} />
        <TextInput label="Profundidade (cm)" {...form.getInputProps('profundidadeCm')} />
        <TextInput label="Peso (g)" {...form.getInputProps('pesoG')} />
        <TextInput label="Peso abatimento (g)" {...form.getInputProps('pesoAbatimentoG')} />
        <TextInput label="Peso pacote (kg)" {...form.getInputProps('pesoPacoteKg')} />
      </SimpleGrid>
    </Stack>
  );
}

/**
 * Aviso de "Usa Produto Preço Volume" desligado (`pdv.usa_preco_volume`, padrão Não): faixas do produto e do mix em
 * modo grupo não valem no PDV dessas lojas. Também usado no grupo de preço e no Simular.
 */
export function AvisoPrecoVolume({ lojas }: { lojas: ReadonlyArray<{ id: string; nome: string }> }) {
  if (!lojas.length) return null;
  return (
    <Alert color="yellow" icon={<IconAlertTriangle size={16} />} p="xs" data-testid="aviso-preco-volume">
      “Usa Produto Preço Volume” está desligado nas lojas: {lojas.map((l) => l.nome).join(', ')}. As faixas
      por quantidade não valem no PDV delas.{' '}
      <Anchor component={Link} size="sm" to="/cadastros/configuracoes/parametros">
        Configurações › Parâmetros
      </Anchor>
    </Alert>
  );
}

function PrecoPorQuantidade({
  form,
  lojas,
  grupo,
  lojasSemPrecoVolume,
}: {
  form: Form;
  lojas: ReadonlyArray<{ id: string; nome: string }>;
  grupo: ProdutoDetalhe['grupoPreco'];
  lojasSemPrecoVolume: ReadonlyArray<{ id: string; nome: string }>;
}) {
  const grupos = useGruposPreco();
  const pode = usePode();
  const v = form.getValues();
  const opcoesLoja = [
    { value: '', label: 'Todas as lojas' },
    ...lojas.map((l) => ({ value: l.id, label: l.nome })),
  ];
  return (
    <Stack gap="sm">
      <AvisoPrecoVolume lojas={lojasSemPrecoVolume} />
      <Text size="xs" c="dimmed">
        A faixa da loja prevalece sobre a de todas as lojas; a quantidade final entra na faixa (6 a 11 vale
        para 11).
      </Text>
      {v.precosQuantidade.map((f, i) => (
        <Group key={f.chave} gap="xs" align="flex-start" data-testid={`faixa-${i}`}>
          <Select
            aria-label="Loja da faixa"
            w={200}
            allowDeselect={false}
            data={opcoesLoja}
            disabled={!!f.id}
            {...form.getInputProps(`precosQuantidade.${i}.lojaId`)}
          />
          <TextInput
            aria-label="Qtd inicial"
            placeholder="Qtd inicial"
            w={110}
            {...form.getInputProps(`precosQuantidade.${i}.quantidadeInicial`)}
          />
          <TextInput
            aria-label="Qtd final"
            placeholder="Sem limite"
            w={110}
            {...form.getInputProps(`precosQuantidade.${i}.quantidadeFinal`)}
          />
          <TextInput
            aria-label="Preço da faixa"
            leftSection="R$"
            w={120}
            {...form.getInputProps(`precosQuantidade.${i}.preco`)}
          />
          <ActionIcon
            mt={4}
            color="red"
            variant="subtle"
            aria-label={`Remover faixa ${i + 1}`}
            onClick={() => form.removeListItem('precosQuantidade', i)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            form.insertListItem('precosQuantidade', {
              chave: novaChave(),
              id: null,
              lojaId: '',
              quantidadeInicial: '',
              quantidadeFinal: '',
              preco: '',
            })
          }
        >
          Inserir faixa
        </Button>
      </Group>
      {pode('grupos_preco.ver') && (
        <Grid>
          <Grid.Col span={{ base: 12, sm: 6 }}>
            <Select
              label="Grupo de preço por quantidade (mix)"
              description="Soma as quantidades com os outros produtos do grupo"
              clearable
              searchable
              disabled={!['simples', 'com_variacoes', 'produzido'].includes(v.tipo)}
              data={(grupos.data?.itens ?? []).map((g) => ({
                value: g.id,
                label: `${g.nome}${g.ativo ? '' : ' (inativo)'}`,
              }))}
              {...form.getInputProps('grupoPrecoQuantidadeId')}
            />
          </Grid.Col>
          {grupo && grupo.id === v.grupoPrecoQuantidadeId && (
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Text size="xs" c="dimmed">
                Modo: {ROTULOS_MODO_PRECO_GRUPO[grupo.modoPreco]}
              </Text>
              <Text size="sm">
                {grupo.faixas
                  .map((f) => `${decimalParaTela(f.quantidadeInicial, 3)}+ R$ ${decimalParaTela(f.preco)}`)
                  .join('; ') || 'Usa o atacado/faixas de cada produto'}
              </Text>
              <Anchor component={Link} size="sm" to={`/produtos/grupos-preco/${grupo.id}`}>
                Abrir o grupo
              </Anchor>
            </Grid.Col>
          )}
        </Grid>
      )}
    </Stack>
  );
}

function BlocoLojas({ form }: { form: Form }) {
  const v = form.getValues();
  if (!v.lojas.length)
    return (
      <Text size="sm" c="dimmed">
        Nenhuma loja ativa permitida.
      </Text>
    );
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Loja</Table.Th>
            <Table.Th>Estoque mínimo</Table.Th>
            <Table.Th>Estoque máximo</Table.Th>
            <Table.Th>Preço de venda</Table.Th>
            <Table.Th>Acréscimo gelada</Table.Th>
            <Table.Th>Ativo na loja</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {v.lojas.map((l, i) => (
            <Table.Tr key={l.lojaId}>
              <Table.Td>{l.nome}</Table.Td>
              <Table.Td>
                <TextInput
                  aria-label={`Estoque mínimo ${l.nome}`}
                  size="xs"
                  {...form.getInputProps(`lojas.${i}.estoqueMinimo`)}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  aria-label={`Estoque máximo ${l.nome}`}
                  size="xs"
                  {...form.getInputProps(`lojas.${i}.estoqueMaximo`)}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  aria-label={`Preço ${l.nome}`}
                  size="xs"
                  placeholder="Preço geral"
                  {...form.getInputProps(`lojas.${i}.precoVenda`)}
                />
              </Table.Td>
              <Table.Td>
                <TextInput
                  aria-label={`Acréscimo gelada ${l.nome}`}
                  size="xs"
                  {...form.getInputProps(`lojas.${i}.acrescimoGelada`)}
                />
              </Table.Td>
              <Table.Td>
                <Switch
                  aria-label={`Ativo na loja ${l.nome}`}
                  {...form.getInputProps(`lojas.${i}.ativoNaLoja`, { type: 'checkbox' })}
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

/**
 * Estoque (ERP 8.2.11): saldo por estoque × tipo, com o "Ajustar" (F2-B12; `estoque_acertos.criar`) para quem tem
 * saldo próprio; no combo, os combos montáveis por estoque (8.2.17). F2-B26: o "Em trânsito" (enviado para o estoque e
 * ainda não recebido) e, só quando houver, a "Divergência a tratar" (a diferença recebida a menor que voltará à origem
 * ou será baixada como perda), dos estoques permitidos e no tipo de cada linha (a API já filtra). F2-B33: "Ver
 * movimentação" em cada linha (com `relatorios.movimentacao_estoque`) abre a Movimentação analítica do produto no
 * estoque, nos últimos 30 dias.
 */
function BlocoEstoque({
  produtoId,
  combo,
  verCusto,
  semSaldoProprio,
  tipoGravado,
}: {
  produtoId: string;
  combo: boolean;
  verCusto: boolean;
  semSaldoProprio: boolean;
  tipoGravado: TipoProduto;
}) {
  const pode = usePode();
  const verMovimentacao = pode('relatorios.movimentacao_estoque');
  const [ajustando, setAjustando] = useState(false);
  const r = useQuery({
    queryKey: ['produtos', produtoId, 'saldos'],
    queryFn: () => apiErp.get<SaldosProduto>(`/produtos/${produtoId}/saldos`),
  });
  if (r.isPending) return <Text size="sm">Carregando…</Text>;
  if (r.isError) return <Alert color="red">{(r.error as Error).message}</Alert>;
  if (r.data.combo || combo) {
    return (
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          O combo não tem estoque próprio: a venda baixa os componentes escolhidos.
        </Text>
        <Table data-testid="montaveis">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Estoque</Table.Th>
              <Table.Th>Combos montáveis</Table.Th>
              <Table.Th>Limitado por</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {r.data.montaveis.map((m) => (
              <Table.Tr key={m.estoqueId}>
                <Table.Td>{m.estoqueNome}</Table.Td>
                <Table.Td>{m.quantidade === null ? 'Sem limite' : m.quantidade}</Table.Td>
                <Table.Td>{m.limitadoPor ?? '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    );
  }
  const acoes = pode('estoque_acertos.criar') ? (
    semSaldoProprio ? (
      <Text size="xs" c="dimmed">
        {tipoGravado === 'produzido'
          ? 'Produto produzido não tem estoque próprio: ajuste os insumos da ficha técnica.'
          : tipoGravado === 'servico'
            ? 'Serviço não tem estoque.'
            : tipoGravado === 'com_variacoes'
              ? 'O saldo é por variação: ajuste pelo acerto de estoque.'
              : 'O produto não controla estoque.'}
      </Text>
    ) : (
      <Group justify="flex-end">
        <Button
          variant="default"
          leftSection={<IconAdjustments size={16} />}
          onClick={() => setAjustando(true)}
        >
          Ajustar
        </Button>
        <ModalAjustarEstoque
          aberto={ajustando}
          produtoId={produtoId}
          saldos={r.data.saldos}
          aoFechar={() => setAjustando(false)}
        />
      </Group>
    )
  ) : null;
  if (!r.data.saldos.length)
    return (
      <Stack gap="xs">
        {acoes}
        <Text size="sm" c="dimmed">
          Sem saldo em nenhum estoque.
        </Text>
      </Stack>
    );
  const comDivergencia = r.data.saldos.some((s) => Number(s.divergenciaATratar) !== 0);
  const pendencia = (v: string) => (Number(v) === 0 ? '—' : decimalParaTela(v, 3));
  return (
    <Stack gap="xs">
      {acoes}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Estoque</Table.Th>
            <Table.Th>Tipo</Table.Th>
            <Table.Th ta="right">Quantidade</Table.Th>
            <Table.Th ta="right" title="Enviado para este estoque e ainda não recebido">
              Em trânsito
            </Table.Th>
            {comDivergencia && (
              <Table.Th
                ta="right"
                title="Recebido a menor numa transferência que saiu deste estoque, ainda sem tratamento (não está no saldo)"
              >
                Divergência a tratar
              </Table.Th>
            )}
            {verCusto && <Table.Th ta="right">Custo médio</Table.Th>}
            <Table.Th>Última entrada</Table.Th>
            <Table.Th>Última saída</Table.Th>
            {verMovimentacao && <Table.Th>Movimentação</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {r.data.saldos.map((s) => (
            <Table.Tr key={`${s.estoqueId}:${s.tipoEstoqueId}`}>
              <Table.Td>{s.estoqueNome}</Table.Td>
              <Table.Td>
                {s.tipoEstoqueNome}{' '}
                {!s.vendavel && (
                  <Badge size="xs" color="gray" variant="light">
                    não vendável
                  </Badge>
                )}
              </Table.Td>
              <Table.Td ta="right">{decimalParaTela(s.quantidade, 3)}</Table.Td>
              <Table.Td ta="right" data-testid="em-transito">
                {pendencia(s.emTransito)}
              </Table.Td>
              {comDivergencia && (
                <Table.Td ta="right" c={Number(s.divergenciaATratar) !== 0 ? 'orange' : undefined}>
                  {pendencia(s.divergenciaATratar)}
                </Table.Td>
              )}
              {verCusto && <Table.Td ta="right">{reais(Number(s.custoMedio))}</Table.Td>}
              <Table.Td>{formatarDataHora(s.ultimaEntradaEm)}</Table.Td>
              <Table.Td>{formatarDataHora(s.ultimaSaidaEm)}</Table.Td>
              {verMovimentacao && (
                <Table.Td>
                  <Anchor
                    component={Link}
                    to={linkVerMovimentacao({ estoqueId: s.estoqueId, produtoId })}
                    size="sm"
                    aria-label={`Ver movimentação em ${s.estoqueNome} (${s.tipoEstoqueNome})`}
                  >
                    Ver movimentação
                  </Anchor>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function Balanca({ form }: { form: Form }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      <Select
        label="Tipo"
        allowDeselect={false}
        data={[
          { value: 'nao_usa', label: 'Não usa' },
          { value: 'peso', label: 'Peso (kg)' },
          { value: 'unidade', label: 'Unidade' },
        ]}
        {...form.getInputProps('balancaTipo')}
      />
      <TextInput label="PLU" description="1 a 999999" {...form.getInputProps('balancaPlu')} />
      <TextInput label="Validade (dias)" {...form.getInputProps('balancaValidadeDias')} />
    </SimpleGrid>
  );
}

function Tributacao({ form, kit }: { form: Form; kit: boolean }) {
  const cfop5 = useCfops('5');
  const cfop6 = useCfops('6');
  const op = (l: Array<{ codigo: string; descricao: string }> | undefined) =>
    (l ?? []).map((c) => ({ value: c.codigo, label: `${c.codigo} – ${c.descricao.slice(0, 60)}` }));
  const digitos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: String(i), label: String(i) }));
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {kit
          ? 'No combo a tributação não vai para a NFC-e: cada componente sai com a própria tributação.'
          : 'Vazio = padrão de Configurações › Tributação (exceto NCM e CFOP). CST 60/CSOSN 500 usa o CFOP 5405 e exige CEST.'}
      </Text>
      <Title order={5} size="h6">
        ICMS
      </Title>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <Select
          label="CFOP dentro do estado"
          searchable
          clearable
          data={op(cfop5.data)}
          {...form.getInputProps('cfopVendaEstado')}
        />
        <Select
          label="CFOP fora do estado"
          searchable
          clearable
          data={op(cfop6.data)}
          {...form.getInputProps('cfopVendaForaEstado')}
        />
        <TextInput label="Situação (CST/CSOSN)" maxLength={3} {...form.getInputProps('icmsSituacao')} />
        <Select label="Origem" clearable data={digitos(9)} {...form.getInputProps('icmsOrigem')} />
        <Select
          label="Modalidade BC"
          clearable
          data={digitos(4)}
          {...form.getInputProps('icmsModalidadeBc')}
        />
        <Select
          label="Modalidade BC ST"
          clearable
          data={digitos(7)}
          {...form.getInputProps('icmsModalidadeBcst')}
        />
        <TextInput label="Alíquota %" {...form.getInputProps('icmsAliquota')} />
        <TextInput label="Redução de BC %" {...form.getInputProps('icmsReducaoBcPct')} />
        <TextInput label="MVA ST %" {...form.getInputProps('icmsMvaPct')} />
        <TextInput label="Alíquota ST %" {...form.getInputProps('icmsAliquotaSt')} />
        <TextInput label="FCP %" {...form.getInputProps('fcpAliquota')} />
        <TextInput label="FCP-ST %" {...form.getInputProps('fcpStAliquota')} />
        <TextInput label="cBenef" maxLength={10} {...form.getInputProps('beneficioFiscalCodigo')} />
      </SimpleGrid>
      <Title order={5} size="h6">
        PIS / COFINS / IPI
      </Title>
      <SimpleGrid cols={{ base: 2, sm: 4 }}>
        <TextInput label="PIS – situação" maxLength={2} {...form.getInputProps('pisSituacao')} />
        <TextInput label="PIS – alíquota %" {...form.getInputProps('pisAliquota')} />
        <TextInput label="COFINS – situação" maxLength={2} {...form.getInputProps('cofinsSituacao')} />
        <TextInput label="COFINS – alíquota %" {...form.getInputProps('cofinsAliquota')} />
        <TextInput label="IPI – situação" maxLength={2} {...form.getInputProps('ipiSituacao')} />
        <TextInput label="IPI – alíquota %" {...form.getInputProps('ipiAliquota')} />
        <TextInput label="IPI – enquadramento" maxLength={3} {...form.getInputProps('ipiEnquadramento')} />
        <TextInput
          label="Classificação IBS/CBS"
          maxLength={6}
          {...form.getInputProps('ibsCbsClassificacao')}
        />
      </SimpleGrid>
    </Stack>
  );
}
