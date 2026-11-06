/**
 * Handler do `venda.finalizada` (SYNC 9.7, 10.2; bloco C6b da 1C): grava a venda inteira que veio do caixa (cabeçalho,
 * itens, complementos, pagamentos, parcelas, TEF e PIX), lança o estoque com o motor do documento (C6a,
 * `lancarDocumento`) **antes** do `INSERT` da venda, para o custo de cada item já entrar nele, e atualiza
 * `numeracoes`, os alertas e a relevância `compra` do cliente. O financeiro (contas a receber, consolidação, vale,
 * crédito) é da Fase 4; a comissão não existe no balcão (O24 do dono, `vendedor_id` nulo).
 *
 * Regras do estoque (SYNC 10.2, com as decisões da 1C, README da API › decisão 133):
 * - estoque = `contexto.estoque_id` do envelope se ainda for válido; senão `lojas.estoque_id` atual, com o alerta
 *   `ESTOQUE_CONTEXTO_INVALIDO` quando o contexto trazia um estoque que deixou de valer. Tipo = o `padrao` (Disponível);
 * - baixa o item não cancelado cujo produto, **pelo valor atual da nuvem**, controla estoque e não é `kit`,
 *   `produzido` nem `servico` (o combo chega desmembrado em componentes, que são itens; o produzido não tem saldo
 *   próprio, D17). O item com `componentes_estoque` (ficha técnica, aceitando o legado `origem = 'kit'`) baixa a lista
 *   como `BAIXA_INSUMO` no lugar dele; o mesmo insumo do mesmo item vira um movimento só com a soma (T4);
 * - o casco cobrado (`vasilhame_item_origem_id`) sai como `VASILHAME_VENDIDO` no lugar do `VENDA_PDV`; os cascos
 *   trazidos (`vasilhames[].devolvidos`) entram como `VASILHAME_DEVOLVIDO` no tipo `vasilhame_vazio`, com o
 *   `documento_item_id` derivado da venda (T4); `emprestados` > 0 (comodato) é da Fase 3 e recusa o evento;
 * - quantidade na unidade base (o PDV já multiplica o fardo), com `unidade_documento`/`fator` do código lido;
 *   `data_movimento = finalizada_em`; saldo negativo nunca recusa (15.1, O15 do dono): vira um `ESTOQUE_NEGATIVO`
 *   deduplicado por estoque, produto e variação;
 * - movimento anterior à contagem de um "Definir" já efetivado ganha um `ACERTO_COMPENSACAO` de sinal oposto contra o
 *   último "Definir" da linha (15.3; ERP 13.1.5 regra 3; T23 no índice de idempotência), pela `compensarDefinir` do
 *   motor (`estoques/compensacao.ts`, F2-B4), a mesma do cancelamento, dos cascos e dos documentos do ERP.
 *
 * Custo (SYNC 10.2): `itens_venda.custo_unitario = Σ custo_total dos movimentos do item ÷ quantidade`, e
 * `vendas.custo_total` = Σ dos itens não cancelados. Item sem baixa (não controla estoque, serviço, produzido sem a
 * ficha no payload) fica com o custo de referência do cadastro (`preco_custo`; T22); no item com ficha, o insumo que
 * não baixa entra pelo custo de referência dele (`preco_custo × quantidade`, T22); item cancelado, sem custo.
 *
 * Conferências que não recusam (SYNC 9.7 "Fechamento das contas" e "Itens de combo", P6; 16.2): as somas da venda
 * (pagamentos aprovados × total, troco, subtotal, valor líquido de cada item e o grupo do combo) e o produto já
 * excluído ou inativo antes da venda viram os alertas `VENDA_INCONSISTENTE` e `PRODUTO_INATIVO_VENDIDO`; a venda
 * grava como veio.
 *
 * Idempotência (SYNC 8.4): a venda que já existe com o mesmo id e o mesmo conteúdo (cabeçalho e todas as linhas) é
 * `ja_existia` sem efeito; com outro conteúdo, `AGREGADO_DIVERGENTE`. Outro id com o mesmo número no caixa é
 * `NUMERO_VENDA_DUPLICADO` (13.1; o 23505 de `uq_vendas_numero` é a segunda barreira, `traduzirErroBanco`).
 */
import {
  dec,
  decTexto,
  payloadVendaFinalizadaSchema,
  type Dec,
  type PayloadVendaCanceladaEmAndamento,
  type PayloadVendaFinalizada,
} from '@genesis/shared';
import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { compensarDefinir } from '../../estoques/compensacao.js';
import {
  itemDerivadoDocumento,
  lancarDocumento,
  LINHAS_POR_COMANDO,
  lerCadastrosEstoque,
  type CadastroProdutoEstoque,
  type CadastrosEstoque,
  type MovimentoDoDocumento,
  type NovoMovimento,
} from '../../estoques/movimentos.js';
import {
  alertas,
  cobrancasPix,
  itensVenda,
  itensVendaComplementos,
  pagamentosVenda,
  parcelasVenda,
  transacoesTef,
  vendas,
} from '../../database/empresa/schema/index.js';
import type { DbEmpresa } from '../../tenancy/tenancy.js';
import { tocarPessoas } from '../toque.js';
import { ErroRegraEvento } from '../erros.js';
import {
  agregadoDivergente,
  colunasDivergentes,
  conferirEscopoLinha,
  registrarAuditoriaPdv,
  type CatalogoHandlers,
  type ContextoHandler,
  type DependenciaEvento,
} from './comum.js';

/** SYNC 10.2: o estoque do contexto do envelope deixou de valer; a venda baixou do estoque atual da loja. */
export const ALERTA_ESTOQUE_CONTEXTO_INVALIDO = 'ESTOQUE_CONTEXTO_INVALIDO';
/** SYNC 15.1: linha de saldo negativa depois da venda (um alerta aberto por estoque, produto e variação). */
export const ALERTA_ESTOQUE_NEGATIVO = 'ESTOQUE_NEGATIVO';
/** SYNC 9.7: as somas da venda não fecham (P6: a venda grava como veio). Um alerta por venda. */
export const ALERTA_VENDA_INCONSISTENTE = 'VENDA_INCONSISTENTE';
/** SYNC 16.2 (conflito 28): produto excluído ou inativado no ERP antes da venda offline. Um por loja e produto. */
export const ALERTA_PRODUTO_INATIVO_VENDIDO = 'PRODUTO_INATIVO_VENDIDO';

/** Tipos de produto sem saldo próprio: o combo baixa os componentes (itens), o produzido a ficha, o serviço nada. */
const TIPOS_SEM_BAIXA_PROPRIA: readonly string[] = ['kit', 'produzido', 'servico'];

/**
 * T15 (desvio da MD 3.5.4): a linha `compra` que já existe só tem `ultima_ocorrencia_em` atualizada quando a venda é
 * pelo menos este intervalo mais nova. Cada UPDATE dá versão nova e desce a todos os PDVs da loja: o cliente que compra
 * várias vezes no dia geraria esse ruído a cada venda, e a expiração (meses) não precisa de precisão maior.
 */
export const INTERVALO_RELEVANCIA_COMPRA = '1 day';

