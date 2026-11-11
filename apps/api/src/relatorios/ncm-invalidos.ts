/**
 * Relatório **NCMs inválidos** (ERP 16.3; Fase 2, F2-B41; README da API › decisão 187): os produtos que a fase
 * fiscal vai recusar pelo NCM, para limpar o cadastro antes dela, com a ação em lote "Definir NCM".
 *
 * **Motivos** (um por produto, nesta ordem): o NCM vazio; inexistente (fora da tabela `ncms` ou excluído dela, o que
 * saiu da Nomenclatura); fora de vigência (`vigencia_fim` no passado) — os três juntos são o contrário do `ncmVigente`
 * (`src/produtos/ncm.ts`, decisão 98), a mesma regra do cadastro, do filtro da listagem, da exportação e do dashboard —
 * e o **CEST incompatível**, só quando a tabela `cests` tem carga (`cests.csv`, decisão 187): o produto com CEST cujo
 * código não está na tabela vigente ou cujo NCM não começa por nenhum dos NCMs do CEST. O convênio lista posições
 * (`2203`), subposições e itens, então a comparação é pelo começo do código: o NCM 2203.00.00 cabe no CEST que lista
 * "2203". Com a tabela vazia, nenhum CEST é conferido (sem falso positivo).
 *
 * Fora: o combo e o serviço (não vão para a NFC-e; MD 3.6.3, decisão 67) e o produto excluído; o inativo entra (volta a
 * vender ao ser reativado). Só leitura; a correção é pelo cadastro ("Editar") ou pelo `definirNcmEmLote`.
 */
