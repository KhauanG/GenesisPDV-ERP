/**
 * **Exportação do catálogo de ida e volta** (Fase 2, F2-B40; ERP 8.5; README da API › decisão 186): a planilha de
 * produtos (e a de clientes, no mesmo mecanismo) no **layout da importação** — os cabeçalhos são os rótulos de
 * `COLUNAS_IMPORTACAO_*`, e cada valor sai como a importação o lê e o compara com o cadastro (decisão 103) —, para
 * exportar, editar no Excel e reimportar: sem mudança, todas as linhas ficam "Sem alteração" e nada é gravado;
 * editada, só as células mudadas viram "Atualizar".
 *
 * São provedores da exportação comum do F2-B29 (`ExportacaoRelatorios`): a consulta lida por cursor num instantâneo,
 * na hora até 5.000 linhas (`LIMITE_EXPORTACAO_CATALOGO`) e em tarefa acima disso (o link no ícone Tarefas), com a
 * auditoria `exportar`. O acesso é o do cadastro: `produtos.exportar` (ou `relatorios.exportar`, ERP 3.1) e
 * `produtos.ver`; clientes, o mesmo com `pessoas`. O custo e o markup saem só com `produtos.ver_custo`
 * (`custo: true`); o preço da loja e o estoque mínimo, só da loja permitida; o estoque atual, só de estoque permitido
 * para ver (a loja permitida não basta, decisão 149).
 *
 * Regras da ida e volta (as da análise em `importacao/produtos.ts`):
 * - `ean` é o código de barras principal do produto (sem as variações); os demais ficam no cadastro (a importação só
 *   acrescenta o da planilha que falta);
 * - `categoria` é a lista dos caminhos (`CERVEJA > LATA`), a principal primeiro, separada por vírgula sem espaço (a
 *   regra do Nuvem3, `lerListaCategorias`); só as categorias não excluídas;
 * - `estoque_atual` é o saldo do tipo de estoque padrão, sem variação, no estoque escolhido (o mesmo que a importação
 *   compara e o "Definir" muda); sem saldo gravado, 0; vazio no produto sem saldo próprio (combo, serviço, produzido,
 *   com variações ou sem controle de estoque), que a importação ignora;
 * - os códigos fiscais saem como texto (o zero à esquerda fica), os preços e as quantidades como número;
 * - a balança pelo texto do mapeamento provisório do Nuvem3 (`formatarBalancaPlanilha`, F2-Q14), lido de volta;
 * - sem a coluna `composicao`: a posição do combo existente não muda pela planilha (decisão 95), e o código do
 *   componente não identifica o produto sem ambiguidade em toda base.
 */
