/**
 * O que as telas da transferência leem além do documento (ERP 13.7; Fase 2, F2-B27; README da API › decisão 175): os
 * **dados dos produtos da grade** do rascunho (o saldo na origem, os lotes e a embalagem, para quem monta a carga sem
 * as permissões do acerto) e o **romaneio** impresso pelo navegador (o cabeçalho da empresa, as duas pontas com a loja
 * e o endereço, e o documento). Só leitura.
 */
import {
  type ConsultaDadosProdutosTransferencia,
  type DadosProdutosTransferencia,
  type PontaRomaneioTransferencia,
  type RomaneioTransferencia,
  type TransferenciaDetalhe,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { embalagemDaLinha, sqlEmbalagemTransferencia } from './transferencias.js';

type Linha = Record<string, unknown>;

/**
 * `GET /transferencias/dados-produtos` (a rota confere `transferencias.criar` e a query): a origem existe e está entre os
 * estoques permitidos para movimentar de quem pede (403 no campo, a mesma conferência do rascunho); o tipo vazio é o
 * padrão (o informado não precisa estar ativo: é só leitura, e o rascunho gravado com um tipo inativado depois continua
 * mostrando o saldo dele). Por produto: o saldo na origem × tipo (zero sem linha), a embalagem de compra de maior fator
 * e os lotes ativos (ou com saldo) que são da origem ou sem estoque, em FEFO — os mesmos que o envio aceita
 * (`conferirLotesItens`). Sem variação (D43).
 */
export async function dadosProdutosTransferencia(
  db: DbEmpresa,
  q: ConsultaDadosProdutosTransferencia,
  sessao: SessaoErp,
): Promise<DadosProdutosTransferencia> {
  const origem = q.estoqueOrigemId.toLowerCase();
  const { rows: est } = await db.execute<{ id: string }>(sql`
    select id from estoques where id = ${origem} and excluido_em is null`);
  if (!est[0]) throw erroCampo('estoqueOrigemId', 'Estoque não encontrado');
  if (!estoquePermitido(sessao, origem, 'movimentar'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque de origem está fora dos seus estoques permitidos.', {
      campos: { estoqueOrigemId: ['Fora dos seus estoques permitidos'] },
    });
  const tipo = q.tipoEstoqueId
    ? sql`${q.tipoEstoqueId}::uuid`
    : sql`(select id from tipos_estoque where padrao and excluido_em is null limit 1)`;
  const ids = `{${[...new Set(q.produtoIds.map((i) => i.toLowerCase()))].join(',')}}`;
  const { rows } = await db.execute<Linha>(sql`
    select p.id, coalesce(s.quantidade, 0)::text as saldo, emb.fator::text as emb_fator, emb.sigla as emb_sigla
      from produtos p
      left join saldos_estoque s on s.produto_id = p.id and s.estoque_id = ${origem}::uuid
                                and s.tipo_estoque_id = ${tipo} and s.variacao_id is null
      ${sqlEmbalagemTransferencia(sql`p.id`)}
     where p.id = any(${ids}::uuid[])
     order by p.id`);
  const { rows: lotes } = await db.execute<Linha>(sql`
    select pl.id, pl.produto_id, pl.lote, to_char(pl.validade, 'YYYY-MM-DD') as validade,
           coalesce(sl.quantidade, 0)::text as q
      from produtos_lotes pl
      left join saldos_lote sl on sl.lote_id = pl.id and sl.estoque_id = ${origem}::uuid and sl.tipo_estoque_id = ${tipo}
     where pl.excluido_em is null and pl.variacao_id is null and (pl.ativo or coalesce(sl.quantidade, 0) <> 0)
       and (pl.estoque_id is null or pl.estoque_id = ${origem}::uuid)
       and pl.produto_id = any(${ids}::uuid[])
     order by pl.produto_id, pl.validade nulls last, pl.lote, pl.id`);
  return {
    produtos: rows.map((r) => ({
      produtoId: r.id as string,
      saldoOrigem: r.saldo as string,
      embalagem: embalagemDaLinha(r.emb_fator, r.emb_sigla),
      lotes: lotes
        .filter((l) => l.produto_id === r.id)
        .map((l) => ({
          loteId: l.id as string,
          lote: l.lote as string,
          validade: (l.validade as string | null) ?? null,
          quantidade: l.q as string,
        })),
    })),
  };
}

/** "Rua X, 500, sala 2, Centro, Londrina/PR, CEP 86020-000" das colunas de endereço de `alias` (empresa ou loja). */
const sqlEndereco = (t: SQL, municipio: SQL) => sql`nullif(concat_ws(', ',
  nullif(${t}.logradouro, ''), nullif(${t}.numero, ''), nullif(${t}.complemento, ''), nullif(${t}.bairro, ''),
  case when ${municipio}.nome is not null then ${municipio}.nome || coalesce('/' || ${t}.uf, '') end,
  case when nullif(${t}.cep, '') is not null
       then 'CEP ' || substr(${t}.cep, 1, 5) || '-' || substr(${t}.cep, 6) end), '')`;

/**
 * O romaneio (ERP 13.7 "Imprime romaneio"): o cabeçalho da empresa (razão social, fantasia, CNPJ, IE, endereço e
 * telefone), a origem e o destino com a loja do estoque (a de menor código, nula no CD) e o endereço (o do cadastro do
 * estoque ou, sem ele, o da loja), e o documento já lido com as regras de quem vê (`detalhe`). Não exige `empresa.ver`:
 * são os dados que saem no papel que acompanha a carga.
 */
export async function romaneioTransferencia(
  db: DbEmpresa,
  detalhe: TransferenciaDetalhe,
): Promise<RomaneioTransferencia> {
  const { rows: emp } = await db.execute<Linha>(sql`
    select e.razao_social, e.nome_fantasia, e.cnpj, e.ie, e.telefone,
           ${sqlEndereco(sql`e`, sql`m`)} as endereco, now() as agora
      from empresa e left join municipios m on m.codigo_ibge = e.municipio_ibge
     limit 1`);
  const e = emp[0];
  if (!e) throw ErroApi.naoEncontrado('Empresa não encontrada.');
  const { rows: pontas } = await db.execute<Linha>(sql`
    select es.id, es.codigo, es.nome, coalesce(nullif(es.endereco, ''), l.endereco) as endereco,
           l.nome as loja_nome, l.razao_social, l.cnpj
      from estoques es
      left join lateral (
        select l.nome, l.razao_social, l.cnpj, ${sqlEndereco(sql`l`, sql`m`)} as endereco
          from lojas l left join municipios m on m.codigo_ibge = l.municipio_ibge
         where l.estoque_id = es.id and l.excluido_em is null
         order by l.codigo limit 1) l on true
     where es.id in (${detalhe.estoqueOrigemId}::uuid, ${detalhe.estoqueDestinoId}::uuid)`);
  const ponta = (id: string, nome: string): PontaRomaneioTransferencia => {
    const p = pontas.find((x) => x.id === id);
    return {
      estoqueId: id,
      estoqueCodigo: (p?.codigo as number | undefined) ?? 0,
      estoqueNome: (p?.nome as string | undefined) ?? nome,
      endereco: (p?.endereco as string | null | undefined) ?? null,
      lojaNome: (p?.loja_nome as string | null | undefined) ?? null,
      lojaRazaoSocial: (p?.razao_social as string | null | undefined) ?? null,
      lojaCnpj: (p?.cnpj as string | null | undefined) ?? null,
    };
  };
  return {
    empresa: {
      razaoSocial: e.razao_social as string,
      nomeFantasia: (e.nome_fantasia as string | null) ?? null,
      cnpj: e.cnpj as string,
      ie: (e.ie as string | null) ?? null,
      endereco: (e.endereco as string | null) ?? null,
      telefone: (e.telefone as string | null) ?? null,
    },
    origem: ponta(detalhe.estoqueOrigemId, detalhe.estoqueOrigemNome),
    destino: ponta(detalhe.estoqueDestinoId, detalhe.estoqueDestinoNome),
    transferencia: detalhe,
    geradoEm: new Date(e.agora as string).toISOString(),
  };
}