type ItemVenda = PayloadVendaFinalizada['itens_venda'][number];
type Linha = Record<string, unknown>;

/**
 * O documento inteiro da venda que o caixa manda: o `venda.finalizada` e a forma B do `venda.cancelada` (a venda em
 * andamento cancelada, SYNC 9.9 B), gravados pelas mesmas funções (`conferirDocumentoVenda`, `montarLinhas`,
 * `gravarLinhasVenda`); só o `venda.finalizada` mexe no estoque.
 */
export type DocumentoVendaCaixa = PayloadVendaFinalizada | PayloadVendaCanceladaEmAndamento;

const minusculo = (v: string) => v.toLowerCase();
const reais = (v: string) => `R$ ${v.replace('.', ',')}`;

/**
 * As pessoas citadas pela venda (cliente, pagamento, cascos), como vieram: a mesma lista resolve os aliases no
 * `preparar` e vira as dependências `pessoa` (SYNC 8.5). Fonte nova de `pessoa_id` entra aqui, senão a pessoa criada no
 * caixa e ainda pendente deixa de reter a venda e a FK falha.
 */
export function pessoasDaVenda(p: DocumentoVendaCaixa): string[] {
  return [
    p.vendas.cliente_id,
    ...p.pagamentos_venda.map((pg) => pg.pessoa_id),
    ...p.vasilhames.map((x) => x.pessoa_id),
  ].filter((id): id is string => !!id);
}

// ---------------------------------------------------------------- conferências da venda (SYNC 9.7, P6)

/** Uma soma da venda que não fecha: `calculado` sai das linhas, `informado` é o que o caixa gravou. */
export interface DiferencaVenda {
  regra: 'pagamentos' | 'troco' | 'subtotal_bruto' | 'valor_liquido' | 'kit';
  calculado: string;
  informado: string;
  item_venda_id?: string;
  kit_grupo_id?: string;
}

/**
 * As conferências do "Fechamento das contas" e do combo (SYNC 9.7), em centavos exatos (`dec`, ADR-05): Σ
 * `pagamentos_venda.valor` aprovados = `vendas.total`; `vendas.troco` = Σ troco dos aprovados; `subtotal_bruto` = Σ
 * `valor_bruto` dos itens não cancelados; `valor_liquido` de cada item não cancelado = `valor_bruto − desconto_item −
 * desconto_promocao − desconto_rateado + acrescimo_rateado + frete_rateado` (MD 3.11.3); e, por `kit_grupo_id`, Σ
 * `valor_bruto` dos itens não cancelados do grupo = `arred2(kit_quantidade × kit_preco_unitario)`. Coluna ausente vale
 * o padrão do banco (zero; pagamento sem `status` = `aprovado`).
 */
export function conferirSomasVenda(p: PayloadVendaFinalizada): DiferencaVenda[] {
  const v = p.vendas;
  const d2 = (x: Dec) => decTexto(x, 2);
  const soma = (xs: ReadonlyArray<string | null | undefined>) => xs.reduce((s, x) => s.plus(dec(x)), dec(0));
  const diferencas: DiferencaVenda[] = [];
  const conferir = (
    regra: DiferencaVenda['regra'],
    calculado: Dec,
    informado: string | null | undefined,
    extra = {},
  ) => {
    if (!calculado.eq(dec(informado))) {
      diferencas.push({ regra, calculado: d2(calculado), informado: d2(dec(informado)), ...extra });
    }
  };
  const aprovados = p.pagamentos_venda.filter((pg) => (pg.status ?? 'aprovado') === 'aprovado');
  conferir('pagamentos', soma(aprovados.map((pg) => pg.valor)), v.total);
  conferir('troco', soma(aprovados.map((pg) => pg.troco)), v.troco);
  const vivos = p.itens_venda.filter((i) => !i.cancelado);
  conferir('subtotal_bruto', soma(vivos.map((i) => i.valor_bruto)), v.subtotal_bruto);
  const grupos = new Map<string, ItemVenda[]>();
  for (const i of vivos) {
    const liquido = dec(i.valor_bruto)
      .minus(dec(i.desconto_item))
      .minus(dec(i.desconto_promocao))
      .minus(dec(i.desconto_rateado))
      .plus(dec(i.acrescimo_rateado))
      .plus(dec(i.frete_rateado));
    conferir('valor_liquido', liquido, i.valor_liquido, { item_venda_id: minusculo(i.id) });
    if (i.kit_grupo_id) {
      const g = grupos.get(minusculo(i.kit_grupo_id));
      if (g) g.push(i);
      else grupos.set(minusculo(i.kit_grupo_id), [i]);
    }
  }
  for (const [grupo, itens] of grupos) {
    const { kit_quantidade: q, kit_preco_unitario: preco } = itens[0]!;
    conferir('kit', dec(decTexto(dec(q).times(dec(preco)), 2)), d2(soma(itens.map((i) => i.valor_bruto))), {
      kit_grupo_id: grupo,
    });
  }
  return diferencas;
}

// ---------------------------------------------------------------- payload → colunas

interface ColunaMapeada {
  chave: string;
  instante: boolean;
  uuid: boolean;
}

const mapas = new WeakMap<PgTable, Map<string, ColunaMapeada>>();

/** Coluna do banco (`snake_case`) → chave do Drizzle, com o tipo que pede conversão. */
function mapaColunas(tabela: PgTable): Map<string, ColunaMapeada> {
  let m = mapas.get(tabela);
  if (!m) {
    m = new Map(
      Object.entries(getTableColumns(tabela)).map(([chave, c]) => [
        c.name,
        { chave, instante: c.columnType === 'PgTimestamp', uuid: c.columnType === 'PgUUID' },
      ]),
    );
    mapas.set(tabela, m);
  }
  return m;
}

/**
 * A linha do payload (chaves = colunas, T17) como o Drizzle grava: só as colunas da tabela (o que é só do payload,
 * como `componentes_estoque`, fica de fora), instantes em `Date` e uuids em minúsculas (o `z.uuid()` aceita as duas
 * caixas e o banco devolve minúsculas: sem isso o reenvio da mesma venda parecia divergente). Chave ausente fica de fora
 * e a coluna recebe o padrão do banco.
 */
export function paraColunas(tabela: PgTable, obj: object): Linha {
  const mapa = mapaColunas(tabela);
  const linha: Linha = {};
  for (const [k, v] of Object.entries(obj)) {
    const col = mapa.get(k);
    if (!col || v === undefined) continue;
    linha[col.chave] =
      col.instante && typeof v === 'string'
        ? new Date(v)
        : col.uuid && typeof v === 'string'
          ? minusculo(v)
          : v;
  }
  return linha;
}

// ---------------------------------------------------------------- preparar (antes da trava 7300001)

/** O que a conferência do documento resolve antes da trava: as pessoas pelos aliases e o cliente definitivo. */
export interface DocumentoConferido {
  /** `pessoa_id` recebido (minúsculas) → o definitivo (`pessoas_aliases`, MD 3.5.2). */
  pessoas: Map<string, string>;
  clienteId: string | null;
}

