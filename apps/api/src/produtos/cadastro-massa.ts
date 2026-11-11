/**
 * **Cadastro em massa por estoque** (Fase 2, F2-B39; ERP 8.3; F2-Q13 = D54 (a); README da API › decisão 185): a grade
 * que cadastra e dá entrada em muitos produtos de uma vez, como no Nuvem3.
 *
 * - `POST /produtos/cadastro-em-massa/pesquisar-ean`: os códigos da grade na **base da empresa** (sem base externa de
 *   GTIN, F2-Q13 (a)); o código achado vira "Atualização" com os valores gravados.
 * - `POST /produtos/cadastro-em-massa`: até `LIMITE_LINHAS_CADASTRO_MASSA` linhas numa transação só (tudo ou nada),
 *   com a 7300001 (`travaVersao`: o `lock_timeout` da espera e o 503 "sistema ocupado" amigável, C13). A linha nova
 *   cria um **Simples** com a tributação vazia (a padrão da Fase 2, decisão 161) pelo `inserirProduto`; a Atualização
 *   passa pelo `atualizarProduto` (versão, "Altera Preço do Produto no ERP", auditoria, descida ao PDV) — as regras
 *   do formulário, com a unicidade de EAN dele (`geral.ean_duplicado` bloquear/avisar), não a da importação. O
 *   estoque a somar vira **um** acerto de Entrada efetivado com a origem `cadastro_massa` (`AJUSTE_CADASTRO`, lançado
 *   agora); o estoque mínimo vai para `produtos_lojas` da loja do estoque; o histórico de preços grava a origem
 *   `cadastro_massa`.
 *
 * A validação junta os erros de todas as linhas (`linhas.N.campo`) antes de gravar; o que só aparece na gravação
 * (raro: a 7300001 serializa os outros escritores) volta com a linha na mensagem e desfaz tudo.
 */
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  MOTIVO_CADASTRO_MASSA,
  PERMISSOES,
  cadastroMassaSchema,
  criarProdutoSchema,
  dec,
  markupPct as markupDe,
  pesquisaEanCadastroMassaSchema,
  type CadastroMassa,
  type CriarProduto,
  type CriarProdutoEntrada,
  type LinhaCadastroMassa,
  type ProdutoEanCadastroMassa,
  type RespostaPesquisaEanCadastroMassa,
  type ResultadoCadastroMassa,
  type TipoProduto,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { Permissao } from '../autorizacao/decorators.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { acertosEstoque, marcas } from '../database/empresa/schema/index.js';
import {
  TIPOS_SEM_ESTOQUE,
  conferirCabecalhoAcerto,
  efetivarAcerto,
  gravarItensRascunho,
  lojaDoEstoque,
  resumoEfetivacao,
} from '../estoques/acertos.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { detalheProduto, sqlVersaoAgregada } from './consultas.js';
import { validarNoBanco } from './gravacao.js';
import {
  LOCALIZACAO_CADASTRO_MASSA,
  atualizarProduto,
  entradaDoDetalhe,
  inserirProduto,
} from './produtos.controller.js';

type Campos = Record<string, string[]>;
const add = (campos: Campos, campo: string, msg: string) => (campos[campo] ??= []).push(msg);

const verCusto = (s: SessaoErp) => s.permissoes.has('produtos.ver_custo');

/** O produto de um código de barras vivo (a consulta do "Pesquisar EAN" e a conferência da gravação). */
type Achado = {
  codigoBarras: string;
  /** O código é `gtin` (o que a unicidade de EAN confere; o `interno` não entra). */
  gtin: boolean;
  variacao: boolean;
  fator: string;
  id: string;
  codigo: number;
  nome: string;
  versao: number;
  tipo: TipoProduto;
  ativo: boolean;
  unidade_id: string;
  sigla: string;
  permite_fracao: boolean;
  ncm: string | null;
  marca_id: string | null;
  marca_nome: string | null;
  categoria_principal_id: string | null;
  preco_custo: string;
  markup_pct: string;
  preco_venda: string;
  controla_estoque: boolean;
  estoque_minimo: string | null;
};

