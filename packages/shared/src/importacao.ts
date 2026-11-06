/**
 * Importação de produtos e clientes por planilha (ERP 8.5, 8.6, 23 questão 14): o layout é o da nossa exportação
 * ("ida e volta") e cada coluna também aceita os nomes usados pelas exportações/relatórios do Nuvem3 (cabeçalhos
 * comparados sem acento, caixa, espaços e pontuação). Colunas desconhecidas são ignoradas e listadas na prévia.
 */
import { z } from 'zod';
import { dec } from './decimal.js';
import { dataContagemSchema } from './estoque.js';

export const TIPOS_IMPORTACAO = ['produtos', 'clientes'] as const;
export type TipoImportacao = (typeof TIPOS_IMPORTACAO)[number];

/** Limite do arquivo (ERP 8.6: ≤ 10 MB) e de linhas por planilha. */
export const LIMITE_ARQUIVO_IMPORTACAO = 10 * 1024 * 1024;
export const LIMITE_LINHAS_IMPORTACAO = 50_000;
/** Linhas devolvidas na prévia (o resumo conta todas). */
export const LIMITE_LINHAS_PREVIA = 1_000;

export interface ColunaImportacao {
  /** Nome no nosso layout (8.5). */
  chave: string;
  rotulo: string;
  /** Outros cabeçalhos aceitos (Nuvem3, variações comuns). */
  aliases: readonly string[];
}

