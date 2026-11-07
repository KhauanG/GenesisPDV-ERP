import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  type StreamableFile,
} from '@nestjs/common';
import {
  ajusteEstoqueProdutoSchema,
  alterarProdutoSchema,
  buscaProdutosSchema,
  combosMontaveis,
  criarProdutoSchema,
  dec,
  exportacaoQuerySchema,
  filtroProdutosSchema,
  gerarCodigoInterno,
  LIMITE_EXPORTACAO,
  limiteDeslocamento,
  ROTULOS_TIPO_PRODUTO,
  TIPOS_PRODUTO,
  validarGtin,
  type CriarProduto,
  type CriarProdutoEntrada,
  type FiltroProdutos,
  type Pagina,
  type ProdutoDetalhe,
  type ProdutoOpcao,
  type ProdutoResumo,
  type ResultadoAjusteProduto,
  type SaldosProduto,
  type TipoProduto,
  type TiposProdutoHabilitados,
  type VerificacaoEan,
} from '@genesis/shared';
import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, escaparLike, ordemDaQuery, ref } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { arquivoExportacao, garantirPodeExportar, type ColunaExportacao } from '../comum/exportacao.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import {
  lojas,
  marcas,
  produtos,
  produtosCategorias,
  produtosCodigosBarras,
  produtosComponentes,
  produtosComponentesAlternativas,
  produtosFornecedores,
  produtosLojas,
  produtosLotes,
  produtosPrecosQuantidade,
  produtosRelacionados,
  unidadesMedida,
} from '../database/empresa/schema/index.js';
import { ajustarEstoqueDefinir, resumoEfetivacao } from '../estoques/acertos.js';
import { estoqueVisivel } from '../estoques/permitidos.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { sqlPendenciasTransferencia, sqlSaldosComPendencias } from '../transferencias/em-transito.js';
import { buscarOpcoes, detalheProduto, fornecedoresDoProduto, lotesDoProduto } from './consultas.js';
import { ncmVigente } from './ncm.js';
import {
  conferirEanDuplicado,
  gravarFilhas,
  gravarFornecedores,
  gravarLotes,
  gravarRelacionados,
  registrarHistoricoPrecos,
  type RelacaoInversaCriada,
  tiposHabilitados,
  type VinculoFornecedorMovido,
  validarNoBanco,
  type ProdutoAntes,
} from './gravacao.js';

const LOCALIZACAO = 'Produtos › Cadastro de produtos';

const sqlEan = sql<
  string | null
>`(select cb.codigo from produtos_codigos_barras cb where cb.produto_id = ${ref('produtos')} and cb.variacao_id is null and cb.principal and cb.excluido_em is null limit 1)`;

const colunasOrdenacao = {
  codigo: produtos.codigo,
  nome: sql`lower(fn_unaccent(${produtos.nome}))`,
  codigo_interno: sql`lower(${produtos.codigoInterno})`,
  ean: sqlEan,
  marca: sql`lower(fn_unaccent(${marcas.descricao}))`,
  localizacao: sql`lower(${produtos.localizacao})`,
  preco_custo: produtos.precoCusto,
  preco_venda: produtos.precoVenda,
};

/** Filtros da listagem (ERP 8.1). `semSuporte`: tipos travados pelas chaves (F2-B1), para "Tipo sem suporte". */
function condicoes(q: FiltroProdutos, semSuporte: readonly TipoProduto[]): SQL | undefined {
  const nome = q.nome?.trim();
  return and(
    isNull(produtos.excluidoEm),
    q.situacao === 'ativos'
      ? eq(produtos.ativo, true)
      : q.situacao === 'inativos'
        ? eq(produtos.ativo, false)
        : undefined,
    nome ? sql`${produtos.busca} like lower(fn_unaccent(${`%${escaparLike(nome)}%`}))` : undefined,
    q.codigo ? eq(produtos.codigo, q.codigo) : undefined,
    q.codigoInterno
      ? sql`lower(${produtos.codigoInterno}) like lower(${`${escaparLike(q.codigoInterno)}%`})`
      : undefined,
    q.codigoBarras
      ? sql`exists (select 1 from produtos_codigos_barras cb where cb.produto_id = ${ref('produtos')} and cb.excluido_em is null and cb.codigo like ${`${escaparLike(q.codigoBarras)}%`})`
      : undefined,
    q.ncm ? sql`${produtos.ncm} like ${`${q.ncm}%`}` : undefined,
    q.marcaId ? eq(produtos.marcaId, q.marcaId) : undefined,
    q.categoriaId
      ? sql`exists (select 1 from produtos_categorias pc join categorias c on c.id = pc.categoria_id
                     join categorias alvo on alvo.id = ${q.categoriaId}
                    where pc.produto_id = ${ref('produtos')} and pc.excluido_em is null
                      and (c.caminho = alvo.caminho or c.caminho like alvo.caminho || '/%'))`
      : undefined,
    q.local === 'pdv'
      ? sql`${produtos.tipo} <> 'materia_prima' and not ${produtos.insumo}`
      : q.local === 'totem'
        ? eq(produtos.usaTotem, true)
        : q.local === 'menu_digital'
          ? eq(produtos.usaMenuDigital, true)
          : undefined,
    q.tipo ? eq(produtos.tipo, q.tipo) : undefined,
    q.situacaoCadastro === 'sem_preco' ? sql`${produtos.precoVenda} <= 0` : undefined,
    q.situacaoCadastro === 'sem_ncm'
      ? sql`(${produtos.ncm} is null or not ${ncmVigente(sql`${produtos.ncm}`)})`
      : undefined,
    q.situacaoCadastro === 'sem_codigo_barras'
      ? sql`not exists (select 1 from produtos_codigos_barras cb where cb.produto_id = ${ref('produtos')} and cb.excluido_em is null)`
      : undefined,
    q.situacaoCadastro === 'ean_duplicado'
      ? sql`exists (select 1 from produtos_codigos_barras cb
                     join produtos_codigos_barras x on x.codigo = cb.codigo and x.tipo = 'gtin' and x.excluido_em is null
                                                    and x.produto_id <> cb.produto_id
                     join produtos px on px.id = x.produto_id and px.excluido_em is null
                    where cb.produto_id = ${ref('produtos')} and cb.tipo = 'gtin' and cb.excluido_em is null)`
      : undefined,
    q.situacaoCadastro === 'tipo_sem_suporte'
      ? semSuporte.length
        ? inArray(produtos.tipo, [...semSuporte])
        : sql`false`
      : undefined,
  );
}

