/**
 * Transferência entre estoques em duas etapas (ERP 13.7; MD 3.7.6; Fase 2, F2-B23; README da API › decisão 171): a
 * conferência do cabeçalho e dos itens do rascunho, a gravação dos itens, o detalhe e as duas ações do remetente —
 * **enviar** (`TRANSF_SAIDA` na origem ao custo médio vigente, com o saldo conferido) e **cancelar** (do rascunho, sem
 * efeito; do trânsito, o `TRANSF_RETORNO` integral de cada saída, ao custo dela, T20). O schema e os contratos são do
 * F2-B22 (migração `0025_transferencias`, `transferencias.ts` do shared; decisão 170); receber, tratar a divergência e o
 * modo de uma etapa (que chama `enviarTransferencia` e o recebimento na mesma transação) ficam em `recebimento.ts`
 * (F2-B24; decisão 172).
 *
 * Os movimentos seguem o motor (`lancarDocumento`): as linhas de saldo travadas uma vez cada, em `ordenarChaves`, a
 * divisão FEFO da saída sem lote (F2-B6) e a compensação contra o "Definir" com a contagem à frente (F2-B4). Quem chama
 * abre a transação com `travaVersao` (os saldos descem ao PDV pelo fluxo `estoque`) e trava o cabeçalho antes.
 */