interface VendaPreparada extends DocumentoConferido {
  cadastros: CadastrosEstoque;
  /** Estoque da baixa (SYNC 10.2) e o do contexto que deixou de valer (alerta), em minúsculas. */
  estoqueId: string;
  estoqueContextoInvalido: string | null;
  /** O cliente existe e não está excluído (relevância `compra` só para quem desce). */
  clienteVivo: boolean;
}

/** O id definitivo de uma pessoa citada pelo payload (`pessoas_aliases` já lidos em `resolverAliases`). */
export const resolverPessoa = (prep: Pick<DocumentoConferido, 'pessoas'>, id: string | null | undefined) =>
  id ? (prep.pessoas.get(minusculo(id)) ?? minusculo(id)) : null;

/** `pessoa_id` recebido (minúsculas) → o definitivo, para os que são alias de outra pessoa (MD 3.5.2). */
export async function resolverAliases(
  tx: DbEmpresa,
  recebidas: readonly string[],
): Promise<Map<string, string>> {
  const pessoas = new Map<string, string>();
  if (!recebidas.length) return pessoas;
  const { rows } = await tx.execute<{ alias_id: string; pessoa_id: string }>(sql`
    select alias_id, pessoa_id from pessoas_aliases
     where alias_id = any(${`{${[...new Set(recebidas.map(minusculo))].join(',')}}`}::uuid[])
       and excluido_em is null`);
  for (const r of rows) pessoas.set(r.alias_id, r.pessoa_id);
  return pessoas;
}

/**
 * A sessão citada por um documento do caixa existe na nuvem e é deste terminal (só lê). Nunca recebida →
 * `SESSAO_INEXISTENTE`; de outro terminal → `ESCOPO_INVALIDO`. A sessão fechada (à força, inclusive) é aceita: o evento
 * tardio do turno entra nela (MD 3.12.1).
 */
export async function conferirSessaoDoDocumento(
  { tx, terminal }: Pick<ContextoHandler, 'tx' | 'terminal'>,
  sessaoId: string,
  documento: string,
): Promise<void> {
  const { rows: sessoes } = await tx.execute<{ terminal_id: string; excluido: boolean }>(sql`
    select terminal_id, excluido_em is not null as excluido from sessoes_caixa where id = ${sessaoId}`);
  const sessao = sessoes[0];
  if (!sessao || sessao.excluido) {
    throw new ErroRegraEvento(
      'SESSAO_INEXISTENTE',
      `Sessão de caixa ${documento} nunca recebida pela nuvem.`,
      {
        sessao_caixa_id: sessaoId,
      },
    );
  }
  if (sessao.terminal_id !== terminal.terminalId) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', `Sessão de caixa ${documento} de outro terminal.`);
  }
}

/**
 * Conferências do documento da venda que só leem, comuns ao `venda.finalizada` e à forma B do `venda.cancelada`:
 * escopo do cabeçalho e das linhas de TEF/PIX, a sessão, o número (SYNC 13.1) e os aliases das pessoas.
 */
export async function conferirDocumentoVenda(
  ctx: ContextoHandler,
  p: DocumentoVendaCaixa,
): Promise<DocumentoConferido> {
  const { tx, terminal } = ctx;
  const v = p.vendas;
  conferirEscopoLinha({ ...v, terminal_id: v.terminal_id ?? undefined }, terminal, 'vendas');
  for (const [tabela, linhas] of [
    ['transacoes_tef', p.transacoes_tef],
    ['cobrancas_pix', p.cobrancas_pix],
  ] as const) {
    for (const l of linhas) {
      conferirEscopoLinha({ loja_id: l.loja_id, terminal_id: l.terminal_id }, terminal, tabela);
      if (l.venda_id && minusculo(l.venda_id) !== minusculo(v.id)) {
        throw new ErroRegraEvento('PAYLOAD_INVALIDO', `Linha de ${tabela} de outra venda.`, { tabela });
      }
    }
  }
  if (!v.sessao_caixa_id) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Venda do caixa sem a sessão de caixa.');
  }
  await conferirSessaoDoDocumento(ctx, v.sessao_caixa_id, 'da venda');
  // SYNC 13.1: o mesmo número com outro id no caixa (o 23505 do INSERT seria a segunda barreira). "Aplicar com novo
  // número" (11.4) troca o número no `aplicar` (`renumerarVenda`): a colisão é justamente o que ele resolve.
  const { rows: mesmoNumero } = ctx.novoNumero
    ? { rows: [] }
    : await tx.execute<{ id: string }>(sql`
    select id from vendas
     where loja_id = ${v.loja_id} and numero_caixa = ${v.numero_caixa} and numero = ${v.numero}
       and id <> ${v.id}
     limit 1`);
  if (mesmoNumero[0]) {
    throw new ErroRegraEvento(
      'NUMERO_VENDA_DUPLICADO',
      `Número ${v.numero_exibicao} já usado por outra venda.`,
      {
        numero: v.numero,
        venda_existente_id: mesmoNumero[0].id,
      },
    );
  }
  const pessoas = await resolverAliases(tx, pessoasDaVenda(p));
  return { pessoas, clienteId: resolverPessoa({ pessoas }, v.cliente_id) };
}

/**
 * Os cascos citados por um documento do caixa (bloco `vasilhames` da venda, devolução avulsa) são produtos do tipo
 * `vasilhame` (MD 3.12.6): outro produto que controla estoque entraria no `vasilhame_vazio` sem erro e só apareceria num
 * inventário. Tipo errado → `PAYLOAD_INVALIDO` (o produto existe; a conferência de existência vem antes).
 */
export function conferirCascos(
  ids: readonly string[],
  cadastros: Pick<CadastrosEstoque, 'produtos'>,
  documento: string,
): void {
  const naoCascos = [...new Set(ids.map(minusculo))].filter(
    (id) => cadastros.produtos.get(id)?.tipo !== 'vasilhame',
  );
  if (naoCascos.length) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', `Casco ${documento} que não é produto do tipo vasilhame.`, {
      produtos: naoCascos,
    });
  }
}

/** O estoque do documento do caixa (SYNC 10.2): o do contexto, se ainda válido, senão o atual da loja. */
export interface EstoqueEscolhido {
  estoqueId: string;
  /** O do contexto que deixou de valer (alerta `ESTOQUE_CONTEXTO_INVALIDO`), ou nulo. */
  estoqueContextoInvalido: string | null;
}

/** `contexto.estoque_id` do envelope em minúsculas: o estoque que `lerCadastrosEstoque` precisa conferir. */
export const estoqueDoContexto = (ctx: Pick<ContextoHandler, 'evento'>) =>
  ctx.evento.contexto.estoque_id ? minusculo(ctx.evento.contexto.estoque_id) : null;

/** Escolhe o estoque com os cadastros já lidos (pedindo `estoqueDoContexto` em `estoqueIds`). */
export async function escolherEstoque(
  ctx: Pick<ContextoHandler, 'tx' | 'terminal' | 'evento'>,
  cadastros: Pick<CadastrosEstoque, 'estoquesValidos'>,
): Promise<EstoqueEscolhido> {
  const { rows: lojas } = await ctx.tx.execute<{ estoque_id: string }>(sql`
    select estoque_id from lojas where id = ${ctx.terminal.lojaId}`);
  const contexto = estoqueDoContexto(ctx);
  const valido = contexto !== null && cadastros.estoquesValidos.has(contexto);
  return {
    estoqueId: valido ? contexto : lojas[0]!.estoque_id,
    estoqueContextoInvalido: contexto !== null && !valido ? contexto : null,
  };
}

