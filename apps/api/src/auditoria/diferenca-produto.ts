/**
 * Diferença legível do cadastro de produto (ERP 16.2, 17.2; Fase 2, F2-B42; README da API › decisão 188): de `antes` e
 * `depois` da auditoria do produto sai a lista do que mudou, com os rótulos dos campos e as filhas ("Preço de venda:
 * 9,90 → 10,90; EAN adicionado 7891234567895; Loja Centro: Preço de venda 9,90 → 10,90").
 *
 * Três passos, para os nomes saírem numa ida ao banco por página: `diferencasProduto` (puro) compara e devolve os
 * itens; `referenciasDiferencas` junta os ids que aparecem neles (marca, unidade, categoria, produto, loja, pessoa…);
 * `carregarNomes` busca os nomes; `textoDiferencas`/`alteracoesDiferencas` montam o texto e a tabela do "ver diferença
 * completa".
 *
 * **Escopo** (quem lê): o custo (`precoCusto`, `custoMedio`, `markupPct`, o custo do fornecedor; os campos marcados e os
 * de nome com "custo"/"markup", como em `redigirParaVisao`) e o que é de loja (a linha da loja, a faixa de uma loja, o
 * lote de um estoque):
 * - `ESCOPO_GRAVADO` — o texto gravado em `auditoria.descricao` (a tela de auditoria o mostra a todos com
 *   `auditoria.ver`, e o filtro "Histórico" procura nele): o custo só com o rótulo ("Preço de custo: (alterado)") e o que
 *   é de loja num aviso só ("Dados de loja alterados"), sem loja nem valor;
 * - o de quem consulta (`escopoDaSessao`): o custo com os valores só com `produtos.ver_custo` (sem ela, nem o rótulo) e
 *   só as lojas e os estoques permitidos.
 *
 * Só entram os campos presentes **dos dois lados** (o `antes` é o detalhe do produto e o `depois` a linha gravada, que
 * têm campos diferentes: `unidadeSigla`, `grupoPreco`… existem só num deles e não são mudança); na criação (`antes`
 * nulo), os campos preenchidos fora do padrão. Campo desconhecido entra com o nome da chave.
 */
import { chaveFornecedorProduto, ROTULOS_TIPO_PRODUTO, ROTULOS_TIPO_RELACAO } from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { mascararSensiveis } from './mascarar.js';

/** Cadastros citados pelos ids dos campos (o nome vem de `carregarNomes`). */
export const TIPOS_REFERENCIA = [
  'marca',
  'unidade',
  'categoria',
  'produto',
  'variacao',
  'loja',
  'pessoa',
  'grupo',
  'estoque',
] as const;
export type TipoReferencia = (typeof TIPOS_REFERENCIA)[number];

type Formato =
  | 'texto'
  /** Texto comprido (descrição longa) e id sem nome legível: só "alterado", sem os valores. */
  | 'textoLongo'
  | 'dinheiro'
  | 'quantidade'
  | 'pct'
  | 'inteiro'
  | 'booleano'
  | 'data'
  | 'dataHora'
  | 'tipoProduto'
  | 'balanca'
  | 'tipoCodigo'
  | 'alternativas'
  /** Campo desconhecido: o valor como veio (objeto ou lista: só "alterado"). */
  | 'bruto'
  | { ref: TipoReferencia };

interface Campo {
  rotulo: string;
  formato: Formato;
  /** Valor de custo (`produtos.ver_custo`). */
  custo?: boolean;
  /** O valor que a criação não mostra (o padrão do cadastro); sem ele: vazio, zero e `false`. */
  padrao?: unknown;
}

const c = (rotulo: string, formato: Formato, extra: Omit<Campo, 'rotulo' | 'formato'> = {}): Campo => ({
  rotulo,
  formato,
  ...extra,
});
const ref = (r: TipoReferencia): Formato => ({ ref: r });