import {
  dec,
  EXPORTACAO_CATALOGO_CLIENTES,
  EXPORTACAO_CATALOGO_PRODUTOS,
  filtrosExportacaoClientesSchema,
  filtrosExportacaoProdutosSchema,
  formatarBalancaPlanilha,
  formatarCpfCnpj,
  LIMITE_EXPORTACAO_CATALOGO,
  ROTULOS_CATEGORIA_PESSOA,
  ROTULOS_TIPO_PRODUTO,
  rotuloColunaImportacao,
  type CategoriaPessoa,
  type FiltrosExportacaoClientes,
  type FiltrosExportacaoProdutos,
  type TipoImportacao,
  type TipoProduto,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { garantirPodeExportar, type ColunaExportacao, type ValorExportado } from '../comum/exportacao.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import type { ProvedorRelatorio } from '../tarefas/exportar-relatorio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { ncmVigente } from './ncm.js';

/** Localização da auditoria `exportar` (a tela Produtos › Exportação tem os dois botões). */
export const LOCALIZACAO_EXPORTACAO_CATALOGO = 'Produtos › Exportação';

/** Tipos sem saldo próprio: o acerto não os lança (`TIPOS_SEM_ESTOQUE`) e o saldo do "Com variações" é por variação. */
const TIPOS_SEM_SALDO_PROPRIO = ['kit', 'servico', 'produzido', 'com_variacoes'] as const;

/**
 * Os filtros preparados (`preparar`, no pedido e de novo na tarefa): a loja e o estoque já conferidos com o acesso da
 * sessão de agora. `loja` = a loja das colunas de loja; `estoque` = o estoque do `estoque_atual` (`null` = sem a
 * coluna: "Todas", ou o estoque da loja fora dos permitidos).
 */
export type FiltrosCatalogoPreparados = FiltrosExportacaoProdutos & {
  loja: string | null;
  estoque: string | null;
};

/** O acesso do cadastro (ERP 3.1): exportar (`<recurso>.exportar` ou `relatorios.exportar`) e ver. */
function garantirAcessoCadastro(sessao: SessaoErp, recurso: 'produtos' | 'pessoas'): void {
  garantirPodeExportar(sessao, recurso);
  if (!sessao.permissoes.has(`${recurso}.ver`))
    throw new ErroApi('SEM_PERMISSAO', 'Você não tem permissão para exportar.', {
      detalhes: { permissoes: [`${recurso}.ver`] },
    });
}

/**
 * Confere a loja (entre as permitidas; 403) ou o estoque (entre os permitidos para ver; 403) e resolve o estoque da
 * loja. O estoque da loja fora dos permitidos não derruba a exportação: sai sem a coluna `estoque_atual` (o preço e o
 * mínimo da loja continuam), salvo com o filtro "Estoque zerado ou negativo", que depende dele (403).
 */
export async function prepararFiltrosCatalogo(
  db: DbEmpresa,
  sessao: SessaoErp,
  f: FiltrosExportacaoProdutos,
): Promise<FiltrosCatalogoPreparados> {
  let loja: string | null = null;
  let estoque: string | null = null;
  if (f.lojaId) {
    if (!lojaPermitida(sessao, f.lojaId))
      throw new ErroApi('SEM_PERMISSAO', 'A loja está fora das suas lojas permitidas.', {
        campos: { lojaId: ['Fora das suas lojas permitidas'] },
      });
    const { rows } = await db.execute<{ id: string; estoque_id: string }>(
      sql`select id, estoque_id from lojas where id = ${f.lojaId} and excluido_em is null`,
    );
    if (!rows[0]) throw erroCampo('lojaId', 'Loja não encontrada');
    loja = rows[0].id;
    estoque = estoquePermitido(sessao, rows[0].estoque_id, 'ver') ? rows[0].estoque_id : null;
    if (!estoque && f.estoqueZerado)
      throw new ErroApi('SEM_PERMISSAO', 'O estoque da loja está fora dos seus estoques permitidos.', {
        campos: { estoqueZerado: ['O estoque da loja está fora dos seus estoques permitidos'] },
      });
  } else if (f.estoqueId) {
    const { rows } = await db.execute<{ id: string }>(
      sql`select id from estoques where id = ${f.estoqueId} and excluido_em is null`,
    );
    if (!rows[0]) throw erroCampo('estoqueId', 'Estoque não encontrado');
    if (!estoquePermitido(sessao, rows[0].id, 'ver'))
      throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
        campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
      });
    estoque = rows[0].id;
  }
  return { ...f, loja, estoque };
}

/** Uma linha da consulta de produtos (numeric chega como texto). */
export interface LinhaCatalogoProduto {
  id: string;
  codigo: number;
  codigo_interno: string | null;
  ean: string | null;
  nome: string;
  tipo: string;
  unidade: string;
  ativo: boolean;
  marca: string | null;
  categorias: string | null;
  preco_custo: string;
  markup_pct: string;
  preco_venda: string;
  preco_atacado: string | null;
  qtd_minima_atacado: string | null;
  preco_promocional: string | null;
  preco_menu_digital: string | null;
  preco_ifood: string | null;
  preco_parcelado: string | null;
  preco_loja: string | null;
  estoque_minimo: string | null;
  estoque_atual: string | null;
  ncm: string | null;
  cest: string | null;
  cfop_venda_estado: string | null;
  icms_situacao: string | null;
  icms_origem: string | null;
  icms_aliquota: string | null;
  pis_situacao: string | null;
  cofins_situacao: string | null;
  ipi_situacao: string | null;
  localizacao: string | null;
  peso_g: string | null;
  descricao_curta: string | null;
  usa_menu_digital: boolean;
  balanca_tipo: string;
}

/** O produto tem saldo próprio no estoque (o `estoque_atual` vale para ele na importação). */
const temSaldoProprio = sql`p.controla_estoque and p.tipo not in (${sql.join(
  TIPOS_SEM_SALDO_PROPRIO.map((t) => sql`${t}`),
  sql`, `,
)})`;

/**
 * A consulta inteira, na ordem do código (estável para o cursor). Os produtos excluídos nunca saem; "Somente ativos"
 * tira os inativos; "Com NCM inválido" é a regra do filtro "Sem NCM" da listagem (vazio ou fora da tabela vigente);
 * "Estoque zerado ou negativo" é o `estoque_atual` ≤ 0 (só produto com saldo próprio).
 */