/** Conferências que só leem: escopo das linhas, sessão, número, referências e cadastros (C6a, T21). */
async function prepararVenda(ctx: ContextoHandler, p: PayloadVendaFinalizada): Promise<VendaPreparada> {
  const { tx } = ctx;
  const comodato = p.vasilhames.filter((x) => x.emprestados > 0);
  if (comodato.length) {
    // `VASILHAME_EMPRESTADO` e `saldos_vasilhame_pessoas` são do comodato (Fase 3, O14 do dono).
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Cascos emprestados (comodato) ainda não são aceitos.', {
      produtos_vasilhame: comodato.map((x) => x.produto_vasilhame_id),
    });
  }
  const conferido = await conferirDocumentoVenda(ctx, p);
  let clienteVivo = false;
  if (conferido.clienteId) {
    const { rows } = await tx.execute<{ vivo: boolean }>(sql`
      select excluido_em is null as vivo from pessoas where id = ${conferido.clienteId}`);
    clienteVivo = rows[0]?.vivo ?? false;
  }

  const estoqueContexto = estoqueDoContexto(ctx);
  const produtoIds = [
    ...p.itens_venda.flatMap((i) => [i.produto_id, ...i.componentes_estoque.map((c) => c.produto_id)]),
    ...p.vasilhames.map((x) => x.produto_vasilhame_id),
  ].map(minusculo);
  const cadastros = await lerCadastrosEstoque(tx, {
    produtoIds,
    codigoBarrasIds: p.itens_venda.flatMap((i) =>
      i.codigo_barras_id ? [minusculo(i.codigo_barras_id)] : [],
    ),
    estoqueIds: estoqueContexto ? [estoqueContexto] : [],
  });
  // SYNC 11.2: produto que nunca existiu na empresa (o excluído existe e é aceito, 16.2: alerta no `aplicar`).
  const faltam = [...new Set(produtoIds)].filter((id) => !cadastros.produtos.has(id));
  if (faltam.length) {
    throw new ErroRegraEvento('REFERENCIA_INEXISTENTE', 'Produto da venda inexistente na empresa.', {
      produtos: faltam,
    });
  }
  // MD 3.12.6: o bloco `vasilhames` só fala de cascos (`tipo = 'vasilhame'`); outro produto entraria no vasilhame_vazio.
  conferirCascos(
    p.vasilhames.map((x) => x.produto_vasilhame_id),
    cadastros,
    'da venda',
  );
  return { ...conferido, cadastros, ...(await escolherEstoque(ctx, cadastros)), clienteVivo };
}

// ---------------------------------------------------------------- linhas da venda

export interface LinhasVenda {
  venda: Linha;
  itens: Linha[];
  complementos: Linha[];
  pagamentos: Linha[];
  parcelas: Linha[];
  tef: Linha[];
  pix: Linha[];
}

/** As linhas como a nuvem grava (sem o custo, que sai do estoque): o `INSERT` e a conferência do reenvio usam esta. */
export function montarLinhas(
  ctx: ContextoHandler,
  p: DocumentoVendaCaixa,
  prep: DocumentoConferido,
): LinhasVenda {
  const vendaId = minusculo(p.vendas.id);
  return {
    venda: {
      ...paraColunas(vendas, p.vendas),
      // A venda do caixa é sempre do terminal dono (o cabeçalho anulável é da venda do ERP).
      terminalId: ctx.terminal.terminalId,
      clienteId: prep.clienteId,
      // T5: hora não confirmada no ERP quando o PDV finalizou sem relógio confiável (SYNC 12.4).
      relogioConfiavel: ctx.evento.relogio_confiavel ?? true,
    },
    itens: p.itens_venda.map((i) => paraColunas(itensVenda, i)),
    complementos: p.itens_venda_complementos.map((c) => paraColunas(itensVendaComplementos, c)),
    pagamentos: p.pagamentos_venda.map((pg) => ({
      ...paraColunas(pagamentosVenda, pg),
      pessoaId: resolverPessoa(prep, pg.pessoa_id),
    })),
    parcelas: p.parcelas_venda.map((pa) => paraColunas(parcelasVenda, pa)),
    // TEF e PIX do caixa pertencem a esta venda: sem `venda_id` no payload, a nuvem liga (nenhuma FK nelas, MD 3.11.5).
    tef: p.transacoes_tef.map((t) => ({ ...paraColunas(transacoesTef, t), vendaId })),
    pix: p.cobrancas_pix.map((x) => ({ ...paraColunas(cobrancasPix, x), vendaId })),
  };
}

/** Colunas que a nuvem preenche ou que mudam depois da finalização (cancelamento, fiscal, devolução): fora do reenvio. */
const IGNORAR_VENDA_FINALIZADA = [
  'status',
  'statusFiscal',
  'devolucao',
  'custoTotal',
  'canceladaEm',
  'canceladaPorId',
  'cancelamentoAutorizadoPorId',
  'motivoCancelamento',
  'cancelamentoOrigem',
  'relogioConfiavel',
];
const IGNORAR_ITEM = ['custoUnitario', 'comissaoPct', 'valorComissao', 'quantidadeDevolvida'];
/** O `status` do pagamento muda com o cancelamento da forma A (`estornado`); a conta financeira é da nuvem. */
const IGNORAR_PAGAMENTO_FINALIZADA = ['status', 'contaFinanceiraId'];

/** As linhas gravadas de uma tabela da venda são as mesmas do payload (pelo `id`), com o mesmo conteúdo. */
function conferirConjunto(
  tabela: string,
  gravadas: ReadonlyArray<Linha & { id: string }>,
  novas: readonly Linha[],
  ignorar: readonly string[] = [],
): void {
  const porId = new Map(gravadas.map((g) => [g.id, g]));
  for (const n of novas) {
    const gravada = porId.get(String(n.id));
    const divergentes = gravada ? colunasDivergentes(gravada, n, ignorar) : ['id'];
    if (divergentes.length) throw agregadoDivergente(tabela, String(n.id), divergentes);
  }
  const sobra = gravadas.find((g) => !novas.some((n) => n.id === g.id));
  if (sobra) throw agregadoDivergente(tabela, sobra.id, ['id']);
}

/**
 * Camada 2 da idempotência (SYNC 8.4) para a venda que já existe: cabeçalho e todas as linhas. `ignorar` são as
 * colunas que mudam depois do evento (as da finalização por padrão; a forma B do `venda.cancelada` passa as dela).
 */
