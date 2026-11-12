/**
 * Valores do formulário de produto (ERP 8.2) ⇄ corpo da API. Decimais ficam como o texto digitado (vírgula, ERP 1.5)
 * e viram string decimal na API; o EAN principal é um campo do Cabeçalho (virtual, MD 3.6.3) e os demais códigos
 * vão para "Embalagens e códigos adicionais"; posições do combo e insumos da ficha técnica são listas separadas.
 */
import {
  chaveLoteProduto,
  TIPOS_SEM_SALDO_PROPRIO,
  type PessoaOpcao,
  type ProdutoDetalhe,
  type ProdutoOpcao,
  type TipoProduto,
  type TipoRelacaoProduto,
} from '@genesis/shared';
import { formatarDecimal, lerDecimal } from '../../componentes/grade/decimal';

let sequencia = 0;
export const novaChave = () => `n${++sequencia}`;

export interface CodigoForm {
  chave: string;
  id: string | null;
  codigo: string;
  tipo: 'gtin' | 'interno';
  descricao: string;
  unidadeId: string | null;
  fator: string;
  preco: string;
  usaVenda: boolean;
  usaCompra: boolean;
}

export interface LojaForm {
  lojaId: string;
  nome: string;
  existente: boolean;
  estoqueMinimo: string;
  estoqueMaximo: string;
  precoVenda: string;
  ativoNaLoja: boolean;
  acrescimoGelada: string;
}

export interface FaixaForm {
  chave: string;
  id: string | null;
  /** `''` = todas as lojas. */
  lojaId: string;
  quantidadeInicial: string;
  quantidadeFinal: string;
  preco: string;
}

export interface AlternativaForm {
  chave: string;
  id: string | null;
  produtoId: string | null;
  produto: ProdutoOpcao | null;
  variacaoId: string | null;
  acrescimo: string;
  ativo: boolean;
}

export interface PosicaoForm {
  chave: string;
  id: string | null;
  componenteId: string | null;
  componente: ProdutoOpcao | null;
  componenteVariacaoId: string | null;
  quantidade: string;
  perdaPct: string;
  rotuloPosicao: string;
  permiteSubstituicao: boolean;
  alternativas: AlternativaForm[];
}

/**
 * Produto relacionado (ERP 8.2.8; F2-B12). `inversa` = o outro já aponta para este **com o tipo gravado**
 * (`tipoGravado`, vem do detalhe; `null` na linha nova): trocar o tipo na grade é excluir e incluir na API, e a inversa
 * do tipo antigo não vale para o novo.
 */
export interface RelacionadoForm {
  chave: string;
  id: string | null;
  relacionadoId: string;
  produto: ProdutoOpcao;
  tipo: TipoRelacaoProduto;
  tipoGravado: TipoRelacaoProduto | null;
  criarInversa: boolean;
  inversa: boolean;
}

/**
 * Vínculo com o fornecedor (ERP 8.2.14; F2-B13). `ultimoCusto` e `ultimaCompraEm` vêm da compra e só são mostrados;
 * `moverVinculo` é a resposta ao 409 do código já ligado a outro produto. Os custos ficam na unidade do produto.
 */
export interface FornecedorForm {
  chave: string;
  id: string | null;
  fornecedorId: string;
  fornecedor: PessoaOpcao;
  codigoFornecedor: string;
  eanFornecedor: string;
  unidadeCompra: string;
  fator: string;
  custoFornecedor: string;
  principal: boolean;
  moverVinculo: boolean;
  ultimoCusto: string | null;
  ultimaCompraEm: string | null;
}

/** Os campos editáveis do lote como vieram do detalhe: o corpo leva só o lote que mudou (F2-B17). */
export interface LoteOriginal {
  lote: string;
  validade: string;
  fabricacao: string;
  fornecedorId: string | null;
  ativo: boolean;
}

/**
 * Lote do bloco Validade (ERP 8.2.12; F2-B17). `estoqueId` = o estoque vinculado da loja escolhida (`''` = todas as
 * lojas); no lote gravado ele não muda (`gravado`), e `rotuloLoja` mostra a loja e o estoque dela (ou o estoque sem
 * loja) que vieram do detalhe. `original` = os campos como vieram (`null` no lote novo). `temMovimento` (do detalhe)
 * tira o "Remover": o lote com histórico só se inativa.
 */