/** Campos do produto (a ordem é a do formulário). */
const CAMPOS_PRODUTO: Record<string, Campo> = {
  nome: c('Nome', 'texto'),
  tipo: c('Tipo', 'tipoProduto', { padrao: 'simples' }),
  ativo: c('Ativo', 'booleano', { padrao: true }),
  codigoInterno: c('Código interno', 'texto'),
  unidadeId: c('Unidade', ref('unidade')),
  permiteFracao: c('Permite fração', 'booleano'),
  ncm: c('NCM', 'texto'),
  cest: c('CEST', 'texto'),
  precoCusto: c('Preço de custo', 'dinheiro', { custo: true }),
  custoMedio: c('Custo médio', 'dinheiro', { custo: true }),
  markupPct: c('Markup %', 'pct', { custo: true }),
  precoVenda: c('Preço de venda', 'dinheiro'),
  precoAtacado: c('Preço de atacado', 'dinheiro'),
  qtdMinimaAtacado: c('Qtd. mínima atacado', 'quantidade'),
  precoPromocional: c('Preço promocional', 'dinheiro'),
  promocaoInicio: c('Promoção – início', 'dataHora'),
  promocaoFim: c('Promoção – fim', 'dataHora'),
  precoMenuDigital: c('Preço no menu digital', 'dinheiro'),
  precoIfood: c('Preço no iFood', 'dinheiro'),
  precoParcelado: c('Preço parcelado', 'dinheiro'),
  grupoPrecoQuantidadeId: c('Grupo de preço por quantidade', ref('grupo')),
  usaFichaTecnica: c('Usa ficha técnica', 'booleano'),
  larguraCm: c('Largura (cm)', 'quantidade'),
  alturaCm: c('Altura (cm)', 'quantidade'),
  profundidadeCm: c('Profundidade (cm)', 'quantidade'),
  pesoG: c('Peso (g)', 'quantidade'),
  pesoAbatimentoG: c('Peso abatimento (g)', 'quantidade'),
  pesoPacoteKg: c('Peso pacote (kg)', 'quantidade'),
  localizacao: c('Localização', 'texto'),
  qtdMinimaVenda: c('Qtd. mín. venda', 'quantidade'),
  material: c('Material', 'texto'),
  comissaoPct: c('Comissão %', 'pct'),
  marcaId: c('Marca', ref('marca')),
  categoriaPrincipalId: c('Categoria principal', ref('categoria')),
  solicitaPrecoPdv: c('Solicita preço no PDV', 'booleano'),
  solicitaLotePdv: c('Solicita lote no PDV', 'booleano'),
  generico: c('Genérico', 'booleano'),
  usaMenuDigital: c('Usa menu digital', 'booleano'),
  insumo: c('Insumo', 'booleano'),
  reposicaoRodizio: c('Reposição por rodízio', 'booleano'),
  usaTotem: c('Usa totem', 'booleano'),
  maisVendido: c('Mais vendido', 'booleano'),
  descricaoCurta: c('Descrição curta', 'texto'),
  descricaoLonga: c('Descrição longa', 'textoLongo'),
  controlaEstoque: c('Controla estoque', 'booleano', { padrao: true }),
  idadeMinima: c('Idade mínima', 'inteiro'),
  vasilhameProdutoId: c('Vasilhame (casco)', ref('produto')),
  vasilhameQuantidade: c('Cascos por unidade', 'inteiro'),
  balancaTipo: c('Balança', 'balanca', { padrao: 'nao_usa' }),
  balancaPlu: c('PLU da balança', 'inteiro'),
  balancaValidadeDias: c('Validade na balança (dias)', 'inteiro'),
  unidadeTributavelId: c('Unidade tributável', ref('unidade')),
  fatorTributavel: c('Fator tributável', 'quantidade', { padrao: '1' }),
  cfopVendaEstado: c('CFOP dentro do estado', 'texto'),
  cfopVendaForaEstado: c('CFOP fora do estado', 'texto'),
  icmsSituacao: c('ICMS – situação', 'texto'),
  icmsOrigem: c('ICMS – origem', 'texto'),
  icmsModalidadeBc: c('ICMS – modalidade BC', 'texto'),
  icmsModalidadeBcst: c('ICMS – modalidade BC ST', 'texto'),
  icmsAliquota: c('ICMS – alíquota %', 'pct'),
  icmsReducaoBcPct: c('ICMS – redução de BC %', 'pct'),
  icmsMvaPct: c('MVA ST %', 'pct'),
  icmsAliquotaSt: c('ICMS – alíquota ST %', 'pct'),
  fcpAliquota: c('FCP %', 'pct'),
  fcpStAliquota: c('FCP-ST %', 'pct'),
  beneficioFiscalCodigo: c('cBenef', 'texto'),
  pisSituacao: c('PIS – situação', 'texto'),
  pisAliquota: c('PIS – alíquota %', 'pct'),
  cofinsSituacao: c('COFINS – situação', 'texto'),
  cofinsAliquota: c('COFINS – alíquota %', 'pct'),
  ipiSituacao: c('IPI – situação', 'texto'),
  ipiAliquota: c('IPI – alíquota %', 'pct'),
  ipiEnquadramento: c('IPI – enquadramento', 'texto'),
  ibsCbsCst: c('IBS/CBS – situação', 'texto'),
  ibsCbsClassificacao: c('Classificação IBS/CBS', 'texto'),
  servicoCodigoLc116: c('Código do serviço (LC 116)', 'texto'),
  isCst: c('IS – situação', 'texto'),
  isClassificacao: c('IS – classificação', 'texto'),
  isAliquotaPct: c('IS – alíquota %', 'pct'),
  isAliquotaEspecifica: c('IS – alíquota específica', 'dinheiro'),
  isUnidade: c('IS – unidade', 'texto'),
  // Ids sem nome legível no relatório (o arquivo da foto, a impressora): só "(alterado)".
  fotoPrincipalArquivoId: c('Foto principal', 'textoLongo'),
  impressoraDestinoId: c('Impressora de destino', 'textoLongo'),
};

/**
 * Campos que não são mudança do cadastro: a identidade, a versão, os carimbos, o texto de busca e os derivados de
 * outros campos (a sigla da unidade, o EAN principal, o grupo e o vasilhame expandidos, os avisos).
 */
const IGNORADOS_PRODUTO = new Set([
  'id',
  'codigo',
  'versao',
  'busca',
  'criadoEm',
  'atualizadoEm',
  'excluidoEm',
  'criadoPorId',
  'atualizadoPorId',
  'excluidoPorId',
  'atualizadoPorNome',
  'unidadeSigla',
  'ean',
  'grupoPreco',
  'vasilhame',
  'usadoEm',
  'avisos',
  'avisosCombo',
  'temMovimento',
  'lotesExcluidos',
  'confirmarEanDuplicado',
]);

type Item = Record<string, unknown>;

/** Uma parte do texto: literal ou valor formatado (os ids viram nome em `carregarNomes`). */
type Parte = string | { valor: unknown; formato: Formato };