/** Layout de produtos (8.5) + nomes do Nuvem3 (Estoque Atual, Movimentação, cadastro). */
export const COLUNAS_IMPORTACAO_PRODUTOS: readonly ColunaImportacao[] = [
  { chave: 'id', rotulo: 'Id (UUID)', aliases: ['uuid', 'idproduto_uuid'] },
  { chave: 'codigo', rotulo: 'Código', aliases: ['id produto', 'idproduto', 'cod produto', 'cod', 'cód.'] },
  {
    chave: 'codigo_interno',
    rotulo: 'Código interno',
    aliases: [
      'codigointerno',
      'ref interna',
      'ref. interna',
      'referencia interna',
      'referencia',
      'cod interno',
    ],
  },
  {
    chave: 'ean',
    rotulo: 'EAN',
    aliases: ['codigo de barras', 'cod barras', 'cod. barras', 'codigobarras', 'gtin', 'ean13', 'barras'],
  },
  { chave: 'nome', rotulo: 'Nome', aliases: ['produto', 'nomeproduto', 'descricao', 'nome produto'] },
  { chave: 'tipo', rotulo: 'Tipo', aliases: ['tipo produto', 'tipoproduto'] },
  {
    chave: 'unidade',
    rotulo: 'Unidade',
    aliases: ['sigla', 'un', 'und', 'unidade medida', 'unidade de medida'],
  },
  { chave: 'ativo', rotulo: 'Ativo', aliases: ['situacao', 'status'] },
  { chave: 'marca', rotulo: 'Marca', aliases: ['nome marca', 'fabricante'] },
  { chave: 'categoria', rotulo: 'Categoria', aliases: ['departamento', 'categorias', 'grupo', 'secao'] },
  {
    chave: 'preco_custo',
    rotulo: 'Preço de custo',
    aliases: ['custo', 'preco custo', 'preço custo', 'precocusto', 'valor custo'],
  },
  { chave: 'markup_pct', rotulo: 'Markup %', aliases: ['markup', 'markup %', 'margem markup'] },
  {
    chave: 'preco_venda',
    rotulo: 'Preço de venda',
    aliases: [
      'venda',
      'preco',
      'preço',
      'preco venda',
      'preço venda',
      'precovenda',
      'valor venda',
      'preco varejo',
    ],
  },
  {
    chave: 'preco_atacado',
    rotulo: 'Preço de atacado',
    aliases: ['atacado', 'preco atacado', 'precoatacado'],
  },
  {
    chave: 'qtd_minima_atacado',
    rotulo: 'Qtd. mínima atacado',
    aliases: ['qtd atacado', 'quantidade atacado', 'qtd minima atacado'],
  },
  { chave: 'preco_promocional', rotulo: 'Preço promocional', aliases: ['promocional', 'preco promocao'] },
  { chave: 'preco_menu_digital', rotulo: 'Preço menu digital', aliases: ['menu digital'] },
  { chave: 'preco_ifood', rotulo: 'Preço iFood', aliases: ['ifood', 'preco ifood'] },
  { chave: 'preco_parcelado', rotulo: 'Preço parcelado', aliases: ['parcelado'] },
  { chave: 'preco_loja', rotulo: 'Preço da loja', aliases: ['preco loja', 'venda loja'] },
  {
    chave: 'estoque_minimo',
    rotulo: 'Estoque mínimo',
    aliases: ['est minimo', 'est. minimo', 'est. mínimo', 'minimo', 'estoqueminimo'],
  },
  {
    chave: 'estoque_atual',
    rotulo: 'Estoque atual',
    aliases: ['est atual', 'est. atual', 'estoque', 'saldo', 'estoqueatual', 'qtd estoque', 'quantidade'],
  },
  { chave: 'ncm', rotulo: 'NCM', aliases: ['codigo ncm', 'ncm/sh'] },
  { chave: 'cest', rotulo: 'CEST', aliases: ['codigo cest'] },
  {
    chave: 'cfop_venda_estado',
    rotulo: 'CFOP (no estado)',
    aliases: ['cfop', 'cfop venda', 'cfop estadual'],
  },
  {
    chave: 'icms_situacao',
    rotulo: 'CST/CSOSN do ICMS',
    aliases: ['cst', 'csosn', 'cst icms', 'situacao tributaria', 'cst/csosn'],
  },
  { chave: 'icms_origem', rotulo: 'Origem', aliases: ['origem', 'origem mercadoria'] },
  { chave: 'icms_aliquota', rotulo: 'Alíquota do ICMS', aliases: ['aliquota icms', 'icms', 'aliquota'] },
  { chave: 'pis_situacao', rotulo: 'CST do PIS', aliases: ['cst pis', 'pis'] },
  { chave: 'cofins_situacao', rotulo: 'CST da COFINS', aliases: ['cst cofins', 'cofins'] },
  { chave: 'ipi_situacao', rotulo: 'CST do IPI', aliases: ['cst ipi', 'ipi'] },
  { chave: 'localizacao', rotulo: 'Localização', aliases: ['local', 'prateleira'] },
  { chave: 'peso_g', rotulo: 'Peso (g)', aliases: ['peso', 'peso bruto'] },
  { chave: 'descricao_curta', rotulo: 'Descrição curta', aliases: ['nome cupom', 'descricao cupom'] },
  {
    // Combo / kit ("grupo de itens" do Nuvem3, ERP 8.2.17): `código*qtd [rótulo]` separados por `|` ou `;`.
    chave: 'composicao',
    rotulo: 'Composição (combo)',
    aliases: ['componentes', 'itens do grupo', 'grupo de itens', 'itens do combo', 'composicao do combo'],
  },
  // Colunas de edição em massa do Nuvem3 ("Exportar/Importar produtos"): `Excluir` marca o item para exclusão (aqui:
  // inativação), `UsaNoMenuDigital` e `UsaBalancaEtiquetadoraStr` ligam o menu digital e a balança.
  { chave: 'excluir', rotulo: 'Excluir', aliases: ['excluido', 'remover', 'inativar'] },
  {
    chave: 'usa_menu_digital',
    rotulo: 'Usa no menu digital',
    aliases: ['usanomenudigital', 'usa menu digital', 'exibe menu digital'],
  },
  {
    chave: 'balanca',
    rotulo: 'Balança',
    aliases: [
      'usabalancaetiquetadorastr',
      'usabalancaetiquetadora',
      'usa balanca etiquetadora',
      'balanca etiquetadora',
      'tipo balanca',
    ],
  },
];