/** Tem saldo próprio: controla estoque e não é combo, serviço, produzido nem com variações (o saldo é da variação). */
const temEstoqueProprio = (a: { tipo: string; controla_estoque: boolean }) =>
  a.controla_estoque &&
  a.tipo !== 'com_variacoes' &&
  !(TIPOS_SEM_ESTOQUE as readonly string[]).includes(a.tipo);

/**
 * Os produtos vivos de cada código (qualquer tipo de código: o EAN, o interno e o da embalagem), um por produto — a
 * linha do pai antes da de uma variação com o mesmo código. Com a loja do estoque, o estoque mínimo dela.
 */
async function produtosPorCodigo(
  db: DbEmpresa,
  codigos: readonly string[],
  lojaId: string | null,
): Promise<Map<string, Achado[]>> {
  const mapa = new Map<string, Achado[]>();
  if (!codigos.length) return mapa;
  const { rows } = await db.execute<Achado & { cod: string }>(sql`
    select distinct on (cb.codigo, p.id)
           cb.codigo as cod, cb.tipo = 'gtin' as gtin, cb.variacao_id is not null as variacao,
           cb.fator::text as fator,
           p.id, p.codigo, p.nome, ${sqlVersaoAgregada(sql`p.id`)} as versao, p.tipo, p.ativo, p.unidade_id, u.sigla, p.permite_fracao, p.ncm,
           p.marca_id, m.descricao as marca_nome, p.categoria_principal_id, p.preco_custo::text,
           p.markup_pct::text, p.preco_venda::text, p.controla_estoque, pl.estoque_minimo::text
      from produtos_codigos_barras cb
      join produtos p on p.id = cb.produto_id and p.excluido_em is null
      join unidades_medida u on u.id = p.unidade_id
      left join marcas m on m.id = p.marca_id
      left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = ${lojaId}::uuid and pl.excluido_em is null
     where cb.excluido_em is null and cb.codigo in (${sql.join(
       codigos.map((c) => sql`${c}`),
       sql`, `,
     )})
     order by cb.codigo, p.id, (cb.variacao_id is not null), (cb.tipo <> 'gtin'), cb.principal desc`);
  for (const r of rows) {
    const { cod, ...a } = r;
    mapa.set(cod, [
      ...(mapa.get(cod) ?? []),
      { ...a, codigoBarras: cod, codigo: Number(a.codigo), versao: Number(a.versao) },
    ]);
  }
  for (const lista of mapa.values()) lista.sort((a, b) => a.codigo - b.codigo);
  return mapa;
}

/** Os campos do produto (`criarProdutoSchema`) nas colunas da grade; os demais ficam com o nome do produto. */
function campoDaGrade(campo: string): string {
  if (campo.startsWith('codigosBarras')) return 'ean';
  if (campo === 'categorias' || campo.startsWith('categorias.') || campo === 'categoriaPrincipalId')
    return 'categoriaId';
  if (campo.startsWith('lojas')) return 'estoqueMinimo';
  return campo.split('.')[0]!;
}

/** O erro de uma linha (do produto ou do acerto) com a linha no campo e na mensagem. */
function comLinha(e: unknown, i: number): unknown {
  if (!(e instanceof ErroApi)) return e;
  const campos = e.extras.campos
    ? Object.fromEntries(
        Object.entries(e.extras.campos).map(([k, v]) => [`linhas.${i}.${campoDaGrade(k)}`, v]),
      )
    : { [`linhas.${i}._linha`]: [e.message] };
  return new ErroApi(e.codigo, `Linha ${i + 1}: ${e.message}`, { ...e.extras, campos });
}

