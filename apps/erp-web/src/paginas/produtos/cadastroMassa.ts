/**
 * Linhas da grade do **cadastro em massa** (ERP 8.3; F2-B39) ⇄ corpo da API: a linha nova, a "Atualização" achada pelo
 * "Pesquisar EAN" (os valores gravados do produto), a validação por linha antes de gravar, o markup ⇄ preço e a marca
 * digitada (a existente pelo nome, a nova criada na gravação). Funções puras, para a tela e o teste da grade.
 */
import {
  markupPct,
  precoPeloMarkupTexto,
  validarGtin,
  type LinhaCadastroMassaEntrada,
  type MarcaResumo,
  type ProdutoEanCadastroMassa,
} from '@genesis/shared';
import { textoDecimal } from '../../componentes/grade/decimal';
import { decimalParaTela, novaChave } from './valores';

export type SituacaoLinhaMassa = 'novo' | 'atualizacao' | 'duplicado' | 'variacao';

/** Os campos do cadastro que a Atualização traz do produto gravado (o resto da linha é o estoque a somar). */
const CAMPOS_GRAVADOS = [
  'nome',
  'unidadeId',
  'ncm',
  'marca',
  'categoriaId',
  'precoCusto',
  'markupPct',
  'precoVenda',
  'estoqueMinimo',
] as const;
type CampoGravado = (typeof CAMPOS_GRAVADOS)[number];
export type ValoresGravadosMassa = Record<CampoGravado, string>;

export interface LinhaMassa {
  chave: string;
  ean: string;
  nome: string;
  unidadeId: string;
  ncm: string;
  /** A marca como digitada: a existente pelo nome (sem acento e caixa) ou uma nova. */
  marca: string;
  categoriaId: string;
  precoCusto: string;
  markupPct: string;
  precoVenda: string;
  /** Quantidade a somar no estoque escolhido (na unidade do produto). */
  estoque: string;
  estoqueMinimo: string;
  /** O EAN que a última pesquisa viu (`null` = ainda não pesquisado) e o que ela achou. */
  pesquisado: string | null;
  situacao: SituacaoLinhaMassa | null;
  /** O produto da Atualização (ou os do EAN duplicado na base). */
  produtos: ProdutoEanCadastroMassa[];
  /**
   * Na Atualização, os valores do produto como a pesquisa os pôs na linha: o campo igual a eles não foi mexido e vai
   * nulo à API (mantém o gravado, sem regravar o produto à toa); `null` fora da Atualização.
   */
  gravados: ValoresGravadosMassa | null;
}

export const novaLinhaMassa = (unidadeId = ''): LinhaMassa => ({
  chave: novaChave(),
  ean: '',
  nome: '',
  unidadeId,
  ncm: '',
  marca: '',
  categoriaId: '',
  precoCusto: '',
  markupPct: '',
  precoVenda: '',
  estoque: '',
  estoqueMinimo: '',
  pesquisado: null,
  situacao: null,
  produtos: [],
  gravados: null,
});

/** Linha sem nada digitado (a unidade padrão não conta): fora da gravação e removida sem confirmação. */
export const linhaMassaVazia = (l: LinhaMassa) =>
  !l.ean.trim() &&
  !l.nome.trim() &&
  !l.ncm.trim() &&
  !l.marca.trim() &&
  !l.categoriaId &&
  !l.precoCusto.trim() &&
  !l.markupPct.trim() &&
  !l.precoVenda.trim() &&
  !l.estoque.trim() &&
  !l.estoqueMinimo.trim();

export const eanDaLinha = (l: LinhaMassa) => l.ean.replace(/\s/g, '');

/** A linha precisa (de novo) do "Pesquisar EAN": tem EAN e ele mudou desde a última pesquisa. */
export const precisaPesquisar = (l: LinhaMassa) => !!eanDaLinha(l) && l.pesquisado !== eanDaLinha(l);

const chaveNome = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

/** A marca existente pelo nome digitado (sem acento e caixa, como a API). */
export const marcaPeloNome = (marcas: readonly MarcaResumo[], nome: string) =>
  nome.trim() ? marcas.find((m) => chaveNome(m.descricao) === chaveNome(nome)) : undefined;