/**
 * Colunas conhecidas do Nuvem3 sem campo equivalente no GenesisPDV: continuam ignoradas, mas a prévia diz o motivo
 * (cabeçalho normalizado → explicação).
 */
export const COLUNAS_SEM_EQUIVALENTE: Record<TipoImportacao, Record<string, string>> = {
  produtos: {
    precopj:
      'sem equivalente no GenesisPDV: não há preço para pessoa jurídica; use preço de atacado ou grupo de preço',
  },
  clientes: {},
};

/** Layout de clientes (8.5) + nomes do Nuvem3. */
export const COLUNAS_IMPORTACAO_CLIENTES: readonly ColunaImportacao[] = [
  { chave: 'id', rotulo: 'Id (UUID)', aliases: ['uuid'] },
  {
    chave: 'codigo',
    rotulo: 'Código',
    aliases: ['id pessoa', 'idpessoa', 'cod', 'cod cliente', 'id cliente'],
  },
  { chave: 'tipo', rotulo: 'Tipo (PF/PJ)', aliases: ['pessoa', 'tipo pessoa', 'fisica/juridica'] },
  { chave: 'nome', rotulo: 'Nome', aliases: ['razao social', 'nome/razao social', 'cliente', 'pessoavenda'] },
  { chave: 'apelido', rotulo: 'Apelido', aliases: ['nome fantasia', 'fantasia'] },
  { chave: 'cpf_cnpj', rotulo: 'CPF/CNPJ', aliases: ['cpf', 'cnpj', 'documento', 'cpfcnpj'] },
  { chave: 'rg_ie', rotulo: 'RG/IE', aliases: ['rg', 'ie', 'inscricao estadual'] },
  { chave: 'nascimento', rotulo: 'Nascimento', aliases: ['data nascimento', 'dt nascimento', 'aniversario'] },
  { chave: 'telefone', rotulo: 'Telefone', aliases: ['fone', 'celular', 'telefone principal', 'whatsapp'] },
  { chave: 'email', rotulo: 'E-mail', aliases: ['e-mail', 'email principal'] },
  { chave: 'cep', rotulo: 'CEP', aliases: [] },
  { chave: 'logradouro', rotulo: 'Logradouro', aliases: ['endereco', 'rua'] },
  { chave: 'numero', rotulo: 'Número', aliases: ['nro', 'num', 'no'] },
  { chave: 'complemento', rotulo: 'Complemento', aliases: [] },
  { chave: 'bairro', rotulo: 'Bairro', aliases: [] },
  { chave: 'cidade', rotulo: 'Cidade', aliases: ['municipio'] },
  { chave: 'uf', rotulo: 'UF', aliases: ['estado'] },
  {
    chave: 'limite_compras',
    rotulo: 'Limite de compras',
    aliases: ['limite', 'limite credito', 'limite de credito'],
  },
  { chave: 'categorias', rotulo: 'Categorias', aliases: ['categoria'] },
];

export function colunasImportacao(tipo: TipoImportacao): readonly ColunaImportacao[] {
  return tipo === 'produtos' ? COLUNAS_IMPORTACAO_PRODUTOS : COLUNAS_IMPORTACAO_CLIENTES;
}