/** Uma filha do produto (sub-tabela, MD 3.6): como achar a mesma linha dos dois lados e como nomeá-la. */
interface Filha {
  chave: string;
  rotulo: (i: Item) => string;
  /** Gênero do rótulo ("adicionado"/"adicionada"). */
  genero: 'o' | 'a';
  /** A chave natural da linha (a mesma dos dois lados). */
  id: (i: Item) => string;
  identificacao: (i: Item) => Parte[];
  campos: Record<string, Campo>;
  /** Campos mostrados na linha adicionada ou removida (sem os de custo e os vazios). */
  resumo: string[];
  /** A loja ou o estoque da linha (o que é de loja, para o escopo); nulo = de todas as lojas. */
  escopo?: (i: Item) => { loja?: string | null; estoque?: string | null };
  /** Campos da chave natural (mudar um deles = remover uma linha e adicionar outra) e os imutáveis. */
  ignorar: string[];
}

const txt = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

const FILHAS: Filha[] = [
  {
    chave: 'codigosBarras',
    rotulo: (i) => (i.tipo === 'interno' ? 'Código de barras interno' : 'EAN'),
    genero: 'o',
    id: (i) => txt(i.codigo),
    identificacao: (i) => [txt(i.codigo)],
    campos: {
      tipo: c('Tipo do código', 'tipoCodigo'),
      principal: c('Principal', 'booleano'),
      descricao: c('Descrição', 'texto'),
      unidadeId: c('Unidade da embalagem', ref('unidade')),
      fator: c('Fator', 'quantidade'),
      preco: c('Preço da embalagem', 'dinheiro'),
      usaVenda: c('Venda', 'booleano'),
      usaCompra: c('Compra', 'booleano'),
    },
    resumo: [],
    ignorar: ['codigo'],
  },
  {
    chave: 'lojas',
    rotulo: () => 'Loja',
    genero: 'a',
    id: (i) => txt(i.lojaId).toLowerCase(),
    identificacao: (i) => [{ valor: i.lojaId, formato: ref('loja') }],
    campos: {
      precoVenda: c('Preço de venda', 'dinheiro'),
      estoqueMinimo: c('Estoque mínimo', 'quantidade'),
      estoqueMaximo: c('Estoque máximo', 'quantidade'),
      ativoNaLoja: c('Ativo na loja', 'booleano', { padrao: true }),
      acrescimoGelada: c('Acréscimo gelada', 'dinheiro'),
    },
    resumo: ['precoVenda', 'estoqueMinimo', 'estoqueMaximo', 'ativoNaLoja', 'acrescimoGelada'],
    escopo: (i) => ({ loja: txt(i.lojaId) || null }),
    ignorar: ['lojaId'],
  },
  {
    chave: 'precosQuantidade',
    rotulo: () => 'Faixa de preço',
    genero: 'a',
    id: (i) => `${txt(i.lojaId).toLowerCase()}|${num(i.quantidadeInicial)}`,
    identificacao: (i) => [
      'a partir de ',
      { valor: i.quantidadeInicial, formato: 'quantidade' },
      ...(i.lojaId
        ? [' na loja ', { valor: i.lojaId, formato: ref('loja') } as Parte]
        : [' em todas as lojas']),
    ],
    campos: {
      quantidadeFinal: c('Qtd final', 'quantidade'),
      preco: c('Preço', 'dinheiro'),
    },
    resumo: ['preco', 'quantidadeFinal'],
    escopo: (i) => ({ loja: txt(i.lojaId) || null }),
    ignorar: ['lojaId', 'quantidadeInicial'],
  },
  {
    chave: 'componentes',
    rotulo: (i) => (i.tipo === 'ficha_tecnica' ? 'Insumo da ficha técnica' : 'Componente do combo'),
    genero: 'o',
    id: (i) =>
      `${txt(i.tipo)}|${txt(i.componenteId).toLowerCase()}|${txt(i.componenteVariacaoId).toLowerCase()}`,
    identificacao: (i) => [
      { valor: i.componenteId, formato: ref('produto') },
      ...(i.componenteVariacaoId
        ? [' · ', { valor: i.componenteVariacaoId, formato: ref('variacao') } as Parte]
        : []),
    ],
    campos: {
      quantidade: c('Qtd', 'quantidade'),
      perdaPct: c('Perda %', 'pct'),
      rotuloPosicao: c('Posição', 'texto'),
      permiteSubstituicao: c('Permite troca', 'booleano'),
      ordem: c('Ordem', 'inteiro'),
      alternativas: c('Alternativas', 'alternativas'),
    },
    resumo: ['quantidade'],
    ignorar: ['tipo', 'componenteId', 'componenteVariacaoId'],
  },
  {
    chave: 'relacionados',
    rotulo: () => 'Relacionado',
    genero: 'o',
    id: (i) => `${txt(i.relacionadoId).toLowerCase()}|${txt(i.tipo)}`,
    identificacao: (i) => [
      { valor: i.relacionadoId, formato: ref('produto') },
      ` (${ROTULOS_TIPO_RELACAO[i.tipo as keyof typeof ROTULOS_TIPO_RELACAO] ?? txt(i.tipo)})`,
    ],
    campos: { ordem: c('Ordem', 'inteiro') },
    resumo: [],
    ignorar: ['relacionadoId', 'tipo'],
  },
  {
    chave: 'fornecedores',
    rotulo: () => 'Fornecedor',
    genero: 'o',
    id: (i) =>
      chaveFornecedorProduto({
        fornecedorId: txt(i.fornecedorId),
        codigoFornecedor: (i.codigoFornecedor as string | null) ?? null,
      }),
    identificacao: (i) => [
      { valor: i.fornecedorId, formato: ref('pessoa') },
      ...(i.codigoFornecedor ? [` (código "${txt(i.codigoFornecedor)}")`] : []),
    ],
    campos: {
      eanFornecedor: c('EAN do fornecedor', 'texto'),
      unidadeCompra: c('Unidade de compra', 'texto'),
      fator: c('Fator', 'quantidade'),
      custoFornecedor: c('Custo do fornecedor', 'dinheiro', { custo: true }),
      ultimoCusto: c('Último custo', 'dinheiro', { custo: true }),
      ultimaCompraEm: c('Última compra', 'data'),
      principal: c('Principal', 'booleano'),
    },
    resumo: ['unidadeCompra', 'fator', 'custoFornecedor'],
    ignorar: ['fornecedorId', 'codigoFornecedor'],
  },
  {
    chave: 'lotes',
    rotulo: () => 'Lote',
    genero: 'o',
    id: (i) => txt(i.id).toLowerCase(),
    identificacao: (i) => [
      txt(i.lote),
      ...(i.estoqueId ? [' (', { valor: i.estoqueId, formato: ref('estoque') } as Parte, ')'] : []),
    ],
    campos: {
      lote: c('Lote', 'texto'),
      validade: c('Validade', 'data'),
      fabricacao: c('Fabricação', 'data'),
      fornecedorId: c('Fornecedor', ref('pessoa')),
      ativo: c('Ativo', 'booleano', { padrao: true }),
    },
    resumo: ['validade', 'fabricacao', 'fornecedorId'],
    escopo: (i) => ({ estoque: txt(i.estoqueId) || null }),
    ignorar: ['estoqueId'],
  },
  {
    // A galeria (8.2.6; F2-B44): o arquivo não tem nome legível; a posição identifica a imagem no texto.
    chave: 'imagens',
    rotulo: () => 'Imagem da galeria',
    genero: 'a',
    id: (i) => txt(i.arquivoId).toLowerCase(),
    identificacao: (i) => [`(posição ${txt(i.ordem)})`],
    campos: { ordem: c('Posição', 'inteiro') },
    resumo: [],
    ignorar: ['arquivoId'],
  },
];