export async function conferirVendaGravada(
  tx: DbEmpresa,
  gravada: Linha & { id: string },
  l: LinhasVenda,
  ignorar: { venda: readonly string[]; pagamento: readonly string[] } = {
    venda: IGNORAR_VENDA_FINALIZADA,
    pagamento: IGNORAR_PAGAMENTO_FINALIZADA,
  },
): Promise<void> {
  const divergentes = colunasDivergentes(gravada, l.venda, ignorar.venda);
  if (divergentes.length) throw agregadoDivergente('vendas', gravada.id, divergentes);
  const id = gravada.id;
  const itens = await tx.select().from(itensVenda).where(eq(itensVenda.vendaId, id));
  conferirConjunto('itens_venda', itens, l.itens, IGNORAR_ITEM);
  const idsItens = itens.map((i) => i.id);
  const complementos = idsItens.length
    ? await tx
        .select()
        .from(itensVendaComplementos)
        .where(inArray(itensVendaComplementos.itemVendaId, idsItens))
    : [];
  conferirConjunto('itens_venda_complementos', complementos, l.complementos);
  const pagamentos = await tx.select().from(pagamentosVenda).where(eq(pagamentosVenda.vendaId, id));
  conferirConjunto('pagamentos_venda', pagamentos, l.pagamentos, ignorar.pagamento);
  const idsPagamentos = pagamentos.map((pg) => pg.id);
  const parcelas = idsPagamentos.length
    ? await tx.select().from(parcelasVenda).where(inArray(parcelasVenda.pagamentoVendaId, idsPagamentos))
    : [];
  conferirConjunto('parcelas_venda', parcelas, l.parcelas);
  // TEF e PIX mudam de status depois (confirmação, cancelamento da forma A): só o que veio do caixa na venda conta.
  // A transação de cancelamento que o `venda.cancelada` A ligou à venda não veio neste documento: fica fora da sobra.
  const tefDoDocumento = new Set(l.tef.map((t) => t.id));
  const tef = (await tx.select().from(transacoesTef).where(eq(transacoesTef.vendaId, id))).filter(
    (t) => t.operacao !== 'cancelamento' || tefDoDocumento.has(t.id),
  );
  conferirConjunto('transacoes_tef', tef, l.tef, ['status', 'confirmadaEm', 'desfeitaEm', 'canceladaEm']);
  const pix = await tx.select().from(cobrancasPix).where(eq(cobrancasPix.vendaId, id));
  conferirConjunto('cobrancas_pix', pix, l.pix, ['status', 'pagaEm', 'valorDevolvido', 'devolvidaEm']);
}

// ---------------------------------------------------------------- estoque

/** O item baixa o próprio produto (SYNC 10.2 "Quem baixa"), pelo cadastro **atual** da nuvem. */
function baixaPropria(cad: CadastrosEstoque, item: ItemVenda): boolean {
  const p = cad.produtos.get(minusculo(item.produto_id))!;
  return p.controlaEstoque && !TIPOS_SEM_BAIXA_PROPRIA.includes(p.tipo) && !item.componentes_estoque.length;
}

/** As linhas de movimento do documento (antes de somar as iguais e travar, `lancarDocumento`). */
function montarMovimentos(
  ctx: ContextoHandler,
  p: PayloadVendaFinalizada,
  prep: VendaPreparada,
): NovoMovimento[] {
  const { cadastros: cad } = prep;
  const v = p.vendas;
  const finalizada = new Date(v.finalizada_em!);
  const precisaTipo = (id: string | null, nome: string): string => {
    if (!id) throw new Error(`Empresa sem o tipo de estoque ${nome}`);
    return id;
  };
  const base = {
    estoqueId: prep.estoqueId,
    lojaId: ctx.terminal.lojaId,
    usuarioId: v.operador_id,
    documentoTipo: 'venda' as const,
    documentoId: v.id,
    dataMovimento: finalizada,
    terminalId: ctx.terminal.terminalId,
    eventoId: ctx.evento.evento_id,
    pessoaId: prep.clienteId,
  };
  const linhas: NovoMovimento[] = [];
  for (const item of p.itens_venda) {
    if (item.cancelado) continue;
    const produto = cad.produtos.get(minusculo(item.produto_id))!;
    for (const c of item.componentes_estoque) {
      const insumo = cad.produtos.get(minusculo(c.produto_id))!;
      if (!insumo.controlaEstoque) continue;
      linhas.push({
        ...base,
        produtoId: c.produto_id,
        variacaoId: c.variacao_id ?? null,
        tipoEstoqueId: precisaTipo(cad.tipoEstoquePadraoId, 'padrão'),
        tipoMovimento: 'BAIXA_INSUMO',
        quantidade: decTexto(dec(c.quantidade).neg(), 3),
        custoReferencia: insumo.precoCusto,
        precoVenda: null,
        documentoItemId: item.id,
        unidadeDocumento: insumo.sigla,
      });
    }
    if (!baixaPropria(cad, item)) continue;
    // Embalagem lida (fardo de 12): a quantidade já vem em unidades base; o código dá a sigla e o fator (SYNC 10.2).
    const codigo = item.codigo_barras_id
      ? cad.codigosBarras.get(minusculo(item.codigo_barras_id))
      : undefined;
    const doProduto = codigo && codigo.produtoId === minusculo(item.produto_id) ? codigo : undefined;
    linhas.push({
      ...base,
      produtoId: item.produto_id,
      variacaoId: item.variacao_id ?? null,
      tipoEstoqueId: precisaTipo(cad.tipoEstoquePadraoId, 'padrão'),
      tipoMovimento: item.vasilhame_item_origem_id ? 'VASILHAME_VENDIDO' : 'VENDA_PDV',
      quantidade: decTexto(dec(item.quantidade).neg(), 3),
      custoReferencia: produto.precoCusto,
      precoVenda: item.preco_unitario,
      documentoItemId: item.id,
      loteId: item.lote_id ?? null,
      unidadeDocumento: doProduto ? (doProduto.sigla ?? produto.sigla) : produto.sigla,
      fator: doProduto ? doProduto.fator : '1',
    });
  }
  for (const x of p.vasilhames) {
    const casco = cad.produtos.get(minusculo(x.produto_vasilhame_id))!;
    if (x.devolvidos <= 0 || !casco.controlaEstoque) continue;
    linhas.push({
      ...base,
      produtoId: x.produto_vasilhame_id,
      variacaoId: null,
      tipoEstoqueId: precisaTipo(cad.tipoEstoqueVasilhameVazioId, 'vasilhame_vazio'),
      tipoMovimento: 'VASILHAME_DEVOLVIDO',
      quantidade: decTexto(x.devolvidos, 3),
      // Entrada dos vazios ao custo médio da linha (ou ao de referência do casco): não traz custo novo.
      custoUnitario: null,
      custoReferencia: casco.precoCusto,
      precoVenda: null,
      documentoItemId: itemDerivadoDocumento(v.id, 'vasilhames'),
      pessoaId: resolverPessoa(prep, x.pessoa_id) ?? prep.clienteId,
      unidadeDocumento: casco.sigla,
    });
  }
  return linhas;
}

// ---------------------------------------------------------------- aplicar

/**
 * Custo de cada item (SYNC 10.2, T22), na ordem de `itens`, e o `vendas.custo_total` (2 casas): Σ `custo_total` dos
 * movimentos do item (`custoPorItem`) ÷ quantidade (4 casas). No item com ficha (`componentes_estoque`), o insumo que
 * não controla estoque não baixa, mas entra pelo custo de referência (`preco_custo × quantidade`, 2 casas como o
 * `custo_total` do movimento): sem isso a caipirinha com cachaça controlada e limão sem controle ficava só com o custo
 * da cachaça e a margem saía inflada. O item sem nenhuma baixa e sem ficha fica com o `preco_custo` do cadastro; o
 * cancelado, sem custo (nulo) e fora do total.
 */