/** Cabeçalho comparável: sem acento, minúsculo, só letras e dígitos. */
export function normalizarCabecalho(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface MapeamentoColunas {
  /** Chave do layout → índice da coluna na planilha. */
  indices: Record<string, number>;
  /** Cabeçalhos da planilha que não correspondem a nenhuma coluna. */
  ignoradas: string[];
  /** Cabeçalhos repetidos (a primeira ocorrência vale). */
  repetidas: string[];
}

/** Reconhece as colunas pelo cabeçalho (nome do layout, rótulo ou alias). */
export function mapearColunas(cabecalho: readonly string[], tipo: TipoImportacao): MapeamentoColunas {
  const porNome = new Map<string, string>();
  for (const c of colunasImportacao(tipo)) {
    for (const nome of [c.chave, c.rotulo, ...c.aliases]) {
      const n = normalizarCabecalho(nome);
      if (n && !porNome.has(n)) porNome.set(n, c.chave);
    }
  }
  const indices: Record<string, number> = {};
  const ignoradas: string[] = [];
  const repetidas: string[] = [];
  cabecalho.forEach((bruto, i) => {
    const texto = String(bruto ?? '').trim();
    if (!texto) return;
    const chave = porNome.get(normalizarCabecalho(texto));
    const semEquivalente = COLUNAS_SEM_EQUIVALENTE[tipo][normalizarCabecalho(texto)];
    if (!chave) ignoradas.push(semEquivalente ? `${texto} (${semEquivalente})` : texto);
    else if (chave in indices) repetidas.push(texto);
    else indices[chave] = i;
  });
  return { indices, ignoradas, repetidas };
}

/**
 * Número da planilha: célula numérica do xlsx ou texto pt-BR (`1.234,56`, `R$ 9,90`, `12%`) ou com ponto decimal
 * (`1234.56`). Vazio → `null`; texto que não é número → `NaN`.
 */
export function lerNumeroPlanilha(valor: unknown): number | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : NaN;
  if (typeof valor === 'boolean') return NaN;
  let t = String(valor)
    .trim()
    .replace(/^R\$\s*/i, '')
    .replace(/%$/, '')
    .replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Número da planilha como texto decimal (ADR-05), pronto para o schema: a célula numérica do Excel (binária: um preço
 * calculado vira `3.4899999999999998`, um valor minúsculo `1e-7`) é arredondada às `casas` da coluna; o texto
 * digitado fica como veio (`3,499` → `3.499`, o schema confere as casas). `null` = vazio; `false` = não é número.
 */
export function lerDecimalPlanilha(valor: unknown, casas: number): string | null | false {
  const n = lerNumeroPlanilha(valor);
  if (n === null) return null;
  if (Number.isNaN(n)) return false;
  if (typeof valor === 'number') return dec(n).toDecimalPlaces(casas).toFixed();
  return dec(n).toFixed();
}

/** Booleano da planilha (`Sim`/`Não`, `S`/`N`, `1`/`0`, `Ativo`/`Inativo`, `true`/`false`). */
export function lerBooleanoPlanilha(valor: unknown): boolean | null {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  const t = normalizarCabecalho(String(valor));
  if (['sim', 's', '1', 'true', 'ativo', 'ativa', 'yes', 'y', 'x'].includes(t)) return true;
  if (['nao', 'n', '0', 'false', 'inativo', 'inativa', 'no'].includes(t)) return false;
  return null;
}

/** Código numérico lido como texto: o Excel guarda EAN/NCM como número (sem zeros à esquerda e às vezes `7.89E+12`). */
export function lerCodigoPlanilha(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return null;
    return Number.isInteger(valor) ? BigInt(valor).toString() : String(valor);
  }
  const t = String(valor).trim();
  return t || null;
}

/**
 * Categorias de uma célula: a nossa planilha traz o caminho (`CERVEJA > LATA`); o Nuvem3, a lista com cada
 * categoria seguida de vírgula (`CERVEJA,`, `MERCEARIA,PIPOCA,`). Separa pela vírgula **não** seguida de espaço (o
 * Nuvem3 tem nomes com vírgula e espaço: `NICSALTS, JUICE E PODS,` é uma categoria só) e ignora o vazio final. Cada
 * item pode ainda ser um caminho `PAI > FILHA` (separado depois, na análise).
 */
