/**
 * Trava "Altera Preço do Produto no ERP" (Configurações › Geral, `geral.altera_preco_produto_erp` = Não; ERP 8.2 e
 * 9.1; README › decisões 68 e 208): **o que, no cadastro do produto, decide o preço cobrado do cliente**, numa lista
 * só, e a comparação do gravado com o enviado. Quem não tem `produtos.alterar_preco` grava o produto só se nada dessa
 * lista mudou; repetir os valores de agora (o formulário e a importação mandam o cadastro inteiro) nunca conta.
 *
 * Função pura (sem banco): `garantirAlterarPreco` (produtos.controller.ts) lê a configuração, as lojas ativas, o
 * detalhe gravado e as opções excluídas e chama `mudancasDePreco`; o teste unitário (`trava-preco.spec.ts`) confere
 * cada campo. Campo de preço novo no cadastro entra **neste arquivo**: a coluna do produto em `CAMPOS_PRECO_PRODUTO`
 * (o teste deriva do contrato os campos de preço e falha com o que ficou fora), a da loja em `CAMPOS_PRECO_LOJA`, e
 * o da filha (código de barras, complemento, alternativa do combo) na regra própria dela, escrita em
 * `mudancasDePreco`.
 */
import type { CriarProduto, ProdutoDetalhe } from '@genesis/shared';

type Valor = string | number | boolean | null;
type Normalizar = (v: unknown) => Valor;

/** Decimal (string do banco ou do zod) comparável: `'1.5000'` e `'1.50'` são o mesmo valor. */
const numero: Normalizar = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
/** Data e hora no minuto (o formulário mostra e devolve `HH:mm`; os segundos gravados não são uma mudança). */
const minuto: Normalizar = (v) =>
  v === null || v === undefined || v === '' ? null : Math.floor(Date.parse(String(v)) / 60_000);
/** Id (uuid) sem diferenciar maiúsculas. */
const id: Normalizar = (v) => (v === null || v === undefined || v === '' ? null : String(v).toLowerCase());
const valor: Normalizar = (v) => (v === undefined ? null : (v as Valor));

/**
 * Os campos do produto que decidem o preço (ERP 8.2.1, 8.2.2 e 8.2.6; PDV 10.4 e 11.3): os preços (venda, atacado,
 * promocional, parcelado, menu digital, iFood), as condições em que eles valem (a quantidade mínima do atacado e a
 * vigência da promoção), o grupo de preço por quantidade (o mix soma as quantidades e dá o preço das faixas dele) e o
 * preço digitado no caixa (Solicita preço PDV e Genérico).
 */
export const CAMPOS_PRECO_PRODUTO = {
  precoVenda: numero,
  precoAtacado: numero,
  qtdMinimaAtacado: numero,
  precoPromocional: numero,
  promocaoInicio: minuto,
  promocaoFim: minuto,
  precoParcelado: numero,
  precoMenuDigital: numero,
  precoIfood: numero,
  grupoPrecoQuantidadeId: id,
  solicitaPrecoPdv: valor,
  generico: valor,
} as const satisfies Partial<Record<keyof CriarProduto & keyof ProdutoDetalhe, Normalizar>>;

/** Os campos de preço da linha da loja (8.2.10): o preço próprio e o acréscimo da versão gelada. */
export const CAMPOS_PRECO_LOJA = {
  precoVenda: numero,
  acrescimoGelada: numero,
} as const satisfies Partial<Record<keyof CriarProduto['lojas'][number], Normalizar>>;

/**
 * O que já saiu da venda deste produto, para a opção que volta (README › decisão 208): as linhas excluídas
 * logicamente dos códigos de barras, dos complementos (inclusive os dos grupos excluídos) e das alternativas do combo
 * (inclusive as das posições excluídas), **da mais nova para a mais antiga** (`garantirAlterarPreco` lê do banco; o
 * detalhe só traz as vivas). Só a mais nova de cada opção conta: é o último preço que ela teve.
 */
export interface OpcoesExcluidas {
  codigosBarras: ReadonlyArray<{ codigo: string; preco: string | null }>;
  complementos: ReadonlyArray<{ produtoId: string | null; descricao: string | null; precoAdicional: string }>;
  alternativas: ReadonlyArray<{ produtoId: string; variacaoId: string | null; acrescimo: string }>;
}

export interface ContextoTravaPreco {
  /** A loja que o usuário vê: as linhas das outras não vêm no detalhe dele e a gravação as preserva (decisão 88). */
  lojaVisivel: (lojaId: string) => boolean;
  /**
   * Loja ativa e não excluída: a linha dela que falta no corpo é excluída pela gravação e a loja passa a cobrar o
   * preço geral. As inativas ficam fora (o formulário só lista as lojas ativas).
   */
  lojaAtiva: (lojaId: string) => boolean;
  excluidas: OpcoesExcluidas;
}