import {
  dec,
  decTexto,
  type CriarTransferencia,
  type Dec,
  type ItemTransferencia,
  type ItemTransferenciaDetalhe,
  type StatusTransferencia,
  type TransferenciaDetalhe,
  type TratamentoDivergenciaTransferencia,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { hojeNaEmpresa } from '../comum/fuso.js';
import { emBlocos } from '../entradas/entrada.js';
import { TIPOS_SEM_ESTOQUE, conferirLotesItens, resolverTipoEstoque } from '../estoques/acertos.js';
import { compensacoesDoDocumento, compensarDefinir } from '../estoques/compensacao.js';
import {
  lancarDocumento,
  ordenarChaves,
  saldoDoLote,
  travarSaldo,
  type ChaveSaldo,
  type NovoMovimento,
} from '../estoques/movimentos.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import { opcoesPorId } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

type Linha = Record<string, unknown>;

const lista = (ids: Iterable<string>) => `{${[...new Set([...ids].map((i) => i.toLowerCase()))].join(',')}}`;

/** Versão do documento inteiro (cabeçalho + itens, inclusive excluídos; decisão 47), como o recebimento e o acerto. */
export const sqlVersaoTransferencia = sql`greatest(t.versao, coalesce((select max(i.versao) from itens_transferencia i where i.transferencia_id = t.id), 0))`;

/** Cabeçalho conferido: o tipo de estoque e a data já resolvidos (os padrões aplicados). */
export interface CabecalhoTransferencia {
  estoqueOrigemId: string;
  estoqueDestinoId: string;
  tipoEstoqueId: string;
  data: string;
  /** A loja do estoque de origem (`null` no CD), a da auditoria e dos movimentos. */
  lojaOrigemId: string | null;
}

/**
 * O "hoje" da transferência (ERP 1.5): no fuso da loja do estoque de origem e, no estoque sem loja (o CD), no fuso da
 * empresa. A loja do estoque é a de menor código (`lojaDoEstoque`, a mesma regra do acerto).
 */
const sqlLojaDoEstoque = (estoque: SQL) =>
  sql`(select l.id from lojas l where l.estoque_id = ${estoque} and l.excluido_em is null order by l.codigo limit 1)`;

/**
 * Cabeçalho do rascunho: a origem existe, está entre os estoques permitidos para movimentar de quem grava (fora dela,
 * 403 no campo, como o acerto e o recebimento) e está ativa; o destino existe e está ativo, mas **não precisa** estar
 * entre os permitidos (o CD despacha para a loja que o expedidor não enxerga; quem recebe é que precisa do destino,
 * F2-B24); o tipo de estoque ativo (vazio = o padrão, o Disponível); e a data do documento, não futura no fuso da
 * origem (vazia = hoje).
 */
export async function conferirCabecalhoTransferencia(
  tx: DbEmpresa,
  dados: Pick<CriarTransferencia, 'estoqueOrigemId' | 'estoqueDestinoId' | 'tipoEstoqueId' | 'data'>,
  sessao: SessaoErp,
): Promise<CabecalhoTransferencia> {
  const origemId = dados.estoqueOrigemId.toLowerCase();
  const destinoId = dados.estoqueDestinoId.toLowerCase();
  const { rows: o } = await tx.execute<{ ativo: boolean; loja_id: string | null; hoje: string }>(sql`
    select e.ativo, ${sqlLojaDoEstoque(sql`e.id`)} as loja_id,
           coalesce((select (now() at time zone l.fuso_horario)::date from lojas l
                      where l.estoque_id = e.id and l.excluido_em is null order by l.codigo limit 1),
                    ${hojeNaEmpresa})::text as hoje
      from estoques e where e.id = ${origemId} and e.excluido_em is null`);
  if (!o[0]) throw erroCampo('estoqueOrigemId', 'Estoque não encontrado');
  if (!estoquePermitido(sessao, origemId, 'movimentar'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque de origem está fora dos seus estoques permitidos.', {
      campos: { estoqueOrigemId: ['Fora dos seus estoques permitidos'] },
    });
  if (!o[0].ativo) throw erroCampo('estoqueOrigemId', 'Estoque inativo');
  const { rows: d } = await tx.execute<{ ativo: boolean }>(sql`
    select ativo from estoques where id = ${destinoId} and excluido_em is null`);
  if (!d[0]) throw erroCampo('estoqueDestinoId', 'Estoque não encontrado');
  if (!d[0].ativo) throw erroCampo('estoqueDestinoId', 'Estoque inativo');
  const tipoEstoqueId = await resolverTipoEstoque(tx, dados.tipoEstoqueId);
  // `AAAA-MM-DD` compara como texto.
  const hoje = o[0].hoje;
  const data = dados.data ?? hoje;
  if (data > hoje) throw erroCampo('data', 'A data não pode ser futura');
  return {
    estoqueOrigemId: origemId,
    estoqueDestinoId: destinoId,
    tipoEstoqueId,
    data,
    lojaOrigemId: o[0].loja_id,
  };
}

type ProdutoTransferencia = {
  id: string;
  nome: string;
  tipo: string;
  controla_estoque: boolean;
  preco_venda: string;
  preco_custo: string;
  sigla: string;
};

/**
 * Confere os itens (no rascunho e de novo no envio, porque o cadastro pode ter mudado): o produto existe e tem saldo
 * próprio (combo, serviço e produzido não; "Com variações" também não enquanto as variações estão travadas, D43, e a
 * `variacaoId` tem de vir vazia) e controla estoque; o lote, quando informado, é do produto e do estoque de origem (ou
 * sem estoque; `conferirLotesItens`, a regra do motor). Os erros saem em `itens.N.campo`, com N = a posição do item.
 */
export async function conferirItensTransferencia(
  tx: DbEmpresa,
  estoqueOrigemId: string,
  itens: ReadonlyArray<Pick<ItemTransferencia, 'produtoId' | 'variacaoId' | 'loteId'>>,
): Promise<Map<string, ProdutoTransferencia>> {
  const mapa = new Map<string, ProdutoTransferencia>();
  if (!itens.length) return mapa;
  const { rows } = await tx.execute<ProdutoTransferencia>(sql`
    select p.id, p.nome, p.tipo, p.controla_estoque, p.preco_venda::text, p.preco_custo::text, u.sigla
      from produtos p join unidades_medida u on u.id = p.unidade_id
     where p.excluido_em is null and p.id = any(${lista(itens.map((i) => i.produtoId))}::uuid[])`);
  for (const r of rows) mapa.set(r.id, r);
  const campos: Record<string, string[]> = {};
  itens.forEach((it, i) => {
    const campo = `itens.${i}.produtoId`;
    const p = mapa.get(it.produtoId.toLowerCase());
    if (!p) campos[campo] = ['Produto não encontrado'];
    else if ((TIPOS_SEM_ESTOQUE as readonly string[]).includes(p.tipo))
      campos[campo] = [
        p.tipo === 'kit'
          ? 'Combo não tem estoque próprio: transfira os componentes'
          : p.tipo === 'produzido'
            ? 'Produto produzido não tem estoque próprio: transfira os insumos da ficha técnica'
            : 'Serviço não tem estoque',
      ];
    else if (p.tipo === 'com_variacoes')
      campos[campo] = ['Produto com variações: o saldo é por variação, que a transferência ainda não lança'];
    else if (!p.controla_estoque) campos[campo] = ['Produto sem controle de estoque'];
    if (it.variacaoId !== null)
      campos[`itens.${i}.variacaoId`] = ['Variações ainda não estão habilitadas: deixe a variação vazia'];
  });
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os itens destacados.', { campos });
  await conferirLotesItens(tx, estoqueOrigemId, itens);
  return mapa;
}

/**
 * Grava os itens do rascunho como o recebimento: os que saíram são excluídos logicamente, os mantidos (mesmo id, mesmo
 * produto e mesmo lote) têm só a quantidade atualizada e os novos entram com a sequência depois da maior já usada.
 * Trocar o produto ou o lote de uma linha = excluir + inserir: o `uq_itens_transferencia_produto` só vale para os vivos,
 * e duas linhas que trocam de lote entre si não colidem no meio da gravação. Recalcula `qtd_itens` pelas linhas vivas.
 */
export async function gravarItensTransferencia(
  tx: DbEmpresa,
  transferencia: { id: string; estoqueOrigemId: string },
  itens: readonly ItemTransferencia[],
): Promise<void> {
  await conferirItensTransferencia(tx, transferencia.estoqueOrigemId, itens);
  const { rows: atuais } = await tx.execute<{ id: string; produto_id: string; lote_id: string | null }>(sql`
    select id, produto_id, lote_id from itens_transferencia
     where transferencia_id = ${transferencia.id} and excluido_em is null`);
  const mantidos = new Set(
    itens.flatMap((it) =>
      it.id &&
      atuais.some(
        (a) =>
          a.id === it.id!.toLowerCase() &&
          a.produto_id === it.produtoId.toLowerCase() &&
          a.lote_id === (it.loteId?.toLowerCase() ?? null),
      )
        ? [it.id.toLowerCase()]
        : [],
    ),
  );
  const sair = atuais.filter((a) => !mantidos.has(a.id)).map((a) => a.id);
  if (sair.length)
    await tx.execute(sql`
      update itens_transferencia set excluido_em = now() where id = any(${lista(sair)}::uuid[])`);
  const { rows: seq } = await tx.execute<{ n: number }>(sql`
    select coalesce(max(sequencia), 0)::int as n from itens_transferencia where transferencia_id = ${transferencia.id}`);
  let sequencia = seq[0]?.n ?? 0;
  const atualizados = new Set<string>();
  for (const it of itens) {
    const idMantido = it.id?.toLowerCase();
    if (idMantido && mantidos.has(idMantido) && !atualizados.has(idMantido)) {
      atualizados.add(idMantido);
      await tx.execute(sql`
        update itens_transferencia set quantidade_enviada = ${it.quantidade}::numeric where id = ${idMantido}`);
    } else {
      sequencia += 1;
      await tx.execute(sql`
        insert into itens_transferencia (id, transferencia_id, sequencia, produto_id, variacao_id, lote_id,
                                         quantidade_enviada)
        values (${uuidv7()}, ${transferencia.id}, ${sequencia}, ${it.produtoId}, ${it.variacaoId}, ${it.loteId},
                ${it.quantidade}::numeric)`);
    }
  }
  await tx.execute(sql`
    update transferencias_estoque t
       set qtd_itens = (select count(*)::int from itens_transferencia i
                         where i.transferencia_id = t.id and i.excluido_em is null)
     where t.id = ${transferencia.id}`);
}

/** O cabeçalho que o envio e o cancelamento leem (a transferência já travada pelo controller). */
export interface TransferenciaATratar {
  id: string;
  codigo: number;
  status: StatusTransferencia;
  estoqueOrigemId: string;
  estoqueDestinoId: string;
  tipoEstoqueId: string;
}

/** O que o envio lançou (auditoria). */
export interface ResultadoEnvio {
  itens: number;
  /** `TRANSF_SAIDA` lançados (um por item, ou um por lote na divisão FEFO). */
  movimentos: number;
  /** `ACERTO_COMPENSACAO` lançadas contra um "Definir" já efetivado com a contagem à frente (F2-B4). */
  compensacoes: number;
}

/** Estoque e tipo do documento continuam vivos e ativos no envio (o rascunho os conferiu ao ser gravado). */
async function exigirEstoquesAtivosNoEnvio(tx: DbEmpresa, t: TransferenciaATratar): Promise<void> {
  const { rows } = await tx.execute<{ id: string; nome: string; ativo: boolean; excluido: boolean }>(sql`
    select id, nome, ativo, excluido_em is not null as excluido from estoques
     where id in (${t.estoqueOrigemId}::uuid, ${t.estoqueDestinoId}::uuid)`);
  for (const [campo, id, rotulo] of [
    ['estoqueOrigemId', t.estoqueOrigemId, 'de origem'],
    ['estoqueDestinoId', t.estoqueDestinoId, 'de destino'],
  ] as const) {
    const e = rows.find((r) => r.id === id.toLowerCase());
    if (!e || e.excluido)
      throw erroCampo(campo, `O estoque ${rotulo} foi excluído: troque-o no rascunho`, 'REGRA_NEGOCIO');
    if (!e.ativo)
      throw erroCampo(
        campo,
        `O estoque ${rotulo} "${e.nome}" está inativo: troque-o no rascunho ou reative-o antes de enviar`,
        'REGRA_NEGOCIO',
      );
  }
  const { rows: tipo } = await tx.execute<{ nome: string; ativo: boolean }>(sql`
    select nome, ativo from tipos_estoque where id = ${t.tipoEstoqueId} and excluido_em is null`);
  if (!tipo[0]?.ativo)
    throw erroCampo(
      'tipoEstoqueId',
      `O tipo de estoque ${tipo[0] ? `"${tipo[0].nome}"` : 'da transferência'} está inativo: troque o tipo do rascunho ou reative o tipo antes de enviar`,
      'REGRA_NEGOCIO',
    );
}

/**
 * Envia a transferência **já travada** em `rascunho` (ERP 13.7, 1ª etapa; SYNC 15.1): confere de novo o estoque, o
 * tipo, os produtos e os lotes; trava as linhas de saldo da origem em ordem estável e confere o saldo (o ERP não deixa
 * negativo, salvo `quem.permiteNegativo` = Master ou `estoque.permite_negativo_erp` da loja da origem; a linha soma
 * todos os itens do produto, e o item com lote também confere o saldo do lote, como a Saída do acerto); lança um
 * `TRANSF_SAIDA` por item em `now()` (F2-B4) ao custo médio vigente da linha (a saída comum, ERP 13.1.4), com o lote
 * informado ou, sem ele, dividido em FEFO pelo motor (um movimento por lote, `documento_item_id` = o item); passa os
 * movimentos pela `compensarDefinir` (a saída lançada antes de um "Definir" com a contagem um pouco à frente); grava o
 * custo unitário em cada item **antes** de a situação sair do rascunho (o trigger só deixa mexer nos itens nele) e
 * passa a `em_transito` com quem e quando enviou. O destino não recebe nada aqui: a entrada é do recebimento
 * (`receberTransferencia`, F2-B24), que repete cada parte da saída.
 */
export async function enviarTransferencia(
  tx: DbEmpresa,
  t: TransferenciaATratar,
  quem: { usuarioId: string; permiteNegativo: boolean },
): Promise<ResultadoEnvio> {
  // Início do documento (regra de data): todos os itens lançam "agora", e a folga é medida contra ele.
  const inicio = new Date();
  await exigirEstoquesAtivosNoEnvio(tx, t);
  const { rows: itens } = await tx.execute<{
    id: string;
    produto_id: string;
    variacao_id: string | null;
    lote_id: string | null;
    quantidade_enviada: string;
  }>(sql`
    select id, produto_id, variacao_id, lote_id, quantidade_enviada::text from itens_transferencia
     where transferencia_id = ${t.id} and excluido_em is null order by sequencia`);
  if (!itens.length) throw new ErroApi('REGRA_NEGOCIO', 'Inclua ao menos um item antes de enviar.');
  const produtos = await conferirItensTransferencia(
    tx,
    t.estoqueOrigemId,
    itens.map((i) => ({ produtoId: i.produto_id, variacaoId: i.variacao_id, loteId: i.lote_id })),
  );
  const { rows: loja } = await tx.execute<{ id: string | null }>(
    sql`select ${sqlLojaDoEstoque(sql`${t.estoqueOrigemId}::uuid`)} as id`,
  );
  const lojaId = loja[0]?.id ?? null;
  const chave = (c: ChaveSaldo) =>
    `${c.estoqueId}|${c.produtoId}|${c.variacaoId ?? ''}|${c.tipoEstoqueId}`.toLowerCase();
  const chaves = itens.map((i, posicao) => ({
    posicao,
    item: i,
    estoqueId: t.estoqueOrigemId,
    produtoId: i.produto_id,
    variacaoId: i.variacao_id,
    tipoEstoqueId: t.tipoEstoqueId,
    loteId: i.lote_id,
  }));
  // As linhas de saldo da origem, uma vez cada, na ordem estável (o motor as trava de novo sem esperar). Com elas
  // travadas, o saldo de cada lote também fica estável (só quem trava a linha grava a do lote).
  const porLinha = new Map<string, { c: (typeof chaves)[number]; total: Dec }>();
  for (const c of chaves) {
    const l = porLinha.get(chave(c)) ?? { c, total: dec(0) };
    l.total = l.total.plus(c.item.quantidade_enviada);
    porLinha.set(chave(c), l);
  }
  const campos: Record<string, string[]> = {};
  for (const c of ordenarChaves([...porLinha.values()].map((l) => ({ ...l.c, loteId: null })))) {
    const saldo = await travarSaldo(tx, c);
    const { total } = porLinha.get(chave(c))!;
    const p = produtos.get(c.produtoId)!;
    if (!quem.permiteNegativo && dec(saldo.quantidade).minus(total).lt(0))
      campos[`itens.${c.posicao}.quantidade`] = [
        `Saldo insuficiente de ${p.nome} na origem: ${Number(saldo.quantidade).toLocaleString('pt-BR')} ${p.sigla}`,
      ];
  }
  if (!quem.permiteNegativo)
    for (const c of chaves) {
      if (!c.loteId || campos[`itens.${c.posicao}.quantidade`]) continue;
      const doLote = await saldoDoLote(tx, { ...c, loteId: c.loteId });
      if (dec(doLote).minus(c.item.quantidade_enviada).lt(0)) {
        const p = produtos.get(c.produtoId)!;
        campos[`itens.${c.posicao}.quantidade`] = [
          `Saldo insuficiente do lote de ${p.nome} na origem: ${Number(doLote).toLocaleString('pt-BR')} ${p.sigla}`,
        ];
      }
    }
  if (Object.keys(campos).length)
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'A transferência deixaria saldo negativo na origem. Ajuste as quantidades ou peça a um usuário Master (Configurações › Estoque › "Permite saldo negativo no ERP").',
      { campos },
    );
  const linhas: NovoMovimento[] = itens.map((i) => {
    const p = produtos.get(i.produto_id)!;
    return {
      estoqueId: t.estoqueOrigemId,
      produtoId: i.produto_id,
      variacaoId: i.variacao_id,
      tipoEstoqueId: t.tipoEstoqueId,
      loteId: i.lote_id,
      tipoMovimento: 'TRANSF_SAIDA',
      quantidade: decTexto(dec(i.quantidade_enviada).neg(), 3),
      custoUnitario: null,
      custoReferencia: p.preco_custo,
      precoVenda: p.preco_venda,
      dataMovimento: inicio,
      lojaId,
      usuarioId: quem.usuarioId,
      documentoTipo: 'transferencia',
      documentoId: t.id,
      documentoItemId: i.id,
      unidadeDocumento: p.sigla.slice(0, 6),
    };
  });
  const r = await lancarDocumento(tx, linhas, { inicioDocumento: inicio });
  const compensacoes = await compensarDefinir(tx, r.movimentos, `transferência ${t.codigo}`);
  // O custo do item é o custo médio da linha na saída: todas as partes da divisão FEFO saem pelo mesmo (o primeiro
  // movimento do item basta). A entrada no destino (`receberTransferencia`) usa o custo gravado em cada movimento.
  const custos = new Map<string, string>();
  for (const m of r.movimentos)
    if (m.linha.documentoItemId && !custos.has(m.linha.documentoItemId))
      custos.set(m.linha.documentoItemId, m.custoUnitario);
  for (const bloco of emBlocos([...custos]))
    await tx.execute(sql`
      update itens_transferencia i set custo_unitario = v.custo
        from (values ${sql.join(
          bloco.map(([id, custo]) => sql`(${id}::uuid, ${custo}::numeric)`),
          sql`, `,
        )}) as v(id, custo)
       where i.id = v.id`);
  await tx.execute(sql`
    update transferencias_estoque
       set status = 'em_transito', enviada_em = now(), enviada_por_id = ${quem.usuarioId},
           atualizado_por_id = ${quem.usuarioId}
     where id = ${t.id}`);
  return { itens: itens.length, movimentos: r.movimentos.length, compensacoes: compensacoes.length };
}