export function lerListaCategorias(texto: string): string[] {
  return texto
    .split(/,(?! )/)
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

/**
 * NCM da planilha só com os dígitos; com 7 dígitos é a célula numérica do Excel que perdeu o zero à esquerda (os
 * capítulos 01 a 09: `9030090` = `09030090`, `4022130` = `04022130`) e o zero volta.
 */
export function lerNcmPlanilha(valor: string | null): { ncm: string; completado: boolean } | null {
  const digitos = valor?.replace(/\D/g, '') ?? '';
  if (!digitos) return null;
  return digitos.length === 7
    ? { ncm: `0${digitos}`, completado: true }
    : { ncm: digitos, completado: false };
}

/**
 * Unidade por extenso do Nuvem3 e variações comuns → sigla do seed (`unidades_medida`). A comparação é sem acento,
 * caixa e pontuação (`normalizarCabecalho`).
 */
export const SINONIMOS_UNIDADE_PLANILHA: Readonly<Record<string, string>> = {
  unidade: 'UN',
  unidades: 'UN',
  unid: 'UN',
  und: 'UN',
  unit: 'UN',
  conjunto: 'CJ',
  conjuntos: 'CJ',
  conj: 'CJ',
  pacote: 'PCT',
  pacotes: 'PCT',
  pac: 'PCT',
  pc: 'PC',
  peca: 'PC',
  pecas: 'PC',
  caixa: 'CX',
  caixas: 'CX',
  fardo: 'FD',
  fardos: 'FD',
  litro: 'L',
  litros: 'L',
  lt: 'L',
  quilograma: 'KG',
  quilogramas: 'KG',
  quilo: 'KG',
  quilos: 'KG',
  kilo: 'KG',
  kilograma: 'KG',
  grama: 'G',
  gramas: 'G',
  gr: 'G',
  mililitro: 'ML',
  mililitros: 'ML',
  metro: 'M',
  metros: 'M',
  mt: 'M',
  centimetro: 'CM',
  centimetros: 'CM',
  metroquadrado: 'M2',
  metrocubico: 'M3',
  duzia: 'DZ',
  duzias: 'DZ',
  par: 'PAR',
  pares: 'PAR',
  kit: 'KIT',
};

/**
 * Acha a unidade pelo texto da planilha: sigla (`UN`), descrição cadastrada (`Unidade`, `Conjunto`) ou sinônimo do
 * Nuvem3 (`Pacote` → `PCT`), sem acento/caixa. `null` = não existe na empresa.
 */
export function resolverUnidadePlanilha<T extends { sigla: string; descricao: string }>(
  texto: string,
  unidades: readonly T[],
): T | null {
  const chave = normalizarCabecalho(texto);
  if (!chave) return null;
  const porSigla = new Map(unidades.map((u) => [normalizarCabecalho(u.sigla), u]));
  const porDescricao = new Map(unidades.map((u) => [normalizarCabecalho(u.descricao), u]));
  const sinonimo = SINONIMOS_UNIDADE_PLANILHA[chave];
  return (
    porSigla.get(chave) ??
    porDescricao.get(chave) ??
    (sinonimo ? porSigla.get(normalizarCabecalho(sinonimo)) : undefined) ??
    null
  );
}

/**
 * Coluna `Excluir` do Nuvem3: afirmativo (`S`, `Sim`, `X`, `1`, `true`) = `true`; vazio ou negativo (`N`, `Não`, `0`)
 * = `false`; qualquer outro texto = `null` (não reconhecido, avisado na prévia).
 */
export function lerExcluirPlanilha(valor: unknown): boolean | null {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string' && !valor.trim()) return false;
  if (typeof valor === 'string' && /^(in)?ativ[oa]$/i.test(normalizarCabecalho(valor))) return null;
  return lerBooleanoPlanilha(valor);
}

export type TipoBalancaPlanilha = 'nao_usa' | 'peso' | 'unidade';

/**
 * Coluna de balança (`UsaBalancaEtiquetadoraStr` do Nuvem3 ou `Balança` do nosso layout): `Peso`/`Pesável`/`KG` ou um
 * afirmativo (`Sim`, `S`) = pesado na balança etiquetadora; `Unidade`/`Unitário` = vendido por unidade na balança;
 * negativo = não usa. Vazio = `null`; texto não reconhecido = `false`.
 */
export function lerBalancaPlanilha(valor: unknown): TipoBalancaPlanilha | null | false {
  if (valor === null || valor === undefined || (typeof valor === 'string' && !valor.trim())) return null;
  const t = normalizarCabecalho(String(valor));
  if (['peso', 'pesavel', 'pesado', 'kg', 'balanca'].includes(t)) return 'peso';
  if (['unidade', 'unitario', 'un', 'porunidade'].includes(t)) return 'unidade';
  if (['naousa', 'nenhum', 'nenhuma'].includes(t)) return 'nao_usa';
  const b = lerBooleanoPlanilha(valor);
  if (b === null) return false;
  return b ? 'peso' : 'nao_usa';
}

/** Valores decimais iguais como decimal (`2,5` = `2.50`), sem `number`; vazio só é igual a vazio. */
export function mesmoDecimal(a: string | null | undefined, b: string | null | undefined): boolean {
  const vazio = (v: string | null | undefined) => v === null || v === undefined || v === '';
  if (vazio(a) || vazio(b)) return vazio(a) && vazio(b);
  return dec(a!).eq(dec(b!));
}

/**
 * Palavras genéricas de embalagem/variante que se repetem entre marcas diferentes (`SKOL LATA` × `BRAHMA LATA`): não
 * contam como palavra em comum na proteção do código.
 */
const PALAVRAS_GENERICAS = new Set([
  'LATA',
  'LATAO',
  'LONG',
  'NECK',
  'GARRAFA',
  'GARRAFINHA',
  'PET',
  'VIDRO',
  'PACK',
  'PACOTE',
  'CAIXA',
  'FARDO',
  'UNIDADE',
  'LITRO',
  'LITROS',
  'COM',
  'SEM',
  'GAS',
  'ZERO',
  'DIET',
  'LIGHT',
  'ORIGINAL',
  'TRADICIONAL',
  'SABOR',
  'SABORES',
  'COLA',
  'PURO',
  'PURA',
  'NATURAL',
  'GELADO',
  'GELADA',
  'RETORNAVEL',
  'DESCARTAVEL',
  'PILSEN',
  'LAGER',
  'PREMIUM',
  'ESPECIAL',
  'EXTRA',
  'MEDIO',
  'MEDIA',
  'GRANDE',
  'PEQUENO',
  'PEQUENA',
  'MINI',
  'NOVO',
  'NOVA',
  'PARA',
  'DOS',
  'DAS',
]);

/**
 * Palavras que identificam o produto, na ordem: ≥ 3 letras, sem acento e sem dígitos (`350ML`, `LT` e `2L` não contam),
 * sem as genéricas de embalagem. O prefixo de categoria do Nuvem3 (`CERVEJA - AMSTEL ULTRA`) sai: quase todo produto
 * da categoria o tem.
 */
function palavrasNome(nome: string): string[] {
  const semPrefixo = /^[^-]{2,30}\s+-\s+(.+)$/.exec(nome)?.[1] ?? nome;
  return [
    ...new Set(
      semPrefixo
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter((p) => p.length >= 3 && !/\d/.test(p) && !PALAVRAS_GENERICAS.has(p)),
    ),
  ];
}

/** Mesma palavra, ou abreviação de ≥ 4 letras (`CERV` × `CERVEJA`, `HEINE` × `HEINEKEN`). */
const mesmaPalavra = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Proteção do cruzamento pelo código (Id Produto, decisão 102): nomes parecidos = a 1ª palavra significativa (em geral
 * a marca) é a mesma **ou** a maioria das palavras coincide (Jaccard ≥ 0,5). `CERVEJA - AMSTEL ULTRA LN` × `CERV
 * AMSTEL ULTRA 330` → parecidos; `CERVEJA - SKOL LATA 350ML` × `CERVEJA - BRAHMA LATA 350ML`, `COCA COLA 2L` ×
 * `PEPSI COLA 2L` e `AGUA CRYSTAL` × `CARVAO 3KG` → diferentes (as palavras de embalagem não contam).
 * Sem palavras para comparar (nome só com números/siglas curtas/genéricas) conta como parecido.
 */
export function nomesParecidos(a: string, b: string): boolean {
  const x = palavrasNome(a);
  const y = palavrasNome(b);
  if (!x.length || !y.length) return true;
  if (mesmaPalavra(x[0]!, y[0]!)) return true;
  const comuns = x.filter((p) => y.some((q) => mesmaPalavra(p, q))).length;
  return comuns / (x.length + y.length - comuns) >= 0.5;
}

// ---------------------------------------------------------------- Opções, prévia e resultado

const booleanoForm = z.preprocess(
  (v) =>
    v === 'true' || v === 'on' || v === '1' ? true : v === 'false' || v === '0' || v === '' ? false : v,
  z.boolean().default(false),
);

const vazioIndefinido = (v: unknown) => (v === '' || v === null ? undefined : v);

const camposOpcoesImportacao = z.object({
  /**
   * Loja dos preços por loja, do estoque mínimo e, sem `estoqueId`, do estoque (8.6). Obrigatória para produtos,
   * salvo quando o "Atualizar estoque" vai para um estoque escolhido (o CD, sem loja; F2-B11).
   */
  lojaId: z.preprocess(vazioIndefinido, z.uuid('Escolha a loja').optional()),
  atualizarEstoque: booleanoForm,
  atualizarEstoqueMinimo: booleanoForm,
  atualizarPrecos: booleanoForm,
  criarMarcasCategorias: booleanoForm,
  /**
   * Estoque do "Atualizar estoque" (F2-B11): qualquer estoque permitido para movimentar, inclusive o sem loja (o CD).
   * Vazio = o estoque da loja escolhida.
   */
  estoqueId: z.preprocess(vazioIndefinido, z.uuid('Estoque inválido').optional()),
  /**
   * Hora da contagem do "Atualizar estoque" (F2-B11; ERP 13.1.5): obrigatória com ele. O AJUSTE_IMPORTACAO lança
   * nessa hora (`retroativoPermitido`), e as vendas e movimentos posteriores a ela são descontados, como no "Definir".
   */
  dataContagem: z.preprocess(vazioIndefinido, dataContagemSchema.optional()),
});

function regrasOpcoesImportacao(v: z.output<typeof camposOpcoesImportacao>, ctx: z.RefinementCtx) {
  if (v.atualizarEstoque && v.dataContagem === undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['dataContagem'],
      message: 'Informe a data/hora da contagem',
    });
}

