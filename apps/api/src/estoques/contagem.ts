/**
 * Importação de contagem e folha de contagem (Fase 2, F2-B9; ERP 13.5 "Importar contagem" e "Imprimir"; README da
 * API › decisão 154): o arquivo do coletor ou da planilha (`código;quantidade`) vira itens do rascunho de um "Definir",
 * com o fator do código de barras de embalagem aplicado e as leituras repetidas somadas, a prévia dos códigos que não
 * entram, a opção "Zerar os não contados" e a divisão automática acima de 5.000 itens em rascunhos com a mesma hora
 * da contagem. A folha de contagem lista os produtos com estoque próprio do estoque × tipo, com ou sem o saldo.
 */
import {
  LIMITE_ITENS_ACERTO,
  LIMITE_LINHAS_CONTAGEM,
  LIMITE_LINHAS_FOLHA_CONTAGEM,
  MAXIMO_QUANTIDADE_ACERTO,
  consolidarContagem,
  dec,
  decTexto,
  dividirEmRascunhos,
  lerArquivoContagem,
  type FiltroFolhaContagem,
  type FolhaContagem,
  type ItemPreviaContagem,
  type OpcoesImportarContagem,
  type PreviaContagem,
  type ProblemaContagem,
  type ProdutoContagem,
  type ResolucaoCodigoContagem,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { ErroApi } from '../comum/erros.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { TIPOS_SEM_ESTOQUE, gravarItensRascunho, type ItemGravar } from './acertos.js';

/** Literal de array do Postgres com cada texto entre aspas (vírgula, chave e aspas do código lido não quebram). */
const arrayTexto = (v: readonly string[]) =>
  `{${[...new Set(v)].map((x) => `"${x.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;

const MENSAGEM_SEM_ESTOQUE: Record<string, string> = {
  kit: 'Combo não tem estoque próprio: conte os componentes',
  produzido: 'Produto produzido não tem estoque próprio: conte os insumos da ficha técnica',
  servico: 'Serviço não tem estoque',
};

interface Casamento {
  produto: ProdutoContagem;
  tipo: string;
  controlaEstoque: boolean;
  variacaoId: string | null;
  fator: string;
}

/**
 * O que cada código lido é (F2-B9): código de barras (`produtos_codigos_barras`, com o fator da embalagem), código
 * interno do produto (fator 1, sem diferença de maiúsculas) ou código interno de variação. O código que casa com mais
 * de um produto (o EAN duplicado entre produtos, `geral.ean_duplicado = 'avisar'`, ou o código interno de um igual ao
 * código de barras de outro), ou com o mesmo produto em fatores diferentes, é ambíguo e não grava. Combo, produzido,
 * serviço e produto sem controle de estoque são recusados como no acerto; a variação e o produto "Com variações"
 * contado no pai também (variações travadas até a D43, F2-B1).
 */
export async function resolverCodigosContagem(
  db: DbEmpresa,
  codigos: readonly string[],
): Promise<Map<string, ResolucaoCodigoContagem>> {
  const unicos = [...new Set(codigos)];
  const mapa = new Map<string, ResolucaoCodigoContagem>();
  if (!unicos.length) return mapa;
  const { rows } = await db.execute<{
    lido: string;
    interno: boolean;
    produto_id: string;
    variacao_id: string | null;
    fator: string;
    codigo: number;
    nome: string;
    tipo: string;
    controla_estoque: boolean;
    sigla: string;
  }>(sql`
    select x.lido, x.interno, x.produto_id, x.variacao_id, x.fator, p.codigo, p.nome, p.tipo, p.controla_estoque, u.sigla
      from (
        select cb.codigo as lido, false as interno, cb.produto_id, cb.variacao_id, cb.fator::text as fator
          from produtos_codigos_barras cb
         where cb.excluido_em is null and cb.codigo = any(${arrayTexto(unicos)}::text[])
        union all
        select lower(p.codigo_interno), true, p.id, null, '1.000'
          from produtos p
         where p.excluido_em is null and p.codigo_interno is not null
           and lower(p.codigo_interno) = any(${arrayTexto(unicos.map((c) => c.toLowerCase()))}::text[])
        union all
        select lower(v.codigo_interno), true, v.produto_id, v.id, '1.000'
          from produtos_variacoes v
         where v.excluido_em is null and v.codigo_interno is not null
           and lower(v.codigo_interno) = any(${arrayTexto(unicos.map((c) => c.toLowerCase()))}::text[])
      ) x
      join produtos p on p.id = x.produto_id and p.excluido_em is null
      join unidades_medida u on u.id = p.unidade_id`);
  const porCodigo = new Map<string, Casamento[]>();
  const juntar = (chave: string, c: Casamento) => {
    const lista = porCodigo.get(chave) ?? [];
    if (
      !lista.some(
        (x) => x.produto.id === c.produto.id && x.variacaoId === c.variacaoId && x.fator === c.fator,
      )
    )
      lista.push(c);
    porCodigo.set(chave, lista);
  };
  // O código de barras casa exato; o interno sem diferença de maiúsculas (a consulta o devolve minúsculo). O índice
  // dos códigos lidos deixa o casamento linear (o arquivo pode ter dezenas de milhares de códigos distintos).
  const lidosPorMinusculo = new Map<string, string[]>();
  for (const lido of unicos) {
    const chave = lido.toLowerCase();
    const lista = lidosPorMinusculo.get(chave) ?? [];
    lista.push(lido);
    lidosPorMinusculo.set(chave, lista);
  }
  for (const r of rows) {
    const c: Casamento = {
      produto: { id: r.produto_id, codigo: r.codigo, nome: r.nome, unidadeSigla: r.sigla },
      tipo: r.tipo,
      controlaEstoque: r.controla_estoque,
      variacaoId: r.variacao_id,
      fator: decTexto(r.fator, 3),
    };
    for (const lido of r.interno ? (lidosPorMinusculo.get(r.lido) ?? []) : [r.lido]) juntar(lido, c);
  }
  for (const lido of unicos) {
    const casados = porCodigo.get(lido) ?? [];
    if (!casados.length) {
      mapa.set(lido, { situacao: 'nao_encontrado' });
      continue;
    }
    if (casados.length > 1) {
      const produtos = [...new Map(casados.map((c) => [c.produto.id, c.produto])).values()];
      mapa.set(lido, { situacao: 'ambiguo', produtos });
      continue;
    }
    const c = casados[0]!;
    if (c.variacaoId || c.tipo === 'com_variacoes')
      mapa.set(lido, {
        situacao: 'com_variacoes',
        produto: c.produto,
        mensagem:
          'Produto com variações: a contagem por variação chega com as variações (contado no pai, não grava)',
      });
    else if ((TIPOS_SEM_ESTOQUE as readonly string[]).includes(c.tipo))
      mapa.set(lido, {
        situacao: 'sem_estoque',
        produto: c.produto,
        mensagem: MENSAGEM_SEM_ESTOQUE[c.tipo]!,
      });
    else if (!c.controlaEstoque)
      mapa.set(lido, {
        situacao: 'sem_estoque',
        produto: c.produto,
        mensagem: 'Produto sem controle de estoque',
      });
    else mapa.set(lido, { situacao: 'encontrado', produto: c.produto, fator: c.fator });
  }
  return mapa;
}

/** O acerto em rascunho que recebe a contagem (já travado e conferido pelo controller). */
export interface AcertoContagem {
  id: string;
  estoqueId: string;
  tipoEstoqueId: string;
}

/** Um rascunho "Definir" da mesma contagem (o mesmo estoque, tipo e hora: os de uma divisão anterior). */
export interface OutroRascunhoContagem {
  id: string;
  codigo: number;
  /** A lista inteira do rascunho, com a quantidade nova dos produtos que o arquivo trouxe. */
  itens: ItemGravar[];
}

/**
 * O que a gravação faz: os itens do rascunho atual (os gravados e os novos), os dos rascunhos novos da divisão e os
 * dos outros rascunhos da mesma contagem em que um produto do arquivo já estava.
 */
export interface PlanoContagem {
  previa: PreviaContagem;
  /** Índice 0 = este acerto (lista inteira, com os itens que já estavam); 1… = os rascunhos novos. */
  rascunhos: ItemGravar[][];
  /** Os outros rascunhos da mesma contagem que a gravação altera (só os que têm produto do arquivo). */
  outros: OutroRascunhoContagem[];
  /** Nenhum item novo, alterado ou zerado (o arquivo só com problemas): a gravação recusa com 422. */
  nadaAGravar: boolean;
}

const listarLinhas = (l: readonly number[]) =>
  l.length > 10 ? `${l.slice(0, 10).join(', ')}… (${l.length})` : l.join(', ');

/**
 * Lê o arquivo, resolve os códigos e monta a prévia e o plano da gravação (F2-B9). A contagem é o grupo dos rascunhos
 * "Definir" do mesmo estoque, tipo e hora (este e os de uma divisão anterior): o produto que já é item de algum deles
 * recebe a soma ou a troca (`itensExistentes`) no rascunho em que está, para não ficar em dois "Definir" da mesma hora
 * (o último efetivado venceria, sem somar). Na gravação os outros rascunhos do grupo são travados (`for update`, em
 * ordem de id). "Zerar os não contados" acrescenta, com contado 0, os produtos com saldo diferente de zero no estoque
 * × tipo que não estão no arquivo nem já no grupo; o produto do arquivo com leitura recusada (código ambíguo, linha
 * inválida com código, total acima do máximo) foi contado e também não é zerado. Os itens novos ocupam o que cabe
 * deste rascunho até 5.000 e o resto vai para rascunhos novos (`dividirEmRascunhos`).
 */
export async function planejarContagem(
  db: DbEmpresa,
  acerto: AcertoContagem,
  arquivo: { nome: string; texto: string },
  opcoes: OpcoesImportarContagem,
): Promise<PlanoContagem> {
  const lido = lerArquivoContagem(arquivo.texto);
  if (lido.linhas > LIMITE_LINHAS_CONTAGEM)
    throw new ErroApi(
      'VALIDACAO',
      `O arquivo tem mais de ${LIMITE_LINHAS_CONTAGEM.toLocaleString('pt-BR')} linhas.`,
      {
        campos: { arquivo: ['Arquivo grande demais: divida a contagem'] },
      },
    );
  if (!lido.linhas)
    throw new ErroApi('VALIDACAO', 'O arquivo não tem nenhuma leitura.', {
      campos: { arquivo: ['Arquivo vazio'] },
    });
  // Os códigos das linhas inválidas também são resolvidos: o produto da linha com quantidade ruim foi contado.
  const codigosInvalidas = lido.invalidas.flatMap((i) => (i.codigo ? [i.codigo] : []));
  const resolucoes = await resolverCodigosContagem(db, [
    ...lido.leituras.map((l) => l.codigo),
    ...codigosInvalidas,
  ]);
  const { itens: consolidados, problemas } = consolidarContagem(lido.leituras, (c) => resolucoes.get(c)!);
  const invalidas: ProblemaContagem[] = lido.invalidas.map((i) => ({
    tipo: 'linha_invalida',
    codigo: i.codigo,
    linhas: [i.linha],
    leituras: 1,
    quantidadeLida: null,
    mensagem: `${i.mensagem}: "${i.conteudo}"`,
    produtos: [],
  }));
  // Os produtos que o arquivo trouxe, mas com a leitura recusada: "Zerar" não os zera.
  const comProblema = new Set<string>();
  for (const p of problemas) for (const x of p.produtos) comProblema.add(x.id);
  for (const c of codigosInvalidas) {
    const r = resolucoes.get(c);
    if (r?.situacao === 'ambiguo') for (const x of r.produtos) comProblema.add(x.id);
    else if (r && r.situacao !== 'nao_encontrado') comProblema.add(r.produto.id);
  }

  const { rows: grupo } = await db.execute<{ id: string; codigo: number }>(sql`
    select a.id, a.codigo from acertos_estoque a
      join acertos_estoque o on o.id = ${acerto.id}
     where a.id <> o.id and a.excluido_em is null and a.status = 'rascunho' and a.tipo_ajuste = 'definir'
       and a.estoque_id = o.estoque_id and a.tipo_estoque_id = o.tipo_estoque_id
       and a.data_contagem = o.data_contagem
     order by a.id
     ${opcoes.modo === 'gravar' ? sql`for update of a` : sql``}`);
  const codigoDoOutro = new Map(grupo.map((g) => [g.id, g.codigo]));
  const { rows: itensGrupo } = await db.execute<{
    id: string;
    acerto_id: string;
    produto_id: string;
    variacao_id: string | null;
    lote_id: string | null;
    q: string;
  }>(sql`
    select id, acerto_id, produto_id, variacao_id, lote_id, quantidade_informada::text as q
      from itens_acerto_estoque
     where acerto_id = any(${`{${[acerto.id, ...grupo.map((g) => g.id)].join(',')}}`}::uuid[])
       and excluido_em is null
     order by sequencia`);
  const atuais = itensGrupo.filter((a) => a.acerto_id === acerto.id);
  // O item deste rascunho vence o de outro (o mesmo produto em dois rascunhos, posto à mão antes).
  const atualDoProduto = new Map<string, (typeof itensGrupo)[number]>();
  for (const a of itensGrupo)
    if (!a.variacao_id && !a.lote_id && (a.acerto_id === acerto.id || !atualDoProduto.has(a.produto_id)))
      atualDoProduto.set(a.produto_id, a);

  const itens: ItemPreviaContagem[] = [];
  const contados: typeof consolidados = [];
  const novos: ItemGravar[] = [];
  const alterados = new Map<string, string>();
  const alteradosEmOutro = new Set<string>();
  for (const c of consolidados) {
    const atual = atualDoProduto.get(c.produto.id);
    const final =
      atual && opcoes.itensExistentes === 'somar'
        ? decTexto(dec(atual.q).plus(c.quantidade), 3)
        : c.quantidade;
    if (dec(final).gt(MAXIMO_QUANTIDADE_ACERTO)) {
      comProblema.add(c.produto.id);
      problemas.push({
        tipo: 'acima_do_maximo',
        codigo: c.codigos
          .map((x) => x.codigo)
          .join(', ')
          .slice(0, 80),
        linhas: lido.leituras.filter((l) => c.codigos.some((x) => x.codigo === l.codigo)).map((l) => l.linha),
        leituras: c.leituras,
        quantidadeLida: decTexto(
          c.codigos.reduce((s, x) => s.plus(x.quantidadeLida), dec(0)),
          3,
        ),
        mensagem: `Somado ao já gravado (${decTexto(atual!.q, 3)}), o total passa de ${MAXIMO_QUANTIDADE_ACERTO.toLocaleString('pt-BR')}: confira as quantidades lidas`,
        produtos: [c.produto],
      });
      continue;
    }
    contados.push(c);
    const outro = atual && atual.acerto_id !== acerto.id ? atual.acerto_id : null;
    if (atual) {
      alterados.set(atual.id, final);
      if (outro) alteradosEmOutro.add(outro);
    } else
      novos.push({
        id: null,
        produtoId: c.produto.id,
        variacaoId: null,
        loteId: null,
        quantidade: final,
        custoUnitario: null,
      });
    itens.push({
      produto: c.produto,
      quantidadeArquivo: c.quantidade,
      quantidadeAnterior: atual ? decTexto(atual.q, 3) : null,
      quantidadeFinal: final,
      leituras: c.leituras,
      codigos: c.codigos,
      zerado: false,
      rascunho: 0,
      outroAcerto: outro ? codigoDoOutro.get(outro)! : null,
    });
  }

  let zerados = 0;
  if (opcoes.zerarNaoContados) {
    const foraDoZerar = [...contados.map((c) => c.produto.id), ...comProblema];
    const { rows } = await db.execute<{ id: string; codigo: number; nome: string; sigla: string }>(sql`
      select p.id, p.codigo, p.nome, u.sigla
        from saldos_estoque s
        join produtos p on p.id = s.produto_id
        join unidades_medida u on u.id = p.unidade_id
       where s.estoque_id = ${acerto.estoqueId} and s.tipo_estoque_id = ${acerto.tipoEstoqueId}
         and s.variacao_id is null and s.quantidade <> 0
         and p.excluido_em is null and p.controla_estoque
         and p.tipo not in ('kit','servico','produzido','com_variacoes')
         and not (p.id = any(${`{${foraDoZerar.join(',')}}`}::uuid[]))
         and not exists (
           select 1 from itens_acerto_estoque i join acertos_estoque a on a.id = i.acerto_id
            where i.produto_id = p.id and i.excluido_em is null and a.excluido_em is null
              and a.status = 'rascunho' and a.tipo_ajuste = 'definir'
              and a.estoque_id = ${acerto.estoqueId} and a.tipo_estoque_id = ${acerto.tipoEstoqueId}
              and a.data_contagem = (select data_contagem from acertos_estoque where id = ${acerto.id}))
       order by lower(fn_unaccent(p.nome)), p.codigo`);
    for (const r of rows) {
      zerados += 1;
      novos.push({
        id: null,
        produtoId: r.id,
        variacaoId: null,
        loteId: null,
        quantidade: '0.000',
        custoUnitario: null,
      });
      itens.push({
        produto: { id: r.id, codigo: r.codigo, nome: r.nome, unidadeSigla: r.sigla },
        quantidadeArquivo: '0.000',
        quantidadeAnterior: null,
        quantidadeFinal: '0.000',
        leituras: 0,
        codigos: [],
        zerado: true,
        rascunho: 0,
        outroAcerto: null,
      });
    }
  }

  // A divisão: os itens que já estão no rascunho ficam nele; os novos enchem o que cabe e abrem os próximos.
  const comoGravar = (a: (typeof itensGrupo)[number]): ItemGravar => ({
    id: a.id,
    produtoId: a.produto_id,
    variacaoId: a.variacao_id,
    loteId: a.lote_id,
    quantidade: alterados.get(a.id) ?? a.q,
    custoUnitario: null,
  });
  const destino = dividirEmRascunhos(atuais.length, novos.length);
  const rascunhos: ItemGravar[][] = [atuais.map(comoGravar)];
  const indiceDoNovo = new Map<string, number>();
  novos.forEach((n, i) => {
    const r = destino[i]!;
    (rascunhos[r] ??= []).push(n);
    indiceDoNovo.set(n.produtoId, r);
  });
  for (const it of itens) it.rascunho = indiceDoNovo.get(it.produto.id) ?? 0;
  const outros: OutroRascunhoContagem[] = grupo
    .filter((g) => alteradosEmOutro.has(g.id))
    .map((g) => ({
      id: g.id,
      codigo: g.codigo,
      itens: itensGrupo.filter((a) => a.acerto_id === g.id).map(comoGravar),
    }));

  const todosProblemas = [...invalidas, ...problemas].sort((a, b) => a.linhas[0]! - b.linhas[0]!);
  const leiturasRecusadas = todosProblemas.reduce((s, p) => s + p.leituras, 0);
  const avisos: string[] = [];
  if (lido.cabecalho) avisos.push(`A primeira linha foi ignorada como cabeçalho: "${lido.cabecalho}".`);
  if (rascunhos.length > 1)
    avisos.push(
      `A contagem fica com ${(atuais.length + novos.length).toLocaleString('pt-BR')} itens, acima do limite de ${LIMITE_ITENS_ACERTO.toLocaleString('pt-BR')} por acerto: ela ocupa ${rascunhos.length} rascunhos, todos com a mesma hora da contagem. Efetive todos.`,
    );
  if (alterados.size)
    avisos.push(
      opcoes.itensExistentes === 'somar'
        ? `${alterados.size} produto(s) já estavam no rascunho: a quantidade do arquivo é somada à gravada.`
        : `${alterados.size} produto(s) já estavam no rascunho: a quantidade do arquivo substitui a gravada.`,
    );
  if (outros.length)
    avisos.push(
      `Parte desses produtos está em outro rascunho desta contagem (Nº ${outros.map((o) => o.codigo).join(', ')}): a quantidade é gravada lá, para o produto não ficar em dois rascunhos da mesma hora.`,
    );
  if (lido.milharAmbiguo.length)
    avisos.push(
      `${lido.milharAmbiguo.length} leitura(s) com um só ponto ou vírgula seguido de 3 dígitos (linha ${listarLinhas(lido.milharAmbiguo)}) foram lidas como casa decimal ("1.000" = 1; "2,500" = 2,5). Se a planilha usa separador de milhar, salve a quantidade sem ele (formato Geral) e importe de novo.`,
    );
  if (leiturasRecusadas)
    avisos.push(`${leiturasRecusadas} leitura(s) não entram no rascunho: confira os problemas abaixo.`);
  if (opcoes.zerarNaoContados && comProblema.size)
    avisos.push(
      `${comProblema.size} produto(s) do arquivo com leitura recusada (código ambíguo, linha inválida ou acima do máximo) não são zerados: corrija o arquivo e importe de novo.`,
    );
  const unidades = contados.reduce((s, c) => s.plus(c.quantidade), dec(0));
  return {
    rascunhos,
    outros,
    nadaAGravar: novos.length === 0 && alterados.size === 0,
    previa: {
      arquivo: arquivo.nome,
      separador: lido.separador,
      cabecalho: lido.cabecalho,
      linhas: lido.linhas,
      leituras: lido.leituras.length,
      itens,
      problemas: todosProblemas,
      totais: {
        produtos: contados.length,
        novos: novos.length - zerados,
        alterados: alterados.size,
        zerados,
        leiturasRecusadas,
        unidades: decTexto(unidades, 3),
      },
      rascunhos: rascunhos.length,
      avisos,
      gravado: false,
      acertos: [],
      outrosAcertos: outros.map((o) => ({ id: o.id, codigo: o.codigo, qtdItens: o.itens.length })),
    },
  };
}

/**
 * Grava o plano (F2-B9): o rascunho atual com a lista inteira (os itens que já tinha, com a quantidade nova quando o
 * arquivo os trouxe, e os novos que couberam), um rascunho novo por parte excedente, copiando o cabeçalho (estoque,
 * tipo, "Definir", a mesma hora da contagem, motivo e responsável), com a observação de que continua este acerto, e
 * os outros rascunhos da mesma contagem em que o arquivo somou ou trocou um item (já travados pelo plano; o autor da
 * alteração muda, e com ele a versão). Os totais saem de `gravarItensRascunho`, como no PUT. Sem nada a gravar (o
 * arquivo só com problemas), 422. Devolve os acertos gravados (o atual primeiro) e os outros alterados.
 */
export async function gravarContagem(
  tx: DbEmpresa,
  acerto: AcertoContagem,
  plano: PlanoContagem,
  usuarioId: string,
): Promise<Pick<PreviaContagem, 'acertos' | 'outrosAcertos'>> {
  const cabecalho = {
    estoqueId: acerto.estoqueId,
    tipoEstoqueId: acerto.tipoEstoqueId,
    tipoAjuste: 'definir' as const,
  };
  if (plano.nadaAGravar)
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Nenhum produto do arquivo pode ser gravado: confira os problemas da prévia.',
    );
  await gravarItensRascunho(tx, { id: acerto.id, ...cabecalho }, plano.rascunhos[0]!);
  const { rows } = await tx.execute<{
    codigo: number;
    motivo: string;
    responsavel_id: string;
    observacoes: string | null;
  }>(sql`select codigo, motivo, responsavel_id, observacoes from acertos_estoque where id = ${acerto.id}`);
  const a = rows[0]!;
  const gravados: PreviaContagem['acertos'] = [
    { id: acerto.id, codigo: a.codigo, qtdItens: plano.rascunhos[0]!.length },
  ];
  for (const itens of plano.rascunhos.slice(1)) {
    const id = uuidv7();
    const nota = `Continuação do acerto Nº ${a.codigo} (importação de contagem acima de ${LIMITE_ITENS_ACERTO.toLocaleString('pt-BR')} itens, ${plano.previa.arquivo}).`;
    await tx.execute(sql`
      insert into acertos_estoque (id, estoque_id, tipo_estoque_id, tipo_ajuste, data_contagem, motivo, responsavel_id,
                                   observacoes, origem, criado_por_id, atualizado_por_id)
      select ${id}, ${acerto.estoqueId}, ${acerto.tipoEstoqueId}, 'definir', o.data_contagem, ${a.motivo},
             ${a.responsavel_id}, ${[a.observacoes, nota].filter(Boolean).join('\n').slice(0, 2000)}, 'manual',
             ${usuarioId}, ${usuarioId}
        from acertos_estoque o where o.id = ${acerto.id}`);
    await gravarItensRascunho(tx, { id, ...cabecalho }, itens);
    const { rows: c } = await tx.execute<{ codigo: number }>(
      sql`select codigo from acertos_estoque where id = ${id}`,
    );
    gravados.push({ id, codigo: c[0]!.codigo, qtdItens: itens.length });
  }
  for (const o of plano.outros) {
    await gravarItensRascunho(tx, { id: o.id, ...cabecalho }, o.itens);
    await tx.execute(sql`update acertos_estoque set atualizado_por_id = ${usuarioId} where id = ${o.id}`);
  }
  return {
    acertos: gravados,
    outrosAcertos: plano.outros.map((o) => ({ id: o.id, codigo: o.codigo, qtdItens: o.itens.length })),
  };
}