const PRECO_GRAVADO = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Preço gravado (`numeric(15,4)`) para a tela sem cortar casas: "3.4567" → "3,4567", "5.9900" → "5,99". */
function precoGravadoParaTela(v: string | null): string {
  if (v === null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? PRECO_GRAVADO.format(n).replace(/\./g, '') : '';
}

/** Os valores do produto achado como a Atualização os mostra (custo e preço com as 4 casas gravadas). */
export const valoresGravados = (p: ProdutoEanCadastroMassa): ValoresGravadosMassa => ({
  nome: p.nome,
  unidadeId: p.unidadeId,
  ncm: p.ncm ?? '',
  marca: p.marcaNome ?? '',
  categoriaId: p.categoriaId ?? '',
  precoCusto: precoGravadoParaTela(p.precoCusto),
  markupPct: decimalParaTela(p.markupPct, 4),
  precoVenda: precoGravadoParaTela(p.precoVenda),
  estoqueMinimo: decimalParaTela(p.estoqueMinimo, 3),
});

/**
 * O resultado do "Pesquisar EAN" na linha: achou um produto (do pai) = **Atualização**, com os valores gravados para
 * editar; mais de um = EAN duplicado na base (corrigir pelo relatório); só numa variação = ainda não atualizável
 * (F2-B50); nada = produto novo. **O que o usuário digitou ou colou fica** (a lista nova de preços colada do Excel
 * atualiza o produto achado): a pesquisa só completa os campos vazios com o gravado (a unidade padrão conta como vazia)
 * e troca os que a pesquisa anterior pôs e ninguém mexeu — os do outro produto, ou os do mesmo pesquisado de novo
 * (trocar o estoque renova a versão e o estoque mínimo, o da loja do estoque de agora). Ao deixar de ser Atualização,
 * só os valores que a pesquisa anterior trouxe saem.
 */
export function aplicarPesquisa(
  l: LinhaMassa,
  produtos: readonly ProdutoEanCadastroMassa[],
  unidadePadrao = '',
): LinhaMassa {
  const ean = eanDaLinha(l);
  const vazia = novaLinhaMassa(unidadePadrao);
  // Não mexido: igual ao que a pesquisa anterior pôs; sem ela, vazio (ou a unidade padrão).
  const intocado = (c: CampoGravado) =>
    l.gravados ? l[c] === l.gravados[c] : !l[c].trim() || (c === 'unidadeId' && l[c] === unidadePadrao);
  const comCampos = (valor: (c: CampoGravado) => string) =>
    Object.fromEntries(CAMPOS_GRAVADOS.map((c) => [c, valor(c)])) as ValoresGravadosMassa;
  const base: LinhaMassa = {
    ...l,
    ...comCampos((c) => (intocado(c) ? vazia[c] : l[c])),
    pesquisado: ean,
    produtos: [...produtos],
    gravados: null,
  };
  if (!produtos.length) return { ...base, situacao: 'novo' };
  if (produtos.length > 1) return { ...base, situacao: 'duplicado' };
  const p = produtos[0]!;
  if (p.variacao) return { ...base, situacao: 'variacao' };
  const gravados = valoresGravados(p);
  const linha: LinhaMassa = {
    ...base,
    ...comCampos((c) => (intocado(c) ? gravados[c] : l[c])),
    situacao: 'atualizacao',
    gravados,
  };
  // Custo ou preço digitados com o markup gravado: o markup sai da conta (a mesma da API sem o markup na linha).
  const precoMexido = linha.precoCusto !== gravados.precoCusto || linha.precoVenda !== gravados.precoVenda;
  if (precoMexido && linha.markupPct === gravados.markupPct && gravados.precoCusto) {
    const custo = textoDecimal(linha.precoCusto);
    const venda = textoDecimal(linha.precoVenda);
    const m = custo !== null && venda !== null && Number(custo) > 0 ? markupPct(custo, venda) : null;
    if (m !== null) linha.markupPct = decimalParaTela(String(m), 4);
  }
  return linha;
}

/**
 * Markup ⇄ preço (ERP 8.3: "Markup % recalcula Preço venda"; as contas do formulário, ERP 8.2.1): o markup digitado
 * refaz o preço sobre o custo (2 casas); o preço digitado refaz o markup (4 casas); o custo digitado refaz o preço
 * pelo markup que já está (ou o markup pelo preço, sem markup). Sem custo, não há markup.
 */
export function alterarPreco(
  l: LinhaMassa,
  campo: 'precoCusto' | 'markupPct' | 'precoVenda',
  valor: string,
): LinhaMassa {
  const nova = { ...l, [campo]: valor };
  const custo = textoDecimal(nova.precoCusto);
  const markup = textoDecimal(nova.markupPct);
  const venda = textoDecimal(nova.precoVenda);
  if (custo === null || !(Number(custo) > 0)) return nova;
  if (campo === 'precoVenda') {
    const m = venda === null ? null : markupPct(custo, venda);
    return { ...nova, markupPct: m === null ? '' : decimalParaTela(String(m), 4) };
  }
  if (markup !== null) return { ...nova, precoVenda: decimalParaTela(precoPeloMarkupTexto(custo, markup)) };
  if (campo === 'precoCusto' && venda !== null) {
    const m = markupPct(custo, venda);
    return { ...nova, markupPct: m === null ? '' : decimalParaTela(String(m), 4) };
  }
  return nova;
}

export interface ContextoLinhaMassa {
  marcas: readonly MarcaResumo[];
  podeCriarMarca: boolean;
  /** O estoque escolhido é de uma loja (o estoque mínimo é da loja). */
  estoqueTemLoja: boolean;
  /** Fração por unidade (a quantidade do produto sem fração é inteira). */
  fracaoDaUnidade: (unidadeId: string) => boolean;
}

const decimalValido = (t: string) => !t.trim() || textoDecimal(t) !== null;

/** Erros da linha antes de gravar (ERP 8.3 "validação por linha"); a API confere de novo e junta os dela. */
export function errosLinhaMassa(
  l: LinhaMassa,
  ctx: ContextoLinhaMassa,
): Partial<Record<keyof LinhaMassa | '_linha', string>> {
  const e: Partial<Record<keyof LinhaMassa | '_linha', string>> = {};
  const ean = eanDaLinha(l);
  if (l.situacao === 'duplicado' && l.pesquisado === ean)
    e.ean = `EAN em ${l.produtos.length} produtos: corrija pelo relatório de EAN duplicado`;
  else if (l.situacao === 'variacao' && l.pesquisado === ean)
    e.ean = 'Código de uma variação: a grade ainda não atualiza variação (use o cadastro do produto)';
  else if (ean && l.pesquisado !== ean) e.ean = 'Pesquise o EAN (Enter no campo ou "Pesquisar EAN")';
  const atualizacao = l.situacao === 'atualizacao' && l.pesquisado === ean;
  if (!atualizacao && ean && !validarGtin(ean))
    e.ean ??= 'GTIN inválido (8, 12, 13 ou 14 dígitos com o verificador)';
  if (!atualizacao) {
    if (l.nome.trim().length < 2) e.nome = 'Informe o nome';
    if (!l.unidadeId) e.unidadeId = 'Escolha a unidade';
  } else if (l.nome.trim() && l.nome.trim().length < 2) e.nome = 'Mínimo de 2 caracteres';
  if (l.ncm.trim() && !/^\d{8}$/.test(l.ncm.replace(/\D/g, ''))) e.ncm = 'NCM com 8 dígitos';
  // A marca que a Atualização trouxe (sem mexer) é a gravada: não se procura na lista (quem não tem "Marcas: Ver").
  const marcaGravada = atualizacao && l.gravados !== null && l.marca === l.gravados.marca;
  if (!marcaGravada && l.marca.trim() && !marcaPeloNome(ctx.marcas, l.marca) && !ctx.podeCriarMarca)
    e.marca = 'Marca inexistente (criar marca exige "Marcas: Criar")';
  if (!decimalValido(l.precoCusto)) e.precoCusto = 'Valor inválido';
  if (!decimalValido(l.markupPct)) e.markupPct = 'Valor inválido';
  const venda = textoDecimal(l.precoVenda);
  if ((!atualizacao || l.precoVenda.trim()) && !(venda !== null && Number(venda) > 0))
    e.precoVenda = 'Informe o preço de venda';
  const estoque = textoDecimal(l.estoque);
  if (l.estoque.trim()) {
    if (estoque === null || !(Number(estoque) > 0)) e.estoque = 'Quantidade maior que zero';
    else if (atualizacao && !l.produtos[0]!.temEstoqueProprio)
      e.estoque = 'O produto não tem estoque próprio';
    else {
      const fracao = atualizacao ? l.produtos[0]!.permiteFracao : ctx.fracaoDaUnidade(l.unidadeId);
      if (!fracao && !Number.isInteger(Number(estoque))) e.estoque = 'Sem fração: quantidade inteira';
    }
  }
  if (l.estoqueMinimo.trim()) {
    const min = textoDecimal(l.estoqueMinimo);
    if (!ctx.estoqueTemLoja) e.estoqueMinimo = 'O estoque não é de uma loja: o mínimo é por loja';
    else if (min === null || Number(min) < 0) e.estoqueMinimo = 'Quantidade inválida';
  }
  return e;
}

/**
 * A linha para o `POST /produtos/cadastro-em-massa` (os decimais com ponto; vazio = nulo = mantém na Atualização). Na
 * Atualização, o campo que ninguém mexeu desde a pesquisa também vai nulo: a linha só de estoque não regrava o produto
 * (nem arredonda o que está gravado) e não pede "Produtos: Editar".
 */
export function linhaParaApi(
  l: LinhaMassa,
  ctx: Pick<ContextoLinhaMassa, 'marcas'>,
): LinhaCadastroMassaEntrada {
  const ean = eanDaLinha(l);
  const atualizacao = l.situacao === 'atualizacao' && l.pesquisado === ean ? l.produtos[0]! : null;
  const gravados = atualizacao ? l.gravados : null;
  const v = (c: CampoGravado) => (gravados && l[c] === gravados[c] ? '' : l[c]);
  const marcaTexto = v('marca').trim();
  const marca = marcaPeloNome(ctx.marcas, marcaTexto);
  const dec = (t: string) => textoDecimal(t);
  return {
    produtoId: atualizacao?.id ?? null,
    versao: atualizacao?.versao ?? null,
    ean: ean || null,
    nome: v('nome').trim() || null,
    unidadeId: v('unidadeId') || null,
    ncm: v('ncm').replace(/\D/g, '') || null,
    marcaId: marca?.id ?? null,
    marcaNova: !marca && marcaTexto ? marcaTexto : null,
    categoriaId: v('categoriaId') || null,
    precoCusto: dec(v('precoCusto')),
    markupPct: dec(v('markupPct')),
    precoVenda: dec(v('precoVenda')),
    estoque: dec(l.estoque),
    estoqueMinimo: dec(v('estoqueMinimo')),
  };
}