export const opcoesImportacaoSchema = camposOpcoesImportacao.superRefine(regrasOpcoesImportacao);
export type OpcoesImportacao = z.output<typeof opcoesImportacaoSchema>;

export const confirmarImportacaoSchema = camposOpcoesImportacao
  .extend({ arquivoId: z.uuid() })
  .superRefine(regrasOpcoesImportacao);

/**
 * Ação prevista da linha: `sem_alteracao` = registro existente igual à planilha (nada é gravado, nem auditoria nem
 * versão nova para o sync); `inativar` = coluna `Excluir` afirmativa em produto existente.
 */
export const ACOES_LINHA_IMPORTACAO = ['criar', 'atualizar', 'sem_alteracao', 'inativar', 'ignorar'] as const;
export type AcaoLinhaImportacao = (typeof ACOES_LINHA_IMPORTACAO)[number];

/** Inconsistências do relatório (roadmap Fase 1 / 15.2): o código facilita filtrar e somar na prévia. */
export const CODIGOS_AVISO_IMPORTACAO = [
  'ean_duplicado',
  'ean_invalido',
  'ncm_invalido',
  'sem_preco',
  'marca_inexistente',
  'categoria_inexistente',
  'cidade_inexistente',
  'documento_invalido',
  'combo_sem_posicoes',
  'codigo_conflito',
  'estoque_negativo',
  'exclusao_sem_produto',
  'outro',
] as const;
export type CodigoAvisoImportacao = (typeof CODIGOS_AVISO_IMPORTACAO)[number];
export const ROTULOS_AVISO_IMPORTACAO: Record<CodigoAvisoImportacao, string> = {
  ean_duplicado: 'EAN duplicado',
  ean_invalido: 'EAN inválido',
  ncm_invalido: 'NCM inválido',
  sem_preco: 'Sem preço',
  marca_inexistente: 'Marca inexistente',
  categoria_inexistente: 'Categoria inexistente',
  cidade_inexistente: 'Cidade não encontrada',
  documento_invalido: 'CPF/CNPJ inválido',
  combo_sem_posicoes: 'Combo sem posições',
  codigo_conflito: 'Conferir código',
  estoque_negativo: 'Estoque negativo',
  exclusao_sem_produto: 'Excluir sem produto',
  outro: 'Outro',
};