/** O resumo do envio na auditoria. */
export function resumoEnvio(r: ResultadoEnvio): string {
  const base = `${r.itens} item(ns), ${r.movimentos} movimento(s)`;
  return r.compensacoes
    ? `${base}, ${r.compensacoes} anulado(s) por "Definir" já efetivado de contagem posterior`
    : base;
}

/** O que o cancelamento lançou (auditoria). */
export interface ResultadoCancelamento {
  /** `TRANSF_RETORNO` lançados (um por `TRANSF_SAIDA`; zero no rascunho). */
  retornos: number;
  /** `ESTORNO_ACERTO` das compensações que um "Definir" lançou contra as saídas. */
  compensacoes: number;
}

/**
 * Cancela a transferência **já travada** (ERP 13.7), com o motivo. Do rascunho, sem efeito no estoque. Do trânsito, um
 * `TRANSF_RETORNO` (entrada, MD 7.3) de cada `TRANSF_SAIDA` ainda não estornado, com `estorno_de_id` = a saída, no
 * mesmo lote e ao custo gravado nela (o estorno de saída do T20: o custo médio da origem volta ao de antes quando nada
 * entrou no meio), e um `ESTORNO_ACERTO` de cada compensação que um "Definir" lançou contra elas (como o estorno do
 * recebimento, decisão 160): o documento volta a não ter efeito nenhum. A entrada não pode deixar saldo negativo (o
 * estorno da compensação, uma saída, anula exatamente a entrada da própria compensação, na mesma linha e lote), então
 * não há regra de negativo; os retornos vão antes, na ordem do documento, para a linha não passar pelo negativo no
 * meio. A recebida não se cancela (faz-se uma transferência inversa): quem chama recusa antes.
 */