export interface LoteForm {
  chave: string;
  id: string | null;
  estoqueId: string;
  rotuloLoja: string | null;
  gravado: boolean;
  lote: string;
  validade: string;
  fabricacao: string;
  fornecedorId: string | null;
  fornecedor: PessoaOpcao | null;
  ativo: boolean;
  temMovimento: boolean;
  original: LoteOriginal | null;
}

const TEXTOS = [
  'nome',
  'codigoInterno',
  'cest',
  'precoCusto',
  'markupPct',
  'precoVenda',
  'precoAtacado',
  'qtdMinimaAtacado',
  'precoPromocional',
  'promocaoInicio',
  'promocaoFim',
  'precoMenuDigital',
  'precoIfood',
  'precoParcelado',
  'larguraCm',
  'alturaCm',
  'profundidadeCm',
  'pesoG',
  'pesoAbatimentoG',
  'pesoPacoteKg',
  'localizacao',
  'qtdMinimaVenda',
  'material',
  'comissaoPct',
  'descricaoCurta',
  'idadeMinima',
  'vasilhameQuantidade',
  'balancaPlu',
  'balancaValidadeDias',
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
] as const;

const BOOLEANOS = [
  'ativo',
  'permiteFracao',
  'usaFichaTecnica',
  'solicitaPrecoPdv',
  'solicitaLotePdv',
  'generico',
  'usaMenuDigital',
  'insumo',
  'reposicaoRodizio',
  'usaTotem',
  'maisVendido',
  'controlaEstoque',
] as const;

export type ValoresProduto = Record<(typeof TEXTOS)[number], string> &
  Record<(typeof BOOLEANOS)[number], boolean> & {
    tipo: TipoProduto;
    unidadeId: string | null;
    ncm: string | null;
    marcaId: string | null;
    categoriaPrincipalId: string | null;
    categorias: string[];
    grupoPrecoQuantidadeId: string | null;
    vasilhameProdutoId: string | null;
    vasilhame: ProdutoOpcao | null;
    balancaTipo: 'nao_usa' | 'peso' | 'unidade';
    eanId: string | null;
    ean: string;
    eanTipo: 'gtin' | 'interno';
    codigosAdicionais: CodigoForm[];
    lojas: LojaForm[];
    precosQuantidade: FaixaForm[];
    posicoes: PosicaoForm[];
    insumos: PosicaoForm[];
    relacionados: RelacionadoForm[];
    fornecedores: FornecedorForm[];
    lotes: LoteForm[];
    /** A foto (um envio `produto_foto`; F2-B44). */
    fotoPrincipalArquivoId: string | null;
    /** As outras imagens (`produtos_imagens`), os ids dos arquivos na ordem. */
    imagens: string[];
    /** Ids dos lotes gravados que o "Remover" tirou da grade: o corpo os manda excluir (F2-B17). */
    lotesExcluidos: string[];
    /** Colunas que o formulário desta fase não edita, devolvidas como vieram. */
    preservar: Record<string, unknown>;
  };

export function produtoVazio(lojas: ReadonlyArray<{ id: string; nome: string }>, unidadeId: string | null) {
  const v = {
    ...(Object.fromEntries(TEXTOS.map((c) => [c, ''])) as Record<(typeof TEXTOS)[number], string>),
    ...(Object.fromEntries(BOOLEANOS.map((c) => [c, false])) as Record<(typeof BOOLEANOS)[number], boolean>),
    tipo: 'simples' as TipoProduto,
    ativo: true,
    controlaEstoque: true,
    precoCusto: '0,00',
    markupPct: '0',
    unidadeId,
    ncm: null,
    marcaId: null,
    categoriaPrincipalId: null,
    categorias: [],
    grupoPrecoQuantidadeId: null,
    vasilhameProdutoId: null,
    vasilhame: null,
    balancaTipo: 'nao_usa' as const,
    eanId: null,
    ean: '',
    eanTipo: 'gtin' as const,
    codigosAdicionais: [],
    lojas: lojas.map((l) => lojaVazia(l)),
    precosQuantidade: [],
    posicoes: [],
    insumos: [],
    relacionados: [],
    fornecedores: [],
    lotes: [],
    fotoPrincipalArquivoId: null,
    imagens: [],
    lotesExcluidos: [],
    preservar: {},
  };
  return v satisfies ValoresProduto as ValoresProduto;
}