import {
  MOTIVOS_NCM_INVALIDO,
  PERMISSOES,
  RELATORIO_NCM_INVALIDOS,
  ROTULOS_MOTIVO_NCM_INVALIDO,
  criarProdutoSchema,
  filtrosNcmInvalidosSchema,
  type ConsultaNcmInvalidos,
  type DefinirNcmLote,
  type FiltrosNcmInvalidos,
  type LinhaNcmInvalido,
  type MotivoNcmInvalido,
  type RespostaNcmInvalidos,
  type ResultadoDefinirNcm,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import type { ColunaExportacao } from '../comum/exportacao.js';
import { detalheProduto, sqlVersaoAgregada } from '../produtos/consultas.js';
import { validarNoBanco } from '../produtos/gravacao.js';
import { ncmVigente } from '../produtos/ncm.js';
import { atualizarProduto, entradaDoDetalhe } from '../produtos/produtos.controller.js';
import type { Servicos } from '../servicos.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Localização da auditoria (a exportação e o "Definir NCM" de cada produto). */
export const LOCALIZACAO_NCM_INVALIDOS = 'Relatórios › NCMs inválidos';

/** A tabela `cests` tem carga (algum CEST não excluído): só então o motivo "CEST incompatível" é conferido. */
const CEST_CARREGADO = sql`exists (select 1 from cests where excluido_em is null)`;

/**
 * O CEST do produto `p` é compatível: vigente na tabela e com algum NCM da lista que é o começo do NCM do produto.
 * (A lista é curta, de 1 a algumas dezenas de códigos: o `unnest` por linha é barato.)
 */
const CEST_COMPATIVEL = sql`exists (
  select 1 from cests c
   where c.codigo = p.cest and c.excluido_em is null
     and (c.vigencia_inicio is null or c.vigencia_inicio <= current_date)
     and (c.vigencia_fim is null or c.vigencia_fim >= current_date)
     and exists (select 1 from unnest(c.ncms) as lista(ncm) where p.ncm like lista.ncm || '%'))`;

/**
 * O `x` dos dois usos (a página e a contagem): cada produto que entra no relatório com o `motivo` (nulo = NCM em
 * ordem), a vigência do NCM (o detalhe do "fora de vigência") e se o CEST está na tabela vigente (o detalhe do "CEST
 * incompatível"). Os três primeiros motivos saem do próprio `not ncmVigente` (decisão 98: um só helper; o teste compara
 * o conjunto com ele): o que não é vigente fica "inexistente" sem a linha não excluída em `ncms` e "fora de vigência"
 * com ela — se a regra do helper mudar (ex.: passar a olhar `vigencia_inicio`), o relatório muda junto.
 */
const COM_MOTIVO = sql`
    with carga as (select ${CEST_CARREGADO} as cest),
    x as (
      select p.id, p.codigo, p.nome, p.ativo, p.codigo_interno, p.ncm, p.cest, n.vigencia_fim,
             case
               when p.ncm is null or p.ncm = '' then 'vazio'
               when not ${ncmVigente(sql`p.ncm`)} then case when n.codigo is null then 'inexistente' else 'fora_vigencia' end
               when carga.cest and p.cest is not null and not ${CEST_COMPATIVEL} then 'cest_incompativel'
             end as motivo,
             case when carga.cest and p.cest is not null
                  then exists (select 1 from cests c where c.codigo = p.cest and c.excluido_em is null
                                  and (c.vigencia_inicio is null or c.vigencia_inicio <= current_date)
                                  and (c.vigencia_fim is null or c.vigencia_fim >= current_date)) end as cest_na_tabela
        from produtos p
        cross join carga
        left join ncms n on n.codigo = p.ncm and n.excluido_em is null
       where p.excluido_em is null and p.tipo not in ('kit', 'servico'))`;

/**
 * Uma linha por produto com motivo, na ordem do nome e do código, com a versão agregada (a do "Definir NCM") e o EAN
 * principal lidos só para as linhas que saem. A exportação lê tudo pelo cursor; a tela passa a página.
 */
export function sqlNcmInvalidos(pagina: { limite: number; deslocamento: number } | null = null) {
  return sql`${COM_MOTIVO}
    select x.id, x.codigo, x.nome, x.ativo, x.codigo_interno, x.ncm, x.cest, x.motivo,
           x.vigencia_fim::text as vigencia_fim, x.cest_na_tabela,
           ${sqlVersaoAgregada(sql`x.id`)}::text as versao,
           (select cb.codigo from produtos_codigos_barras cb
             where cb.produto_id = x.id and cb.variacao_id is null and cb.excluido_em is null
             order by cb.principal desc, cb.id limit 1) as codigo_barras
      from (select * from x where x.motivo is not null
             order by lower(fn_unaccent(x.nome)), x.codigo
             ${pagina ? sql`limit ${pagina.limite} offset ${pagina.deslocamento}` : sql``}) x
     order by lower(fn_unaccent(x.nome)), x.codigo`;
}

/** Quantos produtos por motivo e se a tabela `cests` tem carga (o agregado sem `group by` dá uma linha mesmo vazio). */
const sqlContagem = () => sql`${COM_MOTIVO}
    select (select cest from carga) as cest_carregado,
           coalesce(jsonb_object_agg(m.motivo, m.n) filter (where m.motivo is not null), '{}') as por_motivo
      from (select motivo, count(*)::int as n from x where motivo is not null group by motivo) m`;

interface LinhaBanco {
  id: string;
  codigo: number | string;
  nome: string;
  ativo: boolean;
  codigo_interno: string | null;
  ncm: string | null;
  cest: string | null;
  motivo: MotivoNcmInvalido;
  vigencia_fim: string | null;
  cest_na_tabela: boolean | null;
  versao: string;
  codigo_barras: string | null;
  [k: string]: unknown;
}

type Campos = Record<string, string[]>;

const dataBr = (iso: string) => iso.split('-').reverse().join('/');

/** O porquê em texto, para a tela e o arquivo. */
export function detalheMotivo(
  r: Pick<LinhaBanco, 'motivo' | 'vigencia_fim' | 'cest_na_tabela' | 'cest' | 'ncm'>,
) {
  if (r.motivo === 'inexistente') return `O NCM ${r.ncm} não está na tabela vigente`;
  if (r.motivo === 'fora_vigencia' && r.vigencia_fim) return `Vigência até ${dataBr(r.vigencia_fim)}`;
  if (r.motivo === 'cest_incompativel')
    return r.cest_na_tabela
      ? `O NCM não está na lista do CEST ${r.cest}`
      : `O CEST ${r.cest} não está na tabela vigente`;
  return null;
}

const linhaNcmInvalido = (r: LinhaBanco): LinhaNcmInvalido => ({
  produtoId: r.id,
  produtoCodigo: Number(r.codigo),
  produtoNome: r.nome,
  versao: Number(r.versao),
  ativo: r.ativo,
  codigoInterno: r.codigo_interno,
  codigoBarras: r.codigo_barras,
  ncm: r.ncm,
  cest: r.cest,
  motivo: r.motivo,
  detalhe: detalheMotivo(r),
});

/** A página da tela com o total, a contagem por motivo e se a tabela `cests` tem carga. */
export async function paginaNcmInvalidos(
  db: DbEmpresa,
  q: ConsultaNcmInvalidos,
): Promise<RespostaNcmInvalidos> {
  const { rows } = await db.execute<LinhaBanco>(
    sqlNcmInvalidos({ limite: q.tamanho, deslocamento: (q.pagina - 1) * q.tamanho }),
  );
  const { rows: contagem } = await db.execute<{
    cest_carregado: boolean;
    por_motivo: Partial<Record<MotivoNcmInvalido, number>>;
  }>(sqlContagem());
  const porMotivo = Object.fromEntries(
    MOTIVOS_NCM_INVALIDO.map((m) => [m, Number(contagem[0]?.por_motivo[m] ?? 0)]),
  ) as Record<MotivoNcmInvalido, number>;
  return {
    itens: rows.map(linhaNcmInvalido),
    total: Object.values(porMotivo).reduce((a, b) => a + b, 0),
    pagina: q.pagina,
    tamanho: q.tamanho,
    porMotivo,
    cestCarregado: contagem[0]?.cest_carregado ?? false,
  };
}

/**
 * **Definir NCM em lote** (ERP 16.3, "Ação em lote"): o NCM escolhido no `<BuscaNcm>` para os produtos marcados, na
 * transação de quem chama (com a trava de ordenação, `travaVersao`), tudo ou nada. Cada produto passa pelo
 * `atualizarProduto` — a versão do relatório (409 se alguém mexeu depois), as regras do formulário, a auditoria
 * `editar` dele com a localização do relatório e a versão nova que desce ao PDV —, com a entrada montada do detalhe
 * gravado e só o NCM trocado. Antes de gravar, confere tudo e junta os erros por produto (`produtos.N`); o produto que
 * já tem o NCM não é regravado (não ganha versão nem auditoria à toa).
 */
export async function definirNcmEmLote(
  s: Pick<Servicos, 'auditoria' | 'custoCombos'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  d: DefinirNcmLote,
): Promise<ResultadoDefinirNcm> {
  // Defensiva: a rota já exige as duas permissões no `@Permissao`; vale para quem chamar a função fora dela.
  if (!sessao.permissoes.has('produtos.editar'))
    throw ErroApi.semPermissao(
      `Definir o NCM exige "${PERMISSOES.find((p) => p.chave === 'produtos.editar')?.descricao ?? 'produtos.editar'}".`,
    );
  const { rows: vigente } = await tx.execute(sql`select 1 where ${ncmVigente(d.ncm)}`);
  if (!vigente.length) throw erroCampo('ncm', 'NCM inexistente na tabela vigente');

  const campos: Campos = {};
  const add = (i: number, msg: string) => (campos[`produtos.${i}`] ??= []).push(msg);
  const conflitos: string[] = [];
  const preparados: Array<{
    id: string;
    versao: number;
    dados: ReturnType<typeof criarProdutoSchema.parse>;
  }> = [];
  let semMudanca = 0;
  for (const [i, alvo] of d.produtos.entries()) {
    // O detalhe como o formulário o vê (as lojas e os estoques permitidos, decisão 88): a gravação preserva as linhas
    // das lojas de fora, como no PUT do produto. Com o custo: o `atualizarProduto` o ignora sem `produtos.ver_custo`.
    const det = await detalheProduto(tx, alvo.id, true, sessao.lojas, sessao.estoques);
    if (!det) {
      // A identificação na mensagem (o produto excluído depois de abrir o relatório ainda tem a linha), para o
      // gerente saber qual desmarcar.
      const { rows: excluido } = await tx.execute<{ codigo: number | string; nome: string }>(
        sql`select codigo, nome from produtos where id = ${alvo.id}`,
      );
      add(
        i,
        excluido[0]
          ? `${excluido[0].codigo} - ${excluido[0].nome}: excluído depois de abrir o relatório; gere o relatório de novo`
          : 'Produto não encontrado',
      );
      continue;
    }
    const nome = `${det.codigo} - ${det.nome}`;
    // A versão do cadastro inteiro (decisão 47), a mesma que o `atualizarProduto` confere de novo com a linha travada.
    if (det.versao !== alvo.versao) {
      conflitos.push(nome);
      add(i, `${nome}: alterado depois de abrir o relatório; gere o relatório de novo`);
      continue;
    }
    if (det.ncm === d.ncm) {
      semMudanca++;
      continue;
    }
    const r = criarProdutoSchema.safeParse({ ...entradaDoDetalhe(det), ncm: d.ncm });
    if (!r.success) {
      add(i, `${nome}: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
      continue;
    }
    try {
      await validarNoBanco(tx, r.data, alvo.id, {
        tipo: det.tipo,
        temMovimento: det.temMovimento,
        saldoNaoZero: false,
      });
    } catch (e) {
      if (!(e instanceof ErroApi)) throw e;
      const msgs = Object.values(e.extras.campos ?? {}).flat();
      add(i, `${nome}: ${msgs.length ? msgs.join('; ') : e.message}`);
      continue;
    }
    preparados.push({ id: alvo.id, versao: alvo.versao, dados: r.data });
  }
  if (Object.keys(campos).length) {
    const total = Object.keys(campos).length;
    throw new ErroApi(
      conflitos.length === total ? 'CONFLITO' : 'VALIDACAO',
      conflitos.length === total
        ? `${total} produto(s) foram alterados depois de abrir o relatório. Gere o relatório de novo. Nada foi gravado.`
        : `Verifique os produtos destacados (${total} com erro). Nada foi gravado.`,
      { campos },
    );
  }

  const deps = { auditoria: s.auditoria, custoCombos: s.custoCombos };
  const atualizados: ResultadoDefinirNcm['atualizados'] = [];
  for (const p of preparados) {
    await atualizarProduto(deps, tx, sessao, origem, p.id, p.versao, p.dados, {
      validado: true,
      localizacao: LOCALIZACAO_NCM_INVALIDOS,
    });
    atualizados.push({ id: p.id, codigo: 0, nome: p.dados.nome });
  }
  if (atualizados.length) {
    const { rows } = await tx.execute<{ id: string; codigo: number }>(sql`
      select id, codigo from produtos where id = any(${`{${atualizados.map((a) => a.id).join(',')}}`}::uuid[])`);
    const codigos = new Map(rows.map((r) => [r.id, Number(r.codigo)]));
    for (const a of atualizados) a.codigo = codigos.get(a.id) ?? 0;
  }
  return { atualizados, semMudanca };
}

/**
 * Provedor da exportação (`GET /relatorios/ncm-invalidos/exportar`, F2-B29; decisão 177): uma linha por produto com
 * o motivo e o detalhe. Sem custo nem loja (o produto é da empresa).
 */
export function provedorNcmInvalidos(): ProvedorRelatorio<FiltrosNcmInvalidos, LinhaBanco> {
  return {
    chave: RELATORIO_NCM_INVALIDOS,
    nomeArquivo: 'Relatorio_NCM_Invalidos',
    permissao: 'relatorios.ncm_invalidos',
    entidade: 'produtos',
    localizacao: LOCALIZACAO_NCM_INVALIDOS,
    filtros: filtrosNcmInvalidosSchema,
    colunas: () => {
      const colunas: ColunaExportacao<LinhaBanco>[] = [
        { rotulo: 'Código', valor: (r) => Number(r.codigo) },
        { rotulo: 'Produto', valor: (r) => r.nome, largura: 40 },
        { rotulo: 'Código interno', valor: (r) => r.codigo_interno },
        { rotulo: 'EAN', valor: (r) => r.codigo_barras, largura: 16 },
        { rotulo: 'NCM atual', valor: (r) => r.ncm },
        { rotulo: 'CEST', valor: (r) => r.cest },
        { rotulo: 'Motivo', valor: (r) => ROTULOS_MOTIVO_NCM_INVALIDO[r.motivo] },
        { rotulo: 'Detalhe', valor: (r) => detalheMotivo(r), largura: 40 },
        { rotulo: 'Ativo', valor: (r) => (r.ativo ? 'Sim' : 'Não') },
      ];
      return colunas;
    },
    consulta: () => sqlNcmInvalidos(),
  };
}