/** Junta os erros de um `ErroApi` de validação/conflito do produto nos campos da linha. */
function juntarErro(campos: Campos, e: unknown, i: number): void {
  if (!(e instanceof ErroApi) || !['VALIDACAO', 'CONFLITO', 'REGRA_NEGOCIO'].includes(e.codigo)) throw e;
  if (!e.extras.campos) {
    add(campos, `linhas.${i}._linha`, e.message);
    return;
  }
  for (const [k, v] of Object.entries(e.extras.campos))
    for (const m of v) add(campos, `linhas.${i}.${campoDaGrade(k)}`, m);
}

/** Quantidade com casas decimais não inteiras (o produto sem fração só recebe inteiro). */
const fracionada = (q: string) => !dec(q).isInteger();

interface LinhaPreparada {
  indice: number;
  linha: LinhaCadastroMassa;
  /** Nulo = produto novo. */
  produtoId: string | null;
  /** Nulo = a Atualização só soma estoque (nenhum campo do cadastro veio na linha). */
  dados: CriarProduto | null;
  /** A Atualização não muda o cadastro (só soma estoque): o produto não é regravado. */
  semMudanca: boolean;
}

/** A Atualização sem nenhum campo do cadastro (o ERP manda nulo no que não mudou desde a pesquisa): só o estoque. */
const soEstoque = (l: LinhaCadastroMassa) =>
  l.nome === null &&
  l.unidadeId === null &&
  l.ncm === null &&
  l.marcaId === null &&
  l.marcaNova === null &&
  l.categoriaId === null &&
  l.precoCusto === null &&
  l.markupPct === null &&
  l.precoVenda === null &&
  l.estoqueMinimo === null;

/**
 * O markup gravado: o digitado; sem ele, o do preço sobre o custo (4 casas, `markupPct` do shared, a conta do
 * formulário), ou o de antes quando nem o custo nem o preço mudaram.
 */
function markupDaLinha(l: LinhaCadastroMassa, custo: string, venda: string, anterior: string | null): string {
  if (l.markupPct !== null) return l.markupPct;
  if (anterior !== null && l.precoCusto === null && l.precoVenda === null) return anterior;
  const m = markupDe(custo, venda);
  return m === null ? '0' : String(m);
}