/** Tipos travados agora (o complemento de `tiposHabilitados`); só lê as chaves quando o filtro pede. */
async function tiposSemSuporte(db: DbEmpresa, q: FiltroProdutos): Promise<TipoProduto[]> {
  if (q.situacaoCadastro !== 'tipo_sem_suporte') return [];
  const habilitados = await tiposHabilitados(db);
  return TIPOS_PRODUTO.filter((t) => !habilitados.includes(t));
}

function consultaResumo(db: DbEmpresa) {
  return db
    .select({
      id: produtos.id,
      codigo: produtos.codigo,
      nome: produtos.nome,
      tipo: produtos.tipo,
      ativo: produtos.ativo,
      codigoInterno: produtos.codigoInterno,
      ean: sqlEan,
      marcaNome: marcas.descricao,
      localizacao: produtos.localizacao,
      unidadeSigla: unidadesMedida.sigla,
      precoCusto: produtos.precoCusto,
      precoVenda: produtos.precoVenda,
      versao: produtos.versao,
    })
    .from(produtos)
    .innerJoin(unidadesMedida, eq(unidadesMedida.id, produtos.unidadeId))
    .leftJoin(marcas, eq(marcas.id, produtos.marcaId))
    .$dynamic();
}

const verCusto = (s: SessaoErp) => s.permissoes.has('produtos.ver_custo');

/** Ordenar pelo custo revelaria a ordem dos custos: só com `produtos.ver_custo` (ERP 8.1). */
function garantirOrdemCusto(q: { ordenar?: string }, s: SessaoErp): void {
  if (q.ordenar?.startsWith('preco_custo:') && !verCusto(s)) {
    throw ErroApi.semPermissao('Ordenar pelo custo exige "Produtos: Ver custo".');
  }
}

const semCusto = <T extends { precoCusto: string | null }>(linhas: T[], s: SessaoErp): T[] =>
  verCusto(s) ? linhas : linhas.map((l) => ({ ...l, precoCusto: null }));

const colunasExportacao = (custo: boolean): ColunaExportacao<ProdutoResumo>[] => [
  { rotulo: 'Cód.', valor: (p) => p.codigo },
  { rotulo: 'Nome', valor: (p) => p.nome },
  { rotulo: 'Tipo', valor: (p) => ROTULOS_TIPO_PRODUTO[p.tipo] },
  { rotulo: 'Ref. interna', valor: (p) => p.codigoInterno },
  { rotulo: 'Cód. barras', valor: (p) => p.ean },
  { rotulo: 'Marca', valor: (p) => p.marcaNome },
  { rotulo: 'Unidade', valor: (p) => p.unidadeSigla },
  { rotulo: 'Localização', valor: (p) => p.localizacao },
  ...(custo ? [{ rotulo: 'Preço custo', valor: (p: ProdutoResumo) => Number(p.precoCusto) }] : []),
  { rotulo: 'Preço venda', valor: (p) => Number(p.precoVenda) },
  { rotulo: 'Ativo', valor: (p) => p.ativo },
];

/** Preços que alimentam o histórico (MD 3.6.10). */
const precosDe = (d: {
  precoVenda: string | null;
  precoCusto?: string | null;
  precoAtacado: string | null;
  precoPromocional: string | null;
  precoParcelado: string | null;
  precoMenuDigital: string | null;
  precoIfood: string | null;
}) => ({
  venda: d.precoVenda,
  ...(d.precoCusto !== undefined ? { custo: d.precoCusto } : {}),
  atacado: d.precoAtacado,
  promocional: d.precoPromocional,
  parcelado: d.precoParcelado,
  menu_digital: d.precoMenuDigital,
  ifood: d.precoIfood,
});