export function custoDosItens(
  itens: readonly ItemVenda[],
  cad: Pick<CadastrosEstoque, 'produtos'>,
  custoPorItem: ReadonlyMap<string, string>,
): { unitarios: Array<string | null>; total: string } {
  let total = dec(0);
  const unitarios = itens.map((item) => {
    if (item.cancelado) return null;
    const movimentos = custoPorItem.get(minusculo(item.id));
    let soma: Dec;
    if (item.componentes_estoque.length) {
      soma = dec(movimentos);
      for (const c of item.componentes_estoque) {
        const insumo = cad.produtos.get(minusculo(c.produto_id))!;
        if (!insumo.controlaEstoque)
          soma = soma.plus(decTexto(dec(insumo.precoCusto).times(c.quantidade), 2));
      }
    } else if (movimentos !== undefined) {
      soma = dec(movimentos);
    } else {
      const referencia = decTexto(cad.produtos.get(minusculo(item.produto_id))!.precoCusto, 4);
      total = total.plus(dec(referencia).times(item.quantidade));
      return referencia;
    }
    total = total.plus(soma);
    return decTexto(soma.div(dec(item.quantidade)), 4);
  });
  return { unitarios, total: decTexto(total, 2) };
}

/**
 * Os itens cheios antes dos cascos cobrados (`vasilhame_item_origem_id`, que aponta para o cheio da mesma venda): a
 * FK é conferida no fim de cada comando, e com os itens em blocos o casco num bloco anterior ao do cheio falharia.
 */
export function ordenarCheiosAntes<T extends Linha>(itens: readonly T[]): T[] {
  return [
    ...itens.filter((i) => !i.vasilhameItemOrigemId),
    ...itens.filter((i) => !!i.vasilhameItemOrigemId),
  ];
}

/**
 * Teto de parâmetros por comando do protocolo do PostgreSQL (o contador do `Bind` é de 16 bits; ver
 * `LINHAS_POR_COMANDO` em `movimentos.ts`): uma venda com uns 1100 itens completos (57 parâmetros cada) passava dele
 * num `INSERT` só e caía em `ERRO_INTERNO` a cada reenvio.
 */
const PARAMETROS_POR_COMANDO = 65_535;

/**
 * `INSERT` das linhas de uma tabela da venda em blocos, na mesma transação: até `LINHAS_POR_COMANDO` linhas e nunca
 * mais linhas que o teto de parâmetros dividido pelas colunas da tabela (cada coluna informada é um parâmetro).
 */
async function inserirEmBlocos(tx: DbEmpresa, tabela: PgTable, linhas: readonly Linha[]): Promise<void> {
  const porComando = Math.min(
    LINHAS_POR_COMANDO,
    Math.floor(PARAMETROS_POR_COMANDO / Object.keys(getTableColumns(tabela)).length),
  );
  for (let i = 0; i < linhas.length; i += porComando) {
    await tx.insert(tabela).values(linhas.slice(i, i + porComando) as never);
  }
}

/** Grava o alerta deduplicado (`chave_deduplicacao`); devolve se ele é novo (o aberto com a mesma chave fica). */
export async function gravarAlerta(tx: DbEmpresa, alerta: typeof alertas.$inferInsert): Promise<boolean> {
  const r = await tx.insert(alertas).values(alerta).onConflictDoNothing().returning({ id: alertas.id });
  return r.length > 0;
}

/**
 * `INSERT` do documento da venda (cabeçalho e linhas), um comando por tabela (em blocos, `inserirEmBlocos`), na ordem
 * das FKs: o casco cobrado aponta para o item cheio da mesma venda (`ordenarCheiosAntes`), o complemento para o item,
 * o pagamento para TEF e PIX e a parcela para o pagamento.
 */
export async function gravarLinhasVenda(tx: DbEmpresa, linhas: LinhasVenda): Promise<void> {
  await tx.insert(vendas).values(linhas.venda as typeof vendas.$inferInsert);
  await inserirEmBlocos(tx, itensVenda, ordenarCheiosAntes(linhas.itens));
  await inserirEmBlocos(tx, itensVendaComplementos, linhas.complementos);
  await inserirEmBlocos(tx, transacoesTef, linhas.tef);
  await inserirEmBlocos(tx, cobrancasPix, linhas.pix);
  await inserirEmBlocos(tx, pagamentosVenda, linhas.pagamentos);
  await inserirEmBlocos(tx, parcelasVenda, linhas.parcelas);
}

/**
 * Faixa da renumeração (SYNC 11.4, 13.1; T27 da 1C): "Aplicar com novo número" grava a venda a partir daqui, no topo do
 * espaço do caixa, e não no "próximo livre" logo acima do último número usado. O terminal ativo continua contando
 * pela sequência local dele: o número logo acima do último usado é justamente a próxima venda dele, que colidiria de
 * novo (e a renumerada empurraria `numeracoes` para a faixa do terminal). Nove milhões de vendas num caixa são
 * décadas de balcão. A faixa não entra em `numeracoes`, que continua sendo o último número **do PDV** (base da
 * ativação seguinte, 13.3).
 */
export const INICIO_FAIXA_RENUMERACAO = 9_000_000;

export interface Renumeracao<P extends DocumentoVendaCaixa> {
  payload: P;
  original: { numero: number; exibicao: string };
  novo: { numero: number; exibicao: string };
}

/**
 * "Aplicar com novo número" (SYNC 11.4, 13.1): o documento com o próximo número livre da faixa de renumeração do
 * caixa e o número do PDV guardado em `vendas.observacao` (e no `resultado`/auditoria de quem chama). Roda no `aplicar`,
 * sob a trava 7300001: dois "Aplicar com novo número" de terminais diferentes do mesmo caixa não pegam o mesmo
 * número. O payload gravado em `eventos_recebidos` não muda (é o que o PDV mandou).
 */
export async function renumerarVenda<P extends DocumentoVendaCaixa>(
  { tx }: Pick<ContextoHandler, 'tx'>,
  p: P,
): Promise<Renumeracao<P>> {
  const v = p.vendas;
  const { rows } = await tx.execute<{ n: string }>(sql`
    select (greatest(coalesce(max(numero), 0), ${INICIO_FAIXA_RENUMERACAO}::bigint) + 1)::text as n
      from vendas
     where loja_id = ${v.loja_id} and numero_caixa = ${v.numero_caixa} and numero > ${INICIO_FAIXA_RENUMERACAO}`);
  const numero = Number(rows[0]!.n);
  // `L01-C02-000123` → `L01-C02-9000001`: só a parte numérica do fim muda.
  const exibicao = /\d+$/.test(v.numero_exibicao)
    ? v.numero_exibicao.replace(/\d+$/, String(numero).padStart(6, '0'))
    : String(numero);
  const nota = `Número original do caixa: ${v.numero_exibicao} (renumerada na nuvem, número já usado por outra venda).`;
  const observacao = [nota, v.observacao].filter(Boolean).join(' ').slice(0, 500);
  return {
    payload: { ...p, vendas: { ...v, numero, numero_exibicao: exibicao.slice(0, 20), observacao } },
    original: { numero: v.numero, exibicao: v.numero_exibicao },
    novo: { numero, exibicao: exibicao.slice(0, 20) },
  };
}