/** Marcas digitadas que não existem: reaproveitadas pelo nome (sem acento e caixa) ou criadas (`marcas.criar`). */
async function resolverMarcasNovas(
  s: Pick<Servicos, 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  linhas: readonly LinhaCadastroMassa[],
  campos: Campos,
): Promise<{ ids: Map<number, string>; criadas: number }> {
  const ids = new Map<number, string>();
  const porNome = new Map<string, string>();
  let criadas = 0;
  for (const [i, l] of linhas.entries()) {
    if (!l.marcaNova) continue;
    const { rows } = await tx.execute<{ chave: string; id: string | null }>(sql`
      select lower(fn_unaccent(${l.marcaNova})) as chave,
             (select id from marcas where excluido_em is null
                 and lower(fn_unaccent(descricao)) = lower(fn_unaccent(${l.marcaNova})) order by codigo limit 1) as id`);
    const { chave, id: existente } = rows[0]!;
    const conhecida = existente ?? porNome.get(chave);
    if (conhecida) {
      ids.set(i, conhecida);
      continue;
    }
    if (!sessao.permissoes.has('marcas.criar')) {
      add(campos, `linhas.${i}.marcaNova`, 'Marca inexistente: criar marca exige "Marcas: Criar"');
      continue;
    }
    const [m] = await tx
      .insert(marcas)
      .values({ descricao: l.marcaNova, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
      .returning();
    await s.auditoria.registrar(tx, origem, {
      acao: 'criar',
      entidade: 'marcas',
      registroId: m!.id,
      localizacao: LOCALIZACAO_CADASTRO_MASSA,
      depois: m,
    });
    porNome.set(chave, m!.id);
    ids.set(i, m!.id);
    criadas += 1;
  }
  return { ids, criadas };
}

/**
 * Grava a grade (na transação de quem chama, com `travaVersao`): confere tudo, junta os erros por linha, grava os
 * produtos na ordem da grade e lança o acerto de Entrada do estoque somado.
 */
export async function gravarCadastroMassa(
  s: Pick<Servicos, 'auditoria' | 'custoCombos'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  d: CadastroMassa,
): Promise<ResultadoCadastroMassa> {
  const custo = verCusto(sessao);
  // As permissões de cada parte (as do formulário e do acerto): `produtos.cadastro_massa` abre a tela.
  const exigir = (chave: string, oque: string) => {
    if (!sessao.permissoes.has(chave))
      throw ErroApi.semPermissao(
        `${oque} exige "${PERMISSOES.find((p) => p.chave === chave)?.descricao ?? chave}".`,
      );
  };
  // (A Atualização que só soma estoque não mexe no cadastro: `produtos.editar` só quando ele muda, depois da conferência.)
  if (d.linhas.some((l) => l.produtoId === null)) exigir('produtos.criar', 'Cadastrar produto novo');
  if (d.linhas.some((l) => l.estoque !== null))
    exigir('estoque_acertos.criar', 'Somar estoque (acerto de Entrada)');

  // O estoque permitido para movimentar e ativo, o tipo padrão (Disponível) e a loja (a do estoque mínimo).
  const cab = await conferirCabecalhoAcerto(
    tx,
    { estoqueId: d.estoqueId, tipoEstoqueId: null, tipoEstoqueDestinoId: null, responsavelId: null },
    sessao,
  );
  const lojaId = cab.lojaId;
  const campos: Campos = {};
  const marcasNovas = await resolverMarcasNovas(s, tx, sessao, origem, d.linhas, campos);

  const eans = [...new Set(d.linhas.flatMap((l) => (l.ean ? [l.ean] : [])))];
  const achados = await produtosPorCodigo(tx, eans, lojaId);
  const { rows: unidades } = await tx.execute<{ id: string; permite_fracao: boolean }>(sql`
    select id, permite_fracao from unidades_medida where excluido_em is null and ativo`);
  const fracaoDa = new Map(unidades.map((u) => [u.id, u.permite_fracao]));
  const modoEan =
    (await lerConfiguracao<string>(tx, 'geral.ean_duplicado')) === 'avisar' ? 'avisar' : 'bloquear';
  const duplicados: Array<{
    linha: number;
    codigo: string;
    produtos: Array<{ id: string; codigo: number; nome: string }>;
  }> = [];
  const preparadas: LinhaPreparada[] = [];

  for (const [i, l] of d.linhas.entries()) {
    const campo = (c: string) => `linhas.${i}.${c}`;
    const marcaId = l.marcaNova ? (marcasNovas.ids.get(i) ?? null) : l.marcaId;
    if (l.marcaNova && !marcaId) continue; // a marca sem permissão já entrou nos erros
    if (l.estoqueMinimo !== null) {
      if (!lojaId)
        add(
          campos,
          campo('estoqueMinimo'),
          'O estoque escolhido não é de uma loja: o estoque mínimo é por loja',
        );
      else if (!lojaPermitida(sessao, lojaId))
        add(campos, campo('estoqueMinimo'), 'A loja do estoque está fora das suas lojas permitidas');
    }
    const lojaMinimo = l.estoqueMinimo !== null && lojaId ? { lojaId, estoqueMinimo: l.estoqueMinimo } : null;
    const lista = l.ean ? (achados.get(l.ean) ?? []) : [];

    if (l.produtoId === null) {
      // Produto novo com um EAN que já está em outro produto: a regra do formulário (ERP 8.2 "EAN duplicado").
      const comGtin = lista.filter((a) => a.gtin);
      if (l.ean && comGtin.length)
        duplicados.push({
          linha: i,
          codigo: l.ean,
          produtos: comGtin.map((a) => ({ id: a.id, codigo: a.codigo, nome: a.nome })),
        });
      const corpo: CriarProdutoEntrada = {
        nome: l.nome ?? '',
        tipo: 'simples',
        unidadeId: l.unidadeId ?? '',
        permiteFracao: l.unidadeId ? (fracaoDa.get(l.unidadeId) ?? false) : false,
        ncm: l.ncm,
        marcaId,
        categoriaPrincipalId: l.categoriaId,
        categorias: l.categoriaId ? [l.categoriaId] : [],
        precoVenda: l.precoVenda ?? '0',
        ...(custo && l.precoCusto !== null
          ? {
              precoCusto: l.precoCusto,
              markupPct: markupDaLinha(l, l.precoCusto, l.precoVenda ?? '0', null),
            }
          : {}),
        codigosBarras: l.ean ? [{ codigo: l.ean, principal: true }] : [],
        lojas: lojaMinimo ? [lojaMinimo] : [],
        confirmarEanDuplicado: modoEan === 'avisar' && d.confirmarEanDuplicado,
      };
      const r = criarProdutoSchema.safeParse(corpo);
      if (!r.success) {
        for (const issue of r.error.issues)
          add(campos, campo(campoDaGrade(issue.path.join('.') || '_linha')), issue.message);
        continue;
      }
      try {
        await validarNoBanco(tx, r.data, null, null);
      } catch (e) {
        juntarErro(campos, e, i);
        continue;
      }
      if (l.estoque !== null && !r.data.permiteFracao && fracionada(l.estoque))
        add(campos, campo('estoque'), 'A unidade não permite fração: informe uma quantidade inteira');
      preparadas.push({ indice: i, linha: l, produtoId: null, dados: r.data, semMudanca: false });
      continue;
    }

    // Atualização: o código ainda é do produto que a pesquisa achou, na versão que ela viu.
    const achado = lista.find((a) => a.id === l.produtoId!.toLowerCase());
    if (!achado) {
      add(campos, campo('ean'), 'O código não está mais neste produto: pesquise o EAN de novo');
      continue;
    }
    if (achado.variacao) {
      add(
        campos,
        campo('ean'),
        'Código de uma variação: a grade ainda não atualiza variação (use o cadastro do produto)',
      );
      continue;
    }
    if (achado.versao !== l.versao) {
      add(campos, campo('ean'), 'O produto foi alterado depois da pesquisa: pesquise o EAN de novo');
      continue;
    }
    if (l.estoque !== null && !temEstoqueProprio(achado))
      add(
        campos,
        campo('estoque'),
        !achado.controla_estoque
          ? 'O produto não controla estoque'
          : achado.tipo === 'com_variacoes'
            ? 'Produto com variações: o saldo é por variação (use o acerto de estoque)'
            : 'O produto não tem estoque próprio (combo, serviço ou produzido)',
      );
    if (soEstoque(l)) {
      // Nada do cadastro: sem o detalhe nem a validação do formulário (o produto não é regravado nem conferido).
      if (l.estoque !== null && !achado.permite_fracao && fracionada(l.estoque))
        add(campos, campo('estoque'), 'O produto não permite fração: informe uma quantidade inteira');
      preparadas.push({ indice: i, linha: l, produtoId: achado.id, dados: null, semMudanca: true });
      continue;
    }
    const atual = (await detalheProduto(tx, achado.id, true, sessao.lojas, sessao.estoques))!;
    const base = entradaDoDetalhe(atual);
    const lojas = [...(base.lojas ?? [])];
    if (lojaMinimo) {
      const j = lojas.findIndex((x) => x.lojaId === lojaMinimo.lojaId);
      if (j >= 0) lojas[j] = { ...lojas[j]!, estoqueMinimo: lojaMinimo.estoqueMinimo };
      else lojas.push(lojaMinimo);
    }
    const unidadeId = l.unidadeId ?? atual.unidadeId;
    const custoNovo = custo ? (l.precoCusto ?? atual.precoCusto ?? '0') : null;
    const vendaNova = l.precoVenda ?? atual.precoVenda;
    const entrada: CriarProdutoEntrada = {
      ...base,
      ...(l.nome !== null ? { nome: l.nome } : {}),
      unidadeId,
      ...(unidadeId !== atual.unidadeId ? { permiteFracao: fracaoDa.get(unidadeId) ?? false } : {}),
      ...(l.ncm !== null ? { ncm: l.ncm } : {}),
      ...(marcaId !== null ? { marcaId } : {}),
      // A categoria digitada vira a principal (as outras ficam); a mesma de agora não mexe na lista.
      ...(l.categoriaId !== null && l.categoriaId !== atual.categoriaPrincipalId
        ? {
            categoriaPrincipalId: l.categoriaId,
            categorias: [...new Set([l.categoriaId, ...(base.categorias ?? [])])],
          }
        : {}),
      precoVenda: vendaNova,
      ...(custoNovo !== null
        ? {
            precoCusto: custoNovo,
            markupPct: markupDaLinha(l, custoNovo, vendaNova, atual.markupPct),
          }
        : {}),
      lojas,
      confirmarEanDuplicado: false,
    };
    const r = criarProdutoSchema.safeParse(entrada);
    if (!r.success) {
      for (const issue of r.error.issues)
        add(campos, campo(campoDaGrade(issue.path.join('.') || '_linha')), issue.message);
      continue;
    }
    try {
      await validarNoBanco(tx, r.data, achado.id, {
        tipo: achado.tipo,
        temMovimento: atual.temMovimento,
        saldoNaoZero: false,
      });
    } catch (e) {
      juntarErro(campos, e, i);
      continue;
    }
    if (l.estoque !== null && !r.data.permiteFracao && fracionada(l.estoque))
      add(campos, campo('estoque'), 'O produto não permite fração: informe uma quantidade inteira');
    const gravado = criarProdutoSchema.safeParse(base);
    const semMudanca = gravado.success && JSON.stringify(gravado.data) === JSON.stringify(r.data);
    preparadas.push({ indice: i, linha: l, produtoId: achado.id, dados: r.data, semMudanca });
  }

  if (preparadas.some((p) => p.produtoId !== null && !p.semMudanca))
    exigir('produtos.editar', 'Atualizar o cadastro de produto');

  // EAN de produto novo já cadastrado: "bloquear" recusa (junto dos outros erros); "avisar" pede a confirmação do ERP
  // (409 com `confirmar`) só quando nada mais está errado, e grava com ela (o mesmo fluxo do formulário).
  const confirmado = modoEan === 'avisar' && d.confirmarEanDuplicado;
  if (duplicados.length && !confirmado && (modoEan === 'bloquear' || !Object.keys(campos).length)) {
    for (const x of duplicados)
      add(
        campos,
        `linhas.${x.linha}.ean`,
        `O EAN ${x.codigo} já está no produto ${x.produtos[0]!.codigo} - ${x.produtos[0]!.nome}`,
      );
    const soEan = Object.keys(campos).every((k) => duplicados.some((x) => k === `linhas.${x.linha}.ean`));
    if (soEan)
      throw new ErroApi(
        'CONFLITO',
        modoEan === 'bloquear'
          ? `EAN já cadastrado em outro produto (${duplicados.length} linha(s)). Nada foi gravado.`
          : `${duplicados.length} linha(s) com EAN que já está em outro produto. Gravar mesmo assim?`,
        {
          campos,
          detalhes: { eanDuplicado: { modo: modoEan, confirmar: modoEan === 'avisar', duplicados } },
        },
      );
  }
  if (Object.keys(campos).length) {
    const linhasComErro = new Set(Object.keys(campos).map((k) => k.split('.')[1]));
    throw new ErroApi(
      'VALIDACAO',
      `Verifique as linhas destacadas (${linhasComErro.size} linha(s) com erro). Nada foi gravado.`,
      { campos },
    );
  }

  // Gravação, na ordem da grade (as regras do formulário; o erro tardio volta com a linha e desfaz tudo). A
  // conferência acima já fez o `validarNoBanco` de cada linha nesta transação, com a trava: a gravação não o repete.
  const deps = { auditoria: s.auditoria, custoCombos: s.custoCombos };
  const opcoesGravacao = { cadastroMassa: true, validado: true };
  const gravados: Array<{ indice: number; id: string; acao: 'criado' | 'atualizado' }> = [];
  for (const p of preparadas) {
    try {
      const id =
        p.produtoId === null
          ? await inserirProduto(deps, tx, sessao, origem, p.dados!, opcoesGravacao)
          : p.semMudanca
            ? p.produtoId
            : (await atualizarProduto(
                deps,
                tx,
                sessao,
                origem,
                p.produtoId,
                p.linha.versao,
                p.dados!,
                opcoesGravacao,
              ),
              p.produtoId);
      gravados.push({ indice: p.indice, id, acao: p.produtoId === null ? 'criado' : 'atualizado' });
    } catch (e) {
      throw comLinha(e, p.indice);
    }
  }
  // O código e o nome do resultado numa consulta só (cada ida ao banco conta com a trava presa).
  const nomes = new Map<string, { codigo: number; nome: string }>();
  if (gravados.length) {
    const { rows } = await tx.execute<{ id: string; codigo: number; nome: string }>(sql`
      select id, codigo, nome from produtos where id = any(${`{${gravados.map((g) => g.id).join(',')}}`}::uuid[])`);
    for (const r of rows) nomes.set(r.id, { codigo: Number(r.codigo), nome: r.nome });
  }
  const produtosGravados: ResultadoCadastroMassa['produtos'] = gravados.map((g) => ({
    linha: g.indice + 1,
    id: g.id,
    codigo: nomes.get(g.id)!.codigo,
    nome: nomes.get(g.id)!.nome,
    acao: g.acao,
  }));
  const idDaLinha = new Map(gravados.map((g) => [g.indice, g.id]));

  // O estoque somado: um acerto de Entrada efetivado agora, com a origem `cadastro_massa` (AJUSTE_CADASTRO).
  let acerto: ResultadoCadastroMassa['acerto'] = null;
  const itens = preparadas
    .filter((p) => p.linha.estoque !== null)
    .map((p) => ({
      id: null,
      produtoId: idDaLinha.get(p.indice)!,
      variacaoId: null,
      quantidade: p.linha.estoque!,
      // O custo da Entrada é o da linha (com `produtos.ver_custo`); sem ele (ou sem o custo na linha, como na
      // Atualização que não mexeu no custo), o custo médio/de referência na efetivação.
      custoUnitario: custo ? p.linha.precoCusto : null,
    }));
  if (itens.length) {
    const id = uuidv7();
    const dataContagem = new Date();
    const cabecalho = {
      id,
      estoqueId: d.estoqueId,
      tipoEstoqueId: cab.tipoEstoqueId,
      tipoAjuste: 'entrada' as const,
    };
    const [a] = await tx
      .insert(acertosEstoque)
      .values({
        ...cabecalho,
        dataContagem,
        motivo: MOTIVO_CADASTRO_MASSA,
        responsavelId: sessao.usuarioId,
        observacoes: `Cadastro em massa: ${produtosGravados.length} produto(s) na grade`,
        origem: 'cadastro_massa',
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      })
      .returning({ codigo: acertosEstoque.codigo });
    await gravarItensRascunho(tx, cabecalho, itens, { preservarCusto: !custo });
    const r = await efetivarAcerto(
      tx,
      { ...cabecalho, origem: 'cadastro_massa', dataContagem },
      { usuarioId: sessao.usuarioId, permiteNegativo: false },
    );
    await s.auditoria.registrar(tx, origem, {
      acao: 'criar',
      entidade: 'acertos_estoque',
      registroId: id,
      localizacao: LOCALIZACAO_CADASTRO_MASSA,
      lojaId,
      descricao: `Entrada pelo cadastro em massa (acerto Nº ${a!.codigo})`,
      depois: { estoqueId: d.estoqueId, itens },
    });
    await s.auditoria.registrar(tx, origem, {
      acao: 'efetivar',
      entidade: 'acertos_estoque',
      registroId: id,
      localizacao: LOCALIZACAO_CADASTRO_MASSA,
      lojaId,
      descricao: `Acerto efetivado: ${resumoEfetivacao(r)}`,
    });
    acerto = { id, codigo: a!.codigo, itens: r.itens, movimentos: r.movimentos };
  }
  return {
    criados: produtosGravados.filter((p) => p.acao === 'criado').length,
    atualizados: produtosGravados.filter((p) => p.acao === 'atualizado').length,
    produtos: produtosGravados,
    acerto,
    marcasCriadas: marcasNovas.criadas,
  };
}

/** "Pesquisar EAN" (F2-Q13 = D54 (a)): os códigos na base da empresa, com os valores que a Atualização mostra. */
export async function pesquisarEansCadastroMassa(
  db: DbEmpresa,
  sessao: SessaoErp,
  estoqueId: string,
  codigos: readonly string[],
): Promise<RespostaPesquisaEanCadastroMassa> {
  if (!estoquePermitido(sessao, estoqueId, 'ver'))
    throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
      campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
    });
  const loja = await lojaDoEstoque(db, estoqueId);
  const lojaId = loja && lojaPermitida(sessao, loja) ? loja : null;
  const achados = await produtosPorCodigo(db, [...new Set(codigos)], lojaId);
  const custo = verCusto(sessao);
  return {
    itens: [...achados.entries()].map(([codigo, lista]) => ({
      codigo,
      produtos: lista.map((a): ProdutoEanCadastroMassa => ({
        id: a.id,
        codigo: a.codigo,
        nome: a.nome,
        versao: a.versao,
        tipo: a.tipo,
        ativo: a.ativo,
        unidadeId: a.unidade_id,
        unidadeSigla: a.sigla,
        permiteFracao: a.permite_fracao,
        ncm: a.ncm,
        marcaId: a.marca_id,
        marcaNome: a.marca_nome,
        categoriaId: a.categoria_principal_id,
        // O markup junto do preço revelaria o custo: os dois só com `produtos.ver_custo`.
        precoCusto: custo ? a.preco_custo : null,
        markupPct: custo ? a.markup_pct : null,
        precoVenda: a.preco_venda,
        estoqueMinimo: a.estoque_minimo,
        variacao: a.variacao,
        fator: a.fator,
        temEstoqueProprio: temEstoqueProprio(a),
      })),
    })),
  };
}

/** `/produtos/cadastro-em-massa` (ERP 8.3). */
@Controller('produtos/cadastro-em-massa')
export class CadastroMassaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('produtos.cadastro_massa')
  @Post('pesquisar-ean')
  @HttpCode(200)
  async pesquisarEan(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<RespostaPesquisaEanCadastroMassa> {
    const q = validar(pesquisaEanCadastroMassaSchema, corpo);
    return this.s.tenancy
      .cx()
      .consulta((db) => pesquisarEansCadastroMassa(db, sessao, q.estoqueId, q.codigos));
  }

  /**
   * Grava a grade inteira numa transação (até `LIMITE_LINHAS_CADASTRO_MASSA` linhas): os produtos, o acerto de Entrada
   * e o histórico, ou nada. A espera pela 7300001 tem o limite do ERP (o 503 "sistema ocupado", nada gravado).
   */
  @Permissao('produtos.cadastro_massa')
  @Post()
  @HttpCode(201)
  async gravar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoCadastroMassa> {
    const dados = validar(cadastroMassaSchema, corpo);
    return this.s.tenancy
      .cx()
      .transacao((tx) => gravarCadastroMassa(this.s, tx, sessao, origemDaRequisicao(req), dados), {
        travaVersao: true,
      });
  }
}