const lojaVazia = (l: { id: string; nome: string }): LojaForm => ({
  lojaId: l.id,
  nome: l.nome,
  existente: false,
  estoqueMinimo: '',
  estoqueMaximo: '',
  precoVenda: '',
  ativoNaLoja: true,
  acrescimoGelada: '',
});

/** Decimal da API ("3.4900") para a tela ("3,49"); `casas` 2 em preço, 3 em quantidade (sem zeros à direita). */
export function decimalParaTela(v: string | null | undefined, casas = 2): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? formatarDecimal(n, casas).replace(/\./g, '') : '';
}

/** Texto da tela → número para cálculo (0 quando vazio/inválido). */
export const numero = (t: string | null | undefined) => lerDecimal(t ?? '') ?? 0;

function dataHoraParaTela(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const CASAS: Partial<Record<(typeof TEXTOS)[number], number>> = {
  qtdMinimaAtacado: 3,
  qtdMinimaVenda: 3,
  markupPct: 4,
  icmsAliquota: 4,
  icmsReducaoBcPct: 4,
  icmsMvaPct: 4,
  icmsAliquotaSt: 4,
  fcpAliquota: 4,
  fcpStAliquota: 4,
  pisAliquota: 4,
  cofinsAliquota: 4,
  ipiAliquota: 4,
  comissaoPct: 4,
  larguraCm: 2,
  alturaCm: 2,
  profundidadeCm: 2,
  pesoG: 3,
  pesoAbatimentoG: 3,
  pesoPacoteKg: 3,
};

const DECIMAIS = new Set<string>([
  'precoCusto',
  'markupPct',
  'precoVenda',
  'precoAtacado',
  'qtdMinimaAtacado',
  'precoPromocional',
  'precoMenuDigital',
  'precoIfood',
  'precoParcelado',
  ...Object.keys(CASAS),
]);

function posicaoParaForm(c: ProdutoDetalhe['componentes'][number]): PosicaoForm {
  return {
    chave: c.id,
    id: c.id,
    componenteId: c.componenteId,
    componente: c.componente,
    componenteVariacaoId: c.componenteVariacaoId,
    quantidade: decimalParaTela(c.quantidade, 3),
    perdaPct: decimalParaTela(c.perdaPct, 4),
    rotuloPosicao: c.rotuloPosicao ?? '',
    permiteSubstituicao: c.permiteSubstituicao,
    alternativas: c.alternativas.map((a) => ({
      chave: a.id,
      id: a.id,
      produtoId: a.produtoId,
      produto: a.produto,
      variacaoId: a.variacaoId,
      acrescimo: decimalParaTela(a.acrescimo),
      ativo: a.ativo,
    })),
  };
}

/**
 * Detalhe da API → formulário. `duplicar` (ERP 8.2, `/produtos/:id/duplicar`): copia os dados sem códigos de
 * barras, sem código interno e sem ids das filhas; os relacionados vêm só neste sentido (a cópia ainda não existe
 * para os outros produtos apontarem para ela), e os fornecedores sem o código e o EAN do fornecedor (eles identificam
 * o produto de origem: o mesmo código no outro produto seria o 409), um por fornecedor e sem o histórico de compra.
 * Os lotes não vão para a cópia: são da mercadoria do produto de origem (o saldo por lote é dele), nem a foto e a
 * galeria (os arquivos são dele).
 */
export function paraValores(
  p: ProdutoDetalhe,
  lojasSessao: ReadonlyArray<{ id: string; nome: string }>,
  duplicar = false,
): ValoresProduto {
  const v = produtoVazio([], p.unidadeId);
  for (const c of TEXTOS) {
    const bruto = (p as unknown as Record<string, unknown>)[c];
    v[c] =
      c === 'promocaoInicio' || c === 'promocaoFim'
        ? dataHoraParaTela(bruto as string | null)
        : DECIMAIS.has(c)
          ? decimalParaTela(bruto as string | null, CASAS[c] ?? 2)
          : bruto === null || bruto === undefined
            ? ''
            : String(bruto);
  }
  for (const c of BOOLEANOS) v[c] = p[c];
  const principal = duplicar ? undefined : p.codigosBarras.find((c) => c.principal);
  const semId = <T extends { id: string | null; chave: string }>(x: T): T =>
    duplicar ? { ...x, id: null, chave: novaChave() } : x;
  const nomesLoja = new Map(lojasSessao.map((l) => [l.id, l.nome]));
  return {
    ...v,
    nome: p.nome,
    tipo: p.tipo,
    codigoInterno: duplicar ? '' : (p.codigoInterno ?? ''),
    unidadeId: p.unidadeId,
    ncm: p.ncm,
    marcaId: p.marcaId,
    categoriaPrincipalId: p.categoriaPrincipalId,
    categorias: p.categorias,
    grupoPrecoQuantidadeId: p.grupoPrecoQuantidadeId,
    vasilhameProdutoId: p.vasilhameProdutoId,
    vasilhame: p.vasilhame,
    balancaTipo: p.balancaTipo,
    eanId: principal?.id ?? null,
    ean: principal?.codigo ?? '',
    eanTipo: principal?.tipo ?? 'gtin',
    codigosAdicionais: duplicar
      ? []
      : p.codigosBarras
          .filter((c) => !c.principal)
          .map((c) => ({
            chave: c.id,
            id: c.id,
            codigo: c.codigo,
            tipo: c.tipo,
            descricao: c.descricao ?? '',
            unidadeId: c.unidadeId,
            fator: decimalParaTela(c.fator, 3),
            preco: decimalParaTela(c.preco),
            usaVenda: c.usaVenda,
            usaCompra: c.usaCompra,
          })),
    lojas: [
      ...lojasSessao.map((l) => {
        const linha = p.lojas.find((x) => x.lojaId === l.id);
        return linha
          ? {
              lojaId: l.id,
              nome: l.nome,
              existente: !duplicar,
              estoqueMinimo: decimalParaTela(linha.estoqueMinimo, 3),
              estoqueMaximo: decimalParaTela(linha.estoqueMaximo, 3),
              precoVenda: decimalParaTela(linha.precoVenda),
              ativoNaLoja: linha.ativoNaLoja,
              acrescimoGelada: decimalParaTela(linha.acrescimoGelada),
            }
          : lojaVazia(l);
      }),
    ],
    precosQuantidade: p.precosQuantidade.map((f) =>
      semId({
        chave: f.id,
        id: f.id,
        lojaId: f.lojaId && nomesLoja.has(f.lojaId) ? f.lojaId : (f.lojaId ?? ''),
        quantidadeInicial: decimalParaTela(f.quantidadeInicial, 3),
        quantidadeFinal: decimalParaTela(f.quantidadeFinal, 3),
        preco: decimalParaTela(f.preco),
      }),
    ),
    posicoes: p.componentes
      .filter((c) => c.tipo === 'kit')
      .map(posicaoParaForm)
      .map((c) => (duplicar ? { ...semId(c), alternativas: c.alternativas.map(semId) } : c)),
    insumos: p.componentes
      .filter((c) => c.tipo === 'ficha_tecnica')
      .map(posicaoParaForm)
      .map(semId),
    relacionados: p.relacionados.map((r) =>
      semId({
        chave: r.id,
        id: r.id,
        relacionadoId: r.relacionadoId,
        produto: r.produto,
        tipo: r.tipo,
        tipoGravado: duplicar ? null : r.tipo,
        criarInversa: false,
        inversa: !duplicar && r.inversa,
      }),
    ),
    // Na cópia, sem o código, dois vínculos do mesmo fornecedor (CX 12 e CX 24) seriam o mesmo: fica o primeiro (o
    // principal vem antes).
    fornecedores: p.fornecedores
      .filter((f, i, todos) => !duplicar || todos.findIndex((x) => x.fornecedorId === f.fornecedorId) === i)
      .map((f) =>
        semId({
          chave: f.id,
          id: f.id,
          fornecedorId: f.fornecedorId,
          fornecedor: f.fornecedor,
          codigoFornecedor: duplicar ? '' : (f.codigoFornecedor ?? ''),
          eanFornecedor: duplicar ? '' : (f.eanFornecedor ?? ''),
          unidadeCompra: f.unidadeCompra ?? '',
          fator: decimalParaTela(f.fator, 3),
          custoFornecedor: decimalParaTela(f.custoFornecedor, 4),
          principal: f.principal,
          moverVinculo: false,
          ultimoCusto: duplicar ? null : f.ultimoCusto,
          ultimaCompraEm: duplicar ? null : f.ultimaCompraEm,
        }),
      ),
    lotes: duplicar
      ? []
      : p.lotes.map((l) => {
          const original = {
            lote: l.lote,
            validade: l.validade ?? '',
            fabricacao: l.fabricacao ?? '',
            fornecedorId: l.fornecedorId,
            ativo: l.ativo,
          };
          return {
            chave: l.id,
            id: l.id,
            estoqueId: l.estoqueId ?? '',
            // A loja e o estoque vinculado em que o lote vale (ERP 8.2.12); o estoque sem loja (depósito antigo) só.
            rotuloLoja: l.estoqueId ? [l.lojaNome, l.estoqueNome].filter(Boolean).join(' · ') || null : null,
            gravado: true,
            ...original,
            fornecedor: l.fornecedor,
            temMovimento: l.temMovimento,
            original,
          };
        }),
    // A cópia sai sem imagens (F2-B44): o arquivo é do produto de origem, e a API recusa o de outro cadastro.
    fotoPrincipalArquivoId: duplicar ? null : p.fotoPrincipalArquivoId,
    imagens: duplicar ? [] : p.imagens.map((i) => i.arquivoId),
    lotesExcluidos: [],
    preservar: {
      descricaoLonga: p.descricaoLonga,
      ibsCbsCst: p.ibsCbsCst,
      servicoCodigoLc116: p.servicoCodigoLc116,
    },
  };
}

const opcional = (t: string) => (t.trim() === '' ? null : t.trim());

/**
 * Formulário → corpo de `POST`/`PUT /api/produtos` (sem a versão). `comFornecedores` = o bloco Fornecedores está
 * visível (`geral.produto_usa_fornecedores`): só então a lista vai, e escondido a API mantém os vínculos gravados.
 */
export function paraCorpo(
  v: ValoresProduto,
  opcoes: { comFornecedores?: boolean } = {},
): Record<string, unknown> {
  const textos = Object.fromEntries(TEXTOS.map((c) => [c, opcional(v[c])]));
  const kit = v.tipo === 'kit';
  const codigosBarras = [
    ...(v.ean.trim() ? [{ id: v.eanId, codigo: v.ean.trim(), tipo: v.eanTipo, principal: true }] : []),
    ...v.codigosAdicionais.map((c) => ({
      id: c.id,
      codigo: c.codigo.trim(),
      tipo: c.tipo,
      principal: false,
      descricao: opcional(c.descricao),
      unidadeId: c.unidadeId,
      fator: c.fator.trim() || '1',
      preco: opcional(c.preco),
      usaVenda: c.usaVenda,
      usaCompra: c.usaCompra,
    })),
  ];
  const componente = (c: PosicaoForm, tipo: 'kit' | 'ficha_tecnica', ordem: number) => ({
    id: c.id,
    tipo,
    componenteId: c.componenteId ?? '',
    componenteVariacaoId: c.componenteVariacaoId,
    quantidade: c.quantidade,
    perdaPct: tipo === 'ficha_tecnica' ? opcional(c.perdaPct) : null,
    rotuloPosicao: tipo === 'kit' ? opcional(c.rotuloPosicao) : null,
    permiteSubstituicao: tipo === 'kit' && c.permiteSubstituicao,
    ordem: ordem + 1,
    alternativas:
      tipo === 'kit'
        ? c.alternativas.map((a, i) => ({
            id: a.id,
            produtoId: a.produtoId ?? '',
            variacaoId: a.variacaoId,
            acrescimo: a.acrescimo.trim() || '0',
            ordem: i + 1,
            ativo: a.ativo,
          }))
        : [],
  });
  return {
    ...v.preservar,
    ...textos,
    nome: v.nome,
    precoCusto: textos.precoCusto ?? '0',
    markupPct: textos.markupPct ?? '0',
    precoVenda: textos.precoVenda ?? '0',
    promocaoInicio: v.promocaoInicio ? new Date(v.promocaoInicio).toISOString() : null,
    promocaoFim: v.promocaoFim ? new Date(v.promocaoFim).toISOString() : null,
    ...Object.fromEntries(BOOLEANOS.map((c) => [c, v[c]])),
    usaFichaTecnica: !kit && v.usaFichaTecnica,
    tipo: v.tipo,
    unidadeId: v.unidadeId ?? '',
    ncm: v.ncm,
    marcaId: v.marcaId,
    categoriaPrincipalId: v.categoriaPrincipalId,
    categorias: v.categorias,
    grupoPrecoQuantidadeId: v.grupoPrecoQuantidadeId,
    vasilhameProdutoId: v.vasilhameProdutoId,
    balancaTipo: v.balancaTipo,
    // Sempre a foto e a galeria inteira (F2-B44): `null`/vazia tiram; a API só mantém quando o campo não vem.
    fotoPrincipalArquivoId: v.fotoPrincipalArquivoId,
    imagens: v.imagens,
    codigosBarras,
    lojas: v.lojas
      .filter(
        (l) =>
          l.existente ||
          !l.ativoNaLoja ||
          [l.estoqueMinimo, l.estoqueMaximo, l.precoVenda, l.acrescimoGelada].some((x) => x.trim() !== ''),
      )
      .map((l) => ({
        lojaId: l.lojaId,
        estoqueMinimo: opcional(l.estoqueMinimo),
        estoqueMaximo: opcional(l.estoqueMaximo),
        precoVenda: opcional(l.precoVenda),
        ativoNaLoja: l.ativoNaLoja,
        acrescimoGelada: opcional(l.acrescimoGelada),
      })),
    precosQuantidade: v.precosQuantidade.map((f) => ({
      id: f.id,
      lojaId: f.lojaId || null,
      quantidadeInicial: f.quantidadeInicial,
      quantidadeFinal: opcional(f.quantidadeFinal),
      preco: f.preco,
    })),
    componentes: kit
      ? v.posicoes.map((c, i) => componente(c, 'kit', i))
      : v.usaFichaTecnica
        ? v.insumos.map((c, i) => componente(c, 'ficha_tecnica', i))
        : [],
    // Sempre a lista inteira (vazia = remove todos): a API só mantém os gravados quando o campo não vem.
    relacionados: v.relacionados.map((r, i) => ({
      id: r.id,
      relacionadoId: r.relacionadoId,
      tipo: r.tipo,
      ordem: i + 1,
      criarInversa: r.criarInversa,
    })),
    ...(opcoes.comFornecedores
      ? {
          fornecedores: v.fornecedores.map((f) => ({
            id: f.id,
            fornecedorId: f.fornecedorId,
            codigoFornecedor: opcional(f.codigoFornecedor),
            eanFornecedor: opcional(f.eanFornecedor),
            unidadeCompra: opcional(f.unidadeCompra),
            fator: f.fator.trim() || '1',
            custoFornecedor: opcional(f.custoFornecedor),
            principal: f.principal,
            moverVinculo: f.moverVinculo,
          })),
        }
      : {}),
    // Só os lotes novos e os alterados, e os excluídos (F2-B17): o gravado que não mudou não vai e a API o mantém,
    // então o teto do corpo vale para o que muda, e não para os lotes do produto (que o recebimento faz crescer). Nada
    // mudou no bloco: o corpo não leva as listas. Os tipos sem saldo próprio não têm o bloco Validade.
    ...(TIPOS_SEM_SALDO_PROPRIO.includes(v.tipo) ? {} : corpoLotes(v)),
  };
}

const loteMudou = (l: LoteForm) =>
  !l.original ||
  l.lote.trim() !== l.original.lote ||
  l.validade !== l.original.validade ||
  l.fabricacao !== l.original.fabricacao ||
  (l.fornecedorId?.toLowerCase() ?? null) !== (l.original.fornecedorId?.toLowerCase() ?? null) ||
  l.ativo !== l.original.ativo;

const chaveLoteForm = (l: LoteForm) =>
  chaveLoteProduto({ estoqueId: l.estoqueId || null, lote: l.lote.trim() });

/**
 * Posições (em `v.lotes`) das linhas que vão no corpo, na ordem da grade: as novas e as alteradas, mais a gravada sem
 * mudança que tem a (loja, lote) de uma delas — com ela no corpo o zod aponta o repetido, e a API não reaproveita em
 * silêncio o lote gravado para a linha nova. `errosParaFormulario` usa as mesmas posições para trazer o erro de volta.
 */
function posicoesLotesDoCorpo(v: ValoresProduto): number[] {
  const mudaram = new Set(v.lotes.flatMap((l, i) => (loteMudou(l) ? [i] : [])));
  const chaves = new Set([...mudaram].map((i) => chaveLoteForm(v.lotes[i]!)));
  return v.lotes.flatMap((l, i) => (mudaram.has(i) || chaves.has(chaveLoteForm(l)) ? [i] : []));
}

function corpoLotes(v: ValoresProduto): Record<string, unknown> {
  const lotes = posicoesLotesDoCorpo(v).map((i) => {
    const l = v.lotes[i]!;
    return {
      id: l.id,
      estoqueId: l.estoqueId || null,
      lote: l.lote.trim(),
      validade: l.validade || null,
      fabricacao: l.fabricacao || null,
      fornecedorId: l.fornecedorId,
      ativo: l.ativo,
    };
  });
  return {
    ...(lotes.length ? { lotes } : {}),
    ...(v.lotesExcluidos.length ? { lotesExcluidos: v.lotesExcluidos } : {}),
  };
}

/** Caminhos de erro do corpo (`codigosBarras.N`, `componentes.N`, `lotes.N`) → campos do formulário. */
export function errosParaFormulario(
  v: ValoresProduto,
  campos: Record<string, string>,
): Record<string, string> {
  const r: Record<string, string> = {};
  const temEan = v.ean.trim() !== '';
  const lista = v.tipo === 'kit' ? 'posicoes' : 'insumos';
  const lotes = posicoesLotesDoCorpo(v);
  /** Linha N do corpo → linha da grade (também o "(linha N)" da mensagem do repetido). */
  const linhaLote = (n: number) => (lotes[n] ?? n) + 1;
  for (const [chave, msg] of Object.entries(campos)) {
    const lt = /^lotes\.(\d+)\.?(.*)$/.exec(chave);
    if (lt) {
      r[`lotes.${linhaLote(Number(lt[1])) - 1}.${lt[2] || 'lote'}`] = msg.replace(
        /\(linha (\d+)\)/,
        (_, n: string) => `(linha ${linhaLote(Number(n) - 1)})`,
      );
      continue;
    }
    // O excluído recusado (com saldo, movimento ou acerto em rascunho) cai acima da grade.
    if (chave === 'lotesExcluidos' || chave.startsWith('lotesExcluidos.')) {
      r.lotes ??= msg;
      continue;
    }
    const cb = /^codigosBarras\.(\d+)\.?(.*)$/.exec(chave);
    if (cb) {
      const i = Number(cb[1]);
      if (temEan && i === 0) r.ean = msg;
      else r[`codigosAdicionais.${i - (temEan ? 1 : 0)}.${cb[2] || 'codigo'}`] = msg;
      continue;
    }
    if (chave === 'codigosBarras') {
      r.ean ??= msg;
      continue;
    }
    // A imagem recusada da galeria (F2-B44: de outro cadastro, enviada de novo) cai no campo da galeria.
    if (chave === 'imagens' || chave.startsWith('imagens.')) {
      r.imagens ??= msg;
      continue;
    }
    if (chave === 'componentes' || chave.startsWith('componentes.')) {
      r[chave.replace(/^componentes/, lista)] = msg;
      continue;
    }
    r[chave] = msg;
  }
  return r;
}