/** Campos do `resultado` da venda renumerada (o PDV recebe em `eventos_resolvidos`; a auditoria guarda os dois). */
export function resultadoRenumeracao(r: Renumeracao<DocumentoVendaCaixa> | null): Record<string, unknown> {
  return r
    ? {
        numero_original: r.original.numero,
        numero_exibicao_original: r.original.exibicao,
        numero: r.novo.numero,
        numero_exibicao: r.novo.exibicao,
      }
    : {};
}

/** SYNC 10.2, 13.1: o maior número já visto do caixa, gravado por quem o usou (`greatest`; cria a linha se faltar). */
export async function avancarNumeracao({ tx, terminal }: ContextoHandler, numero: number): Promise<void> {
  await tx.execute(sql`
    insert into numeracoes (tipo, loja_id, caixa_id, ultimo_numero, dono, ultimo_atualizado_por_terminal_id)
    values ('venda', ${terminal.lojaId}, ${terminal.caixaId}, ${numero}, 'terminal', ${terminal.terminalId})
    on conflict (tipo, loja_id, caixa_id, modelo, serie, ambiente) where excluido_em is null
    do update set ultimo_numero = excluded.ultimo_numero,
                  ultimo_atualizado_por_terminal_id = excluded.ultimo_atualizado_por_terminal_id
     where numeracoes.ultimo_numero < excluded.ultimo_numero`);
}

/**
 * SYNC 10.2: o documento do caixa (venda, devolução de cascos) baixou ou deu entrada no estoque atual da loja porque
 * o do contexto deixou de valer. Um alerta aberto por terminal e estoque; devolve se ele é novo.
 */
export async function alertarEstoqueContexto(
  { tx, terminal }: Pick<ContextoHandler, 'tx' | 'terminal'>,
  estoque: EstoqueEscolhido,
  registro: { entidade: string; registroId: string; documento: string },
): Promise<boolean> {
  if (!estoque.estoqueContextoInvalido) return false;
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  return gravarAlerta(tx, {
    tipo: ALERTA_ESTOQUE_CONTEXTO_INVALIDO,
    severidade: 'aviso',
    titulo: `Caixa ${caixa} ${registro.documento} com um estoque que não vale mais`,
    mensagem:
      'O estoque informado pelo caixa foi excluído ou desativado; o movimento foi lançado no estoque atual da loja. ' +
      'Confira o vínculo de estoque da loja e a sincronização do terminal.',
    lojaId: terminal.lojaId,
    entidade: registro.entidade,
    registroId: registro.registroId,
    dados: { estoque_contexto_id: estoque.estoqueContextoInvalido, estoque_usado_id: estoque.estoqueId },
    chaveDeduplicacao: `estoque_contexto_invalido:${terminal.terminalId}:${estoque.estoqueContextoInvalido}`,
  });
}

const ROTULOS_DIFERENCA: Record<DiferencaVenda['regra'], string> = {
  pagamentos: 'pagamentos × total',
  troco: 'troco',
  subtotal_bruto: 'subtotal bruto',
  valor_liquido: 'valor líquido de item',
  kit: 'valor do combo',
};