export interface OcorrenciaImportacao {
  codigo: CodigoAvisoImportacao;
  campo: string | null;
  mensagem: string;
}

/** Diferença de um campo entre o registro atual e a planilha (valores já formatados em pt-BR para exibir). */
export interface AlteracaoImportacao {
  campo: string;
  rotulo: string;
  de: string | null;
  para: string | null;
}

export interface LinhaPreviaImportacao {
  /** Número da linha na planilha (cabeçalho = 1). */
  linha: number;
  acao: AcaoLinhaImportacao;
  /** Nome/descrição para identificar a linha. */
  descricao: string;
  /** Registro existente que será atualizado. */
  registroId: string | null;
  /** Erros impedem a linha (ação `ignorar`). */
  erros: string[];
  /** Inconsistências que não impedem: a linha é gravada e entra no relatório. */
  avisos: OcorrenciaImportacao[];
  /** `atualizar`/`inativar`: o que muda, campo a campo (só esses campos são gravados). */
  alteracoes?: AlteracaoImportacao[];
}

export interface ResumoImportacao {
  linhas: number;
  criar: number;
  atualizar: number;
  sem_alteracao: number;
  inativar: number;
  ignorar: number;
  comAviso: number;
  /** Quantas linhas têm cada inconsistência. */
  porAviso: Partial<Record<CodigoAvisoImportacao, number>>;
}