export async function cancelarTransferencia(
  tx: DbEmpresa,
  t: TransferenciaATratar,
  quem: { usuarioId: string; motivo: string },
): Promise<ResultadoCancelamento> {
  let retornos = 0;
  let compensacoes = 0;
  if (t.status === 'em_transito') {
    const inicio = new Date();
    const { rows: saidas } = await tx.execute<{
      id: string;
      estoque_id: string;
      loja_id: string | null;
      produto_id: string;
      variacao_id: string | null;
      tipo_estoque_id: string;
      lote_id: string | null;
      quantidade: string;
      custo_unitario: string;
      preco_venda: string | null;
      documento_item_id: string | null;
      unidade_documento: string | null;
    }>(sql`
      select m.id, m.estoque_id, m.loja_id, m.produto_id, m.variacao_id, m.tipo_estoque_id, m.lote_id,
             m.quantidade::text, m.custo_unitario::text, m.preco_venda::text, m.documento_item_id,
             m.unidade_documento
        from movimentos_estoque m
       where m.documento_tipo = 'transferencia' and m.documento_id = ${t.id} and m.tipo_movimento = 'TRANSF_SAIDA'
         and m.estorno_de_id is null
         and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)
       order by m.seq_lancamento`);
    const comuns = (m: { estoque_id: string; produto_id: string; variacao_id: string | null }) => ({
      estoqueId: m.estoque_id,
      produtoId: m.produto_id,
      variacaoId: m.variacao_id,
      dataMovimento: inicio,
      usuarioId: quem.usuarioId,
      documentoTipo: 'transferencia' as const,
      documentoId: t.id,
      observacao: quem.motivo.slice(0, 255),
    });
    const linhas: NovoMovimento[] = saidas.map((m) => ({
      ...comuns(m),
      tipoEstoqueId: m.tipo_estoque_id,
      loteId: m.lote_id,
      tipoMovimento: 'TRANSF_RETORNO',
      quantidade: decTexto(dec(m.quantidade).neg(), 3),
      // Estorno de saída (T20): ao custo da saída original.
      custoUnitario: m.custo_unitario,
      custoReferencia: m.custo_unitario,
      precoVenda: m.preco_venda,
      lojaId: m.loja_id,
      documentoItemId: m.documento_item_id,
      unidadeDocumento: m.unidade_documento,
      estornoDeId: m.id,
    }));
    // A compensação de uma saída é uma entrada; o estorno dela (uma saída, ao custo médio vigente) é `ESTORNO_ACERTO`
    // (sinal 0, como no estorno do acerto e do recebimento), no item da saída compensada.
    const contra = await compensacoesDoDocumento(tx, 'transferencia', t.id);
    for (const c of contra)
      linhas.push({
        ...comuns(c),
        tipoEstoqueId: c.tipo_estoque_id,
        loteId: c.lote_id,
        tipoMovimento: 'ESTORNO_ACERTO',
        quantidade: decTexto(dec(c.quantidade).neg(), 3),
        custoUnitario: null,
        custoReferencia: c.custo_unitario,
        precoVenda: c.preco_venda,
        lojaId: c.loja_id,
        documentoItemId: c.documento_item_id,
        unidadeDocumento: c.unidade_documento,
        estornoDeId: c.id,
      });
    if (linhas.length) await lancarDocumento(tx, linhas, { inicioDocumento: inicio });
    retornos = saidas.length;
    compensacoes = contra.length;
  }
  await tx.execute(sql`
    update transferencias_estoque
       set status = 'cancelada', cancelada_em = now(), cancelada_por_id = ${quem.usuarioId},
           motivo_cancelamento = ${quem.motivo.slice(0, 255)}, atualizado_por_id = ${quem.usuarioId}
     where id = ${t.id}`);
  return { retornos, compensacoes };
}

