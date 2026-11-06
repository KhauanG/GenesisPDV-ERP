/**
 * Sugestão de reposição da transferência (ERP 13.7 "Sugerir reposição"; Fase 2, F2-B25; F2-Q11 = D52; README da API ›
 * decisão 173): o CD monta a carga da loja com um clique. Entram os produtos da loja do estoque de destino abaixo do
 * estoque mínimo dela (`produtos_lojas`), contando o que já está a caminho (`sqlEmTransito`), na quantidade que leva o
 * destino ao máximo (ou a mínimo × 2, sem máximo), arredondada para cima à embalagem de compra de maior fator
 * (`estoque.reposicao_arredonda_embalagem`) e limitada ao saldo da origem. Só leitura: a tela (F2-B27) preenche a grade
 * do rascunho com o resultado, e quem salva confere tudo de novo (`gravarItensTransferencia`).
 */
import {
  Dec,
  dec,
  decTexto,
  LIMITE_ITENS_TRANSFERENCIA,
  sugestaoReposicaoSchema,
  type ItemSugestaoReposicao,
  type SugestaoReposicao,
  type SugestaoReposicaoConsulta,
  type Valor,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { TIPOS_SEM_ESTOQUE, lojaDoEstoque } from '../estoques/acertos.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import { opcoesPorId } from '../produtos/consultas.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { sqlEmTransito } from './em-transito.js';
import { conferirCabecalhoTransferencia } from './transferencias.js';

/** F2-Q11 = D52 (padrão até a confirmação do dono): arredonda ao fardo ou à caixa fechada. */
export const CHAVE_REPOSICAO_ARREDONDA_EMBALAGEM = 'estoque.reposicao_arredonda_embalagem';

/** Quantos produtos sem saldo na origem o aviso cita pelo nome (os demais saem como "e mais N"). */
const NOMES_NO_AVISO = 5;

export interface EntradaReposicao {
  estoqueMinimo: Valor;
  /** `null` = sem máximo: o alvo é mínimo × 2. */
  estoqueMaximo: Valor | null;
  saldoDestino: Valor;
  emTransito: Valor;
  saldoOrigem: Valor;
  /** Fator da embalagem de compra do arredondamento; `null` (ou ≤ 1) = sem arredondar. */
  fatorEmbalagem: Valor | null;
  /** Produto sem fração (`permite_fracao` falso): a falta sobe ao inteiro e o saldo da origem desce ao inteiro. */
  inteiro: boolean;
}

export interface ResultadoReposicao {
  /** Alvo − (saldo + em trânsito), antes do arredondamento e do limite; `'0.000'` = não está abaixo do mínimo. */
  falta: string;
  /** A sugerida (3 casas): arredondada à embalagem e limitada ao saldo da origem; `'0.000'` = nada a sugerir. */
  quantidade: string;
}

const ZERO: ResultadoReposicao = { falta: '0.000', quantidade: '0.000' };

/**
 * A conta da sugestão de um produto, em decimal (ADR-05). O produto entra só **abaixo** do mínimo (o mesmo `<` do
 * filtro "Abaixo do mínimo" dos saldos), contando o que está em trânsito para o destino: o que já foi mandado e não
 * chegou não é pedido de novo. A falta é `máximo − (saldo + em trânsito)` ou, sem máximo, `mínimo × 2 − (saldo + em
 * trânsito)`; com a embalagem (fator > 1), sobe ao próximo múltiplo do fator (o fardo fechado); por fim, nunca passa do
 * saldo da origem (o negativo conta como zero). Ex. (critério de pronto): mínimo 24, máximo 72, saldo 10 e 12 em
 * trânsito → falta 50 → 60 com o fardo de 12.
 */
export function calcularReposicao(e: EntradaReposicao): ResultadoReposicao {
  const minimo = dec(e.estoqueMinimo);
  const posicao = dec(e.saldoDestino).plus(dec(e.emTransito));
  if (posicao.gte(minimo)) return ZERO;
  const alvo = e.estoqueMaximo === null ? minimo.times(2) : dec(e.estoqueMaximo);
  const falta = alvo.minus(posicao);
  if (falta.lte(0)) return ZERO;
  let q = e.inteiro ? falta.ceil() : falta;
  const fator = e.fatorEmbalagem === null ? null : dec(e.fatorEmbalagem);
  if (fator && fator.gt(1)) q = q.div(fator).ceil().times(fator);
  const origem = Dec.max(dec(e.saldoOrigem), 0);
  q = Dec.min(q, e.inteiro ? origem.floor() : origem);
  return { falta: decTexto(falta, 3), quantidade: decTexto(q, 3) };
}

/** Os parâmetros da query nos nomes dos campos do rascunho, de onde a tela (F2-B27) pede a sugestão. */
const CAMPOS_DO_RASCUNHO: Readonly<Record<string, string>> = {
  origem: 'estoqueOrigemId',
  destino: 'estoqueDestinoId',
};

/**
 * Valida a query da sugestão (`sugestaoReposicaoSchema`) com os erros nos campos do rascunho: `origem` faltando ou
 * inválida sai em `estoqueOrigemId`, e `destino` (inclusive origem = destino, o `.refine` do schema) em
 * `estoqueDestinoId`, os mesmos nomes das conferências de `conferirCabecalhoTransferencia`. Assim a tela mapeia um
 * só conjunto de nomes; `tipoEstoqueId` já é o do rascunho.
 */
export function validarSugestaoReposicao(query: unknown): SugestaoReposicaoConsulta {
  const r = sugestaoReposicaoSchema.safeParse(query);
  if (r.success) return r.data;
  const erro = ErroApi.validacao(r.error);
  const campos: Record<string, string[]> = {};
  for (const [chave, mensagens] of Object.entries(erro.extras.campos ?? {}))
    (campos[CAMPOS_DO_RASCUNHO[chave] ?? chave] ??= []).push(...mensagens);
  throw new ErroApi(erro.codigo, erro.message, { campos });
}

/**
 * Os avisos e o corte da sugestão (parte pura, com teste unitário): o produto abaixo do mínimo sem saldo na origem é
 * citado pelo nome (os `NOMES_NO_AVISO` primeiros e "e mais N"), e acima de `LIMITE_ITENS_TRANSFERENCIA` itens ficam
 * os primeiros (a lista já vem por nome), com aviso. Não altera `sugeridos`.
 */
export function limitarSugestao<T>(
  sugeridos: readonly T[],
  semSaldo: readonly string[],
): { itens: T[]; avisos: string[] } {
  const avisos: string[] = [];
  if (semSaldo.length) {
    const nomes = semSaldo.slice(0, NOMES_NO_AVISO).join(', ');
    const resto = semSaldo.length > NOMES_NO_AVISO ? ` e mais ${semSaldo.length - NOMES_NO_AVISO}` : '';
    avisos.push(
      semSaldo.length === 1
        ? `1 produto abaixo do mínimo ficou de fora por não ter saldo na origem: ${nomes}.`
        : `${semSaldo.length} produtos abaixo do mínimo ficaram de fora por não ter saldo na origem: ${nomes}${resto}.`,
    );
  }
  if (sugeridos.length > LIMITE_ITENS_TRANSFERENCIA)
    avisos.push(
      `A sugestão passou de ${LIMITE_ITENS_TRANSFERENCIA} itens, o limite por transferência: ficaram os ${LIMITE_ITENS_TRANSFERENCIA} primeiros por nome (${sugeridos.length - LIMITE_ITENS_TRANSFERENCIA} ficaram de fora; faça outra transferência depois desta).`,
    );
  return { itens: sugeridos.slice(0, LIMITE_ITENS_TRANSFERENCIA), avisos };
}

type LinhaReposicao = {
  id: string;
  nome: string;
  permite_fracao: boolean;
  minimo: string;
  maximo: string | null;
  saldo_destino: string;
  em_transito: string;
  saldo_origem: string;
  fator: string | null;
  sigla: string | null;
};

/**
 * `GET /transferencias/sugestao-reposicao` (a rota confere `transferencias.criar` e valida a query com
 * `validarSugestaoReposicao`). A origem e o destino passam pelas conferências do rascunho
 * (`conferirCabecalhoTransferencia`): a origem entre os estoques permitidos para movimentar de quem pede (403) e
 * ativa, o destino ativo, e o tipo de estoque ativo (vazio = o padrão). Além delas, o destino tem de estar entre os
 * permitidos para ver (403), porque a sugestão mostra os números dele. Todos os erros, os do schema inclusive, saem
 * nos campos do rascunho (`estoqueOrigemId`, `estoqueDestinoId`, `tipoEstoqueId`), de onde a tela pede a sugestão.
 * Os saldos (destino e origem) e o em trânsito são os do tipo escolhido. O destino sem loja (o CD) não tem estoque
 * mínimo: sugestão vazia, com aviso.
 *
 * Ficam de fora o combo, o serviço e o produzido (sem saldo próprio), o "Com variações" (saldo por variação, travado
 * pelo D43), o que não controla estoque, o produto inativo ou excluído e o inativo na loja (`ativo_na_loja`), e o sem
 * mínimo na loja. O produto abaixo do mínimo sem saldo na origem sai da lista (a grade não aceita quantidade zero) e
 * é citado num aviso; acima de `LIMITE_ITENS_TRANSFERENCIA` itens, ficam os primeiros por nome, com aviso.
 */
export async function sugestaoReposicao(
  db: DbEmpresa,
  q: SugestaoReposicaoConsulta,
  sessao: SessaoErp,
): Promise<SugestaoReposicao> {
  const cab = await conferirCabecalhoTransferencia(
    db,
    {
      estoqueOrigemId: q.origem,
      estoqueDestinoId: q.destino,
      tipoEstoqueId: q.tipoEstoqueId ?? null,
      data: null,
    },
    sessao,
  );
  // O destino também tem de estar entre os permitidos (para ver): a resposta mostra o saldo, o em trânsito, o mínimo e
  // o máximo dele, e a própria quantidade (máximo − saldo − em trânsito) os entrega (D45; decisões 89 e 149). O
  // rascunho continua aceitando qualquer destino ativo: só a sugestão lê os números do destino.
  if (!estoquePermitido(sessao, cab.estoqueDestinoId, 'ver'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque de destino está fora dos seus estoques permitidos.', {
      campos: { estoqueDestinoId: ['Fora dos seus estoques permitidos'] },
    });
  const lojaDestino = await lojaDoEstoque(db, cab.estoqueDestinoId);
  if (!lojaDestino)
    return {
      itens: [],
      avisos: [
        'O estoque de destino não pertence a uma loja: não há estoque mínimo para comparar (o mínimo e o máximo são da loja, no cadastro do produto).',
      ],
    };
  const arredonda = await lerConfiguracao<boolean>(db, CHAVE_REPOSICAO_ARREDONDA_EMBALAGEM);
  // A embalagem de compra viva (`usa_compra`) de maior fator do produto, sem variação: o fardo ou a caixa fechada.
  const embalagem = arredonda
    ? sql`left join lateral (
             select c.fator, u.sigla from produtos_codigos_barras c
               left join unidades_medida u on u.id = c.unidade_id
              where c.produto_id = p.id and c.variacao_id is null and c.excluido_em is null and c.usa_compra
                and c.fator > 1
              order by c.fator desc, c.principal desc, c.codigo limit 1) emb on true`
    : sql`left join lateral (select null::numeric as fator, null::text as sigla) emb on true`;
  const saldo = (estoque: string) => sql`
    saldos_estoque where estoque_id = ${estoque}::uuid and tipo_estoque_id = ${cab.tipoEstoqueId}::uuid
                     and variacao_id is null`;
  const { rows } = await db.execute<LinhaReposicao>(sql`
    select p.id, p.nome, p.permite_fracao, pl.estoque_minimo::text as minimo, pl.estoque_maximo::text as maximo,
           coalesce(sd.quantidade, 0)::text as saldo_destino, coalesce(tr.quantidade, 0)::text as em_transito,
           coalesce(so.quantidade, 0)::text as saldo_origem, emb.fator::text as fator, emb.sigla
      from produtos_lojas pl
      join produtos p on p.id = pl.produto_id
      left join (select produto_id, quantidade from ${saldo(cab.estoqueDestinoId)}) sd on sd.produto_id = p.id
      left join (select produto_id, quantidade from ${saldo(cab.estoqueOrigemId)}) so on so.produto_id = p.id
      left join (${sqlEmTransito({ estoqueDestinoIds: [cab.estoqueDestinoId], tipoEstoqueId: cab.tipoEstoqueId })}) tr
             on tr.produto_id = p.id and tr.variacao_id is null
      ${embalagem}
     where pl.loja_id = ${lojaDestino}::uuid and pl.excluido_em is null and pl.ativo_na_loja
       and pl.estoque_minimo is not null
       and p.excluido_em is null and p.ativo and p.controla_estoque
       and p.tipo <> all(${`{${[...TIPOS_SEM_ESTOQUE, 'com_variacoes'].join(',')}}`}::text[])
       and coalesce(sd.quantidade, 0) + coalesce(tr.quantidade, 0) < pl.estoque_minimo
     order by lower(p.nome), p.codigo`);
  const sugeridos: Array<{ linha: LinhaReposicao; quantidade: string }> = [];
  const semSaldo: string[] = [];
  for (const r of rows) {
    const c = calcularReposicao({
      estoqueMinimo: r.minimo,
      estoqueMaximo: r.maximo,
      saldoDestino: r.saldo_destino,
      emTransito: r.em_transito,
      saldoOrigem: r.saldo_origem,
      fatorEmbalagem: r.fator,
      inteiro: !r.permite_fracao,
    });
    if (dec(c.quantidade).gt(0)) sugeridos.push({ linha: r, quantidade: c.quantidade });
    else if (dec(c.falta).gt(0)) semSaldo.push(r.nome);
  }
  const { itens, avisos } = limitarSugestao(sugeridos, semSaldo);
  const opcoes = await opcoesPorId(
    db,
    itens.map((s) => s.linha.id),
    sessao.permissoes.has('produtos.ver_custo'),
  );
  return {
    itens: itens.map(({ linha: r, quantidade }): ItemSugestaoReposicao => ({
      produtoId: r.id,
      produto: opcoes.get(r.id)!,
      estoqueMinimo: decTexto(r.minimo, 3),
      estoqueMaximo: r.maximo === null ? null : decTexto(r.maximo, 3),
      saldoDestino: decTexto(r.saldo_destino, 3),
      emTransito: decTexto(r.em_transito, 3),
      saldoOrigem: decTexto(r.saldo_origem, 3),
      embalagem: r.fator === null ? null : { unidadeSigla: r.sigla, fator: decTexto(r.fator, 3) },
      quantidade,
    })),
    avisos,
  };
}