export interface PreviaImportacao {
  tipo: TipoImportacao;
  /** Arquivo guardado para a confirmação (a tarefa relê a planilha). */
  arquivoId: string;
  nomeArquivo: string;
  colunasReconhecidas: string[];
  colunasIgnoradas: string[];
  resumo: ResumoImportacao;
  /** Até `LIMITE_LINHAS_PREVIA` linhas: as com erro/aviso primeiro. */
  linhas: LinhaPreviaImportacao[];
}

export interface ResultadoImportacao {
  tipo: TipoImportacao;
  criados: number;
  atualizados: number;
  /** Linhas iguais ao cadastro (nada gravado). */
  semAlteracao: number;
  /** Produtos inativados pela coluna `Excluir`. */
  inativados: number;
  comErro: number;
  comAviso: number;
  porAviso: Partial<Record<CodigoAvisoImportacao, number>>;
  /** Acerto "Definir" gerado pela coluna `estoque_atual` (8.6); com mais de 5.000 produtos, o primeiro de `acertos`. */
  acertoId: string | null;
  acertoCodigo: number | null;
  /**
   * Todos os acertos "Definir" gerados (F2-B11): acima de `LIMITE_ITENS_ACERTO` produtos a contagem vira vários, com
   * a mesma hora da contagem, como na importação de contagem (F2-B9). Ausente nos resultados de antes do F2-B11.
   */
  acertos?: Array<{ id: string; codigo: number }>;
}

export function resumirLinhas(linhas: readonly LinhaPreviaImportacao[]): ResumoImportacao {
  const r: ResumoImportacao = {
    linhas: linhas.length,
    criar: 0,
    atualizar: 0,
    sem_alteracao: 0,
    inativar: 0,
    ignorar: 0,
    comAviso: 0,
    porAviso: {},
  };
  for (const l of linhas) {
    r[l.acao]++;
    if (l.avisos.length) r.comAviso++;
    for (const codigo of new Set(l.avisos.map((a) => a.codigo)))
      r.porAviso[codigo] = (r.porAviso[codigo] ?? 0) + 1;
  }
  return r;
}