/**
 * Folha de contagem (F2-B9; ERP 13.5 "Imprimir"): os produtos com estoque próprio e controle de estoque (fora combo,
 * produzido, serviço e "Com variações", que a contagem recusa), ativos ou inativos com saldo, do estoque × tipo, por
 * localização (vazia por último) ou por nome, filtráveis por marca e categoria (com as subcategorias). A folha cega
 * não traz o saldo. Recusa acima de 20.000 linhas (filtre por marca ou categoria).
 */
export async function folhaContagem(
  db: DbEmpresa,
  filtro: FiltroFolhaContagem,
  visivel: SQL | undefined,
): Promise<FolhaContagem> {
  const { rows: est } = await db.execute<{ nome: string }>(sql`
    select e.nome from estoques e where e.id = ${filtro.estoqueId} and e.excluido_em is null
      ${visivel ? sql`and ${visivel}` : sql``}`);
  if (!est[0]) throw ErroApi.naoEncontrado('Estoque não encontrado.');
  const { rows: tipo } = await db.execute<{ id: string; nome: string }>(
    filtro.tipoEstoqueId
      ? sql`select id, nome from tipos_estoque where id = ${filtro.tipoEstoqueId} and excluido_em is null`
      : sql`select id, nome from tipos_estoque where padrao and excluido_em is null limit 1`,
  );
  if (!tipo[0])
    throw new ErroApi('VALIDACAO', 'Tipo de estoque não encontrado.', {
      campos: { tipoEstoqueId: ['Tipo inexistente'] },
    });
  const { rows: nomes } = await db.execute<{ marca: string | null; categoria: string | null }>(sql`
    select (select descricao from marcas where id = ${filtro.marcaId ?? null}::uuid) as marca,
           (select caminho_nomes from categorias where id = ${filtro.categoriaId ?? null}::uuid) as categoria`);
  const condicoes: SQL[] = [
    sql`p.excluido_em is null`,
    sql`p.controla_estoque`,
    sql`p.tipo not in ('kit','servico','produzido','com_variacoes')`,
    sql`(p.ativo or coalesce(s.quantidade, 0) <> 0)`,
  ];
  if (filtro.marcaId) condicoes.push(sql`p.marca_id = ${filtro.marcaId}`);
  if (filtro.categoriaId)
    condicoes.push(sql`exists (select 1 from produtos_categorias pc join categorias c on c.id = pc.categoria_id
                                 join categorias alvo on alvo.id = ${filtro.categoriaId}
                                where pc.produto_id = p.id and pc.excluido_em is null
                                  and (c.caminho = alvo.caminho or c.caminho like alvo.caminho || '/%'))`);
  const ordem =
    filtro.ordem === 'localizacao'
      ? sql`p.localizacao is null, lower(p.localizacao), lower(fn_unaccent(p.nome)), p.codigo`
      : sql`lower(fn_unaccent(p.nome)), p.codigo`;
  const { rows } = await db.execute<{
    id: string;
    codigo: number;
    codigo_interno: string | null;
    codigo_barras: string | null;
    nome: string;
    sigla: string;
    localizacao: string | null;
    marca: string | null;
    saldo: string;
  }>(sql`
    select p.id, p.codigo, p.codigo_interno, p.nome, u.sigla, p.localizacao, m.descricao as marca,
           coalesce(s.quantidade, 0)::text as saldo,
           (select cb.codigo from produtos_codigos_barras cb
             where cb.produto_id = p.id and cb.excluido_em is null and cb.variacao_id is null and cb.fator = 1
             order by cb.principal desc, cb.criado_em, cb.id limit 1) as codigo_barras
      from produtos p
      join unidades_medida u on u.id = p.unidade_id
      left join marcas m on m.id = p.marca_id
      left join saldos_estoque s on s.estoque_id = ${filtro.estoqueId} and s.tipo_estoque_id = ${tipo[0].id}
                                and s.produto_id = p.id and s.variacao_id is null
     where ${sql.join(condicoes, sql` and `)}
     order by ${ordem}
     limit ${LIMITE_LINHAS_FOLHA_CONTAGEM + 1}`);
  if (rows.length > LIMITE_LINHAS_FOLHA_CONTAGEM)
    throw new ErroApi(
      'REGRA_NEGOCIO',
      `A folha passa de ${LIMITE_LINHAS_FOLHA_CONTAGEM.toLocaleString('pt-BR')} produtos: filtre por marca ou categoria.`,
    );
  return {
    estoqueNome: est[0].nome,
    tipoEstoqueNome: tipo[0].nome,
    cega: filtro.cega,
    ordem: filtro.ordem,
    marca: nomes[0]?.marca ?? null,
    categoria: nomes[0]?.categoria ?? null,
    geradaEm: new Date().toISOString(),
    linhas: rows.map((r) => ({
      produtoId: r.id,
      codigo: r.codigo,
      codigoInterno: r.codigo_interno,
      codigoBarras: r.codigo_barras,
      nome: r.nome,
      unidadeSigla: r.sigla,
      localizacao: r.localizacao,
      marca: r.marca,
      saldo: filtro.cega ? null : decTexto(r.saldo, 3),
    })),
  };
}