/**
 * As opções de venda de uma lista filha (códigos de barras, complementos, alternativas do combo) por chave da opção
 * (o código; o produto e a variação; o produto ou a descrição livre): as que **saem** da venda neste salvamento, com o
 * valor delas, e as chaves que **têm preço** em algum lugar do cadastro (a opção que fica à venda, a inativa ou fora
 * da venda, e a última excluída). A opção que **entra** na venda (nova, recriada sem o id, com outra chave, reativada
 * ou que volta a ser usada na venda) só passa:
 * - com o valor de uma opção da mesma chave que sai da venda neste mesmo salvamento (excluir e recriar não troca o
 *   preço dela; o valor do código com preço é o preço e o fator), e só com o dela: o preço da mesma opção noutro
 *   grupo ou noutra posição não vale;
 * - sem nada igual saindo, só sem preço e quando a chave não tem preço em lugar nenhum: a opção que tem ou já teve
 *   preço entra só com a permissão, inclusive de graça, em qualquer número de salvamentos.
 */
class OpcoesDaVenda {
  private readonly saindo = new Map<string, Set<string>>();
  private readonly comPreco = new Set<string>();

  sai(chave: string, valor: string): void {
    const s = this.saindo.get(chave) ?? new Set<string>();
    s.add(valor);
    this.saindo.set(chave, s);
  }

  /** A opção da chave que fica no cadastro (à venda ou fora dela) tem preço (`preco` verdadeiro). */
  fica(chave: string, preco: boolean): void {
    if (preco) this.comPreco.add(chave);
  }

  /** As excluídas, da mais nova para a mais antiga: só a mais nova de cada chave conta. */
  excluidas<T>(linhas: ReadonlyArray<T>, chave: (l: T) => string, comPreco: (l: T) => boolean): void {
    const vistas = new Set<string>();
    for (const l of linhas) {
      const k = chave(l);
      if (vistas.has(k)) continue;
      vistas.add(k);
      if (comPreco(l)) this.comPreco.add(k);
    }
  }

  /** A opção que entra na venda muda o preço? `valor` como em `sai`; `comPreco` = ela tem preço. */
  entraMudando(chave: string, valor: string, comPreco: boolean): boolean {
    const s = this.saindo.get(chave);
    if (s) return !s.has(valor);
    return comPreco || this.comPreco.has(chave);
  }

  /** Alguma opção da chave que sai tem este preço (o que mudou foi o fator)? */
  saiComPreco(chave: string, preco: string): boolean {
    return [...(this.saindo.get(chave) ?? [])].some((v) => v.split('x')[0] === preco);
  }
}

/**
 * Os campos de preço que o corpo `d` muda em relação ao gravado `antes` (vazio = nada de preço mudou), no caminho do
 * corpo (`precoVenda`, `codigosBarras.1.preco`, `lojas.0.acrescimoGelada`, `lojas:<id>` para a linha da loja
 * retirada…). Os casamentos das filhas são os mesmos da gravação (`gravarFilhas`, `gravarComplementos`): o que a
 * gravação trata como linha nova é linha nova aqui também.
 */