/** Produtos (ERP 8.1, 8.2): listagem, formulário com as filhas, saldos, verificação de EAN. */
@Controller('produtos')
export class ProdutosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('produtos.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<ProdutoResumo>> {
    const q = validar(filtroProdutosSchema, query);
    garantirOrdemCusto(q, sessao);
    const { limite, deslocamento } = limiteDeslocamento(q);
    return this.s.tenancy.cx().consulta(async (db) => {
      const onde = condicoes(q, await tiposSemSuporte(db, q));
      const itens = (await consultaResumo(db)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', produtos.codigo))
        .limit(limite)
        .offset(deslocamento)) as ProdutoResumo[];
      const [total] = await db.select({ n: count() }).from(produtos).where(onde);
      return { itens: semCusto(itens, sessao), total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('produtos.ver')
  @Get('exportar')
  async exportar(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<StreamableFile> {
    garantirPodeExportar(sessao, 'produtos');
    const q = validar(filtroProdutosSchema.extend(exportacaoQuerySchema.shape), query);
    garantirOrdemCusto(q, sessao);
    const linhas = await this.s.tenancy.cx().transacao(async (tx) => {
      const onde = condicoes(q, await tiposSemSuporte(tx, q));
      const [total] = await tx.select({ n: count() }).from(produtos).where(onde);
      if ((total?.n ?? 0) > LIMITE_EXPORTACAO) {
        throw new ErroApi(
          'REGRA_NEGOCIO',
          `A exportação passa de ${LIMITE_EXPORTACAO.toLocaleString('pt-BR')} linhas. Refine os filtros.`,
        );
      }
      const linhas = (await consultaResumo(tx)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', produtos.codigo))) as ProdutoResumo[];
      const { formato, pagina: _p, tamanho: _t, ...filtros } = q;
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'exportar',
        entidade: 'produtos',
        localizacao: LOCALIZACAO,
        descricao: `Exportação ${formato.toUpperCase()} com ${linhas.length} linha(s)`,
        depois: { formato, filtros, linhas: linhas.length },
      });
      return linhas;
    });
    return arquivoExportacao(q.formato, 'Produtos', colunasExportacao(verCusto(sessao)), linhas);
  }

  /** Busca resumida para os seletores (componente do combo, casco, membros do grupo de preço). */
  @Permissao('produtos.ver')
  @Get('busca')
  async busca(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<ProdutoOpcao[]> {
    const q = validar(buscaProdutosSchema, query);
    return this.s.tenancy.cx().consulta((db) => buscarOpcoes(db, q, verCusto(sessao)));
  }

  /** `GET /produtos/verificar-ean?codigo=&produtoId=` (ERP 8.2): DV e produtos que já têm o código. */
  @Permissao('produtos.ver')
  @Get('verificar-ean')
  async verificarEan(@Query() query: unknown): Promise<VerificacaoEan> {
    const q = validar(
      z.object({ codigo: z.string().trim().min(1).max(30), produtoId: z.uuid().optional() }),
      query,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<{ id: string; codigo: number; nome: string }>(sql`
        select distinct p.id, p.codigo, p.nome from produtos_codigos_barras cb
          join produtos p on p.id = cb.produto_id and p.excluido_em is null
         where cb.codigo = ${q.codigo} and cb.excluido_em is null and cb.produto_id is distinct from ${q.produtoId ?? null}::uuid
         order by p.codigo`);
      const modo =
        (await lerConfiguracao<string>(db, 'geral.ean_duplicado')) === 'avisar' ? 'avisar' : 'bloquear';
      return { codigo: q.codigo, valido: validarGtin(q.codigo), modo, duplicados: rows };
    });
  }

  /**
   * Tipos que o formulário oferece na criação (F2-B1; D43): "Com variações" e "Com complementos" só com a chave
   * ligada. Na edição o ERP mostra também o tipo gravado.
   */
  @Permissao('produtos.ver')
  @Get('tipos-habilitados')
  async tiposHabilitados(): Promise<TiposProdutoHabilitados> {
    return this.s.tenancy.cx().consulta(async (db) => ({
      tipos: await tiposHabilitados(db),
      // F2-B13: o bloco Fornecedores do formulário (ERP 8.2.14) sem exigir `configuracoes.ver` de quem cadastra.
      usaFornecedores: (await lerConfiguracao<boolean>(db, 'geral.produto_usa_fornecedores')) === true,
    }));
  }

  /** Código interno de balcão livre (prefixo 2, ERP 8.2.1 "Gerar código interno"). */
  @Permissao('produtos.ver')
  @Get('codigo-interno-livre')
  async codigoInternoLivre(): Promise<{ codigo: string }> {
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<{ n: string }>(
        sql`select coalesce(max(substr(codigo, 2, 11)::bigint), 0)::text as n from produtos_codigos_barras
             where codigo ~ '^2[0-9]{12}$' and tipo = 'interno'`,
      );
      return { codigo: gerarCodigoInterno(Number(rows[0]!.n) + 1) };
    });
  }

  /**
   * Lojas ativas (das permitidas) com "Usa Produto Preço Volume" desligado (`pdv.usa_preco_volume`, empresa ou
   * Personalizar da loja): as faixas por quantidade do produto e as do mix em modo grupo não valem no PDV delas.
   * O ERP avisa no bloco "Preço por quantidade", no grupo de preço e no Simular.
   */
  @Permissao('produtos.ver')
  @Get('preco-volume')
  async precoVolume(
    @Sessao() sessao: SessaoErp,
  ): Promise<{ lojasDesligadas: Array<{ id: string; nome: string }> }> {
    return this.s.tenancy.cx().consulta(async (db) => {
      const ativas = await db
        .select({ id: lojas.id, nome: lojas.nome })
        .from(lojas)
        .where(and(isNull(lojas.excluidoEm), eq(lojas.ativa, true)));
      const lojasDesligadas: Array<{ id: string; nome: string }> = [];
      for (const l of ativas.filter((x) => lojaPermitida(sessao, x.id))) {
        if ((await lerConfiguracao<boolean>(db, 'pdv.usa_preco_volume', l.id)) !== true)
          lojasDesligadas.push(l);
      }
      return { lojasDesligadas: lojasDesligadas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')) };
    });
  }

  @Permissao('produtos.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<ProdutoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy
      .cx()
      .consulta((db) => detalheProduto(db, id, verCusto(sessao), sessao.lojas, sessao.estoques));
    if (!d) throw ErroApi.naoEncontrado('Produto não encontrado.');
    return d;
  }

  /**
   * Saldo por estoque e tipo (ERP 8.2.11, somente leitura) ou, no combo, os combos montáveis por estoque das lojas
   * (8.2.17), calculados na consulta. Também o saldo de cada lote (`saldos_lote`, 8.2.12; F2-B17). Só os estoques
   * permitidos aparecem (decisão 149). Com o "Em trânsito" e a "Divergência a tratar" das transferências (F2-B26;
   * decisão 174).
   */
  @Permissao('produtos.ver')
  @Get(':id/saldos')
  async saldos(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<SaldosProduto> {
    const id = validar(z.uuid(), idBruto);
    const visivel = estoqueVisivel(sessao, sql`e.id`) ?? sql`true`;
    return this.s.tenancy.cx().consulta(async (db) => {
      const [p] = await db
        .select({ tipo: produtos.tipo })
        .from(produtos)
        .where(and(eq(produtos.id, id), isNull(produtos.excluidoEm)));
      if (!p) throw ErroApi.naoEncontrado('Produto não encontrado.');
      if (p.tipo === 'kit') {
        const { rows: est } = await db.execute<{ id: string; nome: string }>(sql`
          select distinct e.id, e.nome from estoques e join lojas l on l.estoque_id = e.id
           where l.excluido_em is null and l.ativa and e.excluido_em is null and ${visivel}
           order by e.nome`);
        const { rows: pos } = await db.execute<Record<string, unknown>>(sql`
          select pc.id, coalesce(pc.rotulo_posicao, c.nome) as nome, c.nome as componente, pc.quantidade::text as q,
                 c.controla_estoque, pc.componente_id, pc.componente_variacao_id
            from produtos_componentes pc join produtos c on c.id = pc.componente_id
           where pc.produto_id = ${id} and pc.tipo = 'kit' and pc.excluido_em is null`);
        const { rows: saldos } = await db.execute<Record<string, unknown>>(sql`
          select s.estoque_id, s.produto_id, s.variacao_id, sum(s.quantidade)::text as q
            from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id and t.vendavel
           where s.produto_id in (select componente_id from produtos_componentes
                                   where produto_id = ${id} and tipo = 'kit' and excluido_em is null)
           group by s.estoque_id, s.produto_id, s.variacao_id`);
        return {
          combo: true,
          saldos: [],
          lotes: [],
          montaveis: est.map((e) => ({
            estoqueId: e.id,
            estoqueNome: e.nome,
            ...combosMontaveis(
              pos.map((c) => ({
                nome: c.componente as string,
                // Duas posições com o mesmo padrão somam a quantidade (ERP 8.2.17, MD 3.6.7).
                chave: `${c.componente_id as string}:${(c.componente_variacao_id as string | null) ?? ''}`,
                quantidade: c.q as string,
                controlaEstoque: c.controla_estoque as boolean,
                saldo: saldos
                  .filter(
                    (s) =>
                      s.estoque_id === e.id &&
                      s.produto_id === c.componente_id &&
                      (c.componente_variacao_id === null || s.variacao_id === c.componente_variacao_id),
                  )
                  .reduce((t, s) => t.plus(s.q as string), dec(0))
                  .toFixed(),
              })),
            ),
          })),
        };
      }
      // F2-B26 (decisão 174): o "Em trânsito" (no destino) e a "Divergência a tratar" (na origem) de cada estoque ×
      // tipo, somadas as variações como o saldo; a linha aparece também sem saldo lançado (`sqlSaldosComPendencias`).
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        with pd as (${sqlPendenciasTransferencia({ produtoIds: [id] })}),
             pdt as (select estoque_id, tipo_estoque_id, sum(em_transito) as em_transito,
                            sum(divergencia) as divergencia
                       from pd group by estoque_id, tipo_estoque_id)
        select s.estoque_id, e.nome as estoque_nome, s.tipo_estoque_id, t.nome as tipo_nome, t.vendavel,
               sum(s.quantidade)::text as quantidade,
               case when sum(s.quantidade) > 0 then round(sum(s.custo_medio * greatest(s.quantidade, 0)) / nullif(sum(greatest(s.quantidade, 0)), 0), 4)::text end as custo_medio,
               max(s.ultima_entrada_em) as ultima_entrada_em, max(s.ultima_saida_em) as ultima_saida_em,
               coalesce(max(pdt.em_transito), 0)::numeric(15,3)::text as em_transito,
               coalesce(max(pdt.divergencia), 0)::numeric(15,3)::text as divergencia
          from (${sqlSaldosComPendencias({ produtoIds: [id] })}) s
          join estoques e on e.id = s.estoque_id
          join tipos_estoque t on t.id = s.tipo_estoque_id
          left join pdt on pdt.estoque_id = s.estoque_id and pdt.tipo_estoque_id = s.tipo_estoque_id
         where s.produto_id = ${id} and ${visivel}
         group by s.estoque_id, e.nome, s.tipo_estoque_id, t.nome, t.vendavel
         order by e.nome, t.nome`);
      // Saldo por lote (8.2.12; F2-B17): o `saldos_lote` do razão, o mesmo que desce ao PDV.
      const { rows: lotes } = await db.execute<Record<string, unknown>>(sql`
        select s.lote_id, s.estoque_id, e.nome as estoque_nome, s.tipo_estoque_id, t.nome as tipo_nome, t.vendavel,
               s.quantidade::text as quantidade
          from saldos_lote s
          join estoques e on e.id = s.estoque_id
          join tipos_estoque t on t.id = s.tipo_estoque_id
         where s.produto_id = ${id} and s.variacao_id is null and s.quantidade <> 0 and ${visivel}
         order by e.nome, t.nome`);
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      return {
        combo: false,
        montaveis: [],
        lotes: lotes.map((l) => ({
          loteId: l.lote_id as string,
          estoqueId: l.estoque_id as string,
          estoqueNome: l.estoque_nome as string,
          tipoEstoqueId: l.tipo_estoque_id as string,
          tipoEstoqueNome: l.tipo_nome as string,
          vendavel: l.vendavel as boolean,
          quantidade: l.quantidade as string,
        })),
        saldos: rows.map((r) => ({
          estoqueId: r.estoque_id as string,
          estoqueNome: r.estoque_nome as string,
          tipoEstoqueId: r.tipo_estoque_id as string,
          tipoEstoqueNome: r.tipo_nome as string,
          vendavel: r.vendavel as boolean,
          quantidade: r.quantidade as string,
          emTransito: r.em_transito as string,
          divergenciaATratar: r.divergencia as string,
          custoMedio: verCusto(sessao) ? ((r.custo_medio as string | null) ?? '0') : null,
          ultimaEntradaEm: iso(r.ultima_entrada_em),
          ultimaSaidaEm: iso(r.ultima_saida_em),
        })),
      };
    });
  }

  /**
   * "Ajustar" do bloco Estoque (ERP 8.2.11; F2-B12; README da API › decisão 157): um "Definir" de um item, criado e
   * efetivado na hora, com a origem `cadastro_produto` (AJUSTE_CADASTRO). Exige `estoque_acertos.criar` (a mesma do
   * acerto da tela) e o estoque permitido para movimentar; a auditoria fica no acerto (criar + efetivar), com a
   * localização do cadastro de produtos.
   */
  @Permissao('estoque_acertos.criar')
  @Post(':id/ajustar-estoque')
  @HttpCode(200)
  async ajustarEstoque(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoAjusteProduto> {
    const id = validar(z.uuid(), idBruto);
    const dados = validar(ajusteEstoqueProdutoSchema, corpo);
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const { resultado, lojaId } = await ajustarEstoqueDefinir(tx, sessao, id, dados);
        const origem = origemDaRequisicao(req);
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'criar',
          entidade: 'acertos_estoque',
          registroId: resultado.acertoId,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Ajuste de estoque pelo cadastro do produto (acerto Nº ${resultado.codigo})`,
          depois: { produtoId: id, ...dados },
        });
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'efetivar',
          entidade: 'acertos_estoque',
          registroId: resultado.acertoId,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Acerto efetivado: ${resumoEfetivacao({ ...resultado, itens: 1 })}`,
        });
        return resultado;
      },
      { travaVersao: true },
    );
  }

  @Permissao('produtos.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ProdutoDetalhe> {
    const dados = validar(criarProdutoSchema, corpo);
    garantirLojas(sessao, dados);
    const id = await this.s.tenancy
      .cx()
      .transacao((tx) => inserirProduto(this.s, tx, sessao, origemDaRequisicao(req), dados), {
        travaVersao: true,
      });
    return (await this.s.tenancy
      .cx()
      .consulta((db) => detalheProduto(db, id, verCusto(sessao), sessao.lojas, sessao.estoques)))!;
  }

  @Permissao('produtos.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ProdutoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarProdutoSchema, corpo);
    garantirLojas(sessao, dados);
    await this.s.tenancy
      .cx()
      .transacao((tx) => atualizarProduto(this.s, tx, sessao, origemDaRequisicao(req), id, versao, dados), {
        travaVersao: true,
      });
    return (await this.s.tenancy
      .cx()
      .consulta((db) => detalheProduto(db, id, verCusto(sessao), sessao.lojas, sessao.estoques)))!;
  }

  /**
   * ERP 8.2 "Exclusão": bloqueada com saldo ≠ 0 em algum estoque ou se o produto é componente (padrão ou
   * alternativa ativa) de combo ou insumo de ficha técnica. A exclusão é lógica (o PDV recebe o tombstone).
   */
  @Permissao('produtos.excluir')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [linha] = await tx
          .select()
          .from(produtos)
          .where(and(eq(produtos.id, id), isNull(produtos.excluidoEm)))
          .for('update');
        if (!linha) throw ErroApi.naoEncontrado('Produto não encontrado.');
        if (await saldoNaoZero(tx, id)) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O produto tem saldo em estoque: zere o saldo ou inative o produto.',
          );
        }
        const antes = (await detalheProduto(tx, id, true))!;
        if (antes.usadoEm.length) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            `O produto é componente de ${antes.usadoEm.map((u) => `${u.codigo} - ${u.nome}`).join(', ')}. Retire-o da composição ou inative o produto.`,
          );
        }
        const agora = new Date();
        const autor = { excluidoEm: agora, atualizadoPorId: sessao.usuarioId };
        const comps = await tx
          .select({ id: produtosComponentes.id })
          .from(produtosComponentes)
          .where(and(eq(produtosComponentes.produtoId, id), isNull(produtosComponentes.excluidoEm)));
        if (comps.length) {
          await tx
            .update(produtosComponentesAlternativas)
            .set(autor)
            .where(
              and(
                inArray(
                  produtosComponentesAlternativas.componenteId,
                  comps.map((c) => c.id),
                ),
                isNull(produtosComponentesAlternativas.excluidoEm),
              ),
            );
        }
        for (const t of [
          produtosComponentes,
          produtosCodigosBarras,
          produtosLojas,
          produtosPrecosQuantidade,
          produtosCategorias,
          produtosRelacionados,
          // F2-B13: o (fornecedor, código) do produto excluído fica livre para outro produto.
          produtosFornecedores,
          // F2-B17: o produto só se exclui sem saldo; os lotes saem com ele (o razão continua apontando para eles).
          produtosLotes,
        ]) {
          await tx
            .update(t)
            .set(autor)
            .where(and(eq(t.produtoId, id), isNull(t.excluidoEm)));
        }
        // As relações de outros produtos para este também saem: o PDV não sugere um produto excluído.
        await tx
          .update(produtosRelacionados)
          .set(autor)
          .where(and(eq(produtosRelacionados.relacionadoId, id), isNull(produtosRelacionados.excluidoEm)));
        await tx.update(produtos).set(autor).where(eq(produtos.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'produtos',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }
}

/** "Com variações" saindo do tipo (F2-B1): variação ativa trava a troca; movimento de variação, a troca com movimento. */
async function situacaoVariacoes(
  tx: DbEmpresa,
  id: string,
): Promise<{ variacoesAtivas: boolean; movimentoComVariacao: boolean }> {
  const { rows } = await tx.execute<{ ativas: boolean; movimento: boolean }>(sql`
    select exists (select 1 from produtos_variacoes v where v.produto_id = ${id} and v.ativo and v.excluido_em is null) as ativas,
           exists (select 1 from movimentos_estoque m where m.produto_id = ${id} and m.variacao_id is not null) as movimento`);
  return { variacoesAtivas: rows[0]!.ativas, movimentoComVariacao: rows[0]!.movimento };
}

async function saldoNaoZero(tx: DbEmpresa, id: string): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`select 1 from saldos_estoque where produto_id = ${id} and quantidade <> 0 limit 1`,
  );
  return rows.length > 0;
}

/** Colunas de `produtos` vindas do formulário (sem custo: o custo só entra com `produtos.ver_custo`). */
function colunasProduto(d: CriarProduto) {
  const {
    codigosBarras: _cb,
    lojas: _l,
    precosQuantidade: _pq,
    componentes: _c,
    categorias: _cat,
    categoriaPrincipalId: _cp,
    relacionados: _rel,
    fornecedores: _forn,
    lotes: _lotes,
    lotesExcluidos: _lotesExcluidos,
    confirmarEanDuplicado: _conf,
    precoCusto: _custo,
    markupPct: _markup,
    promocaoInicio,
    promocaoFim,
    ...resto
  } = d;
  return {
    ...resto,
    promocaoInicio: promocaoInicio ? new Date(promocaoInicio) : null,
    promocaoFim: promocaoFim ? new Date(promocaoFim) : null,
  };
}

/** Texto de busca (MD 3.6.3 `busca`): nome + código + código interno + códigos de barras, sem acento. */
function textoBusca(d: CriarProduto, codigo: number | null) {
  const texto = [d.nome, codigo, d.codigoInterno, ...d.codigosBarras.map((c) => c.codigo)]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ');
  return sql`lower(fn_unaccent(${texto}))`;
}

/**
 * Filhas no `depois` da auditoria do produto. Os fornecedores são relidos do banco (F2-B13), no formato do `antes`
 * (`detalheProduto` com custo): sem `produtos.ver_custo` o custo do corpo é ignorado, e o corpo nunca traz o último
 * custo nem a última compra; copiar o corpo registraria mudanças que não aconteceram. Os lotes também (F2-B17): o corpo
 * traz só os lotes novos e os alterados, e o `antes` traz todos.
 */
const filhasAuditoria = async (tx: DbEmpresa, produtoId: string, d: CriarProduto) => ({
  codigosBarras: d.codigosBarras,
  lojas: d.lojas,
  precosQuantidade: d.precosQuantidade,
  componentes: d.componentes,
  categorias: d.categorias,
  ...(d.relacionados !== undefined ? { relacionados: d.relacionados } : {}),
  fornecedores: await fornecedoresDoProduto(tx, produtoId, true),
  lotes: await lotesDoProduto(tx, produtoId),
});

/**
 * Auditoria do vínculo de fornecedor tirado de **outro** produto pelo "mover vínculo" (F2-B13): quem abre o histórico
 * dele vê para onde o código foi. Uma linha por produto de origem, com `antes`/`depois` dos vínculos vivos dele (o
 * `antes` traz de volta os que acabaram de sair), como a relação inversa do F2-B12.
 */
async function auditarVinculosMovidos(
  s: DepsGravacao,
  tx: DbEmpresa,
  origem: OrigemAcao,
  produtoId: string,
  movidos: readonly VinculoFornecedorMovido[],
): Promise<void> {
  if (!movidos.length) return;
  const { rows: p } = await tx.execute<{ codigo: number; nome: string }>(
    sql`select codigo, nome from produtos where id = ${produtoId}`,
  );
  const porProduto = new Map<string, VinculoFornecedorMovido[]>();
  for (const m of movidos) porProduto.set(m.produtoId, [...(porProduto.get(m.produtoId) ?? []), m]);
  for (const [outro, deste] of porProduto) {
    const codigos = deste.map((m) => `"${m.codigoFornecedor}"`).join(', ');
    const vinculo =
      deste.length === 1
        ? `Vínculo do fornecedor (código ${codigos}) movido`
        : `Vínculos de fornecedor (códigos ${codigos}) movidos`;
    await s.auditoria.registrar(tx, origem, {
      acao: 'editar',
      entidade: 'produtos',
      registroId: outro,
      localizacao: LOCALIZACAO,
      descricao: `${vinculo} para o produto ${p[0]!.codigo} - ${p[0]!.nome}`,
      antes: {
        fornecedores: await fornecedoresDoProduto(
          tx,
          outro,
          true,
          deste.map((m) => m.id),
        ),
      },
      depois: { fornecedores: await fornecedoresDoProduto(tx, outro, true) },
    });
  }
}

/**
 * Auditoria da relação inversa no **outro** produto (F2-B12): quem abre o histórico dele vê de onde a relação veio.
 * `antes`/`depois` com as relações vivas dele, lidas depois da gravação (o `antes` tira a que acabou de entrar).
 */
async function auditarInversas(
  s: DepsGravacao,
  tx: DbEmpresa,
  origem: OrigemAcao,
  produtoId: string,
  inversas: readonly RelacaoInversaCriada[],
): Promise<void> {
  if (!inversas.length) return;
  const { rows: p } = await tx.execute<{ codigo: number; nome: string }>(
    sql`select codigo, nome from produtos where id = ${produtoId}`,
  );
  for (const inv of inversas) {
    const { rows } = await tx.execute<{ relacionado_id: string; tipo: string; ordem: number }>(sql`
      select relacionado_id, tipo, ordem from produtos_relacionados
       where produto_id = ${inv.produtoId} and excluido_em is null order by ordem, criado_em`);
    const depois = rows.map((r) => ({ relacionadoId: r.relacionado_id, tipo: r.tipo, ordem: r.ordem }));
    await s.auditoria.registrar(tx, origem, {
      acao: 'editar',
      entidade: 'produtos',
      registroId: inv.produtoId,
      localizacao: LOCALIZACAO,
      descricao: `Relação inversa (${inv.tipo}) criada pelo cadastro do produto ${p[0]!.codigo} - ${p[0]!.nome}`,
      antes: {
        relacionados: depois.filter(
          (r) => !(r.relacionadoId === inv.relacionadoId.toLowerCase() && r.tipo === inv.tipo),
        ),
      },
      depois: { relacionados: depois },
    });
  }
}

/** Lojas fora das permitidas não podem ser gravadas por este usuário (as linhas existentes delas ficam). */
/**
 * Lojas fora das permitidas não podem ser enviadas (403): o detalhe não as mostra ao restrito (decisão 88) e a
 * gravação preserva as linhas delas. Linhas sem loja (`loja_id` nulo) seguem a decisão 87.
 */
function garantirLojas(sessao: SessaoErp, d: CriarProduto): void {
  if (sessao.lojas === null) return;
  const fora = [
    ...d.lojas.map((l) => l.lojaId),
    ...d.precosQuantidade.map((f) => f.lojaId).filter((l): l is string => l !== null),
  ].filter((l) => !sessao.lojas!.includes(l));
  if (fora.length) throw ErroApi.semPermissao('Há loja fora das suas lojas permitidas.');
}

/**
 * "Criar relação inversa" (ERP 8.2.8; F2-B12) grava uma linha no cadastro de OUTRO produto (desce ao PDV, sobe a versão
 * dele, entra no histórico dele): exige `produtos.editar`, como o PUT dele. Sem isso, quem só tem `produtos.criar`
 * alteraria pelo POST um produto que não pode editar.
 */
function garantirCriarInversa(sessao: SessaoErp, d: CriarProduto): void {
  if (sessao.permissoes.has('produtos.editar')) return;
  const mensagem = 'Criar a relação inversa altera o outro produto e exige "Produtos: Editar".';
  const campos: Record<string, string[]> = {};
  d.relacionados?.forEach((r, i) => {
    if (r.criarInversa) campos[`relacionados.${i}.criarInversa`] = [mensagem];
  });
  if (Object.keys(campos).length) throw new ErroApi('SEM_PERMISSAO', mensagem, { campos });
}

/**
 * Configurações › Geral › "Altera Preço do Produto no ERP" = Não (`geral.altera_preco_produto_erp`): mudar preço
 * exige `produtos.alterar_preco` (ERP 8.2.1).
 */
async function garantirAlterarPreco(
  tx: DbEmpresa,
  sessao: SessaoErp,
  antes: ProdutoDetalhe,
  d: CriarProduto,
): Promise<void> {
  if (sessao.permissoes.has('produtos.alterar_preco')) return;
  if ((await lerConfiguracao<boolean>(tx, 'geral.altera_preco_produto_erp')) !== false) return;
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const a = precosDe({ ...antes, precoCusto: undefined });
  const b = precosDe({ ...d, precoCusto: undefined });
  const mudouProduto = (Object.keys(b) as (keyof typeof b)[]).some((k) => n(a[k]) !== n(b[k]));
  const lojasAntes = new Map(antes.lojas.map((l) => [l.lojaId, n(l.precoVenda)]));
  const mudouLoja = d.lojas.some((l) => (lojasAntes.get(l.lojaId) ?? null) !== n(l.precoVenda));
  const chaveFaixa = (f: {
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }) => `${f.lojaId}:${n(f.quantidadeInicial)}:${n(f.quantidadeFinal)}:${n(f.preco)}`;
  // Só as faixas que o usuário vê entram na comparação (as de outras lojas não vêm e são preservadas).
  const faixaVisivel = (f: { lojaId: string | null }) =>
    f.lojaId === null || sessao.lojas === null || sessao.lojas.includes(f.lojaId);
  const mudouFaixa =
    antes.precosQuantidade.filter(faixaVisivel).map(chaveFaixa).sort().join('|') !==
    d.precosQuantidade.map(chaveFaixa).sort().join('|');
  if (mudouProduto || mudouLoja || mudouFaixa) {
    throw ErroApi.semPermissao('Alterar preço no ERP exige "Produtos: Alterar preço".');
  }
}

/**
 * Próximo código da sequência `seq_codigo_produtos` que ainda não está em uso: a importação grava produtos com o
 * IdProduto do Nuvem3 (código explícito, decisão 102) e a sequência não é mexida (`setval`) na importação; quando ela
 * alcança um código já usado, salta **de uma vez** para o fim da faixa ocupada (códigos 1..15000 importados não custam
 * 15000 `nextval`) — nunca para trás (`greatest` com o valor atual: outra transação pode já ter avançado).
 */
export async function proximoCodigoProduto(tx: DbEmpresa): Promise<number> {
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const { rows } = await tx.execute<{ n: number; usado: boolean }>(sql`
      select s.n, exists (select 1 from produtos p where p.codigo = s.n) as usado
        from (select nextval('seq_codigo_produtos')::int as n) s`);
    if (!rows[0]!.usado) return rows[0]!.n;
    // Último código da faixa contígua ocupada a partir de n: o próximo `nextval` cai no primeiro livre.
    await tx.execute(sql`
      select setval('seq_codigo_produtos', greatest(
        (select min(p.codigo) from produtos p
          where p.codigo >= ${rows[0]!.n}
            and case when p.codigo < 2147483647
                     then not exists (select 1 from produtos q where q.codigo = p.codigo + 1) else true end),
        (select last_value from seq_codigo_produtos)))`);
  }
  throw new ErroApi('REGRA_NEGOCIO', 'Não há código de produto livre na sequência.');
}

/** Opções da gravação vinda de fora do formulário (importação de planilha, ERP 8.6). */
export interface OpcoesGravacaoProduto {
  /**
   * Importação/migração do Nuvem3: EAN duplicado é gravado e entra no relatório (MD 3.6.5,
   * `genesis.ean_duplicado_importacao`), sem a confirmação do formulário; produto sem NCM também (relatório "NCM
   * inválido"; a emissão fiscal recusa o item até o cadastro ser corrigido).
   */
  importacao?: boolean;
  /**
   * Código (Id Produto) explícito na criação: a importação preserva o IdProduto do Nuvem3, que os operadores
   * conhecem. Sem ele vale a sequência (`proximoCodigoProduto`, que pula os códigos já usados).
   */
  codigo?: number;
}

type DepsGravacao = Pick<Servicos, 'auditoria' | 'custoCombos'>;

/** A origem do histórico de preços (F2-B15): a importação de planilha grava `importacao`; o formulário, `cadastro`. */
const origemHistorico = (opcoes: OpcoesGravacaoProduto) => (opcoes.importacao ? 'importacao' : 'cadastro');

/** Insere o produto com as filhas, o custo do combo, o histórico de preços e a auditoria (transação de quem chama). */
export async function inserirProduto(
  s: DepsGravacao,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  dados: CriarProduto,
  opcoes: OpcoesGravacaoProduto = {},
): Promise<string> {
  garantirCriarInversa(sessao, dados);
  await validarNoBanco(tx, dados, null, null, { ncmOpcional: opcoes.importacao });
  if (opcoes.importacao) await tx.execute(sql`set local genesis.ean_duplicado_importacao = 'on'`);
  else await conferirEanDuplicado(tx, dados, null);
  const custo = verCusto(sessao) && dados.tipo !== 'kit';
  const principal = dados.categoriaPrincipalId ?? dados.categorias[0] ?? null;
  const codigo = opcoes.codigo ?? (await proximoCodigoProduto(tx));
  const [p] = await tx
    .insert(produtos)
    .values({
      ...colunasProduto(dados),
      codigo,
      ...(custo ? { precoCusto: dados.precoCusto, markupPct: dados.markupPct } : {}),
      categoriaPrincipalId: principal,
      busca: textoBusca(dados, codigo),
      criadoPorId: sessao.usuarioId,
      atualizadoPorId: sessao.usuarioId,
    })
    .returning();
  await gravarFilhas(tx, sessao, p!.id, dados, principal);
  const inversas = await gravarRelacionados(tx, sessao, p!.id, dados.relacionados);
  const movidos = await gravarFornecedores(tx, sessao, p!.id, dados.fornecedores, verCusto(sessao));
  await gravarLotes(tx, sessao, p!.id, dados.lotes, dados.lotesExcluidos);
  if (dados.tipo === 'kit') await s.custoCombos.recalcular(tx, [p!.id]);
  await registrarHistoricoPrecos(
    tx,
    sessao,
    p!.id,
    null,
    {
      produto: precosDe({ ...dados, ...(custo ? {} : { precoCusto: undefined }) }),
      lojas: Object.fromEntries(dados.lojas.map((l) => [l.lojaId, l.precoVenda])),
    },
    origemHistorico(opcoes),
  );
  await s.auditoria.registrar(tx, origem, {
    acao: 'criar',
    entidade: 'produtos',
    registroId: p!.id,
    localizacao: LOCALIZACAO,
    depois: { ...p, ...(await filhasAuditoria(tx, p!.id, dados)) },
  });
  await auditarInversas(s, tx, origem, p!.id, inversas);
  await auditarVinculosMovidos(s, tx, origem, p!.id, movidos);
  return p!.id;
}

/**
 * Altera o produto (formulário ou importação) com as mesmas regras: versão (quando informada), troca de tipo, preço
 * com "Altera Preço do Produto no ERP", EAN duplicado, filhas, custo do combo, histórico e auditoria.
 */
export async function atualizarProduto(
  s: DepsGravacao,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  id: string,
  versao: number | null,
  dados: CriarProduto,
  opcoes: OpcoesGravacaoProduto = {},
): Promise<void> {
  const [linha] = await tx
    .select()
    .from(produtos)
    .where(and(eq(produtos.id, id), isNull(produtos.excluidoEm)))
    .for('update');
  if (!linha) throw ErroApi.naoEncontrado('Produto não encontrado.');
  const antes = (await detalheProduto(tx, id, true))!;
  if (versao !== null && antes.versao !== versao)
    await conflitoVersao(tx, { ...linha, versao: antes.versao });
  const contexto: ProdutoAntes = {
    tipo: linha.tipo as TipoProduto,
    temMovimento: antes.temMovimento,
    saldoNaoZero: await saldoNaoZero(tx, id),
    ...(linha.tipo === 'com_variacoes' && dados.tipo !== 'com_variacoes'
      ? await situacaoVariacoes(tx, id)
      : {}),
  };
  await garantirAlterarPreco(tx, sessao, antes, dados);
  garantirCriarInversa(sessao, dados);
  await validarNoBanco(tx, dados, id, contexto, { ncmOpcional: opcoes.importacao });
  if (opcoes.importacao) await tx.execute(sql`set local genesis.ean_duplicado_importacao = 'on'`);
  else await conferirEanDuplicado(tx, dados, id);
  const custo = verCusto(sessao) && dados.tipo !== 'kit';
  const principal = dados.categoriaPrincipalId ?? dados.categorias[0] ?? null;
  const [depois] = await tx
    .update(produtos)
    .set({
      ...colunasProduto(dados),
      ...(custo ? { precoCusto: dados.precoCusto, markupPct: dados.markupPct } : {}),
      categoriaPrincipalId: principal,
      busca: textoBusca(dados, linha.codigo),
      atualizadoPorId: sessao.usuarioId,
    })
    .where(eq(produtos.id, id))
    .returning();
  await gravarFilhas(tx, sessao, id, dados, principal);
  const inversas = await gravarRelacionados(tx, sessao, id, dados.relacionados);
  const movidos = await gravarFornecedores(tx, sessao, id, dados.fornecedores, verCusto(sessao));
  await gravarLotes(tx, sessao, id, dados.lotes, dados.lotesExcluidos);
  if (dados.tipo === 'kit') await s.custoCombos.recalcular(tx, [id]);
  await registrarHistoricoPrecos(
    tx,
    sessao,
    id,
    {
      produto: precosDe({ ...antes, ...(custo ? {} : { precoCusto: undefined }) }),
      lojas: Object.fromEntries(antes.lojas.map((l) => [l.lojaId, l.precoVenda])),
    },
    {
      produto: precosDe({ ...dados, ...(custo ? {} : { precoCusto: undefined }) }),
      lojas: Object.fromEntries([
        ...antes.lojas.map((l) => [l.lojaId, l.precoVenda] as const),
        ...dados.lojas.map((l) => [l.lojaId, l.precoVenda] as const),
      ]),
    },
    origemHistorico(opcoes),
  );
  await s.auditoria.registrar(tx, origem, {
    acao: 'editar',
    entidade: 'produtos',
    registroId: id,
    localizacao: LOCALIZACAO,
    antes,
    depois: { ...depois, ...(await filhasAuditoria(tx, id, dados)) },
  });
  await auditarInversas(s, tx, origem, id, inversas);
  await auditarVinculosMovidos(s, tx, origem, id, movidos);
}

/**
 * Entrada do formulário a partir do detalhe gravado (com custo): base da atualização parcial da importação, que
 * troca só as colunas presentes na planilha e mantém o resto (filhas inclusive).
 */
export function entradaDoDetalhe(d: ProdutoDetalhe): CriarProdutoEntrada {
  const {
    codigo: _codigo,
    custoMedio: _cm,
    ean: _ean,
    unidadeSigla: _un,
    grupoPreco: _gp,
    vasilhame: _vas,
    usadoEm: _uso,
    relacionados: _rel,
    fornecedores: _forn,
    lotes: _lotes,
    avisos: _av,
    temMovimento: _tm,
    id: _id,
    versao: _v,
    criadoEm: _ce,
    atualizadoEm: _ae,
    atualizadoPorNome: _apn,
    ...resto
  } = d as ProdutoDetalhe & Record<string, unknown>;
  return {
    ...(resto as unknown as CriarProdutoEntrada),
    precoCusto: d.precoCusto ?? '0',
    markupPct: d.markupPct ?? '0',
    codigosBarras: d.codigosBarras.map((c) => ({
      id: c.id,
      codigo: c.codigo,
      tipo: c.tipo,
      principal: c.principal,
      descricao: c.descricao,
      unidadeId: c.unidadeId,
      fator: c.fator,
      preco: c.preco,
      usaVenda: c.usaVenda,
      usaCompra: c.usaCompra,
    })),
    precosQuantidade: d.precosQuantidade.map((f) => ({ ...f })),
    componentes: d.componentes.map((c) => ({
      id: c.id,
      tipo: c.tipo,
      componenteId: c.componenteId,
      componenteVariacaoId: c.componenteVariacaoId,
      quantidade: c.quantidade,
      perdaPct: c.perdaPct,
      rotuloPosicao: c.rotuloPosicao,
      permiteSubstituicao: c.permiteSubstituicao,
      ordem: c.ordem,
      alternativas: c.alternativas.map((a) => ({
        id: a.id,
        produtoId: a.produtoId,
        variacaoId: a.variacaoId,
        acrescimo: a.acrescimo,
        ordem: a.ordem,
        ativo: a.ativo,
      })),
    })),
  };
}