export function sqlCatalogoProdutos(f: FiltrosCatalogoPreparados): SQL {
  const estoqueAtual = f.estoque
    ? sql`case when ${temSaldoProprio} then coalesce(${sqlSaldo(f.estoque)}, 0) end`
    : sql`null`;
  return sql`
    select p.id, p.codigo, p.codigo_interno,
           (select cb.codigo from produtos_codigos_barras cb
             where cb.produto_id = p.id and cb.variacao_id is null and cb.principal and cb.excluido_em is null
             order by cb.id limit 1) as ean,
           p.nome, p.tipo, u.sigla as unidade, p.ativo, m.descricao as marca,
           (select string_agg(c.caminho_nomes, ',' order by (pc.categoria_id = p.categoria_principal_id) desc,
                              c.caminho_nomes, c.id)
              from produtos_categorias pc
              join categorias c on c.id = pc.categoria_id and c.excluido_em is null
             where pc.produto_id = p.id and pc.excluido_em is null) as categorias,
           p.preco_custo::text, p.markup_pct::text, p.preco_venda::text, p.preco_atacado::text,
           p.qtd_minima_atacado::text, p.preco_promocional::text, p.preco_menu_digital::text, p.preco_ifood::text,
           p.preco_parcelado::text,
           pl.preco_venda::text as preco_loja, pl.estoque_minimo::text as estoque_minimo,
           (${estoqueAtual})::text as estoque_atual,
           p.ncm, p.cest, p.cfop_venda_estado, p.icms_situacao, p.icms_origem, p.icms_aliquota::text,
           p.pis_situacao, p.cofins_situacao, p.ipi_situacao,
           p.localizacao, p.peso_g::text, p.descricao_curta, p.usa_menu_digital, p.balanca_tipo
      from produtos p
      join unidades_medida u on u.id = p.unidade_id
      left join marcas m on m.id = p.marca_id
      left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ${f.loja}::uuid and pl.excluido_em is null
     where ${ondeCatalogo(f)}
     order by p.codigo`;
}

/** O saldo do tipo de estoque padrão, sem variação, do produto `p` no estoque (o que a importação compara). */
const sqlSaldo = (estoque: string) =>
  sql`(select s.quantidade from saldos_estoque s
         join tipos_estoque t on t.id = s.tipo_estoque_id and t.padrao and t.excluido_em is null
        where s.estoque_id = ${estoque}::uuid and s.produto_id = p.id and s.variacao_id is null limit 1)`;

/** Os filtros sobre `produtos p` (a consulta e a contagem leem os mesmos). */
function ondeCatalogo(f: FiltrosCatalogoPreparados): SQL {
  return sql`p.excluido_em is null
    ${f.somenteAtivos ? sql`and p.ativo` : sql``}
    ${f.ncmInvalido ? sql`and (p.ncm is null or not ${ncmVigente(sql`p.ncm`)})` : sql``}
    ${f.estoqueZerado && f.estoque ? sql`and ${temSaldoProprio} and coalesce(${sqlSaldo(f.estoque)}, 0) <= 0` : sql``}`;
}