/** O resumo do cancelamento na auditoria (sem o motivo). */
export function resumoCancelamento(r: ResultadoCancelamento, deRascunho: boolean): string {
  if (deRascunho) return 'rascunho, sem efeito no estoque';
  const base = `${r.retornos} retorno(s) à origem`;
  return r.compensacoes ? `${base}, ${r.compensacoes} compensação(ões) estornada(s)` : base;
}

/**
 * Detalhe da transferência; `null` = inexistente, excluída ou fora dos estoques visíveis (`filtro`: a origem **ou** o
 * destino entre os visíveis — quem só tem o destino vê a transferência que vai receber). O "Saldo na origem" (ERP
 * 13.7) é o da linha da origem × tipo (o do lote, no item com lote) e sai `null` para quem não vê a origem; o custo do
 * item (o da saída), só com `produtos.ver_custo`.
 */
export async function detalheTransferencia(
  db: DbEmpresa,
  id: string,
  sessao: SessaoErp,
  filtro: SQL | undefined,
): Promise<TransferenciaDetalhe | null> {
  const { rows } = await db.execute<Linha>(sql`
    select t.*, t.data::text as data_texto, eo.nome as origem_nome, ed.nome as destino_nome,
           te.nome as tipo_estoque_nome, au.nome as autor_nome, en.nome as enviada_por_nome,
           rc.nome as recebida_por_nome, ca.nome as cancelada_por_nome, ${sqlVersaoTransferencia} as versao_documento
      from transferencias_estoque t
      join estoques eo on eo.id = t.estoque_origem_id
      join estoques ed on ed.id = t.estoque_destino_id
      join tipos_estoque te on te.id = t.tipo_estoque_id
      left join usuarios au on au.id = t.atualizado_por_id
      left join usuarios en on en.id = t.enviada_por_id
      left join usuarios rc on rc.id = t.recebida_por_id
      left join usuarios ca on ca.id = t.cancelada_por_id
     where t.id = ${id} and t.excluido_em is null ${filtro ? sql`and ${filtro}` : sql``}`);
  const t = rows[0];
  if (!t) return null;
  const veOrigem = estoquePermitido(sessao, t.estoque_origem_id as string, 'ver');
  const { rows: itens } = await db.execute<Linha>(sql`
    select i.id, i.sequencia, i.produto_id, i.variacao_id, i.lote_id, pl.lote, pl.validade::text as validade,
           i.quantidade_enviada::text, i.quantidade_recebida::text, i.diferenca::text, i.tratamento_divergencia,
           i.divergencia_tratada_em, i.custo_unitario::text,
           case when i.lote_id is null then s.quantidade::text else sl.quantidade::text end as saldo_origem
      from itens_transferencia i
      left join produtos_lotes pl on pl.id = i.lote_id
      left join saldos_estoque s on s.estoque_id = ${t.estoque_origem_id as string}::uuid
                                 and s.produto_id = i.produto_id and s.variacao_id is not distinct from i.variacao_id
                                 and s.tipo_estoque_id = ${t.tipo_estoque_id as string}::uuid
      left join saldos_lote sl on sl.estoque_id = ${t.estoque_origem_id as string}::uuid
                               and sl.produto_id = i.produto_id and sl.variacao_id is not distinct from i.variacao_id
                               and sl.tipo_estoque_id = ${t.tipo_estoque_id as string}::uuid and sl.lote_id = i.lote_id
     where i.transferencia_id = ${id} and i.excluido_em is null
     order by i.sequencia`);
  // Inclusive o produto excluído depois de entrar no documento (o item continua legível; no rascunho, regravar sem ele).
  const verCusto = sessao.permissoes.has('produtos.ver_custo');
  const opcoes = await opcoesPorId(
    db,
    itens.map((i) => i.produto_id as string),
    verCusto,
  );
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const texto = (v: unknown) => (v as string | null) ?? null;
  const itensDetalhe: ItemTransferenciaDetalhe[] = itens.map((i) => ({
    id: i.id as string,
    sequencia: i.sequencia as number,
    produtoId: i.produto_id as string,
    produto: opcoes.get(i.produto_id as string)!,
    variacaoId: texto(i.variacao_id),
    loteId: texto(i.lote_id),
    lote: texto(i.lote),
    validade: texto(i.validade),
    quantidadeEnviada: i.quantidade_enviada as string,
    quantidadeRecebida: texto(i.quantidade_recebida),
    diferenca: i.diferenca as string,
    tratamentoDivergencia: texto(i.tratamento_divergencia) as TratamentoDivergenciaTransferencia | null,
    divergenciaTratadaEm: iso(i.divergencia_tratada_em),
    custoUnitario: verCusto ? texto(i.custo_unitario) : null,
    // Sem linha de saldo (nunca movimentou na origem), o saldo é zero.
    saldoOrigem: veOrigem ? ((i.saldo_origem as string | null) ?? '0.000') : null,
  }));
  return {
    id: t.id as string,
    versao: Number(t.versao_documento),
    criadoEm: iso(t.criado_em)!,
    atualizadoEm: iso(t.atualizado_em)!,
    atualizadoPorNome: texto(t.autor_nome),
    codigo: t.codigo as number,
    estoqueOrigemId: t.estoque_origem_id as string,
    estoqueOrigemNome: t.origem_nome as string,
    estoqueDestinoId: t.estoque_destino_id as string,
    estoqueDestinoNome: t.destino_nome as string,
    tipoEstoqueId: t.tipo_estoque_id as string,
    tipoEstoqueNome: t.tipo_estoque_nome as string,
    data: t.data_texto as string,
    motivo: t.motivo as string,
    observacoes: texto(t.observacoes),
    status: t.status as StatusTransferencia,
    enviadaEm: iso(t.enviada_em),
    enviadaPorNome: texto(t.enviada_por_nome),
    recebidaEm: iso(t.recebida_em),
    recebidaPorNome: texto(t.recebida_por_nome),
    canceladaEm: iso(t.cancelada_em),
    canceladaPorNome: texto(t.cancelada_por_nome),
    motivoCancelamento: texto(t.motivo_cancelamento),
    nfeExternaChave: texto(t.nfe_externa_chave),
    nfeExternaNumero: texto(t.nfe_externa_numero),
    qtdItens: t.qtd_itens as number,
    itens: itensDetalhe,
  };
}