async function aplicarVenda(ctx: ContextoHandler, original: PayloadVendaFinalizada, prep: VendaPreparada) {
  const { tx, terminal } = ctx;
  const renumeracao = ctx.novoNumero ? await renumerarVenda(ctx, original) : null;
  const p = renumeracao?.payload ?? original;
  const v = p.vendas;
  const linhas = montarLinhas(ctx, p, prep);
  const [gravada] = await tx.select().from(vendas).where(eq(vendas.id, v.id));
  if (gravada) {
    await conferirVendaGravada(tx, gravada, linhas);
    return { venda_id: gravada.id, ja_existia: true };
  }

  // Estoque antes do documento (C6a): o custo de cada item já entra no INSERT, sem UPDATE na venda finalizada.
  const doc = await lancarDocumento(tx, montarMovimentos(ctx, p, prep));
  const compensacoes = await compensarDefinir(tx, doc.movimentos);
  const custos = custoDosItens(p.itens_venda, prep.cadastros, doc.custoPorItem);
  const custo = custos.total;
  const itens = linhas.itens.map((linha, n) => ({ ...linha, custoUnitario: custos.unitarios[n] ?? null }));
  await gravarLinhasVenda(tx, { ...linhas, venda: { ...linhas.venda, custoTotal: custo }, itens });
  // O número que o PDV usou, mesmo na venda renumerada (a faixa da renumeração fica fora de `numeracoes`).
  await avancarNumeracao(ctx, original.vendas.numero);

  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const alertasGerados: string[] = [];
  if (
    await alertarEstoqueContexto(ctx, prep, { entidade: 'vendas', registroId: v.id, documento: 'vendeu' })
  ) {
    alertasGerados.push(ALERTA_ESTOQUE_CONTEXTO_INVALIDO);
  }
  // SYNC 15.1: o saldo final de cada linha (o último movimento dela, depois das compensações).
  const finais = new Map<string, MovimentoDoDocumento>();
  for (const m of [...doc.movimentos, ...compensacoes]) {
    const l = m.linha;
    finais.set(`${l.estoqueId}|${l.produtoId}|${l.variacaoId ?? ''}|${l.tipoEstoqueId}`, m);
  }
  let negativos = 0;
  for (const m of finais.values()) {
    if (!dec(m.saldoPosterior).lt(0)) continue;
    const l = m.linha;
    const produto = prep.cadastros.produtos.get(l.produtoId)!;
    const novo = await gravarAlerta(tx, {
      tipo: ALERTA_ESTOQUE_NEGATIVO,
      severidade: 'aviso',
      titulo: `Estoque negativo: ${produto.nome}`.slice(0, 150),
      mensagem: `O saldo ficou em ${Number(m.saldoPosterior).toLocaleString('pt-BR')} ${produto.sigla} depois de uma venda do caixa ${caixa}. Confira a contagem ou lance a entrada que falta.`,
      lojaId: terminal.lojaId,
      entidade: 'produtos',
      registroId: l.produtoId,
      dados: {
        estoque_id: l.estoqueId,
        produto_id: l.produtoId,
        variacao_id: l.variacaoId,
        tipo_estoque_id: l.tipoEstoqueId,
        saldo: m.saldoPosterior,
        venda_id: minusculo(v.id),
      },
      chaveDeduplicacao: `estoque_negativo:${l.estoqueId}:${l.produtoId}:${l.variacaoId ?? ''}`,
    });
    if (novo) negativos++;
  }
  if (negativos) alertasGerados.push(ALERTA_ESTOQUE_NEGATIVO);

  // SYNC 16.2 (conflito 28): o produto excluído ou inativado no ERP antes da venda é aceito, com aviso.
  const finalizadaEm = new Date(v.finalizada_em!).getTime();
  const inativos = new Map<string, CadastroProdutoEstoque>();
  for (const item of p.itens_venda) {
    if (item.cancelado) continue;
    const produto = prep.cadastros.produtos.get(minusculo(item.produto_id))!;
    if (produto.inativoDesde !== null && produto.inativoDesde < finalizadaEm)
      inativos.set(produto.id, produto);
  }
  let inativosNovos = 0;
  for (const produto of inativos.values()) {
    const situacao = produto.excluido ? 'excluído' : 'inativo';
    const novo = await gravarAlerta(tx, {
      tipo: ALERTA_PRODUTO_INATIVO_VENDIDO,
      severidade: 'aviso',
      titulo: `Produto ${situacao} vendido: ${produto.nome}`.slice(0, 150),
      mensagem:
        `O caixa ${caixa} vendeu um produto que já estava ${situacao} no ERP (o caixa ainda não tinha recebido a ` +
        'alteração). A venda foi aceita; confira o cadastro e a sincronização do terminal.',
      lojaId: terminal.lojaId,
      entidade: 'produtos',
      registroId: produto.id,
      dados: {
        produto_id: produto.id,
        excluido: produto.excluido,
        inativo_desde: new Date(produto.inativoDesde!).toISOString(),
        venda_id: minusculo(v.id),
        finalizada_em: v.finalizada_em,
      },
      chaveDeduplicacao: `produto_inativo_vendido:${terminal.lojaId}:${produto.id}`,
    });
    if (novo) inativosNovos++;
  }
  if (inativosNovos) alertasGerados.push(ALERTA_PRODUTO_INATIVO_VENDIDO);

  // SYNC 9.7 (P6): somas que não fecham não recusam; a venda grava como veio e o ERP é avisado.
  const diferencas = conferirSomasVenda(p);
  if (diferencas.length) {
    const regras = [...new Set(diferencas.map((d) => ROTULOS_DIFERENCA[d.regra]))].join(', ');
    const novo = await gravarAlerta(tx, {
      tipo: ALERTA_VENDA_INCONSISTENTE,
      severidade: 'aviso',
      titulo: `Venda ${v.numero_exibicao} com somas que não fecham`,
      mensagem:
        `A venda do caixa ${caixa} foi gravada como veio, mas as contas não fecham (${regras}). ` +
        'Confira a venda no ERP e a versão do app do caixa.',
      lojaId: terminal.lojaId,
      entidade: 'vendas',
      registroId: v.id,
      dados: { venda_id: minusculo(v.id), numero_exibicao: v.numero_exibicao, diferencas },
      chaveDeduplicacao: `venda_inconsistente:${minusculo(v.id)}`,
    });
    if (novo) alertasGerados.push(ALERTA_VENDA_INCONSISTENTE);
  }

  const relevancia =
    prep.clienteId && prep.clienteVivo ? await relevanciaCompra(ctx, prep.clienteId, v) : null;
  await registrarAuditoriaPdv(ctx, {
    entidade: 'vendas',
    registroId: v.id,
    acao: 'criar',
    localizacao: 'PDV › Venda',
    descricao: `Venda ${v.numero_exibicao} finalizada no caixa ${caixa}: ${reais(v.total ?? '0.00')}`,
    usuarioId: v.operador_id,
    ocorridoEm: new Date(v.finalizada_em!),
    // As liberações do supervisor ligadas à venda (SYNC 9.7) ficam aqui; também sobem em `auditoria.registros`.
    depois: {
      numero: v.numero,
      total: v.total ?? null,
      custo_total: custo,
      itens: p.itens_venda.length,
      movimentos_estoque: doc.movimentos.length,
      compensacoes: compensacoes.length,
      estoque_id: prep.estoqueId,
      liberacoes: p.liberacoes,
      ...resultadoRenumeracao(renumeracao),
    },
  });
  return {
    venda_id: minusculo(v.id),
    ...resultadoRenumeracao(renumeracao),
    custo_total: custo,
    movimentos: doc.movimentos.length,
    ...(compensacoes.length ? { compensacoes: compensacoes.length } : {}),
    ...(relevancia ? { relevancia_compra: relevancia } : {}),
    ...(alertasGerados.length ? { alertas: alertasGerados } : {}),
  };
}

/**
 * Relevância `compra` do cliente na loja da venda (MD 3.5.4; D19): linha nova toca a pessoa e as filhas para descerem
 * aos PDVs da loja; a que já existe só avança `ultima_ocorrencia_em` uma vez por dia (T15). Devolve o que fez.
 *
 * A data vem do relógio do caixa (`finalizada_em`) e marca o prazo de retenção da LGPD, então nunca fica no futuro:
 * `least` com o `now()` (o caixa com a BIOS em 2028, SYNC 12.3, não segura o cliente no espelho até 2029). A linha
 * que já está no futuro, gravada antes deste teto, volta para a data da venda nova, mesmo que mais velha. O teto vale
 * só para o prazo: as datas do movimento seguem a do caixa (SYNC 12.4).
 */
async function relevanciaCompra(
  { tx, terminal }: ContextoHandler,
  pessoaId: string,
  v: PayloadVendaFinalizada['vendas'],
): Promise<'criada' | 'atualizada' | null> {
  const { rows } = await tx.execute<{ nova: boolean }>(sql`
    insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em)
    values (${pessoaId}, ${terminal.lojaId}, 'compra', least(${v.finalizada_em}::timestamptz, now()))
    on conflict (pessoa_id, loja_id, motivo) where excluido_em is null
    do update set ultima_ocorrencia_em = excluded.ultima_ocorrencia_em
     where pessoas_relevancia_loja.ultima_ocorrencia_em
           < excluded.ultima_ocorrencia_em - ${INTERVALO_RELEVANCIA_COMPRA}::interval
        or pessoas_relevancia_loja.ultima_ocorrencia_em > now()
    returning (xmax = 0) as nova`);
  const r = rows[0];
  if (!r) return null;
  // Depois da linha de relevância: a pessoa e as filhas ganham versão maior que ela (o PDV aplica em ordem).
  if (r.nova) await tocarPessoas(tx, [pessoaId]);
  return r.nova ? 'criada' : 'atualizada';
}

const dependenciaPessoa = (id: string): DependenciaEvento => ({ agregado_tipo: 'pessoa', agregado_id: id });

export const HANDLERS_VENDA: CatalogoHandlers = {
  'venda.finalizada': {
    1: {
      schema: payloadVendaFinalizadaSchema,
      // SYNC 9.7, 8.5: a sessão e as pessoas que o caixa pode ter criado (cadastro rápido, 1D) ficam como dependência.
      async dependencias(_ctx, p: PayloadVendaFinalizada) {
        const v = p.vendas;
        const pessoas = new Set(pessoasDaVenda(p).map(minusculo));
        return [
          ...(v.sessao_caixa_id ? [{ agregado_tipo: 'sessao_caixa', agregado_id: v.sessao_caixa_id }] : []),
          ...[...pessoas].map(dependenciaPessoa),
        ];
      },
      preparar: prepararVenda,
      aplicar: aplicarVenda,
    },
  },
};