export function mudancasDePreco(antes: ProdutoDetalhe, d: CriarProduto, ctx: ContextoTravaPreco): string[] {
  const mudou: string[] = [];

  for (const [campo, normalizar] of Object.entries(CAMPOS_PRECO_PRODUTO) as [
    keyof typeof CAMPOS_PRECO_PRODUTO,
    Normalizar,
  ][]) {
    if (normalizar(antes[campo]) !== normalizar(d[campo])) mudou.push(campo);
  }

  // Códigos de barras (8.2.3; PDV 11.3): o caixa cobra o preço da embalagem ao bipar o código à venda (`usaVenda`) que
  // tem preço (`preço ÷ fator` por unidade, o menor candidato vence); sem preço, cobra o preço do produto × o fator.
  // Regra própria, escrita aqui (não há lista de campos): casamento de `gravarFilhas` (o id entre os códigos gravados
  // do produto).
  // - O código gravado com preço não muda o preço (nem tirá-lo), o fator (à venda) nem o código, à venda ou não: o
  //   preço dele é o que vale quando ele volta para a venda.
  // - O código que entra na venda segue `OpcoesDaVenda` pela chave `codigo` (o valor é o preço e o fator, ou "sem").
  // - Tirar o código ou o "usa na venda" tira o código da venda e não conta; o fator e o código do código sem preço
  //   só mudam a embalagem.
  const valorCodigo = (preco: unknown, fator: unknown) => {
    const p = numero(preco);
    return p === null ? 'sem' : `${p}x${numero(fator)}`;
  };
  const casadoCodigo = d.codigosBarras.map((c) =>
    c.id ? antes.codigosBarras.find((e) => e.id === c.id) : undefined,
  );
  const ficaCodigo = new Set(
    d.codigosBarras.flatMap((c, i) => {
      const a = casadoCodigo[i];
      return a && a.usaVenda && c.usaVenda && a.codigo === c.codigo ? [a.id] : [];
    }),
  );
  const codigos = new OpcoesDaVenda();
  for (const a of antes.codigosBarras) {
    if (a.usaVenda && !ficaCodigo.has(a.id)) codigos.sai(a.codigo, valorCodigo(a.preco, a.fator));
    else codigos.fica(a.codigo, numero(a.preco) !== null);
  }
  codigos.excluidas(
    ctx.excluidas.codigosBarras,
    (c) => c.codigo,
    (c) => numero(c.preco) !== null,
  );
  d.codigosBarras.forEach((c, i) => {
    const a = casadoCodigo[i];
    const precoNovo = numero(c.preco);
    if (a && numero(a.preco) !== precoNovo) {
      mudou.push(`codigosBarras.${i}.preco`);
      return;
    }
    if (a && precoNovo !== null && a.codigo !== c.codigo) {
      mudou.push(`codigosBarras.${i}.codigo`);
      return;
    }
    if (!c.usaVenda) return;
    if (a && a.usaVenda && a.codigo === c.codigo) {
      if (precoNovo !== null && numero(a.fator) !== numero(c.fator)) mudou.push(`codigosBarras.${i}.fator`);
      return;
    }
    if (codigos.entraMudando(c.codigo, valorCodigo(c.preco, c.fator), precoNovo !== null))
      mudou.push(
        `codigosBarras.${i}.${precoNovo !== null && codigos.saiComPreco(c.codigo, String(precoNovo)) ? 'fator' : 'preco'}`,
      );
  });

  // Lojas: a linha enviada (nova ou casada pela loja) e a linha de loja visível e ativa que saiu do corpo.
  const lojasAntes = new Map(antes.lojas.map((l) => [l.lojaId, l]));
  d.lojas.forEach((l, i) => {
    const a = lojasAntes.get(l.lojaId);
    for (const [campo, normalizar] of Object.entries(CAMPOS_PRECO_LOJA) as [
      keyof typeof CAMPOS_PRECO_LOJA,
      Normalizar,
    ][]) {
      if (normalizar(a?.[campo] ?? null) !== normalizar(l[campo])) mudou.push(`lojas.${i}.${campo}`);
    }
  });
  for (const a of antes.lojas) {
    if (!ctx.lojaVisivel(a.lojaId) || !ctx.lojaAtiva(a.lojaId)) continue;
    if (d.lojas.some((l) => l.lojaId === a.lojaId)) continue;
    const temPreco = (Object.keys(CAMPOS_PRECO_LOJA) as (keyof typeof CAMPOS_PRECO_LOJA)[]).some(
      (c) => numero(a[c]) !== null,
    );
    if (temPreco) mudou.push(`lojas:${a.lojaId}`);
  }

  // Faixas de preço por quantidade: só as que o usuário vê entram (as de outras lojas não vêm e são preservadas).
  const chaveFaixa = (f: {
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }) => `${f.lojaId}:${numero(f.quantidadeInicial)}:${numero(f.quantidadeFinal)}:${numero(f.preco)}`;
  const faixaVisivel = (f: { lojaId: string | null }) => f.lojaId === null || ctx.lojaVisivel(f.lojaId);
  if (
    antes.precosQuantidade.filter(faixaVisivel).map(chaveFaixa).sort().join('|') !==
    d.precosQuantidade.map(chaveFaixa).sort().join('|')
  )
    mudou.push('precosQuantidade');

  // Complementos (F2-B51) e alternativas do combo (8.2.17): o preço adicional do complemento e o acréscimo da
  // alternativa são cobrados do cliente na venda. A opção casada pelo id não muda o valor (ativa ou inativa: o valor da
  // inativa é o que vale quando ela volta) nem, com valor, a chave; a que entra na venda segue `OpcoesDaVenda` (valor 0
  // = sem preço). Inativar ou tirar a opção não conta.
  const minusculo = (v: string | null) => v?.toLowerCase() ?? null;
  const chaveComplemento = (c: { produtoId: string | null; descricao: string | null }) =>
    c.produtoId ? `p:${c.produtoId.toLowerCase()}` : `d:${(c.descricao ?? '').toLocaleLowerCase('pt-BR')}`;
  if (d.gruposComplementos !== undefined) {
    // Casamento de `gravarComplementos`: o grupo pelo id entre os do produto, o complemento pelo id entre os do grupo
    // casado, cada gravado uma vez só. A lista ausente mantém os gravados (planilha, cadastro em massa, ERP antigo).
    const gruposUsados = new Set<string>();
    const itensUsados = new Set<string>();
    const casados = d.gruposComplementos.map((g) => {
      const grupo = antes.gruposComplementos.find((x) => x.id === minusculo(g.id) && !gruposUsados.has(x.id));
      if (grupo) gruposUsados.add(grupo.id);
      return g.complementos.map((c) => {
        const a = grupo?.complementos.find((x) => x.id === minusculo(c.id) && !itensUsados.has(x.id));
        if (a) itensUsados.add(a.id);
        return a;
      });
    });
    const fica = new Set(
      d.gruposComplementos.flatMap((g, i) =>
        g.complementos.flatMap((c, j) => {
          const a = casados[i]![j];
          return a && a.ativo && c.ativo && chaveComplemento(a) === chaveComplemento(c) ? [a.id] : [];
        }),
      ),
    );
    const opcoes = new OpcoesDaVenda();
    for (const g of antes.gruposComplementos)
      for (const a of g.complementos) {
        if (a.ativo && !fica.has(a.id)) opcoes.sai(chaveComplemento(a), String(Number(a.precoAdicional)));
        else opcoes.fica(chaveComplemento(a), Number(a.precoAdicional) !== 0);
      }
    opcoes.excluidas(ctx.excluidas.complementos, chaveComplemento, (c) => Number(c.precoAdicional) !== 0);
    d.gruposComplementos.forEach((g, i) =>
      g.complementos.forEach((c, j) => {
        const a = casados[i]![j];
        const preco = Number(c.precoAdicional);
        const chave = chaveComplemento(c);
        const alterado = a && Number(a.precoAdicional) !== preco;
        const outraChave = a && preco !== 0 && chaveComplemento(a) !== chave;
        const entra =
          c.ativo &&
          !(a && a.ativo && chaveComplemento(a) === chave) &&
          opcoes.entraMudando(chave, String(preco), preco !== 0);
        if (alterado || outraChave || entra)
          mudou.push(`gruposComplementos.${i}.complementos.${j}.precoAdicional`);
      }),
    );
  }

  // Alternativas do combo: casamento de `gravarFilhas` (a posição pelo id e o tipo entre as do produto, a alternativa
  // pelo id entre as da posição).
  const chaveAlternativa = (a: { produtoId: string; variacaoId: string | null }) =>
    `${a.produtoId.toLowerCase()}:${a.variacaoId?.toLowerCase() ?? ''}`;
  const casadas = d.componentes.map((c) => {
    if (c.tipo !== 'kit') return [];
    const posicao = c.id ? antes.componentes.find((e) => e.id === c.id && e.tipo === c.tipo) : undefined;
    return c.alternativas.map((alt) =>
      alt.id ? posicao?.alternativas.find((x) => x.id === alt.id) : undefined,
    );
  });
  const ficaAlternativa = new Set(
    d.componentes.flatMap((c, i) =>
      c.alternativas.flatMap((alt, j) => {
        const a = casadas[i]![j];
        return a && a.ativo && alt.ativo && chaveAlternativa(a) === chaveAlternativa(alt) ? [a.id] : [];
      }),
    ),
  );
  const alternativas = new OpcoesDaVenda();
  for (const c of antes.componentes)
    if (c.tipo === 'kit')
      for (const a of c.alternativas) {
        if (a.ativo && !ficaAlternativa.has(a.id))
          alternativas.sai(chaveAlternativa(a), String(Number(a.acrescimo)));
        else alternativas.fica(chaveAlternativa(a), Number(a.acrescimo) !== 0);
      }
  alternativas.excluidas(ctx.excluidas.alternativas, chaveAlternativa, (a) => Number(a.acrescimo) !== 0);
  d.componentes.forEach((c, i) => {
    if (c.tipo !== 'kit') return;
    c.alternativas.forEach((alt, j) => {
      const a = casadas[i]![j];
      const preco = Number(alt.acrescimo);
      const chave = chaveAlternativa(alt);
      const alterado = a && Number(a.acrescimo) !== preco;
      const outraChave = a && preco !== 0 && chaveAlternativa(a) !== chave;
      const entra =
        alt.ativo &&
        !(a && a.ativo && chaveAlternativa(a) === chave) &&
        alternativas.entraMudando(chave, String(preco), preco !== 0);
      if (alterado || outraChave || entra) mudou.push(`componentes.${i}.alternativas.${j}.acrescimo`);
    });
  });

  return mudou;
}