/** Campos de qualquer filha que não são mudança (a identidade e os nomes expandidos, as marcas de tela). */
const IGNORADOS_FILHA = [
  'id',
  'componente',
  'produto',
  'fornecedor',
  'inversa',
  'criarInversa',
  'moverVinculo',
  'estoqueNome',
  'lojaNome',
  'temMovimento',
];

// ---------------------------------------------------------------- Itens

export type ItemDiferenca =
  /** Campo do produto alterado (ou preenchido na criação, com `antes` indefinido). */
  | { tipo: 'campo'; chave: string; campo: Campo; antes: unknown; depois: unknown; criacao: boolean }
  | { tipo: 'filha'; filha: Filha; acao: 'adicionado' | 'removido'; item: Item }
  | {
      tipo: 'filha';
      filha: Filha;
      acao: 'alterado';
      item: Item;
      campos: Array<{ chave: string; campo: Campo; antes: unknown; depois: unknown }>;
    }
  /** Categoria (a lista é de ids). */
  | { tipo: 'categoria'; acao: 'adicionado' | 'removido'; id: string };

const vazio = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function formatoNumerico(f: Formato): boolean {
  return f === 'dinheiro' || f === 'quantidade' || f === 'pct' || f === 'inteiro';
}

/** Mesma coisa nos dois lados (o detalhe traz `"9.9000"` e o corpo `"9.9"`; nulo = vazio). */
function iguais(f: Formato, a: unknown, b: unknown): boolean {
  if (vazio(a) && vazio(b)) return true;
  if (vazio(a) || vazio(b)) return false;
  if (formatoNumerico(f)) return Number(a) === Number(b);
  if (f === 'alternativas') return chaveAlternativas(a) === chaveAlternativas(b);
  if (f === 'data' || f === 'dataHora') {
    const ta = Date.parse(String(a));
    const tb = Date.parse(String(b));
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  }
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** As alternativas do combo, sem a ordem da lista nem os nomes expandidos. */
function chaveAlternativas(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v
    .map((a: Item) =>
      [
        txt(a.produtoId).toLowerCase(),
        txt(a.variacaoId).toLowerCase(),
        num(a.acrescimo),
        a.ativo !== false,
      ].join(':'),
    )
    .sort()
    .join('|');
}

/** O valor que a criação não mostra: o padrão do campo, ou vazio/zero/`false`. */
function noPadrao(campo: Campo, v: unknown): boolean {
  if (campo.padrao !== undefined) return iguais(campo.formato, v, campo.padrao);
  if (vazio(v) || v === false) return true;
  return formatoNumerico(campo.formato) && Number(v) === 0;
}

/** Rótulo de uma chave fora do catálogo: `campoNovo`/`campo_novo` → "Campo novo". */
function rotuloDesconhecido(chave: string): string {
  const s = chave
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CUSTO = /(custo|markup)/i;

function campoDe(catalogo: Record<string, Campo>, chave: string): Campo {
  const conhecido = catalogo[chave];
  if (conhecido) return conhecido;
  return { rotulo: rotuloDesconhecido(chave), formato: 'bruto', custo: CUSTO.test(chave) };
}

const objeto = (v: unknown): v is Item => v !== null && typeof v === 'object' && !Array.isArray(v);

function camposAlterados(
  catalogo: Record<string, Campo>,
  ignorados: Set<string>,
  a: Item,
  b: Item,
): Array<{ chave: string; campo: Campo; antes: unknown; depois: unknown }> {
  const r: Array<{ chave: string; campo: Campo; antes: unknown; depois: unknown }> = [];
  const chaves = [...new Set([...Object.keys(catalogo), ...Object.keys(a), ...Object.keys(b)])];
  for (const chave of chaves) {
    if (ignorados.has(chave) || !(chave in a) || !(chave in b)) continue;
    const campo = campoDe(catalogo, chave);
    if (!iguais(campo.formato, a[chave], b[chave]))
      r.push({ chave, campo, antes: a[chave], depois: b[chave] });
  }
  return r;
}

/**
 * Compara `antes` e `depois` (como estão gravados em jsonb: sem `Date`, os decimais em texto). `antes` nulo = a
 * criação. Puro: os nomes dos cadastros citados vêm depois (`referenciasDiferencas`).
 */
export function diferencasProduto(antes: unknown, depois: unknown): ItemDiferenca[] {
  const a = objeto(antes) ? antes : null;
  const b = objeto(depois) ? depois : null;
  if (!b) return [];
  const itens: ItemDiferenca[] = [];
  const filhas = new Set([...FILHAS.map((f) => f.chave), 'categorias']);

  // Campos do produto.
  if (a) {
    for (const x of camposAlterados(CAMPOS_PRODUTO, new Set([...IGNORADOS_PRODUTO, ...filhas]), a, b))
      itens.push({ tipo: 'campo', ...x, criacao: false });
  } else {
    const chaves = [...new Set([...Object.keys(CAMPOS_PRODUTO), ...Object.keys(b)])];
    for (const chave of chaves) {
      if (IGNORADOS_PRODUTO.has(chave) || filhas.has(chave) || !(chave in b)) continue;
      const campo = campoDe(CAMPOS_PRODUTO, chave);
      if (!noPadrao(campo, b[chave]))
        itens.push({ tipo: 'campo', chave, campo, antes: undefined, depois: b[chave], criacao: true });
    }
  }

  // Filhas: só quando a lista está do lado de depois (e do de antes, na alteração).
  for (const f of FILHAS) {
    if (!Array.isArray(b[f.chave]) || (a && !Array.isArray(a[f.chave]))) continue;
    const lista = (v: unknown) => (Array.isArray(v) ? v.filter(objeto) : []);
    const de = new Map(lista(a?.[f.chave]).map((i) => [f.id(i), i]));
    const para = new Map(lista(b[f.chave]).map((i) => [f.id(i), i]));
    for (const [id, item] of de)
      if (!para.has(id)) itens.push({ tipo: 'filha', filha: f, acao: 'removido', item });
    for (const [id, item] of para) {
      const anterior = de.get(id);
      if (!anterior) itens.push({ tipo: 'filha', filha: f, acao: 'adicionado', item });
      else {
        const campos = camposAlterados(f.campos, new Set([...IGNORADOS_FILHA, ...f.ignorar]), anterior, item);
        if (campos.length) itens.push({ tipo: 'filha', filha: f, acao: 'alterado', item, campos });
      }
    }
  }

  // Categorias (ids).
  if (Array.isArray(b.categorias) && (!a || Array.isArray(a.categorias))) {
    const de = new Set(((a?.categorias as unknown[]) ?? []).map((x) => txt(x).toLowerCase()));
    const para = new Set((b.categorias as unknown[]).map((x) => txt(x).toLowerCase()));
    for (const id of de) if (!para.has(id)) itens.push({ tipo: 'categoria', acao: 'removido', id });
    for (const id of para) if (!de.has(id)) itens.push({ tipo: 'categoria', acao: 'adicionado', id });
  }
  return itens;
}

// ---------------------------------------------------------------- Escopo

/**
 * Quem lê o texto. `custo`: `valores` (com `produtos.ver_custo`), `rotulo` (o texto gravado: "Preço de custo:
 * (alterado)") ou `oculto`. `lojas`/`estoques`: os permitidos (`null` = todos) ou `resumo` (o texto gravado: um aviso
 * "Dados de loja alterados", sem loja nem valor).
 */
export interface EscopoDiferenca {
  custo: 'valores' | 'rotulo' | 'oculto';
  lojas: readonly string[] | null | 'resumo';
  estoques: readonly string[] | null | 'resumo';
}

/** O texto de `auditoria.descricao` (lido por todos com `auditoria.ver` e pelo filtro "Histórico"). */
export const ESCOPO_GRAVADO: EscopoDiferenca = { custo: 'rotulo', lojas: 'resumo', estoques: 'resumo' };

/** O escopo de quem consulta: o custo com `produtos.ver_custo`, as lojas e os estoques permitidos. */
export function escopoDaSessao(s: {
  permissoes: { has(p: string): boolean };
  lojas: readonly string[] | null;
  estoques: readonly string[] | null;
}): EscopoDiferenca {
  return {
    custo: s.permissoes.has('produtos.ver_custo') ? 'valores' : 'oculto',
    lojas: s.lojas,
    estoques: s.estoques,
  };
}

const ehCusto = (campo: Campo) => campo.custo === true;

/** A linha é de uma loja/estoque: `visivel` = permitida; `resumo` = vai para o aviso "Dados de loja alterados". */
function escopoDoItem(f: Filha, item: Item, e: EscopoDiferenca): 'visivel' | 'oculto' | 'resumo' {
  const x = f.escopo?.(item);
  if (!x) return 'visivel';
  const confere = (id: string | null | undefined, lista: EscopoDiferenca['lojas']) => {
    if (id === null || id === undefined) return 'visivel' as const;
    if (lista === 'resumo') return 'resumo' as const;
    if (lista === null) return 'visivel' as const;
    return lista.some((l) => l.toLowerCase() === id.toLowerCase())
      ? ('visivel' as const)
      : ('oculto' as const);
  };
  if ('loja' in x) return confere(x.loja, e.lojas);
  return confere(x.estoque, e.estoques);
}

/**
 * Os itens que o escopo deixa ver: sem o custo (oculto), sem as lojas fora das permitidas; no texto gravado, os de loja
 * saem e o `resumoLoja` diz que houve algum.
 */
function noEscopo(
  itens: readonly ItemDiferenca[],
  e: EscopoDiferenca,
): { itens: ItemDiferenca[]; resumoLoja: boolean } {
  let resumoLoja = false;
  const r: ItemDiferenca[] = [];
  for (const it of itens) {
    if (it.tipo === 'campo') {
      if (ehCusto(it.campo) && e.custo === 'oculto') continue;
      r.push(it);
      continue;
    }
    if (it.tipo === 'categoria') {
      r.push(it);
      continue;
    }
    const onde = escopoDoItem(it.filha, it.item, e);
    if (onde === 'oculto') continue;
    if (onde === 'resumo') {
      resumoLoja = true;
      continue;
    }
    if (it.acao === 'alterado') {
      const campos = it.campos.filter((x) => !(ehCusto(x.campo) && e.custo === 'oculto'));
      if (campos.length) r.push({ ...it, campos });
      continue;
    }
    r.push(it);
  }
  return { itens: r, resumoLoja };
}

// ---------------------------------------------------------------- Nomes

export type Referencias = Record<TipoReferencia, Set<string>>;
export type Nomes = Partial<Record<TipoReferencia, Map<string, string>>>;

function partesDe(it: ItemDiferenca): Array<{ valor: unknown; formato: Formato }> {
  const valores: Array<{ valor: unknown; formato: Formato }> = [];
  const p = (partes: Parte[]) => {
    for (const x of partes) if (typeof x !== 'string') valores.push(x);
  };
  if (it.tipo === 'campo') {
    valores.push(
      { valor: it.antes, formato: it.campo.formato },
      { valor: it.depois, formato: it.campo.formato },
    );
  } else if (it.tipo === 'categoria') {
    valores.push({ valor: it.id, formato: ref('categoria') });
  } else {
    p(it.filha.identificacao(it.item));
    if (it.acao === 'alterado')
      for (const x of it.campos)
        valores.push(
          { valor: x.antes, formato: x.campo.formato },
          { valor: x.depois, formato: x.campo.formato },
        );
    else
      for (const k of it.filha.resumo) {
        const campo = it.filha.campos[k];
        if (campo) valores.push({ valor: it.item[k], formato: campo.formato });
      }
  }
  return valores;
}

/** Os ids citados pelos itens (no escopo de quem lê), por cadastro, para `carregarNomes`. */
export function referenciasDiferencas(
  itens: readonly ItemDiferenca[],
  e: EscopoDiferenca,
  junto: Referencias = referenciasVazias(),
): Referencias {
  for (const it of noEscopo(itens, e).itens)
    for (const { valor, formato } of partesDe(it)) {
      if (typeof formato === 'object' && !vazio(valor)) junto[formato.ref].add(txt(valor).toLowerCase());
      if (formato === 'alternativas' && Array.isArray(valor))
        for (const a of valor as Item[]) {
          if (a.produtoId) junto.produto.add(txt(a.produtoId).toLowerCase());
          if (a.variacaoId) junto.variacao.add(txt(a.variacaoId).toLowerCase());
        }
    }
  return junto;
}

export const referenciasVazias = (): Referencias =>
  Object.fromEntries(TIPOS_REFERENCIA.map((t) => [t, new Set<string>()])) as unknown as Referencias;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Os nomes dos cadastros citados (também os excluídos: o histórico cita o que existia), uma consulta por cadastro. */
export async function carregarNomes(db: DbEmpresa, refs: Referencias): Promise<Nomes> {
  const consultas: Record<TipoReferencia, (ids: string) => ReturnType<typeof sql>> = {
    marca: (ids) => sql`select id, descricao as nome from marcas where id = any(${ids}::uuid[])`,
    unidade: (ids) => sql`select id, sigla as nome from unidades_medida where id = any(${ids}::uuid[])`,
    categoria: (ids) => sql`select id, caminho_nomes as nome from categorias where id = any(${ids}::uuid[])`,
    produto: (ids) =>
      sql`select id, codigo::text || ' - ' || nome as nome from produtos where id = any(${ids}::uuid[])`,
    variacao: (ids) => sql`select id, nome from produtos_variacoes where id = any(${ids}::uuid[])`,
    loja: (ids) => sql`select id, nome from lojas where id = any(${ids}::uuid[])`,
    pessoa: (ids) => sql`select id, nome from pessoas where id = any(${ids}::uuid[])`,
    grupo: (ids) => sql`select id, nome from grupos_preco_quantidade where id = any(${ids}::uuid[])`,
    estoque: (ids) => sql`select id, nome from estoques where id = any(${ids}::uuid[])`,
  };
  const nomes: Nomes = {};
  for (const tipo of TIPOS_REFERENCIA) {
    const ids = [...refs[tipo]].filter((id) => UUID.test(id));
    if (!ids.length) continue;
    const { rows } = await db.execute<{ id: string; nome: string }>(consultas[tipo](`{${ids.join(',')}}`));
    nomes[tipo] = new Map(rows.map((r) => [r.id.toLowerCase(), r.nome]));
  }
  return nomes;
}

// ---------------------------------------------------------------- Texto

const FUSO = 'America/Sao_Paulo';
const dinheiro = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const quantidade = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const pct = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const ROTULOS_BALANCA: Record<string, string> = { nao_usa: 'Não usa', peso: 'Peso', unidade: 'Unidade' };
const ROTULOS_TIPO_CODIGO: Record<string, string> = { gtin: 'EAN', interno: 'Interno' };

/** O valor como o usuário lê ("9,90", "Sim", "03/11/2026", o nome da marca); vazio = "—". */
export function formatarValor(valor: unknown, formato: Formato, nomes: Nomes): string {
  if (vazio(valor)) return '—';
  if (typeof formato === 'object') {
    const id = txt(valor).toLowerCase();
    return nomes[formato.ref]?.get(id) ?? '(não encontrado)';
  }
  const n = Number(valor);
  switch (formato) {
    case 'dinheiro':
      return Number.isFinite(n) ? dinheiro.format(n) : txt(valor);
    case 'quantidade':
      return Number.isFinite(n) ? quantidade.format(n) : txt(valor);
    case 'pct':
      return Number.isFinite(n) ? pct.format(n) : txt(valor);
    case 'inteiro':
      return txt(valor);
    case 'booleano':
      return valor === true || valor === 'true' ? 'Sim' : 'Não';
    case 'data': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(txt(valor));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : txt(valor);
    }
    case 'dataHora': {
      const t = Date.parse(txt(valor));
      return Number.isNaN(t) ? txt(valor) : dataHora.format(new Date(t)).replace(',', '');
    }
    case 'tipoProduto':
      return ROTULOS_TIPO_PRODUTO[valor as keyof typeof ROTULOS_TIPO_PRODUTO] ?? txt(valor);
    case 'balanca':
      return ROTULOS_BALANCA[txt(valor)] ?? txt(valor);
    case 'tipoCodigo':
      return ROTULOS_TIPO_CODIGO[txt(valor)] ?? txt(valor);
    case 'alternativas':
      return Array.isArray(valor)
        ? (valor as Item[])
            .map((a) => formatarValor(a.produtoId, ref('produto'), nomes))
            .sort((x, y) => x.localeCompare(y, 'pt-BR'))
            .join(', ')
        : '—';
    case 'textoLongo':
      return txt(valor);
    case 'bruto':
      if (typeof valor === 'boolean') return valor ? 'Sim' : 'Não';
      if (typeof valor === 'object') return '(lista ou objeto)';
      return txt(valor);
    default:
      return txt(valor);
  }
}

const juntar = (partes: Parte[], nomes: Nomes) =>
  partes.map((x) => (typeof x === 'string' ? x : formatarValor(x.valor, x.formato, nomes))).join('');

/** Só o rótulo, sem os valores: o custo no texto gravado, o texto comprido e o objeto desconhecido. */
const semValores = (campo: Campo, e: EscopoDiferenca, a: unknown, b: unknown) =>
  (ehCusto(campo) && e.custo !== 'valores') ||
  campo.formato === 'textoLongo' ||
  (campo.formato === 'bruto' && (typeof a === 'object' || typeof b === 'object') && !(vazio(a) && vazio(b)));

/**
 * "Preço de venda: 9,90 → 10,90" (na criação, "Preço de venda: 10,90"); sem os valores, "Preço de custo: (alterado)".
 */
function textoCampo(
  x: { campo: Campo; antes: unknown; depois: unknown },
  e: EscopoDiferenca,
  nomes: Nomes,
  separador: string,
  criacao = false,
): string {
  if (semValores(x.campo, e, x.antes, x.depois))
    return `${x.campo.rotulo}${separador}(${criacao ? 'preenchido' : 'alterado'})`;
  const depois = formatarValor(x.depois, x.campo.formato, nomes);
  if (criacao) return `${x.campo.rotulo}${separador}${depois}`;
  return `${x.campo.rotulo}${separador}${formatarValor(x.antes, x.campo.formato, nomes)} → ${depois}`;
}

/** O resumo da filha adicionada/removida ("Preço de venda 10,90, Estoque mínimo 6"), sem custo fora do escopo. */
function resumoFilha(f: Filha, item: Item, e: EscopoDiferenca, nomes: Nomes): string {
  return f.resumo
    .map((k) => ({ k, campo: f.campos[k]! }))
    .filter(({ k, campo }) => !noPadrao(campo, item[k]) && !(ehCusto(campo) && e.custo !== 'valores'))
    .map(({ k, campo }) => `${campo.rotulo} ${formatarValor(item[k], campo.formato, nomes)}`)
    .join(', ');
}

/**
 * Os trechos de custo do texto gravado (`ESCOPO_GRAVADO`), como expressão regular do PostgreSQL (e do JavaScript, no
 * teste): o rótulo com "custo"/"markup" seguido de "(alterado)"/"(preenchido)" — "Preço de custo: (alterado)",
 * "Markup %: (preenchido)", "Custo do fornecedor (alterado)" dentro da filha. O texto gravado nunca traz o valor do
 * custo, só esse rótulo; o filtro "Histórico" os tira da busca de quem não tem `produtos.ver_custo` (decisão 188).
 */
export const TRECHO_CUSTO_GRAVADO = '[^;,:]*(custo|markup)[^;,:]*:? \\((alterado|preenchido)\\)';

/** O aviso do que é de loja no texto gravado (o filtro "Histórico" o ignora para quem tem lojas restritas). */
export const RESUMO_LOJA = 'Dados de loja alterados';

/**
 * O texto legível ("Preço de venda: 9,90 → 10,90; EAN adicionado 7891234567895; Marca: — → HEINEKEN"), no escopo de
 * quem lê. Vazio quando nada visível mudou.
 */
export function textoDiferencas(itens: readonly ItemDiferenca[], nomes: Nomes, e: EscopoDiferenca): string {
  const { itens: visiveis, resumoLoja } = noEscopo(itens, e);
  const partes: string[] = [];
  for (const it of visiveis) {
    if (it.tipo === 'campo') partes.push(textoCampo(it, e, nomes, ': ', it.criacao));
    else if (it.tipo === 'categoria')
      partes.push(
        `Categoria ${it.acao === 'adicionado' ? 'adicionada' : 'removida'} ${formatarValor(it.id, ref('categoria'), nomes)}`,
      );
    else {
      const ident = juntar(it.filha.identificacao(it.item), nomes);
      const rotulo = it.filha.rotulo(it.item);
      if (it.acao === 'alterado')
        partes.push(`${rotulo} ${ident}: ${it.campos.map((x) => textoCampo(x, e, nomes, ' ')).join(', ')}`);
      else {
        const resumo = it.acao === 'adicionado' ? resumoFilha(it.filha, it.item, e, nomes) : '';
        partes.push(
          `${rotulo} ${it.acao.slice(0, -1)}${it.filha.genero} ${ident}${resumo ? ` (${resumo})` : ''}`,
        );
      }
    }
  }
  if (resumoLoja) partes.push(RESUMO_LOJA);
  return partes.join('; ');
}

/** Uma linha da tabela do "ver diferença completa". */
export interface AlteracaoCampo {
  campo: string;
  antes: string;
  depois: string;
}

/**
 * A tabela do "ver diferença completa": um campo por linha (a filha alterada, um por campo: "Loja Centro › Preço de
 * venda"), no escopo de quem lê.
 */
export function alteracoesDiferencas(
  itens: readonly ItemDiferenca[],
  nomes: Nomes,
  e: EscopoDiferenca,
): AlteracaoCampo[] {
  const { itens: visiveis, resumoLoja } = noEscopo(itens, e);
  const r: AlteracaoCampo[] = [];
  const valores = (x: { campo: Campo; antes: unknown; depois: unknown }) =>
    semValores(x.campo, e, x.antes, x.depois)
      ? { antes: x.antes === undefined ? '—' : '(alterado)', depois: '(alterado)' }
      : {
          antes: x.antes === undefined ? '—' : formatarValor(x.antes, x.campo.formato, nomes),
          depois: formatarValor(x.depois, x.campo.formato, nomes),
        };
  for (const it of visiveis) {
    if (it.tipo === 'campo') r.push({ campo: it.campo.rotulo, ...valores(it) });
    else if (it.tipo === 'categoria') {
      const nome = formatarValor(it.id, ref('categoria'), nomes);
      r.push({
        campo: `Categoria ${nome}`,
        antes: it.acao === 'adicionado' ? '—' : 'Vinculada',
        depois: it.acao === 'adicionado' ? 'Vinculada' : 'Removida',
      });
    } else {
      const titulo = `${it.filha.rotulo(it.item)} ${juntar(it.filha.identificacao(it.item), nomes)}`;
      if (it.acao === 'alterado')
        for (const x of it.campos) r.push({ campo: `${titulo} › ${x.campo.rotulo}`, ...valores(x) });
      else {
        const resumo = resumoFilha(it.filha, it.item, e, nomes);
        const genero = it.filha.genero;
        r.push(
          it.acao === 'adicionado'
            ? { campo: titulo, antes: '—', depois: resumo || `Adicionad${genero}` }
            : { campo: titulo, antes: resumo || `Existia`, depois: `Removid${genero}` },
        );
      }
    }
  }
  if (resumoLoja) r.push({ campo: RESUMO_LOJA, antes: '(alterado)', depois: '(alterado)' });
  return r;
}

/** Limite do texto gravado em `auditoria.descricao` (o "ver diferença completa" recalcula tudo de `antes`/`depois`). */
export const LIMITE_DESCRICAO = 2000;

/**
 * O texto de `auditoria.descricao` da gravação do produto (ERP 16.2: "A edição de produto passa a gravar a descricao
 * legível"), no escopo gravado (sem os valores de custo e sem o que é de loja). `antes`/`depois` como vão para a
 * auditoria (normalizados aqui como o jsonb os guarda). Nulo quando nada mudou.
 */
export async function descricaoGravacaoProduto(
  db: DbEmpresa,
  antes: unknown,
  depois: unknown,
): Promise<string | null> {
  // Como o jsonb guarda (`mascararSensiveis`: as datas em ISO, os segredos mascarados).
  const json = (v: unknown) =>
    v === null || v === undefined ? null : (JSON.parse(JSON.stringify(mascararSensiveis(v))) as unknown);
  // O texto é acessório: um dado inesperado no formatador não impede a gravação (o relatório remonta o texto na
  // leitura, do `antes`/`depois`). A consulta dos nomes fica fora do `try`: o erro de banco aborta a transação.
  let itens: ItemDiferenca[];
  let refs: Referencias;
  try {
    itens = diferencasProduto(json(antes), json(depois));
    refs = referenciasDiferencas(itens, ESCOPO_GRAVADO);
  } catch {
    return null;
  }
  if (!itens.length) return null;
  const nomes = await carregarNomes(db, refs);
  let texto: string;
  try {
    texto = textoDiferencas(itens, nomes, ESCOPO_GRAVADO);
  } catch {
    return null;
  }
  if (!texto) return null;
  return texto.length > LIMITE_DESCRICAO ? `${texto.slice(0, LIMITE_DESCRICAO - 1)}…` : texto;
}