/** A contagem sem as subconsultas das colunas (o `count(*)` sobre a consulta inteira calcularia todas). */
async function contarCatalogoProdutos(db: DbEmpresa, f: FiltrosCatalogoPreparados): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(
    sql`select count(*)::bigint as n from produtos p where ${ondeCatalogo(f)}`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Dinheiro e quantidade como número no `.xlsx` (célula numérica; `numeric(15,4)` cabe no `double` sem perda). */
const numero = (v: string | null): number | null => (v === null ? null : dec(v).toNumber());

type Coluna<L> = ColunaExportacao<L> & { chave: string };

const coluna = <L>(
  tipo: TipoImportacao,
  chave: string,
  valor: (l: L) => ValorExportado,
  extra: Partial<ColunaExportacao<L>> = {},
): Coluna<L> => ({ chave, rotulo: rotuloColunaImportacao(tipo, chave), valor, ...extra });

/** As colunas na ordem do layout (ERP 8.5); as da loja, do estoque e da NF só quando pedidas. */
export function colunasCatalogoProdutos(f: FiltrosCatalogoPreparados): Coluna<LinhaCatalogoProduto>[] {
  const c = (chave: string, valor: (l: LinhaCatalogoProduto) => ValorExportado, custo = false) =>
    coluna<LinhaCatalogoProduto>('produtos', chave, valor, custo ? { custo: true } : {});
  return [
    c('id', (l) => l.id),
    c('codigo', (l) => l.codigo),
    c('codigo_interno', (l) => l.codigo_interno),
    c('ean', (l) => l.ean),
    c('nome', (l) => l.nome),
    c('tipo', (l) => ROTULOS_TIPO_PRODUTO[l.tipo as TipoProduto] ?? l.tipo),
    c('unidade', (l) => l.unidade),
    c('ativo', (l) => l.ativo),
    c('marca', (l) => l.marca),
    c('categoria', (l) => l.categorias),
    c('preco_custo', (l) => numero(l.preco_custo), true),
    c('markup_pct', (l) => numero(l.markup_pct), true),
    c('preco_venda', (l) => numero(l.preco_venda)),
    c('preco_atacado', (l) => numero(l.preco_atacado)),
    c('qtd_minima_atacado', (l) => numero(l.qtd_minima_atacado)),
    c('preco_promocional', (l) => numero(l.preco_promocional)),
    c('preco_menu_digital', (l) => numero(l.preco_menu_digital)),
    c('preco_ifood', (l) => numero(l.preco_ifood)),
    c('preco_parcelado', (l) => numero(l.preco_parcelado)),
    ...(f.loja
      ? [c('preco_loja', (l) => numero(l.preco_loja)), c('estoque_minimo', (l) => numero(l.estoque_minimo))]
      : []),
    ...(f.estoque ? [c('estoque_atual', (l) => numero(l.estoque_atual))] : []),
    ...(f.informacoesNf
      ? [
          c('ncm', (l) => l.ncm),
          c('cest', (l) => l.cest),
          c('cfop_venda_estado', (l) => l.cfop_venda_estado),
          c('icms_situacao', (l) => l.icms_situacao),
          c('icms_origem', (l) => l.icms_origem),
          c('icms_aliquota', (l) => numero(l.icms_aliquota)),
          c('pis_situacao', (l) => l.pis_situacao),
          c('cofins_situacao', (l) => l.cofins_situacao),
          c('ipi_situacao', (l) => l.ipi_situacao),
        ]
      : []),
    c('localizacao', (l) => l.localizacao),
    c('peso_g', (l) => numero(l.peso_g)),
    c('descricao_curta', (l) => l.descricao_curta),
    c('usa_menu_digital', (l) => l.usa_menu_digital),
    c('balanca', (l) => formatarBalancaPlanilha(l.balanca_tipo)),
  ];
}

/** Provedor da exportação de produtos (`GET /produtos/exportacao`). */
export function provedorCatalogoProdutos(): ProvedorRelatorio<
  FiltrosCatalogoPreparados,
  LinhaCatalogoProduto,
  FiltrosExportacaoProdutos
> {
  return {
    chave: EXPORTACAO_CATALOGO_PRODUTOS,
    nomeArquivo: 'Exportacao_Produtos',
    permissao: 'produtos.exportar',
    entidade: 'produtos',
    localizacao: LOCALIZACAO_EXPORTACAO_CATALOGO,
    filtros: filtrosExportacaoProdutosSchema,
    limiteNaHora: LIMITE_EXPORTACAO_CATALOGO,
    garantirAcesso: (sessao) => garantirAcessoCadastro(sessao, 'produtos'),
    preparar: prepararFiltrosCatalogo,
    contar: (db, _sessao, f) => contarCatalogoProdutos(db, f),
    colunas: (_sessao, f) => colunasCatalogoProdutos(f),
    consulta: (_sessao, f) => sqlCatalogoProdutos(f),
  };
}

// ---------------------------------------------------------------- Clientes

/** Uma linha da consulta de clientes. */
export interface LinhaCatalogoCliente {
  id: string;
  codigo: number;
  tipo: string;
  nome: string;
  apelido: string | null;
  cpf_cnpj: string | null;
  rg_ie: string | null;
  nascimento: string | null;
  telefone: string | null;
  email: string | null;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  limite_compras: string | null;
  categorias: string[] | null;
}

/**
 * As pessoas da categoria Cliente, não excluídas e não anonimizadas (LGPD: a anonimizada não tem mais dado a exportar),
 * na ordem do código. O telefone e o e-mail são os principais (ou o primeiro); o endereço, o principal no Brasil (o
 * que a importação grava), com a cidade pelo IBGE; o nascimento em `dd/mm/aaaa` (a data como texto, sem o fuso).
 */
export function sqlCatalogoClientes(f: FiltrosExportacaoClientes): SQL {
  return sql`
    select p.id, p.codigo, trim(p.tipo) as tipo, p.nome, p.apelido, p.cpf_cnpj, p.rg_ie,
           to_char(p.nascimento, 'DD/MM/YYYY') as nascimento,
           (select t.ddd || t.numero from pessoas_telefones t
             where t.pessoa_id = p.id and t.excluido_em is null order by t.principal desc, t.id limit 1) as telefone,
           (select e.email from pessoas_emails e
             where e.pessoa_id = p.id and e.excluido_em is null order by e.principal desc, e.id limit 1) as email,
           en.cep, en.logradouro, en.numero, en.complemento, en.bairro, mu.nome as cidade, en.uf,
           p.limite_compras::text,
           (select array_agg(c.categoria order by c.categoria) from pessoas_categorias c
             where c.pessoa_id = p.id and c.excluido_em is null) as categorias
      from pessoas p
      left join lateral (
        select en.cep, en.logradouro, en.numero, en.complemento, en.bairro, en.uf, en.municipio_ibge
          from pessoas_enderecos en
         where en.pessoa_id = p.id and en.excluido_em is null and en.tipo = 'principal' and not en.exterior
         order by en.id limit 1) en on true
      left join municipios mu on mu.codigo_ibge = en.municipio_ibge
     where p.excluido_em is null and p.anonimizada_em is null
       and exists (select 1 from pessoas_categorias pc
                    where pc.pessoa_id = p.id and pc.categoria = 'cliente' and pc.excluido_em is null)
       ${f.somenteAtivos ? sql`and p.ativa` : sql``}
     order by p.codigo`;
}

/** `(43) 99999-0000` (a importação lê só os dígitos). */
function telefoneBr(v: string | null): string | null {
  if (!v) return null;
  const ddd = v.slice(0, 2);
  const n = v.slice(2);
  return `(${ddd}) ${n.length > 4 ? `${n.slice(0, -4)}-${n.slice(-4)}` : n}`;
}

export function colunasCatalogoClientes(): Coluna<LinhaCatalogoCliente>[] {
  const c = (chave: string, valor: (l: LinhaCatalogoCliente) => ValorExportado) =>
    coluna<LinhaCatalogoCliente>('clientes', chave, valor);
  return [
    c('id', (l) => l.id),
    c('codigo', (l) => l.codigo),
    c('tipo', (l) => l.tipo),
    c('nome', (l) => l.nome),
    c('apelido', (l) => l.apelido),
    c('cpf_cnpj', (l) => (l.cpf_cnpj ? formatarCpfCnpj(l.cpf_cnpj) : null)),
    c('rg_ie', (l) => l.rg_ie),
    c('nascimento', (l) => l.nascimento),
    c('telefone', (l) => telefoneBr(l.telefone)),
    c('email', (l) => l.email),
    c('cep', (l) => l.cep),
    c('logradouro', (l) => l.logradouro),
    c('numero', (l) => l.numero),
    c('complemento', (l) => l.complemento),
    c('bairro', (l) => l.bairro),
    c('cidade', (l) => l.cidade),
    c('uf', (l) => l.uf),
    c('limite_compras', (l) => numero(l.limite_compras)),
    c('categorias', (l) =>
      (l.categorias ?? []).map((x) => ROTULOS_CATEGORIA_PESSOA[x as CategoriaPessoa] ?? x).join(', '),
    ),
  ];
}

/** Provedor da exportação de clientes (`GET /pessoas/exportacao`): a permissão é a de pessoas. */
export function provedorCatalogoClientes(): ProvedorRelatorio<
  FiltrosExportacaoClientes,
  LinhaCatalogoCliente,
  FiltrosExportacaoClientes
> {
  return {
    chave: EXPORTACAO_CATALOGO_CLIENTES,
    nomeArquivo: 'Exportacao_Clientes',
    permissao: 'pessoas.exportar',
    entidade: 'pessoas',
    localizacao: LOCALIZACAO_EXPORTACAO_CATALOGO,
    filtros: filtrosExportacaoClientesSchema,
    limiteNaHora: LIMITE_EXPORTACAO_CATALOGO,
    garantirAcesso: (sessao) => garantirAcessoCadastro(sessao, 'pessoas'),
    colunas: () => colunasCatalogoClientes(),
    consulta: (_sessao, f) => sqlCatalogoClientes(f),
  };
}
